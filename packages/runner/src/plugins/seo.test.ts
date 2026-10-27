/**
 * SEO plugin tests.
 *
 * Most of this file is about the three ways a cheap, wide check layer turns
 * into a liability:
 *
 *  1. A ZERO DENOMINATOR REPORTED AS CLEAN. A site with no hreflang anywhere
 *     must come back NOT_MEASURED, not "every cluster is reciprocal" and
 *     certainly not 0%. Four of the seven checks have a denominator that is
 *     routinely zero, and each one is pinned.
 *  2. AN UNAVAILABLE SITEMAP READ AS AN EMPTY ONE. One failed request would
 *     otherwise report every crawled URL as missing from the sitemap —
 *     thousands of findings produced by a timeout.
 *  3. A CAP THAT BIT IN SILENCE. `maxSitemapUrls` truncating the advertised set
 *     makes a perfectly-listed URL look unlisted, so the advertised set has to
 *     be labelled a LOWER BOUND wherever it is used.
 *
 * No network: the text fetcher is injected, so robots.txt and the sitemap are
 * strings in this file.
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactSink, ExecutableTest, RunContext } from '@qaai/shared';
import {
  EMPTY_ROBOTS_FACTS,
  REQUIRED_OG_PROPERTIES,
  SEO_CHECKS,
  SEO_CHECK_LABELS,
  SEO_CHECK_PRESENCE,
  SEO_DEFECTS,
  SEO_DEFECT_CHECK,
  SEO_DEFECT_FINDING_KIND,
  SEO_DEFECT_SEVERITY,
  SITEMAP_PARSE_LIMITS,
  duplicatesByValue,
  harvestSitemaps,
  indexablePages,
  measureSeo,
  parseRobotsForAll,
  parseSitemap,
  robotsForbids,
  runCheck,
  runSeoChecks,
  seoCheckSchema,
  seoPlugin,
  seoTestSpecSchema,
  unavailableSeoFetcher,
} from './seo.js';
import type { RobotsFacts, SeoTestSpec, SeoTextFetcher, TextDocument } from './seo.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

const BASE = 'https://shop.example.com/';
const never = new AbortController().signal;

/** A fetcher answering from a table. Anything absent is ABSENT (a 404). */
function fakeFetcher(
  table: Record<string, TextDocument | string>,
): SeoTextFetcher & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchText(url) {
      asked.push(url);
      const hit = table[url];
      if (hit === undefined) {
        return Promise.resolve({ state: 'ABSENT' as const, detail: 'the server answered 404' });
      }
      return Promise.resolve(
        typeof hit === 'string' ? { state: 'PRESENT' as const, body: hit } : hit,
      );
    },
  };
}

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

function makeContext(): RunContext {
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: BASE,
    secrets: {},
    storageState: null,
    artifacts,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: () => {},
    },
    signal: never,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
  };
}

function makeTest(spec: unknown): ExecutableTest {
  return {
    id: 'test_1',
    name: 'seo',
    type: 'E2E',
    code: '',
    filePath: 'seo.spec.ts',
    spec,
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
  };
}

function makeSpec(over: Record<string, unknown> = {}): SeoTestSpec {
  return seoTestSpecSchema.parse({
    pages: [{ url: BASE, title: 'Home', metaDescription: 'A shop', canonical: BASE }],
    ...over,
  });
}

/** A page with everything a metadata check wants, so a test only breaks one thing. */
function page(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: `${BASE}p`,
    title: 'A page',
    metaDescription: 'About the page',
    canonical: `${BASE}p`,
    openGraph: { title: 'A page', image: `${BASE}og.png` },
    ...over,
  };
}

const CLEAN_ROBOTS: RobotsFacts = {
  sitemaps: [],
  disallow: [],
  allow: [],
  unparsed: [],
  availability: 'PRESENT',
  detail: null,
};

// ─── The vocabulary ──────────────────────────────────────────────────────────

describe('the check and defect vocabularies', () => {
  it('keeps the zod enum, the presence record and the union in step', () => {
    // Both halves of this codebase's pattern for a vocabulary with a write
    // path. `checks` on the spec IS that path, and eight GateRule kinds shipped
    // unsaveable for two slices when only one half existed.
    expect([...seoCheckSchema.options].sort()).toEqual([...SEO_CHECKS].sort());
    expect(Object.keys(SEO_CHECK_PRESENCE).sort()).toEqual([...SEO_CHECKS].sort());
  });

  it('assigns every defect to a check that exists, with a severity and a decision', () => {
    for (const defect of SEO_DEFECTS) {
      expect(SEO_CHECKS, defect).toContain(SEO_DEFECT_CHECK[defect]);
      expect(SEO_DEFECT_SEVERITY[defect], defect).toBeTruthy();
      // `null` is the decision "no honest FindingKind exists for SEO yet", so
      // `undefined` is the failure here and `null` is not.
      expect(SEO_DEFECT_FINDING_KIND[defect], defect).not.toBeUndefined();
    }
    for (const check of SEO_CHECKS) expect(SEO_CHECK_LABELS[check], check).toBeTruthy();
  });

  it('can actually produce every defect it declares', async () => {
    /*
     * A defect in the union that no branch emits is reportable and unreachable
     * at the same time — the shape of the eight GateRule kinds that shipped
     * unsaveable. Driven through `measureSeo` rather than by re-deriving the
     * list, so a branch that stops emitting is caught here rather than in a
     * customer's report.
     */
    const measurement = await measureSeo(
      makeSpec({
        pages: [
          page({
            url: `${BASE}a`,
            title: null,
            metaDescription: null,
            canonical: null,
            openGraph: {},
            jsonLd: ['{not json'],
          }),
          page({
            url: `${BASE}b`,
            title: 'Dup',
            metaDescription: 'Dup',
            canonical: 'https://someone-else.example/',
            hreflang: [{ lang: 'fr', href: `${BASE}c` }],
            jsonLd: ['{"name":"untyped"}'],
          }),
          page({
            url: `${BASE}c`,
            title: 'Dup',
            metaDescription: 'Dup',
            canonical: `${BASE}d`,
            hreflang: [{ lang: 'fr', href: `${BASE}c` }],
          }),
          page({ url: `${BASE}d`, canonical: `${BASE}e` }),
          page({ url: `${BASE}admin/x` }),
        ],
        requireSitemapCompleteness: true,
      }),
      BASE,
      {
        fetcher: fakeFetcher({
          [`${BASE}robots.txt`]: 'User-agent: *\nDisallow: /admin',
          [`${BASE}sitemap.xml`]:
            '<urlset><url><loc>/admin/x</loc></url><url><loc>/never-crawled</loc></url></urlset>',
        }),
      },
      never,
    );

    const produced = new Set(
      measurement.results.flatMap((result) => result.issues.map((issue) => issue.defect)),
    );
    expect([...produced].sort()).toEqual([...SEO_DEFECTS].sort());
  });

  it('has a branch in runCheck for every check in the union', () => {
    /*
     * The third assertion the two above cannot make: a check in the union with
     * no branch would be requestable and unreachable at once. `runCheck`'s
     * return type makes the switch exhaustive at compile time; this is the
     * run-time half, and it also proves the branch returns a result ABOUT the
     * check it was asked for rather than a neighbour's.
     */
    for (const check of SEO_CHECKS) {
      const result = runCheck(check, makeSpec(), {
        baseUrl: BASE,
        robots: CLEAN_ROBOTS,
        sitemap: null,
      });
      expect(result.check, check).toBe(check);
      expect(result.detail, check).toBeTruthy();
    }
  });
});

// ─── robots.txt ──────────────────────────────────────────────────────────────

describe('parsing robots.txt', () => {
  it('reads only the * group, and collects Sitemap lines wherever they appear', () => {
    const facts = parseRobotsForAll(
      [
        'Sitemap: /sitemap_index.xml',
        'User-agent: Googlebot',
        'Disallow: /google-only',
        '',
        'User-agent: *',
        'Disallow: /admin',
        'Allow: /admin/public',
      ].join('\n'),
      BASE,
    );

    expect(facts.availability).toBe('PRESENT');
    expect(facts.sitemaps).toEqual([`${BASE}sitemap_index.xml`]);
    // Googlebot's rule must NOT leak into the `*` group: QAAI is not Googlebot
    // and must not claim to evaluate the rules written for one.
    expect(facts.disallow).toEqual(['/admin']);
    expect(facts.allow).toEqual(['/admin/public']);
  });

  it('treats consecutive User-agent lines as ONE group', () => {
    /*
     * The specification says so and real files rely on it. Getting it backwards
     * silently applies another crawler's rules to `*` — or, as here, DROPS the
     * rules written for `*`.
     *
     * The `*` goes FIRST deliberately. An earlier version of this case put it
     * last, and a mutation that replaced the group EXTENSION with a plain
     * assignment survived: with `*` last, `agents` ends up `['*']` either way
     * and the test could not see the difference. With `*` first, only the
     * extending version still has it when the rule arrives.
     */
    expect(
      parseRobotsForAll(
        ['User-agent: *', 'User-agent: bingbot', 'Disallow: /both'].join('\n'),
        BASE,
      ).disallow,
    ).toEqual(['/both']);
    // And the other ordering, which is the same group read the other way round.
    expect(
      parseRobotsForAll(
        ['User-agent: bingbot', 'User-agent: *', 'Disallow: /both'].join('\n'),
        BASE,
      ).disallow,
    ).toEqual(['/both']);
  });

  it('starts a NEW group at a User-agent line that follows a rule', () => {
    const facts = parseRobotsForAll(
      ['User-agent: *', 'Disallow: /ours', 'User-agent: evilbot', 'Disallow: /theirs'].join('\n'),
      BASE,
    );
    expect(facts.disallow).toEqual(['/ours']);
  });

  it('reads an empty Disallow as "nothing is disallowed", not as forbidding everything', () => {
    // Dropping that distinction forbids the whole site, and would then report
    // every crawled URL as robots-blocked.
    const facts = parseRobotsForAll(['User-agent: *', 'Disallow:'].join('\n'), BASE);
    expect(facts.disallow).toEqual([]);
    expect(robotsForbids(facts, '/anything')).toBe(false);
  });

  it('keeps the lines it did not understand instead of dropping them', () => {
    const facts = parseRobotsForAll(
      ['User-agent: *', 'Crawl-delay: 10', 'Clean-param: ref', 'nonsense'].join('\n'),
      BASE,
    );
    expect(facts.unparsed).toEqual(['Crawl-delay: 10', 'Clean-param: ref', 'nonsense']);
  });

  it('ignores comments', () => {
    const facts = parseRobotsForAll(
      ['# a comment', 'User-agent: * # trailing', 'Disallow: /x'].join('\n'),
      BASE,
    );
    expect(facts.disallow).toEqual(['/x']);
    expect(facts.unparsed).toEqual([]);
  });
});

describe('whether robots.txt forbids a path', () => {
  const facts = (disallow: string[], allow: string[] = []): RobotsFacts => ({
    ...CLEAN_ROBOTS,
    disallow,
    allow,
  });

  it('lets the longest match win, so an explicit Allow is honoured', () => {
    /*
     * A naive "any Disallow matches" would report `Disallow: /admin` plus
     * `Allow: /admin/public` as forbidding a page the site explicitly permits —
     * and then file it as a defect.
     */
    const policy = facts(['/admin'], ['/admin/public']);
    expect(robotsForbids(policy, '/admin/secret')).toBe(true);
    expect(robotsForbids(policy, '/admin/public/page')).toBe(false);
  });

  it('gives a tie to Allow, which is what crawlers do', () => {
    expect(robotsForbids(facts(['/x'], ['/x']), '/x')).toBe(false);
  });

  it('honours * and $', () => {
    expect(robotsForbids(facts(['/*.pdf$']), '/docs/a.pdf')).toBe(true);
    expect(robotsForbids(facts(['/*.pdf$']), '/docs/a.pdf?x=1')).toBe(false);
    expect(robotsForbids(facts(['/a/*/c']), '/a/b/c')).toBe(true);
  });

  it('forbids nothing when there are no rules', () => {
    expect(robotsForbids(CLEAN_ROBOTS, '/anything')).toBe(false);
  });
});

// ─── sitemap.xml ─────────────────────────────────────────────────────────────

describe('parsing a sitemap', () => {
  it('reads <loc> out of a urlset and resolves it', () => {
    const parsed = parseSitemap(
      '<urlset><url><loc>/a</loc></url><url><loc>https://shop.example.com/b</loc></url></urlset>',
      `${BASE}sitemap.xml`,
      { maxUrls: 100 },
    );
    expect(parsed.state).toBe('PRESENT');
    expect(parsed.locs).toEqual([`${BASE}a`, `${BASE}b`]);
    expect(parsed.children).toEqual([]);
  });

  it('reads a sitemap index as CHILDREN, not as URLs', () => {
    const parsed = parseSitemap(
      '<sitemapindex><sitemap><loc>/s1.xml</loc></sitemap></sitemapindex>',
      `${BASE}sitemap.xml`,
      { maxUrls: 100 },
    );
    expect(parsed.locs).toEqual([]);
    expect(parsed.children).toEqual([`${BASE}s1.xml`]);
  });

  it('calls a body it does not recognise UNAVAILABLE, never "no URLs"', () => {
    /*
     * The difference between a fact about us and a fact about the site. "This
     * sitemap is empty" is actionable and would be a lie here; a gzipped or
     * HTML body is simply something this parser cannot read.
     */
    const parsed = parseSitemap('<html>not a sitemap</html>', `${BASE}sitemap.xml`, {
      maxUrls: 100,
    });
    expect(parsed.state).toBe('UNAVAILABLE');
    expect(parsed.locs).toEqual([]);
    expect(parsed.detail).toMatch(/NOT "the sitemap is empty"/);
  });

  it('counts the entries maxSitemapUrls dropped', () => {
    const body = `<urlset>${['a', 'b', 'c']
      .map((p) => `<url><loc>/${p}</loc></url>`)
      .join('')}</urlset>`;
    const parsed = parseSitemap(body, `${BASE}sitemap.xml`, { maxUrls: 2 });
    expect(parsed.locs).toHaveLength(2);
    expect(parsed.truncated).toBe(1);
  });

  it('decodes the five XML entities a <loc> may carry', () => {
    const parsed = parseSitemap(
      '<urlset><url><loc>/s?a=1&amp;b=2</loc></url></urlset>',
      `${BASE}sitemap.xml`,
      { maxUrls: 10 },
    );
    expect(parsed.locs).toEqual([`${BASE}s?a=1&b=2`]);
  });

  it('declares what it cannot do, so a reader knows what the count means', () => {
    // A reader told "the sitemap lists 40 URLs" is entitled to know whether the
    // parser could have seen 40,000.
    expect(SITEMAP_PARSE_LIMITS.length).toBeGreaterThan(0);
    expect(SITEMAP_PARSE_LIMITS.join(' ')).toMatch(/gzip/);
  });
});

describe('harvesting the sitemaps', () => {
  it('follows an index and dedupes the result', async () => {
    const harvest = await harvestSitemaps(
      [`${BASE}sitemap.xml`],
      fakeFetcher({
        [`${BASE}sitemap.xml`]:
          '<sitemapindex><sitemap><loc>/s1.xml</loc></sitemap><sitemap><loc>/s2.xml</loc></sitemap></sitemapindex>',
        [`${BASE}s1.xml`]: '<urlset><url><loc>/a</loc></url></urlset>',
        [`${BASE}s2.xml`]: '<urlset><url><loc>/a</loc></url><url><loc>/b</loc></url></urlset>',
      }),
      { maxDocuments: 10, maxUrls: 100 },
      never,
    );

    expect(harvest.urls).toEqual([`${BASE}a`, `${BASE}b`]);
    expect(harvest.unavailable).toBe(false);
  });

  it('names the documents maxSitemapDocuments stopped it reading', async () => {
    const harvest = await harvestSitemaps(
      [`${BASE}sitemap.xml`],
      fakeFetcher({
        [`${BASE}sitemap.xml`]:
          '<sitemapindex><sitemap><loc>/s1.xml</loc></sitemap><sitemap><loc>/s2.xml</loc></sitemap></sitemapindex>',
        [`${BASE}s1.xml`]: '<urlset><url><loc>/a</loc></url></urlset>',
        [`${BASE}s2.xml`]: '<urlset><url><loc>/b</loc></url></urlset>',
      }),
      { maxDocuments: 2, maxUrls: 100 },
      never,
    );

    expect(harvest.skippedDocuments).toEqual([`${BASE}s2.xml`]);
    expect(harvest.urls).toEqual([`${BASE}a`]);
  });

  it('is UNAVAILABLE when every document failed, so the empty list means nothing', async () => {
    const harvest = await harvestSitemaps(
      [`${BASE}sitemap.xml`],
      fakeFetcher({}),
      { maxDocuments: 10, maxUrls: 100 },
      never,
    );
    expect(harvest.unavailable).toBe(true);
    expect(harvest.urls).toEqual([]);
    expect(harvest.documents[0]!.state).toBe('ABSENT');
  });
});

// ─── The cross-check ─────────────────────────────────────────────────────────

describe('robots/sitemap consistency with the crawl', () => {
  const crawled = (...paths: string[]): Record<string, unknown> => ({
    pages: paths.map((p) => page({ url: `${BASE}${p}` })),
  });

  it('is NOT MEASURED when no sitemap could be read, and says what it avoided', async () => {
    /*
     * The failure this check could do the most damage with: an unreadable
     * sitemap read as an empty one reports EVERY crawled URL as missing from
     * it. A thousand findings from one timeout.
     */
    const measurement = await measureSeo(
      makeSpec({ ...crawled('a', 'b'), checks: ['ROBOTS_SITEMAP_CONSISTENCY'] }),
      BASE,
      { fetcher: fakeFetcher({}) },
      never,
    );

    const result = measurement.results.find((r) => r.check === 'ROBOTS_SITEMAP_CONSISTENCY')!;
    expect(result.outcome).toBe('NOT_MEASURED');
    expect(result.issues).toEqual([]);
    expect(result.detail).toMatch(/UNKNOWN rather than empty/);
    expect(result.detail).toMatch(/all 2 crawled URL\(s\) as missing/);
  });

  it('reports an advertised URL the crawl never reached', async () => {
    const measurement = await measureSeo(
      makeSpec({ ...crawled('a'), checks: ['ROBOTS_SITEMAP_CONSISTENCY'] }),
      BASE,
      {
        fetcher: fakeFetcher({
          [`${BASE}robots.txt`]: 'User-agent: *\nSitemap: /sitemap.xml',
          [`${BASE}sitemap.xml`]:
            '<urlset><url><loc>/a</loc></url><url><loc>/orphaned</loc></url></urlset>',
        }),
      },
      never,
    );

    const result = measurement.results.find((r) => r.check === 'ROBOTS_SITEMAP_CONSISTENCY')!;
    expect(result.outcome).toBe('ISSUES');
    const issue = result.issues.find((i) => i.defect === 'SITEMAP_URL_NOT_CRAWLED')!;
    expect(issue.occurrenceCount).toBe(1);
    expect(issue.examples).toEqual([`${BASE}orphaned`]);
  });

  it('does not demand an exhaustive sitemap unless the test asks', async () => {
    /*
     * The default has to be off. A sitemap is not required to be exhaustive,
     * and a site that deliberately keeps its filtered listing pages out of the
     * sitemap would otherwise get thousands of findings for doing the right
     * thing — which is how a report gets switched off entirely.
     */
    const spec = {
      ...crawled('a', 'not-listed'),
      checks: ['ROBOTS_SITEMAP_CONSISTENCY'] as const,
    };
    const fetcher = fakeFetcher({
      [`${BASE}robots.txt`]: 'User-agent: *',
      [`${BASE}sitemap.xml`]: '<urlset><url><loc>/a</loc></url></urlset>',
    });

    const lenient = await measureSeo(makeSpec(spec), BASE, { fetcher }, never);
    const lenientResult = lenient.results.find((r) => r.check === 'ROBOTS_SITEMAP_CONSISTENCY')!;
    expect(lenientResult.issues.map((i) => i.defect)).not.toContain('CRAWLED_URL_NOT_IN_SITEMAP');
    expect(lenientResult.detail).toMatch(/requireSitemapCompleteness` is false/);

    const strict = await measureSeo(
      makeSpec({ ...spec, requireSitemapCompleteness: true }),
      BASE,
      { fetcher },
      never,
    );
    const strictIssues = strict.results.find((r) => r.check === 'ROBOTS_SITEMAP_CONSISTENCY')!;
    expect(strictIssues.issues.map((i) => i.defect)).toContain('CRAWLED_URL_NOT_IN_SITEMAP');
  });

  it('catches a site that advertises a URL its own robots.txt forbids', async () => {
    // The self-contradiction. The crawler obeys robots.txt, so the sitemap
    // entry is wasted and the page is invisible.
    const measurement = await measureSeo(
      makeSpec({ ...crawled('admin/panel'), checks: ['ROBOTS_SITEMAP_CONSISTENCY'] }),
      BASE,
      {
        fetcher: fakeFetcher({
          [`${BASE}robots.txt`]: 'User-agent: *\nDisallow: /admin',
          [`${BASE}sitemap.xml`]: '<urlset><url><loc>/admin/panel</loc></url></urlset>',
        }),
      },
      never,
    );

    const defects = measurement.results
      .find((r) => r.check === 'ROBOTS_SITEMAP_CONSISTENCY')!
      .issues.map((i) => i.defect)
      .sort();
    expect(defects).toEqual(['CRAWLED_URL_DISALLOWED', 'SITEMAP_URL_DISALLOWED']);
    expect(SEO_DEFECT_SEVERITY.SITEMAP_URL_DISALLOWED).toBe('SERIOUS');
  });

  it('skips the two disallow defects when robots.txt could not be read', async () => {
    /*
     * An UNAVAILABLE robots.txt must not be read as "nothing is disallowed" —
     * that is a measurement nobody made. The sitemap half still runs, and the
     * detail says which half did not.
     */
    const measurement = await measureSeo(
      makeSpec({ ...crawled('a'), checks: ['ROBOTS_SITEMAP_CONSISTENCY'] }),
      BASE,
      {
        fetcher: fakeFetcher({
          [`${BASE}robots.txt`]: { state: 'UNAVAILABLE', detail: 'connection reset' },
          [`${BASE}sitemap.xml`]: '<urlset><url><loc>/a</loc></url></urlset>',
        }),
      },
      never,
    );

    const result = measurement.results.find((r) => r.check === 'ROBOTS_SITEMAP_CONSISTENCY')!;
    expect(result.outcome).toBe('CLEAN');
    expect(result.detail).toMatch(/robots\.txt was UNAVAILABLE/);
    expect(result.detail).toMatch(/not "nothing is disallowed"/);
  });

  it('prefers the sitemaps robots.txt names over the conventional path', async () => {
    // The site is stating where they are. Preferring our guess would check a
    // document the site does not use.
    const fetcher = fakeFetcher({
      [`${BASE}robots.txt`]: 'User-agent: *\nSitemap: /custom.xml',
      [`${BASE}custom.xml`]: '<urlset><url><loc>/a</loc></url></urlset>',
      [`${BASE}sitemap.xml`]: '<urlset><url><loc>/wrong</loc></url></urlset>',
    });
    const measurement = await measureSeo(
      makeSpec({ ...crawled('a'), checks: ['ROBOTS_SITEMAP_CONSISTENCY'] }),
      BASE,
      { fetcher },
      never,
    );

    expect(fetcher.asked).toEqual([`${BASE}robots.txt`, `${BASE}custom.xml`]);
    expect(measurement.sitemap!.urls).toEqual([`${BASE}a`]);
  });

  it('labels a truncated advertised set as a LOWER BOUND', async () => {
    /*
     * The quiet one. With `maxSitemapUrls` biting, a URL the sitemap lists
     * perfectly well is absent from the part we read — so a
     * CRAWLED_URL_NOT_IN_SITEMAP finding could be entirely our cap's doing, and
     * the disclosure has to say so.
     */
    const measurement = await measureSeo(
      makeSpec({
        ...crawled('a'),
        checks: ['ROBOTS_SITEMAP_CONSISTENCY'],
        maxSitemapUrls: 1,
      }),
      BASE,
      {
        fetcher: fakeFetcher({
          [`${BASE}robots.txt`]: 'User-agent: *',
          [`${BASE}sitemap.xml`]:
            '<urlset><url><loc>/a</loc></url><url><loc>/b</loc></url></urlset>',
        }),
      },
      never,
    );

    const cap = measurement.caps.find((c) => c.cap === 'maxSitemapUrls');
    expect(cap!.count).toBe(1);
    expect(cap!.reason).toMatch(/LOWER BOUND/);
    expect(cap!.reason).toMatch(/may be reported as absent from the sitemap/);
  });

  it('discloses the robots.txt lines it did not understand', async () => {
    const measurement = await measureSeo(
      makeSpec({ ...crawled('a'), checks: ['ROBOTS_SITEMAP_CONSISTENCY'] }),
      BASE,
      {
        fetcher: fakeFetcher({ [`${BASE}robots.txt`]: 'User-agent: *\nCrawl-delay: 10' }),
      },
      never,
    );
    const cap = measurement.caps.find((c) => c.cap === 'robots.txt lines not understood');
    expect(cap!.count).toBe(1);
    expect(cap!.reason).toMatch(/Crawl-delay: 10/);
  });
});

// ─── The metadata checks ─────────────────────────────────────────────────────

describe('title and meta description', () => {
  it('makes 300 pages sharing one title ONE issue with a count of 300', async () => {
    // The single most common real SEO defect in a generated site, and the one
    // most able to produce 300 rows.
    const pages = Array.from({ length: 300 }, (_, i) =>
      page({ url: `${BASE}p/${i}`, title: 'Home' }),
    );
    const result = runCheck('TITLE', makeSpec({ pages }), {
      baseUrl: BASE,
      robots: CLEAN_ROBOTS,
      sitemap: null,
    });

    const duplicate = result.issues.find((i) => i.defect === 'TITLE_DUPLICATE')!;
    expect(duplicate.occurrenceCount).toBe(300);
    expect(duplicate.subject).toBe('Home');
    // Examples capped, count never.
    expect(duplicate.examples).toHaveLength(20);
    expect(result.issues).toHaveLength(1);
  });

  it('reports a missing title once, with the count of pages missing it', async () => {
    const result = runCheck(
      'TITLE',
      makeSpec({
        pages: [page({ url: `${BASE}a`, title: null }), page({ url: `${BASE}b`, title: '   ' })],
      }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    const missing = result.issues.find((i) => i.defect === 'TITLE_MISSING')!;
    expect(missing.occurrenceCount).toBe(2);
  });

  it('exempts a noindex page, and says how many it exempted', () => {
    /*
     * Reporting a missing title on a page the site has asked nobody to index is
     * noise, and noise is what gets a whole report ignored. But a silent
     * exemption is a shrinking denominator nobody was told about, so the count
     * is in the detail.
     */
    const result = runCheck(
      'TITLE',
      makeSpec({
        pages: [page({ url: `${BASE}a` }), page({ url: `${BASE}b`, title: null, noindex: true })],
      }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    expect(result.outcome).toBe('CLEAN');
    expect(result.denominator).toBe(1);
    expect(result.detail).toMatch(/1 noindex page\(s\) were exempt/);
  });

  it('is NOT MEASURED when every page is noindex', () => {
    const result = runCheck('TITLE', makeSpec({ pages: [page({ title: null, noindex: true })] }), {
      baseUrl: BASE,
      robots: CLEAN_ROBOTS,
      sitemap: null,
    });
    expect(result.outcome).toBe('NOT_MEASURED');
    expect(result.issues).toEqual([]);
  });

  it('groups duplicates most-shared first, deterministically', () => {
    const pages = [
      page({ url: `${BASE}1`, title: 'B' }),
      page({ url: `${BASE}2`, title: 'B' }),
      page({ url: `${BASE}3`, title: 'A' }),
      page({ url: `${BASE}4`, title: 'A' }),
      page({ url: `${BASE}5`, title: 'A' }),
    ].map((p) => seoTestSpecSchema.parse({ pages: [p] }).pages[0]!);

    expect(duplicatesByValue(pages, (p) => p.title).map((d) => d.value)).toEqual(['A', 'B']);
  });

  it('reports a duplicated meta description separately from a missing one', () => {
    const result = runCheck(
      'META_DESCRIPTION',
      makeSpec({
        pages: [
          page({ url: `${BASE}a`, metaDescription: 'same' }),
          page({ url: `${BASE}b`, metaDescription: 'same' }),
          page({ url: `${BASE}c`, metaDescription: null }),
        ],
      }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    expect(result.issues.map((i) => i.defect).sort()).toEqual([
      'META_DESCRIPTION_DUPLICATE',
      'META_DESCRIPTION_MISSING',
    ]);
  });
});

describe('canonical', () => {
  it('reports a canonical pointing at another origin as SERIOUS', () => {
    // It asks search engines not to index the page at all. Nothing else in this
    // file costs that much.
    const result = runCheck(
      'CANONICAL',
      makeSpec({ pages: [page({ canonical: 'https://someone-else.example/' })] }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    expect(result.issues.map((i) => i.defect)).toEqual(['CANONICAL_OFF_SITE']);
    expect(SEO_DEFECT_SEVERITY.CANONICAL_OFF_SITE).toBe('SERIOUS');
  });

  it('reports a missing canonical and resolves a relative one', () => {
    const result = runCheck(
      'CANONICAL',
      makeSpec({
        pages: [
          page({ url: `${BASE}a`, canonical: null }),
          page({ url: `${BASE}b`, canonical: '/b' }),
        ],
      }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    expect(result.issues.map((i) => i.defect)).toEqual(['CANONICAL_MISSING']);
  });

  it('finds a chain, which crawlers do not follow', () => {
    const result = runCheck(
      'CANONICAL',
      makeSpec({
        pages: [
          page({ url: `${BASE}a`, canonical: `${BASE}b` }),
          page({ url: `${BASE}b`, canonical: `${BASE}c` }),
          page({ url: `${BASE}c`, canonical: `${BASE}c` }),
        ],
      }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    const chain = result.issues.find((i) => i.defect === 'CANONICAL_CHAIN')!;
    expect(chain.subject).toBe(`${BASE}a`);
    expect(chain.detail).toMatch(/do not follow chains/);
  });

  it('does not call a canonical pointing at a page we never loaded a chain', () => {
    // Absent metadata is UNKNOWN. Inferring a chain from it would invent a
    // defect out of the crawl's own incompleteness.
    const result = runCheck(
      'CANONICAL',
      makeSpec({ pages: [page({ url: `${BASE}a`, canonical: `${BASE}never-crawled` })] }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    expect(result.issues.map((i) => i.defect)).not.toContain('CANONICAL_CHAIN');
  });
});

describe('hreflang reciprocity', () => {
  it('is NOT MEASURED on a site that declares no hreflang at all', () => {
    /*
     * The zero-denominator case. A site with no hreflang is not failing this
     * check, it is not taking it — and scoring it 0% would be an unmeasured
     * axis wearing a percentage, which is the lie the whole product is built
     * against.
     */
    const result = runCheck('HREFLANG', makeSpec({ pages: [page()] }), {
      baseUrl: BASE,
      robots: CLEAN_ROBOTS,
      sitemap: null,
    });
    expect(result.outcome).toBe('NOT_MEASURED');
    expect(result.denominator).toBe(0);
    expect(result.detail).toMatch(/nothing is claimed/);
  });

  it('reports the classic one-way cluster', () => {
    const result = runCheck(
      'HREFLANG',
      makeSpec({
        pages: [
          page({
            url: `${BASE}en`,
            hreflang: [
              { lang: 'en', href: `${BASE}en` },
              { lang: 'fr', href: `${BASE}fr` },
            ],
          }),
          page({ url: `${BASE}fr`, hreflang: [{ lang: 'fr', href: `${BASE}fr` }] }),
        ],
      }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    const issue = result.issues.find((i) => i.defect === 'HREFLANG_NOT_RECIPROCAL')!;
    expect(issue.subject).toBe(`${BASE}en → ${BASE}fr`);
  });

  it('reports a cluster with no self-referential entry', () => {
    const result = runCheck(
      'HREFLANG',
      makeSpec({
        pages: [page({ url: `${BASE}en`, hreflang: [{ lang: 'fr', href: `${BASE}fr` }] })],
      }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    expect(result.issues.map((i) => i.defect)).toContain('HREFLANG_NO_SELF');
  });

  it('says nothing about an alternate we have no metadata for', () => {
    // Only a page we HAVE metadata for can be shown not to reciprocate.
    const result = runCheck(
      'HREFLANG',
      makeSpec({
        pages: [
          page({
            url: `${BASE}en`,
            hreflang: [
              { lang: 'en', href: `${BASE}en` },
              { lang: 'de', href: 'https://de.example.com/' },
            ],
          }),
        ],
      }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    expect(result.outcome).toBe('CLEAN');
  });
});

describe('Open Graph and JSON-LD', () => {
  it('names the missing og properties', () => {
    const result = runCheck(
      'OPEN_GRAPH',
      makeSpec({ pages: [page({ openGraph: { type: 'website' } })] }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    expect(result.issues[0]!.detail).toMatch(/og:title, og:image/);
    expect(REQUIRED_OG_PROPERTIES).toEqual(['title', 'image']);
  });

  it('is NOT MEASURED when no page ships a JSON-LD block', () => {
    // Structured data is optional, so a site with none is not failing — and a
    // 0% here would be another unmeasured axis reported as a number.
    const result = runCheck('JSON_LD', makeSpec({ pages: [page()] }), {
      baseUrl: BASE,
      robots: CLEAN_ROBOTS,
      sitemap: null,
    });
    expect(result.outcome).toBe('NOT_MEASURED');
  });

  it('separates invalid JSON from valid JSON with no @type', () => {
    const result = runCheck(
      'JSON_LD',
      makeSpec({
        pages: [
          page({ url: `${BASE}a`, jsonLd: ['{not json'] }),
          page({ url: `${BASE}b`, jsonLd: ['{"name":"x"}'] }),
          page({ url: `${BASE}c`, jsonLd: ['[{"@type":"Product"},{"name":"y"}]'] }),
        ],
      }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );

    expect(result.issues.map((i) => i.defect)).toEqual([
      'JSON_LD_INVALID',
      'JSON_LD_UNTYPED',
      'JSON_LD_UNTYPED',
    ]);
    expect(result.issues[0]!.detail).toMatch(/worse than none/);
    // One entity of the two in the array is untyped, and the count says so.
    expect(result.issues[2]!.occurrenceCount).toBe(1);
  });

  it('accepts a well-formed typed block', () => {
    const result = runCheck(
      'JSON_LD',
      makeSpec({ pages: [page({ jsonLd: ['{"@type":"Organization","name":"Acme"}'] })] }),
      { baseUrl: BASE, robots: CLEAN_ROBOTS, sitemap: null },
    );
    expect(result.outcome).toBe('CLEAN');
  });
});

// ─── The result ──────────────────────────────────────────────────────────────

describe('the execution an SEO test produces', () => {
  it('distinguishes NOT REQUESTED from CLEAN', async () => {
    /*
     * "We checked and it is fine" and "we did not check" cannot be the same
     * row. A check left out of `checks` is NOT_REQUESTED and says so in its own
     * step and in the result message.
     */
    const measurement = await measureSeo(
      makeSpec({ pages: [page()], checks: ['TITLE'] }),
      BASE,
      { fetcher: fakeFetcher({}) },
      never,
    );

    expect(measurement.results.find((r) => r.check === 'TITLE')!.outcome).toBe('CLEAN');
    for (const check of SEO_CHECKS.filter((c) => c !== 'TITLE')) {
      const result = measurement.results.find((r) => r.check === check)!;
      expect(result.outcome, check).toBe('NOT_REQUESTED');
      expect(result.detail, check).toMatch(/Not requested is not clean/);
    }
  });

  it('makes no request at all for a metadata-only test', async () => {
    // robots.txt and the sitemap are only fetched by the check that needs them.
    const fetcher = fakeFetcher({});
    await measureSeo(makeSpec({ pages: [page()], checks: ['TITLE'] }), BASE, { fetcher }, never);
    expect(fetcher.asked).toEqual([]);
  });

  it('FAILS on a defect and counts the pages, not the rows', async () => {
    const pages = Array.from({ length: 5 }, (_, i) =>
      page({ url: `${BASE}p/${i}`, title: 'Home' }),
    );
    const spec = { pages, checks: ['TITLE'] };
    const execution = await runSeoChecks(makeContext(), makeTest(spec), makeSpec(spec), {
      fetcher: fakeFetcher({}),
    });

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/TITLE_DUPLICATE \(5 page\(s\)\)/);
    expect(execution.errorMessage).toMatch(/NOT REQUESTED:/);
    expect(execution.steps.filter((s) => s.status === 'FAILED')).toHaveLength(1);
  });

  it('SKIPS with notRun when no check measured anything, rather than passing', async () => {
    /*
     * The result that must never be PASSED. Every check here has a zero
     * denominator: the only page is noindex and no sitemap is readable.
     */
    const spec = {
      pages: [page({ noindex: true })],
      checks: ['ROBOTS_SITEMAP_CONSISTENCY', 'TITLE'],
    };
    const execution = await runSeoChecks(makeContext(), makeTest(spec), makeSpec(spec), {
      fetcher: fakeFetcher({}),
    });

    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun).toEqual({
      kind: 'NOT_RUN',
      why: expect.stringContaining('No SEO check measured anything'),
    });
    expect(execution.errorMessage).toMatch(/NOT MEASURED/);
  });

  it('PASSES with the unmeasured checks named on the result', async () => {
    const spec = { pages: [page()] };
    const execution = await runSeoChecks(makeContext(), makeTest(spec), makeSpec(spec), {
      fetcher: fakeFetcher({ [`${BASE}robots.txt`]: 'User-agent: *' }),
    });

    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toMatch(/No SEO defect found/);
    // HREFLANG and JSON_LD have zero denominators on this page, and the result
    // says so rather than letting them read as clean.
    expect(execution.errorMessage).toMatch(/NOT MEASURED[^.]*HREFLANG/);
    expect(execution.errorMessage).toMatch(/JSON_LD/);
  });

  it('files no Finding row today, and reports the defect on a step instead', async () => {
    /*
     * `FINDING_KINDS` has no SEO member, and LOCALIZATION — the nearest miss —
     * would put an SEO count into the number a localisation gate reads. So
     * every defect rides on a step, and this pins it: if an `SEO` kind lands,
     * this assertion is the one that has to change on purpose.
     */
    const spec = { pages: [page({ title: null })], checks: ['TITLE'] };
    const execution = await runSeoChecks(makeContext(), makeTest(spec), makeSpec(spec), {
      fetcher: fakeFetcher({}),
    });

    expect(execution.findings).toEqual([]);
    expect(
      execution.steps.some((s) => s.status === 'FAILED' && s.title.includes('TITLE_MISSING')),
    ).toBe(true);
    for (const defect of SEO_DEFECTS) expect(SEO_DEFECT_FINDING_KIND[defect], defect).toBeNull();
  });

  it('marks an unmeasured check SKIPPED rather than FAILED', async () => {
    // `error` on a step means "this failed", and a check with nothing to
    // measure did not fail.
    const spec = { pages: [page()], checks: ['HREFLANG'] };
    const execution = await runSeoChecks(makeContext(), makeTest(spec), makeSpec(spec), {
      fetcher: fakeFetcher({}),
    });
    const step = execution.steps.find((s) => s.title.includes('hreflang'))!;
    expect(step.status).toBe('SKIPPED');
    expect(step.error).toBeNull();
  });
});

// ─── The plugin seam ─────────────────────────────────────────────────────────

describe('the plugin', () => {
  it('rejects a metadata-only test whose every page is noindex', () => {
    expect(() =>
      seoPlugin.validate(makeTest({ pages: [page({ noindex: true })], checks: ['TITLE'] })),
    ).toThrow(/could not measure anything/);
  });

  it('accepts the same pages once the consistency check is asked for', () => {
    // That check does not care about noindex — it compares URL sets.
    expect(() =>
      seoPlugin.validate(
        makeTest({
          pages: [page({ noindex: true })],
          checks: ['TITLE', 'ROBOTS_SITEMAP_CONSISTENCY'],
        }),
      ),
    ).not.toThrow();
  });

  it('names the test in an invalid-spec message', () => {
    expect(() => seoPlugin.validate(makeTest({ pages: [] }))).toThrow(/has an invalid spec/);
  });

  it('reports UNAVAILABLE rather than ABSENT when no fetcher is configured', async () => {
    /*
     * The difference the whole module turns on. "This site publishes no
     * robots.txt" is a measurement somebody could act on, and claiming it on
     * the strength of having no fetcher would be a measurement we did not make.
     */
    const document = await unavailableSeoFetcher.fetchText(`${BASE}robots.txt`, never);
    expect(document.state).toBe('UNAVAILABLE');
    expect(EMPTY_ROBOTS_FACTS.availability).toBe('UNAVAILABLE');
  });

  it('keeps indexablePages as the one definition of eligibility', () => {
    const pages = seoTestSpecSchema.parse({
      pages: [page({ url: `${BASE}a` }), page({ url: `${BASE}b`, noindex: true })],
    }).pages;
    expect(indexablePages(pages).map((p) => p.url)).toEqual([`${BASE}a`]);
  });
});
