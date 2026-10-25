/**
 * Tests for the harvest — everything that widens the frontier without clicking.
 *
 * No browser appears below, which is the point: `harvest.ts` takes its DOM as a
 * {@link DocumentSnapshot} and its network as a one-method fetcher, so every
 * behaviour is driven by a literal. What is asserted here, in rough order of
 * how much it would cost to get wrong:
 *
 *   1. **No cap bites in silence, and no refusal lands with no rule.** Two
 *      property tests walk the whole output of a hostile fixture and assert it
 *      over every discovery rather than field by field, so a future discovery
 *      kind that forgets to carry a rule fails without anyone remembering to
 *      extend the test. A silently truncated harvest makes the coverage
 *      percentage go UP, which is the one direction this product may not be
 *      wrong in.
 *   2. **Unreadable is never zero.** A closed shadow root, a snapshot with no
 *      response headers, a narrower-than-canonical selector and a gzip sitemap
 *      each report UNAVAILABLE with `found: null`. The regression they guard
 *      against is "this page has no pagination links", said about a page nobody
 *      asked.
 *   3. **An asset is not a route.** `srcset`, `script[src]` and
 *      `rel=stylesheet` stay out of the navigable set. A denominator padded
 *      with hashed bundle filenames moves on every build for no reason a
 *      customer can see.
 *   4. **A hash route is a route.** The crawler's `target.hash = ''` is what
 *      makes a hash-routed SPA enumerate as one node, so the keep/drop decision
 *      gets its own block.
 *   5. **Someone else's site is not ours.** The registrable-domain table, the
 *      `evil-example.com` suffix trap, and the private-suffix case where two
 *      unrelated preview deployments would read as one application.
 *   6. **Nothing sensitive survives the boundary inventory.** A redirect to an
 *      identity provider carries a state token, a login hint and a tenant in
 *      its query string; the headline test serialises the ENTIRE inventory and
 *      asserts that none of those strings appears anywhere in it.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_POLICY, type CrawlPolicy } from '@qaai/shared';
import {
  AXIS_SELECTORS,
  DISCOVERY_AS_EXTERNAL_KIND,
  DISCOVERY_KINDS,
  DISCOVERY_KIND_LABELS,
  EMPTY_ROBOTS,
  HARVEST_AXES,
  HARVEST_AXIS_LABELS,
  HARVEST_CAPS,
  HARVEST_CAP_AS_CRAWL_CAP,
  HARVEST_CAP_LABELS,
  HARVEST_ELEMENT_SELECTOR,
  HARVEST_HASH_MODES,
  NAVIGABILITY,
  SITEMAP_KINDS,
  SITEMAP_UNAVAILABILITIES,
  SITEMAP_UNAVAILABILITY_LABELS,
  SUB_DOCUMENT_KINDS,
  SUB_DOCUMENT_UNAVAILABILITIES,
  SUB_DOCUMENT_UNAVAILABILITY_LABELS,
  URL_SCOPES,
  URL_SCOPE_LABELS,
  axisIsConsistent,
  resolveDiscoveredUrl,
  classifyScope,
  dedupeDiscoveries,
  fragmentIsRoute,
  harvestDocument,
  mergeBoundaries,
  navigableDiscoveries,
  navigabilityOf,
  parseLinkHeader,
  parseMetaRefresh,
  parseRobots,
  parseSitemap,
  parseSrcset,
  registrableDomain,
  robotsDecision,
  robotsMatches,
  seedFromRobotsAndSitemaps,
  sitemapReachability,
  sitemapStaleness,
  subDocumentCoverage,
  toCapBites,
  toExcludedPaths,
  unreadAppSubDocuments,
  type BoundaryObservation,
  type Discovery,
  type DocumentSnapshot,
  type ElementRecord,
  type FetchedText,
  type HarvestCapBite,
  type HarvestFetcher,
  type HarvestOptions,
} from './harvest.js';

const BASE = 'https://app.example.com';

const POLICY: CrawlPolicy = { ...DEFAULT_CRAWL_POLICY };

function policy(overrides: Partial<CrawlPolicy> = {}): CrawlPolicy {
  return { ...DEFAULT_CRAWL_POLICY, ...overrides };
}

function options(overrides: Partial<HarvestOptions> = {}): HarvestOptions {
  return { baseUrl: BASE, policy: POLICY, ...overrides };
}

function element(tag: string, attrs: Record<string, string>, text?: string): ElementRecord {
  return text === undefined ? { tag, attrs } : { tag, attrs, text };
}

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    url: `${BASE}/orders`,
    elements: [],
    forms: [],
    headers: {},
    appRoot: '#root',
    subDocuments: [],
    ...overrides,
  };
}

/** A fetcher backed by a map, so the seed is driven without a socket. */
function fetcherFor(responses: Record<string, Partial<FetchedText>>): HarvestFetcher & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string): Promise<FetchedText> {
      calls.push(url);
      const hit = responses[url];
      if (hit === undefined) return { status: 404, body: null };
      return { status: 200, body: null, ...hit };
    },
  };
}

// ─── Vocabulary parity ───────────────────────────────────────────────────────

/**
 * The keystone pattern from `packages/shared/src/surface.ts`, applied to this
 * module's six vocabularies: a compiler-enforced presence record AND a run-time
 * parity check.
 *
 * THE DEFECT THIS PREVENTS is the one that cost two slices: a union member that
 * exists in the list and in nothing else. `satisfies Record<K, V>` catches a
 * MISSING key at the compiler; only a run-time comparison catches a key that
 * stayed in the record after its member left the list, and a stale key is how a
 * label survives the thing it labels.
 */
describe('the vocabularies and their records agree', () => {
  const pairs: Array<[string, readonly string[], Record<string, unknown>]> = [
    ['DISCOVERY_KIND_LABELS', DISCOVERY_KINDS, DISCOVERY_KIND_LABELS],
    ['NAVIGABILITY', DISCOVERY_KINDS, NAVIGABILITY],
    ['DISCOVERY_AS_EXTERNAL_KIND', DISCOVERY_KINDS, DISCOVERY_AS_EXTERNAL_KIND],
    ['URL_SCOPE_LABELS', URL_SCOPES, URL_SCOPE_LABELS],
    ['HARVEST_CAP_LABELS', HARVEST_CAPS, HARVEST_CAP_LABELS],
    ['HARVEST_CAP_AS_CRAWL_CAP', HARVEST_CAPS, HARVEST_CAP_AS_CRAWL_CAP],
    ['HARVEST_AXIS_LABELS', HARVEST_AXES, HARVEST_AXIS_LABELS],
    ['AXIS_SELECTORS', HARVEST_AXES, AXIS_SELECTORS],
    [
      'SUB_DOCUMENT_UNAVAILABILITY_LABELS',
      SUB_DOCUMENT_UNAVAILABILITIES,
      SUB_DOCUMENT_UNAVAILABILITY_LABELS,
    ],
    ['SITEMAP_UNAVAILABILITY_LABELS', SITEMAP_UNAVAILABILITIES, SITEMAP_UNAVAILABILITY_LABELS],
  ];

  for (const [name, members, record] of pairs) {
    it(`${name} has exactly one entry per member, and no stale ones`, () => {
      expect([...Object.keys(record)].sort()).toEqual([...members].sort());
    });
  }

  it('every element-derived axis names a selector the canonical selector contains', () => {
    for (const axis of HARVEST_AXES) {
      const fragment = AXIS_SELECTORS[axis];
      if (fragment === null) continue;
      expect(HARVEST_ELEMENT_SELECTOR).toContain(fragment);
    }
  });

  it('the small enums are non-empty and unique', () => {
    for (const list of [
      DISCOVERY_KINDS,
      URL_SCOPES,
      HARVEST_CAPS,
      HARVEST_AXES,
      HARVEST_HASH_MODES,
      SUB_DOCUMENT_KINDS,
      SUB_DOCUMENT_UNAVAILABILITIES,
      SITEMAP_KINDS,
      SITEMAP_UNAVAILABILITIES,
    ]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

// ─── URL identity ────────────────────────────────────────────────────────────

describe('resolveDiscoveredUrl', () => {
  it('strips the policy’s ignored query parameters and names which it stripped', () => {
    const result = resolveDiscoveredUrl(
      '/orders?utm_source=newsletter&page=2&gclid=abc',
      BASE,
      POLICY,
    );
    expect(result?.url).toBe(`${BASE}/orders?page=2`);
    expect(result?.strippedParams.sort()).toEqual(['gclid', 'utm_source']);
  });

  it('sorts the identity but leaves the navigable URL in document order', () => {
    const left = resolveDiscoveredUrl('/search?b=2&a=1', BASE, POLICY);
    const right = resolveDiscoveredUrl('/search?a=1&b=2', BASE, POLICY);
    expect(left?.identity).toBe(right?.identity);
    // The URL is what we navigate to, and it is NOT reordered: a crawl that
    // reorders parameters visits something the application never linked.
    expect(left?.url).toBe(`${BASE}/search?b=2&a=1`);
    expect(right?.url).toBe(`${BASE}/search?a=1&b=2`);
  });

  it('gives repeated keys a stable identity whatever order they arrive in', () => {
    const left = resolveDiscoveredUrl('/f?tag=b&tag=a', BASE, POLICY);
    const right = resolveDiscoveredUrl('/f?tag=a&tag=b', BASE, POLICY);
    expect(left?.identity).toBe(right?.identity);
  });

  it('KEEPS a hash route, which is what stops an SPA enumerating as one node', () => {
    const orders = resolveDiscoveredUrl('#/orders', `${BASE}/`, POLICY);
    const settings = resolveDiscoveredUrl('#/settings', `${BASE}/`, POLICY);
    expect(orders?.url).toBe(`${BASE}/#/orders`);
    expect(orders?.identity).not.toBe(settings?.identity);
    expect(orders?.routeFragment).toBe('#/orders');
    expect(orders?.droppedFragment).toBeNull();
  });

  it('keeps the old #!/ form too', () => {
    expect(resolveDiscoveredUrl('#!/orders', `${BASE}/`, POLICY)?.routeFragment).toBe('#!/orders');
  });

  it('DROPS a plain anchor fragment, and records that it dropped one', () => {
    const result = resolveDiscoveredUrl('/guide#installation', BASE, POLICY);
    expect(result?.url).toBe(`${BASE}/guide`);
    expect(result?.routeFragment).toBeNull();
    expect(result?.droppedFragment).toBe('#installation');
  });

  it('honours hashRouting IGNORE and ROUTE', () => {
    expect(
      resolveDiscoveredUrl('#/orders', `${BASE}/`, POLICY, { hashRouting: 'IGNORE' })
        ?.routeFragment,
    ).toBeNull();
    expect(
      resolveDiscoveredUrl('#top', `${BASE}/`, POLICY, { hashRouting: 'ROUTE' })?.routeFragment,
    ).toBe('#top');
  });

  it('returns null rather than a guess for a value that does not resolve', () => {
    expect(resolveDiscoveredUrl('', BASE, POLICY)).toBeNull();
    expect(resolveDiscoveredUrl('   ', BASE, POLICY)).toBeNull();
    expect(resolveDiscoveredUrl('http://[', BASE, POLICY)).toBeNull();
  });

  it('keeps path case and normalises the host and default port', () => {
    const result = resolveDiscoveredUrl('https://APP.Example.COM:443/Orders/Detail', BASE, POLICY);
    expect(result?.url).toBe('https://app.example.com/Orders/Detail');
    expect(result?.path).toBe('/Orders/Detail');
  });
});

describe('fragmentIsRoute', () => {
  it('treats a slash-bearing fragment as a route and a bare token as an anchor', () => {
    expect(fragmentIsRoute('#/orders', 'AUTO')).toBe(true);
    expect(fragmentIsRoute('#!/orders', 'AUTO')).toBe(true);
    expect(fragmentIsRoute('#api/create', 'AUTO')).toBe(true);
    expect(fragmentIsRoute('#installation', 'AUTO')).toBe(false);
    expect(fragmentIsRoute('#', 'AUTO')).toBe(false);
    expect(fragmentIsRoute('', 'AUTO')).toBe(false);
  });
});

// ─── Registrable domain and scope ────────────────────────────────────────────

describe('registrableDomain', () => {
  it('gets a multi-label suffix right', () => {
    expect(registrableDomain('shop.example.co.uk')).toMatchObject({
      domain: 'example.co.uk',
      suffix: 'co.uk',
      basis: 'EXACT',
    });
    expect(registrableDomain('a.b.example.com.au')).toMatchObject({
      domain: 'example.com.au',
      suffix: 'com.au',
      basis: 'EXACT',
    });
  });

  it('keeps two preview deployments on one platform APART', () => {
    /*
     * The defect: without `vercel.app` in the private-suffix table, a two-label
     * rule gives both of these the registrable domain `vercel.app`, they read
     * as the same site, and a crawl of our preview would classify an unrelated
     * tenant's preview as part of the application under test.
     */
    const ours = registrableDomain('our-app-git-main.vercel.app');
    const theirs = registrableDomain('someone-else.vercel.app');
    expect(ours.domain).toBe('our-app-git-main.vercel.app');
    expect(ours.basis).toBe('EXACT');
    expect(ours.domain).not.toBe(theirs.domain);
  });

  it('says ASSUMED rather than claiming an unknown suffix', () => {
    const result = registrableDomain('foo.bar.not-a-real-tld');
    expect(result.domain).toBe('bar.not-a-real-tld');
    expect(result.basis).toBe('ASSUMED');
  });

  it('has no registrable domain for an IP, a single label, or a bare suffix', () => {
    for (const host of ['127.0.0.1', '[::1]', 'localhost', 'intranet', 'co.uk']) {
      expect(registrableDomain(host).basis).toBe('NONE');
      expect(registrableDomain(host).domain).toBeNull();
    }
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(registrableDomain('Example.CO.UK.').domain).toBe('example.co.uk');
  });
});

describe('classifyScope', () => {
  it('admits the application’s own origin', () => {
    const result = classifyScope(BASE, `${BASE}/orders`, POLICY);
    expect(result).toMatchObject({ scope: 'SAME_ORIGIN', admitted: true, refusal: null });
    expect(result.rule).not.toBe('');
  });

  it('admits a declared additional origin and names which one matched', () => {
    const result = classifyScope(
      BASE,
      'https://auth.example.com/login',
      policy({ additionalOrigins: ['https://auth.example.com'] }),
    );
    expect(result.scope).toBe('SAME_ORIGIN');
    expect(result.admitted).toBe(true);
    expect(result.rule).toContain('additionalOrigins');
  });

  it('refuses a same-site origin and names additionalOrigins as the remedy', () => {
    const result = classifyScope(BASE, 'https://auth.example.com/login', POLICY);
    expect(result.scope).toBe('SAME_SITE');
    expect(result.admitted).toBe(false);
    expect(result.rule).toContain('additionalOrigins');
  });

  it('treats a different PORT as same-site, not same-origin', () => {
    const result = classifyScope('http://localhost:3000', 'http://localhost:4000/x', POLICY);
    expect(result.scope).not.toBe('SAME_ORIGIN');
    expect(result.admitted).toBe(false);
  });

  it('does NOT fall for a suffix that merely ends with ours', () => {
    const result = classifyScope(BASE, 'https://evil-example.com/login', POLICY);
    expect(result.scope).toBe('OFF_ORIGIN');
    expect(result.admitted).toBe(false);
  });

  it('refuses a non-http scheme as not a page at all', () => {
    for (const url of ['mailto:sales@example.com', 'tel:+15551234', 'javascript:void(0)']) {
      const result = classifyScope(BASE, url, POLICY);
      expect(result.scope).toBe('NON_HTTP');
      expect(result.refusal).toBe('UNSUPPORTED_SCHEME');
    }
  });

  it('never admits a same-site judgement that rests on an ASSUMED suffix', () => {
    const result = classifyScope(
      'https://app.corp.weird-internal',
      'https://auth.corp.weird-internal/login',
      POLICY,
    );
    expect(result.scope).toBe('SAME_SITE');
    expect(result.admitted).toBe(false);
    expect(result.site?.basis).toBe('ASSUMED');
    expect(result.rule).toContain('assumed');
  });
});

// ─── Small parsers ───────────────────────────────────────────────────────────

describe('parseLinkHeader', () => {
  it('reads several refs with quoted and bare rels', () => {
    expect(
      parseLinkHeader('</orders?page=2>; rel="next", </orders?page=1>; rel=prev; title="Back"'),
    ).toEqual([
      { url: '/orders?page=2', rel: ['next'], title: null },
      { url: '/orders?page=1', rel: ['prev'], title: 'Back' },
    ]);
  });

  it('does not split a URL that contains a comma', () => {
    /*
     * The defect a naive split(',') produces is silent: `</a,b>` becomes two
     * entries, one of which resolves to a URL the app does not serve, so the
     * crawl mints a 404 node and reports a coverage gap for a page that never
     * existed.
     */
    expect(parseLinkHeader('</reports/a,b>; rel=next')).toEqual([
      { url: '/reports/a,b', rel: ['next'], title: null },
    ]);
  });

  it('keeps an entry with several rels and one with none', () => {
    expect(parseLinkHeader('</x>; rel="next last", </y>')).toEqual([
      { url: '/x', rel: ['next', 'last'], title: null },
      { url: '/y', rel: [], title: null },
    ]);
  });

  it('ignores garbage without throwing', () => {
    expect(parseLinkHeader('')).toEqual([]);
    expect(parseLinkHeader('not a link header')).toEqual([]);
    expect(parseLinkHeader('<>; rel=next')).toEqual([]);
  });
});

describe('parseMetaRefresh', () => {
  it('reads the delay and the URL in the forms browsers accept', () => {
    expect(parseMetaRefresh('0;url=/next')).toEqual({ delaySeconds: 0, url: '/next' });
    expect(parseMetaRefresh("5; URL='/next'")).toEqual({ delaySeconds: 5, url: '/next' });
    expect(parseMetaRefresh('  2 ; url = /a/b ')).toEqual({ delaySeconds: 2, url: '/a/b' });
  });

  it('keeps the delay for a self-reload, which has no outgoing edge', () => {
    expect(parseMetaRefresh('300')).toEqual({ delaySeconds: 300, url: null });
  });

  it('returns null rather than inventing a 0-second redirect', () => {
    expect(parseMetaRefresh('')).toBeNull();
    expect(parseMetaRefresh('url=/x')).toBeNull();
    expect(parseMetaRefresh('nonsense')).toBeNull();
  });
});

describe('parseSrcset', () => {
  it('takes the URL from each candidate and ignores the descriptor', () => {
    expect(parseSrcset('/a.png 1x, /b.png 2x, /c.png 640w')).toEqual([
      '/a.png',
      '/b.png',
      '/c.png',
    ]);
    expect(parseSrcset('')).toEqual([]);
  });
});

// ─── Harvesting a document ───────────────────────────────────────────────────

describe('harvestDocument reaches what a[href] cannot', () => {
  const doc = snapshot({
    url: `${BASE}/orders`,
    elements: [
      element('a', { href: '/orders/1001' }, 'Order 1001'),
      element('area', { href: '/map/north', alt: 'North region' }),
      element('link', { rel: 'next', href: '/orders?page=2' }),
      element('link', { rel: 'stylesheet', href: '/assets/app.css' }),
      element('meta', { 'http-equiv': 'refresh', content: '0;url=/orders/welcome' }),
      element('tr', { 'data-url': '/orders/1002' }, 'Order 1002'),
      element('div', { role: 'link', 'data-href': '/orders/archive' }, 'Archive'),
      element('span', { role: 'link', href: '/orders/export' }, 'Export'),
      element('iframe', { src: '/embed/invoice', title: 'Invoice' }),
      element('script', { src: 'https://cdn.example.net/analytics.js' }),
      element('img', { srcset: '/logo.png 1x, /logo@2x.png 2x' }),
    ],
    forms: [
      { action: '/search', method: 'get', fields: [{ name: 'q', tag: 'input', type: 'search' }] },
    ],
    headers: { link: '</orders?page=3>; rel=next' },
  });

  const harvest = harvestDocument(doc, options({ fromRoute: '/orders' }));
  const byKind = (kind: string): Discovery[] =>
    harvest.discoveries.filter((discovery) => discovery.kind === kind);

  it('queues a GET form’s action and names its fields as a URL template', () => {
    const form = byKind('GET_FORM')[0];
    expect(form?.url).toBe(`${BASE}/search`);
    expect(form?.admitted).toBe(true);
    expect(form?.template?.params).toEqual(['q']);
    expect(form?.template?.method).toBe('GET');
    // No invented value: the markup supplies none, so there is no sample URL.
    expect(form?.template?.sample).toBeNull();
  });

  it('finds an image-map area, a rel=next, a meta refresh and a Link: header', () => {
    expect(byKind('AREA')[0]?.url).toBe(`${BASE}/map/north`);
    expect(byKind('AREA')[0]?.label).toBe('North region');
    expect(byKind('LINK_REL').map((d) => d.url)).toContain(`${BASE}/orders?page=2`);
    expect(byKind('META_REFRESH')[0]?.url).toBe(`${BASE}/orders/welcome`);
    expect(byKind('META_REFRESH')[0]?.evidence).toContain('after 0s');
    expect(byKind('LINK_HEADER')[0]?.url).toBe(`${BASE}/orders?page=3`);
  });

  it('finds a data-url row and a role=link element', () => {
    expect(byKind('DATA_ATTRIBUTE')[0]?.url).toBe(`${BASE}/orders/1002`);
    expect(byKind('DATA_ATTRIBUTE')[0]?.label).toBe('Order 1002');
    expect(byKind('ROLE_LINK')[0]?.url).toBe(`${BASE}/orders/export`);
  });

  it('merges one element’s two signals into one URL and keeps both kinds', () => {
    // `<div role="link" data-href>` is one URL discovered twice. It must be ONE
    // node — two would double-count the route — and both kinds have to survive,
    // or the provenance says less than it knew.
    const archive = harvest.discoveries.find((d) => d.url === `${BASE}/orders/archive`)!;
    expect(archive.occurrences).toBe(2);
    expect([archive.kind, ...archive.otherKinds].sort()).toEqual(['DATA_ATTRIBUTE', 'ROLE_LINK']);
  });

  it('keeps assets, scripts, stylesheets and frames OUT of the navigable set', () => {
    const navigable = navigableDiscoveries(harvest).map((discovery) => discovery.url);
    expect(navigable).toContain(`${BASE}/orders/1001`);
    expect(navigable).toContain(`${BASE}/search`);
    expect(navigable).not.toContain(`${BASE}/logo.png`);
    expect(navigable).not.toContain(`${BASE}/assets/app.css`);
    expect(navigable).not.toContain(`${BASE}/embed/invoice`);
    expect(navigable).not.toContain('https://cdn.example.net/analytics.js');
  });

  it('records the off-origin script host as a boundary, not as a route', () => {
    expect(
      harvest.boundaries.some(
        (boundary) =>
          boundary.origin === 'https://cdn.example.net' && boundary.kind === 'SCRIPT_HOST',
      ),
    ).toBe(true);
  });

  it('carries a non-empty rule on EVERY discovery, admitted or refused', () => {
    expect(harvest.discoveries.length).toBeGreaterThan(8);
    for (const discovery of harvest.discoveries) {
      expect(discovery.rule, discovery.evidence).not.toBe('');
      // admitted implies no ledger refusal; the converse does not hold — an
      // asset is not refused by anybody.
      if (discovery.admitted) expect(discovery.refusal).toBeNull();
    }
  });

  it('reports every axis as measured, because the canonical selector was used', () => {
    for (const axis of HARVEST_AXES) {
      const state = harvest.availability[axis];
      expect(axisIsConsistent(state), axis).toBe(true);
      expect(state.state, axis).toBe('MEASURED');
    }
    expect(harvest.availability.ANCHORS.found).toBe(1);
    expect(harvest.availability.AREA_MAPS.found).toBe(1);
    expect(harvest.availability.LINK_HEADERS.found).toBe(1);
  });
});

describe('harvestDocument and the policy', () => {
  it('refuses an excluded path WITH the glob that refused it', () => {
    const harvest = harvestDocument(
      snapshot({ elements: [element('a', { href: '/logout' }, 'Sign out')] }),
      options({ fromRoute: '/orders' }),
    );
    const logout = harvest.discoveries[0]!;
    expect(logout.admitted).toBe(false);
    expect(logout.refusal).toBe('POLICY_EXCLUDE');
    expect(logout.rule).toContain('/logout');

    const ledger = toExcludedPaths(harvest.discoveries);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      url: `${BASE}/logout`,
      kind: 'POLICY_EXCLUDE',
      discoveredFrom: '/orders',
    });
    expect(ledger[0]!.rule).toContain('/logout');
  });

  it('refuses a path outside includeGlobs as NOT_INCLUDED, a different fact', () => {
    const harvest = harvestDocument(
      snapshot({ elements: [element('a', { href: '/billing' })] }),
      options({ policy: policy({ includeGlobs: ['/orders/**'] }) }),
    );
    expect(harvest.discoveries[0]?.refusal).toBe('POLICY_NOT_INCLUDED');
  });

  it('keeps assets OUT of the exclusion ledger, so refusals stay readable', () => {
    const harvest = harvestDocument(
      snapshot({
        elements: [
          element('img', { src: '/a.png' }),
          element('script', { src: '/app.js' }),
          element('link', { rel: 'stylesheet', href: '/app.css' }),
        ],
      }),
      options(),
    );
    expect(toExcludedPaths(harvest.discoveries)).toEqual([]);
    for (const discovery of harvest.discoveries) {
      expect(discovery.admitted).toBe(false);
      expect(discovery.refusal).toBeNull();
      expect(discovery.rule).toContain('not a page');
    }
  });

  it('records a POST form as surface and refuses it under safeMethodsOnly', () => {
    const harvest = harvestDocument(
      snapshot({
        forms: [{ action: '/orders/1001/refund', method: 'post', fields: [] }],
      }),
      options(),
    );
    const post = harvest.discoveries[0]!;
    expect(post.kind).toBe('POST_FORM');
    expect(post.admitted).toBe(false);
    expect(post.refusal).toBe('UNSAFE_METHOD');
    expect(post.rule).toContain('safeMethodsOnly');
    // It IS in the ledger: "there is a refund form here we did not drive" is a
    // fact the report owes the reader.
    expect(toExcludedPaths(harvest.discoveries)).toHaveLength(1);
  });

  it('builds a template sample only from values the markup supplies', () => {
    const harvest = harvestDocument(
      snapshot({
        forms: [
          {
            action: '/search?stale=1',
            method: 'get',
            fields: [
              { name: 'q', tag: 'input', type: 'search' },
              { name: 'scope', tag: 'input', type: 'hidden', value: 'orders' },
            ],
          },
        ],
      }),
      options(),
    );
    const template = harvest.templates[0]!;
    // A GET submission REPLACES the action's query, so `stale=1` is gone.
    expect(template.action).toBe(`${BASE}/search`);
    expect(template.params).toEqual(['q', 'scope']);
    expect(template.sample).toBe(`${BASE}/search?scope=orders`);
    expect(template.sample).not.toContain('q=');
  });

  it('honours a robots Disallow ONLY when asked, and names the line when it does', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /admin\n', { baseUrl: BASE });
    const doc = snapshot({ elements: [element('a', { href: '/admin/users' })] });

    // The default: robots.txt is a statement about indexing, not about what
    // exists, so it must not shrink the denominator.
    const advisory = harvestDocument(doc, options({ robots }));
    expect(advisory.discoveries[0]?.admitted).toBe(true);

    const strict = harvestDocument(doc, options({ robots, respectRobotsDisallow: true }));
    expect(strict.discoveries[0]?.admitted).toBe(false);
    expect(strict.discoveries[0]?.rule).toBe('robots.txt: Disallow: /admin');
  });
});

describe('harvestDocument and <base href>', () => {
  it('resolves relative URLs against the base, not the document URL', () => {
    const harvest = harvestDocument(
      snapshot({
        url: `${BASE}/docs/page`,
        baseHref: '/app/',
        elements: [element('base', { href: '/app/' }), element('a', { href: 'settings' })],
      }),
      options(),
    );
    expect(harvest.baseHref).toBe(`${BASE}/app/`);
    expect(harvest.discoveries.some((d) => d.url === `${BASE}/app/settings`)).toBe(true);
  });

  it('flags an off-origin base, which would turn the crawl into someone else’s', () => {
    const harvest = harvestDocument(
      snapshot({
        baseHref: 'https://cdn.other.test/app/',
        elements: [element('a', { href: 'settings' }, 'Settings')],
      }),
      options(),
    );
    expect(harvest.baseHrefIsOffOrigin).toBe(true);
    const settings = harvest.discoveries.find((d) => d.kind === 'ANCHOR');
    expect(settings?.scope).toBe('OFF_ORIGIN');
    expect(settings?.admitted).toBe(false);
  });

  it('reads <base href> out of the element list when the adapter does not lift it', () => {
    const harvest = harvestDocument(
      snapshot({ elements: [element('base', { href: 'https://app.example.com/v2/' })] }),
      options(),
    );
    expect(harvest.baseHref).toBe(`${BASE}/v2/`);
    expect(harvest.baseHrefIsOffOrigin).toBe(false);
  });
});

describe('harvestDocument discloses every cap that bit', () => {
  it('reports the per-document cap as a count AND a reason', () => {
    const elements = Array.from({ length: 12 }, (_, index) =>
      element('a', { href: `/orders/${index}` }),
    );
    const harvest = harvestDocument(snapshot({ elements }), options({ linksPerDocument: 5 }));
    expect(harvest.discoveries).toHaveLength(5);
    const bite = harvest.caps.find((cap) => cap.cap === 'LINKS_PER_DOCUMENT')!;
    expect(bite.limit).toBe(5);
    expect(bite.discarded).toBe(7);
    expect(bite.reason).toContain('at least 7 more existed');
  });

  it('reports NO caps when none bit — a cap that did not bite is not a caveat', () => {
    const harvest = harvestDocument(
      snapshot({ elements: [element('a', { href: '/x' })] }),
      options(),
    );
    expect(harvest.caps).toEqual([]);
  });
});

describe('a narrower selector makes the axes it skipped UNAVAILABLE', () => {
  it('does not claim "no image maps" for a page nobody queried for them', () => {
    const harvest = harvestDocument(
      snapshot({ selector: 'a[href]', elements: [element('a', { href: '/x' })] }),
      options(),
    );
    expect(harvest.availability.ANCHORS).toMatchObject({ state: 'MEASURED', found: 1 });
    for (const axis of ['AREA_MAPS', 'LINK_REL', 'META_REFRESH', 'FRAMES'] as const) {
      expect(harvest.availability[axis].state, axis).toBe('UNAVAILABLE');
      expect(harvest.availability[axis].found, axis).toBeNull();
      expect(harvest.availability[axis].reason, axis).toContain('a[href]');
    }
  });

  it('assumes the canonical selector when the adapter does not say', () => {
    const harvest = harvestDocument(snapshot(), options());
    expect(harvest.availability.AREA_MAPS).toMatchObject({ state: 'MEASURED', found: 0 });
  });
});

describe('the axes with their own signal', () => {
  it('reports UNAVAILABLE, not zero, when the adapter cannot read headers', () => {
    const harvest = harvestDocument({ url: `${BASE}/orders`, elements: [] }, options());
    expect(harvest.availability.LINK_HEADERS).toMatchObject({
      state: 'UNAVAILABLE',
      found: null,
    });
    expect(harvest.availability.FORMS.found).toBeNull();
    expect(harvest.availability.SUB_DOCUMENTS.found).toBeNull();
    expect(harvest.availability.PORTALS.found).toBeNull();
  });

  it('reports MEASURED zero when the headers were read and carry no Link:', () => {
    const harvest = harvestDocument(
      snapshot({ headers: { 'content-type': 'text/html' } }),
      options(),
    );
    expect(harvest.availability.LINK_HEADERS).toMatchObject({ state: 'MEASURED', found: 0 });
  });

  it('distinguishes "no headers captured" from "cannot read headers"', () => {
    const harvest = harvestDocument(snapshot({ headers: null }), options());
    expect(harvest.availability.LINK_HEADERS.state).toBe('UNAVAILABLE');
    expect(harvest.availability.LINK_HEADERS.reason).toContain('captured');
  });
});

// ─── Sub-documents ───────────────────────────────────────────────────────────

describe('sub-document traversal', () => {
  it('harvests a same-origin iframe as PART OF the parent, not as a route', () => {
    const harvest = harvestDocument(
      snapshot({
        elements: [element('iframe', { src: '/embed/checkout' })],
        subDocuments: [
          {
            path: 'iframe[0]',
            kind: 'IFRAME',
            url: `${BASE}/embed/checkout`,
            document: {
              url: `${BASE}/embed/checkout`,
              elements: [element('a', { href: 'terms' }, 'Terms')],
              forms: [{ action: '/pay', method: 'get', fields: [{ name: 'token', tag: 'input' }] }],
              headers: {},
            },
          },
        ],
      }),
      options({ fromRoute: '/checkout' }),
    );

    // The frame's own URL is recorded and NOT queued.
    const frame = harvest.discoveries.find((d) => d.kind === 'FRAME')!;
    expect(frame.admitted).toBe(false);
    expect(frame.rule).toContain('part of its parent document');

    // Its contents ARE harvested, resolved against the FRAME's URL.
    const terms = harvest.discoveries.find((d) => d.url === `${BASE}/embed/terms`)!;
    expect(terms.container).toBe('iframe[0]');
    expect(terms.admitted).toBe(true);
    expect(harvest.templates.some((t) => t.action === `${BASE}/pay`)).toBe(true);

    const report = harvest.subDocuments[0]!;
    expect(report).toMatchObject({ entered: true, unavailable: null, forms: 1 });
    expect(report.discoveries).toBeGreaterThan(0);
    expect(unreadAppSubDocuments(harvest.subDocuments)).toEqual([]);
  });

  it('treats a CROSS-ORIGIN iframe as a boundary, not as unread app surface', () => {
    const harvest = harvestDocument(
      snapshot({
        subDocuments: [
          {
            path: 'iframe[0]',
            kind: 'IFRAME',
            url: 'https://js.stripe.test/v3/elements',
            unavailable: 'CROSS_ORIGIN',
          },
        ],
      }),
      options({ fromRoute: '/checkout' }),
    );
    const report = harvest.subDocuments[0]!;
    expect(report).toMatchObject({
      entered: false,
      unavailable: 'CROSS_ORIGIN',
      unreadAppSurface: false,
      discoveries: null,
      forms: null,
    });
    expect(unreadAppSubDocuments(harvest.subDocuments)).toEqual([]);
    expect(harvest.boundaries.some((b) => b.origin === 'https://js.stripe.test')).toBe(true);
    expect(subDocumentCoverage(harvest.subDocuments)).toEqual({
      entered: 0,
      unreadAppSurface: 0,
      offOrigin: 1,
    });
  });

  it('records a cross-origin frame’s boundary by origin and PATH, never its query', () => {
    /*
     * The sub-document branch has its own boundary push, and a mutation test
     * showed the headline secrets assertion could not reach it: the `<iframe>`
     * ELEMENT produces a boundary at the same (origin, kind), lands first, and
     * masks whatever the frame branch stored. So this fixture gives the frame
     * no matching element — which is also the real shape when a frame is
     * injected by script after load.
     */
    const token = 'st-4471-never-store-this';
    const harvest = harvestDocument(
      snapshot({
        elements: [],
        subDocuments: [
          {
            path: 'iframe[0]',
            kind: 'IFRAME',
            url: `https://idp.other.test/authorize?state=${token}`,
            unavailable: 'CROSS_ORIGIN',
          },
        ],
      }),
      options({ fromRoute: '/login' }),
    );
    const boundary = harvest.boundaries[0]!;
    expect(boundary.origin).toBe('https://idp.other.test');
    expect(boundary.path).toBe('/authorize');
    expect(JSON.stringify(harvest.boundaries)).not.toContain(token);
  });

  it('counts a CLOSED shadow root as unread surface of our OWN application', () => {
    const harvest = harvestDocument(
      snapshot({
        subDocuments: [
          { path: 'pay-widget::shadow', kind: 'SHADOW_ROOT', unavailable: 'CLOSED_SHADOW_ROOT' },
        ],
      }),
      options(),
    );
    expect(harvest.subDocuments[0]).toMatchObject({
      unavailable: 'CLOSED_SHADOW_ROOT',
      unreadAppSurface: true,
      discoveries: null,
    });
    expect(unreadAppSubDocuments(harvest.subDocuments)).toHaveLength(1);
    expect(subDocumentCoverage(harvest.subDocuments).unreadAppSurface).toBe(1);
  });

  it('harvests an OPEN shadow root’s forms and affordances', () => {
    const harvest = harvestDocument(
      snapshot({
        subDocuments: [
          {
            path: 'pay-widget::shadow',
            kind: 'SHADOW_ROOT',
            document: {
              url: `${BASE}/checkout`,
              elements: [element('a', { href: '/checkout/help' }, 'Help')],
              forms: [{ action: '/checkout/confirm', method: 'get', fields: [] }],
              headers: {},
            },
          },
        ],
      }),
      options(),
    );
    expect(harvest.discoveries.some((d) => d.url === `${BASE}/checkout/help`)).toBe(true);
    expect(harvest.discoveries.find((d) => d.url === `${BASE}/checkout/help`)?.container).toBe(
      'pay-widget::shadow',
    );
  });

  it('discloses the depth and budget caps as unread surface, with a bite', () => {
    const nested = (depth: number): DocumentSnapshot => ({
      url: `${BASE}/f${depth}`,
      elements: [],
      forms: [],
      headers: {},
      subDocuments:
        depth > 3
          ? []
          : [
              {
                path: `iframe[${depth}]`,
                kind: 'IFRAME',
                url: `${BASE}/f${depth + 1}`,
                document: nested(depth + 1),
              },
            ],
    });
    const harvest = harvestDocument(nested(0), options({ subDocumentDepth: 1 }));
    expect(harvest.caps.some((cap) => cap.cap === 'SUB_DOCUMENT_DEPTH')).toBe(true);
    expect(unreadAppSubDocuments(harvest.subDocuments).length).toBeGreaterThan(0);
    expect(
      unreadAppSubDocuments(harvest.subDocuments).every(
        (report) => report.unavailable === 'DEPTH_CAP',
      ),
    ).toBe(true);
  });

  it('reports a sub-document the adapter simply did not supply', () => {
    const harvest = harvestDocument(
      snapshot({ subDocuments: [{ path: 'iframe[0]', kind: 'IFRAME', url: `${BASE}/embed` }] }),
      options(),
    );
    expect(harvest.subDocuments[0]).toMatchObject({
      unavailable: 'NOT_SUPPLIED',
      unreadAppSurface: true,
    });
  });
});

describe('portals', () => {
  it('groups elements mounted outside the application root', () => {
    const harvest = harvestDocument(
      snapshot({
        appRoot: '#root',
        elements: [
          element('a', { href: '/x' }),
          {
            tag: 'a',
            attrs: { href: '/modal/confirm' },
            outsideAppRoot: true,
            portalHost: '#modal-root',
          },
          {
            tag: 'a',
            attrs: { href: '/modal/cancel' },
            outsideAppRoot: true,
            portalHost: '#modal-root',
          },
        ],
      }),
      options(),
    );
    expect(harvest.portals).toEqual([{ host: '#modal-root', elements: 2 }]);
    expect(harvest.availability.PORTALS).toMatchObject({ state: 'MEASURED', found: 1 });
    // The portal's links are still harvested — that is the point.
    expect(harvest.discoveries.some((d) => d.url === `${BASE}/modal/confirm`)).toBe(true);
  });

  it('reports UNAVAILABLE when the adapter gave no app-root signal at all', () => {
    const harvest = harvestDocument(
      { url: `${BASE}/orders`, elements: [element('a', { href: '/x' })], forms: [], headers: {} },
      options(),
    );
    expect(harvest.availability.PORTALS).toMatchObject({ state: 'UNAVAILABLE', found: null });
    expect(harvest.portals).toEqual([]);
  });

  it('reports MEASURED zero when the adapter told us and found none', () => {
    const harvest = harvestDocument(snapshot({ appRoot: '#root' }), options());
    expect(harvest.availability.PORTALS).toMatchObject({ state: 'MEASURED', found: 0 });
  });
});

describe('harvestDocument provenance', () => {
  it('normalises the route when a normaliseRoute is injected, and null when not', () => {
    const collapse = (pathname: string): string => pathname.replace(/\/\d+/g, '/:id');
    const doc = snapshot({ elements: [element('a', { href: '/orders/1001/items/7' })] });

    const withIt = harvestDocument(doc, options({ normaliseRoute: collapse }));
    expect(withIt.discoveries[0]?.route).toBe('/orders/:id/items/:id');

    // Nobody normalised it, so there is no normalised route. Not the raw path
    // dressed up as one.
    const without = harvestDocument(doc, options());
    expect(without.discoveries[0]?.route).toBeNull();
  });

  it('puts the normalised route in the ledger when the caller supplies one', () => {
    const harvest = harvestDocument(
      snapshot({ elements: [element('a', { href: '/delete-account/1001' })] }),
      options({ fromRoute: '/orders/:id' }),
    );
    expect(harvest.discoveries[0]?.refusal).toBe('POLICY_EXCLUDE');
    const ledger = toExcludedPaths(harvest.discoveries, {
      normaliseRoute: (pathname) => pathname.replace(/\/\d+/g, '/:id'),
    });
    expect(ledger[0]?.route).toBe('/delete-account/:id');
  });

  it('reads an old <frame src> as well as an <iframe src>', () => {
    const harvest = harvestDocument(
      snapshot({ elements: [element('frame', { src: '/legacy/nav' })] }),
      options(),
    );
    expect(harvest.discoveries[0]?.kind).toBe('FRAME');
    expect(harvest.availability.FRAMES.found).toBe(1);
  });

  it('counts a sub-document’s discoveries against the SAME per-node budget', () => {
    const harvest = harvestDocument(
      snapshot({
        elements: [element('a', { href: '/a' }), element('a', { href: '/b' })],
        subDocuments: [
          {
            path: 'iframe[0]',
            kind: 'IFRAME',
            url: `${BASE}/embed`,
            document: {
              url: `${BASE}/embed`,
              elements: [element('a', { href: '/c' }), element('a', { href: '/d' })],
              forms: [],
              headers: {},
            },
          },
        ],
      }),
      options({ linksPerDocument: 3 }),
    );
    // A frame is part of the parent node, so "how many URLs did this node
    // yield" has one answer and one cap.
    expect(harvest.discoveries).toHaveLength(3);
    expect(harvest.caps.some((cap) => cap.cap === 'LINKS_PER_DOCUMENT')).toBe(true);
  });

  it('matches an additionalOrigins entry written with a path on it', () => {
    const harvest = harvestDocument(
      snapshot({ elements: [element('a', { href: 'https://auth.example.com/login' })] }),
      options({ policy: policy({ additionalOrigins: ['https://auth.example.com/some/path'] }) }),
    );
    expect(harvest.discoveries[0]?.scope).toBe('SAME_ORIGIN');
    expect(harvest.discoveries[0]?.admitted).toBe(true);
  });
});

// ─── Dedupe ──────────────────────────────────────────────────────────────────

describe('dedupeDiscoveries', () => {
  it('merges one identity, counts the sightings, and keeps every kind', () => {
    const harvest = harvestDocument(
      snapshot({
        elements: [
          element('a', { href: '/orders?a=1&b=2' }, 'Orders'),
          element('a', { href: '/orders?b=2&a=1' }),
          element('tr', { 'data-url': '/orders?a=1&b=2' }),
        ],
      }),
      options(),
    );
    expect(harvest.discoveries).toHaveLength(1);
    const merged = harvest.discoveries[0]!;
    expect(merged.occurrences).toBe(3);
    expect(merged.otherKinds).toContain('DATA_ATTRIBUTE');
    expect(merged.label).toBe('Orders');
  });

  it('promotes a URL that is an asset AND an anchor to navigable', () => {
    const asset: Discovery = {
      url: `${BASE}/report.pdf`,
      identity: `${BASE}/report.pdf`,
      kind: 'ASSET',
      scope: 'SAME_ORIGIN',
      route: null,
      fromRoute: null,
      label: null,
      evidence: 'img[src]',
      navigable: false,
      admitted: false,
      rule: 'an image is a file, not a page',
      refusal: null,
      container: null,
      template: null,
      occurrences: 1,
      otherKinds: [],
      droppedFragment: null,
    };
    const anchor: Discovery = {
      ...asset,
      kind: 'ANCHOR',
      evidence: 'a[href] “Download”',
      navigable: true,
      admitted: true,
      rule: 'admitted',
    };
    const [merged] = dedupeDiscoveries([asset, anchor]);
    expect(merged?.navigable).toBe(true);
    expect(merged?.admitted).toBe(true);
    expect(merged?.refusal).toBeNull();
    expect(merged?.kind).toBe('ANCHOR');
  });
});

// ─── Axis consistency, as a function and not only as a property ──────────────

describe('axisIsConsistent', () => {
  it('refuses an UNAVAILABLE axis that carries a count', () => {
    // The shape the honesty rule forbids: "we could not look" with a zero
    // beside it, which every reader renders as "there is nothing there".
    expect(axisIsConsistent({ state: 'UNAVAILABLE', found: 0, reason: 'no adapter' })).toBe(false);
    expect(axisIsConsistent({ state: 'UNAVAILABLE', found: 3, reason: 'no adapter' })).toBe(false);
  });

  it('refuses an UNAVAILABLE axis with no reason', () => {
    expect(axisIsConsistent({ state: 'UNAVAILABLE', found: null, reason: null })).toBe(false);
  });

  it('refuses a MEASURED axis with no count', () => {
    expect(axisIsConsistent({ state: 'MEASURED', found: null, reason: null })).toBe(false);
  });

  it('accepts the two honest shapes, including a measured zero', () => {
    expect(axisIsConsistent({ state: 'MEASURED', found: 0, reason: null })).toBe(true);
    expect(axisIsConsistent({ state: 'MEASURED', found: 12, reason: null })).toBe(true);
    expect(axisIsConsistent({ state: 'UNAVAILABLE', found: null, reason: 'closed root' })).toBe(
      true,
    );
  });
});

// ─── Caps projection ─────────────────────────────────────────────────────────

describe('toCapBites', () => {
  it('maps what it can and hands back what it cannot, named', () => {
    const bites: HarvestCapBite[] = [
      {
        cap: 'LINKS_PER_DOCUMENT',
        limit: 5,
        bites: 1,
        discarded: 7,
        scope: '/orders',
        reason: 'r1',
      },
      {
        cap: 'SITEMAP_URL_BUDGET',
        limit: 10,
        bites: 1,
        discarded: 90,
        scope: '/sitemap.xml',
        reason: 'r2',
      },
    ];
    const result = toCapBites(bites);
    expect(result.capBites).toHaveLength(1);
    expect(result.capBites[0]).toMatchObject({ cap: 'LINKS_PER_PAGE', discarded: 7 });
    // The sitemap budget has no member in CRAWL_CAPS; it comes BACK rather than
    // being filed under a cap a reader interprets as something else.
    expect(result.unexpressible).toHaveLength(1);
    expect(result.unexpressible[0]?.cap).toBe('SITEMAP_URL_BUDGET');
  });
});

// ─── robots.txt ──────────────────────────────────────────────────────────────

describe('parseRobots', () => {
  const BODY = [
    '# comment',
    'Sitemap: https://app.example.com/sitemap.xml',
    'Sitemap: /sitemap-news.xml',
    '',
    'User-agent: *',
    'Disallow: /admin',
    'Disallow:',
    'Allow: /admin/public',
    'Crawl-delay: 2',
    '',
    'User-agent: Googlebot',
    'Disallow: /nothing-for-google',
    'Weird-directive: 1',
  ].join('\n');

  it('collects Sitemap: lines globally and resolves relative ones', () => {
    const robots = parseRobots(BODY, { baseUrl: BASE });
    expect(robots.sitemaps).toEqual([
      'https://app.example.com/sitemap.xml',
      'https://app.example.com/sitemap-news.xml',
    ]);
    expect(robots.availability).toBe('PRESENT');
  });

  it('takes the * group for an unnamed agent and does not merge in Googlebot’s', () => {
    const robots = parseRobots(BODY, { baseUrl: BASE });
    expect(robots.userAgent).toBe('*');
    expect(robots.disallow).toEqual(['/admin']);
    expect(robots.disallow).not.toContain('/nothing-for-google');
    expect(robots.allow).toEqual(['/admin/public']);
    expect(robots.crawlDelaySeconds).toBe(2);
  });

  it('takes the specific group when the agent names it', () => {
    const robots = parseRobots(BODY, { baseUrl: BASE, userAgent: 'Googlebot/2.1' });
    expect(robots.userAgent).toBe('googlebot');
    expect(robots.disallow).toEqual(['/nothing-for-google']);
  });

  it('never turns an empty Disallow into a pattern that matches everything', () => {
    const robots = parseRobots('User-agent: *\nDisallow:\n', { baseUrl: BASE });
    expect(robots.disallow).toEqual([]);
    expect(robotsDecision(robots, '/anything').disallowed).toBe(false);
  });

  it('reports the lines it did not understand rather than dropping them', () => {
    const robots = parseRobots(BODY, { baseUrl: BASE });
    expect(robots.unparsed).toContain('Weird-directive: 1');
  });

  it('produces no exclude globs — robots.txt is not a statement about existence', () => {
    const robots = parseRobots(BODY, { baseUrl: BASE });
    expect(Object.keys(robots)).not.toContain('excludeGlobs');
  });
});

describe('robotsMatches is the robots dialect, not the policy’s glob dialect', () => {
  it('lets * cross a slash, which matchesGlob deliberately does not', () => {
    /*
     * Reusing `matchesGlob` here would make `Disallow: /a/*\/edit` and
     * `Disallow: /*.json$` silently stop applying — a rule the site wrote,
     * quietly not enforced.
     */
    expect(robotsMatches('/a/*/edit', '/a/b/c/edit')).toBe(true);
    expect(robotsMatches('/*.json', '/api/v1/data.json')).toBe(true);
  });

  it('anchors with $ and is a prefix match otherwise', () => {
    expect(robotsMatches('/report$', '/report')).toBe(true);
    expect(robotsMatches('/report$', '/report/2024')).toBe(false);
    expect(robotsMatches('/report', '/report/2024')).toBe(true);
  });

  it('treats ? as a literal, as robots.txt does', () => {
    expect(robotsMatches('/search?', '/search?')).toBe(true);
    expect(robotsMatches('/search?', '/searc')).toBe(false);
  });
});

describe('robotsDecision', () => {
  const robots = parseRobots(
    'User-agent: *\nDisallow: /admin\nAllow: /admin/public\nDisallow: /admin/public/secret\n',
    { baseUrl: BASE },
  );

  it('names the exact line, so a refusal is traceable', () => {
    expect(robotsDecision(robots, '/admin/users')).toEqual({
      disallowed: true,
      rule: 'Disallow: /admin',
    });
  });

  it('lets a longer Allow win over a shorter Disallow', () => {
    expect(robotsDecision(robots, '/admin/public/faq')).toEqual({
      disallowed: false,
      rule: 'Allow: /admin/public',
    });
  });

  it('lets a longer Disallow win over a shorter Allow', () => {
    expect(robotsDecision(robots, '/admin/public/secret/x').disallowed).toBe(true);
  });

  it('allows what nothing matches', () => {
    expect(robotsDecision(robots, '/orders')).toEqual({ disallowed: false, rule: null });
  });
});

// ─── Sitemaps ────────────────────────────────────────────────────────────────

describe('parseSitemap', () => {
  it('reads a urlset with lastmod, changefreq and priority', () => {
    const parsed = parseSitemap(
      `<?xml version="1.0"?>
       <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc>https://app.example.com/orders</loc><lastmod>2026-01-02</lastmod>
              <changefreq>daily</changefreq><priority>0.8</priority></url>
         <url><loc>/settings</loc></url>
       </urlset>`,
      `${BASE}/sitemap.xml`,
    );
    expect(parsed.kind).toBe('URLSET');
    expect(parsed.availability).toBe('MEASURED');
    expect(parsed.entries).toEqual([
      {
        url: `${BASE}/orders`,
        lastmod: '2026-01-02',
        changefreq: 'daily',
        priority: 0.8,
      },
      { url: `${BASE}/settings`, lastmod: null, changefreq: null, priority: null },
    ]);
  });

  it('reads a sitemap index as children, not as URLs', () => {
    const parsed = parseSitemap(
      `<sitemapindex><sitemap><loc>${BASE}/sitemap-1.xml</loc></sitemap>
       <sitemap><loc>${BASE}/sitemap-2.xml</loc></sitemap></sitemapindex>`,
      `${BASE}/sitemap.xml`,
    );
    expect(parsed.kind).toBe('SITEMAPINDEX');
    expect(parsed.entries).toEqual([]);
    expect(parsed.children.map((child) => child.url)).toEqual([
      `${BASE}/sitemap-1.xml`,
      `${BASE}/sitemap-2.xml`,
    ]);
  });

  it('handles namespaced tags, CDATA and entities', () => {
    const parsed = parseSitemap(
      `<ns:urlset><ns:url><ns:loc><![CDATA[${BASE}/a?x=1&amp;y=2]]></ns:loc></ns:url></ns:urlset>`,
      `${BASE}/sitemap.xml`,
    );
    expect(parsed.entries[0]?.url).toBe(`${BASE}/a?x=1&y=2`);
  });

  it('does not mistake <urlset> for a <url> entry', () => {
    const parsed = parseSitemap(`<urlset></urlset>`, `${BASE}/sitemap.xml`);
    expect(parsed.kind).toBe('URLSET');
    expect(parsed.entries).toEqual([]);
    expect(parsed.availability).toBe('MEASURED');
  });

  it('reports UNAVAILABLE for a gzip body rather than "0 URLs"', () => {
    for (const prefix of ['\u001f\u008b', '\u001f�', '\u001fÂ\u008b']) {
      const parsed = parseSitemap(`${prefix}garbage-binary`, `${BASE}/sitemap.xml.gz`);
      expect(parsed.availability).toBe('UNAVAILABLE');
      expect(parsed.unavailableReason).toBe('GZIP_NOT_DECODED');
      expect(parsed.entries).toEqual([]);
    }
  });

  it('counts a malformed <loc> instead of silently shortening the list', () => {
    const parsed = parseSitemap(
      `<urlset><url><lastmod>2026-01-01</lastmod></url><url><loc>http://[</loc></url>
       <url><loc>${BASE}/ok</loc></url></urlset>`,
      `${BASE}/sitemap.xml`,
    );
    expect(parsed.entries.map((entry) => entry.url)).toEqual([`${BASE}/ok`]);
    expect(parsed.malformed).toBe(2);
  });

  it('accepts the plain-text sitemap form', () => {
    const parsed = parseSitemap(`${BASE}/a\n${BASE}/b\n`, `${BASE}/sitemap.txt`);
    expect(parsed.kind).toBe('TEXT');
    expect(parsed.entries.map((entry) => entry.url)).toEqual([`${BASE}/a`, `${BASE}/b`]);
  });

  it('reports UNAVAILABLE for an empty body and for HTML', () => {
    expect(parseSitemap(null, BASE)).toMatchObject({
      availability: 'UNAVAILABLE',
      unavailableReason: 'EMPTY_BODY',
    });
    expect(parseSitemap('<html><body>404</body></html>', BASE)).toMatchObject({
      availability: 'UNAVAILABLE',
      unavailableReason: 'NOT_XML',
    });
  });

  it('survives one broken entity without losing the rest', () => {
    const parsed = parseSitemap(
      `<urlset><url><loc>${BASE}/a&#xFFFFFFFF;b</loc></url><url><loc>${BASE}/c</loc></url></urlset>`,
      `${BASE}/sitemap.xml`,
    );
    expect(parsed.entries).toHaveLength(2);
  });
});

// ─── Seeding ─────────────────────────────────────────────────────────────────

describe('seedFromRobotsAndSitemaps', () => {
  it('reads robots.txt, follows the index, and decides every <loc>', async () => {
    const fetcher = fetcherFor({
      [`${BASE}/robots.txt`]: {
        body: 'User-agent: *\nDisallow: /admin\nSitemap: /sitemap.xml\n',
      },
      [`${BASE}/sitemap.xml`]: {
        body: `<sitemapindex><sitemap><loc>${BASE}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      },
      [`${BASE}/sitemap-pages.xml`]: {
        body: `<urlset>
          <url><loc>${BASE}/orders</loc><lastmod>2026-01-02</lastmod></url>
          <url><loc>${BASE}/admin/users</loc></url>
          <url><loc>${BASE}/logout</loc></url>
          <url><loc>https://blog.example.com/post</loc></url>
        </urlset>`,
      },
    });

    const seed = await seedFromRobotsAndSitemaps({ baseUrl: BASE, policy: POLICY, fetcher });

    expect(seed.robots.availability).toBe('PRESENT');
    expect(seed.robots.sitemaps).toEqual([`${BASE}/sitemap.xml`]);
    expect(seed.availability.robots).toMatchObject({ state: 'MEASURED', found: 1 });

    const byUrl = new Map(seed.discoveries.map((d) => [d.url, d]));
    expect(byUrl.get(`${BASE}/orders`)?.admitted).toBe(true);
    // robots Disallow is ADVISORY by default, so /admin is still surface.
    expect(byUrl.get(`${BASE}/admin/users`)?.admitted).toBe(true);
    // The crawl policy's own exclusion still bites, with its glob as the rule.
    expect(byUrl.get(`${BASE}/logout`)?.admitted).toBe(false);
    expect(byUrl.get(`${BASE}/logout`)?.rule).toContain('/logout');
    // An off-origin <loc> is a boundary, not one of our routes.
    expect(byUrl.get('https://blog.example.com/post')?.admitted).toBe(false);
    expect(seed.boundaries.some((b) => b.origin === 'https://blog.example.com')).toBe(true);

    expect(seed.entries).toHaveLength(4);
    expect(seed.caps).toEqual([]);
  });

  it('distinguishes an ABSENT robots.txt from one it could not fetch', async () => {
    const absent = await seedFromRobotsAndSitemaps({
      baseUrl: BASE,
      policy: POLICY,
      fetcher: fetcherFor({}),
    });
    expect(absent.robots.availability).toBe('ABSENT');
    expect(absent.availability.robots).toMatchObject({ state: 'MEASURED', found: 0 });

    const broken = await seedFromRobotsAndSitemaps({
      baseUrl: BASE,
      policy: POLICY,
      fetcher: {
        async get(): Promise<FetchedText> {
          return { status: null, body: null, error: 'ETIMEDOUT' };
        },
      },
    });
    expect(broken.robots.availability).toBe('UNAVAILABLE');
    expect(broken.availability.robots).toMatchObject({ state: 'UNAVAILABLE', found: null });
    expect(broken.availability.robots.reason).toContain('ETIMEDOUT');
  });

  it('calls a declared 404 sitemap a finding and a conventional one a miss', async () => {
    const fetcher = fetcherFor({
      [`${BASE}/robots.txt`]: { body: 'Sitemap: /sitemap-declared.xml\n' },
    });
    const seed = await seedFromRobotsAndSitemaps({ baseUrl: BASE, policy: POLICY, fetcher });
    const declared = seed.documents.find((d) => d.url.endsWith('/sitemap-declared.xml'))!;
    const conventional = seed.documents.find((d) => d.url.endsWith('/sitemap.xml'))!;
    expect(declared.basis).toBe('ROBOTS');
    expect(declared.declaredButMissing).toBe(true);
    expect(conventional.basis).toBe('CONVENTION');
    expect(conventional.declaredButMissing).toBe(false);
    expect(seed.availability.sitemaps).toMatchObject({ state: 'MEASURED', found: 0 });
  });

  it('REFUSES an off-origin sitemap by default and records why', async () => {
    const fetcher = fetcherFor({
      [`${BASE}/robots.txt`]: { body: 'Sitemap: https://attacker.test/sitemap.xml\n' },
    });
    const seed = await seedFromRobotsAndSitemaps({ baseUrl: BASE, policy: POLICY, fetcher });
    expect(fetcher.calls).not.toContain('https://attacker.test/sitemap.xml');
    const refused = seed.documents.find((d) => d.url.startsWith('https://attacker.test'))!;
    expect(refused.parsed.unavailableReason).toBe('REFUSED_OFF_ORIGIN');
    expect(refused.error).not.toBeNull();
    expect(seed.boundaries.some((b) => b.origin === 'https://attacker.test')).toBe(true);
  });

  it('fetches an off-origin sitemap only on an explicit opt-in', async () => {
    const fetcher = fetcherFor({
      [`${BASE}/robots.txt`]: { body: 'Sitemap: https://cdn.example.com/sitemap.xml\n' },
      'https://cdn.example.com/sitemap.xml': {
        body: `<urlset><url><loc>${BASE}/from-cdn</loc></url></urlset>`,
      },
    });
    const seed = await seedFromRobotsAndSitemaps({
      baseUrl: BASE,
      policy: POLICY,
      fetcher,
      allowOffOriginSitemaps: true,
    });
    expect(fetcher.calls).toContain('https://cdn.example.com/sitemap.xml');
    expect(seed.discoveries.some((d) => d.url === `${BASE}/from-cdn`)).toBe(true);
  });

  it('discloses the URL budget as a count and a reason', async () => {
    const locs = Array.from({ length: 9 }, (_, index) => `<url><loc>${BASE}/p${index}</loc></url>`);
    const fetcher = fetcherFor({
      [`${BASE}/sitemap.xml`]: { body: `<urlset>${locs.join('')}</urlset>` },
    });
    const seed = await seedFromRobotsAndSitemaps({
      baseUrl: BASE,
      policy: POLICY,
      fetcher,
      urlBudget: 4,
    });
    expect(seed.entries).toHaveLength(4);
    const bite = seed.caps.find((cap) => cap.cap === 'SITEMAP_URL_BUDGET')!;
    expect(bite.limit).toBe(4);
    expect(bite.discarded).toBe(5);
    expect(bite.reason).toContain('at least 5 more existed');
  });

  it('discloses the document budget, and what it left unfetched', async () => {
    const children = Array.from(
      { length: 6 },
      (_, index) => `<sitemap><loc>${BASE}/s${index}.xml</loc></sitemap>`,
    );
    const responses: Record<string, Partial<FetchedText>> = {
      [`${BASE}/sitemap.xml`]: { body: `<sitemapindex>${children.join('')}</sitemapindex>` },
    };
    for (let index = 0; index < 6; index += 1) {
      responses[`${BASE}/s${index}.xml`] = {
        body: `<urlset><url><loc>${BASE}/p${index}</loc></url></urlset>`,
      };
    }
    const seed = await seedFromRobotsAndSitemaps({
      baseUrl: BASE,
      policy: POLICY,
      fetcher: fetcherFor(responses),
      documentBudget: 4,
    });
    const bite = seed.caps.find((cap) => cap.cap === 'SITEMAP_DOCUMENT_BUDGET')!;
    expect(bite.limit).toBe(4);
    expect(bite.discarded).toBeGreaterThan(0);
    expect(bite.reason).toContain('more existed');
  });

  it('discloses the index depth limit', async () => {
    const fetcher = fetcherFor({
      [`${BASE}/sitemap.xml`]: {
        body: `<sitemapindex><sitemap><loc>${BASE}/mid.xml</loc></sitemap></sitemapindex>`,
      },
      [`${BASE}/mid.xml`]: {
        body: `<sitemapindex><sitemap><loc>${BASE}/leaf.xml</loc></sitemap></sitemapindex>`,
      },
      [`${BASE}/leaf.xml`]: { body: `<urlset><url><loc>${BASE}/deep</loc></url></urlset>` },
    });
    const seed = await seedFromRobotsAndSitemaps({
      baseUrl: BASE,
      policy: POLICY,
      fetcher,
      indexDepth: 1,
    });
    expect(fetcher.calls).not.toContain(`${BASE}/leaf.xml`);
    expect(seed.caps.some((cap) => cap.cap === 'SITEMAP_INDEX_DEPTH')).toBe(true);
  });

  it('does not throw when the fetcher rejects', async () => {
    const seed = await seedFromRobotsAndSitemaps({
      baseUrl: BASE,
      policy: POLICY,
      fetcher: {
        async get(): Promise<FetchedText> {
          throw new Error('socket hang up');
        },
      },
    });
    expect(seed.robots.availability).toBe('UNAVAILABLE');
    expect(seed.discoveries).toEqual([]);
    expect(seed.documents.every((document) => document.parsed.availability === 'UNAVAILABLE')).toBe(
      true,
    );
  });

  it('never fetches one sitemap document twice', async () => {
    const fetcher = fetcherFor({
      [`${BASE}/robots.txt`]: { body: 'Sitemap: /sitemap.xml\nSitemap: /sitemap.xml\n' },
      [`${BASE}/sitemap.xml`]: { body: '<urlset></urlset>' },
    });
    await seedFromRobotsAndSitemaps({ baseUrl: BASE, policy: POLICY, fetcher });
    expect(fetcher.calls.filter((url) => url === `${BASE}/sitemap.xml`)).toHaveLength(1);
  });
});

// ─── Declared but unreachable, and staleness ─────────────────────────────────

describe('sitemapReachability', () => {
  it('separates a declared 404 from one we never checked and one we refused', () => {
    const result = sitemapReachability(
      [`${BASE}/a`, `${BASE}/b`, `${BASE}/c`, `${BASE}/d`, `${BASE}/e`],
      new Map([
        [`${BASE}/a`, { status: 200 }],
        [`${BASE}/b`, { status: 404 }],
        [`${BASE}/c`, { status: null }],
      ]),
      new Set([`${BASE}/e`]),
    );
    expect(result.reachable).toEqual([`${BASE}/a`]);
    expect(result.unreachable.map((entry) => entry.url)).toEqual([`${BASE}/b`, `${BASE}/c`]);
    expect(result.unreachable[0]?.detail).toContain('404');
    // Never visited is a fact about US, not a defect in the application.
    expect(result.unchecked).toEqual([`${BASE}/d`]);
    expect(result.refused).toEqual([`${BASE}/e`]);
  });
});

describe('sitemapStaleness', () => {
  it('keeps undated entries out of BOTH buckets', () => {
    const result = sitemapStaleness(
      [
        { url: `${BASE}/old`, lastmod: '2020-01-01', changefreq: null, priority: null },
        { url: `${BASE}/new`, lastmod: '2026-10-01', changefreq: null, priority: null },
        { url: `${BASE}/undated`, lastmod: null, changefreq: null, priority: null },
        { url: `${BASE}/broken`, lastmod: 'last tuesday', changefreq: null, priority: null },
      ],
      { now: new Date('2026-10-24T00:00:00Z'), staleAfterDays: 365 },
    );
    expect(result.stale.map((entry) => entry.url)).toEqual([`${BASE}/old`]);
    expect(result.fresh).toBe(1);
    expect(result.undated).toBe(1);
    expect(result.unparseableDates).toBe(1);
  });
});

// ─── The boundary inventory ──────────────────────────────────────────────────

describe('mergeBoundaries', () => {
  const observation = (overrides: Partial<BoundaryObservation>): BoundaryObservation => ({
    origin: 'https://cdn.other.test',
    path: '/static/app.js',
    scope: 'OFF_ORIGIN',
    kind: 'SCRIPT_HOST',
    fromRoute: '/orders',
    evidence: 'script[src]',
    site: registrableDomain('cdn.other.test'),
    ...overrides,
  });

  it('groups by origin and kind and sums the occurrences', () => {
    const inventory = mergeBoundaries([
      observation({}),
      observation({ path: '/static/b.js' }),
      observation({ kind: 'FRAME', path: '/widget' }),
    ]);
    expect(inventory.externals).toHaveLength(2);
    const script = inventory.externals.find((entry) => entry.kind === 'SCRIPT_HOST')!;
    expect(script.occurrences).toBe(2);
    expect(script.fromRoute).toBe('/orders');
    expect(inventory.externals.some((entry) => entry.kind === 'IFRAME')).toBe(true);
    expect(inventory.unmapped).toEqual([]);
  });

  it('lists a same-site origin as a finding with the remedy, not as a route', () => {
    const inventory = mergeBoundaries([
      observation({
        origin: 'https://auth.example.com',
        scope: 'SAME_SITE',
        kind: 'META_REFRESH',
        path: '/login',
        site: registrableDomain('auth.example.com'),
      }),
    ]);
    expect(inventory.externals).toEqual([]);
    expect(inventory.sameSite).toHaveLength(1);
    expect(inventory.sameSite[0]).toMatchObject({
      origin: 'https://auth.example.com',
      registrableDomain: 'example.com',
      suffixBasis: 'EXACT',
      occurrences: 1,
    });
    expect(inventory.sameSite[0]?.advice).toContain('additionalOrigins');
  });

  it('NOTHING sensitive survives the inventory', () => {
    /*
     * The headline test, in the style of traffic.test.ts: a redirect to an
     * identity provider carries a tenant, a login hint and a state token in its
     * query string, and a flow map is stored, exported and rendered in a
     * cockpit. The assertion is over the ENTIRE serialised inventory rather
     * than field by field, so a future field that forgets to drop the query
     * fails this test without anyone remembering to extend it.
     */
    const secrets = {
      state: 'st-9f3a1c7d55b2e4a8-do-not-store',
      hint: 'jane.doe@example.com',
      tenant: 'acme-corp-internal-id-4471',
    };
    const harvest = harvestDocument(
      snapshot({
        elements: [
          element('meta', {
            'http-equiv': 'refresh',
            content: `0;url=https://idp.other.test/authorize?state=${secrets.state}&login_hint=${secrets.hint}&tenant=${secrets.tenant}`,
          }),
          element('iframe', {
            src: `https://idp.other.test/frame?state=${secrets.state}`,
          }),
          element('a', { href: `https://idp.other.test/logout?tenant=${secrets.tenant}` }, 'Out'),
          element('script', { src: `https://idp.other.test/sdk.js?hint=${secrets.hint}` }),
        ],
        subDocuments: [
          {
            path: 'iframe[0]',
            kind: 'IFRAME',
            url: `https://idp.other.test/frame?state=${secrets.state}&tenant=${secrets.tenant}`,
            unavailable: 'CROSS_ORIGIN',
          },
        ],
      }),
      options({ fromRoute: '/login' }),
    );

    /*
     * The whole harvest, not just the inventory: the sub-document report also
     * carries a frame URL, and a mutation test caught it keeping the query.
     */
    const serialised = JSON.stringify({
      inventory: mergeBoundaries(harvest.boundaries),
      subDocuments: harvest.subDocuments,
    });
    for (const [name, value] of Object.entries(secrets)) {
      expect(serialised, name).not.toContain(value);
    }
    // And the origin IS there, because that is the whole point of the item.
    expect(serialised).toContain('https://idp.other.test');
    expect(serialised).toContain('/authorize');
    expect(harvest.subDocuments[0]?.url).toBe('https://idp.other.test/frame');
  });
});

// ─── The property tests, over a deliberately hostile document ────────────────

describe('a hostile document', () => {
  const hostile = snapshot({
    url: `${BASE}/everything`,
    baseHref: '/app/',
    selector: HARVEST_ELEMENT_SELECTOR,
    elements: [
      element('base', { href: '/app/' }),
      element('a', { href: 'mailto:sales@example.com' }, 'Email us'),
      element('a', { href: 'javascript:void(0)' }, 'Nothing'),
      element('a', { href: 'http://[' }, 'Broken'),
      element('a', { href: '/logout' }, 'Sign out'),
      element('a', { href: '/delete-account' }, 'Delete'),
      element('a', { href: 'https://evil-example.com/phish' }, 'Totally us'),
      element('a', { href: 'https://auth.example.com/login' }, 'Sign in'),
      element('a', { href: '#/dashboard' }, 'Dashboard'),
      element('a', { href: '#top' }, 'Back to top'),
      element('area', { href: '' }),
      element('link', { rel: '', href: '/mystery' }),
      element('meta', { 'http-equiv': 'refresh', content: 'garbage' }),
      element('img', { srcset: '' }),
      element('div', { role: 'link' }, 'No URL at all'),
      element('tr', { 'data-href': '', 'data-url': '/orders/7' }),
    ],
    forms: [
      { action: null, method: undefined, fields: [{ name: '', tag: 'input' }] },
      { action: '/x', method: 'PoSt', fields: [] },
    ],
    headers: { link: '<malformed' },
    appRoot: '#root',
    subDocuments: [],
  });

  const harvest = harvestDocument(hostile, options({ fromRoute: '/everything' }));

  it('does not throw, and produces something', () => {
    expect(harvest.discoveries.length).toBeGreaterThan(5);
  });

  it('gives EVERY discovery a non-empty rule, and no admitted one a refusal', () => {
    for (const discovery of harvest.discoveries) {
      expect(discovery.rule, discovery.evidence).not.toBe('');
      expect(discovery.evidence, discovery.url).not.toBe('');
      if (discovery.admitted) expect(discovery.refusal, discovery.url).toBeNull();
      if (discovery.refusal !== null) expect(discovery.admitted, discovery.url).toBe(false);
    }
  });

  it('gives EVERY axis a self-consistent state — no UNAVAILABLE with a count', () => {
    for (const axis of HARVEST_AXES) {
      expect(axisIsConsistent(harvest.availability[axis]), axis).toBe(true);
    }
  });

  it('gives EVERY cap bite a limit, a count and a reason', () => {
    for (const bite of harvest.caps) {
      expect(bite.bites).toBeGreaterThan(0);
      expect(bite.reason).not.toBe('');
      expect(Number.isFinite(bite.limit)).toBe(true);
      expect(bite.discarded).toBeGreaterThanOrEqual(0);
    }
  });

  it('admits ONLY same-origin, navigable, policy-clean URLs', () => {
    for (const discovery of navigableDiscoveries(harvest)) {
      expect(discovery.scope).toBe('SAME_ORIGIN');
      expect(discovery.navigable).toBe(true);
      expect(discovery.admitted).toBe(true);
    }
    const admitted = navigableDiscoveries(harvest).map((discovery) => discovery.url);
    expect(admitted).not.toContain('mailto:sales@example.com');
    expect(admitted).not.toContain(`${BASE}/logout`);
    expect(admitted).not.toContain('https://evil-example.com/phish');
    expect(admitted).not.toContain('https://auth.example.com/login');
  });

  it('every refused URL reaches the ledger with a traceable rule', () => {
    const refused = harvest.discoveries.filter((discovery) => discovery.refusal !== null);
    const ledger = toExcludedPaths(harvest.discoveries);
    expect(ledger).toHaveLength(refused.length);
    for (const row of ledger) {
      expect(row.rule).not.toBe('');
      expect(row.discoveredFrom).toBe('/everything');
    }
  });

  it('still finds the hash route, which is the whole SPA case', () => {
    expect(harvest.discoveries.some((d) => d.url === `${BASE}/app/#/dashboard`)).toBe(true);
    const anchor = harvest.discoveries.find((d) => d.droppedFragment === '#top');
    expect(anchor?.url).toBe(`${BASE}/app/`);
  });
});

// ─── The defaults are the honest ones ────────────────────────────────────────

describe('the defaults', () => {
  it('leaves EMPTY_ROBOTS unavailable rather than pretending it permits everything', () => {
    expect(EMPTY_ROBOTS.availability).toBe('UNAVAILABLE');
    expect(EMPTY_ROBOTS.unavailableReason).not.toBeNull();
    expect(EMPTY_ROBOTS.disallow).toEqual([]);
  });

  it('treats an unknown link rel as a file rather than navigating it', () => {
    expect(navigabilityOf('LINK_REL', 'next')).toBe(true);
    expect(navigabilityOf('LINK_REL', 'NEXT')).toBe(true);
    expect(navigabilityOf('LINK_REL', 'stylesheet')).toBe(false);
    expect(navigabilityOf('LINK_REL', 'modulepreload')).toBe(false);
    expect(navigabilityOf('LINK_REL', null)).toBe(false);
    expect(navigabilityOf('ANCHOR', null)).toBe(true);
    expect(navigabilityOf('ASSET', 'next')).toBe(false);
  });
});
