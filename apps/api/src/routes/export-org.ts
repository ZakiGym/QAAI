/**
 * Per-org data export (GDPR Art. 20 portability, and "can we get our data out"
 * in every enterprise security review).
 *
 * A database dump answers "can you recover the platform". This answers a
 * different question — "can ONE customer take THEIR data and leave" — and the
 * two must not be confused, because the safe answer differs in the one way that
 * matters:
 *
 *   ── SECRETS ARE EXCLUDED, AND THAT IS THE WHOLE DESIGN ────────────────────
 *
 *   A backup contains ciphertext, which is safe because the key lives
 *   elsewhere. An export is DECRYPTED BY DEFINITION — it is JSON, handed to a
 *   human, over HTTP, usually because they asked in a support ticket. An export
 *   containing decrypted secrets is a credential breach with a delivery
 *   mechanism attached: it lands in a Zendesk attachment, a Slack thread, a
 *   downloads folder, an email to the wrong address. There is no version of
 *   this endpoint that decrypts anything, and the response says so in its own
 *   body so the recipient knows what they are missing and why.
 *
 *   The exclusion is enforced by SHAPE, not by a list. `isExcludedColumn()`
 *   drops any column whose NAME says it carries credential material — `*Enc`,
 *   `*Hash`, storage state, signatures. A new sealed column added to the schema
 *   next month is excluded the day it is added, with nobody remembering to come
 *   here. The failure mode of a hand-maintained allowlist is a leak; the
 *   failure mode of this is a missing field in an export, which someone will
 *   report and which harms no one.
 *
 * ── Two more rules ──────────────────────────────────────────────────────────
 *
 * 1. **OWNER only, and audited.** This single request returns everything the
 *    org has. That is the most concentrated read in the product, and it should
 *    appear in the audit log next to the person who ran it.
 *
 * 2. **Tenancy is checked twice.** Every query runs inside the Prisma tenancy
 *    extension, which pins `orgId` — and then every row is re-checked here
 *    before it is written. Belt and braces, because the blast radius of a
 *    regression in the extension is another tenant's data inside a file this
 *    org downloads, and no amount of "the extension handles it" is worth that.
 *
 * Mounting (this file deliberately does not touch src/index.ts):
 *     import { exportOrgRouter } from './routes/export-org.js';
 *     app.use('/export', exportOrgRouter);
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma, unscoped } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const exportOrgRouter: Router = Router();

exportOrgRouter.use(requireAuth);
exportOrgRouter.use(requireRole('OWNER'));

// ─── What is never exported ──────────────────────────────────────────────────

/**
 * Columns dropped from every row of every model, matched by name.
 *
 * Name-based rather than a per-model list, so the default for anything new is
 * EXCLUDED. Each pattern, and the specific thing it stops:
 *
 *   *Enc          Secret.valueEnc, Integration.configEnc,
 *                 SsoConnection.oidcClientSecretEnc, SsoLoginRequest.pkceVerifierEnc,
 *                 User.totpSecretEnc, OAuthAccount.access/refreshTokenEnc.
 *                 Ciphertext. Useless to the recipient without the master key,
 *                 and an offline-attack target if it ever leaves the building.
 *   *Hash         ApiKey.keyHash, Runner.tokenHash, Invite.tokenHash,
 *                 SsoLoginRequest.stateHash/nonceHash, User.passwordHash.
 *                 Verifiers. Exporting them hands over an offline cracking
 *                 target for credentials that are still live.
 *   storageState  AuthProfile.storageState — a cached Playwright session: real,
 *                 unexpired cookies for the customer's own application. This is
 *                 the sharpest one in the schema, because it is a plain JSON
 *                 column with an innocuous name and it is a live session token.
 *   signature     WebhookDelivery.signature — an HMAC under the integration's
 *                 secret. Not reversible, but it is a per-message oracle and it
 *                 has no portability value.
 *   hint          Secret.hint — the last four characters of the PLAINTEXT. Kept
 *                 in the product so the UI can say "…is this the right value?",
 *                 which is exactly why it must not be in a file that leaves.
 */
const EXCLUDED_COLUMN_PATTERNS: ReadonlyArray<RegExp> = [
  /Enc$/,
  /Hash$/,
  /^storageState$/,
  /^signature$/,
  /^hint$/,
  /^pkceVerifier/,
  /secret/i,
  /token$/i,
  /password/i,
];

export function isExcludedColumn(name: string): boolean {
  return EXCLUDED_COLUMN_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Strip excluded columns and record what was dropped.
 *
 * Returns the names it removed rather than removing them silently: the export's
 * own manifest lists them, so the recipient can tell "QAAI does not have this"
 * apart from "QAAI would not give me this".
 */
export function redactRow(
  row: Record<string, unknown>,
  droppedInto: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isExcludedColumn(key)) {
      droppedInto.add(key);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * JSON.stringify replacer for the types Prisma returns and JSON has no spelling
 * for.
 *
 * BigInt is the one that matters and it is not hypothetical:
 * `UsageRecord.quantity` is a BigInt, `JSON.stringify` THROWS on it rather than
 * skipping it, and UsageRecord is non-empty for every org that has ever run a
 * test. Without this the export died part-way through for every real customer
 * while passing every type check — it was found by running the endpoint against
 * restored production data, not by reading the code.
 *
 * Serialised as a STRING, not a Number: these are byte counts and token counts,
 * the metrics that exceed 2^53 first, and `Number` would silently round the
 * value in a document whose purpose is to be an accurate record.
 */
export function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  // Prisma's Decimal and any other object that knows how to render itself.
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

/** `JSON.stringify` that cannot throw on a Prisma scalar. */
function toJson(value: unknown): string {
  return JSON.stringify(value, jsonSafe);
}

// ─── What IS exported ────────────────────────────────────────────────────────

/**
 * Every org-owned model, by Prisma delegate name.
 *
 * Enumerated rather than derived from the Prisma DMMF on purpose. The tenancy
 * extension divides models into org-owned (scoped by `orgId`) and GLOBAL (User,
 * Session, FeatureFlag — deliberately unscoped). Iterating "every model Prisma
 * knows about" would walk straight into the global ones and export every user
 * and session on the installation into one org's download. The list is the
 * safety boundary, so it is written out where it can be reviewed.
 *
 * Membership carries the org's people; their user PROFILES are fetched
 * separately and narrowly, below.
 */
const ORG_OWNED_MODELS = [
  'membership',
  'invite',
  'apiKey',
  'auditLog',
  'project',
  'environment',
  'secret',
  'authProfile',
  'flowMap',
  'testPlan',
  'planItem',
  'suite',
  'test',
  'testVersion',
  'run',
  'runShard',
  'testResult',
  'step',
  'finding',
  'artifact',
  'triageVerdict',
  'healProposal',
  'visualBaseline',
  'schedule',
  'monitor',
  'integration',
  'webhookDelivery',
  'chatConversation',
  'chatMessage',
  'importBatch',
  'agentProposal',
  'subscription',
  'usageRecord',
  'agentCall',
  'featureFlagOverride',
  'ssoConnection',
  'ssoDomain',
  'ssoLoginRequest',
  'ssoAssertionSeen',
  'runner',
  'runnerJob',
  'team',
  'teamMember',
  'ownershipRule',
  'triageBatch',
  'triageBatchItem',
  'digestSubscription',
] as const;

type OrgOwnedModel = (typeof ORG_OWNED_MODELS)[number];

/** Rows per page. Small enough to stream steadily, large enough not to thrash. */
const PAGE_SIZE = 500;

/**
 * Minimal shape of a Prisma delegate. The export walks models by name, which
 * the generated client's types cannot express, so the cast is confined here
 * rather than spread across the handler.
 */
interface Findable {
  findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
}

function delegateFor(model: OrgOwnedModel): Findable {
  const delegate = (prisma as unknown as Record<string, Findable | undefined>)[model];
  if (!delegate || typeof delegate.findMany !== 'function') {
    // A model renamed in the schema without updating the list above. Loud, and
    // caught by the preview endpoint long before anyone runs a real export.
    throw new Error(`export-org: no Prisma delegate named "${model}"`);
  }
  return delegate;
}

/**
 * Read one model in id-ordered pages.
 *
 * Cursor pagination, not offset: an export of a busy org takes long enough that
 * rows are being inserted underneath it, and `skip`/`take` would silently drop
 * or duplicate rows as the offsets shift. Ordering by `id` also makes two
 * exports of unchanged data byte-identical, which is what lets a customer diff
 * them.
 */
async function* pagesOf(
  model: OrgOwnedModel,
  orgId: string,
): AsyncGenerator<Array<Record<string, unknown>>> {
  let cursor: string | null = null;

  for (;;) {
    const rows = await delegateFor(model).findMany({
      take: PAGE_SIZE,
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (rows.length === 0) return;

    /*
     * The second tenancy check. The extension already pinned orgId onto the
     * `where` of this findMany; this asserts the rows that came back actually
     * carry it. If the two ever disagree, the export is aborted mid-stream
     * rather than completed — a truncated download is a support ticket, and a
     * complete one containing another tenant's rows is a breach notification.
     */
    for (const row of rows) {
      if (row.orgId !== undefined && row.orgId !== orgId) {
        throw new Error(
          `export-org: tenancy check failed on ${model} — row is not owned by the requesting org`,
        );
      }
    }

    yield rows;

    if (rows.length < PAGE_SIZE) return;
    const last = rows[rows.length - 1];
    const lastId = last?.id;
    if (typeof lastId !== 'string') return;
    cursor = lastId;
  }
}

// ─── GET /export/org/preview ─────────────────────────────────────────────────

/**
 * What a full export would contain, without producing it.
 *
 * Exists so the UI can say "this will export 41,000 rows" and, more usefully,
 * so it can show the exclusion list BEFORE somebody discovers in the file that
 * their secrets are not in it.
 */
exportOrgRouter.get('/org/preview', async (req: Request, res: Response) => {
  const actor = actorOf(req);

  const counts: Record<string, number> = {};
  let total = 0;
  for (const model of ORG_OWNED_MODELS) {
    const rows = await (
      delegateFor(model) as unknown as { count(args: unknown): Promise<number> }
    ).count({});
    counts[model] = rows;
    total += rows;
  }

  res.json({
    orgId: actor.orgId,
    totalRows: total,
    counts,
    excluded: EXCLUSION_NOTES,
  });
});

// ─── GET /export/org ─────────────────────────────────────────────────────────

/**
 * Everything this org owns, as one JSON document, streamed.
 *
 * Streamed rather than assembled: a mature org's Step and Finding tables run to
 * hundreds of thousands of rows, and building that in memory to hand to
 * `res.json()` is an OOM that takes the whole API process down — every other
 * tenant included — on a button one person pressed.
 *
 * The cost of streaming is that the status code is already sent when a failure
 * happens mid-document, so an error cannot become a clean 500. That is handled
 * explicitly at the end: the document is terminated with a `complete: false`
 * marker and the connection destroyed, so a truncated export is
 * machine-detectable rather than a JSON file that just happens to end early.
 */
exportOrgRouter.get('/org', async (req: Request, res: Response) => {
  const actor = actorOf(req);

  const only = typeof req.query.models === 'string' ? req.query.models.split(',') : null;
  if (only) {
    const unknown = only.filter((m) => !ORG_OWNED_MODELS.includes(m as OrgOwnedModel));
    if (unknown.length > 0) {
      throw badRequest(`Unknown model(s): ${unknown.join(', ')}`, {
        known: [...ORG_OWNED_MODELS],
      });
    }
  }
  const models = only
    ? ORG_OWNED_MODELS.filter((m) => only.includes(m))
    : [...ORG_OWNED_MODELS];

  const org = await prisma.organization.findUnique({
    where: { id: actor.orgId },
    select: { id: true, name: true, slug: true, plan: true, createdAt: true },
  });

  await audit({
    actor,
    action: 'org.export',
    targetType: 'Organization',
    targetId: actor.orgId,
    metadata: { models: models.length, secretsIncluded: false },
  });

  res.status(200);
  res.type('application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="qaai-org-export-${actor.orgId}.json"`,
  );
  // Nothing downstream should hold this in a buffer waiting for a length.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const droppedColumns = new Set<string>();
  const rowCounts: Record<string, number> = {};

  /*
   * Respect backpressure: a fast database and a slow client is the normal case
   * here, and ignoring write()'s return value buffers the entire export in the
   * process anyway — the thing streaming exists to avoid.
   *
   * The listeners are removed on every path. Attaching a `drain` and an `error`
   * handler per write and leaving them behind adds two listeners per row; at a
   * few hundred thousand rows that is a MaxListenersExceededWarning followed by
   * real memory growth, in the handler whose entire purpose is bounded memory.
   */
  const write = (chunk: string): Promise<void> =>
    new Promise((resolvePromise, rejectPromise) => {
      if (res.write(chunk)) {
        resolvePromise();
        return;
      }
      const onDrain = (): void => {
        res.removeListener('error', onError);
        resolvePromise();
      };
      const onError = (err: Error): void => {
        res.removeListener('drain', onDrain);
        rejectPromise(err);
      };
      res.once('drain', onDrain);
      res.once('error', onError);
    });

  try {
    await write('{\n');
    await write(`"format": ${toJson(EXPORT_FORMAT)},\n`);
    await write(`"exportedAt": ${toJson(new Date().toISOString())},\n`);
    await write(`"organization": ${toJson(org)},\n`);
    await write(`"secretsIncluded": false,\n`);
    await write(`"excluded": ${toJson(EXCLUSION_NOTES)},\n`);

    // People, narrowly. Membership rows carry only userIds, which are useless
    // in a portability export; the profile fields are the personal data the
    // org actually holds. passwordHash/totpSecretEnc are not in the select at
    // all — this is the one place a hand-written field list is safer than a
    // redactor, because User is a GLOBAL model and a `select` is what keeps the
    // query from reaching users outside this org's membership.
    const memberships = await prisma.membership.findMany({ select: { userId: true, role: true } });
    const members = await unscoped(() =>
      prisma.user.findMany({
        where: { id: { in: memberships.map((m) => m.userId) } },
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          emailVerified: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
    );
    await write(`"members": ${toJson(members)},\n`);

    await write('"records": {\n');
    let first = true;
    for (const model of models) {
      if (!first) await write(',\n');
      first = false;
      await write(`${toJson(model)}: [`);

      let count = 0;
      for await (const page of pagesOf(model, actor.orgId)) {
        for (const row of page) {
          await write(`${count === 0 ? '' : ','}\n${toJson(redactRow(row, droppedColumns))}`);
          count++;
        }
      }
      rowCounts[model] = count;
      await write(count === 0 ? ']' : '\n]');
    }
    await write('\n},\n');

    await write(`"rowCounts": ${toJson(rowCounts)},\n`);
    await write(`"droppedColumns": ${toJson([...droppedColumns].sort())},\n`);
    await write('"complete": true\n}\n');
    res.end();
  } catch (err) {
    /*
     * Headers are long gone, so there is no status code left to set.
     *
     * Two things happen here and neither is cosmetic. First, an explicit marker
     * is appended — it does NOT close the JSON structures, because the document
     * is already unparseable and pretending otherwise would be the lie this
     * endpoint exists to avoid. It is a greppable string in a file that must
     * not be trusted. Second, the socket is DESTROYED rather than ended: a
     * cleanly-ended response looks like a successful download to every HTTP
     * client, and a client that checks only the status code would file this
     * half-written export as the customer's data export.
     */
    logger.error({ err, orgId: actor.orgId }, 'org export failed mid-stream');
    try {
      /*
       * Wait for the marker to actually reach the socket before destroying it.
       *
       * `res.write(x); res.destroy();` does NOT do this — destroy tears the
       * socket down while the chunk is still in the outgoing buffer, and the
       * marker never arrives. Observed: a 1.2 MB truncated export with zero
       * occurrences of the warning string that was supposed to be its whole
       * defence. The timeout is the backstop for a peer that has already gone
       * away, so a dead client cannot hold the handler open.
       */
      await new Promise<void>((resolveFlush) => {
        const done = (): void => resolveFlush();
        res.write(
          '\n\n"QAAI_EXPORT_INCOMPLETE": "This export failed part-way through and is truncated. ' +
            'It is NOT valid JSON and NOT a complete record. Discard it and re-run."\n',
          done,
        );
        setTimeout(done, 2000).unref();
      });
    } catch {
      // The socket is already gone; nothing to salvage.
    }
    res.destroy();
  }
});

// ─── The exclusion notes, in the response body ───────────────────────────────

export const EXPORT_FORMAT = 'qaai.org-export/v1';

/**
 * Shipped inside every export and every preview.
 *
 * The point of putting this in the payload rather than only in documentation:
 * the file outlives the request, gets forwarded, and gets read by somebody who
 * never saw the docs. It should explain itself.
 */
export const EXCLUSION_NOTES = [
  {
    what: 'Secret values (Secret.valueEnc and every other *Enc column)',
    why:
      'Deliberate, and non-negotiable. Decrypting secrets into a JSON file that gets emailed, ' +
      'attached to a support ticket or left in a downloads folder is a credential breach with a ' +
      'delivery mechanism. The secret NAMES and their metadata are here, so you know exactly what ' +
      'to re-supply.',
    whatYouGetInstead: 'Names, environment, key version, timestamps — everything except the value.',
  },
  {
    what: 'Password hashes, API key hashes, runner token hashes, invite tokens',
    why:
      'They authenticate nothing for you and everything for an attacker. A hash export is an ' +
      'offline cracking target for credentials that are still live.',
    whatYouGetInstead: 'Key prefixes and names, which identify a credential without being one.',
  },
  {
    what: 'Cached browser session state (AuthProfile.storageState)',
    why:
      'It is a live, unexpired set of cookies for YOUR application, captured so tests do not have ' +
      'to log in every run. It is a session token wearing the name of a config field.',
    whatYouGetInstead: 'The auth profile’s name, kind and non-secret config.',
  },
  {
    what: 'Artifact bytes — screenshots, videos, traces',
    why:
      'The Artifact rows are here with their object keys, sizes and content types, but the bytes ' +
      'live in object storage and are typically orders of magnitude larger than this document.',
    whatYouGetInstead:
      'Every artifact row, so you can fetch the objects you want through the artifact API.',
  },
  {
    what: 'Users who are not members of this org, and all global platform data',
    why:
      'This export is scoped to one organization. Member profiles are included because the org ' +
      'holds that data; nothing outside the org boundary is.',
    whatYouGetInstead: 'The member list, with profile fields but no credentials.',
  },
] as const;
