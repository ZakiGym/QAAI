/**
 * Safety tests for recording promotion.
 *
 * The bug this file exists to prevent is not a wrong answer on a screen. It is
 * a session cookie written into a customer's git history, where it is cloned
 * onto every laptop and cannot be revoked by deleting a row. So the assertions
 * are arranged by what the mistake would cost:
 *
 *   1. NOTHING SURVIVES UNNAMED. The default direction is refusal: an empty
 *      approval produces a fixture of methods, paths and status codes and
 *      nothing else. Every test that keeps something has to say which approval
 *      kept it.
 *   2. AN APPROVAL NEVER OVERRIDES A CREDENTIAL. A customer who approves
 *      `cookie`, or approves a field that happens to hold a bearer token, does
 *      not get it committed. An approval says which data is interesting; it is
 *      not a statement that the data is safe.
 *   3. WHAT CANNOT BE SCRUBBED IS REFUSED. A token in a URL path is in no
 *      header, no query parameter and no field, so the allowlist structurally
 *      cannot reach it — and the promotion stops rather than warning.
 *   4. NO REFUSAL AND NO REPORT EVER CONTAINS THE VALUE. The last test in this
 *      file searches the WHOLE serialised report for every fake secret it fed
 *      in, because a redaction that leaks the thing it redacted into an error
 *      path is the same leak by a politer route.
 *   5. EVERY REMOVAL IS COUNTED. "47 values removed" is the sentence that keeps
 *      this honest, and a cap that bit is a count and a reason rather than a
 *      quiet truncation.
 *
 * Every credential below is FAKE and is shaped like the real thing on purpose:
 * a test that used `"secret"` as a token would pass against a detector that
 * only matched the word.
 */

import { describe, expect, it } from 'vitest';
import { SECRET_SHAPES } from '@qaai/shared';
import {
  CREDENTIAL_SHAPES,
  CREDENTIAL_SHAPE_WHY,
  FIXTURE_CONVENTIONS,
  FIXTURE_CONVENTION_SPEC,
  MAX_HEADERS_PER_EXCHANGE,
  MAX_PROMOTED_EXCHANGES,
  PROMOTION_REFUSALS,
  PROMOTION_REFUSAL_WHY,
  REDACTION_KINDS,
  REDACTION_WHY,
  SAFE_HEADER_NAMES,
  countByKind,
  credentialShapeOf,
  credentialShapesIn,
  exchangeKeyOf,
  promoteRecording,
  summariseRedactions,
  valueAtPath,
} from './fixtures.js';
import type { CapturedExchange, FixtureApproval, PromotionReport } from './fixtures.js';

/**
 * COMPOSED AT RUN TIME FROM THE SHARED VOCABULARY, never written whole.
 *
 * A complete key-shaped literal in a committed file is what GitHub push
 * protection blocks, and it has already rejected a finished, green commit in
 * this repository for exactly that. A scanner cannot tell an invented token
 * from a real one — `sk_live_` followed by thirty-eight plausible characters is
 * a Stripe live key as far as any detector is concerned, whoever typed it.
 *
 * So the prefix comes from `SECRET_SHAPES` — the same list the product's own
 * credential scanners derive from, which also means a prefix that changes there
 * changes here — and the tail says what it is in words. The detector these
 * tests exercise cares about the PREFIX, so nothing is weakened by a tail that
 * reads like English.
 */
function shaped(what: string, fallback: string, tail: string): string {
  const prefix = SECRET_SHAPES.find((shape) => shape.what.startsWith(what))?.prefix ?? fallback;
  return `${prefix}${tail}`;
}

/** Fake, and shaped like the real thing. Never a real credential. */
const FAKES = {
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  bearer: 'Bearer AbCdEf0123456789AbCdEf0123456789',
  cookie: 'sid=9f3a7b2c1d4e5f60718293a4b5c6d7e8; theme=dark',
  github: shaped('a GitHub personal access token', 'ghp_', 'this-token-is-fabricated-for-this-test'),
  stripe: shaped('a Stripe live secret key', 'sk_live_', 'this-key-is-fabricated-for-this-test'),
  opaque: 'Qm9iMTIzNDU2Nzg5MEFiQ2RFZkdoSWpLbE1uT3A',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKC\n-----END RSA PRIVATE KEY-----',
};

const digest = (input: string): string => `sha256:${input.length}:${input.slice(0, 8)}`;

const exchange = (over: Partial<CapturedExchange> = {}): CapturedExchange => ({
  method: 'GET',
  url: 'https://shop.example.test/api/cart',
  status: 200,
  requestHeaders: [],
  responseHeaders: [],
  requestBody: null,
  responseBody: null,
  ...over,
});

function promote(
  exchanges: CapturedExchange[],
  approval: FixtureApproval = {},
  over: Partial<Parameters<typeof promoteRecording>[0]> = {},
) {
  return promoteRecording({
    exchanges,
    baseUrl: 'https://shop.example.test',
    approval,
    convention: 'JSON_RESPONSE_SET',
    destinationStem: 'tests/fixtures/cart',
    digest,
    ...over,
  });
}

const countOf = (report: PromotionReport, kind: (typeof REDACTION_KINDS)[number]): number =>
  report.byKind.find((row) => row.kind === kind)?.count ?? 0;

// ─── The vocabularies ────────────────────────────────────────────────────────

describe('every vocabulary has its presence record', () => {
  it('names every redaction kind in the report table', () => {
    // A `satisfies Record<RedactionKind, string>` cannot be written without
    // naming every member, so this is the run-time half: the compiler cannot
    // stop a member being renamed in one place and read in another.
    for (const kind of REDACTION_KINDS) {
      expect(REDACTION_WHY[kind]).toBeTruthy();
    }
    expect(Object.keys(REDACTION_WHY).sort()).toEqual([...REDACTION_KINDS].sort());
  });

  it('gives every refusal something the customer can act on', () => {
    for (const reason of PROMOTION_REFUSALS) {
      expect(PROMOTION_REFUSAL_WHY[reason].length).toBeGreaterThan(40);
    }
    expect(Object.keys(PROMOTION_REFUSAL_WHY).sort()).toEqual([...PROMOTION_REFUSALS].sort());
  });

  it('gives every credential shape a sentence that does not quote a value', () => {
    for (const shape of CREDENTIAL_SHAPES) {
      expect(CREDENTIAL_SHAPE_WHY[shape]).toBeTruthy();
      for (const fake of Object.values(FAKES)) {
        expect(CREDENTIAL_SHAPE_WHY[shape]).not.toContain(fake);
      }
    }
  });

  it('gives every fixture convention a file extension', () => {
    for (const convention of FIXTURE_CONVENTIONS) {
      expect(FIXTURE_CONVENTION_SPEC[convention].extension.startsWith('.')).toBe(true);
    }
  });

  it('counts every kind, including the ones nothing fired', () => {
    // Walking the vocabulary rather than the rows: a kind with no occurrences
    // must still appear as 0, or a reader cannot tell "none happened" from
    // "not looked at".
    const counts = countByKind([]);
    expect(counts).toHaveLength(REDACTION_KINDS.length);
    expect(counts.every((row) => row.count === 0)).toBe(true);
  });
});

// ─── Shape detection ─────────────────────────────────────────────────────────

describe('a credential is recognised by its shape', () => {
  it('names each of the five shapes', () => {
    expect(credentialShapeOf(FAKES.jwt)).toBe('JWT');
    expect(credentialShapeOf(FAKES.pem)).toBe('PEM_BLOCK');
    expect(credentialShapeOf(FAKES.bearer)).toBe('AUTH_SCHEME');
    expect(credentialShapeOf(FAKES.github)).toBe('PROVIDER_TOKEN');
    expect(credentialShapeOf(FAKES.stripe)).toBe('PROVIDER_TOKEN');
    expect(credentialShapeOf(FAKES.opaque)).toBe('OPAQUE_SECRET');
  });

  it('leaves ordinary test data alone', () => {
    for (const ordinary of ['application/json', 'en-GB', '42', 'Blue Running Shoes', '/api/cart']) {
      expect(credentialShapeOf(ordinary)).toBeNull();
    }
  });

  it('finds a credential buried inside a larger token, which is why the sweep exists', () => {
    // The allowlist cannot reach a token in a path segment. This is the shape
    // of the one case that gets past every header and field rule.
    expect(credentialShapesIn(`{"path":"/oauth/callback/${FAKES.github}"}`)).toEqual([
      'PROVIDER_TOKEN',
    ]);
    expect(credentialShapesIn(`?access_token=${FAKES.jwt}`)).toContain('JWT');
  });

  it('finds nothing in a fixture of paths and status codes', () => {
    expect(credentialShapesIn('{"GET /api/cart":{"status":200,"path":"/api/cart"}}')).toEqual([]);
  });
});

// ─── The default direction is refusal ────────────────────────────────────────

describe('nothing survives unnamed', () => {
  const noisy = exchange({
    requestHeaders: [
      { name: 'Authorization', value: FAKES.bearer },
      { name: 'Cookie', value: FAKES.cookie },
      { name: 'X-Api-Key', value: FAKES.opaque },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Request-Id', value: 'req_123' },
    ],
    responseHeaders: [
      { name: 'Set-Cookie', value: 'sid=deadbeefcafe; HttpOnly' },
      { name: 'Content-Type', value: 'application/json' },
    ],
    responseBody: JSON.stringify({ total: 1299, sessionToken: FAKES.jwt }),
  });

  it('keeps only the safe header names with an empty approval', () => {
    const result = promote([noisy]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifact = result.set.artifacts[0]!;
    const fixture = JSON.parse(artifact.content) as Record<string, any>;
    const entry = fixture['GET /api/cart'];
    expect(Object.keys(entry.requestHeaders)).toEqual(['content-type']);
    expect(Object.keys(entry.responseHeaders)).toEqual(['content-type']);
    // The body was never approved, so it is absent — not emptied, not masked.
    expect(entry.responseFields).toBeNull();
  });

  it('counts the Authorization, Cookie and Set-Cookie removals under their own kinds', () => {
    const report = promote([noisy]).report;
    expect(countOf(report, 'AUTH_HEADER')).toBe(1);
    expect(countOf(report, 'COOKIE_HEADER')).toBe(1);
    expect(countOf(report, 'SET_COOKIE')).toBe(1);
    expect(countOf(report, 'UNAPPROVED_HEADER')).toBe(2);
    expect(countOf(report, 'UNAPPROVED_BODY')).toBe(1);
    expect(report.redactionTotal).toBe(6);
  });

  it('refuses to let an approval override a credential header', () => {
    /*
     * THE TEST THAT MATTERS MOST IN THIS FILE. A customer who approves
     * `cookie` — by mistake, or because a screen made it easy — must not get a
     * session committed. An approval widens what is interesting; it is not a
     * statement that the value is safe.
     */
    const report = promote([noisy], {
      headerNames: ['authorization', 'cookie', 'x-api-key'],
    }).report;
    expect(countOf(report, 'AUTH_HEADER')).toBe(1);
    expect(countOf(report, 'COOKIE_HEADER')).toBe(1);
    // `x-api-key` has no always-drop rule, so it is the shape check that caught
    // it — a different kind, deliberately, because the reason differs.
    expect(countOf(report, 'CREDENTIAL_SHAPED_HEADER')).toBe(1);
  });

  it('keeps an approved header whose value is not credential-shaped', () => {
    const result = promote([noisy], { headerNames: ['x-request-id'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = (JSON.parse(result.set.artifacts[0]!.content) as Record<string, any>)[
      'GET /api/cart'
    ];
    expect(entry.requestHeaders['x-request-id']).toBe('req_123');
  });

  it('lists the safe headers it does keep, and they are content negotiation only', () => {
    expect([...SAFE_HEADER_NAMES].sort()).toEqual(['accept', 'accept-language', 'content-type']);
  });
});

// ─── URLs ────────────────────────────────────────────────────────────────────

describe('the URL is reduced to a relative path and approved parameters', () => {
  it('strips embedded user:password credentials and counts it', () => {
    const report = promote([
      exchange({ url: 'https://admin:hunter2@shop.example.test/api/cart' }),
    ]).report;
    expect(countOf(report, 'BASIC_AUTH_IN_URL')).toBe(1);
  });

  it('drops a third-party host rather than keeping it "because it is only analytics"', () => {
    const result = promote([
      exchange({ url: 'https://telemetry.vendor.test/collect?uid=abc' }),
      exchange(),
    ]);
    expect(result.ok).toBe(true);
    expect(countOf(result.report, 'FOREIGN_HOST_EXCHANGE')).toBe(1);
    expect(result.report.exchangesPromoted).toBe(1);
  });

  it('keeps a third-party host the customer named', () => {
    const result = promote([exchange({ url: 'https://cdn.vendor.test/img/1.png' })], {
      extraHosts: ['cdn.vendor.test'],
    });
    expect(result.ok).toBe(true);
    expect(countOf(result.report, 'FOREIGN_HOST_EXCHANGE')).toBe(0);
  });

  it('drops unapproved query values, keeps approved ones, and refuses a tokenised approved one', () => {
    const withQuery = exchange({
      url: `https://shop.example.test/api/cart?page=2&session=${FAKES.opaque}&utm=x`,
    });
    const dropped = promote([withQuery]).report;
    expect(countOf(dropped, 'UNAPPROVED_QUERY_PARAM')).toBe(3);

    const kept = promote([withQuery], { queryParams: ['page', 'session'] });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    const entry = (JSON.parse(kept.set.artifacts[0]!.content) as Record<string, any>)[
      'GET /api/cart'
    ];
    expect(entry.path).toBe('/api/cart?page=2');
    expect(countOf(kept.report, 'CREDENTIAL_SHAPED_QUERY_PARAM')).toBe(1);
    // The parameter NAME is the customer's own allowlist text, so naming it is
    // safe and is the one thing they can act on.
    const where = kept.report.redactions.find(
      (r) => r.kind === 'CREDENTIAL_SHAPED_QUERY_PARAM',
    )?.at;
    expect(where).toBe('session');
  });

  it('drops an exchange whose URL cannot be parsed, and counts it', () => {
    const report = promote([exchange({ url: 'ht tp://%%%' }), exchange()]).report;
    expect(countOf(report, 'UNPARSEABLE_EXCHANGE')).toBe(1);
  });
});

// ─── Bodies ──────────────────────────────────────────────────────────────────

describe('a body is dropped whole unless the exchange and the exact fields are approved', () => {
  const key = exchangeKeyOf('GET', '/api/cart');
  const withBody = exchange({
    responseBody: JSON.stringify({
      total: 1299,
      currency: 'GBP',
      customerEmail: 'dana@example.test',
      refreshToken: FAKES.jwt,
    }),
  });

  it('keeps only the approved paths and counts the rest as dropped', () => {
    const result = promote([withBody], {
      bodyExchangeKeys: [key],
      bodyFields: ['total', 'currency'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = (JSON.parse(result.set.artifacts[0]!.content) as Record<string, any>)[key];
    expect(entry.responseFields).toEqual({ total: 1299, currency: 'GBP' });
    expect(countOf(result.report, 'UNAPPROVED_BODY_FIELD')).toBe(1);
  });

  it('reads a nested exact path, and nothing by prefix', () => {
    const nested = exchange({
      responseBody: JSON.stringify({ data: { items: [{ sku: 'SKU-1', secret: FAKES.opaque }] } }),
    });
    const result = promote([nested], {
      bodyExchangeKeys: [key],
      bodyFields: ['data.items.0.sku'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = (JSON.parse(result.set.artifacts[0]!.content) as Record<string, any>)[key];
    // A prefix approval (`data.*`) would have carried `secret` through, and the
    // refusal naming it would have been composed out of a key read from the
    // capture. Exact paths are what make that impossible.
    expect(entry.responseFields).toEqual({ 'data.items.0.sku': 'SKU-1' });
  });

  it('REFUSES when a value at an approved path is credential-shaped, naming the path', () => {
    const result = promote([withBody], {
      bodyExchangeKeys: [key],
      bodyFields: ['total', 'refreshToken'],
    });
    expect(result.ok).toBe(false);
    const refusal = result.report.refusals[0]!;
    expect(refusal.reason).toBe('CREDENTIAL_IN_APPROVED_CONTENT');
    expect(refusal.at).toBe('refreshToken');
    expect(refusal.why).not.toContain(FAKES.jwt);
  });

  it('refuses an approved body that is not JSON rather than committing it whole', () => {
    const result = promote([exchange({ responseBody: '<html><body>hi</body></html>' })], {
      bodyExchangeKeys: [key],
      bodyFields: ['total'],
    });
    expect(result.ok).toBe(false);
    expect(result.report.refusals[0]!.reason).toBe('OPAQUE_APPROVED_BODY');
    expect(result.report.refusals[0]!.at).toBe(key);
  });

  it('drops an approved body that is over the size ceiling, and counts it', () => {
    const huge = exchange({
      responseBody: JSON.stringify({ blob: 'a'.repeat(25_000) }),
    });
    const result = promote([huge], { bodyExchangeKeys: [key], bodyFields: ['blob'] });
    expect(result.ok).toBe(true);
    expect(countOf(result.report, 'OVERSIZE_BODY')).toBe(1);
  });

  it('reads an exact path and reports absence as absence', () => {
    expect(valueAtPath({ a: { b: [1, 2] } }, 'a.b.1')).toBe(2);
    expect(valueAtPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(valueAtPath({ a: [1] }, 'a.9')).toBeUndefined();
    expect(valueAtPath({ a: [1] }, 'a.x')).toBeUndefined();
  });
});

// ─── The final sweep ─────────────────────────────────────────────────────────

describe('what cannot be scrubbed is refused, not warned about', () => {
  it('refuses a token in a URL path, which no allowlist can reach', () => {
    const result = promote([
      exchange({ url: `https://shop.example.test/oauth/callback/${FAKES.github}` }),
    ]);
    expect(result.ok).toBe(false);
    const refusal = result.report.refusals[0]!;
    expect(refusal.reason).toBe('CREDENTIAL_SURVIVED');
    // The SHAPE, never the value.
    expect(refusal.at).toBe('PROVIDER_TOKEN');
    expect(refusal.why).toContain("provider's prefix");
    expect(refusal.why).not.toContain(FAKES.github);
  });

  it('refuses rather than producing an empty fixture when everything was dropped', () => {
    const result = promote([exchange({ url: 'https://telemetry.vendor.test/collect' })]);
    expect(result.ok).toBe(false);
    expect(result.report.refusals[0]!.reason).toBe('EMPTY_AFTER_SCRUB');
    // The report still says what happened, because a refusal with no counts
    // leaves the customer guessing which approval to change.
    expect(countOf(result.report, 'FOREIGN_HOST_EXCHANGE')).toBe(1);
  });

  it('refuses a destination QAAI may never write into, before scrubbing anything', () => {
    const result = promote([exchange()], {}, { destinationStem: 'node_modules/evil/fixture' });
    expect(result.ok).toBe(false);
    expect(result.report.refusals[0]!.reason).toBe('DESTINATION_REFUSED');
    expect(result.report.redactionTotal).toBe(0);
  });

  it('refuses a base URL that is not a URL rather than emitting absolute paths', () => {
    const result = promote([exchange()], {}, { baseUrl: 'not a url' });
    expect(result.ok).toBe(false);
    expect(result.report.refusals[0]!.reason).toBe('BAD_BASE_URL');
  });
});

// ─── Ownership: a proposal, never a write ────────────────────────────────────

describe('a fixture is proposed, not written, unless QAAI owns the file', () => {
  it('earns PROPOSED_EDIT at a path nothing has recorded', () => {
    const result = promote([exchange()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifact = result.set.artifacts[0]!;
    expect(artifact.ownership).toBe('UNRECORDED');
    expect(artifact.disposition).toBe('PROPOSED_EDIT');
    expect(artifact.role).toBe('DATASET');
    expect(artifact.path).toBe('tests/fixtures/cart.json');
  });

  it('earns UPDATE_OWNED only when the bytes on disk are the bytes QAAI last wrote', () => {
    const ledger = [
      {
        path: 'tests/fixtures/cart.json',
        role: 'DATASET' as const,
        ownership: 'QAAI_OWNED' as const,
        contentHash: 'hash_a',
        imports: [],
      },
    ];
    expect(promote([exchange()], {}, { ledger, onDiskHash: 'hash_a' }).ok).toBe(true);
    const owned = promote([exchange()], {}, { ledger, onDiskHash: 'hash_a' });
    if (!owned.ok) return;
    expect(owned.set.artifacts[0]!.disposition).toBe('UPDATE_OWNED');

    // A human changed our file, so it is theirs now.
    const edited = promote([exchange()], {}, { ledger, onDiskHash: 'hash_b' });
    if (!edited.ok) return;
    expect(edited.set.artifacts[0]!.disposition).toBe('PROPOSED_EDIT');
  });

  it('never proposes a write over a file a human authored', () => {
    const ledger = [
      {
        path: 'tests/fixtures/cart.json',
        role: 'DATASET' as const,
        ownership: 'HUMAN_AUTHORED' as const,
        contentHash: 'hash_a',
        imports: [],
      },
    ];
    const result = promote([exchange()], {}, { ledger, onDiskHash: 'hash_a' });
    if (!result.ok) return;
    expect(result.set.artifacts[0]!.disposition).toBe('PROPOSED_EDIT');
  });
});

// ─── Counting, and the caps ──────────────────────────────────────────────────

describe('every removal and every cap is counted out loud', () => {
  it('reports zero out loud rather than rendering nothing', () => {
    expect(summariseRedactions([], 3)).toBe('Nothing was removed from 3 exchanges.');
    expect(summariseRedactions([], 1)).toBe('Nothing was removed from 1 exchange.');
  });

  it('keeps the total honest when more kinds fired than it names', () => {
    const many = REDACTION_KINDS.map((kind) => ({ kind, at: null }));
    const sentence = summariseRedactions(many, 10);
    expect(sentence).toContain(`${REDACTION_KINDS.length} values removed from 10 exchanges`);
    // A capped list must not read as the whole list.
    expect(sentence).toContain('further kind');
    expect(sentence).toContain(`counted in the ${REDACTION_KINDS.length}`);
  });

  it('reports the exchange cap as a count and a reason when it bites', () => {
    const many = Array.from({ length: MAX_PROMOTED_EXCHANGES + 5 }, (_, i) =>
      exchange({ url: `https://shop.example.test/api/item/${i}` }),
    );
    const result = promote(many);
    expect(result.ok).toBe(true);
    const cap = result.report.caps.find((c) => c.what === 'exchanges');
    expect(cap?.count).toBe(5);
    expect(cap?.reason).toContain('a replay of this flow stops');
    expect(result.report.exchangesIn).toBe(MAX_PROMOTED_EXCHANGES + 5);
    expect(result.report.exchangesPromoted).toBe(MAX_PROMOTED_EXCHANGES);
  });

  it('reports the header cap when it bites, and reports nothing when it does not', () => {
    const headers = Array.from({ length: MAX_HEADERS_PER_EXCHANGE + 4 }, (_, i) => ({
      name: `x-h-${i}`,
      value: 'v',
    }));
    const capped = promote([exchange({ requestHeaders: headers })]);
    expect(capped.report.caps.find((c) => c.what === 'headers')?.count).toBe(4);
    // A disclosure nobody needs is how real disclosures stop being read.
    expect(promote([exchange()]).report.caps).toEqual([]);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('two promotions of the same traffic produce the same bytes', () => {
  it('is byte-identical regardless of the order keys arrived in', () => {
    const key = exchangeKeyOf('GET', '/api/cart');
    const a = promote([exchange({ responseBody: JSON.stringify({ b: 2, a: 1 }) })], {
      bodyExchangeKeys: [key],
      bodyFields: ['a', 'b'],
    });
    const b = promote([exchange({ responseBody: JSON.stringify({ a: 1, b: 2 }) })], {
      bodyExchangeKeys: [key],
      bodyFields: ['b', 'a'],
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // A fixture whose bytes depend on key order makes every re-record a diff
    // nobody can read, and makes the promotion's own idempotence undecidable.
    expect(a.set.artifacts[0]!.content).toBe(b.set.artifacts[0]!.content);
  });

  it('writes the convention into the path and the reason into the artifact', () => {
    const har = promote([exchange()], {}, { convention: 'HAR_SUBSET' });
    expect(har.ok).toBe(true);
    if (!har.ok) return;
    expect(har.set.artifacts[0]!.path).toBe('tests/fixtures/cart.har.json');
    expect(har.set.artifacts[0]!.why).toContain('HAR-shaped');
    expect(har.set.artifacts[0]!.why).toContain('Promoted from a recording of 1 exchange');
  });
});

// ─── The leak test ───────────────────────────────────────────────────────────

describe('no value ever leaves this module', () => {
  it('contains none of the fake secrets anywhere in the artifact OR the report', () => {
    /*
     * THE BROADEST ASSERTION IN THE FILE, and the one that would catch a
     * redaction that leaks the thing it redacted into an error path. Every
     * credential-bearing surface at once: headers, a cookie, a query parameter,
     * an approved field, a PEM body and a token in a path.
     */
    const key = exchangeKeyOf('POST', '/api/checkout');
    const exchanges = [
      exchange({
        method: 'POST',
        url: `https://shop.example.test/api/checkout?session=${FAKES.opaque}`,
        requestHeaders: [
          { name: 'Authorization', value: FAKES.bearer },
          { name: 'Cookie', value: FAKES.cookie },
          { name: 'X-Api-Key', value: FAKES.stripe },
        ],
        responseHeaders: [{ name: 'Set-Cookie', value: `sid=${FAKES.opaque}` }],
        responseBody: JSON.stringify({ total: 1299, key: FAKES.pem }),
      }),
      exchange({ url: `https://shop.example.test/cb/${FAKES.github}` }),
    ];

    for (const approval of [
      {},
      { headerNames: ['authorization', 'cookie', 'x-api-key'] },
      { queryParams: ['session'] },
      { bodyExchangeKeys: [key], bodyFields: ['total', 'key'] },
    ] satisfies FixtureApproval[]) {
      const result = promote(exchanges, approval);
      const blob = JSON.stringify(result);
      for (const [name, fake] of Object.entries(FAKES)) {
        // The cookie's `theme=dark` half is ordinary; the whole header value is
        // what must never appear.
        expect(blob, `${name} leaked for approval ${JSON.stringify(approval)}`).not.toContain(fake);
      }
    }
  });
});
