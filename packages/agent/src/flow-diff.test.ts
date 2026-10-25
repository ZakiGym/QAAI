/**
 * Tests for the diff two doc comments and a screen claimed existed.
 *
 * `FlowMap.version` says "the cockpit diffs versions" in two places and no diff
 * code existed, so this suite's job is not "does it subtract two sets" — it is
 * "does it refuse to subtract them when the subtraction would be a lie". The
 * ways this feature is worse than nothing:
 *
 *   - "no drift" reported for a comparison that had no baseline, or whose
 *     baseline was a crawl held because the site was down
 *   - a route reported as REMOVED when a page budget simply stopped the crawl
 *     reaching it, which every capped crawl of a growing application would do
 *   - a staging crawl diffed against a production crawl and the deploy gap
 *     reported as drift
 *   - `newSurfaceWithoutTests` reported as 0 when testedness was never
 *     established — the value a dashboard paints green
 *   - `/orders/417` in a spec not recognised as a test for `/orders/:param`, so
 *     a tested route counted as untested new surface
 *   - a cap on the named lists applied without the total beside it
 *   - a control counted twice: once as a new route and once as a control added
 *   - two states of one route (`cart-empty` / `cart-full`) read as a page that
 *     lost its Pay button
 *
 * Each of those is a test below.
 */

import { describe, expect, it } from 'vitest';
import type { CapBite, FlowMap, FlowNode, Frontier, Selector } from '@qaai/shared';
import {
  FlowDiffRefused,
  MAX_NAMED_CHANGES,
  baselineIsMeasurable,
  controlIdentity,
  diffFlowMaps,
  driftWorthAnnouncing,
  type FlowDiffSide,
} from './flow-diff.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const selector = (name: string): Selector => ({
  strategy: 'ROLE',
  value: 'button',
  name,
  confidence: 0.9,
});

interface NodeSpec {
  route: string;
  stateKey?: string;
  controls?: Array<{ label: string; kind?: 'link' | 'button' | 'input' }>;
  forms?: Array<{ name: string; fields: string[]; submit?: string }>;
}

function node(spec: NodeSpec): FlowNode {
  return {
    id: `${spec.route}#${spec.stateKey ?? 'default'}`,
    route: spec.route,
    url: `https://app.example.com${spec.route}`,
    title: spec.route,
    stateKey: spec.stateKey ?? 'default',
    requiresRoles: [],
    behindAuth: false,
    forms: (spec.forms ?? []).map((form, index) => ({
      id: `form-${index}`,
      name: form.name,
      selector: selector(form.name),
      fields: form.fields.map((field) => ({
        name: field,
        label: field,
        inputType: 'text',
        required: false,
        selector: selector(field),
        semantic: 'freeform' as const,
      })),
      submit: form.submit ? selector(form.submit) : null,
    })),
    affordances: (spec.controls ?? []).map((control) => ({
      label: control.label,
      selector: selector(control.label),
      kind: control.kind ?? 'button',
    })),
    screenshotKey: null,
    a11yViolationCount: 0,
  };
}

function map(nodes: NodeSpec[], over: Partial<FlowMap> = {}): FlowMap {
  return {
    projectId: 'proj_1',
    environmentId: 'env_prod',
    version: 1,
    baseUrl: 'https://app.example.com',
    nodes: nodes.map(node),
    edges: [],
    journeys: [],
    features: [],
    exploredAt: '2026-10-24T03:00:00.000Z',
    truncatedReason: null,
    ...over,
  };
}

function side(over: Partial<FlowDiffSide> & { map: FlowMap }): FlowDiffSide {
  return {
    flowMapId: 'fm_current',
    version: over.map.version,
    environmentId: over.map.environmentId,
    acceptance: 'ACCEPTED',
    ...over,
  };
}

/** A crawl that stopped early via the oldest of the three signals. */
const TRUNCATED = { truncatedReason: 'the page budget of 60 ran out' };

const capBite: CapBite = {
  cap: 'PER_TEMPLATE_BUDGET',
  limit: 5,
  bites: 3,
  discarded: 12,
  scope: '/orders/:param',
  reason: 'the per-route-template page budget bit',
};

const frontier = (atLeastMoreUrls: number): Frontier => ({
  unvisitedQueued: atLeastMoreUrls,
  beyondDepth: 0,
  excluded: 0,
  offOrigin: 0,
  unreachable: 0,
  atLeastMoreUrls,
  sample: [],
  sampleTruncated: false,
});

// ─── The refusals ────────────────────────────────────────────────────────────

describe('a diff that must not produce a row', () => {
  it('THROWS on two different environments rather than returning a storable shape', () => {
    /*
     * Staging has four routes production does not. That is a deploy pending, not
     * drift, and there is no caveat that makes a count of it mean anything — so
     * this is the one condition that throws. A returned union would be a shape
     * the scheduler could destructure and persist by accident, which is the
     * exact defect class this module exists to close.
     */
    const current = side({ map: map([{ route: '/a' }], { environmentId: 'env_staging' }) });
    const baseline = side({
      flowMapId: 'fm_base',
      map: map([{ route: '/a' }], { environmentId: 'env_prod' }),
    });

    expect(() => diffFlowMaps({ current, baseline, tested: [] })).toThrow(FlowDiffRefused);
    try {
      diffFlowMaps({ current, baseline, tested: [] });
      expect.unreachable('the cross-environment diff must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FlowDiffRefused);
      expect((err as FlowDiffRefused).currentEnvironmentId).toBe('env_staging');
      expect((err as FlowDiffRefused).baselineEnvironmentId).toBe('env_prod');
      expect((err as Error).message).toContain('different environments');
    }
  });

  it('is UNCOMPARABLE with no baseline, and says so instead of "no drift"', () => {
    const diff = diffFlowMaps({
      current: side({ map: map([{ route: '/a' }, { route: '/b' }]) }),
      baseline: null,
      tested: [],
    });

    expect(diff.comparability).toBe('UNCOMPARABLE_NO_BASELINE');
    // The counts are NULL and not zero. A 2 here would be a drift event on the
    // first crawl of every customer's environment.
    expect(diff.counts).toBeNull();
    expect(diff.detail).toBeNull();
    expect(diff.baselineFlowMapId).toBeNull();
    expect(diff.why).toContain('first stored crawl');
    expect(driftWorthAnnouncing(diff)).toBe(false);
  });

  it.each(['CANDIDATE', 'REJECTED'] as const)(
    'is UNCOMPARABLE against a %s baseline — a degraded crawl invents the routes it missed',
    (acceptance) => {
      const diff = diffFlowMaps({
        current: side({ map: map([{ route: '/a' }, { route: '/b' }, { route: '/c' }]) }),
        baseline: side({
          flowMapId: 'fm_base',
          acceptance,
          map: map([{ route: '/a' }], { version: 1 }),
        }),
        tested: [],
      });

      expect(diff.comparability).toBe('UNCOMPARABLE_BASELINE_NOT_ACCEPTED');
      expect(diff.counts).toBeNull();
      expect(diff.why).toContain(acceptance);
      // The baseline id IS kept: the row has to be able to say what it declined
      // to compare against.
      expect(diff.baselineFlowMapId).toBe('fm_base');
    },
  );

  it.each(['CANDIDATE', 'REJECTED'] as const)(
    'is NOT_COMPARED when the CURRENT crawl is %s — a held crawl cannot retire the application',
    (acceptance) => {
      /*
       * THE DEFECT THIS PINS, and it is the mirror of the test above that the
       * first version of this module did not have. The baseline was adjudicated
       * and the current crawl was taken on trust, so a crawl that stopped at a
       * login wall could be the LEFT-hand side of a comparison.
       *
       * Note what the fixture does NOT do: it discloses no truncation. No
       * `truncatedReason`, no cap, an empty frontier — because that is exactly
       * what a failed login looks like. The crawl CONVERGED: it reached the
       * login page, found nothing else in scope, and stopped with an empty
       * queue. So the removal refusal in the truncation rule never fires, and
       * before this check existed the diff reported 400 routes REMOVED, `/login`
       * as new surface with no test against it, and stamped `comparedAt` on it.
       */
      const baselineRoutes = Array.from({ length: 400 }, (_, i) => ({ route: `/page-${i}` }));
      const diff = diffFlowMaps({
        current: side({ acceptance, map: map([{ route: '/login' }], { version: 8 }) }),
        baseline: side({
          flowMapId: 'fm_base',
          acceptance: 'ACCEPTED',
          map: map(baselineRoutes, { version: 7 }),
        }),
        tested: ['/page-1'],
      });

      expect(diff.comparability).toBe('NOT_COMPARED');
      // Every one of the six counts is unsayable, so there are none at all.
      expect(diff.counts).toBeNull();
      expect(diff.detail).toBeNull();
      expect(diff.why).toContain(acceptance);
      // The two opposite facts: nothing was retired, and nothing was announced.
      expect(diff.why).toContain('reports every route it never reached as removed');
      expect(driftWorthAnnouncing(diff)).toBe(false);
      // Both ids survive: the row has to say which crawl it declined to measure.
      expect(diff.currentFlowMapId).toBe('fm_current');
      expect(diff.baselineFlowMapId).toBe('fm_base');
    },
  );

  it('refuses a held CURRENT crawl before it reports "the first crawl of this environment"', () => {
    // Ordering, and it is load-bearing: a REJECTED first crawl is not "every
    // route in it is new", it is a crawl that is not a measurement. The
    // no-baseline sentence names the wrong fact about it.
    const diff = diffFlowMaps({
      current: side({ acceptance: 'REJECTED', map: map([{ route: '/login' }]) }),
      baseline: null,
      tested: null,
    });

    expect(diff.comparability).toBe('NOT_COMPARED');
    expect(diff.why).not.toContain('first stored crawl');
    expect(diff.baselineFlowMapId).toBeNull();
  });

  it('still compares FROM a null-acceptance current crawl, as it does a null baseline', () => {
    // The same reasoning as the baseline side: null is every row written before
    // adjudication, and refusing them would make every diff on an existing
    // install NOT_COMPARED indefinitely.
    const diff = diffFlowMaps({
      current: side({ acceptance: null, map: map([{ route: '/a' }, { route: '/b' }], { version: 2 }) }),
      baseline: side({ flowMapId: 'fm_base', acceptance: null, map: map([{ route: '/a' }], { version: 1 }) }),
      tested: [],
    });

    expect(diff.comparability).toBe('COMPARABLE');
    expect(diff.counts?.routesAdded).toBe(1);
  });

  it('accepts a null-acceptance baseline, because every pre-adjudication row is one', () => {
    // Refusing null would make the first diff after this ships UNCOMPARABLE for
    // every existing install, indefinitely. `selectFlowMap` ranks null between
    // accepted and candidate for the same reason.
    expect(baselineIsMeasurable(null)).toBe(true);
    expect(baselineIsMeasurable('ACCEPTED')).toBe(true);
    expect(baselineIsMeasurable('CANDIDATE')).toBe(false);
    expect(baselineIsMeasurable('REJECTED')).toBe(false);
  });
});

// ─── Truncation and removals ─────────────────────────────────────────────────

describe('removals from a truncated crawl', () => {
  const baseline = side({
    flowMapId: 'fm_base',
    map: map([{ route: '/a' }, { route: '/b' }, { route: '/gone' }], { version: 7 }),
  });

  it('reports removals from a clean crawl', () => {
    const diff = diffFlowMaps({
      current: side({ map: map([{ route: '/a' }, { route: '/b' }], { version: 8 }) }),
      baseline,
      tested: [],
    });

    expect(diff.comparability).toBe('COMPARABLE');
    expect(diff.counts?.routesRemoved).toBe(1);
    expect(diff.detail?.routesRemoved?.named).toEqual(['/gone']);
    expect(diff.detail?.truncation.removalsRefusedBecause).toBeNull();
  });

  it.each([
    ['truncatedReason', TRUNCATED],
    ['a cap that bit', { caps: [capBite] }],
    ['a frontier lower bound', { frontier: frontier(240) }],
  ])('REFUSES removals when the crawl disclosed truncation via %s', (_label, disclosure) => {
    /*
     * The defect: a page budget stops the crawl reaching /gone, and /gone is
     * filed as a deleted route. Every capped crawl of a growing application
     * would file a false deletion report, which is the fastest way to make a
     * drift feed unreadable.
     *
     * Three signals and not one, because `truncatedReason` is the weakest: a
     * per-template budget can discard every instance of /orders/:id while the
     * queue empties and the crawl calls itself converged.
     */
    const diff = diffFlowMaps({
      current: side({
        map: map([{ route: '/a' }, { route: '/b' }], { version: 8, ...disclosure }),
      }),
      baseline,
      tested: [],
    });

    expect(diff.comparability).toBe('COMPARABLE');
    // NULL, not 0 and not 1. "We cannot tell a deletion from a page we did not
    // reach" is the honest answer.
    expect(diff.counts?.routesRemoved).toBeNull();
    expect(diff.counts?.controlsRemoved).toBeNull();
    expect(diff.detail?.routesRemoved).toBeNull();
    // And the cap is DISCLOSED as a count and a reason, not as an adjective.
    expect(diff.detail?.truncation.removalsRefusedBecause).toContain('1 route(s)');
    expect(diff.detail?.truncation.currentTruncated).toBe(true);
    expect(diff.why).toContain('removals not reported');
  });

  it('still reports ADDITIONS from a truncated crawl, as a floor', () => {
    // A truncated crawl under-reports additions, which is a floor and defensible.
    // Refusing them too would mean a capped crawl could never report new surface
    // at all, and new surface with no tests is the number the product sells.
    const diff = diffFlowMaps({
      current: side({
        map: map([{ route: '/a' }, { route: '/b' }, { route: '/gone' }, { route: '/new' }], {
          version: 8,
          ...TRUNCATED,
        }),
      }),
      baseline,
      tested: [],
    });

    expect(diff.counts?.routesAdded).toBe(1);
    expect(diff.detail?.routesAdded.named).toEqual(['/new']);
    expect(diff.counts?.newSurfaceWithoutTests).toBe(1);
  });

  it('caveats a truncated BASELINE instead of refusing additions', () => {
    const diff = diffFlowMaps({
      current: side({ map: map([{ route: '/a' }, { route: '/b' }], { version: 8 }) }),
      baseline: side({
        flowMapId: 'fm_base',
        map: map([{ route: '/a' }], { version: 7, ...TRUNCATED }),
      }),
      tested: [],
    });

    expect(diff.detail?.truncation.baselineTruncated).toBe(true);
    expect(diff.why).toContain('may have existed all along');
  });

  it('carries the frontier lower bound through unchanged, and null is not zero', () => {
    const withFrontier = diffFlowMaps({
      current: side({ map: map([{ route: '/a' }], { version: 8, frontier: frontier(17) }) }),
      baseline: side({ flowMapId: 'fm_base', map: map([{ route: '/a' }], { version: 7 }) }),
      tested: [],
    });
    expect(withFrontier.detail?.truncation.currentAtLeastMoreUrls).toBe(17);

    const withoutFrontier = diffFlowMaps({
      current: side({ map: map([{ route: '/a' }], { version: 8 }) }),
      baseline: side({ flowMapId: 'fm_base', map: map([{ route: '/a' }], { version: 7 }) }),
      tested: [],
    });
    // A crawl that did no frontier accounting reports NULL. Zero would claim a
    // complete enumeration on behalf of a crawl that never counted.
    expect(withoutFrontier.detail?.truncation.currentAtLeastMoreUrls).toBeNull();
  });
});

// ─── Controls and forms ──────────────────────────────────────────────────────

describe('controls and forms', () => {
  it('counts a control added to an EXISTING route, and not the controls of a new one', () => {
    /*
     * The double-count: a new route arrives with six buttons on it, and the
     * report says "1 route added, 6 controls added" as though an existing page
     * had grown. The route is the surface item; its own controls came with it.
     */
    const diff = diffFlowMaps({
      current: side({
        map: map(
          [
            { route: '/checkout', controls: [{ label: 'Pay' }, { label: 'Apply coupon' }] },
            { route: '/refunds', controls: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
          ],
          { version: 8 },
        ),
      }),
      baseline: side({
        flowMapId: 'fm_base',
        map: map([{ route: '/checkout', controls: [{ label: 'Pay' }] }], { version: 7 }),
      }),
      tested: [],
    });

    expect(diff.counts?.routesAdded).toBe(1);
    expect(diff.counts?.controlsAdded).toBe(1);
    expect(diff.detail?.controlsAdded.named).toEqual([
      controlIdentity('/checkout', 'button', 'Apply coupon'),
    ]);
    expect(diff.counts?.routesChanged).toBe(1);
  });

  it('merges two states of one route rather than reporting a lost button', () => {
    /*
     * `stateKey` exists so one URL can be several states. The baseline saw
     * /cart full; this crawl saw it empty FIRST and full second. A per-node
     * comparison would report "Checkout" removed from the empty state — a
     * regression report about a feature that is fine.
     */
    const diff = diffFlowMaps({
      current: side({
        map: map(
          [
            { route: '/cart', stateKey: 'cart-empty', controls: [{ label: 'Browse' }] },
            { route: '/cart', stateKey: 'cart-full', controls: [{ label: 'Checkout' }] },
          ],
          { version: 8 },
        ),
      }),
      baseline: side({
        flowMapId: 'fm_base',
        map: map([{ route: '/cart', stateKey: 'cart-full', controls: [{ label: 'Checkout' }] }], {
          version: 7,
        }),
      }),
      tested: [],
    });

    expect(diff.counts?.controlsRemoved).toBe(0);
    expect(diff.counts?.controlsAdded).toBe(1);
  });

  it('reports a form that gained a field, separately from the control counts', () => {
    /*
     * A field added to a form that already has tests means every one of those
     * tests now submits an incomplete form. That is a different obligation from
     * "there is a new button", which is why it is counted on its own.
     */
    const diff = diffFlowMaps({
      current: side({
        map: map(
          [{ route: '/signup', forms: [{ name: 'signup', fields: ['email', 'password', 'vat'] }] }],
          { version: 8 },
        ),
      }),
      baseline: side({
        flowMapId: 'fm_base',
        map: map(
          [{ route: '/signup', forms: [{ name: 'signup', fields: ['email', 'password'] }] }],
          {
            version: 7,
          },
        ),
      }),
      tested: [],
    });

    expect(diff.counts?.routesChanged).toBe(1);
    expect(diff.detail?.formsChanged.total).toBe(1);
    expect(diff.detail?.formsChanged.named[0]?.change.fieldsAdded).toEqual(['vat']);
    expect(diff.detail?.formsChanged.named[0]?.change.fieldsRemoved).toEqual([]);
  });

  it('refuses a form field REMOVAL from a truncated crawl', () => {
    const diff = diffFlowMaps({
      current: side({
        map: map([{ route: '/signup', forms: [{ name: 'signup', fields: ['email'] }] }], {
          version: 8,
          ...TRUNCATED,
        }),
      }),
      baseline: side({
        flowMapId: 'fm_base',
        map: map([{ route: '/signup', forms: [{ name: 'signup', fields: ['email', 'vat'] }] }], {
          version: 7,
        }),
      }),
      tested: [],
    });

    // Nothing was ADDED and the removal is unsayable, so the route is not
    // reported as changed at all — rather than reported as changed with a zero.
    expect(diff.counts?.routesChanged).toBe(0);
    expect(diff.detail?.formsChanged.total).toBe(0);
  });

  it('counts a form submit button as a control, so a lost submit is not invisible', () => {
    const diff = diffFlowMaps({
      current: side({
        map: map([{ route: '/signup', forms: [{ name: 'signup', fields: ['email'] }] }], {
          version: 8,
        }),
      }),
      baseline: side({
        flowMapId: 'fm_base',
        map: map(
          [{ route: '/signup', forms: [{ name: 'signup', fields: ['email'], submit: 'Join' }] }],
          { version: 7 },
        ),
      }),
      tested: [],
    });

    expect(diff.counts?.controlsRemoved).toBe(1);
    expect(diff.detail?.controlsRemoved?.named).toEqual([
      controlIdentity('/signup', 'button', 'Join'),
    ]);
  });
});

// ─── The one number anyone acts on ───────────────────────────────────────────

describe('new surface with no tests', () => {
  const baseline = side({ flowMapId: 'fm_base', map: map([{ route: '/a' }], { version: 7 }) });

  it('is NULL, never 0, when testedness could not be established', () => {
    /*
     * THE MOST EXPENSIVE WRONG ANSWER IN THE PRODUCT. 0 is what a dashboard
     * paints green, and once written it is indistinguishable from "we looked and
     * everything new is tested".
     */
    const diff = diffFlowMaps({
      current: side({ map: map([{ route: '/a' }, { route: '/new' }], { version: 8 }) }),
      baseline,
      tested: null,
    });

    expect(diff.comparability).toBe('COMPARABLE');
    expect(diff.counts?.routesAdded).toBe(1);
    expect(diff.counts?.newSurfaceWithoutTests).toBeNull();
    expect(diff.detail?.untestedNewRoutes).toBeNull();
    expect(diff.why).toContain('NOT MEASURED');
    // And it does NOT fire an event: an unmeasured number is not a reason to
    // page somebody, and not a reason to stay quiet about either.
    expect(driftWorthAnnouncing(diff)).toBe(false);
  });

  it('builds the headline sentence without a space before its punctuation', () => {
    /*
     * The `why` string is stored on `SurfaceDriftRecord` and rendered in the
     * cockpit verbatim. Assembled as fragments joined by a space, two of them
     * began with a mark of punctuation and the sentence read "0 control(s) added
     * , 0 removed ; 0 form(s) changed fields." Cosmetic, and it is the sentence
     * the product's one number is carried in.
     *
     * Asserted on BOTH removal branches, because the null one dropped an empty
     * fragment and left the stray space in front of the semicolon on its own.
     */
    for (const current of [
      side({ map: map([{ route: '/a' }, { route: '/new' }], { version: 8 }) }),
      side({ map: map([{ route: '/a' }, { route: '/new' }], { version: 8, ...TRUNCATED }) }),
    ]) {
      const diff = diffFlowMaps({ current, baseline, tested: [] });
      expect(diff.why).not.toMatch(/ [,;]/);
      expect(diff.why).toMatch(/control\(s\) added[,;]/);
    }
  });

  it('is 0 — a real measurement — when every new route has a test', () => {
    const diff = diffFlowMaps({
      current: side({ map: map([{ route: '/a' }, { route: '/new' }], { version: 8 }) }),
      baseline,
      tested: ['/new'],
    });

    expect(diff.counts?.newSurfaceWithoutTests).toBe(0);
    expect(diff.detail?.untestedNewRoutes?.named).toEqual([]);
    expect(diff.why).toContain('New surface with no tests: 0.');
    expect(driftWorthAnnouncing(diff)).toBe(false);
  });

  it('recognises a concrete spec URL as a test for a template route', () => {
    // `/orders/417` in a spec IS a test for `/orders/:param`. Exact-key matching
    // would report a tested route as untested new surface, which is the claim
    // that makes a team close the tab.
    const diff = diffFlowMaps({
      current: side({ map: map([{ route: '/a' }, { route: '/orders/:id' }], { version: 8 }) }),
      baseline,
      tested: ['/orders/417'],
    });

    expect(diff.counts?.newSurfaceWithoutTests).toBe(0);
  });

  it('does not credit a parent route for its child', () => {
    // A test that navigates to /checkout has NOT been to /checkout/success.
    const diff = diffFlowMaps({
      current: side({
        map: map([{ route: '/a' }, { route: '/checkout/success' }], { version: 8 }),
      }),
      baseline,
      tested: ['/checkout'],
    });

    expect(diff.counts?.newSurfaceWithoutTests).toBe(1);
    expect(diff.detail?.untestedNewRoutes?.named).toEqual(['/checkout/success']);
    expect(driftWorthAnnouncing(diff)).toBe(true);
  });

  it('counts an existing route that GAINED surface, and not one that only lost it', () => {
    /*
     * A route that only lost a control is not new surface, and folding it in
     * would make the number go UP when the application got smaller.
     */
    const diff = diffFlowMaps({
      current: side({
        map: map(
          [
            { route: '/grew', controls: [{ label: 'Old' }, { label: 'New' }] },
            { route: '/shrank', controls: [{ label: 'Kept' }] },
          ],
          { version: 8 },
        ),
      }),
      baseline: side({
        flowMapId: 'fm_base',
        map: map(
          [
            { route: '/grew', controls: [{ label: 'Old' }] },
            { route: '/shrank', controls: [{ label: 'Kept' }, { label: 'Dropped' }] },
          ],
          { version: 7 },
        ),
      }),
      tested: [],
    });

    expect(diff.counts?.routesChanged).toBe(2);
    expect(diff.counts?.newSurfaceWithoutTests).toBe(1);
    expect(diff.detail?.untestedNewRoutes?.named).toEqual(['/grew']);
  });

  it('treats `/users/[id]` and `/users/:id` as one route', () => {
    // Two spellings of one surface reported as an addition and a removal is the
    // fork `canonicalRoute` exists to prevent.
    const diff = diffFlowMaps({
      current: side({ map: map([{ route: '/users/[id]' }], { version: 8 }) }),
      baseline: side({ flowMapId: 'fm_base', map: map([{ route: '/users/:id' }], { version: 7 }) }),
      tested: null,
    });

    expect(diff.counts?.routesAdded).toBe(0);
    expect(diff.counts?.routesRemoved).toBe(0);
  });
});

// ─── The disclosed cap on the named lists ────────────────────────────────────

describe('the named lists', () => {
  it('caps what it names AND reports the total, so "40" can never read as "all"', () => {
    const many = Array.from({ length: MAX_NAMED_CHANGES + 12 }, (_, i) => ({
      route: `/r${String(i).padStart(3, '0')}`,
    }));
    const diff = diffFlowMaps({
      current: side({ map: map([{ route: '/a' }, ...many], { version: 8 }) }),
      baseline: side({ flowMapId: 'fm_base', map: map([{ route: '/a' }], { version: 7 }) }),
      tested: [],
    });

    expect(diff.detail?.routesAdded.named).toHaveLength(MAX_NAMED_CHANGES);
    expect(diff.detail?.routesAdded.total).toBe(MAX_NAMED_CHANGES + 12);
    expect(diff.detail?.routesAdded.truncated).toBe(true);
    // The COUNT is the full number. A cap on the sample must never become a cap
    // on the measurement.
    expect(diff.counts?.routesAdded).toBe(MAX_NAMED_CHANGES + 12);
  });

  it('is deterministic, so two diffs of the same pair read identically', () => {
    const build = (): ReturnType<typeof diffFlowMaps> =>
      diffFlowMaps({
        current: side({
          map: map([{ route: '/b' }, { route: '/a' }, { route: '/c' }], { version: 8 }),
        }),
        baseline: side({ flowMapId: 'fm_base', map: map([{ route: '/a' }], { version: 7 }) }),
        tested: [],
      });

    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
    expect(build().detail?.routesAdded.named).toEqual(['/b', '/c']);
  });
});
