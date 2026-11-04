/**
 * A sealed value, its key version, and the envelope that binds the two to the
 * row they belong to.
 *
 * ─── THE DEFECT, AS IT STANDS TODAY ─────────────────────────────────────────
 *
 * `apps/api/src/lib/vault.ts` supports exactly ONE key version. `keyForVersion`
 * reads `if (version === 1)` and throws for everything else, `needsRotation`
 * has NO CALLER anywhere in the repo, and the file's own header says rotation
 * happens by "re-encrypting lazily" — a sweep that does not exist. The
 * practical consequence is the one sentence nobody wants to write in an
 * incident review: A COMPROMISE OF THE MASTER KEY CANNOT BE REMEDIATED.
 * Rotating it makes every sealed secret in the install permanently unreadable,
 * so the only available response to a leaked key is to keep using it.
 *
 * Beside it, `AuthProfile.storageState` is a PLAIN JSON COLUMN holding live
 * customer session cookies, with no key version at all.
 *
 * ─── WHAT THIS FILE IS, AND WHAT IT IS NOT ──────────────────────────────────
 *
 * It is the VOCABULARY and the RULES: the envelope's shape, how it serialises,
 * which key states may open a value and which may create one, what the
 * additional authenticated data binds, and a type for an opened plaintext that
 * resists being logged.
 *
 * It contains NO CRYPTOGRAPHY and imports NO NODE BUILTIN, deliberately and for
 * two separate reasons. The first is that `packages/shared/src/index.ts` is what
 * the web app's bundler consumes, and a `node:crypto` import here would reach it
 * through `schemas.ts` — the hazard `private-address.ts` records in its own
 * header. The second is that a security vocabulary with no I/O can be tested
 * exhaustively with no fake, no clock and no key material, and a control nobody
 * can test with a fake is a control nobody will trust.
 *
 * The cipher stays in `apps/api/src/lib/vault.ts` and `apps/worker/src/vault.ts`.
 *
 * ─── THE THREE RULES THAT MAKE ROTATION POSSIBLE ────────────────────────────
 *
 *  1. MANY KEYS MAY BE READABLE AND EXACTLY ONE IS WRITABLE. That is the whole
 *     mechanism: rotation adds a new ACTIVE key, demotes the old one to
 *     READABLE, and a sweep re-seals at its leisure. No flag day, and nothing
 *     becomes unreadable at the moment the key changes.
 *  2. AN UNKNOWN KEY VERSION IS A NAMED REFUSAL. Never a decrypt attempt
 *     against the wrong key, never a caught exception that falls through to an
 *     empty string. {@link SEAL_REFUSALS} is the closed list of ways this can
 *     go wrong and every one of them is a value a caller must handle.
 *  3. A CIPHERTEXT CANNOT BE MOVED. The additional authenticated data names the
 *     model, the row and the field, so a `storageState` lifted from one
 *     AuthProfile and pasted onto another fails to open rather than opening as
 *     somebody else's session. {@link SEALED_FIELDS} is why that binding has a
 *     closed vocabulary instead of a format string at each call site.
 *
 * ─── AND IT NEVER PRINTS WHAT IT PROTECTS ───────────────────────────────────
 *
 * Nothing in this file puts plaintext, ciphertext, a nonce or key material into
 * a string a caller might log. {@link OpenedSecret} is the structural half of
 * that: the plaintext is not a property of the object, so `JSON.stringify`,
 * `console.log`, a template literal and a spread all produce the mask instead.
 * Care at the call sites is worth less than a type that cannot be misused, and
 * there are a great many call sites.
 */

import { SECRET_MASK } from './constants';

// ─── The algorithm ───────────────────────────────────────────────────────────

/**
 * Which cipher an envelope was produced with.
 *
 * One member today, and it is named rather than assumed so that a second is a
 * new member with a reader rather than a format change with no way to tell the
 * two apart. The value matches what `vault.ts` already uses.
 */
export const SEAL_ALGORITHMS = ['AES_256_GCM'] as const;
export type SealAlgorithm = (typeof SEAL_ALGORITHMS)[number];

/** The algorithm a new envelope is written with. Reading is never limited to it. */
export const SEAL_WRITE_ALGORITHM: SealAlgorithm = 'AES_256_GCM';

// ─── The keys ────────────────────────────────────────────────────────────────

/**
 * WHERE ONE VAULT KEY'S STATE SITS IN ITS LIFE. Mirrors the `VaultKeyState`
 * Prisma enum; `check:enums` diffs them.
 *
 * Four, and the fourth is the one this round exists for:
 *
 *   ACTIVE      new values are sealed with it, and it opens what it sealed.
 *               EXACTLY ONE key may be ACTIVE — see {@link selectSealingKey}.
 *   READABLE    opens what it sealed and seals nothing new. This is the state
 *               a rotated-out key sits in while the re-seal sweep drains, and
 *               it is the state that makes rotation possible at all.
 *   RETIRED     opens nothing. Set only once a sweep has PROVED there is
 *               nothing left sealed under it; retiring a key with rows still
 *               under it is how data is lost, so the sweep record
 *               ({@link KEY_ROTATION_STATES}) is the evidence for this
 *               transition rather than somebody's recollection.
 *   COMPROMISED opens nothing, AND IS DISTINCT FROM RETIRED ON PURPOSE. A
 *               retired key is finished with; a compromised one is an incident,
 *               and the rows still sealed under it are the blast radius. One
 *               state for both would make "we rotated" and "we were breached"
 *               the same fact, which is the fact an auditor is asking about.
 */
export const VAULT_KEY_STATES = ['ACTIVE', 'READABLE', 'RETIRED', 'COMPROMISED'] as const;
export type VaultKeyState = (typeof VAULT_KEY_STATES)[number];

/**
 * WHO HOLDS THE KEY MATERIAL. Mirrors the `VaultKeyProvider` Prisma enum.
 *
 * LOCAL is the master key this deployment already has. KMS is a key whose
 * material never enters this process; the row then carries a REFERENCE (a key
 * identifier the provider understands) and not the key.
 *
 * The product works with no KMS configured — LOCAL is the default and the only
 * provider any existing row can have — which is the condition the one permitted
 * new environment variable is held to.
 */
export const VAULT_KEY_PROVIDERS = ['LOCAL', 'KMS'] as const;
export type VaultKeyProvider = (typeof VAULT_KEY_PROVIDERS)[number];

/** What a key in one state may do. Both directions, because they are not opposites. */
export interface VaultKeyStateRule {
  /** May a value sealed under this key be opened? */
  readonly canOpen: boolean;
  /** May a NEW value be sealed under this key? True for ACTIVE alone. */
  readonly canSeal: boolean;
  /**
   * True when rows still sealed under this key are an INCIDENT rather than a
   * backlog. Drives the sweep's urgency and nothing else; it is not a synonym
   * for `canOpen`.
   */
  readonly isIncident: boolean;
  /** One sentence for the operator deciding whether to move a key into this state. */
  readonly why: string;
}

/**
 * The compiler-enforced presence record. A `Record<VaultKeyState, …>` cannot be
 * written without naming every member, so a fifth state is a type error here
 * rather than a key whose read and write permissions are undefined — and
 * `undefined` read as falsy would silently make every key unusable, while
 * `undefined` read as truthy would make a COMPROMISED key work.
 *
 * Both halves, because one without the other passes while the two disagree:
 * this is the compile-time half and `vaultKeyStateSchema.options` in schemas.ts
 * is the run-time half.
 */
export const VAULT_KEY_STATE_RULES = {
  ACTIVE: {
    canOpen: true,
    canSeal: true,
    isIncident: false,
    why: 'The key new values are sealed with. Exactly one key may be in this state.',
  },
  READABLE: {
    canOpen: true,
    canSeal: false,
    isIncident: false,
    why: 'Rotated out. It still opens what it sealed while the re-seal sweep drains, which is what makes rotation possible without a flag day.',
  },
  RETIRED: {
    canOpen: false,
    canSeal: false,
    isIncident: false,
    why: 'Finished with. Set only once a sweep has proved nothing is sealed under it; retiring a key with rows still under it loses that data.',
  },
  COMPROMISED: {
    canOpen: false,
    canSeal: false,
    isIncident: true,
    why: 'Known or suspected to have leaked. It opens nothing, and every row still sealed under it is the blast radius of the incident.',
  },
} as const satisfies Record<VaultKeyState, VaultKeyStateRule>;

/**
 * WHERE A RE-ENCRYPTION SWEEP IS. Mirrors the `KeyRotationState` Prisma enum.
 *
 * A sweep exists so that rotation is RESUMABLE and AUDITABLE. Resumable,
 * because re-sealing every secret in a large install is not one transaction and
 * a process that dies halfway must not start again from the top. Auditable,
 * because "we rotated the key" is a claim, and the rows it re-sealed, the rows
 * it could not, and the point it reached are the evidence for it.
 *
 * FAILED is a terminal state that keeps its cursor, which is the difference
 * between a sweep that can be resumed and one that has to be re-run.
 */
export const KEY_ROTATION_STATES = [
  'PENDING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
] as const;
export type KeyRotationState = (typeof KEY_ROTATION_STATES)[number];

/** States a sweep may be picked up from. Terminal states are deliberately absent. */
export const RESUMABLE_ROTATION_STATES: readonly KeyRotationState[] = [
  'PENDING',
  'RUNNING',
  'PAUSED',
  'FAILED',
];

// ─── What a key row looks like to this module ────────────────────────────────

/**
 * The fields of a `VaultKey` row this module reasons about.
 *
 * A STRUCTURAL SUBSET AND NOT THE PRISMA TYPE, so `@qaai/shared` does not
 * depend on a generated client — and so a caller may hand in a projection.
 * NOTE for that caller: a `select` that drops `state` would make every key look
 * the same to {@link selectSealingKey}, so the type demands all three fields
 * rather than optional ones. A hand-copied projection inside a function is the
 * same hazard as a select-blind fake, and this round has already paid for it
 * once.
 */
export interface VaultKeyRef {
  /** Stable identifier written into the envelope. Never key material. */
  readonly keyId: string;
  /** Monotonic. The envelope carries it, so it must never be reused. */
  readonly version: number;
  readonly state: VaultKeyState;
}

// ─── The refusals ────────────────────────────────────────────────────────────

/**
 * Every way opening or sealing a value can fail. Closed, because each one is a
 * case a caller must handle and `catch {}` is not handling.
 *
 * THERE IS NO `UNKNOWN` MEMBER, for the reason `AddressClass` has none: there
 * is nothing a caller would do with it that it does not already do with
 * MALFORMED_ENVELOPE.
 */
export const SEAL_REFUSALS = [
  /** The stored string is not an envelope this build can read. */
  'MALFORMED_ENVELOPE',
  /** The envelope names an envelope format from the future. */
  'UNKNOWN_ENVELOPE_VERSION',
  /** The envelope names a cipher this build does not have. */
  'UNKNOWN_ALGORITHM',
  /** No key row in this deployment has that version. THE fail-closed case. */
  'UNKNOWN_KEY_VERSION',
  /** The key exists and its state forbids opening (RETIRED). */
  'KEY_NOT_READABLE',
  /** The key exists and has leaked. Distinct from NOT_READABLE: it is an incident. */
  'KEY_COMPROMISED',
  /** Nothing is ACTIVE, so nothing may be sealed. Refuse; do not fall back. */
  'NO_WRITABLE_KEY',
  /** More than one key is ACTIVE. Ambiguous, therefore refused. */
  'MORE_THAN_ONE_WRITABLE_KEY',
  /** The envelope is bound to a different model, row or field than the caller asked for. */
  'AAD_MISMATCH',
  /** The caller named a (model, field) pair that is not a sealed field. */
  'NOT_A_SEALED_FIELD',
] as const;
export type SealRefusal = (typeof SEAL_REFUSALS)[number];

/**
 * A refusal, with a detail string an operator can act on.
 *
 * `detail` NEVER CONTAINS CIPHERTEXT, PLAINTEXT, A NONCE OR KEY MATERIAL — not
 * truncated and not hashed. It names the refusal, the field and, where it is
 * the point, the key VERSION, which is an integer. An error about a secret must
 * be reportable without quoting any part of it, and `sealed.test.ts` asserts
 * that for every member of {@link SEAL_REFUSALS}.
 */
export interface SealFailure {
  readonly ok: false;
  readonly refusal: SealRefusal;
  readonly detail: string;
}

export type SealResult<T> = { readonly ok: true; readonly value: T } | SealFailure;

function fail(refusal: SealRefusal, detail: string): SealFailure {
  return { ok: false, refusal, detail };
}

// ─── Which fields are sealed, and what the AAD binds ────────────────────────

/**
 * EVERY FIELD IN THIS PRODUCT THAT HOLDS A SEALED VALUE.
 *
 * ── Why a closed vocabulary rather than two strings at each call site ───────
 *
 * The additional authenticated data is what stops a ciphertext being MOVED, and
 * it only works if both ends compose it identically. `vault.ts` composes
 * `${orgId}:${name}` inline today, which is correct and is also a format that
 * exists in exactly one place with no name — so the second caller to need it
 * will write `${orgId}-${name}` and discover the mistake as an undecryptable
 * column. Naming the pairs makes the composition a function
 * ({@link aadFor}) and a typo a compile error.
 *
 * ── What each one is, and the one that is new ──────────────────────────────
 *
 *   Secret.valueEnc            the existing vault. Already versioned, already
 *                              AAD-bound; listed so the vocabulary is complete
 *                              and so a sweep can enumerate what it must visit.
 *   User.totpSecretEnc         the TOTP seed. Its column name has always said
 *                              `Enc` and it has NEVER HAD A KEY VERSION beside
 *                              it, so it cannot participate in a rotation at
 *                              all today.
 *   AuthProfile.storageState   LIVE CUSTOMER SESSION COOKIES, in a plain JSON
 *                              column. This is the one this round seals.
 *
 * `scope` is the fact a sweep and an audit need: a key rotation has to visit
 * every sealed field, and the three are reached by different queries because
 * one is global and two are tenanted.
 */
export const SEALED_FIELDS = {
  'Secret.valueEnc': {
    model: 'Secret',
    field: 'valueEnc',
    scope: 'ORG',
    what: 'An environment secret, as stored by the §1 vault.',
  },
  'User.totpSecretEnc': {
    model: 'User',
    field: 'totpSecretEnc',
    scope: 'GLOBAL',
    what: 'A TOTP seed. Possession of it is possession of the second factor.',
  },
  'AuthProfile.storageState': {
    model: 'AuthProfile',
    field: 'storageState',
    scope: 'ORG',
    what: "A cached browser session for the customer's own application. A live credential.",
  },
} as const;

export type SealedFieldKey = keyof typeof SEALED_FIELDS;

/**
 * The same three keys as a TUPLE OF LITERALS, so `z.enum` can consume them.
 *
 * Written out rather than `Object.keys(SEALED_FIELDS)`, which types as
 * `string[]` and would make `sealedFieldKeySchema.options` a list of plain
 * strings — a schema that accepts any string while looking like an enum. The
 * `satisfies` below makes a typo here a compile error, and
 * `sealed.test.ts` asserts this tuple and the object's own keys are the same
 * set, so a fourth sealed field added to one and not the other is caught rather
 * than being a field no write path can name.
 */
export const SEALED_FIELD_KEYS = [
  'Secret.valueEnc',
  'User.totpSecretEnc',
  'AuthProfile.storageState',
] as const satisfies readonly SealedFieldKey[];

/** What one sealed field is, for a sweep and for an audit. */
export interface SealedFieldRule {
  readonly model: string;
  readonly field: string;
  /** ORG rows are reached per tenant; GLOBAL rows are not tenanted at all. */
  readonly scope: 'ORG' | 'GLOBAL';
  readonly what: string;
}

/**
 * The run-time half of the presence record above. The compile-time half is the
 * `satisfies` below; together they stop a fourth sealed field existing with no
 * entry (which would make it invisible to a rotation sweep — a row nothing
 * re-seals is a row that stays readable under a compromised key for ever).
 */
export const SEALED_FIELD_RULES: Record<SealedFieldKey, SealedFieldRule> =
  SEALED_FIELDS satisfies Record<SealedFieldKey, SealedFieldRule>;

/** True for a string that names a sealed field. Narrows, so a caller may not guess. */
export function isSealedFieldKey(value: string): value is SealedFieldKey {
  return Object.prototype.hasOwnProperty.call(SEALED_FIELDS, value);
}

/**
 * WHAT A CIPHERTEXT IS BOUND TO. The model, the row and the field — all three.
 *
 * All three and not two: binding to (model, row) alone would let a sealed TOTP
 * seed be pasted over the same user's sealed anything-else, and binding to
 * (model, field) alone is the move this exists to prevent, one AuthProfile's
 * session onto another.
 */
export interface SealAad {
  readonly fieldKey: SealedFieldKey;
  readonly rowId: string;
}

/**
 * The one composition of the additional authenticated data.
 *
 * `\u001f` (the ASCII unit separator) rather than `:` between the parts,
 * because a cuid cannot contain it and neither can a field name — so there is
 * no pair of distinct bindings that composes to the same string. `a:b` + `c`
 * and `a` + `b:c` are the same AAD with a colon, and "the same AAD" is exactly
 * what must not happen by accident.
 *
 * NOTE, because a doc comment that contradicts the code under it is the worst
 * kind in a security file: this is NOT the composition `apps/api/src/lib/vault.ts`
 * uses for `Secret.valueEnc` today. That one is `${orgId}:${name}` and it is
 * load-bearing for every secret already in every customer's database, so it
 * cannot be changed without re-sealing all of them. This function is for fields
 * being sealed from now on, and `Secret.valueEnc` moves to it only as part of a
 * rotation sweep that re-seals under the new binding. Until then the vocabulary
 * entry above describes the field and this function does not produce its AAD.
 */
export function aadFor(aad: SealAad): string {
  const rule = SEALED_FIELD_RULES[aad.fieldKey];
  return `${rule.model}\u001f${aad.rowId}\u001f${rule.field}`;
}

// ─── The envelope ────────────────────────────────────────────────────────────

/**
 * The envelope format marker. `qs` for "qaai sealed", `1` for this layout.
 *
 * A marker and not a bare base64 blob, so that a column holding a value from a
 * FUTURE build is refused by name (UNKNOWN_ENVELOPE_VERSION) instead of being
 * fed to a cipher that will produce bytes and no error. A downgrade is the
 * normal shape of a rollback, and a rollback must fail loudly.
 */
export const SEAL_ENVELOPE_PREFIX = 'qs1';

/**
 * One sealed value, parsed.
 *
 * `payload` is the opaque, cipher-specific bytes — for AES-256-GCM it is the
 * `iv | tag | ciphertext` base64 layout `vault.ts` already writes, and this
 * module deliberately does not look inside it. Splitting it here would put the
 * nonce length in two files.
 */
export interface SealedEnvelope {
  readonly keyId: string;
  readonly keyVersion: number;
  readonly alg: SealAlgorithm;
  /** base64, cipher-specific. NEVER logged, never interpolated into a message. */
  readonly payload: string;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Serialise an envelope for storage in a single TEXT column.
 *
 * One column and not five, matching `Secret.valueEnc`: five columns is five
 * chances for a writer to update four of them, and a partially-updated envelope
 * is an undecryptable row that looks fine. The key VERSION is additionally
 * mirrored into its own integer column on the row so that "which rows are still
 * under key 1" is an indexed query rather than a string scan — that column is a
 * denormalisation of this string and {@link envelopeMatchesVersionColumn} is
 * what stops the two disagreeing.
 */
export function serialiseEnvelope(envelope: SealedEnvelope): string {
  return [
    SEAL_ENVELOPE_PREFIX,
    envelope.keyId,
    String(envelope.keyVersion),
    envelope.alg,
    envelope.payload,
  ].join('.');
}

/**
 * Read a stored envelope, refusing everything this build cannot name.
 *
 * FAILS CLOSED AT EVERY STEP. There is no arm that returns a partially
 * understood envelope and no arm that returns an empty payload: a column that
 * cannot be parsed is a refusal, because the alternative — "treat it as absent"
 * — is how an unreadable session silently becomes an anonymous run.
 *
 * The detail strings name the refusal and the structural fact behind it and
 * NEVER a byte of the payload.
 */
export function parseEnvelope(raw: unknown): SealResult<SealedEnvelope> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail('MALFORMED_ENVELOPE', 'The stored value is not a non-empty string.');
  }
  const parts = raw.split('.');
  if (parts.length !== 5) {
    return fail(
      'MALFORMED_ENVELOPE',
      `A sealed value has 5 dot-separated parts; this one has ${parts.length}.`,
    );
  }
  const [prefix, keyId, versionText, alg, payload] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (prefix !== SEAL_ENVELOPE_PREFIX) {
    /*
     * Named rather than coerced. A value written by a newer build is the normal
     * shape of a rollback, and guessing at it would hand a future layout to a
     * cipher that answers with bytes instead of an error.
     */
    return fail(
      'UNKNOWN_ENVELOPE_VERSION',
      `This build reads ${SEAL_ENVELOPE_PREFIX} envelopes and the stored value is not one.`,
    );
  }
  if (!KEY_ID.test(keyId)) {
    return fail('MALFORMED_ENVELOPE', 'The key id is not a key id this build can read.');
  }
  if (!/^[1-9][0-9]{0,8}$/.test(versionText)) {
    // Not `Number.parseInt`: that reads `1x` as 1, and a key version is the one
    // field where a lenient parse selects the wrong key and still succeeds.
    return fail('MALFORMED_ENVELOPE', 'The key version is not a positive integer.');
  }
  if (!(SEAL_ALGORITHMS as readonly string[]).includes(alg)) {
    return fail(
      'UNKNOWN_ALGORITHM',
      'The envelope names a cipher this build does not have. It was NOT attempted.',
    );
  }
  if (payload.length === 0 || !BASE64.test(payload)) {
    return fail('MALFORMED_ENVELOPE', 'The payload is not base64.');
  }
  return {
    ok: true,
    value: {
      keyId,
      keyVersion: Number(versionText),
      alg: alg as SealAlgorithm,
      payload,
    },
  };
}

/**
 * True when the row's `…KeyVersion` integer column agrees with the envelope.
 *
 * The integer column exists so that "which rows are still under key 1" is an
 * indexed query. A denormalisation that can drift is a denormalisation that
 * will, and the direction it drifts matters: a row whose column says 2 while
 * its envelope says 1 is a row a sweep will skip and a compromised key will
 * keep opening. So the writer checks, and a mismatch is a refusal rather than a
 * preference for one of the two numbers.
 */
export function envelopeMatchesVersionColumn(
  envelope: SealedEnvelope,
  column: number | null,
): boolean {
  return column !== null && column === envelope.keyVersion;
}

// ─── Choosing a key ─────────────────────────────────────────────────────────

/**
 * The key a NEW value is sealed under: the single ACTIVE one.
 *
 * REFUSES on both ambiguity and absence, and neither falls back. Two ACTIVE
 * keys means half the rows written today are openable only by one of them and
 * nobody can say which half; no ACTIVE key means the deployment is
 * misconfigured, and sealing under a READABLE key "just this once" is how a
 * rotation ends with values under a key that is about to be retired.
 */
export function selectSealingKey(keys: readonly VaultKeyRef[]): SealResult<VaultKeyRef> {
  const writable = keys.filter((key) => VAULT_KEY_STATE_RULES[key.state].canSeal);
  if (writable.length === 0) {
    return fail(
      'NO_WRITABLE_KEY',
      'No vault key is ACTIVE, so nothing may be sealed. Exactly one key must be ACTIVE.',
    );
  }
  if (writable.length > 1) {
    return fail(
      'MORE_THAN_ONE_WRITABLE_KEY',
      `${writable.length} vault keys are ACTIVE. Exactly one must be; the others belong in READABLE.`,
    );
  }
  return { ok: true, value: writable[0]! };
}

/**
 * The key that may open this envelope, or a named refusal.
 *
 * THE FAIL-CLOSED HEART OF THIS FILE. An unknown version does not become a
 * decrypt attempt against whatever key happens to be to hand, and a
 * COMPROMISED key is refused SEPARATELY from a merely unreadable one — an
 * operator reading "KEY_COMPROMISED" is reading the blast radius of an
 * incident, and "KEY_NOT_READABLE" is reading a retirement that went ahead too
 * early. Collapsing the two would make the difference between a mistake and a
 * breach a matter of inference.
 */
export function selectOpeningKey(
  envelope: SealedEnvelope,
  keys: readonly VaultKeyRef[],
): SealResult<VaultKeyRef> {
  const key = keys.find((candidate) => candidate.version === envelope.keyVersion);
  if (!key) {
    return fail(
      'UNKNOWN_KEY_VERSION',
      `No vault key in this deployment has version ${envelope.keyVersion}, so the value was NOT ` +
        'opened. Nothing was attempted against another key.',
    );
  }
  if (key.state === 'COMPROMISED') {
    return fail(
      'KEY_COMPROMISED',
      `Vault key version ${envelope.keyVersion} is marked COMPROMISED. Every value still sealed ` +
        'under it is part of that incident and none of them will be opened.',
    );
  }
  if (!VAULT_KEY_STATE_RULES[key.state].canOpen) {
    return fail(
      'KEY_NOT_READABLE',
      `Vault key version ${envelope.keyVersion} is ${key.state} and opens nothing. A key is only ` +
        'retired once a sweep has proved no value is sealed under it; this value is evidence that ' +
        'was not true.',
    );
  }
  return { ok: true, value: key };
}

/**
 * True when a value should be re-sealed under the current ACTIVE key.
 *
 * ── Why this exists when `vault.ts` already exports `needsRotation` ────────
 *
 * Because that one has NO CALLER, takes no account of key STATE, and compares
 * against a module-level constant rather than against the deployment's own
 * keys. A minted function owes a production caller in the same round it is
 * minted, and the sweep in this round is that caller.
 *
 * `urgent` is not a second opinion on `needed`: a value under a COMPROMISED key
 * needs re-sealing for a different reason and on a different clock from one
 * under a merely superseded key, and one boolean for both would make a sweep
 * unable to put the incident first. Two facts, two fields — the lesson
 * `verified` taught when it was true for a heal that left the test red.
 */
export function resealVerdict(
  envelope: SealedEnvelope,
  keys: readonly VaultKeyRef[],
): { readonly needed: boolean; readonly urgent: boolean; readonly why: string } {
  const key = keys.find((candidate) => candidate.version === envelope.keyVersion);
  if (!key) {
    return {
      needed: true,
      urgent: true,
      why: `Sealed under key version ${envelope.keyVersion}, which this deployment does not have. It cannot be opened, so it cannot be re-sealed either; it must be re-created.`,
    };
  }
  if (key.state === 'COMPROMISED') {
    return {
      needed: true,
      urgent: true,
      why: `Sealed under key version ${envelope.keyVersion}, which is COMPROMISED.`,
    };
  }
  const sealing = selectSealingKey(keys);
  if (!sealing.ok) {
    return { needed: false, urgent: false, why: sealing.detail };
  }
  if (sealing.value.version === envelope.keyVersion) {
    return { needed: false, urgent: false, why: 'Already sealed under the ACTIVE key.' };
  }
  return {
    needed: true,
    urgent: false,
    why: `Sealed under key version ${envelope.keyVersion}; the ACTIVE key is version ${sealing.value.version}.`,
  };
}

// ─── The opened plaintext ───────────────────────────────────────────────────

/**
 * The plaintexts, held OUTSIDE the objects that represent them.
 *
 * This is the whole mechanism. Because the value is not a property of the
 * instance, `JSON.stringify`, `console.log`, `util.inspect`, a template
 * literal, a spread into a log line, an error's `cause`, a structured-log
 * serialiser and a metric label ALL fail to reach it — not by remembering to
 * mask, but because there is nothing there to find. A `#private` field would
 * stop the spread and not `util.inspect`; a masked getter would stop neither.
 *
 * A `WeakMap` so an opened secret is collectable the moment the caller drops it.
 */
const PLAINTEXT = new WeakMap<OpenedSecret, string>();

/**
 * AN OPENED SECRET. A plaintext that resists being written down.
 *
 * Every accessor a logger, a serialiser or a string coercion would reach for
 * answers with {@link SECRET_MASK}. The value comes out of exactly two
 * functions — {@link useSecret}, which is the one to use, and
 * {@link revealSecret}, which exists for the handful of APIs that demand a bare
 * string — so "where does this plaintext go" is a grep for two names rather
 * than a reading of every call site.
 *
 * It carries `fieldKey`, `rowId` and `bytes` in the clear, deliberately: those
 * three make a refusal reportable without quoting anything, which is the
 * property rule 11 asks for and the thing that is usually missing when an error
 * path ends up printing a token.
 */
export class OpenedSecret {
  /** Which sealed field this came out of. Not a secret; it is a column name. */
  readonly fieldKey: SealedFieldKey;
  /** The row it belongs to. Not a secret; it is a cuid. */
  readonly rowId: string;
  /** The plaintext's length. Not the plaintext. Lets a caller say "it was empty". */
  readonly bytes: number;

  constructor(plaintext: string, aad: SealAad) {
    this.fieldKey = aad.fieldKey;
    this.rowId = aad.rowId;
    this.bytes = plaintext.length;
    PLAINTEXT.set(this, plaintext);
  }

  /** `${opened}` and string concatenation. */
  toString(): string {
    return SECRET_MASK;
  }

  /** `+opened`, and anything that prefers a primitive. */
  valueOf(): string {
    return SECRET_MASK;
  }

  /** `JSON.stringify`, which is what most structured loggers are. */
  toJSON(): { sealedField: string; rowId: string; bytes: number; value: string } {
    return {
      sealedField: this.fieldKey,
      rowId: this.rowId,
      bytes: this.bytes,
      value: SECRET_MASK,
    };
  }

  /**
   * `console.log` and `util.inspect` on Node, which do NOT go through `toJSON`
   * and would otherwise print the object's shape. Declared with
   * `Symbol.for` rather than importing `node:util`, so this file still has no
   * Node dependency and the hook is simply ignored in a browser.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `OpenedSecret(${this.fieldKey} ${SECRET_MASK})`;
  }

  get [Symbol.toStringTag](): string {
    return 'OpenedSecret';
  }
}

/**
 * Use a plaintext inside a callback, and let it go.
 *
 * THE ONE TO USE. The plaintext never becomes a variable in the caller's scope,
 * so it cannot be captured by a closure that outlives the call, attached to an
 * error, or still be in a local when something later serialises the frame.
 *
 * It does not catch: an exception from `fn` propagates unchanged, because
 * swallowing it here would make a failure inside a secret-using block look like
 * a failure to obtain the secret.
 */
export function useSecret<T>(opened: OpenedSecret, fn: (plaintext: string) => T): T {
  const value = PLAINTEXT.get(opened);
  if (value === undefined) {
    // Reachable only if an OpenedSecret crossed a structured-clone or
    // serialisation boundary, which strips the WeakMap entry. Fail closed and
    // say what happened without quoting anything.
    throw new Error(
      `This OpenedSecret (${opened.fieldKey}) carries no plaintext — it has been serialised and ` +
        'must be re-opened from the sealed column.',
    );
  }
  return fn(value);
}

/**
 * The plaintext, as a bare string.
 *
 * For the APIs that cannot take a callback — a browser's `addCookies`, an HTTP
 * header, a child process's environment. Named so that `grep revealSecret` is
 * the complete list of places a plaintext escapes the type, and that list is
 * meant to stay short enough to read.
 */
export function revealSecret(opened: OpenedSecret): string {
  return useSecret(opened, (plaintext) => plaintext);
}
