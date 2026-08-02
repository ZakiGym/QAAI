/**
 * The properties that decide whether a performance test survives contact with a
 * real CI box.
 *
 * Almost every case here is about the same thing: ONE MEASUREMENT IS NOISE. A
 * perf plugin that fails on the worst of five loads gets muted in a week, and a
 * perf plugin that hides the disagreement is worse than no plugin at all,
 * because everyone believes the page is being watched. The tests below pin both
 * halves — the verdict is stable, and the doubt is stated out loud.
 *
 * The rest pin the house rules this repo has already been bitten by: a missing
 * tool is a note or a skip and never a failure, and a metric that could not be
 * measured is never quietly reported as a pass.
 */

import { describe, expect, it } from 'vitest';
import { performanceTestSpecSchema } from '@qaai/shared';
import { pluginFor } from '../registry.js';
import {
  INP_OBSERVATION_FLOOR_MS,
  classifyResource,
  displayUrl,
  evaluateBudget,
  isMissingBrowserError,
  lighthouseArgs,
  median,
  parseLighthouseReport,
  performancePlugin,
  summarise,
  toIteration,
  totalBlockingTime,
} from './performance.js';

const spec = performanceTestSpecSchema.parse({});

const budget = (samples: number[], limit: number, unit: 'ms' | 'score' | 'kb' = 'ms') =>
  evaluateBudget({
    label: 'LCP',
    unit,
    samples,
    budget: limit,
    spreadTolerance: 0.25,
    unmeasuredReason: 'nothing measured it',
  });

// ─── The median is the verdict ───────────────────────────────────────────────

describe('the median is what gates, so one bad load cannot fail the build', () => {
  it('takes the middle value of an odd sample', () => {
    expect(median([300, 100, 200])).toBe(200);
  });

  it('averages the middle two of an even sample', () => {
    expect(median([100, 200, 300, 400])).toBe(250);
  });

  it('passes when a single outlier blows past the budget but the median does not', () => {
    // The exact shape of a cold cache or a busy runner: four normal loads and
    // one that took four seconds. Failing here is what gets perf tests deleted.
    const verdict = budget([1800, 1900, 2000, 2100, 9000], 2500);
    expect(verdict.status).toBe('PASSED');
  });

  it('fails when the median itself is over budget, outlier or not', () => {
    // Sorted: 900, 2600, 2700, 2800, 2900 — one suspiciously fast load does not
    // rescue a page that is over budget four times out of five.
    const verdict = budget([2600, 2700, 2800, 2900, 900], 2500);
    expect(verdict.status).toBe('FAILED');
    expect(verdict.message).toContain('2700ms');
    expect(verdict.message).toContain('2500ms');
  });

  it('puts the measured value and the budget in the failure, not just "too slow"', () => {
    const verdict = budget([4000, 4000, 4000], 2500);
    expect(verdict.message).toMatch(/4000ms/);
    expect(verdict.message).toMatch(/2500ms budget/);
  });
});

// ─── …and the doubt is stated out loud ───────────────────────────────────────

describe('when the loads disagreed, the step says the verdict is not trustworthy', () => {
  it('says so on a pass where some loads breached', () => {
    const verdict = budget([2000, 2100, 2400, 2600, 3000], 2500);
    expect(verdict.status).toBe('PASSED');
    expect(verdict.untrustworthy).toBe(true);
    expect(verdict.title).toContain('not trustworthy');
    expect(verdict.title).toContain('2 of 5 loads');
  });

  it('says so on a failure where some loads were inside the budget', () => {
    const verdict = budget([2000, 2100, 2600, 2700, 3000], 2500);
    expect(verdict.status).toBe('FAILED');
    expect(verdict.untrustworthy).toBe(true);
    expect(verdict.message).toContain('rather than a settled regression');
    // The title counts the loads that MET the budget — the same two the message
    // calls "inside the budget". Printing the breach count next to the word
    // "met" made one result state two different numbers about itself.
    expect(verdict.title).toContain('2 of 5 loads met the budget');
    expect(verdict.message).toContain('2 of 5 loads were inside the budget');
  });

  it('does NOT cry wolf when every load agreed', () => {
    const verdict = budget([1000, 1100, 1200], 2500);
    expect(verdict.untrustworthy).toBe(false);
    expect(verdict.title).not.toContain('not trustworthy');
  });

  it('flags a wide spread even when the budget was never close', () => {
    // 200ms to 900ms is a factor of four. The verdict is safe; the number is not
    // a fact, and pretending otherwise is how a 3x regression hides inside noise.
    const verdict = budget([200, 400, 900], 5000);
    expect(verdict.status).toBe('PASSED');
    expect(verdict.noisy).toBe(true);
    expect(verdict.title).toContain('a range, not a fact');
  });

  it('always exposes the spread, not just the median', () => {
    expect(budget([100, 200, 300], 5000).title).toContain('3 loads, 100ms–300ms');
  });

  it('calls a single load a sample rather than a verdict', () => {
    const verdict = budget([1500], 2500);
    expect(verdict.status).toBe('PASSED');
    expect(verdict.title).toContain('raise `iterations`');
  });

  it('treats a zero median with a real range as noisy rather than as perfectly stable', () => {
    // CLS does this constantly: 0, 0, 0.3. Dividing by a zero median must not
    // produce "0% spread" and a confident green tick.
    const stats = summarise([0, 0, 0.3])!;
    expect(stats.median).toBe(0);
    expect(Number.isFinite(stats.relativeSpread)).toBe(false);
    expect(budget([0, 0, 0.3], 1, 'score').noisy).toBe(true);
  });

  it('does not cry wolf about a 4ms wobble, whatever the percentage says', () => {
    // Straight from the first live run: TTFB of 1ms, 1ms, 5ms is a 277% relative
    // spread and means absolutely nothing. A warning that fires there is a
    // warning people learn to skip past, which costs us the one that matters.
    const verdict = budget([1, 1, 5], 800);
    expect(verdict.stats!.relativeSpread).toBeGreaterThan(2);
    expect(verdict.noisy).toBe(false);
    expect(verdict.title).not.toContain('a range, not a fact');
    // The range is still shown — it is a fact. The percentage is not, because a
    // green tick next to "spread 350%" makes a reader distrust the whole report.
    expect(verdict.title).toContain('3 loads, 1ms–5ms');
    expect(verdict.title).not.toContain('spread');
  });

  it('still flags an unstable VERDICT at any magnitude', () => {
    // The absolute floor mutes the spread warning, never the disagreement: if
    // some loads met the budget and others did not, the verdict is a coin flip
    // no matter how small the numbers are.
    const verdict = budget([1, 1, 5], 3);
    expect(verdict.noisy).toBe(false);
    expect(verdict.untrustworthy).toBe(true);
    expect(verdict.title).toContain('not trustworthy');
  });
});

// ─── Never invent a pass ─────────────────────────────────────────────────────

describe('a budget that could not be evaluated is not a pass', () => {
  it('reports SKIPPED with the reason when nothing was measured', () => {
    const verdict = evaluateBudget({
      label: 'INP',
      unit: 'ms',
      samples: [],
      budget: 200,
      spreadTolerance: 0.25,
      unmeasuredReason: 'nothing interacted with the page',
    });
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.status).not.toBe('PASSED');
    expect(verdict.message).toBe('nothing interacted with the page');
  });

  it('never reports an INP of zero when nobody interacted', () => {
    const iteration = toIteration(
      {
        nonce: 'doc-1',
        lcp: 1200,
        fcp: 800,
        cls: 0.01,
        ttfb: 120,
        longTasks: [],
        interactionDurations: [],
        interactionCount: 0,
        documentBytes: 5000,
        resources: [],
        observerErrors: [],
      },
      spec,
    );
    // A zero here would be a perfect score for something nobody measured.
    expect(iteration.metrics.inpMs).toBeUndefined();
    expect(iteration.metrics.lcpMs).toBe(1200);
  });

  it('reports INP once something actually interacted', () => {
    const iteration = toIteration(
      {
        nonce: 'doc-1',
        lcp: 1200,
        fcp: 800,
        cls: 0,
        ttfb: 120,
        longTasks: [],
        interactionDurations: [40, 310, 90],
        interactionCount: 3,
        documentBytes: 0,
        resources: [],
        observerErrors: [],
      },
      spec,
    );
    expect(iteration.metrics.inpMs).toBe(310);
  });

  it('reports an upper bound, not a skip, when the clicks were too fast to time', () => {
    // The platform will not report an event shorter than 16ms, so an instant
    // page looks identical to a page nobody touched. interactionCount tells them
    // apart, and "at most 16ms" is a usable verdict against a ceiling budget.
    const iteration = toIteration(
      {
        nonce: 'doc-1',
        lcp: 1200,
        fcp: 800,
        cls: 0,
        ttfb: 120,
        longTasks: [],
        interactionDurations: [],
        interactionCount: 4,
        documentBytes: 0,
        resources: [],
        observerErrors: [],
      },
      spec,
    );
    expect(iteration.metrics.inpMs).toBe(INP_OBSERVATION_FLOOR_MS);
    expect(iteration.inpUpperBound).toBe(true);
  });

  it('appends the note it is given, so an upper bound is never read as a reading', () => {
    const verdict = evaluateBudget({
      label: 'INP',
      unit: 'ms',
      samples: [16, 16, 16],
      budget: 200,
      spreadTolerance: 0.25,
      unmeasuredReason: 'unused',
      note: 'this is an upper bound',
    });
    expect(verdict.status).toBe('PASSED');
    expect(verdict.title).toContain('this is an upper bound');
  });
});

// ─── A missing tool is never a failing test ──────────────────────────────────

describe('missing tooling is a note or a skip, never a failure', () => {
  it('recognises every way Playwright says the browser is not installed', () => {
    for (const message of [
      "Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app",
      'Please run the following command to download new browsers: npx playwright install',
      'browserType.launch: Target page, context or browser has been closed',
    ]) {
      expect(isMissingBrowserError(message)).toBe(true);
    }
  });

  it('does not mistake a slow page for a missing browser', () => {
    expect(isMissingBrowserError('page.goto: Timeout 45000ms exceeded')).toBe(false);
    expect(isMissingBrowserError('net::ERR_CONNECTION_REFUSED')).toBe(false);
  });
});

// ─── Lighthouse ──────────────────────────────────────────────────────────────

const LH_REPORT = JSON.stringify({
  audits: {
    'largest-contentful-paint': { numericValue: 2312.4 },
    'cumulative-layout-shift': { numericValue: 0.042 },
    'total-blocking-time': { numericValue: 130 },
    'first-contentful-paint': { numericValue: 900 },
    'server-response-time': { numericValue: 88 },
    'resource-summary': {
      details: {
        items: [
          { resourceType: 'total', transferSize: 512_000 },
          { resourceType: 'script', transferSize: 300_000 },
          { resourceType: 'stylesheet', transferSize: 40_000 },
          { resourceType: 'image', transferSize: 150_000 },
        ],
      },
    },
    'network-requests': {
      details: {
        items: [
          { url: 'https://shop.test/app.js', resourceType: 'Script', transferSize: 280_000 },
          { url: 'https://shop.test/hero.png', resourceType: 'Image', transferSize: 150_000 },
        ],
      },
    },
  },
});

describe('reading Lighthouse', () => {
  it('maps its audits onto the metrics QAAI budgets on', () => {
    const parsed = parseLighthouseReport(LH_REPORT, 5);
    expect('iteration' in parsed).toBe(true);
    if (!('iteration' in parsed)) return;
    expect(parsed.iteration.metrics.lcpMs).toBeCloseTo(2312.4);
    expect(parsed.iteration.metrics.clsScore).toBeCloseTo(0.042);
    expect(parsed.iteration.metrics.tbtMs).toBe(130);
    expect(parsed.iteration.metrics.ttfbMs).toBe(88);
    expect(parsed.iteration.bytes.js).toBe(300_000);
    expect(parsed.iteration.bytes.total).toBe(512_000);
    expect(parsed.iteration.offenders[0]?.url).toBe('https://shop.test/app.js');
  });

  it('refuses to read numbers out of a run Lighthouse says failed', () => {
    // The trap: a NO_FCP report is well-formed and full of zeros. Reading it
    // would manufacture a perfect score for a page that never rendered.
    const parsed = parseLighthouseReport(
      JSON.stringify({
        runtimeError: { code: 'NO_FCP', message: 'The page did not paint any content' },
        audits: { 'largest-contentful-paint': { numericValue: 0 } },
      }),
      5,
    );
    expect('error' in parsed).toBe(true);
    if (!('error' in parsed)) return;
    expect(parsed.error).toContain('NO_FCP');
  });

  it('reports unreadable output as an error rather than throwing', () => {
    expect(parseLighthouseReport('<html>not json</html>', 5)).toHaveProperty('error');
    expect(parseLighthouseReport('{}', 5)).toHaveProperty('error');
  });

  it('rebuilds byte totals from the request list when resource-summary is absent', () => {
    const parsed = parseLighthouseReport(
      JSON.stringify({
        audits: {
          'largest-contentful-paint': { numericValue: 1000 },
          'network-requests': {
            details: {
              items: [{ url: 'https://shop.test/a.js', resourceType: 'Script', transferSize: 1234 }],
            },
          },
        },
      }),
      5,
    );
    if (!('iteration' in parsed)) throw new Error('expected a parsed iteration');
    expect(parsed.iteration.bytes.total).toBe(1234);
    expect(parsed.iteration.bytes.js).toBe(1234);
  });
});

describe('the two engines are pinned to the same throttling profile', () => {
  it('tells Lighthouse to simulate nothing when the spec asks for no throttling', () => {
    // Lighthouse's default is a mid-tier phone on slow 4G. Left alone, the same
    // page would clear a budget on one engine and blow it on the other, and the
    // budget would mean nothing.
    const args = lighthouseArgs(spec, 'http://localhost:5050/', '/tmp/lh.json');
    expect(args).toContain('--throttling-method=provided');
    expect(args).toContain('--screenEmulation.disabled');
    expect(args[0]).toBe('http://localhost:5050/');
  });

  it('passes the spec’s own CPU and network numbers through when it does', () => {
    const throttled = performanceTestSpecSchema.parse({
      throttle: { cpuMultiplier: 4, network: 'fast-3g' },
    });
    const args = lighthouseArgs(throttled, 'http://localhost:5050/', '/tmp/lh.json');
    expect(args).toContain('--throttling-method=devtools');
    expect(args).toContain('--throttling.cpuSlowdownMultiplier=4');
    expect(args).toContain('--throttling.downloadThroughputKbps=1638');
    expect(args).toContain('--throttling.requestLatencyMs=563');
  });

  it('keeps every argument a separate array element, so nothing is ever a command line', () => {
    const args = lighthouseArgs(spec, 'http://localhost:5050/', '/tmp/lh.json');
    // One --chrome-flags element carries spaces on purpose; nothing else may,
    // because a spec-supplied value in a shell string would be RCE.
    expect(args.filter((a) => a.includes(' '))).toHaveLength(1);
  });
});

// ─── Bytes: the number a team can act on ─────────────────────────────────────

describe('classifying bytes', () => {
  it.each([
    ['https://shop.test/assets/app.4f2c.js', 'script', 'js'],
    ['https://shop.test/assets/app.css', 'link', 'css'],
    ['https://shop.test/hero.webp', 'img', 'image'],
    ['https://shop.test/promo.mp4', 'video', 'media'],
    ['https://shop.test/page.html', 'other', 'document'],
  ])('classifies %s as %s', (url, initiator, expected) => {
    expect(classifyResource(url, initiator)).toBe(expected);
  });

  it('counts a webfont as a font even though a stylesheet requested it', () => {
    // initiatorType describes who ASKED, not what it is. Trusting it would hide
    // the biggest font payload on the page inside the CSS budget.
    expect(classifyResource('https://shop.test/inter.woff2', 'css')).toBe('font');
  });

  it('ignores the query string when deciding', () => {
    expect(classifyResource('https://shop.test/app.js?v=8f21a&t=1', 'other')).toBe('js');
  });

  it('falls back to the initiator, then to "other", and never throws', () => {
    expect(classifyResource('data:image/png;base64,iVBORw0KGgo=', 'img')).toBe('image');
    expect(classifyResource('https://shop.test/api/products', 'fetch')).toBe('other');
    expect(classifyResource('', '')).toBe('other');
  });

  it('counts the HTML document itself and every resource into the total', () => {
    const iteration = toIteration(
      {
        nonce: 'doc-1',
        lcp: 1000,
        fcp: 500,
        cls: 0,
        ttfb: 50,
        longTasks: [],
        interactionDurations: [],
        interactionCount: 0,
        documentBytes: 4_000,
        resources: [
          { url: 'https://shop.test/a.js', initiatorType: 'script', transferSize: 10_000, encodedBodySize: 10_000 },
          { url: 'https://shop.test/a.css', initiatorType: 'link', transferSize: 2_000, encodedBodySize: 2_000 },
        ],
        observerErrors: [],
      },
      spec,
    );
    expect(iteration.bytes.document).toBe(4_000);
    expect(iteration.bytes.js).toBe(10_000);
    expect(iteration.bytes.css).toBe(2_000);
    expect(iteration.bytes.total).toBe(16_000);
  });

  it('falls back to the encoded size for a cache hit, and counts what stays invisible', () => {
    const iteration = toIteration(
      {
        nonce: 'doc-1',
        lcp: 1000,
        fcp: 500,
        cls: 0,
        ttfb: 50,
        longTasks: [],
        interactionDurations: [],
        interactionCount: 0,
        documentBytes: 0,
        resources: [
          // Cache hit: transferSize 0 but the body size is known.
          { url: 'https://shop.test/a.js', initiatorType: 'script', transferSize: 0, encodedBodySize: 9_000 },
          // Cross-origin with no Timing-Allow-Origin: the browser discloses nothing.
          { url: 'https://cdn.test/b.js', initiatorType: 'script', transferSize: 0, encodedBodySize: 0 },
        ],
        observerErrors: [],
      },
      spec,
    );
    expect(iteration.bytes.js).toBe(9_000);
    // A byte total missing part of the page must say so rather than pass quietly.
    expect(iteration.opaqueResources).toBe(1);
  });
});

describe('naming an offending file without leaking a token', () => {
  it('redacts a sensitive query parameter and still reads like a URL', () => {
    const shown = displayUrl('https://cdn.test/bundle.js?token=SUPERSECRETVALUE&v=3');
    expect(shown).not.toContain('SUPERSECRETVALUE');
    // …and not as %E2%80%A2 soup, which reads like corruption in the one place a
    // person is trying to identify a file to delete.
    expect(shown).not.toContain('%E2%80%A2');
    expect(shown).toContain('cdn.test/bundle.js');
    expect(shown).toContain('v=3');
  });

  it('leaves an ordinary URL completely alone', () => {
    expect(displayUrl('https://cdn.test/app.4f2c.js')).toBe('https://cdn.test/app.4f2c.js');
  });
});

// ─── TBT ─────────────────────────────────────────────────────────────────────

describe('total blocking time', () => {
  it('counts only the part of each long task beyond 50ms', () => {
    expect(totalBlockingTime([{ start: 100, duration: 120 }], 0)).toBe(70);
    expect(
      totalBlockingTime(
        [
          { start: 100, duration: 120 },
          { start: 400, duration: 60 },
        ],
        0,
      ),
    ).toBe(80);
  });

  it('ignores tasks that finished before the first paint', () => {
    expect(totalBlockingTime([{ start: 0, duration: 200 }], 500)).toBe(0);
  });

  it('is zero, not undefined, when the page never blocked', () => {
    expect(totalBlockingTime([], 300)).toBe(0);
  });
});

// ─── Contract ────────────────────────────────────────────────────────────────

describe('the plugin contract', () => {
  it('is registered — a plugin missing from the registry is dead code that typechecks', () => {
    expect(pluginFor('PERFORMANCE')).toBe(performancePlugin);
    expect(performancePlugin.type).toBe('PERFORMANCE');
  });

  it('accepts a spec that says nothing, because the budgets have defaults', () => {
    // A perf test with no budgets always passes, which is worse than no test.
    expect(() =>
      performancePlugin.validate({
        id: 't1',
        name: 'home page',
        type: 'PERFORMANCE',
        code: '',
        filePath: 'perf/home.json',
        spec: {},
        timeoutMs: 60_000,
        quarantined: false,
        tags: [],
      }),
    ).not.toThrow();
    expect(spec.budgets.lcpMs).toBe(2500);
    expect(spec.iterations).toBeGreaterThan(1);
  });

  it('throws a sentence naming the bad field', () => {
    expect(() =>
      performancePlugin.validate({
        id: 't2',
        name: 'home page',
        type: 'PERFORMANCE',
        code: '',
        filePath: 'perf/home.json',
        spec: { iterations: 400, budgets: { lcpMs: -5 } },
        timeoutMs: 60_000,
        quarantined: false,
        tags: [],
      }),
    ).toThrow(/Performance test "home page" has an invalid spec — .*iterations/s);
  });

  it('lets a spec turn one metric’s gate off without turning them all off', () => {
    const partial = performanceTestSpecSchema.parse({ budgets: { inpMs: null, lcpMs: 4000 } });
    expect(partial.budgets.inpMs).toBeNull();
    expect(partial.budgets.lcpMs).toBe(4000);
    // Unmentioned metrics keep gating — the load.ts rule: never silently
    // degrade into a test that cannot fail.
    expect(partial.budgets.clsScore).toBe(0.1);
  });
});
