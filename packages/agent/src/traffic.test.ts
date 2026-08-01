/**
 * Tests for traffic ingest.
 *
 * The model is not involved in anything below: turning an upload into ranked,
 * redacted journeys is arithmetic and string work, and all of it is testable.
 * What is asserted here, in rough order of how much it would cost to get wrong:
 *
 *   1. **Nothing sensitive survives ingest.** The headline test feeds a payload
 *      laced with a session cookie, a bearer token, a card number, an email, a
 *      national id and a JWT, then serialises the ENTIRE analysis and asserts
 *      that not one of those strings appears anywhere in it. That is the
 *      property the feature is sold on, so it is asserted over the whole output
 *      rather than field by field — a future field that forgets to redact fails
 *      this test without anyone remembering to extend it.
 *   2. **The percentages are real.** "60% of your users walk this" is the whole
 *      argument, so the ranking is checked against corpora with hand-countable
 *      answers.
 *   3. **Parameterisation collapses ids and does NOT collapse pages.** The
 *      false positive — ten real routes flattened into `/:param` — destroys the
 *      output silently, so it gets its own test.
 *   4. **Coverage cross-referencing.** A journey the suite already covers must
 *      not be proposed, including when the existing test writes the route with
 *      a template literal or a differently-named placeholder.
 *   5. **The failure paths.** Malformed lines, unknown formats, empty uploads,
 *      spans that are not requests — none may throw, lose the rest of the
 *      upload, or echo the input back.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_GAP_MS,
  MAX_STEPS_PER_SESSION,
  Redactor,
  TrafficFormatError,
  analyzeTraffic,
  buildRouteTemplates,
  classifySegment,
  crossReferenceSteps,
  detectFormat,
  journeyIdOf,
  journeyToPlanItem,
  looksLikeCardNumber,
  parseClfTimestamp,
  rankJourneys,
  routeShape,
  routesMentionedIn,
  sanitisePath,
  sessionise,
} from './traffic.js';
import type { ExistingTest, TrafficEvent } from './traffic.js';

const SALT = 'a-fixed-salt-so-these-tests-are-deterministic';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SECRETS = {
  sessionCookie: 'sIdVALUE-9f3a1c7d55b2e4a8',
  bearer: 'sk_live_51NxAbCdEfGhIjKlMnOpQr',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  card: '4111111111111111',
  email: 'jane.doe@example.com',
  nationalId: '123-45-6789',
  password: 'hunter2-not-in-any-artifact',
  freeTextQuery: 'chest pain at night',
};

function harEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startedDateTime: '2024-10-10T13:55:36.000Z',
    time: 120,
    request: {
      method: 'GET',
      url: 'https://shop.example.com/products',
      headers: [
        { name: 'Cookie', value: `sid=${SECRETS.sessionCookie}; theme=dark` },
        { name: 'Authorization', value: `Bearer ${SECRETS.bearer}` },
        { name: 'User-Agent', value: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Safari/537.36' },
      ],
      queryString: [],
      cookies: [{ name: 'sid', value: SECRETS.sessionCookie }],
    },
    response: {
      status: 200,
      content: { size: 4096, mimeType: 'text/html', text: `<html>${SECRETS.password}</html>` },
    },
    ...overrides,
  };
}

function har(entries: Array<Record<string, unknown>>): Record<string, unknown> {
  return { log: { version: '1.2', creator: { name: 'DevTools' }, entries } };
}

function clfLine(opts: {
  ip: string;
  at: string;
  method?: string;
  target: string;
  status?: number;
  ua?: string;
}): string {
  const ua = opts.ua ?? 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Safari/537.36';
  return `${opts.ip} - - [${opts.at}] "${opts.method ?? 'GET'} ${opts.target} HTTP/1.1" ${
    opts.status ?? 200
  } 2326 "https://shop.example.com/" "${ua}"`;
}

/** Minute `n` of 10 Oct 2024, in CLF form. */
function at(minute: number, second = 0): string {
  const hh = String(13 + Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  const ss = String(second).padStart(2, '0');
  return `10/Oct/2024:${hh}:${mm}:${ss} +0000`;
}

function event(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  return {
    at: Date.UTC(2024, 9, 10, 13, 0, 0),
    method: 'GET',
    route: '/products',
    host: 'shop.example.com',
    status: 200,
    durationMs: 100,
    contentKind: 'html',
    queryKeys: [],
    identityKey: 'user-1',
    identitySource: 'SESSION_COOKIE',
    routeFromSource: false,
    isStaticAsset: false,
    isBot: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Redaction — the reason a customer would or would not upload their traffic
// ─────────────────────────────────────────────────────────────────────────────

describe('nothing sensitive survives ingest', () => {
  const archive = har([
    harEntry({
      request: {
        method: 'GET',
        url: `https://shop.example.com/users/${encodeURIComponent(SECRETS.email)}/profile?q=${encodeURIComponent(SECRETS.freeTextQuery)}&access_token=${SECRETS.bearer}`,
        headers: [
          { name: 'Cookie', value: `sid=${SECRETS.sessionCookie}` },
          { name: 'Authorization', value: `Bearer ${SECRETS.bearer}` },
          { name: 'X-Api-Key', value: SECRETS.bearer },
        ],
        cookies: [{ name: 'sid', value: SECRETS.sessionCookie }],
      },
    }),
    harEntry({
      startedDateTime: '2024-10-10T13:56:00.000Z',
      request: {
        method: 'POST',
        url: `https://shop.example.com/checkout/${SECRETS.card}`,
        headers: [{ name: 'Cookie', value: `sid=${SECRETS.sessionCookie}` }],
        postData: {
          mimeType: 'application/json',
          text: JSON.stringify({ password: SECRETS.password, pan: SECRETS.card }),
        },
      },
      response: { status: 201, content: { size: 12, mimeType: 'application/json', text: '{}' } },
    }),
    harEntry({
      startedDateTime: '2024-10-10T13:57:00.000Z',
      request: {
        method: 'GET',
        url: `https://shop.example.com/session/${SECRETS.jwt}/renew`,
        headers: [{ name: 'Cookie', value: `sid=${SECRETS.sessionCookie}` }],
      },
    }),
    harEntry({
      startedDateTime: '2024-10-10T13:58:00.000Z',
      request: {
        method: 'GET',
        url: `https://shop.example.com/taxpayers/${SECRETS.nationalId}`,
        headers: [{ name: 'Cookie', value: `sid=${SECRETS.sessionCookie}` }],
      },
    }),
  ]);

  const analysis = analyzeTraffic(archive, { identitySalt: SALT, existingTests: [] });
  const serialised = JSON.stringify(analysis);

  // Asserted over the WHOLE serialised analysis rather than per field: a field
  // added later that forgets to redact fails this without anyone remembering to
  // extend the test.
  it.each(Object.entries(SECRETS))('does not leak %s anywhere in the analysis', (_name, value) => {
    expect(serialised).not.toContain(value);
  });

  it('does not leak the percent-encoded forms either', () => {
    expect(serialised).not.toContain(encodeURIComponent(SECRETS.email));
    expect(serialised).not.toContain(encodeURIComponent(SECRETS.freeTextQuery));
    expect(serialised).not.toContain(SECRETS.freeTextQuery.replace(/ /g, '+'));
  });

  it('replaces each sensitive path segment with a placeholder that names its kind', () => {
    const routes = analysis.journeys.flatMap((j) => j.steps.map((s) => s.route));
    expect(routes).toContain('/users/:email/profile');
    expect(routes).toContain('/checkout/:card');
    expect(routes).toContain('/session/:token/renew');
    expect(routes).toContain('/taxpayers/:national-id');
  });

  it('says exactly what it stripped, by category', () => {
    const { counts } = analysis.redaction;
    expect(counts.EMAIL).toBeGreaterThanOrEqual(1);
    expect(counts.CARD_NUMBER).toBeGreaterThanOrEqual(1);
    expect(counts.NATIONAL_ID).toBeGreaterThanOrEqual(1);
    expect(counts.JWT).toBeGreaterThanOrEqual(1);
    expect(counts.QUERY_VALUE).toBeGreaterThanOrEqual(2);
    expect(counts.COOKIE).toBeGreaterThanOrEqual(1);
    expect(counts.HEADER).toBeGreaterThanOrEqual(3);
    expect(counts.REQUEST_BODY).toBe(1);
    expect(counts.RESPONSE_BODY).toBeGreaterThanOrEqual(3);
    expect(analysis.redaction.when).toMatch(/before anything could be persisted/);
  });

  it('keeps query parameter NAMES, which are route shape, and no values', () => {
    expect(analysis.redaction.queryParamNamesKept).toEqual(['access_token', 'q']);
  });
});

describe('identity keys group without identifying', () => {
  it('is stable for one value under one salt and different under another', () => {
    const a = new Redactor('salt-one');
    const b = new Redactor('salt-two');
    const value = SECRETS.sessionCookie;

    expect(a.hash('SESSION_COOKIE', value)).toBe(a.hash('SESSION_COOKIE', value));
    expect(a.hash('SESSION_COOKIE', value)).not.toBe(b.hash('SESSION_COOKIE', value));
    // The point of the per-analysis salt: two uploads of the same user's
    // traffic cannot be joined together after the fact.
    expect(a.hash('SESSION_COOKIE', value)).not.toContain(value.slice(0, 8));
    expect(a.hash('SESSION_COOKIE', value)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('separates two users of the same HAR by their session cookies', () => {
    const analysis = analyzeTraffic(
      har([
        harEntry({
          request: {
            method: 'GET',
            url: 'https://shop.example.com/cart',
            headers: [{ name: 'Cookie', value: 'sid=user-alpha' }],
          },
        }),
        harEntry({
          request: {
            method: 'GET',
            url: 'https://shop.example.com/cart',
            headers: [{ name: 'Cookie', value: 'sid=user-beta' }],
          },
        }),
      ]),
      { identitySalt: SALT, existingTests: [] },
    );

    expect(analysis.totals.sessions).toBe(2);
    expect(analysis.identityBreakdown.SESSION_COOKIE).toBe(2);
  });
});

describe('card numbers are Luhn-checked, not length-checked', () => {
  it.each(['4111111111111111', '5500 0000 0000 0004', '378282246310005', '4111-1111-1111-1111'])(
    'treats %s as a card number',
    (value) => {
      expect(looksLikeCardNumber(value)).toBe(true);
    },
  );

  it.each(['1234567890123', '42', '2024-10-10', 'abcdefabcdefabcd'])(
    'does not treat %s as a card number',
    (value) => {
      expect(looksLikeCardNumber(value)).toBe(false);
    },
  );

  it('still redacts a long non-Luhn digit run as an identifier rather than keeping it', () => {
    // Not a card, but a 13-digit path segment is nobody's page name either.
    expect(classifySegment('1234567890123').text).toBe(':id');
  });
});

describe('segment classification', () => {
  it.each([
    ['1001', ':id'],
    ['0f2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', ':uuid'],
    ['507f1f77bcf86cd799439011', ':uuid'],
    ['2024-10-10', ':date'],
    ['deadbeefcafebabe', ':hash'],
    ['jane.doe@example.com', ':email'],
    ['+1-555-0199-77', ':phone'],
    ['checkout', 'checkout'],
    ['red-running-shoes', 'red-running-shoes'],
  ])('classifies %s as %s', (input, expected) => {
    expect(classifySegment(input).text).toBe(expected);
  });

  it('scrubs PII embedded inside an otherwise ordinary segment', () => {
    // The match is greedy over the local part — `order-jane.doe` is as
    // plausibly the address as `jane.doe` is — and greedy is the right
    // direction to be wrong in: over-redacting costs a route name, and
    // under-redacting costs an email address.
    expect(classifySegment('order-jane.doe@example.com-final').text).toBe(':email-final');
  });

  it('drops every query value, including the harmless-looking ones', () => {
    const { queryKeys } = sanitisePath('/search?q=chest+pain&page=2&sort=asc');
    expect(queryKeys).toEqual(['page', 'q', 'sort']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Parameterisation
// ─────────────────────────────────────────────────────────────────────────────

describe('parameterisation collapses identifiers', () => {
  it('turns ten thousand order pages into one journey', () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      harEntry({
        startedDateTime: new Date(Date.UTC(2024, 9, 10, 13, 0, i)).toISOString(),
        request: {
          method: 'GET',
          url: `https://shop.example.com/orders/${1000 + i}`,
          headers: [{ name: 'Cookie', value: `sid=user-${i}` }],
        },
      }),
    );

    const analysis = analyzeTraffic(har(entries), { identitySalt: SALT, existingTests: [] });
    expect(analysis.journeys).toHaveLength(1);
    expect(analysis.journeys[0]!.steps[0]!.route).toBe('/orders/:id');
    expect(analysis.journeys[0]!.sessionCount).toBe(200);
  });

  it('collapses a high-cardinality slug position that no syntactic rule catches', () => {
    const slugs = [
      'red-shoes',
      'blue-hat',
      'green-coat',
      'black-belt',
      'white-shirt',
      'grey-socks',
      'brown-bag',
      'pink-scarf',
      'navy-jeans',
    ];
    const paths = slugs.map((slug) => [
      classifySegment('products'),
      classifySegment(slug),
    ]);

    const { templates, notes } = buildRouteTemplates(paths);
    expect(new Set(templates)).toEqual(new Set(['/products/:param']));
    expect(notes[0]!.distinctValues).toBe(9);
    expect(notes[0]!.template).toBe('/products/:param');
    expect(notes[0]!.reason).toMatch(/high cardinality/);
  });

  it('does NOT collapse a set of real top-level pages that are each visited often', () => {
    // The expensive false positive: ten routes flattened into /:param, which
    // silently merges every journey in the product into one.
    const pages = [
      'login',
      'products',
      'cart',
      'checkout',
      'account',
      'help',
      'about',
      'search',
      'orders',
      'settings',
    ];
    const paths = pages.flatMap((page) =>
      Array.from({ length: 50 }, () => [classifySegment(page)]),
    );

    const { templates, notes } = buildRouteTemplates(paths);
    expect(notes).toHaveLength(0);
    expect(new Set(templates)).toEqual(new Set(pages.map((p) => `/${p}`)));
  });

  it('refuses to guess from a sample too small to argue from', () => {
    const paths = Array.from({ length: 4 }, (_, i) => [
      classifySegment('u'),
      classifySegment(`person${i}`),
    ]);
    const { notes } = buildRouteTemplates(paths);
    expect(notes).toHaveLength(0);
  });

  it('prefers the route template the application published over its own guess', () => {
    const otlp = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'aaaa',
                  kind: 2,
                  startTimeUnixNano: '1728568536000000000',
                  endTimeUnixNano: '1728568536200000000',
                  name: 'GET /orders/{orderId}',
                  attributes: [
                    { key: 'http.request.method', value: { stringValue: 'GET' } },
                    { key: 'url.path', value: { stringValue: '/orders/red-shoes' } },
                    { key: 'http.route', value: { stringValue: '/orders/{orderId}' } },
                    { key: 'session.id', value: { stringValue: 'sess-1' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const analysis = analyzeTraffic(otlp, { identitySalt: SALT, existingTests: [] });
    expect(analysis.journeys[0]!.steps[0]!.route).toBe('/orders/:orderId');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Sessionisation
// ─────────────────────────────────────────────────────────────────────────────

describe('sessionisation', () => {
  const base = Date.UTC(2024, 9, 10, 13, 0, 0);

  it('splits one identity on an inactivity gap', () => {
    const sessions = sessionise([
      event({ at: base }),
      event({ at: base + 60_000, route: '/cart' }),
      event({ at: base + 60_000 + DEFAULT_SESSION_GAP_MS + 1000, route: '/products' }),
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.events).toHaveLength(2);
    expect(sessions[1]!.events).toHaveLength(1);
  });

  it('keeps a gap of exactly the threshold in one session — the split is strict', () => {
    const sessions = sessionise([
      event({ at: base }),
      event({ at: base + DEFAULT_SESSION_GAP_MS, route: '/cart' }),
    ]);
    expect(sessions).toHaveLength(1);
  });

  it('caps a session that never goes idle, rather than calling a day one journey', () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      event({ at: base + i * 10 * 60_000, route: `/page-${i}` }),
    );
    const sessions = sessionise(events, { maxSessionMs: 60 * 60_000 });
    expect(sessions.length).toBeGreaterThan(1);
    for (const session of sessions) {
      expect(session.endedAt - session.startedAt).toBeLessThanOrEqual(60 * 60_000);
    }
  });

  it('truncates a session past the step cap and admits it', () => {
    const events = Array.from({ length: MAX_STEPS_PER_SESSION + 5 }, (_, i) =>
      event({ at: base + i * 1000, route: `/page-${i}` }),
    );
    const sessions = sessionise(events);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.events).toHaveLength(MAX_STEPS_PER_SESSION);
    expect(sessions[0]!.truncated).toBe(true);
  });

  it('never mixes two identities into one session', () => {
    const sessions = sessionise([
      event({ at: base, identityKey: 'a' }),
      event({ at: base + 1000, identityKey: 'b' }),
      event({ at: base + 2000, identityKey: 'a', route: '/cart' }),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.events.length).sort()).toEqual([1, 2]);
  });

  it('orders events within a session deterministically when timestamps collide', () => {
    // Access logs have one-second resolution, so ties are the normal case.
    const first = sessionise([
      event({ at: base, route: '/b' }),
      event({ at: base, route: '/a' }),
    ]);
    const second = sessionise([
      event({ at: base, route: '/a' }),
      event({ at: base, route: '/b' }),
    ]);
    expect(first[0]!.events.map((e) => e.route)).toEqual(second[0]!.events.map((e) => e.route));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Ranking — the number the whole feature is sold on
// ─────────────────────────────────────────────────────────────────────────────

describe('ranking reports the real percentage', () => {
  // Six of ten sessions walk / → /products → /cart; the other four stop at
  // /products. Both numbers below are hand-countable on purpose.
  const log = [
    ...Array.from({ length: 6 }, (_, i) =>
      [
        clfLine({ ip: `203.0.113.${i}`, at: at(i), target: '/' }),
        clfLine({ ip: `203.0.113.${i}`, at: at(i, 10), target: '/products' }),
        clfLine({ ip: `203.0.113.${i}`, at: at(i, 20), target: '/cart' }),
      ].join('\n'),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      [
        clfLine({ ip: `198.51.100.${i}`, at: at(i), target: '/' }),
        clfLine({ ip: `198.51.100.${i}`, at: at(i, 10), target: '/products' }),
      ].join('\n'),
    ),
  ].join('\n');

  const analysis = analyzeTraffic(log, { identitySalt: SALT, existingTests: [] });

  it('recognises Combined Log Format without being told', () => {
    expect(analysis.format).toBe('ACCESS_LOG');
    expect(analysis.totals.sessions).toBe(10);
    expect(analysis.totals.requests).toBe(26);
  });

  it('puts the journey most sessions walk first, with its exact share', () => {
    const top = analysis.journeys[0]!;
    expect(top.steps.map((s) => `${s.method} ${s.route}`)).toEqual([
      'GET /',
      'GET /products',
      'GET /cart',
    ]);
    expect(top.sessionCount).toBe(6);
    expect(top.sessionShare).toBeCloseTo(0.6, 10);
  });

  it('reports containment separately, because one extra step forks a journey', () => {
    const shorter = analysis.journeys.find((j) => j.steps.length === 2)!;
    expect(shorter.sessionCount).toBe(4);
    expect(shorter.sessionShare).toBeCloseTo(0.4, 10);
    // Every one of the ten sessions passes through / → /products.
    expect(shorter.containingSessionCount).toBe(10);
    expect(shorter.containingSessionShare).toBeCloseTo(1, 10);
  });

  it('grades priority off the share, so the top journey is the critical path', () => {
    expect(analysis.journeys[0]!.suggestedPriority).toBe('CRITICAL_PATH');
  });

  it('is deterministic: the same upload ranks identically twice', () => {
    const again = analyzeTraffic(log, { identitySalt: SALT, existingTests: [] });
    expect(JSON.stringify(again.journeys)).toBe(JSON.stringify(analysis.journeys));
  });
});

describe('ranking hygiene', () => {
  const base = Date.UTC(2024, 9, 10, 13, 0, 0);

  it('collapses polling into one step and counts the repeats', () => {
    const journeys = rankJourneys(
      sessionise([
        event({ at: base, route: '/orders/:id' }),
        event({ at: base + 1000, route: '/orders/:id' }),
        event({ at: base + 2000, route: '/orders/:id' }),
        event({ at: base + 3000, route: '/receipt' }),
      ]),
    );

    expect(journeys[0]!.steps).toHaveLength(2);
    expect(journeys[0]!.steps[0]!.repeats).toBe(2);
    expect(journeys[0]!.steps[0]!.count).toBe(3);
  });

  it('carries production error rates through, because a failing journey is the test to write', () => {
    const journeys = rankJourneys(
      sessionise([
        event({ at: base, route: '/checkout', method: 'POST', status: 500, identityKey: 'a' }),
        event({ at: base, route: '/checkout', method: 'POST', status: 200, identityKey: 'b' }),
      ]),
    );
    expect(journeys[0]!.steps[0]!.errorRate).toBeCloseTo(0.5, 10);
    expect(journeys[0]!.errorRate).toBeCloseTo(0.5, 10);
  });

  it('excludes bots and static assets, and says how many it dropped', () => {
    const log = [
      clfLine({ ip: '203.0.113.1', at: at(0), target: '/products' }),
      clfLine({ ip: '203.0.113.1', at: at(0, 1), target: '/assets/app.js' }),
      clfLine({ ip: '203.0.113.1', at: at(0, 2), target: '/favicon.ico' }),
      clfLine({ ip: '203.0.113.9', at: at(1), target: '/health', ua: 'Pingdom.com_bot_version_1.4' }),
    ].join('\n');

    const analysis = analyzeTraffic(log, { identitySalt: SALT, existingTests: [] });
    expect(analysis.totals.staticAssetsFiltered).toBe(3); // app.js, favicon.ico, /health
    expect(analysis.totals.botRequestsFiltered).toBe(1);
    expect(analysis.totals.requests).toBe(1);
    expect(analysis.warnings.join(' ')).toMatch(/bots, crawlers or uptime monitors/);
  });

  it('keeps static assets when asked, because sometimes the asset IS the bug', () => {
    const log = [
      clfLine({ ip: '203.0.113.1', at: at(0), target: '/products' }),
      clfLine({ ip: '203.0.113.1', at: at(0, 1), target: '/assets/app.js' }),
    ].join('\n');
    const analysis = analyzeTraffic(log, {
      identitySalt: SALT,
      includeStaticAssets: true,
      existingTests: [],
    });
    expect(analysis.totals.requests).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Parsers, and their failure paths
// ─────────────────────────────────────────────────────────────────────────────

describe('access log parsing', () => {
  it('converts the timezone rather than trusting the wall clock', () => {
    expect(parseClfTimestamp('10/Oct/2024:13:55:36 -0700')).toBe(
      Date.UTC(2024, 9, 10, 20, 55, 36),
    );
    expect(parseClfTimestamp('10/Oct/2024:13:55:36 +0200')).toBe(
      Date.UTC(2024, 9, 10, 11, 55, 36),
    );
    expect(parseClfTimestamp('10/Oct/2024:13:55:36')).toBe(Date.UTC(2024, 9, 10, 13, 55, 36));
    expect(parseClfTimestamp('not a timestamp')).toBeNull();
  });

  it('parses a vhost prefix and an X-Forwarded-For list, which strict regexes drop', () => {
    const line =
      'shop.example.com 203.0.113.7, 10.0.0.1 - jsmith [10/Oct/2024:13:55:36 +0000] ' +
      '"GET /orders/1001 HTTP/1.1" 200 2326 "-" "Mozilla/5.0 Safari/537.36" 0.245';

    const analysis = analyzeTraffic(line, { identitySalt: SALT, existingTests: [] });
    expect(analysis.totals.parsed).toBe(1);
    expect(analysis.totals.skipped).toBe(0);
    expect(analysis.journeys[0]!.steps[0]!.route).toBe('/orders/:id');
  });

  it('reports a malformed line by NUMBER and never echoes its contents', () => {
    const log = [
      clfLine({ ip: '203.0.113.1', at: at(0), target: '/products' }),
      'this line is garbage and contains SUPERSECRET-TOKEN-9999',
      clfLine({ ip: '203.0.113.1', at: at(1), target: '/cart' }),
    ].join('\n');

    const analysis = analyzeTraffic(log, { identitySalt: SALT, existingTests: [] });
    expect(analysis.totals.parsed).toBe(2);
    expect(analysis.totals.skipped).toBe(1);
    expect(analysis.totals.unparsedLineNumbers).toEqual([2]);
    expect(JSON.stringify(analysis)).not.toContain('SUPERSECRET');
    // One bad line must not lose the rest of the upload.
    expect(analysis.journeys[0]!.steps).toHaveLength(2);
  });

  it('warns when the log has no User-Agent, because IP-only grouping is lossy', () => {
    const common = '203.0.113.7 - - [10/Oct/2024:13:55:36 +0000] "GET /products HTTP/1.1" 200 2326';
    const analysis = analyzeTraffic(common, { identitySalt: SALT, existingTests: [] });
    expect(analysis.warnings.join(' ')).toMatch(/Common \(not Combined\)/);
  });
});

describe('OTLP parsing', () => {
  function span(attrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    return {
      traceId: 'trace-1',
      kind: 2,
      name: 'server span',
      startTimeUnixNano: '1728568536000000000',
      endTimeUnixNano: '1728568536450000000',
      attributes: Object.entries(attrs).map(([key, value]) => ({
        key,
        value: { stringValue: value },
      })),
      ...overrides,
    };
  }

  function otlp(spans: unknown[]) {
    return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }] };
  }

  it('groups by session.id when the application exports one', () => {
    const analysis = analyzeTraffic(
      otlp([
        span({
          'http.request.method': 'GET',
          'url.path': '/products',
          'session.id': 'sess-a',
          'http.response.status_code': '200',
        }),
        span(
          {
            'http.request.method': 'POST',
            'url.path': '/cart',
            'session.id': 'sess-a',
            'http.response.status_code': '201',
          },
          { startTimeUnixNano: '1728568546000000000' },
        ),
        span({
          'http.request.method': 'GET',
          'url.path': '/products',
          'session.id': 'sess-b',
        }),
      ]),
      { identitySalt: SALT, existingTests: [] },
    );

    expect(analysis.format).toBe('OTLP');
    expect(analysis.totals.sessions).toBe(2);
    expect(analysis.identityBreakdown.SESSION_ID).toBe(2);
    expect(analysis.journeys[0]!.steps.map((s) => s.method)).toEqual(['GET', 'POST']);
    expect(analysis.journeys[0]!.steps[1]!.status).toBe(201);
  });

  it('skips spans that are not HTTP requests instead of ranking them as journeys', () => {
    const analysis = analyzeTraffic(
      otlp([
        span({ 'db.system': 'postgresql' }, { name: 'SELECT orders' }),
        span({ 'messaging.system': 'kafka' }, { kind: 5 }),
        span({ 'http.request.method': 'GET', 'url.path': '/products', 'session.id': 's' }),
      ]),
      { identitySalt: SALT, existingTests: [] },
    );

    expect(analysis.totals.parsed).toBe(1);
    expect(analysis.totals.skipped).toBe(2);
    expect(Object.keys(analysis.totals.skippedReasons)).toContain(
      'span carries no HTTP method (not a request)',
    );
  });

  it('accepts OTLP shipped one batch per line', () => {
    const ndjson = [
      JSON.stringify(otlp([span({ 'http.request.method': 'GET', 'url.path': '/a', 'session.id': 'x' })])),
      JSON.stringify(otlp([span({ 'http.request.method': 'GET', 'url.path': '/b', 'session.id': 'x' })])),
    ].join('\n');

    const analysis = analyzeTraffic(ndjson, { identitySalt: SALT, existingTests: [] });
    expect(analysis.format).toBe('OTLP');
    expect(analysis.totals.parsed).toBe(2);
  });

  it('warns that a trace id is not a user', () => {
    const analysis = analyzeTraffic(
      otlp([span({ 'http.request.method': 'GET', 'url.path': '/products' })]),
      { identitySalt: SALT, existingTests: [] },
    );
    expect(analysis.identityBreakdown.TRACE_ID).toBe(1);
    expect(analysis.warnings.join(' ')).toMatch(/one distributed request rather than one user/);
  });
});

describe('format detection and refusal', () => {
  it('recognises each accepted shape', () => {
    expect(detectFormat(har([]))).toBe('HAR');
    expect(detectFormat({ resourceSpans: [] })).toBe('OTLP');
    expect(detectFormat(clfLine({ ip: '203.0.113.1', at: at(0), target: '/' }))).toBe('ACCESS_LOG');
    expect(detectFormat('hello world')).toBeNull();
  });

  it('refuses an unrecognised upload with a message that lists what it takes', () => {
    expect(() => analyzeTraffic('hello world')).toThrow(TrafficFormatError);
    expect(() => analyzeTraffic('hello world')).toThrow(/HAR|access-log|resourceSpans/);
  });

  it('refuses malformed JSON without echoing it back', () => {
    expect(() => analyzeTraffic('{"log": {"entries": [', { format: 'HAR' })).toThrow(
      /not valid JSON/,
    );
  });

  it('survives an empty upload rather than dividing by zero', () => {
    const analysis = analyzeTraffic(har([]), { identitySalt: SALT, existingTests: [] });
    expect(analysis.journeys).toEqual([]);
    expect(analysis.totals.sessions).toBe(0);
    expect(analysis.window).toBeNull();
  });

  it('treats a HAR with no cookies as one browser, and says that it did', () => {
    const analysis = analyzeTraffic(
      har([
        harEntry({ request: { method: 'GET', url: 'https://shop.example.com/', headers: [] } }),
        harEntry({
          startedDateTime: '2024-10-10T13:56:00.000Z',
          request: { method: 'GET', url: 'https://shop.example.com/cart', headers: [] },
        }),
      ]),
      { identitySalt: SALT, existingTests: [] },
    );

    expect(analysis.totals.sessions).toBe(1);
    expect(analysis.identityBreakdown.UPLOAD_SCOPE).toBe(1);
    expect(analysis.warnings.join(' ')).toMatch(/treated as one client/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cross-referencing the existing suite
// ─────────────────────────────────────────────────────────────────────────────

describe('a journey the suite already covers is not a proposal', () => {
  const checkoutTest: ExistingTest = {
    id: 'test-1',
    name: 'Checkout with a saved card',
    code: `
      import { test, expect } from '@playwright/test';
      test('checkout', async ({ page }) => {
        await page.goto('/products');
        await page.goto('/cart');
        await page.request.post('/checkout');
      });
    `,
  };

  it('marks a fully-mentioned journey COVERED', () => {
    const coverage = crossReferenceSteps(
      [
        { method: 'GET', route: '/products' },
        { method: 'GET', route: '/cart' },
        { method: 'POST', route: '/checkout' },
      ],
      [checkoutTest],
    );

    expect(coverage.status).toBe('COVERED');
    expect(coverage.matchedRatio).toBe(1);
    expect(coverage.matchedTests[0]!.id).toBe('test-1');
    expect(coverage.missingSteps).toEqual([]);
    expect(coverage.basis).toMatch(/Text matching, not execution/);
  });

  it('names the steps a partially-covering test misses', () => {
    const coverage = crossReferenceSteps(
      [
        { method: 'GET', route: '/products' },
        { method: 'GET', route: '/cart' },
        { method: 'POST', route: '/checkout' },
        { method: 'GET', route: '/receipt' },
        { method: 'GET', route: '/account' },
      ],
      [checkoutTest],
    );

    expect(coverage.status).toBe('PARTIAL');
    expect(coverage.missingSteps).toEqual(['GET /receipt', 'GET /account']);
  });

  it('matches a route written as a template literal or a differently-named placeholder', () => {
    const test: ExistingTest = {
      id: 'test-2',
      name: 'Order detail',
      code: 'await page.goto(`/orders/${orderId}`); await request.get("/orders/{id}/items");',
    };

    expect(routesMentionedIn(test)).toContain(routeShape('/orders/:id'));
    expect(
      crossReferenceSteps(
        [
          { method: 'GET', route: '/orders/:id' },
          { method: 'GET', route: '/orders/:id/items' },
        ],
        [test],
      ).status,
    ).toBe('COVERED');
  });

  it('reads routes out of an API test’s spec, not only its code', () => {
    const test: ExistingTest = {
      id: 'test-3',
      name: 'Cart API',
      code: '// generated',
      spec: { requests: [{ method: 'POST', path: '/cart' }] },
    };
    expect(crossReferenceSteps([{ method: 'POST', route: '/cart' }], [test]).status).toBe(
      'COVERED',
    );
  });

  it('reports UNCOVERED — never a false COVERED — when there is no suite to compare with', () => {
    const coverage = crossReferenceSteps([{ method: 'GET', route: '/products' }], []);
    expect(coverage.status).toBe('UNCOVERED');
    expect(coverage.missingSteps).toEqual(['GET /products']);
  });

  it('does not mistake an import path for a route', () => {
    const test: ExistingTest = {
      id: 'test-4',
      name: 'Imports only',
      code: "import { helper } from './helpers/checkout.js';",
    };
    expect(crossReferenceSteps([{ method: 'GET', route: '/checkout' }], [test]).status).toBe(
      'UNCOVERED',
    );
  });

  it('flows coverage through the whole analysis', () => {
    const log = Array.from({ length: 6 }, (_, i) =>
      [
        clfLine({ ip: `203.0.113.${i}`, at: at(i), target: '/products' }),
        clfLine({ ip: `203.0.113.${i}`, at: at(i, 10), target: '/cart' }),
        clfLine({ ip: `203.0.113.${i}`, at: at(i, 20), method: 'POST', target: '/checkout' }),
      ].join('\n'),
    ).join('\n');

    const analysis = analyzeTraffic(log, { identitySalt: SALT, existingTests: [checkoutTest] });
    expect(analysis.journeys[0]!.coverage.status).toBe('COVERED');
    expect(analysis.journeys[0]!.coverage.matchedTests[0]!.name).toBe(
      'Checkout with a saved card',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Handing a journey to the Generator
// ─────────────────────────────────────────────────────────────────────────────

describe('journey → plan item', () => {
  const log = [
    ...Array.from({ length: 6 }, (_, i) =>
      [
        clfLine({ ip: `203.0.113.${i}`, at: at(i), target: '/products' }),
        clfLine({ ip: `203.0.113.${i}`, at: at(i, 10), target: '/orders/1001' }),
        clfLine({ ip: `203.0.113.${i}`, at: at(i, 20), method: 'POST', target: '/checkout' }),
      ].join('\n'),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      clfLine({ ip: `198.51.100.${i}`, at: at(i), target: '/products' }),
    ),
  ].join('\n');

  const analysis = analyzeTraffic(log, { identitySalt: SALT, existingTests: [] });
  const journey = analysis.journeys[0]!;
  const item = journeyToPlanItem(journey, {
    totalSessions: analysis.totals.sessions,
    source: analysis.format,
  });

  it('states the real percentage, which is the entire argument for the test', () => {
    expect(item.rationale).toContain('6 of 10 sessions');
    expect(item.rationale).toContain('60.0%');
    expect(item.rationale).toContain('access logs');
  });

  it('writes one step per request, in order, with the status production returns', () => {
    expect(item.steps[0]).toMatch(/^1\. Open GET \/products, which returns 200 in production\./);
    expect(item.steps[2]).toMatch(/^3\. Open POST \/checkout/);
  });

  it('tells the Generator not to hard-code an id that was stripped on ingest', () => {
    expect(item.steps.at(-1)).toMatch(/\/orders\/:id/);
    expect(item.steps.at(-1)).toMatch(/never hard-code one taken from production/);
  });

  it('asserts on outcomes, and always on the absence of a 5xx', () => {
    expect(item.assertions).toContain('No step in the journey returns a 5xx.');
    expect(item.assertions[0]).toMatch(/responds 200/);
  });

  it('carries the journey id so the generated test can be traced back to the traffic', () => {
    expect(item.journeyId).toBe(journey.id);
    expect(journeyIdOf(journey.steps)).toBe(journey.id);
  });

  it('derives a feature name from where the journey ends, not where it starts', () => {
    expect(item.feature).toBe('Checkout');
    expect(item.title.startsWith('Checkout:')).toBe(true);
  });

  it('is a pure function of the journey', () => {
    const again = journeyToPlanItem(journey, {
      totalSessions: analysis.totals.sessions,
      source: analysis.format,
    });
    expect(again).toEqual(item);
  });

  // The API's /propose endpoint takes journeys back from a browser and has to
  // decide whether they are the ones /analyze produced. It re-sanitises every
  // route and recomputes the id, so these three properties are what make that
  // check meaningful rather than decorative.
  it('re-derives its id after a round trip through JSON', () => {
    const roundTripped = JSON.parse(JSON.stringify(journey)) as typeof journey;
    expect(journeyIdOf(roundTripped.steps)).toBe(journey.id);
  });

  it('changes its id the moment a step is edited', () => {
    const edited = journey.steps.map((step, i) =>
      i === 0 ? { ...step, route: '/users/jane.doe@example.com' } : step,
    );
    expect(journeyIdOf(edited)).not.toBe(journey.id);
  });

  it('cannot be smuggled past re-sanitisation, because sanitising changes the id', () => {
    // What a client trying to get a raw production path into the database
    // would send: a real route swapped in under an id from a clean analysis.
    const smuggled = [{ method: 'GET', route: '/users/jane.doe@example.com' }];
    const sanitised = smuggled.map((step) => ({
      method: step.method,
      route: `/${sanitisePath(step.route).segments.map((s) => s.text).join('/')}`,
    }));

    expect(sanitised[0]!.route).toBe('/users/:email');
    expect(journeyIdOf(sanitised)).not.toBe(journeyIdOf(smuggled));
  });

  it('honours an explicit test type override from the caller', () => {
    const api = journeyToPlanItem(journey, {
      totalSessions: analysis.totals.sessions,
      source: analysis.format,
      testType: 'API',
    });
    expect(api.testType).toBe('API');
  });
});
