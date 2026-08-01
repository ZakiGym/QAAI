/**
 * Tests for test-from-bug-report.
 *
 * There is no API key in this environment, so nothing here executes a model.
 * That is not the limitation it sounds like: the model writes the code, and
 * everything that decides WHETHER the code is right — what was read out of the
 * ticket, which route it starts from, whether a test already covers it, and
 * above all whether a run reproduced anything — is deterministic and is what is
 * tested below.
 *
 * Four properties carry the feature, and each one is here because getting it
 * wrong is silent:
 *
 *   1. **A reproduction that passes has not reproduced anything.** `reproVerdict`
 *      must say NOT_REPRODUCED on a green run, in those words, for every way a
 *      run can be green.
 *   2. **The assertion is the expected behaviour, never the observed one.** An
 *      assertion built from "Actual:" passes against the broken app.
 *   3. **A URL from a ticket may choose a path, never a host.** `parseIssueUrl`
 *      feeds a request that carries a vault token, and the trailing-dot bypass
 *      in apps/api/src/lib/issues.ts started life as exactly this kind of
 *      hostname comparison.
 *   4. **Duplicate detection fails open.** It is the one thing here that can
 *      suppress work, and the cost of a false positive is a bug nobody ever
 *      reproduced.
 */

import { TEST_RESULT_STATUSES, planItemSchema } from '@qaai/shared';
import type { FlowMap, FlowNode, TestResultStatus } from '@qaai/shared';
import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_THRESHOLD,
  ReproInputError,
  buildReproPlanItem,
  classifySection,
  collapseIds,
  extractBugReport,
  extractErrorStrings,
  extractPaths,
  extractSelectors,
  extractUrls,
  failureText,
  findCoveringTests,
  matchFlowMap,
  matchReportedError,
  mergeEnrichment,
  parseIssueUrl,
  parseSteps,
  reproVerdict,
} from './repro.js';
import type { CoveringTest, ExtractedReport } from './repro.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function node(route: string, title: string, id = route): FlowNode {
  return {
    id,
    route,
    url: `https://staging.shop.test${route}`,
    title,
    stateKey: 'default',
    requiresRoles: [],
    behindAuth: false,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
  };
}

function flowMap(nodes: FlowNode[], overrides: Partial<FlowMap> = {}): FlowMap {
  return {
    projectId: 'p1',
    environmentId: 'e1',
    version: 3,
    baseUrl: 'https://staging.shop.test',
    nodes,
    edges: [],
    journeys: [],
    features: [{ name: 'Checkout', nodeIds: ['/checkout'] }],
    exploredAt: '2026-01-01T00:00:00.000Z',
    truncatedReason: null,
    ...overrides,
  };
}

const SHOP = flowMap([
  node('/', 'Home'),
  node('/cart', 'Your cart'),
  node('/checkout', 'Checkout'),
  node('/orders/:id', 'Order detail'),
]);

/** A GitHub issue template, filled in the way people actually fill them in. */
const GITHUB_STYLE = `# Checkout hangs after applying a promo code

## Steps to reproduce
1. Go to https://staging.shop.test/cart
2. Add the "Blue mug" to the cart
3. Click \`#promo-apply\` and enter SAVE10
4. Press Check out

## Expected behaviour
The order confirmation page appears and the total shows 10% off.

## Actual behaviour
The spinner never stops and the console shows an error.

\`\`\`
TypeError: Cannot read properties of undefined (reading 'total')
    at applyPromo (checkout.js:42:11)
\`\`\`

## Environment
- Browser: Chrome 141
- OS: macOS 15.2
- Environment: staging
`;

// ─── parseIssueUrl ───────────────────────────────────────────────────────────

describe('parseIssueUrl reads an identifier and never a destination', () => {
  it('reads a GitHub issue', () => {
    expect(parseIssueUrl('https://github.com/acme/storefront/issues/412')).toEqual({
      provider: 'GITHUB',
      host: 'github.com',
      repo: 'acme/storefront',
      key: '412',
      isPullRequest: false,
    });
  });

  it('accepts a GitHub pull request, because the issues API serves those too', () => {
    const ref = parseIssueUrl('https://github.com/acme/storefront/pull/9');
    expect(ref).toMatchObject({ provider: 'GITHUB', key: '9', isPullRequest: true });
  });

  it('reads a Linear issue with or without the slug', () => {
    expect(parseIssueUrl('https://linear.app/acme/issue/ENG-42/checkout-hangs')).toMatchObject({
      provider: 'LINEAR',
      key: 'ENG-42',
    });
    expect(parseIssueUrl('https://linear.app/acme/issue/ENG-42')).toMatchObject({ key: 'ENG-42' });
  });

  it('reads a Jira issue from /browse and from a board URL', () => {
    expect(parseIssueUrl('https://acme.atlassian.net/browse/QA-12')).toMatchObject({
      provider: 'JIRA',
      host: 'acme.atlassian.net',
      key: 'QA-12',
    });
    expect(
      parseIssueUrl('https://acme.atlassian.net/jira/software/projects/QA/boards/1?selectedIssue=QA-12'),
    ).toMatchObject({ provider: 'JIRA', key: 'QA-12' });
  });

  /*
   * The one that matters. `https://acme.atlassian.net./browse/QA-1` resolves to
   * the same machine as the dotless form, and Node's URL parser keeps the dot.
   * The route compares this host against the host on the configured Jira
   * integration and refuses a mismatch — so a host that normalises differently
   * here than it does there is a comparison that can be walked past, which is
   * precisely the bug issues.ts carries a comment about.
   */
  it('normalises a trailing-dot host so a hostname comparison cannot be bypassed', () => {
    expect(parseIssueUrl('https://acme.atlassian.net./browse/QA-1').host).toBe('acme.atlassian.net');
    expect(parseIssueUrl('https://ACME.Atlassian.NET/browse/QA-1').host).toBe('acme.atlassian.net');
    expect(parseIssueUrl('https://GitHub.com./acme/repo/issues/1')).toMatchObject({
      provider: 'GITHUB',
      host: 'github.com',
    });
  });

  it('refuses credentials embedded in the URL', () => {
    expect(() => parseIssueUrl('https://user:ghp_secret@github.com/a/b/issues/1')).toThrow(
      ReproInputError,
    );
  });

  it('refuses a scheme that is not http(s)', () => {
    for (const url of ['file:///etc/passwd', 'ftp://github.com/a/b/issues/1']) {
      expect(() => parseIssueUrl(url)).toThrow(ReproInputError);
    }
  });

  it('refuses dot segments in a GitHub slug, encoded or not', () => {
    expect(() => parseIssueUrl('https://github.com/../../issues/1')).toThrow(ReproInputError);
    expect(() => parseIssueUrl('https://github.com/%2e%2e/repo/issues/1')).toThrow(ReproInputError);
  });

  it('refuses a Jira-shaped URL on a single-label internal host', () => {
    expect(() => parseIssueUrl('https://jira/browse/QA-1')).toThrow(ReproInputError);
    expect(() => parseIssueUrl('https://localhost./browse/QA-1')).toThrow(ReproInputError);
  });

  it('refuses anything it cannot make an identifier out of, and says what works', () => {
    expect(() => parseIssueUrl('https://example.com/some/page')).toThrow(/github\.com/);
    expect(() => parseIssueUrl('not a url')).toThrow(ReproInputError);
    expect(() => parseIssueUrl('')).toThrow(ReproInputError);
    expect(() => parseIssueUrl('https://github.com/acme/repo/issues/abc')).toThrow(ReproInputError);
    expect(() => parseIssueUrl('https://linear.app/acme/issue/eng-42')).toThrow(ReproInputError);
  });
});

// ─── Section classification and step parsing ─────────────────────────────────

describe('classifySection puts the specific labels ahead of the generic ones', () => {
  it.each([
    // "Steps" is the single most common heading there is, and a word-boundary
    // pattern built around the singular does not match it.
    ['Steps', 'STEPS'],
    ['Steps to reproduce', 'STEPS'],
    ['Reproduction steps', 'STEPS'],
    ['To reproduce', 'STEPS'],
    ['How to reproduce', 'STEPS'],
    ['Expected result', 'EXPECTED'],
    ['Expected behaviour', 'EXPECTED'],
    ['Actual result', 'ACTUAL'],
    ['Observed', 'ACTUAL'],
    ['Current behavior', 'ACTUAL'],
    ['Environment', 'ENVIRONMENT'],
    ['Browser', 'ENVIRONMENT'],
    ['Stack trace', 'ERRORS'],
    ['Console output', 'ERRORS'],
    ['Summary', 'TITLE'],
    ['Additional context', 'DESCRIPTION'],
    ['Shipping address', 'OTHER'],
  ])('%s -> %s', (label, key) => {
    expect(classifySection(label)).toBe(key);
  });

  it('does not let "Expected result" fall into ACTUAL through the word "result"', () => {
    expect(classifySection('Expected result')).toBe('EXPECTED');
    expect(classifySection('Actual result')).toBe('ACTUAL');
  });
});

describe('parseSteps reads every convention a reporter might use', () => {
  it('reads a numbered list', () => {
    const { steps, format } = parseSteps('1. Open /cart\n2. Click Check out\n3. Watch it hang');
    expect(format).toBe('ORDERED');
    expect(steps).toEqual(['Open /cart', 'Click Check out', 'Watch it hang']);
  });

  it('reads "Step 1:" prose', () => {
    const { steps, format } = parseSteps('Step 1: Log in\nStep 2: Open the cart');
    expect(format).toBe('STEP_N');
    expect(steps).toEqual(['Log in', 'Open the cart']);
  });

  it('keeps the Gherkin keyword, because it is part of the meaning', () => {
    const { steps, format } = parseSteps('Given a logged-in user\nWhen I click Pay\nThen it hangs');
    expect(format).toBe('GHERKIN');
    expect(steps[0]).toBe('Given a logged-in user');
  });

  it('reads a bullet list', () => {
    expect(parseSteps('- Open /cart\n* Click pay').format).toBe('BULLET');
  });

  it('folds a wrapped step into the step above it', () => {
    const { steps } = parseSteps('1. Open the cart page\n   and wait for it to load\n2. Click pay');
    expect(steps).toEqual(['Open the cart page and wait for it to load', 'Click pay']);
  });

  it('splits a list that was crammed onto one line', () => {
    const { steps, format } = parseSteps('1. go to /cart 2. click checkout 3. see the spinner');
    expect(format).toBe('INLINE');
    expect(steps).toEqual(['go to /cart', 'click checkout', 'see the spinner']);
  });

  it('does not read a version number as an inline list', () => {
    // "1." here is a version, and the numbers do not count up from 1 to 2.
    expect(parseSteps('We are on build 1.4 and it broke after 3. releases').format).not.toBe(
      'INLINE',
    );
  });

  it('falls back to one step per line only for short prose, and says so', () => {
    expect(parseSteps('Open the cart\nClick pay').format).toBe('LINES');
    const long = Array.from({ length: 20 }, (_, i) => `sentence number ${i}`).join('\n');
    expect(parseSteps(long)).toEqual({ steps: [], format: 'NONE' });
  });
});

// ─── extractBugReport ────────────────────────────────────────────────────────

describe('extractBugReport reads a filled-in issue template', () => {
  const report = extractBugReport(GITHUB_STYLE);

  it('takes the heading as the title rather than the first paragraph under it', () => {
    expect(report.title).toContain('Checkout');
    expect(report.title).toContain('hangs after applying a promo code');
  });

  it('reads the numbered steps', () => {
    expect(report.stepsFormat).toBe('ORDERED');
    expect(report.steps).toHaveLength(4);
    expect(report.steps[3]).toBe('Press Check out');
  });

  it('reads expected and actual into separate fields', () => {
    expect(report.expected).toMatch(/order confirmation page appears/);
    expect(report.actual).toMatch(/spinner never stops/);
  });

  it('reads the URL, the route and the selector out of the prose', () => {
    expect(report.urls).toContain('https://staging.shop.test/cart');
    expect(report.selectors).toContain('#promo-apply');
  });

  it('keeps the stack trace and pulls the error string out of it', () => {
    expect(report.codeBlocks[0]).toContain('applyPromo');
    expect(report.errorStrings.some((e) => e.startsWith('TypeError:'))).toBe(true);
  });

  it('reads the environment', () => {
    expect(report.environment).toMatchObject({
      browser: 'Chrome 141',
      envName: 'staging',
    });
    expect(report.environment.os?.toLowerCase()).toContain('macos');
  });

  it('scores a well-structured report high enough not to need a model', () => {
    expect(report.structureScore).toBeGreaterThan(0.8);
    expect(report.found).toEqual(expect.arrayContaining(['STEPS', 'EXPECTED', 'ACTUAL', 'TITLE']));
  });

  it('never claims a field a model filled in', () => {
    expect(report.enrichedFields).toEqual([]);
  });
});

describe('extractBugReport survives the shapes that are not GitHub markdown', () => {
  it('reads Jira wiki markup, including {code} blocks', () => {
    const report = extractBugReport(
      [
        'h2. Steps',
        '# Open /orders/9931',
        '# Click Refund',
        'h2. Expected',
        'The refund is issued',
        'h2. Actual',
        'A 500 is returned',
        '{code}',
        'HTTP 500 Internal Server Error',
        '{code}',
      ].join('\n'),
    );
    expect(report.expected).toBe('The refund is issued');
    expect(report.actual).toBe('A 500 is returned');
    expect(report.codeBlocks[0]).toContain('Internal Server Error');
  });

  it('reads bold inline labels with the colon inside or outside the emphasis', () => {
    const inside = extractBugReport('**Expected:** the total updates\n**Actual:** it stays at zero');
    expect(inside.expected).toBe('the total updates');
    expect(inside.actual).toBe('it stays at zero');

    const outside = extractBugReport('**Expected**: the total updates\n**Actual**: it stays');
    expect(outside.expected).toBe('the total updates');
  });

  it('finds a numbered list that was never given a heading', () => {
    const report = extractBugReport(
      'Cart is broken.\n\n1. Add a mug\n2. Open /cart\n3. The quantity shows 0',
    );
    expect(report.steps).toHaveLength(3);
    expect(report.stepsFormat).toBe('ORDERED');
  });

  it('does not mistake a bulleted environment list for steps', () => {
    const report = extractBugReport(
      'The cart total is wrong.\n\nEnvironment:\n- Chrome 141\n- macOS 15\n',
    );
    expect(report.steps).toEqual([]);
    expect(report.environment.browser).toBe('Chrome 141');
  });

  /*
   * The regression this parser is shaped around. jest prints `Expected: 200 /
   * Received: 500` inside its output; a section splitter that runs over the
   * fence truncates the reporter's real Expected section and replaces it with a
   * fragment of a diff, and the generated test then asserts on "200".
   */
  it('does not let Expected:/Received: inside a stack trace overwrite the real sections', () => {
    const report = extractBugReport(
      [
        '## Expected',
        'The basket shows three items',
        '## Actual',
        'It shows none',
        '## Logs',
        '```',
        'expect(received).toBe(expected)',
        'Expected: 200',
        'Received: 500',
        '```',
      ].join('\n'),
    );
    expect(report.expected).toBe('The basket shows three items');
    expect(report.actual).toBe('It shows none');
  });

  it('falls back to a fenced Expected/Received pair when the prose has neither', () => {
    const report = extractBugReport(
      'Something is off with the API.\n\n```\nExpected: 201\nReceived: 500\n```',
    );
    expect(report.expected).toBe('201');
    expect(report.actual).toBe('500');
  });

  it('returns an empty report rather than throwing on empty or junk input', () => {
    for (const input of ['', '   \n\n ', ' ']) {
      const report = extractBugReport(input);
      expect(report.steps).toEqual([]);
      expect(report.structureScore).toBeGreaterThanOrEqual(0);
    }
  });

  it('scores an unstructured one-liner below the threshold that asks a model', () => {
    const report = extractBugReport('checkout is broken again, pls fix');
    expect(report.structureScore).toBeLessThan(0.45);
  });

  it('truncates a log dump instead of parsing megabytes of it', () => {
    const started = Date.now();
    const report = extractBugReport(`## Steps\n1. Open /cart\n\n\`\`\`\n${'x'.repeat(500_000)}\n\`\`\``);
    // Truncation cuts the closing fence off, so the block is unterminated. It
    // still has to be treated as a block, or a quarter of a megabyte of log
    // folds into the step above it and becomes the step the generator reads.
    expect(report.steps).toEqual(['Open /cart']);
    expect(report.codeBlocks[0]!.length).toBeLessThanOrEqual(2_000);
    // Not a benchmark — a guard against a pattern that backtracks forever on a
    // pasted log, which is the most common thing to paste into this endpoint.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

// ─── The scanners ────────────────────────────────────────────────────────────

describe('the scanners keep out the things that only look like what they match', () => {
  it('strips sentence punctuation and markdown parentheses off a URL', () => {
    expect(extractUrls('See https://a.test/cart.')).toEqual(['https://a.test/cart']);
    expect(extractUrls('the [cart](https://a.test/cart) page')).toEqual(['https://a.test/cart']);
    expect(extractUrls('https://a.test/x https://a.test/x')).toEqual(['https://a.test/x']);
  });

  it('reads relative routes but not dates or URL path fragments', () => {
    expect(extractPaths('Broken on /checkout and /orders/99')).toEqual(['/checkout', '/orders/99']);
    expect(extractPaths('Happened on 12/03/2026')).toEqual([]);
    expect(extractPaths('at https://a.test/cart')).toEqual([]);
  });

  it('reads selectors and refuses issue references and file names', () => {
    const found = extractSelectors(
      'click `#promo-apply` then .checkout-total, see [data-testid="pay"] — see #1234 and app.js',
    );
    expect(found).toContain('#promo-apply');
    expect(found).toContain('.checkout-total');
    expect(found).toContain('[data-testid="pay"]');
    expect(found).not.toContain('#1234');
    expect(found.some((s) => s === '.js')).toBe(false);
  });

  it('reads Playwright-style locators verbatim', () => {
    expect(extractSelectors("page.locator('#pay') and getByRole('button', { name: 'Pay' })")).toEqual(
      expect.arrayContaining(["getByRole('button', { name: 'Pay' })", "page.locator('#pay')"]),
    );
  });

  it('reads named errors, statuses and the message on screen', () => {
    const found = extractErrorStrings(
      'It shows "Something went wrong" and the API returned 502.\nTypeError: x is not a function',
    );
    expect(found).toContain('Something went wrong');
    expect(found).toContain('TypeError: x is not a function');
    expect(found.some((e) => e.includes('502'))).toBe(true);
  });

  it('mines fenced blocks it is handed as well as the prose', () => {
    const found = extractErrorStrings('see the log', ['ReferenceError: total is not defined']);
    expect(found).toContain('ReferenceError: total is not defined');
  });

  /*
   * Found by running the whole pipeline against the demo store. A report that
   * quoted product names in its steps produced them as "reported errors"; the
   * generated test's own locator then echoed one back inside a Playwright
   * timeout, and a run that failed because A BUTTON WAS MISSING was reported as
   * a confirmed reproduction of the bug. Both halves of that are now closed.
   */
  it('does not harvest a quoted product name as an error', () => {
    expect(
      extractErrorStrings('Add the "Pour-over kettle" to the cart, then the "Ceramic mug"'),
    ).toEqual([]);
  });

  it('does harvest a quoted phrase that something nearby calls a message', () => {
    expect(extractErrorStrings('a toast reads "We could not save that"')).toContain(
      'We could not save that',
    );
    expect(extractErrorStrings('the error "Card declined by issuer" appears')).toContain(
      'Card declined by issuer',
    );
  });

  it('keeps quoted nouns in the steps out of the error list of a whole report', () => {
    const report = extractBugReport(
      [
        '## Steps',
        '1. Add the "Pour-over kettle" to the cart',
        '2. Add the "Ceramic mug" as well',
        '## Actual',
        'The page shows "Order total is wrong"',
      ].join('\n'),
    );
    expect(report.errorStrings).toEqual(['Order total is wrong']);
  });
});

// ─── matchFlowMap ────────────────────────────────────────────────────────────

describe('matchFlowMap starts the test from a route that exists', () => {
  const from = (text: string) => matchFlowMap(extractBugReport(text), SHOP);

  it('matches an exact route', () => {
    const result = from('Broken on /checkout');
    expect(result.startRoute).toBe('/checkout');
    expect(result.matches[0]?.how).toBe('EXACT');
    expect(result.warnings).toEqual([]);
  });

  it('matches a concrete id against a parameterised route', () => {
    const result = from('Broken on https://staging.shop.test/orders/8812');
    expect(result.startRoute).toBe('/orders/:id');
    expect(result.matches[0]?.how).toBe('PARAMETERISED');
  });

  it('collapses ids the crawler never saw', () => {
    expect(collapseIds('/orders/9f31c8a0-1b2c-4d3e-8f90-abcdef012345/items')).toBe(
      '/orders/:id/items',
    );
    expect(collapseIds('/cart')).toBe('/cart');
  });

  it('resolves the feature from the matched node', () => {
    expect(from('Broken on /checkout').feature).toBe('Checkout');
  });

  it('warns when the reporter is describing a different host', () => {
    const result = from('Broken on https://shop.example.com/checkout');
    expect(result.warnings.join(' ')).toMatch(/points at https:\/\/shop\.example\.com/);
    expect(result.matches[0]?.offEnvironment).toBe(true);
    // The route still matches — it is the same app on a different environment.
    expect(result.startRoute).toBe('/checkout');
  });

  it('does not call a trailing-dot host a different origin', () => {
    const result = from('Broken on https://staging.shop.test./checkout');
    expect(result.matches[0]?.offEnvironment).toBe(false);
  });

  it('warns loudly when nothing in the crawl serves the reported route', () => {
    const result = from('Broken on /gift-cards/redeem');
    expect(result.matches[0]?.how).toBe('NONE');
    expect(result.warnings.join(' ')).toMatch(/Nothing in flow map v3 serves/);
    // Still proposes the reporter's own path — refusing to start anywhere is
    // less useful than starting somewhere and saying it was unverified.
    expect(result.startRoute).toBe('/gift-cards/redeem');
  });

  it('surfaces a truncated crawl so a missing route is not blamed on the reporter', () => {
    const truncated = flowMap([node('/cart', 'Your cart')], { truncatedReason: 'page budget' });
    const result = matchFlowMap(extractBugReport('Broken on /checkout'), truncated);
    expect(result.warnings.join(' ')).toMatch(/incomplete \(page budget\)/);
  });

  it('says so when there is no flow map at all rather than pretending', () => {
    const result = matchFlowMap(extractBugReport('Broken on /checkout'), null);
    expect(result.startRoute).toBe('/checkout');
    expect(result.nodeIds).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/Run the Explorer/);
  });
});

// ─── findCoveringTests ──────────────────────────────────────────────────────────

describe('findCoveringTests says "you already have this" — and fails open when unsure', () => {
  const report = extractBugReport(GITHUB_STYLE);
  const match = matchFlowMap(report, SHOP);

  const covering: CoveringTest = {
    id: 't1',
    name: 'Checkout hangs when a promo code is applied',
    filePath: 'tests/checkout/promo.spec.ts',
    feature: 'Checkout',
    code: `await page.goto('/cart');\nawait page.locator('#promo-apply').click();\nawait page.getByRole('button', { name: 'Check out' }).click();`,
    tags: [],
  };

  const unrelated: CoveringTest = {
    id: 't2',
    name: 'Admin can export the payroll CSV',
    filePath: 'tests/admin/payroll.spec.ts',
    feature: 'Admin',
    code: `await page.goto('/admin/payroll');`,
    tags: [],
  };

  it('finds the test that already covers the bug', () => {
    const result = findCoveringTests(report, match, [unrelated, covering]);
    expect(result.duplicateOf?.testId).toBe('t1');
    expect(result.duplicateOf!.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    expect(result.duplicateOf!.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('ranks candidates and never puts an unrelated test on top', () => {
    const result = findCoveringTests(report, match, [unrelated, covering]);
    expect(result.candidates[0]?.testId).toBe('t1');
  });

  it('reports no duplicate when there are no tests', () => {
    expect(findCoveringTests(report, match, []).duplicateOf).toBeNull();
  });

  /*
   * Fail-open, the house rule. Everything below scores something and none of it
   * is evidence, so all of it must resolve to "write the test". A false positive
   * here is a bug that was never reproduced because QAAI said it already had a
   * test for it.
   */
  it('refuses to call one signal a duplicate, however strong', () => {
    const sameRouteOnly: CoveringTest = {
      id: 't3',
      name: 'Zzzz',
      filePath: 'tests/zzzz.spec.ts',
      feature: null,
      code: `await page.goto('/cart');`,
      tags: [],
    };
    const result = findCoveringTests(report, match, [sameRouteOnly]);
    expect(result.candidates[0]?.reasons).toHaveLength(1);
    expect(result.duplicateOf).toBeNull();
  });

  it('finds no duplicate for a report with nothing in it', () => {
    const thin = extractBugReport('it broke');
    const result = findCoveringTests(thin, matchFlowMap(thin, SHOP), [covering, unrelated]);
    expect(result.duplicateOf).toBeNull();
  });

  it('keeps scoring after a test it cannot score', () => {
    const broken = { ...covering, id: 't4', code: null as unknown as string };
    const result = findCoveringTests(report, match, [broken, covering]);
    expect(result.candidates.some((c) => c.testId === 't1')).toBe(true);
  });
});

// ─── buildReproPlanItem ──────────────────────────────────────────────────────

describe('buildReproPlanItem asserts the expected behaviour, never the observed one', () => {
  const plan = (text: string) => {
    const extracted = extractBugReport(text);
    return buildReproPlanItem({
      extracted,
      match: matchFlowMap(extracted, SHOP),
      source: { kind: 'ISSUE', provider: 'GITHUB', key: '412', url: 'https://github.com/a/b/issues/412' },
      id: 'item-1',
    });
  };

  it('produces a plan item the plan schema accepts', () => {
    // The generate path validates against this schema, so a plan item that
    // fails it is a reproduction that silently never becomes a test.
    expect(() => planItemSchema.parse(plan(GITHUB_STYLE).item)).not.toThrow();
    expect(() => planItemSchema.parse(plan('it broke').item)).not.toThrow();
    expect(() => planItemSchema.parse(plan('').item)).not.toThrow();
  });

  /*
   * The property the whole feature turns on. An assertion built from "Actual:"
   * passes against the broken application and proves the opposite of what the
   * reader will assume it proves.
   */
  it('builds the assertion from Expected and quotes Actual only as context', () => {
    const { item } = plan(GITHUB_STYLE);
    const [first] = item.assertions;
    expect(first).toMatch(/order confirmation page appears/);
    expect(first).not.toMatch(/spinner never stops/);
    expect(item.assertions.join(' ')).toMatch(/must FAIL while the bug is live/);
  });

  it('negates the symptom when the report states no expectation, and says it did', () => {
    const { item, notes } = plan('Cart is broken.\n\nActual: the total stays at zero on /cart');
    expect(item.assertions[0]).toMatch(/must NOT/i);
    expect(notes.join(' ')).toMatch(/negation of the reported symptom/);
  });

  it('warns when it had to invent the steps', () => {
    const { item, notes } = plan('checkout is broken again');
    expect(item.steps.length).toBeGreaterThanOrEqual(1);
    expect(notes.join(' ')).toMatch(/no steps to reproduce in any recognised form/);
  });

  it('prepends a navigation step only when the reporter did not write one', () => {
    const withGoto = plan('## Steps\n1. Go to /cart\n2. Click pay');
    expect(withGoto.item.steps[0]).toBe('Go to /cart');

    const without = plan('## Steps\n1. Click pay on /checkout\n2. Watch it hang');
    expect(without.item.steps[0]).toBe('Open /checkout');
  });

  it('carries the flow-map warnings into the notes a human reads', () => {
    const { notes } = plan('Broken on /gift-cards/redeem\n\nExpected: it redeems');
    expect(notes.join(' ')).toMatch(/Nothing in flow map v3 serves/);
  });

  it('raises the priority for a server error or a crash', () => {
    expect(plan('Checkout returns HTTP 500.\n\nExpected: the order confirms').item.priority).toBe(
      'CRITICAL_PATH',
    );
    expect(plan('The app crashes on /cart.\n\nExpected: the cart loads').item.priority).toBe(
      'CRITICAL_PATH',
    );
    expect(plan('The label is misaligned on /cart.\n\nExpected: it lines up').item.priority).toBe(
      'IMPORTANT',
    );
  });

  it('names the source in the rationale so the test is traceable to its ticket', () => {
    expect(plan(GITHUB_STYLE).item.rationale).toMatch(/GITHUB 412/);
  });
});

// ─── mergeEnrichment ─────────────────────────────────────────────────────────

describe('mergeEnrichment lets a model fill gaps and never overwrite the reporter', () => {
  const extracted = extractBugReport('## Steps\n1. Open /cart\n\n## Expected\nThe cart loads');

  it('keeps what the reporter wrote', () => {
    const merged = mergeEnrichment(extracted, {
      title: 'A title the model made up',
      steps: ['Something the model made up'],
      expected: 'Something else the model made up',
      actual: 'It hangs',
      reading: 'why',
    });
    expect(merged.steps).toEqual(['Open /cart']);
    expect(merged.expected).toBe('The cart loads');
    expect(merged.actual).toBe('It hangs');
    expect(merged.enrichedFields).toEqual(['actual']);
  });

  it('records every field it did supply', () => {
    const thin = extractBugReport('checkout broken');
    const merged = mergeEnrichment(thin, {
      title: 'Checkout is broken',
      steps: ['Open /checkout', 'Click Pay'],
      expected: 'The order confirms',
      actual: 'Nothing happens',
      reading: 'why',
    });
    expect(merged.steps).toEqual(['Open /checkout', 'Click Pay']);
    expect(merged.enrichedFields).toEqual(expect.arrayContaining(['steps', 'expected', 'actual']));
  });

  it('passes the extraction through untouched when there was no enrichment', () => {
    expect(mergeEnrichment(extracted, null)).toBe(extracted);
  });
});

// ─── reproVerdict ────────────────────────────────────────────────────────────

describe('reproVerdict — a reproduction that passes has not reproduced anything', () => {
  const extracted = extractBugReport(GITHUB_STYLE);
  const verdict = (status: TestResultStatus | null, errorMessage: string | null = null) =>
    reproVerdict({ status, errorMessage, extracted });

  it('calls a PASSED run NOT_REPRODUCED, in those words', () => {
    const result = verdict('PASSED');
    expect(result.outcome).toBe('NOT_REPRODUCED');
    expect(result.confirmed).toBe(false);
    expect(result.headline).toMatch(/NOT reproduced/);
    expect(result.headline).toMatch(/PASSES/);
  });

  it('confirms a failure that echoes the reported error', () => {
    const result = verdict(
      'FAILED',
      "TypeError: Cannot read properties of undefined (reading 'total')\n  at applyPromo",
    );
    expect(result.outcome).toBe('REPRODUCED');
    expect(result.confirmed).toBe(true);
    expect(result.matchedReportedError).toMatch(/^TypeError:/);
  });

  it('does not confirm a failure that happened for some other reason', () => {
    const result = verdict('FAILED', 'locator.click: Timeout 30000ms exceeded on the login form');
    expect(result.outcome).toBe('REPRODUCED');
    expect(result.confirmed).toBe(false);
    expect(result.detail).toMatch(/broken first step, a missing fixture or a wrong route/);
  });

  /*
   * A total that is wrong by the price of a line names no error text, and that
   * is the most common shape of report there is. Saying "it failed with a
   * different error" there reads as an accusation against a test that is fine.
   */
  it('distinguishes "different error" from "the report quoted no error at all"', () => {
    const numeric = extractBugReport(
      '## Expected\nThe total equals subtotal plus tax\n## Actual\nIt is 45.00 short',
    );
    expect(numeric.errorStrings).toEqual([]);
    const result = reproVerdict({
      status: 'FAILED',
      errorMessage: 'expect(received).toBeCloseTo(expected)\nExpected: 151.72\nReceived: 106.72',
      extracted: numeric,
    });
    expect(result.outcome).toBe('REPRODUCED');
    expect(result.confirmed).toBe(false);
    expect(result.detail).toMatch(/quoted no error text/);
    expect(result.detail).not.toMatch(/broken first step/);
  });

  it('treats a timeout as a failure, not as an inconclusive run', () => {
    expect(verdict('TIMED_OUT').outcome).toBe('REPRODUCED');
  });

  it('refuses to call a flake a reproduction', () => {
    const result = verdict('FLAKY');
    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.confirmed).toBe(false);
  });

  it('reports a test that never executed as inconclusive, with the runner reason', () => {
    const result = verdict('SKIPPED', 'chromium is not installed on this worker');
    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.detail).toMatch(/chromium is not installed/);
  });

  it('reports "not run yet" rather than guessing', () => {
    expect(verdict(null).outcome).toBe('INCONCLUSIVE');
  });

  it('has an answer for every status the runner can produce', () => {
    // A status this does not handle would fall through to a default sentence
    // and quietly stop distinguishing green from red.
    for (const status of TEST_RESULT_STATUSES) {
      const result = verdict(status);
      expect(['REPRODUCED', 'NOT_REPRODUCED', 'INCONCLUSIVE']).toContain(result.outcome);
      expect(result.headline.length).toBeGreaterThan(10);
    }
    expect(
      TEST_RESULT_STATUSES.filter((s) => verdict(s).outcome === 'NOT_REPRODUCED'),
    ).toEqual(['PASSED']);
  });
});

describe('matchReportedError only counts a match that is evidence', () => {
  it('matches a long message as a substring, whitespace and case aside', () => {
    expect(
      matchReportedError('Error:   Cannot Read Properties of undefined', [
        'Cannot read properties of undefined',
      ]),
    ).toBe('Cannot read properties of undefined');
  });

  it('matches a short needle only on a whole-token boundary', () => {
    expect(matchReportedError('server returned HTTP 500', ['HTTP 500'])).toBe('HTTP 500');
    expect(matchReportedError('took 11500ms', ['HTTP 500'])).toBeNull();
  });

  it('is null with no error message and ignores needles too short to mean anything', () => {
    expect(matchReportedError(null, ['HTTP 500'])).toBeNull();
    expect(matchReportedError('anything at all', ['a'])).toBeNull();
  });

  /*
   * The circularity that made a missing button look like a confirmed
   * reproduction. A test generated from a report is built out of that report's
   * words, so its locators contain them — and Playwright prints the locator it
   * was waiting for. Matching against that confirms every timeout.
   */
  it('ignores the part of a Playwright failure that is our own locator', () => {
    const failure = [
      "TimeoutError: locator.click: Timeout 15000ms exceeded.",
      'Call log:',
      "  - waiting for getByRole('button', { name: 'Add Pour-over kettle to cart' })",
    ].join('\n');
    expect(matchReportedError(failure, ['Pour-over kettle'])).toBeNull();
  });

  it('still matches an application error that happens to arrive with a call log', () => {
    const failure = [
      'Error: expect(received).toBe(expected)',
      'The page showed Order total is wrong',
      'Call log:',
      "  - waiting for getByTestId('order-total')",
    ].join('\n');
    expect(matchReportedError(failure, ['Order total is wrong'])).toBe('Order total is wrong');
  });

  it('strips the locator echo and keeps the rest', () => {
    expect(failureText("boom\nCall log:\n - waiting for getByText('x')")).toBe('boom\n');
    expect(failureText("locator.click failed: real reason")).toContain('real reason');
  });
});

// ─── The report the API hands back ───────────────────────────────────────────

describe('the extracted structure is safe to show a user', () => {
  it('caps every list so a pasted log cannot become the response body', () => {
    const many = Array.from({ length: 200 }, (_, i) => `https://a.test/p${i}`).join('\n');
    const report: ExtractedReport = extractBugReport(many);
    expect(report.urls.length).toBeLessThanOrEqual(20);
    expect(report.steps.length).toBeLessThanOrEqual(40);
    for (const step of report.steps) expect(step.length).toBeLessThanOrEqual(300);
  });
});
