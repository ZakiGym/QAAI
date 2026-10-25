/**
 * Observation tests.
 *
 * This module's mistakes are not symmetrical, and the suite is weighted the way
 * the product's honesty rules are:
 *
 *   A FALSE NEGATIVE IS THE EXPENSIVE ONE. Every defect this file fixes made
 *   the crawl report LESS than it saw while claiming to have seen everything —
 *   a bot wall enumerated as a one-page application, a download recorded as
 *   nothing, an empty state recorded as populated, a 404 recorded as a route.
 *   All four raise the coverage percentage. So every classifier here has a test
 *   that asserts the UNKNOWN / UNAVAILABLE / null answer, and asserts that it
 *   is not the flattering one.
 *
 *   A FALSE POSITIVE IS LOUD AND CHEAP ONCE: a good crawl gets held for review.
 *   So every blocking verdict has a COUNTER-EXAMPLE beside it — a legitimate
 *   single-page site that is not called a bot wall, a cookie banner above a
 *   working application that is not called a consent wall, a settings page that
 *   is not probed with a bad id, a console warning that is not called a defect.
 *
 * Nothing here starts a browser. The event source, the navigation outcome and
 * the page structure are all plain data, which is the whole point of the
 * injected surface: the judgement calls (is this a bot wall? is this list empty
 * or still loading?) are exactly the ones that have to be cheap to keep
 * correct, and crawler.ts's three-English-sentences empty-state heuristic went
 * unnoticed for the length of the product precisely because they were not.
 *
 * `normaliseRoute` is the REAL one from crawler.ts rather than a stub, because
 * the claim that an observed call's template and a crawled route's template are
 * spelled the same way is the claim the endpoint inventory rests on, and a stub
 * would prove only that the stub agrees with itself.
 */

import { describe, expect, it } from 'vitest';
import {
  CRAWL_CAPS,
  DEFAULT_CRAWL_POLICY,
  adjudicateCrawl,
  policyDecision,
  shouldGenerateAgainst,
  surfaceKey,
  type CrawlPolicy,
} from '@qaai/shared';
import { normaliseRoute } from '../crawler.js';
import {
  CrawlObserver,
  OBSERVATION_CAPS,
  OBSERVER_CAPABILITIES,
  callSurfaceKey,
  canonicalCall,
  classifyInterstitial,
  classifyNavigationFailure,
  classifyProbe,
  detectStructuralState,
  dispositionFilename,
  documentKindFor,
  documentSurfaceFor,
  holdForInterstitial,
  looksLikeAuthPath,
  observationCaveats,
  parseStoredObservation,
  planErrorProbes,
  reconcileCalledEndpoints,
  recordBounce,
  runtimeErrorKindForConsole,
  runtimeErrorSignature,
  structuralStateKeyPart,
  transportFor,
  type BrowserEvent,
  type BrowserEventSource,
  type ObservedNavigation,
  type ObservedCall,
  type PageStructure,
} from './observe.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE = 'https://app.example.test';
const POLICY: CrawlPolicy = DEFAULT_CRAWL_POLICY;
const NOW = '2026-10-24T12:00:00.000Z';

class FakeSource implements BrowserEventSource {
  private listeners: Array<(event: BrowserEvent) => void> = [];

  on(listener: (event: BrowserEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  emit(...events: BrowserEvent[]): void {
    for (const event of events) {
      for (const listener of [...this.listeners]) listener(event);
    }
  }
}

/** A page that tells us nothing. Each test turns on only the signal it is about. */
function structure(partial: Partial<PageStructure> = {}): PageStructure {
  return {
    title: 'Orders',
    ariaBusyCount: 0,
    roleStatusTexts: [],
    roleAlertTexts: [],
    ariaLiveCount: 0,
    collections: [],
    skeletonClassCount: 0,
    pristineDisabledSubmitCount: 0,
    formCount: 1,
    linkCount: 8,
    sameOriginLinkCount: 8,
    landmarks: ['nav', 'main'],
    headingTexts: ['Orders'],
    textSample: 'Order 41 Order 42',
    scriptOrigins: [],
    ...partial,
  };
}

function observer(options: Partial<Parameters<typeof makeObserver>[0]> = {}): CrawlObserver {
  return makeObserver(options);
}

function makeObserver(options: {
  caps?: Partial<ConstructorParameters<typeof CrawlObserver>[0]['caps']>;
  capabilities?: ConstructorParameters<typeof CrawlObserver>[0]['capabilities'];
  policy?: CrawlPolicy;
}): CrawlObserver {
  return new CrawlObserver({
    baseUrl: BASE,
    policy: options.policy ?? POLICY,
    normaliseRoute,
    redactionSalt: 'fixed-salt-for-tests',
    ...(options.caps ? { caps: options.caps } : {}),
    capabilities: options.capabilities ?? {
      NETWORK_EVENTS: true,
      CONSOLE_EVENTS: true,
      DOWNLOAD_EVENTS: true,
      STRUCTURE_READ: true,
    },
  });
}

function call(partial: Partial<ObservedCall> = {}): ObservedCall {
  return {
    transport: 'XHR',
    method: 'GET',
    template: '/api/orders',
    origin: BASE,
    offOrigin: false,
    status: 200,
    statusClass: 'OK',
    contentType: 'application/json',
    queryParams: [],
    headerNames: [],
    credentialHeaderNames: [],
    occurrences: 1,
    fromRoute: '/orders',
    interaction: 'load',
    failure: null,
    ...partial,
  };
}

function nav(partial: Partial<ObservedNavigation> = {}): ObservedNavigation {
  return {
    requestedUrl: `${BASE}/orders`,
    finalUrl: `${BASE}/orders`,
    status: 200,
    ...partial,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 1 — THE RUNTIME NETWORK INVENTORY
// ─────────────────────────────────────────────────────────────────────────────

describe('canonicalCall', () => {
  it('collapses an id shape the safety classifier deliberately leaves alone', () => {
    // The reconciliation claim in one assertion: a recorded XHR to
    // /api/orders/ORD-1001 and a route table's /api/orders/:id have to be the
    // same string, or every order in the customer's database mints an endpoint.
    expect(canonicalCall(`${BASE}/api/orders/ORD-1001`, POLICY, { normaliseRoute }).template).toBe(
      '/api/orders/:id',
    );
    expect(canonicalCall(`${BASE}/api/orders/42`, POLICY, { normaliseRoute }).template).toBe(
      '/api/orders/:id',
    );
  });

  it('is redacted but NOT collapsed when normaliseRoute is omitted, which is the documented cost', () => {
    expect(canonicalCall(`${BASE}/api/orders/ORD-1001`, POLICY).template).toBe(
      '/api/orders/ORD-1001',
    );
  });

  it('placeholders a card number in a path even though it appears exactly once', () => {
    // The frequency pass a statistical parameteriser would use cannot catch a
    // singleton, and "it only leaked once" is still a leak.
    const result = canonicalCall(`${BASE}/pay/4242424242424242`, POLICY, { normaliseRoute });
    expect(result.template).toBe('/pay/:card');
    expect(result.template).not.toContain('4242');
  });

  it('placeholders an email in a path', () => {
    expect(
      canonicalCall(`${BASE}/users/jane%40example.com/profile`, POLICY, { normaliseRoute })
        .template,
    ).toBe('/users/:email/profile');
  });

  it('keeps query parameter NAMES, drops every value, and honours ignoredQueryParams', () => {
    const result = canonicalCall(
      `${BASE}/search?q=my+diagnosis&page=2&utm_source=newsletter&gclid=abc`,
      POLICY,
      { normaliseRoute },
    );
    expect(result.queryParams).toEqual(['page', 'q']);
    expect(JSON.stringify(result)).not.toContain('diagnosis');
    expect(JSON.stringify(result)).not.toContain('newsletter');
  });

  it('never carries URL credentials into the template', () => {
    const result = canonicalCall('https://user:hunter2@app.example.test/admin', POLICY, {
      normaliseRoute,
    });
    expect(result.template).toBe('/admin');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});

describe('transportFor', () => {
  it('maps the vocabulary it knows', () => {
    expect(transportFor('xhr')).toBe('XHR');
    expect(transportFor('fetch')).toBe('FETCH');
    expect(transportFor('ping')).toBe('BEACON');
    expect(transportFor('eventsource')).toBe('EVENT_SOURCE');
    expect(transportFor('document')).toBe('NAVIGATION');
    expect(transportFor('image')).toBe('ASSET');
  });

  it('never guesses a word it does not know into a transport', () => {
    // OTHER keeps it out of API_TRANSPORTS, so a resource type a future
    // browser invents cannot silently become an undeclared endpoint finding.
    expect(transportFor('prefetch')).toBe('OTHER');
    expect(transportFor(null)).toBe('OTHER');
    expect(transportFor(undefined)).toBe('OTHER');
  });
});

describe('reconcileCalledEndpoints — the CALLED_BUT_NEVER_DECLARED finding', () => {
  it('names an endpoint the UI calls that no detector declared', () => {
    const result = reconcileCalledEndpoints(
      [
        call({ method: 'POST', template: '/api/refunds', fromRoute: '/orders/:id' }),
        call({ method: 'POST', template: '/api/refunds', fromRoute: '/admin/billing' }),
      ],
      [surfaceKey('ENDPOINT', 'GET /api/orders')],
    );
    expect(result.calledButNeverDeclared).toHaveLength(1);
    const finding = result.calledButNeverDeclared[0]!;
    expect(finding.key).toBe(surfaceKey('ENDPOINT', 'POST /api/refunds'));
    expect(finding.calledFrom).toEqual(['/orders/:id', '/admin/billing']);
    expect(finding.occurrences).toBe(2);
    expect(finding.evidence).toContain('no source detector declared it');
  });

  it('does not accuse an asset of being an undeclared API', () => {
    // A 404 on a webfont would otherwise be reported as a backend endpoint the
    // customer must go and document.
    const result = reconcileCalledEndpoints(
      [call({ transport: 'ASSET', template: '/static/app.css' })],
      [],
    );
    expect(result.calledButNeverDeclared).toEqual([]);
  });

  it('does not accuse somebody else’s API of being the customer’s undeclared endpoint', () => {
    const result = reconcileCalledEndpoints(
      [call({ template: '/v1/track', origin: 'https://api.segment.io', offOrigin: true })],
      [],
    );
    expect(result.calledButNeverDeclared).toEqual([]);
  });

  it('carries the credential fact, so a generated test knows it must authenticate', () => {
    const result = reconcileCalledEndpoints(
      [
        call({
          method: 'POST',
          template: '/api/refunds',
          credentialHeaderNames: ['authorization'],
        }),
      ],
      [],
    );
    expect(result.calledButNeverDeclared[0]?.needsCredentials).toBe(true);
  });

  it('reports the mirror as declared-but-never-called, which is a candidate list and not dead code', () => {
    const declared = surfaceKey('ENDPOINT', 'DELETE /api/orders/:id');
    const result = reconcileCalledEndpoints([call()], [declared, callSurfaceKey(call())]);
    expect(result.declaredButNeverCalled).toEqual([declared]);
    expect(result.declaredAndCalled).toEqual([callSurfaceKey(call())]);
  });

  it('caps the route list and says how many more there were', () => {
    const calls = Array.from({ length: 9 }, (_, index) =>
      call({ method: 'POST', template: '/api/ping', fromRoute: `/page-${index}` }),
    );
    const finding = reconcileCalledEndpoints(calls, [], { maxRoutesPerFinding: 2 })
      .calledButNeverDeclared[0]!;
    expect(finding.calledFrom).toHaveLength(2);
    expect(finding.evidence).toContain('and 7 more');
    expect(finding.occurrences).toBe(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 2 — THE REDIRECT AND BOUNCE LEDGER
// ─────────────────────────────────────────────────────────────────────────────

describe('recordBounce', () => {
  const options = { baseUrl: BASE, policy: POLICY, normaliseRoute, observedAtIso: NOW };

  it('records the route that was REQUESTED, not the one it landed on', () => {
    // THE DEFECT. crawler.ts stores the node under page.url(), so a gated
    // /admin/billing that bounces to /login is enumerated as /login and
    // /admin/billing appears nowhere in the graph at all.
    const { record } = recordBounce(
      nav({
        requestedUrl: `${BASE}/admin/billing`,
        finalUrl: `${BASE}/login?next=/admin/billing`,
        status: 200,
        hops: [`${BASE}/admin/billing`],
      }),
      options,
    );
    expect(record.requestedRoute).toBe('/admin/billing');
    expect(record.finalRoute).toBe('/login');
    expect(record.kind).toBe('AUTH_WALL');
    expect(record.access).toEqual({
      role: null,
      outcome: 'REDIRECTED',
      status: 200,
      destinationRoute: '/login',
      basis: 'OBSERVED',
      observedAtIso: NOW,
    });
  });

  it('reports a null hop chain when the adapter cannot say, and never an empty one', () => {
    // `[]` would mean "we looked and there were no hops", which is a claim an
    // adapter without REDIRECT_CHAIN does not entitle us to make.
    expect(recordBounce(nav(), options).record.hops).toBeNull();
    expect(recordBounce(nav({ hops: [] }), options).record.hops).toEqual([]);
  });

  it('keeps only the path and origin of a hop, never the query that carries the state token', () => {
    const { record } = recordBounce(
      nav({
        requestedUrl: `${BASE}/app`,
        finalUrl: 'https://idp.example.test/authorize?state=secret-state-token&client_id=abc',
        status: 200,
        hops: [`${BASE}/app`],
      }),
      options,
    );
    expect(record.kind).toBe('OFF_ORIGIN');
    expect(record.originChanged).toBe(true);
    expect(JSON.stringify(record)).not.toContain('secret-state-token');
    expect(record.finalUrl).toBe('https://idp.example.test/authorize');
    // The NAMES survive: they are route shape, and `?state=` tells a reader
    // this is an OAuth hop. The values are user data and are gone.
    expect(record.finalQueryParams).toEqual(['client_id', 'state']);
  });

  it('an off-origin bounce is OFF_ORIGIN even when the destination path looks like a login', () => {
    // Ordering, and it matters: an IdP's /login is somebody else's page, and
    // recording it as our auth wall puts their form in our denominator.
    const { record } = recordBounce(
      nav({ requestedUrl: `${BASE}/app`, finalUrl: 'https://idp.example.test/login', status: 200 }),
      options,
    );
    expect(record.kind).toBe('OFF_ORIGIN');
  });

  it('an error status that did not move is DENIED, not REDIRECTED', () => {
    const { record } = recordBounce(nav({ status: 403 }), options);
    expect(record.kind).toBe('ERROR_STATUS');
    expect(record.access.outcome).toBe('DENIED');
    expect(record.access.destinationRoute).toBeNull();
    expect(record.access.status).toBe(403);
  });

  it('a URL change with no response at all is a SOFT_NAVIGATION, not a server redirect', () => {
    const { record } = recordBounce(
      nav({ requestedUrl: `${BASE}/reports`, finalUrl: `${BASE}/upgrade`, status: null }),
      options,
    );
    expect(record.kind).toBe('SOFT_NAVIGATION');
    expect(record.access.status).toBeNull();
  });

  it('a served route is ALLOWED', () => {
    const { record } = recordBounce(nav(), options);
    expect(record.kind).toBe('NONE');
    expect(record.access.outcome).toBe('ALLOWED');
  });

  it('discloses the hop cap as a count and a reason', () => {
    const hops = Array.from({ length: 6 }, (_, index) => `${BASE}/hop-${index}`);
    const { record, cap } = recordBounce(
      nav({ requestedUrl: `${BASE}/a`, finalUrl: `${BASE}/b`, hops }),
      { ...options, maxHops: 2 },
    );
    expect(record.hopsTruncated).toBe(true);
    expect(record.hops).toHaveLength(2);
    expect(cap?.cap).toBe('BOUNCE_HOPS');
    expect(cap?.discarded).toBe(4);
    expect(cap?.reason).toContain('at least 4 more hop(s) followed');
  });

  it('names the role it asked as, so the access cell is a route × role fact', () => {
    const { record } = recordBounce(nav({ status: 403 }), { ...options, role: 'VIEWER' });
    expect(record.access.role).toBe('VIEWER');
    expect(record.access.basis).toBe('OBSERVED');
  });
});

describe('looksLikeAuthPath', () => {
  it('catches the sign-in vocabulary', () => {
    for (const path of ['/login', '/sign-in', '/auth/callback', '/sso', '/session/new']) {
      expect(looksLikeAuthPath(path)).toBe(true);
    }
  });

  it('does not catch a word that merely starts the same way', () => {
    // /authors is content. A word-boundary match keeps it out.
    for (const path of ['/authors', '/authors/42', '/signinups']) {
      expect(looksLikeAuthPath(path)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 3 — THE INTERSTITIAL AND BOT-WALL CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyInterstitial', () => {
  it('refuses to block on an English phrase alone', () => {
    // THE MISTAKE THIS MODULE EXISTS NOT TO REPEAT. A phrase list is why
    // crawler.ts's empty-state detection works on QAAI's demo and nowhere else.
    const finding = classifyInterstitial({
      structure: structure({ textSample: 'We use cookies to improve your experience' }),
      status: 200,
      nodeCount: 14,
    });
    expect(finding.blocksEnumeration).toBe(false);
    expect(finding.kind).toBe('NONE');
    expect(finding.reason).toBeNull();
    expect(finding.signals.map((signal) => signal.strength)).toEqual(['WEAK']);
  });

  it('blocks on a vendor challenge header', () => {
    const finding = classifyInterstitial({
      structure: structure(),
      status: 403,
      responseHeaders: { 'cf-mitigated': 'challenge' },
      nodeCount: 1,
    });
    expect(finding.kind).toBe('BOT_CHALLENGE');
    expect(finding.blocksEnumeration).toBe(true);
    expect(finding.reason).toContain('this was not the application');
  });

  it('blocks on a one-node crawl whose single node has no application chrome', () => {
    // The silent total failure: one node, no links, no truncatedReason, and a
    // denominator of 1 that makes the coverage percentage go UP.
    const finding = classifyInterstitial({
      structure: structure({
        sameOriginLinkCount: 0,
        formCount: 0,
        landmarks: [],
        textSample: 'Ein Moment bitte',
      }),
      status: 200,
      nodeCount: 1,
    });
    expect(finding.blocksEnumeration).toBe(true);
    expect(finding.signals.map((signal) => signal.signal)).toContain('SINGLE_NODE_CRAWL');
  });

  it('does not block a legitimate one-page site, because a real page has links', () => {
    const finding = classifyInterstitial({
      structure: structure({ sameOriginLinkCount: 4, formCount: 0, landmarks: [] }),
      status: 200,
      nodeCount: 1,
    });
    expect(finding.blocksEnumeration).toBe(false);
  });

  it('downgrades the no-chrome signal to WEAK when the crawl found other pages', () => {
    const finding = classifyInterstitial({
      structure: structure({ sameOriginLinkCount: 0, formCount: 0, landmarks: [] }),
      status: 200,
      nodeCount: 30,
    });
    expect(finding.blocksEnumeration).toBe(false);
    const hit = finding.signals.find((signal) => signal.signal === 'NO_APP_CHROME');
    expect(hit?.strength).toBe('WEAK');
  });

  it('blocks when every requested URL came back with the same title', () => {
    const finding = classifyInterstitial({
      structure: structure({ title: 'Sign in' }),
      status: 200,
      nodeCount: 1,
      distinctTitles: 1,
      requestedUrlCount: 40,
    });
    expect(finding.kind).toBe('LOGIN_WALL');
    expect(finding.blocksEnumeration).toBe(true);
  });

  it('maps a 503 onto SITE_DOWN, which is honest, and invents nothing for a consent wall', () => {
    // CRAWL_DEGRADATIONS has no "a wall answered instead of your app" member.
    // Mapping a consent wall onto SITE_DOWN would be a fabricated measurement,
    // so the degradation is null and the sentence carries the fact.
    const maintenance = classifyInterstitial({
      structure: structure(),
      status: 503,
      nodeCount: 1,
    });
    expect(maintenance.degradation?.kind).toBe('SITE_DOWN');

    const consent = classifyInterstitial({
      structure: structure({ sameOriginLinkCount: 0, formCount: 0, landmarks: [] }),
      status: 200,
      nodeCount: 1,
    });
    expect(consent.blocksEnumeration).toBe(true);
    expect(consent.degradation).toBeNull();
    expect(consent.reason).not.toBeNull();
  });

  it('records every signal with its strength, so a reader can discount a weak one', () => {
    const finding = classifyInterstitial({
      structure: structure({ scriptOrigins: ['https://challenges.cloudflare.com'] }),
      status: 403,
      responseHeaders: { 'retry-after': '30', server: 'cloudflare' },
      nodeCount: 1,
    });
    const byId = new Map(finding.signals.map((signal) => [signal.signal, signal.strength]));
    expect(byId.get('CHALLENGE_SCRIPT_HOST')).toBe('STRONG');
    expect(byId.get('CHALLENGE_STATUS')).toBe('STRONG');
    expect(byId.get('RETRY_AFTER')).toBe('WEAK');
  });

  it('cannot conclude anything from a structure read that did not run', () => {
    const finding = classifyInterstitial({ structure: null, status: 200, nodeCount: 1 });
    expect(finding.blocksEnumeration).toBe(false);
    expect(finding.kind).toBe('NONE');
  });
});

describe('holdForInterstitial', () => {
  const clean = adjudicateCrawl({
    nodeCount: 1,
    errorNodeCount: 0,
    loadFailureCount: 0,
    throttledCount: 0,
    expectedAuthButHitWall: false,
  });

  it('holds an otherwise-ACCEPTED crawl as a CANDIDATE with a reason', () => {
    // adjudicateCrawl builds its degradations from counts and cannot see a
    // wall: a challenge answering 200 produces one node, no errors, no
    // throttling — and adjudicates ACCEPTED, becoming the denominator.
    expect(clean.state).toBe('ACCEPTED');
    const finding = classifyInterstitial({
      structure: structure({ sameOriginLinkCount: 0, formCount: 0, landmarks: [] }),
      status: 200,
      nodeCount: 1,
    });
    const held = holdForInterstitial(clean, finding);
    expect(held.state).toBe('CANDIDATE');
    expect(held.reasons).toHaveLength(1);
    expect(held.reasons[0]).toContain('this was not the application');
  });

  it('leaves a clean crawl alone when nothing blocked', () => {
    const finding = classifyInterstitial({ structure: structure(), status: 200, nodeCount: 20 });
    expect(holdForInterstitial(clean, finding)).toBe(clean);
  });

  it('never upgrades a REJECTED crawl, it only adds the evidence', () => {
    const rejected = adjudicateCrawl({
      nodeCount: 0,
      errorNodeCount: 0,
      loadFailureCount: 2,
      throttledCount: 0,
      expectedAuthButHitWall: false,
    });
    const finding = classifyInterstitial({
      structure: structure({ sameOriginLinkCount: 0, formCount: 0, landmarks: [] }),
      status: 200,
      nodeCount: 1,
    });
    const held = holdForInterstitial(rejected, finding);
    expect(held.state).toBe('REJECTED');
    expect(held.reasons.length).toBe(rejected.reasons.length + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 4 — ERROR-PATH ENUMERATION
// ─────────────────────────────────────────────────────────────────────────────

describe('planErrorProbes', () => {
  const plan = (targets: Parameters<typeof planErrorProbes>[0]['targets'], policy = POLICY) =>
    planErrorProbes({ targets, policy, policyDecision });

  it('probes a template that takes an identifier', () => {
    const result = plan([{ template: '/orders/:id', sampleUrl: `${BASE}/orders/42` }]);
    const badId = result.probes.find((probe) => probe.kind === 'BAD_ID');
    expect(badId?.method).toBe('GET');
    expect(badId?.url).toBe(`${BASE}/orders/0`);
    expect(badId?.expectation).toContain('never a 500');
  });

  it('does not probe a template with no identifier, which would spend the budget on nothing', () => {
    const result = plan([{ template: '/settings', sampleUrl: `${BASE}/settings` }]);
    expect(result.probes).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it('records the unsafe-method probe as REFUSED with the rule, and never silently drops it', () => {
    // A refusal in the ledger is something a customer can choose to allow. A
    // `continue` is a surface that does not exist as far as anyone can tell.
    const result = plan([{ template: '/orders/:id', sampleUrl: `${BASE}/orders/42` }]);
    expect(result.probes.some((probe) => probe.method === 'DELETE')).toBe(false);
    const refusal = result.refused.find((entry) => entry.kind === 'UNSAFE_METHOD');
    expect(refusal?.rule).toBe('safeMethodsOnly: only GET and HEAD are issued');
    expect(refusal?.route).toBe('/orders/:id');
    expect(refusal?.discoveredFrom).toContain('UNSUPPORTED_METHOD');
  });

  it('records a policy-excluded probe with the glob that excluded it', () => {
    const result = plan([{ template: '/logout/:id', sampleUrl: `${BASE}/logout/9` }]);
    expect(result.probes).toEqual([]);
    const refusal = result.refused.find((entry) => entry.kind === 'POLICY_EXCLUDE');
    expect(refusal?.rule).toContain('excludeGlobs');
  });

  it('plans the missing-query probe only for a route that was seen with parameters', () => {
    const result = plan([
      { template: '/reports', sampleUrl: `${BASE}/reports`, queryParams: ['from', 'to'] },
    ]);
    const probe = result.probes.find((entry) => entry.kind === 'MISSING_REQUIRED_QUERY');
    expect(probe?.url).toBe(`${BASE}/reports`);
    expect(probe?.why).toContain('from, to');
  });

  it('discloses the per-template cap with a count, and charges it only for probes it was allowed to issue', () => {
    const result = planErrorProbes({
      targets: [{ template: '/orders/:id', sampleUrl: `${BASE}/orders/42`, queryParams: ['tab'] }],
      policy: POLICY,
      policyDecision,
      caps: { probesPerTemplate: 1 },
    });
    expect(result.probes).toHaveLength(1);
    const cap = result.caps.find((entry) => entry.cap === 'PROBES_PER_TEMPLATE');
    expect(cap?.bites).toBe(1);
    expect(cap?.discarded).toBe(1);
    expect(cap?.reason).toContain('at least that many error paths were not enumerated');
    // The DELETE was refused by the method rule, not charged to the cap.
    expect(result.refused).toHaveLength(1);
  });

  it('discloses the whole-crawl probe cap', () => {
    const result = planErrorProbes({
      targets: Array.from({ length: 4 }, (_, index) => ({
        template: `/thing-${index}/:id`,
        sampleUrl: `${BASE}/thing-${index}/7`,
      })),
      policy: POLICY,
      policyDecision,
      caps: { probesTotal: 2 },
    });
    expect(result.probes).toHaveLength(2);
    expect(result.caps.find((entry) => entry.cap === 'PROBES_TOTAL')?.discarded).toBe(2);
  });
});

describe('classifyProbe', () => {
  const probe = planErrorProbes({
    targets: [{ template: '/orders/:id', sampleUrl: `${BASE}/orders/42` }],
    policy: POLICY,
    policyDecision,
  }).probes[0]!;

  it('a 404 is a confirmed error path, and a node the generator must not write a happy path against', () => {
    const result = classifyProbe(probe, nav({ status: 404 }), structure());
    expect(result.verdict).toBe('ERROR_PATH_CONFIRMED');
    expect(result.isSurface).toBe(true);
    expect(shouldGenerateAgainst({ status: result.status })).toBe(false);
  });

  it('a 200 that renders an error state is a SOFT_ERROR — the case that fools every other tool', () => {
    const result = classifyProbe(
      probe,
      nav({ status: 200 }),
      structure({ roleAlertTexts: ['We could not find that order'] }),
    );
    expect(result.verdict).toBe('SOFT_ERROR');
    expect(result.status.isErrorPage).toBe(true);
    expect(shouldGenerateAgainst({ status: result.status })).toBe(false);
  });

  it('a 200 with real content means the application accepted input that cannot be valid', () => {
    const result = classifyProbe(
      probe,
      nav({ status: 200 }),
      structure({ collections: [{ selector: 'tbody', rowCount: 4, heading: 'Lines' }] }),
    );
    expect(result.verdict).toBe('ACCEPTED_BAD_INPUT');
    expect(result.detail).toContain('an id that cannot exist');
  });

  it('a 500 is a SERVER_FAULT and not an error path', () => {
    expect(classifyProbe(probe, nav({ status: 500 }), structure()).verdict).toBe('SERVER_FAULT');
  });

  it('no response is UNMEASURED and is never a pass', () => {
    const result = classifyProbe(probe, nav({ status: null, failure: 'net::ERR_TIMED_OUT' }), null);
    expect(result.verdict).toBe('UNMEASURED');
    expect(result.status.code).toBeNull();
    expect(result.status.class).toBe('UNKNOWN');
    expect(result.isSurface).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 5 — THE RUNTIME ERROR LEDGER
// ─────────────────────────────────────────────────────────────────────────────

describe('runtimeErrorSignature', () => {
  it('collapses one defect seen with different ids into one signature', () => {
    const left = runtimeErrorSignature(
      'PAGE_ERROR',
      "TypeError: Cannot read properties of undefined (reading 'name') at Order 41",
    );
    const right = runtimeErrorSignature(
      'PAGE_ERROR',
      "TypeError: Cannot read properties of undefined (reading 'name') at Order 42",
    );
    expect(left).toBe(right);
  });

  it('collapses the same stack frame seen in two environments', () => {
    const left = runtimeErrorSignature(
      'PAGE_ERROR',
      'boom at https://staging.x.test/app/42/main.js',
    );
    const right = runtimeErrorSignature('PAGE_ERROR', 'boom at https://prod.x.test/app/99/main.js');
    expect(left).toBe(right);
  });

  it('keeps two genuinely different defects apart', () => {
    expect(runtimeErrorSignature('PAGE_ERROR', 'TypeError: x is not a function')).not.toBe(
      runtimeErrorSignature('PAGE_ERROR', 'RangeError: invalid array length'),
    );
  });

  it('keeps the same message under two kinds apart', () => {
    expect(runtimeErrorSignature('PAGE_ERROR', 'failed')).not.toBe(
      runtimeErrorSignature('CONSOLE_ERROR', 'failed'),
    );
  });
});

describe('runtimeErrorKindForConsole', () => {
  it('a console warning is not a defect', () => {
    // Recording console.warn would bury the real findings under deprecations.
    expect(runtimeErrorKindForConsole('warning', 'componentWillMount is deprecated')).toBeNull();
    expect(runtimeErrorKindForConsole('info', 'hydrated')).toBeNull();
  });

  it('a CSP violation is a CSP violation even when it arrives as a warning', () => {
    expect(
      runtimeErrorKindForConsole(
        'warning',
        'Refused to load the script because it violates the following Content Security Policy directive',
      ),
    ).toBe('CSP_VIOLATION');
  });

  it('mixed content is classified ahead of CSP, because its remedy is different', () => {
    expect(
      runtimeErrorKindForConsole(
        'error',
        'Mixed Content: the page was loaded over HTTPS but requested an insecure resource',
      ),
    ).toBe('MIXED_CONTENT');
  });

  it('a plain console error is a console error', () => {
    expect(runtimeErrorKindForConsole('error', 'Failed to fetch orders')).toBe('CONSOLE_ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 6 — STRUCTURAL EMPTY / LOADING / ERROR DETECTION
// ─────────────────────────────────────────────────────────────────────────────

describe('detectStructuralState', () => {
  it('says UNKNOWN when the read could not run, and never POPULATED', () => {
    // crawler.ts catches its own exception and returns 'default', which is then
    // stored as a state key as though it were a reading.
    const verdict = detectStructuralState(null);
    expect(verdict.state).toBe('UNKNOWN');
    expect(verdict.basis).toBe('NONE');
    expect(verdict.why).toContain('did not run');
  });

  it('says UNKNOWN when no signal fired, and never POPULATED', () => {
    // `empty ? 'empty' : 'populated'` is why every non-English empty state in
    // the world is recorded as populated today.
    const verdict = detectStructuralState(structure({ textSample: 'Willkommen' }));
    expect(verdict.state).toBe('UNKNOWN');
    expect(verdict.basis).toBe('NONE');
  });

  it('reads an empty collection with a heading structurally, in any language', () => {
    const verdict = detectStructuralState(
      structure({
        collections: [{ selector: 'tbody', rowCount: 0, heading: 'Bestellungen' }],
        textSample: 'Noch keine Bestellungen',
      }),
    );
    expect(verdict.state).toBe('EMPTY');
    expect(verdict.basis).toBe('STRONG');
    expect(verdict.signals.map((hit) => hit.signal)).toContain('EMPTY_COLLECTION_WITH_HEADING');
  });

  it('aria-busy is loading, and loading beats empty', () => {
    // A list that has not arrived is not a list that is empty: calling it empty
    // invents a state the application does not have, and a test for it is flaky
    // forever.
    const verdict = detectStructuralState(
      structure({
        ariaBusyCount: 1,
        collections: [{ selector: 'tbody', rowCount: 0, heading: 'Orders' }],
      }),
    );
    expect(verdict.state).toBe('LOADING');
  });

  it('role=alert is an error, and error beats loading and empty', () => {
    const verdict = detectStructuralState(
      structure({
        roleAlertTexts: ['Could not load orders'],
        ariaBusyCount: 1,
        collections: [{ selector: 'tbody', rowCount: 0, heading: 'Orders' }],
      }),
    );
    expect(verdict.state).toBe('ERROR');
    expect(verdict.basis).toBe('STRONG');
  });

  it('an English phrase on its own yields WEAK_ONLY, so a reader can discount it', () => {
    const verdict = detectStructuralState(
      structure({ textSample: 'Your cart is empty', formCount: 0 }),
    );
    expect(verdict.state).toBe('EMPTY');
    expect(verdict.basis).toBe('WEAK_ONLY');
    expect(verdict.why).toContain('Discount this verdict');
  });

  it('role=status is only a loading signal when its text says so', () => {
    const loading = detectStructuralState(structure({ roleStatusTexts: ['Loading orders…'] }));
    expect(loading.state).toBe('LOADING');
    expect(loading.basis).toBe('STRONG');

    const counting = detectStructuralState(structure({ roleStatusTexts: ['3 results'] }));
    expect(counting.state).toBe('UNKNOWN');
    const hit = counting.signals.find((signal) => signal.signal === 'ROLE_STATUS');
    expect(hit?.strength).toBe('WEAK');
  });

  it('a populated collection is populated', () => {
    const verdict = detectStructuralState(
      structure({ collections: [{ selector: 'tbody', rowCount: 12, heading: 'Orders' }] }),
    );
    expect(verdict.state).toBe('POPULATED');
    expect(verdict.basis).toBe('STRONG');
  });

  it('a mix of empty and populated collections is not an empty state', () => {
    const verdict = detectStructuralState(
      structure({
        collections: [
          { selector: 'tbody', rowCount: 0, heading: 'Drafts' },
          { selector: 'ul', rowCount: 5, heading: 'Orders' },
        ],
      }),
    );
    expect(verdict.state).toBe('POPULATED');
    expect(verdict.signals.map((hit) => hit.signal)).not.toContain('EMPTY_COLLECTION_WITH_HEADING');
  });

  it('a disabled submit on a pristine form is a state worth a test', () => {
    const verdict = detectStructuralState(structure({ pristineDisabledSubmitCount: 1 }));
    expect(verdict.state).toBe('EMPTY');
    expect(verdict.signals.map((hit) => hit.signal)).toContain('DISABLED_SUBMIT_ON_PRISTINE_FORM');
  });

  it('a skeleton class alone is a weak loading guess, not a confident one', () => {
    const verdict = detectStructuralState(structure({ skeletonClassCount: 6 }));
    expect(verdict.state).toBe('LOADING');
    expect(verdict.basis).toBe('WEAK_ONLY');
  });
});

describe('structuralStateKeyPart', () => {
  it('carries the basis, so two states decided on different evidence do not merge', () => {
    expect(structuralStateKeyPart(detectStructuralState(null))).toBe('unknown:none');
    expect(
      structuralStateKeyPart(detectStructuralState(structure({ textSample: 'no orders yet' }))),
    ).toBe('empty:weak_only');
    expect(
      structuralStateKeyPart(
        detectStructuralState(
          structure({ collections: [{ selector: 'tbody', rowCount: 0, heading: 'Orders' }] }),
        ),
      ),
    ).toBe('empty:strong');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 7 — DOWNLOAD / EXPORT / DOCUMENT SURFACE
// ─────────────────────────────────────────────────────────────────────────────

describe('documentKindFor', () => {
  it('believes the filename over a content type that is lying', () => {
    // `application/octet-stream` is what a badly-configured export server sends
    // for a CSV, which is extremely common and would otherwise read as OTHER.
    expect(documentKindFor('orders.csv', 'application/octet-stream')).toBe('CSV');
  });

  it('falls back to the content type when there is no filename', () => {
    expect(documentKindFor(null, 'application/pdf')).toBe('PDF');
    expect(
      documentKindFor(null, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe('XLSX');
  });

  it('stays OTHER rather than guessing', () => {
    expect(documentKindFor(null, null)).toBe('OTHER');
    expect(documentKindFor('export', 'application/octet-stream')).toBe('OTHER');
  });
});

describe('dispositionFilename', () => {
  it('reads the filename out of the header', () => {
    expect(dispositionFilename('attachment; filename="orders-2026.csv"')).toBe('orders-2026.csv');
  });

  it('scrubs an email out of an export filename', () => {
    // Applications genuinely generate these, and an export filename is a real
    // place customer data appears.
    const name = dispositionFilename('attachment; filename="invoice-jane@example.com.pdf"');
    expect(name).not.toContain('jane@example.com');
    expect(name).toContain(':email');
  });

  it('is null when the header names no file', () => {
    expect(dispositionFilename('attachment')).toBeNull();
    expect(dispositionFilename(null)).toBeNull();
  });
});

describe('documentSurfaceFor', () => {
  it('a URL-backed export is an ENDPOINT with a key built by surfaceKey', () => {
    const surface = documentSurfaceFor({
      trigger: 'ANCHOR_DOWNLOAD',
      url: `${BASE}/exports/orders/2026.csv`,
      filename: '2026.csv',
      contentType: 'text/csv',
      fromRoute: '/orders',
      interaction: 'click "Export CSV"',
      policy: POLICY,
      normaliseRoute,
    });
    expect(surface.axis).toBe('ENDPOINT');
    expect(surface.key).toBe(surfaceKey('ENDPOINT', 'GET /exports/orders/:id'));
    expect(surface.documentKind).toBe('CSV');
    expect(surface.interaction).toBe('click "Export CSV"');
    expect(surface.exercise.state).toBe('EXERCISABLE');
    expect(surface.bodyRead).toBe(false);
    expect(surface.sources).toEqual(['CRAWL']);
  });

  it('a blob export has NO axis and says why, rather than being forced onto ROUTE', () => {
    // Forcing it onto ROUTE would collide with the page's own route key and
    // mint a phantom route per export button.
    const surface = documentSurfaceFor({
      trigger: 'BLOB_EXPORT',
      url: null,
      filename: 'report.xlsx',
      fromRoute: '/reports',
      interaction: 'click "Download"',
      policy: POLICY,
    });
    expect(surface.key).toBeNull();
    expect(surface.axis).toBeNull();
    expect(surface.axisReason).toContain('no DOCUMENT axis');
    expect(surface.documentKind).toBe('XLSX');
  });

  it('a blob export is UNEXERCISABLE with a reason, never EXERCISABLE and never silently dropped', () => {
    const surface = documentSurfaceFor({
      trigger: 'BLOB_EXPORT',
      url: null,
      fromRoute: '/reports',
      interaction: 'click "Download"',
      policy: POLICY,
    });
    expect(surface.exercise.state).toBe('UNEXERCISABLE');
    expect(surface.exercise.reason).toBe('CAPABILITY_UNAVAILABLE');
    expect(surface.exercise.detail).not.toBe('');
  });
});

describe('classifyNavigationFailure', () => {
  it('an abort with a download is a DOWNLOAD, not an unreachable URL', () => {
    // THE DEFECT: crawler.ts has one `catch { could not load; continue }`, and
    // Chromium aborts a download navigation — so every CSV, PDF and XLSX
    // reachable by a link is recorded as nothing at all.
    const result = classifyNavigationFailure('net::ERR_ABORTED at https://x/export.csv', 1);
    expect(result.kind).toBe('DOWNLOAD');
    expect(result.why).toContain('serves a file, not a page');
  });

  it('an abort with no download is UNCLASSIFIED, not UNREACHABLE', () => {
    // An abort has several causes. Claiming the URL does not exist would put a
    // real route into the unreachable count, where it is simply wrong.
    const result = classifyNavigationFailure('net::ERR_ABORTED', 0);
    expect(result.kind).toBe('UNCLASSIFIED');
    expect(result.why).toContain('neither recorded as surface nor as unreachable');
  });

  it('a certificate failure is TLS, which is what adjudicateCrawl counts', () => {
    expect(classifyNavigationFailure('net::ERR_CERT_AUTHORITY_INVALID', 0).kind).toBe('TLS');
  });

  it('a refused connection or a timeout is genuinely unreachable', () => {
    expect(classifyNavigationFailure('net::ERR_CONNECTION_REFUSED', 0).kind).toBe('UNREACHABLE');
    expect(classifyNavigationFailure('Timeout 20000ms exceeded', 0).kind).toBe('UNREACHABLE');
  });

  it('an error it does not recognise is UNCLASSIFIED and never guessed', () => {
    expect(
      classifyNavigationFailure('Target page, context or browser has been closed', 0).kind,
    ).toBe('UNCLASSIFIED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORDER
// ─────────────────────────────────────────────────────────────────────────────

describe('CrawlObserver', () => {
  it('attributes a call to the node AND the interaction that caused it', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/orders/:id', interaction: 'click "Refund"' });
    source.emit(
      {
        kind: 'request',
        request: { method: 'POST', url: `${BASE}/api/refunds`, resourceType: 'fetch' },
      },
      {
        kind: 'response',
        response: {
          request: { method: 'POST', url: `${BASE}/api/refunds`, resourceType: 'fetch' },
          status: 201,
          contentType: 'application/json',
        },
      },
    );

    const node = watcher.take();
    expect(node.calls).toHaveLength(1);
    const recorded = node.calls[0]!;
    expect(recorded.transport).toBe('FETCH');
    expect(recorded.template).toBe('/api/refunds');
    expect(recorded.status).toBe(201);
    expect(recorded.fromRoute).toBe('/orders/:id');
    expect(recorded.interaction).toBe('click "Refund"');
  });

  it('attributes a late response to the record it belongs to, not the node focused when it lands', () => {
    // A slow analytics POST outlives the page that fired it. Without the
    // pending map, the "called from" list names the wrong route — the kind of
    // wrong a customer notices immediately and never forgets.
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    const request = { method: 'POST', url: `${BASE}/api/slow`, resourceType: 'xhr' };

    watcher.focus({ route: '/dashboard', interaction: 'load' });
    source.emit({ kind: 'request', request });
    watcher.focus({ route: '/settings', interaction: 'load' });
    source.emit({ kind: 'response', response: { request, status: 200, contentType: null } });

    const report = watcher.report();
    const slow = report.calls.find((entry) => entry.template === '/api/slow')!;
    expect(slow.fromRoute).toBe('/dashboard');
    expect(slow.status).toBe(200);
    expect(watcher.take().calls).toEqual([]);
  });

  it('a request that never answered keeps status null — never 0 and never 200', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/orders', interaction: 'load' });
    source.emit({
      kind: 'request',
      request: { method: 'GET', url: `${BASE}/api/pending`, resourceType: 'xhr' },
    });
    const recorded = watcher.take().calls[0]!;
    expect(recorded.status).toBeNull();
    expect(recorded.statusClass).toBe('UNKNOWN');
  });

  it('never stores a header value, only its name', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/orders', interaction: 'load' });
    source.emit({
      kind: 'request',
      request: {
        method: 'GET',
        url: `${BASE}/api/orders`,
        resourceType: 'xhr',
        headers: { Authorization: 'Bearer super-secret-token', Cookie: 'sid=abc123' },
      },
    });

    const recorded = watcher.take().calls[0]!;
    expect(recorded.headerNames).toEqual(['authorization', 'cookie']);
    expect(recorded.credentialHeaderNames).toEqual(['authorization', 'cookie']);
    const serialised = JSON.stringify(watcher.report());
    expect(serialised).not.toContain('super-secret-token');
    expect(serialised).not.toContain('sid=abc123');
  });

  it('counts an event that arrived before any focus instead of dropping it', () => {
    // An adapter that attaches late loses the first page's network, and a
    // silent zero would read as a quiet page.
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    source.emit({
      kind: 'request',
      request: { method: 'GET', url: `${BASE}/api/early`, resourceType: 'xhr' },
    });
    expect(watcher.report().unattributedEvents).toBe(1);
    expect(watcher.report().calls).toEqual([]);
  });

  it('discloses the per-node call cap with a count', () => {
    const source = new FakeSource();
    const watcher = observer({ caps: { callsPerNode: 2 } });
    watcher.attach(source);
    watcher.focus({ route: '/dashboard', interaction: 'load' });
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      source.emit({
        kind: 'request',
        request: { method: 'GET', url: `${BASE}/api/${name}`, resourceType: 'xhr' },
      });
    }

    const node = watcher.take();
    expect(node.calls).toHaveLength(2);
    expect(node.callsTruncated).toBe(true);
    const cap = watcher.report().caps.find((entry) => entry.cap === 'CALLS_PER_NODE')!;
    expect(cap.bites).toBe(3);
    expect(cap.discarded).toBe(3);
    expect(cap.limit).toBe(2);
    expect(cap.reason).toContain('at least that many more existed');
  });

  it('collapses two instances of one endpoint into one call, which is what the cap is spent on', () => {
    // My first version of the cap test used /api/widget-0 … /api/widget-4 and
    // got ONE call back, because normaliseRoute reads `widget-0` as an id
    // shape. That is the crawler's rule and sharing it is the point — an
    // endpoint template and a route template have to be spelled the same way —
    // so the behaviour is asserted here rather than worked around.
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/dashboard', interaction: 'load' });
    for (const id of ['ORD-1001', 'ORD-1002', '42']) {
      source.emit({
        kind: 'request',
        request: { method: 'GET', url: `${BASE}/api/orders/${id}`, resourceType: 'xhr' },
      });
    }
    const node = watcher.take();
    expect(node.calls).toHaveLength(1);
    expect(node.calls[0]?.template).toBe('/api/orders/:id');
    expect(node.calls[0]?.occurrences).toBe(3);
  });

  it('counts a repeated call as an occurrence rather than spending the cap on it', () => {
    const source = new FakeSource();
    const watcher = observer({ caps: { callsPerNode: 1 } });
    watcher.attach(source);
    watcher.focus({ route: '/dashboard', interaction: 'load' });
    for (let index = 0; index < 3; index += 1) {
      source.emit({
        kind: 'request',
        request: { method: 'GET', url: `${BASE}/api/poll`, resourceType: 'xhr' },
      });
    }
    const node = watcher.take();
    expect(node.calls[0]?.occurrences).toBe(3);
    expect(node.callsTruncated).toBe(false);
  });

  it('a Content-Disposition response becomes a document with no navigation at all', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/orders', interaction: 'click "Export"' });
    const request = { method: 'GET', url: `${BASE}/exports/orders`, resourceType: 'xhr' };
    source.emit(
      { kind: 'request', request },
      {
        kind: 'response',
        response: {
          request,
          status: 200,
          contentType: 'text/csv',
          contentDisposition: 'attachment; filename="orders.csv"',
        },
      },
    );

    const documents = watcher.report().documents;
    expect(documents).toHaveLength(1);
    expect(documents[0]?.documentKind).toBe('CSV');
    expect(documents[0]?.trigger).toBe('CONTENT_DISPOSITION');
    expect(documents[0]?.interaction).toBe('click "Export"');
  });

  it('a blob download is recorded once per route and interaction, not once per click', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/reports', interaction: 'click "Download"' });
    source.emit(
      { kind: 'download', url: null, suggestedFilename: 'report.xlsx' },
      { kind: 'download', url: null, suggestedFilename: 'report.xlsx' },
    );
    expect(watcher.report().documents).toHaveLength(1);
    expect(watcher.downloadsInFocus()).toBe(2);
  });

  it('an off-origin call is an external boundary with origin and path only, never the query', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/orders', interaction: 'load' });
    source.emit({
      kind: 'request',
      request: {
        method: 'POST',
        url: 'https://api.segment.io/v1/track?writeKey=secret-write-key',
        resourceType: 'fetch',
      },
    });

    const report = watcher.report();
    expect(report.externals).toHaveLength(1);
    expect(report.externals[0]).toMatchObject({
      kind: 'SCRIPT_HOST',
      origin: 'https://api.segment.io',
      samplePath: '/v1/track',
      fromRoute: '/orders',
    });
    expect(JSON.stringify(report.externals)).not.toContain('secret-write-key');
  });

  it('an own-origin websocket is a call whose method is WS, not a fictional GET', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/chat', interaction: 'load' });
    source.emit({ kind: 'websocket', url: `${BASE}/ws/notifications` });

    const recorded = watcher.take().calls[0]!;
    expect(recorded.transport).toBe('WEBSOCKET');
    expect(recorded.method).toBe('WS');
    expect(recorded.status).toBeNull();
  });

  it('an off-origin websocket is a boundary and not one of our endpoints', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/chat', interaction: 'load' });
    source.emit({ kind: 'websocket', url: 'wss://pusher.example.net/app/abc' });

    expect(watcher.take().calls).toEqual([]);
    expect(watcher.report().externals[0]?.kind).toBe('WEBSOCKET');
  });

  it('deduplicates runtime errors by signature and counts per node and per crawl separately', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);

    watcher.focus({ route: '/orders', interaction: 'load' });
    source.emit(
      { kind: 'pageerror', message: "TypeError: cannot read 'name' of undefined at Order 41" },
      { kind: 'pageerror', message: "TypeError: cannot read 'name' of undefined at Order 42" },
    );
    const first = watcher.take();
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]?.occurrences).toBe(2);

    watcher.focus({ route: '/invoices', interaction: 'load' });
    source.emit({
      kind: 'pageerror',
      message: "TypeError: cannot read 'name' of undefined at Order 7",
    });
    expect(watcher.take().errors[0]?.occurrences).toBe(1);

    const ledger = watcher.report().errors;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.occurrences).toBe(3);
    expect(ledger[0]?.sampleRoutes).toEqual(['/orders', '/invoices']);
    expect(ledger[0]?.seed).toContain('assert no uncaught exception');
  });

  it('discloses the per-node error cap and the route-sample cap', () => {
    const source = new FakeSource();
    const watcher = observer({ caps: { errorsPerNode: 1, errorSampleRoutes: 1 } });
    watcher.attach(source);
    watcher.focus({ route: '/a', interaction: 'load' });
    source.emit(
      { kind: 'pageerror', message: 'Alpha failed' },
      { kind: 'pageerror', message: 'Beta failed' },
    );
    watcher.focus({ route: '/b', interaction: 'load' });
    source.emit({ kind: 'pageerror', message: 'Alpha failed' });

    const caps = watcher.report().caps;
    expect(caps.find((cap) => cap.cap === 'ERRORS_PER_NODE')?.discarded).toBe(1);
    expect(caps.find((cap) => cap.cap === 'ERROR_SAMPLE_ROUTES')?.discarded).toBe(1);
    expect(
      watcher.report().errors.find((entry) => entry.message === 'Alpha failed')
        ?.sampleRoutesTruncated,
    ).toBe(true);
  });

  it('a failed request is both a runtime error and a call failure, but an aborted download is neither', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/orders', interaction: 'load' });
    const failing = { method: 'GET', url: `${BASE}/api/missing`, resourceType: 'xhr' };
    const download = { method: 'GET', url: `${BASE}/exports/orders.csv`, resourceType: 'document' };
    source.emit(
      { kind: 'request', request: failing },
      { kind: 'requestfailed', request: failing, errorText: 'net::ERR_CONNECTION_REFUSED' },
      { kind: 'request', request: download },
      { kind: 'requestfailed', request: download, errorText: 'net::ERR_ABORTED' },
    );

    const node = watcher.take();
    expect(node.calls.find((entry) => entry.template === '/api/missing')?.failure).toBe(
      'net::ERR_CONNECTION_REFUSED',
    );
    expect(node.errors).toHaveLength(1);
    expect(node.errors[0]?.kind).toBe('REQUEST_FAILED');
  });

  it('collects the counts adjudicateCrawl needs and that only observation can see', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/orders', interaction: 'load' });
    const throttled = { method: 'GET', url: `${BASE}/api/a`, resourceType: 'xhr' };
    const broken = { method: 'GET', url: `${BASE}/api/b`, resourceType: 'xhr' };
    const insecure = { method: 'GET', url: `${BASE}/api/c`, resourceType: 'xhr' };
    source.emit(
      { kind: 'request', request: throttled },
      { kind: 'response', response: { request: throttled, status: 429 } },
      { kind: 'request', request: broken },
      { kind: 'response', response: { request: broken, status: 500 } },
      { kind: 'requestfailed', request: insecure, errorText: 'net::ERR_CERT_DATE_INVALID' },
    );
    watcher.addBounce(
      recordBounce(nav({ requestedUrl: `${BASE}/admin`, finalUrl: `${BASE}/login`, status: 200 }), {
        baseUrl: BASE,
        policy: POLICY,
        normaliseRoute,
        observedAtIso: NOW,
      }).record,
    );

    expect(watcher.report().adjudication).toEqual({
      throttled: 1,
      tlsFailures: 1,
      authWallBounces: 1,
      serverErrorResponses: 1,
    });
  });

  it('reports every capability the adapter did not declare as UNAVAILABLE, not as an empty result', () => {
    const watcher = makeObserver({ capabilities: { NETWORK_EVENTS: true } });
    const report = watcher.report();
    expect(report.capabilities).toHaveLength(OBSERVER_CAPABILITIES.length);
    const console = report.capabilities.find((entry) => entry.capability === 'CONSOLE_EVENTS')!;
    expect(console.state).toBe('UNAVAILABLE');
    expect(console.why).toContain('this is not a claim that there was nothing to see');
    expect(report.capabilities.find((entry) => entry.capability === 'NETWORK_EVENTS')?.state).toBe(
      'AVAILABLE',
    );
  });

  it('carries an adapter’s own reason for a missing capability', () => {
    const watcher = makeObserver({
      capabilities: { DOWNLOAD_EVENTS: 'the worker has no writable download directory' },
    });
    const entry = watcher
      .report()
      .capabilities.find((candidate) => candidate.capability === 'DOWNLOAD_EVENTS')!;
    expect(entry.state).toBe('AVAILABLE');
    expect(entry.why).toBe('the worker has no writable download directory');
  });

  it('unsubscribes when the returned function is called', () => {
    const source = new FakeSource();
    const watcher = observer();
    const detach = watcher.attach(source);
    watcher.focus({ route: '/orders', interaction: 'load' });
    detach();
    source.emit({
      kind: 'request',
      request: { method: 'GET', url: `${BASE}/api/after`, resourceType: 'xhr' },
    });
    expect(watcher.take().calls).toEqual([]);
  });

  it('folds in caps produced by a pure planner, so one ledger holds them all', () => {
    const watcher = observer();
    const planned = planErrorProbes({
      targets: [{ template: '/orders/:id', sampleUrl: `${BASE}/orders/42`, queryParams: ['tab'] }],
      policy: POLICY,
      policyDecision,
      caps: { probesPerTemplate: 1 },
    });
    watcher.mergeCaps(planned.caps);
    expect(watcher.report().caps.find((cap) => cap.cap === 'PROBES_PER_TEMPLATE')?.discarded).toBe(
      1,
    );
  });

  it('take() on an unfocused observer claims nothing rather than inventing a node', () => {
    const node = observer().take();
    expect(node).toEqual({
      route: null,
      interaction: null,
      calls: [],
      callsTruncated: false,
      errors: [],
      errorsTruncated: false,
      documents: [],
      documentsTruncated: false,
      downloadCount: 0,
      websocketOrigins: [],
    });
  });
});

describe('observationCaveats', () => {
  it('reaches every reason the numbers above it are a floor', () => {
    const source = new FakeSource();
    const watcher = makeObserver({
      caps: { callsPerNode: 1 },
      capabilities: { NETWORK_EVENTS: true },
    });
    watcher.attach(source);
    source.emit({
      kind: 'request',
      request: { method: 'GET', url: `${BASE}/api/early`, resourceType: 'xhr' },
    });
    watcher.focus({ route: '/orders', interaction: 'load' });
    source.emit(
      { kind: 'request', request: { method: 'GET', url: `${BASE}/api/a`, resourceType: 'xhr' } },
      { kind: 'request', request: { method: 'GET', url: `${BASE}/api/b`, resourceType: 'xhr' } },
    );
    watcher.setInterstitial(
      classifyInterstitial({
        structure: structure({ sameOriginLinkCount: 0, formCount: 0, landmarks: [] }),
        status: 200,
        nodeCount: 1,
      }),
    );

    const caveats = observationCaveats(watcher.report());
    expect(caveats.some((line) => line.includes('the console and page-error stream'))).toBe(true);
    expect(caveats.some((line) => line.includes('the per-node network-call limit'))).toBe(true);
    expect(caveats.some((line) => line.includes('could not be attributed'))).toBe(true);
    expect(caveats.some((line) => line.includes('this was not the application'))).toBe(true);
  });
});

describe('parseStoredObservation', () => {
  it('returns null for a flow map that has no observation, which every stored map does', () => {
    // Null means "this crawl has no observation". It must never be rendered as
    // "this crawl observed nothing".
    expect(parseStoredObservation(null)).toBeNull();
    expect(parseStoredObservation(undefined)).toBeNull();
    expect(parseStoredObservation('{}')).toBeNull();
    expect(parseStoredObservation([])).toBeNull();
  });

  it('returns null for a version it does not know, rather than believing half of it', () => {
    expect(parseStoredObservation({ version: 2, calls: [] })).toBeNull();
  });

  it('round-trips a report through JSON', () => {
    const source = new FakeSource();
    const watcher = observer();
    watcher.attach(source);
    watcher.focus({ route: '/orders', interaction: 'load' });
    source.emit({
      kind: 'request',
      request: { method: 'GET', url: `${BASE}/api/orders`, resourceType: 'xhr' },
    });
    const report = watcher.report();
    const parsed = parseStoredObservation(JSON.parse(JSON.stringify(report)));
    expect(parsed?.calls).toHaveLength(1);
    expect(parsed?.calls[0]?.template).toBe('/api/orders');
    expect(parsed?.adjudication).toEqual(report.adjudication);
  });

  it('does not invent counts for an adjudication block that is missing', () => {
    const parsed = parseStoredObservation({ version: 1 });
    expect(parsed?.adjudication).toEqual({
      throttled: 0,
      tlsFailures: 0,
      authWallBounces: 0,
      serverErrorResponses: 0,
    });
    expect(parsed?.calls).toEqual([]);
  });
});

describe('the cap vocabularies stay apart on purpose', () => {
  it('shares no member with CRAWL_CAPS, so neither label lookup can come back undefined', () => {
    // CRAWL_CAPS is the TRAVERSAL's budget ledger and OBSERVATION_CAPS is this
    // module's. A name in both would make it ambiguous which limit a `CapBite`
    // came from, and a name in neither would render as `undefined` in a report.
    const shared = OBSERVATION_CAPS.filter((cap) =>
      (CRAWL_CAPS as readonly string[]).includes(cap),
    );
    expect(shared).toEqual([]);
  });
});

describe('the per-node document cap', () => {
  const exportCsv = (name: string): Parameters<typeof documentSurfaceFor>[0] => ({
    trigger: 'ANCHOR_DOWNLOAD',
    url: `${BASE}/exports/${name}.csv`,
    filename: `${name}.csv`,
    contentType: 'text/csv',
    fromRoute: '/orders',
    interaction: `click "Export ${name}"`,
    policy: POLICY,
    normaliseRoute,
  });

  it('charges the cap for a document it kept out, not for a repeat of one it kept', () => {
    /*
     * The ordering defect. `keepDocument` charged the cap BEFORE the
     * de-duplication, which `recordRequest` does the other way round twenty
     * lines of reasoning away. So one export button clicked thirty times on
     * one node reported `DOCUMENTS_PER_NODE` with ten `discarded` — "at least
     * ten more documents existed" — when every one of them was the document
     * already in the list. `discarded` is the number a reader is invited to
     * treat as a floor on what was missed, so charging it for a repeat of
     * something we kept invents that floor.
     */
    const obs = observer({ caps: { documentsPerNode: 2 } });
    obs.focus({ route: '/orders', interaction: null });
    for (let i = 0; i < 30; i += 1) obs.addDocument(documentSurfaceFor(exportCsv('orders')));

    const report = obs.report();
    expect(report.documents).toHaveLength(1);
    expect(report.caps.find((cap) => cap.cap === 'DOCUMENTS_PER_NODE')).toBeUndefined();
    expect(observationCaveats(report).join(' ')).not.toContain('per-node document limit');
  });

  it('still discloses the cap, with a count, when distinct documents ARE lost', () => {
    const obs = observer({ caps: { documentsPerNode: 2 } });
    obs.focus({ route: '/orders', interaction: null });
    for (const name of ['orders', 'invoices', 'refunds', 'payouts']) {
      obs.addDocument(documentSurfaceFor(exportCsv(name)));
    }

    const report = obs.report();
    expect(report.documents).toHaveLength(2);
    const bite = report.caps.find((cap) => cap.cap === 'DOCUMENTS_PER_NODE');
    expect(bite?.bites).toBe(2);
    expect(bite?.discarded).toBe(2);
    expect(bite?.reason).toContain('more');
    expect(observationCaveats(report).join(' ')).toContain('per-node document limit');
  });
});
