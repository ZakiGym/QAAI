/**
 * What the install screen can work out for itself, before anybody clicks
 * Install — and, more importantly, what it cannot.
 *
 * ─── The line this module refuses to cross ───────────────────────────────────
 *
 * It does not verify the signature. It cannot: the org's trusted keys never
 * reach the browser, and the verifier lives in a Node-only module. Every
 * objection it raises is one the SERVER raises again, so nothing here is load
 * bearing — this is a mirror, not a gate.
 *
 * That distinction is the reason the return type carries `signatureChecked:
 * false` as a literal instead of leaving it implied. A preview panel that lists
 * five green ticks and stays quiet about provenance reads, to the person about
 * to approve it, as "we checked". They would be approving on the strength of a
 * screen that parsed some JSON. The screen has to say out loud that the one
 * question that matters is answered on submit, by the server, and nowhere else.
 *
 * ─── Why mirror the checks at all, then ──────────────────────────────────────
 *
 * Because the objections that ARE knowable here are the ones a person can fix
 * before wasting a round trip, and two of them are things they should see while
 * still looking at the document: the bundle they downloaded not matching the
 * digest the publisher signed, and a capability list bigger than they expected.
 * Showing those after a failed POST means showing them on a screen that has
 * already lost the context.
 */

import type { CapabilityInfo, InstalledPlugin, PluginRegistry } from './types';

/** The document a publisher ships alongside their bundle. */
export interface SignedManifestDocument {
  manifest: {
    schema: string;
    name: string;
    version: string;
    publisher: string;
    displayName: string;
    description: string;
    homepage?: string;
    protocol: number;
    capabilities: string[];
    code: { sha256: string; bytes: number; entry: string };
  };
  signature: { algorithm: string; value: string };
}

/**
 * Something the reader should know before submitting.
 *
 * `blocking` means the server will certainly refuse, so the button says so
 * rather than inviting a click that cannot work. Everything else is advice.
 */
export interface Objection {
  kind:
    | 'unknown-publisher'
    | 'publisher-revoked'
    | 'protocol'
    | 'reserved-name'
    | 'already-installed'
    | 'digest-mismatch'
    | 'plan';
  message: string;
  blocking: boolean;
}

export interface CapabilityGrant {
  info: CapabilityInfo;
  /** The plan cannot permit this one. */
  beyondPlan: boolean;
}

export type InstallPreview =
  | { state: 'empty' }
  | { state: 'unreadable'; message: string }
  | {
      state: 'ready';
      document: SignedManifestDocument;
      grants: CapabilityGrant[];
      /**
       * Capabilities the manifest asks for that this build has no vocabulary
       * for. Rendered as unknown rather than dropped: a row silently omitted
       * from the list is a permission granted without being shown, which is the
       * worst failure this screen has.
       */
      unrecognised: string[];
      objections: Objection[];
      /** Always false. See the note at the top of this file. */
      signatureChecked: false;
    };

function readable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the pasted document. Deliberately strict about the handful of fields
 * the screen renders, and deliberately silent about the rest — the server owns
 * the real schema, and a second, drifting copy of it here would produce a
 * screen that refuses documents the API would have accepted.
 */
export function parseSignedDocument(text: string): SignedManifestDocument | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'That is not valid JSON. Paste the whole file the publisher gave you.' };
  }

  if (!readable(parsed)) return { error: 'Expected a JSON object with a manifest and a signature.' };

  const manifest = parsed.manifest;
  const signature = parsed.signature;
  if (!readable(manifest)) {
    return { error: 'No `manifest` in that document — this looks like something else.' };
  }
  if (!readable(signature) || typeof signature.value !== 'string' || !signature.value) {
    return {
      error:
        'No `signature` in that document. An unsigned manifest cannot be installed, ' +
        'so there is nothing to preview.',
    };
  }

  const code = manifest.code;
  const missing = [
    typeof manifest.name === 'string' ? null : 'name',
    typeof manifest.version === 'string' ? null : 'version',
    typeof manifest.publisher === 'string' ? null : 'publisher',
    typeof manifest.protocol === 'number' ? null : 'protocol',
    Array.isArray(manifest.capabilities) ? null : 'capabilities',
    readable(code) && typeof code.sha256 === 'string' ? null : 'code.sha256',
  ].filter((field): field is string => field !== null);

  if (missing.length > 0) {
    return { error: `That manifest is missing ${missing.join(', ')}.` };
  }

  return parsed as unknown as SignedManifestDocument;
}

/**
 * Everything the panel shows, given what has been pasted and what the org
 * already has.
 *
 * `bundleSha256` is what the installer computed over the file they downloaded
 * (`shasum -a 256 plugin.tgz`). Empty while they have not typed it yet, which
 * is not an objection — it is simply the next thing to do.
 */
export function previewInstall(
  documentText: string,
  bundleSha256: string,
  registry: PluginRegistry,
): InstallPreview {
  if (!documentText.trim()) return { state: 'empty' };

  const parsed = parseSignedDocument(documentText);
  if ('error' in parsed) return { state: 'unreadable', message: parsed.error };

  const { manifest } = parsed;
  const known = new Map(registry.capabilities.map((c) => [c.name, c]));

  const grants: CapabilityGrant[] = [];
  const unrecognised: string[] = [];
  for (const name of manifest.capabilities) {
    const info = known.get(name);
    if (!info) {
      unrecognised.push(String(name));
      continue;
    }
    grants.push({
      info,
      beyondPlan: info.governed && !registry.plan.allowsGovernedCapabilities,
    });
  }

  const objections: Objection[] = [];

  const publisher = registry.publishers.find((p) => p.publisherId === manifest.publisher);
  if (!publisher) {
    objections.push({
      kind: 'unknown-publisher',
      blocking: true,
      message:
        `You have not told this organisation to trust "${manifest.publisher}". Add their ` +
        `signing key below — checking the fingerprint against their own site first — and ` +
        `then install.`,
    });
  } else if (publisher.revokedAt) {
    objections.push({
      kind: 'publisher-revoked',
      blocking: true,
      message: `The key you hold for "${manifest.publisher}" is revoked. Nothing signed by it can be installed.`,
    });
  }

  if (manifest.protocol > registry.protocol.speaks) {
    objections.push({
      kind: 'protocol',
      blocking: true,
      message:
        `Built for plugin protocol ${manifest.protocol}; this QAAI speaks ` +
        `${registry.protocol.speaks}. Ask the publisher for a current build.`,
    });
  } else if (manifest.protocol < registry.protocol.oldest) {
    objections.push({
      kind: 'protocol',
      blocking: true,
      message:
        `Built for plugin protocol ${manifest.protocol}, which this build no longer honours ` +
        `(the oldest is ${registry.protocol.oldest}).`,
    });
  }

  /*
   * The reserved list is served by the API, off the same constant the install
   * endpoint refuses on. Deriving it here from a hard-coded list of test types
   * would go stale the first time QAAI adds a twentieth one, and the screen
   * would then invite an install the server refuses.
   */
  if (registry.reservedNames.includes(manifest.name.toLowerCase())) {
    objections.push({
      kind: 'reserved-name',
      blocking: true,
      message: `"${manifest.name}" is the name of a plugin QAAI ships. Two plugins cannot claim it.`,
    });
  }

  const clash: InstalledPlugin | undefined = registry.plugins.find((p) => p.name === manifest.name);
  if (clash) {
    objections.push({
      kind: 'already-installed',
      blocking: true,
      message: `${manifest.name} is already installed at ${clash.version}. Uninstall it first.`,
    });
  }

  const digest = bundleSha256.trim().toLowerCase();
  if (digest && digest !== manifest.code.sha256.toLowerCase()) {
    objections.push({
      kind: 'digest-mismatch',
      blocking: true,
      message:
        'The file you downloaded is not the file that was signed. Discard it and fetch it ' +
        'again from the publisher directly.',
    });
  }

  const beyond = grants.filter((g) => g.beyondPlan).map((g) => g.info.label.toLowerCase());
  if (beyond.length > 0) {
    objections.push({
      kind: 'plan',
      blocking: true,
      message:
        `This asks for ${beyond.join(', ')}, and on ${registry.plan.label} there is no audit ` +
        `log to show you what it did with them.`,
    });
  }

  return {
    state: 'ready',
    document: parsed,
    grants,
    unrecognised,
    objections,
    signatureChecked: false,
  };
}

/** Whether Install should be offered at all, and the reason when it should not. */
export function blockingReason(preview: InstallPreview, bundleSha256: string): string | null {
  if (preview.state !== 'ready') return 'Paste the signed manifest the publisher gave you.';
  if (!bundleSha256.trim()) {
    return 'Enter the SHA-256 of the file you downloaded — `shasum -a 256` on the bundle.';
  }
  const blocker = preview.objections.find((o) => o.blocking);
  return blocker ? blocker.message : null;
}
