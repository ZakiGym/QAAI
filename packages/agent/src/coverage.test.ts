/**
 * Coverage gap analysis: the honesty tests.
 *
 * This module tells a team something about their own work that they did not
 * ask to hear, so it is judged on a different axis from the rest of the
 * codebase. A wrong gap is not an inaccuracy, it is an accusation — and a team
 * that is told twice that its tested checkout is untested will never open the
 * screen again. Every case below is therefore one of two things:
 *
 *   - a claim we must NOT make (the invisible test, the parent route, the
 *     mentioned button, the untested about page), or
 *   - a claim we must ALWAYS be able to justify (every gap carries evidence,
 *     every id is stable, every proposal is schema-valid).
 *
 * The model is deliberately absent from all of it. Nothing here needs a key,
 * because nothing that decides whether a gap exists is allowed to need one.
 */

import { describe, expect, it } from 'vitest';
import { planItemSchema } from '@qaai/shared';
import type { Selector } from '@qaai/shared';
import {
  analyzeCoverage,
  assertsAFailure,
  signsIn,
  canonicalRoute,
  planItemForGap,
  readCrawl,
  routeVisits,
  type CoverageGap,
  type CoverageTestInput,
} from './coverage.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const role = (name: string, confidence = 0.9): Selector => ({
  strategy: 'ROLE',
  value: 'button',
  name,
  confidence,
});

const link = (name: string): Selector => ({
  strategy: 'ROLE',
  value: 'link',
  name,
  confidence: 0.85,
});

interface NodeOver {
  id: string;
  route: string;
  title?: string;
  behindAuth?: boolean;
  forms?: unknown[];
  affordances?: unknown[];
}

function node(over: NodeOver): Record<string, unknown> {
  return {
    id: over.id,
    route: over.route,
    url: `https://shop.test${over.route}`,
    title: over.title ?? over.route,
    stateKey: 'default',
    requiresRoles: [],
    behindAuth: over.behindAuth ?? false,
    forms: over.forms ?? [],
    affordances: over.affordances ?? [],
    screenshotKey: null,
    a11yViolationCount: 0,
  };
}

function edge(id: string, from: string, to: string, action: string): Record<string, unknown> {
  return { id, from, to, action, selector: null };
}

function form(
  name: string,
  submit: string | null,
  fields: Array<[string, boolean, string]>,
): Record<string, unknown> {
  return {
    id: `form-${name}`,
    name,
    selector: { strategy: 'CSS', value: 'form', confidence: 0.7 },
    submit: submit ? role(submit) : null,
    fields: fields.map(([label, required, semantic]) => ({
      name: label.toLowerCase().replace(/\s+/g, '_'),
      label,
      inputType: 'text',
      required,
      selector: { strategy: 'LABEL', value: label, name: label, confidence: 0.9 },
      semantic,
    })),
  };
}

/**
 * A small shop with the shape every real crawl has: a hub, a funnel, a page
 * reachable from three places, a marketing page nobody should be nagged about,
 * and an admin area behind an auth wall.
 */
function shopGraph(): Record<string, unknown> {
  return {
    projectId: 'p1',
    environmentId: 'e1',
    version: 4,
    baseUrl: 'https://shop.test',
    exploredAt: '2026-07-01T00:00:00.000Z',
    truncatedReason: null,
    nodes: [
      node({
        id: 'n-home',
        route: '/',
        title: 'Home',
        affordances: [{ label: 'Shop now', selector: link('Shop now'), kind: 'link' }],
      }),
      node({
        id: 'n-products',
        route: '/products',
        title: 'All products',
        affordances: [{ label: 'Burr Grinder', selector: link('Burr Grinder'), kind: 'link' }],
      }),
      node({
        id: 'n-product',
        route: '/products/[id]',
        title: 'Product detail',
        affordances: [{ label: 'Add to cart', selector: role('Add to cart'), kind: 'button' }],
      }),
      node({
        id: 'n-cart',
        route: '/cart',
        title: 'Your cart',
        affordances: [{ label: 'Check out', selector: role('Check out'), kind: 'button' }],
      }),
      node({
        id: 'n-checkout',
        route: '/checkout',
        title: 'Checkout',
        forms: [
          form('Payment', 'Place order', [
            ['Card number', true, 'credit_card'],
            ['Expiry', true, 'card_expiry'],
            ['CVC', true, 'card_cvc'],
          ]),
        ],
        affordances: [{ label: 'Place order', selector: role('Place order'), kind: 'button' }],
      }),
      node({ id: 'n-success', route: '/checkout/success', title: 'Order confirmed' }),
      node({
        id: 'n-refunds',
        route: '/refunds',
        title: 'Request a refund',
        forms: [
          form('Refund request', 'Submit refund', [
            ['Order number', true, 'freeform'],
            ['Reason', false, 'freeform'],
          ]),
        ],
        affordances: [{ label: 'Submit refund', selector: role('Submit refund'), kind: 'button' }],
      }),
      node({ id: 'n-about', route: '/about', title: 'About us' }),
      node({
        id: 'n-admin',
        route: '/admin/users',
        title: 'Manage users',
        behindAuth: true,
        affordances: [{ label: 'Invite user', selector: role('Invite user'), kind: 'button' }],
      }),
    ],
    edges: [
      edge('e1', 'n-home', 'n-products', 'click "Shop now"'),
      edge('e2', 'n-products', 'n-product', 'click "Burr Grinder"'),
      edge('e3', 'n-product', 'n-cart', 'click "Add to cart"'),
      edge('e4', 'n-cart', 'n-checkout', 'click "Check out"'),
      edge('e5', 'n-checkout', 'n-success', 'submit the Payment form'),
      // Three ways into /refunds — this is what makes it outrank /about.
      edge('e6', 'n-home', 'n-refunds', 'click "Refunds"'),
      edge('e7', 'n-success', 'n-refunds', 'click "Request a refund"'),
      edge('e8', 'n-about', 'n-refunds', 'click "Refund policy"'),
      edge('e9', 'n-home', 'n-about', 'click "About"'),
      edge('e10', 'n-home', 'n-admin', 'click "Admin"'),
    ],
    journeys: [
      {
        id: 'j-buy',
        name: 'Buy a grinder',
        description: 'Browse, add to cart, pay',
        edgeIds: ['e2', 'e3', 'e4', 'e5'],
        priority: 'CRITICAL_PATH',
        roles: [],
      },
    ],
    features: [
      { name: 'Checkout', nodeIds: ['n-cart', 'n-checkout', 'n-success'] },
      { name: 'Catalogue', nodeIds: ['n-products', 'n-product'] },
      { name: 'Refunds', nodeIds: ['n-refunds'] },
      { name: 'Marketing', nodeIds: ['n-home', 'n-about'] },
      { name: 'Admin', nodeIds: ['n-admin'] },
    ],
  };
}

function test_(over: Partial<CoverageTestInput> & { id: string }): CoverageTestInput {
  return {
    name: over.id,
    filePath: `specs/${over.id}.spec.ts`,
    feature: null,
    priority: 'IMPORTANT',
    testType: 'E2E',
    tags: [],
    routes: [],
    code: null,
    ...over,
  };
}

const run = (tests: CoverageTestInput[], graph: unknown = shopGraph()) =>
  analyzeCoverage({ flowMapGraph: graph, tests });

const kinds = (gaps: CoverageGap[], route: string) =>
  gaps.filter((g) => g.route === route).map((g) => g.kind);

const routesWithGap = (gaps: CoverageGap[], kind: string) =>
  gaps.filter((g) => g.kind === kind).map((g) => g.route);

// ─── Route keys ──────────────────────────────────────────────────────────────

describe('canonicalRoute collapses every dialect of "anything here"', () => {
  it('folds the framework spellings onto one key', () => {
    for (const raw of ['/orders/[id]', '/orders/{id}', '/orders/:id', '/orders/$id']) {
      expect(canonicalRoute(raw)).toBe('/orders/:param');
    }
    expect(canonicalRoute('/docs/[...slug]')).toBe('/docs/*');
    expect(canonicalRoute('/Checkout/?a=1#top')).toBe('/checkout');
    expect(canonicalRoute('')).toBe('/');
  });

  it('is idempotent, because it is applied to both sides of the comparison', () => {
    for (const raw of ['/orders/[id]', '/a//b/', '/DOCS/[...slug]', '/']) {
      expect(canonicalRoute(canonicalRoute(raw))).toBe(canonicalRoute(raw));
    }
  });
});

describe('routeVisits is strict where impact analysis is generous', () => {
  it('does not let a parent route claim its children', () => {
    // The whole feature dies if this is wrong: half of every suite starts at
    // "/", and a prefix match would declare the entire app covered.
    expect(routeVisits('/checkout', '/checkout/success')).toBe(false);
    expect(routeVisits('/', '/about')).toBe(false);
    expect(routeVisits('/checkout', '/checkout')).toBe(true);
  });

  it('treats a dynamic segment as a wildcard from either direction', () => {
    expect(routeVisits('/orders/123', '/orders/:param')).toBe(true);
    expect(routeVisits('/orders/:param', '/orders/123')).toBe(true);
    expect(routeVisits('/orders/123/items', '/orders/:param')).toBe(false);
  });

  it('lets a catch-all swallow the remainder', () => {
    expect(routeVisits('/docs/*', '/docs/a/b/c')).toBe(true);
    expect(routeVisits('/docs/a/b/c', '/docs/*')).toBe(true);
  });
});

// ─── The claim we must not make ──────────────────────────────────────────────

describe('a test we cannot read is UNKNOWN, never a gap', () => {
  const invisible = test_({
    id: 'invisible',
    name: 'walks the whole funnel',
    code: 'const url = routeFor(product);\nawait page.goto(url);\nawait page.click("#buy");',
    routes: [],
  });

  it('files the test under unknowns with the literal that defeated extraction', () => {
    const report = run([invisible]);
    expect(report.unknowns.map((u) => u.testId)).toEqual(['invisible']);
    expect(report.unknowns[0]!.sample).toContain('goto(url');
    expect(report.unknowns[0]!.reason).toMatch(/built at runtime/i);
  });

  it('caps every route gap at MEDIUM, because that test could be covering any of them', () => {
    const report = run([invisible]);
    const routeGaps = report.gaps.filter((g) => g.kind === 'UNVISITED_ROUTE');
    expect(routeGaps.length).toBeGreaterThan(0);
    expect(routeGaps.every((g) => g.confidence !== 'HIGH')).toBe(true);
    expect(report.caveats.join(' ')).toMatch(/could be covering a route listed below/i);
  });

  it('reaches HIGH only when every test in the project was fully readable', () => {
    const report = run([test_({ id: 'seen', code: "await page.goto('/about')", routes: ['/about'] })]);
    // /products is not adjacent to anything the suite visits, so nothing
    // weakens the claim: every test was readable and none of them goes there.
    const products = report.gaps.find(
      (g) => g.route === '/products' && g.kind === 'UNVISITED_ROUTE',
    )!;
    expect(products.confidence).toBe('HIGH');

    const withInvisible = run([
      test_({ id: 'seen', code: "await page.goto('/about')", routes: ['/about'] }),
      invisible,
    ]);
    expect(
      withInvisible.gaps.find((g) => g.route === '/products' && g.kind === 'UNVISITED_ROUTE')!
        .confidence,
    ).toBe('MEDIUM');
  });

  it('treats a caller-flagged truncation as unknown too', () => {
    const report = run([
      test_({ id: 'huge', routes: ['/about'], code: "page.goto('/about')", coverageTruncated: true }),
    ]);
    expect(report.unknowns.map((u) => u.testId)).toContain('huge');
    expect(report.unknowns[0]!.reason).toMatch(/extraction limit/i);
  });

  it('does not double-count: an unknown test still contributes the routes it did declare', () => {
    // It declared /cart and ALSO navigates somewhere invisible. The declared
    // half is real coverage; only the invisible half is unknown.
    const report = run([
      test_({
        id: 'half',
        routes: ['/cart'],
        code: "await page.goto('/cart'); await page.goto(next);",
      }),
    ]);
    expect(routesWithGap(report.gaps, 'UNVISITED_ROUTE')).not.toContain('/cart');
    expect(report.unknowns.map((u) => u.testId)).toEqual(['half']);
  });
});

describe('a near miss downgrades a gap instead of erasing it', () => {
  it('says so when a test lands one click away', () => {
    const report = run([
      test_({ id: 'checkout', routes: ['/checkout'], code: "page.goto('/checkout')" }),
    ]);
    const success = report.gaps.find((g) => g.route === '/checkout/success')!;
    expect(success.kind).toBe('UNVISITED_ROUTE');
    expect(success.confidence).toBe('MEDIUM');
    expect(success.evidence.join(' ')).toMatch(/click through without writing the URL down/i);
    expect(success.relatedTestIds).toEqual(['checkout']);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

describe('unvisited routes', () => {
  it('reports a route nothing visits, with the crawl evidence for it', () => {
    const report = run([test_({ id: 'about', routes: ['/about'], code: "page.goto('/about')" })]);
    const refunds = report.gaps.find((g) => g.route === '/refunds')!;
    expect(refunds.kind).toBe('UNVISITED_ROUTE');
    expect(refunds.evidence[0]).toMatch(/reached \/refunds from 3 places/);
    expect(refunds.evidence[1]).toMatch(/No route literal in any of the 1 enabled tests/);
    expect(refunds.feature).toBe('Refunds');
  });

  it('does not report a route a test does visit', () => {
    const report = run([test_({ id: 'r', routes: ['/refunds'], code: "page.goto('/refunds')" })]);
    expect(routesWithGap(report.gaps, 'UNVISITED_ROUTE')).not.toContain('/refunds');
  });

  it('matches a concrete id against the crawl’s dynamic segment', () => {
    const report = run([
      test_({ id: 'pd', routes: ['/products/42'], code: "page.goto('/products/42')" }),
    ]);
    expect(routesWithGap(report.gaps, 'UNVISITED_ROUTE')).not.toContain('/products/:param');
  });

  it('says plainly when a project has no tests at all', () => {
    const report = run([]);
    expect(report.caveats.join(' ')).toMatch(/no enabled tests/i);
    const refunds = report.gaps.find((g) => g.route === '/refunds')!;
    expect(refunds.evidence.join(' ')).toMatch(/no enabled tests at all/i);
  });
});

describe('routes behind an auth wall', () => {
  it('is its own kind when nothing reaches it', () => {
    const report = run([test_({ id: 'about', routes: ['/about'] })]);
    expect(kinds(report.gaps, '/admin/users')).toContain('UNREACHED_AUTH_ROUTE');
  });

  it('still reports a gap when the only visitor never signs in', () => {
    const report = run([
      test_({
        id: 'redirect',
        name: 'admin redirects anonymous users',
        routes: ['/admin/users'],
        code: "await page.goto('/admin/users'); await expect(page).toHaveURL(/login/);",
      }),
    ]);
    const gap = report.gaps.find(
      (g) => g.route === '/admin/users' && g.title.includes('only ever tested signed out'),
    );
    expect(gap).toBeDefined();
    expect(gap!.evidence.join(' ')).toMatch(/coverage of the redirect, not of what the page does/i);
  });

  it('closes once a test actually signs in', () => {
    const report = run([
      test_({
        id: 'admin',
        routes: ['/admin/users'],
        code: "test.use({ storageState: 'admin.json' });\nawait page.goto('/admin/users');",
      }),
    ]);
    expect(kinds(report.gaps, '/admin/users')).not.toContain('UNREACHED_AUTH_ROUTE');
  });
});

// ─── Journeys ────────────────────────────────────────────────────────────────

describe('journeys', () => {
  const fullWalk = test_({
    id: 'buy',
    name: 'buys a grinder',
    routes: ['/products', '/products/1', '/cart', '/checkout', '/checkout/success'],
    code: "await page.goto('/products/1'); await page.getByRole('button', { name: 'Add to cart' }).click();",
  });

  it('reports a journey no single test walks, and shows the partial coverage', () => {
    const report = run([
      test_({ id: 'cart-only', routes: ['/cart'] }),
      test_({ id: 'checkout-only', routes: ['/checkout'] }),
    ]);
    const gap = report.gaps.find((g) => g.kind === 'UNWALKED_JOURNEY')!;
    expect(gap.title).toContain('Buy a grinder');
    expect(gap.evidence[0]).toMatch(/\/products\/:param → \/cart → \/checkout → \/checkout\/success/);
    expect(gap.evidence[1]).toMatch(/2 of 5 steps are visited/);
    expect(gap.evidence[1]).toMatch(/nobody walks the whole path/);
    expect(gap.relatedTestIds.sort()).toEqual(['cart-only', 'checkout-only']);
  });

  it('closes when one test covers every step', () => {
    const report = run([fullWalk]);
    expect(report.gaps.filter((g) => g.kind === 'UNWALKED_JOURNEY')).toHaveLength(0);
    expect(report.totals.journeysWalked).toBe(1);
  });

  it('does not let two tests between them count as a walk', () => {
    // The bugs live in the hand-offs. Two tests that each do half prove nothing
    // about the state carried across the seam.
    const report = run([
      test_({ id: 'a', routes: ['/products', '/products/1', '/cart'] }),
      test_({ id: 'b', routes: ['/checkout', '/checkout/success'] }),
    ]);
    expect(report.gaps.some((g) => g.kind === 'UNWALKED_JOURNEY')).toBe(true);
    expect(report.totals.journeysWalked).toBe(0);
  });
});

// ─── Forms and affordances ───────────────────────────────────────────────────

describe('forms', () => {
  it('reports a form nobody fills or submits, and names its fields', () => {
    const report = run([test_({ id: 'about', routes: ['/about'] })]);
    const gap = report.gaps.find(
      (g) => g.kind === 'UNSUBMITTED_FORM' && g.route === '/refunds',
    )!;
    expect(gap.evidence[0]).toMatch(/Order number, Reason/);
    expect(gap.evidence[1]).toMatch(/Submit refund/);
  });

  it('closes on a mention of the submit control anywhere in the suite', () => {
    // Generous on purpose: a false "nobody submits your payment form" is the
    // finding that gets the whole screen closed.
    const report = run([
      test_({
        id: 'pay',
        routes: ['/checkout'],
        code: "await page.getByRole('button', { name: 'Place order' }).click();",
      }),
    ]);
    expect(
      report.gaps.some((g) => g.kind === 'UNSUBMITTED_FORM' && g.route === '/checkout'),
    ).toBe(false);
  });

  it('closes on a field label alongside a fill call', () => {
    const report = run([
      test_({
        id: 'pay',
        routes: ['/checkout'],
        code: "await page.getByLabel('Card number').fill('4242424242424242');",
      }),
    ]);
    expect(
      report.gaps.some((g) => g.kind === 'UNSUBMITTED_FORM' && g.route === '/checkout'),
    ).toBe(false);
  });

  it('does not close on a field label with no interaction at all', () => {
    const report = run([
      test_({ id: 'reads', routes: ['/checkout'], code: "await expect(page.getByText('Card number')).toBeVisible();" }),
    ]);
    expect(
      report.gaps.some((g) => g.kind === 'UNSUBMITTED_FORM' && g.route === '/checkout'),
    ).toBe(true);
  });
});

describe('affordances', () => {
  it('reports a button no test mentions', () => {
    const report = run([test_({ id: 'about', routes: ['/about'] })]);
    const gap = report.gaps.find(
      (g) => g.kind === 'UNUSED_AFFORDANCE' && g.title.includes('Add to cart'),
    )!;
    expect(gap.evidence[0]).toMatch(/getByRole\('button', \{ name: 'Add to cart' \}\)/);
  });

  it('closes on either the label or the locator expression', () => {
    const byLabel = run([test_({ id: 'a', code: 'await clickButton("Add to cart");', routes: ['/x'] })]);
    const byExpression = run([
      test_({
        id: 'b',
        code: "await page.getByRole('button', { name: 'Invite user' }).click();",
        routes: ['/x'],
      }),
    ]);
    expect(byLabel.gaps.some((g) => g.title.includes('Add to cart'))).toBe(false);
    expect(byExpression.gaps.some((g) => g.title.includes('Invite user'))).toBe(false);
  });

  it('leaves links to the route gaps rather than reporting both', () => {
    const report = run([test_({ id: 'about', routes: ['/about'] })]);
    // "Shop now" is a link into /products, which is already an UNVISITED_ROUTE.
    expect(report.gaps.some((g) => g.title.includes('Shop now'))).toBe(false);
  });
});

// ─── Negative cases ──────────────────────────────────────────────────────────

describe('the happy-path-only check', () => {
  const happyCheckout = test_({
    id: 'happy',
    name: 'checkout succeeds with a valid card',
    routes: ['/cart', '/checkout', '/checkout/success'],
    code: "await page.getByLabel('Card number').fill('4242'); await page.getByRole('button', { name: 'Place order' }).click();",
  });

  it('fires on a feature that is only ever tested succeeding', () => {
    const report = run([happyCheckout]);
    const gap = report.gaps.find((g) => g.kind === 'NO_NEGATIVE_CASE' && g.feature === 'Checkout')!;
    expect(gap.confidence).toBe('LOW');
    expect(gap.evidence.join(' ')).toMatch(/weakest claim in this report/i);
    expect(gap.evidence.join(' ')).toMatch(/input validation is only proven by the input that is refused/i);
  });

  it('closes as soon as one test asserts a failure', () => {
    const report = run([
      happyCheckout,
      test_({
        id: 'declined',
        name: 'a declined card is rejected',
        routes: ['/checkout'],
        code: "await expect(page.getByRole('alert')).toContainText('declined');",
      }),
    ]);
    expect(
      report.gaps.some((g) => g.kind === 'NO_NEGATIVE_CASE' && g.feature === 'Checkout'),
    ).toBe(false);
  });

  it('never nags about a feature with nothing to get wrong', () => {
    // Marketing has no form, no auth wall, and an informational name. Demanding
    // a failure test for the about page is how a report gets ignored.
    const report = run([
      test_({ id: 'about', name: 'about renders', routes: ['/about', '/'] }),
    ]);
    expect(
      report.gaps.some((g) => g.kind === 'NO_NEGATIVE_CASE' && g.feature === 'Marketing'),
    ).toBe(false);
  });

  it('says nothing about a feature with no tests — that is a route gap, reported once', () => {
    const report = run([]);
    expect(report.gaps.filter((g) => g.kind === 'NO_NEGATIVE_CASE')).toHaveLength(0);
  });
});

describe('the failure-marker heuristic itself', () => {
  it('counts the things you only write when testing a failure', () => {
    for (const sample of [
      'rejects an invalid email',
      "expect(res.status).toBe(422)",
      "getbyrole('alert')",
      'the order should not be created',
      'a duplicate coupon is refused',
    ]) {
      expect(assertsAFailure(sample.toLowerCase())).toBe(true);
    }
  });

  it('does not read a fixed sleep as a test of a 500', () => {
    // A bare number near a wait is not an assertion about a status code, and
    // reading it as one would silently suppress a real gap.
    expect(assertsAFailure('await page.waitfortimeout(500);')).toBe(false);
    expect(assertsAFailure('await expect(total).tohavetext("$500.00")')).toBe(false);
  });

  it('needs two weak markers, because one shows up in happy paths', () => {
    expect(assertsAFailure('await expect(banner).not.tobevisible()')).toBe(false);
    expect(
      assertsAFailure(
        'await expect(banner).not.tobevisible(); await expect(page.getbytext("empty")).tobevisible()',
      ),
    ).toBe(true);
  });
});

describe('the sign-in heuristic itself', () => {
  it('does not mistake asserting a redirect for having gone through it', () => {
    // This is the exact test whose existence proves the gap: it reaches the
    // door and is turned away. Reading "login" in it as authentication would
    // close the finding it demonstrates.
    expect(signsIn("await expect(page).tohaveurl(/login/)".toLowerCase())).toBe(false);
    expect(signsIn("await page.goto('/login')")).toBe(false);
  });

  it('counts a session, a header, a helper call, or a typed password', () => {
    for (const sample of [
      "test.use({ storagestate: 'admin.json' })",
      "extrahttpheaders: { authorization: `bearer ${token}` }",
      'await signin(page, user)',
      "await page.getbylabel('password').fill('hunter2')",
    ]) {
      expect(signsIn(sample.toLowerCase()), sample).toBe(true);
    }
  });
});

// ─── Ranking ─────────────────────────────────────────────────────────────────

describe('ranking by reachability and blast radius', () => {
  const report = run([]);

  it('puts the refunds page above the about page', () => {
    const refunds = report.gaps.find((g) => g.kind === 'UNVISITED_ROUTE' && g.route === '/refunds')!;
    const about = report.gaps.find((g) => g.kind === 'UNVISITED_ROUTE' && g.route === '/about')!;
    expect(refunds.score).toBeGreaterThan(about.score);
    expect(refunds.reachability).toBeGreaterThan(about.reachability);
  });

  it('returns the gaps already sorted, best first', () => {
    const scores = report.gaps.map((g) => g.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('shows its working, so the ranking can be argued with', () => {
    const refunds = report.gaps.find((g) => g.kind === 'UNVISITED_ROUTE' && g.route === '/refunds')!;
    expect(refunds.scoreWhy.join(' ')).toMatch(/reached it from 3 places/);
    expect(refunds.scoreWhy.join(' ')).toMatch(/heuristic/);
  });

  it('ranks a route gap above a lone unclicked button', () => {
    const route = report.gaps.find((g) => g.kind === 'UNVISITED_ROUTE')!;
    const affordance = report.gaps.find((g) => g.kind === 'UNUSED_AFFORDANCE')!;
    expect(route.score).toBeGreaterThan(affordance.score);
  });
});

// ─── Invariants ──────────────────────────────────────────────────────────────

describe('invariants that hold for every gap', () => {
  const report = run([
    test_({ id: 'a', routes: ['/cart'], code: "page.goto('/cart')" }),
    test_({ id: 'b', routes: ['/about'], code: "page.goto('/about')" }),
  ]);

  it('never emits a gap without evidence', () => {
    expect(report.gaps.length).toBeGreaterThan(5);
    for (const gap of report.gaps) {
      expect(gap.evidence.length).toBeGreaterThan(0);
      expect(gap.evidence.every((line) => line.trim().length > 0)).toBe(true);
      expect(gap.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('gives every gap a unique, stable id', () => {
    const ids = report.gaps.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);

    const again = run([
      test_({ id: 'a', routes: ['/cart'], code: "page.goto('/cart')" }),
      test_({ id: 'b', routes: ['/about'], code: "page.goto('/about')" }),
    ]);
    expect(again.gaps.map((g) => g.id)).toEqual(ids);
    expect(again.fingerprint).toBe(report.fingerprint);
  });

  it('keeps the id stable when only the score moves', () => {
    // The id names the SUBJECT. A human ticking "write this test" means the
    // page, not the sentence we happened to print about it this morning.
    const before = run([]).gaps.find((g) => g.route === '/refunds' && g.kind === 'UNVISITED_ROUTE')!;
    const after = run([test_({ id: 'x', routes: ['/about'] })]).gaps.find(
      (g) => g.route === '/refunds' && g.kind === 'UNVISITED_ROUTE',
    )!;
    expect(after.id).toBe(before.id);
  });

  it('moves the fingerprint when a test changes', () => {
    const changed = run([
      test_({ id: 'a', routes: ['/cart', '/checkout'], code: "page.goto('/cart')" }),
      test_({ id: 'b', routes: ['/about'], code: "page.goto('/about')" }),
    ]);
    expect(changed.fingerprint).not.toBe(report.fingerprint);
  });

  it('keeps the totals honest', () => {
    expect(report.totals.routes).toBe(9);
    expect(report.totals.routesVisited).toBe(2);
    expect(report.totals.tests).toBe(2);
    expect(report.totals.gaps).toBe(report.gaps.length);
  });
});

// ─── Surviving the flow map ──────────────────────────────────────────────────

describe('a report never dies on a malformed crawl', () => {
  it('says it knows nothing rather than inventing gaps', () => {
    for (const graph of [null, 'nope', 42, {}, { nodes: 'not an array' }, { nodes: [] }]) {
      const report = analyzeCoverage({
        flowMapGraph: graph,
        tests: [test_({ id: 'a', routes: ['/x'] })],
      });
      expect(report.crawled).toBe(false);
      expect(report.gaps).toEqual([]);
      expect(report.caveats.join(' ')).toMatch(/no readable crawl/i);
    }
  });

  it('reports the parts it could not read instead of dropping them', () => {
    const graph = shopGraph();
    (graph.nodes as unknown[]).push(null, { id: 'no-route' }, { route: '/orphan' });
    const report = run([], graph);
    expect(report.crawled).toBe(true);
    expect(report.unreadable.join(' ')).toMatch(/3 crawled state\(s\) had no id or no readable route/);
  });

  it('flags a journey that points at edges the graph does not hold', () => {
    const graph = shopGraph();
    (graph.journeys as Array<Record<string, unknown>>)[0]!.edgeIds = ['e2', 'ghost', 'e5'];
    const report = run([], graph);
    expect(report.unreadable.join(' ')).toMatch(/references 1 edge id\(s\) that are not in the graph/);
    expect(report.gaps.some((g) => g.kind === 'UNWALKED_JOURNEY')).toBe(true);
  });

  it('warns that a truncated crawl bounds what a gap can even mean', () => {
    const graph = shopGraph();
    graph.truncatedReason = 'page budget exhausted at 25 pages';
    const report = run([], graph);
    expect(report.caveats.join(' ')).toMatch(/coverage of what was SEEN, not of what exists/);
  });

  it('survives nodes whose forms and affordances are junk', () => {
    const graph = shopGraph();
    (graph.nodes as Array<Record<string, unknown>>)[0]!.forms = [null, { name: 'x', fields: 'no' }];
    (graph.nodes as Array<Record<string, unknown>>)[0]!.affordances = [null, { label: 'orphan' }];
    expect(() => run([], graph)).not.toThrow();
    const report = run([], graph);
    expect(report.unreadable.join(' ')).toMatch(/was not an object and was skipped/);
  });

  it('reads a crawl that carries url but no route field', () => {
    const crawl = readCrawl({
      nodes: [{ id: 'a', url: 'https://shop.test/Deep/Page?x=1' }],
      edges: [],
    });
    expect(crawl.ok).toBe(true);
    expect(crawl.nodes[0]!.route).toBe('/deep/page');
  });
});

// ─── The handoff to the Generator ────────────────────────────────────────────

describe('planItemForGap', () => {
  const report = run([
    test_({
      id: 'happy',
      name: 'checkout succeeds',
      routes: ['/cart', '/checkout', '/checkout/success'],
      code: "await page.getByLabel('Card number').fill('4242');",
    }),
  ]);

  it('produces a plan item the existing plan schema accepts, for every gap', () => {
    expect(report.gaps.length).toBeGreaterThan(5);
    for (const gap of report.gaps) {
      const parsed = planItemSchema.safeParse(planItemForGap(gap));
      expect(parsed.success, `${gap.kind} ${gap.title}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it('carries the evidence through as the rationale, so the test argues for itself', () => {
    const gap = report.gaps.find((g) => g.route === '/refunds' && g.kind === 'UNVISITED_ROUTE')!;
    const item = planItemForGap(gap);
    expect(item.rationale).toContain('reached /refunds from 3 places');
    expect(item.id).toBe(gap.id);
  });

  it('writes journey steps from the actions the crawler actually performed', () => {
    const journeyReport = run([test_({ id: 'x', routes: ['/about'] })]);
    const gap = journeyReport.gaps.find((g) => g.kind === 'UNWALKED_JOURNEY')!;
    const item = planItemForGap(gap);
    expect(item.steps).toContain('click "Add to cart"');
    expect(item.steps).toContain('click "Check out"');
    expect(item.journeyId).toBe('j-buy');
  });

  it('inherits CRITICAL_PATH from the Explorer and never invents it', () => {
    const journeyGap = run([]).gaps.find((g) => g.kind === 'UNWALKED_JOURNEY')!;
    expect(planItemForGap(journeyGap).priority).toBe('CRITICAL_PATH');

    // Nothing else, however high it scores, gets to call itself critical.
    const others = run([]).gaps.filter((g) => g.kind !== 'UNWALKED_JOURNEY');
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((g) => planItemForGap(g).priority !== 'CRITICAL_PATH')).toBe(true);
  });

  it('asks for a sign-in step when the page is behind an auth wall', () => {
    const gap = run([]).gaps.find((g) => g.kind === 'UNREACHED_AUTH_ROUTE')!;
    const item = planItemForGap(gap);
    expect(item.testType).toBe('SECURITY_SMOKE');
    expect(item.steps.join(' ')).toMatch(/sign in/i);
    expect(item.assertions.join(' ')).toMatch(/signed-out one does not/i);
  });

  it('turns a form gap into fill steps named after the real fields', () => {
    const gap = report.gaps.find((g) => g.kind === 'UNSUBMITTED_FORM' && g.route === '/refunds')!;
    const item = planItemForGap(gap);
    expect(item.steps.join('\n')).toMatch(/Fill "Order number"/);
    expect(item.steps[item.steps.length - 1]).toContain('Submit refund');
    expect(item.assertions.join(' ')).toMatch(/Leaving "Order number" empty is refused/);
  });

  it('asks for meaning rather than pixels', () => {
    for (const gap of report.gaps) {
      const item = planItemForGap(gap);
      expect(item.assertions.length).toBeGreaterThan(0);
      expect(item.assertions.join(' ')).not.toMatch(/screenshot|pixel|css class/i);
    }
  });

  it('clamps to the plan schema bounds rather than being rejected at the last moment', () => {
    const monstrous: CoverageGap = {
      ...report.gaps[0]!,
      title: 'x'.repeat(500),
      evidence: ['y'.repeat(4000)],
      feature: 'z'.repeat(400),
    };
    const item = planItemForGap(monstrous);
    expect(planItemSchema.safeParse(item).success).toBe(true);
    expect(item.rationale.length).toBeLessThanOrEqual(1000);
    expect(item.feature.length).toBeLessThanOrEqual(80);
  });
});
