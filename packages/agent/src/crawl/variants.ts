/**
 * The variant axes — the five other applications a single crawl never sees.
 *
 * THE DEFECT THIS FIXES: `crawl()` opens exactly one browser context, at
 * `viewport: { width: 1280, height: 900 }`, in the default colour scheme, in
 * the browser's own locale, with one storage state, and with no request ever
 * intercepted. Everything that only exists outside that one configuration is
 * not reported as uncovered — it is not in the denominator at all:
 *
 *   · the hamburger, the bottom sheet and every `md:hidden` control, because
 *     nothing was ever narrower than 1280px — while the CROSS_BROWSER and
 *     MOBILE runners already exist and will happily run tests at those widths;
 *   · the dark, printed, forced-colors, zoomed, offline and
 *     permission-denied renderings of every screen;
 *   · eleven of the twelve locales, and — worse — the twelve localised PATHS
 *     of one route counted as twelve routes, which divides the coverage
 *     percentage by twelve for no reason connected to anybody's tests;
 *   · the loading, empty, error, 403, slow and partial half of every screen,
 *     because the crawl never fails a request;
 *   · the pagination, overflow, zero-result, quota and trial-expired screens,
 *     because one account's data is one slice of the app.
 *
 * ─── What this module is and is not ─────────────────────────────────────────
 *
 * It is pure. Every function here takes facts and returns facts: a PLAN (what
 * to crawl, in what variant, at what cost) and an ATTRIBUTION (this control,
 * route, node or state exists in variants X and Y and not Z). No browser is
 * opened, no page is read. The browser surface a variant pass needs is
 * declared as {@link VariantBrowserSurface} — an interface with one optional
 * method per capability — and {@link capabilitiesOf} reports what an injected
 * surface can actually do, so a capability the harness has not got becomes an
 * UNEXERCISABLE variant with a named reason rather than a crash or, far worse,
 * a silently skipped axis.
 *
 * ─── The three rules every planner here obeys ───────────────────────────────
 *
 * 1. THE CROSS PRODUCT IS NOT THE PLAN. 412 routes × 4 devices × 8 render
 *    axes × 12 locales × 7 data profiles is not affordable and claiming it
 *    would be the cap-without-disclosure lie. So each planner SAMPLES, and
 *    every sample reports what it dropped as a {@link CapBite} with both a
 *    `bites` count and a `discarded` count, which is what lets the report say
 *    "at least 340 more variants existed".
 *
 * 2. A DIFFERENCE IS NOT AUTOMATICALLY SURFACE. The same page at two widths is
 *    one route; a control that exists ONLY on mobile is new surface. Which of
 *    the two a difference is depends on the axis, so it is DATA —
 *    {@link VARIANT_AXIS_SURFACE_RULE} — and not a judgement made five times.
 *
 * 3. UNMEASURED IS NOT IDENTICAL. A variant that was planned and never run, a
 *    variant the harness cannot produce, a variant policy refused and a
 *    variant that ran and looked exactly like the baseline are four different
 *    facts, and {@link VariantAttribution} keeps them in four separate lists.
 *    Collapsing any of them into "no difference" is how an axis nobody
 *    measured comes to read as an axis with nothing in it.
 */

import {
  DIMENSION_AXIS,
  dimensionCellIdentity,
  matchesGlob,
  originFromSources,
  policyDecision,
  surfaceKey,
  type CapBite,
  type CrawlCap,
  type CrawlPolicy,
  type DimensionCoordinate,
  type DimensionDetail,
  type ExclusionKind,
  type SurfaceDimensionValue,
  type SurfaceExercise,
  type SurfaceItem,
  type SurfaceKind,
  type SurfaceSource,
  type UnexercisableReason,
} from '@qaai/shared';

// ─── The axes ────────────────────────────────────────────────────────────────

/**
 * The five variant axes.
 *
 * Five and not eight: these are the axes whose values are enumerable
 * INDEPENDENTLY of the page they apply to, and which a crawl can actually
 * produce. A browser engine (`CROSS_BROWSER`) is not here because the runner
 * owns it and it is not an enumeration question; a role is not here because it
 * is `SURFACE_DIMENSION_KINDS.ROLE` and the role prober owns it.
 */
export const VARIANT_AXES = ['DEVICE', 'RENDER', 'LOCALE', 'FAULT', 'DATA'] as const;
export type VariantAxis = (typeof VARIANT_AXES)[number];

/**
 * Every axis as a run-time value, enforced by the compiler.
 *
 * The keystone pattern from `GATE_RULE_KIND_PRESENT` and
 * `DIMENSION_DETAIL_PRESENT`: a `Record` keyed on the union, so a sixth axis
 * breaks this line, plus a parity test in variants.test.ts that walks
 * {@link planVariantCrawl} and fails when an axis has no planner. Two
 * mechanisms because each catches what the other cannot — the compiler cannot
 * see that an axis has no planner, and a test cannot see a typo in a key.
 */
const VARIANT_AXIS_PRESENT: Record<VariantAxis, true> = {
  DEVICE: true,
  RENDER: true,
  LOCALE: true,
  FAULT: true,
  DATA: true,
};

export const VARIANT_AXIS_KINDS = Object.keys(VARIANT_AXIS_PRESENT) as readonly VariantAxis[];

export const VARIANT_AXIS_LABELS: Record<VariantAxis, string> = {
  DEVICE: 'Devices and viewports',
  RENDER: 'Render environments',
  LOCALE: 'Locales',
  FAULT: 'Injected failure states',
  DATA: 'Data-state profiles',
};

/**
 * Which existing `SURFACE_KINDS` axis each variant's items are counted on.
 *
 * DEVICE and LOCALE are DERIVED from `DIMENSION_AXIS` rather than restated,
 * because a second copy of that mapping is exactly the fork that let a
 * source-derived flow map displace a crawl: the same fact spelled in two
 * files drifts, and the drift is invisible. The other three are states of ONE
 * item rather than pairings across a shared dimension table — see the note on
 * `SURFACE_DIMENSION_KINDS` in shared/surface.ts — so they land on the state
 * axes `SURFACE_KINDS` already has. No thirteenth kind is minted here; a
 * thirteenth kind would be a second denominator.
 */
export const VARIANT_AXIS_SURFACE_KIND: Record<VariantAxis, SurfaceKind> = {
  DEVICE: DIMENSION_AXIS.DEVICE,
  LOCALE: DIMENSION_AXIS.LOCALE,
  /** A named rendering state of a page: dark, printed, offline, permission-denied. */
  RENDER: 'COMPONENT_STATE',
  /** "A declared error or empty state of a route" — now OBSERVED, not declared. */
  FAULT: 'ERROR_STATE',
  /** "A distinct data shape a route must handle: empty, one, many, pathological." */
  DATA: 'DATA_VARIANT',
};

/**
 * What counts as new surface on each axis, as data.
 *
 * This is the question item 1 of the register asks and it has a different
 * answer per axis, so answering it in five planners would mean five chances to
 * answer it differently:
 *
 *   `controlIsSurface`  a control (or a route, or a node) that exists in the
 *                       variant and not in the baseline is new surface. True
 *                       everywhere — a mobile-only "Filter" button is a thing
 *                       a test can press and nothing in the inventory names it.
 *   `stateIsSurface`    a variant whose page merely LOOKS different, with no
 *                       new control, is itself a distinct state worth testing.
 *                       True for the three state axes: an empty-list screen, a
 *                       403 screen and a print view are all states a test
 *                       asserts on even when they offer nothing to click.
 *                       FALSE for DEVICE and LOCALE, because the same page at
 *                       two widths is not two routes and /fr/pricing is not a
 *                       second route — it is one route with a locale
 *                       coordinate. Counting those as items is how twelve
 *                       locales multiply a denominator by twelve.
 */
export const VARIANT_AXIS_SURFACE_RULE: Record<
  VariantAxis,
  { controlIsSurface: boolean; stateIsSurface: boolean; why: string }
> = {
  DEVICE: {
    controlIsSurface: true,
    stateIsSurface: false,
    why: 'a control that exists only at this viewport is new surface; the same page at two widths is not two routes',
  },
  RENDER: {
    controlIsSurface: true,
    stateIsSurface: true,
    why: 'a print view, an offline screen and a denied-permission screen are distinct states a test asserts on',
  },
  LOCALE: {
    controlIsSurface: true,
    stateIsSurface: false,
    why: 'one route with a locale coordinate, never twelve routes; only a control the canonical route does not have is new surface',
  },
  FAULT: {
    controlIsSurface: true,
    stateIsSurface: true,
    why: 'the error and empty half of a screen is surface in its own right, even when it offers nothing to click',
  },
  DATA: {
    controlIsSurface: true,
    stateIsSurface: true,
    why: 'a zero-result, overflow or trial-expired screen is a distinct data state of the same route',
  },
};

// ─── Capabilities: what the harness can actually do ──────────────────────────

/**
 * The browser capabilities a variant pass needs, named so an absent one can be
 * REPORTED.
 *
 * This is the UNAVAILABLE-never-PASS rule in its most literal form. `ZOOM` is
 * the member that proves the point: Playwright has no browser-zoom API at all,
 * so 200% zoom needs a CDP session (`Emulation.setPageScaleFactor`) and is
 * therefore absent on Firefox and WebKit. An axis we cannot produce must come
 * back as UNEXERCISABLE / CAPABILITY_UNAVAILABLE and be counted in the
 * inventory, not quietly dropped from the plan — dropping it is what makes a
 * coverage percentage computed over the axes that happened to work.
 */
export const VARIANT_CAPABILITIES = [
  'VIEWPORT',
  'EMULATE_MEDIA',
  'ZOOM',
  'OFFLINE',
  'ROUTE_INTERCEPT',
  'PERMISSIONS',
  'LOCALE_CONTEXT',
  'IDENTITY',
] as const;
export type VariantCapability = (typeof VARIANT_CAPABILITIES)[number];

export const VARIANT_CAPABILITY_LABELS: Record<VariantCapability, string> = {
  VIEWPORT: 'set the viewport, scale factor, touch and user agent',
  EMULATE_MEDIA: 'emulate colour scheme, reduced motion, forced colors and print',
  ZOOM: 'set the page zoom factor',
  OFFLINE: 'take the context offline',
  ROUTE_INTERCEPT: 'intercept and fail a request',
  PERMISSIONS: 'grant and revoke browser permissions',
  LOCALE_CONTEXT: 'open a context in another locale',
  IDENTITY: 'open a context as another identity',
};

/**
 * The adapter call each capability means, so the thin adapter has nothing to
 * guess and a reviewer can check it against the Playwright API.
 *
 * Written down because the one place this slice can still go wrong is an
 * adapter that reports a capability it does not implement correctly — which
 * would be the measured-but-not-measured lie with a passing test behind it.
 */
export const VARIANT_CAPABILITY_ADAPTER: Record<VariantCapability, string> = {
  VIEWPORT: 'browser.newContext({ viewport, deviceScaleFactor, hasTouch, userAgent })',
  EMULATE_MEDIA: 'page.emulateMedia({ colorScheme, reducedMotion, forcedColors, media })',
  ZOOM: 'CDP session → Emulation.setPageScaleFactor (Chromium only; no Playwright API)',
  OFFLINE: 'context.setOffline(true)',
  ROUTE_INTERCEPT: 'page.route(glob, route => route.fulfill | route.abort)',
  PERMISSIONS: 'context.grantPermissions / context.clearPermissions',
  LOCALE_CONTEXT: 'browser.newContext({ locale, timezoneId })',
  IDENTITY: 'browser.newContext({ storageState })',
};

/**
 * The browser surface a variant pass drives, as an INJECTED interface.
 *
 * Every method is optional, and that is the design: the adapter implements what
 * the engine it is driving can do, {@link capabilitiesOf} reports the set, and
 * the planners turn a gap into a named UNEXERCISABLE variant. Nothing in this
 * module calls any of these — they are here so the seam is a contract rather
 * than a convention, and so the whole module is testable with an object
 * literal. The existing crawl takes a `playwright.Page` and that is precisely
 * why 629 lines of it have almost no tests.
 */
export interface VariantBrowserSurface {
  setDevice?: (profile: DeviceProfile) => Promise<void>;
  emulateMedia?: (media: RenderMediaOverride) => Promise<void>;
  setPageZoom?: (factor: number) => Promise<void>;
  setOffline?: (offline: boolean) => Promise<void>;
  interceptRequest?: (match: RequestMatcher, mechanism: FaultMechanism) => Promise<void>;
  setPermissions?: (granted: readonly BrowserPermission[]) => Promise<void>;
  setLocale?: (tag: string) => Promise<void>;
  useIdentity?: (identityRef: string | null) => Promise<void>;
}

/**
 * Which capabilities an injected surface actually has.
 *
 * A `Record` from capability to the method that implements it, so a new
 * capability cannot be added without saying which method proves it. The check
 * is `typeof … === 'function'` and nothing more: a surface that implements a
 * method badly is the adapter's defect, and no amount of inspection here would
 * catch it.
 */
const CAPABILITY_METHOD: Record<VariantCapability, keyof VariantBrowserSurface> = {
  VIEWPORT: 'setDevice',
  EMULATE_MEDIA: 'emulateMedia',
  ZOOM: 'setPageZoom',
  OFFLINE: 'setOffline',
  ROUTE_INTERCEPT: 'interceptRequest',
  PERMISSIONS: 'setPermissions',
  LOCALE_CONTEXT: 'setLocale',
  IDENTITY: 'useIdentity',
};

export function capabilitiesOf(surface: VariantBrowserSurface): VariantCapability[] {
  return VARIANT_CAPABILITIES.filter(
    (capability) => typeof surface[CAPABILITY_METHOD[capability]] === 'function',
  );
}

/** The capabilities a variant needs and the surface has not got. */
export function missingCapabilities(
  required: readonly VariantCapability[],
  available: readonly VariantCapability[],
): VariantCapability[] {
  return required.filter((capability) => !available.includes(capability));
}

// ─── Devices (register item 1) ───────────────────────────────────────────────

/**
 * What a device is to a crawl: a viewport, a pixel ratio, whether it has a
 * touch screen, and what it claims to be.
 *
 * The user-agent CLASS and not a user-agent string, because the string is the
 * adapter's business (Playwright's own device descriptors carry one) and a
 * hard-coded Chrome 119 string here would rot into a lie about what we drove.
 */
export const DEVICE_USER_AGENT_CLASSES = ['DESKTOP', 'MOBILE', 'TABLET'] as const;
export type DeviceUserAgentClass = (typeof DEVICE_USER_AGENT_CLASSES)[number];

export interface DeviceProfile {
  /** Identity, and the value of the DEVICE coordinate. The app's own spelling. */
  key: string;
  label: string;
  widthPx: number;
  heightPx: number;
  deviceScaleFactor: number;
  touch: boolean;
  userAgentClass: DeviceUserAgentClass;
  /** Playwright device descriptor name, when it is one of theirs. */
  descriptor: string | null;
  /** Why this device is in the set at all. Printed in the plan. */
  why: string;
}

/**
 * The device the existing crawl runs at, and therefore the baseline every
 * device attribution is made against.
 *
 * It is in the set deliberately: the baseline has to be a NAMED device with a
 * coordinate of its own, or a control found at 390px has nothing to be
 * "additional to" and the attribution would be comparing against an unnamed
 * default.
 */
export const BASELINE_DEVICE_KEY = 'desktop-1280';

/**
 * The device set, as DATA.
 *
 * FOUR, one per layout breakpoint class, and not one per marketed handset. The
 * cost of a device is a full re-crawl of the sampled nodes, and two phones that
 * are both 390 CSS pixels wide produce byte-identical DOM — paying twice for
 * that is how a variant pass becomes unaffordable and then gets switched off.
 * The widths are chosen where real frameworks put their breakpoints: 360 is
 * below every `sm:`, 390 is the modern phone, 820 lands between `md:` and
 * `lg:` where tablet layouts are most often untested, 1280 is today's crawl.
 *
 * A customer with a 5120px kiosk or a 320px scanner replaces this list; it is
 * an input to {@link planDeviceVariants}, not a constant it reads.
 */
export const DEVICE_PROFILES: readonly DeviceProfile[] = [
  {
    key: BASELINE_DEVICE_KEY,
    label: 'Desktop 1280×900',
    widthPx: 1280,
    heightPx: 900,
    deviceScaleFactor: 1,
    touch: false,
    userAgentClass: 'DESKTOP',
    descriptor: null,
    why: 'the viewport the existing crawl is hard-coded to, so it is the baseline every other device is attributed against',
  },
  {
    key: 'mobile-390',
    label: 'Phone 390×844',
    widthPx: 390,
    heightPx: 844,
    deviceScaleFactor: 3,
    touch: true,
    userAgentClass: 'MOBILE',
    descriptor: 'iPhone 14',
    why: 'the modern phone width: below every framework `sm:` breakpoint, so this is where navigation collapses into a hamburger and actions move into a bottom sheet',
  },
  {
    key: 'mobile-360',
    label: 'Small phone 360×640',
    widthPx: 360,
    heightPx: 640,
    deviceScaleFactor: 2,
    touch: true,
    userAgentClass: 'MOBILE',
    descriptor: null,
    why: 'the narrowest width still worth supporting; tables overflow and fixed-width controls clip here and nowhere else',
  },
  {
    key: 'tablet-820',
    label: 'Tablet 820×1180',
    widthPx: 820,
    heightPx: 1180,
    deviceScaleFactor: 2,
    touch: true,
    userAgentClass: 'TABLET',
    descriptor: 'iPad Air',
    why: 'between `md:` and `lg:`, with touch — the combination most layouts are never checked at',
  },
];

/**
 * A device profile as a row of the dimension table.
 *
 * Here rather than in the writer so that the DEVICE dimension's `detail` is
 * derived from the same object the crawl was driven with. A device row whose
 * `widthPx` disagrees with the viewport we actually set would make every cell
 * on the axis a claim about a configuration that never ran.
 */
export function deviceDimensionValue(
  profile: DeviceProfile,
  source: SurfaceSource,
): SurfaceDimensionValue {
  const detail: DimensionDetail = {
    dimension: 'DEVICE',
    widthPx: profile.widthPx,
    heightPx: profile.heightPx,
    touch: profile.touch,
    descriptor: profile.descriptor,
  };
  return {
    kind: 'DEVICE',
    key: profile.key,
    label: profile.label,
    source,
    evidence: profile.why,
    isDefault: profile.key === BASELINE_DEVICE_KEY,
    available: true,
    detail,
  };
}

// ─── Render environments (register item 2) ───────────────────────────────────

/**
 * The render environments, each of which is a different UI with different
 * failures and none of which is enumerated today.
 *
 * OFFLINE is here and NOT in {@link FAULT_STATES}, and the duplication it
 * avoids is worth stating: a page with no network at all and a page whose one
 * data request was aborted are different measurements, but if both axes owned
 * "offline" they would mint two items for the same screen and the DATA_VARIANT
 * and ERROR_STATE axes would each count it once. One owner per fact. The fault
 * axis fails INDIVIDUAL requests; this axis kills the whole network, document
 * included, which is the service-worker question and a different test.
 */
export const RENDER_AXES = [
  'DARK_MODE',
  'REDUCED_MOTION',
  'FORCED_COLORS',
  'PRINT',
  'ZOOM_200',
  'OFFLINE',
  'PERMISSION_GRANTED',
  'PERMISSION_DENIED',
] as const;
export type RenderAxisKind = (typeof RENDER_AXES)[number];

/** The permissions worth a variant. Playwright's own permission names. */
export const BROWSER_PERMISSIONS = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-write',
] as const;
export type BrowserPermission = (typeof BROWSER_PERMISSIONS)[number];

/**
 * A media emulation, with `null` meaning LEAVE IT ALONE.
 *
 * Not `'no-preference'` for the untouched fields, because setting a field to
 * its neutral value is still setting it: `forcedColors: 'none'` is an
 * assertion that we drove the page with forced colours explicitly off, and a
 * report that says so when the adapter never touched the setting is the
 * measured-but-not-measured lie in miniature.
 */
export interface RenderMediaOverride {
  colorScheme: 'light' | 'dark' | 'no-preference' | null;
  reducedMotion: 'reduce' | 'no-preference' | null;
  forcedColors: 'active' | 'none' | null;
  media: 'screen' | 'print' | null;
}

const NO_MEDIA_OVERRIDE: RenderMediaOverride = {
  colorScheme: null,
  reducedMotion: null,
  forcedColors: null,
  media: null,
};

/**
 * Whether a difference on this axis is one this module can SEE.
 *
 * STRUCTURAL: the axis changes the DOM — controls appear, text changes, a
 * whole different screen renders. {@link variantSignature} detects it.
 *
 * VISUAL_ONLY: the axis changes pixels and usually nothing else. Dark mode
 * swaps colours; reduced motion removes an animation. A structural signature
 * CANNOT see either, so an identical signature on one of these axes means
 * exactly "no structural difference" and must never be reported as "dark mode
 * is covered" — the defect it hides (unreadable text on a dark background) is
 * a visual check's job, and this module is not one. Saying which is which is
 * the only honest thing available here.
 */
export const RENDER_DIFFERENCE_KINDS = ['STRUCTURAL', 'VISUAL_ONLY'] as const;
export type RenderDifferenceKind = (typeof RENDER_DIFFERENCE_KINDS)[number];

export interface RenderEnvironment {
  kind: RenderAxisKind;
  label: string;
  requires: readonly VariantCapability[];
  media: RenderMediaOverride;
  /** Zoom factor, for the one axis that has one. */
  zoomFactor: number | null;
  differenceKind: RenderDifferenceKind;
  /**
   * True when this axis must not be planned blind — the permission axes, which
   * only mean something on a route that asks for a permission. Planning them
   * everywhere would be 6 permissions × 2 states × every route of invented
   * cells, which is the cross-product lie with extra steps.
   */
  needsDeclaration: boolean;
  why: string;
}

export const RENDER_ENVIRONMENTS: Record<RenderAxisKind, RenderEnvironment> = {
  DARK_MODE: {
    kind: 'DARK_MODE',
    label: 'dark colour scheme',
    requires: ['EMULATE_MEDIA'],
    media: { ...NO_MEDIA_OVERRIDE, colorScheme: 'dark' },
    zoomFactor: null,
    differenceKind: 'VISUAL_ONLY',
    needsDeclaration: false,
    why: 'a theme the app ships and nothing has ever rendered; structurally identical in most apps, which is why this axis reports NO STRUCTURAL DIFFERENCE rather than a pass',
  },
  REDUCED_MOTION: {
    kind: 'REDUCED_MOTION',
    label: 'prefers-reduced-motion',
    requires: ['EMULATE_MEDIA'],
    media: { ...NO_MEDIA_OVERRIDE, reducedMotion: 'reduce' },
    zoomFactor: null,
    differenceKind: 'VISUAL_ONLY',
    needsDeclaration: false,
    why: 'an app that gates a transition on this setting can leave a modal permanently invisible; the structural signature sees that, a colour change it does not',
  },
  FORCED_COLORS: {
    kind: 'FORCED_COLORS',
    label: 'forced colors (high contrast)',
    requires: ['EMULATE_MEDIA'],
    media: { ...NO_MEDIA_OVERRIDE, forcedColors: 'active' },
    zoomFactor: null,
    differenceKind: 'VISUAL_ONLY',
    needsDeclaration: false,
    why: 'background images and CSS-coloured state indicators disappear entirely under forced colors, which is an accessibility failure no test in the suite can see today',
  },
  PRINT: {
    kind: 'PRINT',
    label: 'print stylesheet',
    requires: ['EMULATE_MEDIA'],
    media: { ...NO_MEDIA_OVERRIDE, media: 'print' },
    zoomFactor: null,
    differenceKind: 'STRUCTURAL',
    needsDeclaration: false,
    why: 'a print stylesheet hides navigation and reveals a print-only header, so the printed invoice is a genuinely different screen — and it is the one customers forward to their accountant',
  },
  ZOOM_200: {
    kind: 'ZOOM_200',
    label: '200% zoom',
    requires: ['ZOOM'],
    media: NO_MEDIA_OVERRIDE,
    zoomFactor: 2,
    differenceKind: 'STRUCTURAL',
    needsDeclaration: false,
    why: 'WCAG 1.4.4 requires 200% without loss of content; at 200% a desktop layout collapses to its mobile breakpoint and controls overlap. Needs CDP — report it UNAVAILABLE rather than skipping the axis',
  },
  OFFLINE: {
    kind: 'OFFLINE',
    label: 'offline',
    requires: ['OFFLINE'],
    media: NO_MEDIA_OVERRIDE,
    zoomFactor: null,
    differenceKind: 'STRUCTURAL',
    needsDeclaration: false,
    why: 'the whole network gone, document included: this is the service-worker and offline-shell question. Owned by this axis and deliberately NOT by the fault axis, so one screen does not mint two items',
  },
  PERMISSION_GRANTED: {
    kind: 'PERMISSION_GRANTED',
    label: 'permission granted',
    requires: ['PERMISSIONS'],
    media: NO_MEDIA_OVERRIDE,
    zoomFactor: null,
    differenceKind: 'STRUCTURAL',
    needsDeclaration: true,
    why: 'the happy half of a permission flow — the scanner opens, the clipboard write succeeds. Only planned for a route a declarer says asks for the permission',
  },
  PERMISSION_DENIED: {
    kind: 'PERMISSION_DENIED',
    label: 'permission denied',
    requires: ['PERMISSIONS'],
    media: NO_MEDIA_OVERRIDE,
    zoomFactor: null,
    differenceKind: 'STRUCTURAL',
    needsDeclaration: true,
    why: 'the half that ships broken: the fallback message, the retry, the disabled control. Also the only state a real user who clicked "Block" ever sees again',
  },
};

// ─── Locales (register item 3) ───────────────────────────────────────────────

/**
 * How the application selects a locale, which decides what the plan tells the
 * adapter to DO.
 *
 * It matters more than it looks. A `PATH_PREFIX` app needs a navigation to
 * `/fr/pricing` and the route must then be collapsed back onto `/pricing` or
 * the denominator multiplies; an `ACCEPT_LANGUAGE` app needs a fresh context
 * and the URL never changes, so there is nothing to collapse and no risk of
 * multiplication at all.
 */
export const LOCALE_MECHANISMS = [
  'PATH_PREFIX',
  'SUBDOMAIN',
  'QUERY_PARAM',
  'ACCEPT_LANGUAGE',
  'COOKIE',
] as const;
export type LocaleMechanism = (typeof LOCALE_MECHANISMS)[number];

/** Which mechanisms change the URL, and therefore need route collapsing. */
export const URL_BEARING_LOCALE_MECHANISMS: readonly LocaleMechanism[] = [
  'PATH_PREFIX',
  'SUBDOMAIN',
  'QUERY_PARAM',
];

/**
 * A locale as this module needs it. DISCOVERING these is the source analysis's
 * job; this is the input shape.
 */
export interface LocaleInput {
  /** BCP-47 as the app spells it: `pt-BR`, not `pt_br`. The coordinate value. */
  tag: string;
  /** RTL re-lays-out the page, so it is not a string swap. */
  rtl: boolean;
  isDefault: boolean;
  /** False when the environment cannot serve it — a cell, not a gap. */
  available: boolean;
}

/**
 * Splits a path into its route template and its locale, and ONLY ever strips a
 * segment that a declared locale claims.
 *
 * This is the function that stops twelve locales from multiplying the
 * denominator by twelve, and the "only declared" rule is what stops it
 * destroying the denominator instead: `/fr` is a locale prefix in an app that
 * declares `fr` and an ordinary route segment in an app that does not, and
 * stripping it blind would merge `/fr/pricing` (a French page) with
 * `/pricing` in the first app and `/fr/pricing` (the France landing page) with
 * `/pricing` in the second. One of those is correct and one silently deletes a
 * route from the inventory.
 *
 * The comparison is case-insensitive and the RETURNED locale is the DECLARED
 * spelling, never the path's: `/PT-br/pricing` in an app that declares `pt-BR`
 * yields `pt-BR`, because the coordinate value has to be the dimension row's
 * key or the cell is a new cell every time somebody types a URL differently.
 */
export function canonicalLocalePath(
  path: string,
  locales: readonly LocaleInput[],
  mechanism: LocaleMechanism = 'PATH_PREFIX',
): { template: string; locale: string | null; spellingDiffers: boolean } {
  if (!URL_BEARING_LOCALE_MECHANISMS.includes(mechanism) || mechanism !== 'PATH_PREFIX') {
    // Nothing to strip: a subdomain or a query parameter is not part of the
    // path, and a header or cookie is not part of the URL at all.
    return { template: path, locale: null, spellingDiffers: false };
  }
  const segments = path.split('/');
  // ['', 'fr', 'pricing'] — index 1 is the first real segment.
  const first = segments[1];
  if (first === undefined || first === '') {
    return { template: path, locale: null, spellingDiffers: false };
  }
  const declared = locales.find((locale) => locale.tag.toLowerCase() === first.toLowerCase());
  if (declared === undefined) {
    return { template: path, locale: null, spellingDiffers: false };
  }
  const rest = `/${segments.slice(2).join('/')}`;
  return {
    // `/fr` alone is the French home page, which is `/` and not ''.
    template: rest === '/' || rest === '' ? '/' : rest.replace(/\/$/, ''),
    locale: declared.tag,
    spellingDiffers: declared.tag !== first,
  };
}

/** One route template and every localised path that collapsed onto it. */
export interface LocaleCollapse {
  template: string;
  /** The declared locale tags seen for it. */
  locales: string[];
  /** The paths that collapsed, so the operation is auditable. */
  paths: string[];
}

/**
 * Collapses localised paths onto their templates, and REPORTS how many.
 *
 * Collapsing shrinks the route denominator — twelve paths become one — and
 * every operation that shrinks a denominator has to be disclosed or it is
 * indistinguishable from the truncation this whole slice exists to stop. The
 * difference is that this one is CORRECT (twelve translations of one page are
 * one page to test, with a locale coordinate), and `collapsed` is the number
 * that lets a reader check the claim instead of taking it.
 */
export function collapseLocalisedRoutes(
  paths: readonly string[],
  locales: readonly LocaleInput[],
  mechanism: LocaleMechanism = 'PATH_PREFIX',
): { templates: LocaleCollapse[]; collapsed: number; rule: string } {
  const groups = new Map<string, LocaleCollapse>();
  let collapsed = 0;

  for (const path of paths) {
    const { template, locale } = canonicalLocalePath(path, locales, mechanism);
    const group = groups.get(template) ?? { template, locales: [], paths: [] };
    group.paths.push(path);
    if (locale !== null) {
      collapsed += 1;
      if (!group.locales.includes(locale)) group.locales.push(locale);
    }
    groups.set(template, group);
  }

  const templates = [...groups.values()];
  return {
    templates,
    collapsed,
    rule:
      `${collapsed} localised path(s) collapsed onto ${templates.length} route template(s): ` +
      `a localised route is ONE route with a LOCALE coordinate, never a second route. ` +
      `Counting them separately would divide the route coverage percentage by the ` +
      `number of locales for no reason connected to any test.`,
  };
}

// ─── Fault injection (register item 4) ───────────────────────────────────────

/**
 * The states a screen has that a crawl which never fails a request can never
 * reach.
 *
 * Eight, and each is named after WHAT THE USER SEES rather than after the HTTP
 * code, because the name ends up on a surface item a customer reads: "the
 * empty state of /orders" is a thing they can picture and "/orders with a
 * 200 and [] " is not.
 */
export const FAULT_STATES = [
  'LOADING',
  'SLOW',
  'EMPTY',
  'PARTIAL',
  'ERROR',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
] as const;
export type FaultState = (typeof FAULT_STATES)[number];

/** The compiler half of the keystone guard; variants.test.ts holds the other. */
const FAULT_STATE_PRESENT: Record<FaultState, true> = {
  LOADING: true,
  SLOW: true,
  EMPTY: true,
  PARTIAL: true,
  ERROR: true,
  FORBIDDEN: true,
  NOT_FOUND: true,
  RATE_LIMITED: true,
};

export const FAULT_STATE_KINDS = Object.keys(FAULT_STATE_PRESENT) as readonly FaultState[];

/** How a state is produced. The adapter switches on `kind` and nothing else. */
export interface FaultMechanism {
  kind: 'STATUS' | 'ABORT' | 'DELAY' | 'BODY';
  /** For STATUS. */
  status: number | null;
  /** For DELAY. */
  delayMillis: number | null;
  /** For BODY. */
  body: 'EMPTY_COLLECTION' | 'TRUNCATED' | null;
  detail: string;
}

/**
 * State → mechanism, as data.
 *
 * LOADING is the interesting one: it is a DELAY long enough that the response
 * never arrives within the observation window, which is the only way to hold a
 * skeleton on screen long enough to enumerate it. It is not an ABORT — an
 * abort produces the ERROR state, and a harness that conflated them would
 * report a spinner where the app actually shows a failure message.
 */
export const FAULT_MECHANISMS: Record<FaultState, FaultMechanism> = {
  LOADING: {
    kind: 'DELAY',
    status: null,
    delayMillis: 30_000,
    body: null,
    detail: 'hold the response past the observation window so the skeleton stays on screen',
  },
  SLOW: {
    kind: 'DELAY',
    status: null,
    delayMillis: 3_000,
    body: null,
    detail:
      'answer late, so a spinner, a timeout and a double-submit guard all get a chance to be wrong',
  },
  EMPTY: {
    kind: 'BODY',
    status: 200,
    delayMillis: null,
    body: 'EMPTY_COLLECTION',
    detail: 'a successful response with nothing in it — the zero-result screen',
  },
  PARTIAL: {
    kind: 'BODY',
    status: 200,
    delayMillis: null,
    body: 'TRUNCATED',
    detail: 'a response missing fields the UI reads, which is what a rolling deploy looks like',
  },
  ERROR: {
    kind: 'STATUS',
    status: 500,
    delayMillis: null,
    body: null,
    detail: 'the server failed — the error boundary half of the screen',
  },
  FORBIDDEN: {
    kind: 'STATUS',
    status: 403,
    delayMillis: null,
    body: null,
    detail:
      'authorised for the page and not for the data, which is the state a role change produces',
  },
  NOT_FOUND: {
    kind: 'STATUS',
    status: 404,
    delayMillis: null,
    body: null,
    detail: 'the record is gone — a bookmarked deep link after a delete',
  },
  RATE_LIMITED: {
    kind: 'STATUS',
    status: 429,
    delayMillis: null,
    body: null,
    detail: 'throttled, which almost no UI handles and every API does',
  },
};

/**
 * The three states planned by default.
 *
 * ERROR, EMPTY and SLOW, because they are the three a reviewer can always
 * justify: every screen that loads data has a failure, an emptiness and a
 * latency. The other five are planned when a caller asks, and the ones NOT
 * planned are disclosed as a cap bite — "5 more states per request existed" —
 * rather than being absent from the report.
 */
export const DEFAULT_FAULT_STATES: readonly FaultState[] = ['ERROR', 'EMPTY', 'SLOW'];

/**
 * The methods a fault may be injected against. NEVER anything else.
 *
 * This is a hard rule and not a budget: failing a `POST /api/orders` means
 * issuing it. The request is already in flight by the time an interceptor sees
 * it, so "fail it" is indistinguishable from "place the order and then lie to
 * the page about the outcome" — which can leave a real order, a real charge
 * and a real email behind, and a UI state nobody can reproduce. A
 * non-idempotent request is therefore REFUSED with a named rule, counted in
 * the inventory, and never silently skipped.
 */
export const IDEMPOTENT_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'TRACE'];

export const NON_IDEMPOTENT_RULE =
  'faults: a non-idempotent request is never injected against — failing a POST means first issuing it';

/**
 * One request the observe pass saw, as this module needs it.
 *
 * PATH ONLY and no query VALUES, the same rule traffic.ts enforces on upload:
 * a request matcher is STORED on a plan, rendered in a cockpit and exported,
 * and `?token=…`, `?email=…` and `?q=my+diagnosis` are all equally
 * unacceptable there. {@link requestMatcherFor} strips anything that gets
 * through, so a careless adapter cannot put one in.
 */
export interface VariantRequestObservation {
  /** The in-app route whose page issued it, normalised. */
  issuedFromRoute: string;
  /** Upper-cased HTTP method, as observed. */
  method: string;
  /** Origin of the request target, so an off-origin call can be refused. */
  origin: string;
  /** Path of the request target. No query, no fragment. */
  path: string;
  /**
   * Playwright's resource type when it was recorded, lower-cased. Null when
   * the observe pass did not record one — which must not be read as 'other',
   * because resource type is how `xhr`/`fetch` get ranked ahead of an image.
   */
  resourceType: string | null;
  /** How many times the page issued it. Ranking signal and nothing more. */
  occurrences: number;
  /** The status it answered with, when recorded. Null = not recorded. */
  status: number | null;
}

/**
 * A request to intercept. `pathGlob` is matched with `matchesGlob` from
 * @qaai/shared — the ONE glob implementation, so a panel previewing "which
 * requests will be failed" and the adapter deciding it cannot disagree.
 */
export interface RequestMatcher {
  method: string;
  pathGlob: string;
  issuedFromRoute: string;
}

/** Drops the query and the fragment. The privacy rule, enforced in one place. */
export function normaliseRequestPath(raw: string): string {
  const withoutFragment = raw.split('#')[0] ?? '';
  return withoutFragment.split('?')[0] ?? '';
}

export function requestMatcherFor(request: VariantRequestObservation): RequestMatcher {
  return {
    method: request.method.toUpperCase(),
    pathGlob: normaliseRequestPath(request.path),
    issuedFromRoute: request.issuedFromRoute,
  };
}

/** Whether a matcher claims a request. Used by the adapter and by the tests. */
export function requestMatches(
  matcher: RequestMatcher,
  request: VariantRequestObservation,
): boolean {
  if (matcher.method !== request.method.toUpperCase()) return false;
  return matchesGlob(matcher.pathGlob, normaliseRequestPath(request.path));
}

/**
 * Whether a fault may be injected against this request, and WHICH rule
 * decided — the same shape as `policyDecision`, for the same reason: a refusal
 * with no rule is indistinguishable from a bug in the crawler, and the
 * customer's only response to that is to distrust the number.
 */
export function injectionDecision(
  request: VariantRequestObservation,
  ownOrigins: readonly string[],
): { admitted: boolean; rule: string } {
  if (!IDEMPOTENT_METHODS.includes(request.method.toUpperCase())) {
    return { admitted: false, rule: NON_IDEMPOTENT_RULE };
  }
  if (!ownOrigins.includes(request.origin)) {
    return {
      admitted: false,
      rule: `faults: ${request.origin} is not this application's origin — failing it would test somebody else's surface`,
    };
  }
  return { admitted: true, rule: 'admitted' };
}

/**
 * Requests ranked by how likely failing them is to change the screen.
 *
 * A document or an xhr/fetch is what the page renders FROM; a font failing
 * changes nothing a test can assert. Occurrences break ties, because a request
 * the page makes on every visit is load-bearing and one it made once was
 * probably a lazily-loaded extra. A null `resourceType` ranks last among
 * recorded ones rather than being treated as 'other' — "nobody recorded it" is
 * not evidence that it is an image.
 */
const RESOURCE_RANK: Record<string, number> = {
  document: 0,
  xhr: 1,
  fetch: 1,
  websocket: 2,
  script: 3,
  stylesheet: 4,
};

function resourceRank(resourceType: string | null): number {
  if (resourceType === null) return 5;
  return RESOURCE_RANK[resourceType] ?? 6;
}

// ─── Data-state profiles (register item 5) ───────────────────────────────────

/**
 * The data states one account cannot show you.
 *
 * Seven, and every one of them is a screen a customer has shipped broken at
 * least once: the empty state nobody designed, the overflow nobody paginated,
 * the boundary nobody rounded, the trial expiry that locks a user out of their
 * own data, the quota wall, and the plan tier whose feature flag hides half
 * the navigation.
 */
export const DATA_PROFILE_KINDS = [
  'EMPTY',
  'TYPICAL',
  'HEAVY',
  'BOUNDARY',
  'TRIAL_EXPIRED',
  'QUOTA_EXCEEDED',
  'PLAN_TIER',
] as const;
export type DataProfileKind = (typeof DATA_PROFILE_KINDS)[number];

export const DATA_PROFILE_LABELS: Record<DataProfileKind, string> = {
  EMPTY: 'no records at all — the zero-result and first-run screens',
  TYPICAL: 'the ordinary account a crawl already sees',
  HEAVY: 'enough records to paginate, virtualise and overflow',
  BOUNDARY: 'the values at the edges: one record, the maximum, zero-length, maximum-length',
  TRIAL_EXPIRED: 'a lapsed trial — the lock-out screen and whatever it still leaks',
  QUOTA_EXCEEDED: 'a limit already spent, so every create path must refuse',
  PLAN_TIER: 'a plan whose entitlements hide or disable part of the application',
};

/**
 * The baseline profile: what a crawl with one ordinary account already sees.
 *
 * Named, because "the data the crawl happened to have" is not a baseline
 * anything can be attributed against, and the existing crawl's account is
 * exactly that.
 */
export const BASELINE_DATA_PROFILE_KIND: DataProfileKind = 'TYPICAL';

/**
 * A named data profile, bound to an identity.
 *
 * THE DATA IS THE CUSTOMER'S. This module owns the vocabulary, the plan and the
 * attribution; seeding an account with 10,000 orders is the customer's
 * environment's job and nothing here pretends otherwise. What this shape
 * insists on is that a profile names the IDENTITY it is reached through — a
 * profile with no credential cannot be crawled, and saying
 * "UNEXERCISABLE: needs a disposable record and none is provisioned" is worth
 * more than reporting its screens as uncovered gaps the customer could close
 * if only they knew how.
 */
export interface DataProfile {
  /** Identity within the project. The customer's own spelling, never folded. */
  key: string;
  kind: DataProfileKind;
  label: string;
  /** The auth profile / storage state this profile is reached through. */
  identityRef: string | null;
  /** Whether the environment can currently produce it. */
  available: boolean;
  /** Why not. Required by convention when `available` is false. */
  unavailableReason: UnexercisableReason | null;
  /**
   * Routes the customer says this profile changes. EMPTY MEANS UNKNOWN, not
   * none: an empty list makes the planner sample representative nodes rather
   * than plan nothing, and the difference is recorded in the plan's rule.
   */
  routes: readonly string[];
  evidence: string;
}

// ─── The shared plan shape ───────────────────────────────────────────────────

/**
 * A node of the baseline crawl, as this module needs it.
 *
 * Narrower than `FlowNode` on purpose, and the precedent is `BoundaryForm`: the
 * only callers that could supply a full `FlowNode` are the ones holding a live
 * crawl, while the integrator reading a stored FlowMap has counts and not
 * locators. Asking for exactly what is read means nobody has to invent a field
 * to satisfy the signature.
 *
 * There is deliberately no `depth`: `FlowNode` does not store one. The crawl
 * queue is breadth-first, so the ARRAY ORDER is depth order and the first node
 * of a route template is its shallowest instance. That is a fact about the
 * caller, so it is written down here rather than assumed.
 */
export interface VariantNode {
  id: string;
  /** Normalised route template: `/orders/:id`. */
  route: string;
  stateKey: string;
  /** `node.forms.length`. */
  forms: number;
  /**
   * `node.affordances.length`, or NULL when the crawl did not record them.
   * Null is not 0: an unrecorded affordance count must not make a page look
   * like a page with nothing on it, so it is ranked on forms alone and the
   * count of such nodes is disclosed in the plan's rule.
   */
  affordances: number | null;
}

/** What the adapter must do to produce a variant. One arm per capability. */
export type VariantSetup =
  | { kind: 'DEVICE'; profile: DeviceProfile }
  | { kind: 'MEDIA'; media: RenderMediaOverride }
  | { kind: 'ZOOM'; factor: number }
  | { kind: 'OFFLINE' }
  | { kind: 'PERMISSIONS'; granted: readonly BrowserPermission[]; permission: BrowserPermission }
  | { kind: 'LOCALE'; tag: string; mechanism: LocaleMechanism; url: string | null }
  | { kind: 'FAULT'; match: RequestMatcher; state: FaultState; mechanism: FaultMechanism }
  | { kind: 'DATA'; profileKey: string; identityRef: string | null };

/**
 * Setup kind → the capability it needs, enforced by the compiler.
 *
 * The guard that matters most in this file: a new setup arm with no capability
 * would be a variant the planner emits, the adapter cannot run, and nothing
 * reports as unavailable — a silently skipped axis, which is the failure mode
 * this module exists to make impossible.
 */
export const VARIANT_SETUP_CAPABILITY: Record<VariantSetup['kind'], VariantCapability> = {
  DEVICE: 'VIEWPORT',
  MEDIA: 'EMULATE_MEDIA',
  ZOOM: 'ZOOM',
  OFFLINE: 'OFFLINE',
  PERMISSIONS: 'PERMISSIONS',
  LOCALE: 'LOCALE_CONTEXT',
  FAULT: 'ROUTE_INTERCEPT',
  DATA: 'IDENTITY',
};

/**
 * Which setups need a FRESH BROWSER CONTEXT rather than a call on the open one.
 *
 * Playwright fixes `locale`, `hasTouch`, `deviceScaleFactor`, `userAgent` and
 * `storageState` at context creation; `emulateMedia`, `setOffline`,
 * `grantPermissions` and `route` all work on a live page. That is a cost
 * difference of a whole browser context per variant, so it belongs in the cost
 * model — and it is also the reason the device and locale axes are sampled
 * harder than the render axis.
 */
export const VARIANT_SETUP_NEEDS_CONTEXT: Record<VariantSetup['kind'], boolean> = {
  DEVICE: true,
  MEDIA: false,
  ZOOM: false,
  OFFLINE: false,
  PERMISSIONS: false,
  LOCALE: true,
  FAULT: false,
  DATA: true,
};

/** One variant of one base, planned. */
export interface PlannedVariant {
  /** Stable and deterministic: the same inputs give the same ids every run. */
  id: string;
  axis: VariantAxis;
  /** The route template this variant re-visits. */
  base: string;
  /** The node of the baseline crawl it re-visits. */
  nodeId: string;
  /** The `CoverageItem.key` this variant mints if it yields surface. */
  surfaceKey: string;
  surfaceKind: SurfaceKind;
  /** Non-empty only on the two axes that ARE dimension pairings. */
  coordinates: DimensionCoordinate[];
  setup: VariantSetup;
  requires: readonly VariantCapability[];
  /**
   * Null when this variant can be driven here. Set when it cannot — and the
   * variant STAYS IN THE PLAN with it set, named and counted, rather than
   * being dropped. See `NON_DENOMINATOR_EXERCISABILITIES`: dropping the hard
   * ones is what makes a coverage number go up.
   */
  exercise: SurfaceExercise | null;
  estimatedMillis: number;
  why: string;
}

/** The cost model, as an options object. No env vars; see binding rule 4. */
export interface VariantCostModel {
  /** Navigate, settle, read the page. */
  visitMillis: number;
  /** Extra for a variant that needs a fresh browser context. */
  contextMillis: number;
}

export const DEFAULT_VARIANT_COST: VariantCostModel = {
  visitMillis: 4_000,
  contextMillis: 1_500,
};

/**
 * The sampling budgets. Every one of them is a cap, so every one of them is
 * reported when it bites.
 */
export interface VariantBudget {
  nodesPerDevice: number;
  nodesPerRenderAxis: number;
  nodesPerLocale: number;
  faultRoutes: number;
  requestsPerRoute: number;
  statesPerRequest: number;
  nodesPerDataProfile: number;
  /** The ceiling across every axis, applied last by `planVariantCrawl`. */
  totalVisits: number;
}

export const DEFAULT_VARIANT_BUDGET: VariantBudget = {
  nodesPerDevice: 25,
  nodesPerRenderAxis: 10,
  nodesPerLocale: 25,
  faultRoutes: 25,
  requestsPerRoute: 3,
  statesPerRequest: 3,
  nodesPerDataProfile: 25,
  totalVisits: 400,
};

/**
 * The cap members used for variant truncation.
 *
 * `CRAWL_CAPS` has no variant member, and these two are the honest fits: a
 * limit on how many pages the variant pass may visit IS a page budget, and
 * taking one node per route template IS a per-template budget. Both are
 * disclosed through the same `FlowMap.caps` ledger as every other cap, which
 * means `enumerationOutcome` already refuses to call a crawl CONVERGED when a
 * variant sample bit — which is correct, and would not happen if these lived
 * in a vocabulary of their own that nothing consumed. `scope` always names the
 * axis, so a reader can tell a variant bite from the crawl's own.
 *
 * Two dedicated members (`VARIANT_SAMPLE`, `FAULT_INJECTION_BUDGET`) would
 * label the report better; they are a one-line addition to `CRAWL_CAPS` and
 * `CRAWL_CAP_LABELS` and these two constants are the only place to change.
 */
const VARIANT_BUDGET_CAP: CrawlCap = 'PAGE_BUDGET';
const VARIANT_TEMPLATE_CAP: CrawlCap = 'PER_TEMPLATE_BUDGET';

/**
 * A base the crawl policy refuses, recorded so it lands in the EXCLUSION
 * LEDGER rather than among the variants.
 *
 * A refused BASE and a refused VARIANT are different facts and belong in
 * different places. "The policy excludes /admin, so no device variant of it was
 * planned" is a statement about a path, which `FlowMap.excluded` already exists
 * to hold — and putting it there means one reader renders every refusal in the
 * crawl, however it arose. "We will never inject a fault against
 * POST /api/orders" is a statement about a VARIANT of a path we did enumerate,
 * so it stays in the plan as a held-out variant with its rule.
 */
export interface VariantRefusal {
  axis: VariantAxis;
  base: string;
  nodeId: string;
  /** The rule from `policyDecision` — a line a human can look up. */
  rule: string;
  /** The shared ledger's own vocabulary, so one reader renders every refusal. */
  kind: ExclusionKind;
  why: string;
}

/** One axis's plan. The same shape for all five axes. */
export interface VariantPlan {
  axis: VariantAxis;
  /** Everything planned, including the held-out ones. */
  variants: PlannedVariant[];
  /** Bases the policy refused. For `FlowMap.excluded`, not for the denominator. */
  refusedBases: VariantRefusal[];
  /**
   * Every budget that bit, with a `bites` count AND a `discarded` count. A
   * plan with an empty array enumerated every candidate it was given.
   */
  caps: CapBite[];
  /** Variants that can actually be driven here. */
  runnable: number;
  /** Planned, named, counted, and not drivable here. */
  heldOut: number;
  estimatedMillis: number;
  /**
   * AT LEAST this many more variants on this axis existed and were not
   * planned. Candidates we actually held — never an estimate. Same contract as
   * `lowerBoundMoreUrls`.
   */
  atLeastMoreVariants: number;
  /** The sentence the report prints where a product would otherwise go. */
  rule: string;
}

/** Every axis's plan, plus the ceiling applied across them. */
export interface VariantCrawlPlan {
  plans: VariantPlan[];
  /** Flattened, in plan order, after the overall ceiling. */
  variants: PlannedVariant[];
  /** Every axis's refusals, flattened. Destined for `FlowMap.excluded`. */
  refusedBases: VariantRefusal[];
  caps: CapBite[];
  runnable: number;
  heldOut: number;
  estimatedMillis: number;
  atLeastMoreVariants: number;
  /** Axes that produced nothing, and WHY — never an absent axis. */
  emptyAxes: Array<{ axis: VariantAxis; why: string }>;
  rule: string;
}

// ─── Plan construction helpers ───────────────────────────────────────────────

/** The context every planner shares. */
export interface VariantContext {
  nodes: readonly VariantNode[];
  policy: CrawlPolicy;
  available: readonly VariantCapability[];
  budget: VariantBudget;
  cost: VariantCostModel;
  /** Origins that are this application's own, for the fault axis. */
  ownOrigins: readonly string[];
}

export function variantContext(input: {
  nodes: readonly VariantNode[];
  policy: CrawlPolicy;
  available: readonly VariantCapability[];
  ownOrigins?: readonly string[];
  budget?: Partial<VariantBudget>;
  cost?: Partial<VariantCostModel>;
}): VariantContext {
  return {
    nodes: input.nodes,
    policy: input.policy,
    available: input.available,
    budget: { ...DEFAULT_VARIANT_BUDGET, ...(input.budget ?? {}) },
    cost: { ...DEFAULT_VARIANT_COST, ...(input.cost ?? {}) },
    ownOrigins: input.ownOrigins ?? [],
  };
}

function capBite(
  cap: CrawlCap,
  limit: number,
  bites: number,
  discarded: number,
  scope: string,
  reason: string,
): CapBite {
  return { cap, limit, bites, discarded, scope, reason };
}

/**
 * The nodes worth re-crawling on an axis, and everything that decision dropped.
 *
 * Two rules, both disclosed:
 *
 * 1. ONE NODE PER ROUTE TEMPLATE. Re-crawling a second `/orders/:id` at 390px
 *    cannot teach us anything the first one did not, because the template is
 *    the thing that has a layout. This is the rule that keeps the device axis
 *    affordable at all, and it is reported as a `PER_TEMPLATE_BUDGET` bite
 *    with the number of sibling nodes it discarded.
 *
 * 2. RANKED, THEN TRUNCATED. The ranking puts the entry node first (it is the
 *    navigation, and navigation is what collapses on a phone), then the pages
 *    with the most controls, then the ones with forms. A page with controls is
 *    where a responsive control can hide; a page with none cannot have a
 *    mobile-only button. What the truncation dropped is a `PAGE_BUDGET` bite.
 */
export function selectRepresentatives(
  ctx: VariantContext,
  axis: VariantAxis,
  limit: number,
): {
  /** The representatives inside the limit. */
  chosen: VariantNode[];
  /** Every admitted template representative, ranked, BEFORE the limit. */
  ranked: VariantNode[];
  caps: CapBite[];
  /** Nodes whose affordance count was never recorded. Disclosed, not assumed. */
  unranked: number;
  refusedBases: VariantRefusal[];
} {
  const caps: CapBite[] = [];
  const scope = variantScope(axis);

  /*
   * The policy is re-applied even though the baseline crawl already applied
   * it: a policy can be tightened between the crawl that produced these nodes
   * and the variant pass, and re-visiting a route the customer has since
   * excluded would be driving a path they revoked. Refusals are RETURNED
   * rather than dropped, so the report can tell a refusal from a nonexistent
   * surface.
   */
  const admitted: VariantNode[] = [];
  const refusedBases: VariantRefusal[] = [];
  const refusedRoutes = new Set<string>();
  for (const node of ctx.nodes) {
    const decision = policyDecision(ctx.policy, node.route);
    if (decision.admitted) {
      admitted.push(node);
      continue;
    }
    if (refusedRoutes.has(node.route)) continue;
    refusedRoutes.add(node.route);
    refusedBases.push({
      axis,
      base: node.route,
      nodeId: node.id,
      rule: decision.rule,
      kind: decision.rule.startsWith('includeGlobs') ? 'POLICY_NOT_INCLUDED' : 'POLICY_EXCLUDE',
      why: `no ${axis} variant of ${node.route} was planned: the crawl policy refuses it, which is a different fact from the route not existing`,
    });
  }

  const byTemplate = new Map<string, VariantNode>();
  const templatesWithSiblings = new Set<string>();
  let siblingsDiscarded = 0;
  for (const node of admitted) {
    if (!byTemplate.has(node.route)) {
      byTemplate.set(node.route, node);
      continue;
    }
    siblingsDiscarded += 1;
    templatesWithSiblings.add(node.route);
  }
  if (siblingsDiscarded > 0) {
    caps.push(
      capBite(
        VARIANT_TEMPLATE_CAP,
        1,
        templatesWithSiblings.size,
        siblingsDiscarded,
        scope,
        `one node per route template: ${siblingsDiscarded} further state(s) of ${templatesWithSiblings.size} already-chosen template(s) were not re-visited, because a second instance of a template has the same layout as the first`,
      ),
    );
  }

  const unranked = admitted.filter((node) => node.affordances === null).length;
  const sorted = [...byTemplate.values()].sort((left, right) => {
    /*
     * `?? -1` and NOT `?? 0`: an unrecorded affordance count ranks BELOW a
     * page recorded as having none, because "nobody counted" is not evidence
     * that a page is empty. The count of such nodes rides in the plan's rule
     * so the ranking is auditable rather than asserted.
     */
    const leftControls = left.affordances ?? -1;
    const rightControls = right.affordances ?? -1;
    if (leftControls !== rightControls) return rightControls - leftControls;
    if (left.forms !== right.forms) return right.forms - left.forms;
    return left.route.localeCompare(right.route);
  });
  /*
   * The entry node is first whatever its control count, because it is the
   * navigation and the navigation is the single most device-sensitive thing in
   * any application. `ctx.nodes[0]` is the entry node by construction: the
   * crawl pushes the base URL first.
   */
  const entry = ctx.nodes[0];
  const ranked =
    entry !== undefined && sorted.some((node) => node.id === entry.id)
      ? [entry, ...sorted.filter((node) => node.id !== entry.id)]
      : sorted;

  const take = takeWithBite(ranked, limit, scope, 'route template');
  if (take.cap !== null) caps.push(take.cap);

  return { chosen: take.taken, ranked, caps, unranked, refusedBases };
}

function variantScope(axis: VariantAxis): string {
  return `${axis} variant pass`;
}

/**
 * Takes the first `limit` of a ranked list and DISCLOSES what that cost.
 *
 * One helper rather than four copies, because the cap bite is the part a
 * planner is most likely to forget — and a budget that bit without saying so
 * is the single defect this slice exists to remove.
 */
function takeWithBite<T>(
  items: readonly T[],
  limit: number,
  scope: string,
  what: string,
): { taken: T[]; cap: CapBite | null } {
  const taken = items.slice(0, Math.max(0, limit));
  const dropped = items.length - taken.length;
  if (dropped <= 0) return { taken, cap: null };
  return {
    taken,
    cap: capBite(
      VARIANT_BUDGET_CAP,
      limit,
      1,
      dropped,
      scope,
      `${scope}: ${taken.length} of ${items.length} ${what}(s) were planned; at least ${dropped} more existed and were not enumerated`,
    ),
  };
}

/** `%`-free state identity for the axes that are states rather than pairings. */
function stateIdentity(base: string, state: string): string {
  return `${base}#${state.replace(/#/g, '%23')}`;
}

function dimensionVariantKey(
  axis: 'DEVICE' | 'LOCALE',
  base: string,
  value: string,
): { surfaceKey: string; surfaceKind: SurfaceKind; coordinates: DimensionCoordinate[] } {
  const dimension = axis;
  const coordinates: DimensionCoordinate[] = [{ dimension, value }];
  const kind = VARIANT_AXIS_SURFACE_KIND[axis];
  return {
    // Never hand-built: `dimensionCellIdentity` is the one spelling six
    // writers have to agree on byte for byte.
    surfaceKey: surfaceKey(kind, dimensionCellIdentity(base, coordinates)),
    surfaceKind: kind,
    coordinates,
  };
}

function stateVariantKey(
  axis: 'RENDER' | 'FAULT' | 'DATA',
  base: string,
  state: string,
): { surfaceKey: string; surfaceKind: SurfaceKind; coordinates: DimensionCoordinate[] } {
  const kind = VARIANT_AXIS_SURFACE_KIND[axis];
  return {
    surfaceKey: surfaceKey(kind, stateIdentity(base, state)),
    surfaceKind: kind,
    coordinates: [],
  };
}

function capabilityExercise(
  missing: readonly VariantCapability[],
  what: string,
): SurfaceExercise | null {
  if (missing.length === 0) return null;
  return {
    state: 'UNEXERCISABLE',
    reason: 'CAPABILITY_UNAVAILABLE',
    rule: null,
    detail: `${what} needs ${missing
      .map((capability) => `${capability} (${VARIANT_CAPABILITY_ADAPTER[capability]})`)
      .join(', ')}, which this harness does not have`,
  };
}

function estimate(ctx: VariantContext, setup: VariantSetup): number {
  const context = VARIANT_SETUP_NEEDS_CONTEXT[setup.kind] ? ctx.cost.contextMillis : 0;
  const delay =
    setup.kind === 'FAULT' && setup.mechanism.delayMillis !== null
      ? setup.mechanism.delayMillis
      : 0;
  return ctx.cost.visitMillis + context + delay;
}

function plannedVariant(
  ctx: VariantContext,
  input: {
    axis: VariantAxis;
    base: string;
    nodeId: string;
    variantKey: string;
    setup: VariantSetup;
    keys: { surfaceKey: string; surfaceKind: SurfaceKind; coordinates: DimensionCoordinate[] };
    exercise: SurfaceExercise | null;
    why: string;
  },
): PlannedVariant {
  const required: VariantCapability[] = [VARIANT_SETUP_CAPABILITY[input.setup.kind]];
  return {
    id: `${input.axis}:${input.base}#${input.variantKey}`,
    axis: input.axis,
    base: input.base,
    nodeId: input.nodeId,
    surfaceKey: input.keys.surfaceKey,
    surfaceKind: input.keys.surfaceKind,
    coordinates: input.keys.coordinates,
    setup: input.setup,
    requires: required,
    exercise:
      input.exercise ?? capabilityExercise(missingCapabilities(required, ctx.available), input.why),
    estimatedMillis: estimate(ctx, input.setup),
    why: input.why,
  };
}

function finishPlan(
  axis: VariantAxis,
  variants: PlannedVariant[],
  caps: CapBite[],
  refusedBases: VariantRefusal[],
  rule: string,
): VariantPlan {
  const runnable = variants.filter((variant) => variant.exercise === null);
  return {
    axis,
    variants,
    refusedBases,
    caps,
    runnable: runnable.length,
    heldOut: variants.length - runnable.length,
    /*
     * Only the runnable ones cost anything. A held-out variant is named and
     * counted and will never be visited, so charging for it would make the
     * plan look more expensive the LESS the harness can do — and the obvious
     * response to an expensive plan is to cut the budget, which would hide the
     * held-out variants too.
     */
    estimatedMillis: runnable.reduce((running, variant) => running + variant.estimatedMillis, 0),
    atLeastMoreVariants: caps.reduce((running, cap) => running + cap.discarded, 0),
    rule,
  };
}

// ─── The five planners ───────────────────────────────────────────────────────

/**
 * The device plan (register item 1).
 *
 * Re-crawls the sampled representative of each route template at each device
 * other than the baseline. The baseline device is skipped deliberately and the
 * plan says so: the baseline crawl already visited every node at 1280×900, and
 * planning it again would double the cost to produce an attribution against
 * itself.
 */
export function planDeviceVariants(
  ctx: VariantContext,
  input?: { devices?: readonly DeviceProfile[]; baselineDeviceKey?: string },
): VariantPlan {
  const baselineKey = input?.baselineDeviceKey ?? BASELINE_DEVICE_KEY;
  const devices = (input?.devices ?? DEVICE_PROFILES).filter(
    (device) => device.key !== baselineKey,
  );
  const { chosen, caps, unranked, refusedBases } = selectRepresentatives(
    ctx,
    'DEVICE',
    ctx.budget.nodesPerDevice,
  );

  const variants: PlannedVariant[] = [];
  for (const device of devices) {
    for (const node of chosen) {
      variants.push(
        plannedVariant(ctx, {
          axis: 'DEVICE',
          base: node.route,
          nodeId: node.id,
          variantKey: device.key,
          setup: { kind: 'DEVICE', profile: device },
          keys: dimensionVariantKey('DEVICE', node.route, device.key),
          exercise: null,
          why: `${node.route} at ${device.label}: ${device.why}`,
        }),
      );
    }
  }

  return finishPlan(
    'DEVICE',
    variants,
    caps,
    refusedBases,
    `${chosen.length} route template(s) × ${devices.length} non-baseline device(s). ` +
      `The cross product of every node and every device was NOT planned: one node per ` +
      `template, ranked by control count, because the same page at two widths is one ` +
      `route and only a control that exists at one width is new surface.` +
      (unranked > 0
        ? ` ${unranked} node(s) had no recorded affordance count and were ranked below the pages that did.`
        : '') +
      (refusedBases.length > 0
        ? ` ${refusedBases.length} base(s) were refused by the crawl policy; they are in \`refusedBases\` for the exclusion ledger, not in the denominator.`
        : ''),
  );
}

/**
 * The render-environment plan (register item 2).
 *
 * `permissionRoutes` is required for the two permission axes and absent for
 * the rest. A permission variant is only planned where a declarer says the
 * route asks for the permission — see `RenderEnvironment.needsDeclaration` —
 * and an axis with no declaration produces an EMPTY plan with a stated reason
 * rather than cells for six permissions on every page.
 */
export function planRenderVariants(
  ctx: VariantContext,
  input?: {
    axes?: readonly RenderAxisKind[];
    permissionRoutes?: ReadonlyMap<string, readonly BrowserPermission[]>;
  },
): VariantPlan {
  const axes = input?.axes ?? RENDER_AXES;
  const permissionRoutes =
    input?.permissionRoutes ?? new Map<string, readonly BrowserPermission[]>();
  const { chosen, caps, refusedBases } = selectRepresentatives(
    ctx,
    'RENDER',
    ctx.budget.nodesPerRenderAxis,
  );
  const variants: PlannedVariant[] = [];
  const skippedAxes: string[] = [];

  for (const axisKind of axes) {
    const environment = RENDER_ENVIRONMENTS[axisKind];
    if (environment.needsDeclaration) {
      let planned = 0;
      for (const node of chosen) {
        for (const permission of permissionRoutes.get(node.route) ?? []) {
          const granted = axisKind === 'PERMISSION_GRANTED' ? [permission] : [];
          const state = `render=${axisKind}:${permission}`;
          variants.push(
            plannedVariant(ctx, {
              axis: 'RENDER',
              base: node.route,
              nodeId: node.id,
              variantKey: state,
              setup: { kind: 'PERMISSIONS', granted, permission },
              keys: stateVariantKey('RENDER', node.route, state),
              exercise: null,
              why: `${node.route} with ${permission} ${axisKind === 'PERMISSION_GRANTED' ? 'granted' : 'denied'}: ${environment.why}`,
            }),
          );
          planned += 1;
        }
      }
      if (planned === 0) {
        skippedAxes.push(
          `${axisKind}: no route among the sampled template(s) is declared to ask for a permission, so no cell was invented`,
        );
      }
      continue;
    }

    for (const node of chosen) {
      const state = `render=${axisKind}`;
      const setup: VariantSetup =
        environment.zoomFactor !== null
          ? { kind: 'ZOOM', factor: environment.zoomFactor }
          : axisKind === 'OFFLINE'
            ? { kind: 'OFFLINE' }
            : { kind: 'MEDIA', media: environment.media };
      variants.push(
        plannedVariant(ctx, {
          axis: 'RENDER',
          base: node.route,
          nodeId: node.id,
          variantKey: state,
          setup,
          keys: stateVariantKey('RENDER', node.route, state),
          exercise: null,
          why: `${node.route} under ${environment.label}: ${environment.why}`,
        }),
      );
    }
  }

  const visual = axes.filter((axis) => RENDER_ENVIRONMENTS[axis].differenceKind === 'VISUAL_ONLY');
  return finishPlan(
    'RENDER',
    variants,
    caps,
    refusedBases,
    `${chosen.length} route template(s) × ${axes.length} render axis(es). ` +
      `${visual.length} of those axes (${visual.join(', ')}) are VISUAL_ONLY: an identical ` +
      `structural signature there means "no structural difference" and must never be ` +
      `reported as covered — a visual check owns that question and this is not one.` +
      (skippedAxes.length > 0 ? ` Not planned: ${skippedAxes.join('; ')}.` : ''),
  );
}

/**
 * The locale plan (register item 3).
 *
 * The locale list is an INPUT: discovering which locales an application ships
 * is the source analysis's job. What this does is crawl per locale and keep the
 * result attributable to ONE route with a LOCALE coordinate, which is the
 * difference between adding an axis and dividing the route percentage by
 * twelve.
 */
export function planLocaleVariants(
  ctx: VariantContext,
  input: {
    locales: readonly LocaleInput[];
    mechanism?: LocaleMechanism;
    /** Base URL, so a PATH_PREFIX plan can carry the URL to navigate to. */
    baseUrl?: string;
  },
): VariantPlan {
  const mechanism = input.mechanism ?? 'PATH_PREFIX';
  const nonDefault = input.locales.filter((locale) => !locale.isDefault);
  const { chosen, caps, refusedBases } = selectRepresentatives(
    ctx,
    'LOCALE',
    ctx.budget.nodesPerLocale,
  );
  const variants: PlannedVariant[] = [];
  const minted = new Set<string>();

  for (const locale of nonDefault) {
    for (const node of chosen) {
      /*
       * The base is the CANONICAL template, not the localised path. A node the
       * crawl reached at `/fr/pricing` collapses onto `/pricing` here, so the
       * cell is `/pricing|LOCALE=fr` whichever path we happened to arrive by —
       * otherwise the same cell would have one identity per crawl.
       */
      const { template } = canonicalLocalePath(node.route, input.locales, mechanism);
      /*
       * `/pricing` and `/fr/pricing` both collapse onto `/pricing`, so without
       * this the same cell would be planned twice — and a duplicate cell is a
       * duplicate item in the denominator, which is the multiplication defect
       * arriving by the back door.
       */
      const cellId = `${template}|LOCALE=${locale.tag}`;
      if (minted.has(cellId)) continue;
      minted.add(cellId);
      const url =
        mechanism === 'PATH_PREFIX' && input.baseUrl !== undefined
          ? `${input.baseUrl.replace(/\/$/, '')}/${locale.tag}${template === '/' ? '' : template}`
          : null;
      variants.push(
        plannedVariant(ctx, {
          axis: 'LOCALE',
          base: template,
          nodeId: node.id,
          variantKey: locale.tag,
          setup: { kind: 'LOCALE', tag: locale.tag, mechanism, url },
          keys: dimensionVariantKey('LOCALE', template, locale.tag),
          exercise: locale.available
            ? null
            : {
                state: 'UNEXERCISABLE',
                reason: 'DIMENSION_UNAVAILABLE',
                rule: null,
                detail: `this environment cannot serve ${locale.tag}, so its cells are named and counted rather than reported as uncovered`,
              },
          why:
            `${template} in ${locale.tag}` +
            (locale.rtl ? ' (RTL — the page re-lays-out, so this is not a string swap)' : ''),
        }),
      );
    }
  }

  return finishPlan(
    'LOCALE',
    variants,
    caps,
    refusedBases,
    `${chosen.length} route template(s) × ${nonDefault.length} non-default locale(s), ` +
      `collapsed onto canonical templates via ${mechanism}. A localised route is ONE ` +
      `route with a LOCALE coordinate: twelve locales add twelve CELLS on the ` +
      `${VARIANT_AXIS_SURFACE_KIND.LOCALE} axis and ZERO routes, because counting them as ` +
      `routes would divide the route coverage percentage by twelve.`,
  );
}

/**
 * The fault-injection plan (register item 4).
 *
 * Driven entirely by the observed network inventory: a request nothing was
 * seen to make cannot be failed, and inventing one would be inventing a
 * measurement. Three budgets, each disclosed — routes, requests per route,
 * states per request — because the untruncated product is every request of
 * every page in eight states.
 */
export function planFaultVariants(
  ctx: VariantContext,
  input: {
    requests: readonly VariantRequestObservation[];
    states?: readonly FaultState[];
  },
): VariantPlan {
  const states = input.states ?? DEFAULT_FAULT_STATES;
  const caps: CapBite[] = [];
  const variants: PlannedVariant[] = [];

  // Group by the route that issued them, so the budgets are per route.
  const byRoute = new Map<string, VariantRequestObservation[]>();
  for (const request of input.requests) {
    const list = byRoute.get(request.issuedFromRoute) ?? [];
    list.push(request);
    byRoute.set(request.issuedFromRoute, list);
  }

  const nodeFor = new Map<string, VariantNode>();
  for (const node of ctx.nodes) if (!nodeFor.has(node.route)) nodeFor.set(node.route, node);

  /*
   * The policy is re-applied to the ROUTE that issues the requests, for the
   * same reason the other four axes re-apply it: a path the customer has since
   * excluded must not be driven, and the refusal belongs in the ledger rather
   * than being silently absent.
   */
  const refusedBases: VariantRefusal[] = [];
  const admittedRoutes: string[] = [];
  for (const route of byRoute.keys()) {
    const decision = policyDecision(ctx.policy, route);
    if (decision.admitted) {
      admittedRoutes.push(route);
      continue;
    }
    refusedBases.push({
      axis: 'FAULT',
      base: route,
      nodeId: nodeFor.get(route)?.id ?? route,
      rule: decision.rule,
      kind: decision.rule.startsWith('includeGlobs') ? 'POLICY_NOT_INCLUDED' : 'POLICY_EXCLUDE',
      why: `no fault was injected on ${route}: the crawl policy refuses it, which is a different fact from the route having no failure states`,
    });
  }

  const routes = admittedRoutes.sort((left, right) => {
    const leftCount = byRoute.get(left)?.length ?? 0;
    const rightCount = byRoute.get(right)?.length ?? 0;
    if (leftCount !== rightCount) return rightCount - leftCount;
    return left.localeCompare(right);
  });
  const plannedRoutes = routes.slice(0, Math.max(0, ctx.budget.faultRoutes));
  if (routes.length > plannedRoutes.length) {
    const dropped = routes
      .slice(plannedRoutes.length)
      .reduce((running, route) => running + (byRoute.get(route)?.length ?? 0), 0);
    caps.push(
      capBite(
        VARIANT_BUDGET_CAP,
        ctx.budget.faultRoutes,
        1,
        dropped,
        variantScope('FAULT'),
        `${plannedRoutes.length} of ${routes.length} route(s) with observed requests were planned; at least ${dropped} more request(s) existed and none of their failure states were enumerated`,
      ),
    );
  }

  let requestsDiscarded = 0;
  let requestBites = 0;
  let statesDiscarded = 0;
  let stateBites = 0;

  for (const route of plannedRoutes) {
    const observed = byRoute.get(route) ?? [];
    const admitted: VariantRequestObservation[] = [];
    for (const request of observed) {
      const decision = injectionDecision(request, ctx.ownOrigins);
      if (decision.admitted) {
        admitted.push(request);
        continue;
      }
      /*
       * A refusal gets a REFUSED variant with the rule, not a silent skip.
       * This is the one state the register's rule 9 names explicitly: a
       * surface that was refused and a surface that does not exist must never
       * be recorded the same way, and the fault axis is where most refusals
       * happen — every mutating request on every page.
       */
      const state = `fault=REFUSED:${request.method.toUpperCase()}:${normaliseRequestPath(request.path)}`;
      variants.push(
        plannedVariant(ctx, {
          axis: 'FAULT',
          base: route,
          nodeId: nodeFor.get(route)?.id ?? route,
          variantKey: state,
          setup: {
            kind: 'FAULT',
            match: requestMatcherFor(request),
            state: 'ERROR',
            mechanism: FAULT_MECHANISMS.ERROR,
          },
          keys: stateVariantKey('FAULT', route, state),
          exercise: {
            state: 'REFUSED',
            reason: null,
            rule: decision.rule,
            detail: `${request.method.toUpperCase()} ${normaliseRequestPath(request.path)} was never injected against: ${decision.rule}`,
          },
          why: `the failure states behind ${request.method.toUpperCase()} ${normaliseRequestPath(request.path)} are not enumerable here`,
        }),
      );
    }

    const ranked = [...admitted].sort((left, right) => {
      const rank = resourceRank(left.resourceType) - resourceRank(right.resourceType);
      if (rank !== 0) return rank;
      if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
      return normaliseRequestPath(left.path).localeCompare(normaliseRequestPath(right.path));
    });
    const chosenRequests = ranked.slice(0, Math.max(0, ctx.budget.requestsPerRoute));
    if (ranked.length > chosenRequests.length) {
      requestBites += 1;
      requestsDiscarded += ranked.length - chosenRequests.length;
    }

    const chosenStates = states.slice(0, Math.max(0, ctx.budget.statesPerRequest));
    if (states.length > chosenStates.length) {
      stateBites += 1;
      statesDiscarded += (states.length - chosenStates.length) * chosenRequests.length;
    }

    for (const request of chosenRequests) {
      const matcher = requestMatcherFor(request);
      for (const faultState of chosenStates) {
        const mechanism = FAULT_MECHANISMS[faultState];
        const state = `fault=${faultState}:${matcher.method}:${matcher.pathGlob}`;
        variants.push(
          plannedVariant(ctx, {
            axis: 'FAULT',
            base: route,
            nodeId: nodeFor.get(route)?.id ?? route,
            variantKey: state,
            setup: { kind: 'FAULT', match: matcher, state: faultState, mechanism },
            keys: stateVariantKey('FAULT', route, state),
            exercise: null,
            why: `${route} with ${matcher.method} ${matcher.pathGlob} in its ${faultState} state: ${mechanism.detail}`,
          }),
        );
      }
    }
  }

  if (requestsDiscarded > 0) {
    caps.push(
      capBite(
        VARIANT_BUDGET_CAP,
        ctx.budget.requestsPerRoute,
        requestBites,
        requestsDiscarded,
        'FAULT requests per route',
        `${requestsDiscarded} injectable request(s) across ${requestBites} route(s) were not planned; they were ranked below the per-route limit, not found absent`,
      ),
    );
  }
  if (statesDiscarded > 0) {
    caps.push(
      capBite(
        VARIANT_BUDGET_CAP,
        ctx.budget.statesPerRequest,
        stateBites,
        statesDiscarded,
        'FAULT states per request',
        `${statesDiscarded} failure state(s) were not planned across ${stateBites} route(s); of ${FAULT_STATES.length} states this module can produce, ${ctx.budget.statesPerRequest} were taken per request`,
      ),
    );
  }

  return finishPlan(
    'FAULT',
    variants,
    caps,
    refusedBases,
    `${plannedRoutes.length} route(s) × up to ${ctx.budget.requestsPerRoute} request(s) × up to ` +
      `${ctx.budget.statesPerRequest} state(s), from the OBSERVED network inventory only — a ` +
      `request nothing was seen to make cannot be failed. No fault is ever injected against a ` +
      `non-idempotent request: ${NON_IDEMPOTENT_RULE}.`,
  );
}

/**
 * The data-profile plan (register item 5).
 *
 * A profile that names no routes is sampled against the representative nodes,
 * because "the customer has not told us which screens this profile changes" is
 * not the same as "it changes none" — and the second reading would plan
 * nothing for every profile anybody set up without filling in a field.
 */
export function planDataVariants(
  ctx: VariantContext,
  input: { profiles: readonly DataProfile[] },
): VariantPlan {
  const baseline = input.profiles.find(
    (profile) => profile.kind === BASELINE_DATA_PROFILE_KIND && profile.identityRef !== null,
  );
  const profiles = input.profiles.filter((profile) => profile.key !== baseline?.key);
  const { chosen, ranked, caps, refusedBases } = selectRepresentatives(
    ctx,
    'DATA',
    ctx.budget.nodesPerDataProfile,
  );
  const variants: PlannedVariant[] = [];
  let declaredRouteProfiles = 0;

  for (const profile of profiles) {
    const declared = profile.routes.length > 0;
    if (declared) declaredRouteProfiles += 1;
    /*
     * A declared route list is filtered against `ranked` and not against
     * `ctx.nodes`, so it inherits the policy refusal and the one-node-per-
     * template rule — and it is then subject to the same budget, with the same
     * disclosure. A profile declaring 500 routes must not quietly buy itself a
     * bigger budget than the sampling rule gives every other profile.
     */
    const take = declared
      ? takeWithBite(
          ranked.filter((node) => profile.routes.includes(node.route)),
          ctx.budget.nodesPerDataProfile,
          `${variantScope('DATA')} (${profile.key})`,
          'declared route',
        )
      : { taken: chosen, cap: null };
    if (take.cap !== null) caps.push(take.cap);

    for (const node of take.taken) {
      const state = `data=${profile.key}`;
      variants.push(
        plannedVariant(ctx, {
          axis: 'DATA',
          base: node.route,
          nodeId: node.id,
          variantKey: state,
          setup: { kind: 'DATA', profileKey: profile.key, identityRef: profile.identityRef },
          keys: stateVariantKey('DATA', node.route, state),
          exercise: dataProfileExercise(profile),
          why: `${node.route} under the ${profile.key} profile (${DATA_PROFILE_LABELS[profile.kind]})`,
        }),
      );
    }
  }

  return finishPlan(
    'DATA',
    variants,
    caps,
    refusedBases,
    `${profiles.length} non-baseline profile(s); ${declaredRouteProfiles} of them named the ` +
      `routes they change and were planned against exactly those, the rest against ` +
      `${chosen.length} representative template(s) because an unstated route list means ` +
      `UNKNOWN and not NONE. The profile DATA is the environment's; this is the plan and the ` +
      `attribution.` +
      (baseline === undefined
        ? ' No baseline profile with an identity was supplied, so every profile here is attributed against the crawl as it ran.'
        : ` Attributed against the ${baseline.key} profile.`),
  );
}

/**
 * Why a profile cannot be driven, in the registry's own vocabulary.
 *
 * A profile with no identity is UNEXERCISABLE and not REFUSED: nobody excluded
 * it, we simply have no credential to reach it with, and the remedy
 * ("provision a disposable account") is the customer's to act on. Recording it
 * as REFUSED would send them looking through a crawl policy for a rule that
 * does not exist.
 */
function dataProfileExercise(profile: DataProfile): SurfaceExercise | null {
  if (profile.identityRef === null) {
    return {
      state: 'UNEXERCISABLE',
      reason: 'NEEDS_DISPOSABLE_DATA',
      rule: null,
      detail: `the ${profile.key} profile names no identity, so nothing can sign in as it; its screens are counted and named, never reported as uncovered`,
    };
  }
  if (!profile.available) {
    return {
      state: 'UNEXERCISABLE',
      reason: profile.unavailableReason ?? 'DIMENSION_UNAVAILABLE',
      rule: null,
      detail: `the ${profile.key} profile is not available in this environment: ${profile.evidence}`,
    };
  }
  return null;
}

/**
 * Every axis, planned, with the overall ceiling applied LAST and disclosed.
 *
 * The ceiling is applied here rather than inside each planner so that one axis
 * cannot consume the whole budget silently: each axis is sampled on its own
 * terms first, and the truncation across axes is a single bite a reader can
 * see. `emptyAxes` names any axis that produced nothing and why, because an
 * axis absent from a report reads as an axis with nothing in it.
 */
export function planVariantCrawl(
  ctx: VariantContext,
  input: {
    devices?: { devices?: readonly DeviceProfile[]; baselineDeviceKey?: string };
    render?: {
      axes?: readonly RenderAxisKind[];
      permissionRoutes?: ReadonlyMap<string, readonly BrowserPermission[]>;
    };
    locales?: { locales: readonly LocaleInput[]; mechanism?: LocaleMechanism; baseUrl?: string };
    faults?: { requests: readonly VariantRequestObservation[]; states?: readonly FaultState[] };
    data?: { profiles: readonly DataProfile[] };
  },
): VariantCrawlPlan {
  const plans: VariantPlan[] = [
    planDeviceVariants(ctx, input.devices),
    planRenderVariants(ctx, input.render),
    planLocaleVariants(ctx, input.locales ?? { locales: [] }),
    planFaultVariants(ctx, input.faults ?? { requests: [] }),
    planDataVariants(ctx, input.data ?? { profiles: [] }),
  ];

  const caps = plans.flatMap((plan) => plan.caps);
  const all = plans.flatMap((plan) => plan.variants);

  /*
   * The policy's own page budget binds the variant pass too. A customer who
   * capped a crawl at 50 pages did not agree to 400 more visits because they
   * are on a different axis, and a ceiling taken from somewhere the customer
   * cannot see is the cap-without-disclosure defect by another route.
   */
  const ceiling = Math.min(ctx.budget.totalVisits, ctx.policy.pageBudget);
  const ceilingIsPolicy = ctx.policy.pageBudget < ctx.budget.totalVisits;

  /*
   * Held-out variants are kept whatever the ceiling: they cost no visit, and
   * dropping them would delete the only record that a surface exists and
   * cannot be driven here.
   */
  const held = all.filter((variant) => variant.exercise !== null);
  const runnableAll = all.filter((variant) => variant.exercise === null);
  const runnable = runnableAll.slice(0, Math.max(0, ceiling));
  const dropped = runnableAll.length - runnable.length;
  if (dropped > 0) {
    caps.push(
      capBite(
        VARIANT_BUDGET_CAP,
        ceiling,
        1,
        dropped,
        'all variant axes',
        `${runnable.length} of ${runnableAll.length} runnable variant(s) fit the ${ceiling}-visit ceiling` +
          (ceilingIsPolicy ? " — the limit is the crawl policy's own pageBudget" : '') +
          `; at least ${dropped} more variants existed and were not enumerated`,
      ),
    );
  }

  const kept = [...runnable, ...held];
  const keptIds = new Set(kept.map((variant) => variant.id));
  const emptyAxes = plans
    .filter((plan) => !plan.variants.some((variant) => keptIds.has(variant.id)))
    .map((plan) => ({
      axis: plan.axis,
      why: plan.rule,
    }));

  return {
    plans,
    variants: kept,
    refusedBases: plans.flatMap((plan) => plan.refusedBases),
    caps,
    runnable: runnable.length,
    heldOut: held.length,
    estimatedMillis: runnable.reduce((running, variant) => running + variant.estimatedMillis, 0),
    atLeastMoreVariants: caps.reduce((running, cap) => running + cap.discarded, 0),
    emptyAxes,
    rule:
      `${kept.length} variant(s) across ${plans.length} axes: ${runnable.length} runnable, ` +
      `${held.length} named and held out. This is a SAMPLE and never a cross product — ` +
      `at least ${caps.reduce((running, cap) => running + cap.discarded, 0)} more variants ` +
      `existed and are counted in \`caps\`.`,
  };
}

// ─── The state signature ─────────────────────────────────────────────────────

/**
 * What a variant pass reads off a page. The input to the signature.
 *
 * Every field that can be absent is NULLABLE rather than defaulted, and the
 * signature prints `?` for a null. That is the whole point of this shape: a
 * row count of 0 means "we counted and there are none", a row count of null
 * means "nobody counted", and a signature that rendered both as `rows=0` would
 * report an injected 500 as identical to a working page whenever the pass
 * failed to count rows.
 */
export interface VariantPageFacts {
  title: string | null;
  headings: readonly string[];
  /** Affordance labels, as the crawl records them. */
  controls: readonly string[];
  /** In-app routes linked from the page, normalised. */
  routes: readonly string[];
  /** Node identities (`route#stateKey`) reached from here. For the DATA axis. */
  nodes?: readonly string[];
  /** Table or list rows. NULL = not counted. */
  rowCount: number | null;
  /** Text of alert/error regions — how an error state enters the signature. */
  alerts: readonly string[];
  /** HTTP status of the navigation. NULL = not recorded. */
  status: number | null;
  /** Whether a busy/loading indicator was present. NULL = not looked for. */
  busy: boolean | null;
}

/**
 * A small, stable, deterministic digest. FNV-1a, in 32 bits.
 *
 * Not a cryptographic hash and it does not need to be: nothing here is a
 * secret, the only requirement is that the same page gives the same string on
 * every machine and every version, so that a signature stored last week is
 * comparable to one computed now. A separator byte goes between parts so that
 * ['ab','c'] and ['a','bc'] cannot collide — two different pages with the same
 * signature would be reported as "no distinct state", which is the answer this
 * function exists to be careful about.
 */
function digest(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The signature that proves the UI actually changed.
 *
 * STRUCTURAL, and deliberately so: headings, control labels, link targets, row
 * presence, alert text, status and busy state. It cannot see a colour, a font
 * or a margin — which is why {@link RENDER_ENVIRONMENTS} marks the axes where
 * that is the only possible difference as VISUAL_ONLY instead of pretending a
 * structural comparison answers them.
 *
 * Controls, routes and headings are SORTED before hashing. A control moving
 * from the top of the page to a hamburger menu is not new surface, and a
 * signature that changed when the ORDER changed would report every responsive
 * reflow as a distinct state — which would fill the report with findings that
 * are all the same finding.
 *
 * Rows are reduced to none/some rather than counted. "17 orders" and
 * "18 orders" are the same state; "0 orders" and "some orders" are not.
 */
export function variantSignature(facts: VariantPageFacts): string {
  const sorted = (values: readonly string[]): string[] => [...values].sort();
  return [
    `t=${digest([facts.title ?? '\u0000null'])}`,
    `h=${facts.headings.length}:${digest(sorted(facts.headings))}`,
    `c=${facts.controls.length}:${digest(sorted(facts.controls))}`,
    `r=${facts.routes.length}:${digest(sorted(facts.routes))}`,
    // `?` and never 0 — see the note on VariantPageFacts.
    `rows=${facts.rowCount === null ? '?' : facts.rowCount > 0 ? 'some' : 'none'}`,
    `a=${facts.alerts.length}:${digest(sorted(facts.alerts))}`,
    `s=${facts.status === null ? '?' : facts.status}`,
    `busy=${facts.busy === null ? '?' : facts.busy ? 'y' : 'n'}`,
  ].join('|');
}

/** Null in, null out: there is no signature of a page nobody read. */
export function variantSignatureOf(facts: VariantPageFacts | null | undefined): string | null {
  return facts === null || facts === undefined ? null : variantSignature(facts);
}

/**
 * The comparison, with three answers and not two.
 *
 * A boolean would collapse UNMEASURED into IDENTICAL, and that single collapse
 * is how an injected 500 that nobody observed comes to be reported as a page
 * that handled it identically — a measurement we never took, printed as a
 * result.
 */
export const SIGNATURE_VERDICTS = ['DISTINCT', 'IDENTICAL', 'UNMEASURED'] as const;
export type SignatureVerdict = (typeof SIGNATURE_VERDICTS)[number];

export function compareSignatures(
  baseline: string | null | undefined,
  observed: string | null | undefined,
): SignatureVerdict {
  if (baseline === null || baseline === undefined || observed === null || observed === undefined) {
    return 'UNMEASURED';
  }
  return baseline === observed ? 'IDENTICAL' : 'DISTINCT';
}

// ─── Attribution ─────────────────────────────────────────────────────────────

/**
 * What became of one planned variant.
 *
 * Five outcomes and each lands in its own bucket of {@link VariantAttribution}.
 * NOT_RUN is the one a naive implementation leaves out, and it is the most
 * dangerous: a plan of 400 variants of which 12 ran and 388 were never
 * attempted must not read as 12 differences found.
 */
export const VARIANT_OUTCOMES = [
  'OBSERVED',
  'UNAVAILABLE',
  'REFUSED',
  'FAILED',
  'NOT_RUN',
] as const;
export type VariantOutcome = (typeof VARIANT_OUTCOMES)[number];

const VARIANT_OUTCOME_PRESENT: Record<VariantOutcome, true> = {
  OBSERVED: true,
  UNAVAILABLE: true,
  REFUSED: true,
  FAILED: true,
  NOT_RUN: true,
};

export const VARIANT_OUTCOME_KINDS = Object.keys(
  VARIANT_OUTCOME_PRESENT,
) as readonly VariantOutcome[];

/** One variant, as the pass reports it back. */
export interface VariantObservation {
  variantId: string;
  outcome: VariantOutcome;
  /** Null unless the outcome is OBSERVED and the pass captured the page. */
  facts: VariantPageFacts | null;
  /** The sentence the report prints. Never defaulted to ''. */
  detail: string;
}

/** What kind of thing a finding is about. */
export const VARIANT_FINDING_KINDS = ['CONTROL', 'ROUTE', 'NODE', 'STATE'] as const;
export type VariantFindingKind = (typeof VARIANT_FINDING_KINDS)[number];

export interface VariantFinding {
  kind: VariantFindingKind;
  axis: VariantAxis;
  /** The route template. */
  base: string;
  /** The control label, route, node identity, or the variant's state name. */
  identity: string;
  /** The `CoverageItem.key` this finding would mint. */
  surfaceKey: string;
  surfaceKind: SurfaceKind;
  coordinates: DimensionCoordinate[];
  /** Variant ids it was seen in. `BASELINE` is not a variant id and is not here. */
  presentIn: string[];
  /** Variant ids that were OBSERVED and did not have it. */
  absentIn: string[];
  why: string;
}

/** A variant that ran and looked exactly like the baseline. */
export interface NoDistinctState {
  variantId: string;
  axis: VariantAxis;
  base: string;
  /** VISUAL_ONLY axes get a different sentence; see RENDER_ENVIRONMENTS. */
  why: string;
}

export interface VariantAttribution {
  /**
   * New surface: a control, route, node or state the variant has and the
   * baseline does not, filtered by {@link VARIANT_AXIS_SURFACE_RULE}.
   */
  newSurface: VariantFinding[];
  /**
   * Controls the baseline has and the variant does not. A FINDING — a desktop
   * action with no mobile equivalent is a real problem — but not new surface:
   * the inventory already names it.
   */
  hiddenByVariant: VariantFinding[];
  /**
   * Observed, structurally identical to the baseline. Never counted as covered
   * surface. On the fault axis this is itself the finding: a screen that
   * renders identically under an injected 500 has no error state.
   */
  noDistinctState: NoDistinctState[];
  /**
   * Observed, structurally different, and on an axis where a mere difference
   * is not new surface (DEVICE, LOCALE). Reported so the difference is
   * visible, counted nowhere.
   */
  differsWithoutNewSurface: NoDistinctState[];
  /** Planned and never attempted. NOT a measurement of anything. */
  unmeasured: Array<{ variantId: string; axis: VariantAxis; base: string; why: string }>;
  /** The harness could not produce the variant. Our limit, named. */
  unavailable: Array<{ variantId: string; axis: VariantAxis; base: string; why: string }>;
  /** Policy refused it. We did not look. Nothing is claimed either way. */
  refused: Array<{ variantId: string; axis: VariantAxis; base: string; why: string }>;
  /** It was attempted and broke. Unknown, not absent. */
  failed: Array<{ variantId: string; axis: VariantAxis; base: string; why: string }>;
  /**
   * Observed, but the BASELINE for its base was never measured, so there is
   * nothing to attribute the difference to. A separate list because
   * "different from an unmeasured baseline" is not a difference.
   */
  unattributable: Array<{ variantId: string; axis: VariantAxis; base: string; why: string }>;
  /** An observation whose variant id is in no plan. Our bug, surfaced. */
  unknownVariants: string[];
  rule: string;
}

function emptyAttribution(): VariantAttribution {
  return {
    newSurface: [],
    hiddenByVariant: [],
    noDistinctState: [],
    differsWithoutNewSurface: [],
    unmeasured: [],
    unavailable: [],
    refused: [],
    failed: [],
    unattributable: [],
    unknownVariants: [],
    rule: '',
  };
}

/** The state name a state-axis variant asserts, read back off its id. */
function variantStateName(variant: PlannedVariant): string {
  const hash = variant.id.indexOf('#');
  return hash < 0 ? variant.id : variant.id.slice(hash + 1);
}

/**
 * Attributes observed variant results to surface, per axis.
 *
 * The one function all five axes share, because "this exists in variants X and
 * Y and not Z" is the same question whatever produced the variant — and
 * because five copies of it would be five chances to disagree about what
 * counts.
 *
 * The baseline is a map from route template to the facts the ORDINARY crawl
 * read for it. A base with no baseline entry yields `unattributable` rather
 * than a finding: every control in the variant would otherwise look new.
 */
export function attributeVariants(input: {
  plan: readonly PlannedVariant[];
  baseline: ReadonlyMap<string, VariantPageFacts | null>;
  observations: readonly VariantObservation[];
}): VariantAttribution {
  const attribution = emptyAttribution();
  const byId = new Map(input.plan.map((variant) => [variant.id, variant]));
  const observed = new Map(input.observations.map((entry) => [entry.variantId, entry]));

  for (const entry of input.observations) {
    if (!byId.has(entry.variantId)) attribution.unknownVariants.push(entry.variantId);
  }

  for (const variant of input.plan) {
    const where = { variantId: variant.id, axis: variant.axis, base: variant.base };
    const observation = observed.get(variant.id);

    /*
     * A variant held out at plan time is reported from the PLAN and never
     * waits for an observation: the exercise record already says which of the
     * two reasons it is, and the two must not merge. REFUSED means policy said
     * no; UNEXERCISABLE means our harness cannot.
     */
    if (variant.exercise !== null) {
      const detail = variant.exercise.detail;
      if (variant.exercise.state === 'REFUSED') {
        attribution.refused.push({
          ...where,
          why: `${variant.exercise.rule ?? 'refused with no rule recorded'} — ${detail}`,
        });
      } else {
        attribution.unavailable.push({
          ...where,
          why: `${variant.exercise.reason ?? 'unclassified'} — ${detail}`,
        });
      }
      continue;
    }

    if (observation === undefined || observation.outcome === 'NOT_RUN') {
      attribution.unmeasured.push({
        ...where,
        why:
          observation?.detail ??
          'planned and never attempted — this is not evidence that the variant looks like the baseline',
      });
      continue;
    }
    if (observation.outcome === 'UNAVAILABLE') {
      attribution.unavailable.push({ ...where, why: observation.detail });
      continue;
    }
    if (observation.outcome === 'REFUSED') {
      attribution.refused.push({ ...where, why: observation.detail });
      continue;
    }
    if (observation.outcome === 'FAILED') {
      attribution.failed.push({ ...where, why: observation.detail });
      continue;
    }
    if (observation.facts === null) {
      attribution.unmeasured.push({
        ...where,
        why: `reported OBSERVED with no captured page facts: ${observation.detail}`,
      });
      continue;
    }

    const baselineFacts = input.baseline.get(variant.base) ?? null;
    if (baselineFacts === null) {
      attribution.unattributable.push({
        ...where,
        why: `the baseline crawl recorded nothing for ${variant.base}, so a difference here cannot be attributed to the variant`,
      });
      continue;
    }

    const rule = VARIANT_AXIS_SURFACE_RULE[variant.axis];
    const verdict = compareSignatures(
      variantSignature(baselineFacts),
      variantSignature(observation.facts),
    );

    const added = {
      CONTROL: observation.facts.controls.filter(
        (control) => !baselineFacts.controls.includes(control),
      ),
      ROUTE: observation.facts.routes.filter((route) => !baselineFacts.routes.includes(route)),
      NODE: (observation.facts.nodes ?? []).filter(
        (node) => !(baselineFacts.nodes ?? []).includes(node),
      ),
    };

    if (rule.controlIsSurface) {
      for (const kind of ['CONTROL', 'ROUTE', 'NODE'] as const) {
        for (const identity of added[kind]) {
          attribution.newSurface.push(
            finding(
              variant,
              kind,
              identity,
              `${identity} exists in this variant and not in the baseline: ${rule.why}`,
            ),
          );
        }
      }
    }

    for (const control of baselineFacts.controls) {
      if (!observation.facts.controls.includes(control)) {
        attribution.hiddenByVariant.push(
          finding(
            variant,
            'CONTROL',
            control,
            `${control} exists in the baseline and NOT in this variant — already in the inventory, so it is a finding and not new surface`,
          ),
        );
      }
    }

    const addedAnything =
      added.CONTROL.length > 0 || added.ROUTE.length > 0 || added.NODE.length > 0;

    if (verdict === 'IDENTICAL') {
      attribution.noDistinctState.push({
        ...where,
        why: noDistinctStateReason(variant),
      });
      continue;
    }
    if (rule.stateIsSurface) {
      attribution.newSurface.push(
        finding(
          variant,
          'STATE',
          variantStateName(variant),
          `the page is structurally different in this variant: ${rule.why}`,
        ),
      );
    } else if (!addedAnything) {
      attribution.differsWithoutNewSurface.push({
        ...where,
        why: `the page differs in this variant but adds no control, route or node, and on the ${variant.axis} axis a difference alone is not surface: ${rule.why}`,
      });
    }
  }

  attribution.rule =
    `${attribution.newSurface.length} new surface item(s); ` +
    `${attribution.noDistinctState.length} variant(s) rendered with no distinct state and are counted as NOTHING, ` +
    `not as covered; ${attribution.unmeasured.length} planned and never run; ` +
    `${attribution.unavailable.length} the harness cannot produce; ` +
    `${attribution.refused.length} refused by policy; ${attribution.failed.length} attempted and broken; ` +
    `${attribution.unattributable.length} with no measured baseline. Those six are separate ` +
    `counts because a refused surface, an unmeasured surface and a surface that does not ` +
    `exist are different facts.`;

  return attribution;
}

function finding(
  variant: PlannedVariant,
  kind: VariantFindingKind,
  identity: string,
  why: string,
): VariantFinding {
  return {
    kind,
    axis: variant.axis,
    base: variant.base,
    identity,
    /*
     * A CONTROL, ROUTE or NODE found in a variant gets its own key under the
     * variant's cell identity, because the thing that is new is "this control,
     * in this variant" — the same control in another variant is the same
     * surface and must land on the same key.
     */
    surfaceKey: kind === 'STATE' ? variant.surfaceKey : `${variant.surfaceKey}@${kind}:${identity}`,
    surfaceKind: variant.surfaceKind,
    coordinates: variant.coordinates,
    presentIn: [variant.id],
    absentIn: [],
    why,
  };
}

/**
 * The sentence for a variant that rendered identically — and it differs by
 * axis, which is the point.
 *
 * On a VISUAL_ONLY render axis an identical structure is EXPECTED and says
 * nothing about whether dark mode works. On the fault axis it is the finding
 * itself: a screen that looks the same under an injected 500 has no error
 * state at all, which is a defect a customer can act on today.
 */
function noDistinctStateReason(variant: PlannedVariant): string {
  if (variant.axis === 'FAULT' && variant.setup.kind === 'FAULT') {
    return (
      `the page rendered identically with ${variant.setup.match.method} ` +
      `${variant.setup.match.pathGlob} in its ${variant.setup.state} state: NO DISTINCT STATE. ` +
      `Either the UI silently swallows the failure or it has no error state — either way this ` +
      `is a finding and not covered surface.`
    );
  }
  if (variant.axis === 'RENDER') {
    const kind =
      variantStateName(variant)
        .replace(/^render=/, '')
        .split(':')[0] ?? '';
    const environment = RENDER_ENVIRONMENTS[kind as RenderAxisKind];
    if (environment !== undefined && environment.differenceKind === 'VISUAL_ONLY') {
      return (
        `no STRUCTURAL difference under ${environment.label}. This axis changes pixels, which a ` +
        `structural signature cannot see, so this is NOT a statement that ${environment.label} ` +
        `works — a visual check owns that question and this is not one.`
      );
    }
  }
  return `the page rendered identically in this variant: no distinct state, so no surface is claimed`;
}

/**
 * The attribution expressed in the surface registry's own type.
 *
 * This is the step that makes the slice reach the denominator: a finding nobody
 * turns into a `SurfaceItem` is a finding nothing counts. Only `newSurface`
 * becomes items — a no-distinct-state result, an unmeasured variant and a
 * refused one mint nothing, by design — and `origin` is DERIVED with
 * `originFromSources` rather than set, so the two provenance fields cannot
 * come to disagree.
 */
export function variantSurfaceItems(
  attribution: VariantAttribution,
  input: { environmentId: string | null; detector?: string },
): SurfaceItem[] {
  const sources: SurfaceSource[] = ['CRAWL'];
  const origin = originFromSources(sources);
  return attribution.newSurface.map((entry) => ({
    kind: entry.surfaceKind,
    key: entry.surfaceKey,
    label: `${entry.base} — ${entry.identity}`,
    file: null,
    line: null,
    // `originFromSources` returns null only for an empty set, which this is
    // not; the fallback keeps the type honest without inventing a value.
    origin: origin ?? 'CRAWL_ONLY',
    evidence: entry.why,
    detector: input.detector ?? 'crawl/variants',
    sources,
    /*
     * Observed in a real browser under a real variant, so EXERCISABLE. A
     * variant that could not be driven never reaches `newSurface` — it is in
     * `unavailable` or `refused` with its own record.
     */
    exercise: {
      state: 'EXERCISABLE',
      reason: null,
      rule: null,
      detail: `observed under the ${entry.axis} variant ${entry.presentIn.join(', ')}`,
    },
    environmentId: input.environmentId,
    ...(entry.coordinates.length > 0 ? { coordinates: entry.coordinates } : {}),
    meta: { axis: entry.axis, findingKind: entry.kind, presentIn: entry.presentIn },
  }));
}
