/**
 * Tests for the metrics registry, the route labelling, and the rate-limit key.
 *
 * Three things are being pinned down here, and they have different stakes:
 *
 *  1. THE RATE-LIMIT KEY. This is a security control, not a metric. Until now a
 *     custom keyGenerator returned `req.ip` directly, which means an IPv6 client
 *     got a fresh budget for every address in its own prefix — an unbounded
 *     budget, on the endpoints that protect password login and the SAML ACS. The
 *     tests below assert the grouping directly rather than asserting that the
 *     warning went away, because the warning is a heuristic and the grouping is
 *     the actual property.
 *
 *  2. LEAKAGE AND CARDINALITY. /metrics is unauthenticated. A label that can
 *     hold a caller-chosen string is both a data leak and a way for a stranger
 *     to exhaust the API's memory, so the labelling functions are tested against
 *     the inputs a bot actually sends.
 *
 *  3. THE TEXT FORMAT. A body Prometheus cannot parse is a monitoring outage
 *     that looks like silence.
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Counter,
  Gauge,
  Histogram,
  IPV6_RATE_LIMIT_SUBNET,
  MAX_SERIES_PER_METRIC,
  WORKER_SNAPSHOT_VERSION,
  _resetRegistryForTests,
  apiExceptions,
  httpInFlight,
  httpRequests,
  normalizeRoute,
  observabilityMiddleware,
  parseWorkerSnapshot,
  rateLimitKey,
  registry,
  renderWorkerSnapshots,
  routeLabelFor,
  statusClass,
  type WorkerMetricsSnapshot,
} from './metrics.js';

beforeEach(() => {
  _resetRegistryForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// The IPv6 rate-limit hole
// ─────────────────────────────────────────────────────────────────────────────

describe('the rate-limit key for unauthenticated IPv6 traffic', () => {
  /*
   * The bug, stated precisely: an IPv4 client is one address, but an IPv6 client
   * is a whole delegated prefix — a home connection typically holds a /56 and a
   * datacentre a /48. Keying the limiter on the full 128-bit address therefore
   * hands anyone with IPv6 an unlimited budget: rotate the low bits, get a new
   * bucket, repeat. That is not a degraded rate limit, it is no rate limit.
   */

  it('puts two addresses from the same /64 in one bucket', () => {
    const a = rateLimitKey({ ip: '2001:db8:abcd:0012::1' });
    const b = rateLimitKey({ ip: '2001:db8:abcd:0012:dead:beef:cafe:f00d' });

    expect(a).toBe(b);
  });

  it('puts every /64 inside one /56 in the same bucket', () => {
    // The prefix that is actually delegated to a subscriber is the /56, so
    // grouping at /64 alone would still leave 256 buckets per customer to
    // rotate through.
    const keys = new Set(
      ['2001:db8:abcd:0000::1', '2001:db8:abcd:0042::1', '2001:db8:abcd:00ff::9999'].map((ip) =>
        rateLimitKey({ ip }),
      ),
    );

    expect(keys.size).toBe(1);
  });

  it('does not merge two different customers', () => {
    // The other half of the property. A prefix wide enough to group a whole ISP
    // would be its own outage: one abusive customer would rate-limit everybody
    // who shares their upstream.
    expect(rateLimitKey({ ip: '2001:db8:abcd::1' })).not.toBe(
      rateLimitKey({ ip: '2001:db8:abce::1' }),
    );
  });

  it('leaves IPv4 alone, one address to one bucket', () => {
    expect(rateLimitKey({ ip: '203.0.113.9' })).not.toBe(rateLimitKey({ ip: '203.0.113.10' }));
  });

  it('groups an IPv4-mapped IPv6 address with the plain IPv4 address', () => {
    // ::ffff:203.0.113.9 and 203.0.113.9 are the same host. Two buckets would
    // mean a client doubles its budget by reconnecting over a dual-stack path.
    expect(rateLimitKey({ ip: '::ffff:203.0.113.9' })).toBe(rateLimitKey({ ip: '203.0.113.9' }));
  });

  it('uses a /56, matching express-rate-limit', () => {
    expect(IPV6_RATE_LIMIT_SUBNET).toBe(56);
  });
});

describe('the rate-limit key for everything else', () => {
  it('buckets authenticated traffic by org, not by address', () => {
    // One tenant behind a corporate NAT must not spend everybody else's budget,
    // and the same tenant arriving from two offices must share one.
    const office = rateLimitKey({ ip: '203.0.113.9', actor: { orgId: 'org_a' } });
    const home = rateLimitKey({ ip: '198.51.100.4', actor: { orgId: 'org_a' } });

    expect(office).toBe(home);
    expect(office).not.toBe(rateLimitKey({ ip: '203.0.113.9', actor: { orgId: 'org_b' } }));
  });

  it('cannot let an org id collide with an address-shaped key', () => {
    // Namespacing is cheap; an org that could name itself after an IP and take
    // over that IP's bucket is not.
    expect(rateLimitKey({ actor: { orgId: '203.0.113.9' } })).not.toBe(
      rateLimitKey({ ip: '203.0.113.9' }),
    );
  });

  it('falls back to one shared bucket when there is no address at all', () => {
    // The safe direction. A unique key per address-less request would be a
    // limiter that never limits.
    expect(rateLimitKey({})).toBe(rateLimitKey({ ip: undefined }));
    expect(rateLimitKey({})).toBe(rateLimitKey({ actor: { orgId: null } }));
  });

  it('satisfies express-rate-limit ERR_ERL_KEY_GEN_IPV6 source check', () => {
    /*
     * express-rate-limit validates a custom keyGenerator by reading its source
     * and refusing one that mentions `req.ip` without calling the
     * `ipKeyGenerator` helper. That check is what has been firing on every boot.
     *
     * Replicated verbatim here rather than asserted through a boot log, so this
     * fails at the moment somebody "simplifies" the helper call away — which is
     * exactly how the hole would be reopened.
     */
    const source = rateLimitKey.toString();

    expect(source.includes('req.ip') || source.includes('request.ip')).toBe(true);
    expect(source.includes('ipKeyGenerator')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route labelling: leakage and cardinality
// ─────────────────────────────────────────────────────────────────────────────

describe('route labels', () => {
  it('labels an unmatched path with one constant, never the path', () => {
    /*
     * The cardinality bomb. /metrics being unauthenticated means this API is
     * scanned continuously, and if every 404 got its own label value then any
     * stranger could mint unlimited time series by requesting unlimited URLs.
     */
    expect(routeLabelFor({ path: '/wp-login.php' })).toBe('<unmatched>');
    expect(routeLabelFor({ path: '/.env' })).toBe('<unmatched>');
    expect(routeLabelFor({ path: '/' + 'a'.repeat(500) })).toBe('<unmatched>');
  });

  it("uses Express's own route template when a route matched", () => {
    expect(routeLabelFor({ baseUrl: '/runs', route: { path: '/:id' }, path: '/clx123' })).toBe(
      '/runs/:id',
    );
    expect(routeLabelFor({ baseUrl: '', route: { path: '/health/ready' } })).toBe('/health/ready');
  });

  it('scrubs identifiers out of a parameterised mount prefix', () => {
    // req.baseUrl substitutes REAL values into a parameterised mount, so the
    // template alone is not enough — the prefix has to be scrubbed too.
    expect(
      routeLabelFor({
        baseUrl: '/projects/clh8f9a2b3c4d5e6f7g8h9i0',
        route: { path: '/runs' },
      }),
    ).toBe('/projects/:id/runs');
  });

  it('replaces every shape of identifier this codebase mints', () => {
    expect(normalizeRoute('/runs/clh8f9a2b3c4d5e6f7g8h9i0')).toBe('/runs/:id');
    expect(normalizeRoute('/runs/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/runs/:id');
    expect(normalizeRoute('/pulls/4821')).toBe('/pulls/:id');
    expect(normalizeRoute('/keys/qaai_abcdef123456')).toBe('/keys/:id');
    expect(normalizeRoute('/commits/9f1c2b3a4d5e6f70')).toBe('/commits/:id');
  });

  it('keeps a real path segment readable', () => {
    expect(normalizeRoute('/suite-health/summary')).toBe('/suite-health/summary');
    expect(normalizeRoute('/')).toBe('/');
  });

  it('collapses a pathologically deep path instead of labelling it', () => {
    expect(normalizeRoute('/a/b/c/d/e/f/g/h/i/j/k')).toBe('/<deep>');
  });

  it('never emits a label containing a query string', () => {
    // req.path excludes the query, but this is the assertion that matters if
    // somebody ever swaps in originalUrl: the query is where the tokens are.
    for (const candidate of ['/sso/acs?RelayState=secret', '/auth/magic?token=abc']) {
      expect(normalizeRoute(candidate)).not.toContain('secret');
      expect(normalizeRoute(candidate)).not.toContain('abc');
    }
  });
});

describe('status classes', () => {
  it('collapses forty codes into five', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(302)).toBe('3xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(429)).toBe('4xx');
    expect(statusClass(500)).toBe('5xx');
    expect(statusClass(503)).toBe('5xx');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The registry and the text format
// ─────────────────────────────────────────────────────────────────────────────

describe('the Prometheus text format', () => {
  it('emits HELP and TYPE for every family it renders', () => {
    httpRequests.inc({ method: 'GET', route: '/runs/:id', status_class: '2xx' });
    const body = registry.render();

    expect(body).toContain('# HELP qaai_http_requests_total ');
    expect(body).toContain('# TYPE qaai_http_requests_total counter');
    expect(body).toContain(
      'qaai_http_requests_total{method="GET",route="/runs/:id",status_class="2xx"} 1',
    );
    // Prometheus requires a trailing newline on the body.
    expect(body.endsWith('\n')).toBe(true);
  });

  it('refuses a metric with no HELP text', () => {
    // A metric whose meaning lives only in somebody's head cannot be paged on.
    expect(() => new Counter('qaai_test_thing', '  ', [])).toThrow(/HELP/);
  });

  it('refuses an invalid metric or label name', () => {
    expect(() => new Counter('9_bad_name', 'help', [])).toThrow(/metric name/);
    expect(() => new Counter('qaai_ok', 'help', ['bad-label'])).toThrow(/label name/);
  });

  it('refuses to decrement a counter', () => {
    // rate() over a series that can go down produces numbers that are quietly
    // wrong, which is worse than an exception.
    const c = new Counter('qaai_test_counter', 'help', []);
    expect(() => c.inc(undefined, -1)).toThrow(/cannot decrease/);
  });

  it('escapes label values so a stray quote cannot corrupt the body', () => {
    const c = new Counter('qaai_test_escape', 'help', ['label']);
    c.inc({ label: 'a"b\\c\nd' });

    expect(c.render()).toContain('qaai_test_escape{label="a\\"b\\\\c\\nd"} 1');
  });

  it('renders a histogram with cumulative buckets, +Inf, sum and count', () => {
    const h = new Histogram('qaai_test_hist', 'help', ['route'], [0.1, 1]);
    h.observe(0.05, { route: '/x' });
    h.observe(0.5, { route: '/x' });
    h.observe(10, { route: '/x' });

    const body = h.render();
    expect(body).toContain('qaai_test_hist_bucket{route="/x",le="0.1"} 1');
    // Cumulative: the 0.05 and the 0.5 observation both count here.
    expect(body).toContain('qaai_test_hist_bucket{route="/x",le="1"} 2');
    expect(body).toContain('qaai_test_hist_bucket{route="/x",le="+Inf"} 3');
    expect(body).toContain('qaai_test_hist_count{route="/x"} 3');
    expect(body).toContain('qaai_test_hist_sum{route="/x"} 10.55');
  });

  it('rejects descending histogram buckets', () => {
    expect(() => new Histogram('qaai_test_bad', 'help', [], [1, 0.5])).toThrow(/ascend/);
  });

  it('lets a gauge go down again', () => {
    const g = new Gauge('qaai_test_gauge', 'help', []);
    g.inc();
    g.inc();
    g.dec();
    expect(g.get()).toBe(1);
  });

  it('omits an empty label rather than writing foo=""', () => {
    const c = new Counter('qaai_test_optional', 'help', ['a', 'b']);
    c.inc({ a: 'x' });
    expect(c.render()).toContain('qaai_test_optional{a="x"} 1');
  });

  it('renders nothing at all for a family with no observations', () => {
    // Emitting a bare HELP/TYPE pair with no samples is legal but noisy, and it
    // makes a genuinely absent metric hard to spot.
    expect(new Counter('qaai_test_empty', 'help', []).render()).toBe('');
  });
});

describe('the cardinality ceiling', () => {
  it('folds runaway labels into one series instead of growing without bound', () => {
    const c = new Counter('qaai_test_bomb', 'help', ['id']);
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 250; i++) c.inc({ id: `id-${i}` });

    const lines = c.render().split('\n').filter((l) => l.startsWith('qaai_test_bomb'));

    // The ceiling plus exactly one overflow series, and not one more.
    expect(lines.length).toBe(MAX_SERIES_PER_METRIC + 1);
    expect(c.render()).toContain('qaai_test_bomb{id="__overflow__"} 250');
  });

  it('says out loud which metric overflowed', () => {
    // Silent degradation is how a dashboard stays wrong for a quarter.
    const c = new Counter('qaai_test_bomb_two', 'help', ['id']);
    for (let i = 0; i <= MAX_SERIES_PER_METRIC; i++) c.inc({ id: `id-${i}` });

    expect(registry.render()).toContain(
      'qaai_metrics_series_dropped_total{metric="qaai_test_bomb_two"} 1',
    );
  });

  it('counts the overflow once, not once per dropped series', () => {
    const c = new Counter('qaai_test_bomb_three', 'help', ['id']);
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 100; i++) c.inc({ id: `id-${i}` });

    expect(registry.render()).toContain(
      'qaai_metrics_series_dropped_total{metric="qaai_test_bomb_three"} 1',
    );
  });
});

describe('the registry', () => {
  it('refuses two metrics with the same name', () => {
    // Two families under one name is an unparseable scrape.
    expect(() => registry.register(new Counter('qaai_http_requests_total', 'help', []))).toThrow(
      /already registered/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The HTTP middleware
// ─────────────────────────────────────────────────────────────────────────────

function fakeExchange(over: { statusCode?: number; writableEnded?: boolean } = {}) {
  const res = Object.assign(new EventEmitter(), {
    statusCode: over.statusCode ?? 200,
    writableEnded: over.writableEnded ?? true,
  });
  const req = { method: 'GET', baseUrl: '/runs', route: { path: '/:id' }, path: '/clx1' };
  return { req, res };
}

describe('the request middleware', () => {
  it('records a finished request against its route template', () => {
    const { req, res } = fakeExchange({ statusCode: 201 });
    observabilityMiddleware(req as never, res as never, () => {});
    res.emit('close');

    expect(
      httpRequests.get({ method: 'GET', route: '/runs/:id', status_class: '2xx' }),
    ).toBe(1);
  });

  it('returns the in-flight gauge to zero even when the client hangs up', () => {
    /*
     * The reason the middleware listens on 'close' and not 'finish'. An aborted
     * response never fires 'finish', so a gauge decremented there climbs forever
     * under a flaky network and eventually reads as an API that is wedged.
     */
    const { req, res } = fakeExchange({ writableEnded: false });
    observabilityMiddleware(req as never, res as never, () => {});
    expect(httpInFlight.get()).toBe(1);

    res.emit('close');
    expect(httpInFlight.get()).toBe(0);
  });

  it('files an aborted request separately from a server error', () => {
    // Folding client hang-ups into 5xx poisons the error-rate SLO with something
    // that is not our fault.
    const { req, res } = fakeExchange({ statusCode: 200, writableEnded: false });
    observabilityMiddleware(req as never, res as never, () => {});
    res.emit('close');

    expect(
      httpRequests.get({ method: 'GET', route: '/runs/:id', status_class: 'aborted' }),
    ).toBe(1);
    expect(httpRequests.get({ method: 'GET', route: '/runs/:id', status_class: '5xx' })).toBe(0);
  });

  it('calls next exactly once so it can be mounted first', () => {
    const { req, res } = fakeExchange();
    let calls = 0;
    observabilityMiddleware(req as never, res as never, () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });
});

describe('exception accounting', () => {
  it('labels by a closed vocabulary, never by the exception class', () => {
    apiExceptions.inc({ route: '/runs/:id', kind: 'unhandled' });
    expect(registry.render()).toContain(
      'qaai_api_exceptions_total{route="/runs/:id",kind="unhandled"} 1',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Worker snapshots
// ─────────────────────────────────────────────────────────────────────────────

const goodSnapshot = (): Record<string, unknown> => ({
  v: WORKER_SNAPSHOT_VERSION,
  instance: 'a1b2c3d4e5f60718',
  startedAtMs: 1_000_000,
  publishedAtMs: 1_060_000,
  concurrency: 4,
  jobs: { 'qaai.run': { completed: 12, failed: 3 } },
  active: { 'qaai.run': 2 },
  jobDuration: { 'qaai.run': { le: [1, 5], counts: [1, 4], sum: 30, count: 6 } },
  pluginDuration: { E2E: { le: [0.5, 1], counts: [2, 5], sum: 12.5, count: 7 } },
});

describe('reading a worker snapshot off the wire', () => {
  it('accepts a well-formed snapshot', () => {
    const parsed = parseWorkerSnapshot(goodSnapshot());
    expect(parsed?.instance).toBe('a1b2c3d4e5f60718');
    expect(parsed?.jobs['qaai.run']?.completed).toBe(12);
  });

  it('accepts the JSON string form, since that is what Redis returns', () => {
    expect(parseWorkerSnapshot(JSON.stringify(goodSnapshot()))?.concurrency).toBe(4);
  });

  it('discards a snapshot from a different code version', () => {
    /*
     * The rolling-deploy case, and the reason the version exists. For a few
     * minutes a new API reads snapshots written by old workers; guessing at
     * their shape would produce a malformed scrape body precisely while a
     * deploy is in flight, which is when the metrics matter most.
     */
    expect(parseWorkerSnapshot({ ...goodSnapshot(), v: 99 })).toBeNull();
  });

  it('discards garbage rather than throwing', () => {
    expect(parseWorkerSnapshot('not json at all')).toBeNull();
    expect(parseWorkerSnapshot(null)).toBeNull();
    expect(parseWorkerSnapshot(42)).toBeNull();
    expect(parseWorkerSnapshot([])).toBeNull();
  });

  it('refuses an instance id that would break the text format', () => {
    // The instance id is printed as a label value. A snapshot that could inject
    // a quote or a newline into the body is a snapshot that can corrupt every
    // metric after it.
    expect(parseWorkerSnapshot({ ...goodSnapshot(), instance: 'a"b' })).toBeNull();
    expect(parseWorkerSnapshot({ ...goodSnapshot(), instance: 'a\nb' })).toBeNull();
    expect(parseWorkerSnapshot({ ...goodSnapshot(), instance: '' })).toBeNull();
  });

  it('drops a histogram whose buckets and counts disagree', () => {
    const snap = goodSnapshot();
    snap.jobDuration = { 'qaai.run': { le: [1, 5, 10], counts: [1, 4], sum: 30, count: 6 } };
    expect(parseWorkerSnapshot(snap)?.jobDuration['qaai.run']).toBeUndefined();
  });

  it('drops a histogram whose buckets do not ascend', () => {
    const snap = goodSnapshot();
    snap.jobDuration = { 'qaai.run': { le: [5, 1], counts: [1, 4], sum: 30, count: 6 } };
    expect(parseWorkerSnapshot(snap)?.jobDuration['qaai.run']).toBeUndefined();
  });

  it('drops a label a worker should never have sent', () => {
    const snap = goodSnapshot();
    snap.pluginDuration = {
      'checkout with saved Amex" fails': { le: [1], counts: [1], sum: 1, count: 1 },
    };
    const parsed = parseWorkerSnapshot(snap);
    expect(Object.keys(parsed?.pluginDuration ?? {})).toEqual([]);
  });

  it('caps how many series one worker can contribute', () => {
    const snap = goodSnapshot();
    const plugins: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) plugins[`p${i}`] = { le: [1], counts: [1], sum: 1, count: 1 };
    snap.pluginDuration = plugins;

    expect(Object.keys(parseWorkerSnapshot(snap)?.pluginDuration ?? {}).length).toBe(64);
  });
});

describe('rendering worker metrics', () => {
  const snapshot = (over: Partial<WorkerMetricsSnapshot> = {}): WorkerMetricsSnapshot => ({
    ...(parseWorkerSnapshot(goodSnapshot()) as WorkerMetricsSnapshot),
    ...over,
  });

  it('keeps each worker on its own series so its counters stay monotonic', () => {
    /*
     * Summing counters across a changing set of processes produces a series that
     * DROPS when a worker dies, and rate() over a non-monotonic series is
     * silently wrong. Per-instance, each series only ever resets — which is the
     * contract rate() is actually built on.
     */
    const body = renderWorkerSnapshots([
      snapshot({ instance: 'aaaa' }),
      snapshot({ instance: 'bbbb' }),
    ]);

    expect(body).toContain('qaai_worker_jobs_total{instance="aaaa",queue="qaai.run",outcome="completed"} 12');
    expect(body).toContain('qaai_worker_jobs_total{instance="bbbb",queue="qaai.run",outcome="completed"} 12');
    expect(body).toContain('qaai_workers_online 2');
  });

  it('reports liveness by presence, so a dead worker simply vanishes', () => {
    // The TTL on the Redis key is what makes this true: nothing has to observe
    // the death and write it down, which is fortunate, because the only process
    // in a position to do that is the one that just died.
    const body = renderWorkerSnapshots([]);
    // Matched against sample lines rather than the whole body: another metric's
    // HELP text refers to this one by name, and that is documentation, not a
    // sample.
    const samples = body.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(samples.some((l) => l.startsWith('qaai_worker_up'))).toBe(false);
    expect(samples.some((l) => l.startsWith('qaai_worker_heartbeat_age_seconds'))).toBe(false);
  });

  it('still reports zero online workers, because that is the alertable value', () => {
    /*
     * The counterpart to the test above, and the reason the two metrics behave
     * differently. Per-instance series must disappear or a dead worker keeps
     * reporting; the aggregate must NOT, because "no workers are running" is
     * precisely the condition somebody writes an alert for, and an alert cannot
     * fire on a series that is absent.
     */
    expect(renderWorkerSnapshots([])).toContain('qaai_workers_online 0');
  });

  it('exposes heartbeat age so a wedged worker is distinguishable from a dead one', () => {
    const body = renderWorkerSnapshots([snapshot({ publishedAtMs: 1_000_000 })], 1_045_000);
    expect(body).toContain('qaai_worker_heartbeat_age_seconds{instance="a1b2c3d4e5f60718"} 45');
  });

  it('never reports a negative age when clocks disagree', () => {
    // The worker stamps publishedAtMs from its own clock and the API subtracts
    // from its own. On unsynchronised hosts that difference goes negative, and a
    // negative age reads as a metric bug rather than a clock bug.
    const body = renderWorkerSnapshots([snapshot({ publishedAtMs: 2_000_000 })], 1_000_000);
    expect(body).toContain('qaai_worker_heartbeat_age_seconds{instance="a1b2c3d4e5f60718"} 0');
  });

  it('renders plugin durations by test type with a +Inf bucket', () => {
    const body = renderWorkerSnapshots([snapshot()]);
    expect(body).toContain(
      'qaai_plugin_execution_duration_seconds_bucket{instance="a1b2c3d4e5f60718",plugin="E2E",le="+Inf"} 7',
    );
    expect(body).toContain(
      'qaai_plugin_execution_duration_seconds_sum{instance="a1b2c3d4e5f60718",plugin="E2E"} 12.5',
    );
  });

  it('gives every family it renders a HELP line', () => {
    const body = renderWorkerSnapshots([snapshot()]);
    const types = [...body.matchAll(/^# TYPE (\S+)/gm)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(0);
    for (const name of types) expect(body).toContain(`# HELP ${name} `);
  });

  it('publishes nothing that could identify a tenant', () => {
    /*
     * The standing constraint on this whole endpoint. Asserted as a property
     * over the rendered body rather than trusted to review, because /metrics is
     * served without authentication and a leak here is a leak to the internet.
     */
    const body = renderWorkerSnapshots([snapshot()]);
    for (const forbidden of ['org_', 'http://', 'https://', '@', 'acme']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
