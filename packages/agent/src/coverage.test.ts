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
  MAX_BOUNDARY_CASES_PER_GAP,
  analyzeCoverage,
  assertsAFailure,
  chooseAuthProfile,
  expandNegativeCases,
  signsIn,
  canonicalRoute,
  planItemForGap,
  readCrawl,
  routeVisits,
  type AuthProfileChoice,
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
  /** The application's own word on who may see this state. */
  requiresRoles?: string[];
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
    requiresRoles: over.requiresRoles ?? [],
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

/** The same analysis, with roles on offer. */
const runAs = (
  tests: CoverageTestInput[],
  authProfiles: AuthProfileChoice[],
  graph: unknown = shopGraph(),
) => analyzeCoverage({ flowMapGraph: graph, tests, authProfiles });

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

// ─── The negative half, enumerated ───────────────────────────────────────────

/**
 * THE DEFECT, VERBATIM FROM THE REGISTER: "Boundary and equivalence-class
 * expansion per field — one whole feature becomes ONE negative item, built from
 * the FIRST required field. Nothing enumerates empty / too-long / wrong-type /
 * off-by-one / Luhn-invalid / future-date."
 *
 * What stood in `planItemForGap` was literally
 * `subject.forms.flatMap((f) => f.fields).find((f) => f.required)`, one step and
 * two assertions. The fixture below is a form that DECLARES real constraints —
 * a maxlength, a min/max/step triple, a pattern, a select's options — because
 * that is the input the crawler now captures and the input the old
 * `FormSummary` projection threw away before anything could read it.
 */
function constrainedCheckout(): Record<string, unknown> {
  const field = (over: Record<string, unknown>) => ({
    inputType: 'text',
    required: false,
    selector: { strategy: 'LABEL', value: String(over.label), confidence: 0.9 },
    ...over,
  });
  return {
    version: 9,
    baseUrl: 'https://shop.test',
    nodes: [
      node({
        id: 'n-pay',
        route: '/pay',
        title: 'Pay',
        forms: [
          {
            id: 'form-pay',
            name: 'Payment',
            selector: { strategy: 'CSS', value: 'form', confidence: 0.7 },
            submit: role('Place order'),
            fields: [
              field({
                name: 'email',
                label: 'Email',
                inputType: 'email',
                semantic: 'email',
                required: true,
                maxLength: 64,
                validationMessage: 'Enter a valid email address',
              }),
              field({
                name: 'cardNumber',
                label: 'Card number',
                semantic: 'credit_card',
                required: true,
                maxLength: null,
              }),
              field({
                name: 'quantity',
                label: 'Quantity',
                inputType: 'number',
                semantic: 'number',
                required: true,
                min: '1',
                max: '10',
                step: '1',
                maxLength: null,
              }),
              field({
                name: 'promo',
                label: 'Promo code',
                semantic: 'freeform',
                pattern: '[A-Z]{4}[0-9]{2}',
                maxLength: 6,
              }),
              field({
                name: 'country',
                label: 'Country',
                inputType: 'select',
                semantic: 'country',
                required: true,
                options: ['Portugal', 'Japan'],
                maxLength: null,
              }),
              field({ name: 'notes', label: 'Notes', inputType: 'textarea', semantic: 'freeform', maxLength: null }),
            ],
          },
        ],
      }),
    ],
    edges: [],
    journeys: [],
    features: [{ name: 'Payment', nodeIds: ['n-pay'] }],
  };
}

const payGap = (): CoverageGap => {
  const report = analyzeCoverage({
    flowMapGraph: constrainedCheckout(),
    tests: [
      test_({
        id: 'happy-pay',
        name: 'pays with a valid card',
        routes: ['/pay'],
        code: "await page.getByLabel('Email').fill('a@b.co'); await page.getByRole('button', { name: 'Place order' }).click();",
      }),
    ],
  });
  return report.gaps.find((g) => g.kind === 'NO_NEGATIVE_CASE' && g.feature === 'Payment')!;
};

describe('the crawled constraints survive the projection onto a gap', () => {
  /*
   * `readForms` used to read three members off each raw field — label, required,
   * semantic — and drop the other eight, `name` among them. That projection is
   * where the negative half of testing died: the limit is a number the page
   * already carries in an attribute, and "submit one character over it" was
   * unreachable BY CONSTRUCTION once the number was gone.
   */
  const fields = () => {
    const subject = payGap().subject;
    if (subject.kind !== 'negative') throw new Error('expected a negative subject');
    return subject.forms.flatMap((f) => f.fields);
  };

  it('carries the name, which is the key the expansion writes values under', () => {
    expect(fields().map((f) => f.name)).toEqual([
      'email',
      'cardNumber',
      'quantity',
      'promo',
      'country',
      'notes',
    ]);
  });

  it('carries each declared constraint, verbatim', () => {
    const byName = new Map(fields().map((f) => [f.name, f]));
    expect(byName.get('email')!.maxLength).toBe(64);
    expect(byName.get('email')!.validationMessage).toBe('Enter a valid email address');
    expect(byName.get('quantity')!.min).toBe('1');
    expect(byName.get('quantity')!.max).toBe('10');
    expect(byName.get('quantity')!.step).toBe('1');
    expect(byName.get('promo')!.pattern).toBe('[A-Z]{4}[0-9]{2}');
    expect(byName.get('country')!.options).toEqual(['Portugal', 'Japan']);
    expect(byName.get('notes')!.inputType).toBe('textarea');
  });

  it('keeps "nobody looked" and "the page declares nothing" apart', () => {
    /*
     * Three states, not two — the distinction `FormField` is optional in order
     * to preserve. Collapsing absent onto null would make every crawl written
     * before the capture claim the application declares no limits anywhere, and
     * boundaries.ts prints that claim in the justification of every case.
     */
    const byName = new Map(fields().map((f) => [f.name, f]));
    // The crawl looked at Notes and the page declares no limit.
    expect(byName.get('notes')!.maxLength).toBeNull();
    // Nothing looked at Email's pattern, so the key is not there at all.
    expect('pattern' in byName.get('email')!).toBe(false);
    expect(byName.get('email')!.pattern).toBeUndefined();
  });

  it('falls back to the label as the key when a crawl captured no name', () => {
    // An old-shape crawl. Two nameless fields keyed on '' would collide, and
    // every case for the second would silently perturb the first.
    const graph = constrainedCheckout();
    const forms = (graph.nodes as Array<{ forms: Array<{ fields: Array<Record<string, unknown>> }> }>)[0]!.forms[0]!;
    for (const f of forms.fields) delete f.name;
    const crawl = readCrawl(graph);
    const names = crawl.nodes[0]!.forms[0]!.fields.map((f) => f.name);
    expect(names).toEqual(['Email', 'Card number', 'Quantity', 'Promo code', 'Country', 'Notes']);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('a NO_NEGATIVE_CASE gap becomes a table of cases, not one case', () => {
  it('enumerates the classes the register says nothing enumerated', () => {
    const item = planItemForGap(payGap());
    const prose = [...item.steps, ...item.assertions].join(' ');
    /*
     * The register's own list, each one now a row with its own expectation.
     * `empty` and `whitespace-only` are present in the expansion and fall below
     * the rank cap on this six-field form — which the disclosure says out loud,
     * and which the "cap is stated" test below holds it to.
     */
    for (const klass of [
      'over-max-length', // too long
      'at-max-length', // and the limit itself, which must be ACCEPTED
      'wrong-type',
      'over-max', // off-by-one, upper
      'under-min', // off-by-one, lower
      'luhn-invalid',
      'step-misaligned',
      'pattern-violating',
      'unbounded-length',
      'injection-like',
    ]) {
      expect(prose, `no case for ${klass}`).toContain(`[${klass}]`);
    }
  });

  it('is nothing like the one case it replaces', () => {
    const item = planItemForGap(payGap());
    // The literal sentence the old arm produced, from `find(f => f.required)`.
    expect(item.steps.join(' ')).not.toMatch(/left empty or set to an invalid value/);
    // And it is a table, not a sentence.
    expect(item.steps.filter((s) => /^\[[a-z-]+\]/.test(s)).length).toBeGreaterThan(8);
  });

  it('carries the real values the page\'s own attributes imply', () => {
    const steps = planItemForGap(payGap()).steps.join('\n');
    // One over maxlength=64, the inclusive limit itself, and the off-by-ones
    // either side of min="1" max="10" with step="1".
    expect(steps).toMatch(/\[over-max-length\] set "Email" to a 65-character value/);
    expect(steps).toMatch(/\[at-max-length\] set "Email" to a 64-character value/);
    expect(steps).toMatch(/\[over-max\] set "Quantity" to "11"/);
    expect(steps).toMatch(/\[under-min\] set "Quantity" to "0"/);
    expect(steps).toMatch(/\[step-misaligned\] set "Quantity" to "1\.5"/);
  });

  it('does NOT invent a class the page gives it nothing to found on', () => {
    /*
     * The other half of honesty. Only `promo` declares a pattern, only
     * `quantity` a range, only `country` a set of options — so no case may
     * appear for a field whose attributes could not produce one.
     */
    const steps = planItemForGap(payGap()).steps.join('\n');
    expect(steps).not.toMatch(/\[pattern-violating\] set "(Email|Notes|Quantity)"/);
    expect(steps).not.toMatch(/\[over-max\] set "(Email|Notes|Promo code)"/);
    expect(steps).not.toMatch(/\[not-in-options\] set "(Email|Notes|Quantity)"/);
    // A card number has a fixed format, so "emoji must round-trip" is not an
    // expectation this can defend — asserting it would fail a correct app.
    expect(steps).not.toMatch(/\[unicode-emoji\] set "Card number"/);
  });

  it('keeps the positive control, which the rank cap would otherwise cut', () => {
    // `happy-path` is ranked 25, near the bottom, so a plain top-N slice loses
    // it every time — and without it every negative row is equally consistent
    // with a form that refuses ALL input.
    const item = planItemForGap(payGap());
    expect(item.steps.join(' ')).toContain('[happy-path] submit "Payment" with every field valid');
    expect(item.assertions[0]).toMatch(/^Positive control \("Payment"\)/);
  });

  it('asks for ONE parameterised test over the rows, not one test per row', () => {
    // `ecosystem-prompts.ts` already tells the model to prefer an input table
    // over a loop in every ecosystem; the item has to be shaped like that.
    const steps = planItemForGap(payGap()).steps.join(' ');
    expect(steps).toContain('ONE parameterised test');
    expect(steps).toContain('not one test per row');
    expect(steps).toContain('not a loop inside a single test');
  });

  it('perturbs exactly one field per row, and says why that matters', () => {
    const steps = planItemForGap(payGap()).steps;
    expect(steps.join(' ')).toContain('change exactly ONE field per case');
    for (const step of steps.filter((s) => /^\[/.test(s) && !s.includes('happy-path'))) {
      expect(step).toContain('leaving every other field valid');
    }
  });

  it('gives every row its own expectation, in the application\'s terms', () => {
    const item = planItemForGap(payGap());
    const rows = item.assertions.filter((a) => /^\[[a-z-]+\]/.test(a));
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows) {
      // Not "something was refused" — the whole point is that each row says
      // what the application should do, specifically enough to fail on.
      expect(row.length, row).toBeGreaterThan(60);
    }
  });

  it('stays inside the bounds the plan endpoint enforces', () => {
    const item = planItemForGap(payGap());
    expect(item.steps.length).toBeLessThanOrEqual(40);
    expect(item.assertions.length).toBeLessThanOrEqual(20);
    expect(planItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('the cap is STATED, never silent', () => {
  /*
   * Split in two on purpose. The cap has to be stated in BOTH places, for
   * different readers: the gap is what a human looks at on the coverage screen
   * and decides to act on, and the plan item is what travels to the approval
   * screen and then into the generated test's own assertions. Breaking either
   * one has to be able to go red on its own, or a mutation that silences one of
   * them hides behind the other still passing.
   */
  it('names the classes that did not fit IN THE PLAN ITEM a human approves', () => {
    const disclosure = planItemForGap(payGap()).assertions.find((a) =>
      a.startsWith('NOT COVERED by this test:'),
    );
    expect(disclosure, 'the item does not disclose its cap at all').toBeDefined();
    expect(disclosure).toMatch(/equivalence class\(es\) with NO case in this table/);
  });

  it('names them IN THE GAP too, which is what a human reads first', () => {
    const evidence = payGap().evidence.join(' ');
    expect(evidence).toMatch(/NOT enumerated:/);
    expect(evidence).toMatch(/equivalence class\(es\) with NO case in this table/);
  });

  it('reports the top-N honestly: the count kept AND the count there were', () => {
    const evidence = payGap().evidence.join(' ');
    expect(evidence).toMatch(
      new RegExp(`gives \\d+ boundary case\\(s\\) over 6 field\\(s\\); the top ${MAX_BOUNDARY_CASES_PER_GAP} by rank`),
    );
  });

  it('spends the slots on breadth across classes, not depth within one', () => {
    /*
     * Measured regression. A plain top-12-by-rank slice gave four
     * `injection-like` rows (one per text field) and no off-by-one case at all,
     * on a form declaring min="1" max="10" step="1". That is one idea tested on
     * four fields, not a partition of the input space.
     */
    const classes = planItemForGap(payGap())
      .steps.map((s) => /^\[([a-z-]+)\]/.exec(s)?.[1])
      .filter((c): c is string => Boolean(c));
    expect(classes.length).toBe(MAX_BOUNDARY_CASES_PER_GAP);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('counts the two-field combinations it refuses to generate', () => {
    const expansion = expandNegativeCases('seed', [
      {
        name: 'Payment',
        submitLabel: 'Pay',
        fields: [
          { name: 'a', label: 'A', inputType: 'text', required: true, semantic: 'freeform' },
          { name: 'b', label: 'B', inputType: 'text', required: true, semantic: 'freeform' },
        ],
      },
    ]);
    const pairs = expansion.dropped.find((d) => d.what.includes('two-field'));
    expect(pairs).toBeDefined();
    expect(pairs!.why).toMatch(/cannot be attributed to either one/);
  });

  it('expands the same form once when the crawl met it on several pages', () => {
    // A dynamic route is crawled once per real URL, so the group arrives
    // carrying five copies of one form. Expanding each would fill the table
    // with the same case five times over.
    const form = {
      name: 'Add to cart',
      submitLabel: 'Add',
      fields: [
        { name: 'qty', label: 'Quantity', inputType: 'number', required: true, semantic: 'number' as const },
      ],
    };
    const one = expandNegativeCases('seed', [form]);
    const five = expandNegativeCases('seed', [form, form, form, form, form]);
    expect(five.cases.map((c) => c.id)).toEqual(one.cases.map((c) => c.id));
    expect(five.dropped.find((d) => d.what.includes('duplicate copies'))!.count).toBe(4);
  });

  it('does not sum apples and oranges into one alarming number', () => {
    // `dropped` holds cases, two-field combinations and inapplicable classes.
    // Summing them produced 605 on a six-field form, of which 528 were
    // combinations nobody would ever generate — a number nobody can act on.
    const evidence = payGap().evidence.join(' ');
    expect(evidence).toMatch(/\d+ group\(s\) of case\(s\), combination\(s\) and class\(es\)/);
  });
});

describe('the expansion needs no model, and never changes its mind', () => {
  it('produces an identical table on a second call', () => {
    // The seed is the gap id, which is itself a stable hash of the subject. So
    // a gap that travels out through GET /coverage and back in through POST
    // /propose expands to the same table on both sides.
    const a = planItemForGap(payGap());
    const b = planItemForGap(payGap());
    expect(b.steps).toEqual(a.steps);
    expect(b.assertions).toEqual(a.assertions);
  });

  it('does not change the type that decides the no-key path', () => {
    /*
     * `canScaffoldWithoutModel` is what gates the first-run path on a
     * deployment with no key, and it keys on the TEST TYPE. The expansion must
     * not move it: a form-bearing negative gap stays E2E, and a
     * permission-boundary one stays SECURITY_SMOKE.
     */
    expect(planItemForGap(payGap()).testType).toBe('E2E');
    const boundary = run([
      test_({ id: 'admin', name: 'admin page loads', routes: ['/admin/users'], code: 'await login(page);' }),
    ]).gaps.find((g) => g.kind === 'NO_NEGATIVE_CASE' && g.feature === 'Admin');
    expect(boundary).toBeDefined();
    expect(planItemForGap(boundary!).testType).toBe('SECURITY_SMOKE');
  });

  it('falls back to the permission wording when there is no form to expand', () => {
    const boundary = run([
      test_({ id: 'admin', name: 'admin page loads', routes: ['/admin/users'], code: 'await login(page);' }),
    ]).gaps.find((g) => g.kind === 'NO_NEGATIVE_CASE' && g.feature === 'Admin')!;
    const item = planItemForGap(boundary);
    expect(item.steps.join(' ')).toContain('without the permission or precondition it requires');
    expect(boundary.evidence.join(' ')).toContain('No form on this feature could be expanded');
  });

  it('survives a form from a crawl that predates constraint capture', () => {
    // Every constraint absent. The expansion degrades to the classes that need
    // no declared constraint rather than producing nothing.
    const legacy = expandNegativeCases('seed', [
      {
        name: 'Contact',
        submitLabel: 'Send',
        fields: [
          { name: 'email', label: 'Email', inputType: 'email', required: true, semantic: 'email' },
          { name: 'body', label: 'Message', inputType: 'textarea', required: false, semantic: 'freeform' },
        ],
      },
    ]);
    const classes = legacy.cases.map((c) => c.equivalenceClass);
    expect(classes).toContain('empty');
    expect(classes).toContain('wrong-type');
    expect(classes).toContain('unbounded-length');
    expect(classes).not.toContain('over-max-length');
    // And it says the attributes were NOT CAPTURED, rather than claiming the
    // page declares no limits — a claim about markup nobody read.
    expect(legacy.dropped.map((d) => d.what).join(' | ')).toMatch(/was captured on this field/);
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

// ─── Binding a role to the test that closes an auth gap ──────────────────────

/**
 * The defect this section exists for was a LOOP, not a wrong answer.
 *
 * `UNREACHED_AUTH_ROUTE` says "no authenticated test reaches /admin/users". The
 * only test the planner could propose for it was a SECURITY_SMOKE, whose schema
 * can assert anonymous denial and nothing else — so the test was written, it
 * passed, it never reached the page, and the next analysis reported the same
 * gap. Closing the gap re-created the gap, for ever, and no amount of work by
 * the customer could make it converge.
 *
 * Two things had to be true to break it, and both are asserted below:
 *
 *   1. The plan item must carry an AUTH PROFILE, so the test that gets written
 *      signs in instead of asserting a redirect.
 *   2. A test bound to a profile must COUNT AS AUTHENTICATED even though its
 *      source contains no sign-in at all — the runner injects the session, so
 *      `signsIn()` is false for exactly the tests that are most certainly
 *      signed in. This is the half that is easy to miss and the half that makes
 *      the loop a loop.
 *
 * And one thing must stay true: with no profile to name, the planner must NOT
 * quietly propose the signed-in test anyway. A test that runs as nobody and
 * passes is worse than an open gap, because it reports coverage of a page it
 * never saw.
 */

const ADMIN: AuthProfileChoice = { id: 'prof_admin', name: 'Admin', kind: 'FORM_LOGIN' };
const SHOPPER: AuthProfileChoice = { id: 'prof_shopper', name: 'Shopper', kind: 'FORM_LOGIN' };

const adminGap = (report: { gaps: CoverageGap[] }): CoverageGap =>
  report.gaps.find((g) => g.route === '/admin/users' && g.kind === 'UNREACHED_AUTH_ROUTE')!;

describe('an UNREACHED_AUTH_ROUTE gap names the role its test must assume', () => {
  it('carries the profile on the gap and on the plan item', () => {
    const gap = adminGap(runAs([], [ADMIN]));
    expect(gap.requiresAuth).toBe(true);
    expect(gap.authProfile?.id).toBe('prof_admin');

    const item = planItemForGap(gap);
    expect(item.authProfileId).toBe('prof_admin');
    expect(planItemSchema.safeParse(item).success).toBe(true);
  });

  it('proposes a test that SIGNS IN rather than one that asserts the redirect', () => {
    const item = planItemForGap(adminGap(runAs([], [ADMIN])));
    // SECURITY_SMOKE is the type whose schema can only express anonymous
    // denial. Staying on it is what made the loop impossible to exit.
    expect(item.testType).toBe('E2E');
    expect(item.steps.join(' ')).toMatch(/sign in as the "Admin" auth profile/i);
    // The runner injects the session; a login form written into the test would
    // be a second, different sign-in that the profile does not describe.
    expect(item.steps.join(' ')).toMatch(/do NOT write a login form/i);
    expect(item.assertions.join(' ')).toMatch(/Signed in as "Admin"/);
    expect(item.assertions.join(' ')).toMatch(/not a redirect to a login page/i);
  });

  it('says in the evidence which role was chosen and why', () => {
    const gap = adminGap(runAs([], [ADMIN]));
    // The choice is deterministic, which means it is sometimes wrong, which
    // means it has to be arguable. /admin/users and "Admin" share a word.
    expect(gap.evidence.join(' ')).toMatch(/will run as the auth profile "Admin"/);
    expect(gap.evidence.join(' ')).toMatch(/share the word "admin"/);
  });

  it('CONVERGES: a test bound to that profile closes the gap it came from', () => {
    const closing = test_({
      id: 'admin-users',
      name: 'admin can manage users',
      routes: ['/admin/users'],
      // Exactly what the generated test looks like: no sign-in anywhere in it,
      // because the session arrives from the profile. `signsIn` is false here.
      code: "await page.goto('/admin/users');\nawait expect(page.getByRole('table')).toBeVisible();",
      authProfileId: 'prof_admin',
      authProfileRequired: true,
    });
    expect(signsIn(closing.code!.toLowerCase())).toBe(false);

    expect(kinds(runAs([closing], [ADMIN]).gaps, '/admin/users')).not.toContain(
      'UNREACHED_AUTH_ROUTE',
    );
    // And the same test WITHOUT the binding does not close it — which is the
    // proof that the binding is what closed it, not the route literal.
    const unbound = test_({ ...closing, authProfileId: null, authProfileRequired: false });
    expect(kinds(run([unbound]).gaps, '/admin/users')).toContain('UNREACHED_AUTH_ROUTE');
  });

  it('re-opens the gap, by name, when the profile was deleted under the test', () => {
    // The foreign key is SetNull: deleting a profile leaves the test with
    // `authProfileRequired` true and nothing bound. It now runs anonymously and
    // passes whatever a signed-out visitor sees — so this must not read as
    // coverage, and the report must name the test rather than telling a team
    // that wrote exactly this test that nothing reaches /admin/users.
    const orphan = test_({
      id: 'admin-users',
      name: 'admin can manage users',
      routes: ['/admin/users'],
      code: "await page.goto('/admin/users');",
      authProfileId: null,
      authProfileRequired: true,
    });

    const gap = adminGap(runAs([orphan], [ADMIN]));
    expect(gap).toBeDefined();
    expect(gap.title).toMatch(/has a test that needs a role and has no auth profile bound/i);
    expect(gap.evidence.join(' ')).toMatch(/"admin can manage users" declare they need/i);
    expect(gap.evidence.join(' ')).toMatch(/re-bind them rather than writing another test/i);
  });
});

describe('with no role to name, the planner refuses to pretend', () => {
  it('leaves the plan item unbound and says the page stays uncovered', () => {
    const gap = adminGap(run([]));
    expect(gap.requiresAuth).toBe(true);
    expect(gap.authProfile).toBeNull();

    const item = planItemForGap(gap);
    expect(item.authProfileId).toBeNull();
    // Still a real, useful test — of the wall. What it must not do is read as
    // coverage of the page behind it.
    expect(item.testType).toBe('SECURITY_SMOKE');
    expect(item.assertions.join(' ')).toMatch(/NOT COVERED by this test/);
    expect(item.assertions.join(' ')).toMatch(/do not read a pass here as coverage/i);
    expect(planItemSchema.safeParse(item).success).toBe(true);
  });

  it('names the missing setup in the evidence and once at the top of the report', () => {
    const report = run([]);
    expect(adminGap(report).evidence.join(' ')).toMatch(/NO auth profile configured/);
    expect(report.caveats.join(' ')).toMatch(
      /behind an auth wall and this environment has no auth profile configured/i,
    );
  });

  it('does not close the gap just because a profile exists but could not be matched', () => {
    // Two profiles, neither named for anything in the crawl. Picking one would
    // sign the test in as the wrong person, which fails by succeeding.
    const report = runAs([], [SHOPPER, { id: 'prof_eu', name: 'EU customer' }]);
    const gap = adminGap(report);
    expect(gap.authProfile).toBeNull();
    expect(gap.evidence.join(' ')).toMatch(/2 auth profiles are configured/);
    expect(gap.evidence.join(' ')).toMatch(/"Shopper"/);
    expect(report.caveats.join(' ')).toMatch(/none of the 2 configured auth profile\(s\) could be matched/i);
  });

  it('leaves public routes alone — nothing to sign in as, nothing needed', () => {
    const report = runAs([], [ADMIN]);
    const about = report.gaps.find((g) => g.route === '/about')!;
    expect(about.requiresAuth).toBe(false);
    expect(about.authProfile).toBeNull();
    expect(planItemForGap(about).authProfileId).toBeNull();
    expect(planItemForGap(about).assertions.join(' ')).not.toMatch(/NOT COVERED/);
  });
});

describe('chooseAuthProfile, the rule itself', () => {
  it('prefers the role the application declared over anything inferred', () => {
    // The route says "admin"; the app says the node needs "staff". The app wins
    // — it is a statement, not an inference from a URL.
    const chosen = chooseAuthProfile([ADMIN, { id: 'prof_staff', name: 'Staff member' }], {
      route: '/admin/users',
      requiresRoles: ['staff'],
    });
    expect(chosen?.id).toBe('prof_staff');
    expect(chosen?.why).toMatch(/declares it requires the role "staff"/);
  });

  it('falls back to a word the route and a profile name share', () => {
    const chosen = chooseAuthProfile([SHOPPER, ADMIN], { route: '/admin/users' });
    expect(chosen?.id).toBe('prof_admin');
  });

  it('uses the only profile there is, since there is nothing to choose between', () => {
    const chosen = chooseAuthProfile([SHOPPER], { route: '/admin/users' });
    expect(chosen?.id).toBe('prof_shopper');
    expect(chosen?.why).toMatch(/only auth profile configured/);
  });

  it('refuses rather than guessing between several unmatched profiles', () => {
    expect(chooseAuthProfile([SHOPPER, { id: 'prof_eu', name: 'EU customer' }], {
      route: '/admin/users',
    })).toBeNull();
  });

  it('is stable: the same crawl and profiles always bind the same role', () => {
    const roles = { route: '/admin/users', requiresRoles: ['admin'] };
    const forwards = chooseAuthProfile([ADMIN, { id: 'prof_admin2', name: 'Admin backup' }], roles);
    const backwards = chooseAuthProfile([{ id: 'prof_admin2', name: 'Admin backup' }, ADMIN], roles);
    // A gap id is stable across recomputation; the profile behind it has to be
    // too, or two reads of one report propose two different tests.
    expect(forwards?.id).toBe(backwards?.id);
  });

  it('has nothing to offer when there are no profiles, and says so by returning null', () => {
    expect(chooseAuthProfile([], { route: '/admin/users', requiresRoles: ['admin'] })).toBeNull();
  });
});

describe('the fingerprint notices a role change', () => {
  it('changes when a test is re-bound to a different profile', () => {
    const base = test_({ id: 't', routes: ['/admin/users'], code: "page.goto('/admin/users')" });
    const anonymous = runAs([base], [ADMIN]).fingerprint;
    const bound = runAs([{ ...base, authProfileId: 'prof_admin' }], [ADMIN]).fingerprint;
    // Without this, a re-bind would pass the staleness check on /propose and a
    // human could generate a test for a gap they had just closed.
    expect(bound).not.toBe(anonymous);
  });
});
