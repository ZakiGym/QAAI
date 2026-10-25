/**
 * Interaction-driven enumeration — the application that is not behind a URL.
 *
 * THE DEFECT THIS FIXES, stated as a number. `crawler.ts` follows `a[href]` and
 * nothing else. Everything behind a button, a tab, an accordion, a wizard step,
 * a pagination control, a search submit, a modal trigger or a dropdown is
 * invisible to the denominator, which in a modern application is most of it. A
 * hash-routed app (Vue default, Angular `useHash`, every legacy admin panel)
 * enumerates as exactly ONE node, because `crawler.ts:356` does `target.hash =
 * ''` BEFORE dedupe. So the product's sentence — "your app has 412 routes, 25
 * are covered, here are the 387" — is today computed over the subset of the app
 * that happens to be linked.
 *
 * WHY EVERY BROWSER CAPABILITY IS INJECTED. `crawler.ts` is 629 lines with
 * almost no tests, and the reason is structural rather than cultural: its
 * decisions live inside `page.evaluate()` callbacks, so the only way to test
 * them is to run a browser. This module therefore splits in two:
 *
 *   • the decisions — what to click, is it destructive, is this the same state,
 *     how do we get back, what did a budget cost — are pure functions over
 *     plain data, and they are what the tests exercise;
 *   • the browser is an {@link InteractionSurface}: eight methods that read
 *     facts and perform one action each. Its one adapter
 *     ({@link playwrightInteractionSurface}) makes no decisions, so the part
 *     that cannot be unit-tested is the part with no judgement in it.
 *
 * A capability the surface does not have is reported UNAVAILABLE and costed.
 * Without the history hook a same-document SPA transition is unobservable, and
 * the module says so rather than reporting zero client-side navigations.
 *
 * NO MODEL IS INVOLVED, deliberately, for the reason crawler.ts states:
 * deciding what EXISTS is a graph traversal, and doing it in code makes it
 * cheap, repeatable and diffable version to version.
 *
 * THE HONESTY RULES THIS FILE IS UNDER. Every budget that bit is reported as a
 * count AND a reason, because a silently truncated enumeration makes the
 * coverage percentage go UP. A control we refused to click is recorded as a
 * refusal with the rule that refused it — never dropped, because a refused
 * surface and a surface that does not exist are opposite facts. "Converged" is
 * claimed only when the frontier is empty and nothing bit; otherwise it
 * "stopped".
 */

import { createHash } from 'node:crypto';
/*
 * TYPE-ONLY, and the only reference to playwright in this file. It exists for
 * the compile-time seam assertion beside `PageLike`; no value is imported, so
 * this module neither launches a browser nor needs one to be tested.
 */
import type { Page as PlaywrightPage } from 'playwright';
import {
  enumerationOutcome,
  externalParts,
  isOwnOrigin,
  lowerBoundMoreUrls,
  matchesGlob,
  policyDecision,
  statusClassFor,
  surfaceKey,
  type CapBite,
  type CrawlCap,
  type CrawlPolicy,
  type EnumerationOutcome,
  type ExcludedPath,
  type ExclusionKind,
  type ExternalBoundary,
  type FlowEdge,
  type FlowNode,
  type FormField,
  type FormFieldSemantic,
  type FormModel,
  type Frontier,
  type Selector,
  type SurfaceExercise,
} from '@qaai/shared';

// ─── The injected browser surface ────────────────────────────────────────────

/**
 * The browser capabilities this module needs, named so a missing one can be
 * reported instead of silently producing an empty measurement.
 *
 * The first four are required: without them nothing can be enumerated and the
 * crawl is FAILED, not converged-over-nothing. The rest degrade, and each
 * degradation has a `cost` sentence in {@link InteractionCrawlResult.unavailable}.
 */
export const INTERACTION_CAPABILITIES = [
  /** Click an element the last `controls()` read named. Required. */
  'CLICK',
  /** Navigate to a URL. Required — it is the first step of every replay path. */
  'GOTO',
  /** Read the structure a state signature is computed from. Required. */
  'SNAPSHOT',
  /** Read the page's controls. Required. */
  'CONTROLS',
  /** Type into a field, so a search submit has something to submit. */
  'FILL',
  /**
   * Observe pushState/replaceState/popstate. Without it a same-document SPA
   * transition cannot be told from a server navigation, and the count of
   * client-side navigations is UNKNOWN rather than zero.
   */
  'HISTORY_HOOK',
  /**
   * The HTTP status of a navigation. Without it `FlowNode.status.code` is null
   * — which is what `statusClassFor` turns into UNKNOWN, never into OK.
   */
  'NAVIGATION_STATUS',
  /** The open dialog's accessible name, so a modal is a distinguishable state. */
  'DIALOG_REGION',
  /** Browser back. Not used as the reversal strategy — see {@link REVERSAL_STRATEGIES}. */
  'BACK',
] as const;
export type InteractionCapability = (typeof INTERACTION_CAPABILITIES)[number];

/** Capabilities without which there is no measurement at all. */
export const REQUIRED_CAPABILITIES: readonly InteractionCapability[] = [
  'CLICK',
  'GOTO',
  'SNAPSHOT',
  'CONTROLS',
];

/** A capability the surface did not offer, and what its absence cost. */
export interface CapabilityGap {
  capability: InteractionCapability;
  /** What is UNKNOWN as a result. Never phrased as a zero. */
  cost: string;
}

/**
 * One element as the adapter read it. RAW FACTS ONLY — every classification,
 * score and refusal in this file is computed from this shape by a pure
 * function, which is the whole reason the shape exists.
 */
export interface RawControl {
  /**
   * Names the element back to the surface for a click or a fill. Stable only
   * within one `controls()` read: the adapter stamps it, and a navigation wipes
   * it. Identity across reads is {@link controlIdentity}, never this.
   */
  ref: string;
  /** Lowercase tag name. */
  tag: string;
  /** The `type` attribute, for inputs and buttons. */
  type: string | null;
  /** The EXPLICIT `role` attribute. The implicit one is derived — see {@link implicitRole}. */
  role: string | null;
  rel: string | null;
  /** Trimmed visible text, already length-capped by the adapter. */
  text: string;
  ariaLabel: string | null;
  title: string | null;
  testId: string | null;
  placeholder: string | null;
  /** First associated `<label>`'s text. */
  label: string | null;
  name: string | null;
  /** Absolute href, for anchors and for a form's action. */
  href: string | null;
  ariaExpanded: string | null;
  ariaControls: string | null;
  ariaHasPopup: string | null;
  ariaCurrent: string | null;
  /** `[data-state]` — the Radix/shadcn convention for an open/active control. */
  dataState: string | null;
  disabled: boolean;
  /** `aria-hidden`, `hidden`, or zero-sized. Not interactive, not counted. */
  hidden: boolean;
  required: boolean;
  contentEditable: boolean;
  /**
   * A click handler the adapter could see: an `onclick` attribute, or a
   * listener registered through a patched `addEventListener`. React's synthetic
   * delegation means this is a LOWER BOUND — a div with a React onClick and no
   * role shows up only when the adapter's listener hook was installed before
   * hydration, which is why `HANDLER_DIV` scores last rather than being
   * treated as a reliable signal.
   */
  hasClickHandler: boolean;
  /** Nearest landmark or region, for per-page control identity. Null = none. */
  landmark: string | null;
  /** Enclosing `<form>` index, or null when the control is formless. */
  formIndex: number | null;
  /** The enclosing `<fieldset>`'s legend, when there is one. */
  fieldset: string | null;
  /** The `<select>`'s option texts. */
  options: string[] | null;
  /**
   * Index among controls on this page sharing its role AND accessible name, or
   * null when it is the only one. Three "Save" buttons on one page are three
   * controls, and without this they would be one identity.
   */
  nth: number | null;
  /** Last-resort locator. */
  cssPath: string;
  /** What the markup declares about the value. See {@link RawFieldConstraints}. */
  constraints: RawFieldConstraints;
}

/**
 * The constraints the DOM already carries. Taken as a `Pick` of `FormField`
 * rather than restated, because they are load-bearing for every boundary test
 * and a second spelling of them is a second thing to keep in step.
 */
export type RawFieldConstraints = Partial<
  Pick<
    FormField,
    | 'maxLength'
    | 'minLength'
    | 'min'
    | 'max'
    | 'step'
    | 'pattern'
    | 'inputMode'
    | 'autocomplete'
    | 'accept'
    | 'multiple'
    | 'validationMessage'
  >
>;

/** One line of the accessibility structure, in document order. */
export interface RawStructureNode {
  role: string;
  name: string;
  depth: number;
}

/** Everything a state signature is computed from. */
export interface RawSnapshot {
  url: string;
  title: string;
  structure: RawStructureNode[];
  /**
   * The open dialog's accessible name, or null when no dialog is open. Absent
   * capability `DIALOG_REGION` must send null AND declare the gap — a modal
   * that cannot be seen makes two states look like one.
   */
  dialogName: string | null;
  /** `aria-current` / `[data-state=active]` names: which tab or step is live. */
  activeMarkers: string[];
  /**
   * The status of the navigation that produced this document, or null when
   * there was none (a same-document SPA transition) or the surface cannot read
   * it. NULL IS NOT 200.
   */
  statusCode: number | null;
  /** True when the body is the application's own error page. */
  isErrorPage: boolean;
}

/** A client-side navigation the history hook observed. */
export interface RawNavigation {
  kind: 'PUSH' | 'REPLACE' | 'POP' | 'HASH';
  url: string;
}

export interface NavigationOutcome {
  ok: boolean;
  url: string;
  /** Null for a same-document transition or an unavailable capability. */
  status: number | null;
  error: string | null;
}

export interface ClickOutcome {
  ok: boolean;
  error: string | null;
  /** True when the click caused a document load. */
  navigated: boolean;
  status: number | null;
}

/**
 * The browser, as eight methods. Narrow enough to fake in a test, which is the
 * point: the fake in `interact.test.ts` is a page graph in a literal.
 */
export interface InteractionSurface {
  capabilities(): readonly InteractionCapability[];
  /** The current URL, read without a round trip to the page. */
  url(): string;
  goto(url: string): Promise<NavigationOutcome>;
  back(): Promise<NavigationOutcome>;
  snapshot(): Promise<RawSnapshot>;
  controls(): Promise<RawControl[]>;
  click(ref: string): Promise<ClickOutcome>;
  fill(ref: string, value: string): Promise<boolean>;
  /** Returns the navigations seen since the last drain, and clears them. */
  drainNavigations(): Promise<RawNavigation[]>;
}

/**
 * The two pure functions this module needs from `crawler.ts`, INJECTED rather
 * than imported.
 *
 * Not a style choice: `crawler.ts` imports `chromium` at module scope and will
 * import this file once phase 3 wires it, so a static import either way is a
 * cycle. Copying `normaliseRoute` would be worse — two route normalisers
 * disagreeing by one segment means `/orders/1001` and `/orders/:id` stop being
 * the same thing and the per-template budget stops applying. Required rather
 * than optional so a missing wire is a compile error, not a crawl that mints a
 * node per order id.
 */
export interface CrawlerPrimitives {
  /** `/orders/ORD-1001` → `/orders/:id`. `normaliseRoute` from crawler.ts. */
  normaliseRoute: (pathname: string) => string;
  /** `semanticFor` from crawler.ts. */
  semanticFor: (
    name: string,
    type: string,
    label: string,
    autocomplete?: string | null,
  ) => FormFieldSemantic;
}

// ─── Control identity: the "Save" defect ─────────────────────────────────────

/**
 * Per-page control identity.
 *
 * THE DEFECT: `locators.ts:68` de-duplicates affordances by locator
 * EXPRESSION, so `getByRole('button', { name: 'Save' })` is ONE identity across
 * five routes. Cover it on /profile and the other four read as covered — a
 * 100%-at-20% lie, and the most flattering possible direction to be wrong in.
 *
 * So identity is `route::landmark::role::label::nth`, five parts because each
 * one is a different control a test would have to reach separately:
 *   • route     — the page. The missing part, and the whole defect.
 *   • landmark  — `main` vs `nav`: the same label in a header and in a table
 *                 row are two controls with two behaviours.
 *   • role      — a `button` named "Filter" and a `tab` named "Filter" differ.
 *   • label     — the accessible name, in the APPLICATION'S OWN CASE. Folding
 *                 case merges two controls and shrinks the denominator.
 *   • nth       — three "Save" buttons on one page are three controls.
 *
 * `*` in the landmark position means there is NO enclosing landmark; the
 * adapter always looks, so it is a measurement and not an unknown.
 *
 * WHAT THIS DOES TO STORED DATA: every control-level coverage key changes. See
 * this module's report — the old bare-label keys must be treated as RETIRED,
 * and the corrected number goes DOWN, which has to be announced rather than
 * smoothed.
 */
export function controlIdentity(input: {
  route: string;
  landmark: string | null;
  role: string;
  label: string;
  nth?: number | null;
}): string {
  return [
    encodeIdentityPart(input.route),
    encodeIdentityPart(input.landmark ?? '*'),
    encodeIdentityPart(input.role),
    encodeIdentityPart(collapse(input.label)),
    input.nth === null || input.nth === undefined ? '' : String(input.nth),
  ].join('::');
}

/** The inverse, so a reader can render the route without re-deriving it. */
export function parseControlIdentity(identity: string): {
  route: string;
  landmark: string | null;
  role: string;
  label: string;
  nth: number | null;
} | null {
  const parts = identity.split('::');
  if (parts.length !== 5) return null;
  const [route, landmark, role, label, nth] = parts as [string, string, string, string, string];
  const index = nth === '' ? null : Number.parseInt(nth, 10);
  if (index !== null && !Number.isFinite(index)) return null;
  return {
    route: decodeIdentityPart(route),
    landmark: landmark === '*' ? null : decodeIdentityPart(landmark),
    role: decodeIdentityPart(role),
    label: decodeIdentityPart(label),
    nth: index,
  };
}

/*
 * `%` first, so `::` encoded as `%3A%3A` cannot be produced by a label that
 * already contained `%3A`. Same ordering rule as `dimensionCellIdentity`.
 */
function encodeIdentityPart(value: string): string {
  return value.replace(/%/g, '%25').replace(/:/g, '%3A');
}

function decodeIdentityPart(value: string): string {
  return value.replace(/%3A/g, ':').replace(/%25/g, '%');
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// ─── Locators, computed from the raw descriptor ──────────────────────────────

/**
 * Tag (plus input type) → the role the platform gives it.
 *
 * EXPORTED so there is one of these in the repo. `bestSelector` in crawler.ts
 * has the same map inside a closure, which means a role added here and not
 * there produces two different locators for one element — see this module's
 * report for the one-line change that points crawler.ts at this function.
 */
export function implicitRole(tag: string, type: string | null): string | null {
  const byTag: Record<string, string> = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    summary: 'button',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
  };
  const direct = byTag[tag];
  if (direct) return direct;
  if (tag !== 'input') return null;
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset')
    return 'button';
  if (type === 'search') return 'searchbox';
  return 'textbox';
}

/**
 * The accessible name, in the order the platform computes it — with `title`
 * added at the end, because an ICON-ONLY control whose only name is a `title`
 * attribute is one of the controls this module exists to stop losing.
 */
export function accessibleName(raw: RawControl): string {
  return collapse(raw.ariaLabel ?? raw.label ?? raw.text ?? '') || collapse(raw.title ?? '');
}

/**
 * The label used for BOTH the display name and the identity.
 *
 * One function, because two would be the `locators.ts` defect again one level
 * down: an identity derived from a label that is not the label on screen means
 * a reader cannot find the control the report names. The `name` attribute is
 * the last fallback, so an icon-only control with neither `aria-label` nor
 * `title` is still distinguishable from the next one instead of both being ''.
 */
export function labelOf(raw: RawControl): string {
  return accessibleName(raw) || collapse(raw.name ?? '');
}

/**
 * The per-page identity of a raw control, affordance or field.
 *
 * Exported and used by `rankCandidate`, by the replay walker and by the search
 * fill, so there is exactly one formula. A second one would mean a replay path
 * recorded under one spelling and looked up under another, which presents as
 * "the state could not be reached" and is actually a string bug.
 */
export function identityOfRaw(raw: RawControl, route: string): string {
  return controlIdentity({
    route,
    landmark: raw.landmark,
    role: raw.role ?? implicitRole(raw.tag, raw.type) ?? raw.tag,
    label: labelOf(raw),
    nth: raw.nth,
  });
}

/**
 * The most resilient locator for a raw control.
 *
 * Same order and the same confidence numbers as `bestSelector` in crawler.ts —
 * deliberately, because the Generator's review threshold (0.6) is calibrated
 * against them. The difference is that this one is synchronous over plain data,
 * so it is tested; the other runs inside `locator.evaluate()` and is not.
 */
export function selectorFor(raw: RawControl): Selector {
  const role = raw.role ?? implicitRole(raw.tag, raw.type);
  const name = accessibleName(raw);
  const nth = raw.nth === null ? {} : { nth: raw.nth };

  if (role && name) {
    return { strategy: 'ROLE', value: role, name, confidence: 0.95, ...nth };
  }
  if (raw.label) return { strategy: 'LABEL', value: raw.label, confidence: 0.9, ...nth };
  if (raw.testId) return { strategy: 'TEST_ID', value: raw.testId, confidence: 0.85, ...nth };
  if (raw.placeholder)
    return { strategy: 'PLACEHOLDER', value: raw.placeholder, confidence: 0.7, ...nth };
  if (name) return { strategy: 'TEXT', value: name, confidence: 0.6, ...nth };
  return { strategy: 'CSS', value: raw.cssPath, confidence: 0.3, ...nth };
}

// ─── Candidate selection ─────────────────────────────────────────────────────

/**
 * What kind of thing a control is, which is what decides whether clicking it
 * is likely to reveal a state.
 *
 * Ranked by how much the MARKUP ITSELF promises. A control with
 * `aria-controls` has told us there is a region it governs; a div with a click
 * handler has told us nothing except that somebody wired it, and our ability
 * to see that handler at all is a lower bound (see `RawControl.hasClickHandler`).
 */
export const INTERACTION_KINDS = [
  /** `aria-expanded`, `<summary>`: the markup declares hidden content. */
  'DISCLOSURE',
  /** `role=tab`, `[data-state]` on a tab list. */
  'TAB',
  /** "Next", "Continue", "Step 2" — a step of a multi-page form. */
  'WIZARD_STEP',
  /** `aria-haspopup=dialog`, a modal trigger. */
  'DIALOG_TRIGGER',
  /** `rel=next`, "Page 3", "›". */
  'PAGINATION',
  /** `role=menuitem`, `aria-haspopup=menu`. */
  'MENU',
  /** The submit of a GET search form: safe, and the results are a state. */
  'SEARCH_SUBMIT',
  /** The submit of some other form. Subject to `safeMethodsOnly`. */
  'FORM_SUBMIT',
  /** A plain button with no further declaration. */
  'BUTTON',
  /** A div/span/li carrying a click handler and no role. */
  'HANDLER_DIV',
  /** An anchor. Recorded here, FOLLOWED by the URL crawl — not clicked twice. */
  'LINK',
] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const INTERACTION_KIND_LABELS: Record<InteractionKind, string> = {
  DISCLOSURE: 'a disclosure that declares hidden content',
  TAB: 'a tab',
  WIZARD_STEP: 'a wizard step',
  DIALOG_TRIGGER: 'a dialog trigger',
  PAGINATION: 'a pagination control',
  MENU: 'a menu item',
  SEARCH_SUBMIT: 'a search submit',
  FORM_SUBMIT: 'a form submit',
  BUTTON: 'a button',
  HANDLER_DIV: 'an element with a click handler and no role',
  LINK: 'a link',
};

/**
 * The base score per kind, before the per-element adjustments in
 * {@link rankCandidate}. A compiler-enforced Record so a new kind cannot be
 * added without deciding what it is worth.
 */
export const INTERACTION_KIND_WEIGHT: Record<InteractionKind, number> = {
  DISCLOSURE: 0.9,
  TAB: 0.88,
  WIZARD_STEP: 0.85,
  DIALOG_TRIGGER: 0.8,
  PAGINATION: 0.78,
  MENU: 0.75,
  SEARCH_SUBMIT: 0.6,
  FORM_SUBMIT: 0.5,
  BUTTON: 0.4,
  HANDLER_DIV: 0.2,
  LINK: 0.1,
};

/** Roles that are fields rather than affordances — the field extractor's job. */
const FIELD_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'spinbutton',
  'slider',
  'switch',
  'checkbox',
  'radio',
]);

const FIELD_TAGS = new Set(['input', 'select', 'textarea']);
const NON_FIELD_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);
const HANDLER_TAGS = new Set(['div', 'span', 'li', 'td', 'tr', 'article', 'section', 'label']);
const PAGINATION_TEXT = /^(next|previous|prev|first|last|\d+|›|‹|»|«|→|←|\.\.\.)$/i;
const WIZARD_TEXT = /\b(next|continue|proceed|previous|back|step\s*\d+|finish|review)\b/i;
const SEARCH_HINT = /\b(search|find|query|filter)\b/i;

/** Whether this raw control is a form field rather than something to click. */
export function isFieldControl(raw: RawControl): boolean {
  if (raw.contentEditable) return true;
  if (raw.role !== null && FIELD_ROLES.has(raw.role)) return true;
  if (!FIELD_TAGS.has(raw.tag)) return false;
  return !NON_FIELD_INPUT_TYPES.has((raw.type ?? '').toLowerCase());
}

/**
 * What kind of affordance this is, or null when it is not one.
 *
 * Order is the whole function. A `<button>` named "Next" inside `nav` is
 * pagination; the same button inside `main` is a wizard step; and a control
 * that declares `aria-expanded` is a disclosure whatever it is named, because
 * the attribute is a statement by the author and the label is a guess by us.
 */
export function classifyControl(raw: RawControl): InteractionKind | null {
  if (raw.hidden || raw.disabled) return null;
  if (isFieldControl(raw)) return null;

  const role = raw.role ?? implicitRole(raw.tag, raw.type);
  const name = accessibleName(raw);
  const lower = name.toLowerCase();

  // Declared signals first: these are the author telling us, not us guessing.
  if (raw.tag === 'summary') return 'DISCLOSURE';
  if (raw.ariaExpanded !== null) return 'DISCLOSURE';
  if (raw.ariaHasPopup === 'dialog') return 'DIALOG_TRIGGER';
  if (role === 'tab') return 'TAB';
  if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') return 'MENU';
  if (raw.ariaHasPopup === 'menu' || raw.ariaHasPopup === 'true' || raw.ariaHasPopup === 'listbox')
    return 'MENU';
  if (raw.rel !== null && /\bnext\b|\bprev(ious)?\b/i.test(raw.rel)) return 'PAGINATION';

  const paginationContext =
    (raw.landmark !== null && /nav|pagination/i.test(raw.landmark)) ||
    /pagin/i.test(raw.testId ?? '') ||
    /\bpage\b/i.test(raw.ariaLabel ?? '');
  if (paginationContext && (PAGINATION_TEXT.test(lower) || /\bpage\b/i.test(lower)))
    return 'PAGINATION';

  // `[data-state]` is the shadcn/Radix convention and appears on tabs,
  // accordions and dropdowns alike; treat it as a tab only when the control
  // is in a tablist-shaped context, otherwise as a disclosure.
  if (raw.dataState !== null) {
    if (raw.ariaControls !== null || raw.ariaCurrent !== null) return 'TAB';
    return 'DISCLOSURE';
  }
  if (raw.ariaCurrent !== null && role !== 'link') return 'TAB';

  const isSubmit =
    (raw.tag === 'button' && (raw.type === 'submit' || raw.type === null)) ||
    (raw.tag === 'input' && raw.type === 'submit');
  if (isSubmit && raw.formIndex !== null) {
    const searchy = SEARCH_HINT.test(lower) || SEARCH_HINT.test(raw.name ?? '');
    return searchy ? 'SEARCH_SUBMIT' : 'FORM_SUBMIT';
  }

  if (role === 'button' || raw.tag === 'button' || raw.tag === 'input') {
    if (WIZARD_TEXT.test(lower)) return 'WIZARD_STEP';
    return 'BUTTON';
  }
  if (role === 'link' || raw.href !== null) return 'LINK';
  if (raw.hasClickHandler && HANDLER_TAGS.has(raw.tag)) return 'HANDLER_DIV';
  return null;
}

/** A control the crawl could drive, with the score that decides the order. */
export interface InteractionCandidate {
  ref: string;
  kind: InteractionKind;
  label: string;
  /** Per-page identity. See {@link controlIdentity}. */
  identity: string;
  selector: Selector;
  /** 0–1: how likely clicking it is to reveal a state we have not seen. */
  score: number;
  /** The sentence behind the score, in the customer's terms. */
  why: string;
  /** The id of the region the control declares it governs, when it declares one. */
  controls: string | null;
  /** The role used in the identity and the locator. */
  role: string;
  landmark: string | null;
  /** Resolved path, for anchors and form actions — what the policy is applied to. */
  path: string | null;
}

/**
 * Score and describe one classified control.
 *
 * The adjustments, and why each one: `aria-controls` is the strongest single
 * signal in the whole function, because the author has named the region the
 * control governs — that is a promise of hidden content. No accessible name is
 * a penalty rather than a disqualification: an icon-only control with neither
 * `aria-label` nor `title` is real, and it is also one the Generator cannot
 * write a stable locator for, so it sorts last and is still counted.
 */
export function rankCandidate(
  raw: RawControl,
  kind: InteractionKind,
  route: string,
): InteractionCandidate {
  const role = raw.role ?? implicitRole(raw.tag, raw.type) ?? raw.tag;
  const label = labelOf(raw);
  const reasons: string[] = [INTERACTION_KIND_LABELS[kind]];
  let score = INTERACTION_KIND_WEIGHT[kind];

  if (raw.ariaControls !== null) {
    score += 0.08;
    reasons.push(`declares aria-controls="${raw.ariaControls}"`);
  }
  if (raw.dataState !== null) {
    score += 0.04;
    reasons.push(`carries data-state="${raw.dataState}"`);
  }
  if (label === '') {
    score -= 0.15;
    reasons.push('no accessible name — no stable locator can be written for it');
  }
  if (raw.testId !== null) {
    score += 0.02;
    reasons.push(`has a test id (${raw.testId})`);
  }

  return {
    ref: raw.ref,
    kind,
    label,
    identity: identityOfRaw(raw, route),
    selector: selectorFor(raw),
    score: Math.min(1, Math.max(0, Number(score.toFixed(4)))),
    why: reasons.join('; '),
    controls: raw.ariaControls,
    role,
    landmark: raw.landmark,
    path: pathOf(raw.href),
  };
}

function pathOf(href: string | null): string | null {
  if (href === null) return null;
  try {
    return new URL(href).pathname;
  } catch {
    return null;
  }
}

// ─── Destructive refusal ─────────────────────────────────────────────────────

/**
 * Verbs we will not click, grouped by the reason, because the remedy differs.
 *
 * The highest-risk flows in every application are exactly the ones a crawler
 * must not fire blind, and the reason this list is a list rather than one regex
 * is that "ends the session", "destroys data" and "charges a card" are three
 * different sentences for the customer and three different remedies.
 */
const SESSION_ENDING = /\b(log|sign)\s*-?\s*(out|off)\b|\blogout\b|\bsignout\b/i;
const DESTRUCTIVE = new RegExp(
  [
    '\\bdelete\\b',
    '\\bdestroy\\b',
    '\\bremove\\b',
    '\\brevoke\\b',
    '\\bwipe\\b',
    '\\bpurge\\b',
    '\\bterminate\\b',
    '\\bdeactivate\\b',
    '\\bdisable account\\b',
    '\\bclose account\\b',
    '\\bcancel (subscription|plan|membership|account)\\b',
    '\\bdowngrade\\b',
    '\\breset\\b',
    '\\bdiscard\\b',
    '\\bunsubscribe\\b',
  ].join('|'),
  'i',
);
const REAL_WORLD = new RegExp(
  [
    '\\bpay\\b',
    '\\bpay now\\b',
    '\\bcharge\\b',
    '\\bcheck ?out\\b',
    '\\bplace order\\b',
    '\\bconfirm (order|payment|purchase)\\b',
    '\\bbuy\\b',
    '\\bsubscribe\\b',
    '\\bsend (email|invite|message|invitation)\\b',
    '\\binvite\\b',
    '\\bpublish\\b',
    '\\bdeploy\\b',
  ].join('|'),
  'i',
);

/**
 * Whether the crawl may click this candidate, and — when it may not — the
 * {@link SurfaceExercise} that must enter the inventory.
 *
 * THE RULE THIS ENCODES. A refused control is NOT dropped. It is counted,
 * named, and held out of the coverage denominator by
 * `NON_DENOMINATOR_EXERCISABILITIES`, so refusing it cannot raise the
 * percentage. Dropping it is the move that can.
 *
 * REFUSED vs UNEXERCISABLE, and the line between them is the point:
 *   • REFUSED        — a rule the CUSTOMER can read said no. `rule` names the
 *                      policy field, so they can change it.
 *   • UNEXERCISABLE  — OUR harness cannot safely drive it here, and no policy
 *                      field governs it. The remedy is a disposable record or
 *                      a capability, not a setting.
 *
 * The two-field design of `allowDestructive` + `destructiveAllowGlobs` is what
 * makes the first case possible: a throwaway seeded environment can opt in per
 * path, and then "Delete order" is driven on purpose rather than refused.
 */
export function refusalFor(
  candidate: Pick<InteractionCandidate, 'kind' | 'label' | 'path'>,
  policy: CrawlPolicy,
  route: string,
): SurfaceExercise | null {
  const label = candidate.label;

  // 1. Session-ending. Checked first: everything after it in the crawl would
  //    run anonymous, so this is not merely destructive, it invalidates the
  //    rest of the measurement.
  if (SESSION_ENDING.test(label)) {
    const decided = candidate.path === null ? null : policyDecision(policy, candidate.path);
    if (decided && !decided.admitted) {
      return {
        state: 'REFUSED',
        rule: decided.rule,
        detail: `"${label}" would end the session; the crawl policy refuses it (${decided.rule}).`,
      };
    }
    if (decided && decided.admitted && policy.allowDestructive) {
      /*
       * THE SAME PER-PATH OPT-IN AS RULE 2, and the defect this closes sat on
       * the MORE consequential rule. A bare `allowDestructive` used to return
       * null here, so one environment switch licensed clicking "Sign out" on
       * every route it could reach — while "Delete order" on that same route
       * under that same policy stayed REFUSED for want of a matching glob. The
       * weaker gate guarded the stronger consequence: a destructive click loses
       * one record, a logout makes every state measured after it anonymous.
       */
      if (policy.destructiveAllowGlobs.some((glob) => globMatches(glob, route))) return null;
      return {
        state: 'REFUSED',
        rule: `destructiveAllowGlobs: no pattern matched ${route}`,
        detail:
          `"${label}" ends the session. allowDestructive is on, but no ` +
          `destructiveAllowGlobs pattern matches ${route}, so it was not driven. ` +
          `Every state after it would be measured logged out.`,
      };
    }
    return {
      state: 'UNEXERCISABLE',
      reason: 'SESSION_ENDING',
      detail:
        `"${label}" ends the session and has no path the crawl policy could be checked ` +
        `against, so the harness refuses it. Every state after it would be measured ` +
        `logged out.`,
    };
  }

  // 2. Destructive. A policy field governs this, so a customer who wants it
  //    driven can say so — per path, not per environment.
  if (DESTRUCTIVE.test(label)) {
    if (!policy.allowDestructive) {
      return {
        state: 'REFUSED',
        rule: 'allowDestructive: false',
        detail:
          `"${label}" looks destructive and this environment does not allow destructive ` +
          `actions. Set allowDestructive with a destructiveAllowGlobs pattern for ` +
          `${route} to have it driven.`,
      };
    }
    const allowed = policy.destructiveAllowGlobs.some((glob) => globMatches(glob, route));
    if (!allowed) {
      return {
        state: 'REFUSED',
        rule: `destructiveAllowGlobs: no pattern matched ${route}`,
        detail:
          `"${label}" looks destructive. allowDestructive is on, but no ` +
          `destructiveAllowGlobs pattern matches ${route}, so it was not driven.`,
      };
    }
    return null;
  }

  // 3. Real-world side effects. No policy field governs these, and there must
  //    not be one: "charge the card" is not a setting, it is a disposable
  //    account and a provider in test mode.
  if (REAL_WORLD.test(label)) {
    return {
      state: 'UNEXERCISABLE',
      reason: 'REAL_WORLD_SIDE_EFFECT',
      detail:
        `"${label}" has a real-world side effect — money, mail or a third party. ` +
        `Driving it needs a disposable account and a provider in test mode.`,
    };
  }

  // 4. A non-GET submit while the policy allows only safe methods. The form is
  //    still inventory; the CRAWLER is what may not post it.
  if (candidate.kind === 'FORM_SUBMIT' && policy.safeMethodsOnly) {
    return {
      state: 'REFUSED',
      rule: 'safeMethodsOnly: true',
      detail:
        `"${label}" submits a form. safeMethodsOnly is on, so the crawl did not submit ` +
        `it; a generated test with a plan behind it still can.`,
    };
  }

  return null;
}

/*
 * The glob dialect, so `destructiveAllowGlobs` is matched the same way the
 * panel previews it. `matchesGlob` in @qaai/shared is the one implementation;
 * this wrapper exists only to keep the call site readable and to tolerate a
 * pattern that is not a string, which a JSONB column can hold.
 */
function globMatches(glob: unknown, path: string): boolean {
  if (typeof glob !== 'string') return false;
  // Imported lazily through the shared barrel's own implementation so the
  // panel's preview and this decision cannot disagree.
  return matchesGlob(glob, path);
}

// ─── State identity ─────────────────────────────────────────────────────────

/**
 * What a state IS, and the two mistakes either side of it.
 *
 * Too coarse and a wizard's step 2 is step 1, so half a checkout is invisible.
 * Too fine and the same tab clicked twice is two nodes, the crawl never
 * terminates, and the denominator inflates with duplicates — which makes the
 * percentage go DOWN for no reason, the mirror of the lie this product cannot
 * afford.
 *
 * So the signature is the URL's route identity plus a digest of the
 * accessibility structure, with three normalisations, each for a thing that
 * changes WITHOUT the state changing:
 *   • volatile names — "2 minutes ago", an ISO timestamp, "12 results" — are
 *     replaced by placeholders. Without this every revisit is a new state.
 *   • order is dropped: the lines are sorted, so a re-sorted table is one
 *     state. A wizard step still differs, because its CONTENT differs.
 *   • live-region roles (status, progressbar, timer) are dropped, because a
 *     toast or a spinner is an animation frame and not a state. `alert` is
 *     KEPT: a validation error IS a state, and the error path is where the
 *     tests live.
 */
export interface StateSignature {
  /** `route#digest`. The visited-set key. */
  id: string;
  route: string;
  /** The URL identity, including the surviving query and hash route. */
  identity: string;
  digest: string;
  /** The open dialog, NAMED rather than hashed, so a reader can see it. */
  dialog: string | null;
  /** The live tab/step markers, named for the same reason. */
  markers: string[];
}

const VOLATILE_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'paragraph',
  'status',
  'progressbar',
  'timer',
  'marquee',
  'log',
]);

/** Ordered: the date and duration rules must run before the bare-number rule. */
const VOLATILE_NAME_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\d{4}-\d{2}-\d{2}(t[\d:.]+z?)?/gi, '<date>'],
  [/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, '<time>'],
  [/\b(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/gi, '<ago>'],
  [/\bin\s+(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\b/gi, '<in>'],
  [/\d[\d,.]*/g, '#'],
];

/** One structure line, normalised for the digest. */
export function normaliseStructureName(name: string): string {
  let out = collapse(name).toLowerCase();
  for (const [pattern, replacement] of VOLATILE_NAME_RULES) {
    out = out.replace(pattern, replacement);
  }
  return collapse(out);
}

/**
 * The digest of a page's structure. Sorted and de-duplicated, so reordering is
 * not a state change and a repeated row is not fifty.
 */
export function structuralDigest(input: {
  structure: readonly RawStructureNode[];
  dialogName: string | null;
  activeMarkers: readonly string[];
}): string {
  const lines = new Set<string>();
  for (const node of input.structure) {
    const role = node.role.toLowerCase();
    if (VOLATILE_ROLES.has(role)) continue;
    lines.add(`${role}:${normaliseStructureName(node.name)}`);
  }
  if (input.dialogName !== null) {
    lines.add(`dialog:${normaliseStructureName(input.dialogName)}`);
  }
  for (const marker of input.activeMarkers) {
    lines.add(`active:${normaliseStructureName(marker)}`);
  }
  const payload = [...lines].sort().join('\n');
  return createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

/** The signature of the state the surface is currently showing. */
export function stateSignatureOf(
  snapshot: RawSnapshot,
  mode: RouteMode,
  policy: CrawlPolicy,
  primitives: CrawlerPrimitives,
): StateSignature {
  const url = routeIdentity(snapshot.url, mode, policy, primitives);
  const digest = structuralDigest(snapshot);
  return {
    id: `${url.identity}#${digest}`,
    route: url.route,
    identity: url.identity,
    digest,
    dialog: snapshot.dialogName,
    markers: [...snapshot.activeMarkers].sort(),
  };
}

// ─── SPA and hash routes ────────────────────────────────────────────────────

/**
 * How this application expresses its routes.
 *
 * DETECTED FROM A SAMPLE, never guessed from one URL, because the guess is
 * unfalsifiable in both directions: one `/#/orders` looks hash-routed and might
 * be a deep link into a path-routed app, and one `/orders` says nothing about
 * whether `#/` is used elsewhere. UNDETERMINED is a real answer and is what a
 * single sample gets.
 */
export const ROUTE_MODES = ['PATH', 'HASH', 'MIXED', 'UNDETERMINED'] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

/** `#/orders`, `#!/orders` — a route by SYNTAX, whatever the mode turns out to be. */
const ROUTE_LIKE_HASH = /^#!?\//;

export function detectRouteMode(urls: readonly string[]): { mode: RouteMode; why: string } {
  const parsed: URL[] = [];
  for (const url of urls) {
    try {
      parsed.push(new URL(url));
    } catch {
      /* not a URL; it cannot be evidence either way */
    }
  }
  if (parsed.length < 2) {
    return {
      mode: 'UNDETERMINED',
      why: `${parsed.length} usable URL sample(s): one URL cannot distinguish a hash route from a deep link`,
    };
  }

  const routeLike = new Set(parsed.filter((u) => ROUTE_LIKE_HASH.test(u.hash)).map((u) => u.hash));
  const paths = new Set(parsed.map((u) => u.pathname));

  if (routeLike.size >= 2 && paths.size <= 1) {
    return {
      mode: 'HASH',
      why: `${routeLike.size} distinct route-like hashes under one pathname — the hash IS the route`,
    };
  }
  if (routeLike.size >= 2) {
    return {
      mode: 'MIXED',
      why: `${routeLike.size} route-like hashes across ${paths.size} pathnames`,
    };
  }
  if (paths.size >= 2) {
    return {
      mode: 'PATH',
      why: `${paths.size} distinct pathnames and no repeated route-like hash`,
    };
  }
  return {
    mode: 'UNDETERMINED',
    why: `${parsed.length} samples share one pathname and show no repeated route-like hash`,
  };
}

/**
 * The route identity of a URL, with the hash kept when it is part of the route.
 *
 * THE DEFECT: `crawler.ts:356` sets `target.hash = ''` BEFORE dedupe, so a
 * hash-routed application collapses to one node and the coverage denominator
 * for the whole app is 1.
 *
 * The rule here is syntactic where it can be and modal where it must be. A
 * hash matching `#/` is a route whatever the mode says, because that is what
 * the syntax means. A bare `#section` is dropped in PATH and UNDETERMINED mode
 * (it is an in-page anchor and keeping it mints a node per heading link) and
 * KEPT in HASH mode, where `#home` is how some routers spell a route.
 */
export function routeIdentity(
  url: string,
  mode: RouteMode,
  policy: CrawlPolicy,
  primitives: CrawlerPrimitives,
): { identity: string; route: string; hashRoute: string | null; queryDropped: string[] } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { identity: url, route: url, hashRoute: null, queryDropped: [] };
  }

  const dropped: string[] = [];
  for (const param of policy.ignoredQueryParams) {
    if (parsed.searchParams.has(param)) {
      dropped.push(param);
      parsed.searchParams.delete(param);
    }
  }
  parsed.searchParams.sort();

  const hash = parsed.hash;
  const routeLike = ROUTE_LIKE_HASH.test(hash);
  const keepHash =
    hash !== '' && hash !== '#' && (routeLike || mode === 'HASH' || mode === 'MIXED');

  const basePath = primitives.normaliseRoute(parsed.pathname);
  let hashRoute: string | null = null;
  if (keepHash) {
    const raw = hash.replace(/^#!?/, '');
    // Only a path-shaped hash goes through the route normaliser; `#home` is a
    // name, and collapsing a segment of it to `:id` would be inventing a
    // parameter the router does not have.
    hashRoute = raw.startsWith('/') ? primitives.normaliseRoute(raw) : raw;
  }

  const route = hashRoute === null ? basePath : `${basePath}#${hashRoute}`;
  const query = parsed.searchParams.toString();
  return {
    identity: query === '' ? route : `${route}?${query}`,
    route,
    hashRoute,
    queryDropped: dropped,
  };
}

// ─── Reversibility ─────────────────────────────────────────────────────────

/**
 * How the crawl gets back to a state it has already left.
 *
 * REPLAY is the strategy, and the reason is not performance. Browser BACK
 * restores a URL, not an application state: a modal closed by `history.back()`
 * is not a modal that was never opened, a wizard's back button may submit, and
 * in a client-routed app `back` can land on a component that re-fetches into a
 * different state. Worse, BACK leaves no artefact — and the artefact is the
 * point. The Generator needs "goto /orders, click Filters, click Archived" to
 * write a test that reaches the state, so the crawl records that path and then
 * WALKS it, which is the only way to learn it actually works.
 *
 * A replay that lands somewhere else is recorded as `verified: false` with
 * `divergedTo`, and that state is not expanded. A state we cannot return to is
 * a state no test can reach, and reporting it as reachable would be a promise
 * the Generator cannot keep.
 */
export const REVERSAL_STRATEGIES = ['REPLAY', 'BACK', 'RELOAD'] as const;
export type ReversalStrategy = (typeof REVERSAL_STRATEGIES)[number];

export interface ReplayStep {
  kind: 'GOTO' | 'CLICK' | 'FILL';
  /** For GOTO the URL; for CLICK and FILL the control identity. */
  target: string;
  /** What a human would read in the test: `click "Filters"`. */
  label: string;
  selector: Selector | null;
  /** For FILL: the value typed. Always a literal, never a secret. */
  value?: string;
}

export interface ReplayPath {
  steps: ReplayStep[];
  /**
   * True when the harness re-walked these steps and arrived at the same
   * signature. False means the path is recorded but did NOT reproduce the
   * state, which is a caveat the Generator has to see.
   */
  verified: boolean;
  /** The signature it arrived at instead, when it diverged. */
  divergedTo: string | null;
  strategy: ReversalStrategy;
}

/** A readable rendering of a replay path, for an edge's `action` and a report. */
export function describeReplay(path: ReplayPath): string {
  return path.steps
    .map((step) =>
      step.kind === 'GOTO'
        ? `open ${step.target}`
        : step.kind === 'FILL'
          ? `type "${step.value ?? ''}" into ${step.label}`
          : `click "${step.label}"`,
    )
    .join(' → ');
}

// ─── Budgets, and the disclosure of every one that bit ──────────────────────

/**
 * The two budgets that are interaction-specific.
 *
 * They are NOT `CapBite`s, and the reason is a vocabulary gap rather than a
 * design decision: `CRAWL_CAPS` in @qaai/shared has eight members and none of
 * them is an interaction budget. Reporting a per-node interaction limit as
 * `AFFORDANCES_PER_PAGE` would be filing one cap under another cap's name,
 * which is the kind of near-miss that makes a report unreadable. See this
 * module's report for the two members to add; `budgetBitesAsCaps` becomes a
 * three-line function the day they exist.
 *
 * Everything the crawl does that IS expressible in `CRAWL_CAPS` —
 * the interaction depth limit, the wall clock, the per-page control cap, the
 * state budget, the per-template pagination budget — is reported as a real
 * `CapBite` in `result.caps`.
 */
export const INTERACTION_BUDGETS = ['INTERACTION_BUDGET', 'PER_NODE_INTERACTION_BUDGET'] as const;
export type InteractionBudget = (typeof INTERACTION_BUDGETS)[number];

export const INTERACTION_BUDGET_LABELS: Record<InteractionBudget, string> = {
  INTERACTION_BUDGET: 'the global interaction budget',
  PER_NODE_INTERACTION_BUDGET: 'the per-state interaction budget',
};

/** Same shape as `CapBite`, including the REQUIRED `discarded` count. */
export interface BudgetBite {
  budget: InteractionBudget;
  limit: number;
  bites: number;
  /** Candidates it threw away. The lower bound on what it cost. */
  discarded: number;
  scope: string | null;
  reason: string;
}

/** Only the budgets that actually bit. One that did not is not a caveat. */
export function budgetsThatBit(budgets: readonly BudgetBite[]): BudgetBite[] {
  return budgets.filter((budget) => budget.bites > 0);
}

/** Everything the interaction budgets threw away, summed. */
export function discardedByBudgets(budgets: readonly BudgetBite[]): number {
  return budgetsThatBit(budgets).reduce((running, budget) => running + budget.discarded, 0);
}

/**
 * THE INVARIANT that keeps "converged" honest, as a predicate a test can hold.
 *
 * Every budget bite site adds its `discarded` count to `unvisitedQueued`, so a
 * budget that bit always moves `atLeastMoreUrls` off zero and
 * `enumerationOutcome` already answers STOPPED. That is the whole reason the
 * CONVERGED guard below it cannot fire — and it is one missing `+=` away from
 * being untrue, at which point the word "converged" would appear on a
 * truncated crawl. So the invariant is asserted rather than assumed: a bite
 * that costs 7 candidates and a lower bound of 0 is a contradiction, and this
 * is where it is caught.
 */
export function budgetsFeedTheFrontier(
  result: Pick<InteractionCrawlResult, 'budgets' | 'frontier'>,
): boolean {
  return discardedByBudgets(result.budgets) <= result.frontier.atLeastMoreUrls;
}

/*
 * A tiny ledger, so that a cap or budget is recorded in exactly one place and
 * cannot be incremented without a `discarded` count. Every `break` and
 * `continue` in `exploreInteractions` goes through one of these two methods.
 */
class Ledger {
  private readonly caps = new Map<string, CapBite>();
  private readonly budgets = new Map<InteractionBudget, BudgetBite>();

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

  budget(budget: InteractionBudget, limit: number, discarded: number, scope: string | null): void {
    const existing = this.budgets.get(budget);
    if (existing) {
      existing.bites += 1;
      existing.discarded += discarded;
      if (existing.scope !== scope) existing.scope = null;
      return;
    }
    this.budgets.set(budget, {
      budget,
      limit,
      bites: 1,
      discarded,
      scope,
      reason: `${INTERACTION_BUDGET_LABELS[budget]} of ${limit} applied`,
    });
  }

  capList(): CapBite[] {
    return [...this.caps.values()];
  }

  budgetList(): BudgetBite[] {
    return [...this.budgets.values()];
  }
}

// ─── Formless field extraction ──────────────────────────────────────────────

/**
 * Field groups that are not inside a `<form>`.
 *
 * THE DEFECT: `crawler.ts:141` reads `page.locator('form')` and the controls
 * inside it. A controlled React application renders `<div>`s with `onSubmit`
 * handlers and no `<form>` element at all, so it produces ZERO `FormModel`s —
 * no field semantics, no constraint capture, and `UNSUBMITTED_FORM` can never
 * fire because there is no form for it to fire about.
 *
 * Grouping is by the enclosing `<fieldset>`'s legend, else the enclosing
 * landmark, else the page. That is the same thing a human means by "the form on
 * this page" and it is derived from markup the author wrote rather than from
 * proximity in pixels.
 *
 * THE FINDING IS THE MISSING SUBMIT. A group with fields and no submit control
 * comes back with `submit: null`, which is exactly the signal
 * `UNSUBMITTED_FORM` needs — so the absence is reported rather than papered
 * over with the nearest button.
 */
export function fieldGroupsFrom(
  controls: readonly RawControl[],
  context: { route: string; primitives: CrawlerPrimitives },
): FormModel[] {
  const fields = controls.filter(
    (raw) => isFieldControl(raw) && raw.formIndex === null && !raw.hidden,
  );
  if (fields.length === 0) return [];

  const groups = new Map<string, RawControl[]>();
  for (const raw of fields) {
    const key = raw.fieldset ?? raw.landmark ?? '*';
    groups.set(key, [...(groups.get(key) ?? []), raw]);
  }

  const submits = controls.filter((raw) => {
    const kind = classifyControl(raw);
    return kind === 'FORM_SUBMIT' || kind === 'SEARCH_SUBMIT' || kind === 'BUTTON';
  });

  const forms: FormModel[] = [];
  for (const [key, members] of groups) {
    const groupSubmit = submits.find(
      (raw) =>
        (raw.fieldset ?? raw.landmark ?? '*') === key &&
        /\b(submit|save|send|search|apply|continue|create|update|add|sign in|log in)\b/i.test(
          accessibleName(raw),
        ),
    );

    forms.push({
      id: `formless-${slug(key)}`,
      name: key === '*' ? 'Fields outside any landmark' : `Fields in ${key}`,
      /*
       * The group's own locator is the landmark, which is the only thing that
       * exists: there is no element to point at, which is the defect. CSS at
       * 0.4 rather than 0.5 says that out loud — it is weaker than the
       * `form:nth-of-type()` the real-form path produces.
       */
      selector: { strategy: 'CSS', value: landmarkSelector(key), confidence: 0.4 },
      fields: members.map((raw, index) => fieldFrom(raw, index, context.primitives)),
      submit: groupSubmit === undefined ? null : selectorFor(groupSubmit),
    });
  }
  return forms;
}

function fieldFrom(raw: RawControl, index: number, primitives: CrawlerPrimitives): FormField {
  const inputType = (raw.type ?? raw.role ?? raw.tag).toLowerCase();
  const label = raw.label ?? raw.ariaLabel ?? null;
  const options = raw.options === null || raw.options.length === 0 ? {} : { options: raw.options };
  return {
    name: raw.name ?? `field-${index}`,
    label,
    inputType,
    required: raw.required,
    selector: selectorFor(raw),
    semantic: primitives.semanticFor(
      raw.name ?? '',
      inputType,
      label ?? '',
      raw.constraints.autocomplete,
    ),
    ...options,
    ...raw.constraints,
  };
}

function landmarkSelector(key: string): string {
  if (key === '*') return 'body';
  return `[aria-label="${key}"], fieldset:has(legend:text-is("${key}"))`;
}

function slug(value: string): string {
  return (
    collapse(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'page'
  );
}

// ─── The result ─────────────────────────────────────────────────────────────

/**
 * A `FlowNode` for a state reached by interaction, plus what it took to get
 * there. The extra members are additive, so the object is a `FlowNode`
 * everywhere a `FlowNode` is expected and survives being stored as graph JSON.
 */
export interface InteractionNode extends FlowNode {
  signature: StateSignature;
  /** How to reach it. The artefact the Generator needs. */
  replay: ReplayPath;
  /** Clicks from the entry URL. 0 for a state reached by navigation alone. */
  interactionDepth: number;
  parentStateId: string | null;
}

/** A `FlowEdge` that carries the path a test would walk to traverse it. */
export interface InteractionEdge extends FlowEdge {
  /** The control's per-page identity — stable across crawls, unlike `ref`. */
  controlIdentity: string;
  kind: InteractionKind;
  /** The replay path to the edge's TARGET. */
  replay: ReplayPath;
  /** Set when the transition was a client-side navigation rather than a load. */
  navigation: RawNavigation['kind'] | null;
}

/** Every control seen, driven or not. The real control denominator. */
export interface ControlSighting {
  stateId: string;
  route: string;
  identity: string;
  label: string;
  kind: InteractionKind;
  /** The `FlowNode.affordances` vocabulary, so the existing readers work. */
  affordanceKind: 'link' | 'button' | 'input';
  selector: Selector;
  /** Set when it was refused or could not be driven. Null when it was fine. */
  exercise: SurfaceExercise | null;
  exercised: boolean;
  /** The state it produced, when it produced one. */
  leadsTo: string | null;
}

/** A control the crawl would not drive, with the rule and the surface key. */
export interface InteractionRefusal {
  stateId: string;
  route: string;
  identity: string;
  label: string;
  kind: InteractionKind;
  /** Never EXERCISABLE: this list exists to name what was held out. */
  exercise: SurfaceExercise;
  /**
   * The inventory key for what the refusal cost us.
   *
   * `COMPONENT_STATE` and not a thirteenth axis: what a refused control denies
   * us is the STATE behind it, which is exactly a component state we cannot
   * reach. NOTE that `COMPONENT_STATE` is not in `MEASURED_SURFACE_KINDS`, so
   * whoever admits these into the denominator must add the matcher AND the
   * measured-kind entry in one change — `check-wiring` section 9 fails on
   * either half alone, and a measured kind with no matcher reports a whole axis
   * as false gaps.
   */
  surfaceItemKey: string;
}

export interface InteractionStats {
  statesVisited: number;
  /** Clicks performed, excluding replay clicks. */
  interactions: number;
  /** Replay walks performed, so the cost of REPLAY-not-BACK is visible. */
  replays: number;
  /** Clicks that changed nothing. A real measurement: the control is inert. */
  noOpInteractions: number;
  controlsSeen: number;
  /**
   * Controls present and DISABLED in the state we read them in.
   *
   * They used to be erased: `classifyControl` returns null for a disabled
   * element, and the null branch dropped it without a sighting, without a
   * refusal and without a count — so a pager whose "Previous" is disabled on
   * page 1 reported the page as having one pagination control when it has two,
   * and nothing in the report said a control had been left out. A disabled
   * control is a surface that EXISTS and that we could not exercise here,
   * which is not the same thing as a surface that does not exist.
   *
   * A count and not a held-out `InteractionRefusal`, because an UNEXERCISABLE
   * needs a `reason` from `UNEXERCISABLE_REASONS` and no member of it is true
   * of "disabled in this state" — inventing one is a change to a file this
   * module does not own. See this review's report for that ask.
   */
  disabledControls: number;
  /** Controls `aria-hidden`, `hidden` or zero-sized when read. Same reasoning. */
  hiddenControls: number;
  /** Replays that did not reproduce their state. Each one is an unreachable state. */
  replayFailures: number;
  /**
   * Clicks on a control that DECLARES a transition and left the state
   * signature unchanged.
   *
   * NOT folded into `noOpInteractions`, which asserts something stronger than
   * we know. "The control is inert" is a measurement; this is the absence of
   * one. A client-side pager that does not touch the URL is the case that
   * proves it: page 2's rows and its "Page 2 of 5" normalise to exactly page
   * 1's digest, so `Next` reads as inert, the four remaining pages are never
   * enumerated, no cap bites, and the crawl says CONVERGED — the truncation
   * that makes the coverage percentage go UP, reported as convergence.
   *
   * Kept to `PAGINATION` and `WIZARD_STEP`, the two kinds with no legitimate
   * "already there" reading: a tab, a menu or a disclosure can honestly be
   * clicked while the state it leads to is the state you are in, and a pager
   * that has run out of pages disables its control rather than leaving it live.
   */
  indistinguishableInteractions: number;
  clientNavigations: number | null;
}

export interface InteractionCrawlResult {
  nodes: InteractionNode[];
  edges: InteractionEdge[];
  controls: ControlSighting[];
  /** Field groups found outside any `<form>`, per state. */
  formlessForms: Array<{ stateId: string; forms: FormModel[] }>;
  routeMode: RouteMode;
  routeModeWhy: string;
  refusals: InteractionRefusal[];
  excluded: ExcludedPath[];
  externals: ExternalBoundary[];
  /** Caps expressible in `CRAWL_CAPS`. Merge into `FlowMap.caps`. */
  caps: CapBite[];
  /** The two interaction budgets `CRAWL_CAPS` has no member for. */
  budgets: BudgetBite[];
  /** States and controls known and not driven. `atLeastMoreUrls` is consistent. */
  frontier: Frontier;
  outcome: EnumerationOutcome;
  why: string;
  unavailable: CapabilityGap[];
  stats: InteractionStats;
}

export interface InteractionCrawlOptions {
  baseUrl: string;
  /** Pages the URL crawl reached. Interaction exploration starts at each. */
  entryUrls: string[];
  policy: CrawlPolicy;
  primitives: CrawlerPrimitives;
  /** Default 300. */
  interactionBudget?: number;
  /** Default 12. */
  perNodeInteractionBudget?: number;
  /** Clicks deep from an entry URL. Default 4. */
  maxInteractionDepth?: number;
  /** States this pass may add. Default `policy.pageBudget`. */
  maxStates?: number;
  /** Controls read per state. Default 200 — crawler.ts's cap was a SILENT 20. */
  controlsPerPage?: number;
  /** Default `policy.wallClockMillis`. */
  wallClockMillis?: number;
  /** Pagination steps per route template. Default 3. */
  maxPaginationFollow?: number;
  /** The literal typed into a search box. Never a secret, never a real value. */
  searchProbe?: string;
  /** Injected so a budget test does not depend on the wall clock. */
  now?: () => number;
  /** Maps a signature to an existing FlowNode id, so edges join the URL graph. */
  nodeIdFor?: (signature: StateSignature) => string | null;
  onProgress?: (message: string) => void;
}

// ─── The traversal ──────────────────────────────────────────────────────────

interface StateRecord {
  signature: StateSignature;
  nodeId: string;
  replay: ReplayPath;
  depth: number;
  /** False once we have read its controls, so a state is expanded once. */
  pending: boolean;
}

/**
 * Explore what is behind the controls, starting from the pages the URL crawl
 * already reached.
 *
 * Returns a graph fragment rather than a `FlowMap`: the caller owns the map and
 * merges this into it, because the URL crawl and this pass produce two halves
 * of one graph and only the caller knows the node-id space.
 */
export async function exploreInteractions(
  surface: InteractionSurface,
  options: InteractionCrawlOptions,
): Promise<InteractionCrawlResult> {
  const progress = options.onProgress ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const policy = options.policy;
  const primitives = options.primitives;

  const interactionBudget = options.interactionBudget ?? 300;
  const perNodeBudget = options.perNodeInteractionBudget ?? 12;
  const maxDepth = options.maxInteractionDepth ?? 4;
  const maxStates = options.maxStates ?? policy.pageBudget;
  const controlsPerPage = options.controlsPerPage ?? 200;
  const wallClockMillis = options.wallClockMillis ?? policy.wallClockMillis;
  const maxPaginationFollow = options.maxPaginationFollow ?? 3;
  const searchProbe = options.searchProbe ?? 'qaai';
  const deadline = now() + wallClockMillis;

  const available = new Set(surface.capabilities());
  const unavailable: CapabilityGap[] = [];
  for (const capability of INTERACTION_CAPABILITIES) {
    if (available.has(capability)) continue;
    unavailable.push({ capability, cost: CAPABILITY_COST[capability] });
  }

  const ledger = new Ledger();
  const nodes: InteractionNode[] = [];
  const edges: InteractionEdge[] = [];
  const controls: ControlSighting[] = [];
  const formlessForms: Array<{ stateId: string; forms: FormModel[] }> = [];
  const refusals: InteractionRefusal[] = [];
  const excluded: ExcludedPath[] = [];
  const externals = new Map<string, ExternalBoundary>();
  const states = new Map<string, StateRecord>();
  const pending: string[] = [];
  const frontierSample: string[] = [];
  const paginationFollowed = new Map<string, number>();

  const stats: InteractionStats = {
    statesVisited: 0,
    interactions: 0,
    replays: 0,
    noOpInteractions: 0,
    controlsSeen: 0,
    disabledControls: 0,
    hiddenControls: 0,
    replayFailures: 0,
    indistinguishableInteractions: 0,
    clientNavigations: available.has('HISTORY_HOOK') ? 0 : null,
  };
  let unvisitedQueued = 0;
  let beyondDepth = 0;
  let unreachable = 0;
  let offOrigin = 0;

  const missing = REQUIRED_CAPABILITIES.filter((capability) => !available.has(capability));
  if (missing.length > 0) {
    /*
     * FAILED, and not an empty success. A surface that cannot click produced no
     * measurement, and "0 states behind controls" from a harness that cannot
     * click is the single most flattering lie available here: it reads as "this
     * app has nothing behind a button".
     */
    return {
      nodes: [],
      edges: [],
      controls: [],
      formlessForms: [],
      routeMode: 'UNDETERMINED',
      routeModeWhy: 'no URL was read: the surface is missing a required capability',
      refusals: [],
      excluded: [],
      externals: [],
      caps: [],
      budgets: [],
      frontier: emptyFrontier(),
      outcome: 'FAILED',
      why: `the browser surface is missing ${missing.join(', ')}; nothing was enumerated`,
      unavailable,
      stats,
    };
  }

  /*
   * Route mode is detected from the entry URLs FIRST, because the signature of
   * the very first state depends on whether the hash is part of its route — and
   * a mode decided later would have to re-key every state found before it.
   */
  const detected = detectRouteMode(options.entryUrls);
  let routeMode = detected.mode;
  let routeModeWhy = detected.why;

  const recordExternal = (url: string, kind: ExternalBoundary['kind'], fromRoute: string): void => {
    const parts = externalParts(url);
    if (parts === null) return;
    const existing = externals.get(parts.origin);
    if (existing) {
      existing.occurrences += 1;
      return;
    }
    externals.set(parts.origin, {
      kind,
      origin: parts.origin,
      fromRoute,
      samplePath: parts.path,
      occurrences: 1,
    });
  };

  const register = (
    signature: StateSignature,
    snapshot: RawSnapshot,
    replay: ReplayPath,
    depth: number,
    parentStateId: string | null,
    pageControls: readonly RawControl[],
  ): StateRecord => {
    const existing = states.get(signature.id);
    if (existing) return existing;

    const nodeId = options.nodeIdFor?.(signature) ?? `istate-${states.size}`;
    const record: StateRecord = { signature, nodeId, replay, depth, pending: true };
    states.set(signature.id, record);

    nodes.push({
      id: nodeId,
      route: signature.route,
      url: snapshot.url,
      title: snapshot.title,
      /*
       * `stateKey` is the digest, so the existing readers that group by it keep
       * working and two visits to one state stay one node.
       */
      stateKey: signature.digest,
      /*
       * Empty, and it means "this pass asked no role" — the same thing it means
       * in crawler.ts. The role prober fills it; inventing a role list here
       * would be claiming a measurement nobody made.
       */
      requiresRoles: [],
      /*
       * True only when a click NAVIGATED from a non-auth route to an auth one:
       * that is a request that got bounced, which is what an auth wall is. A
       * same-document transition to a sign-in view is not distinguishable from
       * opening the sign-in page on purpose, so it stays false rather than
       * guessed.
       */
      behindAuth: parentStateId !== null && isAuthWall(signature.route, states, parentStateId),
      forms: [],
      affordances: [],
      screenshotKey: null,
      /*
       * NOT A MEASUREMENT. axe did not run in this pass, and `FlowNode`'s field
       * is a required `number` so there is nothing else to write. It is the
       * one place in this module where a zero stands in for an absence, it is
       * inherited from the model rather than introduced here, and the fix —
       * making it `number | null` — is in this module's report.
       */
      a11yViolationCount: 0,
      status: {
        code: snapshot.statusCode,
        class: statusClassFor(snapshot.statusCode),
        isErrorPage: snapshot.isErrorPage,
      },
      signature,
      replay,
      interactionDepth: depth,
      parentStateId,
    });

    const forms = fieldGroupsFrom(pageControls, { route: signature.route, primitives });
    if (forms.length > 0) formlessForms.push({ stateId: signature.id, forms });

    return record;
  };

  /** Read, classify and RECORD every control on the current state. */
  const readControls = async (
    record: StateRecord,
  ): Promise<{ raw: RawControl[]; admitted: InteractionCandidate[] }> => {
    const all = await surface.controls();
    let raw = all;
    if (all.length > controlsPerPage) {
      raw = all.slice(0, controlsPerPage);
      ledger.cap(
        'AFFORDANCES_PER_PAGE',
        controlsPerPage,
        all.length - controlsPerPage,
        record.signature.route,
        `read the first ${controlsPerPage} of ${all.length} controls on ${record.signature.route}; at least ${all.length - controlsPerPage} more existed`,
      );
    }

    const admitted: InteractionCandidate[] = [];
    for (const element of raw) {
      if (element.hidden) {
        stats.hiddenControls += 1;
        continue;
      }
      if (isFieldControl(element)) {
        stats.controlsSeen += 1;
        continue;
      }
      const kind = classifyControl(element);
      if (kind === null) {
        // Counted rather than erased. See `InteractionStats.disabledControls`.
        if (element.disabled) stats.disabledControls += 1;
        continue;
      }
      stats.controlsSeen += 1;
      const candidate = rankCandidate(element, kind, record.signature.route);

      // Off-origin anchors are somebody else's application, and counting them
      // would produce coverage gaps for a page our customer cannot change.
      if (
        candidate.path !== null &&
        element.href !== null &&
        !isOwnOrigin(options.baseUrl, element.href, policy)
      ) {
        offOrigin += 1;
        recordExternal(element.href, 'LINK', record.signature.route);
        controls.push(sighting(record, candidate, null, false, null));
        continue;
      }

      // A path the policy refuses enters the exclusion ledger with the RULE
      // that refused it. A refusal with no record is the defect.
      if (candidate.path !== null) {
        const decided = policyDecision(policy, candidate.path);
        if (!decided.admitted) {
          excluded.push({
            url: element.href ?? candidate.path,
            route: primitives.normaliseRoute(candidate.path),
            kind: exclusionKindFor(decided.rule),
            rule: decided.rule,
            discoveredFrom: record.signature.route,
          });
          const exercise: SurfaceExercise = {
            state: 'REFUSED',
            rule: decided.rule,
            detail: `${candidate.path} is refused by the crawl policy (${decided.rule}).`,
          };
          refusals.push(refusal(record, candidate, exercise));
          controls.push(sighting(record, candidate, exercise, false, null));
          continue;
        }
      }

      const refused = refusalFor(candidate, policy, record.signature.route);
      if (refused !== null) {
        refusals.push(refusal(record, candidate, refused));
        controls.push(sighting(record, candidate, refused, false, null));
        continue;
      }

      // Links are recorded and NOT clicked: the URL crawl owns them, and
      // clicking them here would double-count the same traversal.
      if (candidate.kind === 'LINK') {
        controls.push(sighting(record, candidate, null, false, null));
        continue;
      }

      admitted.push(candidate);
    }

    admitted.sort(
      (left, right) => right.score - left.score || left.label.localeCompare(right.label),
    );
    return { raw, admitted };
  };

  /**
   * Walk a replay path and say whether it reproduced the state.
   *
   * This is where REPLAY earns its place over BACK: the path is the Generator's
   * artefact, and walking it is the only way to find out it works.
   */
  const reach = async (record: StateRecord): Promise<boolean> => {
    stats.replays += 1;
    const first = record.replay.steps[0];
    if (first === undefined || first.kind !== 'GOTO') return false;

    const landed = await surface.goto(first.target);
    if (!landed.ok) {
      record.replay.verified = false;
      record.replay.divergedTo = null;
      return false;
    }

    for (const step of record.replay.steps.slice(1)) {
      const pageControls = await surface.controls();
      /*
       * The route the step's identity was MINTED under, read back out of the
       * identity itself. Using the target state's route here was a real defect
       * I wrote and my own test caught: every replay of a path whose click
       * navigated failed to find its control, so every such state was reported
       * unreachable — a whole class of surface silently lost to a string
       * mismatch.
       */
      const stepRoute = parseControlIdentity(step.target)?.route ?? record.signature.route;
      const match = pageControls.find(
        (element) => identityOfRaw(element, stepRoute) === step.target,
      );
      if (match === undefined) {
        record.replay.verified = false;
        record.replay.divergedTo = 'control not found on replay';
        return false;
      }
      if (step.kind === 'FILL') {
        await surface.fill(match.ref, step.value ?? searchProbe);
        continue;
      }
      const clicked = await surface.click(match.ref);
      if (!clicked.ok) {
        record.replay.verified = false;
        record.replay.divergedTo = clicked.error;
        return false;
      }
    }

    const snapshot = await surface.snapshot();
    const arrived = stateSignatureOf(snapshot, routeMode, policy, primitives);
    if (arrived.id !== record.signature.id) {
      record.replay.verified = false;
      record.replay.divergedTo = arrived.id;
      return false;
    }
    record.replay.verified = true;
    record.replay.divergedTo = null;
    return true;
  };

  // ── Entry states ──────────────────────────────────────────────────────────

  const seenUrls: string[] = [];
  for (const entryUrl of options.entryUrls) {
    const path = pathOf(entryUrl);
    if (path !== null) {
      const decided = policyDecision(policy, path);
      if (!decided.admitted) {
        excluded.push({
          url: entryUrl,
          route: primitives.normaliseRoute(path),
          kind: exclusionKindFor(decided.rule),
          rule: decided.rule,
          discoveredFrom: null,
        });
        continue;
      }
    }
    if (!isOwnOrigin(options.baseUrl, entryUrl, policy)) {
      offOrigin += 1;
      recordExternal(entryUrl, 'LINK', '/');
      continue;
    }

    const landed = await surface.goto(entryUrl);
    if (!landed.ok) {
      unreachable += 1;
      progress(`could not open ${entryUrl}`);
      continue;
    }
    seenUrls.push(surface.url());
    const snapshot = await surface.snapshot();
    const signature = stateSignatureOf(snapshot, routeMode, policy, primitives);
    if (states.has(signature.id)) continue;

    const replay: ReplayPath = {
      steps: [{ kind: 'GOTO', target: entryUrl, label: entryUrl, selector: null }],
      verified: true,
      divergedTo: null,
      strategy: 'REPLAY',
    };
    const pageControls = await surface.controls();
    const record = register(signature, snapshot, replay, 0, null, pageControls);
    pending.push(record.signature.id);
  }

  /*
   * Re-detect the mode now that real URLs have been seen. The entry list is
   * what the URL crawl produced, and in a hash-routed app that list is one URL
   * — which is the very defect — so the URLs the browser actually settled on
   * are better evidence. Upgrading UNDETERMINED is safe; overriding a decided
   * mode is not, because the states already registered are keyed under it.
   */
  if (routeMode === 'UNDETERMINED') {
    const better = detectRouteMode([...options.entryUrls, ...seenUrls]);
    if (better.mode !== 'UNDETERMINED') {
      routeMode = better.mode;
      routeModeWhy = `${better.why} (from the URLs the browser settled on)`;
    } else {
      routeModeWhy = better.why;
    }
  }

  // ── Expansion ─────────────────────────────────────────────────────────────

  while (pending.length > 0) {
    if (now() > deadline) {
      ledger.cap(
        'WALL_CLOCK',
        wallClockMillis,
        pending.length,
        null,
        `stopped after ${Math.round(wallClockMillis / 1000)}s with ${pending.length} state(s) still to expand`,
      );
      unvisitedQueued += pending.length;
      for (const id of pending) pushSample(frontierSample, id);
      break;
    }
    if (stats.interactions >= interactionBudget) {
      ledger.budget('INTERACTION_BUDGET', interactionBudget, pending.length, null);
      unvisitedQueued += pending.length;
      for (const id of pending) pushSample(frontierSample, id);
      break;
    }
    if (nodes.length >= maxStates) {
      ledger.cap(
        'PAGE_BUDGET',
        maxStates,
        pending.length,
        null,
        `stopped at the ${maxStates}-state budget with ${pending.length} state(s) still to expand`,
      );
      unvisitedQueued += pending.length;
      for (const id of pending) pushSample(frontierSample, id);
      break;
    }

    const stateId = pending.shift();
    if (stateId === undefined) break;
    const record = states.get(stateId);
    if (record === undefined) continue;

    if (!(await reach(record))) {
      /*
       * `unvisitedQueued` and NOT `unreachable`, and my own test is what made
       * the difference matter. `unreachable` means "failed to load, unknown
       * whether it exists"; this state we have STOOD IN, so we know it exists
       * and we know we never read its controls. Filing it under `unreachable`
       * kept it out of `lowerBoundMoreUrls`, and the crawl then reported
       * CONVERGED with a discovered, unexpanded state sitting in it — the
       * exact sentence this module is not allowed to produce.
       */
      stats.replayFailures += 1;
      unvisitedQueued += 1;
      pushSample(frontierSample, stateId);
      progress(`could not get back to ${stateId}`);
      continue;
    }
    record.pending = false;
    stats.statesVisited += 1;
    progress(`exploring ${record.signature.route} (${record.signature.digest})`);

    const { raw, admitted } = await readControls(record);
    attachAffordances(nodes, record, raw);

    if (record.depth >= maxDepth) {
      ledger.cap(
        'DEPTH',
        maxDepth,
        admitted.length,
        record.signature.route,
        `${record.signature.route} is ${record.depth} interaction(s) deep; ${admitted.length} further control(s) were not driven`,
      );
      unvisitedQueued += admitted.length;
      for (const candidate of admitted) pushSample(frontierSample, candidate.identity);
      continue;
    }

    let take = admitted;
    if (admitted.length > perNodeBudget) {
      take = admitted.slice(0, perNodeBudget);
      const dropped = admitted.slice(perNodeBudget);
      ledger.budget(
        'PER_NODE_INTERACTION_BUDGET',
        perNodeBudget,
        dropped.length,
        record.signature.route,
      );
      unvisitedQueued += dropped.length;
      for (const candidate of dropped) pushSample(frontierSample, candidate.identity);
    }

    for (const [index, candidate] of take.entries()) {
      if (stats.interactions >= interactionBudget) {
        const remaining = take.length - index;
        ledger.budget('INTERACTION_BUDGET', interactionBudget, remaining, record.signature.route);
        unvisitedQueued += remaining;
        for (const left of take.slice(index)) pushSample(frontierSample, left.identity);
        break;
      }
      if (candidate.kind === 'PAGINATION') {
        const followed = paginationFollowed.get(record.signature.route) ?? 0;
        if (followed >= maxPaginationFollow) {
          ledger.cap(
            'PER_TEMPLATE_BUDGET',
            maxPaginationFollow,
            1,
            record.signature.route,
            `followed ${maxPaginationFollow} page(s) of ${record.signature.route}; later pages were not enumerated`,
          );
          unvisitedQueued += 1;
          pushSample(frontierSample, candidate.identity);
          continue;
        }
        paginationFollowed.set(record.signature.route, followed + 1);
      }

      /*
       * Get back to the parent before each click. The previous click left the
       * browser in the CHILD state, and clicking the next candidate from there
       * would record an edge from a state it did not come from — a wrong edge
       * is worse than a missing one, because the Generator would emit a test
       * that cannot pass.
       */
      if (index > 0 && !(await reach(record))) {
        stats.replayFailures += 1;
        const remaining = take.length - index;
        unvisitedQueued += remaining;
        for (const left of take.slice(index)) pushSample(frontierSample, left.identity);
        break;
      }

      const typed = await maybeFillSearch(
        surface,
        candidate,
        raw,
        searchProbe,
        record.signature.route,
      );
      const clicked = await surface.click(candidate.ref);
      stats.interactions += 1;
      if (!clicked.ok) {
        unreachable += 1;
        controls.push(sighting(record, candidate, null, true, null));
        continue;
      }

      const navigations = available.has('HISTORY_HOOK') ? await surface.drainNavigations() : [];
      if (stats.clientNavigations !== null) stats.clientNavigations += navigations.length;

      const landedUrl = surface.url();
      if (!isOwnOrigin(options.baseUrl, landedUrl, policy)) {
        offOrigin += 1;
        recordExternal(landedUrl, 'REDIRECT', record.signature.route);
        controls.push(sighting(record, candidate, null, true, null));
        continue;
      }

      const snapshot = await surface.snapshot();
      const after = stateSignatureOf(snapshot, routeMode, policy, primitives);

      if (after.id === record.signature.id) {
        /*
         * Two different findings wear the same shape here, and calling them one
         * thing was the most flattering mistake in this file.
         *
         * For a control that promises nothing, this IS a measurement: the
         * control is inert, or it toggled something the signature deliberately
         * ignores, and it is COVERED as a sighting that leads nowhere.
         *
         * For a `PAGINATION` or `WIZARD_STEP` control it is the ABSENCE of one.
         * Those two kinds have no honest "already there" reading, so an
         * unchanged signature means either the application is broken or our
         * digest could not see the change — and the second is routine: a
         * client-side pager leaves the URL alone, and page 2's rows and its
         * "Page 2 of 5" normalise to page 1's digest exactly. Recorded as
         * inert, the remaining pages are never enumerated, no cap bites, and
         * `enumerationOutcome` is handed an empty frontier and says CONVERGED.
         * So it gets its own count and its own sentence in `why`, and the
         * frontier is deliberately NOT incremented — a lower bound of 1 "more"
         * behind a control that may genuinely be spent would be inventing the
         * number instead of naming the gap.
         */
        if (DECLARES_A_TRANSITION.has(candidate.kind)) {
          stats.indistinguishableInteractions += 1;
        } else {
          stats.noOpInteractions += 1;
        }
        controls.push(sighting(record, candidate, null, true, null));
        continue;
      }

      const replay: ReplayPath = {
        steps: [
          ...record.replay.steps,
          ...(typed === null
            ? []
            : [
                {
                  kind: 'FILL' as const,
                  target: typed.identity,
                  label: typed.label,
                  selector: typed.selector,
                  value: searchProbe,
                },
              ]),
          {
            kind: 'CLICK' as const,
            target: candidate.identity,
            label: candidate.label,
            selector: candidate.selector,
          },
        ],
        verified: false,
        divergedTo: null,
        strategy: 'REPLAY',
      };

      const known = states.get(after.id);
      if (known === undefined && record.depth + 1 > maxDepth) {
        beyondDepth += 1;
        pushSample(frontierSample, after.id);
      }

      const childControls = known === undefined ? await surface.controls() : [];
      const child =
        known ??
        register(after, snapshot, replay, record.depth + 1, record.signature.id, childControls);

      edges.push({
        id: `iedge-${edges.length}`,
        from: record.nodeId,
        to: child.nodeId,
        action: `click "${candidate.label}"`,
        selector: candidate.selector,
        controlIdentity: candidate.identity,
        kind: candidate.kind,
        replay: child.replay,
        navigation: navigations[0]?.kind ?? null,
      });
      controls.push(sighting(record, candidate, null, true, after.id));

      if (known === undefined && record.depth + 1 <= maxDepth) {
        pending.push(child.signature.id);
      }
    }
  }

  const caps = ledger.capList();
  const budgets = ledger.budgetList();
  /*
   * DISTINCT refused SURFACES, which is what the comment on `pathRefusals`
   * already claimed and what the arithmetic did not deliver.
   *
   * `excluded.length + refusals.length - pathRefusals` counts RECORDS, and a
   * refusal is recorded once per STATE it is seen on. A "Log out" link in the
   * site nav of a four-route app with six dashboard states is sixteen records
   * for four surfaces, so the one number in the frontier whose job is to be
   * defensible read four times too high. De-duplicating on `surfaceItemKey` is
   * the fix: it is the inventory key, so two records that would upsert the same
   * `CoverageItem` are one surface by construction. Entry-URL exclusions have
   * no refusal record (nothing classified them, so there is no control), which
   * is what `discoveredFrom === null` identifies, and they de-duplicate on the
   * URL instead.
   */
  const distinctRefusedSurfaces = new Set(refusals.map((entry) => entry.surfaceItemKey));
  const distinctEntryExclusions = new Set(
    excluded.filter((entry) => entry.discoveredFrom === null).map((entry) => entry.url),
  );
  const frontier: Frontier = {
    unvisitedQueued,
    beyondDepth,
    excluded: distinctRefusedSurfaces.size + distinctEntryExclusions.size,
    offOrigin,
    unreachable,
    atLeastMoreUrls: lowerBoundMoreUrls({ unvisitedQueued, beyondDepth }),
    sample: frontierSample.slice(0, 20),
    sampleTruncated: frontierSample.length > 20,
  };

  /*
   * `enumerationOutcome` is the shared adjudication and is used rather than
   * re-decided here, because "converged" has one definition in this product and
   * a second one in this file would be the fork that lets the word be claimed
   * on a truncated crawl. The budgets that bit are folded into `why`, because
   * they are not expressible as `CapBite`s and `enumerationOutcome` can only
   * see the caps.
   */
  const adjudicated = enumerationOutcome({
    visitedPages: stats.statesVisited,
    frontier,
    caps,
  });
  const bitBudgets = budgetsThatBit(budgets);
  /*
   * The sentence that keeps `CONVERGED` from being read as "there was nothing
   * more". `enumerationOutcome` has three values and none of them is "we
   * stopped seeing"; substituting STOPPED here would trade one wrong label for
   * another (its own label says a budget ran out, and none did) and would fork
   * the one definition of convergence this product has. So the count is named
   * in the same string the caller folds into `truncatedReason`, and the
   * missing outcome member is in this review's report.
   */
  const blind =
    stats.indistinguishableInteractions === 0
      ? ''
      : `; ${stats.indistinguishableInteractions} control(s) that DECLARE a transition left the ` +
        `state signature unchanged, so whatever is behind them was neither enumerated nor ruled out`;
  /*
   * A guard that cannot fire today, kept on purpose. See
   * `budgetsFeedTheFrontier`: every bite site adds its `discarded` count to the
   * frontier, so `enumerationOutcome` has already answered STOPPED by the time
   * we get here. It stays because the alternative to an unreachable check is
   * the word "converged" printed over a crawl that stopped, and the invariant
   * that makes it unreachable is one `+=` away from untrue.
   */
  const outcome: EnumerationOutcome =
    adjudicated.outcome === 'CONVERGED' && bitBudgets.length > 0 ? 'STOPPED' : adjudicated.outcome;
  const why =
    (bitBudgets.length === 0
      ? adjudicated.why
      : `${adjudicated.why}; interaction budgets that applied: ${bitBudgets
          .map(
            (budget) =>
              `${INTERACTION_BUDGET_LABELS[budget.budget]} (${budget.discarded} discarded)`,
          )
          .join(', ')}`) + blind;

  return {
    nodes,
    edges,
    controls,
    formlessForms,
    routeMode,
    routeModeWhy,
    refusals,
    excluded,
    externals: [...externals.values()],
    caps,
    budgets,
    frontier,
    outcome,
    why,
    unavailable,
    stats,
  };
}

/**
 * The kinds whose markup PROMISES a state we have not seen, so an unchanged
 * signature after clicking one is an unknown rather than a measurement. See
 * `InteractionStats.indistinguishableInteractions`.
 */
const DECLARES_A_TRANSITION: ReadonlySet<InteractionKind> = new Set<InteractionKind>([
  'PAGINATION',
  'WIZARD_STEP',
]);

const CAPABILITY_COST: Record<InteractionCapability, string> = {
  CLICK: 'nothing behind a control can be reached; the interaction pass is FAILED, not empty',
  GOTO: 'no state can be reached or returned to; the interaction pass is FAILED, not empty',
  SNAPSHOT: 'no state signature can be computed, so every click would mint a new node',
  CONTROLS: 'no control can be found; the control denominator is UNKNOWN, not zero',
  FILL: 'a search box cannot be filled, so search-result states were not reached',
  HISTORY_HOOK:
    'client-side navigations were not observed: the count is UNKNOWN rather than zero, and a same-document transition cannot be told from a document load',
  NAVIGATION_STATUS:
    'FlowNode.status.code is null for every state, so shouldGenerateAgainst refuses them all rather than assuming 200',
  DIALOG_REGION:
    'an open dialog is invisible to the signature, so a modal and the page behind it may read as one state',
  BACK: 'none — REPLAY is the reversal strategy and does not use it',
};

function emptyFrontier(): Frontier {
  return {
    unvisitedQueued: 0,
    beyondDepth: 0,
    excluded: 0,
    offOrigin: 0,
    unreachable: 0,
    atLeastMoreUrls: 0,
    sample: [],
    sampleTruncated: false,
  };
}

function pushSample(sample: string[], value: string): void {
  if (sample.length < 200) sample.push(value);
}

/** The `EXCLUSION_KINDS` member a `policyDecision` rule corresponds to. */
function exclusionKindFor(rule: string): ExclusionKind {
  if (rule.startsWith('includeGlobs')) return 'POLICY_NOT_INCLUDED';
  return 'POLICY_EXCLUDE';
}

function isAuthWall(
  route: string,
  states: ReadonlyMap<string, StateRecord>,
  parentStateId: string,
): boolean {
  if (!/\/(login|signin|sign-in|auth)\b/i.test(route)) return false;
  const parent = states.get(parentStateId);
  if (parent === undefined) return false;
  return !/\/(login|signin|sign-in|auth)\b/i.test(parent.signature.route);
}

function sighting(
  record: StateRecord,
  candidate: InteractionCandidate,
  exercise: SurfaceExercise | null,
  exercised: boolean,
  leadsTo: string | null,
): ControlSighting {
  return {
    stateId: record.signature.id,
    route: record.signature.route,
    identity: candidate.identity,
    label: candidate.label,
    kind: candidate.kind,
    affordanceKind: affordanceKindFor(candidate.kind),
    selector: candidate.selector,
    exercise,
    exercised,
    leadsTo,
  };
}

function refusal(
  record: StateRecord,
  candidate: InteractionCandidate,
  exercise: SurfaceExercise,
): InteractionRefusal {
  return {
    stateId: record.signature.id,
    route: record.signature.route,
    identity: candidate.identity,
    label: candidate.label,
    kind: candidate.kind,
    exercise,
    surfaceItemKey: surfaceKey('COMPONENT_STATE', candidate.identity),
  };
}

/** The three-value vocabulary `FlowNode.affordances` already uses. */
export function affordanceKindFor(kind: InteractionKind): 'link' | 'button' | 'input' {
  if (kind === 'LINK') return 'link';
  if (kind === 'SEARCH_SUBMIT' || kind === 'FORM_SUBMIT') return 'input';
  return 'button';
}

/**
 * Fill the state's `FlowNode.affordances` from the sightings on it.
 *
 * REPLACES crawler.ts's first-sighting-only, 20-per-page, non-empty-innerText-
 * only capture. The cap that applies here is `controlsPerPage` and it is
 * disclosed; the old one was a silent `slice(0, 20)`.
 */
export function attachAffordances(
  nodes: InteractionNode[],
  record: { nodeId: string; signature: StateSignature },
  raw: readonly RawControl[],
): void {
  const node = nodes.find((candidate) => candidate.id === record.nodeId);
  if (node === undefined) return;

  /*
   * Keyed on the per-page IDENTITY and not on the label, which is the
   * locators.ts defect in miniature: keying on the label here would drop the
   * second of two same-named controls in different landmarks.
   */
  const seen = new Set<string>();
  for (const affordance of node.affordances) {
    seen.add(`${affordance.kind}|${affordance.label}`);
  }
  for (const element of raw) {
    if (element.hidden) continue;
    /*
     * Fields are affordances too. crawler.ts recorded `button,
     * input[type=submit]` with non-empty innerText and nothing else, so a page
     * of inputs reported no controls at all — and the 'input' member of the
     * affordance vocabulary had no producer.
     */
    const kind = isFieldControl(element) ? null : classifyControl(element);
    if (kind === null && !isFieldControl(element)) continue;
    const identity = identityOfRaw(element, record.signature.route);
    if (seen.has(identity)) continue;
    seen.add(identity);
    node.affordances.push({
      label: labelOf(element),
      selector: selectorFor(element),
      kind: kind === null ? 'input' : affordanceKindFor(kind),
    });
  }
}

/**
 * Type into the search box a search submit belongs to, so the submit produces
 * a results state rather than an empty-query no-op.
 *
 * The probe is a LITERAL from the options, never a generated or real value: a
 * crawl typing a plausible email into a search box is a crawl that may match a
 * real customer record, and the results page is then a screenshot of somebody's
 * data.
 */
async function maybeFillSearch(
  surface: InteractionSurface,
  candidate: InteractionCandidate,
  raw: readonly RawControl[],
  probe: string,
  route: string,
): Promise<{ identity: string; label: string; selector: Selector } | null> {
  if (candidate.kind !== 'SEARCH_SUBMIT') return null;
  const box = raw.find(
    (element) =>
      isFieldControl(element) &&
      !element.hidden &&
      (element.landmark ?? '*') === (candidate.landmark ?? '*') &&
      (element.type === 'search' ||
        element.role === 'searchbox' ||
        SEARCH_HINT.test(element.name ?? '') ||
        SEARCH_HINT.test(accessibleName(element))),
  );
  if (box === undefined) return null;
  const filled = await surface.fill(box.ref, probe);
  if (!filled) return null;
  return {
    identity: identityOfRaw(box, route),
    label: labelOf(box),
    selector: selectorFor(box),
  };
}

// ─── The adapter ────────────────────────────────────────────────────────────

/**
 * The playwright-shaped half of the surface. A `Page`-like object, typed
 * structurally so this file does not import playwright and so the adapter can
 * be exercised against anything that offers the same four methods.
 *
 * WHAT IS NOT TESTED HERE, said plainly, in the style crawler.test.ts
 * established: every function below runs inside `page.evaluate()` and needs a
 * real browser. A unit test of it could only prove that a mock DOM matches the
 * code. Naming the gap beats a test that reads as coverage and measures
 * nothing — and it is exactly why all the judgement in this module lives above
 * this line, over plain data, where it IS tested.
 */
export interface PageLike {
  url(): string;
  title(): Promise<string>;
  goto(
    url: string,
    options?: { waitUntil?: PageLifecycle | 'commit'; timeout?: number },
  ): Promise<{ status(): number } | null>;
  goBack(options?: { timeout?: number }): Promise<{ status(): number } | null>;
  waitForLoadState(state?: PageLifecycle, options?: { timeout?: number }): Promise<void>;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  /*
   * `Promise<unknown>` and not `Promise<void>`: playwright 1.62 returns a
   * `Disposable` here, and the compile-time seam assertion below caught it.
   * The adapter awaits it and discards it — the handle would only be needed to
   * REMOVE the history hook, and a crawl never wants to.
   */
  addInitScript(script: { content: string }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
}

/*
 * The literal unions playwright declares. Written out rather than `string`,
 * and this is not pedantry: with `strictFunctionTypes` a parameter typed
 * `string` here makes a real `Page` NOT assignable to `PageLike`, and the
 * integrator's first line — `playwrightInteractionSurface(page)` — fails to
 * compile with a message about `waitForLoadState`. I found that by trying it.
 */
type PageLifecycle = 'load' | 'domcontentloaded' | 'networkidle';

/*
 * THE SEAM, ASSERTED AT COMPILE TIME.
 *
 * A type-only import, so nothing about this line reaches the runtime, the
 * module still takes its browser as an injected interface, and the tests still
 * run against a literal. What it buys is the one failure mode this repo is
 * named for: `playwrightInteractionSurface` being correct, tested, documented
 * as serving the crawl — and impossible to actually call, because `Page` drifted
 * one optional parameter away from `PageLike` and nobody found out until the
 * integration. If playwright changes, THIS line goes red, in this file, with
 * this comment next to it.
 */
type AssertPageIsPageLike<T extends PageLike> = T;
export type PlaywrightPageSatisfiesPageLike = AssertPageIsPageLike<PlaywrightPage>;

/**
 * The attribute the adapter stamps so a click can name an element the last read
 * found.
 *
 * Playwright element handles do not survive a navigation and a CSS path is not
 * unique in a list, so the read stamps and the click selects on the stamp. It
 * is a `data-` attribute, which changes no behaviour and is wiped by the next
 * load; the one risk is an application whose own CSS selects on `[data-*]`
 * wildcards, and it is disclosed here rather than left to be discovered.
 */
export const REF_ATTRIBUTE = 'data-qaai-ref';

/** Builds an {@link InteractionSurface} over a playwright `Page`. */
export function playwrightInteractionSurface(
  page: PageLike,
  options: { readCap?: number } = {},
): InteractionSurface {
  const readCap = options.readCap ?? 500;
  let lastStatus: number | null = null;
  let historyInstalled = false;

  const settle = async (): Promise<void> => {
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  };

  const installHistoryHook = async (): Promise<boolean> => {
    if (historyInstalled) return true;
    try {
      await page.addInitScript({ content: HISTORY_HOOK_SCRIPT });
      historyInstalled = true;
      return true;
    } catch {
      return false;
    }
  };

  return {
    capabilities(): readonly InteractionCapability[] {
      const base: InteractionCapability[] = [
        'CLICK',
        'GOTO',
        'SNAPSHOT',
        'CONTROLS',
        'FILL',
        'NAVIGATION_STATUS',
        'DIALOG_REGION',
        'BACK',
      ];
      // Reported only once the init script is actually installed, because a
      // capability we claim and do not have is the lie this field exists to
      // prevent.
      return historyInstalled ? [...base, 'HISTORY_HOOK'] : base;
    },
    url(): string {
      return page.url();
    },
    async goto(url: string): Promise<NavigationOutcome> {
      await installHistoryHook();
      try {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        });
        await settle();
        lastStatus = response === null ? null : response.status();
        return { ok: true, url: page.url(), status: lastStatus, error: null };
      } catch (error) {
        lastStatus = null;
        return { ok: false, url: page.url(), status: null, error: String(error) };
      }
    },
    async back(): Promise<NavigationOutcome> {
      try {
        const response = await page.goBack({ timeout: 10_000 });
        await settle();
        lastStatus = response === null ? null : response.status();
        return { ok: true, url: page.url(), status: lastStatus, error: null };
      } catch (error) {
        return { ok: false, url: page.url(), status: null, error: String(error) };
      }
    },
    async snapshot(): Promise<RawSnapshot> {
      const read = await page
        .evaluate<Omit<RawSnapshot, 'url' | 'title' | 'statusCode'>>(SNAPSHOT_SCRIPT)
        .catch(() => null);
      const title = await page.title().catch(() => '');
      if (read === null) {
        // Null everywhere rather than empty structures: an unreadable page is
        // not a page with no structure, and the second claim would make every
        // such page one state.
        return {
          url: page.url(),
          title,
          structure: [],
          dialogName: null,
          activeMarkers: [],
          statusCode: lastStatus,
          isErrorPage: false,
        };
      }
      return { ...read, url: page.url(), title, statusCode: lastStatus };
    },
    async controls(): Promise<RawControl[]> {
      const read = await page.evaluate<RawControl[]>(CONTROLS_SCRIPT, readCap).catch(() => null);
      return read ?? [];
    },
    async click(ref: string): Promise<ClickOutcome> {
      const before = page.url();
      try {
        await page.click(`[${REF_ATTRIBUTE}="${ref}"]`, { timeout: 10_000 });
        await settle();
        const navigated = page.url() !== before;
        return { ok: true, error: null, navigated, status: navigated ? lastStatus : null };
      } catch (error) {
        return { ok: false, error: String(error), navigated: false, status: null };
      }
    },
    async fill(ref: string, value: string): Promise<boolean> {
      try {
        await page.fill(`[${REF_ATTRIBUTE}="${ref}"]`, value, { timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },
    async drainNavigations(): Promise<RawNavigation[]> {
      if (!historyInstalled) return [];
      const read = await page
        .evaluate<RawNavigation[]>(
          `(() => { const w = window; const out = w.__qaaiNav ?? []; w.__qaaiNav = []; return out; })()`,
        )
        .catch(() => []);
      return read;
    },
  };
}

/**
 * Patches pushState/replaceState and listens for popstate/hashchange.
 *
 * Installed as an INIT script so it is in place before the application's router
 * is, which is the only way a client-side navigation that happens during
 * hydration is seen at all.
 */
const HISTORY_HOOK_SCRIPT = `
(() => {
  const w = window;
  if (w.__qaaiNavInstalled) return;
  w.__qaaiNavInstalled = true;
  w.__qaaiNav = [];
  const record = (kind) => { try { w.__qaaiNav.push({ kind, url: location.href }); } catch {} };
  const push = history.pushState;
  const replace = history.replaceState;
  history.pushState = function (...args) { const r = push.apply(this, args); record('PUSH'); return r; };
  history.replaceState = function (...args) { const r = replace.apply(this, args); record('REPLACE'); return r; };
  addEventListener('popstate', () => record('POP'));
  addEventListener('hashchange', () => record('HASH'));
})()
`;

/** Reads the accessibility-shaped structure a state signature is computed from. */
const SNAPSHOT_SCRIPT = `
(() => {
  const nameOf = (el) => (
    el.getAttribute('aria-label') ||
    (el.innerText || el.textContent || '').trim().slice(0, 80)
  );
  const roleOf = (el) => el.getAttribute('role') || ({
    a: 'link', button: 'button', nav: 'navigation', main: 'main', header: 'banner',
    footer: 'contentinfo', aside: 'complementary', form: 'form', table: 'table',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', li: 'listitem',
    ul: 'list', ol: 'list', dialog: 'dialog', summary: 'button', input: 'textbox',
    select: 'combobox', textarea: 'textbox', label: 'generic'
  })[el.tagName.toLowerCase()] || 'generic';
  const depthOf = (el) => { let d = 0; let p = el.parentElement; while (p) { d++; p = p.parentElement; } return d; };

  const structure = [];
  const nodes = document.querySelectorAll(
    'main, nav, header, footer, aside, form, table, dialog, [role], h1, h2, h3, h4, li, button, a[href], input, select, textarea, summary'
  );
  for (const el of Array.from(nodes).slice(0, 600)) {
    structure.push({ role: roleOf(el), name: nameOf(el), depth: depthOf(el) });
  }

  const dialog = document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]');
  const activeMarkers = Array.from(
    document.querySelectorAll('[aria-current], [aria-selected="true"], [data-state="active"], [aria-expanded="true"]')
  ).slice(0, 40).map(nameOf).filter(Boolean);

  const body = (document.body && document.body.innerText) || '';
  const isErrorPage = /\\b(404|not found|page not found|500|something went wrong|internal server error)\\b/i.test(body.slice(0, 2000));

  return { structure, dialogName: dialog ? nameOf(dialog) : null, activeMarkers, isErrorPage };
})()
`;

/**
 * Reads every control, STAMPS a ref on each, and counts duplicate
 * role+name pairs so `nth` is a measurement rather than a guess.
 *
 * Captures the real control denominator: links, buttons, inputs, `role=button`,
 * click-handler divs, and icon-only controls named only by `aria-label` or
 * `title`. crawler.ts reads `button, input[type=submit]` with non-empty
 * innerText, which excludes every icon button in a modern UI.
 */
const CONTROLS_SCRIPT = `
((cap) => {
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role]', '[onclick]', '[aria-expanded]', '[aria-controls]', '[data-state]',
    '[contenteditable="true"]'
  ].join(', ');

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag);
      node = parent;
    }
    return parts.join(' > ');
  };

  const attr = (el, name) => { const v = el.getAttribute(name); return v === null || v.trim() === '' ? null : v; };
  const length = (el, name) => {
    const v = attr(el, name); if (v === null) return null;
    const n = Number.parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const landmarkOf = (el) => {
    let p = el;
    while (p) {
      const role = p.getAttribute && p.getAttribute('role');
      const tag = p.tagName ? p.tagName.toLowerCase() : '';
      if (role && ['navigation','main','banner','contentinfo','complementary','search','region','dialog','form'].includes(role))
        return (p.getAttribute('aria-label') || role);
      if (['nav','main','header','footer','aside','dialog'].includes(tag))
        return (p.getAttribute('aria-label') || tag);
      p = p.parentElement;
    }
    return null;
  };
  const visible = (el) => {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const nameOf = (el) => {
    const labels = el.labels;
    const label = labels && labels.length > 0 ? (labels[0].textContent || '').trim() : null;
    return el.getAttribute('aria-label') || label || (el.innerText || el.textContent || '').trim().slice(0, 80) || el.getAttribute('title') || '';
  };

  const forms = Array.from(document.querySelectorAll('form'));
  const elements = Array.from(document.querySelectorAll(SELECTOR)).slice(0, cap);

  const counts = new Map();
  for (const el of elements) {
    const key = (el.getAttribute('role') || el.tagName.toLowerCase()) + '|' + nameOf(el);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const seen = new Map();

  return elements.map((el, index) => {
    const ref = 'r' + index;
    el.setAttribute('${REF_ATTRIBUTE}', ref);
    const tag = el.tagName.toLowerCase();
    const labels = el.labels;
    const form = el.closest('form');
    const fieldset = el.closest('fieldset');
    const legend = fieldset ? fieldset.querySelector('legend') : null;
    const key = (el.getAttribute('role') || tag) + '|' + nameOf(el);
    const duplicate = (counts.get(key) || 0) > 1;
    const ordinal = seen.get(key) || 0;
    seen.set(key, ordinal + 1);
    return {
      ref,
      tag,
      type: attr(el, 'type'),
      role: attr(el, 'role'),
      rel: attr(el, 'rel'),
      text: (el.innerText || el.textContent || '').trim().slice(0, 80),
      ariaLabel: attr(el, 'aria-label'),
      title: attr(el, 'title'),
      testId: attr(el, 'data-testid') || attr(el, 'data-test-id'),
      placeholder: attr(el, 'placeholder'),
      label: labels && labels.length > 0 ? (labels[0].textContent || '').trim() : null,
      name: attr(el, 'name'),
      href: el.href || attr(el, 'formaction') || (form ? form.action : null) || null,
      ariaExpanded: attr(el, 'aria-expanded'),
      ariaControls: attr(el, 'aria-controls'),
      ariaHasPopup: attr(el, 'aria-haspopup'),
      ariaCurrent: attr(el, 'aria-current'),
      dataState: attr(el, 'data-state'),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      hidden: !visible(el),
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      contentEditable: el.getAttribute('contenteditable') === 'true',
      hasClickHandler: el.hasAttribute('onclick'),
      landmark: landmarkOf(el),
      formIndex: form ? forms.indexOf(form) : null,
      fieldset: legend ? (legend.textContent || '').trim() : null,
      options: tag === 'select'
        ? Array.from(el.options).map((o) => (o.textContent || '').trim()).filter(Boolean)
        : null,
      nth: duplicate ? ordinal : null,
      cssPath: cssPath(el),
      constraints: {
        maxLength: length(el, 'maxlength'),
        minLength: length(el, 'minlength'),
        min: attr(el, 'min'),
        max: attr(el, 'max'),
        step: attr(el, 'step'),
        pattern: attr(el, 'pattern'),
        inputMode: attr(el, 'inputmode'),
        autocomplete: attr(el, 'autocomplete'),
        accept: attr(el, 'accept'),
        multiple: el.hasAttribute('multiple'),
        validationMessage:
          (el.validity && el.validity.customError && el.validationMessage) || attr(el, 'title'),
      },
    };
  });
})
`;
