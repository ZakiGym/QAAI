/**
 * Password hashing and opaque-token handling.
 *
 * scrypt from node:crypto rather than bcrypt/argon2: it is memory-hard, it is in
 * the standard library (no native build step in the Docker image), and it is
 * FIPS-adjacent enough for SOC2 conversations. Parameters below target ~100ms
 * per hash on commodity hardware.
 */

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { API_KEY_PREFIX } from '@qaai/shared';
import { env } from '../env.js';

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
 * Session cookies, API keys, invite and runner tokens: we store only the hash,
 * so a database leak does not hand out live credentials.
 *
 * HMAC-SHA256 keyed on SESSION_SECRET, not a bare SHA-256. Not scrypt: these
 * are already 256 bits of entropy from `generateToken`, so stretching buys
 * nothing against a guessing attack and costs a lot on every authenticated
 * request.
 *
 * ── Why keyed, when the input is already unguessable ────────────────────────
 *
 * Honestly: the guessing argument does not need it. 256 random bits are not
 * brute-forced and not rainbow-tabled, so an unkeyed digest of one is already
 * safe against the attack people usually mean.
 *
 * It is keyed because SESSION_SECRET was REQUIRED AT BOOT — the API refuses to
 * start without 32 characters of it — and nothing read it. `deploy/.env.example`
 * and `deploy/README.md` told operators it signed session cookies. It did not.
 * A secret an operator generates, stores, rotates and protects, that has no
 * effect, is worse than no secret: it spends real trust on nothing, and the
 * first person to discover it stops believing the other things those docs say.
 *
 * So either it had to go or it had to work. Making it work is the better half
 * of that choice, because it does buy one real thing: the database alone is no
 * longer enough. A dump — a stolen backup, a replica, an errant analytics
 * export — cannot be turned into live sessions without also holding the secret,
 * which lives in the environment and, per deploy/backup.md, is deliberately
 * kept out of the backups.
 *
 * ── Deploying this invalidates every existing token ─────────────────────────
 *
 * The digest changes, so sessions, API keys and runner tokens minted before it
 * no longer match. Everyone signs in again; CI keys and runner tokens must be
 * regenerated. That is a one-time cost that is acceptable now and would not be
 * later, which is exactly why it is being paid now.
 */
export function hashToken(raw: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(raw).digest('hex');
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
