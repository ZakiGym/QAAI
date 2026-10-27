/**
 * THE RUNNER-SIDE PRINCIPAL RESOLVER — turning named actors into sessions, and
 * refusing to run when one is missing.
 *
 * ── The defect this makes impossible ───────────────────────────────────────
 *
 * The register's sentence, verbatim: "an 8-hour TTL that is never refreshed and
 * an expired session silently degrading every nightly run". Here is the shape
 * of it. A test is bound to an admin profile. The cached session expired at 2am.
 * The run starts at 3am, the session is injected anyway, the browser arrives at
 * /admin/users logged out, gets the login page, and the assertion — "no error
 * banner is visible" — passes. The suite is green. The route is reported as
 * covered by an authenticated test. Nobody finds out until an admin-only
 * endpoint turns out to have been unguarded for a quarter.
 *
 * Silent degradation to anonymous is therefore not a robustness feature, it is
 * THE defect: it is what makes an auth-gated route LOOK covered. So a missing or
 * expired principal yields a typed NOT_RUN with the reason — never a pass, never
 * an anonymous run, and never a SKIP, because a skip does not gate and a suite
 * whose permission tests quietly stopped running is exactly the thing nobody
 * notices. `missingRoleSession` in playwright-harness.ts already does this for
 * the ONE profile a test can bind; this does it for every named principal, which
 * is what a two-actor authorization test needs.
 *
 * ── WHAT IT REFUSES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
 *
 * A principal that NAMES a credential and has none is a refusal. A principal
 * that names none is not:
 *
 *   · an ANONYMOUS principal is the baseline every authorization probe compares
 *     against, and giving it a session would be the bug;
 *   · a DISPOSABLE principal with no auth profile is one the SCENARIO creates —
 *     a signup, an invite acceptance — and it has no session yet BY DESIGN.
 *     Refusing it would make signup, password-reset and lockout scenarios
 *     unrunnable, which is the state this round exists to leave behind.
 *
 * Those three needs are named in {@link PRINCIPAL_NEEDS} rather than inferred at
 * each read site, because "does this actor owe us a session?" answered twice can
 * be answered differently twice.
 *
 * ── SECRECY IS STRUCTURAL, NOT A CONVENTION ────────────────────────────────
 *
 * This module handles `storageState`. No type it returns has a field a
 * credential can sit in: {@link ResolvedPrincipal} carries `hasStorageState`, a
 * boolean, and the state itself is reachable ONLY through
 * {@link PrincipalResolution.storageStateFor} — a method, which `JSON.stringify`
 * drops. {@link PrincipalResolution.toJSON} returns the scrubbed report, so even
 * a nested serialisation of a context that holds one cannot print it. The
 * absence of a session is fully reportable without quoting any part of it:
 * that is what `NO_SESSION` and `SESSION_EXPIRED` are for.
 *
 * ── PURE, AND THE I/O IS A PLAN ────────────────────────────────────────────
 *
 * No browser, no Playwright `Page`, no `fetch`, no clock: the current time is an
 * ARGUMENT (`nowMs`). Creating a browser context per principal is real I/O and
 * belongs in the harness, so this module produces
 * {@link PrincipalContextPlan}s — a description of the contexts to open — and
 * the harness's job is a thin loop over them. That split is why this file's
 * decisions are testable with a fake and 629 lines of crawler.ts were not.
 */

import { isNotRunKind, notRunMessage, runSessions } from '@qaai/shared';
import type { ExecutableTest, NotRunKind, RunContext } from '@qaai/shared';

/*
 * ── DERIVED FROM `RunContext`, NOT IMPORTED ────────────────────────────────
 *
 * `PrincipalSession` and `Principal` live in packages/shared/src/principals.ts,
 * which is not on the @qaai/shared barrel yet — the line is owed, see this
 * round's handover. The two alternatives are both worse: a relative import
 * across the workspace boundary compiles and then bypasses the package entry
 * point, which is the defect this round was told twice not to repeat; and a
 * hand-copied interface is a second declaration free to drift from the first.
 *
 * An indexed-access type off `RunContext` — the contract this module consumes —
 * cannot drift by construction. If `sessions` changes shape, these change with
 * it and the compiler reports it here.
 *
 * OBSERVED DURING THIS ROUND, and the reason this is not provisional: the
 * `export * from './principals'` line APPEARED in the shared barrel mid-round
 * and was GONE from the file twenty minutes later, overwritten by another
 * agent's write to the same index.ts. A module that imports through a barrel
 * line six parallel agents are racing on does not compile reliably; a module
 * that derives from a type it already consumes compiles either way. When the
 * line is settled, the right-hand sides below become imports and nothing else
 * in this file changes.
 */
export type RunSessionMap = NonNullable<RunContext['sessions']>;
export type RunSessionEntry = RunSessionMap[string];
export type SessionPrincipal = RunSessionEntry['principal'];

/**
 * The name the run's single session is filed under — `DEFAULT_PRINCIPAL_NAME`
 * from principals.ts, which this package cannot import yet (see above).
 *
 * A duplicated constant with no guard is how two spellings of one identity get
 * into a codebase, so there is a guard: `principals.test.ts` asserts this equals
 * the key `runSessions()` actually synthesises from a legacy `storageState`. A
 * rename over there goes red here, rather than this resolver quietly looking for
 * a session under a name nothing files one under — which would turn every
 * existing single-session run into a NOT_RUN.
 */
export const RUNNER_DEFAULT_PRINCIPAL_NAME = 'default';

// ─── What an actor owes us ───────────────────────────────────────────────────

/**
 * Whether this actor owes us a session, and if not, why not.
 *
 * Three members, and the two that are not SESSION_REQUIRED are the reason this
 * is an enum instead of a boolean. "No session" is the correct state for both of
 * them and a refusal for neither, and a boolean would force a reader to
 * rediscover which — or, far more likely, to refuse one of them and silently
 * disable a whole class of scenario.
 */
export const PRINCIPAL_NEEDS = [
  /** Names an auth profile. Must arrive with a live session or the test does not run. */
  'SESSION_REQUIRED',
  /** `kind: 'ANONYMOUS'`. A session here would be the bug, not the fix. */
  'ANONYMOUS_BY_DESIGN',
  /**
   * `kind: 'DISPOSABLE'` with no auth profile: the scenario creates this actor
   * itself. No session yet is the design, and the scenario's own signup step is
   * what produces one.
   */
  'PROVISIONED_BY_SCENARIO',
] as const;
export type PrincipalNeed = (typeof PRINCIPAL_NEEDS)[number];

/** Compile-time half of the parity guard; the run-time half is in the test file. */
const PRINCIPAL_NEED_PRESENT: Record<PrincipalNeed, true> = {
  SESSION_REQUIRED: true,
  ANONYMOUS_BY_DESIGN: true,
  PROVISIONED_BY_SCENARIO: true,
};

/** Derived, never hand-listed. */
export const PRINCIPAL_NEED_LIST = Object.keys(
  PRINCIPAL_NEED_PRESENT,
) as ReadonlyArray<PrincipalNeed>;

/** One actor this test needs, with what it owes us. No credential field. */
export interface PrincipalRequirement {
  readonly name: string;
  readonly role: string | null;
  readonly authProfileId: string | null;
  readonly need: PrincipalNeed;
  /**
   * True for the entry that stands in for `RunContext.storageState`.
   *
   * It is a separate fact from the name: a run may file its shared session under
   * another name, and a test's own `authProfileId` creates a default
   * requirement that `test.principals` never mentions.
   */
  readonly isDefault: boolean;
}

/**
 * Every actor this test needs, default first and then by name.
 *
 * ── Why `authProfileId` and `principals` are not alternatives ──────────────
 *
 * `ExecutableTest.authProfileId` binds the DEFAULT principal and
 * `ExecutableTest.principals` names the others; a test with the first set and
 * the second empty is exactly what it has always been. So this produces a
 * default requirement from `authProfileId` or from `authProfileRequired`, and
 * then one per named principal — and a named principal called `default` REPLACES
 * the synthesised one rather than sitting beside it, because two requirements
 * under one name is two sessions that can disagree about one identity, which is
 * the defect `runSessions` was written to remove one level up.
 *
 * `authProfileRequired` with no binding produces a requirement with a null
 * profile id and `need: 'SESSION_REQUIRED'`. That pair is not a contradiction —
 * it is the state the foreign key creates when a profile is deleted, and the
 * test's own declaration that it is meaningless signed out is the thing that
 * must still be honoured. The resolver turns it into NO_SESSION with the
 * re-bind as the remedy.
 */
export function requiredPrincipals(
  test: Pick<ExecutableTest, 'authProfileId' | 'authProfileRequired' | 'principals'>,
  defaultPrincipalName: string = RUNNER_DEFAULT_PRINCIPAL_NAME,
): readonly PrincipalRequirement[] {
  const named = test.principals ?? [];
  const out: PrincipalRequirement[] = [];

  const boundProfile = typeof test.authProfileId === 'string' && test.authProfileId !== ''
    ? test.authProfileId
    : null;
  const declaresDefault = named.some((p) => p.name === defaultPrincipalName);

  if (!declaresDefault && (boundProfile !== null || test.authProfileRequired === true)) {
    out.push({
      name: defaultPrincipalName,
      role: null,
      authProfileId: boundProfile,
      need: 'SESSION_REQUIRED',
      isDefault: true,
    });
  }

  for (const p of [...named].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push({
      name: p.name,
      role: p.role,
      authProfileId: p.authProfileId,
      need: needOf(p),
      isDefault: p.name === defaultPrincipalName,
    });
  }

  return out;
}

/**
 * The one place the three needs are decided.
 *
 * ANONYMOUS before the profile check, because an anonymous principal that
 * somehow carries a profile id is a contradiction in the plan item and the
 * honest reading of it is the `kind` — the field whose whole purpose is to say
 * "this actor has no account". Treating it as SESSION_REQUIRED would refuse to
 * run the baseline probe every authorization check compares against.
 */
function needOf(p: SessionPrincipal): PrincipalNeed {
  if (p.kind === 'ANONYMOUS') return 'ANONYMOUS_BY_DESIGN';
  const hasProfile = typeof p.authProfileId === 'string' && p.authProfileId !== '';
  if (hasProfile) return 'SESSION_REQUIRED';
  if (p.kind === 'DISPOSABLE') return 'PROVISIONED_BY_SCENARIO';
  /*
   * PERSISTENT with no profile. Not provisionable — a PERSISTENT actor is the
   * customer's own account and a scenario may not create or destroy one — and
   * not anonymous, because it claims to be somebody. So it owes us a session it
   * has no way to obtain, which the resolver reports as NO_SESSION naming the
   * missing binding. The alternative, reading it as anonymous, is the silent
   * degradation this file exists to refuse.
   */
  return 'SESSION_REQUIRED';
}

// ─── Why a principal did not resolve ─────────────────────────────────────────

/**
 * Every way a required session can fail to arrive. Each is a sentence the
 * report prints, and each maps to a {@link NotRunKind} in {@link NOT_RUN_FOR}.
 */
export const PRINCIPAL_RESOLUTION_FAILURES = [
  /** Nothing is filed under this name. The login never ran, or it failed. */
  'NO_SESSION',
  /** A session is filed and its declared expiry has passed. THE nightly-run defect. */
  'SESSION_EXPIRED',
  /**
   * A session is filed and it belongs to a DIFFERENT auth profile.
   *
   * Running it would execute an admin test as a member — which does not fail
   * loudly. It signs in successfully as the wrong person and asserts whatever
   * that person can see, so it is refused rather than attempted.
   */
  'WRONG_PROFILE',
  /**
   * A session is filed for this name and does not say WHICH profile it belongs
   * to, while the principal names one.
   *
   * Separate from WRONG_PROFILE because the remedy is ours and not the
   * customer's: `attachAuthProfile` is meant to be called alongside setting
   * `storageState`, and a context carrying a session it cannot attribute is —
   * in run-workspace.ts's own words — indistinguishable from one carrying the
   * wrong session. Refused for that reason rather than run hopefully.
   */
  'UNATTRIBUTED_SESSION',
  /**
   * A session is filed for this name and holds no storageState.
   *
   * An SSO bypass token "signs in" successfully and produces none; so does a
   * login whose confirmation step never fired. The entry exists, so NO_SESSION
   * would be the wrong sentence, and running it is an anonymous run under
   * another name.
   */
  'ANONYMOUS_SESSION',
  /**
   * A session is filed with NO declared expiry and the caller set
   * `expiryUndeclared: 'REFUSE'`.
   *
   * Separate from SESSION_EXPIRED because it is a different fact: not "the
   * session is stale" but "nobody can tell whether it is". See
   * {@link PrincipalResolveOptions.expiryUndeclared} for why the default is to
   * run and disclose instead.
   */
  'EXPIRY_UNDECLARED',
  /** The plan item names an actor with a blank name. Malformed test, not a bad environment. */
  'BLANK_NAME',
  /** Two actors share one name, so a session lookup is ambiguous. Malformed test. */
  'DUPLICATE_NAME',
] as const;
export type PrincipalResolutionFailureReason = (typeof PRINCIPAL_RESOLUTION_FAILURES)[number];

/** Compile-time half of the parity guard. */
const PRINCIPAL_RESOLUTION_FAILURE_PRESENT: Record<PrincipalResolutionFailureReason, true> = {
  NO_SESSION: true,
  SESSION_EXPIRED: true,
  WRONG_PROFILE: true,
  UNATTRIBUTED_SESSION: true,
  ANONYMOUS_SESSION: true,
  EXPIRY_UNDECLARED: true,
  BLANK_NAME: true,
  DUPLICATE_NAME: true,
};

/** Derived, never hand-listed. */
export const PRINCIPAL_RESOLUTION_FAILURE_LIST = Object.keys(
  PRINCIPAL_RESOLUTION_FAILURE_PRESENT,
) as ReadonlyArray<PrincipalResolutionFailureReason>;

/**
 * Which `NotRunKind` each failure is, decided once.
 *
 * ── Why the split is BLOCKED_BY_ENV vs UNSUPPORTED and never NOT_RUN ───────
 *
 * The four kinds are not interchangeable and `constants.ts` says what each one
 * costs: BLOCKED_BY_ENV and UNSUPPORTED must be EXCLUDED from a pass rate and
 * from a coverage denominator, CANCELLED means nobody wanted the answer, and
 * NOT_RUN is "nobody wrote to this row" — the weakest, and the honest reading of
 * a row nothing claimed.
 *
 * So: a session that the environment could not produce is BLOCKED_BY_ENV, which
 * is true and keeps it out of both denominators. A test whose own principal list
 * is malformed is UNSUPPORTED — the environment is fine and the input is not.
 * NOTHING here maps to NOT_RUN or CANCELLED: this module always has a claim, and
 * writing the weakest kind over a claim we actually hold would put a shrug in
 * the database where a reason belongs. `principals.test.ts` asserts that in both
 * directions over the whole list.
 */
const NOT_RUN_FOR: Record<PrincipalResolutionFailureReason, NotRunKind> = {
  NO_SESSION: 'BLOCKED_BY_ENV',
  SESSION_EXPIRED: 'BLOCKED_BY_ENV',
  WRONG_PROFILE: 'BLOCKED_BY_ENV',
  UNATTRIBUTED_SESSION: 'BLOCKED_BY_ENV',
  ANONYMOUS_SESSION: 'BLOCKED_BY_ENV',
  EXPIRY_UNDECLARED: 'BLOCKED_BY_ENV',
  BLANK_NAME: 'UNSUPPORTED',
  DUPLICATE_NAME: 'UNSUPPORTED',
};

/**
 * The sentence for each failure. Exhaustive by `Record`, so an eighth reason
 * cannot ship without one.
 *
 * READ THESE AS A SECURITY SURFACE. Every one of them is interpolated into
 * `TestResult.errorMessage`, stored, exported, rendered in the cockpit and
 * attached to a GitHub check. Not one of them may quote a cookie, a token, a
 * storageState or any part of one: the ABSENCE of a session is fully describable
 * by naming the principal, the profile id and what was expected, and
 * `principals.test.ts` pins that with a sentinel value it asserts never appears.
 */
const FAILURE_DETAIL: Record<PrincipalResolutionFailureReason, string> = {
  NO_SESSION:
    'no session was resolved for this principal, so running the test would run it as nobody — ' +
    'an anonymous browser on an auth-gated page gets the login wall, which a loose assertion ' +
    'passes. Check that the auth profile still exists and that its login succeeded on this run',
  SESSION_EXPIRED:
    'the session resolved for this principal has a declared expiry that has already passed, so ' +
    'injecting it would run the test signed out. Refresh the profile\'s session before the run ' +
    'rather than at the start of the night',
  WRONG_PROFILE:
    'the session resolved under this principal\'s name belongs to a different auth profile, so ' +
    'the test would run as the wrong identity — which does not fail loudly, it passes as ' +
    'whatever that identity can see',
  UNATTRIBUTED_SESSION:
    'a session was resolved for this principal and nothing recorded which auth profile it ' +
    'belongs to, so it cannot be shown to be the right identity. The worker should call ' +
    'attachAuthProfile wherever it sets storageState',
  ANONYMOUS_SESSION:
    'a session was resolved for this principal and it carries no browser state, so the test ' +
    'would run anonymously under an authenticated name. A bypass-token profile produces this: ' +
    'it authenticates a request and gives a browser nothing',
  EXPIRY_UNDECLARED:
    'the session resolved for this principal declares no expiry, and this run was configured to ' +
    'refuse rather than disclose that. Record an expiry when the login resolves the session, so ' +
    'a stale nightly run fails instead of passing',
  BLANK_NAME:
    'this test names a principal with a blank name, so there is no key to look a session up ' +
    'under. The plan item that produced it is malformed',
  DUPLICATE_NAME:
    'this test names two principals with the same name, so a session lookup is ambiguous and ' +
    'the test could silently act as either. The plan item that produced it is malformed',
};

export interface PrincipalResolutionFailure {
  readonly principalName: string;
  readonly reason: PrincipalResolutionFailureReason;
  /** The profile that was expected, for the report. Never a credential. */
  readonly authProfileId: string | null;
  /** The typed outcome, ready to put on a `TestExecution`. */
  readonly notRun: { kind: NotRunKind; why: string };
}

// ─── Things a reader must know about a resolution that SUCCEEDED ─────────────

/**
 * Facts that do not stop the run and that a reader must have anyway.
 *
 * Every one of them weakens what a PASS means, which is the only reason they
 * exist as data rather than as nothing: a green test whose session's liveness
 * was never established is not the same evidence as a green test whose session
 * was known good, and a report that cannot tell them apart has rounded a
 * caveat down to a pass.
 */
export const PRINCIPAL_CAVEATS = [
  /**
   * The session declares no expiry. Null is "nobody told us", NOT "never
   * expires" — a resolver that read it as the second is the 8-hour-TTL defect.
   */
  'EXPIRY_UNDECLARED',
  /**
   * The principal has a profile and no role, so a verdict from it cannot be
   * attributed to a (route, role) cell. It is coverage of the route by SOMEBODY
   * and of the cell by nobody.
   */
  'ROLE_UNDECLARED',
  /**
   * Two principals resolved to the same session.
   *
   * A two-actor test whose actors share one identity compares an identity with
   * itself: every cross-tenant read succeeds, nothing is denied, and it renders
   * as "no leakage found". That is the vacuous pass `TenantPair.distinct` refuses
   * one level up, and it has to be sayable here too, because the resolver is the
   * first place that can see it.
   */
  'SHARED_SESSION',
] as const;
export type PrincipalCaveatKind = (typeof PRINCIPAL_CAVEATS)[number];

/** Compile-time half of the parity guard. */
const PRINCIPAL_CAVEAT_PRESENT: Record<PrincipalCaveatKind, true> = {
  EXPIRY_UNDECLARED: true,
  ROLE_UNDECLARED: true,
  SHARED_SESSION: true,
};

/** Derived, never hand-listed. */
export const PRINCIPAL_CAVEAT_LIST = Object.keys(
  PRINCIPAL_CAVEAT_PRESENT,
) as ReadonlyArray<PrincipalCaveatKind>;

const CAVEAT_DETAIL: Record<PrincipalCaveatKind, string> = {
  EXPIRY_UNDECLARED:
    'this session declares no expiry, so a pass does not establish that it was still live — ' +
    'record an expiry when the login resolves it',
  ROLE_UNDECLARED:
    'this principal declares no role, so a verdict from it covers the route and no (route, role) ' +
    'cell — set AuthProfile.role to make the coverage attributable',
  SHARED_SESSION:
    'this principal resolved to the same session as another, so a test that compares the two is ' +
    'comparing one identity with itself and cannot find a cross-identity defect',
};

export interface PrincipalCaveat {
  readonly principalName: string;
  readonly kind: PrincipalCaveatKind;
  readonly detail: string;
}

// ─── The resolution ──────────────────────────────────────────────────────────

/**
 * One actor, resolved. CARRIES NO CREDENTIAL AND HAS NOWHERE TO PUT ONE.
 *
 * `hasStorageState` is the whole of what this says about the secret: whether
 * there is one. The state itself comes from
 * {@link PrincipalResolution.storageStateFor}, which is a method and therefore
 * absent from every serialisation of this object — by `JSON.stringify`, by a
 * structured log, by an artifact writer. That is a structural guarantee rather
 * than a rule somebody has to remember at the sixth call site.
 */
export interface ResolvedPrincipal {
  readonly name: string;
  readonly role: string | null;
  readonly authProfileId: string | null;
  readonly need: PrincipalNeed;
  /** Whether a browser state was resolved. NEVER the state. */
  readonly hasStorageState: boolean;
  /** The declared expiry, or null when none was declared. Not a secret. */
  readonly expiresAtIso: string | null;
}

/** The whole resolution, as a plain object safe to log, store or export. */
export interface PrincipalResolutionReport {
  readonly testId: string;
  readonly resolved: readonly ResolvedPrincipal[];
  readonly failures: readonly PrincipalResolutionFailure[];
  readonly caveats: readonly PrincipalCaveat[];
  readonly ok: boolean;
  readonly notRun: { kind: NotRunKind; why: string } | null;
}

export interface PrincipalResolution extends PrincipalResolutionReport {
  /**
   * The ONE door to a credential. Null for a name that did not resolve, for an
   * anonymous principal, and for one the scenario has yet to create.
   *
   * A method and not a field, deliberately: `JSON.stringify` drops methods, so
   * the credential cannot reach a log, an artifact or an HTTP response by
   * somebody serialising this object. Call it at the point of use and do not
   * store what it returns.
   */
  storageStateFor(name: string): unknown | null;
  /** Everything safe to print. Also what `JSON.stringify` of this returns. */
  toJSON(): PrincipalResolutionReport;
}

export interface PrincipalResolveOptions {
  /**
   * Now, in milliseconds since the epoch. INJECTED — there is no ambient clock
   * in this module, because an expiry comparison against a clock nobody passed
   * is a test that passes in the morning and fails at night.
   */
  readonly nowMs: number;
  /**
   * What to do about a session with NO declared expiry.
   *
   * 'CAVEAT' (the default) resolves it and records {@link PRINCIPAL_CAVEATS}'s
   * EXPIRY_UNDECLARED. 'REFUSE' turns it into a NOT_RUN.
   *
   * ── Why the default is the weaker one ──────────────────────────────────
   *
   * Because `runSessions()` synthesises the legacy `RunContext.storageState`
   * entry with `expiresAtIso: null`, so REFUSE as a default would turn every
   * existing single-session run in every install into a BLOCKED_BY_ENV
   * overnight. A brake arrives at `observe` and is armed deliberately; this is
   * the same judgement. What the default must not do is go QUIET, and it does
   * not — the caveat is counted, carries a remedy, and reaches the report.
   */
  readonly expiryUndeclared?: 'CAVEAT' | 'REFUSE';
  /** The name this run files its shared session under. */
  readonly defaultPrincipalName?: string;
}

/**
 * Resolve every actor this test needs, or say precisely which one could not be.
 *
 * Reads the run's sessions through `runSessions()` and not through
 * `ctx.sessions` or `ctx.storageState` directly, and that is not tidiness: two
 * fields that can both describe the default identity is two fields that can
 * DISAGREE about it, and the way that defect shows up is a test running as the
 * wrong identity and passing. `runSessions` decides the precedence once.
 *
 * Returns a resolution even when nothing failed, and `notRun` is null exactly
 * then. A caller that only looks at `notRun` is correct; a caller that reads
 * `caveats` is better informed.
 */
export function resolvePrincipals(
  ctx: Pick<RunContext, 'storageState' | 'sessions' | 'authProfileId'>,
  test: Pick<ExecutableTest, 'id' | 'authProfileId' | 'authProfileRequired' | 'principals'>,
  options: PrincipalResolveOptions,
): PrincipalResolution {
  const defaultName = options.defaultPrincipalName ?? RUNNER_DEFAULT_PRINCIPAL_NAME;
  const sessions = runSessions(ctx);
  const requirements = requiredPrincipals(test, defaultName);

  const resolved: ResolvedPrincipal[] = [];
  const failures: PrincipalResolutionFailure[] = [];
  const caveats: PrincipalCaveat[] = [];
  const states = new Map<string, unknown>();

  const fail = (
    principalName: string,
    reason: PrincipalResolutionFailureReason,
    authProfileId: string | null,
  ): void => {
    const why = `principal "${principalName}": ${FAILURE_DETAIL[reason]}.`;
    failures.push({
      principalName,
      reason,
      authProfileId,
      notRun: { kind: NOT_RUN_FOR[reason], why: notRunMessage(NOT_RUN_FOR[reason], why) },
    });
  };

  /*
   * ── SHAPE FIRST, AND THE EARLY RETURN IS THE POINT ────────────────────────
   *
   * BLANK_NAME and DUPLICATE_NAME are properties of the TEST, not of the
   * environment, and they are the only two failures here that mean "we cannot
   * interpret what was asked for". Resolved after the session lookups they came
   * back second: a test naming two actors `victim` produced NO_SESSION for the
   * first and DUPLICATE_NAME for the second, so the headline was
   * BLOCKED_BY_ENV — "your staging box is down" — about a malformed plan item.
   *
   * So the shape is checked in its own pass and the function returns on any
   * failure. Nothing is suppressed: every shape failure is on the list with its
   * own sentence. What is deliberately NOT attempted is the session lookup,
   * because looking a session up under an ambiguous name is how a test comes to
   * act as either of two identities depending on iteration order.
   */
  const seen = new Set<string>();
  for (const req of requirements) {
    if (req.name.trim() === '') fail(req.name, 'BLANK_NAME', req.authProfileId);
    else if (seen.has(req.name)) fail(req.name, 'DUPLICATE_NAME', req.authProfileId);
    else seen.add(req.name);
  }
  if (failures.length > 0) {
    const shapeReport: PrincipalResolutionReport = {
      testId: test.id,
      resolved: [],
      failures,
      caveats: [],
      ok: false,
      notRun: failures[0]?.notRun ?? null,
    };
    return {
      ...shapeReport,
      storageStateFor: (): unknown | null => null,
      toJSON: (): PrincipalResolutionReport => shapeReport,
    };
  }

  for (const req of requirements) {
    /*
     * The two needs that owe us nothing are resolved before the session lookup,
     * not after. Looking first and then deciding would make a stray session
     * under an anonymous principal's name silently become its identity, which
     * is the opposite of what ANONYMOUS means.
     */
    if (req.need === 'ANONYMOUS_BY_DESIGN' || req.need === 'PROVISIONED_BY_SCENARIO') {
      resolved.push({
        name: req.name,
        role: req.role,
        authProfileId: req.authProfileId,
        need: req.need,
        hasStorageState: false,
        expiresAtIso: null,
      });
      continue;
    }

    const entry: RunSessionEntry | undefined = Object.prototype.hasOwnProperty.call(
      sessions,
      req.name,
    )
      ? sessions[req.name]
      : undefined;

    if (entry === undefined) {
      fail(req.name, 'NO_SESSION', req.authProfileId);
      continue;
    }

    const sessionProfile = entry.principal.authProfileId;

    /*
     * ── EMPTINESS BEFORE ATTRIBUTION, AND WHICH EMPTINESS IT IS ─────────────
     *
     * An entry with no `storageState` has two completely different causes and
     * they carry different remedies, so they are different failures:
     *
     *   NO_SESSION         nothing was ever resolved for this name. `runSessions`
     *                      SYNTHESISES exactly this entry from a null
     *                      `RunContext.storageState` — deliberately, so a caller
     *                      cannot read "no entry" as "we could not sign in" — and
     *                      it marks it ANONYMOUS with no profile. That placeholder
     *                      is the ABSENCE of a session, not a session.
     *   ANONYMOUS_SESSION  a profile WAS resolved and produced no browser state.
     *                      An SSO bypass token does this: it authenticates a
     *                      request and gives a browser nothing.
     *
     * Checked before the profile comparison, because the synthesised placeholder
     * names no profile, so comparing first reported UNATTRIBUTED_SESSION — "the
     * worker should call attachAuthProfile" — for a run where no login had ever
     * been attempted. A true sentence about the wrong thing sends a reader to
     * the wrong file.
     */
    if (entry.storageState === null || entry.storageState === undefined) {
      const placeholder = entry.principal.kind === 'ANONYMOUS' || sessionProfile === null;
      fail(req.name, placeholder ? 'NO_SESSION' : 'ANONYMOUS_SESSION', req.authProfileId);
      continue;
    }

    /*
     * AN UNATTRIBUTED SESSION IS REFUSED, and that is deliberately the same
     * rule `missingRoleSession` in playwright-harness.ts already applies: it
     * requires `supplied === declared`, so a context whose `authProfileId` is
     * null fails it too. Two resolvers that disagree about whether a test may
     * run is two answers to one question, and the way that defect shows up is
     * the test running under whichever resolver the code path reached. Matching
     * it is worth more than being independently lenient.
     *
     * A requirement with a null profile id — the `authProfileRequired`-with-no-
     * binding case, where the foreign key nulled the binding — skips this
     * branch: there is nothing to compare against, and the session's own
     * profile is the best available answer. The harness treats it the same way.
     */
    if (req.authProfileId !== null && sessionProfile !== req.authProfileId) {
      fail(
        req.name,
        sessionProfile === null ? 'UNATTRIBUTED_SESSION' : 'WRONG_PROFILE',
        req.authProfileId,
      );
      continue;
    }

    const expiresAtIso = entry.expiresAtIso;
    if (expiresAtIso === null) {
      if ((options.expiryUndeclared ?? 'CAVEAT') === 'REFUSE') {
        fail(req.name, 'EXPIRY_UNDECLARED', req.authProfileId);
        continue;
      }
      caveats.push({
        principalName: req.name,
        kind: 'EXPIRY_UNDECLARED',
        detail: CAVEAT_DETAIL.EXPIRY_UNDECLARED,
      });
    } else {
      const expiresAtMs = Date.parse(expiresAtIso);
      /*
       * An UNPARSEABLE expiry is treated as undeclared and NOT as expired.
       * `Date.parse` returns NaN and every comparison with NaN is false, so the
       * naive `expiresAtMs <= nowMs` would silently resolve it as live — the
       * exact silent degradation this file refuses. Routed through the
       * undeclared arm instead, it carries a caveat or a refusal depending on
       * the policy, which is the honest reading: nobody can tell.
       */
      if (!Number.isFinite(expiresAtMs)) {
        if ((options.expiryUndeclared ?? 'CAVEAT') === 'REFUSE') {
          fail(req.name, 'EXPIRY_UNDECLARED', req.authProfileId);
          continue;
        }
        caveats.push({
          principalName: req.name,
          kind: 'EXPIRY_UNDECLARED',
          detail: CAVEAT_DETAIL.EXPIRY_UNDECLARED,
        });
      } else if (expiresAtMs <= options.nowMs) {
        fail(req.name, 'SESSION_EXPIRED', req.authProfileId);
        continue;
      }
    }

    const role = req.role ?? entry.principal.role;
    if (role === null || role.trim() === '') {
      caveats.push({
        principalName: req.name,
        kind: 'ROLE_UNDECLARED',
        detail: CAVEAT_DETAIL.ROLE_UNDECLARED,
      });
    }

    states.set(req.name, entry.storageState);
    resolved.push({
      name: req.name,
      role: role === null || role.trim() === '' ? null : role,
      authProfileId: req.authProfileId ?? sessionProfile,
      need: req.need,
      hasStorageState: true,
      expiresAtIso,
    });
  }

  /*
   * SHARED_SESSION, detected by IDENTITY and not by value.
   *
   * `===` on the resolved storageState, because that is the only comparison
   * this module may make: deep-equalling two states would mean walking a
   * credential-bearing structure, and hashing one would mean deriving a value
   * from a secret — which the rule forbids "not truncated, not hashed". Two
   * principals handed the same object by the session resolver is the case that
   * actually occurs, since it is one cached session looked up twice.
   */
  const byState = new Map<unknown, string[]>();
  for (const [name, state] of states) {
    const names = byState.get(state);
    if (names) names.push(name);
    else byState.set(state, [name]);
  }
  for (const names of byState.values()) {
    if (names.length < 2) continue;
    for (const name of [...names].sort()) {
      caveats.push({
        principalName: name,
        kind: 'SHARED_SESSION',
        detail: `${CAVEAT_DETAIL.SHARED_SESSION} (shared with ${names.filter((n) => n !== name).sort().join(', ')})`,
      });
    }
  }

  const ok = failures.length === 0;
  const report: PrincipalResolutionReport = {
    testId: test.id,
    resolved,
    failures,
    caveats,
    ok,
    /*
     * The FIRST failure's outcome becomes the test's, and the rest stay on the
     * list. One test produces one `TestExecution`, which holds one `notRun`, so
     * something has to be chosen — and the first in requirement order is the
     * default principal when it failed, which is the one a reader should look at
     * first. Nothing is suppressed: `failures` carries all of them, and a
     * caller that reports only `notRun` has still disclosed a count it can print.
     */
    notRun: ok ? null : (failures[0]?.notRun ?? null),
  };

  return {
    ...report,
    storageStateFor: (name: string): unknown | null => {
      if (!states.has(name)) return null;
      return states.get(name) ?? null;
    },
    toJSON: (): PrincipalResolutionReport => report,
  };
}

// ─── The plan the harness executes ───────────────────────────────────────────

/**
 * The file one PRINCIPAL's session is written to.
 *
 * Keyed on the principal NAME and not on the profile id, unlike
 * `storageStateFileName` in playwright-harness.ts — which stays as it is and
 * keeps meaning what it means for the single-session path. The grain here is
 * the actor: two principals may legitimately share one auth profile (a holder
 * and a subject of the same role), and a file per profile would put one name's
 * session where another name's belongs with nothing in the workspace to show
 * it. A principal name is scenario-authored text and becomes a real filename,
 * so it is sanitised like any other untrusted path component.
 */
export function principalStorageStateFileName(principalName: string): string {
  const safe = principalName.replace(/[^A-Za-z0-9._-]/g, '_');
  return `storage-state-principal-${safe === '' ? 'unnamed' : safe}.json`;
}

/** One browser context the harness must open. Describes it; does not open it. */
export interface PrincipalContextPlan {
  readonly principalName: string;
  readonly authProfileId: string | null;
  readonly role: string | null;
  /** Where the harness writes this principal's state, relative to the workspace. */
  readonly storageStateFileName: string;
  /**
   * Whether a state exists to inject.
   *
   * FALSE for an anonymous principal and for one the scenario creates, and in
   * both cases that is correct rather than a shortfall. A harness that treated
   * false as "fall back to the default session" would hand the anonymous
   * baseline an authenticated session and make every authorization probe pass.
   */
  readonly injectStorageState: boolean;
}

/**
 * The contexts to open, in a stable order.
 *
 * Returns plans ONLY for principals that resolved, which is why it takes a
 * resolution and not a test: a plan for a principal whose session is missing is
 * a context the harness would open anonymously, and that is the degradation
 * this module exists to prevent. A failed resolution produces NO plan and a
 * NOT_RUN, in that order.
 */
export function principalContextPlans(
  resolution: Pick<PrincipalResolution, 'resolved'>,
): readonly PrincipalContextPlan[] {
  return [...resolution.resolved]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      principalName: p.name,
      authProfileId: p.authProfileId,
      role: p.role,
      storageStateFileName: principalStorageStateFileName(p.name),
      injectStorageState: p.hasStorageState,
    }));
}

// ─── Reporting an absence without quoting it ─────────────────────────────────

/**
 * The one safe rendering of a run's sessions: who, in what state, with what
 * expiry — and no credential anywhere.
 *
 * This exists so that logging code has something to call. `ctx.sessions` is
 * secret-bearing and `ctx.storageState` is secret-bearing, and the way they
 * leak is not a deliberate `logger.info({ sessions })` — it is a diagnostic
 * someone adds at 3am that spreads the context into a log line. A named,
 * obviously-safe alternative is the only intervention that survives that.
 */
export function describeRunSessions(
  ctx: Pick<RunContext, 'storageState' | 'sessions' | 'authProfileId'>,
): ReadonlyArray<{
  name: string;
  role: string | null;
  authProfileId: string | null;
  hasStorageState: boolean;
  expiresAtIso: string | null;
}> {
  const sessions = runSessions(ctx);
  return Object.keys(sessions)
    .sort()
    .map((name) => {
      const entry = sessions[name];
      return {
        name,
        role: entry?.principal.role ?? null,
        authProfileId: entry?.principal.authProfileId ?? null,
        hasStorageState: entry?.storageState !== null && entry?.storageState !== undefined,
        expiresAtIso: entry?.expiresAtIso ?? null,
      };
    });
}

/**
 * One line per failure, for a human.
 *
 * Built from the failure list rather than from the sessions, so there is no
 * code path here that touches a credential at all — the strongest form of "its
 * absence must be reportable without quoting any part of it".
 */
export function describePrincipalFailures(
  resolution: Pick<PrincipalResolution, 'failures'>,
): readonly string[] {
  return resolution.failures.map(
    (f) =>
      `${f.principalName} [${f.reason}]${f.authProfileId === null ? '' : ` (auth profile ${f.authProfileId})`}: ${FAILURE_DETAIL[f.reason]}.`,
  );
}

/**
 * Narrow an untrusted string to a failure reason, so a stored row reads back.
 *
 * Mirrors `isNotRunKind`, which is used here to assert the invariant the
 * `NOT_RUN_FOR` map rests on: every value in it is a real `NotRunKind`. A map
 * literal cannot drift from the union it is keyed on, but it CAN drift from the
 * union it is valued by, and this is the cheapest place to notice.
 */
export function isPrincipalResolutionFailure(
  value: unknown,
): value is PrincipalResolutionFailureReason {
  return (
    typeof value === 'string' &&
    (PRINCIPAL_RESOLUTION_FAILURE_LIST as readonly string[]).includes(value)
  );
}

/** The `NotRunKind` a given failure produces. Exported so a reader need not guess. */
export function notRunKindFor(reason: PrincipalResolutionFailureReason): NotRunKind {
  const kind = NOT_RUN_FOR[reason];
  /*
   * Defensive and cheap: `NOT_RUN_FOR` is typed, so this cannot fire today.
   * It exists because the map's VALUES are the half a `Record` does not pin —
   * a future edit can put a plausible-looking string there — and a bad value
   * reaching the database as a kind is worse than throwing here.
   */
  if (!isNotRunKind(kind)) {
    throw new Error(`gap in NOT_RUN_FOR: ${reason} maps to a value that is not a NotRunKind`);
  }
  return kind;
}
