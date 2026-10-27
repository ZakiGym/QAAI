/**
 * THE CLOSURE LOOP, PROVED TO CONVERGE.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * An UNREACHED_AUTH_ROUTE gap says "no AUTHENTICATED test reaches this route".
 * The closure loop answered it with a SECURITY_SMOKE that could only assert
 * anonymous denial — so the test passed, the route was still unreached by any
 * authenticated test, the next analysis re-derived the identical gap, and the
 * campaign proposed the same work again. A loop that cannot converge.
 *
 * These tests run the loop for real: analyse → gap → plan item → the test that
 * item would produce → RE-ANALYSE. The convergence claim is the second report,
 * and the non-convergence claim is pinned too, because a test that only shows
 * the happy case cannot fail when the fix is removed.
 */

import { describe, expect, it } from 'vitest';
import { ANONYMOUS_ROLE } from '@qaai/shared';
import {
  analyzeCoverage,
  attributeRouteRoles,
  joinGapClosure,
  planItemForGap,
  roleOfTest,
  routeRoleCellKey,
} from './coverage.js';
import type { CoverageTestInput } from './coverage.js';

const ADMIN_PROFILE = { id: 'prof_admin', name: 'Admin', kind: 'FORM_LOGIN' };

/** A crawl with one public route and one the crawler hit an auth wall on. */
const flowMapGraph = {
  version: 1,
  baseUrl: 'https://app.example.com',
  nodes: [
    {
      id: 'n_home',
      route: '/',
      title: 'Home',
      stateKey: '/',
      behindAuth: false,
      forms: [],
      affordances: [],
      requiresRoles: [],
    },
    {
      id: 'n_admin',
      route: '/admin/settings',
      title: 'Settings',
      stateKey: '/admin/settings',
      behindAuth: true,
      forms: [],
      affordances: [],
      requiresRoles: ['admin'],
    },
  ],
  edges: [],
  journeys: [],
  features: [],
};

const test = (over: Partial<CoverageTestInput> & { id: string }): CoverageTestInput => ({
  name: over.id,
  filePath: `tests/${over.id}.spec.ts`,
  feature: null,
  priority: 'IMPORTANT',
  testType: 'E2E',
  tags: [],
  routes: [],
  code: null,
  ...over,
});

const authGapsOf = (tests: CoverageTestInput[]) =>
  analyzeCoverage({
    flowMapGraph,
    tests,
    authProfiles: [ADMIN_PROFILE],
  }).gaps.filter((gap) => gap.kind === 'UNREACHED_AUTH_ROUTE');

describe('closing an auth-route gap no longer re-creates it', () => {
  it('derives the gap when nothing reaches the guarded route', () => {
    const gaps = authGapsOf([test({ id: 't_home', routes: ['/'] })]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.route).toBe('/admin/settings');
    expect(gaps[0]!.requiresAuth).toBe(true);
    // The gap names the profile, which is what makes the item bindable at all.
    expect(gaps[0]!.authProfile?.id).toBe(ADMIN_PROFILE.id);
  });

  it('mints a plan item BOUND to the role the gap asked for', () => {
    const gap = authGapsOf([test({ id: 't_home', routes: ['/'] })])[0]!;
    expect(planItemForGap(gap).authProfileId).toBe(ADMIN_PROFILE.id);
  });

  it('CONVERGES: the gap is gone once a test bound to that role exists', () => {
    const gap = authGapsOf([test({ id: 't_home', routes: ['/'] })])[0]!;
    const item = planItemForGap(gap);

    // The test that plan item produces: same route, bound to the item's role.
    // This is exactly what the generate processor writes onto the Test row.
    const closing = test({
      id: 't_admin',
      routes: ['/admin/settings'],
      authProfileId: item.authProfileId,
      authProfileRequired: item.authProfileId !== null,
    });

    expect(authGapsOf([test({ id: 't_home', routes: ['/'] }), closing])).toEqual([]);
  });

  it('DOES NOT converge on an anonymous test — the defect, pinned', () => {
    /*
     * The old SECURITY_SMOKE: it reaches the route and runs as nobody. It can
     * only prove the wall holds, so the page behind it is still uncovered and
     * the gap MUST still be reported. If this expectation ever flips to `[]`,
     * the product has started counting a signed-out visit as coverage of a page
     * behind an auth wall.
     */
    const anonymous = test({ id: 't_wall', routes: ['/admin/settings'] });
    const gaps = authGapsOf([test({ id: 't_home', routes: ['/'] }), anonymous]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.route).toBe('/admin/settings');
  });

  it('DOES NOT converge on a test whose profile was deleted', () => {
    // authProfileRequired stayed true, the FK nulled the id. There is no
    // session to inject, so the test does not reach the page however much it
    // looks like a signed-in one.
    const broken = test({
      id: 't_broken',
      routes: ['/admin/settings'],
      authProfileId: null,
      authProfileRequired: true,
    });
    expect(authGapsOf([broken])).toHaveLength(1);
  });
});

describe('the (route, role) attribution', () => {
  const tests = [
    test({ id: 't_home', routes: ['/'] }),
    test({
      id: 't_admin',
      routes: ['/admin/settings'],
      authProfileId: 'prof_admin',
      authProfileRequired: true,
    }),
    test({ id: 't_broken', routes: ['/admin/settings'], authProfileRequired: true }),
  ];
  const attribution = attributeRouteRoles({
    routes: ['/', '/admin/settings'],
    tests,
    roles: ['prof_admin', 'prof_member'],
  });

  it('separates the same route reached by two different roles', () => {
    // The whole defect in one assertion: route-only attribution made these one
    // cell, so an anonymous visit closed a gap that wanted an admin one.
    expect(attribution.byKey.get(routeRoleCellKey('/admin/settings', 'prof_admin'))?.testIds).toEqual(
      ['t_admin'],
    );
    expect(
      attribution.byKey.get(routeRoleCellKey('/admin/settings', ANONYMOUS_ROLE))?.testIds,
    ).toEqual([]);
  });

  it('gives a configured role its own cells even with no test, so the gap is visible', () => {
    // A role with no cells reads as nothing to cover rather than as something
    // uncovered — the same bug, in the denominator.
    const cell = attribution.byKey.get(routeRoleCellKey('/admin/settings', 'prof_member'));
    expect(cell).toBeDefined();
    expect(cell!.testIds).toEqual([]);
  });

  it('attributes a BROKEN binding to no role at all, and names it', () => {
    expect(attribution.brokenBindingTestIds).toEqual(['t_broken']);
    for (const cell of attribution.cells) expect(cell.testIds).not.toContain('t_broken');
    // Specifically NOT credited to the anonymous role, which would report the
    // signed-out surface as better covered than it is.
    expect(roleOfTest({ authProfileId: null, authProfileRequired: true }).kind).toBe(
      'BROKEN_BINDING',
    );
  });

  it('names the tests it read partially, so an empty cell is not read as UNCOVERED', () => {
    const partial = attributeRouteRoles({
      routes: ['/'],
      tests: [test({ id: 't_capped', routes: [], coverageTruncated: true })],
    });
    expect(partial.truncatedTestIds).toEqual(['t_capped']);
  });

  it('is deterministic', () => {
    const again = attributeRouteRoles({
      routes: ['/', '/admin/settings'],
      tests,
      roles: ['prof_admin', 'prof_member'],
    });
    expect(again.cells).toEqual(attribution.cells);
  });
});

describe('the gap → plan item → test join', () => {
  const gap = { id: 'gap_admin', requiresAuth: true, authProfile: { id: 'prof_admin', name: 'Admin', why: 'the fixture names it' } };

  it('reports OPEN when nothing has been proposed', () => {
    const join = joinGapClosure({ gaps: [gap], planItems: [], tests: [] });
    expect(join.byGapId.get('gap_admin')!.state).toBe('OPEN');
    expect(join.counts.OPEN).toBe(1);
  });

  it('distinguishes PROPOSED from OPEN, so the loop stops re-proposing', () => {
    const join = joinGapClosure({
      gaps: [gap],
      planItems: [
        { id: 'pi_1', gapId: 'gap_admin', authProfileId: 'prof_admin', generatedTestId: null },
      ],
      tests: [],
    });
    const link = join.byGapId.get('gap_admin')!;
    expect(link.state).toBe('PROPOSED');
    expect(link.planItemIds).toEqual(['pi_1']);
  });

  it('reports CLOSED when the test is bound to the role the gap asked for', () => {
    const join = joinGapClosure({
      gaps: [gap],
      planItems: [
        { id: 'pi_1', gapId: 'gap_admin', authProfileId: 'prof_admin', generatedTestId: 't_1' },
      ],
      tests: [
        {
          id: 't_1',
          gapId: 'gap_admin',
          planItemId: 'pi_1',
          authProfileId: 'prof_admin',
          authProfileRequired: true,
        },
      ],
    });
    expect(join.byGapId.get('gap_admin')!.state).toBe('CLOSED');
  });

  it('reports TEST_WRONG_ROLE rather than CLOSED for an anonymous test — the old bug', () => {
    const join = joinGapClosure({
      gaps: [gap],
      planItems: [{ id: 'pi_1', gapId: 'gap_admin', authProfileId: null, generatedTestId: 't_1' }],
      tests: [{ id: 't_1', gapId: 'gap_admin', planItemId: 'pi_1', authProfileId: null }],
    });
    const link = join.byGapId.get('gap_admin')!;
    expect(link.state).toBe('TEST_WRONG_ROLE');
    expect(link.wantedRole).toBe('prof_admin');
    expect(link.actualRoles).toEqual([ANONYMOUS_ROLE]);
    // And it SAYS so, in words a human can act on.
    expect(link.why).toContain('still uncovered');
  });

  it('finds the gap through planItemId when Test.gapId was never written', () => {
    // Tests generated before the column existed carry only planItemId. Reading
    // one route alone under-reports closure and re-proposes work that exists.
    const join = joinGapClosure({
      gaps: [gap],
      planItems: [
        { id: 'pi_1', gapId: 'gap_admin', authProfileId: 'prof_admin', generatedTestId: 't_1' },
      ],
      tests: [
        { id: 't_1', gapId: null, planItemId: 'pi_1', authProfileId: 'prof_admin' },
      ],
    });
    expect(join.byGapId.get('gap_admin')!.testIds).toEqual(['t_1']);
    expect(join.byGapId.get('gap_admin')!.state).toBe('CLOSED');
  });

  it('reports a dangling provenance rather than dropping it', () => {
    const join = joinGapClosure({
      gaps: [gap],
      planItems: [{ id: 'pi_x', gapId: 'gap_vanished', authProfileId: null, generatedTestId: null }],
      tests: [{ id: 't_x', gapId: 'gap_vanished', planItemId: null, authProfileId: null }],
    });
    expect(join.orphanedPlanItemIds).toEqual(['pi_x']);
    expect(join.orphanedTestIds).toEqual(['t_x']);
  });

  it('leaves a cold plan item out of the join entirely', () => {
    // gapId null is "not minted for a gap", not a missing value to be guessed.
    const join = joinGapClosure({
      gaps: [gap],
      planItems: [{ id: 'pi_cold', gapId: null, authProfileId: null, generatedTestId: null }],
      tests: [],
    });
    expect(join.orphanedPlanItemIds).toEqual([]);
    expect(join.byGapId.get('gap_admin')!.planItemIds).toEqual([]);
  });

  it('does not care about role when the gap needed none', () => {
    const join = joinGapClosure({
      gaps: [{ id: 'gap_public', requiresAuth: false, authProfile: null }],
      planItems: [],
      tests: [{ id: 't_1', gapId: 'gap_public', planItemId: null, authProfileId: 'prof_admin' }],
    });
    expect(join.byGapId.get('gap_public')!.state).toBe('TEST_WRITTEN');
  });

  it('accounts for every gap exactly once across the states', () => {
    const gaps = [
      gap,
      { id: 'gap_b', requiresAuth: false, authProfile: null },
      { id: 'gap_c', requiresAuth: true, authProfile: { id: 'prof_admin', name: 'Admin', why: 'the fixture names it' } },
    ];
    const join = joinGapClosure({ gaps, planItems: [], tests: [] });
    const total = Object.values(join.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(gaps.length);
    expect(join.links).toHaveLength(gaps.length);
  });
});
