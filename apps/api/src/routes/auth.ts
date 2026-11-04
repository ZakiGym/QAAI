/**
 * Auth routes (§1): signup, login, logout, session introspection, org switch.
 *
 * Deviation from the spec worth naming: the spec lists NextAuth. With a
 * separate Express API, NextAuth would leave two systems owning sessions and a
 * shared secret between them. The API owns auth instead — one session table,
 * one place where a token is minted, and the CLI and cockpit authenticate the
 * same way. OAuth providers slot in as additional routes on this router.
 *
 * ── WHAT THIS ROUND CHANGED, AND WHICH DEFECT EACH PART CLOSES ─────────────
 *
 *   1. THE SECOND FACTOR WAS DECORATIVE. This file read
 *      `if (user.totpEnabledAt && !input.totpCode) throw` and then never looked
 *      at the code again. Presence was checked; the value was not, so any six
 *      digits signed in. Real RFC 6238 verification now lives in
 *      `lib/totp.ts`, with a ±1-step window, replay refusal, enrolment that
 *      needs a verified code, and hashed single-use recovery codes.
 *
 *   2. THERE WAS NO THROTTLING OF ANY KIND. `index.ts` mounts a 300-per-minute
 *      per-IP limiter across the whole API, which a password list walked from a
 *      hundred hosts never notices. `lib/throttle.ts` counts per identifier AND
 *      per source, backs off, and locks as a ceiling.
 *
 *   3. THERE WAS NO WAY TO SIGN OUT A LOST LAPTOP. `lib/sessions.ts` lists
 *      them, revokes one, revokes all, and stamps `lastSeenAt` so the list is
 *      something a person can act on.
 *
 *   4. SIGNUP NEVER PROVED THE ADDRESS. With SSO JIT provisioning that is
 *      pre-account-takeover: register `victim@company.com` first and inherit
 *      the account when the IdP provisions it. Verification is issued and
 *      redeemed here; the JIT half is an edit owed to `lib/sso.ts`.
 *
 *   5. AN ORGANISATION COULD BUY SSO AND KEEP PASSWORD LOGIN. `enforceSso` had
 *      no reader anywhere in the repository. It has one below, with a
 *      break-glass that an attacker cannot use and that cannot lock an
 *      organisation out of its own account.
 *
 * ── EVERY REFUSAL BEFORE THE PASSWORD IS CHECKED IS THE SAME REFUSAL ───────
 *
 * One sentence, one status, one time floor — see {@link LOGIN_REFUSAL} and
 * {@link LOGIN_TIME_FLOOR_MS}. Nothing a caller can observe distinguishes an
 * unknown address from a wrong password from a locked account. AFTER a correct
 * password the answers become specific, and that is deliberate rather than
 * sloppy: a caller who has just proved they hold the credential already knows
 * the account exists, so "verify your email" and "sign in through your identity
 * provider" tell them nothing they could not already see, and withholding them
 * would produce support tickets instead of security.
 *
 * ── RULE 11, AS A PROPERTY OF THIS FILE ───────────────────────────────────
 *
 * No password, TOTP code, TOTP seed, recovery code, verification token,
 * `otpauth://` payload, session token or CSRF token appears in a log line, an
 * audit entry, an error message or a refusal anywhere below. The seed is sealed
 * before it is stored and is opened into a local that is used once;
 * `auth.test.ts` walks the error paths and asserts the values are absent from
 * every response and every captured audit entry.
 */

import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  changePasswordSchema,
  controlEnforces,
  controlMode,
  createSessionSchema,
  issueVerificationTokenSchema,
  loginSchema,
  recoveryCodeSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  resolveLoginThrottle,
  signupSchema,
  totpEnrolmentSchema,
} from '@qaai/shared';
import type { ActorContext, OrgRole, SecurityControl } from '@qaai/shared';
import { prisma, unscoped, withTenant } from '../lib/prisma.js';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { mailDriver, passwordResetMail, sendMail } from '../lib/mail.js';
import { open as openSealed, seal } from '../lib/vault.js';
import {
  TOTP_REFUSAL_SENTENCE,
  generateTotpSecret,
  hashRecoveryCode,
  inProcessReplayStore,
  mintRecoveryCodes,
  totpEnrolmentUri,
  verifyTotpCode,
} from '../lib/totp.js';
import type { TotpReplayStore } from '../lib/totp.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfTokenFor,
  csrfTokenMatches,
  listSessions,
  methodNeedsCsrf,
  normaliseDeviceLabel,
  revokeAllSessions,
  revokeSession,
  touchSession,
} from '../lib/sessions.js';
import {
  SOURCE_FAILURE_MULTIPLIER,
  checkLoginThrottle,
  clearLoginLock,
  recordFailure,
  recordLoginAttempt,
  recordSuccess,
  throttleKey,
} from '../lib/throttle.js';
import { env, isProd } from '../env.js';
import { SESSION_COOKIE, actorOf, attachActor, requireAuth } from '../middleware/auth.js';

export const authRouter: Router = Router();

/**
 * THE I/O THIS ROUTER TAKES FROM OUTSIDE ITSELF.
 *
 * A clock, a sleep, an entropy source and the TOTP replay memory. Injected for
 * the reason rule 8 states: a control nobody can test with a fake is a control
 * nobody will trust, and three of the four below are untestable otherwise — a
 * ±1-step window has to be driven across a step boundary, a replay has to be
 * driven twice inside one window, and a fixed time floor has to be observable.
 *
 * `fetch`, DNS and sockets are deliberately absent: nothing in this file opens
 * one. Mail goes through `lib/mail.ts`, which is the one send policy.
 */
export interface AuthIo {
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: (bytes: number) => Buffer;
  readonly replay: TotpReplayStore;
}

const SYSTEM_NOW = (): number => Date.now();

let io: AuthIo = {
  now: SYSTEM_NOW,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: randomBytes,
  replay: inProcessReplayStore(SYSTEM_NOW),
};

/**
 * Point this router at its I/O. Returns the previous settings so a caller can
 * restore them, which is what keeps one test from leaking a fake into the next.
 */
export function configureAuthIo(next: Partial<AuthIo>): AuthIo {
  const previous = io;
  io = { ...io, ...next };
  return previous;
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base || 'org';
}

// ─── The uniform refusal, and the floor under it ────────────────────────────

/**
 * THE ONE SENTENCE EVERY PRE-PASSWORD REFUSAL SHOWS.
 *
 * A constant and not four string literals, because an oracle is built out of
 * one of them drifting. An unknown address, a wrong password, a locked
 * identifier and a throttled source all answer with exactly this, with the same
 * 401 and under the same floor. `auth.test.ts` compares the full response of a
 * LOCKED EXISTING account against a NONEXISTENT one — status, body and elapsed
 * time — because that pair is the control's own failure mode: a lockout that
 * can be distinguished is an account-enumeration oracle, which is a worse leak
 * than the brute force it was built to stop.
 */
export const LOGIN_REFUSAL = 'Email or password is incorrect';

/**
 * Every login response takes at least this long.
 *
 * The argument is already written down in this file for `/password/forgot`, and
 * it applies here for the same reason: balancing two branches to do "the same
 * shape of work" got that endpoint's timing ratio from 2.2x to 1.2x and no
 * further, because the branches are not identical and never will be. A known
 * address costs a membership lookup and an unknown one does not. A fixed floor
 * does not depend on the branch at all.
 *
 * 300ms on an endpoint a person hits once per device per three days.
 */
export const LOGIN_TIME_FLOOR_MS = 300;

/** Spend whatever is left of a budget. `max(0, …)` so a slow request is not made slower. */
async function spendFloor(startedAt: number, floorMs: number): Promise<void> {
  const remaining = floorMs - (io.now() - startedAt);
  if (remaining > 0) await io.sleep(remaining);
}

// ─── The rollout brakes ─────────────────────────────────────────────────────

/**
 * WHAT ONE ORGANISATION HAS ARMED, plus the two settings the login path reads.
 *
 * Carried as one object so no call site below reads `securityControlModes` off
 * a row it projected itself — lesson F, which cost a slice: a hand-copied
 * projection inside a function drops a field and every test still passes.
 */
interface OrgSecurityContext {
  readonly id: string;
  readonly enforceSso: boolean;
  readonly securityControlModes: unknown;
  readonly loginThrottlePolicy: unknown;
}

/** The action every OBSERVE count is written under. One spelling, so it is countable. */
export const OBSERVED_ACTION = 'security.control.observed';

/**
 * COUNT WHAT ENFORCE WOULD HAVE REFUSED.
 *
 * Rule 13: a mode with no counter is an off switch with a reassuring name, and
 * this product has shipped one of those. Every OBSERVE branch below calls this
 * before it allows the request through, so "how many logins would we have
 * blocked" is one query over `AuditLog` — `action = 'security.control.observed'`
 * grouped by `targetId`, which is the control's name.
 *
 * An audit row and not a counter column, because the question an operator
 * actually asks is "which of my people would this have stopped, and when", and
 * a monotonic integer cannot answer it. `audit()` masks its metadata and
 * swallows its own failures, so this cannot break a login either.
 *
 * `detail` NEVER carries a credential. The call sites pass an outcome name and
 * at most an identifier the actor owns.
 */
async function countObserved(
  control: SecurityControl,
  actor: Pick<ActorContext, 'userId' | 'orgId' | 'ip' | 'impersonatedBy'>,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await audit({
    actor,
    action: OBSERVED_ACTION,
    targetType: 'SecurityControl',
    targetId: control,
    metadata: { control, wouldHaveRefused: true, ...detail },
  });
}

/**
 * A CONTROL THAT IS NOT INSTALLED, COUNTED AND SAID OUT LOUD.
 *
 * Deliberately NOT {@link countObserved}: that writes `wouldHaveRefused: true`,
 * and nothing would have been refused here because nothing was read. The
 * metadata says NULL for that field rather than `false` or `0` — a control
 * whose state nobody could read must report UNAVAILABLE, never a measured
 * answer it does not have.
 *
 * LOGGED AT ERROR, ON EVERY ATTEMPT IT ADMITS. Not warn, and not once: this is
 * a security control that is off, the window is supposed to be minutes, and the
 * remedy is one command. A line per login is self-limiting because it stops the
 * moment the migration runs, and a throttle that silently stopped throttling is
 * the thing `countAttempt`'s own comment above refuses to allow.
 *
 * The AUDIT ROW needs an actor and so is written only when the org resolved;
 * the LOG LINE is unconditional. Said here because the two differ, and a reader
 * who assumed the audit count was complete would under-read the window.
 */
async function countThrottleNotInstalled(
  actor: Pick<ActorContext, 'userId' | 'orgId' | 'ip' | 'impersonatedBy'> | null,
): Promise<void> {
  logger.error(
    { control: 'LOGIN_THROTTLE', availability: 'NOT_INSTALLED' },
    'the LoginThrottle relation does not exist, so this login was admitted without a throttle ' +
      'check — run prisma migrate deploy',
  );
  if (actor === null) return;
  await audit({
    actor,
    action: OBSERVED_ACTION,
    targetType: 'SecurityControl',
    targetId: 'LOGIN_THROTTLE',
    metadata: {
      control: 'LOGIN_THROTTLE',
      /* Nothing was read, so there is nothing to have refused. NULL, not false. */
      wouldHaveRefused: null,
      availability: 'NOT_INSTALLED',
    },
  });
}

/** True when this org has this control in ENFORCE. Falls back per control, never throws. */
function enforcing(control: SecurityControl, org: OrgSecurityContext | null): boolean {
  return controlEnforces(controlMode(control, org?.securityControlModes ?? null));
}

// ─── Cookies ────────────────────────────────────────────────────────────────

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

/**
 * THE READABLE COMPANION COOKIE. Deliberately NOT HttpOnly.
 *
 * The page has to be able to read it to echo it back in {@link CSRF_HEADER},
 * which is the whole double-submit mechanism. That is not a weakening of the
 * session cookie: this value authorises nothing on its own, it is derived from
 * the session hash by an HMAC the client cannot compute, and a script able to
 * read it is a script running on our origin, which no CSRF scheme survives.
 */
function csrfCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    isProd ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

/** The raw session token from the request, or null. */
function rawSessionToken(req: Request): string | null {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

interface IssuedSession {
  readonly raw: string;
  readonly maxAge: number;
  readonly tokenHash: string;
  readonly csrf: string;
}

/**
 * Mint a session row, a cookie value and the CSRF token derived from it.
 *
 * Goes through `createSessionSchema`, which is the write path for
 * `Session.expiresAt` and `Session.deviceLabel`. The schema is not inventing
 * the expiry rule — the column is already NOT NULL — it is giving the only code
 * that creates sessions a door, so a creator that forgets the field is a
 * refusal with a path rather than a Prisma error at run time.
 */
async function issueSession(
  userId: string,
  orgId: string,
  ip: string | null,
  ua: string | null,
  deviceLabel: unknown,
): Promise<IssuedSession> {
  const raw = generateToken(32);
  const tokenHash = hashToken(raw);

  const parsed = createSessionSchema.parse({
    expiresAt: new Date(io.now() + env.SESSION_TTL_HOURS * 3600_000),
    deviceLabel: normaliseDeviceLabel(deviceLabel),
  });

  await unscoped(() =>
    prisma.session.create({
      data: {
        userId,
        tokenHash,
        activeOrgId: orgId,
        ip,
        userAgent: ua,
        deviceLabel: parsed.deviceLabel,
        expiresAt: parsed.expiresAt,
      },
      select: { id: true },
    }),
  );

  return {
    raw,
    maxAge: env.SESSION_TTL_HOURS * 3600,
    tokenHash,
    csrf: csrfTokenFor(tokenHash),
  };
}

/** Both cookies, in the order a `Set-Cookie` array wants them. */
function authCookies(issued: IssuedSession): string[] {
  return [sessionCookie(issued.raw, issued.maxAge), csrfCookie(issued.csrf, issued.maxAge)];
}

// ─── CSRF, as a door rather than a convention ───────────────────────────────

/**
 * THE CSRF CHECK, AND WHY IT IS MOUNTED ON THE ROUTER.
 *
 * Per-route helper calls were the alternative and were rejected: a control
 * applied by remembering to call it is one forgotten call away from a hole, and
 * this repository has shipped routes with a missing scope check before. Mounted
 * here it covers every state-changing route on this router whether or not
 * somebody remembered.
 *
 * ── IT APPLIES ONLY WHERE THE BROWSER ATTACHES THE CREDENTIAL ──────────────
 *
 * A caller with no session cookie is skipped, which is not a bypass: a CSRF
 * check exists because the browser sends the cookie by itself, and a bearer
 * token or an API key is attached by the client deliberately. A caller holding
 * BOTH is checked, because the cookie is the one an attacker can trigger.
 * Signup and login are reached without a cookie and so are unaffected.
 *
 * ── THE REFUSAL IS NOT AN ORACLE ───────────────────────────────────────────
 *
 * One sentence for a missing token and a wrong one. "Missing" versus "wrong"
 * would tell a page whether it had guessed the header name.
 *
 * ── SCOPE: THERE ARE TWO LAYERS, AND THIS IS THE SECOND ────────────────────
 *
 * This paragraph used to say the API outside `/auth/*` was uncovered and that
 * the edit which fixes it was owed. THAT IS NO LONGER TRUE, and leaving it
 * would be worse than saying nothing: a reviewer who trusts it concludes the
 * API is unprotected and adds a second mechanism on top of the one that is
 * already there. Both mounts, as they actually stand:
 *
 *   LAYER 1 — `apps/api/src/index.ts:163`, `app.use(csrfGuard({…}))` from
 *   `middleware/csrf.ts`. An ORIGIN check (`Origin`, falling back to
 *   `Sec-Fetch-Site`), mounted after `attachActor` and BEFORE every router,
 *   so it covers the whole API — `/settings`, `/projects`, `/runs`,
 *   `/integrations`, a router added next round, and `/auth/*` too. It needs
 *   nothing from the client, which is why it could ship at once.
 *
 *   LAYER 2 — `authRouter.use(…, csrfGuard)` below. The double-submit token, on
 *   `/auth/*` only. Strictly narrower in reach and strictly stronger where it
 *   applies: a token cannot be replayed by a caller that merely suppresses
 *   headers, so it is on the router that mints, revokes and switches sessions.
 *   Of this file's fifteen mutating routes it bites on the ones reached WITH a
 *   session cookie — the nine behind `requireAuth`, plus `/logout` and a
 *   `/verify-email` posted while signed in.
 *
 * WHAT NEITHER LAYER COVERS, so it is not mistaken for complete:
 *
 *   An UNAUTHENTICATED mutating request. Both layers skip a caller with no
 *   cookie — there is no credential for another site to borrow — so login CSRF
 *   (forcing a victim to sign in AS THE ATTACKER) is addressed by neither.
 *   Named rather than left to be noticed.
 *
 *   A BEARER-TOKEN or API-KEY caller, by design in both: the client attached
 *   that credential deliberately and no page can read one.
 *
 *   `index.ts` passes no `storedModes` to layer 1, so its brake resolves to
 *   `CSRF_TOKEN`'s fallback for every org. Layer 2 below reads the org's row.
 */
const CSRF_REFUSAL = 'This request is missing a valid CSRF token.';

async function csrfGuard(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!methodNeedsCsrf(req.method)) {
    next();
    return;
  }
  const raw = rawSessionToken(req);
  if (raw === null) {
    next();
    return;
  }

  const expected = csrfTokenFor(hashToken(raw));
  if (csrfTokenMatches(expected, req.headers[CSRF_HEADER])) {
    next();
    return;
  }

  const actor = req.actor;
  if (actor && !enforcing('CSRF_TOKEN', await orgSecurityOf(actor.orgId))) {
    await countObserved('CSRF_TOKEN', actor, { method: req.method, path: req.path });
    next();
    return;
  }

  next(forbidden(CSRF_REFUSAL));
}

/**
 * Stamp `lastSeenAt` on the session this request arrived on.
 *
 * The writer `Session.lastSeenAt` is owed: a minted column with no writer is
 * half the defect it was minted to fix, and a revocation screen that cannot say
 * when a device was last used is a screen nobody can act on. Coarse (see
 * `LAST_SEEN_RESOLUTION_MS`) and awaited rather than fired-and-forgotten, so a
 * test can assert it without a timer. It never throws.
 *
 * Mounted on this router only. Unlike {@link csrfGuard} that is the whole
 * intent rather than a gap waiting on an edit elsewhere: `lastSeenAt` answers
 * "when was this device last used" on the session-revocation screen, and the
 * sessions this router mints and revokes are the only rows that screen lists.
 */
async function stampLastSeen(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const raw = rawSessionToken(req);
  if (raw !== null) await touchSession({ tokenHash: hashToken(raw), nowMs: io.now() });
  next();
}

/*
 * `attachActor` first, so the two guards below can read the org's brake modes
 * and write an OBSERVE count against a real tenant. It resolves an actor
 * without rejecting, and `requireAuth` reuses what it put on the request, so
 * this is not a second credential lookup.
 */
authRouter.use(attachActor, stampLastSeen, csrfGuard);

/**
 * COUNTER WRITES THAT MUST NOT CHANGE THE ANSWER.
 *
 * ── WHICH THROTTLE CALLS ARE BEST-EFFORT, AND WHICH ARE NOT ───────────────
 *
 * The READ (`checkLoginThrottle`) is NOT wrapped FOR FAILING TO READ: if the
 * lock state cannot be read, the control cannot know whether this identifier is
 * locked, and the only fail-closed answer is to refuse. That costs nothing
 * real, because verifying the password needs the same database.
 *
 * It distinguishes exactly ONE case from that, inside the module: the relation
 * being ABSENT, which is what `prisma migrate deploy` not having run yet looks
 * like. "There is no lock table" and "I cannot read the lock table" are two
 * facts, and conflating them cost EVERY login a 500 in the window between the
 * code landing and the migration running — measured, not predicted. See
 * `ThrottleAvailability`; the NOT_INSTALLED arm is handled below and is the
 * only arm this route degrades for.
 *
 * The WRITES are wrapped, because by the time either of them runs the decision
 * has already been made: a failure write happens on the way to a refusal that
 * is happening anyway, and a success write happens after the session row is
 * already committed. Throwing there would turn a correct 401 into a 500 — which
 * is also a difference an attacker can observe between two branches — or a
 * successful login into one the user is told failed.
 *
 * LOGGED, not swallowed. A counter that silently stops counting is a throttle
 * that is off, and the only way anybody finds out is this line.
 */
async function countAttempt(what: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    logger.error({ err, what }, 'could not write a login throttle counter');
  }
}

/** The org settings the brakes read. Null for an org that cannot be read. */
async function orgSecurityOf(orgId: string): Promise<OrgSecurityContext | null> {
  return unscoped(() =>
    prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        enforceSso: true,
        securityControlModes: true,
        loginThrottlePolicy: true,
      },
    }),
  );
}

// ─── Invites ────────────────────────────────────────────────────────────────

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

// ─── Email verification ─────────────────────────────────────────────────────

/**
 * A day. Long enough to survive a weekend and an inbox somebody checks on
 * Monday; short enough that a link in a leaked mailbox archive is dead.
 */
const EMAIL_VERIFY_TTL_HOURS = 24;

/**
 * A RESEND IS A MAIL SEND AN UNAUTHENTICATED-ISH CALLER CAN TRIGGER.
 *
 * This project has a recorded abuse incident behind exactly that shape, so the
 * resend endpoint is rate-limited by the age of the newest unused token for the
 * address rather than by trusting the caller to click once. No new table: the
 * token row's own `createdAt` is the rate limit, which cannot drift from the
 * thing it is limiting.
 */
const VERIFY_RESEND_MIN_MINUTES = 5;

/**
 * Issue an EMAIL_VERIFY token and send it, through the one send policy.
 *
 * `sendMail` in `lib/mail.ts` IS the send policy — the SMTP/console decision,
 * the one place the body is composed, and the one place a failure is logged.
 * A second send path is how a mail channel becomes a relay, which is why
 * nothing here opens a transport.
 *
 * ── THE TOKEN IS NEVER LOGGED, AND THE CONSOLE DRIVER IS THE EXCEPTION ─────
 *
 * On an install with no `SMTP_HOST`, `sendMail` writes the whole body — link
 * included — to the operator's own log at `info`, deliberately, because it is
 * the only copy that exists. That is the operator reading their own
 * deployment's mail, not QAAI logging a credential, and `mailDriver()` is
 * reported to the caller so the screen can say "ask your administrator" instead
 * of "check your email". Nothing in THIS file writes the token anywhere.
 *
 * ── WHY `sent` IS A FACT AND NOT AN ASSUMPTION ────────────────────────────
 *
 * Returns whether a token was actually issued, and the driver, so the caller
 * can tell the truth. A `true` compiled from "we called this function" is one
 * of the lies this product cannot afford: the screen would say "check your
 * email" for a link that was never minted.
 */
interface VerificationSend {
  readonly sent: boolean;
  readonly delivery: 'smtp' | 'console';
}

async function sendEmailVerification(email: string): Promise<VerificationSend> {
  const token = generateToken(32);
  const issued = issueVerificationTokenSchema.parse({
    email,
    purpose: 'EMAIL_VERIFY',
    expiresAt: new Date(io.now() + EMAIL_VERIFY_TTL_HOURS * 3600_000),
  });

  try {
    await issueVerificationRow(issued, hashToken(token));
  } catch (err) {
    /*
     * ── WHY THE TOKEN WRITE IS BEST-EFFORT, AND WHY THAT IS FAIL-CLOSED ────
     *
     * The only caller that can reach this on a fresh account is signup, and by
     * then the user and the organisation are COMMITTED. Throwing would answer
     * 500 for a signup that completely succeeded, and the caller's retry would
     * meet "an account with that email already exists" — a dead end with an
     * account at the bottom of it.
     *
     * Failing closed here means leaving `emailVerified` NULL, which is exactly
     * what happens: the address stays unproved, `EMAIL_VERIFICATION` still
     * refuses it under ENFORCE, and JIT provisioning still must not adopt it.
     * Nothing is opened by this branch. What it costs is one link, and the
     * recovery is `POST /auth/verify-email/resend`.
     *
     * LOGGED AND NOT SWALLOWED, unlike the mail failure below: a mail server
     * that is down is an operator's known state, and a verification token that
     * cannot be written is a database problem nobody would otherwise see.
     */
    logger.error({ err }, 'could not issue an email-verification token');
    return { sent: false, delivery: mailDriver() };
  }

  const url = `${env.WEB_PUBLIC_URL}/verify-email?token=${token}`;
  try {
    /*
     * Composed here rather than in `lib/mail.ts` beside the other four
     * messages, which is where the house keeps its wording. The reason is this
     * round's file ownership and nothing else; moving it is a two-line edit
     * listed in `needsFromOtherFiles`, and until then this is the only place
     * the text lives.
     */
    await sendMail({
      to: email,
      subject: 'Confirm your QAAI email address',
      text: [
        'Confirm this address so it can be used to sign in to QAAI.',
        '',
        url,
        '',
        `The link works once and expires in ${EMAIL_VERIFY_TTL_HOURS} hours.`,
        '',
        'If you did not create a QAAI account, someone typed your address by ' +
          'mistake. Nothing has been done to it and you can ignore this message.',
      ].join('\n'),
    });
  } catch {
    /*
     * Swallowed, exactly as `/password/forgot` swallows: the token is already
     * durable, the failure is logged with the address by lib/mail.ts, and a 500
     * here would fail a signup that has otherwise completely succeeded.
     */
  }

  return { sent: true, delivery: mailDriver() };
}

/** The two writes that make one live verification token. Separated so the caller can catch them. */
async function issueVerificationRow(
  issued: { email: string; purpose: string; expiresAt: Date },
  tokenHash: string,
): Promise<void> {
  await unscoped(async () => {
    /*
     * Any earlier unused verification for this address stops working the moment
     * a new one is asked for — the same single-live-token rule
     * `/password/forgot` applies, for the same reason: otherwise every link
     * ever sent stays live until it expires, so one leaked old message is
     * enough.
     */
    await prisma.verificationToken.updateMany({
      where: { email: issued.email, purpose: 'EMAIL_VERIFY', usedAt: null },
      data: { usedAt: new Date(io.now()) },
    });
    await prisma.verificationToken.create({
      data: {
        email: issued.email,
        tokenHash,
        purpose: issued.purpose,
        expiresAt: issued.expiresAt,
      },
      select: { id: true },
    });
  });
}

/**
 * REDEEM A VERIFICATION LINK. Single use, expiring, and it proves one thing.
 *
 * Unauthenticated, because the person clicking it may be on a different device
 * from the one they signed up on. That is safe: the token is 32 random bytes,
 * it is stored as a hash, it is burned inside the same transaction that writes
 * `emailVerified`, and holding it proves exactly the fact being recorded.
 *
 * The refusal is one sentence for a token that never existed, one that is
 * spent and one that has expired — three states a caller holding a valid token
 * never sees and an attacker should not be able to tell apart.
 */
authRouter.post('/verify-email', async (req, res) => {
  const token = String(req.body?.token ?? '');
  const invalid = badRequest('That confirmation link is invalid or has expired. Ask for a new one.');
  if (!token) throw invalid;

  const record = await unscoped(() =>
    prisma.verificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, email: true, purpose: true, expiresAt: true, usedAt: true },
    }),
  );

  if (!record || record.purpose !== 'EMAIL_VERIFY') throw invalid;
  if (record.usedAt) throw invalid;
  if (record.expiresAt < new Date(io.now())) throw invalid;

  const user = await unscoped(() =>
    prisma.user.findUnique({ where: { email: record.email }, select: { id: true } }),
  );
  if (!user) throw invalid;

  await unscoped(() =>
    prisma.$transaction(async (tx) => {
      /*
       * Burn the token in the same transaction that records the fact, and only
       * if it is still unused — the update IS the lock, so two concurrent uses
       * of one link cannot both succeed.
       */
      const burned = await tx.verificationToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date(io.now()) },
      });
      if (burned.count === 0) throw invalid;

      await tx.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date(io.now()) },
      });
    }),
  );

  res.json({ ok: true, email: record.email });
});

/** Ask for another confirmation link. Rate-limited by the newest token's age. */
authRouter.post('/verify-email/resend', requireAuth, async (req, res) => {
  const actor = actorOf(req);

  const user = await unscoped(() =>
    prisma.user.findUnique({
      where: { id: actor.userId },
      select: { email: true, emailVerified: true },
    }),
  );
  if (!user) throw unauthorized();
  if (user.emailVerified) {
    res.json({ ok: true, alreadyVerified: true, delivery: mailDriver() });
    return;
  }

  const newest = await unscoped(() =>
    prisma.verificationToken.findFirst({
      where: { email: user.email, purpose: 'EMAIL_VERIFY', usedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  );
  if (
    newest &&
    newest.createdAt.getTime() > io.now() - VERIFY_RESEND_MIN_MINUTES * 60_000
  ) {
    // 429 and a wait, not a silent success: an endpoint that reports "sent" and
    // does nothing is the failure this codebase keeps producing.
    res.status(429).json({
      ok: false,
      message: `A confirmation link was sent in the last ${VERIFY_RESEND_MIN_MINUTES} minutes. Check your inbox, then try again.`,
    });
    return;
  }

  const verification = await sendEmailVerification(user.email);
  res.status(verification.sent ? 200 : 503).json({ ok: verification.sent, ...verification });
});

// ─── Signup ─────────────────────────────────────────────────────────────────

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

  /*
   * THE ADDRESS IS NOW PROVABLE, WHICH IT NEVER WAS.
   *
   * Signup is not blocked on it — `EMAIL_VERIFICATION` defaults to OBSERVE for
   * the reason its brake records (nothing has ever written `emailVerified` for
   * a password account, so enforcing would lock out the whole installed base).
   * What changes today is that the fact starts being RECORDED, so a later
   * ENFORCE has a population to enforce against.
   *
   * ── WHAT THE SSO SIDE DOES WITH IT, since this paragraph used to overstate it ─
   *
   * It said SSO "can refuse to hand a JIT provision to an address nobody
   * proved". It does NOT refuse, and refusing was considered and rejected:
   * every pre-existing user is unverified, so a refusal would lock an org's
   * whole staff out at the moment it turned SSO on.
   *
   * `routes/sso.ts` SEVERS instead. When an SSO login claims an existing row
   * whose `emailVerified` is null, it nulls that row's `passwordHash` and
   * revokes its live sessions before attaching the membership. That closes the
   * pre-account-takeover — sign up as victim@customer.com, wait for the
   * customer to configure SSO, keep password access to an org account — without
   * locking anybody out, because the person arriving holds the credential the
   * org itself controls. The reasoning is written out at the claim site.
   *
   * So the value written here is load-bearing in the OTHER direction than this
   * paragraph once claimed: a row this route marks verified is a row whose
   * password an SSO claim will LEAVE ALONE.
   */
  const verification = await sendEmailVerification(email);

  const issued = await issueSession(
    user.id,
    org.id,
    req.ip ?? null,
    req.headers['user-agent'] ?? null,
    req.body?.deviceLabel,
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
    .setHeader('Set-Cookie', authCookies(issued))
    .json({
      user,
      org: { ...org, role },
      csrfToken: issued.csrf,
      // The measured pair, not a `true` compiled from "we called the function".
      emailVerification: verification,
    });
});

// ─── Login ──────────────────────────────────────────────────────────────────

/**
 * The seed for one user, opened, or null.
 *
 * FAILS CLOSED AND SILENTLY. An undecryptable seed returns null, which the
 * caller turns into a refusal — it does NOT fall through to "no second factor
 * required", which would turn a key problem into an authentication bypass. That
 * exception handler is the defect pattern this round is told to hunt for in its
 * own work, and this is the one place in this file that could have had it.
 *
 * Nothing is logged: `lib/vault.ts` composes its error from the AAD name, not
 * the value, but the safest reportable fact is the refusal itself.
 */
function openTotpSecret(row: {
  id: string;
  totpSecretEnc: string | null;
  totpSecretKeyVersion: number | null;
}): string | null {
  if (row.totpSecretEnc === null) return null;
  try {
    /*
     * `?? 1` is the contract `User.totpSecretKeyVersion` records: NULL beside a
     * non-null seed is the legacy state and means "sealed under whatever
     * version 1 was". It is a fact a sweep must be able to see rather than
     * assume, which is why the column exists and why this is the only place
     * that reads it.
     */
    return openSealed(row.totpSecretEnc, row.totpSecretKeyVersion ?? 1, row.id, TOTP_SEAL_NAME);
  } catch {
    return null;
  }
}

/**
 * The AAD name the seed is sealed under.
 *
 * `lib/vault.ts` composes its additional authenticated data as
 * `${orgId}:${name}`, and `User` is a GLOBAL model with no org — so the row id
 * goes in the first position and the sealed-field key in the second, giving
 * `${userId}:User.totpSecretEnc`. That binds the ciphertext to the ROW and the
 * FIELD, which is what stops a seed being pasted over the same user's sealed
 * anything-else or another user's seed.
 *
 * NOTE, because a doc comment that contradicts the code under it is the worst
 * kind in a security file: this is NOT `aadFor()` from
 * packages/shared/src/sealed.ts, which is this round's canonical composition
 * and uses a unit separator. That module is not reachable from this package —
 * it is in neither `packages/shared`'s barrel nor its `exports` map — so the
 * API cannot import it today. The binding is the same three facts in the same
 * order; only the separator differs. The one-line package edit that makes the
 * canonical version importable, and the one-line swap here that follows it, are
 * both in this round's `needsFromOtherFiles`.
 */
const TOTP_SEAL_NAME = 'User.totpSecretEnc';

/** The columns login reads off `User`. A constant, so no branch re-lists them. */
const LOGIN_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  passwordHash: true,
  emailVerified: true,
  totpEnabledAt: true,
  totpConfirmedAt: true,
  totpSecretEnc: true,
  totpSecretKeyVersion: true,
} as const;

authRouter.post('/login', async (req, res) => {
  const startedAt = io.now();
  const input = loginSchema.parse(req.body);
  const email = input.email.toLowerCase();
  const ip = req.ip ?? null;
  const ua = req.headers['user-agent'] ?? null;

  const identifierHash = throttleKey('email', email);
  const sourceHash = ip === null ? null : throttleKey('source', ip);

  /**
   * Record the attempt, spend the floor, and RETURN the one refusal to throw.
   *
   * Returns rather than throws, and that is a type-system fact rather than a
   * style choice: `await helper()` where the helper returns `Promise<never>`
   * does NOT narrow control flow in TypeScript, so every `user` access after
   * such a call was an error, and the obvious fix — a non-null assertion at
   * each site — would have put eleven `!`s on the one variable whose nullness
   * is the difference between "this address exists" and "it does not". `throw
   * await refusal(…)` narrows, and the compiler keeps checking.
   */
  const refusal = async (
    outcome: Parameters<typeof recordLoginAttempt>[0]['outcome'],
    backoffMs: number,
  ): Promise<Error> => {
    await recordLoginAttempt({ identifierHash, outcome, ip, userAgent: ua ?? null });
    await spendFloor(startedAt, LOGIN_TIME_FLOOR_MS + backoffMs);
    return unauthorized(LOGIN_REFUSAL);
  };

  const user = await unscoped(() =>
    prisma.user.findUnique({ where: { email }, select: LOGIN_USER_SELECT }),
  );

  /*
   * The membership is read BEFORE the password is verified, which is a change
   * of order and not of behaviour: its absence is still only acted on after the
   * password check below, so it cannot become an "is this address a member of
   * anything" probe. It is read early because the THROTTLE POLICY lives on the
   * organisation, and a throttle that resolved its policy after deciding
   * whether to refuse would be reading a setting it had already ignored.
   */
  const membership = user
    ? await unscoped(() =>
        prisma.membership.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'asc' },
          select: {
            orgId: true,
            role: true,
            org: {
              select: {
                id: true,
                name: true,
                slug: true,
                plan: true,
                enforceSso: true,
                securityControlModes: true,
                loginThrottlePolicy: true,
              },
            },
          },
        }),
      )
    : null;

  /**
   * THE ORGANISATION, OR NULL — AND NULL IS NOT A CRASH.
   *
   * Prisma types `membership.org` as non-null and it is, in a consistent
   * database. It is read into a local and checked anyway, because the four
   * brakes below read their stored mode off this object: a membership row whose
   * organisation cannot be read (a cascade mid-flight, a replica that has not
   * caught up) would otherwise throw a TypeError INSIDE the login path, and the
   * caller would get a 500 where every other refusal on this route is a 401 —
   * which is both a crash and a difference an attacker can observe.
   *
   * Treated as "not a member of any organisation", which is the refusal that
   * already exists for exactly this state and is applied below, after the
   * password check, so it cannot become a membership probe.
   */
  const memberOrg = membership?.org ?? null;

  const org: OrgSecurityContext | null = memberOrg
    ? {
        id: memberOrg.id,
        enforceSso: memberOrg.enforceSso,
        securityControlModes: memberOrg.securityControlModes,
        loginThrottlePolicy: memberOrg.loginThrottlePolicy,
      }
    : null;
  const policy = resolveLoginThrottle(org?.loginThrottlePolicy ?? null);
  /** The actor an OBSERVE count is written against. Only usable once the org is known. */
  const observer = org
    ? { userId: user?.id ?? '', orgId: org.id, ip, impersonatedBy: null }
    : null;

  // ── The throttle ──────────────────────────────────────────────────────────

  const throttle = await checkLoginThrottle({
    identifier: email,
    sourceIp: ip,
    storedPolicy: org?.loginThrottlePolicy ?? null,
    nowMs: io.now(),
  });

  /*
   * THE WINDOW BEFORE THE MIGRATION, HANDLED HERE AND NOT LEFT AS A NOTE.
   *
   * `wouldRefuse` is `false` on this arm by type, so the block below would do
   * nothing and the login would proceed un-throttled with no record that the
   * control was absent — which is a cap not applied and not counted. This is
   * the count and the noise. It is NOT gated on the brake mode, on purpose:
   * the mode chooses between enforcing and observing a control that EXISTS,
   * and an operator who set ENFORCE is owed the loudest possible signal that
   * what they armed is not installed.
   */
  if (throttle.availability === 'NOT_INSTALLED') await countThrottleNotInstalled(observer);

  if (throttle.wouldRefuse) {
    if (enforcing('LOGIN_THROTTLE', org)) {
      throw await refusal('LOCKED_OUT', throttle.backoffMs);
    }
    /*
     * OBSERVE: the `LOCKED_OUT` row is written and the caller is admitted. That
     * row IS the count the brake owes — `countWouldHaveRefused` in
     * lib/throttle.ts reads it — so the mode cannot be armed without the number
     * being available first.
     */
    await recordLoginAttempt({ identifierHash, outcome: 'LOCKED_OUT', ip, userAgent: ua ?? null });
    /*
     * `throttle.identifier` is non-null here because `wouldRefuse` is only ever
     * true on the MEASURED arm — the compiler proves that rather than a comment
     * claiming it, which is why the decision is a union and not a flag.
     */
    if (observer && throttle.identifier)
      await countObserved('LOGIN_THROTTLE', observer, { failures: throttle.identifier.failures });
  }

  // ── The password ──────────────────────────────────────────────────────────

  // Same error and roughly the same work whether the account exists or not, so
  // login cannot be used to enumerate registered addresses.
  const ok = user?.passwordHash
    ? await verifyPassword(input.password, user.passwordHash)
    : await verifyPassword(input.password, `scrypt$32768$8$1$${'A'.repeat(24)}$${'A'.repeat(88)}`);

  if (!user || !ok) {
    await countAttempt('identifier.failure', () =>
      recordFailure(identifierHash, policy, io.now()),
    );
    if (sourceHash !== null) {
      await countAttempt('source.failure', () =>
        recordFailure(
          sourceHash,
          { ...policy, maxFailures: policy.maxFailures * SOURCE_FAILURE_MULTIPLIER },
          io.now(),
          { canLock: false },
        ),
      );
    }
    throw await refusal(user ? 'BAD_PASSWORD' : 'UNKNOWN_IDENTIFIER', throttle.backoffMs);
  }

  // ── The second factor ─────────────────────────────────────────────────────

  /*
   * `totpEnabledAt` SET AND `totpConfirmedAt` NULL IS NOT ENROLLED.
   *
   * Every row that exists when this code lands is in exactly that state,
   * because enrolment never verified a code either — so a user may hold a
   * `totpEnabledAt` for a seed their authenticator never saw. Demanding a code
   * from them would lock them out of their own organisation; accepting any six
   * digits is the defect being fixed. Treating the pair as "not enrolled" is
   * the only reading that does neither.
   *
   * ── `!== null` AND NOT `!= null`, WHICH IS THE FAIL-CLOSED CHOICE ─────────
   *
   * Strict, so an `undefined` — which is what a `select` that stopped naming
   * this column would produce — takes the ENROLLED branch and asks for a code
   * nobody can supply. That is a loud, total, immediately visible outage. The
   * loose comparison would take the other branch and let every second factor
   * in the install through silently. Between a loud outage and a silent bypass
   * this is the right way round, and `LOGIN_USER_SELECT` plus a stand-in that
   * throws on a column it does not have (`auth.test.ts`) is what stops the
   * select drifting in the first place.
   */
  if (user.totpConfirmedAt !== null) {
    const supplied = input.totpCode;
    const recovery = recoveryCodeSchema.safeParse({ code: req.body?.recoveryCode });

    if (recovery.success) {
      /*
       * A recovery code is SINGLE USE, and the `usedAt: null` in the WHERE is
       * what makes it so — the update is the lock, so the same code presented
       * twice concurrently cannot both succeed. Looked up by hash: the code
       * itself is never stored and never compared in the clear.
       */
      const burned = await unscoped(() =>
        prisma.totpRecoveryCode.updateMany({
          where: {
            userId: user.id,
            codeHash: hashRecoveryCode(recovery.data.code),
            usedAt: null,
          },
          data: { usedAt: new Date(io.now()), usedFromIp: ip },
        }),
      );
      if (burned.count === 0) {
        await countAttempt('recovery.failure', () =>
          recordFailure(identifierHash, policy, io.now()),
        );
        throw await refusal('BAD_TOTP', throttle.backoffMs);
      }
    } else if (supplied === undefined) {
      /*
       * Specific, and safe to be: the caller has just proved they hold the
       * password, so "this account has a second factor" is not a fact being
       * revealed to anybody who did not already have it.
       */
      await recordLoginAttempt({ identifierHash, outcome: 'BAD_TOTP', ip, userAgent: ua ?? null });
      await spendFloor(startedAt, LOGIN_TIME_FLOOR_MS);
      throw unauthorized('A two-factor code is required');
    } else {
      const verdict = await verifyTotpCode({
        secretBase32: openTotpSecret(user),
        code: supplied,
        nowMs: io.now(),
        confirmedAt: user.totpConfirmedAt,
        userId: user.id,
        replay: io.replay,
      });

      if (!verdict.ok) {
        /*
         * A BAD CODE COUNTS AGAINST THE THROTTLE. Without this, a six-digit
         * space is brute-forceable at the full request rate behind a correct
         * password — which is the one place where the second factor is the only
         * thing left standing.
         */
        await countAttempt('totp.failure', () =>
          recordFailure(identifierHash, policy, io.now()),
        );
        await recordLoginAttempt({ identifierHash, outcome: 'BAD_TOTP', ip, userAgent: ua ?? null });

        if (enforcing('TOTP_VERIFICATION', org)) {
          await spendFloor(startedAt, LOGIN_TIME_FLOOR_MS + throttle.backoffMs);
          // The member (`verdict.refusal`) is operator-facing and stays in the
          // attempt row; the caller gets one sentence for all five, so a replay
          // cannot be told from a wrong code.
          throw unauthorized(TOTP_REFUSAL_SENTENCE);
        }
        /*
         * OBSERVE: admitted anyway, and counted. The brake's own words for what
         * this number is: "the size of the hole; it must not be left running."
         */
        if (observer) await countObserved('TOTP_VERIFICATION', observer, { refusal: verdict.refusal });
      }
    }
  }

  if (!membership || !memberOrg) {
    throw unauthorized('This account is not a member of any organization');
  }

  // ── Email verification ────────────────────────────────────────────────────

  if (user.emailVerified === null) {
    if (enforcing('EMAIL_VERIFICATION', org)) {
      await recordLoginAttempt({
        identifierHash,
        outcome: 'EMAIL_UNVERIFIED',
        ip,
        userAgent: ua ?? null,
      });
      await spendFloor(startedAt, LOGIN_TIME_FLOOR_MS);
      throw forbidden('Confirm your email address before signing in. Ask for a new link.');
    }
    await recordLoginAttempt({
      identifierHash,
      outcome: 'EMAIL_UNVERIFIED',
      ip,
      userAgent: ua ?? null,
    });
    if (observer) await countObserved('EMAIL_VERIFICATION', observer);
  }

  // ── Enforce-SSO ───────────────────────────────────────────────────────────

  if (org?.enforceSso) {
    /*
     * ── THE BREAK-GLASS, AND WHY IT IS THESE TWO DOORS AND NOT A FLAG ──────
     *
     * An org that refuses password login can be locked out of its own account
     * two ways, and a break-glass that is a setting somebody toggles is a
     * setting an attacker toggles. So neither door below is anything a caller
     * supplies:
     *
     *   1. NO USABLE CONNECTION. If the org has no ENABLED `SsoConnection`,
     *      password login still works. That covers the org that set the flag
     *      before configuring SSO, and the org whose only connection was
     *      disabled — including by us, on a certificate rotation. An attacker
     *      cannot reach this door, because reaching it would mean already
     *      holding the authority to disable the connection.
     *
     *   2. AN OWNER WITH A CONFIRMED SECOND FACTOR. If the IdP itself is down,
     *      door 1 does not open (the connection is still enabled) and the
     *      organisation is genuinely stranded. An OWNER who holds the password
     *      AND a verified TOTP code gets in. An attacker holding only the
     *      password does not, and one holding both has the IdP too.
     *
     * Both doors are AUDITED as a break-glass use, which is the half that makes
     * them reviewable rather than just permissive.
     */
    const usableConnections = await unscoped(() =>
      prisma.ssoConnection.count({ where: { orgId: org.id, enabled: true } }),
    );
    const brokeGlass =
      usableConnections === 0
        ? 'NO_ENABLED_SSO_CONNECTION'
        : membership.role === 'OWNER' && user.totpConfirmedAt !== null
          ? 'OWNER_WITH_SECOND_FACTOR'
          : null;

    if (brokeGlass === null) {
      if (enforcing('ENFORCE_SSO', org)) {
        await recordLoginAttempt({
          identifierHash,
          outcome: 'SSO_REQUIRED',
          ip,
          userAgent: ua ?? null,
        });
        await spendFloor(startedAt, LOGIN_TIME_FLOOR_MS);
        throw forbidden('This organization signs in through its identity provider.');
      }
      await recordLoginAttempt({
        identifierHash,
        outcome: 'SSO_REQUIRED',
        ip,
        userAgent: ua ?? null,
      });
      if (observer) await countObserved('ENFORCE_SSO', observer);
    } else {
      await withTenant(org.id, () =>
        audit({
          actor: { userId: user.id, orgId: org.id, ip, impersonatedBy: null },
          action: 'auth.sso.break_glass',
          targetType: 'Organization',
          targetId: org.id,
          metadata: { door: brokeGlass, role: membership.role },
        }),
      );
    }
  }

  // ── Admitted ──────────────────────────────────────────────────────────────

  const issued = await issueSession(user.id, membership.orgId, ip, ua ?? null, req.body?.deviceLabel);

  await countAttempt('identifier.success', () => recordSuccess(identifierHash, io.now()));
  if (sourceHash !== null) {
    await countAttempt('source.success', () => recordSuccess(sourceHash, io.now()));
  }
  await recordLoginAttempt({ identifierHash, outcome: 'SUCCESS', ip, userAgent: ua ?? null });

  await unscoped(() =>
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(io.now()) } }),
  );

  await spendFloor(startedAt, LOGIN_TIME_FLOOR_MS);

  res.setHeader('Set-Cookie', authCookies(issued)).json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified !== null,
    },
    org: {
      id: memberOrg.id,
      name: memberOrg.name,
      slug: memberOrg.slug,
      plan: memberOrg.plan,
      role: membership.role,
    },
    csrfToken: issued.csrf,
  });
});

authRouter.post('/logout', async (req, res) => {
  const raw = rawSessionToken(req);
  if (raw) {
    await unscoped(() =>
      prisma.session.updateMany({
        where: { tokenHash: hashToken(raw), revokedAt: null },
        // The reason vocabulary exists so a session row can say WHY it stopped
        // working. `USER_SIGNED_OUT` is the one state that is not an incident.
        data: {
          revokedAt: new Date(io.now()),
          revokedReason: 'USER_SIGNED_OUT',
          revokedBy: req.actor?.userId ?? null,
        },
      }),
    );
  }
  res
    .setHeader('Set-Cookie', [sessionCookie('', 0), csrfCookie('', 0)])
    .json({ ok: true });
});

// ─── Sessions ───────────────────────────────────────────────────────────────

/**
 * THE LIST. The thing that makes "sign out my lost laptop" possible.
 *
 * The token is not in the projection and `sessions.test.ts` asserts the
 * absence rather than trusting this sentence.
 */
authRouter.get('/sessions', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const raw = rawSessionToken(req);

  const sessions = await listSessions(actor.userId, {
    nowMs: io.now(),
    currentTokenHash: raw === null ? null : hashToken(raw),
  });

  res.json({ sessions });
});

/**
 * REVOKE ONE. Immediate, because `middleware/auth.ts` reads `revokedAt` on
 * every request and there is no token cache between them.
 *
 * A session belonging to somebody else is a 404 and not a 403: the two must be
 * indistinguishable, or an id becomes a probe for whose session it is.
 */
authRouter.delete('/sessions/:sessionId', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const sessionId = String(req.params.sessionId ?? '');

  const revoked = await revokeSession({
    userId: actor.userId,
    sessionId,
    reason: 'USER_REVOKED_DEVICE',
    byUserId: actor.userId,
    nowMs: io.now(),
  });
  if (!revoked) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
    return;
  }

  await audit({
    actor,
    action: 'session.revoke',
    targetType: 'Session',
    targetId: sessionId,
    metadata: { reason: 'USER_REVOKED_DEVICE' },
  });

  res.json({ ok: true });
});

/**
 * REVOKE THE REST. `?includeCurrent=true` revokes this one too.
 *
 * The count is in the response, because a bulk action that reports "done"
 * without a number is a bulk action nobody can verify.
 */
authRouter.post('/sessions/revoke-all', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const raw = rawSessionToken(req);
  const includeCurrent = req.body?.includeCurrent === true;

  const revoked = await revokeAllSessions({
    userId: actor.userId,
    exceptTokenHash: includeCurrent || raw === null ? null : hashToken(raw),
    reason: 'ALL_SESSIONS_REVOKED',
    byUserId: actor.userId,
    nowMs: io.now(),
  });

  await audit({
    actor,
    action: 'session.revoke_all',
    targetType: 'User',
    targetId: actor.userId,
    metadata: { revoked, includeCurrent },
  });

  res.json({ ok: true, revoked, includeCurrent });
});

// ─── TOTP enrolment ─────────────────────────────────────────────────────────

/**
 * STEP ONE: mint a seed, seal it, and hand back the QR payload.
 *
 * `totpEnabledAt` is set and `totpConfirmedAt` is NOT. Until a code verifies,
 * this user has no second factor as far as login is concerned — which is what
 * makes the enrolment two steps instead of the one step that produced the
 * defect.
 *
 * ── THE RESPONSE IS A CREDENTIAL AND THE AUDIT ENTRY IS NOT ────────────────
 *
 * The body carries the seed and the `otpauth://` URI, once, to the person who
 * just authenticated as this user. The audit entry carries neither, and
 * `auth.test.ts` asserts that. `seal()` also returns a `hint` — the last four
 * characters of the plaintext — which is useful for a secret an operator needs
 * to recognise and is a partial credential for this one, so it is deliberately
 * not read.
 */
authRouter.post('/totp/enrol', requireAuth, async (req, res) => {
  const actor = actorOf(req);

  const user = await unscoped(() =>
    prisma.user.findUnique({
      where: { id: actor.userId },
      select: { id: true, email: true, totpConfirmedAt: true },
    }),
  );
  if (!user) throw unauthorized();
  if (user.totpConfirmedAt !== null) {
    // Re-enrolling silently would replace a working factor with an unconfirmed
    // one and leave the user with neither.
    throw conflict('Two-factor authentication is already set up. Turn it off first.');
  }

  const secret = generateTotpSecret(io.random);
  const sealed = seal(secret, user.id, TOTP_SEAL_NAME);

  await unscoped(() =>
    prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecretEnc: sealed.ciphertext,
        totpSecretKeyVersion: sealed.keyVersion,
        totpEnabledAt: new Date(io.now()),
        totpConfirmedAt: null,
      },
      select: { id: true },
    }),
  );

  await audit({
    actor,
    action: 'user.totp.enrol_started',
    targetType: 'User',
    targetId: user.id,
    metadata: { keyVersion: sealed.keyVersion },
  });

  res.json({
    secret,
    otpauthUrl: totpEnrolmentUri(secret, user.email, 'QAAI'),
    confirmed: false,
  });
});

/**
 * STEP TWO: a code that verifies, and the recovery codes that come with it.
 *
 * `totpEnrolmentSchema` refuses `confirmed: true` with no code, which is the
 * schema half of the same rule. This is the half that checks the code.
 */
authRouter.post('/totp/confirm', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const input = totpEnrolmentSchema.parse({ ...req.body, confirmed: true });

  const user = await unscoped(() =>
    prisma.user.findUnique({
      where: { id: actor.userId },
      select: {
        id: true,
        totpSecretEnc: true,
        totpSecretKeyVersion: true,
        totpEnabledAt: true,
        totpConfirmedAt: true,
      },
    }),
  );
  if (!user) throw unauthorized();
  if (user.totpEnabledAt === null) throw badRequest('Start the two-factor setup first.');

  const verdict = await verifyTotpCode({
    secretBase32: openTotpSecret(user),
    code: input.code!,
    nowMs: io.now(),
    /*
     * The seed being confirmed RIGHT NOW. `verifyTotpCode` refuses a null
     * `confirmedAt` — correctly, because a code cannot be checked against a
     * factor nobody has proved — and this call is the act of proving it, so the
     * clock is passed in its place.
     */
    confirmedAt: new Date(io.now()),
    userId: user.id,
    replay: io.replay,
  });
  if (!verdict.ok) throw badRequest(TOTP_REFUSAL_SENTENCE);

  const minted = mintRecoveryCodes(input.recoveryCodeCount, io.random);

  await unscoped(() =>
    prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { totpConfirmedAt: new Date(io.now()) },
      });
      /*
       * Any codes from an earlier attempt are DELETED rather than left beside
       * the new ones. A printout the user threw away must stop working, and a
       * recovery code that outlives the enrolment it belonged to is a
       * credential nobody is tracking.
       */
      await tx.totpRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.totpRecoveryCode.createMany({
        data: minted.hashes.map((codeHash) => ({ userId: user.id, codeHash })),
      });
    }),
  );

  await audit({
    actor,
    action: 'user.totp.confirmed',
    targetType: 'User',
    targetId: user.id,
    metadata: { recoveryCodes: minted.hashes.length },
  });

  // Shown ONCE. Nothing stores or logs these.
  res.json({ confirmed: true, recoveryCodes: minted.display });
});

/**
 * TURN IT OFF. The current password AND a working factor.
 *
 * Both, because either alone is a way to strip a second factor off a borrowed
 * laptop: the session is not enough (that is what the password is for) and the
 * password is not enough (that is what the factor is for). Every other session
 * is cut, with `TOTP_CHANGED` as the recorded reason.
 */
authRouter.post('/totp/disable', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const currentPassword = String(req.body?.currentPassword ?? '');

  const user = await unscoped(() =>
    prisma.user.findUnique({
      where: { id: actor.userId },
      select: {
        id: true,
        passwordHash: true,
        totpSecretEnc: true,
        totpSecretKeyVersion: true,
        totpConfirmedAt: true,
      },
    }),
  );
  if (!user) throw unauthorized();
  if (user.totpConfirmedAt === null) throw badRequest('Two-factor authentication is not on.');
  if (!user.passwordHash) {
    throw badRequest('This account signs in through your identity provider and has no password.');
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw badRequest('That is not your current password.');
  }

  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  const verdict = await verifyTotpCode({
    secretBase32: openTotpSecret(user),
    code,
    nowMs: io.now(),
    confirmedAt: user.totpConfirmedAt,
    userId: user.id,
    replay: io.replay,
  });
  if (!verdict.ok) throw badRequest(TOTP_REFUSAL_SENTENCE);

  const raw = rawSessionToken(req);
  await unscoped(() =>
    prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          totpSecretEnc: null,
          totpSecretKeyVersion: null,
          totpEnabledAt: null,
          totpConfirmedAt: null,
        },
      });
      await tx.totpRecoveryCode.deleteMany({ where: { userId: user.id } });
    }),
  );

  const revoked = await revokeAllSessions({
    userId: user.id,
    exceptTokenHash: raw === null ? null : hashToken(raw),
    reason: 'TOTP_CHANGED',
    byUserId: user.id,
    nowMs: io.now(),
  });

  await audit({
    actor,
    action: 'user.totp.disabled',
    targetType: 'User',
    targetId: user.id,
    metadata: { sessionsRevoked: revoked },
  });

  res.json({ ok: true, sessionsRevoked: revoked });
});

/** Re-mint the recovery codes. Needs a working code, because the codes are the factor's spare. */
authRouter.post('/totp/recovery-codes', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const input = totpEnrolmentSchema.parse({ ...req.body, confirmed: true });

  const user = await unscoped(() =>
    prisma.user.findUnique({
      where: { id: actor.userId },
      select: {
        id: true,
        totpSecretEnc: true,
        totpSecretKeyVersion: true,
        totpConfirmedAt: true,
      },
    }),
  );
  if (!user) throw unauthorized();
  if (user.totpConfirmedAt === null) throw badRequest('Two-factor authentication is not on.');

  const verdict = await verifyTotpCode({
    secretBase32: openTotpSecret(user),
    code: input.code!,
    nowMs: io.now(),
    confirmedAt: user.totpConfirmedAt,
    userId: user.id,
    replay: io.replay,
  });
  if (!verdict.ok) throw badRequest(TOTP_REFUSAL_SENTENCE);

  const minted = mintRecoveryCodes(input.recoveryCodeCount, io.random);

  await unscoped(() =>
    prisma.$transaction(async (tx) => {
      await tx.totpRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.totpRecoveryCode.createMany({
        data: minted.hashes.map((codeHash) => ({ userId: user.id, codeHash })),
      });
    }),
  );

  await audit({
    actor,
    action: 'user.totp.recovery_codes_reminted',
    targetType: 'User',
    targetId: user.id,
    metadata: { recoveryCodes: minted.hashes.length },
  });

  res.json({ recoveryCodes: minted.display });
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
  const startedAt = io.now();
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
    const expiresAt = new Date(io.now() + RESET_TTL_MINUTES * 60_000);

    await unscoped(async () => {
      /*
       * Any earlier unused reset for this address stops working the moment a new
       * one is asked for. Otherwise every request ever made stays live until it
       * expires, so a single leaked old email is enough.
       */
      await prisma.verificationToken.updateMany({
        where: { email, purpose: 'PASSWORD_RESET', usedAt: null },
        data: { usedAt: new Date(io.now()) },
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
  await spendFloor(startedAt, FORGOT_TIME_BUDGET_MS);

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
  if (record.expiresAt < new Date(io.now())) throw invalid;

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
        data: { usedAt: new Date(io.now()) },
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
        data: {
          revokedAt: new Date(io.now()),
          revokedReason: 'PASSWORD_CHANGED',
          revokedBy: user.id,
        },
      });
    }),
  );

  /*
   * THE UNLOCK PATH. A completed reset clears the login lock, because a hard
   * lock is a denial-of-service weapon against a known address and this is the
   * one door the real owner can open and somebody locking them out cannot:
   * it needs a single-use token that was mailed to the address. Not a bypass —
   * by the time this runs the password has changed and every session is dead,
   * so there is nothing left for the guesses to aim at.
   */
  try {
    await clearLoginLock(record.email, io.now());
  } catch (err) {
    /*
     * BEST-EFFORT, AND THAT IS THE FAIL-CLOSED DIRECTION. The password change
     * and the session revocations above are already COMMITTED, so a throw here
     * would answer 500 for a reset that completely succeeded — and the user
     * would not know their password had changed.
     *
     * Leaving the lock in place IS the closed state: the identifier stays
     * locked, nothing is opened, and the remedy is to wait it out or reset
     * again. Logged because an unlock that cannot be written is a database
     * problem nobody would otherwise see.
     */
    logger.error({ err }, 'could not clear the login lock after a password reset');
  }

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
  const raw = rawSessionToken(req);

  await unscoped(() =>
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
  );

  /*
   * Other sessions are revoked; THIS one survives. Signing someone out of the
   * tab they just changed their password in reads as a failure, and every other
   * device is the thing actually worth cutting off.
   *
   * Through `revokeAllSessions` rather than an inline `updateMany`, so the
   * reason and the actor are written the same way they are written everywhere
   * else — a revocation with no recorded reason is a row a reviewer cannot
   * explain, and there is already a legitimate population of those (rows
   * revoked before the column existed).
   */
  const revoked = await revokeAllSessions({
    userId: user.id,
    exceptTokenHash: raw === null ? null : hashToken(raw),
    reason: 'PASSWORD_CHANGED',
    byUserId: user.id,
    nowMs: io.now(),
  });

  await audit({
    actor,
    action: 'user.password.change',
    targetType: 'User',
    targetId: user.id,
    metadata: { sessionsRevoked: revoked },
  });

  res.json({ ok: true, sessionsRevoked: revoked });
});

/**
 * HOW MANY RECOVERY CODES ARE LEFT, or NULL when it could not be read.
 *
 * The read `TotpRecoveryCode`'s own `@@index([userId, usedAt])` exists for, and
 * the number that decides whether the security page prompts for a re-mint. A
 * count and never the codes: no endpoint returns a recovery code after the one
 * response that minted it.
 *
 * `usedAt: null` in the WHERE rather than a count of all rows, because "three
 * of your ten codes are gone" is the fact a person acts on and "you have ten
 * codes" is the fact that gets them locked out.
 *
 * NULL AND NEVER ZERO ON FAILURE. Zero reads as "you have none left, mint
 * more"; null reads as "we could not tell you", which is the truth. A number
 * reported as measured that was not measured is one of the lies this product
 * cannot afford, and a security page is the worst place for one.
 */
async function countRemainingRecoveryCodes(userId: string): Promise<number | null> {
  try {
    return await unscoped(() =>
      prisma.totpRecoveryCode.count({ where: { userId, usedAt: null } }),
    );
  } catch (err) {
    logger.error({ err }, 'could not count the remaining recovery codes');
    return null;
  }
}

authRouter.get('/me', requireAuth, async (req, res) => {
  const actor = actorOf(req);

  const user = await unscoped(() =>
    prisma.user.findUnique({
      where: { id: actor.userId },
      select: {
        id: true,
        email: true,
        name: true,
        isSuperuser: true,
        emailVerified: true,
        totpEnabledAt: true,
        totpConfirmedAt: true,
      },
    }),
  );

  const memberships = await unscoped(() =>
    prisma.membership.findMany({
      where: { userId: actor.userId },
      select: { role: true, org: { select: { id: true, name: true, slug: true, plan: true } } },
    }),
  );

  const recoveryCodesRemaining = user ? await countRemainingRecoveryCodes(user.id) : null;

  const raw = rawSessionToken(req);

  res.json({
    user: user && {
      ...user,
      /*
       * THE PAIR, REPORTED AS THE PAIR. `totpEnabledAt` set with
       * `totpConfirmedAt` null is NOT ENROLLED, and the screen has to be able
       * to say "you started setting this up and never finished" rather than
       * either "2FA is on" (a lie) or nothing at all (which is how the user
       * never finishes). Two facts, two fields — never collapsed to one
       * boolean.
       */
      twoFactor: {
        started: user.totpEnabledAt !== null,
        confirmed: user.totpConfirmedAt !== null,
        recoveryCodesRemaining,
      },
      emailVerified: user.emailVerified !== null,
    },
    activeOrgId: actor.orgId,
    orgs: memberships.map((m) => ({ ...m.org, role: m.role })),
    /*
     * Returned so a page that was loaded before the cookie existed, or one whose
     * readable cookie a browser extension has eaten, can recover the token
     * without re-authenticating. Safe to return to a caller who already holds
     * the session: it is derived from that session and authorises nothing else.
     */
    csrfToken: raw === null ? null : csrfTokenFor(hashToken(raw)),
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

  const raw = rawSessionToken(req);
  if (raw) {
    await unscoped(() =>
      prisma.session.updateMany({
        where: { tokenHash: hashToken(raw) },
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
