import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashToken, generateToken, generateApiKey, safeEqual } from './crypto.js';
import { env } from '../env.js';

/**
 * `SESSION_SECRET` was required at boot and read by nothing, while
 * `deploy/.env.example` told operators it signed session cookies. These tests
 * exist so it cannot quietly stop mattering again: each one fails if the key
 * is dropped back out of the digest.
 */
describe('hashToken', () => {
  it('is keyed on SESSION_SECRET, not a bare digest of the token', () => {
    const raw = generateToken();

    // The exact thing it used to be. If this ever matches again, the secret has
    // stopped doing anything and the operator docs are a lie once more.
    expect(hashToken(raw)).not.toBe(createHash('sha256').update(raw).digest('hex'));
    expect(hashToken(raw)).toBe(createHmac('sha256', env.SESSION_SECRET).update(raw).digest('hex'));
  });

  it('gives a different digest under a different key, which is what makes a dump useless', () => {
    const raw = generateToken();
    const underAnotherKey = createHmac('sha256', `${env.SESSION_SECRET}-rotated`)
      .update(raw)
      .digest('hex');

    // A stolen database carries the hashes and not the key, so the rows cannot
    // be matched against a token without it.
    expect(hashToken(raw)).not.toBe(underAnotherKey);
  });

  it('is stable for one token, or nobody could log in twice', () => {
    const raw = generateToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
  });

  it('separates two tokens', () => {
    expect(hashToken(generateToken())).not.toBe(hashToken(generateToken()));
  });

  it('covers API keys too — they are looked up by the same digest', () => {
    const key = generateApiKey();
    expect(key.hash).toBe(hashToken(key.raw));
    expect(key.raw.startsWith(key.prefix)).toBe(true);
  });
});

describe('generateToken', () => {
  it('is 256 bits, which is why the digest is not stretched', () => {
    // base64url of 32 bytes: 43 characters, no padding.
    expect(generateToken()).toHaveLength(43);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(seen.size).toBe(500);
  });
});

describe('safeEqual', () => {
  it('matches equal strings and rejects the rest', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    // Different lengths must not throw — timingSafeEqual does, on its own.
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
