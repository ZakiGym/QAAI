/**
 * Per-identifier and per-source login throttling, and the evidence behind it.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * There was none of this. `apps/api/src/index.ts` mounts `express-rate-limit`
 * at 300 requests a minute PER IP across the whole API, which is not a login
 * control: a password list walked from a hundred addresses never comes near it,
 * and one address walking a list of a thousand EMAILS spends a third of its
 * budget doing it. Credential stuffing was unimpeded, no failed attempt was
 * recorded anywhere, and `LoginThrottle` / `LoginAttempt` did not exist.
 *
 * ── BACKOFF FIRST, LOCK AS THE CEILING, AND WHY THAT WAY ROUND ─────────────
 *
 * A hard lock is a denial-of-service weapon: anybody who knows an address can
 * fail ten logins against it and take its owner offline. A backoff is not —
 * it costs the attacker time proportional to their own guessing and costs a
 * legitimate user nothing, because a legitimate user's first or second attempt
 * succeeds. So the primary brake is a growing delay, the first half of the
 * budget is free (a human mistyping twice must notice nothing at all), and the
 * hard lock is only the ceiling: short, self-clearing, and with an unlock path
 * the real user can always reach — `POST /auth/password/reset` clears it,
 * because controlling the mailbox is proof an attacker locking somebody out
 * does not have.
 *
 * ── TWO NAMESPACES IN ONE TABLE ────────────────────────────────────────────
 *
 * `LoginThrottle.identifierHash` is unique, and this module stores both the
 * per-identifier counter and the per-source counter in it, under
 * {@link THROTTLE_NAMESPACES}-prefixed inputs so the two can never collide.
 * The source counter is deliberately MUCH more generous and NEVER hard-locks:
 * an office behind one NAT address is one source, and hard-locking it is
 * locking a building out of its own account.
 *
 * ── NO ORACLE ──────────────────────────────────────────────────────────────
 *
 * A row is created for addresses that have NO ACCOUNT — that is what makes
 * per-identifier throttling possible without telling the caller which accounts
 * exist. Nothing in this module varies its work or its verdict on whether the
 * identifier is known, and `routes/auth.ts` answers every refusal with one
 * sentence under one fixed time floor. The test that matters is the one
 * comparing a LOCKED EXISTING account with a NONEXISTENT one, body and timing.
 *
 * ── RULE 11 ────────────────────────────────────────────────────────────────
 *
 * Nothing in this file accepts, stores, returns or logs a password, a code or a
 * token. The identifier itself is hashed before it reaches a row, and no
 * function here writes a log line at all.
 */

import { createHash } from 'node:crypto';
import { recordLoginAttemptSchema, resolveLoginThrottle } from '@qaai/shared';
import type { LoginAttemptOutcome, LoginThrottlePolicy } from '@qaai/shared';
import { prisma, unscoped } from './prisma.js';

/**
 * WHAT A COUNTER IS KEYED ON. Prefixed before hashing, so the two namespaces
 * cannot collide and an operator reading a row knows which kind it is only by
 * reproducing the hash — which is the same trade the column already documents.
 *
 * NOTE, because the column's own comment says "SHA-256 of the lower-cased
 * identifier": the input hashed here is `email:<address>` or `source:<ip>`, not
 * the bare address. The operator's join from a `User.email` they already hold
 * still works; it needs the prefix. The one-line correction to that comment is
 * listed in this round's `needsFromOtherFiles`, because schema.prisma is not
 * this agent's file and a comment that disagrees with its writer is a defect.
 */
export const THROTTLE_NAMESPACES = ['email', 'source'] as const;
export type ThrottleNamespace = (typeof THROTTLE_NAMESPACES)[number];

/**
 * The counter key for one identifier.
 *
 * PLAIN SHA-256 and not the keyed `hashToken`, matching what
 * `recordLoginAttemptSchema` requires (`/^[0-9a-f]{64}$/`) and what the column
 * records. The comment on `LoginThrottle.identifierHash` is explicit that this
 * is a KEY AND NOT ANONYMISATION — an email is recoverable from its digest by a
 * dictionary in seconds — and that is accurate and deliberate: what the digest
 * buys is that the table cannot be READ as a list of addresses somebody is
 * walking, which is the only property it claims.
 */
export function throttleKey(namespace: ThrottleNamespace, value: string): string {
  return createHash('sha256').update(`${namespace}:${value.trim().toLowerCase()}`).digest('hex');
}

/**
 * HOW HARD THE BACKOFF BITES.
 *
 * `freeFailures` is half the policy's budget, rounded up: a human who mistypes
 * their password twice must notice nothing, and the clamp in
 * `resolveLoginThrottle` keeps `maxFailures` at 3 or more, so there is always
 * at least one free attempt.
 *
 * The cap is four seconds. Not larger: every held request is a held socket, and
 * a throttle that becomes a memory-exhaustion surface has traded one
 * availability problem for another. Four seconds against a six-digit or
 * password-list guess rate is the difference between millions of attempts an
 * hour and nine hundred.
 */
export const BACKOFF_BASE_MS = 250;
export const BACKOFF_CAP_MS = 4_000;

/**
 * THE SOURCE COUNTER'S OWN POLICY: ten times the failures, and no lock at all.
 *
 * A multiplier on the resolved per-identifier policy rather than its own stored
 * column, so a customer who raises the threshold for a CI job that signs in on
 * every build raises both together and cannot end up with a source limit below
 * their identifier limit — which would make the per-identifier setting
 * unreachable and look, from the outside, exactly like the identifier limit
 * being ignored.
 */
export const SOURCE_FAILURE_MULTIPLIER = 10;

/** The columns this module reads. Named so a `select` can be checked against it. */
export interface ThrottleState {
  readonly failures: number;
  readonly windowStart: Date;
  readonly lockedUntil: Date | null;
  readonly lockCount: number;
}

/**
 * ONE COUNTER'S VERDICT. Pure: no clock, no database, no logging.
 *
 * `wouldRefuse` and `refused` are TWO FACTS and not one, which is the whole
 * mechanism behind the OBSERVE brake: `wouldRefuse` is what the control
 * decided, `refused` is what the caller is told to do about it, and in OBSERVE
 * mode the first is true while the second is false. One field for both would
 * make "how many logins would we have blocked" unanswerable, which is the only
 * question OBSERVE mode exists to answer.
 */
export interface ThrottleVerdict {
  /** True when this counter is over its budget, whatever the mode. */
  readonly wouldRefuse: boolean;
  /** How long to hold the response before answering. Applies in BOTH modes. */
  readonly backoffMs: number;
  /** Consecutive failures inside the current window, after window expiry is applied. */
  readonly failures: number;
  /** When the lock lifts, or null. Null in the source namespace, always. */
  readonly lockedUntil: Date | null;
}

/**
 * Has the window this row was counting in already passed?
 *
 * Exported because {@link recordFailure} and {@link throttleVerdict} must agree
 * about it — a verdict that treats the window as live while the writer resets it
 * is a counter that never reaches its threshold.
 */
export function windowExpired(state: ThrottleState, policy: LoginThrottlePolicy, nowMs: number): boolean {
  return state.windowStart.getTime() + policy.windowMinutes * 60_000 <= nowMs;
}

/**
 * The delay for a given failure count. Exponential above the free half, capped.
 *
 * Deterministic and not jittered, deliberately: jitter here would make the
 * timing-equality test between a locked account and a nonexistent one
 * unprovable, and the thing jitter defends against (a clock-based side channel)
 * is already closed by the fixed response floor in `routes/auth.ts`.
 */
export function backoffFor(failures: number, policy: LoginThrottlePolicy): number {
  const free = Math.ceil(policy.maxFailures / 2);
  if (failures <= free) return 0;
  const steps = failures - free - 1;
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** steps);
}

/**
 * Read one counter row into a verdict.
 *
 * A MISSING ROW IS NOT A REFUSAL — it is a first attempt, and the overwhelming
 * majority of logins are one. That is the one place in this round where absence
 * means allow, and it is sound because the row is created by the FAILURE path:
 * there is no state an attacker can withhold to get a pass.
 */
export function throttleVerdict(
  state: ThrottleState | null,
  policy: LoginThrottlePolicy,
  nowMs: number,
  options: { readonly canLock: boolean } = { canLock: true },
): ThrottleVerdict {
  if (state === null) {
    return { wouldRefuse: false, backoffMs: 0, failures: 0, lockedUntil: null };
  }

  if (options.canLock && state.lockedUntil !== null && state.lockedUntil.getTime() > nowMs) {
    return {
      wouldRefuse: true,
      // A locked identifier still pays the maximum backoff, so a caller cannot
      // tell "locked" from "nearly locked" by how fast the answer came.
      backoffMs: BACKOFF_CAP_MS,
      failures: state.failures,
      lockedUntil: state.lockedUntil,
    };
  }

  const failures = windowExpired(state, policy, nowMs) ? 0 : state.failures;
  return {
    wouldRefuse: options.canLock && failures >= policy.maxFailures,
    backoffMs: backoffFor(failures, policy),
    failures,
    lockedUntil: null,
  };
}

// ─── The stored half ────────────────────────────────────────────────────────

/** The one `select` this module reads. Kept as a constant so no caller re-lists it. */
const THROTTLE_SELECT = {
  failures: true,
  windowStart: true,
  lockedUntil: true,
  lockCount: true,
} as const;

/** Read a counter. `LoginThrottle` is GLOBAL, so every access is unscoped. */
export async function readThrottle(identifierHash: string): Promise<ThrottleState | null> {
  return unscoped(() =>
    prisma.loginThrottle.findUnique({
      where: { identifierHash },
      select: THROTTLE_SELECT,
    }),
  );
}

/**
 * BOTH COUNTERS FOR ONE ATTEMPT, as one decision.
 *
 * The two are combined by taking the WORST: the longest backoff and either
 * refusal. A caller that read only the identifier counter would let a hundred
 * addresses be walked from one host at full speed, and one that read only the
 * source counter would let a distributed list-walk through — the pair is the
 * control, and reading them in one function is what stops a call site
 * forgetting the second.
 */
/**
 * WHETHER THE COUNTERS WERE READ AT ALL, and why that is its own field.
 *
 * ── THE DEFECT, MEASURED ───────────────────────────────────────────────────
 *
 * `LoginThrottle` arrives in a hand-written migration, and the code reaches a
 * deployment before `prisma migrate deploy` does. Until it runs the relation
 * does not exist, the read below is deliberately unwrapped — an unreadable lock
 * must not be assumed open — and MEASURED by driving the real router over a
 * loopback socket with the one relation answering Postgres's own
 * "relation does not exist": `POST /auth/login` answered **500, for every
 * caller, with no account able to sign in**. That is fail-closed AND a total
 * login outage, and nobody owned the window.
 *
 * ── THE TWO FACTS THAT WERE ONE FIELD ──────────────────────────────────────
 *
 * A thrown read conflated two situations that call for opposite answers:
 *
 *   NOT_INSTALLED  the TABLE is absent. No counter has ever been written, so
 *                  there is no lock anywhere and nothing to honour. "This
 *                  control is not installed yet" — and refusing every login in
 *                  the name of a control that holds no state protects nobody.
 *   (anything else) the table is there and could not be READ: a dropped
 *                  connection, a permission change, a statement timeout. "I
 *                  cannot tell whether you are locked out", which is the
 *                  fail-closed case and still propagates.
 *
 * Only the first is degraded, it is distinguished by Postgres's own error code
 * and nothing looser, and it is COUNTED and LOGGED AT ERROR on every attempt it
 * admits — see `loginThrottleUnavailable` in routes/auth.ts and
 * `SECURITY_CONTROL_BRAKES.LOGIN_THROTTLE`, whose paragraph names this window.
 *
 * NOT A BRAKE MODE. An operator cannot choose this; it is a fact about the
 * database, it clears itself the moment the migration runs, and it is reported
 * as NOT_INSTALLED rather than as a measured zero — a verdict of
 * `failures: 0` here would be a number nobody measured.
 */
export const THROTTLE_AVAILABILITY = ['MEASURED', 'NOT_INSTALLED'] as const;
export type ThrottleAvailability = (typeof THROTTLE_AVAILABILITY)[number];

/**
 * Postgres's "relation does not exist", as Prisma reports it.
 *
 * The CODE and not the message: the message is localised and quotes the
 * invocation, and matching on its text is how a recogniser comes to accept a
 * timeout as a missing table. `P2021` is the only code that means the relation
 * is absent; `P1001`/`P1002` (unreachable, timed out) and `P2024` (pool
 * exhausted) deliberately do not match, because those are the "cannot tell"
 * case and must keep failing closed.
 */
const RELATION_DOES_NOT_EXIST = 'P2021';

/** True for exactly the missing-relation error, and for nothing that merely looks like it. */
export function throttleTableAbsent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { readonly code?: unknown }).code === RELATION_DOES_NOT_EXIST
  );
}

/**
 * A DISCRIMINATED UNION AND NOT A FLAG BESIDE THE VERDICTS.
 *
 * `identifier` and `source` are null on the NOT_INSTALLED arm, so a call site
 * cannot read `decision.identifier.failures` without narrowing first — the
 * compiler refuses it. A boolean `installed` field beside two always-present
 * verdicts would have let the existing call site go on reading
 * `throttle.identifier.failures` and report a fabricated zero as the number of
 * failures observed, which is the lie this field exists to prevent.
 */
export type LoginThrottleDecision =
  | {
      readonly availability: 'MEASURED';
      readonly identifier: ThrottleVerdict;
      readonly source: ThrottleVerdict;
      readonly wouldRefuse: boolean;
      readonly backoffMs: number;
    }
  | {
      readonly availability: 'NOT_INSTALLED';
      readonly identifier: null;
      readonly source: null;
      /* Nothing was read, so nothing may be refused and nothing may be waited for. */
      readonly wouldRefuse: false;
      readonly backoffMs: 0;
    };

export interface CheckThrottleInput {
  /** The address as supplied. Hashed here; never stored or logged in the clear. */
  readonly identifier: string;
  /** The client address, or null when the request arrived without one. */
  readonly sourceIp: string | null;
  /** `Organization.loginThrottlePolicy` for the identifier's org, or null/undefined. */
  readonly storedPolicy?: unknown;
  readonly nowMs: number;
}

export async function checkLoginThrottle(
  input: CheckThrottleInput,
): Promise<LoginThrottleDecision> {
  const policy = resolveLoginThrottle(input.storedPolicy);
  const sourcePolicy: LoginThrottlePolicy = {
    ...policy,
    maxFailures: policy.maxFailures * SOURCE_FAILURE_MULTIPLIER,
  };

  let identifierState: ThrottleState | null;
  try {
    identifierState = await readThrottle(throttleKey('email', input.identifier));
  } catch (err) {
    /*
     * THE ONLY CAUGHT ERROR IN THIS MODULE, and it is caught on the FIRST read
     * so the second is never attempted against a relation that is not there.
     * Anything that is not the missing relation is re-thrown unchanged: a read
     * that failed for any other reason leaves us unable to say whether this
     * identifier is locked, and the only fail-closed answer to that is the 500
     * this re-throw produces.
     */
    if (!throttleTableAbsent(err)) throw err;
    return { availability: 'NOT_INSTALLED', identifier: null, source: null, wouldRefuse: false, backoffMs: 0 };
  }
  /*
   * A request with no source address gets NO source counter rather than a
   * shared "unknown" bucket. A shared bucket is one counter for every caller
   * behind a proxy that strips the header, which would lock them out of each
   * other's accounts — a control that manufactures the outage it was built to
   * prevent.
   */
  const sourceState =
    input.sourceIp === null ? null : await readThrottle(throttleKey('source', input.sourceIp));

  const identifier = throttleVerdict(identifierState, policy, input.nowMs);
  const source = throttleVerdict(sourceState, sourcePolicy, input.nowMs, { canLock: false });

  return {
    availability: 'MEASURED',
    identifier,
    source,
    wouldRefuse: identifier.wouldRefuse || source.wouldRefuse,
    backoffMs: Math.max(identifier.backoffMs, source.backoffMs),
  };
}

/** What one counter looked like after a failure was written. */
export interface RecordedFailure {
  readonly failures: number;
  readonly lockedUntil: Date | null;
  readonly lockCount: number;
}

/**
 * Write one failure against one counter, locking if it crossed the threshold.
 *
 * An `upsert`, because the row for an address nobody has ever failed against
 * does not exist and must be created by the first failure — that is how an
 * address with no account gets a counter, which is what makes the control
 * oracle-free.
 *
 * The window is reset HERE as well as read in {@link throttleVerdict}: a
 * failure after the window passed starts a new window at one failure, not at
 * eleven, so a user who gets it wrong once a week is never locked.
 */
export async function recordFailure(
  identifierHash: string,
  policy: LoginThrottlePolicy,
  nowMs: number,
  options: { readonly canLock: boolean } = { canLock: true },
): Promise<RecordedFailure> {
  const now = new Date(nowMs);
  const existing = await readThrottle(identifierHash);

  /**
   * A LIVE LOCK IS NEVER RE-LOCKED, and an EXPIRED one starts the count over.
   *
   * Both halves were missing on the first draft and the test caught it, which
   * is worth recording because the comment was already right and the code was
   * not:
   *
   *   - Without `alreadyLocked`, every failure past the threshold wrote a NEW,
   *     LATER `lockedUntil`. That sounds harmless and is not: the attacker
   *     chooses when it is written, so a lock whose end they can move is a lock
   *     they can hold a legitimate user inside indefinitely — the hard lock
   *     becoming the denial-of-service weapon it was designed around.
   *   - Without `lockExpired`, a row that had just come out of a lock was still
   *     at or above the threshold, so the single next failure re-locked
   *     immediately whenever `lockMinutes` is shorter than `windowMinutes`. One
   *     mistyped password after a lock lifts would start another one.
   */
  const alreadyLocked = existing?.lockedUntil != null && existing.lockedUntil.getTime() > nowMs;
  const lockExpired = existing?.lockedUntil != null && existing.lockedUntil.getTime() <= nowMs;

  const fresh = existing === null || lockExpired || windowExpired(existing, policy, nowMs);
  const failures = fresh ? 1 : existing.failures + 1;
  const crossed = options.canLock && !alreadyLocked && failures >= policy.maxFailures;
  const lockedUntil = crossed ? new Date(nowMs + policy.lockMinutes * 60_000) : null;
  const lockCount = (existing?.lockCount ?? 0) + (crossed ? 1 : 0);

  const row = await unscoped(() =>
    prisma.loginThrottle.upsert({
      where: { identifierHash },
      create: {
        identifierHash,
        failures,
        windowStart: now,
        lockedUntil,
        lockCount,
        lastFailureAt: now,
      },
      update: {
        failures,
        // A fresh window also clears the expired lock that may have caused it,
        // so the row never carries a `lockedUntil` in the past beside a live
        // count — a reader comparing the two would have to know which one won.
        ...(fresh ? { windowStart: now, lockedUntil: null } : {}),
        ...(crossed ? { lockedUntil, lockCount } : {}),
        lastFailureAt: now,
      },
      select: { failures: true, lockedUntil: true, lockCount: true },
    }),
  );

  return row;
}

/**
 * A SUCCESSFUL login clears the counter.
 *
 * `failures: 0` and a fresh window, and `lockedUntil: null` — a correct
 * credential after a lock has expired must not leave the row one failure away
 * from locking again.
 */
export async function recordSuccess(identifierHash: string, nowMs: number): Promise<void> {
  const now = new Date(nowMs);
  await unscoped(() =>
    prisma.loginThrottle.upsert({
      where: { identifierHash },
      create: { identifierHash, failures: 0, windowStart: now, lastSuccessAt: now },
      update: { failures: 0, windowStart: now, lockedUntil: null, lastSuccessAt: now },
      select: { identifierHash: true },
    }),
  );
}

/**
 * THE UNLOCK PATH. Called from `POST /auth/password/reset`.
 *
 * ── WHY THIS IS THE RIGHT ESCAPE, AND WHY IT IS NOT A BYPASS ───────────────
 *
 * A hard lock is a denial-of-service weapon against a known address, so it
 * needs a door the REAL user can open and an attacker cannot. Completing a
 * password reset means holding a single-use token that was mailed to the
 * address — which is the one thing somebody locking a stranger out does not
 * have. It is not a bypass, because by the time this runs the password has
 * already been changed and every session revoked: there is nothing left for the
 * guesses to be aimed at.
 *
 * The lock count is NOT cleared. "Locked out forty times this month" is the
 * signal that separates a forgetful human from a password list, and a reset
 * must not erase it.
 */
export async function clearLoginLock(identifier: string, nowMs: number): Promise<void> {
  const now = new Date(nowMs);
  await unscoped(() =>
    prisma.loginThrottle.updateMany({
      where: { identifierHash: throttleKey('email', identifier) },
      data: { failures: 0, windowStart: now, lockedUntil: null },
    }),
  );
}

/**
 * APPEND ONE ATTEMPT TO THE EVIDENCE LOG.
 *
 * Separate from the counter on purpose: `LoginThrottle` is one row the gate
 * reads and writes on every attempt, and this is the append-only log an
 * operator reads afterwards. Merging them would put an unbounded log on the hot
 * path of every login.
 *
 * NEVER THE PASSWORD, NEVER THE CODE, NEVER A TOKEN — and that is enforced by
 * going through `recordLoginAttemptSchema`, which has four fields and no room
 * for one. Failures are SWALLOWED, for the same reason `audit()` swallows:
 * evidence that cannot be written must not turn a correct login into a 500.
 * Unlike `audit()` it is not logged either, because the only thing worth
 * logging here is the identifier, and this module does not put identifiers in
 * logs.
 */
export async function recordLoginAttempt(input: {
  readonly identifierHash: string;
  readonly outcome: LoginAttemptOutcome;
  readonly ip: string | null;
  readonly userAgent: string | null;
}): Promise<void> {
  const parsed = recordLoginAttemptSchema.safeParse({
    identifierHash: input.identifierHash,
    outcome: input.outcome,
    ip: input.ip,
    userAgent: input.userAgent === null ? null : input.userAgent.slice(0, 500),
  });
  if (!parsed.success) return;

  try {
    await unscoped(() =>
      prisma.loginAttempt.create({ data: parsed.data, select: { id: true } }),
    );
  } catch {
    /* Evidence is best-effort; a correct login must not fail because of it. */
  }
}

/**
 * HOW MANY ATTEMPTS THE OBSERVE MODE WOULD HAVE REFUSED.
 *
 * The counter a brake owes: `SECURITY_CONTROL_BRAKES.LOGIN_THROTTLE.observeCounts`
 * says "every attempt that would have been locked out, per identifier", and
 * this is the read that answers it. The rows are already there — a throttle in
 * OBSERVE mode writes the `LOCKED_OUT` attempt and then admits the caller — so
 * the count is a query and not a second mechanism that could disagree with the
 * first.
 */
export async function countWouldHaveRefused(sinceMs: number): Promise<number> {
  return unscoped(() =>
    prisma.loginAttempt.count({
      where: { outcome: 'LOCKED_OUT', createdAt: { gte: new Date(sinceMs) } },
    }),
  );
}
