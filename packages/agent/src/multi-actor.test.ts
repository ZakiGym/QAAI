/**
 * Tests for multi-actor scenario generation.
 *
 * Every test below is one way this module could be WORSE than not existing, and
 * that framing is not rhetorical — a multi-actor generator has exactly two
 * dangerous failure modes and both of them produce green suites:
 *
 *   1. A SCAFFOLD. Two contexts are opened, two pages are visited, nothing
 *      about the handoff between them is asserted, and the coverage gap that
 *      was asking for a real two-actor test is closed by a test that proves
 *      nothing. So: a pattern whose evidence is absent must be reported as
 *      UNSUPPORTED with a reason, never emitted.
 *   2. ONE IDENTITY WEARING TWO NAMES. If both contexts resolve to the same
 *      session, an invite-and-accept test has the inviter seeing their own
 *      invitation and PASSES. So: the emitted spec must fail loudly when an
 *      actor's session is missing, and the enumeration must refuse a role it
 *      has no evidence can be signed in as.
 *
 * Plus the two rules this round is bound by: every cap that bit is disclosed as
 * a count AND a reason, and no credential reaches generated code.
 *
 * No network, no browser, no clock. The access matrix is built from literals
 * and the emitter is a pure string function, which is what lets the whole table
 * run in milliseconds with no API key.
 */

import { describe, expect, it } from 'vitest';
import { ANONYMOUS_ROLE } from '@qaai/shared';
import { admit } from './admission';
import {
  ACTOR_REJECTION_LIST,
  HANDOFF_KINDS,
  HANDOFF_PATTERN,
  MULTI_ACTOR_PATTERNS,
  MULTI_ACTOR_PATTERN_LIST,
  MULTI_ACTOR_STEP_KIND_LIST,
  PATTERN_DESCRIPTORS,
  PROVISION_REFUSAL_LIST,
  UNSUPPORTED_REASON_LIST,
  actorName,
  actorStateFile,
  checkProvisionFields,
  deriveActors,
  enumerateMultiActorScenarios,
  MULTI_ACTOR_TEST_TYPE,
  multiActorPlanItem,
  renderMultiActorSpec,
  resolveRoute,
  scenarioId,
  type ActorHandoff,
  type DisposableActorOffer,
  type MultiActorInput,
} from './multi-actor.js';
import type { AccessMatrix, AccessMatrixCell } from './access-matrix.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AT = '2026-10-26T09:00:00.000Z';
const SEED = 'seed-1234';

function cell(
  routeTemplate: string,
  role: string,
  outcome: AccessMatrixCell['outcome'],
  overrides: Partial<AccessMatrixCell> = {},
): AccessMatrixCell {
  const probed = outcome !== 'NOT_PROBED';
  return {
    routeTemplate,
    role,
    outcome,
    basis: 'OBSERVED',
    status: probed ? (outcome === 'ALLOWED' ? 200 : 403) : null,
    finalUrl: probed ? `https://app.test${routeTemplate}` : null,
    probedAtIso: probed ? AT : null,
    authProfileId: role === ANONYMOUS_ROLE ? null : `prof_${role}`,
    attemptId: null,
    inferredFrom: null,
    notProbedBecause: probed ? null : 'nobody asked',
    ...overrides,
  };
}

function matrixOf(cells: readonly AccessMatrixCell[]): AccessMatrix {
  return {
    routes: [...new Set(cells.map((c) => c.routeTemplate))].sort(),
    roles: [...new Set(cells.map((c) => c.role))].sort(),
    cells,
    counts: {
      measured: cells.filter((c) => c.outcome !== 'NOT_PROBED').length,
      erroredObserved: 0,
      declared: 0,
      notProbed: cells.filter((c) => c.outcome === 'NOT_PROBED').length,
      cells: cells.length,
    },
    gaps: [],
  };
}

/** Admin is served /admin; member is refused it. Both are also served /home. */
const DIVERGENT = matrixOf([
  cell('/admin', 'admin', 'ALLOWED'),
  cell('/admin', 'member', 'FORBIDDEN'),
  cell('/home', 'admin', 'ALLOWED'),
  cell('/home', 'member', 'ALLOWED'),
]);

function input(overrides: Partial<MultiActorInput> = {}): MultiActorInput {
  return { matrix: DIVERGENT, seed: SEED, ...overrides };
}

const INVITE: ActorHandoff = {
  kind: 'INVITE',
  producerRole: 'admin',
  consumerRole: 'member',
  producerRoute: '/team/members',
  producerAffordance: { role: 'button', name: 'Invite teammate' },
  consumerRoute: '/invitations',
  consumerSignal: 'You have been invited',
  evidence: 'journey "invite a teammate", approved 2026-10-20',
};

const OFFER: DisposableActorOffer = {
  role: 'member',
  provisionRoute: '/signup',
  provisionAffordance: { role: 'button', name: 'Create account' },
  provisionFields: [
    { locator: { role: 'textbox', name: 'Email' }, value: 'qa+r1@example.test', secretName: null },
    { locator: { role: 'textbox', name: 'Password' }, value: null, secretName: 'SIGNUP_PASSWORD' },
  ],
  logoutAffordance: { role: 'button', name: 'Sign out' },
  evidence: 'the crawl reached /signup and the policy allows destructive steps here',
};

// ─── Vocabulary parity ───────────────────────────────────────────────────────

describe('vocabulary parity', () => {
  it('describes every pattern, so none can be enumerated with no expectation', () => {
    expect(MULTI_ACTOR_PATTERN_LIST).toEqual([...MULTI_ACTOR_PATTERNS]);
    for (const pattern of MULTI_ACTOR_PATTERNS) {
      const descriptor = PATTERN_DESCRIPTORS[pattern];
      expect(descriptor.actors, pattern).toBeGreaterThanOrEqual(2);
      expect(descriptor.asserts.length, pattern).toBeGreaterThan(20);
      expect(descriptor.rationale.length, pattern).toBeGreaterThan(20);
    }
  });

  it('gives every handoff kind exactly one pattern, and every handoff pattern one kind', () => {
    const produced = HANDOFF_KINDS.map((kind) => HANDOFF_PATTERN[kind]);
    expect(new Set(produced).size).toBe(HANDOFF_KINDS.length);
    for (const pattern of produced) {
      expect(PATTERN_DESCRIPTORS[pattern].evidence).toBe('DECLARED_HANDOFF');
    }
  });

  it('marks exactly the destructive pattern as destructive', () => {
    const destructive = MULTI_ACTOR_PATTERNS.filter(
      (p) => PATTERN_DESCRIPTORS[p].destructiveStep !== null,
    );
    // One. A second destructive pattern is a decision, not a side effect of
    // adding a member — this test is where that decision gets made.
    expect(destructive).toEqual(['SESSION_INDEPENDENCE']);
  });

  it('renders every step kind, so a kind cannot ship with no code behind it', () => {
    for (const kind of MULTI_ACTOR_STEP_KIND_LIST) {
      const spec = renderMultiActorSpec({
        id: 'ma_test',
        pattern: 'PRIVILEGE_DIVERGENCE',
        title: 'step rendering',
        principals: [
          {
            name: 'a',
            kind: 'PERSISTENT',
            lifecycle: 'DECLARED',
            role: 'admin',
            authProfileId: 'p1',
            authProfileKind: null,
            tenant: null,
            createdByScenario: null,
          },
        ],
        steps: [
          {
            actor: 'a',
            kind,
            route: '/x',
            locator: { role: 'button', name: 'Go' },
            text: 'hello',
            secretName: null,
            description: 'do the thing',
          },
        ],
        assertions: ['something'],
        priority: 'IMPORTANT',
        evidence: 'test',
        destructive: null,
      });
      // Every kind must contribute at least one statement; an unrendered kind
      // would silently produce a test body with only comments in it.
      expect(spec, kind).toMatch(/await |expect\(/);
    }
  });
});

// ─── Deriving actors from the matrix ─────────────────────────────────────────

describe('deriveActors', () => {
  it('derives the actor set from the matrix rather than from a configured guess', () => {
    const { actors } = deriveActors(DIVERGENT);
    expect(actors.map((a) => a.role)).toEqual(['admin', 'member']);
    expect(actors[0]?.allowed).toEqual(['/admin', '/home']);
    expect(actors[1]?.refused).toEqual(['/admin']);
  });

  it('REFUSES a role whose whole column is NOT_PROBED, rather than acting as it', () => {
    const matrix = matrixOf([
      cell('/admin', 'admin', 'ALLOWED'),
      cell('/admin', 'auditor', 'NOT_PROBED'),
    ]);
    const { actors, rejected } = deriveActors(matrix);
    expect(actors.map((a) => a.role)).toEqual(['admin']);
    expect(rejected).toEqual([
      expect.objectContaining({ role: 'auditor', reason: 'NO_MEASURED_CELL' }),
    ]);
  });

  it('REFUSES a credentialed role whose cells name no auth profile', () => {
    const matrix = matrixOf([
      cell('/admin', 'admin', 'ALLOWED'),
      cell('/admin', 'member', 'FORBIDDEN', { authProfileId: null }),
    ]);
    const { actors, rejected } = deriveActors(matrix);
    expect(actors.map((a) => a.role)).toEqual(['admin']);
    expect(rejected[0]?.reason).toBe('NO_AUTH_PROFILE');
    // The reason has to say WHY it matters, because the remedy is non-obvious:
    // the test would have run and passed.
    expect(rejected[0]?.detail).toContain('pass');
  });

  it('keeps the anonymous column as an actor, with no profile and no credential', () => {
    const matrix = matrixOf([
      cell('/admin', 'admin', 'ALLOWED'),
      cell('/admin', ANONYMOUS_ROLE, 'REDIRECTED_TO_LOGIN'),
    ]);
    const { actors, rejected } = deriveActors(matrix);
    expect(rejected).toEqual([]);
    const anon = actors.find((a) => a.anonymous);
    expect(anon?.name).toBe('anonymous');
    expect(anon?.authProfileId).toBeNull();
  });

  it('can actually produce every rejection reason it declares', () => {
    const produced = new Set<string>();
    produced.add(
      deriveActors(matrixOf([cell('/a', 'x', 'NOT_PROBED')])).rejected[0]?.reason ?? '',
    );
    produced.add(
      deriveActors(matrixOf([cell('/a', 'y', 'ALLOWED', { authProfileId: null })])).rejected[0]
        ?.reason ?? '',
    );
    // A role literally called "default" collides with the run's default
    // principal name, which is the fastest way to end up acting as one identity
    // under two names.
    produced.add(
      deriveActors(matrixOf([cell('/a', 'default', 'ALLOWED')])).rejected[0]?.reason ?? '',
    );
    expect([...produced].sort()).toEqual([...ACTOR_REJECTION_LIST].sort());
  });

  it('gives the anonymous role a name that is legal in an identifier and a filename', () => {
    expect(actorName(ANONYMOUS_ROLE)).toBe('anonymous');
    expect(actorName('Billing Admin')).toBe('billing-admin');
    expect(actorStateFile(actorName('Billing Admin'))).toBe('playwright/.auth/billing-admin.json');
  });
});

// ─── PRIVILEGE_DIVERGENCE ────────────────────────────────────────────────────

describe('PRIVILEGE_DIVERGENCE', () => {
  it('asserts both halves in one test, which two matrix passes cannot', () => {
    const result = enumerateMultiActorScenarios(input());
    const scenario = result.scenarios.find((s) => s.pattern === 'PRIVILEGE_DIVERGENCE');
    expect(scenario).toBeDefined();
    expect(scenario?.principals.map((p) => p.name)).toEqual(['admin', 'member']);
    expect(scenario?.steps.map((s) => `${s.actor}:${s.kind}`)).toEqual([
      'admin:VISIT_EXPECT_SERVED',
      'member:VISIT_EXPECT_REFUSED',
    ]);
    // The evidence names the weakness it removes, so a reviewer can see why the
    // test is worth running when the matrix "already says" this.
    expect(scenario?.evidence).toContain('two separate passes');
  });

  it('reports NO_DIVERGENT_ROUTE rather than returning a clean zero', () => {
    const flat = matrixOf([
      cell('/home', 'admin', 'ALLOWED'),
      cell('/home', 'member', 'ALLOWED'),
    ]);
    const result = enumerateMultiActorScenarios(input({ matrix: flat }));
    expect(result.scenarios.filter((s) => s.pattern === 'PRIVILEGE_DIVERGENCE')).toEqual([]);
    const row = result.unsupported.find((u) => u.pattern === 'PRIVILEGE_DIVERGENCE');
    expect(row?.reason).toBe('NO_DIVERGENT_ROUTE');
    // The sentence has to warn against reading it as good news.
    expect(row?.detail).toContain('not a clean bill of health');
  });

  it('refuses a parameterised template with no instance, and accepts one with', () => {
    const templated = matrixOf([
      cell('/orders/:id', 'admin', 'ALLOWED'),
      cell('/orders/:id', 'member', 'FORBIDDEN'),
    ]);
    const without = enumerateMultiActorScenarios(input({ matrix: templated }));
    expect(
      without.unsupported.find((u) => u.pattern === 'PRIVILEGE_DIVERGENCE')?.reason,
    ).toBe('TEMPLATE_NOT_INSTANTIABLE');

    const withInstance = enumerateMultiActorScenarios(
      input({ matrix: templated, routeInstances: { '/orders/:id': '/orders/4821' } }),
    );
    const scenario = withInstance.scenarios.find((s) => s.pattern === 'PRIVILEGE_DIVERGENCE');
    expect(scenario?.steps[0]?.route).toBe('/orders/4821');
  });

  it('never navigates a template literally, because the 404 would read as a denial', () => {
    expect(resolveRoute('/orders/:id', {})).toBeNull();
    expect(resolveRoute('/orders/{id}', {})).toBeNull();
    expect(resolveRoute('/admin', {})).toBe('/admin');
  });

  it('lets an anonymous actor be the refused side but never the only session', () => {
    const matrix = matrixOf([
      cell('/admin', 'admin', 'ALLOWED'),
      cell('/admin', ANONYMOUS_ROLE, 'FORBIDDEN'),
    ]);
    const result = enumerateMultiActorScenarios(input({ matrix }));
    const scenario = result.scenarios.find((s) => s.pattern === 'PRIVILEGE_DIVERGENCE');
    expect(scenario?.principals.map((p) => p.kind)).toEqual(['PERSISTENT', 'ANONYMOUS']);
    // And no handoff pattern may be built from it: an anonymous visitor cannot
    // accept an invitation.
    expect(
      result.unsupported.find((u) => u.pattern === 'INVITE_AND_ACCEPT')?.reason,
    ).toBeDefined();
  });

  it('produces one scenario per actor pair, not one per divergent route', () => {
    const many = matrixOf([
      cell('/admin', 'admin', 'ALLOWED'),
      cell('/admin', 'member', 'FORBIDDEN'),
      cell('/admin/users', 'admin', 'ALLOWED'),
      cell('/admin/users', 'member', 'FORBIDDEN'),
      cell('/admin/billing', 'admin', 'ALLOWED'),
      cell('/admin/billing', 'member', 'FORBIDDEN'),
    ]);
    const result = enumerateMultiActorScenarios(input({ matrix: many }));
    expect(result.scenarios.filter((s) => s.pattern === 'PRIVILEGE_DIVERGENCE')).toHaveLength(1);
  });
});

// ─── The declared handoffs ───────────────────────────────────────────────────

describe('declared handoffs', () => {
  it('reports each handoff pattern as unsupported when nothing declared one', () => {
    const result = enumerateMultiActorScenarios(input());
    for (const kind of HANDOFF_KINDS) {
      const row = result.unsupported.find((u) => u.pattern === HANDOFF_PATTERN[kind]);
      expect(row?.reason, kind).toBe('NO_DECLARED_HANDOFF');
      // The remedy, not just the absence.
      expect(row?.detail, kind).toContain('declare the handoff');
    }
  });

  it('builds the invite scenario from a declared handoff', () => {
    const result = enumerateMultiActorScenarios(input({ handoffs: [INVITE] }));
    const scenario = result.scenarios.find((s) => s.pattern === 'INVITE_AND_ACCEPT');
    expect(scenario?.steps.map((s) => s.actor)).toEqual(['admin', 'admin', 'member', 'member']);
    expect(scenario?.steps.at(-1)?.kind).toBe('EXPECT_TEXT');
    expect(scenario?.assertions[0]).toContain('You have been invited');
  });

  it('REFUSES a handoff with no producer affordance instead of emitting a scaffold', () => {
    const result = enumerateMultiActorScenarios(
      input({ handoffs: [{ ...INVITE, producerAffordance: null }] }),
    );
    expect(result.scenarios.filter((s) => s.pattern === 'INVITE_AND_ACCEPT')).toEqual([]);
    expect(result.unsupported.find((u) => u.pattern === 'INVITE_AND_ACCEPT')?.reason).toBe(
      'NO_PRODUCER_AFFORDANCE',
    );
  });

  it('REFUSES a handoff with no consumer signal, because "the page loaded" is not evidence', () => {
    const result = enumerateMultiActorScenarios(
      input({ handoffs: [{ ...INVITE, consumerSignal: null }] }),
    );
    expect(result.scenarios.filter((s) => s.pattern === 'INVITE_AND_ACCEPT')).toEqual([]);
    const row = result.unsupported.find((u) => u.pattern === 'INVITE_AND_ACCEPT');
    expect(row?.reason).toBe('NO_CONSUMER_SIGNAL');
    expect(row?.detail).toContain('we did not check');
  });

  it('REFUSES a handoff naming a role the matrix never measured', () => {
    const result = enumerateMultiActorScenarios(
      input({ handoffs: [{ ...INVITE, consumerRole: 'auditor' }] }),
    );
    expect(result.unsupported.find((u) => u.pattern === 'INVITE_AND_ACCEPT')?.reason).toBe(
      'HANDOFF_ROLE_NOT_AN_ACTOR',
    );
  });

  it('REFUSES a handoff whose producer and consumer are the same actor', () => {
    const result = enumerateMultiActorScenarios(
      input({ handoffs: [{ ...INVITE, consumerRole: 'admin' }] }),
    );
    // The whole value of the pattern is that a second identity observes the
    // result. One identity doing both is the test that passes while the feature
    // is broken.
    expect(result.scenarios.filter((s) => s.pattern === 'INVITE_AND_ACCEPT')).toEqual([]);
    expect(result.unsupported.find((u) => u.pattern === 'INVITE_AND_ACCEPT')?.reason).toBe(
      'HANDOFF_ROLE_NOT_AN_ACTOR',
    );
  });
});

// ─── SESSION_INDEPENDENCE: the destructive one ───────────────────────────────

describe('SESSION_INDEPENDENCE', () => {
  it('builds a disposable principal the scenario itself created, and proves it', () => {
    const result = enumerateMultiActorScenarios(input({ disposable: OFFER }));
    const scenario = result.scenarios.find((s) => s.pattern === 'SESSION_INDEPENDENCE');
    expect(scenario).toBeDefined();
    const doomed = scenario!.principals[0]!;
    expect(doomed.kind).toBe('DISPOSABLE');
    // THE load-bearing assertion of this whole pattern: the principal names the
    // scenario that creates it, which is what `proveDisposable` requires and
    // what stops a long-lived account being logged out.
    expect(doomed.createdByScenario).toBe(scenario!.id);
    expect(scenario!.destructive).toEqual({ kind: 'LOGOUT', permitted: true, refusal: null });
  });

  it('never aims the destructive step at the surviving actor', () => {
    const result = enumerateMultiActorScenarios(input({ disposable: OFFER }));
    const scenario = result.scenarios.find((s) => s.pattern === 'SESSION_INDEPENDENCE')!;
    const survivor = scenario.principals[1]!;
    expect(survivor.kind).toBe('PERSISTENT');
    const logoutStep = scenario.steps.find((s) => s.locator?.name === 'Sign out');
    expect(logoutStep?.actor).toBe(scenario.principals[0]?.name);
    expect(logoutStep?.actor).not.toBe(survivor.name);
  });

  it('checks the survivor BEFORE and AFTER the logout, or it measures nothing', () => {
    const result = enumerateMultiActorScenarios(input({ disposable: OFFER }));
    const scenario = result.scenarios.find((s) => s.pattern === 'SESSION_INDEPENDENCE')!;
    const survivorName = scenario.principals[1]!.name;
    const indexes = scenario.steps
      .map((step, i) => ({ step, i }))
      .filter(({ step }) => step.actor === survivorName)
      .map(({ i }) => i);
    const logoutIndex = scenario.steps.findIndex((s) => s.locator?.name === 'Sign out');
    expect(indexes).toHaveLength(2);
    // A post-logout check alone cannot tell a broken session from one that was
    // never working, so the pre-check is not decoration.
    expect(indexes[0]).toBeLessThan(logoutIndex);
    expect(indexes[1]).toBeGreaterThan(logoutIndex);
  });

  it('reports NO_DISPOSABLE_OFFER rather than silently skipping the destructive half', () => {
    const result = enumerateMultiActorScenarios(input());
    const row = result.unsupported.find((u) => u.pattern === 'SESSION_INDEPENDENCE');
    expect(row?.reason).toBe('NO_DISPOSABLE_OFFER');
    expect(row?.detail).toContain("customer's own account may never be it");
  });

  it('reports DISPOSABLE_OFFER_INCOMPLETE when the logout affordance is missing', () => {
    const result = enumerateMultiActorScenarios(
      input({ disposable: { ...OFFER, logoutAffordance: null } }),
    );
    expect(result.unsupported.find((u) => u.pattern === 'SESSION_INDEPENDENCE')?.reason).toBe(
      'DISPOSABLE_OFFER_INCOMPLETE',
    );
  });
});

// ─── Credentials never reach generated code ──────────────────────────────────

describe('a credential never reaches the customer’s repository', () => {
  it('REFUSES a password field carrying an inline value', () => {
    const refusals = checkProvisionFields([
      { locator: { role: 'textbox', name: 'Password' }, value: 'hunter2', secretName: null },
    ]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toBe('CREDENTIAL_INLINED');
    // The refusal names the field and never the value — a refusal that echoes
    // the secret has leaked it into the report it was written to protect.
    expect(JSON.stringify(refusals)).not.toContain('hunter2');
  });

  it('stops the whole destructive scenario when a field is refused', () => {
    const result = enumerateMultiActorScenarios(
      input({
        disposable: {
          ...OFFER,
          provisionFields: [
            { locator: { role: 'textbox', name: 'Password' }, value: 'hunter2', secretName: null },
          ],
        },
      }),
    );
    expect(result.scenarios.filter((s) => s.pattern === 'SESSION_INDEPENDENCE')).toEqual([]);
    expect(result.unsupported.find((u) => u.pattern === 'SESSION_INDEPENDENCE')?.reason).toBe(
      'PROVISION_FIELD_REFUSED',
    );
    expect(result.provisionRefusals[0]?.reason).toBe('CREDENTIAL_INLINED');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('can actually produce every provision refusal it declares', () => {
    const produced = checkProvisionFields([
      { locator: { role: 'textbox', name: 'Email' }, value: null, secretName: null },
      { locator: { role: 'textbox', name: 'Email' }, value: 'a@b.test', secretName: 'X' },
      { locator: { role: 'textbox', name: 'Password' }, value: 'p', secretName: null },
    ]).map((r) => r.reason);
    expect([...produced].sort()).toEqual([...PROVISION_REFUSAL_LIST].sort());
  });

  it('emits the vault entry NAME and never a value', () => {
    const result = enumerateMultiActorScenarios(input({ disposable: OFFER }));
    const scenario = result.scenarios.find((s) => s.pattern === 'SESSION_INDEPENDENCE')!;
    const spec = renderMultiActorSpec(scenario);
    expect(spec).toContain("process.env[\"SIGNUP_PASSWORD\"]");
    // And it must fail rather than typing an empty string, which would report
    // the customer's signup form as broken.
    expect(spec).toContain('is not available to this run');
  });
});

// ─── Accounting and disclosure ───────────────────────────────────────────────

describe('accounting', () => {
  it('accounts for every pattern exactly once: built or unsupported, never neither', () => {
    const cases: Array<Partial<MultiActorInput>> = [
      {},
      { handoffs: [INVITE] },
      { disposable: OFFER },
      { handoffs: [INVITE], disposable: OFFER },
      { matrix: matrixOf([cell('/home', 'admin', 'ALLOWED')]) },
    ];
    for (const overrides of cases) {
      const result = enumerateMultiActorScenarios(input(overrides));
      const built = new Set(result.scenarios.map((s) => s.pattern));
      const refused = new Set(result.unsupported.map((u) => u.pattern));
      for (const pattern of MULTI_ACTOR_PATTERNS) {
        const inBuilt = built.has(pattern);
        const inRefused = refused.has(pattern);
        // Exactly one. Both would double-count; neither is the silent drop this
        // whole module is built to prevent.
        expect(inBuilt !== inRefused, `${pattern} ${JSON.stringify(overrides)}`).toBe(true);
      }
      expect(result.considered).toBeGreaterThanOrEqual(MULTI_ACTOR_PATTERNS.length);
    }
  });

  it('can actually produce every unsupported reason it declares', () => {
    const produced = new Set<string>();
    const collect = (overrides: Partial<MultiActorInput>): void => {
      for (const row of enumerateMultiActorScenarios(input(overrides)).unsupported) {
        produced.add(row.reason);
      }
    };
    collect({});
    // One credentialed role: a session, but nobody to compare it against.
    collect({ matrix: matrixOf([cell('/home', 'admin', 'ALLOWED')]) });
    // Two roles and no disagreement anywhere.
    collect({
      matrix: matrixOf([
        cell('/home', 'admin', 'ALLOWED'),
        cell('/home', 'member', 'ALLOWED'),
      ]),
    });
    // Only the anonymous column: an actor, and no session to hold.
    collect({
      matrix: matrixOf([
        cell('/home', ANONYMOUS_ROLE, 'ALLOWED'),
        cell('/admin', ANONYMOUS_ROLE, 'FORBIDDEN'),
      ]),
      disposable: OFFER,
    });
    collect({
      matrix: matrixOf([
        cell('/orders/:id', 'admin', 'ALLOWED'),
        cell('/orders/:id', 'member', 'FORBIDDEN'),
      ]),
    });
    collect({ handoffs: [{ ...INVITE, producerAffordance: null }] });
    collect({ handoffs: [{ ...INVITE, consumerSignal: null }] });
    collect({ handoffs: [{ ...INVITE, consumerRole: 'auditor' }] });
    collect({ disposable: { ...OFFER, logoutAffordance: null } });
    collect({
      disposable: {
        ...OFFER,
        provisionFields: [
          { locator: { role: 'textbox', name: 'Password' }, value: 'x', secretName: null },
        ],
      },
    });
    expect([...produced].sort()).toEqual([...UNSUPPORTED_REASON_LIST].sort());
  });

  it('DISCLOSES the cap as a count and a reason, and never one without the other', () => {
    const uncapped = enumerateMultiActorScenarios(input({ handoffs: [INVITE], disposable: OFFER }));
    expect(uncapped.omittedByCap).toBe(0);
    expect(uncapped.capReason).toBeNull();

    const capped = enumerateMultiActorScenarios(
      input({ handoffs: [INVITE], disposable: OFFER, limit: 1 }),
    );
    expect(capped.scenarios).toHaveLength(1);
    expect(capped.omittedByCap).toBe(uncapped.scenarios.length - 1);
    expect(capped.capReason).not.toBeNull();
    expect(capped.capReason).toContain('at least');
  });

  it('is byte-identical across calls and across seeds only where the seed is mixed in', () => {
    const a = enumerateMultiActorScenarios(input({ handoffs: [INVITE], disposable: OFFER }));
    const b = enumerateMultiActorScenarios(input({ handoffs: [INVITE], disposable: OFFER }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const other = enumerateMultiActorScenarios(
      input({ handoffs: [INVITE], disposable: OFFER, seed: 'seed-9999' }),
    );
    expect(other.scenarios.map((s) => s.id)).not.toEqual(a.scenarios.map((s) => s.id));
    // Everything except the ids is seed-independent, so a re-seeded run is the
    // same suite under new names rather than a different suite.
    expect(other.scenarios.map((s) => s.title)).toEqual(a.scenarios.map((s) => s.title));
  });

  it('gives different subjects different ids, NUL-separated so parts cannot collide', () => {
    expect(scenarioId(SEED, 'PRIVILEGE_DIVERGENCE', 'a b')).not.toBe(
      scenarioId(SEED, 'PRIVILEGE_DIVERGENCE', 'a', 'b'),
    );
    expect(scenarioId(SEED, 'PRIVILEGE_DIVERGENCE', 'x')).toBe(
      scenarioId(SEED, 'PRIVILEGE_DIVERGENCE', 'x'),
    );
  });
});

// ─── The plan item ───────────────────────────────────────────────────────────

describe('multiActorPlanItem', () => {
  it('leaves authProfileId NULL, because no single identity runs this test', () => {
    const scenario = enumerateMultiActorScenarios(input()).scenarios[0]!;
    const { item, principals } = multiActorPlanItem(scenario);
    // Naming one of the two actors here would bind the test to that identity and
    // re-create the single-session assumption this module exists to escape.
    expect(item.authProfileId).toBeNull();
    expect(principals).toHaveLength(2);
  });

  it('puts the actor on every step, so no step can be executed as the wrong identity', () => {
    const scenario = enumerateMultiActorScenarios(input({ handoffs: [INVITE] })).scenarios.find(
      (s) => s.pattern === 'INVITE_AND_ACCEPT',
    )!;
    const { item } = multiActorPlanItem(scenario);
    for (const step of item.steps) expect(step).toMatch(/^\[(admin|member)\] /);
  });
});

// ─── The emitted spec ────────────────────────────────────────────────────────

describe('renderMultiActorSpec', () => {
  const scenario = enumerateMultiActorScenarios(input()).scenarios[0]!;
  const spec = renderMultiActorSpec(scenario);

  it('opens ONE BROWSER CONTEXT PER PRINCIPAL, which is the whole feature', () => {
    const contexts = [...spec.matchAll(/browser\.newContext\(/g)];
    expect(contexts).toHaveLength(scenario.principals.length);
    expect(spec).toContain('storageState: sessionFor("admin")');
    expect(spec).toContain('storageState: sessionFor("member")');
  });

  it('FAILS LOUDLY when an actor has no session, instead of sharing one', () => {
    expect(spec).toContain('throw new Error(');
    expect(spec).toContain('No signed-in session for the actor');
    // The message must say what the silent alternative would have cost, because
    // that is the sentence that stops somebody "fixing" it by falling back.
    expect(spec).toContain('proving nothing about the second identity');
  });

  it('closes every context even when an assertion throws', () => {
    expect(spec).toContain('try {');
    expect(spec).toContain('} finally {');
    const closes = [...spec.matchAll(/Context\.close\(\)/g)];
    expect(closes).toHaveLength(scenario.principals.length);
  });

  it('clears the admission gates this module is written to clear', () => {
    // ASSERTIONS — a test with no expect is the zero-assertion defect.
    expect(spec).toMatch(/expect\(/);
    // NO_FIXED_SLEEP — Playwright's auto-waiting does the waiting.
    expect(spec).not.toMatch(/waitForTimeout|setTimeout|sleep\(/);
    // NO_LOCK_IN — the generated test is the customer's code and must run with
    // QAAI uninstalled, so not even an identifier may name it.
    expect(spec).not.toMatch(/qaai/i);
    // LOCATORS — role/name only. A CSS selector cannot be constructed here,
    // because ActorLocator has no field for one.
    expect(spec).not.toMatch(/\.locator\(|querySelector|nth-child/);
  });

  it('declares no two bindings with one name, in EVERY scenario it can emit', () => {
    /*
     * Checked across every pattern, not just the first. The privilege-divergence
     * spec has one served step and one refused step, whose bindings differ by
     * name anyway — so a mutation that stopped threading the step index through
     * the emitter SURVIVED this test while it only looked at that one spec. The
     * session-independence spec has three served steps, and three bindings
     * called `served0` do not compile.
     */
    const all = enumerateMultiActorScenarios(
      input({ handoffs: [INVITE], disposable: OFFER }),
    ).scenarios;
    expect(all.length).toBeGreaterThan(2);
    for (const candidate of all) {
      const consts = [...renderMultiActorSpec(candidate).matchAll(/^\s*const (\w+)\b/gm)].map(
        (m) => m[1],
      );
      expect(new Set(consts).size, candidate.pattern).toBe(consts.length);
    }
  });

  it('asserts a REFUSAL by status floor, not by "not 200"', () => {
    // A soft login wall answers 200 with a sign-in form, so `not.toBe(200)`
    // would fail on an application that is behaving correctly.
    expect(spec).toContain('toBeGreaterThanOrEqual(400)');
    expect(spec).not.toContain('not.toBe(200)');
  });

  it('is byte-identical across calls', () => {
    expect(renderMultiActorSpec(scenario)).toBe(spec);
  });

  /*
   * THE THIRD DANGEROUS FAILURE MODE, which the two in this file's header do
   * not cover: the spec is correct and never reaches the suite at all, because
   * the gate that must bless it refuses it.
   *
   * It shipped exactly that way. `multiActorPlanItem` wrote its approved
   * assertions as "<role> receives a successful response for <url>" while
   * `renderStep` wrote the expect() message as "<actor> should be served
   * <url>" — two vocabularies for one fact, both in this file — and FIDELITY
   * traces approved assertions into the code BY WORD. So it reported "0 of 2
   * approved assertion(s) are traceable" and admission answered REVISE, a
   * verdict a DETERMINISTIC scaffold can never satisfy: there is no model in
   * the loop to rewrite anything, so the caller either loops forever or treats
   * it as a refusal. With `revisable: false` — the honest flag for a scaffold —
   * it answered REFUSE outright.
   *
   * That is why this asserts the VERDICT and not the prose. Pinning the two
   * sentences would pass the day somebody changes one of them and not the
   * other, which is the drift that caused this.
   *
   * No toolchain is injected, so SYNTAX/TYPECHECK/FORMAT/LINT report
   * UNAVAILABLE rather than PASS. That is admission being honest, not a
   * failure, and it is why ADMIT is reachable here at all.
   */
  it('emits a spec the ADMISSION GATE accepts, as a model-free scaffold', async () => {
    const item = multiActorPlanItem(scenario).item;
    const report = await admit({
      code: spec,
      filePath: 'tests/e2e/privilege-divergence.spec.ts',
      testType: MULTI_ACTOR_TEST_TYPE,
      item,
      language: 'TYPESCRIPT',
      // Nothing can act on a rewrite request: this emitter is pure string
      // concatenation, so REVISE would be a verdict nobody can satisfy.
      revisable: false,
    });

    const fidelity = report.gates.find((gate) => gate.gate === 'FIDELITY');
    expect(fidelity?.status, fidelity?.detail.join(' | ')).toBe('PASS');
    expect(report.verdict).toBe('ADMIT');
  });
});
