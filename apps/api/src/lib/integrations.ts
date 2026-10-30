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
import type { ChatCredentials } from './chat-integrations.js';
import { decodeChatCredentials, encodeChatCredentials, integrationAad } from './chat-integrations.js';

/**
 * Namespaced so a token can never be opened as if it were an environment
 * secret. The name lives in chat-integrations.ts (the pure module the worker
 * also imports) so both sides bind the same AAD; `aadName` here is that helper.
 */
const aadName = integrationAad;

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
 * Chat-webhook credentials — the URL, plus the WEBHOOK signing secret when one
 * exists — sealed as one JSON envelope under the same AAD as a git token. The
 * plaintext is produced only inside a send and is never returned by any
 * endpoint, logged, or written to audit metadata.
 */
export function sealChatCredentials(
  credentials: ChatCredentials,
  orgId: string,
  integrationId: string,
) {
  return seal(encodeChatCredentials(credentials), orgId, aadName(integrationId));
}

export function openChatCredentials(
  ciphertext: string,
  keyVersion: number,
  orgId: string,
  integrationId: string,
): ChatCredentials {
  return decodeChatCredentials(open(ciphertext, keyVersion, orgId, aadName(integrationId)));
}

/**
 * Non-secret settings we keep on Integration.config. The token lives in
 * configEnc; `keyVersion` rides alongside so the master key can rotate.
 */
/**
 * Every `Integration.config` key the git integrations store.
 *
 * ── WHY ALL FOUR ARE HERE AND NOT JUST THE TWO THE PUSH NEEDS ──────────────
 *
 * `baseBranch` and `pullRequests` were read straight off the JSON by
 * `pullRequestStore.loadTarget` (apps/api/src/lib/git.ts) while this function —
 * the one named "parse the git config" — did not know they existed. Two readers
 * of one row, and the one a developer finds by its name was the incomplete one.
 * The failure that waits at the end of that is a key added to one reader and
 * not the other, on the path that decides WHICH REPOSITORY a pull request is
 * opened in.
 */
export interface GitIntegrationConfig {
  repo: string;
  /**
   * The branch QAAI PUSHES TO. Defaulted, because a push with nowhere to go is
   * not a useful refusal.
   */
  defaultBranch: string;
  /**
   * The branch a pull request is opened AGAINST — the trunk, not QAAI's own
   * branch. NOT DEFAULTED, deliberately: `defaultBranch` falls back to
   * `qaai/tests`, and a `baseBranch` that inherited that fallback would propose
   * merging a heal into the test-sync branch instead of the trunk, or open a
   * pull request from QAAI's branch into QAAI's branch. `undefined` means
   * "nobody configured one", and the caller decides what to assume and says so.
   */
  baseBranch?: string;
  /**
   * Whether this integration may open pull requests. An EXPLICIT `true`, never
   * "not false": a missing key is an org that configured a git integration
   * before pull requests existed, and inheriting an outward-facing write into
   * their repository from a default is consent this product may not assume.
   */
  pullRequests?: boolean;
  keyVersion?: number;
}

export function parseGitConfig(config: unknown): GitIntegrationConfig {
  const c = (config ?? {}) as Partial<GitIntegrationConfig>;
  return {
    repo: typeof c.repo === 'string' ? c.repo : '',
    defaultBranch: typeof c.defaultBranch === 'string' ? c.defaultBranch : 'qaai/tests',
    ...(typeof c.baseBranch === 'string' ? { baseBranch: c.baseBranch } : {}),
    pullRequests: c.pullRequests === true,
    ...(typeof c.keyVersion === 'number' ? { keyVersion: c.keyVersion } : {}),
  };
}
