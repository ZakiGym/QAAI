import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRAWL_POLICY,
  EMPTY_FRONTIER,
  FORM_FIELD_SEMANTICS,
  type FlowMap,
  type FormField,
  accessCoverage,
  adjudicateCrawl,
  capsThatBit,
  discardedByCaps,
  enumerationOutcome,
  exclusionsByRule,
  frontierIsConsistent,
  isOwnOrigin,
  lowerBoundMoreUrls,
  matchesGlob,
  policyDecision,
  resolveCrawlPolicy,
  selectFlowMap,
  shouldGenerateAgainst,
  statusClassFor,
} from './flow-map';
import {
  capBiteSchema,
  crawlAcceptanceSchema,
  crawlPolicySchema,
  excludedPathSchema,
  externalBoundarySchema,
  flowMapProvenanceSchema,
  frontierSchema,
  nodeStatusSchema,
  routeAccessSchema,
  updateCrawlPolicySchema,
} from './schemas';
import { fillForm, syntheticValue } from './synthetic';

/**
 * The compatibility test for the constraint capture added to `FormField`.
 *
 * A FlowMap is STORED. Every crawl made before today sits in a database as JSON
 * with no `maxLength`, no `pattern`, no `inputMode` — so the new members have to
 * be optional in a way that is true at runtime and not merely true in the type
 * system. The risk is not that TypeScript complains; it is that a consumer
 * written against the new shape reads `field.maxLength`, gets `undefined`, and
 * either crashes or — worse — treats "nobody looked" as "the page declares no
 * limit" and reports a finding about a crawl that never recorded one.
 *
 * So this file parses a frozen pre-change FlowMap from a JSON STRING, exactly
 * as the API would off the wire, and runs the new consumers over it.
 */

/**
 * A FlowMap in the shape this repo produced before constraint capture existed.
 *
 * Deliberately a string literal and not a typed object: a typed fixture would
 * be updated by whoever next changes the interface, and then it would stop
 * being a record of the old shape, which is the only thing it is for.
 */
const PRE_CONSTRAINTS_FLOW_MAP_JSON = `{
  "projectId": "prj_1",
  "environmentId": "env_1",
  "version": 3,
  "baseUrl": "https://shop.example.com",
  "nodes": [
    {
      "id": "node-0",
      "route": "/checkout",
      "url": "https://shop.example.com/checkout",
      "title": "Checkout",
      "stateKey": "Checkout/f1/rnone/populated",
      "requiresRoles": [],
      "behindAuth": false,
      "forms": [
        {
          "id": "form-0",
          "name": "POST /checkout",
          "selector": { "strategy": "CSS", "value": "form:nth-of-type(1)", "confidence": 0.5 },
          "fields": [
            {
              "name": "email",
              "label": "Email",
              "inputType": "email",
              "required": true,
              "selector": { "strategy": "LABEL", "value": "Email", "confidence": 0.9 },
              "semantic": "email"
            },
            {
              "name": "cardNumber",
              "label": "Card number",
              "inputType": "text",
              "required": true,
              "selector": { "strategy": "LABEL", "value": "Card number", "confidence": 0.9 },
              "semantic": "credit_card"
            },
            {
              "name": "country",
              "label": "Country",
              "inputType": "select",
              "required": false,
              "selector": { "strategy": "LABEL", "value": "Country", "confidence": 0.9 },
              "semantic": "country",
              "options": ["Select a country", "Portugal", "Japan"]
            }
          ],
          "submit": { "strategy": "ROLE", "value": "button", "name": "Place order", "confidence": 0.95 }
        }
      ],
      "affordances": [],
      "screenshotKey": null,
      "a11yViolationCount": 0
    }
  ],
  "edges": [],
  "journeys": [],
  "features": [{ "name": "Checkout", "nodeIds": ["node-0"] }],
  "exploredAt": "2026-01-04T10:00:00.000Z",
  "truncatedReason": null
}`;

describe('an old-shaped FlowMap still loads', () => {
  const flowMap = JSON.parse(PRE_CONSTRAINTS_FLOW_MAP_JSON) as FlowMap;
  const form = flowMap.nodes[0]?.forms[0];
  const fields = form?.fields ?? [];

  it('parses, with every pre-existing member intact', () => {
    expect(flowMap.version).toBe(3);
    expect(form?.id).toBe('form-0');
    expect(fields).toHaveLength(3);
    expect(fields[0]?.name).toBe('email');
    expect(fields[0]?.required).toBe(true);
    expect(fields[0]?.semantic).toBe('email');
    expect(fields[2]?.options).toEqual(['Select a country', 'Portugal', 'Japan']);
  });

  it('reports every new constraint as undefined — "nobody looked", not "nothing declared"', () => {
    // This is the distinction the whole optional-vs-null design exists for. A
    // consumer that cannot tell these apart will claim a pre-change crawl
    // declares no maxlength anywhere, which is a finding about the crawler
    // dressed up as a finding about the application.
    const field = fields[0] as FormField;
    for (const key of [
      'maxLength',
      'minLength',
      'min',
      'max',
      'step',
      'pattern',
      'inputMode',
      'autocomplete',
      'accept',
      'multiple',
      'validationMessage',
    ] as const) {
      expect(field[key], key).toBeUndefined();
    }
  });

  it('still produces valid synthetic values for every field', () => {
    const { values, notes } = fillForm(fields, { seed: 'run-old-map' });
    expect(values.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(values.cardNumber).toBe('4242424242424242');
    // The select's options survived the round trip, so the value is one of them
    // rather than a plausible country name the control does not offer.
    expect(['Portugal', 'Japan']).toContain(values.country);
    expect(notes).toEqual([]);
  });

  it('claims no honoured constraint it did not actually see', () => {
    const result = syntheticValue(fields[0] as FormField, { seed: 'run-old-map' });
    expect(result.honoured).toEqual([]);
    expect(result.unsatisfiable).toEqual([]);
  });
});

describe('FORM_FIELD_SEMANTICS', () => {
  it('keeps every name that predates the additions', () => {
    // These spellings travel in stored FlowMap JSON, so renaming one would
    // silently reclassify every field in every crawl already on disk.
    for (const name of [
      'email',
      'password',
      'person_name',
      'phone',
      'street_address',
      'city',
      'postal_code',
      'country',
      'credit_card',
      'card_expiry',
      'card_cvc',
      'date',
      'number',
      'search',
      'freeform',
      'unknown',
    ] as const) {
      expect(FORM_FIELD_SEMANTICS).toContain(name);
    }
  });

  it('adds the three that were missing', () => {
    expect(FORM_FIELD_SEMANTICS).toContain('url');
    expect(FORM_FIELD_SEMANTICS).toContain('username');
    expect(FORM_FIELD_SEMANTICS).toContain('currency');
  });

  it('has no duplicates', () => {
    expect(new Set(FORM_FIELD_SEMANTICS).size).toBe(FORM_FIELD_SEMANTICS.length);
  });

  it('is exhaustively handled by the synthetic factory', () => {
    // The guarantee that matters: a semantic added to the vocabulary without a
    // generator behind it would fall through to the 'unknown' branch and type
    // a meaningless token into a field, silently. This makes that a test
    // failure instead.
    for (const semantic of FORM_FIELD_SEMANTICS) {
      const result = syntheticValue({ name: `a_${semantic}`, semantic }, { seed: 'run-1' });
      expect(result.value, semantic).not.toBe('');
      if (semantic !== 'unknown') {
        expect(result.value, semantic).not.toMatch(/^qaai-[a-z0-9]{6}$/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Enumeration honesty
//
// Every test below pins a sentence this product is not allowed to say. The
// theme is one defect in several costumes: a truncated, refused, misattributed
// or degraded enumeration shrinks the DENOMINATOR while the numerator — the
// tests that already exist — does not, so the coverage percentage goes UP. Each
// of these asserts that the shrinking is recorded, counted and attributed
// instead.
// ─────────────────────────────────────────────────────────────────────────────

describe('an old-shaped FlowMap carries none of the honesty fields', () => {
  const flowMap = JSON.parse(PRE_CONSTRAINTS_FLOW_MAP_JSON) as FlowMap;

  it('reports every new member as undefined — "nobody accounted", not "nothing to account"', () => {
    // Same contract as the constraint capture above. A report reading
    // `caps: undefined` as "no cap bit" would claim a complete enumeration on
    // behalf of the 60-page crawl that produced this map.
    for (const key of [
      'policyApplied',
      'provenance',
      'acceptance',
      'caps',
      'frontier',
      'excluded',
      'externals',
    ] as const) {
      expect(flowMap[key], key).toBeUndefined();
    }
    expect(flowMap.nodes[0]?.status).toBeUndefined();
    expect(flowMap.nodes[0]?.access).toBeUndefined();
  });

  it('refuses to generate a happy-path test against a node with no recorded status', () => {
    /*
     * The most consequential default in this file. A node from a crawl that
     * predates status capture could be a 404 page, and assuming 200 re-creates
     * the original defect — a test asserting that a page which does not exist
     * loads correctly, which then PASSES against the error page forever — for
     * every flow map already on disk. The remedy is a re-crawl, which is cheap.
     */
    expect(shouldGenerateAgainst(flowMap.nodes[0]!)).toBe(false);
  });
});

describe('resolveCrawlPolicy', () => {
  it('applies the production-safe defaults when the environment never chose', () => {
    const applied = resolveCrawlPolicy(null);
    expect(applied.defaulted).toBe(true);
    expect(applied.overridden).toEqual([]);
    expect(applied.policy).toEqual(DEFAULT_CRAWL_POLICY);
    // The two that make it safe against a live application, whatever the caps.
    expect(applied.policy.safeMethodsOnly).toBe(true);
    expect(applied.policy.allowDestructive).toBe(false);
  });

  it('tells an environment that chose every default from one that never chose', () => {
    // `{}` is a decision somebody made and can be held to; null is not. The
    // panel needs to render those differently or it cannot show what anybody
    // actually configured.
    expect(resolveCrawlPolicy({}).defaulted).toBe(false);
    expect(resolveCrawlPolicy({}).overridden).toEqual([]);
  });

  it('names only the fields the row actually set', () => {
    const applied = resolveCrawlPolicy({ pageBudget: 50, excludeGlobs: ['/admin/**'] });
    expect(applied.overridden.sort()).toEqual(['excludeGlobs', 'pageBudget']);
    expect(applied.policy.pageBudget).toBe(50);
    expect(applied.policy.maxDepth).toBe(DEFAULT_CRAWL_POLICY.maxDepth);
  });

  it('ignores a wrongly-typed field rather than letting a cap stop applying', () => {
    /*
     * `pageBudget: "1000"` out of a JSONB column would reach
     * `nodes.length >= "1000"`, which is false for every crawl that will ever
     * run. A cap that silently stops applying is the worst direction for THIS
     * field to fail in: the crawl runs forever and nothing says why.
     */
    const applied = resolveCrawlPolicy({ pageBudget: '1000', maxDepth: -3 });
    expect(applied.policy.pageBudget).toBe(DEFAULT_CRAWL_POLICY.pageBudget);
    expect(applied.policy.maxDepth).toBe(DEFAULT_CRAWL_POLICY.maxDepth);
    expect(applied.overridden).toEqual([]);
  });

  it('reports a key it does not recognise instead of dropping it', () => {
    // An unknown field is either our bug or a downgrade from a newer build.
    // Both deserve a line in the report rather than a shrug.
    expect(resolveCrawlPolicy({ maxPages: 60 }).unknownKeys).toEqual(['maxPages']);
    expect(resolveCrawlPolicy('nope').unknownKeys).toEqual(['<not an object>']);
  });
});

describe('matchesGlob', () => {
  it('keeps * inside a segment and lets ** cross one', () => {
    expect(matchesGlob('/admin/*', '/admin/billing')).toBe(true);
    expect(matchesGlob('/admin/*', '/admin/billing/invoices')).toBe(false);
    expect(matchesGlob('/admin/**', '/admin/billing/invoices')).toBe(true);
  });

  it('matches ? against one character that is not a slash', () => {
    expect(matchesGlob('/a?c', '/abc')).toBe(true);
    expect(matchesGlob('/a?c', '/a/c')).toBe(false);
  });

  it('treats a regex metacharacter in the glob as a literal', () => {
    // A customer who types `/orders/:id` means that path, not a character
    // class. A glob dialect that leaked regex syntax would silently widen the
    // scope of a production crawl.
    expect(matchesGlob('/orders/:id', '/orders/:id')).toBe(true);
    expect(matchesGlob('/a.c', '/abc')).toBe(false);
  });
});

describe('policyDecision', () => {
  const policy = { ...DEFAULT_CRAWL_POLICY };

  it('refuses the session-ending and destructive defaults, and names the rule', () => {
    // The five patterns crawler.ts hard-codes today and drops with no record.
    // Here the rule travels with the refusal, so a refused route is finally
    // distinguishable from one the application does not serve.
    const logout = policyDecision(policy, '/logout');
    expect(logout.admitted).toBe(false);
    expect(logout.rule).toContain('excludeGlobs');
    expect(policyDecision(policy, '/delete-account').admitted).toBe(false);
    expect(policyDecision(policy, '/__reset').admitted).toBe(false);
  });

  it('admits an ordinary path', () => {
    expect(policyDecision(policy, '/orders/1001')).toEqual({
      admitted: true,
      rule: 'admitted',
    });
  });

  it('refuses everything outside a non-empty include list, and says which rule', () => {
    const scoped = { ...policy, includeGlobs: ['/admin/**'] };
    expect(policyDecision(scoped, '/pricing').rule).toContain('includeGlobs');
    expect(policyDecision(scoped, '/admin/users').admitted).toBe(true);
  });

  it('needs BOTH the flag and a pattern before it drives a destructive path', () => {
    /*
     * `allowDestructive` on its own grants nothing. "This environment is
     * disposable" is a different claim from "drive the logout link", and a
     * customer who flips the environment-wide switch must not silently acquire
     * permission to end their own session on every crawl.
     */
    expect(policyDecision({ ...policy, allowDestructive: true }, '/logout').admitted).toBe(false);
    expect(
      policyDecision({ ...policy, destructiveAllowGlobs: ['/logout'] }, '/logout').admitted,
    ).toBe(false);
    const both = policyDecision(
      { ...policy, allowDestructive: true, destructiveAllowGlobs: ['/logout'] },
      '/logout',
    );
    expect(both.admitted).toBe(true);
    expect(both.rule).toContain('overridden');
  });
});

describe('isOwnOrigin', () => {
  it('compares origins and not suffixes', () => {
    // `evil-example.com` ends with `example.com`. A suffix test here would
    // enumerate somebody else's site into our customer's denominator.
    expect(isOwnOrigin('https://app.example.com', 'https://app.example.com/x')).toBe(true);
    expect(isOwnOrigin('https://app.example.com', 'https://evil-example.com/x')).toBe(false);
    expect(isOwnOrigin('https://app.example.com', 'http://app.example.com/x')).toBe(false);
    expect(isOwnOrigin('https://app.example.com', 'https://app.example.com:8443/x')).toBe(false);
  });

  it('admits an origin the policy names as part of the same application', () => {
    const policy = { ...DEFAULT_CRAWL_POLICY, additionalOrigins: ['https://auth.example.com'] };
    expect(isOwnOrigin('https://app.example.com', 'https://auth.example.com/login', policy)).toBe(
      true,
    );
  });

  it('is false for a string that is not a URL', () => {
    expect(isOwnOrigin('https://app.example.com', 'mailto:a@b.c')).toBe(false);
    expect(isOwnOrigin('https://app.example.com', 'not a url')).toBe(false);
  });
});

describe('the frontier lower bound', () => {
  const frontier = {
    unvisitedQueued: 180,
    beyondDepth: 60,
    excluded: 31,
    offOrigin: 12,
    unreachable: 4,
    atLeastMoreUrls: 240,
    sample: ['https://a/1'],
    sampleTruncated: true,
  };

  it('counts the unknown and nothing else', () => {
    /*
     * The composition rule, and it is a judgement with a reason for every
     * exclusion. Refused URLs are KNOWN — they are named in the exclusion
     * ledger, so they are not part of "more existed". Off-origin URLs are not
     * this application's surface. Unreachable URLs are unknown-rather-than-
     * absent, and claiming them as missing surface would be inventing a number
     * in the alarming direction, which is the same sin as inventing one in the
     * flattering direction.
     */
    expect(lowerBoundMoreUrls(frontier)).toBe(240);
    expect(frontierIsConsistent(frontier)).toBe(true);
  });

  it('catches a stored bound a writer invented', () => {
    // The column is a FLOOR derived from URLs we actually held, not a number a
    // writer may choose. `frontierSchema` refuses the same thing on the wire.
    expect(frontierIsConsistent({ ...frontier, atLeastMoreUrls: 0 })).toBe(false);
  });

  it('is zero for an empty frontier', () => {
    expect(lowerBoundMoreUrls(EMPTY_FRONTIER)).toBe(0);
    expect(frontierIsConsistent(EMPTY_FRONTIER)).toBe(true);
  });
});

describe('capsThatBit', () => {
  const caps = [
    {
      cap: 'PAGE_BUDGET' as const,
      limit: 60,
      bites: 1,
      discarded: 240,
      scope: null,
      reason: 'stopped at the 60-page budget',
    },
    {
      cap: 'DEPTH' as const,
      limit: 6,
      bites: 0,
      discarded: 0,
      scope: null,
      reason: 'never reached',
    },
  ];

  it('reports only the caps that stopped something', () => {
    // A cap that did not bite is not a caveat, and listing it would bury the
    // one that did.
    expect(capsThatBit(caps).map((cap) => cap.cap)).toEqual(['PAGE_BUDGET']);
  });

  it('sums what the caps threw away', () => {
    expect(discardedByCaps(caps)).toBe(240);
  });
});

describe('enumerationOutcome', () => {
  const clean = {
    cap: 'DEPTH' as const,
    limit: 6,
    bites: 0,
    discarded: 0,
    scope: null,
    reason: '',
  };

  it('calls it CONVERGED only with an empty frontier AND no cap that bit', () => {
    expect(
      enumerationOutcome({ visitedPages: 412, frontier: EMPTY_FRONTIER, caps: [clean] }).outcome,
    ).toBe('CONVERGED');
  });

  it('refuses CONVERGED when a cap trimmed the surface, even with an empty queue', () => {
    /*
     * The sentence this whole type exists to make impossible. A crawl can empty
     * its queue while a per-template budget was dropping every instance of
     * `/orders/:id` — that is not convergence, it is convergence over a surface
     * we trimmed, and the two produce the same `nodes.length` with completely
     * different denominators.
     */
    const result = enumerationOutcome({
      visitedPages: 60,
      frontier: EMPTY_FRONTIER,
      caps: [
        {
          cap: 'PER_TEMPLATE_BUDGET',
          limit: 25,
          bites: 9_900,
          discarded: 9_900,
          scope: '/orders/:id',
          reason: 'per-template budget',
        },
      ],
    });
    expect(result.outcome).toBe('STOPPED');
    expect(result.why).toContain('9900 discarded');
  });

  it('says how many more URLs were known when it stopped', () => {
    const result = enumerationOutcome({
      visitedPages: 60,
      frontier: { ...EMPTY_FRONTIER, unvisitedQueued: 240, atLeastMoreUrls: 240 },
      caps: [],
    });
    expect(result.outcome).toBe('STOPPED');
    // Not "stopped early". A number.
    expect(result.why).toContain('at least 240 more in-scope URL(s)');
  });

  it('calls a crawl that loaded nothing FAILED, not CONVERGED', () => {
    // An empty frontier and no caps describe both a complete crawl of a
    // one-page site and a crawl of a site that was down.
    expect(
      enumerationOutcome({ visitedPages: 0, frontier: EMPTY_FRONTIER, caps: [] }).outcome,
    ).toBe('FAILED');
  });
});

describe('adjudicateCrawl', () => {
  const healthy = {
    nodeCount: 412,
    errorNodeCount: 3,
    loadFailureCount: 0,
    throttledCount: 0,
    expectedAuthButHitWall: false,
  };

  it('accepts a clean crawl with no reasons attached', () => {
    const verdict = adjudicateCrawl(healthy);
    expect(verdict.state).toBe('ACCEPTED');
    expect(verdict.reasons).toEqual([]);
    expect(verdict.degradations).toEqual([]);
  });

  it('rejects a crawl that enumerated nothing, so the previous map stands', () => {
    const verdict = adjudicateCrawl({ ...healthy, nodeCount: 0, loadFailureCount: 40 });
    expect(verdict.state).toBe('REJECTED');
    expect(verdict.degradations[0]?.kind).toBe('SITE_DOWN');
    expect(verdict.reasons.join(' ')).toContain('the previous one stands');
  });

  it('holds a rate-limited crawl as a candidate', () => {
    const verdict = adjudicateCrawl({ ...healthy, nodeCount: 40, throttledCount: 120 });
    expect(verdict.state).toBe('CANDIDATE');
    expect(verdict.degradations.map((d) => d.kind)).toContain('RATE_LIMITED');
  });

  it('holds a crawl that was logged out despite being given credentials', () => {
    // The commonest way a denominator collapses: the storageState expired, the
    // crawl enumerated the marketing site, and every authenticated route
    // vanished from the denominator while its tests stayed in the numerator.
    const verdict = adjudicateCrawl({ ...healthy, nodeCount: 9, expectedAuthButHitWall: true });
    expect(verdict.state).toBe('CANDIDATE');
    expect(verdict.degradations.map((d) => d.kind)).toContain('NOT_LOGGED_IN');
  });

  it('holds a crawl that collapsed against the last accepted one', () => {
    const verdict = adjudicateCrawl({
      ...healthy,
      nodeCount: 3,
      previous: { version: 8, nodeCount: 412 },
    });
    expect(verdict.state).toBe('CANDIDATE');
    expect(verdict.degradations.map((d) => d.kind)).toContain('SHRANK');
    expect(verdict.comparedToVersion).toBe(8);
    expect(verdict.previousNodeCount).toBe(412);
  });

  it('accepts a shrink inside the threshold — applications do lose routes', () => {
    // 412 → 300 is a 27% drop. Holding every shrink for review would make this
    // a mechanism people switch off; what it has to catch is the collapse.
    const verdict = adjudicateCrawl({
      ...healthy,
      nodeCount: 300,
      previous: { version: 8, nodeCount: 412 },
    });
    expect(verdict.state).toBe('ACCEPTED');
  });

  it('needs a strict majority of error pages before calling it degraded', () => {
    // `>=` would hold a candidate for every tiny application with a 404 test
    // fixture linked from its home page.
    expect(adjudicateCrawl({ ...healthy, nodeCount: 2, errorNodeCount: 1 }).state).toBe('ACCEPTED');
    expect(adjudicateCrawl({ ...healthy, nodeCount: 2, errorNodeCount: 2 }).state).toBe(
      'CANDIDATE',
    );
  });
});

describe('selectFlowMap', () => {
  const base = { createdAtIso: '2026-10-01T00:00:00.000Z' };

  it('matches the environment rather than preferring it', () => {
    /*
     * The defect in 13 of the 16 readers. A staging crawl is not a weaker
     * measurement of production, it is a measurement of something else —
     * different routes, different roles, different flags — so falling back to
     * it would compute a production coverage number over staging's surface.
     */
    const selection = selectFlowMap(
      [
        {
          ...base,
          id: 'staging-v9',
          version: 9,
          environmentId: 'env_staging',
          derivedFrom: 'CRAWL',
          acceptance: 'ACCEPTED',
        },
      ],
      { environmentId: 'env_prod' },
    );
    expect(selection.chosen).toBeNull();
    expect(selection.rejected[0]?.why).toContain('measures another application');
  });

  it('prefers an observed crawl over a newer source-derived map', () => {
    /*
     * `flowMapFromSource` writes a map derived from the REPOSITORY with its own
     * version number, so v9-from-source displaced v8-from-crawl and the
     * denominator became "whatever the route table says" — no forms, no states,
     * no affordances. A version is a sequence number, not evidence.
     */
    const selection = selectFlowMap(
      [
        {
          ...base,
          id: 'source-v9',
          version: 9,
          environmentId: 'env_prod',
          derivedFrom: 'SOURCE',
          acceptance: 'ACCEPTED',
        },
        {
          ...base,
          id: 'crawl-v8',
          version: 8,
          environmentId: 'env_prod',
          derivedFrom: 'CRAWL',
          acceptance: 'ACCEPTED',
        },
      ],
      { environmentId: 'env_prod' },
    );
    expect(selection.chosen?.id).toBe('crawl-v8');
    expect(selection.why).toContain('observed (CRAWL)');
  });

  it('never chooses a rejected map', () => {
    const selection = selectFlowMap(
      [
        {
          ...base,
          id: 'dead-v9',
          version: 9,
          environmentId: 'env_prod',
          derivedFrom: 'CRAWL',
          acceptance: 'REJECTED',
        },
      ],
      { environmentId: 'env_prod', allowCandidate: true },
    );
    expect(selection.chosen).toBeNull();
  });

  it('refuses a degraded crawl unless the caller asked for one', () => {
    const rows = [
      {
        ...base,
        id: 'degraded-v9',
        version: 9,
        environmentId: 'env_prod',
        derivedFrom: 'CRAWL' as const,
        acceptance: 'CANDIDATE' as const,
      },
    ];
    expect(selectFlowMap(rows, { environmentId: 'env_prod' }).chosen).toBeNull();

    const permitted = selectFlowMap(rows, { environmentId: 'env_prod', allowCandidate: true });
    expect(permitted.chosen?.id).toBe('degraded-v9');
    // And the caveat travels with the number rather than being swallowed.
    expect(permitted.why).toContain('rests on a degraded crawl');
  });

  it('prefers an accepted crawl over a newer candidate', () => {
    const selection = selectFlowMap(
      [
        {
          ...base,
          id: 'candidate-v9',
          version: 9,
          environmentId: 'env_prod',
          derivedFrom: 'CRAWL',
          acceptance: 'CANDIDATE',
        },
        {
          ...base,
          id: 'accepted-v8',
          version: 8,
          environmentId: 'env_prod',
          derivedFrom: 'CRAWL',
          acceptance: 'ACCEPTED',
        },
      ],
      { environmentId: 'env_prod', allowCandidate: true },
    );
    expect(selection.chosen?.id).toBe('accepted-v8');
  });

  it('ranks an unadjudicated legacy row between accepted and candidate', () => {
    // Null is not evidence of health and not evidence of degradation. Treating
    // it as either would be a claim about every map written before adjudication
    // existed.
    const selection = selectFlowMap(
      [
        {
          ...base,
          id: 'candidate-v9',
          version: 9,
          environmentId: 'env_prod',
          derivedFrom: 'CRAWL',
          acceptance: 'CANDIDATE',
        },
        {
          ...base,
          id: 'legacy-v7',
          version: 7,
          environmentId: 'env_prod',
          derivedFrom: null,
          acceptance: null,
        },
      ],
      { environmentId: 'env_prod', allowCandidate: true },
    );
    expect(selection.chosen?.id).toBe('legacy-v7');
    expect(selection.why).toContain('provenance not recorded');
  });

  it('prefers a clean declared map over a crawl that was explicitly held', () => {
    /*
     * The trade this ordering makes, pinned so nobody reverses it by accident.
     * CANDIDATE means "nothing measures against this", and provenance must not
     * overrule that marker. The displacement defect was a source map winning on
     * its VERSION NUMBER against a crawl nobody had a complaint about —
     * choosing it over a crawl we have adjudicated as degraded is a different
     * decision, and `why` says which one was made.
     */
    const selection = selectFlowMap(
      [
        {
          ...base,
          id: 'candidate-crawl-v9',
          version: 9,
          environmentId: 'env_prod',
          derivedFrom: 'CRAWL',
          acceptance: 'CANDIDATE',
        },
        {
          ...base,
          id: 'source-v2',
          version: 2,
          environmentId: 'env_prod',
          derivedFrom: 'SOURCE',
          acceptance: 'ACCEPTED',
        },
      ],
      { environmentId: 'env_prod', allowCandidate: true },
    );
    expect(selection.chosen?.id).toBe('source-v2');
    expect(selection.why).toContain('declared (SOURCE)');
  });

  it('falls back to the highest version among equals', () => {
    const selection = selectFlowMap(
      [
        {
          ...base,
          id: 'v7',
          version: 7,
          environmentId: 'env_prod',
          derivedFrom: 'CRAWL',
          acceptance: 'ACCEPTED',
        },
        {
          ...base,
          id: 'v9',
          version: 9,
          environmentId: 'env_prod',
          derivedFrom: 'CRAWL',
          acceptance: 'ACCEPTED',
        },
      ],
      { environmentId: 'env_prod' },
    );
    expect(selection.chosen?.id).toBe('v9');
    expect(selection.rejected).toEqual([{ id: 'v7', why: 'outranked by v9' }]);
  });

  it('says a declared map is all there is, rather than implying it is a crawl', () => {
    const selection = selectFlowMap(
      [
        {
          ...base,
          id: 'source-v1',
          version: 1,
          environmentId: 'env_prod',
          derivedFrom: 'SOURCE',
          acceptance: 'ACCEPTED',
        },
      ],
      { environmentId: 'env_prod' },
    );
    expect(selection.chosen?.id).toBe('source-v1');
    expect(selection.why).toContain('no observed map exists');
  });
});

describe('statusClassFor and shouldGenerateAgainst', () => {
  it('classifies a code, and calls a missing one UNKNOWN rather than OK', () => {
    expect(statusClassFor(200)).toBe('OK');
    expect(statusClassFor(302)).toBe('REDIRECT');
    expect(statusClassFor(404)).toBe('CLIENT_ERROR');
    expect(statusClassFor(500)).toBe('SERVER_ERROR');
    expect(statusClassFor(null)).toBe('UNKNOWN');
    expect(statusClassFor(undefined)).toBe('UNKNOWN');
    expect(statusClassFor(99)).toBe('UNKNOWN');
  });

  it('refuses a happy-path test against an error node', () => {
    // The node STAYS in the graph and in the inventory, on the ERROR_STATE
    // axis, where it is worth a test that asserts the error. What it must not
    // get is a test asserting the route's content loads.
    expect(
      shouldGenerateAgainst({ status: { code: 404, class: 'CLIENT_ERROR', isErrorPage: true } }),
    ).toBe(false);
    expect(
      shouldGenerateAgainst({ status: { code: 500, class: 'SERVER_ERROR', isErrorPage: false } }),
    ).toBe(false);
  });

  it('refuses a soft 404 — 200 with the application’s error page', () => {
    // The case that fools everything else. The status is fine; the page is not.
    expect(shouldGenerateAgainst({ status: { code: 200, class: 'OK', isErrorPage: true } })).toBe(
      false,
    );
  });

  it('permits an OK or a redirect', () => {
    expect(shouldGenerateAgainst({ status: { code: 200, class: 'OK', isErrorPage: false } })).toBe(
      true,
    );
    expect(
      shouldGenerateAgainst({ status: { code: 302, class: 'REDIRECT', isErrorPage: false } }),
    ).toBe(true);
  });
});

describe('accessCoverage', () => {
  it('counts a measured cell and never counts an unasked one as passing', () => {
    const coverage = accessCoverage(
      [
        {
          role: 'ADMIN',
          outcome: 'ALLOWED',
          status: 200,
          destinationRoute: null,
          basis: 'OBSERVED',
          observedAtIso: '2026-10-24T00:00:00.000Z',
        },
        {
          role: 'VIEWER',
          outcome: 'DENIED',
          status: 403,
          destinationRoute: null,
          basis: 'OBSERVED',
          observedAtIso: '2026-10-24T00:00:00.000Z',
        },
        // Declared only: the source says SUPPORT is required and nobody asked.
        {
          role: 'SUPPORT',
          outcome: 'DENIED',
          status: null,
          destinationRoute: null,
          basis: 'DECLARED',
          observedAtIso: null,
        },
      ],
      ['ADMIN', 'VIEWER', 'SUPPORT'],
    );
    // Three roles plus anonymous. Anonymous counts because "can a logged-out
    // visitor reach /admin" is the first question anybody asks, and leaving it
    // out would make the cell that matters most invisible.
    expect(coverage.cells).toBe(4);
    expect(coverage.measured).toBe(2);
    expect(coverage.declaredOnly).toBe(1);
    // The declared cell is NOT measured. A declared restriction the application
    // does not actually enforce is the defect we are looking for.
    expect(coverage.unmeasured).toBe(2);
  });

  it('reports every cell unmeasured when nothing asked', () => {
    const coverage = accessCoverage([], ['ADMIN']);
    expect(coverage.measured).toBe(0);
    expect(coverage.unmeasured).toBe(2);
  });
});

describe('exclusionsByRule', () => {
  it('groups refusals by rule, commonest first, with the count beside the sample', () => {
    const grouped = exclusionsByRule([
      {
        url: 'https://a/logout',
        route: '/logout',
        kind: 'SESSION_ENDING',
        rule: 'excludeGlobs: /logout',
        discoveredFrom: '/',
      },
      {
        url: 'https://a/account/logout',
        route: '/account/logout',
        kind: 'SESSION_ENDING',
        rule: 'excludeGlobs: /logout',
        discoveredFrom: '/account',
      },
      {
        url: 'https://a/delete-account',
        route: '/delete-account',
        kind: 'DESTRUCTIVE',
        rule: 'excludeGlobs: /delete-**',
        discoveredFrom: '/account',
      },
    ]);
    expect(grouped[0]).toEqual({
      rule: 'excludeGlobs: /logout',
      kind: 'SESSION_ENDING',
      count: 2,
      sample: ['https://a/logout', 'https://a/account/logout'],
    });
    expect(grouped).toHaveLength(2);
  });
});

// ─── The write path ─────────────────────────────────────────────────────────

describe('crawlPolicySchema', () => {
  it('parses an empty body into exactly the documented defaults', () => {
    // One place where a default is written down. Two would be two policies.
    expect(crawlPolicySchema.parse({})).toEqual(DEFAULT_CRAWL_POLICY);
  });

  it('refuses a glob with no leading slash', () => {
    // `admin/**` silently matches nothing, because the crawler tests against
    // `URL.pathname`. A scope rule that matches nothing looks applied in the
    // panel and refuses nothing in the crawl.
    expect(crawlPolicySchema.safeParse({ excludeGlobs: ['admin/**'] }).success).toBe(false);
  });

  it('refuses allowDestructive with no allow pattern', () => {
    // The flag alone grants nothing — `policyDecision` requires both — so a
    // customer who sets it would reasonably believe destructive paths are now
    // being covered. Refusing is how they find out while looking at the panel.
    expect(updateCrawlPolicySchema.safeParse({ allowDestructive: true }).success).toBe(false);
    expect(
      updateCrawlPolicySchema.safeParse({
        allowDestructive: true,
        destructiveAllowGlobs: ['/logout'],
      }).success,
    ).toBe(true);
  });

  it('refuses an additional origin that carries a path', () => {
    expect(
      crawlPolicySchema.safeParse({ additionalOrigins: ['https://auth.example.com/login'] })
        .success,
    ).toBe(false);
    expect(
      crawlPolicySchema.safeParse({ additionalOrigins: ['https://auth.example.com'] }).success,
    ).toBe(true);
  });
});

describe('the enumeration wire shapes', () => {
  it('refuses a frontier whose lower bound does not follow from its counts', () => {
    const good = {
      unvisitedQueued: 180,
      beyondDepth: 60,
      excluded: 0,
      offOrigin: 0,
      unreachable: 0,
      atLeastMoreUrls: 240,
      sample: [],
      sampleTruncated: false,
    };
    expect(frontierSchema.safeParse(good).success).toBe(true);
    // 0 would be the flattering answer and it is the one a careless writer
    // reaches for.
    expect(frontierSchema.safeParse({ ...good, atLeastMoreUrls: 0 }).success).toBe(false);
  });

  it('refuses a DECLARED access outcome that reports a status', () => {
    // Nobody made the request. Writing 403 there reports a measurement that was
    // never taken, which is the lie this product cannot afford in its purest
    // form.
    const declared = {
      role: 'VIEWER',
      outcome: 'DENIED' as const,
      status: 403,
      destinationRoute: null,
      basis: 'DECLARED' as const,
      observedAtIso: null,
    };
    expect(routeAccessSchema.safeParse(declared).success).toBe(false);
    expect(routeAccessSchema.safeParse({ ...declared, status: null }).success).toBe(true);
  });

  it('refuses a REDIRECTED outcome that does not say where it landed', () => {
    expect(
      routeAccessSchema.safeParse({
        role: null,
        outcome: 'REDIRECTED',
        status: 302,
        destinationRoute: null,
        basis: 'OBSERVED',
        observedAtIso: '2026-10-24T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('refuses a node status defaulted into existence', () => {
    // `code` is nullable and NOT defaulted to 200. A same-document SPA
    // transition produces no response, and this is the boundary where
    // "nobody looked" is cheapest to turn into "it answered 200".
    expect(nodeStatusSchema.safeParse({ class: 'OK', isErrorPage: false }).success).toBe(false);
    expect(
      nodeStatusSchema.safeParse({ code: null, class: 'UNKNOWN', isErrorPage: false }).success,
    ).toBe(true);
  });

  it('refuses an exclusion with no rule', () => {
    const entry = {
      url: 'https://a/logout',
      route: '/logout',
      kind: 'SESSION_ENDING' as const,
      discoveredFrom: null,
    };
    expect(excludedPathSchema.safeParse(entry).success).toBe(false);
    expect(excludedPathSchema.safeParse({ ...entry, rule: 'excludeGlobs: /logout' }).success).toBe(
      true,
    );
  });

  it('refuses a cap bite with no discarded count', () => {
    // An omitted `discarded` reads as "the cap cost nothing", which is the one
    // claim a truncated crawl is not entitled to make.
    const bite = {
      cap: 'PAGE_BUDGET' as const,
      limit: 60,
      bites: 1,
      scope: null,
      reason: 'budget',
    };
    expect(capBiteSchema.safeParse(bite).success).toBe(false);
    expect(capBiteSchema.safeParse({ ...bite, discarded: 0 }).success).toBe(true);
  });

  it('keeps an external boundary to an origin and a path', () => {
    /*
     * An IdP redirect carries the tenant, a user hint and a state token in its
     * query string, and a flow map is stored, rendered in a cockpit and
     * exported on request. No part of this product needs those values.
     */
    const boundary = {
      kind: 'REDIRECT' as const,
      origin: 'https://login.microsoftonline.com',
      fromRoute: '/login',
      samplePath: '/common/oauth2/v2.0/authorize',
      occurrences: 3,
    };
    expect(externalBoundarySchema.safeParse(boundary).success).toBe(true);
    expect(
      externalBoundarySchema.safeParse({
        ...boundary,
        samplePath: '/authorize?login_hint=ada@example.com&state=abc',
      }).success,
    ).toBe(false);
    expect(
      externalBoundarySchema.safeParse({ ...boundary, origin: 'https://idp.example.com/path' })
        .success,
    ).toBe(false);
  });

  it('refuses a CANDIDATE acceptance with no reason', () => {
    // "Degraded" with no reason is a denominator a customer cannot audit and
    // will not believe.
    expect(
      crawlAcceptanceSchema.safeParse({
        state: 'CANDIDATE',
        reasons: [],
        degradations: [],
        comparedToVersion: null,
        previousNodeCount: null,
      }).success,
    ).toBe(false);
  });

  it('accepts what adjudicateCrawl produces', () => {
    // The two halves of the same claim: the adjudicator's output has to survive
    // its own validator, or the write path refuses the thing the product
    // computed.
    const verdict = adjudicateCrawl({
      nodeCount: 9,
      errorNodeCount: 0,
      loadFailureCount: 0,
      throttledCount: 4,
      expectedAuthButHitWall: true,
      previous: { version: 8, nodeCount: 412 },
    });
    expect(crawlAcceptanceSchema.safeParse(verdict).success).toBe(true);
    expect(
      flowMapProvenanceSchema.safeParse({
        derivedFrom: 'CRAWL',
        acceptance: verdict.state,
        outcome: 'STOPPED',
      }).success,
    ).toBe(true);
  });
});
