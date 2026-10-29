/**
 * AUTHENTICATION-LIFECYCLE JOURNEYS — the flows nothing has ever driven.
 *
 * ── The defect this file exists to close ────────────────────────────────────
 *
 * Fourteen flows, every one of them among the highest-risk an application has,
 * and not one of them is exercised today:
 *
 *   signup · email verification · login · logout · session expiry · session
 *   revocation · password reset · password change · account lockout · unlock ·
 *   MFA enrolment · recovery-code use · email change · account deletion
 *
 * Two mechanisms kept them undriven, and they reinforced each other. The crawl
 * refuses `/logout` and its siblings (`DEFAULT_CRAWL_POLICY.excludeGlobs` in
 * flow-map.ts, and `SESSION_ENDING` in crawl/interact.ts), because following a
 * sign-out link makes every state measured afterwards anonymous. And the run
 * has ONE shared account, so driving any of these against it destroys the only
 * way in. `EXCLUSION_AS_EXERCISE.SESSION_ENDING` in coverage.ts already states
 * the remedy — "bind a second auth profile the harness is allowed to log out" —
 * and nothing in the repository could produce one.
 *
 * This module produces them. Every journey here creates its own throwaway
 * account, proves it is a throwaway BEFORE the destructive step, and declares
 * how to clean it up.
 *
 * ── What this module does NOT do, stated first because it shapes everything ─
 *
 * It PLANS. It never signs in, never clicks, never deletes. It takes facts
 * about an enumerated application and returns, for each flow, either a journey
 * or a recorded reason there is none. That matters for three reasons:
 *
 *   1. Disposability is proved at PLAN time, so a journey aimed at the
 *      customer's own account is never written down at all — it does not reach
 *      a database, an approval screen, or a runner that might be careless.
 *   2. The whole module is pure, so all fourteen flows and every refusal path
 *      are testable in milliseconds with no browser and no network. 629 lines
 *      of crawler.ts had almost no tests for exactly the opposite reason.
 *   3. "We could not test logout, and here is what we need" is a deliverable.
 *      A refusal is a VALUE here, never a throw and never a skipped test,
 *      because a destructive scenario that silently declines to run is
 *      indistinguishable from one that ran and found nothing.
 *
 * The one piece of real I/O the lifecycle needs — reading a verification link
 * or a reset token out of a delivered message — is {@link awaitOutOfBandMessage},
 * which takes its mailbox and its clock as injected interfaces. No `fetch`
 * import, no Playwright `Page`, no ambient clock.
 *
 * ── Disposability: why this module cannot prove it itself ───────────────────
 *
 * `proveDisposable` in packages/shared/src/principals.ts is the one check that
 * protects the customer's account, and it is deliberately NOT re-implemented
 * here. {@link enumerateAuthLifecycle} takes a {@link DisposabilityProver} as
 * an argument and has NO DEFAULT, so there is exactly one implementation of
 * that check in the repository. Two implementations that could disagree about
 * which account may be destroyed is the worst defect this file could contain,
 * and a default parameter is how the second one gets written.
 *
 * The signature is structural, so the keystone's real `proveDisposable` is the
 * adapter and nothing needs writing:
 *
 *   enumerateAuthLifecycle(ctx, proveDisposable)
 *
 * — no wrapper and no closure, because {@link DisposabilityProver} takes the
 * run's default principal name as its second argument exactly as
 * `proveDisposable` does. That is deliberate: a prover the caller has to
 * remember to close over the default name is a prover somebody eventually
 * calls without it, and the thing that argument stops is the shared account
 * being copied into a principal and labelled DISPOSABLE.
 *
 * Honest about what the compiler buys here: {@link DisposableTarget} is a
 * structural type, so an object literal carrying a hand-written `disposability`
 * field satisfies it, where the keystone's branded `DestructiblePrincipal`
 * cannot be forged at all. What it buys is that a bare principal is NOT
 * assignable — `planAuthLifecycleFlow(flow, somePrincipal, ctx)` does not
 * compile — and that a forgery is one greppable line (`disposability:`
 * constructed outside a prover). Once principals.ts is on the shared barrel the
 * prover's own return type carries the brand through, and the forge closes with
 * no change to this file. See the note on {@link DisposableTarget}.
 *
 * ── Security, and it is the reason several things here look awkward ─────────
 *
 * No password, TOTP secret, OTP, reset token, session cookie, storageState or
 * bypass token appears in a journey, a step, an assertion, a title, an id, a
 * cleanup line or a log line — not truncated, not hashed, not in an error path.
 * Three mechanisms, because one would be a comment:
 *
 *   · {@link AuthLifecycleContext} HAS NO FIELD A CREDENTIAL COULD OCCUPY. A
 *     credential is named, never carried: the run seed plus a scope derives the
 *     value at execution time, so the journey records the SCOPE and the runner
 *     re-derives. That is also what makes a journey reproducible, so the two
 *     requirements turn out to be the same requirement.
 *   · {@link OutOfBandValue} holds the one unavoidable secret — the code or
 *     token out of a delivered message — in a CLOSURE. It is not an own
 *     property, so it survives neither `JSON.stringify`, nor template
 *     interpolation, nor `Object.values`, nor a console log.
 *   · {@link lifecycleJourneyViolations} scans every string of a finished
 *     journey for credential shapes. A heuristic, and labelled as one: the
 *     structural guarantees above are the protection, and this is the belt.
 *
 * A CAPTCHA is never solved, evaded or worked around. The only acceptable
 * routes past one are the provider's documented test keys or a bypass the
 * customer issues on their own edge — `BOT_BYPASS_MODES` in auth-profiles.ts
 * already enumerates them — and when neither is configured the outcome is
 * UNREACHABLE_BEHIND_BOT_PROTECTION with `botProtectionRemedy`'s sentence
 * beside it.
 *
 * Lockout testing deliberately burns failed attempts against a real auth
 * system. {@link LOCKOUT_ATTEMPT_CEILING} bounds it, {@link AttemptBudget}
 * reports the bound as a count AND a reason, and the budget can only be built
 * from a {@link DisposableTarget} — so it cannot be aimed at a persistent
 * principal even by accident.
 */

import {
  AUTH_CAPABILITY_REMEDY,
  PRIORITIES,
  botProtectionRemedy,
  createSyntheticFactory,
  reachabilityFromPolicy,
} from '@qaai/shared';
import type {
  AuthCapability,
  BotBypassMode,
  BotProtectionProvider,
  CleanupObligation,
  Priority,
  SyntheticFactory,
  TestType,
} from '@qaai/shared';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The principal this module acts on, and the proof it may be damaged
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A principal, as this module needs to see one.
 *
 * Structurally the keystone's `Principal` from packages/shared/src/principals.ts
 * and deliberately not a second vocabulary: the field names, the `kind` union
 * and the `createdByScenario` rule are theirs.
 *
 * The barrel reason this restatement originally gave is GONE — index.ts:177
 * carries `export * from './principals'` — and the sentence is corrected rather
 * than left to mislead. What remains is the reason in {@link DisposableTarget}
 * below, which the barrel does not touch: `DisposabilityProof` is branded with
 * a MODULE-PRIVATE witness symbol that cannot be named from outside
 * packages/shared, so a structural type is still what a journey builder here
 * can take. Adopting the branded type is a real item and it is still owed; it
 * needs a prover in packages/shared, not an import line.
 *
 * NOTE WHAT IS ABSENT, as it is absent on the keystone's type and for the same
 * reason: no password, no TOTP secret, no OTP, no session cookie, no
 * storageState, no bypass token, no API key. A principal NAMES a credential by
 * pointing at an auth profile; the credential is resolved by the worker and
 * never enters a plan item, a generated test, a fixture or a log line.
 */
export interface LifecyclePrincipal {
  readonly name: string;
  readonly kind: 'PERSISTENT' | 'DISPOSABLE' | 'ANONYMOUS';
  readonly lifecycle: string;
  readonly role: string | null;
  readonly authProfileId: string | null;
  readonly tenant: { readonly id: string; readonly label: string | null } | null;
  /**
   * The scenario that created this actor. Required for disposability — see the
   * keystone's `proveDisposable`: "disposable" without a creator is a claim
   * nobody made.
   */
  readonly createdByScenario: string | null;
}

/**
 * Evidence that a principal was created by the scenario about to damage it.
 *
 * The three facts the keystone's `DisposabilityProof` carries, minus its
 * module-private witness symbol — which is exactly the part that cannot be
 * named from outside packages/shared. See {@link DisposableTarget}.
 */
export interface DisposabilityEvidence {
  readonly principalName: string;
  readonly createdByScenario: string;
  readonly tenantId: string | null;
}

/**
 * A principal a lifecycle journey may be written against. THE type every
 * journey builder in this file takes.
 *
 * A {@link LifecyclePrincipal} is not assignable to it: `kind` is narrowed to
 * `'DISPOSABLE'` and there is no `disposability` field on the wider type. So
 * `planAuthLifecycleFlow('LOGOUT', somePrincipal, ctx)` is a compile error and
 * the author has to route through a {@link DisposabilityProver} and handle its
 * refusal. The two `@ts-expect-error` assertions in auth-lifecycle.test.ts are
 * what keeps that true: a directive that stops erroring is itself an error, so
 * weakening this fails `tsc` rather than a review.
 *
 * The keystone's `DestructiblePrincipal` — `Principal<'DISPOSABLE'> & {
 * disposability: DisposabilityProof }` — is assignable to this, because its
 * proof carries these three fields plus a symbol key this type does not forbid.
 * That is the whole adoption plan: when principals.ts reaches the shared
 * barrel, a prover that returns the real branded type satisfies
 * {@link DisposabilityProver} unchanged, and the brand then travels with the
 * value through every function here.
 */
export type DisposableTarget = LifecyclePrincipal & {
  readonly kind: 'DISPOSABLE';
  readonly disposability: DisposabilityEvidence;
};

/**
 * The result of asking whether a principal may be damaged.
 *
 * Structurally the keystone's `DisposabilityResult`. `reason` is a `string` and
 * not a union on purpose: this module PRINTS it and never branches on it, and
 * narrowing it here would be a second declaration of a vocabulary
 * principals.ts owns — which would then drift from it silently.
 */
export type DisposabilityOutcome =
  | { readonly ok: true; readonly principal: DisposableTarget }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

/**
 * The injected check. `proveDisposable` from packages/shared/src/principals.ts
 * satisfies this signature as-is.
 *
 * REQUIRED, WITH NO DEFAULT, and that is the single most deliberate decision in
 * this file. A default would be a second implementation of the one check that
 * stands between a generated destructive journey and the customer's production
 * login. Two implementations that can disagree about which account may be
 * destroyed is not a maintenance concern; it is the failure this whole slice
 * was commissioned to prevent.
 */
export type DisposabilityProver = (
  candidate: LifecyclePrincipal,
  /**
   * The name the run files its SHARED session under.
   *
   * Second positional argument, matching `proveDisposable(candidate,
   * runDefaultName)` exactly, so the keystone's function IS the adapter and
   * nothing has to be written to bridge them. `enumerateAuthLifecycle` supplies
   * it from {@link AuthLifecycleContext.runDefaultPrincipalName}; a caller never
   * has to remember to.
   */
  runDefaultName: string,
) => DisposabilityOutcome;

// ─────────────────────────────────────────────────────────────────────────────
// 2. The flows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every authentication-lifecycle flow this module can plan.
 *
 * The three pairs that look redundant and are not:
 *
 *   · PASSWORD_RESET and PASSWORD_CHANGE. One is driven from OUTSIDE a session
 *     and proves a stranger holding a mailbox can take the account over
 *     legitimately; the other is driven from INSIDE one and proves the form
 *     re-authenticates. An application that gets one right and the other wrong
 *     is the ordinary case.
 *   · ACCOUNT_LOCKOUT and LOCKOUT_UNLOCK. Locking is a defence; being unable to
 *     unlock is a denial of service the customer inflicts on their own users,
 *     and it is a separate bug with a separate owner.
 *   · SESSION_EXPIRY and SESSION_REVOCATION. One is time passing, the other is
 *     a user asking. The keystone's `PrincipalLifecycle` separates SIGNED_OUT
 *     from SESSION_EXPIRED on exactly this argument.
 *
 * EMAIL_VERIFICATION is separate from SIGNUP because the interesting question
 * is not whether the mail arrives — it is whether the link is single-use, and
 * whether an unverified account can do anything.
 */
export const AUTH_LIFECYCLE_FLOWS = [
  'SIGNUP',
  'EMAIL_VERIFICATION',
  'LOGIN',
  'LOGOUT',
  'SESSION_EXPIRY',
  'SESSION_REVOCATION',
  'PASSWORD_RESET',
  'PASSWORD_CHANGE',
  'ACCOUNT_LOCKOUT',
  'LOCKOUT_UNLOCK',
  'MFA_ENROLMENT',
  'MFA_RECOVERY_CODE',
  'EMAIL_CHANGE',
  'ACCOUNT_DELETION',
] as const;
export type AuthLifecycleFlow = (typeof AUTH_LIFECYCLE_FLOWS)[number];

/**
 * The compile-time half of the parity guard.
 *
 * A `Record` keyed on the union cannot be written without naming every member,
 * and naming one that does not exist is an excess property. The run-time half
 * is in auth-lifecycle.test.ts, which compares this derived list against the
 * declared tuple — because a member added to the tuple and forgotten here, or
 * the reverse, is otherwise invisible.
 *
 * Two mechanisms rather than one because the class of defect is proven in this
 * repository: eight `GateRule` kinds shipped UNSAVEABLE for two slices, present
 * in the union and absent from the write path, and `check:wiring` cannot see it
 * — a union member with no write path is live code in a file that is reached.
 */
const AUTH_LIFECYCLE_FLOW_PRESENT: Record<AuthLifecycleFlow, true> = {
  SIGNUP: true,
  EMAIL_VERIFICATION: true,
  LOGIN: true,
  LOGOUT: true,
  SESSION_EXPIRY: true,
  SESSION_REVOCATION: true,
  PASSWORD_RESET: true,
  PASSWORD_CHANGE: true,
  ACCOUNT_LOCKOUT: true,
  LOCKOUT_UNLOCK: true,
  MFA_ENROLMENT: true,
  MFA_RECOVERY_CODE: true,
  EMAIL_CHANGE: true,
  ACCOUNT_DELETION: true,
};

/** Derived, never hand-listed. See the record above. */
export const AUTH_LIFECYCLE_FLOW_LIST = Object.keys(
  AUTH_LIFECYCLE_FLOW_PRESENT,
) as ReadonlyArray<AuthLifecycleFlow>;

/**
 * The surfaces a lifecycle flow needs the enumeration to have FOUND.
 *
 * Not routes: a sign-out control is usually a button in a menu with no path at
 * all, which is why `crawl/interact.ts` records it as UNEXERCISABLE with no
 * rule to quote. A surface here is "the application has somewhere to do this",
 * however it is reached.
 */
export const LIFECYCLE_SURFACES = [
  'SIGNUP_FORM',
  'LOGIN_FORM',
  'LOGOUT_CONTROL',
  'PASSWORD_RESET_REQUEST',
  'PASSWORD_CHANGE_FORM',
  'SESSION_MANAGEMENT',
  'MFA_ENROLMENT',
  'EMAIL_CHANGE_FORM',
  'ACCOUNT_DELETION',
] as const;
export type LifecycleSurface = (typeof LIFECYCLE_SURFACES)[number];

/** Compile-time half of the parity guard. */
const LIFECYCLE_SURFACE_PRESENT: Record<LifecycleSurface, true> = {
  SIGNUP_FORM: true,
  LOGIN_FORM: true,
  LOGOUT_CONTROL: true,
  PASSWORD_RESET_REQUEST: true,
  PASSWORD_CHANGE_FORM: true,
  SESSION_MANAGEMENT: true,
  MFA_ENROLMENT: true,
  EMAIL_CHANGE_FORM: true,
  ACCOUNT_DELETION: true,
};

/** Derived, never hand-listed. */
export const LIFECYCLE_SURFACE_LIST = Object.keys(
  LIFECYCLE_SURFACE_PRESENT,
) as ReadonlyArray<LifecycleSurface>;

/**
 * What the keystone calls this flow's destructive step, or null.
 *
 * The seven names are `DESTRUCTIVE_STEP_KINDS` from principals.ts, as string
 * literals rather than that union, for the barrel reason given on
 * {@link LifecyclePrincipal}. The run-time half of the guard is the test that
 * asserts every value used here is one of the seven.
 */
export type LifecycleDestructiveStep =
  | 'LOGOUT'
  | 'SESSION_EXPIRY'
  | 'PASSWORD_RESET'
  | 'EMAIL_CHANGE'
  | 'LOCKOUT'
  | 'ACCOUNT_DELETION'
  | 'REVOKE_ALL_SESSIONS';

/** The out-of-band artefacts a flow may have to read out of a delivered message. */
export const OUT_OF_BAND_KINDS = ['CODE', 'LINK'] as const;
export type OutOfBandKind = (typeof OUT_OF_BAND_KINDS)[number];

/**
 * Everything decided about a flow before any application is looked at.
 *
 * A `Record<AuthLifecycleFlow, …>` and not a lookup function, so a fifteenth
 * flow cannot join the union without someone deciding all nine of these — the
 * same argument `BOUNDARY_DESCRIPTORS` makes in boundaries.ts. The failure mode
 * a partial lookup produces is a flow that defaults to "needs nothing, destroys
 * nothing" and is therefore generated against the shared account.
 */
export interface LifecycleFlowDescriptor {
  /** The test name. Generic by construction: no address, no secret, no run id. */
  readonly title: string;
  /** Why this flow is worth a journey, in the words the plan item will carry. */
  readonly rationale: string;
  readonly priority: Priority;
  readonly testType: TestType;
  /** The keystone's name for the destructive step, or null when there is none. */
  readonly destructiveStep: LifecycleDestructiveStep | null;
  /** The surface the application must have, beyond the signup form every flow needs. */
  readonly requires: LifecycleSurface | null;
  /** True when the flow cannot complete without reading a delivered message. */
  readonly needsOutOfBandMessage: boolean;
  /** Capabilities beyond a browser and a mailbox. TOTP_CLOCK for the MFA flows. */
  readonly needsCapabilities: readonly AuthCapability[];
  /** True when the flow needs to know when a session stops being accepted. */
  readonly needsSessionLifetime: boolean;
  /** True when the flow needs a route only a signed-in principal is served. */
  readonly needsAuthenticatedRoute: boolean;
}

/**
 * Every flow, described. Nine decisions each, none of them defaulted.
 *
 * The three judgements worth arguing with, stated rather than buried:
 *
 *   · PASSWORD_CHANGE's destructive step is PASSWORD_RESET. The keystone has
 *     seven kinds and no PASSWORD_CHANGE among them, and the closest TRUE one
 *     is PASSWORD_RESET: both end with the stored credential no longer working,
 *     which is the fact that makes the step destructive. They remain separate
 *     FLOWS because one is driven from inside a session and one from outside.
 *     Recorded here rather than silently mapped, because a report that says
 *     "PASSWORD_RESET" about a change form is a small lie and small lies are
 *     the ones that survive.
 *   · The MFA flows have NO destructive step, and this is not an oversight.
 *     Enrolling a second factor does not end an identity; it changes what
 *     signing in requires. They still demand a disposable principal, for the
 *     reason given on {@link planAuthLifecycleFlow} — every flow here does.
 *   · SIGNUP's destructive step is null and its cleanup is not. Creating an
 *     account is the opposite of destroying one, and it is still the step that
 *     leaves a row in the customer's database.
 */
export const LIFECYCLE_FLOW_DESCRIPTORS: Record<AuthLifecycleFlow, LifecycleFlowDescriptor> = {
  SIGNUP: {
    title: 'Sign up for a new account',
    rationale:
      'Signup is the first thing a new customer does and the last thing anybody tests, because ' +
      'driving it needs an address nobody owns. It is also the only way this suite can obtain an ' +
      'account it is allowed to destroy, so every other lifecycle journey depends on it working.',
    priority: 'CRITICAL_PATH',
    testType: 'E2E',
    destructiveStep: null,
    requires: 'SIGNUP_FORM',
    needsOutOfBandMessage: false,
    needsCapabilities: [],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: false,
  },
  EMAIL_VERIFICATION: {
    title: 'Verify a new address, and fail to verify it twice',
    rationale:
      'The interesting question is not whether the mail arrives. It is whether the link is ' +
      'single-use: a verification token that still works on the second visit is a token an ' +
      'attacker who reads one old email can replay.',
    priority: 'CRITICAL_PATH',
    testType: 'EMAIL_OTP',
    destructiveStep: null,
    requires: 'SIGNUP_FORM',
    needsOutOfBandMessage: true,
    needsCapabilities: ['MAILBOX_POLL'],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: false,
  },
  LOGIN: {
    title: 'Sign in, after being refused once',
    rationale:
      'A login test that only tries the correct password checks half the door. The refusal is ' +
      'where the bugs are: a message that reveals whether the address is registered, and a ' +
      'failed attempt that leaves the account unusable.',
    priority: 'CRITICAL_PATH',
    testType: 'E2E',
    destructiveStep: null,
    requires: 'LOGIN_FORM',
    needsOutOfBandMessage: false,
    needsCapabilities: [],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: true,
  },
  LOGOUT: {
    title: 'Sign out, and stay signed out through the back button',
    rationale:
      'Skip-listed in every crawl this product has ever run, so it has never been driven once. ' +
      'The back button is the half that fails: an authenticated page served from cache after ' +
      'sign-out is a real disclosure on a shared computer.',
    priority: 'CRITICAL_PATH',
    testType: 'E2E',
    destructiveStep: 'LOGOUT',
    requires: 'LOGOUT_CONTROL',
    needsOutOfBandMessage: false,
    needsCapabilities: [],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: true,
  },
  SESSION_EXPIRY: {
    title: 'Let a session expire, and be asked to sign in again',
    rationale:
      'Nobody asked for this one, which is why it breaks. An application that handles a ' +
      'deliberate sign-out and not an expired cookie serves a half-rendered page or a 500 to ' +
      'every user who left a tab open.',
    priority: 'IMPORTANT',
    testType: 'E2E',
    destructiveStep: 'SESSION_EXPIRY',
    requires: 'LOGIN_FORM',
    needsOutOfBandMessage: false,
    needsCapabilities: [],
    needsSessionLifetime: true,
    needsAuthenticatedRoute: true,
  },
  SESSION_REVOCATION: {
    title: 'Revoke another session, from the one you are holding',
    rationale:
      '"Sign out everywhere" is the control a user reaches for after losing a laptop, and it is ' +
      'the one nobody can test with a single session. It needs two live sessions for the same ' +
      'principal, which was inexpressible before the run could hold more than one.',
    priority: 'IMPORTANT',
    testType: 'E2E',
    destructiveStep: 'REVOKE_ALL_SESSIONS',
    requires: 'SESSION_MANAGEMENT',
    needsOutOfBandMessage: false,
    needsCapabilities: [],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: true,
  },
  PASSWORD_RESET: {
    title: 'Reset a forgotten password end to end',
    rationale:
      'The full chain — request, message, link, set, sign in with the new one, be refused with ' +
      'the old one — because a reset that leaves the previous password working hands the account ' +
      'to whoever knew it, and nothing short of the whole chain can see that.',
    priority: 'CRITICAL_PATH',
    testType: 'EMAIL_OTP',
    destructiveStep: 'PASSWORD_RESET',
    requires: 'PASSWORD_RESET_REQUEST',
    needsOutOfBandMessage: true,
    needsCapabilities: ['MAILBOX_POLL'],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: false,
  },
  PASSWORD_CHANGE: {
    title: 'Change a password from inside the session',
    rationale:
      'A change form that does not ask for the current password lets anyone who borrows an ' +
      'unlocked browser take the account permanently. The wrong-current-password attempt is the ' +
      'point of the journey, not a nicety.',
    priority: 'CRITICAL_PATH',
    testType: 'E2E',
    destructiveStep: 'PASSWORD_RESET',
    requires: 'PASSWORD_CHANGE_FORM',
    needsOutOfBandMessage: false,
    needsCapabilities: [],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: false,
  },
  ACCOUNT_LOCKOUT: {
    title: 'Lock an account out with repeated failures',
    rationale:
      'The only brake on credential stuffing, and the only flow whose test deliberately burns ' +
      'failed attempts against a live auth system. Bounded and disclosed; aimed only at an ' +
      'account this journey created seconds earlier.',
    priority: 'IMPORTANT',
    testType: 'SECURITY_SMOKE',
    destructiveStep: 'LOCKOUT',
    requires: 'LOGIN_FORM',
    needsOutOfBandMessage: false,
    needsCapabilities: [],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: false,
  },
  LOCKOUT_UNLOCK: {
    title: 'Get back in after a lockout',
    rationale:
      'A lock nobody can undo is a denial of service the customer inflicts on their own users, ' +
      'and it is a different bug with a different owner from the lock itself. It also checks the ' +
      'failure counter actually resets, rather than re-locking on the next typo.',
    priority: 'IMPORTANT',
    testType: 'EMAIL_OTP',
    destructiveStep: 'LOCKOUT',
    requires: 'PASSWORD_RESET_REQUEST',
    needsOutOfBandMessage: true,
    needsCapabilities: ['MAILBOX_POLL'],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: false,
  },
  MFA_ENROLMENT: {
    title: 'Enrol a second factor, and need it afterwards',
    rationale:
      'The bug is not in the enrolment screen; it is in whether enrolment takes effect. A ' +
      'second factor that is recorded as active while the password alone still signs in is ' +
      'worse than none, because the user believes they are protected.',
    priority: 'IMPORTANT',
    testType: 'SECURITY_SMOKE',
    destructiveStep: null,
    requires: 'MFA_ENROLMENT',
    needsOutOfBandMessage: false,
    needsCapabilities: ['TOTP_CLOCK'],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: false,
  },
  MFA_RECOVERY_CODE: {
    title: 'Use a recovery code once, and only once',
    rationale:
      'Recovery codes are the back door the user is told to keep. One that works twice is a ' +
      'permanent bypass of the second factor, and a count that does not decrease means nobody ' +
      'can tell how many are left.',
    priority: 'IMPORTANT',
    testType: 'SECURITY_SMOKE',
    destructiveStep: null,
    requires: 'MFA_ENROLMENT',
    needsOutOfBandMessage: false,
    needsCapabilities: ['TOTP_CLOCK'],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: false,
  },
  EMAIL_CHANGE: {
    title: 'Change the address, and confirm it before it counts',
    rationale:
      'An address change that takes effect before the new mailbox confirms it is an account ' +
      'takeover: type a victim\'s address, and their reset links arrive at your inbox. The ' +
      'journey checks the old address still works until confirmation and not after.',
    priority: 'CRITICAL_PATH',
    testType: 'EMAIL_OTP',
    destructiveStep: 'EMAIL_CHANGE',
    requires: 'EMAIL_CHANGE_FORM',
    needsOutOfBandMessage: true,
    needsCapabilities: ['MAILBOX_POLL'],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: false,
  },
  ACCOUNT_DELETION: {
    title: 'Delete the account, and find the session dead with it',
    rationale:
      'The flow no suite can run without an account it may lose. The defect it looks for is a ' +
      'session that outlives the account it belongs to, which means a deleted user can keep ' +
      'reading their old data until a cookie expires.',
    priority: 'IMPORTANT',
    testType: 'E2E',
    destructiveStep: 'ACCOUNT_DELETION',
    requires: 'ACCOUNT_DELETION',
    needsOutOfBandMessage: false,
    needsCapabilities: [],
    needsSessionLifetime: false,
    needsAuthenticatedRoute: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Outcomes: a journey, or a recorded reason there is none
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What came of asking for a flow.
 *
 * Only ONE member is a journey. Eight are absences, and every one of them
 * carries a remedy, because the alternatives are all on the list of lies this
 * product cannot afford: a REFUSED surface recorded like one that does not
 * exist, a pass that means "we did not check", a null that became a zero.
 *
 * The distinction between the REFUSED member and the seven UNREACHABLE ones is
 * whose problem it is. REFUSED_NOT_DISPOSABLE is OUR rule declining to act and
 * says nothing at all about the application. The UNREACHABLE members name a
 * prerequisite the customer controls and can supply. SUPPRESSED_SELF_AUDIT is
 * neither: it is a bug in THIS module, surfaced instead of swallowed, because a
 * failure suppressed without being counted is the same lie wearing a hat.
 */
export const AUTH_LIFECYCLE_OUTCOMES = [
  /** A journey was produced. */
  'GENERATED',
  /** The injected prover said the principal may not be damaged. Our rule, not their bug. */
  'REFUSED_NOT_DISPOSABLE',
  /** Nothing in this application can create a throwaway account, so no flow can run. */
  'UNREACHABLE_NO_DISPOSABLE_PRINCIPAL',
  /** A challenge stands in front of signup and no legitimate route past it is configured. */
  'UNREACHABLE_BEHIND_BOT_PROTECTION',
  /** The flow needs a delivered message and there is nowhere to read one. */
  'UNREACHABLE_NO_MAIL_SINK',
  /** The flow needs a capability this run does not have — a TOTP clock, usually. */
  'UNREACHABLE_MISSING_CAPABILITY',
  /** The flow needs to know when a session stops being accepted, and nobody said. */
  'UNREACHABLE_NO_USABLE_SESSION_LIFETIME',
  /** The enumeration never found the page or control this flow acts on. */
  'UNREACHABLE_SURFACE_NOT_ENUMERATED',
  /** This module built a journey and its own audit rejected it. OUR bug, counted. */
  'SUPPRESSED_SELF_AUDIT',
] as const;
export type AuthLifecycleOutcome = (typeof AUTH_LIFECYCLE_OUTCOMES)[number];

/** Compile-time half of the parity guard. */
const AUTH_LIFECYCLE_OUTCOME_PRESENT: Record<AuthLifecycleOutcome, true> = {
  GENERATED: true,
  REFUSED_NOT_DISPOSABLE: true,
  UNREACHABLE_NO_DISPOSABLE_PRINCIPAL: true,
  UNREACHABLE_BEHIND_BOT_PROTECTION: true,
  UNREACHABLE_NO_MAIL_SINK: true,
  UNREACHABLE_MISSING_CAPABILITY: true,
  UNREACHABLE_NO_USABLE_SESSION_LIFETIME: true,
  UNREACHABLE_SURFACE_NOT_ENUMERATED: true,
  SUPPRESSED_SELF_AUDIT: true,
};

/** Derived, never hand-listed. */
export const AUTH_LIFECYCLE_OUTCOME_LIST = Object.keys(
  AUTH_LIFECYCLE_OUTCOME_PRESENT,
) as ReadonlyArray<AuthLifecycleOutcome>;

/**
 * Outcomes in which NOTHING WAS MEASURED.
 *
 * Derived by exclusion, so a tenth outcome counts as measured only if somebody
 * decides it does, instead of defaulting into the measured set because they did
 * not know this line existed. THE RULE THIS SERVES: a flow whose outcome is in
 * here reports UNAVAILABLE or REFUSED, never PASS and never a count of zero.
 */
export const UNMEASURED_AUTH_LIFECYCLE_OUTCOMES: ReadonlyArray<AuthLifecycleOutcome> =
  AUTH_LIFECYCLE_OUTCOME_LIST.filter((outcome) => outcome !== 'GENERATED');

/** The deliverable: the flow, and either its journey or why there is none. */
export type AuthLifecycleResult =
  | {
      readonly flow: AuthLifecycleFlow;
      readonly outcome: 'GENERATED';
      readonly journey: AuthLifecycleJourney;
    }
  | {
      readonly flow: AuthLifecycleFlow;
      readonly outcome: Exclude<AuthLifecycleOutcome, 'GENERATED'>;
      /** The fact that stopped it, in one sentence. Never a secret. */
      readonly detail: string;
      /** What the customer (or we) must do. Always present on an absence. */
      readonly remedy: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// 4. The journey
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One step. `session` is here because SESSION_REVOCATION needs two live
 * sessions for the SAME principal, and a step that only names the principal
 * cannot say which of the two it acts in — which is precisely the flow that
 * could not be written before.
 */
export interface AuthLifecycleStep {
  readonly index: number;
  /** The principal name this step acts as. */
  readonly as: string;
  /** Which session of that principal. {@link PRIMARY_SESSION} unless stated. */
  readonly session: string;
  /** Imperative, plain English. The Generator turns these into code. */
  readonly action: string;
  /** True for the step that ends or alters the identity. */
  readonly destructive: boolean;
  /** Set when the step cannot proceed without reading a delivered message. */
  readonly outOfBand: OutOfBandKind | null;
}

/** The default session label. Two constants rather than two bare strings. */
export const PRIMARY_SESSION = 'primary';
/** The second live session of the same principal, for the revocation flow. */
export const SECONDARY_SESSION = 'secondary';

/**
 * What using this journey obliges the suite to clean up.
 *
 * `satisfiedByFlow` is the member that stops a lie. ACCOUNT_DELETION's cleanup
 * IS the flow, and recording it as an outstanding obligation would have the
 * suite try to delete an account it already deleted and report the failure as a
 * defect in the application.
 */
export interface AuthLifecycleCleanup {
  /** `CLEANUP_OBLIGATIONS` from synthetic.ts, which already names these five. */
  readonly obligation: CleanupObligation;
  /** The principal the obligation is about. */
  readonly ownedBy: string;
  /** What to do, in one imperative sentence. */
  readonly action: string;
  /** True when completing the flow discharges the obligation. */
  readonly satisfiedByFlow: boolean;
}

/**
 * The bound on failed attempts a journey will burn, and the disclosure that
 * goes with it.
 *
 * Every field is required and `capReason` is non-null exactly when `capped` is
 * true, so a reader can never see a bound with no reason beside it. That is the
 * product's own rule about caps — "every budget, take, limit and timeout that
 * BIT must be reported as a count AND a reason" — applied to the one budget
 * here that is spent on the customer's live auth system rather than on our own
 * compute.
 */
export interface AttemptBudget {
  /** Failed attempts this journey will actually burn. */
  readonly attempts: number;
  /** The lockout threshold the customer declared, or null when nobody said. */
  readonly declaredThreshold: number | null;
  /** The ceiling in force. */
  readonly ceiling: number;
  /** True when the ceiling, not the declared threshold, decided `attempts`. */
  readonly capped: boolean;
  /** Why the ceiling bit. Non-null exactly when `capped`. */
  readonly capReason: string | null;
}

/**
 * A planned lifecycle journey.
 *
 * `syntheticScope` is the field that makes this both reproducible and safe, and
 * the two turn out to be one property. The journey records the SCOPE a value is
 * derived from, never the value: the runner calls
 * `createSyntheticFactory({ seed, scope })` and gets the same password this
 * plan intended, byte for byte, in every process and forever — and the password
 * itself never enters the plan, the database, the approval screen or a log.
 */
export interface AuthLifecycleJourney {
  /** Deterministic in (runSeed, flow). Carries no secret and no clock. */
  readonly id: string;
  readonly flow: AuthLifecycleFlow;
  readonly title: string;
  readonly rationale: string;
  readonly priority: Priority;
  readonly testType: TestType;
  /** The actors. Exactly one today; the shape is a list because two-actor flows exist. */
  readonly principals: readonly DisposableTarget[];
  readonly steps: readonly AuthLifecycleStep[];
  /** Meaning-level, never pixels. At least one, always. */
  readonly assertions: readonly string[];
  /** At least one, always: a journey that creates an account and declares no cleanup fills a database. */
  readonly cleanup: readonly AuthLifecycleCleanup[];
  /** The keystone's name for the destructive step, or null. */
  readonly destructiveStep: LifecycleDestructiveStep | null;
  /** The failed-attempt bound, or null for a flow that burns none. */
  readonly attemptBudget: AttemptBudget | null;
  /**
   * The ONE condition under which this journey's result is UNKNOWN rather than
   * PASS or FAIL, or null when there is none.
   *
   * This is the field that stops "a pass that means we did not check". A
   * lockout journey that reaches its bound without the account locking has not
   * found a bug and has not proved anything; without somewhere to say so, the
   * only available report is a green tick.
   */
  readonly inconclusiveIf: string | null;
  /** The scope the runner re-derives this journey's synthetic values from. */
  readonly syntheticScope: string;
  /**
   * The address this journey's messages are delivered to, or null when it reads
   * none.
   *
   * An identifier, not a credential: it is a synthetic address at a reserved
   * domain, generated from the run seed, and carrying it is what lets a stray
   * row in a staging database be traced back to the run that made it.
   */
  readonly recipient: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The input, which has no field a credential could occupy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a delivered message can be read.
 *
 * Structurally what `packages/runner/src/plugins/email-otp.ts` already demands
 * — it builds `mailboxUrl?to=<recipient>` and reads `{ messages: [...] }` — and
 * named as a config rather than re-derived there, because that plugin has the
 * contract and no type for it. The needsFromOtherFiles entry adopts this one.
 *
 * `endpoint` is a URL and is NOT secret-bearing: a mail catcher that needs a
 * credential supplies it through the environment's `extraHeaders`, whose
 * secret-bearing names are already refused as literals by
 * `environmentExtraHeaderSchema`.
 */
export interface MailSinkConfig {
  /** Absolute, or relative to the environment base URL. For the report. */
  readonly endpoint: string;
  /**
   * The domain generated addresses are minted under.
   *
   * Null means "use the reserved default" — `SYNTHETIC_EMAIL_DOMAIN`, which is
   * `example.com` and is reserved by RFC 2606 precisely so that a test cannot
   * mail a stranger.
   */
  readonly recipientDomain: string | null;
}

/** The bot-protection half of the environment's access row, as this module reads it. */
export interface LifecycleBotProtection {
  readonly provider: BotProtectionProvider;
  readonly bypassMode: BotBypassMode;
}

/**
 * Everything this module needs to know, and nothing it must not.
 *
 * THERE IS NO FIELD HERE A CREDENTIAL COULD OCCUPY. No password, no TOTP
 * secret, no OTP, no reset token, no session cookie, no storageState, no bypass
 * token, no API key. A credential is NAMED — by `authProfileId` on a principal,
 * or by a `Secret.name` reference on the auth profile — and resolved by the
 * worker at execution time. The test asserts this with `@ts-expect-error` on an
 * object literal carrying each of those names, so adding one of them to this
 * interface turns a passing test into a compile error.
 *
 * Every field is required. An optional field here would be a silent default,
 * and the defaults that matter are all unsafe in the same direction: an absent
 * `botProtection` read as "nothing in the way" or an absent
 * `sessionLifetimeSeconds` read as "never expires" produces a journey that
 * cannot work and a report that says it can. `limits` is the one exception and
 * it only tightens.
 */
export interface AuthLifecycleContext {
  /**
   * The run seed. Everything generated is a pure function of it.
   *
   * The same seed gives the same journey ids, the same principal names and the
   * same synthetic values forever — that is replay, and it is the point. A
   * fresh run passes a fresh seed and gets a fresh account, which is what lets
   * a signup journey run twice.
   */
  readonly runSeed: string;
  /**
   * The name the run files its SHARED session under.
   *
   * Required, with no default, and the reason is the keystone's own: two
   * sources of truth about the one name every session lookup keys on is how a
   * journey comes to be aimed at the customer's account under another label.
   *
   * {@link enumerateAuthLifecycle} passes it to the prover on every call. This
   * module never compares against it itself, because the comparison belongs in
   * the one function that is allowed to decide disposability — and a second
   * check here would be the start of the second implementation this file is
   * organised to avoid.
   */
  readonly runDefaultPrincipalName: string;
  /** Prefixes the scenario name recorded as each principal's creator. */
  readonly scenarioPrefix: string;
  /** The lifecycle surfaces the enumeration actually found. */
  readonly observedSurfaces: readonly LifecycleSurface[];
  /**
   * A route only a signed-in principal is served, or null.
   *
   * Null is a real and consequential answer: without one there is nothing to
   * re-request after a session ends, so LOGOUT, SESSION_EXPIRY,
   * SESSION_REVOCATION and ACCOUNT_DELETION would assert the absence of a page
   * we never found — which passes whether or not the session survived.
   */
  readonly authenticatedRoute: string | null;
  /**
   * True when the signup form exists but needs an invite we have no source for.
   *
   * Separate from the surface being absent because the remedies differ: one
   * needs a signup page, the other needs an invite endpoint or a seeded code.
   */
  readonly signupInviteOnly: boolean;
  /** Where delivered messages can be read, or null. */
  readonly mailSink: MailSinkConfig | null;
  /** What this run can do. `AUTH_CAPABILITIES` from auth-profiles.ts. */
  readonly capabilities: readonly AuthCapability[];
  /** What stands in front of the signup and login forms. */
  readonly botProtection: LifecycleBotProtection;
  /**
   * How long a session is accepted for, in seconds, or null.
   *
   * NULL IS "NOBODY TOLD US", NOT "NEVER EXPIRES" — the keystone says exactly
   * this on `PrincipalSession.expiresAtIso`. A journey that reads null as never
   * waits forever; one that reads it as unknown reports UNAVAILABLE and names
   * the missing fact.
   */
  readonly sessionLifetimeSeconds: number | null;
  /**
   * The failed-attempt threshold the customer declared, or null.
   *
   * Null does not block the lockout journey — it makes its negative result
   * INCONCLUSIVE rather than a pass. See {@link AuthLifecycleJourney.inconclusiveIf}.
   */
  readonly declaredLockoutThreshold: number | null;
  /** The tenant new principals belong to, or null when the application has no tenancy. */
  readonly tenant: { readonly id: string; readonly label: string | null } | null;
  /** Ceilings. Present to be tightened; the defaults are the safe ones. */
  readonly limits?: {
    readonly lockoutAttemptCeiling?: number;
    readonly sessionWaitCeilingSeconds?: number;
  };
}

/**
 * The most failed sign-ins any journey here will ever burn.
 *
 * EIGHT, and the number is a judgement two ways. High enough to trip the
 * common thresholds — three and five are what frameworks ship — with headroom
 * for an application that counts per-window rather than per-account. Low enough
 * that it cannot be mistaken for credential stuffing by the customer's own
 * monitoring, which would be a real cost we imposed on them without asking.
 *
 * It is also spent against an account this journey created seconds earlier and
 * will delete, so the thing being locked out is our own throwaway. That is why
 * {@link attemptBudgetFor} takes a {@link DisposableTarget}: the bound can be
 * loosened by a caller, and it still cannot be aimed at a persistent principal.
 */
export const LOCKOUT_ATTEMPT_CEILING = 8;

/**
 * The longest a journey may wait for a session to expire, in seconds.
 *
 * TWO MINUTES. A thirty-minute session cannot be waited out by a test suite,
 * and pretending otherwise produces either a suite nobody runs or a sleep
 * somebody deletes. Beyond this the honest outcome is
 * UNREACHABLE_NO_USABLE_SESSION_LIFETIME with the remedy that actually works:
 * expire the session server-side, or declare a short-lived session for the test
 * environment.
 */
export const SESSION_WAIT_CEILING_SECONDS = 120;

// ─────────────────────────────────────────────────────────────────────────────
// 6. Planning one flow
// ─────────────────────────────────────────────────────────────────────────────

/** The remedy for an absence, in one place so the sentence cannot drift. */
const REMEDY: Record<Exclude<AuthLifecycleOutcome, 'GENERATED'>, string> = {
  REFUSED_NOT_DISPOSABLE:
    'Every flow here destroys or alters an identity, so it runs only against an account the ' +
    'journey itself created. Let this environment accept a signup and each journey will make its ' +
    'own, use it, and delete it.',
  UNREACHABLE_NO_DISPOSABLE_PRINCIPAL:
    'Expose a self-serve signup on this non-production environment, or give us an endpoint that ' +
    'mints an invite, so each lifecycle journey can create and destroy its own account. Until ' +
    'then none of these fourteen flows can be driven, because the only account available is the ' +
    'one every other test needs.',
  /*
   * These two are OVERRIDDEN at every call site with a provider-specific or
   * capability-specific sentence — `botProtectionRemedy` and
   * `AUTH_CAPABILITY_REMEDY` already write the good ones. The text here is a
   * real fallback and not an empty string, because an empty remedy renders as a
   * blank line under "what to do about it", which reads as "nothing can be
   * done" rather than as a missing sentence. An earlier draft left them `''`
   * for exactly as long as it took to notice that.
   */
  UNREACHABLE_BEHIND_BOT_PROTECTION:
    'A bot defence stands in front of this environment\'s signup and login forms. Configure this ' +
    'NON-PRODUCTION environment with the provider\'s documented test keys, allowlist QAAI at your ' +
    'edge, or issue a signed bypass header and store its value in the vault. The challenge is ' +
    'never solved, evaded or worked around.',
  UNREACHABLE_NO_MAIL_SINK: AUTH_CAPABILITY_REMEDY.MAILBOX_POLL,
  UNREACHABLE_MISSING_CAPABILITY:
    'This flow needs a capability this run does not have. The specific remedy is on the result; ' +
    'AUTH_CAPABILITY_REMEDY in auth-profiles.ts names what to do for each one.',
  UNREACHABLE_NO_USABLE_SESSION_LIFETIME:
    'Declare how long a session is accepted for on this environment, and make it short enough ' +
    `for a test to outlast — at most ${SESSION_WAIT_CEILING_SECONDS}s — or expose a way to ` +
    'expire one server-side. A session lifetime nobody stated cannot be waited out, and guessing ' +
    'at it produces a test that hangs rather than one that fails.',
  UNREACHABLE_SURFACE_NOT_ENUMERATED:
    'The enumeration never found this page or control. Point us at it — a route, or a crawl that ' +
    'reaches it signed in — and the journey becomes drivable. It is recorded as not found rather ' +
    'than as absent, because a surface we could not reach and one the application does not have ' +
    'are opposite facts.',
  SUPPRESSED_SELF_AUDIT:
    'This is a defect in QAAI, not in your application. The journey was built and then rejected ' +
    'by this module\'s own audit, so it was not stored. The violations are in the detail; please ' +
    'send them to us.',
};

/**
 * Plan one flow against one already-proven target.
 *
 * `target` is a {@link DisposableTarget}, so a {@link LifecyclePrincipal} does
 * not compile here. That is the whole safety mechanism: the proving happens
 * once, at the caller, in the one function in the repository that is allowed to
 * do it, and this function cannot be reached without it.
 *
 * EVERY flow requires a disposable target, including the ones with no
 * destructive step. That is stricter than it has to be and it is deliberate.
 * MFA enrolment does not end an identity, but it changes what signing in
 * requires — enrol a second factor on the shared account and every other test
 * in the suite stops being able to log in, which is indistinguishable from
 * having deleted it. A login journey that burns a failed attempt can trip a
 * lockout on the shared account and do the same. There is no flow here whose
 * worst case against the customer's own login is acceptable, so there is no
 * flow here that may be aimed at it.
 *
 * Pure: no clock, no randomness, no I/O. The same arguments give the same
 * result in every process, forever.
 */
export function planAuthLifecycleFlow(
  flow: AuthLifecycleFlow,
  target: DisposableTarget,
  ctx: AuthLifecycleContext,
): AuthLifecycleResult {
  const descriptor = LIFECYCLE_FLOW_DESCRIPTORS[flow];

  const absent = (
    outcome: Exclude<AuthLifecycleOutcome, 'GENERATED'>,
    detail: string,
    remedy?: string,
  ): AuthLifecycleResult => ({ flow, outcome, detail, remedy: remedy ?? REMEDY[outcome] });

  /*
   * ORDER OF CHECKS, and it is chosen so the reader sees the most specific true
   * reason rather than the first one the code happened to reach.
   *
   * Bot protection comes before the surface check because a challenge on the
   * door EXPLAINS a missing surface: reporting "we never found your signup
   * form" to a customer whose WAF refused every one of our requests sends them
   * to look at the wrong thing. The signup form is checked before the flow's
   * own surface for the same reason — without a signup there is no principal,
   * so the flow's own page being absent is not yet the interesting fact.
   */
  const challenge = reachabilityFromPolicy(ctx.botProtection);
  if (challenge.reachability === 'UNREACHABLE_BEHIND_BOT_PROTECTION') {
    return absent(
      'UNREACHABLE_BEHIND_BOT_PROTECTION',
      `a ${ctx.botProtection.provider} challenge stands in front of this application's signup ` +
        'and login forms, and no documented test key, customer allowlist or signed bypass header ' +
        'is configured for this environment — so no account this suite is allowed to destroy can ' +
        'be created. The challenge was not solved, evaded or worked around.',
      challenge.remedy ?? botProtectionRemedy(ctx.botProtection.provider),
    );
  }

  if (!ctx.observedSurfaces.includes('SIGNUP_FORM')) {
    return absent(
      'UNREACHABLE_NO_DISPOSABLE_PRINCIPAL',
      'the enumeration found no signup form, so this suite has no way to create an account it ' +
        'is allowed to destroy, and every flow in this group needs one.',
    );
  }

  if (ctx.signupInviteOnly) {
    return absent(
      'UNREACHABLE_NO_DISPOSABLE_PRINCIPAL',
      'signup on this environment needs an invitation, and nothing configured here can mint ' +
        'one — so the journey cannot create the throwaway account it would then destroy.',
    );
  }

  if (descriptor.requires !== null && !ctx.observedSurfaces.includes(descriptor.requires)) {
    return absent(
      'UNREACHABLE_SURFACE_NOT_ENUMERATED',
      `this flow acts on the ${surfaceLabel(descriptor.requires)} and the enumeration never ` +
        'found one.',
    );
  }

  if (descriptor.needsAuthenticatedRoute && ctx.authenticatedRoute === null) {
    return absent(
      'UNREACHABLE_SURFACE_NOT_ENUMERATED',
      'no route that only a signed-in principal is served was enumerated, so there is nothing ' +
        'to re-request once the session ends — and a journey that asserts the absence of a page ' +
        'it never found passes whether the session survived or not.',
    );
  }

  if (descriptor.needsOutOfBandMessage && ctx.mailSink === null) {
    return absent(
      'UNREACHABLE_NO_MAIL_SINK',
      'this flow cannot complete without reading a message the application sends out of band, ' +
        'and no mail sink is configured for this environment.',
    );
  }

  /*
   * Capabilities, in the order `needsCapabilities` declares them, so the
   * sentence a customer reads names the first thing they have to fix rather
   * than whichever one a set iteration happened to yield.
   *
   * `authAdapterUnavailable` in auth-profiles.ts answers the same question for
   * an auth PROFILE; it keys on `AuthProfileKind`, and a lifecycle FLOW is not
   * a profile kind, so the lookup is here and the remedy sentences are theirs.
   */
  for (const capability of descriptor.needsCapabilities) {
    if (capability === 'MAILBOX_POLL' && ctx.mailSink !== null) {
      /*
       * A configured sink IS the mailbox capability. Treating them as two
       * independent facts produced a report that told a customer with a working
       * mail catcher to go and configure a mail catcher.
       */
      continue;
    }
    if (!ctx.capabilities.includes(capability)) {
      return absent(
        'UNREACHABLE_MISSING_CAPABILITY',
        `this flow needs the ${capability} capability and this run does not have it.`,
        AUTH_CAPABILITY_REMEDY[capability],
      );
    }
  }

  if (descriptor.needsSessionLifetime) {
    const ceiling = ctx.limits?.sessionWaitCeilingSeconds ?? SESSION_WAIT_CEILING_SECONDS;
    if (ctx.sessionLifetimeSeconds === null) {
      return absent(
        'UNREACHABLE_NO_USABLE_SESSION_LIFETIME',
        'nobody declared when a session stops being accepted on this environment, and an ' +
          'undeclared lifetime is "we were not told", not "never expires" — so this journey ' +
          'would either hang or assert against a number we invented.',
      );
    }
    if (ctx.sessionLifetimeSeconds > ceiling) {
      return absent(
        'UNREACHABLE_NO_USABLE_SESSION_LIFETIME',
        `the declared session lifetime of ${ctx.sessionLifetimeSeconds}s is longer than the ` +
          `${ceiling}s a journey may wait, so it cannot be outlasted in a test run.`,
      );
    }
  }

  const journey = buildJourney(flow, target, ctx);

  /*
   * MEASURE THE MEASURER. The audit runs on the way out, not only in the test
   * file, because the thing it guards against is a future edit to this file
   * putting a credential or a zero-assertion journey into a customer's
   * repository. Suppressing is the right answer; suppressing SILENTLY is not,
   * which is why this is an outcome with a count behind it rather than a
   * `return null`.
   */
  const violations = lifecycleJourneyViolations(journey);
  if (violations.length > 0) {
    return absent(
      'SUPPRESSED_SELF_AUDIT',
      `this module built a ${flow} journey that failed its own audit and did not store it: ` +
        violations.join('; '),
    );
  }

  return { flow, outcome: 'GENERATED', journey };
}

/** The surface, in the words a customer uses for it. Compiler-enforced. */
const SURFACE_LABELS: Record<LifecycleSurface, string> = {
  SIGNUP_FORM: 'signup form',
  LOGIN_FORM: 'login form',
  LOGOUT_CONTROL: 'sign-out control',
  PASSWORD_RESET_REQUEST: 'forgotten-password form',
  PASSWORD_CHANGE_FORM: 'change-password form',
  SESSION_MANAGEMENT: 'active-sessions screen',
  MFA_ENROLMENT: 'two-factor enrolment screen',
  EMAIL_CHANGE_FORM: 'change-email form',
  ACCOUNT_DELETION: 'delete-account control',
};

function surfaceLabel(surface: LifecycleSurface): string {
  return SURFACE_LABELS[surface];
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Planning the whole lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every flow, planned, with a principal of its own.
 *
 * ── Why a principal PER FLOW and not one for the group ─────────────────────
 *
 * Because the flows destroy things. A shared throwaway would mean the deletion
 * journey decides whether the logout journey can run, the lockout journey
 * decides whether the login journey can sign in, and the password-reset journey
 * changes the credential the MFA journey needs — so the ORDER of execution
 * would decide the results, and a suite whose results depend on its order is
 * the flake this product exists to eliminate. One account per journey costs
 * fourteen signups and buys fourteen independent answers.
 *
 * `prove` is required and has no default: see {@link DisposabilityProver}.
 *
 * DETERMINISTIC. No clock, no randomness, no ambient state. Call it twice with
 * the same context and the results are byte-identical, which the test asserts
 * by deep-comparing two runs.
 */
export function enumerateAuthLifecycle(
  ctx: AuthLifecycleContext,
  prove: DisposabilityProver,
): AuthLifecycleEnumeration {
  const results: AuthLifecycleResult[] = [];

  for (const flow of AUTH_LIFECYCLE_FLOWS) {
    const candidate = lifecyclePrincipalFor(flow, ctx);
    const proof = prove(candidate, ctx.runDefaultPrincipalName);
    if (!proof.ok) {
      /*
       * The prover declined. Recorded as a REFUSAL with the prover's own reason
       * and detail, and never as a skip: a destructive scenario that silently
       * declines to run reads exactly like one that ran and found nothing, and
       * that is the shape of lie this product cannot afford.
       */
      results.push({
        flow,
        outcome: 'REFUSED_NOT_DISPOSABLE',
        detail: `${proof.reason}: ${proof.detail}`,
        remedy: REMEDY.REFUSED_NOT_DISPOSABLE,
      });
      continue;
    }
    results.push(planAuthLifecycleFlow(flow, proof.principal, ctx));
  }

  const generated = results.filter((r) => r.outcome === 'GENERATED').length;
  return {
    results,
    considered: results.length,
    generated,
    /*
     * The parts sum to the whole, and the test asserts it. A count that does
     * not reconcile is how a flow comes to be dropped with no record — the
     * defect the whole enumeration-honesty section of flow-map.ts is about.
     */
    unmeasured: results.length - generated,
  };
}

/** Every flow's verdict, and an account of them that reconciles. */
export interface AuthLifecycleEnumeration {
  readonly results: readonly AuthLifecycleResult[];
  /** How many flows were considered. Always `AUTH_LIFECYCLE_FLOWS.length`. */
  readonly considered: number;
  readonly generated: number;
  /** Considered minus generated. Never a zero that means "we did not look". */
  readonly unmeasured: number;
}

/**
 * The throwaway principal a flow will create, as a DECLARED candidate.
 *
 * DECLARED and not ACTIVE: nothing has been created yet, and the keystone's
 * `PrincipalLifecycle` is explicit that a principal still waiting to be created
 * is a check that has not happened YET, which is a different fact from one that
 * could not happen.
 *
 * `createdByScenario` is set here, and it is the fact the prover checks. It is
 * true by construction: the journey this name belongs to performs the signup as
 * its first step. A principal whose creator is a scenario that does NOT create
 * it would pass the prover and be a lie, which is why step 0 of every journey
 * is the signup rather than an assumption that one happened.
 */
export function lifecyclePrincipalFor(
  flow: AuthLifecycleFlow,
  ctx: AuthLifecycleContext,
): LifecyclePrincipal {
  const scenario = scenarioNameFor(flow, ctx);
  return {
    name: principalNameFor(flow, ctx),
    kind: 'DISPOSABLE',
    lifecycle: 'DECLARED',
    role: null,
    /*
     * NULL, and that is correct rather than missing. The account does not exist
     * yet, so there is no auth profile to point at; the journey's own signup
     * step is what brings both into being. The keystone says the same on
     * `Principal.authProfileId`: null for a DISPOSABLE actor the scenario has
     * not created yet.
     */
    authProfileId: null,
    tenant: ctx.tenant,
    createdByScenario: scenario,
  };
}

/** The scenario that creates and owns this flow's principal. */
function scenarioNameFor(flow: AuthLifecycleFlow, ctx: AuthLifecycleContext): string {
  return `${ctx.scenarioPrefix}/${flow.toLowerCase().replace(/_/g, '-')}`;
}

/**
 * The principal's name — deterministic, greppable, and obviously ours.
 *
 * The `qaai-` prefix and the run token are both for the customer's benefit: a
 * row left behind in a staging database can be traced to the run and the flow
 * that made it, which is the same argument synthetic.ts makes for putting its
 * token inside generated addresses.
 */
function principalNameFor(flow: AuthLifecycleFlow, ctx: AuthLifecycleContext): string {
  return `qaai-${flow.toLowerCase().replace(/_/g, '-')}-${factoryFor(flow, ctx).token}`;
}

/**
 * The synthetic factory for one flow. The ONE place a scope is composed, so the
 * runner and this module cannot come to disagree about which values a journey
 * meant.
 */
function factoryFor(flow: AuthLifecycleFlow, ctx: AuthLifecycleContext): SyntheticFactory {
  return createSyntheticFactory({
    seed: ctx.runSeed,
    scope: syntheticScopeFor(flow),
    ...(ctx.mailSink?.recipientDomain
      ? { emailDomain: ctx.mailSink.recipientDomain }
      : {}),
  });
}

/** The scope string a journey records and the runner re-derives from. */
export function syntheticScopeFor(flow: AuthLifecycleFlow): string {
  return `auth-lifecycle/${flow.toLowerCase().replace(/_/g, '-')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. The attempt budget
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The failed-attempt bound for a journey, and its disclosure.
 *
 * Takes a {@link DisposableTarget} and does not use it. That is not an
 * oversight: it is what makes "a bound on failed sign-ins" impossible to
 * compute for a principal nobody proved disposable, which in turn makes it
 * impossible to AIM a lockout journey at the customer's account. The parameter
 * is the point; the body does not need it.
 *
 * When the customer declared a threshold we burn one attempt past it, because
 * the question is whether the lock fires AT the threshold. When they did not,
 * we burn the ceiling and the journey's result is inconclusive rather than a
 * pass — see {@link AuthLifecycleJourney.inconclusiveIf}.
 */
export function attemptBudgetFor(
  _target: DisposableTarget,
  declaredThreshold: number | null,
  ceiling: number = LOCKOUT_ATTEMPT_CEILING,
): AttemptBudget {
  const wanted = declaredThreshold === null ? ceiling : declaredThreshold + 1;
  const attempts = Math.min(wanted, ceiling);
  const capped = wanted > ceiling;
  return {
    attempts,
    declaredThreshold,
    ceiling,
    capped,
    capReason: capped
      ? `a ceiling of ${ceiling} failed sign-ins was applied; the declared lockout threshold of ` +
        `${String(declaredThreshold)} would have needed ${wanted}, so this journey cannot reach ` +
        'the threshold and a negative result is inconclusive rather than a pass'
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. The journeys themselves
// ─────────────────────────────────────────────────────────────────────────────

/** A step, with the defaults every step shares. */
function step(
  index: number,
  as: string,
  action: string,
  extra: {
    session?: string;
    destructive?: boolean;
    outOfBand?: OutOfBandKind;
  } = {},
): AuthLifecycleStep {
  return {
    index,
    as,
    session: extra.session ?? PRIMARY_SESSION,
    action,
    destructive: extra.destructive ?? false,
    outOfBand: extra.outOfBand ?? null,
  };
}

/**
 * Build the journey for one flow. Reached only with a proven target.
 *
 * The `switch` is exhaustive over the union and ends in a `never` check, so a
 * fifteenth flow fails to compile here rather than silently producing a journey
 * with no steps — which would be counted as GENERATED and assert nothing.
 */
function buildJourney(
  flow: AuthLifecycleFlow,
  target: DisposableTarget,
  ctx: AuthLifecycleContext,
): AuthLifecycleJourney {
  const descriptor = LIFECYCLE_FLOW_DESCRIPTORS[flow];
  const factory = factoryFor(flow, ctx);
  const scope = syntheticScopeFor(flow);
  const who = target.name;
  const recipient = descriptor.needsOutOfBandMessage || flow === 'SIGNUP' || flow === 'EMAIL_CHANGE'
    ? factory.value({ name: 'email', semantic: 'email' })
    : null;
  const route = ctx.authenticatedRoute;

  const base = {
    id: `authlc-${flow.toLowerCase().replace(/_/g, '-')}-${factory.token}`,
    flow,
    title: descriptor.title,
    rationale: descriptor.rationale,
    priority: descriptor.priority,
    testType: descriptor.testType,
    principals: [target] as readonly DisposableTarget[],
    destructiveStep: descriptor.destructiveStep,
    syntheticScope: scope,
    recipient,
  } as const;

  /*
   * STEP 0 IS ALWAYS THE SIGNUP, in every one of the fourteen.
   *
   * That is the disposability rule made operational rather than asserted. The
   * principal's `createdByScenario` claims this journey created it, and the
   * prover believes that claim; step 0 is what makes the claim true. A journey
   * that assumed an account already existed would be destroying something it
   * did not create, which is the exact thing the prover is there to stop and
   * the exact thing it cannot see.
   *
   * It also makes every journey independent of every other: no ordering, no
   * shared state, and nothing one journey does can decide what another finds.
   */
  const create = step(
    0,
    who,
    `Create the disposable account "${who}" by completing the signup form with this run's ` +
      `synthetic values for scope "${scope}". The values are derived from the run seed at ` +
      'execution time and are deliberately not written into this plan.',
  );

  const cleanupDelete: AuthLifecycleCleanup = {
    obligation: 'DELETE_ENTITY',
    ownedBy: who,
    action: `Delete the account "${who}" and release its address, whether this journey passed or failed.`,
    satisfiedByFlow: false,
  };

  switch (flow) {
    case 'SIGNUP':
      return {
        ...base,
        steps: [
          create,
          step(1, who, 'Submit the form by its accessible "Sign up" control.'),
          step(
            2,
            who,
            'Wait for the application to settle into either a signed-in state or a ' +
              '"verify your address" state — whichever it chooses.',
          ),
        ],
        assertions: [
          'the signup form accepts the synthetic values and the application confirms the account was created',
          'the new account is either signed in or told to verify its address, and the journey records WHICH — ' +
            'an application that silently signs an unverified user in is a finding, not a variation',
          'no field is reported invalid, and if one is, the field and the message are named rather than retried',
        ],
        cleanup: [cleanupDelete],
        attemptBudget: null,
        inconclusiveIf: null,
      };

    case 'EMAIL_VERIFICATION':
      return {
        ...base,
        steps: [
          create,
          step(1, who, `Read the verification message delivered to ${String(recipient)} at the mail sink.`, {
            outOfBand: 'LINK',
          }),
          step(2, who, 'Follow the verification link exactly once.'),
          step(3, who, 'Wait for the application to report the address as verified.'),
          step(4, who, 'Follow the SAME verification link a second time.'),
        ],
        assertions: [
          'exactly one verification message is delivered to the new address',
          'the first use of the link verifies the address and the application says so in its own words',
          'THE SECOND use of the same link does not verify again — a replayable verification token is a token ' +
            'an attacker who reads one old message can use',
          'the second use fails cleanly rather than with a server fault; a 500 here is a separate finding and is reported as one',
        ],
        cleanup: [cleanupDelete],
        attemptBudget: null,
        inconclusiveIf: null,
      };

    case 'LOGIN': {
      const budget = attemptBudgetFor(target, 1, ctx.limits?.lockoutAttemptCeiling ?? LOCKOUT_ATTEMPT_CEILING);
      return {
        ...base,
        steps: [
          create,
          step(1, who, 'Open a fresh browser context holding no stored session.'),
          step(
            2,
            who,
            `Submit the login form for "${who}" with a deliberately wrong password. This burns ` +
              `${budget.attempts} failed attempt against an account created by this journey and ` +
              'no other.',
          ),
          step(3, who, 'Submit the login form with the correct synthetic password for this scope.'),
          step(4, who, `Wait for ${route === null ? 'the signed-in landing state' : route} to be served.`),
        ],
        assertions: [
          'the wrong password is refused',
          'the refusal does not reveal whether the address is registered — "no account with that email" is a ' +
            'user-enumeration finding, and this journey is the only place it gets checked',
          'the correct password signs in afterwards, so one failed attempt did not make the account unusable',
          `the signed-in principal is served ${route === null ? 'its landing page' : route}`,
        ],
        cleanup: [cleanupDelete],
        attemptBudget: budget,
        inconclusiveIf: null,
      };
    }

    case 'LOGOUT':
      return {
        ...base,
        steps: [
          create,
          step(1, who, `Sign in as "${who}" and wait for ${String(route)} to be served.`),
          step(2, who, 'Activate the accessible "Sign out" control.', { destructive: true }),
          step(3, who, 'Wait for the signed-out state to appear.'),
          step(4, who, 'Press the browser BACK button.'),
          step(5, who, `Re-request ${String(route)} directly in the same context.`),
        ],
        assertions: [
          `after signing out, ${String(route)} is no longer served to this session`,
          'the browser BACK button does not restore the authenticated page from cache — a cached authenticated ' +
            'page after sign-out is a real disclosure on a shared computer, and it is the half of logout that fails',
          'the session is rejected by the application\'s own response, which is what the journey asserts on; it ' +
            'never reads the session cookie',
        ],
        cleanup: [cleanupDelete],
        attemptBudget: null,
        inconclusiveIf: null,
      };

    case 'SESSION_EXPIRY': {
      const lifetime = ctx.sessionLifetimeSeconds ?? 0;
      return {
        ...base,
        steps: [
          create,
          step(1, who, `Sign in as "${who}" and wait for ${String(route)} to be served.`),
          step(
            2,
            who,
            `Poll ${String(route)} until it stops being served, bounded by the declared session ` +
              `lifetime of ${lifetime}s plus a grace margin. This is a deadline driven by a ` +
              'declared value, not a fixed sleep.',
            { destructive: true },
          ),
          step(3, who, `Re-request ${String(route)} once the session has lapsed.`),
          step(4, who, 'Sign in again with the same credentials.'),
        ],
        assertions: [
          `the lapsed session is no longer accepted for ${String(route)}`,
          'the application redirects to its login form rather than serving a partial page or a server fault — ' +
            'an expired cookie is the case nobody asked for and therefore the case that breaks',
          'signing in again works, so expiry did not lock or damage the account',
        ],
        cleanup: [cleanupDelete],
        attemptBudget: null,
        inconclusiveIf:
          `the session is still accepted after the declared ${lifetime}s — this is UNKNOWN rather ` +
          'than a failure, because a declared lifetime may be a floor rather than an exact value, ' +
          'and reporting it as a pass would claim we watched a session expire when we did not',
      };
    }

    case 'SESSION_REVOCATION':
      return {
        ...base,
        steps: [
          create,
          step(1, who, `Sign in as "${who}" in the primary session.`),
          step(2, who, `Sign in as "${who}" again in a second, independent browser context.`, {
            session: SECONDARY_SESSION,
          }),
          step(3, who, 'From the primary session, open the active-sessions screen.'),
          step(4, who, 'Revoke every session other than the one being held.', { destructive: true }),
          step(5, who, `In the secondary session, re-request ${String(route)}.`, {
            session: SECONDARY_SESSION,
          }),
        ],
        assertions: [
          'the secondary session is no longer accepted after revocation — this is the whole promise of ' +
            '"sign out everywhere", and it is untestable with one session',
          'the primary session, which performed the revocation, is still accepted; a control that signs the ' +
            'user out of the device they are using is a different bug and a common one',
          'the active-sessions screen no longer lists the revoked session',
        ],
        cleanup: [cleanupDelete],
        attemptBudget: null,
        inconclusiveIf: null,
      };

    case 'PASSWORD_RESET':
      return {
        ...base,
        steps: [
          create,
          step(1, who, 'Open a fresh browser context holding no stored session.'),
          step(2, who, `Request a password reset for ${String(recipient)}.`),
          step(3, who, `Read the reset message delivered to ${String(recipient)} at the mail sink.`, {
            outOfBand: 'LINK',
          }),
          step(4, who, 'Follow the reset link.'),
          step(
            5,
            who,
            `Set a new password — this run's synthetic value for scope "${scope}#replacement", ` +
              'derived at execution time and not written into this plan.',
            { destructive: true },
          ),
          step(6, who, 'Sign in with the NEW password.'),
          step(7, who, 'In another fresh context, sign in with the OLD password.'),
          step(8, who, 'Follow the reset link a SECOND time.'),
        ],
        assertions: [
          'the reset request is accepted for a registered address, and its response does not reveal whether ' +
            'the address is registered',
          'exactly one reset message is delivered',
          'the new password signs in',
          'THE OLD PASSWORD IS REFUSED — a reset that leaves the previous credential working hands the account ' +
            'to whoever already knew it, and nothing short of this whole chain can see it',
          'the reset link does not work a second time; a replayable reset token is a standing takeover path',
        ],
        cleanup: [cleanupDelete],
        attemptBudget: null,
        inconclusiveIf: null,
      };

    case 'PASSWORD_CHANGE': {
      const budget = attemptBudgetFor(target, 1, ctx.limits?.lockoutAttemptCeiling ?? LOCKOUT_ATTEMPT_CEILING);
      return {
        ...base,
        steps: [
          create,
          step(1, who, `Sign in as "${who}".`),
          step(2, who, 'Open the change-password form.'),
          step(
            3,
            who,
            'Submit it with a deliberately wrong CURRENT password and a valid new one. This burns ' +
              `${budget.attempts} failed credential check against an account created by this journey.`,
          ),
          step(
            4,
            who,
            `Submit it with the correct current password and a new one — this run's synthetic ` +
              `value for scope "${scope}#replacement".`,
            { destructive: true },
          ),
          step(5, who, 'Sign out, then sign in with the NEW password.'),
          step(6, who, 'In a fresh context, sign in with the OLD password.'),
        ],
        assertions: [
          'the change is REFUSED when the current password is wrong — a change form that does not re-authenticate ' +
            'lets anyone who borrows an unlocked browser take the account permanently',
          'the change succeeds with the correct current password',
          'the new password signs in and the OLD one is refused',
          'whether the change invalidated the other sessions is recorded as a fact rather than assumed; both ' +
            'behaviours exist in the wild and only one of them is what the user expects',
        ],
        cleanup: [cleanupDelete],
        attemptBudget: budget,
        inconclusiveIf: null,
      };
    }

    case 'ACCOUNT_LOCKOUT': {
      const budget = attemptBudgetFor(
        target,
        ctx.declaredLockoutThreshold,
        ctx.limits?.lockoutAttemptCeiling ?? LOCKOUT_ATTEMPT_CEILING,
      );
      return {
        ...base,
        steps: [
          create,
          step(1, who, 'Open a fresh browser context holding no stored session.'),
          step(
            2,
            who,
            `Submit the login form with a wrong password up to ${budget.attempts} times, stopping ` +
              'at the FIRST attempt the application refuses as locked. The bound is deliberate: ' +
              'these are real failed sign-ins against a live auth system, and they are aimed only ' +
              `at "${who}", which this journey created moments earlier.`,
            { destructive: true },
          ),
          step(3, who, 'Submit the login form with the CORRECT password.'),
        ],
        assertions: [
          `the account locks at or before attempt ${budget.attempts}, and the attempt number at which it locked ` +
            'is recorded rather than merely passing',
          'after the lock, the CORRECT password is also refused — a lock that only blocks wrong passwords is not a lock',
          'the refusal message does not reveal whether the address is registered',
        ],
        cleanup: [cleanupDelete],
        attemptBudget: budget,
        inconclusiveIf:
          `the account is NOT locked after ${budget.attempts} failed attempts. That is UNKNOWN, not a pass: ` +
          (budget.declaredThreshold === null
            ? 'no lockout threshold was declared for this environment, so the application may lock at a higher ' +
              'count this journey\'s bound deliberately does not reach'
            : `the declared threshold is ${budget.declaredThreshold}, and a lock that fires later than declared ` +
              'is a finding this bound cannot distinguish from no lock at all'),
      };
    }

    case 'LOCKOUT_UNLOCK': {
      const budget = attemptBudgetFor(
        target,
        ctx.declaredLockoutThreshold,
        ctx.limits?.lockoutAttemptCeiling ?? LOCKOUT_ATTEMPT_CEILING,
      );
      return {
        ...base,
        steps: [
          create,
          step(1, who, 'Open a fresh browser context holding no stored session.'),
          step(
            2,
            who,
            `Lock the account by submitting a wrong password up to ${budget.attempts} times, ` +
              'stopping at the first refusal that reports a lock.',
            { destructive: true },
          ),
          step(3, who, `Read the unlock or reset message delivered to ${String(recipient)} at the mail sink.`, {
            outOfBand: 'LINK',
          }),
          step(4, who, 'Follow it and complete the unlock the application offers.'),
          step(5, who, 'Sign in with the correct password.'),
          step(6, who, 'Submit one further wrong password, then the correct one.'),
        ],
        assertions: [
          'an unlock path exists and its message is delivered — a lock nobody can undo is a denial of service ' +
            'the customer inflicts on their own users',
          'after unlocking, the correct password signs in',
          'the failed-attempt counter was RESET by the unlock: one further wrong attempt does not immediately re-lock',
        ],
        cleanup: [cleanupDelete],
        attemptBudget: budget,
        inconclusiveIf:
          `the account is not locked within ${budget.attempts} attempts, so there was nothing to unlock and ` +
          'this journey proved nothing about the unlock path. UNKNOWN, not a pass',
      };
    }

    case 'MFA_ENROLMENT': {
      const budget = attemptBudgetFor(target, 1, ctx.limits?.lockoutAttemptCeiling ?? LOCKOUT_ATTEMPT_CEILING);
      return {
        ...base,
        steps: [
          create,
          step(1, who, `Sign in as "${who}".`),
          step(2, who, 'Open the two-factor enrolment screen.'),
          step(
            3,
            who,
            'Enrol a time-based second factor. The shared secret the application issues is held ' +
              'in the run session store for the length of the run and is never written into this ' +
              'plan, a generated test, a fixture or a log line.',
          ),
          step(4, who, 'Confirm enrolment with a code derived from that secret.'),
          step(5, who, 'Sign out, then open a fresh context and sign in with the password alone.'),
          step(
            6,
            who,
            `Submit a deliberately wrong second-factor code. This burns ${budget.attempts} ` +
              'failed second-factor check.',
          ),
          step(7, who, 'Submit a correct code and complete the sign-in.'),
        ],
        assertions: [
          'enrolment completes and the application reports the factor as active',
          'after enrolment the PASSWORD ALONE does not sign in — a factor recorded as active while the password ' +
            'still works on its own is worse than none, because the user believes they are protected',
          'a wrong second-factor code is refused',
          'a correct code completes the sign-in',
        ],
        cleanup: [
          cleanupDelete,
          {
            obligation: 'REVOKE_CREDENTIAL',
            ownedBy: who,
            action:
              `Discard the second-factor secret issued to "${who}" from the run session store. It is never ` +
              'persisted, so this is a drop rather than a delete.',
            satisfiedByFlow: false,
          },
        ],
        attemptBudget: budget,
        inconclusiveIf: null,
      };
    }

    case 'MFA_RECOVERY_CODE':
      return {
        ...base,
        steps: [
          create,
          step(1, who, `Sign in as "${who}" and enrol a time-based second factor.`),
          step(
            2,
            who,
            'Capture the recovery codes the application issues. They are held in the run session ' +
              'store and never written into this plan, a generated test, a fixture or a log line.',
          ),
          step(3, who, 'Sign out, then sign in with the password in a fresh context.'),
          step(4, who, 'Use ONE recovery code in place of the second factor.'),
          step(5, who, 'Sign out, then sign in with the password again.'),
          step(6, who, 'Offer the SAME recovery code a second time.'),
        ],
        assertions: [
          'a recovery code completes the sign-in when the second factor is unavailable',
          'THE SAME recovery code does not work twice — a reusable recovery code is a permanent bypass of the ' +
            'second factor the user thinks they enrolled',
          'the remaining recovery-code count decreases by exactly one; a count that does not move means nobody ' +
            'can tell how many are left',
        ],
        cleanup: [
          cleanupDelete,
          {
            obligation: 'REVOKE_CREDENTIAL',
            ownedBy: who,
            action:
              `Discard the second-factor secret and the recovery codes issued to "${who}" from the run ` +
              'session store.',
            satisfiedByFlow: false,
          },
        ],
        attemptBudget: null,
        inconclusiveIf:
          'the application issues no recovery codes at enrolment. That is UNKNOWN for this journey and a ' +
          'finding in its own right — a second factor with no recovery path locks a user out of their own ' +
          'account when they lose a phone — but it is not evidence that recovery codes are single-use',
      };

    case 'EMAIL_CHANGE':
      return {
        ...base,
        steps: [
          create,
          step(1, who, `Sign in as "${who}".`),
          step(
            2,
            who,
            `Open the change-email form and request a change to a second synthetic address for ` +
              `scope "${scope}#replacement".`,
            { destructive: true },
          ),
          step(3, who, 'Read the confirmation message delivered to the NEW address at the mail sink.', {
            outOfBand: 'LINK',
          }),
          step(4, who, `Before following it, sign in with the OLD address ${String(recipient)} in a fresh context.`),
          step(5, who, 'Follow the confirmation link.'),
          step(6, who, 'Sign in with the NEW address.'),
          step(7, who, `Sign in with the OLD address ${String(recipient)}.`),
        ],
        assertions: [
          'the change is NOT effective before confirmation: the old address still signs in at that point. An ' +
            'address change that takes effect unconfirmed is an account takeover — type a victim\'s address and ' +
            'their reset links arrive in your inbox',
          'after confirmation the new address signs in',
          'after confirmation the OLD address does not sign in',
          'whether a notice was also delivered to the old address is recorded as a fact; an email change with no ' +
            'notice to the previous owner leaves a takeover silent',
        ],
        cleanup: [
          cleanupDelete,
          {
            obligation: 'RELEASE_IDENTIFIER',
            ownedBy: who,
            action:
              'Release BOTH synthetic addresses this journey consumed, not just the current one — the old ' +
              'address is still held by the account until it is deleted.',
            satisfiedByFlow: false,
          },
        ],
        attemptBudget: null,
        inconclusiveIf: null,
      };

    case 'ACCOUNT_DELETION':
      return {
        ...base,
        steps: [
          create,
          step(1, who, `Sign in as "${who}" and wait for ${String(route)} to be served.`),
          step(2, who, 'Open the delete-account control.'),
          step(3, who, 'Confirm the deletion exactly as the application requires.', { destructive: true }),
          step(4, who, 'Wait for the deleted or signed-out state to appear.'),
          step(5, who, `Re-request ${String(route)} using the session held from before the deletion.`),
          step(6, who, 'In a fresh context, sign in with the deleted account\'s credentials.'),
        ],
        assertions: [
          'the deletion completes and the application confirms it',
          'THE PRE-DELETION SESSION IS NO LONGER ACCEPTED — a session that outlives the account it belongs to ' +
            'lets a deleted user keep reading their old data until a cookie expires, and this is the only ' +
            'journey that can see it',
          'the deleted account cannot sign in afterwards',
          'whether the same address may be used to sign up again is recorded rather than assumed; both answers ' +
            'are defensible and only one of them matches what the application promises',
        ],
        cleanup: [
          {
            obligation: 'DELETE_ENTITY',
            ownedBy: who,
            action:
              `Nothing to do: deleting "${who}" IS this journey. If the deletion step did not complete, the ` +
              'account is left behind and the suite must remove it.',
            satisfiedByFlow: true,
          },
        ],
        attemptBudget: null,
        inconclusiveIf: null,
      };
  }

  /*
   * Unreachable while the switch is exhaustive, and it is the compiler that
   * guarantees that: `flow` is `never` here, so adding a fifteenth member to
   * AUTH_LIFECYCLE_FLOWS without a case fails `tsc` on this line. A default
   * arm returning an empty journey would instead ship a flow that is counted
   * as GENERATED and asserts nothing.
   */
  const exhaustive: never = flow;
  throw new Error(`unhandled auth-lifecycle flow: ${String(exhaustive)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. The self-audit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credential SHAPES, for the belt-and-braces scan.
 *
 * These are heuristics and are labelled as such. The protection against a
 * secret reaching a journey is structural — {@link AuthLifecycleContext} has no
 * field one could arrive in, and {@link OutOfBandValue} keeps the one
 * unavoidable secret in a closure — and this list exists to catch a FUTURE edit
 * to this file that interpolates something it should not.
 *
 * Each pattern needs a value beside the name to fire, so the many legitimate
 * mentions of the words ("submit the login form with the correct password") do
 * not trip it. That was tested the obvious way: the fourteen journeys are
 * scanned in auth-lifecycle.test.ts and must produce no violation.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  {
    name: 'a JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}/,
  },
  {
    name: 'a named credential with a value beside it',
    pattern:
      /\b(?:password|passwd|pwd|secret|totp|otp|token|cookie|storagestate|apikey|api[_-]key)\b\s*[:=]\s*\S/i,
  },
  {
    name: 'an Authorization header value',
    pattern: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}/i,
  },
  {
    name: 'a long hexadecimal run, which is what a token or a hash looks like',
    pattern: /\b[A-Fa-f0-9]{32,}\b/,
  },
  {
    name: 'a long base64 run, which is what an encoded credential looks like',
    pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
  },
];

/**
 * Everything wrong with a finished journey, as sentences.
 *
 * Exported because two callers want it and for different reasons: this module
 * runs it on the way out, so a defect in the builder suppresses the journey and
 * is COUNTED as SUPPRESSED_SELF_AUDIT rather than shipped; and the generation
 * gate can run it on a journey that arrived from anywhere else.
 *
 * Empty means nothing was found, which is not the same as "this journey is
 * good" — the scan knows about credential shapes, empty assertions and missing
 * cleanup, and it does not know whether the steps describe the application
 * correctly. Saying which it is beats letting a reader assume the stronger one.
 */
export function lifecycleJourneyViolations(journey: AuthLifecycleJourney): readonly string[] {
  const out: string[] = [];

  if (journey.assertions.length === 0) {
    out.push(
      'the journey has no assertions, so it would be stored, counted towards coverage and pass ' +
        'without checking anything',
    );
  }
  if (journey.cleanup.length === 0) {
    out.push(
      'the journey has no cleanup obligation, and every journey here creates an account — one ' +
        'with no declared cleanup fills the customer\'s database a row per run',
    );
  }

  const names = new Set(journey.principals.map((p) => p.name));
  for (const s of journey.steps) {
    if (!names.has(s.as)) {
      out.push(
        `step ${s.index} acts as "${s.as}", which is not one of this journey's declared ` +
          'principals, so no session would be resolved for it',
      );
    }
  }

  for (const principal of journey.principals) {
    if (principal.kind !== 'DISPOSABLE') {
      out.push(
        `principal "${principal.name}" is ${principal.kind} and this journey destroys or alters ` +
          'the identity it acts on',
      );
    }
  }

  if (journey.destructiveStep !== null && !journey.steps.some((s) => s.destructive)) {
    out.push(
      `the journey declares the destructive step ${journey.destructiveStep} and no step is ` +
        'marked destructive, so a reviewer reading the steps cannot see where the damage happens',
    );
  }

  if (journey.attemptBudget !== null) {
    const b = journey.attemptBudget;
    if (b.capped !== (b.capReason !== null)) {
      out.push(
        'the attempt budget reports a cap with no reason beside it (or a reason with no cap), ' +
          'which is a bound applied without being disclosed',
      );
    }
    if (b.attempts > b.ceiling) {
      out.push(
        `the attempt budget would burn ${b.attempts} failed sign-ins against a live auth system, ` +
          `past its own ceiling of ${b.ceiling}`,
      );
    }
  }

  /*
   * A fixed sleep in the PLAIN ENGLISH becomes a fixed sleep in the generated
   * code, and the admission gate's NO_FIXED_SLEEP would then refuse the test
   * with no clue that the plan asked for it. Caught here, where the sentence is
   * still editable.
   */
  for (const s of journey.steps) {
    if (/\bwait (?:for )?\d+\s*(?:ms|milliseconds?|s|seconds?|minutes?)\b/i.test(s.action)) {
      out.push(
        `step ${s.index} asks for a fixed sleep, which the admission gate refuses and which is ` +
          'the commonest source of the flake this product exists to eliminate — wait for a ' +
          'condition, or poll to a deadline',
      );
    }
  }

  for (const text of journeyStrings(journey)) {
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.pattern.test(text)) {
        /*
         * The violation names the SHAPE and NEVER quotes the match. A finding
         * that prints the credential it found is the leak it was trying to
         * report.
         */
        out.push(
          `a journey string looks like it contains ${shape.name}; nothing here may carry a ` +
            'credential, and the offending text is deliberately not quoted',
        );
      }
    }
  }

  return out;
}

/**
 * Every string a journey would show a human or write to a store.
 *
 * Walks the declared fields rather than `JSON.stringify`, so a field added to
 * {@link AuthLifecycleJourney} is scanned only once someone adds it here — and
 * the test that asserts this function sees every string field is what makes
 * that a deliberate decision instead of an omission.
 */
function journeyStrings(journey: AuthLifecycleJourney): readonly string[] {
  return [
    journey.id,
    journey.title,
    journey.rationale,
    journey.syntheticScope,
    journey.recipient ?? '',
    journey.inconclusiveIf ?? '',
    ...journey.assertions,
    ...journey.steps.map((s) => s.action),
    ...journey.steps.map((s) => s.as),
    ...journey.cleanup.map((c) => c.action),
    ...journey.principals.map((p) => p.name),
    /*
     * THREE PRINCIPAL FIELDS THAT WERE NOT SCANNED, found by an adversarial
     * pass: a journey carrying a JWT in `role` or `createdByScenario` passed
     * the belt clean, while the same string in `cleanup[].action` was caught.
     * The header above promises a test asserting this function sees every
     * string field; that test did not exist either, and now does
     * ("scans every string field of a journey, so the belt has no blind side").
     */
    ...journey.principals.map((p) => p.role ?? ''),
    ...journey.principals.map((p) => p.createdByScenario ?? ''),
    /*
     * `principals[].authProfileId` is DELIBERATELY EXCLUDED, and this is the
     * decision the header asks to be made explicitly rather than by omission.
     * It is an identifier, not a credential — the credential it points at lives
     * in the vault and is resolved by the worker — and a 32-character
     * hexadecimal id would trip the "long hexadecimal run" shape and suppress a
     * valid journey. A false violation here deletes a real destructive scenario
     * from the suite, which is worse than not scanning a field that structurally
     * cannot hold a secret.
     */
    journey.attemptBudget?.capReason ?? '',
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. The out-of-band seam: reading a code or a link out of a delivered message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One delivered message.
 *
 * The field names are `packages/runner/src/plugins/email-otp.ts`'s own
 * `CaughtMail`, with `receivedAt` spelled `receivedAtIso` because the plugin
 * parses it as an ISO instant and an unqualified name invited a number. That
 * plugin has the contract and no type for it; this is the type, and the
 * needsFromOtherFiles entry adopts it there rather than keeping two.
 */
export interface CaughtMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly receivedAtIso: string;
}

/**
 * The mailbox, as an injected interface.
 *
 * Narrow on purpose: one method, no transport, no credential. The HTTP adapter
 * that satisfies it is three lines and lives at the edge — which is the whole
 * point, because `waitForMail` in email-otp.ts takes a URL, calls `fetch` and
 * is therefore untestable, and the bug below went unnoticed for exactly that
 * reason.
 */
export interface MailSink {
  /** The sink's own address, for the report. Never a credential. */
  readonly endpoint: string;
  /** Messages for this recipient, newest or oldest first — order is not relied on. */
  readonly search: (query: {
    readonly recipient: string;
    readonly sinceMs: number;
  }) => Promise<readonly CaughtMessage[]>;
}

/**
 * The clock, injected. No `Date.now()` and no `setTimeout` anywhere in this
 * module's logic.
 *
 * Not fastidiousness: a polling loop that reads an ambient clock can only be
 * tested by actually waiting, so in practice it is not tested at all, and the
 * `SINK_UNAVAILABLE` distinction below is precisely the kind of thing that then
 * ships wrong.
 */
export interface LifecycleClock {
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * How long before the request a message may be stamped and still be accepted
 * as this journey's.
 *
 * TWO SECONDS, and the tradeoff is real rather than hidden. The application
 * server's clock and ours are not the same clock, so a message genuinely sent
 * in response to our request can carry a timestamp slightly before it; with no
 * grace the journey times out waiting for mail that already arrived. With grace
 * we may accept a message sent in the two seconds before our request — which is
 * why the recipient address is unique per (run, flow): the only message that
 * could be confused with ours is one sent to an address no previous run ever
 * used.
 *
 * `email-otp.ts` has the same guard, as a bare `since - 1000`, with no name and
 * no statement of what it costs.
 */
export const MESSAGE_CLOCK_SKEW_GRACE_MS = 2_000;

/** Why no message was read. */
export const MESSAGE_WAIT_FAILURES = [
  /** The deadline passed with no matching message. The application's behaviour. */
  'TIMED_OUT',
  /** Every read of the sink threw. OUR dependency, not their bug. */
  'SINK_UNAVAILABLE',
] as const;
export type MessageWaitFailure = (typeof MESSAGE_WAIT_FAILURES)[number];

/** A message, or an accounted-for absence. */
export type MessageWaitResult =
  | {
      readonly delivered: true;
      readonly message: CaughtMessage;
      /** How many reads it took. Disclosed, like every other bound here. */
      readonly attempts: number;
      readonly waitedMs: number;
    }
  | {
      readonly delivered: false;
      readonly reason: MessageWaitFailure;
      readonly attempts: number;
      readonly waitedMs: number;
      /** One sentence a human can act on. Never quotes a message body. */
      readonly detail: string;
    };

/**
 * Poll the sink until the message lands, or the deadline passes.
 *
 * ── The defect this fixes, which is not the polling ────────────────────────
 *
 * `waitForMail` in email-otp.ts swallows EVERY error — "the catcher may not be
 * up yet; keep trying" — and then returns null. So a mail catcher that is down,
 * misconfigured or answering 500 is reported to the customer as
 * "No email reached <address> within 30s", which is a statement about THEIR
 * application. It is our dependency failing, it has a different remedy, and the
 * customer is sent to debug their mailer.
 *
 * Here the two are different arms. SINK_UNAVAILABLE is returned when every read
 * threw and none succeeded; TIMED_OUT when the sink answered and the message
 * was not there. One read succeeding is enough to make the sink available, so a
 * transient error during startup still ends in the honest answer.
 *
 * Pure over its injections: no `fetch`, no ambient clock, no `setTimeout`.
 */
export async function awaitOutOfBandMessage(args: {
  readonly sink: MailSink;
  readonly clock: LifecycleClock;
  readonly recipient: string;
  /** When the request that should have triggered the message was made. */
  readonly requestedAtMs: number;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<MessageWaitResult> {
  const { sink, clock, recipient, requestedAtMs, timeoutMs, pollIntervalMs } = args;
  const startedAt = clock.nowMs();
  const deadline = startedAt + timeoutMs;
  const since = requestedAtMs - MESSAGE_CLOCK_SKEW_GRACE_MS;

  let attempts = 0;
  let anyReadSucceeded = false;
  let lastErrorKind: string | null = null;

  for (;;) {
    attempts += 1;
    try {
      const messages = await sink.search({ recipient, sinceMs: since });
      anyReadSucceeded = true;
      const fresh = messages.find(
        (m) => m.to === recipient && Date.parse(m.receivedAtIso) >= since,
      );
      if (fresh !== undefined) {
        return {
          delivered: true,
          message: fresh,
          attempts,
          waitedMs: clock.nowMs() - startedAt,
        };
      }
    } catch (err) {
      /*
       * The KIND of failure, never the message. A sink error can carry a URL
       * with a token in its query string, and an error path that prints it is
       * the leak this file is most careful about everywhere else.
       */
      lastErrorKind = err instanceof Error ? err.name : typeof err;
    }

    if (clock.nowMs() + pollIntervalMs >= deadline) break;
    await clock.sleep(pollIntervalMs);
  }

  const waitedMs = clock.nowMs() - startedAt;
  if (!anyReadSucceeded) {
    return {
      delivered: false,
      reason: 'SINK_UNAVAILABLE',
      attempts,
      waitedMs,
      detail:
        `every one of ${attempts} reads of the mail sink at ${sink.endpoint} failed` +
        (lastErrorKind === null ? '' : ` (${lastErrorKind})`) +
        '. This is our dependency, not your application: no conclusion about the message the ' +
        'application may or may not have sent can be drawn from it.',
    };
  }
  return {
    delivered: false,
    reason: 'TIMED_OUT',
    attempts,
    waitedMs,
    detail:
      `the mail sink at ${sink.endpoint} answered ${attempts} times and no message for this ` +
      `journey's address arrived within ${timeoutMs}ms of the request.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. The one unavoidable secret, held where it cannot be printed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A code or a link read out of a delivered message.
 *
 * A reset token IS a credential: it signs its holder in. So this type holds it
 * in a CLOSURE, not in a property, and every way a value normally escapes is
 * closed:
 *
 *   · `JSON.stringify(v)` → the description, via `toJSON`.
 *   · `` `${v}` `` and `String(v)` → the description, via `toString`.
 *   · `Object.keys(v)` / `Object.values(v)` / `{...v}` → the two methods and
 *     the description. The secret is not an own property, so there is nothing
 *     to spread.
 *   · `console.log(v)` and `util.inspect(v)` → the methods, not the value.
 *
 * `reveal()` is the one door, it is named so that `grep -n 'reveal()'` finds
 * every use, and the rule for callers is that its result goes into a browser
 * field and nowhere else — never a log, never an assertion message, never a
 * test name, never a report.
 *
 * `describe()` is deliberately thin. It gives a shape and never a sample: a
 * LINK is described by its ORIGIN and the COUNT of its path segments and query
 * parameters, because a reset path is commonly `/reset/<token>` and a reset
 * query is commonly `?token=<token>` — so printing either would print the
 * secret. The message SUBJECT is not included for the same reason: "Your code
 * is 418210" is a subject line.
 */
export interface OutOfBandValue {
  readonly kind: OutOfBandKind;
  /** The one door. Goes into a browser field; never into a log or a report. */
  readonly reveal: () => string;
  /** A shape, never a sample. Safe for a report. */
  readonly describe: () => string;
  readonly toString: () => string;
  readonly toJSON: () => string;
}

/**
 * Wrap a value so it cannot be printed by accident.
 *
 * Exported so that the runner's adapter — the only code that ever holds one of
 * these — can construct one at the point it reads the message, rather than
 * passing a bare string around and wrapping it later. A secret that exists as a
 * bare string for three stack frames has already been logged by whatever
 * instrumented those frames.
 */
export function outOfBandValue(kind: OutOfBandKind, raw: string): OutOfBandValue {
  const description = describeOutOfBand(kind, raw);
  const held = raw;
  const value: OutOfBandValue = {
    kind,
    reveal: () => held,
    describe: () => description,
    toString: () => description,
    toJSON: () => description,
  };
  return value;
}

/** The safe shape of a value. See the note on {@link OutOfBandValue}. */
function describeOutOfBand(kind: OutOfBandKind, raw: string): string {
  if (kind === 'CODE') {
    return `a ${raw.length}-character one-time code (not shown)`;
  }
  /*
   * A URL we cannot parse is described as unparseable and NOT echoed. The
   * tempting alternative — "a link: <raw>" for the unparseable case — is how a
   * token-bearing URL reaches a log through the error path, which is the path
   * nobody reviews.
   */
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter((s) => s.length > 0).length;
    const params = [...url.searchParams.keys()].length;
    return (
      `a link on ${url.origin} with ${segments} path segment${segments === 1 ? '' : 's'} and ` +
      `${params} query parameter${params === 1 ? '' : 's'} (not shown)`
    );
  } catch {
    return 'a link that could not be parsed as a URL (not shown)';
  }
}

/** Why nothing could be extracted from a message. */
export const EXTRACTION_FAILURES = [
  /** The pattern is not a valid regular expression. OUR configuration error. */
  'PATTERN_INVALID',
  /** The message arrived and the pattern matched nothing. */
  'NO_MATCH',
  /** The pattern matched and captured an empty string, which is not a value. */
  'EMPTY_MATCH',
] as const;
export type ExtractionFailure = (typeof EXTRACTION_FAILURES)[number];

export type ExtractionResult =
  | { readonly found: true; readonly value: OutOfBandValue }
  | {
      readonly found: false;
      readonly reason: ExtractionFailure;
      /** Never quotes the message body: a body that failed one pattern may match another. */
      readonly detail: string;
    };

/**
 * Pull the code or the link out of a message body.
 *
 * Pure, so it is testable against a literal message with no mailbox and no
 * browser — which is the point, because this is the function whose failure mode
 * is "the test submitted the wrong six characters and the application correctly
 * refused them", reported as an application defect.
 *
 * The first capture group wins, falling back to the whole match, which is the
 * convention `emailOtpSpecSchema.codePattern` already establishes in
 * email-otp.ts. A pattern that is not a valid regular expression is OUR
 * configuration error and says so, rather than being reported as a message that
 * did not arrive.
 */
export function extractOutOfBand(
  kind: OutOfBandKind,
  message: CaughtMessage,
  pattern: string,
): ExtractionResult {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return {
      found: false,
      reason: 'PATTERN_INVALID',
      detail:
        `the ${kind.toLowerCase()} pattern configured for this flow is not a valid regular ` +
        'expression, so no extraction was attempted. This is a configuration error on our side, ' +
        'not a message that failed to arrive.',
    };
  }

  const match = re.exec(message.text);
  if (match === null) {
    return {
      found: false,
      reason: 'NO_MATCH',
      detail:
        `the message arrived and the configured ${kind.toLowerCase()} pattern matched nothing in ` +
        'its body. The body is deliberately not quoted here — it carries whatever the ' +
        'application sent, which for these flows is a credential.',
    };
  }

  const raw = match[1] ?? match[0];
  if (raw.length === 0) {
    return {
      found: false,
      reason: 'EMPTY_MATCH',
      detail:
        `the configured ${kind.toLowerCase()} pattern matched and captured nothing, so there is ` +
        'no value to use. Check the capture group in the pattern.',
    };
  }

  return { found: true, value: outOfBandValue(kind, raw) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The lifecycle in one paragraph, for the report.
 *
 * Says how many flows were planned AND names what was not, because "11 of 14
 * authentication flows are covered" with the other three unexplained is the
 * number that makes a customer stop reading. The sentence for an absence always
 * carries its remedy.
 */
export function describeAuthLifecycle(enumeration: AuthLifecycleEnumeration): string {
  const { generated, considered } = enumeration;
  if (generated === considered) {
    return `All ${considered} authentication-lifecycle flows were planned against throwaway accounts this suite creates and deletes.`;
  }

  const byOutcome = new Map<AuthLifecycleOutcome, AuthLifecycleFlow[]>();
  for (const result of enumeration.results) {
    if (result.outcome === 'GENERATED') continue;
    const list = byOutcome.get(result.outcome) ?? [];
    list.push(result.flow);
    byOutcome.set(result.outcome, list);
  }

  /*
   * Ordered by the declared outcome list rather than by insertion, so two runs
   * with the same facts produce the same paragraph. A report whose sentences
   * reorder between runs cannot be diffed, and a report nobody can diff is one
   * nobody notices a change in.
   */
  const parts: string[] = [];
  for (const outcome of AUTH_LIFECYCLE_OUTCOME_LIST) {
    const flows = byOutcome.get(outcome);
    if (flows === undefined || flows.length === 0) continue;
    parts.push(`${flows.join(', ')} — ${outcome}`);
  }

  return (
    `${generated} of ${considered} authentication-lifecycle flows were planned. ` +
    `The other ${enumeration.unmeasured} were not measured: ${parts.join('; ')}. ` +
    'Each one carries the remedy that would make it drivable; none of them is a pass.'
  );
}

/**
 * Whether a result may be counted as covering anything.
 *
 * The one predicate the coverage arithmetic should call, so that "we could not
 * check this" can never be added to a numerator by a caller reading the outcome
 * string and guessing. See {@link UNMEASURED_AUTH_LIFECYCLE_OUTCOMES}.
 */
export function countsAsMeasured(result: AuthLifecycleResult): boolean {
  return !UNMEASURED_AUTH_LIFECYCLE_OUTCOMES.includes(result.outcome);
}

/**
 * The priorities this module can emit, derived from the descriptors.
 *
 * Exists so the plan-item writer can be told the range without reading fourteen
 * records, and so that a descriptor set that accidentally emitted a priority
 * `PRIORITIES` does not contain would be visible. Deterministically ordered by
 * `PRIORITIES`, not by iteration.
 */
export function lifecyclePriorities(): readonly Priority[] {
  const used = new Set(AUTH_LIFECYCLE_FLOW_LIST.map((f) => LIFECYCLE_FLOW_DESCRIPTORS[f].priority));
  return PRIORITIES.filter((p) => used.has(p));
}
