import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRAWL_POLICY,
  PLANS,
  capBiteSchema,
  discardedByCaps,
  excludedPathSchema,
  externalBoundarySchema,
  frontierSchema,
  type CrawlPolicy,
  type Plan,
} from '@qaai/shared';
import {
  COUNTS_TOWARD_LOWER_BOUND,
  CRAWL_STOP_REASONS,
  CRAWL_STOP_REASON_PRESENT,
  CrawlFrontier,
  DEFAULT_TEMPLATE_CARDINALITY_THRESHOLD,
  DISCOVERY_SOURCES,
  DISCOVERY_SOURCE_PRESENT,
  KNOWN_UNKNOWN_KINDS,
  KNOWN_UNKNOWN_PRESENT,
  OFFER_OUTCOMES,
  OFFER_OUTCOME_PRESENT,
  PLAN_CRAWL_CEILINGS,
  TEMPLATE_EVIDENCE_KINDS,
  TEMPLATE_EVIDENCE_PRESENT,
  canonicaliseUrl,
  inferRouteTemplates,
  refusalSummary,
  resolveCrawlBudget,
  restoreFrontier,
  scheduleCrawl,
  serialiseFrontier,
  type CrawlLimitOverrides,
  type FrontierEntry,
  type HashRoutingMode,
  type OfferedCandidate,
  type ResolvedCrawlBudget,
  type VisitResult,
} from './frontier';

/**
 * What is and is not covered here, said plainly.
 *
 * Everything in frontier.ts is covered, because everything in frontier.ts is
 * pure or takes its one side effect — the browser — as an injected function.
 * That is the point of the module's shape: `crawler.ts` is 629 lines with two
 * tested functions precisely because its traversal and its page driving are the
 * same code, and no unit test can call it without launching Chromium.
 *
 * The scheduler's tests use an injected clock and an injected sleep, so they
 * assert ORDER and CONCURRENCY rather than elapsed time. A test that waits in
 * real time proves the machine was slow, not that the scheduler was right.
 */

const BASE = 'https://app.test';

function budgetFor(input?: {
  plan?: Plan;
  storedPolicy?: unknown;
  overrides?: CrawlLimitOverrides;
}): ResolvedCrawlBudget {
  return resolveCrawlBudget({
    plan: input?.plan ?? 'ENTERPRISE',
    storedPolicy: input?.storedPolicy ?? null,
    ...(input?.overrides === undefined ? {} : { overrides: input.overrides }),
  });
}

function frontierFor(input?: {
  plan?: Plan;
  storedPolicy?: unknown;
  overrides?: CrawlLimitOverrides;
  hashRouting?: HashRoutingMode;
  cardinalityThreshold?: number;
  baseUrl?: string;
}): CrawlFrontier {
  return new CrawlFrontier({
    baseUrl: input?.baseUrl ?? BASE,
    budget: budgetFor(input),
    ...(input?.hashRouting === undefined ? {} : { hashRouting: input.hashRouting }),
    ...(input?.cardinalityThreshold === undefined
      ? {}
      : { cardinalityThreshold: input.cardinalityThreshold }),
  });
}

function policy(overrides?: Partial<CrawlPolicy>): CrawlPolicy {
  return { ...DEFAULT_CRAWL_POLICY, ...overrides };
}

function canonical(url: string, hashRouting?: HashRoutingMode): string {
  const result = canonicaliseUrl(url, {
    policy: policy(),
    ...(hashRouting === undefined ? {} : { hashRouting }),
  });
  if (!result.ok) throw new Error(`expected ${url} to canonicalise: ${result.rule}`);
  return result.canonical.url;
}

/**
 * A frontier plus a root entry to hang offers off.
 *
 * The root is SYNTHETIC — never queued and never marked visited — so
 * `visitedCount` starts at zero and a test that sets `pageBudget: 2` gets two
 * visits rather than one. The first version of this helper seeded and visited
 * the root, and three budget assertions were off by one because of it.
 */
function seeded(input?: Parameters<typeof frontierFor>[0]): {
  frontier: CrawlFrontier;
  root: FrontierEntry;
} {
  const base = input?.baseUrl ?? BASE;
  return {
    frontier: frontierFor(input),
    root: {
      url: `${base}/`,
      depth: 0,
      template: '/',
      budgetKey: '/',
      discoveredFrom: null,
      discoveredVia: 'SEED',
      order: [0],
    },
  };
}

// ─── The vocabularies, and the drift the compiler cannot see ────────────────

describe('the enumeration vocabularies keep their presence records', () => {
  /*
   * The keystone pattern from packages/shared/src/types.ts, applied here for the
   * reason stated there: a union with a write path and a hand-written record
   * drifts, and eight GateRule kinds that no customer could save for two slices
   * were invisible because nothing checked the record against the array.
   */
  it('names every discovery source', () => {
    expect(Object.keys(DISCOVERY_SOURCE_PRESENT).sort()).toEqual([...DISCOVERY_SOURCES].sort());
  });

  it('names every template evidence kind', () => {
    expect(Object.keys(TEMPLATE_EVIDENCE_PRESENT).sort()).toEqual(
      [...TEMPLATE_EVIDENCE_KINDS].sort(),
    );
  });

  it('names every known-unknown kind, and decides for each whether it counts', () => {
    expect(Object.keys(KNOWN_UNKNOWN_PRESENT).sort()).toEqual([...KNOWN_UNKNOWN_KINDS].sort());
    // The second record is the load-bearing one: a new kind that nobody decided
    // about would either inflate or flatter the lower bound by default.
    expect(Object.keys(COUNTS_TOWARD_LOWER_BOUND).sort()).toEqual([...KNOWN_UNKNOWN_KINDS].sort());
  });

  it('names every offer outcome and stop reason', () => {
    expect(Object.keys(OFFER_OUTCOME_PRESENT).sort()).toEqual([...OFFER_OUTCOMES].sort());
    expect(Object.keys(CRAWL_STOP_REASON_PRESENT).sort()).toEqual([...CRAWL_STOP_REASONS].sort());
  });

  it('gives every plan a crawl ceiling', () => {
    // A new plan with no ceiling would fall through to `undefined` and every
    // comparison against it is false — a cap that silently stops applying.
    expect(Object.keys(PLAN_CRAWL_CEILINGS).sort()).toEqual([...PLANS].sort());
  });
});

// ─── 1. URL canonicalisation ────────────────────────────────────────────────

describe('canonicaliseUrl folds a URL to the place it points at', () => {
  it('strips the tracking parameters the policy names', () => {
    const result = canonicaliseUrl(`${BASE}/products?utm_source=a&gclid=b&sort=price`, {
      policy: policy(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonical.url).toBe(`${BASE}/products?sort=price`);
    expect(result.canonical.applied).toContain('STRIPPED_IGNORED_PARAMS');
    // The fold is auditable: a customer asking why two links are one page gets
    // the values that were dropped, not a shrug.
    expect(result.canonical.dropped).toEqual([
      { name: 'utm_source', value: 'a' },
      { name: 'gclid', value: 'b' },
    ]);
  });

  it('makes two inbound links with different tracking one identity', () => {
    // THE DEFECT: `?utm_source=twitter` and `?utm_source=email` are the same
    // state, and today they are two nodes that each eat a page of the budget.
    expect(canonical(`${BASE}/pricing?utm_source=twitter`)).toBe(
      canonical(`${BASE}/pricing?utm_source=email`),
    );
  });

  it('orders the query, so ?b=2&a=1 and ?a=1&b=2 are one place', () => {
    expect(canonical(`${BASE}/s?b=2&a=1`)).toBe(canonical(`${BASE}/s?a=1&b=2`));
    expect(canonical(`${BASE}/s?b=2&a=1`)).toBe(`${BASE}/s?a=1&b=2`);
  });

  it('keeps every value of a repeated parameter', () => {
    // `?tag=a&tag=b` is a different filter from `?tag=a`; deduplicating would
    // merge two states and lose one.
    expect(canonical(`${BASE}/s?tag=a&tag=b`)).not.toBe(canonical(`${BASE}/s?tag=a`));
  });

  it('keeps page one and buckets the tail into a single identity', () => {
    const first = canonical(`${BASE}/orders?page=1`);
    const second = canonical(`${BASE}/orders?page=2`);
    const far = canonical(`${BASE}/orders?page=397`);
    expect(first).toBe(`${BASE}/orders?page=1`);
    // Pages 2..N are one thing to test: the route, the forms and the assertions
    // are identical and only the rows differ.
    expect(second).toBe(far);
    expect(second).toBe(`${BASE}/orders?page=%3An`);
    expect(first).not.toBe(second);
  });

  it('buckets an opaque cursor, which otherwise never terminates', () => {
    expect(canonical(`${BASE}/feed?cursor=eyJpZCI6MX0`)).toBe(
      canonical(`${BASE}/feed?cursor=eyJpZCI6OTk5fQ`),
    );
  });

  it('normalises the parts of a URL that are not significant', () => {
    expect(canonical('https://APP.test:443/orders/')).toBe(`${BASE}/orders`);
    expect(canonical(`${BASE}/docs/index.html`)).toBe(`${BASE}/docs`);
  });

  it('keeps path case, which IS significant', () => {
    // `/Orders` and `/orders` are two routes on any case-sensitive server, and
    // merging them hides one of them from the denominator.
    expect(canonical(`${BASE}/Orders`)).not.toBe(canonical(`${BASE}/orders`));
  });

  it('is idempotent, so a caller may canonicalise twice', () => {
    /*
     * This matters at the integration seam. `crawl/harvest.ts` canonicalises a
     * harvested href before handing it on, and `CrawlFrontier.offer` then
     * canonicalises whatever it is given — so every URL goes through this
     * function twice. A second pass that re-bucketed `page=:n` into something
     * else, or re-sorted an already-sorted query differently, would mint a
     * second identity for a page already visited and count it twice.
     */
    for (const raw of [
      `${BASE}/orders?page=397&utm_source=x`,
      `${BASE}/feed?cursor=abc`,
      `${BASE}/docs/index.html`,
      `${BASE}/#/orders/1001`,
      `${BASE}/s?b=2&a=1`,
    ]) {
      const once = canonical(raw);
      expect(canonical(once)).toBe(once);
    }
  });

  it('refuses a non-page URL with a reason, never a bare drop', () => {
    for (const href of [
      'mailto:sales@app.test',
      'tel:+15551234',
      'javascript:void(0)',
      'nonsense',
    ]) {
      const result = canonicaliseUrl(href, { policy: policy() });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.kind).toBe('UNSUPPORTED_SCHEME');
      expect(result.rule.length).toBeGreaterThan(0);
    }
  });
});

describe('hash routing, so a single-page app is not one node', () => {
  it('treats #/route as a route and #anchor as the same page', () => {
    // THE DEFECT: crawler.ts does `target.hash = ''`, so every one of these is
    // `/` and a hash-routed application enumerates as exactly ONE node with a
    // coverage percentage of 100%.
    const orders = canonical(`${BASE}/#/orders`);
    const order = canonical(`${BASE}/#/orders/1001`);
    const settings = canonical(`${BASE}/#/settings`);
    expect(new Set([orders, order, settings]).size).toBe(3);
    // An in-page anchor is NOT a state: twelve jump links on one page must not
    // become thirteen nodes, which would inflate the denominator instead.
    expect(canonical(`${BASE}/pricing#plans`)).toBe(canonical(`${BASE}/pricing`));
  });

  it('never merges a hash route with the server route of the same name', () => {
    expect(canonical(`${BASE}/#/orders/1001`)).not.toBe(canonical(`${BASE}/orders/1001`));
  });

  it('obeys IGNORE and ROUTE when the application is known', () => {
    expect(canonical(`${BASE}/#/orders`, 'IGNORE')).toBe(`${BASE}/`);
    // ROUTE is for an app whose fragments are all routes, anchors included.
    expect(canonical(`${BASE}/page#section`, 'ROUTE')).toBe(`${BASE}/page#/section`);
  });

  it('puts the hash route on the route path behind a # segment', () => {
    const result = canonicaliseUrl(`${BASE}/app/#/orders/1001`, { policy: policy() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonical.routePath).toBe('/app/#/orders/1001');
    expect(result.canonical.hashRoute).toBe('/orders/1001');
  });
});

// ─── 2. Route-template inference ────────────────────────────────────────────

describe('inferRouteTemplates reads the SET of paths, not one path in isolation', () => {
  it('leaves /oauth2/authorize alone', () => {
    /*
     * THE DEFECT, exactly: `normaliseRoute('/oauth2/authorize')` returns
     * '/:id/authorize', because "oauth2" has a digit, has letters and is longer
     * than three characters. Two unrelated routes merge, and a merge SHRINKS
     * the denominator.
     */
    const inferred = inferRouteTemplates(['/oauth2/authorize', '/oauth2/token']);
    expect(inferred.templates.map((template) => template.template).sort()).toEqual([
      '/oauth2/authorize',
      '/oauth2/token',
    ]);
  });

  it('leaves /404 and /500 alone', () => {
    // `normaliseRoute('/404')` returns '/:id': the error page becomes a route
    // template and every 404 the crawl hits joins it.
    const inferred = inferRouteTemplates(['/404', '/500', '/home']);
    expect(inferred.templates.map((template) => template.template).sort()).toEqual([
      '/404',
      '/500',
      '/home',
    ]);
  });

  it('leaves /404 alone even surrounded by real numeric siblings', () => {
    /*
     * The case above passes for the wrong reason on its own — '/500' and
     * '/home' are reserved too, so there is no unreserved sibling to collapse
     * with. Mutation M2 (deleting '404' from RESERVED_SEGMENTS) left it green.
     * This is the production situation: a crawl of a numeric-id app hits the
     * error page, and without the reserved vocabulary the error page joins the
     * id template and every 404 afterwards is counted as a covered record.
     */
    const inferred = inferRouteTemplates(['/404', '/1001', '/1002']);
    expect(inferred.templates.map((template) => template.template).sort()).toEqual([
      '/404',
      '/:id',
    ]);
  });

  it('never builds a template from a single path', () => {
    // The rule that makes the two cases above safe in general: with no sibling
    // there is no evidence, and shape alone is what produced `/:id/authorize`.
    const inferred = inferRouteTemplates(['/orders/1001']);
    expect(inferred.templates.map((template) => template.template)).toEqual(['/orders/1001']);
  });

  it('collapses numeric siblings and carries the evidence', () => {
    const inferred = inferRouteTemplates(['/orders/1001', '/orders/1002', '/orders/1003']);
    expect(inferred.templates).toHaveLength(1);
    const template = inferred.templates[0];
    expect(template?.template).toBe('/orders/:id');
    // The count is the auditable part: a reader can see three instances
    // collapsed, which is what makes the inference checkable rather than magic.
    expect(template?.instances).toBe(3);
    expect(template?.parameters[0]?.evidence).toBe('ID_SHAPE_SIBLINGS');
    expect(template?.parameters[0]?.distinctValues).toBe(3);
    expect(template?.parameters[0]?.sample).toContain('1001');
  });

  it('keeps /orders/new out of /orders/:id', () => {
    // A Rails-shaped app serves the FORM at /orders/new and a record at
    // /orders/1001. Collapsing them loses the only page of the pair with a form.
    const inferred = inferRouteTemplates(['/orders/new', '/orders/1001', '/orders/1002']);
    expect(inferred.templates.map((template) => template.template).sort()).toEqual([
      '/orders/:id',
      '/orders/new',
    ]);
  });

  it('collapses slug siblings once there are enough of them', () => {
    // THE OTHER DEFECT: today these stay distinct, so a catalogue of 10,000
    // products is 10,000 routes and the page budget is spent inside one
    // template while real routes stay unreached.
    const inferred = inferRouteTemplates([
      '/products/blue-widget',
      '/products/red-widget',
      '/products/green-widget',
      '/products/steel-bolt',
      '/products/brass-nut',
    ]);
    expect(inferred.templates).toHaveLength(1);
    expect(inferred.templates[0]?.template).toBe('/products/:slug');
    expect(inferred.templates[0]?.parameters[0]?.evidence).toBe('SIBLING_CARDINALITY');
    expect(inferred.templates[0]?.instances).toBe(5);
  });

  it('discloses a family it declined to collapse instead of guessing', () => {
    /*
     * Two values is not evidence either way: /settings/profile and
     * /settings/billing are two routes, /products/blue-widget and
     * /products/red-widget are probably one template. So neither is collapsed
     * and the undecided family is REPORTED — a reader can see the route count
     * might be 2 instead of 1, rather than trusting a threshold nobody
     * mentioned.
     */
    const inferred = inferRouteTemplates(['/things/blue-widget', '/things/red-widget']);
    expect(inferred.templates.map((template) => template.template).sort()).toEqual([
      '/things/blue-widget',
      '/things/red-widget',
    ]);
    expect(inferred.unresolved).toHaveLength(1);
    expect(inferred.unresolved[0]?.pattern).toBe('/things/*');
    expect(inferred.unresolved[0]?.distinctValues).toBe(2);
    expect(inferred.unresolved[0]?.sample).toEqual(['blue-widget', 'red-widget']);
    expect(inferred.unresolved[0]?.why).toContain('below the');
  });

  it('collapses an unambiguous id on one instance, because no route is a uuid', () => {
    const inferred = inferRouteTemplates([
      '/users/550e8400-e29b-41d4-a716-446655440000',
      '/sessions/ORD-1001',
    ]);
    expect(inferred.templates.map((template) => template.template).sort()).toEqual([
      '/sessions/:id',
      '/users/:id',
    ]);
    for (const template of inferred.templates) {
      expect(template.parameters[0]?.evidence).toBe('UNAMBIGUOUS_ID_SHAPE');
    }
  });

  it('finds BOTH parameters of a two-parameter template', () => {
    /*
     * These two paths differ in two positions, so a sibling key built from
     * literals would never pair them and neither position would ever collect a
     * second value. The id mask in `familyKey` is what makes this work at all.
     */
    const inferred = inferRouteTemplates(['/orders/1001/items/5', '/orders/1002/items/7']);
    expect(inferred.templates).toHaveLength(1);
    expect(inferred.templates[0]?.template).toBe('/orders/:id/items/:id2');
    expect(inferred.templates[0]?.parameters).toHaveLength(2);
  });

  it('never parameterises an api version', () => {
    const inferred = inferRouteTemplates(['/api/v1/users', '/api/v2/users', '/api/v3/users']);
    expect(inferred.templates.map((template) => template.template).sort()).toEqual([
      '/api/v1/users',
      '/api/v2/users',
      '/api/v3/users',
    ]);
  });

  it('gives the same answer whatever order the paths arrive in', () => {
    // A non-deterministic template set makes the FlowMap undiffable, and
    // diffing versions is a shipped feature.
    const paths = [
      '/orders/1001',
      '/products/blue-widget',
      '/orders/new',
      '/products/red-widget',
      '/orders/1002',
      '/products/green-widget',
      '/products/steel-bolt',
      '/products/brass-nut',
    ];
    const forwards = inferRouteTemplates(paths);
    const backwards = inferRouteTemplates([...paths].reverse());
    expect(backwards.templates).toEqual(forwards.templates);
  });

  it('reports the threshold it applied', () => {
    expect(inferRouteTemplates([]).cardinalityThreshold).toBe(
      DEFAULT_TEMPLATE_CARDINALITY_THRESHOLD,
    );
    // A nonsense threshold falls back rather than disabling the rule, which a
    // zero would do silently.
    expect(inferRouteTemplates([], { cardinalityThreshold: 0 }).cardinalityThreshold).toBe(
      DEFAULT_TEMPLATE_CARDINALITY_THRESHOLD,
    );
    expect(inferRouteTemplates([], { cardinalityThreshold: 3 }).cardinalityThreshold).toBe(3);
  });
});

// ─── 3. The budget ──────────────────────────────────────────────────────────

describe('resolveCrawlBudget is validated, configurable and disclosed', () => {
  it('defaults to a budget far larger than the hard-coded 60', () => {
    const budget = budgetFor();
    // The numbers in crawler.ts (60 pages, depth 6) were a "make the demo
    // finish" decision and are why a 412-route app reports a percentage over
    // one seventh of itself.
    expect(budget.limits.pageBudget).toBe(1_000);
    expect(budget.limits.maxDepth).toBe(12);
    expect(budget.clamped).toEqual([]);
    // Null and {} stay distinguishable: one environment never decided, the
    // other decided to accept every default.
    expect(budget.policy.defaulted).toBe(true);
    expect(resolveCrawlBudget({ plan: 'TEAM', storedPolicy: {} }).policy.defaulted).toBe(false);
  });

  it('clamps to the plan ceiling and says so with both numbers', () => {
    const budget = budgetFor({ plan: 'FREE' });
    expect(budget.limits.pageBudget).toBe(PLAN_CRAWL_CEILINGS.FREE.pageBudget);
    const clamp = budget.clamped.find((entry) => entry.field === 'pageBudget');
    // A clamp applied without being disclosed is a cap that silently flatters
    // the percentage; this is the disclosure.
    expect(clamp?.requested).toBe(1_000);
    expect(clamp?.applied).toBe(100);
    expect(clamp?.cap).toBe('PAGE_BUDGET');
    expect(clamp?.why).toContain('FREE');
  });

  it('does not clamp a policy that fits the plan', () => {
    const budget = budgetFor({ plan: 'ENTERPRISE', storedPolicy: { pageBudget: 90_000 } });
    expect(budget.limits.pageBudget).toBe(90_000);
    expect(budget.clamped).toEqual([]);
  });

  it('keeps a cap applying when the column holds a string', () => {
    /*
     * A JSONB `pageBudget: "50"` would otherwise put a STRING where the crawl
     * compares a number, and `visited >= "50"` is false for every crawl that
     * will ever run — a cap that stops applying, which is the worst direction
     * for this field to fail in. `resolveCrawlPolicy` type-checks per field.
     */
    const budget = budgetFor({ storedPolicy: { pageBudget: '50' } });
    expect(budget.limits.pageBudget).toBe(1_000);
    expect(budget.policy.overridden).not.toContain('pageBudget');
  });

  it('reports an unusable override rather than swallowing it', () => {
    const budget = budgetFor({ overrides: { workers: 0 } });
    expect(budget.limits.workers).toBe(4);
    expect(budget.rejected).toEqual([
      { field: 'workers', value: 0, why: 'not a positive integer — the default stands' },
    ]);
  });

  it('reports an unknown key in the stored policy', () => {
    const budget = budgetFor({ storedPolicy: { pageBudget: 10, maxPagez: 7 } });
    expect(budget.policy.unknownKeys).toEqual(['maxPagez']);
  });
});

// ─── 4. The frontier, its admissions and its ledgers ───────────────────────

describe('the frontier admits, refuses and records', () => {
  it('queues a seed and hands it back', () => {
    const frontier = frontierFor();
    expect(frontier.seed(`${BASE}/`).kind).toBe('ACCEPTED');
    expect(frontier.pendingCount).toBe(1);
    const entry = frontier.take();
    expect(entry?.url).toBe(`${BASE}/`);
    expect(entry?.depth).toBe(0);
    expect(entry?.discoveredVia).toBe('SEED');
    expect(frontier.pendingCount).toBe(0);
  });

  it('treats a second offer of the same place as one place', () => {
    const { frontier, root } = seeded();
    expect(frontier.offer({ url: '/orders?utm_source=a', via: 'LINK' }, root).kind).toBe(
      'ACCEPTED',
    );
    // Same place after canonicalisation, so it costs nothing and is not queued
    // twice — the budget is spent on distinct states.
    expect(frontier.offer({ url: '/orders?utm_source=b', via: 'LINK' }, root).kind).toBe(
      'DUPLICATE',
    );
    expect(frontier.pendingCount).toBe(1);
  });

  it('refuses a session-ending path and names the rule that refused it', () => {
    const { frontier, root } = seeded();
    const outcome = frontier.offer({ url: '/logout', via: 'LINK' }, root);
    expect(outcome.kind).toBe('REFUSED_BY_POLICY');
    const excluded = frontier.excluded();
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.kind).toBe('SESSION_ENDING');
    // The rule is a line a human can look up in the environment's policy, not a
    // dumped regex: a refusal with no rule is the defect this ledger exists for.
    expect(excluded[0]?.rule).toBe('excludeGlobs: /logout');
    expect(excluded[0]?.discoveredFrom).toBe(`${BASE}/`);
    expect(excludedPathSchema.parse(excluded[0])).toBeTruthy();
  });

  it('records a refused URL once however many pages link to it', () => {
    const { frontier, root } = seeded();
    for (let index = 0; index < 50; index += 1) {
      frontier.offer({ url: '/logout', via: 'LINK' }, root);
    }
    // "31 URLs refused" is the number a customer wants; "1,400 links ignored"
    // is noise that hides it.
    expect(frontier.excluded()).toHaveLength(1);
  });

  it('classifies a destructive refusal apart from a session-ending one', () => {
    const { frontier, root } = seeded();
    frontier.offer({ url: '/logout', via: 'LINK' }, root);
    frontier.offer({ url: '/delete-account', via: 'LINK' }, root);
    expect(
      frontier
        .excluded()
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(['DESTRUCTIVE', 'SESSION_ENDING']);
    expect(refusalSummary(frontier.excluded())).toEqual([
      '1 URL(s) looks destructive',
      '1 URL(s) would end the session',
    ]);
  });

  it('refuses everything outside an include list and says which rule did it', () => {
    const { frontier, root } = seeded({ storedPolicy: { includeGlobs: ['/', '/app/**'] } });
    expect(frontier.offer({ url: '/app/orders', via: 'LINK' }, root).kind).toBe('ACCEPTED');
    expect(frontier.offer({ url: '/marketing', via: 'LINK' }, root).kind).toBe('REFUSED_BY_POLICY');
    const refused = frontier.excluded().find((entry) => entry.url.endsWith('/marketing'));
    expect(refused?.kind).toBe('POLICY_NOT_INCLUDED');
  });

  it('records an off-origin link as a boundary, with the origin and not the query', () => {
    const { frontier, root } = seeded();
    const outcome = frontier.offer(
      {
        url: 'https://accounts.idp.test/authorize?tenant=acme&state=secret-token',
        via: 'LINK',
        referenceKind: 'REDIRECT',
      },
      root,
    );
    expect(outcome.kind).toBe('OFF_ORIGIN');
    const externals = frontier.externals();
    expect(externals).toHaveLength(1);
    expect(externals[0]?.origin).toBe('https://accounts.idp.test');
    // Origin and PATH only. A redirect to an identity provider carries a state
    // token, and a flow map is stored, rendered and exported on request.
    expect(externals[0]?.samplePath).toBe('/authorize');
    expect(JSON.stringify(externals[0])).not.toContain('secret-token');
    expect(externalBoundarySchema.parse(externals[0])).toBeTruthy();
  });

  it('counts how often a boundary was referenced but the URLs only once', () => {
    const { frontier, root } = seeded();
    for (let index = 0; index < 3; index += 1) {
      frontier.offer({ url: 'https://idp.test/authorize', via: 'LINK' }, root);
    }
    expect(frontier.externals()[0]?.occurrences).toBe(3);
    expect(
      frontier.account().components.find((component) => component.kind === 'OFF_ORIGIN')?.count,
    ).toBe(1);
  });

  it('follows an additional origin the policy calls part of the app', () => {
    const { frontier, root } = seeded({
      storedPolicy: { additionalOrigins: ['https://auth.app.test'] },
    });
    expect(frontier.offer({ url: 'https://auth.app.test/login', via: 'LINK' }, root).kind).toBe(
      'ACCEPTED',
    );
    // Not a suffix test: `evil-app.test` ends with `app.test`.
    expect(frontier.offer({ url: 'https://evilapp.test/login', via: 'LINK' }, root).kind).toBe(
      'OFF_ORIGIN',
    );
  });

  it('rescues a URL first seen past the depth limit', () => {
    /*
     * The same URL can be offered at depth 3 from a deep page and at depth 1
     * from the navigation bar. Treating the first sighting as a closed decision
     * would lose a page one click from the home page.
     */
    const { frontier, root } = seeded({ storedPolicy: { maxDepth: 1 } });
    const deep: FrontierEntry = { ...root, depth: 1 };
    expect(frontier.offer({ url: '/reports', via: 'LINK' }, deep).kind).toBe('BEYOND_DEPTH');
    expect(
      frontier.account().components.find((component) => component.kind === 'BEYOND_DEPTH')?.count,
    ).toBe(1);
    expect(frontier.offer({ url: '/reports', via: 'LINK' }, root).kind).toBe('ACCEPTED');
    // And it stops being counted as unreached, or the lower bound double-counts
    // a page that was in fact visited.
    expect(
      frontier.account().components.find((component) => component.kind === 'BEYOND_DEPTH')?.count,
    ).toBe(0);
  });

  it('enforces the per-template budget and discloses the count', () => {
    const { frontier, root } = seeded({ storedPolicy: { perTemplatePageBudget: 2 } });
    for (const id of [1001, 1002, 1003, 1004, 1005]) {
      frontier.offer({ url: `/orders/${id}`, via: 'LINK' }, root);
    }
    // Two admitted, three refused — and the three are a DISCLOSED fact with a
    // count, not a silent drop, because a silently trimmed template makes the
    // coverage percentage go up.
    expect(frontier.pendingCount).toBe(2);
    const bite = frontier.caps().find((cap) => cap.cap === 'PER_TEMPLATE_BUDGET');
    expect(bite?.bites).toBe(3);
    expect(bite?.discarded).toBe(3);
    expect(bite?.scope).toBe('/orders/:id');
    expect(bite?.limit).toBe(2);
    expect(capBiteSchema.parse(bite)).toBeTruthy();
  });

  it('does not let one template starve the frontier', () => {
    // The failure this prevents: a list page links to 10,000 records, the whole
    // page budget goes into `/orders/:id`, and `/settings` is never reached.
    const { frontier, root } = seeded({
      storedPolicy: { perTemplatePageBudget: 3, pageBudget: 10 },
    });
    for (let id = 1; id <= 200; id += 1) {
      frontier.offer({ url: `/orders/${1000 + id}`, via: 'LINK' }, root);
    }
    expect(frontier.offer({ url: '/settings', via: 'LINK' }, root).kind).toBe('ACCEPTED');
    expect(frontier.pending().some((entry) => entry.url.endsWith('/settings'))).toBe(true);
  });

  it('refuses an offer when the queue is full and says the queue did it', () => {
    const { frontier, root } = seeded({ overrides: { queueCapacity: 2 } });
    frontier.offer({ url: '/a', via: 'LINK' }, root);
    frontier.offer({ url: '/b', via: 'LINK' }, root);
    const outcome = frontier.offer({ url: '/c', via: 'LINK' }, root);
    expect(outcome.kind).toBe('QUEUE_FULL');
    expect(frontier.caps().find((cap) => cap.cap === 'QUEUE_SIZE')?.discarded).toBe(1);
  });

  it('charges a redirect to the template it actually landed on', () => {
    // Otherwise a login redirect spends `/orders/:id`'s budget on visits that
    // all saw the sign-in page.
    const { frontier, root } = seeded({ storedPolicy: { perTemplatePageBudget: 1 } });
    const outcome = frontier.offer({ url: '/orders/1001', via: 'LINK' }, root);
    expect(outcome.kind).toBe('ACCEPTED');
    const entry = frontier.take();
    expect(entry).not.toBeNull();
    if (entry === null) return;
    frontier.markVisited(entry, '/login');
    // The order template's budget was released, so a second order can be read.
    expect(frontier.offer({ url: '/orders/1002', via: 'LINK' }, root).kind).toBe('ACCEPTED');
  });

  it('orders the queue breadth-first and deterministically', () => {
    const { frontier, root } = seeded();
    for (const path of ['/c', '/a', '/b']) frontier.offer({ url: path, via: 'LINK' }, root);
    const first = frontier.take();
    expect(first).not.toBeNull();
    if (first === null) return;
    frontier.markVisited(first, '/c');
    frontier.offer({ url: '/c/deep', via: 'LINK' }, first);
    // Depth 1 before depth 2, and within a depth, discovery order — not
    // alphabetical and not completion order.
    expect(frontier.pending().map((entry) => entry.url)).toEqual([
      `${BASE}/a`,
      `${BASE}/b`,
      `${BASE}/c/deep`,
    ]);
  });
});

// ─── 4b. The round trip ─────────────────────────────────────────────────────

describe('the frontier survives being written down', () => {
  function populated(): CrawlFrontier {
    const { frontier, root } = seeded({ storedPolicy: { maxDepth: 1, perTemplatePageBudget: 1 } });
    // The root really is visited here: a resume has to remember that, or it
    // re-enumerates the page it started from and counts it twice.
    frontier.seed(`${BASE}/`);
    const taken = frontier.take();
    if (taken === null) throw new Error('seed did not queue');
    frontier.markVisited(taken, '/');
    frontier.offer({ url: '/a', via: 'LINK' }, root);
    frontier.offer({ url: '/orders/1001', via: 'LINK' }, root);
    frontier.offer({ url: '/orders/1002', via: 'LINK' }, root);
    frontier.offer({ url: '/logout', via: 'LINK' }, root);
    frontier.offer({ url: 'https://idp.test/authorize', via: 'LINK' }, root);
    const deep: FrontierEntry = { ...root, depth: 1 };
    frontier.offer({ url: '/too/deep', via: 'LINK' }, deep);
    return frontier;
  }

  it('round-trips through JSON unchanged', () => {
    const before = serialiseFrontier(populated());
    const reparsed = JSON.parse(JSON.stringify(before)) as typeof before;
    const restored = restoreFrontier(reparsed, {
      baseUrl: BASE,
      budget: budgetFor({ storedPolicy: { maxDepth: 1, perTemplatePageBudget: 1 } }),
    });
    expect(restored.warnings).toEqual([]);
    // Byte-identical, which is the only version of this claim worth making: a
    // resume that loses the visited set re-enumerates pages and counts them
    // twice, and a resume that loses the ledgers forgets what it refused.
    expect(serialiseFrontier(restored.frontier)).toEqual(before);
  });

  it('continues the leftover queue rather than starting again', () => {
    const snapshot = serialiseFrontier(populated());
    const { frontier } = restoreFrontier(snapshot, {
      baseUrl: BASE,
      budget: budgetFor({ storedPolicy: { maxDepth: 1, perTemplatePageBudget: 1 } }),
    });
    expect(frontier.pendingCount).toBe(snapshot.queue.length);
    expect(frontier.visitedCount).toBe(1);
    // The root was visited before the snapshot; offering it again is a
    // duplicate, not a second visit.
    expect(frontier.seed(`${BASE}/`).kind).toBe('DUPLICATE');
    // And the refusal is remembered, so the ledger does not grow on every resume.
    const root = snapshot.queue[0];
    expect(root).toBeDefined();
    if (root === undefined) return;
    expect(frontier.offer({ url: '/logout', via: 'LINK' }, root).kind).toBe('DUPLICATE');
    expect(frontier.excluded()).toHaveLength(1);
  });

  it('warns when the canonicalisation rules changed under it', () => {
    /*
     * Raising a page budget and resuming is the point of a persisted frontier,
     * so a changed budget is silent. A changed `ignoredQueryParams` is not:
     * every URL in the visited set was canonicalised under the old list, so the
     * crawl will re-visit pages it has seen and count them twice.
     */
    const snapshot = serialiseFrontier(populated());
    const restored = restoreFrontier(snapshot, {
      baseUrl: BASE,
      budget: budgetFor({ storedPolicy: { ignoredQueryParams: ['utm_source'] } }),
    });
    expect(restored.warnings.join(' ')).toContain('ignoredQueryParams');
    expect(restored.warnings.join(' ')).toContain('enumerated twice');
  });

  it('warns when restored against a different application', () => {
    const snapshot = serialiseFrontier(populated());
    const restored = restoreFrontier(snapshot, {
      baseUrl: 'https://other.test',
      budget: budgetFor(),
    });
    expect(restored.warnings.join(' ')).toContain('belongs to the other application');
  });

  it('says nothing about a budget that merely grew', () => {
    const snapshot = serialiseFrontier(populated());
    const restored = restoreFrontier(snapshot, {
      baseUrl: BASE,
      budget: budgetFor({
        storedPolicy: { maxDepth: 1, perTemplatePageBudget: 1, pageBudget: 9_000 },
      }),
    });
    expect(restored.warnings).toEqual([]);
  });
});

// ─── 5. The scheduler ───────────────────────────────────────────────────────

/** A clock and a sleep that move only when the test says so. */
function fakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  advance: (ms: number) => void;
} {
  let clock = 0;
  const slept: number[] = [];
  return {
    now: () => clock,
    sleep: async (millis: number) => {
      slept.push(millis);
      clock += millis;
    },
    slept,
    advance: (millis: number) => {
      clock += millis;
    },
  };
}

/** Yields control `count` times, so completion order is set by microtasks. */
async function ticks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe('scheduleCrawl runs visits in parallel and orders the RESULTS', () => {
  it('returns results in BFS order even when they finish backwards', async () => {
    const { frontier, root } = seeded();
    for (const path of ['/a', '/b', '/c']) frontier.offer({ url: path, via: 'LINK' }, root);
    const completion: string[] = [];
    // /c finishes first, /a last.
    const delay: Record<string, number> = { '/a': 6, '/b': 3, '/c': 0 };

    const schedule = await scheduleCrawl<string>({
      frontier,
      perOriginLimit: 4,
      visit: async (entry) => {
        const path = new URL(entry.url).pathname;
        await ticks(delay[path] ?? 0);
        completion.push(path);
        return { kind: 'VISITED', value: path, finalRoutePath: path };
      },
    });

    expect(completion).toEqual(['/c', '/b', '/a']);
    /*
     * And the results come back the other way round. This is the whole reason
     * the scheduler is its own function: version diffing is a shipped feature,
     * and a parallel crawl that emitted nodes in completion order would show
     * the entire graph as changed on every run.
     */
    expect(schedule.results.map((result) => result.value)).toEqual(['/a', '/b', '/c']);
    expect(schedule.stoppedBecause).toBe('CONVERGED');
  });

  it('holds the per-origin concurrency limit', async () => {
    /*
     * The visits are GATED — each one parks until this test releases it — so
     * the assertion is about how many the scheduler will hold open at once.
     * The first version of this test let the visits resolve on their own, and
     * every one of them had finished before the scheduler reacted to the first:
     * the limit was never under pressure, so a scheduler with no limit at all
     * would have passed it.
     */
    const frontier = frontierFor({ storedPolicy: { additionalOrigins: ['https://cdn.app.test'] } });
    const root: FrontierEntry = {
      url: `${BASE}/`,
      depth: 0,
      template: '/',
      budgetKey: '/',
      discoveredFrom: null,
      discoveredVia: 'SEED',
      order: [0],
    };
    for (const path of ['/a', '/b', '/c', '/d']) frontier.offer({ url: path, via: 'LINK' }, root);
    frontier.offer({ url: 'https://cdn.app.test/x', via: 'LINK' }, root);

    const gates = new Map<string, () => void>();
    const live = new Map<string, number>();
    const peak = new Map<string, number>();
    const schedule = scheduleCrawl<string>({
      frontier,
      perOriginLimit: 2,
      visit: async (entry) => {
        const origin = new URL(entry.url).origin;
        live.set(origin, (live.get(origin) ?? 0) + 1);
        peak.set(origin, Math.max(peak.get(origin) ?? 0, live.get(origin) ?? 0));
        await new Promise<void>((resolve) => gates.set(entry.url, resolve));
        live.set(origin, (live.get(origin) ?? 1) - 1);
        return { kind: 'VISITED', value: entry.url, finalRoutePath: new URL(entry.url).pathname };
      },
    });

    await ticks(5);
    // Four workers, four app.test pages queued — and only two are open, plus
    // the one on the other host.
    expect([...gates.keys()].sort()).toEqual([`${BASE}/a`, `${BASE}/b`, 'https://cdn.app.test/x']);
    expect(peak.get(BASE)).toBe(2);
    expect(live.get(BASE)).toBe(2);

    for (;;) {
      const open = [...gates.values()];
      if (open.length === 0) break;
      gates.clear();
      for (const release of open) release();
      await ticks(5);
    }
    const finished = await schedule;

    expect(finished.results).toHaveLength(5);
    // Never more than two at once on the app's own origin...
    expect(peak.get(BASE)).toBe(2);
    // ...and the second host was not starved by the first.
    expect(peak.get('https://cdn.app.test')).toBe(1);
  });

  it('waits out a politeness delay without losing a page', async () => {
    const { frontier, root } = seeded({ overrides: { workers: 1 } });
    for (const path of ['/a', '/b']) frontier.offer({ url: path, via: 'LINK' }, root);
    const clock = fakeClock();

    const schedule = await scheduleCrawl<string>({
      frontier,
      politenessMillis: 100,
      now: clock.now,
      sleep: clock.sleep,
      visit: async (entry) => ({ kind: 'VISITED', value: new URL(entry.url).pathname }),
    });

    // It slept rather than hammering the host, and it slept exactly as long as
    // the nearest entry needed.
    expect(clock.slept).toEqual([100]);
    // A `take` that dropped what it could not start would lose a page to the
    // delay and then report it as if it did not exist.
    expect(schedule.results.map((result) => result.value)).toEqual(['/a', '/b']);
  });

  it('stops at the page budget, visits no more than it, and counts the leftovers', async () => {
    const { frontier, root } = seeded({
      storedPolicy: { pageBudget: 2 },
      overrides: { workers: 2 },
    });
    for (const path of ['/a', '/b', '/c', '/d', '/e']) {
      frontier.offer({ url: path, via: 'LINK' }, root);
    }

    const schedule = await scheduleCrawl<string>({
      frontier,
      visit: async (entry) => ({ kind: 'VISITED', value: entry.url }),
    });

    expect(schedule.stoppedBecause).toBe('PAGE_BUDGET');
    // Exactly the budget: a page visited past the cap is a page the cap did not
    // actually bound, and the number would then mean nothing.
    expect(schedule.results).toHaveLength(2);
    expect(schedule.account.atLeastMoreUrls).toBe(3);
    expect(schedule.why).toContain('at least 3 more in-scope URL(s)');
    expect(schedule.why).not.toContain('converged');
  });

  it('stops at the wall clock', async () => {
    const { frontier, root } = seeded({
      storedPolicy: { wallClockMillis: 1_000 },
      overrides: { workers: 1 },
    });
    for (const path of ['/a', '/b', '/c']) frontier.offer({ url: path, via: 'LINK' }, root);
    const clock = fakeClock();

    const schedule = await scheduleCrawl<string>({
      frontier,
      now: clock.now,
      sleep: clock.sleep,
      visit: async (entry) => {
        clock.advance(600);
        return { kind: 'VISITED', value: entry.url };
      },
    });

    expect(schedule.stoppedBecause).toBe('WALL_CLOCK');
    expect(schedule.results).toHaveLength(2);
    expect(schedule.account.caps.find((cap) => cap.cap === 'WALL_CLOCK')?.discarded).toBe(1);
  });

  it('treats a visitor that throws as unreachable, not as a missing page', async () => {
    const { frontier, root } = seeded();
    frontier.offer({ url: '/boom', via: 'LINK' }, root);

    const schedule = await scheduleCrawl<string>({
      frontier,
      visit: async () => {
        throw new Error('net::ERR_CONNECTION_RESET');
      },
    });

    expect(schedule.unreachable).toHaveLength(1);
    expect(schedule.unreachable[0]?.reason).toContain('ERR_CONNECTION_RESET');
    // Unknown whether it exists, so it is NOT claimed as missing surface:
    // inventing a number in the alarming direction is the same sin as
    // inventing one in the flattering direction.
    expect(schedule.account.atLeastMoreUrls).toBe(0);
    expect(
      schedule.account.components.find((component) => component.kind === 'UNREACHABLE')?.count,
    ).toBe(1);
  });

  it('puts an aborted entry back and refuses to call that convergence', async () => {
    const { frontier, root } = seeded();
    for (const path of ['/a', '/b']) frontier.offer({ url: path, via: 'LINK' }, root);

    const schedule = await scheduleCrawl<string>({
      frontier,
      perOriginLimit: 1,
      visit: async (entry) =>
        entry.url.endsWith('/a')
          ? { kind: 'ABORT', reason: 'the site rate-limited the crawl' }
          : { kind: 'VISITED', value: entry.url },
    });

    expect(schedule.stoppedBecause).toBe('ABORTED');
    expect(schedule.why).toContain('rate-limited');
    // Never visited, so still unvisited surface, so still in the lower bound.
    expect(schedule.account.atLeastMoreUrls).toBe(2);
  });

  it('keeps the links found on the last page before the cap bit', async () => {
    const { frontier, root } = seeded({
      storedPolicy: { pageBudget: 1 },
      overrides: { workers: 1 },
    });
    frontier.offer({ url: '/a', via: 'LINK' }, root);

    const schedule = await scheduleCrawl<string>({
      frontier,
      visit: async (entry) => ({
        kind: 'VISITED',
        value: entry.url,
        finalRoutePath: '/a',
        discovered: [
          { url: '/a/one', via: 'LINK' },
          { url: '/a/two', via: 'LINK' },
        ] satisfies OfferedCandidate[],
      }),
    });

    expect(schedule.stoppedBecause).toBe('PAGE_BUDGET');
    // Dropping them would make the cap look cheaper than it was.
    expect(schedule.account.atLeastMoreUrls).toBe(2);
    expect(schedule.account.caps.find((cap) => cap.cap === 'PAGE_BUDGET')?.discarded).toBe(2);
  });

  it('needs no browser at all', async () => {
    // The module's whole shape is this: the browser is an injected function, so
    // the traversal is testable without launching one. crawler.ts is the
    // counterexample it was written against.
    const { frontier, root } = seeded();
    frontier.offer({ url: '/only', via: 'LINK' }, root);
    const visits: VisitResult<number>[] = [{ kind: 'VISITED', value: 7, finalRoutePath: '/only' }];
    const schedule = await scheduleCrawl<number>({
      frontier,
      visit: async () => visits[0] ?? { kind: 'UNREACHABLE', reason: 'none left' },
    });
    expect(schedule.results.map((result) => result.value)).toEqual([7]);
  });
});

// ─── 6. The known-unknown account ───────────────────────────────────────────

describe('the account says what was not enumerated, and why', () => {
  it('writes a frontier the stored schema accepts', () => {
    const { frontier, root } = seeded({ storedPolicy: { maxDepth: 1, perTemplatePageBudget: 1 } });
    frontier.offer({ url: '/a', via: 'LINK' }, root);
    frontier.offer({ url: '/orders/1001', via: 'LINK' }, root);
    frontier.offer({ url: '/orders/1002', via: 'LINK' }, root);
    frontier.offer({ url: '/logout', via: 'LINK' }, root);
    frontier.offer({ url: 'https://idp.test/a', via: 'LINK' }, root);
    const deep: FrontierEntry = { ...root, depth: 1 };
    frontier.offer({ url: '/too/deep', via: 'LINK' }, deep);

    const account = frontier.account();
    /*
     * `frontierSchema` REFUSES any `atLeastMoreUrls` that is not
     * `unvisitedQueued + beyondDepth`, so this parse is the proof that the
     * writer did not invent the headline number — which is the one number this
     * whole slice exists to produce.
     */
    expect(frontierSchema.parse(account.frontier)).toBeTruthy();
    expect(account.frontier.atLeastMoreUrls).toBe(account.atLeastMoreUrls);
  });

  it('counts the four in-scope components and only those', () => {
    const { frontier, root } = seeded({ storedPolicy: { maxDepth: 1, perTemplatePageBudget: 1 } });
    frontier.offer({ url: '/a', via: 'LINK' }, root); // queued
    frontier.offer({ url: '/orders/1001', via: 'LINK' }, root); // queued
    frontier.offer({ url: '/orders/1002', via: 'LINK' }, root); // template overflow
    frontier.offer({ url: '/logout', via: 'LINK' }, root); // refused
    frontier.offer({ url: 'https://idp.test/a', via: 'LINK' }, root); // off-origin
    const deep: FrontierEntry = { ...root, depth: 1 };
    frontier.offer({ url: '/too/deep', via: 'LINK' }, deep); // beyond depth

    const account = frontier.account();
    const counts = new Map(
      account.components.map((component) => [component.kind, component.count]),
    );
    expect(counts.get('UNVISITED_QUEUED')).toBe(2);
    expect(counts.get('TEMPLATE_OVERFLOW')).toBe(1);
    expect(counts.get('BEYOND_DEPTH')).toBe(1);
    expect(counts.get('REFUSED_BY_POLICY')).toBe(1);
    expect(counts.get('OFF_ORIGIN')).toBe(1);
    // 2 queued + 1 template overflow + 1 beyond depth. The refused URL is known
    // BY NAME in the ledger, so it is not part of "more existed"; the
    // off-origin URL is not this application's surface at all.
    expect(account.atLeastMoreUrls).toBe(4);
  });

  it('keeps a refused URL and a nonexistent URL apart', () => {
    const { frontier, root } = seeded();
    frontier.offer({ url: '/logout', via: 'LINK' }, root);
    const account = frontier.account();
    // The refused one is nameable, with the rule that refused it...
    expect(account.excluded.map((entry) => entry.url)).toEqual([`${BASE}/logout`]);
    expect(account.excluded[0]?.rule).toContain('excludeGlobs');
    // ...and it is not in the lower bound, which is where "we do not know what
    // is there" lives. A URL the application does not serve appears in neither.
    expect(account.atLeastMoreUrls).toBe(0);
    expect(
      account.components.find((component) => component.kind === 'REFUSED_BY_POLICY')
        ?.countsTowardLowerBound,
    ).toBe(false);
  });

  it('reports a zero rather than omitting a component', () => {
    const { frontier } = seeded();
    const account = frontier.account();
    // Absent reads as "we did not account for it"; zero reads as "we looked and
    // there was none". A reporter that cannot tell them apart will claim a
    // complete enumeration on behalf of a 60-page crawl.
    expect(account.components).toHaveLength(KNOWN_UNKNOWN_KINDS.length);
    for (const component of account.components) expect(component.count).toBe(0);
    expect(account.atLeastMoreUrls).toBe(0);
  });

  it('lets exactly one terminal cap claim the leftover queue', () => {
    const { frontier, root } = seeded();
    for (const path of ['/a', '/b', '/c']) frontier.offer({ url: path, via: 'LINK' }, root);
    frontier.noteTerminalCap('PAGE_BUDGET');
    frontier.noteTerminalCap('WALL_CLOCK');
    /*
     * `discardedByCaps` SUMS `discarded` across the ledger. Two caps claiming
     * the same three URLs would make that sum six — a number inflated in the
     * alarming direction, which this module treats as exactly as bad as
     * flattering one.
     */
    expect(frontier.caps().filter((cap) => cap.bites > 0)).toHaveLength(1);
    expect(discardedByCaps(frontier.caps())).toBe(3);
  });

  it('carries the plan clamp even when it never bit', () => {
    const { frontier } = seeded({ plan: 'FREE' });
    const account = frontier.account();
    // "This crawl was allowed 100 pages" belongs beside the number whether or
    // not the application had more than 100 — but it is not a cap that BIT, so
    // it is not in the cap ledger pretending to be a caveat.
    expect(account.clamps.some((clamp) => clamp.field === 'pageBudget')).toBe(true);
    expect(account.caps.filter((cap) => cap.bites > 0)).toEqual([]);
  });

  it('carries the template inference into the account', () => {
    const { frontier, root } = seeded();
    for (const id of [1001, 1002, 1003]) {
      frontier.offer({ url: `/orders/${id}`, via: 'LINK' }, root);
    }
    const account = frontier.account();
    const orders = account.templates.templates.find(
      (template) => template.template === '/orders/:id',
    );
    // So the report can say "3 instances collapsed into /orders/:id" rather
    // than asking a reader to trust the number.
    expect(orders?.instances).toBe(3);
    expect(orders?.parameters[0]?.evidence).toBe('ID_SHAPE_SIBLINGS');
  });

  it('marks the sample truncated only when it really is', () => {
    const small = seeded();
    for (const path of ['/a', '/b']) small.frontier.offer({ url: path, via: 'LINK' }, small.root);
    // Two pending, two in the sample: nothing was left out.
    expect(small.frontier.account().frontier.sampleTruncated).toBe(false);

    const big = seeded();
    for (let index = 0; index < 20; index += 1) {
      big.frontier.offer({ url: `/p${index}`, via: 'LINK' }, big.root);
    }
    expect(big.frontier.account().frontier.sampleTruncated).toBe(true);
    expect(frontierSchema.parse(big.frontier.account().frontier)).toBeTruthy();
  });
});
