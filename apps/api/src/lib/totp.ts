/**
 * RFC 6238 TOTP, and the recovery codes beside it.
 *
 * ── THE DEFECT THIS FILE EXISTS TO CLOSE ────────────────────────────────────
 *
 * `apps/api/src/routes/auth.ts` read
 *
 *     if (user.totpEnabledAt && !input.totpCode) throw unauthorized(…)
 *
 * and then NEVER LOOKED AT THE CODE AGAIN. Presence was checked; the value was
 * not. Any six digits signed in. That is worse than having no second factor at
 * all, because it is the one the customer believes in — and it is why
 * `LoginAttemptOutcome.BAD_TOTP` has never once been reachable and the count of
 * it has always been zero for the most flattering possible reason.
 *
 * ── WHY THIS MODULE HAS NO DATABASE, NO CLOCK AND NO RANDOMNESS ─────────────
 *
 * Every one of those is an argument. A control nobody can test with a fake is a
 * control nobody will trust, and a TOTP implementation is exactly the kind of
 * thing whose off-by-one-step bug only shows up in the half-minute either side
 * of midnight. So `nowMs` is a number the caller passes, the entropy source is
 * a function the caller passes, and the replay memory is an interface the
 * caller passes. The route (`routes/auth.ts`) holds the real three; the tests
 * hold fakes; neither this file nor its tests ever open a socket, read a clock
 * or touch Postgres.
 *
 * ── WHAT IS NOT IN HERE, AND WHY ────────────────────────────────────────────
 *
 * SEALING. The seed is sealed with `lib/vault.ts` AT THE ROUTE, not here,
 * because the moment this module could read a key it would also be the module
 * that could log one. Here a seed is a base32 string the caller already holds,
 * and the only thing this file does with it is compute codes.
 *
 * ── RULE 11, WRITTEN AS CODE RATHER THAN AS A PROMISE ───────────────────────
 *
 * No function in this file puts a seed, a code, a recovery code or an
 * `otpauth://` payload into a return value that is not the thing itself, into
 * an Error message, or into a refusal. Refusals are MEMBERS OF A CLOSED LIST
 * (`TOTP_REFUSALS`) with a fixed sentence each, so "report the failure" cannot
 * accidentally become "quote the credential". `totp.test.ts` proves it by
 * walking every refusal and asserting the offending value appears in neither
 * the refusal nor its detail.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The step, the digit count and the window. All three fixed, none configurable.
 *
 * ±1 STEP AND NO MORE. A wider window is the cheap answer to "my phone's clock
 * is off", and it is also a linear multiplication of the number of codes an
 * attacker's guess can match: at ±1 three codes are live at any instant, at ±5
 * it is eleven. Google Authenticator, 1Password and Authy all keep real clocks;
 * a user whose device is more than thirty seconds out has a device problem, and
 * the honest fix is to say so rather than to widen the door for everybody.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW_STEPS = 1;

/**
 * HMAC-SHA1, which is not a mistake and not legacy debt.
 *
 * RFC 6238's default, and the only algorithm every authenticator app reads from
 * an `otpauth://` URI without an explicit `algorithm=` parameter. SHA-256 is
 * available in the URI spec and is NOT universally supported; shipping it would
 * mean a share of customers whose app silently computes different codes from
 * ours, which presents to them as "2FA is broken" and to us as an unverifiable
 * support ticket. HMAC-SHA1 in HOTP is not a collision problem — the digest is
 * truncated to six digits of a keyed MAC, and SHA-1's weaknesses are
 * collisions, not MAC forgery.
 */
const TOTP_HMAC = 'sha1';

/** 20 bytes, per RFC 4226 §4: the recommended shared-secret length. */
export const TOTP_SECRET_BYTES = 20;

/**
 * HOW MANY RECOVERY CODES, AND HOW LONG EACH ONE IS.
 *
 * Ten 10-character base32 codes: ~50 bits each, which is why they are stored
 * under a plain digest and not stretched (see {@link hashRecoveryCode}).
 * `totpEnrolmentSchema.recoveryCodeCount` bounds the request at 8–16; this is
 * the default it applies.
 */
export const RECOVERY_CODE_CHARS = 10;

/**
 * Base32, RFC 4648, UPPER CASE AND UNPADDED.
 *
 * Unpadded because an `otpauth://` secret parameter with `=` in it is a URI
 * escaping problem in some authenticators, and upper case because the base32
 * alphabet has no lower case and a mixed-case secret is a secret some apps
 * reject. `I`, `L`, `O` and `1`/`0` ARE in the alphabet, which is why the
 * recovery-code alphabet below is a different, narrower one.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * The recovery-code alphabet: Crockford-ish, with the confusable characters
 * removed.
 *
 * A recovery code is read off a printout by a person who is already locked out
 * and already annoyed, and `l` / `1` / `I` / `O` / `0` is how that goes wrong.
 * 32 characters minus five is 27, which is not a power of two — so
 * {@link mintRecoveryCodes} rejects biased bytes rather than taking a modulus,
 * because a modulus over 27 makes the first five characters measurably more
 * likely and a recovery code is a password.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Random bytes, injected. `node:crypto`'s `randomBytes` at the route. */
export type RandomBytes = (bytes: number) => Buffer;

// ─── Refusals ───────────────────────────────────────────────────────────────

/**
 * WHY A CODE WAS NOT ACCEPTED. A closed list, one fixed sentence each.
 *
 * ── NO ORACLE, AND NOT THE KIND YOU EXPECT ─────────────────────────────────
 *
 * The caller must not hand these straight to a user in a way that distinguishes
 * them, and the reason is NOT account enumeration — by the time a code is being
 * checked the caller has already presented a correct password, so they know the
 * account exists. The reason is REPLAY: telling an attacker
 * "CODE_ALREADY_USED" rather than "CODE_DID_NOT_VERIFY" tells them the code
 * they intercepted WAS the right one and that they are racing a window, which
 * is a fact worth having. So {@link TOTP_REFUSAL_SENTENCE} is one sentence for
 * every member, the member itself is for the operator's log, and
 * `routes/auth.ts` answers with the sentence.
 */
export const TOTP_REFUSALS = [
  /** No seed on the row, or a seed that would not decode. Enrolment is incomplete. */
  'NO_SECRET',
  /** `totpEnabledAt` set and `totpConfirmedAt` null: a factor nobody has proved. */
  'NOT_CONFIRMED',
  /** Not six digits. Refused before any HMAC, so a long input costs nothing. */
  'MALFORMED_CODE',
  /** Six digits that match no code in the window. */
  'CODE_DID_NOT_VERIFY',
  /** The right code for a step that has already been spent. See the replay store. */
  'CODE_ALREADY_USED',
] as const;
export type TotpRefusal = (typeof TOTP_REFUSALS)[number];

/**
 * THE ONE SENTENCE EVERY REFUSAL SHOWS A CALLER.
 *
 * Identical for all five, deliberately, for the reason in `TOTP_REFUSALS`. The
 * member and the step live in the verdict, which is operator-facing and goes to
 * a `LoginAttempt` row, never to the response body.
 */
export const TOTP_REFUSAL_SENTENCE = 'That two-factor code is not valid.';

/**
 * ONE CODE CHECK, AS A VERDICT.
 *
 * `step` on the accepted branch is not decoration: it is what the caller spends
 * in the replay store, and a verdict that said only "yes" would make replay
 * refusal impossible to implement correctly — the caller would have to
 * re-derive which step matched, which is the same computation done twice and
 * two chances to disagree.
 */
export type TotpVerdict =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false; readonly refusal: TotpRefusal };

// ─── base32 ─────────────────────────────────────────────────────────────────

/** Bytes to unpadded upper-case base32. */
export function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Base32 to bytes, or null for anything that is not base32.
 *
 * NULL AND NOT A THROW, and not a best-effort decode either: a seed that will
 * not decode is a row that cannot produce a code, and the caller's answer to
 * that is `NO_SECRET` — a refusal — rather than an exception whose message
 * would be built from the offending string.
 *
 * Padding and spaces are tolerated on the way IN because users paste seeds from
 * authenticator exports; the output of {@link toBase32} never contains either.
 */
export function fromBase32(input: string): Buffer | null {
  const cleaned = input.replace(/[\s=]/g, '').toUpperCase();
  if (cleaned.length === 0) return null;

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ─── The algorithm ──────────────────────────────────────────────────────────

/** The step number a given instant falls in. Exported because the replay store keys on it. */
export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * RFC 4226 HOTP: the truncated, keyed digest of a counter.
 *
 * Not exported. The only caller is {@link totpCodeAt}, and a second caller
 * would be a second place that decides how many digits a code has.
 */
function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  // Written as a BigInt so the high word is not silently dropped: a step number
  // fits in 32 bits until the year 6053, and `writeUInt32BE(0)` for the high
  // half is the kind of thing that is correct for forty years and then is not.
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(TOTP_HMAC, key).update(message).digest();
  // Dynamic truncation, RFC 4226 §5.4. The low nibble of the last byte picks
  // the offset; the top bit of the selected word is masked off so the result is
  // positive on every platform's signed arithmetic.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** The code for one step. Exported so a test can assert a verdict against a real code. */
export function totpCodeAt(secretBase32: string, step: number): string | null {
  const key = fromBase32(secretBase32);
  if (key === null || key.length === 0) return null;
  return hotp(key, step);
}

/**
 * CONSTANT-TIME CODE COMPARISON.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — which is not a leak, because both sides are known to be exactly
 * {@link TOTP_DIGITS} characters by the time this runs (a malformed input is
 * refused before any HMAC is computed). A `===` here would leak the position of
 * the first wrong digit, which over a few thousand attempts is a measurable
 * reduction of a six-digit space.
 */
function codesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * WHICH STEPS HAVE ALREADY BEEN SPENT.
 *
 * ── WHY REPLAY REFUSAL IS NOT OPTIONAL ─────────────────────────────────────
 *
 * Without it, a code observed over the shoulder, read off a shared screen, or
 * phished into a proxy is REUSABLE for the rest of its window — up to ninety
 * seconds at ±1 step. A second factor that can be used twice is a second factor
 * an attacker only has to see once.
 *
 * ── WHY IT IS AN INTERFACE AND NOT A TABLE ─────────────────────────────────
 *
 * Because this round may not add a column (it does not own the schema), and
 * because the honest shape of the gap is visible this way. The default
 * implementation, {@link inProcessReplayStore}, is PER PROCESS: it refuses a
 * replay against the same API instance and does not survive a restart or reach
 * a second instance behind a load balancer. That is a real partial control and
 * it is named as one in `openProblems` rather than described as finished; the
 * durable backing (a `User.totpLastUsedStep` column, or Redis) is one
 * implementation of this interface away and needs no change to this file, the
 * route, or any test.
 */
export interface TotpReplayStore {
  /** True when `step` has already been accepted for `userId`. */
  wasUsed(userId: string, step: number): Promise<boolean>;
  /** Record `step` as spent. `ttlMs` is how long it must be remembered. */
  markUsed(userId: string, step: number, ttlMs: number): Promise<void>;
}

/**
 * The per-process replay store. Fails CLOSED in the one direction it can:
 * a step it remembers is refused, and it never forgets a step while that
 * step's window could still be presented.
 *
 * Pruned on write rather than on a timer, so an idle process holds nothing and
 * there is no interval to leak in a test. The entries are `${userId}:${step}`
 * and a step number — no secret, no code.
 */
export function inProcessReplayStore(now: () => number): TotpReplayStore {
  const spent = new Map<string, number>();
  return {
    async wasUsed(userId, step) {
      const until = spent.get(`${userId}:${step}`);
      return until !== undefined && until > now();
    },
    async markUsed(userId, step, ttlMs) {
      const at = now();
      for (const [key, until] of spent) if (until <= at) spent.delete(key);
      spent.set(`${userId}:${step}`, at + ttlMs);
    },
  };
}

/** How long a spent step must be remembered: the whole window, plus a step of slack. */
export const REPLAY_MEMORY_MS = (TOTP_WINDOW_STEPS * 2 + 2) * TOTP_STEP_SECONDS * 1000;

export interface VerifyTotpInput {
  /** The row's sealed-then-opened seed, base32. Never logged by this module. */
  readonly secretBase32: string | null;
  /** What the caller typed. Never logged by this module, not even truncated. */
  readonly code: string;
  readonly nowMs: number;
  /** `User.totpConfirmedAt`. Null means the factor was never proved — see below. */
  readonly confirmedAt: Date | null;
  readonly userId: string;
  readonly replay: TotpReplayStore;
}

/**
 * VERIFY ONE CODE. The function the login path was missing.
 *
 * Fails closed at every branch: no seed, an undecodable seed, an unconfirmed
 * enrolment, a malformed code, a code outside the window and a spent step are
 * all refusals, and there is no path through this function that returns `ok`
 * without a `timingSafeEqual` having matched.
 *
 * ── `confirmedAt` NULL IS A REFUSAL HERE AND AN ADMISSION AT THE ROUTE ─────
 *
 * This function refuses `NOT_CONFIRMED`, because a code cannot be checked
 * against a factor nobody has proved. The ROUTE reads the same pair differently
 * and must: `totpEnabledAt` set with `totpConfirmedAt` null means NOT ENROLLED,
 * so the route does not ask for a code at all and the user signs in with their
 * password. That is not a contradiction — it is the only reading that neither
 * locks out a user whose authenticator never saw the seed (because enrolment
 * never verified a code either) nor accepts an unverified second factor. The
 * refusal here exists for a caller that asks anyway.
 */
export async function verifyTotpCode(input: VerifyTotpInput): Promise<TotpVerdict> {
  if (input.confirmedAt === null) return { ok: false, refusal: 'NOT_CONFIRMED' };
  if (input.secretBase32 === null) return { ok: false, refusal: 'NO_SECRET' };

  // Shape first, so a 4KB "code" is rejected without computing three HMACs.
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(input.code)) {
    return { ok: false, refusal: 'MALFORMED_CODE' };
  }

  const key = fromBase32(input.secretBase32);
  if (key === null || key.length === 0) return { ok: false, refusal: 'NO_SECRET' };

  const current = stepAt(input.nowMs);
  let matched: number | null = null;
  /*
   * EVERY step in the window is checked even after a match, so the number of
   * HMACs computed does not depend on WHICH step matched. Returning early on
   * the first hit would make "the code was one step old" measurably slower than
   * "the code was current", which is a 1-in-3 narrowing of the window an
   * attacker is aiming at.
   */
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const step = current + offset;
    const candidate = hotp(key, step);
    if (codesEqual(candidate, input.code) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, refusal: 'CODE_DID_NOT_VERIFY' };

  if (await input.replay.wasUsed(input.userId, matched)) {
    return { ok: false, refusal: 'CODE_ALREADY_USED' };
  }
  await input.replay.markUsed(input.userId, matched, REPLAY_MEMORY_MS);

  return { ok: true, step: matched };
}

// ─── Enrolment ──────────────────────────────────────────────────────────────

/** A freshly minted seed. The caller seals it; nothing here stores it. */
export function generateTotpSecret(random: RandomBytes): string {
  return toBase32(random(TOTP_SECRET_BYTES));
}

/**
 * The `otpauth://` URI an authenticator reads from a QR code.
 *
 * ── THIS RETURN VALUE IS A CREDENTIAL ──────────────────────────────────────
 *
 * It CONTAINS THE SEED. It is as sensitive as the seed, it goes into a response
 * body exactly once at enrolment, and it must never be logged, audited,
 * attached to an error or put in a metric label — which is why it is built here
 * and nowhere else, so "where can a QR payload leak from" is a grep for this
 * function's name. `totp.test.ts` asserts the enrolment route's audit entry does
 * not contain it.
 *
 * `algorithm` and `digits` are stated explicitly rather than left to the app's
 * default: an authenticator that assumed SHA-256 would compute codes we would
 * reject, and the user would have no way to tell that from a wrong seed.
 */
export function totpEnrolmentUri(secretBase32: string, accountEmail: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ─── Recovery codes ─────────────────────────────────────────────────────────

/**
 * Normalise a code as typed: case, spaces and the dash the display format puts
 * in the middle all removed.
 *
 * `recoveryCodeSchema` in packages/shared does the same transform at the door,
 * and this function is the one the HASH is computed over, so the two must agree
 * — they are both "strip whitespace and dashes, lower-case". Kept here as well
 * because {@link hashRecoveryCode} must not be callable with an unnormalised
 * string by accident: a code stored under one normalisation and looked up under
 * another is a recovery code that silently never works.
 */
export function normaliseRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toLowerCase();
}

/**
 * HASHED, NOT SEALED, AND NOT STRETCHED. Three decisions, three reasons.
 *
 * HASHED rather than sealed: a sealed value can be OPENED, so a sealed recovery
 * code is a credential this process can read, print and leak. A digest cannot be
 * opened by anybody, including us, which is the correct property for a value
 * whose only use is to be COMPARED. (The TOTP seed beside it is sealed for the
 * opposite reason: codes are computed from it, so it has to be readable.)
 *
 * PLAIN SHA-256 rather than the HMAC `hashToken` applies: because
 * `TotpRecoveryCode.codeHash` records its contract as "SHA-256 of the
 * normalised code, hex", and a column whose comment and whose writer disagree
 * is worse than either choice. Two hashings of the same credential in one
 * codebase is also how a lookup silently stops matching.
 *
 * NOT STRETCHED: a code is {@link RECOVERY_CODE_CHARS} characters from a
 * 31-character alphabet — about 50 bits — so there is no dictionary and no
 * rainbow table to defend against, and scrypt on a login path that may check
 * ten rows is a denial-of-service surface bought for nothing.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

/**
 * ONE MINTED BATCH: what the user is shown, and what is stored.
 *
 * TWO FIELDS AND NOT ONE, because they are two facts with two lifetimes. The
 * `display` array exists for the length of one HTTP response and is then gone
 * for ever; the `hashes` array is what the database keeps. A single array the
 * caller hashed itself is how a plaintext ends up in an audit entry.
 */
export interface MintedRecoveryCodes {
  /** Shown ONCE, in the enrolment response. Never logged, never stored. */
  readonly display: readonly string[];
  /** `TotpRecoveryCode.codeHash`, in the same order. */
  readonly hashes: readonly string[];
}

/**
 * Mint `count` single-use recovery codes.
 *
 * ── REJECTION SAMPLING, NOT A MODULUS ──────────────────────────────────────
 *
 * The alphabet has 31 characters and a byte has 256 values. `byte % 31` makes
 * the first eleven characters appear 9 times per 256 and the rest 8 — a 12%
 * bias, which over ten characters is a measurable reduction of the search
 * space. So a byte of 248 or more is DISCARDED and another is drawn. The loop
 * is bounded by drawing in blocks and refusing to spin: if the injected source
 * returns bytes that never fall in range (a fake returning `0xff`), this throws
 * rather than hanging, and the message names the source and not the bytes.
 */
export function mintRecoveryCodes(count: number, random: RandomBytes): MintedRecoveryCodes {
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  const display: string[] = [];

  for (let index = 0; index < count; index += 1) {
    let code = '';
    let drawn = 0;
    while (code.length < RECOVERY_CODE_CHARS) {
      const block = random(RECOVERY_CODE_CHARS * 2);
      drawn += 1;
      if (drawn > 8) {
        throw new Error(
          'The injected entropy source produced no byte inside the unbiased range after 8 blocks. ' +
            'Recovery codes were NOT minted; nothing was written.',
        );
      }
      for (const byte of block) {
        if (byte >= limit) continue;
        code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
        if (code.length === RECOVERY_CODE_CHARS) break;
      }
    }
    // Dashed in the middle for the printout only; `normaliseRecoveryCode`
    // removes it, so the dash is never part of what is hashed or compared.
    display.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }

  return { display, hashes: display.map(hashRecoveryCode) };
}
