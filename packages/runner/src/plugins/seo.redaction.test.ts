/**
 * Adversarial tests for the SEO plugin: false findings, leaks, and a pass over
 * nothing.
 *
 * Separate from seo.test.ts, which covers the checks' own rules. Three defects
 * found by attacking it, all three real:
 *
 *  1. TWO FALSE FINDINGS ON A CORRECT SITE. `new URL()` normalises
 *     (`https://x.test` → `https://x.test/`) and a raw crawled string does not,
 *     so one side of every hreflang comparison was normalised and the other was
 *     not. A page whose crawled URL is origin-only failed the self-reference
 *     test against its OWN resolved alternate, and its partner then failed
 *     reciprocity against it: two findings, on a cluster with nothing wrong
 *     with it. This is the most damaging class of defect this product can ship
 *     — a team that gets findings like these learns to ignore the rest.
 *  2. A CLEAN VERDICT OVER A ZERO DENOMINATOR. The consistency check builds its
 *     own `CheckResult` instead of going through `finish`, so it skipped the
 *     zero-denominator rule and reported CLEAN when the two sets were never
 *     compared — which `runSeoChecks` then counted as a measured check and
 *     published as PASSED, "No SEO defect found".
 *  3. A QUERY STRING IN A REPORT. This plugin's whole input is crawled URLs,
 *     and a crawl that reached a password-reset page carries `?token=…` on the
 *     page url, on its canonical, on its hreflang alternates and in the sitemap
 *     `<loc>` that advertises it.
 */

import { describe, expect, it } from 'vitest';
import type { RunContext, TestExecution } from '@qaai/shared';
import {
  EMPTY_ROBOTS_FACTS,
  runCheck,
  runSeoChecks,
  seoTestSpecSchema,
  type SeoTextFetcher,
  type SitemapHarvest,
} from './seo.js';

function context(): RunContext {
  return {
    baseUrl: 'https://x.test',
    signal: new AbortController().signal,
    logger: {
      step: () => {},
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    },
  } as unknown as RunContext;
}

async function execute(spec: unknown, fetcher: SeoTextFetcher): Promise<TestExecution> {
  const parsed = seoTestSpecSchema.parse(spec);
  return runSeoChecks(context(), { id: 't_1', name: 'seo', spec: parsed } as never, parsed, {
    fetcher,
  });
}

const unavailable: SeoTextFetcher = {
  fetchText: () =>
    Promise.resolve({ state: 'UNAVAILABLE' as const, detail: 'no fetcher in this test' }),
};

const presentSitemap = (body: string): SeoTextFetcher => ({
  fetchText: (url) =>
    Promise.resolve(
      url.endsWith('robots.txt')
        ? { state: 'PRESENT' as const, body: 'User-agent: *\nDisallow: /admin' }
        : { state: 'PRESENT' as const, body },
    ),
});

describe('hreflang does not invent a defect on a reciprocal cluster', () => {
  it('accepts a cluster whose pages are named by origin alone', () => {
    /*
     * The exact fixture that produced two findings. `https://x.test` resolves
     * to `https://x.test/`, and both pages name each other correctly.
     */
    const spec = seoTestSpecSchema.parse({
      pages: [
        {
          url: 'https://x.test',
          hreflang: [
            { lang: 'en', href: 'https://x.test' },
            { lang: 'fr', href: 'https://x.test/fr' },
          ],
        },
        {
          url: 'https://x.test/fr',
          hreflang: [
            { lang: 'fr', href: 'https://x.test/fr' },
            { lang: 'en', href: 'https://x.test' },
          ],
        },
      ],
      checks: ['HREFLANG'],
    });

    const result = runCheck('HREFLANG', spec, {
      baseUrl: 'https://x.test',
      robots: EMPTY_ROBOTS_FACTS,
      sitemap: null,
    });

    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe('CLEAN');
    expect(result.denominator).toBe(2);
  });

  it('still catches the real one-sided cluster, so the fix did not disable the check', () => {
    const spec = seoTestSpecSchema.parse({
      pages: [
        { url: 'https://x.test/en', hreflang: [{ lang: 'en', href: '/en' }, { lang: 'fr', href: '/fr' }] },
        // `/fr` names only itself: the classic half-built international site.
        { url: 'https://x.test/fr', hreflang: [{ lang: 'fr', href: '/fr' }] },
      ],
      checks: ['HREFLANG'],
    });

    const result = runCheck('HREFLANG', spec, {
      baseUrl: 'https://x.test',
      robots: EMPTY_ROBOTS_FACTS,
      sitemap: null,
    });

    expect(result.issues.map((issue) => issue.defect)).toEqual(['HREFLANG_NOT_RECIPROCAL']);
  });
});

describe('a check that compared nothing is NOT_MEASURED, never CLEAN', () => {
  const emptyButPresent: SitemapHarvest = {
    urls: [],
    documents: [
      {
        url: 'https://x.test/sitemap.xml',
        locs: [],
        children: [],
        truncated: 0,
        state: 'PRESENT',
        detail: null,
      },
    ],
    skippedDocuments: [],
    truncatedUrls: 0,
    unavailable: false,
  };

  it('refuses to call an empty-vs-empty comparison clean', () => {
    const result = runCheck(
      'ROBOTS_SITEMAP_CONSISTENCY',
      // A sitemap that parsed and advertises nothing, and a page URL that does
      // not parse — so `crawled` is empty too.
      seoTestSpecSchema.parse({
        pages: [{ url: 'not a url at all' }],
        checks: ['ROBOTS_SITEMAP_CONSISTENCY'],
      }),
      { baseUrl: 'https://x.test', robots: EMPTY_ROBOTS_FACTS, sitemap: emptyButPresent },
    );

    expect(result.outcome).toBe('NOT_MEASURED');
    expect(result.denominator).toBe(0);
    expect(result.detail).toMatch(/NOT a clean result/);
  });

  it('does not publish that as a PASSED result', async () => {
    const execution = await execute(
      { pages: [{ url: 'not a url at all' }], checks: ['ROBOTS_SITEMAP_CONSISTENCY'] },
      presentSitemap('<urlset></urlset>'),
    );

    // The whole point: no measured check, so the result cannot be a pass.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('NOT_RUN');
    expect(execution.errorMessage).toMatch(/No SEO check measured anything/);
  });

  it('reports the advertised count as the denominator, not two sets added together', () => {
    const result = runCheck(
      'ROBOTS_SITEMAP_CONSISTENCY',
      seoTestSpecSchema.parse({
        pages: [{ url: 'https://x.test/a' }, { url: 'https://x.test/b' }],
        checks: ['ROBOTS_SITEMAP_CONSISTENCY'],
      }),
      {
        baseUrl: 'https://x.test',
        robots: EMPTY_ROBOTS_FACTS,
        sitemap: { ...emptyButPresent, urls: ['https://x.test/a'] },
      },
    );

    // 1 advertised, 2 crawled. `3` would be the four-incommensurable-
    // denominators mistake in miniature; both counts are in `detail` instead.
    expect(result.denominator).toBe(1);
    expect(result.detail).toContain('1 advertised URL(s) compared against 2 crawled URL(s)');
  });
});

describe('no credential reaches an SEO report', () => {
  const SECRETS = {
    page: 'PAGE-RESET-TOKEN-1',
    canonical: 'CANON-SID-2',
    sitemap: 'SITEMAP-TOKEN-3',
    alternate: 'HREFLANG-TOKEN-4',
  };

  it('strips the query from the page url, the canonical, the alternates and the sitemap', async () => {
    const execution = await execute(
      {
        pages: [
          {
            url: `https://x.test/reset?token=${SECRETS.page}`,
            title: null,
            canonical: `https://evil.test/c?sid=${SECRETS.canonical}`,
            hreflang: [{ lang: 'fr', href: `https://x.test/fr?t=${SECRETS.alternate}` }],
          },
          { url: 'https://x.test/b', title: null },
        ],
        requireSitemapCompleteness: true,
      },
      presentSitemap(
        `<urlset><url><loc>https://x.test/reset?token=${SECRETS.sitemap}</loc></url></urlset>`,
      ),
    );

    const text = JSON.stringify(execution);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    // Not vacuous: the defects really were found, and by path.
    expect(execution.status).toBe('FAILED');
    expect(text).toContain('https://x.test/reset');
    expect(text).toContain('https://evil.test/c');
  });

  it('withholds the JSON parse message, which quotes the block’s own bytes', async () => {
    /*
     * V8 has two message families and only one of them echoes. The descriptive
     * form ("Expected ',' or '}' after property value in JSON at position 27")
     * carries a position and nothing else; the `Unexpected token` form quotes a
     * ~14-character window of the INPUT back at you. Forwarding the message put
     * whatever sat beside the syntax error into a step title and a stored
     * result.
     *
     * The fixture is built for the ECHOING form, and the assertion below proves
     * it echoes before asserting that the plugin does not. A first attempt at
     * this test used a trailing-comma block, which produces the non-echoing
     * form — so it passed against a deliberately reverted fix. Measured, not
     * assumed.
     */
    const block = '{"@type":"T","SEEP9":}';
    let raw = '';
    try {
      JSON.parse(block);
    } catch (err) {
      raw = err instanceof Error ? err.message : '';
    }
    expect(raw).toContain('SEEP9');

    const execution = await execute(
      { pages: [{ url: 'https://x.test/a', title: 't', jsonLd: [block] }], checks: ['JSON_LD'] },
      unavailable,
    );

    const text = JSON.stringify(execution);
    expect(text).not.toContain('SEEP9');
    // The defect is still reported, still locatable, and still has a position.
    expect(text).toContain('not valid JSON');
    expect(text).toContain('https://x.test/a #1');
  });

  it('discloses the redaction as a count, and still compares on the full URL', async () => {
    /*
     * The second half matters as much as the first: if redaction reached the
     * COMPARISON, two pages differing only in their query would collapse into
     * one and be reported as sharing a duplicate title that does not exist.
     */
    const execution = await execute(
      {
        pages: [
          { url: 'https://x.test/p?v=1', title: 'One', metaDescription: 'a' },
          { url: 'https://x.test/p?v=2', title: 'Two', metaDescription: 'b' },
        ],
        checks: ['TITLE'],
      },
      unavailable,
    );

    expect(execution.status).toBe('PASSED');
    const disclosure = execution.console.map((entry) => entry.text).join('\n');
    expect(disclosure).toMatch(/2 URL\(s\) in this test carried a query string/);
    expect(disclosure).toMatch(/no two pages were merged by it/);
  });
});
