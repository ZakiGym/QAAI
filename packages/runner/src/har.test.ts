/**
 * The three things a hermetic-replay implementation can lie about, and the
 * tests that stop it.
 *
 *  1. That a run was hermetic when something reached the live network. Every
 *     escape hatch here — a passthrough on a miss, a handler that threw, a
 *     recorder that never installed, a report that was never written — is
 *     tested to produce a result that says NOT HERMETIC in so many words. The
 *     dangerous bug in this module is not a crash, it is a green run.
 *
 *  2. That a recording is safe to hand around. Redaction is asserted on the
 *     bytes that reach disk, not on a helper, because "we strip it on export"
 *     is the guarantee that fails the first time someone reads the file some
 *     other way.
 *
 *  3. That matching still works. A recording that stops matching the day after
 *     it is made is a recording nobody uses, so the cache-buster cases are as
 *     load-bearing as the security ones.
 *
 * The route handler is exercised through fakes rather than a browser: it only
 * ever touches four methods of Playwright's `Route`, which is why `har.ts`
 * describes them structurally.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASE_URL_TOKEN,
  REDACTED,
  archiveRecordedAt,
  createArchive,
  defaultNormalisation,
  describeRedaction,
  entryBody,
  entryHeaders,
  indexArchive,
  installHar,
  isThirdParty,
  matchKey,
  normaliseUrl,
  parseArchive,
  parseHarConfig,
  readHarRunDir,
  mergeArchives,
  mergeRunReports,
  redactHeaders,
  redactText,
  redactUrl,
  stalenessWarning,
  summariseHarRun,
  unroutableTransports,
} from './har.js';
import type {
  HarApiResponse,
  HarConfig,
  HarEntry,
  HarNormalisation,
  HarRoute,
  HarRunReport,
  HarTestType,
} from './har.js';

const N = (over: Partial<HarNormalisation> = {}): HarNormalisation => ({
  ...defaultNormalisation(),
  ...over,
});

// ─── Configuration ───────────────────────────────────────────────────────────

describe('parseHarConfig', () => {
  it('is off unless a test asks for it', () => {
    expect(parseHarConfig(null)).toEqual({ config: null, problem: null });
    expect(parseHarConfig({ ecosystem: 'pytest' })).toEqual({ config: null, problem: null });
    expect(parseHarConfig({ har: { mode: 'off' } })).toEqual({ config: null, problem: null });
  });

  it('defaults to a hermetic replay of everything', () => {
    const { config } = parseHarConfig({ har: { mode: 'replay' } });
    expect(config).toMatchObject({
      mode: 'replay',
      onMiss: 'abort',
      scope: 'all',
      path: 'fixtures/network.har.json',
      maxAgeDays: 30,
    });
  });

  it('lets QAAI_HAR_MODE re-record a whole suite without editing every spec', () => {
    const { config } = parseHarConfig({ har: { mode: 'replay', path: 'fixtures/a.har.json' } }, {
      QAAI_HAR_MODE: 'record',
    });
    expect(config?.mode).toBe('record');
    // …but it may not redirect where the recording lives, or every test in the
    // suite would write over the same file.
    expect(config?.path).toBe('fixtures/a.har.json');
  });

  it.each([
    ['an unknown mode', { har: { mode: 'playback' } }],
    ['an unknown miss rule', { har: { mode: 'replay', onMiss: 'ignore' } }],
    ['an unknown scope', { har: { mode: 'replay', scope: 'first-party' } }],
    ['an absolute path', { har: { mode: 'record', path: '/etc/passwd' } }],
    ['a traversing path', { har: { mode: 'record', path: '../../secrets.har' } }],
    ['a non-object har key', { har: 'replay' }],
    ['a bad drop list', { har: { mode: 'replay', normalise: { dropQueryParams: [1] } } }],
    ['an uncompilable pattern', { har: { mode: 'replay', normalise: { dropQueryParamPatterns: ['('] } } }],
    ['an uncompilable exclude', { har: { mode: 'replay', exclude: ['[a-'] } }],
    ['a negative age', { har: { mode: 'replay', maxAgeDays: -1 } }],
  ])('reports %s rather than guessing', (_label, spec) => {
    const result = parseHarConfig(spec);
    expect(result.config).toBeNull();
    expect(result.problem).toBeTruthy();
  });

  it('accepts null maxAgeDays as "never warn"', () => {
    expect(parseHarConfig({ har: { mode: 'replay', maxAgeDays: null } }).config?.maxAgeDays).toBeNull();
  });
});

// ─── Matching ────────────────────────────────────────────────────────────────

describe('normalisation keeps a recording usable past its first day', () => {
  it('drops cache busters and timestamps', () => {
    const a = matchKey('GET', 'https://api.example.com/items?_=1738000000&page=2', N());
    const b = matchKey('GET', 'https://api.example.com/items?_=1799999999&page=2', N());
    expect(a).toBe(b);
    expect(a).toContain('page=2');
  });

  it('sorts surviving parameters, because a server cannot tell the order', () => {
    expect(normaliseUrl('https://x.test/a?b=2&a=1', N())).toBe(
      normaliseUrl('https://x.test/a?a=1&b=2', N()),
    );
  });

  it('ignores the fragment, credentials, default port and host case', () => {
    expect(normaliseUrl('https://User:pw@API.Example.com:443/v1//items#top', N())).toBe(
      'https://api.example.com/v1/items',
    );
  });

  it('honours a caller-supplied drop list and pattern', () => {
    const n = N({ dropQueryParams: ['sessionId'], dropQueryParamPatterns: ['^x-'] });
    expect(normaliseUrl('https://x.test/a?sessionid=9&x-trace=1&keep=1', n)).toBe(
      'https://x.test/a?keep=1',
    );
    // The custom list REPLACES the defaults, so `_` now survives.
    expect(normaliseUrl('https://x.test/a?_=1', n)).toBe('https://x.test/a?_=1');
  });

  it('can ignore the query or the host entirely', () => {
    expect(normaliseUrl('https://x.test/a?q=1', N({ ignoreQuery: true }))).toBe('https://x.test/a');
    expect(normaliseUrl('https://x.test/a?q=1', N({ ignoreHost: true }))).toBe('/a?q=1');
  });

  it('folds the environment base URL away so a recording survives a host change', () => {
    const staging = matchKey('GET', 'https://staging.shop.test/cart', N(), 'https://staging.shop.test');
    const preview = matchKey('GET', 'https://pr-42.shop.test/cart', N(), 'https://pr-42.shop.test');
    expect(staging).toBe(preview);
    expect(staging).toBe(`GET ${BASE_URL_TOKEN}/cart`);
    // A third party keeps its real host — that is the thing being frozen.
    expect(matchKey('GET', 'https://stripe.test/v1/charges', N(), 'https://staging.shop.test')).toBe(
      'GET https://stripe.test/v1/charges',
    );
  });

  it('does not confuse a look-alike host with the base URL', () => {
    expect(normaliseUrl('https://shop.test.evil.com/cart', N(), 'https://shop.test')).toBe(
      'https://shop.test.evil.com/cart',
    );
  });

  it('leaves a URL it cannot parse alone rather than throwing', () => {
    expect(normaliseUrl('data:text/plain,hi', N())).toBe('data:text/plain,hi');
  });

  it('knows what is third party', () => {
    expect(isThirdParty('https://stripe.test/x', 'https://shop.test')).toBe(true);
    expect(isThirdParty('https://shop.test/x', 'https://shop.test')).toBe(false);
  });
});

// ─── Redaction ───────────────────────────────────────────────────────────────

describe('credentials are stripped on the way in', () => {
  it('replaces credential headers and keeps their names visible', () => {
    const headers = redactHeaders({
      Authorization: 'Bearer sk_live_deadbeefdeadbeef',
      Cookie: 'session=abc123def456',
      'X-Api-Key': 'key_1234567890',
      Accept: 'application/json',
      'Content-Encoding': 'gzip',
    });
    expect(headers).toContainEqual({ name: 'Authorization', value: REDACTED });
    expect(headers).toContainEqual({ name: 'Cookie', value: REDACTED });
    expect(headers).toContainEqual({ name: 'X-Api-Key', value: REDACTED });
    expect(headers).toContainEqual({ name: 'Accept', value: 'application/json' });
    // Encoding headers describe bytes the archive no longer holds.
    expect(headers.map((h) => h.name)).not.toContain('Content-Encoding');
  });

  it('replaces credential query parameters and URL credentials', () => {
    const out = redactUrl('https://u:p@api.test/v1?access_token=abc123456&page=2');
    expect(out).toContain('access_token=%5BREDACTED%5D');
    expect(out).toContain('page=2');
    expect(out).not.toContain('abc123456');
  });

  it('finds tokens hiding in bodies', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g';
    expect(redactText(`{"token":"${jwt}"}`)).not.toContain('eyJhbGci');
    expect(redactText('Authorization: Bearer sk_live_abcdefgh')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('masks this environment\'s own secret values wherever they appear', () => {
    expect(redactText('the key is s3cr3t-value-here', ['s3cr3t-value-here'])).toBe(
      `the key is ${REDACTED}`,
    );
    // Too short to mask safely — it would eat ordinary prose.
    expect(redactText('an ok result', ['ok'])).toBe('an ok result');
  });

  it('says in the archive what it stripped and when', () => {
    const described = describeRedaction(['STRIPE_KEY']);
    expect(described.when).toContain('before anything was written');
    expect(described.environmentSecretsMasked).toEqual(['STRIPE_KEY']);
  });
});

// ─── Archive ─────────────────────────────────────────────────────────────────

function entry({
  url,
  method = 'GET',
  ...over
}: Partial<HarEntry> & { url: string; method?: string }): HarEntry {
  return {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    time: 5,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [{ name: 'content-type', value: 'application/json' }],
      content: { size: 2, mimeType: 'application/json', text: '{}' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 2,
    },
    cache: {},
    timings: { send: -1, wait: 5, receive: -1 },
    ...over,
  };
}

describe('archive', () => {
  it('refuses a file that is not a HAR, with a reason', () => {
    expect(() => parseArchive('nope')).toThrow(/not valid JSON/);
    expect(() => parseArchive('{"log":{}}')).toThrow(/log\.entries/);
  });

  it('reads a HAR QAAI did not write, dating it from its first entry', () => {
    const foreign = { log: { version: '1.2', entries: [entry({ url: 'https://x.test/a' })] } };
    const archive = parseArchive(JSON.stringify(foreign));
    expect(archiveRecordedAt(archive)).toBe('2026-01-01T00:00:00.000Z');
    expect(indexArchive(archive, N(), null).size).toBe(1);
  });

  it('serves repeats of a polled endpoint in order, then repeats the last', () => {
    const archive = createArchive({
      recordedAt: new Date().toISOString(),
      baseUrl: null,
      normalise: N(),
      scope: 'all',
      secretNames: [],
    });
    archive.log.entries.push(
      entry({ url: 'https://x.test/status', response: { ...entry({ url: '' }).response, status: 202 } }),
      entry({ url: 'https://x.test/status?_=99', response: { ...entry({ url: '' }).response, status: 200 } }),
    );
    const bucket = indexArchive(archive, N(), null).get('GET https://x.test/status');
    expect(bucket?.map((e) => e.response.status)).toEqual([202, 200]);
  });

  it('decodes bodies and refuses to replay cookies or stale encodings', () => {
    const binary = entry({
      url: 'https://x.test/img',
      response: {
        ...entry({ url: '' }).response,
        headers: [
          { name: 'content-type', value: 'image/png' },
          { name: 'set-cookie', value: REDACTED },
          { name: 'content-encoding', value: 'gzip' },
        ],
        content: { size: 3, mimeType: 'image/png', text: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64' },
      },
    });
    expect([...entryBody(binary)]).toEqual([1, 2, 3]);
    expect(Object.keys(entryHeaders(binary))).toEqual(['content-type']);
  });
});

describe('stalenessWarning', () => {
  const now = Date.parse('2026-08-01T00:00:00.000Z');

  it('says nothing about a fresh recording', () => {
    expect(stalenessWarning('2026-07-25T00:00:00.000Z', 30, now)).toBeNull();
  });

  it('warns, with the age, once a recording is old', () => {
    const warning = stalenessWarning('2026-01-01T00:00:00.000Z', 30, now);
    expect(warning).toMatch(/212 days old/);
    expect(warning).toMatch(/Re-record/);
  });

  it('warns when a recording will not say how old it is', () => {
    expect(stalenessWarning(null, 30, now)).toMatch(/does not say when it was captured/);
  });

  it('can be switched off', () => {
    expect(stalenessWarning('2001-01-01T00:00:00.000Z', null, now)).toBeNull();
  });
});

// ─── The visibility guarantee ────────────────────────────────────────────────

const REPLAY_CONFIG: HarConfig = {
  mode: 'replay',
  path: 'fixtures/network.har.json',
  onMiss: 'abort',
  scope: 'all',
  normalise: N(),
  exclude: [],
  maxAgeDays: 30,
  maxEntryBytes: 512_000,
  maxTotalBytes: 24_000_000,
};

function report(over: Partial<HarRunReport> = {}): HarRunReport {
  return {
    mode: 'replay',
    served: 3,
    recorded: 0,
    excluded: 0,
    misses: [],
    installError: null,
    wrote: null,
    bytes: 0,
    truncatedEntries: 0,
    entries: [],
    ...over,
  };
}

describe('a run that was not hermetic always says so', () => {
  it('claims hermetic only when every request came from the recording', () => {
    const summary = summariseHarRun(report(), REPLAY_CONFIG);
    expect(summary.hermetic).toBe(true);
    expect(summary.notice).toMatch(/^HERMETIC: all 3 request/);
  });

  it('refuses to claim hermetic when no report was written at all', () => {
    // The dangerous case: a recorder that never started looks exactly like a
    // recorder with nothing to do. Fail open — assume the network was used.
    const summary = summariseHarRun(null, REPLAY_CONFIG);
    expect(summary.hermetic).toBe(false);
    expect(summary.notice).toMatch(/^NOT HERMETIC/);
  });

  it('refuses to claim hermetic when the runtime failed to install', () => {
    const summary = summariseHarRun(report({ installError: 'boom' }), REPLAY_CONFIG);
    expect(summary.hermetic).toBe(false);
    expect(summary.notice).toContain('boom');
    expect(summary.notice).toMatch(/^NOT HERMETIC/);
  });

  it('names the passthrough as the thing that broke hermeticity', () => {
    const summary = summariseHarRun(
      report({
        misses: [{ method: 'POST', url: 'https://stripe.test/v1/charges', key: 'k', action: 'passed-through' }],
      }),
      { ...REPLAY_CONFIG, onMiss: 'passthrough' },
    );
    expect(summary.hermetic).toBe(false);
    expect(summary.notice).toMatch(/^NOT HERMETIC/);
    expect(summary.notice).toContain('https://stripe.test/v1/charges');
    expect(summary.notice).toContain('har.mode = "record"');
  });

  it('stays hermetic when a miss was blocked, and blames the recording, not the app', () => {
    const summary = summariseHarRun(
      report({ misses: [{ method: 'GET', url: 'https://x.test/new', key: 'k', action: 'aborted' }] }),
      REPLAY_CONFIG,
    );
    expect(summary.hermetic).toBe(true);
    expect(summary.notice).toContain('BLOCKED');
    expect(summary.notice).toContain('not necessarily a bug in the application');
  });

  it('never calls a recording run hermetic, and says what it stripped', () => {
    const summary = summariseHarRun(
      report({ mode: 'record', served: 0, recorded: 12, bytes: 900, wrote: '/tmp/x.har' }),
      { ...REPLAY_CONFIG, mode: 'record' },
      { artifactKey: 'artifacts/x.har.json' },
    );
    expect(summary.hermetic).toBe(false);
    expect(summary.notice).toContain('captured 12 request');
    expect(summary.notice).toContain('artifacts/x.har.json');
    expect(summary.notice).toContain(REDACTED);
  });

  it('carries the staleness warning into the result', () => {
    const summary = summariseHarRun(report(), REPLAY_CONFIG, { staleness: 'This recording is old.' });
    expect(summary.notice).toContain('This recording is old.');
  });
});

/*
 * Observed against the running demo store: a replay whose spec called
 * `page.request.get('/api/never-recorded')` got a real 404 back from the live
 * server, while the report said `served: 1, misses: 2` and the run summarised
 * as HERMETIC. Playwright's `context.route()` intercepts what the BROWSER
 * sends; APIRequestContext is a separate HTTP client in the Node process and
 * never reaches the handler, so the route handler's own counters can never
 * notice it. The only honest answer is to read the spec and say so.
 */
describe('traffic the route handler is structurally unable to see', () => {
  it('spots page.request, context.request and the request fixture', () => {
    expect(unroutableTransports(`await page.request.get('/x');`)).toEqual(['page.request']);
    expect(unroutableTransports(`await context.request.post('/x');`)).toEqual(['context.request']);
    expect(unroutableTransports(`test('t', async ({ page, request }) => {});`)).toEqual([
      'the `request` fixture',
    ]);
  });

  it('leaves an ordinary browser-only spec alone', () => {
    const spec = `test('t', async ({ page }) => {
      await page.goto('/products');
      await page.evaluate(() => fetch('/api/things'));
    });`;
    expect(unroutableTransports(spec)).toEqual([]);
    expect(summariseHarRun(report(), REPLAY_CONFIG, { unroutable: [] }).hermetic).toBe(true);
  });

  it('never prints the word HERMETIC for a run that used an unroutable transport', () => {
    const summary = summariseHarRun(report(), REPLAY_CONFIG, { unroutable: ['page.request'] });
    expect(summary.hermetic).toBe(false);
    expect(summary.notice).toMatch(/^NOT HERMETIC/);
    expect(summary.notice).toContain('page.request');
    // The old text claimed "nothing reached the network" — the exact sentence
    // that was false. It must not appear anywhere in this notice.
    expect(summary.notice).not.toContain('nothing reached the network');
    expect(summary.notice).not.toMatch(/(^|\n)HERMETIC:/);
  });

  it('warns on a RECORD run that the recording is incomplete, not that it leaked', () => {
    const summary = summariseHarRun(report({ recorded: 3 }), { ...REPLAY_CONFIG, mode: 'record' }, {
      unroutable: ['page.request'],
    });
    expect(summary.hermetic).toBe(false);
    expect(summary.notice).toMatch(/^INCOMPLETE RECORDING/);
    // The consequence that matters: the later replay will let them out.
    expect(summary.notice).toContain('reach the live network');
  });

  it('still forfeits hermeticity when no report was written at all', () => {
    const summary = summariseHarRun(null, REPLAY_CONFIG, { unroutable: ['page.request'] });
    expect(summary.hermetic).toBe(false);
    expect(summary.notice).toContain('page.request');
  });
});

describe('merging what several processes wrote', () => {
  // Playwright loads a spec in the collection process AND in each worker, so
  // installHar runs more than once. The collection process executes no test and
  // records nothing; when both wrote to one filename its empty result landed
  // last and erased the worker's recording, and the run reported that it had
  // intercepted nothing while quietly throwing away what it caught.
  it('never lets an empty report erase a real one', () => {
    const merged = mergeRunReports([
      report({ served: 0, entries: [] }),
      report({ served: 4, misses: [{ method: 'GET', url: 'u', key: 'k', action: 'aborted' }] }),
      report({ served: 0, entries: [] }),
    ]);
    expect(merged?.served).toBe(4);
    expect(merged?.misses).toHaveLength(1);
  });

  it('never lets an empty recording erase a real one', () => {
    const empty = createArchive({
      recordedAt: '2026-01-01T00:00:00.000Z',
      baseUrl: null,
      normalise: N(),
      scope: 'all',
      secretNames: [],
    });
    const real = createArchive({
      recordedAt: '2026-01-01T00:00:00.000Z',
      baseUrl: null,
      normalise: N(),
      scope: 'all',
      secretNames: [],
    });
    real.log.entries.push(entry({ url: 'https://x.test/a' }));
    expect(mergeArchives([empty, real, empty])?.log.entries).toHaveLength(1);
  });

  it('keeps every worker\'s entries rather than picking one', () => {
    const make = (url: string) => {
      const a = createArchive({
        recordedAt: '2026-01-01T00:00:00.000Z',
        baseUrl: null,
        normalise: N(),
        scope: 'all',
        secretNames: [],
      });
      a.log.entries.push(entry({ url }));
      return a;
    };
    expect(mergeArchives([make('https://x.test/a'), make('https://x.test/b')])?.log.entries).toHaveLength(2);
  });

  it('reports nothing at all as nothing, so the plugin fails open', () => {
    expect(mergeRunReports([])).toBeNull();
    expect(summariseHarRun(mergeRunReports([]), REPLAY_CONFIG).hermetic).toBe(false);
  });

  it('keeps an install error even when another process succeeded', () => {
    const merged = mergeRunReports([report({ installError: 'no recording' }), report()]);
    expect(merged?.installError).toBe('no recording');
  });
});

// ─── The route handler, through fakes ────────────────────────────────────────

interface FakeResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

interface RouteCalls {
  fulfilled: Array<{ status?: number; headers?: Record<string, string>; body?: Buffer | string }>;
  aborted: string[];
  continued: number;
  fetched: number;
}

function fakeRoute(init: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string | null;
  response?: FakeResponse;
  fetchThrows?: boolean;
}): { route: HarRoute; calls: RouteCalls } {
  const calls: RouteCalls = { fulfilled: [], aborted: [], continued: 0, fetched: 0 };
  const route: HarRoute = {
    request: () => ({
      method: () => init.method ?? 'GET',
      url: () => init.url,
      headers: () => init.headers ?? {},
      postData: () => init.postData ?? null,
    }),
    fetch: (): Promise<HarApiResponse> => {
      calls.fetched += 1;
      if (init.fetchThrows) return Promise.reject(new Error('ECONNREFUSED'));
      const r = init.response ?? {};
      return Promise.resolve({
        status: () => r.status ?? 200,
        statusText: () => r.statusText ?? 'OK',
        headers: () => r.headers ?? { 'content-type': 'application/json' },
        body: () => Promise.resolve(Buffer.from(r.body ?? '{}')),
      });
    },
    fulfill: (options) => {
      calls.fulfilled.push(options);
      return Promise.resolve();
    },
    abort: (code) => {
      calls.aborted.push(code ?? 'failed');
      return Promise.resolve();
    },
    continue: () => {
      calls.continued += 1;
      return Promise.resolve();
    },
  };
  return { route, calls };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qaai-har-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Installs the runtime the way Playwright would and hands back the one route
 * handler it registered, plus the flush that `afterEach` triggers.
 */
async function install(
  config: HarConfig,
  over: { baseUrl?: string | null; secretNames?: string[] } = {},
): Promise<{
  handle: (route: HarRoute) => Promise<void>;
  flush: () => Promise<void>;
  readReport: () => HarRunReport | null;
  readArchiveJson: () => string;
}> {
  // Its own directory per install, exactly as the plugin gives each run one.
  const reportDir = mkdtempSync(join(dir, 'run-'));
  const beforeEachFns: Array<(args: { context: { route: (u: string, h: (r: HarRoute) => unknown) => Promise<void> } }) => unknown> = [];
  const afterEachFns: Array<(args: unknown) => unknown> = [];
  const test: HarTestType = {
    beforeEach: (fn) => beforeEachFns.push(fn),
    afterEach: (fn) => afterEachFns.push(fn),
  };

  installHar(test, {
    config,
    baseUrl: over.baseUrl === undefined ? 'https://shop.test' : over.baseUrl,
    secretNames: over.secretNames ?? [],
    reportDir,
  });

  let handler: ((route: HarRoute) => unknown) | null = null;
  for (const fn of beforeEachFns) {
    await fn({
      context: {
        route: (_url, h) => {
          handler = h;
          return Promise.resolve();
        },
      },
    });
  }

  return {
    handle: async (route) => {
      await (handler as unknown as (r: HarRoute) => Promise<void>)(route);
    },
    flush: async () => {
      for (const fn of afterEachFns) await fn({});
    },
    readReport: () => readHarRunDir(reportDir).report,
    readArchiveJson: () => JSON.stringify(readHarRunDir(reportDir).archive, null, 2),
  };
}

const recordConfig = (over: Partial<HarConfig> = {}): HarConfig => ({
  ...REPLAY_CONFIG,
  mode: 'record',
  ...over,
});

describe('record mode', () => {
  it('captures the pair, serves the real bytes back, and writes a HAR', async () => {
    const har = await install(recordConfig());
    const { route, calls } = fakeRoute({
      url: 'https://stripe.test/v1/charges?_=1738',
      method: 'POST',
      postData: '{"amount":100}',
      response: { status: 201, body: '{"id":"ch_1"}' },
    });

    await har.handle(route);
    await har.flush();

    expect(calls.fetched).toBe(1);
    expect(calls.fulfilled[0]?.status).toBe(201);

    const archive = parseArchive(har.readArchiveJson());
    expect(archive.log.entries).toHaveLength(1);
    const recorded = archive.log.entries[0]!;
    // The cache buster is normalised out of the stored URL, so the entry still
    // matches tomorrow's request.
    expect(recorded.request.url).toBe('https://stripe.test/v1/charges');
    expect(recorded.response.content.text).toBe('{"id":"ch_1"}');
    expect(har.readReport()?.recorded).toBe(1);
  });

  it('never writes a credential to disk', async () => {
    // The harness puts an environment's secrets in the Playwright process's own
    // env before the spec loads; the runtime reads them by name at install so
    // their VALUES never travel through the workspace.
    process.env.STRIPE_KEY = 'sk_test_supersecretvalue';
    let readArchiveJson: () => string = () => {
      throw new Error('install never ran');
    };
    try {
      const har = await install(recordConfig(), { secretNames: ['STRIPE_KEY'] });
      readArchiveJson = har.readArchiveJson;
      const { route } = fakeRoute({
        url: 'https://api.test/me?access_token=tok_abcdefghij',
        headers: { authorization: 'Bearer sk_test_supersecretvalue', cookie: 'sid=abcdef123456' },
        response: {
          headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abcdef123456' },
          body: '{"key":"sk_test_supersecretvalue"}',
        },
      });
      await har.handle(route);
      await har.flush();
    } finally {
      delete process.env.STRIPE_KEY;
    }

    // Asserted against the FILE, because that is the thing that gets exported.
    const onDisk = readArchiveJson();
    expect(onDisk).not.toContain('sk_test_supersecretvalue');
    expect(onDisk).not.toContain('tok_abcdefghij');
    expect(onDisk).not.toContain('sid=abcdef123456');
    expect(onDisk).toContain(REDACTED);
    // And it explains itself to whoever opens it.
    expect(parseArchive(onDisk).log._qaai?.redaction).toMatchObject({
      when: expect.stringContaining('capture time'),
    });
  });

  it('records an oversized body as metadata rather than blowing up the artifact', async () => {
    const har = await install(recordConfig({ maxEntryBytes: 16 }));
    const { route } = fakeRoute({ url: 'https://x.test/big', response: { body: 'x'.repeat(100) } });
    await har.handle(route);
    await har.flush();

    const recorded = parseArchive(har.readArchiveJson()).log.entries[0]!;
    expect(recorded.response.content.text).toBeUndefined();
    expect(recorded._qaai?.truncated).toBe(true);
    expect(har.readReport()?.truncatedEntries).toBe(1);
  });

  it('hands a request that genuinely failed back to Playwright', async () => {
    const har = await install(recordConfig());
    const { route, calls } = fakeRoute({ url: 'https://down.test/x', fetchThrows: true });
    await har.handle(route);
    await har.flush();

    expect(calls.aborted).toEqual(['failed']);
    expect(parseArchive(har.readArchiveJson()).log.entries).toHaveLength(0);
  });
});

describe('replay mode', () => {
  function recordingAt(path: string, entries: HarEntry[]): void {
    const archive = createArchive({
      recordedAt: new Date().toISOString(),
      baseUrl: 'https://shop.test',
      normalise: N(),
      scope: 'all',
      secretNames: [],
    });
    archive.log.entries.push(...entries);
    writeFileSync(path, JSON.stringify(archive), 'utf8');
  }

  it('serves a recorded response and never touches the network', async () => {
    const path = join(dir, 'net.har.json');
    recordingAt(path, [
      entry({
        url: 'https://stripe.test/v1/charges',
        response: {
          ...entry({ url: '' }).response,
          status: 201,
          content: { size: 13, mimeType: 'application/json', text: '{"id":"ch_1"}' },
        },
      }),
    ]);

    const har = await install({ ...REPLAY_CONFIG, path });
    // A different cache buster than the one recorded: normalisation is what
    // makes the recording still work.
    const { route, calls } = fakeRoute({ url: 'https://stripe.test/v1/charges?_=999' });
    await har.handle(route);
    await har.flush();

    expect(calls.fetched).toBe(0);
    expect(calls.continued).toBe(0);
    expect(calls.fulfilled[0]?.status).toBe(201);
    expect(String(calls.fulfilled[0]?.body)).toBe('{"id":"ch_1"}');
    expect(har.readReport()).toMatchObject({ served: 1, misses: [] });
  });

  it('replays against a different host than it was recorded on', async () => {
    const path = join(dir, 'net.har.json');
    recordingAt(path, [entry({ url: `${BASE_URL_TOKEN}/api/cart` })]);
    const har = await install({ ...REPLAY_CONFIG, path }, { baseUrl: 'https://pr-42.shop.test' });
    const { route, calls } = fakeRoute({ url: 'https://pr-42.shop.test/api/cart' });
    await har.handle(route);
    expect(calls.fulfilled).toHaveLength(1);
  });

  it('still matches once the token in the URL has rotated', async () => {
    // The recording holds `access_token=[REDACTED]`, because that is the only
    // safe thing to store. Matching has to agree, or every credential-bearing
    // URL would miss on the very next run — a token's whole job is to change.
    const path = join(dir, 'net.har.json');
    recordingAt(path, [
      entry({ url: normaliseUrl('https://api.test/me?access_token=first_token_value', N()) }),
    ]);
    const har = await install({ ...REPLAY_CONFIG, path });
    const { route, calls } = fakeRoute({ url: 'https://api.test/me?access_token=second_token_value' });
    await har.handle(route);
    expect(calls.fulfilled).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).not.toContain('first_token_value');
  });

  it('blocks an unrecorded request by default, and reports it', async () => {
    const path = join(dir, 'net.har.json');
    recordingAt(path, []);
    const har = await install({ ...REPLAY_CONFIG, path });
    const { route, calls } = fakeRoute({ url: 'https://new.test/thing', method: 'POST' });
    await har.handle(route);
    await har.flush();

    expect(calls.aborted).toEqual(['failed']);
    expect(calls.continued).toBe(0);
    const miss = har.readReport()?.misses[0];
    expect(miss).toMatchObject({ method: 'POST', action: 'aborted' });
    expect(summariseHarRun(har.readReport(), REPLAY_CONFIG).hermetic).toBe(true);
  });

  it('lets a miss through only when told to, and never quietly', async () => {
    const path = join(dir, 'net.har.json');
    recordingAt(path, []);
    const config = { ...REPLAY_CONFIG, path, onMiss: 'passthrough' as const };
    const har = await install(config);
    const { route, calls } = fakeRoute({ url: 'https://new.test/thing' });
    await har.handle(route);
    await har.flush();

    expect(calls.continued).toBe(1);
    expect(calls.aborted).toEqual([]);
    const summary = summariseHarRun(har.readReport(), config);
    expect(summary.hermetic).toBe(false);
    expect(summary.notice).toMatch(/^NOT HERMETIC/);
  });

  it('redacts the URL it reports a miss for', async () => {
    const path = join(dir, 'net.har.json');
    recordingAt(path, []);
    const har = await install({ ...REPLAY_CONFIG, path });
    const { route } = fakeRoute({ url: 'https://new.test/thing?token=abcdef123456' });
    await har.handle(route);
    await har.flush();
    expect(JSON.stringify(har.readReport())).not.toContain('abcdef123456');
  });

  it('blocks an excluded URL instead of letting it out', async () => {
    const path = join(dir, 'net.har.json');
    recordingAt(path, []);
    const har = await install({ ...REPLAY_CONFIG, path, exclude: ['analytics\\.test'] });
    const { route, calls } = fakeRoute({ url: 'https://analytics.test/collect' });
    await har.handle(route);
    await har.flush();

    expect(calls.aborted).toEqual(['blockedbyclient']);
    // Excluded on purpose is not a miss — it must not read as a stale recording.
    expect(har.readReport()).toMatchObject({ excluded: 1, misses: [] });
  });

  it('leaves the application under test alone in third-party scope', async () => {
    const path = join(dir, 'net.har.json');
    recordingAt(path, []);
    const har = await install({ ...REPLAY_CONFIG, path, scope: 'third-party' });
    const own = fakeRoute({ url: 'https://shop.test/checkout' });
    await har.handle(own.route);
    expect(own.calls.continued).toBe(1);
    expect(har.readReport()?.misses).toEqual([]);
  });

  it('repeats the last recorded response when a poll outruns the recording', async () => {
    const path = join(dir, 'net.har.json');
    const base = entry({ url: 'https://x.test/status' });
    recordingAt(path, [
      { ...base, response: { ...base.response, status: 202 } },
      { ...base, response: { ...base.response, status: 200 } },
    ]);
    const har = await install({ ...REPLAY_CONFIG, path });
    const statuses: Array<number | undefined> = [];
    for (let i = 0; i < 3; i += 1) {
      const { route, calls } = fakeRoute({ url: 'https://x.test/status' });
      await har.handle(route);
      statuses.push(calls.fulfilled[0]?.status);
    }
    expect(statuses).toEqual([202, 200, 200]);
  });

  it('reports a missing recording as an install error rather than throwing', async () => {
    const har = await install({ ...REPLAY_CONFIG, path: join(dir, 'absent.har.json') });
    const report = har.readReport();
    expect(report?.installError).toBeTruthy();
    expect(summariseHarRun(report, REPLAY_CONFIG).hermetic).toBe(false);
  });
});

describe('the handler itself never fails a test', () => {
  it('falls back to continuing the request, and records that it did', async () => {
    const path = join(dir, 'net.har.json');
    writeFileSync(
      path,
      JSON.stringify({ log: { version: '1.2', entries: [entry({ url: 'https://x.test/a' })] } }),
      'utf8',
    );
    const har = await install({ ...REPLAY_CONFIG, path });

    // A route whose own methods blow up: the failure is on Playwright's side of
    // the boundary, and the handler must not turn it into a test failure.
    const exploding: HarRoute = {
      request: () => {
        throw new Error('route is gone');
      },
      fetch: () => Promise.reject(new Error('no')),
      fulfill: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      continue: () => Promise.resolve(),
    };

    await expect(har.handle(exploding)).resolves.toBeUndefined();
    await har.flush();
    const summary = summariseHarRun(har.readReport(), REPLAY_CONFIG);
    expect(summary.hermetic).toBe(false);
    expect(summary.notice).toContain('handler error');
  });
});
