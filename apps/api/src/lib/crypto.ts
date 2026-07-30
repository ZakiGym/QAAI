/**
 * Password hashing and opaque-token handling.
 *
 * scrypt from node:crypto rather than bcrypt/argon2: it is memory-hard, it is in
 * the standard library (no native build step in the Docker image), and it is
 * FIPS-adjacent enough for SOC2 conversations. Parameters below target ~100ms
 * per hash on commodity hardware.
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { API_KEY_PREFIX } from '@qaai/shared';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Format: `scrypt$N$r$p$<salt-b64>$<hash-b64>` — self-describing so params can change. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) {
    return false;
  }

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: Math.max(64 * 1024 * 1024, 129 * N * r),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Session cookies, API keys, invite tokens: we store only the hash, so a database
 * leak does not hand out live credentials. SHA-256 (not scrypt) because these are
 * already 256 bits of entropy — stretching buys nothing and costs a lot per request.
 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export interface GeneratedApiKey {
  /** Shown to the user exactly once. */
  raw: string;
  hash: string;
  /** Stored for display: `qaai_a1b2c3d4`. */
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const body = randomBytes(24).toString('base64url');
  const raw = `${API_KEY_PREFIX}${body}`;
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, API_KEY_PREFIX.length + 8) };
}

/** Constant-time string compare for tokens supplied by a caller. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
