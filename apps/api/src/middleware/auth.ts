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
import { API_KEY_PREFIX, ROLE_RANK, controlEnforces, controlMode } from '@qaai/shared';
import type { ActorContext, OrgRole } from '@qaai/shared';
import { prisma, unscoped, withTenant } from '../lib/prisma.js';
import { hashToken } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { logger, setRequestActor } from '../lib/logger.js';

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

/**
 * THE EMPTY SCOPE ARRAY, AND WHY IT USED TO BE A WILDCARD.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * This function read `scopes: key.scopes.length > 0 ? key.scopes : ['*']`, and
 * `requireScope` short-circuits on `'*'`. So a key stored with NO scopes held
 * EVERY scope — and `POST /settings/api-keys` hand-parsed `req.body.scopes`
 * with no schema, so `{"scopes": []}` was storable. "Create a key that can do
 * nothing" and "create a key that can do anything" were the same request.
 *
 * ── THE MEANING, PICKED ────────────────────────────────────────────────────
 *
 * An empty list means NO SCOPES. It is not shorthand for all of them. The
 * wildcard reading existed because old rows exist, not because anybody chose
 * it, and `API_KEY_SCOPES` deliberately excludes `'*'` so a key cannot even
 * name the thing the empty array was being read as.
 *
 * ── WHY THE CREDENTIAL IS REFUSED OUTRIGHT, not narrowed to `[]` ───────────
 *
 * Returning `scopes: []` would make the key mean "nothing that happens to be
 * checked" — and MEASURED on this tree, 151 of the 184 mutating route
 * declarations under `routes/` carry no `requireScope` at all, so a no-scope
 * key would still change member roles. This middleware cannot know which route
 * the request is heading for, so the only reading under which the empty array
 * means NOTHING is that the credential does not authenticate. The caller gets
 * the same uniform 401 an unknown, revoked or expired key gets — rule 12: no
 * new oracle.
 *
 * ── THE BRAKE ──────────────────────────────────────────────────────────────
 *
 * `API_KEY_SCOPE` is the mode, and it gates THE REFUSAL and not only the
 * report (rule 13). OBSERVE keeps today's answer — the wildcard — and COUNTS
 * it, which is exactly what `SECURITY_CONTROL_BRAKES.API_KEY_SCOPE.observeCounts`
 * promises: "every request authorised by a key whose scopes are empty". Its
 * fallback is ENFORCE, so an install that has stored nothing gets the refusal;
 * an operator who reads the count first sets OBSERVE and keeps today's answer.
 */
function scopesForKey(
  key: { readonly id: string; readonly scopes: readonly string[] },
  storedModes: unknown,
): readonly string[] | null {
  if (key.scopes.length > 0) return key.scopes;

  if (controlEnforces(controlMode('API_KEY_SCOPE', storedModes))) return null;

  countEmptyScopeKey(key.id);
  return ['*'];
}

/**
 * OBSERVE-MODE COUNTS, per key id.
 *
 * In memory and per process, which is the honest limit and the same one
 * `middleware/csrf.ts` states for the same position in the stack: a restart
 * loses them and two API replicas each hold their own. The log line beside each
 * increment is what survives a restart. It is for reading the blast radius
 * before arming the brake — "how many keys is this, and which" — not an audit
 * trail, and an `AuditLog` write on every authenticated request would be a
 * database round trip in the credential path.
 *
 * Keyed on the key's id, which is a cuid. NOT on the key, not on its hash and
 * not on its prefix (rule 11): nothing here is a fragment of a credential.
 */
const emptyScopeObserved = new Map<string, number>();

function countEmptyScopeKey(keyId: string): void {
  const next = (emptyScopeObserved.get(keyId) ?? 0) + 1;
  emptyScopeObserved.set(keyId, next);
  logger.warn(
    { control: 'API_KEY_SCOPE', apiKeyId: keyId, observed: next },
    'a key with an empty scope list was authorised as a wildcard because the brake is in OBSERVE',
  );
}

/** What OBSERVE has let through, by key id. Exported so a test and the health surface can read it. */
export function apiKeyScopeObserved(): Readonly<Record<string, number>> {
  return Object.fromEntries(emptyScopeObserved);
}

/** Test-only reset, so one test's counts cannot leak into the next. */
export function resetApiKeyScopeObserved(): void {
  emptyScopeObserved.clear();
}

/**
 * IS A REVOKED KEY STILL INSIDE ITS ROTATION GRACE WINDOW?
 *
 * `ApiKey.rotationGraceUntil` says "while this is in the future BOTH this key
 * and the one it replaced authorise", and nothing read it. This is its reader;
 * `POST /settings/api-keys/:keyId/rotate` is its writer.
 *
 * TWO CONDITIONS, both fail-closed:
 *
 *   `rotatedAt` MUST BE SET on the key being presented. A key revoked by a
 *   human through `DELETE /settings/api-keys/:keyId` has `rotatedAt` null and
 *   can never come back — otherwise "revoke this leaked key" would be undone
 *   by a grace window somebody opened last week.
 *
 *   The SUCCESSOR must itself be live (`revokedAt: null`). A grace window
 *   inherited from a replacement that was itself revoked is a window nobody
 *   meant to leave open.
 */
async function rotationGraceOpen(keyId: string, rotatedAt: Date | null, now: Date): Promise<boolean> {
  if (rotatedAt === null) return false;
  const successor = await unscoped(() =>
    prisma.apiKey.findFirst({
      where: { replacesKeyId: keyId, revokedAt: null, rotationGraceUntil: { gt: now } },
      select: { id: true },
    }),
  );
  return successor !== null;
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
        rotatedAt: true,
        /*
         * The brake modes come through the RELATION rather than a second query
         * of my own: lesson F, a hand-copied projection inside a function drops
         * a field and every test still passes. One select, one row, one answer.
         */
        org: { select: { securityControlModes: true } },
      },
    }),
  );

  const now = new Date();
  if (!key) return null;
  if (key.expiresAt && key.expiresAt < now) return null;
  if (key.revokedAt && !(await rotationGraceOpen(key.id, key.rotatedAt, now))) return null;

  const scopes = scopesForKey(key, key.org?.securityControlModes ?? null);
  if (scopes === null) return null;

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
    scopes: [...scopes],
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
