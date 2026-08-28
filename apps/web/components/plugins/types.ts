/**
 * The shapes `GET /plugins` answers with.
 *
 * Declared here rather than imported from @qaai/shared, and the reason is worth
 * knowing: the manifest module in that package imports `node:crypto`, so it is
 * deliberately absent from the barrel the web bundler consumes. Nothing in this
 * folder can verify a signature and nothing in it should pretend to.
 *
 * The capability VOCABULARY is not duplicated either — it is served by the API,
 * on the same response as the plugins, out of the same file the install
 * endpoint refuses on. A UI-side copy of that table is exactly how an install
 * screen ends up reassuring somebody about a permission whose meaning changed
 * two releases ago.
 */

export type CapabilityName = string;

export interface CapabilityInfo {
  name: CapabilityName;
  label: string;
  /** What the plugin will be able to do. */
  grants: string;
  /** The limit that still applies once granted. */
  bounded: string;
  /** True when the org's plan has to permit it. */
  governed: boolean;
}

export interface Publisher {
  id: string;
  publisherId: string;
  displayName: string;
  /** SHA-256 of the key, grouped in fours. What a person compares by eye. */
  fingerprint: string;
  revokedAt: string | null;
  createdAt: string;
  pluginCount: number;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  publisher: string;
  displayName: string;
  description: string;
  homepage: string | null;
  protocol: number;
  capabilities: CapabilityName[];
  governedCapabilities: CapabilityName[];
  codeSha256: string;
  codeEntry: string;
  codeBytes: number;
  createdAt: string;
  /** Its publisher's key has been revoked since it was installed. */
  publisherRevoked: boolean;
  /** projectId → enabled. A missing project has never been decided, and is off. */
  projects: Record<string, boolean>;
}

export interface PluginRegistry {
  plan: { label: string; allowsGovernedCapabilities: boolean };
  protocol: { speaks: number; oldest: number };
  manifestSchema: string;
  reservedNames: string[];
  capabilities: CapabilityInfo[];
  publishers: Publisher[];
  plugins: InstalledPlugin[];
  projects: Array<{ id: string; name: string }>;
}
