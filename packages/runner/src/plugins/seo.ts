/**
 * SEO and metadata checks (§4 SEO).
 *
 * Entirely absent from this product until now, and the cheapest wide layer
 * after link integrity: every check in this file is deterministic, model-free,
 * needs no browser, and applies to every URL a crawl reached. There is nothing
 * to configure and nothing to guess.
 *
 * Seven checks, and they are NOT of equal worth. In rough order:
 *
 *   ROBOTS_SITEMAP_CONSISTENCY  the valuable one. It cross-checks two
 *     ENUMERATION SOURCES against each other: what the site ADVERTISES (its
 *     sitemap) against what the crawl actually REACHED. Four disagreements are
 *     possible and all four are real defects — a route in the sitemap nobody
 *     can crawl, a route the crawl found that the sitemap never mentions, a
 *     sitemap that advertises a URL robots.txt forbids, and a crawled URL
 *     robots.txt forbids. QAAI is in a unique position to notice these,
 *     because it is the only thing in the stack holding both lists.
 *   CANONICAL        a canonical pointing somewhere else makes the page
 *     invisible, and a canonical loop makes a whole section invisible.
 *   HREFLANG         reciprocity. `en` naming `fr` while `fr` does not name
 *     `en` is the classic one, and it silently halves an international site.
 *   TITLE            missing, empty, or — far more often — the SAME on 300
 *     pages, which is the signal `observe.ts` already looks for on the crawl
 *     side for a different reason.
 *   META_DESCRIPTION missing or duplicated.
 *   OPEN_GRAPH       `og:title`/`og:image` absent, so every share is a blank
 *     card.
 *   JSON_LD          invalid JSON, or valid JSON with no `@type`. A broken
 *     blob is worse than none: the crawler that reads it sees a malformed
 *     entity rather than falling back to the page.
 *
 * ── WHAT THIS FILE DOES NOT DO, deliberately ────────────────────────────────
 *
 * It does not parse HTML. Every per-page field arrives in the spec, already
 * extracted by the crawl that loaded the page — because a second extraction
 * here would read a DIFFERENT document at a DIFFERENT moment, and two surfaces
 * disagreeing about one page's title is a worse outcome than not checking it.
 *
 * It DOES parse robots.txt and the sitemap, because nobody has fetched those
 * for this purpose and they are two documents rather than a page. The parse is
 * deliberately shallow and every limit it has is declared in
 * {@link SITEMAP_PARSE_LIMITS} and reported when it bites.
 *
 * `packages/agent/src/crawl/harvest.ts` has a richer robots/sitemap parser
 * behind `parseRobots` and `sitemapReachability`, and this file does NOT use
 * it: `@qaai/runner` does not depend on `@qaai/agent`, and adding the
 * dependency is a package.json change this round does not own. That overlap is
 * real and is in the handover; it is written down here rather than hidden,
 * because the failure mode of two parsers is that they disagree and nobody
 * knows which one the number came from.
 *
 * ── NO QUERY STRING IS EVER REPORTED ────────────────────────────────────────
 *
 * Comparison uses the full URL — two URLs differing only in their query are two
 * pages — and the PRINTED form has its query and fragment dropped. This
 * plugin's whole input is crawled URLs, and a crawl that reached a
 * password-reset page carries `?token=…` on the page url, on its canonical, on
 * its hreflang alternates and in the sitemap `<loc>` that advertises it; all
 * four reached a step title and a stored result verbatim before `safeUrl`
 * existed. A JSON-LD parse error is withheld for the same reason: V8 quotes a
 * window of the block's own bytes back inside the message. The count of URLs
 * shortened is disclosed.
 *
 * ── Injected transport (rule 8) ─────────────────────────────────────────────
 *
 * One narrow text fetcher, for robots.txt and the sitemap. No network in the
 * tests, and the real adapter reports UNAVAILABLE when absent — never ABSENT,
 * because "this site publishes no sitemap" is a measurement and "we could not
 * ask" is not.
 */

import { z } from 'zod';
import type {
  ConsoleEntry,
  ExecutableTest,
  Finding,
  FindingKind,
  FindingSeverity,
  RunContext,
  StepResult,
  TestExecution,
} from '@qaai/shared';
/*
 * ONE implementation of "a URL as it is safe to print", imported rather than
 * restated. This file's own header says why: the failure mode of two parsers is
 * that they disagree and nobody knows which one the number came from, and that
 * goes double for a redaction — a second copy that drifts is a leak nobody is
 * looking for. `printableUrl` is a pure function over a string with no state
 * and no I/O, so the import couples nothing but the rule itself.
 */
import { printableUrl, scrubUrlsInText } from './links.js';

// ─── The check axis ──────────────────────────────────────────────────────────

/** The seven checks. See the header for why they are in this order. */
export const SEO_CHECKS = [
  'ROBOTS_SITEMAP_CONSISTENCY',
  'CANONICAL',
  'HREFLANG',
  'TITLE',
  'META_DESCRIPTION',
  'OPEN_GRAPH',
  'JSON_LD',
] as const;
export type SeoCheck = (typeof SEO_CHECKS)[number];

/**
 * The compiler-enforced presence record this codebase requires beside a
 * vocabulary with a write path, paired with the run-time parity test in
 * seo.test.ts.
 *
 * `checks` on the spec below is that write path. Both halves exist because
 * eight GateRule kinds shipped unsaveable for two slices when only one of them
 * did: the zod enum accepted a member no branch honoured, and `check:wiring`
 * is structurally unable to see it. A third test asserts every member actually
 * reaches a branch in `runCheck`, which is the failure the other two cannot
 * catch.
 */
export const SEO_CHECK_PRESENCE: Record<SeoCheck, true> = {
  ROBOTS_SITEMAP_CONSISTENCY: true,
  CANONICAL: true,
  HREFLANG: true,
  TITLE: true,
  META_DESCRIPTION: true,
  OPEN_GRAPH: true,
  JSON_LD: true,
};

export const SEO_CHECK_LABELS: Record<SeoCheck, string> = {
  ROBOTS_SITEMAP_CONSISTENCY: 'robots.txt / sitemap.xml consistency with the crawl',
  CANONICAL: 'Canonical URL',
  HREFLANG: 'hreflang reciprocity',
  TITLE: 'Title',
  META_DESCRIPTION: 'Meta description',
  OPEN_GRAPH: 'Open Graph',
  JSON_LD: 'JSON-LD',
};

export const seoCheckSchema = z.enum(SEO_CHECKS);

/** The defects each check can report. Stable codes, prefixed against collision. */
export const SEO_DEFECTS = [
  'TITLE_MISSING',
  'TITLE_DUPLICATE',
  'META_DESCRIPTION_MISSING',
  'META_DESCRIPTION_DUPLICATE',
  'CANONICAL_MISSING',
  'CANONICAL_OFF_SITE',
  'CANONICAL_CHAIN',
  'HREFLANG_NOT_RECIPROCAL',
  'HREFLANG_NO_SELF',
  'OG_INCOMPLETE',
  'JSON_LD_INVALID',
  'JSON_LD_UNTYPED',
  'SITEMAP_URL_NOT_CRAWLED',
  'CRAWLED_URL_NOT_IN_SITEMAP',
  'SITEMAP_URL_DISALLOWED',
  'CRAWLED_URL_DISALLOWED',
] as const;
export type SeoDefect = (typeof SEO_DEFECTS)[number];

/**
 * Which check owns each defect.
 *
 * A `Record` over the whole union rather than a lookup built at run time, so
 * the compiler refuses a new defect that no check claims — the shape in which a
 * defect would be reportable and unreachable at the same time.
 */
export const SEO_DEFECT_CHECK: Record<SeoDefect, SeoCheck> = {
  TITLE_MISSING: 'TITLE',
  TITLE_DUPLICATE: 'TITLE',
  META_DESCRIPTION_MISSING: 'META_DESCRIPTION',
  META_DESCRIPTION_DUPLICATE: 'META_DESCRIPTION',
  CANONICAL_MISSING: 'CANONICAL',
  CANONICAL_OFF_SITE: 'CANONICAL',
  CANONICAL_CHAIN: 'CANONICAL',
  HREFLANG_NOT_RECIPROCAL: 'HREFLANG',
  HREFLANG_NO_SELF: 'HREFLANG',
  OG_INCOMPLETE: 'OPEN_GRAPH',
  JSON_LD_INVALID: 'JSON_LD',
  JSON_LD_UNTYPED: 'JSON_LD',
  SITEMAP_URL_NOT_CRAWLED: 'ROBOTS_SITEMAP_CONSISTENCY',
  CRAWLED_URL_NOT_IN_SITEMAP: 'ROBOTS_SITEMAP_CONSISTENCY',
  SITEMAP_URL_DISALLOWED: 'ROBOTS_SITEMAP_CONSISTENCY',
  CRAWLED_URL_DISALLOWED: 'ROBOTS_SITEMAP_CONSISTENCY',
};

export const SEO_DEFECT_SEVERITY: Record<SeoDefect, FindingSeverity> = {
  // A page that points its canonical at another site asks search engines not to
  // index it at all. Nothing else here costs that much.
  CANONICAL_OFF_SITE: 'SERIOUS',
  CANONICAL_CHAIN: 'SERIOUS',
  SITEMAP_URL_DISALLOWED: 'SERIOUS',
  JSON_LD_INVALID: 'MODERATE',
  HREFLANG_NOT_RECIPROCAL: 'MODERATE',
  TITLE_MISSING: 'MODERATE',
  TITLE_DUPLICATE: 'MODERATE',
  SITEMAP_URL_NOT_CRAWLED: 'MODERATE',
  CRAWLED_URL_DISALLOWED: 'MODERATE',
  CANONICAL_MISSING: 'MINOR',
  META_DESCRIPTION_MISSING: 'MINOR',
  META_DESCRIPTION_DUPLICATE: 'MINOR',
  HREFLANG_NO_SELF: 'MINOR',
  OG_INCOMPLETE: 'MINOR',
  JSON_LD_UNTYPED: 'MINOR',
  CRAWLED_URL_NOT_IN_SITEMAP: 'MINOR',
};

/**
 * Which defects become a `Finding` row.
 *
 * None of them, today, and that is a statement rather than an oversight.
 * `FINDING_KINDS` has five members — ACCESSIBILITY, SECURITY, PERFORMANCE,
 * LOCALIZATION, VISUAL — and not one of them is SEO. The nearest miss is
 * LOCALIZATION for the hreflang defects, and it is still a miss: hreflang
 * reciprocity is a crawler-visibility defect, not a translation defect, and
 * filing it under LOCALIZATION would put an SEO count into the number a
 * localisation gate reads.
 *
 * So every defect here is reported as a FAILED step with its code, its subject
 * and its reason, which loses the cross-run dedupe `Finding.code` gives and
 * nothing else. The handover for this round asks for an `SEO` member of
 * `FINDING_KINDS` (shared + the Prisma enum + a migration, none of which this
 * change owns); when it lands, this map is the only place that changes, and
 * `runSeoChecks` already files a Finding for every defect whose entry is not
 * null.
 */
export const SEO_DEFECT_FINDING_KIND: Record<SeoDefect, FindingKind | null> = {
  TITLE_MISSING: null,
  TITLE_DUPLICATE: null,
  META_DESCRIPTION_MISSING: null,
  META_DESCRIPTION_DUPLICATE: null,
  CANONICAL_MISSING: null,
  CANONICAL_OFF_SITE: null,
  CANONICAL_CHAIN: null,
  HREFLANG_NOT_RECIPROCAL: null,
  HREFLANG_NO_SELF: null,
  OG_INCOMPLETE: null,
  JSON_LD_INVALID: null,
  JSON_LD_UNTYPED: null,
  SITEMAP_URL_NOT_CRAWLED: null,
  CRAWLED_URL_NOT_IN_SITEMAP: null,
  SITEMAP_URL_DISALLOWED: null,
  CRAWLED_URL_DISALLOWED: null,
};

/** Stable code per defect, for a report and for the Finding row when one exists. */
export function seoDefectCode(defect: SeoDefect): string {
  return `seo-${defect.toLowerCase().replace(/_/g, '-')}`;
}

// ─── The spec ────────────────────────────────────────────────────────────────

/**
 * One page's metadata, as the crawl extracted it.
 *
 * Every field is NULLABLE and null means ABSENT FROM THE DOCUMENT — a real
 * measurement. A page the crawl never loaded must not appear in this list at
 * all; a row of nulls would be reported as a page with no title, which is the
 * opposite of the truth.
 */
export const seoPageSchema = z.object({
  url: z.string().min(1).max(4000),
  title: z.string().max(2000).nullable().default(null),
  metaDescription: z.string().max(4000).nullable().default(null),
  /** `<link rel="canonical">` as written. Resolved against `url`. */
  canonical: z.string().max(4000).nullable().default(null),
  /** `<link rel="alternate" hreflang>` pairs, as written. */
  hreflang: z
    .array(z.object({ lang: z.string().min(1).max(50), href: z.string().min(1).max(4000) }))
    .default([]),
  /** `og:*` properties, keyed WITHOUT the prefix: `title`, `image`, `type`… */
  openGraph: z.record(z.string(), z.string()).default({}),
  /** Every `<script type="application/ld+json">` body, verbatim and unparsed. */
  jsonLd: z.array(z.string().max(100_000)).default([]),
  /**
   * Whether this page is indexable at all, when the crawl saw a `robots` meta
   * or an `X-Robots-Tag`. A `noindex` page is EXEMPT from the metadata checks:
   * reporting a missing title on a page the site has asked nobody to index is
   * noise, and noise is what gets a report ignored.
   */
  noindex: z.boolean().default(false),
});
export type SeoPage = z.infer<typeof seoPageSchema>;

export const seoTestSpecSchema = z.object({
  pages: z.array(seoPageSchema).min(1),
  checks: z
    .array(seoCheckSchema)
    .min(1)
    .default([...SEO_CHECKS]),
  /**
   * Where robots.txt lives, relative to the base URL. Spelled out rather than
   * assumed so a test can point at a staging path.
   */
  robotsPath: z.string().min(1).max(500).default('/robots.txt'),
  /**
   * Sitemaps to read when robots.txt names none. `/sitemap.xml` is the
   * convention; when robots.txt DOES name sitemaps, those win, because the site
   * is stating where they are.
   */
  sitemapPaths: z.array(z.string().min(1).max(500)).default(['/sitemap.xml']),
  /** Sitemap documents to fetch, including nested indexes. A disclosed cap. */
  maxSitemapDocuments: z.number().int().min(1).max(200).default(10),
  /** `<loc>` entries to keep per document. A disclosed cap. */
  maxSitemapUrls: z.number().int().min(1).max(200_000).default(50_000),
  /**
   * Report crawled URLs that the sitemap does not list.
   *
   * Default FALSE, and the default is the honest one: a sitemap is not required
   * to be exhaustive, and a site that deliberately omits its filtered listing
   * pages from the sitemap would otherwise get thousands of findings for doing
   * the right thing. On for a site that intends its sitemap to be complete.
   */
  requireSitemapCompleteness: z.boolean().default(false),
  /** Examples listed per aggregated defect. The TRUE count is always reported. */
  maxExamplesPerDefect: z.number().int().min(1).max(500).default(20),
});
export type SeoTestSpec = z.infer<typeof seoTestSpecSchema>;

// ─── The injected transport ──────────────────────────────────────────────────

/**
 * One fetched text document.
 *
 * Three states, and they must never merge: PRESENT (we read it), ABSENT (the
 * server answered and there is nothing there — a fact about the site), and
 * UNAVAILABLE (we could not find out — a fact about us).
 */
export type TextDocument =
  | { state: 'PRESENT'; body: string }
  | { state: 'ABSENT'; detail: string }
  | { state: 'UNAVAILABLE'; detail: string };

export interface SeoTextFetcher {
  fetchText(url: string, signal: AbortSignal): Promise<TextDocument>;
}

export interface SeoDeps {
  fetcher: SeoTextFetcher;
}

/**
 * The fetcher this plugin uses when nothing configured one.
 *
 * UNAVAILABLE, never ABSENT. The difference is the whole discipline of this
 * module: an ABSENT robots.txt means "this site publishes none", which is a
 * measurement somebody could act on, and claiming it on the strength of having
 * no fetcher would be a measurement we did not make.
 */
export const unavailableSeoFetcher: SeoTextFetcher = {
  fetchText() {
    return Promise.resolve({
      state: 'UNAVAILABLE' as const,
      detail:
        'No text fetcher is configured for this environment, so robots.txt and the sitemap were ' +
        'not read. This is NOT "this site publishes none" — nothing was measured.',
    });
  },
};

// ─── robots.txt ──────────────────────────────────────────────────────────────

/**
 * What robots.txt says, for the `*` group.
 *
 * Only the `*` group, deliberately: QAAI is not Googlebot and must not claim to
 * evaluate the rules written for one. A site that disallows `*` from a route it
 * also puts in its sitemap has a self-contradiction regardless of which crawler
 * is reading.
 */
export interface RobotsFacts {
  sitemaps: string[];
  disallow: string[];
  allow: string[];
  /** Lines the parse did not understand. Reported, never dropped. */
  unparsed: string[];
  availability: 'PRESENT' | 'ABSENT' | 'UNAVAILABLE';
  detail: string | null;
}

export const EMPTY_ROBOTS_FACTS: RobotsFacts = {
  sitemaps: [],
  disallow: [],
  allow: [],
  unparsed: [],
  availability: 'UNAVAILABLE',
  detail: 'robots.txt was not read',
};

/**
 * Parse the `*` group out of a robots.txt body.
 *
 * Shallow on purpose, and the shallowness is declared: consecutive
 * `User-agent:` lines form one group (the specification says so and real files
 * rely on it), `Sitemap:` is global and collected wherever it appears, and
 * anything else is pushed to `unparsed` rather than guessed at.
 */
export function parseRobotsForAll(body: string, baseUrl: string): RobotsFacts {
  const sitemaps: string[] = [];
  const disallow: string[] = [];
  const allow: string[] = [];
  const unparsed: string[] = [];

  let agents: string[] = [];
  let previousLineWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') {
      previousLineWasAgent = false;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      unparsed.push(line);
      previousLineWasAgent = false;
      continue;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    switch (field) {
      case 'user-agent': {
        // A User-agent line directly after another EXTENDS the group; one after
        // a rule STARTS a new group. Getting this backwards silently applies
        // another crawler's rules to `*`.
        agents = previousLineWasAgent ? [...agents, value.toLowerCase()] : [value.toLowerCase()];
        previousLineWasAgent = true;
        break;
      }
      case 'sitemap': {
        try {
          sitemaps.push(new URL(value, baseUrl).toString());
        } catch {
          unparsed.push(line);
        }
        previousLineWasAgent = false;
        break;
      }
      case 'disallow':
      case 'allow': {
        previousLineWasAgent = false;
        if (!agents.includes('*')) break;
        // An empty `Disallow:` means "nothing is disallowed" and is NOT a rule
        // forbidding the empty path. Dropping that distinction forbids the
        // whole site.
        if (value === '') break;
        (field === 'disallow' ? disallow : allow).push(value);
        break;
      }
      default: {
        // crawl-delay, host, clean-param and anything a vendor invented. Named
        // rather than dropped, so a file QAAI half-understood says so.
        unparsed.push(line);
        previousLineWasAgent = false;
      }
    }
  }

  return { sitemaps, disallow, allow, unparsed, availability: 'PRESENT', detail: null };
}

/**
 * Does the `*` group forbid this path?
 *
 * Prefix matching with `*` and `$`, and LONGEST-MATCH-WINS between Allow and
 * Disallow, which is what every major crawler implements. A naive "any
 * Disallow matches" would report `Disallow: /admin` + `Allow: /admin/public` as
 * forbidding a page the site explicitly permits.
 */
export function robotsForbids(facts: RobotsFacts, pathname: string): boolean {
  const match = (pattern: string): number => {
    if (pattern === '') return -1;
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const escaped = body
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const re = new RegExp(`^${escaped}${anchored ? '$' : ''}`);
    return re.test(pathname) ? body.length : -1;
  };

  let longestDisallow = -1;
  for (const pattern of facts.disallow) longestDisallow = Math.max(longestDisallow, match(pattern));
  if (longestDisallow < 0) return false;

  let longestAllow = -1;
  for (const pattern of facts.allow) longestAllow = Math.max(longestAllow, match(pattern));

  // A tie goes to Allow, which is what the crawlers do: an explicit permission
  // as specific as the prohibition is the site saying "this one is fine".
  return longestDisallow > longestAllow;
}

// ─── sitemap.xml ─────────────────────────────────────────────────────────────

/**
 * Everything this parse cannot do, named in one place.
 *
 * Exported so the result can print it: a reader who sees "the sitemap lists 40
 * URLs" is entitled to know whether the parser could have seen 40,000. Each of
 * these is a limit of the PARSER, not a fact about the site, and the result
 * says which.
 */
export const SITEMAP_PARSE_LIMITS: readonly string[] = [
  'a gzipped sitemap (.xml.gz) is not decompressed and reads as UNAVAILABLE',
  'only <loc> is read; <lastmod>, <changefreq> and <priority> are ignored here',
  'a sitemap index is followed one level deep, bounded by maxSitemapDocuments',
  'non-XML bodies are UNAVAILABLE, never "no URLs"',
];

export interface SitemapDocument {
  url: string;
  /** `<loc>` values, absolute. */
  locs: string[];
  /** `<sitemap><loc>` values when the document is an index. */
  children: string[];
  /** Entries dropped by `maxSitemapUrls`, with the count. */
  truncated: number;
  state: 'PRESENT' | 'ABSENT' | 'UNAVAILABLE';
  detail: string | null;
}

/**
 * Pull `<loc>` out of a sitemap or sitemap index.
 *
 * A regex rather than an XML parser, and the trade is deliberate: a real parser
 * is a dependency this package does not have (package.json is not this change's
 * to edit), and `<loc>` is the one element whose shape is fixed by the sitemap
 * protocol. A body that contains no `<urlset` and no `<sitemapindex` is
 * UNAVAILABLE — "not XML we recognise" — and never "a sitemap with no URLs",
 * because the second is a fact about the site and we did not establish it.
 */
export function parseSitemap(
  body: string,
  url: string,
  options: { maxUrls: number },
): SitemapDocument {
  const isIndex = /<sitemapindex[\s>]/i.test(body);
  const isUrlSet = /<urlset[\s>]/i.test(body);
  if (!isIndex && !isUrlSet) {
    return {
      url,
      locs: [],
      children: [],
      truncated: 0,
      state: 'UNAVAILABLE',
      detail:
        'the body contains neither <urlset> nor <sitemapindex>, so it is not a sitemap this ' +
        'parser recognises. This is NOT "the sitemap is empty".',
    };
  }

  const found: string[] = [];
  let truncated = 0;
  for (const match of body.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)) {
    const raw = match[1];
    if (raw === undefined) continue;
    let absolute: string;
    try {
      const resolved = new URL(decodeXmlEntities(raw), url);
      resolved.hash = '';
      absolute = resolved.toString();
    } catch {
      continue;
    }
    if (found.length >= options.maxUrls) {
      truncated += 1;
      continue;
    }
    found.push(absolute);
  }

  return {
    url,
    locs: isIndex ? [] : found,
    children: isIndex ? found : [],
    truncated,
    state: 'PRESENT',
    detail: null,
  };
}

/** The five XML entities a `<loc>` is allowed to carry. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export interface SitemapHarvest {
  /** Every URL the site advertises, deduped. */
  urls: string[];
  documents: SitemapDocument[];
  /** Documents not fetched because `maxSitemapDocuments` bit. */
  skippedDocuments: string[];
  /** Entries dropped by `maxSitemapUrls`, across all documents. */
  truncatedUrls: number;
  /** True when NO document could be read, so `urls` is not a measurement. */
  unavailable: boolean;
}

/**
 * Fetch the sitemaps, following an index one level deep.
 *
 * `unavailable` is the field that matters. When every document failed, `urls`
 * is empty and that empty list means NOTHING — comparing a crawl against it
 * would report every crawled URL as missing from the sitemap, which is a
 * thousand findings produced by one failed request.
 */
export async function harvestSitemaps(
  roots: readonly string[],
  fetcher: SeoTextFetcher,
  options: { maxDocuments: number; maxUrls: number },
  signal: AbortSignal,
): Promise<SitemapHarvest> {
  const documents: SitemapDocument[] = [];
  const skippedDocuments: string[] = [];
  const queue = [...roots];
  const seen = new Set<string>(roots);
  const urls = new Set<string>();
  let truncatedUrls = 0;
  let anyPresent = false;

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    if (signal.aborted) {
      skippedDocuments.push(next);
      continue;
    }
    if (documents.length >= options.maxDocuments) {
      skippedDocuments.push(next);
      continue;
    }

    const fetched = await fetcher.fetchText(next, signal);
    if (fetched.state !== 'PRESENT') {
      documents.push({
        url: next,
        locs: [],
        children: [],
        truncated: 0,
        state: fetched.state,
        detail: fetched.detail,
      });
      continue;
    }

    const parsed = parseSitemap(fetched.body, next, { maxUrls: options.maxUrls });
    documents.push(parsed);
    if (parsed.state === 'PRESENT') anyPresent = true;
    truncatedUrls += parsed.truncated;
    for (const loc of parsed.locs) urls.add(loc);
    for (const child of parsed.children) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }

  return {
    urls: [...urls].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    documents,
    skippedDocuments,
    truncatedUrls,
    unavailable: !anyPresent,
  };
}

// ─── The checks ──────────────────────────────────────────────────────────────

export interface SeoIssue {
  defect: SeoDefect;
  /** The deduped subject: a URL, or the duplicated title/description. */
  subject: string;
  /** How many pages share this defect. One row, N occurrences. */
  occurrenceCount: number;
  /** Example pages, already capped. Never use its length as the count. */
  examples: string[];
  detail: string;
}

/**
 * A check's outcome. Four states, and the last two are why this type exists.
 *
 * NOT_MEASURED is for a check whose denominator was zero or whose input was
 * UNAVAILABLE. It is NOT `RAN` with no issues: "every page has a title" and
 * "no page was eligible for the title check" are different sentences, and a
 * product whose only asset is a number cannot afford to print the first when
 * the second is true.
 */
export type CheckOutcome = 'CLEAN' | 'ISSUES' | 'NOT_MEASURED' | 'NOT_REQUESTED';

export interface CheckResult {
  check: SeoCheck;
  outcome: CheckOutcome;
  /** How many pages (or URLs) the check actually considered. */
  denominator: number;
  issues: SeoIssue[];
  /** Printable verbatim. On NOT_MEASURED it says what was missing. */
  detail: string;
}

/** Pages a metadata check applies to: the ones the site wants indexed. */
export function indexablePages(pages: readonly SeoPage[]): SeoPage[] {
  return pages.filter((page) => !page.noindex);
}

/**
 * A URL as it is safe to PRINT. See `printableUrl` in ./links.ts for the whole
 * of the reasoning; the short version is that this plugin's inputs are crawled
 * URLs, and a crawl that reached a password-reset page carries `?token=…` on
 * the page URL, on its canonical, on its hreflang alternates and in the
 * sitemap `<loc>` that advertises it. Every one of those reached a step title
 * and a `Finding.location` verbatim before this, measured and confirmed.
 *
 * Comparison and grouping still use the FULL URL: two URLs differing only in
 * their query are two pages, and collapsing them would merge two titles into a
 * duplicate that does not exist.
 */
function safeUrl(raw: string): string {
  return printableUrl(raw).url;
}

function safeUrls(urls: readonly string[]): string[] {
  return urls.map(safeUrl);
}

/** True when this URL would lose something on the way to the report. */
function carriesQuery(raw: string): boolean {
  return printableUrl(raw).dropped;
}

/**
 * One URL, in the one form every comparison in this file uses.
 *
 * Null when it cannot be parsed, which is UNKNOWN and never a defect.
 *
 * Exists because comparing a raw crawled URL against a resolved one is the
 * source of the two hreflang false findings described in that check: `URL`
 * normalises (`https://x.test` → `https://x.test/`, default ports dropped,
 * host lower-cased) and a raw string does not, so one side of the comparison
 * was normalised and the other was not. Every `===`, every `Set.has` and every
 * `Map` key below goes through here, on both sides.
 */
/**
 * Just the position out of a JSON parse error, with the quoted input dropped.
 *
 * Empty when the parser gave no position, which is honest: an empty string
 * says "no position was reported" rather than inventing `at position 0`.
 */
function jsonErrorPosition(err: unknown): string {
  if (!(err instanceof Error)) return '';
  const at = /\bat position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(err.message);
  if (at === null) return '';
  return at[2] === undefined
    ? ` (at position ${at[1]})`
    : ` (at line ${at[2]}, column ${at[3]})`;
}

function normaliseUrl(raw: string, base?: string): string | null {
  try {
    const url = base === undefined ? new URL(raw) : new URL(raw, base);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function examples(urls: readonly string[], cap: number): string[] {
  return safeUrls(urls.slice(0, cap));
}

/**
 * Group pages by a field's value and report the values more than one page
 * shares.
 *
 * Exported because the duplicate-title check is the one customers argue with,
 * and "300 pages all titled Home" is the single most common real SEO defect in
 * a generated site.
 */
export function duplicatesByValue(
  pages: readonly SeoPage[],
  value: (page: SeoPage) => string | null,
): Array<{ value: string; urls: string[] }> {
  const byValue = new Map<string, string[]>();
  for (const page of pages) {
    const raw = value(page);
    if (raw === null) continue;
    const key = raw.trim();
    if (key === '') continue;
    const bucket = byValue.get(key);
    if (bucket === undefined) byValue.set(key, [page.url]);
    else bucket.push(page.url);
  }
  return [...byValue.entries()]
    .filter(([, urls]) => urls.length > 1)
    .map(([value_, urls]) => ({ value: value_, urls }))
    .sort((left, right) =>
      right.urls.length !== left.urls.length
        ? right.urls.length - left.urls.length
        : left.value < right.value
          ? -1
          : 1,
    );
}

/** Open Graph properties a share card cannot be built without. */
export const REQUIRED_OG_PROPERTIES: readonly string[] = ['title', 'image'];

/**
 * Run one check. Exhaustive over `SeoCheck` by its return type, so a new member
 * of the union cannot be added without a branch here.
 */
export function runCheck(
  check: SeoCheck,
  spec: SeoTestSpec,
  context: { baseUrl: string; robots: RobotsFacts; sitemap: SitemapHarvest | null },
): CheckResult {
  const cap = spec.maxExamplesPerDefect;
  const eligible = indexablePages(spec.pages);
  const noindexCount = spec.pages.length - eligible.length;
  const exempt =
    noindexCount === 0 ? '' : ` ${noindexCount} noindex page(s) were exempt from this check.`;

  const finish = (denominator: number, issues: SeoIssue[], clean: string): CheckResult => ({
    check,
    outcome: denominator === 0 ? 'NOT_MEASURED' : issues.length > 0 ? 'ISSUES' : 'CLEAN',
    denominator,
    issues,
    detail:
      denominator === 0
        ? `no page or URL was eligible for this check, so nothing is claimed about it.${exempt}`
        : issues.length > 0
          ? `${issues.length} distinct defect(s) over ${denominator} page(s).${exempt}`
          : `${clean} (${denominator} page(s) checked).${exempt}`,
  });

  switch (check) {
    case 'TITLE': {
      const issues: SeoIssue[] = [];
      const missing = eligible.filter((p) => (p.title ?? '').trim() === '');
      if (missing.length > 0) {
        issues.push({
          defect: 'TITLE_MISSING',
          subject: '(no <title>)',
          occurrenceCount: missing.length,
          examples: examples(
            missing.map((p) => p.url),
            cap,
          ),
          detail: 'the document has no title, or its title is empty',
        });
      }
      for (const duplicate of duplicatesByValue(eligible, (p) => p.title)) {
        issues.push({
          defect: 'TITLE_DUPLICATE',
          subject: duplicate.value,
          occurrenceCount: duplicate.urls.length,
          examples: examples(duplicate.urls, cap),
          detail: `${duplicate.urls.length} pages share this exact title`,
        });
      }
      return finish(eligible.length, issues, 'every page has its own non-empty title');
    }

    case 'META_DESCRIPTION': {
      const issues: SeoIssue[] = [];
      const missing = eligible.filter((p) => (p.metaDescription ?? '').trim() === '');
      if (missing.length > 0) {
        issues.push({
          defect: 'META_DESCRIPTION_MISSING',
          subject: '(no meta description)',
          occurrenceCount: missing.length,
          examples: examples(
            missing.map((p) => p.url),
            cap,
          ),
          detail: 'the document has no meta description, so the search result snippet is guessed',
        });
      }
      for (const duplicate of duplicatesByValue(eligible, (p) => p.metaDescription)) {
        issues.push({
          defect: 'META_DESCRIPTION_DUPLICATE',
          subject: duplicate.value.slice(0, 120),
          occurrenceCount: duplicate.urls.length,
          examples: examples(duplicate.urls, cap),
          detail: `${duplicate.urls.length} pages share this exact meta description`,
        });
      }
      return finish(eligible.length, issues, 'every page has its own meta description');
    }

    case 'CANONICAL': {
      const issues: SeoIssue[] = [];
      const canonicalOf = new Map<string, string>();
      for (const page of eligible) {
        if (page.canonical === null || page.canonical.trim() === '') {
          issues.push({
            defect: 'CANONICAL_MISSING',
            subject: safeUrl(page.url),
            occurrenceCount: 1,
            examples: [safeUrl(page.url)],
            detail: 'no <link rel="canonical">, so duplicate URLs of this page compete',
          });
          continue;
        }
        let resolved: URL;
        try {
          resolved = new URL(page.canonical, page.url);
        } catch {
          issues.push({
            defect: 'CANONICAL_OFF_SITE',
            subject: safeUrl(page.url),
            occurrenceCount: 1,
            examples: [safeUrl(page.url)],
            detail: `the canonical "${safeUrl(page.canonical)}" could not be parsed as a URL`,
          });
          continue;
        }
        resolved.hash = '';
        /*
         * Keyed on the NORMALISED page URL, not the raw one. `new URL()` gives
         * back `https://x.test/` for `https://x.test`, so a map keyed on the
         * raw string and read with a resolved one misses — and the chain check
         * below then compares a resolved target against a raw key and cannot
         * find the hop it is looking for. Both sides through one normaliser.
         */
        canonicalOf.set(normaliseUrl(page.url) ?? page.url, resolved.toString());

        const baseOrigin = ((): string | null => {
          try {
            return new URL(context.baseUrl).origin;
          } catch {
            return null;
          }
        })();
        if (baseOrigin !== null && resolved.origin !== baseOrigin) {
          issues.push({
            defect: 'CANONICAL_OFF_SITE',
            subject: safeUrl(page.url),
            occurrenceCount: 1,
            examples: [safeUrl(page.url)],
            detail:
              `the canonical points at ${safeUrl(resolved.toString())}, on another origin — ` +
              'this asks search engines not to index this page at all',
          });
        }
      }

      /*
       * A canonical CHAIN: A canonicalises to B and B canonicalises to C.
       * Crawlers do not follow chains, so every page after the first hop is
       * dropped. Only reported when the intermediate page is one we have
       * metadata for — a canonical pointing at a page we never loaded is not
       * evidence of a chain.
       */
      for (const [url, target] of canonicalOf) {
        if (target === url) continue;
        const onward = canonicalOf.get(target);
        if (onward !== undefined && onward !== target) {
          issues.push({
            defect: 'CANONICAL_CHAIN',
            subject: safeUrl(url),
            occurrenceCount: 1,
            examples: safeUrls([url, target, onward]),
            detail:
              `canonical chain: ${safeUrl(url)} → ${safeUrl(target)} → ${safeUrl(onward)}. ` +
              'Crawlers do not follow chains, so this page is dropped rather than consolidated',
          });
        }
      }
      return finish(eligible.length, issues, 'every page declares a canonical on this origin');
    }

    case 'HREFLANG': {
      /*
       * Reciprocity, which is the only hreflang rule worth machine-checking: if
       * `/en` names `/fr`, then `/fr` must name `/en`, or search engines ignore
       * the whole cluster. The DENOMINATOR is the pages that declare hreflang
       * at all — a site with no hreflang is not failing this check, it is not
       * taking it, and scoring it 0% would be an unmeasured axis reported as a
       * number.
       */
      /*
       * ── THE FALSE FINDING THIS NORMALISATION REMOVES ───────────────────────
       *
       * Both sides of every comparison go through `normaliseUrl`, including the
       * page's OWN url. They did not before, and the asymmetry invented
       * defects on a cluster that was perfectly correct: `new URL()` returns
       * `https://x.test/` for `https://x.test`, so a page whose crawled URL is
       * origin-only failed the self-reference test against its own resolved
       * alternate, and its partner then failed reciprocity against it. Two
       * SERIOUS-looking findings, on a site with nothing wrong with it,
       * reproduced on a two-page fixture. Teams that get those stop reading the
       * rest of the report.
       */
      const declaring = eligible.filter((p) => p.hreflang.length > 0);
      const issues: SeoIssue[] = [];
      const alternatesOf = new Map<string, Set<string>>();
      const selfOf = new Map<string, string>();
      for (const page of declaring) {
        const self = normaliseUrl(page.url) ?? page.url;
        selfOf.set(page.url, self);
        const set = new Set<string>();
        for (const alternate of page.hreflang) {
          const url = normaliseUrl(alternate.href, page.url);
          if (url !== null) set.add(url);
        }
        alternatesOf.set(self, set);
      }

      for (const page of declaring) {
        const self = selfOf.get(page.url) ?? page.url;
        const mine = alternatesOf.get(self) ?? new Set<string>();
        if (!mine.has(self)) {
          issues.push({
            defect: 'HREFLANG_NO_SELF',
            subject: safeUrl(page.url),
            occurrenceCount: 1,
            examples: [safeUrl(page.url)],
            detail:
              'the hreflang cluster does not include a self-referential entry, which the ' +
              'specification requires for the cluster to be honoured',
          });
        }
        for (const other of mine) {
          if (other === self) continue;
          const theirs = alternatesOf.get(other);
          // Only a page we HAVE metadata for can be shown not to reciprocate.
          // Absent metadata is UNKNOWN and must not be reported as a defect.
          if (theirs === undefined) continue;
          if (!theirs.has(self)) {
            issues.push({
              defect: 'HREFLANG_NOT_RECIPROCAL',
              subject: `${safeUrl(page.url)} → ${safeUrl(other)}`,
              occurrenceCount: 1,
              examples: safeUrls([page.url, other]),
              detail:
                `${safeUrl(page.url)} names ${safeUrl(other)} as an alternate and it does not ` +
                'name it back, so search engines ignore the whole cluster',
            });
          }
        }
      }
      return finish(declaring.length, issues, 'every hreflang cluster is reciprocal');
    }

    case 'OPEN_GRAPH': {
      const issues: SeoIssue[] = [];
      for (const page of eligible) {
        const missing = REQUIRED_OG_PROPERTIES.filter(
          (property) => (page.openGraph[property] ?? '').trim() === '',
        );
        if (missing.length > 0) {
          issues.push({
            defect: 'OG_INCOMPLETE',
            subject: safeUrl(page.url),
            occurrenceCount: 1,
            examples: [safeUrl(page.url)],
            detail: `og:${missing.join(', og:')} absent — a share of this page renders blank`,
          });
        }
      }
      return finish(eligible.length, issues, 'every page carries og:title and og:image');
    }

    case 'JSON_LD': {
      /*
       * The denominator is the pages that ship a JSON-LD block. A site with
       * none is not failing — structured data is optional — and a 0% here would
       * be an unmeasured axis wearing a percentage.
       */
      const carrying = eligible.filter((p) => p.jsonLd.length > 0);
      const issues: SeoIssue[] = [];
      for (const page of carrying) {
        for (const [index, block] of page.jsonLd.entries()) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(block);
          } catch (err) {
            issues.push({
              defect: 'JSON_LD_INVALID',
              subject: `${safeUrl(page.url)} #${index + 1}`,
              occurrenceCount: 1,
              examples: [safeUrl(page.url)],
              /*
               * The parser's own message is NOT forwarded. V8 quotes a window
               * of the input back at you — `Unexpected token '}',
               * ..."EY-9","x":}" is not valid JSON` — so a credential sitting
               * near the syntax error ends up in a step title and a stored
               * result. The POSITION is what a developer needs to find it, and
               * the position is all this reports.
               */
              detail:
                `the ld+json block is not valid JSON${jsonErrorPosition(err)} — a malformed ` +
                'entity is worse than none, because the crawler stops at it. The parser’s own ' +
                'message is withheld: it quotes the block’s own bytes back, which may be a secret',
            });
            continue;
          }
          const entities = Array.isArray(parsed) ? parsed : [parsed];
          const untyped = entities.filter(
            (entity) =>
              typeof entity !== 'object' ||
              entity === null ||
              typeof (entity as Record<string, unknown>)['@type'] !== 'string',
          );
          if (untyped.length > 0) {
            issues.push({
              defect: 'JSON_LD_UNTYPED',
              subject: `${safeUrl(page.url)} #${index + 1}`,
              occurrenceCount: untyped.length,
              examples: [safeUrl(page.url)],
              detail:
                `${untyped.length} entit(ies) in this block carry no string "@type", so nothing ` +
                'can be done with them',
            });
          }
        }
      }
      return finish(carrying.length, issues, 'every JSON-LD block parses and carries an @type');
    }

    case 'ROBOTS_SITEMAP_CONSISTENCY': {
      /*
       * The cross-check this whole file is worth having for: two independent
       * ENUMERATION SOURCES compared against each other.
       *
       * It is also the check most able to produce a thousand false findings, so
       * each of its four defects is gated on having the evidence for it:
       *
       *  · no readable sitemap → NOT_MEASURED. An empty advertised set would
       *    otherwise make every crawled URL "missing from the sitemap".
       *  · robots.txt UNAVAILABLE → the two `DISALLOWED` defects are skipped
       *    rather than reported as "nothing is disallowed".
       *  · CRAWLED_URL_NOT_IN_SITEMAP is off unless the spec asks, because a
       *    sitemap is not required to be exhaustive.
       */
      const sitemap = context.sitemap;
      const crawled = new Set<string>();
      for (const page of spec.pages) {
        try {
          const url = new URL(page.url);
          url.hash = '';
          crawled.add(url.toString());
        } catch {
          continue;
        }
      }

      if (sitemap === null || sitemap.unavailable) {
        return {
          check,
          outcome: 'NOT_MEASURED',
          denominator: 0,
          issues: [],
          detail:
            'no sitemap could be read, so the advertised URL set is UNKNOWN rather than empty. ' +
            'Nothing is claimed about sitemap/crawl consistency — an empty advertised set would ' +
            `have reported all ${crawled.size} crawled URL(s) as missing from it. ` +
            (sitemap === null
              ? 'No sitemap fetch was attempted.'
              : sitemap.documents
                  .map(
                    (d) =>
                      `${safeUrl(d.url)}: ${d.state}` +
                      (d.detail === null ? '' : ` (${scrubUrlsInText(d.detail)})`),
                  )
                  .join('; ')),
        };
      }

      const advertised = new Set(sitemap.urls);
      const issues: SeoIssue[] = [];
      const robotsReadable = context.robots.availability === 'PRESENT';

      const notCrawled = [...advertised].filter((url) => !crawled.has(url));
      if (notCrawled.length > 0) {
        issues.push({
          defect: 'SITEMAP_URL_NOT_CRAWLED',
          subject: `${notCrawled.length} advertised URL(s)`,
          occurrenceCount: notCrawled.length,
          examples: examples(notCrawled, cap),
          detail:
            'the sitemap advertises these and the crawl never reached them — either they are ' +
            'unreachable by any link, or the crawl stopped short of them. Both are worth knowing',
        });
      }

      if (spec.requireSitemapCompleteness) {
        const notAdvertised = [...crawled].filter((url) => !advertised.has(url));
        if (notAdvertised.length > 0) {
          issues.push({
            defect: 'CRAWLED_URL_NOT_IN_SITEMAP',
            subject: `${notAdvertised.length} crawled URL(s)`,
            occurrenceCount: notAdvertised.length,
            examples: examples(notAdvertised, cap),
            detail:
              'the crawl reached these and the sitemap does not list them, and this test asked ' +
              'for the sitemap to be exhaustive',
          });
        }
      }

      if (robotsReadable) {
        const pathOf = (raw: string): string | null => {
          try {
            const url = new URL(raw);
            return `${url.pathname}${url.search}`;
          } catch {
            return null;
          }
        };
        const forbiddenAdvertised = [...advertised].filter((url) => {
          const path = pathOf(url);
          return path !== null && robotsForbids(context.robots, path);
        });
        if (forbiddenAdvertised.length > 0) {
          issues.push({
            defect: 'SITEMAP_URL_DISALLOWED',
            subject: `${forbiddenAdvertised.length} advertised URL(s)`,
            occurrenceCount: forbiddenAdvertised.length,
            examples: examples(forbiddenAdvertised, cap),
            detail:
              'the sitemap asks crawlers to index these and robots.txt forbids the `*` group ' +
              'from fetching them — the site contradicts itself and the crawler obeys robots.txt',
          });
        }
        const forbiddenCrawled = [...crawled].filter((url) => {
          const path = pathOf(url);
          return path !== null && robotsForbids(context.robots, path);
        });
        if (forbiddenCrawled.length > 0) {
          issues.push({
            defect: 'CRAWLED_URL_DISALLOWED',
            subject: `${forbiddenCrawled.length} crawled URL(s)`,
            occurrenceCount: forbiddenCrawled.length,
            examples: examples(forbiddenCrawled, cap),
            detail:
              'these pages exist and robots.txt forbids the `*` group from them, so no search ' +
              'engine will ever see them. Intentional for an admin area; a defect for anything else',
          });
        }
      }

      /*
       * ── A CLEAN VERDICT OVER NOTHING ──────────────────────────────────────
       *
       * Both sets empty means nothing was COMPARED, and this branch used to
       * return CLEAN for it: a sitemap that parsed but advertised no URL, plus
       * page URLs none of which parsed, produced "No SEO defect found" on a
       * PASSED result. That is the pass that means we did not check, and it got
       * past the zero-denominator rule only because this branch builds its own
       * CheckResult instead of going through `finish`. Confirmed on a fixture
       * before this guard existed.
       *
       * The denominator is the ADVERTISED count and not the two sets added
       * together. They are different units — one is what the site claims, the
       * other is what a crawl reached — and a single number over their sum is
       * the four-incommensurable-denominators mistake in miniature. Both counts
       * are in `detail`, where a reader can see which is which.
       */
      if (advertised.size === 0 && crawled.size === 0) {
        return {
          check,
          outcome: 'NOT_MEASURED',
          denominator: 0,
          issues,
          detail:
            'the sitemap parsed and advertised no URL, and no page URL in this test could be ' +
            'parsed either, so the two sets were never compared. Nothing is claimed about ' +
            'sitemap/crawl consistency — this is NOT a clean result.',
        };
      }

      return {
        check,
        outcome: issues.length > 0 ? 'ISSUES' : 'CLEAN',
        denominator: advertised.size,
        issues,
        detail:
          `${advertised.size} advertised URL(s) compared against ${crawled.size} crawled URL(s)` +
          (robotsReadable
            ? `, with ${context.robots.disallow.length} Disallow rule(s) for \`*\`.`
            : `. robots.txt was ${context.robots.availability}, so the two disallow defects were ` +
              'NOT checked — this is not "nothing is disallowed".') +
          (spec.requireSitemapCompleteness
            ? ''
            : ' `requireSitemapCompleteness` is false, so crawled URLs missing from the sitemap ' +
              'were not reported.'),
      };
    }
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

export interface SeoMeasurement {
  results: CheckResult[];
  robots: RobotsFacts;
  sitemap: SitemapHarvest | null;
  /** Caps that BIT, each as a count and a reason (rule 10). */
  caps: Array<{ cap: string; count: number; reason: string }>;
}

/**
 * Read robots.txt and the sitemaps, then run every requested check.
 *
 * Exported separately from the plugin so the whole measurement runs against a
 * fake fetcher, which is every test in seo.test.ts.
 */
export async function measureSeo(
  spec: SeoTestSpec,
  baseUrl: string,
  deps: SeoDeps,
  signal: AbortSignal,
): Promise<SeoMeasurement> {
  const requested = new Set<SeoCheck>(spec.checks);
  const caps: SeoMeasurement['caps'] = [];
  const needsRobots = requested.has('ROBOTS_SITEMAP_CONSISTENCY');

  let robots: RobotsFacts = EMPTY_ROBOTS_FACTS;
  let sitemap: SitemapHarvest | null = null;

  if (needsRobots) {
    let robotsUrl: string;
    try {
      robotsUrl = new URL(spec.robotsPath, baseUrl).toString();
    } catch {
      robotsUrl = spec.robotsPath;
    }
    const fetched = await deps.fetcher.fetchText(robotsUrl, signal);
    robots =
      fetched.state === 'PRESENT'
        ? parseRobotsForAll(fetched.body, baseUrl)
        : { ...EMPTY_ROBOTS_FACTS, availability: fetched.state, detail: fetched.detail };

    if (robots.unparsed.length > 0) {
      caps.push({
        cap: 'robots.txt lines not understood',
        count: robots.unparsed.length,
        reason:
          `${robots.unparsed.length} line(s) of robots.txt were not understood by this parser ` +
          `and were ignored: ${robots.unparsed.slice(0, 5).join(' | ')}`,
      });
    }

    // robots.txt naming its sitemaps WINS over the convention: the site is
    // stating where they are, and preferring our guess would check a document
    // the site does not use.
    const roots: string[] = [];
    if (robots.sitemaps.length > 0) {
      roots.push(...robots.sitemaps);
    } else {
      for (const path of spec.sitemapPaths) {
        try {
          roots.push(new URL(path, baseUrl).toString());
        } catch {
          continue;
        }
      }
    }

    sitemap = await harvestSitemaps(
      roots,
      deps.fetcher,
      { maxDocuments: spec.maxSitemapDocuments, maxUrls: spec.maxSitemapUrls },
      signal,
    );

    if (sitemap.skippedDocuments.length > 0) {
      caps.push({
        cap: 'maxSitemapDocuments',
        count: sitemap.skippedDocuments.length,
        reason:
          `${sitemap.skippedDocuments.length} sitemap document(s) were NOT read because ` +
          `maxSitemapDocuments is ${spec.maxSitemapDocuments} (or the run was cancelled), so ` +
          'the advertised URL set is a LOWER BOUND rather than the whole of it.',
      });
    }
    if (sitemap.truncatedUrls > 0) {
      caps.push({
        cap: 'maxSitemapUrls',
        count: sitemap.truncatedUrls,
        reason:
          `${sitemap.truncatedUrls} sitemap <loc> entr(ies) were dropped because maxSitemapUrls ` +
          `is ${spec.maxSitemapUrls}. The advertised set is a LOWER BOUND; a crawled URL may be ` +
          'reported as absent from the sitemap when it is only absent from the part we read.',
      });
    }
  }

  /*
   * The redaction, disclosed as a count like every other thing removed from
   * this plugin's answer. A reader comparing a reported URL against their own
   * sitemap has to know why the two do not match character for character; and
   * a reader who assumed QAAI stores whatever it crawls has to know it does
   * not. Counted over every URL that could reach a report.
   */
  const redactable = [
    ...spec.pages.map((page) => page.url),
    ...spec.pages.flatMap((page) => (page.canonical === null ? [] : [page.canonical])),
    ...spec.pages.flatMap((page) => page.hreflang.map((alternate) => alternate.href)),
    ...(sitemap?.urls ?? []),
  ];
  const redacted = redactable.filter(carriesQuery).length;
  if (redacted > 0) {
    caps.push({
      cap: 'query string redaction',
      count: redacted,
      reason:
        `${redacted} URL(s) in this test carried a query string or fragment, which was DROPPED ` +
        'before anything was reported, because a crawled reset page carries a token in one. ' +
        'Comparison still used the full URL, so no two pages were merged by it.',
    });
  }

  const results: CheckResult[] = [];
  for (const check of SEO_CHECKS) {
    if (!requested.has(check)) {
      results.push({
        check,
        outcome: 'NOT_REQUESTED',
        denominator: 0,
        issues: [],
        detail:
          'this test’s `checks` list does not include it, so nothing is claimed about it. ' +
          'Not requested is not clean.',
      });
      continue;
    }
    results.push(runCheck(check, spec, { baseUrl, robots, sitemap }));
  }

  return { results, robots, sitemap, caps };
}

/**
 * Run an SEO test against an injected text fetcher.
 *
 * The status rule, same shape as every other plugin in this directory:
 *
 *   · any issue                 → FAILED.
 *   · no check measured anything → SKIPPED with `notRun`. A green SEO test that
 *                                 read nothing is the lie this file exists to
 *                                 prevent.
 *   · something measured, clean → PASSED, with every NOT_MEASURED check, every
 *                                 NOT_REQUESTED check and every cap disclosed.
 */
export async function runSeoChecks(
  ctx: RunContext,
  test: ExecutableTest,
  spec: SeoTestSpec,
  deps: SeoDeps,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const measurement = await measureSeo(spec, ctx.baseUrl, deps, ctx.signal);

  const steps: StepResult[] = [];
  const findings: Finding[] = [];
  const notes: ConsoleEntry[] = [];

  // durationMs is 0 on every step here on purpose: these are REPORT ROWS over
  // one measurement, not timed operations, and inventing a per-row duration
  // would be a number nothing measured.
  const record = (title: string, status: StepResult['status'], detail: string): void => {
    const index = steps.length;
    ctx.logger.step({ testId: test.id, index, title, status });
    steps.push({
      index,
      title: `${title} — ${detail}`,
      status,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: 0,
      screenshotKey: null,
      error:
        status === 'FAILED'
          ? { message: detail, stack: null, selector: null, expected: null, actual: null }
          : null,
    });
  };

  const allIssues: SeoIssue[] = [];
  for (const result of measurement.results) {
    const label = SEO_CHECK_LABELS[result.check];
    if (result.outcome === 'ISSUES') {
      for (const issue of result.issues) {
        allIssues.push(issue);
        record(
          `${label}: ${issue.defect} — ${issue.subject} (${issue.occurrenceCount} page(s))`,
          'FAILED',
          issue.examples.length > 0
            ? `${issue.detail}. e.g. ${issue.examples.slice(0, 3).join(', ')}`
            : issue.detail,
        );
        const kind = SEO_DEFECT_FINDING_KIND[issue.defect];
        if (kind !== null) {
          findings.push({
            kind,
            severity: SEO_DEFECT_SEVERITY[issue.defect],
            code: seoDefectCode(issue.defect),
            message: `${label}: ${issue.subject} — ${issue.detail}`,
            location: issue.subject,
            helpUrl: null,
          });
        }
      }
      continue;
    }
    // CLEAN is a PASSED step; the two unmeasured outcomes are SKIPPED, because
    // `error` on a step means "this failed" and neither of them did.
    record(label, result.outcome === 'CLEAN' ? 'PASSED' : 'SKIPPED', result.detail);
  }

  for (const cap of measurement.caps) {
    record(`Cap applied: ${cap.cap} (${cap.count})`, 'SKIPPED', cap.reason);
    notes.push({ level: 'warn', text: cap.reason, at: new Date().toISOString() });
  }
  if (
    measurement.robots.availability !== 'PRESENT' &&
    spec.checks.includes('ROBOTS_SITEMAP_CONSISTENCY')
  ) {
    notes.push({
      level: 'warn',
      text:
        `robots.txt was ${measurement.robots.availability}: ` +
        `${measurement.robots.detail ?? 'no reason recorded'}. Parser limits: ` +
        SITEMAP_PARSE_LIMITS.join('; '),
      at: new Date().toISOString(),
    });
  }

  const measured = measurement.results.filter(
    (r) => r.outcome === 'CLEAN' || r.outcome === 'ISSUES',
  );
  const unmeasured = measurement.results.filter((r) => r.outcome === 'NOT_MEASURED');
  const notRequested = measurement.results.filter((r) => r.outcome === 'NOT_REQUESTED');

  const disclosure =
    ` ${measured.length} of ${SEO_CHECKS.length} check(s) measured something.` +
    (unmeasured.length > 0
      ? ` NOT MEASURED (zero denominator or unavailable input): ${unmeasured
          .map((r) => r.check)
          .join(', ')}.`
      : '') +
    (notRequested.length > 0
      ? ` NOT REQUESTED: ${notRequested.map((r) => r.check).join(', ')}.`
      : '') +
    (measurement.caps.length > 0
      ? ` Caps that bit: ${measurement.caps.map((c) => `${c.cap} (${c.count})`).join(', ')}.`
      : '');

  const base = {
    testId: test.id,
    network: [],
    console: notes,
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings,
  } satisfies Omit<TestExecution, 'status' | 'steps' | 'errorMessage' | 'durationMs'>;

  if (allIssues.length > 0) {
    const byDefect = new Map<SeoDefect, number>();
    for (const issue of allIssues) {
      byDefect.set(issue.defect, (byDefect.get(issue.defect) ?? 0) + issue.occurrenceCount);
    }
    return {
      ...base,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      steps,
      errorMessage:
        `${allIssues.length} SEO defect(s): ` +
        [...byDefect.entries()].map(([defect, n]) => `${defect} (${n} page(s))`).join(', ') +
        `.${disclosure}`,
    };
  }

  if (measured.length === 0) {
    const why =
      'No SEO check measured anything, so nothing is claimed about this site’s metadata.' +
      disclosure;
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps,
      /*
       * NOT_RUN, the weakest of the four kinds. BLOCKED_BY_ENV would be a
       * stronger claim than the evidence supports: a page set with no titles to
       * check and no readable sitemap is not proof of a broken environment.
       */
      notRun: { kind: 'NOT_RUN', why },
      errorMessage: why,
    };
  }

  return {
    ...base,
    status: 'PASSED',
    durationMs: Date.now() - startedAt,
    steps,
    errorMessage: `No SEO defect found.${disclosure}`,
  };
}

let deps: SeoDeps = { fetcher: unavailableSeoFetcher };

/** Install the text fetcher. Returns the previous set, so a test restores it. */
export function setSeoDeps(next: SeoDeps): SeoDeps {
  const previous = deps;
  deps = next;
  return previous;
}

export const seoPlugin = {
  type: 'SEO' as const,

  validate(test: ExecutableTest): void {
    const parsed = seoTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`SEO test "${test.name}" has an invalid spec — ${issues}`);
    }

    /*
     * Caught HERE rather than at run time: a test whose every page is noindex
     * and whose only checks are metadata ones can measure NOTHING, and an
     * author who learns that from a SKIPPED result has waited for a run to be
     * told about a mistake they could see.
     */
    const spec = parsed.data;
    const metadataOnly = !spec.checks.includes('ROBOTS_SITEMAP_CONSISTENCY');
    if (metadataOnly && indexablePages(spec.pages).length === 0) {
      throw new Error(
        `SEO test "${test.name}" asks only for metadata checks and every page it lists is ` +
          'noindex, so it could not measure anything. Add an indexable page, or add the ' +
          'ROBOTS_SITEMAP_CONSISTENCY check.',
      );
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runSeoChecks(ctx, test, seoTestSpecSchema.parse(test.spec), deps);
  },
};
