/**
 * Vault reader for the worker. Mirrors apps/api/src/lib/vault.ts — same
 * algorithm, same AAD binding — because the worker must decrypt secrets to run
 * tests but must not import the API's request-scoped modules.
 */

import { createDecipheriv } from 'node:crypto';
import { config, logger, prisma } from './context.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function keyForVersion(version: number): Buffer {
  if (version !== 1) throw new Error(`No vault key registered for version ${version}`);
  const key = Buffer.from(config.vaultMasterKey, 'base64');
  if (key.length !== 32) throw new Error('VAULT_MASTER_KEY must decode to exactly 32 bytes');
  return key;
}

export function open(sealed: string, keyVersion: number, orgId: string, name: string): string {
  const raw = Buffer.from(sealed, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, keyForVersion(keyVersion), iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(`${orgId}:${name}`, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * Decrypts every secret for an environment. A secret that fails to decrypt is
 * skipped with a warning rather than aborting the run — one rotated key should
 * not take a whole suite down, and the test that needed it will fail loudly
 * with a missing-env-var error that says exactly what happened.
 */
export async function secretsFor(
  orgId: string,
  environmentId: string,
): Promise<Record<string, string>> {
  const rows = await prisma.secret.findMany({
    where: { orgId, environmentId },
    select: { name: true, valueEnc: true, keyVersion: true },
  });

  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      out[row.name] = open(row.valueEnc, row.keyVersion, orgId, row.name);
    } catch (err) {
      logger.error({ err, secret: row.name }, 'could not decrypt secret; skipping');
    }
  }
  return out;
}
