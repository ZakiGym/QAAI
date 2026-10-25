/**
 * Tests for obsolete-test detection and the pre-failure drift check.
 *
 * The dangerous failure of this module is proposing the deletion of a test that
 * was fine. A crawler that stopped at a login wall, a feature flag or a budget
 * produces exactly the same evidence as a deleted page — "the crawl did not
 * reach it" — and acting on that would destroy coverage the customer paid for
 * and would not notice was gone. So most of this file is about REFUSING to
 * propose retirement, and each refusal names the condition that was missing.
 */

import { describe, expect, it } from 'vitest';
import type { FlowMap, FlowNode, Selector } from '@qaai/shared';
import { auditTestsAgainstCrawl, crawlSurfaceOf, driftCheck, locatorIdentity } from './obsolete.js';
import type { SuiteHealthTestInput } from './suite-health.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const role = (value: string, name: string): Selector => ({
  strategy: 'ROLE',
  value,
  name,
  confidence: 0.9,
});

const node = (route: string, affordances: Selector[]): FlowNode => ({
  id: `n-${route}`,
  route,
  url: `https://app.test${route}`,
  title: route,
  stateKey: 'default',
  requiresRoles: [],
  behindAuth: false,
  forms: [],
  affordances: affordances.map((selector) => ({
    label: selector.name ?? selector.value,
    selector,
    kind: 'button' as const,
  })),
  screenshotKey: null,
  a11yViolationCount: 0,
});

const flowMap = (nodes: FlowNode[], truncatedReason: string | null = null): FlowMap => ({
  projectId: 'p1',
  environmentId: 'e1',
  version: 7,
  baseUrl: 'https://app.test',
  nodes,
  edges: [],
  journeys: [],
  features: [],
  exploredAt: '2026-10-24T00:00:00.000Z',
  truncatedReason,
});

const test_ = (over: Partial<SuiteHealthTestInput> = {}): SuiteHealthTestInput => ({
  id: 't1',
  name: 'checkout completes',
  filePath: 'tests/checkout.spec.ts',
  type: 'E2E',
  priority: 'IMPORTANT',
  feature: 'checkout',
  tags: [],
  code: [
    "import { test, expect } from '@playwright/test';",
    "test('checkout completes', async ({ page }) => {",
    "  await page.goto('/checkout');",
    "  await page.getByRole('button', { name: 'Pay' }).click();",
    "  await expect(page.getByTestId('receipt')).toBeVisible();",
    '});',
  ].join('\n'),
  spec: null,
  flakeRate: 0,
  quarantined: false,
  consecutiveFailures: 0,
  ...over,
});

const CHECKOUT_CRAWL = flowMap([node('/checkout', [role('button', 'Pay')])]);

// ─── The distinction ─────────────────────────────────────────────────────────

describe('unreached is not obsolete, and the difference is load-bearing', () => {
  it('proposes retirement only when the route is gone from BOTH the source and a complete crawl', () => {
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      // A complete crawl that reached a different page entirely.
      flowMap: flowMap([node('/orders', [role('link', 'Orders')])]),
      declaredRoutes: ['/orders'],
      retiredRoutes: ['/checkout'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('OBSOLETE');
    expect(only.retirement).not.toBeNull();
    expect(only.retirement!.confidence).toBe(0.9);
    // Positive evidence of deletion, not merely absence.
    expect(only.retirement!.evidence.join(' ')).toMatch(/no longer found/);
    // And the proposal says what accepting it actually does.
    expect(only.retirement!.explanation).toMatch(/DISABLES the test/);
    expect(only.retirement!.explanation).toMatch(/switch it back on/);
    // Counted separately from the drift warnings, because a retirement is not a
    // warning: it is a proposal somebody has to decide on.
    const check = driftCheck(report);
    expect(check.obsoleteCount).toBe(1);
    expect(check.warnings).toEqual([]);
  });

  it('calls it UNREACHED, never obsolete, when the source still declares the route', () => {
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      // The crawler stopped at the login wall and never saw /checkout.
      flowMap: flowMap([node('/login', [role('button', 'Sign in')])]),
      declaredRoutes: ['/login', '/checkout'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('UNREACHED');
    expect(only.retirement).toBeNull();
    expect(only.evidence.join(' ')).toMatch(/still declares/);
    expect(only.caveats.join(' ')).toMatch(/NOT a retirement candidate/);
  });

  it('refuses to propose retirement from a TRUNCATED crawl', () => {
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      flowMap: flowMap([node('/orders', [])], 'page budget exhausted after 25 pages'),
      declaredRoutes: ['/orders'],
      retiredRoutes: ['/checkout'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('UNMEASURED');
    expect(only.retirement).toBeNull();
    expect(only.evidence.join(' ')).toMatch(/stopped early/);
    expect(only.evidence.join(' ')).toMatch(/past where it stopped/);
    expect(report.caveats.join(' ')).toMatch(/looks exactly like a route that is gone/);
  });

  it('refuses to propose retirement with no source analysis to cross-check', () => {
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      flowMap: flowMap([node('/orders', [])]),
      // Null, not []: nobody has read the code, so "not declared" is not a fact.
      declaredRoutes: null,
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('UNMEASURED');
    expect(only.retirement).toBeNull();
    expect(only.evidence.join(' ')).toMatch(/absence of a detector/);
    expect(report.sourceAnalysed).toBe(false);
  });

  it('refuses to judge a test it could not read in full', () => {
    const report = auditTestsAgainstCrawl({
      tests: [
        test_({
          // Unterminated template literal: comment stripping ends inside a
          // string, so every absence-based claim about this file is worthless.
          code: "test('x', async ({ page }) => {\n  const a = `oops\n  await page.goto('/gone');\n});",
        }),
      ],
      flowMap: flowMap([node('/orders', [])]),
      declaredRoutes: ['/orders'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('UNMEASURED');
    expect(only.retirement).toBeNull();
    expect(only.evidence.join(' ')).toMatch(/could not read this test in full/);
  });

  it('refuses to judge a test that navigates nowhere', () => {
    const report = auditTestsAgainstCrawl({
      tests: [
        test_({
          type: 'API',
          code: "test('creates an order', async ({ request }) => {\n  const res = await request.post('/api/orders');\n  expect(res.status()).toBe(201);\n});",
        }),
      ],
      flowMap: CHECKOUT_CRAWL,
      declaredRoutes: ['/checkout'],
    });

    expect(report.tests[0]!.verdict).toBe('UNMEASURED');
    expect(report.tests[0]!.evidence.join(' ')).toMatch(/navigates to no route/);
  });

  it('lowers confidence when nothing proves the route was deleted rather than renamed', () => {
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      flowMap: flowMap([node('/orders', [])]),
      declaredRoutes: ['/orders'],
      // No retiredRoutes: this is pure absence on both sides.
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('OBSOLETE');
    expect(only.retirement!.confidence).toBe(0.7);
    expect(only.retirement!.explanation).toMatch(/deleted rather than renamed/);
    expect(only.caveats.join(' ')).toMatch(/argument from absence/);
  });

  it('does not retire a test when only SOME of its routes are gone', () => {
    const report = auditTestsAgainstCrawl({
      tests: [
        test_({
          code: [
            "test('two pages', async ({ page }) => {",
            "  await page.goto('/checkout');",
            "  await page.goto('/gone');",
            "  await expect(page.getByTestId('x')).toBeVisible();",
            '});',
          ].join('\n'),
        }),
      ],
      flowMap: CHECKOUT_CRAWL,
      declaredRoutes: ['/checkout'],
    });

    // One route reached, one gone — that is a test to fix, not a test to delete.
    expect(report.tests[0]!.verdict).not.toBe('OBSOLETE');
    expect(report.tests[0]!.retirement).toBeNull();
  });

  it('refuses to propose retirement from a CAPPED list of declared routes', () => {
    /*
     * The source side of the argument, fenced as hard as the crawl side. Both
     * callers read the project's route items with a `take`, so on a project with
     * more items than that a route the code DOES declare arrives here missing —
     * which is the exact negative OBSOLETE needs. A cap that can manufacture a
     * retirement for a test whose page is fine is the one mistake this feature
     * calls unrecoverable.
     */
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      flowMap: flowMap([node('/orders', [])]),
      declaredRoutes: ['/orders'],
      declaredRoutesTruncatedReason: 'read the first 2000 route items of more than 2000',
      // Even WITH positive evidence of deletion, which is the 0.9-confidence
      // path: one strong negative plus one capped one is still not two.
      retiredRoutes: ['/checkout'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('UNMEASURED');
    expect(only.retirement).toBeNull();
    expect(only.evidence.join(' ')).toMatch(/capped before it got here/);
    expect(report.declaredRoutesTruncatedReason).toMatch(/2000 route items/);
    expect(report.caveats.join(' ')).toMatch(
      /looks exactly like a route the code does not declare/,
    );
  });

  it('still proposes retirement when the declared list is explicitly complete', () => {
    // The other half of the fence: null means "this is the whole list", and a
    // caller that can say so gets the verdict it was always meant to get.
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      flowMap: flowMap([node('/orders', [])]),
      declaredRoutes: ['/orders'],
      declaredRoutesTruncatedReason: null,
      retiredRoutes: ['/checkout'],
    });

    expect(report.tests[0]!.verdict).toBe('OBSOLETE');
    expect(report.tests[0]!.retirement!.evidence.join(' ')).toMatch(/not a capped page of it/);
  });
});

// ─── The mixed case ──────────────────────────────────────────────────────────

/**
 * A test driving two routes against a complete crawl that reached one of them.
 *
 * THE DEFECT: there was no branch for "some reached, some not", so this fell
 * through to CURRENT — the one verdict whose caveats are documented empty,
 * carrying the sentence "every route this test drives was reached by the newest
 * crawl" about a route the crawl never saw. `routes[]` held the true per-route
 * facts the whole time; the verdict and the evidence both contradicted them.
 */
const TWO_ROUTE_TEST = (second: string): SuiteHealthTestInput =>
  test_({
    code: [
      "import { test, expect } from '@playwright/test';",
      "test('two pages', async ({ page }) => {",
      "  await page.goto('/checkout');",
      `  await page.goto('${second}');`,
      "  await page.getByRole('button', { name: 'Pay' }).click();",
      "  await expect(page.getByTestId('receipt')).toBeVisible();",
      '});',
    ].join('\n'),
  });

describe('a partly-unreached test is never reported CURRENT', () => {
  it('says so when the source still declares the route the crawl missed', () => {
    const report = auditTestsAgainstCrawl({
      tests: [TWO_ROUTE_TEST('/invoice')],
      flowMap: CHECKOUT_CRAWL,
      declaredRoutes: ['/checkout', '/invoice'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('PARTLY_UNREACHED');
    expect(only.retirement).toBeNull();
    // The evidence has to NAME both halves. "Every route was reached" is the
    // sentence this test exists to keep out of the report.
    expect(only.evidence.join(' ')).toMatch(/reached \/checkout but not \/invoice/);
    expect(only.evidence.join(' ')).not.toMatch(/Every route this test drives was reached/);
    expect(only.evidence.join(' ')).toMatch(/still declares \/invoice/);
    // CURRENT is the only verdict a reader is told has nothing to discount.
    expect(only.caveats).not.toEqual([]);
    expect(only.caveats.join(' ')).toMatch(/NOT a retirement candidate/);
    expect(only.caveats.join(' ')).toMatch(/Nothing is claimed about this test’s use of \/invoice/);
    // And the per-route facts and the verdict now agree.
    expect(only.routes).toEqual([
      { route: '/checkout', reached: true, declared: true, retired: false },
      { route: '/invoice', reached: false, declared: true, retired: false },
    ]);
  });

  it('says so when the missed route is absent from the source too', () => {
    const report = auditTestsAgainstCrawl({
      tests: [TWO_ROUTE_TEST('/gone')],
      flowMap: CHECKOUT_CRAWL,
      declaredRoutes: ['/checkout'],
      retiredRoutes: ['/gone'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('PARTLY_UNREACHED');
    expect(only.verdict).not.toBe('CURRENT');
    expect(only.retirement).toBeNull();
    expect(only.evidence.join(' ')).toMatch(/\/gone is absent from the application’s source/);
    // Two independent negatives hold for the ROUTE and still not for the TEST:
    // it drives a page that is plainly there.
    expect(only.evidence.join(' ')).toMatch(/an edit to the test and not a retirement/);
    expect(only.caveats.join(' ')).toMatch(/still drives a live page is never proposed/);
  });

  it('reports DRIFTED rather than the partial verdict, so no warning is lost', () => {
    // Drift is the actionable half and only a DRIFTED verdict becomes a warning
    // in driftCheck. The unreached route is disclosed in the caveats instead of
    // taking the verdict and silently dropping the warning.
    const report = auditTestsAgainstCrawl({
      tests: [TWO_ROUTE_TEST('/invoice')],
      flowMap: flowMap([node('/checkout', [role('button', 'Place order')])]),
      declaredRoutes: ['/checkout', '/invoice'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('DRIFTED');
    expect(only.caveats.join(' ')).toMatch(
      /also drives \/invoice, which the crawl did not reach/,
    );
    expect(driftCheck(report).warnings).toHaveLength(1);
  });

  it('counts the partial verdict in the summary, so it has a denominator', () => {
    const report = auditTestsAgainstCrawl({
      tests: [TWO_ROUTE_TEST('/invoice'), test_({ id: 't2' })],
      flowMap: CHECKOUT_CRAWL,
      declaredRoutes: ['/checkout', '/invoice'],
    });

    expect(report.summary).toEqual({
      CURRENT: 1,
      DRIFTED: 0,
      UNREACHED: 0,
      PARTLY_UNREACHED: 1,
      OBSOLETE: 0,
      UNMEASURED: 0,
    });
    const check = driftCheck(report);
    expect(check.summary.PARTLY_UNREACHED).toBe(1);
    expect(check.warnings).toEqual([]);
    expect(check.obsoleteCount).toBe(0);
  });

  it('reports CURRENT only when every route really was reached', () => {
    // The other side of the branch: the verdict whose caveats are empty still
    // exists, and still means what it says.
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      flowMap: CHECKOUT_CRAWL,
      declaredRoutes: ['/checkout'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('CURRENT');
    expect(only.caveats).toEqual([]);
    expect(only.routes.every((route) => route.reached)).toBe(true);
  });
});

// ─── Drift ───────────────────────────────────────────────────────────────────

describe('the pre-failure drift check', () => {
  it('warns about a locator the newest crawl did not see, before the test fails', () => {
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      // The route is still there; "Pay" was renamed to "Place order".
      flowMap: flowMap([node('/checkout', [role('button', 'Place order')])]),
      declaredRoutes: ['/checkout'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('DRIFTED');
    expect(only.retirement).toBeNull();

    const check = driftCheck(report);
    expect(check.crawlVersion).toBe(7);
    expect(check.warnings).toHaveLength(1);
    expect(check.warnings[0]!.missing[0]!.locator).toBe('role=button[pay]');
    expect(check.warnings[0]!.summary).toMatch(/has not failed yet/);
  });

  it('never claims drift for a route the crawl did not reach', () => {
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      flowMap: flowMap([node('/login', [role('button', 'Sign in')])]),
      declaredRoutes: ['/login', '/checkout'],
    });

    // Every locator would be "missing" on a page nobody loaded. That is noise
    // by construction, so no locator is even compared.
    expect(report.tests[0]!.verdict).toBe('UNREACHED');
    expect(report.tests[0]!.locators).toEqual([]);
    expect(driftCheck(report).warnings).toEqual([]);
  });

  it('says nothing has drifted only about the locators it could compare', () => {
    const report = auditTestsAgainstCrawl({
      tests: [
        test_({
          code: [
            "test('css locator', async ({ page }) => {",
            "  await page.goto('/checkout');",
            "  await page.locator('.cart > .row:nth-child(2) button').click();",
            "  await expect(page.getByTestId('receipt')).toBeVisible();",
            '});',
          ].join('\n'),
        }),
      ],
      flowMap: CHECKOUT_CRAWL,
      declaredRoutes: ['/checkout'],
    });

    const only = report.tests[0]!;
    expect(only.verdict).toBe('CURRENT');
    // A CSS locator is not evidence of anything: the crawler does not enumerate
    // arbitrary CSS, so its absence from the flow map says nothing.
    expect(only.locators.some((check) => !check.comparable)).toBe(true);
    expect(only.caveats.join(' ')).toMatch(/could not be compared/);
  });

  it('ignores positional modifiers, so .first() is not reported as drift', () => {
    expect(locatorIdentity('role=button[pay]:first')).toBe('role=button[pay]');
    expect(locatorIdentity('role=row:nth2')).toBe('role=row');
    expect(locatorIdentity('role=row:has:total')).toBe('role=row');

    const report = auditTestsAgainstCrawl({
      tests: [
        test_({
          code: [
            "test('first row', async ({ page }) => {",
            "  await page.goto('/checkout');",
            "  await page.getByRole('button', { name: 'Pay' }).first().click();",
            "  await expect(page.getByTestId('receipt')).toBeVisible();",
            '});',
          ].join('\n'),
        }),
      ],
      flowMap: CHECKOUT_CRAWL,
      declaredRoutes: ['/checkout'],
    });
    expect(report.tests[0]!.verdict).toBe('CURRENT');
  });

  it('puts the critical-path test about to break at the top', () => {
    const report = auditTestsAgainstCrawl({
      tests: [
        test_({ id: 'low', name: 'nice to have', priority: 'NICE_TO_HAVE' }),
        test_({ id: 'high', name: 'critical', priority: 'CRITICAL_PATH' }),
      ],
      flowMap: flowMap([node('/checkout', [role('button', 'Place order')])]),
      declaredRoutes: ['/checkout'],
    });

    const check = driftCheck(report);
    expect(check.warnings.map((warning) => warning.testId)).toEqual(['high', 'low']);
    expect(check.summary.DRIFTED).toBe(2);
  });

  it('reports every verdict as a count, so the warnings have a denominator', () => {
    const report = auditTestsAgainstCrawl({
      tests: [test_()],
      flowMap: null,
      declaredRoutes: ['/checkout'],
    });

    expect(report.summary).toEqual({
      CURRENT: 0,
      DRIFTED: 0,
      UNREACHED: 0,
      PARTLY_UNREACHED: 0,
      OBSOLETE: 0,
      UNMEASURED: 1,
    });
    expect(report.caveats.join(' ')).toMatch(/Nothing has crawled/);
    expect(driftCheck(report).crawlVersion).toBeNull();
  });
});

describe('crawlSurfaceOf', () => {
  it('survives a flow map written by an older crawler', () => {
    const surface = crawlSurfaceOf({
      ...flowMap([]),
      // Shapes a stored FlowMap can genuinely have.
      nodes: [{ route: '/checkout' }, null] as never,
    });
    expect(surface.routes).toEqual(['/checkout']);
    expect(surface.locators.size).toBe(0);
  });

  it('counts the locators it cannot compare rather than dropping them', () => {
    const surface = crawlSurfaceOf(
      flowMap([node('/x', [{ strategy: 'CSS', value: '.a > .b', confidence: 0.3 }])]),
    );
    expect(surface.locators.size).toBe(0);
    expect(surface.uncomparableAffordances).toBe(1);
  });

  it('normalises a crawled id segment so it matches a test that visits a real one', () => {
    const surface = crawlSurfaceOf(flowMap([node('/orders/8123', [])]));
    expect(surface.routes).toEqual(['/orders/:param']);
  });
});
