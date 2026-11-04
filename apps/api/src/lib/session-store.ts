/**
 * THE SESSION STORE — the one path that seals and opens a cached customer
 * session, and the one place that decides whether a run may use it.
 *
 * ─── THE DEFECT, REPRODUCED AT HEAD 37498c1 ─────────────────────────────────
 *
 * `AuthProfile.storageState` held LIVE CUSTOMER SESSION COOKIES for the
 * customer's own application in a plain, unencrypted JSON column. Possession of
 * that value IS possession of the customer's session, which makes it the
 * highest-value secret this product holds, and it was the only credential in
 * the product that never went through the §1 vault.
 *
 * Beside it sat a second defect that is a CORRECTNESS defect and not only a
 * security one. The 8-hour TTL on `storageStateExpiresAt` was never refreshed,
 * and every reader spelt the same three lines:
 *
 *     const fresh = profile.storageState &&
 *       (!profile.storageStateExpiresAt || profile.storageStateExpiresAt > new Date());
 *
 * — so an expired session became `null`, and `null` became
 * `session = { ok: true, storageState }` (apps/worker/src/processors/run.ts
 * around line 1426). The run then executed ANONYMOUSLY and reported a pass.
 * Every auth-gated route it touched looked covered by a test that was never
 * signed in, which is a coverage number assembled out of our own silence.
 *
 * Note the `!profile.storageStateExpiresAt ||` arm: a null expiry was read as
 * "valid forever". That is the opposite of what a missing expiry can honestly
 * mean, and it is the reason {@link SESSION_STATES} has a member for it.
 *
 * ─── WHAT THIS FILE IS ──────────────────────────────────────────────────────
 *
 * Two things, deliberately in one module because they are the same decision
 * read twice:
 *
 *   1. SEAL and OPEN, over the keystone's envelope
 *      (`packages/shared/src/sealed.ts`), with the AAD bound to the profile ROW
 *      so a ciphertext cannot be moved between profiles.
 *   2. THE GATE — {@link sessionGate} — which turns a row into one of eight
 *      named states and says, for each, whether a run may proceed, and if not,
 *      which typed NOT_RUN it must record. FAIL CLOSED: a session this module
 *      cannot vouch for does not become an anonymous pass.
 *
 * ─── IT NEVER PRINTS WHAT IT PROTECTS ──────────────────────────────────────
 *
 * The plaintext leaves this module only as an {@link OpenedSecret}, whose
 * plaintext is held outside the object, so a log line, a JSON serialiser, a
 * template literal and a spread all find the mask instead. No refusal detail,
 * no gate sentence and no audit metadata produced here contains the session,
 * the envelope payload, a nonce or key material — not truncated and not hashed.
 * `session-store.test.ts` asserts that for every refusal this module can
 * produce, which is the "report the failure without quoting the secret"
 * property rule 11 asks for.
 *
 * ─── AND IT TAKES ITS CRYPTO AS AN INTERFACE ───────────────────────────────
 *
 * {@link SessionCipher} is injected, so every decision in this file is testable
 * with a fake and no key material, no clock and no database. The LOCAL
 * implementation is {@link localSessionCipher} and it writes the SAME
 * `iv | tag | ciphertext` base64 layout `apps/api/src/lib/vault.ts` already
 * writes, so the two are one format and not two.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { controlEnforces } from '@qaai/shared';
import type { ControlMode, NotRunKind } from '@qaai/shared';
/*
 * THE SEALED-VALUE VOCABULARY, BY A FOUR-DOT RELATIVE PATH.
 *
 * `packages/shared/src/index.ts` does not re-export `./sealed` yet, and
 * `packages/shared/package.json` has no `./sealed` subpath either — so there is
 * no barrel specifier to use. This is the same workaround, for the same reason,
 * that `apps/api/src/lib/ownership.ts` records above its own import and that
 * `apps/worker/src/processors/retention.ts` uses for `@qaai/storage`'s `gc.ts`.
 * It resolves identically under tsc, tsx and vitest. The one-line barrel edit
 * that retires it is in this slice's `needsFromOtherFiles`.
 */
import {
  OpenedSecret,
  SEAL_WRITE_ALGORITHM,
  aadFor,
  envelopeMatchesVersionColumn,
  parseEnvelope,
  selectOpeningKey,
  selectSealingKey,
  serialiseEnvelope,
  useSecret,
} from '../../../../packages/shared/src/sealed.js';
import type {
  SealRefusal,
  SealedFieldKey,
  VaultKeyRef,
  VaultKeyState,
} from '../../../../packages/shared/src/sealed.js';
import { VAULT_KEY_STATES } from '../../../../packages/shared/src/sealed.js';

// ─── Which sealed field this module owns ─────────────────────────────────────

/**
 * The one sealed field this module is about.
 *
 * A constant rather than a string at each call site, because it is half of the
 * AAD: a call that composed `'AuthProfile.storageState '` with a trailing space
 * would seal values nothing could ever open, and the failure would arrive one
 * deploy later as a column full of undecryptable rows.
 */
export const SESSION_FIELD_KEY: SealedFieldKey = 'AuthProfile.storageState';

/**
 * How long before expiry a session is treated as due for refresh.
 *
 * ONE HOUR OF AN EIGHT-HOUR TTL. The point is to refresh BEFORE a run needs the
 * session rather than during it: a nightly suite that starts seven hours and
 * fifty-nine minutes after the last login would otherwise discover the problem
 * in the middle of its first test, which is the shape the original defect took.
 * A session inside this window is still USABLE — see {@link SESSION_STATE_RULES}
 * — because refusing a session that is valid for another fifty minutes would
 * turn a refresh outage into a run outage.
 */
export const SESSION_REFRESH_LEAD_MS = 60 * 60_000;

// ─── The cipher, injected ────────────────────────────────────────────────────

/**
 * ENCRYPT AND DECRYPT ONE STRING UNDER ONE KEY VERSION, WITH AAD.
 *
 * Narrow on purpose. It is the complete surface a KMS provider has to implement
 * (`VaultKey.provider = KMS`, whose material never enters this process), and it
 * is the complete surface a test has to fake. Both halves matter: a control
 * whose cipher is a module-level `node:crypto` call is a control whose refusals
 * can only be tested by holding real key material, which is how a security test
 * suite ends up with a key in it.
 *
 * Async because a KMS round-trip is, and because making it async later would
 * change every caller.
 */
export interface SessionCipher {
  /** Returns the opaque, cipher-specific base64 payload. Never a whole envelope. */
  readonly encrypt: (input: {
    plaintext: string;
    keyVersion: number;
    aad: string;
  }) => Promise<string>;
  readonly decrypt: (input: {
    payload: string;
    keyVersion: number;
    aad: string;
  }) => Promise<string>;
}

/**
 * Where one key version's material comes from, for a LOCAL provider.
 *
 * NULL FOR A VERSION THIS PROCESS CANNOT NAME, never a throw and never a
 * fallback to another version: handing version 2's ciphertext to version 1's
 * key produces an authentication-tag failure, and a caught tag failure is
 * indistinguishable from tampering. {@link openSession} turns the null into the
 * named refusal.
 */
export type KeyMaterialResolver = (version: number) => Buffer | null;

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM standard, and matches vault.ts.
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * The resolver for a deployment whose only key is the existing master key.
 *
 * VERSION 1 ONLY, AND THAT IS NOT A LIMITATION THIS ROUND HID. The master key
 * arrives in one environment variable (`VAULT_MASTER_KEY`), so one process
 * holds one piece of LOCAL material; a second LOCAL version has nowhere to come
 * from until the key-rotation slice decides where that is, and inventing a
 * second environment variable here would be deciding it for them. Every other
 * version resolves to null, which is a named refusal rather than a silent
 * decrypt against the wrong key.
 *
 * The caller passes the base64 string — `env.VAULT_MASTER_KEY` in the API,
 * `config.vaultMasterKey` in the worker — so this module imports neither of
 * those and can therefore be imported by a unit test without a configured
 * environment.
 */
export function masterKeyResolver(base64: string): KeyMaterialResolver {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_LENGTH) {
    // Thrown at construction, not at use: a deployment with a malformed master
    // key must fail where the operator can see it, exactly as env.ts intends,
    // rather than one run later as an undecryptable session.
    throw new Error(`VAULT_MASTER_KEY must decode to exactly ${KEY_LENGTH} bytes`);
  }
  return (version) => (version === 1 ? key : null);
}

/** Thrown only inside {@link localSessionCipher}; every caller converts it to a refusal. */
class NoKeyMaterialError extends Error {
  constructor(readonly keyVersion: number) {
    super(`This process holds no vault key material for version ${keyVersion}`);
    this.name = 'NoKeyMaterialError';
  }
}

/**
 * AES-256-GCM, in the layout the vault already uses.
 *
 * `iv | tag | ciphertext`, base64, self-contained — byte-identical to
 * `apps/api/src/lib/vault.ts`, so the payload inside a `qs1` envelope and the
 * payload inside `Secret.valueEnc` are the same bytes in the same order. Two
 * layouts would mean the key-rotation sweep has to know which field it is
 * looking at before it can read one.
 *
 * NOTHING HERE IS LOGGED OR PUT IN A MESSAGE. The decrypt failure is
 * deliberately opaque for the reason vault.ts gives: distinguishing "wrong key"
 * from "tampered" leaks information, and here it would also be an oracle over
 * which sessions are real.
 */
export function localSessionCipher(resolve: KeyMaterialResolver): SessionCipher {
  const keyFor = (version: number): Buffer => {
    const key = resolve(version);
    if (key === null) throw new NoKeyMaterialError(version);
    return key;
  };

  return {
    encrypt: async ({ plaintext, keyVersion, aad }) => {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, keyFor(keyVersion), iv, {
        authTagLength: TAG_LENGTH,
      });
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    decrypt: async ({ payload, keyVersion, aad }) => {
      const key = keyFor(keyVersion);
      const raw = Buffer.from(payload, 'base64');
      if (raw.length < IV_LENGTH + TAG_LENGTH + 1) throw new Error('Malformed sealed payload');
      const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_LENGTH), {
        authTagLength: TAG_LENGTH,
      });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
      return Buffer.concat([
        decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

// ─── The row, and the projection that reads it ───────────────────────────────

/**
 * THE FIELDS OF AN `AuthProfile` ROW THIS MODULE DECIDES ON.
 *
 * EVERY FIELD IS REQUIRED, none optional, and that is the lesson a previous
 * slice paid for twice: an internal map typed `{ key, status, label }` re-listed
 * those three fields and dropped the fourth, and every test passed until it was
 * mutation-proved. An optional field here would let a caller hand in a
 * projection that omits `storageStateNeedsReseal`, and `undefined` read as
 * falsy would make a row the migration marked for re-seal look perfectly fresh.
 */
export interface SealedSessionRow {
  readonly id: string;
  /**
   * THE LEGACY PLAINTEXT COLUMN. Read for ONE purpose: to notice that it is not
   * null, which means a writer that predates the sealing migration has run
   * since. Its value is never opened, never logged and never used — see
   * `LEGACY_PLAINTEXT` in {@link SESSION_STATE_RULES}.
   */
  readonly storageState: unknown;
  readonly storageStateExpiresAt: Date | null;
  readonly storageStateSealed: string | null;
  readonly storageStateKeyVersion: number | null;
  readonly storageStateNeedsReseal: boolean;
}

/**
 * The Prisma `select` for {@link SealedSessionRow} — ONE definition, and the
 * compiler enforces that it names every field.
 *
 * `satisfies Record<keyof SealedSessionRow, true>` is the whole point: a field
 * added to the interface and not to this object is a compile error here, rather
 * than a field three call sites silently stop selecting. Rule 9 is about a
 * select-blind FAKE; this is the other half of the same hazard — a hand-copied
 * projection inside a real query — and it is the one that actually shipped.
 */
export const SESSION_ROW_SELECT = {
  id: true,
  storageState: true,
  storageStateExpiresAt: true,
  storageStateSealed: true,
  storageStateKeyVersion: true,
  storageStateNeedsReseal: true,
} as const satisfies Record<keyof SealedSessionRow, true>;

// ─── The eight states of a stored session ────────────────────────────────────

/**
 * WHAT A STORED SESSION IS, EXACTLY. Eight members, and each one is a different
 * answer to "may this run proceed as this identity".
 *
 * The three lines this replaces collapsed all eight into two — "truthy and not
 * expired" or "nothing" — which is how four distinct, actionable situations
 * (never signed in · expired · marked for re-seal by the migration · plaintext
 * written by an old image) became one `null` that read as "run it anonymously".
 *
 *   SEALED_FRESH       sealed, versioned, and valid for longer than the refresh
 *                      lead. The normal case. USE IT.
 *   SEALED_EXPIRING    sealed and valid, inside {@link SESSION_REFRESH_LEAD_MS}
 *                      of expiry. STILL USABLE and refresh is due — refusing a
 *                      session with fifty minutes left would turn a refresh
 *                      outage into a run outage.
 *   SEALED_EXPIRED     sealed and past its expiry. NOT usable.
 *   SEALED_NO_EXPIRY   sealed with a NULL expiry. Not usable, and this is the
 *                      member that exists because the old readers spelt
 *                      `!expiresAt || expiresAt > now` — reading a missing
 *                      expiry as "valid forever", which is the opposite of what
 *                      an absent expiry can honestly mean.
 *   SEALED_UNVERSIONED sealed with a NULL `storageStateKeyVersion`. The
 *                      envelope carries the version, so this COULD be opened —
 *                      and is not, because the indexed column is how a rotation
 *                      sweep finds rows, and a row with a null version is a row
 *                      the sweep skips and a compromised key keeps opening.
 *   NEEDS_RESEAL       `storageStateNeedsReseal` is true: either the sealing
 *                      migration destroyed plaintext here, or a rotation sweep
 *                      could not open it. The explicit, queryable form of
 *                      "there is no usable session here".
 *   LEGACY_PLAINTEXT   the legacy column is NOT NULL. The migration nulled every
 *                      one of them, so a non-null value means a writer from
 *                      before this slice has run since — and the plaintext is
 *                      the NEWER write. It is refused rather than used, and the
 *                      refresh that follows nulls it (see
 *                      {@link SealedSessionWrite}). Highest precedence for that
 *                      reason: it is the one state with a live secret in the
 *                      clear in the database.
 *   ABSENT             nothing at all. Never signed in.
 */
export const SESSION_STATES = [
  'SEALED_FRESH',
  'SEALED_EXPIRING',
  'SEALED_EXPIRED',
  'SEALED_NO_EXPIRY',
  'SEALED_UNVERSIONED',
  'NEEDS_RESEAL',
  'LEGACY_PLAINTEXT',
  'ABSENT',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** What one state means for a run, and whose problem it is. */
export interface SessionStateRule {
  /** May a run carry this session? True for exactly two of the eight. */
  readonly usable: boolean;
  /** Should a refresh be attempted? True for seven of the eight. */
  readonly refreshDue: boolean;
  /**
   * WHOSE PROBLEM THIS IS, and not a synonym for `usable`.
   *
   * OURS      something we wrote, failed to migrate or failed to refresh.
   * LIFECYCLE nothing is broken; there is simply no current session. An
   *           eight-hour TTL expiring is the TTL working.
   *
   * There is deliberately no THEIRS member: every state here is a fact about
   * OUR store. "The customer's login stopped working" is a fact about a refresh
   * ATTEMPT, it arrives from `LoginResult.failure.fault`, and it belongs to
   * apps/worker/src/processors/auth-refresh.ts.
   */
  readonly fault: 'OURS' | 'LIFECYCLE';
  /** One sentence for an operator. Names no secret, by construction and by test. */
  readonly why: string;
}

/**
 * The compiler-enforced presence record. A `Record<SessionState, …>` cannot be
 * written without naming every member, so a ninth state is a type error here
 * rather than a state with no rule — and `undefined.usable` read as falsy would
 * make every session unusable, while a `?? true` anywhere near it would make an
 * unknown state USABLE, which is the exception-handler-falls-through-to-allow
 * pattern this round is hunting.
 *
 * Both halves, because one without the other passes while the two disagree:
 * this is the compile-time half, and `session-store.test.ts` asserts the
 * run-time parity of {@link SESSION_STATES} against this object's own keys.
 */
export const SESSION_STATE_RULES = {
  SEALED_FRESH: {
    usable: true,
    refreshDue: false,
    fault: 'LIFECYCLE',
    why: 'The sealed session is valid and is not due for refresh.',
  },
  SEALED_EXPIRING: {
    usable: true,
    refreshDue: true,
    fault: 'LIFECYCLE',
    why:
      'The sealed session is still valid but expires within the refresh lead, so it is used now ' +
      'and refreshed before the next run needs it.',
  },
  SEALED_EXPIRED: {
    usable: false,
    refreshDue: true,
    fault: 'LIFECYCLE',
    why: 'The sealed session is past its expiry, so it cannot be carried into a run.',
  },
  SEALED_NO_EXPIRY: {
    usable: false,
    refreshDue: true,
    fault: 'OURS',
    why:
      'The sealed session has no recorded expiry, so nothing can say whether it is still valid. ' +
      'A missing expiry is not an unlimited one.',
  },
  SEALED_UNVERSIONED: {
    usable: false,
    refreshDue: true,
    fault: 'OURS',
    why:
      'The sealed session has no key version on the row, so a key rotation would skip it. It is ' +
      're-sealed before it is used again.',
  },
  NEEDS_RESEAL: {
    usable: false,
    refreshDue: true,
    fault: 'OURS',
    why:
      'This profile is marked as needing a new session: either the sealing migration destroyed ' +
      'the plaintext it held, or a rotation sweep could not open it.',
  },
  LEGACY_PLAINTEXT: {
    usable: false,
    refreshDue: true,
    fault: 'OURS',
    why:
      'This profile holds a session in the legacy plaintext column, which means a writer from ' +
      'before the sealing migration has run since. It is refused rather than used, and the ' +
      'refresh that replaces it clears that column.',
  },
  ABSENT: {
    usable: false,
    refreshDue: true,
    fault: 'LIFECYCLE',
    why: 'This profile has no stored session. Nothing has signed in as this identity yet.',
  },
} as const satisfies Record<SessionState, SessionStateRule>;

// ─── The gate ────────────────────────────────────────────────────────────────

/**
 * WHAT A RUN MAY DO WITH THIS PROFILE, UNDER THIS MODE.
 *
 * ── The three outcomes, and why they are three fields ──────────────────────
 *
 * Exactly one of `usable`, `notRun !== null` and `anonymousPermitted` is the
 * operative answer, always, and `session-store.test.ts` asserts that across
 * every state × every mode. One tri-state field would have been smaller and
 * would have lost the fact a caller most needs: a run that is PERMITTED to go
 * anonymous (OBSERVE) still has to be COUNTED as a degradation, and a field
 * that merely said "ANONYMOUS" would be read as "fine".
 */
export interface SessionGate {
  readonly state: SessionState;
  readonly mode: ControlMode;
  /** The caller may open the session and carry it. */
  readonly usable: boolean;
  /** A refresh should be attempted for this profile. Independent of `usable`. */
  readonly refreshDue: boolean;
  /**
   * THE TYPED NOT_RUN. Non-null exactly when the session is unusable AND the
   * mode is ENFORCE.
   *
   * `BLOCKED_BY_ENV` for every unusable state, and the enum's own documentation
   * is why: it is the kind for "the configured login no longer works". It is
   * also the kind the NOT_RUN_KINDS guidance says must be EXCLUDED from a pass
   * rate and from a coverage denominator — which is the half of this defect
   * that is about the product's core number rather than about security. An
   * anonymous run must not be able to credit an auth-gated route.
   */
  readonly notRun: { readonly kind: NotRunKind; readonly why: string } | null;
  /**
   * OBSERVE ONLY. True exactly when the session is unusable and the brake is
   * still off, meaning the caller may do what it did before this control
   * existed — run anonymously — and MUST count it. See
   * {@link countSessionGate}; `SECURITY_CONTROL_BRAKES.SESSION_STATE_SEAL`
   * names this count as what OBSERVE owes.
   */
  readonly anonymousPermitted: boolean;
  /** Null exactly when `usable`. Otherwise the state's own attribution. */
  readonly fault: 'OURS' | 'LIFECYCLE' | null;
  /** For the operator, inside their tenant. Contains no part of any secret. */
  readonly detail: string;
}

/**
 * Classify one row. Pure, total, and the precedence is deliberate.
 *
 * LEGACY_PLAINTEXT is tested FIRST and ahead of a perfectly good sealed value,
 * because the two can only coexist if an un-migrated writer ran after the
 * migration — in which case the plaintext is the newer session and the sealed
 * one is stale. Refusing both and refreshing is the only answer that neither
 * reads the plaintext nor carries a session we know to be out of date.
 */
export function sessionStateOf(row: SealedSessionRow, now: Date): SessionState {
  if (row.storageState !== null && row.storageState !== undefined) return 'LEGACY_PLAINTEXT';
  if (row.storageStateNeedsReseal) return 'NEEDS_RESEAL';
  if (row.storageStateSealed === null || row.storageStateSealed.length === 0) return 'ABSENT';
  if (row.storageStateKeyVersion === null) return 'SEALED_UNVERSIONED';
  if (row.storageStateExpiresAt === null) return 'SEALED_NO_EXPIRY';
  const msLeft = row.storageStateExpiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return 'SEALED_EXPIRED';
  if (msLeft <= SESSION_REFRESH_LEAD_MS) return 'SEALED_EXPIRING';
  return 'SEALED_FRESH';
}

/**
 * THE GATE. The one function every consumer of a cached session calls.
 *
 * FAILS CLOSED: there is no arm that returns `usable: true` for a state whose
 * rule says otherwise, and no arm that catches anything. The only way an
 * unusable session becomes an anonymous run is `mode: 'OBSERVE'`, which is the
 * documented brake and which produces `anonymousPermitted` — a field whose
 * name makes the caller's obligation to count it hard to miss.
 */
export function sessionGate(
  row: SealedSessionRow,
  options: { readonly now: Date; readonly mode: ControlMode },
): SessionGate {
  const state = sessionStateOf(row, options.now);
  const rule = SESSION_STATE_RULES[state];
  const enforcing = controlEnforces(options.mode);

  if (rule.usable) {
    return {
      state,
      mode: options.mode,
      usable: true,
      refreshDue: rule.refreshDue,
      notRun: null,
      anonymousPermitted: false,
      fault: null,
      detail: rule.why,
    };
  }

  return {
    state,
    mode: options.mode,
    usable: false,
    refreshDue: rule.refreshDue,
    notRun: enforcing
      ? {
          kind: 'BLOCKED_BY_ENV',
          /*
           * The sentence a customer reads on the result row. It says what was
           * not done and what to do, and it names NO host, NO cookie, NO
           * profile secret and no part of the session — a NOT_RUN reason is
           * rendered in the cockpit, put in a JUnit file and posted to chat.
           */
          why:
            `${rule.why} The test was NOT RUN rather than run signed out: an anonymous run of a ` +
            'page behind a login passes most assertions and would report the route as covered.',
        }
      : null,
    anonymousPermitted: !enforcing,
    fault: rule.fault,
    detail: rule.why,
  };
}

// ─── The OBSERVE count ───────────────────────────────────────────────────────

/**
 * ONE BUCKET OF COUNTED DEGRADATIONS. Rule 13's other half: a mode that does
 * not count is an off switch with a reassuring name.
 *
 * Keyed on (profileId, state), which is exactly what
 * `SECURITY_CONTROL_BRAKES.SESSION_STATE_SEAL.observeCounts` promises — "every
 * run that would have been reported NOT_RUN and instead went anonymous, per
 * profile ... beside how many were considered". The profile id is a cuid and
 * not a secret; the state is a member of a closed list. Neither can carry a
 * cookie.
 *
 * WHAT IS COUNTED IS WHAT THE CONSUMER DID, not what the gate said: the two
 * disagree by design on three paths, and deriving one from the other reported
 * runs that ran signed in as refused. See {@link SessionGateOutcome}.
 */
/**
 * WHAT THE CONSUMER ACTUALLY DID WITH THE GATE'S ANSWER.
 *
 * ── WHY THIS IS TOLD TO THE COUNTER AND NOT DERIVED FROM THE GATE ──────────
 *
 * It was derived, and MEASURED on this tree the derivation was wrong for three
 * of the four production call paths. The gate answers about the ROW; what
 * happened to the RUN is the consumer's decision, and three consumers overrule
 * the gate on purpose:
 *
 *   LEGACY_PLAINTEXT  `openCachedSession` CARRIES it in both modes (it is the
 *                     newest session the customer has and it works today), while
 *                     the gate reports `notRun: BLOCKED_BY_ENV` under ENFORCE.
 *                     EXECUTED: a carried legacy session tallied
 *                     `{degraded:0, blocked:1, used:0}` — reported as refused,
 *                     having run signed in as the identity.
 *   ABSENT            apps/worker/src/processors/run.ts deliberately does NOT
 *                     refuse it ("not stale, they are new"), and ran anonymous
 *                     while the gate's `notRun` tallied it as blocked.
 *   no cached session the PER-PROFILE paths in run.ts and explore.ts drive a
 *                     LOGIN rather than refuse, so the cache missing is not a
 *                     degradation at all and must not be counted as one.
 *
 * An operator reads these numbers to decide whether to arm the brake. "412
 * blocked" meaning "412 runs will break" when those 412 are exactly the runs
 * that keep working either way is a measured number that was not measured —
 * and it is the number the brake's own `observeCounts` promises.
 *
 *   USED       the cached session was carried. The run ran as the identity.
 *   ANONYMOUS  no session was carried and the run went ahead signed out.
 *   REFUSED    no session was carried and the run was reported NOT_RUN.
 *   SIGNED_IN  no cached session, so a fresh login was driven for this profile.
 *              NOT a degradation: nothing was taken away and nothing was
 *              claimed. Counted because a denominator that silently drops the
 *              commonest outcome is not a denominator.
 *   WOULD_SEAL the REFRESH SWEEP's own member, and not a run outcome at all.
 *              It means "this tick left the profile in a state that arming the
 *              brake would change" — the worklist
 *              `SECURITY_CONTROL_BRAKES.SESSION_STATE_SEAL.observeCounts`
 *              promises an operator before they enforce. It has its own member
 *              because the sweep and a run measure DIFFERENT THINGS through
 *              this one counter, and folding the sweep's worklist into
 *              `degraded` made one number mean "runs that went anonymous" in
 *              one caller and "profiles a seal would replace" in another.
 */
export const SESSION_GATE_OUTCOMES = [
  'USED',
  'ANONYMOUS',
  'REFUSED',
  'SIGNED_IN',
  'WOULD_SEAL',
] as const;
export type SessionGateOutcome = (typeof SESSION_GATE_OUTCOMES)[number];

export interface SessionDegradationTally {
  readonly profileId: string;
  readonly state: SessionState;
  /** Runs that went anonymous without a session. `ANONYMOUS`. */
  readonly degraded: number;
  /** Runs that were reported NOT_RUN. `REFUSED`. */
  readonly blocked: number;
  /** Runs that carried the cached session. `USED`. */
  readonly used: number;
  /**
   * Runs for which a fresh login was driven instead. `SIGNED_IN`.
   *
   * Its own bucket rather than folded into `used`: "the cache worked" and "the
   * cache missed and we signed in" are the two facts that say whether the
   * refresh sweep is keeping up, and one number cannot carry both.
   */
  readonly signedIn: number;
  /** Profiles the sweep left in a state arming the brake would change. `WOULD_SEAL`. */
  readonly wouldSeal: number;
}

/** The identity of a tally bucket. One definition, so two writers cannot disagree. */
export function sessionTallyKey(profileId: string, state: SessionState): string {
  return `${profileId}\u001f${state}`;
}

/**
 * Add one gate decision to a tally map.
 *
 * EVERY decision, not only the degradations. "We would have reported 412 runs
 * NOT_RUN" is only interesting beside how many runs there were, and a count
 * with no denominator is the kind of number that gets quoted at a customer and
 * cannot be defended.
 */
export function countSessionGate(
  into: Map<string, SessionDegradationTally>,
  profileId: string,
  gate: SessionGate,
  /**
   * REQUIRED, so a call site cannot forget it and fall back to the gate's own
   * verdict — which is the derivation that was wrong. See
   * {@link SessionGateOutcome}.
   */
  outcome: SessionGateOutcome,
): Map<string, SessionDegradationTally> {
  const key = sessionTallyKey(profileId, gate.state);
  const existing = into.get(key);
  into.set(key, {
    profileId,
    state: gate.state,
    degraded: (existing?.degraded ?? 0) + (outcome === 'ANONYMOUS' ? 1 : 0),
    blocked: (existing?.blocked ?? 0) + (outcome === 'REFUSED' ? 1 : 0),
    used: (existing?.used ?? 0) + (outcome === 'USED' ? 1 : 0),
    signedIn: (existing?.signedIn ?? 0) + (outcome === 'SIGNED_IN' ? 1 : 0),
    wouldSeal: (existing?.wouldSeal ?? 0) + (outcome === 'WOULD_SEAL' ? 1 : 0),
  });
  return into;
}

/** How many runs the brake let go anonymous, out of how many there were. */
export function sessionDegradation(tallies: Iterable<SessionDegradationTally>): {
  readonly degraded: number;
  readonly blocked: number;
  readonly used: number;
  readonly signedIn: number;
  readonly wouldSeal: number;
  readonly total: number;
} {
  let degraded = 0;
  let blocked = 0;
  let used = 0;
  let signedIn = 0;
  let wouldSeal = 0;
  for (const tally of tallies) {
    degraded += tally.degraded;
    blocked += tally.blocked;
    used += tally.used;
    signedIn += tally.signedIn;
    wouldSeal += tally.wouldSeal;
  }
  /*
   * `signedIn` IS IN THE DENOMINATOR. Every decision this counter is told about
   * lands in exactly one bucket, so the total is the number of cached-session
   * decisions made — which is what makes "we would have refused N of M" a
   * sentence that can be defended. Leaving it out would shrink M by the
   * commonest outcome and inflate every ratio read off it.
   */
  return {
    degraded,
    blocked,
    used,
    signedIn,
    wouldSeal,
    total: degraded + blocked + used + signedIn + wouldSeal,
  };
}

// ─── The keys ────────────────────────────────────────────────────────────────

/**
 * The `VaultKey` rows, as this module needs them. One definition of the select,
 * for the reason {@link SESSION_ROW_SELECT} gives.
 */
export const VAULT_KEY_SELECT = {
  keyId: true,
  version: true,
  state: true,
} as const satisfies Record<keyof VaultKeyRef, true>;

/** The narrowest database surface this module needs. Injected, so a test needs no Postgres. */
export interface VaultKeyReader {
  readonly vaultKey: {
    findMany: (args: {
      select: typeof VAULT_KEY_SELECT;
      orderBy: { version: 'asc' };
    }) => Promise<ReadonlyArray<Record<string, unknown>>>;
  };
}

/**
 * The keys this deployment can name, and the versions it cannot.
 *
 * TWO FACTS, TWO FIELDS. A row whose `state` is not a member of
 * {@link VAULT_KEY_STATES} is EXCLUDED from `keys` — a key whose permissions
 * cannot be read must not seal or open anything — and its version is reported
 * in `unreadableVersions` so that "we did not check" is never silent. Dropping
 * it quietly would make {@link openSession} answer `UNKNOWN_KEY_VERSION` for a
 * row that plainly exists, which is a true refusal with a misleading cause.
 *
 * The same exclusion is what a select-blind read produces: a `findMany` that
 * forgot `state: true` yields `undefined` here, every row lands in
 * `unreadableVersions`, and sealing refuses with NO_WRITABLE_KEY rather than
 * treating an unknown state as permissive.
 */
export function vaultKeysFrom(rows: ReadonlyArray<Record<string, unknown>>): {
  readonly keys: readonly VaultKeyRef[];
  readonly unreadableVersions: readonly number[];
} {
  const keys: VaultKeyRef[] = [];
  const unreadableVersions: number[] = [];
  for (const row of rows) {
    const version = row.version;
    const keyId = row.keyId;
    const state = row.state;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) continue;
    if (
      typeof keyId !== 'string' ||
      keyId.length === 0 ||
      typeof state !== 'string' ||
      !(VAULT_KEY_STATES as readonly string[]).includes(state)
    ) {
      unreadableVersions.push(version);
      continue;
    }
    keys.push({ keyId, version, state: state as VaultKeyState });
  }
  return { keys, unreadableVersions };
}

/**
 * Read the key table.
 *
 * This is the production read that connects `model VaultKey` to something —
 * `check-wiring` reported it as DISCONNECTED ("a schema entry for a feature
 * that does not exist") at the start of this slice, and a table nothing reads
 * is a table whose states are a claim.
 */
export async function readVaultKeys(db: VaultKeyReader): Promise<{
  readonly keys: readonly VaultKeyRef[];
  readonly unreadableVersions: readonly number[];
}> {
  const rows = await db.vaultKey.findMany({
    select: VAULT_KEY_SELECT,
    orderBy: { version: 'asc' },
  });
  return vaultKeysFrom(rows);
}

// ─── Sealing ─────────────────────────────────────────────────────────────────

/**
 * THE COLUMNS A CALLER WRITES, ALL OF THEM, AS ONE OBJECT.
 *
 * ── Why the legacy column is in here, set to null, on every single write ───
 *
 * Because that is what makes "WRITE NOTHING HERE EVER AGAIN" a property of the
 * code rather than a sentence in the schema. A caller that spreads this object
 * into `data` cannot write a sealed session and leave a plaintext one beside
 * it, and a profile in the `LEGACY_PLAINTEXT` state is CLEANED by the next
 * successful refresh instead of needing a second sweep to find it.
 *
 * `storageStateExpiresAt` is in here for the paired reason the schema records:
 * nulling the state and leaving the expiry made
 * `expiresAt !== null && > now` report a valid session for a profile that has
 * none, so the two columns move together, always.
 */
export interface SealedSessionWrite {
  readonly storageStateSealed: string;
  readonly storageStateKeyVersion: number;
  readonly storageStateSealedAt: Date;
  readonly storageStateExpiresAt: Date;
  /** Always false: a value sealed under the ACTIVE key needs no re-seal. */
  readonly storageStateNeedsReseal: false;
  /** ALWAYS NULL. See this type's own comment. */
  readonly storageState: null;
}

/** A refusal this module raises about the ROW, as opposed to about the envelope. */
export const SESSION_REFUSALS = [
  /** The row's key-version column disagrees with the envelope it holds. */
  'VERSION_COLUMN_DISAGREES',
  /** There is no sealed value on the row at all. The gate should have caught this. */
  'NOT_SEALED',
  /** The value decrypted, and what came out is not a JSON session. */
  'NOT_A_SESSION',
  /** The caller asked to seal something that is not serialisable as a session. */
  'NOT_SERIALISABLE',
] as const;
export type SessionRefusal = (typeof SESSION_REFUSALS)[number];

/**
 * The result of a seal or an open.
 *
 * The refusal is a member of EITHER closed list — the keystone's
 * {@link SealRefusal} for everything about the envelope and the keys, and
 * {@link SessionRefusal} for the four facts that are about this row. Two lists
 * rather than abusing a near-miss member: `MALFORMED_ENVELOPE` for a row whose
 * version column drifted would be a true refusal with a false cause, and in a
 * security file the cause is what the next reviewer acts on.
 */
export type SessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly refusal: SealRefusal | SessionRefusal;
      /** Operator-facing. Contains no part of the plaintext, the payload or a key. */
      readonly detail: string;
    };

function refuse(refusal: SealRefusal | SessionRefusal, detail: string): SessionResult<never> {
  return { ok: false, refusal, detail };
}

/**
 * Seal one session for one profile.
 *
 * The AAD binds the model, THIS ROW'S id and the field, through the keystone's
 * {@link aadFor} — so a ciphertext lifted from one AuthProfile and pasted onto
 * another fails to open rather than opening as somebody else's session. That
 * binding is the reason `profileId` is a required argument and not derived from
 * anything the caller might get wrong.
 *
 * REFUSES rather than falling back when no key is ACTIVE or when two are. There
 * is no "seal it under a READABLE key just this once": that is how a rotation
 * ends with values under a key that is about to be retired.
 */
export async function sealSession(input: {
  readonly profileId: string;
  /** The Playwright storageState, as the login produced it. */
  readonly storageState: unknown;
  readonly expiresAt: Date;
  readonly keys: readonly VaultKeyRef[];
  readonly cipher: SessionCipher;
  readonly now: Date;
}): Promise<SessionResult<SealedSessionWrite>> {
  if (input.storageState === null || input.storageState === undefined) {
    return refuse(
      'NOT_SERIALISABLE',
      'There is nothing to seal: the login produced no session. A profile kind that ' +
        'authenticates with a request header has no browser session to cache.',
    );
  }

  let plaintext: string;
  try {
    plaintext = JSON.stringify(input.storageState);
  } catch {
    /*
     * A circular or unserialisable value. The error from JSON.stringify can
     * quote a key path out of the session, so it is DISCARDED rather than
     * attached — an error about a secret must be reportable without quoting any
     * part of it.
     */
    return refuse('NOT_SERIALISABLE', 'The captured session could not be serialised as JSON.');
  }
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    return refuse('NOT_SERIALISABLE', 'The captured session serialised to nothing.');
  }

  const sealing = selectSealingKey(input.keys);
  if (!sealing.ok) return refuse(sealing.refusal, sealing.detail);

  let payload: string;
  try {
    payload = await input.cipher.encrypt({
      plaintext,
      keyVersion: sealing.value.version,
      aad: aadFor({ fieldKey: SESSION_FIELD_KEY, rowId: input.profileId }),
    });
  } catch (err) {
    /*
     * The only expected failure is "this process holds no material for that
     * version". Anything else is a cipher fault, and either way the error is
     * NOT attached: a cipher error can carry buffer contents, and nothing from
     * a failed encryption may reach a log line.
     */
    return refuse(
      'UNKNOWN_KEY_VERSION',
      err instanceof NoKeyMaterialError
        ? `Vault key version ${err.keyVersion} is ACTIVE in the key table and this process holds ` +
            'no material for it, so nothing was sealed.'
        : `The session could not be sealed under key version ${sealing.value.version}.`,
    );
  }

  return {
    ok: true,
    value: {
      storageStateSealed: serialiseEnvelope({
        keyId: sealing.value.keyId,
        keyVersion: sealing.value.version,
        alg: SEAL_WRITE_ALGORITHM,
        payload,
      }),
      storageStateKeyVersion: sealing.value.version,
      storageStateSealedAt: input.now,
      storageStateExpiresAt: input.expiresAt,
      storageStateNeedsReseal: false,
      storageState: null,
    },
  };
}

// ─── Opening ─────────────────────────────────────────────────────────────────

/**
 * Open one profile's sealed session.
 *
 * ── What comes back, and what does not ────────────────────────────────────
 *
 * An {@link OpenedSecret}, never a string. The plaintext is held outside the
 * object, so this function's return value cannot be logged, serialised,
 * interpolated or spread into anything — and the two ways to get the plaintext
 * out are named functions, which keeps "where does this session go" a grep for
 * two names. {@link useSessionState} is the one to use.
 *
 * ── Fails closed at every step ────────────────────────────────────────────
 *
 * An unparseable envelope, a key version this deployment cannot name, a
 * COMPROMISED key, a drifted version column, a tag failure and a plaintext that
 * is not a session are ALL refusals. There is no arm that returns a partially
 * understood session and no arm that treats a failure as "no session", because
 * "treat it as absent" is precisely how an unreadable session became an
 * anonymous run.
 */
export async function openSession(input: {
  readonly row: SealedSessionRow;
  readonly keys: readonly VaultKeyRef[];
  readonly cipher: SessionCipher;
}): Promise<SessionResult<OpenedSecret>> {
  const { row } = input;
  if (row.storageStateSealed === null || row.storageStateSealed.length === 0) {
    return refuse(
      'NOT_SEALED',
      'This profile holds no sealed session. Nothing was opened and nothing was attempted.',
    );
  }

  const envelope = parseEnvelope(row.storageStateSealed);
  if (!envelope.ok) return refuse(envelope.refusal, envelope.detail);

  if (!envelopeMatchesVersionColumn(envelope.value, row.storageStateKeyVersion)) {
    /*
     * The integer column is a denormalisation of the envelope, and the
     * direction of a drift matters: a row whose column says 2 while its
     * envelope says 1 is a row a rotation sweep SKIPS and a compromised key
     * goes on opening. So a mismatch is a refusal rather than a preference for
     * one of the two numbers.
     */
    return refuse(
      'VERSION_COLUMN_DISAGREES',
      `The row records key version ${row.storageStateKeyVersion ?? 'none'} and the sealed value ` +
        `was written under version ${envelope.value.keyVersion}. A rotation sweep reads the ` +
        'column, so the two must agree before this session is used again.',
    );
  }

  const key = selectOpeningKey(envelope.value, input.keys);
  if (!key.ok) return refuse(key.refusal, key.detail);

  const aad = aadFor({ fieldKey: SESSION_FIELD_KEY, rowId: row.id });
  let plaintext: string;
  try {
    plaintext = await input.cipher.decrypt({
      payload: envelope.value.payload,
      keyVersion: envelope.value.keyVersion,
      aad,
    });
  } catch (err) {
    /*
     * DELIBERATELY ONE ANSWER FOR THREE CAUSES — wrong key, tampered
     * ciphertext, and an AAD that belongs to another row. Separating them
     * would be an oracle: "that ciphertext is valid, just not for this
     * profile" tells an attacker who has read the column that they have a
     * usable session and only need the right row id. The error object itself
     * is NOT attached, for the reason the seal path gives.
     */
    if (err instanceof NoKeyMaterialError) {
      return refuse(
        'UNKNOWN_KEY_VERSION',
        `The sealed session names key version ${err.keyVersion}, which this process holds no ` +
          'material for. Nothing was attempted against another key.',
      );
    }
    return refuse(
      'AAD_MISMATCH',
      'The sealed session did not open: the key, the ciphertext and the row it is bound to do ' +
        'not agree. Which of the three is wrong is deliberately not reported.',
    );
  }

  const opened = new OpenedSecret(plaintext, { fieldKey: SESSION_FIELD_KEY, rowId: row.id });

  /*
   * VERIFIED HERE SO THAT AN OpenedSecret IS ALWAYS A SESSION.
   *
   * The parse result is discarded and the parse is done again in
   * `useSessionState` for the consumer. That is a deliberate second parse: the
   * alternative is returning the parsed object, which would put a live session
   * back into an ordinary value that anything can log — exactly what
   * `OpenedSecret` exists to prevent. One extra JSON.parse per login is not a
   * cost worth a plaintext escaping the type.
   */
  const shaped = useSecret(opened, (value) => {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  });
  if (!shaped) {
    return refuse(
      'NOT_A_SESSION',
      `The sealed value opened and what came out is not a JSON session object (${opened.bytes} ` +
        'bytes). The bytes themselves are not reported.',
    );
  }

  return { ok: true, value: opened };
}

/**
 * Use the session inside a callback, and let it go.
 *
 * THE ONE TO USE. The parsed session never becomes a variable in the caller's
 * scope, so it cannot be captured by a closure that outlives the call, attached
 * to an error, or still be in a local when something later serialises the
 * frame. The callback's RETURN VALUE is the caller's, so a callback that
 * returns the session itself defeats this — and that is a reviewable line
 * rather than an invisible one, which is the most a type can do here.
 *
 * It does not catch: an exception from `fn` propagates unchanged, because
 * swallowing it would make a failure inside a session-using block look like a
 * failure to obtain the session.
 */
export function useSessionState<T>(opened: OpenedSecret, fn: (storageState: unknown) => T): T {
  return useSecret(opened, (plaintext) => fn(JSON.parse(plaintext) as unknown));
}
