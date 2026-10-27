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
import type { CodebaseAnalysis, ExclusionKind, FlowMap, SurfaceItem } from '@qaai/shared';
import { originFromSources, totalsForItems } from '@qaai/shared';
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
/*
 * The participation vocabulary's OWNER. `surface-inventory.ts` reaches it as a
 * TYPE-ONLY import (reconcile.ts imports that module at run time, so a value
 * import back would be a cycle), and a type the compiler erases is a half-guard
 * — nothing at run time would notice a member respelled in transit. This file
 * imports both and closes the other half.
 */
import { SOURCE_PARTICIPATIONS } from './reconcile.js';

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
    expect(inventory.reconciliation).toEqual({
      sourceOnly: 4,
      crawlOnly: 0,
      both: 0,
      declarersUnrecorded: 0,
    });
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

// ─── Quarantine: a suppressed result is not coverage ────────────────────────

/**
 * The defect: this matcher counted a quarantined test's PASSED result
 * identically to a live one, while `packages/runner/src/gates.ts` excluded it
 * from every rule and suite health counted it as a liability. Three surfaces of
 * one product giving opposite answers about one test.
 *
 * The rule: the item keeps its MATCH — somebody did write a test, and erasing
 * that would be the opposite error — and stops being COVERED. That is exactly
 * the DECLARED rung of the coverage ladder, which `surfaceStatusForTier` maps
 * onto ASSERTED_NOT_RUN.
 */
describe('analyseSurfaceCoverage — a quarantined test is not coverage', () => {
  const passing = (over: Partial<TestExecutionFact> = {}): TestExecutionFact => ({
    testId: 'tst_1',
    runId: 'run_1',
    status: 'PASSED',
    atIso: '2026-10-20T00:00:00.000Z',
    ...over,
  });

  it('refuses to call an item COVERED on a suppressed pass', () => {
    const live = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [passing()],
    });
    expect(live.entries[0]?.status).toBe('COVERED');

    const suppressed = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [passing({ quarantined: true })],
    });
    expect(suppressed.entries[0]?.status).toBe('ASSERTED_NOT_RUN');
    expect(suppressed.entries[0]?.verification.executed).toBe(false);
  });

  it('keeps the match, so the finding names the test rather than hiding it', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [passing({ quarantined: true })],
    });
    // The item is not covered AND the test is still listed: "your only test for
    // this is suppressed" is the finding, which needs both halves.
    expect(result.entries[0]?.matches).toHaveLength(1);
    expect(result.entries[0]?.matches[0]?.testId).toBe('tst_1');
    expect(result.entries[0]?.verification.lastStatus).toBe('PASSED');
    expect(result.entries[0]?.verification.everPassed).toBe(true);
  });

  it('reports the count, because an item that silently stopped being covered is the same defect as one that silently started', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [passing({ quarantined: true })],
    });
    expect(result.caveats.join(' ')).toContain('matched by a quarantined test');
    expect(result.caveats.join(' ')).toContain('no unquarantined cover');
  });

  it('stays COVERED when a second, live test also matches', () => {
    const result = run({
      items: [ROUTE_ITEM],
      tests: [test_({ id: 'tst_1', routes: ['/orders/1'] }), test_({ id: 'tst_2', routes: ['/orders/2'] })],
      executions: [passing({ quarantined: true }), passing({ testId: 'tst_2' })],
    });
    expect(result.entries[0]?.status).toBe('COVERED');
    // Still disclosed: one of the two covers gates nothing.
    expect(result.caveats.join(' ')).toContain('also matched by a test that is not');
  });

  it('changes the fingerprint, so a quarantine is a change in the answer', () => {
    const before = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [passing()],
    });
    const after = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [passing({ quarantined: true })],
    });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('behaves exactly as before for an execution that does not mention quarantine', () => {
    const absent = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [passing()],
    });
    const explicit = run({
      items: [ROUTE_ITEM],
      tests: [test_({ routes: ['/orders/1'] })],
      executions: [passing({ quarantined: false })],
    });
    expect(absent.fingerprint).toBe(explicit.fingerprint);
    expect(absent.totals.percent).toBe(explicit.totals.percent);
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

// ─── The eight-declarer union ─────────────────────────────────────────────────

/**
 * ONE RECONCILED SURFACE, WITH PROVENANCE.
 *
 * Three disjoint inventories of one application used to live on three screens
 * and were never unioned, so a customer could read two different coverage
 * numbers and no combined figure. The union is only worth having if it is
 * honest rather than merely bigger, so every test here is one of the four rules
 * in surface-inventory.ts's header:
 *
 *   one surface with N provenances, never N surfaces;
 *   one declarer is still a declarer, and WHICH one is visible;
 *   a declarer that failed does not silently drop out;
 *   unexercisable and refused surfaces stay in, with their reason.
 */


/** A declarer-supplied item, the way a sitemap/OpenAPI/traffic reader hands one over. */
function declared(
  key: string,
  sources: SurfaceItem['sources'],
  extra: Partial<SurfaceItem> = {},
): SurfaceItem {
  return {
    kind: 'ROUTE',
    key,
    label: key.slice('ROUTE:'.length),
    file: null,
    line: null,
    sources,
    origin: originFromSources(sources ?? []) ?? 'SOURCE_ONLY',
    evidence: `declared by ${(sources ?? []).join('+') || 'nobody'}`,
    detector: null,
    ...extra,
  };
}

const excluded = (
  over: Partial<{ url: string; route: string | null; kind: ExclusionKind; rule: string }> = {},
) => ({
  url: over.url ?? 'https://app.example.com/logout',
  route: over.route === undefined ? '/logout' : over.route,
  kind: over.kind ?? ('SESSION_ENDING' as ExclusionKind),
  rule: over.rule ?? 'session-ending:logout',
  discoveredFrom: null,
});

const sourceRoute = (route: string): CodebaseAnalysis['routes'][number] => ({
  route,
  detector: 'next-app-router',
  file: `app${route}/page.tsx`,
  evidence: 'directory path is the URL',
  dynamic: route.includes('['),
});

describe('the union carries provenance', () => {
  it('makes the same route found by three declarers ONE item with three provenances', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: flowMap({ nodes: [node('/orders')] }),
      observed: [declared('ROUTE:/orders', ['SITEMAP'])],
    });

    const orders = inventory.items.filter((item) => item.key === 'ROUTE:/orders');
    expect(orders).toHaveLength(1);
    expect([...(orders[0]!.sources ?? [])].sort()).toEqual(['CRAWL', 'SITEMAP', 'SOURCE']);
    // Derived from the union, never written beside it.
    expect(orders[0]!.origin).toBe('BOTH');
    // The source side still owns the actionable fields.
    expect(orders[0]!.file).toBe('app/orders/page.tsx');
  });

  it('keeps an item only one declarer named, and says which one', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
      observed: [declared('ROUTE:/hidden-admin', ['OPENAPI'])],
    });

    const hidden = inventory.items.find((item) => item.key === 'ROUTE:/hidden-admin')!;
    expect(hidden).toBeDefined();
    expect(hidden.sources).toEqual(['OPENAPI']);

    const openapi = inventory.participation.find((entry) => entry.source === 'OPENAPI')!;
    expect(openapi.itemsDeclared).toBe(1);
    // The confidence signal: a route only an OpenAPI document mentions is a
    // weaker claim than one three declarers agree on.
    expect(openapi.soleDeclarerOf).toBe(1);
    expect(inventory.caveats.join(' ')).toMatch(/Items with a single declarer/);
  });

  it('counts a declarer that agrees with others apart from one that stands alone', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/a'), sourceRoute('/b')] }),
      flowMap: null,
      observed: [declared('ROUTE:/a', ['TRAFFIC']), declared('ROUTE:/c', ['TRAFFIC'])],
    });

    const traffic = inventory.participation.find((entry) => entry.source === 'TRAFFIC')!;
    expect(traffic.itemsDeclared).toBe(2);
    expect(traffic.soleDeclarerOf).toBe(1);
    const source = inventory.participation.find((entry) => entry.source === 'SOURCE')!;
    expect(source.itemsDeclared).toBe(2);
    expect(source.soleDeclarerOf).toBe(1);
  });

  it('absorbs a traffic-observed instance into the template the repo declares', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders/[id]')] }),
      flowMap: null,
      observed: [declared('ROUTE:/orders/417', ['TRAFFIC'])],
    });

    // One item, not two. Keyed literally these are two, one of which does not
    // exist as a distinct testable thing — and on a paginated app it is hundreds.
    const routes = inventory.items.filter((item) => item.kind === 'ROUTE');
    expect(routes.map((item) => item.key)).toEqual(['ROUTE:/orders/:param']);
    expect([...(routes[0]!.sources ?? [])].sort()).toEqual(['SOURCE', 'TRAFFIC']);
  });

  it('does not let a thinner declarer blank out a file the source read', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
      observed: [declared('ROUTE:/orders', ['MANUAL'], { file: null, detector: null })],
    });

    const orders = inventory.items.find((item) => item.key === 'ROUTE:/orders')!;
    expect(orders.file).toBe('app/orders/page.tsx');
    expect(orders.detector).toBe('next-app-router');
  });

  it('counts an item with no declarer list apart, rather than claiming agreement', () => {
    const legacy: SurfaceItem = {
      kind: 'ROUTE',
      key: 'ROUTE:/legacy',
      label: '/legacy',
      file: null,
      line: null,
      origin: 'SOURCE_ONLY',
      evidence: 'a row stored before provenance existed',
      detector: null,
    };
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: null,
      observed: [legacy],
    });

    expect(inventory.reconciliation.declarersUnrecorded).toBe(1);
    expect(inventory.caveats.join(' ')).toMatch(/record no declarer list/);
  });
});

describe('the union records which declarers participated', () => {
  it('pairs every participation value with reconcile’s own vocabulary', () => {
    // The run-time half of the guard: `SourceParticipation` reaches this module
    // as a type-only import, which the compiler checks and nothing at run time
    // can. A member respelled in transit would not fail to compile.
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: null,
      participation: [{ source: 'SOURCE', participation: 'FAILED', detail: 'clone timed out' }],
    });
    for (const entry of inventory.participation) {
      expect(SOURCE_PARTICIPATIONS).toContain(entry.participation);
    }
  });

  it('marks the union PARTIAL when a declarer was asked and failed', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({ nodes: [node('/orders')] }),
      participation: [
        { source: 'CRAWL', participation: 'LOADED', detail: '1 route reached' },
        { source: 'SITEMAP', participation: 'FAILED', detail: 'sitemap.xml returned 404' },
      ],
    });

    expect(inventory.complete).toBe(false);
    expect(inventory.partialBecause.join(' ')).toMatch(/SITEMAP was asked and could not be read/);
    // The direction matters and must be stated: a failed declarer shrinks the
    // denominator, so the percentage goes UP.
    expect(inventory.partialBecause.join(' ')).toMatch(/raises any percentage/);
    expect(inventory.caveats.join(' ')).toMatch(/sitemap.xml returned 404/);
  });

  it('does not read a FAILED declarer as one that declared nothing', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: null,
      participation: [{ source: 'OPENAPI', participation: 'FAILED', detail: 'unparseable' }],
    });

    const openapi = inventory.participation.find((entry) => entry.source === 'OPENAPI')!;
    expect(openapi.counted).toBe(false);
    // Null, not 0. "It declared nothing" and "it was never read" differ by the
    // whole size of the document.
    expect(openapi.itemsDeclared).toBeNull();
    expect(openapi.soleDeclarerOf).toBeNull();
  });

  it('is COMPLETE only when every declarer that was asked loaded', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
      participation: [{ source: 'SOURCE', participation: 'LOADED', detail: '1 route' }],
    });

    expect(inventory.complete).toBe(true);
    expect(inventory.partialBecause).toEqual([]);
  });

  it('says NULL, not true, when the caller did not account for the declarers', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
    });

    // The flattering lie: `true` here reads as "every source was read" about a
    // union that never asked the question.
    expect(inventory.complete).toBeNull();
    expect(inventory.partialBecause.join(' ')).toMatch(/whether it is complete is unknown/);
  });

  it('describes a derived NOT_CONFIGURED as our bookkeeping, not their application', () => {
    const inventory = buildSurfaceInventory({ analysis: null, flowMap: null });
    const sitemap = inventory.participation.find((entry) => entry.source === 'SITEMAP')!;

    expect(sitemap.participation).toBe('NOT_CONFIGURED');
    expect(sitemap.detail).toMatch(/statement about our bookkeeping/);
  });
});

describe('refused and unexercisable surfaces stay in the inventory', () => {
  it('mints an item for a logout the crawl refused to follow', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({ nodes: [node('/orders')], excluded: [excluded()] }),
    });

    const logout = inventory.items.find((item) => item.key === 'ROUTE:/logout')!;
    expect(logout).toBeDefined();
    expect(logout.exercise?.state).toBe('UNEXERCISABLE');
    expect(logout.exercise?.reason).toBe('SESSION_ENDING');
    expect(logout.exercise?.rule).toBe('session-ending:logout');
    // The crawl is the declarer: it found the link and decided not to follow.
    expect(logout.sources).toEqual(['CRAWL']);
    // The remedy is what makes this actionable rather than a complaint.
    expect(logout.meta?.remedy).toMatch(/auth profile/i);
    expect(inventory.heldOut.unexercisable).toBe(1);
  });

  it('keeps it in the inventory and out of the coverage division, counted', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({
        nodes: [node('/orders')],
        excluded: [excluded(), excluded({ url: 'https://app.example.com/x', route: '/internal', kind: 'POLICY_EXCLUDE', rule: 'excludeGlobs:/internal/**' })],
      }),
    });
    const totals = totalsForItems(
      inventory.items.map((item) => ({
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

    // Three items in the inventory; one in the division. The other two are
    // named with a reason, which is the whole point — dropping them would raise
    // the percentage by removing the riskiest things in the app.
    expect(inventory.items).toHaveLength(3);
    const routes = totals.byKind.find((kind) => kind.kind === 'ROUTE')!;
    expect(routes.denominator).toBe(1);
    expect(routes.unexercisable).toBe(1);
    expect(routes.refused).toBe(1);
  });

  it('folds fifty links to one logout into one refused surface', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({
        nodes: [node('/orders')],
        excluded: Array.from({ length: 50 }, (_unused, index) =>
          excluded({ url: `https://app.example.com/logout?from=${index}` }),
        ),
      }),
    });

    expect(inventory.items.filter((item) => item.key === 'ROUTE:/logout')).toHaveLength(1);
    expect(inventory.heldOut.unexercisable).toBe(1);
  });

  it('does not count an off-origin refusal as this application’s surface', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({
        nodes: [node('/orders')],
        excluded: [
          excluded({
            url: 'https://accounts.example.net/signin',
            route: null,
            kind: 'OFF_ORIGIN',
            rule: 'off-origin:accounts.example.net',
          }),
        ],
      }),
    });

    expect(inventory.items).toHaveLength(1);
    expect(inventory.heldOut).toEqual({ unexercisable: 0, refused: 0 });
    expect(inventory.caveats.join(' ')).toMatch(/off-origin or not a page/);
  });

  it('says a missing refusal ledger is unknown rather than none', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({ nodes: [node('/orders')] }),
    });

    expect(inventory.heldOut).toEqual({ unexercisable: 0, refused: 0 });
    expect(inventory.caveats.join(' ')).toMatch(/unknown — not "none"/);
  });

  it('prefers a reached observation over a refusal of the same surface', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({
        nodes: [node('/logout')],
        excluded: [excluded()],
      }),
    });

    const logout = inventory.items.find((item) => item.key === 'ROUTE:/logout')!;
    // Something actually drove it, which beats any prediction that it could
    // not be driven — but the refusal's sentence is still on the row.
    expect(logout.exercise?.state).toBe('EXERCISABLE');
    expect(logout.evidence).toMatch(/would end the session/);
  });

  it('carries the environment onto every observed item', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: flowMap({ nodes: [node('/orders')], excluded: [excluded()] }),
    });

    for (const item of inventory.items) {
      expect(item.environmentId).toBe('env_1');
    }
  });
});

describe('the inventory runs the reverse direction', () => {
  it('names a route the suite references and no declarer enumerated', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
      tests: [test_({ id: 'ghost', routes: ['/admin/reports'] })],
    });

    expect(inventory.reverse.measured).toBe(true);
    expect(inventory.reverse.declaredSetUnderstatedByAtLeast).toBe(1);
    expect(inventory.reverse.unenumerated[0]!.route).toBe('/admin/reports');
    expect(inventory.caveats.join(' ')).toMatch(/upper bound/);
  });

  it('counts a target absorbed by the union as agreement', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders/[id]')] }),
      flowMap: null,
      tests: [test_({ id: 'ok', routes: ['/orders/417'] })],
    });

    expect(inventory.reverse.declaredSetUnderstatedByAtLeast).toBe(0);
  });

  it('claims nothing when the union is empty', () => {
    const inventory = buildSurfaceInventory({
      analysis: null,
      flowMap: null,
      tests: [test_({ id: 'a', routes: ['/x'] })],
    });

    // No declarer produced anything, so every test target is "un-enumerated" —
    // which would be a finding about the customer made out of our own silence.
    expect(inventory.reverse.measured).toBe(false);
    expect(inventory.reverse.declaredSetUnderstatedByAtLeast).toBeNull();
  });

  it('does not read an absent suite as agreement', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
    });

    expect(inventory.reverse.declaredSetUnderstatedByAtLeast).toBe(0);
    expect(inventory.caveats.join(' ')).toMatch(/there was no suite to compare/);
  });
});

describe('the fingerprint moves when the measurement moves', () => {
  const base = () =>
    buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
    });

  it('is stable across identical inputs', () => {
    expect(base().fingerprint).toBe(base().fingerprint);
  });

  it('moves when a second declarer joins an item', () => {
    const withTraffic = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
      observed: [declared('ROUTE:/orders', ['TRAFFIC'])],
    });

    // Same one item, same key — but "declared in source" and "declared in
    // source and walked by real traffic" are different measurements, and a
    // fingerprint that held still would keep every cached snapshot valid
    // through exactly the change this slice added.
    expect(withTraffic.items).toHaveLength(1);
    expect(withTraffic.fingerprint).not.toBe(base().fingerprint);
  });

  it('moves when a second DECLARED declarer joins, which leaves `origin` unchanged', () => {
    /*
     * The case the origin field cannot carry, and the reason `sources` is
     * hashed separately.
     *
     * SOURCE and SITEMAP are both DECLARATIONS, so `originFromSources` returns
     * SOURCE_ONLY for either and for both. A fingerprint over `origin` alone
     * therefore holds still while the evidence behind the item doubles — and
     * rule 2 of this union is that a route one declarer names is a weaker claim
     * than one two agree on. Hashing only `origin` would keep every cached
     * snapshot valid through exactly that change.
     */
    const alsoSitemap = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
      observed: [declared('ROUTE:/orders', ['SITEMAP'])],
    });

    expect(alsoSitemap.items).toHaveLength(1);
    expect(alsoSitemap.items[0]!.origin).toBe('SOURCE_ONLY');
    expect(base().items[0]!.origin).toBe('SOURCE_ONLY');
    expect(alsoSitemap.fingerprint).not.toBe(base().fingerprint);
  });

  it('moves when an exercisability is recorded, which `origin` also cannot carry', () => {
    const observedItem = declared('ROUTE:/orders', ['SOURCE'], {
      exercise: { state: 'UNEXERCISABLE', reason: 'DESTRUCTIVE', detail: 'deletes the order' },
    });
    const classified = buildSurfaceInventory({
      analysis: null,
      flowMap: null,
      observed: [observedItem],
    });
    const unclassified = buildSurfaceInventory({
      analysis: null,
      flowMap: null,
      observed: [declared('ROUTE:/orders', ['SOURCE'])],
    });

    // Same key, same single declarer, same origin — one is in the division and
    // one is not, which is the largest possible change to the number.
    expect(classified.items[0]!.origin).toBe(unclassified.items[0]!.origin);
    expect(classified.fingerprint).not.toBe(unclassified.fingerprint);
  });

  it('moves when an item leaves the division', () => {
    const refused = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: flowMap({
        nodes: [],
        excluded: [excluded({ url: 'https://app.example.com/orders', route: '/orders', kind: 'DESTRUCTIVE', rule: 'destructive:delete' })],
      }),
    });

    expect(refused.items).toHaveLength(1);
    expect(refused.items[0]!.exercise?.state).toBe('UNEXERCISABLE');
    expect(refused.fingerprint).not.toBe(base().fingerprint);
  });
});

describe('the source read’s own shortfalls reach the number', () => {
  it('says how many facts the readers could not report, and why', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        routes: [sourceRoute('/orders')],
        shortfalls: [
          { detector: 'next-app-router', reason: 'NO_CONTENT', count: 12, detail: '12 files were listed without bodies' },
          { detector: null, reason: 'CAP_REACHED', count: 230, detail: 'the file cap bit' },
        ],
      }),
      flowMap: null,
    });

    // "At least N more existed", not "possibly incomplete". A surface our own
    // reader skipped is ABSENT from the denominator rather than uncovered, and
    // absent raises the percentage while uncovered lowers it.
    expect(inventory.caveats.join(' ')).toMatch(/could not report at least 242 facts/);
    expect(inventory.caveats.join(' ')).toMatch(/12× the file body was not uploaded \(next-app-router\)/);
    expect(inventory.caveats.join(' ')).toMatch(/230× one of this analysis’s own caps was reached \(every detector\)/);
  });

  it('says UNKNOWN, not zero, for an analysis with no shortfall ledger', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')] }),
      flowMap: null,
    });

    expect(inventory.caveats.join(' ')).toMatch(/predates the shortfall ledger/);
    expect(inventory.caveats.join(' ')).toMatch(/unknown — not zero/);
  });

  it('reports no shortfall sentence when the readers ran and lost nothing', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({ routes: [sourceRoute('/orders')], shortfalls: [] }),
      flowMap: null,
    });

    expect(inventory.caveats.join(' ')).not.toMatch(/could not report at least/);
    expect(inventory.caveats.join(' ')).not.toMatch(/predates the shortfall ledger/);
  });

  it('names a guard that protects an area no route detector found', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        routes: [sourceRoute('/orders')],
        guards: [
          {
            kind: 'NEXT_MIDDLEWARE',
            file: 'middleware.ts',
            line: 4,
            patterns: ['/admin/:path*'],
            roles: ['ADMIN'],
            evidence: 'middleware matcher covers /admin/:path*',
          },
        ],
      }),
      flowMap: null,
    });

    // Evidence about OUR extractor: either the configuration is dead, or a
    // whole admin area went unread. Suppressing it hides our own error rate.
    expect(inventory.caveats.join(' ')).toMatch(/1 guard declaration names URL patterns that match no route/);
    expect(inventory.caveats.join(' ')).toMatch(/middleware.ts: \/admin\/:path\*/);
  });

  it('says nothing about a guard whose pattern does match a route', () => {
    const inventory = buildSurfaceInventory({
      analysis: analysis({
        routes: [sourceRoute('/admin/users')],
        guards: [
          {
            kind: 'NEXT_MIDDLEWARE',
            file: 'middleware.ts',
            line: 4,
            patterns: ['/admin/*'],
            roles: ['ADMIN'],
            evidence: 'middleware matcher covers /admin/*',
          },
        ],
      }),
      flowMap: null,
    });

    expect(inventory.caveats.join(' ')).not.toMatch(/match no route/);
  });
});
