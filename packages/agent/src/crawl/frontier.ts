/**
 * The crawl frontier (§3.1) — what to visit next, what counts as the same place
 * twice, and what it costs when a budget runs out.
 *
 * ── Why this module exists, in one paragraph ────────────────────────────────
 *
 * QAAI's product is a denominator: "your app has 412 routes, 25 are covered,
 * here are the 387". The frontier IS the denominator's production line, and
 * every defect in it moves the coverage percentage without moving the quality
 * of the tests. `crawler.ts` today holds its queue in a local array, decides
 * route identity with three regexes applied to one path at a time, caps at 60
 * pages, and discards the leftover queue with one sentence on
 * `truncatedReason`. Each of those is a lever that silently flatters us:
 *
 *   · `normaliseRoute('/oauth2/authorize')` → `/:id/authorize`, because
 *     "oauth2" has digits and letters and is longer than three characters. Two
 *     unrelated routes merge, so the denominator SHRINKS.
 *   · `normaliseRoute('/404')` → `/:id`. The error page becomes a route
 *     template, and every 404 the crawl hits joins it.
 *   · `/products/blue-widget` and `/products/red-widget` stay distinct, so a
 *     catalogue of 10,000 items is 10,000 routes: the denominator EXPLODES
 *     while the page budget is spent inside one template.
 *   · `?page=1..400` mints 400 identities for one list.
 *   · the 60-page cap stops the crawl and the 240 URLs still in the queue are
 *     freed with the process, so "at least 240 more existed" is a sentence the
 *     current design cannot say even in principle.
 *
 * So this module's job is not "a queue". It is: one canonical identity per
 * place, one route template per family of places with the evidence attached,
 * one validated budget whose every bite is counted, and a persistable value
 * that can still say what it did not reach after the crawl is over.
 *
 * ── The rule every decision here follows ────────────────────────────────────
 *
 * A URL that was REFUSED, a URL that was NOT REACHED, a URL that is SOMEBODY
 * ELSE'S, and a URL that DOES NOT EXIST are four different facts. crawler.ts
 * records all four identically, which is to say not at all. Every rejection
 * path below therefore ends in a ledger entry, a named count and a reason —
 * never in a bare `continue`.
 *
 * ── No browser, by construction ─────────────────────────────────────────────
 *
 * Nothing here imports playwright or touches a page: the scheduler takes its
 * browser surface as an injected `CrawlVisitor`. That is deliberate. 629 lines
 * of crawler.ts have almost no tests precisely because its traversal and its
 * browser driving are the same function, and a traversal that cannot be tested
 * without a browser is a traversal nobody tests.
 */

import {
  CRAWL_CAP_LABELS,
  EXCLUSION_KIND_LABELS,
  externalParts,
  isOwnOrigin,
  lowerBoundMoreUrls,
  policyDecision,
  resolveCrawlPolicy,
  type AppliedCrawlPolicy,
  type CapBite,
  type CrawlCap,
  type CrawlPolicy,
  type ExcludedPath,
  type ExclusionKind,
  type ExternalBoundary,
  type ExternalKind,
  type Frontier,
  type Plan,
} from '@qaai/shared';

// ─── 1a. Canonical identity: one URL per place ──────────────────────────────

/**
 * How a URL came to be known. Carried on every queue entry, because a resumed
 * crawl, a sitemap import and a link found on page 3 are different evidence,
 * and a report that cannot tell them apart cannot say where its surface came
 * from.
 */
export const DISCOVERY_SOURCES = [
  /** The crawl's starting URL, or one added by hand. */
  'SEED',
  /** An `a[href]`. */
  'LINK',
  /** A button, tab, accordion or other control that navigated. */
  'AFFORDANCE',
  /** A `form[action]`. */
  'FORM_ACTION',
  /** A redirect's destination. */
  'REDIRECT',
  /** robots.txt / sitemap.xml. */
  'SITEMAP',
  /** A route table read out of the repository. */
  'ROUTE_TABLE',
  /** Restored from a persisted frontier. */
  'RESUME',
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

/**
 * The compiler-enforced presence record, copying the keystone pattern in
 * `packages/shared/src/types.ts`.
 *
 * THE DEFECT THIS PREVENTS: eight `GateRule` kinds existed in the union, could
 * not be saved by any customer for two slices, and nothing could see it,
 * because a union with a write path and no presence record drifts in silence.
 * `DiscoverySource` has a write path — it is serialised into the persisted
 * frontier — so it gets the same treatment, and frontier.test.ts checks this
 * record's keys against the array at run time, which the compiler cannot.
 */
export const DISCOVERY_SOURCE_PRESENT: Record<DiscoverySource, true> = {
  SEED: true,
  LINK: true,
  AFFORDANCE: true,
  FORM_ACTION: true,
  REDIRECT: true,
  SITEMAP: true,
  ROUTE_TABLE: true,
  RESUME: true,
};

/**
 * What to do with `#...`.
 *
 * THE DEFECT: crawler.ts sets `target.hash = ''` unconditionally, so a
 * hash-routed single-page application enumerates as exactly ONE node —
 * `/#/orders`, `/#/orders/1001` and `/#/settings` are all `/`. A whole class of
 * application reports a denominator of 1 and a coverage percentage of 100%.
 *
 * AUTO is the default and the rule is mechanical rather than clever: a fragment
 * that starts with `/` is a route (`#/orders/1001`), anything else is an
 * in-page anchor (`#pricing`) which is NOT a separate state and must keep
 * collapsing — or one page with twelve jump links becomes thirteen nodes and
 * the denominator inflates in the other direction.
 */
export const HASH_ROUTING_MODES = ['AUTO', 'ROUTE', 'IGNORE'] as const;
export type HashRoutingMode = (typeof HASH_ROUTING_MODES)[number];

/**
 * Query parameters whose value is a position in a list rather than a different
 * place.
 *
 * `?page=2` has the same route, the same forms and the same assertions as
 * `?page=1`; what differs is the rows. Three hundred pages of a list are one
 * thing to test, and treating them as 300 states is how a page budget gets
 * spent entirely inside a single template.
 */
export const PAGINATION_PARAMS = [
  'page',
  'p',
  'pagenum',
  'page_num',
  'pagenumber',
  'page_number',
  'offset',
  'start',
  'skip',
  'limit',
  'per_page',
  'perpage',
  'pagesize',
  'page_size',
] as const;

/**
 * Parameters whose value is an opaque handle — a cursor, a continuation token,
 * a cache-busting stamp.
 *
 * Bucketed to a single token rather than kept, because the values are unique
 * per request: keeping them mints a new identity for every page view, and a
 * crawl of a cursor-paginated list never terminates.
 */
export const OPAQUE_QUERY_PARAMS = [
  'cursor',
  'after',
  'before',
  'continuation',
  'continuationtoken',
  'page_token',
  'pagetoken',
  'scroll_id',
  '_',
] as const;

/** The pagination bucket token. It appears in the canonical URL, so it is visible. */
export const PAGE_BUCKET_TOKEN = ':n';
/** The opaque-handle bucket token. */
export const CURSOR_BUCKET_TOKEN = ':cursor';

/**
 * Every transformation canonicalisation can apply, named so a report can show
 * what was folded into what.
 *
 * A canonicalisation nobody can see is indistinguishable from a bug: when a
 * customer asks why `/products?sort=price&utm_source=x` is missing from their
 * inventory, the answer has to be the list of steps that merged it.
 */
export const CANONICAL_STEPS = [
  'LOWERCASED_HOST',
  'DROPPED_DEFAULT_PORT',
  'DROPPED_TRAILING_SLASH',
  'DROPPED_INDEX_FILE',
  'STRIPPED_IGNORED_PARAMS',
  'SORTED_QUERY',
  'BUCKETED_PAGINATION',
  'BUCKETED_OPAQUE_PARAM',
  'DROPPED_FRAGMENT',
  'KEPT_HASH_ROUTE',
] as const;
export type CanonicalStep = (typeof CANONICAL_STEPS)[number];

export interface CanonicalUrl {
  /** The identity. Two URLs with the same `url` are the same place. */
  url: string;
  origin: string;
  /** Pathname, with no trailing slash (except root) and no query. */
  pathname: string;
  /**
   * The path that template inference runs over: `pathname`, plus the hash
   * route's segments behind a literal `#` segment when one was kept.
   *
   * The `#` marker stays in deliberately. `/#/orders/1` and `/orders/1` are
   * different URLs that can both exist in one application, and dropping the
   * marker would MERGE them — a merge shrinks the denominator, which is the
   * direction this product is not allowed to be wrong in.
   */
  routePath: string;
  /** Canonical query string without the leading `?`. Empty when there is none. */
  query: string;
  /** The hash route, when `hashRouting` kept one. Null for an in-page anchor. */
  hashRoute: string | null;
  applied: CanonicalStep[];
  /** Parameters dropped, with the values seen, so the fold is auditable. */
  dropped: Array<{ name: string; value: string }>;
}

export type CanonicaliseResult =
  { ok: true; canonical: CanonicalUrl } | { ok: false; kind: ExclusionKind; rule: string };

export interface CanonicaliseOptions {
  policy: CrawlPolicy;
  hashRouting?: HashRoutingMode;
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };
const INDEX_FILES = new Set(['index.html', 'index.htm', 'index.php', 'default.html']);

function isPaginationParam(name: string): boolean {
  return (PAGINATION_PARAMS as readonly string[]).includes(name.toLowerCase());
}

function isOpaqueParam(name: string): boolean {
  return (OPAQUE_QUERY_PARAMS as readonly string[]).includes(name.toLowerCase());
}

/**
 * Turns a raw href into the identity of the place it points at.
 *
 * Returns the REASON on failure rather than null, because every caller is about
 * to write a ledger entry and "could not canonicalise" is not a reason a
 * customer can act on. `UNSUPPORTED_SCHEME` covers `mailto:`, `tel:`,
 * `javascript:` and a string that is not a URL at all — all four are "not a
 * page", and all four are a bare `continue` in crawler.ts today.
 */
export function canonicaliseUrl(raw: string, options: CanonicaliseOptions): CanonicaliseResult {
  const hashRouting = options.hashRouting ?? 'AUTO';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      kind: 'UNSUPPORTED_SCHEME',
      rule: `not an absolute URL: ${raw.slice(0, 80)}`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      kind: 'UNSUPPORTED_SCHEME',
      rule: `scheme ${parsed.protocol} is not a page`,
    };
  }

  const applied: CanonicalStep[] = [];
  const dropped: Array<{ name: string; value: string }> = [];

  // Host case is not significant; path case IS — `/Orders` and `/orders` are
  // two routes on any case-sensitive server, and merging them hides one.
  if (parsed.host !== parsed.host.toLowerCase()) {
    parsed.host = parsed.host.toLowerCase();
    applied.push('LOWERCASED_HOST');
  }
  if (parsed.port !== '' && DEFAULT_PORTS[parsed.protocol] === parsed.port) {
    parsed.port = '';
    applied.push('DROPPED_DEFAULT_PORT');
  }

  let pathname = parsed.pathname === '' ? '/' : parsed.pathname;
  const lastSegment = pathname.split('/').pop() ?? '';
  if (INDEX_FILES.has(lastSegment.toLowerCase())) {
    pathname = pathname.slice(0, pathname.length - lastSegment.length);
    applied.push('DROPPED_INDEX_FILE');
  }
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.replace(/\/+$/, '');
    if (pathname === '') pathname = '/';
    applied.push('DROPPED_TRAILING_SLASH');
  }

  // ── The query ──
  const ignored = new Set(options.policy.ignoredQueryParams.map((name) => name.toLowerCase()));
  const kept: Array<[string, string]> = [];
  let strippedAny = false;
  let bucketedPagination = false;
  let bucketedOpaque = false;

  for (const [name, value] of parsed.searchParams.entries()) {
    if (ignored.has(name.toLowerCase())) {
      dropped.push({ name, value });
      strippedAny = true;
      continue;
    }
    if (isOpaqueParam(name)) {
      kept.push([name, CURSOR_BUCKET_TOKEN]);
      bucketedOpaque = true;
      continue;
    }
    if (isPaginationParam(name)) {
      /*
       * The FIRST page keeps its own identity and the tail collapses into one.
       *
       * Not "collapse all of it": page 1 is the list's default state, it is the
       * one a user lands on, and it is frequently the only one with an empty
       * state worth testing. Pages 2..N differ from each other only in which
       * rows they hold, which is data, not surface. So `?page=1` stays and
       * `?page=2`, `?page=397`, `?page=400` all become `?page=:n` — two
       * identities for a 400-page list instead of 400.
       */
      const first = value === '1' || value === '0' || value === '';
      kept.push([name, first ? value : PAGE_BUCKET_TOKEN]);
      if (!first) bucketedPagination = true;
      continue;
    }
    kept.push([name, value]);
  }

  if (strippedAny) applied.push('STRIPPED_IGNORED_PARAMS');
  if (bucketedPagination) applied.push('BUCKETED_PAGINATION');
  if (bucketedOpaque) applied.push('BUCKETED_OPAQUE_PARAM');

  /*
   * Sorted by name then value, so `?b=2&a=1` and `?a=1&b=2` are one place.
   * Multi-valued parameters keep EVERY value: `?tag=a&tag=b` is a different
   * filter from `?tag=a`, and deduplicating them would merge two states.
   */
  const sorted = [...kept].sort(
    (left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]),
  );
  if (sorted.some((pair, index) => pair !== kept[index])) applied.push('SORTED_QUERY');

  const query = sorted
    .map(([name, value]) =>
      value === ''
        ? encodeURIComponent(name)
        : `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join('&');

  // ── The fragment ──
  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  let hashRoute: string | null = null;
  if (fragment !== '') {
    const looksLikeRoute = fragment.startsWith('/');
    if (hashRouting === 'ROUTE' || (hashRouting === 'AUTO' && looksLikeRoute)) {
      hashRoute = fragment.startsWith('/') ? fragment : `/${fragment}`;
      if (hashRoute.length > 1 && hashRoute.endsWith('/')) {
        hashRoute = hashRoute.replace(/\/+$/, '');
      }
      applied.push('KEPT_HASH_ROUTE');
    } else {
      applied.push('DROPPED_FRAGMENT');
    }
  }

  const url =
    `${parsed.origin}${pathname}` +
    (query === '' ? '' : `?${query}`) +
    (hashRoute === null ? '' : `#${hashRoute}`);
  const routePath =
    hashRoute === null ? pathname : `${pathname === '/' ? '' : pathname}/#${hashRoute}`;

  return {
    ok: true,
    canonical: {
      url,
      origin: parsed.origin,
      pathname,
      routePath,
      query,
      hashRoute,
      applied,
      dropped,
    },
  };
}

// ─── 1b. Route-template inference from the SET of observed paths ────────────

/**
 * Segments that are never a parameter, whatever their shape.
 *
 * THE DEFECT THIS LIST FIXES, precisely: `normaliseRoute` turns `/oauth2/...`
 * into `/:id/...` because "oauth2" contains a digit, contains a letter and is
 * longer than three characters; and `/404` into `/:id` because it is all
 * digits. Both merge routes with nothing to do with each other, and a merge is
 * the flattering direction — fewer routes in the denominator.
 *
 * `new`, `edit` and `create` are the entries worth defending. Rails-shaped apps
 * serve `/orders/new` (a form) and `/orders/1001` (a record) side by side, and
 * collapsing them loses the only page of the pair that has a form on it.
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  // The hash-route marker this module inserts; never a parameter.
  '#',
  // Infrastructure and protocol
  'api',
  'apis',
  'graphql',
  'rest',
  'rpc',
  'oauth',
  'oauth2',
  'oidc',
  'saml',
  'auth',
  'authorize',
  'authorization',
  'callback',
  'token',
  'refresh',
  'well-known',
  '.well-known',
  'static',
  'assets',
  'public',
  'media',
  'uploads',
  '_next',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  // Session
  'login',
  'signin',
  'sign-in',
  'logout',
  'signout',
  'sign-out',
  'signup',
  'sign-up',
  'register',
  'verify',
  'reset',
  'password',
  'mfa',
  'totp',
  // CRUD action names — the `/orders/new` case
  'new',
  'edit',
  'create',
  'update',
  'delete',
  'destroy',
  'me',
  'self',
  // Operational
  'health',
  'healthz',
  'readyz',
  'livez',
  'metrics',
  'status',
  'version',
  'ping',
  // Status-code pages — the `/404` case
  '400',
  '401',
  '402',
  '403',
  '404',
  '405',
  '408',
  '409',
  '410',
  '418',
  '422',
  '429',
  '500',
  '501',
  '502',
  '503',
  '504',
  // Section names that are routes, not records
  'index',
  'home',
  'dashboard',
  'settings',
  'account',
  'profile',
  'billing',
  'admin',
  'search',
  'about',
  'contact',
  'help',
  'support',
  'docs',
  'terms',
  'privacy',
  'pricing',
  'blog',
  'news',
  'faq',
  'cart',
  'checkout',
]);

/** `v1`, `v2`, `v10`: an API version is never a record id. */
const RESERVED_PATTERNS = [/^v\d{1,3}$/i];

export function isReservedSegment(segment: string): boolean {
  return (
    RESERVED_SEGMENTS.has(segment.toLowerCase()) ||
    RESERVED_PATTERNS.some((pattern) => pattern.test(segment))
  );
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 16+ hex characters: a Mongo ObjectId, a commit sha, a content hash. */
const LONG_HEX_SHAPE = /^[0-9a-f]{16,}$/i;
/**
 * `ORD-1001`, `cus_a1b2`, `inv_000123`: a short prefix, a separator, and a
 * suffix that CONTAINS A DIGIT.
 *
 * The digit requirement is the whole point. Without it this pattern matches
 * `sign-out`, `blue-widget` and `well-known`, which would then collapse on
 * shape alone with no sibling evidence at all — exactly the class of mistake
 * `normaliseRoute` makes today.
 */
const PREFIXED_ID_SHAPE = /^[A-Za-z]{1,8}[-_][A-Za-z0-9]*\d[A-Za-z0-9]*$/;
/** A long opaque token: base64url-ish, 22+ characters. */
const OPAQUE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,}$/;

const BARE_NUMBER_SHAPE = /^\d+$/;
const SHORT_HEX_SHAPE = /^[0-9a-f]{8,15}$/i;
const MIXED_ALNUM_SHAPE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9]{4,}$/;
const SLUG_SHAPE = /^[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)*$/;

/**
 * Shapes no human gives a route. ONE instance is enough to call it a parameter.
 *
 * The line between this and `isIdShapedSegment` is the single most important
 * judgement in template inference, so it is drawn narrowly: a UUID, 16+ hex
 * characters, a prefixed id with a digit in it, or a 22-character opaque token.
 * Nobody names a route `550e8400-e29b-41d4-a716-446655440000`.
 *
 * A BARE NUMBER is deliberately NOT here. `/404`, `/500`, `/blog/2024` and
 * `/page/2` are bare numbers that are routes, and `/404` → `/:id` is one of the
 * two defects this file exists to fix.
 */
export function isUnambiguousIdSegment(segment: string): boolean {
  if (isReservedSegment(segment)) return false;
  return (
    UUID_SHAPE.test(segment) ||
    LONG_HEX_SHAPE.test(segment) ||
    PREFIXED_ID_SHAPE.test(segment) ||
    OPAQUE_TOKEN_SHAPE.test(segment)
  );
}

/**
 * Shapes that LOOK like an id but need corroboration — at least two distinct
 * siblings in the same position of the same family.
 *
 * This is the old `normaliseRoute` heuristic, kept because it is a good signal
 * and made safe by requiring siblings. `/404` on its own has no sibling, so it
 * stays `/404`; `/orders/1001` beside `/orders/1002` has one, so they become
 * `/orders/:id`.
 */
export function isIdShapedSegment(segment: string): boolean {
  if (isReservedSegment(segment)) return false;
  if (isUnambiguousIdSegment(segment)) return true;
  return (
    BARE_NUMBER_SHAPE.test(segment) ||
    SHORT_HEX_SHAPE.test(segment) ||
    MIXED_ALNUM_SHAPE.test(segment)
  );
}

/** Why a position became a parameter. Carried into the report as the evidence. */
export const TEMPLATE_EVIDENCE_KINDS = [
  /** A shape no route ever has. One instance is enough. */
  'UNAMBIGUOUS_ID_SHAPE',
  /** An id-looking shape with at least two distinct siblings. */
  'ID_SHAPE_SIBLINGS',
  /** Enough distinct values in one position that it cannot be a route name. */
  'SIBLING_CARDINALITY',
] as const;
export type TemplateEvidenceKind = (typeof TEMPLATE_EVIDENCE_KINDS)[number];

export const TEMPLATE_EVIDENCE_PRESENT: Record<TemplateEvidenceKind, true> = {
  UNAMBIGUOUS_ID_SHAPE: true,
  ID_SHAPE_SIBLINGS: true,
  SIBLING_CARDINALITY: true,
};

export interface TemplateParameter {
  /** Zero-based segment index. */
  position: number;
  /** The token as rendered: `:id`, `:slug`, `:param`, plus an ordinal if repeated. */
  name: string;
  evidence: TemplateEvidenceKind;
  /** Distinct values observed in this position of this family. */
  distinctValues: number;
  /** Up to five of them, so the inference can be checked by eye. */
  sample: string[];
}

export interface RouteTemplate {
  /** `/orders/:id/items/:id2`. */
  template: string;
  parameters: TemplateParameter[];
  /** How many distinct observed paths collapsed into it. */
  instances: number;
  sample: string[];
}

/**
 * A sibling family that was NOT collapsed, and why.
 *
 * This is the disclosure half of template inference and it is as load-bearing
 * as the templates. `/settings/profile` and `/settings/billing` are two routes;
 * `/products/blue-widget` and `/products/red-widget` are probably one template
 * with two instances — and with two values observed there is nothing that tells
 * them apart. Reporting the undecided families lets a reader see where the
 * route count might be N instead of 1, rather than trusting a threshold nobody
 * told them about.
 */
export interface UnresolvedFamily {
  /** The family with the undecided position shown as `*`. */
  pattern: string;
  position: number;
  distinctValues: number;
  sample: string[];
  why: string;
}

export interface TemplateInference {
  templates: RouteTemplate[];
  unresolved: UnresolvedFamily[];
  /** Distinct paths that went in — the route count before collapsing. */
  observedPaths: number;
  /** The threshold applied, so the numbers above can be reproduced. */
  cardinalityThreshold: number;
}

/**
 * How many distinct values in one position before it is a parameter rather than
 * a set of route names.
 *
 * Five, and it is a judgement that is sometimes wrong in both directions —
 * which is why `TemplateInference.unresolved` exists. Lower, and
 * `/settings/{profile,billing,team}` becomes `/settings/:slug`, losing three
 * real routes from the denominator. Higher, and a catalogue of eight products
 * stays eight routes.
 */
export const DEFAULT_TEMPLATE_CARDINALITY_THRESHOLD = 5;

const HOLE = '\u0000';
const ID_MASK = '\u0001';

function segmentsOf(routePath: string): string[] {
  return routePath.split('/').filter((segment) => segment !== '');
}

/**
 * The key that makes two paths siblings.
 *
 * EVERY id-shaped segment is masked, not just the one under consideration. That
 * detail is what lets a template with two parameters be found at all:
 * `/orders/1001/items/5` and `/orders/1002/items/7` differ in two positions, so
 * with literal keys they are never siblings and neither position ever collects
 * a second value. With the mask they are both `orders/<id>/items/<hole>` and the
 * evidence appears.
 */
function familyKey(segments: readonly string[], holeAt: number): string {
  return segments
    .map((segment, index) =>
      index === holeAt ? HOLE : isIdShapedSegment(segment) ? ID_MASK : segment,
    )
    .join('/');
}

interface PositionDecision {
  evidence: TemplateEvidenceKind;
  token: string;
  distinctValues: number;
  sample: string[];
}

/**
 * The template index: ONE implementation, used both incrementally (the
 * per-template budget has to decide at enqueue time) and in batch (the report
 * needs an order-independent answer).
 *
 * `matchesGlob` in @qaai/shared carries the same note for the same reason: when
 * the panel's preview and the crawler's decision are two implementations of one
 * rule they disagree, and the disagreement stays invisible until a customer
 * asks why a page was skipped.
 */
export class RouteTemplateIndex {
  private readonly threshold: number;
  /** familyKey → (value → occurrences). */
  private readonly families = new Map<string, Map<string, number>>();
  private readonly paths = new Set<string>();

  constructor(options?: { cardinalityThreshold?: number }) {
    const requested = options?.cardinalityThreshold;
    this.threshold =
      requested !== undefined && Number.isInteger(requested) && requested >= 2
        ? requested
        : DEFAULT_TEMPLATE_CARDINALITY_THRESHOLD;
  }

  get cardinalityThreshold(): number {
    return this.threshold;
  }

  get observedPaths(): number {
    return this.paths.size;
  }

  observedPathList(): string[] {
    return [...this.paths].sort();
  }

  /** Records one observed path. Idempotent: the same path twice is one instance. */
  observe(routePath: string): void {
    if (this.paths.has(routePath)) return;
    this.paths.add(routePath);
    const segments = segmentsOf(routePath);
    for (let index = 0; index < segments.length; index += 1) {
      const value = segments[index];
      if (value === undefined) continue;
      const key = familyKey(segments, index);
      const values = this.families.get(key) ?? new Map<string, number>();
      values.set(value, (values.get(value) ?? 0) + 1);
      this.families.set(key, values);
    }
  }

  private decide(segments: readonly string[], index: number): PositionDecision | null {
    const value = segments[index];
    if (value === undefined) return null;
    // A reserved segment is a route name. It is never a parameter, and it never
    // joins a template its siblings formed — `/orders/new` keeps its own row.
    if (isReservedSegment(value)) return null;

    const values = this.families.get(familyKey(segments, index));
    // Candidates exclude reserved siblings, so `/orders/new` cannot push
    // `/orders/:id` over the cardinality threshold with a value that is a route.
    // SORTED, because a Map iterates in insertion order and the samples below
    // travel into the stored flow map: an evidence list that depends on crawl
    // order makes the version-to-version diff show churn that is not there.
    const candidates =
      values === undefined
        ? []
        : [...values.keys()].filter((entry) => !isReservedSegment(entry)).sort();
    if (candidates.length === 0) return null;

    if (isUnambiguousIdSegment(value)) {
      return {
        evidence: 'UNAMBIGUOUS_ID_SHAPE',
        token: ':id',
        distinctValues: candidates.length,
        sample: candidates.slice(0, 5),
      };
    }

    const idShaped = candidates.filter((candidate) => isIdShapedSegment(candidate));
    if (isIdShapedSegment(value) && idShaped.length >= 2) {
      return {
        evidence: 'ID_SHAPE_SIBLINGS',
        token: ':id',
        distinctValues: idShaped.length,
        sample: idShaped.slice(0, 5),
      };
    }

    if (candidates.length >= this.threshold) {
      const allSlugs = candidates.every((candidate) => SLUG_SHAPE.test(candidate));
      return {
        evidence: 'SIBLING_CARDINALITY',
        token: allSlugs ? ':slug' : ':param',
        distinctValues: candidates.length,
        sample: candidates.slice(0, 5),
      };
    }

    return null;
  }

  /**
   * The template this path belongs to, with the evidence for each parameter.
   *
   * Safe to call for a path that was never observed: it returns the path itself,
   * which is the honest answer. With no siblings there is no evidence, and
   * inventing a template from one path's shape is the defect.
   */
  templateFor(routePath: string): { template: string; parameters: TemplateParameter[] } {
    const segments = segmentsOf(routePath);
    const parameters: TemplateParameter[] = [];
    const usedNames = new Map<string, number>();

    const rendered = segments.map((segment, index) => {
      const decision = this.decide(segments, index);
      if (decision === null) return segment;
      const seen = (usedNames.get(decision.token) ?? 0) + 1;
      usedNames.set(decision.token, seen);
      // `/orders/:id/items/:id` is ambiguous to read and to diff, so a repeated
      // token gets an ordinal: `:id`, `:id2`, `:id3`.
      const name = seen === 1 ? decision.token : `${decision.token}${seen}`;
      parameters.push({
        position: index,
        name,
        evidence: decision.evidence,
        distinctValues: decision.distinctValues,
        sample: decision.sample,
      });
      return name;
    });

    return { template: rendered.length === 0 ? '/' : `/${rendered.join('/')}`, parameters };
  }

  /**
   * The key the PER-TEMPLATE BUDGET counts against — deliberately coarser than
   * the route template, and the difference is the point.
   *
   * A denominator must be EXACT: `/404` is a route and `/blog/2024` may be one,
   * so `templateFor` refuses to parameterise either without sibling evidence. A
   * budget must be CONSERVATIVE: it has to refuse the ten-thousandth order
   * before the ten-thousandth order is queued, and waiting for evidence means
   * the first instance of every template is charged to its own literal path and
   * the budget leaks by one per template.
   *
   * So this masks any id-shaped segment on shape alone. `/orders/1001` has the
   * budget key `/orders/:id` from the very first instance, which is what makes
   * the cap exact for the case that matters — numeric, uuid and prefixed ids.
   *
   * THE RESIDUAL LEAK, stated rather than hidden: a SLUG template
   * (`/products/:slug`) is only recognised at the cardinality threshold, so up
   * to `cardinalityThreshold - 1` of its instances are charged to their own
   * literal keys and the template can admit that many pages over its budget. It
   * is bounded by four at the default threshold, it is in the flattering
   * direction for cost and the honest direction for coverage (more pages
   * enumerated, not fewer), and it is why `CapBite.scope` prints this key.
   */
  budgetKeyFor(routePath: string): string {
    const segments = segmentsOf(routePath);
    const rendered = segments.map((segment, index) => {
      const decision = this.decide(segments, index);
      if (decision !== null) return decision.token;
      return isIdShapedSegment(segment) ? ':id' : segment;
    });
    return rendered.length === 0 ? '/' : `/${rendered.join('/')}`;
  }

  /** Every template the observed set implies, highest instance count first. */
  templates(): RouteTemplate[] {
    const grouped = new Map<string, { parameters: TemplateParameter[]; paths: string[] }>();
    for (const path of this.observedPathList()) {
      const { template, parameters } = this.templateFor(path);
      const group = grouped.get(template) ?? { parameters, paths: [] };
      group.paths.push(path);
      if (group.parameters.length === parameters.length) {
        // Keep the widest evidence seen for each position.
        group.parameters = group.parameters.map((existing, index) => {
          const incoming = parameters[index];
          if (incoming === undefined) return existing;
          return incoming.distinctValues > existing.distinctValues ? incoming : existing;
        });
      }
      grouped.set(template, group);
    }
    return [...grouped.entries()]
      .map(([template, group]) => ({
        template,
        parameters: group.parameters,
        instances: group.paths.length,
        sample: group.paths.slice(0, 5),
      }))
      .sort(
        (left, right) =>
          right.instances - left.instances || left.template.localeCompare(right.template),
      );
  }

  /** Families with real variation that met no rule. See `UnresolvedFamily`. */
  unresolved(): UnresolvedFamily[] {
    const out: UnresolvedFamily[] = [];
    for (const [key, values] of this.families.entries()) {
      const candidates = [...values.keys()].filter((value) => !isReservedSegment(value));
      if (candidates.length < 2) continue;
      const masked = key.split('/');
      const position = masked.indexOf(HOLE);
      if (position < 0) continue;
      const firstCandidate = candidates[0];
      if (firstCandidate === undefined) continue;
      /*
       * Probe the family with one of its own values. If `decide` resolves it,
       * the family IS collapsed and reporting it would be noise. The ID_MASK
       * placeholders become a bare number so `familyKey` masks them back to the
       * same key — the probe has to reconstruct the key it came from, or it
       * would be asking about a family that does not exist.
       */
      const probe = masked.map((segment, index) =>
        index === position ? firstCandidate : segment === ID_MASK ? '1' : segment,
      );
      if (this.decide(probe, position) !== null) continue;
      out.push({
        pattern: `/${masked
          .map((segment) => (segment === HOLE ? '*' : segment === ID_MASK ? ':id' : segment))
          .join('/')}`,
        position,
        distinctValues: candidates.length,
        sample: [...candidates].sort().slice(0, 5),
        why:
          `${candidates.length} distinct value(s) in this position, below the ` +
          `${this.threshold}-value threshold and not an id shape — these may be one template ` +
          `or ${candidates.length} routes, and nothing observed says which`,
      });
    }
    return out.sort(
      (left, right) =>
        right.distinctValues - left.distinctValues || left.pattern.localeCompare(right.pattern),
    );
  }

  /** The observed path set, for a frontier snapshot. */
  snapshot(): { cardinalityThreshold: number; observedPaths: string[] } {
    return { cardinalityThreshold: this.threshold, observedPaths: this.observedPathList() };
  }
}

/**
 * Template inference over a whole set of paths. Pure, deterministic and
 * order-independent: every path is observed first and resolved second, so
 * shuffling the input cannot change the answer.
 */
export function inferRouteTemplates(
  routePaths: readonly string[],
  options?: { cardinalityThreshold?: number },
): TemplateInference {
  const index = new RouteTemplateIndex(options);
  for (const path of routePaths) index.observe(path);
  return {
    templates: index.templates(),
    unresolved: index.unresolved(),
    observedPaths: index.observedPaths,
    cardinalityThreshold: index.cardinalityThreshold,
  };
}

// ─── 3. The budget: validated, configurable, and far larger than 60 ────────

/**
 * Every limit the crawl applies, in one object.
 *
 * Four of these are hard-coded integers in crawler.ts today with no name, no
 * configuration and no record that they applied: `slice(0, 20)` on affordances,
 * `journeys.length < 40`, and the page/depth caps all three web callers pass as
 * a literal 25 and 3. A cap with no name cannot be disclosed, which is the
 * point of naming them.
 */
export interface CrawlBudgetLimits {
  pageBudget: number;
  perTemplatePageBudget: number;
  maxDepth: number;
  wallClockMillis: number;
  /** How many URLs may wait in the queue before offers are refused. */
  queueCapacity: number;
  /** Links taken from one page. */
  linksPerPage: number;
  /** Affordances recorded on one node — today a bare `slice(0, 20)`. */
  affordancesPerPage: number;
  /** Journeys derived from the finished graph — today a bare `< 40`. */
  journeyLimit: number;
  /** Parallel visitors. The serial crawl is why even 60 pages is slow. */
  workers: number;
}

/** The fields of `CrawlBudgetLimits` that are not `CrawlPolicy` fields. */
export type CrawlLimitOverrides = Partial<
  Pick<
    CrawlBudgetLimits,
    'queueCapacity' | 'linksPerPage' | 'affordancesPerPage' | 'journeyLimit' | 'workers'
  >
>;

/**
 * Defaults for the limits that are NOT on `Environment.crawlPolicy`.
 *
 * On an options object rather than in `process.env`, per the house rule: a
 * crawl's scope has to be reviewable on the environment it applies to, and an
 * environment variable is neither reviewable nor per-environment.
 */
export const DEFAULT_CRAWL_LIMITS: Required<CrawlLimitOverrides> = {
  queueCapacity: 50_000,
  linksPerPage: 500,
  affordancesPerPage: 100,
  journeyLimit: 200,
  workers: 4,
};

/**
 * The per-plan ceilings. A `Record<Plan, …>` so the compiler refuses a new plan
 * with no ceiling — the same presence discipline the vocabularies above use.
 *
 * These are CEILINGS, not defaults. `DEFAULT_CRAWL_POLICY` describes a normal
 * application (1,000 pages, depth 12); these describe how much compute a tier
 * has bought. The FREE ceiling of 100 pages is BELOW that default, so a free
 * org's crawl is clamped — and a clamp that bites is a cap that bit, reported
 * with a count and a reason like every other one. Clamping in silence is how
 * "100% covered" comes to mean "100% of the first 100 states".
 */
export const PLAN_CRAWL_CEILINGS: Record<Plan, CrawlBudgetLimits> = {
  FREE: {
    pageBudget: 100,
    perTemplatePageBudget: 10,
    maxDepth: 6,
    wallClockMillis: 5 * 60 * 1_000,
    queueCapacity: 5_000,
    linksPerPage: 200,
    affordancesPerPage: 50,
    journeyLimit: 40,
    workers: 1,
  },
  TEAM: {
    pageBudget: 2_000,
    perTemplatePageBudget: 50,
    maxDepth: 15,
    wallClockMillis: 30 * 60 * 1_000,
    queueCapacity: 50_000,
    linksPerPage: 500,
    affordancesPerPage: 100,
    journeyLimit: 200,
    workers: 4,
  },
  BUSINESS: {
    pageBudget: 20_000,
    perTemplatePageBudget: 200,
    maxDepth: 25,
    wallClockMillis: 2 * 60 * 60 * 1_000,
    queueCapacity: 200_000,
    linksPerPage: 2_000,
    affordancesPerPage: 250,
    journeyLimit: 1_000,
    workers: 10,
  },
  ENTERPRISE: {
    // The maxima `crawlPolicySchema` will store, so an enterprise policy is
    // bounded by what can be persisted and by nothing else.
    pageBudget: 100_000,
    perTemplatePageBudget: 10_000,
    maxDepth: 100,
    wallClockMillis: 6 * 60 * 60 * 1_000,
    queueCapacity: 1_000_000,
    linksPerPage: 10_000,
    affordancesPerPage: 1_000,
    journeyLimit: 10_000,
    workers: 24,
  },
};

/** One limit the plan ceiling lowered, with both numbers. */
export interface BudgetClamp {
  field: keyof CrawlBudgetLimits;
  /** The cap this limit becomes when it bites, for the ledger. Null when it has none. */
  cap: CrawlCap | null;
  requested: number;
  applied: number;
  ceiling: number;
  plan: Plan;
  why: string;
}

export interface ResolvedCrawlBudget {
  limits: CrawlBudgetLimits;
  /** The environment's policy as applied, including which fields anybody chose. */
  policy: AppliedCrawlPolicy;
  plan: Plan;
  /** Limits the plan ceiling lowered. Empty when the policy fitted. */
  clamped: BudgetClamp[];
  /** Override values that were not usable, and why they were ignored. */
  rejected: Array<{ field: string; value: unknown; why: string }>;
}

const CAP_FOR_FIELD: Partial<Record<keyof CrawlBudgetLimits, CrawlCap>> = {
  pageBudget: 'PAGE_BUDGET',
  perTemplatePageBudget: 'PER_TEMPLATE_BUDGET',
  maxDepth: 'DEPTH',
  wallClockMillis: 'WALL_CLOCK',
  queueCapacity: 'QUEUE_SIZE',
  linksPerPage: 'LINKS_PER_PAGE',
  affordancesPerPage: 'AFFORDANCES_PER_PAGE',
  journeyLimit: 'JOURNEY_LIMIT',
};

/**
 * Builds the budget from the environment's stored policy and the org's plan.
 *
 * `resolveCrawlPolicy` (phase 1) does the per-field type checking, so a JSONB
 * `pageBudget: "1000"` cannot arrive here as a string and make a cap stop
 * applying. This adds the plan ceiling, and every clamp is RETURNED rather than
 * quietly swallowed: `clamped` is what lets a report say "your plan limited this
 * crawl to 100 pages" instead of printing a coverage percentage computed over a
 * twelfth of the application with no explanation.
 */
export function resolveCrawlBudget(input: {
  /** `Environment.crawlPolicy`, raw from the JSONB column. */
  storedPolicy?: unknown;
  plan: Plan;
  /** The limits that are not policy fields. Anything omitted keeps its default. */
  overrides?: CrawlLimitOverrides;
}): ResolvedCrawlBudget {
  const policy = resolveCrawlPolicy(input.storedPolicy ?? null);
  const ceilings = PLAN_CRAWL_CEILINGS[input.plan];
  const rejected: Array<{ field: string; value: unknown; why: string }> = [];

  const overrides = input.overrides ?? {};
  const extra: Required<CrawlLimitOverrides> = { ...DEFAULT_CRAWL_LIMITS };
  for (const field of Object.keys(DEFAULT_CRAWL_LIMITS) as Array<keyof CrawlLimitOverrides>) {
    const value = overrides[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      // Reported, not dropped. A caller that asked for `workers: 0` has asked
      // for a crawl that visits nothing, and silently substituting the default
      // would hide the bug in whatever computed it.
      rejected.push({ field, value, why: 'not a positive integer — the default stands' });
      continue;
    }
    extra[field] = value;
  }

  const requested: CrawlBudgetLimits = {
    pageBudget: policy.policy.pageBudget,
    perTemplatePageBudget: policy.policy.perTemplatePageBudget,
    maxDepth: policy.policy.maxDepth,
    wallClockMillis: policy.policy.wallClockMillis,
    ...extra,
  };

  const limits: CrawlBudgetLimits = { ...requested };
  const clamped: BudgetClamp[] = [];
  for (const field of Object.keys(requested) as Array<keyof CrawlBudgetLimits>) {
    const ceiling = ceilings[field];
    if (requested[field] <= ceiling) continue;
    limits[field] = ceiling;
    clamped.push({
      field,
      cap: CAP_FOR_FIELD[field] ?? null,
      requested: requested[field],
      applied: ceiling,
      ceiling,
      plan: input.plan,
      why: `the ${input.plan} plan's ceiling for ${field} is ${ceiling}; ${requested[field]} was asked for`,
    });
  }

  return { limits, policy, plan: input.plan, clamped, rejected };
}

// ─── 6. The known-unknown account ───────────────────────────────────────────

/**
 * The components of "at least N more URLs existed".
 *
 * Separate kinds because collapsing them is how a report comes to say something
 * false, and because only SOME of them are part of the lower bound. The rule is
 * phase 1's and it is not re-litigated here: a refused URL is KNOWN BY NAME (it
 * is in the exclusion ledger, so it is not part of "more existed"), an
 * off-origin URL is not this application's surface, and an unreachable URL is
 * unknown-not-absent — claiming it as missing surface would invent a number in
 * the alarming direction, which is the same sin as inventing one in the
 * flattering direction.
 */
export const KNOWN_UNKNOWN_KINDS = [
  /** Discovered, in scope, still queued when the crawl stopped. */
  'UNVISITED_QUEUED',
  /** Discovered, in scope, past the depth limit. */
  'BEYOND_DEPTH',
  /** Discovered, in scope, refused because its route template was full. */
  'TEMPLATE_OVERFLOW',
  /** Discovered, in scope, refused because the queue was full. */
  'QUEUE_OVERFLOW',
  /** Refused by a policy rule. Known by name — see the exclusion ledger. */
  'REFUSED_BY_POLICY',
  /** Another origin. Not this application's surface. */
  'OFF_ORIGIN',
  /** Failed to load. Unknown whether it exists. */
  'UNREACHABLE',
] as const;
export type KnownUnknownKind = (typeof KNOWN_UNKNOWN_KINDS)[number];

export const KNOWN_UNKNOWN_PRESENT: Record<KnownUnknownKind, true> = {
  UNVISITED_QUEUED: true,
  BEYOND_DEPTH: true,
  TEMPLATE_OVERFLOW: true,
  QUEUE_OVERFLOW: true,
  REFUSED_BY_POLICY: true,
  OFF_ORIGIN: true,
  UNREACHABLE: true,
};

/**
 * Which kinds are part of the lower bound.
 *
 * A `Record` rather than a filter in a function body, so adding a kind forces a
 * decision about whether it counts. The four that count are the four that are
 * "in scope, discovered, and not visited"; the three that do not each have
 * their reason stated above.
 */
export const COUNTS_TOWARD_LOWER_BOUND: Record<KnownUnknownKind, boolean> = {
  UNVISITED_QUEUED: true,
  BEYOND_DEPTH: true,
  TEMPLATE_OVERFLOW: true,
  QUEUE_OVERFLOW: true,
  REFUSED_BY_POLICY: false,
  OFF_ORIGIN: false,
  UNREACHABLE: false,
};

export interface KnownUnknownComponent {
  kind: KnownUnknownKind;
  /** Distinct URLs, never offer events: the same link on 50 pages is one URL. */
  count: number;
  countsTowardLowerBound: boolean;
  reason: string;
  sample: string[];
}

export interface KnownUnknownAccount {
  /** The headline: at least this many more in-scope URLs existed. */
  atLeastMoreUrls: number;
  components: KnownUnknownComponent[];
  /** The stored shape, which `frontierSchema` accepts exactly as written. */
  frontier: Frontier;
  caps: CapBite[];
  excluded: ExcludedPath[];
  externals: ExternalBoundary[];
  /**
   * Plan ceilings that lowered a limit. Carried here even when they never bit,
   * because "this crawl was allowed 100 pages" belongs beside the number
   * whether or not the application had more.
   */
  clamps: BudgetClamp[];
  /** The templates inferred, with evidence, and the families left undecided. */
  templates: TemplateInference;
}

// ─── 4. The frontier itself ─────────────────────────────────────────────────

export interface FrontierEntry {
  /** Canonical URL. The identity. */
  url: string;
  depth: number;
  /** Route template as known when the entry was queued. */
  template: string;
  /**
   * The key the per-template budget charged this entry to — see
   * `RouteTemplateIndex.budgetKeyFor`. Stored on the entry rather than
   * recomputed, because the index has learned more paths by the time the visit
   * finishes and a recomputed key would credit the refund to a different
   * bucket than the one that was charged.
   */
  budgetKey: string;
  /** Canonical URL of the page it was found on. Null for a seed. */
  discoveredFrom: string | null;
  discoveredVia: DiscoverySource;
  /**
   * The deterministic sort key: the parent's key with this entry's index among
   * its siblings appended.
   *
   * A global counter is the obvious choice and it is WRONG the moment the crawl
   * is parallel: the counter then depends on which worker finished first, so two
   * runs over the same application produce the same nodes in a different order,
   * every `node-N` id shifts, and the version-to-version diff — a shipped
   * feature — shows the whole graph as changed. A path key depends only on the
   * link structure, so the order is reproducible however the work was scheduled.
   */
  order: number[];
}

/** Compares two entries into BFS order: depth first, then discovery path. */
export function compareFrontierEntries(left: FrontierEntry, right: FrontierEntry): number {
  if (left.depth !== right.depth) return left.depth - right.depth;
  const length = Math.max(left.order.length, right.order.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.order[index] ?? -1;
    const b = right.order[index] ?? -1;
    if (a !== b) return a - b;
  }
  return left.url.localeCompare(right.url);
}

export interface OfferedCandidate {
  /** The href as found, absolute or relative to the page it was found on. */
  url: string;
  via: DiscoverySource;
  /** How it was referenced, for the external-boundary ledger. */
  referenceKind?: ExternalKind;
}

export const OFFER_OUTCOMES = [
  'ACCEPTED',
  /** The same place, already queued, visited or decided. Costs nothing. */
  'DUPLICATE',
  'UNSUPPORTED_SCHEME',
  'OFF_ORIGIN',
  'REFUSED_BY_POLICY',
  'BEYOND_DEPTH',
  'TEMPLATE_BUDGET',
  'QUEUE_FULL',
] as const;
export type OfferOutcomeKind = (typeof OFFER_OUTCOMES)[number];

export const OFFER_OUTCOME_PRESENT: Record<OfferOutcomeKind, true> = {
  ACCEPTED: true,
  DUPLICATE: true,
  UNSUPPORTED_SCHEME: true,
  OFF_ORIGIN: true,
  REFUSED_BY_POLICY: true,
  BEYOND_DEPTH: true,
  TEMPLATE_BUDGET: true,
  QUEUE_FULL: true,
};

export type OfferOutcome =
  | { kind: 'ACCEPTED'; entry: FrontierEntry }
  | { kind: Exclude<OfferOutcomeKind, 'ACCEPTED'>; url: string | null; reason: string };

export interface FrontierOptions {
  baseUrl: string;
  budget: ResolvedCrawlBudget;
  hashRouting?: HashRoutingMode;
  cardinalityThreshold?: number;
}

/** What `serialiseFrontier` writes. JSON only — no Map, no Set, no RegExp. */
export interface FrontierSnapshot {
  /** Bumped when the shape changes, so a restore can say it is reading an old one. */
  snapshotVersion: 1;
  baseUrl: string;
  /** The canonicalisation inputs. A restore under different ones is reported. */
  canonicalisation: CanonicalisationFingerprint;
  queue: FrontierEntry[];
  visited: string[];
  unreachable: string[];
  beyondDepth: string[];
  offOrigin: string[];
  /** Decided-and-final URLs with their outcome, so a resume re-refuses nothing. */
  decided: Array<{ url: string; outcome: OfferOutcomeKind }>;
  templateCounts: Array<{ template: string; admitted: number; visited: number; discarded: number }>;
  observedPaths: string[];
  excluded: ExcludedPath[];
  externals: ExternalBoundary[];
  caps: CapBite[];
  /** Child counters, so a resumed page's new links sort after its old ones. */
  childCounts: Array<{ url: string; count: number }>;
  nextRootOrder: number;
}

export interface CanonicalisationFingerprint {
  hashRouting: HashRoutingMode;
  ignoredQueryParams: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  additionalOrigins: string[];
  cardinalityThreshold: number;
}

interface TemplateCounter {
  /** Queued or visited. What the per-template budget actually counts. */
  admitted: number;
  visited: number;
  discarded: number;
  sample: string[];
}

/**
 * The frontier as a VALUE: the queue with depths and provenance, the visited
 * set, the per-template counters, the refused ledger and the known-unknown
 * lower bound — all of it serialisable.
 *
 * THE DEFECT: the queue is a local `const queue: Array<…>` inside `crawl()`, so
 * a truncated crawl can never be continued and a crashed one loses everything,
 * including the knowledge that there was more. "At least 240 more URLs existed"
 * is unsayable when the array holding those 240 URLs is freed with the function.
 */
export class CrawlFrontier {
  readonly baseUrl: string;
  readonly limits: CrawlBudgetLimits;
  readonly policy: CrawlPolicy;
  readonly budget: ResolvedCrawlBudget;
  readonly hashRouting: HashRoutingMode;

  private readonly templateIndex: RouteTemplateIndex;
  /** depth → entries, sorted lazily when the scheduler reaches that depth. */
  private readonly buckets = new Map<number, { entries: FrontierEntry[]; sorted: boolean }>();
  private readonly visited = new Set<string>();
  private readonly unreachableUrls = new Set<string>();
  private readonly queuedUrls = new Set<string>();
  private readonly beyondDepthUrls = new Set<string>();
  private readonly offOriginUrls = new Set<string>();
  private readonly decidedUrls = new Map<string, OfferOutcomeKind>();
  private readonly templateCounts = new Map<string, TemplateCounter>();
  private readonly excludedLedger = new Map<string, ExcludedPath>();
  private readonly externalLedger = new Map<string, ExternalBoundary>();
  private readonly capLedger = new Map<string, CapBite>();
  private readonly childCounts = new Map<string, number>();
  private readonly overflowSamples = new Map<KnownUnknownKind, string[]>();
  private queueOverflowCount = 0;
  private queuedCount = 0;
  private nextRootOrder = 0;
  private terminalCapClaimed = false;

  constructor(options: FrontierOptions) {
    this.baseUrl = options.baseUrl;
    this.budget = options.budget;
    this.limits = options.budget.limits;
    this.policy = options.budget.policy.policy;
    this.hashRouting = options.hashRouting ?? 'AUTO';
    this.templateIndex = new RouteTemplateIndex(
      options.cardinalityThreshold === undefined
        ? undefined
        : { cardinalityThreshold: options.cardinalityThreshold },
    );
  }

  get visitedCount(): number {
    return this.visited.size;
  }

  get pendingCount(): number {
    return this.queuedCount;
  }

  get templates(): RouteTemplateIndex {
    return this.templateIndex;
  }

  /** Which plan clamps apply, so a caller need not thread the budget separately. */
  get clamps(): BudgetClamp[] {
    return this.budget.clamped;
  }

  /** The canonical identity of a URL under this frontier's policy. */
  canonicalise(raw: string, relativeTo?: string | null): CanonicaliseResult {
    let absolute = raw;
    if (relativeTo !== undefined && relativeTo !== null) {
      try {
        absolute = new URL(raw, relativeTo).toString();
      } catch {
        absolute = raw;
      }
    }
    return canonicaliseUrl(absolute, { policy: this.policy, hashRouting: this.hashRouting });
  }

  /** Seeds the crawl. A seed is depth 0 and its own root in the order key. */
  seed(url: string, via: DiscoverySource = 'SEED'): OfferOutcome {
    return this.offer({ url, via }, null);
  }

  /**
   * The ONE admission decision, and the only place a candidate can be dropped.
   *
   * Check order is deliberate, and each step ends in a different ledger:
   *
   *   scheme → off-origin → already-decided → policy → depth → template → queue
   *
   * Scheme and origin come first because `policyDecision` takes a PATH, and a
   * path from another origin is meaningless against our globs; off-origin also
   * precedes the duplicate check because the external ledger counts
   * OCCURRENCES, and "47 links to accounts.google.com" is the useful number.
   * "Already decided" then comes before the policy so a refusal is recorded
   * once however many pages link to it — a customer wants to read "we refused
   * /logout", not the same line fifty times. Depth comes before the template
   * and queue budgets because a depth decision is NOT final; see below.
   */
  offer(candidate: OfferedCandidate, parent: FrontierEntry | null): OfferOutcome {
    const result = this.canonicalise(candidate.url, parent?.url ?? this.baseUrl);
    if (!result.ok) {
      // A `mailto:` link is not surface, and not a refusal of surface either —
      // but it IS a thing we chose not to follow, so it lands in the ledger with
      // its reason rather than vanishing into a `continue`.
      this.recordExclusion({
        url: candidate.url.slice(0, 2_000),
        route: null,
        kind: result.kind,
        rule: result.rule,
        discoveredFrom: parent?.url ?? null,
      });
      return { kind: 'UNSUPPORTED_SCHEME', url: null, reason: result.rule };
    }

    const canonical = result.canonical;
    const url = canonical.url;

    if (!isOwnOrigin(this.baseUrl, url, this.policy)) {
      this.offOriginUrls.add(url);
      this.recordExternal(canonical, candidate.referenceKind ?? 'LINK', parent);
      return {
        kind: 'OFF_ORIGIN',
        url,
        reason: `${canonical.origin} is not this application's origin`,
      };
    }

    if (this.visited.has(url) || this.queuedUrls.has(url)) {
      return { kind: 'DUPLICATE', url, reason: 'already visited or queued' };
    }
    const decided = this.decidedUrls.get(url);
    if (decided !== undefined) {
      return { kind: 'DUPLICATE', url, reason: `already decided: ${decided}` };
    }

    const decision = policyDecision(this.policy, canonical.pathname);
    if (!decision.admitted) {
      this.templateIndex.observe(canonical.routePath);
      this.recordExclusion({
        url,
        route: this.templateIndex.templateFor(canonical.routePath).template,
        kind: exclusionKindForRule(decision.rule, canonical.pathname),
        rule: decision.rule,
        discoveredFrom: parent?.url ?? null,
      });
      this.decidedUrls.set(url, 'REFUSED_BY_POLICY');
      return { kind: 'REFUSED_BY_POLICY', url, reason: decision.rule };
    }

    const depth = parent === null ? 0 : parent.depth + 1;
    if (depth > this.limits.maxDepth) {
      /*
       * NOT final, and a separate set is how that is expressed.
       *
       * The same URL can be offered at depth 13 from a deep page and at depth 2
       * from the navigation bar. Recording the first as a closed decision would
       * lose a page that is two clicks from the home page. Breadth-first makes
       * the shallow offer arrive first in practice; relying on that is how an
       * ordering assumption becomes a missing route, so the rescue below is
       * explicit rather than incidental.
       */
      this.beyondDepthUrls.add(url);
      this.noteCap({
        cap: 'DEPTH',
        limit: this.limits.maxDepth,
        bites: 1,
        discarded: 1,
        scope: null,
        reason: `${CRAWL_CAP_LABELS.DEPTH} of ${this.limits.maxDepth} stopped a link at depth ${depth}`,
      });
      return {
        kind: 'BEYOND_DEPTH',
        url,
        reason: `depth ${depth} is past the limit of ${this.limits.maxDepth}`,
      };
    }

    this.templateIndex.observe(canonical.routePath);
    const template = this.templateIndex.templateFor(canonical.routePath).template;
    // The BUDGET key, not the route template. See `budgetKeyFor`: the
    // denominator must be exact and the cap must be conservative, and charging
    // the cap to the exact template leaks one page per template because the
    // first instance has no sibling yet.
    const budgetKey = this.templateIndex.budgetKeyFor(canonical.routePath);
    const counter = this.counterFor(budgetKey);

    if (counter.admitted >= this.limits.perTemplatePageBudget) {
      counter.discarded += 1;
      if (counter.sample.length < 5) counter.sample.push(url);
      this.decidedUrls.set(url, 'TEMPLATE_BUDGET');
      this.rememberOverflow('TEMPLATE_OVERFLOW', url);
      this.noteCap({
        cap: 'PER_TEMPLATE_BUDGET',
        limit: this.limits.perTemplatePageBudget,
        bites: 1,
        discarded: 1,
        scope: budgetKey,
        reason:
          `${budgetKey} reached its ${this.limits.perTemplatePageBudget}-page budget; ` +
          `further instances were not enumerated`,
      });
      return {
        kind: 'TEMPLATE_BUDGET',
        url,
        reason: `${budgetKey} already contributed ${counter.admitted} page(s)`,
      };
    }

    if (this.queuedCount >= this.limits.queueCapacity) {
      this.decidedUrls.set(url, 'QUEUE_FULL');
      this.queueOverflowCount += 1;
      this.rememberOverflow('QUEUE_OVERFLOW', url);
      this.noteCap({
        cap: 'QUEUE_SIZE',
        limit: this.limits.queueCapacity,
        bites: 1,
        discarded: 1,
        scope: null,
        reason: `the frontier queue reached its ${this.limits.queueCapacity}-entry capacity`,
      });
      return {
        kind: 'QUEUE_FULL',
        url,
        reason: `the queue is at its ${this.limits.queueCapacity}-entry capacity`,
      };
    }

    // Rescued from the depth set: it was known-and-unreached a moment ago and is
    // about to be queued, so it must stop being counted as unreached.
    this.beyondDepthUrls.delete(url);

    const siblingIndex = parent === null ? this.nextRootOrder++ : this.nextChildIndex(parent.url);
    const entry: FrontierEntry = {
      url,
      depth,
      template,
      budgetKey,
      discoveredFrom: parent?.url ?? null,
      discoveredVia: candidate.via,
      order: parent === null ? [siblingIndex] : [...parent.order, siblingIndex],
    };

    counter.admitted += 1;
    this.push(entry);
    return { kind: 'ACCEPTED', entry };
  }

  private counterFor(template: string): TemplateCounter {
    const existing = this.templateCounts.get(template);
    if (existing !== undefined) return existing;
    const fresh: TemplateCounter = { admitted: 0, visited: 0, discarded: 0, sample: [] };
    this.templateCounts.set(template, fresh);
    return fresh;
  }

  private nextChildIndex(parentUrl: string): number {
    const next = this.childCounts.get(parentUrl) ?? 0;
    this.childCounts.set(parentUrl, next + 1);
    return next;
  }

  private push(entry: FrontierEntry): void {
    const bucket = this.buckets.get(entry.depth) ?? { entries: [], sorted: false };
    bucket.entries.push(entry);
    bucket.sorted = false;
    this.buckets.set(entry.depth, bucket);
    this.queuedUrls.add(entry.url);
    this.queuedCount += 1;
  }

  /**
   * The next entry to visit, in BFS order, optionally skipping entries the
   * caller cannot start yet (a per-origin concurrency limit, a politeness
   * delay).
   *
   * A skipped entry STAYS in the queue. That matters: a `take` that dropped
   * what it could not start would lose pages to the politeness delay and then
   * report them as if they did not exist.
   */
  take(canStart?: (entry: FrontierEntry) => boolean): FrontierEntry | null {
    const depths = [...this.buckets.keys()].sort((left, right) => left - right);
    for (const depth of depths) {
      const bucket = this.buckets.get(depth);
      if (bucket === undefined || bucket.entries.length === 0) continue;
      if (!bucket.sorted) {
        bucket.entries.sort(compareFrontierEntries);
        bucket.sorted = true;
      }
      const index =
        canStart === undefined ? 0 : bucket.entries.findIndex((entry) => canStart(entry));
      if (index < 0) continue;
      const [entry] = bucket.entries.splice(index, 1);
      if (entry === undefined) continue;
      this.queuedUrls.delete(entry.url);
      this.queuedCount -= 1;
      return entry;
    }
    return null;
  }

  /** Puts an entry back, unvisited. For a visit abandoned rather than failed. */
  requeue(entry: FrontierEntry): void {
    if (this.visited.has(entry.url) || this.queuedUrls.has(entry.url)) return;
    this.push(entry);
  }

  /**
   * Records a successful visit.
   *
   * `finalRoutePath` is where the navigation actually landed. A redirect means
   * the page we got is not the URL we asked for, and the template the visit
   * spent belongs to what we GOT — otherwise a login redirect charges the budget
   * to `/orders/:id` while every one of those visits saw the sign-in page.
   */
  markVisited(entry: FrontierEntry, finalRoutePath?: string | null): void {
    this.visited.add(entry.url);
    this.queuedUrls.delete(entry.url);
    let budgetKey = entry.budgetKey;
    if (finalRoutePath !== undefined && finalRoutePath !== null) {
      this.templateIndex.observe(finalRoutePath);
      budgetKey = this.templateIndex.budgetKeyFor(finalRoutePath);
      if (budgetKey !== entry.budgetKey) {
        // The admission was charged to the template we ASKED for; move it, or a
        // login redirect spends `/orders/:id`'s budget on visits that every one
        // of them saw the sign-in page for.
        const asked = this.counterFor(entry.budgetKey);
        asked.admitted = Math.max(0, asked.admitted - 1);
        this.counterFor(budgetKey).admitted += 1;
      }
    }
    this.counterFor(budgetKey).visited += 1;
  }

  /**
   * Records a navigation that failed.
   *
   * UNREACHABLE, not "does not exist": a timeout, a connection reset and a DNS
   * failure all leave us not knowing whether the page is there. It is reported
   * as its own count and is deliberately NOT part of the lower bound — see
   * `COUNTS_TOWARD_LOWER_BOUND`.
   */
  markUnreachable(entry: FrontierEntry): void {
    this.unreachableUrls.add(entry.url);
    this.queuedUrls.delete(entry.url);
    this.decidedUrls.set(entry.url, 'DUPLICATE');
  }

  /**
   * Adds or merges a cap bite.
   *
   * Public because the caps outside this module's reach — `LINKS_PER_PAGE`,
   * `AFFORDANCES_PER_PAGE`, `JOURNEY_LIMIT` — are applied in crawler.ts and must
   * land in the SAME ledger, or a report has two partial lists of caps and no
   * way to know it.
   */
  noteCap(bite: CapBite): void {
    const key = `${bite.cap}:${bite.scope ?? ''}`;
    const existing = this.capLedger.get(key);
    if (existing === undefined) {
      this.capLedger.set(key, { ...bite });
      return;
    }
    existing.bites += bite.bites;
    existing.discarded += bite.discarded;
    existing.limit = bite.limit;
    existing.reason = bite.reason;
  }

  /**
   * Records the cap that ENDED the crawl, with the queue it left behind.
   *
   * Only the first terminal cap is recorded, and the reason is arithmetic:
   * `discardedByCaps` (phase 1) SUMS `discarded` across the ledger. If the page
   * budget and the wall clock both claimed the same 240 leftover URLs the sum
   * would be 480 — a number inflated in the alarming direction, which this file
   * treats as exactly as bad as flattering one.
   */
  noteTerminalCap(cap: Extract<CrawlCap, 'PAGE_BUDGET' | 'WALL_CLOCK'>): void {
    if (this.terminalCapClaimed) return;
    this.terminalCapClaimed = true;
    const limit = cap === 'PAGE_BUDGET' ? this.limits.pageBudget : this.limits.wallClockMillis;
    this.noteCap({
      cap,
      limit,
      bites: 1,
      discarded: this.queuedCount,
      scope: null,
      reason:
        `${CRAWL_CAP_LABELS[cap]} (${limit}) stopped the crawl with ${this.queuedCount} ` +
        `in-scope URL(s) still queued`,
    });
  }

  private rememberOverflow(kind: KnownUnknownKind, url: string): void {
    const sample = this.overflowSamples.get(kind) ?? [];
    if (sample.length < 5) sample.push(url);
    this.overflowSamples.set(kind, sample);
  }

  private recordExclusion(entry: ExcludedPath): void {
    // Keyed by URL, so one refused path linked from fifty pages is ONE refusal.
    // The count a report prints is "31 URLs refused", not "1,400 links ignored".
    if (this.excludedLedger.has(entry.url)) return;
    this.excludedLedger.set(entry.url, entry);
  }

  private recordExternal(
    canonical: CanonicalUrl,
    kind: ExternalKind,
    parent: FrontierEntry | null,
  ): void {
    const parts = externalParts(canonical.url);
    if (parts === null) return;
    const key = `${kind}:${parts.origin}`;
    const existing = this.externalLedger.get(key);
    if (existing !== undefined) {
      existing.occurrences += 1;
      return;
    }
    this.externalLedger.set(key, {
      kind,
      origin: parts.origin,
      fromRoute: parent?.template ?? null,
      // Origin and PATH only. A redirect to an identity provider carries the
      // tenant, a user hint and a state token in its query string, and a flow
      // map is stored, rendered in a cockpit and exported on request.
      samplePath: parts.path === '' ? '/' : parts.path,
      occurrences: 1,
    });
  }

  /** Every cap in the ledger, biggest cost first. */
  caps(): CapBite[] {
    return [...this.capLedger.values()].sort(
      (left, right) => right.discarded - left.discarded || left.cap.localeCompare(right.cap),
    );
  }

  /** The refusal ledger. A refused URL and a nonexistent URL never read the same. */
  excluded(): ExcludedPath[] {
    return [...this.excludedLedger.values()];
  }

  externals(): ExternalBoundary[] {
    return [...this.externalLedger.values()].sort(
      (left, right) =>
        right.occurrences - left.occurrences || left.origin.localeCompare(right.origin),
    );
  }

  /**
   * The whole account: the lower bound, its components, and the stored
   * `Frontier` shape that `frontierSchema` accepts as written.
   *
   * `TEMPLATE_OVERFLOW` and `QUEUE_OVERFLOW` are FOLDED into the stored
   * `unvisitedQueued`, and the fold is correct rather than convenient: phase 1
   * defines that field as "in scope, discovered, never visited", which is
   * exactly what all three are. They stay distinguishable in `components`,
   * because "your per-template budget hid 900 orders" and "the crawl ran out of
   * time" have different remedies.
   *
   * The one arithmetic trap worth naming out loud: `atLeastMoreUrls` and
   * `discardedByCaps(caps)` OVERLAP and must never be added together. The
   * overflow URLs appear in both — once as surface we did not reach, once as the
   * cost of the cap that stopped us reaching it.
   */
  account(): KnownUnknownAccount {
    const templateOverflow = [...this.templateCounts.values()].reduce(
      (running, counter) => running + counter.discarded,
      0,
    );
    const queuedSample = this.pending()
      .slice(0, 5)
      .map((entry) => entry.url);
    const templateSample = this.overflowSamples.get('TEMPLATE_OVERFLOW') ?? [];
    const queueSample = this.overflowSamples.get('QUEUE_OVERFLOW') ?? [];
    const depthSample = [...this.beyondDepthUrls].slice(0, 5);
    const externals = this.externals();

    const components: KnownUnknownComponent[] = [
      {
        kind: 'UNVISITED_QUEUED',
        count: this.queuedCount,
        countsTowardLowerBound: COUNTS_TOWARD_LOWER_BOUND.UNVISITED_QUEUED,
        reason: 'discovered, in scope, and still queued when the crawl stopped',
        sample: queuedSample,
      },
      {
        kind: 'BEYOND_DEPTH',
        count: this.beyondDepthUrls.size,
        countsTowardLowerBound: COUNTS_TOWARD_LOWER_BOUND.BEYOND_DEPTH,
        reason: `seen past the depth limit of ${this.limits.maxDepth}`,
        sample: depthSample,
      },
      {
        kind: 'TEMPLATE_OVERFLOW',
        count: templateOverflow,
        countsTowardLowerBound: COUNTS_TOWARD_LOWER_BOUND.TEMPLATE_OVERFLOW,
        reason: `refused by the ${this.limits.perTemplatePageBudget}-page per-template budget`,
        sample: templateSample,
      },
      {
        kind: 'QUEUE_OVERFLOW',
        count: this.queueOverflowCount,
        countsTowardLowerBound: COUNTS_TOWARD_LOWER_BOUND.QUEUE_OVERFLOW,
        reason: `refused because the queue was at its ${this.limits.queueCapacity}-entry capacity`,
        sample: queueSample,
      },
      {
        kind: 'REFUSED_BY_POLICY',
        count: this.excludedLedger.size,
        countsTowardLowerBound: COUNTS_TOWARD_LOWER_BOUND.REFUSED_BY_POLICY,
        reason: 'refused by a policy rule — known by name, so not part of "more existed"',
        sample: [...this.excludedLedger.keys()].slice(0, 5),
      },
      {
        kind: 'OFF_ORIGIN',
        count: this.offOriginUrls.size,
        countsTowardLowerBound: COUNTS_TOWARD_LOWER_BOUND.OFF_ORIGIN,
        reason:
          `another origin — somebody else's application, not this one's surface ` +
          `(${externals.reduce((running, external) => running + external.occurrences, 0)} reference(s) ` +
          `to ${externals.length} boundary/boundaries)`,
        sample: externals.slice(0, 5).map((external) => external.origin),
      },
      {
        kind: 'UNREACHABLE',
        count: this.unreachableUrls.size,
        countsTowardLowerBound: COUNTS_TOWARD_LOWER_BOUND.UNREACHABLE,
        reason:
          'failed to load — unknown whether it exists, so claimed as neither present nor absent',
        sample: [...this.unreachableUrls].slice(0, 5),
      },
    ];

    const counts = {
      unvisitedQueued: this.queuedCount + templateOverflow + this.queueOverflowCount,
      beyondDepth: this.beyondDepthUrls.size,
      excluded: this.excludedLedger.size,
      offOrigin: this.offOriginUrls.size,
      unreachable: this.unreachableUrls.size,
    };
    const atLeastMoreUrls = lowerBoundMoreUrls(counts);
    const sample = [...queuedSample, ...templateSample, ...queueSample, ...depthSample].slice(
      0,
      100,
    );

    return {
      atLeastMoreUrls,
      components,
      frontier: {
        ...counts,
        atLeastMoreUrls,
        sample,
        // Honest in both directions: true only when the sample really is shorter
        // than the frontier it came from, which is what `frontierSchema`'s
        // refinement checks.
        sampleTruncated: sample.length < atLeastMoreUrls + counts.excluded,
      },
      caps: this.caps(),
      excluded: this.excluded(),
      externals,
      clamps: this.budget.clamped,
      templates: {
        templates: this.templateIndex.templates(),
        unresolved: this.templateIndex.unresolved(),
        observedPaths: this.templateIndex.observedPaths,
        cardinalityThreshold: this.templateIndex.cardinalityThreshold,
      },
    };
  }

  /** Every entry still queued, in BFS order. For a resume, and for a test. */
  pending(): FrontierEntry[] {
    const all: FrontierEntry[] = [];
    for (const bucket of this.buckets.values()) all.push(...bucket.entries);
    return all.sort(compareFrontierEntries);
  }

  visitedUrls(): string[] {
    return [...this.visited].sort();
  }

  /** The canonicalisation inputs, as the snapshot stores and compares them. */
  fingerprint(): CanonicalisationFingerprint {
    return {
      hashRouting: this.hashRouting,
      ignoredQueryParams: [...this.policy.ignoredQueryParams].sort(),
      includeGlobs: [...this.policy.includeGlobs].sort(),
      excludeGlobs: [...this.policy.excludeGlobs].sort(),
      additionalOrigins: [...this.policy.additionalOrigins].sort(),
      cardinalityThreshold: this.templateIndex.cardinalityThreshold,
    };
  }

  /** @internal Used by `serialiseFrontier`; not part of the crawl API. */
  toSnapshot(): FrontierSnapshot {
    return {
      snapshotVersion: 1,
      baseUrl: this.baseUrl,
      canonicalisation: this.fingerprint(),
      queue: this.pending().map((entry) => ({ ...entry, order: [...entry.order] })),
      visited: this.visitedUrls(),
      unreachable: [...this.unreachableUrls].sort(),
      beyondDepth: [...this.beyondDepthUrls].sort(),
      offOrigin: [...this.offOriginUrls].sort(),
      decided: [...this.decidedUrls.entries()]
        .map(([url, outcome]) => ({ url, outcome }))
        .sort((left, right) => left.url.localeCompare(right.url)),
      templateCounts: [...this.templateCounts.entries()]
        .map(([template, counter]) => ({
          template,
          admitted: counter.admitted,
          visited: counter.visited,
          discarded: counter.discarded,
        }))
        .sort((left, right) => left.template.localeCompare(right.template)),
      observedPaths: this.templateIndex.observedPathList(),
      excluded: this.excluded(),
      externals: this.externals(),
      caps: this.caps(),
      childCounts: [...this.childCounts.entries()]
        .map(([url, count]) => ({ url, count }))
        .sort((left, right) => left.url.localeCompare(right.url)),
      nextRootOrder: this.nextRootOrder,
    };
  }

  /** @internal Used by `restoreFrontier`; not part of the crawl API. */
  loadSnapshot(snapshot: FrontierSnapshot): void {
    for (const path of snapshot.observedPaths) this.templateIndex.observe(path);
    for (const entry of snapshot.queue) this.push({ ...entry, order: [...entry.order] });
    for (const url of snapshot.visited) this.visited.add(url);
    for (const url of snapshot.unreachable) this.unreachableUrls.add(url);
    for (const url of snapshot.beyondDepth) this.beyondDepthUrls.add(url);
    for (const url of snapshot.offOrigin) this.offOriginUrls.add(url);
    for (const { url, outcome } of snapshot.decided) this.decidedUrls.set(url, outcome);
    for (const row of snapshot.templateCounts) {
      this.templateCounts.set(row.template, {
        admitted: row.admitted,
        visited: row.visited,
        discarded: row.discarded,
        sample: [],
      });
    }
    for (const entry of snapshot.excluded) this.excludedLedger.set(entry.url, { ...entry });
    for (const external of snapshot.externals) {
      this.externalLedger.set(`${external.kind}:${external.origin}`, { ...external });
    }
    for (const cap of snapshot.caps)
      this.capLedger.set(`${cap.cap}:${cap.scope ?? ''}`, { ...cap });
    for (const { url, count } of snapshot.childCounts) this.childCounts.set(url, count);
    this.nextRootOrder = snapshot.nextRootOrder;
    this.queueOverflowCount = snapshot.caps.find((cap) => cap.cap === 'QUEUE_SIZE')?.discarded ?? 0;
  }
}

/** `/logout` matched an exclude glob — which KIND of refusal was it? */
function exclusionKindForRule(rule: string, pathname: string): ExclusionKind {
  if (rule.startsWith('includeGlobs')) return 'POLICY_NOT_INCLUDED';
  if (/logout|sign[-_]?out|signout/i.test(pathname)) return 'SESSION_ENDING';
  if (/delete|destroy|remove|purge|__reset/i.test(pathname)) return 'DESTRUCTIVE';
  return 'POLICY_EXCLUDE';
}

// ─── 4b. Serialise and restore ──────────────────────────────────────────────

/**
 * The frontier as JSON, so a truncated crawl can be continued and a crashed one
 * does not lose the knowledge that there was more.
 *
 * The STORAGE is the integrator's: this pair defines the shape, and nothing in
 * this module writes a row.
 */
export function serialiseFrontier(frontier: CrawlFrontier): FrontierSnapshot {
  return frontier.toSnapshot();
}

export interface RestoreResult {
  frontier: CrawlFrontier;
  /**
   * What changed between the snapshot and the policy it is restored under.
   *
   * Reported rather than enforced. Raising a page budget and resuming is the
   * whole point of a persisted frontier, so a changed budget is fine. A changed
   * `ignoredQueryParams` is NOT fine in the same way: every URL in the visited
   * set was canonicalised under the old list, so the crawl will re-visit pages
   * it has already seen and count them twice. A caller that ignores these
   * warnings gets a double-counted denominator, and this is where it was told.
   */
  warnings: string[];
}

export function restoreFrontier(
  snapshot: FrontierSnapshot,
  options: FrontierOptions,
): RestoreResult {
  const warnings: string[] = [];
  if (snapshot.snapshotVersion !== 1) {
    warnings.push(
      `snapshot version ${String(snapshot.snapshotVersion)} is not 1 — restored on a best effort, ` +
        `and the visited set may not mean what it did`,
    );
  }
  if (snapshot.baseUrl !== options.baseUrl) {
    warnings.push(
      `the snapshot was taken against ${snapshot.baseUrl} and is restored against ` +
        `${options.baseUrl} — every stored identity belongs to the other application`,
    );
  }

  const frontier = new CrawlFrontier(options);
  const fresh = frontier.fingerprint();
  for (const key of Object.keys(fresh) as Array<keyof CanonicalisationFingerprint>) {
    const before = JSON.stringify(snapshot.canonicalisation[key]);
    const after = JSON.stringify(fresh[key]);
    if (before === after) continue;
    warnings.push(
      `canonicalisation changed: ${key} was ${before} and is now ${after} — URLs already ` +
        `visited may canonicalise differently and be enumerated twice`,
    );
  }

  frontier.loadSnapshot(snapshot);
  return { frontier, warnings };
}

// ─── 5. Parallel-context scheduling ─────────────────────────────────────────

/**
 * What a visit produced. The crawl module returns this; the frontier never
 * learns what a browser is.
 */
export type VisitResult<T> =
  | {
      kind: 'VISITED';
      /** Whatever the caller wants to keep — a FlowNode, a page summary. */
      value: T;
      /**
       * Where the navigation actually landed, as a route path. Null when it is
       * not known; absent means the same thing. Never guess the requested path:
       * that is how a redirect to the login page gets charged to the route
       * nobody actually saw.
       */
      finalRoutePath?: string | null;
      discovered?: readonly OfferedCandidate[];
    }
  | { kind: 'UNREACHABLE'; reason: string }
  /** Stop the whole crawl — a TLS failure or a rate-limit wall, not a 404. */
  | { kind: 'ABORT'; reason: string };

export interface VisitContext {
  /** Which parallel slot this visit is running in, 0-based. */
  worker: number;
  /** Pages visited so far, so a visitor can report progress honestly. */
  visited: number;
}

export type CrawlVisitor<T> = (
  entry: FrontierEntry,
  context: VisitContext,
) => Promise<VisitResult<T>>;

export const CRAWL_STOP_REASONS = [
  /** The queue emptied. Still only "converged" when no cap discarded anything. */
  'CONVERGED',
  'PAGE_BUDGET',
  'WALL_CLOCK',
  /** A visitor asked to stop. */
  'ABORTED',
] as const;
export type CrawlStopReason = (typeof CRAWL_STOP_REASONS)[number];

export const CRAWL_STOP_REASON_PRESENT: Record<CrawlStopReason, true> = {
  CONVERGED: true,
  PAGE_BUDGET: true,
  WALL_CLOCK: true,
  ABORTED: true,
};

export interface SchedulerOptions<T> {
  frontier: CrawlFrontier;
  visit: CrawlVisitor<T>;
  /** Concurrent visits to ONE origin. Lower than `workers` for a shared host. */
  perOriginLimit?: number;
  /** Minimum gap between two starts against the same origin. */
  politenessMillis?: number;
  /** Injected so a test does not wait in real time. */
  now?: () => number;
  sleep?: (millis: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

export interface CrawlSchedule<T> {
  /**
   * The visits, in BFS order — NOT completion order.
   *
   * This is the whole reason the scheduler is its own function. Version diffing
   * is a shipped feature, and a parallel crawl that emitted nodes in completion
   * order would produce a different graph on every run over the same
   * application: every node id shifts, and the diff shows the app as rewritten.
   */
  results: Array<{ entry: FrontierEntry; value: T }>;
  unreachable: Array<{ entry: FrontierEntry; reason: string }>;
  stoppedBecause: CrawlStopReason;
  /** The sentence for the report. Never "converged" when it merely stopped. */
  why: string;
  account: KnownUnknownAccount;
}

export const DEFAULT_PER_ORIGIN_LIMIT = 4;
export const DEFAULT_POLITENESS_MILLIS = 0;

interface Settled<T> {
  id: number;
  worker: number;
  entry: FrontierEntry;
  result: VisitResult<T> | { kind: 'THREW'; reason: string };
}

/**
 * N workers pulling from the frontier, with a per-origin concurrency limit and
 * a politeness delay, producing a deterministically ordered result.
 *
 * It starts no browsers and knows nothing about one: `visit` is injected. That
 * is what makes it testable at all, and the lesson is from crawler.ts, where
 * the traversal and the browser driving are one 200-line function and have
 * almost no tests as a direct consequence.
 */
export async function scheduleCrawl<T>(options: SchedulerOptions<T>): Promise<CrawlSchedule<T>> {
  const { frontier, visit } = options;
  const limits = frontier.limits;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((millis: number) => new Promise<void>((resolve) => setTimeout(resolve, millis)));
  const perOriginLimit = Math.max(1, options.perOriginLimit ?? DEFAULT_PER_ORIGIN_LIMIT);
  const politeness = Math.max(0, options.politenessMillis ?? DEFAULT_POLITENESS_MILLIS);
  const progress = options.onProgress ?? (() => {});

  const deadline = now() + limits.wallClockMillis;
  const results: Array<{ entry: FrontierEntry; value: T }> = [];
  const unreachable: Array<{ entry: FrontierEntry; reason: string }> = [];
  const inFlightByOrigin = new Map<string, number>();
  const nextAllowedByOrigin = new Map<string, number>();
  const active = new Map<number, Promise<Settled<T>>>();
  const freeWorkers: number[] = [];
  for (let worker = Math.max(1, limits.workers) - 1; worker >= 0; worker -= 1) {
    freeWorkers.push(worker);
  }

  let stop: CrawlStopReason | null = null;
  let abortReason: string | null = null;
  let nextId = 0;
  /** Earliest moment a politeness-blocked entry could start. */
  let waitUntil: number | null = null;

  const originOf = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  };

  const startable = (entry: FrontierEntry): boolean => {
    const origin = originOf(entry.url);
    if ((inFlightByOrigin.get(origin) ?? 0) >= perOriginLimit) return false;
    const allowed = nextAllowedByOrigin.get(origin) ?? 0;
    if (allowed > now()) {
      waitUntil = waitUntil === null ? allowed : Math.min(waitUntil, allowed);
      return false;
    }
    return true;
  };

  for (;;) {
    if (stop === null) {
      if (now() >= deadline) stop = 'WALL_CLOCK';
      else if (frontier.visitedCount >= limits.pageBudget) stop = 'PAGE_BUDGET';
    }

    let started = 0;
    waitUntil = null;
    while (
      stop === null &&
      freeWorkers.length > 0 &&
      // Never start more visits than the budget allows to finish: a page
      // visited past the budget is a page the budget did not actually bound.
      frontier.visitedCount + active.size < limits.pageBudget
    ) {
      const entry = frontier.take(startable);
      if (entry === null) break;
      const worker = freeWorkers.shift();
      if (worker === undefined) {
        frontier.requeue(entry);
        break;
      }
      const origin = originOf(entry.url);
      inFlightByOrigin.set(origin, (inFlightByOrigin.get(origin) ?? 0) + 1);
      nextAllowedByOrigin.set(origin, now() + politeness);
      const id = nextId++;
      progress(`Visiting ${entry.url} (depth ${entry.depth}, worker ${worker})`);
      active.set(
        id,
        visit(entry, { worker, visited: frontier.visitedCount }).then(
          (result): Settled<T> => ({ id, worker, entry, result }),
          (error: unknown): Settled<T> => ({
            id,
            worker,
            entry,
            result: {
              kind: 'THREW' as const,
              reason: error instanceof Error ? error.message : String(error),
            },
          }),
        ),
      );
      started += 1;
    }

    if (active.size === 0) {
      if (stop !== null) break;
      if (started > 0) continue;
      if (waitUntil === null || frontier.pendingCount === 0) {
        stop = 'CONVERGED';
        break;
      }
      // Everything queued is waiting out a politeness delay. Sleep exactly as
      // long as the nearest one needs, never past the wall clock.
      await sleep(Math.max(0, Math.min(waitUntil, deadline) - now()));
      continue;
    }

    const settled = await Promise.race(active.values());
    active.delete(settled.id);
    freeWorkers.push(settled.worker);
    const origin = originOf(settled.entry.url);
    inFlightByOrigin.set(origin, Math.max(0, (inFlightByOrigin.get(origin) ?? 1) - 1));

    const result = settled.result;
    if (result.kind === 'THREW' || result.kind === 'UNREACHABLE') {
      // A visitor that throws is a failed navigation, not a missing page.
      frontier.markUnreachable(settled.entry);
      unreachable.push({ entry: settled.entry, reason: result.reason });
      continue;
    }
    if (result.kind === 'ABORT') {
      stop = 'ABORTED';
      abortReason = result.reason;
      // Back in the queue: it was never visited, so it is still unvisited
      // surface and belongs in the lower bound.
      frontier.requeue(settled.entry);
      continue;
    }

    frontier.markVisited(settled.entry, result.finalRoutePath);
    results.push({ entry: settled.entry, value: result.value });
    /*
     * Offers are accepted even after `stop` is set, and that is deliberate: a
     * link found on the last page before the budget bit is a known in-scope URL
     * we did not visit, which is exactly what the lower bound is for. Dropping
     * it would make the cap look cheaper than it was.
     */
    for (const candidate of result.discovered ?? []) frontier.offer(candidate, settled.entry);
  }

  /*
   * The terminal cap is claimed AFTER the loop, not when `stop` was set, so its
   * `discarded` counts the queue as it finally stood — including the links the
   * in-flight visits were still adding when the budget bit.
   */
  if (stop === 'PAGE_BUDGET' || stop === 'WALL_CLOCK') frontier.noteTerminalCap(stop);

  // Deterministic, whatever order the visits finished in.
  results.sort((left, right) => compareFrontierEntries(left.entry, right.entry));
  unreachable.sort((left, right) => compareFrontierEntries(left.entry, right.entry));

  const account = frontier.account();
  const stoppedBecause = stop ?? 'CONVERGED';
  return {
    results,
    unreachable,
    stoppedBecause,
    why: stopSentence(stoppedBecause, account, abortReason, frontier.visitedCount),
    account,
  };
}

/**
 * The sentence the report prints.
 *
 * "Converged" is only ever claimed when the lower bound is zero AND no cap
 * discarded anything. It is the most tempting false sentence available to this
 * feature — it is what every cap makes a crawl look like from the inside — so
 * the claim is checked against the ACCOUNT rather than against the loop's exit.
 */
function stopSentence(
  stop: CrawlStopReason,
  account: KnownUnknownAccount,
  abortReason: string | null,
  visited: number,
): string {
  const bit = account.caps.filter((cap) => cap.bites > 0);
  const named = bit.map((cap) => `${CRAWL_CAP_LABELS[cap.cap]} (${cap.discarded} discarded)`);
  if (stop === 'CONVERGED' && account.atLeastMoreUrls === 0 && bit.length === 0) {
    return `visited ${visited} page(s); the queue emptied with nothing in scope left and no cap applied`;
  }
  const head =
    stop === 'ABORTED'
      ? `the crawl was stopped: ${abortReason ?? 'no reason given'}`
      : stop === 'CONVERGED'
        ? 'the queue emptied, but a cap had already discarded URLs — this is not convergence'
        : `the crawl stopped at ${CRAWL_CAP_LABELS[stop]}`;
  return (
    `${head}; visited ${visited} page(s); at least ${account.atLeastMoreUrls} more in-scope ` +
    `URL(s) were known and not visited` +
    (named.length > 0 ? `; caps that applied: ${named.join(', ')}` : '') +
    (account.excluded.length > 0 ? `; ${account.excluded.length} URL(s) were refused` : '')
  );
}

/** A human-readable summary of the refusal ledger, for the report's caveats. */
export function refusalSummary(excluded: readonly ExcludedPath[]): string[] {
  const byKind = new Map<ExclusionKind, number>();
  for (const entry of excluded) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
  return [...byKind.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([kind, count]) => `${count} URL(s) ${EXCLUSION_KIND_LABELS[kind]}`);
}
