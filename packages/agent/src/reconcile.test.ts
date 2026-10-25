/**
 * Tests for the module that produces the product's headline sentence.
 *
 * "Your source declares 412 routes, the crawl reached 25" is only worth saying
 * if it is true, and there are more ways for it to be subtly false than there
 * are lines in the module. The suite is built around those:
 *
 *   - a source that FAILED to load being read as a source that declared nothing
 *     (which shrinks the denominator and raises the reach percentage)
 *   - a staging crawl merged into a production reconciliation
 *   - `/users/[id]` and `/users/:id` reported as two different surfaces
 *   - `/users/:id` reported as never reached when the crawl visited /users/417
 *   - a template match presented as though it were an identical-key match
 *   - a capture–recapture estimate published across two sources that cause each
 *     other, where the number is biased in the reassuring direction
 *   - an estimate produced at zero overlap, which is arithmetic, not evidence
 *   - a cap that bit and was reported as an adjective rather than a count
 *   - a non-deterministic pairing, which would make every run look like a change
 *
 * Each of those is a test below.
 */

import { describe, expect, it } from 'vitest';
import {
  INDEPENDENT_SOURCE_PAIRS,
  MATCH_BASES,
  RECONCILIATION_STATES,
  SOURCE_PARTICIPATIONS,
  normaliseEntry,
  pairIsIndependent,
  participationIsHole,
  reconcileSurface,
  type ReconcileInput,
  type ReconcileSourceInput,
  type ReconciledSurface,
  type ReconciliationReport,
} from './reconcile.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function declaredSource(
  paths: string[],
  overrides: Partial<ReconcileSourceInput> = {},
): ReconcileSourceInput {
  return {
    source: 'SOURCE',
    participation: 'LOADED',
    detail: `${paths.length} route(s) from the app router`,
    entries: paths.map((spelling) => ({ spelling })),
    environmentId: null,
    ...overrides,
  };
}

function crawlSource(
  paths: string[],
  overrides: Partial<ReconcileSourceInput> = {},
): ReconcileSourceInput {
  return {
    source: 'CRAWL',
    participation: 'LOADED',
    detail: `${paths.length} page(s) visited`,
    entries: paths.map((spelling) => ({ spelling })),
    environmentId: 'env-prod',
    ...overrides,
  };
}

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    projectId: 'proj-1',
    environmentId: 'env-prod',
    axis: 'ROUTE',
    sources: [],
    ...overrides,
  };
}

function rowFor(report: ReconciliationReport, identity: string): ReconciledSurface {
  const row = report.rows.find((candidate) => candidate.identity === identity);
  if (row === undefined) {
    throw new Error(`no row for ${identity}; rows: ${report.rows.map((r) => r.identity).join(', ')}`);
  }
  return row;
}

// ─── The three sets ──────────────────────────────────────────────────────────

describe('the three sets the product is sold on', () => {
  it('splits declared, reached and both', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/', '/pricing', '/admin/billing']),
          crawlSource(['/', '/pricing', '/promo-2024']),
        ],
      }),
    );

    expect(report.counts).toMatchObject({
      declaredAndReached: 2,
      declaredNeverReached: 1,
      reachedNeverDeclared: 1,
    });
    expect(rowFor(report, '/admin/billing').state).toBe('DECLARED_BUT_NEVER_REACHED');
    expect(rowFor(report, '/promo-2024').state).toBe('REACHED_BUT_NEVER_DECLARED');
    expect(rowFor(report, '/pricing').state).toBe('DECLARED_AND_REACHED');
  });

  it('derives origin from the declarers rather than setting it beside state', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/', '/admin']), crawlSource(['/', '/promo'])] }),
    );
    expect(rowFor(report, '/').origin).toBe('BOTH');
    expect(rowFor(report, '/admin').origin).toBe('SOURCE_ONLY');
    expect(rowFor(report, '/promo').origin).toBe('CRAWL_ONLY');
  });

  it('says the sentence the whole product rests on', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a', '/b', '/c', '/d']),
          crawlSource(['/a', '/zzz']),
        ],
      }),
    );
    expect(report.headline).toContain('SOURCE declare 4 route(s)');
    expect(report.headline).toContain('CRAWL reached 1 of them (25%)');
    expect(report.headline).toContain('1 more that no source declares');
  });

  it('orders the rows findings-first and deterministically', () => {
    const report = reconcileSurface(
      input({
        sources: [declaredSource(['/z', '/a', '/m']), crawlSource(['/m', '/q'])],
      }),
    );
    const states = report.rows.map((row) => RECONCILIATION_STATES.indexOf(row.state));
    expect(states).toEqual([...states].sort((left, right) => left - right));

    const again = reconcileSurface(
      input({ sources: [declaredSource(['/m', '/z', '/a']), crawlSource(['/q', '/m'])] }),
    );
    expect(again.rows.map((row) => row.identity)).toEqual(report.rows.map((row) => row.identity));
  });
});

// ─── Spelling ────────────────────────────────────────────────────────────────

describe('the same route spelled five ways is one surface', () => {
  it('pairs every parameter dialect and keeps both originals on the row', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/users/[id]']),
          crawlSource(['/users/:id'], { source: 'CRAWL' }),
        ],
      }),
    );
    const row = rowFor(report, '/users/:param');
    expect(row.state).toBe('DECLARED_AND_REACHED');
    expect(row.matchBasis).toBe('EXACT');
    expect(row.declaredAs).toEqual([{ source: 'SOURCE', spelling: '/users/[id]' }]);
    expect(row.reachedAs).toEqual([{ source: 'CRAWL', spelling: '/users/:id' }]);
  });

  it('keeps every spelling a source used, so a bad match is auditable', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/users/[id]', '/users/{id}']),
          crawlSource(['/users/$id']),
        ],
      }),
    );
    const row = rowFor(report, '/users/:param');
    expect(row.declaredAs.map((ref) => ref.spelling).sort()).toEqual([
      '/users/[id]',
      '/users/{id}',
    ]);
    expect(row.reachedAs.map((ref) => ref.spelling)).toEqual(['/users/$id']);
  });

  it('does not report a declared template as never reached when an instance was visited', () => {
    const report = reconcileSurface(
      input({
        sources: [declaredSource(['/users/[id]']), crawlSource(['/users/417', '/users/9'])],
      }),
    );
    const row = rowFor(report, '/users/:param');
    expect(row.state).toBe('DECLARED_AND_REACHED');
    expect(row.matchBasis).toBe('TEMPLATE');
    expect(row.reachedAs.map((ref) => ref.spelling).sort()).toEqual(['/users/417', '/users/9']);
    expect(report.counts.reachedNeverDeclared).toBe(0);
  });

  it('pairs a wildcard with the subtree it swallows', () => {
    const report = reconcileSurface(
      input({
        sources: [declaredSource(['/docs/[...slug]']), crawlSource(['/docs/intro/install'])],
      }),
    );
    expect(rowFor(report, '/docs/*').state).toBe('DECLARED_AND_REACHED');
    expect(rowFor(report, '/docs/*').matchBasis).toBe('TEMPLATE');
  });

  it('never presents a relaxed match as an identical-key match', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/users/[id]']), crawlSource(['/users/417'])] }),
    );
    expect(report.counts.relaxedMatches).toBe(1);
    expect(report.crawlRecall.exactReached).toBe(0);
    expect(report.crawlRecall.reached).toBe(1);
    expect(report.caveats.join(' ')).toContain('needed a relaxed rule');
  });

  it('prefers the most specific template when two could absorb an observation', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/files/[...path]', '/files/[id]']),
          crawlSource(['/files/417']),
        ],
      }),
    );
    // /files/:param has one placeholder, /files/* also one — but ':param' sorts
    // before '*' is not the rule; placeholder COUNT ties, so the deterministic
    // lexicographic tiebreak decides and the row is flagged ambiguous.
    const matched = report.rows.filter((row) => row.state === 'DECLARED_AND_REACHED');
    expect(matched).toHaveLength(1);
    expect(matched[0]?.ambiguous).toBe(true);
    expect(report.counts.ambiguousMatches).toBe(1);
    expect(report.caveats.join(' ')).toContain('more than one declared template');
  });

  it('is case- and query-insensitive, as the canonicaliser already is', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/Checkout']), crawlSource(['/checkout?step=2#top'])] }),
    );
    expect(rowFor(report, '/checkout').state).toBe('DECLARED_AND_REACHED');
  });

  it('builds the stored key with the registry’s own format', () => {
    const report = reconcileSurface(input({ sources: [declaredSource(['/pricing'])] }));
    expect(rowFor(report, '/pricing').key).toBe('ROUTE:/pricing');
  });
});

// ─── The endpoint axis ───────────────────────────────────────────────────────

describe('endpoints carry their verb, and an unreadable verb stays unreadable', () => {
  it('keeps two verbs on one path as two surfaces', () => {
    const report = reconcileSurface(
      input({
        axis: 'ENDPOINT',
        sources: [
          declaredSource(['/api/users', '/api/users'], {
            source: 'OPENAPI',
            entries: [
              { spelling: '/api/users', method: 'get' },
              { spelling: '/api/users', method: 'delete' },
            ],
          }),
          crawlSource([], {
            source: 'TRAFFIC',
            entries: [{ spelling: '/api/users', method: 'GET' }],
          }),
        ],
      }),
    );
    expect(report.counts.declaredAndReached).toBe(1);
    expect(report.counts.declaredNeverReached).toBe(1);
    expect(rowFor(report, 'DELETE /api/users').state).toBe('DECLARED_BUT_NEVER_REACHED');
  });

  it('normalises a missing method to UNKNOWN rather than guessing GET', () => {
    expect(normaliseEntry('ENDPOINT', { spelling: '/api/x' }).identity).toBe('UNKNOWN /api/x');
    expect(normaliseEntry('ENDPOINT', { spelling: '/api/x', method: null }).identity).toBe(
      'UNKNOWN /api/x',
    );
    expect(normaliseEntry('ENDPOINT', { spelling: '/api/x', method: 'post' }).identity).toBe(
      'POST /api/x',
    );
  });

  it('pairs an UNKNOWN verb with a stated one, and says that is what it did', () => {
    const report = reconcileSurface(
      input({
        axis: 'ENDPOINT',
        sources: [
          declaredSource([], {
            source: 'SOURCE',
            entries: [{ spelling: '/api/refunds', method: null }],
          }),
          crawlSource([], {
            source: 'TRAFFIC',
            entries: [{ spelling: '/api/refunds', method: 'POST' }],
          }),
        ],
      }),
    );
    const matched = report.rows.filter((row) => row.state === 'DECLARED_AND_REACHED');
    expect(matched).toHaveLength(1);
    expect(matched[0]?.matchBasis).toBe('METHOD_AGNOSTIC');
    expect(report.caveats.join(' ')).toContain('unreadable HTTP method');
  });

  it('calls operations "operation" in the headline, not "route"', () => {
    const report = reconcileSurface(
      input({
        axis: 'ENDPOINT',
        sources: [
          declaredSource([], { source: 'OPENAPI', entries: [{ spelling: '/a', method: 'GET' }] }),
          crawlSource([], { source: 'TRAFFIC', entries: [{ spelling: '/a', method: 'GET' }] }),
        ],
      }),
    );
    expect(report.headline).toContain('operation(s)');
  });
});

// ─── Participation ───────────────────────────────────────────────────────────

describe('a reconciliation with a missing source says so, every time', () => {
  it('never reads a FAILED source as a source that declared nothing', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a', '/b']),
          {
            source: 'SITEMAP',
            participation: 'FAILED',
            detail: 'GET /sitemap.xml returned 404',
            entries: [],
            environmentId: null,
          },
          crawlSource(['/a']),
        ],
      }),
    );

    expect(report.complete).toBe(false);
    const sitemap = report.participation.find((entry) => entry.source === 'SITEMAP');
    expect(sitemap?.counted).toBe(false);
    expect(sitemap?.notCountedBecause).toContain('404');
    expect(sitemap?.distinctEntries).toBe(0);
    expect(report.verdict).toContain('NOT a full reconciliation');
    expect(report.caveats.join(' ')).toContain('raises the reach percentage');
  });

  it('distinguishes a source that failed from one nobody configured', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a']),
          {
            source: 'OPENAPI',
            participation: 'NOT_CONFIGURED',
            detail: 'no OpenAPI document is registered for this project',
            entries: [],
            environmentId: null,
          },
        ],
      }),
    );
    const openapi = report.participation.find((entry) => entry.source === 'OPENAPI');
    expect(openapi?.participation).toBe('NOT_CONFIGURED');
    expect(openapi?.notCountedBecause).toContain('not set up');
  });

  /*
   * THE FLAG THAT WAS STUCK AT FALSE.
   *
   * `complete` was `participation.every(counted)`, and a NOT_CONFIGURED source
   * is never counted — so every project without all eight declarers (which is
   * every project, and the caller in apps/api/src/lib/coverage-store.ts passes
   * all eight) reported `complete: false`, headlined "(partial)" and printed
   * "every surface it would have named is missing from the declared set, which
   * raises the reach percentage" about declarers the customer had deliberately
   * not set up. Two defects in one: the sentence is false, and a sitemap that
   * genuinely 404s became indistinguishable from the normal state — which is
   * the one case the flag exists for.
   */
  it('is complete when nothing failed, however many declarers are not set up', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a']),
          crawlSource(['/a']),
          ...(['OPENAPI', 'SITEMAP', 'REQUIREMENT', 'MANUAL', 'CATALOGUE'] as const).map(
            (source): ReconcileSourceInput => ({
              source,
              participation: 'NOT_CONFIGURED',
              detail: `no ${source} is registered for this project`,
              entries: [],
              environmentId: null,
            }),
          ),
        ],
      }),
    );

    expect(report.complete).toBe(true);
    expect(report.verdict).toContain('reconciled across 2 source(s)');
    // Named, so a reader can see what was not consulted...
    expect(report.verdict).toContain('not set up for this project');
    expect(report.verdict).toContain('CATALOGUE');
    // ...but never as a hole, and never as a reason the percentage moved.
    expect(report.headline).not.toContain('partial');
    expect(report.caveats.join(' ')).not.toContain('raises the reach percentage');
    for (const entry of report.participation) expect(entry.hole).toBe(false);
  });

  it('is incomplete when one declarer failed, and names only that one as the hole', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a']),
          crawlSource(['/a']),
          {
            source: 'SITEMAP',
            participation: 'FAILED',
            detail: 'GET /sitemap.xml returned 500',
            entries: [],
            environmentId: null,
          },
          {
            source: 'MANUAL',
            participation: 'NOT_CONFIGURED',
            detail: 'nothing was entered by hand',
            entries: [],
            environmentId: null,
          },
        ],
      }),
    );

    expect(report.complete).toBe(false);
    expect(report.headline).toContain('partial');
    expect(report.participation.find((entry) => entry.source === 'SITEMAP')?.hole).toBe(true);
    expect(report.participation.find((entry) => entry.source === 'MANUAL')?.hole).toBe(false);
    expect(report.verdict).toContain('SITEMAP');
    expect(report.verdict).not.toContain('MANUAL (');
    expect(report.caveats.join(' ')).toContain('raises the reach percentage');
  });

  it('calls an observation of another environment a hole, because we were entitled to it', () => {
    const report = reconcileSurface(
      input({
        environmentId: 'env-prod',
        sources: [declaredSource(['/a']), crawlSource(['/a'], { environmentId: 'env-staging' })],
      }),
    );
    const crawl = report.participation.find((entry) => entry.source === 'CRAWL');
    expect(crawl?.participation).toBe('LOADED');
    expect(crawl?.counted).toBe(false);
    expect(crawl?.hole).toBe(true);
    expect(report.complete).toBe(false);
  });

  it('pairs the hole predicate with the three participation values', () => {
    // The run-time half of the guard: `participationIsHole` is the only place
    // that decides, and a new SourceParticipation value must be classified here
    // rather than defaulting into "not a hole" and silently never flagging.
    expect(participationIsHole({ participation: 'FAILED', counted: false })).toBe(true);
    expect(participationIsHole({ participation: 'NOT_CONFIGURED', counted: false })).toBe(false);
    expect(participationIsHole({ participation: 'LOADED', counted: false })).toBe(true);
    for (const participation of SOURCE_PARTICIPATIONS) {
      expect(participationIsHole({ participation, counted: true })).toBe(false);
    }
  });

  it('reports participation even when everything loaded', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/a']), crawlSource(['/a'])] }),
    );
    expect(report.complete).toBe(true);
    expect(report.participation).toHaveLength(2);
    expect(report.verdict).toContain('reconciled across 2 source(s)');
  });

  it('labels each source with the side it feeds, from the observed-source split', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/a']), crawlSource(['/a'])] }),
    );
    expect(report.participation.find((entry) => entry.source === 'SOURCE')?.side).toBe('DECLARED');
    expect(report.participation.find((entry) => entry.source === 'CRAWL')?.side).toBe('REACHED');
  });

  it('refuses to report a reach at all when nothing observed', () => {
    const report = reconcileSurface(input({ sources: [declaredSource(['/a', '/b'])] }));
    expect(report.headline).toContain('nothing observed any of them');
    // It must disclaim the figure explicitly rather than print it: "0% reached"
    // would be a measurement, and no observation was made.
    expect(report.headline).toContain('not 0% reached, which would be a measurement');
    expect(report.crawlRecall.reached).toBe(0);
  });

  it('says a crawl-only inventory is what it is', () => {
    const report = reconcileSurface(input({ sources: [crawlSource(['/a', '/b'])] }));
    expect(report.headline).toContain('crawl-only inventory');
  });

  it('reconciles nothing when nothing loaded, and says that too', () => {
    const report = reconcileSurface(
      input({
        sources: [
          {
            source: 'SOURCE',
            participation: 'FAILED',
            detail: 'the repository was never ingested',
            entries: [],
            environmentId: null,
          },
        ],
      }),
    );
    expect(report.rows).toEqual([]);
    expect(report.headline).toContain('nothing was reconciled');
    expect(report.crawlRecall.percent).toBeNull();
  });
});

// ─── Environment ─────────────────────────────────────────────────────────────

describe('a crawl of another environment is a measurement of something else', () => {
  it('drops a staging crawl out of a production reconciliation, with a reason', () => {
    const report = reconcileSurface(
      input({
        environmentId: 'env-prod',
        sources: [
          declaredSource(['/a', '/b']),
          crawlSource(['/a', '/staging-only'], { environmentId: 'env-staging' }),
        ],
      }),
    );

    const crawl = report.participation.find((entry) => entry.source === 'CRAWL');
    expect(crawl?.counted).toBe(false);
    expect(crawl?.notCountedBecause).toContain('env-staging');
    expect(report.counts.reachedNeverDeclared).toBe(0);
    expect(report.counts.declaredAndReached).toBe(0);
    expect(report.complete).toBe(false);
  });

  it('counts a declaration with no environment, which is environment-independent', () => {
    const report = reconcileSurface(
      input({
        environmentId: 'env-prod',
        sources: [declaredSource(['/a'], { environmentId: null }), crawlSource(['/a'])],
      }),
    );
    expect(report.complete).toBe(true);
    expect(report.counts.declaredAndReached).toBe(1);
  });
});

// ─── Recall ──────────────────────────────────────────────────────────────────

describe('recall is a ratio of what we hold, and says what it divided', () => {
  it('divides reached by declared, and reports the exact-only figure beside it', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a', '/b', '/users/[id]', '/d']),
          crawlSource(['/a', '/users/417']),
        ],
      }),
    );
    expect(report.crawlRecall.declared).toBe(4);
    expect(report.crawlRecall.reached).toBe(2);
    expect(report.crawlRecall.percent).toBe(50);
    expect(report.crawlRecall.exactReached).toBe(1);
    expect(report.crawlRecall.exactPercent).toBe(25);
  });

  it('returns null rather than 0% or 100% when the declared set is empty', () => {
    const report = reconcileSurface(input({ sources: [crawlSource(['/a'])] }));
    expect(report.crawlRecall.declared).toBe(0);
    expect(report.crawlRecall.percent).toBeNull();
    expect(report.crawlRecall.exactPercent).toBeNull();
  });

  it('warns in its own rule that a failed source raises the figure', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/a']), crawlSource(['/a'])] }),
    );
    expect(report.crawlRecall.rule).toContain('failed to load shrinks it');
  });
});

// ─── Capture–recapture ───────────────────────────────────────────────────────

describe('the population estimate refuses more often than it answers', () => {
  it('will not estimate across SOURCE and CRAWL, which cause each other', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/a', '/b', '/c']), crawlSource(['/a', '/b'])] }),
    );
    expect(report.populationEstimate.state).toBe('UNPROVEN');
    expect(report.populationEstimate.totalSurfaces).toBeNull();
    expect(report.populationEstimate.beyondBothSources).toBeNull();
    expect(report.populationEstimate.reason).toContain('positively correlated');
    expect(report.caveats.join(' ')).toContain('no population estimate');
  });

  it('estimates across two genuinely independent sources', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a', '/b', '/c', '/d']),
          {
            source: 'TRAFFIC',
            participation: 'LOADED',
            detail: '3 paths in the access log',
            entries: [{ spelling: '/a' }, { spelling: '/b' }, { spelling: '/x' }],
            environmentId: 'env-prod',
          },
        ],
      }),
    );
    const estimate = report.populationEstimate;
    expect(estimate.state).toBe('ESTIMATED');
    expect(estimate.pair?.sort()).toEqual(['SOURCE', 'TRAFFIC']);
    expect(estimate.n1).toBe(4);
    expect(estimate.n2).toBe(3);
    expect(estimate.overlap).toBe(2);
    // Chapman: ((4+1)(3+1) / (2+1)) - 1 = 20/3 - 1 = 5.67 -> floor 5
    expect(estimate.totalSurfaces).toBe(5);
    // union is {a,b,c,d,x} = 5, so nothing is implied beyond both
    expect(estimate.beyondBothSources).toBe(0);
    expect(estimate.reason).toContain("Chapman's estimator");
  });

  it('implies surface beyond both sources when they disagree more', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a', '/b', '/c', '/d', '/e', '/f']),
          {
            source: 'TRAFFIC',
            participation: 'LOADED',
            detail: '6 paths in the access log',
            entries: ['/a', '/w', '/x', '/y', '/z', '/v'].map((spelling) => ({ spelling })),
            environmentId: 'env-prod',
          },
        ],
      }),
    );
    const estimate = report.populationEstimate;
    // ((6+1)(6+1)/(1+1)) - 1 = 49/2 - 1 = 23.5 -> 23; union is 11
    expect(estimate.totalSurfaces).toBe(23);
    expect(estimate.beyondBothSources).toBe(12);
  });

  it('refuses at zero overlap rather than producing a number from nothing', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a', '/b']),
          {
            source: 'TRAFFIC',
            participation: 'LOADED',
            detail: 'disjoint log',
            entries: [{ spelling: '/x' }, { spelling: '/y' }],
            environmentId: 'env-prod',
          },
        ],
      }),
    );
    expect(report.populationEstimate.state).toBe('UNPROVEN');
    expect(report.populationEstimate.overlap).toBe(0);
    expect(report.populationEstimate.reason).toContain('nothing to estimate from');
  });

  /*
   * "They share no surface" and "one of them found nothing" are different
   * facts, and the second one was unreachable. The empty-capture refusal sat
   * AFTER the zero-overlap refusal, and a source with no entries has an overlap
   * of zero by construction — so an OpenAPI document with no operations on this
   * axis, or a traffic connector that returned nothing, was reported as two
   * sources that both found things and failed to agree.
   */
  it('says which independent source declared nothing, rather than blaming the overlap', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a', '/b']),
          {
            source: 'TRAFFIC',
            participation: 'LOADED',
            detail: 'the log held no route on this axis',
            entries: [],
            environmentId: 'env-prod',
          },
        ],
      }),
    );
    const estimate = report.populationEstimate;
    expect(estimate.state).toBe('UNPROVEN');
    expect(estimate.pair).toEqual(['SOURCE', 'TRAFFIC']);
    expect(estimate.n2).toBe(0);
    expect(estimate.reason).toContain('declared nothing on this axis');
    expect(estimate.reason).toContain('TRAFFIC 0');
    expect(estimate.totalSurfaces).toBeNull();
  });

  it('refuses with fewer than two loaded sources', () => {
    const report = reconcileSurface(input({ sources: [declaredSource(['/a'])] }));
    expect(report.populationEstimate.state).toBe('UNPROVEN');
    expect(report.populationEstimate.reason).toContain('needs two sources');
  });

  it('counts only EXACT matches as recaptures, never a template pairing', () => {
    /*
     * One declared template paired with three observed instances is not three
     * recaptures of one individual. Over-counting m shrinks the estimate, which
     * understates hidden surface — the failure mode this product cannot have.
     */
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/users/[id]', '/a']),
          {
            source: 'TRAFFIC',
            participation: 'LOADED',
            detail: 'three instances and one literal',
            entries: ['/users/1', '/users/2', '/users/3', '/a'].map((spelling) => ({ spelling })),
            environmentId: 'env-prod',
          },
        ],
      }),
    );
    // Only '/a' is an identical key across the two sources.
    expect(report.populationEstimate.overlap).toBe(1);
    // ...while the reconciliation itself DID pair the template.
    expect(report.counts.declaredAndReached).toBe(2);
    expect(report.counts.relaxedMatches).toBe(1);
  });

  it('states every assumption, even when it refuses', () => {
    const refused = reconcileSurface(
      input({ sources: [declaredSource(['/a']), crawlSource(['/a'])] }),
    );
    expect(refused.populationEstimate.assumptions.length).toBeGreaterThanOrEqual(5);
    expect(refused.populationEstimate.assumptions.join(' ')).toContain('closed population');
    expect(refused.populationEstimate.assumptions.join(' ')).toContain('homogeneous catchability');
  });

  it('keeps the independence table order-insensitive and closed', () => {
    expect(pairIsIndependent('TRAFFIC', 'SOURCE')).toBe(true);
    expect(pairIsIndependent('SOURCE', 'TRAFFIC')).toBe(true);
    expect(pairIsIndependent('CRAWL', 'SOURCE')).toBe(false);
    expect(pairIsIndependent('SOURCE', 'SITEMAP')).toBe(false);
    expect(pairIsIndependent('SOURCE', 'OPENAPI')).toBe(false);
    for (const [left, right] of INDEPENDENT_SOURCE_PAIRS) expect(left).not.toBe(right);
  });
});

// ─── Caps ────────────────────────────────────────────────────────────────────

describe('a cap that bit is reported as a count, not as an adjective', () => {
  it('names the limit, the discard count and the lower bound it implies', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a']),
          crawlSource(['/a'], {
            caps: [
              {
                source: 'CRAWL',
                cap: 'page budget',
                limit: 60,
                discarded: 240,
                reason: 'the crawl stopped at 60 pages with URLs still queued',
              },
            ],
          }),
        ],
      }),
    );
    expect(report.caps).toHaveLength(1);
    const caveats = report.caveats.join(' ');
    expect(caveats).toContain('capped at 60');
    expect(caveats).toContain('discarded 240');
    expect(caveats).toContain('at least 240 more existed');
  });

  it('keeps the caps of a source that failed, because the cap still happened', () => {
    const report = reconcileSurface(
      input({
        sources: [
          declaredSource(['/a']),
          {
            source: 'SITEMAP',
            participation: 'FAILED',
            detail: 'the gzip stream was truncated',
            entries: [],
            environmentId: null,
            caps: [
              {
                source: 'SITEMAP',
                cap: 'entry take',
                limit: 5000,
                discarded: 12,
                reason: 'the reader stopped at 5000 entries',
              },
            ],
          },
        ],
      }),
    );
    expect(report.caps).toHaveLength(1);
    expect(report.caveats.join(' ')).toContain('at least 12 more existed');
  });

  it('always carries the sentence that explains the matcher', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/a']), crawlSource(['/a'])] }),
    );
    expect(report.caveats.length).toBeGreaterThan(0);
    expect(report.caveats.join(' ')).toContain('original spelling');
  });
});

// ─── Bookkeeping ─────────────────────────────────────────────────────────────

describe('the counts cannot disagree with the rows', () => {
  it('accounts for every row exactly once, over several shapes', () => {
    const fixtures: ReconcileInput[] = [
      input({ sources: [] }),
      input({ sources: [declaredSource(['/a', '/b'])] }),
      input({ sources: [crawlSource(['/a'])] }),
      input({ sources: [declaredSource(['/users/[id]', '/a']), crawlSource(['/users/1', '/b'])] }),
      input({
        axis: 'ENDPOINT',
        sources: [
          declaredSource([], {
            source: 'OPENAPI',
            entries: [{ spelling: '/x', method: 'GET' }, { spelling: '/y', method: null }],
          }),
          crawlSource([], {
            source: 'TRAFFIC',
            entries: [{ spelling: '/y', method: 'POST' }, { spelling: '/z', method: 'GET' }],
          }),
        ],
      }),
    ];

    for (const fixture of fixtures) {
      const report = reconcileSurface(fixture);
      const { declaredNeverReached, reachedNeverDeclared, declaredAndReached } = report.counts;
      expect(declaredNeverReached + reachedNeverDeclared + declaredAndReached).toBe(
        report.rows.length,
      );
      for (const row of report.rows) {
        if (row.state === 'DECLARED_BUT_NEVER_REACHED') {
          expect(row.reachedAs).toEqual([]);
          expect(row.declaredAs.length).toBeGreaterThan(0);
          expect(row.matchBasis).toBeNull();
        }
        if (row.state === 'REACHED_BUT_NEVER_DECLARED') {
          expect(row.declaredAs).toEqual([]);
          expect(row.reachedAs.length).toBeGreaterThan(0);
          expect(row.matchBasis).toBeNull();
        }
        if (row.state === 'DECLARED_AND_REACHED') {
          expect(row.declaredAs.length).toBeGreaterThan(0);
          expect(row.reachedAs.length).toBeGreaterThan(0);
          expect(MATCH_BASES).toContain(row.matchBasis);
        }
      }
    }
  });

  it('dedupes two spellings of one surface within a single source', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/users/[id]', '/users/{id}', '/users/:id'])] }),
    );
    expect(report.rows).toHaveLength(1);
    expect(report.participation[0]?.distinctEntries).toBe(1);
    expect(report.rows[0]?.declaredAs).toHaveLength(3);
  });

  it('keeps reached-never-declared out of the recall denominator', () => {
    const report = reconcileSurface(
      input({ sources: [declaredSource(['/a']), crawlSource(['/a', '/b', '/c'])] }),
    );
    expect(report.crawlRecall.declared).toBe(1);
    expect(report.crawlRecall.percent).toBe(100);
    expect(report.counts.reachedNeverDeclared).toBe(2);
  });
});
