/**
 * The plugin manifest — the security boundary for code QAAI did not write.
 *
 * QAAI ships nineteen first-party runner plugins (packages/runner/src/plugins).
 * They are trusted because they are in this repository and went through this
 * repository's review. A customer-installed plugin has neither property: it
 * runs against the customer's application, with the customer's secrets within
 * reach, on infrastructure we operate. The only thing standing between those
 * two facts is this file.
 *
 * So the manifest is not metadata. It is a CONTRACT the publisher signs and we
 * refuse to install without, and it exists here — in @qaai/shared — rather than
 * in the API because the API decides whether a plugin may be installed and the
 * runner decides what its code may reach at execution time, and those two
 * decisions must be reading the same document. A second copy of "what does
 * `secrets` mean" is how a capability gets enforced on install and ignored at
 * run time.
 *
 * ─── The five things the manifest has to answer ──────────────────────────────
 *
 *   IDENTITY   name, version, publisher. The name is what collides with a
 *              first-party plugin, so it is checked against a reserved set
 *              rather than merely being unique per org.
 *   INTEGRITY  a SHA-256 of the code being installed, inside the signed body.
 *              The manifest is what the publisher vouches for; the hash is what
 *              ties that vouching to specific bytes.
 *   CAPABILITY what it will be able to reach. An install screen that cannot say
 *              this is a screen that teaches people to click Install without
 *              reading, so the vocabulary here is deliberately small and each
 *              entry carries the sentence a person is shown.
 *   COMPAT     which protocol version it targets. A plugin built for a contract
 *              this build no longer speaks is REFUSED with the version numbers
 *              in the message — not loaded and left to throw halfway through
 *              someone's nightly.
 *   PROVENANCE an Ed25519 signature over all of the above.
 *
 * ─── Why there is no "skip signature verification" option ────────────────────
 *
 * There is no flag, no env var and no boolean parameter anywhere in this module
 * that makes `evaluateInstall` return OK for an unverified manifest. A flag
 * would be worse than not signing at all, because it would be set: once by
 * someone debugging a publisher's CI at 6pm, and then forever, and the product
 * would still say "signature verified" on the install screen.
 *
 * The knob that does exist is which publishers an org trusts, and that is a
 * different question with a different answer — it is a deliberate, audited,
 * owner-only act with the key fingerprint on screen, not a switch that disables
 * a check. Trusting a publisher is a decision. Not checking is an accident.
 *
 * ─── Why this module is imported by path, not from the barrel ────────────────
 *
 * `packages/shared/src/index.ts` re-exports every other module in this package,
 * and this one is deliberately absent from it: the barrel is what the web app's
 * bundler consumes, and this file imports `node:crypto`. Consumers reach it by
 * relative path. If it is ever added to the barrel, the verification helpers
 * need to move behind a Node-only entry point first.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import { TEST_TYPES } from './constants';

// ─── Versions ────────────────────────────────────────────────────────────────

/** The manifest document format. Bumped only when the SHAPE below changes. */
export const PLUGIN_MANIFEST_SCHEMA = 'qaai.plugin/1';

/**
 * The runner contract this build speaks, and the oldest it still honours.
 *
 * Two numbers rather than one because they answer different questions. A
 * plugin targeting a HIGHER protocol was built against a contract that did not
 * exist when this build shipped — it may call a hook that is not there. A
 * plugin targeting a LOWER one was built against a contract this build has
 * since dropped. Both are refusals, and they are not the same refusal, so the
 * message says which.
 *
 * They are equal today because there has only ever been one contract. The pair
 * is here so the first bump is a one-line change with a correct error message
 * already written, rather than the moment somebody has to invent this logic
 * while a customer's install is failing.
 */
export const PLUGIN_PROTOCOL_VERSION = 1;
export const MIN_PLUGIN_PROTOCOL_VERSION = 1;

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * What a plugin can ask for. The whole vocabulary — there is no `*` and no
 * escape hatch, because a capability nobody can enumerate is a capability
 * nobody can refuse.
 */
/*
 * The vocabulary and its copy live in ./plugin-capabilities, which both this
 * module and the RUNNER's sandbox read. They used to be declared here as the
 * raw list a plugin might want — `network`, `page`, `filesystem`, `env`,
 * `secrets`, `subprocess` — while the sandbox granted only what it could
 * mediate. One word overlapped, so an install could be approved here and
 * refused on every run afterwards.
 */
import {
  PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_COPY,
  type PluginCapability,
} from './plugin-capabilities';

export {
  PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_COPY,
  REFUSED_CAPABILITIES,
  capabilityRefusal,
  isGrantableCapability,
  type PluginCapability,
  type CapabilityCopy,
} from './plugin-capabilities';


/**
 * Capabilities an org may only grant on a plan that includes the audit log.
 *
 * The reasoning is not "these are the expensive ones". It is that the entire
 * safety story for reading a project's secrets is *you can go and see what it
 * did afterwards* — and on a plan with no audit log there is nothing to go and
 * see. Selling a capability whose only control is a record the customer cannot
 * read would be selling them the risk without the control.
 *
 * `log`, `http` and `fixtures` are not on this list, and that is not a claim
 * that they are harmless: a plugin that can request the app under test and
 * write to the log can move what it reads into somewhere it can be collected.
 * They are excluded because a test plugin that can do none of the three cannot
 * do anything at all, so gating them would not be a control, it would be a ban.
 * What keeps those three honest is the runtime sandbox — QAAI makes the request
 * and holds the socket — not this list.
 */
export const GOVERNED_CAPABILITIES: readonly PluginCapability[] = ['secrets'];

export function isGovernedCapability(capability: PluginCapability): boolean {
  return GOVERNED_CAPABILITIES.includes(capability);
}

// ─── Reserved names ──────────────────────────────────────────────────────────

/**
 * Names a customer plugin may not take.
 *
 * Derived from `TEST_TYPES` rather than typed out, so a twentieth first-party
 * test type reserves its own name on the commit that adds it. The failure this
 * prevents is not cosmetic: the runner resolves a test's type to a plugin, and
 * an installed plugin called `e2e` sitting next to the built-in `e2e` is an
 * ambiguity resolved by whichever lookup happens to run first — which is to say
 * a third party deciding it executes your end-to-end suite.
 *
 * `external` and `matrix` are here by hand because they are plugin MODULES with
 * no test type of their own name (`external` backs INTEGRATION and UNIT_GEN;
 * `matrix` backs CROSS_BROWSER and LOCALIZATION).
 */
export const RESERVED_PLUGIN_NAMES: readonly string[] = [
  ...TEST_TYPES.map((type) => type.toLowerCase().replace(/_/g, '-')),
  'external',
  'matrix',
  'qaai',
];

/**
 * `qaai-anything` is reserved too. A plugin named `qaai-visual-pro` is a claim
 * about who wrote it, made in the one place a person actually reads.
 */
export function isReservedPluginName(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_PLUGIN_NAMES.includes(lower) || lower.startsWith('qaai-');
}

// ─── The document ────────────────────────────────────────────────────────────

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Plugin and publisher names alike: lowercase kebab and bounded.
 *
 * Exported because the API validates a publisher name people TYPE against the
 * same pattern a manifest's `publisher` field must satisfy. Two patterns would
 * let an org register "Acme", which can then never match a manifest signed as
 * "acme" — a trusted key that silently matches nothing.
 */
export const PLUGIN_SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Semver, with a prerelease tail allowed and build metadata deliberately not. */
const PLUGIN_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * The entry path inside the bundle.
 *
 * Relative, no `..`, no leading slash, no backslashes, and it must end in `.js`
 * or `.mjs`. This is checked on a SIGNED document by the API, which never opens
 * the file — so it is not the thing that stops a traversal. It is here so a
 * manifest that could only ever be a traversal attempt is refused before anyone
 * installs it, and so the runner is never handed `../../../etc/passwd` and left
 * to be the only line of defence.
 */
const ENTRY_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+\.m?js$/;

export const pluginManifestSchema = z
  .object({
    schema: z.literal(PLUGIN_MANIFEST_SCHEMA),
    name: z.string().min(2).max(40).regex(PLUGIN_SLUG, 'lowercase letters, digits and hyphens'),
    version: z.string().max(40).regex(PLUGIN_VERSION, 'must be a semantic version, e.g. 1.4.2'),
    publisher: z.string().min(2).max(40).regex(PLUGIN_SLUG, 'lowercase letters, digits and hyphens'),
    displayName: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400),
    homepage: z.string().url().startsWith('https://').max(300).optional(),
    protocol: z.number().int().min(0).max(1000),
    /*
     * `.min(1)`: a plugin declaring no capabilities at all is either lying or
     * useless, and both are worth a sentence at install time. `.max()` and the
     * dedupe below stop a manifest padding the screen until the dangerous row
     * scrolls off it.
     */
    capabilities: z
      .array(z.enum(PLUGIN_CAPABILITIES))
      .min(1)
      .max(PLUGIN_CAPABILITIES.length)
      .refine((list) => new Set(list).size === list.length, 'capabilities must not repeat'),
    code: z.object({
      sha256: z.string().regex(SHA256_HEX, 'must be 64 lowercase hex characters'),
      bytes: z.number().int().positive().max(64 * 1024 * 1024),
      entry: z.string().min(1).max(200).regex(ENTRY_PATH, 'must be a relative .js path in the bundle'),
    }),
  })
  .strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const pluginSignatureSchema = z
  .object({
    /*
     * One algorithm, named rather than assumed. A signature block with no
     * algorithm field cannot be rotated without a flag day; a signature block
     * that accepts several is a downgrade attack waiting for the weakest.
     * `z.literal` means adding a second one is a deliberate edit here.
     */
    algorithm: z.literal('ed25519'),
    /** base64 of the 64-byte detached signature. */
    value: z.string().min(1).max(200),
  })
  .strict();

export type PluginSignature = z.infer<typeof pluginSignatureSchema>;

// ─── Canonicalisation ────────────────────────────────────────────────────────

/**
 * The exact bytes that get signed.
 *
 * `JSON.stringify` is not enough: it preserves insertion order, so a manifest
 * that round-trips through any tool that reorders keys — a formatter, a YAML
 * conversion, Postgres `jsonb`, which does not preserve order at all — produces
 * a different string and a signature that no longer verifies. Since we store
 * the manifest as JSON and re-verify from storage, that is not a hypothetical.
 *
 * Sorted keys, no whitespace, arrays left in order (an array's order is part of
 * its meaning). Anything that cannot be represented deterministically throws
 * rather than being coerced, because the failure mode of a lenient
 * canonicaliser is two different documents with one signature.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJson: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      // Dropped, not serialised: `{a: undefined}` and `{}` are the same
      // document to every JSON reader, so they must sign identically.
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }

  throw new Error(`canonicalJson: cannot canonicalise ${type}`);
}

/** The signed message. Every field of the manifest, and nothing else. */
export function manifestSigningInput(manifest: PluginManifest): Buffer {
  return Buffer.from(canonicalJson(manifest), 'utf8');
}

// ─── Publisher keys ──────────────────────────────────────────────────────────

/** SPKI DER prefix for an Ed25519 public key: 12 bytes, then the raw 32. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_RAW_BYTES = 32;

/**
 * A publisher's public key, from whatever the person pasting it happened to
 * have, normalised to the raw 32 bytes.
 *
 * Both forms are accepted because both are what real tools emit: `openssl` and
 * Node's `KeyObject.export({ type: 'spki' })` give the 44-byte DER, while every
 * document that writes an Ed25519 key inline writes the raw 32. Rejecting one
 * of them would mean the publisher onboarding step is "convert your key",
 * performed by hand, on the value that decides what code we will trust.
 *
 * Returns null rather than throwing: this parses input from a form.
 */
export function normalizePublisherKey(base64: string): Buffer | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(base64.trim(), 'base64');
  } catch {
    return null;
  }

  if (raw.length === ED25519_RAW_BYTES) return raw;

  if (
    raw.length === ED25519_SPKI_PREFIX.length + ED25519_RAW_BYTES &&
    raw.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return raw.subarray(ED25519_SPKI_PREFIX.length);
  }

  return null;
}

/**
 * What a human compares against the publisher's website.
 *
 * Grouped in fours because the whole point is that somebody reads it out loud
 * or scans it against another screen, and 64 unbroken hex characters is a
 * string people confirm without checking.
 */
export function publisherKeyFingerprint(rawKey: Buffer): string {
  const digest = createHash('sha256').update(rawKey).digest('hex');
  return (digest.slice(0, 32).match(/.{4}/g) ?? []).join('-');
}

/**
 * Ed25519 verification. False on anything malformed, never a throw.
 *
 * Signature verification is called with attacker-influenced bytes by
 * definition, so a corrupt key or a 3-byte signature has to be a refusal rather
 * than a 500 — a crash here is a denial-of-service on the install endpoint, and
 * an exception escaping into a `catch` somewhere upstream is how "verification
 * failed" turns into "verification skipped".
 */
export function verifyManifestSignature(
  manifest: PluginManifest,
  signature: PluginSignature,
  rawPublicKey: Buffer,
): boolean {
  if (rawPublicKey.length !== ED25519_RAW_BYTES) return false;

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: 'der',
      type: 'spki',
    });
    const sig = Buffer.from(signature.value, 'base64');
    // Ed25519 signatures are fixed-width. Checking here means a truncated or
    // padded value is a clean false instead of relying on the provider.
    if (sig.length !== 64) return false;
    return verifySignature(null, manifestSigningInput(manifest), key, sig);
  } catch {
    return false;
  }
}

/** SHA-256 of the bundle bytes, in the lowercase hex the manifest carries. */
export function bundleDigest(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ─── The verdict ─────────────────────────────────────────────────────────────

/**
 * Every way an install can be refused.
 *
 * A closed union, so a new refusal is a compile error everywhere that renders
 * one rather than an unlabelled row on the install screen.
 */
export type PluginRefusalCode =
  | 'MANIFEST_MALFORMED'
  | 'UNKNOWN_PUBLISHER'
  | 'PUBLISHER_REVOKED'
  | 'SIGNATURE_INVALID'
  | 'PROTOCOL_TOO_NEW'
  | 'PROTOCOL_TOO_OLD'
  | 'RESERVED_NAME'
  | 'HASH_MISMATCH'
  | 'CAPABILITY_NOT_IN_PLAN';

export interface PluginRefusal {
  ok: false;
  code: PluginRefusalCode;
  /**
   * Addressed to the person who tried to install it and said in full: what was
   * refused, why, and what would make it work. "Install failed" is not an error
   * message — it teaches the reader that the check is noise and the next step
   * is to retry, which is exactly wrong when the reason is a bad signature.
   */
  message: string;
  /** Machine-readable specifics for the screen and for the audit row. */
  detail?: Record<string, unknown>;
}

export interface PluginApproval {
  ok: true;
  manifest: PluginManifest;
  /** Capabilities the org's plan had to permit. Recorded on the install row. */
  governed: PluginCapability[];
}

export type PluginVerdict = PluginRefusal | PluginApproval;

/** The trusted publisher this org has on file, as the caller read it back. */
export interface TrustedPublisher {
  publisherId: string;
  /** Normalised raw 32 bytes. */
  publicKey: Buffer;
  revokedAt: Date | null;
}

export interface InstallCandidate {
  /** Straight off the wire — shape is this function's problem, not the caller's. */
  manifest: unknown;
  signature: PluginSignature;
  /**
   * SHA-256 of the bytes the installer actually obtained, hex.
   *
   * Compared against the hash inside the SIGNED manifest. What that catches is
   * a download that does not match what the publisher vouched for: a mirror
   * serving something else, a CDN object replaced after the manifest was
   * published, a proxy rewriting the response. It is not a defence against the
   * installer themselves, who could send any digest they like — they are an
   * admin of this org choosing to install this thing. The check that binds
   * bytes to manifest for the code that actually EXECUTES is the runner's, at
   * load time, against the hash stored here.
   */
  bundleSha256: string;
  /** null when this org trusts no publisher by that name. */
  publisher: TrustedPublisher | null;
  plan: {
    /** "Team", "Business" — used verbatim in the refusal. */
    label: string;
    /** Whether this plan may grant GOVERNED_CAPABILITIES. */
    allowsGovernedCapabilities: boolean;
  };
}

const refuse = (
  code: PluginRefusalCode,
  message: string,
  detail?: Record<string, unknown>,
): PluginRefusal => ({ ok: false, code, message, ...(detail ? { detail } : {}) });

/**
 * The whole install decision, in one pure function.
 *
 * One function on purpose. Spread across a handler, these checks are seven
 * independent `if`s that a later endpoint — a bulk install, a re-verify sweep,
 * an upgrade path — reimplements six of. That is the shape of every "the check
 * was there, on the other route" incident. A caller that wants to install a
 * plugin has to obtain a `PluginApproval`, and the only way to get one is here.
 *
 * ─── The order is load-bearing ───────────────────────────────────────────────
 *
 * Shape, then publisher, then SIGNATURE, then everything else. After step three
 * every fact the later steps report — the protocol number, the name, the hash,
 * the capability list — is a fact a known publisher put their key behind. Check
 * the capability set first and you are quoting an attacker's JSON back to the
 * user inside a sentence that sounds like the product vouching for it.
 *
 * "Then publisher" is two questions, not one: is there a trusted row, and is it
 * the row for the publisher THIS MANIFEST NAMES. The second was missing, and
 * without it step three verifies a signature under whatever key the caller
 * passed while step four onwards prints the name the manifest claimed. See the
 * comment on the check itself.
 */
export function evaluateInstall(candidate: InstallCandidate): PluginVerdict {
  const parsed = pluginManifestSchema.safeParse(candidate.manifest);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? first.path.join('.') : 'manifest';
    return refuse(
      'MANIFEST_MALFORMED',
      `This is not a ${PLUGIN_MANIFEST_SCHEMA} manifest: ${where} ${first?.message ?? 'is invalid'}.`,
      { field: where },
    );
  }
  const manifest = parsed.data;

  const publisher = candidate.publisher;
  if (!publisher) {
    return refuse(
      'UNKNOWN_PUBLISHER',
      `Nobody has told this organisation to trust the publisher "${manifest.publisher}". ` +
        `Add their signing key under Trusted publishers — confirm the fingerprint against ` +
        `their own site first — and install again.`,
      { publisher: manifest.publisher },
    );
  }
  /*
   * The row the caller read back must be the publisher the MANIFEST names.
   *
   * Every check after this one is "does this signature verify under
   * `publisher.publicKey`", and the sentence that result is reported in says
   * `manifest.publisher`. Nothing tied those two together: hand this function a
   * manifest claiming `acme` alongside the trusted-publisher row for `evilcorp`
   * and it verifies evilcorp's signature, approves the install, and prints
   * acme's name while doing it.
   *
   * Not reachable through POST /plugins today — that route looks the row up BY
   * `manifest.publisher`, so the pair always matches — which is exactly why it
   * has to be asserted HERE. This is a pure function whose whole reason for
   * existing (see the docblock) is that the next caller, the bulk installer or
   * the re-verify sweep, does not get to reimplement six of seven checks. A
   * precondition that only holds because of how today's single caller happens
   * to query is not a precondition, it is a coincidence.
   *
   * Reported as UNKNOWN_PUBLISHER rather than as a new code, and the code is
   * accurate: nobody has told this organisation to trust the publisher this
   * manifest names. The `detail` carries both ids so an operator reading the
   * audit row can see it was a mismatched pair rather than an absent one.
   */
  if (publisher.publisherId !== manifest.publisher) {
    return refuse(
      'UNKNOWN_PUBLISHER',
      `This manifest is published by "${manifest.publisher}", but the signing key offered for ` +
        `it belongs to "${publisher.publisherId}". A key vouches only for its own publisher. ` +
        `Add "${manifest.publisher}"'s key under Trusted publishers — confirm the fingerprint ` +
        `against their own site first — and install again.`,
      { publisher: manifest.publisher, offeredKeyFor: publisher.publisherId },
    );
  }

  if (publisher.revokedAt) {
    return refuse(
      'PUBLISHER_REVOKED',
      `The signing key for "${manifest.publisher}" was revoked on ` +
        `${publisher.revokedAt.toISOString().slice(0, 10)}. Nothing signed by it can be ` +
        `installed. If they have rotated keys, add the new one.`,
      { publisher: manifest.publisher, revokedAt: publisher.revokedAt.toISOString() },
    );
  }

  if (!verifyManifestSignature(manifest, candidate.signature, publisher.publicKey)) {
    return refuse(
      'SIGNATURE_INVALID',
      `The signature does not match this manifest under "${manifest.publisher}"’s key ` +
        `(${publisherKeyFingerprint(publisher.publicKey)}). Either the manifest was altered ` +
        `after it was signed, or it was signed by a different key. Do not install it.`,
      {
        publisher: manifest.publisher,
        fingerprint: publisherKeyFingerprint(publisher.publicKey),
      },
    );
  }

  // ── Everything below is signed content ──────────────────────────────────

  if (manifest.protocol > PLUGIN_PROTOCOL_VERSION) {
    return refuse(
      'PROTOCOL_TOO_NEW',
      `${manifest.displayName} targets plugin protocol ${manifest.protocol} and this build of ` +
        `QAAI speaks ${PLUGIN_PROTOCOL_VERSION}. Upgrade QAAI, or ask ${manifest.publisher} for ` +
        `a build targeting ${PLUGIN_PROTOCOL_VERSION}.`,
      { targets: manifest.protocol, supported: PLUGIN_PROTOCOL_VERSION },
    );
  }
  if (manifest.protocol < MIN_PLUGIN_PROTOCOL_VERSION) {
    return refuse(
      'PROTOCOL_TOO_OLD',
      `${manifest.displayName} targets plugin protocol ${manifest.protocol}, which this build no ` +
        `longer honours (the oldest is ${MIN_PLUGIN_PROTOCOL_VERSION}). Ask ${manifest.publisher} ` +
        `for a current build.`,
      { targets: manifest.protocol, oldestSupported: MIN_PLUGIN_PROTOCOL_VERSION },
    );
  }

  if (isReservedPluginName(manifest.name)) {
    return refuse(
      'RESERVED_NAME',
      `"${manifest.name}" is the name of a plugin QAAI ships. A third-party plugin cannot take ` +
        `it — tests of that type would have two plugins claiming them. Ask ` +
        `${manifest.publisher} to publish under a different name.`,
      { name: manifest.name },
    );
  }

  if (candidate.bundleSha256 !== manifest.code.sha256) {
    return refuse(
      'HASH_MISMATCH',
      `The code you downloaded is not the code ${manifest.publisher} signed. The manifest says ` +
        `sha256:${manifest.code.sha256.slice(0, 12)}… and the bundle is ` +
        `sha256:${candidate.bundleSha256.slice(0, 12)}…. Discard it and fetch it again from ` +
        `the publisher directly.`,
      { expected: manifest.code.sha256, actual: candidate.bundleSha256 },
    );
  }

  const governed = manifest.capabilities.filter(isGovernedCapability);
  if (governed.length > 0 && !candidate.plan.allowsGovernedCapabilities) {
    const named = governed.map((c) => PLUGIN_CAPABILITY_COPY[c].label.toLowerCase());
    return refuse(
      'CAPABILITY_NOT_IN_PLAN',
      `${manifest.displayName} asks for ${named.join(', ')}, and on ${candidate.plan.label} ` +
        `there is no audit log to show you what it did with them. Upgrade to a plan with the ` +
        `audit log, or install a build of this plugin that does not ask for them.`,
      { capabilities: governed, plan: candidate.plan.label },
    );
  }

  return { ok: true, manifest, governed };
}
