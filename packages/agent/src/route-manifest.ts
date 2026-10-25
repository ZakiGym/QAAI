/**
 * The running application's OWN route table, read without crawling it.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * A crawl can only ever report what it reached. `analyseCodebase` reports what
 * the repository declares — but only when we HAVE the repository, and only for
 * the routers it can parse. Between those two there is a third source that
 * costs one HTTP request and nothing else: most shipped single-page
 * applications publish their complete route table as a static asset, and some
 * hand it over from memory to anyone who asks the router object for it.
 *
 * A Next.js build writes `routes-manifest.json`; the pages router ships
 * `sortedPages` inside `_buildManifest.js`; the app router ships
 * `app-build-manifest.json`; Vue Router answers `router.getRoutes()`; Angular
 * answers `Router.config`; React Router 7 leaves `__reactRouterManifest` on
 * `window`. Every one of those is a list of ROUTE TEMPLATES, produced by the
 * framework itself, available before a single page has been clicked.
 *
 * This is the cheapest complete route table in existence and QAAI could not
 * read any of it. The sentence this file exists to make possible is "your
 * build declares 412 routes; the crawl reached 25; here are the 387" — and the
 * 412 has to come from somewhere that is not the crawl, or the sentence is
 * circular.
 *
 * ── THE ONE DISTINCTION THIS MODULE IS ORGANISED AROUND ─────────────────────
 *
 * A template out of `routes-manifest.json` is GROUND TRUTH: the build compiled
 * it, the server matches on it, and its dynamic segments are named by the
 * manifest's own `routeKeys`. A template read off a file path in a source map
 * is A GUESS: `src/pages/orders/[id].tsx` looks like a route and very often is
 * one, but nothing in the map says the application routes to it, and a
 * `src/pages/_helpers/useOrder.ts` in the same tree would produce a route that
 * does not exist.
 *
 * Storing those two identically is the specific lie this product cannot
 * afford, because a phantom route in the denominator makes the coverage
 * percentage LOWER (which looks conservative) while a phantom route in the
 * NAMED LIST is a line item a customer will go looking for and not find — and
 * one of those destroys the number's credibility permanently. So every
 * template carries {@link RouteTemplateGrade}, the grade is fixed per
 * extractor by a compiler-enforced table, and the `evidence` sentence of an
 * INFERRED template says in words that it is inferred.
 *
 * ── THE FOUR ANSWERS, AND WHY AN EMPTY LIST IS NOT ONE OF THEM ──────────────
 *
 * `extractRouteManifest` never returns a bare array, because an empty array
 * reads as "this application has no client routes" and that sentence is almost
 * never the true one. The states are:
 *
 *   READ           at least one extractor produced at least one template.
 *   EMPTY          an extractor READ its document and the document declared
 *                  zero routes. This is a real answer about the application —
 *                  rare, but true when it happens.
 *   NOT_AVAILABLE  nothing could be read, with a reason that separates "we had
 *                  no capability to look" from "we looked and no application of
 *                  this shape is here" from "a document existed and we failed
 *                  to read it".
 *
 * `complete` rides on READ and EMPTY and is false whenever any extractor
 * FAILED or any cap bit, so "the build declares 412 routes" can never be said
 * unqualified over a partial read. "Reconciled" over a source that failed to
 * load is the kind of claim that gets a vendor's number thrown out entirely.
 *
 * ── NO I/O IN THIS FILE ─────────────────────────────────────────────────────
 *
 * Both capabilities are injected and both are narrow. The HTTP half reuses
 * {@link HarvestFetcher} rather than minting a second one-method fetcher —
 * `playwrightCrawlAdapter()` already implements it, so the integrator passes
 * the object they already have and there is exactly one fetch vocabulary in
 * the enumerate slice. The in-page half is {@link RouteTableReader}, one
 * `evaluate`, structurally satisfied by playwright's `Page` (asserted at
 * compile time below) so it needs no adapter at all.
 *
 * Everything else here is text and graph work over plain data, which is why
 * route-manifest.test.ts drives all of it with literals and never opens a
 * socket or a browser. 629 lines of crawler.ts have almost no tests because
 * their judgement lives inside `page.evaluate` callbacks; the single
 * `evaluate` this module uses returns plain data and makes no decisions, and
 * that boundary is NAMED as untested rather than covered by a test that proves
 * a mock matches a mock.
 *
 * ── NOTHING HERE CALLS A MODEL ──────────────────────────────────────────────
 *
 * Same rule as coverage.ts and surface-inventory.ts. A denominator is a claim
 * about the customer's application, and enumeration is parsing and graph work.
 * A route table we could not show the working for is worth less than no route
 * table.
 */

/*
 * TYPE-ONLY, and the only reference to playwright in this file. It exists for
 * the compile-time seam assertion beside `RouteTableReader`; no value is
 * imported, so this module neither launches a browser nor needs one to be
 * tested. The precedent and the reasoning are in crawl/interact.ts.
 */
import type { Page as PlaywrightPage } from 'playwright';
import {
  originFromSources,
  surfaceKey,
  type CrawlCap,
  type SurfaceItem,
  type SurfaceSource,
} from '@qaai/shared';
import { canonicalRoute } from './coverage.js';
import type { FetchedText, HarvestFetcher } from './crawl/harvest.js';

// ─── 1. The extractors ───────────────────────────────────────────────────────

/**
 * The nine places a shipped application will hand over its own route table.
 *
 * Listed in one closed vocabulary rather than grown one special case at a time,
 * because the thing a reader needs from this module is not "here are some
 * routes" but "here is which of the nine ways of asking worked, and which did
 * not" — and an extractor that is silently absent from that list is an
 * unmeasured axis reported as a measured zero.
 */
export const ROUTE_EXTRACTORS = [
  /** `routes-manifest.json` — the Next.js build's own compiled route table. */
  'NEXT_ROUTES_MANIFEST',
  /** `app-build-manifest.json` — the App Router's module map. */
  'NEXT_APP_BUILD_MANIFEST',
  /** `_buildManifest.js` — the Pages Router's `sortedPages`. */
  'NEXT_BUILD_MANIFEST',
  /** `asset-manifest.json` — CRA's build files, or Vite's entry map. */
  'ASSET_MANIFEST',
  /** The `<script type="module">` / `modulepreload` graph in a built index.html. */
  'MODULE_GRAPH',
  /** `router.getRoutes()` in the running application. */
  'VUE_ROUTER',
  /** `Router.config` in the running application. */
  'ANGULAR_ROUTER',
  /** React Router's route objects, where the running app exposes them. */
  'REACT_ROUTER',
  /** A `.map` file's `sources` list. The last resort, and a guess. */
  'SOURCE_MAP',
] as const;
export type RouteExtractor = (typeof ROUTE_EXTRACTORS)[number];

export const ROUTE_EXTRACTOR_LABELS: Record<RouteExtractor, string> = {
  NEXT_ROUTES_MANIFEST: "the Next.js build's routes-manifest.json",
  NEXT_APP_BUILD_MANIFEST: "the App Router's app-build-manifest.json",
  NEXT_BUILD_MANIFEST: "the Pages Router's _buildManifest.js",
  ASSET_MANIFEST: 'the build asset manifest',
  MODULE_GRAPH: "the module graph in the application's index.html",
  VUE_ROUTER: "Vue Router's own route records",
  ANGULAR_ROUTER: "Angular Router's own configuration",
  REACT_ROUTER: "React Router's own route objects",
  SOURCE_MAP: 'the original file names in a source map',
};

/**
 * Which capability each extractor needs.
 *
 * Compiler-enforced, and load-bearing: with no `reader` injected the three
 * in-page extractors must report UNAVAILABLE rather than ABSENT. "The app does
 * not expose a Vue router" and "we had no way to ask" are different facts
 * about different things, and only one of them is evidence about the customer.
 */
export const ROUTE_EXTRACTOR_NEEDS = {
  NEXT_ROUTES_MANIFEST: 'FETCH',
  NEXT_APP_BUILD_MANIFEST: 'FETCH',
  NEXT_BUILD_MANIFEST: 'FETCH',
  ASSET_MANIFEST: 'FETCH',
  MODULE_GRAPH: 'FETCH',
  VUE_ROUTER: 'IN_PAGE',
  ANGULAR_ROUTER: 'IN_PAGE',
  REACT_ROUTER: 'IN_PAGE',
  SOURCE_MAP: 'FETCH',
} as const satisfies Record<RouteExtractor, 'FETCH' | 'IN_PAGE'>;

// ─── 2. Grades: ground truth, derived, or a guess ────────────────────────────

/**
 * How much a template's provenance proves.
 *
 *   DECLARED  the document states the URL TEMPLATE itself. The framework wrote
 *             this string and the router matches on it.
 *   DERIVED   the document states a build artifact and the template was
 *             computed from it by a documented rule — App Router module paths
 *             through the segment rules, say. The existence is ground truth;
 *             the URL is our arithmetic, so a rule we got wrong shows up here.
 *   INFERRED  the template was read off a file name that LOOKS like a route.
 *             Nothing in the document says the application routes to it.
 *
 * The gap between DERIVED and INFERRED is the one worth defending. A reader
 * who treats all three alike will put a `useOrder.ts` helper in a customer's
 * list of uncovered pages, and that is a mistake they only have to see once.
 */
export const ROUTE_TEMPLATE_GRADES = ['DECLARED', 'DERIVED', 'INFERRED'] as const;
export type RouteTemplateGrade = (typeof ROUTE_TEMPLATE_GRADES)[number];

export const ROUTE_TEMPLATE_GRADE_LABELS: Record<RouteTemplateGrade, string> = {
  DECLARED: "the application's own route table states this template",
  DERIVED: 'computed from a build artifact by a documented rule',
  INFERRED: 'guessed from a file name that looks like a route',
};

/** The grades a caller may present as fact about the application. */
export const GROUND_TRUTH_GRADES: readonly RouteTemplateGrade[] = ['DECLARED', 'DERIVED'];

/** True when the template may be stated without the word "probably". */
export function isGroundTruth(grade: RouteTemplateGrade): boolean {
  return GROUND_TRUTH_GRADES.includes(grade);
}

/**
 * The grade each extractor can ever produce, fixed here and not at the call
 * site.
 *
 * Compiler-enforced so a new extractor cannot land without declaring what its
 * output proves. `MODULE_GRAPH` is NULL and that is not an oversight: the
 * module graph names chunks, never routes. Letting it carry a grade would
 * invite someone to turn `assets/OrdersDetail-a1b2c3.js` into `/orders-detail`,
 * which is a route the application does not serve, invented by us, in the
 * customer's gap list. What the module graph produces is script candidates for
 * {@link ROUTE_EXTRACTORS} `SOURCE_MAP`, and that is all.
 */
export const EXTRACTOR_GRADE = {
  NEXT_ROUTES_MANIFEST: 'DECLARED',
  NEXT_APP_BUILD_MANIFEST: 'DERIVED',
  NEXT_BUILD_MANIFEST: 'DECLARED',
  ASSET_MANIFEST: 'INFERRED',
  MODULE_GRAPH: null,
  VUE_ROUTER: 'DECLARED',
  ANGULAR_ROUTER: 'DECLARED',
  REACT_ROUTER: 'DECLARED',
  SOURCE_MAP: 'INFERRED',
} as const satisfies Record<RouteExtractor, RouteTemplateGrade | null>;

// ─── 3. The template ─────────────────────────────────────────────────────────

/**
 * One route TEMPLATE, which is not a URL.
 *
 * `/orders/:id` is the thing the application declares; `/orders/7f3a` is one
 * instance of it, and an enumeration that lists instances is counting the
 * customer's data rather than their application. The segment NAMES survive —
 * `:orderId` and `:id` are different templates to a human reading a gap list,
 * even though `canonicalRoute` folds both to `:param` for identity.
 *
 * NAMED `DeclaredRoute` AND NOT `RouteTemplate`, for two reasons. The first is
 * mechanical: `crawl/frontier.ts` already exports a `RouteTemplate` through the
 * same package barrel, `export *` makes a duplicated name ambiguous (TS2308)
 * and ES module semantics drop BOTH — the exact failure mode the header of
 * crawl/index.ts exists to document, and the newcomer renames.
 *
 * The second is that the two really are different things, and sharing a name
 * would have hidden it. The frontier's `RouteTemplate` is INFERRED by
 * collapsing observed paths — `/products/blue` and `/products/red` become
 * `/products/:param` above a cardinality threshold. This one is DECLARED: the
 * application handed over the template itself, no instances were seen, and no
 * threshold was involved.
 */
export interface DeclaredRoute {
  /** Normalised, with named dynamic segments: `/orders/:id`, `/docs/:slug*`. */
  template: string;
  /** Exactly as the document spelled it: `/orders/[id]`, `orders/:id`, `''`. */
  declaredAs: string;
  grade: RouteTemplateGrade;
  extractor: RouteExtractor;
  /** The document URL, or the probe id for an in-page read. */
  document: string;
  /** Dynamic segment names in order. Empty for a static route. */
  params: string[];
  /** True when a segment swallows the remainder — `[...slug]`, `*`, `**`. */
  catchAll: boolean;
  /**
   * The route's name, when the router has one (`Vue`'s named routes, React
   * Router's `id`). Null when the router does not name routes — never `''`.
   */
  name: string | null;
  /**
   * Where this template redirects, when the document says it is a redirect
   * rather than a page. Null for a page.
   */
  redirectsTo: string | null;
  /**
   * The original source file, when the document named one. Only a source map
   * and a Vite asset manifest can — and for those it is the ONLY honest field
   * on the item, because the file is what we actually saw and the template is
   * what we guessed from it.
   */
  file: string | null;
}

// ─── 4. Attempts: measured, absent, failed, or never looked ─────────────────

/**
 * What happened when one extractor was tried.
 *
 * Four states, because three of them produce an empty template list and only
 * one of them supports the sentence "this application publishes no Vue router":
 *
 *   MEASURED     we read the document. `found` is a number, possibly 0.
 *   ABSENT       we asked and it is not here (a 404, a router not on `window`).
 *   FAILED       it is here and we could not read it — a parse error, a
 *                transport error, a shape we do not recognise. `found` is NULL
 *                and the report must not treat this extractor as having voted.
 *   UNAVAILABLE  we had no capability to look at all.
 *
 * The `found === null` invariant on the last three is checked by
 * {@link attemptIsConsistent} and asserted over every attempt in the tests, so
 * a future extractor that returns `found: 0` on a transport error fails
 * without anyone remembering to extend the test. A null that became 0 is the
 * defect: it turns "we could not read your route table" into "your application
 * has no routes", and the second one raises the coverage percentage.
 */
export const ROUTE_EXTRACTOR_STATES = ['MEASURED', 'ABSENT', 'FAILED', 'UNAVAILABLE'] as const;
export type RouteExtractorState = (typeof ROUTE_EXTRACTOR_STATES)[number];

export const ROUTE_EXTRACTOR_STATE_LABELS: Record<RouteExtractorState, string> = {
  MEASURED: 'read',
  ABSENT: 'asked for, and not present',
  FAILED: 'present and unreadable',
  UNAVAILABLE: 'not looked for — no capability here',
};

export interface RouteExtractorAttempt {
  extractor: RouteExtractor;
  state: RouteExtractorState;
  /** Templates this extractor contributed. NULL unless MEASURED. */
  found: number | null;
  /** The document or probe it tried. Null when it never got as far as one. */
  document: string | null;
  /** Required unless MEASURED: what stopped us. Never defaulted to ''. */
  reason: string | null;
}

/** Whether an attempt's own fields agree. See {@link ROUTE_EXTRACTOR_STATES}. */
export function attemptIsConsistent(attempt: RouteExtractorAttempt): boolean {
  return attempt.state === 'MEASURED'
    ? attempt.found !== null && attempt.found >= 0
    : attempt.found === null && attempt.reason !== null && attempt.reason.length > 0;
}

function measured(
  extractor: RouteExtractor,
  document: string,
  found: number,
): RouteExtractorAttempt {
  return { extractor, state: 'MEASURED', found, document, reason: null };
}

function absent(
  extractor: RouteExtractor,
  document: string | null,
  reason: string,
): RouteExtractorAttempt {
  return { extractor, state: 'ABSENT', found: null, document, reason };
}

function failed(
  extractor: RouteExtractor,
  document: string | null,
  reason: string,
): RouteExtractorAttempt {
  return { extractor, state: 'FAILED', found: null, document, reason };
}

function unavailable(extractor: RouteExtractor, reason: string): RouteExtractorAttempt {
  return { extractor, state: 'UNAVAILABLE', found: null, document: null, reason };
}

// ─── 5. Caps, every one of which bites visibly ───────────────────────────────

/**
 * The five limits in this module. Each is reported as a count AND a sentence
 * when it bites, and `discarded` is the field that matters: "the template
 * budget bit" is a fact about us, "the template budget bit and discarded 318
 * declared routes" is a fact about how wrong the number is.
 *
 * An undisclosed cap on an ingest makes the coverage percentage go UP, which
 * is the one direction this product may not be wrong in — a smaller
 * denominator with the same numerator flatters us, and nothing on screen would
 * say why.
 */
export const ROUTE_MANIFEST_CAPS = [
  'TEMPLATE_BUDGET',
  'DOCUMENT_BUDGET',
  'SCRIPT_CANDIDATE_BUDGET',
  'SOURCE_MAP_BUDGET',
  'ROUTE_TREE_DEPTH',
] as const;
export type RouteManifestCap = (typeof ROUTE_MANIFEST_CAPS)[number];

export const ROUTE_MANIFEST_CAP_LABELS: Record<RouteManifestCap, string> = {
  TEMPLATE_BUDGET: 'the overall template budget',
  DOCUMENT_BUDGET: 'the manifest document budget',
  SCRIPT_CANDIDATE_BUDGET: 'the script candidate limit',
  SOURCE_MAP_BUDGET: 'the source map budget',
  ROUTE_TREE_DEPTH: 'the route-tree depth limit',
};

/**
 * Where each cap lands in the shared crawl vocabulary.
 *
 * All five are NULL, and the table exists anyway. `CRAWL_CAPS` has no member
 * for a manifest document budget or a route-tree depth, and filing
 * `ROUTE_TREE_DEPTH` under `DEPTH` — which means clicks from the seed — would
 * put a number in a field every reader interprets as something else. The
 * compiler-enforced shape is what makes a future `CRAWL_CAPS` addition a
 * one-line change here instead of a silent divergence, and it is why there is
 * no projection function: there is currently nothing to project, and a
 * function that always returns an empty list is worse than its absence.
 */
export const ROUTE_MANIFEST_CAP_AS_CRAWL_CAP = {
  TEMPLATE_BUDGET: null,
  DOCUMENT_BUDGET: null,
  SCRIPT_CANDIDATE_BUDGET: null,
  SOURCE_MAP_BUDGET: null,
  ROUTE_TREE_DEPTH: null,
} as const satisfies Record<RouteManifestCap, CrawlCap | null>;

/** Structurally `CapBite`, with this module's own cap vocabulary. */
export interface RouteManifestCapBite {
  cap: RouteManifestCap;
  limit: number;
  bites: number;
  /** Candidates it discarded. A LOWER bound on what it cost. */
  discarded: number;
  scope: string | null;
  reason: string;
}

// ─── 6. Subtrees nobody expanded, which are not caps ────────────────────────

/**
 * A branch of a route tree we can SEE but cannot ENUMERATE.
 *
 * Angular's `loadChildren` and React Router's `lazy` are functions. Until the
 * application calls them the children do not exist in memory, so a read of
 * `Router.config` returns a parent with an empty `children` array and no
 * indication that forty routes live under it. Reporting the parent and
 * stopping is the move that makes a 412-route application look like a 9-route
 * application, so each one is recorded with its parent template and the report
 * can say "at least one more route exists under /admin".
 *
 * Deliberately NOT a cap bite: a cap is a limit WE chose and could raise, and
 * this is a limit the application's own code shape imposes. Folding them
 * together would make "raise the budget" read as the remedy for something no
 * budget can fix.
 */
export const ROUTE_SUBTREE_UNEXPANDED_REASONS = ['LAZY_MODULE', 'LAZY_ROUTE_OBJECT'] as const;
export type RouteSubtreeUnexpandedReason = (typeof ROUTE_SUBTREE_UNEXPANDED_REASONS)[number];

export const ROUTE_SUBTREE_UNEXPANDED_LABELS: Record<RouteSubtreeUnexpandedReason, string> = {
  LAZY_MODULE: 'the children are in a lazily loaded module that was never loaded',
  LAZY_ROUTE_OBJECT: 'the route object defers its children to a function we did not call',
};

export interface UnexpandedSubtree {
  extractor: RouteExtractor;
  /** The parent template whose children we could not see. */
  parent: string;
  reason: RouteSubtreeUnexpandedReason;
  detail: string;
}

// ─── 7. Declarations that are not routes, counted rather than dropped ───────

/**
 * Why an entry in a route document did not become a template.
 *
 * Every one of these is a line in a manifest that we read, understood, and
 * chose not to count. Dropping them silently would be indistinguishable from
 * a parser that missed them, and the difference matters: a customer comparing
 * our 412 against their own count of 437 needs the 25 to be explained, not
 * absent.
 */
export const ROUTE_SKIP_REASONS = [
  /** `/_app`, `/_error`, `/_document`, `/middleware` — plumbing with no URL. */
  'FRAMEWORK_PLUMBING',
  /** A layout, loading, template or default module. Real, and not addressable. */
  'NOT_ADDRESSABLE',
  /** An App Router `route.ts`. That is an ENDPOINT and its method is unknown here. */
  'API_HANDLER',
  /** `/_next/data/<buildId>/...` — a fetch target for a page already counted. */
  'DATA_ROUTE',
  /** A redirect or rewrite RULE. A URL shape, but not a page of the application. */
  'REWRITE_OR_REDIRECT_RULE',
  /** The document is real and lists build files rather than routes. */
  'NOT_A_ROUTE_DOCUMENT',
  /** An entry we could not turn into a template. Counted so our error rate shows. */
  'UNPARSEABLE_ENTRY',
] as const;
export type RouteSkipReason = (typeof ROUTE_SKIP_REASONS)[number];

export const ROUTE_SKIP_REASON_LABELS: Record<RouteSkipReason, string> = {
  FRAMEWORK_PLUMBING: 'framework plumbing with no URL of its own',
  NOT_ADDRESSABLE: 'a real module with no URL a browser can request',
  API_HANDLER: 'an API handler — an endpoint, not a page',
  DATA_ROUTE: 'a data fetch target for a page already counted',
  REWRITE_OR_REDIRECT_RULE: 'a redirect or rewrite rule rather than a page',
  NOT_A_ROUTE_DOCUMENT: 'this document lists build files, not routes',
  UNPARSEABLE_ENTRY: 'we could not turn this entry into a template',
};

export interface SkippedDeclaration {
  extractor: RouteExtractor;
  reason: RouteSkipReason;
  count: number;
  /** Up to three, so the report can show what it means without dumping a build. */
  examples: string[];
}

// ─── 8. The result ───────────────────────────────────────────────────────────

/** Why no extractor produced anything. */
export const ROUTE_MANIFEST_UNAVAILABILITIES = [
  /** Neither capability was injected. We did not look. */
  'NOTHING_LOOKED',
  /** We looked everywhere and no application of a shape we know is here. */
  'NO_EXTRACTOR_APPLIED',
  /** Documents were here and every one of them failed to read. */
  'ALL_EXTRACTORS_FAILED',
] as const;
export type RouteManifestUnavailability = (typeof ROUTE_MANIFEST_UNAVAILABILITIES)[number];

export const ROUTE_MANIFEST_UNAVAILABILITY_LABELS: Record<RouteManifestUnavailability, string> = {
  NOTHING_LOOKED: 'no fetcher and no in-page reader were available, so nothing was tried',
  NO_EXTRACTOR_APPLIED: 'every extractor was tried and none of their documents is served here',
  ALL_EXTRACTORS_FAILED: 'a route document was served and every attempt to read one failed',
};

/** The parts every answer carries, including the ones that found nothing. */
interface RouteManifestBase {
  baseUrl: string;
  /** One per extractor considered, in the order they were tried. */
  attempts: RouteExtractorAttempt[];
  /** Only the caps that BIT. A cap that did not bite is not a caveat. */
  caps: RouteManifestCapBite[];
  unexpanded: UnexpandedSubtree[];
  skipped: SkippedDeclaration[];
  /**
   * Locales the build declared, when a manifest declares any.
   *
   * Reported and NEVER multiplied through. A Next.js build with four locales
   * serves `/en/orders/:id` as well as `/orders/:id`, but turning 412 templates
   * into 1,648 would be a cross product we invented — the locale axis already
   * exists as `SurfaceDimension` with kind `LOCALE`, and that is where the
   * multiplication belongs, computed once, by the code that owns the
   * dimension denominator. Listing the locales here is what lets that code
   * know they exist.
   */
  locales: string[];
  /** Script URLs collected for the source-map pass, after its cap. */
  scriptCandidates: string[];
}

export type RouteManifest =
  | (RouteManifestBase & {
      state: 'READ';
      templates: DeclaredRoute[];
      /** False when any extractor FAILED or any cap bit. */
      complete: boolean;
      /** Why `complete` is false, one sentence each. Empty when it is true. */
      incomplete: string[];
    })
  | (RouteManifestBase & {
      state: 'EMPTY';
      /**
       * The document we read that declared nothing, so "this application has
       * no client routes" is attributable rather than asserted.
       */
      readDocument: string;
      complete: boolean;
      incomplete: string[];
    })
  | (RouteManifestBase & {
      state: 'NOT_AVAILABLE';
      reason: RouteManifestUnavailability;
      detail: string;
    });

/** The templates, or an empty list — for a caller that has already branched. */
export function templatesOf(manifest: RouteManifest): DeclaredRoute[] {
  return manifest.state === 'READ' ? manifest.templates : [];
}

// ─── 9. The injected capabilities ────────────────────────────────────────────

/**
 * The in-page capability: one method.
 *
 * One, because one is all this needs, and because {@link PageLike} in
 * crawl/interact.ts demands nine — a fake for nine methods in order to test a
 * route-table read is the friction that stops the test being written.
 *
 * Nothing in this module decides anything inside the script. The script reads
 * three globals and returns plain data; every judgement about that data —
 * joining relative Angular paths, flattening React Router's parent chain,
 * deciding a `''` path is the parent's index — happens above the seam where it
 * is driven by literals.
 */
export interface RouteTableReader {
  evaluate<T>(script: string): Promise<T>;
}

/*
 * THE SEAM, ASSERTED AT COMPILE TIME.
 *
 * Type-only, so nothing reaches the runtime and the tests still run against a
 * literal. What it buys is the failure mode this repo is named for: a module
 * that is correct, tested and documented as serving the crawl, and impossible
 * to actually call because playwright's `Page` drifted one parameter away from
 * the interface. If `Page.evaluate` changes, THIS line goes red, in this file,
 * with this comment next to it — and there is no adapter function to fix,
 * because a `Page` IS a `RouteTableReader`.
 */
type AssertIsRouteTableReader<T extends RouteTableReader> = T;
export type PlaywrightPageSatisfiesRouteTableReader = AssertIsRouteTableReader<PlaywrightPage>;

/*
 * The HTTP seam, asserted the same way against the fetcher this slice already
 * has. Reusing `HarvestFetcher` instead of declaring a second one-method
 * fetcher is deliberate: `playwrightCrawlAdapter()` in crawler.ts already
 * implements it, so the integrator passes `adapter.fetcher` straight through,
 * and there is one fetch vocabulary in the enumerate slice rather than two
 * that will drift. If that interface changes, this line says so.
 */
type AssertIsManifestFetcher<T extends HarvestFetcher> = T;
export type HarvestFetcherServesRouteManifest = AssertIsManifestFetcher<HarvestFetcher>;

/**
 * The globals the in-page script probes, as ids rather than expressions.
 *
 * Exported so there is ONE list. The script reports which of these it tried,
 * and {@link readRouteTable} refuses a probe id it does not recognise — so a
 * probe added to the script without being added here is a loud failure rather
 * than a framework that silently reports zero routes forever. Zero routes from
 * a router that was never asked looks exactly like an application with no
 * client routing.
 */
export const ROUTE_TABLE_PROBES = [
  /** `__vue_app__` on the mount element, which is where Vue 3 leaves the app. */
  'VUE_APP_ROOT',
  /** `window.__VUE_ROUTER__`, which applications sometimes set deliberately. */
  'VUE_ROUTER_GLOBAL',
  /** Angular's `ng.getInjector`, available in a dev build and under `enableDebugTools`. */
  'ANGULAR_INJECTOR',
  /** React Router 7's own manifest, flat with `parentId`. */
  'REACT_ROUTER_MANIFEST',
  /** Remix's manifest, the same shape under its older name. */
  'REMIX_MANIFEST',
  /** `__staticRouterHydrationData`, left by a server-rendered data router. */
  'STATIC_ROUTER_HYDRATION',
] as const;
export type RouteTableProbeId = (typeof ROUTE_TABLE_PROBES)[number];

/**
 * One route node, as the three routers describe themselves.
 *
 * Deliberately the UNION of what all three provide rather than three shapes:
 * one `evaluate`, one serialisable result, and the differences handled above
 * the seam. `path: null` is a route object with no path at all, which React
 * Router allows for a pathless layout route — a real thing, and not the same
 * as `path: ''`, which means "the parent's own URL".
 */
export interface RawRouteNode {
  path: string | null;
  /** React Router's index route: the parent's URL, with no segment of its own. */
  index?: boolean;
  /** Vue's named routes, React Router's `id`. */
  name?: string | null;
  redirectTo?: string | null;
  /** True when the children are behind a function we did not call. */
  lazy?: boolean;
  children?: RawRouteNode[];
  /** React Router's flat manifest form. */
  id?: string;
  parentId?: string | null;
}

/**
 * What the in-page script returns.
 *
 * `null` per framework means WE ASKED AND IT IS NOT THERE. An absent key would
 * mean the script did not look, which is why the script always writes all
 * three and why `probed` is separate: between them a reader can tell "this is
 * not a Vue application" from "the Vue probe was not run in this build of the
 * script".
 */
export interface RouteTableProbeResult {
  probed: RouteTableProbeId[];
  vue: RawRouteNode[] | null;
  angular: RawRouteNode[] | null;
  react: RawRouteNode[] | null;
  /** A per-probe failure the page itself hit. Empty when every probe ran clean. */
  errors: Array<{ probe: RouteTableProbeId; message: string }>;
}

/**
 * The one script this module runs in the page.
 *
 * NOT TESTED HERE, said plainly, in the style crawler.test.ts established:
 * this runs inside `page.evaluate()` and needs a real browser with a real
 * framework mounted in it. A unit test of it could only prove that a mock DOM
 * matches the code. Naming the gap beats a test that reads as coverage and
 * measures nothing — and it is exactly why there is NO judgement below this
 * comment. Every branch here is "does this global exist", every value returned
 * is a plain object, and the whole of the route-table logic lives in
 * {@link readRouteTable} over that plain data.
 */
export const ROUTE_TABLE_SCRIPT = `(() => {
  const probed = [];
  const errors = [];
  const probe = (id, fn) => {
    probed.push(id);
    try { return fn(); } catch (err) {
      errors.push({ probe: id, message: err && err.message ? String(err.message) : String(err) });
      return null;
    }
  };
  const node = (r) => ({
    path: typeof r.path === 'string' ? r.path : null,
    index: r.index === true,
    name: typeof r.name === 'string' ? r.name : (typeof r.id === 'string' ? r.id : null),
    redirectTo: typeof r.redirectTo === 'string' ? r.redirectTo : null,
    lazy: typeof r.loadChildren === 'function' || typeof r.lazy === 'function',
    children: Array.isArray(r.children) ? r.children.map(node) : undefined,
    id: typeof r.id === 'string' ? r.id : undefined,
    parentId: r.parentId === null || typeof r.parentId === 'string' ? r.parentId : undefined,
  });

  const vueFromRoot = probe('VUE_APP_ROOT', () => {
    for (const el of Array.from(document.querySelectorAll('[data-v-app], #app, #root, body > div'))) {
      const app = el.__vue_app__;
      const router = app && app.config && app.config.globalProperties && app.config.globalProperties.$router;
      if (router && typeof router.getRoutes === 'function') return router.getRoutes().map(node);
    }
    return null;
  });
  const vueFromGlobal = probe('VUE_ROUTER_GLOBAL', () => {
    const router = window.__VUE_ROUTER__;
    return router && typeof router.getRoutes === 'function' ? router.getRoutes().map(node) : null;
  });

  const angular = probe('ANGULAR_INJECTOR', () => {
    const ng = window.ng;
    if (!ng || typeof ng.getInjector !== 'function') return null;
    const host = document.querySelector('app-root, [ng-version]') || document.body;
    const injector = ng.getInjector(host);
    if (!injector || typeof injector.get !== 'function') return null;
    for (const token of Array.from(window.__qaaiRouterTokens__ || [])) {
      const router = injector.get(token, null);
      if (router && Array.isArray(router.config)) return router.config.map(node);
    }
    const byName = Object.values(injector.records || {}).find((r) => r && r.value && Array.isArray(r.value.config));
    return byName ? byName.value.config.map(node) : null;
  });

  const manifest = probe('REACT_ROUTER_MANIFEST', () => {
    const m = window.__reactRouterManifest;
    return m && m.routes ? Object.values(m.routes).map(node) : null;
  });
  const remix = probe('REMIX_MANIFEST', () => {
    const m = window.__remixManifest;
    return m && m.routes ? Object.values(m.routes).map(node) : null;
  });
  const hydration = probe('STATIC_ROUTER_HYDRATION', () => {
    const d = window.__staticRouterHydrationData;
    return d && Array.isArray(d.routes) ? d.routes.map(node) : null;
  });

  return {
    probed,
    errors,
    vue: vueFromRoot || vueFromGlobal,
    angular,
    react: manifest || remix || hydration,
  };
})()`;

// ─── 10. Template normalisation ──────────────────────────────────────────────

/*
 * `normaliseRoute` and `dynamicSegment` in packages/shared/src/codebase.ts do
 * exactly this and are both module-private, so they are reimplemented here
 * rather than left uncalled. That duplication is named, not hidden: the
 * remedy is two `export` keywords in codebase.ts, and until they land a
 * divergence between the two copies would make a route declared by the repo
 * and the same route declared by the build read as two different items. The
 * tests below pin the shared file's behaviour — `[[...slug]]`, `[...slug]`,
 * `[id]`, `*` and `**` — so a drift fails here.
 */

/** Strips the query and fragment, forces one leading slash, drops the trailing one. */
export function normaliseTemplate(raw: string): string {
  let out = raw.trim();
  out = out.split('?')[0]!.split('#')[0]!;
  if (!out.startsWith('/')) out = `/${out}`;
  out = out.replace(/\/{2,}/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out || '/';
}

/**
 * One segment in any router's spelling, as `:name` / `:name*`.
 *
 * Handles the four file-convention forms, the two colon forms and the two
 * wildcards, because a template list assembled from six documents has all of
 * them in it and a reader comparing `/docs/[...slug]` with `/docs/:slug*` has
 * to be told they are the same route.
 */
export function templateSegment(segment: string): string {
  const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
  if (optionalCatchAll) return `:${optionalCatchAll[1]}*`;
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (catchAll) return `:${catchAll[1]}*`;
  const bracket = /^\[(.+)\]$/.exec(segment);
  if (bracket) return `:${bracket[1]}`;
  const brace = /^\{(.+)\}$/.exec(segment);
  if (brace) {
    const inner = brace[1]!;
    // `{...rest}` is the OpenAPI/Hono spelling of a catch-all.
    return inner.startsWith('...') ? `:${inner.slice(3)}*` : `:${inner}`;
  }
  if (segment === '**') return '*';
  if (segment === '*') return '*';
  // `:id*`, `:id?`, `:id` — already colon-spelled. `?` is dropped: an optional
  // segment is two templates and inventing the second is not this module's job.
  const colon = /^:(.+)$/.exec(segment);
  if (colon) {
    const name = colon[1]!;
    if (name.endsWith('*') || name.endsWith('+')) return `:${name.slice(0, -1)}*`;
    return `:${name.replace(/\?$/, '')}`;
  }
  return segment;
}

/** Applies {@link templateSegment} across a path and normalises the result. */
export function toTemplate(raw: string): string {
  const segments = normaliseTemplate(raw)
    .split('/')
    .filter(Boolean)
    .map(templateSegment);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/** Dynamic segment names in order, and whether any swallows the remainder. */
export function templateParams(template: string): { params: string[]; catchAll: boolean } {
  const params: string[] = [];
  let catchAll = false;
  for (const segment of template.split('/').filter(Boolean)) {
    if (segment === '*') {
      catchAll = true;
      params.push('*');
      continue;
    }
    if (!segment.startsWith(':')) continue;
    const name = segment.slice(1);
    if (name.endsWith('*')) {
      catchAll = true;
      params.push(name.slice(0, -1));
      continue;
    }
    params.push(name);
  }
  return { params, catchAll };
}

/** Next.js Pages Router specials. `/404` and `/500` ARE pages; these are not. */
const PAGES_PLUMBING = new Set(['/_app', '/_error', '/_document', '/middleware']);

/**
 * App Router module names and whether each one is a URL.
 *
 * Compiler-enforced over its own key set so a new Next.js convention has to be
 * classified rather than falling through a default. The three `false` entries
 * are the interesting ones: a layout is a real module in a real directory, a
 * browser cannot request it, and counting it would put `/orders/layout` in a
 * customer's gap list.
 */
const APP_ROUTER_LEAVES = {
  page: 'PAGE',
  'not-found': 'PAGE',
  error: 'PAGE',
  'global-error': 'PAGE',
  route: 'ENDPOINT',
  layout: 'NOT_ADDRESSABLE',
  template: 'NOT_ADDRESSABLE',
  loading: 'NOT_ADDRESSABLE',
  default: 'NOT_ADDRESSABLE',
} as const satisfies Record<string, 'PAGE' | 'ENDPOINT' | 'NOT_ADDRESSABLE'>;

/**
 * An App Router segment's contribution to the URL, or null when it has none.
 *
 * `(shop)` is a route group, `@modal` a parallel-route slot and `_private` a
 * private folder. All three organise the tree and none appears in the URL,
 * which is the whole reason an app-router URL cannot be read off a module path
 * with a naive join — and the reason this extractor is graded DERIVED.
 */
function appRouterSegment(segment: string): string | null {
  if (/^\(.*\)$/.test(segment)) return null;
  if (segment.startsWith('@')) return null;
  if (segment.startsWith('_')) return null;
  return templateSegment(segment);
}

/** The pages roots a file path has to sit under before it may become a route. */
const PAGES_ROOTS = ['pages', 'app', 'routes', 'views', 'screens'];

/** Anything under one of these is a component, not a page, whatever it is called. */
const NOT_A_PAGE = /(?:^|\/)(?:components?|layouts?|composables?|hooks?|utils?|lib|stores?|assets?|styles?|tests?|__tests__|node_modules)(?:\/|$)/;

/**
 * A route template GUESSED from an original source path.
 *
 * The last resort, used by the source-map and asset-manifest extractors, and
 * the only producer of INFERRED templates. Returns null far more often than it
 * returns a template, on purpose: a wrong guess here becomes a page in the
 * customer's uncovered list that does not exist, and the first time they click
 * one and get a 404 the whole denominator is in question. So the path must sit
 * under a recognised pages root, must not sit under a components-shaped
 * directory, and must look like a page module.
 */
export function templateFromSourcePath(raw: string): string | null {
  // webpack:///./src/pages/orders/[id].tsx and friends.
  const path = cleanSourcePath(raw);
  if (!/\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx)$/.test(path)) return null;
  if (NOT_A_PAGE.test(path)) return null;

  const parts = path.split('/').filter((p) => p.length > 0 && p !== '.' && p !== '..');
  const rootAt = parts.findIndex((p) => PAGES_ROOTS.includes(p));
  if (rootAt === -1) return null;
  const isAppRouter = parts[rootAt] === 'app';
  const rest = parts.slice(rootAt + 1);
  if (rest.length === 0) return null;

  const last = rest[rest.length - 1]!;
  const leaf = last.replace(/\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx)$/, '');
  if (isAppRouter) {
    // Under `app/`, only a `page` module is a page. `app/orders/Row.tsx` is
    // colocated UI, and guessing `/orders/Row` from it is exactly the invented
    // route this function exists to refuse.
    const classified = APP_ROUTER_LEAVES[leaf as keyof typeof APP_ROUTER_LEAVES];
    if (classified !== 'PAGE') return null;
    const segments = rest.slice(0, -1).map(appRouterSegment);
    return normaliseTemplate(`/${segments.filter((s): s is string => s !== null).join('/')}`);
  }
  if (PAGES_PLUMBING.has(`/${leaf}`)) return null;
  const head = rest.slice(0, -1).map(templateSegment);
  const tail = leaf === 'index' ? [] : [templateSegment(leaf)];
  return normaliseTemplate(`/${[...head, ...tail].join('/')}`);
}

// ─── 11. The readers, one per document shape ─────────────────────────────────

/** What a reader produces: templates, plus everything it chose not to count. */
export interface ReadResult {
  templates: DeclaredRoute[];
  skipped: SkippedDeclaration[];
  unexpanded: UnexpandedSubtree[];
  /** Script URLs worth asking for a source map. */
  scriptCandidates: string[];
  locales: string[];
  /** Set when the document was recognised and could not be read. */
  failure: string | null;
}

function emptyRead(): ReadResult {
  return {
    templates: [],
    skipped: [],
    unexpanded: [],
    scriptCandidates: [],
    locales: [],
    failure: null,
  };
}

/** Accumulates skips by reason, keeping at most three examples of each. */
class SkipLedger {
  private readonly byReason = new Map<RouteSkipReason, SkippedDeclaration>();

  constructor(private readonly extractor: RouteExtractor) {}

  add(reason: RouteSkipReason, example: string): void {
    const existing = this.byReason.get(reason);
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 3) existing.examples.push(example);
      return;
    }
    this.byReason.set(reason, {
      extractor: this.extractor,
      reason,
      count: 1,
      examples: [example],
    });
  }

  drain(): SkippedDeclaration[] {
    return [...this.byReason.values()];
  }
}

function template(
  extractor: RouteExtractor,
  document: string,
  declaredAs: string,
  path: string,
  extra: Partial<Pick<DeclaredRoute, 'name' | 'redirectsTo' | 'file' | 'grade'>> = {},
): DeclaredRoute {
  const normalised = toTemplate(path);
  const { params, catchAll } = templateParams(normalised);
  const grade = extra.grade ?? EXTRACTOR_GRADE[extractor];
  /*
   * A null grade means this extractor produces candidates, never templates,
   * and reaching here with one is a programming error rather than a fact about
   * the customer's application. Throwing beats defaulting: a default would
   * silently stamp a guess with whatever grade happened to be first in the
   * list, and the whole point of the grade is that it cannot be casual.
   */
  if (grade === null) {
    throw new Error(`${extractor} is declared as producing no templates — see EXTRACTOR_GRADE`);
  }
  return {
    template: normalised,
    declaredAs,
    grade,
    extractor,
    document,
    params,
    catchAll,
    name: extra.name ?? null,
    redirectsTo: extra.redirectsTo ?? null,
    file: extra.file ?? null,
  };
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

/**
 * The string literals of a JavaScript array, read with a bracket scanner.
 *
 * A regex cannot do this and the first version of it was WRONG in the worst
 * available direction: `sortedPages:["/","/orders/[id]","/legacy"]` contains a
 * `]` INSIDE a dynamic route, so `\[([^\]]*)\]` stopped at `/orders/[id` and
 * silently dropped every page after the first dynamic one. A Next application
 * with dynamic routes would have reported a handful of static pages as its
 * complete route table — a truncation that makes the denominator smaller and
 * the coverage percentage higher, with nothing on screen to say it happened.
 *
 * Returns null when the array never closes, which is a truncated response and
 * must be a FAILED read rather than a short list.
 */
function jsStringArrayAt(body: string, openAt: number): string[] | null {
  const values: string[] = [];
  let depth = 0;
  let index = openAt;
  while (index < body.length) {
    const char = body[index]!;
    if (char === '[') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return values;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = '';
      let cursor = index + 1;
      while (cursor < body.length) {
        const inner = body[cursor]!;
        // An escape consumes the next character, so `"a\"b"` does not end early.
        if (inner === '\\') {
          value += body[cursor + 1] ?? '';
          cursor += 2;
          continue;
        }
        if (inner === char) break;
        value += inner;
        cursor += 1;
      }
      if (cursor >= body.length) return null;
      values.push(value);
      index = cursor + 1;
      continue;
    }
    index += 1;
  }
  return null;
}

/**
 * A source-map or bundler path, reduced to something a human can open.
 *
 * `webpack:///./src/pages/orders/[id].tsx` is the same file as
 * `src/pages/orders/[id].tsx`, and the second is the one that belongs in
 * `SurfaceItem.file` — it is the only field on an INFERRED item that is
 * genuinely ground truth, so it has to be the form the customer can click.
 */
function cleanSourcePath(raw: string): string {
  return raw
    .replace(/^[a-z-]+:\/{2,3}/i, '')
    .replace(/^\.?\//, '')
    .split('?')[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsIn(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * `routes-manifest.json` — the strongest answer this module can give.
 *
 * The Next.js build writes it and the server matches on the regexes in it, so
 * `dynamicRoutes[].page` is not our reading of the application's intent, it is
 * the application. `basePath` is applied, and that is not a detail: a build
 * with `basePath: '/app'` serves `/app/orders/[id]` while the manifest's
 * `page` is the unprefixed `/orders/[id]`, and a denominator full of routes
 * that 404 is worse than no denominator.
 */
export function readRoutesManifest(document: string, body: string): ReadResult {
  const out = emptyRead();
  const ledger = new SkipLedger('NEXT_ROUTES_MANIFEST');
  let parsed: unknown;
  try {
    parsed = parseJson(body);
  } catch (err) {
    out.failure = `routes-manifest.json did not parse as JSON: ${messageOf(err)}`;
    return out;
  }
  if (!isRecord(parsed)) {
    out.failure = 'routes-manifest.json is not a JSON object';
    return out;
  }
  const hasRouteKeys = 'staticRoutes' in parsed || 'dynamicRoutes' in parsed;
  if (!hasRouteKeys) {
    out.failure =
      'the document parsed but declares neither staticRoutes nor dynamicRoutes — the ' +
      'routes-manifest shape has changed and this extractor did not read it';
    return out;
  }

  const basePath = typeof parsed['basePath'] === 'string' ? parsed['basePath'] : '';
  const i18n = parsed['i18n'];
  if (isRecord(i18n)) out.locales = stringsIn(i18n['locales']);

  for (const group of ['staticRoutes', 'dynamicRoutes'] as const) {
    const entries = parsed[group];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry['page'] !== 'string') {
        ledger.add('UNPARSEABLE_ENTRY', `${group}[] with no string page`);
        continue;
      }
      const page = entry['page'];
      if (PAGES_PLUMBING.has(page)) {
        ledger.add('FRAMEWORK_PLUMBING', page);
        continue;
      }
      out.templates.push(
        template('NEXT_ROUTES_MANIFEST', document, page, `${basePath}${page}`),
      );
    }
  }

  for (const [group, reason] of [
    ['dataRoutes', 'DATA_ROUTE'],
    ['redirects', 'REWRITE_OR_REDIRECT_RULE'],
    ['rewrites', 'REWRITE_OR_REDIRECT_RULE'],
  ] as const) {
    const entries = parsed[group];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const label = entry['page'] ?? entry['source'] ?? entry['path'];
      ledger.add(reason, typeof label === 'string' ? label : group);
    }
  }

  out.skipped = ledger.drain();
  return out;
}

/**
 * `app-build-manifest.json` — the App Router's module map.
 *
 * Its keys are MODULE paths (`/orders/[id]/page`), not URLs, so the template is
 * computed by the segment rules and the grade is DERIVED. The three
 * classifications in {@link APP_ROUTER_LEAVES} are where the honesty is: a
 * `route` module is an endpoint whose method this document does not state, and
 * a `layout` has no URL at all. Both are counted into `skipped` so the
 * difference between our arithmetic and the customer's count of their own app
 * directory is explained rather than absent.
 */
export function readAppBuildManifest(document: string, body: string): ReadResult {
  const out = emptyRead();
  const ledger = new SkipLedger('NEXT_APP_BUILD_MANIFEST');
  let parsed: unknown;
  try {
    parsed = parseJson(body);
  } catch (err) {
    out.failure = `app-build-manifest.json did not parse as JSON: ${messageOf(err)}`;
    return out;
  }
  const pages = isRecord(parsed) ? parsed['pages'] : undefined;
  if (!isRecord(pages)) {
    out.failure =
      'the document parsed and has no `pages` object — the app-build-manifest shape has ' +
      'changed and this extractor did not read it';
    return out;
  }

  const seen = new Set<string>();
  for (const key of Object.keys(pages)) {
    const parts = key.split('/').filter(Boolean);
    const leaf = parts[parts.length - 1];
    if (leaf === undefined) {
      // The bare `/` key: an app directory whose root module is unnamed.
      ledger.add('UNPARSEABLE_ENTRY', key);
      continue;
    }
    const classified = APP_ROUTER_LEAVES[leaf as keyof typeof APP_ROUTER_LEAVES];
    if (classified === undefined) {
      ledger.add('UNPARSEABLE_ENTRY', key);
      continue;
    }
    if (classified === 'ENDPOINT') {
      ledger.add('API_HANDLER', key);
      continue;
    }
    if (classified === 'NOT_ADDRESSABLE') {
      ledger.add('NOT_ADDRESSABLE', key);
      continue;
    }
    const segments = parts.slice(0, -1).map(appRouterSegment);
    const path = normaliseTemplate(`/${segments.filter((s): s is string => s !== null).join('/')}`);
    /*
     * Two modules can share a URL: `/(shop)/cart/page` and `/(admin)/cart/page`
     * both serve `/cart`. That is a finding about THEIR app and a Next build
     * would refuse it, but we must not emit the same template twice and
     * double-count a route in the denominator.
     */
    if (seen.has(path)) {
      ledger.add('UNPARSEABLE_ENTRY', `${key} resolves to ${path}, already declared`);
      continue;
    }
    seen.add(path);
    out.templates.push(template('NEXT_APP_BUILD_MANIFEST', document, key, path));
  }

  out.skipped = ledger.drain();
  return out;
}

/**
 * `_buildManifest.js` — the Pages Router's `sortedPages`.
 *
 * A JavaScript file, and it is NOT evaluated. Fetching a script off the
 * application and running it would make this module an arbitrary-code
 * execution path aimed at whatever the customer's origin serves, which is the
 * same argument that makes `allowOffOriginSitemaps` false by default in
 * harvest.ts. `sortedPages` is a flat array of string literals; a regex over
 * it reads the whole route table and cannot run anything.
 */
export function readBuildManifest(document: string, body: string): ReadResult {
  const out = emptyRead();
  const ledger = new SkipLedger('NEXT_BUILD_MANIFEST');
  const at = /sortedPages\s*:\s*\[/.exec(body);
  if (at === null) {
    const looksLikeOne = /__BUILD_MANIFEST/.test(body);
    out.failure = looksLikeOne
      ? 'the file is a Next build manifest and has no sortedPages array — the shape has changed'
      : 'the file is not a Next build manifest';
    return out;
  }
  const pages = jsStringArrayAt(body, at.index + at[0].length - 1);
  if (pages === null) {
    out.failure = 'the sortedPages array is not closed — the file was truncated in transit';
    return out;
  }
  if (pages.length === 0) {
    // An empty sortedPages is a real, readable answer about a real build.
    out.skipped = ledger.drain();
    return out;
  }
  for (const page of pages) {
    if (PAGES_PLUMBING.has(page)) {
      ledger.add('FRAMEWORK_PLUMBING', page);
      continue;
    }
    out.templates.push(template('NEXT_BUILD_MANIFEST', document, page, page));
  }
  out.skipped = ledger.drain();
  return out;
}

/**
 * `asset-manifest.json`, in both the shapes that name.
 *
 * CRA's shape lists BUILD FILES and no routes whatever, and the honest output
 * for it is zero templates plus a `NOT_A_ROUTE_DOCUMENT` skip saying so — not
 * a route list guessed from chunk names. Vite's shape is different: each entry
 * can carry `src`, the original module path, and for a file-convention router
 * (`vite-plugin-pages`, `unplugin-vue-router`) that path IS the route. Even
 * then the template is INFERRED, because nothing in the manifest says the
 * application routes to it.
 */
export function readAssetManifest(document: string, body: string): ReadResult {
  const out = emptyRead();
  const ledger = new SkipLedger('ASSET_MANIFEST');
  let parsed: unknown;
  try {
    parsed = parseJson(body);
  } catch (err) {
    out.failure = `asset-manifest.json did not parse as JSON: ${messageOf(err)}`;
    return out;
  }
  if (!isRecord(parsed)) {
    out.failure = 'asset-manifest.json is not a JSON object';
    return out;
  }

  const files = parsed['files'];
  if (isRecord(files)) {
    // CRA. Nothing here is a route; the scripts are source-map candidates.
    for (const value of Object.values(files)) {
      if (typeof value === 'string' && /\.m?js$/.test(value.split('?')[0]!)) {
        out.scriptCandidates.push(value);
      }
    }
    ledger.add(
      'NOT_A_ROUTE_DOCUMENT',
      `${Object.keys(files).length} build files, no route declarations`,
    );
    out.skipped = ledger.drain();
    return out;
  }

  const seen = new Set<string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      ledger.add('UNPARSEABLE_ENTRY', key);
      continue;
    }
    const file = value['file'];
    if (typeof file === 'string' && /\.m?js$/.test(file.split('?')[0]!)) {
      out.scriptCandidates.push(file);
    }
    const src = typeof value['src'] === 'string' ? value['src'] : key;
    const guessed = templateFromSourcePath(src);
    if (guessed === null) {
      ledger.add('NOT_A_ROUTE_DOCUMENT', src);
      continue;
    }
    if (seen.has(guessed)) continue;
    seen.add(guessed);
    out.templates.push(template('ASSET_MANIFEST', document, src, guessed, { file: src }));
  }

  out.skipped = ledger.drain();
  return out;
}

/** `src`/`href` on the script-ish tags, which is all the module graph is. */
const MODULE_GRAPH_TAGS =
  /<(?:script|link)\b([^>]*?)\/?>/gi;

/**
 * The module graph in a built index.html.
 *
 * ZERO TEMPLATES, by construction and not by accident — see the null in
 * {@link EXTRACTOR_GRADE}. A chunk named `OrdersDetail-a1b2c3.js` is a chunk;
 * `/orders-detail` is a route we would have invented. What this produces is the
 * script candidate list the source-map pass needs, plus the `buildId` that
 * makes `_buildManifest.js` addressable at all.
 */
export function readModuleGraph(document: string, body: string): ReadResult & { buildId: string | null } {
  const out = { ...emptyRead(), buildId: null as string | null };
  const ledger = new SkipLedger('MODULE_GRAPH');
  let matches = 0;
  for (const tag of body.matchAll(MODULE_GRAPH_TAGS)) {
    const attrs = tag[1] ?? '';
    const rel = /\brel\s*=\s*["']?([a-z-]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? null;
    if (rel !== null && rel !== 'modulepreload' && rel !== 'preload') continue;
    const url = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const value = url?.[1] ?? url?.[2] ?? url?.[3] ?? null;
    if (value === null || value.length === 0) continue;
    if (!/\.m?js(?:$|\?)/.test(value)) continue;
    matches += 1;
    out.scriptCandidates.push(value);
    const build = /\/_next\/static\/([^/]+)\/_buildManifest\.js/.exec(value);
    if (build) out.buildId = build[1]!;
  }
  /*
   * `__NEXT_DATA__` carries the buildId even when the manifest script is not in
   * the markup, which happens on a statically exported page. Read as a string,
   * never by evaluating the JSON blob's surrounding script.
   */
  if (out.buildId === null) {
    const inline = /"buildId"\s*:\s*"([^"]+)"/.exec(body);
    if (inline) out.buildId = inline[1]!;
  }
  if (matches > 0) {
    ledger.add(
      'NOT_A_ROUTE_DOCUMENT',
      `${matches} script modules — chunk names, which are not routes`,
    );
  }
  out.skipped = ledger.drain();
  return out;
}

/**
 * A source map's `sources` list. The last resort, and every template a guess.
 *
 * The one thing it has that nothing else does is the ORIGINAL FILE NAME, which
 * is a fact we genuinely observed — so `file` on these templates is ground
 * truth even though `template` is not. A reader that wants to show the
 * customer something defensible about an INFERRED route shows them the file.
 */
export function readSourceMap(document: string, body: string): ReadResult {
  const out = emptyRead();
  const ledger = new SkipLedger('SOURCE_MAP');
  let parsed: unknown;
  try {
    parsed = parseJson(body);
  } catch (err) {
    out.failure = `${document} did not parse as JSON: ${messageOf(err)}`;
    return out;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['sources'])) {
    out.failure = `${document} parsed and has no \`sources\` array — not a source map`;
    return out;
  }
  const root = typeof parsed['sourceRoot'] === 'string' ? parsed['sourceRoot'] : '';
  const seen = new Set<string>();
  for (const source of stringsIn(parsed['sources'])) {
    const joined =
      root.length > 0 ? `${root.replace(/\/$/, '')}/${source.replace(/^\//, '')}` : source;
    const guessed = templateFromSourcePath(joined);
    if (guessed === null) continue;
    if (seen.has(guessed)) continue;
    seen.add(guessed);
    const file = cleanSourcePath(joined);
    out.templates.push(template('SOURCE_MAP', document, file, guessed, { file }));
  }
  if (seen.size === 0) ledger.add('NOT_A_ROUTE_DOCUMENT', `${document}: no page-shaped sources`);
  out.skipped = ledger.drain();
  return out;
}

// ─── 12. The route table the running app hands over ─────────────────────────

/**
 * Turns one {@link RouteTableProbeResult} into templates for whichever of the
 * three routers answered.
 *
 * ALL the judgement for the in-page path is here, over plain data, which is
 * what makes it testable. Three shapes, three joins:
 *
 *   Vue      `getRoutes()` is already flat and already absolute. Take `path`.
 *   Angular  a tree of RELATIVE paths. `''` means the parent's own URL, `**`
 *            is the wildcard, and `loadChildren` is a subtree we cannot see.
 *   React    either nested with relative paths and `index`, or flat with
 *            `parentId`. Both are handled, because React Router 7 ships the
 *            flat form on `window` and `createBrowserRouter` is nested.
 *
 * Getting the Angular join wrong is how a 412-route application enumerates as
 * nine top-level templates, so the depth cap is reported and the lazy subtrees
 * are reported, and neither is allowed to be silent.
 */
export function readRouteTable(
  probe: RouteTableProbeResult,
  options: { treeDepth?: number } = {},
): ReadResult & { caps: RouteManifestCapBite[]; unknownProbes: string[] } {
  const out = {
    ...emptyRead(),
    caps: [] as RouteManifestCapBite[],
    unknownProbes: [] as string[],
  };
  const depthLimit = options.treeDepth ?? DEFAULT_TREE_DEPTH;
  let depthBites = 0;
  let depthDiscarded = 0;

  for (const id of probe.probed) {
    if (!(ROUTE_TABLE_PROBES as readonly string[]).includes(id)) out.unknownProbes.push(id);
  }

  const walk = (
    extractor: RouteExtractor,
    nodes: readonly RawRouteNode[],
    parent: string,
    depth: number,
    seen: Set<string>,
  ): void => {
    if (depth > depthLimit) {
      depthBites += 1;
      depthDiscarded += nodes.length;
      return;
    }
    for (const node of nodes) {
      const own = node.index === true ? '' : (node.path ?? '');
      const joined = own.startsWith('/') ? own : `${parent}/${own}`;
      const path = toTemplate(joined);
      const addressable = node.path !== null || node.index === true;
      if (addressable && !seen.has(`${path}|${node.redirectTo ?? ''}`)) {
        seen.add(`${path}|${node.redirectTo ?? ''}`);
        out.templates.push(
          template(extractor, extractor, own === '' ? (node.index === true ? '(index)' : '') : own, path, {
            name: node.name ?? null,
            redirectsTo: node.redirectTo ?? null,
          }),
        );
      }
      if (node.lazy === true) {
        out.unexpanded.push({
          extractor,
          parent: path,
          reason: extractor === 'ANGULAR_ROUTER' ? 'LAZY_MODULE' : 'LAZY_ROUTE_OBJECT',
          detail:
            `${path} defers its children to a function the application had not called, so at ` +
            'least one route below it exists and is not in this list',
        });
      }
      if (node.children && node.children.length > 0) {
        walk(extractor, node.children, path === '/' ? '' : path, depth + 1, seen);
      }
    }
  };

  if (probe.vue !== null) {
    // `getRoutes()` is flat and absolute: a tree walk would double-count every
    // child, because Vue returns the children AND their parents in one list.
    const seen = new Set<string>();
    for (const node of probe.vue) {
      if (node.path === null) continue;
      const path = toTemplate(node.path);
      if (seen.has(path)) continue;
      seen.add(path);
      out.templates.push(
        template('VUE_ROUTER', 'VUE_ROUTER', node.path, path, {
          name: node.name ?? null,
          redirectsTo: node.redirectTo ?? null,
        }),
      );
    }
  }
  if (probe.angular !== null) walk('ANGULAR_ROUTER', probe.angular, '', 0, new Set());
  if (probe.react !== null) {
    const flat = probe.react.some((node) => node.parentId !== undefined);
    if (flat) {
      out.templates.push(...flattenByParentId(probe.react));
    } else {
      walk('REACT_ROUTER', probe.react, '', 0, new Set());
    }
  }

  if (depthBites > 0) {
    out.caps.push({
      cap: 'ROUTE_TREE_DEPTH',
      limit: depthLimit,
      bites: depthBites,
      discarded: depthDiscarded,
      scope: null,
      reason:
        `the route tree is deeper than ${depthLimit} levels; ${depthDiscarded} nodes below that ` +
        'depth were not expanded, so at least that many more routes exist',
    });
  }
  return out;
}

/**
 * React Router 7's flat manifest: `{ id, parentId, path, index }`.
 *
 * The parent chain has to be walked to build a URL, and a cycle in `parentId`
 * would hang that walk. A manifest with a cycle is a manifest we do not
 * understand, so the node is skipped and counted rather than guessed at — and
 * an orphan whose `parentId` names a route that is not in the manifest is the
 * same case.
 */
function flattenByParentId(nodes: readonly RawRouteNode[]): DeclaredRoute[] {
  const byId = new Map<string, RawRouteNode>();
  for (const node of nodes) if (node.id !== undefined) byId.set(node.id, node);

  const out: DeclaredRoute[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.path === null && node.index !== true) continue;
    const chain: string[] = [];
    let current: RawRouteNode | undefined = node;
    const visited = new Set<string>();
    let broken = false;
    while (current) {
      if (current.id !== undefined) {
        if (visited.has(current.id)) {
          broken = true;
          break;
        }
        visited.add(current.id);
      }
      const own = current.index === true ? '' : (current.path ?? '');
      if (own.startsWith('/')) {
        chain.unshift(own);
        break;
      }
      if (own.length > 0) chain.unshift(own);
      const parentId: string | null | undefined = current.parentId;
      if (parentId === null || parentId === undefined) break;
      const parent = byId.get(parentId);
      if (parent === undefined) {
        broken = true;
        break;
      }
      current = parent;
    }
    if (broken) continue;
    const path = toTemplate(`/${chain.join('/')}`);
    const key = `${path}|${node.redirectTo ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      template('REACT_ROUTER', 'REACT_ROUTER', node.path ?? '(index)', path, {
        name: node.name ?? node.id ?? null,
        redirectsTo: node.redirectTo ?? null,
      }),
    );
  }
  return out;
}

// ─── 13. The orchestrator ────────────────────────────────────────────────────

const DEFAULT_TEMPLATE_BUDGET = 5_000;
const DEFAULT_DOCUMENT_BUDGET = 12;
const DEFAULT_SCRIPT_CANDIDATE_BUDGET = 40;
const DEFAULT_SOURCE_MAP_BUDGET = 10;
const DEFAULT_TREE_DEPTH = 12;

/**
 * Where each fetched extractor's document conventionally lives.
 *
 * `routes-manifest.json` and `app-build-manifest.json` are written into
 * `.next/` and are usually NOT served, so these will usually 404 — which is an
 * ABSENT, not a failure, and is the honest answer. The point of trying is that
 * the strongest route table in existence costs one request when it IS served,
 * and `extraDocuments` lets a customer who serves it elsewhere say so without
 * an environment variable.
 */
export const CONVENTIONAL_DOCUMENTS = {
  NEXT_ROUTES_MANIFEST: ['/_next/routes-manifest.json', '/routes-manifest.json'],
  NEXT_APP_BUILD_MANIFEST: ['/_next/app-build-manifest.json', '/app-build-manifest.json'],
  ASSET_MANIFEST: ['/asset-manifest.json', '/.vite/manifest.json', '/manifest.json'],
  MODULE_GRAPH: ['/'],
} as const satisfies Partial<Record<RouteExtractor, readonly string[]>>;

export interface RouteManifestOptions {
  baseUrl: string;
  /**
   * The HTTP capability. NULL means the five fetched extractors report
   * UNAVAILABLE — never ABSENT. `playwrightCrawlAdapter().fetcher` in
   * crawler.ts already satisfies this.
   */
  fetcher: HarvestFetcher | null;
  /** The in-page capability. NULL means the three router extractors report UNAVAILABLE. */
  reader: RouteTableReader | null;
  /** Restrict the run. Omitted means all nine. */
  extractors?: readonly RouteExtractor[];
  /** Extra document URLs the customer serves their route table at. */
  extraDocuments?: readonly string[];
  templateBudget?: number;
  documentBudget?: number;
  scriptCandidateBudget?: number;
  sourceMapBudget?: number;
  treeDepth?: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function absoluteUrl(baseUrl: string, path: string): string {
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

/**
 * Asks the application for its own route table, nine ways.
 *
 * Returns a {@link RouteManifest} and never a bare array — see the header for
 * why an empty list is not one of the answers. Every cap bites visibly, every
 * extractor's outcome is one of four states, and `complete` is false the
 * moment anything failed, so no caller can print "your build declares N
 * routes" over a read that half worked.
 */
export async function extractRouteManifest(
  options: RouteManifestOptions,
): Promise<RouteManifest> {
  const wanted = new Set<RouteExtractor>(options.extractors ?? ROUTE_EXTRACTORS);
  const templateBudget = options.templateBudget ?? DEFAULT_TEMPLATE_BUDGET;
  const documentBudget = options.documentBudget ?? DEFAULT_DOCUMENT_BUDGET;
  const candidateBudget = options.scriptCandidateBudget ?? DEFAULT_SCRIPT_CANDIDATE_BUDGET;
  const sourceMapBudget = options.sourceMapBudget ?? DEFAULT_SOURCE_MAP_BUDGET;

  const attempts: RouteExtractorAttempt[] = [];
  const caps: RouteManifestCapBite[] = [];
  const unexpanded: UnexpandedSubtree[] = [];
  const skipped: SkippedDeclaration[] = [];
  const locales = new Set<string>();
  const templates: DeclaredRoute[] = [];
  const candidates: string[] = [];
  let candidatesDiscarded = 0;
  /*
   * DISTINCT templates the budget cost us, not candidate readings of them.
   *
   * A counter here reported `discarded: 2` when two extractors both declared
   * the one route that did not fit, and the cap's sentence is about TEMPLATES —
   * "at least 2 more templates were declared and are not in this list" over an
   * application missing exactly one. `discarded` is a FLOOR, and a floor that
   * counts the same route twice is a fabricated one.
   */
  const templatesDiscarded = new Set<string>();
  let documentsFetched = 0;
  let documentsDiscarded = 0;
  let anyDocumentServed = false;

  /** Keeps the strongest grade for a template and counts the budget honestly. */
  const accept = (found: readonly DeclaredRoute[]): number => {
    let added = 0;
    for (const candidate of found) {
      /*
       * Two extractors declaring one route is the normal case — a Next app
       * serves both `_buildManifest.js` and `routes-manifest.json` — and the
       * DECLARED reading must win over the INFERRED one. Keeping both would
       * double-count the route in the denominator; keeping the weaker one
       * would report a guess where ground truth was available.
       *
       * ── THIS RUNS BEFORE THE BUDGET CHECK, AND THE ORDER IS THE FIX ───────
       *
       * It used to run after, which broke the cap in both directions at once.
       *
       * A route we ALREADY HOLD was counted as a route we LOST: two extractors
       * declaring the same two routes under a budget of two reported "at least
       * 2 more templates were declared and are not in this list" about an
       * application that declares exactly the two on screen. A cap's count is a
       * FLOOR and never an estimate, and a number invented in the alarming
       * direction is the same sin as one invented in the flattering direction.
       *
       * And a full list could no longer be CORRECTED. The asset manifest is
       * INFERRED and runs before the in-page routers, which are DECLARED, so
       * once the budget was spent the stored row kept "the application may not
       * route to it" about a route the application's own router declares — a
       * cap deciding a provenance question. A duplicate consumes no slot and a
       * grade upgrade replaces in place, so neither needs to ask the budget.
       */
      const existing = templates.findIndex((t) => t.template === candidate.template);
      if (existing >= 0) {
        const incumbent = templates[existing]!;
        const beats =
          ROUTE_TEMPLATE_GRADES.indexOf(candidate.grade) <
          ROUTE_TEMPLATE_GRADES.indexOf(incumbent.grade);
        if (beats) templates[existing] = candidate;
        continue;
      }
      if (templates.length >= templateBudget) {
        templatesDiscarded.add(candidate.template);
        continue;
      }
      templates.push(candidate);
      added += 1;
    }
    return added;
  };

  const absorb = (result: ReadResult): void => {
    skipped.push(...result.skipped);
    unexpanded.push(...result.unexpanded);
    for (const locale of result.locales) locales.add(locale);
    for (const script of result.scriptCandidates) {
      if (candidates.length >= candidateBudget) {
        candidatesDiscarded += 1;
        continue;
      }
      if (!candidates.includes(script)) candidates.push(script);
    }
  };

  const fetchText = async (url: string): Promise<FetchedText | 'BUDGET'> => {
    if (documentsFetched >= documentBudget) {
      documentsDiscarded += 1;
      return 'BUDGET';
    }
    documentsFetched += 1;
    const fetcher = options.fetcher;
    /* Unreachable while callers go through `runFetched`, which checks first. */
    if (fetcher === null) return { status: null, body: null, error: 'no fetcher' };
    try {
      return await fetcher.get(url);
    } catch (err) {
      // A fetcher is documented as never throwing; one that does must not take
      // the whole enumeration down with it.
      return { status: null, body: null, error: messageOf(err) };
    }
  };

  /** Tries an extractor's conventional URLs in order and records ONE attempt. */
  const runFetched = async (
    extractor: RouteExtractor,
    urls: readonly string[],
    read: (document: string, body: string) => ReadResult,
  ): Promise<void> => {
    if (!wanted.has(extractor)) return;
    if (options.fetcher === null) {
      attempts.push(
        unavailable(extractor, 'no fetcher was injected, so this document was never requested'),
      );
      return;
    }
    const notFound: string[] = [];
    for (const path of urls) {
      const url = absoluteUrl(options.baseUrl, path);
      const response = await fetchText(url);
      if (response === 'BUDGET') {
        attempts.push(
          failed(
            extractor,
            url,
            `the document budget of ${documentBudget} was spent before this document was ` +
              'requested, so nothing is known about it',
          ),
        );
        return;
      }
      if (response.status === null) {
        attempts.push(
          failed(extractor, url, `the request did not complete: ${response.error ?? 'no detail'}`),
        );
        return;
      }
      if (response.status === 404 || response.status === 410) {
        notFound.push(`${url} → ${response.status}`);
        continue;
      }
      if (response.status >= 400) {
        attempts.push(failed(extractor, url, `the server answered ${response.status}`));
        return;
      }
      if (response.body === null || response.body.length === 0) {
        attempts.push(failed(extractor, url, `${response.status} with no body we could decode`));
        return;
      }
      anyDocumentServed = true;
      const result = read(url, response.body);
      if (result.failure !== null) {
        attempts.push(failed(extractor, url, result.failure));
        absorb(result);
        return;
      }
      absorb(result);
      attempts.push(measured(extractor, url, accept(result.templates)));
      return;
    }
    attempts.push(
      absent(
        extractor,
        urls[0] === undefined ? null : absoluteUrl(options.baseUrl, urls[0]),
        `not served at ${notFound.length} conventional location${notFound.length === 1 ? '' : 's'}: ${notFound.join(', ')}`,
      ),
    );
  };

  // The module graph goes first: it supplies the buildId that makes
  // `_buildManifest.js` addressable and the scripts the source maps need.
  let buildId: string | null = null;
  await runFetched('MODULE_GRAPH', CONVENTIONAL_DOCUMENTS.MODULE_GRAPH, (document, body) => {
    const result = readModuleGraph(document, body);
    buildId = result.buildId;
    return result;
  });

  await runFetched(
    'NEXT_ROUTES_MANIFEST',
    CONVENTIONAL_DOCUMENTS.NEXT_ROUTES_MANIFEST,
    readRoutesManifest,
  );
  await runFetched(
    'NEXT_APP_BUILD_MANIFEST',
    CONVENTIONAL_DOCUMENTS.NEXT_APP_BUILD_MANIFEST,
    readAppBuildManifest,
  );

  if (wanted.has('NEXT_BUILD_MANIFEST')) {
    const declared = (options.extraDocuments ?? []).filter((url) =>
      url.includes('_buildManifest'),
    );
    const fromBuildId = buildId === null ? [] : [`/_next/static/${buildId}/_buildManifest.js`];
    const urls = [...declared, ...fromBuildId];
    /*
     * The fetcher check comes FIRST and the order is the whole point. Without
     * it, a run with no fetcher reported ABSENT with the reason "the served
     * HTML names no buildId" — a claim about the customer's application made
     * without ever requesting a byte of it. A source's silence read as a
     * source's answer, in the one place that would have been hardest to spot.
     */
    if (options.fetcher === null) {
      attempts.push(
        unavailable(
          'NEXT_BUILD_MANIFEST',
          'no fetcher was injected, so the served HTML was never read and no buildId could be ' +
            'discovered',
        ),
      );
    } else if (urls.length === 0) {
      attempts.push(
        absent(
          'NEXT_BUILD_MANIFEST',
          null,
          'the served HTML names no buildId and no _buildManifest.js was declared, so the ' +
            'Pages Router manifest has no address to request',
        ),
      );
    } else {
      await runFetched('NEXT_BUILD_MANIFEST', urls, readBuildManifest);
    }
  }

  await runFetched('ASSET_MANIFEST', CONVENTIONAL_DOCUMENTS.ASSET_MANIFEST, readAssetManifest);

  // Any other declared document is offered to every parser that recognises it.
  for (const extra of options.extraDocuments ?? []) {
    if (extra.includes('_buildManifest')) continue;
    if (extra.endsWith('routes-manifest.json') && wanted.has('NEXT_ROUTES_MANIFEST')) {
      await runFetched('NEXT_ROUTES_MANIFEST', [extra], readRoutesManifest);
    }
  }

  // ── The in-page route tables ──
  if (options.reader === null) {
    for (const extractor of ['VUE_ROUTER', 'ANGULAR_ROUTER', 'REACT_ROUTER'] as const) {
      if (wanted.has(extractor)) {
        attempts.push(
          unavailable(
            extractor,
            'no in-page reader was injected, so the running application was never asked for ' +
              'its router',
          ),
        );
      }
    }
  } else {
    const inPage = (['VUE_ROUTER', 'ANGULAR_ROUTER', 'REACT_ROUTER'] as const).filter((e) =>
      wanted.has(e),
    );
    if (inPage.length > 0) {
      let probe: RouteTableProbeResult | null = null;
      let probeError: string | null = null;
      try {
        probe = await options.reader.evaluate<RouteTableProbeResult>(ROUTE_TABLE_SCRIPT);
      } catch (err) {
        probeError = messageOf(err);
      }
      if (probe === null || typeof probe !== 'object') {
        for (const extractor of inPage) {
          attempts.push(
            failed(
              extractor,
              extractor,
              `the in-page route-table read did not complete: ${probeError ?? 'it returned nothing'}`,
            ),
          );
        }
      } else {
        const read = readRouteTable(probe, { treeDepth: options.treeDepth });
        absorb(read);
        caps.push(...read.caps);
        const byExtractor = new Map<RouteExtractor, DeclaredRoute[]>();
        for (const found of read.templates) {
          const list = byExtractor.get(found.extractor) ?? [];
          list.push(found);
          byExtractor.set(found.extractor, list);
        }
        const raw: Record<'VUE_ROUTER' | 'ANGULAR_ROUTER' | 'REACT_ROUTER', RawRouteNode[] | null> =
          { VUE_ROUTER: probe.vue, ANGULAR_ROUTER: probe.angular, REACT_ROUTER: probe.react };
        for (const extractor of inPage) {
          const owned: readonly string[] = PROBES_FOR_EXTRACTOR[extractor];
          const pageError = probe.errors.find((e) => owned.includes(e.probe));
          if (raw[extractor] === null) {
            attempts.push(
              pageError
                ? failed(
                    extractor,
                    extractor,
                    `the ${extractor} probe threw inside the page: ${pageError.message}`,
                  )
                : absent(
                    extractor,
                    extractor,
                    'the running application exposes no router of this kind',
                  ),
            );
            continue;
          }
          attempts.push(
            measured(extractor, extractor, accept(byExtractor.get(extractor) ?? [])),
          );
        }
        if (read.unknownProbes.length > 0) {
          /*
           * The script reported a probe this module does not know. That is
           * script/module drift and it is recorded as a FAILED read rather
           * than ignored, because the framework behind an unknown probe is one
           * nobody is enumerating and nothing else on screen would say so.
           */
          attempts.push(
            failed(
              'REACT_ROUTER',
              'ROUTE_TABLE_PROBES',
              `the in-page script probed ${read.unknownProbes.join(', ')}, which is not in ` +
                'ROUTE_TABLE_PROBES — the script and this module have drifted',
            ),
          );
        }
      }
    }
  }

  // ── Source maps: the last resort ──
  if (wanted.has('SOURCE_MAP')) {
    if (options.fetcher === null) {
      attempts.push(
        unavailable('SOURCE_MAP', 'no fetcher was injected, so no source map was requested'),
      );
    } else if (candidates.length === 0) {
      attempts.push(
        absent(
          'SOURCE_MAP',
          null,
          'no script candidates were collected, so there was nothing to ask for a map for',
        ),
      );
    } else {
      const take = candidates.slice(0, sourceMapBudget);
      if (candidates.length > take.length) {
        caps.push({
          cap: 'SOURCE_MAP_BUDGET',
          limit: sourceMapBudget,
          bites: 1,
          discarded: candidates.length - take.length,
          scope: null,
          reason:
            `${candidates.length} scripts were collected and only ${sourceMapBudget} were asked ` +
            `for a source map, so at least ${candidates.length - take.length} more maps exist ` +
            'and were not read',
        });
      }
      let mapsRead = 0;
      let found = 0;
      const failures: string[] = [];
      for (const script of take) {
        const url = `${absoluteUrl(options.baseUrl, script).split('?')[0]!}.map`;
        const response = await fetchText(url);
        if (response === 'BUDGET') {
          documentsDiscarded += 1;
          continue;
        }
        if (response.status === null) {
          failures.push(`${url}: ${response.error ?? 'the request did not complete'}`);
          continue;
        }
        if (response.status >= 400 || response.body === null || response.body.length === 0) {
          // Maps are deliberately unpublished in most production builds. Not a
          // finding, not a failure: an absence we expected.
          continue;
        }
        anyDocumentServed = true;
        const result = readSourceMap(url, response.body);
        if (result.failure !== null) {
          failures.push(result.failure);
          continue;
        }
        mapsRead += 1;
        absorb(result);
        found += accept(result.templates);
      }
      if (mapsRead > 0) {
        attempts.push(measured('SOURCE_MAP', `${mapsRead} source maps`, found));
      } else if (failures.length > 0) {
        attempts.push(failed('SOURCE_MAP', `${take.length} candidates`, failures.join('; ')));
      } else {
        attempts.push(
          absent(
            'SOURCE_MAP',
            `${take.length} candidates`,
            `none of the ${take.length} scripts publishes a .map alongside it`,
          ),
        );
      }
    }
  }

  if (templatesDiscarded.size > 0) {
    caps.push({
      cap: 'TEMPLATE_BUDGET',
      limit: templateBudget,
      bites: 1,
      discarded: templatesDiscarded.size,
      scope: null,
      reason:
        `the template budget of ${templateBudget} was reached; at least ${templatesDiscarded.size} ` +
        'more templates were declared and are not in this list',
    });
  }
  if (documentsDiscarded > 0) {
    caps.push({
      cap: 'DOCUMENT_BUDGET',
      limit: documentBudget,
      bites: 1,
      discarded: documentsDiscarded,
      scope: null,
      reason:
        `the document budget of ${documentBudget} was reached; ${documentsDiscarded} further ` +
        'documents were not requested and nothing is known about them',
    });
  }
  if (candidatesDiscarded > 0) {
    caps.push({
      cap: 'SCRIPT_CANDIDATE_BUDGET',
      limit: candidateBudget,
      bites: 1,
      discarded: candidatesDiscarded,
      scope: null,
      reason:
        `the script candidate limit of ${candidateBudget} was reached; ${candidatesDiscarded} ` +
        'further scripts were never considered for a source map',
    });
  }

  const base: RouteManifestBase = {
    baseUrl: options.baseUrl,
    attempts,
    caps,
    unexpanded,
    skipped,
    locales: [...locales],
    scriptCandidates: candidates,
  };

  const incomplete: string[] = [];
  for (const attempt of attempts) {
    if (attempt.state === 'FAILED') {
      incomplete.push(
        `${ROUTE_EXTRACTOR_LABELS[attempt.extractor]} could not be read: ${attempt.reason}`,
      );
    }
    if (attempt.state === 'UNAVAILABLE') {
      incomplete.push(`${ROUTE_EXTRACTOR_LABELS[attempt.extractor]} was not consulted: ${attempt.reason}`);
    }
  }
  for (const cap of caps) incomplete.push(cap.reason);
  for (const subtree of unexpanded) incomplete.push(subtree.detail);

  if (templates.length > 0) {
    return { ...base, state: 'READ', templates, complete: incomplete.length === 0, incomplete };
  }

  /*
   * EMPTY is "an extractor read its document and the document declared zero
   * routes" — a measured zero, and a real answer about the application. ONLY AN
   * EXTRACTOR THAT CAN DECLARE A ROUTE MAY CAST THAT VOTE.
   *
   * `MODULE_GRAPH`'s entry in `EXTRACTOR_GRADE` is null because it produces
   * script candidates and never templates: a MEASURED module-graph read means
   * "we read your index.html", not "your application declares no routes".
   * Counting it turned every application whose `/` answers 200 into EMPTY —
   * `readDocument` naming the index.html as the table that declared nothing —
   * so a run that read no route table at all reported a denominator of zero
   * rather than NOT_AVAILABLE. The null that became 0, on the denominator
   * itself, and the one place in this module it would have been hardest to see.
   */
  const readSomething = attempts.find(
    (a) => a.state === 'MEASURED' && EXTRACTOR_GRADE[a.extractor] !== null,
  );
  if (readSomething !== undefined) {
    return {
      ...base,
      state: 'EMPTY',
      readDocument: readSomething.document ?? ROUTE_EXTRACTOR_LABELS[readSomething.extractor],
      complete: incomplete.length === 0,
      incomplete,
    };
  }

  const reason: RouteManifestUnavailability =
    options.fetcher === null && options.reader === null
      ? 'NOTHING_LOOKED'
      : attempts.some((a) => a.state === 'FAILED') && anyDocumentServed
        ? 'ALL_EXTRACTORS_FAILED'
        : 'NO_EXTRACTOR_APPLIED';
  return {
    ...base,
    state: 'NOT_AVAILABLE',
    reason,
    detail: ROUTE_MANIFEST_UNAVAILABILITY_LABELS[reason],
  };
}

/**
 * Which probes feed which extractor, so a probe that threw is attributed to
 * the framework it was looking for.
 *
 * Compiler-enforced. A probe added to {@link ROUTE_TABLE_PROBES} without an
 * entry here would make an in-page exception land on the wrong framework's
 * attempt, which is a FAILED read reported about a router that answered fine.
 */
const PROBES_FOR_EXTRACTOR = {
  VUE_ROUTER: ['VUE_APP_ROOT', 'VUE_ROUTER_GLOBAL'],
  ANGULAR_ROUTER: ['ANGULAR_INJECTOR'],
  REACT_ROUTER: ['REACT_ROUTER_MANIFEST', 'REMIX_MANIFEST', 'STATIC_ROUTER_HYDRATION'],
} as const satisfies Record<
  'VUE_ROUTER' | 'ANGULAR_ROUTER' | 'REACT_ROUTER',
  readonly RouteTableProbeId[]
>;

// ─── 14. The write path into the surface registry ───────────────────────────

/**
 * The declarer this module records, and the argument for it.
 *
 * NOT `CRAWL`. A crawl is an OBSERVATION — something answered — and reading
 * `_buildManifest.js` observes that the manifest answered, not that
 * `/orders/:id` did. Recording these as CRAWL would put a route nothing has
 * ever requested into the observed half of `originFromSources`, where it reads
 * as BOTH, and the product's headline sentence ("declared in source, never
 * reached") would be computed over items that had been reached by nothing.
 *
 * NOT `SOURCE` either: a source detector reads the repository, and we have not
 * got the repository here. {@link SurfaceSource} `CATALOGUE` is defined as
 * exactly this case — "machine read, like SOURCE, but out of a system rather
 * than out of the repo" — and the running application is the system. It lands
 * on the declared side of `originFromSources`, which is the correct answer: a
 * route the build declares and no crawl has reached is SOURCE_ONLY, and that is
 * the set no runtime-only competitor can see at all.
 */
export const ROUTE_MANIFEST_SOURCE: SurfaceSource = 'CATALOGUE';

export interface RouteManifestItemOptions {
  /**
   * The environment these templates were read from. REQUIRED, with no default.
   *
   * A build manifest is read from one deployment, so unlike a repository
   * declaration it is NOT environment-independent — a staging-only route that
   * entered a production project's denominator would be reported as an
   * uncovered production gap. Leaving the field absent would mean "this item
   * predates the capture", which is false, and defaulting it to null would
   * claim environment-independence we have not got. So the caller states it,
   * and `null` is a thing they may state rather than a thing we assume.
   */
  environmentId: string | null;
  /**
   * Include INFERRED templates. FALSE by default.
   *
   * A guess belongs in the inventory only where a reader can see it is a
   * guess. Most callers want the defensible denominator, and the ones that want
   * our full reach can ask — but they have to ask, because an inferred route
   * in a gap list is a page the customer will go looking for and not find.
   */
  includeInferred?: boolean;
}

/**
 * Turns the manifest into {@link SurfaceItem} rows for the existing registry.
 *
 * There is no second registry and no `SurfaceItem` model: `CoverageItem` IS
 * the surface registry, these are ROUTE items on it, and identity goes through
 * `canonicalRoute` exactly as the source and crawl sides do — which is the
 * only reason `/orders/[id]` from a build manifest and `/orders/123` from a
 * crawl are recognised as one route rather than two.
 *
 * `exercise` is deliberately ABSENT rather than null or EXERCISABLE. This
 * module reads a route table; it has no opinion on whether a test may drive
 * `/account/delete` in this environment, and "nobody classified it" is the one
 * true thing to record. `exercisabilityCounts` counts that case, so these items
 * stay in the denominator, which is correct — a declared route is a surface
 * until somebody says otherwise.
 */
export function routeManifestSurfaceItems(
  manifest: RouteManifest,
  options: RouteManifestItemOptions,
): SurfaceItem[] {
  const origin = originFromSources([ROUTE_MANIFEST_SOURCE]);
  /*
   * KEYED BY THE REGISTRY KEY, not pushed, and the difference is a duplicate
   * primary key.
   *
   * `accept` de-duplicates on the NAMED template and this function keys on the
   * CANONICAL one, because that is the only identity under which a build
   * manifest's `/orders/[id]` and a crawl's `/orders/123` are recognised as one
   * route. But `canonicalRoute` folds every parameter name to `:param` and
   * lower-cases the rest, so `/orders/:orderId` from a routes manifest and
   * `/orders/:id` guessed from a source map are TWO templates and ONE key —
   * and this emitted an item for each. Two rows with one key is not a bigger
   * measurement of the application: on the way into `CoverageItem` one
   * overwrites the other, whichever the upsert reaches last wins, and in the
   * ordering above that is the GUESS overwriting the declaration. So the
   * strongest grade wins here, where the reason can be written down.
   */
  const byKey = new Map<string, { item: SurfaceItem; grade: RouteTemplateGrade }>();
  /** The spellings a key collapsed, so the collapse is reported and not hidden. */
  const alsoSpelled = new Map<string, string[]>();
  for (const found of templatesOf(manifest)) {
    if (!isGroundTruth(found.grade) && options.includeInferred !== true) continue;
    const identity = canonicalRoute(found.template);
    const key = surfaceKey('ROUTE', identity);
    const item: SurfaceItem = {
      kind: 'ROUTE',
      key,
      label: found.template,
      file: found.file,
      line: null,
      /*
       * Derived, never set by hand. An item whose `origin` and `sources`
       * disagree shows one of them on screen and the other in the API, and
       * the reader has no way to tell which.
       */
      origin: origin ?? 'SOURCE_ONLY',
      evidence: evidenceFor(found, manifest.baseUrl),
      detector: `route-manifest:${found.extractor}`,
      sources: [ROUTE_MANIFEST_SOURCE],
      environmentId: options.environmentId,
      meta: {
        template: found.template,
        declaredAs: found.declaredAs,
        grade: found.grade,
        extractor: found.extractor,
        document: found.document,
        params: found.params,
        catchAll: found.catchAll,
        routeName: found.name,
        redirectsTo: found.redirectsTo,
      },
    };

    const incumbent = byKey.get(key);
    if (incumbent === undefined) {
      byKey.set(key, { item, grade: found.grade });
      continue;
    }
    const beats =
      ROUTE_TEMPLATE_GRADES.indexOf(found.grade) <
      ROUTE_TEMPLATE_GRADES.indexOf(incumbent.grade);
    const losing = beats ? incumbent.item.label : found.template;
    const list = alsoSpelled.get(key) ?? [];
    if (!list.includes(losing)) list.push(losing);
    alsoSpelled.set(key, list);
    if (beats) byKey.set(key, { item, grade: found.grade });
  }

  const items: SurfaceItem[] = [];
  for (const [key, held] of byKey) {
    const others = alsoSpelled.get(key);
    if (others === undefined || others.length === 0) {
      items.push(held.item);
      continue;
    }
    /*
     * Two of our own readers named one route differently. That is a fact about
     * OUR extractors, not about the customer's application, and this module
     * reports that kind rather than dropping it — the same argument
     * `skipped` and `unexpanded` make.
     */
    items.push({ ...held.item, meta: { ...held.item.meta, alsoSpelled: others } });
  }
  return items;
}

/**
 * The sentence that justifies the item, in the customer's terms.
 *
 * An INFERRED template says so IN THE SENTENCE, not only in a field a renderer
 * might not show. The evidence string is the thing that survives into a CSV
 * export and a support ticket, and "we guessed this from a file name" has to
 * survive with it.
 */
function evidenceFor(found: DeclaredRoute, baseUrl: string): string {
  const where = ROUTE_EXTRACTOR_LABELS[found.extractor];
  const shown = found.declaredAs.length > 0 ? found.declaredAs : found.template;
  switch (found.grade) {
    case 'DECLARED':
      return `${where} at ${baseUrl} declares the route template ${shown} — the application's own route table`;
    case 'DERIVED':
      return `${where} at ${baseUrl} lists ${shown}; ${found.template} is computed from it by the router's segment rules`;
    case 'INFERRED':
      return `${where} at ${baseUrl} names the file ${shown}; ${found.template} is INFERRED from that file name and the application may not route to it`;
  }
}
