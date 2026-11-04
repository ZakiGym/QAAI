/**
 * Org settings (§8): members, API keys, audit log.
 *
 * API keys are the load-bearing part — the CLI and CI have no session, so a key
 * is the only way they authenticate (§1). The raw key is shown exactly once, at
 * creation; only its hash is stored, so a database leak hands out no live
 * credentials.
 */

import { Router } from 'express';
import {
  API_KEY_PREFIX,
  createApiKeySchema,
  egressAllowlistEntrySchema,
  inviteSchema,
  resolveEgressPolicy,
  rotateApiKeySchema,
  secretScopeSchema,
  updateMemberSchema,
} from '@qaai/shared';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { generateApiKey, generateToken, hashToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { auditRowsToCsv } from '../lib/audit.js';
import { inviteMail, mailDriver, sendMail } from '../lib/mail.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';
import { env } from '../env.js';

export const settingsRouter: Router = Router();

settingsRouter.use(requireAuth);

// ─── Members ─────────────────────────────────────────────────────────────────

settingsRouter.get('/members', async (req, res) => {
  const actor = actorOf(req);
  const memberships = await prisma.membership.findMany({
    where: { orgId: actor.orgId },
    orderBy: { createdAt: 'asc' },
  });

  // Users are a global table, so this read is unscoped by necessity — the ids
  // come from the org's own memberships, so no cross-tenant data is exposed.
  const users = await unscoped(() =>
    prisma.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, email: true, name: true },
    }),
  );
  const byId = new Map(users.map((u) => [u.id, u]));

  res.json({
    members: memberships.map((m) => ({
      userId: m.userId,
      role: m.role,
      name: byId.get(m.userId)?.name ?? '',
      email: byId.get(m.userId)?.email ?? '',
      joinedAt: m.createdAt,
    })),
  });
});

/**
 * How many OWNERs this org has, and whether a given user is one.
 *
 * Every mutation below consults this. An org with no OWNER cannot be recovered
 * through the product — OWNER is the only role that can promote anyone, so the
 * last one demoting or removing themselves is a one-way door into an account
 * nobody can administer. The check is cheap; the alternative is a support
 * ticket that ends in a database edit.
 */
async function ownerGuard(orgId: string, userId: string) {
  const owners = await prisma.membership.findMany({
    where: { orgId, role: 'OWNER' },
    select: { userId: true },
  });
  return { count: owners.length, isOwner: owners.some((o) => o.userId === userId) };
}

/** Change a member's role. */
settingsRouter.patch('/members/:userId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const userId = String(req.params.userId);
  const input = updateMemberSchema.parse(req.body);

  const membership = await prisma.membership.findFirst({
    where: { orgId: actor.orgId, userId },
    select: { id: true, role: true },
  });
  if (!membership) throw notFound('Member');
  if (membership.role === input.role) {
    res.json({ member: { userId, role: membership.role }, changed: false });
    return;
  }

  const { count, isOwner } = await ownerGuard(actor.orgId, userId);
  if (isOwner && count === 1) {
    throw badRequest(
      'This is the only owner. Promote someone else to owner first, then change this role.',
    );
  }

  /*
   * Only an OWNER may mint another OWNER. ADMIN can otherwise administer the
   * org, but handing out the one role that can remove the person who granted it
   * is an escalation, not an administration task.
   */
  if (input.role === 'OWNER' && actor.role !== 'OWNER') {
    throw badRequest('Only an owner can make someone else an owner.');
  }

  /*
   * AND ONLY AN OWNER MAY DEMOTE ONE — the other half of the same rule, which
   * was missing while `DELETE /settings/members/:userId` had it.
   *
   * The asymmetry was the defect: an ADMIN passes `requireRole('ADMIN')`, the
   * last-OWNER guard above does not fire while a second OWNER exists, and
   * `input.role` is not 'OWNER' when demoting, so every guard on this route
   * declined to look. A measured `PATCH /settings/members/<owner>` with
   * `{ role: 'MEMBER' }` from an ADMIN session answered 200 and the OWNER
   * became a MEMBER. Removing an OWNER was already refused here; demoting one
   * reaches the same end by a different verb, and an ADMIN stripping the
   * founder's role is the escalation the rank rule exists to stop.
   *
   * Deliberately NOT gated on a brake mode. `ROLE_RANK_GUARD` has a brake entry
   * and no production reader, and an OBSERVE default here would leave the hole
   * open in every deployment; this refusal costs an ADMIN nothing they are
   * supposed to be able to do.
   */
  if (membership.role === 'OWNER' && actor.role !== 'OWNER') {
    throw badRequest('Only an owner can change the role of another owner.');
  }

  await prisma.membership.update({ where: { id: membership.id }, data: { role: input.role } });

  await audit({
    actor,
    action: 'member.role.change',
    targetType: 'User',
    targetId: userId,
    metadata: { from: membership.role, to: input.role },
  });

  res.json({ member: { userId, role: input.role }, changed: true });
});

/**
 * Remove someone from this organisation.
 *
 * Their user account and everything they authored survive — this ends their
 * access to one org, which is what "remove from the team" means when a person
 * can belong to several. Their sessions in THIS org are cut immediately.
 */
settingsRouter.delete('/members/:userId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const userId = String(req.params.userId);

  const membership = await prisma.membership.findFirst({
    where: { orgId: actor.orgId, userId },
    select: { id: true, role: true },
  });
  if (!membership) throw notFound('Member');

  const { count, isOwner } = await ownerGuard(actor.orgId, userId);
  if (isOwner && count === 1) {
    throw badRequest('This is the only owner. Make someone else an owner before removing them.');
  }
  if (membership.role === 'OWNER' && actor.role !== 'OWNER') {
    throw badRequest('Only an owner can remove another owner.');
  }

  await prisma.membership.delete({ where: { id: membership.id } });

  /*
   * A session carries the org it is acting in. Leaving one alive would let a
   * removed member keep reading this org's data until it expired — up to
   * SESSION_TTL_HOURS after they were told they had been removed.
   */
  await unscoped(() =>
    prisma.session.updateMany({
      where: { userId, activeOrgId: actor.orgId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );

  await audit({
    actor,
    action: 'member.remove',
    targetType: 'User',
    targetId: userId,
    metadata: { role: membership.role },
  });

  res.json({ ok: true });
});

// ─── API keys (§1) ───────────────────────────────────────────────────────────

settingsRouter.get('/api-keys', async (req, res) => {
  const keys = await prisma.apiKey.findMany({
    where: { revokedAt: null },
    orderBy: { createdAt: 'desc' },
    // The hash is never returned; the prefix is the only recoverable part.
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scopes: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
    },
  });
  res.json({ keys });
});

/**
 * THE DEFAULTS THIS ROUTE HAS ALWAYS APPLIED, named so the schema can be wired
 * WITHOUT breaking the one client that calls it.
 *
 * `apps/web/app/settings/page.tsx:1142` posts `{ name }` and nothing else, so
 * applying `createApiKeySchema` to `req.body` raw would 400 the cockpit's own
 * "create key" button — the exact class of regression this round is cleaning
 * up. The defaults are filled in for ABSENT fields only, which is today's
 * behaviour exactly:
 *
 *   `scopes` absent  → `['runs:write', 'runs:read']`, as before.
 *   `expiresAt` absent → `null`. The schema makes it REQUIRED AND NULLABLE so a
 *   caller that thinks about expiry must say so; a caller that has never heard
 *   of it keeps the never-expires key it has always got.
 *
 * AN EXPLICIT `[]` IS NOT ABSENT, so it reaches `.min(1)` and is REFUSED. That
 * is the whole point: `{"scopes": []}` used to be storable and
 * `middleware/auth.ts` read it as the wildcard, so the restrictive-looking
 * request was the unrestricted one.
 */
function apiKeyCreateBody(body: unknown): unknown {
  const sent: Record<string, unknown> = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>) }
    : {};
  if (sent.scopes === undefined) sent.scopes = ['runs:write', 'runs:read'];
  if (sent.expiresAt === undefined) sent.expiresAt = null;
  return sent;
}

settingsRouter.post('/api-keys', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);

  const parsed = createApiKeySchema.safeParse(apiKeyCreateBody(req.body));
  if (!parsed.success) {
    /*
     * PATHS, NOT MESSAGES, the same way the allowlist endpoint does it. The
     * schema's refusals are written for a developer reading the API log and
     * quote the scope strings the caller sent; this response says which field
     * was refused and nothing a prober can learn the vocabulary from.
     */
    throw badRequest('That API key cannot be created', {
      refusedPaths: refusedPaths(parsed.error),
    });
  }
  const { name, scopes, expiresAt } = parsed.data;

  const { raw, hash, prefix } = generateApiKey();

  const key = await prisma.apiKey.create({
    // orgId is stamped by the tenancy extension; naming it satisfies the type.
    data: {
      orgId: actor.orgId,
      name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: [...scopes],
      expiresAt,
    },
    select: { id: true, name: true, keyPrefix: true, scopes: true, expiresAt: true, createdAt: true },
  });

  await audit({
    actor,
    action: 'apikey.create',
    targetType: 'ApiKey',
    targetId: key.id,
    metadata: { name, scopes, expiresAt },
  });

  // The only time the full key exists outside a CI's secret store. There is no
  // way to see it again — the client must copy it now.
  res.status(201).json({ key: { ...key, secret: raw, prefix: API_KEY_PREFIX } });
});

/**
 * ROTATION — minting the replacement while the old key still works.
 *
 * ── WHY THIS ROUTE EXISTS AT ALL ───────────────────────────────────────────
 *
 * `ApiKey.rotatedAt`, `ApiKey.replacesKeyId` and `ApiKey.rotationGraceUntil`
 * were columns with no writer, and `rotateApiKeySchema` was a schema with no
 * call site. Without them the only way to replace a key is `DELETE`, which
 * breaks every caller at the same instant — which is why keys do not get
 * replaced, and why a key from two years ago is still in somebody's pipeline.
 *
 * The reader is `rotationGraceOpen` in `middleware/auth.ts`: while the NEW
 * key's `rotationGraceUntil` is in the future, the OLD key keeps authorising
 * even though it is revoked.
 *
 * ── THE GRACE WINDOW IS THE DANGEROUS PART, AND IT IS BOUNDED ──────────────
 *
 * `graceMinutes` defaults to 0 — an immediate replacement — and the schema caps
 * it at a week, because a grace window nobody closes is two live keys, which is
 * the state rotation was called to end. It is recorded in the audit row so the
 * window is a fact somebody can be asked about.
 *
 * SCOPES ARE CARRIED OVER unless the caller narrows them. A rotation that
 * silently re-applied this route's creation defaults would WIDEN a key the
 * customer had restricted, which is a privilege escalation dressed as hygiene.
 */
settingsRouter.post('/api-keys/:keyId/rotate', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);

  const parsed = rotateApiKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw badRequest('That rotation cannot be performed', {
      refusedPaths: refusedPaths(parsed.error),
    });
  }

  // Tenancy-scoped: a key id from another org is simply not found, so this is
  // not an existence oracle for other tenants' key ids.
  const old = await prisma.apiKey.findUnique({
    where: { id: String(req.params.keyId) },
    select: { id: true, name: true, userId: true, scopes: true, expiresAt: true, revokedAt: true },
  });
  if (!old) throw notFound('API key');
  /*
   * A revoked key is not rotatable. Rotation revives its predecessor for the
   * grace window, so rotating something that was deliberately revoked would be
   * a way to UN-revoke a key that leaked. The remedy is to create a new key.
   */
  if (old.revokedAt) throw conflict('That key has been revoked; create a new one instead');

  const scopes = parsed.data.scopes ?? old.scopes;
  const now = new Date();
  const graceUntil =
    parsed.data.graceMinutes > 0
      ? new Date(now.getTime() + parsed.data.graceMinutes * 60_000)
      : null;

  const { raw, hash, prefix } = generateApiKey();

  const replacement = await prisma.apiKey.create({
    data: {
      orgId: actor.orgId,
      userId: old.userId,
      name: old.name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: [...scopes],
      expiresAt: old.expiresAt,
      replacesKeyId: old.id,
      rotationGraceUntil: graceUntil,
    },
    select: { id: true, name: true, keyPrefix: true, scopes: true, createdAt: true },
  });

  /*
   * The predecessor is revoked AND stamped `rotatedAt` in one write. Both
   * matter to the reader: `revokedAt` is what stops it once the window closes,
   * and `rotatedAt` is what distinguishes "revoked by a rotation" from "revoked
   * by a human", which is the only key the grace window may revive.
   */
  await prisma.apiKey.update({
    where: { id: old.id },
    data: { revokedAt: now, rotatedAt: now },
  });

  await audit({
    actor,
    action: 'apikey.rotate',
    targetType: 'ApiKey',
    targetId: replacement.id,
    metadata: {
      name: old.name,
      replacesKeyId: old.id,
      scopes,
      graceMinutes: parsed.data.graceMinutes,
      graceUntil,
    },
  });

  res.status(201).json({
    key: { ...replacement, secret: raw, prefix: API_KEY_PREFIX },
    replaced: { id: old.id, graceUntil },
  });
});

settingsRouter.delete('/api-keys/:keyId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const key = await prisma.apiKey.findUnique({ where: { id: String(req.params.keyId) } });
  if (!key) throw notFound('API key');

  await prisma.apiKey.update({
    where: { id: key.id },
    data: { revokedAt: new Date() },
  });

  await audit({
    actor,
    action: 'apikey.revoke',
    targetType: 'ApiKey',
    targetId: key.id,
    metadata: { name: key.name },
  });

  res.json({ ok: true });
});

// ─── Audit log (§1) ──────────────────────────────────────────────────────────

/**
 * The audit trail. Every mutation has been recorded since the first commit and
 * nothing ever read it back, which makes an audit log a compliance checkbox
 * rather than a tool. Actor ids are resolved to names in one extra query so the
 * log is readable rather than a wall of cuids.
 *
 * ADMIN-only: it names who did what, which is not everyone's business.
 */
settingsRouter.get('/audit', requireRole('ADMIN'), async (req, res) => {
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  const rows = await prisma.auditLog.findMany({
    where: { ...(action ? { action: { startsWith: action } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Number(req.query.limit ?? 200)),
  });

  if (req.query.format === 'csv') {
    res
      .type('text/csv')
      .setHeader('Content-Disposition', 'attachment; filename="qaai-audit.csv"')
      .send(auditRowsToCsv(rows));
    return;
  }

  // One lookup for every distinct actor, rather than N queries.
  const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))];
  const users = userIds.length
    ? await unscoped(() =>
        prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        }),
      )
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  res.json({
    entries: rows.map((r) => ({
      ...r,
      actor: r.userId
        ? (byId.get(r.userId)?.name ?? byId.get(r.userId)?.email ?? 'unknown')
        : 'system',
    })),
  });
});

// ─── Audit log & usage (§11, §9) ─────────────────────────────────────────────

/**
 * The audit trail. Every mutation has been recorded since the first commit —
 * actor, action, target, masked metadata — and nothing has ever read it back,
 * which makes an audit log a compliance checkbox rather than a tool.
 *
 * ADMIN-only: it names who did what, which is not everyone's business.
 */
/**
 * What the AI has cost. Every model call already records its tokens, its
 * latency and its price; none of it was visible, so "what am I paying for
 * this" was unanswerable — a bad property for a product that bills partly on
 * model usage.
 */
settingsRouter.get('/usage', async (req, res) => {
  const actor = actorOf(req);
  const days = Math.min(90, Number(req.query.days ?? 30));
  const since = new Date(Date.now() - days * 86_400_000);

  /*
   * Five sums and a count, computed by Postgres.
   *
   * This used to `findMany` every AgentCall in the window and add the columns up
   * in JavaScript. That is a linear read of a table that grows with every model
   * call the product makes: a busy org's 30-day window is hundreds of thousands
   * of rows, all of them serialised, shipped over the wire and turned into
   * objects so that six numbers could come out the other end. `groupBy` does the
   * same arithmetic where the rows already are and returns one row per agent —
   * five, today, and never more than AgentKind has members.
   *
   * Both queries run through the tenant-scoped client, so `orgId` is on the
   * where clause without being written here, and the pair is served by the
   * existing (orgId, createdAt) index.
   */
  const [totals, failures] = await Promise.all([
    prisma.agentCall.groupBy({
      by: ['agent'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, costCents: true },
    }),
    /*
     * A second pass rather than a CASE expression, because `_count` counts rows
     * and `error` is nullable: one groupBy cannot both count every call and
     * count the failed ones. Same index, same window, and the row count is the
     * number of agents.
     */
    prisma.agentCall.groupBy({
      by: ['agent'],
      where: { createdAt: { gte: since }, error: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const failuresByAgent = new Map(failures.map((row) => [row.agent, row._count._all]));

  const byAgent = totals
    .map((row) => ({
      agent: row.agent,
      calls: row._count._all,
      // Cache reads are tokens the org was billed for at a discount, not tokens
      // it did not send — the old loop folded them into input and this must keep
      // doing that or the number on the screen changes meaning.
      inputTokens: (row._sum.inputTokens ?? 0) + (row._sum.cacheReadTokens ?? 0),
      outputTokens: row._sum.outputTokens ?? 0,
      costCents: row._sum.costCents ?? 0,
      failures: failuresByAgent.get(row.agent) ?? 0,
    }))
    .sort((a, b) => b.costCents - a.costCents);

  /*
   * The ceiling next to the meter. The budget is deploy-wide env
   * (QAAI_MONTHLY_TOKEN_BUDGET, 0 = none); the spend is this org's
   * month-to-date row — the exact row the LLM gate reads before refusing a
   * call, so what this endpoint shows and what the gate enforces cannot drift.
   */
  const now = new Date();
  const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthRow = await prisma.usageRecord.findUnique({
    where: {
      orgId_metric_period: { orgId: actor.orgId, metric: 'agent_tokens', period },
    },
    select: { quantity: true },
  });

  res.json({
    days,
    // Summed from the groups rather than counted again: the groups already
    // partition every call in the window, so a third query would only be a
    // chance for the total and the breakdown to disagree.
    totalCalls: byAgent.reduce((sum, row) => sum + row.calls, 0),
    totalCostCents: byAgent.reduce((sum, row) => sum + row.costCents, 0),
    monthlyTokenBudget: env.QAAI_MONTHLY_TOKEN_BUDGET,
    tokensThisMonth: Number(monthRow?.quantity ?? 0n),
    byAgent,
  });
});

/**
 * Invite a teammate.
 *
 * The link this mints is now actually consumable: `POST /auth/signup` accepts
 * `invite` and joins the inviting org at the invited role. Until that landed,
 * every link here dropped the recipient into a brand-new organisation of their
 * own — the invite was a decoration on a single-user product.
 *
 * The link is BOTH emailed and returned. Emailed because that is what an invite
 * is; returned because a deployment with no SMTP host has no other way to
 * deliver it, and `delivery` tells the caller which of those two happened so the
 * UI can stop saying "sent" when nothing was.
 */
settingsRouter.post('/invites', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = inviteSchema.parse(req.body);

  /*
   * The same rule PATCH /members/:userId applies, in the same words, because an
   * invite is a role grant with a delay and the two must read as one policy.
   * Without it the sibling route's check was decorative: an ADMIN who could not
   * promote themselves directly could invite an address they control at OWNER,
   * accept it, and come back holding the role that moves money on the org's
   * card, exports every row it owns, and demotes the real owners.
   */
  if (input.role === 'OWNER' && actor.role !== 'OWNER') {
    throw badRequest('Only an owner can make someone else an owner.');
  }

  const email = input.email.toLowerCase();

  const existingUser = await unscoped(() =>
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
  );
  if (existingUser) {
    /*
     * Scoped to THIS org. The old check asked whether the person had any
     * membership anywhere and refused if so, which made it impossible to invite
     * a consultant who already belonged to another customer's org — a
     * cross-tenant leak in the other direction, since the answer depended on
     * data the caller cannot see.
     */
    const already = await prisma.membership.findFirst({
      where: { orgId: actor.orgId, userId: existingUser.id },
      select: { id: true },
    });
    if (already) throw conflict('That person is already in this organisation');
  }

  // Stored as a hash, exactly like an API key: the raw token is shown once and
  // is unrecoverable afterwards.
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);

  /*
   * Re-inviting the same address replaces the earlier invite rather than 409ing
   * on the @@unique([orgId, email]) constraint. An admin whose first invite went
   * to a typo'd inbox, or expired, otherwise had no way forward at all: there was
   * no revoke endpoint either.
   */
  const invite = await prisma.invite.upsert({
    where: { orgId_email: { orgId: actor.orgId, email } },
    create: {
      orgId: actor.orgId,
      email,
      role: input.role,
      tokenHash: hashToken(token),
      invitedBy: actor.userId,
      expiresAt,
    },
    update: {
      role: input.role,
      tokenHash: hashToken(token),
      invitedBy: actor.userId,
      expiresAt,
      // A re-invite is a fresh invite; an accepted one would otherwise stay closed.
      acceptedAt: null,
    },
    select: { id: true, email: true, role: true, expiresAt: true },
  });

  const acceptUrl = `${env.WEB_PUBLIC_URL}/signup?invite=${token}`;

  const org = await prisma.organization.findUnique({
    where: { id: actor.orgId },
    select: { name: true },
  });
  const inviter = await unscoped(() =>
    prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true, email: true } }),
  );

  let delivery: 'smtp' | 'console' | 'failed' = mailDriver();
  try {
    await sendMail(
      inviteMail(email, org?.name ?? 'QAAI', inviter?.name || inviter?.email || 'A teammate', acceptUrl),
    );
  } catch {
    // The invite row is already durable, so a mail failure must not lose it —
    // the link below still works. Reported so the UI can say to send it by hand.
    delivery = 'failed';
  }

  await audit({
    actor,
    action: 'invite.create',
    targetType: 'Invite',
    targetId: invite.id,
    metadata: { email, role: input.role, delivery },
  });

  res.status(201).json({
    invite,
    // Shown once so the admin can pass it on however they like.
    acceptUrl,
    delivery,
  });
});

/** Withdraw an invite that has not been used. */
settingsRouter.delete('/invites/:inviteId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const inviteId = String(req.params.inviteId);

  const invite = await prisma.invite.findFirst({
    where: { id: inviteId, orgId: actor.orgId },
    select: { id: true, email: true, acceptedAt: true },
  });
  if (!invite) throw notFound('Invite');
  if (invite.acceptedAt) {
    // Deleting it would not un-join them, and pretending otherwise is worse
    // than saying where the real control is.
    throw badRequest('That invitation was already accepted. Remove the member instead.');
  }

  await prisma.invite.delete({ where: { id: invite.id } });

  await audit({
    actor,
    action: 'invite.revoke',
    targetType: 'Invite',
    targetId: invite.id,
    metadata: { email: invite.email },
  });

  res.json({ ok: true });
});

settingsRouter.get('/invites', requireRole('ADMIN'), async (_req, res) => {
  const invites = await prisma.invite.findMany({
    where: { acceptedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  res.json({ invites });
});

// ─── Secret scopes, and the egress records ───────────────────────────────────

/**
 * WHICH FIELD WAS REFUSED — never the MESSAGE, and never the value.
 *
 * The convention in the older routes here is
 * `badRequest(parsed.error.issues[0]?.message)`, and that is a defect worth not
 * copying: a zod message QUOTES THE OFFENDING VALUE, and on these endpoints the
 * offending value is a reason string, an owner's email or a host somebody
 * typed — heading for a log line, a response body and an audit row. The path
 * and the code say which field and why without reproducing any of it.
 *
 * `apps/api/src/lib/pull-request.ts`'s `refusalPathsOf` takes the same position
 * for the same reason; this is that shape, local because that one is private.
 */
function refusedPaths(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }> }): string[] {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'} [${issue.code}]`);
}

/**
 * The environment a secret belongs to, confirmed against the actor's org.
 *
 * Read through the tenancy-scoped client, so a secret id from another tenant is
 * simply not found. Returning the ENVIRONMENT id as well is what lets the
 * caller be sure the scope row it writes names a secret in an environment this
 * org owns, rather than trusting an id out of the request.
 */
async function ownedSecret(secretId: string) {
  const secret = await prisma.secret.findUnique({
    where: { id: secretId },
    select: { id: true, name: true, environmentId: true },
  });
  if (!secret) throw notFound('No such secret');
  return secret;
}

/**
 * ── WHO MAY RECEIVE ONE ENVIRONMENT SECRET ──────────────────────────────────
 *
 * THE DEFECT: every decrypted environment secret was injected into every test.
 * A test that needed a Stripe test key also received the production database
 * password, and nothing recorded that it had. `SecretScope` is the fix and
 * `packages/runner/src/secrets.ts` is the reader — but `check-wiring` reported
 * the table DISCONNECTED, "written by nothing, every read returns an empty set
 * forever", and a default-DENY table with no writer is not a control, it is an
 * outage waiting for somebody to arm it.
 *
 * These three endpoints are the writer. They live here rather than beside the
 * secrets in `routes/projects.ts` because a scope is a SECURITY GRANT and not a
 * project setting — the row records who widened access to a credential and
 * why — and because this round's file ownership put `projects.ts` elsewhere.
 * (`routes/environments.ts`, which the round's brief named, does not exist in
 * this repository; environments and secrets are both served from
 * `projects.ts`.)
 *
 * ADMIN AND ABOVE. Writing a scope row widens who can read a credential, which
 * is the same grade of action as inviting a member, and MEMBER is the role a
 * FORM_LOGIN profile is edited by — the very hole the egress work is about.
 */
settingsRouter.get('/secrets/:secretId/scopes', requireRole('ADMIN'), async (req, res) => {
  const secret = await ownedSecret(String(req.params.secretId));
  const scopes = await prisma.secretScope.findMany({
    where: { secretId: secret.id },
    orderBy: { createdAt: 'asc' },
    /*
     * NO `secretId` AND NO VALUE OF THE SECRET ITSELF. The projection is the
     * grant, not the credential: `Secret.valueEnc` and `Secret.hint` are not
     * reachable from this read at all, so no widening of this endpoint can
     * start returning them by accident.
     */
    select: {
      id: true,
      kind: true,
      value: true,
      reason: true,
      createdBy: true,
      createdAt: true,
    },
  });
  res.json({
    secret: { id: secret.id, name: secret.name },
    scopes,
    /*
     * THE ABSENCE IS THE DENIAL, said out loud. An empty list here does not
     * mean "no restrictions", it means this secret reaches no test — which is
     * the opposite reading, and the one an operator will assume unless told.
     * The mode is what decides whether that denial is applied or only counted.
     */
    reachesNothing: scopes.length === 0,
  });
});

/*
 * `requireScope('secrets:write')` ON THE TWO WRITES, and the reason the GET
 * above does not carry one.
 *
 * THE DEFECT, MEASURED on this tree: 151 of the 184 mutating route
 * declarations under `routes/` carry no `requireScope`, so a key a customer
 * created as `runs:read` could widen who may read a production credential.
 * `secrets:write` is the name `routes/projects.ts` already gates every
 * environment-secret write on (`:469`, `:617`, `:651`) — the same vocabulary,
 * not a seventh spelling, which `API_KEY_SCOPES` exists to prevent.
 *
 * It is the two WRITES only. The read returns no secret value and no secretId
 * — it is the grant, not the credential — and a scope check on it would be a
 * refusal with nothing behind it.
 *
 * ── WHAT IS STILL UNSCOPED HERE, AND WHY IT IS NOT MISLABELLED ─────────────
 *
 * Eleven mutating routes in this file; these two are now scoped. The other
 * NINE — members ×2, api-keys ×3, invites ×2, egress-allowlist ×2 — are org
 * ADMINISTRATION, and no member of `API_KEY_SCOPES` honestly names that. The
 * six members are `tests:read|write`, `runs:read|write`, `secrets:write` and
 * `git:push`, enumerated from the routes that already gate on them. Labelling
 * a member-role change `secrets:write` would make a key the customer believes
 * is narrower than it is, which is the precise failure that vocabulary was
 * enumerated to prevent.
 *
 * THE EDIT THAT CLOSES THEM is one member added to `API_KEY_SCOPES` in
 * packages/shared/src/constants.ts — a file this round's ownership puts
 * elsewhere — after which `requireScope('org:admin')` belongs on all nine.
 * `POST /api-keys` and its rotate sibling are the sharpest of them: a key that
 * can mint a key can mint one with WIDER scopes than its own, so an
 * org-administration scope is the floor and refusing API keys outright may be
 * the right answer. That refusal would be a new control and needs a brake name,
 * which is also in `packages/shared`, so it is named here rather than smuggled
 * in unbrakeable.
 */
settingsRouter.post(
  '/secrets/:secretId/scopes',
  requireRole('ADMIN'),
  requireScope('secrets:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const secret = await ownedSecret(String(req.params.secretId));

    const parsed = secretScopeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('That scope cannot be stored', { refusedPaths: refusedPaths(parsed.error) });
    }

    /*
     * The unique is (secretId, kind, value) and a duplicate is REFUSED rather
     * than merged: two rows for the same grant are two authors who each believed
     * they were the one who opened it, and the audit cannot then say who.
     * `value` is null for ENVIRONMENT_WIDE, and Postgres treats two nulls as
     * distinct in a unique index — so that one case is checked here explicitly,
     * because the database will not do it.
     */
    if (parsed.data.value === null) {
      const existing = await prisma.secretScope.findFirst({
        where: { secretId: secret.id, kind: parsed.data.kind, value: null },
        select: { id: true },
      });
      if (existing) throw conflict('That scope already exists');
    }

    let scope: { id: string };
    try {
      scope = await prisma.secretScope.create({
        data: {
          orgId: actor.orgId,
          secretId: secret.id,
          kind: parsed.data.kind,
          value: parsed.data.value,
          reason: parsed.data.reason,
          // The record of WHO granted access to a credential, which must outlive
          // the account that did it — hence a string and not a relation.
          createdBy: actor.userId || null,
        },
        select: { id: true },
      });
    } catch {
      throw conflict('That scope already exists');
    }

    await audit({
      actor,
      action: 'secret.scope.granted',
      targetType: 'Secret',
      targetId: secret.id,
      /*
       * The KIND and what it names, never the secret's value and never the
       * reason text. The kind is the blast radius and is the thing worth
       * alerting on; the reason is a free-text field somebody typed and has no
       * business in an audit row that is exported to CSV.
       */
      metadata: { kind: parsed.data.kind, names: parsed.data.value, secretName: secret.name },
    });

    res.status(201).json({ scope: { id: scope.id } });
  },
);

settingsRouter.delete(
  '/secrets/:secretId/scopes/:scopeId',
  requireRole('ADMIN'),
  requireScope('secrets:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const secret = await ownedSecret(String(req.params.secretId));
    const scope = await prisma.secretScope.findFirst({
      where: { id: String(req.params.scopeId), secretId: secret.id },
      select: { id: true, kind: true, value: true },
    });
    if (!scope) throw notFound('No such scope');

    await prisma.secretScope.delete({ where: { id: scope.id } });
    await audit({
      actor,
      action: 'secret.scope.revoked',
      targetType: 'Secret',
      targetId: secret.id,
      metadata: { kind: scope.kind, names: scope.value, secretName: secret.name },
    });
    res.status(204).end();
  },
);

/**
 * ── THE EGRESS ALLOWLIST: A HOST THAT IS REACHABLE ON PURPOSE ───────────────
 *
 * `EgressAllowlistEntry` was DISCONNECTED — "a schema entry for a feature that
 * does not exist" — while `egressAllowlistEntrySchema` already existed and
 * already refused an entry with no owner and no reason. This is the door.
 *
 * It exists because the egress policy is deliberately strict: HOSTED permits
 * PUBLIC ONLY, so a customer whose staging application genuinely lives on
 * `10.0.0.5` has exactly two honest escapes — the SELF_HOSTED deployment mode,
 * or naming that host here with an owner and a reason. An OBSERVE mode would
 * have been the third and it is the wrong one, because it turns the control off
 * for everything rather than opening one door.
 *
 * OWNER-ONLY, which is stricter than the scopes above. An allowlist entry makes
 * a private address reachable from inside our infrastructure — it is an SSRF
 * with paperwork, and the paperwork is what makes it survive review — so it is
 * the one grant that is not delegated to ADMIN.
 */
settingsRouter.get(
  '/environments/:environmentId/egress-allowlist',
  requireRole('ADMIN'),
  async (req, res) => {
    const environmentId = String(req.params.environmentId);
    // Scoped read: an environment id from another tenant is not found.
    const environment = await prisma.environment.findUnique({
      where: { id: environmentId },
      select: { id: true, name: true, egressPolicy: true },
    });
    if (!environment) throw notFound('No such environment');

    const entries = await prisma.egressAllowlistEntry.findMany({
      where: { environmentId: environment.id },
      orderBy: { host: 'asc' },
      select: {
        id: true,
        host: true,
        contexts: true,
        ownerEmail: true,
        reason: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    /*
     * The RESOLVED policy beside the stored column, because they are two facts
     * and an operator reading one needs the other: an unparseable column
     * resolves to the HOSTED policy (PUBLIC ONLY), and without saying so the
     * page would render an empty permitted list as "nothing is permitted"
     * rather than "this column did not parse and the strict default is in
     * force".
     */
    const resolved = resolveEgressPolicy(environment.egressPolicy);
    res.json({
      environment: { id: environment.id, name: environment.name },
      entries,
      policy: {
        mode: resolved.mode,
        deployment: resolved.deployment,
        permittedClasses: resolved.permittedClasses,
      },
    });
  },
);

settingsRouter.post(
  '/environments/:environmentId/egress-allowlist',
  requireRole('OWNER'),
  async (req, res) => {
    const actor = actorOf(req);
    const environment = await prisma.environment.findUnique({
      where: { id: String(req.params.environmentId) },
      select: { id: true },
    });
    if (!environment) throw notFound('No such environment');

    const parsed = egressAllowlistEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      /*
       * PATHS, NOT MESSAGES — and here it matters most on this endpoint. The
       * schema's own refusals quote the host and the reason ("is not a host
       * QAAI can read", "may not be a wildcard"), and the host is the one
       * string on this request that an attacker chose.
       */
      throw badRequest('That allowlist entry cannot be stored', {
        refusedPaths: refusedPaths(parsed.error),
      });
    }

    const entry = await prisma.egressAllowlistEntry.upsert({
      // Unique on (orgId, environmentId, host) — an EXACT host, never a suffix
      // and never a pattern. A second entry for the same host is an edit.
      where: {
        orgId_environmentId_host: {
          orgId: actor.orgId,
          environmentId: environment.id,
          host: parsed.data.host,
        },
      },
      create: {
        orgId: actor.orgId,
        environmentId: environment.id,
        host: parsed.data.host,
        contexts: [...parsed.data.contexts],
        ownerEmail: parsed.data.ownerEmail,
        reason: parsed.data.reason,
        expiresAt: parsed.data.expiresAt,
        createdBy: actor.userId || null,
      },
      update: {
        contexts: [...parsed.data.contexts],
        ownerEmail: parsed.data.ownerEmail,
        reason: parsed.data.reason,
        expiresAt: parsed.data.expiresAt,
      },
      select: { id: true, host: true },
    });

    await audit({
      actor,
      action: 'egress.allowlist.written',
      targetType: 'Environment',
      targetId: environment.id,
      /*
       * The HOST and the CONTEXTS are the blast radius and belong here. The
       * reason text does not: it is free text somebody typed, this row is
       * exported to CSV, and the audit's job is to say what was opened rather
       * than to reproduce the argument for it.
       */
      metadata: { host: entry.host, contexts: parsed.data.contexts, owner: parsed.data.ownerEmail },
    });

    res.status(201).json({ entry });
  },
);

settingsRouter.delete(
  '/environments/:environmentId/egress-allowlist/:entryId',
  requireRole('OWNER'),
  async (req, res) => {
    const actor = actorOf(req);
    const entry = await prisma.egressAllowlistEntry.findFirst({
      where: {
        id: String(req.params.entryId),
        environmentId: String(req.params.environmentId),
      },
      select: { id: true, host: true, environmentId: true },
    });
    if (!entry) throw notFound('No such allowlist entry');

    await prisma.egressAllowlistEntry.delete({ where: { id: entry.id } });
    await audit({
      actor,
      action: 'egress.allowlist.removed',
      targetType: 'Environment',
      targetId: entry.environmentId,
      metadata: { host: entry.host },
    });
    res.status(204).end();
  },
);

/**
 * ── WHAT THE EGRESS CONTROL ACTUALLY REFUSED, PER DAY ───────────────────────
 *
 * `EgressDecisionTally` was the third DISCONNECTED table. It is the answer to
 * the one question an operator must be able to ask before arming a brake:
 * "what would ENFORCE have stopped?" A mode that counts nothing is an off
 * switch with a reassuring name, and a count nobody can read is the same thing
 * one step later.
 *
 * ADMIN rather than OWNER: reading what was refused is diagnosis, and the rows
 * carry no credential — a host, a class, an outcome and a count.
 */
settingsRouter.get('/egress-tally', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const rows = await prisma.egressDecisionTally.findMany({
    /*
     * `bucketDate`, NOT `day`. Worth a comment because the first draft of this
     * query said `day` and TYPECHECKED: with several unknown keys in one
     * Prisma argument object the inference collapses to a looser overload and
     * the excess-property check stops firing, so the only symptom would have
     * been a runtime validation error on a page nobody loads until an incident.
     * A single wrong key DOES error; it is the combination that hides it.
     */
    where: { orgId: actor.orgId, bucketDate: { gte: since } },
    orderBy: [{ bucketDate: 'desc' }, { count: 'desc' }],
    take: 500,
    select: {
      bucketDate: true,
      context: true,
      outcome: true,
      addressClass: true,
      refusal: true,
      host: true,
      count: true,
      hostsOmitted: true,
    },
  });

  /*
   * `hostsOmitted` is summed and REPORTED rather than dropped, because it is
   * what makes these numbers readable as a FLOOR. A cap that bit and was not
   * disclosed turns "we refused 12 hosts" into a measurement nobody can
   * qualify — lie #3, a cap applied without being counted.
   */
  const omitted = rows.reduce((total, row) => total + row.hostsOmitted, 0);
  res.json({
    rows,
    windowDays: 30,
    hostsOmitted: omitted,
    /*
     * Named `isFloor` rather than `complete: false`, because the two readings
     * of one boolean are exactly the confusion worth avoiding: these counts are
     * never an over-estimate, and a reader who sees a cap disclosed should know
     * which direction the error runs.
     */
    isFloor: omitted > 0 || rows.length === 500,
  });
});
