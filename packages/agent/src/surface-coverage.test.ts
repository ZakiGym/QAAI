/**
 * Tests for the denominator and the division.
 *
 * These two modules produce the number the whole product is sold on, so the
 * suite is built around the ways a coverage number lies rather than around
 * line coverage of the functions:
 *
 *   - counting something as covered because a string appeared in a file
 *   - counting something as uncovered when we simply could not see the test
 *   - letting an axis we do not measure enter the denominator as zeroes
 *   - printing 0% or 100% when the real answer is "we found nothing"
 *   - letting a waiver quietly shrink the denominator with nobody's name on it
 *   - an unstable identity, which would make every run look like a change and
 *     destroy the trend the gate depends on
 *
 * Each of those is a test below. The happy paths are here too, but they are not
 * what this file is for.
 */

import { describe, expect, it } from 'vitest';
import type { CodebaseAnalysis, FlowMap, SurfaceItem } from '@qaai/shared';
import { totalsForItems } from '@qaai/shared';
import {
  buildSurfaceInventory,
  endpointIdentity,
  fingerprintInventory,
} from './surface-inventory.js';
import {
  analyseSurfaceCoverage,
  rankUncovered,
  type SurfaceCoverageInput,
  type TestExecutionFact,
} from './surface-coverage.js';
import type { CoverageTestInput } from './coverage.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function analysis(overrides: Partial<CodebaseAnalysis> = {}): CodebaseAnalysis {
  return {
    routes: [],
    endpoints: [],
    forms: [],
    authSurfaces: [],
    frameworks: [],
    detectors: [],
    coverage: {
      filesGiven: 10,
      filesAnalysed: 10,
      filesWithContent: 10,
      filesIgnored: 0,
      filesTruncated: 0,
      truncated: false,
    },
    notes: [],
    warnings: [],
    ...overrides,
  };
}

function flowMap(overrides: Partial<FlowMap> = {}): FlowMap {
  return {
    projectId: 'prj_1',
    environmentId: 'env_1',
    version: 3,
    baseUrl: 'https://app.example.com',
    nodes: [],
    edges: [],
    journeys: [],
    features: [],
    exploredAt: '2026-10-23T00:00:00.000Z',
    truncatedReason: null,
    ...overrides,
  };
}

function node(route: string, extra: Partial<FlowMap['nodes'][number]> = {}) {
  return {
    id: `n_${route}`,
    route,
    url: `https://app.example.com${route}`,
    title: route,
    stateKey: route,
    requiresRoles: [],
    behindAuth: false,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
    ...extra,
  };
}

function test_(overrides: Partial<CoverageTestInput> = {}): CoverageTestInput {
  return {
    id: 'tst_1',
    name: 'a test',
    filePath: 'tests/a.spec.ts',
    feature: null,
    priority: 'IMPORTANT',
    testType: 'E2E',
    tags: [],
    routes: [],
    code: null,
    ...overrides,
  };
}

function run(input: Partial<SurfaceCoverageInput> & { items: readonly SurfaceItem[] }) {
  return analyseSurfaceCoverage({ tests: [], ...input });
}

// ─── The inventory ───────────────────────────────────────────────────────────

describe('buildSurfaceInventory', () => {
  it('reads routes, endpoints, forms and auth surfaces from source', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        routes: [
          {
            route: '/orders/[id]',
            detector: 'next-app-router',
            file: 'app/orders/[id]/page.tsx',
            evidence: 'directory path is the URL',
            dynamic: true,
          },
        ],
        endpoints: [
          {
            method: 'POST',
            path: '/api/refunds',
            detector: 'next-app-router',
            file: 'app/api/refunds/route.ts',
            evidence: 'exported POST handler',
            dynamic: false,
          },
        ],
        forms: [
          {
            id: 'app/login/page.tsx#0',
            name: 'login',
            action: '/api/session',
            method: 'POST',
            file: 'app/login/page.tsx',
            submitLabel: 'Sign in',
            fields: [
              {
                name: 'email',
                label: 'Email',
                inputType: 'email',
                required: true,
                semantic: 'email',
              },
            ],
          },
        ],
        authSurfaces: [
          {
            kind: 'LOGIN',
            path: '/login',
            from: 'form',
            file: 'app/login/page.tsx',
            evidence: 'a form with a password field',
          },
        ],
      }),
      flowMap: null,
    });

    expect(inventory.items.map((item) => item.key).sort()).toEqual([
      'AUTH_SURFACE:LOGIN@/login',
      'ENDPOINT:POST /api/refunds',
      'FORM:app/login/page.tsx#0',
      'ROUTE:/orders/:param',
    ]);
    // The dynamic segment is canonicalised, so a crawl's /orders/123 will match.
    expect(inventory.items.find((item) => item.kind === 'ROUTE')?.label).toBe('/orders/:param');
    expect(inventory.reconciliation).toEqual({ sourceOnly: 4, crawlOnly: 0, both: 0 });
  });

  it('marks a source item the crawl also reached as BOTH, keeping the source file', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        routes: [
          {
            route: '/orders/[id]',
            detector: 'next-app-router',
            file: 'app/orders/[id]/page.tsx',
            evidence: 'directory path is the URL',
            dynamic: true,
          },
        ],
      }),
      flowMap: flowMap({ nodes: [node('/orders/123')] }),
    });

    const route = inventory.items.find((item) => item.kind === 'ROUTE');
    expect(route?.origin).toBe('BOTH');
    // The file is what makes the item actionable, so the source side must win.
    expect(route?.file).toBe('app/orders/[id]/page.tsx');
    expect(route?.evidence).toContain('directory path is the URL');
    expect(route?.evidence).toContain('the crawl reached');
  });

  /**
   * The finding this product is built on: the code declares it, nothing has
   * ever reached it. Every runtime-only competitor is blind to this row.
   */
  it('reports a declared route no crawl reached as SOURCE_ONLY', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        routes: [
          {
            route: '/admin/billing',
            detector: 'next-app-router',
            file: 'app/admin/billing/page.tsx',
            evidence: 'directory path is the URL',
            dynamic: false,
          },
        ],
      }),
      flowMap: flowMap({ nodes: [node('/')] }),
    });

    const admin = inventory.items.find((item) => item.key === 'ROUTE:/admin/billing');
    expect(admin?.origin).toBe('SOURCE_ONLY');
    expect(inventory.reconciliation.sourceOnly).toBe(1);
  });

  it('reports a crawled route the source never declared as CRAWL_ONLY, and says it is our error', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis(),
      flowMap: flowMap({ nodes: [node('/surprise')] }),
    });

    expect(inventory.items.find((item) => item.key === 'ROUTE:/surprise')?.origin).toBe(
      'CRAWL_ONLY',
    );
    expect(inventory.caveats.join(' ')).toContain("gap in QAAI's own extraction");
  });

  it('treats two detectors finding one route as agreement, not a duplicate', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        routes: [
          {
            route: '/pricing',
            detector: 'next-app-router',
            file: 'app/pricing/page.tsx',
            evidence: 'directory path is the URL',
            dynamic: false,
          },
          {
            route: '/pricing',
            detector: 'react-router',
            file: 'src/App.tsx',
            evidence: 'a <Route path="/pricing"> element',
            dynamic: false,
          },
        ],
      }),
      flowMap: null,
    });

    const routes = inventory.items.filter((item) => item.kind === 'ROUTE');
    expect(routes).toHaveLength(1);
    expect(routes[0]?.evidence).toContain('also');
  });

  /**
   * The phantom-denominator bug.
   *
   * The crawl reports concrete URLs; the source declares templates. Keyed
   * literally, `/orders/1`, `/orders/2` and `/orders/3` are three items beside
   * the one real `/orders/:param` — and on a paginated or faceted app that is
   * hundreds of denominator entries for things that are not distinct testable
   * surfaces. A percentage computed against that is meaningless, and worse, it
   * drifts every time the crawl happens to visit a different id.
   */
  it('folds concrete crawled URLs into the dynamic route they belong to', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        routes: [
          {
            route: '/orders/[id]',
            detector: 'next-app-router',
            file: 'app/orders/[id]/page.tsx',
            evidence: 'directory path is the URL',
            dynamic: true,
          },
        ],
      }),
      flowMap: flowMap({
        nodes: [node('/orders/1'), node('/orders/2'), node('/orders/3')],
      }),
    });

    const routes = inventory.items.filter((item) => item.kind === 'ROUTE');
    expect(routes).toHaveLength(1);
    expect(routes[0]?.key).toBe('ROUTE:/orders/:param');
    expect(routes[0]?.origin).toBe('BOTH');
    expect(inventory.caveats.join(' ')).toContain('folded into the dynamic route');
  });

  it('does not let a template absorb a static route that exists in its own right', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        routes: [
          {
            route: '/orders/[id]',
            detector: 'next-app-router',
            file: 'app/orders/[id]/page.tsx',
            evidence: 'dynamic',
            dynamic: true,
          },
          {
            route: '/orders/new',
            detector: 'next-app-router',
            file: 'app/orders/new/page.tsx',
            evidence: 'static',
            dynamic: false,
          },
        ],
      }),
      flowMap: flowMap({ nodes: [node('/orders/new')] }),
    });

    const routes = inventory.items.filter((item) => item.kind === 'ROUTE');
    expect(routes.map((route) => route.key).sort()).toEqual([
      'ROUTE:/orders/:param',
      'ROUTE:/orders/new',
    ]);
    // The exact key must win, so /orders/new is the thing the crawl reached.
    expect(routes.find((route) => route.key === 'ROUTE:/orders/new')?.origin).toBe('BOTH');
    expect(routes.find((route) => route.key === 'ROUTE:/orders/:param')?.origin).toBe(
      'SOURCE_ONLY',
    );
  });

  /**
   * Forms cannot be reconciled between a DOM and a file, so with both inputs
   * present the form axis is the source's list only. Minting both would
   * double-count every form in the application.
   */
  it('does not double-count a form found both in source and by the crawl', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        forms: [
          {
            id: 'app/login/page.tsx#0',
            name: 'login',
            action: '/api/session',
            method: 'POST',
            file: 'app/login/page.tsx',
            submitLabel: 'Sign in',
            fields: [
              {
                name: 'email',
                label: 'Email',
                inputType: 'email',
                required: true,
                semantic: 'email',
              },
            ],
          },
        ],
      }),
      flowMap: flowMap({
        nodes: [
          node('/login', {
            forms: [
              {
                id: 'dom-form-0',
                name: 'login',
                selector: { strategy: 'CSS', value: 'form', confidence: 1 },
                fields: [],
                submit: null,
              },
            ],
          }),
        ],
      }),
    });

    expect(inventory.items.filter((item) => item.kind === 'FORM')).toHaveLength(1);
    expect(inventory.caveats.join(' ')).toContain('counted from the source instead');
  });

  it('does use crawled forms when the crawl is the only inventory there is', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({
        nodes: [
          node('/login', {
            forms: [
              {
                id: 'dom-form-0',
                name: 'login',
                selector: { strategy: 'CSS', value: 'form', confidence: 1 },
                fields: [],
                submit: null,
              },
            ],
          }),
        ],
      }),
    });
    expect(inventory.items.filter((item) => item.kind === 'FORM')).toHaveLength(1);
  });

  it('says so when there is no source analysis at all', () => {
    const inventory = buildSurfaceInventory({ analysis: null, flowMap: flowMap() });
    expect(inventory.caveats.join(' ')).toContain('only what a crawl reached');
  });

  it('says so when the crawl stopped early, because the gap list is then a lower bound', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis(),
      flowMap: flowMap({ truncatedReason: 'page budget of 60 reached' }),
    });
    expect(inventory.caveats.join(' ')).toContain('page budget of 60');
    expect(inventory.caveats.join(' ')).toContain('lower bound');
  });

  it('names a blocked detector rather than reporting a complete denominator', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        detectors: [
          {
            id: 'next-app-router',
            label: 'Next.js app router',
            looksFor: 'app/**/page.tsx',
            filesExamined: 12,
            found: 0,
            blocked: 'file bodies were never uploaded',
          },
        ],
      }),
      flowMap: null,
    });
    expect(inventory.caveats.join(' ')).toContain('file bodies were never uploaded');
  });

  it('does not claim a verb it could not read', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        endpoints: [
          {
            method: 'UNKNOWN',
            path: '/api/thing',
            detector: 'next-app-router',
            file: 'app/api/thing/route.ts',
            evidence: 'a route.ts with no readable exports',
            dynamic: false,
          },
        ],
      }),
      flowMap: null,
    });
    const endpoint = inventory.items[0];
    expect(endpoint?.key).toBe('ENDPOINT:UNKNOWN /api/thing');
    expect(endpoint?.meta?.verbUnreadable).toBe(true);
    expect(inventory.caveats.join(' ')).toContain('unreadable HTTP verbs');
  });

  /**
   * Identity stability. If reformatting a file changed an item's key, every
   * snapshot would differ from the one before it and the trend a gate depends
   * on would be noise.
   */
  it('keys an item independently of line numbers and declaration spelling', () => {
    const one = buildSurfaceInventory({
      analysis: analysis({
        routes: [
          {
            route: '/orders/[id]',
            detector: 'next-app-router',
            file: 'a.tsx',
            evidence: 'x',
            dynamic: true,
          },
        ],
      }),
      flowMap: null,
    });
    const two = buildSurfaceInventory({
      analysis: analysis({
        routes: [
          {
            route: '/orders/:id',
            detector: 'react-router',
            file: 'b.tsx',
            evidence: 'a totally different sentence',
            dynamic: true,
          },
        ],
      }),
      flowMap: null,
    });
    expect(one.items[0]?.key).toBe(two.items[0]?.key);
    expect(one.fingerprint).toBe(two.fingerprint);
  });

  it('changes the fingerprint when an item appears or its origin changes', () => {
    const base: SurfaceItem[] = [
      {
        kind: 'ROUTE',
        key: 'ROUTE:/a',
        label: '/a',
        file: null,
        line: null,
        origin: 'SOURCE_ONLY',
        evidence: 'x',
        detector: null,
      },
    ];
    const originChanged: SurfaceItem[] = [{ ...base[0]!, origin: 'BOTH' }];
    const added: SurfaceItem[] = [...base, { ...base[0]!, key: 'ROUTE:/b', label: '/b' }];

    expect(fingerprintInventory(base)).not.toBe(fingerprintInventory(originChanged));
    expect(fingerprintInventory(base)).not.toBe(fingerprintInventory(added));
  });

  it('does not move the fingerprint for a change in evidence prose alone', () => {
    const base: SurfaceItem[] = [
      {
        kind: 'ROUTE',
        key: 'ROUTE:/a',
        label: '/a',
        file: null,
        line: null,
        origin: 'SOURCE_ONLY',
        evidence: 'reached via one URL',
        detector: null,
      },
    ];
    const reworded: SurfaceItem[] = [{ ...base[0]!, evidence: 'reached via another URL' }];
    expect(fingerprintInventory(base)).toBe(fingerprintInventory(reworded));
  });
});

describe('endpointIdentity', () => {
  it('upper-cases the method and canonicalises the path', () => {
    expect(endpointIdentity('post', '/api/orders/[id]')).toBe('POST /api/orders/:param');
  });
});

// ─── The division ────────────────────────────────────────────────────────────

const ROUTE_ITEM: SurfaceItem = {
  kind: 'ROUTE',
  key: 'ROUTE:/orders/:param',
  label: '/orders/:param',
  file: 'app/orders/[id]/page.tsx',
  line: null,
  origin: 'SOURCE_ONLY',
  evidence: 'directory path is the URL',
  detector: 'next-app-router',
};

describe('analyseSurfaceCoverage — routes', () => {
  it('matches a literal route and reports the basis', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/:param'] })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
    expect(result.entries[0]?.matches[0]?.basis).toBe('LITERAL');
  });

  it('matches a concrete URL against a dynamic route', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/123'] })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
    expect(result.entries[0]?.matches[0]?.basis).toBe('NORMALISED');
  });

  /** Rule 3, and the one that costs us headline points on purpose. */
  it('does not call an item covered when its test has never run', () => {
    const result = run({ items: [ROUTE_ITEM], tests: [test_({ routes: ['/orders/1'] })] });
    expect(result.entries[0]?.status).toBe('ASSERTED_NOT_RUN');
    expect(result.totals.covered).toBe(0);
    expect(result.caveats.join(' ')).toContain('never been run');
  });

  /**
   * A failing test is coverage. It is covered AND failing, and those are two
   * facts, not one.
   *
   * This asserted ASSERTED_NOT_RUN, which was wrong twice over: the item has a
   * test that demonstrably runs, and the label on that status says "a test
   * exists but has never run" — a false sentence about a test the customer has
   * watched fail. Coverage asks whether a test exists and runs; whether it
   * passes is the run report's job.
   */
  it('calls an item covered when its test ran and failed, and keeps the failure visible', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'FAILED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
    expect(result.entries[0]?.verification.lastStatus).toBe('FAILED');
    expect(result.entries[0]?.verification.everPassed).toBe(false);
  });

  it('does not count a SKIPPED result as a run — a skipped test asserted nothing', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'SKIPPED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('ASSERTED_NOT_RUN');
    expect(result.entries[0]?.verification.executed).toBe(false);
  });

  /**
   * The regression test for the worst defect this feature shipped.
   *
   * A PASSED result used to overwrite lastRunId/lastStatus whatever its date,
   * so an item whose newest run FAILED reported "last run: PASSED" from an
   * older one. A wrong fact, in the direction that flatters the vendor, on a
   * surface whose only test is red.
   */
  it('reports the genuinely newest run, never an older happier one', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [
        {
          testId: 'tst_1',
          runId: 'run_new',
          status: 'FAILED',
          atIso: '2026-10-22T00:00:00.000Z',
          everPassed: true,
        },
      ],
    });
    expect(result.entries[0]?.verification.lastRunId).toBe('run_new');
    expect(result.entries[0]?.verification.lastStatus).toBe('FAILED');
    // The pass is still reported — as its own field, not as the last status.
    expect(result.entries[0]?.verification.everPassed).toBe(true);
  });

  it('picks the newest run across several matched tests, not the first one seen', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [
        test_({ id: 'tst_old', routes: ['/orders/1'] }),
        test_({ id: 'tst_new', routes: ['/orders/2'] }),
      ],
      executions: [
        {
          testId: 'tst_old',
          runId: 'run_old',
          status: 'PASSED',
          atIso: '2026-10-01T00:00:00.000Z',
        },
        {
          testId: 'tst_new',
          runId: 'run_new',
          status: 'FAILED',
          atIso: '2026-10-22T00:00:00.000Z',
        },
      ],
    });
    expect(result.entries[0]?.verification.lastRunId).toBe('run_new');
    expect(result.entries[0]?.verification.lastStatus).toBe('FAILED');
    expect(result.entries[0]?.verification.everPassed).toBe(true);
  });

  /** Rule 2 — the most important rule in the file. */
  it('reports UNKNOWN, not UNCOVERED, when the suite navigates to runtime URLs', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ code: 'await page.goto(url);' })],
    });
    expect(result.entries[0]?.status).toBe('UNKNOWN');
    expect(result.totals.uncovered).toBe(0);
    expect(result.caveats.join(' ')).toContain('cannot tell');
  });

  it('keeps UNKNOWN out of the numerator but inside the denominator', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ code: 'await page.goto(url);' })],
    });
    // An item we cannot reason about is a hole in OUR knowledge. Moving it out
    // of the denominator would raise the percentage every time we got worse.
    expect(result.totals.denominator).toBe(1);
    expect(result.totals.percent).toBe(0);
  });

  it('does not let a runtime URL make a FORM unknowable', () => {
    const form: SurfaceItem = {
      kind: 'FORM',
      key: 'FORM:app/login/page.tsx#0',
      label: 'login',
      file: 'app/login/page.tsx',
      line: null,
      origin: 'SOURCE_ONLY',
      evidence: 'a form',
      detector: null,
      meta: { fields: [{ name: 'emailAddress', label: 'Email' }] },
    };
    const result = run({ items: [form], tests: [test_({ code: 'await page.goto(url);' })] });
    expect(result.entries[0]?.status).toBe('UNCOVERED');
  });

  it('still reads a plain string goto as readable', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ code: "await page.goto('/orders/1');", routes: ['/orders/1'] })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
  });
});

describe('analyseSurfaceCoverage — endpoints', () => {
  const endpoint: SurfaceItem = {
    kind: 'ENDPOINT',
    key: 'ENDPOINT:POST /api/refunds',
    label: 'POST /api/refunds',
    file: 'app/api/refunds/route.ts',
    line: null,
    origin: 'SOURCE_ONLY',
    evidence: 'exported POST handler',
    detector: 'next-app-router',
    meta: { method: 'POST', path: '/api/refunds' },
  };

  it('requires both the path and the method', () => {
    const pathOnly = run({
      items: [endpoint],
      tests: [test_({ code: "await request.get('/api/refunds');" })],
    });
    expect(pathOnly.entries[0]?.status).toBe('UNCOVERED');

    const both = run({
      items: [endpoint],
      tests: [test_({ code: "await request.post('/api/refunds');" })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(both.entries[0]?.status).toBe('COVERED');
  });

  it('accepts an API-type test as evidence of the verb', () => {
    const result = run({
      items: [endpoint],
      tests: [test_({ testType: 'API', code: 'url: /api/refunds' })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
  });

  /** Our unreadable parse must not become the customer's failing grade. */
  it('matches on path alone when the verb could not be read', () => {
    const unknown: SurfaceItem = {
      ...endpoint,
      key: 'ENDPOINT:UNKNOWN /api/refunds',
      meta: { method: 'UNKNOWN', path: '/api/refunds', verbUnreadable: true },
    };
    const result = run({
      items: [unknown],
      tests: [test_({ code: "await request.get('/api/refunds');" })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
    expect(result.entries[0]?.matches[0]?.basis).toBe('HEURISTIC');
  });
});

describe('analyseSurfaceCoverage — forms', () => {
  const form: SurfaceItem = {
    kind: 'FORM',
    key: 'FORM:app/login/page.tsx#0',
    label: 'login',
    file: 'app/login/page.tsx',
    line: null,
    origin: 'SOURCE_ONLY',
    evidence: 'a form',
    detector: null,
    meta: {
      submitLabel: 'Sign in',
      fields: [
        { name: 'emailAddress', label: 'Email address' },
        { name: 'id', label: null },
      ],
    },
  };

  it('counts a form as exercised when a test mentions one of its fields', () => {
    const result = run({
      items: [form],
      tests: [test_({ code: "await page.fill('#emailAddress', 'a@b.c');" })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
  });

  /**
   * The generous direction taken too far. A field called `id` appears in
   * virtually every spec, so matching on it would mark every form covered.
   */
  it('ignores field names too short to be distinctive', () => {
    const result = run({
      items: [form],
      tests: [test_({ code: "const id = 'x'; await page.goto('/somewhere-else');" })],
    });
    expect(result.entries[0]?.status).toBe('UNCOVERED');
  });

  it('accepts the submit label as weaker evidence', () => {
    const result = run({
      items: [form],
      tests: [test_({ code: "await page.getByRole('button', { name: 'Sign in' }).click();" })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
  });
});

describe('analyseSurfaceCoverage — auth surfaces', () => {
  const login: SurfaceItem = {
    kind: 'AUTH_SURFACE',
    key: 'AUTH_SURFACE:LOGIN@/login',
    label: 'login at /login',
    file: 'app/login/page.tsx',
    line: null,
    origin: 'SOURCE_ONLY',
    evidence: 'a form with a password field',
    detector: 'form',
    meta: { authKind: 'LOGIN', path: '/login' },
  };

  /** Reaching /login is not testing login. */
  it('is not covered by a test that merely visits the page', () => {
    const result = run({
      items: [login],
      tests: [test_({ routes: ['/login'], code: "await page.goto('/login');" })],
    });
    expect(result.entries[0]?.status).toBe('UNCOVERED');
  });

  it('is covered by a test that performs the authentication step', () => {
    const result = run({
      items: [login],
      tests: [
        test_({
          routes: ['/login'],
          code: "await page.fill('#password', 'hunter2'); await signIn();",
        }),
      ],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
  });
});

// ─── Waivers and the denominator ─────────────────────────────────────────────

describe('waivers', () => {
  it('removes a waived item from the denominator and names who waived it', () => {
    const result = run({
      items: [ROUTE_ITEM],
      waivers: {
        'ROUTE:/orders/:param': {
          reason: 'legacy admin page, scheduled for deletion',
          byUserId: 'usr_1',
          byEmail: 'owner@example.com',
          createdAtIso: '2026-10-01T00:00:00.000Z',
          expiresAtIso: '2026-12-01T00:00:00.000Z',
        },
      },
    });

    expect(result.entries[0]?.status).toBe('WAIVED');
    expect(result.entries[0]?.waiver?.byEmail).toBe('owner@example.com');
    expect(result.totals.denominator).toBe(0);
    expect(result.totals.waived).toBe(1);
    // Nothing to divide, so no number — not 0% and not 100%.
    expect(result.totals.percent).toBeNull();
  });
});

describe('the headline arithmetic', () => {
  it('returns null rather than a number when nothing is measured', () => {
    const result = run({ items: [] });
    expect(result.totals.percent).toBeNull();
    expect(result.totals.denominator).toBe(0);
  });

  it('rounds to one decimal place', () => {
    const items: SurfaceItem[] = Array.from({ length: 3 }, (_, index) => ({
      ...ROUTE_ITEM,
      key: `ROUTE:/r${index}`,
      label: `/r${index}`,
    }));
    const result = run({
      items,
      tests: [test_({ routes: ['/r0'] })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.totals.percent).toBe(33.3);
  });

  /**
   * An axis with no extractor must not enter the denominator as a row of
   * zeroes. "0% of your component states are covered" is a lie about the
   * customer's app; "we do not measure component states" is a fact about ours.
   */
  it('excludes unmeasured axes from the denominator', () => {
    const items: SurfaceItem[] = [
      ROUTE_ITEM,
      {
        kind: 'COMPONENT_STATE',
        key: 'COMPONENT_STATE:Button/loading',
        label: 'Button — loading',
        file: null,
        line: null,
        origin: 'SOURCE_ONLY',
        evidence: 'declared',
        detector: null,
      },
    ];
    const totals = totalsForItems(
      items.map((item) => ({
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
    expect(totals.denominator).toBe(1);
    expect(totals.byKind.find((kind) => kind.kind === 'COMPONENT_STATE')?.measured).toBe(false);
  });

  it('reports a per-axis percent of null for an axis with nothing on it', () => {
    const totals = totalsForItems([]);
    expect(totals.byKind.every((kind) => kind.percent === null)).toBe(true);
  });

  it('counts the reconciliation both ways', () => {
    const items: SurfaceItem[] = [
      { ...ROUTE_ITEM, key: 'ROUTE:/a', origin: 'SOURCE_ONLY' },
      { ...ROUTE_ITEM, key: 'ROUTE:/b', origin: 'CRAWL_ONLY' },
      { ...ROUTE_ITEM, key: 'ROUTE:/c', origin: 'BOTH' },
    ];
    const result = run({ items });
    expect(result.totals.declaredNeverReached).toBe(1);
    expect(result.totals.reachedNeverDeclared).toBe(1);
  });

  it('says the numerator is zero by construction when there are no tests', () => {
    const result = run({ items: [ROUTE_ITEM] });
    expect(result.caveats.join(' ')).toContain('no tests');
  });

  /** The claim no competitor publishes, and the reason it is kept separate. */
  it('flags covered items with no mutation result as not known to assert anything', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [
        { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });
    expect(result.entries[0]?.verification.mutationKilled).toBeNull();
    expect(result.caveats.join(' ')).toContain('not known to assert anything meaningful');
  });

  it('records a mutation kill when a run reported one', () => {
    const executions: TestExecutionFact[] = [
      {
        testId: 'tst_1',
        runId: 'run_1',
        status: 'PASSED',
        atIso: '2026-10-20T00:00:00.000Z',
        mutationKilled: true,
      },
    ];
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions,
    });
    expect(result.entries[0]?.verification.mutationKilled).toBe(true);
  });
});

describe('rankUncovered', () => {
  it('puts auth surfaces first and source-only items before crawl-only ones', () => {
    const items: SurfaceItem[] = [
      { ...ROUTE_ITEM, kind: 'FORM', key: 'FORM:f', label: 'f' },
      { ...ROUTE_ITEM, kind: 'ROUTE', key: 'ROUTE:/crawled', origin: 'CRAWL_ONLY' },
      { ...ROUTE_ITEM, kind: 'ROUTE', key: 'ROUTE:/declared', origin: 'SOURCE_ONLY' },
      { ...ROUTE_ITEM, kind: 'AUTH_SURFACE', key: 'AUTH_SURFACE:LOGIN@/login' },
      {
        ...ROUTE_ITEM,
        kind: 'ENDPOINT',
        key: 'ENDPOINT:POST /api/x',
        meta: { method: 'POST', path: '/api/x' },
      },
    ];
    const ranked = rankUncovered(run({ items }).entries);
    expect(ranked.map((entry) => entry.item.key)).toEqual([
      'AUTH_SURFACE:LOGIN@/login',
      'ENDPOINT:POST /api/x',
      'ROUTE:/declared',
      'ROUTE:/crawled',
      'FORM:f',
    ]);
  });
});
