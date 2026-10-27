/**
 * Adversarial tests for the LINKS plugin: the things a report must never do.
 *
 * Separate from links.test.ts, which covers the plugin's own rules. This file
 * covers four defects found by attacking it, three of which were real:
 *
 *  1. A QUERY STRING IN A REPORT. The plugin's input is crawled URLs, and a
 *     crawl of a password-reset page carries `?token=…` on the page url while
 *     a `<script src="…?key=…">` carries an API key on the target. Both reached
 *     `Finding.location` and the step titles verbatim — and those are stored on
 *     the TestResult row, exported through the SARIF reporter into a file teams
 *     upload to GitHub code scanning, and rendered in the cockpit. A reset
 *     token in a third party's alert database is a disclosure, not a finding.
 *  2. A DISPLAY CAP DECIDING WHETHER A DEFECT EXISTS. MIXED_CONTENT was read
 *     off the `maxOccurrencesPerTarget`-capped example list, so an http script
 *     on the 21st https page of a site went unreported while twenty http pages
 *     filled the list.
 *  3. THAT CAP NEVER APPEARING IN `caps` at all.
 *
 * The fourth — "one broken footer link on 400 pages becomes 400 findings" —
 * was REFUTED and is pinned here anyway, because it is the property that makes
 * this layer cheap enough to run and nothing else asserts it at scale.
 */

import { describe, expect, it } from 'vitest';
import type { RunContext, TestExecution } from '@qaai/shared';
import {
  classifyTarget,
  groupEdgesByTarget,
  issuesForTarget,
  linksTestSpecSchema,
  LINK_DEFECTS,
  measureLinks,
  printableUrl,
  runLinksTest,
  scrubUrlsInText,
  type LinkClock,
  type LinkProber,
  type LinkProbeResult,
} from './links.js';

const clock: LinkClock = { now: () => 0, sleep: async () => {} };
const signal = (): AbortSignal => new AbortController().signal;

const answering = (answer: (url: string) => LinkProbeResult): LinkProber => ({
  probe: (url) => Promise.resolve(answer(url)),
});

const ok = answering(() => ({ status: 200, location: null, error: null }));

function context(): RunContext {
  return {
    baseUrl: 'https://shop.test',
    signal: signal(),
    logger: {
      step: () => {},
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    },
  } as unknown as RunContext;
}

async function execute(spec: unknown, prober: LinkProber): Promise<TestExecution> {
  const parsed = linksTestSpecSchema.parse(spec);
  return runLinksTest(
    context(),
    { id: 't_1', name: 'links', spec: parsed } as never,
    parsed,
    { prober, clock },
  );
}

/** Every string a reader could ever see on one result, as one blob. */
function reportedText(execution: TestExecution): string {
  return JSON.stringify({
    steps: execution.steps,
    console: execution.console,
    findings: execution.findings,
    errorMessage: execution.errorMessage,
    network: execution.network,
  });
}

describe('no credential reaches a links report', () => {
  const SECRETS = {
    pageToken: 'RESET-TOKEN-9f2a',
    linkCode: 'OAUTH-CODE-77',
    assetKey: 'APIKEY-abc123',
    hopSignature: 'SIG-deadbeef',
    errorToken: 'ERRTOKEN-5150',
  };

  it('strips the query from the page url, the link, the asset and the redirect hop', async () => {
    const execution = await execute(
      {
        pages: [
          {
            // The page the crawl was ON is the likeliest leak of all: a reset
            // link IS the page url.
            url: `https://shop.test/reset?token=${SECRETS.pageToken}`,
            edges: [
              { href: `/confirm?code=${SECRETS.linkCode}`, kind: 'LINK', selector: 'a.cta' },
              { href: `http://cdn.test/t.js?key=${SECRETS.assetKey}`, kind: 'ASSET', selector: 'script' },
            ],
          },
        ],
      },
      answering((url) =>
        url.includes('/confirm')
          ? {
              status: 302,
              // A `Location` is where an OAuth code and a signed download live.
              location: `https://shop.test/done?sig=${SECRETS.hopSignature}`,
              error: null,
            }
          : { status: 404, location: null, error: null },
      ),
    );

    const text = reportedText(execution);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    // Not a vacuous pass: the defect really was reported, by path.
    expect(text).toContain('http://cdn.test/t.js');
    expect(text).toContain('/reset');
  });

  it('strips it from a prober’s own error text, which is the error path', () => {
    /*
     * The ERROR path, asserted on `classifyTarget` rather than on a whole
     * execution — and deliberately, because measuring it showed something
     * worth writing down: an UNKNOWN target produces no issue, so this detail
     * reaches no step and no finding on today's result. It is a public return
     * value of an exported pure function all the same, and a real `fetch`
     * rejection quotes the URL it failed on, so redacting the target and then
     * handing the token back in the reason beside it is a leak waiting for its
     * first caller. The hole in the other direction — that nobody is TOLD why a
     * target is UNKNOWN — is in this round's handover.
     */
    const classified = classifyTarget({
      internal: true,
      chain: {
        hops: ['https://shop.test/a'],
        final: {
          status: null,
          location: null,
          error: `fetch failed for https://shop.test/a?token=${SECRETS.errorToken} (ECONNRESET)`,
        },
        outcome: 'RESOLVED',
        downgradeAt: null,
      },
    });

    expect(classified.verdict).toBe('UNKNOWN');
    expect(classified.detail).not.toContain(SECRETS.errorToken);
    expect(classified.detail).toContain('ECONNRESET');
  });

  it('discloses how many URLs it shortened, so a reader can match them to the HTML', async () => {
    const measurement = await measureLinks(
      linksTestSpecSchema.parse({
        pages: [
          { url: 'https://shop.test/a?x=1', edges: [{ href: '/b?y=2', kind: 'LINK', selector: null }] },
        ],
      }),
      'https://shop.test',
      { prober: ok, clock },
      signal(),
    );

    const cap = measurement.caps.find((entry) => entry.cap === 'query string redaction');
    expect(cap?.count).toBe(2);
    expect(cap?.reason).toMatch(/full URL was still requested/);
  });

  it('keeps the full URL for the REQUEST, because liveness depends on the query', async () => {
    // The redaction is a display rule. If it reached the prober, a link that
    // 404s only with its query would come back 200 and the defect would vanish.
    const requested: string[] = [];
    await execute(
      {
        pages: [
          {
            url: 'https://shop.test/',
            edges: [{ href: '/download?file=report.pdf', kind: 'LINK', selector: null }],
          },
        ],
      },
      answering((url) => {
        requested.push(url);
        return { status: 200, location: null, error: null };
      }),
    );

    expect(requested).toEqual(['https://shop.test/download?file=report.pdf']);
  });

  it('drops rather than masks, because a truncated token is still a token', () => {
    expect(printableUrl('https://x.test/p?token=abc#frag')).toEqual({
      url: 'https://x.test/p',
      dropped: true,
    });
    expect(printableUrl('https://x.test/p')).toEqual({ url: 'https://x.test/p', dropped: false });
    // An unparseable href cannot be cleaned structurally, so it is cut.
    expect(printableUrl('::not a url::?token=abc').url).toBe('::not a url::');
    expect(scrubUrlsInText('two https://a.test/x?k=1 and https://b.test/y#z here')).toBe(
      'two https://a.test/x and https://b.test/y here',
    );
  });
});

describe('a display cap may not decide whether a defect exists', () => {
  /** 25 http pages and ONE https page, all carrying the same http script. */
  const pages = [
    ...Array.from({ length: 25 }, (_, index) => ({
      url: `http://shop.test/p${index}`,
      edges: [{ href: 'http://cdn.test/app.js', kind: 'ASSET' as const, selector: 'script' }],
    })),
    {
      url: 'https://shop.test/secure',
      edges: [{ href: 'http://cdn.test/app.js', kind: 'ASSET' as const, selector: 'script' }],
    },
  ];

  it('finds the mixed content on the page beyond maxOccurrencesPerTarget', () => {
    const grouped = groupEdgesByTarget(pages, {
      baseUrl: 'https://shop.test',
      internalOrigins: [],
      maxOccurrencesPerTarget: 20,
    });
    const group = grouped.groups[0];
    expect(group).toBeDefined();
    if (group === undefined) return;

    // The shape of the trap: the counts disagree with the example list, and the
    // only https occurrence is NOT in the list.
    expect(group.occurrenceCount).toBe(26);
    expect(group.occurrences).toHaveLength(20);
    expect(group.occurrences.some((o) => o.pageWasSecure)).toBe(false);
    expect(group.secureAssetCount).toBe(1);

    const issues = issuesForTarget(
      group,
      'OK',
      'answered 200',
      null,
      new Set(LINK_DEFECTS),
    );
    const mixed = issues.find((issue) => issue.defect === 'MIXED_CONTENT');
    expect(mixed).toBeDefined();
    // And it SAYS it has no example, rather than printing an empty list as if
    // the defect were unevidenced.
    expect(mixed?.detail).toMatch(/No example page is listed/);
  });

  it('discloses the example cap as a count and a reason', async () => {
    const measurement = await measureLinks(
      linksTestSpecSchema.parse({ pages, maxOccurrencesPerTarget: 20 }),
      'https://shop.test',
      { prober: ok, clock },
      signal(),
    );

    const cap = measurement.caps.find((entry) => entry.cap === 'maxOccurrencesPerTarget');
    expect(cap?.count).toBe(6);
    expect(cap?.reason).toMatch(/no defect was decided from the example list/);
  });
});

describe('the properties that make this layer runnable at all', () => {
  it('reports one finding with 400 occurrences, after exactly one request', async () => {
    const pages = Array.from({ length: 400 }, (_, index) => ({
      url: `https://shop.test/p${index}`,
      edges: [{ href: '/legal/terms', kind: 'LINK' as const, selector: 'footer a' }],
    }));
    let requests = 0;

    const measurement = await measureLinks(
      linksTestSpecSchema.parse({ pages }),
      'https://shop.test',
      {
        prober: answering((url) => {
          requests += 1;
          return url.endsWith('/legal/terms')
            ? { status: 404, location: null, error: null }
            : { status: 200, location: null, error: null };
        }),
        clock,
      },
      signal(),
    );

    expect(measurement.issues).toHaveLength(1);
    expect(measurement.issues[0]?.occurrenceCount).toBe(400);
    expect(measurement.issues[0]?.pageCount).toBe(400);
    // The whole economics of this plugin: one request, not four hundred.
    expect(requests).toBe(1);
  });

  it('calls a partner site that times out UNKNOWN, not the customer’s dead link', () => {
    const timedOut = classifyTarget({
      internal: false,
      chain: {
        hops: ['https://partner.example/deal'],
        final: { status: null, location: null, error: 'ETIMEDOUT' },
        outcome: 'RESOLVED',
        downgradeAt: null,
      },
    });
    expect(timedOut.verdict).toBe('UNKNOWN');
    expect(timedOut.detail).toMatch(/cannot tell its own network from the far end/);

    // And a 404 from the same origin IS theirs: the server stated it is gone.
    expect(
      classifyTarget({
        internal: false,
        chain: {
          hops: ['https://partner.example/deal'],
          final: { status: 404, location: null, error: null },
          outcome: 'RESOLVED',
          downgradeAt: null,
        },
      }).verdict,
    ).toBe('BROKEN');
  });
});
