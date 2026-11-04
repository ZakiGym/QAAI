import { describe, expect, it } from 'vitest';
import { CrawlEgressGate } from './crawl/egress.js';
import type { CrawlEgressGuard, GuardAnswer } from './crawl/egress.js';
import {
  crawlApp,
  guardCrawlAdapter,
  runCrawl,
  type CrawlAdapter,
  type CrawlOpenInput,
  type CrawlPage,
} from './crawler';
import type { EgressDecision, GuardedTarget } from '@qaai/shared';

/**
 * THE CRAWL'S ADOPTION OF THE EGRESS GATE.
 *
 * `packages/agent/src/crawl/egress.test.ts` covers the GATE — that it asks,
 * records, counts and pins. `packages/shared/src/egress-guard.test.ts` covers
 * the GUARD's decisions. NEITHER of them proves the crawler calls any of it,
 * and that was the whole defect: for one round the gate and the guard were
 * complete, tested, and imported by nothing but their own tests, which is the
 * state `scripts/check-wiring.ts` calls DISCONNECTED and the thing the last
 * four rounds kept producing — "a module with excellent vocabulary and no
 * door".
 *
 * So these tests are about the DOOR. They assert that the crawl asks before it
 * navigates, that a refusal does not reach the real adapter, that the pins
 * reach the browser, that the refusal is COUNTED and REPORTED rather than
 * silently shrinking the denominator, and — the one that matters most — that
 * the production entry point cannot be called ungated.
 *
 * NO NETWORK AND NO DNS. The gate's guard is injected in every test but one;
 * the exception drives the REAL guard against an IP LITERAL, which
 * `decideEgress` decides without consulting a resolver at all (`verdict.kind
 * === 'address'` returns before `io.lookup`). That is what lets the production
 * door be tested rather than described.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────

function target(host: string): GuardedTarget {
  return { scheme: 'https:', host, port: '', origin: `https://${host}` };
}

function decision(host: string, over: Partial<EgressDecision> = {}): EgressDecision {
  return {
    context: 'CRAWL',
    host,
    allowed: true,
    outcome: 'ALLOWED',
    refusal: null,
    decidedByClass: 'public',
    allowlistedBy: null,
    mode: 'ENFORCE',
    pinned: null,
    detail: `${host} resolved to a public address.`,
    warning: null,
    ...over,
  };
}

function allow(host: string, addresses: readonly string[] = ['93.184.216.34']): GuardAnswer {
  return {
    ok: true,
    permit: {
      kind: 'PINNED',
      context: 'CRAWL',
      target: target(host),
      pinned: {
        host,
        addresses: addresses.map((address) => ({ address, class: 'public' as const })),
        pinnedAt: '2026-10-29T12:00:00.000Z',
        fromLiteral: false,
      },
      wouldRefuse: null,
      decision: decision(host),
    },
  };
}

function refuse(host: string): GuardAnswer {
  return {
    ok: false,
    refusal: 'CLASS_NOT_PERMITTED',
    operatorDetail: `Refusing ${host}: it resolves to 169.254.169.254, a link-local address.`,
    context: 'CRAWL',
    target: target(host),
    decision: decision(host, {
      allowed: false,
      outcome: 'REFUSED',
      refusal: 'CLASS_NOT_PERMITTED',
      decidedByClass: 'link-local',
    }),
    paddedMs: 250,
  };
}

/** A guard that allows the hosts named and refuses everything else. */
function guardAllowing(...hosts: readonly string[]): { guard: CrawlEgressGuard; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    guard: async (url) => {
      asked.push(url);
      const host = new URL(url).hostname;
      return hosts.includes(host) ? allow(host) : refuse(host);
    },
  };
}

function gateWith(guard: CrawlEgressGuard): CrawlEgressGate {
  let tick = 0;
  return new CrawlEgressGate({ guard, clock: () => (tick += 1_000) });
}

/**
 * The smallest adapter that records what it was asked to do.
 *
 * It records `opened` — the `CrawlOpenInput` it received — because the launch
 * argument is the only way a pin reaches Chromium, so "did the rules arrive"
 * is a fact about this object and not about a browser.
 */
function recordingAdapter(): {
  adapter: CrawlAdapter;
  navigated: string[];
  fetched: string[];
  drove: string[];
  opened: CrawlOpenInput[];
} {
  const navigated: string[] = [];
  const fetched: string[] = [];
  const drove: string[] = [];
  const opened: CrawlOpenInput[] = [];
  const page: CrawlPage = {
    async goto(url) {
      navigated.push(url);
      return { requestedUrl: url, finalUrl: url, status: 200 };
    },
    currentUrl: () => 'https://app.example.com/',
    title: async () => 'the title nobody outside should read',
    documentSnapshot: async () => ({}) as never,
    pageStructure: async () => null,
    rawSnapshot: async () => null,
    forms: async () => [],
    affordances: async () => [],
    downloadAnchors: async () => [],
  };
  return {
    navigated,
    fetched,
    drove,
    opened,
    adapter: {
      fetcher: {
        async get(url) {
          fetched.push(url);
          return { status: 200, body: 'User-agent: *' };
        },
      },
      async open(input) {
        opened.push(input);
        return {
          pages: [page],
          events: null,
          observerCapabilities: {},
          interaction: null,
          variants: {},
          async driveVariant(_setup, url) {
            drove.push(url);
            return { outcome: 'OBSERVED', facts: null, detail: 'drove it' };
          },
          async close() {},
        };
      },
    },
  };
}

// ─── The gate is asked before anything leaves ───────────────────────────────

describe('guardCrawlAdapter asks before every outbound path', () => {
  it('ASKS THE GATE AND REACHES THE REAL ADAPTER for an allowed URL', async () => {
    const real = recordingAdapter();
    const { guard, asked } = guardAllowing('app.example.com');
    const guarded = guardCrawlAdapter({ adapter: real.adapter, gate: gateWith(guard) });

    const browser = await guarded.open({ baseUrl: 'https://app.example.com/', workers: 1 });
    const nav = await browser.pages[0]!.goto('https://app.example.com/orders');

    expect(nav.status).toBe(200);
    expect(real.navigated).toEqual(['https://app.example.com/orders']);
    // The base URL is admitted at `open`, which is what gives the launch a pin.
    expect(asked).toContain('https://app.example.com/');
    expect(asked).toContain('https://app.example.com/orders');
  });

  it('REFUSES A NAVIGATION WITHOUT CALLING THE REAL ADAPTER', async () => {
    // The recorded defect: `baseUrl` is validated by `z.string().url()` plus a
    // protocol check, so the IMDS address is accepted at the door and the
    // crawl drives a browser to it from inside the API container.
    const real = recordingAdapter();
    const { guard } = guardAllowing('app.example.com');
    const guarded = guardCrawlAdapter({ adapter: real.adapter, gate: gateWith(guard) });

    const browser = await guarded.open({ baseUrl: 'https://app.example.com/', workers: 1 });
    const nav = await browser.pages[0]!.goto('http://169.254.169.254/latest/meta-data/');

    // NOT ONE BYTE LEFT. This is the assertion that distinguishes a guard from
    // a log line: the real page was never asked to navigate.
    expect(real.navigated).toEqual([]);
    expect(nav.status).toBeNull();
    expect(nav.failure).toBeTruthy();
  });

  it('GATES THE ROBOTS/SITEMAP FETCH, which is the attacker-influenced one', async () => {
    /*
     * A sitemap is a document the TARGET writes and it may name any URL at all,
     * so these are not "our own base URL" requests — they are a list of
     * destinations supplied by the thing under test. The real adapter fetches
     * them with `redirect: 'follow'`.
     */
    const real = recordingAdapter();
    const { guard } = guardAllowing('app.example.com');
    const guarded = guardCrawlAdapter({ adapter: real.adapter, gate: gateWith(guard) });

    const allowed = await guarded.fetcher!.get('https://app.example.com/robots.txt');
    const refused = await guarded.fetcher!.get('http://10.0.0.5/sitemap.xml');

    expect(allowed.status).toBe(200);
    expect(real.fetched).toEqual(['https://app.example.com/robots.txt']);
    // `status: null` is what distinguishes "we could not fetch robots.txt"
    // from "this site publishes none". Never a 200 with an empty body.
    expect(refused.status).toBeNull();
    expect(refused.body).toBeNull();
  });

  it('GATES THE VARIANT DRIVE, which does not look like a navigation from here', async () => {
    const real = recordingAdapter();
    const { guard } = guardAllowing('app.example.com');
    const guarded = guardCrawlAdapter({ adapter: real.adapter, gate: gateWith(guard) });

    const browser = await guarded.open({ baseUrl: 'https://app.example.com/', workers: 1 });
    const ok = await browser.driveVariant({} as never, 'https://app.example.com/cart');
    const no = await browser.driveVariant({} as never, 'http://127.0.0.1:9200/_cluster/health');

    expect(ok.outcome).toBe('OBSERVED');
    expect(no.outcome).toBe('REFUSED');
    // `facts: null` is the three-state convention: nobody looked. A zeroed
    // facts object would be a measurement of a page nobody opened.
    expect(no.facts).toBeNull();
    expect(real.drove).toEqual(['https://app.example.com/cart']);
  });

  it('forwards every non-outbound page method to the real page', async () => {
    // The spread is why a reader added to `CrawlPage` later is forwarded rather
    // than silently becoming undefined — only the outbound methods are
    // overridden, and a decorator that re-listed the readers would be the
    // hand-copied projection that made an earlier fix unreachable.
    const real = recordingAdapter();
    const { guard } = guardAllowing('app.example.com');
    const guarded = guardCrawlAdapter({ adapter: real.adapter, gate: gateWith(guard) });
    const browser = await guarded.open({ baseUrl: 'https://app.example.com/', workers: 1 });

    expect(await browser.pages[0]!.title()).toBe('the title nobody outside should read');
    expect(browser.pages[0]!.currentUrl()).toBe('https://app.example.com/');
  });
});

// ─── The pin reaches the browser ────────────────────────────────────────────

describe('the pin is delivered to the browser', () => {
  it('PASSES --host-resolver-rules BUILT FROM THE PINS to the adapter', async () => {
    const real = recordingAdapter();
    const { guard } = guardAllowing('app.example.com');
    const guarded = guardCrawlAdapter({ adapter: real.adapter, gate: gateWith(guard) });

    await guarded.open({ baseUrl: 'https://app.example.com/', workers: 2 });

    const rules = real.opened[0]?.hostResolverRules;
    expect(rules).toContain('app.example.com');
    expect(rules).toContain('93.184.216.34');
    // Everything else about the open input is passed through untouched.
    expect(real.opened[0]?.workers).toBe(2);
  });

  it('passes NO rules rather than an empty one when nothing was pinned', async () => {
    // `--host-resolver-rules=` is a different argument to Chromium than its
    // absence, and an empty rule set has broken its resolver before.
    const real = recordingAdapter();
    const { guard } = guardAllowing(); // refuses everything, so nothing pins
    const guarded = guardCrawlAdapter({ adapter: real.adapter, gate: gateWith(guard) });

    await guarded.open({ baseUrl: 'http://169.254.169.254/', workers: 1 });

    expect(real.opened[0]?.hostResolverRules).toBeUndefined();
  });
});

// ─── The refusal is counted and reported, never a silent shrink ─────────────

describe('a refused URL is reported, not silently dropped', () => {
  it('PUTS THE EGRESS SUMMARY IN `caveats`, so the denominator reads as a FLOOR', async () => {
    /*
     * THE LIE THIS PREVENTS. A crawl that enumerated less of an application
     * because a policy refused part of it, and said nothing, would report a
     * smaller denominator as the whole surface — and the coverage percentage
     * would go UP on the day the control started working. `caveats` is the
     * field whose stated job is "every reason the numbers above are a FLOOR".
     */
    const real = recordingAdapter();
    const { guard } = guardAllowing('app.test');
    const gate = gateWith(guard);
    // A refusal the gate has recorded before the crawl reports.
    await gate.admit({ url: 'http://169.254.169.254/latest/meta-data/' });

    const outcome = await runCrawl(real.adapter, {
      baseUrl: 'https://app.test/',
      projectId: 'p1',
      environmentId: 'e1',
      version: 1,
      maxPages: 1,
      maxDepth: 0,
      egressGate: gate,
    });

    expect(outcome.caveats.join(' | ')).toContain('refused by egress policy');
  });

  it('says nothing about egress when the gate refused nothing', async () => {
    // A caveat that appears on every clean crawl is noise, and noise is how a
    // real one stops being read.
    const real = recordingAdapter();
    const { guard } = guardAllowing('app.test');

    const outcome = await runCrawl(real.adapter, {
      baseUrl: 'https://app.test/',
      projectId: 'p1',
      environmentId: 'e1',
      version: 1,
      maxPages: 1,
      maxDepth: 0,
      egressGate: gateWith(guard),
    });

    expect(outcome.caveats.join(' | ')).not.toContain('egress');
  });
});

// ─── The production door ────────────────────────────────────────────────────

describe('crawlApp cannot be called ungated', () => {
  it('REFUSES A LOOPBACK BASE URL THROUGH THE REAL GUARD, with no gate supplied', async () => {
    /*
     * THE TEST THAT PROVES THE DOOR. No `egressGate` is passed, so `crawlApp`
     * builds a real one — the real `guardUrl`, the real `classifyHost`, the
     * real `resolveEgressPolicy` — and the only reason this runs without a
     * network is that `127.0.0.1` is an IP LITERAL: `decideEgress` returns at
     * `verdict.kind === 'address'` before it ever reaches `io.lookup`.
     *
     * No `egressPolicy` is passed either, which is the second half of the
     * point: `resolveEgressPolicy(undefined)` falls back to the HOSTED policy,
     * PUBLIC ONLY. An absent policy is the STRICTEST one, not an open one.
     *
     * If `crawlApp` ever stops building a gate, `navigated` goes non-empty and
     * this test goes red. That is the assertion — not the refusal text.
     */
    const real = recordingAdapter();

    const outcome = await crawlApp({
      baseUrl: 'http://127.0.0.1/',
      projectId: 'p1',
      environmentId: 'e1',
      version: 1,
      maxPages: 1,
      maxDepth: 0,
      adapter: real.adapter,
    });

    expect(real.navigated).toEqual([]);
    expect(outcome.caveats.join(' | ')).toContain('refused by egress policy');
  });

  it('refuses the IMDS address through the real guard too', async () => {
    const real = recordingAdapter();

    await crawlApp({
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
      projectId: 'p1',
      environmentId: 'e1',
      version: 1,
      maxPages: 1,
      maxDepth: 0,
      adapter: real.adapter,
    });

    expect(real.navigated).toEqual([]);
  });
});

// ─── No oracle ──────────────────────────────────────────────────────────────

describe('a refusal tells the tenant nothing about our network', () => {
  it('GIVES BYTE-IDENTICAL output for a link-local host and an unresolvable one', async () => {
    /*
     * For a crawl the tenant IS the adversary: they chose the base URL and the
     * network they are mapping is ours. "That is a link-local address" and
     * "that host did not resolve" are two different facts about the inside of
     * our infrastructure, and the crawl's progress events already report what
     * answered.
     */
    const real = recordingAdapter();
    const linkLocal = guardCrawlAdapter({
      adapter: real.adapter,
      gate: gateWith(async (url) => refuse(new URL(url).hostname)),
    });
    const unresolvable = guardCrawlAdapter({
      adapter: real.adapter,
      gate: gateWith(async (url) => ({
        ok: false as const,
        refusal: 'UNRESOLVED' as const,
        operatorDetail: `Refusing ${new URL(url).hostname}: it could not be resolved.`,
        context: 'CRAWL' as const,
        target: target(new URL(url).hostname),
        decision: null,
        paddedMs: 250,
      })),
    });

    const a = await (
      await linkLocal.open({ baseUrl: 'https://app.example.com/', workers: 1 })
    ).pages[0]!.goto('http://169.254.169.254/');
    const b = await (
      await unresolvable.open({ baseUrl: 'https://app.example.com/', workers: 1 })
    ).pages[0]!.goto('http://nope.invalid/');

    expect(a.failure).toBe(b.failure);
    // And the refusal names no address, no class and no refusal code.
    expect(a.failure).not.toContain('169.254');
    expect(a.failure).not.toContain('link-local');
    expect(a.failure).not.toContain('CLASS_NOT_PERMITTED');
  });

  it('NEVER DISCLOSES THE RESOLVED ADDRESS OR CLASS, only what the tenant typed', async () => {
    /*
     * THE TENANT'S OWN INPUT IS NOT A LEAK; THE RESOLUTION IS.
     *
     * An earlier draft of this test asserted that the refusal contained no
     * `169.254.169.254` at all, and it failed — correctly. `requestedUrl` and
     * `finalUrl` echo the URL the tenant configured, which tells them nothing
     * they did not type, and the bounce ledger KEYS on `finalUrl`, so blanking
     * it would collapse every refusal in a crawl into one node.
     *
     * The leak worth closing is the RESOLUTION: the address the name answered
     * with and the class it was judged to be. So the host here is a NAME, and
     * the address it resolved to is a separate string that must appear nowhere.
     * This is the distinction the first draft of this test missed, and writing
     * it down is cheaper than rediscovering it.
     */
    const real = recordingAdapter();
    const guarded = guardCrawlAdapter({
      adapter: real.adapter,
      gate: gateWith(async () => ({
        ok: false as const,
        refusal: 'CLASS_NOT_PERMITTED' as const,
        // What the install may read, and the only place any of this may live.
        operatorDetail:
          'Refusing internal.example.com: it resolves to 169.254.169.254, a link-local address.',
        context: 'CRAWL' as const,
        target: target('internal.example.com'),
        decision: decision('internal.example.com', {
          allowed: false,
          outcome: 'REFUSED',
          refusal: 'CLASS_NOT_PERMITTED',
          decidedByClass: 'link-local',
        }),
        paddedMs: 250,
      })),
    });
    const browser = await guarded.open({ baseUrl: 'https://app.example.com/', workers: 1 });
    const nav = await browser.pages[0]!.goto('https://internal.example.com/admin');

    const serialised = JSON.stringify(nav);
    // The resolved address: never. The class: never. The refusal code: never.
    expect(serialised).not.toContain('169.254.169.254');
    expect(serialised).not.toContain('link-local');
    expect(serialised).not.toContain('CLASS_NOT_PERMITTED');
    expect(serialised).not.toContain('resolves to');
    // And the real adapter was never asked to navigate.
    expect(real.navigated).toEqual([]);
  });
});
