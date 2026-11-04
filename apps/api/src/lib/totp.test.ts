/**
 * Tests for RFC 6238 verification, replay refusal and recovery codes.
 *
 * What is being proven, worst defect first:
 *
 *   1. THE CODE'S VALUE IS CHECKED. The defect this file exists to close is a
 *      login path that checked a code was PRESENT and never looked at it, so
 *      the first test is that a wrong six digits is refused — which would have
 *      passed against the old route and is the whole round in one assertion.
 *
 *   2. THE WINDOW IS ±1 STEP AND NO MORE. Both edges accepted, both
 *      next-neighbours refused. A window that silently widened would be
 *      invisible without this.
 *
 *   3. A CODE CANNOT BE USED TWICE. Same code, same window, second attempt
 *      refused — and refused with its OWN member so an operator can see a
 *      replay, while the caller gets the same sentence as a wrong code.
 *
 *   4. EVERY REFUSAL IS THE SAME SENTENCE, and no refusal quotes the seed, the
 *      code or the QR payload. Walked over all five members rather than
 *      asserted about one.
 *
 *   5. RECOVERY CODES ARE UNBIASED, SINGLE-USE-SHAPED AND HASHED. The alphabet
 *      is 31 characters and a byte is 256 values, so a modulus would make the
 *      first eleven characters 12% more likely; the rejection sampling is
 *      asserted against a source that returns exactly the biased bytes.
 *
 * No clock, no socket, no database, no `node:dns`: `nowMs` is a number, the
 * entropy source is a function, and the replay memory is an interface.
 */

import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_CHARS,
  REPLAY_MEMORY_MS,
  TOTP_DIGITS,
  TOTP_REFUSALS,
  TOTP_REFUSAL_SENTENCE,
  TOTP_STEP_SECONDS,
  TOTP_WINDOW_STEPS,
  fromBase32,
  generateTotpSecret,
  hashRecoveryCode,
  inProcessReplayStore,
  mintRecoveryCodes,
  normaliseRecoveryCode,
  stepAt,
  toBase32,
  totpCodeAt,
  totpEnrolmentUri,
  verifyTotpCode,
} from './totp.js';
import type { TotpReplayStore } from './totp.js';

/** A seed with no secret in it: twenty bytes of a counting pattern. */
const SEED = toBase32(Buffer.from(Array.from({ length: 20 }, (_, i) => (i * 7 + 3) & 0xff)));
const USER = 'user_totp';
/** A step comfortably inside the epoch, so arithmetic is readable in failures. */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

/** A replay store that remembers nothing, for the tests that are not about replay. */
function forgetfulStore(): TotpReplayStore {
  return { wasUsed: async () => false, markUsed: async () => {} };
}

function codeFor(nowMs: number, offsetSteps = 0): string {
  const code = totpCodeAt(SEED, stepAt(nowMs) + offsetSteps);
  if (code === null) throw new Error('the fixture seed did not decode');
  return code;
}

describe('base32, which the authenticator reads the seed through', () => {
  it('round-trips arbitrary bytes', () => {
    for (const length of [1, 2, 3, 4, 5, 10, 20, 32]) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 31 + 17) & 0xff));
      expect(fromBase32(toBase32(bytes))?.equals(bytes)).toBe(true);
    }
  });

  it('emits no padding and no lower case, because some authenticators reject both', () => {
    const encoded = toBase32(Buffer.from([1, 2, 3]));
    expect(encoded).not.toContain('=');
    expect(encoded).toBe(encoded.toUpperCase());
  });

  it('tolerates padding and spaces on the way IN, because users paste exports', () => {
    const encoded = toBase32(Buffer.from([9, 9, 9, 9, 9]));
    const spaced = `${encoded.slice(0, 4)} ${encoded.slice(4)}===`;
    expect(fromBase32(spaced)?.equals(Buffer.from([9, 9, 9, 9, 9]))).toBe(true);
  });

  it('answers NULL for a string that is not base32, rather than a best-effort decode', () => {
    // `1`, `8`, `0` are not in the alphabet. A best-effort decode would produce
    // bytes, and bytes produce codes, and a code computed from a mangled seed
    // never matches anything the user's app shows — which presents as "2FA is
    // broken" with nothing in a log to say why.
    expect(fromBase32('ABC1')).toBeNull();
    expect(fromBase32('')).toBeNull();
    expect(fromBase32('!!!!')).toBeNull();
  });
});

describe('a supplied TOTP code', () => {
  it('REFUSES SIX DIGITS THAT ARE NOT THE CODE — the defect, in one assertion', async () => {
    const right = codeFor(NOW);
    // Any six digits that are not the current code. Picked by arithmetic rather
    // than by a literal so this cannot accidentally BE the code.
    const wrong = String((Number(right) + 500_000) % 10 ** TOTP_DIGITS).padStart(
      TOTP_DIGITS,
      '0',
    );

    const verdict = await verifyTotpCode({
      secretBase32: SEED,
      code: wrong,
      nowMs: NOW,
      confirmedAt: new Date(NOW),
      userId: USER,
      replay: forgetfulStore(),
    });

    expect(verdict).toEqual({ ok: false, refusal: 'CODE_DID_NOT_VERIFY' });
  });

  it('accepts the code for the current step', async () => {
    const verdict = await verifyTotpCode({
      secretBase32: SEED,
      code: codeFor(NOW),
      nowMs: NOW,
      confirmedAt: new Date(NOW),
      userId: USER,
      replay: forgetfulStore(),
    });
    expect(verdict).toEqual({ ok: true, step: stepAt(NOW) });
  });

  it('accepts BOTH edges of the ±1 window and refuses both next-neighbours', async () => {
    const attempt = (offset: number) =>
      verifyTotpCode({
        secretBase32: SEED,
        code: codeFor(NOW, offset),
        nowMs: NOW,
        confirmedAt: new Date(NOW),
        userId: USER,
        replay: forgetfulStore(),
      });

    expect((await attempt(-TOTP_WINDOW_STEPS)).ok).toBe(true);
    expect((await attempt(TOTP_WINDOW_STEPS)).ok).toBe(true);
    // One step further out in each direction. A window that widened to ±2 — the
    // cheap answer to "my phone's clock is off" — triples the number of live
    // codes and would pass every other test in this file.
    expect(await attempt(-(TOTP_WINDOW_STEPS + 1))).toEqual({
      ok: false,
      refusal: 'CODE_DID_NOT_VERIFY',
    });
    expect(await attempt(TOTP_WINDOW_STEPS + 1)).toEqual({
      ok: false,
      refusal: 'CODE_DID_NOT_VERIFY',
    });
  });

  it('refuses anything that is not six digits BEFORE computing an HMAC', async () => {
    for (const code of ['', '12345', '1234567', '12345a', ' 123456', '1'.repeat(4096)]) {
      expect(
        await verifyTotpCode({
          secretBase32: SEED,
          code,
          nowMs: NOW,
          confirmedAt: new Date(NOW),
          userId: USER,
          replay: forgetfulStore(),
        }),
      ).toEqual({ ok: false, refusal: 'MALFORMED_CODE' });
    }
  });

  it('refuses an UNCONFIRMED enrolment rather than checking a factor nobody proved', async () => {
    expect(
      await verifyTotpCode({
        secretBase32: SEED,
        code: codeFor(NOW),
        nowMs: NOW,
        confirmedAt: null,
        userId: USER,
        replay: forgetfulStore(),
      }),
    ).toEqual({ ok: false, refusal: 'NOT_CONFIRMED' });
  });

  it('refuses a missing or undecodable seed, and never falls through to "no factor needed"', async () => {
    for (const secretBase32 of [null, '', 'not-base32-at-all-1118']) {
      expect(
        await verifyTotpCode({
          secretBase32,
          code: codeFor(NOW),
          nowMs: NOW,
          confirmedAt: new Date(NOW),
          userId: USER,
          replay: forgetfulStore(),
        }),
      ).toEqual({ ok: false, refusal: 'NO_SECRET' });
    }
  });
});

describe('replay refusal — an intercepted code must not be reusable', () => {
  it('REFUSES THE SAME CODE TWICE INSIDE ONE WINDOW', async () => {
    let clock = NOW;
    const replay = inProcessReplayStore(() => clock);
    const code = codeFor(NOW);

    const first = await verifyTotpCode({
      secretBase32: SEED,
      code,
      nowMs: clock,
      confirmedAt: new Date(NOW),
      userId: USER,
      replay,
    });
    expect(first.ok).toBe(true);

    // Two seconds later. Same step, same code — which is exactly what somebody
    // who read it off a screen or proxied it through a phishing page holds.
    clock = NOW + 2_000;
    expect(
      await verifyTotpCode({
        secretBase32: SEED,
        code,
        nowMs: clock,
        confirmedAt: new Date(NOW),
        userId: USER,
        replay,
      }),
    ).toEqual({ ok: false, refusal: 'CODE_ALREADY_USED' });
  });

  it('spends a step per USER, so two people are not locked out of each other', async () => {
    const clock = NOW;
    const replay = inProcessReplayStore(() => clock);
    const code = codeFor(NOW);

    expect(
      (
        await verifyTotpCode({
          secretBase32: SEED,
          code,
          nowMs: clock,
          confirmedAt: new Date(NOW),
          userId: 'user_a',
          replay,
        })
      ).ok,
    ).toBe(true);
    // The same seed is a test fixture, not a real shared secret; what is being
    // asserted is that the replay KEY carries the user, so one person signing
    // in does not spend another person's step.
    expect(
      (
        await verifyTotpCode({
          secretBase32: SEED,
          code,
          nowMs: clock,
          confirmedAt: new Date(NOW),
          userId: 'user_b',
          replay,
        })
      ).ok,
    ).toBe(true);
  });

  it('remembers a spent step for the whole window it could still be presented in', async () => {
    let clock = NOW;
    const replay = inProcessReplayStore(() => clock);
    await replay.markUsed(USER, stepAt(NOW), REPLAY_MEMORY_MS);

    // One step short of the memory: still refused.
    clock = NOW + REPLAY_MEMORY_MS - TOTP_STEP_SECONDS * 1000;
    expect(await replay.wasUsed(USER, stepAt(NOW))).toBe(true);

    // Past it: forgotten, which is correct — that step's codes are long dead,
    // so remembering them for ever is a memory leak and nothing else.
    clock = NOW + REPLAY_MEMORY_MS + 1;
    expect(await replay.wasUsed(USER, stepAt(NOW))).toBe(false);
  });

  it('does NOT spend a step when the code failed, so a typo costs nothing', async () => {
    const clock = NOW;
    const replay = inProcessReplayStore(() => clock);
    const right = codeFor(NOW);
    const wrong = String((Number(right) + 1) % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');

    await verifyTotpCode({
      secretBase32: SEED,
      code: wrong,
      nowMs: clock,
      confirmedAt: new Date(NOW),
      userId: USER,
      replay,
    });
    // A failed attempt that burned the step would mean one mistyped digit locks
    // the user out of the next thirty seconds of their own authenticator.
    expect(
      (
        await verifyTotpCode({
          secretBase32: SEED,
          code: right,
          nowMs: clock,
          confirmedAt: new Date(NOW),
          userId: USER,
          replay,
        })
      ).ok,
    ).toBe(true);
  });
});

describe('a refusal must be reportable without quoting what it refused', () => {
  it('shows ONE sentence for every one of the five refusals', () => {
    // Derived from the list, so a sixth refusal added without a thought about
    // what the caller is told fails here rather than shipping its own wording.
    expect(TOTP_REFUSALS.length).toBe(5);
    expect(TOTP_REFUSAL_SENTENCE).toBe('That two-factor code is not valid.');
    expect(TOTP_REFUSAL_SENTENCE).not.toMatch(/\d{6}/);
  });

  it('never puts the seed, the code or the QR payload in a verdict', async () => {
    const code = codeFor(NOW);
    const uri = totpEnrolmentUri(SEED, 'person@example.test', 'QAAI');

    const verdicts = [
      await verifyTotpCode({
        secretBase32: SEED,
        code: '000000',
        nowMs: NOW,
        confirmedAt: new Date(NOW),
        userId: USER,
        replay: forgetfulStore(),
      }),
      await verifyTotpCode({
        secretBase32: SEED,
        code,
        nowMs: NOW,
        confirmedAt: null,
        userId: USER,
        replay: forgetfulStore(),
      }),
      await verifyTotpCode({
        secretBase32: null,
        code,
        nowMs: NOW,
        confirmedAt: new Date(NOW),
        userId: USER,
        replay: forgetfulStore(),
      }),
      await verifyTotpCode({
        secretBase32: SEED,
        code: 'nonsense',
        nowMs: NOW,
        confirmedAt: new Date(NOW),
        userId: USER,
        replay: forgetfulStore(),
      }),
      await verifyTotpCode({
        secretBase32: SEED,
        code,
        nowMs: NOW,
        confirmedAt: new Date(NOW),
        userId: USER,
        replay: { wasUsed: async () => true, markUsed: async () => {} },
      }),
    ];

    // Every member reached, so this is a walk of the list and not a sample.
    expect(new Set(verdicts.filter((v) => !v.ok).map((v) => !v.ok && v.refusal))).toEqual(
      new Set(TOTP_REFUSALS),
    );

    for (const verdict of verdicts) {
      const serialised = JSON.stringify(verdict);
      expect(serialised).not.toContain(SEED);
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain(uri);
    }
  });

  it('builds the QR payload with the algorithm named, so no app guesses SHA-256', () => {
    const uri = totpEnrolmentUri(SEED, 'person@example.test', 'QAAI');
    expect(uri.startsWith('otpauth://totp/QAAI:person%40example.test?')).toBe(true);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain(`digits=${TOTP_DIGITS}`);
    expect(uri).toContain(`period=${TOTP_STEP_SECONDS}`);
  });
});

describe('recovery codes', () => {
  /** A source whose bytes are all above the unbiased limit, to drive the rejection. */
  const biasedBytes = (value: number) => (n: number) => Buffer.alloc(n, value);
  const countingBytes = (): ((n: number) => Buffer) => {
    let next = 0;
    return (n: number) =>
      Buffer.from(
        Array.from({ length: n }, () => {
          next = (next + 1) & 0xff;
          return next;
        }),
      );
  };

  it('mints what it says, in the display shape and the stored shape', () => {
    const minted = mintRecoveryCodes(10, countingBytes());
    expect(minted.display.length).toBe(10);
    expect(minted.hashes.length).toBe(10);
    for (const code of minted.display) {
      // Five, a dash, five — and the dash is cosmetic, so the hash is over the
      // normalised form and a user who omits it still gets in.
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      expect(normaliseRecoveryCode(code).length).toBe(RECOVERY_CODE_CHARS);
    }
    expect(minted.hashes).toEqual(minted.display.map(hashRecoveryCode));
  });

  it('hashes the NORMALISED code, so the dash and the case cannot break a redemption', () => {
    const minted = mintRecoveryCodes(1, countingBytes());
    const shown = minted.display[0]!;
    expect(hashRecoveryCode(shown.toLowerCase())).toBe(minted.hashes[0]);
    expect(hashRecoveryCode(shown.replace('-', ''))).toBe(minted.hashes[0]);
    expect(hashRecoveryCode(` ${shown.toLowerCase()} `)).toBe(minted.hashes[0]);
  });

  it('contains no confusable character, because a locked-out person types these by hand', () => {
    const minted = mintRecoveryCodes(16, countingBytes());
    for (const code of minted.display) {
      expect(code).not.toMatch(/[ILO01]/);
    }
  });

  it('REJECTS BIASED BYTES rather than taking a modulus over a 31-character alphabet', () => {
    // 248..255 are above the unbiased limit (256 - 256 % 31 = 248). A modulus
    // implementation would happily turn 0xff into a character and make the
    // first eleven letters 12% more likely than the rest.
    expect(() => mintRecoveryCodes(1, biasedBytes(0xff))).toThrow(
      /no byte inside the unbiased range/,
    );
  });

  it('does not put a code in the error it throws when entropy fails', () => {
    try {
      mintRecoveryCodes(1, biasedBytes(0xfe));
      expect.unreachable('a source of only out-of-range bytes must not mint');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('nothing was written');
      expect(message).not.toMatch(/[A-Z2-9]{5}-[A-Z2-9]{5}/);
    }
  });

  it('mints distinct codes', () => {
    const minted = mintRecoveryCodes(16, countingBytes());
    expect(new Set(minted.display).size).toBe(16);
    expect(new Set(minted.hashes).size).toBe(16);
  });
});

describe('a generated seed', () => {
  it('is twenty bytes of the injected entropy, encoded for an authenticator', () => {
    const secret = generateTotpSecret((n) => Buffer.alloc(n, 0xa5));
    expect(fromBase32(secret)?.equals(Buffer.alloc(20, 0xa5))).toBe(true);
  });

  it('produces codes that verify against itself', async () => {
    const secret = generateTotpSecret((n) => Buffer.alloc(n, 0x5a));
    const code = totpCodeAt(secret, stepAt(NOW));
    expect(code).toMatch(/^\d{6}$/);
    expect(
      (
        await verifyTotpCode({
          secretBase32: secret,
          code: code!,
          nowMs: NOW,
          confirmedAt: new Date(NOW),
          userId: USER,
          replay: forgetfulStore(),
        })
      ).ok,
    ).toBe(true);
  });
});
