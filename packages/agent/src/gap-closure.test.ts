/**
 * The tests for session-aware gap closure.
 *
 * THE DELIVERABLE IS `the loop converges`, and the reason it is written against
 * the REAL `analyzeCoverage` and `buildAccessMatrix` rather than against fakes
 * is that the defect it pins lived in the SEAM. Every part of the old loop was
 * individually correct: the gap detector correctly reported an unreached auth
 * route, `planItemForGap` correctly produced a plan item, and the SECURITY_SMOKE
 * schema correctly asserted anonymous denial. The loop still could not converge,
 * because the thing the detector needed back was a column the proposal never
 * set. A fake re-analysis would have agreed with whatever this file told it to
 * agree with, and the fourth round of re-closing one gap would have shipped
 * green.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runSessions } from '@qaai/shared';
import { buildAccessMatrix } from './access-matrix.js';
import type { AccessMatrix, RoleProbe } from './access-matrix.js';
import { analyzeCoverage } from './coverage.js';
import type { AuthProfileChoice, CoverageGap, CoverageTestInput } from './coverage.js';
import {
  CLOSURE_DEFAULT_PRINCIPAL_NAME,
  CONVERGENCE_STATE_LIST,
  CONVERGENCE_STATES,
  MAX_CLOSURES_PER_ROUND,
  MEASURED_ROLE_BINDING_SOURCES,
  PROJECTED_TEST_ID_PREFIX,
  ROLE_BINDING_REFUSAL_LIST,
  ROLE_BINDING_REFUSALS,
  ROLE_BINDING_SOURCE_LIST,
  ROLE_BINDING_SOURCES,
  ROLE_COVERAGE_STATE_LIST,
  ROLE_COVERAGE_STATES,
  ROLE_SOURCE_LIST,
  ROLE_SOURCES,
  bindRoleForGap,
  closeGapAsRole,
  closureRound,
  closureScenarioName,
  projectClosedTest,
  roleCoverageCellKey,
  roleCoverageCells,
  roleOfProfile,
  verifyConvergence,
} from './gap-closure.js';
import type { ClosureAuthProfile, ClosureGap, SessionBoundClosure } from './gap-closure.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SEED = 'run_01JQ8EXAMPLE';

/** One auth-gated route behind a declared role, and one open route. The minimum. */
function oneGatedRoute(): Record<string, unknown> {
  const node = (
    id: string,
    route: string,
    behindAuth = false,
    requiresRoles: string[] = [],
  ): Record<string, unknown> => ({
    id,
    route,
    url: `https://app.test${route}`,
    title: route,
    stateKey: 'default',
    requiresRoles,
    behindAuth,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
  });

  return {
    projectId: 'p1',
    environmentId: 'e1',
    version: 1,
    baseUrl: 'https://app.test',
    exploredAt: '2026-07-01T00:00:00.000Z',
    truncatedReason: null,
    nodes: [node('n-home', '/'), node('n-admin', '/admin/users', true, ['admin'])],
    edges: [{ id: 'e1', from: 'n-home', to: 'n-admin', action: 'click "Admin"', selector: null }],
    journeys: [],
    features: [],
  };
}

const ADMIN_PROFILE: AuthProfileChoice = { id: 'ap-admin', name: 'Admin' };
const CLOSURE_ADMIN: ClosureAuthProfile = { id: 'ap-admin', name: 'Admin', role: 'admin' };
const CLOSURE_MEMBER: ClosureAuthProfile = { id: 'ap-member', name: 'Member', role: 'member' };

/** A gap shaped like the one `analyzeCoverage` actually produces, for unit work. */
function authGap(over: Partial<ClosureGap> = {}): ClosureGap {
  return {
    id: 'gap_admin',
    kind: 'UNREACHED_AUTH_ROUTE',
    route: '/admin/users',
    requiresAuth: true,
    authProfile: { id: 'ap-admin', name: 'Admin', why: 'named for the declared role.' },
    ...over,
  };
}

function probe(over: Partial<RoleProbe> & { role: string }): RoleProbe {
  return {
    authProfileId: null,
    attemptId: null,
    outcome: 'CRAWLED',
    contributed: true,
    detail: null,
    observations: [],
    ...over,
  };
}

function observation(
  routeTemplate: string,
  observed: 'ALLOWED' | 'DENIED' | 'REDIRECTED' | 'UNKNOWN',
  status: number | null,
): RoleProbe['observations'][number] {
  return {
    routeTemplate,
    observed,
    status,
    finalUrl: `https://app.test${routeTemplate}`,
    observedAtIso: '2026-07-01T00:00:00.000Z',
  };
}

/** Admin got in, member was refused, on the real matrix builder. */
function matrixAdminInMemberOut(): AccessMatrix {
  return buildAccessMatrix({
    routes: ['/', '/admin/users'],
    probes: [
      probe({
        role: 'admin',
        authProfileId: 'ap-admin',
        observations: [
          observation('/', 'ALLOWED', 200),
          observation('/admin/users', 'ALLOWED', 200),
        ],
      }),
      probe({
        role: 'member',
        authProfileId: 'ap-member',
        observations: [
          observation('/', 'ALLOWED', 200),
          observation('/admin/users', 'DENIED', 403),
        ],
      }),
    ],
  });
}

// ─── Vocabulary parity ───────────────────────────────────────────────────────

describe('closure vocabulary parity', () => {
  /*
   * The same guard the rest of the repo uses, for the same reason: eight
   * `GateRule` kinds shipped UNSAVEABLE for two slices because a union member
   * had no write path, and `check:wiring` cannot see that — a union member with
   * no write path is live code in a file that is reached.
   */
  it('derives every list from its presence record, so a new member cannot hide', () => {
    expect(ROLE_BINDING_SOURCE_LIST).toEqual([...ROLE_BINDING_SOURCES]);
    expect(ROLE_BINDING_REFUSAL_LIST).toEqual([...ROLE_BINDING_REFUSALS]);
    expect(ROLE_SOURCE_LIST).toEqual([...ROLE_SOURCES]);
    expect(ROLE_COVERAGE_STATE_LIST).toEqual([...ROLE_COVERAGE_STATES]);
    expect(CONVERGENCE_STATE_LIST).toEqual([...CONVERGENCE_STATES]);
  });

  it('counts exactly one binding source as a measurement', () => {
    // A declaration is not a check. If a second source ever counts as measured,
    // that is a decision somebody must make here rather than inherit.
    expect(MEASURED_ROLE_BINDING_SOURCES).toEqual(['OBSERVED_ALLOWED']);
  });

  it('spells the default principal the way runSessions does', () => {
    /*
     * The drift guard for the duplicated constant. `CLOSURE_DEFAULT_PRINCIPAL_NAME`
     * lives in principals.ts, which is not on the @qaai/shared barrel yet, so
     * this module declares the name locally — and a duplicated constant with no
     * guard is how two spellings of one identity get into a codebase. A rename
     * over there turns this red instead of producing closures that bind a
     * session nothing files.
     */
    const synthesised = Object.keys(runSessions({ storageState: { cookies: [] } }));
    expect(synthesised).toEqual([CLOSURE_DEFAULT_PRINCIPAL_NAME]);
  });
});

// ─── THE DELIVERABLE ─────────────────────────────────────────────────────────

describe('the loop converges', () => {
  /** The real analyser, wrapped as the injected re-analysis. */
  const reanalyze = (tests: readonly CoverageTestInput[]) => {
    const report = analyzeCoverage({
      flowMapGraph: oneGatedRoute(),
      tests: [...tests],
      authProfiles: [ADMIN_PROFILE],
    });
    return {
      crawled: report.crawled,
      complete: report.totals.gaps === report.totals.gapsReturned,
      openGapIds: new Set(report.gaps.map((g) => g.id)),
    };
  };

  const firstPass = (): { gaps: CoverageGap[]; authGapId: string } => {
    const report = analyzeCoverage({
      flowMapGraph: oneGatedRoute(),
      tests: [],
      authProfiles: [ADMIN_PROFILE],
    });
    const auth = report.gaps.find((g) => g.kind === 'UNREACHED_AUTH_ROUTE');
    expect(auth, 'the fixture must produce an UNREACHED_AUTH_ROUTE gap').toBeDefined();
    return { gaps: report.gaps, authGapId: auth!.id };
  };

  it('reports UNREACHED_AUTH_ROUTE on the first pass', () => {
    const { gaps } = firstPass();
    const auth = gaps.filter((g) => g.kind === 'UNREACHED_AUTH_ROUTE');
    expect(auth).toHaveLength(1);
    expect(auth[0]?.route).toBe('/admin/users');
    expect(auth[0]?.requiresAuth).toBe(true);
  });

  it('closes it as a ROLE, not as an anonymous denial', () => {
    const { gaps } = firstPass();
    const round = closureRound({
      gaps,
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
      seed: SEED,
    });

    expect(round.closures).toHaveLength(1);
    const closure = round.closures[0]!;
    expect(closure.binding.role).toBe('admin');
    expect(closure.binding.authProfileId).toBe('ap-admin');
    expect(closure.binding.source).toBe('OBSERVED_ALLOWED');
    expect(closure.binding.measured).toBe(true);

    /*
     * THE DEFECT, PINNED. A SECURITY_SMOKE here is the old behaviour: its
     * schema can assert one thing — that an anonymous visitor is refused — so
     * the gap asking for a signed-in test was answered with a signed-out one,
     * and closing the gap re-created the gap.
     */
    expect(closure.testType).toBe('E2E');
    expect(closure.testType).not.toBe('SECURITY_SMOKE');

    // The identity reaches the plan item, and from there the Test row.
    expect(closure.planItemPatch.authProfileId).toBe('ap-admin');
    expect(closure.planItemPatch.principals).toHaveLength(1);
    expect(closure.planItemPatch.principals[0]?.name).toBe(CLOSURE_DEFAULT_PRINCIPAL_NAME);
    expect(closure.planItemPatch.principals[0]?.role).toBe('admin');
    expect(closure.planItemPatch.principals[0]?.authProfileId).toBe('ap-admin');
    expect(closure.planItemPatch.gapId).toBe(closure.gapId);
  });

  it('binds the closure PERSISTENT, so a destructive step aimed at it will not compile', () => {
    /*
     * A closure's principal is the CUSTOMER'S configured account. PERSISTENT is
     * what makes `proveDisposable` refuse it, and `createdByScenario: null` is
     * what makes the refusal stick — that field is the one fact
     * `proveDisposable` uses to permit destruction, so a closure claiming to
     * have created its own actor would hand a generated scenario permission to
     * delete the only way in.
     */
    const result = closeGapAsRole({
      gap: authGap(),
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_ADMIN],
      seed: SEED,
    });
    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.closure.planItemPatch.principals[0]?.kind).toBe('PERSISTENT');
    expect(result.closure.planItemPatch.principals[0]?.createdByScenario).toBeNull();
  });

  it('CONVERGES — the projected test removes the gap from a complete re-analysis', () => {
    const { gaps } = firstPass();
    const round = closureRound({
      gaps,
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
      seed: SEED,
    });

    const verdict = verifyConvergence({
      closures: round.closures,
      existingTests: [],
      reanalyze,
    });

    expect(verdict.state).toBe('CONVERGES');
    expect(verdict.stillOpenGapIds).toEqual([]);
    expect(verdict.closedGapIds).toEqual(round.closures.map((c) => c.gapId));
  });

  it('goes from UNREACHED_AUTH_ROUTE to covered after ONE closure pass', () => {
    const { gaps, authGapId } = firstPass();
    const round = closureRound({
      gaps,
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
      seed: SEED,
    });

    // The suite as it stands after the closure's test lands.
    const suite = round.closures.map(projectClosedTest);
    const second = analyzeCoverage({
      flowMapGraph: oneGatedRoute(),
      tests: suite,
      authProfiles: [ADMIN_PROFILE],
    });

    expect(second.gaps.map((g) => g.id)).not.toContain(authGapId);
    expect(second.gaps.filter((g) => g.kind === 'UNREACHED_AUTH_ROUTE')).toEqual([]);

    /*
     * And the route IS covered rather than merely unreported. `routesVisited`
     * is the analyser's own numerator, so this asserts the closure moved the
     * number it is supposed to move — not just that one list got shorter.
     */
    expect(second.totals.routesVisited).toBeGreaterThan(0);
    expect(second.ledger.items.some((i) => i.key === 'ROUTE:/admin/users')).toBe(true);
  });

  it('does NOT re-propose it on the second pass', () => {
    const { gaps } = firstPass();
    const first = closureRound({
      gaps,
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
      seed: SEED,
    });
    const suite = first.closures.map(projectClosedTest);
    const second = analyzeCoverage({
      flowMapGraph: oneGatedRoute(),
      tests: suite,
      authProfiles: [ADMIN_PROFILE],
    });

    const again = closureRound({
      gaps: second.gaps,
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
      seed: SEED,
    });

    /*
     * THE WHOLE POINT. The first round's gap id must not come back, and the
     * second round must not mint a closure for it under any id. Anything the
     * second pass DOES report is a different gap — the fixture's open route,
     * and a NO_NEGATIVE_CASE now that the route has a happy-path test — and
     * those are refused here with a reason rather than bound to a session,
     * because they are not auth gaps and this loop is not entitled to them.
     */
    expect(again.closures).toEqual([]);
    for (const closure of first.closures) {
      expect(again.closures.map((c) => c.gapId)).not.toContain(closure.gapId);
    }
    expect(again.refusals.length).toBeGreaterThan(0);
    expect(again.refusals.every((r) => r.refusal === 'NOT_AN_AUTH_GAP')).toBe(true);
    expect(again.considered).toBe(second.gaps.length);
  });

  it('is byte-identical for the same seed, and only the scenario name moves with it', () => {
    const { gaps } = firstPass();
    const round = (seed: string) =>
      closureRound({
        gaps,
        matrix: matrixAdminInMemberOut(),
        profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
        seed,
      });

    expect(JSON.stringify(round(SEED))).toBe(JSON.stringify(round(SEED)));

    const a = round(SEED).closures[0]!;
    const b = round('run_OTHER').closures[0]!;
    expect(b.scenarioName).not.toBe(a.scenarioName);
    // Everything that is not the seeded name is unchanged by the seed.
    expect({ ...b, scenarioName: a.scenarioName }).toEqual(a);
  });
});

// ─── verifyConvergence refuses to claim what it did not see ──────────────────

describe('verifyConvergence', () => {
  const closure = (): SessionBoundClosure => {
    const result = closeGapAsRole({
      gap: authGap(),
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_ADMIN],
      seed: SEED,
    });
    if (!result.closed) throw new Error('fixture must close');
    return result.closure;
  };

  it('reports UNVERIFIABLE, not CONVERGES, when the re-analysis saw no application', () => {
    const verdict = verifyConvergence({
      closures: [closure()],
      existingTests: [],
      reanalyze: () => ({ crawled: false, complete: true, openGapIds: new Set() }),
    });
    // An empty gap list from an empty crawl would otherwise mark every gap
    // closed the first time the Explorer failed.
    expect(verdict.state).toBe('UNVERIFIABLE');
    expect(verdict.closedGapIds).toEqual([]);
    expect(verdict.why).toContain('no readable crawl');
  });

  it('reports UNVERIFIABLE when the re-analysis returned a ranked PAGE', () => {
    const verdict = verifyConvergence({
      closures: [closure()],
      existingTests: [],
      reanalyze: () => ({ crawled: true, complete: false, openGapIds: new Set() }),
    });
    expect(verdict.state).toBe('UNVERIFIABLE');
    expect(verdict.why).toContain('ranked page');
  });

  it('reports UNVERIFIABLE for an empty closure list rather than a vacuous pass', () => {
    const verdict = verifyConvergence({
      closures: [],
      existingTests: [],
      reanalyze: () => ({ crawled: true, complete: true, openGapIds: new Set() }),
    });
    // "Nothing was proposed" is the absence of the experiment, not a result.
    expect(verdict.state).toBe('UNVERIFIABLE');
    expect(verdict.why).toContain('absence of the experiment');
  });

  it('reports DOES_NOT_CONVERGE and names the gap when the projection changes nothing', () => {
    const c = closure();
    const verdict = verifyConvergence({
      closures: [c],
      existingTests: [],
      reanalyze: () => ({ crawled: true, complete: true, openGapIds: new Set([c.gapId]) }),
    });
    expect(verdict.state).toBe('DOES_NOT_CONVERGE');
    expect(verdict.stillOpenGapIds).toEqual([c.gapId]);
    expect(verdict.why).toContain('Do not generate these');
  });

  it('hands the re-analysis the existing suite as well as the projections', () => {
    const c = closure();
    let seen: readonly CoverageTestInput[] = [];
    const existing: CoverageTestInput = {
      id: 't-existing',
      name: 'existing',
      filePath: 'a.spec.ts',
      feature: null,
      priority: 'IMPORTANT',
      testType: 'E2E',
      tags: [],
      routes: ['/'],
      code: null,
    };
    verifyConvergence({
      closures: [c],
      existingTests: [existing],
      reanalyze: (tests) => {
        seen = tests;
        return { crawled: true, complete: true, openGapIds: new Set() };
      },
    });
    /*
     * Re-analysing the projections ALONE would be a different question — "does
     * this gap close in a suite with nothing else in it?" — and would answer
     * CONVERGES for a closure that only converges because the existing suite is
     * missing. Goes red if the spread drops `existingTests`.
     */
    expect(seen.map((t) => t.id)).toEqual(['t-existing', `${PROJECTED_TEST_ID_PREFIX}${c.gapId}`]);
  });

  it('projects a test with NO sign-in code, because that is what the real one has', () => {
    const projected = projectClosedTest(closure());
    /*
     * Load-bearing. A test bound to an auth profile has no sign-in text at all —
     * the runner injects the session before the first navigation — so
     * `signsIn()` over its code is false and the ONLY thing that makes the next
     * analysis see an authenticated visitor is `authProfileId`. A projection
     * with plausible login code in it would converge through a route the real
     * generated test does not have: a green self-check for a loop that still
     * does not converge.
     */
    expect(projected.code).toBeNull();
    expect(projected.authProfileId).toBe('ap-admin');
    expect(projected.authProfileRequired).toBe(true);
    expect(projected.id.startsWith(PROJECTED_TEST_ID_PREFIX)).toBe(true);
  });
});

// ─── Which identity, and on what evidence ───────────────────────────────────

describe('bindRoleForGap', () => {
  it('prefers a MEASURED allowed cell over a name match', () => {
    const result = bindRoleForGap({
      gap: authGap({ authProfile: { id: 'ap-member', name: 'Member', why: 'name match.' } }),
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });
    expect(result.bound).toBe(true);
    if (!result.bound) return;
    // The gap's own chooser picked Member. The matrix watched Member get a 403.
    expect(result.binding.role).toBe('admin');
    expect(result.binding.source).toBe('OBSERVED_ALLOWED');
  });

  it('marks a DECLARED allowed cell as not a measurement', () => {
    /*
     * The non-contributing probe is not padding. `buildAccessMatrix` derives
     * its ROLE COLUMNS from the probes, so a declaration about a role nothing
     * ever attempted produces no cell at all — which is the realistic shape
     * here: the source says admin is allowed and no admin crawl has run.
     */
    const matrix = buildAccessMatrix({
      routes: ['/admin/users'],
      probes: [
        probe({
          role: 'admin',
          authProfileId: 'ap-admin',
          outcome: 'NEVER_ATTEMPTED',
          contributed: false,
          detail: 'no admin crawl has run on this environment',
          observations: [],
        }),
      ],
      declarations: [
        {
          routeTemplate: '/admin/users',
          role: 'admin',
          outcome: 'ALLOWED',
          source: 'middleware.ts: requireRole("admin")',
        },
      ],
    });
    const result = bindRoleForGap({
      gap: authGap({ authProfile: null }),
      matrix,
      profiles: [CLOSURE_ADMIN],
    });
    expect(result.bound).toBe(true);
    if (!result.bound) return;
    expect(result.binding.source).toBe('DECLARED_ALLOWED');
    // The whole value of holding declaration and observation side by side is
    // detecting where they disagree; a claim counted as a check erases that.
    expect(result.binding.measured).toBe(false);
    expect(result.binding.why).toContain('not on a measurement');
  });

  it('falls back to the gap\'s own chosen profile when nothing measured this route', () => {
    const result = bindRoleForGap({
      gap: authGap(),
      matrix: null,
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });
    expect(result.bound).toBe(true);
    if (!result.bound) return;
    expect(result.binding.source).toBe('CHOSEN_PROFILE');
    expect(result.binding.measured).toBe(false);
    expect(result.binding.authProfileId).toBe('ap-admin');
  });

  it('binds a profile the gap named and the caller did not pass', () => {
    /*
     * A real state: the gap travels out through GET /coverage and comes back
     * through POST /propose, and a profile can be deleted in between. Dropping
     * the binding would re-open the gap, which is the non-convergence this
     * module exists to remove.
     */
    const result = bindRoleForGap({
      gap: authGap(),
      matrix: null,
      profiles: [CLOSURE_MEMBER],
    });
    expect(result.bound).toBe(true);
    if (!result.bound) return;
    expect(result.binding.authProfileId).toBe('ap-admin');
    expect(result.binding.roleSource).toBe('PROFILE_NAME');
  });

  it('takes the role from the profile NAME when none is declared, and says so', () => {
    const result = bindRoleForGap({
      gap: authGap(),
      matrix: null,
      profiles: [{ id: 'ap-admin', name: 'Admin', role: null }],
    });
    expect(result.bound).toBe(true);
    if (!result.bound) return;
    /*
     * Attributing a profile with no declared role to `roleKey(null)` would file
     * an authenticated session under the logged-out column; refusing to close
     * would re-create the non-convergence for the common case. So the name
     * becomes the role and the binding discloses it.
     */
    expect(result.binding.role).toBe('Admin');
    expect(result.binding.roleSource).toBe('PROFILE_NAME');
    expect(result.binding.why).toContain('taken from the profile\'s NAME');
  });

  it('can actually produce every refusal it declares', () => {
    const produced = new Set<string>();

    produced.add(
      asRefusal(bindRoleForGap({ gap: authGap({ requiresAuth: false }), profiles: [CLOSURE_ADMIN] })),
    );
    produced.add(
      asRefusal(bindRoleForGap({ gap: authGap({ route: null }), profiles: [CLOSURE_ADMIN] })),
    );
    produced.add(asRefusal(bindRoleForGap({ gap: authGap(), profiles: [] })));
    produced.add(
      asRefusal(
        bindRoleForGap({
          gap: authGap({ authProfile: null }),
          matrix: matrixAdminInMemberOut(),
          profiles: [CLOSURE_MEMBER],
        }),
      ),
    );

    /*
     * Exhaustiveness over the declared list, in the shape principals.test.ts
     * uses: a refusal reason no code path can produce is a sentence the report
     * will never print, which is dead vocabulary pretending to be a decision.
     */
    expect([...produced].sort()).toEqual([...ROLE_BINDING_REFUSAL_LIST].sort());
  });

  it('refuses rather than binding an identity it watched bounce off the route', () => {
    const result = bindRoleForGap({
      gap: authGap({ authProfile: { id: 'ap-member', name: 'Member', why: 'only profile.' } }),
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_MEMBER],
    });
    expect(result.bound).toBe(false);
    if (result.bound) return;
    expect(result.refusal).toBe('NO_ROLE_REACHES_IT');
    // Not a pass and not a zero: the detail is what the report prints.
    expect(result.detail).toContain('every one was refused');
  });

  it('does NOT refuse on incomplete evidence — one unprobed candidate is inconclusive', () => {
    /*
     * The member was measured and refused; the admin was never probed. Refusing
     * here would leave the gap open on the strength of a cell nobody asked
     * about, which is the NOT_PROBED-read-as-a-fact defect access-matrix.ts
     * refuses one level down.
     */
    const matrix = buildAccessMatrix({
      routes: ['/admin/users'],
      probes: [
        probe({
          role: 'member',
          authProfileId: 'ap-member',
          observations: [observation('/admin/users', 'DENIED', 403)],
        }),
      ],
    });
    const result = bindRoleForGap({
      gap: authGap(),
      matrix,
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });
    expect(result.bound).toBe(true);
    if (!result.bound) return;
    expect(result.binding.role).toBe('admin');
    expect(result.binding.source).toBe('CHOSEN_PROFILE');
  });

  it('binds the same identity however the profiles are ordered', () => {
    const forwards = bindRoleForGap({
      gap: authGap({ authProfile: null }),
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });
    const backwards = bindRoleForGap({
      gap: authGap({ authProfile: null }),
      matrix: matrixAdminInMemberOut(),
      profiles: [CLOSURE_MEMBER, CLOSURE_ADMIN],
    });
    // A gap id is stable across recomputation; the role behind it has to be too,
    // or the closure ledger is comparing two closures under one name.
    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
  });
});

function asRefusal(result: ReturnType<typeof bindRoleForGap>): string {
  expect(result.bound, 'this input must refuse').toBe(false);
  return result.bound ? 'BOUND' : result.refusal;
}

describe('roleOfProfile', () => {
  it('prefers the declared role and falls back to the name', () => {
    expect(roleOfProfile(CLOSURE_ADMIN)).toEqual({ role: 'admin', roleSource: 'DECLARED_ROLE' });
    expect(roleOfProfile({ id: 'x', name: 'Admin', role: null })).toEqual({
      role: 'Admin',
      roleSource: 'PROFILE_NAME',
    });
  });

  it('treats a whitespace-only declared role as undeclared', () => {
    // `roleKey` trims, so '   ' would otherwise become the anonymous role and
    // file an authenticated profile in the logged-out column.
    expect(roleOfProfile({ id: 'x', name: 'Admin', role: '   ' })).toEqual({
      role: 'Admin',
      roleSource: 'PROFILE_NAME',
    });
  });
});

// ─── (route, role) attribution ───────────────────────────────────────────────

describe('roleCoverageCells', () => {
  const adminTest = { id: 't-admin', routes: ['/admin/users'], authProfileId: 'ap-admin' };

  it('attributes coverage to the CELL, so an admin test does not cover the member cell', () => {
    const coverage = roleCoverageCells({
      matrix: matrixAdminInMemberOut(),
      tests: [adminTest],
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });

    const cell = (route: string, role: string) =>
      coverage.cells.find((c) => c.route === route && c.role === role);

    /*
     * THE SECOND HALF OF THE DEFECT. Attributed to the ROUTE, one admin test
     * marked /admin/users covered and silently answered "what does a member get
     * here?" with "covered" — and that cell is where the expensive defects are.
     */
    expect(cell('/admin/users', 'admin')?.state).toBe('COVERED');
    expect(cell('/admin/users', 'admin')?.testIds).toEqual(['t-admin']);
    expect(cell('/admin/users', 'member')?.state).toBe('ROLE_REFUSED');
    expect(cell('/', 'admin')?.state).toBe('UNCOVERED');
  });

  it('keeps ROLE_REFUSED out of the uncovered count', () => {
    const coverage = roleCoverageCells({
      matrix: matrixAdminInMemberOut(),
      tests: [adminTest],
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });
    // Counting a measured refusal as a hole asks a team to write a test that
    // signs in as somebody who cannot get in.
    expect(coverage.counts.roleRefused).toBe(1);
    /*
     * Keyed on the CELL and not on the role column: ('/', member) IS genuinely
     * uncovered — the member was observed being served the home page and no
     * member-bound test visits it — and asserting over the column alone would
     * pass for the wrong reason.
     */
    const uncovered = coverage.cells
      .filter((c) => c.state === 'UNCOVERED')
      .map((c) => `${c.route}|${c.role}`);
    expect(uncovered).not.toContain('/admin/users|member');
    expect(uncovered).toContain('/|member');
  });

  it('keeps NOT_PROBED separate from UNCOVERED', () => {
    const matrix = buildAccessMatrix({
      routes: ['/', '/admin/users'],
      probes: [
        probe({
          role: 'admin',
          authProfileId: 'ap-admin',
          observations: [
            observation('/', 'ALLOWED', 200),
            observation('/admin/users', 'ALLOWED', 200),
          ],
        }),
        // The member pass's login failed, so it contributed nothing.
        probe({
          role: 'member',
          authProfileId: 'ap-member',
          outcome: 'LOGIN_FAILED',
          contributed: false,
          detail: 'the member login did not complete',
          observations: [],
        }),
      ],
    });
    const coverage = roleCoverageCells({
      matrix,
      tests: [adminTest],
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });

    /*
     * A cell nobody asked about is not a hole in the customer's suite, and
     * reporting it as one manufactures a denominator — the exact failure
     * access-matrix.ts refuses one level down. Goes red if NOT_PROBED is folded
     * into UNCOVERED.
     */
    const member = coverage.cells.filter((c) => c.role === 'member');
    expect(member.every((c) => c.state === 'NOT_PROBED')).toBe(true);
    expect(coverage.counts.uncovered).toBe(1); // only ('/', 'admin')
  });

  it('discloses the unprobed cells as a count AND a reason', () => {
    const matrix = buildAccessMatrix({
      routes: ['/', '/admin/users'],
      probes: [
        probe({
          role: 'member',
          authProfileId: 'ap-member',
          outcome: 'LOGIN_FAILED',
          contributed: false,
          detail: 'the member login did not complete',
          observations: [],
        }),
      ],
    });
    const coverage = roleCoverageCells({ matrix, tests: [], profiles: [CLOSURE_MEMBER] });

    expect(coverage.gaps.length).toBeGreaterThan(0);
    expect(coverage.gaps.reduce((n, g) => n + g.cells, 0)).toBe(coverage.counts.notProbed);
    // "61 cells are not probed because the member login failed" has a fix in it.
    // "61 cells are not probed" does not.
    expect(coverage.gaps.every((g) => g.reason.trim().length > 0)).toBe(true);
  });

  it('accounts for every cell: the parts sum to the whole', () => {
    const coverage = roleCoverageCells({
      matrix: matrixAdminInMemberOut(),
      tests: [adminTest],
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });
    const { covered, uncovered, roleRefused, notProbed, cells } = coverage.counts;
    expect(covered + uncovered + roleRefused + notProbed).toBe(cells);
    expect(cells).toBe(coverage.cells.length);
    // routes × roles — the denominator this axis finally has.
    expect(cells).toBe(
      matrixAdminInMemberOut().routes.length * matrixAdminInMemberOut().roles.length,
    );
  });

  it('attributes an UNBOUND test to no cell at all', () => {
    const coverage = roleCoverageCells({
      matrix: matrixAdminInMemberOut(),
      tests: [{ id: 't-anon', routes: ['/admin/users'] }],
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });
    // Spreading an anonymous test across every role is how one smoke test came
    // to mark a whole matrix covered. The undercount is the error worth having.
    expect(coverage.counts.covered).toBe(0);
  });

  it('attributes a test whose profile was deleted to no cell', () => {
    const coverage = roleCoverageCells({
      matrix: matrixAdminInMemberOut(),
      tests: [
        { id: 't-broken', routes: ['/admin/users'], authProfileId: null, authProfileRequired: true },
      ],
      profiles: [CLOSURE_ADMIN, CLOSURE_MEMBER],
    });
    // It is running anonymously and passing whatever a signed-out visitor sees.
    expect(coverage.counts.covered).toBe(0);
  });

  it('does not let a parent route stand in for a child', () => {
    const matrix = buildAccessMatrix({
      routes: ['/admin', '/admin/users'],
      probes: [
        probe({
          role: 'admin',
          authProfileId: 'ap-admin',
          observations: [
            observation('/admin', 'ALLOWED', 200),
            observation('/admin/users', 'ALLOWED', 200),
          ],
        }),
      ],
    });
    const coverage = roleCoverageCells({
      matrix,
      tests: [{ id: 't', routes: ['/admin'], authProfileId: 'ap-admin' }],
      profiles: [CLOSURE_ADMIN],
    });
    // `routeVisits` is strict on length for exactly this reason, and the
    // attribution has to inherit that or a route is silently covered by its parent.
    expect(coverage.cells.find((c) => c.route === '/admin')?.state).toBe('COVERED');
    expect(coverage.cells.find((c) => c.route === '/admin/users')?.state).toBe('UNCOVERED');
  });
});

describe('roleCoverageCellKey', () => {
  it('cannot collide two different (route, role) pairs', () => {
    // A slash separator makes ('/a', 'b/c') and ('/a/b', 'c') the same key, and a
    // role is customer-supplied text.
    expect(roleCoverageCellKey({ route: '/a', role: 'b/c' })).not.toBe(
      roleCoverageCellKey({ route: '/a/b', role: 'c' }),
    );
  });
});

// ─── The round, and the cap ──────────────────────────────────────────────────

describe('closureRound', () => {
  const manyGaps = (n: number): ClosureGap[] =>
    Array.from({ length: n }, (_, i) =>
      authGap({ id: `gap_${String(i).padStart(3, '0')}`, route: `/admin/page-${i}` }),
    );

  it('accounts for every gap it was offered', () => {
    const round = closureRound({
      gaps: [...manyGaps(3), authGap({ id: 'gap_open', requiresAuth: false })],
      profiles: [CLOSURE_ADMIN],
      seed: SEED,
    });
    expect(round.considered).toBe(4);
    expect(round.closures.length + round.refusals.length + round.capped.dropped).toBe(4);
  });

  it('DISCLOSES the cap as a count and a reason', () => {
    const round = closureRound({
      gaps: manyGaps(MAX_CLOSURES_PER_ROUND + 4),
      profiles: [CLOSURE_ADMIN],
      seed: SEED,
    });
    expect(round.closures).toHaveLength(MAX_CLOSURES_PER_ROUND);
    expect(round.capped.dropped).toBe(4);
    // A capped list that presents itself as complete is the dishonesty this
    // field removes: "at least N more existed" has to be sayable.
    expect(round.capped.reason).toContain('At least 4 more');
    expect(round.capped.reason).toContain(String(MAX_CLOSURES_PER_ROUND));
  });

  it('says the cap did NOT bite, rather than saying nothing', () => {
    const round = closureRound({ gaps: manyGaps(2), profiles: [CLOSURE_ADMIN], seed: SEED });
    // A report that can only speak when it was truncated cannot tell a complete
    // list from a truncated one.
    expect(round.capped.dropped).toBe(0);
    expect(round.capped.reason).toBeNull();
    expect(round.capped.limit).toBe(MAX_CLOSURES_PER_ROUND);
  });

  it('never exceeds the module cap however high a caller asks', () => {
    const round = closureRound({
      gaps: manyGaps(MAX_CLOSURES_PER_ROUND + 2),
      profiles: [CLOSURE_ADMIN],
      seed: SEED,
      limit: 10_000,
    });
    expect(round.closures).toHaveLength(MAX_CLOSURES_PER_ROUND);
    expect(round.capped.limit).toBe(MAX_CLOSURES_PER_ROUND);
  });

  it('records a refusal rather than dropping the gap', () => {
    const round = closureRound({ gaps: [authGap()], profiles: [], seed: SEED });
    expect(round.closures).toEqual([]);
    expect(round.refusals).toEqual([
      {
        gapId: 'gap_admin',
        refusal: 'NO_PROFILE_CONFIGURED',
        detail: expect.stringContaining('no auth profile is configured'),
      },
    ]);
  });

  it('gives every gap in one run its own scenario name', () => {
    const round = closureRound({ gaps: manyGaps(5), profiles: [CLOSURE_ADMIN], seed: SEED });
    const names = round.closures.map((c) => c.scenarioName);
    // Two closures in one run that share a name are two scenarios nothing can
    // tell apart in a report or a ledger row.
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('closureScenarioName', () => {
  it('is stable for a (seed, gapId) and moves with either', () => {
    expect(closureScenarioName(SEED, 'gap_a')).toBe(closureScenarioName(SEED, 'gap_a'));
    expect(closureScenarioName(SEED, 'gap_a')).not.toBe(closureScenarioName(SEED, 'gap_b'));
    expect(closureScenarioName(SEED, 'gap_a')).not.toBe(closureScenarioName('other', 'gap_a'));
  });
});

// ─── Determinism, asserted over the source ───────────────────────────────────

describe('generation is reproducible', () => {
  /*
   * Comments STRIPPED before the grep, because this module's own header names
   * `Math.random`, `Date.now` and `new Date()` in the sentence that promises it
   * does not call them. A grep over the raw file is therefore red for the
   * document that states the rule, which is a test that punishes writing the
   * reason down. Code is the thing under assertion.
   */
  const source = readFileSync(fileURLToPath(new URL('./gap-closure.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('strips comments but keeps the code, so the greps below mean something', () => {
    // Guards the stripper itself: a regex that ate the whole file would make
    // every assertion below pass for the worst possible reason.
    expect(source).toContain('export function closureRound');
    expect(source).not.toContain('SESSION-AWARE GAP CLOSURE');
  });

  it('contains no ambient clock and no randomness', () => {
    /*
     * The commonest cause of the flake this product exists to eliminate is a
     * generator that is not reproducible. Asserted over the SOURCE rather than
     * over behaviour because a `Date.now()` on a rarely-taken branch passes
     * every behavioural test and then produces a suite nobody can debug.
     */
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/new Date\(/);
    expect(source).not.toMatch(/performance\.now/);
  });

  it('has no model call and no network import', () => {
    // There is no ANTHROPIC_API_KEY on this deployment and there must not need
    // to be: a model may only ever ENRICH what this already produced.
    expect(source).not.toMatch(/@anthropic-ai/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/from 'node:https?'/);
  });
});
