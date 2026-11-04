/**
 * Sessions: listing them, revoking them, and the CSRF token derived from one.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * THERE WAS NO WAY TO SIGN OUT A LOST LAPTOP. `Session` rows have existed since
 * the init migration, `revokedAt` with them, and the only thing that ever wrote
 * it was `POST /auth/logout` (the current tab) and a password change (the
 * others, all at once, with no way to see or choose). A customer whose laptop
 * was stolen could change their password — and that was the entire remedy, for
 * every device, with no list to look at and nothing to confirm it worked.
 *
 * ── A REVOCATION THAT TAKES AN HOUR IS NOT A REVOCATION ────────────────────
 *
 * This is the one claim in this round's brief that DID NOT reproduce, and the
 * finding is worth more than the fix would have been.
 * `SECURITY_CONTROL_BRAKES.SESSION_REVOCATION` says "no request path ever
 * honoured it, so ENFORCE is the first time a revoked session stops working".
 * It is honoured: `apps/api/src/middleware/auth.ts` reads
 *
 *     if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
 *
 * on EVERY request, in `actorFromSession`, and has since that function was
 * written. There is no token cache and no expiry window, so a revocation is
 * already immediate — the next request on that cookie is anonymous. What was
 * missing was not enforcement; it was the LIST and the per-device door, which
 * is what this file builds. The brake's paragraph is wrong and is listed for
 * correction in this round's `needsFromOtherFiles`: in a security file a
 * comment that overstates a hole is as damaging as one that hides it, because
 * the next reviewer trusts it instead of reading.
 *
 * ── RULE 11 ────────────────────────────────────────────────────────────────
 *
 * No function here accepts, returns or logs a session token. The hash is taken
 * at the door by `hashToken` and only hashes cross this module's boundary; the
 * listing projects nine columns and `tokenHash` is not one of them, which is
 * asserted rather than intended (`sessions.test.ts`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { revokeSessionSchema } from '@qaai/shared';
import type { SessionRevocationReason } from '@qaai/shared';
import { env } from '../env.js';
import { prisma, unscoped } from './prisma.js';

/**
 * ONE SESSION, AS A PERSON SEES IT.
 *
 * `deviceLabel` and `lastSeenAt` are both here because without them the screen
 * is useless for its only purpose: a list of five rows reading "Mozilla/5.0
 * (Macintosh…)" and a creation date is not a list anybody can act on, and "sign
 * out the one I am not holding" is the only question being asked.
 *
 * `current` is computed from the caller's own cookie, so the screen can refuse
 * to let somebody sign themselves out by accident while looking for the laptop.
 */
export interface SessionSummary {
  readonly id: string;
  readonly deviceLabel: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
  readonly expiresAt: Date;
  readonly current: boolean;
}

/**
 * The columns the listing reads. A CONSTANT, not a literal re-typed inside the
 * function.
 *
 * Lesson F, paid for in this codebase: a hand-copied projection inside a
 * function is as blind as a select-blind fake. An internal map typed
 * `{key, status, label}` re-listed those three fields and dropped the fourth,
 * and every test passed until it was mutation-proved. `tokenHash` is absent
 * from this object on purpose and `sessions.test.ts` asserts the absence.
 */
const SESSION_SELECT = {
  id: true,
  deviceLabel: true,
  ip: true,
  userAgent: true,
  createdAt: true,
  lastSeenAt: true,
  expiresAt: true,
  tokenHash: true,
} as const;

/**
 * The live sessions of one user, newest activity first.
 *
 * LIVE MEANS NOT REVOKED AND NOT EXPIRED, and both halves are applied in the
 * query rather than filtered afterwards: `@@index([userId, revokedAt])` exists
 * for exactly this read, and a post-filter would make the index decorative.
 *
 * ── `nulls: 'last'` IS LOAD-BEARING AND WAS WRONG ON THE FIRST DRAFT ───────
 *
 * Ordered by `lastSeenAt` and then `createdAt`, because a session that has made
 * no request since the column landed has a null `lastSeenAt` and must not sort
 * as "most recently used" — it is unknown, not new. `ORDER BY … DESC` in
 * Postgres puts NULLs FIRST, which is exactly that defect, and this file's
 * first draft used the bare `'desc'` form while the paragraph here claimed
 * nulls sorted last. The test caught the disagreement; the explicit directive
 * is the fix, and `sessions.test.ts` models Postgres's own null ordering so a
 * revert to the bare form fails rather than passing.
 */
export async function listSessions(
  userId: string,
  options: { readonly nowMs: number; readonly currentTokenHash: string | null },
): Promise<SessionSummary[]> {
  const rows = await unscoped(() =>
    prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date(options.nowMs) } },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: SESSION_SELECT,
    }),
  );

  return rows.map((row) => ({
    id: row.id,
    deviceLabel: row.deviceLabel,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    current: options.currentTokenHash !== null && row.tokenHash === options.currentTokenHash,
  }));
}

/**
 * REVOKE ONE SESSION, BY ID, BELONGING TO THIS USER.
 *
 * `updateMany` with `userId` in the WHERE and not `update` by id: the id comes
 * from a URL, and an `update` would succeed against another person's session
 * the moment an id leaked. The `userId` clause makes a cross-user revocation
 * return a count of zero, which the caller renders as a 404 — the same
 * indistinguishable answer `notFound` exists for.
 *
 * `revokedAt: null` is in the WHERE too, so revoking an already-revoked session
 * reports `false` rather than overwriting the reason and the time of the
 * revocation that actually mattered. "Who ended this session and why" is
 * evidence, and the second writer would destroy it.
 *
 * Returns whether a row changed. The caller must not describe `false` as
 * "revoked" — `sessions.test.ts` asserts the count.
 */
export async function revokeSession(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly reason: SessionRevocationReason;
  readonly byUserId: string | null;
  readonly nowMs: number;
}): Promise<boolean> {
  // Through the schema, which is the only write path for the reason vocabulary.
  // A spelling no reader can name is a revocation an operator cannot explain.
  const reason = revokeSessionSchema.parse({ reason: input.reason }).reason;

  const result = await unscoped(() =>
    prisma.session.updateMany({
      where: { id: input.sessionId, userId: input.userId, revokedAt: null },
      data: { revokedAt: new Date(input.nowMs), revokedReason: reason, revokedBy: input.byUserId },
    }),
  );
  return result.count > 0;
}

/**
 * REVOKE EVERY SESSION OF ONE USER, optionally sparing the caller's own.
 *
 * `exceptTokenHash` null means spare nothing — which is what an administrative
 * revocation and an SSO enforcement want, and what a user asking to "sign out
 * everywhere including here" wants. The password-change path passes its own
 * hash, because signing someone out of the tab they just changed their password
 * in reads as a failure and every OTHER device is the thing worth cutting off.
 *
 * Returns the count, because a bulk action that reports "done" without a number
 * is a bulk action nobody can verify. `routes/auth.ts` puts the number in the
 * response.
 */
export async function revokeAllSessions(input: {
  readonly userId: string;
  readonly exceptTokenHash: string | null;
  readonly reason: SessionRevocationReason;
  readonly byUserId: string | null;
  readonly nowMs: number;
}): Promise<number> {
  const reason = revokeSessionSchema.parse({ reason: input.reason }).reason;

  const result = await unscoped(() =>
    prisma.session.updateMany({
      where: {
        userId: input.userId,
        revokedAt: null,
        ...(input.exceptTokenHash === null ? {} : { NOT: { tokenHash: input.exceptTokenHash } }),
      },
      data: { revokedAt: new Date(input.nowMs), revokedReason: reason, revokedBy: input.byUserId },
    }),
  );
  return result.count;
}

/**
 * STAMP `lastSeenAt`. The writer the column needs to be worth reading.
 *
 * ── WHY IT IS COARSE, AND WHY THAT IS NOT LAZINESS ─────────────────────────
 *
 * Every authenticated request would otherwise be a write, which turns a session
 * cookie into a row-level write lock on the hot path of the whole API. So the
 * stamp is skipped unless the recorded value is more than
 * {@link LAST_SEEN_RESOLUTION_MS} old. The cost is that the screen can be a
 * minute behind; the benefit is that the column exists at all. A person
 * deciding which laptop to kill does not need the second.
 *
 * `updateMany` and not `update`, so a token that has just been revoked by
 * another tab does not throw on a missing row — and `revokedAt: null` in the
 * WHERE means a revoked session is never touched again, so "last seen" cannot
 * creep forward on a session that is already dead.
 *
 * Returns nothing and throws nothing: a failed stamp must not fail a request.
 */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

export async function touchSession(input: {
  readonly tokenHash: string;
  readonly nowMs: number;
}): Promise<void> {
  try {
    await unscoped(() =>
      prisma.session.updateMany({
        where: {
          tokenHash: input.tokenHash,
          revokedAt: null,
          OR: [
            { lastSeenAt: null },
            { lastSeenAt: { lt: new Date(input.nowMs - LAST_SEEN_RESOLUTION_MS) } },
          ],
        },
        data: { lastSeenAt: new Date(input.nowMs) },
      }),
    );
  } catch {
    /* A presence stamp is not worth a 500. */
  }
}

/**
 * CLIENT-SUPPLIED AND THEREFORE BOUNDED AND NEVER TRUSTED.
 *
 * It is a LABEL, not an identity: nothing authorises on it and nothing matches
 * on it. Control characters are stripped because the list is also read in a
 * terminal (`qaai sessions`), where a stray `\r` or an ANSI escape rewrites the
 * operator's screen — a log-injection surface that has nothing to do with the
 * browser. Length-bounded to match `createSessionSchema`.
 */
export function normaliseDeviceLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return cleaned.length === 0 ? null : cleaned;
}

// ─── CSRF ───────────────────────────────────────────────────────────────────

/**
 * THE CSRF TOKEN FOR ONE SESSION, DERIVED AND NOT STORED.
 *
 * ── WHY A CHECK IS NEEDED WHEN THE COOKIE IS ALREADY SameSite=Lax ──────────
 *
 * Because `Lax` is a browser's promise, not ours: it covers nothing on a
 * browser that predates it, it does not cover a same-site subdomain an attacker
 * has an XSS foothold on, and `Lax` DOES send the cookie on a top-level
 * navigation — so a form-less `<a>` to a mutating GET would carry it. The API
 * has no mutating GETs today and must not acquire one; the token is what makes
 * that a check rather than a convention.
 *
 * ── WHY IT IS DERIVED FROM THE SESSION AND NOT A SECOND ROW ────────────────
 *
 * HMAC(SESSION_SECRET, "csrf" ‖ tokenHash) is unforgeable without the server
 * secret, is stable for the life of the session, dies exactly when the session
 * dies, and needs no storage, no expiry sweep and no second lookup on the hot
 * path. The domain separator matters: without the `csrf` prefix the derivation
 * would be a second value computed from the same input as something else, and
 * two keyed digests of one input is how a value minted for one purpose starts
 * authenticating another.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────
 *
 * Not a defence against XSS. A script running on our own origin can read the
 * readable cookie and send the header, and no CSRF scheme survives that; the
 * answer to XSS is the CSP, which is a separate control with its own brake.
 * Saying so here because a comment that implied otherwise would be the worst
 * kind in a security file.
 */
export function csrfTokenFor(sessionTokenHash: string): string {
  return createHmac('sha256', env.SESSION_SECRET)
    .update(`csrf\u001f${sessionTokenHash}`)
    .digest('hex');
}

/**
 * Constant-time comparison of a supplied CSRF token against the derived one.
 *
 * The length check is not a leak: both sides are a fixed-width hex digest when
 * correct, so a mismatch in length is a malformed input and carries no
 * information about the expected value. `timingSafeEqual` throws on unequal
 * lengths, which is why it cannot be reached with one.
 */
export function csrfTokenMatches(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(supplied, 'utf8'));
}

/**
 * RE-EXPORTED FROM `@qaai/shared`, NOT DECLARED HERE.
 *
 * These two were literals in this file and literals AGAIN in apps/web/lib/api.ts,
 * because `apps/web` must not import from `apps/api`. Two string literals that
 * must match and that no compiler compares is how the cockpit came to answer
 * 403 on sign-out and switch-org: a writer with no reader, and nothing in
 * either workspace looking wrong. They are published once in
 * `packages/shared/src/constants.ts` and imported on both sides; this
 * re-export is here so the API's own call sites — `csrfGuard` in routes/auth.ts
 * and the cookie it sets — keep importing them from the module that owns the
 * CSRF derivation.
 */
export { CSRF_COOKIE, CSRF_HEADER } from '@qaai/shared';

/**
 * WHICH METHODS NEED THE TOKEN.
 *
 * The safe methods are excluded because a CSRF token on a GET is a token in a
 * URL in a referrer header in somebody's analytics. `HEAD` and `OPTIONS` are
 * excluded for the same reason and because a pre-flight that required a token
 * would break every browser client before it ever sent one.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function methodNeedsCsrf(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}
