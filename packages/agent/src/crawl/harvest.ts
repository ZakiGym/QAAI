/**
 * Harvest — everything that widens the frontier WITHOUT clicking anything.
 *
 * THE DEFECT THIS FIXES: `packages/agent/src/crawler.ts` queues `a[href]` and
 * nothing else. So a GET search form, an `<area>` in an image map, a
 * `<link rel="next">` pagination chain, a `<meta http-equiv="refresh">`, a
 * `data-url` on a table row, a `role="link"` div, an `<iframe src>` and a
 * `Link:` response header are all invisible to enumeration — and the sitemap,
 * which is the cheapest complete route list in existence and which the
 * application publishes on purpose, is never read at all. A hash-routed SPA
 * enumerates as exactly one node, because the queue does `target.hash = ''`.
 *
 * None of that needs a click, a browser automation trick or a model. It is
 * string work over a document and a fetched text body, which is why this module
 * is pure: `harvestDocument` takes a {@link DocumentSnapshot} — one
 * `page.evaluate` worth of facts — and `seedFromRobotsAndSitemaps` takes a
 * {@link HarvestFetcher}. Nothing here opens a socket or holds a Page, so every
 * behaviour below is driven by a literal in `harvest.test.ts` rather than by a
 * browser the unit suite has no way to run. The 629 lines of crawler.ts that
 * have almost no tests are what the other shape costs.
 *
 * ─── The four honesty rules this file is built around ────────────────────────
 *
 * 1. A REFUSED URL IS NOT AN ABSENT URL. Every discovery carries `admitted`,
 *    `rule` and `refusal`, and `rule` is never empty — a URL that was dropped
 *    can always be traced to one line of one policy a human wrote. Today
 *    `/logout` and friends vanish with no record at all, so a route we refused
 *    is indistinguishable from a route the app does not serve.
 *
 * 2. AN ASSET IS NOT A ROUTE. `srcset`, `<script src>` and a `rel=stylesheet`
 *    are URLs, and putting them in the route denominator would inflate it with
 *    files no test can meaningfully cover. {@link NAVIGABILITY} makes a new
 *    discovery kind declare which it is, at the compiler, before it can ship.
 *
 * 3. EVERY CAP THAT BIT IS DISCLOSED AS A COUNT AND A REASON. A silently
 *    truncated harvest makes the coverage percentage go UP, which is the one
 *    direction this product may never be wrong in.
 *
 * 4. UNREADABLE IS NOT EMPTY. A closed shadow root, a document whose response
 *    headers the adapter cannot see, a `.xml.gz` nothing decompressed — each
 *    reports UNAVAILABLE with `found: null`, never MEASURED with `found: 0`.
 *    See {@link HarvestAxisState}.
 */

import {
  policyDecision,
  type CapBite,
  type CrawlCap,
  type CrawlPolicy,
  type ExclusionKind,
  type ExcludedPath,
  type ExternalBoundary,
  type ExternalKind,
} from '@qaai/shared';

// ─── 1. URL identity ─────────────────────────────────────────────────────────

/**
 * How a fragment is treated when deciding whether two URLs are one page.
 *
 * AUTO is the default and the only one that fixes the defect: crawler.ts sets
 * `target.hash = ''` unconditionally, so `#/orders`, `#/settings` and
 * `#/reports` are all the base URL and a hash-routed application enumerates as
 * one node with one route. Dropping a plain `#section` anchor is right —
 * it is the same page scrolled — and dropping `#/orders` is a whole app.
 *
 * The heuristic is "a fragment containing a slash is a route". It is wrong in
 * two directions and both are stated rather than hidden: a router using
 * `#orders` with no slash reads as an anchor (we under-enumerate, which is the
 * safe direction), and a documentation anchor like `#api/create` reads as a
 * route (we mint one extra node, visibly, with its evidence attached).
 * ROUTE and IGNORE exist so a project that knows which it is can say so.
 *
 * ─── A FORK, NAMED ────────────────────────────────────────────────────────────
 * `./frontier.ts` declares `HASH_ROUTING_MODES` with these same three values
 * and its own, STRICTER, AUTO rule: a fragment is a route only when it starts
 * with `/`. Two lists of three strings is the fork this codebase is explicit
 * about hating; there are two because both modules landed in the same round
 * under disjoint file ownership, and the values are spelled identically here so
 * one setting can drive both and the collapse is a one-line import. The
 * integration note says which call wins: the frontier owns NODE IDENTITY, so a
 * fragment this module keeps and the frontier collapses is collapsed. Keeping
 * the broader rule here is deliberate — `#!/orders` is a real router form that
 * the stricter rule misses, and offering a URL the frontier then merges costs
 * nothing, while never offering it loses the application.
 */
export const HARVEST_HASH_MODES = ['AUTO', 'ROUTE', 'IGNORE'] as const;
export type HarvestHashMode = (typeof HARVEST_HASH_MODES)[number];

/** One URL, resolved and split into the parts a crawl decides with. */
export interface ResolvedUrl {
  /**
   * The URL to navigate to: absolute, ignored query parameters stripped,
   * remaining parameters in their original order, hash route kept.
   */
  url: string;
  /**
   * The IDENTITY. Same as `url` with the remaining query parameters SORTED, so
   * `?a=1&b=2` and `?b=2&a=1` are one node instead of two. Sorted for identity
   * only and never navigated to, because a server that cares about parameter
   * order is rare and a crawl that reorders what it visits is a crawl visiting
   * something the application never linked.
   */
  identity: string;
  origin: string;
  /** Pathname, which is what the policy's globs are matched against. */
  path: string;
  /** The fragment, when it was KEPT as part of the identity. Never ''. */
  routeFragment: string | null;
  /**
   * A fragment that was dropped as a plain anchor. Recorded because dropping a
   * fragment is exactly how a hash-routed SPA came to enumerate as one node,
   * and a reader deserves to see that a drop happened.
   */
  droppedFragment: string | null;
  /** Query parameters the policy removed, named so the strip is auditable. */
  strippedParams: string[];
}

/** True when a fragment looks like a client-side route rather than an anchor. */
export function fragmentIsRoute(fragment: string, mode: HarvestHashMode): boolean {
  const body = fragment.replace(/^#/, '');
  if (body === '') return false;
  if (mode === 'IGNORE') return false;
  if (mode === 'ROUTE') return true;
  // `#!/x` is the old Googlebot-era form and still in the wild.
  return body.startsWith('/') || body.startsWith('!/') || body.includes('/');
}

/**
 * Resolves a raw URL against a base and reduces it to an identity.
 *
 * Returns null — not a guess — for anything that does not parse. A caller that
 * wants the unparseable ones counted records them from its own loop; inventing
 * a URL here so the list looks complete is the flattering kind of lie.
 */
export function resolveDiscoveredUrl(
  raw: string,
  base: string,
  policy: CrawlPolicy,
  options: { hashRouting?: HarvestHashMode } = {},
): ResolvedUrl | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, base);
  } catch {
    return null;
  }

  const strippedParams: string[] = [];
  for (const name of [...parsed.searchParams.keys()]) {
    if (policy.ignoredQueryParams.includes(name)) {
      strippedParams.push(name);
      parsed.searchParams.delete(name);
    }
  }

  const rawFragment = parsed.hash;
  const keepFragment =
    rawFragment !== '' && fragmentIsRoute(rawFragment, options.hashRouting ?? 'AUTO');
  const routeFragment = keepFragment ? rawFragment : null;
  const droppedFragment = !keepFragment && rawFragment !== '' ? rawFragment : null;
  parsed.hash = keepFragment ? rawFragment : '';

  const url = parsed.toString();

  const sorted = new URL(url);
  const entries = [...sorted.searchParams.entries()].sort((left, right) =>
    left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0]),
  );
  // Rebuilt rather than sorted in place: URLSearchParams.sort() is stable but
  // only by key, so two values of one repeated key keep an arbitrary order and
  // the identity would depend on document order after all.
  const rebuilt = new URLSearchParams();
  for (const [key, value] of entries) rebuilt.append(key, value);
  sorted.search = rebuilt.toString() === '' ? '' : `?${rebuilt.toString()}`;

  return {
    url,
    identity: sorted.toString(),
    origin: parsed.origin,
    path: parsed.pathname,
    routeFragment,
    droppedFragment,
    strippedParams,
  };
}

// ─── 2. Scope: same origin, same site, somebody else's ───────────────────────

/**
 * Where a discovered URL sits relative to the application under test.
 *
 * Five answers and not two, because the three that are usually collapsed into
 * "external" have different remedies. OFF_ORIGIN is somebody else's software
 * and must never enter our denominator — a third-party IdP's login page counted
 * as our route produces a recommended test the customer cannot write.
 * SAME_SITE is the ambiguous one: `auth.example.com` from `www.example.com` is
 * usually the same application and sometimes a different product, and the only
 * honest treatment is to NAME it and let a human declare it.
 */
export const URL_SCOPES = [
  /** Origin-equal to the base URL, or a declared `additionalOrigins` entry. */
  'SAME_ORIGIN',
  /** Same registrable domain, different host, port or scheme. */
  'SAME_SITE',
  /** A different registrable domain. */
  'OFF_ORIGIN',
  /** mailto:, tel:, javascript:, data:, blob: — not a page in any sense. */
  'NON_HTTP',
  /** It did not resolve. We know a string was there and nothing else. */
  'UNPARSEABLE',
] as const;
export type UrlScope = (typeof URL_SCOPES)[number];

export const URL_SCOPE_LABELS: Record<UrlScope, string> = {
  SAME_ORIGIN: 'the application’s own origin',
  SAME_SITE: 'the same registrable domain, a different origin',
  OFF_ORIGIN: 'a different site',
  NON_HTTP: 'not an http(s) URL',
  UNPARSEABLE: 'could not be resolved',
};

/**
 * The registrable domain of a host, and HOW SURE we are.
 *
 * `basis` is the field that keeps this honest. Shipping a public-suffix list is
 * not an option — it is 15,000 lines that go stale, and vendoring it here would
 * make "is this the same site" depend on how old this build is — so the table
 * below is small, deliberate and incomplete. Being incomplete is fine; being
 * incomplete and silent is not, which is why every answer says whether the
 * suffix was looked up or assumed, and why an ASSUMED answer is never allowed
 * to widen a crawl. See {@link classifyScope}.
 */
export interface RegistrableDomain {
  /** `example.co.uk`. Null when the host has no registrable domain. */
  domain: string | null;
  /** The suffix used: `co.uk`, `com`, `vercel.app`. */
  suffix: string | null;
  /**
   * EXACT    the suffix is in the table below.
   * ASSUMED  the TLD is not in the table; "last two labels" was assumed.
   * NONE     an IP address, a single-label host, or a host that IS a suffix.
   *          There is no registrable domain, so SAME_SITE cannot be claimed.
   */
  basis: 'EXACT' | 'ASSUMED' | 'NONE';
  host: string;
}

/**
 * Multi-label public suffixes, ICANN and private, as one set.
 *
 * The private entries are not padding — they are the ones that matter most to a
 * tool whose customers deploy previews. Without `vercel.app` in here,
 * `our-app.vercel.app` and `some-other-tenant.vercel.app` share the
 * registrable domain `vercel.app` and read as THE SAME SITE, so a crawl of a
 * preview deployment would classify an unrelated customer's preview as part of
 * the application under test. The same holds for `github.io`, `pages.dev`,
 * `herokuapp.com` and the rest: a platform's hosting domain is a public suffix
 * in practice whatever a two-label rule says.
 */
const MULTI_LABEL_SUFFIXES = new Set<string>([
  // United Kingdom
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'net.uk',
  'sch.uk',
  'ltd.uk',
  'plc.uk',
  // Australia / New Zealand
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'asn.au',
  'id.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'govt.nz',
  'ac.nz',
  // Europe / Americas / Asia, the commercial second levels
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'com.mx',
  'com.ar',
  'com.co',
  'com.pe',
  'co.za',
  'org.za',
  'net.za',
  'gov.za',
  'ac.za',
  'co.jp',
  'or.jp',
  'ne.jp',
  'ac.jp',
  'go.jp',
  'co.kr',
  'or.kr',
  'ne.kr',
  'co.in',
  'net.in',
  'org.in',
  'gov.in',
  'ac.in',
  'com.sg',
  'com.my',
  'com.ph',
  'com.hk',
  'com.tw',
  'com.cn',
  'com.tr',
  'com.ua',
  'com.pl',
  'com.es',
  'com.pt',
  'co.il',
  'co.id',
  'co.th',
  'com.sa',
  'com.ng',
  'com.pk',
  // Private suffixes: platform hosting domains. See the note above.
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'herokuapp.com',
  'azurewebsites.net',
  'cloudfront.net',
  'appspot.com',
  'firebaseapp.com',
  'web.app',
  'onrender.com',
  'fly.dev',
  'railway.app',
  'repl.co',
  'surge.sh',
  'ngrok.io',
  'ngrok-free.app',
  'trycloudflare.com',
  's3.amazonaws.com',
  'elasticbeanstalk.com',
]);

/**
 * Single-label suffixes we recognise. Partial ON PURPOSE: an unrecognised TLD
 * yields `basis: 'ASSUMED'` rather than a wrong EXACT, and ASSUMED is treated
 * conservatively everywhere it is read.
 */
const KNOWN_TLDS = new Set<string>([
  'com',
  'net',
  'org',
  'edu',
  'gov',
  'mil',
  'int',
  'io',
  'dev',
  'app',
  'co',
  'ai',
  'me',
  'info',
  'biz',
  'tv',
  'cc',
  'xyz',
  'tech',
  'cloud',
  'online',
  'site',
  'store',
  'shop',
  'blog',
  'page',
  'link',
  'live',
  'news',
  'world',
  'life',
  'fun',
  'space',
  'agency',
  'studio',
  'design',
  'digital',
  'software',
  'systems',
  'solutions',
  'network',
  'host',
  'email',
  'us',
  'uk',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'se',
  'no',
  'dk',
  'fi',
  'pl',
  'ru',
  'jp',
  'cn',
  'in',
  'br',
  'au',
  'ca',
  'mx',
  'ch',
  'at',
  'be',
  'cz',
  'pt',
  'gr',
  'ie',
  'nz',
  'za',
  'kr',
  'sg',
  'hk',
  'tw',
  'tr',
  'il',
  'ae',
  'sa',
  'ua',
  'ro',
  'hu',
  'bg',
  'hr',
  'si',
  'sk',
  'lt',
  'lv',
  'ee',
  'is',
  'lu',
  'mt',
  'cy',
  'id',
  'th',
  'vn',
  'ph',
  'my',
  'ng',
  'ke',
  'cl',
  'ar',
  'pe',
  'uy',
  'ec',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The registrable domain of a host, conservatively.
 *
 * Order matters: a three-label suffix is tested before a two-label one, so
 * `s3.amazonaws.com` is not mistaken for `amazonaws.com`, and a multi-label
 * suffix before a bare TLD, so `example.co.uk` does not reduce to `co.uk`.
 */
export function registrableDomain(host: string): RegistrableDomain {
  const normalised = host.toLowerCase().replace(/\.$/, '');
  if (normalised === '') return { domain: null, suffix: null, basis: 'NONE', host: normalised };
  // An IP literal or a bracketed IPv6 address has no registrable domain, so two
  // different addresses are never "the same site" — the alternative is that
  // 10.0.0.1 and 10.0.0.2 read as one application.
  if (IPV4.test(normalised) || normalised.startsWith('[') || normalised.includes(':')) {
    return { domain: null, suffix: null, basis: 'NONE', host: normalised };
  }

  const labels = normalised.split('.');
  if (labels.length < 2) {
    // `localhost`, or an intranet single label. No registrable domain, so
    // SAME_SITE is not available — which is correct: `localhost:3000` and
    // `localhost:4000` can be two different applications on one machine.
    return { domain: null, suffix: null, basis: 'NONE', host: normalised };
  }

  for (const size of [3, 2]) {
    if (labels.length < size) continue;
    const suffix = labels.slice(-size).join('.');
    if (!MULTI_LABEL_SUFFIXES.has(suffix)) continue;
    if (labels.length === size) {
      // The host IS the public suffix. `co.uk` is not a site.
      return { domain: null, suffix, basis: 'NONE', host: normalised };
    }
    return {
      domain: labels.slice(-(size + 1)).join('.'),
      suffix,
      basis: 'EXACT',
      host: normalised,
    };
  }

  const tld = labels[labels.length - 1]!;
  return {
    domain: labels.slice(-2).join('.'),
    suffix: tld,
    basis: KNOWN_TLDS.has(tld) ? 'EXACT' : 'ASSUMED',
    host: normalised,
  };
}

/** The scope decision, with the rule that made it and the refusal to record. */
export interface ScopeDecision {
  scope: UrlScope;
  /** The sentence a report prints. Never empty, including when admitted. */
  rule: string;
  /** Whether a crawl may queue it. ONLY SAME_ORIGIN is ever admitted. */
  admitted: boolean;
  /** The ledger kind for a refusal. Null exactly when `admitted`. */
  refusal: ExclusionKind | null;
  origin: string | null;
  site: RegistrableDomain | null;
}

const HTTP_SCHEMES = new Set(['http:', 'https:']);

/**
 * Classifies a URL against the application's own origin.
 *
 * SAME_SITE IS NOT ADMITTED, and that is the conservative answer the register
 * item asks for. `auth.example.com` is often part of the application and
 * sometimes a different product on a shared domain; crawling it on a guess
 * means enumerating software the customer did not ask us to measure, and
 * skipping it silently means losing their login. So it is refused WITH A RULE
 * that names the remedy — add it to `additionalOrigins` — and it appears in the
 * boundary inventory as a finding rather than as a gap.
 *
 * An ASSUMED registrable domain never widens anything either: `basis` is
 * carried through to the inventory so the report can say which same-site
 * judgements rest on a two-label guess.
 */
export function classifyScope(
  baseUrl: string,
  candidate: string,
  policy: CrawlPolicy,
): ScopeDecision {
  let theirs: URL;
  try {
    theirs = new URL(candidate);
  } catch {
    return {
      scope: 'UNPARSEABLE',
      rule: 'could not be resolved to an absolute URL',
      admitted: false,
      refusal: 'UNSUPPORTED_SCHEME',
      origin: null,
      site: null,
    };
  }

  if (!HTTP_SCHEMES.has(theirs.protocol)) {
    return {
      scope: 'NON_HTTP',
      rule: `scheme ${theirs.protocol} is not a page`,
      admitted: false,
      refusal: 'UNSUPPORTED_SCHEME',
      origin: null,
      site: null,
    };
  }

  let ours: URL;
  try {
    ours = new URL(baseUrl);
  } catch {
    return {
      scope: 'UNPARSEABLE',
      rule: 'the base URL did not parse, so nothing can be compared to it',
      admitted: false,
      refusal: 'OFF_ORIGIN',
      origin: theirs.origin,
      site: registrableDomain(theirs.hostname),
    };
  }

  const site = registrableDomain(theirs.hostname);

  if (theirs.origin === ours.origin) {
    return {
      scope: 'SAME_ORIGIN',
      rule: 'the application’s own origin',
      admitted: true,
      refusal: null,
      origin: theirs.origin,
      site,
    };
  }

  /*
   * Origin equality — scheme, host AND port — never a suffix test, for the
   * reason `isOwnOrigin` in @qaai/shared states: `evil-example.com` ends with
   * `example.com`. The same list is consulted here rather than calling
   * isOwnOrigin, because this function has to report WHICH additional origin
   * matched and a boolean cannot.
   */
  for (const declared of policy.additionalOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(declared);
    } catch {
      continue;
    }
    if (parsed.origin !== theirs.origin) continue;
    return {
      scope: 'SAME_ORIGIN',
      rule: `additionalOrigins: ${parsed.origin}`,
      admitted: true,
      refusal: null,
      origin: theirs.origin,
      site,
    };
  }

  const oursSite = registrableDomain(ours.hostname);
  const sameSite =
    site.domain !== null && oursSite.domain !== null && site.domain === oursSite.domain;

  if (sameSite) {
    return {
      scope: 'SAME_SITE',
      rule:
        `same registrable domain (${site.domain}, suffix ${site.basis.toLowerCase()}) but a ` +
        `different origin; add ${theirs.origin} to additionalOrigins to enumerate it`,
      admitted: false,
      refusal: 'OFF_ORIGIN',
      origin: theirs.origin,
      site,
    };
  }

  return {
    scope: 'OFF_ORIGIN',
    rule: `a different site (${site.domain ?? theirs.hostname})`,
    admitted: false,
    refusal: 'OFF_ORIGIN',
    origin: theirs.origin,
    site,
  };
}

// ─── 3. Discovery kinds ──────────────────────────────────────────────────────

/**
 * How a URL was found. The provenance half of "your app has 412 routes".
 *
 * Every member except ANCHOR is a URL the crawl cannot see today. They are
 * listed separately rather than lumped into "link" because the remedy differs:
 * a `data-url` that is never followed is a missing route, a `script[src]` on a
 * CDN is a third-party origin, and a GET form is a URL TEMPLATE whose instances
 * were never enumerated at all. A report that cannot say which is which cannot
 * tell a customer what to do about it.
 */
export const DISCOVERY_KINDS = [
  'ANCHOR',
  'AREA',
  'GET_FORM',
  'POST_FORM',
  'LINK_REL',
  'LINK_HEADER',
  'META_REFRESH',
  'DATA_ATTRIBUTE',
  'ROLE_LINK',
  'FRAME',
  'ASSET',
  'SCRIPT_HOST',
  'BASE',
  'SITEMAP_URL',
  'SITEMAP_INDEX',
  'ROBOTS_SITEMAP',
  'REDIRECT',
] as const;
export type DiscoveryKind = (typeof DISCOVERY_KINDS)[number];

export const DISCOVERY_KIND_LABELS: Record<DiscoveryKind, string> = {
  ANCHOR: 'a[href]',
  AREA: 'area[href] in an image map',
  GET_FORM: 'a GET form — a URL template',
  POST_FORM: 'a POST form',
  LINK_REL: '<link rel>',
  LINK_HEADER: 'a Link: response header',
  META_REFRESH: '<meta http-equiv="refresh">',
  DATA_ATTRIBUTE: 'a data-href / data-url attribute',
  ROLE_LINK: 'an element with role="link"',
  FRAME: '<iframe src> / <frame src>',
  ASSET: 'an image, media or stylesheet URL',
  SCRIPT_HOST: '<script src>',
  BASE: '<base href>',
  SITEMAP_URL: 'a <loc> in a sitemap',
  SITEMAP_INDEX: 'a <loc> in a sitemap index',
  ROBOTS_SITEMAP: 'a Sitemap: line in robots.txt',
  REDIRECT: 'a redirect the transport followed',
};

/**
 * Whether a discovery kind yields a page, a file, or depends on its `rel`.
 *
 * A compiler-enforced record and not a function body, following the keystone
 * pattern in `packages/shared/src/surface.ts`: a new DISCOVERY_KINDS member
 * does not compile until somebody has decided which of the three it is. THE
 * DEFECT THIS PREVENTS is the worst one available in this slice — a new kind
 * that harvests asset URLs and is queued as routes puts `logo.svg` and
 * `app.a1b2c3.js` in the denominator, and a denominator padded with files the
 * suite can never cover is a coverage percentage that goes DOWN for a reason
 * nobody can explain, every time the bundler changes a hash.
 */
export const NAVIGABILITY = {
  ANCHOR: 'DOCUMENT',
  AREA: 'DOCUMENT',
  GET_FORM: 'DOCUMENT',
  // A POST form's action is surface and is not a GET target. Recorded, refused
  // under `safeMethodsOnly`, never queued.
  POST_FORM: 'ASSET',
  LINK_REL: 'BY_REL',
  LINK_HEADER: 'BY_REL',
  META_REFRESH: 'DOCUMENT',
  DATA_ATTRIBUTE: 'DOCUMENT',
  ROLE_LINK: 'DOCUMENT',
  // A same-origin frame is traversed as part of its PARENT node rather than
  // queued as a route of its own; see `harvestDocument`.
  FRAME: 'ASSET',
  ASSET: 'ASSET',
  SCRIPT_HOST: 'ASSET',
  BASE: 'ASSET',
  SITEMAP_URL: 'DOCUMENT',
  SITEMAP_INDEX: 'ASSET',
  ROBOTS_SITEMAP: 'ASSET',
  REDIRECT: 'DOCUMENT',
} as const satisfies Record<DiscoveryKind, 'DOCUMENT' | 'ASSET' | 'BY_REL'>;

/**
 * `rel` tokens that name another DOCUMENT, so a `<link>` or a `Link:` header
 * carrying one is a page to enumerate. `next` and `prev` are the pagination
 * chain — the single cheapest way to reach page 2 of a list without clicking —
 * and `canonical` is how a parameterised URL tells you its real identity.
 */
const NAVIGABLE_LINK_RELS = new Set([
  'next',
  'prev',
  'previous',
  'up',
  'canonical',
  'alternate',
  'index',
  'contents',
  'start',
  'first',
  'last',
  'home',
  'search',
  'author',
  'help',
  'license',
  'terms-of-service',
  'privacy-policy',
]);

/**
 * Whether this sighting is a page.
 *
 * An unknown `rel` is recorded and NOT navigated. `rel="modulepreload"` is a
 * file and `rel="payment"` is a page, and a crawl that guesses in the
 * permissive direction visits assets. The discovery still carries the rel in
 * its evidence, so an unknown rel that matters shows up in the report as
 * something to add to the list rather than disappearing.
 */
export function navigabilityOf(kind: DiscoveryKind, rel?: string | null): boolean {
  const declared = NAVIGABILITY[kind];
  if (declared === 'DOCUMENT') return true;
  if (declared === 'ASSET') return false;
  const tokens = (rel ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.some((token) => NAVIGABLE_LINK_RELS.has(token));
}

/**
 * The ExternalKind each discovery kind becomes in `FlowMap.externals`.
 *
 * Compiler-enforced, so a new discovery kind cannot reach the boundary
 * inventory without a decision. `null` means the shared vocabulary has no
 * member for it and the boundary is reported through `BoundaryInventory.
 * unmapped` rather than mis-filed — see the note on {@link mergeBoundaries}.
 *
 * ASSET is the imprecise one and it is imprecise on purpose: EXTERNAL_KINDS has
 * SCRIPT_HOST and no ASSET_HOST, so an image CDN is filed under SCRIPT_HOST.
 * That is a label being slightly wrong, which is recoverable; dropping the
 * origin so a CDN never appears in the inventory at all is not.
 */
export const DISCOVERY_AS_EXTERNAL_KIND = {
  ANCHOR: 'LINK',
  AREA: 'LINK',
  GET_FORM: 'FORM_ACTION',
  POST_FORM: 'FORM_ACTION',
  LINK_REL: 'LINK',
  LINK_HEADER: 'LINK',
  META_REFRESH: 'REDIRECT',
  DATA_ATTRIBUTE: 'LINK',
  ROLE_LINK: 'LINK',
  FRAME: 'IFRAME',
  ASSET: 'SCRIPT_HOST',
  SCRIPT_HOST: 'SCRIPT_HOST',
  BASE: 'LINK',
  SITEMAP_URL: 'LINK',
  SITEMAP_INDEX: 'LINK',
  ROBOTS_SITEMAP: 'LINK',
  REDIRECT: 'REDIRECT',
} as const satisfies Record<DiscoveryKind, ExternalKind | null>;

/** One discovered URL, with everything needed to defend or refuse it. */
export interface Discovery {
  /** The URL to navigate to. See {@link ResolvedUrl.url}. */
  url: string;
  /** The node identity. See {@link ResolvedUrl.identity}. */
  identity: string;
  kind: DiscoveryKind;
  scope: UrlScope;
  /** Normalised route, when `options.normaliseRoute` was supplied. */
  route: string | null;
  /** The in-app route the document was, so the inventory can say WHY. */
  fromRoute: string | null;
  /** Link text or accessible name, for the flow edge's action. */
  label: string | null;
  /**
   * The sentence that justifies the discovery, in the customer's terms:
   * `a[href] "Checkout"`, `meta http-equiv=refresh after 0s`,
   * `form method=get action=/search`. This is what makes the denominator
   * auditable rather than asserted.
   */
  evidence: string;
  /** False for a file. A false here keeps a URL out of the route denominator. */
  navigable: boolean;
  /** Whether a crawl may queue it: scope AND policy AND method all agree. */
  admitted: boolean;
  /**
   * The rule that decided, admitted or not. NEVER empty — a refusal with no
   * rule is the defect this module exists to remove.
   */
  rule: string;
  /**
   * The exclusion-ledger kind, when this URL was REFUSED.
   *
   * The invariant is one-directional on purpose: `admitted` implies
   * `refusal === null`, but a null refusal does NOT imply admitted. A
   * stylesheet was not refused by anybody — it is not a page, so it has a rule
   * ("a stylesheet is a file, not a page") and no ledger entry. Putting every
   * asset in the exclusion ledger would bury the refusals a customer can act
   * on under a thousand images.
   */
  refusal: ExclusionKind | null;
  /** The sub-document it was found in. Null = the top-level document. */
  container: string | null;
  /** A GET form's parameter names. A URL template, not a URL. */
  template: UrlTemplate | null;
  /** How many sightings merged into this one. See {@link dedupeDiscoveries}. */
  occurrences: number;
  /** Other kinds that found the same identity. */
  otherKinds: DiscoveryKind[];
  /** A fragment that was dropped as a plain anchor, when one was. */
  droppedFragment: string | null;
}

/**
 * A GET form, which is a URL TEMPLATE and not a URL.
 *
 * `/search?q=` is a route whose instances are unbounded. The template is the
 * honest artifact: it says "this URL shape exists and its instances were not
 * enumerated", which is a true sentence a crawl can produce without typing a
 * search term and without pretending the result page is covered.
 */
export interface UrlTemplate {
  /** The resolved action, with no query string. */
  action: string;
  /** Field names in document order — the parameters of the template. */
  params: string[];
  /** Values the markup already supplies: hidden inputs, a selected option. */
  fixed: Array<{ name: string; value: string }>;
  /**
   * An example built from `fixed` ONLY. Null when the markup supplies nothing,
   * because the alternative is inventing a query the application never served.
   */
  sample: string | null;
  method: 'GET' | 'POST';
}

// ─── 4. The document snapshot: the injected browser surface ──────────────────

/**
 * The CSS the adapter must query to produce `DocumentSnapshot.elements`.
 *
 * Exported so there is ONE list. The adapter's `page.evaluate` and this
 * module's expectations cannot drift apart if they come from the same constant,
 * and the failure mode they would otherwise have is the quiet one: a selector
 * removed from the adapter makes a whole discovery kind report zero findings
 * forever, and zero findings looks exactly like a page with no image maps.
 */
export const HARVEST_ELEMENT_SELECTOR = [
  'a[href]',
  'area[href]',
  'link[href]',
  'meta[http-equiv]',
  'base[href]',
  'iframe[src]',
  'frame[src]',
  'script[src]',
  'img[src]',
  'img[srcset]',
  'source[src]',
  'source[srcset]',
  '[data-href]',
  '[data-url]',
  '[role="link"]',
].join(', ');

/** One element, flattened to the attributes harvest reads. */
export interface ElementRecord {
  /** Lower-case tag name. */
  tag: string;
  /** Attributes with lower-case names, exactly as the markup spells them. */
  attrs: Record<string, string>;
  /** Trimmed text, for the edge label. */
  text?: string | null;
  /**
   * True when the element is NOT inside the application's root container — a
   * React/Vue portal mounted on `body`. Undefined means the adapter could not
   * tell, which is reported as UNAVAILABLE rather than as "no portals".
   */
  outsideAppRoot?: boolean;
  /** The `body > *` container the element sits in, for a portal's identity. */
  portalHost?: string | null;
}

export interface FormFieldRecord {
  name: string | null;
  tag: string;
  type?: string | null;
  /** The value the markup supplies, when it supplies one. */
  value?: string | null;
  checked?: boolean;
}

export interface FormRecord {
  /** The `action` attribute as written. Null means "this same URL". */
  action: string | null;
  /** The `method` attribute as written. Absent means GET, per HTML. */
  method?: string | null;
  fields: FormFieldRecord[];
  /** An accessible name for the form, for the evidence sentence. */
  label?: string | null;
}

/**
 * One `page.evaluate` worth of facts about a document.
 *
 * A SNAPSHOT and not a live Page, for the reason rule 8 of this slice states:
 * a module that holds a Page can only be tested with a browser, and the unit
 * suite has none. The data here is exactly what crosses the browser→Node
 * boundary anyway, so the adapter is one `evaluate` and every behaviour in this
 * file is driven by a literal.
 *
 * The three-state convention from `FormField`'s constraint capture applies to
 * every optional member: absent means the adapter cannot supply it (a
 * capability we have not got), null means it looked and there is nothing, and a
 * value is the fact. `headers: undefined` therefore reports the Link-header
 * axis as UNAVAILABLE, never as "this page declares no Link: header".
 */
export interface DocumentSnapshot {
  /** The document's own URL, absolute. Relative URLs resolve against it. */
  url: string;
  /**
   * The `<base href>` as written. Resolved against `url` here, so an adapter
   * that passes the raw attribute is correct.
   */
  baseHref?: string | null;
  elements: ElementRecord[];
  /**
   * The selector the adapter actually queried. Absent means
   * {@link HARVEST_ELEMENT_SELECTOR} — which is what the adapter is supposed to
   * pass — and anything narrower makes the axes it leaves out UNAVAILABLE
   * rather than zero. See {@link AXIS_SELECTORS}.
   */
  selector?: string | null;
  forms?: FormRecord[];
  /** Response headers, lower-case names. Absent = the adapter cannot read them. */
  headers?: Record<string, string> | null;
  /** The selector of the application root, for portal detection. */
  appRoot?: string | null;
  /** Open shadow roots and frames the adapter could read, or could not. */
  subDocuments?: SubDocumentSnapshot[];
  /** The URL the transport ended at, when it followed a redirect. */
  finalUrl?: string | null;
}

export const SUB_DOCUMENT_KINDS = ['IFRAME', 'FRAME', 'SHADOW_ROOT', 'PORTAL'] as const;
export type SubDocumentKind = (typeof SUB_DOCUMENT_KINDS)[number];

/**
 * Why a sub-document could not be read.
 *
 * CROSS_ORIGIN is the one that must never be counted with the others. A
 * cross-origin iframe is SOMEBODY ELSE'S APPLICATION: not reading it is
 * correct, it is not a gap in our measurement, and it belongs in the boundary
 * inventory. Every other member here IS a gap in the application's own surface
 * — a closed shadow root is the customer's checkout form that we could not
 * look inside — and reporting it as "no affordances found" would be the lie
 * this file is built to prevent.
 */
export const SUB_DOCUMENT_UNAVAILABILITIES = [
  'CROSS_ORIGIN',
  'CLOSED_SHADOW_ROOT',
  'SANDBOXED',
  'DETACHED',
  'NOT_SUPPLIED',
  'DEPTH_CAP',
  'BUDGET_CAP',
] as const;
export type SubDocumentUnavailability = (typeof SUB_DOCUMENT_UNAVAILABILITIES)[number];

export const SUB_DOCUMENT_UNAVAILABILITY_LABELS: Record<SubDocumentUnavailability, string> = {
  CROSS_ORIGIN: 'a different origin — somebody else’s application, not ours to read',
  CLOSED_SHADOW_ROOT: 'a closed shadow root — the page does not expose its contents',
  SANDBOXED: 'sandboxed without allow-same-origin',
  DETACHED: 'the frame went away before it could be read',
  NOT_SUPPLIED: 'the adapter did not supply it',
  DEPTH_CAP: 'past the sub-document depth limit',
  BUDGET_CAP: 'past the sub-document budget',
};

/** The app's OWN surface we could not read. CROSS_ORIGIN is not ours. */
const APP_SURFACE_UNAVAILABILITIES: readonly SubDocumentUnavailability[] = [
  'CLOSED_SHADOW_ROOT',
  'SANDBOXED',
  'DETACHED',
  'NOT_SUPPLIED',
  'DEPTH_CAP',
  'BUDGET_CAP',
];

export interface SubDocumentSnapshot {
  /** `iframe[1]`, `checkout-widget::shadow`, `portal(#modal-root)`. */
  path: string;
  kind: SubDocumentKind;
  /** The frame's URL, for an IFRAME or FRAME. */
  url?: string | null;
  /** The document, when it could be read. */
  document?: DocumentSnapshot | null;
  /** Why not. Null when `document` is present. */
  unavailable?: SubDocumentUnavailability | null;
}

/** What happened to one sub-document, entered or refused. */
export interface SubDocumentReport {
  path: string;
  kind: SubDocumentKind;
  url: string | null;
  scope: UrlScope | null;
  entered: boolean;
  unavailable: SubDocumentUnavailability | null;
  /** How many discoveries came out of it. Null when it was not entered. */
  discoveries: number | null;
  /** How many forms it contributed. Null when it was not entered. */
  forms: number | null;
  /** True when this is a gap in the APP's surface rather than a boundary. */
  unreadAppSurface: boolean;
}

/** A portal: a region of the document mounted outside the application root. */
export interface PortalRegion {
  /** The `body > *` container: `#modal-root`, `div[data-portal]`. */
  host: string;
  /** How many harvestable elements sit inside it. */
  elements: number;
}

// ─── 5. Caps, disclosed ──────────────────────────────────────────────────────

/**
 * Every limit this module can apply.
 *
 * Separate from `CRAWL_CAPS` because three of them have no member there and
 * @qaai/shared is not this agent's file. `HARVEST_CAP_AS_CRAWL_CAP` maps the
 * ones that do have a home and names the ones that do not, so
 * {@link toCapBites} can hand the integrator an explicit `unexpressible` list
 * instead of quietly losing a cap that bit. A cap that bit and was not reported
 * makes the coverage percentage go up, which is rule 9 of this slice.
 */
export const HARVEST_CAPS = [
  'LINKS_PER_DOCUMENT',
  'SUB_DOCUMENT_BUDGET',
  'SUB_DOCUMENT_DEPTH',
  'SITEMAP_URL_BUDGET',
  'SITEMAP_DOCUMENT_BUDGET',
  'SITEMAP_INDEX_DEPTH',
] as const;
export type HarvestCap = (typeof HARVEST_CAPS)[number];

export const HARVEST_CAP_LABELS: Record<HarvestCap, string> = {
  LINKS_PER_DOCUMENT: 'the per-document discovery limit',
  SUB_DOCUMENT_BUDGET: 'the sub-document budget',
  SUB_DOCUMENT_DEPTH: 'the sub-document depth limit',
  SITEMAP_URL_BUDGET: 'the sitemap URL budget',
  SITEMAP_DOCUMENT_BUDGET: 'the sitemap document budget',
  SITEMAP_INDEX_DEPTH: 'the sitemap index depth limit',
};

/**
 * Where each harvest cap lands in the shared vocabulary.
 *
 * Compiler-enforced, so a new harvest cap must declare whether it has a home.
 * The four nulls are not an oversight: `CRAWL_CAPS` has no member for a sitemap
 * budget or a sub-document limit, and inventing a mapping (filing a sitemap
 * budget under PAGE_BUDGET, say) would put a number in a field a reader
 * interprets as something else.
 */
export const HARVEST_CAP_AS_CRAWL_CAP = {
  LINKS_PER_DOCUMENT: 'LINKS_PER_PAGE',
  SUB_DOCUMENT_BUDGET: null,
  SUB_DOCUMENT_DEPTH: null,
  SITEMAP_URL_BUDGET: null,
  SITEMAP_DOCUMENT_BUDGET: null,
  SITEMAP_INDEX_DEPTH: null,
} as const satisfies Record<HarvestCap, CrawlCap | null>;

/** Structurally `CapBite`, with this module's own cap vocabulary. */
export interface HarvestCapBite {
  cap: HarvestCap;
  limit: number;
  bites: number;
  /** Candidates it discarded. A LOWER bound on what it cost. */
  discarded: number;
  scope: string | null;
  reason: string;
}

/**
 * Projects harvest cap bites onto the shared `CapBite` shape.
 *
 * Returns the ones it could not express rather than dropping them, and the
 * field is named so that losing them takes a deliberate act. The remedy is six
 * lines in `CRAWL_CAPS`; until they land, a caller prints `unexpressible`
 * beside the flow map's caps or the sitemap budget is a cap that bit in
 * silence.
 */
export function toCapBites(bites: readonly HarvestCapBite[]): {
  capBites: CapBite[];
  unexpressible: HarvestCapBite[];
} {
  const capBites: CapBite[] = [];
  const unexpressible: HarvestCapBite[] = [];
  for (const bite of bites) {
    const mapped = HARVEST_CAP_AS_CRAWL_CAP[bite.cap];
    if (mapped === null) {
      unexpressible.push(bite);
      continue;
    }
    capBites.push({
      cap: mapped,
      limit: bite.limit,
      bites: bite.bites,
      discarded: bite.discarded,
      scope: bite.scope,
      reason: bite.reason,
    });
  }
  return { capBites, unexpressible };
}

// ─── 6. Axis availability: measured, or not looked at ────────────────────────

/**
 * The harvest axes, each of which is separately measurable and separately
 * unavailable.
 *
 * The point of listing them is `found: null`. A document with no `<area>` and a
 * document whose image maps we never queried both produce an empty list, and
 * only one of them supports the sentence "this page has no image maps".
 */
export const HARVEST_AXES = [
  'ANCHORS',
  'AREA_MAPS',
  'FORMS',
  'LINK_REL',
  'META_REFRESH',
  'DATA_ATTRIBUTES',
  'ROLE_LINKS',
  'FRAMES',
  'ASSETS',
  'SCRIPT_HOSTS',
  'BASE_HREF',
  'LINK_HEADERS',
  'SUB_DOCUMENTS',
  'PORTALS',
] as const;
export type HarvestAxis = (typeof HARVEST_AXES)[number];

/**
 * The fragment of {@link HARVEST_ELEMENT_SELECTOR} each element-derived axis
 * depends on, so a snapshot taken with a NARROWER selector reports the axes it
 * could not have seen as UNAVAILABLE instead of as zero.
 *
 * Compiler-enforced, and the null entries are the axes that do not come from
 * the element list at all (forms, headers, sub-documents, portals have their
 * own availability signals). THE DEFECT THIS PREVENTS: an adapter that queries
 * `a[href], form` reports "this application declares no image maps, no
 * pagination links and no meta refreshes" for every page it ever visits, and
 * every one of those sentences is a measurement nobody took.
 */
export const AXIS_SELECTORS = {
  ANCHORS: 'a[href]',
  AREA_MAPS: 'area[href]',
  LINK_REL: 'link[href]',
  META_REFRESH: 'meta[http-equiv]',
  DATA_ATTRIBUTES: '[data-href]',
  ROLE_LINKS: '[role="link"]',
  FRAMES: 'iframe[src]',
  ASSETS: 'img[src]',
  SCRIPT_HOSTS: 'script[src]',
  BASE_HREF: 'base[href]',
  FORMS: null,
  LINK_HEADERS: null,
  SUB_DOCUMENTS: null,
  PORTALS: null,
} as const satisfies Record<HarvestAxis, string | null>;

export const HARVEST_AXIS_LABELS: Record<HarvestAxis, string> = {
  ANCHORS: 'anchors',
  AREA_MAPS: 'image-map areas',
  FORMS: 'forms',
  LINK_REL: '<link rel> elements',
  META_REFRESH: 'meta refreshes',
  DATA_ATTRIBUTES: 'data-href / data-url attributes',
  ROLE_LINKS: 'role="link" elements',
  FRAMES: 'frames',
  ASSETS: 'asset URLs',
  SCRIPT_HOSTS: 'script hosts',
  BASE_HREF: '<base href>',
  LINK_HEADERS: 'Link: response headers',
  SUB_DOCUMENTS: 'sub-documents',
  PORTALS: 'portals',
};

/**
 * One axis's result. `found` is null EXACTLY when `state` is UNAVAILABLE, and
 * `axisIsConsistent` asserts it so a writer that reports an unavailable axis as
 * zero fails a test rather than shipping a flattering number.
 */
export interface HarvestAxisState {
  state: 'MEASURED' | 'UNAVAILABLE';
  found: number | null;
  /** Required when UNAVAILABLE: what stopped us looking. */
  reason: string | null;
}

/** Whether an axis's own fields agree. See {@link HarvestAxisState}. */
export function axisIsConsistent(axis: HarvestAxisState): boolean {
  return axis.state === 'UNAVAILABLE'
    ? axis.found === null && axis.reason !== null
    : axis.found !== null;
}

function measured(found: number): HarvestAxisState {
  return { state: 'MEASURED', found, reason: null };
}

function unavailable(reason: string): HarvestAxisState {
  return { state: 'UNAVAILABLE', found: null, reason };
}

// ─── 7. Boundary inventory ───────────────────────────────────────────────────

/** One sighting of an origin that is not the application's own. */
export interface BoundaryObservation {
  origin: string;
  /** PATH only, never the query. See {@link ExternalBoundary.origin}. */
  path: string | null;
  scope: 'SAME_SITE' | 'OFF_ORIGIN';
  kind: DiscoveryKind;
  /** The in-app route that reached it — the WHY. */
  fromRoute: string | null;
  evidence: string;
  site: RegistrableDomain | null;
}

/** A same-site origin: possibly part of the app, never crawled on a guess. */
export interface SameSiteHost {
  origin: string;
  registrableDomain: string | null;
  /** EXACT / ASSUMED / NONE, so a report can show which calls are guesses. */
  suffixBasis: RegistrableDomain['basis'];
  reachedBy: DiscoveryKind[];
  fromRoutes: string[];
  samplePath: string | null;
  occurrences: number;
  /** The remedy sentence. The only way a customer learns this host exists. */
  advice: string;
}

export interface BoundaryInventory {
  /** `FlowMap.externals`, grouped by (origin, kind). */
  externals: ExternalBoundary[];
  /** Same-registrable-domain origins, named as findings rather than crawled. */
  sameSite: SameSiteHost[];
  /**
   * Observations whose discovery kind has no `ExternalKind`. Empty today and
   * kept so that adding a kind without a mapping surfaces here instead of
   * disappearing.
   */
  unmapped: BoundaryObservation[];
}

/**
 * Collapses sightings into the inventory `FlowMap.externals` stores.
 *
 * Grouped by (origin, kind) because the shared shape carries one kind per row,
 * and `samplePath` is a PATH: a redirect to an identity provider carries the
 * tenant, a login hint and a state token in its query string, and a flow map is
 * stored, exported and rendered in a cockpit. There is no version of this
 * product that needs those values, so they are dropped here and the drop is
 * asserted over the whole serialised inventory in the test file.
 */
export function mergeBoundaries(observations: readonly BoundaryObservation[]): BoundaryInventory {
  const external = new Map<string, ExternalBoundary>();
  const site = new Map<string, SameSiteHost>();
  const unmapped: BoundaryObservation[] = [];

  for (const observation of observations) {
    if (observation.scope === 'SAME_SITE') {
      const existing = site.get(observation.origin);
      if (existing) {
        existing.occurrences += 1;
        if (!existing.reachedBy.includes(observation.kind)) {
          existing.reachedBy.push(observation.kind);
        }
        if (observation.fromRoute && !existing.fromRoutes.includes(observation.fromRoute)) {
          existing.fromRoutes.push(observation.fromRoute);
        }
        continue;
      }
      site.set(observation.origin, {
        origin: observation.origin,
        registrableDomain: observation.site?.domain ?? null,
        suffixBasis: observation.site?.basis ?? 'NONE',
        reachedBy: [observation.kind],
        fromRoutes: observation.fromRoute ? [observation.fromRoute] : [],
        samplePath: observation.path,
        occurrences: 1,
        advice:
          `${observation.origin} shares the registrable domain ` +
          `${observation.site?.domain ?? 'unknown'} (suffix ` +
          `${(observation.site?.basis ?? 'NONE').toLowerCase()}). It was NOT enumerated; add it ` +
          `to the environment’s crawlPolicy.additionalOrigins if it is part of this application.`,
      });
      continue;
    }

    const kind = DISCOVERY_AS_EXTERNAL_KIND[observation.kind] as ExternalKind | null;
    if (kind === null) {
      unmapped.push(observation);
      continue;
    }
    const key = `${observation.origin}|${kind}`;
    const existing = external.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    external.set(key, {
      kind,
      origin: observation.origin,
      fromRoute: observation.fromRoute,
      samplePath: observation.path,
      occurrences: 1,
    });
  }

  return {
    externals: [...external.values()].sort((left, right) => right.occurrences - left.occurrences),
    sameSite: [...site.values()].sort((left, right) => right.occurrences - left.occurrences),
    unmapped,
  };
}

/**
 * The refused discoveries as `ExcludedPath` rows.
 *
 * Every refusal becomes a ledger entry; nothing is dropped. A URL refused with
 * no record is indistinguishable from a URL the application does not serve,
 * which is the whole reason this slice exists.
 */
export function toExcludedPaths(
  discoveries: readonly Discovery[],
  options: { normaliseRoute?: (pathname: string) => string } = {},
): ExcludedPath[] {
  const rows: ExcludedPath[] = [];
  for (const discovery of discoveries) {
    if (discovery.admitted) continue;
    if (discovery.refusal === null) continue;
    let route = discovery.route;
    if (route === null && options.normaliseRoute) {
      try {
        route = options.normaliseRoute(new URL(discovery.url).pathname);
      } catch {
        route = null;
      }
    }
    rows.push({
      url: discovery.url,
      route,
      kind: discovery.refusal,
      rule: discovery.rule,
      discoveredFrom: discovery.fromRoute,
    });
  }
  return rows;
}

// ─── 8. Harvesting a document ────────────────────────────────────────────────

export interface HarvestOptions {
  /** The application's own base URL. Scope is decided against it. */
  baseUrl: string;
  policy: CrawlPolicy;
  /** The route the harvested document is, for provenance. */
  fromRoute?: string | null;
  /**
   * Collapses `/orders/1001` → `/orders/:id`. INJECTED rather than imported:
   * `normaliseRoute` lives in crawler.ts beside `chromium`, and importing it
   * would pull playwright into a module whose whole point is that it needs no
   * browser. The integrator passes it; without it `Discovery.route` is null,
   * which is honest — nobody normalised it.
   */
  normaliseRoute?: (pathname: string) => string;
  hashRouting?: HarvestHashMode;
  /** Per-document discovery cap. Disclosed as a cap bite when it bites. */
  linksPerDocument?: number;
  /** How many sub-documents may be entered, across the whole recursion. */
  subDocumentBudget?: number;
  /** How deep the sub-document recursion may go. */
  subDocumentDepth?: number;
  /**
   * robots.txt rules, when the caller has them. Advisory by DEFAULT: see
   * `respectRobotsDisallow`.
   */
  robots?: RobotsPolicy | null;
  /**
   * Whether a robots.txt Disallow refuses a URL.
   *
   * FALSE by default, and the default is the honest one. robots.txt is a
   * statement to search engines about what to INDEX; it is not a statement
   * about what exists. An application that hides `/admin` from Google still has
   * an admin area, and letting its robots.txt shrink our denominator would mean
   * the coverage percentage goes UP the moment a customer writes a Disallow
   * line. When a caller does set this, the refusal still carries the exact
   * robots rule, so the URL stays in the ledger by name.
   */
  respectRobotsDisallow?: boolean;
}

const DEFAULT_LINKS_PER_DOCUMENT = 500;
const DEFAULT_SUB_DOCUMENT_BUDGET = 25;
const DEFAULT_SUB_DOCUMENT_DEPTH = 3;

export interface DocumentHarvest {
  /** Everything found, deduped by identity, refused ones included. */
  discoveries: Discovery[];
  /** GET and POST form templates: URL shapes whose instances are unenumerated. */
  templates: UrlTemplate[];
  /** Every sub-document, entered or not, with why not. */
  subDocuments: SubDocumentReport[];
  /** Regions mounted outside the application root. */
  portals: PortalRegion[];
  /** Off-origin and same-site sightings, for the boundary inventory. */
  boundaries: BoundaryObservation[];
  caps: HarvestCapBite[];
  /** Per-axis measured/unavailable, with `found: null` when unavailable. */
  availability: Record<HarvestAxis, HarvestAxisState>;
  /**
   * The `<base href>` in force. Worth its own field: a base pointing at another
   * origin makes every relative URL in the document off-origin, which turns a
   * crawl of the customer's application into a crawl of somebody else's.
   */
  baseHref: string | null;
  /** True when that base href is not the application's own origin. */
  baseHrefIsOffOrigin: boolean;
}

/**
 * Rewrites each bite's sentence with the FINAL discarded count.
 *
 * The reason is built when the cap first bites, so without this pass a cap that
 * discarded 240 candidates would report "at least 1 more existed" — the exact
 * understatement rule 9 of this slice is about.
 */
function finaliseCaps(
  caps: ReadonlyMap<HarvestCap, { bite: HarvestCapBite; scopes: Set<string> }>,
): HarvestCapBite[] {
  return [...caps.values()].map(({ bite: entry }) => ({
    ...entry,
    reason:
      `${HARVEST_CAP_LABELS[entry.cap]} (${entry.limit}) bit ${entry.bites} ` +
      `time${entry.bites === 1 ? '' : 's'} and discarded ${entry.discarded}; at least ` +
      `${entry.discarded} more existed`,
  }));
}

/** The attributes that carry a URL on a non-anchor element, in priority order. */
const DATA_URL_ATTRIBUTES = ['data-href', 'data-url'] as const;

interface Sighting {
  raw: string;
  kind: DiscoveryKind;
  evidence: string;
  label: string | null;
  rel: string | null;
  template: UrlTemplate | null;
  droppedFragmentAllowed?: boolean;
}

/**
 * Harvests every URL a document declares without anything being clicked.
 *
 * The order of operations matters in one place: `<base href>` is resolved
 * FIRST, because every other resolution in the document depends on it, and a
 * harvest that resolved half the links against the document URL and half
 * against the base would produce two sets of identities for one page.
 */
export function harvestDocument(
  snapshot: DocumentSnapshot,
  options: HarvestOptions,
): DocumentHarvest {
  const budget = {
    subDocuments: options.subDocumentBudget ?? DEFAULT_SUB_DOCUMENT_BUDGET,
    depth: options.subDocumentDepth ?? DEFAULT_SUB_DOCUMENT_DEPTH,
    links: options.linksPerDocument ?? DEFAULT_LINKS_PER_DOCUMENT,
  };
  const state: HarvestState = {
    options,
    budget,
    enteredSubDocuments: 0,
    caps: new Map(),
    discoveries: [],
    templates: [],
    subDocuments: [],
    portals: [],
    boundaries: [],
    axisCounts: new Map(),
    axisUnavailable: new Map(),
  };

  /*
   * The selector check runs BEFORE anything is harvested, so an axis the
   * adapter could not have seen is marked unavailable even if the element list
   * happens to contain nothing of that kind anyway. Doing it after would make
   * the answer depend on the page's contents rather than on what we queried.
   */
  markNarrowSelector(state, snapshot);

  const baseHref = resolveBase(snapshot);
  harvestInto(state, snapshot, { container: null, depth: 0, baseHref });

  const availability = {} as Record<HarvestAxis, HarvestAxisState>;
  for (const axis of HARVEST_AXES) {
    const reason = state.axisUnavailable.get(axis);
    /*
     * An element-derived axis with no entry defaults to MEASURED 0 and that is
     * defensible: `elements` was supplied, the canonical selector covers every
     * one of those axes, and `markNarrowSelector` has already flagged any the
     * adapter did not query. The axes that have no element selector
     * (FORMS, LINK_HEADERS, SUB_DOCUMENTS, PORTALS) each set their own
     * unavailability when their signal is absent.
     */
    availability[axis] =
      reason === undefined ? measured(state.axisCounts.get(axis) ?? 0) : unavailable(reason);
  }

  const baseScope =
    baseHref === null ? null : classifyScope(options.baseUrl, baseHref, options.policy);

  return {
    discoveries: dedupeDiscoveries(state.discoveries),
    templates: state.templates,
    subDocuments: state.subDocuments,
    portals: state.portals,
    boundaries: state.boundaries,
    caps: finaliseCaps(state.caps),
    availability,
    baseHref,
    baseHrefIsOffOrigin: baseScope !== null && baseScope.scope !== 'SAME_ORIGIN',
  };
}

interface HarvestState {
  options: HarvestOptions;
  budget: { subDocuments: number; depth: number; links: number };
  enteredSubDocuments: number;
  /** `scopes` so `bites` counts the places a cap bit, not the things it ate. */
  caps: Map<HarvestCap, { bite: HarvestCapBite; scopes: Set<string> }>;
  discoveries: Discovery[];
  templates: UrlTemplate[];
  subDocuments: SubDocumentReport[];
  portals: PortalRegion[];
  boundaries: BoundaryObservation[];
  axisCounts: Map<HarvestAxis, number>;
  axisUnavailable: Map<HarvestAxis, string>;
}

/** Flags the axes a narrower-than-canonical selector could not have seen. */
function markNarrowSelector(state: HarvestState, snapshot: DocumentSnapshot): void {
  const selector = snapshot.selector;
  if (selector === undefined || selector === null) return;
  for (const axis of HARVEST_AXES) {
    const fragment = AXIS_SELECTORS[axis];
    if (fragment === null) continue;
    if (selector.includes(fragment)) continue;
    state.axisUnavailable.set(
      axis,
      `the adapter queried "${selector}", which does not include ${fragment}, so ${HARVEST_AXIS_LABELS[axis]} were not measured`,
    );
  }
}

/**
 * Records a cap bite.
 *
 * `bites` counts the distinct places the cap applied and `discarded` counts
 * what it cost, because the two answer different questions: "the depth limit
 * bit on 14 frames" and "the depth limit discarded 14 frames" happen to be the
 * same number there and are not the same number for a per-page cap, and
 * collapsing them loses the one a reader needs.
 */
function bite(
  state: HarvestState,
  cap: HarvestCap,
  limit: number,
  scope: string | null,
  discarded = 1,
): void {
  const existing = state.caps.get(cap);
  if (existing) {
    existing.bite.discarded += discarded;
    if (!existing.scopes.has(scope ?? '')) {
      existing.scopes.add(scope ?? '');
      existing.bite.bites += 1;
    }
    return;
  }
  state.caps.set(cap, {
    scopes: new Set([scope ?? '']),
    bite: {
      cap,
      limit,
      bites: 1,
      discarded,
      scope,
      reason: `${HARVEST_CAP_LABELS[cap]} (${limit}) stopped the harvest; at least ${discarded} more existed`,
    },
  });
}

function countAxis(state: HarvestState, axis: HarvestAxis, by = 1): void {
  state.axisCounts.set(axis, (state.axisCounts.get(axis) ?? 0) + by);
}

/** Resolves `<base href>` against the document URL, defensively. */
function resolveBase(snapshot: DocumentSnapshot): string | null {
  const declared =
    snapshot.baseHref ??
    snapshot.elements.find((element) => element.tag === 'base')?.attrs['href'] ??
    null;
  if (declared === null || declared.trim() === '') return null;
  try {
    return new URL(declared, snapshot.url).toString();
  } catch {
    return null;
  }
}

function harvestInto(
  state: HarvestState,
  snapshot: DocumentSnapshot,
  context: { container: string | null; depth: number; baseHref: string | null },
): void {
  const base = context.baseHref ?? snapshot.url;
  const sightings: Sighting[] = [];

  for (const element of snapshot.elements) {
    sightings.push(...sightingsFor(element, state));
  }
  sightings.push(...formSightings(snapshot, state));
  sightings.push(...linkHeaderSightings(snapshot, state));

  for (const sighting of sightings) {
    /*
     * A sub-document's discoveries count against the SAME budget as its
     * parent's: a frame is part of the parent node, so "how many URLs did this
     * node yield" has one answer and one cap.
     */
    if (state.discoveries.length >= state.budget.links) {
      bite(state, 'LINKS_PER_DOCUMENT', state.budget.links, context.container ?? snapshot.url);
      continue;
    }
    const decided = decide(sighting, base, state.options, context.container);
    state.discoveries.push(decided.discovery);
    if (decided.discovery.template) state.templates.push(decided.discovery.template);
    if (
      decided.scope !== null &&
      (decided.scope.scope === 'SAME_SITE' || decided.scope.scope === 'OFF_ORIGIN')
    ) {
      state.boundaries.push({
        origin: decided.scope.origin ?? '',
        path: safeParts(decided.discovery.url)?.path ?? null,
        scope: decided.scope.scope,
        kind: decided.discovery.kind,
        fromRoute: decided.discovery.fromRoute,
        evidence: decided.discovery.evidence,
        site: decided.scope.site,
      });
    }
  }

  harvestPortals(state, snapshot, context.container);
  harvestSubDocuments(state, snapshot, context);
}

/** Turns one element into zero or more sightings, and counts its axis. */
function sightingsFor(element: ElementRecord, state: HarvestState): Sighting[] {
  const attrs = element.attrs;
  const label = (element.text ?? '').trim() === '' ? null : (element.text ?? '').trim();
  const out: Sighting[] = [];

  const dataAttribute = DATA_URL_ATTRIBUTES.find((name) => (attrs[name] ?? '').trim() !== '');
  const role = (attrs['role'] ?? '').toLowerCase();

  switch (element.tag) {
    case 'a': {
      const href = attrs['href'];
      if (href !== undefined) {
        countAxis(state, 'ANCHORS');
        out.push({
          raw: href,
          kind: 'ANCHOR',
          evidence: label ? `a[href] “${label}”` : 'a[href]',
          label,
          rel: attrs['rel'] ?? null,
          template: null,
        });
      }
      break;
    }
    case 'area': {
      const href = attrs['href'];
      if (href !== undefined) {
        countAxis(state, 'AREA_MAPS');
        const alt = (attrs['alt'] ?? '').trim();
        out.push({
          raw: href,
          kind: 'AREA',
          evidence: alt ? `area[href] alt=“${alt}”` : 'area[href] in an image map',
          label: alt === '' ? label : alt,
          rel: null,
          template: null,
        });
      }
      break;
    }
    case 'link': {
      const href = attrs['href'];
      if (href !== undefined) {
        const rel = (attrs['rel'] ?? '').trim();
        countAxis(state, 'LINK_REL');
        out.push({
          raw: href,
          kind: 'LINK_REL',
          evidence: rel === '' ? 'link[href] with no rel' : `link rel=${rel}`,
          label: null,
          rel,
          template: null,
        });
      }
      break;
    }
    case 'meta': {
      const equiv = (attrs['http-equiv'] ?? '').toLowerCase();
      if (equiv !== 'refresh') break;
      countAxis(state, 'META_REFRESH');
      const parsed = parseMetaRefresh(attrs['content'] ?? '');
      if (parsed === null || parsed.url === null) break;
      out.push({
        raw: parsed.url,
        kind: 'META_REFRESH',
        evidence: `meta http-equiv=refresh after ${parsed.delaySeconds}s`,
        label: null,
        rel: null,
        template: null,
      });
      break;
    }
    case 'base': {
      const href = attrs['href'];
      if (href === undefined) break;
      countAxis(state, 'BASE_HREF');
      out.push({
        raw: href,
        kind: 'BASE',
        evidence: 'base[href] — every relative URL in this document resolves against it',
        label: null,
        rel: null,
        template: null,
      });
      break;
    }
    case 'iframe':
    case 'frame': {
      const src = attrs['src'];
      if (src === undefined) break;
      countAxis(state, 'FRAMES');
      out.push({
        raw: src,
        kind: 'FRAME',
        evidence: `${element.tag}[src] — traversed as part of this document, not a route of its own`,
        label: (attrs['title'] ?? '').trim() || null,
        rel: null,
        template: null,
      });
      break;
    }
    case 'script': {
      const src = attrs['src'];
      if (src === undefined) break;
      countAxis(state, 'SCRIPT_HOSTS');
      out.push({
        raw: src,
        kind: 'SCRIPT_HOST',
        evidence: 'script[src]',
        label: null,
        rel: null,
        template: null,
      });
      break;
    }
    case 'img':
    case 'source': {
      const src = attrs['src'];
      const srcset = attrs['srcset'];
      if (src !== undefined && src.trim() !== '') {
        countAxis(state, 'ASSETS');
        out.push({
          raw: src,
          kind: 'ASSET',
          evidence: `${element.tag}[src]`,
          label: null,
          rel: null,
          template: null,
        });
      }
      for (const candidate of parseSrcset(srcset ?? '')) {
        countAxis(state, 'ASSETS');
        out.push({
          raw: candidate,
          kind: 'ASSET',
          evidence: `${element.tag}[srcset]`,
          label: null,
          rel: null,
          template: null,
        });
      }
      break;
    }
    default:
      break;
  }

  /*
   * data-href / data-url and role=link are checked on EVERY tag, including the
   * tags above: a `<div data-url>` and an `<a href data-url>` are both real,
   * and a framework that wires navigation to a data attribute on an anchor
   * (so the href is "#") is common enough that skipping anchors here would
   * lose the only real URL on the element.
   */
  if (dataAttribute !== undefined) {
    countAxis(state, 'DATA_ATTRIBUTES');
    out.push({
      raw: attrs[dataAttribute]!,
      kind: 'DATA_ATTRIBUTE',
      evidence: label
        ? `${dataAttribute} on <${element.tag}> “${label}”`
        : `${dataAttribute} on <${element.tag}>`,
      label,
      rel: null,
      template: null,
    });
  }

  if (role === 'link') {
    countAxis(state, 'ROLE_LINKS');
    const raw = attrs['href'] ?? attrs['data-href'] ?? attrs['data-url'] ?? null;
    if (raw !== null && raw.trim() !== '') {
      out.push({
        raw,
        kind: 'ROLE_LINK',
        evidence: label
          ? `role="link" on <${element.tag}> “${label}”`
          : `role="link" on <${element.tag}>`,
        label,
        rel: null,
        template: null,
      });
    }
  }

  return out;
}

/**
 * Forms as URL templates.
 *
 * A GET form IS a URL: its action plus its field names is `/search?q=&sort=`,
 * a route shape the crawl has never recorded even though every field name is
 * sitting in the markup. A POST form's action is recorded too — it is surface,
 * and `safeMethodsOnly` refuses it with a rule rather than letting it vanish.
 */
function formSightings(snapshot: DocumentSnapshot, state: HarvestState): Sighting[] {
  if (snapshot.forms === undefined) {
    state.axisUnavailable.set(
      'FORMS',
      'the adapter did not supply this document’s forms, so no GET-form templates were read',
    );
    return [];
  }

  const out: Sighting[] = [];
  for (const form of snapshot.forms) {
    countAxis(state, 'FORMS');
    const method = (form.method ?? 'get').trim().toLowerCase() === 'post' ? 'POST' : 'GET';
    const raw = form.action === null || form.action.trim() === '' ? snapshot.url : form.action;

    const params: string[] = [];
    const fixed: Array<{ name: string; value: string }> = [];
    for (const field of form.fields) {
      const name = (field.name ?? '').trim();
      if (name === '') continue;
      if (!params.includes(name)) params.push(name);
      const type = (field.type ?? '').toLowerCase();
      const supplies =
        field.value !== undefined &&
        field.value !== null &&
        field.value !== '' &&
        (type === 'hidden' || field.checked === true || type === '' || type === 'text');
      if (supplies) fixed.push({ name, value: field.value! });
    }

    const label = (form.label ?? '').trim() || null;
    const template: UrlTemplate = {
      action: raw,
      params,
      fixed,
      sample: null,
      method,
    };

    out.push({
      raw,
      kind: method === 'GET' ? 'GET_FORM' : 'POST_FORM',
      evidence:
        `form method=${method.toLowerCase()} action=${form.action ?? '(this URL)'}` +
        (params.length > 0 ? ` fields=${params.join(',')}` : ' with no named fields'),
      label,
      rel: null,
      template,
    });
  }
  return out;
}

/** The `Link:` response header, which carries pagination with no DOM at all. */
function linkHeaderSightings(snapshot: DocumentSnapshot, state: HarvestState): Sighting[] {
  if (snapshot.headers === undefined) {
    state.axisUnavailable.set(
      'LINK_HEADERS',
      'the adapter cannot read response headers, so Link: headers were not measured',
    );
    return [];
  }
  if (snapshot.headers === null) {
    state.axisUnavailable.set(
      'LINK_HEADERS',
      'no response headers were captured for this document',
    );
    return [];
  }
  const value = snapshot.headers['link'] ?? snapshot.headers['Link'] ?? null;
  if (value === null) {
    // MEASURED with zero found: the headers were read and there is no Link:.
    countAxis(state, 'LINK_HEADERS', 0);
    return [];
  }

  const refs = parseLinkHeader(value);
  const out: Sighting[] = [];
  for (const ref of refs) {
    countAxis(state, 'LINK_HEADERS');
    out.push({
      raw: ref.url,
      kind: 'LINK_HEADER',
      evidence: `Link: header rel=${ref.rel.join(' ') || '(none)'}`,
      label: ref.title,
      rel: ref.rel.join(' '),
      template: null,
    });
  }
  return out;
}

/**
 * Decides one sighting: canonicalise, classify, apply the policy, record.
 *
 * THE ORDER IS THE DESIGN. Navigability is settled before the policy, so an
 * `<img src>` on a CDN gets the rule "an image is a file, not a page" and NO
 * ledger entry, while a page on that same CDN gets OFF_ORIGIN and a ledger
 * entry a customer can act on. Running the policy first would fill the
 * exclusion ledger with every stylesheet on every page, and a ledger nobody
 * reads is the same as no ledger.
 *
 * Both are still classified, so both reach the boundary inventory: the CDN's
 * origin appears either way, which is the point of item 4.
 */
function decide(
  sighting: Sighting,
  base: string,
  options: HarvestOptions,
  container: string | null,
): { discovery: Discovery; scope: ScopeDecision | null } {
  const canonical = resolveDiscoveredUrl(sighting.raw, base, options.policy, {
    ...(options.hashRouting === undefined ? {} : { hashRouting: options.hashRouting }),
  });

  if (canonical === null) {
    return {
      scope: null,
      discovery: {
        url: sighting.raw,
        identity: sighting.raw,
        kind: sighting.kind,
        scope: 'UNPARSEABLE',
        route: null,
        fromRoute: options.fromRoute ?? null,
        label: sighting.label,
        evidence: `${sighting.evidence} — did not resolve to a URL`,
        navigable: false,
        admitted: false,
        rule: 'the value did not resolve to an absolute URL',
        refusal: 'UNSUPPORTED_SCHEME',
        container,
        template: null,
        occurrences: 1,
        otherKinds: [],
        droppedFragment: null,
      },
    };
  }

  const scope = classifyScope(options.baseUrl, canonical.url, options.policy);
  const navigable = navigabilityOf(sighting.kind, sighting.rel);
  const route = options.normaliseRoute ? options.normaliseRoute(canonical.path) : null;

  /*
   * A GET submission REPLACES the action's query string — that is what the HTML
   * form algorithm does — so a template's action carries none. Keeping the
   * action's own `?page=2` would produce a sample URL no browser would ever
   * request from that form.
   */
  const strippedAction = stripQuery(canonical.url);
  const template = sighting.template
    ? {
        ...sighting.template,
        action: sighting.template.method === 'GET' ? strippedAction : canonical.url,
        sample: sampleFor(strippedAction, sighting.template),
      }
    : null;

  let admitted: boolean;
  let rule: string;
  let refusal: ExclusionKind | null;

  if (sighting.kind === 'POST_FORM') {
    // Surface, and never a GET target. Refused WITH a rule rather than dropped,
    // because "there is a POST form here we did not drive" is a fact a report
    // owes the reader.
    admitted = false;
    refusal = 'UNSAFE_METHOD';
    rule = options.policy.safeMethodsOnly
      ? 'safeMethodsOnly: a POST form is not submitted during discovery'
      : 'discovery does not submit forms; a POST form is recorded as surface only';
  } else if (!navigable) {
    admitted = false;
    refusal = null;
    rule =
      sighting.kind === 'FRAME'
        ? 'a frame is traversed as part of its parent document, not queued as a route'
        : `${DISCOVERY_KIND_LABELS[sighting.kind]} is a file, not a page`;
  } else if (!scope.admitted) {
    admitted = false;
    rule = scope.rule;
    refusal = scope.refusal;
  } else {
    const decision = policyDecision(options.policy, canonical.path);
    admitted = decision.admitted;
    rule = decision.rule;
    refusal = decision.admitted
      ? null
      : decision.rule.startsWith('includeGlobs')
        ? 'POLICY_NOT_INCLUDED'
        : 'POLICY_EXCLUDE';

    if (admitted && options.respectRobotsDisallow === true && options.robots) {
      const robots = robotsDecision(options.robots, canonical.path);
      if (robots.disallowed) {
        admitted = false;
        rule = `robots.txt: ${robots.rule ?? 'Disallow'}`;
        refusal = 'POLICY_EXCLUDE';
      }
    }
  }

  return {
    scope,
    discovery: {
      url: canonical.url,
      identity: canonical.identity,
      kind: sighting.kind,
      scope: scope.scope,
      route,
      fromRoute: options.fromRoute ?? null,
      label: sighting.label,
      evidence: sighting.evidence,
      navigable,
      admitted,
      rule,
      refusal,
      container,
      template,
      occurrences: 1,
      otherKinds: [],
      droppedFragment: canonical.droppedFragment,
    },
  };
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * An example URL for a template, built ONLY from values the markup supplies.
 *
 * Null when it supplies none. A sample with invented values would be a URL the
 * application never served, presented as one it did — and it would then be
 * queued, visited, and counted as a covered route.
 */
function sampleFor(action: string, template: UrlTemplate): string | null {
  if (template.fixed.length === 0) return null;
  try {
    const url = new URL(action);
    for (const { name, value } of template.fixed) url.searchParams.set(name, value);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Merges sightings of one identity.
 *
 * Navigability is OR: a URL seen as both an `<img src>` and an `<a href>` is
 * reachable by clicking, so it is a page. Admission takes the admitted sighting
 * where there is one, for the same reason — and the refusal is dropped with it,
 * because a URL that one rule admits is not refused.
 */
export function dedupeDiscoveries(discoveries: readonly Discovery[]): Discovery[] {
  const merged = new Map<string, Discovery>();
  for (const discovery of discoveries) {
    const existing = merged.get(discovery.identity);
    if (!existing) {
      merged.set(discovery.identity, { ...discovery, otherKinds: [...discovery.otherKinds] });
      continue;
    }
    existing.occurrences += discovery.occurrences;
    if (existing.kind !== discovery.kind && !existing.otherKinds.includes(discovery.kind)) {
      existing.otherKinds.push(discovery.kind);
    }
    if (discovery.navigable && !existing.navigable) {
      existing.navigable = true;
      existing.kind = discovery.kind;
      existing.evidence = discovery.evidence;
    }
    if (discovery.admitted && !existing.admitted) {
      existing.admitted = true;
      existing.rule = discovery.rule;
      existing.refusal = null;
    }
    if (existing.template === null && discovery.template !== null) {
      existing.template = discovery.template;
    }
    if (existing.label === null && discovery.label !== null) existing.label = discovery.label;
    /*
     * A dropped fragment survives the merge. Found by a test: a `<base
     * href="/app/">` and an `<a href="#top">` resolve to the same identity, the
     * base is recorded first, and the merge was dropping the one fact that said
     * a fragment had been thrown away — which is the single thing this module
     * exists to make visible for hash-routed applications.
     */
    if (existing.droppedFragment === null && discovery.droppedFragment !== null) {
      existing.droppedFragment = discovery.droppedFragment;
    }
  }
  return [...merged.values()];
}

/** The discoveries a crawl should queue: admitted, navigable, same origin. */
export function navigableDiscoveries(harvest: DocumentHarvest): Discovery[] {
  return harvest.discoveries.filter(
    (discovery) => discovery.admitted && discovery.navigable && discovery.scope === 'SAME_ORIGIN',
  );
}

// ─── 9. Sub-documents and portals ────────────────────────────────────────────

/**
 * Portals: a region of the page mounted outside the application root.
 *
 * A modal, a toast stack, a `<dialog>` and most date pickers render into a
 * sibling of the app root, and a crawl whose queries are scoped to that root
 * sees none of them. The detection is a DOM fact the adapter records
 * (`outsideAppRoot`), not a guess made here — and when the adapter records
 * nothing the axis is UNAVAILABLE, because "we could not tell whether this page
 * uses portals" and "this page uses no portals" are different sentences and
 * only one of them is true of a page nobody asked.
 */
function harvestPortals(
  state: HarvestState,
  snapshot: DocumentSnapshot,
  container: string | null,
): void {
  const told = snapshot.elements.some((element) => element.outsideAppRoot !== undefined);
  if (!told && snapshot.appRoot === undefined) {
    state.axisUnavailable.set(
      'PORTALS',
      'the adapter supplied no application-root signal, so portals were not measured',
    );
    return;
  }

  const hosts = new Map<string, number>();
  for (const element of snapshot.elements) {
    if (element.outsideAppRoot !== true) continue;
    const host = element.portalHost ?? 'body > (unidentified)';
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  // Zero portals is a MEASUREMENT here — the adapter told us where the app root
  // is — so the axis is recorded even when nothing was found.
  countAxis(state, 'PORTALS', 0);
  for (const [host, elements] of hosts) {
    countAxis(state, 'PORTALS');
    state.portals.push({ host: container === null ? host : `${container} ${host}`, elements });
  }
}

/**
 * Enters same-origin frames and open shadow roots as PART OF THE PARENT NODE.
 *
 * Not as separate routes, which is the register item's rule and the right one:
 * a checkout form inside an iframe is a form on `/checkout`, and minting
 * `/embed/payment-widget` as its own route would put a URL in the denominator
 * that no customer journey ever navigates to.
 *
 * A cross-origin frame is refused and recorded as a boundary. Its interior is
 * not our surface, so it is NOT counted among the sub-documents we failed to
 * read — see `unreadAppSubDocuments`, which is the number that means "the
 * application has surface we could not see".
 */
function harvestSubDocuments(
  state: HarvestState,
  snapshot: DocumentSnapshot,
  context: { container: string | null; depth: number; baseHref: string | null },
): void {
  if (snapshot.subDocuments === undefined) {
    if (!state.axisUnavailable.has('SUB_DOCUMENTS')) {
      state.axisUnavailable.set(
        'SUB_DOCUMENTS',
        'the adapter supplied no sub-documents, so frames and shadow roots were not traversed',
      );
    }
    return;
  }

  for (const sub of snapshot.subDocuments) {
    const path = context.container === null ? sub.path : `${context.container} > ${sub.path}`;
    const scope =
      sub.url == null
        ? null
        : classifyScope(
            state.options.baseUrl,
            resolveAgainst(sub.url, snapshot.url),
            state.options.policy,
          );

    if (scope !== null && scope.scope !== 'SAME_ORIGIN') {
      const parts = safeParts(resolveAgainst(sub.url!, snapshot.url));
      if (parts && (scope.scope === 'SAME_SITE' || scope.scope === 'OFF_ORIGIN')) {
        state.boundaries.push({
          origin: parts.origin,
          path: parts.path,
          scope: scope.scope,
          kind: 'FRAME',
          fromRoute: state.options.fromRoute ?? null,
          evidence: `${sub.kind.toLowerCase()} at ${path} — a different origin, not this application`,
          site: scope.site,
        });
      }
      state.subDocuments.push({
        path,
        kind: sub.kind,
        /*
         * ORIGIN AND PATH ONLY for an off-origin frame. Found by a mutation
         * test: a cross-origin frame's `src` is where an identity provider's
         * state token, login hint and tenant id live, and this report is part
         * of a harvest a caller may persist, export or render. The app's own
         * frames keep their full URL; somebody else's never do.
         */
        url: parts === null ? null : `${parts.origin}${parts.path}`,
        scope: scope.scope,
        entered: false,
        unavailable: 'CROSS_ORIGIN',
        discoveries: null,
        forms: null,
        unreadAppSurface: false,
      });
      countAxis(state, 'SUB_DOCUMENTS');
      continue;
    }

    if (context.depth + 1 > state.budget.depth) {
      bite(state, 'SUB_DOCUMENT_DEPTH', state.budget.depth, path);
      state.subDocuments.push({
        path,
        kind: sub.kind,
        url: sub.url ?? null,
        scope: scope?.scope ?? null,
        entered: false,
        unavailable: 'DEPTH_CAP',
        discoveries: null,
        forms: null,
        unreadAppSurface: true,
      });
      countAxis(state, 'SUB_DOCUMENTS');
      continue;
    }

    if (state.enteredSubDocuments >= state.budget.subDocuments) {
      bite(state, 'SUB_DOCUMENT_BUDGET', state.budget.subDocuments, path);
      state.subDocuments.push({
        path,
        kind: sub.kind,
        url: sub.url ?? null,
        scope: scope?.scope ?? null,
        entered: false,
        unavailable: 'BUDGET_CAP',
        discoveries: null,
        forms: null,
        unreadAppSurface: true,
      });
      countAxis(state, 'SUB_DOCUMENTS');
      continue;
    }

    const document = sub.document ?? null;
    if (document === null) {
      const why = sub.unavailable ?? 'NOT_SUPPLIED';
      state.subDocuments.push({
        path,
        kind: sub.kind,
        url: sub.url ?? null,
        scope: scope?.scope ?? null,
        entered: false,
        unavailable: why,
        discoveries: null,
        forms: null,
        unreadAppSurface: APP_SURFACE_UNAVAILABILITIES.includes(why),
      });
      countAxis(state, 'SUB_DOCUMENTS');
      continue;
    }

    state.enteredSubDocuments += 1;
    const before = state.discoveries.length;
    harvestInto(state, document, {
      container: path,
      depth: context.depth + 1,
      // A sub-document resolves its own relative URLs against ITS OWN base and
      // URL, never the parent's: an iframe at /embed/widget linking to
      // `settings` means /embed/settings, and resolving it against the parent
      // would mint a route that does not exist.
      baseHref: resolveBase(document),
    });
    countAxis(state, 'SUB_DOCUMENTS');
    state.subDocuments.push({
      path,
      kind: sub.kind,
      url: sub.url ?? null,
      scope: scope?.scope ?? null,
      entered: true,
      unavailable: null,
      discoveries: state.discoveries.length - before,
      forms: document.forms?.length ?? 0,
      unreadAppSurface: false,
    });
  }
}

function resolveAgainst(raw: string, base: string): string {
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
}

function safeParts(url: string): { origin: string; path: string } | null {
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, path: parsed.pathname };
  } catch {
    return null;
  }
}

/**
 * The sub-documents that are a gap in the APPLICATION's own surface.
 *
 * Cross-origin frames are excluded by construction. The count this returns is
 * the honest answer to "is there surface here you could not see", and it is the
 * number a report must print beside a coverage percentage computed on a page
 * with a closed shadow root in it.
 */
export function unreadAppSubDocuments(reports: readonly SubDocumentReport[]): SubDocumentReport[] {
  return reports.filter((report) => report.unreadAppSurface);
}

/** Entered, unreadable (ours), and off-origin — three counts, never collapsed. */
export function subDocumentCoverage(reports: readonly SubDocumentReport[]): {
  entered: number;
  unreadAppSurface: number;
  offOrigin: number;
} {
  return {
    entered: reports.filter((report) => report.entered).length,
    unreadAppSurface: reports.filter((report) => report.unreadAppSurface).length,
    offOrigin: reports.filter((report) => report.unavailable === 'CROSS_ORIGIN').length,
  };
}

// ─── 10. Small parsers ───────────────────────────────────────────────────────

/** One entry of a `Link:` response header. */
export interface LinkHeaderRef {
  url: string;
  /** rel tokens, lower-cased. Empty when the entry declares none. */
  rel: string[];
  title: string | null;
}

/**
 * Parses a `Link:` response header.
 *
 * Split on the commas OUTSIDE the angle brackets, because a URL may contain a
 * comma — `Link: </a,b>; rel=next` is legal and a naive `split(',')` turns it
 * into two broken entries, one of which resolves to a URL the application does
 * not serve. The failure is silent: you get a 404 node and a coverage gap for a
 * page that never existed.
 */
export function parseLinkHeader(value: string): LinkHeaderRef[] {
  const out: LinkHeaderRef[] = [];
  let depth = 0;
  let current = '';
  const parts: string[] = [];
  for (const char of value) {
    if (char === '<') depth += 1;
    else if (char === '>') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current);

  for (const part of parts) {
    const match = /<([^>]*)>(.*)$/s.exec(part.trim());
    if (!match) continue;
    const url = (match[1] ?? '').trim();
    if (url === '') continue;
    const rel: string[] = [];
    let title: string | null = null;
    for (const attribute of (match[2] ?? '').split(';')) {
      const pair = /^\s*([\w*-]+)\s*=\s*(.*)$/.exec(attribute);
      if (!pair) continue;
      const name = (pair[1] ?? '').toLowerCase();
      const raw = (pair[2] ?? '').trim().replace(/^["']|["']$/g, '');
      if (name === 'rel') rel.push(...raw.toLowerCase().split(/\s+/).filter(Boolean));
      else if (name === 'title' && raw !== '') title = raw;
    }
    out.push({ url, rel, title });
  }
  return out;
}

/**
 * Parses a `<meta http-equiv="refresh">` content attribute.
 *
 * The delay is kept because it is the difference between a redirect and a
 * kiosk: `0; url=/next` is a navigation the crawl must follow, and `300` with
 * no URL is a page that reloads itself every five minutes and has no outgoing
 * edge at all. Returning the delay lets a caller tell them apart; collapsing
 * both to "there is a refresh here" does not.
 */
export function parseMetaRefresh(content: string): {
  delaySeconds: number;
  url: string | null;
} | null {
  const trimmed = content.trim();
  if (trimmed === '') return null;
  const [head, ...rest] = trimmed.split(';');
  const delay = Number.parseFloat((head ?? '').trim());
  if (!Number.isFinite(delay) || delay < 0) {
    // A content attribute with no leading number is malformed; `url=/x` alone
    // is not a refresh any browser honours, so claiming a 0-second redirect
    // from it would invent an edge.
    return null;
  }
  const tail = rest.join(';');
  const match = /url\s*=\s*(.*)$/i.exec(tail);
  const url = match ? (match[1] ?? '').trim().replace(/^["']|["']$/g, '') : '';
  return { delaySeconds: delay, url: url === '' ? null : url };
}

/**
 * The document URLs in a `srcset`.
 *
 * `srcset` is `url 2x, url 640w` — comma-separated with a descriptor, and the
 * URL may itself contain a comma if it is percent-encoded. Each entry's URL is
 * everything up to the first run of whitespace.
 */
export function parseSrcset(value: string): string[] {
  if (value.trim() === '') return [];
  return value
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0] ?? '')
    .filter((entry) => entry !== '');
}

// ─── 11. robots.txt ──────────────────────────────────────────────────────────

/**
 * What robots.txt says, and what it does NOT say.
 *
 * The `Sitemap:` lines are the cheapest complete route list in existence and
 * QAAI does not read them today. The `Disallow` rules are the trap: they are a
 * POLICY INPUT, not a crawl target and not an absence. An application that
 * hides `/admin` from search engines still has an admin area with forty routes
 * in it, and letting robots.txt remove them from the inventory would mean the
 * coverage percentage goes UP the day a customer writes a Disallow line. So
 * `parseRobots` produces no exclude globs; it reports the rules, and
 * `harvestDocument` honours them only when a caller explicitly opts in — and
 * even then the refusal lands in the ledger with the robots line as its rule.
 */
export interface RobotsPolicy {
  /** `Sitemap:` lines, resolved to absolute URLs. */
  sitemaps: string[];
  /** `Disallow` patterns for the matched user-agent group. */
  disallow: string[];
  /** `Allow` patterns for the matched group. A longer match wins. */
  allow: string[];
  /** Which group matched: the specific user-agent, or `*`. */
  userAgent: string | null;
  crawlDelaySeconds: number | null;
  /** Lines we did not understand. Reported, never dropped. */
  unparsed: string[];
  /**
   * PRESENT  the file exists and was parsed.
   * ABSENT   the server answered and there is no robots.txt (a 404). A real
   *          measurement: "this site publishes no robots.txt" is a fact.
   * UNAVAILABLE  we could not find out. Never the same as ABSENT.
   */
  availability: 'PRESENT' | 'ABSENT' | 'UNAVAILABLE';
  unavailableReason: string | null;
}

export const EMPTY_ROBOTS: RobotsPolicy = {
  sitemaps: [],
  disallow: [],
  allow: [],
  userAgent: null,
  crawlDelaySeconds: null,
  unparsed: [],
  availability: 'UNAVAILABLE',
  unavailableReason: 'robots.txt was not fetched',
};

/**
 * Parses robots.txt for one user-agent.
 *
 * Group selection follows the de-facto rule: the most specific matching
 * user-agent group wins outright and `*` is the fallback, with no merging
 * between them. Merging would apply a rule written for Googlebot to us, and a
 * crawl refusing URLs on the strength of somebody else's rules is a crawl whose
 * denominator depends on a line that was never about it.
 *
 * `Sitemap:` is a GLOBAL directive and is collected from every group, which is
 * what the specification says and what every server assumes.
 */
export function parseRobots(
  body: string,
  options: { baseUrl: string; userAgent?: string } = { baseUrl: 'http://localhost' },
): RobotsPolicy {
  const agent = (options.userAgent ?? '*').toLowerCase();
  const sitemaps: string[] = [];
  const unparsed: string[] = [];
  const groups = new Map<string, { disallow: string[]; allow: string[]; delay: number | null }>();

  let currentAgents: string[] = [];
  let lastLineWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) {
      unparsed.push(rawLine.trim());
      continue;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    switch (field) {
      case 'user-agent': {
        // Consecutive User-agent lines form ONE group; a User-agent line after
        // a rule starts a new one.
        if (!lastLineWasAgent) currentAgents = [];
        currentAgents.push(value.toLowerCase());
        lastLineWasAgent = true;
        for (const name of currentAgents) {
          if (!groups.has(name)) groups.set(name, { disallow: [], allow: [], delay: null });
        }
        continue;
      }
      case 'sitemap': {
        try {
          sitemaps.push(new URL(value, options.baseUrl).toString());
        } catch {
          unparsed.push(rawLine.trim());
        }
        lastLineWasAgent = false;
        continue;
      }
      case 'disallow':
      case 'allow':
      case 'crawl-delay': {
        lastLineWasAgent = false;
        const targets = currentAgents.length > 0 ? currentAgents : ['*'];
        for (const name of targets) {
          const group = groups.get(name) ?? { disallow: [], allow: [], delay: null };
          if (field === 'disallow') {
            // `Disallow:` with an empty value means "nothing is disallowed" and
            // must not become the pattern '' — which matches every path.
            if (value !== '') group.disallow.push(value);
          } else if (field === 'allow') {
            if (value !== '') group.allow.push(value);
          } else {
            const delay = Number.parseFloat(value);
            group.delay = Number.isFinite(delay) ? delay : group.delay;
          }
          groups.set(name, group);
        }
        continue;
      }
      default: {
        lastLineWasAgent = false;
        unparsed.push(rawLine.trim());
        continue;
      }
    }
  }

  const matched =
    [...groups.keys()]
      .filter((name) => name !== '*' && agent.includes(name))
      .sort((left, right) => right.length - left.length)[0] ?? (groups.has('*') ? '*' : null);
  const group = matched === null ? null : (groups.get(matched) ?? null);

  return {
    sitemaps,
    disallow: group?.disallow ?? [],
    allow: group?.allow ?? [],
    userAgent: matched,
    crawlDelaySeconds: group?.delay ?? null,
    unparsed,
    availability: 'PRESENT',
    unavailableReason: null,
  };
}

/**
 * robots.txt path matching, which is NOT the crawl policy's glob dialect.
 *
 * In robots.txt `*` crosses `/` and `$` anchors the end. `matchesGlob` from
 * @qaai/shared deliberately does not let `*` cross a slash, so reusing it would
 * silently mis-evaluate `Disallow: /*.json$` and every nested wildcard — a rule
 * the site wrote would quietly stop applying. Two dialects, two
 * implementations, and this comment is why there is not one.
 */
export function robotsMatches(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((segment) => segment.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/**
 * Whether robots.txt disallows a path, and WHICH line said so.
 *
 * Longest match wins and Allow beats Disallow at equal length, which is the
 * behaviour every major crawler implements. The rule is returned so a caller
 * that opts into honouring robots can put the actual line in the exclusion
 * ledger instead of the word "robots".
 */
export function robotsDecision(
  robots: RobotsPolicy,
  path: string,
): { disallowed: boolean; rule: string | null } {
  let bestDisallow: string | null = null;
  for (const pattern of robots.disallow) {
    if (!robotsMatches(pattern, path)) continue;
    if (bestDisallow === null || pattern.length > bestDisallow.length) bestDisallow = pattern;
  }
  if (bestDisallow === null) return { disallowed: false, rule: null };

  let bestAllow: string | null = null;
  for (const pattern of robots.allow) {
    if (!robotsMatches(pattern, path)) continue;
    if (bestAllow === null || pattern.length > bestAllow.length) bestAllow = pattern;
  }
  if (bestAllow !== null && bestAllow.length >= bestDisallow.length) {
    return { disallowed: false, rule: `Allow: ${bestAllow}` };
  }
  return { disallowed: true, rule: `Disallow: ${bestDisallow}` };
}

// ─── 12. Sitemaps ────────────────────────────────────────────────────────────

export const SITEMAP_KINDS = ['URLSET', 'SITEMAPINDEX', 'TEXT', 'UNKNOWN'] as const;
export type SitemapKind = (typeof SITEMAP_KINDS)[number];

export interface SitemapEntry {
  url: string;
  /** `<lastmod>` as written. Null means the sitemap declares none. */
  lastmod: string | null;
  changefreq: string | null;
  /** 0–1, or null when absent or unparseable. */
  priority: number | null;
}

export const SITEMAP_UNAVAILABILITIES = [
  'GZIP_NOT_DECODED',
  'NOT_XML',
  'EMPTY_BODY',
  'HTTP_ERROR',
  'TRANSPORT_ERROR',
  'REFUSED_OFF_ORIGIN',
] as const;
export type SitemapUnavailability = (typeof SITEMAP_UNAVAILABILITIES)[number];

export const SITEMAP_UNAVAILABILITY_LABELS: Record<SitemapUnavailability, string> = {
  GZIP_NOT_DECODED: 'the body is gzip and the fetcher did not decompress it',
  NOT_XML: 'the body is not a sitemap document',
  EMPTY_BODY: 'the response had no body',
  HTTP_ERROR: 'the server did not return the document',
  TRANSPORT_ERROR: 'the request did not complete',
  REFUSED_OFF_ORIGIN: 'the sitemap is on another origin and was not fetched',
};

export interface ParsedSitemap {
  kind: SitemapKind;
  /** URL entries, for a urlset or a text sitemap. */
  entries: SitemapEntry[];
  /** Child sitemap URLs, for an index. */
  children: SitemapEntry[];
  /**
   * `<loc>` values that did not resolve. Counted, because a sitemap full of
   * broken locs is a finding about the application, not a reason for a
   * shorter list.
   */
  malformed: number;
  /** MEASURED means the document was parsed, whatever it contained. */
  availability: 'MEASURED' | 'UNAVAILABLE';
  unavailableReason: SitemapUnavailability | null;
}

/**
 * The byte prefixes of a gzip stream, as a text decoder may render them.
 *
 * 0x1f 0x8b survives a latin1 decode as `\u001f\u008b`, becomes
 * `\u001f\ufffd` under a lossy UTF-8 decode, and becomes `\u001f\u00c2\u008b`
 * when UTF-8 output is read back as latin1. All three mean "this is a .xml.gz
 * nobody decompressed", and all three must report UNAVAILABLE rather than parse
 * to zero entries: "your sitemap declares 0 URLs" is the exact shape of lie
 * that makes a coverage percentage go UP.
 */
const GZIP_PREFIXES = ['\u001f\u008b', '\u001f\ufffd', '\u001f\u00c2\u008b'];

/** A numeric character reference, or the reference itself when it is not one. */
function codePoint(raw: string, radix: number, original: string): string {
  const value = Number.parseInt(raw, radix);
  // A reference outside the Unicode range throws from fromCodePoint, and one
  // malformed entity must not lose the 4,000 URLs that parsed before it.
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return original;
  try {
    return String.fromCodePoint(value);
  } catch {
    return original;
  }
}

function decodeEntities(value: string): string {
  return (
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => codePoint(hex, 16, match))
      .replace(/&#(\d+);/g, (match, dec: string) => codePoint(dec, 10, match))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // LAST, so `&amp;lt;` becomes `&lt;` and not `<`.
      .replace(/&amp;/g, '&')
  );
}

function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(
    `<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`,
    'i',
  ).exec(block);
  if (!match) return null;
  const value = decodeEntities(match[1] ?? '').trim();
  return value === '' ? null : value;
}

/**
 * Parses a sitemap: a urlset, a sitemap index, or the plain-text form.
 *
 * Regex and not an XML parser, deliberately: adding a dependency to read four
 * tags would make the enumeration slice's correctness depend on a parser's
 * entity and namespace behaviour, and a malformed sitemap — which is the common
 * case in the wild — makes a strict parser throw and lose the 4,000 URLs that
 * parsed fine before the bad one.
 *
 * A gzip body reports UNAVAILABLE rather than parsing to zero entries. "Your
 * sitemap.xml.gz declares 0 URLs" is the exact shape of lie this product cannot
 * afford: it would make the denominator smaller and the percentage higher.
 */
export function parseSitemap(body: string | null, baseUrl: string): ParsedSitemap {
  const empty = (reason: SitemapUnavailability): ParsedSitemap => ({
    kind: 'UNKNOWN',
    entries: [],
    children: [],
    malformed: 0,
    availability: 'UNAVAILABLE',
    unavailableReason: reason,
  });

  if (body === null || body.trim() === '') return empty('EMPTY_BODY');
  if (GZIP_PREFIXES.some((prefix) => body.startsWith(prefix))) {
    return empty('GZIP_NOT_DECODED');
  }

  const isIndex = /<(?:[\w-]+:)?sitemapindex[\s>]/i.test(body);
  const isUrlset = /<(?:[\w-]+:)?urlset[\s>]/i.test(body);

  let malformed = 0;
  const read = (block: string): SitemapEntry | null => {
    const loc = tagValue(block, 'loc');
    if (loc === null) {
      malformed += 1;
      return null;
    }
    let absolute: string;
    try {
      absolute = new URL(loc, baseUrl).toString();
    } catch {
      malformed += 1;
      return null;
    }
    const priorityRaw = tagValue(block, 'priority');
    const priority = priorityRaw === null ? null : Number.parseFloat(priorityRaw);
    return {
      url: absolute,
      lastmod: tagValue(block, 'lastmod'),
      changefreq: tagValue(block, 'changefreq'),
      priority: priority !== null && Number.isFinite(priority) ? priority : null,
    };
  };

  if (isIndex) {
    const children: SitemapEntry[] = [];
    for (const match of body.matchAll(
      /<(?:[\w-]+:)?sitemap\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?sitemap>/gi,
    )) {
      const entry = read(match[1] ?? '');
      if (entry) children.push(entry);
    }
    return {
      kind: 'SITEMAPINDEX',
      entries: [],
      children,
      malformed,
      availability: 'MEASURED',
      unavailableReason: null,
    };
  }

  if (isUrlset) {
    const entries: SitemapEntry[] = [];
    for (const match of body.matchAll(/<(?:[\w-]+:)?url\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?url>/gi)) {
      const entry = read(match[1] ?? '');
      if (entry) entries.push(entry);
    }
    return {
      kind: 'URLSET',
      entries,
      children: [],
      malformed,
      availability: 'MEASURED',
      unavailableReason: null,
    };
  }

  // The plain-text form the sitemaps.org specification also permits: one URL
  // per line, no XML at all. Accepted because refusing it would report a real
  // complete route list as "not a sitemap".
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length > 0 && lines.every((line) => /^https?:\/\//i.test(line))) {
    return {
      kind: 'TEXT',
      entries: lines.map((line) => ({
        url: line,
        lastmod: null,
        changefreq: null,
        priority: null,
      })),
      children: [],
      malformed: 0,
      availability: 'MEASURED',
      unavailableReason: null,
    };
  }

  return empty('NOT_XML');
}

// ─── 13. Seeding from robots.txt and sitemaps ────────────────────────────────

/** A fetched text resource. The one capability this module takes injected. */
export interface FetchedText {
  /** HTTP status, or null when the transport never produced one. */
  status: number | null;
  /** Decoded body, or null when there is none we could decode. */
  body: string | null;
  headers?: Record<string, string> | null;
  /** Transport failure, when `status` is null. */
  error?: string | null;
  /** The URL the transport ended at, when it followed a redirect. */
  finalUrl?: string | null;
}

/**
 * The network capability, injected.
 *
 * One method, because one method is all the seeding needs, and because a narrow
 * interface is the difference between a module the unit suite drives with a Map
 * and 629 lines nothing can test.
 */
export interface HarvestFetcher {
  get(url: string): Promise<FetchedText>;
}

/** Why a sitemap URL was in the candidate list, which decides if a 404 is a finding. */
export const SITEMAP_BASES = ['ROBOTS', 'DECLARED', 'CONVENTION', 'INDEX'] as const;
export type SitemapBasis = (typeof SITEMAP_BASES)[number];

export interface SitemapDocumentResult {
  url: string;
  basis: SitemapBasis;
  status: number | null;
  parsed: ParsedSitemap;
  /**
   * A finding: the site DECLARED this sitemap and did not serve it. Only true
   * for ROBOTS, DECLARED and INDEX — a conventional guess that 404s is a guess
   * that missed, not a defect in the application.
   */
  declaredButMissing: boolean;
  error: string | null;
}

export interface SeedOptions {
  baseUrl: string;
  policy: CrawlPolicy;
  fetcher: HarvestFetcher;
  /** Sitemap URLs the project declared, over and above robots.txt. */
  extraSitemaps?: string[];
  urlBudget?: number;
  documentBudget?: number;
  indexDepth?: number;
  userAgent?: string;
  normaliseRoute?: (pathname: string) => string;
  hashRouting?: HarvestHashMode;
  /**
   * Whether a sitemap on another origin may be fetched. FALSE by default.
   *
   * robots.txt is a file on the application's own origin whose contents are
   * controlled by whoever can write there, and a `Sitemap:` line pointing at an
   * arbitrary host turns our crawler into a request generator aimed wherever
   * that line says. The specification permits cross-host sitemaps; a crawler
   * that follows them unasked is an SSRF primitive. Refused by default, and the
   * refusal is RECORDED, so a customer whose sitemap genuinely lives on a CDN
   * sees why it was skipped rather than wondering where their routes went.
   */
  allowOffOriginSitemaps?: boolean;
  /** See {@link HarvestOptions.respectRobotsDisallow}. False by default. */
  respectRobotsDisallow?: boolean;
}

export interface SeedHarvest {
  robots: RobotsPolicy;
  /** One per sitemap document considered, in fetch order. */
  documents: SitemapDocumentResult[];
  /** Every `<loc>`, canonicalised, classified and decided. */
  discoveries: Discovery[];
  /** The raw entries, deduped by URL, for staleness reporting. */
  entries: SitemapEntry[];
  caps: HarvestCapBite[];
  boundaries: BoundaryObservation[];
  availability: {
    robots: HarvestAxisState;
    /** `found` is the number of sitemap DOCUMENTS parsed. */
    sitemaps: HarvestAxisState;
  };
}

const DEFAULT_URL_BUDGET = 5_000;
const DEFAULT_DOCUMENT_BUDGET = 50;
const DEFAULT_INDEX_DEPTH = 3;

/** The conventional locations, tried when nothing declares a sitemap. */
const CONVENTIONAL_SITEMAPS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];

/**
 * Reads robots.txt and every sitemap it leads to, and turns them into
 * discoveries.
 *
 * The cheapest complete route list in existence: an application that publishes
 * a sitemap has already told us its routes, and today nothing reads it. A
 * 412-route app whose crawl reaches 60 pages has 352 routes sitting in a file
 * at a known URL.
 *
 * Every budget here BITES VISIBLY. `documentBudget` stopping at 50 of 200
 * sitemap files is not a smaller app, it is an unmeasured one, and the cap bite
 * carries the count so the report can say "at least N more existed".
 */
export async function seedFromRobotsAndSitemaps(options: SeedOptions): Promise<SeedHarvest> {
  const urlBudget = options.urlBudget ?? DEFAULT_URL_BUDGET;
  const documentBudget = options.documentBudget ?? DEFAULT_DOCUMENT_BUDGET;
  const indexDepth = options.indexDepth ?? DEFAULT_INDEX_DEPTH;

  const caps = new Map<HarvestCap, { bite: HarvestCapBite; scopes: Set<string> }>();
  const capBite = (cap: HarvestCap, limit: number, scope: string | null, discarded: number) => {
    const existing = caps.get(cap);
    if (existing) {
      existing.bite.discarded += discarded;
      if (!existing.scopes.has(scope ?? '')) {
        existing.scopes.add(scope ?? '');
        existing.bite.bites += 1;
      }
      return;
    }
    caps.set(cap, {
      scopes: new Set([scope ?? '']),
      bite: { cap, limit, bites: 1, discarded, scope, reason: '' },
    });
  };

  let robots: RobotsPolicy = { ...EMPTY_ROBOTS };
  let robotsAxis: HarvestAxisState = unavailable('robots.txt was not fetched');
  let robotsUrl: string;
  try {
    robotsUrl = new URL('/robots.txt', options.baseUrl).toString();
  } catch {
    robotsUrl = '';
  }

  if (robotsUrl !== '') {
    const response = await options.fetcher.get(robotsUrl).catch((error: unknown) => ({
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (response.status === null) {
      robots = {
        ...EMPTY_ROBOTS,
        availability: 'UNAVAILABLE',
        unavailableReason: response.error ?? 'the request did not complete',
      };
      robotsAxis = unavailable(robots.unavailableReason ?? 'the request did not complete');
    } else if (response.status >= 400) {
      // A 404 is a MEASUREMENT: this site publishes no robots.txt. Distinct from
      // a timeout, where we learned nothing.
      robots = {
        ...EMPTY_ROBOTS,
        availability: 'ABSENT',
        unavailableReason: `the server answered ${response.status}`,
      };
      robotsAxis = measured(0);
    } else {
      robots = parseRobots(response.body ?? '', {
        baseUrl: options.baseUrl,
        ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
      });
      robotsAxis = measured(robots.sitemaps.length);
    }
  }

  const candidates: Array<{ url: string; basis: SitemapBasis; depth: number }> = [];
  const seenDocuments = new Set<string>();
  const push = (raw: string, basis: SitemapBasis, depth: number): void => {
    let absolute: string;
    try {
      absolute = new URL(raw, options.baseUrl).toString();
    } catch {
      return;
    }
    if (seenDocuments.has(absolute)) return;
    seenDocuments.add(absolute);
    candidates.push({ url: absolute, basis, depth });
  };

  for (const sitemap of robots.sitemaps) push(sitemap, 'ROBOTS', 0);
  for (const sitemap of options.extraSitemaps ?? []) push(sitemap, 'DECLARED', 0);
  /*
   * The conventional locations are tried even when robots.txt named some: a
   * robots.txt listing one locale's sitemap while /sitemap.xml holds the rest
   * is ordinary, and the cost of a miss is one 404.
   */
  for (const path of CONVENTIONAL_SITEMAPS) push(path, 'CONVENTION', 0);

  const documents: SitemapDocumentResult[] = [];
  const boundaries: BoundaryObservation[] = [];
  const discoveries: Discovery[] = [];
  const entries = new Map<string, SitemapEntry>();

  /*
   * One options object for every `<loc>`, built after robots.txt is parsed so
   * a caller that opted into honouring Disallow gets the real rules rather
   * than the empty default.
   */
  const seedHarvestOptions: HarvestOptions = {
    baseUrl: options.baseUrl,
    policy: options.policy,
    robots,
    ...(options.normaliseRoute ? { normaliseRoute: options.normaliseRoute } : {}),
    ...(options.hashRouting ? { hashRouting: options.hashRouting } : {}),
    ...(options.respectRobotsDisallow === undefined
      ? {}
      : { respectRobotsDisallow: options.respectRobotsDisallow }),
  };

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;

    if (documents.length >= documentBudget) {
      capBite('SITEMAP_DOCUMENT_BUDGET', documentBudget, candidate.url, candidates.length - index);
      break;
    }

    const scope = classifyScope(options.baseUrl, candidate.url, options.policy);
    if (scope.scope !== 'SAME_ORIGIN' && options.allowOffOriginSitemaps !== true) {
      if (scope.origin !== null && (scope.scope === 'SAME_SITE' || scope.scope === 'OFF_ORIGIN')) {
        boundaries.push({
          origin: scope.origin,
          path: safeParts(candidate.url)?.path ?? null,
          scope: scope.scope,
          kind: candidate.basis === 'ROBOTS' ? 'ROBOTS_SITEMAP' : 'SITEMAP_INDEX',
          fromRoute: null,
          evidence: `a ${candidate.basis.toLowerCase()} sitemap on another origin`,
          site: scope.site,
        });
      }
      documents.push({
        url: candidate.url,
        basis: candidate.basis,
        status: null,
        parsed: {
          kind: 'UNKNOWN',
          entries: [],
          children: [],
          malformed: 0,
          availability: 'UNAVAILABLE',
          unavailableReason: 'REFUSED_OFF_ORIGIN',
        },
        declaredButMissing: false,
        error: scope.rule,
      });
      continue;
    }

    const response = await options.fetcher.get(candidate.url).catch((error: unknown) => ({
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    }));

    const declared = candidate.basis !== 'CONVENTION';
    if (response.status === null || response.status >= 400) {
      documents.push({
        url: candidate.url,
        basis: candidate.basis,
        status: response.status ?? null,
        parsed: {
          kind: 'UNKNOWN',
          entries: [],
          children: [],
          malformed: 0,
          availability: 'UNAVAILABLE',
          unavailableReason: response.status === null ? 'TRANSPORT_ERROR' : 'HTTP_ERROR',
        },
        declaredButMissing: declared,
        error:
          response.error ?? (response.status === null ? 'no response' : `HTTP ${response.status}`),
      });
      continue;
    }

    const parsed = parseSitemap(response.body, candidate.url);
    documents.push({
      url: candidate.url,
      basis: candidate.basis,
      status: response.status,
      parsed,
      declaredButMissing: false,
      error: null,
    });

    for (const child of parsed.children) {
      if (candidate.depth + 1 > indexDepth) {
        capBite('SITEMAP_INDEX_DEPTH', indexDepth, candidate.url, 1);
        continue;
      }
      push(child.url, 'INDEX', candidate.depth + 1);
    }

    for (const entry of parsed.entries) {
      if (entries.size >= urlBudget) {
        capBite('SITEMAP_URL_BUDGET', urlBudget, candidate.url, 1);
        continue;
      }
      if (entries.has(entry.url)) continue;
      entries.set(entry.url, entry);

      const sighting: Sighting = {
        raw: entry.url,
        kind: 'SITEMAP_URL',
        evidence: `sitemap ${candidate.url} <loc>${entry.lastmod ? ` lastmod ${entry.lastmod}` : ''}`,
        label: null,
        rel: null,
        template: null,
      };
      const decided = decide(sighting, candidate.url, seedHarvestOptions, null);
      discoveries.push(decided.discovery);
      if (
        decided.scope !== null &&
        (decided.scope.scope === 'SAME_SITE' || decided.scope.scope === 'OFF_ORIGIN')
      ) {
        boundaries.push({
          origin: decided.scope.origin ?? '',
          path: safeParts(decided.discovery.url)?.path ?? null,
          scope: decided.scope.scope,
          kind: 'SITEMAP_URL',
          fromRoute: null,
          evidence: decided.discovery.evidence,
          site: decided.scope.site,
        });
      }
    }
  }

  const parsedDocuments = documents.filter(
    (document) => document.parsed.availability === 'MEASURED',
  ).length;

  return {
    robots,
    documents,
    discoveries: dedupeDiscoveries(discoveries),
    entries: [...entries.values()],
    caps: finaliseCaps(caps),
    boundaries,
    availability: {
      robots: robotsAxis,
      sitemaps:
        documents.length === 0
          ? unavailable('no sitemap document was considered')
          : measured(parsedDocuments),
    },
  };
}

// ─── 14. Declared but unreachable, and staleness ─────────────────────────────

/**
 * What became of the URLs a sitemap declared.
 *
 * Four buckets and the last two are the reason this exists. "Declared and
 * 404s" is a FINDING about the application: the site advertises a URL it does
 * not serve, which is a real defect a customer can act on. "Declared and never
 * visited" is a fact about US — we did not look — and reporting it as a finding
 * would be inventing a defect. "Declared and refused" is known by name. Three
 * different sentences that every tool in this market collapses into one.
 */
export interface SitemapReachability {
  reachable: string[];
  unreachable: Array<{ url: string; status: number | null; detail: string }>;
  unchecked: string[];
  refused: string[];
}

export function sitemapReachability(
  declared: readonly string[],
  observed: ReadonlyMap<string, { status: number | null }>,
  refused: ReadonlySet<string> = new Set(),
): SitemapReachability {
  const out: SitemapReachability = {
    reachable: [],
    unreachable: [],
    unchecked: [],
    refused: [],
  };
  for (const url of declared) {
    if (refused.has(url)) {
      out.refused.push(url);
      continue;
    }
    const seen = observed.get(url);
    if (seen === undefined) {
      out.unchecked.push(url);
      continue;
    }
    if (seen.status === null) {
      out.unreachable.push({
        url,
        status: null,
        detail: 'declared in a sitemap; the request did not complete',
      });
      continue;
    }
    if (seen.status >= 400) {
      out.unreachable.push({
        url,
        status: seen.status,
        detail: `declared in a sitemap; the server answered ${seen.status}`,
      });
      continue;
    }
    out.reachable.push(url);
  }
  return out;
}

/**
 * Sitemap staleness, with the undated entries kept separate.
 *
 * An entry with no `<lastmod>` is NOT fresh — it is undated, and folding it
 * into either bucket would be inventing a date. The split is the whole value of
 * the function: "48 routes have not changed in two years, and 300 carry no date
 * at all" is actionable, and "48 stale" with the other 300 silently counted as
 * current is not.
 */
export function sitemapStaleness(
  entries: readonly SitemapEntry[],
  options: { now: Date; staleAfterDays: number },
): {
  stale: SitemapEntry[];
  fresh: number;
  undated: number;
  unparseableDates: number;
} {
  const cutoff = options.now.getTime() - options.staleAfterDays * 24 * 60 * 60 * 1_000;
  const stale: SitemapEntry[] = [];
  let fresh = 0;
  let undated = 0;
  let unparseableDates = 0;

  for (const entry of entries) {
    if (entry.lastmod === null) {
      undated += 1;
      continue;
    }
    const parsed = Date.parse(entry.lastmod);
    if (!Number.isFinite(parsed)) {
      unparseableDates += 1;
      continue;
    }
    if (parsed < cutoff) stale.push(entry);
    else fresh += 1;
  }

  return { stale, fresh, undated, unparseableDates };
}
