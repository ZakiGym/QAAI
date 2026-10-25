/**
 * Mobile screen enumeration — the denominator for "every device".
 *
 * THE DEFECT THIS FIXES, stated as the arithmetic it breaks. A MOBILE plugin
 * exists (`packages/runner/src/plugins/mobile.ts`, five drivers, 1963 lines) and
 * it EXECUTES mobile tests. Nothing in this repository enumerates a mobile
 * screen. So QAAI can run a test against a surface it cannot count, and mobile
 * coverage is not 0% — it has no denominator at all. "Your app has 412 routes,
 * 25 are covered, here are the 387" is the whole company, and today that
 * sentence is silent about every screen of the native app the same customer
 * ships.
 *
 * WHY THIS IS A FlowMap AND NOT A SECOND UNIVERSE. A mobile graph of its own
 * would produce a second coverage number computed a second way, and the first
 * question anybody asks of two numbers is which one is wrong. So a screen is a
 * {@link FlowNode}, a transition is a {@link FlowEdge}, the caps are
 * {@link CapBite}s, the known-unknowns are a {@link Frontier}, and termination
 * is {@link enumerationOutcome} — the same five shapes the URL crawl and the
 * interaction crawl already write. `mobileScreenSurfaceItems` and
 * `mobileReconcileSource` are the two doors into the ONE reconciled surface in
 * `surface-inventory.ts`.
 *
 * Mobile screen identities live under the reserved route prefix
 * {@link MOBILE_ROUTE_PREFIX}, so a reader can separate the native axis from
 * the web one without a second table — see {@link isMobileScreenRoute}. That
 * prefix is a stopgap and is labelled as one: the honest home for a screen is a
 * `MOBILE_SCREEN` member of `SURFACE_KINDS` with its own matcher, which lives
 * in files this module does not own. The prefix keeps the number auditable in
 * the meantime; it does not pretend to be the right answer.
 *
 * WHY EVERY DEVICE CAPABILITY IS INJECTED. There is no emulator, no phone and
 * no device farm in a unit test, and a module that can only be exercised with
 * one is a module nobody exercises. So this file splits the way `crawl/interact
 * .ts` splits:
 *
 *   • the decisions — is this the same screen, what kind of control is that,
 *     may we tap it, has the scroll container ended, did a budget bite, did
 *     enumeration converge — are pure functions over plain data;
 *   • the device is a {@link MobileDevice}: nine methods that read one fact or
 *     perform one action each. Its one adapter, {@link appiumMobileDevice},
 *     makes no decisions, and even its hardest part —
 *     {@link parseViewHierarchy} — is pure, so a RECORDED hierarchy is a
 *     complete test fixture.
 *
 * NO MODEL IS INVOLVED, deliberately. Deciding what EXISTS is a graph
 * traversal; doing it in code makes it cheap, repeatable and diffable version
 * to version, which is the same reason `crawler.ts` gives.
 *
 * THE HONESTY RULES THIS FILE IS UNDER.
 *   · When there is no device, the answer is UNAVAILABLE with a remedy, and
 *     the UNAVAILABLE result HAS NO `screens` FIELD — see
 *     {@link MobileEnumerationResult}. An empty graph reads as "this app has no
 *     mobile screens", which is the most expensive sentence this file could
 *     accidentally say.
 *   · Every budget that bit is a count AND a reason, because a truncated
 *     enumeration makes the coverage percentage go UP.
 *   · A control we refused to tap is recorded as a refusal with the rule that
 *     refused it. A refused surface and a surface that does not exist are
 *     opposite facts.
 *   · Identity that could only be computed STRUCTURALLY is counted and named,
 *     because a structurally-identified screen may split in two on a tablet and
 *     a report that cannot say so is overcounting without knowing it.
 *   · "Converged" is claimed only when the frontier is empty and nothing bit.
 */

import { createHash } from 'node:crypto';
import {
  enumerationOutcome,
  lowerBoundMoreUrls,
  surfaceKey,
  type CapBite,
  type CrawlCap,
  type CrawlPolicy,
  type EnumerationOutcome,
  type FlowEdge,
  type FlowNode,
  type FormFieldSemantic,
  type Frontier,
  type MobilePlatform,
  type MobileSelector,
  type SurfaceExercise,
  type SurfaceItem,
  type SurfaceSource,
} from '@qaai/shared';
/*
 * FOUR FUNCTIONS, IMPORTED RATHER THAN RE-IMPLEMENTED, and each one is a fork
 * this module is not allowed to make:
 *
 *   controlIdentity        — `route::landmark::role::label::nth`. A second
 *                            identity scheme for native controls means a
 *                            control covered on one screen reads as covered on
 *                            five, which is the "Save" defect interact.ts
 *                            documents, re-introduced on a new axis.
 *   normaliseStructureName — the volatile-text rules ("2 minutes ago", "12
 *                            results", an ISO date). A list screen whose rows
 *                            carry timestamps mints a new state on every read
 *                            without them, and two copies of these rules
 *                            diverge on the first bug fix.
 *   refusalFor             — the session-ending / destructive / real-world
 *                            vocabulary AND the `allowDestructive` +
 *                            `destructiveAllowGlobs` two-field opt-in. A
 *                            second copy of the destructive regex is two
 *                            policies that disagree about "Delete account",
 *                            and only one of them is on screen.
 *   affordanceKindFor      — the link/button/input vocabulary `FlowNode`
 *                            already stores.
 */
import {
  affordanceKindFor,
  controlIdentity,
  normaliseStructureName,
  refusalFor,
  type InteractionKind,
} from './crawl/interact.js';
/*
 * TYPE-ONLY, and from `reconcile.ts` rather than from `@qaai/shared`, because
 * that is where the reconciliation vocabulary lives. `mobileReconcileSource`
 * below returns the shape `reconcileSurface` consumes, so the mobile axis joins
 * the ONE reconciled surface instead of growing a second one. No value is
 * imported, so this adds no edge to the module graph reconcile.ts already has.
 */
import type { ReconcileEntry, ReconcileSourceInput } from './reconcile.js';

// ─── The injected device surface ─────────────────────────────────────────────

/**
 * The device capabilities this module needs, NAMED so a missing one can be
 * reported instead of silently producing a smaller measurement.
 *
 * The first three are required: without them nothing is enumerable and the
 * answer is UNAVAILABLE, not an app with no screens. The rest degrade, and
 * every degradation has a `cost` sentence in {@link MOBILE_CAPABILITY_COST}
 * phrased as an UNKNOWN rather than a zero.
 */
export const MOBILE_ENUMERATION_CAPABILITIES = [
  /** Dump the view hierarchy. Required — it is the whole measurement. */
  'HIERARCHY',
  /** Tap an element the last hierarchy read named. Required to traverse. */
  'TAP',
  /**
   * Start or re-foreground the app under test. Required, because REPLAY is the
   * reversal strategy and `launch` is every replay path's first step.
   */
  'LAUNCH',
  /**
   * The foreground activity and package. Without it a screen has no ANCHOR and
   * identity falls back to STRUCTURAL — see {@link MOBILE_IDENTITY_BASES}.
   */
  'CURRENT_SCREEN',
  /**
   * Swipe. Without it the half of a scroll container below the fold is never
   * read, and the controls down there are UNKNOWN rather than absent.
   */
  'SWIPE',
  /**
   * The platform back gesture / hardware back button. Without it the back
   * edges of the graph are UNKNOWN — never reported as "this screen has no way
   * back", which is the opposite fact.
   */
  'BACK',
  /**
   * Rotate the device. Without it the orientation-invariance of screen
   * identity is UNPROVEN here, and {@link OrientationProbe.stable} is NULL.
   */
  'ORIENTATION',
  /**
   * Dismiss the soft keyboard. Without it a screen whose IME is up occludes
   * its own controls and this module refuses to drive its fields rather than
   * tapping blind.
   */
  'HIDE_KEYBOARD',
  /**
   * The device descriptor: platform version, size in dp, emulator or not.
   * Without it a screen cannot be attributed to a form factor and the
   * phone-versus-tablet claim is unmade rather than assumed.
   */
  'DEVICE_INFO',
] as const;
export type MobileEnumerationCapability = (typeof MOBILE_ENUMERATION_CAPABILITIES)[number];

/** Capabilities without which there is no measurement at all. */
export const REQUIRED_MOBILE_CAPABILITIES: readonly MobileEnumerationCapability[] = [
  'HIERARCHY',
  'TAP',
  'LAUNCH',
];

/**
 * What each absent capability costs, as a sentence a report prints.
 *
 * A compiler-enforced `Record`, so a new capability cannot be added without
 * deciding what its absence makes UNKNOWN. Every sentence names an unknown;
 * none of them names a zero.
 */
export const MOBILE_CAPABILITY_COST: Record<MobileEnumerationCapability, string> = {
  HIERARCHY: 'no screen can be read, so no mobile surface can be enumerated at all',
  TAP: 'no transition can be driven, so every screen past the entry screen is UNKNOWN',
  LAUNCH: 'the app cannot be re-foregrounded, so no state can be returned to and replayed',
  CURRENT_SCREEN:
    'screens have no anchor, so identity is STRUCTURAL: one screen laid out two ways may be counted twice',
  SWIPE:
    'scroll containers are read only as far as the first hierarchy dump, so the controls below the fold are UNKNOWN',
  BACK: 'the graph has no back edges; whether each screen has a way back is UNKNOWN, not "none"',
  ORIENTATION:
    'orientation-invariance of screen identity is UNPROVEN in this run, so stable is NULL rather than true',
  HIDE_KEYBOARD:
    'a screen whose keyboard is up keeps it up, so its fields are held out as UNEXERCISABLE rather than tapped blind',
  DEVICE_INFO: 'the form factor is UNKNOWN, so screens cannot be attributed to a phone or a tablet',
};

/** A capability the device did not offer, and what its absence cost. */
export interface MobileCapabilityGap {
  capability: MobileEnumerationCapability;
  /** What is UNKNOWN as a result. Never phrased as a zero. */
  cost: string;
}

/** Portrait or landscape. The only two this module needs to distinguish. */
export const MOBILE_ORIENTATIONS = ['PORTRAIT', 'LANDSCAPE'] as const;
export type MobileOrientation = (typeof MOBILE_ORIENTATIONS)[number];

/**
 * The direction the FINGER moves, not the direction the content moves.
 *
 * Named this way because the two are opposite and a crawl that got it backwards
 * would scroll a list to its top forever and report convergence. A swipe UP
 * reveals what is BELOW the fold.
 */
export const MOBILE_SWIPE_DIRECTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT'] as const;
export type MobileSwipeDirection = (typeof MOBILE_SWIPE_DIRECTIONS)[number];

/**
 * Form factor, from the device's shortest side in dp.
 *
 * UNKNOWN is a real member and is what a device reports when `DEVICE_INFO` is
 * absent. Defaulting it to PHONE would attribute a tablet-only two-pane screen
 * to a phone, which is the claim this axis exists to make correctly.
 */
export const MOBILE_FORM_FACTORS = ['PHONE', 'TABLET', 'UNKNOWN'] as const;
export type MobileFormFactor = (typeof MOBILE_FORM_FACTORS)[number];

/** The dp threshold Android's own `sw600dp` qualifier uses for a tablet. */
export const TABLET_SHORTEST_SIDE_DP = 600;

/**
 * The form factor, from a measurement.
 *
 * Returns UNKNOWN for a missing dimension rather than guessing from the
 * platform — an iPad and an iPhone are both IOS, and "IOS means phone" is how a
 * tablet layout comes to be filed as a phone screen.
 */
export function formFactorOf(input: {
  widthDp: number | null;
  heightDp: number | null;
}): MobileFormFactor {
  const { widthDp, heightDp } = input;
  if (widthDp === null || heightDp === null) return 'UNKNOWN';
  if (!Number.isFinite(widthDp) || !Number.isFinite(heightDp)) return 'UNKNOWN';
  if (widthDp <= 0 || heightDp <= 0) return 'UNKNOWN';
  return Math.min(widthDp, heightDp) >= TABLET_SHORTEST_SIDE_DP ? 'TABLET' : 'PHONE';
}

/** A device or emulator the harness can drive. */
export interface MobileDeviceDescriptor {
  /** udid / emulator serial / farm session name. */
  id: string;
  platform: MobilePlatform;
  /** Null when `DEVICE_INFO` is absent. Never defaulted to a version string. */
  platformVersion: string | null;
  formFactor: MobileFormFactor;
  /** dp, so {@link formFactorOf} is a measurement. Null without `DEVICE_INFO`. */
  widthDp: number | null;
  heightDp: number | null;
  /** Null when `DEVICE_INFO` is absent: "we do not know" is not "a real phone". */
  emulator: boolean | null;
}

/**
 * One view-hierarchy element as the adapter read it. RAW FACTS ONLY — every
 * classification, score and refusal in this file is a pure function over this
 * shape, which is the whole reason the shape exists.
 */
export interface RawViewNode {
  /**
   * Names the element back to the device for a tap or a type. Stable only
   * within ONE hierarchy read: a transition invalidates it. Identity across
   * reads is {@link controlIdentity}, never this.
   */
  ref: string;
  /** `android.widget.Button`, `XCUIElementTypeButton`. The platform's own class. */
  className: string;
  /** `resource-id` / iOS `identifier`. The one genuinely device-invariant id. */
  resourceId: string | null;
  /** `content-desc` / iOS `name`. The locator a redesign survives. */
  accessibilityId: string | null;
  /** Visible text / iOS `label`. DATA, and therefore normalised out of identity. */
  text: string | null;
  /** iOS `value`, a switch's on/off, a field's current contents. */
  value: string | null;
  /** Placeholder / hint text. */
  hint: string | null;
  enabled: boolean;
  displayed: boolean;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  focused: boolean;
  checkable: boolean;
  checked: boolean;
  /** A selected tab or segment. Part of the screen's variant markers. */
  selected: boolean;
  /** A secure text entry. This module never reads or records its value. */
  password: boolean;
  /** Position among its siblings, 0-based. */
  index: number;
  depth: number;
  /**
   * Geometry. CAPTURED AND DELIBERATELY EXCLUDED FROM IDENTITY — see
   * {@link screenSignatureOf}. It is here because a zero-area element is not
   * on screen and because a report wants to say where a control was; it is
   * excluded from identity because it is exactly what differs between a phone
   * and a tablet, and between portrait and landscape.
   */
  bounds: { x: number; y: number; width: number; height: number } | null;
  /**
   * The enclosing structural container: `navbar`, `tabbar`, `list`, `scroll`,
   * `dialog`, or null when there is none. The native analogue of a landmark,
   * and the third part of {@link controlIdentity} — the same label in a nav bar
   * and in a list row are two controls with two behaviours.
   */
  container: string | null;
}

/** Everything one hierarchy read tells us. */
export interface RawScreen {
  /**
   * Android's foreground activity (`.CheckoutActivity`). Null on iOS and null
   * without `CURRENT_SCREEN`; null is why {@link MOBILE_IDENTITY_BASES} has a
   * STRUCTURAL member.
   */
  activity: string | null;
  /** The foreground package / bundle id. Null without `CURRENT_SCREEN`. */
  packageName: string | null;
  /** The navigation-bar title the hierarchy declares, when it declares one. */
  title: string | null;
  nodes: RawViewNode[];
  /**
   * True when the soft keyboard is up. NOT a screen: an IME occludes the
   * screen underneath, and minting a node for it would double every form.
   */
  keyboardShown: boolean;
  /** An open alert's or sheet's text, or null. Named, not hashed. */
  alertText: string | null;
  /** Null when `ORIENTATION` is absent. Never defaulted to PORTRAIT. */
  orientation: MobileOrientation | null;
  /**
   * Whatever the adapter could not make sense of, verbatim-free. A hierarchy
   * that half-parsed is a smaller measurement and has to say so.
   */
  warnings: string[];
}

/** The result of one device action. `ok: false` is a fact, never an exception. */
export interface MobileActionOutcome {
  ok: boolean;
  /** A short sentence. Never a credential, never a field value. */
  error: string | null;
}

/**
 * Which mechanism went back.
 *
 * Recorded because they are not the same edge. The hardware button is Android's
 * and is delivered to the app, which may handle it; the edge gesture is the
 * platform's and may pop a navigation controller the app never hears about; a
 * nav-bar chevron is the APP'S OWN control and is already a tappable
 * affordance. Collapsing them would make "this screen has a way back" a claim
 * about three different things.
 */
export const MOBILE_BACK_MECHANISMS = [
  'HARDWARE_BUTTON',
  'EDGE_GESTURE',
  'NAV_BAR_CONTROL',
] as const;
export type MobileBackMechanism = (typeof MOBILE_BACK_MECHANISMS)[number];

export interface MobileBackOutcome extends MobileActionOutcome {
  /** Null when the device could not say which mechanism it used. */
  mechanism: MobileBackMechanism | null;
}

/**
 * The device, as nine methods. Narrow enough to fake in a test, which is the
 * point: the fake in `mobile-crawler.test.ts` is a screen graph in a literal
 * and the adapter's hardest part takes a recorded XML string.
 */
export interface MobileDevice {
  capabilities(): readonly MobileEnumerationCapability[];
  /**
   * The attached devices and emulators.
   *
   * AN EMPTY ARRAY IS THE UNAVAILABLE ANSWER and the single most important
   * contract in this file: it means "we could not look", not "the app has no
   * screens". {@link enumerateMobileScreens} turns it into a
   * {@link MobileEnumerationUnavailable}, which has no `screens` field for a
   * reader to misread.
   */
  devices(): Promise<MobileDeviceDescriptor[]>;
  /** Start, or re-foreground, the app under test. Every replay path's step 1. */
  launch(): Promise<MobileActionOutcome>;
  screen(): Promise<RawScreen>;
  tap(ref: string): Promise<MobileActionOutcome>;
  type(ref: string, value: string): Promise<MobileActionOutcome>;
  /** Swipe inside `ref`'s container, or over the whole screen when it is null. */
  swipe(input: {
    ref: string | null;
    direction: MobileSwipeDirection;
  }): Promise<MobileActionOutcome>;
  back(): Promise<MobileBackOutcome>;
  hideKeyboard(): Promise<MobileActionOutcome>;
  rotate(orientation: MobileOrientation): Promise<MobileActionOutcome>;
}

/**
 * The one pure function this module needs from `crawler.ts`, INJECTED rather
 * than imported.
 *
 * REQUIRED, not optional, so a missing wire is a compile error. Copying
 * `semanticFor` would be the fork that matters most on this axis: a field the
 * mobile crawl classified `freeform` and the web crawl classified `email` is
 * one synthetic-data decision made two ways, and the test that types "lorem
 * ipsum" into an email field is the visible half of it.
 */
export interface MobilePrimitives {
  /** `semanticFor` from crawler.ts. */
  semanticFor: (
    name: string,
    type: string,
    label: string,
    autocomplete?: string | null,
  ) => FormFieldSemantic;
}

// ─── Screen identity: the phone-and-tablet defect ────────────────────────────

/**
 * The reserved route prefix every mobile screen's identity carries.
 *
 * It exists so the native axis is SEPARABLE inside the one reconciled
 * denominator. A mobile screen is not a URL, `SURFACE_KINDS` has no
 * `MOBILE_SCREEN` member, and minting one needs an entry in
 * `MEASURED_SURFACE_KINDS` plus a matcher in the same change (check:wiring
 * section 9 fails on either half alone) — in files this module does not own.
 * Until that lands a mobile screen enters the ROUTE axis under this prefix, and
 * {@link isMobileScreenRoute} is how every reader splits the two apart.
 *
 * It is also what makes `CrawlPolicy.excludeGlobs` and `destructiveAllowGlobs`
 * work on native screens: a customer can write `/mobile/android/**` and mean it.
 */
export const MOBILE_ROUTE_PREFIX = '/mobile';

/** Whether this route identity is a native screen rather than a URL route. */
export function isMobileScreenRoute(route: string): boolean {
  return route === MOBILE_ROUTE_PREFIX || route.startsWith(`${MOBILE_ROUTE_PREFIX}/`);
}

/** The URI scheme a mobile screen's `FlowNode.url` carries. Not an http URL. */
export const MOBILE_URL_SCHEME = 'mobile:';

/**
 * How a screen's identity was established.
 *
 * ANCHORED is the good case and the one that satisfies "the same screen on a
 * phone and a tablet is one node": the anchor is a name the APP declares — an
 * Android activity, a navigation title, a root container's accessibility id —
 * and it does not move when the layout does.
 *
 * STRUCTURAL is the fallback, used when nothing anchors the screen, and it is
 * COUNTED AND REPORTED rather than quietly used. A structural identity is
 * computed from the set of controls, and a tablet's two-pane layout has a
 * different set from a phone's one-pane layout — so a structurally-identified
 * screen can split into two nodes across form factors. That is overcounting,
 * which moves the percentage DOWN; it is still a wrong number, and a report
 * that cannot name which screens are at risk cannot be trusted about either
 * direction.
 */
export const MOBILE_IDENTITY_BASES = ['ANCHORED', 'STRUCTURAL'] as const;
export type MobileIdentityBasis = (typeof MOBILE_IDENTITY_BASES)[number];

export const MOBILE_IDENTITY_BASIS_LABELS: Record<MobileIdentityBasis, string> = {
  ANCHORED: 'identified by a name the app declares, so layout changes do not split it',
  STRUCTURAL:
    'identified by its control set, because the app declares no name — a different layout may be counted as a second screen',
};

/**
 * What the app under test is called, per platform.
 *
 * Both members, because a screen's identity has to survive the app being
 * installed on the other platform: `com.acme.app` on Android and
 * `com.acme.Acme` on iOS are two apps as far as a bundle id is concerned and
 * one application as far as a customer is concerned. The platform is therefore
 * part of the route and the appId is the platform's own spelling, so neither is
 * guessed from the other.
 */
export interface MobileAppIdentity {
  platform: MobilePlatform;
  /** The package name (Android) or bundle id (iOS). */
  appId: string;
}

/**
 * A screen's anchor: the name the application itself gives it.
 *
 * Ranked by how much the APP declares, which is the same ranking
 * `classifyControl` uses for the web:
 *   1. the Android activity — a class name the developer wrote;
 *   2. the navigation-bar title, normalised — the words on the screen's own
 *      header, which is what iOS has instead of an activity;
 *   3. the root container's accessibility id or resource id — set by hand, so
 *      also a declaration;
 * and nothing else. A guess from the first visible label would anchor a list
 * screen on whichever row happened to be first.
 */
export function screenAnchorOf(raw: RawScreen): {
  anchor: string | null;
  basis: MobileIdentityBasis;
  why: string;
} {
  const activity = collapse(raw.activity ?? '');
  if (activity !== '') {
    return {
      anchor: `activity:${activity}`,
      basis: 'ANCHORED',
      why: `the foreground activity is ${activity}`,
    };
  }
  const title = normaliseScreenText(raw.title ?? '');
  if (title !== '') {
    return {
      anchor: `title:${title}`,
      basis: 'ANCHORED',
      why: `the navigation bar declares the title "${title}"`,
    };
  }
  const root = rootDeclaredId(raw.nodes);
  if (root !== null) {
    return {
      anchor: `root:${root}`,
      basis: 'ANCHORED',
      why: `the root container declares the id ${root}`,
    };
  }
  return {
    anchor: null,
    basis: 'STRUCTURAL',
    why: 'the app declares no activity, no title and no root id, so identity is the control set',
  };
}

/** The shallowest node that declares an id of its own. */
function rootDeclaredId(nodes: readonly RawViewNode[]): string | null {
  let best: { depth: number; id: string } | null = null;
  for (const node of nodes) {
    const id = collapse(node.resourceId ?? node.accessibilityId ?? '');
    if (id === '') continue;
    if (best === null || node.depth < best.depth) best = { depth: node.depth, id };
  }
  return best === null ? null : best.id;
}

/**
 * Screen text, normalised for identity.
 *
 * Delegates to `normaliseStructureName`, which already replaces dates, times,
 * "2 minutes ago" and bare numbers — the four things that change on every read
 * of a list screen without the screen changing. A second copy of those rules
 * here would diverge on the first bug fix, and the symptom would be a crawl
 * that mints a new node per refresh and reports hundreds of screens.
 */
export function normaliseScreenText(text: string): string {
  return normaliseStructureName(text);
}

/**
 * The device- and orientation-invariant identity of one element.
 *
 * GEOMETRY IS NOT IN IT, and that is the whole function: `bounds` is what
 * differs between a phone and a tablet and between portrait and landscape, so
 * an identity that included it would make one screen four. Neither is sibling
 * index, which a responsive layout reorders.
 *
 * Ranked by what the APP declares: a resource id, then an accessibility id,
 * then the role plus the normalised text. The last is the weak case and is
 * why {@link MobileControlSighting.selectorConfidence} exists.
 */
export function viewNodeIdentity(node: RawViewNode): string {
  const declared = collapse(node.resourceId ?? '');
  if (declared !== '') return `id:${declared}`;
  const accessibility = collapse(node.accessibilityId ?? '');
  if (accessibility !== '') return `a11y:${accessibility}`;
  const role = canonicalRole(node.className);
  const text = normaliseScreenText(node.text ?? node.value ?? '');
  return `${role}:${text}`;
}

/**
 * The variant markers of a screen: the facts that make two genuinely different
 * states share one anchor.
 *
 * THREE AND ONLY THREE, and each one is a state a test would have to reach
 * separately:
 *   • the selected tab / segment / wizard step — "a tab RE-selected is not a
 *     new node" falls out of this: re-tapping the live tab leaves the marker
 *     set identical, so the signature is identical;
 *   • an open alert or sheet, NAMED rather than hashed so a reader can see it —
 *     a permission dialog over a screen IS a state;
 *   • the keyboard, which is NOT a state. It is recorded here so the traversal
 *     can see it and dismiss it, and `screenSignatureOf` drops it before
 *     hashing, because an IME is an occlusion and a screen with its keyboard up
 *     is the same screen.
 */
export function screenMarkersOf(raw: RawScreen): {
  markers: string[];
  keyboardShown: boolean;
} {
  const markers = new Set<string>();
  for (const node of raw.nodes) {
    if (!node.selected && !(node.checkable && node.checked)) continue;
    const identity = viewNodeIdentity(node);
    markers.add(node.selected ? `selected:${identity}` : `checked:${identity}`);
  }
  if (raw.alertText !== null) {
    markers.add(`alert:${normaliseScreenText(raw.alertText)}`);
  }
  return { markers: [...markers].sort(), keyboardShown: raw.keyboardShown };
}

/**
 * The digest of a screen's control set. Sorted and de-duplicated, so
 * reordering is not a state change and a repeated list row is not fifty.
 *
 * Only `displayed` nodes with an identity contribute, and geometry contributes
 * nothing — see {@link viewNodeIdentity}.
 */
export function screenDigest(input: {
  nodes: readonly RawViewNode[];
  markers: readonly string[];
}): string {
  const lines = new Set<string>();
  for (const node of input.nodes) {
    if (!node.displayed) continue;
    lines.add(`${canonicalRole(node.className)}|${viewNodeIdentity(node)}`);
  }
  for (const marker of input.markers) lines.add(`marker|${marker}`);
  const payload = [...lines].sort().join('\n');
  return createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

/** A screen's identity, and the evidence for how it was established. */
export interface MobileScreenSignature {
  /** The visited-set key: `route#variant`. */
  id: string;
  /** The reserved-prefix route. See {@link MOBILE_ROUTE_PREFIX}. */
  route: string;
  /** The `mobile:` URI for `FlowNode.url`. */
  url: string;
  anchor: string | null;
  basis: MobileIdentityBasis;
  /** Why the basis is what it is, in one sentence. */
  why: string;
  /**
   * The variant digest. For an ANCHORED screen it covers the MARKERS ONLY, so
   * a phone and a tablet showing the same screen agree; for a STRUCTURAL screen
   * it covers the whole control set, because there is nothing else to go on.
   */
  digest: string;
  markers: string[];
  class: MobileScreenClass;
}

/**
 * What this screen belongs to.
 *
 * The distinction the traversal cannot work without: three of these five are
 * things the crawl must HANDLE and must not expand, and treating them as app
 * screens is how a mobile crawl spends its budget enumerating the Android
 * share sheet.
 */
export const MOBILE_SCREEN_CLASSES = [
  /** The app under test. The only class that is expanded. */
  'APP',
  /** A runtime permission dialog. A state we record and never answer. */
  'OS_PERMISSION',
  /** A share sheet, photo picker or Settings pane the app opened. */
  'OS_SHEET',
  /**
   * The soft keyboard, with nothing else readable. NOT a screen — it occludes
   * one. Recorded so the traversal can dismiss it rather than hang on it.
   */
  'KEYBOARD',
  /** We left the app. The native analogue of the off-origin boundary. */
  'OTHER_APP',
] as const;
export type MobileScreenClass = (typeof MOBILE_SCREEN_CLASSES)[number];

export const MOBILE_SCREEN_CLASS_LABELS: Record<MobileScreenClass, string> = {
  APP: 'a screen of the app under test',
  OS_PERMISSION: 'an operating-system permission dialog',
  OS_SHEET: 'an operating-system sheet the app opened',
  KEYBOARD: 'the soft keyboard, occluding the screen underneath',
  OTHER_APP: 'another application — outside the app under test',
};

/** The classes the traversal expands. Everything else is recorded, not driven. */
export const EXPANDED_SCREEN_CLASSES: readonly MobileScreenClass[] = ['APP'];

/*
 * The packages that own a runtime permission dialog, and the ones that own a
 * system sheet.
 *
 * MATCHED ON THE PACKAGE and not on the words in the dialog, because the words
 * are localised and the package is not. A crawl that recognised "Allow" would
 * not recognise "Zulassen", would answer the dialog on a German device, and
 * would grant a permission nobody asked it to grant.
 */
const PERMISSION_PACKAGES = [
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.android.packageinstaller',
  'com.google.android.packageinstaller',
];
const SYSTEM_SHEET_PACKAGES = [
  'com.android.systemui',
  'com.android.settings',
  'com.android.intentresolver',
  'com.google.android.documentsui',
  'com.android.providers.media',
  'com.apple.springboard',
  'com.apple.Preferences',
  'com.apple.UIKit.activity',
];

/**
 * Which of the five this screen is, and why.
 *
 * `packageName === null` is the honest hard case: without `CURRENT_SCREEN` we
 * cannot tell our app from somebody else's, so the answer is APP with a
 * `why` that says the check could not be made. Guessing OTHER_APP would abandon
 * the crawl on the entry screen; guessing silently would hide that the most
 * important boundary in the traversal went unchecked.
 */
export function classifyScreen(
  raw: RawScreen,
  app: MobileAppIdentity,
): { class: MobileScreenClass; why: string } {
  const pkg = collapse(raw.packageName ?? '');
  if (pkg === '') {
    return {
      class: 'APP',
      why: 'the device did not report a foreground package, so the app boundary could not be checked',
    };
  }
  if (PERMISSION_PACKAGES.includes(pkg)) {
    return { class: 'OS_PERMISSION', why: `${pkg} owns the runtime permission dialog` };
  }
  if (SYSTEM_SHEET_PACKAGES.includes(pkg)) {
    return { class: 'OS_SHEET', why: `${pkg} is an operating-system sheet` };
  }
  if (pkg !== app.appId) {
    return { class: 'OTHER_APP', why: `the foreground package is ${pkg}, not ${app.appId}` };
  }
  if (raw.keyboardShown && raw.nodes.filter((node) => node.displayed).length === 0) {
    return { class: 'KEYBOARD', why: 'the keyboard is up and nothing else is readable' };
  }
  return { class: 'APP', why: `the foreground package is ${app.appId}` };
}

/**
 * The signature of the screen the device is currently showing.
 *
 * THE TWO REQUIREMENTS THIS FUNCTION IS THE ANSWER TO:
 *
 *   "the same screen on a phone and a tablet is one node" — an ANCHORED
 *   signature hashes the MARKERS ONLY. A tablet's extra detail pane adds
 *   controls, not markers, so the two agree. A STRUCTURAL signature cannot make
 *   that promise and says so via `basis`, which the result counts.
 *
 *   "a tab re-selected is not a new node" — re-tapping the live tab leaves the
 *   selected-marker set byte-identical, so `digest` is unchanged and the
 *   visited set recognises the state. Tapping a DIFFERENT tab changes the
 *   marker and is correctly a new node.
 *
 * The keyboard is excluded from the digest deliberately: a screen with its IME
 * up is the same screen, and including it would double every form screen.
 */
export function screenSignatureOf(raw: RawScreen, app: MobileAppIdentity): MobileScreenSignature {
  const anchorInfo = screenAnchorOf(raw);
  const { markers } = screenMarkersOf(raw);
  const classified = classifyScreen(raw, app);

  const digest =
    anchorInfo.basis === 'ANCHORED'
      ? screenDigest({ nodes: [], markers })
      : screenDigest({ nodes: raw.nodes, markers });

  const slug = anchorInfo.anchor ?? `structural:${digest}`;
  const route = mobileScreenRoute(app, slug);
  return {
    id: `${route}#${digest}`,
    route,
    url: `${MOBILE_URL_SCHEME}//${app.platform.toLowerCase()}/${app.appId}/${encodeURIComponent(slug)}`,
    anchor: anchorInfo.anchor,
    basis: anchorInfo.basis,
    why: anchorInfo.why,
    digest,
    markers: [...markers],
    class: classified.class,
  };
}

/**
 * The reserved-prefix route for one screen.
 *
 * Path-shaped on purpose: `policyDecision`, `matchesGlob` and the whole of
 * `CrawlPolicy` take a path, so this is what lets a customer write
 * `destructiveAllowGlobs: ['/mobile/android/com.acme.app/**']` and have it
 * govern native taps exactly as it governs web clicks. A screen identity that
 * were not a path would need a second policy engine.
 */
export function mobileScreenRoute(app: MobileAppIdentity, slug: string): string {
  return [
    MOBILE_ROUTE_PREFIX,
    app.platform.toLowerCase(),
    app.appId,
    slug.replace(/\s+/g, '-'),
  ].join('/');
}

// ─── Native affordances ──────────────────────────────────────────────────────

/**
 * The native control kinds, which are not the web's.
 *
 * A tab bar, a nav bar, a list row, a switch, a picker and a scroll container
 * have no web equivalent that would survive being filed under `BUTTON`, and
 * each one is a different test. `INTERACTION_KINDS` has eleven members and none
 * of them is a scroll container — reporting one as `HANDLER_DIV` would be
 * filing one kind under another kind's name, which is the near-miss
 * `crawl/interact.ts` names as the thing that makes a report unreadable.
 */
export const MOBILE_CONTROL_KINDS = [
  /** A bottom tab / segmented control item. Switches the whole screen. */
  'TAB_BAR_ITEM',
  /** A nav-bar action, including the app's own back chevron. */
  'NAV_BAR_ITEM',
  /** A row of a list or table. The most under-enumerated surface on mobile. */
  'LIST_ROW',
  /** "Next", "Continue", "Step 2 of 4". */
  'WIZARD_STEP',
  /** A plain button. */
  'BUTTON',
  /** A text field. A field, not an affordance: the field extractor's job. */
  'TEXT_FIELD',
  /** A switch or toggle. */
  'SWITCH',
  /** A checkbox or radio. */
  'CHECKBOX',
  /** A spinner, date picker or wheel. */
  'PICKER',
  /** A slider. */
  'SLIDER',
  /**
   * A scrollable container. Not something to tap: something to SCROLL, which is
   * how the half of the screen below the fold gets read at all.
   */
  'SCROLL_CONTAINER',
  /** A tappable view with no recognised class. The lower-bound case. */
  'HANDLER_VIEW',
] as const;
export type MobileControlKind = (typeof MOBILE_CONTROL_KINDS)[number];

export const MOBILE_CONTROL_KIND_LABELS: Record<MobileControlKind, string> = {
  TAB_BAR_ITEM: 'a tab bar item',
  NAV_BAR_ITEM: 'a navigation bar item',
  LIST_ROW: 'a list row',
  WIZARD_STEP: 'a wizard step',
  BUTTON: 'a button',
  TEXT_FIELD: 'a text field',
  SWITCH: 'a switch',
  CHECKBOX: 'a checkbox or radio',
  PICKER: 'a picker',
  SLIDER: 'a slider',
  SCROLL_CONTAINER: 'a scrollable container',
  HANDLER_VIEW: 'a tappable view with no recognised class',
};

/**
 * The base score per kind, before the per-element adjustments in
 * {@link rankMobileCandidate}. A compiler-enforced `Record` so a new kind
 * cannot be added without deciding what it is worth.
 *
 * A tab bar item outranks everything because it reaches a whole other screen
 * for one tap; a list row is next because it is the gateway to the detail
 * screen nobody enumerates; a slider and a field score 0 because driving them
 * reveals no new screen, and they are recorded as surface rather than driven.
 */
export const MOBILE_CONTROL_KIND_WEIGHT: Record<MobileControlKind, number> = {
  TAB_BAR_ITEM: 0.95,
  NAV_BAR_ITEM: 0.8,
  LIST_ROW: 0.78,
  WIZARD_STEP: 0.75,
  BUTTON: 0.5,
  HANDLER_VIEW: 0.2,
  SCROLL_CONTAINER: 0,
  TEXT_FIELD: 0,
  SWITCH: 0,
  CHECKBOX: 0,
  PICKER: 0,
  SLIDER: 0,
};

/**
 * The `InteractionKind` each native kind corresponds to, so `refusalFor` —
 * which owns the session-ending / destructive / real-world vocabulary and the
 * `allowDestructive` + `destructiveAllowGlobs` opt-in — governs a native tap
 * exactly as it governs a web click.
 *
 * A compiler-enforced `Record`, so a new native kind cannot be added without
 * deciding which policy branch it falls under. The mapping is by MEANING and
 * the two interesting rows are stated rather than left to be inferred:
 * `TEXT_FIELD` and the other field kinds map to `FORM_SUBMIT` so that
 * `safeMethodsOnly` governs typing into them, and `SCROLL_CONTAINER` maps to
 * `DISCLOSURE` because scrolling reveals declared-but-hidden content and is
 * never destructive.
 */
export const MOBILE_CONTROL_AS_INTERACTION_KIND: Record<MobileControlKind, InteractionKind> = {
  TAB_BAR_ITEM: 'TAB',
  NAV_BAR_ITEM: 'MENU',
  LIST_ROW: 'LINK',
  WIZARD_STEP: 'WIZARD_STEP',
  BUTTON: 'BUTTON',
  TEXT_FIELD: 'FORM_SUBMIT',
  SWITCH: 'FORM_SUBMIT',
  CHECKBOX: 'FORM_SUBMIT',
  PICKER: 'FORM_SUBMIT',
  SLIDER: 'FORM_SUBMIT',
  SCROLL_CONTAINER: 'DISCLOSURE',
  HANDLER_VIEW: 'HANDLER_DIV',
};

/** The field kinds. A field is surface to RECORD, not an affordance to tap. */
export const MOBILE_FIELD_KINDS: readonly MobileControlKind[] = [
  'TEXT_FIELD',
  'SWITCH',
  'CHECKBOX',
  'PICKER',
  'SLIDER',
];

/**
 * The platform class or element type, as a role.
 *
 * Both platforms' class names end in the role, so the mapping is a suffix
 * table rather than a guess: `android.widget.Button` and
 * `XCUIElementTypeButton` are both `button`. Unrecognised classes return
 * `view`, which is honest — it is what the hierarchy said — and feeds
 * `HANDLER_VIEW`, the lower-bound case.
 */
export function canonicalRole(className: string): string {
  const bare = className.replace(/^XCUIElementType/, '').replace(/^.*\./, '');
  const lower = bare.toLowerCase();
  const mapped = ROLE_BY_CLASS[lower];
  return mapped ?? 'view';
}

const ROLE_BY_CLASS: Record<string, string | undefined> = {
  // Buttons and tappables
  button: 'button',
  imagebutton: 'button',
  appcompatbutton: 'button',
  materialbutton: 'button',
  floatingactionbutton: 'button',
  // Text
  textview: 'text',
  appcompattextview: 'text',
  statictext: 'text',
  // Fields
  edittext: 'textfield',
  appcompatedittext: 'textfield',
  textinputedittext: 'textfield',
  textfield: 'textfield',
  securetextfield: 'textfield',
  searchfield: 'textfield',
  textview_ios: 'textfield',
  // Toggles
  switch: 'switch',
  switchcompat: 'switch',
  switchmaterial: 'switch',
  togglebutton: 'switch',
  checkbox: 'checkbox',
  appcompatcheckbox: 'checkbox',
  radiobutton: 'checkbox',
  // Pickers
  spinner: 'picker',
  numberpicker: 'picker',
  datepicker: 'picker',
  timepicker: 'picker',
  pickerwheel: 'picker',
  picker: 'picker',
  segmentedcontrol: 'tabbar',
  slider: 'slider',
  seekbar: 'slider',
  // Containers
  recyclerview: 'list',
  listview: 'list',
  gridview: 'list',
  table: 'list',
  collectionview: 'list',
  scrollview: 'scroll',
  nestedscrollview: 'scroll',
  horizontalscrollview: 'scroll',
  viewpager: 'scroll',
  viewpager2: 'scroll',
  // Rows
  cell: 'row',
  link: 'link',
  textlink: 'link',
  // Bars
  tablayout: 'tabbar',
  bottomnavigationview: 'tabbar',
  tabbar: 'tabbar',
  toolbar: 'navbar',
  actionbar: 'navbar',
  navigationbar: 'navbar',
  // Dialogs
  alert: 'dialog',
  sheet: 'dialog',
};

/** Whether this node is a field to record rather than an affordance to tap. */
export function isMobileFieldNode(node: RawViewNode): boolean {
  const role = canonicalRole(node.className);
  return (
    role === 'textfield' ||
    role === 'switch' ||
    role === 'checkbox' ||
    role === 'picker' ||
    role === 'slider'
  );
}

/** "Next", "Continue", "Step 2". Shared with the web vocabulary by meaning. */
const WIZARD_TEXT = /\b(next|continue|proceed|previous|back|step\s*\d+|finish|review|done)\b/i;

/**
 * Roles that are tappable BY TYPE, whatever the dump says about clickability.
 *
 * THE DEFECT THIS FIXES, and it is the whole iOS axis. Android's hierarchy
 * carries `clickable`; iOS's carries NO SUCH ATTRIBUTE — an
 * `XCUIElementTypeButton` has `enabled` and `visible` and nothing else. So a
 * clickability test alone classifies every single iOS control as "not an
 * affordance", `classifyMobileControl` returns null for all of them, and an
 * iPhone app enumerates as a list of screens with no controls on any of them.
 * That is a zero that is not a measurement, on the half of the mobile market
 * that is iOS.
 *
 * The cost of the other direction is accepted and small: an Android `Button`
 * with `clickable="false"` is now classified as a BUTTON. It is still a button
 * the developer put on the screen, `enabled` already separates the disabled
 * case, and over-counting one rare element is preferable to erasing a platform.
 */
const TAPPABLE_BY_ROLE = new Set(['button', 'row', 'tabbar', 'navbar', 'link']);

/** Whether this element can be tapped at all. See {@link TAPPABLE_BY_ROLE}. */
export function isTappableNode(node: RawViewNode): boolean {
  if (node.clickable || node.longClickable) return true;
  return TAPPABLE_BY_ROLE.has(canonicalRole(node.className));
}

/**
 * What kind of native control this is, or null when it is not one.
 *
 * Order is the whole function, and it is the native mirror of
 * `classifyControl`: the CONTAINER the element sits in decides first, because
 * on mobile the container is the strongest declaration available — the same
 * "Settings" label is a tab in a tab bar, a nav action in a nav bar and a row
 * in a list, and those are three controls with three behaviours.
 *
 * Returns null for a HIDDEN element only. A DISABLED element is a classified
 * control: {@link MobileEnumerationStats.disabledControls} counts it, because a
 * disabled "Previous" on page 1 is a control that EXISTS and that we could not
 * exercise here, which is not the same thing as a control that does not exist.
 */
export function classifyMobileControl(node: RawViewNode): MobileControlKind | null {
  if (!node.displayed) return null;

  const role = canonicalRole(node.className);
  const container = (node.container ?? '').toLowerCase();

  if (role === 'scroll' || role === 'list' || node.scrollable) return 'SCROLL_CONTAINER';
  if (isMobileFieldNode(node)) {
    if (role === 'switch') return 'SWITCH';
    if (role === 'checkbox') return 'CHECKBOX';
    if (role === 'picker') return 'PICKER';
    if (role === 'slider') return 'SLIDER';
    return 'TEXT_FIELD';
  }

  if (!isTappableNode(node)) return null;

  if (container === 'tabbar' || role === 'tabbar') return 'TAB_BAR_ITEM';
  if (container === 'navbar' || role === 'navbar') return 'NAV_BAR_ITEM';
  if (role === 'row' || role === 'link' || container === 'list') return 'LIST_ROW';

  const name = mobileAccessibleName(node);
  if (role === 'button' && WIZARD_TEXT.test(name)) return 'WIZARD_STEP';
  if (role === 'button') return 'BUTTON';
  return 'HANDLER_VIEW';
}

/**
 * The accessible name, in the APPLICATION'S OWN CASE.
 *
 * Ranked by what the developer DECLARED: `content-desc` / iOS `name` first
 * because it is set deliberately and is what a screen reader says, then the
 * visible text, then the hint, then the resource id. Folding case would merge
 * two controls and shrink the denominator, which is why `collapse` normalises
 * whitespace and nothing else.
 */
export function mobileAccessibleName(node: RawViewNode): string {
  const candidates = [node.accessibilityId, node.text, node.hint, node.resourceId];
  for (const candidate of candidates) {
    const value = collapse(candidate ?? '');
    if (value !== '') return value;
  }
  return '';
}

/**
 * The locator a generated MOBILE test will use, plus how much we trust it.
 *
 * `MobileSelector` and not the web `Selector`, and the difference is
 * load-bearing: `MobileSelector` is what `packages/runner/src/plugins/mobile
 * .ts` already consumes, so the thing this module enumerates is the thing the
 * runner can drive. Squeezing a native locator into the web `Selector`'s
 * ROLE / LABEL / CSS strategies would hand the generator a Playwright locator
 * for a native control, which is a test that cannot be written.
 *
 * `accessibility id` is preferred for the reason `MOBILE_LOCATOR_STRATEGIES`
 * already states: it is the one locator stable across a redesign, works on both
 * platforms, and improves the app for screen-reader users when a developer has
 * to add it. An xpath is the last resort and carries a confidence low enough to
 * be flagged for review.
 */
export function mobileSelectorFor(node: RawViewNode): {
  selector: MobileSelector;
  confidence: number;
} {
  const accessibility = collapse(node.accessibilityId ?? '');
  if (accessibility !== '') {
    return { selector: { using: 'accessibility id', value: accessibility }, confidence: 0.95 };
  }
  const resource = collapse(node.resourceId ?? '');
  if (resource !== '') {
    return { selector: { using: 'id', value: resource }, confidence: 0.85 };
  }
  return { selector: { using: 'xpath', value: node.ref }, confidence: 0.35 };
}

/** A control the crawl could drive, with the score that decides the order. */
export interface MobileCandidate {
  ref: string;
  kind: MobileControlKind;
  label: string;
  /** Per-screen identity. See {@link controlIdentity}. */
  identity: string;
  selector: MobileSelector;
  selectorConfidence: number;
  /** 0–1: how likely tapping it is to reveal a screen we have not seen. */
  score: number;
}

/**
 * How likely driving this control is to reveal a screen we have not seen.
 *
 * Deliberately NOT a model call and deliberately not a coin flip. The order
 * decides which controls a budget leaves undriven, so a bad order does not make
 * the measurement wrong — it makes the part that was cut the interesting part.
 */
export function rankMobileCandidate(
  node: RawViewNode,
  kind: MobileControlKind,
  seenIdentities: ReadonlySet<string>,
  identity: string,
): number {
  let score = MOBILE_CONTROL_KIND_WEIGHT[kind];
  // A control we have already driven somewhere is worth less, not nothing: the
  // same "Settings" tab on two screens can lead to two screens.
  if (seenIdentities.has(identity)) score -= 0.25;
  // A declared id is a developer's statement that this thing matters.
  if (collapse(node.resourceId ?? '') !== '') score += 0.05;
  if (collapse(node.accessibilityId ?? '') !== '') score += 0.05;
  // Already selected: tapping it is the "tab re-selected" no-op.
  if (node.selected) score -= 0.5;
  if (!node.enabled) score -= 1;
  return Math.max(0, Math.min(1, score));
}

// ─── Reversal: how the crawl gets back to a screen it has left ───────────────

/**
 * How the crawl returns to a state it has already left.
 *
 * REPLAY is the strategy, for the reason `crawl/interact.ts` gives and one more
 * that is specific to mobile. The web reason: BACK restores a URL, not an
 * application state. The mobile reason: THERE IS NO URL. A native screen has no
 * address, so "go back to where we were" can only ever mean "relaunch the app
 * and walk the taps" — and walking them is the only way to learn that the path
 * actually works, which is the artefact the Generator needs in order to write a
 * mobile test at all.
 *
 * BACK therefore appears here as a MEASURED EDGE and not as the recovery
 * mechanism. RESET is relaunch-only, used when the app has been left entirely.
 */
export const MOBILE_REVERSAL_STRATEGIES = ['REPLAY', 'BACK', 'RESET'] as const;
export type MobileReversalStrategy = (typeof MOBILE_REVERSAL_STRATEGIES)[number];

export const MOBILE_REPLAY_STEP_KINDS = ['LAUNCH', 'TAP', 'TYPE', 'SWIPE', 'BACK'] as const;
export type MobileReplayStepKind = (typeof MOBILE_REPLAY_STEP_KINDS)[number];

export interface MobileReplayStep {
  kind: MobileReplayStepKind;
  /** For LAUNCH the app id; for TAP/TYPE the control identity; for SWIPE the direction. */
  target: string;
  /** What a human would read in the test: `tap "Check out"`. */
  label: string;
  selector: MobileSelector | null;
  /** For TYPE: the literal typed. Always a literal, never a secret. */
  value?: string;
}

export interface MobileReplayPath {
  steps: MobileReplayStep[];
  /**
   * True when the harness re-walked these steps and arrived at the same
   * signature. FALSE means the path is recorded and did NOT reproduce the
   * screen, which is a caveat the Generator has to see: a screen we cannot
   * return to is a screen no test can reach, and reporting it as reachable
   * would be a promise the Generator cannot keep.
   */
  verified: boolean;
  /** The signature it arrived at instead, when it diverged. */
  divergedTo: string | null;
  strategy: MobileReversalStrategy;
}

/** A readable rendering of a replay path, for an edge's `action` and a report. */
export function describeMobileReplay(path: MobileReplayPath): string {
  return path.steps
    .map((step) => {
      if (step.kind === 'LAUNCH') return `launch ${step.target}`;
      if (step.kind === 'TYPE') return `type "${step.value ?? ''}" into ${step.label}`;
      if (step.kind === 'SWIPE') return `swipe ${step.target}`;
      if (step.kind === 'BACK') return 'press back';
      return `tap "${step.label}"`;
    })
    .join(' → ');
}

// ─── Budgets, and the disclosure of every one that bit ───────────────────────

/**
 * The budgets that are mobile-specific.
 *
 * They are NOT `CapBite`s, for the same vocabulary reason `INTERACTION_BUDGETS`
 * is not: `CRAWL_CAPS` has eight members and none of them is a scroll-reveal
 * limit or a back-probe limit. Filing a scroll budget under
 * `AFFORDANCES_PER_PAGE` would put one cap under another cap's name, and a
 * report that does that cannot be read.
 *
 * Everything the mobile crawl does that IS expressible in `CRAWL_CAPS` — the
 * screen budget, the depth limit, the wall clock, the per-screen control cap,
 * the queue limit — is reported as a real `CapBite` in `result.caps`.
 */
export const MOBILE_BUDGETS = [
  'SCROLL_REVEAL',
  'PER_SCREEN_INTERACTION',
  'BACK_PROBE',
  'ORIENTATION_PROBE',
] as const;
export type MobileBudget = (typeof MOBILE_BUDGETS)[number];

export const MOBILE_BUDGET_LABELS: Record<MobileBudget, string> = {
  SCROLL_REVEAL: 'the per-container scroll limit',
  PER_SCREEN_INTERACTION: 'the per-screen tap budget',
  BACK_PROBE: 'the back-edge probe budget',
  ORIENTATION_PROBE: 'the orientation-probe budget',
};

/**
 * Same shape as `CapBite`, including the REQUIRED `discarded` count — and
 * `unknownRemainder`, which `CapBite` has no room for.
 *
 * `unknownRemainder` is the honest answer to the scroll container. When the
 * scroll budget bites while the last swipe was still revealing new controls, we
 * know more existed and we do NOT know how many: the container does not publish
 * its length. `discarded: 0` with `unknownRemainder: true` says exactly that,
 * and the pair is what stops a reader turning "the budget bit" into "it cost
 * nothing". A zero with `unknownRemainder: false` is a real measurement — the
 * budget expired on a container that had already converged.
 */
export interface MobileBudgetBite {
  budget: MobileBudget;
  limit: number;
  bites: number;
  /** Candidates it threw away, where a number is knowable. */
  discarded: number;
  /** True when an UNKNOWN number of further candidates existed. Never ignored. */
  unknownRemainder: boolean;
  scope: string | null;
  reason: string;
}

/** Only the budgets that actually bit. One that did not is not a caveat. */
export function mobileBudgetsThatBit(budgets: readonly MobileBudgetBite[]): MobileBudgetBite[] {
  return budgets.filter((budget) => budget.bites > 0);
}

/** Everything the mobile budgets threw away, summed. */
export function discardedByMobileBudgets(budgets: readonly MobileBudgetBite[]): number {
  return mobileBudgetsThatBit(budgets).reduce((running, budget) => running + budget.discarded, 0);
}

/**
 * THE INVARIANT that keeps "converged" honest, as a predicate a test can hold.
 *
 * Every budget bite site adds its `discarded` count to `unvisitedQueued`, so a
 * budget that bit moves `atLeastMoreUrls` off zero and `enumerationOutcome`
 * already answers STOPPED. It is one missing `+=` away from being untrue, at
 * which point the word CONVERGED would appear on a truncated enumeration. So
 * the invariant is asserted rather than assumed.
 *
 * A bite whose remainder is UNKNOWN is covered by the second clause: it cannot
 * contribute a number, so it must instead have forced the outcome off CONVERGED
 * — which {@link enumerateMobileScreens} does through `caps`.
 */
export function mobileBudgetsFeedTheFrontier(
  result: Pick<MobileEnumerationEnumerated, 'budgets' | 'frontier' | 'outcome'>,
): boolean {
  if (discardedByMobileBudgets(result.budgets) > result.frontier.atLeastMoreUrls) return false;
  const unknown = mobileBudgetsThatBit(result.budgets).some((bite) => bite.unknownRemainder);
  return !unknown || result.outcome !== 'CONVERGED';
}

/*
 * A tiny ledger, so a cap or a budget is recorded in exactly one place and
 * cannot be incremented without a `discarded` count. Every `break` and
 * `continue` in the traversal goes through one of these two methods.
 */
class MobileLedger {
  private readonly caps = new Map<string, CapBite>();
  private readonly budgets = new Map<MobileBudget, MobileBudgetBite>();

  cap(cap: CrawlCap, limit: number, discarded: number, scope: string | null, reason: string): void {
    const key = `${cap}:${scope ?? ''}`;
    const existing = this.caps.get(key);
    if (existing) {
      existing.bites += 1;
      existing.discarded += discarded;
      return;
    }
    this.caps.set(key, { cap, limit, bites: 1, discarded, scope, reason });
  }

  budget(input: {
    budget: MobileBudget;
    limit: number;
    discarded: number;
    unknownRemainder: boolean;
    scope: string | null;
    reason: string;
  }): void {
    const existing = this.budgets.get(input.budget);
    if (existing) {
      existing.bites += 1;
      existing.discarded += input.discarded;
      existing.unknownRemainder = existing.unknownRemainder || input.unknownRemainder;
      if (existing.scope !== input.scope) existing.scope = null;
      return;
    }
    this.budgets.set(input.budget, { ...input, bites: 1 });
  }

  capList(): CapBite[] {
    return [...this.caps.values()];
  }

  budgetList(): MobileBudgetBite[] {
    return [...this.budgets.values()];
  }
}

// ─── The result ──────────────────────────────────────────────────────────────

/**
 * A `FlowNode` for a mobile screen, plus what it took to get there.
 *
 * The extra members are additive, so the object IS a `FlowNode` everywhere one
 * is expected and survives being stored as graph JSON.
 */
export interface MobileScreenNode extends FlowNode {
  signature: MobileScreenSignature;
  /** How to reach it. The artefact the Generator needs. */
  replay: MobileReplayPath;
  /** Taps from the entry screen. 0 for the screen the app launches into. */
  interactionDepth: number;
  parentScreenId: string | null;
  /** The device this screen was read on, so a form-factor claim has evidence. */
  device: MobileDeviceDescriptor;
  /** Every control seen on it, driven or not. The real control denominator. */
  controls: MobileControlSighting[];
  /** The field group, when the screen has fields. Null when it has none. */
  fields: MobileFieldGroup | null;
  /**
   * False when the traversal recorded this screen and did NOT expand it — an OS
   * dialog, a sheet, another app, or a branch a budget cut.
   *
   * `expandedWhy` is required when this is false, because "a screen whose crawl
   * was skipped" counted as "a screen with no further surface" is the mobile
   * form of the role-skipped lie: it is the difference between "nothing is
   * behind this" and "we did not look".
   */
  expanded: boolean;
  expandedWhy: string | null;
  /**
   * Whether this screen is behind an authentication wall — UNKNOWN here, and
   * NULL rather than false.
   *
   * `FlowNode.behindAuth` above is a required `boolean` with no null available,
   * so `false` is written there and must NOT be read as a measurement. This
   * field is the honest one. Measuring it needs an identity to crawl as, and
   * `authProfile.findFirst` picks exactly one for the whole crawl today; see
   * this module's report.
   */
  behindAuthMeasured: boolean | null;
}

/** A `FlowEdge` that carries the path a test would walk to traverse it. */
export interface MobileScreenEdge extends FlowEdge {
  /** The control's per-screen identity — stable across crawls, unlike `ref`. */
  controlIdentity: string | null;
  kind: MobileEdgeKind;
  /** Which mechanism went back, for a BACK edge. Null otherwise. */
  backMechanism: MobileBackMechanism | null;
  /** The replay path to the edge's TARGET. */
  replay: MobileReplayPath;
  /** The native locator, so the edge is drivable by the MOBILE runner. */
  mobileSelector: MobileSelector | null;
}

/**
 * How a transition happened.
 *
 * BACK is a first-class edge and that is the point of this union. The platform
 * back gesture and the hardware back button are how a user leaves most native
 * screens; a crawl that treated them as a RESET would record the graph as a
 * star of screens hanging off the launch screen, and "can the user get back
 * from here" — the single most common native defect — would be unaskable.
 *
 * APP_EXIT is the other end of the same fact: back on the root screen leaves
 * the app, which is correct behaviour and a measurable edge, not a crawl
 * failure.
 */
export const MOBILE_EDGE_KINDS = ['TAP', 'BACK', 'APP_EXIT', 'OS_DIALOG'] as const;
export type MobileEdgeKind = (typeof MOBILE_EDGE_KINDS)[number];

export const MOBILE_EDGE_KIND_LABELS: Record<MobileEdgeKind, string> = {
  TAP: 'a tap on a control',
  BACK: 'the platform back gesture or hardware back button',
  APP_EXIT: 'back from the root screen, which leaves the app',
  OS_DIALOG: 'an operating-system dialog the screen raised',
};

/** Every control seen, driven or not. The real control denominator. */
export interface MobileControlSighting {
  screenId: string;
  route: string;
  identity: string;
  label: string;
  kind: MobileControlKind;
  /** The `FlowNode.affordances` vocabulary, so the existing readers work. */
  affordanceKind: 'link' | 'button' | 'input';
  selector: MobileSelector;
  selectorConfidence: number;
  /** Set when it was refused or could not be driven. Null when it was fine. */
  exercise: SurfaceExercise | null;
  exercised: boolean;
  /** Present and disabled in the state we read it in. Surface, not absence. */
  disabled: boolean;
  /** The screen it produced, when it produced one. */
  leadsTo: string | null;
}

/** A control the crawl would not drive, with the rule and the surface key. */
export interface MobileRefusal {
  screenId: string;
  route: string;
  identity: string;
  label: string;
  kind: MobileControlKind;
  /** Never EXERCISABLE: this list exists to name what was held out. */
  exercise: SurfaceExercise;
  /**
   * The inventory key for what the refusal cost us: the screen behind the
   * control we would not tap, which is a component state we cannot reach.
   *
   * NOTE that `COMPONENT_STATE` is not in `MEASURED_SURFACE_KINDS`, so whoever
   * admits these into the denominator must add the matcher AND the measured-kind
   * entry in one change — check:wiring section 9 fails on either half alone.
   */
  surfaceItemKey: string;
}

/** One field on a screen, with the semantic the synthetic generator needs. */
export interface MobileField {
  identity: string;
  label: string;
  kind: MobileControlKind;
  selector: MobileSelector;
  selectorConfidence: number;
  /** From the INJECTED `semanticFor`, so one classifier serves both axes. */
  semantic: FormFieldSemantic;
  /**
   * True when the platform marks it a secure entry. The VALUE of such a field
   * is never read, never hashed and never recorded anywhere in this module.
   */
  secure: boolean;
  required: boolean;
  /** Set when the harness would not type into it, with the reason. */
  exercise: SurfaceExercise | null;
}

/** The fields of one screen. The native analogue of a `FormModel`. */
export interface MobileFieldGroup {
  screenId: string;
  route: string;
  fields: MobileField[];
  /** The control that submits them, when one is recognisable. */
  submit: { identity: string; label: string; selector: MobileSelector } | null;
}

/** Another application the app under test reached. The native off-origin boundary. */
export interface MobileExternalApp {
  /**
   * The package or bundle id. ID ONLY — never the deep link that reached it,
   * which on a share or an OAuth hand-off carries a token, and a flow map is
   * stored, exported and rendered in a cockpit.
   */
  appId: string;
  /** The in-app screen that reached it. */
  fromRoute: string | null;
  occurrences: number;
}

/**
 * Whether screen identity survived a rotation, PROVEN rather than asserted.
 *
 * `stable: null` is the answer when `ORIENTATION` is absent or the probe budget
 * was spent — never `true`, which would claim a measurement we did not make,
 * and never `false`, which would report a defect we did not see. The whole
 * reason the probe exists is that "a phone and a tablet are one node" is a
 * claim this module makes about its own identity function, and a claim with no
 * check behind it is the kind this product cannot afford.
 */
export interface OrientationProbe {
  ran: boolean;
  stable: boolean | null;
  /** The signature before and after, when the probe ran and diverged. */
  before: string | null;
  after: string | null;
  why: string;
}

export interface MobileEnumerationStats {
  screensVisited: number;
  /** Taps performed, excluding replay taps. */
  taps: number;
  /** Replay walks performed, so the cost of REPLAY-not-BACK is visible. */
  replays: number;
  /** Taps that changed nothing. A real measurement: the control is inert. */
  noOpTaps: number;
  controlsSeen: number;
  /**
   * Controls present and DISABLED in the state we read them in. A control that
   * EXISTS and could not be exercised here, which is not a control that does
   * not exist.
   */
  disabledControls: number;
  /** Controls `displayed: false` when read. Same reasoning. */
  hiddenControls: number;
  /** Replays that did not reproduce their screen. Each one is an unreachable screen. */
  replayFailures: number;
  /**
   * Screens whose identity could only be computed STRUCTURALLY.
   *
   * The caveat a tablet needs: these may split into two nodes across form
   * factors. Reported as a count so the report can name the risk instead of
   * presenting one number with no error bars.
   */
  screensIdentifiedStructurally: number;
  /** Scroll containers that did NOT reach their end. Controls below are UNKNOWN. */
  containersNotScrolledToEnd: number;
  /** OS dialogs and sheets met, recorded and never answered. */
  osStatesMet: number;
  /**
   * Back edges measured. NULL — not 0 — when the `BACK` capability is absent:
   * "we could not press back" and "no screen has a way back" are opposite
   * facts and only one of them is the customer's problem.
   */
  backEdges: number | null;
  /** Times the crawl left the app and had to relaunch. */
  appExits: number;
}

/**
 * Enumeration ran. The graph, and everything that qualifies it.
 *
 * `outcome` is the shared `EnumerationOutcome`, reused rather than respelled:
 * CONVERGED means there was nothing left to visit, STOPPED means a budget ran
 * out while screens were still queued (the UNPROVEN answer), FAILED means
 * nothing was enumerated. `why` always carries the NUMBER.
 */
export interface MobileEnumerationEnumerated {
  status: 'ENUMERATED';
  app: MobileAppIdentity;
  device: MobileDeviceDescriptor;
  screens: MobileScreenNode[];
  edges: MobileScreenEdge[];
  controls: MobileControlSighting[];
  fieldGroups: MobileFieldGroup[];
  refusals: MobileRefusal[];
  externals: MobileExternalApp[];
  /** Caps expressible in `CRAWL_CAPS`. Merge into `FlowMap.caps`. */
  caps: CapBite[];
  /** The four budgets `CRAWL_CAPS` has no member for. */
  budgets: MobileBudgetBite[];
  /** Screens known and not visited. `atLeastMoreUrls` is consistent. */
  frontier: Frontier;
  outcome: EnumerationOutcome;
  /** Always carries the count. See {@link enumerationOutcome}. */
  why: string;
  orientationProbe: OrientationProbe;
  unavailable: MobileCapabilityGap[];
  /** Whatever the hierarchy reads could not be made sense of. */
  warnings: string[];
  stats: MobileEnumerationStats;
}

/**
 * Why no enumeration was possible.
 *
 * A closed vocabulary with a REMEDY per member, in the style the MOBILE runner
 * plugin's skip paths already established: "a mobile test that reports 'your
 * app is broken' because the emulator was not running is worse than no mobile
 * test at all", and the enumeration form of that sentence is "an app reported
 * as having no screens because no device was attached".
 */
export const MOBILE_UNAVAILABLE_REASONS = [
  'NO_DEVICE',
  'MISSING_CAPABILITY',
  'APP_NOT_LAUNCHED',
  'HIERARCHY_UNREADABLE',
] as const;
export type MobileUnavailableReason = (typeof MOBILE_UNAVAILABLE_REASONS)[number];

export const MOBILE_UNAVAILABLE_REMEDIES: Record<MobileUnavailableReason, string> = {
  NO_DEVICE:
    'No device or emulator is attached. Boot an emulator or simulator, attach a device, or configure a device farm on the environment, then re-run enumeration.',
  MISSING_CAPABILITY:
    'The driver does not offer a capability enumeration cannot work without. Use an Appium server with the platform driver installed, or a device farm session, then re-run enumeration.',
  APP_NOT_LAUNCHED:
    'The app under test could not be brought to the foreground. Check that the build is installed on this device and that the package or bundle id on the environment matches it.',
  HIERARCHY_UNREADABLE:
    'The device returned no readable view hierarchy. On Android confirm the UiAutomator service is running; on iOS confirm WebDriverAgent is installed and trusted.',
};

/**
 * No enumeration happened, and WHY — with NO `screens` FIELD.
 *
 * The missing field is the design. A result object with `screens: []` reads as
 * "this application has no mobile screens", which is the most expensive thing
 * this module could accidentally say: it would enter the denominator as a
 * complete measurement of zero surface, and a zero denominator reports as 100%
 * covered. A discriminated union forces every reader to answer the question
 * before it can see a graph.
 */
export interface MobileEnumerationUnavailable {
  status: 'UNAVAILABLE';
  reason: MobileUnavailableReason;
  /** What to do about it. Never blank. */
  remedy: string;
  /** What specifically was missing, in this run's own words. */
  detail: string;
  app: MobileAppIdentity;
  /** The device we tried, when there was one. */
  device: MobileDeviceDescriptor | null;
  unavailable: MobileCapabilityGap[];
  /**
   * FAILED, always, and spelled out rather than left to a reader.
   * `ENUMERATION_OUTCOME_LABELS.FAILED` is 'nothing was enumerated', which is
   * exactly the fact, and it keeps this result comparable with the other two
   * crawls' outcomes.
   */
  outcome: 'FAILED';
  why: string;
}

export type MobileEnumerationResult = MobileEnumerationEnumerated | MobileEnumerationUnavailable;

/** Narrowing helper, so a reader cannot forget the UNAVAILABLE branch. */
export function mobileScreensOf(result: MobileEnumerationResult): MobileScreenNode[] | null {
  return result.status === 'ENUMERATED' ? result.screens : null;
}

export interface MobileEnumerationOptions {
  app: MobileAppIdentity;
  policy: CrawlPolicy;
  primitives: MobilePrimitives;
  /** Which attached device to use. Default: the first one `devices()` reports. */
  deviceId?: string;
  /** Screens this pass may add. Default `policy.pageBudget`. */
  maxScreens?: number;
  /** Taps deep from the launch screen. Default `policy.maxDepth`. */
  maxDepth?: number;
  /** Default 400. */
  tapBudget?: number;
  /** Default 12. */
  perScreenTapBudget?: number;
  /** Controls read per screen. Default 200. */
  controlsPerScreen?: number;
  /** Swipes per scroll container. Default 6. */
  scrollRevealBudget?: number;
  /** Back probes for the whole run. Default 40. */
  backProbeBudget?: number;
  /** Default `policy.wallClockMillis`. */
  wallClockMillis?: number;
  /** Set false to skip the rotation probe. Default true where `ORIENTATION` exists. */
  probeOrientation?: boolean;
  /** Frontier sample size. Default 20. */
  frontierSampleSize?: number;
  /** Injected so a budget test does not depend on the wall clock. */
  now?: () => number;
  onProgress?: (message: string) => void;
}

// ─── The traversal ───────────────────────────────────────────────────────────

interface ScreenRecord {
  signature: MobileScreenSignature;
  nodeId: string;
  replay: MobileReplayPath;
  depth: number;
  /** False once we have read its controls, so a screen is expanded once. */
  pending: boolean;
}

const UNKNOWN_DEVICE: MobileDeviceDescriptor = {
  id: 'unknown',
  platform: 'ANDROID',
  platformVersion: null,
  formFactor: 'UNKNOWN',
  widthDp: null,
  heightDp: null,
  emulator: null,
};

/**
 * Enumerate the screens of a native application.
 *
 * Returns a graph FRAGMENT rather than a `FlowMap`, for the reason
 * `exploreInteractions` returns one: the caller owns the map, and the web crawl
 * and this pass produce two halves of one graph. Only the caller knows the
 * node-id space, and only the caller knows whether a `FlowMap` for this
 * environment should carry mobile screens at all.
 */
export async function enumerateMobileScreens(
  device: MobileDevice,
  options: MobileEnumerationOptions,
): Promise<MobileEnumerationResult> {
  const progress = options.onProgress ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const app = options.app;
  const policy = options.policy;

  const available = new Set(device.capabilities());
  const unavailable: MobileCapabilityGap[] = [];
  for (const capability of MOBILE_ENUMERATION_CAPABILITIES) {
    if (available.has(capability)) continue;
    unavailable.push({ capability, cost: MOBILE_CAPABILITY_COST[capability] });
  }

  const missingRequired = REQUIRED_MOBILE_CAPABILITIES.filter(
    (capability) => !available.has(capability),
  );
  if (missingRequired.length > 0) {
    return unavailableResult({
      reason: 'MISSING_CAPABILITY',
      detail: `the driver does not offer ${missingRequired.join(', ')}`,
      app,
      device: null,
      unavailable,
    });
  }

  const attached = await device.devices();
  if (attached.length === 0) {
    return unavailableResult({
      reason: 'NO_DEVICE',
      detail: 'the driver reported no attached device or emulator',
      app,
      device: null,
      unavailable,
    });
  }
  const chosen =
    (options.deviceId === undefined
      ? attached[0]
      : attached.find((candidate) => candidate.id === options.deviceId)) ?? attached[0];
  /*
   * noUncheckedIndexedAccess: `attached[0]` is `T | undefined` even though the
   * length check above proves otherwise. UNKNOWN_DEVICE is unreachable and is
   * here so the fallback is a visibly-unknown descriptor rather than a cast
   * that would also silence a real future bug.
   */
  const deviceInfo = chosen ?? UNKNOWN_DEVICE;

  const launched = await device.launch();
  if (!launched.ok) {
    return unavailableResult({
      reason: 'APP_NOT_LAUNCHED',
      detail: launched.error ?? 'launch failed and the driver gave no reason',
      app,
      device: deviceInfo,
      unavailable,
    });
  }

  const warnings: string[] = [];
  const first = await device.screen();
  warnings.push(...first.warnings);
  if (first.nodes.length === 0 && first.alertText === null) {
    return unavailableResult({
      reason: 'HIERARCHY_UNREADABLE',
      detail: 'the first hierarchy read returned no elements and no alert',
      app,
      device: deviceInfo,
      unavailable,
    });
  }

  const maxScreens = options.maxScreens ?? policy.pageBudget;
  const maxDepth = options.maxDepth ?? policy.maxDepth;
  const tapBudget = options.tapBudget ?? 400;
  const perScreenTapBudget = options.perScreenTapBudget ?? 12;
  const controlsPerScreen = options.controlsPerScreen ?? 200;
  const scrollRevealBudget = options.scrollRevealBudget ?? 6;
  const backProbeBudget = options.backProbeBudget ?? 40;
  const wallClockMillis = options.wallClockMillis ?? policy.wallClockMillis;
  const sampleSize = options.frontierSampleSize ?? 20;
  const deadline = now() + wallClockMillis;

  const ledger = new MobileLedger();
  const screens: MobileScreenNode[] = [];
  const edges: MobileScreenEdge[] = [];
  const controls: MobileControlSighting[] = [];
  const fieldGroups: MobileFieldGroup[] = [];
  const refusals: MobileRefusal[] = [];
  const externalsByApp = new Map<string, MobileExternalApp>();
  const known = new Map<string, ScreenRecord>();
  const seenControlIdentities = new Set<string>();
  const queue: ScreenRecord[] = [];
  /** Screens discovered, in scope, and never visited. Feeds the lower bound. */
  const unvisited = new Set<string>();
  /** Screens seen past the depth limit. The second half of the lower bound. */
  const beyondDepth = new Set<string>();

  const stats: MobileEnumerationStats = {
    screensVisited: 0,
    taps: 0,
    replays: 0,
    noOpTaps: 0,
    controlsSeen: 0,
    disabledControls: 0,
    hiddenControls: 0,
    replayFailures: 0,
    screensIdentifiedStructurally: 0,
    containersNotScrolledToEnd: 0,
    osStatesMet: 0,
    /*
     * NULL, not 0, when we cannot press back. Set to 0 only once the capability
     * is confirmed, so "no back edge was found" and "we could not look" are
     * never the same number.
     */
    backEdges: available.has('BACK') ? 0 : null,
    appExits: 0,
  };

  let tapsSpent = 0;
  let backProbesSpent = 0;

  const outOfTime = (): boolean => now() >= deadline;

  /** Dismiss an occluding keyboard, or say why we could not. */
  const settleKeyboard = async (raw: RawScreen): Promise<RawScreen> => {
    if (!raw.keyboardShown) return raw;
    if (!available.has('HIDE_KEYBOARD')) return raw;
    const hidden = await device.hideKeyboard();
    if (!hidden.ok) return raw;
    const after = await device.screen();
    warnings.push(...after.warnings);
    return after;
  };

  /**
   * Read a screen's controls, scrolling every container until it converges or
   * the scroll budget bites.
   *
   * MERGED INTO ONE SCREEN, never minted as a second: scrolling is not a state
   * change, and a crawl that thought it was would report a long list as a dozen
   * screens and claim that much more surface than exists.
   */
  const readControlsWithScroll = async (
    raw: RawScreen,
    signature: MobileScreenSignature,
  ): Promise<RawViewNode[]> => {
    const byIdentity = new Map<string, RawViewNode>();
    const absorb = (nodes: readonly RawViewNode[]): number => {
      let added = 0;
      for (const node of nodes) {
        const identity = viewNodeIdentity(node);
        if (byIdentity.has(identity)) continue;
        byIdentity.set(identity, node);
        added += 1;
      }
      return added;
    };
    absorb(raw.nodes);

    const scrollable = raw.nodes.some((node) => node.scrollable);
    if (!scrollable) return [...byIdentity.values()];
    if (!available.has('SWIPE')) {
      stats.containersNotScrolledToEnd += 1;
      return [...byIdentity.values()];
    }

    let swipes = 0;
    let converged = false;
    while (swipes < scrollRevealBudget) {
      if (outOfTime()) break;
      const swiped = await device.swipe({ ref: null, direction: 'UP' });
      swipes += 1;
      if (!swiped.ok) break;
      const after = await device.screen();
      warnings.push(...after.warnings);
      const added = absorb(after.nodes);
      if (added === 0) {
        converged = true;
        break;
      }
    }
    if (!converged) {
      stats.containersNotScrolledToEnd += 1;
      ledger.budget({
        budget: 'SCROLL_REVEAL',
        limit: scrollRevealBudget,
        /*
         * ZERO WITH unknownRemainder: TRUE, and the pair is the honest answer.
         * The last swipe was still revealing controls, so more exist; a scroll
         * container does not publish its length, so the number is UNKNOWN.
         * Writing a made-up count here would be inventing a measurement, and
         * writing a bare 0 would read as "the budget cost nothing".
         */
        discarded: 0,
        unknownRemainder: true,
        scope: signature.route,
        reason:
          `the scroll limit of ${scrollRevealBudget} swipe(s) stopped ${signature.route} ` +
          `before its container reached the end; the last swipe was still revealing ` +
          `controls, so an UNKNOWN number of further controls below the fold were never read`,
      });
    }
    return [...byIdentity.values()];
  };

  /** Walk a replay path and report whether it landed where it claims. */
  const walkReplay = async (
    path: MobileReplayPath,
    expected: string,
  ): Promise<MobileReplayPath> => {
    stats.replays += 1;
    const relaunched = await device.launch();
    if (!relaunched.ok) {
      stats.replayFailures += 1;
      return { ...path, verified: false, divergedTo: null };
    }
    for (const step of path.steps) {
      if (step.kind === 'LAUNCH') continue;
      if (step.kind === 'BACK') {
        await device.back();
        continue;
      }
      if (step.kind === 'SWIPE') {
        await device.swipe({ ref: null, direction: 'UP' });
        continue;
      }
      const current = await device.screen();
      warnings.push(...current.warnings);
      const match = current.nodes.find((node) => viewNodeIdentity(node) === step.target);
      if (match === undefined) {
        stats.replayFailures += 1;
        return { ...path, verified: false, divergedTo: null };
      }
      if (step.kind === 'TYPE') await device.type(match.ref, step.value ?? '');
      else await device.tap(match.ref);
    }
    const landedRaw = await settleKeyboard(await device.screen());
    warnings.push(...landedRaw.warnings);
    const landed = screenSignatureOf(landedRaw, app);
    if (landed.id === expected) return { ...path, verified: true, divergedTo: null };
    stats.replayFailures += 1;
    return { ...path, verified: false, divergedTo: landed.id };
  };

  /** Record a screen, or return the record we already hold for it. */
  const recordScreen = (input: {
    raw: RawScreen;
    signature: MobileScreenSignature;
    replay: MobileReplayPath;
    depth: number;
    parentScreenId: string | null;
    expanded: boolean;
    expandedWhy: string | null;
  }): ScreenRecord => {
    const existing = known.get(input.signature.id);
    if (existing !== undefined) return existing;

    const nodeId = `mobile:${input.signature.id}`;
    if (input.signature.basis === 'STRUCTURAL') stats.screensIdentifiedStructurally += 1;

    const node: MobileScreenNode = {
      id: nodeId,
      route: input.signature.route,
      url: input.signature.url,
      title: collapse(input.raw.title ?? '') || (input.signature.anchor ?? input.signature.route),
      /*
       * The marker digest, which is exactly `FlowNode.stateKey`'s job:
       * "distinguishes states that share a route". A dialog over a screen and
       * the screen beneath it share an anchor and differ here.
       */
      stateKey: input.signature.digest,
      /*
       * EMPTY, and it is the same hardcoded empty the web crawl writes:
       * `authProfile.findFirst(orderBy createdAt asc)` picks ONE identity for
       * the whole crawl and `requiresRoles` has no writer anywhere. Writing a
       * guess here would give authorisation coverage a fabricated denominator.
       */
      requiresRoles: [],
      /*
       * NOT A MEASUREMENT. `FlowNode.behindAuth` is a required boolean with no
       * null available, so `false` is the only writable value; the honest
       * answer is `behindAuthMeasured: null` below. Both are set here so a
       * reader of either can find the other.
       */
      behindAuth: false,
      /*
       * EMPTY on purpose. A `FormModel`'s locators are web `Selector`s, and a
       * native field's locator is a `MobileSelector`; filing one as the other
       * would hand the Generator a Playwright locator for a native control.
       * The real fields are `fields` below.
       */
      forms: [],
      /*
       * Same reason. `FlowNode.affordances` carries a web `Selector`; the real
       * controls, with their native locators, are `controls` below. This mirrors
       * `exploreInteractions`, which also leaves the field empty and carries
       * its sightings separately.
       */
      affordances: [],
      screenshotKey: null,
      /*
       * NOT A MEASUREMENT. No accessibility scan ran in this pass, and
       * `FlowNode`'s field is a required `number` so there is nothing else to
       * write. It is inherited from the model rather than introduced here — see
       * the identical note in `crawl/interact.ts` — and the fix, making it
       * `number | null`, is in this module's report.
       */
      a11yViolationCount: 0,
      /*
       * NULL, deliberately, and the consequence is stated rather than hidden: a
       * native screen has NO HTTP STATUS, `NODE_STATUS_CLASSES` has no
       * not-applicable member, and `shouldGenerateAgainst` returns false for a
       * null status. So the shared predicate refuses to write a happy-path test
       * against every mobile screen. That is the conservative direction and it
       * is still wrong; `mobileScreenIsGeneratable` below is the correct local
       * predicate, and the shared fix is in this module's report. Writing a
       * synthetic 200 here would be the alternative, and it would be a status
       * we invented.
       */
      status: null,
      signature: input.signature,
      replay: input.replay,
      interactionDepth: input.depth,
      parentScreenId: input.parentScreenId,
      device: deviceInfo,
      controls: [],
      fields: null,
      expanded: input.expanded,
      expandedWhy: input.expandedWhy,
      behindAuthMeasured: null,
    };
    screens.push(node);
    stats.screensVisited += 1;

    const record: ScreenRecord = {
      signature: input.signature,
      nodeId,
      replay: input.replay,
      depth: input.depth,
      pending: input.expanded,
    };
    known.set(input.signature.id, record);
    unvisited.delete(input.signature.id);
    return record;
  };

  const noteExternal = (appId: string, fromRoute: string | null): void => {
    const existing = externalsByApp.get(appId);
    if (existing !== undefined) {
      existing.occurrences += 1;
      return;
    }
    externalsByApp.set(appId, { appId, fromRoute, occurrences: 1 });
  };

  // ── The entry screen ──────────────────────────────────────────────────────
  const entryRaw = await settleKeyboard(first);
  const entrySignature = screenSignatureOf(entryRaw, app);
  const entryReplay: MobileReplayPath = {
    steps: [{ kind: 'LAUNCH', target: app.appId, label: `launch ${app.appId}`, selector: null }],
    verified: true,
    divergedTo: null,
    strategy: 'RESET',
  };
  const entryRecord = recordScreen({
    raw: entryRaw,
    signature: entrySignature,
    replay: entryReplay,
    depth: 0,
    parentScreenId: null,
    expanded: EXPANDED_SCREEN_CLASSES.includes(entrySignature.class),
    expandedWhy: EXPANDED_SCREEN_CLASSES.includes(entrySignature.class)
      ? null
      : `${MOBILE_SCREEN_CLASS_LABELS[entrySignature.class]}; recorded and not expanded`,
  });
  if (entryRecord.pending) queue.push(entryRecord);

  // ── The orientation probe ─────────────────────────────────────────────────
  const orientationProbe = await probeOrientation({
    device,
    available,
    app,
    wanted: options.probeOrientation !== false,
    before: entrySignature,
    ledger,
    warnings,
  });

  // ── The frontier walk ─────────────────────────────────────────────────────
  while (queue.length > 0) {
    const record = queue.shift();
    if (record === undefined) break;
    if (!record.pending) continue;
    record.pending = false;

    if (outOfTime()) {
      const discarded = queue.length + 1;
      for (const pending of [record, ...queue]) unvisited.add(pending.signature.id);
      ledger.cap(
        'WALL_CLOCK',
        wallClockMillis,
        discarded,
        null,
        `the wall-clock limit of ${wallClockMillis}ms expired with ${discarded} screen(s) still queued`,
      );
      break;
    }

    progress(`mobile: ${record.signature.route}`);

    // Replay to this screen, unless it is the one we are already on.
    const currentNow = screenSignatureOf(await device.screen(), app);
    if (currentNow.id !== record.signature.id) {
      const walked = await walkReplay(record.replay, record.signature.id);
      patchReplay(screens, record.nodeId, walked);
      if (!walked.verified) {
        markUnexpanded(
          screens,
          record.nodeId,
          `its replay path did not reproduce the screen (landed on ${walked.divergedTo ?? 'nothing readable'}), so nothing behind it could be read`,
        );
        continue;
      }
    }

    const raw = await settleKeyboard(await device.screen());
    warnings.push(...raw.warnings);
    const nodes = await readControlsWithScroll(raw, record.signature);

    // ── Classify every control. The real control denominator. ──────────────
    const candidates: MobileCandidate[] = [];
    let readCount = 0;
    for (const node of nodes) {
      if (readCount >= controlsPerScreen) {
        const dropped = nodes.length - readCount;
        ledger.cap(
          'AFFORDANCES_PER_PAGE',
          controlsPerScreen,
          dropped,
          record.signature.route,
          `the per-screen control limit of ${controlsPerScreen} stopped ${record.signature.route} and discarded ${dropped} further control(s)`,
        );
        break;
      }
      if (!node.displayed) {
        stats.hiddenControls += 1;
        continue;
      }
      const kind = classifyMobileControl(node);
      if (kind === null) continue;
      readCount += 1;
      stats.controlsSeen += 1;

      const label = mobileAccessibleName(node);
      const role = canonicalRole(node.className);
      const identity = controlIdentity({
        route: record.signature.route,
        landmark: node.container,
        role,
        label,
        nth: node.index,
      });
      const { selector, confidence } = mobileSelectorFor(node);

      if (!node.enabled) stats.disabledControls += 1;

      /*
       * THE POLICY, from `refusalFor` and not from a local copy. The native
       * kind is mapped to the interaction kind whose MEANING matches, and the
       * screen route is passed as the path so that `excludeGlobs` and
       * `destructiveAllowGlobs` govern a native tap exactly as they govern a
       * web click.
       */
      const exercise = refusalFor(
        {
          kind: MOBILE_CONTROL_AS_INTERACTION_KIND[kind],
          label,
          path: record.signature.route,
        },
        policy,
        record.signature.route,
      );

      const sighting: MobileControlSighting = {
        screenId: record.signature.id,
        route: record.signature.route,
        identity,
        label,
        kind,
        affordanceKind: affordanceKindFor(MOBILE_CONTROL_AS_INTERACTION_KIND[kind]),
        selector,
        selectorConfidence: confidence,
        exercise,
        exercised: false,
        disabled: !node.enabled,
        leadsTo: null,
      };
      controls.push(sighting);
      attachControl(screens, record.nodeId, sighting);

      if (exercise !== null) {
        refusals.push({
          screenId: record.signature.id,
          route: record.signature.route,
          identity,
          label,
          kind,
          exercise,
          surfaceItemKey: surfaceKey('COMPONENT_STATE', identity),
        });
        continue;
      }
      if (MOBILE_FIELD_KINDS.includes(kind)) continue;
      if (kind === 'SCROLL_CONTAINER') continue;
      if (!node.enabled) continue;

      candidates.push({
        ref: node.ref,
        kind,
        label,
        identity,
        selector,
        selectorConfidence: confidence,
        score: rankMobileCandidate(node, kind, seenControlIdentities, identity),
      });
    }

    const group = fieldGroupFrom({
      nodes,
      screenId: record.signature.id,
      route: record.signature.route,
      keyboardBlocked: raw.keyboardShown && !available.has('HIDE_KEYBOARD'),
      primitives: options.primitives,
    });
    if (group !== null) {
      fieldGroups.push(group);
      attachFields(screens, record.nodeId, group);
    }

    // ── Drive the candidates, best first ───────────────────────────────────
    candidates.sort(
      (left, right) => right.score - left.score || left.label.localeCompare(right.label),
    );

    let tapsHere = 0;
    for (const candidate of candidates) {
      if (tapsHere >= perScreenTapBudget) {
        const dropped = candidates.length - candidates.indexOf(candidate);
        ledger.budget({
          budget: 'PER_SCREEN_INTERACTION',
          limit: perScreenTapBudget,
          discarded: dropped,
          unknownRemainder: false,
          scope: record.signature.route,
          reason:
            `the per-screen tap budget of ${perScreenTapBudget} stopped ` +
            `${record.signature.route} and left ${dropped} control(s) undriven`,
        });
        for (let index = candidates.indexOf(candidate); index < candidates.length; index += 1) {
          unvisited.add(`undriven:${candidates[index]?.identity ?? index}`);
        }
        break;
      }
      if (tapsSpent >= tapBudget) {
        const dropped = candidates.length - candidates.indexOf(candidate);
        ledger.cap(
          'PAGE_BUDGET',
          tapBudget,
          dropped,
          null,
          `the overall tap budget of ${tapBudget} was spent and left ${dropped} control(s) undriven on ${record.signature.route}`,
        );
        for (let index = candidates.indexOf(candidate); index < candidates.length; index += 1) {
          unvisited.add(`undriven:${candidates[index]?.identity ?? index}`);
        }
        break;
      }
      if (screens.length >= maxScreens) {
        const dropped = candidates.length - candidates.indexOf(candidate);
        ledger.cap(
          'PAGE_BUDGET',
          maxScreens,
          dropped,
          null,
          `the screen budget of ${maxScreens} was reached and left ${dropped} control(s) undriven on ${record.signature.route}`,
        );
        for (let index = candidates.indexOf(candidate); index < candidates.length; index += 1) {
          unvisited.add(`undriven:${candidates[index]?.identity ?? index}`);
        }
        break;
      }
      if (record.depth + 1 > maxDepth) {
        const dropped = candidates.length - candidates.indexOf(candidate);
        ledger.cap(
          'DEPTH',
          maxDepth,
          dropped,
          record.signature.route,
          `the depth limit of ${maxDepth} tap(s) stopped ${record.signature.route} and left ${dropped} control(s) undriven`,
        );
        for (let index = candidates.indexOf(candidate); index < candidates.length; index += 1) {
          beyondDepth.add(`beyond:${candidates[index]?.identity ?? index}`);
        }
        break;
      }
      if (outOfTime()) {
        const dropped = candidates.length - candidates.indexOf(candidate);
        ledger.cap(
          'WALL_CLOCK',
          wallClockMillis,
          dropped,
          record.signature.route,
          `the wall-clock limit of ${wallClockMillis}ms expired and left ${dropped} control(s) undriven on ${record.signature.route}`,
        );
        for (let index = candidates.indexOf(candidate); index < candidates.length; index += 1) {
          unvisited.add(`undriven:${candidates[index]?.identity ?? index}`);
        }
        break;
      }

      // Re-resolve the ref: the scroll loop above invalidated the first read.
      const live = await device.screen();
      warnings.push(...live.warnings);
      const target = live.nodes.find(
        (node) => viewNodeIdentity(node) === identityTargetOf(candidate),
      );
      if (target === undefined) {
        markExercised(controls, screens, candidate.identity, record.signature.id, record.nodeId, {
          state: 'UNEXERCISABLE',
          reason: 'CAPABILITY_UNAVAILABLE',
          detail: `"${candidate.label}" was not on screen when the crawl returned to ${record.signature.route}, so it could not be driven.`,
        });
        continue;
      }

      const tapped = await device.tap(target.ref);
      tapsSpent += 1;
      tapsHere += 1;
      stats.taps += 1;
      seenControlIdentities.add(candidate.identity);
      if (!tapped.ok) {
        markExercised(controls, screens, candidate.identity, record.signature.id, record.nodeId, {
          state: 'UNEXERCISABLE',
          reason: 'CAPABILITY_UNAVAILABLE',
          detail: `"${candidate.label}" could not be tapped: ${tapped.error ?? 'the driver gave no reason'}.`,
        });
        continue;
      }

      const afterRaw = await device.screen();
      warnings.push(...afterRaw.warnings);
      const after = screenSignatureOf(afterRaw, app);

      if (after.id === record.signature.id) {
        stats.noOpTaps += 1;
        markLeadsTo(
          controls,
          screens,
          candidate.identity,
          record.signature.id,
          record.nodeId,
          null,
          true,
        );
        continue;
      }

      const nextReplay: MobileReplayPath = {
        steps: [
          ...record.replay.steps,
          {
            kind: 'TAP',
            target: identityTargetOf(candidate),
            label: candidate.label,
            selector: candidate.selector,
          },
        ],
        verified: false,
        divergedTo: null,
        strategy: 'REPLAY',
      };

      if (after.class === 'OTHER_APP') {
        stats.appExits += 1;
        noteExternal(collapse(afterRaw.packageName ?? '') || 'unknown', record.signature.route);
        edges.push(
          mobileEdge({
            from: record.nodeId,
            to: null,
            kind: 'APP_EXIT',
            action: `tap "${candidate.label}" leaves ${app.appId}`,
            candidate,
            replay: nextReplay,
          }),
        );
        markLeadsTo(
          controls,
          screens,
          candidate.identity,
          record.signature.id,
          record.nodeId,
          null,
          true,
        );
        await device.launch();
        continue;
      }

      const expandable = EXPANDED_SCREEN_CLASSES.includes(after.class);
      if (!expandable) stats.osStatesMet += 1;

      const target2 = recordScreen({
        raw: afterRaw,
        signature: after,
        replay: { ...nextReplay, verified: true },
        depth: record.depth + 1,
        parentScreenId: record.signature.id,
        expanded: expandable,
        expandedWhy: expandable
          ? null
          : `${MOBILE_SCREEN_CLASS_LABELS[after.class]}; recorded and never answered, so the surface behind it is UNKNOWN rather than absent`,
      });
      edges.push(
        mobileEdge({
          from: record.nodeId,
          to: target2.nodeId,
          kind: expandable ? 'TAP' : 'OS_DIALOG',
          action: `tap "${candidate.label}"`,
          candidate,
          replay: { ...nextReplay, verified: true },
        }),
      );
      markLeadsTo(
        controls,
        screens,
        candidate.identity,
        record.signature.id,
        record.nodeId,
        after.id,
        true,
      );
      if (target2.pending && !queue.includes(target2)) queue.push(target2);

      /*
       * Recover by REPLAY, never by BACK. An OS dialog is the case that proves
       * it: back may dismiss it on Android and does nothing over an iOS system
       * alert, and either way the state we were in is not restored by
       * un-pressing the button that left it.
       */
      const back = await walkReplay(record.replay, record.signature.id);
      patchReplay(screens, record.nodeId, back);
      if (!back.verified) {
        markUnexpanded(
          screens,
          record.nodeId,
          `the crawl could not return to it after driving "${candidate.label}", so its remaining controls were not driven`,
        );
        for (let index = candidates.indexOf(candidate) + 1; index < candidates.length; index += 1) {
          unvisited.add(`undriven:${candidates[index]?.identity ?? index}`);
        }
        break;
      }
    }

    // ── The back edge, MEASURED and not assumed ────────────────────────────
    if (available.has('BACK') && record.depth > 0) {
      if (backProbesSpent >= backProbeBudget) {
        ledger.budget({
          budget: 'BACK_PROBE',
          limit: backProbeBudget,
          discarded: 1,
          unknownRemainder: false,
          scope: record.signature.route,
          reason:
            `the back-probe budget of ${backProbeBudget} was spent, so whether ` +
            `${record.signature.route} has a way back is UNKNOWN rather than "none"`,
        });
      } else {
        backProbesSpent += 1;
        const pressed = await device.back();
        const landedRaw = await device.screen();
        warnings.push(...landedRaw.warnings);
        const landed = screenSignatureOf(landedRaw, app);
        if (landed.class === 'OTHER_APP') {
          stats.appExits += 1;
          stats.backEdges = (stats.backEdges ?? 0) + 1;
          edges.push({
            id: `mobile-back:${record.nodeId}`,
            from: record.nodeId,
            to: record.nodeId,
            action: 'press back, which leaves the app',
            selector: null,
            controlIdentity: null,
            kind: 'APP_EXIT',
            backMechanism: pressed.mechanism,
            replay: record.replay,
            mobileSelector: null,
          });
          await device.launch();
        } else if (landed.id !== record.signature.id) {
          stats.backEdges = (stats.backEdges ?? 0) + 1;
          const landedRecord = known.get(landed.id);
          edges.push({
            id: `mobile-back:${record.nodeId}`,
            from: record.nodeId,
            to: landedRecord?.nodeId ?? `mobile:${landed.id}`,
            action: 'press back',
            selector: null,
            controlIdentity: null,
            kind: 'BACK',
            backMechanism: pressed.mechanism,
            replay: record.replay,
            mobileSelector: null,
          });
          if (landedRecord === undefined) unvisited.add(landed.id);
        }
      }
    }
  }

  // ── The frontier, and the lower bound that replaces "stopped early" ──────
  const frontier: Frontier = {
    unvisitedQueued: unvisited.size,
    beyondDepth: beyondDepth.size,
    /*
     * Every refusal is KNOWN BY NAME in `refusals`, so it is not part of "more
     * existed" — the same rule `Frontier` already states for a refused URL.
     */
    excluded: refusals.length,
    offOrigin: [...externalsByApp.values()].reduce(
      (running, item) => running + item.occurrences,
      0,
    ),
    unreachable: stats.replayFailures,
    atLeastMoreUrls: 0,
    sample: [...unvisited, ...beyondDepth].slice(0, sampleSize),
    sampleTruncated: unvisited.size + beyondDepth.size > sampleSize,
  };
  frontier.atLeastMoreUrls = lowerBoundMoreUrls(frontier);

  const budgets = ledger.budgetList();
  /*
   * A budget whose remainder is UNKNOWN cannot contribute a number to the
   * frontier, so it is promoted to a CAP here in order to force the outcome off
   * CONVERGED. Without this a scroll container that never reached its end would
   * report "every discovered screen was visited" — convergence over a surface
   * we trimmed, which is the one sentence `enumerationOutcome` exists to
   * prevent.
   */
  for (const bite of mobileBudgetsThatBit(budgets)) {
    if (!bite.unknownRemainder) continue;
    ledger.cap(
      'AFFORDANCES_PER_PAGE',
      bite.limit,
      0,
      bite.scope,
      `${MOBILE_BUDGET_LABELS[bite.budget]} bit on ${bite.scope ?? 'the run'} and an UNKNOWN number of controls were never read`,
    );
  }

  const decided = enumerationOutcome({
    visitedPages: stats.screensVisited,
    frontier,
    caps: ledger.capList(),
  });

  return {
    status: 'ENUMERATED',
    app,
    device: deviceInfo,
    screens,
    edges,
    controls,
    fieldGroups,
    refusals,
    externals: [...externalsByApp.values()],
    caps: ledger.capList(),
    budgets,
    frontier,
    outcome: decided.outcome,
    why: `${decided.why}; ${stats.screensVisited} screen(s) enumerated on ${deviceInfo.id} (${deviceInfo.formFactor})`,
    orientationProbe,
    unavailable,
    warnings: [...new Set(warnings)],
    stats,
  };
}

/** The identity the replay path and the re-resolution both key on. */
function identityTargetOf(candidate: MobileCandidate): string {
  /*
   * The LAST part of `controlIdentity` is the sibling index and the parts before
   * it are route/landmark/role/label. A replay has to find the element again in
   * a FRESH hierarchy read, where refs have been invalidated, and
   * `viewNodeIdentity` is the only key that survives a read — so the replay
   * target is the view identity, not the control identity. They are different
   * keys on purpose: control identity distinguishes three "Save" buttons on one
   * screen, view identity finds one element in one dump.
   */
  return candidate.selector.using === 'accessibility id'
    ? `a11y:${candidate.selector.value}`
    : candidate.selector.using === 'id'
      ? `id:${candidate.selector.value}`
      : `${roleOfKind(candidate.kind)}:${normaliseScreenText(candidate.label)}`;
}

function roleOfKind(kind: MobileControlKind): string {
  if (kind === 'LIST_ROW') return 'row';
  if (kind === 'TEXT_FIELD') return 'textfield';
  if (kind === 'SWITCH') return 'switch';
  if (kind === 'CHECKBOX') return 'checkbox';
  if (kind === 'PICKER') return 'picker';
  if (kind === 'SLIDER') return 'slider';
  if (kind === 'SCROLL_CONTAINER') return 'scroll';
  if (kind === 'TAB_BAR_ITEM') return 'tabbar';
  if (kind === 'NAV_BAR_ITEM') return 'navbar';
  return 'button';
}

function mobileEdge(input: {
  from: string;
  to: string | null;
  kind: MobileEdgeKind;
  action: string;
  candidate: MobileCandidate;
  replay: MobileReplayPath;
}): MobileScreenEdge {
  return {
    id: `mobile-edge:${input.from}->${input.to ?? 'external'}:${input.candidate.identity}`,
    from: input.from,
    /*
     * An APP_EXIT edge has no node to point at — another application is not our
     * surface and must not become a node in our graph. It points back at its
     * own source, and `kind` is what tells a reader to read it as an exit. A
     * synthetic "external" node would enter the denominator as a screen.
     */
    to: input.to ?? input.from,
    action: input.action,
    selector: null,
    controlIdentity: input.candidate.identity,
    kind: input.kind,
    backMechanism: null,
    replay: input.replay,
    mobileSelector: input.candidate.selector,
  };
}

async function probeOrientation(input: {
  device: MobileDevice;
  available: ReadonlySet<MobileEnumerationCapability>;
  app: MobileAppIdentity;
  wanted: boolean;
  before: MobileScreenSignature;
  ledger: MobileLedger;
  warnings: string[];
}): Promise<OrientationProbe> {
  if (!input.wanted) {
    return {
      ran: false,
      stable: null,
      before: null,
      after: null,
      why: 'the caller switched the orientation probe off, so invariance is UNPROVEN in this run',
    };
  }
  if (!input.available.has('ORIENTATION')) {
    input.ledger.budget({
      budget: 'ORIENTATION_PROBE',
      limit: 1,
      discarded: 0,
      unknownRemainder: false,
      scope: null,
      reason:
        'the driver cannot rotate the device, so whether screen identity survives a rotation is UNPROVEN here',
    });
    return {
      ran: false,
      stable: null,
      before: null,
      after: null,
      why: MOBILE_CAPABILITY_COST.ORIENTATION,
    };
  }
  const rotated = await input.device.rotate('LANDSCAPE');
  if (!rotated.ok) {
    return {
      ran: false,
      stable: null,
      before: input.before.id,
      after: null,
      why: `the rotation failed (${rotated.error ?? 'no reason given'}), so invariance is UNPROVEN in this run`,
    };
  }
  const after = await input.device.screen();
  input.warnings.push(...after.warnings);
  const afterSignature = screenSignatureOf(after, input.app);
  await input.device.rotate('PORTRAIT');
  const stable = afterSignature.id === input.before.id;
  return {
    ran: true,
    stable,
    before: input.before.id,
    after: afterSignature.id,
    why: stable
      ? 'the entry screen kept its identity across a rotation'
      : `the entry screen changed identity across a rotation (${input.before.id} → ${afterSignature.id}), so screens on this app may be counted twice per orientation`,
  };
}

function unavailableResult(input: {
  reason: MobileUnavailableReason;
  detail: string;
  app: MobileAppIdentity;
  device: MobileDeviceDescriptor | null;
  unavailable: MobileCapabilityGap[];
}): MobileEnumerationUnavailable {
  return {
    status: 'UNAVAILABLE',
    reason: input.reason,
    remedy: MOBILE_UNAVAILABLE_REMEDIES[input.reason],
    detail: input.detail,
    app: input.app,
    device: input.device,
    unavailable: input.unavailable,
    outcome: 'FAILED',
    why: `mobile enumeration did not run: ${input.detail}`,
  };
}

function patchReplay(screens: MobileScreenNode[], nodeId: string, replay: MobileReplayPath): void {
  const node = screens.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return;
  node.replay = replay;
}

function markUnexpanded(screens: MobileScreenNode[], nodeId: string, why: string): void {
  const node = screens.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return;
  node.expanded = false;
  node.expandedWhy = why;
}

function attachControl(
  screens: MobileScreenNode[],
  nodeId: string,
  sighting: MobileControlSighting,
): void {
  const node = screens.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return;
  node.controls.push(sighting);
}

function attachFields(screens: MobileScreenNode[], nodeId: string, group: MobileFieldGroup): void {
  const node = screens.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return;
  node.fields = group;
}

/*
 * BOTH MARKERS KEY ON screenId AS WELL AS identity, and the second part is the
 * bug it prevents. `controlIdentity` is route-scoped, and two STATES share one
 * route — a screen and the same screen with a dialog over it, a tab bar with a
 * different tab live. Marking by identity alone would record one tap's result
 * against the twin control on the sibling state, so a control that was never
 * driven would read as driven and its `leadsTo` would name a screen it does not
 * reach.
 */
function markExercised(
  controls: MobileControlSighting[],
  screens: MobileScreenNode[],
  identity: string,
  screenId: string,
  nodeId: string,
  exercise: SurfaceExercise,
): void {
  for (const list of [controls, screens.find((node) => node.id === nodeId)?.controls ?? []]) {
    for (const sighting of list) {
      if (sighting.identity !== identity || sighting.screenId !== screenId) continue;
      sighting.exercise = exercise;
    }
  }
}

function markLeadsTo(
  controls: MobileControlSighting[],
  screens: MobileScreenNode[],
  identity: string,
  screenId: string,
  nodeId: string,
  leadsTo: string | null,
  exercised: boolean,
): void {
  for (const list of [controls, screens.find((node) => node.id === nodeId)?.controls ?? []]) {
    for (const sighting of list) {
      if (sighting.identity !== identity || sighting.screenId !== screenId) continue;
      sighting.leadsTo = leadsTo;
      sighting.exercised = exercised;
    }
  }
}

/**
 * The fields of one screen, with the semantic the synthetic generator needs.
 *
 * `semanticFor` is the INJECTED one, so the mobile axis and the web axis
 * classify an email field the same way. A field whose keyboard we cannot
 * dismiss is recorded with `UNEXERCISABLE / CAPABILITY_UNAVAILABLE` rather than
 * dropped: the field exists, and we could not type into it here.
 */
export function fieldGroupFrom(input: {
  nodes: readonly RawViewNode[];
  screenId: string;
  route: string;
  keyboardBlocked: boolean;
  primitives: MobilePrimitives;
}): MobileFieldGroup | null {
  const fields: MobileField[] = [];
  let submit: MobileFieldGroup['submit'] = null;

  for (const node of input.nodes) {
    if (!node.displayed) continue;
    const kind = classifyMobileControl(node);
    if (kind === null) continue;

    if (!MOBILE_FIELD_KINDS.includes(kind)) {
      if (submit === null && kind === 'BUTTON' && SUBMIT_TEXT.test(mobileAccessibleName(node))) {
        const label = mobileAccessibleName(node);
        submit = {
          identity: viewNodeIdentity(node),
          label,
          selector: mobileSelectorFor(node).selector,
        };
      }
      continue;
    }

    const label = mobileAccessibleName(node);
    const { selector, confidence } = mobileSelectorFor(node);
    fields.push({
      identity: viewNodeIdentity(node),
      label,
      kind,
      selector,
      selectorConfidence: confidence,
      /*
       * The platform's own `secure` flag beats every heuristic, so a secure
       * entry is classified `password` without the label being consulted —
       * and its VALUE is never read, which is why `node.value` is not passed.
       */
      semantic: node.password
        ? 'password'
        : input.primitives.semanticFor(
            collapse(node.resourceId ?? ''),
            canonicalRole(node.className),
            label,
            null,
          ),
      secure: node.password,
      /*
       * A native field carries no `required` attribute. FALSE is what the
       * hierarchy supports and it is not a claim that the field is optional —
       * `MobileField` has no third state because `FormField.required` has none
       * either, and forking the shape here would make the two incomparable.
       */
      required: false,
      exercise: input.keyboardBlocked
        ? {
            state: 'UNEXERCISABLE',
            reason: 'CAPABILITY_UNAVAILABLE',
            detail: `the soft keyboard is up on ${input.route} and this driver cannot dismiss it, so "${label}" was recorded and not typed into.`,
          }
        : null,
    });
  }

  if (fields.length === 0) return null;
  return { screenId: input.screenId, route: input.route, fields, submit };
}

const SUBMIT_TEXT =
  /\b(submit|save|continue|sign in|log in|register|send|confirm|apply|next|done)\b/i;

/**
 * Whether a generator may write a happy-path test against this mobile screen.
 *
 * The local predicate, and it exists because the shared one cannot answer. A
 * native screen has no HTTP status, `NODE_STATUS_CLASSES` has no
 * not-applicable member, and `shouldGenerateAgainst` therefore returns FALSE
 * for every screen this module produces — see the `status: null` note in
 * `recordScreen`. That is conservative in the right direction and still wrong,
 * so this is what a mobile generator asks instead:
 *
 *   • the screen is the APP'S, not an OS dialog, a sheet or another app;
 *   • its replay path was VERIFIED, so there is a path a test can walk;
 *   • it is not an unexpanded branch we never read.
 *
 * It deliberately does NOT require ANCHORED identity. A structurally-identified
 * screen is a real screen a real test can reach; the caveat belongs on the
 * COUNT, which `stats.screensIdentifiedStructurally` carries.
 */
export function mobileScreenIsGeneratable(node: MobileScreenNode): boolean {
  if (node.signature.class !== 'APP') return false;
  if (!node.replay.verified) return false;
  return node.expanded;
}

// ─── The two doors into the reconciled denominator ───────────────────────────

/**
 * The declarer a mobile enumeration counts as.
 *
 * CRAWL, and it is not a near-miss: `OBSERVED_SOURCES` is about whether the
 * thing was watched ANSWERING, and a screen whose hierarchy we dumped answered.
 * A device is a stranger browser.
 */
export const MOBILE_SURFACE_SOURCE: SurfaceSource = 'CRAWL';

export interface MobileSurfaceItemOptions {
  environmentId: string;
  /** Set to include screens the crawl recorded and did not expand. Default true. */
  includeUnexpanded?: boolean;
}

/**
 * The WRITE path: mobile screens as `SurfaceItem`s for the one reconciled
 * inventory.
 *
 * Returns an EMPTY ARRAY for an UNAVAILABLE result, which is correct and is why
 * the union exists: an empty item list from an UNAVAILABLE run contributes
 * nothing to the denominator, where a list of zero screens from a "successful"
 * run would contribute a complete measurement of no surface. The caller must
 * read `status` and surface the remedy; this function cannot do it for them,
 * and returning fabricated items would be worse.
 *
 * An unexpanded screen IS an item. It exists — we stood on it — and what we do
 * not know is what is behind it. Dropping it would be the move that raises the
 * percentage.
 *
 * ONE ITEM PER ROUTE, NOT PER STATE, and the collapse is DISCLOSED rather than
 * silent. Two states of one Android activity — a tab bar on Orders and the same
 * bar on Account — share a route, exactly as two states of one URL share a
 * route in the web FlowMap. So `meta.stateCount` carries how many states that
 * route had and `meta.states` names them, because a route counted once when it
 * holds four distinct screens is a smaller denominator than the application
 * has, and a reader has to be able to see that rather than infer it.
 */
export function mobileScreenSurfaceItems(
  result: MobileEnumerationResult,
  options: MobileSurfaceItemOptions,
): SurfaceItem[] {
  if (result.status === 'UNAVAILABLE') return [];
  const includeUnexpanded = options.includeUnexpanded !== false;
  const items: SurfaceItem[] = [];
  const seen = new Set<string>();

  const admitted = result.screens.filter((screen) => includeUnexpanded || screen.expanded);
  /** Every state of each route, so the collapse below can be disclosed. */
  const statesByRoute = new Map<string, string[]>();
  for (const screen of admitted) {
    const states = statesByRoute.get(screen.route) ?? [];
    states.push(screen.stateKey);
    statesByRoute.set(screen.route, states);
  }

  for (const screen of admitted) {
    const key = surfaceKey('ROUTE', screen.route);
    if (seen.has(key)) continue;
    seen.add(key);
    const states = statesByRoute.get(screen.route) ?? [screen.stateKey];
    items.push({
      kind: 'ROUTE',
      key,
      label: `${result.app.platform} ${screen.title}`,
      /*
       * NULL, not a guessed source path. A screen was read off a device, and
       * the activity class name is not a repo-relative file — writing one would
       * make an editor link that opens nothing.
       */
      file: null,
      line: null,
      /*
       * Derived, never set by hand. An item whose `origin` and `sources`
       * disagree shows one of them on screen and the other in the API.
       */
      origin: 'CRAWL_ONLY',
      evidence: `${screen.signature.why}; read on ${screen.device.id} (${screen.device.formFactor})`,
      detector: 'mobile-crawler',
      sources: [MOBILE_SURFACE_SOURCE],
      environmentId: options.environmentId,
      /*
       * EXERCISABLE only when the screen is one a test can actually reach. An
       * unexpanded OS dialog is inventory and is held OUT of the coverage
       * denominator by `NON_DENOMINATOR_EXERCISABILITIES`, so recording it
       * cannot raise the percentage — which dropping it would.
       */
      exercise: screen.expanded
        ? { state: 'EXERCISABLE', detail: 'the crawl reached it and replayed the path back to it' }
        : {
            state: 'UNEXERCISABLE',
            reason: 'CAPABILITY_UNAVAILABLE',
            detail: screen.expandedWhy ?? 'the crawl recorded it and did not expand it',
          },
      meta: {
        mobile: true,
        platform: result.app.platform,
        appId: result.app.appId,
        screenClass: screen.signature.class,
        identityBasis: screen.signature.basis,
        anchor: screen.signature.anchor,
        markers: screen.signature.markers,
        formFactor: screen.device.formFactor,
        deviceId: screen.device.id,
        interactionDepth: screen.interactionDepth,
        replay: describeMobileReplay(screen.replay),
        replayVerified: screen.replay.verified,
        controlCount: screen.controls.length,
        expanded: screen.expanded,
        expandedWhy: screen.expandedWhy,
        /*
         * The collapse, named. `stateCount: 4` on one route is the report's cue
         * that this route is four screens a test would have to reach
         * separately, and the ROUTE axis has room for one of them.
         */
        stateCount: states.length,
        states,
      },
    });
  }
  return items;
}

/**
 * The READ path: this run as one source for `reconcileSurface`.
 *
 * `participation` is the field that matters and it is why this function exists
 * rather than the caller assembling the shape.
 *
 * AN UNAVAILABLE RUN IS **FAILED**, NOT NOT_CONFIGURED, and the difference is
 * the whole point. `participationIsHole` treats NOT_CONFIGURED as costing the
 * comparison nothing — correctly, because a declarer a project never set up was
 * never owed. But a caller who asked for mobile enumeration HAS a mobile app:
 * the surface exists, we were entitled to the observation, and we do not have
 * it. Filing "no emulator was attached" as NOT_CONFIGURED would erase the
 * mobile hole from the report, which is the same shape as recording a login
 * that FAILED as a crawl that found nothing behind the wall.
 *
 * A run that silently contributed zero entries would be worse still: every
 * mobile screen would read as DECLARED_BUT_NEVER_REACHED, or as nothing at all.
 */
export function mobileReconcileSource(
  result: MobileEnumerationResult,
  environmentId: string,
): ReconcileSourceInput {
  if (result.status === 'UNAVAILABLE') {
    return {
      source: MOBILE_SURFACE_SOURCE,
      participation: 'FAILED',
      detail: `mobile enumeration did not run (${result.reason}): ${result.detail}. ${result.remedy}`,
      entries: [],
      environmentId,
      caps: [],
    };
  }

  const entries: ReconcileEntry[] = [];
  const seen = new Set<string>();
  for (const screen of result.screens) {
    if (seen.has(screen.route)) continue;
    seen.add(screen.route);
    entries.push({ spelling: screen.route, method: null });
  }

  return {
    source: MOBILE_SURFACE_SOURCE,
    participation: result.outcome === 'FAILED' ? 'FAILED' : 'LOADED',
    detail:
      result.outcome === 'FAILED'
        ? `mobile enumeration failed: ${result.why}`
        : `${entries.length} mobile screen(s) from ${result.device.id} (${result.device.formFactor}); ${result.why}`,
    entries,
    environmentId,
    caps: [
      ...result.caps.map((cap) => ({
        source: MOBILE_SURFACE_SOURCE,
        cap: cap.cap,
        limit: cap.limit,
        discarded: cap.discarded,
        reason: cap.reason,
      })),
      ...mobileBudgetsThatBit(result.budgets).map((bite) => ({
        source: MOBILE_SURFACE_SOURCE,
        cap: bite.budget,
        limit: bite.limit,
        /*
         * An UNKNOWN remainder cannot be a number, so `discarded` stays 0 and
         * the sentence carries the fact. `ReconcileCap` has no
         * `unknownRemainder` field, and inventing a count to fill it would turn
         * "we do not know how many" into a measurement.
         */
        discarded: bite.discarded,
        reason: bite.unknownRemainder
          ? `${bite.reason} (the remaining count is UNKNOWN, not zero)`
          : bite.reason,
      })),
    ],
  };
}

// ─── The one thin adapter: Appium over its W3C HTTP API ──────────────────────

/**
 * The transport, INJECTED, so the adapter's translation is testable without a
 * server.
 *
 * `fetch`-shaped rather than `fetch` itself for the reason
 * `packages/runner/src/plugins/mobile.ts` gives for driving Appium directly:
 * the protocol is JSON over HTTP, so a client is a function and a session id,
 * not a dependency. Injecting it means the adapter's own decisions — which
 * endpoint, which body, how to read the answer — are unit-testable, and what is
 * left untestable is a network call with no judgement in it.
 */
export interface MobileHttpTransport {
  (request: {
    method: 'GET' | 'POST';
    /** Session-relative path, e.g. `/source`. */
    path: string;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }>;
}

export interface AppiumMobileDeviceOptions {
  transport: MobileHttpTransport;
  app: MobileAppIdentity;
  /**
   * The device, as the farm or the local server reported it. Passed in rather
   * than probed, because the W3C protocol has no portable "list devices" call
   * and a `GET /status` that answered would still not describe the handset.
   *
   * AN EMPTY ARRAY IS THE HONEST VALUE when nothing is attached, and
   * {@link enumerateMobileScreens} turns it into UNAVAILABLE rather than an
   * empty graph.
   */
  devices: MobileDeviceDescriptor[];
  /** Which capabilities this session actually has. */
  capabilities?: readonly MobileEnumerationCapability[];
}

/** Everything an Appium session can offer this module. */
export const APPIUM_CAPABILITIES: readonly MobileEnumerationCapability[] =
  MOBILE_ENUMERATION_CAPABILITIES;

/**
 * Drive a real Appium session.
 *
 * THIN BY CONSTRUCTION: every method is one or two protocol calls and a shape
 * translation, and the only non-trivial step — turning the XML page source into
 * {@link RawViewNode}s — is {@link parseViewHierarchy}, which is pure and takes
 * a recorded string. There is no decision in this function that a test cannot
 * reach.
 */
export function appiumMobileDevice(options: AppiumMobileDeviceOptions): MobileDevice {
  const transport = options.transport;
  const capabilities = options.capabilities ?? APPIUM_CAPABILITIES;

  const outcome = (result: { status: number; body: unknown }): MobileActionOutcome =>
    result.status >= 200 && result.status < 300
      ? { ok: true, error: null }
      : { ok: false, error: appiumMessage(result) };

  const resolve = async (ref: string): Promise<string | null> => {
    const found = await transport({
      method: 'POST',
      path: '/element',
      body: { using: 'xpath', value: ref },
    });
    if (found.status < 200 || found.status >= 300) return null;
    return appiumElementId(found.body);
  };

  return {
    capabilities: () => capabilities,
    devices: async () => options.devices,
    launch: async () =>
      outcome(
        await transport({
          method: 'POST',
          path: '/appium/device/activate_app',
          body: { appId: options.app.appId, bundleId: options.app.appId },
        }),
      ),
    screen: async () => {
      const source = await transport({ method: 'GET', path: '/source' });
      const xml =
        typeof appiumValue(source.body) === 'string' ? String(appiumValue(source.body)) : '';
      const parsed = parseViewHierarchy(xml, options.app.platform);
      const activity = await transport({ method: 'GET', path: '/appium/device/current_activity' });
      const pkg = await transport({ method: 'GET', path: '/appium/device/current_package' });
      const keyboard = await transport({ method: 'GET', path: '/appium/device/is_keyboard_shown' });
      const orientation = await transport({ method: 'GET', path: '/orientation' });
      return {
        activity: stringOrNull(appiumValue(activity.body)),
        /*
         * iOS has no `current_package`, and the call 404s. The app's own bundle
         * id is NOT substituted in that case, because that would make the
         * OTHER_APP check always pass and the app boundary unmeasurable —
         * `classifyScreen` reads null as "the boundary could not be checked"
         * and says so.
         */
        packageName: stringOrNull(appiumValue(pkg.body)),
        title: parsed.title,
        nodes: parsed.nodes,
        keyboardShown: appiumValue(keyboard.body) === true,
        orientation:
          appiumValue(orientation.body) === 'LANDSCAPE'
            ? 'LANDSCAPE'
            : appiumValue(orientation.body) === 'PORTRAIT'
              ? 'PORTRAIT'
              : null,
        alertText: parsed.alertText,
        warnings: parsed.warnings,
      };
    },
    tap: async (ref) => {
      const id = await resolve(ref);
      if (id === null) return { ok: false, error: 'the element was not found in a fresh read' };
      return outcome(await transport({ method: 'POST', path: `/element/${id}/click`, body: {} }));
    },
    type: async (ref, value) => {
      const id = await resolve(ref);
      if (id === null) return { ok: false, error: 'the element was not found in a fresh read' };
      await transport({ method: 'POST', path: `/element/${id}/clear`, body: {} });
      /*
       * The value is sent and is NEVER logged, NEVER returned in an error and
       * never put in a path. Enumeration types only its own literals; a real
       * credential reaches a device through the runner's vault, not through
       * this module.
       */
      return outcome(
        await transport({ method: 'POST', path: `/element/${id}/value`, body: { text: value } }),
      );
    },
    swipe: async (input) =>
      outcome(
        await transport({
          method: 'POST',
          path: '/execute/sync',
          body: {
            script: 'mobile: swipeGesture',
            args: [{ direction: input.direction.toLowerCase(), percent: 0.75 }],
          },
        }),
      ),
    back: async () => {
      const pressed = await transport({ method: 'POST', path: '/back', body: {} });
      return {
        ...outcome(pressed),
        /*
         * `POST /back` is the hardware button on Android and the navigation
         * pop on iOS. The protocol does not say which, so the mechanism is
         * derived from the PLATFORM and not guessed per call — and it is
         * `HARDWARE_BUTTON` only where a hardware button exists.
         */
        mechanism: options.app.platform === 'ANDROID' ? 'HARDWARE_BUTTON' : 'EDGE_GESTURE',
      };
    },
    hideKeyboard: async () =>
      outcome(await transport({ method: 'POST', path: '/appium/device/hide_keyboard', body: {} })),
    rotate: async (orientation) =>
      outcome(await transport({ method: 'POST', path: '/orientation', body: { orientation } })),
  };
}

/** The W3C envelope: every answer is `{ value: … }`. */
function appiumValue(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return null;
  return (body as { value?: unknown }).value ?? null;
}

function appiumElementId(body: unknown): string | null {
  const value = appiumValue(body);
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!key.startsWith('element-') && key !== 'ELEMENT') continue;
    const id = record[key];
    if (typeof id === 'string' && id !== '') return id;
  }
  return null;
}

function appiumMessage(result: { status: number; body: unknown }): string {
  const value = appiumValue(result.body);
  if (typeof value === 'object' && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return `HTTP ${result.status}: ${message}`;
  }
  return `HTTP ${result.status}`;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// ─── The hierarchy parser: pure, so a recorded dump is a complete fixture ────

/**
 * Turn an Appium page source into {@link RawViewNode}s.
 *
 * PURE, and that is the point of the whole file's shape: this is the one part
 * of the adapter with real judgement in it, and a recorded Android or iOS
 * hierarchy is a complete test fixture for it. No device, no emulator, no
 * server.
 *
 * WHY A HAND-WRITTEN SCANNER AND NOT AN XML LIBRARY. This workspace has no XML
 * parser, both platforms' dumps are attribute-only element trees, and adding a
 * dependency for 80 lines of tag scanning is a cost paid by every consumer of
 * this package. The scanner respects quotes when it looks for a tag's end,
 * which is the one thing a naive `indexOf('>')` gets wrong — an
 * `accessibility id` containing `>` is common and would otherwise truncate the
 * element and silently drop every attribute after it.
 *
 * WHAT A FAILURE LOOKS LIKE: `warnings`. A dump that half-parsed is a SMALLER
 * measurement and has to say so, because the missing half would otherwise be
 * reported as a screen with fewer controls.
 */
export function parseViewHierarchy(
  xml: string,
  platform: MobilePlatform,
): { nodes: RawViewNode[]; title: string | null; alertText: string | null; warnings: string[] } {
  const nodes: RawViewNode[] = [];
  const warnings: string[] = [];
  let title: string | null = null;
  let alertText: string | null = null;

  if (xml.trim() === '') {
    return { nodes, title, alertText, warnings: ['the device returned an empty page source'] };
  }

  /** The open-element stack: each entry is a parent ref plus its child counter. */
  const stack: Array<{
    ref: string;
    tag: string;
    children: Map<string, number>;
    container: string | null;
  }> = [];
  /** Nodes whose container is `navbar`, so the title can be read after the walk. */
  const navbarText: string[] = [];
  let cursor = 0;
  let depthOverflow = false;

  while (cursor < xml.length) {
    const open = xml.indexOf('<', cursor);
    if (open === -1) break;
    // Declarations, comments and CDATA carry no elements.
    if (xml.startsWith('<?', open) || xml.startsWith('<!', open)) {
      const close = xml.indexOf('>', open);
      if (close === -1) break;
      cursor = close + 1;
      continue;
    }
    if (xml.startsWith('</', open)) {
      const close = xml.indexOf('>', open);
      if (close === -1) break;
      stack.pop();
      cursor = close + 1;
      continue;
    }

    const end = findTagEnd(xml, open);
    if (end === -1) {
      warnings.push(
        'an element was not closed, so the hierarchy was read only as far as it parsed',
      );
      break;
    }
    const inner = xml.slice(open + 1, end);
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const tag = space === -1 ? body : body.slice(0, space);
    const attributes =
      space === -1 ? new Map<string, string>() : parseAttributes(body.slice(space));

    const parent = stack[stack.length - 1] ?? null;
    const className = attributes.get('class') ?? attributes.get('type') ?? tag;
    const role = canonicalRole(className);

    /*
     * The sibling index, counted PER CLASS within the parent, which is what an
     * xpath predicate counts. An index counted across all siblings would
     * produce an xpath that selects a different element, and the tap would land
     * somewhere else.
     */
    /*
     * THE SEGMENT IS THE CLASS, not the tag, whenever the dump uses the generic
     * `<node>` element — because that is the xpath Appium itself resolves. A raw
     * `uiautomator dump` writes `<node class="android.widget.Button">`, while
     * Appium's `GET /source` writes `<android.widget.Button>`, and the locator
     * that works against the driver names the CLASS either way. An xpath built
     * from the literal `node` tag resolves to nothing, so every tap would come
     * back "element not found" and the crawl would report a screen with no
     * reachable controls.
     */
    const segment = tag === 'node' ? className : tag;
    const counter = parent?.children ?? new Map<string, number>();
    const nth = (counter.get(segment) ?? 0) + 1;
    counter.set(segment, nth);

    const ref = `${parent === null ? '' : parent.ref}/${segment}[${nth}]`;
    if (stack.length > 200) depthOverflow = true;

    /*
     * THE ENVELOPE IS NOT A VIEW, AND IS STILL PART OF THE XPATH. Android wraps
     * its dump in `<hierarchy rotation="0">` and Appium's iOS source in
     * `<AppiumAUT>` around an `XCUIElementTypeApplication`; none of the three is
     * a control.
     *
     * So they are skipped as NODES — counting them would put a phantom element
     * in every screen's digest and every control count, and the phantom would
     * differ between the two platforms, giving one application two different
     * node counts for a reason that is purely about XML.
     *
     * And they are kept as PATH, which is the half a naive skip gets wrong:
     * Appium resolves `/hierarchy/android.widget.FrameLayout[1]` and
     * `/AppiumAUT/XCUIElementTypeApplication[1]/XCUIElementTypeButton[1]`. Drop
     * the envelope from the path and every ref becomes a relative xpath the
     * driver cannot resolve — so every tap returns "element not found" and the
     * crawl reports screens with no reachable controls.
     */
    if (WRAPPER_TAGS.has(tag)) {
      if (!selfClosing) stack.push({ ref, tag, children: new Map(), container: null });
      cursor = end + 1;
      continue;
    }

    const container = containerOf(role, parent?.container ?? null);
    const secure =
      boolAttribute(attributes, 'password', false) || className.includes('SecureTextField');
    const node: RawViewNode = {
      ref,
      className,
      resourceId:
        attributeOrNull(attributes, 'resource-id') ?? attributeOrNull(attributes, 'name-id'),
      accessibilityId:
        attributeOrNull(attributes, 'content-desc') ?? attributeOrNull(attributes, 'name'),
      text: attributeOrNull(attributes, 'text') ?? attributeOrNull(attributes, 'label'),
      /*
       * NULL FOR A SECURE FIELD, ALWAYS, and this is a security rule and not a
       * tidiness one. iOS reports a secure field's contents in `value`, so a
       * dump taken while a sign-in form is half typed carries a partial
       * password — and a `RawViewNode` flows into a screen digest, a stored
       * FlowMap, an exported report and a cockpit. Enumeration has no use for
       * the contents of any field; it needs to know the field EXISTS.
       */
      value: secure ? null : attributeOrNull(attributes, 'value'),
      hint: attributeOrNull(attributes, 'hint') ?? attributeOrNull(attributes, 'placeholder'),
      enabled: boolAttribute(attributes, 'enabled', true),
      displayed: displayedOf(attributes, platform),
      clickable: boolAttribute(attributes, 'clickable', false),
      longClickable: boolAttribute(attributes, 'long-clickable', false),
      scrollable:
        boolAttribute(attributes, 'scrollable', false) || role === 'scroll' || role === 'list',
      focused: boolAttribute(attributes, 'focused', false),
      checkable: boolAttribute(attributes, 'checkable', false),
      checked: boolAttribute(attributes, 'checked', false),
      selected: boolAttribute(attributes, 'selected', false),
      password: secure,
      index: nth - 1,
      depth: stack.length,
      bounds: boundsOf(attributes),
      container,
    };
    nodes.push(node);

    /*
     * THE TITLE IS USUALLY A CHILD OF THE BAR, not the bar itself. An Android
     * `Toolbar` carries no text — its label is a `TextView` inside it — so a
     * check on the bar's own text finds nothing and the screen loses its
     * anchor, which on iOS (where there is no activity) demotes identity all
     * the way to STRUCTURAL. Collecting every text-bearing descendant of a
     * navbar and taking the first is what makes the anchor available at all.
     */
    if (role === 'navbar' || container === 'navbar') {
      const navTitle = collapse(node.text ?? node.accessibilityId ?? '');
      if (navTitle !== '') navbarText.push(navTitle);
    }
    if (role === 'dialog' && alertText === null) {
      const text = collapse(node.text ?? node.accessibilityId ?? '');
      if (text !== '') alertText = text;
    }

    if (!selfClosing) {
      stack.push({ ref, tag, children: new Map(), container });
    }
    cursor = end + 1;
  }

  title = navbarText[0] ?? null;
  if (depthOverflow) {
    warnings.push(
      'the hierarchy nested past 200 levels; the deepest elements were read but their container attribution may be wrong',
    );
  }
  if (nodes.length === 0) {
    warnings.push('the page source parsed to no elements');
  }
  return { nodes, title, alertText, warnings };
}

/**
 * The index of a tag's closing `>`, respecting quoted attribute values.
 *
 * A naive `indexOf('>')` truncates `content-desc="Rows > 10"` and silently
 * drops every attribute after it, which on a real Android dump means losing
 * `clickable`, `enabled` and `bounds` on exactly the rows that mention a
 * comparison.
 */
function findTagEnd(xml: string, open: number): number {
  let quote: string | null = null;
  for (let index = open + 1; index < xml.length; index += 1) {
    const char = xml[index];
    if (char === undefined) break;
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const name = match[1];
    const value = match[3] ?? match[4] ?? '';
    if (name !== undefined) attributes.set(name, decodeEntities(value));
    match = pattern.exec(source);
  }
  return attributes;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributeOrNull(attributes: Map<string, string>, name: string): string | null {
  const value = attributes.get(name);
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function boolAttribute(attributes: Map<string, string>, name: string, fallback: boolean): boolean {
  const value = attributes.get(name);
  if (value === undefined) return fallback;
  return value === 'true';
}

/**
 * Whether the element is on screen.
 *
 * iOS declares `visible`; Android does not, and its dump carries `bounds`
 * instead. A zero-area element is not on screen whatever the platform, so the
 * geometry is the fallback — and a node with neither signal is treated as
 * DISPLAYED, because an element the dump listed and said nothing about is more
 * likely present than absent, and dropping it would shrink the denominator.
 */
function displayedOf(attributes: Map<string, string>, platform: MobilePlatform): boolean {
  const visible = attributes.get('visible');
  if (visible !== undefined) return visible === 'true';
  const displayed = attributes.get('displayed');
  if (displayed !== undefined) return displayed === 'true';
  const bounds = boundsOf(attributes);
  if (bounds !== null) return bounds.width > 0 && bounds.height > 0;
  return platform === 'ANDROID' || platform === 'IOS';
}

/** `bounds="[0,0][1080,2340]"` (Android) or `x`/`y`/`width`/`height` (iOS). */
function boundsOf(
  attributes: Map<string, string>,
): { x: number; y: number; width: number; height: number } | null {
  const bounds = attributes.get('bounds');
  if (bounds !== undefined) {
    const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(bounds);
    if (match !== null) {
      const left = Number(match[1]);
      const top = Number(match[2]);
      const right = Number(match[3]);
      const bottom = Number(match[4]);
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
  }
  const x = numberAttribute(attributes, 'x');
  const y = numberAttribute(attributes, 'y');
  const width = numberAttribute(attributes, 'width');
  const height = numberAttribute(attributes, 'height');
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function numberAttribute(attributes: Map<string, string>, name: string): number | null {
  const value = attributes.get(name);
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The structural container an element sits in — the native analogue of a
 * landmark, and the third part of {@link controlIdentity}.
 *
 * INHERITED from the nearest container ancestor, which is the whole reason it
 * is computed during the walk rather than looked up afterwards: a tab's label
 * is a `TextView` three levels inside a `BottomNavigationView`, and without
 * inheritance it would be classified as a list row or as nothing.
 */
function containerOf(role: string, inherited: string | null): string | null {
  if (role === 'tabbar') return 'tabbar';
  if (role === 'navbar') return 'navbar';
  if (role === 'list') return 'list';
  if (role === 'scroll') return 'scroll';
  if (role === 'dialog') return 'dialog';
  return inherited;
}

/** The XML envelopes neither platform renders. See the note in the walk. */
const WRAPPER_TAGS = new Set(['hierarchy', 'AppiumAUT', 'XCUIElementTypeApplication']);

/** Whitespace-normalised, case PRESERVED. Folding case merges two controls. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
