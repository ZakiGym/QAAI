/**
 * Provenance tests for the route manifest, written from the outside in.
 *
 * route-manifest.test.ts drives each extractor and asserts the grade it
 * produces. These three ask the question one level up — DOES THE GRADE SURVIVE
 * ALL THE WAY TO A STORED ROW — because a grade that is computed correctly and
 * then lost on the way into the registry buys nothing. Three places could lose
 * it, and two of them did:
 *
 *   1. `accept`, where two extractors declare one route and the stronger
 *      reading has to win.
 *   2. `accept` AGAIN, when the template budget is already full: a cap that
 *      bites must not decide a provenance question, and it must not count a
 *      route we already hold as a route we lost.
 *   3. `routeManifestSurfaceItems`, where the NAMED template (`/orders/:id`)
 *      becomes a CANONICAL identity (`/orders/:param`) and two spellings of one
 *      route collapse onto one key.
 *
 * Every fixture here is literals and a map-backed fetcher. No socket, no
 * browser — same contract as the module's own suite.
 */

import { describe, expect, it } from 'vitest';
import {
  ROUTE_TABLE_PROBES,
  extractRouteManifest,
  routeManifestSurfaceItems,
  templatesOf,
  type RouteManifestOptions,
  type RouteTableProbeResult,
  type RouteTableReader,
} from './route-manifest.js';
import type { FetchedText, HarvestFetcher } from './crawl/harvest.js';

const BASE = 'https://app.example.com';

function fetcherFor(responses: Record<string, Partial<FetchedText>>): HarvestFetcher {
  return {
    async get(url: string): Promise<FetchedText> {
      const hit = responses[url];
      if (hit === undefined) return { status: 404, body: null };
      return { status: 200, body: null, ...hit };
    },
  };
}

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

function options(overrides: Partial<RouteManifestOptions> = {}): RouteManifestOptions {
  return { baseUrl: BASE, fetcher: null, reader: null, ...overrides };
}

/** A build's own compiled route table. Everything out of it is DECLARED. */
const ROUTES_MANIFEST = JSON.stringify({
  version: 3,
  basePath: '',
  staticRoutes: [{ page: '/' }, { page: '/orders' }],
  dynamicRoutes: [{ page: '/orders/[id]' }],
});

/** A source map. Everything out of it is a guess from a file name. */
const SOURCE_MAP = JSON.stringify({
  sources: ['src/pages/reports/[id].tsx', 'src/pages/_helpers/useOrder.ts'],
});

describe('a declaration and a guess are not stored the same way', () => {
  const bothSources = async () =>
    extractRouteManifest(
      options({
        fetcher: fetcherFor({
          [`${BASE}/`]: { status: 200, body: '<script src="/a.js"></script>' },
          [`${BASE}/_next/routes-manifest.json`]: { status: 200, body: ROUTES_MANIFEST },
          [`${BASE}/a.js.map`]: { status: 200, body: SOURCE_MAP },
        }),
      }),
    );

  it('grades the manifest route DECLARED and the source-map route INFERRED', async () => {
    const found = templatesOf(await bothSources());
    const manifestRoute = found.find((t) => t.template === '/orders/:id');
    const guessed = found.find((t) => t.template === '/reports/:id');

    expect(manifestRoute?.grade).toBe('DECLARED');
    expect(manifestRoute?.extractor).toBe('NEXT_ROUTES_MANIFEST');
    expect(guessed?.grade).toBe('INFERRED');
    expect(guessed?.extractor).toBe('SOURCE_MAP');
  });

  it('says "INFERRED" in the evidence sentence, which is what survives a CSV export', async () => {
    const manifest = await bothSources();
    const everything = routeManifestSurfaceItems(manifest, {
      environmentId: null,
      includeInferred: true,
    });
    const guess = everything.find((i) => i.label === '/reports/:id');
    const declared = everything.find((i) => i.label === '/orders/:id');

    expect(guess?.evidence).toContain('INFERRED');
    expect(guess?.evidence).toContain('may not route to it');
    // The DECLARED one must NOT carry the hedge, or the word stops meaning
    // anything the first time a reader sees it on a route they know is real.
    expect(declared?.evidence).not.toContain('INFERRED');
    expect(declared?.meta?.grade).toBe('DECLARED');
    expect(guess?.meta?.grade).toBe('INFERRED');
  });

  it('keeps the guess OUT of the default denominator, and says which extractor made it', async () => {
    const manifest = await bothSources();
    const safe = routeManifestSurfaceItems(manifest, { environmentId: null });
    expect(safe.map((i) => i.label).sort()).toEqual(['/', '/orders', '/orders/:id']);
    expect(safe.every((i) => i.detector?.startsWith('route-manifest:'))).toBe(true);
  });
});

describe('an application where no extractor applies', () => {
  it('answers NOT_AVAILABLE with a reason, never an empty list', async () => {
    // A server that is up and serving a page with no build manifests, no asset
    // manifest, no scripts and no in-page router.
    const manifest = await extractRouteManifest(
      options({
        fetcher: fetcherFor({ [`${BASE}/`]: { status: 200, body: '<html><body/></html>' } }),
        reader: readerFor({}),
      }),
    );

    expect(manifest.state).toBe('NOT_AVAILABLE');
    if (manifest.state !== 'NOT_AVAILABLE') throw new Error('unreachable');
    expect(manifest.reason).toBe('NO_EXTRACTOR_APPLIED');
    expect(manifest.detail.length).toBeGreaterThan(0);
    // `templatesOf` is the only way a caller gets an array, and it returns one
    // only for READ. An empty array must never be reachable as an ANSWER.
    expect(templatesOf(manifest)).toEqual([]);
    // Every extractor accounted for: nine attempts, none of them MEASURED, and
    // every non-MEASURED one carrying a reason.
    expect(manifest.attempts).toHaveLength(9);
    /*
     * MODULE_GRAPH is the one MEASURED attempt — it read the index.html — and
     * it is exactly why this must not be EMPTY: its `EXTRACTOR_GRADE` is null,
     * so it can never declare a route and its silence is not the
     * application's answer.
     */
    expect(
      manifest.attempts.filter((a) => a.state === 'MEASURED').map((a) => a.extractor),
    ).toEqual(['MODULE_GRAPH']);
    expect(
      manifest.attempts.every((a) => a.state === 'MEASURED' || (a.reason ?? '').length > 0),
    ).toBe(true);
  });

  it('separates "we had no capability" from "we looked and nothing is here"', async () => {
    const nothingLooked = await extractRouteManifest(options());
    expect(nothingLooked.state).toBe('NOT_AVAILABLE');
    if (nothingLooked.state !== 'NOT_AVAILABLE') throw new Error('unreachable');
    // NOT the same answer as the test above, and that is the whole point: one
    // is a fact about the application, the other a fact about our own setup.
    expect(nothingLooked.reason).toBe('NOTHING_LOOKED');
  });
});

describe('the template budget must not decide a provenance question', () => {
  /*
   * Two extractors, the same two routes, a budget exactly big enough for one
   * extractor's worth. A Next app really does serve both `_buildManifest.js`
   * and `routes-manifest.json`, and `accept`'s own comment says so — this is
   * that case with the in-page readers, which is the cheapest way to get two
   * DECLARED extractors into one run.
   */
  const twoExtractorsOneRouteSet = (templateBudget: number) =>
    extractRouteManifest(
      options({
        templateBudget,
        reader: readerFor({
          vue: [{ path: '/a' }, { path: '/b' }],
          react: [{ path: '/a' }, { path: '/b' }],
        }),
      }),
    );

  it('does not report a route it already holds as a route it lost', async () => {
    /*
     * THE DEFECT: the budget check ran BEFORE the duplicate check, so once the
     * list was full every later candidate was counted as discarded — including
     * the ones already in the list. The cap then reported "at least 2 more
     * templates were declared and are not in this list" over an application
     * that declares exactly the two it already shows.
     *
     * `journeysDroppedByCap`'s note in schema.prisma states the rule this
     * breaks: a cap's count is a FLOOR and never an estimate, and inventing a
     * number in the alarming direction is the same sin as inventing one in the
     * flattering direction.
     */
    const manifest = await twoExtractorsOneRouteSet(2);
    expect(manifest.state).toBe('READ');
    if (manifest.state !== 'READ') throw new Error('unreachable');
    expect(templatesOf(manifest).map((t) => t.template).sort()).toEqual(['/a', '/b']);
    expect(manifest.caps.find((c) => c.cap === 'TEMPLATE_BUDGET')).toBeUndefined();
    // `complete` is still false, and correctly so: six extractors were
    // UNAVAILABLE because no fetcher was injected. What must not appear is a
    // template-budget sentence, which is the fabricated part.
    expect(manifest.incomplete.join(' ')).not.toContain('template budget');
  });

  it('still reports a real bite, with a floor that is true', async () => {
    const manifest = await twoExtractorsOneRouteSet(1);
    expect(manifest.state).toBe('READ');
    if (manifest.state !== 'READ') throw new Error('unreachable');
    const bite = manifest.caps.find((c) => c.cap === 'TEMPLATE_BUDGET');
    expect(bite?.limit).toBe(1);
    // One route held, one route genuinely not in the list. Not two, which is
    // what counting candidate readings instead of templates reported.
    expect(bite?.discarded).toBe(1);
    expect(bite?.reason).toContain('at least 1 ');
    expect(manifest.complete).toBe(false);
  });

  it('lets ground truth overwrite a guess even when the budget is full', async () => {
    /*
     * ASSET_MANIFEST is INFERRED and runs before the in-page routers, which are
     * DECLARED. With a budget of one, the guess arrived first and filled the
     * list; the DECLARED reading of the SAME route was then counted as
     * discarded and thrown away, so the stored row kept the grade that says
     * "the application may not route to it" about a route its own router
     * declares. A cap decided a provenance question.
     */
    const manifest = await extractRouteManifest(
      options({
        templateBudget: 1,
        fetcher: fetcherFor({
          // Vite's asset-manifest shape: every entry is a SOURCE FILE, so
          // everything out of it is INFERRED.
          [`${BASE}/asset-manifest.json`]: {
            status: 200,
            body: JSON.stringify({
              'src/pages/orders/[id].tsx': {
                file: 'assets/orders-a1b2c3.js',
                src: 'src/pages/orders/[id].tsx',
              },
            }),
          },
          [`${BASE}/`]: { status: 404, body: null },
        }),
        reader: readerFor({ vue: [{ path: '/orders/:id' }] }),
      }),
    );
    const held = templatesOf(manifest);
    expect(held).toHaveLength(1);
    expect(held[0]?.template).toBe('/orders/:id');
    expect(held[0]?.grade).toBe('DECLARED');
    expect(held[0]?.extractor).toBe('VUE_ROUTER');
  });
});

describe('two spellings of one route are one registry row', () => {
  /*
   * `accept` de-duplicates on the NAMED template and the registry keys on the
   * CANONICAL one — `canonicalRoute` folds every param name to `:param` and
   * lower-cases the rest. So `/orders/:orderId` and `/orders/:id` are two
   * templates and ONE key, and `routeManifestSurfaceItems` emitted an item for
   * each. Two rows with one primary key is not a bigger measurement of the
   * application: on the way into `CoverageItem` one silently overwrites the
   * other, and which one wins is whichever the upsert reached last.
   *
   * The dangerous ordering is the one below: the guess is listed after the
   * declaration, so a last-write-wins upsert stores "we guessed this from a
   * file name" about a route the build's own manifest declares.
   */
  const twoSpellings = () =>
    extractRouteManifest(
      options({
        fetcher: fetcherFor({
          [`${BASE}/`]: { status: 200, body: '<script src="/a.js"></script>' },
          [`${BASE}/_next/routes-manifest.json`]: {
            status: 200,
            body: JSON.stringify({
              version: 3,
              basePath: '',
              staticRoutes: [],
              dynamicRoutes: [{ page: '/orders/[orderId]' }],
            }),
          },
          [`${BASE}/a.js.map`]: {
            status: 200,
            body: JSON.stringify({ sources: ['src/pages/orders/[id].tsx'] }),
          },
        }),
      }),
    );

  it('keeps both spellings as templates, because the names are what a human reads', async () => {
    const found = templatesOf(await twoSpellings());
    expect(found.map((t) => t.template).sort()).toEqual(['/orders/:id', '/orders/:orderId']);
  });

  it('emits ONE item per key, and keeps the strongest grade', async () => {
    const items = routeManifestSurfaceItems(await twoSpellings(), {
      environmentId: null,
      includeInferred: true,
    });
    expect(items).toHaveLength(1);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(items[0]?.key).toBe('ROUTE:/orders/:param');
    // The declaration wins, so the evidence a customer reads is the true one.
    expect(items[0]?.meta?.grade).toBe('DECLARED');
    expect(items[0]?.evidence).not.toContain('INFERRED');
  });

  it('records the spelling it collapsed rather than dropping it silently', async () => {
    const items = routeManifestSurfaceItems(await twoSpellings(), {
      environmentId: null,
      includeInferred: true,
    });
    // The losing spelling is a fact about OUR extractors — two readers that
    // named one route differently — and it is the kind this module reports.
    expect(items[0]?.meta?.alsoSpelled).toEqual(['/orders/:id']);
  });

  it('never emits a duplicate key over the whole hostile run', async () => {
    const manifest = await extractRouteManifest(
      options({
        fetcher: fetcherFor({
          [`${BASE}/`]: { status: 200, body: '<script src="/a.js"></script>' },
          [`${BASE}/_next/routes-manifest.json`]: { status: 200, body: ROUTES_MANIFEST },
          [`${BASE}/a.js.map`]: { status: 200, body: SOURCE_MAP },
        }),
        reader: readerFor({ vue: [{ path: '/Orders' }, { path: '/orders/:orderId' }] }),
      }),
    );
    const items = routeManifestSurfaceItems(manifest, {
      environmentId: null,
      includeInferred: true,
    });
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
