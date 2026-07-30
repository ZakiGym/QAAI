/**
 * Secrets vault (§1) — AES-256-GCM, key from env today and KMS later.
 *
 * Design notes:
 * - Per-secret random IV; never reused.
 * - The GCM auth tag is stored alongside, so tampering fails closed on decrypt.
 * - Additional authenticated data binds a ciphertext to its (orgId, name). Moving
 *   a row to another org or renaming it in-place makes it undecryptable rather
 *   than silently readable under the wrong tenant.
 * - `keyVersion` is stored per row so the master key can be rotated by
 *   re-encrypting lazily instead of in one migration.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM standard
const TAG_LENGTH = 16;
const CURRENT_KEY_VERSION = 1;

/**
 * Versioned key material. Rotation: add version 2 here sourced from a new env
 * var / KMS handle, bump CURRENT_KEY_VERSION, and leave version 1 in place until
 * the re-encrypt sweeper has drained.
 */
function keyForVersion(version: number): Buffer {
  if (version === 1) {
    const key = Buffer.from(env.VAULT_MASTER_KEY, 'base64');
    if (key.length !== 32) {
      throw new Error('VAULT_MASTER_KEY must decode to exactly 32 bytes');
    }
    return key;
  }
  throw new Error(`No vault key registered for version ${version}`);
}

export interface SealedSecret {
  ciphertext: string;
  keyVersion: number;
  /** Last 4 plaintext characters, so the UI can confirm a value without decrypting. */
  hint: string;
}

function aad(orgId: string, name: string): Buffer {
  return Buffer.from(`${orgId}:${name}`, 'utf8');
}

export function seal(plaintext: string, orgId: string, name: string): SealedSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyForVersion(CURRENT_KEY_VERSION), iv, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(aad(orgId, name));

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    // iv | tag | ciphertext, base64. Self-contained so no side table is needed.
    ciphertext: Buffer.concat([iv, tag, encrypted]).toString('base64'),
    keyVersion: CURRENT_KEY_VERSION,
    hint: plaintext.length <= 4 ? '' : plaintext.slice(-4),
  };
}

export function open(sealed: string, keyVersion: number, orgId: string, name: string): string {
  const raw = Buffer.from(sealed, 'base64');
  if (raw.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Malformed ciphertext');
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, keyForVersion(keyVersion), iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(aad(orgId, name));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately opaque: distinguishing "wrong key" from "tampered" leaks information.
    throw new Error(`Unable to decrypt secret "${name}" — wrong key or tampered ciphertext`);
  }
}

/** True when a row should be re-sealed under the current key on next write. */
export function needsRotation(keyVersion: number): boolean {
  return keyVersion < CURRENT_KEY_VERSION;
}
