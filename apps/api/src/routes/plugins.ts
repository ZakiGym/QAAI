/**
 * The plugin registry (§4) — install, uninstall, and per-project enablement of
 * code QAAI did not write.
 *
 * Everything this router refuses, it refuses in one place: `evaluateInstall` in
 * @qaai/shared. That is deliberate and it is the whole design. Spread across
 * this file, the seven install checks would be seven independent `if`s, and the
 * next endpoint that wants to install a plugin — a bulk import, an upgrade
 * path, a CLI — would reimplement six of them and forget the seventh. Here,
 * the only way to obtain a `PluginApproval` is to have passed all of them, and
 * the type system says so.
 *
 * ─── The three verbs, and why they are three ─────────────────────────────────
 *
 *   TRUST an org decides a publisher's signing key is really theirs. This is
 *         the security decision in the feature and the only one that cannot be
 *         made by looking at the artifact: it is a claim about the world, and
 *         somebody has to check the fingerprint against the publisher's own
 *         site. Nothing ships pre-trusted, so a fresh install can install
 *         nothing at all until a human does this.
 *   INSTALL a verified plugin is recorded for the org. It does not run.
 *   ENABLE  it is allowed to run against one project. Absence of a row means
 *           off, so a plugin never becomes live on a project created later.
 *
 * Collapsing INSTALL and ENABLE would make "install" mean "start running this
 * against every application I have", which is a much larger act than the word
 * suggests, and would leave no way to take a plugin off production while
 * keeping it on staging — the exact move somebody makes at 2am.
 *
 * ─── Roles ───────────────────────────────────────────────────────────────────
 *
 * Reads are open to any member; every mutation is ADMIN, enablement included.
 * Enabling a plugin that has asked for `secrets` on the production project is
 * not an editing action, and MEMBER is the role we hand to people who write
 * tests. The gate is on the write, not on the read, because hiding the list
 * from members would mean the people whose runs execute this code cannot see
 * what is in them.
 *
 * ─── Why the shared module is imported by path ───────────────────────────────
 *
 * `@qaai/shared`'s package exports map lists only `.` and `./constants`, and
 * `plugin-manifest` is deliberately not in the barrel — it imports node:crypto
 * and the barrel is what the web app's bundler consumes. Until it has an entry
 * of its own, the honest import is the relative one. Every real execution path
 * here (tsx in the Dockerfile, vitest, tsc) resolves it.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  MIN_PLUGIN_PROTOCOL_VERSION,
  PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_COPY,
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_SLUG,
  RESERVED_PLUGIN_NAMES,
  evaluateInstall,
  isGovernedCapability,
  normalizePublisherKey,
  pluginSignatureSchema,
  publisherKeyFingerprint,
  type PluginRefusal,
  type PluginRefusalCode,
} from '../../../../packages/shared/src/plugin-manifest.js';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.js';
import { planFor } from '../lib/plan.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const pluginsRouter: Router = Router();

pluginsRouter.use(requireAuth);

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * Which HTTP status each refusal deserves.
 *
 * Three buckets, and the distinction is not decoration — the screen renders a
 * different thing for each. 400 means "you sent nonsense". 422 means "your
 * request was fine and this ARTEFACT is not acceptable", which is every
 * provenance and compatibility failure and the only bucket where the right
 * next step is to go back to the publisher. 402 means "buy something", and is
 * the one case where retrying identically could ever work.
 *
 * A `Record` keyed on the union rather than a switch with a default: a new
 * refusal code is then a compile error here instead of quietly falling into
 * whichever status the default happened to be.
 */
const REFUSAL_STATUS: Record<PluginRefusalCode, number> = {
  MANIFEST_MALFORMED: 400,
  UNKNOWN_PUBLISHER: 422,
  PUBLISHER_REVOKED: 422,
  SIGNATURE_INVALID: 422,
  PROTOCOL_TOO_NEW: 422,
  PROTOCOL_TOO_OLD: 422,
  RESERVED_NAME: 422,
  HASH_MISMATCH: 422,
  CAPABILITY_NOT_IN_PLAN: 402,
};

/**
 * The refusal, as an ApiError, with the reason in `code` rather than buried in
 * prose. "PLUGIN_REFUSED" alone would leave the UI with one bucket and the
 * customer with one sentence, and the entire point of enumerating these is that
 * a bad signature and an unpaid plan need different screens.
 */
function refusalError(refusal: PluginRefusal): ApiError {
  return new ApiError(
    REFUSAL_STATUS[refusal.code],
    refusal.code,
    refusal.message,
    refusal.detail,
  );
}

// ─── Input ───────────────────────────────────────────────────────────────────

const slug = z.string().trim().toLowerCase().min(2).max(40).regex(PLUGIN_SLUG, {
  message: 'lowercase letters, digits and hyphens',
});

const addPublisherSchema = z
  .object({
    publisherId: slug,
    displayName: z.string().trim().min(1).max(80),
    /**
     * Base64, either the raw 32 bytes or the SPKI DER — `normalizePublisherKey`
     * settles which. Capped generously rather than exactly, so a paste with a
     * PEM header produces "that is not an Ed25519 key" and not "too long",
     * which is a more useful sentence to the person holding the key.
     */
    publicKey: z.string().trim().min(1).max(500),
  })
  .strict();

const installSchema = z
  .object({
    /* Shape is `evaluateInstall`'s problem — it owns the manifest schema and the
     * error message that names the offending field. Parsing it here as well
     * would mean two definitions of what a manifest is. */
    manifest: z.unknown(),
    signature: pluginSignatureSchema,
    bundleSha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 digest in lowercase hex'),
  })
  .strict();

const enablementSchema = z.object({ enabled: z.boolean() }).strict();

// ─── Shared reads ────────────────────────────────────────────────────────────

/**
 * The org's plan, expressed as the two facts `evaluateInstall` needs.
 *
 * `limits`, not `plan`: `planFor` returns the plan LABEL the org bought and the
 * limits it is currently metered at, and those disagree for an org whose
 * subscription is past due. The refusal has to quote the pair that is actually
 * being applied, or it says "on Business…" while enforcing Free's ceiling.
 */
async function planGate(orgId: string): Promise<{
  label: string;
  allowsGovernedCapabilities: boolean;
}> {
  const { limits } = await planFor(orgId);
  return { label: limits.label, allowsGovernedCapabilities: limits.auditLog };
}

async function pluginOr404(pluginId: string) {
  const plugin = await prisma.plugin.findUnique({
    where: { id: pluginId },
    select: { id: true, name: true, version: true, publisher: true, capabilities: true },
  });
  if (!plugin) throw notFound('Plugin');
  return plugin;
}

// ─── GET / — everything the screen renders ───────────────────────────────────

/**
 * One call, because the screen cannot ask its question in pieces.
 *
 * The capability vocabulary and its copy are SERVED rather than duplicated in
 * the web app. That is the point of the endpoint being shaped this way: the
 * sentence the approver reads under "Project secrets" and the rule the API
 * enforces on `secrets` are then the same string from the same file, and there
 * is no way for the screen to describe a capability the enforcer means
 * differently. A UI-side copy of that table is exactly how an install screen
 * starts reassuring people about a permission that has since changed.
 */
pluginsRouter.get('/', async (req, res) => {
  const actor = actorOf(req);

  const [publishers, plugins, projects, plan] = await Promise.all([
    prisma.pluginPublisher.findMany({
      orderBy: { publisherId: 'asc' },
      select: {
        id: true,
        publisherId: true,
        displayName: true,
        fingerprint: true,
        revokedAt: true,
        createdAt: true,
      },
    }),
    prisma.plugin.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        version: true,
        publisher: true,
        publisherRowId: true,
        displayName: true,
        description: true,
        homepage: true,
        protocol: true,
        capabilities: true,
        governedCapabilities: true,
        codeSha256: true,
        codeEntry: true,
        codeBytes: true,
        createdAt: true,
      },
    }),
    prisma.project.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    planGate(actor.orgId),
  ]);

  /*
   * Every enablement row for the org in one read, then grouped in memory.
   * Plugins × projects is small — tens by tens — and the alternative is a query
   * per plugin, which is the shape that turns a settings screen into a hundred
   * round trips on the org that has most to look at.
   */
  const enablements = await prisma.pluginEnablement.findMany({
    select: { pluginId: true, projectId: true, enabled: true },
  });
  const byPlugin = new Map<string, Record<string, boolean>>();
  for (const row of enablements) {
    const existing = byPlugin.get(row.pluginId) ?? {};
    existing[row.projectId] = row.enabled;
    byPlugin.set(row.pluginId, existing);
  }

  const revokedRows = new Set(publishers.filter((p) => p.revokedAt).map((p) => p.id));

  res.json({
    plan,
    protocol: { speaks: PLUGIN_PROTOCOL_VERSION, oldest: MIN_PLUGIN_PROTOCOL_VERSION },
    manifestSchema: PLUGIN_MANIFEST_SCHEMA,
    /*
     * Served, not re-derived in the browser. The screen warns about a name a
     * first-party plugin owns before the install is attempted, and a hard-coded
     * copy of this list in the web app goes stale the first time QAAI adds a
     * twentieth test type — at which point the screen invites an install the
     * API refuses.
     */
    reservedNames: RESERVED_PLUGIN_NAMES,
    capabilities: PLUGIN_CAPABILITIES.map((name) => ({
      name,
      ...PLUGIN_CAPABILITY_COPY[name],
      governed: isGovernedCapability(name),
    })),
    publishers: publishers.map((p) => ({
      ...p,
      pluginCount: plugins.filter((plugin) => plugin.publisherRowId === p.id).length,
    })),
    plugins: plugins.map(({ publisherRowId, ...plugin }) => ({
      ...plugin,
      /*
       * Surfaced per plugin, not left for the screen to join: a plugin whose
       * publisher's key was revoked after it was installed is still sitting
       * there, still enabled, and its signature can no longer be checked
       * against anything. That is the single most important row on this page
       * and it must not depend on the reader noticing two lists agree.
       */
      publisherRevoked: revokedRows.has(publisherRowId),
      projects: byPlugin.get(plugin.id) ?? {},
    })),
    projects,
  });
});

// ─── Publishers ──────────────────────────────────────────────────────────────

/**
 * Trust a publisher's signing key.
 *
 * Three outcomes, and the middle one is the interesting one:
 *
 *   · No row for this publisher → trusted, fingerprint returned so the person
 *     can compare it against the publisher's own site.
 *   · A REVOKED row and nothing installed under it → the key is rotated onto
 *     that row. Rotation reuses the row rather than adding a second, because
 *     two rows for "acme" would turn "is this signature from acme" into a loop
 *     over candidate keys, and a loop that accepts if ANY key matches is a loop
 *     in which revocation does nothing.
 *   · A REVOKED row with plugins still installed under it → REFUSED, naming
 *     them. Their stored signatures were made with the key that was revoked;
 *     accepting a new key would leave those installs pointing at a key that
 *     cannot verify them, so the next re-verification either fails mysteriously
 *     or, worse, is skipped. Uninstall first, then trust the new key, then
 *     install again — three deliberate steps, each of which a person sees.
 */
pluginsRouter.post('/publishers', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = addPublisherSchema.parse(req.body);

  const publicKey = normalizePublisherKey(input.publicKey);
  if (!publicKey) {
    throw badRequest(
      'That is not an Ed25519 public key. Paste the 32 raw bytes or the SPKI DER, base64 — ' +
        'what `openssl pkey -pubout -outform DER` produces.',
    );
  }
  const fingerprint = publisherKeyFingerprint(publicKey);

  const existing = await prisma.pluginPublisher.findUnique({
    where: { orgId_publisherId: { orgId: actor.orgId, publisherId: input.publisherId } },
    select: { id: true, revokedAt: true, fingerprint: true },
  });

  if (existing && !existing.revokedAt) {
    throw conflict(
      `"${input.publisherId}" is already trusted, with key ${existing.fingerprint}. Revoke that ` +
        `key before trusting a different one — two live keys for one publisher would mean a ` +
        `signature is accepted if either matches.`,
      { fingerprint: existing.fingerprint },
    );
  }

  if (existing) {
    const stranded = await prisma.plugin.findMany({
      where: { publisherRowId: existing.id },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    if (stranded.length > 0) {
      throw conflict(
        `${stranded.length} plugin${stranded.length === 1 ? '' : 's'} from ` +
          `"${input.publisherId}" ${stranded.length === 1 ? 'is' : 'are'} still installed ` +
          `(${stranded.map((p) => p.name).join(', ')}), signed by the key you revoked. ` +
          `Uninstall ${stranded.length === 1 ? 'it' : 'them'} first — nothing can re-verify ` +
          `${stranded.length === 1 ? 'it' : 'them'} under a new key.`,
        { plugins: stranded.map((p) => p.name) },
      );
    }
  }

  const publisher = existing
    ? await prisma.pluginPublisher.update({
        where: { id: existing.id },
        data: {
          displayName: input.displayName,
          publicKey: publicKey.toString('base64'),
          fingerprint,
          revokedAt: null,
          revokedBy: null,
          addedBy: actor.userId || null,
        },
        select: {
          id: true,
          publisherId: true,
          displayName: true,
          fingerprint: true,
          revokedAt: true,
          createdAt: true,
        },
      })
    : await prisma.pluginPublisher.create({
        data: {
          // Stamped by the tenancy extension anyway; written out because every
          // other create in this API does, and a reader should not have to know
          // about the extension to see that this row is org-owned.
          orgId: actor.orgId,
          publisherId: input.publisherId,
          displayName: input.displayName,
          publicKey: publicKey.toString('base64'),
          fingerprint,
          addedBy: actor.userId || null,
        },
        select: {
          id: true,
          publisherId: true,
          displayName: true,
          fingerprint: true,
          revokedAt: true,
          createdAt: true,
        },
      });

  await audit({
    actor,
    action: existing ? 'plugin.publisher.rotate' : 'plugin.publisher.trust',
    targetType: 'PluginPublisher',
    targetId: publisher.id,
    // The fingerprint, never the key material — though for a PUBLIC key that is
    // caution rather than necessity. The fingerprint is the useful field
    // anyway: it is what somebody later compares against what they approved.
    metadata: { publisherId: publisher.publisherId, fingerprint },
  });

  res.status(existing ? 200 : 201).json({ publisher, pluginCount: 0 });
});

/**
 * Stop trusting a key.
 *
 * A timestamp, not a delete, and the plugins installed under it are LEFT ALONE.
 * Cascading an uninstall off a revocation would mean one click silently
 * stopping every suite that depends on those plugins, decided by someone
 * looking at a key rather than at a test schedule. The list screen marks them
 * instead, loudly, and uninstalling stays a separate, named act.
 */
pluginsRouter.post('/publishers/:publisherRowId/revoke', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);

  const existing = await prisma.pluginPublisher.findUnique({
    where: { id: String(req.params.publisherRowId) },
    select: { id: true, publisherId: true, fingerprint: true, revokedAt: true },
  });
  if (!existing) throw notFound('Publisher');
  if (existing.revokedAt) throw conflict('That key was already revoked.');

  const publisher = await prisma.pluginPublisher.update({
    where: { id: existing.id },
    data: { revokedAt: new Date(), revokedBy: actor.userId || null },
    select: {
      id: true,
      publisherId: true,
      displayName: true,
      fingerprint: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  const affected = await prisma.plugin.findMany({
    where: { publisherRowId: existing.id },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });

  await audit({
    actor,
    action: 'plugin.publisher.revoke',
    targetType: 'PluginPublisher',
    targetId: publisher.id,
    metadata: {
      publisherId: publisher.publisherId,
      fingerprint: existing.fingerprint,
      // Named in the audit row because this is the moment the org's exposure
      // changed, and "what was still installed when we stopped trusting them"
      // is the first question anyone asks afterwards.
      stillInstalled: affected.map((p) => p.name),
    },
  });

  res.json({ publisher, stillInstalled: affected });
});

// ─── Install ─────────────────────────────────────────────────────────────────

pluginsRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = installSchema.parse(req.body);

  /*
   * The publisher is read BEFORE the manifest is trusted for anything, using
   * the publisher name off the unverified document. That is safe and it is the
   * only order that works: the name is a lookup key, the row it finds carries
   * the key that decides whether the document may be believed at all, and
   * `evaluateInstall` refuses when the lookup came back empty.
   */
  const claimed = (input.manifest as { publisher?: unknown } | null)?.publisher;
  const publisherRow =
    typeof claimed === 'string' && claimed.length > 0 && claimed.length <= 40
      ? await prisma.pluginPublisher.findUnique({
          where: { orgId_publisherId: { orgId: actor.orgId, publisherId: claimed } },
          select: { id: true, publisherId: true, publicKey: true, revokedAt: true },
        })
      : null;

  const verdict = evaluateInstall({
    manifest: input.manifest,
    signature: input.signature,
    bundleSha256: input.bundleSha256,
    publisher: publisherRow
      ? {
          publisherId: publisherRow.publisherId,
          publicKey: Buffer.from(publisherRow.publicKey, 'base64'),
          revokedAt: publisherRow.revokedAt,
        }
      : null,
    plan: await planGate(actor.orgId),
  });

  if (!verdict.ok) {
    /*
     * A refused install is audited, even though nothing was written.
     *
     * The house rule is an audit on every mutation, and this is not one — but a
     * signature that did not verify is the single most interesting event this
     * feature can produce, and it is precisely the one that leaves no trace by
     * default. Somebody attempting to install a tampered manifest against a
     * customer's org should not be invisible because the attempt failed.
     */
    await audit({
      actor,
      action: 'plugin.install.refused',
      targetType: 'Plugin',
      metadata: {
        reason: verdict.code,
        publisher: typeof claimed === 'string' ? claimed : null,
        ...(verdict.detail ?? {}),
      },
    });
    throw refusalError(verdict);
  }

  const { manifest, governed } = verdict;
  // Non-null: `evaluateInstall` returns UNKNOWN_PUBLISHER when it is null, and
  // that is a refusal, so reaching here means the row exists.
  const publisher = publisherRow!;

  const clash = await prisma.plugin.findUnique({
    where: { orgId_name: { orgId: actor.orgId, name: manifest.name } },
    select: { version: true },
  });
  if (clash) {
    throw conflict(
      `${manifest.name} is already installed at ${clash.version}. Uninstall it before ` +
        `installing ${manifest.version} — an upgrade in place would change what the plugin can ` +
        `reach without anyone approving the new capability list.`,
      { installedVersion: clash.version },
    );
  }

  const plugin = await prisma.plugin.create({
    data: {
      orgId: actor.orgId,
      name: manifest.name,
      version: manifest.version,
      publisherRowId: publisher.id,
      publisher: manifest.publisher,
      displayName: manifest.displayName,
      description: manifest.description,
      homepage: manifest.homepage ?? null,
      protocol: manifest.protocol,
      capabilities: manifest.capabilities,
      governedCapabilities: governed,
      codeSha256: manifest.code.sha256,
      codeBytes: manifest.code.bytes,
      codeEntry: manifest.code.entry,
      /*
       * The manifest and its signature are kept verbatim so verification can be
       * REDONE — by the runner before it loads anything, and by us on a protocol
       * bump. The columns above are a convenience copy that this row could in
       * principle drift from; these two are the evidence.
       *
       * Only the signature VALUE is stored. Its algorithm is pinned by the
       * manifest schema (`qaai.plugin/1` means Ed25519 and nothing else), so a
       * second algorithm is a schema bump and a migration moment regardless.
       */
      manifest,
      signature: input.signature.value,
      installedBy: actor.userId || null,
    },
    select: {
      id: true,
      name: true,
      version: true,
      publisher: true,
      displayName: true,
      description: true,
      homepage: true,
      protocol: true,
      capabilities: true,
      governedCapabilities: true,
      codeSha256: true,
      codeEntry: true,
      codeBytes: true,
      createdAt: true,
    },
  });

  await audit({
    actor,
    action: 'plugin.install',
    targetType: 'Plugin',
    targetId: plugin.id,
    metadata: {
      name: plugin.name,
      version: plugin.version,
      publisher: plugin.publisher,
      fingerprint: publisherKeyFingerprint(Buffer.from(publisher.publicKey, 'base64')),
      capabilities: plugin.capabilities,
      codeSha256: plugin.codeSha256,
    },
  });

  // Installed, and enabled nowhere. The response says so explicitly rather than
  // leaving the screen to infer it from an empty map.
  res.status(201).json({ plugin: { ...plugin, publisherRevoked: false, projects: {} } });
});

// ─── Uninstall ───────────────────────────────────────────────────────────────

/**
 * Remove a plugin from the org. Its enablements go with it — the foreign key
 * cascades, which is the point of the cascade: a project marked as running
 * something that no longer exists is a row nothing will ever reconcile.
 */
pluginsRouter.delete('/:pluginId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const plugin = await pluginOr404(String(req.params.pluginId));

  const enabledOn = await prisma.pluginEnablement.findMany({
    where: { pluginId: plugin.id, enabled: true },
    select: { projectId: true },
  });

  await prisma.plugin.delete({ where: { id: plugin.id } });

  await audit({
    actor,
    action: 'plugin.uninstall',
    targetType: 'Plugin',
    targetId: plugin.id,
    metadata: {
      name: plugin.name,
      version: plugin.version,
      publisher: plugin.publisher,
      capabilities: plugin.capabilities,
      // Which projects just lost it. Read before the delete, because after the
      // cascade there is nothing left to read and this is the field that
      // explains why a suite's behaviour changed.
      wasEnabledOn: enabledOn.map((row) => row.projectId),
    },
  });

  res.json({ uninstalled: { id: plugin.id, name: plugin.name } });
});

// ─── Enable / disable, per project ───────────────────────────────────────────

/**
 * Allow, or stop allowing, one plugin to run against one project.
 *
 * Both ids are re-read through the tenant-scoped client BEFORE the upsert, and
 * that is not belt-and-braces. The tenancy extension guards `update` and
 * `delete` with a pre-flight ownership check but deliberately leaves `upsert`'s
 * update path alone (see lib/prisma.ts) — its `where` has to stay a unique
 * selector, and `pluginId_projectId` is one. So the guarantee that neither id
 * belongs to another org has to be established here, by two lookups the
 * extension does scope, or a leaked pair of ids would write through.
 */
pluginsRouter.put(
  '/:pluginId/projects/:projectId',
  requireRole('ADMIN'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = enablementSchema.parse(req.body);

    const plugin = await pluginOr404(String(req.params.pluginId));

    const projectId = String(req.params.projectId);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, archivedAt: true },
    });
    if (!project) throw notFound('Project');
    /*
     * Enabling on an archived project is refused; DISABLING is not. Refusing
     * both would leave a plugin permanently live on a project somebody archived
     * precisely to stop it doing things.
     */
    if (project.archivedAt && input.enabled) {
      throw badRequest(`${project.name} is archived. Restore it before enabling plugins on it.`);
    }

    const row = await prisma.pluginEnablement.upsert({
      where: { pluginId_projectId: { pluginId: plugin.id, projectId: project.id } },
      create: {
        orgId: actor.orgId,
        pluginId: plugin.id,
        projectId: project.id,
        enabled: input.enabled,
        updatedBy: actor.userId || null,
      },
      update: { enabled: input.enabled, updatedBy: actor.userId || null },
      select: { pluginId: true, projectId: true, enabled: true, updatedAt: true },
    });

    await audit({
      actor,
      action: input.enabled ? 'plugin.enable' : 'plugin.disable',
      targetType: 'Plugin',
      targetId: plugin.id,
      metadata: {
        name: plugin.name,
        version: plugin.version,
        projectId: project.id,
        projectName: project.name,
        // The capability list is repeated on every enable on purpose. This row
        // is the moment third-party code became able to touch this project, and
        // an auditor reading it should not have to go and find the install row
        // to learn what that meant.
        capabilities: plugin.capabilities,
      },
    });

    res.json({ enablement: row });
  },
);
