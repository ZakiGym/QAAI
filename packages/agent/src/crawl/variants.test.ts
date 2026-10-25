import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRAWL_POLICY,
  DIMENSION_AXIS,
  dimensionCellIdentity,
  SURFACE_KINDS,
  surfaceKey,
  type CrawlPolicy,
} from '@qaai/shared';
import {
  attributeVariants,
  BASELINE_DATA_PROFILE_KIND,
  BASELINE_DEVICE_KEY,
  BROWSER_PERMISSIONS,
  canonicalLocalePath,
  capabilitiesOf,
  collapseLocalisedRoutes,
  compareSignatures,
  DATA_PROFILE_KINDS,
  DATA_PROFILE_LABELS,
  DEFAULT_FAULT_STATES,
  DEVICE_PROFILES,
  deviceDimensionValue,
  FAULT_MECHANISMS,
  FAULT_STATE_KINDS,
  FAULT_STATES,
  IDEMPOTENT_METHODS,
  injectionDecision,
  missingCapabilities,
  NON_IDEMPOTENT_RULE,
  normaliseRequestPath,
  planDataVariants,
  planDeviceVariants,
  planFaultVariants,
  planLocaleVariants,
  planRenderVariants,
  planVariantCrawl,
  RENDER_AXES,
  RENDER_ENVIRONMENTS,
  requestMatcherFor,
  requestMatches,
  selectRepresentatives,
  variantContext,
  variantSignature,
  variantSignatureOf,
  variantSurfaceItems,
  VARIANT_AXES,
  VARIANT_AXIS_KINDS,
  VARIANT_AXIS_LABELS,
  VARIANT_AXIS_SURFACE_KIND,
  VARIANT_AXIS_SURFACE_RULE,
  VARIANT_CAPABILITIES,
  VARIANT_CAPABILITY_ADAPTER,
  VARIANT_CAPABILITY_LABELS,
  VARIANT_OUTCOME_KINDS,
  VARIANT_OUTCOMES,
  VARIANT_SETUP_CAPABILITY,
  VARIANT_SETUP_NEEDS_CONTEXT,
  type BrowserPermission,
  type DataProfile,
  type LocaleInput,
  type PlannedVariant,
  type VariantBrowserSurface,
  type VariantBudget,
  type VariantCapability,
  type VariantContext,
  type VariantCostModel,
  type VariantNode,
  type VariantObservation,
  type VariantPageFacts,
  type VariantRequestObservation,
} from './variants';

/**
 * What is and is not covered here.
 *
 * Everything in variants.ts is a pure function, so all of it is tested — which
 * is the whole reason the browser surface is an injected interface rather than
 * a `playwright.Page`. {@link VariantBrowserSurface} itself is exercised only
 * through {@link capabilitiesOf}: whether an adapter's `setPageZoom` really
 * sets the zoom is a question only a real browser can answer, and asserting on
 * a fake's behaviour here would prove the fake matches the fake.
 *
 * The tests below are grouped by the five register items, then by the two
 * cross-cutting mechanisms — the state signature and the attribution — because
 * those two are where a mistake would silently flatter the coverage number.
 */

const ALL_CAPABILITIES: readonly VariantCapability[] = VARIANT_CAPABILITIES;
const OWN_ORIGIN = 'https://app.test';

function node(route: string, over: Partial<VariantNode> = {}): VariantNode {
  return {
    id: over.id ?? `node-${route}`,
    route,
    stateKey: over.stateKey ?? 'default',
    forms: over.forms ?? 0,
    affordances: over.affordances === undefined ? 0 : over.affordances,
  };
}

function context(
  over: {
    nodes?: readonly VariantNode[];
    policy?: CrawlPolicy;
    available?: readonly VariantCapability[];
    ownOrigins?: readonly string[];
    budget?: Partial<VariantBudget>;
    cost?: Partial<VariantCostModel>;
  } = {},
): VariantContext {
  return variantContext({
    nodes: over.nodes ?? [node('/'), node('/orders'), node('/orders/:id')],
    policy: over.policy ?? DEFAULT_CRAWL_POLICY,
    available: over.available ?? ALL_CAPABILITIES,
    ownOrigins: over.ownOrigins ?? [OWN_ORIGIN],
    ...(over.budget ? { budget: over.budget } : {}),
    ...(over.cost ? { cost: over.cost } : {}),
  });
}

function facts(over: Partial<VariantPageFacts> = {}): VariantPageFacts {
  return {
    title: over.title === undefined ? 'Orders' : over.title,
    headings: over.headings ?? ['Orders'],
    controls: over.controls ?? ['New order'],
    routes: over.routes ?? ['/orders/:id'],
    ...(over.nodes ? { nodes: over.nodes } : {}),
    rowCount: over.rowCount === undefined ? 3 : over.rowCount,
    alerts: over.alerts ?? [],
    status: over.status === undefined ? 200 : over.status,
    busy: over.busy === undefined ? false : over.busy,
  };
}

function request(over: Partial<VariantRequestObservation> = {}): VariantRequestObservation {
  return {
    issuedFromRoute: over.issuedFromRoute ?? '/orders',
    method: over.method ?? 'GET',
    origin: over.origin ?? OWN_ORIGIN,
    path: over.path ?? '/api/orders',
    resourceType: over.resourceType === undefined ? 'xhr' : over.resourceType,
    occurrences: over.occurrences ?? 1,
    status: over.status === undefined ? 200 : over.status,
  };
}

function profile(over: Partial<DataProfile> = {}): DataProfile {
  return {
    key: over.key ?? 'Heavy-Account',
    kind: over.kind ?? 'HEAVY',
    label: over.label ?? 'a seeded account with 10,000 orders',
    identityRef: over.identityRef === undefined ? 'auth-1' : over.identityRef,
    available: over.available === undefined ? true : over.available,
    unavailableReason: over.unavailableReason ?? null,
    routes: over.routes ?? [],
    evidence: over.evidence ?? 'declared on the environment',
  };
}

function locale(tag: string, over: Partial<LocaleInput> = {}): LocaleInput {
  return {
    tag,
    rtl: over.rtl ?? false,
    isDefault: over.isDefault ?? false,
    available: over.available === undefined ? true : over.available,
  };
}

function observed(variant: PlannedVariant, page: VariantPageFacts | null): VariantObservation {
  return {
    variantId: variant.id,
    outcome: 'OBSERVED',
    facts: page,
    detail: 'ran',
  };
}

// ─── The axis vocabulary ─────────────────────────────────────────────────────

describe('the variant axis vocabulary', () => {
  it('keeps the compiler-enforced record and the list in parity', () => {
    // The keystone pattern: the `Record<VariantAxis, true>` cannot drift past
    // the compiler, and this is the half that catches a key the compiler
    // accepts but nobody added to the list.
    expect(VARIANT_AXIS_KINDS).toEqual([...VARIANT_AXES]);
  });

  it('gives every axis a label, a surface kind and a surface rule', () => {
    for (const axis of VARIANT_AXES) {
      expect(VARIANT_AXIS_LABELS[axis]).toBeTruthy();
      expect(VARIANT_AXIS_SURFACE_KIND[axis]).toBeTruthy();
      expect(VARIANT_AXIS_SURFACE_RULE[axis].why).toBeTruthy();
    }
  });

  it('mints no thirteenth surface kind', () => {
    // A dimension whose cells landed on a kind SURFACE_KINDS does not have
    // would be a second denominator.
    for (const axis of VARIANT_AXES) {
      expect(SURFACE_KINDS).toContain(VARIANT_AXIS_SURFACE_KIND[axis]);
    }
  });

  it('takes the device and locale axes from DIMENSION_AXIS rather than restating them', () => {
    // Two copies of this mapping is the fork that let a source-derived flow map
    // displace a crawl: the same fact spelled in two files drifts invisibly.
    expect(VARIANT_AXIS_SURFACE_KIND.DEVICE).toBe(DIMENSION_AXIS.DEVICE);
    expect(VARIANT_AXIS_SURFACE_KIND.LOCALE).toBe(DIMENSION_AXIS.LOCALE);
  });

  it('treats a bare difference as surface on the three state axes only', () => {
    expect(VARIANT_AXIS_SURFACE_RULE.DEVICE.stateIsSurface).toBe(false);
    expect(VARIANT_AXIS_SURFACE_RULE.LOCALE.stateIsSurface).toBe(false);
    expect(VARIANT_AXIS_SURFACE_RULE.RENDER.stateIsSurface).toBe(true);
    expect(VARIANT_AXIS_SURFACE_RULE.FAULT.stateIsSurface).toBe(true);
    expect(VARIANT_AXIS_SURFACE_RULE.DATA.stateIsSurface).toBe(true);
    // A control is surface everywhere: a mobile-only button is a thing a test
    // can press and nothing in the inventory names it.
    for (const axis of VARIANT_AXES) {
      expect(VARIANT_AXIS_SURFACE_RULE[axis].controlIsSurface).toBe(true);
    }
  });

  it('plans every axis — an axis with no planner is the drift this catches', () => {
    const plan = planVariantCrawl(context(), {
      locales: { locales: [locale('en', { isDefault: true }), locale('fr')] },
      faults: { requests: [request()] },
      data: { profiles: [profile()] },
      render: { permissionRoutes: new Map([['/orders', ['camera'] as BrowserPermission[]]]) },
    });
    expect(plan.plans.map((entry) => entry.axis)).toEqual([...VARIANT_AXES]);
    for (const axis of VARIANT_AXES) {
      expect(plan.variants.some((variant) => variant.axis === axis)).toBe(true);
    }
  });
});

// ─── Capabilities ────────────────────────────────────────────────────────────

describe('capabilities', () => {
  it('reports only the methods an injected surface actually implements', () => {
    const surface: VariantBrowserSurface = {
      setDevice: async () => {},
      emulateMedia: async () => {},
    };
    expect(capabilitiesOf(surface)).toEqual(['VIEWPORT', 'EMULATE_MEDIA']);
  });

  it('reports nothing for an empty surface rather than assuming the default', () => {
    expect(capabilitiesOf({})).toEqual([]);
  });

  it('names the adapter call and a label for every capability', () => {
    for (const capability of VARIANT_CAPABILITIES) {
      expect(VARIANT_CAPABILITY_LABELS[capability]).toBeTruthy();
      expect(VARIANT_CAPABILITY_ADAPTER[capability]).toBeTruthy();
    }
  });

  it('maps every setup kind the planners emit onto a capability', () => {
    const plan = planVariantCrawl(context(), {
      locales: { locales: [locale('fr')] },
      faults: { requests: [request()] },
      data: { profiles: [profile()] },
      render: { permissionRoutes: new Map([['/orders', ['camera'] as BrowserPermission[]]]) },
    });
    const kinds = new Set(plan.variants.map((variant) => variant.setup.kind));
    expect(kinds.size).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(VARIANT_CAPABILITIES).toContain(VARIANT_SETUP_CAPABILITY[kind]);
      // Every emitted setup also has to say whether it needs a fresh context,
      // or the cost model silently charges nothing for a browser launch.
      expect(typeof VARIANT_SETUP_NEEDS_CONTEXT[kind]).toBe('boolean');
    }
  });

  it('names the gap and not the whole required set', () => {
    expect(missingCapabilities(['ZOOM', 'VIEWPORT'], ['VIEWPORT'])).toEqual(['ZOOM']);
  });
});

// ─── Item 1: devices ─────────────────────────────────────────────────────────

describe('device enumeration', () => {
  it('names the viewport the existing crawl is hard-coded to as the baseline', () => {
    const baseline = DEVICE_PROFILES.find((device) => device.key === BASELINE_DEVICE_KEY);
    expect(baseline).toBeDefined();
    expect(baseline?.widthPx).toBe(1280);
    expect(baseline?.heightPx).toBe(900);
  });

  it('puts every mobile profile below the 768px breakpoint, with touch', () => {
    // The justification for a device being in the set at all is that it crosses
    // a layout breakpoint; a phone-width profile without touch would not
    // produce the bottom sheets and tap targets this axis exists to find.
    for (const device of DEVICE_PROFILES.filter((entry) => entry.userAgentClass === 'MOBILE')) {
      expect(device.widthPx).toBeLessThan(768);
      expect(device.touch).toBe(true);
    }
  });

  it('derives the dimension row from the profile the crawl was driven with', () => {
    const device = DEVICE_PROFILES[1]!;
    const row = deviceDimensionValue(device, 'CATALOGUE');
    expect(row.kind).toBe('DEVICE');
    expect(row.key).toBe(device.key);
    expect(row.source).toBe('CATALOGUE');
    expect(row.isDefault).toBe(false);
    expect(row.detail).toEqual({
      dimension: 'DEVICE',
      widthPx: device.widthPx,
      heightPx: device.heightPx,
      touch: device.touch,
      descriptor: device.descriptor,
    });
  });

  it('marks exactly the baseline device as the dimension default', () => {
    const defaults = DEVICE_PROFILES.filter(
      (device) => deviceDimensionValue(device, 'CATALOGUE').isDefault,
    );
    // Two defaults make `dimensionDenominator`'s default-cell arithmetic
    // ambiguous, and the database does not enforce one.
    expect(defaults.map((device) => device.key)).toEqual([BASELINE_DEVICE_KEY]);
  });

  it('does not re-crawl the baseline device', () => {
    const plan = planDeviceVariants(context());
    expect(plan.variants.some((variant) => variant.id.endsWith(BASELINE_DEVICE_KEY))).toBe(false);
  });

  it('takes one node per route template and discloses the siblings it dropped', () => {
    const ctx = context({
      nodes: [
        node('/orders', { id: 'a', stateKey: 'empty' }),
        node('/orders', { id: 'b', stateKey: 'populated' }),
        node('/orders', { id: 'c', stateKey: 'filtered' }),
      ],
    });
    const plan = planDeviceVariants(ctx);
    const bite = plan.caps.find((cap) => cap.cap === 'PER_TEMPLATE_BUDGET');
    expect(bite).toBeDefined();
    expect(bite?.bites).toBe(1);
    // Two of three states were not re-visited, and the number is the point: a
    // cap that bit without a discarded count is a fact about us, not about how
    // wrong the percentage is.
    expect(bite?.discarded).toBe(2);
    expect(plan.variants.filter((variant) => variant.base === '/orders')).toHaveLength(3);
  });

  it('discloses the sampling budget as a cap with a lower bound', () => {
    const ctx = context({
      nodes: [node('/'), node('/a'), node('/b'), node('/c')],
      budget: { nodesPerDevice: 2 },
    });
    const plan = planDeviceVariants(ctx);
    const bite = plan.caps.find((cap) => cap.cap === 'PAGE_BUDGET');
    expect(bite?.discarded).toBe(2);
    expect(bite?.reason).toContain('at least 2 more');
    expect(plan.atLeastMoreVariants).toBe(2);
  });

  it('always re-crawls the entry node, whatever its control count', () => {
    // The entry node is the navigation, and navigation is the single most
    // device-sensitive thing in any application.
    const ctx = context({
      nodes: [node('/', { id: 'home', affordances: 0 }), node('/busy', { affordances: 40 })],
      budget: { nodesPerDevice: 1 },
    });
    const plan = planDeviceVariants(ctx);
    expect(plan.variants.map((variant) => variant.base)).toContain('/');
  });

  it('ranks a node with no recorded affordance count below one recorded as having none', () => {
    // `null` is not `0`: "nobody counted" is not evidence that a page is empty,
    // and a ranking that read it as 0 would be the null-became-zero lie
    // choosing which pages get measured.
    const ctx = context({
      /*
       * `/` is the entry node and is always chosen; the ranking decides the
       * second slot, and it must not be the page nobody counted. The routes
       * are named so that the ALPHABETICAL tiebreak would pick the wrong one:
       * a ranking that read null as 0 ties the two and then takes `/aaa`,
       * which is what this asserts against.
       */
      nodes: [
        node('/'),
        node('/aaa-never-counted', { affordances: null }),
        node('/zzz-counted-zero', { affordances: 0 }),
      ],
      budget: { nodesPerDevice: 2 },
    });
    const plan = planDeviceVariants(ctx);
    const bases = new Set(plan.variants.map((variant) => variant.base));
    expect([...bases].sort()).toEqual(['/', '/zzz-counted-zero']);
    expect(plan.rule).toContain('no recorded affordance count');
  });

  it('builds the cell key with dimensionCellIdentity and never by hand', () => {
    const plan = planDeviceVariants(context({ nodes: [node('/checkout')] }));
    const variant = plan.variants.find((entry) => entry.setup.kind === 'DEVICE')!;
    const value = variant.setup.kind === 'DEVICE' ? variant.setup.profile.key : '';
    expect(variant.surfaceKey).toBe(
      surfaceKey(
        DIMENSION_AXIS.DEVICE,
        dimensionCellIdentity('/checkout', [{ dimension: 'DEVICE', value }]),
      ),
    );
    expect(variant.coordinates).toEqual([{ dimension: 'DEVICE', value }]);
  });

  it('holds a variant out — named and counted — when the harness cannot set a viewport', () => {
    const plan = planDeviceVariants(context({ available: [] }));
    expect(plan.runnable).toBe(0);
    expect(plan.heldOut).toBe(plan.variants.length);
    expect(plan.variants.length).toBeGreaterThan(0);
    const held = plan.variants[0]!;
    expect(held.exercise?.state).toBe('UNEXERCISABLE');
    expect(held.exercise?.reason).toBe('CAPABILITY_UNAVAILABLE');
    // A held-out variant costs no visit; charging for it would make the plan
    // look more expensive the less the harness can do.
    expect(plan.estimatedMillis).toBe(0);
  });

  it('records a policy-refused base in the exclusion ledger, not as a gap', () => {
    const ctx = context({ nodes: [node('/'), node('/logout')] });
    const plan = planDeviceVariants(ctx);
    expect(plan.variants.some((variant) => variant.base === '/logout')).toBe(false);
    const refusal = plan.refusedBases.find((entry) => entry.base === '/logout');
    expect(refusal?.kind).toBe('POLICY_EXCLUDE');
    expect(refusal?.rule).toContain('excludeGlobs');
    expect(refusal?.why).toContain('different fact from the route not existing');
  });

  it('records a refused base once, however many states of it the crawl saw', () => {
    const ctx = context({
      nodes: [node('/logout', { id: 'x' }), node('/logout', { id: 'y', stateKey: 'other' })],
    });
    expect(planDeviceVariants(ctx).refusedBases).toHaveLength(1);
  });

  it('classifies a refusal by an include list as NOT_INCLUDED, not as an exclusion', () => {
    const ctx = context({
      nodes: [node('/admin')],
      policy: { ...DEFAULT_CRAWL_POLICY, includeGlobs: ['/public/**'] },
    });
    expect(planDeviceVariants(ctx).refusedBases[0]?.kind).toBe('POLICY_NOT_INCLUDED');
  });
});

// ─── Item 2: render environments ─────────────────────────────────────────────

describe('render environments', () => {
  it('has an environment for every axis, keyed by itself', () => {
    for (const axis of RENDER_AXES) {
      expect(RENDER_ENVIRONMENTS[axis].kind).toBe(axis);
      expect(RENDER_ENVIRONMENTS[axis].requires.length).toBeGreaterThan(0);
      expect(RENDER_ENVIRONMENTS[axis].why).toBeTruthy();
    }
  });

  it('leaves every media field it is not setting as null', () => {
    // `forcedColors: 'none'` is an assertion that we drove the page with forced
    // colours explicitly off. Claiming it when the adapter never touched the
    // setting is the measured-but-not-measured lie in miniature.
    const dark = RENDER_ENVIRONMENTS.DARK_MODE.media;
    expect(dark.colorScheme).toBe('dark');
    expect(dark.reducedMotion).toBeNull();
    expect(dark.forcedColors).toBeNull();
    expect(dark.media).toBeNull();
  });

  it('reports 200% zoom UNAVAILABLE rather than skipping the axis when CDP is absent', () => {
    const available = ALL_CAPABILITIES.filter((capability) => capability !== 'ZOOM');
    const plan = planRenderVariants(context({ available }), { axes: ['ZOOM_200', 'DARK_MODE'] });
    const zoom = plan.variants.filter((variant) => variant.setup.kind === 'ZOOM');
    expect(zoom.length).toBeGreaterThan(0);
    for (const variant of zoom) {
      expect(variant.exercise?.state).toBe('UNEXERCISABLE');
      expect(variant.exercise?.reason).toBe('CAPABILITY_UNAVAILABLE');
      expect(variant.exercise?.detail).toContain('Emulation.setPageScaleFactor');
    }
    // The other axis is unaffected: one missing capability must not take the
    // whole render pass with it.
    expect(
      plan.variants.some((variant) => variant.setup.kind === 'MEDIA' && variant.exercise === null),
    ).toBe(true);
  });

  it('invents no permission cell where nothing declares a permission', () => {
    const plan = planRenderVariants(context(), { axes: ['PERMISSION_DENIED'] });
    expect(plan.variants).toHaveLength(0);
    expect(plan.rule).toContain('no route among the sampled template(s) is declared');
  });

  it('plans one cell per declared permission, granted and denied kept apart', () => {
    const permissionRoutes = new Map<string, readonly BrowserPermission[]>([['/scan', ['camera']]]);
    const plan = planRenderVariants(context({ nodes: [node('/scan')] }), {
      axes: ['PERMISSION_GRANTED', 'PERMISSION_DENIED'],
      permissionRoutes,
    });
    expect(plan.variants).toHaveLength(2);
    const granted = plan.variants.find((variant) => variant.id.includes('PERMISSION_GRANTED'))!;
    const denied = plan.variants.find((variant) => variant.id.includes('PERMISSION_DENIED'))!;
    expect(granted.setup.kind === 'PERMISSIONS' && granted.setup.granted).toEqual(['camera']);
    // Denial is the absence of a grant, which is what Playwright gives you —
    // and it is the state a real user who clicked "Block" sees for ever.
    expect(denied.setup.kind === 'PERMISSIONS' && denied.setup.granted).toEqual([]);
    expect(granted.surfaceKey).not.toBe(denied.surfaceKey);
  });

  it('knows about the permissions worth a variant', () => {
    expect(BROWSER_PERMISSIONS).toContain('camera');
    expect(BROWSER_PERMISSIONS).toContain('clipboard-read');
    expect(BROWSER_PERMISSIONS).toContain('notifications');
    expect(BROWSER_PERMISSIONS).toContain('geolocation');
  });

  it('owns offline on exactly one axis, so one screen does not mint two items', () => {
    expect(RENDER_AXES).toContain('OFFLINE');
    expect(FAULT_STATES as readonly string[]).not.toContain('OFFLINE');
    expect(RENDER_ENVIRONMENTS.OFFLINE.why).toContain('deliberately NOT by the fault axis');
  });

  it('says which axes a structural signature cannot answer', () => {
    const plan = planRenderVariants(context(), { axes: ['DARK_MODE', 'PRINT'] });
    expect(RENDER_ENVIRONMENTS.DARK_MODE.differenceKind).toBe('VISUAL_ONLY');
    expect(RENDER_ENVIRONMENTS.PRINT.differenceKind).toBe('STRUCTURAL');
    expect(plan.rule).toContain('VISUAL_ONLY');
    expect(plan.rule).toContain('must never be');
  });
});

// ─── Item 3: locales ─────────────────────────────────────────────────────────

describe('the locale axis', () => {
  const locales = [locale('en', { isDefault: true }), locale('fr'), locale('pt-BR')];

  it('strips only a segment a declared locale claims', () => {
    expect(canonicalLocalePath('/fr/pricing', locales)).toMatchObject({
      template: '/pricing',
      locale: 'fr',
    });
    // `/fr` is an ordinary route segment in an app that does not declare `fr`,
    // and stripping it blind would delete a route from the inventory.
    expect(canonicalLocalePath('/fr/pricing', [locale('en', { isDefault: true })])).toMatchObject({
      template: '/fr/pricing',
      locale: null,
    });
  });

  it('returns the declared spelling and flags that the path differed', () => {
    // The coordinate value has to be the dimension row's key, or the cell is a
    // new cell every time somebody types a URL differently.
    expect(canonicalLocalePath('/PT-br/pricing', locales)).toMatchObject({
      template: '/pricing',
      locale: 'pt-BR',
      spellingDiffers: true,
    });
    expect(canonicalLocalePath('/pt-BR/pricing', locales).spellingDiffers).toBe(false);
  });

  it('treats a bare locale prefix as the home route', () => {
    expect(canonicalLocalePath('/fr', locales).template).toBe('/');
    expect(canonicalLocalePath('/fr/', locales).template).toBe('/');
  });

  it('strips nothing for a mechanism that is not in the path', () => {
    for (const mechanism of ['ACCEPT_LANGUAGE', 'COOKIE', 'SUBDOMAIN', 'QUERY_PARAM'] as const) {
      expect(canonicalLocalePath('/fr/pricing', locales, mechanism)).toMatchObject({
        template: '/fr/pricing',
        locale: null,
      });
    }
  });

  it('collapses twelve localised paths onto one template and says how many', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => locale(`l${index}`));
    const paths = twelve.map((entry) => `/${entry.tag}/pricing`);
    const result = collapseLocalisedRoutes(paths, twelve);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.locales).toHaveLength(12);
    expect(result.collapsed).toBe(12);
    // Collapsing shrinks the route denominator, and every operation that
    // shrinks a denominator has to be disclosed or it is indistinguishable
    // from truncation.
    expect(result.rule).toContain('12 localised path(s) collapsed onto 1 route template(s)');
  });

  it('adds cells on the locale axis and ZERO routes', () => {
    const twelve = [
      locale('en', { isDefault: true }),
      ...Array.from({ length: 12 }, (_, index) => locale(`l${index}`)),
    ];
    const plan = planLocaleVariants(context({ nodes: [node('/pricing')] }), { locales: twelve });
    expect(plan.variants).toHaveLength(12);
    for (const variant of plan.variants) {
      expect(variant.surfaceKind).toBe(DIMENSION_AXIS.LOCALE);
      expect(variant.base).toBe('/pricing');
      expect(variant.surfaceKind).not.toBe('ROUTE');
    }
    expect(new Set(plan.variants.map((variant) => variant.base)).size).toBe(1);
    expect(plan.rule).toContain('ZERO routes');
  });

  it('mints one cell when a localised path and its canonical both appear', () => {
    // `/pricing` and `/fr/pricing` collapse onto the same base; planning both
    // would put a duplicate item in the denominator, which is the
    // multiplication defect arriving by the back door.
    const plan = planLocaleVariants(
      context({ nodes: [node('/pricing'), node('/fr/pricing', { id: 'fr' })] }),
      { locales },
    );
    const keys = plan.variants.map((variant) => variant.surfaceKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.variants.filter((variant) => variant.id.endsWith('fr'))).toHaveLength(1);
  });

  it('counts a locale this environment cannot serve instead of reporting it uncovered', () => {
    const plan = planLocaleVariants(context({ nodes: [node('/pricing')] }), {
      locales: [locale('en', { isDefault: true }), locale('ar', { available: false, rtl: true })],
    });
    expect(plan.variants).toHaveLength(1);
    expect(plan.variants[0]?.exercise?.state).toBe('UNEXERCISABLE');
    expect(plan.variants[0]?.exercise?.reason).toBe('DIMENSION_UNAVAILABLE');
    expect(plan.variants[0]?.why).toContain('RTL');
  });

  it('does not re-crawl the default locale', () => {
    const plan = planLocaleVariants(context({ nodes: [node('/pricing')] }), { locales });
    expect(plan.variants.some((variant) => variant.id.endsWith('en'))).toBe(false);
  });

  it('carries the URL to navigate to for a path-prefix app', () => {
    const plan = planLocaleVariants(context({ nodes: [node('/pricing'), node('/')] }), {
      locales,
      baseUrl: 'https://app.test/',
    });
    const urls = plan.variants
      .filter((variant) => variant.setup.kind === 'LOCALE')
      .map((variant) => (variant.setup.kind === 'LOCALE' ? variant.setup.url : null));
    expect(urls).toContain('https://app.test/fr/pricing');
    // The home route is `/fr`, not `/fr/`.
    expect(urls).toContain('https://app.test/fr');
  });
});

// ─── Item 4: fault injection ─────────────────────────────────────────────────

describe('fault injection', () => {
  it('keeps the state list and its compiler record in parity', () => {
    expect(FAULT_STATE_KINDS).toEqual([...FAULT_STATES]);
  });

  it('gives every state a mechanism, and holds a spinner apart from a failure', () => {
    for (const state of FAULT_STATES) {
      expect(FAULT_MECHANISMS[state].detail).toBeTruthy();
    }
    // LOADING is a DELAY and not an ABORT: an abort produces the ERROR state,
    // and conflating them would report a spinner where the app shows a failure.
    expect(FAULT_MECHANISMS.LOADING.kind).toBe('DELAY');
    expect(FAULT_MECHANISMS.ERROR.kind).toBe('STATUS');
    expect(FAULT_MECHANISMS.ERROR.status).toBe(500);
    expect(FAULT_MECHANISMS.FORBIDDEN.status).toBe(403);
    expect(FAULT_MECHANISMS.EMPTY.body).toBe('EMPTY_COLLECTION');
    expect(DEFAULT_FAULT_STATES).toEqual(['ERROR', 'EMPTY', 'SLOW']);
  });

  it('never injects against a non-idempotent request', () => {
    // Failing a POST means first issuing it, which can leave a real order, a
    // real charge and a real email behind.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      const decision = injectionDecision(request({ method }), [OWN_ORIGIN]);
      expect(decision.admitted).toBe(false);
      expect(decision.rule).toBe(NON_IDEMPOTENT_RULE);
    }
    for (const method of IDEMPOTENT_METHODS) {
      expect(injectionDecision(request({ method }), [OWN_ORIGIN]).admitted).toBe(true);
    }
  });

  it('records a refused request as REFUSED with its rule, never as absent', () => {
    const plan = planFaultVariants(context(), {
      requests: [request({ method: 'POST', path: '/api/orders' })],
    });
    expect(plan.variants).toHaveLength(1);
    const variant = plan.variants[0]!;
    expect(variant.exercise?.state).toBe('REFUSED');
    expect(variant.exercise?.rule).toBe(NON_IDEMPOTENT_RULE);
    expect(variant.exercise?.detail).toContain('POST /api/orders');
    expect(plan.runnable).toBe(0);
    expect(plan.heldOut).toBe(1);
  });

  it('refuses an off-origin request and names the origin', () => {
    const decision = injectionDecision(request({ origin: 'https://cdn.vendor.test' }), [
      OWN_ORIGIN,
    ]);
    expect(decision.admitted).toBe(false);
    expect(decision.rule).toContain('https://cdn.vendor.test');
    expect(decision.rule).toContain("somebody else's surface");
  });

  it('never carries a query value or a fragment into a stored matcher', () => {
    // A matcher is stored, rendered in a cockpit and exported; `?token=…` and
    // `?q=my+diagnosis` are equally unacceptable there.
    expect(normaliseRequestPath('/api/orders?token=abc#frag')).toBe('/api/orders');
    const matcher = requestMatcherFor(request({ path: '/api/orders?email=a@b.test' }));
    expect(matcher.pathGlob).toBe('/api/orders');
    expect(JSON.stringify(matcher)).not.toContain('a@b.test');
  });

  it('matches a request with the one shared glob implementation', () => {
    const matcher = { method: 'GET', pathGlob: '/api/**', issuedFromRoute: '/orders' };
    expect(requestMatches(matcher, request({ path: '/api/orders/1' }))).toBe(true);
    expect(requestMatches(matcher, request({ path: '/static/app.js' }))).toBe(false);
    expect(requestMatches(matcher, request({ method: 'HEAD' }))).toBe(false);
    // The query is stripped before matching, so a glob never has to anticipate
    // one — and a request with a query cannot escape a matcher that claims it.
    expect(requestMatches(matcher, request({ path: '/api/orders?page=2' }))).toBe(true);
  });

  it('discloses the per-route request budget with what it discarded', () => {
    const plan = planFaultVariants(context({ budget: { requestsPerRoute: 1 } }), {
      requests: [
        request({ path: '/api/a' }),
        request({ path: '/api/b' }),
        request({ path: '/api/c' }),
      ],
      states: ['ERROR'],
    });
    const bite = plan.caps.find((cap) => cap.scope === 'FAULT requests per route');
    expect(bite?.bites).toBe(1);
    expect(bite?.discarded).toBe(2);
    expect(bite?.reason).toContain('not found absent');
    expect(plan.atLeastMoreVariants).toBe(2);
  });

  it('discloses the per-request state budget against the states it can produce', () => {
    const plan = planFaultVariants(context({ budget: { statesPerRequest: 1 } }), {
      requests: [request()],
      states: ['ERROR', 'EMPTY', 'SLOW', 'FORBIDDEN'],
    });
    expect(plan.variants).toHaveLength(1);
    const bite = plan.caps.find((cap) => cap.scope === 'FAULT states per request');
    expect(bite?.discarded).toBe(3);
    expect(bite?.reason).toContain(`of ${FAULT_STATES.length} states`);
  });

  it('discloses the route budget and what it left unenumerated', () => {
    const plan = planFaultVariants(context({ budget: { faultRoutes: 1 } }), {
      requests: [
        request({ issuedFromRoute: '/orders', path: '/api/a' }),
        request({ issuedFromRoute: '/orders', path: '/api/b' }),
        request({ issuedFromRoute: '/invoices', path: '/api/c' }),
      ],
      states: ['ERROR'],
    });
    const bite = plan.caps.find((cap) => cap.scope === 'FAULT variant pass');
    expect(bite?.discarded).toBe(1);
    expect(plan.variants.every((variant) => variant.base === '/orders')).toBe(true);
  });

  it('ranks the requests the page renders from above the ones it does not', () => {
    const plan = planFaultVariants(context({ budget: { requestsPerRoute: 2 } }), {
      requests: [
        request({ path: '/static/logo.png', resourceType: 'image' }),
        request({ path: '/api/orders', resourceType: 'xhr' }),
        request({ path: '/orders', resourceType: 'document' }),
      ],
      states: ['ERROR'],
    });
    const paths = plan.variants.map((variant) =>
      variant.setup.kind === 'FAULT' ? variant.setup.match.pathGlob : '',
    );
    expect(paths).toEqual(['/orders', '/api/orders']);
  });

  it('ranks an unrecorded resource type below every recorded one', () => {
    // Treating `null` as 'other' would be an assumption about a request nobody
    // classified; it ranks last among the recorded kinds instead.
    const plan = planFaultVariants(context({ budget: { requestsPerRoute: 1 } }), {
      requests: [
        request({ path: '/api/unknown', resourceType: null }),
        request({ path: '/api/known', resourceType: 'stylesheet' }),
      ],
      states: ['ERROR'],
    });
    const chosen = plan.variants[0]!;
    expect(chosen.setup.kind === 'FAULT' && chosen.setup.match.pathGlob).toBe('/api/known');
  });

  it('holds the whole axis out, named, when the harness cannot intercept', () => {
    const available = ALL_CAPABILITIES.filter((capability) => capability !== 'ROUTE_INTERCEPT');
    const plan = planFaultVariants(context({ available }), { requests: [request()] });
    expect(plan.variants.length).toBeGreaterThan(0);
    expect(plan.runnable).toBe(0);
    expect(plan.variants[0]?.exercise?.reason).toBe('CAPABILITY_UNAVAILABLE');
  });

  it('refuses to inject on a route the policy excludes', () => {
    const plan = planFaultVariants(context(), {
      requests: [request({ issuedFromRoute: '/logout', path: '/api/session' })],
    });
    expect(plan.variants).toHaveLength(0);
    expect(plan.refusedBases[0]?.base).toBe('/logout');
    expect(plan.refusedBases[0]?.why).toContain(
      'different fact from the route having no failure states',
    );
  });

  it('charges the delay a waiting mechanism costs', () => {
    const slow = planFaultVariants(context(), { requests: [request()], states: ['SLOW'] });
    const error = planFaultVariants(context(), { requests: [request()], states: ['ERROR'] });
    expect(slow.estimatedMillis).toBe(error.estimatedMillis + FAULT_MECHANISMS.SLOW.delayMillis!);
  });

  it('plans nothing from an empty network inventory, and says why', () => {
    const plan = planFaultVariants(context(), { requests: [] });
    expect(plan.variants).toHaveLength(0);
    expect(plan.rule).toContain('a request nothing was seen to make cannot be failed');
  });
});

// ─── Item 5: data profiles ───────────────────────────────────────────────────

describe('data-state profiles', () => {
  it('names the states one account cannot show you', () => {
    for (const kind of DATA_PROFILE_KINDS) {
      expect(DATA_PROFILE_LABELS[kind]).toBeTruthy();
    }
    expect(DATA_PROFILE_KINDS).toContain('EMPTY');
    expect(DATA_PROFILE_KINDS).toContain('HEAVY');
    expect(DATA_PROFILE_KINDS).toContain('TRIAL_EXPIRED');
    expect(BASELINE_DATA_PROFILE_KIND).toBe('TYPICAL');
  });

  it('holds out a profile nothing can sign in as', () => {
    const plan = planDataVariants(context({ nodes: [node('/orders')] }), {
      profiles: [profile({ identityRef: null })],
    });
    expect(plan.variants).toHaveLength(1);
    expect(plan.variants[0]?.exercise?.state).toBe('UNEXERCISABLE');
    expect(plan.variants[0]?.exercise?.reason).toBe('NEEDS_DISPOSABLE_DATA');
    expect(plan.runnable).toBe(0);
  });

  it('keeps an unavailable profile’s own reason rather than inventing one', () => {
    const plan = planDataVariants(context({ nodes: [node('/orders')] }), {
      profiles: [
        profile({ available: false, unavailableReason: 'REAL_WORLD_SIDE_EFFECT' }),
        profile({ key: 'other', available: false, unavailableReason: null }),
      ],
    });
    expect(plan.variants[0]?.exercise?.reason).toBe('REAL_WORLD_SIDE_EFFECT');
    // No reason recorded falls back to the dimension reason, never to a claim
    // that the profile is fine.
    expect(plan.variants[1]?.exercise?.reason).toBe('DIMENSION_UNAVAILABLE');
  });

  it('does not re-crawl the baseline profile', () => {
    const plan = planDataVariants(context({ nodes: [node('/orders')] }), {
      profiles: [profile({ key: 'typical', kind: 'TYPICAL' }), profile({ key: 'heavy' })],
    });
    expect(plan.variants.map((variant) => variant.id.split('#')[1])).toEqual(['data=heavy']);
    expect(plan.rule).toContain('Attributed against the typical profile');
  });

  it('plans a declared route list against exactly those routes', () => {
    const plan = planDataVariants(
      context({ nodes: [node('/orders'), node('/invoices'), node('/settings')] }),
      { profiles: [profile({ routes: ['/invoices'] })] },
    );
    expect(plan.variants.map((variant) => variant.base)).toEqual(['/invoices']);
    expect(plan.rule).toContain('1 of them named the routes they change');
  });

  it('subjects a declared route list to the same budget, with the same disclosure', () => {
    // A profile declaring 500 routes must not quietly buy itself a bigger
    // budget than the sampling rule gives every other profile.
    const plan = planDataVariants(
      context({
        nodes: [node('/a'), node('/b'), node('/c')],
        budget: { nodesPerDataProfile: 1 },
      }),
      { profiles: [profile({ routes: ['/a', '/b', '/c'] })] },
    );
    expect(plan.variants).toHaveLength(1);
    const bite = plan.caps.find((cap) => (cap.scope ?? '').includes('Heavy-Account'));
    expect(bite?.discarded).toBe(2);
  });

  it('reads an unstated route list as UNKNOWN and not as NONE', () => {
    const plan = planDataVariants(context({ nodes: [node('/orders')] }), {
      profiles: [profile({ routes: [] })],
    });
    expect(plan.variants).toHaveLength(1);
    expect(plan.rule).toContain('UNKNOWN and not NONE');
  });

  it('keeps the profile key in the customer’s own spelling', () => {
    // Folding the case would merge two profiles and shrink the denominator.
    const plan = planDataVariants(context({ nodes: [node('/orders')] }), {
      profiles: [profile({ key: 'Trial-EXPIRED', kind: 'TRIAL_EXPIRED' })],
    });
    expect(plan.variants[0]?.surfaceKey).toContain('Trial-EXPIRED');
    expect(plan.variants[0]?.surfaceKind).toBe(VARIANT_AXIS_SURFACE_KIND.DATA);
  });

  it('excludes a policy-refused route from a declared profile too', () => {
    const plan = planDataVariants(context({ nodes: [node('/logout'), node('/orders')] }), {
      profiles: [profile({ routes: ['/logout', '/orders'] })],
    });
    expect(plan.variants.map((variant) => variant.base)).toEqual(['/orders']);
    expect(plan.refusedBases.map((entry) => entry.base)).toEqual(['/logout']);
  });
});

// ─── The state signature ─────────────────────────────────────────────────────

describe('the state signature', () => {
  it('never renders an uncounted row count as zero', () => {
    // THE defect this function exists to avoid: a null that became a 0 would
    // report an injected 500 as identical to a working page whenever the pass
    // failed to count rows.
    const uncounted = variantSignature(facts({ rowCount: null }));
    const none = variantSignature(facts({ rowCount: 0 }));
    const some = variantSignature(facts({ rowCount: 7 }));
    expect(uncounted).toContain('rows=?');
    expect(none).toContain('rows=none');
    expect(some).toContain('rows=some');
    expect(uncounted).not.toBe(none);
  });

  it('treats two non-zero row counts as the same state', () => {
    // "17 orders" and "18 orders" are the same state; "0 orders" and "some" are
    // not. A signature that counted rows would report every list as a new
    // state on every crawl.
    expect(variantSignature(facts({ rowCount: 17 }))).toBe(
      variantSignature(facts({ rowCount: 18 })),
    );
  });

  it('prints a question mark for an unrecorded status and busy flag', () => {
    const signature = variantSignature(facts({ status: null, busy: null }));
    expect(signature).toContain('s=?');
    expect(signature).toContain('busy=?');
    expect(signature).not.toContain('s=200');
  });

  it('ignores the order controls were found in', () => {
    // A control moving into a hamburger menu is not new surface, and a
    // signature that changed on reorder would fill the report with findings
    // that are all the same finding.
    expect(variantSignature(facts({ controls: ['a', 'b'] }))).toBe(
      variantSignature(facts({ controls: ['b', 'a'] })),
    );
  });

  it('changes when a control, a heading or an alert changes', () => {
    const base = variantSignature(facts());
    expect(variantSignature(facts({ controls: ['New order', 'Filter'] }))).not.toBe(base);
    expect(variantSignature(facts({ headings: ['Nothing here yet'] }))).not.toBe(base);
    expect(variantSignature(facts({ alerts: ['Something went wrong'] }))).not.toBe(base);
    expect(variantSignature(facts({ title: null }))).not.toBe(base);
  });

  it('separates the digest parts, so two different pages cannot collide', () => {
    // Without a separator byte ['ab','c'] and ['a','bc'] hash the same, and two
    // different pages with one signature would be reported as "no distinct
    // state" — the answer this function exists to be careful about.
    expect(variantSignature(facts({ headings: ['ab', 'c'] }))).not.toBe(
      variantSignature(facts({ headings: ['a', 'bc'] })),
    );
  });

  it('has no signature for a page nobody read', () => {
    expect(variantSignatureOf(null)).toBeNull();
    expect(variantSignatureOf(undefined)).toBeNull();
    expect(variantSignatureOf(facts())).toBe(variantSignature(facts()));
  });

  it('answers UNMEASURED and never IDENTICAL when a side is missing', () => {
    // The single collapse that turns a measurement we never took into a
    // printed result.
    expect(compareSignatures(null, 'x')).toBe('UNMEASURED');
    expect(compareSignatures('x', null)).toBe('UNMEASURED');
    expect(compareSignatures(undefined, undefined)).toBe('UNMEASURED');
    expect(compareSignatures('x', 'x')).toBe('IDENTICAL');
    expect(compareSignatures('x', 'y')).toBe('DISTINCT');
  });
});

// ─── Attribution ─────────────────────────────────────────────────────────────

describe('attribution', () => {
  function deviceVariant(): PlannedVariant {
    return planDeviceVariants(
      context({ nodes: [node('/orders')], budget: { nodesPerDevice: 1 } }),
      { devices: [DEVICE_PROFILES[1]!] },
    ).variants[0]!;
  }

  function faultVariant(): PlannedVariant {
    return planFaultVariants(context({ nodes: [node('/orders')] }), {
      requests: [request()],
      states: ['ERROR'],
    }).variants[0]!;
  }

  it('calls a control that exists only on mobile new surface', () => {
    const variant = deviceVariant();
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts({ controls: ['New order'] })]]),
      observations: [observed(variant, facts({ controls: ['New order', 'Open menu'] }))],
    });
    expect(attribution.newSurface).toHaveLength(1);
    expect(attribution.newSurface[0]).toMatchObject({
      kind: 'CONTROL',
      axis: 'DEVICE',
      base: '/orders',
      identity: 'Open menu',
    });
    expect(attribution.newSurface[0]?.surfaceKey).toContain('CONTROL:Open menu');
    expect(attribution.newSurface[0]?.presentIn).toEqual([variant.id]);
  });

  it('does not call the same page at a second width a second route', () => {
    const variant = deviceVariant();
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts({ rowCount: 4 })]]),
      // Structurally different (the list is empty here) but nothing new to
      // press: on the DEVICE axis that is not surface.
      observations: [observed(variant, facts({ rowCount: 0 }))],
    });
    expect(attribution.newSurface).toHaveLength(0);
    expect(attribution.differsWithoutNewSurface).toHaveLength(1);
    expect(attribution.differsWithoutNewSurface[0]?.why).toContain('not surface');
  });

  it('calls a distinct injected failure state surface in its own right', () => {
    const variant = faultVariant();
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts()]]),
      observations: [observed(variant, facts({ alerts: ['Could not load orders'], rowCount: 0 }))],
    });
    const state = attribution.newSurface.find((entry) => entry.kind === 'STATE');
    expect(state).toBeDefined();
    expect(state?.axis).toBe('FAULT');
    expect(state?.surfaceKey).toBe(variant.surfaceKey);
    expect(state?.surfaceKind).toBe(VARIANT_AXIS_SURFACE_KIND.FAULT);
  });

  it('reports NO DISTINCT STATE for an injected failure that renders identically', () => {
    const variant = faultVariant();
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts()]]),
      observations: [observed(variant, facts())],
    });
    expect(attribution.newSurface).toHaveLength(0);
    expect(attribution.noDistinctState).toHaveLength(1);
    expect(attribution.noDistinctState[0]?.why).toContain('NO DISTINCT STATE');
    expect(attribution.noDistinctState[0]?.why).toContain('not covered surface');
  });

  it('refuses to read an identical dark-mode render as dark mode working', () => {
    const variant = planRenderVariants(context({ nodes: [node('/orders')] }), {
      axes: ['DARK_MODE'],
    }).variants[0]!;
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts()]]),
      observations: [observed(variant, facts())],
    });
    expect(attribution.noDistinctState[0]?.why).toContain('no STRUCTURAL difference');
    expect(attribution.noDistinctState[0]?.why).toContain('a visual check owns that question');
  });

  it('calls a control the variant hides a finding and not new surface', () => {
    const variant = deviceVariant();
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts({ controls: ['New order', 'Export CSV'] })]]),
      observations: [observed(variant, facts({ controls: ['New order'] }))],
    });
    expect(attribution.newSurface).toHaveLength(0);
    expect(attribution.hiddenByVariant.map((entry) => entry.identity)).toEqual(['Export CSV']);
  });

  it('routes every outcome into exactly one bucket', () => {
    const variant = deviceVariant();
    const baseline = new Map([['/orders', facts()]]);
    const buckets = (outcome: (typeof VARIANT_OUTCOMES)[number]) => {
      const attribution = attributeVariants({
        plan: [variant],
        baseline,
        observations: [
          { variantId: variant.id, outcome, facts: facts(), detail: `it was ${outcome}` },
        ],
      });
      return {
        unmeasured: attribution.unmeasured.length,
        unavailable: attribution.unavailable.length,
        refused: attribution.refused.length,
        failed: attribution.failed.length,
        unattributable: attribution.unattributable.length,
      };
    };
    expect(VARIANT_OUTCOME_KINDS).toEqual([...VARIANT_OUTCOMES]);
    expect(buckets('NOT_RUN')).toMatchObject({
      unmeasured: 1,
      unavailable: 0,
      refused: 0,
      failed: 0,
    });
    expect(buckets('UNAVAILABLE')).toMatchObject({
      unmeasured: 0,
      unavailable: 1,
      refused: 0,
      failed: 0,
    });
    expect(buckets('REFUSED')).toMatchObject({
      unmeasured: 0,
      unavailable: 0,
      refused: 1,
      failed: 0,
    });
    expect(buckets('FAILED')).toMatchObject({
      unmeasured: 0,
      unavailable: 0,
      refused: 0,
      failed: 1,
    });
    // OBSERVED is the only outcome that is not a caveat.
    expect(buckets('OBSERVED')).toMatchObject({
      unmeasured: 0,
      unavailable: 0,
      refused: 0,
      failed: 0,
      unattributable: 0,
    });
  });

  it('calls a planned variant with no observation unmeasured, never identical', () => {
    const variant = deviceVariant();
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts()]]),
      observations: [],
    });
    expect(attribution.unmeasured).toHaveLength(1);
    expect(attribution.unmeasured[0]?.why).toContain(
      'not evidence that the variant looks like the baseline',
    );
    expect(attribution.noDistinctState).toHaveLength(0);
  });

  it('calls an OBSERVED result with no captured facts unmeasured', () => {
    const variant = deviceVariant();
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts()]]),
      observations: [observed(variant, null)],
    });
    expect(attribution.unmeasured[0]?.why).toContain(
      'reported OBSERVED with no captured page facts',
    );
  });

  it('cannot attribute a difference against an unmeasured baseline', () => {
    const variant = deviceVariant();
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map(),
      observations: [observed(variant, facts({ controls: ['Open menu'] }))],
    });
    expect(attribution.newSurface).toHaveLength(0);
    expect(attribution.unattributable).toHaveLength(1);
    expect(attribution.unattributable[0]?.why).toContain('recorded nothing for /orders');
  });

  it('keeps a plan-time refusal apart from a plan-time capability gap', () => {
    const refused = planFaultVariants(context(), {
      requests: [request({ method: 'DELETE' })],
    }).variants[0]!;
    const unavailable = planDeviceVariants(
      context({ nodes: [node('/orders')], available: [], budget: { nodesPerDevice: 1 } }),
      { devices: [DEVICE_PROFILES[1]!] },
    ).variants[0]!;
    const attribution = attributeVariants({
      plan: [refused, unavailable],
      baseline: new Map([['/orders', facts()]]),
      observations: [],
    });
    // Policy said no, versus our harness cannot: different facts, different
    // remedies, and only the second is ours to fix.
    expect(attribution.refused).toHaveLength(1);
    expect(attribution.refused[0]?.why).toContain(NON_IDEMPOTENT_RULE);
    expect(attribution.unavailable).toHaveLength(1);
    expect(attribution.unavailable[0]?.why).toContain('CAPABILITY_UNAVAILABLE');
    expect(attribution.unmeasured).toHaveLength(0);
  });

  it('surfaces an observation for a variant nothing planned', () => {
    const attribution = attributeVariants({
      plan: [],
      baseline: new Map(),
      observations: [
        { variantId: 'DEVICE:/ghost#mobile-390', outcome: 'OBSERVED', facts: facts(), detail: '' },
      ],
    });
    expect(attribution.unknownVariants).toEqual(['DEVICE:/ghost#mobile-390']);
  });

  it('counts the six caveats separately in its own summary', () => {
    const attribution = attributeVariants({ plan: [], baseline: new Map(), observations: [] });
    expect(attribution.rule).toContain('counted as NOTHING');
    expect(attribution.rule).toContain('Those six are separate');
  });

  it('attributes a new node to the data profile that reached it', () => {
    const variant = planDataVariants(context({ nodes: [node('/orders')] }), {
      profiles: [profile({ key: 'heavy' })],
    }).variants[0]!;
    const attribution = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts({ nodes: ['/orders#populated'] })]]),
      observations: [observed(variant, facts({ nodes: ['/orders#populated', '/orders#page-2'] }))],
    });
    const found = attribution.newSurface.find((entry) => entry.kind === 'NODE');
    expect(found?.identity).toBe('/orders#page-2');
    expect(found?.axis).toBe('DATA');
  });
});

// ─── Items into the registry ─────────────────────────────────────────────────

describe('variantSurfaceItems', () => {
  function attributionWithNewSurface() {
    const variant = planDeviceVariants(
      context({ nodes: [node('/orders')], budget: { nodesPerDevice: 1 } }),
      { devices: [DEVICE_PROFILES[1]!] },
    ).variants[0]!;
    return attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts({ controls: ['New order'] })]]),
      observations: [observed(variant, facts({ controls: ['New order', 'Open menu'] }))],
    });
  }

  it('declares CRAWL as the source and derives the origin from it', () => {
    const items = variantSurfaceItems(attributionWithNewSurface(), { environmentId: 'env-1' });
    expect(items).toHaveLength(1);
    expect(items[0]?.sources).toEqual(['CRAWL']);
    // Derived, never set independently: two provenance fields that disagree
    // mean only one of them is on screen.
    expect(items[0]?.origin).toBe('CRAWL_ONLY');
    expect(items[0]?.environmentId).toBe('env-1');
    expect(items[0]?.detector).toBe('crawl/variants');
    expect(items[0]?.evidence).toBeTruthy();
    expect(items[0]?.exercise?.state).toBe('EXERCISABLE');
  });

  it('carries the dimension coordinates for a cell and none for a state', () => {
    const cell = variantSurfaceItems(attributionWithNewSurface(), { environmentId: null });
    expect(cell[0]?.coordinates).toEqual([{ dimension: 'DEVICE', value: DEVICE_PROFILES[1]!.key }]);

    const variant = planFaultVariants(context({ nodes: [node('/orders')] }), {
      requests: [request()],
      states: ['ERROR'],
    }).variants[0]!;
    const state = variantSurfaceItems(
      attributeVariants({
        plan: [variant],
        baseline: new Map([['/orders', facts()]]),
        observations: [observed(variant, facts({ alerts: ['Failed'] }))],
      }),
      { environmentId: null },
    );
    expect(state[0]?.coordinates).toBeUndefined();
  });

  it('mints nothing for a no-distinct-state, unmeasured or refused variant', () => {
    const variant = planFaultVariants(context({ nodes: [node('/orders')] }), {
      requests: [request()],
      states: ['ERROR'],
    }).variants[0]!;
    const identical = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts()]]),
      observations: [observed(variant, facts())],
    });
    expect(variantSurfaceItems(identical, { environmentId: null })).toHaveLength(0);

    const never = attributeVariants({
      plan: [variant],
      baseline: new Map([['/orders', facts()]]),
      observations: [],
    });
    expect(variantSurfaceItems(never, { environmentId: null })).toHaveLength(0);
  });
});

// ─── The combined plan ───────────────────────────────────────────────────────

describe('planVariantCrawl', () => {
  const inputs = {
    locales: { locales: [locale('en', { isDefault: true }), locale('fr')] },
    faults: { requests: [request()] },
    data: { profiles: [profile()] },
  };

  it('applies the overall ceiling last and discloses the bite', () => {
    const plan = planVariantCrawl(context({ budget: { totalVisits: 3 } }), inputs);
    expect(plan.runnable).toBe(3);
    const bite = plan.caps.find((cap) => cap.scope === 'all variant axes');
    expect(bite?.limit).toBe(3);
    expect(bite?.discarded).toBeGreaterThan(0);
    expect(bite?.reason).toContain('at least');
  });

  it('lets the crawl policy’s own page budget bind, and says that it did', () => {
    // A customer who capped a crawl at two pages did not agree to 400 more
    // visits because they are on a different axis.
    const plan = planVariantCrawl(
      context({ policy: { ...DEFAULT_CRAWL_POLICY, pageBudget: 2 } }),
      inputs,
    );
    expect(plan.runnable).toBe(2);
    const bite = plan.caps.find((cap) => cap.scope === 'all variant axes');
    expect(bite?.reason).toContain("the limit is the crawl policy's own pageBudget");
  });

  it('keeps every held-out variant through the ceiling', () => {
    // They cost no visit, and dropping them would delete the only record that
    // a surface exists and cannot be driven here.
    const plan = planVariantCrawl(context({ available: [], budget: { totalVisits: 1 } }), inputs);
    expect(plan.runnable).toBe(0);
    expect(plan.heldOut).toBeGreaterThan(0);
    expect(plan.variants).toHaveLength(plan.heldOut);
    expect(plan.caps.some((cap) => cap.scope === 'all variant axes')).toBe(false);
  });

  it('reports the lower bound as the sum of what the caps discarded', () => {
    const plan = planVariantCrawl(context({ budget: { totalVisits: 2 } }), inputs);
    expect(plan.atLeastMoreVariants).toBe(
      plan.caps.reduce((running, cap) => running + cap.discarded, 0),
    );
    expect(plan.rule).toContain('SAMPLE and never a cross product');
  });

  it('names an axis that produced nothing instead of omitting it', () => {
    // An axis absent from a report reads as an axis with nothing in it.
    const plan = planVariantCrawl(context(), { data: { profiles: [] } });
    expect(plan.emptyAxes.map((entry) => entry.axis)).toEqual(['LOCALE', 'FAULT', 'DATA']);
    for (const entry of plan.emptyAxes) expect(entry.why).toBeTruthy();
  });

  it('carries every axis’s refusals into one ledger', () => {
    const plan = planVariantCrawl(context({ nodes: [node('/'), node('/logout')] }), inputs);
    expect(plan.refusedBases.some((entry) => entry.base === '/logout')).toBe(true);
    expect(new Set(plan.refusedBases.map((entry) => entry.axis)).size).toBeGreaterThan(1);
  });

  it('selects representatives identically for every axis, so the bases line up', () => {
    const ctx = context({ nodes: [node('/'), node('/orders')], budget: { nodesPerDevice: 1 } });
    const chosen = selectRepresentatives(ctx, 'DEVICE', 1);
    expect(chosen.chosen).toHaveLength(1);
    expect(chosen.ranked).toHaveLength(2);
    expect(chosen.caps[0]?.cap).toBe('PAGE_BUDGET');
  });
});
