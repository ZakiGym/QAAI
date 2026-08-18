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
import {
  changePasswordSchema,
  loginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  signupSchema,
} from '@qaai/shared';
import type { OrgRole } from '@qaai/shared';
import { prisma, unscoped, withTenant } from '../lib/prisma.js';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { mailDriver, passwordResetMail, sendMail } from '../lib/mail.js';
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

/**
 * Look up an invite by its raw token, refusing anything a user must not join.
 *
 * Returned rather than thrown-through so `GET /auth/invite` can render the
 * reason on the signup screen instead of a bare 400 — "that invitation has
 * expired, ask for another" is actionable; "Bad Request" is not.
 */
interface PendingInvite {
  id: string;
  email: string;
  role: OrgRole;
  orgId: string;
  /** Who sent it. Read at acceptance to decide whether an OWNER seat is theirs to give. */
  invitedBy: string;
  org: { id: string; name: string; slug: string; plan: string };
}

/*
 * Discriminated on a literal `ok`, not on the presence of a field. `'error' in
 * found` and a truthiness check both left `invite` as possibly-undefined at
 * every call site, because an optional property is not a discriminant.
 */
type InviteLookup = { ok: false; error: string } | { ok: true; invite: PendingInvite };

async function findInvite(token: string): Promise<InviteLookup> {
  const invite = await unscoped(() =>
    prisma.invite.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        email: true,
        role: true,
        orgId: true,
        invitedBy: true,
        expiresAt: true,
        acceptedAt: true,
        org: { select: { id: true, name: true, slug: true, plan: true } },
      },
    }),
  );

  if (!invite) return { ok: false, error: 'That invitation link is not valid.' };
  // Single use. Without this the same link joins the org again on every visit.
  if (invite.acceptedAt) return { ok: false, error: 'That invitation has already been used.' };
  if (invite.expiresAt < new Date()) {
    return { ok: false, error: 'That invitation has expired. Ask for a new one.' };
  }
  return { ok: true, invite };
}

/**
 * The role an invite can actually grant.
 *
 * The stored role is not taken on trust. `POST /settings/invites` refuses an
 * ADMIN who asks for an OWNER invite, but rows written before that check landed
 * are still in the table and THIS is the site that hands out the membership, so
 * an OWNER seat is granted only when the person who sent the invite held OWNER
 * themselves.
 *
 * What disagreed, and what it cost: the invite row said OWNER while nobody with
 * the authority to grant OWNER had chosen it. An ADMIN who could not promote
 * themselves through `PATCH /settings/members/:userId` invited an address they
 * controlled at OWNER, accepted it, and came back holding the role that charges
 * the org's card, exports every row it owns, sweeps artifacts irreversibly, and
 * demotes the real owners. Do not drop this because the invite route now checks
 * too — one check at the write site is one bug away from the same escalation.
 *
 * Clamped to ADMIN rather than refused: the recipient did nothing wrong, and a
 * link that dead-ends is a support ticket for a role they were never owed.
 */
async function grantableRole(invite: PendingInvite): Promise<OrgRole> {
  if (invite.role !== 'OWNER') return invite.role;

  const inviter = await unscoped(() =>
    prisma.membership.findFirst({
      where: { orgId: invite.orgId, userId: invite.invitedBy },
      select: { role: true },
    }),
  );
  return inviter?.role === 'OWNER' ? 'OWNER' : 'ADMIN';
}

/**
 * What an invite link is for, so the signup screen can say who invited you and
 * which organisation you are joining before you type anything.
 *
 * Unauthenticated on purpose — the whole point is that the recipient has no
 * account yet. It reveals only the org name and the invited email, both of which
 * the holder of the token already knows because they were sent them.
 */
authRouter.get('/invite', async (req, res) => {
  const token = String(req.query.token ?? '');
  if (!token) throw badRequest('A token is required');

  const found = await findInvite(token);
  if (!found.ok) {
    res.status(410).json({ valid: false, reason: found.error });
    return;
  }

  res.json({
    valid: true,
    email: found.invite.email,
    // The role signup will actually grant, not the one the row asks for. The
    // screen saying "join as owner" and the membership coming out ADMIN is the
    // same disagreement one step earlier.
    role: await grantableRole(found.invite),
    org: { name: found.invite.org.name },
  });
});

authRouter.post('/signup', async (req, res) => {
  const input = signupSchema.parse(req.body);
  const email = input.email.toLowerCase();

  const existing = await unscoped(() => prisma.user.findUnique({ where: { email } }));
  if (existing) throw conflict('An account with that email already exists');

  const passwordHash = await hashPassword(input.password);

  /*
   * Two paths. With an invite the organisation already exists and the new user
   * joins it at the role the inviter chose; without one they create their own
   * and own it.
   *
   * Both stay inside a single transaction for the same reason as before: a user
   * with no membership is a state the cockpit cannot render and the person
   * cannot escape.
   */
  let user: { id: string; email: string; name: string | null };
  let org: { id: string; name: string; slug: string; plan: string };
  let role: string;
  let joinedExisting = false;

  if (input.invite) {
    const found = await findInvite(input.invite);
    if (!found.ok) throw badRequest(found.error);
    const invite = found.invite;

    /*
     * The invite names an address, and that is the address that may use it.
     * Without this check anyone holding the link signs up as themselves and
     * takes the seat — an invite would be a bearer token for org membership.
     * Compared case-insensitively because the invite was stored as typed.
     */
    if (invite.email.toLowerCase() !== email) {
      throw badRequest(`That invitation was sent to ${invite.email}. Sign up with that address.`);
    }

    // Not `invite.role`: see grantableRole. This is the last gate before a
    // membership row exists, and the only one an old invite row cannot bypass.
    const granted = await grantableRole(invite);

    const result = await unscoped(() =>
      prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email, name: input.name, passwordHash },
          select: { id: true, email: true, name: true },
        });

        await tx.membership.create({
          data: { orgId: invite.orgId, userId: created.id, role: granted },
        });

        /*
         * Consumed inside the transaction, and conditionally: `acceptedAt: null`
         * in the WHERE makes the update itself the lock. Two people opening the
         * same link at the same moment would otherwise both pass the check in
         * findInvite and both get a seat.
         */
        const consumed = await tx.invite.updateMany({
          where: { id: invite.id, acceptedAt: null },
          data: { acceptedAt: new Date() },
        });
        if (consumed.count === 0) throw conflict('That invitation has already been used.');

        return created;
      }),
    );

    user = result;
    org = invite.org;
    role = granted;
    joinedExisting = true;
  } else {
    // The union in signupSchema guarantees this, but the compiler does not know
    // it from `input.invite` alone.
    const orgName = input.orgName!;

    const result = await unscoped(() =>
      prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email, name: input.name, passwordHash },
          select: { id: true, email: true, name: true },
        });

        let slug = slugify(orgName);
        if (await tx.organization.findUnique({ where: { slug } })) {
          slug = `${slug}-${generateToken(3)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')}`;
        }

        const organization = await tx.organization.create({
          data: {
            name: orgName,
            slug,
            // The creator is the OWNER; there is no other way to become one.
            memberships: { create: { userId: created.id, role: 'OWNER' } },
          },
          select: { id: true, name: true, slug: true, plan: true },
        });

        return { created, organization };
      }),
    );

    user = result.created;
    org = result.organization;
    role = 'OWNER';
  }

  const { raw, maxAge } = await issueSession(
    user.id,
    org.id,
    req.ip ?? null,
    req.headers['user-agent'] ?? null,
  );

  await audit({
    actor: { userId: user.id, orgId: org.id, ip: req.ip ?? null, impersonatedBy: null },
    action: joinedExisting ? 'invite.accept' : 'org.create',
    targetType: 'Organization',
    targetId: org.id,
    metadata: joinedExisting ? { email, role } : { name: org.name },
  });

  res
    .status(201)
    .setHeader('Set-Cookie', sessionCookie(raw, maxAge))
    .json({ user, org: { ...org, role } });
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

// ─── Passwords ───────────────────────────────────────────────────────────────
//
// A password could be set at signup and never again: no reset, no change, and
// no admin path either. A customer who forgot theirs was locked out of their
// organisation and their data permanently, and an org whose only OWNER forgot it
// was simply dead. The VerificationToken table has existed the whole time with
// "PASSWORD_RESET" named in a comment on it, and nothing ever wrote a row.

/** Short on purpose. A reset link is a password; it should not sit in an inbox for a day. */
const RESET_TTL_MINUTES = 60;

/**
 * Start a reset.
 *
 * ALWAYS answers the same thing, whether or not the address has an account.
 * Anything else turns this endpoint into a "does this person use QAAI?" oracle
 * that anyone can query, which is a customer-list leak and the reason the
 * response says "if an account exists".
 */
/**
 * Every response to /password/forgot takes at least this long.
 *
 * An identical body is not enough to close an enumeration oracle. Balancing the
 * two branches to do "the same shape of work" got the gap from 2.2x down to
 * 1.2x and no further — the branches are not identical and never will be, and a
 * ratio that depends on how fast Postgres felt today is not a security property.
 *
 * A fixed floor is, because it does not depend on the branch at all: do the
 * work, then wait until the budget is spent. The cost is that a legitimate
 * forgot-password request always takes 300ms, which nobody will ever notice on
 * an endpoint you hit once when you are already locked out.
 */
const FORGOT_TIME_BUDGET_MS = 300;

authRouter.post('/password/forgot', async (req, res) => {
  const startedAt = Date.now();
  const input = requestPasswordResetSchema.parse(req.body);
  const email = input.email.toLowerCase();

  const user = await unscoped(() =>
    prisma.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } }),
  );

  /*
   * SSO users have `passwordHash: null` by construction (see lib/sso.ts) and
   * must not be handed a way to set one — that would create a second credential
   * for an account the customer's IdP is supposed to control exclusively.
   */
  if (user && user.passwordHash !== null) {
    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

    await unscoped(async () => {
      /*
       * Any earlier unused reset for this address stops working the moment a new
       * one is asked for. Otherwise every request ever made stays live until it
       * expires, so a single leaked old email is enough.
       */
      await prisma.verificationToken.updateMany({
        where: { email, purpose: 'PASSWORD_RESET', usedAt: null },
        data: { usedAt: new Date() },
      });
      await prisma.verificationToken.create({
        data: { email, tokenHash: hashToken(token), purpose: 'PASSWORD_RESET', expiresAt },
      });
    });

    const url = `${env.WEB_PUBLIC_URL}/reset-password?token=${token}`;
    try {
      await sendMail(passwordResetMail(email, url, RESET_TTL_MINUTES));
    } catch {
      /*
       * Swallowed deliberately, and only here. The token is already durable, the
       * failure is logged with the address by lib/mail.ts, and the alternative —
       * a 500 — tells an unauthenticated caller that this particular address
       * exists, which is exactly what the uniform response above prevents.
       */
    }
  }

  // Spend whatever is left of the budget before answering. `max(0, …)` so a
  // request that somehow ran long is not made longer still.
  const remaining = FORGOT_TIME_BUDGET_MS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));

  res.json({
    ok: true,
    message: 'If an account exists for that address, a reset link is on its way.',
    /*
     * Told to the client so the screen can say "ask your administrator to check
     * the API log" instead of "check your email" on an install with no mail
     * server. The alternative is a user waiting forever for a message that was
     * never going to arrive.
     */
    delivery: mailDriver(),
  });
});

/** Finish a reset. Single use, expiring, and it ends every other session. */
authRouter.post('/password/reset', async (req, res) => {
  const input = resetPasswordSchema.parse(req.body);

  const record = await unscoped(() =>
    prisma.verificationToken.findUnique({
      where: { tokenHash: hashToken(input.token) },
      select: { id: true, email: true, purpose: true, expiresAt: true, usedAt: true },
    }),
  );

  const invalid = badRequest('That reset link is invalid or has expired. Ask for a new one.');
  if (!record || record.purpose !== 'PASSWORD_RESET') throw invalid;
  if (record.usedAt) throw invalid;
  if (record.expiresAt < new Date()) throw invalid;

  const user = await unscoped(() =>
    prisma.user.findUnique({ where: { email: record.email }, select: { id: true } }),
  );
  if (!user) throw invalid;

  const passwordHash = await hashPassword(input.password);

  await unscoped(() =>
    prisma.$transaction(async (tx) => {
      /*
       * Burn the token in the same transaction that changes the password, and
       * only if it is still unused — the update IS the lock, so two concurrent
       * uses of one link cannot both succeed.
       */
      const burned = await tx.verificationToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (burned.count === 0) throw invalid;

      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });

      /*
       * Every existing session dies. If the reset happened because someone else
       * had the account, leaving their session alive would make the reset
       * pointless — they would still be signed in.
       */
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }),
  );

  res.json({ ok: true });
});

/** Change your own password while signed in. Requires the current one. */
authRouter.post('/password/change', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const input = changePasswordSchema.parse(req.body);

  const user = await unscoped(() =>
    prisma.user.findUnique({
      where: { id: actor.userId },
      select: { id: true, passwordHash: true },
    }),
  );

  if (!user?.passwordHash) {
    // An SSO account has no password to change; saying so beats a wrong-password error.
    throw badRequest('This account signs in through your identity provider and has no password.');
  }

  /*
   * The current password is required even though the caller already holds a
   * session: it is what stops a borrowed laptop or a stolen cookie from becoming
   * permanent ownership of the account.
   */
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw badRequest('That is not your current password.');
  }

  const passwordHash = await hashPassword(input.newPassword);
  const currentToken = /qaai_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];

  await unscoped(() =>
    prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      /*
       * Other sessions are revoked; THIS one survives. Signing someone out of
       * the tab they just changed their password in reads as a failure, and
       * every other device is the thing actually worth cutting off.
       */
      await tx.session.updateMany({
        where: {
          userId: user.id,
          revokedAt: null,
          ...(currentToken
            ? { NOT: { tokenHash: hashToken(decodeURIComponent(currentToken)) } }
            : {}),
        },
        data: { revokedAt: new Date() },
      });
    }),
  );

  await audit({
    actor,
    action: 'user.password.change',
    targetType: 'User',
    targetId: user.id,
    metadata: {},
  });

  res.json({ ok: true });
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
