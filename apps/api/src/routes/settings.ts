/**
 * Org settings (§8): members, API keys, audit log.
 *
 * API keys are the load-bearing part — the CLI and CI have no session, so a key
 * is the only way they authenticate (§1). The raw key is shown exactly once, at
 * creation; only its hash is stored, so a database leak hands out no live
 * credentials.
 */

import { Router } from 'express';
import { API_KEY_PREFIX, inviteSchema, updateMemberSchema } from '@qaai/shared';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { generateApiKey, generateToken, hashToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { auditRowsToCsv } from '../lib/audit.js';
import { inviteMail, mailDriver, sendMail } from '../lib/mail.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
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

settingsRouter.post('/api-keys', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw badRequest('A name is required');

  const scopes: string[] = Array.isArray(req.body?.scopes)
    ? req.body.scopes
    : ['runs:write', 'runs:read'];

  const { raw, hash, prefix } = generateApiKey();

  const key = await prisma.apiKey.create({
    // orgId is stamped by the tenancy extension; naming it satisfies the type.
    data: { orgId: actor.orgId, name, keyHash: hash, keyPrefix: prefix, scopes },
    select: { id: true, name: true, keyPrefix: true, scopes: true, createdAt: true },
  });

  await audit({
    actor,
    action: 'apikey.create',
    targetType: 'ApiKey',
    targetId: key.id,
    metadata: { name, scopes },
  });

  // The only time the full key exists outside a CI's secret store. There is no
  // way to see it again — the client must copy it now.
  res.status(201).json({ key: { ...key, secret: raw, prefix: API_KEY_PREFIX } });
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
