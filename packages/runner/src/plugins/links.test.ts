/**
 * Link-integrity plugin tests.
 *
 * Four properties are load-bearing and every one of them is a way this layer
 * could be WORSE than not existing, so they get most of the file:
 *
 *  1. ONE FINDING, N OCCURRENCES. A broken footer link on 400 pages must
 *     produce one row with a count of 400 and ONE request. The alternative is a
 *     400-row report, which is a report nobody reaches the end of — the other
 *     defects underneath it are then invisible, so noise does the same damage
 *     as a miss.
 *  2. AN EXTERNAL LINK THAT TIMES OUT IS UNKNOWN, NOT BROKEN. QAAI must never
 *     file a partner site's bot wall as the customer's defect, at scale, across
 *     every outbound link they have.
 *  3. A HOP LIMIT IS NOT A REDIRECT LOOP. The first is OUR cap and the second
 *     is THEIR defect, and conflating them invents loops.
 *  4. EVERY CAP THAT BIT IS REPORTED AS A COUNT AND A REASON, and the targets
 *     it skipped are UNCHECKED rather than healthy.
 *
 * No network and no browser: the prober and the clock are injected, so the
 * rate limiter is exercised with no sleeping at all.
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactSink, ExecutableTest, RunContext } from '@qaai/shared';
import {
  EXTERNAL_INCONCLUSIVE_STATUSES,
  LINK_DEFECTS,
  LINK_DEFECT_CODES,
  LINK_DEFECT_FINDING_KIND,
  LINK_DEFECT_LABELS,
  LINK_DEFECT_PRESENCE,
  LINK_DEFECT_SEVERITY,
  ProbePacer,
  classifyTarget,
  findOrphanPages,
  followRedirects,
  groupEdgesByTarget,
  linkDefectSchema,
  linksPlugin,
  linksTestSpecSchema,
  measureLinks,
  resolveHref,
  runLinksTest,
  unavailableLinkProber,
} from './links.js';
import type { LinkClock, LinkProbeResult, LinkProber, LinksTestSpec } from './links.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** A clock that only moves when something sleeps, so the suite never waits. */
function fakeClock(): LinkClock & { readonly t: () => number } {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
    t: () => now,
  };
}

/** A prober answering from a table, recording every URL it was asked for. */
function fakeProber(
  table: Record<string, Partial<LinkProbeResult>>,
  fallback: Partial<LinkProbeResult> = { status: 200 },
): LinkProber & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    probe(url) {
      asked.push(url);
      const hit = table[url] ?? fallback;
      return Promise.resolve({
        status: hit.status ?? null,
        location: hit.location ?? null,
        error: hit.error ?? null,
      });
    },
  };
}

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

function makeContext(over: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'https://shop.example.com/',
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
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    ...over,
  };
}

function makeTest(spec: unknown): ExecutableTest {
  return {
    id: 'test_1',
    name: 'links',
    type: 'E2E',
    code: '',
    filePath: 'links.spec.ts',
    spec,
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
  };
}

/** A spec with every cap wide open, so a test only narrows what it is about. */
function makeSpec(over: Partial<LinksTestSpec> = {}): LinksTestSpec {
  return linksTestSpecSchema.parse({
    pages: [{ url: 'https://shop.example.com/', edges: [] }],
    requestsPerSecond: 200,
    ...over,
  });
}

const never = new AbortController().signal;

// ─── The vocabulary ──────────────────────────────────────────────────────────

describe('the defect vocabulary', () => {
  it('keeps the zod enum, the presence record and the union in step', () => {
    /*
     * The pattern this codebase requires beside a vocabulary with a write path,
     * and both halves are here because only one of them existed when eight
     * GateRule kinds shipped unsaveable for two slices. `check:wiring` cannot
     * see that class of defect, so this test is the only thing that can.
     */
    expect([...linkDefectSchema.options].sort()).toEqual([...LINK_DEFECTS].sort());
    expect(Object.keys(LINK_DEFECT_PRESENCE).sort()).toEqual([...LINK_DEFECTS].sort());
  });

  it('gives every defect a label, a severity, a code and a finding decision', () => {
    for (const defect of LINK_DEFECTS) {
      expect(LINK_DEFECT_LABELS[defect], defect).toBeTruthy();
      expect(LINK_DEFECT_SEVERITY[defect], defect).toBeTruthy();
      expect(LINK_DEFECT_CODES[defect], defect).toMatch(/^link-/);
      // `null` is a decision ("no honest FindingKind exists for this yet"), not
      // an omission — so `undefined` is the failure, not `null`.
      expect(LINK_DEFECT_FINDING_KIND[defect], defect).not.toBeUndefined();
    }
    expect(new Set(Object.values(LINK_DEFECT_CODES)).size).toBe(LINK_DEFECTS.length);
  });

  it('can actually produce every defect it declares', () => {
    /*
     * The third assertion the other two cannot make: a defect in the union with
     * no branch that emits it is reportable and unreachable at the same time,
     * which is exactly the shape of the eight unsaveable GateRule kinds.
     *
     * Driven through `measureLinks` rather than by re-deriving the list, so a
     * branch that stops emitting is caught here.
     */
    const spec = makeSpec({
      pages: [
        {
          url: 'https://shop.example.com/',
          edges: [
            { href: 'https://shop.example.com/gone', kind: 'LINK', selector: null },
            { href: 'https://shop.example.com/logo.png', kind: 'ASSET', selector: null },
            { href: 'https://shop.example.com/loop', kind: 'LINK', selector: null },
            { href: 'http://cdn.example.com/a.js', kind: 'ASSET', selector: null },
            { href: 'http://old.example.com/promo', kind: 'LINK', selector: null },
          ],
        },
      ],
      enumerated: ['https://shop.example.com/secret'],
      internalOrigins: ['https://shop.example.com'],
    });

    return measureLinks(
      spec,
      'https://shop.example.com/',
      {
        prober: fakeProber({
          'https://shop.example.com/gone': { status: 404 },
          'https://shop.example.com/logo.png': { status: 404 },
          'https://shop.example.com/loop': {
            status: 302,
            location: 'https://shop.example.com/loop',
          },
        }),
        clock: fakeClock(),
      },
      never,
    ).then((measurement) => {
      const produced = new Set(measurement.issues.map((issue) => issue.defect));
      expect([...produced].sort()).toEqual([...LINK_DEFECTS].sort());
    });
  });
});

// ─── Resolving hrefs ─────────────────────────────────────────────────────────

describe('resolving an href to a target', () => {
  it('resolves relative hrefs against the page that carried them', () => {
    expect(resolveHref('../cart', 'https://shop.example.com/a/b')).toEqual({
      ok: true,
      target: 'https://shop.example.com/cart',
    });
  });

  it('drops the fragment, so two anchors on one page are ONE request', () => {
    /*
     * `/pricing#plans` and `/pricing#faq` are one document. Keeping them apart
     * would request the same page twice and report one dead link as two — the
     * dedupe failure this layer exists to avoid, arriving through the back door.
     */
    const a = resolveHref('/pricing#plans', 'https://shop.example.com/');
    const b = resolveHref('/pricing#faq', 'https://shop.example.com/');
    expect(a).toEqual(b);
    expect(a).toEqual({ ok: true, target: 'https://shop.example.com/pricing' });
  });

  it('separates the three reasons an href is not a target', () => {
    // Each means something different to the reader: a mailto: is correct and
    // uncheckable, an unparseable href is probably a bug in the page, and a
    // same-document link points where it already is.
    expect(resolveHref('mailto:a@b.c', 'https://shop.example.com/')).toEqual({
      ok: false,
      reason: 'NOT_HTTP',
    });
    expect(resolveHref('javascript:void 0', 'https://shop.example.com/')).toEqual({
      ok: false,
      reason: 'NOT_HTTP',
    });
    expect(resolveHref('#top', 'https://shop.example.com/x')).toEqual({
      ok: false,
      reason: 'SAME_DOCUMENT',
    });
    expect(resolveHref('/a', 'not a url')).toEqual({ ok: false, reason: 'UNPARSEABLE' });
  });
});

// ─── Dedupe ──────────────────────────────────────────────────────────────────

describe('dedupe by target', () => {
  it('makes one broken footer link on 400 pages ONE group with 400 occurrences', () => {
    const pages = Array.from({ length: 400 }, (_, i) => ({
      url: `https://shop.example.com/p/${i}`,
      edges: [{ href: '/terms', kind: 'LINK' as const, selector: 'footer a' }],
    }));

    const grouped = groupEdgesByTarget(pages, {
      baseUrl: 'https://shop.example.com/',
      internalOrigins: [],
      maxOccurrencesPerTarget: 20,
    });

    expect(grouped.groups).toHaveLength(1);
    const [group] = grouped.groups;
    expect(group!.occurrenceCount).toBe(400);
    expect(group!.pageCount).toBe(400);
    // The EXAMPLE list is capped; the count never is. Reading the count off
    // `occurrences.length` is how "400 pages" becomes "20 pages" in a report.
    expect(group!.occurrences).toHaveLength(20);
  });

  it('requests one URL once however many pages carry it', async () => {
    const pages = Array.from({ length: 50 }, (_, i) => ({
      url: `https://shop.example.com/p/${i}`,
      edges: [{ href: '/terms', kind: 'LINK' as const, selector: null }],
    }));
    const prober = fakeProber({ 'https://shop.example.com/terms': { status: 404 } });

    const measurement = await measureLinks(
      makeSpec({ pages }),
      'https://shop.example.com/',
      { prober, clock: fakeClock() },
      never,
    );

    expect(prober.asked).toEqual(['https://shop.example.com/terms']);
    expect(measurement.issues).toHaveLength(1);
    expect(measurement.issues[0]!.occurrenceCount).toBe(50);
  });

  it('orders most-referenced first, so a cap keeps the link that matters', () => {
    // The order IS the contract: `maxTargets` truncates this list, so it has to
    // keep the footer link on 400 pages and drop the one-off, identically on
    // every run.
    const grouped = groupEdgesByTarget(
      [
        {
          url: 'https://shop.example.com/',
          edges: [
            { href: '/rare', kind: 'LINK', selector: null },
            { href: '/common', kind: 'LINK', selector: null },
          ],
        },
        {
          url: 'https://shop.example.com/b',
          edges: [{ href: '/common', kind: 'LINK', selector: null }],
        },
      ],
      { baseUrl: 'https://shop.example.com/', internalOrigins: [], maxOccurrencesPerTarget: 20 },
    );

    expect(grouped.groups.map((g) => g.target)).toEqual([
      'https://shop.example.com/common',
      'https://shop.example.com/rare',
    ]);
  });

  it('counts the hrefs that produced no target instead of dropping them', () => {
    const grouped = groupEdgesByTarget(
      [
        {
          url: 'https://shop.example.com/x',
          edges: [
            { href: 'mailto:a@b.c', kind: 'LINK', selector: null },
            { href: 'tel:+1', kind: 'LINK', selector: null },
            { href: '#top', kind: 'LINK', selector: null },
          ],
        },
      ],
      { baseUrl: 'https://shop.example.com/', internalOrigins: [], maxOccurrencesPerTarget: 20 },
    );

    expect(grouped.groups).toHaveLength(0);
    expect(grouped.unresolved).toEqual({ NOT_HTTP: 2, UNPARSEABLE: 0, SAME_DOCUMENT: 1 });
  });

  it('reports a page whose own URL cannot be parsed rather than silently losing its edges', () => {
    const grouped = groupEdgesByTarget(
      [{ url: 'http://[bad', edges: [{ href: '/a', kind: 'LINK', selector: null }] }],
      { baseUrl: 'https://shop.example.com/', internalOrigins: [], maxOccurrencesPerTarget: 20 },
    );
    expect(grouped.unparseablePages).toEqual(['http://[bad']);
    expect(grouped.unresolved.UNPARSEABLE).toBe(1);
  });
});

// ─── Redirects ───────────────────────────────────────────────────────────────

describe('following a redirect chain', () => {
  it('calls a repeat a LOOP', async () => {
    const chain = await followRedirects(
      'https://shop.example.com/a',
      fakeProber({
        'https://shop.example.com/a': { status: 302, location: '/b' },
        'https://shop.example.com/b': { status: 302, location: '/a' },
      }),
      10,
      new ProbePacer(0, fakeClock()),
      never,
    );

    expect(chain.outcome).toBe('LOOP');
    expect(chain.hops).toEqual([
      'https://shop.example.com/a',
      'https://shop.example.com/b',
      'https://shop.example.com/a',
    ]);
  });

  it('calls a long chain a HOP_LIMIT, which is NOT a loop', async () => {
    /*
     * The honesty case. A chain of six redirects under a five-hop budget is a
     * long chain, and reporting it as a loop would put a defect on the
     * customer's site on the strength of OUR cap. A loop is only a loop when a
     * URL repeats; nothing else is evidence.
     */
    const chain = await followRedirects(
      'https://shop.example.com/0',
      {
        probe: (url) => {
          const n = Number(new URL(url).pathname.slice(1));
          return Promise.resolve({ status: 302, location: `/${n + 1}`, error: null });
        },
      },
      5,
      new ProbePacer(0, fakeClock()),
      never,
    );

    expect(chain.outcome).toBe('HOP_LIMIT');
    expect(chain.hops).toHaveLength(6);
    expect(new Set(chain.hops).size).toBe(6);

    const { verdict, detail } = classifyTarget({ internal: true, chain });
    expect(verdict).toBe('UNKNOWN');
    expect(detail).toMatch(/NOT a loop/);
    expect(detail).toMatch(/maxRedirectHops/);
  });

  it('notices a chain stepping down from https to http', async () => {
    const chain = await followRedirects(
      'https://shop.example.com/a',
      fakeProber({
        'https://shop.example.com/a': { status: 301, location: 'http://shop.example.com/b' },
        'http://shop.example.com/b': { status: 200 },
      }),
      5,
      new ProbePacer(0, fakeClock()),
      never,
    );

    expect(chain.outcome).toBe('RESOLVED');
    expect(chain.downgradeAt).toEqual({
      from: 'https://shop.example.com/a',
      to: 'http://shop.example.com/b',
    });
  });

  it('stops at a 3xx with no usable Location rather than inventing a next hop', async () => {
    const chain = await followRedirects(
      'https://shop.example.com/a',
      fakeProber({ 'https://shop.example.com/a': { status: 302, location: null } }),
      5,
      new ProbePacer(0, fakeClock()),
      never,
    );
    expect(chain.outcome).toBe('RESOLVED');
    expect(chain.final.status).toBe(302);
    expect(chain.hops).toEqual(['https://shop.example.com/a']);
  });
});

// ─── The external/internal judgement ─────────────────────────────────────────

describe('classifying a probed target', () => {
  const resolved = (status: number | null, error: string | null = null) => ({
    hops: ['https://x/'],
    final: { status, location: null, error },
    outcome: 'RESOLVED' as const,
    downgradeAt: null,
  });

  it('reads a request that did not complete as UNKNOWN, for either origin', () => {
    // We cannot tell our own network from the far end, so nothing is asserted
    // in either direction. An internal transport error is in the same position:
    // the run itself is the other party to that failure.
    for (const internal of [true, false]) {
      const { verdict, detail } = classifyTarget({
        internal,
        chain: resolved(null, 'ETIMEDOUT'),
      });
      expect(verdict, String(internal)).toBe('UNKNOWN');
      expect(detail).toMatch(/UNKNOWN, not broken/);
      expect(detail).toMatch(/ETIMEDOUT/);
    }
  });

  it('never calls somebody else’s bot wall or outage a broken link', () => {
    /*
     * The defect that would do the most damage per line of code: filing a
     * partner site's 403 as the customer's dead link, across every outbound
     * link they have. 401/403/407/408/425/429/451 are what a partner returns to
     * an unknown client and a human with a browser reaches it fine; a 5xx is a
     * third party having a bad minute.
     */
    for (const status of EXTERNAL_INCONCLUSIVE_STATUSES) {
      expect(
        classifyTarget({ internal: false, chain: resolved(status) }).verdict,
        String(status),
      ).toBe('UNKNOWN');
    }
    expect(classifyTarget({ internal: false, chain: resolved(503) }).verdict).toBe('UNKNOWN');
  });

  it('does call an external 404 broken, because the server said so positively', () => {
    // The counter-test: the UNKNOWN branch above must not swallow the defect it
    // sits next to. A 404/410 is a statement that the thing they linked to is
    // gone, and that IS the customer's dead link.
    const { verdict, detail } = classifyTarget({ internal: false, chain: resolved(404) });
    expect(verdict).toBe('BROKEN');
    expect(detail).toMatch(/stating positively/);
    expect(classifyTarget({ internal: false, chain: resolved(410) }).verdict).toBe('BROKEN');
  });

  it('calls the customer’s own 404 and 500 broken', () => {
    expect(classifyTarget({ internal: true, chain: resolved(404) }).verdict).toBe('BROKEN');
    expect(classifyTarget({ internal: true, chain: resolved(500) }).verdict).toBe('BROKEN');
    // Including the statuses that are inconclusive on somebody else's origin:
    // a bot wall on your OWN site in front of a linked page is still a defect.
    expect(classifyTarget({ internal: true, chain: resolved(403) }).verdict).toBe('BROKEN');
  });

  it('calls a 2xx and a resolved 3xx OK', () => {
    expect(classifyTarget({ internal: true, chain: resolved(200) }).verdict).toBe('OK');
    expect(classifyTarget({ internal: true, chain: resolved(301) }).verdict).toBe('OK');
  });

  it('decides internal from the base URL and internalOrigins, end to end', async () => {
    /*
     * The origin decision is what makes the UNKNOWN rules above apply to the
     * right party, and it is the one half of them that `classifyTarget` cannot
     * check — it is handed `internal` as a boolean. So this drives the same
     * 503 through `measureLinks` from three origins at once: the base URL's,
     * one named in `internalOrigins`, and a stranger's.
     *
     * Both directions matter. "Everything is internal" would file a partner's
     * outage as a dead link; "everything is external" would quietly stop
     * reporting the customer's own 5xx, which is the defect they are paying to
     * hear about.
     */
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [
              { href: 'https://shop.example.com/own', kind: 'LINK', selector: null },
              { href: 'https://cdn.shop.example.com/also-own', kind: 'LINK', selector: null },
              { href: 'https://partner.example.com/theirs', kind: 'LINK', selector: null },
            ],
          },
        ],
        internalOrigins: ['https://cdn.shop.example.com'],
      }),
      'https://shop.example.com/',
      {
        prober: fakeProber({}, { status: 503 }),
        clock: fakeClock(),
      },
      never,
    );

    expect(measurement.issues.map((i) => i.target).sort()).toEqual([
      'https://cdn.shop.example.com/also-own',
      'https://shop.example.com/own',
    ]);
    // The partner's 503 is UNKNOWN, and the two of ours are BROKEN.
    expect(measurement.verdicts.BROKEN).toBe(2);
    expect(measurement.verdicts.UNKNOWN).toBe(1);
  });

  it('distinguishes UNCHECKED from UNKNOWN and carries the reason', () => {
    const { verdict, detail } = classifyTarget({
      internal: true,
      chain: null,
      uncheckedReason: 'maxTargets bit',
    });
    expect(verdict).toBe('UNCHECKED');
    expect(detail).toBe('maxTargets bit');
  });
});

// ─── Mixed content and downgrades ────────────────────────────────────────────

describe('the two downgrades', () => {
  it('splits a subresource from a link, because only one breaks the page', async () => {
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [
              { href: 'http://cdn.example.com/a.js', kind: 'ASSET', selector: 'script' },
              { href: 'http://partner.example.com/x', kind: 'LINK', selector: 'a' },
            ],
          },
        ],
      }),
      'https://shop.example.com/',
      { prober: fakeProber({}), clock: fakeClock() },
      never,
    );

    const defects = measurement.issues.map((i) => i.defect).sort();
    expect(defects).toEqual(['HTTPS_DOWNGRADE', 'MIXED_CONTENT']);
    expect(LINK_DEFECT_SEVERITY.MIXED_CONTENT).toBe('SERIOUS');
    expect(LINK_DEFECT_SEVERITY.HTTPS_DOWNGRADE).toBe('MODERATE');
  });

  it('does not report a downgrade from a page that was itself http', async () => {
    // `http://` linking to `http://` is not a downgrade — there was no tunnel
    // to leave. A check that fired here would light up every local and preview
    // environment in the product.
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'http://localhost:3000/',
            edges: [{ href: 'http://localhost:3000/a.js', kind: 'ASSET', selector: null }],
          },
        ],
      }),
      'http://localhost:3000/',
      { prober: fakeProber({}), clock: fakeClock() },
      never,
    );
    expect(measurement.issues).toEqual([]);
  });

  it('still reports mixed content for a target a cap stopped us probing', async () => {
    /*
     * Worth pinning: the two downgrades are statements about the EDGE, so they
     * hold whether or not the request was ever made. A reading that required a
     * probe would silently lose them the moment a cap bit.
     */
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [{ href: 'http://cdn.example.com/a.js', kind: 'ASSET', selector: null }],
          },
        ],
        checkExternal: false,
      }),
      'https://shop.example.com/',
      { prober: fakeProber({}), clock: fakeClock() },
      never,
    );

    expect(measurement.issues.map((i) => i.defect)).toEqual(['MIXED_CONTENT']);
    expect(measurement.verdicts.UNCHECKED).toBe(1);
    expect(measurement.caps.map((c) => c.cap)).toContain('checkExternal');
  });

  it('reports a target used both ways and broken as BOTH defects', async () => {
    // "The logo is missing" and "the nav link is dead" are two bug reports, and
    // collapsing them to one drops whichever the reader needed.
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [
              { href: '/img/hero.png', kind: 'ASSET', selector: 'img' },
              { href: '/img/hero.png', kind: 'LINK', selector: 'a' },
            ],
          },
        ],
      }),
      'https://shop.example.com/',
      {
        prober: fakeProber({ 'https://shop.example.com/img/hero.png': { status: 404 } }),
        clock: fakeClock(),
      },
      never,
    );

    expect(measurement.issues.map((i) => i.defect).sort()).toEqual(['DEAD_ASSET', 'DEAD_LINK']);
    for (const issue of measurement.issues) expect(issue.occurrenceCount).toBe(2);
  });
});

// ─── Caps ────────────────────────────────────────────────────────────────────

describe('every cap that bit', () => {
  it('reports maxTargets as a count AND a reason, and keeps the rest UNCHECKED', async () => {
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [
              { href: '/a', kind: 'LINK', selector: null },
              { href: '/a', kind: 'LINK', selector: null },
              { href: '/a', kind: 'LINK', selector: null },
              { href: '/b', kind: 'LINK', selector: null },
              { href: '/b', kind: 'LINK', selector: null },
              { href: '/c', kind: 'LINK', selector: null },
            ],
          },
        ],
        maxTargets: 2,
      }),
      'https://shop.example.com/',
      { prober: fakeProber({}), clock: fakeClock() },
      never,
    );

    const cap = measurement.caps.find((c) => c.cap === 'maxTargets');
    expect(cap).toBeDefined();
    expect(cap!.count).toBe(1);
    expect(cap!.reason).toMatch(/UNCHECKED, not healthy/);
    expect(cap!.reason).toMatch(/maxTargets is 2/);
    // Unchecked, never counted as fine.
    expect(measurement.verdicts.OK).toBe(2);
    expect(measurement.verdicts.UNCHECKED).toBe(1);
  });

  it('spends the budget on the most-referenced targets', async () => {
    const prober = fakeProber({});
    await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [
              { href: '/rare', kind: 'LINK', selector: null },
              { href: '/common', kind: 'LINK', selector: null },
              { href: '/common', kind: 'LINK', selector: null },
            ],
          },
        ],
        maxTargets: 1,
      }),
      'https://shop.example.com/',
      { prober, clock: fakeClock() },
      never,
    );
    expect(prober.asked).toEqual(['https://shop.example.com/common']);
  });

  it('reports the wall-clock budget, with the count of targets it cost', async () => {
    /*
     * Exact arithmetic on purpose. 10 requests per second is a 100ms minimum
     * interval; the first probe pays nothing and each one after pays 100ms, so
     * the 1000ms budget expires having probed 11 of the 15 targets. A cap that
     * bit and printed a vague sentence would be a run duration nobody can
     * explain.
     */
    const pages = [
      {
        url: 'https://shop.example.com/',
        edges: Array.from({ length: 15 }, (_, i) => ({
          href: `/t${i}`,
          kind: 'LINK' as const,
          selector: null,
        })),
      },
    ];
    const measurement = await measureLinks(
      makeSpec({ pages, requestsPerSecond: 10, budgetMs: 1000 }),
      'https://shop.example.com/',
      { prober: fakeProber({}), clock: fakeClock() },
      never,
    );

    const cap = measurement.caps.find((c) => c.cap === 'budgetMs');
    expect(cap).toBeDefined();
    expect(cap!.count).toBe(4);
    expect(cap!.reason).toMatch(/1000ms/);
    expect(measurement.verdicts.OK).toBe(11);
    expect(measurement.verdicts.UNCHECKED).toBe(4);
  });

  it('discloses the rate limit even though it skipped nothing', async () => {
    // The pacer does not lose any coverage; it makes the run slow. Disclosed so
    // the first person to debug the duration does not look at the customer's
    // servers.
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [
              { href: '/a', kind: 'LINK', selector: null },
              { href: '/b', kind: 'LINK', selector: null },
              { href: '/c', kind: 'LINK', selector: null },
            ],
          },
        ],
        requestsPerSecond: 2,
      }),
      'https://shop.example.com/',
      { prober: fakeProber({}), clock: fakeClock() },
      never,
    );

    const cap = measurement.caps.find((c) => c.cap === 'requestsPerSecond');
    expect(cap).toBeDefined();
    expect(cap!.count).toBe(2);
    expect(cap!.reason).toMatch(/1000ms in total/);
    expect(cap!.reason).toMatch(/Nothing was skipped/);
  });

  it('does not invent a rate-limit disclosure when the limiter never paused', () => {
    // Null rather than `{pausedMs: 0}`: a cap that did not bite has nothing to
    // disclose, and a 0 in a report reads as a measurement.
    expect(new ProbePacer(100, fakeClock()).cost).toBeNull();
  });

  it('leaves the remaining targets UNCHECKED when the run is cancelled', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [{ href: '/a', kind: 'LINK', selector: null }],
          },
        ],
      }),
      'https://shop.example.com/',
      { prober: fakeProber({}), clock: fakeClock() },
      aborted.signal,
    );

    expect(measurement.verdicts.UNCHECKED).toBe(1);
    const cap = measurement.caps.find((c) => c.cap === 'cancellation');
    expect(cap!.count).toBe(1);
    expect(cap!.reason).toMatch(/UNCHECKED, not healthy/);
  });

  it('reads a prober that threw as UNKNOWN rather than as the site’s defect', async () => {
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [{ href: '/a', kind: 'LINK', selector: null }],
          },
        ],
      }),
      'https://shop.example.com/',
      {
        prober: {
          probe: () => Promise.reject(new Error('proxy refused')),
        },
        clock: fakeClock(),
      },
      never,
    );

    expect(measurement.verdicts.UNKNOWN).toBe(1);
    expect(measurement.issues).toEqual([]);
  });
});

// ─── Orphans ─────────────────────────────────────────────────────────────────

describe('orphan pages', () => {
  it('is NOT MEASURED when there is no enumeration, never "zero orphans"', async () => {
    /*
     * A zero denominator reporting a clean result is the same lie as a coverage
     * percentage of 100 over nothing, and it is the easiest one to ship here:
     * an empty `enumerated` list produces no orphans entirely by accident.
     */
    const measurement = await measureLinks(
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [{ href: '/a', kind: 'LINK', selector: null }],
          },
        ],
        enumerated: [],
      }),
      'https://shop.example.com/',
      { prober: fakeProber({}), clock: fakeClock() },
      never,
    );
    expect(measurement.orphans).toBeNull();

    const execution = await runLinksTest(
      makeContext(),
      makeTest({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [{ href: '/a', kind: 'LINK', selector: null }],
          },
        ],
      }),
      makeSpec({
        pages: [
          {
            url: 'https://shop.example.com/',
            edges: [{ href: '/a', kind: 'LINK', selector: null }],
          },
        ],
      }),
      { prober: fakeProber({}), clock: fakeClock() },
    );
    const step = execution.steps.find((s) => s.title.includes('Orphan pages NOT MEASURED'));
    expect(step?.status).toBe('SKIPPED');
    expect(step?.title).toMatch(/not zero orphans/);
  });

  it('finds an enumerated page no link points at', () => {
    const groups = groupEdgesByTarget(
      [
        {
          url: 'https://shop.example.com/',
          edges: [{ href: '/reachable', kind: 'LINK', selector: null }],
        },
      ],
      { baseUrl: 'https://shop.example.com/', internalOrigins: [], maxOccurrencesPerTarget: 20 },
    ).groups;

    const report = findOrphanPages(
      ['https://shop.example.com/reachable', 'https://shop.example.com/hidden'],
      groups,
      'https://shop.example.com/',
    );
    expect(report.orphans).toEqual(['https://shop.example.com/hidden']);
    expect(report.considered).toBe(2);
  });

  it('never calls the base URL an orphan', () => {
    // Every crawl starts there, so it is reachable by definition. Reporting it
    // would be noise on every single run.
    const report = findOrphanPages(['https://shop.example.com/'], [], 'https://shop.example.com/');
    expect(report.orphans).toEqual([]);
    expect(report.considered).toBe(1);
  });

  it('does not count an image reference as making a page navigable', () => {
    /*
     * The whole point of the check. A page only ever loaded as an `<img src>`
     * is not navigable, and treating an ASSET edge as "reachable" would hide
     * exactly the defect this looks for.
     */
    const groups = groupEdgesByTarget(
      [
        {
          url: 'https://shop.example.com/',
          edges: [{ href: '/hidden', kind: 'ASSET', selector: 'img' }],
        },
      ],
      { baseUrl: 'https://shop.example.com/', internalOrigins: [], maxOccurrencesPerTarget: 20 },
    ).groups;

    expect(
      findOrphanPages(['https://shop.example.com/hidden'], groups, 'https://shop.example.com/')
        .orphans,
    ).toEqual(['https://shop.example.com/hidden']);
  });

  it('excludes an unparseable enumerated entry instead of guessing', () => {
    const report = findOrphanPages(['http://[bad'], [], 'https://shop.example.com/');
    expect(report.unparseable).toEqual(['http://[bad']);
    expect(report.considered).toBe(0);
  });
});

// ─── The result ──────────────────────────────────────────────────────────────

describe('the execution a links test produces', () => {
  const onePage = {
    pages: [
      {
        url: 'https://shop.example.com/',
        edges: [{ href: '/gone', kind: 'LINK' as const, selector: 'nav a' }],
      },
    ],
  };

  it('FAILS on a defect, and names every unchecked axis in the message', async () => {
    const execution = await runLinksTest(
      makeContext(),
      makeTest(onePage),
      makeSpec({ ...onePage, checks: ['DEAD_LINK'] }),
      {
        prober: fakeProber({ 'https://shop.example.com/gone': { status: 404 } }),
        clock: fakeClock(),
      },
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/1 link-integrity defect/);
    expect(execution.errorMessage).toMatch(/NOT checked for:/);
    expect(execution.errorMessage).toMatch(/ORPHAN_PAGE/);
    expect(execution.steps.filter((s) => s.status === 'FAILED')).toHaveLength(1);
  });

  it('SKIPS with notRun when nothing was classified, rather than passing', async () => {
    /*
     * The result that must never be PASSED. A green links test over a prober
     * that answered nothing is the "no drift since the last crawl, because the
     * comparison did not run" lie wearing a URL for a hat.
     */
    const execution = await runLinksTest(makeContext(), makeTest(onePage), makeSpec(onePage), {
      prober: unavailableLinkProber,
      clock: fakeClock(),
    });

    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun).toEqual({
      kind: 'NOT_RUN',
      why: expect.stringContaining('No link target was classified'),
    });
    expect(execution.errorMessage).toMatch(/1 UNKNOWN/);
  });

  it('PASSES with the disclosure attached when everything checked was healthy', async () => {
    const execution = await runLinksTest(makeContext(), makeTest(onePage), makeSpec(onePage), {
      prober: fakeProber({}),
      clock: fakeClock(),
    });

    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toMatch(/No link-integrity defect found/);
    expect(execution.errorMessage).toMatch(/Checked 1 of 1 distinct target/);
  });

  it('files only the two transport-security defects as Findings', async () => {
    /*
     * `FINDING_KINDS` has no member for link integrity, and filing a dead image
     * under ACCESSIBILITY to get it a row would attribute a measurement to an
     * axis that did not make it. So four of the six ride on steps alone, and
     * this pins which — if a future `LINK_INTEGRITY` kind lands, this assertion
     * is the one that has to change on purpose.
     */
    const spec = {
      pages: [
        {
          url: 'https://shop.example.com/',
          edges: [
            { href: 'http://cdn.example.com/a.js', kind: 'ASSET' as const, selector: null },
            { href: '/gone', kind: 'LINK' as const, selector: null },
          ],
        },
      ],
    };
    const execution = await runLinksTest(makeContext(), makeTest(spec), makeSpec(spec), {
      prober: fakeProber({ 'https://shop.example.com/gone': { status: 404 } }),
      clock: fakeClock(),
    });

    expect(execution.findings.map((f) => f.code)).toEqual(['link-mixed-content']);
    expect(execution.findings[0]!.kind).toBe('SECURITY');
    expect(execution.findings[0]!.message).toMatch(/1 occurrence\(s\) on 1 page\(s\)/);
    // The dead link is still fully reported, just not as a Finding row.
    expect(execution.steps.some((s) => s.title.includes('Dead link'))).toBe(true);
  });

  it('puts every cap on a step of its own, not only in a summary sentence', async () => {
    const spec = {
      pages: [
        {
          url: 'https://shop.example.com/',
          edges: [
            { href: '/a', kind: 'LINK' as const, selector: null },
            { href: '/b', kind: 'LINK' as const, selector: null },
          ],
        },
      ],
    };
    const execution = await runLinksTest(
      makeContext(),
      makeTest(spec),
      makeSpec({ ...spec, maxTargets: 1 }),
      { prober: fakeProber({}), clock: fakeClock() },
    );

    const capStep = execution.steps.find((s) => s.title.startsWith('Cap applied: maxTargets'));
    expect(capStep?.status).toBe('SKIPPED');
    expect(capStep?.title).toMatch(/\(1\)/);
    expect(execution.console.some((c) => c.text.includes('maxTargets is 1'))).toBe(true);
  });
});

// ─── The plugin seam ─────────────────────────────────────────────────────────

describe('the plugin', () => {
  it('rejects a spec that could not measure anything, before a run is queued', () => {
    /*
     * A test whose only check is ORPHAN_PAGE with no enumeration measures
     * NOTHING. Caught in `validate` rather than at run time: an author who
     * learns this from a SKIPPED result has waited for a run to be told about a
     * mistake that was visible on the spec.
     */
    expect(() =>
      linksPlugin.validate(
        makeTest({
          pages: [{ url: 'https://shop.example.com/', edges: [] }],
          checks: ['ORPHAN_PAGE'],
        }),
      ),
    ).toThrow(/could not measure anything/);
  });

  it('accepts the same spec once it carries an enumeration', () => {
    expect(() =>
      linksPlugin.validate(
        makeTest({
          pages: [{ url: 'https://shop.example.com/', edges: [] }],
          checks: ['ORPHAN_PAGE'],
          enumerated: ['https://shop.example.com/x'],
        }),
      ),
    ).not.toThrow();
  });

  it('names the test in an invalid-spec message', () => {
    expect(() => linksPlugin.validate(makeTest({ pages: [] }))).toThrow(/has an invalid spec/);
  });

  it('reports UNAVAILABLE rather than answering 200 when no prober is configured', async () => {
    // A stub that answered 200 would declare every link in the product healthy
    // on the strength of a fake, which is worse than having no plugin: it would
    // move a number.
    const result = await unavailableLinkProber.probe('https://shop.example.com/', never);
    expect(result.status).toBeNull();
    expect(result.error).toMatch(/Nothing was measured/);
  });
});
