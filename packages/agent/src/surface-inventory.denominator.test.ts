/**
 * The union's denominator, probed against the ways it can be quietly wrong.
 *
 * `surface-coverage.test.ts` covers what `buildSurfaceInventory` produces.
 * These are the four defects an adversarial pass found in the arithmetic
 * underneath it, each demonstrated against a fixture application before it was
 * fixed and each pinned here:
 *
 *   - a declared CATCH-ALL absorbing nothing, so a documentation subtree came
 *     out of this union as three items while `reconcileSurface` answered one
 *     row for the same two declarers and the same two spellings
 *   - a template declared by any declarer other than the repo absorbing
 *     nothing, because the template list was taken before those items arrived
 *   - a REFUSED destructive surface absorbed into a declared dynamic route,
 *     which carried the refusal onto a real route, dropped that route out of
 *     the coverage denominator, and deleted the refusal as an item
 *   - "reached by a crawl" printed over items that were declared by real
 *     traffic, or that the crawl had explicitly refused to open
 *
 * Every one of them moves the denominator or the reason attached to it, which
 * is the only thing this product sells.
 */

import { describe, expect, it } from 'vitest';
import { totalsForKind, type CodebaseAnalysis, type FlowMap, type SurfaceItem } from '@qaai/shared';
import { buildSurfaceInventory, type SurfaceSourceAsked } from './surface-inventory.js';
import { analyseSurfaceCoverage } from './surface-coverage.js';
import { reconcileSurface, type ReconcileSourceInput } from './reconcile.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function analysis(routes: Array<{ route: string; dynamic?: boolean }>): CodebaseAnalysis {
  return {
    routes: routes.map(({ route, dynamic = route.includes('[') || route.includes(':') }) => ({
      route,
      detector: 'next-app-router',
      file: `app${route.replace(/[:[\]*.]/g, '_')}/page.tsx`,
      evidence: 'directory path is the URL',
      dynamic,
    })),
    endpoints: [],
    forms: [],
    authSurfaces: [],
    detectors: [],
    coverage: { filesSeen: routes.length, filesWithContent: routes.length },
    warnings: [],
    notes: [],
    shortfalls: [],
  } as unknown as CodebaseAnalysis;
}

function node(route: string) {
  return {
    id: `n-${route}`,
    route,
    url: `https://fixture.test${route}`,
    title: route,
    stateKey: 'default',
    requiresRoles: [],
    behindAuth: false,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
  };
}

function flowMap(overrides: Partial<FlowMap> = {}): FlowMap {
  return {
    projectId: 'p1',
    environmentId: 'env-prod',
    version: 3,
    baseUrl: 'https://fixture.test',
    nodes: [],
    edges: [],
    journeys: [],
    features: [],
    exploredAt: '2026-10-20T10:00:00.000Z',
    truncatedReason: null,
    excluded: [],
    ...overrides,
  } as FlowMap;
}

function declaredItem(key: string, sources: SurfaceItem['sources']): SurfaceItem {
  return {
    kind: 'ROUTE',
    key,
    label: key.slice('ROUTE:'.length),
    file: null,
    line: null,
    sources,
    origin: 'SOURCE_ONLY',
    evidence: `a ${(sources ?? []).join('/')} declarer named ${key.slice('ROUTE:'.length)}`,
    detector: null,
  };
}

const asked = (...sources: SurfaceSourceAsked['source'][]): SurfaceSourceAsked[] =>
  sources.map((source) => ({ source, participation: 'LOADED', detail: `${source} was read` }));

function routeKeys(items: readonly SurfaceItem[]): string[] {
  return items
    .filter((item) => item.kind === 'ROUTE')
    .map((item) => item.key)
    .sort();
}

// ─── Templates ───────────────────────────────────────────────────────────────

describe('a declared template absorbs its instances, whoever declared it', () => {
  /*
   * `canonicalRoute` spells `[...slug]`, `[[...slug]]` and a literal `/docs/*`
   * as `/docs/*`, and the template filter only looked for `:param`. So the
   * subtree came out as three items and the reconciliation — same two
   * declarers, same two spellings, `routeVisits` either way — came out as one
   * row. Two inventories of one application is the defect this slice exists to
   * end, so the agreement between the two modules is asserted, not just the
   * count.
   */
  it('folds a crawled subtree into the catch-all a hand entry declared', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({ nodes: [node('/docs/intro'), node('/docs/guides/auth')] }),
      observed: [declaredItem('ROUTE:/docs/*', ['MANUAL'])],
      participation: asked('CRAWL', 'MANUAL'),
    });

    expect(routeKeys(inventory.items)).toEqual(['ROUTE:/docs/*']);
    const docs = inventory.items.find((item) => item.key === 'ROUTE:/docs/*');
    expect([...(docs?.sources ?? [])].sort()).toEqual(['CRAWL', 'MANUAL']);
    expect(docs?.origin).toBe('BOTH');
    expect(inventory.caveats.join(' ')).toContain('folded into the dynamic route');

    const report = reconcileSurface({
      projectId: 'p1',
      environmentId: 'env-prod',
      axis: 'ROUTE',
      sources: [
        {
          source: 'MANUAL',
          participation: 'LOADED',
          detail: 'one hand-entered subtree',
          entries: [{ spelling: '/docs/*' }],
          environmentId: null,
        } satisfies ReconcileSourceInput,
        {
          source: 'CRAWL',
          participation: 'LOADED',
          detail: 'two pages visited',
          entries: [{ spelling: '/docs/intro' }, { spelling: '/docs/guides/auth' }],
          environmentId: 'env-prod',
        } satisfies ReconcileSourceInput,
      ],
    });
    // The two modules must agree about how many surfaces this is.
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.state).toBe('DECLARED_AND_REACHED');
    expect(routeKeys(inventory.items)).toHaveLength(report.rows.length);
  });

  it('prefers the more specific template, so a catch-all keeps only the deeper paths', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis([{ route: '/docs/[slug]' }, { route: '/docs/[...rest]' }]),
      flowMap: flowMap({ nodes: [node('/docs/intro'), node('/docs/guides/auth')] }),
      participation: asked('SOURCE', 'CRAWL'),
    });

    expect(routeKeys(inventory.items)).toEqual(['ROUTE:/docs/*', 'ROUTE:/docs/:param']);
    // One segment went to `:param`; two segments could only go to `*`.
    const single = inventory.items.find((item) => item.key === 'ROUTE:/docs/:param');
    const deep = inventory.items.find((item) => item.key === 'ROUTE:/docs/*');
    expect(single?.origin).toBe('BOTH');
    expect(deep?.origin).toBe('BOTH');
  });

  it('does not let a template swallow another template', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis([{ route: '/docs/[...rest]' }]),
      flowMap: null,
      observed: [declaredItem('ROUTE:/docs/:param', ['CATALOGUE'])],
      participation: asked('SOURCE', 'CATALOGUE'),
    });
    expect(routeKeys(inventory.items)).toEqual(['ROUTE:/docs/*', 'ROUTE:/docs/:param']);
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe('a refused surface is never an instance of anything', () => {
  /*
   * THE WORST OF THE FOUR. An application declaring `/[slug]` — an ordinary CMS
   * catch-all — plus a crawl that refused `/logout` produced ONE item: the
   * refusal was folded into the declared route, the route inherited
   * UNEXERCISABLE/SESSION_ENDING through `preferExercise`, `totalsForKind` held
   * it out of the coverage denominator, and the ROUTE axis came back
   * `denominator: 0, percent: null` for an application with a route and a
   * logout. The riskiest surface in the application deleted a real route from
   * the denominator and then vanished itself.
   */
  it('keeps a refused logout and a declared dynamic route as two surfaces', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis([{ route: '/[slug]' }]),
      flowMap: flowMap({
        excluded: [
          {
            url: 'https://fixture.test/logout',
            route: '/logout',
            kind: 'SESSION_ENDING',
            rule: 'session-ending-path',
            discoveredFrom: null,
          },
        ],
      }),
      participation: asked('SOURCE', 'CRAWL'),
    });

    expect(routeKeys(inventory.items)).toEqual(['ROUTE:/:param', 'ROUTE:/logout']);
    const declared = inventory.items.find((item) => item.key === 'ROUTE:/:param');
    const refused = inventory.items.find((item) => item.key === 'ROUTE:/logout');
    // The declared route must not carry another surface's reason.
    expect(declared?.exercise).toBeUndefined();
    expect(refused?.exercise?.state).toBe('UNEXERCISABLE');
    expect(refused?.exercise?.reason).toBe('SESSION_ENDING');
    expect(inventory.heldOut).toEqual({ unexercisable: 1, refused: 0 });

    // And the division must still have something to divide by.
    const coverage = analyseSurfaceCoverage({
      items: inventory.items,
      tests: [],
      executions: [],
      waivers: {},
    });
    const routes = coverage.totals.byKind.find((totals) => totals.kind === 'ROUTE');
    expect(routes?.denominator).toBe(1);
    expect(routes?.unexercisable).toBe(1);
  });

  /*
   * `ExcludedPath.route` is "the normalised route, WHEN IT COULD BE DERIVED",
   * and this module keyed a refusal with no stored route on the raw URL — so
   * one /logout refused twice, once with a route and once without, came out as
   * TWO unexercisable surfaces with one of them keyed `ROUTE:https://…?next=%2F`
   * — a ROUTE key that is not a route and can never be matched by a test. The
   * gap report in coverage.ts read the pathname out of the same field and
   * counted one, so the two readers of one ledger disagreed about how many
   * destructive surfaces this application has.
   */
  it('counts one refused surface once when only some entries carry a route', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({
        excluded: [
          {
            url: 'https://fixture.test/logout',
            route: '/logout',
            kind: 'SESSION_ENDING',
            rule: 'session-ending-path',
            discoveredFrom: null,
          },
          {
            url: 'https://fixture.test/logout?next=%2F',
            route: null,
            kind: 'SESSION_ENDING',
            rule: 'session-ending-path',
            discoveredFrom: null,
          },
        ],
      }),
      participation: asked('CRAWL'),
    });

    expect(routeKeys(inventory.items)).toEqual(['ROUTE:/logout']);
    expect(inventory.heldOut).toEqual({ unexercisable: 1, refused: 0 });
  });

  it('still keeps a refusal whose URL has no readable path, keyed on the URL', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({
        excluded: [
          {
            url: 'not-a-url-at-all',
            route: null,
            kind: 'DESTRUCTIVE',
            rule: 'destructive-path',
            discoveredFrom: null,
          },
        ],
      }),
      participation: asked('CRAWL'),
    });
    // Dropping it would hide exactly the class the ledger exists to show.
    expect(routeKeys(inventory.items)).toEqual(['ROUTE:not-a-url-at-all']);
    expect(inventory.heldOut.unexercisable).toBe(1);
  });

  it('does not describe a refusal as a crawled URL that was folded in', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis([{ route: '/[slug]' }]),
      flowMap: flowMap({
        excluded: [
          {
            url: 'https://fixture.test/delete-account',
            route: '/delete-account',
            kind: 'DESTRUCTIVE',
            rule: 'destructive-path',
            discoveredFrom: null,
          },
        ],
      }),
      participation: asked('SOURCE', 'CRAWL'),
    });
    expect(inventory.caveats.join(' ')).not.toContain('folded into the dynamic route');
  });
});

// ─── Who observed what ───────────────────────────────────────────────────────

describe('"observed and never declared" counts only what was observed', () => {
  /*
   * The sentence counted `origin === 'CRAWL_ONLY'`, and that origin is the
   * legacy observed/declared summary: it holds every TRAFFIC-only route (no
   * crawl went near it) and every refusal (the crawl declined to go). Both were
   * reported as "reached by a crawl", which claims a measurement that was never
   * made — and for the refusals it is the exact confusion the exclusion ledger
   * exists to end.
   */
  it('names real traffic as the observer, not a crawl that never ran there', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis([{ route: '/dashboard' }]),
      flowMap: flowMap({ nodes: [node('/dashboard')] }),
      observed: [
        {
          ...declaredItem('ROUTE:/admin/reports', ['TRAFFIC']),
          environmentId: 'env-prod',
          evidence: 'real traffic hit /admin/reports',
        },
      ],
      participation: asked('SOURCE', 'CRAWL', 'TRAFFIC'),
    });

    const sentence = inventory.caveats.find((caveat) =>
      caveat.includes('never found in the source'),
    );
    expect(sentence).toBeDefined();
    expect(sentence).toContain('1 item was observed answering');
    expect(sentence).toContain('seen in real traffic');
    expect(sentence).not.toContain('reached by a crawl');
  });

  it('does not count a refused surface as evidence about our own extractor', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis([{ route: '/dashboard' }]),
      flowMap: flowMap({
        nodes: [node('/dashboard')],
        excluded: [
          {
            url: 'https://fixture.test/logout',
            route: '/logout',
            kind: 'SESSION_ENDING',
            rule: 'session-ending-path',
            discoveredFrom: null,
          },
          {
            url: 'https://fixture.test/internal/debug',
            route: '/internal/debug',
            kind: 'POLICY_EXCLUDE',
            rule: 'excludeGlobs:/internal/**',
            discoveredFrom: null,
          },
        ],
      }),
      participation: asked('SOURCE', 'CRAWL'),
    });

    // Both refusals are IN the inventory and named with their reasons...
    expect(routeKeys(inventory.items)).toEqual([
      'ROUTE:/dashboard',
      'ROUTE:/internal/debug',
      'ROUTE:/logout',
    ]);
    expect(inventory.heldOut).toEqual({ unexercisable: 1, refused: 1 });
    // ...and neither is offered as a route a crawl reached and the source missed.
    expect(inventory.caveats.join(' ')).not.toContain('never found in the source');
  });

  it('holds the refused pair out of the division and counts them beside it', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis([{ route: '/dashboard' }]),
      flowMap: flowMap({
        nodes: [node('/dashboard')],
        excluded: [
          {
            url: 'https://fixture.test/logout',
            route: '/logout',
            kind: 'SESSION_ENDING',
            rule: 'session-ending-path',
            discoveredFrom: null,
          },
          {
            url: 'https://fixture.test/internal/debug',
            route: '/internal/debug',
            kind: 'POLICY_EXCLUDE',
            rule: 'excludeGlobs:/internal/**',
            discoveredFrom: null,
          },
        ],
      }),
      participation: asked('SOURCE', 'CRAWL'),
    });

    const totals = totalsForKind(
      'ROUTE',
      inventory.items
        .filter((item) => item.kind === 'ROUTE')
        .map((item) => ({
          item,
          status: 'UNCOVERED' as const,
          matches: [],
          verification: {
            lastRunId: null,
            lastStatus: null,
            executed: false,
            everPassed: false,
            mutationKilled: null,
          },
        })),
    );
    // Three surfaces, one denominator: the two we are not allowed to drive are
    // counted and named rather than dropped, which is what keeps the percentage
    // from rising when the hardest surface in the application is found.
    expect(totals.denominator).toBe(1);
    expect(totals.unexercisable).toBe(1);
    expect(totals.refused).toBe(1);
  });
});
