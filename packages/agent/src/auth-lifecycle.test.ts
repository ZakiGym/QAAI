/**
 * Tests for the authentication-lifecycle journeys.
 *
 * Six things here are worth more than the rest of the file:
 *
 *  1. **THE COMPILER REFUSES THE DANGEROUS CALL.** Two `@ts-expect-error`
 *     assertions prove a bare principal and a hand-forged proof are not
 *     assignable where a journey builder expects a disposable target. A
 *     `@ts-expect-error` that stops erroring is itself a compile error, so
 *     weakening that guarantee fails `tsc` rather than a review. These are the
 *     two assertions in the file that cannot be satisfied by a wrong
 *     implementation.
 *
 *  2. **NOT MEASURED IS NEVER A PASS.** Every "we could not drive this" path is
 *     asserted to be the right UNREACHABLE/REFUSED member *and* asserted not to
 *     be GENERATED, separately. The counts are asserted to reconcile, because a
 *     flow dropped with no record is how fourteen flows become "11 of 11
 *     covered".
 *
 *  3. **NOTHING HERE CAN HOLD A SECRET.** The context type is asserted to
 *     REFUSE a password, a TOTP secret, an OTP, a reset token, a session cookie
 *     and a storageState as excess properties; all fourteen journeys are
 *     scanned for credential shapes; and `OutOfBandValue` is attacked with
 *     every ordinary way a value escapes — `JSON.stringify`, template
 *     interpolation, spread, `Object.values`.
 *
 *  4. **DETERMINISM IS ASSERTED, NOT HOPED FOR.** Two enumerations over the
 *     same context are deep-compared. A generator that is not reproducible
 *     produces a suite nobody can debug, and it is the commonest cause of the
 *     flake this product exists to eliminate.
 *
 *  5. **THE BOUND REALLY BOUNDS.** The lockout budget is asserted to be capped,
 *     to disclose the cap as a count AND a reason, and never to exceed the
 *     ceiling — a cap that is documented and not enforced is worse than no cap.
 *
 *  6. **A DEAD MAIL SINK IS OUR PROBLEM, NOT THEIRS.** The two arms of
 *     `awaitOutOfBandMessage` are tested separately, because collapsing them is
 *     the live defect in `email-otp.ts`: a catcher that is down is reported to
 *     the customer as "no email reached this address", which sends them to
 *     debug their mailer.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTH_LIFECYCLE_FLOWS,
  AUTH_LIFECYCLE_FLOW_LIST,
  AUTH_LIFECYCLE_OUTCOMES,
  AUTH_LIFECYCLE_OUTCOME_LIST,
  LIFECYCLE_FLOW_DESCRIPTORS,
  LIFECYCLE_SURFACES,
  LIFECYCLE_SURFACE_LIST,
  LOCKOUT_ATTEMPT_CEILING,
  MESSAGE_CLOCK_SKEW_GRACE_MS,
  OUT_OF_BAND_KINDS,
  PRIMARY_SESSION,
  SECONDARY_SESSION,
  SESSION_WAIT_CEILING_SECONDS,
  UNMEASURED_AUTH_LIFECYCLE_OUTCOMES,
  attemptBudgetFor,
  awaitOutOfBandMessage,
  countsAsMeasured,
  describeAuthLifecycle,
  enumerateAuthLifecycle,
  extractOutOfBand,
  lifecycleJourneyViolations,
  lifecyclePrincipalFor,
  lifecyclePriorities,
  outOfBandValue,
  planAuthLifecycleFlow,
  syntheticScopeFor,
} from './auth-lifecycle.js';
import type {
  AuthLifecycleContext,
  AuthLifecycleEnumeration,
  AuthLifecycleFlow,
  AuthLifecycleJourney,
  CaughtMessage,
  DisposabilityProver,
  DisposableTarget,
  LifecycleClock,
  LifecyclePrincipal,
  LifecycleSurface,
  MailSink,
} from './auth-lifecycle.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ALL_SURFACES: readonly LifecycleSurface[] = LIFECYCLE_SURFACES;

/**
 * A context in which every flow can be driven. The negative cases take this and
 * remove exactly one thing, so a failure names the one fact that mattered.
 */
function fullContext(over: Partial<AuthLifecycleContext> = {}): AuthLifecycleContext {
  return {
    runSeed: 'run_01HQ',
    runDefaultPrincipalName: 'default',
    scenarioPrefix: 'auth-lifecycle',
    observedSurfaces: ALL_SURFACES,
    authenticatedRoute: '/dashboard',
    signupInviteOnly: false,
    mailSink: { endpoint: 'http://mail.test/__mail', recipientDomain: 'mail.test' },
    capabilities: ['BROWSER', 'TOTP_CLOCK', 'MAILBOX_POLL'],
    botProtection: { provider: 'NONE', bypassMode: 'NOT_CONFIGURED' },
    sessionLifetimeSeconds: 60,
    declaredLockoutThreshold: 3,
    tenant: { id: 'tnt_1', label: 'Acme' },
    ...over,
  };
}

/**
 * A stand-in for the keystone's `proveDisposable`.
 *
 * It implements the same five checks in the same order and returns the same six
 * reason names, which is NOT an invitation to keep two implementations — see
 * the needsFromOtherFiles entry. It exists because the real one is in
 * packages/shared/src/principals.ts, which is not yet on the shared barrel, and
 * because a test that injected a prover which always said yes would exercise
 * none of the refusal paths that matter.
 */
const prover: DisposabilityProver = (candidate, runDefaultName) => {
  const refuse = (reason: string, detail: string) =>
    ({ ok: false as const, reason, detail: `${candidate.name}: ${detail}` });
  if (candidate.kind === 'ANONYMOUS') {
    return refuse('ANONYMOUS_PRINCIPAL', 'an anonymous principal has no account');
  }
  if (candidate.kind === 'PERSISTENT') {
    return refuse('PERSISTENT_PRINCIPAL', "this is the customer's own account");
  }
  if (candidate.name === runDefaultName) {
    return refuse('IS_RUN_DEFAULT', "this is the run's default session");
  }
  if (candidate.createdByScenario === null || candidate.createdByScenario.trim() === '') {
    return refuse('NO_CREATING_SCENARIO', 'marked DISPOSABLE but names no creating scenario');
  }
  return {
    ok: true,
    principal: {
      ...candidate,
      kind: 'DISPOSABLE',
      disposability: {
        principalName: candidate.name,
        createdByScenario: candidate.createdByScenario,
        tenantId: candidate.tenant?.id ?? null,
      },
    },
  };
};

/** A prover that always refuses, for the paths where that is the point. */
const refusingProver: DisposabilityProver = (candidate) => ({
  ok: false,
  reason: 'PERSISTENT_PRINCIPAL',
  detail: `${candidate.name}: this is the customer's own account and may never be damaged`,
});

function targetFor(flow: AuthLifecycleFlow, ctx: AuthLifecycleContext): DisposableTarget {
  const proof = prover(lifecyclePrincipalFor(flow, ctx), ctx.runDefaultPrincipalName);
  if (!proof.ok) throw new Error(`fixture prover refused ${flow}: ${proof.reason}`);
  return proof.principal;
}

function journeyFor(flow: AuthLifecycleFlow, ctx = fullContext()): AuthLifecycleJourney {
  const result = planAuthLifecycleFlow(flow, targetFor(flow, ctx), ctx);
  if (result.outcome !== 'GENERATED') {
    throw new Error(`fixture expected a journey for ${flow}, got ${result.outcome}`);
  }
  return result.journey;
}

function everyJourney(ctx = fullContext()): readonly AuthLifecycleJourney[] {
  return AUTH_LIFECYCLE_FLOWS.map((flow) => journeyFor(flow, ctx));
}

function message(over: Partial<CaughtMessage> = {}): CaughtMessage {
  return {
    to: 'someone@mail.test',
    subject: 'Confirm your address',
    text: 'Visit https://app.test/verify?token=abc to confirm.',
    receivedAtIso: '2026-06-15T12:00:00.000Z',
    ...over,
  };
}

/** A clock that advances only when something asks it to sleep. No real time passes. */
function fakeClock(startMs = 1_000): LifecycleClock & { elapsed: () => number } {
  let now = startMs;
  return {
    nowMs: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    elapsed: () => now - startMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the flow vocabulary', () => {
  it('derives its list from the presence record rather than hand-listing it', () => {
    // Both halves of the parity guard, compared. A member added to the tuple and
    // forgotten in the record (or the reverse) is otherwise invisible: the union
    // compiles, and check:wiring cannot see a union member with no write path.
    expect([...AUTH_LIFECYCLE_FLOW_LIST].sort()).toEqual([...AUTH_LIFECYCLE_FLOWS].sort());
    expect(AUTH_LIFECYCLE_FLOW_LIST).toHaveLength(14);
  });

  it('enumerates all fourteen flows the register named as never driven', () => {
    expect([...AUTH_LIFECYCLE_FLOWS]).toEqual([
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
    ]);
  });

  it('describes every flow, so none can be planned with nothing decided about it', () => {
    for (const flow of AUTH_LIFECYCLE_FLOWS) {
      const d = LIFECYCLE_FLOW_DESCRIPTORS[flow];
      expect(d.title.length, flow).toBeGreaterThan(0);
      expect(d.rationale.length, flow).toBeGreaterThan(40);
      expect(d.priority, flow).toBeTruthy();
      expect(d.testType, flow).toBeTruthy();
    }
  });

  it('names only destructive steps the keystone declares', () => {
    /*
     * `DESTRUCTIVE_STEP_KINDS` lives in packages/shared/src/principals.ts and is
     * not yet reachable through the shared barrel, so the seven names are
     * restated here. That is a duplication and it is the reason this test
     * exists: if the keystone's list changes, this is the line that has to be
     * updated, and the needsFromOtherFiles entry removes the duplication
     * altogether.
     */
    const keystoneKinds = [
      'LOGOUT',
      'SESSION_EXPIRY',
      'PASSWORD_RESET',
      'EMAIL_CHANGE',
      'LOCKOUT',
      'ACCOUNT_DELETION',
      'REVOKE_ALL_SESSIONS',
    ];
    for (const flow of AUTH_LIFECYCLE_FLOWS) {
      const kind = LIFECYCLE_FLOW_DESCRIPTORS[flow].destructiveStep;
      if (kind === null) continue;
      expect(keystoneKinds, flow).toContain(kind);
    }
  });

  it('requires only surfaces it can name', () => {
    expect([...LIFECYCLE_SURFACE_LIST].sort()).toEqual([...LIFECYCLE_SURFACES].sort());
    for (const flow of AUTH_LIFECYCLE_FLOWS) {
      const required = LIFECYCLE_FLOW_DESCRIPTORS[flow].requires;
      if (required === null) continue;
      expect(LIFECYCLE_SURFACES, flow).toContain(required);
    }
  });

  it('keeps the outcome list derived, and keeps GENERATED the only measured one', () => {
    expect([...AUTH_LIFECYCLE_OUTCOME_LIST].sort()).toEqual([...AUTH_LIFECYCLE_OUTCOMES].sort());
    // Derived by exclusion in the module: a tenth outcome must be decided into
    // the measured set deliberately rather than defaulting into it.
    expect(UNMEASURED_AUTH_LIFECYCLE_OUTCOMES).not.toContain('GENERATED');
    expect(UNMEASURED_AUTH_LIFECYCLE_OUTCOMES).toHaveLength(AUTH_LIFECYCLE_OUTCOMES.length - 1);
  });

  it('emits only priorities the shared vocabulary declares', () => {
    expect(lifecyclePriorities().length).toBeGreaterThan(0);
    expect(lifecyclePriorities()).toEqual(['CRITICAL_PATH', 'IMPORTANT']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('disposability is enforced by the compiler', () => {
  it('refuses a bare principal where a journey builder expects a proven target', () => {
    const bare: LifecyclePrincipal = lifecyclePrincipalFor('LOGOUT', fullContext());
    /*
     * THE ASSERTION THAT MATTERS MOST IN THIS FILE.
     *
     * `planAuthLifecycleFlow` takes a `DisposableTarget`, which carries a
     * `disposability` field a bare principal does not have. So aiming a logout
     * journey at an unproven principal is a COMPILE error, and this directive is
     * what keeps it one: if the signature is ever widened to accept a
     * `LifecyclePrincipal`, this `@ts-expect-error` has nothing to suppress and
     * `tsc` fails on the directive itself.
     */
    // @ts-expect-error a principal nobody proved disposable is not a target
    const refused = () => planAuthLifecycleFlow('LOGOUT', bare, fullContext());
    expect(typeof refused).toBe('function');
  });

  it('refuses an attempt budget aimed at a principal nobody proved disposable', () => {
    const bare: LifecyclePrincipal = lifecyclePrincipalFor('ACCOUNT_LOCKOUT', fullContext());
    /*
     * The lockout budget is the one number in this module that is spent on the
     * customer's live auth system. `attemptBudgetFor` takes a target it does not
     * use, for exactly this reason: a bound on failed sign-ins cannot be computed
     * for a principal nobody proved disposable, so a lockout journey cannot be
     * aimed at the shared account even by a caller who means to.
     */
    // @ts-expect-error a failed-sign-in budget may not be computed for an unproven principal
    const refused = () => attemptBudgetFor(bare, 3);
    expect(typeof refused).toBe('function');
  });
});

describe('the prover is the only way in', () => {
  it('records a refusal as a REFUSAL with the prover\'s own reason, never as a skip', () => {
    const enumeration = enumerateAuthLifecycle(fullContext(), refusingProver);

    // Every one of the fourteen is accounted for. A destructive scenario that
    // silently declines reads exactly like one that ran and found nothing.
    expect(enumeration.considered).toBe(14);
    expect(enumeration.generated).toBe(0);
    expect(enumeration.unmeasured).toBe(14);
    for (const result of enumeration.results) {
      expect(result.outcome, result.flow).toBe('REFUSED_NOT_DISPOSABLE');
      expect(result.outcome, result.flow).not.toBe('GENERATED');
      if (result.outcome === 'GENERATED') continue;
      expect(result.detail, result.flow).toContain('PERSISTENT_PRINCIPAL');
      expect(result.remedy.length, result.flow).toBeGreaterThan(40);
    }
  });

  it('never counts a refused flow as measured', () => {
    const enumeration = enumerateAuthLifecycle(fullContext(), refusingProver);
    expect(enumeration.results.filter(countsAsMeasured)).toHaveLength(0);
  });

  it('proposes a principal the prover can accept: DISPOSABLE, DECLARED, with a creator', () => {
    const candidate = lifecyclePrincipalFor('ACCOUNT_DELETION', fullContext());
    expect(candidate.kind).toBe('DISPOSABLE');
    // DECLARED and not ACTIVE: nothing has been created yet, and "waiting to be
    // created" is a different fact from "could not be created".
    expect(candidate.lifecycle).toBe('DECLARED');
    expect(candidate.createdByScenario).toBe('auth-lifecycle/account-deletion');
    // Null because the account does not exist yet, so there is no profile to
    // point at. The journey's own signup step brings both into being.
    expect(candidate.authProfileId).toBeNull();
  });

  it('gives every flow its own principal, so no journey can decide another\'s result', () => {
    const ctx = fullContext();
    const names = AUTH_LIFECYCLE_FLOWS.map((flow) => lifecyclePrincipalFor(flow, ctx).name);
    // A shared throwaway would mean the deletion journey decides whether the
    // logout journey can run, and the ORDER of execution would decide the result.
    expect(new Set(names).size).toBe(14);
  });

  it('never proposes the run default under another label', () => {
    const ctx = fullContext({ runDefaultPrincipalName: 'default' });
    for (const flow of AUTH_LIFECYCLE_FLOWS) {
      expect(lifecyclePrincipalFor(flow, ctx).name, flow).not.toBe('default');
    }
  });

  it('hands the run\'s default principal name to the prover on every call', () => {
    /*
     * The field would otherwise be declared, documented and never read — and the
     * comment above it says the enumeration passes it on, so a dead field here
     * would be a doc comment contradicting the code under it. It is load-bearing:
     * the fastest way to destroy the customer's account is to copy the default
     * session into a principal and label it DISPOSABLE, and the prover's second
     * argument is what refuses that.
     */
    const seen: string[] = [];
    const spy: DisposabilityProver = (candidate, runDefaultName) => {
      seen.push(runDefaultName);
      return prover(candidate, runDefaultName);
    };
    enumerateAuthLifecycle(fullContext({ runDefaultPrincipalName: 'shared-login' }), spy);
    expect(seen).toHaveLength(14);
    expect(new Set(seen)).toEqual(new Set(['shared-login']));
  });

  it('REFUSES a flow whose principal name IS the run default, under any label', () => {
    // Proved by naming the run default what this module names its throwaway: the
    // prover then refuses, and the refusal is recorded rather than skipped.
    const ctx = fullContext();
    const collidingName = lifecyclePrincipalFor('LOGOUT', ctx).name;
    const results = enumerateAuthLifecycle(
      fullContext({ runDefaultPrincipalName: collidingName }),
      prover,
    ).results;
    const logout = results.find((r) => r.flow === 'LOGOUT');
    expect(logout?.outcome).toBe('REFUSED_NOT_DISPOSABLE');
    if (logout !== undefined && logout.outcome !== 'GENERATED') {
      expect(logout.detail).toContain('IS_RUN_DEFAULT');
    }
    // And only that one: the other thirteen have different names.
    expect(results.filter((r) => r.outcome === 'GENERATED')).toHaveLength(13);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('every flow is planned when the application supports it', () => {
  it('plans all fourteen, and the counts reconcile', () => {
    const enumeration = enumerateAuthLifecycle(fullContext(), prover);
    expect(enumeration.generated).toBe(14);
    expect(enumeration.considered).toBe(14);
    expect(enumeration.unmeasured).toBe(0);
    // The parts sum to the whole. A count that does not reconcile is how a flow
    // comes to be dropped with no record at all.
    expect(enumeration.generated + enumeration.unmeasured).toBe(enumeration.considered);
  });

  it('gives every journey at least one assertion and at least one cleanup obligation', () => {
    for (const journey of everyJourney()) {
      // A journey with no assertion would be stored, counted towards coverage and
      // pass without checking anything.
      expect(journey.assertions.length, journey.flow).toBeGreaterThan(0);
      // A journey that creates an account and declares no cleanup fills the
      // customer's database a row per run.
      expect(journey.cleanup.length, journey.flow).toBeGreaterThan(0);
    }
  });

  it('starts every journey by creating its own account', () => {
    for (const journey of everyJourney()) {
      const first = journey.steps[0];
      expect(first, journey.flow).toBeDefined();
      // Step 0 is what makes `createdByScenario` TRUE rather than merely claimed:
      // the prover believes the claim and cannot see whether the journey honours
      // it. A journey that assumed an account existed would destroy something it
      // did not create.
      expect(first?.action, journey.flow).toContain('Create the disposable account');
      expect(first?.as, journey.flow).toBe(journey.principals[0]?.name);
    }
  });

  it('marks a destructive step wherever it declares one', () => {
    for (const journey of everyJourney()) {
      if (journey.destructiveStep === null) continue;
      expect(
        journey.steps.filter((s) => s.destructive).length,
        `${journey.flow} declares ${journey.destructiveStep}`,
      ).toBeGreaterThan(0);
    }
  });

  it('passes its own audit for every flow', () => {
    for (const journey of everyJourney()) {
      expect(lifecycleJourneyViolations(journey), journey.flow).toEqual([]);
    }
  });

  it('writes the password-reset chain end to end, including the old password failing', () => {
    const journey = journeyFor('PASSWORD_RESET');
    const assertions = journey.assertions.join(' | ').toLowerCase();
    // The whole point of the chain: a reset that leaves the previous credential
    // working hands the account to whoever already knew it.
    expect(assertions).toContain('old password is refused');
    expect(assertions).toContain('new password signs in');
    expect(assertions).toContain('second time');
    // Request, read, follow, set, sign in with the new, be refused with the old,
    // replay the link.
    expect(journey.steps.length).toBeGreaterThanOrEqual(9);
    expect(journey.steps.some((s) => s.outOfBand === 'LINK')).toBe(true);
  });

  it('walks logout through the browser back button, which is the half that fails', () => {
    const journey = journeyFor('LOGOUT');
    expect(journey.steps.some((s) => s.action.includes('BACK button'))).toBe(true);
    expect(journey.assertions.join(' ')).toContain('cache');
  });

  it('holds two live sessions for one principal, which was inexpressible before', () => {
    const journey = journeyFor('SESSION_REVOCATION');
    const sessions = new Set(journey.steps.map((s) => s.session));
    expect(sessions).toEqual(new Set([PRIMARY_SESSION, SECONDARY_SESSION]));
    // Both sessions belong to the SAME principal: "sign out everywhere" is about
    // one identity on two devices, not two identities.
    expect(new Set(journey.steps.map((s) => s.as)).size).toBe(1);
  });

  it('asks the replay question wherever a single-use token exists', () => {
    for (const flow of ['EMAIL_VERIFICATION', 'PASSWORD_RESET', 'MFA_RECOVERY_CODE'] as const) {
      const text = journeyFor(flow).assertions.join(' ').toLowerCase();
      // "the second use", "a second time", "twice" — the wording differs per flow
      // and the question does not: is the single-use artefact actually single-use?
      expect(text, flow).toMatch(/second (?:use|time)|twice/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a flow that cannot be driven is RECORDED, never skipped and never passed', () => {
  it('reports UNREACHABLE_BEHIND_BOT_PROTECTION, and does not offer a workaround', () => {
    const ctx = fullContext({
      botProtection: { provider: 'TURNSTILE', bypassMode: 'NOT_CONFIGURED' },
    });
    const enumeration = enumerateAuthLifecycle(ctx, prover);
    expect(enumeration.generated).toBe(0);
    for (const result of enumeration.results) {
      expect(result.outcome, result.flow).toBe('UNREACHABLE_BEHIND_BOT_PROTECTION');
      if (result.outcome === 'GENERATED') continue;
      // The honest answer names the provider and the three legitimate routes
      // past it, every one of which is an action the OWNER of the environment
      // takes on their own system.
      expect(result.remedy).toContain('test keys');
      expect(result.detail).toContain('not solved, evaded or worked around');
    }
  });

  it('accepts a configured bypass as a reason to proceed, without ever sending one', () => {
    // The bypass VALUE is a vault reference on the environment row and never
    // reaches this module; all it learns is that a legitimate route exists.
    const ctx = fullContext({
      botProtection: { provider: 'TURNSTILE', bypassMode: 'SIGNED_BYPASS_HEADER' },
    });
    expect(enumerateAuthLifecycle(ctx, prover).generated).toBe(14);
  });

  it('reports UNREACHABLE_NO_DISPOSABLE_PRINCIPAL for every flow when there is no signup', () => {
    const ctx = fullContext({
      observedSurfaces: ALL_SURFACES.filter((s) => s !== 'SIGNUP_FORM'),
    });
    const enumeration = enumerateAuthLifecycle(ctx, prover);
    expect(enumeration.generated).toBe(0);
    expect(enumeration.unmeasured).toBe(14);
    for (const result of enumeration.results) {
      // Not "the signup page is missing" for one flow: with no signup there is
      // no account this suite may destroy, so NONE of the fourteen can run.
      expect(result.outcome, result.flow).toBe('UNREACHABLE_NO_DISPOSABLE_PRINCIPAL');
    }
  });

  it('separates an invite-only signup from a missing one, because the remedies differ', () => {
    const invite = enumerateAuthLifecycle(fullContext({ signupInviteOnly: true }), prover);
    const missing = enumerateAuthLifecycle(
      fullContext({ observedSurfaces: ALL_SURFACES.filter((s) => s !== 'SIGNUP_FORM') }),
      prover,
    );
    const detailOf = (e: AuthLifecycleEnumeration) => {
      const first = e.results[0];
      return first !== undefined && first.outcome !== 'GENERATED' ? first.detail : '';
    };
    expect(detailOf(invite)).toContain('invitation');
    expect(detailOf(missing)).toContain('no signup form');
    expect(detailOf(invite)).not.toBe(detailOf(missing));
  });

  it('reports a missing surface as NOT FOUND rather than as absent, per flow', () => {
    const ctx = fullContext({
      observedSurfaces: ALL_SURFACES.filter((s) => s !== 'LOGOUT_CONTROL'),
    });
    const enumeration = enumerateAuthLifecycle(ctx, prover);
    const logout = enumeration.results.find((r) => r.flow === 'LOGOUT');
    expect(logout?.outcome).toBe('UNREACHABLE_SURFACE_NOT_ENUMERATED');
    if (logout !== undefined && logout.outcome !== 'GENERATED') {
      expect(logout.detail).toContain('sign-out control');
      // "A surface we could not reach and one the application does not have are
      // opposite facts" — the remedy says so rather than implying absence.
      expect(logout.remedy).toContain('not found rather');
    }
    // The other thirteen are unaffected: one missing control does not blank the group.
    expect(enumeration.generated).toBe(13);
  });

  it('refuses the session flows when no authenticated route was enumerated', () => {
    const enumeration = enumerateAuthLifecycle(fullContext({ authenticatedRoute: null }), prover);
    for (const flow of ['LOGOUT', 'SESSION_EXPIRY', 'SESSION_REVOCATION', 'ACCOUNT_DELETION'] as const) {
      const result = enumeration.results.find((r) => r.flow === flow);
      expect(result?.outcome, flow).toBe('UNREACHABLE_SURFACE_NOT_ENUMERATED');
      if (result !== undefined && result.outcome !== 'GENERATED') {
        // A journey that asserts the absence of a page it never found passes
        // whether the session survived or not. That is the pass this prevents.
        expect(result.detail, flow).toContain('nothing to re-request');
      }
    }
  });

  it('reports UNREACHABLE_NO_MAIL_SINK for the out-of-band flows and nothing else', () => {
    const enumeration = enumerateAuthLifecycle(fullContext({ mailSink: null }), prover);
    const needsMail = AUTH_LIFECYCLE_FLOWS.filter(
      (f) => LIFECYCLE_FLOW_DESCRIPTORS[f].needsOutOfBandMessage,
    );
    expect(needsMail.length).toBeGreaterThan(0);
    for (const result of enumeration.results) {
      const expected = needsMail.includes(result.flow)
        ? 'UNREACHABLE_NO_MAIL_SINK'
        : 'GENERATED';
      expect(result.outcome, result.flow).toBe(expected);
    }
  });

  it('does not tell a customer with a working mail catcher to configure a mail catcher', () => {
    /*
     * A configured sink IS the MAILBOX_POLL capability. Treating them as two
     * independent facts produced exactly that sentence.
     */
    const ctx = fullContext({ capabilities: ['BROWSER', 'TOTP_CLOCK'] });
    const verification = enumerateAuthLifecycle(ctx, prover).results.find(
      (r) => r.flow === 'EMAIL_VERIFICATION',
    );
    expect(verification?.outcome).toBe('GENERATED');
  });

  it('reports UNREACHABLE_MISSING_CAPABILITY with the house remedy for the MFA flows', () => {
    const ctx = fullContext({ capabilities: ['BROWSER', 'MAILBOX_POLL'] });
    const enumeration = enumerateAuthLifecycle(ctx, prover);
    for (const flow of ['MFA_ENROLMENT', 'MFA_RECOVERY_CODE'] as const) {
      const result = enumeration.results.find((r) => r.flow === flow);
      expect(result?.outcome, flow).toBe('UNREACHABLE_MISSING_CAPABILITY');
      if (result !== undefined && result.outcome !== 'GENERATED') {
        expect(result.detail, flow).toContain('TOTP_CLOCK');
        // AUTH_CAPABILITY_REMEDY.TOTP_CLOCK — the sentence the house already
        // wrote, rather than a second one that would drift from it.
        expect(result.remedy, flow).toContain('seedSecretName');
        // And it says what QAAI does NOT do with the seed.
        expect(result.remedy, flow).toContain('never stores one');
      }
    }
    expect(enumeration.generated).toBe(12);
  });

  it('treats an undeclared session lifetime as UNKNOWN, never as "never expires"', () => {
    const result = enumerateAuthLifecycle(
      fullContext({ sessionLifetimeSeconds: null }),
      prover,
    ).results.find((r) => r.flow === 'SESSION_EXPIRY');
    expect(result?.outcome).toBe('UNREACHABLE_NO_USABLE_SESSION_LIFETIME');
    if (result !== undefined && result.outcome !== 'GENERATED') {
      expect(result.detail).toContain('"we were not told", not "never expires"');
    }
  });

  it('refuses a session lifetime no test could outlast, and names the ceiling', () => {
    const result = enumerateAuthLifecycle(
      fullContext({ sessionLifetimeSeconds: 1_800 }),
      prover,
    ).results.find((r) => r.flow === 'SESSION_EXPIRY');
    expect(result?.outcome).toBe('UNREACHABLE_NO_USABLE_SESSION_LIFETIME');
    if (result !== undefined && result.outcome !== 'GENERATED') {
      expect(result.detail).toContain('1800s');
      expect(result.detail).toContain(`${SESSION_WAIT_CEILING_SECONDS}s`);
    }
  });

  it('carries a remedy on every single absence, across every degraded context', () => {
    const contexts: AuthLifecycleContext[] = [
      fullContext({ mailSink: null }),
      fullContext({ capabilities: ['BROWSER'] }),
      fullContext({ sessionLifetimeSeconds: null }),
      fullContext({ authenticatedRoute: null }),
      fullContext({ observedSurfaces: [] }),
      fullContext({ signupInviteOnly: true }),
      fullContext({ botProtection: { provider: 'WAF', bypassMode: 'NOT_CONFIGURED' } }),
    ];
    for (const ctx of contexts) {
      for (const result of enumerateAuthLifecycle(ctx, prover).results) {
        if (result.outcome === 'GENERATED') continue;
        // A REFUSED or UNEXERCISABLE surface recorded without what it would take
        // to exercise it is a dead end the customer's only response to is distrust.
        expect(result.remedy.trim().length, `${result.flow}/${result.outcome}`).toBeGreaterThan(40);
        expect(result.detail.trim().length, `${result.flow}/${result.outcome}`).toBeGreaterThan(20);
      }
    }
  });

  it('can actually produce every outcome it declares', () => {
    /*
     * Exhaustiveness over the declared union, the same shape the keystone uses
     * for its refusal reasons. An outcome that cannot be produced is either dead
     * vocabulary or a path somebody forgot to wire — and a reader cannot tell
     * which from the list alone.
     */
    const seen = new Set<string>();
    const contexts: AuthLifecycleContext[] = [
      fullContext(),
      fullContext({ observedSurfaces: ALL_SURFACES.filter((s) => s !== 'SIGNUP_FORM') }),
      fullContext({ observedSurfaces: ALL_SURFACES.filter((s) => s !== 'MFA_ENROLMENT') }),
      fullContext({ botProtection: { provider: 'RECAPTCHA', bypassMode: 'NOT_CONFIGURED' } }),
      fullContext({ mailSink: null }),
      fullContext({ capabilities: ['BROWSER', 'MAILBOX_POLL'] }),
      fullContext({ sessionLifetimeSeconds: null }),
      // A harvested route carrying a token in its query string. See the
      // suppression test below for why this is a real crawl outcome.
      fullContext({ authenticatedRoute: '/d?token=0123456789abcdef0123456789abcdef' }),
    ];
    for (const ctx of contexts) {
      for (const result of enumerateAuthLifecycle(ctx, prover).results) seen.add(result.outcome);
    }
    for (const result of enumerateAuthLifecycle(fullContext(), refusingProver).results) {
      seen.add(result.outcome);
    }

    expect([...seen].sort()).toEqual([...AUTH_LIFECYCLE_OUTCOME_LIST].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the lockout bound', () => {
  it('burns one attempt past a declared threshold, to see the lock fire AT it', () => {
    const budget = attemptBudgetFor(targetFor('ACCOUNT_LOCKOUT', fullContext()), 3);
    expect(budget.attempts).toBe(4);
    expect(budget.declaredThreshold).toBe(3);
    expect(budget.capped).toBe(false);
    expect(budget.capReason).toBeNull();
  });

  it('DISCLOSES the cap as a count AND a reason when the ceiling bites', () => {
    const budget = attemptBudgetFor(targetFor('ACCOUNT_LOCKOUT', fullContext()), 50);
    expect(budget.attempts).toBe(LOCKOUT_ATTEMPT_CEILING);
    expect(budget.capped).toBe(true);
    // A cap applied without being disclosed is on the short list of lies this
    // product cannot afford.
    expect(budget.capReason).toContain(String(LOCKOUT_ATTEMPT_CEILING));
    expect(budget.capReason).toContain('51');
    expect(budget.capReason).toContain('inconclusive');
  });

  it('never exceeds the ceiling, whatever it is handed', () => {
    const target = targetFor('ACCOUNT_LOCKOUT', fullContext());
    for (const declared of [null, 0, 1, 7, 8, 9, 1_000]) {
      const budget = attemptBudgetFor(target, declared);
      expect(budget.attempts, `declared ${String(declared)}`).toBeLessThanOrEqual(budget.ceiling);
    }
  });

  it('burns the ceiling, not infinity, when no threshold was declared', () => {
    const budget = attemptBudgetFor(targetFor('ACCOUNT_LOCKOUT', fullContext()), null);
    expect(budget.attempts).toBe(LOCKOUT_ATTEMPT_CEILING);
    expect(budget.capped).toBe(false);
  });

  it('makes a negative lockout result INCONCLUSIVE and not a pass', () => {
    const undeclared = journeyFor('ACCOUNT_LOCKOUT', fullContext({ declaredLockoutThreshold: null }));
    expect(undeclared.inconclusiveIf).toContain('UNKNOWN, not a pass');
    expect(undeclared.inconclusiveIf).toContain('no lockout threshold was declared');

    const declared = journeyFor('ACCOUNT_LOCKOUT', fullContext({ declaredLockoutThreshold: 3 }));
    expect(declared.inconclusiveIf).toContain('UNKNOWN, not a pass');
    expect(declared.inconclusiveIf).toContain('declared threshold is 3');
  });

  it('bounds the three flows that burn failed credential checks, and only those', () => {
    const budgeted = everyJourney()
      .filter((j) => j.attemptBudget !== null)
      .map((j) => j.flow)
      .sort();
    expect(budgeted).toEqual(
      [
        'ACCOUNT_LOCKOUT',
        'LOCKOUT_UNLOCK',
        'LOGIN',
        'MFA_ENROLMENT',
        'PASSWORD_CHANGE',
      ].sort(),
    );
  });

  it('lets a caller tighten the ceiling but reports what that cost', () => {
    const journey = journeyFor(
      'ACCOUNT_LOCKOUT',
      fullContext({ declaredLockoutThreshold: 5, limits: { lockoutAttemptCeiling: 2 } }),
    );
    expect(journey.attemptBudget?.attempts).toBe(2);
    expect(journey.attemptBudget?.capped).toBe(true);
    expect(journey.attemptBudget?.capReason).toContain('cannot reach');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces byte-identical enumerations for the same seed', () => {
    const ctx = fullContext();
    const a = enumerateAuthLifecycle(ctx, prover);
    const b = enumerateAuthLifecycle(ctx, prover);
    // No clock, no randomness, no ambient state. A generator that is not
    // reproducible produces a suite nobody can debug.
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });

  it('produces a DIFFERENT account for a different seed, which is what lets signup run twice', () => {
    const one = enumerateAuthLifecycle(fullContext({ runSeed: 'run_A' }), prover);
    const two = enumerateAuthLifecycle(fullContext({ runSeed: 'run_B' }), prover);
    const names = (e: AuthLifecycleEnumeration) =>
      e.results.map((r) => (r.outcome === 'GENERATED' ? r.journey.principals[0]?.name : null));
    expect(names(two)).not.toEqual(names(one));
  });

  it('keeps the scope stable, because the runner re-derives the values from it', () => {
    // The journey records the SCOPE and never the value. If this string moved,
    // the runner would derive a different password from the same plan and the
    // signup step would succeed while the login step failed.
    expect(syntheticScopeFor('PASSWORD_RESET')).toBe('auth-lifecycle/password-reset');
    for (const journey of everyJourney()) {
      expect(journey.syntheticScope, journey.flow).toBe(syntheticScopeFor(journey.flow));
    }
  });

  it('keeps journey ids stable across calls and distinct across flows', () => {
    const first = everyJourney().map((j) => j.id);
    const second = everyJourney().map((j) => j.id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('orders the report by the declared outcome list, so two runs can be diffed', () => {
    const ctx = fullContext({ mailSink: null, capabilities: ['BROWSER'] });
    const a = describeAuthLifecycle(enumerateAuthLifecycle(ctx, prover));
    const b = describeAuthLifecycle(enumerateAuthLifecycle(ctx, prover));
    expect(b).toBe(a);
    expect(a).toContain('none of them is a pass');

    /*
     * Stability across two calls is NOT enough, and finding that out cost a
     * surviving mutant: reversing the declared order still produces two
     * identical paragraphs, because both calls then reverse it the same way.
     * What has to be asserted is that the order is the DECLARED one — so a
     * change to the loop is a deliberate change to a stated order rather than a
     * silent change to a paragraph nobody can diff against last week's.
     */
    const positions = AUTH_LIFECYCLE_OUTCOME_LIST.map((o) => a.indexOf(`— ${o}`)).filter(
      (i) => i >= 0,
    );
    expect(positions.length).toBeGreaterThan(1);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('nothing here can hold a secret', () => {
  it('REFUSES a context carrying a credential, as an excess property', () => {
    const base = fullContext();
    /*
     * The structural guarantee, asserted rather than commented. A credential is
     * NAMED here (by `authProfileId` on a principal, or by a `Secret.name`
     * reference on the auth profile) and never carried. Adding any of these
     * fields to `AuthLifecycleContext` turns these passing directives into
     * compile errors — which is the point: a field a secret could sit in would
     * have to be added deliberately, past six failing tests.
     */
    // @ts-expect-error a context may not carry a password
    const withPassword: AuthLifecycleContext = { ...base, password: 'hunter2' };
    // @ts-expect-error a context may not carry a TOTP secret
    const withTotp: AuthLifecycleContext = { ...base, totpSecret: 'JBSWY3DP' };
    // @ts-expect-error a context may not carry a one-time code
    const withOtp: AuthLifecycleContext = { ...base, otp: '418210' };
    // @ts-expect-error a context may not carry a reset token
    const withReset: AuthLifecycleContext = { ...base, resetToken: 'tok_abc' };
    // @ts-expect-error a context may not carry a session cookie
    const withCookie: AuthLifecycleContext = { ...base, sessionCookie: 'sid=1' };
    // @ts-expect-error a context may not carry a Playwright storageState
    const withState: AuthLifecycleContext = { ...base, storageState: {} };

    expect(
      [withPassword, withTotp, withOtp, withReset, withCookie, withState].every(
        (c) => c.runSeed === base.runSeed,
      ),
    ).toBe(true);
  });

  it('finds no credential shape anywhere in any of the fourteen journeys', () => {
    for (const journey of everyJourney()) {
      expect(lifecycleJourneyViolations(journey), journey.flow).toEqual([]);
    }
  });

  it('puts no credential in a journey id, a title or a test name', () => {
    for (const journey of everyJourney()) {
      // Ids and titles end up in a database, a cockpit and a Playwright test
      // name. A secret in a test name is a secret in a CI log.
      expect(journey.id, journey.flow).toMatch(/^authlc-[a-z-]+-[0-9a-z]{6}$/);
      expect(journey.title, journey.flow).not.toMatch(/[0-9a-f]{16,}/);
    }
  });

  it('records the scope a value comes from, never the value', () => {
    const journey = journeyFor('PASSWORD_RESET');
    const everything = JSON.stringify(journey);
    // The steps TALK about the password at length and never contain one.
    expect(everything).toContain('auth-lifecycle/password-reset');
    expect(everything).toContain('not written into this plan');
    expect(everything).not.toMatch(/password["']?\s*[:=]\s*["']?\S/i);
  });

  it('keeps the generated address at the configured sink domain, not a stranger\'s', () => {
    const journey = journeyFor('PASSWORD_RESET');
    expect(journey.recipient).toMatch(/@mail\.test$/);
    // And it is traceable: the run token is in the address, so a row left in a
    // staging database can be tied back to the run that made it.
    expect(journey.recipient).toMatch(/[0-9a-z]{6}/);
  });

  it('catches a credential a future edit interpolates, and does NOT quote it', () => {
    const journey = journeyFor('LOGIN');
    const leaky: AuthLifecycleJourney = {
      ...journey,
      assertions: [...journey.assertions, 'sign in with password=hunter2-abcdef and continue'],
    };
    const violations = lifecycleJourneyViolations(leaky);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join(' ')).toContain('a named credential with a value beside it');
    // A finding that prints the credential it found IS the leak it was reporting.
    expect(violations.join(' ')).not.toContain('hunter2');
    expect(violations.join(' ')).toContain('deliberately not quoted');
  });

  /*
   * THE BLIND SIDE THE HEADER PROMISED WAS TESTED AND WAS NOT.
   *
   * `journeyStrings`'s own comment says "the test that asserts this function
   * sees every string field is what makes that a deliberate decision instead of
   * an omission" — and no such test existed, while three principal fields went
   * unscanned. A JWT in `role` or `createdByScenario` passed the belt clean.
   *
   * This drives the belt through EVERY string-bearing field by name, so a field
   * added to the journey and forgotten in `journeyStrings` fails here.
   */
  it('scans every string field of a journey, so the belt has no blind side', () => {
    const journey = journeyFor('LOGIN');
    const JWT = 'eyJhbGciOiJIUzI1NiJ9.leaked-payload.signature';

    const mutate: ReadonlyArray<[string, AuthLifecycleJourney]> = [
      ['title', { ...journey, title: JWT }],
      ['rationale', { ...journey, rationale: JWT }],
      ['assertions[]', { ...journey, assertions: [JWT] }],
      ['steps[].action', {
        ...journey,
        steps: journey.steps.map((step, i) => (i === 0 ? { ...step, action: JWT } : step)),
      }],
      ['cleanup[].action', {
        ...journey,
        cleanup: journey.cleanup.map((c, i) => (i === 0 ? { ...c, action: JWT } : c)),
      }],
      ['principals[].role', {
        ...journey,
        principals: journey.principals.map((pr, i) => (i === 0 ? { ...pr, role: JWT } : pr)),
      }],
      ['principals[].createdByScenario', {
        ...journey,
        principals: journey.principals.map((pr, i) =>
          i === 0 ? { ...pr, createdByScenario: JWT } : pr,
        ),
      }],
    ];

    for (const [field, leaky] of mutate) {
      const violations = lifecycleJourneyViolations(leaky);
      expect(violations.join(' '), `${field} is not scanned by the credential belt`).toContain(
        'a JSON web token',
      );
      // And never quoted, in every field — the rule is not per call site.
      expect(violations.join(' '), field).not.toContain('leaked-payload');
    }
  });

  it('catches a bearer token, a JWT and a long hex run', () => {
    const journey = journeyFor('LOGIN');
    const cases: ReadonlyArray<[string, string]> = [
      ['Authorization: Bearer abcdefghijklmnop', 'an Authorization header value'],
      ['eyJhbGciOiJIUzI1NiJ9.payload', 'a JSON web token'],
      ['the id is 0123456789abcdef0123456789abcdef', 'a long hexadecimal run'],
    ];
    for (const [text, shape] of cases) {
      const violations = lifecycleJourneyViolations({ ...journey, assertions: [text] });
      expect(violations.join(' '), text).toContain(shape);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the out-of-band value cannot be printed by accident', () => {
  const secret = 'rst_9f3a-TOKEN-do-not-log';

  it('does not survive JSON.stringify', () => {
    const value = outOfBandValue('LINK', `https://app.test/reset?token=${secret}`);
    const serialised = JSON.stringify({ value });
    expect(serialised).not.toContain(secret);
    expect(serialised).toContain('not shown');
  });

  it('does not survive template interpolation or String()', () => {
    const value = outOfBandValue('CODE', '418210');
    expect(`${value}`).not.toContain('418210');
    expect(String(value)).not.toContain('418210');
    expect(`${value}`).toContain('6-character one-time code');
  });

  it('is not an own property, so a spread and Object.values cannot reach it', () => {
    const value = outOfBandValue('CODE', secret);
    // The secret lives in a CLOSURE. There is nothing to spread, nothing to
    // enumerate and nothing for an instrumented logger to serialise.
    expect(JSON.stringify(Object.values({ ...value }).map(String))).not.toContain(secret);
    expect(Object.keys(value).sort()).toEqual(
      ['describe', 'kind', 'reveal', 'toJSON', 'toString'].sort(),
    );
  });

  it('describes a LINK by its origin and SHAPE, because the token is in the path or the query', () => {
    const value = outOfBandValue('LINK', `https://app.test/account/reset/${secret}?u=1&v=2`);
    const described = value.describe();
    expect(described).not.toContain(secret);
    expect(described).toContain('https://app.test');
    expect(described).toContain('3 path segments');
    expect(described).toContain('2 query parameters');
  });

  it('does not echo a link it cannot parse — the error path is where tokens leak', () => {
    const value = outOfBandValue('LINK', `not-a-url-${secret}`);
    expect(value.describe()).not.toContain(secret);
    expect(value.describe()).toContain('could not be parsed');
  });

  it('still reveals the exact value through its one named door', () => {
    // `reveal()` is the one door and it is named so `grep -n 'reveal()'` finds
    // every use. Its result goes into a browser field and nowhere else.
    expect(outOfBandValue('CODE', '418210').reveal()).toBe('418210');
  });
});

describe('extracting a code or a link', () => {
  it('prefers the first capture group, falling back to the whole match', () => {
    const grouped = extractOutOfBand('CODE', message({ text: 'Your code is 418210.' }), 'code is (\\d{6})');
    expect(grouped.found).toBe(true);
    if (grouped.found) expect(grouped.value.reveal()).toBe('418210');

    const whole = extractOutOfBand('CODE', message({ text: 'Your code is 418210.' }), '\\d{6}');
    expect(whole.found).toBe(true);
    if (whole.found) expect(whole.value.reveal()).toBe('418210');
  });

  it('calls an invalid pattern OUR configuration error, not a message that did not arrive', () => {
    const result = extractOutOfBand('CODE', message(), '(unclosed');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe('PATTERN_INVALID');
      expect(result.detail).toContain('configuration error on our side');
    }
  });

  it('reports NO_MATCH without quoting the body, which carries the credential', () => {
    const result = extractOutOfBand(
      'LINK',
      message({ text: `Use https://app.test/verify?token=${'s3cr3t-value-here'}` }),
      'nothing-matches-this',
    );
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe('NO_MATCH');
      expect(result.detail).not.toContain('s3cr3t');
      expect(result.detail).toContain('deliberately not quoted');
    }
  });

  it('refuses an empty capture rather than returning a value that is not one', () => {
    const result = extractOutOfBand('CODE', message({ text: 'code: ' }), 'code: (\\d*)');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toBe('EMPTY_MATCH');
  });

  it('declares exactly the two artefacts a lifecycle message can carry', () => {
    expect([...OUT_OF_BAND_KINDS]).toEqual(['CODE', 'LINK']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('awaiting a delivered message', () => {
  /** A sink whose answers are scripted, so a polling loop is testable at all. */
  function scriptedSink(
    answers: ReadonlyArray<readonly CaughtMessage[] | Error>,
  ): MailSink & { calls: () => number } {
    let i = 0;
    return {
      endpoint: 'http://mail.test/__mail',
      calls: () => i,
      search: async () => {
        const answer = answers[Math.min(i, answers.length - 1)];
        i += 1;
        if (answer instanceof Error) throw answer;
        return answer ?? [];
      },
    };
  }

  const recipient = 'someone@mail.test';
  const fresh = message({ to: recipient, receivedAtIso: '2026-06-15T12:00:05.000Z' });

  it('returns the message, and discloses how many reads it took', async () => {
    const sink = scriptedSink([[], [], [fresh]]);
    const clock = fakeClock();
    const result = await awaitOutOfBandMessage({
      sink,
      clock,
      recipient,
      requestedAtMs: Date.parse('2026-06-15T12:00:00.000Z'),
      timeoutMs: 10_000,
      pollIntervalMs: 500,
    });
    expect(result.delivered).toBe(true);
    if (result.delivered) {
      expect(result.message.to).toBe(recipient);
      expect(result.attempts).toBe(3);
      // Not a real second passed. An injected clock is what makes this testable.
      expect(result.waitedMs).toBe(1_000);
    }
  });

  it('distinguishes a DEAD SINK from an application that sent nothing', async () => {
    /*
     * THE DEFECT THIS CLOSES. `waitForMail` in email-otp.ts swallows every error
     * and returns null, so a catcher that is down is reported as
     * "No email reached <address> within 30s" — a statement about the CUSTOMER'S
     * application, with their mailer as the thing to go and debug.
     */
    const dead = scriptedSink([new Error('ECONNREFUSED')]);
    const clock = fakeClock();
    const result = await awaitOutOfBandMessage({
      sink: dead,
      clock,
      recipient,
      requestedAtMs: 0,
      timeoutMs: 2_000,
      pollIntervalMs: 500,
    });
    expect(result.delivered).toBe(false);
    if (!result.delivered) {
      expect(result.reason).toBe('SINK_UNAVAILABLE');
      expect(result.detail).toContain('our dependency, not your application');
      expect(result.detail).toContain('no conclusion');
      // The error KIND, never its message: a sink error can carry a URL with a
      // token in its query string.
      expect(result.detail).toContain('Error');
      expect(result.detail).not.toContain('ECONNREFUSED');
    }
  });

  it('reports TIMED_OUT once the sink has answered at least once', async () => {
    // One transient error during startup must not turn an honest timeout into
    // "our dependency is broken". One successful read is enough.
    const flaky = scriptedSink([new Error('ECONNREFUSED'), [], []]);
    const result = await awaitOutOfBandMessage({
      sink: flaky,
      clock: fakeClock(),
      recipient,
      requestedAtMs: 0,
      timeoutMs: 2_000,
      pollIntervalMs: 500,
    });
    expect(result.delivered).toBe(false);
    if (!result.delivered) {
      expect(result.reason).toBe('TIMED_OUT');
      expect(result.detail).toContain('answered');
      expect(result.attempts).toBeGreaterThan(1);
    }
  });

  it('ignores a message addressed to somebody else', async () => {
    const sink = scriptedSink([[message({ to: 'other@mail.test', receivedAtIso: '2026-06-15T12:00:05.000Z' })]]);
    const result = await awaitOutOfBandMessage({
      sink,
      clock: fakeClock(),
      recipient,
      requestedAtMs: Date.parse('2026-06-15T12:00:00.000Z'),
      timeoutMs: 1_000,
      pollIntervalMs: 500,
    });
    expect(result.delivered).toBe(false);
  });

  it('ignores a message older than the request, so a previous run cannot satisfy this one', async () => {
    const stale = message({ to: recipient, receivedAtIso: '2020-01-01T00:00:00.000Z' });
    const result = await awaitOutOfBandMessage({
      sink: scriptedSink([[stale]]),
      clock: fakeClock(),
      recipient,
      requestedAtMs: Date.parse('2026-06-15T12:00:00.000Z'),
      timeoutMs: 1_000,
      pollIntervalMs: 500,
    });
    // A test that accepts an old message passes without the application having
    // sent anything — a pass that means "we did not check".
    expect(result.delivered).toBe(false);
  });

  it('accepts a message stamped inside the clock-skew grace, and names the grace', async () => {
    const requestedAtMs = Date.parse('2026-06-15T12:00:00.000Z');
    const slightlyEarly = message({
      to: recipient,
      receivedAtIso: new Date(requestedAtMs - MESSAGE_CLOCK_SKEW_GRACE_MS + 10).toISOString(),
    });
    const result = await awaitOutOfBandMessage({
      sink: scriptedSink([[slightlyEarly]]),
      clock: fakeClock(),
      recipient,
      requestedAtMs,
      timeoutMs: 1_000,
      pollIntervalMs: 500,
    });
    // The application server's clock is not ours. Without this, a journey times
    // out waiting for mail that already arrived.
    expect(result.delivered).toBe(true);
  });

  it('never sleeps past the deadline', async () => {
    const clock = fakeClock();
    const result = await awaitOutOfBandMessage({
      sink: scriptedSink([[]]),
      clock,
      recipient,
      requestedAtMs: 0,
      timeoutMs: 1_200,
      pollIntervalMs: 500,
    });
    expect(result.delivered).toBe(false);
    // A poll loop that overshoots its own timeout is how a 30s wait becomes 45s
    // in a suite with a 30s per-test budget.
    expect(clock.elapsed()).toBeLessThanOrEqual(1_200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the self-audit', () => {
  it('rejects a journey with no assertions', () => {
    const journey = { ...journeyFor('LOGIN'), assertions: [] };
    expect(lifecycleJourneyViolations(journey).join(' ')).toContain('no assertions');
  });

  it('rejects a journey with no cleanup obligation', () => {
    const journey = { ...journeyFor('LOGIN'), cleanup: [] };
    expect(lifecycleJourneyViolations(journey).join(' ')).toContain('no cleanup obligation');
  });

  it('rejects a step acting as a principal the journey never declared', () => {
    const journey = journeyFor('LOGOUT');
    const steps = journey.steps.map((s, i) => (i === 2 ? { ...s, as: 'somebody-else' } : s));
    expect(lifecycleJourneyViolations({ ...journey, steps }).join(' ')).toContain('somebody-else');
  });

  it('rejects a journey that declares a destructive step and marks none', () => {
    const journey = journeyFor('ACCOUNT_DELETION');
    const steps = journey.steps.map((s) => ({ ...s, destructive: false }));
    expect(lifecycleJourneyViolations({ ...journey, steps }).join(' ')).toContain(
      'no step is marked destructive',
    );
  });

  it('rejects an attempt budget that reports a cap with no reason beside it', () => {
    const journey = journeyFor('ACCOUNT_LOCKOUT');
    const budget = journey.attemptBudget;
    expect(budget).not.toBeNull();
    if (budget === null) return;
    const violations = lifecycleJourneyViolations({
      ...journey,
      attemptBudget: { ...budget, capped: true, capReason: null },
    });
    expect(violations.join(' ')).toContain('without being disclosed');
  });

  it('rejects a budget that would burn past its own ceiling', () => {
    const journey = journeyFor('ACCOUNT_LOCKOUT');
    const budget = journey.attemptBudget;
    if (budget === null) return;
    const violations = lifecycleJourneyViolations({
      ...journey,
      attemptBudget: { ...budget, attempts: 500, ceiling: 8, capped: true, capReason: 'x' },
    });
    expect(violations.join(' ')).toContain('past its own ceiling');
  });

  it('rejects a fixed sleep in the plain English, before it becomes one in code', () => {
    const journey = journeyFor('SESSION_EXPIRY');
    const steps = journey.steps.map((s, i) =>
      i === 2 ? { ...s, action: 'Wait 90 seconds for the session to expire.' } : s,
    );
    const violations = lifecycleJourneyViolations({ ...journey, steps });
    // Caught where the sentence is still editable. Left in, the admission gate
    // refuses the generated test with no clue the plan asked for it.
    expect(violations.join(' ')).toContain('fixed sleep');
  });

  it('does not flag the real SESSION_EXPIRY step, which polls to a declared deadline', () => {
    const journey = journeyFor('SESSION_EXPIRY');
    expect(lifecycleJourneyViolations(journey)).toEqual([]);
    expect(journey.steps.some((s) => s.action.includes('not a fixed sleep'))).toBe(true);
  });

  it('SUPPRESSES a journey the audit rejects, rather than storing it', () => {
    /*
     * THE PATH THIS COVERS, and it is not hypothetical.
     *
     * The crawl harvests URLs as it finds them, and a route can arrive with a
     * token in its query string — a share link, a preview link, a magic-link
     * landing page. That string is interpolated into the steps and assertions of
     * every flow that re-requests an authenticated route, so without an audit on
     * the way OUT, a harvested credential would be written into the customer's
     * repository inside a generated test name and a Playwright assertion.
     *
     * Suppressing is the right answer. Suppressing SILENTLY is not, which is why
     * this is an outcome with a count behind it and not a `return null`.
     */
    const ctx = fullContext({
      authenticatedRoute: '/dashboard?token=0123456789abcdef0123456789abcdef',
    });
    const result = planAuthLifecycleFlow('LOGOUT', targetFor('LOGOUT', ctx), ctx);
    expect(result.outcome).toBe('SUPPRESSED_SELF_AUDIT');
    if (result.outcome !== 'GENERATED') {
      expect(result.detail).toContain('failed its own audit');
      expect(result.detail).toContain('long hexadecimal run');
      // The finding names the shape and never quotes the match.
      expect(result.detail).not.toContain('0123456789abcdef');
      // And it is OUR bug, said plainly, rather than filed as a fact about them.
      expect(result.remedy).toContain('defect in QAAI, not in your application');
    }
  });

  it('counts a suppression as unmeasured, never as a pass', () => {
    expect(AUTH_LIFECYCLE_OUTCOMES).toContain('SUPPRESSED_SELF_AUDIT');
    expect(UNMEASURED_AUTH_LIFECYCLE_OUTCOMES).toContain('SUPPRESSED_SELF_AUDIT');
    expect(
      countsAsMeasured({
        flow: 'LOGIN',
        outcome: 'SUPPRESSED_SELF_AUDIT',
        detail: 'x',
        remedy: 'y',
      }),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the report', () => {
  it('says all fourteen when all fourteen were planned', () => {
    const text = describeAuthLifecycle(enumerateAuthLifecycle(fullContext(), prover));
    expect(text).toContain('All 14');
    expect(text).toContain('throwaway accounts this suite creates and deletes');
  });

  it('names what was NOT measured, rather than reporting a flattering fraction', () => {
    const ctx = fullContext({ mailSink: null });
    const text = describeAuthLifecycle(enumerateAuthLifecycle(ctx, prover));
    // "10 of 14 covered" with the other four unexplained is the number that makes
    // a customer stop reading.
    expect(text).toContain('of 14');
    expect(text).toContain('were not measured');
    expect(text).toContain('UNREACHABLE_NO_MAIL_SINK');
    expect(text).toContain('PASSWORD_RESET');
    expect(text).toContain('none of them is a pass');
  });

  it('reconciles the fraction it prints with the counts it was given', () => {
    const ctx = fullContext({ capabilities: ['BROWSER'] });
    const enumeration = enumerateAuthLifecycle(ctx, prover);
    const text = describeAuthLifecycle(enumeration);
    expect(text).toContain(`${enumeration.generated} of ${enumeration.considered}`);
    expect(text).toContain(`other ${enumeration.unmeasured}`);
  });
});
