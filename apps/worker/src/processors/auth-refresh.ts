/**
 * SESSION REFRESH — the sweep that keeps a cached customer session alive, and
 * refuses to let a dead one become an anonymous run.
 *
 * ─── THE DEFECT, REPRODUCED AT HEAD 37498c1 ─────────────────────────────────
 *
 * `AuthProfile.storageStateExpiresAt` is stamped eight hours ahead by
 * `packages/runner/src/login.ts` and WAS NEVER REFRESHED BY ANYTHING. There was
 * no module in the repository named for this job: the brief listed
 * `apps/worker/src/processors/auth-refresh.ts` as an existing file to extend
 * and no such file existed — `grep -rn auth-refresh` over apps/ and packages/
 * matched nothing at all. So this is the whole of it, not an extension.
 *
 * The consequence was not that runs failed. It was worse than that. Every
 * reader spelt the same three lines —
 *
 *     const fresh = profile.storageState &&
 *       (!profile.storageStateExpiresAt || profile.storageStateExpiresAt > new Date());
 *
 * — so an expired session became `null`, and in apps/worker/src/processors/run.ts
 * (around line 1426) `null` became `session = { ok: true, storageState }`. The
 * run then executed ANONYMOUSLY and reported a pass, which makes every
 * auth-gated route it touched look covered by a test that was never signed in.
 * That is a security defect and a defect in the product's core number at the
 * same time, and the second one is the harder to notice.
 *
 * ─── THE RULE THAT MATTERS MOST ─────────────────────────────────────────────
 *
 * WHEN A REFRESH FAILS, THE RUN DOES NOT GO ANONYMOUS. It reports the typed
 * NOT_RUN that {@link sessionGate} produces — `BLOCKED_BY_ENV`, which the
 * NOT_RUN_KINDS guidance says must be EXCLUDED from a pass rate and from a
 * coverage denominator — and the owner is told. Fail closed, in the direction
 * that costs a measurement rather than inventing one.
 *
 * ─── AND THE REFRESH IS ITSELF A CREDENTIAL-USING OUTBOUND CALL ─────────────
 *
 * This is the part that is easy to miss. A refresh drives a real browser to a
 * customer-named URL and TYPES VAULT PLAINTEXT into whatever answers — so it is
 * the same recorded defect as the crawler, on a path that runs unattended every
 * night. The target therefore goes through the egress guard
 * (`packages/shared/src/egress.ts`, context `LOGIN`) before any browser is
 * launched, and NOTHING about the page comes back: see
 * {@link AuthRefreshLogin}, which deliberately has no `message` field.
 *
 * ─── EVERYTHING IS INJECTED ─────────────────────────────────────────────────
 *
 * The clock, the cipher, the DNS resolver, the classifier and the browser login
 * all arrive as {@link AuthRefreshDeps}. There is NO NETWORK AND NO DNS in this
 * module's tests, and no key material: a control that can only be tested by
 * holding a real key and resolving a real name is a control nobody will trust.
 */

import { Queue } from 'bullmq';
import { controlEnforces, controlMode } from '@qaai/shared';
import type { ControlMode, NotRunKind, SecurityControl } from '@qaai/shared';
/*
 * THE EGRESS GUARD, BY A FOUR-DOT RELATIVE PATH.
 *
 * `packages/shared/src/index.ts` does not re-export `./egress` and
 * `packages/shared/package.json` has no `./egress` subpath, so there is no
 * barrel specifier to use — the same situation `session-store.ts` records for
 * `./sealed`, and the same workaround processors/retention.ts uses for
 * `@qaai/storage`'s `gc.ts`. The barrel edit that retires both is named in this
 * slice's `needsFromOtherFiles`.
 *
 * This is also why the import is from `egress.js` and NOT from
 * `private-address.js`: egress.ts imports the classifier TYPE-ONLY precisely so
 * that nothing drags `node:dns` along behind it.
 */
import {
  EGRESS_REFUSAL_SENTENCE,
  countEgress,
  decideEgress,
  resolveEgressPolicy,
} from '../../../../packages/shared/src/egress.js';
import type {
  EgressDecision,
  EgressIo,
  EgressOutcome,
  EgressRefusal,
  EgressTally,
} from '../../../../packages/shared/src/egress.js';
import { signInWithProfile } from '@qaai/runner';
import type { LoginFailure, LoginStep } from '@qaai/runner';
/*
 * The session store lives in the API's lib because that is where the vault
 * does. The worker imports the API's libs by relative path all over this
 * directory (`start-run.js`, `github-app.js`, `cluster.js`, `ownership.js`),
 * so this is the established shape and not a new one.
 */
import {
  SESSION_REFRESH_LEAD_MS,
  SESSION_ROW_SELECT,
  countSessionGate,
  localSessionCipher,
  masterKeyResolver,
  openSession,
  readVaultKeys,
  sealSession,
  sessionDegradation,
  sessionGate,
  useSessionState,
} from '../../../api/src/lib/session-store.js';
import type {
  SealedSessionRow,
  SessionCipher,
  SessionDegradationTally,
  SessionGate,
  SessionState,
} from '../../../api/src/lib/session-store.js';
/*
 * The generated where-input type, so the sweep's OR arms are checked against
 * the schema rather than inferred into a shape Prisma rejects. Imported from
 * the API's generated client by relative path, exactly as
 * processors/preflight.ts imports `DeploymentCapabilityStatus`.
 */
import type { AuthProfileWhereInput } from '../../../api/src/generated/prisma/models/AuthProfile.js';
import { Prisma } from '../../../api/src/generated/prisma/client.js';
import { config, connection, logger, prisma } from '../context.js';
import { secretsFor } from '../vault.js';

/**
 * Its own queue, like retention, flake and bisect.
 *
 * NOT in `QUEUE_NAMES` (packages/shared/src/constants.ts) only because this
 * slice does not own that file — the same reason and the same shape as
 * `RETENTION_QUEUE` in processors/retention.ts, which carries the identical
 * note. The literal is pinned by this module's test so the registration in
 * index.ts and this constant cannot drift apart silently.
 */
export const AUTH_REFRESH_QUEUE = 'qaai.auth-refresh';

export interface AuthRefreshJob {
  at: string;
  /** Confine the sweep to one org. Absent sweeps every org. */
  orgId?: string | null;
  /** Refresh exactly one profile — what the cockpit's "Sign in" button wants. */
  profileId?: string | null;
  /** Profiles per tick. Bounds how many logins one tick can drive at a customer. */
  maxProfiles?: number;
}

// ─── The bounds ──────────────────────────────────────────────────────────────

/**
 * HOW MANY CONSECUTIVE FAILURES BEFORE THIS PROFILE IS LEFT ALONE.
 *
 * ── Why a cap at all, and why five ─────────────────────────────────────────
 *
 * Because a failing refresh is an unattended process typing a password into a
 * customer's own login form, over and over, every night. Enough of those and we
 * are not refreshing a session, we are locking the customer out of their own
 * account with their own credentials — and a lockout WE caused on an account
 * whose password we hold is the worst available outcome of a feature whose
 * whole purpose is to keep that account usable.
 *
 * Five, because the backoff below spreads five attempts across roughly
 * seventeen hours. That is long enough for a genuine outage to end on its own
 * and short enough that a rotated password is noticed the same day; and five is
 * under every per-account lockout threshold this codebase's own
 * `LOGIN_THROTTLE` brake considers generous.
 *
 * REACHING THE CAP IS REPORTED, never silent — `ATTEMPTS_CAPPED` is an outcome
 * with an audit row, because a cap that bit without being counted is one of the
 * lies this product cannot ship. The counter resets to zero on the next
 * success, so the cap is a pause and not a tombstone.
 */
export const MAX_REFRESH_FAILURES = 5;

/**
 * How long to wait after the Nth consecutive failure.
 *
 * Fifteen minutes, an hour, four hours, twelve hours. Exponential-ish rather
 * than exact powers, because the useful shape is "retry soon in case it was a
 * blip, then stop bothering them": the first retry catches a restart, and by
 * the fourth the honest reading is that the credentials changed and a person
 * has to look.
 *
 * A documented constant and deliberately NOT an environment variable:
 * `scripts/check-wiring.ts` fails an undocumented one, and a backoff that
 * differs per deployment is a backoff nobody can answer "why did it retry then?"
 * from.
 */
export const REFRESH_BACKOFF_MS: readonly number[] = [
  15 * 60_000,
  60 * 60_000,
  4 * 3_600_000,
  12 * 3_600_000,
];

/** Profiles one tick will attempt, when the job does not say. */
export const DEFAULT_MAX_PROFILES_PER_TICK = 25;

/**
 * Which brake decides whether an unusable session is a NOT_RUN or an anonymous
 * run. A named constant, not the string at two call sites, because
 * `controlMode` takes it and `SECURITY_CONTROL_BRAKES` documents it — and a
 * typo would resolve to that control's fallback for a control nobody spelt.
 */
export const SESSION_SEAL_CONTROL: SecurityControl = 'SESSION_STATE_SEAL';

/**
 * THE LIMITATION OF THE EGRESS CHECK ON THIS PATH, STATED RATHER THAN HIDDEN.
 *
 * {@link decideEgress} returns a PINNED ADDRESS SET, and the pin is what turns
 * a check into a control: whoever opens the connection must connect to those
 * addresses and not re-resolve the name. On this path the connection is opened
 * by a PLAYWRIGHT BROWSER inside `packages/runner/src/login.ts`, which resolves
 * the host itself and which this slice does not own. So the classification is
 * real and the PIN IS NOT ENFORCED AT THE SOCKET yet.
 *
 * That is written into every report and every audit row for a login that was
 * attempted, because the alternative is a control that reads as complete and is
 * not — "a pass that means we did not check" is the exact lie rule 14 forbids.
 * The addresses are handed to {@link AuthRefreshDeps.signIn} so the seam exists
 * and the remedy is one edit in a file this slice does not own; it is named in
 * `needsFromOtherFiles`.
 */
export const REFRESH_PIN_LIMITATION =
  'The host was classified and the authorised addresses were pinned, but the browser that opens ' +
  'the connection resolves the name itself, so the pin is not enforced at the socket.';

// ─── The outcomes ────────────────────────────────────────────────────────────

/**
 * WHAT HAPPENED TO ONE PROFILE'S REFRESH. Closed, because the sweep's report
 * is grouped by it and because each one is a different thing for an operator to
 * do.
 */
export const AUTH_REFRESH_OUTCOMES = [
  /** A new session was captured, sealed and stored. */
  'REFRESHED',
  /** The stored session is fresh. Nothing to do, and no login was driven. */
  'NOT_DUE',
  /** Due, but inside the backoff window after a recent failure. */
  'BACKED_OFF',
  /** {@link MAX_REFRESH_FAILURES} consecutive failures. Stopped on purpose. */
  'ATTEMPTS_CAPPED',
  /** The environment's base URL is not a URL this can target at all. */
  'TARGET_UNUSABLE',
  /** The egress guard refused the target. No browser was launched. */
  'REFUSED_BY_EGRESS',
  /** The login was driven and the application did not complete it. */
  'LOGIN_FAILED',
  /** The login succeeded and produced no browser session to cache. */
  'NOT_REFRESHABLE',
  /** A session was captured and could not be sealed. It is NOT stored in the clear. */
  'SEAL_FAILED',
] as const;
export type AuthRefreshOutcome = (typeof AUTH_REFRESH_OUTCOMES)[number];

/** What one outcome means for the counter, the audit log and the next run. */
export interface AuthRefreshOutcomeRule {
  /** Was a browser login actually driven at the customer's application? */
  readonly attempted: boolean;
  /**
   * Does `storageStateRefreshFailures` increment?
   *
   * TRUE for the refusals that are about this target as well as for a failed
   * login, and that is deliberate: a base URL that the egress guard refuses is
   * refused every night, and a counter that never advanced would retry it for
   * ever. FALSE where no attempt was made for a reason that is not about the
   * target — the backoff and the cap — because counting a deferral as a failure
   * would make the cap arrive without five failures behind it.
   */
  readonly countsAsFailure: boolean;
  /** Does this write an audit row? False only for the two quiet, expected ones. */
  readonly audited: boolean;
  readonly what: string;
}

/**
 * The compiler-enforced presence record. A `Record<AuthRefreshOutcome, …>`
 * cannot be written without naming every member, so a tenth outcome is a type
 * error here rather than an outcome with no counter rule — and `undefined`
 * read as falsy would silently stop a counter advancing, which is the exact
 * shape of "retries for ever and never reports the cap".
 *
 * Both halves, because one without the other passes while the two disagree:
 * this is the compile-time half and `auth-refresh.test.ts` asserts the run-time
 * parity of {@link AUTH_REFRESH_OUTCOMES} against this object's keys.
 */
export const AUTH_REFRESH_OUTCOME_RULES = {
  REFRESHED: {
    attempted: true,
    countsAsFailure: false,
    audited: true,
    what: 'A new session was captured, sealed under the ACTIVE key and stored.',
  },
  NOT_DUE: {
    attempted: false,
    countsAsFailure: false,
    audited: false,
    what: 'The stored session is valid and outside the refresh lead.',
  },
  BACKED_OFF: {
    attempted: false,
    countsAsFailure: false,
    audited: false,
    what: 'A refresh failed recently and the backoff window has not elapsed.',
  },
  ATTEMPTS_CAPPED: {
    attempted: false,
    countsAsFailure: false,
    audited: true,
    what:
      'Consecutive failures reached the cap, so no further login will be driven until one ' +
      'succeeds. This is how a broken refresh stops being a lockout risk.',
  },
  TARGET_UNUSABLE: {
    attempted: false,
    countsAsFailure: true,
    audited: true,
    what: "The environment's base URL could not be parsed into a host to classify.",
  },
  REFUSED_BY_EGRESS: {
    attempted: false,
    countsAsFailure: true,
    audited: true,
    what: 'The egress guard refused the target, so no browser was launched and nothing was typed.',
  },
  LOGIN_FAILED: {
    attempted: true,
    countsAsFailure: true,
    audited: true,
    what: 'The login was driven and the application did not complete it.',
  },
  NOT_REFRESHABLE: {
    attempted: true,
    countsAsFailure: true,
    audited: true,
    what:
      'The login succeeded and produced no browser session — an SSO bypass token is a request ' +
      'header, not a session, so there is nothing to cache.',
  },
  SEAL_FAILED: {
    attempted: true,
    countsAsFailure: true,
    audited: true,
    what:
      'A session was captured and could not be sealed. It is DISCARDED rather than stored in the ' +
      'clear, which is the whole point of the sealed column.',
  },
} as const satisfies Record<AuthRefreshOutcome, AuthRefreshOutcomeRule>;

/** Audit actions this processor writes. Named so a reader can grep the audit log. */
export const AUTH_REFRESH_AUDIT_ACTIONS = {
  refreshed: 'auth_profile.session_refreshed',
  failed: 'auth_profile.session_refresh_failed',
  capped: 'auth_profile.session_refresh_capped',
} as const;

// ─── The injected surfaces ───────────────────────────────────────────────────

/**
 * WHAT COMES BACK FROM A LOGIN, AND WHAT DELIBERATELY DOES NOT.
 *
 * ── The missing field is the control ──────────────────────────────────────
 *
 * `LoginResult` carries a `message`, and `LoginFailureReport` carries a
 * `detail`, and BOTH are built from the page title on three paths in
 * `packages/runner/src/login.ts` (around lines 1035, 1070 and 1384:
 * `` `${what} failed` + (title ? ` (page title: "${title}")` : '') ``). When the
 * target is an internal host, that title is a fact about the inside of the
 * customer's network — or of ours — echoed back out of a login nobody watched.
 *
 * So this type has NO `message` AND NO `detail`. It carries `kind`, `step` and
 * `fault`, which are three closed vocabularies, and there is therefore no field
 * through which a page's contents can reach a report, an audit row, a log line
 * or the next run's NOT_RUN sentence. A structural refusal rather than a
 * remembered one; `auth-refresh.test.ts` asserts a login that returns a title
 * cannot get it into anything.
 */
export interface AuthRefreshLogin {
  readonly ok: boolean;
  /** The captured Playwright session, or null. Never logged, never reported. */
  readonly storageState: unknown | null;
  readonly expiresAt: Date | null;
  /** Non-null exactly when `ok` is false. Three closed vocabularies and nothing else. */
  readonly failure: {
    readonly kind: LoginFailure;
    readonly step: LoginStep;
    readonly fault: 'OURS' | 'THEIRS' | 'UNDETERMINED';
  } | null;
}

/** What a login is asked to do. */
export interface AuthRefreshSignIn {
  readonly profile: {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly config: unknown;
  };
  readonly environmentKind: string;
  readonly baseUrl: string;
  /**
   * THE ADDRESSES THE EGRESS DECISION AUTHORISED, and the only addresses this
   * login may connect to.
   *
   * Passed even though `login.ts` cannot yet honour it, because a seam that
   * does not exist is a seam nobody will wire: the remedy is one edit in a file
   * this slice does not own, and it is named in `needsFromOtherFiles`. See
   * {@link REFRESH_PIN_LIMITATION}.
   */
  readonly pinnedAddresses: readonly string[];
  /**
   * `Environment.egressPolicy`, raw, so the login guards against the
   * customer's own policy and not against the HOSTED default.
   *
   * It was already in `REFRESH_CANDIDATE_SELECT` and already reached
   * `decideEgress`; this field is what carries it the last step, into
   * `signInWithProfile`, which resolves it under the LOGIN context.
   */
  readonly egressPolicy: unknown;
  readonly secrets: Readonly<Record<string, string>>;
}

/** Every surface this processor cannot have in a unit test. */
export interface AuthRefreshDeps {
  readonly now: () => Date;
  readonly cipher: SessionCipher;
  /** The classifier and resolver. `decideEgress` takes them for exactly this reason. */
  readonly egress: EgressIo;
  readonly signIn: (input: AuthRefreshSignIn) => Promise<AuthRefreshLogin>;
  readonly secretsFor: (orgId: string, environmentId: string) => Promise<Record<string, string>>;
}

// ─── The backoff ─────────────────────────────────────────────────────────────

/**
 * MAY WE TRY AGAIN YET, AND WHEN IS THE NEXT TIME.
 *
 * Pure and injected-clock, so the whole retry schedule is testable without
 * waiting. Three answers because they are three different facts: `due` is
 * whether to attempt now, `nextAttemptAt` is what to tell an operator, and
 * `capped` is whether there will be a next attempt at all.
 *
 * A row with failures recorded and NO attempt timestamp is treated as DUE. That
 * combination can only come from an inconsistent write, and the alternative —
 * refusing — would park such a profile for ever with no path back. One attempt
 * stamps the timestamp and repairs the row, and the cap bounds it, so this
 * cannot become a loop.
 */
export function refreshBackoff(
  failures: number,
  lastAttemptAt: Date | null,
  now: Date,
): { readonly due: boolean; readonly nextAttemptAt: Date | null; readonly capped: boolean } {
  if (failures >= MAX_REFRESH_FAILURES) {
    return { due: false, nextAttemptAt: null, capped: true };
  }
  if (failures <= 0) return { due: true, nextAttemptAt: null, capped: false };
  if (lastAttemptAt === null) return { due: true, nextAttemptAt: null, capped: false };

  // noUncheckedIndexedAccess: the last step is the floor for any index past the
  // end, so adding a sixth failure cannot read `undefined` as "no wait at all".
  const step =
    REFRESH_BACKOFF_MS[failures - 1] ?? REFRESH_BACKOFF_MS[REFRESH_BACKOFF_MS.length - 1] ?? 0;
  const nextAttemptAt = new Date(lastAttemptAt.getTime() + step);
  return { due: nextAttemptAt.getTime() <= now.getTime(), nextAttemptAt, capped: false };
}

// ─── The report ──────────────────────────────────────────────────────────────

/**
 * WHAT ONE PROFILE'S REFRESH DID.
 *
 * Nothing in here is a secret and `auth-refresh.test.ts` asserts that for every
 * outcome: the profile id is a cuid, the host is what the customer typed, the
 * state and the outcome and the failure kind are members of closed lists, and
 * there is no field a cookie, a password, a page title or an envelope payload
 * could travel in.
 */
export interface AuthRefreshReport {
  readonly profileId: string;
  readonly outcome: AuthRefreshOutcome;
  /** What the stored session was before this ran. */
  readonly stateBefore: SessionState;
  /** Which consecutive attempt this was. 1 for the first after a success. */
  readonly attempt: number;
  /** When the next attempt is due, or null when capped or refreshed. */
  readonly nextAttemptAt: Date | null;
  /** True when the attempt cap stopped this. Reported, never silent. */
  readonly capped: boolean;
  /**
   * THE TYPED NOT_RUN A RUN MUST RECORD IF IT NEEDS THIS IDENTITY NOW.
   *
   * Non-null whenever this profile has no usable session and the seal control
   * is ENFORCING. This is the field that replaces the anonymous run, so it is
   * carried on the report rather than re-derived by each consumer.
   */
  readonly notRun: { readonly kind: NotRunKind; readonly why: string } | null;
  /** True when the brake is OBSERVE and a run may still go anonymous — and be counted. */
  readonly anonymousPermitted: boolean;
  readonly failureKind: LoginFailure | null;
  readonly failureFault: 'OURS' | 'THEIRS' | 'UNDETERMINED' | null;
  readonly egressOutcome: EgressOutcome | null;
  readonly egressRefusal: EgressRefusal | null;
  /** Non-null exactly when a login was attempted. See {@link REFRESH_PIN_LIMITATION}. */
  readonly pinLimitation: string | null;
  readonly mode: ControlMode;
  /**
   * TRUE WHEN THIS TICK WOULD HAVE SEALED AND IS NOT, BECAUSE THE BRAKE IS OFF.
   *
   * ── The brake that did not brake ──────────────────────────────────────────
   *
   * `sealSession` was called UNCONDITIONALLY and its write nulls
   * `storageState`, so OBSERVE destroyed the plaintext column exactly as
   * ENFORCE did — an operator who set OBSERVE believing today's behaviour
   * continued got the one irreversible half of the control anyway. A mode that
   * gates only the REPORT is an off switch with a reassuring name.
   *
   * It is a FLAG and not an inferred reading of `mode`, because the two can
   * differ: a profile that was NOT_DUE, backed off or capped had no session to
   * seal at all under either mode, and counting those as withheld seals would
   * inflate the worklist an operator reads before arming with profiles arming
   * would not touch. True on exactly the outcomes where a session was captured
   * and written in the clear instead of sealed.
   */
  readonly sealWithheld: boolean;
  /** For the operator, inside their own tenant. No secret, by construction and by test. */
  readonly detail: string;
}

/** The columns a refresh writes, as one object per outcome. */
interface RefreshWrite {
  readonly data: Record<string, unknown>;
}

// ─── One profile ─────────────────────────────────────────────────────────────

/** The profile row this processor decides on, sealed columns included. */
export interface RefreshCandidate extends SealedSessionRow {
  readonly orgId: string;
  readonly environmentId: string;
  readonly name: string;
  readonly kind: string;
  readonly config: unknown;
  readonly storageStateRefreshAttemptedAt: Date | null;
  readonly storageStateRefreshFailures: number;
  readonly environment: {
    readonly id: string;
    readonly kind: string;
    readonly baseUrl: string;
    readonly egressPolicy: unknown;
  };
}

/**
 * The Prisma `select` for {@link RefreshCandidate} — ONE definition, and the
 * compiler enforces that it names every field.
 *
 * `satisfies Record<keyof …, …>` over the whole row, for the reason
 * `SESSION_ROW_SELECT` records: a hand-copied projection inside a function is
 * the same hazard as a select-blind fake, and it is the one that actually
 * shipped this month. A field added to the type and not here is a compile
 * error rather than a field this query silently stops reading.
 */
export const REFRESH_CANDIDATE_SELECT = {
  ...SESSION_ROW_SELECT,
  orgId: true,
  environmentId: true,
  name: true,
  kind: true,
  config: true,
  storageStateRefreshAttemptedAt: true,
  storageStateRefreshFailures: true,
  environment: {
    select: { id: true, kind: true, baseUrl: true, egressPolicy: true },
  },
} as const satisfies Record<keyof RefreshCandidate, true | { select: Record<string, true> }>;

function report(
  base: Pick<
    AuthRefreshReport,
    'profileId' | 'stateBefore' | 'attempt' | 'mode' | 'notRun' | 'anonymousPermitted'
  >,
  outcome: AuthRefreshOutcome,
  detail: string,
  extra: Partial<AuthRefreshReport> = {},
): AuthRefreshReport {
  return {
    ...base,
    outcome,
    detail,
    nextAttemptAt: null,
    capped: false,
    failureKind: null,
    failureFault: null,
    egressOutcome: null,
    egressRefusal: null,
    pinLimitation: AUTH_REFRESH_OUTCOME_RULES[outcome].attempted ? REFRESH_PIN_LIMITATION : null,
    // FALSE unless the caller says otherwise: "we withheld a seal" is a claim
    // about a session that was captured, and defaulting it to the mode would
    // make every NOT_DUE profile in the install read as one.
    sealWithheld: false,
    ...extra,
  };
}

/**
 * REFRESH ONE PROFILE.
 *
 * ── The order of the checks is the control ────────────────────────────────
 *
 * Staleness, then the cap, then the backoff, then EGRESS, then the login. Every
 * step before the login is a step that can refuse WITHOUT launching a browser
 * and without typing a password anywhere, and that ordering is the difference
 * between a guard and a log line. In particular the egress decision is taken
 * before `signIn` is called at all, so a profile pointed at `169.254.169.254`
 * never reaches the code that would type vault plaintext into whatever answers.
 *
 * ── It writes nothing itself ──────────────────────────────────────────────
 *
 * It returns the report and the column write, and {@link processAuthRefreshTick}
 * performs it. That keeps every decision in this function pure enough to test
 * exhaustively against a fake, which is the only way the refusal paths get
 * covered at all.
 */
export async function refreshProfile(
  deps: AuthRefreshDeps,
  candidate: RefreshCandidate,
  options: { readonly mode: ControlMode; readonly keys: Awaited<ReturnType<typeof readVaultKeys>> },
): Promise<{
  readonly report: AuthRefreshReport;
  readonly write: RefreshWrite | null;
  /**
   * The egress decision, returned so the TICK can count it.
   *
   * Null when no target was classified at all (not due, backed off, capped, or
   * an unparseable base URL). It is returned rather than counted here because
   * a counter inside a pure decision function is a counter a test cannot read
   * — and `countEgress` counts EVERY decision, allowed ones included, because
   * "we would have refused 1,204" is only defensible beside how many there were.
   */
  readonly decision: EgressDecision | null;
}> {
  const now = deps.now();
  const gate = sessionGate(candidate, { now, mode: options.mode });
  /*
   * THE BRAKE, READ ONCE AND USED FOR THE WRITE AS WELL AS THE REPORT.
   *
   * `options.mode` used to reach `sessionGate` and nothing else, so the seal
   * and the write that nulls `storageState` happened in OBSERVE exactly as in
   * ENFORCE. Rule 13 is about precisely this: if a control has a mode, the
   * mode must gate THE WRITE AND THE REFUSAL, not only what gets reported.
   */
  const enforcing = controlEnforces(options.mode);
  const attempt = candidate.storageStateRefreshFailures + 1;
  const base = {
    profileId: candidate.id,
    stateBefore: gate.state,
    attempt,
    mode: options.mode,
    notRun: gate.notRun,
    anonymousPermitted: gate.anonymousPermitted,
  } as const;

  /*
   * IN OBSERVE THE PLAINTEXT COLUMN IS THE LIVE SESSION, SO ITS OWN EXPIRY
   * DECIDES WHETHER A REFRESH IS DUE.
   *
   * `SESSION_STATE_RULES.LEGACY_PLAINTEXT.refreshDue` is true because under
   * ENFORCE that row holds a session nothing may carry and the refresh is what
   * CLEARS it. Under OBSERVE nothing clears it — by design, that is the whole
   * brake — and both consumers carry it, so without this arm every plaintext
   * profile in the install would be due on every tick, for ever: an hourly
   * unattended sign-in per profile at the customer's own login form, which is
   * the lockout hazard `MAX_REFRESH_FAILURES` exists to bound and which a
   * SUCCESSFUL login never trips. So in OBSERVE the question becomes the
   * honest one — is the session we are actually using close to expiry.
   */
  const legacyStillLive =
    !enforcing &&
    gate.state === 'LEGACY_PLAINTEXT' &&
    candidate.storageStateExpiresAt !== null &&
    candidate.storageStateExpiresAt.getTime() - now.getTime() > SESSION_REFRESH_LEAD_MS;

  if (!gate.refreshDue || legacyStillLive) {
    return {
      report: report(
        base,
        'NOT_DUE',
        legacyStillLive
          ? 'The plaintext session on this profile is still valid and the seal brake is OBSERVE, ' +
              'so it is the session in use and nothing is due. Arm SESSION_STATE_SEAL to have it ' +
              'replaced by a sealed one.'
          : gate.detail,
      ),
      write: null,
      decision: null,
    };
  }

  const backoff = refreshBackoff(
    candidate.storageStateRefreshFailures,
    candidate.storageStateRefreshAttemptedAt,
    now,
  );
  if (backoff.capped) {
    /*
     * THE CAP, REPORTED. No login is driven — which is the point: the next
     * attempt would be the sixth consecutive unattended password submission at
     * a customer's own account, and that is how a refresh becomes a lockout.
     */
    return {
      report: report(
        base,
        'ATTEMPTS_CAPPED',
        `${candidate.storageStateRefreshFailures} consecutive refreshes have failed, which is the ` +
          `cap of ${MAX_REFRESH_FAILURES}. No further sign-in will be attempted for this profile ` +
          'until one succeeds, so that a failing refresh cannot lock the account out. Check the ' +
          'credentials on this profile and sign in from the cockpit to clear it.',
        { capped: true },
      ),
      write: null,
      decision: null,
    };
  }
  if (!backoff.due) {
    return {
      report: report(base, 'BACKED_OFF', 'Inside the backoff window after a recent failure.', {
        nextAttemptAt: backoff.nextAttemptAt,
      }),
      write: null,
      decision: null,
    };
  }

  // ── The target ───────────────────────────────────────────────────────────
  let host: string;
  try {
    host = new URL(candidate.environment.baseUrl).hostname;
    if (host.length === 0) throw new Error('no host');
  } catch {
    /*
     * The parse error is NOT attached. A URL parse failure quotes the URL, the
     * URL can carry a credential in its userinfo or its path, and this detail
     * reaches a log line and an audit row.
     */
    return {
      report: report(
        base,
        'TARGET_UNUSABLE',
        "This environment's base URL is not a URL with a host, so there is nothing to classify " +
          'and no sign-in was attempted.',
      ),
      write: failureWrite(now),
      decision: null,
    };
  }

  const policy = resolveEgressPolicy(candidate.environment.egressPolicy);
  const decision = await decideEgress({ context: 'LOGIN', host, policy, io: deps.egress });
  if (!decision.allowed) {
    return {
      report: report(base, 'REFUSED_BY_EGRESS', decision.detail, {
        egressOutcome: decision.outcome,
        egressRefusal: decision.refusal,
      }),
      write: failureWrite(now),
      decision,
    };
  }

  // ── The login ────────────────────────────────────────────────────────────
  const secrets = await deps.secretsFor(candidate.orgId, candidate.environmentId);
  const login = await deps.signIn({
    profile: {
      id: candidate.id,
      name: candidate.name,
      kind: candidate.kind,
      config: candidate.config,
    },
    environmentKind: candidate.environment.kind,
    baseUrl: candidate.environment.baseUrl,
    pinnedAddresses: (decision.pinned?.addresses ?? []).map((pinned) => pinned.address),
    egressPolicy: candidate.environment.egressPolicy,
    secrets,
  });

  const egressFacts = {
    egressOutcome: decision.outcome,
    egressRefusal: decision.refusal,
  } as const;

  if (!login.ok) {
    /*
     * The login's own verdict, carried through as three closed vocabularies and
     * NOT as its sentence. `LoginFailureReport.detail` and `LoginResult.message`
     * are built from the page title on three paths in login.ts, and a page
     * title from an internal host is an information leak out of a login nobody
     * watched. The kind and the fault are what an operator acts on anyway.
     */
    return {
      report: report(
        base,
        'LOGIN_FAILED',
        `The sign-in was attempted and did not complete: ${login.failure?.kind ?? 'unreported'} ` +
          `at the ${login.failure?.step ?? 'unreported'} step. Nothing about the page is ` +
          'recorded, deliberately.',
        {
          ...egressFacts,
          failureKind: login.failure?.kind ?? null,
          failureFault: login.failure?.fault ?? null,
          ...nextAfterFailure(attempt, now),
        },
      ),
      write: failureWrite(now),
      decision,
    };
  }

  if (login.storageState === null || login.storageState === undefined) {
    return {
      report: report(base, 'NOT_REFRESHABLE', AUTH_REFRESH_OUTCOME_RULES.NOT_REFRESHABLE.what, {
        ...egressFacts,
        ...nextAfterFailure(attempt, now),
      }),
      write: failureWrite(now),
      decision,
    };
  }

  /*
   * The login's own expiry, and the REFRESH LEAD as a floor when it reports
   * none — deliberately not eight hours. Hoisted out of the seal call because
   * the OBSERVE write below stamps the same expiry: two expressions for one
   * timestamp is how the two modes come to disagree about when a session dies.
   */
  const expiresAt = login.expiresAt ?? new Date(now.getTime() + SESSION_REFRESH_LEAD_MS);

  if (!enforcing) {
    /*
     * ── OBSERVE: TODAY'S BEHAVIOUR, AND A COUNT ─────────────────────────────
     *
     * The captured session is written into `storageState` in the clear, which
     * is what `packages/runner/src/login.ts`'s consumers and
     * apps/api/src/routes/projects.ts do today, and the plaintext column is
     * LEFT EXACTLY AS THE BRAKE PROMISES. Nothing is sealed and nothing is
     * nulled: a sealed value written by a mode nobody armed is still the write
     * the operator declined, and it would put the row in the one state the
     * gate refuses while claiming the brake was off.
     *
     * `sealWithheld` is the count. It is a measured fact about what happened —
     * a session was captured and stored in the clear — and deliberately NOT a
     * claim that the seal would have succeeded, which is a thing nobody
     * attempted and which {@link AUTH_REFRESH_OUTCOMES} already has
     * `SEAL_FAILED` for.
     *
     * `storageStateNeedsReseal` is cleared, because it means "there is no
     * usable session here" and there now is one. Leaving it true would also
     * keep this profile on the sweep's worklist for ever.
     */
    return {
      decision,
      report: report(
        base,
        'REFRESHED',
        'A new session was captured and written to the legacy plaintext column: the ' +
          'SESSION_STATE_SEAL brake is OBSERVE, so nothing was sealed and the plaintext column ' +
          'was left exactly as it was. Counted as one profile a seal would have replaced.',
        { ...egressFacts, notRun: null, anonymousPermitted: false, sealWithheld: true },
      ),
      write: {
        data: {
          storageState: login.storageState,
          storageStateExpiresAt: expiresAt,
          storageStateNeedsReseal: false,
          storageStateRefreshedAt: now,
          storageStateRefreshAttemptedAt: now,
          /* Reset, not incremented: the cap is a pause and not a tombstone. */
          storageStateRefreshFailures: 0,
        },
      },
    };
  }

  const sealed = await sealSession({
    profileId: candidate.id,
    storageState: login.storageState,
    /*
     * See `expiresAt` above.
     *
     * `succeeded()` in login.ts always stamps an expiry, so the fallback is for
     * a path that does not exist today and must not become a claim if one
     * appears. One refresh lead is the shortest useful answer: it never
     * over-claims validity the way copying the eight-hour TTL would, and the
     * row it produces is `SEALED_EXPIRING` on the very next gate read — usable
     * now, refreshed again next tick. The alternative, refusing outright, would
     * discard a session that was successfully captured and leave the profile on
     * its expired one, which is worse for the customer and no safer for us.
     */
    expiresAt,
    keys: options.keys.keys,
    cipher: deps.cipher,
    now,
  });

  if (!sealed.ok) {
    return {
      report: report(
        base,
        'SEAL_FAILED',
        `A session was captured and could not be sealed (${sealed.refusal}): ${sealed.detail} It ` +
          'was DISCARDED rather than stored in the clear.',
        { ...egressFacts, ...nextAfterFailure(attempt, now) },
      ),
      write: failureWrite(now),
      decision,
    };
  }

  return {
    decision,
    report: report(
      base,
      'REFRESHED',
      `A new session was sealed under vault key version ${sealed.value.storageStateKeyVersion}.`,
      {
        ...egressFacts,
        /*
         * The gate's answer is about the state BEFORE this ran, and this
         * profile now HAS a session — so carrying the old NOT_RUN forward would
         * tell a run not to proceed on the strength of a problem that has just
         * been fixed. Two facts, and this is the later one.
         */
        notRun: null,
        anonymousPermitted: false,
      },
    ),
    write: {
      data: {
        ...sealed.value,
        /*
         * `Prisma.DbNull` AND NOT THE BARE `null` `SealedSessionWrite` CARRIES.
         *
         * `storageState` is `Json?`, and Prisma's update input for a nullable
         * Json column is `NullableJsonNullValueInput | InputJsonValue` — a bare
         * `null` is not a member, which is why assigning `SealedSessionWrite`
         * to `AuthProfileUpdateInput` is a type error (reproduced; see
         * `openProblems`). This write only compiled at all because
         * `RefreshWrite.data` is `Record<string, unknown>`, so the type system
         * was not checking it. `DbNull` is SQL NULL, which is exactly what the
         * sealing migration's own `SET "storageState" = NULL` produced, and it
         * removes the question of which null a bare `null` becomes.
         */
        storageState: Prisma.DbNull,
        storageStateRefreshedAt: now,
        storageStateRefreshAttemptedAt: now,
        /* Reset, not incremented: the cap is a pause and not a tombstone. */
        storageStateRefreshFailures: 0,
      },
    },
  };
}

/**
 * When the next attempt is due after THIS failure, and whether this failure was
 * the one that reached the cap.
 *
 * Both, because `nextAttemptAt: null` otherwise carries two different facts —
 * "there is no next attempt because we are capped" and "we could not say" — and
 * a field that means two things is a defect even when both readings are
 * defensible. An operator reading the audit row for the fifth failure needs to
 * know that it was the last one.
 */
function nextAfterFailure(
  attempt: number,
  now: Date,
): { readonly nextAttemptAt: Date | null; readonly capped: boolean } {
  const backoff = refreshBackoff(attempt, now, now);
  return { nextAttemptAt: backoff.nextAttemptAt, capped: backoff.capped };
}

/**
 * The write for every unsuccessful outcome that MADE or TRIED a target.
 *
 * `{ increment: 1 }` rather than a computed value, so two ticks that overlap
 * cannot both write "failures = 3" and lose one. The timestamp moves on every
 * attempt, which is what makes (attempted recently, refreshed long ago) — the
 * state that means sign-in is broken — a thing the two columns can express.
 *
 * NOTHING ABOUT THE SESSION IS WRITTEN HERE. A failed refresh does not touch
 * `storageStateSealed`: the old sealed value stays exactly as it was, because
 * destroying a session we merely failed to replace would turn a transient
 * outage into a profile with nothing at all.
 */
function failureWrite(now: Date): RefreshWrite {
  return {
    data: {
      storageStateRefreshAttemptedAt: now,
      storageStateRefreshFailures: { increment: 1 },
    },
  };
}

// ─── The sweep ───────────────────────────────────────────────────────────────

/** What one tick did, for the operator and for the brake's count. */
export interface AuthRefreshTickResult {
  readonly visited: number;
  readonly reports: readonly AuthRefreshReport[];
  /** Per outcome, so "17 refreshed, 2 capped" is one read. */
  readonly byOutcome: Readonly<Record<AuthRefreshOutcome, number>>;
  /** The seal control's OBSERVE count, per profile and per state. */
  readonly degradation: ReturnType<typeof sessionDegradation>;
  /** The egress control's own count, by context, outcome and class. */
  readonly egress: readonly EgressTally[];
  /** Key versions whose state this deployment could not read. Never silent. */
  readonly unreadableKeyVersions: readonly number[];
  /** True when the tick stopped at `maxProfiles` and more were due. */
  readonly cappedByBudget: boolean;
}

function emptyByOutcome(): Record<AuthRefreshOutcome, number> {
  /*
   * Built from the list rather than written out, so a tenth outcome counts from
   * zero instead of being `undefined` — and a report of an outcome with no
   * counter would otherwise print `NaN` after one increment.
   */
  const out = {} as Record<AuthRefreshOutcome, number>;
  for (const outcome of AUTH_REFRESH_OUTCOMES) out[outcome] = 0;
  return out;
}

/**
 * ONE TICK OF THE SWEEP.
 *
 * ── Which profiles it touches, and the one it deliberately does not ───────
 *
 * Profiles whose stored session is EXPIRING, EXPIRED, UNVERSIONED or marked for
 * re-seal. NOT profiles that have never had a session at all: those are not
 * stale, they are new, and the path that signs them in on their first run
 * already exists and already works. Including them would mean driving a login
 * at every profile in the install on the first tick after deploy, which is the
 * sweep hammering a customer's auth system to fix something that was not broken.
 * `storageStateNeedsReseal` is how the rows the sealing migration emptied are
 * found instead — that flag is exactly the difference between "never signed in"
 * and "we destroyed the plaintext that was here".
 *
 * Disposable principals are excluded too: a DISPOSABLE identity belongs to the
 * scenario that created it and signing one back in after it was destroyed would
 * resurrect a principal the suite believes is gone.
 */
export async function processAuthRefreshTick(
  job: AuthRefreshJob,
  injected?: Partial<AuthRefreshDeps>,
): Promise<AuthRefreshTickResult> {
  const deps = await productionDeps(injected);
  const now = deps.now();
  const take = Math.max(1, job.maxProfiles ?? DEFAULT_MAX_PROFILES_PER_TICK);
  /*
   * THE READ THAT CONNECTS `model VaultKey` TO SOMETHING.
   *
   * `check-wiring` reported that table as DISCONNECTED — "a schema entry for a
   * feature that does not exist" — when this slice started, and a key table
   * nothing reads is a table whose ACTIVE/READABLE/COMPROMISED states are a
   * claim rather than a control.
   */
  const keys = await readVaultKeys(prisma);

  if (keys.unreadableVersions.length > 0) {
    logger.warn(
      { versions: keys.unreadableVersions },
      'vault key rows whose state could not be read; they will neither seal nor open',
    );
  }

  const where: AuthProfileWhereInput = {
    ...(job.profileId ? { id: job.profileId } : {}),
    ...(job.orgId ? { orgId: job.orgId } : {}),
    principalKind: 'PERSISTENT',
    ...(job.profileId
      ? {}
      : {
          OR: [
            { storageStateNeedsReseal: true },
            { AND: [{ storageStateSealed: { not: null } }, { storageStateKeyVersion: null }] },
            {
              AND: [{ storageStateSealed: { not: null } }, { storageStateExpiresAt: null }],
            },
            {
              AND: [
                { storageStateSealed: { not: null } },
                {
                  storageStateExpiresAt: {
                    lte: new Date(now.getTime() + SESSION_REFRESH_LEAD_MS),
                  },
                },
              ],
            },
            /*
             * A profile an un-migrated writer wrote plaintext into. Refreshing
             * it is what CLEARS that column — see SealedSessionWrite.
             *
             * `Prisma.DbNull` and not `null`, for the reason
             * apps/api/src/lib/coverage-store.ts records at its own use: the
             * column is `Json?`, so SQL NULL (nothing was ever written) and
             * JSON `null` (the literal null was written) are different stored
             * values, and filtering on `null` is a type error precisely
             * because Prisma refuses to guess which was meant. Here the
             * distinction is load-bearing: a row holding the JSON literal
             * `null` has no session either, and treating it as one would drive
             * a login for a profile that needs none.
             */
            { storageState: { not: Prisma.DbNull } },
          ],
        }),
  };

  const candidates = (await prisma.authProfile.findMany({
    where,
    select: REFRESH_CANDIDATE_SELECT,
    // Nulls FIRST, explicitly: Postgres sorts them last on ASC, which would put
    // a profile that has never been attempted behind every one that has.
    orderBy: [{ storageStateRefreshAttemptedAt: { sort: 'asc', nulls: 'first' } }],
    // One more than the budget, so "there were more" is a measured fact rather
    // than an inference from a full page.
    take: take + 1,
  })) as unknown as RefreshCandidate[];

  const cappedByBudget = candidates.length > take;
  const batch = cappedByBudget ? candidates.slice(0, take) : candidates;

  const reports: AuthRefreshReport[] = [];
  const byOutcome = emptyByOutcome();
  const degradation = new Map<string, SessionDegradationTally>();
  const egress = new Map<string, EgressTally>();
  const modes = new Map<string, ControlMode>();

  for (const candidate of batch) {
    let mode = modes.get(candidate.orgId);
    if (mode === undefined) {
      const org = await prisma.organization.findUnique({
        where: { id: candidate.orgId },
        select: { securityControlModes: true },
      });
      mode = controlMode(SESSION_SEAL_CONTROL, org?.securityControlModes ?? null);
      modes.set(candidate.orgId, mode);
    }

    const outcome = await refreshProfile(deps, candidate, { mode, keys });
    reports.push(outcome.report);
    byOutcome[outcome.report.outcome] += 1;
    /*
     * EVERY decision, not only the refused ones — see the field's comment on
     * `refreshProfile`. A tick that classified nothing reports an EMPTY tally
     * list, which is the honest answer: no connection was considered, so there
     * is no refusal rate to quote.
     */
    if (outcome.decision) countEgress(egress, outcome.decision);
    /*
     * THE BRAKE'S COUNT, OVER WHAT THIS TICK DID NOT FIX.
     *
     * Taken on the state BEFORE the refresh, and only when the refresh did NOT
     * produce a session — which is the honest reading of
     * `SECURITY_CONTROL_BRAKES.SESSION_STATE_SEAL.observeCounts`, "every run
     * that would have been reported NOT_RUN and instead went anonymous, per
     * profile".
     *
     * Counting a profile this tick REPAIRED would inflate the number with
     * sessions that are now perfectly usable — and that number is the one an
     * operator reads before they dare enforce. A refusal that was applied has
     * to be counted; a refusal that did not happen must not be.
     *
     * `sealWithheld` IS THE SECOND HALF, and it is why the condition is not
     * simply "not refreshed". A profile refreshed under OBSERVE has a session
     * again and is NOT repaired as far as this control is concerned: it is
     * still plaintext, and it is exactly one of the profiles arming the brake
     * would seal. So it goes in the tally under its BEFORE state, where
     * `wouldSeal` becomes the worklist `SECURITY_CONTROL_BRAKES
     * .SESSION_STATE_SEAL.observeCounts` promises, over the denominator
     * `sessionDegradation` already reports as `total`.
     *
     * `WOULD_SEAL` UNDER OBSERVE AND NOT `degraded`, which is what this counted
     * before in both modes. The sweep and a run measure different things
     * through this one counter: a run reports what it DID with a session, and
     * the sweep reports which profiles this control is currently affecting.
     * They shared the `degraded` bucket, so that one field meant "runs that
     * went anonymous" in run.ts and explore.ts and "profiles a seal would
     * replace" here — two facts in one number, read by the same operator
     * deciding whether to enforce.
     *
     * THE MODE PICKS THE MEMBER, because the fact is different in each:
     * under OBSERVE the brake DECLINED to act and arming it would change this
     * profile (`WOULD_SEAL`, the worklist); under ENFORCE it is already acting
     * and this profile's runs ARE being refused (`REFUSED`). One member for
     * both would make the worklist an operator reads before arming include
     * the profiles arming it has already caught.
     */
    if (outcome.report.outcome !== 'REFRESHED' || outcome.report.sealWithheld) {
      countSessionGate(
        degradation,
        candidate.id,
        sessionGate(candidate, { now, mode }),
        controlEnforces(mode) ? 'REFUSED' : 'WOULD_SEAL',
      );
    }

    if (outcome.write) {
      await prisma.authProfile
        .update({ where: { id: candidate.id }, data: outcome.write.data })
        .catch((err: unknown) =>
          // A write failure costs one refresh, never the sweep. The error is
          // logged without the data, which carries the sealed envelope.
          logger.warn({ err, profileId: candidate.id }, 'could not record the refresh attempt'),
        );
    }

    if (AUTH_REFRESH_OUTCOME_RULES[outcome.report.outcome].audited) {
      await writeAuditRow(candidate, outcome.report).catch((err: unknown) =>
        logger.error({ err, profileId: candidate.id }, 'refresh audit write failed'),
      );
    }
  }

  logger.info(
    { visited: batch.length, byOutcome, cappedByBudget },
    'auth profile session refresh tick',
  );

  return {
    visited: batch.length,
    reports,
    byOutcome,
    degradation: sessionDegradation(degradation.values()),
    egress: [...egress.values()],
    unreadableKeyVersions: keys.unreadableVersions,
    cappedByBudget,
  };
}

/**
 * THE OWNER'S ALERT, as an audit row.
 *
 * ── Why the audit log and not a chat page ─────────────────────────────────
 *
 * Because the audit log is a surface that exists and is read (Settings → Audit
 * log, and `auditRowsToCsv` for export), and `processNotify` in
 * apps/worker/src/processors/notify.ts returns silently for every event except
 * `monitor.down` and `run.finished` — so enqueuing a new event name would be an
 * alert that goes nowhere while reading, in this file, as though somebody had
 * been told. The one-arm edit that adds the chat page is in
 * `needsFromOtherFiles`; until it lands, the honest claim is the row.
 *
 * ── What goes in the metadata, and what does not ──────────────────────────
 *
 * The outcome, the state, the failure KIND and FAULT, the attempt number and
 * the cap. Not the session, not the envelope, not the page, not the login's
 * sentence, and not the resolved ADDRESS: the address is the one fact that adds
 * reachability information beyond the host the operator typed themselves, and a
 * refusal that names it is an inventory of what answers inside their network.
 * The address CLASS is kept, because that is what an allowlist entry needs.
 */
async function writeAuditRow(candidate: RefreshCandidate, entry: AuthRefreshReport): Promise<void> {
  const action = entry.capped
    ? AUTH_REFRESH_AUDIT_ACTIONS.capped
    : entry.outcome === 'REFRESHED'
      ? AUTH_REFRESH_AUDIT_ACTIONS.refreshed
      : AUTH_REFRESH_AUDIT_ACTIONS.failed;

  await prisma.auditLog.create({
    data: {
      orgId: candidate.orgId,
      // No user: a sweep is not a person, and attributing it to one would make
      // the audit log say somebody signed in when nobody did.
      userId: null,
      action,
      targetType: 'AuthProfile',
      targetId: candidate.id,
      /*
       * Cast at the serialisation boundary and nowhere else. Prisma's
       * `InputJsonObject` demands an index signature, and giving
       * {@link AuthRefreshAuditMetadata} one would defeat its purpose — the
       * whole value of that type is that it is a CLOSED list of what may be
       * written down about a secret, which an index signature re-opens.
       */
      metadata: auditMetadata(entry) as unknown as Prisma.InputJsonObject,
    },
  });
}

/**
 * EXACTLY WHAT REACHES THE AUDIT ROW. A named type and not
 * `Record<string, unknown>`, for two reasons: the loose type is not assignable
 * to Prisma's JSON input, and — the reason that matters — a field added to this
 * object is a visible change to a type whose whole job is to list what may be
 * written down about a secret.
 */
export interface AuthRefreshAuditMetadata {
  readonly outcome: AuthRefreshOutcome;
  readonly stateBefore: SessionState;
  readonly attempt: number;
  readonly capped: boolean;
  readonly nextAttemptAt: string | null;
  readonly failureKind: LoginFailure | null;
  readonly failureFault: 'OURS' | 'THEIRS' | 'UNDETERMINED' | null;
  readonly egressOutcome: EgressOutcome | null;
  readonly egressRefusal: EgressRefusal | null;
  readonly mode: ControlMode;
  readonly notRunKind: NotRunKind | null;
  readonly pinLimitation: string | null;
  readonly refusalSentence: string | null;
  /**
   * TRUE WHEN THE BRAKE LEFT A CAPTURED SESSION IN THE CLEAR.
   *
   * In the audit row rather than only in the tick's return value, because the
   * tick's numbers live for one process and this is the per-profile evidence
   * an operator needs months later to answer "when did this profile stop
   * being plaintext". A boolean about WHERE a session was written; it cannot
   * carry any part of the session itself.
   */
  readonly sealWithheld: boolean;
}

/** The metadata object, exported so its contents are a tested fact. */
export function auditMetadata(entry: AuthRefreshReport): AuthRefreshAuditMetadata {
  return {
    outcome: entry.outcome,
    stateBefore: entry.stateBefore,
    attempt: entry.attempt,
    capped: entry.capped,
    nextAttemptAt: entry.nextAttemptAt?.toISOString() ?? null,
    failureKind: entry.failureKind,
    failureFault: entry.failureFault,
    egressOutcome: entry.egressOutcome,
    egressRefusal: entry.egressRefusal,
    mode: entry.mode,
    notRunKind: entry.notRun?.kind ?? null,
    pinLimitation: entry.pinLimitation,
    sealWithheld: entry.sealWithheld,
    /*
     * The uniform sentence, for anything a non-operator might end up reading.
     * One constant for every egress refusal, from egress.ts — a refusal that
     * varied by cause would tell whoever typed the URL which internal hosts
     * exist.
     */
    refusalSentence: entry.egressRefusal === null ? null : EGRESS_REFUSAL_SENTENCE,
  };
}

// ─── Production wiring ───────────────────────────────────────────────────────

/**
 * The real surfaces, built lazily and overridable one at a time.
 *
 * `Partial<AuthRefreshDeps>` rather than all-or-nothing, so a test can take the
 * real cipher and a fake resolver — which is the combination that proves an
 * envelope the database will actually hold while never touching DNS.
 */
async function productionDeps(injected?: Partial<AuthRefreshDeps>): Promise<AuthRefreshDeps> {
  return {
    now: injected?.now ?? (() => new Date()),
    cipher: injected?.cipher ?? localSessionCipher(masterKeyResolver(config.vaultMasterKey)),
    /*
     * The real classifier is loaded ONLY when nothing was injected, so a unit
     * test that supplies its own `EgressIo` never reaches the dynamic import
     * and therefore cannot touch DNS even by accident. There is deliberately
     * no fallback stub: a stub here would be an `EgressIo` that answers
     * something, and anything it answered would be a classification nobody
     * performed.
     */
    egress: injected?.egress ?? (await loadEgressIo()),
    signIn: injected?.signIn ?? browserSignIn,
    secretsFor: injected?.secretsFor ?? secretsFor,
  };
}

/**
 * The classifier and resolver, from the module that already has them.
 *
 * Imported DYNAMICALLY and on a SUBPATH, for the reason api-surface.ts,
 * lib/issues.ts and lib/sso.ts all record above their own imports:
 * `private-address.ts` reaches for `node:dns`, and a Node builtin pulled into
 * the wrong graph breaks the web build. Dynamic as well as subpathed so that
 * importing this processor does not pull a resolver in at all.
 *
 * `lookup` goes through `resolvesPublicly`, which already refuses an ambiguous
 * literal and already answers with EVERY address a name has rather than the
 * first — and `decideEgress` then classifies all of them and pins them. The
 * classification is deliberately NOT taken from `resolvesPublicly`'s own
 * verdict: that one answers a different question (is it public?) and the policy
 * here is per-deployment and per-context.
 */
export async function loadEgressIo(): Promise<EgressIo> {
  const mod = await import('@qaai/shared/private-address');
  return {
    classifyHost: mod.classifyHost,
    classifyAddress: mod.classifyAddress,
    lookup: async (host) => {
      const verdict = await mod.resolvesPublicly(host);
      return verdict.addresses.map((address) => ({ address }));
    },
    now: () => new Date(),
  };
}

/** The real login. Drives a browser; never called from a unit test. */
async function browserSignIn(input: AuthRefreshSignIn): Promise<AuthRefreshLogin> {
  const result = await signInWithProfile(
    {
      id: input.profile.id,
      name: input.profile.name,
      kind: input.profile.kind as never,
      config: input.profile.config,
    },
    input.secrets,
    {
      environmentKind: input.environmentKind as never,
      baseUrl: input.baseUrl,
      /*
       * THE POLICY, NOW HONOURED. `egressPolicy` was already in
       * `REFRESH_CANDIDATE_SELECT` and reached `decideEgress` here, but it
       * stopped at this call — so the login this processor drives built its
       * guard from the HOSTED default rather than from the environment's own
       * policy. A column selected whose value never reaches the one function
       * that needed it is half the defect it was minted to fix.
       *
       * `signInWithProfile` resolves it under the LOGIN context, which is the
       * right one and deliberately not the context used for the decision above:
       * the login types vault plaintext into whatever answers, so it refuses an
       * https→http downgrade that a plain reachability decision would permit.
       *
       * {@link REFRESH_PIN_LIMITATION} still stands for the ADDRESSES — see
       * `input.pinnedAddresses`. The policy half is wired; the pin half needs
       * the login browser's launch argument and is recorded, not claimed.
       */
      egressPolicy: input.egressPolicy,
    },
  );
  /*
   * THE NARROWING IS THE CONTROL. `result.message` and
   * `result.failure.detail` are dropped here and nowhere else, which is why
   * there is no path from a page title into a report, an audit row or a log
   * line. Do not widen this object.
   */
  return {
    ok: result.ok,
    storageState: result.storageState,
    expiresAt: result.expiresAt,
    failure: result.failure
      ? { kind: result.failure.kind, step: result.failure.step, fault: result.failure.fault }
      : null,
  };
}

let refreshQueue: Queue | null = null;

/**
 * Built lazily, so importing this module for a unit test does not open a Redis
 * connection. (`queues.ts` builds its producers at import time; that file is
 * not ours to change and a refresh test must not need a live Redis.)
 */
function queue(): Queue {
  refreshQueue ??= new Queue(AUTH_REFRESH_QUEUE, { connection });
  return refreshQueue;
}

/**
 * Arm the sweep. Repeatable job, de-duplicated by key, so calling it on every
 * boot is safe and the sweep exists for as long as a worker does.
 *
 * HOURLY, not daily: the TTL this exists to beat is eight hours, and a daily
 * sweep would leave a sixteen-hour window in which a session expires and the
 * next run finds it dead — which is the defect, rediscovered on a schedule.
 *
 * BOTH `removeOnComplete` AND `removeOnFail`. A BullMQ job id is a Redis key,
 * and a per-entity id with only one of the two set means the second attempt is
 * silently dropped once the first has failed and stayed.
 */
export async function armAuthRefreshSweep(): Promise<void> {
  await queue().add('tick', { at: new Date().toISOString() } satisfies AuthRefreshJob, {
    repeat: { every: 60 * 60_000 },
    jobId: 'qaai-auth-refresh-tick',
    removeOnComplete: 20,
    removeOnFail: 20,
  });
}

export async function closeAuthRefreshQueue(): Promise<void> {
  if (refreshQueue) await refreshQueue.close();
  refreshQueue = null;
}

/**
 * Re-exported so a consumer of a refreshed session has ONE import for the whole
 * path — read the row, gate it, open it.
 *
 * Not a convenience: `run.ts` and `explore.ts` each re-derived "is this session
 * fresh" from the raw columns, which is how one expression came to be spelt
 * three times and wrong in all three. A single specifier is what makes the
 * replacement edit a deletion rather than a rewrite.
 */
export {
  countSessionGate,
  openSession,
  readVaultKeys,
  sealSession,
  sessionDegradation,
  sessionGate,
  SESSION_REFRESH_LEAD_MS,
  SESSION_ROW_SELECT,
};

// ─── The consumers' door: read the row, gate it, open it ─────────────────────

/**
 * WHAT A CONSUMER MAY CARRY FOR ONE PROFILE, AND WHY.
 *
 * ── Four fields because they are four different facts ─────────────────────
 *
 * The three lines this replaces produced ONE value — a session or `null` — and
 * a `null` fell through to an anonymous crawl. So the answer here keeps the
 * session apart from the reason, and keeps the reason apart from the GATE,
 * because a caller has to render the state name without being able to reach
 * the session and has to decide on `gate.notRun` without re-deriving it.
 */
export interface CachedSessionRead {
  /** The gate's own verdict, unmodified. `notRun` and `anonymousPermitted` included. */
  readonly gate: SessionGate;
  /**
   * THE SESSION TO CARRY, or null when none may be carried.
   *
   * Non-null for exactly two situations: a sealed session the gate called
   * usable and this process opened, and a LEGACY_PLAINTEXT row — see
   * {@link CachedSessionSource}. Null is never "run it anonymously"; it is
   * "there is no session here", and what the caller does about that is the
   * caller's typed decision.
   */
  readonly storageState: unknown | null;
  readonly source: CachedSessionSource;
  /**
   * One sentence for an operator. NAMES NO PART OF ANY SESSION: it is built
   * from the gate's own detail and from closed vocabularies, and
   * `auth-refresh.test.ts` asserts that for every source.
   */
  readonly detail: string;
}

/**
 * WHERE THE SESSION A CONSUMER IS ABOUT TO CARRY CAME FROM.
 *
 *   SEALED            opened out of `storageStateSealed` under a named key
 *                     version. The normal case once the brake is armed.
 *   LEGACY_PLAINTEXT  taken from the legacy column. See {@link openCachedSession}
 *                     for why this is CARRIED rather than refused.
 *   NONE              nothing is carried. The gate says why.
 *
 * Reported rather than inferred from `storageState !== null`, because "we used
 * the sealed column" and "we used the one the migration was written to empty"
 * are the two facts an operator needs in order to know whether a writer that
 * predates this control is still running — and that is a count, not a guess.
 */
export const CACHED_SESSION_SOURCES = ['SEALED', 'LEGACY_PLAINTEXT', 'NONE'] as const;
export type CachedSessionSource = (typeof CACHED_SESSION_SOURCES)[number];

/**
 * THE ONE READER. Both consumers of a cached session call this and nothing else.
 *
 * ── What it replaces ──────────────────────────────────────────────────────
 *
 *     const fresh = profile.storageState &&
 *       (!profile.storageStateExpiresAt || profile.storageStateExpiresAt > new Date());
 *
 * spelt once in apps/worker/src/processors/explore.ts and once in
 * apps/worker/src/processors/run.ts, reading a NULL expiry as "valid for ever"
 * in both, and collapsing eight distinguishable situations into a `null` that
 * the caller then treated as consent to run signed out.
 *
 * ── LEGACY_PLAINTEXT IS CARRIED, AND THAT IS DELIBERATE ───────────────────
 *
 * `SESSION_STATE_RULES.LEGACY_PLAINTEXT.usable` is false, and it is right to
 * be: a run must not CACHE a session out of that column or treat it as
 * vouched-for. But a non-null legacy column means an un-migrated writer —
 * apps/api/src/routes/projects.ts, or an older image — has written the
 * customer's CURRENT session there, and that session works today. Refusing it
 * would take a working product away while protecting nothing: the value is
 * already in the clear in the database, and declining to read it does not
 * un-leak it. So it is carried, the SOURCE says so, and the refresh sweep
 * replaces it under ENFORCE within the hour. The honest cost of the other
 * choice is a whole install's default-identity suites refused every time
 * somebody presses "Sign in" in the cockpit.
 *
 * ── FAILS CLOSED EVERYWHERE ELSE ──────────────────────────────────────────
 *
 * A null cipher, an envelope that will not parse, a key version this process
 * cannot name, a drifted version column and a tag failure all produce
 * `storageState: null` with the reason attached. There is no arm that treats a
 * failure to OPEN as an absence of session, because "treat it as absent" is
 * precisely how an unreadable session became an anonymous run.
 */
export async function openCachedSession(
  row: SealedSessionRow,
  options: {
    readonly keys: Awaited<ReturnType<typeof readVaultKeys>>;
    /** Null when this process holds no usable master key. See {@link workerSessionCipher}. */
    readonly cipher: SessionCipher | null;
    readonly now: Date;
    readonly mode: ControlMode;
  },
): Promise<CachedSessionRead> {
  const gate = sessionGate(row, { now: options.now, mode: options.mode });

  if (gate.usable) {
    if (options.cipher === null) {
      return {
        gate,
        storageState: null,
        source: 'NONE',
        detail:
          'This profile holds a sealed session and this process holds no usable vault master ' +
          'key, so nothing was opened and nothing was attempted against another key.',
      };
    }
    const opened = await openSession({ row, keys: options.keys.keys, cipher: options.cipher });
    if (!opened.ok) {
      return {
        gate,
        storageState: null,
        source: 'NONE',
        /*
         * The refusal CODE and the store's own sentence, both of which are
         * closed vocabularies about the envelope and the keys. Neither
         * contains the payload, a nonce, key material or any part of the
         * session — `session-store.ts` asserts that for every refusal it can
         * produce, which is what makes quoting them here safe.
         */
        detail: `The sealed session did not open (${opened.refusal}): ${opened.detail}`,
      };
    }
    /*
     * ── THE ONE LINE WHERE THE PLAINTEXT LEAVES `OpenedSecret` ─────────────
     *
     * `useSessionState`'s own comment says a callback that returns the session
     * itself defeats the type, and that this is "a reviewable line rather than
     * an invisible one". This is that line, and there is exactly one of it per
     * consumer path: Playwright needs the parsed storageState object to build
     * a context with, so it cannot stay inside the callback. Nothing between
     * here and the browser logs it — rule 11 and explore.ts's own comment at
     * the `signIn` adapter both say `storageState` IS the credential.
     */
    return {
      gate,
      storageState: useSessionState(opened.value, (storageState) => storageState),
      source: 'SEALED',
      detail: gate.detail,
    };
  }

  if (gate.state === 'LEGACY_PLAINTEXT') {
    /*
     * ── CARRIED, BUT ONLY WHILE IT IS STILL VALID ───────────────────────────
     *
     * `sessionStateOf` tests the legacy column FIRST and never reaches the
     * expiry, which is exactly right for a gate that refuses the state
     * outright — and exactly wrong for a caller that carries it. An EXPIRED
     * plaintext session carried into a run is the ORIGINAL defect, not a
     * mitigation of it: a dead session is handed to the browser, the browser is
     * bounced to a login, and most assertions pass against the login page.
     *
     * A NULL expiry is refused for the reason `SEALED_NO_EXPIRY` exists as its
     * own state: `!expiresAt ||` was the arm that read a missing expiry as
     * "valid for ever", and that is the opposite of what an absent expiry can
     * honestly mean.
     */
    const expiresAt = row.storageStateExpiresAt;
    if (expiresAt === null || expiresAt.getTime() <= options.now.getTime()) {
      return {
        gate,
        storageState: null,
        source: 'NONE',
        detail:
          'This profile holds a session in the legacy plaintext column and it is ' +
          `${expiresAt === null ? 'recorded with no expiry' : 'past its expiry'}, so it is not ` +
          'carried. A missing expiry is not an unlimited one.',
      };
    }
    return {
      gate,
      storageState: row.storageState,
      source: 'LEGACY_PLAINTEXT',
      detail:
        'This profile holds a session in the legacy plaintext column, which means a writer that ' +
        'predates the sealing migration has run since. It is carried while it is valid, because ' +
        'it is the newest session the customer has and it works today, and the refresh sweep ' +
        'replaces it with a sealed one under ENFORCE.',
    };
  }

  return { gate, storageState: null, source: 'NONE', detail: gate.detail };
}

/**
 * The worker's session cipher, or NULL when this process cannot build one.
 *
 * ── Why this one is nullable and `productionDeps` above is not ────────────
 *
 * The SWEEP must fail loudly on a malformed `VAULT_MASTER_KEY`: it is a
 * scheduled job, its failure is visible, and an operator has to know the key is
 * wrong. A RUN must fail CLOSED per profile instead — taking the whole run down
 * because one profile has a sealed session would turn a key problem into an
 * outage across every test in the suite, including the ones that need no
 * identity at all. So the error is converted into "no cipher", which
 * {@link openCachedSession} turns into a named refusal.
 *
 * The thrown error is DISCARDED rather than attached: a key-length error from
 * `masterKeyResolver` is about key material, and nothing from a failed key
 * construction may reach a log line.
 */
export function workerSessionCipher(): SessionCipher | null {
  try {
    return localSessionCipher(masterKeyResolver(config.vaultMasterKey));
  } catch {
    return null;
  }
}
