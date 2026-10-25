import { describe, expect, it, vi } from 'vitest';
import type { CrawlOutcome, InterstitialFinding } from '@qaai/agent';
import { EMPTY_FRONTIER, lowerBoundMoreUrls } from '@qaai/shared';
import type { FlowMap, FlowNode, Frontier } from '@qaai/shared';
/*
 * TYPE-ONLY, and that is why it sits with the other static imports rather than
 * in the dynamic block below: a type import is erased, so it cannot load
 * ./explore.js before `vi.mock` has replaced the worker context the way a value
 * import would.
 */
import type { RolePassResult } from './explore.js';

/*
 * The worker's context opens Postgres, Redis and the LLM at import time and
 * calls `process.exit(1)` when an env var is missing, so it is replaced
 * wholesale — the same shape every other processor test in this directory uses.
 * None of the three functions under test touches it; they are pure, which is
 * why they were extracted in the first place.
 */
vi.mock('../context.js', () => ({
  config: { anthropicApiKey: '' },
  connection: {},
  llm: {},
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  prisma: {},
  publishEvent: () => {},
}));
vi.mock('../vault.js', () => ({ secretsFor: async () => ({}) }));
vi.mock('../queues.js', () => ({ enqueueGenerate: async () => {} }));

const { adjudicateExplore, enumerationCompleteness, mergeFlowMaps } = await import('./explore.js');

/**
 * WHAT THESE TESTS COVER, AND WHAT THEY DO NOT.
 *
 * The three decisions this processor makes that can produce a false
 * denominator, each as a pure exported function:
 *
 *   • the acceptance gate — whether a degraded crawl may BE the denominator;
 *   • the incremental merge — what a disappeared node means;
 *   • the completeness verdict — converged, or merely stopped.
 *
 * `processExplore` itself is NOT covered. It is a Prisma transaction, a queue
 * enqueue and an event publish around those three, and a test of it would be a
 * test of four mocks agreeing with each other. The three decisions are where
 * the lies live and they are reachable directly, which is the whole reason they
 * were extracted.
 */

function node(route: string, stateKey = 'x'): FlowNode {
  return {
    id: `node-${route}`,
    route,
    url: `https://app.test${route}`,
    title: route,
    stateKey,
    requiresRoles: [],
    behindAuth: false,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
  };
}

function map(routes: string[], version = 1, frontier?: Partial<Frontier>): FlowMap {
  const base: Frontier = { ...EMPTY_FRONTIER, ...frontier };
  return {
    projectId: 'p',
    environmentId: 'e',
    version,
    baseUrl: 'https://app.test/',
    nodes: routes.map((route) => node(route)),
    edges: [],
    journeys: [],
    features: [],
    exploredAt: new Date().toISOString(),
    truncatedReason: null,
    frontier: { ...base, atLeastMoreUrls: lowerBoundMoreUrls(base) },
  };
}

function outcomeFor(input: {
  routes: string[];
  converged?: boolean;
  unvisitedQueued?: number;
  interstitial?: InterstitialFinding | null;
  authWallBounces?: number;
  throttled?: number;
  loadFailures?: number;
  saturation?: Array<{ visited: number; nodes: number }>;
}): CrawlOutcome {
  const frontier: Frontier = {
    ...EMPTY_FRONTIER,
    unvisitedQueued: input.unvisitedQueued ?? 0,
  };
  return {
    flowMap: {
      ...map(input.routes),
      frontier: { ...frontier, atLeastMoreUrls: lowerBoundMoreUrls(frontier) },
    },
    outcome: input.converged === false ? 'STOPPED' : 'CONVERGED',
    saturation: input.saturation ?? [],
    interstitial: input.interstitial ?? null,
    degradationCounts: {
      errorNodeCount: 0,
      loadFailureCount: input.loadFailures ?? 0,
      throttledCount: input.throttled ?? 0,
      tlsFailureCount: 0,
      authWallBounces: input.authWallBounces ?? 0,
    },
  } as unknown as CrawlOutcome;
}

describe('adjudicateExplore — a degraded crawl must not become the denominator', () => {
  it('accepts a clean crawl', () => {
    const acceptance = adjudicateExplore({
      outcome: outcomeFor({ routes: ['/', '/orders', '/settings'] }),
      authenticated: false,
      previous: { version: 1, nodeCount: 3 },
    });
    expect(acceptance.state).toBe('ACCEPTED');
    // Never a reason for ACCEPTED: `crawlAcceptanceSchema` refuses the other
    // way round, and a reason on a healthy crawl is noise in every report.
    expect(acceptance.reasons).toEqual([]);
  });

  it('rejects a crawl that enumerated nothing, rather than letting it replace the map', () => {
    const acceptance = adjudicateExplore({
      outcome: outcomeFor({ routes: [], loadFailures: 3 }),
      authenticated: false,
      previous: { version: 4, nodeCount: 120 },
    });
    expect(acceptance.state).toBe('REJECTED');
    expect(acceptance.reasons.join(' ')).toContain('previous one stands');
  });

  it('holds a crawl that collapsed against the last accepted map', () => {
    const acceptance = adjudicateExplore({
      outcome: outcomeFor({ routes: ['/'] }),
      authenticated: false,
      previous: { version: 7, nodeCount: 412 },
    });
    expect(acceptance.state).toBe('CANDIDATE');
    expect(acceptance.comparedToVersion).toBe(7);
    expect(acceptance.previousNodeCount).toBe(412);
  });

  it('holds a crawl that was bounced to a login WITH credentials', () => {
    const acceptance = adjudicateExplore({
      outcome: outcomeFor({ routes: ['/', '/login'], authWallBounces: 4 }),
      authenticated: true,
      previous: null,
    });
    expect(acceptance.state).toBe('CANDIDATE');
  });

  it('does NOT hold an anonymous crawl that hit the wall — that is the app working', () => {
    // Either half alone is not a degradation. An anonymous crawl SHOULD be
    // bounced, and holding it would make the mechanism one people switch off.
    const acceptance = adjudicateExplore({
      outcome: outcomeFor({ routes: ['/', '/login'], authWallBounces: 4 }),
      authenticated: false,
      previous: null,
    });
    expect(acceptance.state).toBe('ACCEPTED');
  });

  it('holds a bot wall that adjudication ALONE would accept', () => {
    /*
     * THE CASE THE COUNTS CANNOT SEE, and the reason the second step exists.
     * A challenge page answers 200 with one node, no error statuses and no
     * throttling, so `adjudicateCrawl` has nothing to object to — the wall
     * becomes the denominator and the coverage percentage goes UP.
     */
    const bare = outcomeFor({ routes: ['/'] });
    const withoutClassifier = adjudicateExplore({
      outcome: bare,
      authenticated: false,
      previous: null,
    });
    expect(withoutClassifier.state).toBe('ACCEPTED');

    const held = adjudicateExplore({
      outcome: outcomeFor({
        routes: ['/'],
        interstitial: {
          kind: 'BOT_CHALLENGE',
          blocksEnumeration: true,
          reason: 'a bot challenge answered instead of the application',
          signals: [],
          degradation: null,
        },
      }),
      authenticated: false,
      previous: null,
    });
    expect(held.state).toBe('CANDIDATE');
    expect(held.reasons.join(' ')).toContain('bot challenge');
  });

  it('never upgrades a REJECTED crawl, however the wall is classified', () => {
    const held = adjudicateExplore({
      outcome: outcomeFor({
        routes: [],
        loadFailures: 2,
        interstitial: {
          kind: 'MAINTENANCE',
          blocksEnumeration: true,
          reason: 'a maintenance page answered instead of the application',
          signals: [],
          degradation: null,
        },
      }),
      authenticated: false,
      previous: null,
    });
    expect(held.state).toBe('REJECTED');
    // The evidence is added; the verdict is not improved.
    expect(held.reasons.join(' ')).toContain('maintenance page');
  });

  it('ignores an interstitial that does not block enumeration', () => {
    const acceptance = adjudicateExplore({
      outcome: outcomeFor({
        routes: ['/', '/orders'],
        interstitial: {
          kind: 'CONSENT_WALL',
          blocksEnumeration: false,
          reason: null,
          signals: [],
          degradation: null,
        },
      }),
      authenticated: false,
      previous: null,
    });
    expect(acceptance.state).toBe('ACCEPTED');
  });
});

describe('mergeFlowMaps — a disappeared node is TWO different facts', () => {
  it('carries a node the crawl did not reach, when enumeration did not converge', () => {
    /*
     * THE DEFECT: every crawl writes a new version that REPLACES the last, so a
     * node the budget never reached is silently deleted, the denominator
     * shrinks, the numerator does not, and the coverage percentage goes UP.
     */
    const previous = map(['/', '/orders', '/settings', '/reports'], 4);
    const fresh = map(['/', '/orders'], 5, { unvisitedQueued: 12 });
    const { merged, report } = mergeFlowMaps(previous, fresh, {
      converged: false,
      atLeastMoreUrls: 12,
    });
    expect(report.carried).toBe(2);
    expect(report.dropped).toBe(0);
    expect(merged.nodes.map((entry) => entry.route).sort()).toEqual([
      '/',
      '/orders',
      '/reports',
      '/settings',
    ]);
    expect(report.rule).toContain('CARRIED');
    expect(report.rule).toContain('different facts');
  });

  it('drops a node only when the crawl is entitled to say it is gone', () => {
    const previous = map(['/', '/orders', '/retired'], 4);
    const fresh = map(['/', '/orders'], 5);
    const { merged, report } = mergeFlowMaps(previous, fresh, {
      converged: true,
      atLeastMoreUrls: 0,
    });
    expect(report.dropped).toBe(1);
    expect(report.carried).toBe(0);
    expect(merged.nodes.map((entry) => entry.route)).toEqual(['/', '/orders']);
    expect(report.rule).toContain('REMOVED');
  });

  it('does not drop on convergence while the lower bound is non-zero', () => {
    // CONVERGED with URLs still known and unvisited is not convergence over
    // the surface — it is convergence over the surface we trimmed.
    const previous = map(['/', '/gone'], 4);
    const fresh = map(['/'], 5, { beyondDepth: 9 });
    const { report } = mergeFlowMaps(previous, fresh, { converged: true, atLeastMoreUrls: 9 });
    expect(report.dropped).toBe(0);
    expect(report.carried).toBe(1);
  });

  it('re-identifies a carried node so it cannot collide with a fresh one', () => {
    // The fresh map numbers its nodes from the schedule's deterministic order,
    // so a previous `node-0` is a DIFFERENT state from this crawl's `node-0`.
    const previous: FlowMap = { ...map(['/a'], 4), nodes: [{ ...node('/a'), id: 'node-0' }] };
    const fresh: FlowMap = { ...map(['/b'], 5), nodes: [{ ...node('/b'), id: 'node-0' }] };
    const { merged } = mergeFlowMaps(previous, fresh, { converged: false, atLeastMoreUrls: 1 });
    const ids = merged.nodes.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries only the edges BETWEEN carried nodes', () => {
    const previous: FlowMap = {
      ...map(['/a', '/b'], 4),
      nodes: [
        { ...node('/a'), id: 'p0' },
        { ...node('/b'), id: 'p1' },
      ],
      edges: [
        { id: 'e0', from: 'p0', to: 'p1', action: 'open', selector: null },
        // An edge into a node the fresh crawl DID reach: its id now means
        // something else, so carrying it would be a dangling edge.
        { id: 'e1', from: 'p0', to: 'node-0', action: 'open', selector: null },
      ],
    };
    const fresh = map(['/'], 5, { unvisitedQueued: 2 });
    const { merged } = mergeFlowMaps(previous, fresh, { converged: false, atLeastMoreUrls: 2 });
    const ids = new Set(merged.nodes.map((entry) => entry.id));
    for (const edge of merged.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
    expect(merged.edges).toHaveLength(1);
  });

  it('treats the first crawl as the whole denominator and says so', () => {
    const fresh = map(['/', '/orders'], 1);
    const { merged, report } = mergeFlowMaps(null, fresh, {
      converged: true,
      atLeastMoreUrls: 0,
    });
    expect(merged).toBe(fresh);
    expect(report.carried).toBe(0);
    expect(report.rule).toContain('no previous accepted map');
  });

  it('refreshes a node seen in both rather than counting it twice', () => {
    const previous = map(['/', '/orders'], 4);
    const fresh = map(['/', '/orders'], 5);
    const { merged, report } = mergeFlowMaps(previous, fresh, {
      converged: false,
      atLeastMoreUrls: 3,
    });
    expect(merged.nodes).toHaveLength(2);
    expect(report.refreshed).toBe(2);
    expect(report.carried).toBe(0);
  });
});

describe('enumerationCompleteness — a percentage must never be quoted silently', () => {
  it('is CONVERGED only when the frontier emptied and nothing was discarded', () => {
    const verdict = enumerationCompleteness(outcomeFor({ routes: ['/', '/a'] }));
    expect(verdict.state).toBe('CONVERGED');
    expect(verdict.why).toContain('whole known surface');
  });

  it('is UNPROVEN when URLs were known and not visited, and names the number', () => {
    const verdict = enumerationCompleteness(
      outcomeFor({ routes: ['/'], converged: false, unvisitedQueued: 240 }),
    );
    expect(verdict.state).toBe('UNPROVEN');
    expect(verdict.why).toContain('at least 240');
    expect(verdict.why).toContain('unknown whole');
  });

  it('is UNPROVEN when the loop converged but URLs were still known — not convergence', () => {
    /*
     * The frontier can empty while a per-template budget was discarding every
     * instance of `/orders/:id`. `enumerationOutcome` reports that as STOPPED,
     * but a caller that read only the loop's exit would see CONVERGED, so the
     * lower bound is tested TOO rather than instead.
     */
    const verdict = enumerationCompleteness(
      outcomeFor({ routes: ['/'], converged: true, unvisitedQueued: 7 }),
    );
    expect(verdict.state).toBe('UNPROVEN');
    expect(verdict.why).toContain('at least 7');
  });

  it('is UNPROVEN even when the frontier is empty, if the loop merely stopped', () => {
    // `enumerationOutcome` can report STOPPED with an empty frontier when a cap
    // discarded candidates, and that is NOT convergence.
    const verdict = enumerationCompleteness(outcomeFor({ routes: ['/'], converged: false }));
    expect(verdict.state).toBe('UNPROVEN');
  });

  it('reports a flattened discovery curve as SUGGESTIVE, and does not upgrade on it', () => {
    /*
     * The saturation curve is the cheap half and it is all that is implemented.
     * A flat tail is evidence the crawl was running out of new surface; it is
     * NOT evidence that none was left, because a section reachable only from a
     * page the budget never opened produces exactly the same flat tail. So it
     * is reported beside the verdict and the verdict stays UNPROVEN.
     */
    const saturation = Array.from({ length: 20 }, (_, index) => ({
      visited: index + 1,
      // Flat from visit 12 on: the last quarter of the visits (16..20)
      // discovered nothing at all.
      nodes: Math.min(index + 1, 12),
    }));
    const verdict = enumerationCompleteness(
      outcomeFor({ routes: ['/'], converged: false, unvisitedQueued: 5, saturation }),
    );
    expect(verdict.state).toBe('UNPROVEN');
    expect(verdict.tailDiscoveryRate).toBe(0);
    expect(verdict.why).toContain('NOT proof');
  });

  it('reports a NULL discovery rate rather than a zero when there were too few visits', () => {
    // Nobody measured, which is not the same as "nothing was discovered late".
    const verdict = enumerationCompleteness(
      outcomeFor({
        routes: ['/'],
        converged: false,
        unvisitedQueued: 1,
        saturation: [
          { visited: 1, nodes: 1 },
          { visited: 2, nodes: 2 },
        ],
      }),
    );
    expect(verdict.tailDiscoveryRate).toBeNull();
    expect(verdict.why).not.toContain('0%');
  });
});

/**
 * ── THE THREE DECISIONS IN THE ORDER THE PROCESSOR RUNS THEM ────────────────
 *
 * Every test above drives ONE of the three functions. A wiring mutation showed
 * that is not enough: replacing `adjudicateExplore`'s result in
 * `processExplore` with a hard-coded ACCEPTED, and replacing the
 * `mergeFlowMaps` call with its own input, each left all 21 of them green. The
 * decisions were proved; the SEQUENCE that uses them was not, and the sequence
 * is where the denominator is actually decided — a gate that answers CANDIDATE
 * to a caller that merges anyway protects nothing.
 *
 * `processExplore` itself still cannot be called here (it is a Prisma
 * transaction and a queue enqueue), so what is asserted is the composition the
 * processor performs: gate, then merge ONLY on a promotion, then the resume
 * point ONLY on a promotion. If the processor's own branch is rewritten these
 * stay green — which is why they are stated as the contract the branch must
 * implement, in the same words as the code.
 */
describe('the acceptance chain — a degraded crawl must not move the number', () => {
  /** What `processExplore` does with an outcome, as a single expression. */
  function chain(input: {
    outcome: CrawlOutcome;
    authenticated: boolean;
    previousMap: FlowMap | null;
    previousAccepted: { version: number; nodeCount: number } | null;
  }): {
    state: string;
    promoted: boolean;
    nodeCount: number;
    rule: string;
    writesResume: boolean;
    /*
     * THE KINDS, not just the state. Two of the four tests below passed for the
     * wrong reason without this: a down site and a rate-limited one are both
     * held, so asserting the STATE alone is green even when the signal under
     * test is ignored entirely. Zeroing `loadFailureCount` left "a site that is
     * DOWN" green (the verdict came from the zero node count) and zeroing
     * `throttledCount` left "a RATE-LIMITED crawl is held" green (the verdict
     * came from the shrink against v4). The kind is what names WHY, and it is
     * what a customer is shown.
     */
    kinds: string[];
  } {
    const acceptance = adjudicateExplore({
      outcome: input.outcome,
      authenticated: input.authenticated,
      previous: input.previousAccepted,
    });
    const promoted = acceptance.state === 'ACCEPTED';
    const completeness = enumerationCompleteness(input.outcome);
    const { merged, report } = promoted
      ? mergeFlowMaps(input.previousMap, input.outcome.flowMap, {
          converged: completeness.state === 'CONVERGED',
          atLeastMoreUrls: input.outcome.flowMap.frontier?.atLeastMoreUrls ?? 0,
        })
      : { merged: input.outcome.flowMap, report: { rule: 'held, so nothing was merged' } };
    return {
      state: acceptance.state,
      promoted,
      nodeCount: merged.nodes.length,
      rule: report.rule,
      // The processor writes `withResumePoint` only when promoted, and the
      // reason is sharper than the merge's: a resume point whose visited set is
      // full of bot-wall pages makes the NEXT crawl skip the real pages.
      writesResume: promoted,
      kinds: acceptance.degradations.map((degradation) => degradation.kind),
    };
  }

  it('a site that is DOWN does not merge, does not resume, and leaves 412 standing', () => {
    // The scenario this whole gate exists for: staging fell over, the crawl
    // loaded nothing, and the newest row would otherwise become the
    // denominator — numerator unchanged, percentage UP, nobody told.
    const previous = map(
      Array.from({ length: 412 }, (_, index) => `/r${index}`),
      7,
    );
    const result = chain({
      outcome: outcomeFor({ routes: [], loadFailures: 12 }),
      authenticated: false,
      previousMap: previous,
      previousAccepted: { version: 7, nodeCount: 412 },
    });
    expect(result.state).toBe('REJECTED');
    expect(result.promoted).toBe(false);
    expect(result.writesResume).toBe(false);
    // The 412 are NOT carried forward under the dead crawl's version — that
    // would launder the outage into a map that reads as complete.
    expect(result.nodeCount).toBe(0);
    expect(result.rule).toContain('nothing was merged');
    // SITE_DOWN, not NO_PAGES: "we could not reach it" and "it has no pages"
    // are different facts and the ledger must not render them the same way.
    expect(result.kinds).toContain('SITE_DOWN');
  });

  it('a RATE-LIMITED crawl is held on the THROTTLING alone, with no shrink to lean on', () => {
    /*
     * The node count deliberately does NOT collapse — four routes against four
     * in v4 — so `SHRANK` cannot fire and the only degradation available is the
     * 429s. Written the other way round first, with one node against four, and
     * zeroing `throttledCount` left it green: the verdict was coming from the
     * shrink and the throttling signal was never exercised at all.
     */
    const previous = map(['/', '/orders', '/settings', '/admin'], 4);
    const result = chain({
      outcome: outcomeFor({ routes: ['/', '/orders', '/settings', '/admin'], throttled: 9 }),
      authenticated: false,
      previousMap: previous,
      previousAccepted: { version: 4, nodeCount: 4 },
    });
    expect(result.state).toBe('CANDIDATE');
    expect(result.kinds).toEqual(['RATE_LIMITED']);
    expect(result.promoted).toBe(false);
    expect(result.writesResume).toBe(false);
  });

  it('a LOGGED-OUT authenticated crawl is held even though it looks healthy', () => {
    // 200s, no errors, no throttling: adjudication on the counts alone would
    // accept this, and the sign-in page would become the denominator.
    const result = chain({
      outcome: outcomeFor({ routes: ['/', '/login'], authWallBounces: 6 }),
      authenticated: true,
      previousMap: map(['/', '/orders', '/settings'], 3),
      previousAccepted: { version: 3, nodeCount: 3 },
    });
    expect(result.state).toBe('CANDIDATE');
    expect(result.kinds).toEqual(['NOT_LOGGED_IN']);
    expect(result.promoted).toBe(false);
  });

  it('a clean crawl DOES merge, and an unproven one carries rather than drops', () => {
    // The other half, or the gate is indistinguishable from a feature switch
    // that is off: a healthy crawl must still produce a merged map, and a node
    // it did not reach must survive while enumeration is unproven.
    const previous = map(['/', '/orders', '/legacy'], 6);
    const result = chain({
      outcome: outcomeFor({ routes: ['/', '/orders'], converged: false, unvisitedQueued: 4 }),
      authenticated: false,
      previousMap: previous,
      previousAccepted: { version: 6, nodeCount: 3 },
    });
    expect(result.state).toBe('ACCEPTED');
    expect(result.promoted).toBe(true);
    expect(result.writesResume).toBe(true);
    // `/legacy` is CARRIED: the crawl stopped with 4 URLs known and unvisited,
    // so it is not entitled to say the route is gone. The denominator comes out
    // too LOW rather than too high, which is the conservative direction.
    expect(result.nodeCount).toBe(3);
  });
});

/**
 * ── HALF THE APP, PER ROLE ──────────────────────────────────────────────────
 *
 * Three register items land below, and the tests are shaped around the lies
 * each one could tell instead of around its happy path:
 *
 *   PER-ROLE ENUMERATION      a role whose login failed counted as a role with
 *                             no extra surface; a role's cost hidden; a
 *                             degraded role pass allowed into the denominator.
 *   THE TWO-PASS CRAWL        `behindAuth` false everywhere because a session
 *                             was supplied, and `requiresRoles` empty because
 *                             nothing ever wrote it.
 *   THE ACCESS MATRIX         covered by packages/agent/src/access-matrix.test
 *                             .ts; what is asserted here is the processor's
 *                             side of it — which passes may contribute cells at
 *                             all.
 *
 * `processExplore` is still not called: it is a Prisma upsert loop and a queue
 * enqueue around these decisions. The decisions are where the lies live and
 * they are all reachable directly, which is why they were extracted.
 */
const {
  MAX_ROLE_PASSES,
  ROLE_OUTCOME_FOR_LOGIN_FAILURE,
  adjudicateUnion,
  loginRoutesFrom,
  mergeRolePasses,
  planRolePasses,
  roleAttemptReport,
  routesNewToRole,
  staleRoleAttempts,
} = await import('./explore.js');
const { LOGIN_FAILURES } = await import('@qaai/runner');
const { ANONYMOUS_ROLE } = await import('@qaai/shared');

/** One finished pass, as `runRolePasses` would have produced it. */
function pass(input: {
  role: string;
  routes?: string[];
  contributed?: boolean;
  outcome?: string;
  detail?: string | null;
  authWallBounces?: number;
  behindAuthRoutes?: string[];
  anonymousAllowed?: string[];
  /**
   * The state digest this pass's nodes carry. DISTINCT PER PASS is the real
   * shape: an admin sees different content on /dashboard than a member, so the
   * two passes produce two STATES of one route and the merge keeps both. With
   * one shared key the anonymous node always wins the identity slot and the
   * per-route wall evidence is never exercised — which is exactly how a
   * mutation that deleted that evidence survived.
   */
  stateKey?: string;
}): RolePassResult {
  const crawl =
    input.routes === undefined
      ? null
      : (() => {
          const built = outcomeFor({
            routes: input.routes,
            authWallBounces: input.authWallBounces ?? 0,
          });
          for (const node of built.flowMap.nodes) {
            if (input.stateKey !== undefined) node.stateKey = input.stateKey;
            const walled = (input.behindAuthRoutes ?? []).includes(node.route);
            const allowed = (input.anonymousAllowed ?? []).includes(node.route);
            node.behindAuth = walled;
            node.access = [
              {
                role: input.role === ANONYMOUS_ROLE ? null : input.role,
                outcome: walled ? 'REDIRECTED' : 'ALLOWED',
                status: walled ? 302 : 200,
                destinationRoute: walled ? '/login' : null,
                basis: 'OBSERVED',
                observedAtIso: '2026-10-24T10:00:00.000Z',
              },
            ];
            if (allowed) node.behindAuth = false;
          }
          return built;
        })();
  return {
    identity:
      input.role === ANONYMOUS_ROLE
        ? null
        : {
            authProfileId: `profile-${input.role}`,
            profileName: input.role,
            role: input.role,
            roleFromName: false,
            kind: 'FORM_LOGIN',
          },
    role: input.role,
    outcome: input.outcome ?? (crawl === null ? 'LOGIN_FAILED' : 'CRAWLED'),
    detail: input.detail ?? null,
    remedy: null,
    acceptance: null,
    crawl,
    contributed: input.contributed ?? crawl !== null,
    routesReached: (input.contributed ?? crawl !== null) ? (input.routes?.length ?? 0) : null,
    cappedBy: null,
    atLeastMoreRoutes: null,
  } as unknown as RolePassResult;
}

describe('planRolePasses — the role axis, and what it refuses to claim', () => {
  const profile = (
    id: string,
    name: string,
    role: string | null,
    kind: 'FORM_LOGIN' | 'MOCK_IDP' = 'FORM_LOGIN',
  ) => ({ id, name, kind, role });

  it('plans one pass per declared role', () => {
    const plan = planRolePasses({
      profiles: [profile('a', 'Admin login', 'admin'), profile('b', 'Member login', 'member')],
    });

    expect(plan.identities.map((identity) => identity.role)).toEqual(['admin', 'member']);
    expect(plan.identities.every((identity) => !identity.roleFromName)).toBe(true);
  });

  it('falls back to the profile NAME when no role is declared, and says it did', () => {
    // A null role means "nobody said what this is" and must NOT become the
    // anonymous visitor. The name is what the crawler has always passed.
    const plan = planRolePasses({ profiles: [profile('a', 'Ahmad test login', null)] });

    expect(plan.identities[0]?.role).toBe('Ahmad test login');
    expect(plan.identities[0]?.roleFromName).toBe(true);
  });

  it('refuses a profile that cannot be attributed to a role at all', () => {
    // `roleKey('')` is the reserved `<anonymous>` spelling, which is a claim
    // about a logged-OUT visitor — the opposite of an unlabelled logged-in one.
    const plan = planRolePasses({ profiles: [profile('a', '   ', null)] });

    expect(plan.identities).toHaveLength(0);
    expect(plan.skipped[0]?.outcome).toBe('NEVER_ATTEMPTED');
    expect(plan.skipped[0]?.detail).toContain('claiming it is the anonymous visitor');
  });

  it('crawls a role ONCE when two profiles are the same role, and discloses the other', () => {
    const plan = planRolePasses({
      profiles: [profile('a', 'Admin one', 'admin'), profile('b', 'Admin two', 'admin')],
    });

    expect(plan.identities).toHaveLength(1);
    expect(plan.identities[0]?.profileName).toBe('Admin one');
    // Not a skipped ROLE: the role IS crawled. Recording an attempt for it
    // would also collide with RoleCrawlAttempt's unique (environment, role).
    expect(plan.skipped).toHaveLength(0);
    expect(plan.duplicates[0]).toEqual({
      role: 'admin',
      profileName: 'Admin two',
      keptProfileName: 'Admin one',
    });
  });

  it('discloses the cap as a COUNT and a REASON, never as a shorter list', () => {
    const plan = planRolePasses({
      profiles: Array.from({ length: 7 }, (_, i) => profile(`p${i}`, `P${i}`, `role-${i}`)),
      maxRolePasses: 2,
    });

    expect(plan.identities).toHaveLength(2);
    expect(plan.disclosure.atLeastMoreRoles).toBe(5);
    expect(plan.disclosure.cappedBy).toBe('MAX_ROLE_PASSES=2');
    expect(plan.disclosure.why).toContain('at least 5 more role(s) exist');
    // Every capped role is still an attempt row with a reason, so none of them
    // reads as a role with no extra surface.
    expect(plan.skipped.filter((skip) => skip.outcome === 'SKIPPED_BY_POLICY')).toHaveLength(5);
  });

  it('states the budget strategy rather than leaving the multiplier to be inferred', () => {
    const plan = planRolePasses({
      profiles: [profile('a', 'A', 'admin'), profile('b', 'B', 'member')],
    });

    expect(plan.disclosure.strategy).toBe('MULTIPLIED');
    expect(plan.disclosure.passes).toBe(3);
    expect(plan.disclosure.atLeastMoreRoles).toBeNull();
    expect(plan.disclosure.why).toContain('FULL page budget');
    expect(plan.disclosure.why).toContain('3× one crawl');
  });

  it('does not decide what the login module decides', () => {
    // MOCK_IDP on production, and a kind with no adapter, are both refused by
    // `signInWithProfile` — which reports WHICH stage refused with the remedy.
    // A second opinion here is the duplicate source of truth that made eight
    // GateRule kinds unsaveable for two slices.
    const plan = planRolePasses({ profiles: [profile('a', 'SSO', 'admin', 'MOCK_IDP')] });
    expect(plan.identities.map((identity) => identity.kind)).toEqual(['MOCK_IDP']);
  });

  it('defaults the cap to MAX_ROLE_PASSES', () => {
    const plan = planRolePasses({
      profiles: Array.from({ length: MAX_ROLE_PASSES + 1 }, (_, i) =>
        profile(`p${i}`, `P${i}`, `role-${i}`),
      ),
    });
    expect(plan.identities).toHaveLength(MAX_ROLE_PASSES);
    expect(plan.disclosure.atLeastMoreRoles).toBe(1);
  });
});

describe('the login verdict becomes the attempt outcome, unmodified', () => {
  it('maps every LoginFailure, so a tenth kind cannot ship as a bad password', () => {
    expect(Object.keys(ROLE_OUTCOME_FOR_LOGIN_FAILURE).sort()).toEqual([...LOGIN_FAILURES].sort());
  });

  it('keeps OURS and THEIRS apart: UNAVAILABLE is not a failed login', () => {
    expect(ROLE_OUTCOME_FOR_LOGIN_FAILURE.UNAVAILABLE).toBe('LOGIN_UNAVAILABLE');
    expect(ROLE_OUTCOME_FOR_LOGIN_FAILURE.REJECTED).toBe('LOGIN_FAILED');
    expect(ROLE_OUTCOME_FOR_LOGIN_FAILURE.BLOCKED).toBe('UNREACHABLE_BEHIND_BOT_PROTECTION');
    expect(ROLE_OUTCOME_FOR_LOGIN_FAILURE.REFUSED_BY_POLICY).toBe('SKIPPED_BY_POLICY');
  });
});

describe('mergeRolePasses — the two facts every node now carries', () => {
  it('writes requiresRoles for a route no anonymous visitor reached', () => {
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'] }),
      pass({ role: 'admin', routes: ['/', '/admin'] }),
    ];
    const { merged } = mergeRolePasses(passes, passes[0]!.crawl!.flowMap);

    const admin = merged.nodes.find((node) => node.route === '/admin');
    // The field the crawler has written `[]` into unconditionally since the
    // beginning, which is why the admin area was ABSENT rather than uncovered.
    expect(admin?.requiresRoles).toEqual(['admin']);
    // Empty is the field's documented meaning: reachable logged out.
    expect(merged.nodes.find((node) => node.route === '/')?.requiresRoles).toEqual([]);
  });

  it('labels the auth wall from the ANONYMOUS pass, not from the authenticated one', () => {
    /*
     * THE DEFECT, exactly. With a valid storageState the crawler is never
     * bounced, so the authenticated pass's /admin node has `behindAuth: false`
     * — and before this merge that was the only node there was, which is why
     * `behindAuth` was false everywhere a profile existed and the product could
     * not tell a customer where their own wall is.
     *
     * The two passes carry DIFFERENT state keys, because an admin sees
     * different content, so BOTH nodes are in the union and the authenticated
     * one is the node a test would be generated against.
     */
    const passes = [
      pass({
        role: ANONYMOUS_ROLE,
        routes: ['/', '/admin'],
        behindAuthRoutes: ['/admin'],
        stateKey: 'logged-out',
      }),
      pass({ role: 'admin', routes: ['/', '/admin'], stateKey: 'admin-shell' }),
    ];
    const { merged, report } = mergeRolePasses(passes, passes[0]!.crawl!.flowMap);

    const admin = merged.nodes.filter((node) => node.route === '/admin');
    expect(admin).toHaveLength(2);
    // The authenticated node — the one that was NOT bounced — is marked from
    // the anonymous pass's evidence about the same route.
    const authenticated = admin.find((node) => node.stateKey.includes('admin-shell'));
    expect(authenticated).toBeDefined();
    expect(authenticated?.behindAuth).toBe(true);
    expect(admin.every((node) => node.behindAuth)).toBe(true);
    expect(report.nodesBehindAuth).toBe(2);
  });

  it('does NOT assert a route is public when the anonymous pass never probed it', () => {
    // False is the field's DEFAULT, not a measurement. A route only the admin
    // pass reached keeps its own pass's value rather than being flipped either
    // way on evidence nobody gathered.
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'], stateKey: 'logged-out' }),
      pass({
        role: 'admin',
        routes: ['/', '/admin/billing'],
        behindAuthRoutes: ['/admin/billing'],
        stateKey: 'admin-shell',
      }),
    ];
    const { merged } = mergeRolePasses(passes, passes[0]!.crawl!.flowMap);

    const billing = merged.nodes.find((node) => node.route === '/admin/billing');
    expect(billing?.behindAuth).toBe(true);
    // And the honest half: it is attributed to the role that reached it, which
    // is what puts it in the denominator at all.
    expect(billing?.requiresRoles).toEqual(['admin']);
  });

  it('carries BOTH cells for a node two identities reached', () => {
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'] }),
      pass({ role: 'admin', routes: ['/'] }),
    ];
    const { merged } = mergeRolePasses(passes, passes[0]!.crawl!.flowMap);

    // ONE node, two access cells: was it reachable anonymously, and was it
    // reachable authenticated. Two nodes would double the denominator for
    // every shared page, which on a real application is most of them.
    expect(merged.nodes.filter((node) => node.route === '/')).toHaveLength(1);
    expect(merged.nodes[0]?.access?.map((cell) => cell.role)).toEqual([null, 'admin']);
  });

  it('lets NO node or cell in from a pass that did not contribute', () => {
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'] }),
      pass({
        role: 'admin',
        routes: ['/', '/admin', '/admin/billing'],
        contributed: false,
        outcome: 'CRAWLED',
        detail: 'held as REJECTED: a bot challenge was classified',
      }),
    ];
    const { merged, report, probes } = mergeRolePasses(passes, passes[0]!.crawl!.flowMap);

    expect(merged.nodes.map((node) => node.route)).toEqual(['/']);
    expect(report.rolesRefused).toBe(1);
    const admin = probes.find((probe) => probe.role === 'admin');
    expect(admin?.contributed).toBe(false);
    expect(admin?.observations).toEqual([]);
    expect(admin?.detail).toContain('bot challenge');
  });

  it('counts the surface that was previously absent', () => {
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/', '/pricing'] }),
      pass({ role: 'admin', routes: ['/', '/admin', '/admin/billing'] }),
    ];
    const { report } = mergeRolePasses(passes, passes[0]!.crawl!.flowMap);

    expect(report.routesOnlyAuthenticated).toBe(2);
    expect(report.routesOnlyAnonymous).toBe(1);
    expect(report.rolesContributing).toBe(2);
  });

  it('gives a journey the role it was walked as', () => {
    const passes = [pass({ role: 'admin', routes: ['/'] })];
    const { merged } = mergeRolePasses(passes, passes[0]!.crawl!.flowMap);
    for (const journey of merged.journeys) expect(journey.roles).toEqual(['admin']);
  });
});

describe('routesNewToRole — the number that must be NULL rather than 0', () => {
  it('counts the routes only this role reached', () => {
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'] }),
      pass({ role: 'admin', routes: ['/', '/admin', '/admin/billing'] }),
    ];
    expect(routesNewToRole(passes[1]!, passes)).toBe(2);
    expect(routesNewToRole(passes[0]!, passes)).toBe(0);
  });

  it('is NULL for a role whose crawl never ran, not 0', () => {
    // 0 would license "this role sees nothing extra", which is the fabrication
    // the attempt table exists to prevent.
    const passes = [pass({ role: ANONYMOUS_ROLE, routes: ['/'] }), pass({ role: 'admin' })];
    expect(routesNewToRole(passes[1]!, passes)).toBeNull();
  });

  it('ignores a held pass when deciding what is shared', () => {
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'] }),
      pass({ role: 'admin', routes: ['/admin'] }),
      pass({ role: 'ghost', routes: ['/admin'], contributed: false, outcome: 'CRAWLED' }),
    ];
    // Without the filter the bot wall's page would make /admin look shared and
    // the admin pass would report 0 new routes.
    expect(routesNewToRole(passes[1]!, passes)).toBe(1);
  });
});

describe('adjudicateUnion — the shrink test belongs to the union', () => {
  it('does not hold an anonymous pass against an authenticated baseline', () => {
    // 412 routes behind a login means the anonymous pass SHOULD be a fraction
    // of the accepted map. Adjudicating each pass against the baseline would
    // report the one pass that finds the wall as a collapse, every time.
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'] }),
      pass({ role: 'admin', routes: ['/', '/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i'] }),
    ];
    const acceptance = adjudicateUnion({
      passes,
      nodeCount: 11,
      previous: { version: 4, nodeCount: 11 },
    });
    expect(acceptance.state).toBe('ACCEPTED');
  });

  it('holds the union when it collapsed against the last accepted map', () => {
    const passes = [pass({ role: ANONYMOUS_ROLE, routes: ['/'] })];
    const acceptance = adjudicateUnion({
      passes,
      nodeCount: 1,
      previous: { version: 9, nodeCount: 412 },
    });
    expect(acceptance.state).not.toBe('ACCEPTED');
    expect(acceptance.degradations.map((entry) => entry.kind)).toContain('SHRANK');
  });

  it('sums the degradation counts across contributing passes', () => {
    const throttled = pass({ role: 'admin', routes: ['/'] });
    throttled.crawl!.degradationCounts.throttledCount = 3;
    const passes = [pass({ role: ANONYMOUS_ROLE, routes: ['/'] }), throttled];

    const acceptance = adjudicateUnion({ passes, nodeCount: 1, previous: null });
    expect(acceptance.degradations.find((entry) => entry.kind === 'RATE_LIMITED')?.count).toBe(3);
  });

  it('is NOT tainted by a pass that contributed nothing', () => {
    const held = pass({ role: 'ghost', routes: ['/'], contributed: false, outcome: 'CRAWLED' });
    held.crawl!.interstitial = {
      kind: 'BOT_CHALLENGE',
      signals: [],
      blocksEnumeration: true,
      reason: 'a challenge answered',
      degradation: null,
    } as unknown as InterstitialFinding;
    const passes = [pass({ role: ANONYMOUS_ROLE, routes: ['/', '/pricing'] }), held];

    // The wall never got into the union, so it has nothing to taint. A
    // conservative hold here would let one bad profile block a good
    // denominator.
    expect(adjudicateUnion({ passes, nodeCount: 2, previous: null }).state).toBe('ACCEPTED');
  });

  it('IS held when a CONTRIBUTING pass met a blocking wall', () => {
    const contributing = pass({ role: ANONYMOUS_ROLE, routes: ['/'] });
    contributing.crawl!.interstitial = {
      kind: 'BOT_CHALLENGE',
      signals: [],
      blocksEnumeration: true,
      reason: 'a challenge answered every URL',
      degradation: null,
    } as unknown as InterstitialFinding;

    expect(
      adjudicateUnion({ passes: [contributing], nodeCount: 1, previous: null }).state,
    ).not.toBe('ACCEPTED');
  });
});

describe('loginRoutesFrom — the wall is measured, not configured', () => {
  it('reads the wall off the anonymous pass’s bounces', () => {
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/', '/admin'], behindAuthRoutes: ['/admin'] }),
    ];
    expect(loginRoutesFrom(passes)).toContain('/login');
  });

  it('ignores an authenticated pass, which by definition is not bounced', () => {
    const passes = [
      pass({ role: 'admin', routes: ['/admin'], behindAuthRoutes: ['/admin'] }),
    ];
    expect(loginRoutesFrom(passes)).toEqual([]);
  });

  it('ignores a held anonymous pass, whose bounces are evidence about the crawl', () => {
    const passes = [
      pass({
        role: ANONYMOUS_ROLE,
        routes: ['/admin'],
        behindAuthRoutes: ['/admin'],
        contributed: false,
        outcome: 'CRAWLED',
      }),
    ];
    expect(loginRoutesFrom(passes)).toEqual([]);
  });
});

describe('staleRoleAttempts — a row for a deleted profile describes the past', () => {
  const row = (role: string, outcome: string, at: string | null) => ({
    role,
    outcome: outcome as Parameters<typeof staleRoleAttempts>[0][number]['outcome'],
    attemptedAt: at === null ? null : new Date(at),
  });

  it('names a stored role this environment can no longer be', () => {
    // The table is upserted per (environment, role), so deleting the profile
    // leaves a CRAWLED row with route counts on it rendering as current.
    const stale = staleRoleAttempts(
      [row('admin', 'CRAWLED', '2026-03-01T00:00:00.000Z'), row('member', 'CRAWLED', null)],
      [ANONYMOUS_ROLE, 'member'],
    );

    expect(stale.map((entry) => entry.role)).toEqual(['admin']);
    expect(stale[0]?.why).toContain('no longer has');
    expect(stale[0]?.why).toContain('2026-03-01');
  });

  it('says nothing about a role that was crawled this round', () => {
    expect(
      staleRoleAttempts([row('admin', 'CRAWLED', null)], [ANONYMOUS_ROLE, 'admin']),
    ).toEqual([]);
  });

  it('includes a role whose pass FAILED this round only if it is gone entirely', () => {
    // A role that failed is still a role we have an identity for, and its fresh
    // attempt row is the current truth. Calling that stale would bury the
    // failure under a staleness note about itself.
    expect(staleRoleAttempts([row('admin', 'LOGIN_FAILED', null)], ['admin'])).toEqual([]);
  });
});

describe('roleAttemptReport — the one answer that must be allowed to be NULL', () => {
  it('answers NO-extra-surface only for a crawl that actually finished', () => {
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'] }),
      pass({ role: 'admin', routes: ['/'] }),
    ];
    const report = roleAttemptReport(passes[1]!, passes);

    expect(report.routesNewToThisRole).toBe(0);
    expect(report.hadNoExtraSurface).toBe(true);
  });

  it('REFUSES to answer for a capped crawl that found nothing new', () => {
    /*
     * The tempting local version — `routesNewToThisRole === 0` — says TRUE
     * here, and the routes this pass did not reach are exactly the ones in
     * question. "We could not finish crawling as admin" and "admin sees nothing
     * extra" are opposite sentences.
     */
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'] }),
      pass({ role: 'admin', routes: ['/'], outcome: 'CRAWLED_PARTIAL' }),
    ];
    const report = roleAttemptReport(passes[1]!, passes);

    expect(report.routesNewToThisRole).toBe(0);
    expect(report.hadNoExtraSurface).toBeNull();
  });

  it('still answers YES-it-found-extra for a capped crawl, because finding is positive', () => {
    const passes = [
      pass({ role: ANONYMOUS_ROLE, routes: ['/'] }),
      pass({ role: 'admin', routes: ['/', '/admin'], outcome: 'CRAWLED_PARTIAL' }),
    ];
    expect(roleAttemptReport(passes[1]!, passes).hadNoExtraSurface).toBe(false);
  });

  it('REFUSES to answer for a role whose login failed', () => {
    const passes = [pass({ role: ANONYMOUS_ROLE, routes: ['/'] }), pass({ role: 'admin' })];
    const report = roleAttemptReport(passes[1]!, passes);

    expect(report.hadNoExtraSurface).toBeNull();
    expect(report.routesNewToThisRole).toBeNull();
    expect(report.routesReached).toBeNull();
    expect(report.outcome).toBe('LOGIN_FAILED');
  });
});
