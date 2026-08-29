/**
 * Closing the loop between the plugin registry and a run.
 *
 * Until this file existed, `prisma.plugin`, `prisma.pluginEnablement` and
 * `prisma.pluginPublisher` were read by exactly one place in the repository —
 * the settings API that writes them. An org could trust a publisher, install a
 * signed plugin, enable it on a project, watch the screen say so, and no run
 * would ever look. The registry was a filing cabinet.
 *
 * This module is the read side. It is deliberately the ONLY place in the worker
 * that knows the registry exists, and it hands the run loop two things:
 *
 *   `byType`      the plugins a run may route a test to, keyed by test type.
 *   `admissions`  one row per enabled plugin saying whether it was admitted and,
 *                 when it was not, the sentence that says why.
 *
 * ─── What is honestly possible today, and what is not ────────────────────────
 *
 * `byType` is, on the current schema, ALWAYS EMPTY, and that is not a bug in
 * this file — it is the finding. Two things the runtime needs have no source in
 * what an install records:
 *
 *   THE CODE.      `Plugin` stores `codeSha256`, `codeBytes` and `codeEntry` —
 *                  a description of a bundle — and no bundle. There is no blob
 *                  column, no object-storage key, and no fetch URL anywhere in
 *                  the install path (apps/api/src/routes/plugins.ts never sees
 *                  the bytes; it is handed a digest of them). So there is
 *                  nothing to hash and nothing to execute.
 *   THE TEST TYPE. `pluginManifestSchema` is `.strict()` and has no field
 *                  naming a `TestType`. A plugin therefore cannot say which
 *                  tests it is for, and the runner cannot invent one.
 *
 * Fixing either is a schema change, which this wave does not do. So rather than
 * a code path that pretends to load, every enabled plugin is put through the
 * verification that IS possible — and all of it is real, because the install
 * stored the evidence for exactly this purpose — and then refused with a
 * sentence naming the gap. `admitPlugin` is where that happens.
 *
 * The verification is worth having on its own. The manifest and its detached
 * signature are kept verbatim precisely so they can be re-checked away from the
 * endpoint that accepted them, and re-checking them here catches the cases the
 * install-time check cannot: a publisher key revoked after the install, a
 * manifest row edited in the database afterwards, a convenience column drifted
 * from the signed document.
 *
 * ─── Two rules that do not bend ──────────────────────────────────────────────
 *
 *  · A PLUGIN PROBLEM IS NEVER THE CUSTOMER'S PROBLEM. Nothing in here throws
 *    at the run loop. A refused plugin, a registry that cannot be read, a row
 *    whose shape changed under us — all of them come back as an admission with
 *    a fault on it, the run proceeds, and the application under test is not
 *    blamed for any of it.
 *  · A FIRST-PARTY TEST TYPE CANNOT BE SHADOWED. `resolveTestPlugin` asks the
 *    built-in registry first and only consults installed plugins for a type it
 *    answers `null` for. Not "prefer" — the installed map is never even
 *    consulted for a type QAAI implements.
 */

import { pluginFor } from '@qaai/runner';
import type { PluginFault, PluginFaultKind } from '@qaai/runner';
import type { RunnerPlugin, TestType } from '@qaai/shared';
/*
 * By path, for the reason apps/api/src/routes/plugins.ts is: `plugin-manifest`
 * is deliberately absent from @qaai/shared's barrel because it imports
 * node:crypto and the barrel is what the web app's bundler consumes. Until it
 * has an export entry of its own, the honest import is the relative one.
 */
import {
  MIN_PLUGIN_PROTOCOL_VERSION,
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_PROTOCOL_VERSION,
  isReservedPluginName,
  normalizePublisherKey,
  pluginManifestSchema,
  publisherKeyFingerprint,
  verifyManifestSignature,
} from '../../../../packages/shared/src/plugin-manifest.js';

// ─── What the registry hands us ──────────────────────────────────────────────

/**
 * One enabled plugin, as read back.
 *
 * A structural type rather than Prisma's generated one so this module can be
 * exercised against a fake and so a column that disappears is a compile error
 * here rather than an `undefined` three frames away.
 */
export interface EnabledPluginRow {
  orgId: string;
  projectId: string;
  plugin: {
    id: string;
    orgId: string;
    name: string;
    version: string;
    publisher: string;
    protocol: number;
    capabilities: string[];
    codeSha256: string;
    codeBytes: number;
    codeEntry: string;
    /** The verified manifest, verbatim. Re-parsed, never trusted by shape. */
    manifest: unknown;
    /** base64 of the detached Ed25519 signature over the manifest. */
    signature: string;
    publisherRow: {
      orgId: string;
      publisherId: string;
      /** base64 of the raw 32-byte key. */
      publicKey: string;
      revokedAt: Date | null;
    } | null;
  };
}

/**
 * The columns this module needs, named once.
 *
 * Exported so the test asserts the query asks for the manifest and the
 * signature — the two the re-verification is made of. A select that quietly
 * stopped fetching them would leave every plugin refused for the wrong reason.
 */
export const ENABLED_PLUGIN_SELECT = {
  orgId: true,
  projectId: true,
  plugin: {
    select: {
      id: true,
      orgId: true,
      name: true,
      version: true,
      publisher: true,
      protocol: true,
      capabilities: true,
      codeSha256: true,
      codeBytes: true,
      codeEntry: true,
      manifest: true,
      signature: true,
      publisherRow: {
        select: { orgId: true, publisherId: true, publicKey: true, revokedAt: true },
      },
    },
  },
} as const;

/**
 * The narrowest client this module can work against.
 *
 * Declared with method syntax on purpose: Prisma's `findMany` is a method, and
 * a property-typed function would be checked contravariantly and refuse the
 * real client.
 */
export interface PluginRegistryReader {
  pluginEnablement: {
    findMany(args: {
      where: {
        orgId: string;
        projectId: string;
        enabled: boolean;
        plugin: { orgId: string };
      };
      select: typeof ENABLED_PLUGIN_SELECT;
    }): Promise<unknown[]>;
  };
}

// ─── Admissions ──────────────────────────────────────────────────────────────

/** One enabled plugin's verdict. `fault === null` means it may run. */
export interface PluginAdmission {
  pluginId: string;
  /** `name@version`, or a phrase when the row could not be identified. */
  label: string;
  publisher: string;
  fault: PluginFault | null;
}

export interface ProjectPlugins {
  /**
   * Installed plugins by the test type they answer for. Always empty today —
   * see the header. Kept as a map rather than removed because the resolution
   * order in `resolveTestPlugin` is the thing that must be right, and an
   * ordering nothing exercises is an ordering nobody notices reversing.
   */
  byType: ReadonlyMap<TestType, RunnerPlugin>;
  admissions: readonly PluginAdmission[];
}

const NO_PLUGINS: ProjectPlugins = { byType: new Map(), admissions: [] };

function fault(kind: PluginFaultKind, message: string): PluginFault {
  return { kind, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function shortDigest(hex: string): string {
  return `sha256:${hex.slice(0, 12)}…`;
}

/**
 * Whether one enabled plugin may run, and if not, the sentence that says why.
 *
 * ─── The order is load-bearing ───────────────────────────────────────────────
 *
 * Provenance first — publisher, then signature — then everything the signature
 * covers, then the integrity anchor, and only after all of that anything about
 * loading. Reversed, the refusals would quote fields off a document nobody has
 * established anyone signed, inside sentences that sound like QAAI vouching for
 * them. It is the same order `evaluateInstall` uses, for the same reason, and
 * the two must not drift: this is the SECOND time the same document is judged,
 * and a second opinion that applies different rules is not a check, it is a
 * coin toss.
 *
 * The integrity comparison sits ahead of every "can we load this" question so
 * that the digest is settled before anything downstream could ever be tempted
 * to touch bytes. Today nothing downstream touches bytes at all, which makes
 * the ordering free — and free is exactly when to establish it, rather than on
 * the day a bundle store lands and somebody has to remember.
 */
export function admitPlugin(row: EnabledPluginRow): PluginAdmission {
  const plugin = row.plugin;
  const label = `${plugin.name}@${plugin.version}`;
  const verdict = (f: PluginFault | null): PluginAdmission => ({
    pluginId: plugin.id,
    label,
    publisher: plugin.publisher,
    fault: f,
  });

  /*
   * The enablement row, the plugin row and the publisher row must all name the
   * same org. Two of the three are already filtered in the query; this is the
   * third, and it is here rather than in the `where` because a publisher row
   * that belongs to somebody else is not "no results", it is a fact worth
   * saying out loud.
   */
  const publisherRow = plugin.publisherRow;
  if (!publisherRow) {
    return verdict(
      fault(
        'LOAD_ERROR',
        `${label} has no publisher row, so nothing can say who signed it. Nothing was executed.`,
      ),
    );
  }
  if (publisherRow.orgId !== row.orgId || plugin.orgId !== row.orgId) {
    return verdict(
      fault(
        'LOAD_ERROR',
        `${label} is enabled for an organisation that does not own it. Nothing was executed.`,
      ),
    );
  }

  if (publisherRow.revokedAt) {
    return verdict(
      fault(
        'LOAD_ERROR',
        `the signing key for "${publisherRow.publisherId}" was revoked on ` +
          `${publisherRow.revokedAt.toISOString().slice(0, 10)}, and ${label} is still installed ` +
          `and still enabled. QAAI will not run code whose provenance it can no longer check. ` +
          `Nothing was executed.`,
      ),
    );
  }

  const parsed = pluginManifestSchema.safeParse(plugin.manifest);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? first.path.join('.') : 'manifest';
    return verdict(
      fault(
        'BAD_SHAPE',
        `the manifest stored for ${label} is no longer a ${PLUGIN_MANIFEST_SCHEMA} document ` +
          `(${where} ${first?.message ?? 'is invalid'}). It was one when it was installed, so ` +
          `the row has changed since. Nothing was executed.`,
      ),
    );
  }
  const manifest = parsed.data;

  const publicKey = normalizePublisherKey(publisherRow.publicKey);
  if (!publicKey) {
    return verdict(
      fault(
        'LOAD_ERROR',
        `the stored public key for "${publisherRow.publisherId}" is not an Ed25519 key, so ` +
          `${label}'s signature cannot be checked against anything. Nothing was executed.`,
      ),
    );
  }

  if (
    !verifyManifestSignature(
      manifest,
      { algorithm: 'ed25519', value: plugin.signature },
      publicKey,
    )
  ) {
    return verdict(
      fault(
        'LOAD_ERROR',
        `${label}'s stored signature no longer verifies under "${publisherRow.publisherId}"'s ` +
          `key (${publisherKeyFingerprint(publicKey)}). Either the manifest row was altered ` +
          `after it was installed or the key on file is not the one that signed it. Nothing ` +
          `was executed.`,
      ),
    );
  }

  // ── Everything below is signed content ────────────────────────────────────

  if (manifest.name !== plugin.name || manifest.version !== plugin.version) {
    return verdict(
      fault(
        'LOAD_ERROR',
        `the row calls this plugin ${label} and the signed manifest calls it ` +
          `${manifest.name}@${manifest.version}. The columns are a convenience copy of the ` +
          `manifest and they have drifted from it. Nothing was executed.`,
      ),
    );
  }

  /*
   * THE integrity anchor, checked before anything that could lead to execution.
   *
   * There are two digests in play and they are not the same kind of thing.
   * `manifest.code.sha256` is inside the document the publisher signed, so it
   * is the one with provenance; `Plugin.codeSha256` is a column copied from it
   * at install for querying. When they disagree there is no single value to
   * verify bytes against, and "pick one" is how a verification step starts
   * passing on everything.
   */
  if (manifest.code.sha256 !== plugin.codeSha256) {
    return verdict(
      fault(
        'HASH_MISMATCH',
        `the manifest ${manifest.publisher} signed records ${shortDigest(manifest.code.sha256)} ` +
          `for ${label}'s code and the installed row records ${shortDigest(plugin.codeSha256)}. ` +
          `The two disagree, so there is no digest QAAI could verify code against. Nothing ` +
          `was executed.`,
      ),
    );
  }

  if (manifest.protocol > PLUGIN_PROTOCOL_VERSION || manifest.protocol < MIN_PLUGIN_PROTOCOL_VERSION) {
    return verdict(
      fault(
        'LOAD_ERROR',
        `${label} targets plugin protocol ${manifest.protocol} and this worker speaks ` +
          `${MIN_PLUGIN_PROTOCOL_VERSION}–${PLUGIN_PROTOCOL_VERSION}. It was installed against ` +
          `a contract this build no longer honours. Nothing was executed.`,
      ),
    );
  }

  /*
   * Checked again here, and not because the install path forgot to: it did not
   * (`evaluateInstall` refuses a reserved name). It is repeated because THIS is
   * the moment a name would decide which code answers for a test type, the
   * install ran under a different build of that reserved list, and a row can
   * reach this table by means other than that endpoint. A guarantee stated at
   * the door and never re-stated at the thing it protects is a guarantee that
   * survives exactly as long as the door.
   */
  if (isReservedPluginName(manifest.name)) {
    return verdict(
      fault(
        'LOAD_ERROR',
        `"${manifest.name}" is a name QAAI reserves for the plugins it ships. An installed ` +
          `plugin may not answer for a first-party test type. Nothing was executed.`,
      ),
    );
  }

  /*
   * Verified, and still unrunnable. Both halves of this sentence are load
   * bearing: the customer is told their plugin's provenance checked out, so
   * they do not go looking for a signing problem, and then told exactly which
   * two things QAAI does not have. It ends by taking the blame, because this is
   * a gap in QAAI and the message will be read by somebody deciding whether
   * their vendor shipped something broken.
   */
  return verdict(
    fault(
      'MISSING_ENTRY',
      `${label} is installed, enabled, and its signature verifies under ` +
        `"${publisherRow.publisherId}" (${publisherKeyFingerprint(publicKey)}) — and QAAI ` +
        `still cannot run it. The registry records the manifest and nothing else: there are no ` +
        `bundle bytes and no location to fetch "${plugin.codeEntry}" ` +
        `(${plugin.codeBytes} bytes, ${shortDigest(manifest.code.sha256)}) from, so there is ` +
        `nothing to verify against that digest; and a ${PLUGIN_MANIFEST_SCHEMA} manifest names ` +
        `no test type, so there is no test QAAI could route to it. Nothing was executed. This ` +
        `is a gap in QAAI, not a fault in ${label}.`,
    ),
  );
}

// ─── Reading the registry ────────────────────────────────────────────────────

/**
 * Every plugin enabled for THIS project in THIS org, judged.
 *
 * Four filters, and each one is a different way of getting it wrong:
 * `orgId` on the enablement, `projectId`, `enabled: true` — absence of a row
 * means off, and so does a row that says false — and `plugin: { orgId }`, which
 * is the one that is not redundant. The worker's Prisma client carries NO
 * tenancy extension (see context.ts: it drains every org's jobs), so nothing
 * else in this process would notice an enablement row pointing at another org's
 * plugin.
 *
 * Never throws. A registry that cannot be read is reported as one admission
 * with a fault on it and the run continues: the alternative is a database blip
 * in a feature the customer may not even use turning their suite red.
 */
export async function loadProjectPlugins(
  db: PluginRegistryReader,
  scope: { orgId: string; projectId: string },
): Promise<ProjectPlugins> {
  let rows: unknown[];
  try {
    rows = await db.pluginEnablement.findMany({
      where: {
        orgId: scope.orgId,
        projectId: scope.projectId,
        enabled: true,
        plugin: { orgId: scope.orgId },
      },
      select: ENABLED_PLUGIN_SELECT,
    });
  } catch (err) {
    return {
      byType: new Map(),
      admissions: [
        {
          pluginId: '',
          label: 'the plugin registry',
          publisher: '',
          fault: fault(
            'LOAD_ERROR',
            `QAAI could not read which plugins are enabled for this project, so it ran none of ` +
              `them: ${err instanceof Error ? err.message : String(err)}. The suite itself was ` +
              `not affected.`,
          ),
        },
      ],
    };
  }

  if (rows.length === 0) return NO_PLUGINS;

  const admissions: PluginAdmission[] = [];
  for (const row of rows) {
    // A row whose shape is not what the select asked for is a fault, not a
    // crash: this loop is the last thing standing between a schema drift and a
    // TypeError inside somebody's run.
    if (!isRecord(row) || !isRecord(row.plugin)) {
      admissions.push({
        pluginId: '',
        label: 'an enabled plugin',
        publisher: '',
        fault: fault(
          'BAD_SHAPE',
          'an enablement row came back without the plugin it enables, so QAAI could not ' +
            'identify it. Nothing was executed.',
        ),
      });
      continue;
    }
    admissions.push(admitPlugin(row as unknown as EnabledPluginRow));
  }

  /*
   * `byType` stays empty: `admitPlugin` cannot return an admitted plugin on
   * this schema, and building the map from a fault would be the pretence this
   * module exists not to commit. When a bundle store and a manifest test-type
   * field land, this is the line that changes.
   */
  return { byType: new Map(), admissions };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * The plugin that will execute a test of this type — first-party first, always.
 *
 * Not a merged map with a preference, and not `installed.get(type) ??
 * pluginFor(type)`. The built-in registry is asked first and the installed map
 * is not consulted at all for a type it answers, so there is no arrangement of
 * registry rows that can put third-party code in front of `e2ePlugin`. The
 * install path already refuses a plugin NAMED after a first-party type, and
 * `admitPlugin` refuses it a second time; this is the third and last line, and
 * it is the only one that is not a name comparison — it is structural.
 *
 * Worth stating plainly, because it is the current shape of the feature: every
 * one of the nineteen members of `TEST_TYPES` has a first-party plugin
 * (packages/runner/src/registry.ts, `UNIMPLEMENTED_TYPES` is empty). So even if
 * `byType` could be populated, this function would never reach it. An installed
 * plugin can only become reachable by QAAI adding a test type it does not
 * itself implement.
 */
export function resolveTestPlugin(type: TestType, project: ProjectPlugins): RunnerPlugin | null {
  const firstParty = pluginFor(type);
  if (firstParty) return firstParty;
  return project.byType.get(type) ?? null;
}
