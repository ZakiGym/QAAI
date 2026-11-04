/**
 * THE SCOPE GUARD, AND THE TALLY THE BRAKE WRITES INTO.
 *
 * ── WHAT THIS FILE IS FOR, AND WHAT IT IS NOT ──────────────────────────────
 *
 * `routes/accounts.test.ts` drives REAL requests with REAL API keys through
 * this middleware over a loopback socket, and that is where the brake's two
 * answers are proved — an empty scope list is refused under ENFORCE, kept and
 * counted under OBSERVE. Those assertions belong there because the defect was
 * never in a function: it was that no production call site reached one.
 *
 * What is here instead is the part that needs no database and no socket:
 *
 *   1. `requireScope`'s own semantics, which are a pure predicate over
 *      `req.actor.scopes`. THE REASON THIS MATTERS: `requireScope` is the ONLY
 *      production consumer of `actor.scopes`, so if it disagreed with the
 *      credential path about what an empty list means, the two halves of the
 *      control would each be individually correct and jointly useless.
 *
 *   2. The refusal is not an oracle, and does not name the actor's scopes back.
 *
 *   3. The OBSERVE tally's read/reset contract, because it is module state and
 *      a counter that leaks between tests is a counter nobody can quote.
 *
 * No clock, no socket, no prisma: an Express handler is three plain values.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SECURITY_CONTROL_BRAKES } from '@qaai/shared';
import type { ActorContext } from '@qaai/shared';
import type { NextFunction, Request, Response } from 'express';
import { apiKeyScopeObserved, requireRole, requireScope, resetApiKeyScopeObserved } from './auth.js';

/** An actor with everything named, so no test depends on an absent field. */
function actor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: 'user_1',
    orgId: 'org_1',
    role: 'MEMBER',
    apiKeyId: 'apikey_1',
    scopes: [],
    impersonatedBy: null,
    ip: null,
    ...over,
  };
}

/**
 * Run one guard and report what it did.
 *
 * The middleware signals a refusal by passing an error to `next`, so "allowed"
 * and "refused" are both `next` having been called and the difference is the
 * argument. A helper that only recorded "was next called" would report every
 * refusal as an allowance.
 */
function run(
  guard: (req: Request, res: Response, next: NextFunction) => void,
  which: ActorContext | undefined,
): { allowed: boolean; status: number | null; message: string | null } {
  const req = { actor: which } as unknown as Request;
  let error: unknown;
  let called = false;
  guard(req, {} as Response, ((err?: unknown) => {
    called = true;
    error = err;
  }) as NextFunction);

  if (!called) throw new Error('the guard called neither next() nor next(err)');
  if (error === undefined) return { allowed: true, status: null, message: null };
  const api = error as { status?: number; message?: string };
  return { allowed: false, status: api.status ?? null, message: api.message ?? null };
}

describe('requireScope', () => {
  it('REFUSES AN ACTOR WHOSE SCOPE LIST IS EMPTY', () => {
    /*
     * The half that has to agree with the credential path. Under ENFORCE
     * `actorFromApiKey` refuses an empty-scope key outright, so this arm is
     * reached only in OBSERVE or by a session — but if it ever said YES to an
     * empty list, the meaning of the empty array would differ between the two
     * halves of one control, which is how the wildcard reading survived in the
     * first place.
     */
    const refused = run(requireScope('runs:read'), actor({ scopes: [] }));
    expect(refused.allowed).toBe(false);
    expect(refused.status).toBe(403);
  });

  it('allows the exact scope and refuses a neighbouring one', () => {
    expect(run(requireScope('runs:read'), actor({ scopes: ['runs:read'] })).allowed).toBe(true);
    // `runs:write` is not a superset of `runs:read` and must not be read as one:
    // the vocabulary is a set, not a ladder.
    expect(run(requireScope('runs:read'), actor({ scopes: ['runs:write'] })).allowed).toBe(false);
  });

  it('allows a session actor, who holds the wildcard sentinel', () => {
    /*
     * `'*'` is what the session path puts on the actor, and `API_KEY_SCOPES`
     * deliberately excludes it so a KEY can never name it. A human is governed
     * by a role instead.
     */
    expect(run(requireScope('secrets:write'), actor({ apiKeyId: null, scopes: ['*'] })).allowed)
      .toBe(true);
  });

  it('refuses an anonymous caller with 401 rather than 403', () => {
    // "You are not signed in" and "your key is too narrow" are different
    // remedies, and a 403 at an unauthenticated caller sends them to the wrong
    // one.
    const refused = run(requireScope('runs:read'), undefined);
    expect(refused.allowed).toBe(false);
    expect(refused.status).toBe(401);
  });

  it('does not echo the actor’s scopes back in the refusal', () => {
    /*
     * Rule 12. The refusal names the ONE scope that was required, which is the
     * remedy and is useful. It must not list what the key does hold, because
     * that turns a 403 into a readout of a credential the caller may have
     * stolen.
     */
    const refused = run(
      requireScope('secrets:write'),
      actor({ scopes: ['runs:read', 'tests:read'] }),
    );
    expect(refused.message).toContain('secrets:write');
    expect(refused.message).not.toContain('runs:read');
    expect(refused.message).not.toContain('tests:read');
  });
});

describe('requireRole, beside it', () => {
  it('ranks OWNER above ADMIN above MEMBER above VIEWER', () => {
    // Asserted here because `requireScope` and `requireRole` are the two guards
    // that stand between an API key and an org-administration route, and a
    // round that adds call sites to one should not be able to break the other.
    expect(run(requireRole('ADMIN'), actor({ role: 'OWNER' })).allowed).toBe(true);
    expect(run(requireRole('ADMIN'), actor({ role: 'ADMIN' })).allowed).toBe(true);
    expect(run(requireRole('ADMIN'), actor({ role: 'MEMBER' })).allowed).toBe(false);
    expect(run(requireRole('MEMBER'), actor({ role: 'VIEWER' })).allowed).toBe(false);
  });
});

describe('the API_KEY_SCOPE observe tally', () => {
  beforeEach(() => {
    resetApiKeyScopeObserved();
  });

  it('starts empty, which is not the same as a zero', () => {
    /*
     * Rule 14: a thing reported as measured that was not measured. An empty
     * object says "no request has been counted"; a `{ someKey: 0 }` would claim
     * a key had been seen and found clean.
     */
    expect(apiKeyScopeObserved()).toEqual({});
  });

  it('hands back a snapshot rather than the live map', () => {
    // A caller that could mutate the returned object could silently edit the
    // count an operator is about to read.
    const snapshot = apiKeyScopeObserved();
    (snapshot as Record<string, number>).apikey_x = 99;
    expect(apiKeyScopeObserved()).toEqual({});
  });
});

describe('the brake table this middleware reads', () => {
  it('still defaults API_KEY_SCOPE to ENFORCE, which is what makes the refusal the default', () => {
    /*
     * Not a tautology: every test in accounts.test.ts that asserts a 401 for an
     * empty-scope key with NOTHING stored on the org depends on this fallback.
     * If it were flipped to OBSERVE those tests would still pass — they would
     * just be asserting the wrong thing — so the fallback is pinned here where
     * a reader can see the dependency.
     */
    expect(SECURITY_CONTROL_BRAKES.API_KEY_SCOPE.fallback).toBe('ENFORCE');
  });

  it('describes what enforcing breaks, and it matches what this middleware does', () => {
    // Rule 14: a doc comment that contradicts the code under it. The sentence
    // promises that ENFORCE makes the empty array mean NOTHING, and the
    // credential path refuses such a key outright.
    expect(SECURITY_CONTROL_BRAKES.API_KEY_SCOPE.enforcingBreaks).toContain('empty scope array');
    expect(SECURITY_CONTROL_BRAKES.API_KEY_SCOPE.observeCounts).toContain('scopes are empty');
  });
});
