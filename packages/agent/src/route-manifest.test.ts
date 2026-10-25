/**
 * Tests for the running application's own route table.
 *
 * No socket and no browser appears below, which is the point: `extractRouteManifest`
 * takes its HTTP as a one-method fetcher and its page as a one-method
 * `evaluate`, so every behaviour is driven by a literal. What is asserted here,
 * in rough order of how much it would cost to get wrong:
 *
 *   1. **A guess is never stored as a fact.** `routes-manifest.json` produces
 *      DECLARED, a source map produces INFERRED, the two are different values
 *      on the same field, the INFERRED item says so IN ITS EVIDENCE SENTENCE,
 *      and the write path leaves it out unless asked. A phantom route in a
 *      customer's gap list is the one mistake that costs the whole number its
 *      credibility.
 *   2. **An empty list is never an answer.** Every path that finds nothing
 *      returns NOT_AVAILABLE with one of three reasons, and the reason
 *      separates "we had no capability", "no app of this shape is here" and "a
 *      document was served and we failed to read it". A test that passes with
 *      `templates: []` would be this module's worst defect shipped green.
 *   3. **No cap bites in silence, and no attempt reports a null as a zero.**
 *      Two property tests walk the ENTIRE output of a hostile fixture and
 *      assert it over every attempt and every cap rather than field by field,
 *      so a future extractor that forgets a reason fails without anyone
 *      remembering to extend the test. An undisclosed cap makes the coverage
 *      percentage go UP.
 *   4. **A lazy subtree is not an absence.** Angular's `loadChildren` and
 *      React Router's `lazy` hide whole route trees; each is reported with its
 *      parent so the report can say "at least one more exists below here".
 *      Silence there turns a 412-route app into a 9-route app.
 *   5. **A layout is not a page and a module is not a URL.** The App Router
 *      segment rules get their own block: a route group, a parallel slot and a
 *      private folder contribute nothing to the URL, and `/orders/layout` must
 *      never reach a gap list.
 *   6. **The registry gets rows it will accept.** Every emitted item is parsed
 *      through the real `surfaceItemSchema` — the actual validator between a
 *      producer and the row — so an over-long evidence sentence or a bad
 *      declarer fails here rather than on a customer's write.
 */

import { describe, expect, it } from 'vitest';
import {
  SURFACE_SOURCES,
  exercisabilityCounts,
  originFromSources,
  surfaceItemSchema,
} from '@qaai/shared';
import type { FetchedText, HarvestFetcher } from './crawl/harvest.js';
import {
  CONVENTIONAL_DOCUMENTS,
  EXTRACTOR_GRADE,
  GROUND_TRUTH_GRADES,
  ROUTE_EXTRACTORS,
  ROUTE_EXTRACTOR_LABELS,
  ROUTE_EXTRACTOR_NEEDS,
  ROUTE_EXTRACTOR_STATES,
  ROUTE_EXTRACTOR_STATE_LABELS,
  ROUTE_MANIFEST_CAPS,
  ROUTE_MANIFEST_CAP_AS_CRAWL_CAP,
  ROUTE_MANIFEST_CAP_LABELS,
  ROUTE_MANIFEST_SOURCE,
  ROUTE_MANIFEST_UNAVAILABILITIES,
  ROUTE_MANIFEST_UNAVAILABILITY_LABELS,
  ROUTE_SKIP_REASONS,
  ROUTE_SKIP_REASON_LABELS,
  ROUTE_SUBTREE_UNEXPANDED_LABELS,
  ROUTE_SUBTREE_UNEXPANDED_REASONS,
  ROUTE_TABLE_PROBES,
  ROUTE_TABLE_SCRIPT,
  ROUTE_TEMPLATE_GRADES,
  ROUTE_TEMPLATE_GRADE_LABELS,
  attemptIsConsistent,
  extractRouteManifest,
  isGroundTruth,
  normaliseTemplate,
  readAppBuildManifest,
  readAssetManifest,
  readBuildManifest,
  readModuleGraph,
  readRouteTable,
  readRoutesManifest,
  readSourceMap,
  routeManifestSurfaceItems,
  templateFromSourcePath,
  templateParams,
  templateSegment,
  templatesOf,
  toTemplate,
  type RawRouteNode,
  type RouteExtractor,
  type RouteManifest,
  type RouteManifestOptions,
  type RouteTableProbeResult,
  type RouteTableReader,
} from './route-manifest.js';

const BASE = 'https://app.example.com';

/** A fetcher backed by a map, so the whole run happens without a socket. */
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

/** A page whose one `evaluate` returns the probe result it was built with. */
function readerFor(probe: Partial<RouteTableProbeResult>): RouteTableReader {
  return {
    async evaluate<T>(): Promise<T> {
      return {
        probed: [...ROUTE_TABLE_PROBES],
        vue: null,
        angular: null,
        react: null,
        errors: [],
        ...probe,
      } as unknown as T;
    },
  };
}

function probeResult(overrides: Partial<RouteTableProbeResult> = {}): RouteTableProbeResult {
  return {
    probed: [...ROUTE_TABLE_PROBES],
    vue: null,
    angular: null,
    react: null,
    errors: [],
    ...overrides,
  };
}

function options(overrides: Partial<RouteManifestOptions> = {}): RouteManifestOptions {
  return { baseUrl: BASE, fetcher: null, reader: null, ...overrides };
}

const ROUTES_MANIFEST = JSON.stringify({
  version: 3,
  basePath: '',
  staticRoutes: [{ page: '/' }, { page: '/orders' }, { page: '/_error' }],
  dynamicRoutes: [{ page: '/orders/[id]' }, { page: '/docs/[...slug]' }],
  dataRoutes: [{ page: '/orders/[id]', dataRouteRegex: 'x' }],
  redirects: [{ source: '/old-orders', destination: '/orders' }],
});

// ─── Vocabulary parity ───────────────────────────────────────────────────────

describe('the vocabularies', () => {
  /*
   * Eight GateRule kinds shipped unsaveable for two slices because only one of
   * the compiler-enforced record and the run-time parity test existed. Every
   * closed list in this module gets both: a `Record<Union, string>` the
   * compiler refuses to let drift, and this test asserting the keys ARE the
   * list rather than a superset that happens to compile.
   */
  it('label every member of every list, with no extras', () => {
    expect(Object.keys(ROUTE_EXTRACTOR_LABELS).sort()).toEqual([...ROUTE_EXTRACTORS].sort());
    expect(Object.keys(ROUTE_EXTRACTOR_NEEDS).sort()).toEqual([...ROUTE_EXTRACTORS].sort());
    expect(Object.keys(EXTRACTOR_GRADE).sort()).toEqual([...ROUTE_EXTRACTORS].sort());
    expect(Object.keys(ROUTE_TEMPLATE_GRADE_LABELS).sort()).toEqual(
      [...ROUTE_TEMPLATE_GRADES].sort(),
    );
    expect(Object.keys(ROUTE_EXTRACTOR_STATE_LABELS).sort()).toEqual(
      [...ROUTE_EXTRACTOR_STATES].sort(),
    );
    expect(Object.keys(ROUTE_MANIFEST_CAP_LABELS).sort()).toEqual([...ROUTE_MANIFEST_CAPS].sort());
    expect(Object.keys(ROUTE_MANIFEST_CAP_AS_CRAWL_CAP).sort()).toEqual(
      [...ROUTE_MANIFEST_CAPS].sort(),
    );
    expect(Object.keys(ROUTE_SKIP_REASON_LABELS).sort()).toEqual([...ROUTE_SKIP_REASONS].sort());
    expect(Object.keys(ROUTE_SUBTREE_UNEXPANDED_LABELS).sort()).toEqual(
      [...ROUTE_SUBTREE_UNEXPANDED_REASONS].sort(),
    );
    expect(Object.keys(ROUTE_MANIFEST_UNAVAILABILITY_LABELS).sort()).toEqual(
      [...ROUTE_MANIFEST_UNAVAILABILITIES].sort(),
    );
  });

  it('grade the module graph as producing no templates at all', () => {
    // The null is load-bearing: a chunk name is not a route, and a grade here
    // would invite `/orders-detail` to be invented from `OrdersDetail-a1.js`.
    expect(EXTRACTOR_GRADE.MODULE_GRAPH).toBeNull();
    const producers = ROUTE_EXTRACTORS.filter((e) => EXTRACTOR_GRADE[e] !== null);
    expect(producers).not.toContain('MODULE_GRAPH');
    expect(producers.length).toBe(ROUTE_EXTRACTORS.length - 1);
  });

  it('never mints a template from a chunk name', () => {
    /*
     * The one behaviour the null grade buys. `OrdersDetail-a1b2.js` is a chunk;
     * `/orders-detail` would be a route we invented, and it would sit in a
     * customer's gap list looking exactly like a declared one.
     *
     * NOT TESTED, said plainly: the `throw` inside the template builder for a
     * null-graded extractor is an assertion on an unreachable path — the
     * builder is private and no caller passes MODULE_GRAPH to it. A test that
     * forced it would prove the `throw` statement executes, which nobody
     * doubts, and would measure nothing about the behaviour above.
     */
    const read = readModuleGraph('u', '<script src="/assets/OrdersDetail-a1b2.js"></script>');
    expect(read.templates).toEqual([]);
    expect(read.scriptCandidates).toEqual(['/assets/OrdersDetail-a1b2.js']);
  });

  it('keep the in-page extractors in one group, so a missing reader is UNAVAILABLE', () => {
    const inPage = ROUTE_EXTRACTORS.filter((e) => ROUTE_EXTRACTOR_NEEDS[e] === 'IN_PAGE');
    expect(inPage).toEqual(['VUE_ROUTER', 'ANGULAR_ROUTER', 'REACT_ROUTER']);
  });

  it('declare the manifest source as CATALOGUE, which lands on the DECLARED side', () => {
    /*
     * Not CRAWL. Reading `_buildManifest.js` observes that the manifest
     * answered, never that `/orders/:id` did — and CRAWL would put a route
     * nothing has requested into the observed half of `originFromSources`,
     * where it reads as BOTH and the product's headline sentence stops being
     * true.
     */
    expect(SURFACE_SOURCES).toContain(ROUTE_MANIFEST_SOURCE);
    expect(ROUTE_MANIFEST_SOURCE).toBe('CATALOGUE');
    expect(originFromSources([ROUTE_MANIFEST_SOURCE])).toBe('SOURCE_ONLY');
  });

  it('treat only DECLARED and DERIVED as statable without hedging', () => {
    expect(GROUND_TRUTH_GRADES).toEqual(['DECLARED', 'DERIVED']);
    expect(isGroundTruth('DECLARED')).toBe(true);
    expect(isGroundTruth('DERIVED')).toBe(true);
    expect(isGroundTruth('INFERRED')).toBe(false);
  });

  it('name every probe the in-page script actually runs', () => {
    // Script/module drift makes a whole framework report zero routes forever,
    // and zero routes looks exactly like an app with no client routing.
    for (const probe of ROUTE_TABLE_PROBES) {
      expect(ROUTE_TABLE_SCRIPT).toContain(`'${probe}'`);
    }
    const quoted = [...ROUTE_TABLE_SCRIPT.matchAll(/probe\('([A-Z_]+)'/g)].map((m) => m[1]!);
    expect([...new Set(quoted)].sort()).toEqual([...ROUTE_TABLE_PROBES].sort());
  });

  it('never evaluate a fetched script', () => {
    // Running JavaScript fetched off the customer's origin would make this an
    // arbitrary-code path aimed wherever they serve. `sortedPages` is read with
    // a regex for exactly this reason.
    const source = readBuildManifest.toString();
    expect(source).not.toMatch(/\beval\(|new Function\(/);
  });
});

// ─── Template normalisation ──────────────────────────────────────────────────

describe('templates, which are not URLs', () => {
  it('keep the dynamic segment NAME, in every router spelling', () => {
    expect(templateSegment('[id]')).toBe(':id');
    expect(templateSegment('[...slug]')).toBe(':slug*');
    expect(templateSegment('[[...slug]]')).toBe(':slug*');
    expect(templateSegment('{id}')).toBe(':id');
    expect(templateSegment('{...rest}')).toBe(':rest*');
    expect(templateSegment(':id')).toBe(':id');
    expect(templateSegment(':id?')).toBe(':id');
    expect(templateSegment(':slug*')).toBe(':slug*');
    expect(templateSegment('**')).toBe('*');
    expect(templateSegment('orders')).toBe('orders');
  });

  it('fold the six spellings of one route onto one template', () => {
    // A list assembled from six documents has all of them in it, and a reader
    // comparing /docs/[...slug] with /docs/:slug* has to be told they are one.
    expect(toTemplate('/docs/[...slug]')).toBe('/docs/:slug*');
    expect(toTemplate('docs/:slug*')).toBe('/docs/:slug*');
    expect(toTemplate('/orders/[id]/')).toBe('/orders/:id');
    expect(toTemplate('/orders/{id}?x=1#y')).toBe('/orders/:id');
    expect(normaliseTemplate('')).toBe('/');
    expect(normaliseTemplate('///a//b/')).toBe('/a/b');
  });

  it('name the parameters in order and flag the catch-all', () => {
    expect(templateParams('/orders/:orderId/lines/:lineId')).toEqual({
      params: ['orderId', 'lineId'],
      catchAll: false,
    });
    expect(templateParams('/docs/:slug*')).toEqual({ params: ['slug'], catchAll: true });
    expect(templateParams('/admin/*')).toEqual({ params: ['*'], catchAll: true });
    expect(templateParams('/orders')).toEqual({ params: [], catchAll: false });
  });

  it('refuse to guess a route out of a component', () => {
    /*
     * The whole defence against INFERRED garbage. Every rejection below is a
     * route that would otherwise appear in a customer's uncovered list and 404
     * when they clicked it — and they only have to see that once.
     */
    expect(templateFromSourcePath('src/pages/orders/[id].tsx')).toBe('/orders/:id');
    expect(templateFromSourcePath('src/pages/index.tsx')).toBe('/');
    expect(templateFromSourcePath('webpack:///./src/pages/orders/index.vue')).toBe('/orders');
    expect(templateFromSourcePath('src/app/orders/[id]/page.tsx')).toBe('/orders/:id');
    expect(templateFromSourcePath('src/app/(shop)/cart/page.tsx')).toBe('/cart');

    expect(templateFromSourcePath('src/components/OrderRow.tsx')).toBeNull();
    expect(templateFromSourcePath('src/pages/components/Row.tsx')).toBeNull();
    expect(templateFromSourcePath('src/hooks/useOrder.ts')).toBeNull();
    expect(templateFromSourcePath('src/pages/_app.tsx')).toBeNull();
    // Under app/, only a `page` module is a page: colocated UI is not a route.
    expect(templateFromSourcePath('src/app/orders/Row.tsx')).toBeNull();
    expect(templateFromSourcePath('src/app/orders/layout.tsx')).toBeNull();
    expect(templateFromSourcePath('src/lib/orders.ts')).toBeNull();
    expect(templateFromSourcePath('src/pages/orders/styles.css')).toBeNull();
    expect(templateFromSourcePath('vendor/thing.js')).toBeNull();
  });
});

// ─── routes-manifest.json: the strongest answer ─────────────────────────────

describe('routes-manifest.json', () => {
  it('read static and dynamic pages as DECLARED, and drop the plumbing loudly', () => {
    const read = readRoutesManifest('u', ROUTES_MANIFEST);
    expect(read.failure).toBeNull();
    expect(read.templates.map((t) => t.template)).toEqual([
      '/',
      '/orders',
      '/orders/:id',
      '/docs/:slug*',
    ]);
    for (const t of read.templates) expect(t.grade).toBe('DECLARED');

    const plumbing = read.skipped.find((s) => s.reason === 'FRAMEWORK_PLUMBING');
    expect(plumbing).toEqual({
      extractor: 'NEXT_ROUTES_MANIFEST',
      reason: 'FRAMEWORK_PLUMBING',
      count: 1,
      examples: ['/_error'],
    });
  });

  it('apply basePath, or the whole denominator 404s', () => {
    const read = readRoutesManifest(
      'u',
      JSON.stringify({ basePath: '/app', staticRoutes: [{ page: '/orders' }], dynamicRoutes: [] }),
    );
    expect(read.templates[0]!.template).toBe('/app/orders');
    // The manifest's own spelling survives, so the arithmetic is auditable.
    expect(read.templates[0]!.declaredAs).toBe('/orders');
  });

  it('report the locales and refuse to multiply by them', () => {
    /*
     * Four locales on 412 templates would be 1,648 items of cross product we
     * invented. The LOCALE axis already exists as a `SurfaceDimension`, and the
     * multiplication belongs there, computed once.
     */
    const read = readRoutesManifest(
      'u',
      JSON.stringify({
        staticRoutes: [{ page: '/orders' }],
        dynamicRoutes: [],
        i18n: { locales: ['en', 'de', 'fr', 'ja'], defaultLocale: 'en' },
      }),
    );
    expect(read.locales).toEqual(['en', 'de', 'fr', 'ja']);
    expect(read.templates.map((t) => t.template)).toEqual(['/orders']);
  });

  it('count data routes and redirect rules rather than dropping them', () => {
    const read = readRoutesManifest('u', ROUTES_MANIFEST);
    expect(read.skipped.find((s) => s.reason === 'DATA_ROUTE')?.count).toBe(1);
    expect(read.skipped.find((s) => s.reason === 'REWRITE_OR_REDIRECT_RULE')).toEqual({
      extractor: 'NEXT_ROUTES_MANIFEST',
      reason: 'REWRITE_OR_REDIRECT_RULE',
      count: 1,
      examples: ['/old-orders'],
    });
  });

  it('say the SHAPE changed rather than reporting a route-free application', () => {
    // A manifest whose keys we do not recognise is a failure of ours. Reporting
    // it as zero routes would be our bug shown to the customer as their app.
    const renamed = readRoutesManifest('u', JSON.stringify({ version: 9, routes: [] }));
    expect(renamed.templates).toEqual([]);
    expect(renamed.failure).toContain('shape has changed');

    const broken = readRoutesManifest('u', '{not json');
    expect(broken.failure).toContain('did not parse');
  });
});

// ─── app-build-manifest.json: derived, not declared ─────────────────────────

describe('app-build-manifest.json', () => {
  const manifest = JSON.stringify({
    pages: {
      '/page': ['a.js'],
      '/layout': ['b.js'],
      '/orders/page': ['c.js'],
      '/orders/[id]/page': ['d.js'],
      '/orders/[id]/loading': ['e.js'],
      '/(shop)/cart/page': ['f.js'],
      '/@modal/photo/page': ['g.js'],
      '/_internal/debug/page': ['h.js'],
      '/api/webhooks/route': ['i.js'],
      '/not-found': ['j.js'],
    },
  });

  it('apply the segment rules and grade the result DERIVED', () => {
    const read = readAppBuildManifest('u', manifest);
    expect(read.failure).toBeNull();
    expect(read.templates.map((t) => t.template).sort()).toEqual([
      '/',
      '/cart',
      '/debug',
      '/orders',
      '/orders/:id',
      '/photo',
    ]);
    // DERIVED and not DECLARED: the module path is ground truth, the URL is our
    // arithmetic, and a segment rule we got wrong shows up as this grade.
    for (const t of read.templates) expect(t.grade).toBe('DERIVED');
  });

  it('keep a layout out of the gap list, and an endpoint out of the ROUTE axis', () => {
    const read = readAppBuildManifest('u', manifest);
    expect(read.templates.map((t) => t.template)).not.toContain('/layout');
    expect(read.skipped.find((s) => s.reason === 'NOT_ADDRESSABLE')).toEqual({
      extractor: 'NEXT_APP_BUILD_MANIFEST',
      reason: 'NOT_ADDRESSABLE',
      count: 2,
      examples: ['/layout', '/orders/[id]/loading'],
    });
    // A `route.ts` is an ENDPOINT whose METHOD this document does not state.
    // Emitting it as a ROUTE would file an endpoint on the wrong axis.
    expect(read.skipped.find((s) => s.reason === 'API_HANDLER')?.examples).toEqual([
      '/api/webhooks/route',
    ]);
  });

  it('refuse to count one URL twice when two modules claim it', () => {
    const read = readAppBuildManifest(
      'u',
      JSON.stringify({ pages: { '/(shop)/cart/page': ['a'], '/(admin)/cart/page': ['b'] } }),
    );
    expect(read.templates.map((t) => t.template)).toEqual(['/cart']);
    expect(read.skipped.find((s) => s.reason === 'UNPARSEABLE_ENTRY')?.count).toBe(1);
  });

  it('count every skip even past the three-example cap', () => {
    /*
     * The COUNT is the fact and the examples are only illustration. A reporter
     * that showed three examples and implied three occurrences would understate
     * the difference between our template count and the customer's own count
     * of their app directory — which is the number they will check us against.
     */
    const read = readAppBuildManifest(
      'u',
      JSON.stringify({
        pages: {
          '/layout': ['a'],
          '/a/layout': ['b'],
          '/b/layout': ['c'],
          '/c/layout': ['d'],
          '/d/layout': ['e'],
        },
      }),
    );
    const skip = read.skipped.find((s) => s.reason === 'NOT_ADDRESSABLE')!;
    expect(skip.count).toBe(5);
    expect(skip.examples).toEqual(['/layout', '/a/layout', '/b/layout']);
  });

  it('say the shape changed when `pages` is gone', () => {
    const read = readAppBuildManifest('u', JSON.stringify({ routes: {} }));
    expect(read.templates).toEqual([]);
    expect(read.failure).toContain('shape has');
  });
});

// ─── _buildManifest.js ───────────────────────────────────────────────────────

describe('_buildManifest.js', () => {
  const body =
    'self.__BUILD_MANIFEST={"/":["a.js"],"/orders/[id]":["b.js"],' +
    'sortedPages:["/","/404","/500","/_app","/_error","/orders/[id]"]};' +
    'self.__BUILD_MANIFEST_CB&&self.__BUILD_MANIFEST_CB();';

  it('read sortedPages as DECLARED and keep /404 and /500', () => {
    const read = readBuildManifest('u', body);
    expect(read.templates.map((t) => t.template)).toEqual(['/', '/404', '/500', '/orders/:id']);
    for (const t of read.templates) expect(t.grade).toBe('DECLARED');
    // `/404` and `/500` ARE pages a browser can request; `/_app` and `/_error`
    // are not. The same leading underscore means opposite things.
    expect(read.skipped[0]!.examples).toEqual(['/_app', '/_error']);
  });

  it('distinguish "not a build manifest" from "a build manifest we cannot read"', () => {
    expect(readBuildManifest('u', 'console.log(1)').failure).toBe(
      'the file is not a Next build manifest',
    );
    expect(readBuildManifest('u', 'self.__BUILD_MANIFEST={};').failure).toContain(
      'has no sortedPages array',
    );
  });

  it('treat a genuinely empty sortedPages as a read, not a failure', () => {
    const read = readBuildManifest('u', 'self.__BUILD_MANIFEST={sortedPages:[]};');
    expect(read.failure).toBeNull();
    expect(read.templates).toEqual([]);
  });
});

// ─── asset manifests and the module graph ───────────────────────────────────

describe('asset manifests and the module graph', () => {
  it("say a CRA manifest lists build files, and never guess a route from one", () => {
    const read = readAssetManifest(
      'u',
      JSON.stringify({
        files: { 'main.js': '/static/js/main.abc.js', 'main.css': '/static/css/main.css' },
        entrypoints: ['static/js/main.abc.js'],
      }),
    );
    expect(read.templates).toEqual([]);
    expect(read.skipped[0]!.reason).toBe('NOT_A_ROUTE_DOCUMENT');
    // What it IS good for: the scripts the source-map pass will ask about.
    expect(read.scriptCandidates).toEqual(['/static/js/main.abc.js']);
  });

  it('read a Vite entry map as INFERRED, because nothing says the app routes there', () => {
    const read = readAssetManifest(
      'u',
      JSON.stringify({
        'src/pages/orders/[id].tsx': { file: 'assets/Order-a1.js', src: 'src/pages/orders/[id].tsx', isEntry: true },
        'src/components/Row.tsx': { file: 'assets/Row-b2.js', src: 'src/components/Row.tsx' },
      }),
    );
    expect(read.templates.map((t) => [t.template, t.grade, t.file])).toEqual([
      ['/orders/:id', 'INFERRED', 'src/pages/orders/[id].tsx'],
    ]);
    expect(read.scriptCandidates).toEqual(['assets/Order-a1.js', 'assets/Row-b2.js']);
  });

  it('produce zero templates from a module graph, and the buildId it is there for', () => {
    const html = `<!doctype html><html><head>
      <script type="module" src="/assets/index-a1b2.js"></script>
      <link rel="modulepreload" href="/assets/Orders-c3d4.js">
      <link rel="stylesheet" href="/assets/index.css">
      <script src="/_next/static/BUILD123/_buildManifest.js" defer></script>
      <img src="/logo.png">
      </head><body><script id="__NEXT_DATA__">{"buildId":"BUILD123"}</script></body></html>`;
    const read = readModuleGraph('u', html);
    // A chunk named Orders-c3d4.js is a chunk. `/orders` would be our invention.
    expect(read.templates).toEqual([]);
    expect(read.buildId).toBe('BUILD123');
    expect(read.scriptCandidates).toEqual([
      '/assets/index-a1b2.js',
      '/assets/Orders-c3d4.js',
      '/_next/static/BUILD123/_buildManifest.js',
    ]);
    // A stylesheet and an image are not scripts and are not routes.
    expect(read.scriptCandidates).not.toContain('/assets/index.css');
    expect(read.scriptCandidates).not.toContain('/logo.png');
    expect(read.skipped[0]!.reason).toBe('NOT_A_ROUTE_DOCUMENT');
  });

  it('keep a non-script out of the candidates even when the tag looks right', () => {
    /*
     * The `rel` filter is NOT what excludes a stylesheet here — a
     * `modulepreload` of a `.css` file and a `<script src>` pointing at JSON
     * both pass it, and only the extension check stops them. A `.css` in the
     * candidate list becomes a `.css.map` request and then a parse failure
     * attributed to the source-map extractor: our noise, reported as a finding
     * about their application.
     */
    const read = readModuleGraph(
      'u',
      '<link rel="modulepreload" href="/assets/style.css">' +
        '<script src="/assets/data.json"></script>' +
        '<script type="module" src="/assets/real.mjs"></script>',
    );
    expect(read.scriptCandidates).toEqual(['/assets/real.mjs']);
  });

  it('find the buildId from __NEXT_DATA__ when no manifest script is in the markup', () => {
    const read = readModuleGraph('u', '<script>{"buildId":"XYZ"}</script>');
    expect(read.buildId).toBe('XYZ');
  });
});

// ─── source maps: the last resort ────────────────────────────────────────────

describe('source maps', () => {
  it('grade every template INFERRED and keep the file, which IS ground truth', () => {
    const read = readSourceMap('/a.js.map', JSON.stringify({
      version: 3,
      sources: [
        'webpack:///./src/pages/orders/[id].tsx',
        'webpack:///./src/components/OrderRow.tsx',
        'webpack:///./node_modules/react/index.js',
      ],
    }));
    expect(read.templates.map((t) => [t.template, t.grade, t.file])).toEqual([
      ['/orders/:id', 'INFERRED', 'src/pages/orders/[id].tsx'],
    ]);
  });

  it('apply sourceRoot', () => {
    const read = readSourceMap('/a.js.map', JSON.stringify({
      sourceRoot: 'src/',
      sources: ['pages/orders/index.tsx'],
    }));
    expect(read.templates.map((t) => t.template)).toEqual(['/orders']);
  });

  it('say "not a source map" rather than reporting no routes', () => {
    expect(readSourceMap('/a.map', '{"version":3}').failure).toContain('not a source map');
    expect(readSourceMap('/a.map', 'nope').failure).toContain('did not parse');
  });
});

// ─── the route tables the running app hands over ────────────────────────────

describe('the in-page route tables', () => {
  it('take Vue getRoutes() flat, because it already contains the children', () => {
    // Walking it as a tree would double-count every child: Vue returns the
    // parents AND the children in one list, with absolute paths on both.
    const read = readRouteTable(
      probeResult({
        vue: [
          { path: '/', name: 'home', children: [{ path: '/orders', name: 'orders' }] },
          { path: '/orders', name: 'orders' },
          { path: '/orders/:id', name: 'order' },
        ],
      }),
    );
    expect(read.templates.map((t) => t.template)).toEqual(['/', '/orders', '/orders/:id']);
    expect(read.templates.map((t) => t.name)).toEqual(['home', 'orders', 'order']);
    for (const t of read.templates) expect(t.extractor).toBe('VUE_ROUTER');
  });

  it("join Angular's relative paths down the tree", () => {
    const read = readRouteTable(
      probeResult({
        angular: [
          { path: '', redirectTo: '/orders' },
          {
            path: 'orders',
            children: [
              { path: '', index: false },
              { path: ':id', children: [{ path: 'lines' }] },
            ],
          },
          { path: '**', name: 'notFound' },
        ],
      }),
    );
    /*
     * `{path:'orders', children:[{path:''}]}` is ONE URL — the child component
     * renders at the parent's own path — so it appears once. Emitting it twice
     * would double-count `/orders` in the denominator, which is the mirror of
     * the truncation defect: a route counted twice makes the percentage lower
     * than it is and the named list wrong.
     */
    expect(read.templates.map((t) => t.template)).toEqual([
      '/',
      '/orders',
      '/orders/:id',
      '/orders/:id/lines',
      '/*',
    ]);
    // The redirect is recorded as a redirect, not silently merged into a page.
    expect(read.templates[0]!.redirectsTo).toBe('/orders');
    expect(read.templates[1]!.redirectsTo).toBeNull();
  });

  it('keep a redirect and a page at one path apart', () => {
    // Same URL, two different declarations: one redirects and one renders. The
    // dedupe key carries the destination so a redirect never swallows a page.
    const read = readRouteTable(
      probeResult({ angular: [{ path: 'go', redirectTo: '/orders' }, { path: 'go' }] }),
    );
    expect(read.templates.map((t) => [t.template, t.redirectsTo])).toEqual([
      ['/go', '/orders'],
      ['/go', null],
    ]);
  });

  it('report a lazy subtree, because silence turns 412 routes into 9', () => {
    const read = readRouteTable(
      probeResult({ angular: [{ path: 'admin', lazy: true, children: [] }] }),
    );
    expect(read.unexpanded).toEqual([
      {
        extractor: 'ANGULAR_ROUTER',
        parent: '/admin',
        reason: 'LAZY_MODULE',
        detail: expect.stringContaining('at least one route below it exists'),
      },
    ]);
  });

  it('call a React lazy route object by its own name', () => {
    const read = readRouteTable(probeResult({ react: [{ path: 'reports', lazy: true }] }));
    expect(read.unexpanded[0]!.reason).toBe('LAZY_ROUTE_OBJECT');
  });

  it("flatten React Router's parentId chain", () => {
    const read = readRouteTable(
      probeResult({
        react: [
          { id: 'root', parentId: null, path: '/' },
          { id: 'orders', parentId: 'root', path: 'orders' },
          { id: 'orders.index', parentId: 'orders', path: null, index: true },
          { id: 'order', parentId: 'orders', path: ':id' },
        ],
      }),
    );
    // `orders.index` resolves to `/orders`, which `orders` already declared:
    // one URL, one item in the denominator.
    expect(read.templates.map((t) => t.template)).toEqual(['/', '/orders', '/orders/:id']);
    expect(read.templates.map((t) => t.name)).toEqual(['root', 'orders', 'order']);
  });

  it('skip a cyclic or orphaned parent chain rather than guessing a URL', () => {
    const read = readRouteTable(
      probeResult({
        react: [
          { id: 'a', parentId: 'b', path: 'a' },
          { id: 'b', parentId: 'a', path: 'b' },
          { id: 'c', parentId: 'missing', path: 'c' },
          { id: 'ok', parentId: null, path: '/ok' },
        ],
      }),
    );
    expect(read.templates.map((t) => t.template)).toEqual(['/ok']);
  });

  it('walk nested React route objects when there is no parentId', () => {
    const read = readRouteTable(
      probeResult({
        react: [{ path: '/', children: [{ path: 'settings', children: [{ index: true, path: null }] }] }],
      }),
    );
    expect(read.templates.map((t) => t.template)).toEqual(['/', '/settings']);
  });

  it('skip a pathless layout route, which has no URL of its own', () => {
    const read = readRouteTable(
      probeResult({ react: [{ path: null, children: [{ path: '/dash' }] }] }),
    );
    expect(read.templates.map((t) => t.template)).toEqual(['/dash']);
  });

  it('bite the depth cap visibly, with the count of what it cost', () => {
    let deepest: RawRouteNode = { path: 'leaf' };
    for (let i = 0; i < 6; i++) deepest = { path: `n${i}`, children: [deepest] };
    const read = readRouteTable(probeResult({ angular: [deepest] }), { treeDepth: 2 });
    const bite = read.caps.find((c) => c.cap === 'ROUTE_TREE_DEPTH');
    expect(bite).toBeDefined();
    expect(bite!.limit).toBe(2);
    expect(bite!.discarded).toBeGreaterThan(0);
    expect(bite!.reason).toContain('at least that many more routes exist');
  });

  it('flag a probe this module does not know, rather than ignoring it', () => {
    const read = readRouteTable(
      probeResult({ probed: ['VUE_APP_ROOT', 'SOLID_ROUTER' as never] }),
    );
    expect(read.unknownProbes).toEqual(['SOLID_ROUTER']);
  });
});

// ─── The orchestrator: four answers, never an empty list ────────────────────

describe('extractRouteManifest', () => {
  it('report NOTHING_LOOKED when neither capability was injected', async () => {
    const manifest = await extractRouteManifest(options());
    expect(manifest.state).toBe('NOT_AVAILABLE');
    if (manifest.state !== 'NOT_AVAILABLE') throw new Error('unreachable');
    expect(manifest.reason).toBe('NOTHING_LOOKED');
    expect(manifest.detail).toBe(ROUTE_MANIFEST_UNAVAILABILITY_LABELS.NOTHING_LOOKED);
    // Every extractor still appears, as UNAVAILABLE — not ABSENT, which would
    // be a claim about the customer's application we never made.
    expect(manifest.attempts.length).toBe(ROUTE_EXTRACTORS.length);
    for (const attempt of manifest.attempts) expect(attempt.state).toBe('UNAVAILABLE');
    expect(templatesOf(manifest)).toEqual([]);
  });

  it('report NO_EXTRACTOR_APPLIED when everything 404s', async () => {
    const manifest = await extractRouteManifest(
      options({ fetcher: fetcherFor({}), reader: readerFor({}) }),
    );
    expect(manifest.state).toBe('NOT_AVAILABLE');
    if (manifest.state !== 'NOT_AVAILABLE') throw new Error('unreachable');
    expect(manifest.reason).toBe('NO_EXTRACTOR_APPLIED');
    // "The app does not expose a Vue router" is a real finding; it needed the
    // reader to be present to be sayable at all.
    const vue = manifest.attempts.find((a) => a.extractor === 'VUE_ROUTER')!;
    expect(vue.state).toBe('ABSENT');
    expect(vue.reason).toContain('exposes no router of this kind');
  });

  it('report ALL_EXTRACTORS_FAILED when a document was served and could not be read', async () => {
    const manifest = await extractRouteManifest(
      options({
        fetcher: fetcherFor({
          [`${BASE}/_next/routes-manifest.json`]: { status: 200, body: '{not json' },
        }),
      }),
    );
    expect(manifest.state).toBe('NOT_AVAILABLE');
    if (manifest.state !== 'NOT_AVAILABLE') throw new Error('unreachable');
    expect(manifest.reason).toBe('ALL_EXTRACTORS_FAILED');
  });

  it('report EMPTY, attributed, when a real table declares nothing', async () => {
    /*
     * The one case where "this application has no client routes" is TRUE. It is
     * a separate state from NOT_AVAILABLE so that a caller cannot print it over
     * a read that failed, and it names the document so the sentence is
     * attributable rather than asserted.
     */
    const manifest = await extractRouteManifest(
      options({
        fetcher: fetcherFor({
          [`${BASE}/_next/routes-manifest.json`]: {
            status: 200,
            body: JSON.stringify({ staticRoutes: [], dynamicRoutes: [] }),
          },
        }),
      }),
    );
    expect(manifest.state).toBe('EMPTY');
    if (manifest.state !== 'EMPTY') throw new Error('unreachable');
    expect(manifest.readDocument).toBe(`${BASE}/_next/routes-manifest.json`);
    expect(manifest.complete).toBe(false);
    expect(manifest.incomplete.join(' ')).toContain('was not consulted');
  });

  it('read a Next app end to end, and never claim complete over a partial read', async () => {
    const manifest = await extractRouteManifest(
      options({
        fetcher: fetcherFor({
          [`${BASE}/`]: {
            status: 200,
            body: '<script src="/_next/static/B1/_buildManifest.js"></script>',
          },
          [`${BASE}/_next/routes-manifest.json`]: { status: 200, body: ROUTES_MANIFEST },
          [`${BASE}/_next/static/B1/_buildManifest.js`]: {
            status: 200,
            body: 'self.__BUILD_MANIFEST={sortedPages:["/","/orders/[id]","/legacy"]};',
          },
        }),
        reader: readerFor({}),
      }),
    );
    expect(manifest.state).toBe('READ');
    if (manifest.state !== 'READ') throw new Error('unreachable');
    expect(manifest.templates.map((t) => t.template).sort()).toEqual([
      '/',
      '/docs/:slug*',
      '/legacy',
      '/orders',
      '/orders/:id',
    ]);
    /*
     * COMPLETE, and the reason is the distinction this module turns on: every
     * one of the nine ways of asking was tried and every one ANSWERED. The
     * documents that 404'd are ABSENT — "we asked and it is not served" is a
     * finished answer about the application. Only UNAVAILABLE (we could not
     * ask) and FAILED (we asked and could not read the reply) leave a hole,
     * and only those two make `complete` false.
     */
    expect(manifest.complete).toBe(true);
    expect(manifest.incomplete).toEqual([]);
    expect(manifest.attempts.some((a) => a.state === 'ABSENT')).toBe(true);
    expect(manifest.attempts.some((a) => a.state === 'UNAVAILABLE')).toBe(false);
    expect(manifest.attempts.some((a) => a.state === 'FAILED')).toBe(false);
  });

  it('read every page of a dynamic Pages Router app, which the first parser truncated', async () => {
    /*
     * The regression test for the worst defect this module had. A `]` inside
     * `/orders/[id]` ended the first regex's match, so every page AFTER the
     * first dynamic route vanished — a Next app would have reported three
     * static pages as its complete route table, and a smaller denominator
     * with the same numerator is a HIGHER coverage percentage with nothing on
     * screen to explain it.
     */
    const manifest = await extractRouteManifest(
      options({
        extractors: ['MODULE_GRAPH', 'NEXT_BUILD_MANIFEST'],
        fetcher: fetcherFor({
          [`${BASE}/`]: { status: 200, body: '<script src="/_next/static/B1/_buildManifest.js">' },
          [`${BASE}/_next/static/B1/_buildManifest.js`]: {
            status: 200,
            body:
              'self.__BUILD_MANIFEST={"/orders/[id]":["b.js"],' +
              'sortedPages:["/","/orders/[id]","/docs/[...slug]","/legacy"]};',
          },
        }),
      }),
    );
    expect(templatesOf(manifest).map((t) => t.template)).toEqual([
      '/',
      '/orders/:id',
      '/docs/:slug*',
      '/legacy',
    ]);
  });

  it('call a truncated sortedPages a FAILED read, not a short list', async () => {
    const manifest = await extractRouteManifest(
      options({
        extractors: ['MODULE_GRAPH', 'NEXT_BUILD_MANIFEST'],
        fetcher: fetcherFor({
          [`${BASE}/`]: { status: 200, body: '<script src="/_next/static/B1/_buildManifest.js">' },
          [`${BASE}/_next/static/B1/_buildManifest.js`]: {
            status: 200,
            body: 'self.__BUILD_MANIFEST={sortedPages:["/","/orders',
          },
        }),
      }),
    );
    const attempt = manifest.attempts.find((a) => a.extractor === 'NEXT_BUILD_MANIFEST')!;
    expect(attempt.state).toBe('FAILED');
    expect(attempt.found).toBeNull();
    expect(attempt.reason).toContain('truncated');
  });

  it('say the Pages manifest has no address rather than pretending it is absent', async () => {
    const manifest = await extractRouteManifest(
      options({ fetcher: fetcherFor({ [`${BASE}/`]: { status: 200, body: '<html></html>' } }) }),
    );
    const attempt = manifest.attempts.find((a) => a.extractor === 'NEXT_BUILD_MANIFEST')!;
    expect(attempt.state).toBe('ABSENT');
    expect(attempt.reason).toContain('no buildId');
  });

  it('keep the DECLARED reading when two documents declare one route', async () => {
    /*
     * A Next app serves both documents. Keeping both would double-count the
     * route in the denominator; keeping the weaker one would show a guess
     * where ground truth was available.
     */
    const manifest = await extractRouteManifest(
      options({
        fetcher: fetcherFor({
          [`${BASE}/`]: { status: 200, body: '<script src="/a.js"></script>' },
          [`${BASE}/_next/routes-manifest.json`]: {
            status: 200,
            body: JSON.stringify({ staticRoutes: [{ page: '/orders' }], dynamicRoutes: [] }),
          },
          [`${BASE}/a.js.map`]: {
            status: 200,
            body: JSON.stringify({ sources: ['src/pages/orders/index.tsx'] }),
          },
        }),
      }),
    );
    expect(manifest.state).toBe('READ');
    if (manifest.state !== 'READ') throw new Error('unreachable');
    const orders = manifest.templates.filter((t) => t.template === '/orders');
    expect(orders.length).toBe(1);
    expect(orders[0]!.grade).toBe('DECLARED');
  });

  it('UPGRADE a guess when a later extractor declares the same route', async () => {
    /*
     * The other direction, and the one the extractor ORDER makes reachable:
     * the asset manifest (INFERRED) is read before the running app's own
     * router (DECLARED). Without the upgrade the route would be stored as a
     * guess although ground truth for it arrived moments later — the item
     * would sit out of the defensible denominator by default, which
     * UNDERSTATES what QAAI can prove about the application.
     *
     * A mutation that kept the incumbent survived the first version of this
     * block, because that one only ever fed the stronger reading first.
     */
    const manifest = await extractRouteManifest(
      options({
        extractors: ['ASSET_MANIFEST', 'VUE_ROUTER'],
        fetcher: fetcherFor({
          [`${BASE}/asset-manifest.json`]: {
            status: 200,
            body: JSON.stringify({
              'src/pages/orders/index.vue': { file: 'a.js', src: 'src/pages/orders/index.vue' },
            }),
          },
        }),
        reader: readerFor({ vue: [{ path: '/orders', name: 'orders' }] }),
      }),
    );
    expect(manifest.state).toBe('READ');
    const orders = templatesOf(manifest).filter((t) => t.template === '/orders');
    expect(orders.length).toBe(1);
    expect(orders[0]!.grade).toBe('DECLARED');
    expect(orders[0]!.extractor).toBe('VUE_ROUTER');
  });

  it('never double-count a route two extractors both declare', async () => {
    // A Next app with both routers serves the route in two documents. Counting
    // it twice makes the denominator larger than the application.
    const manifest = await extractRouteManifest(
      options({
        fetcher: fetcherFor({
          [`${BASE}/`]: { status: 200, body: '<script src="/_next/static/B1/_buildManifest.js">' },
          [`${BASE}/_next/app-build-manifest.json`]: {
            status: 200,
            body: JSON.stringify({ pages: { '/orders/page': ['a'] } }),
          },
          [`${BASE}/_next/static/B1/_buildManifest.js`]: {
            status: 200,
            body: 'self.__BUILD_MANIFEST={sortedPages:["/orders"]};',
          },
        }),
      }),
    );
    const all = templatesOf(manifest);
    expect(all.map((t) => t.template)).toEqual(['/orders']);
    // DECLARED beats the DERIVED reading that arrived first.
    expect(all[0]!.grade).toBe('DECLARED');
  });

  it('bite the source-map budget visibly', async () => {
    const scripts = Array.from({ length: 5 }, (_, i) => `/a${i}.js`);
    const manifest = await extractRouteManifest(
      options({
        sourceMapBudget: 2,
        fetcher: fetcherFor({
          [`${BASE}/`]: {
            status: 200,
            body: scripts.map((s) => `<script src="${s}"></script>`).join(''),
          },
        }),
      }),
    );
    const bite = manifest.caps.find((c) => c.cap === 'SOURCE_MAP_BUDGET')!;
    expect(bite.limit).toBe(2);
    expect(bite.discarded).toBe(3);
    expect(bite.reason).toContain('at least 3 more maps exist');
  });

  it('bite the template budget visibly', async () => {
    const manifest = await extractRouteManifest(
      options({
        templateBudget: 2,
        fetcher: fetcherFor({
          [`${BASE}/_next/routes-manifest.json`]: { status: 200, body: ROUTES_MANIFEST },
        }),
      }),
    );
    const bite = manifest.caps.find((c) => c.cap === 'TEMPLATE_BUDGET')!;
    expect(bite.discarded).toBe(2);
    expect(bite.reason).toContain('more templates were declared');
  });

  it('bite the document budget, and say nothing is known about what it skipped', async () => {
    const manifest = await extractRouteManifest(
      options({
        documentBudget: 1,
        fetcher: fetcherFor({ [`${BASE}/`]: { status: 200, body: '<html></html>' } }),
      }),
    );
    const bite = manifest.caps.find((c) => c.cap === 'DOCUMENT_BUDGET')!;
    expect(bite.discarded).toBeGreaterThan(0);
    expect(bite.reason).toContain('nothing is known about them');
    const skippedAttempt = manifest.attempts.find(
      (a) => a.state === 'FAILED' && a.reason?.includes('document budget'),
    );
    expect(skippedAttempt).toBeDefined();
  });

  it('call a transport failure a FAILED read, never an absence', async () => {
    const manifest = await extractRouteManifest(
      options({
        extractors: ['NEXT_ROUTES_MANIFEST'],
        fetcher: {
          async get() {
            return { status: null, body: null, error: 'ECONNREFUSED' };
          },
        },
      }),
    );
    const attempt = manifest.attempts[0]!;
    expect(attempt.state).toBe('FAILED');
    expect(attempt.found).toBeNull();
    expect(attempt.reason).toContain('ECONNREFUSED');
  });

  it('survive a fetcher that throws, which it is documented never to do', async () => {
    const manifest = await extractRouteManifest(
      options({
        extractors: ['NEXT_ROUTES_MANIFEST'],
        fetcher: {
          async get() {
            throw new Error('boom');
          },
        },
      }),
    );
    expect(manifest.attempts[0]!.state).toBe('FAILED');
    expect(manifest.attempts[0]!.reason).toContain('boom');
  });

  it('call an in-page probe that threw a FAILED read, not an absent router', async () => {
    const manifest = await extractRouteManifest(
      options({
        extractors: ['VUE_ROUTER', 'ANGULAR_ROUTER'],
        reader: readerFor({
          errors: [{ probe: 'VUE_APP_ROOT', message: 'illegal invocation' }],
        }),
      }),
    );
    const vue = manifest.attempts.find((a) => a.extractor === 'VUE_ROUTER')!;
    expect(vue.state).toBe('FAILED');
    expect(vue.reason).toContain('illegal invocation');
    // The Angular probe did not throw, so its silence IS an answer.
    expect(manifest.attempts.find((a) => a.extractor === 'ANGULAR_ROUTER')!.state).toBe('ABSENT');
  });

  it('call an evaluate that rejected a FAILED read for every in-page extractor', async () => {
    const manifest = await extractRouteManifest(
      options({
        reader: {
          async evaluate<T>(): Promise<T> {
            throw new Error('page closed');
          },
        },
      }),
    );
    const inPage = manifest.attempts.filter((a) => ROUTE_EXTRACTOR_NEEDS[a.extractor] === 'IN_PAGE');
    expect(inPage.length).toBe(3);
    for (const attempt of inPage) {
      expect(attempt.state).toBe('FAILED');
      expect(attempt.reason).toContain('page closed');
    }
  });

  it('read a Vue app with no fetcher at all', async () => {
    const manifest = await extractRouteManifest(
      options({ reader: readerFor({ vue: [{ path: '/', name: 'home' }, { path: '/orders/:id' }] }) }),
    );
    expect(manifest.state).toBe('READ');
    if (manifest.state !== 'READ') throw new Error('unreachable');
    expect(manifest.templates.map((t) => t.template)).toEqual(['/', '/orders/:id']);
    const fetched = manifest.attempts.filter((a) => ROUTE_EXTRACTOR_NEEDS[a.extractor] === 'FETCH');
    for (const attempt of fetched) expect(attempt.state).toBe('UNAVAILABLE');
  });

  it('honour an extractor allowlist', async () => {
    const manifest = await extractRouteManifest(
      options({ extractors: ['VUE_ROUTER'], reader: readerFor({ vue: [{ path: '/' }] }) }),
    );
    expect(manifest.attempts.map((a) => a.extractor)).toEqual(['VUE_ROUTER']);
  });

  it('try an extra document the customer declared', async () => {
    const url = `${BASE}/internal/routes-manifest.json`;
    const fetcher = fetcherFor({ [url]: { status: 200, body: ROUTES_MANIFEST } });
    const manifest = await extractRouteManifest(
      options({ extractors: ['NEXT_ROUTES_MANIFEST'], fetcher, extraDocuments: [url] }),
    );
    expect(fetcher.calls).toContain(url);
    expect(manifest.state).toBe('READ');
  });
});

// ─── Property tests over a hostile fixture ──────────────────────────────────

/** One run that exercises every state, so the properties below have teeth. */
async function hostileRun(): Promise<RouteManifest> {
  return extractRouteManifest(
    options({
      sourceMapBudget: 1,
      templateBudget: 3,
      treeDepth: 1,
      fetcher: fetcherFor({
        [`${BASE}/`]: {
          status: 200,
          body: '<script src="/a.js"></script><script src="/b.js"></script>',
        },
        [`${BASE}/_next/routes-manifest.json`]: { status: 200, body: ROUTES_MANIFEST },
        [`${BASE}/_next/app-build-manifest.json`]: { status: 500, body: 'nope' },
        [`${BASE}/asset-manifest.json`]: { status: 200, body: '{bad' },
        [`${BASE}/a.js.map`]: {
          status: 200,
          body: JSON.stringify({ sources: ['src/pages/extra.tsx'] }),
        },
      }),
      reader: readerFor({
        angular: [{ path: 'admin', lazy: true, children: [{ path: 'users', children: [{ path: ':id' }] }] }],
        errors: [{ probe: 'REMIX_MANIFEST', message: 'nope' }],
      }),
    }),
  );
}

describe('properties that must hold over the whole output', () => {
  it('never lets an attempt report a null as a zero', async () => {
    const manifest = await hostileRun();
    expect(manifest.attempts.length).toBe(ROUTE_EXTRACTORS.length);
    for (const attempt of manifest.attempts) {
      // The invariant, over every attempt: MEASURED has a number, everything
      // else has a null AND a reason. "We could not read your route table"
      // becoming "your application has no routes" raises the percentage.
      expect(attemptIsConsistent(attempt), `${attempt.extractor} ${attempt.state}`).toBe(true);
      expect(ROUTE_EXTRACTOR_STATES).toContain(attempt.state);
    }
    // Every state is actually reached by this fixture, or the property is vacuous.
    const states = new Set(manifest.attempts.map((a) => a.state));
    expect([...states].sort()).toEqual(['ABSENT', 'FAILED', 'MEASURED']);
  });

  it('never lets a cap bite in silence', async () => {
    const manifest = await hostileRun();
    expect(manifest.caps.length).toBeGreaterThan(0);
    for (const cap of manifest.caps) {
      expect(ROUTE_MANIFEST_CAPS).toContain(cap.cap);
      // A cap that is recorded but did not bite is noise; one that bit with no
      // reason is the undisclosed cap this product may not ship.
      expect(cap.bites).toBeGreaterThan(0);
      expect(cap.limit).toBeGreaterThan(0);
      expect(cap.discarded).toBeGreaterThanOrEqual(0);
      expect(cap.reason.length).toBeGreaterThan(20);
    }
  });

  it('never lets an unexpanded subtree or a skip land without its vocabulary', async () => {
    const manifest = await hostileRun();
    for (const subtree of manifest.unexpanded) {
      expect(ROUTE_SUBTREE_UNEXPANDED_REASONS).toContain(subtree.reason);
      expect(subtree.parent.startsWith('/')).toBe(true);
      expect(subtree.detail.length).toBeGreaterThan(20);
    }
    for (const skip of manifest.skipped) {
      expect(ROUTE_SKIP_REASONS).toContain(skip.reason);
      expect(ROUTE_EXTRACTORS).toContain(skip.extractor);
      expect(skip.count).toBeGreaterThan(0);
      // Examples are capped at three so a report can show what it means
      // without dumping a build.
      expect(skip.examples.length).toBeGreaterThan(0);
      expect(skip.examples.length).toBeLessThanOrEqual(3);
      expect(skip.examples.length).toBeLessThanOrEqual(skip.count);
    }
  });

  it('never calls a partial read complete, and explains every reason it is not', async () => {
    const manifest = await hostileRun();
    expect(manifest.state).toBe('READ');
    if (manifest.state !== 'READ') throw new Error('unreachable');
    expect(manifest.complete).toBe(false);
    // Every cap bite and every failure has to be IN the sentence list, or the
    // caller can print "complete: false" with nothing to show for it.
    for (const cap of manifest.caps) expect(manifest.incomplete).toContain(cap.reason);
    for (const subtree of manifest.unexpanded) {
      expect(manifest.incomplete).toContain(subtree.detail);
    }
    const failures = manifest.attempts.filter((a) => a.state === 'FAILED');
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(manifest.incomplete.join('\n')).toContain(
        ROUTE_EXTRACTOR_LABELS[failure.extractor],
      );
    }
  });

  it('never stores a template with a grade its extractor cannot produce', async () => {
    const manifest = await hostileRun();
    for (const found of templatesOf(manifest)) {
      expect(ROUTE_TEMPLATE_GRADES).toContain(found.grade);
      expect(EXTRACTOR_GRADE[found.extractor]).toBe(found.grade);
      expect(found.template.startsWith('/')).toBe(true);
      // An instantiated URL in a template list is the customer's DATA being
      // counted as their application.
      expect(found.template).not.toContain('?');
      expect(found.declaredAs).toBeTypeOf('string');
    }
  });
});

// ─── The write path into the registry ───────────────────────────────────────

describe('routeManifestSurfaceItems', () => {
  const manifest: RouteManifest = {
    state: 'READ',
    baseUrl: BASE,
    templates: [
      ...readRoutesManifest(`${BASE}/_next/routes-manifest.json`, ROUTES_MANIFEST).templates,
      ...readSourceMap(
        `${BASE}/a.js.map`,
        JSON.stringify({ sources: ['src/pages/guessed.tsx'] }),
      ).templates,
    ],
    complete: true,
    incomplete: [],
    attempts: [],
    caps: [],
    unexpanded: [],
    skipped: [],
    locales: [],
    scriptCandidates: [],
  };

  it('leave a guess out of the registry unless the caller asks for it', async () => {
    const safe = routeManifestSurfaceItems(manifest, { environmentId: 'env_1' });
    expect(safe.map((i) => i.label)).toEqual(['/', '/orders', '/orders/:id', '/docs/:slug*']);

    const everything = routeManifestSurfaceItems(manifest, {
      environmentId: 'env_1',
      includeInferred: true,
    });
    expect(everything.map((i) => i.label)).toContain('/guessed');
    expect(everything.length).toBe(safe.length + 1);
  });

  it('say IN THE EVIDENCE SENTENCE that an inferred route is inferred', () => {
    /*
     * The evidence string is what survives into a CSV export and a support
     * ticket. A grade in a field a renderer might not show is not enough.
     */
    const [guess] = routeManifestSurfaceItems(
      { ...manifest, templates: manifest.templates.filter((t) => t.grade === 'INFERRED') },
      { environmentId: null, includeInferred: true },
    );
    expect(guess!.evidence).toContain('INFERRED');
    expect(guess!.evidence).toContain('may not route to it');
    expect(guess!.file).toBe('src/pages/guessed.tsx');

    const [declared] = routeManifestSurfaceItems(manifest, { environmentId: null });
    expect(declared!.evidence).toContain("application's own route table");
    expect(declared!.evidence).not.toContain('INFERRED');
  });

  it('use the shared identity, so a crawl and a manifest agree on one route', () => {
    // `/orders/[id]` from a build manifest and `/orders/123` from a crawl are
    // one route, and `canonicalRoute` is the only reason they are recognised
    // as one rather than two items in the denominator.
    const items = routeManifestSurfaceItems(manifest, { environmentId: 'env_1' });
    const dynamic = items.find((i) => i.label === '/orders/:id')!;
    expect(dynamic.key).toBe('ROUTE:/orders/:param');
    // The LABEL keeps the segment name, because `:param` is useless to a human.
    expect(dynamic.label).toBe('/orders/:id');
    expect(dynamic.meta?.['params']).toEqual(['id']);
  });

  it('derive origin from sources instead of setting both by hand', () => {
    const items = routeManifestSurfaceItems(manifest, { environmentId: 'env_1' });
    for (const item of items) {
      expect(item.sources).toEqual(['CATALOGUE']);
      // Two provenance fields that can disagree show one on screen and the
      // other in the API, with no way to tell which.
      expect(item.origin).toBe(originFromSources(item.sources!));
      expect(item.origin).toBe('SOURCE_ONLY');
    }
  });

  it('leave exercisability unclassified, because this module has no opinion', () => {
    const items = routeManifestSurfaceItems(manifest, { environmentId: 'env_1' });
    for (const item of items) {
      // ABSENT, not null and not EXERCISABLE. "Nobody classified it" is the one
      // true thing to record, and `exercisabilityCounts` counts it — a declared
      // route stays in the denominator until somebody says otherwise.
      expect('exercise' in item).toBe(false);
      expect(exercisabilityCounts(item.exercise?.state)).toBe(true);
    }
  });

  it('carry the environment, because a build manifest is read from ONE deployment', () => {
    // A staging-only route in a production denominator reads as an uncovered
    // production gap. The caller has to state the environment; null is a thing
    // they may state, not a thing this module assumes.
    const items = routeManifestSurfaceItems(manifest, { environmentId: 'env_staging' });
    for (const item of items) expect(item.environmentId).toBe('env_staging');
    const unscoped = routeManifestSurfaceItems(manifest, { environmentId: null });
    for (const item of unscoped) expect(item.environmentId).toBeNull();
  });

  it('emit rows the real validator accepts', () => {
    /*
     * `surfaceItemSchema` is the actual gate between a producer and a
     * `CoverageItem` row. Asserting against it rather than a hand-written
     * shape is what catches an over-long evidence sentence, a `line: 0`, or a
     * declarer outside `SURFACE_SOURCES` — here, instead of on a write.
     */
    const items = routeManifestSurfaceItems(manifest, {
      environmentId: 'env_1',
      includeInferred: true,
    });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const parsed = surfaceItemSchema.safeParse(item);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    }
  });

  it('emit nothing at all for a manifest that found nothing', () => {
    const nothing = routeManifestSurfaceItems(
      {
        state: 'NOT_AVAILABLE',
        reason: 'NOTHING_LOOKED',
        detail: 'x',
        baseUrl: BASE,
        attempts: [],
        caps: [],
        unexpanded: [],
        skipped: [],
        locales: [],
        scriptCandidates: [],
      },
      { environmentId: null },
    );
    expect(nothing).toEqual([]);
  });

  it('name its detector per extractor, so a systematically wrong one is findable', () => {
    const items = routeManifestSurfaceItems(manifest, {
      environmentId: null,
      includeInferred: true,
    });
    const detectors = new Set(items.map((i) => i.detector));
    expect(detectors).toEqual(
      new Set(['route-manifest:NEXT_ROUTES_MANIFEST', 'route-manifest:SOURCE_MAP']),
    );
  });
});

// ─── Documents and conventions ──────────────────────────────────────────────

describe('the conventional document list', () => {
  it('only names paths, so the base URL decides the host', () => {
    for (const urls of Object.values(CONVENTIONAL_DOCUMENTS)) {
      for (const url of urls) expect(url.startsWith('/')).toBe(true);
    }
  });

  it('covers every fetched extractor that has a fixed address', () => {
    // NEXT_BUILD_MANIFEST and SOURCE_MAP are deliberately absent: one needs a
    // buildId read off the HTML, the other needs a script candidate. Both are
    // addresses discovered at run time, and a conventional guess for either
    // would be a request aimed at a URL we invented.
    const fetched = ROUTE_EXTRACTORS.filter(
      (e): e is RouteExtractor => ROUTE_EXTRACTOR_NEEDS[e] === 'FETCH',
    );
    const fixed = Object.keys(CONVENTIONAL_DOCUMENTS);
    expect(fetched.filter((e) => !fixed.includes(e))).toEqual([
      'NEXT_BUILD_MANIFEST',
      'SOURCE_MAP',
    ]);
  });
});
