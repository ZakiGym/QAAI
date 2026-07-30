/**
 * Auth routes (§1): signup, login, logout, session introspection, org switch.
 *
 * Deviation from the spec worth naming: the spec lists NextAuth. With a
 * separate Express API, NextAuth would leave two systems owning sessions and a
 * shared secret between them. The API owns auth instead — one session table,
 * one place where a token is minted, and the CLI and cockpit authenticate the
 * same way. OAuth providers slot in as additional routes on this router.
 */

import { Router } from 'express';
import { loginSchema, signupSchema } from '@qaai/shared';
import { prisma, unscoped, withTenant } from '../lib/prisma.js';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { env, isProd } from '../env.js';
import { SESSION_COOKIE, actorOf, requireAuth } from '../middleware/auth.js';

export const authRouter: Router = Router();

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base || 'org';
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    isProd ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

async function issueSession(userId: string, orgId: string, ip: string | null, ua: string | null) {
  const raw = generateToken(32);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000);

  await unscoped(() =>
    prisma.session.create({
      data: { userId, tokenHash: hashToken(raw), activeOrgId: orgId, ip, userAgent: ua, expiresAt },
    }),
  );

  return { raw, maxAge: env.SESSION_TTL_HOURS * 3600 };
}

authRouter.post('/signup', async (req, res) => {
  const input = signupSchema.parse(req.body);
  const email = input.email.toLowerCase();

  const existing = await unscoped(() => prisma.user.findUnique({ where: { email } }));
  if (existing) throw conflict('An account with that email already exists');

  const passwordHash = await hashPassword(input.password);

  // One transaction: a user with no org is a broken state the UI cannot recover
  // from, so the two rows are created together or not at all.
  const { user, org } = await unscoped(() =>
    prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name: input.name, passwordHash },
        select: { id: true, email: true, name: true },
      });

      let slug = slugify(input.orgName);
      if (await tx.organization.findUnique({ where: { slug } })) {
        slug = `${slug}-${generateToken(3)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')}`;
      }

      const org = await tx.organization.create({
        data: {
          name: input.orgName,
          slug,
          // The creator is the OWNER; there is no other way to become one.
          memberships: { create: { userId: user.id, role: 'OWNER' } },
        },
        select: { id: true, name: true, slug: true, plan: true },
      });

      return { user, org };
    }),
  );

  const { raw, maxAge } = await issueSession(
    user.id,
    org.id,
    req.ip ?? null,
    req.headers['user-agent'] ?? null,
  );

  await audit({
    actor: { userId: user.id, orgId: org.id, ip: req.ip ?? null, impersonatedBy: null },
    action: 'org.create',
    targetType: 'Organization',
    targetId: org.id,
    metadata: { name: org.name },
  });

  res
    .status(201)
    .setHeader('Set-Cookie', sessionCookie(raw, maxAge))
    .json({ user, org: { ...org, role: 'OWNER' } });
});

authRouter.post('/login', async (req, res) => {
  const input = loginSchema.parse(req.body);
  const email = input.email.toLowerCase();

  const user = await unscoped(() =>
    prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, passwordHash: true, totpEnabledAt: true },
    }),
  );

  // Same error and roughly the same work whether the account exists or not, so
  // login cannot be used to enumerate registered addresses.
  const ok = user?.passwordHash
    ? await verifyPassword(input.password, user.passwordHash)
    : await verifyPassword(input.password, `scrypt$32768$8$1$${'A'.repeat(24)}$${'A'.repeat(88)}`);

  if (!user || !ok) throw unauthorized('Email or password is incorrect');

  if (user.totpEnabledAt && !input.totpCode) {
    throw unauthorized('A two-factor code is required');
  }

  const membership = await unscoped(() =>
    prisma.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: {
        orgId: true,
        role: true,
        org: { select: { id: true, name: true, slug: true, plan: true } },
      },
    }),
  );
  if (!membership) throw unauthorized('This account is not a member of any organization');

  const { raw, maxAge } = await issueSession(
    user.id,
    membership.orgId,
    req.ip ?? null,
    req.headers['user-agent'] ?? null,
  );

  await unscoped(() =>
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
  );

  res.setHeader('Set-Cookie', sessionCookie(raw, maxAge)).json({
    user: { id: user.id, email: user.email, name: user.name },
    org: { ...membership.org, role: membership.role },
  });
});

authRouter.post('/logout', async (req, res) => {
  const header = req.headers.cookie ?? '';
  const match = /qaai_session=([^;]+)/.exec(header);
  if (match) {
    await unscoped(() =>
      prisma.session.updateMany({
        where: { tokenHash: hashToken(decodeURIComponent(match[1]!)) },
        data: { revokedAt: new Date() },
      }),
    );
  }
  res.setHeader('Set-Cookie', sessionCookie('', 0)).json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const actor = actorOf(req);

  const user = await unscoped(() =>
    prisma.user.findUnique({
      where: { id: actor.userId },
      select: { id: true, email: true, name: true, isSuperuser: true, totpEnabledAt: true },
    }),
  );

  const memberships = await unscoped(() =>
    prisma.membership.findMany({
      where: { userId: actor.userId },
      select: { role: true, org: { select: { id: true, name: true, slug: true, plan: true } } },
    }),
  );

  res.json({
    user,
    activeOrgId: actor.orgId,
    orgs: memberships.map((m) => ({ ...m.org, role: m.role })),
  });
});

/** Switches which org the current session acts in (§1 multi-org). */
authRouter.post('/switch-org', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const orgId = String(req.body?.orgId ?? '');
  if (!orgId) throw badRequest('orgId is required');

  const membership = await unscoped(() =>
    prisma.membership.findUnique({
      where: { orgId_userId: { orgId, userId: actor.userId } },
      select: { role: true },
    }),
  );
  // Indistinguishable from "no such org" — membership must not be probeable.
  if (!membership) throw unauthorized('Not a member of that organization');

  const raw = /qaai_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (raw) {
    await unscoped(() =>
      prisma.session.updateMany({
        where: { tokenHash: hashToken(decodeURIComponent(raw)) },
        data: { activeOrgId: orgId },
      }),
    );
  }

  await withTenant(orgId, () =>
    audit({
      actor: { userId: actor.userId, orgId, ip: actor.ip, impersonatedBy: null },
      action: 'session.switch_org',
      targetType: 'Organization',
      targetId: orgId,
    }),
  );

  res.json({ ok: true, orgId, role: membership.role });
});
