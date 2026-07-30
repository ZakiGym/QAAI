/**
 * Authentication and RBAC (§1).
 *
 * Two credential types reach this middleware: a session cookie (the cockpit)
 * and an API key (the CLI and CI). Both resolve to the same ActorContext, so
 * every downstream handler is written once.
 *
 * The tenancy scope is opened here and nowhere else — `requireAuth` wraps the
 * rest of the request in `withTenant(orgId, …)`, which is what makes the Prisma
 * extension's guarantees hold.
 */

import type { NextFunction, Request, Response } from 'express';
import { API_KEY_PREFIX, ROLE_RANK } from '@qaai/shared';
import type { ActorContext, OrgRole } from '@qaai/shared';
import { prisma, unscoped, withTenant } from '../lib/prisma.js';
import { hashToken } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { setRequestActor } from '../lib/logger.js';

export const SESSION_COOKIE = 'qaai_session';

declare module 'express-serve-static-core' {
  interface Request {
    actor?: ActorContext;
  }
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function clientIp(req: Request): string | null {
  // Trust the first hop only; the proxy in front sets this and anything further
  // left is client-supplied and forgeable.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? null;
}

async function actorFromSession(req: Request): Promise<ActorContext | null> {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;

  // Unscoped: sessions are global and this runs before any org is known.
  const session = await unscoped(() =>
    prisma.session.findUnique({
      where: { tokenHash: hashToken(raw) },
      select: { userId: true, activeOrgId: true, expiresAt: true, revokedAt: true },
    }),
  );

  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

  const membership = await unscoped(() =>
    session.activeOrgId
      ? prisma.membership.findUnique({
          where: { orgId_userId: { orgId: session.activeOrgId, userId: session.userId } },
          select: { orgId: true, role: true },
        })
      : prisma.membership.findFirst({
          where: { userId: session.userId },
          orderBy: { createdAt: 'asc' },
          select: { orgId: true, role: true },
        }),
  );

  if (!membership) return null;

  return {
    userId: session.userId,
    orgId: membership.orgId,
    role: membership.role as OrgRole,
    apiKeyId: null,
    scopes: ['*'],
    impersonatedBy: null,
    ip: clientIp(req),
  };
}

async function actorFromApiKey(req: Request): Promise<ActorContext | null> {
  const header = req.headers.authorization;
  const raw = header?.startsWith('Bearer ')
    ? header.slice(7).trim()
    : typeof req.headers['x-api-key'] === 'string'
      ? req.headers['x-api-key']
      : null;

  if (!raw || !raw.startsWith(API_KEY_PREFIX)) return null;

  const key = await unscoped(() =>
    prisma.apiKey.findUnique({
      where: { keyHash: hashToken(raw) },
      select: {
        id: true,
        orgId: true,
        userId: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
      },
    }),
  );

  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) return null;

  // lastUsedAt is useful for key hygiene but must not block the request.
  void unscoped(() =>
    prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }),
  ).catch(() => {});

  const role: OrgRole = key.userId
    ? (((
        await unscoped(() =>
          prisma.membership.findUnique({
            where: { orgId_userId: { orgId: key.orgId, userId: key.userId! } },
            select: { role: true },
          }),
        )
      )?.role as OrgRole) ?? 'MEMBER')
    : 'MEMBER';

  return {
    userId: key.userId ?? '',
    orgId: key.orgId,
    role,
    apiKeyId: key.id,
    scopes: key.scopes.length > 0 ? key.scopes : ['*'],
    impersonatedBy: null,
    ip: clientIp(req),
  };
}

/**
 * Resolves the actor if one is present, but does not reject. Used on routes
 * that behave differently when signed in (the marketing site, health).
 */
export async function attachActor(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.actor = (await actorFromSession(req)) ?? (await actorFromApiKey(req)) ?? undefined;
  if (req.actor) setRequestActor(req.actor.userId, req.actor.orgId);
  next();
}

/** Rejects anonymous callers and opens the tenancy scope for everything after. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.actor) {
    req.actor = (await actorFromSession(req)) ?? (await actorFromApiKey(req)) ?? undefined;
  }
  if (!req.actor) {
    next(unauthorized());
    return;
  }
  setRequestActor(req.actor.userId, req.actor.orgId);
  withTenant(req.actor.orgId, () => next());
}

/** Requires at least `minimum`. OWNER > ADMIN > MEMBER > VIEWER. */
export function requireRole(minimum: OrgRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.actor) {
      next(unauthorized());
      return;
    }
    if (ROLE_RANK[req.actor.role] < ROLE_RANK[minimum]) {
      next(forbidden(`This action requires the ${minimum} role or higher`));
      return;
    }
    next();
  };
}

/** Requires a specific API-key scope. Session actors hold every scope. */
export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.actor) {
      next(unauthorized());
      return;
    }
    const { scopes } = req.actor;
    if (!scopes.includes('*') && !scopes.includes(scope)) {
      next(forbidden(`This API key is missing the "${scope}" scope`));
      return;
    }
    next();
  };
}

export function actorOf(req: Request): ActorContext {
  if (!req.actor) throw unauthorized();
  return req.actor;
}
