/**
 * The tests for the runner-side principal resolver.
 *
 * TWO THINGS ARE BEING PINNED HERE AND THEY ARE BOTH LOAD-BEARING.
 *
 * The first is the refusal. A missing or expired session must produce a typed
 * NOT_RUN and never a pass, never an anonymous run and never a SKIP, because
 * the whole reason an auth-gated route can look covered is that an anonymous
 * browser arriving at it gets a login page that a loose assertion passes. Every
 * failure arm below is a separate test for that one sentence.
 *
 * The second is the secrecy, and it is asserted with a SENTINEL: the fixture
 * storageState carries a string that exists nowhere else in the repo, and the
 * tests assert it appears in no serialisation, no error message, no plan and no
 * description. A rule about not logging credentials is worth nothing at the
 * sixth call site; a test that fails the moment one reaches a string is worth
 * something.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOT_RUN_KINDS, isNotRunKind, parseNotRun, runSessions } from '@qaai/shared';
import type { ExecutableTest, RunContext } from '@qaai/shared';
import {
  PRINCIPAL_CAVEAT_LIST,
  PRINCIPAL_CAVEATS,
  PRINCIPAL_NEED_LIST,
  PRINCIPAL_NEEDS,
  PRINCIPAL_RESOLUTION_FAILURE_LIST,
  PRINCIPAL_RESOLUTION_FAILURES,
  RUNNER_DEFAULT_PRINCIPAL_NAME,
  describePrincipalFailures,
  describeRunSessions,
  isPrincipalResolutionFailure,
  notRunKindFor,
  principalContextPlans,
  principalStorageStateFileName,
  requiredPrincipals,
  resolvePrincipals,
} from './principals.js';
import type { RunSessionEntry, SessionPrincipal } from './principals.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * THE SENTINEL. A string that appears in no other file in this repo, planted
 * inside the fixture's storageState so that any path which leaks a credential
 * leaks something greppable instead of something plausible.
 */
const SECRET = 'qaai-sentinel-session-cookie-5Qv3Nx-DO-NOT-LEAK';
const STATE = { cookies: [{ name: 'sid', value: SECRET, domain: 'app.test' }] };

const NOW = Date.parse('2026-07-01T12:00:00.000Z');
const LATER = '2026-07-01T20:00:00.000Z';
const EARLIER = '2026-07-01T04:00:00.000Z';

function actor(over: Partial<SessionPrincipal> & { name: string }): SessionPrincipal {
  return {
    kind: 'PERSISTENT',
    lifecycle: 'ACTIVE',
    role: null,
    authProfileId: null,
    authProfileKind: null,
    tenant: null,
    createdByScenario: null,
    ...over,
  };
}

function entry(over: Partial<RunSessionEntry> & { principal: SessionPrincipal }): RunSessionEntry {
  return { storageState: STATE, expiresAtIso: LATER, ...over };
}

type Ctx = Pick<RunContext, 'storageState' | 'sessions' | 'authProfileId'>;

function ctx(over: Partial<Ctx> = {}): Ctx {
  return { storageState: null, ...over };
}

type Test = Pick<ExecutableTest, 'id' | 'authProfileId' | 'authProfileRequired' | 'principals'>;

function test_(over: Partial<Test> = {}): Test {
  return { id: 't1', ...over };
}

/** A run that resolved the admin session properly, the way the worker should. */
function adminRun(over: Partial<RunSessionEntry> = {}): Ctx {
  return ctx({
    storageState: null,
    authProfileId: 'ap-admin',
    sessions: {
      [RUNNER_DEFAULT_PRINCIPAL_NAME]: entry({
        principal: actor({
          name: RUNNER_DEFAULT_PRINCIPAL_NAME,
          role: 'admin',
          authProfileId: 'ap-admin',
        }),
        ...over,
      }),
    },
  });
}

const ADMIN_TEST = test_({ authProfileId: 'ap-admin', authProfileRequired: true });

// ─── Vocabulary parity ───────────────────────────────────────────────────────

describe('principal resolution vocabulary parity', () => {
  it('derives every list from its presence record', () => {
    expect(PRINCIPAL_NEED_LIST).toEqual([...PRINCIPAL_NEEDS]);
    expect(PRINCIPAL_RESOLUTION_FAILURE_LIST).toEqual([...PRINCIPAL_RESOLUTION_FAILURES]);
    expect(PRINCIPAL_CAVEAT_LIST).toEqual([...PRINCIPAL_CAVEATS]);
  });

  it('spells the default principal the way runSessions does', () => {
    /*
     * The drift guard. `RUNNER_DEFAULT_PRINCIPAL_NAME` lives in principals.ts, which
     * is not on the @qaai/shared barrel yet, so this module declares the name
     * locally — and a rename over there would otherwise make this resolver look
     * for a session under a name nothing files one under, turning every
     * existing single-session run into a BLOCKED_BY_ENV overnight.
     */
    expect(Object.keys(runSessions({ storageState: STATE }))).toEqual([
      RUNNER_DEFAULT_PRINCIPAL_NAME,
    ]);
  });

  it('narrows an untrusted failure reason', () => {
    for (const reason of PRINCIPAL_RESOLUTION_FAILURE_LIST) {
      expect(isPrincipalResolutionFailure(reason)).toBe(true);
    }
    for (const value of ['', 'NOPE', null, 42, {}]) {
      expect(isPrincipalResolutionFailure(value)).toBe(false);
    }
  });
});

// ─── What a test owes us ─────────────────────────────────────────────────────

describe('requiredPrincipals', () => {
  it('synthesises the default requirement from the test\'s own binding', () => {
    expect(requiredPrincipals(test_({ authProfileId: 'ap-admin' }))).toEqual([
      {
        name: RUNNER_DEFAULT_PRINCIPAL_NAME,
        role: null,
        authProfileId: 'ap-admin',
        need: 'SESSION_REQUIRED',
        isDefault: true,
      },
    ]);
  });

  it('still requires a session when the BINDING is gone and the intent is not', () => {
    /*
     * The broken-binding case: `onDelete: SetNull` nulled `authProfileId` and
     * left `authProfileRequired` true. The one thing such a test must never do
     * is run anonymously and pass, so it still owes us a session.
     */
    const [req] = requiredPrincipals(test_({ authProfileRequired: true }));
    expect(req?.need).toBe('SESSION_REQUIRED');
    expect(req?.authProfileId).toBeNull();
  });

  it('owes nothing for a test with no binding and no declared intent', () => {
    expect(requiredPrincipals(test_())).toEqual([]);
  });

  it('lets a NAMED default replace the synthesised one rather than sit beside it', () => {
    const reqs = requiredPrincipals(
      test_({
        authProfileId: 'ap-admin',
        principals: [
          actor({ name: RUNNER_DEFAULT_PRINCIPAL_NAME, role: 'admin', authProfileId: 'ap-other' }),
        ],
      }),
    );
    /*
     * Two requirements under one name is two sessions that can disagree about
     * one identity — the defect `runSessions` removes one level up. Goes red if
     * the synthesised default is pushed unconditionally.
     */
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.authProfileId).toBe('ap-other');
  });

  it('orders named principals by name, so the plan is stable', () => {
    const reqs = requiredPrincipals(
      test_({
        principals: [
          actor({ name: 'victim', authProfileId: 'ap-b' }),
          actor({ name: 'attacker', authProfileId: 'ap-a' }),
        ],
      }),
    );
    expect(reqs.map((r) => r.name)).toEqual(['attacker', 'victim']);
  });

  it('decides the three needs, and only one of them owes a session', () => {
    const reqs = requiredPrincipals(
      test_({
        principals: [
          actor({ name: 'anon', kind: 'ANONYMOUS' }),
          actor({ name: 'bound', authProfileId: 'ap-a' }),
          actor({ name: 'fresh', kind: 'DISPOSABLE', createdByScenario: 'signup' }),
          actor({ name: 'orphan' }),
        ],
      }),
    );
    const need = (name: string) => reqs.find((r) => r.name === name)?.need;
    // A session for the anonymous baseline would be the bug, not the fix.
    expect(need('anon')).toBe('ANONYMOUS_BY_DESIGN');
    expect(need('bound')).toBe('SESSION_REQUIRED');
    // Refusing this one makes signup, password-reset and lockout unrunnable.
    expect(need('fresh')).toBe('PROVISIONED_BY_SCENARIO');
    // PERSISTENT with no profile claims to be somebody and has no way to be.
    expect(need('orphan')).toBe('SESSION_REQUIRED');
  });

  it('reads an ANONYMOUS principal by its KIND even when it carries a profile', () => {
    // A contradiction in the plan item. The honest reading is the field whose
    // whole purpose is to say "this actor has no account".
    const [req] = requiredPrincipals(
      test_({ principals: [actor({ name: 'anon', kind: 'ANONYMOUS', authProfileId: 'ap-a' })] }),
    );
    expect(req?.need).toBe('ANONYMOUS_BY_DESIGN');
  });
});

// ─── The refusal ─────────────────────────────────────────────────────────────

describe('resolvePrincipals refuses rather than degrading to anonymous', () => {
  it('resolves a healthy admin session', () => {
    const resolution = resolvePrincipals(adminRun(), ADMIN_TEST, { nowMs: NOW });
    expect(resolution.ok).toBe(true);
    expect(resolution.notRun).toBeNull();
    expect(resolution.failures).toEqual([]);
    expect(resolution.resolved).toEqual([
      {
        name: RUNNER_DEFAULT_PRINCIPAL_NAME,
        role: 'admin',
        authProfileId: 'ap-admin',
        need: 'SESSION_REQUIRED',
        hasStorageState: true,
        expiresAtIso: LATER,
      },
    ]);
    expect(resolution.storageStateFor(RUNNER_DEFAULT_PRINCIPAL_NAME)).toBe(STATE);
  });

  it('REFUSES an expired session — the nightly-run defect, named', () => {
    /*
     * The register's sentence: "an 8-hour TTL that is never refreshed and an
     * expired session silently degrading every nightly run". This is that run.
     * The session expired at 04:00, it is now 12:00, and the old behaviour was
     * to inject it anyway, land on a login page and pass.
     */
    const resolution = resolvePrincipals(adminRun({ expiresAtIso: EARLIER }), ADMIN_TEST, {
      nowMs: NOW,
    });
    expect(resolution.ok).toBe(false);
    expect(resolution.failures.map((f) => f.reason)).toEqual(['SESSION_EXPIRED']);
    expect(resolution.notRun?.kind).toBe('BLOCKED_BY_ENV');
    // Nothing resolved, so there is nothing for the harness to open a context
    // with — a plan here would be an anonymous context under an admin's name.
    expect(resolution.resolved).toEqual([]);
    expect(principalContextPlans(resolution)).toEqual([]);
    expect(resolution.storageStateFor(RUNNER_DEFAULT_PRINCIPAL_NAME)).toBeNull();
  });

  it('refuses a session that expires exactly now', () => {
    // The boundary is <=, not <: a session whose stated life ends at this
    // instant is not one to start a navigation with.
    const resolution = resolvePrincipals(
      adminRun({ expiresAtIso: new Date(NOW).toISOString() }),
      ADMIN_TEST,
      { nowMs: NOW },
    );
    expect(resolution.failures.map((f) => f.reason)).toEqual(['SESSION_EXPIRED']);
  });

  it('refuses a missing session', () => {
    const resolution = resolvePrincipals(ctx(), ADMIN_TEST, { nowMs: NOW });
    expect(resolution.failures.map((f) => f.reason)).toEqual(['NO_SESSION']);
    expect(resolution.notRun?.kind).toBe('BLOCKED_BY_ENV');
  });

  it('refuses a session belonging to another profile', () => {
    const run = ctx({
      storageState: null,
      authProfileId: 'ap-member',
      sessions: {
        [RUNNER_DEFAULT_PRINCIPAL_NAME]: entry({
          principal: actor({
            name: RUNNER_DEFAULT_PRINCIPAL_NAME,
            role: 'member',
            authProfileId: 'ap-member',
          }),
        }),
      },
    });
    const resolution = resolvePrincipals(run, ADMIN_TEST, { nowMs: NOW });
    /*
     * Running it would execute an admin test as a member, which does not fail
     * loudly — it signs in successfully as the wrong person and asserts
     * whatever that person can see.
     */
    expect(resolution.failures.map((f) => f.reason)).toEqual(['WRONG_PROFILE']);
  });

  it('refuses a session nothing attributed, exactly as the harness already does', () => {
    const run = ctx({
      storageState: null,
      sessions: {
        [RUNNER_DEFAULT_PRINCIPAL_NAME]: entry({
          principal: actor({ name: RUNNER_DEFAULT_PRINCIPAL_NAME }),
        }),
      },
    });
    const resolution = resolvePrincipals(run, ADMIN_TEST, { nowMs: NOW });
    /*
     * `missingRoleSession` requires `supplied === declared`, so it refuses this
     * too. Two resolvers that disagree about whether a test may run is two
     * answers to one question, and the test runs under whichever the code path
     * reached.
     */
    expect(resolution.failures.map((f) => f.reason)).toEqual(['UNATTRIBUTED_SESSION']);
    expect(resolution.failures[0]?.notRun.why).toContain('attachAuthProfile');
  });

  it('refuses an entry that carries no browser state', () => {
    const resolution = resolvePrincipals(adminRun({ storageState: null }), ADMIN_TEST, {
      nowMs: NOW,
    });
    /*
     * A bypass-token profile authenticates a REQUEST and gives a browser
     * nothing. The entry exists, so NO_SESSION would be the wrong sentence, and
     * running it is an anonymous run under an authenticated name.
     */
    expect(resolution.failures.map((f) => f.reason)).toEqual(['ANONYMOUS_SESSION']);
  });

  it('refuses a blank principal name', () => {
    const resolution = resolvePrincipals(
      adminRun(),
      test_({ principals: [actor({ name: '  ', authProfileId: 'ap-admin' })] }),
      { nowMs: NOW },
    );
    expect(resolution.failures.map((f) => f.reason)).toEqual(['BLANK_NAME']);
    // The environment is fine; the input is not.
    expect(resolution.notRun?.kind).toBe('UNSUPPORTED');
  });

  it('refuses two principals with one name', () => {
    const resolution = resolvePrincipals(
      adminRun(),
      test_({
        principals: [
          actor({ name: 'dup', authProfileId: 'ap-a' }),
          actor({ name: 'dup', authProfileId: 'ap-b' }),
        ],
      }),
      { nowMs: NOW },
    );
    expect(resolution.failures.map((f) => f.reason)).toEqual(['DUPLICATE_NAME']);
    expect(resolution.notRun?.kind).toBe('UNSUPPORTED');
  });

  it('reports a malformed principal list AS malformed, not as a dead environment', () => {
    /*
     * Resolved in one pass, the session lookups came first: a test naming two
     * actors `dup` produced NO_SESSION for the first and DUPLICATE_NAME for the
     * second, so the headline was BLOCKED_BY_ENV — "your staging box is down" —
     * about a plan item nobody could interpret. Goes red if the shape pass is
     * folded back into the resolution loop.
     */
    const resolution = resolvePrincipals(
      ctx(),
      test_({
        principals: [
          actor({ name: 'dup', authProfileId: 'ap-a' }),
          actor({ name: 'dup', authProfileId: 'ap-b' }),
        ],
      }),
      { nowMs: NOW },
    );
    expect(resolution.failures.map((f) => f.reason)).toEqual(['DUPLICATE_NAME']);
    expect(resolution.notRun?.kind).toBe('UNSUPPORTED');
    // And nothing is half-resolved behind an input we could not read.
    expect(resolution.resolved).toEqual([]);
    expect(resolution.storageStateFor('dup')).toBeNull();
  });

  it('tells a synthesised anonymous placeholder from a profile that made no state', () => {
    /*
     * `runSessions` synthesises an entry from a null `RunContext.storageState`
     * and marks it ANONYMOUS with no profile — deliberately, so a caller cannot
     * read "no entry" as "we could not sign in". That placeholder is the
     * ABSENCE of a session, and reporting it as UNATTRIBUTED_SESSION sent a
     * reader to look for a missing `attachAuthProfile` call on a run where no
     * login had ever been attempted.
     */
    expect(
      resolvePrincipals(ctx(), ADMIN_TEST, { nowMs: NOW }).failures.map((f) => f.reason),
    ).toEqual(['NO_SESSION']);

    // A profile DID resolve and produced no browser state: a different fact.
    const bypass = ctx({
      storageState: null,
      authProfileId: 'ap-admin',
      sessions: {
        [RUNNER_DEFAULT_PRINCIPAL_NAME]: entry({
          principal: actor({ name: RUNNER_DEFAULT_PRINCIPAL_NAME, authProfileId: 'ap-admin' }),
          storageState: null,
        }),
      },
    });
    expect(resolvePrincipals(bypass, ADMIN_TEST, { nowMs: NOW }).failures.map((f) => f.reason)).toEqual(
      ['ANONYMOUS_SESSION'],
    );
  });

  it('can actually produce every failure reason it declares', () => {
    const produced = new Set<string>();
    const reasons = (r: ReturnType<typeof resolvePrincipals>) =>
      r.failures.forEach((f) => produced.add(f.reason));

    reasons(resolvePrincipals(ctx(), ADMIN_TEST, { nowMs: NOW }));
    reasons(resolvePrincipals(adminRun({ expiresAtIso: EARLIER }), ADMIN_TEST, { nowMs: NOW }));
    reasons(
      resolvePrincipals(
        ctx({
          storageState: null,
          sessions: {
            [RUNNER_DEFAULT_PRINCIPAL_NAME]: entry({
              principal: actor({ name: RUNNER_DEFAULT_PRINCIPAL_NAME, authProfileId: 'ap-other' }),
            }),
          },
        }),
        ADMIN_TEST,
        { nowMs: NOW },
      ),
    );
    reasons(
      resolvePrincipals(
        ctx({
          storageState: null,
          sessions: {
            [RUNNER_DEFAULT_PRINCIPAL_NAME]: entry({
              principal: actor({ name: RUNNER_DEFAULT_PRINCIPAL_NAME }),
            }),
          },
        }),
        ADMIN_TEST,
        { nowMs: NOW },
      ),
    );
    reasons(resolvePrincipals(adminRun({ storageState: null }), ADMIN_TEST, { nowMs: NOW }));
    reasons(
      resolvePrincipals(adminRun({ expiresAtIso: null }), ADMIN_TEST, {
        nowMs: NOW,
        expiryUndeclared: 'REFUSE',
      }),
    );
    reasons(
      resolvePrincipals(adminRun(), test_({ principals: [actor({ name: '' })] }), { nowMs: NOW }),
    );
    reasons(
      resolvePrincipals(
        ctx({
          storageState: null,
          authProfileId: 'ap-admin',
          sessions: {
            [RUNNER_DEFAULT_PRINCIPAL_NAME]: entry({
              principal: actor({ name: RUNNER_DEFAULT_PRINCIPAL_NAME, authProfileId: 'ap-admin' }),
              storageState: null,
            }),
          },
        }),
        ADMIN_TEST,
        { nowMs: NOW },
      ),
    );
    reasons(
      resolvePrincipals(
        adminRun(),
        test_({
          principals: [
            actor({ name: 'dup', authProfileId: 'ap-admin' }),
            actor({ name: 'dup', authProfileId: 'ap-admin' }),
          ],
        }),
        { nowMs: NOW },
      ),
    );

    /*
     * Exhaustiveness. A failure reason no code path can produce is a sentence
     * the report will never print — dead vocabulary pretending to be a
     * decision — and this is the only way to notice.
     */
    expect([...produced].sort()).toEqual([...PRINCIPAL_RESOLUTION_FAILURE_LIST].sort());
  });

  it('keeps every failure on the list while putting the first on the result', () => {
    const resolution = resolvePrincipals(
      ctx(),
      test_({
        principals: [
          actor({ name: 'a', authProfileId: 'ap-a' }),
          actor({ name: 'b', authProfileId: 'ap-b' }),
        ],
      }),
      { nowMs: NOW },
    );
    // One TestExecution holds one notRun, so something must be chosen — and
    // nothing may be suppressed. A failure dropped without being counted is the
    // lie; a failure not chosen as the headline is not.
    expect(resolution.failures).toHaveLength(2);
    expect(resolution.notRun?.why).toContain('"a"');
  });
});

// ─── The NOT_RUN mapping ─────────────────────────────────────────────────────

describe('the NOT_RUN kinds', () => {
  it('maps every reason to a real NotRunKind', () => {
    for (const reason of PRINCIPAL_RESOLUTION_FAILURE_LIST) {
      expect(isNotRunKind(notRunKindFor(reason))).toBe(true);
    }
  });

  it('never claims NOT_RUN or CANCELLED', () => {
    /*
     * This module always HAS a claim. NOT_RUN is "nobody wrote to this row" and
     * CANCELLED is "nobody wanted the answer"; writing either over a reason we
     * actually hold would put a shrug in the database where a sentence belongs.
     */
    for (const reason of PRINCIPAL_RESOLUTION_FAILURE_LIST) {
      expect(notRunKindFor(reason)).not.toBe('NOT_RUN');
      expect(notRunKindFor(reason)).not.toBe('CANCELLED');
    }
    expect(NOT_RUN_KINDS).toContain('NOT_RUN');
  });

  it('tags the message so a stored row reads back', () => {
    const resolution = resolvePrincipals(ctx(), ADMIN_TEST, { nowMs: NOW });
    const parsed = parseNotRun(resolution.notRun?.why ?? null);
    // The tag is what a surface sees; the sentence after it is what a human
    // reads. This product has shipped both halves missing.
    expect(parsed?.kind).toBe('BLOCKED_BY_ENV');
    expect(parsed?.why).toContain('run it as nobody');
  });
});

// ─── Caveats — what a PASS does and does not mean ────────────────────────────

describe('caveats', () => {
  it('runs a session with no declared expiry and DISCLOSES it', () => {
    const resolution = resolvePrincipals(adminRun({ expiresAtIso: null }), ADMIN_TEST, {
      nowMs: NOW,
    });
    /*
     * `runSessions` synthesises the legacy `storageState` entry with
     * `expiresAtIso: null`, so refusing by default would turn every existing
     * single-session run in every install into a BLOCKED_BY_ENV. What the
     * default must not do is go QUIET — null is "nobody told us", NOT "never
     * expires", and a resolver that read it as the second IS the defect.
     */
    expect(resolution.ok).toBe(true);
    expect(resolution.caveats.map((c) => c.kind)).toContain('EXPIRY_UNDECLARED');
    expect(resolution.caveats.find((c) => c.kind === 'EXPIRY_UNDECLARED')?.detail).toContain(
      'record an expiry',
    );
  });

  it('refuses instead when the caller arms the brake', () => {
    const resolution = resolvePrincipals(adminRun({ expiresAtIso: null }), ADMIN_TEST, {
      nowMs: NOW,
      expiryUndeclared: 'REFUSE',
    });
    expect(resolution.ok).toBe(false);
    expect(resolution.failures.map((f) => f.reason)).toEqual(['EXPIRY_UNDECLARED']);
  });

  it('treats an UNPARSEABLE expiry as unknown and not as live', () => {
    /*
     * `Date.parse` returns NaN and every comparison with NaN is false, so the
     * naive `expiresAtMs <= nowMs` silently resolves it as live — the exact
     * silent degradation this module refuses. Goes red if the
     * `Number.isFinite` guard is removed.
     */
    const resolution = resolvePrincipals(adminRun({ expiresAtIso: 'not-a-date' }), ADMIN_TEST, {
      nowMs: NOW,
    });
    expect(resolution.caveats.map((c) => c.kind)).toContain('EXPIRY_UNDECLARED');

    const armed = resolvePrincipals(adminRun({ expiresAtIso: 'not-a-date' }), ADMIN_TEST, {
      nowMs: NOW,
      expiryUndeclared: 'REFUSE',
    });
    expect(armed.failures.map((f) => f.reason)).toEqual(['EXPIRY_UNDECLARED']);
  });

  it('says when a verdict cannot be attributed to a (route, role) cell', () => {
    const run = ctx({
      storageState: null,
      authProfileId: 'ap-admin',
      sessions: {
        [RUNNER_DEFAULT_PRINCIPAL_NAME]: entry({
          principal: actor({ name: RUNNER_DEFAULT_PRINCIPAL_NAME, authProfileId: 'ap-admin' }),
        }),
      },
    });
    const resolution = resolvePrincipals(run, ADMIN_TEST, { nowMs: NOW });
    expect(resolution.ok).toBe(true);
    expect(resolution.caveats.map((c) => c.kind)).toContain('ROLE_UNDECLARED');
  });

  it('says when two principals turned out to be one identity', () => {
    const shared = STATE;
    const run = ctx({
      storageState: null,
      sessions: {
        attacker: {
          principal: actor({ name: 'attacker', role: 'member', authProfileId: 'ap-a' }),
          storageState: shared,
          expiresAtIso: LATER,
        },
        victim: {
          principal: actor({ name: 'victim', role: 'member', authProfileId: 'ap-a' }),
          storageState: shared,
          expiresAtIso: LATER,
        },
      },
    });
    const resolution = resolvePrincipals(
      run,
      test_({
        principals: [
          actor({ name: 'attacker', role: 'member', authProfileId: 'ap-a' }),
          actor({ name: 'victim', role: 'member', authProfileId: 'ap-a' }),
        ],
      }),
      { nowMs: NOW },
    );
    /*
     * A two-actor test whose actors share one identity compares an identity
     * with itself: every cross-tenant read succeeds, nothing is denied, and it
     * renders as "no leakage found". That is the vacuous pass
     * `TenantPair.distinct` refuses one level up, and the resolver is the first
     * place that can see it.
     */
    expect(resolution.ok).toBe(true);
    const shared_caveats = resolution.caveats.filter((c) => c.kind === 'SHARED_SESSION');
    expect(shared_caveats.map((c) => c.principalName).sort()).toEqual(['attacker', 'victim']);
    expect(shared_caveats[0]?.detail).toContain('comparing one identity with itself');
  });

  it('does not cry SHARED_SESSION over two genuinely different sessions', () => {
    const run = ctx({
      storageState: null,
      sessions: {
        attacker: {
          principal: actor({ name: 'attacker', role: 'member', authProfileId: 'ap-a' }),
          storageState: { cookies: [{ name: 'sid', value: `${SECRET}-a` }] },
          expiresAtIso: LATER,
        },
        victim: {
          principal: actor({ name: 'victim', role: 'member', authProfileId: 'ap-b' }),
          storageState: { cookies: [{ name: 'sid', value: `${SECRET}-b` }] },
          expiresAtIso: LATER,
        },
      },
    });
    const resolution = resolvePrincipals(
      run,
      test_({
        principals: [
          actor({ name: 'attacker', role: 'member', authProfileId: 'ap-a' }),
          actor({ name: 'victim', role: 'member', authProfileId: 'ap-b' }),
        ],
      }),
      { nowMs: NOW },
    );
    expect(resolution.caveats.filter((c) => c.kind === 'SHARED_SESSION')).toEqual([]);
  });

  it('can actually produce every caveat it declares', () => {
    const produced = new Set<string>();
    for (const resolution of [
      resolvePrincipals(adminRun({ expiresAtIso: null }), ADMIN_TEST, { nowMs: NOW }),
      resolvePrincipals(
        ctx({
          storageState: null,
          authProfileId: 'ap-admin',
          sessions: {
            [RUNNER_DEFAULT_PRINCIPAL_NAME]: entry({
              principal: actor({ name: RUNNER_DEFAULT_PRINCIPAL_NAME, authProfileId: 'ap-admin' }),
            }),
          },
        }),
        ADMIN_TEST,
        { nowMs: NOW },
      ),
      resolvePrincipals(
        ctx({
          storageState: null,
          sessions: {
            a: {
              principal: actor({ name: 'a', role: 'member', authProfileId: 'ap-a' }),
              storageState: STATE,
              expiresAtIso: LATER,
            },
            b: {
              principal: actor({ name: 'b', role: 'member', authProfileId: 'ap-a' }),
              storageState: STATE,
              expiresAtIso: LATER,
            },
          },
        }),
        test_({
          principals: [
            actor({ name: 'a', role: 'member', authProfileId: 'ap-a' }),
            actor({ name: 'b', role: 'member', authProfileId: 'ap-a' }),
          ],
        }),
        { nowMs: NOW },
      ),
    ]) {
      resolution.caveats.forEach((c) => produced.add(c.kind));
    }
    expect([...produced].sort()).toEqual([...PRINCIPAL_CAVEAT_LIST].sort());
  });
});

// ─── The two needs that owe nothing ─────────────────────────────────────────

describe('the principals that need no session', () => {
  it('resolves an anonymous principal with no state and no failure', () => {
    const resolution = resolvePrincipals(
      ctx(),
      test_({ principals: [actor({ name: 'anon', kind: 'ANONYMOUS' })] }),
      { nowMs: NOW },
    );
    expect(resolution.ok).toBe(true);
    expect(resolution.resolved[0]?.need).toBe('ANONYMOUS_BY_DESIGN');
    expect(resolution.resolved[0]?.hasStorageState).toBe(false);
  });

  it('ignores a stray session filed under an anonymous principal\'s name', () => {
    /*
     * Looking the session up first and deciding afterwards would make a stray
     * entry silently become the anonymous baseline's identity, which is the
     * opposite of what ANONYMOUS means — and would make every authorization
     * probe that compares against it pass.
     */
    const run = ctx({
      storageState: null,
      sessions: { anon: entry({ principal: actor({ name: 'anon', authProfileId: 'ap-admin' }) }) },
    });
    const resolution = resolvePrincipals(
      run,
      test_({ principals: [actor({ name: 'anon', kind: 'ANONYMOUS' })] }),
      { nowMs: NOW },
    );
    expect(resolution.resolved[0]?.hasStorageState).toBe(false);
    expect(resolution.storageStateFor('anon')).toBeNull();
  });

  it('lets a scenario-provisioned principal run without a session', () => {
    // Refusing this is what makes signup, password reset and lockout
    // unrunnable, which is the state this round exists to leave behind.
    const resolution = resolvePrincipals(
      ctx(),
      test_({
        principals: [actor({ name: 'fresh', kind: 'DISPOSABLE', createdByScenario: 'signup' })],
      }),
      { nowMs: NOW },
    );
    expect(resolution.ok).toBe(true);
    expect(resolution.notRun).toBeNull();
    expect(resolution.resolved[0]?.need).toBe('PROVISIONED_BY_SCENARIO');
  });
});

// ─── The plan the harness executes ──────────────────────────────────────────

describe('principalContextPlans', () => {
  it('plans one context per resolved principal, in a stable order', () => {
    const run = ctx({
      storageState: null,
      sessions: {
        victim: entry({ principal: actor({ name: 'victim', role: 'member', authProfileId: 'ap-b' }) }),
        attacker: entry({
          principal: actor({ name: 'attacker', role: 'admin', authProfileId: 'ap-a' }),
          storageState: { cookies: [] },
        }),
      },
    });
    const resolution = resolvePrincipals(
      run,
      test_({
        principals: [
          actor({ name: 'victim', role: 'member', authProfileId: 'ap-b' }),
          actor({ name: 'attacker', role: 'admin', authProfileId: 'ap-a' }),
        ],
      }),
      { nowMs: NOW },
    );
    expect(resolution.ok).toBe(true);
    expect(principalContextPlans(resolution)).toEqual([
      {
        principalName: 'attacker',
        authProfileId: 'ap-a',
        role: 'admin',
        storageStateFileName: 'storage-state-principal-attacker.json',
        injectStorageState: true,
      },
      {
        principalName: 'victim',
        authProfileId: 'ap-b',
        role: 'member',
        storageStateFileName: 'storage-state-principal-victim.json',
        injectStorageState: true,
      },
    ]);
  });

  it('does not ask the harness to inject a state for an actor that has none', () => {
    const resolution = resolvePrincipals(
      ctx(),
      test_({
        principals: [
          actor({ name: 'anon', kind: 'ANONYMOUS' }),
          actor({ name: 'fresh', kind: 'DISPOSABLE', createdByScenario: 'signup' }),
        ],
      }),
      { nowMs: NOW },
    );
    /*
     * A harness that read `false` as "fall back to the default session" would
     * hand the anonymous baseline an authenticated session and make every
     * authorization probe pass.
     */
    expect(principalContextPlans(resolution).map((p) => p.injectStorageState)).toEqual([
      false,
      false,
    ]);
  });
});

describe('principalStorageStateFileName', () => {
  it('sanitises a scenario-authored name into a filename', () => {
    expect(principalStorageStateFileName('tenant b/../../etc/passwd')).toBe(
      'storage-state-principal-tenant_b_.._.._etc_passwd.json',
    );
  });

  it('gives different principals different files', () => {
    // Two principals may legitimately share one auth profile; a file per
    // profile would put one name's session where another name's belongs.
    expect(principalStorageStateFileName('attacker')).not.toBe(
      principalStorageStateFileName('victim'),
    );
  });

  it('never produces a bare prefix for an empty name', () => {
    expect(principalStorageStateFileName('')).toBe('storage-state-principal-unnamed.json');
  });
});

// ─── SECURITY: the absence is reportable, the secret is not ─────────────────

describe('the resolver cannot leak a credential', () => {
  const everyRendering = (): string[] => {
    const healthy = resolvePrincipals(adminRun(), ADMIN_TEST, { nowMs: NOW });
    const expired = resolvePrincipals(adminRun({ expiresAtIso: EARLIER }), ADMIN_TEST, {
      nowMs: NOW,
    });
    const missing = resolvePrincipals(ctx(), ADMIN_TEST, { nowMs: NOW });
    return [
      JSON.stringify(healthy),
      JSON.stringify(healthy.toJSON()),
      JSON.stringify({ nested: { deeply: healthy } }),
      JSON.stringify(healthy.resolved),
      JSON.stringify(healthy.caveats),
      JSON.stringify(principalContextPlans(healthy)),
      JSON.stringify(describeRunSessions(adminRun())),
      JSON.stringify(describePrincipalFailures(expired)),
      JSON.stringify(describePrincipalFailures(missing)),
      JSON.stringify(expired),
      JSON.stringify(missing),
      expired.notRun?.why ?? '',
      missing.notRun?.why ?? '',
    ];
  };

  it('keeps the sentinel out of every serialisation, message and plan', () => {
    /*
     * The rule, in full: never log, echo, return or embed a session cookie or a
     * storageState — not truncated, not hashed, not in an error path, not in a
     * test name. This asserts it over every rendering this module offers, with
     * a sentinel the fixture planted, so a future field that happens to carry
     * the state fails here rather than at a customer.
     */
    for (const rendering of everyRendering()) {
      expect(rendering).not.toContain(SECRET);
      expect(rendering).not.toContain('qaai-sentinel');
    }
  });

  it('reports the ABSENCE of a session without quoting any part of one', () => {
    const expired = resolvePrincipals(adminRun({ expiresAtIso: EARLIER }), ADMIN_TEST, {
      nowMs: NOW,
    });
    const lines = describePrincipalFailures(expired);
    expect(lines).toHaveLength(1);
    // Everything a reader needs: who, which profile, what happened, what to do.
    expect(lines[0]).toContain(RUNNER_DEFAULT_PRINCIPAL_NAME);
    expect(lines[0]).toContain('SESSION_EXPIRED');
    expect(lines[0]).toContain('ap-admin');
    expect(lines[0]).toContain('Refresh the profile');
  });

  it('describes a run\'s sessions by identity and state only', () => {
    expect(describeRunSessions(adminRun())).toEqual([
      {
        name: RUNNER_DEFAULT_PRINCIPAL_NAME,
        role: 'admin',
        authProfileId: 'ap-admin',
        hasStorageState: true,
        expiresAtIso: LATER,
      },
    ]);
  });

  it('says a legacy storageState is present without showing it', () => {
    // The field this product has always had. It is the default principal, and
    // the describer has to be able to say so without printing it.
    const described = describeRunSessions({ storageState: STATE, authProfileId: 'ap-admin' });
    expect(described).toEqual([
      {
        name: RUNNER_DEFAULT_PRINCIPAL_NAME,
        role: null,
        authProfileId: 'ap-admin',
        hasStorageState: true,
        expiresAtIso: null,
      },
    ]);
    expect(JSON.stringify(described)).not.toContain(SECRET);
  });

  it('exposes the state through exactly one named door', () => {
    const healthy = resolvePrincipals(adminRun(), ADMIN_TEST, { nowMs: NOW });
    // The door exists — the harness needs it — and it is a METHOD, which
    // JSON.stringify drops. That is the structural half of the guarantee.
    expect(healthy.storageStateFor(RUNNER_DEFAULT_PRINCIPAL_NAME)).toBe(STATE);
    expect(healthy.storageStateFor('nobody')).toBeNull();
    expect(Object.keys(healthy.toJSON())).not.toContain('storageStateFor');
  });
});

// ─── The legacy path still works ────────────────────────────────────────────

describe('the single-session path is unchanged', () => {
  it('resolves a run that only ever set storageState and authProfileId', () => {
    /*
     * Every install in production is this shape. `runSessions` synthesises the
     * default entry from the legacy fields, and if this regressed, every
     * auth-bound test everywhere would turn into a BLOCKED_BY_ENV on the first
     * deploy of this module.
     */
    const resolution = resolvePrincipals(
      { storageState: STATE, authProfileId: 'ap-admin' },
      ADMIN_TEST,
      { nowMs: NOW },
    );
    expect(resolution.ok).toBe(true);
    expect(resolution.notRun).toBeNull();
    expect(resolution.storageStateFor(RUNNER_DEFAULT_PRINCIPAL_NAME)).toBe(STATE);
    // And the weakness is disclosed rather than hidden: nobody stated an expiry.
    expect(resolution.caveats.map((c) => c.kind)).toContain('EXPIRY_UNDECLARED');
  });

  it('asks nothing of a test that binds no profile at all', () => {
    const resolution = resolvePrincipals(ctx(), test_(), { nowMs: NOW });
    expect(resolution.ok).toBe(true);
    expect(resolution.resolved).toEqual([]);
    expect(principalContextPlans(resolution)).toEqual([]);
  });

  it('lets a run file its shared session under another name', () => {
    const run = ctx({
      storageState: null,
      authProfileId: 'ap-admin',
      sessions: {
        primary: entry({
          principal: actor({ name: 'primary', role: 'admin', authProfileId: 'ap-admin' }),
        }),
      },
    });
    const resolution = resolvePrincipals(run, ADMIN_TEST, {
      nowMs: NOW,
      defaultPrincipalName: 'primary',
    });
    expect(resolution.ok).toBe(true);
    expect(resolution.resolved[0]?.name).toBe('primary');
  });
});

// ─── No ambient clock ───────────────────────────────────────────────────────

describe('the resolver has no clock of its own', () => {
  /*
   * Comments stripped before the grep, for the reason gap-closure.test.ts gives:
   * this module's own header names the thing it promises not to do, and a test
   * that punishes writing the reason down is a test that gets the reason
   * deleted.
   */
  const source = readFileSync(fileURLToPath(new URL('./principals.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('strips comments but keeps the code', () => {
    expect(source).toContain('export function resolvePrincipals');
    expect(source).not.toContain('THE RUNNER-SIDE PRINCIPAL RESOLVER');
  });

  it('reads the time from its argument and from nowhere else', () => {
    /*
     * An expiry compared against a clock nobody passed is a test that passes in
     * the morning and fails at night — and, far worse here, a resolver whose
     * refusal cannot be tested at all.
     */
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/new Date\(/);
    expect(source).not.toMatch(/Math\.random/);
    // `Date.parse` is pure and IS allowed: it reads the string it was handed.
    expect(source).toMatch(/Date\.parse/);
  });

  it('imports no browser and no network', () => {
    expect(source).not.toMatch(/playwright/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/from 'node:/);
  });
});
