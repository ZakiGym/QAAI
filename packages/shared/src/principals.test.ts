import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_PRINCIPAL,
  DEFAULT_PRINCIPAL_NAME,
  DESTRUCTIVE_STEP_KINDS,
  DESTRUCTIVE_STEP_KIND_LIST,
  DISPOSABILITY_REFUSAL_REASONS,
  DISPOSABILITY_REFUSAL_REASON_LIST,
  PRINCIPAL_KINDS,
  PRINCIPAL_KIND_LIST,
  PRINCIPAL_LIFECYCLES,
  PRINCIPAL_LIFECYCLE_LIST,
  PROBE_REFUSAL_REASONS,
  PROBE_REFUSAL_REASON_LIST,
  SAFE_PROBE_METHODS,
  SESSIONED_LIFECYCLES,
  UNMEASURED_LIFECYCLES,
  admitCrossTenantProbe,
  bindDestructiveStep,
  describePrincipal,
  hadSession,
  isSafeProbeMethod,
  principal,
  proveDisposable,
  tenantPair,
} from './principals';
import type { DestructiblePrincipal, DestructiveStep, Principal, TenantRef } from './principals';
import {
  destructiveStepSchema,
  principalKindSchema,
  principalLifecycleSchema,
  principalSchema,
  testAuthBindingSchema,
} from './schemas';
import { runSessions } from './types';

const ACME: TenantRef = { id: 'tenant-acme', label: 'Acme' };
const GLOBEX: TenantRef = { id: 'tenant-globex', label: 'Globex' };

/** A principal the scenario created and may destroy. The only shape that passes. */
function throwaway(over: Partial<Principal> = {}): Principal {
  return principal({
    name: 'signup-victim',
    kind: 'DISPOSABLE',
    lifecycle: 'ACTIVE',
    createdByScenario: 'password-reset-walk',
    tenant: ACME,
    ...over,
  });
}

/*
 * ── The parity guards ───────────────────────────────────────────────────────
 *
 * Each vocabulary has TWO mechanisms and each catches what the other cannot. A
 * `Record<Union, true>` in principals.ts makes the COMPILER refuse a member
 * with no entry, which is why `*_LIST` is derived rather than hand-written. The
 * tests below are the RUN-TIME half: zod's `.options` exist only at run time, so
 * nothing but an assertion can compare them.
 *
 * Both halves are needed, and the cost of having only one is measured: eight
 * `GateRule` kinds shipped UNSAVEABLE for two slices — present in the union,
 * absent from the zod write path — and `check:wiring` cannot see that class of
 * defect, because a union member with no write path is live code in a file that
 * is reached.
 */
describe('principal vocabulary parity', () => {
  it('derives PRINCIPAL_KIND_LIST from the presence record, in declaration order', () => {
    expect(PRINCIPAL_KIND_LIST).toEqual([...PRINCIPAL_KINDS]);
  });

  it('gives principalKindSchema one option per kind, and no others', () => {
    expect(principalKindSchema.options.slice().sort()).toEqual([...PRINCIPAL_KINDS].sort());
  });

  it('derives PRINCIPAL_LIFECYCLE_LIST from the presence record, in declaration order', () => {
    expect(PRINCIPAL_LIFECYCLE_LIST).toEqual([...PRINCIPAL_LIFECYCLES]);
  });

  it('gives principalLifecycleSchema one option per lifecycle, and no others', () => {
    expect(principalLifecycleSchema.options.slice().sort()).toEqual(
      [...PRINCIPAL_LIFECYCLES].sort(),
    );
  });

  it('derives DESTRUCTIVE_STEP_KIND_LIST from the presence record', () => {
    expect(DESTRUCTIVE_STEP_KIND_LIST).toEqual([...DESTRUCTIVE_STEP_KINDS]);
  });

  it('derives both refusal-reason lists from their presence records', () => {
    expect(DISPOSABILITY_REFUSAL_REASON_LIST).toEqual([...DISPOSABILITY_REFUSAL_REASONS]);
    expect(PROBE_REFUSAL_REASON_LIST).toEqual([...PROBE_REFUSAL_REASONS]);
  });

  it('refuses a kind the union does not have', () => {
    expect(principalKindSchema.safeParse('SEMI_DISPOSABLE').success).toBe(false);
  });
});

describe('lifecycle sets', () => {
  it('counts exactly one lifecycle as holding a session', () => {
    // If a second ever qualifies it must be a decision, not an accident: the
    // cross-tenant sweep accepts a denial as evidence only from a principal in
    // one of these states, and widening the set silently makes a signed-out
    // 401 read as an authorization control working.
    expect(SESSIONED_LIFECYCLES).toEqual(['ACTIVE']);
  });

  it('never lets a lifecycle be both sessioned and unmeasured', () => {
    const both = SESSIONED_LIFECYCLES.filter((s) => UNMEASURED_LIFECYCLES.includes(s));
    expect(both).toEqual([]);
  });

  it('separates "never got started" from "ran and ended the session"', () => {
    // hadSession is what stops a scenario that never provisioned an actor being
    // reported beside one that logged out on purpose.
    expect(hadSession('DECLARED')).toBe(false);
    expect(hadSession('PROVISION_FAILED')).toBe(false);
    expect(hadSession('DESTRUCTION_REFUSED')).toBe(false);
    expect(hadSession('SIGNED_OUT')).toBe(true);
    expect(hadSession('LOCKED_OUT')).toBe(true);
    expect(hadSession('DESTROYED')).toBe(true);
  });
});

/*
 * ── Disposability ───────────────────────────────────────────────────────────
 *
 * The highest-stakes behaviour in the file. The customer has ONE account, six
 * agents are about to write destructive scenarios in parallel, and the only
 * thing standing between those two facts is this function.
 */
describe('proveDisposable', () => {
  it('admits a principal the scenario created', () => {
    const result = proveDisposable(throwaway());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.kind).toBe('DISPOSABLE');
    expect(result.principal.disposability.createdByScenario).toBe('password-reset-walk');
    expect(result.principal.disposability.tenantId).toBe(ACME.id);
  });

  it('REFUSES the customer’s own account', () => {
    const result = proveDisposable(principal({ name: 'owner', kind: 'PERSISTENT' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('PERSISTENT_PRINCIPAL');
    // The remedy has to be in the sentence: a refusal a customer cannot act on
    // reads as the product refusing to do its job.
    expect(result.detail).toContain('disposable');
  });

  it('refuses an anonymous principal as NOT APPLICABLE rather than forbidden', () => {
    // The distinction is the point. An anonymous actor has no account to
    // destroy, so this is not a destructive step that was refused — it is not a
    // destructive step, and recording it as forbidden would put an
    // unexercisable surface in the same bucket as an exercisable one.
    const result = proveDisposable(ANONYMOUS_PRINCIPAL);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ANONYMOUS_PRINCIPAL');
    expect(result.detail).toContain('not applicable');
  });

  it('refuses the run default even when it claims to be disposable', () => {
    // The fastest way to delete the customer's account is to copy the shared
    // session into a principal and label it DISPOSABLE. This is that check.
    const result = proveDisposable(
      throwaway({ name: DEFAULT_PRINCIPAL_NAME, createdByScenario: 'definitely-mine' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('IS_RUN_DEFAULT');
  });

  /*
   * THE HOLE THIS CLOSED, found by an adversarial pass rather than by review.
   *
   * The comparison used to be `candidate.name === runDefaultName`, and
   * `principalSchema` does not trim a name. So every spelling below was handed
   * back as a DestructiblePrincipal bound to the customer's shared session —
   * the exact act the test above says this check exists to stop, defeated by a
   * capital letter. A plan item written by a model arrives with whatever
   * spelling the model chose.
   */
  it('refuses the run default however its name is cased or padded', () => {
    for (const spelling of ['Default', 'DEFAULT', ' default', 'default ', 'default\t', ' DeFaUlT ']) {
      const result = proveDisposable(
        throwaway({ name: spelling, createdByScenario: 'definitely-mine' }),
      );
      expect(result.ok, `${JSON.stringify(spelling)} was admitted as destructible`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('IS_RUN_DEFAULT');
    }
  });

  it('refuses a renamed shared session however ITS name is cased or padded', () => {
    for (const spelling of ['Shared', 'SHARED', ' shared ']) {
      const result = proveDisposable(throwaway({ name: spelling }), 'shared');
      expect(result.ok, `${JSON.stringify(spelling)} was admitted as destructible`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('IS_RUN_DEFAULT');
    }
  });

  it('still admits a name that merely RESEMBLES the default, so the guard is not a blanket', () => {
    const result = proveDisposable(throwaway({ name: 'default-2' }));
    expect(result.ok).toBe(true);
  });

  it('honours a run whose default session is filed under another name', () => {
    const result = proveDisposable(throwaway({ name: 'shared' }), 'shared');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('IS_RUN_DEFAULT');
  });

  it('refuses a disposability claim with no creating scenario', () => {
    for (const creator of [null, '', '   ']) {
      const result = proveDisposable(throwaway({ createdByScenario: creator }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('NO_CREATING_SCENARIO');
    }
  });

  it('refuses a second destruction, so one act cannot report two successes', () => {
    const result = proveDisposable(throwaway({ lifecycle: 'DESTROYED' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ALREADY_DESTROYED');
  });

  it('refuses an actor that never existed, separately from one already gone', () => {
    for (const lifecycle of ['PROVISION_FAILED', 'UNAVAILABLE'] as const) {
      const result = proveDisposable(throwaway({ lifecycle }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('NEVER_PROVISIONED');
    }
  });

  /*
   * Exhaustiveness, which is the test a hand-written list of cases cannot be.
   * A seventh refusal reason added to the union and never produced by any code
   * path is a reason no report can ever print — the vocabulary would claim a
   * distinction the implementation does not make.
   */
  it('can actually produce every refusal reason it declares', () => {
    const produced = new Set<string>();
    const fixtures: Principal[] = [
      principal({ name: 'owner', kind: 'PERSISTENT' }),
      ANONYMOUS_PRINCIPAL,
      throwaway({ createdByScenario: null }),
      throwaway({ name: DEFAULT_PRINCIPAL_NAME }),
      throwaway({ lifecycle: 'DESTROYED' }),
      throwaway({ lifecycle: 'PROVISION_FAILED' }),
    ];
    for (const fixture of fixtures) {
      const result = proveDisposable(fixture);
      if (!result.ok) produced.add(result.reason);
    }
    expect([...produced].sort()).toEqual([...DISPOSABILITY_REFUSAL_REASON_LIST].sort());
  });
});

/*
 * ── The compile-time half of the guarantee ──────────────────────────────────
 *
 * These assertions are checked by `tsc`, not by vitest: a `@ts-expect-error`
 * that does NOT error is itself a compile error, so each one fails loudly the
 * moment the guarantee is weakened. That is what makes the disposability rail a
 * type-level guarantee rather than a convention — and it is why this block
 * exists even though it asserts nothing at run time.
 */
describe('disposability is enforced by the compiler', () => {
  it('refuses a PERSISTENT principal where a destructive step is expected', () => {
    const step: DestructiveStep<string> = (target) => target.name;
    const persistent = principal({ name: 'owner', kind: 'PERSISTENT' });

    /*
     * A Principal is not a DestructiblePrincipal: it carries no
     * DisposabilityProof, and only proveDisposable can mint one. THE NEXT TWO
     * LINES ARE THE GUARANTEE. If the directive ever becomes unused, the
     * compiler stopped refusing a destructive step aimed at the customer's own
     * account, and `tsc` fails on the unused directive — which is why this is a
     * compile-time assertion and not a run-time one.
     *
     * The directive must sit on the line IMMEDIATELY above the code. An earlier
     * draft had four lines of `//` explanation between them, which silently made
     * it apply to a comment and report as unused.
     */
    // @ts-expect-error — see above: this is the guarantee.
    step(persistent);

    // Routed properly, it compiles and runs.
    const proof = proveDisposable(throwaway());
    expect(proof.ok && step(proof.principal)).toBe('signup-victim');
  });

  it('refuses a hand-forged proof', () => {
    const base = throwaway();
    /*
     * DisposabilityProof's witness is a module-private `unique symbol` that is
     * never exported, so no other module can name the key — a forged proof is
     * missing it, and the compiler says so (TS2741).
     */
    const forged: DestructiblePrincipal = {
      ...base,
      kind: 'DISPOSABLE',
      // @ts-expect-error — TS2741 lands on THIS property, not on the
      // declaration, so the directive belongs here: the witness is missing and
      // cannot be written from outside principals.ts.
      disposability: { principalName: 'x', createdByScenario: 'y', tenantId: null },
    };
    expect(forged.name).toBe('signup-victim');
  });
});

describe('bindDestructiveStep', () => {
  it('does not run the step when disposability cannot be proved', () => {
    let ran = false;
    const bound = bindDestructiveStep('ACCOUNT_DELETION', principal({ name: 'owner' }), () => {
      ran = true;
      return 'deleted';
    });
    expect(bound.permitted).toBe(false);
    expect(ran).toBe(false);
    if (bound.permitted) return;
    // The refusal is a VALUE that reaches the report, not a throw that becomes a
    // skipped test. A skipped destructive scenario is indistinguishable from one
    // that ran and found nothing.
    expect(bound.refusal.reason).toBe('PERSISTENT_PRINCIPAL');
    expect(bound.kind).toBe('ACCOUNT_DELETION');
  });

  it('runs the step, lazily, when it is permitted', () => {
    let ran = false;
    const bound = bindDestructiveStep('LOGOUT', throwaway(), (target) => {
      ran = true;
      return target.disposability.createdByScenario;
    });
    expect(bound.permitted).toBe(true);
    // Lazy: binding must not perform the destruction, or a caller that inspects
    // the binding before deciding has already destroyed the actor.
    expect(ran).toBe(false);
    if (!bound.permitted) return;
    expect(bound.run()).toBe('password-reset-walk');
    expect(ran).toBe(true);
  });
});

/*
 * ── Cross-tenant probes ─────────────────────────────────────────────────────
 *
 * Read-only and safe-verb by default. Every refusal is a surface recorded as
 * NOT PERFORMED with its reason; none of them is a pass and none is a zero.
 * "0 cross-tenant leaks" over a sweep that never ran is the lie this guards.
 */
describe('admitCrossTenantProbe', () => {
  const holder = principal({ name: 'acme-admin', lifecycle: 'ACTIVE', tenant: ACME });
  const subject = principal({ name: 'globex-admin', lifecycle: 'ACTIVE', tenant: GLOBEX });

  it('admits a safe-verb sweep across two distinct tenants', () => {
    const result = admitCrossTenantProbe({ method: 'get', holder, subject, subjectIdCount: 14 });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.method).toBe('GET');
    expect(result.tenants.distinct).toBe(true);
  });

  it('refuses every verb that could mutate another tenant’s data', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const result = admitCrossTenantProbe({ method, holder, subject, subjectIdCount: 3 });
      expect(result.admitted).toBe(false);
      if (result.admitted) continue;
      expect(result.reason).toBe('UNSAFE_VERB');
    }
  });

  it('treats POST as unsafe even though many read-only endpoints are POST', () => {
    // A deliberate false negative, stated in the module and asserted here so it
    // cannot be "fixed" without reading the argument: the alternative is a sweep
    // that writes to another tenant's data, and no report format makes that
    // acceptable.
    expect(isSafeProbeMethod('POST')).toBe(false);
    expect([...SAFE_PROBE_METHODS]).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });

  it('refuses a sweep of one tenant against itself', () => {
    const result = admitCrossTenantProbe({
      method: 'GET',
      holder,
      subject: principal({ name: 'acme-member', lifecycle: 'ACTIVE', tenant: ACME }),
      subjectIdCount: 9,
    });
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe('SAME_TENANT');
    expect(result.detail).toContain('proves nothing');
  });

  it('refuses rather than comparing a null tenant against a null tenant', () => {
    const result = admitCrossTenantProbe({
      method: 'GET',
      holder: principal({ name: 'a', lifecycle: 'ACTIVE' }),
      subject: principal({ name: 'b', lifecycle: 'ACTIVE' }),
      subjectIdCount: 5,
    });
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe('NO_TENANCY');
  });

  it('refuses when the asking principal has no session, so a denial proves nothing', () => {
    const result = admitCrossTenantProbe({
      method: 'GET',
      holder: principal({ name: 'acme-admin', lifecycle: 'SIGNED_OUT', tenant: ACME }),
      subject,
      subjectIdCount: 5,
    });
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe('NO_HOLDER_SESSION');
  });

  it('refuses a sweep over zero ids instead of reporting it as clean', () => {
    const result = admitCrossTenantProbe({ method: 'GET', holder, subject, subjectIdCount: 0 });
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe('NO_SUBJECT_IDS');
  });

  it('can actually produce every probe refusal reason it declares', () => {
    const produced = new Set<string>();
    const cases = [
      { method: 'DELETE', holder, subject, subjectIdCount: 1 },
      { method: 'GET', holder, subject: principal({ name: 'c', lifecycle: 'ACTIVE', tenant: ACME }), subjectIdCount: 1 },
      { method: 'GET', holder: principal({ name: 'd', lifecycle: 'ACTIVE' }), subject, subjectIdCount: 1 },
      { method: 'GET', holder: principal({ name: 'e', lifecycle: 'SIGNED_OUT', tenant: ACME }), subject, subjectIdCount: 1 },
      { method: 'GET', holder, subject, subjectIdCount: 0 },
    ];
    for (const input of cases) {
      const result = admitCrossTenantProbe(input);
      if (!result.admitted) produced.add(result.reason);
    }
    expect([...produced].sort()).toEqual([...PROBE_REFUSAL_REASON_LIST].sort());
  });
});

describe('tenantPair', () => {
  it('compares on id and never on the human label', () => {
    // Two tenants a customer legitimately gave the same display name must still
    // compare as distinct, or the sweep between them is silently dropped.
    const pair = tenantPair({ id: 'a', label: 'Head Office' }, { id: 'b', label: 'Head Office' });
    expect(pair.distinct).toBe(true);
  });
});

describe('describePrincipal', () => {
  it('names the actor, its role, its tenant and its state', () => {
    const line = describePrincipal(
      principal({ name: 'memberA', role: 'member', tenant: ACME, lifecycle: 'ACTIVE' }),
    );
    expect(line).toBe('memberA (member in Acme, ACTIVE)');
  });

  it('falls back to the tenant id when there is no label', () => {
    const line = describePrincipal(
      principal({ name: 'x', role: 'admin', tenant: { id: 'tenant-7', label: null } }),
    );
    expect(line).toContain('tenant-7');
  });

  it('says what an unlabelled principal is without claiming it is anonymous', () => {
    // role null is NOT anonymous — the same distinction AuthProfile.role draws.
    expect(describePrincipal(principal({ name: 'u' }))).toBe('u (persistent, DECLARED)');
    expect(describePrincipal(ANONYMOUS_PRINCIPAL)).toBe('<anonymous> (anonymous, ACTIVE)');
  });
});

/*
 * ── RunContext.sessions ─────────────────────────────────────────────────────
 *
 * The compatibility hinge. `storageState` must keep meaning what it meant, and
 * no consumer should ever have to decide which of the two fields to trust.
 */
describe('runSessions', () => {
  it('synthesises a default entry from the legacy storageState', () => {
    const sessions = runSessions({ storageState: { cookies: [] }, authProfileId: 'ap_1' });
    expect(Object.keys(sessions)).toEqual([DEFAULT_PRINCIPAL_NAME]);
    const entry = sessions[DEFAULT_PRINCIPAL_NAME];
    expect(entry?.principal.kind).toBe('PERSISTENT');
    expect(entry?.principal.authProfileId).toBe('ap_1');
    expect(entry?.storageState).toEqual({ cookies: [] });
  });

  it('records a null storageState as the ANONYMOUS session, not as a missing one', () => {
    // "No entry" and "we could not sign in" are different facts and only one is
    // a problem. Collapsing them makes a legitimately anonymous run look broken.
    const sessions = runSessions({ storageState: null });
    expect(sessions[DEFAULT_PRINCIPAL_NAME]?.principal.kind).toBe('ANONYMOUS');
    expect(sessions[DEFAULT_PRINCIPAL_NAME]?.storageState).toBeNull();
  });

  it('lets an explicit default session win over the legacy field', () => {
    const explicit = {
      [DEFAULT_PRINCIPAL_NAME]: {
        principal: principal({ name: DEFAULT_PRINCIPAL_NAME, role: 'admin' }),
        storageState: { cookies: ['explicit'] },
        expiresAtIso: null,
      },
    };
    const sessions = runSessions({ storageState: { cookies: ['legacy'] }, sessions: explicit });
    expect(sessions[DEFAULT_PRINCIPAL_NAME]?.principal.role).toBe('admin');
  });

  it('keeps named principals beside the synthesised default', () => {
    const sessions = runSessions({
      storageState: { cookies: [] },
      sessions: {
        victim: {
          principal: throwaway({ name: 'victim' }),
          storageState: { cookies: ['v'] },
          expiresAtIso: '2026-12-01T00:00:00.000Z',
        },
      },
    });
    expect(Object.keys(sessions).sort()).toEqual([DEFAULT_PRINCIPAL_NAME, 'victim']);
  });
});

/*
 * ── The zod write paths ─────────────────────────────────────────────────────
 */
describe('principalSchema', () => {
  it('accepts a well-formed disposable principal', () => {
    expect(principalSchema.safeParse(throwaway()).success).toBe(true);
  });

  it('REFUSES an extra property rather than silently dropping it', () => {
    // `.strict()` on purpose. A dropped secret is a secret the sender still
    // believes was stored, and it reached our logs on the way to being dropped.
    const result = principalSchema.safeParse({ ...throwaway(), password: 'hunter2' });
    expect(result.success).toBe(false);
  });

  it('refuses an anonymous principal that names a credential', () => {
    const result = principalSchema.safeParse({
      ...principal({ name: 'nobody', kind: 'ANONYMOUS' }),
      authProfileId: 'ap_1',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a disposability claim with no creating scenario', () => {
    const result = principalSchema.safeParse(throwaway({ createdByScenario: null }));
    expect(result.success).toBe(false);
  });
});

describe('destructiveStepSchema', () => {
  it('accepts a step aimed at a disposable principal', () => {
    const result = destructiveStepSchema.safeParse({
      kind: 'PASSWORD_RESET',
      target: throwaway(),
      intent: 'reset the password of an account this scenario created',
    });
    expect(result.success).toBe(true);
  });

  it('REFUSES a step aimed at the customer’s own account', () => {
    // The second half of the guarantee. The compiler covers code written here;
    // this covers a row arriving over HTTP or out of a model's tool call, which
    // is the path the compiler cannot see.
    const result = destructiveStepSchema.safeParse({
      kind: 'ACCOUNT_DELETION',
      target: principal({ name: 'owner', kind: 'PERSISTENT' }),
      intent: 'delete the account',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('PERSISTENT');
  });

  it('refuses a step aimed at an anonymous principal as meaningless', () => {
    const result = destructiveStepSchema.safeParse({
      kind: 'LOGOUT',
      target: ANONYMOUS_PRINCIPAL,
      intent: 'log out',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a step aimed at an already destroyed principal', () => {
    const result = destructiveStepSchema.safeParse({
      kind: 'LOGOUT',
      target: throwaway({ lifecycle: 'DESTROYED' }),
      intent: 'log out again',
    });
    expect(result.success).toBe(false);
  });
});

describe('testAuthBindingSchema', () => {
  it('accepts a binding whose profile belongs to the same project', () => {
    const result = testAuthBindingSchema.safeParse({
      projectId: 'p1',
      authProfileId: 'ap_1',
      authProfileProjectId: 'p1',
    });
    expect(result.success).toBe(true);
  });

  it('REFUSES a binding to an auth profile from another project', () => {
    /*
     * The quietest defect in the round. Nothing raises an error today: the run
     * resolves a session for another application, browses this one anonymously,
     * passes, and is counted as authenticated coverage of a page it never
     * reached.
     */
    const result = testAuthBindingSchema.safeParse({
      projectId: 'p1',
      authProfileId: 'ap_1',
      authProfileProjectId: 'p2',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a binding whose profile could not be resolved at all', () => {
    const result = testAuthBindingSchema.safeParse({
      projectId: 'p1',
      authProfileId: 'ap_1',
      authProfileProjectId: null,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an anonymous test, which is most tests', () => {
    const result = testAuthBindingSchema.safeParse({ projectId: 'p1' });
    expect(result.success).toBe(true);
  });

  it('refuses two principals sharing a name', () => {
    // They would collide in RunContext.sessions and the test would silently act
    // as a single identity — a two-actor authorization test that tests nothing.
    const result = testAuthBindingSchema.safeParse({
      projectId: 'p1',
      principals: [throwaway({ name: 'victim' }), throwaway({ name: 'victim' })],
    });
    expect(result.success).toBe(false);
  });
});
