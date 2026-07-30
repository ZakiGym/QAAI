/**
 * Git integration credentials.
 *
 * A personal access token is sealed with the same AES-256-GCM vault the test
 * secrets use, with the AAD bound to `orgId:integration:<id>`. That binding means
 * a ciphertext row copied into another org — or another integration — fails to
 * decrypt rather than quietly working under the wrong tenant.
 *
 * The plaintext is produced only inside a push and is never returned by any
 * endpoint, logged, or written to audit metadata.
 */

import { open, seal } from './vault.js';

/** Namespaced so a token can never be opened as if it were an environment secret. */
const aadName = (integrationId: string) => `integration:${integrationId}`;

export function sealToken(token: string, orgId: string, integrationId: string) {
  return seal(token, orgId, aadName(integrationId));
}

export function openToken(
  ciphertext: string,
  keyVersion: number,
  orgId: string,
  integrationId: string,
): string {
  return open(ciphertext, keyVersion, orgId, aadName(integrationId));
}

/**
 * Non-secret settings we keep on Integration.config. The token lives in
 * configEnc; `keyVersion` rides alongside so the master key can rotate.
 */
export interface GitIntegrationConfig {
  repo: string;
  defaultBranch: string;
  keyVersion?: number;
}

export function parseGitConfig(config: unknown): GitIntegrationConfig {
  const c = (config ?? {}) as Partial<GitIntegrationConfig>;
  return {
    repo: typeof c.repo === 'string' ? c.repo : '',
    defaultBranch: typeof c.defaultBranch === 'string' ? c.defaultBranch : 'qaai/tests',
    ...(typeof c.keyVersion === 'number' ? { keyVersion: c.keyVersion } : {}),
  };
}
