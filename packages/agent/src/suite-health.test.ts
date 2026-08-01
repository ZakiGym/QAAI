/**
 * Suite-health tests.
 *
 * The two things this module can get wrong are not symmetrical, and the suite
 * is weighted accordingly.
 *
 *   A FALSE DUPLICATE is the expensive one. Somebody reads "these two tests are
 *   the same" and deletes one, and the deleted one was the only test asserting
 *   the total. So the negative cases here — two tests with near-identical names
 *   doing different things, two tests with the same journey and one differing
 *   assertion — matter more than the positive ones, and they assert not just
 *   the verdict but that the DIFFERENCE is spelled out in the payload a human
 *   reads.
 *
 *   A FALSE WEAKNESS is cheap once and fatal in aggregate: a report that cries
 *   wolf about strong tests gets closed and never opened again. So every
 *   finding kind is tested with its own counter-example — a regex assertion is
 *   not volatile, a catch that re-throws is not swallowing, a negated existence
 *   check is a real assertion.
 *
 * Nothing here calls a model, because nothing in the module does.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_SIMILARITY,
  analyzeSuiteHealth,
  extractBehavior,
  findDuplicates,
  findWeakAssertions,
  normalizeLocator,
  normalizeRoute,
  scoreSuiteHealth,
  similarity,
  specAssertions,
  stripComments,
  suiteHealthPrompt,
  type SuiteHealthTestInput,
  type TestBehavior,
  type WeakAssertionKind,
} from './suite-health.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTest(over: Partial<SuiteHealthTestInput> & { id: string }): SuiteHealthTestInput {
  return {
    name: over.id,
    filePath: `tests/${over.id}.spec.ts`,
    type: 'E2E',
    priority: 'IMPORTANT',
    feature: 'Checkout',
    tags: [],
    code: '',
    spec: null,
    flakeRate: 0,
    quarantined: false,
    consecutiveFailures: 0,
    ...over,
  };
}

const CHECKOUT_HAPPY = `
import { test, expect } from '@playwright/test';

test('checkout with a saved card', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByRole('heading')).toHaveText('Order confirmed');
});
`;

/** Same journey, different name, ONE extra assertion. The classic near-duplicate. */
const CHECKOUT_HAPPY_COPY = `
import { test, expect } from '@playwright/test';

test('a returning customer can complete a purchase', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByRole('heading')).toHaveText('Order confirmed');
  await expect(page.getByTestId('order-total')).toHaveText('$59.97');
});
`;

/** Byte-for-byte the same behaviour under a third name. */
const CHECKOUT_HAPPY_TWIN = `
test('purchase completes', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByRole('heading')).toHaveText('Order confirmed');
});
`;

/**
 * The same behaviour again, written in a different STYLE: double quotes, a
 * locator held in a variable, the chain wrapped. Behaviour-level comparison has
 * to see through all of it — this is what a second engineer's copy looks like.
 */
const CHECKOUT_HAPPY_THIRD = `
test("buying works", async ({ page }) => {
  const payButton = page.getByRole("button", { name: "Pay now" });
  await page.goto("/checkout");
  await page
    .getByLabel("Card number")
    .fill("4242424242424242");
  await payButton.click();
  await expect(page.getByRole("heading")).toHaveText("Order confirmed");
});
`;

// ─── Comment stripping ───────────────────────────────────────────────────────

describe('comment stripping', () => {
  it('does not treat the // in a URL as a comment', () => {
    const { text, unreliable } = stripComments(
      `await page.goto('https://shop.test/checkout');\nawait expect(page).toBeOK();`,
    );

    expect(unreliable).toBe(false);
    expect(text).toContain('https://shop.test/checkout');
    expect(text).toContain('toBeOK');
  });

  it('blanks comments without moving any offset or losing a line', () => {
    const source = `const a = 1; // trailing\n/* block\n   spans */ const b = 2;\n`;
    const { text } = stripComments(source);

    expect(text.length).toBe(source.length);
    expect(text.split('\n').length).toBe(source.split('\n').length);
    expect(text).not.toContain('trailing');
    expect(text).toContain('const b = 2;');
  });

  it('flags a source that ends inside an unterminated string', () => {
    expect(stripComments(`const s = 'oops`).unreliable).toBe(true);
    expect(stripComments(`/* never closed`).unreliable).toBe(true);
  });

  it('does not count a commented-out assertion as an assertion', () => {
    // The whole reason comments are stripped: this test is assertion-free and
    // has to be reported as such, however much it looks like it checks something.
    const behavior = extractBehavior(
      makeTest({
        id: 't',
        code: `test('x', async ({ page }) => {\n  await page.goto('/orders');\n  // await expect(page.getByRole('heading')).toHaveText('Orders');\n});`,
      }),
    );

    expect(behavior.assertionSites).toHaveLength(0);
    expect(behavior.incomplete).toBe(false);
  });
});

// ─── Normalisation ───────────────────────────────────────────────────────────

describe('route normalisation', () => {
  it('collapses every dynamic-segment spelling onto one', () => {
    const forms = ['/orders/[id]', '/orders/{id}', '/orders/:id', '/orders/$id', '/orders/8123'];
    const normalized = new Set(forms.map(normalizeRoute));

    expect([...normalized]).toEqual(['/orders/:param']);
  });

  it('drops query and hash and lower-cases', () => {
    expect(normalizeRoute('/Checkout?step=2#top')).toBe('/checkout');
    expect(normalizeRoute('/')).toBe('/');
  });
});

describe('locator normalisation', () => {
  it('gives two spellings of the same locator the same key', () => {
    const single = normalizeLocator(`page.getByRole('button', { name: 'Pay now' }).click()`);
    const double = normalizeLocator(`page.getByRole("button", { name: "Pay Now" }).click()`);

    expect(single).toBe('role=button[pay now]');
    expect(double).toBe(single);
  });

  it('keeps chain, nth and hasText in the key', () => {
    expect(normalizeLocator(`page.getByTestId('rows').getByRole('link').nth(2).click()`)).toBe(
      'testid=rows>role=link:nth2',
    );
  });

  it('reads the pre-locator API rather than dropping the action', () => {
    expect(normalizeLocator(`page.click('#pay')`)).toBe('css=#pay');
  });
});

// ─── Behaviour extraction ────────────────────────────────────────────────────

describe('behaviour extraction', () => {
  it('reads routes, actions and assertions out of a normal spec', () => {
    const behavior = extractBehavior(makeTest({ id: 'a', code: CHECKOUT_HAPPY }));

    expect(behavior.routes).toEqual(['nav:/checkout']);
    expect(behavior.actions).toEqual([
      'act:click:role=button[pay now]',
      'act:fill:label=card number',
    ]);
    expect(behavior.assertions).toHaveLength(1);
    expect(behavior.assertions[0]).toContain('tohavetext');
    expect(behavior.incomplete).toBe(false);
  });

  it('survives a chain broken across lines', () => {
    // Prettier wraps long chains, and a line-local scan sees the click as
    // happening on nothing at all.
    const behavior = extractBehavior(
      makeTest({
        id: 'wrapped',
        code: `test('x', async ({ page }) => {\n  await page\n    .getByRole('button', { name: 'Pay now' })\n    .click();\n  await expect(page.getByTestId('total'))\n    .toHaveText('$10.00');\n});`,
      }),
    );

    expect(behavior.actions).toEqual(['act:click:role=button[pay now]']);
    expect(behavior.assertionSites).toHaveLength(1);
    expect(behavior.assertionSites[0]!.target).toBe('testid=total');
  });

  it('resolves a locator held in a variable to the same key as an inline one', () => {
    const inline = extractBehavior(
      makeTest({ id: 'inline', code: `test('x', async ({ page }) => {\n  await page.getByRole('button', { name: 'Pay now' }).click();\n});` }),
    );
    const viaVar = extractBehavior(
      makeTest({
        id: 'var',
        code: `test('x', async ({ page }) => {\n  const payButton = page.getByRole('button', { name: 'Pay now' });\n  await payButton.click();\n});`,
      }),
    );

    expect(viaVar.actions).toEqual(inline.actions);
  });

  it('takes the static prefix of a template-literal navigation', () => {
    const behavior = extractBehavior(
      makeTest({ id: 't', code: 'await page.goto(`${baseURL}/orders/${id}`);' }),
    );

    expect(behavior.routes).toEqual(['nav:/orders/:param']);
  });

  it('reads routes out of spec for the types whose code is inert', () => {
    const behavior = extractBehavior(
      makeTest({
        id: 'api',
        type: 'API',
        code: null,
        spec: { steps: [{ method: 'POST', path: '/api/orders' }, { path: '/api/orders/42' }] },
      }),
    );

    expect(behavior.routes.sort()).toEqual(['nav:/api/orders', 'nav:/api/orders/:param']);
  });

  it('distinguishes a status assertion from a value assertion made with the same matcher', () => {
    const behavior = extractBehavior(
      makeTest({
        id: 'k',
        code: `expect(response.status()).toBe(200);\nexpect(total).toBe(59.97);`,
      }),
    );

    expect(behavior.assertionSites.map((s) => s.kind)).toEqual(['transport', 'content']);
  });

  it('records line numbers against the original source, comments included', () => {
    const code = `// header\n\ntest('x', async ({ page }) => {\n  await expect(page.getByText('hi')).toBeVisible();\n});`;
    const behavior = extractBehavior(makeTest({ id: 'l', code }));

    expect(behavior.assertionSites[0]!.line).toBe(4);
    expect(behavior.assertionSites[0]!.quote).toBe(
      "await expect(page.getByText('hi')).toBeVisible();",
    );
  });

  it('marks a test it could not read completely instead of reporting it as thin', () => {
    const behavior = extractBehavior(
      makeTest({ id: 'broken', code: `await page.goto('/checkout);\nawait page.click('#pay');` }),
    );

    expect(behavior.incomplete).toBe(true);
    expect(behavior.incompleteReason).toMatch(/unterminated/);
  });

  it('never throws, whatever is in the code column', () => {
    for (const code of ['', '((((', '}}}}', 'expect(', 'try {', ' ']) {
      expect(() => extractBehavior(makeTest({ id: 'x', code }))).not.toThrow();
    }
  });
});

// ─── Similarity ──────────────────────────────────────────────────────────────

describe('similarity', () => {
  const behaviorOf = (id: string, code: string): TestBehavior =>
    extractBehavior(makeTest({ id, code }));

  it('scores two byte-identical journeys as identical', () => {
    const result = similarity(
      behaviorOf('a', CHECKOUT_HAPPY),
      behaviorOf('b', CHECKOUT_HAPPY_TWIN),
    );

    expect(result.score).toBe(1);
    expect(result.differingFacets).toEqual([]);
  });

  it('drops below 1 when one assertion differs, and says which', () => {
    const result = similarity(
      behaviorOf('a', CHECKOUT_HAPPY),
      behaviorOf('b', CHECKOUT_HAPPY_COPY),
    );

    expect(result.score).toBeLessThan(1);
    expect(result.differingFacets).toContain('assertions');
    expect(result.facets.assertions.onlyInB.join()).toContain('order-total');
    expect(result.facets.assertions.onlyInA).toEqual([]);
  });

  it('does not let a shared emptiness inflate the score', () => {
    // Two assertion-free tests must not score 1.0 on the "assertions" facet by
    // virtue of both having none — that facet is unmeasured, not perfect.
    const a = behaviorOf('a', `await page.goto('/a');\nawait page.click('#one');`);
    const b = behaviorOf('b', `await page.goto('/b');\nawait page.click('#two');`);
    const result = similarity(a, b);

    expect(result.facets.assertions.score).toBeNull();
    expect(result.score).toBe(0);
  });
});

// ─── Duplicate detection ─────────────────────────────────────────────────────

describe('duplicate detection', () => {
  const scanOf = (tests: SuiteHealthTestInput[]) => findDuplicates(tests.map(extractBehavior));

  it('finds two differently-named tests doing the same thing', () => {
    const scan = scanOf([
      makeTest({ id: 'a', name: 'checkout with a saved card', code: CHECKOUT_HAPPY }),
      makeTest({ id: 'b', name: 'purchase completes', code: CHECKOUT_HAPPY_TWIN }),
    ]);

    expect(scan.pairs).toHaveLength(1);
    expect(scan.pairs[0]!.verdict).toBe('IDENTICAL');
    expect(scan.pairs[0]!.score).toBe(1);
  });

  it('does NOT call two similarly-named tests duplicates when they do different things', () => {
    // The trap. Name similarity is not evidence and is never consulted.
    const scan = scanOf([
      makeTest({
        id: 'a',
        name: 'checkout succeeds',
        code: `await page.goto('/checkout');\nawait page.getByRole('button', { name: 'Pay now' }).click();\nawait expect(page.getByRole('heading')).toHaveText('Order confirmed');`,
      }),
      makeTest({
        id: 'b',
        name: 'checkout succeeded',
        code: `await page.goto('/admin/refunds');\nawait page.getByRole('button', { name: 'Issue refund' }).click();\nawait expect(page.getByTestId('refund-status')).toHaveText('Refunded');`,
      }),
    ]);

    expect(scan.pairs).toHaveLength(0);
  });

  it('spells out the differing assertion and refuses to call the pair disposable', () => {
    const scan = scanOf([
      makeTest({ id: 'a', code: CHECKOUT_HAPPY }),
      makeTest({ id: 'b', code: CHECKOUT_HAPPY_COPY }),
    ]);

    const pair = scan.pairs[0]!;
    expect(pair.score).toBeGreaterThan(DEFAULT_MIN_SIMILARITY);
    expect(pair.assertionsDiffer).toBe(true);
    expect(pair.facets.assertions.shared).toHaveLength(1);
    expect(pair.facets.assertions.onlyInB).toHaveLength(1);
    expect(pair.recommendation).toMatch(/keep both/i);
  });

  it('never marks anything safe to delete, at any similarity', () => {
    const scan = scanOf([
      makeTest({ id: 'a', code: CHECKOUT_HAPPY }),
      makeTest({ id: 'b', code: CHECKOUT_HAPPY_TWIN }),
      makeTest({ id: 'c', code: CHECKOUT_HAPPY_COPY }),
    ]);

    expect(scan.pairs.length).toBeGreaterThan(0);
    for (const pair of scan.pairs) expect(pair.safeToDelete).toBe(false);
    for (const cluster of scan.clusters) expect(cluster.recommendation).not.toMatch(/\bdelete\b/i);
  });

  it('groups three tests doing the same thing into one cluster', () => {
    const scan = scanOf([
      makeTest({ id: 'a', name: 'one', code: CHECKOUT_HAPPY }),
      makeTest({ id: 'b', name: 'two', code: CHECKOUT_HAPPY_TWIN }),
      makeTest({ id: 'c', name: 'three', code: CHECKOUT_HAPPY_THIRD }),
    ]);

    expect(scan.clusters).toHaveLength(1);
    expect(scan.clusters[0]!.size).toBe(3);
    expect(scan.clusters[0]!.sharedRoutes).toEqual(['nav:/checkout']);
    expect(scan.clusters[0]!.sharedAssertions).toHaveLength(1);
    expect(scan.clusters[0]!.membersDiffer).toBe(false);
  });

  it('keeps the test with the extra assertion OUT of the cluster', () => {
    // The whole safety argument in one case. Three tests are the same test;
    // the fourth walks the same journey and additionally checks the total. It
    // is reported as overlapping — with the extra assertion named — and never
    // swept into a group labelled "pick one of these to keep".
    const scan = scanOf([
      makeTest({ id: 'a', name: 'one', code: CHECKOUT_HAPPY }),
      makeTest({ id: 'b', name: 'two', code: CHECKOUT_HAPPY_TWIN }),
      makeTest({ id: 'c', name: 'three', code: CHECKOUT_HAPPY_THIRD }),
      makeTest({ id: 'd', name: 'checks the total too', code: CHECKOUT_HAPPY_COPY }),
    ]);

    expect(scan.clusters).toHaveLength(1);
    expect(scan.clusters[0]!.testIds).not.toContain('d');

    const withD = scan.pairs.filter((p) => p.a.testId === 'd' || p.b.testId === 'd');
    expect(withD.length).toBeGreaterThan(0);
    for (const pair of withD) {
      expect(pair.verdict).toBe('OVERLAPPING');
      expect(pair.assertionsDiffer).toBe(true);
      expect(JSON.stringify(pair.facets.assertions)).toContain('order-total');
      expect(pair.recommendation).toMatch(/keep both/i);
    }
  });

  it('excludes a test it could not read completely', () => {
    // Its facets are a subset of what it does, and a subset can only make two
    // tests look MORE alike than they are.
    const scan = scanOf([
      makeTest({ id: 'a', code: CHECKOUT_HAPPY }),
      makeTest({ id: 'b', code: `${CHECKOUT_HAPPY}\nconst broken = 'unterminated` }),
    ]);

    expect(scan.pairs).toHaveLength(0);
  });

  it('ignores pairs too thin to mean anything', () => {
    const scan = scanOf([
      makeTest({ id: 'a', code: `await page.goto('/');` }),
      makeTest({ id: 'b', code: `await page.goto('/');` }),
    ]);

    expect(scan.pairs).toHaveLength(0);
  });

  it('does not index on routes alone, so a shared route is not a candidate pair', () => {
    // `nav:/checkout` in a 2000-test suite yields 31k candidate comparisons and
    // distinguishes none of them. Indexing it put an ordinary suite over the
    // pair cap, which turned the safety valve into a permanent "duplicate
    // detection unavailable".
    const scan = scanOf([
      makeTest({
        id: 'a',
        code: `await page.goto('/checkout');\nawait page.getByTestId('a').click();\nawait expect(page.getByTestId('x')).toHaveText('1');`,
      }),
      makeTest({
        id: 'b',
        code: `await page.goto('/checkout');\nawait page.getByTestId('b').click();\nawait expect(page.getByTestId('y')).toHaveText('2');`,
      }),
    ]);

    expect(scan.pairsCompared).toBe(0);
    expect(scan.complete).toBe(true);
  });

  it('still compares tests whose only signal IS their routes', () => {
    // Dropping routes from the index entirely would make thin, navigation-only
    // duplicates the one kind this cannot see.
    const code = `await page.goto('/a');\nawait page.goto('/b');\nawait page.goto('/c');`;
    const scan = scanOf([makeTest({ id: 'a', code }), makeTest({ id: 'b', code })]);

    expect(scan.pairsCompared).toBe(1);
    expect(scan.pairs[0]!.verdict).toBe('IDENTICAL');
  });

  it('reports a capped scan as incomplete rather than returning a short list as the answer', () => {
    const tests = Array.from({ length: 12 }, (_, i) =>
      makeTest({ id: `t${i}`, code: CHECKOUT_HAPPY }),
    );
    const scan = findDuplicates(tests.map(extractBehavior), { maxPostings: 3 });

    expect(scan.complete).toBe(false);
    expect(scan.incompleteReason).toMatch(/not expanded/);
    expect(scan.skippedCommonTokens.length).toBeGreaterThan(0);
  });

  it('keeps clusters complete even when the reported pair list is truncated', () => {
    const tests = Array.from({ length: 5 }, (_, i) =>
      makeTest({ id: `t${i}`, code: CHECKOUT_HAPPY }),
    );
    const scan = findDuplicates(tests.map(extractBehavior), { maxReportedPairs: 2 });

    expect(scan.pairs).toHaveLength(2);
    expect(scan.omittedPairs).toBe(8); // 10 pairs among 5 tests
    expect(scan.clusters[0]!.size).toBe(5);
  });
});

// ─── Weak assertions ─────────────────────────────────────────────────────────

function findingsFor(tests: SuiteHealthTestInput[]) {
  const behaviors = new Map(tests.map((t) => [t.id, extractBehavior(t)]));
  return findWeakAssertions(tests, behaviors);
}

function kinds(tests: SuiteHealthTestInput[]): WeakAssertionKind[] {
  return findingsFor(tests).map((f) => f.kind);
}

describe('assertion strengthening', () => {
  it('flags a test that navigates and asserts only a status code', () => {
    const code = `test('orders page loads', async ({ page }) => {\n  const res = await page.goto('/orders');\n  expect(res.status()).toBe(200);\n});`;
    const [finding] = findingsFor([makeTest({ id: 'a', name: 'orders page loads', code })]).filter(
      (f) => f.kind === 'TRANSPORT_ONLY',
    );

    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('HIGH');
    expect(finding!.line).toBe(3);
    expect(finding!.quote).toBe('expect(res.status()).toBe(200);');
    expect(finding!.assertInstead).toMatch(/toHaveText|toContainText/);
  });

  it('flags a test with no assertion at all', () => {
    const code = `test('user can open settings', async ({ page }) => {\n  await page.goto('/settings');\n  await page.getByRole('button', { name: 'Save' }).click();\n});`;
    const finding = findingsFor([makeTest({ id: 'a', code })]).find(
      (f) => f.kind === 'NO_ASSERTIONS',
    );

    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('HIGH');
    expect(finding!.quote).toBe("await page.goto('/settings');");
  });

  it('flags a locator only ever asserted to exist, and names it', () => {
    const code = `await page.goto('/orders');\nawait expect(page.getByTestId('order-row')).toBeVisible();`;
    const finding = findingsFor([makeTest({ id: 'a', code })]).find(
      (f) => f.kind === 'EXISTENCE_ONLY',
    );

    expect(finding).toBeDefined();
    expect(finding!.why).toContain('testid=order-row');
    expect(finding!.quote).toContain('toBeVisible');
  });

  it('does not flag toBeVisible on a locator that already names the text', () => {
    // `getByRole('heading', { name: 'Products' })` fails if the heading says
    // anything else, so the expected content is already asserted. Telling the
    // author to "assert the content instead" is telling them to write it twice
    // — and this fired on real seeded specs before it was fixed.
    const code = `await page.goto('/');\nawait expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();\nawait expect(page.getByText('Ground Coffee Co.')).toBeVisible();`;

    expect(kinds([makeTest({ id: 'a', name: 'storefront rejects a bad slug', code })])).toEqual([]);
  });

  it('still flags toBeVisible on a locator that pins nothing', () => {
    const code = `await page.goto('/');\nawait expect(page.getByTestId('product-price')).toBeVisible();`;
    const finding = findingsFor([makeTest({ id: 'a', code })]).find(
      (f) => f.kind === 'EXISTENCE_ONLY',
    );

    // The distinction that matters: a price element rendering "NaN" passes this.
    expect(finding).toBeDefined();
    expect(finding!.why).toContain('testid=product-price');
  });

  it('does not accuse a plugin-asserted test type of having no assertions', () => {
    // Accessibility, visual, security-smoke and mutation tests never author an
    // assertion — the plugin owns the pass/fail criterion. Every a11y and
    // security row in the seeded project was flagged HIGH before this rule.
    const a11y = makeTest({
      id: 'a',
      type: 'ACCESSIBILITY',
      code: '// Accessibility tests are driven by `spec`, not source code.',
      spec: { routes: ['/'], standard: 'wcag2aa' },
    });
    const security = makeTest({
      id: 'b',
      type: 'SECURITY_SMOKE',
      code: '// Security smoke tests are driven by `spec`, not source code.',
      spec: { authRequiredPaths: ['/account'] },
    });

    expect(kinds([a11y])).not.toContain('NO_ASSERTIONS');
    expect(kinds([security])).not.toContain('NO_ASSERTIONS');
  });

  it('never emits a finding whose evidence renders as an empty string', () => {
    // A spec-driven test has no source line, and a blank `quote` is a finding
    // nobody can check. Observed on a seeded imported API test.
    const findings = findingsFor([
      makeTest({
        id: 'a',
        type: 'API',
        feature: 'Health',
        code: '',
        spec: { steps: [{ path: '/api/health', expectStatus: 200, expectBody: { ok: true } }] },
      }),
    ]);

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.quote.trim()).not.toBe('');
      expect(finding.quote).toContain('/api/health');
    }
  });

  it('quotes the spec fragment, not a comment, when the finding came from spec', () => {
    const finding = findingsFor([
      makeTest({
        id: 'a',
        type: 'API',
        code: '// API tests are driven by `spec`.',
        spec: { steps: [{ path: '/api/orders', expectStatus: 200 }] },
      }),
    ]).find((f) => f.kind === 'TRANSPORT_ONLY');

    expect(finding).toBeDefined();
    expect(finding!.line).toBeNull();
    expect(finding!.quote).toContain('expectStatus');
    expect(finding!.quote).not.toContain('driven by');
  });

  it('does not flag a locator that is also asserted on for content', () => {
    const code = `await page.goto('/orders');\nawait expect(page.getByTestId('order-row')).toBeVisible();\nawait expect(page.getByTestId('order-row')).toContainText('Delivered');`;

    expect(kinds([makeTest({ id: 'a', name: 'orders show status', code })])).not.toContain(
      'EXISTENCE_ONLY',
    );
  });

  it('does not flag a negated existence check — "the error is gone" is a real assertion', () => {
    const code = `await page.goto('/orders');\nawait expect(page.getByTestId('spinner')).not.toBeVisible();`;

    expect(kinds([makeTest({ id: 'a', code })])).not.toContain('EXISTENCE_ONLY');
  });

  it('flags an assertion on a volatile expected value and quotes the line', () => {
    const code = `await expect(page.getByTestId('placed-at')).toHaveText('2026-01-15');\nawait expect(page.getByTestId('ref')).toHaveText('Order #10023');`;
    const findings = findingsFor([makeTest({ id: 'a', code })]).filter(
      (f) => f.kind === 'VOLATILE_ASSERTION',
    );

    expect(findings).toHaveLength(2);
    expect(findings[0]!.why).toMatch(/ISO date|order or invoice number/);
    expect(findings.map((f) => f.line).sort()).toEqual([1, 2]);
  });

  it('does not call a regex assertion volatile — a regex is the fix', () => {
    const code = `await expect(page.getByTestId('ref')).toHaveText(/Order #\\d+/);\nawait expect(page.getByTestId('placed-at')).toHaveText(/\\d{4}-\\d{2}-\\d{2}/);`;

    expect(kinds([makeTest({ id: 'a', code })])).not.toContain('VOLATILE_ASSERTION');
  });

  it('sees a volatile value in the second argument of a two-argument matcher', () => {
    const code = `await expect(page.getByRole('link')).toHaveAttribute('href', '/orders/8812431');`;

    expect(kinds([makeTest({ id: 'a', code })])).toContain('VOLATILE_ASSERTION');
  });

  it('flags an assertion whose failure is swallowed by a catch', () => {
    const code = `test('checkout', async ({ page }) => {\n  await page.goto('/checkout');\n  try {\n    await expect(page.getByRole('heading')).toHaveText('Order confirmed');\n  } catch (e) {\n    console.log('probably fine');\n  }\n});`;
    const finding = findingsFor([makeTest({ id: 'a', code })]).find(
      (f) => f.kind === 'SWALLOWED_ASSERTION',
    );

    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('HIGH');
    expect(finding!.line).toBe(4);
    expect(finding!.why).toContain('line 5');
    expect(finding!.quote).toContain('Order confirmed');
  });

  it('does not flag a catch that re-throws', () => {
    const code = `try {\n  await expect(page.getByRole('heading')).toHaveText('Order confirmed');\n} catch (e) {\n  throw new Error('checkout heading wrong: ' + e);\n}`;

    expect(kinds([makeTest({ id: 'a', name: 'checkout fails loudly', code })])).not.toContain(
      'SWALLOWED_ASSERTION',
    );
  });

  it('does not let a swallowed assertion satisfy the "has assertions" check', () => {
    // A test whose ONLY assertion is swallowed asserts nothing that can fail.
    const code = `try {\n  await expect(page.getByRole('heading')).toHaveText('Hi');\n} catch {}`;
    const result = kinds([makeTest({ id: 'a', code })]);

    expect(result).toContain('SWALLOWED_ASSERTION');
  });

  it('flags a feature whose every test walks the happy path', () => {
    const finding = findingsFor([
      makeTest({ id: 'a', feature: 'Login', name: 'user logs in', code: CHECKOUT_HAPPY }),
      makeTest({ id: 'b', feature: 'Login', name: 'user stays logged in', code: CHECKOUT_HAPPY }),
      makeTest({ id: 'c', feature: 'Login', name: 'user logs out', code: CHECKOUT_HAPPY }),
    ]).find((f) => f.kind === 'NO_NEGATIVE_PATH');

    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('MEDIUM');
    expect(finding!.why).toContain('Login');
    expect(finding!.assertInstead).toMatch(/4xx|alert/);
  });

  it('accepts a feature with one error-path test', () => {
    const negative = `await page.goto('/login');\nawait page.getByLabel('Email').fill('nope@example.com');\nawait expect(page.getByRole('alert')).toContainText('Invalid credentials');`;

    expect(
      kinds([
        makeTest({ id: 'a', feature: 'Login', name: 'user logs in', code: CHECKOUT_HAPPY }),
        makeTest({ id: 'b', feature: 'Login', name: 'wrong password is rejected', code: negative }),
      ]),
    ).not.toContain('NO_NEGATIVE_PATH');
  });

  it('leaves a genuinely strong test alone', () => {
    const code = `test('checkout charges the right total', async ({ page }) => {\n  await page.goto('/checkout');\n  await page.getByLabel('Card number').fill('4242424242424242');\n  await page.getByRole('button', { name: 'Pay now' }).click();\n  await expect(page.getByRole('heading')).toHaveText('Order confirmed');\n  await expect(page.getByTestId('order-total')).toHaveText('$59.97');\n  await expect(page.getByRole('alert')).toBeHidden();\n});`;

    expect(kinds([makeTest({ id: 'a', name: 'checkout rejects an expired card', code })])).toEqual(
      [],
    );
  });

  it('makes no absence-based accusation about a test it could not read', () => {
    // Unterminated string: we did not see the end of this test, so "it has no
    // assertions" is not something we know.
    const code = `await page.goto('/orders');\nconst broken = 'never closed`;
    const result = kinds([makeTest({ id: 'a', code })]);

    expect(result).not.toContain('NO_ASSERTIONS');
    expect(result).not.toContain('TRANSPORT_ONLY');
    expect(result).not.toContain('NO_NEGATIVE_PATH');
  });

  it('reads assertions out of spec before accusing a spec-driven test of having none', () => {
    const withBody = makeTest({
      id: 'a',
      type: 'API',
      code: null,
      spec: { steps: [{ path: '/api/orders', expectStatus: 200, expectBody: { total: 5997 } }] },
    });
    const statusOnly = makeTest({
      id: 'b',
      type: 'API',
      code: null,
      spec: { steps: [{ path: '/api/orders', expectStatus: 200 }] },
    });

    expect(kinds([withBody])).not.toContain('NO_ASSERTIONS');
    expect(kinds([withBody])).not.toContain('TRANSPORT_ONLY');
    expect(kinds([statusOnly])).toContain('TRANSPORT_ONLY');
  });

  it('classifies spec assertions the same way the finding does', () => {
    expect(specAssertions({ expectStatus: 200 }).statusOnly).toBe(true);
    expect(specAssertions({ expectStatus: 200 }).count).toBe(1);
    expect(specAssertions({ expectStatus: 200, expectBody: {} }).statusOnly).toBe(false);
    // A k6 threshold is an assertion; missing it made every LOAD test look empty.
    expect(specAssertions({ thresholds: { http_req_duration: ['p(95)<500'] } }).count).toBe(1);
    expect(specAssertions(null)).toEqual({ statusOnly: false, count: 0, statusQuote: null });
  });
});

// ─── The score ───────────────────────────────────────────────────────────────

describe('the health score', () => {
  it('decomposes: the components add up to the total', () => {
    const tests = [
      makeTest({ id: 'a', code: CHECKOUT_HAPPY, flakeRate: 12 }),
      makeTest({ id: 'b', code: CHECKOUT_HAPPY_TWIN, quarantined: true }),
      makeTest({ id: 'c', code: `await page.goto('/x');`, consecutiveFailures: 5 }),
    ];
    const report = analyzeSuiteHealth({ tests });
    const sum = report.components.reduce((total, c) => total + c.contribution, 0);

    expect(Math.round(sum)).toBe(report.score);
    expect(report.formula.trim().endsWith(`=  ${report.score}`)).toBe(true);
    for (const component of report.components) {
      if (!component.available) continue;
      expect(component.contribution).toBeCloseTo(
        (component.score! * component.effectiveWeight) / 100,
        1,
      );
    }
  });

  it('renormalises the weights over the components it could measure', () => {
    const report = analyzeSuiteHealth({ tests: [makeTest({ id: 'a', code: CHECKOUT_HAPPY })] });
    const availableWeight = report.components
      .filter((c) => c.available)
      .reduce((sum, c) => sum + c.effectiveWeight, 0);

    // No flow map here, so critical-path coverage is unmeasured and says so.
    const critical = report.components.find((c) => c.key === 'criticalCoverage')!;
    expect(critical.available).toBe(false);
    expect(critical.effectiveWeight).toBe(0);
    expect(critical.detail).toMatch(/not scored/i);
    expect(availableWeight).toBeCloseTo(100, 1);
  });

  it('refuses to grade duplication off a capped scan rather than reporting a flattering number', () => {
    const tests = Array.from({ length: 12 }, (_, i) =>
      makeTest({ id: `t${i}`, code: CHECKOUT_HAPPY }),
    );
    const report = analyzeSuiteHealth({ tests, options: { maxPostings: 3 } });
    const duplication = report.components.find((c) => c.key === 'duplication')!;

    expect(report.limits.duplicateScanComplete).toBe(false);
    expect(duplication.available).toBe(false);
    expect(duplication.score).toBeNull();
    expect(duplication.detail).toMatch(/cleaner than it is/);
  });

  it('costs the suite for quarantined tests and for persistent failures', () => {
    const clean = analyzeSuiteHealth({ tests: [makeTest({ id: 'a', code: CHECKOUT_HAPPY })] });
    const rotten = analyzeSuiteHealth({
      tests: [
        makeTest({ id: 'a', code: CHECKOUT_HAPPY, quarantined: true, consecutiveFailures: 9 }),
      ],
    });

    expect(rotten.score).toBeLessThan(clean.score);
    expect(rotten.components.find((c) => c.key === 'quarantine')!.score).toBe(0);
    expect(rotten.components.find((c) => c.key === 'reliability')!.score).toBe(0);
  });

  it('scores a strong single-test suite above a weak one', () => {
    const strong = analyzeSuiteHealth({
      tests: [
        makeTest({
          id: 'a',
          name: 'checkout rejects an expired card',
          code: `await page.goto('/checkout');\nawait page.getByRole('button', { name: 'Pay now' }).click();\nawait expect(page.getByTestId('order-total')).toHaveText('$59.97');`,
        }),
      ],
    });
    const weak = analyzeSuiteHealth({
      tests: [
        makeTest({
          id: 'a',
          name: 'checkout page loads',
          code: `const res = await page.goto('/checkout');\nexpect(res.status()).toBe(200);`,
        }),
      ],
    });

    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.grade).toBe('A');
  });

  it('is 0, and says why, when nothing could be measured', () => {
    const result = scoreSuiteHealth({
      tests: [],
      behaviors: [],
      duplicates: {
        pairs: [],
        clusters: [],
        complete: true,
        incompleteReason: null,
        pairsCompared: 0,
        skippedCommonTokens: [],
        omittedPairs: 0,
        ineligible: [],
      },
      weakAssertions: [],
      criticalPaths: { available: false, journeys: [] },
    });

    expect(result.score).toBe(0);
    expect(result.formula).toMatch(/not by evidence/);
  });
});

// ─── Critical-path coverage ──────────────────────────────────────────────────

describe('critical-path coverage', () => {
  const graph = {
    nodes: [
      { id: 'n1', route: '/cart' },
      { id: 'n2', route: '/checkout' },
      { id: 'n3', route: '/orders/[id]' },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
    ],
    journeys: [
      { id: 'j1', name: 'Buy something', priority: 'CRITICAL_PATH', edgeIds: ['e1', 'e2'] },
      { id: 'j2', name: 'Browse', priority: 'NICE_TO_HAVE', edgeIds: ['e1'] },
    ],
  };

  it('counts only CRITICAL_PATH journeys and scores partial coverage as half', () => {
    const report = analyzeSuiteHealth({
      tests: [makeTest({ id: 'a', code: `await page.goto('/cart');\nawait page.goto('/checkout');` })],
      flowMapGraph: graph,
    });

    expect(report.criticalPaths).toHaveLength(1);
    expect(report.criticalPaths[0]!.status).toBe('PARTIAL');
    expect(report.components.find((c) => c.key === 'criticalCoverage')!.score).toBe(50);
  });

  it('treats a journey covered only by a quarantined test as uncovered', () => {
    // A quarantined test is a signal switched off; counting it as coverage
    // would be the report telling a comfortable lie.
    const report = analyzeSuiteHealth({
      tests: [
        makeTest({
          id: 'a',
          quarantined: true,
          code: `await page.goto('/cart');\nawait page.goto('/checkout');\nawait page.goto('/orders/9');`,
        }),
      ],
      flowMapGraph: graph,
    });

    expect(report.criticalPaths[0]!.status).toBe('UNCOVERED');
    expect(report.criticalPaths[0]!.onlyQuarantined).toBe(true);
  });

  it('degrades to unmeasured on a flow map of the wrong shape rather than throwing', () => {
    for (const bad of [null, 42, { nodes: 'nope' }, { nodes: [], journeys: [{}] }]) {
      const report = analyzeSuiteHealth({
        tests: [makeTest({ id: 'a', code: CHECKOUT_HAPPY })],
        flowMapGraph: bad,
      });
      expect(report.components.find((c) => c.key === 'criticalCoverage')!.available).toBe(false);
    }
  });
});

// ─── End to end ──────────────────────────────────────────────────────────────

describe('the report', () => {
  it('lists what it could not analyse instead of scoring it as healthy', () => {
    const report = analyzeSuiteHealth({
      tests: [
        makeTest({ id: 'ok', code: CHECKOUT_HAPPY }),
        makeTest({ id: 'bad', code: `await page.goto('/x');\nconst s = 'unterminated` }),
      ],
    });

    expect(report.totals.tests).toBe(2);
    expect(report.totals.analyzed).toBe(1);
    expect(report.unanalyzed).toHaveLength(1);
    expect(report.unanalyzed[0]!.testId).toBe('bad');
    expect(report.unanalyzed[0]!.reason).toMatch(/unterminated/);
    // And the excluded test is named in the component detail, not buried.
    expect(report.components.find((c) => c.key === 'assertionStrength')!.detail).toContain(
      'could not be read completely',
    );
  });

  it('scores every cluster it found, even the ones too numerous to list', () => {
    // The cluster list is capped for payload. If the SCORE were computed off
    // the capped list, a suite could improve its number by having too many
    // duplicates to print — the exact opposite of what the number is for.
    const tests = Array.from({ length: 220 }, (_, i) =>
      makeTest({
        id: `t${i}`,
        // Pairs: t0≡t1, t2≡t3, … 110 clusters of two.
        code: `await page.goto('/f${i >> 1}');\nawait page.getByTestId('go-${i >> 1}').click();\nawait expect(page.getByTestId('out-${i >> 1}')).toHaveText('v${i >> 1}');`,
      }),
    );
    const report = analyzeSuiteHealth({ tests });

    expect(report.totals.duplicateClusters).toBe(110);
    expect(report.duplicateClusters).toHaveLength(100);
    expect(report.limits.omittedClusters).toBe(10);
    // All 220 tests are duplicated, so the component bottoms out — proof the
    // score saw the 10 clusters that were never printed.
    expect(report.components.find((c) => c.key === 'duplication')!.score).toBe(0);
  });

  it('handles an empty suite without pretending it is healthy', () => {
    const report = analyzeSuiteHealth({ tests: [] });

    expect(report.score).toBe(0);
    expect(report.duplicates).toEqual([]);
    expect(report.weakAssertions).toEqual([]);
    expect(report.totals.tests).toBe(0);
  });

  it('produces prompt material that carries the caveats, not just the numbers', () => {
    const tests = Array.from({ length: 12 }, (_, i) =>
      makeTest({ id: `t${i}`, code: CHECKOUT_HAPPY }),
    );
    const report = analyzeSuiteHealth({ tests, options: { maxPostings: 3 } });
    const { system, user } = suiteHealthPrompt(report);

    expect(system).toMatch(/not recommend deleting/i);
    expect(user).toContain(`Score: ${report.score}/100`);
    expect(user).toMatch(/Duplicate scan incomplete/);
  });

  it('counts findings by severity consistently with the list it returns', () => {
    const report = analyzeSuiteHealth({
      tests: [
        makeTest({ id: 'a', code: `await page.goto('/a');\nawait page.click('#b');` }),
        makeTest({
          id: 'b',
          code: `await expect(page.getByTestId('at')).toHaveText('2026-01-15');`,
        }),
      ],
    });
    const { HIGH, MEDIUM, LOW } = report.totals.weakAssertionsBySeverity;

    expect(HIGH + MEDIUM + LOW).toBe(report.weakAssertions.length);
    expect(report.totals.weakAssertions).toBe(report.weakAssertions.length);
  });

  it('survives a suite of hostile code columns', () => {
    const tests = ['((((', '`unclosed', 'try {', 'expect(', '', 'a'.repeat(50_000)].map(
      (code, i) => makeTest({ id: `t${i}`, code }),
    );

    expect(() => analyzeSuiteHealth({ tests })).not.toThrow();
    const report = analyzeSuiteHealth({ tests });
    expect(report.totals.tests).toBe(tests.length);
  });
});
