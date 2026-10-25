import { describe, expect, it } from 'vitest';
import {
  FORM_FIELD_SEMANTICS,
  capsThatBit,
  discardedByCaps,
  shouldGenerateAgainst,
  type CapBite,
} from '@qaai/shared';
import {
  CRAWL_RESUME_KEY,
  DISCOVERY_SOURCE_FOR_KIND,
  EXTERNAL_KIND_FOR_DISCOVERY,
  deriveJourneys,
  normaliseHashbang,
  normaliseRoute,
  resumeAdvice,
  resumePointFrom,
  crawl,
  crawlApp,
  runCrawl,
  semanticFor,
  withResumePoint,
  type CrawlAdapter,
  type CrawlPage,
} from './crawler';
import type { InteractionSurface, RawControl } from './crawl/interact.js';
import { DISCOVERY_SOURCES } from './crawl/frontier.js';
import { DISCOVERY_KINDS, HARVEST_ELEMENT_SELECTOR } from './crawl/harvest.js';

/**
 * What is and is not covered here, said plainly.
 *
 * `semanticFor` and `normaliseRoute` are pure functions and are tested
 * properly. The in-page constraint extraction (`readConstraints`) is NOT
 * covered: it runs inside `locator.evaluate()` and needs a real browser, so a
 * unit test could only exercise a mock of the DOM and would prove that the mock
 * matches the code rather than that the code reads a page correctly. Naming the
 * gap beats a test that reads as coverage and measures nothing — the attributes
 * it reads are exercised end to end by the demo app's checkout form
 * (apps/demo/src/views.ts), which carries required, inputmode and autocomplete
 * on every field.
 */

describe('semanticFor', () => {
  it('trusts the autocomplete token over any guess from the name', () => {
    // The token vocabulary is specified, so a developer who wrote it has TOLD
    // us what the field is; everything else in the function is inference from a
    // string somebody chose for other reasons.
    expect(semanticFor('f1', 'text', 'Number', 'cc-number')).toBe('credit_card');
    expect(semanticFor('q', 'text', 'Code', 'cc-csc')).toBe('card_cvc');
    expect(semanticFor('x', 'text', 'Line one', 'address-line1')).toBe('street_address');
    expect(semanticFor('x', 'text', 'Town', 'address-level2')).toBe('city');
    expect(semanticFor('whatever', 'text', '', 'email')).toBe('email');
  });

  it('reads the demo checkout form the way that form is actually marked up', () => {
    // Mirrors apps/demo/src/views.ts, which is the one real form in this repo.
    expect(semanticFor('email', 'email', 'Email', 'email')).toBe('email');
    expect(semanticFor('fullName', 'text', 'Full name', 'name')).toBe('person_name');
    expect(semanticFor('address', 'text', 'Street address', 'street-address')).toBe(
      'street_address',
    );
    expect(semanticFor('city', 'text', 'City', 'address-level2')).toBe('city');
    expect(semanticFor('postalCode', 'text', 'Postal code', 'postal-code')).toBe('postal_code');
    expect(semanticFor('cardNumber', 'text', 'Card number', 'cc-number')).toBe('credit_card');
  });

  it('classifies a username, which used to come back as freeform', () => {
    // `\bname\b` does not match inside "username" — no word boundary — so these
    // fell through to the free-text branch and got a sentence typed into them.
    expect(semanticFor('username', 'text', 'Username')).toBe('username');
    expect(semanticFor('user_name', 'text', '')).toBe('username');
    expect(semanticFor('handle', 'text', 'Handle')).toBe('username');
  });

  it('classifies a URL field, which used to come back as unknown', () => {
    expect(semanticFor('website', 'url', 'Website')).toBe('url');
    expect(semanticFor('homepage', 'text', 'Homepage')).toBe('url');
  });

  it('separates money from a plain count', () => {
    expect(semanticFor('price', 'number', 'Price')).toBe('currency');
    expect(semanticFor('subtotal', 'text', 'Subtotal')).toBe('currency');
    // `amount` stays a number, where it has always been: it is as often a count
    // as a sum, and this rule only claims the words that can only mean money.
    expect(semanticFor('amount', 'number', 'Amount')).toBe('number');
    expect(semanticFor('quantity', 'number', 'Quantity')).toBe('number');
  });

  it('keeps every pre-existing classification unchanged', () => {
    // These are the answers this function gave before constraints were added.
    // A regression here would silently reclassify fields in every new crawl.
    expect(semanticFor('email', 'email', '')).toBe('email');
    expect(semanticFor('pw', 'password', '')).toBe('password');
    expect(semanticFor('q', 'search', '')).toBe('search');
    expect(semanticFor('phone', 'tel', '')).toBe('phone');
    expect(semanticFor('cvc', 'text', 'CVC')).toBe('card_cvc');
    expect(semanticFor('expiry', 'text', 'Expiry')).toBe('card_expiry');
    expect(semanticFor('cardNumber', 'text', 'Card number')).toBe('credit_card');
    expect(semanticFor('zip', 'text', '')).toBe('postal_code');
    expect(semanticFor('country', 'text', '')).toBe('country');
    expect(semanticFor('city', 'text', '')).toBe('city');
    expect(semanticFor('street', 'text', '')).toBe('street_address');
    expect(semanticFor('fullName', 'text', 'Full name')).toBe('person_name');
    expect(semanticFor('dob', 'date', '')).toBe('date');
    expect(semanticFor('message', 'textarea', '')).toBe('freeform');
    expect(semanticFor('anything', 'text', '')).toBe('freeform');
    expect(semanticFor('mystery', 'checkbox', '')).toBe('unknown');
  });

  it('only ever returns a name from the shared vocabulary', () => {
    const inputs: Array<[string, string, string, string?]> = [
      ['email', 'email', 'Email'],
      ['x', 'text', ''],
      ['x', 'checkbox', ''],
      ['x', 'text', '', 'nonsense-token'],
      ['', '', ''],
    ];
    for (const [name, type, label, autocomplete] of inputs) {
      expect(FORM_FIELD_SEMANTICS).toContain(semanticFor(name, type, label, autocomplete));
    }
  });

  it('ignores an autocomplete token it does not know', () => {
    expect(semanticFor('email', 'email', 'Email', 'off')).toBe('email');
    expect(semanticFor('q', 'search', '', 'nope')).toBe('search');
  });

  it('reads the first known token in a multi-token autocomplete value', () => {
    expect(semanticFor('x', 'text', '', 'shipping street-address')).toBe('street_address');
    expect(semanticFor('x', 'text', '', 'section-a billing postal-code')).toBe('postal_code');
  });
});

describe('normaliseRoute', () => {
  it.each([
    ['/orders/1001', '/orders/:id'],
    ['/orders/ORD-1001', '/orders/:id'],
    ['/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301', '/users/:id'],
    ['/products', '/products'],
    ['/', '/'],
  ])('collapses %s', (input, expected) => {
    expect(normaliseRoute(input)).toBe(expected);
  });
});

// ─── The orchestration, driven by a fake browser ─────────────────────────────

/**
 * WHAT THESE TESTS ARE FOR.
 *
 * The old `crawl()` took a Playwright `Page` directly, so the admission rules,
 * the dedupe key, the budget arithmetic and the "stopped early" sentence were
 * all unexercised — 629 lines with nine tests, all of them on the two pure
 * helpers above. `runCrawl` takes a `CrawlAdapter`, so a whole application is a
 * literal here and every one of those decisions is reachable.
 *
 * What is still NOT covered, and it is the same honest gap `readConstraints`
 * has always carried: `playwrightCrawlAdapter` itself. Its four `evaluate`
 * scripts and its event mapping need a real Chromium, and a unit test there
 * would prove a mock matches a mock. It is named in the report rather than
 * papered over.
 */

interface FakePageSpec {
  status?: number | null;
  title?: string;
  /** Rendered as `<a href>` elements in the document snapshot. */
  links?: string[];
  headings?: string[];
  rows?: number;
  alerts?: string[];
  /** Where a navigation to this URL actually lands. */
  redirectsTo?: string;
  /** Set to make `goto` report a transport failure instead of a response. */
  failure?: string;
  downloadAnchors?: Array<{ href: string; filename: string | null; label: string | null }>;
}

function fakeAdapter(
  pages: Record<string, FakePageSpec>,
  options: {
    robots?: string | null;
    sitemap?: string | null;
    downloads?: Set<string>;
    interaction?: InteractionSurface | null;
  } = {},
): { adapter: CrawlAdapter; visited: string[] } {
  const visited: string[] = [];
  let current = '';
  const specFor = (url: string): FakePageSpec | undefined =>
    pages[url] ?? pages[url.replace(/\/$/, '')] ?? pages[`${url}/`];

  let emit: ((event: never) => void) | null = null;
  const page: CrawlPage = {
    async goto(url) {
      visited.push(url);
      const spec = specFor(url);
      // Fired DURING the navigation, which is when a real download event
      // arrives — at attach time it would land in `unattributedEvents` and
      // `downloadsInFocus()` would be 0, which is what the recorder's
      // attribution is for.
      if (options.downloads?.has(url) && emit) {
        (emit as (event: unknown) => void)({
          kind: 'download',
          url,
          suggestedFilename: 'export.csv',
        });
      }
      if (spec?.failure !== undefined) {
        current = url;
        return { requestedUrl: url, finalUrl: url, status: null, failure: spec.failure };
      }
      current = spec?.redirectsTo ?? url;
      return {
        requestedUrl: url,
        finalUrl: current,
        /*
         * An EXPLICIT `status: null` is honoured. `spec.status ?? 200` is the
         * same null-became-200 defect the code under test must not have, and a
         * fake that commits it makes the test prove nothing.
         */
        status: spec === undefined ? 404 : 'status' in spec ? spec.status! : 200,
        hops: spec?.redirectsTo ? [url] : [],
        responseHeaders: { 'content-type': 'text/html' },
      };
    },
    currentUrl: () => current,
    async title() {
      return specFor(current)?.title ?? 'untitled';
    },
    async documentSnapshot() {
      const spec = specFor(current);
      return {
        url: current,
        selector: HARVEST_ELEMENT_SELECTOR,
        headers: { 'content-type': 'text/html' },
        elements: (spec?.links ?? []).map((href) => ({
          tag: 'a',
          attrs: { href },
          text: `go ${href}`,
        })),
        forms: [],
      };
    },
    async pageStructure() {
      const spec = specFor(current);
      return {
        title: spec?.title ?? 'untitled',
        ariaBusyCount: 0,
        roleStatusTexts: [],
        roleAlertTexts: spec?.alerts ?? [],
        ariaLiveCount: 0,
        collections:
          spec?.rows === undefined
            ? []
            : [{ selector: 'tbody', rowCount: spec.rows, heading: 'Orders' }],
        skeletonClassCount: 0,
        pristineDisabledSubmitCount: 0,
        formCount: 0,
        linkCount: (spec?.links ?? []).length,
        sameOriginLinkCount: (spec?.links ?? []).length,
        landmarks: ['nav', 'main'],
        headingTexts: spec?.headings ?? ['Home'],
        textSample: '',
        scriptOrigins: [],
      };
    },
    async rawSnapshot() {
      const spec = specFor(current);
      return {
        url: current,
        title: spec?.title ?? 'untitled',
        structure: (spec?.headings ?? ['Home']).map((name) => ({
          role: 'heading',
          name,
          depth: 0,
        })),
        dialogName: null,
        activeMarkers: [],
        statusCode: spec !== undefined && 'status' in spec ? spec.status! : 200,
        isErrorPage: (spec?.alerts ?? []).length > 0,
      };
    },
    async forms() {
      return [];
    },
    async affordances() {
      return [];
    },
    async downloadAnchors() {
      return specFor(current)?.downloadAnchors ?? [];
    },
  };

  const adapter: CrawlAdapter = {
    fetcher:
      options.robots === undefined && options.sitemap === undefined
        ? null
        : {
            async get(url) {
              if (url.endsWith('/robots.txt')) {
                return options.robots === null
                  ? { status: 404, body: null }
                  : { status: 200, body: options.robots ?? '' };
              }
              if (url.includes('sitemap')) {
                return options.sitemap
                  ? { status: 200, body: options.sitemap }
                  : { status: 404, body: null };
              }
              return { status: 404, body: null };
            },
          },
    async open() {
      return {
        pages: [page],
        events: {
          on(listener) {
            emit = listener;
            return () => {
              emit = null;
            };
          },
        },
        observerCapabilities: { NETWORK_EVENTS: true, STRUCTURE_READ: true },
        interaction: options.interaction ?? null,
        variants: {},
        async driveVariant() {
          return { outcome: 'UNAVAILABLE', facts: null, detail: 'the fake drives no variants' };
        },
        async close() {},
      };
    },
  };
  return { adapter, visited };
}

const BASE_OPTIONS = {
  baseUrl: 'https://app.test/',
  projectId: 'proj_1',
  environmentId: 'env_1',
  version: 1,
};

describe('crawl / crawlApp — the shipped signatures', () => {
  /*
   * `crawl()` HAS NO CALLER IN THIS REPO — `explore.ts` calls `crawlApp()` —
   * and it had no test either, so the one thing an unknown external caller
   * depends on was unverified: that it still hands back the FlowMap and not the
   * outcome wrapper it is now implemented on top of. A one-line wrapper is
   * exactly where a return-shape change hides.
   */
  it('still returns the FlowMap alone, for every caller that predates CrawlOutcome', async () => {
    const { adapter } = fakeAdapter({
      'https://app.test/': { title: 'Home', links: ['/orders'] },
      'https://app.test/orders': { title: 'Orders', headings: ['Orders'] },
    });
    const map = await crawl({ ...BASE_OPTIONS, adapter });
    // A FlowMap, not a CrawlOutcome: `map.nodes` and no `map.flowMap`.
    expect(Array.isArray(map.nodes)).toBe(true);
    expect(map.nodes.map((node) => node.route).sort()).toEqual(['/', '/orders']);
    expect('flowMap' in map).toBe(false);
  });

  it('honours a legacy maxPages exactly as before, and NAMES it as an override', async () => {
    // The regression that matters for the three web callers still sending
    // `maxPages: 25, maxDepth: 3`: they must get today's behaviour unchanged,
    // and now get it reported instead of applied as a constant nobody chose.
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/a', '/b', '/c'] },
      'https://app.test/a': {},
      'https://app.test/b': {},
      'https://app.test/c': {},
    });
    const outcome = await crawlApp({ ...BASE_OPTIONS, adapter, maxPages: 2, maxDepth: 3 });
    expect(outcome.flowMap.nodes).toHaveLength(2);
    expect(outcome.budget.limits.pageBudget).toBe(2);
    expect(outcome.budget.policy.overridden).toContain('pageBudget');
    // ...and the two pages are a FLOOR, not the application's size.
    expect(outcome.flowMap.frontier!.atLeastMoreUrls).toBeGreaterThan(0);
    expect(outcome.outcome).toBe('STOPPED');
  });
});

describe('runCrawl — enumeration', () => {
  it('follows a link graph and writes one node per state', async () => {
    const { adapter } = fakeAdapter({
      'https://app.test/': { title: 'Home', links: ['/orders', '/settings'] },
      'https://app.test/orders': { title: 'Orders', rows: 3, headings: ['Orders'] },
      'https://app.test/settings': { title: 'Settings', headings: ['Settings'] },
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    expect(outcome.flowMap.nodes.map((node) => node.route).sort()).toEqual([
      '/',
      '/orders',
      '/settings',
    ]);
    expect(outcome.outcome).toBe('CONVERGED');
    expect(outcome.flowMap.truncatedReason).toBeNull();
  });

  it('enumerates a hash-routed SPA as more than one node — the headline defect', async () => {
    // crawler.ts set `target.hash = ''` BEFORE the dedupe, so /#/orders,
    // /#/orders/1001 and /#/settings were all `/` and a whole class of
    // application reported a denominator of 1 and a coverage of 100%.
    const { adapter } = fakeAdapter({
      'https://app.test/': { title: 'App', links: ['/#/orders', '/#/settings', '/#pricing'] },
      'https://app.test/#/orders': { title: 'Orders', headings: ['Orders'] },
      'https://app.test/#/settings': { title: 'Settings', headings: ['Settings'] },
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    const routes = outcome.flowMap.nodes.map((node) => node.route).sort();
    expect(routes).toContain('/#/orders');
    expect(routes).toContain('/#/settings');
    // ...and the in-page anchor is still the same page, or one page with twelve
    // jump links would become thirteen nodes.
    expect(routes).not.toContain('/#pricing');
  });

  it('keeps the hashbang form, which the frontier rule alone would drop', async () => {
    expect(normaliseHashbang('https://app.test/#!/orders')).toBe('https://app.test/#/orders');
    expect(normaliseHashbang('https://app.test/#pricing')).toBe('https://app.test/#pricing');
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/#!/orders'] },
      'https://app.test/#/orders': { title: 'Orders', headings: ['Orders'] },
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    expect(outcome.flowMap.nodes.map((node) => node.route)).toContain('/#/orders');
  });

  it('records the route that was REQUESTED, not the one it landed on', async () => {
    // The old code stored the node under `page.url()`, so /admin/billing →
    // /login enumerated /login and /admin/billing appeared NOWHERE.
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/admin/billing'] },
      'https://app.test/admin/billing': { redirectsTo: 'https://app.test/login', status: 200 },
      'https://app.test/login': { title: 'Sign in' },
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    const gated = outcome.flowMap.nodes.find((node) => node.route === '/admin/billing');
    expect(gated).toBeDefined();
    expect(gated!.behindAuth).toBe(true);
    expect(gated!.access?.[0]?.outcome).toBe('REDIRECTED');
    expect(gated!.access?.[0]?.basis).toBe('OBSERVED');
    // The destination is offered back, so the sign-in page is a node of its own
    // rather than a place nothing enumerates.
    expect(outcome.flowMap.nodes.map((node) => node.route)).toContain('/login');
  });

  it('keeps an unreadable status NULL, and refuses to generate against it', async () => {
    /*
     * MUTATION M13 FOUND THIS GAP. The 404 test below passed with
     * `code: nav.status ?? 200` in place, because its status is 404 and the
     * `??` never fires. The case that matters is the one where the adapter
     * CANNOT read a status — a same-document SPA transition, or a surface with
     * no NAVIGATION_STATUS capability — and a 200 written there is a happy-path
     * test generated against a page nobody measured.
     */
    const { adapter } = fakeAdapter({
      'https://app.test/': { status: null, title: 'App' },
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    const root = outcome.flowMap.nodes[0]!;
    expect(root.status?.code).toBeNull();
    expect(root.status?.class).toBe('UNKNOWN');
    expect(shouldGenerateAgainst(root)).toBe(false);
  });

  it('sets the status on every node, and never assumes 200', async () => {
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/missing'] },
      'https://app.test/missing': { status: 404, title: 'Not found' },
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    const missing = outcome.flowMap.nodes.find((node) => node.route === '/missing');
    expect(missing?.status?.code).toBe(404);
    expect(missing?.status?.class).toBe('CLIENT_ERROR');
    expect(shouldGenerateAgainst(missing!)).toBe(false);
    expect(outcome.degradationCounts.errorNodeCount).toBe(1);
  });
});

describe('runCrawl — the lies it must not tell', () => {
  it('discloses the page budget as a count AND a reason, and is not CONVERGED', async () => {
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/a', '/b', '/c', '/d'] },
      'https://app.test/a': {},
      'https://app.test/b': {},
      'https://app.test/c': {},
      'https://app.test/d': {},
    });
    const outcome = await runCrawl(adapter, { ...BASE_OPTIONS, maxPages: 2 });
    expect(outcome.outcome).toBe('STOPPED');
    expect(outcome.flowMap.truncatedReason).not.toBeNull();
    // "at least N more existed" is the whole point: a truncated crawl makes the
    // coverage percentage go UP, so the cap has to be a number.
    expect(outcome.flowMap.frontier!.atLeastMoreUrls).toBeGreaterThan(0);
    expect(discardedByCaps(outcome.flowMap.caps ?? [])).toBeGreaterThan(0);
    expect(capsThatBit(outcome.flowMap.caps ?? []).map((bite) => bite.cap)).toContain(
      'PAGE_BUDGET',
    );
  });

  it('is not CONVERGED when the queue emptied but a template budget had bitten', async () => {
    /*
     * MUTATION M5 FOUND THIS GAP. `truncatedReason` was tested only against the
     * page budget, where the scheduler itself reports PAGE_BUDGET — so reading
     * `schedule.stoppedBecause` instead of the enumeration verdict stayed
     * green. This is the case that separates them: the queue EMPTIES (the
     * scheduler says CONVERGED) while a per-template budget was refusing every
     * further `/orders/:id`. Convergence over a surface we trimmed is not
     * convergence, and it is the single most tempting false sentence this
     * feature has available.
     */
    const { adapter } = fakeAdapter({
      'https://app.test/': {
        links: ['/orders/1001', '/orders/1002', '/orders/1003', '/orders/1004'],
      },
      'https://app.test/orders/1001': { title: 'Order' },
      'https://app.test/orders/1002': { title: 'Order' },
      'https://app.test/orders/1003': { title: 'Order' },
      'https://app.test/orders/1004': { title: 'Order' },
    });
    const outcome = await runCrawl(adapter, {
      ...BASE_OPTIONS,
      crawlPolicy: { perTemplatePageBudget: 1 },
    });
    expect(outcome.stoppedBecause).toBe('CONVERGED');
    expect(outcome.outcome).toBe('STOPPED');
    expect(outcome.flowMap.truncatedReason).not.toBeNull();
    expect(capsThatBit(outcome.flowMap.caps ?? []).map((bite) => bite.cap)).toContain(
      'PER_TEMPLATE_BUDGET',
    );
  });

  it('says the lower bound ONCE — the caveat a customer reads is not doubled', async () => {
    /*
     * WIRING MUTATION FOUND THIS. `truncatedReason` was `[schedule.why,
     * verdict.why].join('; ')`, and both sentences render the SAME ledger —
     * `stopSentence` in the frontier already ends with the lower bound and the
     * cap list that `enumerationOutcome` produces. So the one prose field a
     * customer reads said "at least 36 more in-scope URL(s) were known and not
     * visited; caps that applied: …" twice, which reads as two findings about
     * two different numbers. Asserted as a COUNT, because `not.toBeNull()` —
     * which is all that was checked — is green for any amount of repetition.
     */
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/a', '/b', '/c', '/d'] },
      'https://app.test/a': {},
      'https://app.test/b': {},
      'https://app.test/c': {},
      'https://app.test/d': {},
    });
    const outcome = await runCrawl(adapter, { ...BASE_OPTIONS, maxPages: 2 });
    const reason = outcome.flowMap.truncatedReason!;
    expect(reason).toContain('more in-scope');
    expect(reason.split('more in-scope URL(s) were known and not visited')).toHaveLength(2);
    expect(reason.split('caps that applied:')).toHaveLength(2);
  });

  it('feeds a HARVEST cap into the frontier ledger, so it cannot report CONVERGED', async () => {
    /*
     * WIRING MUTATION FOUND THIS GAP. `toCapBites(harvestCaps)` →
     * `frontier.noteCap` had no test: every cap the suite exercised was one the
     * FRONTIER itself owns (the page budget, the per-template budget), so
     * deleting the line that carries harvest's own bites into the ledger left
     * all 59 tests green. The consequence is rule 9's worst case — a crawl
     * whose links-per-document cap discarded surface, reporting CONVERGED,
     * which makes the coverage percentage go UP for having looked at less.
     *
     * `linksPerPage: 2` against a page of five links is the cheapest harvest
     * bite there is.
     */
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/a', '/b', '/c', '/d', '/e'] },
      'https://app.test/a': {},
      'https://app.test/b': {},
    });
    const outcome = await runCrawl(adapter, {
      ...BASE_OPTIONS,
      limitOverrides: { linksPerPage: 2 },
    });
    // The queue empties — there is nothing left to visit — and that is NOT
    // convergence, because a cap decided what reached the queue.
    expect(outcome.stoppedBecause).toBe('CONVERGED');
    expect(outcome.outcome).toBe('STOPPED');
    expect(outcome.flowMap.truncatedReason).not.toBeNull();
    expect(capsThatBit(outcome.flowMap.caps ?? []).map((bite) => bite.cap)).toContain(
      'LINKS_PER_PAGE',
    );
    expect(discardedByCaps(outcome.flowMap.caps ?? [])).toBeGreaterThan(0);
  });

  it('feeds the JOURNEY limit into the frontier ledger, not just into its callback', async () => {
    /*
     * WIRING MUTATION FOUND THIS GAP TOO, and it is the same shape as the one
     * above. `deriveJourneys` is tested directly with a fake callback, so the
     * bite is proved to be EMITTED — and nothing proved it is RECEIVED. The
     * callback `runCrawl` passes is `frontier.noteCap`, and replacing it with
     * `() => {}` left all 59 green: a crawl that refused to emit paths would
     * then report CONVERGED, with the discarded count nowhere.
     */
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/a', '/b', '/c', '/d'] },
      'https://app.test/a': {},
      'https://app.test/b': {},
      'https://app.test/c': {},
      'https://app.test/d': {},
    });
    const outcome = await runCrawl(adapter, {
      ...BASE_OPTIONS,
      limitOverrides: { journeyLimit: 1 },
    });
    expect(outcome.flowMap.journeys).toHaveLength(1);
    expect(capsThatBit(outcome.flowMap.caps ?? []).map((bite) => bite.cap)).toContain(
      'JOURNEY_LIMIT',
    );
    expect(outcome.outcome).toBe('STOPPED');
    expect(outcome.flowMap.truncatedReason).not.toBeNull();
  });

  it("reports a caller's hard-coded cap as a policy override rather than a fact", async () => {
    const { adapter } = fakeAdapter({ 'https://app.test/': {} });
    const outcome = await runCrawl(adapter, { ...BASE_OPTIONS, maxPages: 25, maxDepth: 3 });
    expect(outcome.budget.policy.overridden).toContain('pageBudget');
    expect(outcome.budget.policy.overridden).toContain('maxDepth');
    expect(outcome.flowMap.policyApplied?.policy.pageBudget).toBe(25);
  });

  it('uses the environment policy, not 25/3, when the caller names no cap', async () => {
    const { adapter } = fakeAdapter({ 'https://app.test/': {} });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    // The default is 1,000 pages and depth 12, which is the slice: a 412-route
    // application cannot enumerate as 60 and report a percentage over a seventh
    // of itself.
    expect(outcome.budget.limits.pageBudget).toBeGreaterThan(60);
    expect(outcome.budget.policy.defaulted).toBe(true);
  });

  it('clamps to the plan ceiling and says so with both numbers', async () => {
    const { adapter } = fakeAdapter({ 'https://app.test/': {} });
    const outcome = await runCrawl(adapter, { ...BASE_OPTIONS, plan: 'FREE' });
    expect(outcome.budget.clamped.some((clamp) => clamp.field === 'pageBudget')).toBe(true);
    expect(outcome.caveats.some((line) => line.includes('FREE'))).toBe(true);
  });

  it('refuses a logout link by NAME, with the rule that refused it', async () => {
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/logout', '/orders'] },
      'https://app.test/orders': {},
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    const refusal = outcome.flowMap.excluded!.find((row) => row.url.includes('/logout'));
    expect(refusal).toBeDefined();
    expect(refusal!.rule).not.toBe('');
    expect(refusal!.kind).toBe('POLICY_EXCLUDE');
    // A refused surface and a surface that does not exist must never be
    // recorded the same way, and a refusal is NOT part of "more existed".
    expect(outcome.flowMap.nodes.map((node) => node.route)).not.toContain('/logout');
    expect(outcome.flowMap.frontier!.excluded).toBeGreaterThan(0);
  });

  it('records an off-origin link as a boundary with no query string', async () => {
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['https://idp.example.com/authorize?state=SECRET-TOKEN'] },
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    expect(outcome.flowMap.externals!.some((row) => row.origin === 'https://idp.example.com')).toBe(
      true,
    );
    expect(JSON.stringify(outcome.flowMap.externals)).not.toContain('SECRET-TOKEN');
    expect(outcome.flowMap.frontier!.offOrigin).toBeGreaterThan(0);
  });

  it('counts a URL that is a FILE as a document, never as unreachable', async () => {
    // crawler.ts's single `catch { could not load; continue }` swallowed every
    // CSV, PDF and XLSX export in the application.
    const { adapter } = fakeAdapter(
      {
        'https://app.test/': { links: ['/exports/orders.csv'] },
        'https://app.test/exports/orders.csv': { failure: 'net::ERR_ABORTED' },
      },
      { downloads: new Set(['https://app.test/exports/orders.csv']) },
    );
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    expect(outcome.degradationCounts.loadFailureCount).toBe(0);
    expect(outcome.flowMap.frontier!.unreachable).toBe(0);
    expect(outcome.caveats.some((line) => line.includes('files rather than pages'))).toBe(true);
  });

  it('treats a navigation that threw as unreachable, not as a missing page', async () => {
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/broken'] },
      'https://app.test/broken': { failure: 'net::ERR_NAME_NOT_RESOLVED' },
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    expect(outcome.degradationCounts.loadFailureCount).toBe(1);
    // Unreachable is NOT part of the lower bound: unknown-not-absent, and
    // claiming it would invent a number in the alarming direction.
    expect(outcome.flowMap.frontier!.unreachable).toBe(1);
    expect(outcome.flowMap.frontier!.atLeastMoreUrls).toBe(0);
  });

  it('names the surface it could not look at, instead of reporting a zero', async () => {
    const { adapter } = fakeAdapter({ 'https://app.test/': {} });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    expect(outcome.caveats.some((line) => line.includes('behind a button'))).toBe(true);
    expect(outcome.caveats.some((line) => line.includes('robots.txt'))).toBe(true);
  });

  it('holds a one-node crawl with no application chrome as a candidate', async () => {
    // A bot wall answers 200 with one page, no links, no form and no landmark.
    // `adjudicateCrawl` alone returns ACCEPTED and the wall becomes the
    // denominator; the interstitial classifier is the only thing that stops it.
    const { adapter } = fakeAdapter({ 'https://app.test/': { title: 'Just a moment...' } });
    const bare = await runCrawl(adapter, BASE_OPTIONS);
    // The fake reports two landmarks, so this crawl is NOT blocked — which is
    // the point: the signal is structural and a page with chrome is a page.
    expect(bare.interstitial).not.toBeNull();
    expect(bare.interstitial!.blocksEnumeration).toBe(false);
  });
});

describe('runCrawl — the persisted frontier', () => {
  it('writes a snapshot a later crawl can continue', async () => {
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/a', '/b', '/c'] },
      'https://app.test/a': {},
      'https://app.test/b': {},
      'https://app.test/c': {},
    });
    const first = await runCrawl(adapter, { ...BASE_OPTIONS, maxPages: 2 });
    const advice = resumeAdvice(first.snapshot);
    expect(advice.resumable).toBe(true);
    expect(advice.pending).toBeGreaterThan(0);

    // THE REGISTER ITEM: today every crawl writes a new version that REPLACES
    // the last, so an application over the cap can never be fully enumerated
    // however often it runs. Continuing is what fixes that.
    const second = await runCrawl(adapter, {
      ...BASE_OPTIONS,
      version: 2,
      maxPages: 10,
      resumeFrom: first.snapshot,
    });
    const firstRoutes = new Set(first.flowMap.nodes.map((node) => node.route));
    const secondRoutes = second.flowMap.nodes.map((node) => node.route);
    expect(secondRoutes.some((route) => !firstRoutes.has(route))).toBe(true);
    // ...and it does not re-visit what the first run already saw.
    expect(secondRoutes).not.toContain('/');
  });

  it('round-trips through the stored graph, and refuses a shape it does not know', async () => {
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/a'] },
      'https://app.test/a': {},
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    const stored = JSON.parse(JSON.stringify(withResumePoint(outcome.flowMap, outcome.snapshot)));
    expect(resumePointFrom(stored)).toEqual(outcome.snapshot);
    // Every flow map already on disk has none, and that must read as "this
    // crawl did not record one" rather than as an empty queue.
    expect(resumePointFrom(outcome.flowMap)).toBeNull();
    /*
     * MUTATION M10 FOUND THIS GAP. `{ snapshotVersion: 9 }` alone was rejected
     * by the `baseUrl` check further down, so weakening the version gate left
     * the test green. A snapshot written by a NEWER build is otherwise
     * well-formed — that is the whole hazard — so the fixture has to be the
     * real one with only its version changed.
     */
    expect(
      resumePointFrom({ [CRAWL_RESUME_KEY]: { ...outcome.snapshot, snapshotVersion: 9 } }),
    ).toBeNull();
    expect(resumePointFrom({ [CRAWL_RESUME_KEY]: { snapshotVersion: 9 } })).toBeNull();
    expect(resumeAdvice(null).resumable).toBe(false);
  });
});

describe('runCrawl — seeding and the vocabularies', () => {
  it('seeds from the sitemap, which is the cheapest complete route list there is', async () => {
    const { adapter } = fakeAdapter(
      {
        'https://app.test/': { title: 'Home' },
        'https://app.test/deep/page': { title: 'Deep' },
      },
      {
        robots: 'Sitemap: https://app.test/sitemap.xml\n',
        sitemap:
          '<urlset><url><loc>https://app.test/deep/page</loc></url>' +
          '<url><loc>https://app.test/</loc></url></urlset>',
      },
    );
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    // Nothing links to /deep/page; only the sitemap knows it exists.
    expect(outcome.flowMap.nodes.map((node) => node.route)).toContain('/deep/page');
    expect(outcome.sitemap?.declared).toBe(2);
  });

  it('names every discovery kind in both mapping records', () => {
    // `satisfies` catches a MISSING key; only a run-time comparison catches a
    // stale one. The eight gate kinds no customer could save for two slices
    // were invisible for want of exactly this.
    expect(Object.keys(DISCOVERY_SOURCE_FOR_KIND).sort()).toEqual([...DISCOVERY_KINDS].sort());
    expect(Object.keys(EXTERNAL_KIND_FOR_DISCOVERY).sort()).toEqual([...DISCOVERY_KINDS].sort());
    for (const source of Object.values(DISCOVERY_SOURCE_FOR_KIND)) {
      expect(DISCOVERY_SOURCES).toContain(source);
    }
  });

  it('discloses the journey limit instead of dropping paths silently', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => ({
      id: `node-${index}`,
      route: `/r${index}`,
      url: `https://app.test/r${index}`,
      title: `R${index}`,
      stateKey: 'x',
      requiresRoles: [],
      behindAuth: false,
      forms: [],
      affordances: [],
      screenshotKey: null,
      a11yViolationCount: 0,
    }));
    // A star: node-0 links to five leaves, so there are five complete paths.
    const edges = nodes.slice(1).map((node, index) => ({
      id: `edge-${index}`,
      from: 'node-0',
      to: node.id,
      action: 'open',
      selector: null,
    }));
    const bites: CapBite[] = [];
    const journeys = deriveJourneys(nodes, edges, 2, (bite) => bites.push(bite));
    expect(journeys).toHaveLength(2);
    expect(bites).toHaveLength(1);
    expect(bites[0]!.cap).toBe('JOURNEY_LIMIT');
    expect(bites[0]!.discarded).toBe(3);
    expect(bites[0]!.reason).toContain('at least');
  });
});

/**
 * A surface with ONE button that opens a panel, so there is exactly one state
 * behind a click and nothing else to find.
 *
 * It exists because the fake adapter above reported `interaction: null` for
 * every test in this file, which meant `exploreInteractions` was never called
 * at all: deleting the whole interaction pass from `runCrawl` left every test
 * green. That is the shape of defect this suite was written to stop — a module
 * whose CONNECTION has no test is a module the next refactor deletes.
 *
 * `snapshot()` for `/` is byte-identical to what the URL pass's `rawSnapshot`
 * returns for `/` (the same single `Home` heading, the same 200, no dialog), on
 * purpose: that is what makes the structural digests agree, which is the whole
 * precondition for the two passes sharing one node-id space.
 */
function fakeInteractionSurface(): InteractionSurface {
  let url = 'https://app.test/';
  let panelOpen = false;
  const button = {
    ref: 'ref-1',
    tag: 'button',
    type: 'button',
    role: null,
    rel: null,
    text: 'Open filters',
    ariaLabel: null,
    title: null,
    testId: null,
    placeholder: null,
    label: null,
    name: null,
  } as unknown as RawControl;
  const structureFor = (): Array<{ role: string; name: string; depth: number }> =>
    panelOpen
      ? [
          { role: 'heading', name: 'Home', depth: 0 },
          { role: 'heading', name: 'Filters', depth: 1 },
        ]
      : [{ role: 'heading', name: 'Home', depth: 0 }];
  return {
    capabilities: () => ['CLICK', 'GOTO', 'SNAPSHOT', 'CONTROLS', 'BACK'] as never,
    url: () => url,
    async goto(next) {
      url = next;
      panelOpen = false;
      return { ok: true, url: next, status: 200, error: null };
    },
    async back() {
      panelOpen = false;
      return { ok: true, url, status: 200, error: null };
    },
    async snapshot() {
      return {
        url,
        title: 'Home',
        structure: structureFor(),
        dialogName: null,
        activeMarkers: [],
        statusCode: 200,
        isErrorPage: false,
      };
    },
    async controls() {
      return panelOpen ? [] : [button];
    },
    async click(ref) {
      if (ref === button.ref) panelOpen = true;
      return { ok: true, error: null, navigated: false, status: null };
    },
    async fill() {
      return true;
    },
    async drainNavigations() {
      return [];
    },
  };
}

describe('runCrawl — the interaction pass, at the seam', () => {
  it('enumerates a state behind a button that the URL crawl cannot reach', async () => {
    // The headline reason the interaction module exists: `a[href]` cannot see
    // a panel, a tab or a wizard step, so an application whose whole surface is
    // behind buttons enumerated as one node and reported 100%.
    const home = { 'https://app.test/': { title: 'Home', headings: ['Home'] } };
    const without = await runCrawl(fakeAdapter(home).adapter, BASE_OPTIONS);
    const with_ = await runCrawl(
      fakeAdapter(home, { interaction: fakeInteractionSurface() }).adapter,
      BASE_OPTIONS,
    );
    expect(without.flowMap.nodes).toHaveLength(1);
    expect(with_.flowMap.nodes).toHaveLength(2);
    // ...and it is REACHABLE: the edge is the click, which is the artefact the
    // Generator needs in order to write a test that gets to the state.
    expect(with_.flowMap.edges.map((edge) => edge.action)).toContain('click "Open filters"');
  });

  it('shares ONE node-id space with the URL pass, so a state is not counted twice', async () => {
    /*
     * `nodeIdFor` hands the interaction pass `seenStates.get(route#digest)`,
     * which is the SAME key the URL pass stores its states under. Without it
     * the interaction pass re-reports `/` — a state the URL crawl already
     * enumerated — as a node of its own, and the denominator grows by one for
     * every page the two passes both reached.
     *
     * Asserted as "exactly one node for `/` whose state key the URL pass
     * minted", because a node COUNT alone is satisfied by two wrong graphs.
     */
    const home = { 'https://app.test/': { title: 'Home', headings: ['Home'] } };
    const baseline = await runCrawl(fakeAdapter(home).adapter, BASE_OPTIONS);
    const urlPassStateKey = baseline.flowMap.nodes[0]!.stateKey;

    const outcome = await runCrawl(
      fakeAdapter(home, { interaction: fakeInteractionSurface() }).adapter,
      BASE_OPTIONS,
    );
    const sharedState = outcome.flowMap.nodes.filter((node) => node.stateKey === urlPassStateKey);
    expect(sharedState).toHaveLength(1);
    expect(sharedState[0]!.id).toBe('node-0');
    // The new state is APPENDED after the URL nodes, not interleaved: ids are
    // assigned in the schedule's order and a shift re-writes the version diff.
    expect(outcome.flowMap.nodes.map((node) => node.id)).toEqual(['node-0', 'node-1']);
  });

  it('discloses an interaction pass that stopped with states still to expand', async () => {
    /*
     * The interaction pass has its own budget and `maxStates` defaults to the
     * policy's `pageBudget`, so a tight budget leaves the panel state
     * UNEXPANDED. That is surface we know about and did not reach — the
     * known-unknown this slice exists to report — and if the pass's own
     * sentence were dropped the only trace would be a node that is not there.
     *
     * NOT asserted as a named cap, because it is not one: `CRAWL_CAPS` has no
     * INTERACTION_BUDGET member, so the bite can only be prose today. That is
     * the gap, and it is in the report rather than papered over here.
     */
    const outcome = await runCrawl(
      fakeAdapter(
        { 'https://app.test/': { title: 'Home', headings: ['Home'] } },
        { interaction: fakeInteractionSurface() },
      ).adapter,
      { ...BASE_OPTIONS, crawlPolicy: { pageBudget: 1 } },
    );
    // The panel state was NOT reached, and the report says why rather than
    // reading as an application with nothing behind its buttons.
    expect(outcome.flowMap.nodes).toHaveLength(1);
    expect(outcome.caveats.join(' ')).toContain('state(s) still to expand');
    expect(outcome.outcome).toBe('STOPPED');
  });

  it('says so when the adapter has no interaction surface, instead of reporting zero', async () => {
    // "No states behind a button" and "we did not look behind any button" are
    // different facts and the report must not render them the same way.
    const outcome = await runCrawl(
      fakeAdapter({ 'https://app.test/': { title: 'Home' } }).adapter,
      BASE_OPTIONS,
    );
    expect(outcome.caveats.join(' ')).toContain('has no interaction surface');
    const driven = await runCrawl(
      fakeAdapter(
        { 'https://app.test/': { title: 'Home', headings: ['Home'] } },
        { interaction: fakeInteractionSurface() },
      ).adapter,
      BASE_OPTIONS,
    );
    expect(driven.caveats.join(' ')).not.toContain('has no interaction surface');
    // The budget invariant is ASSERTED rather than trusted: every interaction
    // budget bite must have fed the frontier, or the pass's convergence claim
    // is an inflated one. A violation is a caveat, so its absence is the proof.
    expect(driven.caveats.join(' ')).not.toContain('budget bite its frontier does not account');
  });
});

describe('runCrawl — the route mode', () => {
  it('detects the route mode from the SAMPLE and carries it out', async () => {
    /*
     * It must be CARRIED OUT, not just computed. A re-crawl that decides a
     * different mode re-keys every state, every node id shifts, and the
     * version-to-version diff shows the whole graph as rewritten when nothing
     * about the application changed. I wrote this as a single assignment after
     * the schedule first and it was DEAD CODE — the mode was detected and
     * discarded, so every state signature was keyed as UNDETERMINED.
     */
    const { adapter } = fakeAdapter({
      'https://app.test/': { links: ['/#/orders', '/#/customers'] },
      'https://app.test/#/orders': { title: 'Orders', headings: ['Orders'] },
      'https://app.test/#/customers': { title: 'Customers', headings: ['Customers'] },
    });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    expect(outcome.routeMode).toBe('HASH');
    expect(outcome.routeModeWhy).not.toBe('');
  });

  it('refuses to decide from one URL, and says UNDETERMINED', async () => {
    // UNDETERMINED is a real answer: one `/orders` says nothing about whether
    // `#/` is used elsewhere, and a guess is unfalsifiable in both directions.
    const { adapter } = fakeAdapter({ 'https://app.test/': { title: 'Home' } });
    const outcome = await runCrawl(adapter, BASE_OPTIONS);
    expect(outcome.routeMode).toBe('UNDETERMINED');
  });
});
