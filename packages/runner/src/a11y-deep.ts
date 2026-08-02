/**
 * Behavioural accessibility checks — the two thirds axe cannot see.
 *
 * The ACCESSIBILITY plugin runs axe-core, which is excellent at what it does and
 * what it does is READ MARKUP. Contrast ratios, missing alt text, a landmark
 * used twice: all of it is decidable from a static DOM. The barriers that
 * actually stop people using a product are not in the markup, they are in what
 * happens when you press a key:
 *
 *   - a control that never receives focus, so it may as well not exist;
 *   - a focus ring somebody removed in a reset stylesheet, so a keyboard user is
 *     navigating blind;
 *   - a widget that swallows Tab and never gives it back, which turns the rest
 *     of the page into a wall;
 *   - a dialog that opens and leaves focus behind it, or closes and drops focus
 *     at the top of the document;
 *   - an animation that keeps playing for someone who asked the operating system
 *     for less of it.
 *
 * None of that is visible to a static scan, and every one of it is a WCAG
 * failure a real user hits within seconds. This module drives a real page with a
 * real keyboard and reports what happened.
 *
 * ── Four rules this module is built around ──────────────────────────────────
 *
 * IT IS ADDITIVE AND OFF BY DEFAULT. A spec with no `deep` block behaves exactly
 * as it did before this file existed: axe runs, nothing else does. Every check
 * is switched on BY NAME, so a team adopts them one at a time instead of
 * inheriting a hundred new findings the morning after an upgrade.
 *
 * SEVERITY IS HONEST. There is exactly one CRITICAL here — a keyboard trap that
 * we confirmed cannot be escaped with Tab, Shift+Tab or Escape, which makes the
 * page unusable — and it is the only one that fails a test. A focus order that
 * disagrees with the visual order is MODERATE because the check is a heuristic
 * and a human has to confirm it. If everything were CRITICAL the severity would
 * carry no information and the gate keyed on it would be turned off.
 *
 * IT FAILS OPEN. A check that cannot run says so as an `a11y.inconclusive`
 * finding naming the check and the reason, and never throws: a detector that
 * swallows its own failure reports a clean page it never looked at, and a
 * reporting problem must never lose a run.
 *
 * IT DOES NOT MUTATE THE PAGE. No injected sentinels, no data-attributes, no
 * globals on `window`. Element identity is carried by a JSHandle to an array
 * that lives only in the driver, so the application under test sees exactly the
 * DOM it built. The cost is one blind spot, documented at `analyseTabRing`.
 *
 * The pure analysis (name resolution, indicator comparison, order, ring shape)
 * is separated from the browser work on purpose: it is where the judgement calls
 * live, and it is unit-testable without a browser. See a11y-deep.test.ts.
 */

import { z } from 'zod';
import type { Finding } from '@qaai/shared';
import type { JSHandle, Page } from 'playwright';

// ─── Codes and criteria ──────────────────────────────────────────────────────

/**
 * Prefix on every code this module emits.
 *
 * axe findings use the bare axe rule id (`color-contrast`, `aria-hidden-focus`),
 * so a namespace keeps the two families apart for a mute rule, a gate, or a
 * dashboard filter — and guarantees a code here can never collide with a rule id
 * axe adds in a future release.
 */
export const DEEP_A11Y_CODE_PREFIX = 'a11y.';

export function isDeepA11yFinding(finding: Finding): boolean {
  return finding.code.startsWith(DEEP_A11Y_CODE_PREFIX);
}

/** A check that could not run. Evidence that we did not look, never that it is clean. */
export function isInconclusiveDeepA11yFinding(finding: Finding): boolean {
  return finding.code.startsWith(`${DEEP_A11Y_CODE_PREFIX}inconclusive`);
}

interface WcagCriterion {
  id: string;
  name: string;
  level: 'A' | 'AA' | 'AAA';
  /** Understanding-document slug; every finding gets the URL as its helpUrl. */
  slug: string;
}

const WCAG = {
  nonTextContrast: {
    id: '1.4.11',
    name: 'Non-text Contrast',
    level: 'AA',
    slug: 'non-text-contrast',
  },
  keyboard: { id: '2.1.1', name: 'Keyboard', level: 'A', slug: 'keyboard' },
  noKeyboardTrap: { id: '2.1.2', name: 'No Keyboard Trap', level: 'A', slug: 'no-keyboard-trap' },
  pauseStopHide: { id: '2.2.2', name: 'Pause, Stop, Hide', level: 'A', slug: 'pause-stop-hide' },
  animationFromInteractions: {
    id: '2.3.3',
    name: 'Animation from Interactions',
    level: 'AAA',
    slug: 'animation-from-interactions',
  },
  focusOrder: { id: '2.4.3', name: 'Focus Order', level: 'A', slug: 'focus-order' },
  linkPurpose: {
    id: '2.4.4',
    name: 'Link Purpose (In Context)',
    level: 'A',
    slug: 'link-purpose-in-context',
  },
  focusVisible: { id: '2.4.7', name: 'Focus Visible', level: 'AA', slug: 'focus-visible' },
  labelsOrInstructions: {
    id: '3.3.2',
    name: 'Labels or Instructions',
    level: 'A',
    slug: 'labels-or-instructions',
  },
  nameRoleValue: { id: '4.1.2', name: 'Name, Role, Value', level: 'A', slug: 'name-role-value' },
} as const satisfies Record<string, WcagCriterion>;

function understandingUrl(criterion: WcagCriterion): string {
  return `https://www.w3.org/WAI/WCAG21/Understanding/${criterion.slug}.html`;
}

// Findings are persisted with `message` truncated at 2000 chars and `location` at
// 1000 (apps/worker/src/processors/run.ts). Cut them here so the text ends in an
// ellipsis rather than mid-word.
const MESSAGE_LIMIT = 1800;
const LOCATION_LIMIT = 900;

// ─── Configuration: off by default, every check switched on by name ──────────

/**
 * Turns `true` / `false` into the object form, so a spec can say either
 * `keyboardTraps: true` or `keyboardTraps: { enabled: true, … }`.
 */
function toggled<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (value === true ? {} : value === false ? { enabled: false } : value),
    schema,
  );
}

const keyboardTraversalSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * A hard stop on Tab presses. A page with a hundred controls needs about two
   * hundred; the cap is what keeps a pathological ring from becoming the reason
   * a run never finishes.
   */
  maxTabStops: z.number().int().positive().max(2000).default(200),
  /** Compare each stop's computed style against its unfocused baseline. */
  focusVisible: z.boolean().default(true),
  /** Compare the tab order against the on-screen geometry. */
  visualOrder: z.boolean().default(true),
  budgetMs: z.number().int().positive().max(600_000).default(30_000),
});

const keyboardTrapsSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Keys tried, in order, to escape a stuck ring. Escape is what a dialog
   * listens for; a widget that needs something else is exactly the case WCAG
   * 2.1.2 says must be documented to the user.
   */
  escapeKeys: z.array(z.string().min(1)).default(['Escape']),
});

/**
 * Names that pass a "has a label" check and tell a screen-reader user nothing.
 * Lower-cased and compared whole, never as substrings: "Read more about the
 * returns policy" is a fine name and must not match "read more".
 */
const DEFAULT_UNINFORMATIVE_NAMES = [
  'click here',
  'click',
  'here',
  'more',
  'read more',
  'learn more',
  'details',
  'link',
  'button',
  'image',
  'icon',
  'go',
  'ok',
  'yes',
  'no',
  'this',
  'untitled',
];

const accessibleNamesSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Controls to leave alone — a third-party widget, usually. Matched as a
   * SUBSTRING of the element's generated selector path (`#intercom`, `.vendor`),
   * not evaluated as a CSS selector, so it costs nothing per element.
   */
  ignoreSelectors: z.array(z.string().min(1)).default([]),
  /** Replaces the built-in list when set; matched case-insensitively, whole-string. */
  uninformativeNames: z.array(z.string().min(1)).default(DEFAULT_UNINFORMATIVE_NAMES),
});

const modalSchema = z.object({
  name: z.string().min(1),
  /** The control that opens the dialog. Driven with the keyboard, not a mouse. */
  trigger: z.string().min(1),
  /** The dialog container. Defaults to whatever `[role=dialog], dialog[open], [aria-modal=true]` finds. */
  dialog: z.string().min(1).optional(),
  /** A close control, tried after the escape key. */
  close: z.string().min(1).optional(),
  /** Set null for a dialog that deliberately ignores Escape. */
  closeKey: z.string().min(1).nullable().default('Escape'),
  expectFocusRestored: z.boolean().default(true),
  /** Tab presses used to prove the dialog holds focus. */
  maxTrapProbes: z.number().int().positive().max(200).default(25),
});

const routeChangeSchema = z.object({
  name: z.string().min(1),
  /** A link or control that changes the view without a full page load. */
  trigger: z.string().min(1),
  /** Where focus should land. Defaults to "anywhere that is not <body>". */
  expectFocus: z.string().min(1).optional(),
});

const focusManagementSchema = z.object({
  enabled: z.boolean().default(true),
  modals: z.array(modalSchema).default([]),
  routeChanges: z.array(routeChangeSchema).default([]),
  budgetMs: z.number().int().positive().max(600_000).default(30_000),
});

const reducedMotionSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Below this, motion is a transition rather than an animation and reporting it
   * would bury the infinite carousel under two hundred 150ms hovers.
   */
  longAnimationMs: z.number().int().positive().default(1000),
});

const forcedColorsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Cap on elements inspected, so the pass stays sub-second on a huge DOM. */
  maxElements: z.number().int().positive().max(50_000).default(4000),
});

export const deepA11yConfigSchema = z.object({
  keyboardTraversal: toggled(keyboardTraversalSchema).optional(),
  keyboardTraps: toggled(keyboardTrapsSchema).optional(),
  accessibleNames: toggled(accessibleNamesSchema).optional(),
  focusManagement: toggled(focusManagementSchema).optional(),
  reducedMotion: toggled(reducedMotionSchema).optional(),
  forcedColors: toggled(forcedColorsSchema).optional(),
});

export const DEEP_A11Y_CHECKS = [
  'keyboardTraversal',
  'keyboardTraps',
  'accessibleNames',
  'focusManagement',
  'reducedMotion',
  'forcedColors',
] as const;

export type DeepA11yCheck = (typeof DEEP_A11Y_CHECKS)[number];

/** Every check present, every one carrying its own `enabled`. */
export interface ResolvedDeepA11yConfig {
  keyboardTraversal: z.infer<typeof keyboardTraversalSchema>;
  keyboardTraps: z.infer<typeof keyboardTrapsSchema>;
  accessibleNames: z.infer<typeof accessibleNamesSchema>;
  focusManagement: z.infer<typeof focusManagementSchema>;
  reducedMotion: z.infer<typeof reducedMotionSchema>;
  forcedColors: z.infer<typeof forcedColorsSchema>;
  /** Set when the block could not be read. Nothing runs; the reason is reported. */
  configError?: string;
}

function disabled<T extends z.ZodTypeAny>(schema: T): z.output<T> {
  return schema.parse({ enabled: false });
}

function allDisabled(): ResolvedDeepA11yConfig {
  return {
    keyboardTraversal: disabled(keyboardTraversalSchema),
    keyboardTraps: disabled(keyboardTrapsSchema),
    accessibleNames: disabled(accessibleNamesSchema),
    focusManagement: disabled(focusManagementSchema),
    reducedMotion: disabled(reducedMotionSchema),
    forcedColors: disabled(forcedColorsSchema),
  };
}

/**
 * Reads the `deep` block off a raw accessibility spec.
 *
 * Returns null when there is no block, which is the default and means the plugin
 * behaves exactly as it did before this module existed.
 *
 * A MALFORMED block is not silently ignored — it comes back with a
 * `configError`, so the run reports "you asked for deep checks and got none,
 * here is why". Treating a typo as "off" is the suppression this module exists
 * to make impossible.
 */
export function parseDeepA11yConfig(rawSpec: unknown): ResolvedDeepA11yConfig | null {
  if (rawSpec === null || typeof rawSpec !== 'object') return null;
  const block = (rawSpec as Record<string, unknown>).deep;
  if (block === undefined || block === null) return null;

  const parsed = deepA11yConfigSchema.safeParse(block);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return {
      ...allDisabled(),
      configError: `The deep block is invalid, so no deep accessibility check ran — ${issues}`,
    };
  }

  return {
    ...allDisabled(),
    ...Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)),
  };
}

export function enabledChecks(config: ResolvedDeepA11yConfig): DeepA11yCheck[] {
  return DEEP_A11Y_CHECKS.filter((check) => config[check].enabled);
}

// ─── The seam: what the browser hands back ───────────────────────────────────

/** Computed style values, keyed by CSS property name. */
export type FocusStyle = Record<string, string>;

/**
 * The properties compared between the focused and unfocused state.
 *
 * Passed INTO the page rather than read from module scope, because a function
 * handed to `page.evaluate` is serialised and loses every closure it had.
 */
export const FOCUS_STYLE_PROPS = [
  'outline-style',
  'outline-width',
  'outline-color',
  'outline-offset',
  'box-shadow',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-bottom-width',
  'border-bottom-color',
  'background-color',
  'background-image',
  'color',
  'text-decoration-line',
  'text-decoration-thickness',
  'transform',
  'filter',
  'opacity',
] as const;

export interface ElementRect {
  /** Document coordinates, so scrolling during traversal cannot move them. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One interactive element, as the page described it. */
export interface ElementSnapshot {
  index: number;
  selector: string;
  tag: string;
  /** `input` type, lower-cased. */
  type: string | null;
  /** The explicit `role` attribute, if any. */
  role: string | null;
  ariaLabel: string | null;
  ariaLabelledbyText: string | null;
  /** Ids named by aria-labelledby that resolve to nothing. */
  ariaLabelledbyMissing: string[];
  /** Text of an associated `<label>`, native or wrapping. */
  labelText: string | null;
  text: string;
  /**
   * alt text of descendant images, joined. An image-only link (`<a><img
   * alt="Home"></a>`) has no text of its own and is named by the image — miss
   * this and every logo link on the internet is reported as unnamed.
   */
  imageAltText: string | null;
  title: string | null;
  placeholder: string | null;
  alt: string | null;
  value: string | null;
  /** aria-hidden on the element or any ancestor. */
  ariaHidden: boolean;
  inert: boolean;
  disabled: boolean;
  /** `el.tabIndex` — negative means "focusable only in code". */
  tabIndex: number;
  hasTabIndexAttribute: boolean;
  /** Rendered at all: a zero-area or visibility:hidden control is not a tab stop. */
  visible: boolean;
  rect: ElementRect;
  /** Unfocused computed style, captured before anything was focused. */
  style: FocusStyle;
  /** Selector of the nearest dialog-ish ancestor, for the modal checks. */
  dialogAncestor: string | null;
}

export interface AnimationSnapshot {
  /** CSS animation name, or the empty string for a transition. */
  name: string;
  target: string;
  durationMs: number;
  /** `Infinity` serialises to null over the CDP boundary; -1 stands in for it. */
  iterations: number;
  playState: string;
}

export interface MotionSnapshot {
  /** Whether the emulation actually took: false makes the whole pass inconclusive. */
  reduceMatches: boolean;
  animations: AnimationSnapshot[];
  scrollBehavior: string;
  /** Elements that start moving on their own and offer no pause control. */
  autoplayMedia: string[];
  /** Whether ANY stylesheet mentions prefers-reduced-motion. */
  hasReducedMotionQuery: boolean;
  /** A stylesheet we could not read (cross-origin) — the query answer is then a guess. */
  unreadableStylesheets: number;
}

export interface ForcedColorsSnapshot {
  forcedMatches: boolean;
  /** Selectors of elements that opted out of the user's colour choices. */
  adjustNone: string[];
  scanned: number;
  truncated: boolean;
}

/** One Tab stop, as observed. */
export interface TabStop {
  /** Position in the ring, 0-based. */
  position: number;
  /** Index into the collected candidates, or -1 for `<body>`/`<html>`. */
  index: number;
  /** True when focus landed on the document rather than on any control. */
  documentLevel: boolean;
  tag: string;
  label: string;
  selector: string;
  style: FocusStyle;
  dialogAncestor: string | null;
}

// ─── Pure analysis ───────────────────────────────────────────────────────────

export type NameSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'label'
  | 'text'
  | 'image-alt'
  | 'value'
  | 'alt'
  | 'title'
  | 'placeholder'
  | 'none';

export interface AccessibleName {
  name: string;
  source: NameSource;
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The accessible name, resolved the way a screen reader announces it.
 *
 * Precedence here is the one the brief specifies: aria-label, then
 * aria-labelledby, then the element's own text (a native `<label>` counts as the
 * control's text — it is what the user sees next to it), then value/alt for the
 * input types whose name comes from an attribute, then title, then placeholder.
 *
 * ONE DELIBERATE DIVERGENCE FROM ACCNAME: the specification gives
 * aria-labelledby precedence over aria-label, and browsers implement it that
 * way. The two orders differ only for an element carrying BOTH, which is rare
 * and is itself an authoring mistake — so rather than pick a winner silently,
 * `assessAccessibleName` reports that element as `conflicting-labels` and says
 * which one the browser will actually announce.
 */
export function computeAccessibleName(el: ElementSnapshot): AccessibleName {
  const candidates: Array<[NameSource, string]> = [
    ['aria-label', clean(el.ariaLabel)],
    ['aria-labelledby', clean(el.ariaLabelledbyText)],
    ['label', clean(el.labelText)],
    ['text', clean(el.text)],
    ['image-alt', clean(el.imageAltText)],
    ['value', el.tag === 'input' && isValueNamed(el.type) ? clean(el.value) : ''],
    ['alt', clean(el.alt)],
    ['title', clean(el.title)],
    ['placeholder', clean(el.placeholder)],
  ];

  for (const [source, value] of candidates) {
    if (value.length > 0) return { name: value, source };
  }
  return { name: '', source: 'none' };
}

function isValueNamed(type: string | null): boolean {
  return type === 'submit' || type === 'button' || type === 'reset';
}

/**
 * Is this name worth announcing?
 *
 * Whole-string comparison after lower-casing and stripping punctuation: "Read
 * more about our returns policy" is a good name and must not be caught by the
 * "read more" entry. A name made only of punctuation or emoji ("🔍", "›") is
 * caught separately, because that is the icon-button case and it is the single
 * most common one.
 */
export function isUninformativeName(name: string, uninformative: readonly string[]): boolean {
  const normalised = name
    .toLowerCase()
    .replace(/[\s.!?:;,"'…\-–—>«»]+/g, ' ')
    .trim();
  if (normalised.length === 0) return true;
  return uninformative.some((entry) => entry.toLowerCase().trim() === normalised);
}

/** A name with no letters or digits in it announces as gibberish or as nothing. */
export function isSymbolOnlyName(name: string): boolean {
  return name.length > 0 && !/[\p{L}\p{N}]/u.test(name);
}

export type NameProblemKind =
  | 'missing'
  | 'uninformative'
  | 'symbol-only'
  | 'placeholder-only'
  | 'title-only'
  | 'hidden-from-assistive-tech'
  | 'labelledby-missing-target'
  | 'conflicting-labels';

export interface NameProblem {
  kind: NameProblemKind;
  element: ElementSnapshot;
  name: AccessibleName;
  detail: string;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'combobox',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
  'treeitem',
]);

/** What a screen reader would call this control, for the finding text. */
export function describeElement(el: ElementSnapshot): string {
  const role =
    el.role ??
    (el.tag === 'a' ? 'link' : el.tag === 'input' ? `${el.type ?? 'text'} input` : el.tag);
  const name = computeAccessibleName(el).name;
  return name ? `${role} “${name}”` : `unnamed ${role}`;
}

/**
 * Every way a control's name can fail, in the order that matters.
 *
 * Returns at most one problem per element: reporting an icon button as both
 * "hidden from assistive technology" and "name is a symbol" is two lines about
 * one fix, and the first one is the one to fix.
 */
export function assessAccessibleName(
  el: ElementSnapshot,
  options: { uninformativeNames: readonly string[] },
): NameProblem | null {
  const name = computeAccessibleName(el);
  const problem = (kind: NameProblemKind, detail: string): NameProblem => ({
    kind,
    element: el,
    name,
    detail,
  });

  // A focusable control inside aria-hidden is reachable by keyboard and absent
  // from the accessibility tree: the user lands on something that announces
  // nothing at all. (axe's `aria-hidden-focus` overlaps here; the codes differ
  // so a team can mute either one.)
  if (el.ariaHidden && el.tabIndex >= 0 && !el.disabled) {
    return problem(
      'hidden-from-assistive-tech',
      'it is inside aria-hidden="true" but still takes keyboard focus',
    );
  }

  if (el.ariaLabelledbyMissing.length > 0 && !clean(el.ariaLabelledbyText)) {
    return problem(
      'labelledby-missing-target',
      `aria-labelledby points at ${el.ariaLabelledbyMissing.map((id) => `#${id}`).join(', ')}, which ${el.ariaLabelledbyMissing.length === 1 ? 'does' : 'do'} not exist in the document`,
    );
  }

  if (name.source === 'none') {
    return problem('missing', 'nothing resolves to a name at all');
  }

  if (clean(el.ariaLabel) && clean(el.ariaLabelledbyText)) {
    return problem(
      'conflicting-labels',
      `it carries both aria-label (“${clean(el.ariaLabel)}”) and aria-labelledby (“${clean(el.ariaLabelledbyText)}”); a browser announces the aria-labelledby one`,
    );
  }

  if (isSymbolOnlyName(name.name)) {
    return problem(
      'symbol-only',
      `its name is “${name.name}”, which has no words in it — a screen reader reads the character or nothing`,
    );
  }

  if (isUninformativeName(name.name, options.uninformativeNames)) {
    return problem(
      'uninformative',
      `its name is “${name.name}”, which says nothing about what it does when read out of context`,
    );
  }

  // A placeholder is not a label: it disappears the moment the user types, and
  // several screen reader / browser pairs never announce it.
  if (name.source === 'placeholder') {
    return problem('placeholder-only', `its only name is the placeholder text “${name.name}”`);
  }

  if (name.source === 'title') {
    return problem(
      'title-only',
      `its only name is the title attribute “${name.name}”, which never appears for a touch or keyboard user`,
    );
  }

  return null;
}

/** Should this element have a name at all? */
export function expectsAccessibleName(el: ElementSnapshot): boolean {
  if (!el.visible || el.inert) return false;
  if (el.role && INTERACTIVE_ROLES.has(el.role)) return true;
  if (el.tag === 'input') return el.type !== 'hidden';
  return ['a', 'button', 'select', 'textarea', 'summary'].includes(el.tag);
}

// ── Focus indicator ──

export type IndicatorChannel =
  | 'outline'
  | 'box-shadow'
  | 'border'
  | 'background'
  | 'text colour'
  | 'underline'
  | 'transform'
  | 'filter'
  | 'opacity';

export interface FocusIndicator {
  visible: boolean;
  via: IndicatorChannel[];
}

/**
 * Channels a Windows High Contrast / forced-colors user still sees.
 *
 * In forced-colors mode the browser throws away author colours and does not
 * paint box-shadows at all, so a focus ring built out of `box-shadow` — a very
 * common pattern — is simply not there for the users most likely to need it.
 * Outlines and borders are re-painted in the user's own colours and survive.
 */
const FORCED_COLORS_SAFE: readonly IndicatorChannel[] = [
  'outline',
  'border',
  'underline',
  'transform',
  'filter',
  'opacity',
];

function px(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function outlineDrawn(style: FocusStyle): boolean {
  const outlineStyle = style['outline-style'] ?? 'none';
  return outlineStyle !== 'none' && px(style['outline-width']) > 0;
}

/**
 * Did anything visible change when this element took focus?
 *
 * Compares the computed style at the stop against the same element's style
 * captured before anything was focused. A changed `outline-color` while
 * `outline-style` is still `none` is not an indicator, which is why the outline
 * channel is decided by whether an outline is actually DRAWN rather than by a
 * property-by-property diff.
 */
export function focusIndicatorDelta(baseline: FocusStyle, focused: FocusStyle): FocusIndicator {
  const via: IndicatorChannel[] = [];
  const changed = (prop: string): boolean => baseline[prop] !== focused[prop];

  if (
    outlineDrawn(focused) &&
    (!outlineDrawn(baseline) ||
      changed('outline-width') ||
      changed('outline-color') ||
      changed('outline-style') ||
      changed('outline-offset'))
  ) {
    via.push('outline');
  }
  if (changed('box-shadow') && (focused['box-shadow'] ?? 'none') !== 'none') via.push('box-shadow');
  if (
    changed('border-top-width') ||
    changed('border-top-style') ||
    changed('border-top-color') ||
    changed('border-bottom-width') ||
    changed('border-bottom-color')
  ) {
    via.push('border');
  }
  if (changed('background-color') || changed('background-image')) via.push('background');
  if (changed('color')) via.push('text colour');
  if (changed('text-decoration-line') || changed('text-decoration-thickness'))
    via.push('underline');
  if (changed('transform')) via.push('transform');
  if (changed('filter')) via.push('filter');
  if (changed('opacity')) via.push('opacity');

  return { visible: via.length > 0, via };
}

export function survivesForcedColors(indicator: FocusIndicator): boolean {
  return indicator.via.some((channel) => FORCED_COLORS_SAFE.includes(channel));
}

// ── Focus order vs visual order ──

export interface FocusOrderRegression {
  from: TabStop;
  to: TabStop;
  /** How far up the page the tab order jumped, in CSS pixels. */
  jumpedUpBy: number;
}

/**
 * Tab stops whose order disagrees with the way the page reads.
 *
 * The signal is deliberately narrow: the next stop must sit entirely ABOVE the
 * previous one AND no further right. Both halves were paid for:
 *
 *  - "entirely above" drops left-to-right quibbles inside a row. A two-column
 *    form that tabs down one column and then the other is a design decision
 *    people argue about, and a checker that fires on every one of them is a
 *    checker nobody keeps switched on.
 *  - "no further right" was added after running this against the demo store's
 *    product grid, where it reported three regressions that were nothing of the
 *    sort: tabbing from the Add-to-cart button at the bottom of one card to the
 *    title link at the top of the NEXT card along is up-and-to-the-right, and it
 *    is exactly how a card grid is supposed to read. Up-and-to-the-LEFT is the
 *    shape with no innocent explanation — the focus ring goes back to somewhere
 *    the user has already been.
 *
 * The cost of that narrowness is a missed case (a genuinely wrong order that
 * happens to move right), and it is the right way round: this is a MODERATE
 * heuristic finding that a human has to confirm, so it must be quiet.
 *
 * `tolerance` absorbs sub-pixel layout and the couple of pixels a sticky header
 * moves by.
 */
export function focusOrderRegressions(
  stops: readonly TabStop[],
  rects: ReadonlyMap<number, ElementRect>,
  options: { tolerance?: number; max?: number } = {},
): FocusOrderRegression[] {
  const tolerance = options.tolerance ?? 4;
  const max = options.max ?? 5;
  const out: FocusOrderRegression[] = [];

  const ordered = stops.filter((stop) => !stop.documentLevel && rects.has(stop.index));

  for (let i = 1; i < ordered.length && out.length < max; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    const a = rects.get(previous.index)!;
    const b = rects.get(current.index)!;

    // Entirely above the previous stop — not merely higher, but not overlapping
    // it at all, so the two are never on the same visual row — and not off to
    // the right, which is the card-grid shape.
    const gap = a.y - (b.y + b.height);
    if (gap > tolerance && b.x <= a.x + tolerance) {
      out.push({ from: previous, to: current, jumpedUpBy: Math.round(gap) });
    }
  }

  return out;
}

// ── The shape of the tab ring ──

export interface TabRingAnalysis {
  /** True when the ring wrapped back through the document, i.e. it is closed. */
  completed: boolean;
  /** Focus stopped moving: the same element twice in a row. */
  stuckAt: TabStop | null;
  /**
   * The ring cycled among a subset of the page's controls without ever passing
   * through the document, and other controls exist outside it.
   */
  cycle: TabStop[] | null;
  /** Controls that are in the tab order on paper and never received focus. */
  unreachable: ElementSnapshot[];
  /** Ran out of Tab presses before the ring closed. */
  exhausted: boolean;
}

/**
 * What the walk found.
 *
 * THE BLIND SPOT, stated plainly: a page whose ENTIRE tab ring is trapped —
 * every control inside the trap, none outside — is reported by the "never
 * reached the document" rule, which is right; but a browser that wraps focus
 * without a document-level stop would make that rule fire on a healthy page.
 * Chromium (the browser this runner drives) always stops on `<body>` at the
 * wrap, which is what makes the rule safe here. The alternative — injecting a
 * sentinel element to tab into — would mutate the page under test, and this
 * module does not do that.
 */
export function analyseTabRing(
  stops: readonly TabStop[],
  candidates: readonly ElementSnapshot[],
  options: { exhausted: boolean },
): TabRingAnalysis {
  const visited = new Set(stops.filter((s) => !s.documentLevel).map((s) => s.index));
  const sawDocument = stops.some((s) => s.documentLevel);

  let stuckAt: TabStop | null = null;
  for (let i = 1; i < stops.length; i++) {
    const previous = stops[i - 1]!;
    const current = stops[i]!;
    if (!current.documentLevel && current.index >= 0 && current.index === previous.index) {
      stuckAt = current;
      break;
    }
  }

  // A control is expected in the tab order when it is rendered, enabled and not
  // inert, AND either it is focusable already or it claims an interactive role
  // without having been deliberately taken out with tabindex="-1".
  //
  // That second clause is the whole point of collecting role-bearing elements: a
  // `<div role="button">` with no tabindex reports `tabIndex === -1` exactly like
  // a control someone removed on purpose, and it is the single most common way
  // to ship a button no keyboard can reach.
  const expected = candidates.filter((el) => {
    if (!el.visible || el.disabled || el.inert) return false;
    if (el.tabIndex >= 0) return true;
    return el.role !== null && INTERACTIVE_ROLES.has(el.role) && !el.hasTabIndexAttribute;
  });

  const cycle =
    !sawDocument && stops.length > 0 && visited.size < expected.length
      ? stops.filter((s) => !s.documentLevel)
      : null;

  return {
    completed: sawDocument,
    stuckAt,
    cycle,
    // Only meaningful once the ring closed: a walk cut short by a trap or a
    // budget has not finished visiting, and calling the rest "unreachable" would
    // turn one real problem into fifty invented ones.
    unreachable:
      sawDocument && !options.exhausted ? expected.filter((el) => !visited.has(el.index)) : [],
    exhausted: options.exhausted,
  };
}

// ── Motion ──

export interface MotionProblem {
  kind: 'animation' | 'scroll-behaviour' | 'autoplay';
  target: string;
  detail: string;
  /** Infinite motion is the one that makes people ill; finite motion is milder. */
  endless: boolean;
}

/**
 * Motion still running after the user asked the operating system for less of it.
 *
 * A transition is not an animation: below `longAnimationMs` and with a finite
 * count, motion is the 150ms fade on a hover and reporting it would bury the
 * carousel that never stops. `iterations === -1` is how Infinity survives the
 * trip out of the page.
 */
export function motionProblems(
  snapshot: MotionSnapshot,
  options: { longAnimationMs: number },
): MotionProblem[] {
  const problems: MotionProblem[] = [];

  for (const animation of snapshot.animations) {
    const endless = animation.iterations === -1;
    if (!endless && animation.durationMs < options.longAnimationMs) continue;
    if (animation.playState === 'idle' || animation.playState === 'finished') continue;
    problems.push({
      kind: 'animation',
      target: animation.target,
      endless,
      detail: endless
        ? `the animation ${animation.name || '(a transition)'} is still running and repeats forever`
        : `the animation ${animation.name || '(a transition)'} is still running for ${Math.round(animation.durationMs)}ms`,
    });
  }

  if (snapshot.scrollBehavior === 'smooth') {
    problems.push({
      kind: 'scroll-behaviour',
      target: ':root',
      endless: false,
      detail:
        'scroll-behavior is still `smooth`, so every in-page jump animates the whole viewport',
    });
  }

  for (const target of snapshot.autoplayMedia) {
    problems.push({
      kind: 'autoplay',
      target,
      endless: true,
      detail: 'it plays automatically and exposes no controls to pause it',
    });
  }

  return problems;
}

// ─── In-page collectors ──────────────────────────────────────────────────────
//
// Everything below runs INSIDE the browser. Two rules apply and both are load
// bearing: a function handed to `page.evaluate` is serialised, so it may not
// reference anything in module scope (constants come in through the argument),
// and the runner's tsconfig has no DOM lib, so the DOM surface each one touches
// is declared structurally here.

/**
 * Hands a function to the page in a form no bundler can break.
 *
 * esbuild's `keepNames` — which is ON by default in tsx, and tsx is how this
 * repo runs the worker in development — rewrites every named inner function
 * into `__name(fn, "fn")`, where `__name` is a helper it defines at the top of
 * the MODULE. `page.evaluate` serialises only the function, so the page gets a
 * body that calls a helper which does not exist there, and every check dies with
 * `ReferenceError: __name is not defined`.
 *
 * That failure is quiet in the worst way: the checks fail open (they report
 * `a11y.inconclusive.*` and the run survives), so the feature would appear to
 * work after `npm run build` (tsc, no helper) and silently check nothing under
 * `npm run dev` (tsx). Found by running the plugin against the demo store, not
 * by a unit test — vitest's own transform does not add the helper.
 *
 * The fix is to build the function in THIS process out of source text, with a
 * one-line identity `__name` next to the code that calls it. It stays a real
 * function, so Playwright still calls it with the argument and still resolves
 * any JSHandle inside that argument; and when the helper is absent (a tsc
 * build) the shim is simply never used.
 */
export function inPage<A, R>(fn: (arg: A) => R): (arg: A) => R {
  // The "data" here is one of THIS module's own functions, read back with
  // Function.prototype.toString; nothing from the page or from a spec reaches
  // it. The alternatives are worse: passing a string expression makes Playwright
  // drop the argument (and with it the element handle), and an eval inside the
  // page is refused by any app with a strict Content-Security-Policy — exactly
  // the kind of app a scanner has to work on.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(
    'arg',
    `const __name = (value) => value; return (${fn.toString()})(arg);`,
  ) as (arg: A) => R;
}

interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DomStyle {
  getPropertyValue(property: string): string;
}

interface DomElement {
  tagName: string;
  id: string;
  className: unknown;
  textContent: string | null;
  parentElement: DomElement | null;
  children: ArrayLike<DomElement>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): DomRect;
  closest(selector: string): DomElement | null;
  matches(selector: string): boolean;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  contains(other: DomElement | null): boolean;
  tabIndex: number;
  type?: string;
  value?: string;
  disabled?: boolean;
  labels?: ArrayLike<DomElement> | null;
}

interface DomAnimationEffect {
  target: DomElement | null;
  getComputedTiming(): { duration?: number | string; iterations?: number };
}

interface DomAnimation {
  animationName?: string;
  playState: string;
  effect: DomAnimationEffect | null;
}

interface DomStyleSheet {
  cssRules: ArrayLike<{ cssText?: string }>;
}

interface DomDocument {
  documentElement: DomElement;
  body: DomElement;
  activeElement: DomElement | null;
  styleSheets: ArrayLike<DomStyleSheet>;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getElementById(id: string): DomElement | null;
  getAnimations?: () => DomAnimation[];
}

interface DomWindow {
  document: DomDocument;
  scrollX: number;
  scrollY: number;
  getComputedStyle(element: DomElement): DomStyle;
  matchMedia(query: string): { matches: boolean };
}

/**
 * Elements that can take focus, plus elements that claim an interactive role
 * without being focusable — the second group is how a `<div role="button">` with
 * no tabindex gets caught, and it is invisible to a check that only walks the
 * tab ring.
 */
const CANDIDATE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
  ...[...INTERACTIVE_ROLES].map((role) => `[role="${role}"]`),
].join(',');

const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"],dialog,[aria-modal="true"]';

interface CollectOptions {
  selector: string;
  dialogSelector: string;
  styleProps: readonly string[];
  maxCandidates: number;
}

/** IN THE BROWSER. Picks the elements to describe, and hands back the live nodes. */
const collectNodes = (options: CollectOptions): DomElement[] => {
  const doc = (globalThis as unknown as DomWindow).document;
  const all = doc.querySelectorAll(options.selector);
  const out: DomElement[] = [];
  for (let i = 0; i < all.length && out.length < options.maxCandidates; i++) {
    const el = all[i];
    if (el) out.push(el);
  }
  return out;
};

/** IN THE BROWSER. Describes the nodes collected above. Nothing is mutated. */
const describeNodes = (arg: {
  nodes: DomElement[];
  options: CollectOptions;
}): ElementSnapshot[] => {
  const win = globalThis as unknown as DomWindow;
  const doc = win.document;

  const selectorFor = (element: DomElement): string => {
    const parts: string[] = [];
    let node: DomElement | null = element;
    let depth = 0;
    while (node && depth < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const classes =
        typeof node.className === 'string'
          ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
          : [];
      if (classes.length > 0) part += `.${classes.join('.')}`;
      const parent: DomElement | null = node.parentElement;
      if (parent) {
        const siblings: DomElement[] = [];
        for (let i = 0; i < parent.children.length; i++) {
          const child = parent.children[i];
          if (child && child.tagName === node.tagName) siblings.push(child);
        }
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  };

  const textOf = (element: DomElement | null): string =>
    (element?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

  return arg.nodes.map((el, index) => {
    const style = win.getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    const labelledby = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter((id) => id.length > 0);
    const labelledbyText: string[] = [];
    const labelledbyMissing: string[] = [];
    for (const id of labelledby) {
      const target = doc.getElementById(id);
      if (target) labelledbyText.push(textOf(target));
      else labelledbyMissing.push(id);
    }

    let labelText: string | null = null;
    const labels = el.labels;
    if (labels && labels.length > 0) {
      const texts: string[] = [];
      for (let i = 0; i < labels.length; i++) texts.push(textOf(labels[i] ?? null));
      labelText = texts.join(' ').trim() || null;
    } else {
      const wrapping = el.closest('label');
      if (wrapping) labelText = textOf(wrapping) || null;
    }

    const images = el.querySelectorAll('img[alt],area[alt],input[type="image"][alt]');
    const imageAlt: string[] = [];
    for (let i = 0; i < images.length && imageAlt.length < 4; i++) {
      const alt = images[i]?.getAttribute('alt');
      if (alt && alt.trim().length > 0) imageAlt.push(alt.trim());
    }

    const dialog = el.closest(arg.options.dialogSelector);
    const styleValues: Record<string, string> = {};
    for (const prop of arg.options.styleProps) styleValues[prop] = style.getPropertyValue(prop);

    return {
      index,
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      type: (el.type ?? el.getAttribute('type'))?.toLowerCase() ?? null,
      role: el.getAttribute('role')?.toLowerCase() ?? null,
      ariaLabel: el.getAttribute('aria-label'),
      ariaLabelledbyText: labelledbyText.join(' ').trim() || null,
      ariaLabelledbyMissing: labelledbyMissing,
      labelText,
      // The control's own text, not a wrapping label's — those are separate
      // name sources and conflating them hides "the label is the only name".
      text: textOf(el),
      imageAltText: imageAlt.join(' ').trim() || null,
      title: el.getAttribute('title'),
      placeholder: el.getAttribute('placeholder'),
      alt: el.getAttribute('alt'),
      value: typeof el.value === 'string' ? el.value : null,
      ariaHidden: el.closest('[aria-hidden="true"]') !== null,
      inert: el.closest('[inert]') !== null,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      tabIndex: typeof el.tabIndex === 'number' ? el.tabIndex : 0,
      hasTabIndexAttribute: el.hasAttribute('tabindex'),
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.getPropertyValue('visibility') !== 'hidden' &&
        style.getPropertyValue('display') !== 'none',
      // Document coordinates: the page scrolls as we tab through it, and a
      // viewport-relative rect would make the order check nonsense.
      rect: {
        x: rect.x + win.scrollX,
        y: rect.y + win.scrollY,
        width: rect.width,
        height: rect.height,
      },
      style: styleValues,
      dialogAncestor: dialog ? selectorFor(dialog) : null,
    };
  });
};

/** IN THE BROWSER. Where is focus now, and what does it look like there? */
const readFocus = (arg: {
  nodes: DomElement[];
  styleProps: readonly string[];
  dialogSelector: string;
}): Omit<TabStop, 'position'> => {
  const win = globalThis as unknown as DomWindow;
  const doc = win.document;
  const el = doc.activeElement;

  if (!el || el === doc.body || el === doc.documentElement) {
    return {
      index: -1,
      documentLevel: true,
      tag: el ? el.tagName.toLowerCase() : 'none',
      label: 'the document itself',
      selector: el ? el.tagName.toLowerCase() : 'none',
      style: {},
      dialogAncestor: null,
    };
  }

  const style = win.getComputedStyle(el);
  const styleValues: Record<string, string> = {};
  for (const prop of arg.styleProps) styleValues[prop] = style.getPropertyValue(prop);

  const dialog = el.closest(arg.dialogSelector);
  const name =
    el.getAttribute('aria-label') ??
    (el.textContent ?? '').replace(/\s+/g, ' ').trim() ??
    el.getAttribute('title') ??
    '';

  return {
    index: arg.nodes.indexOf(el),
    documentLevel: false,
    tag: el.tagName.toLowerCase(),
    label: name.slice(0, 80),
    selector: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`,
    style: styleValues,
    dialogAncestor: dialog
      ? `${dialog.tagName.toLowerCase()}${dialog.id ? `#${dialog.id}` : ''}`
      : null,
  };
};

/** IN THE BROWSER. Motion still running under prefers-reduced-motion. */
const readMotion = (arg: { maxAnimations: number }): MotionSnapshot => {
  const win = globalThis as unknown as DomWindow;
  const doc = win.document;

  const selectorFor = (element: DomElement | null): string => {
    if (!element) return '(detached)';
    const tag = element.tagName.toLowerCase();
    if (element.id) return `${tag}#${element.id}`;
    const classes =
      typeof element.className === 'string'
        ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
        : [];
    return classes.length > 0 ? `${tag}.${classes.join('.')}` : tag;
  };

  const animations: AnimationSnapshot[] = [];
  const running = typeof doc.getAnimations === 'function' ? doc.getAnimations() : [];
  for (const animation of running.slice(0, arg.maxAnimations)) {
    const timing = animation.effect?.getComputedTiming() ?? {};
    const duration = typeof timing.duration === 'number' ? timing.duration : 0;
    const iterations = timing.iterations ?? 1;
    animations.push({
      name: animation.animationName ?? '',
      target: selectorFor(animation.effect?.target ?? null),
      durationMs: duration,
      // Infinity does not survive JSON; -1 stands in for it.
      iterations: Number.isFinite(iterations) ? iterations : -1,
      playState: animation.playState,
    });
  }

  const autoplay: string[] = [];
  const media = doc.querySelectorAll('video[autoplay],audio[autoplay],marquee');
  for (let i = 0; i < media.length; i++) {
    const el = media[i];
    if (!el) continue;
    if (el.tagName.toLowerCase() !== 'marquee' && el.hasAttribute('controls')) continue;
    autoplay.push(selectorFor(el));
  }

  let hasQuery = false;
  let unreadable = 0;
  for (let i = 0; i < doc.styleSheets.length; i++) {
    const sheet = doc.styleSheets[i];
    try {
      const rules = sheet?.cssRules;
      if (!rules) continue;
      for (let r = 0; r < rules.length; r++) {
        if ((rules[r]?.cssText ?? '').indexOf('prefers-reduced-motion') !== -1) {
          hasQuery = true;
          break;
        }
      }
    } catch {
      // A cross-origin stylesheet cannot be read. Counted, not guessed at.
      unreadable++;
    }
    if (hasQuery) break;
  }

  return {
    reduceMatches: win.matchMedia('(prefers-reduced-motion: reduce)').matches,
    animations,
    scrollBehavior: win.getComputedStyle(doc.documentElement).getPropertyValue('scroll-behavior'),
    autoplayMedia: autoplay,
    hasReducedMotionQuery: hasQuery,
    unreadableStylesheets: unreadable,
  };
};

/** IN THE BROWSER. Who opted out of the user's own colours? */
const readForcedColors = (arg: { maxElements: number }): ForcedColorsSnapshot => {
  const win = globalThis as unknown as DomWindow;
  const doc = win.document;
  const all = doc.querySelectorAll('*');
  const limit = Math.min(all.length, arg.maxElements);
  const adjustNone: string[] = [];

  for (let i = 0; i < limit; i++) {
    const el = all[i];
    if (!el) continue;
    const value = win.getComputedStyle(el).getPropertyValue('forced-color-adjust');
    if (value === 'none' && adjustNone.length < 25) {
      const tag = el.tagName.toLowerCase();
      adjustNone.push(el.id ? `${tag}#${el.id}` : tag);
    }
  }

  return {
    forcedMatches: win.matchMedia('(forced-colors: active)').matches,
    adjustNone,
    scanned: limit,
    truncated: all.length > limit,
  };
};

// ─── Finding assembly ────────────────────────────────────────────────────────

interface DeepFindingInput {
  code: string;
  severity: Finding['severity'];
  criterion: WcagCriterion;
  location: string;
  /** What is wrong, naming the element. */
  problem: string;
  /** What to do about it. */
  remedy: string;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function toFinding(input: DeepFindingInput, mask: (s: string) => string): Finding {
  return {
    kind: 'ACCESSIBILITY',
    severity: input.severity,
    code: input.code,
    message: truncate(
      mask(
        `${input.problem} ${input.remedy} (WCAG ${input.criterion.id} ${input.criterion.name}, Level ${input.criterion.level}.)`,
      ),
      MESSAGE_LIMIT,
    ),
    location: truncate(mask(input.location), LOCATION_LIMIT),
    helpUrl: understandingUrl(input.criterion),
  };
}

// ─── Driving the page ────────────────────────────────────────────────────────

export interface DeepA11yDeps {
  page: Page;
  /** The route being scanned, for finding text. */
  route: string;
  config: ResolvedDeepA11yConfig;
  /**
   * Re-navigates to the route. The motion and forced-colors passes reload under
   * media emulation, and the plugin owns what "loaded" means for this run.
   */
  navigate: () => Promise<void>;
  signal?: AbortSignal | null;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void } | null;
  /** Page text lands in findings; a name interpolated from a secret would too. */
  mask?: ((input: string) => string) | null;
}

export interface DeepA11yCheckOutcome {
  check: DeepA11yCheck;
  /** RAN means we looked. SKIPPED means we did not, and a finding says why. */
  status: 'RAN' | 'SKIPPED';
  detail: string;
  findings: number;
}

export interface DeepA11yResult {
  findings: Finding[];
  outcomes: DeepA11yCheckOutcome[];
}

const CHECK_LABELS: Record<DeepA11yCheck, string> = {
  keyboardTraversal: 'Keyboard traversal',
  keyboardTraps: 'Keyboard traps',
  accessibleNames: 'Accessible names',
  focusManagement: 'Focus management',
  reducedMotion: 'Reduced motion',
  forcedColors: 'Forced colors',
};

/** Human-readable check name, for a cockpit step title. */
export function deepA11yCheckLabel(check: DeepA11yCheck): string {
  return CHECK_LABELS[check];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the enabled checks against one already-loaded route.
 *
 * NEVER THROWS. Every check is wrapped: one that fails takes its own findings
 * with it and leaves an `a11y.inconclusive.<check>` behind saying what was not
 * looked at, because a silent skip is indistinguishable from a clean page.
 */
export async function runDeepA11yChecks(deps: DeepA11yDeps): Promise<DeepA11yResult> {
  const { page, config, route } = deps;
  const mask = deps.mask ?? ((input: string) => input);
  const raw: DeepFindingInput[] = [];
  const outcomes: DeepA11yCheckOutcome[] = [];

  const inconclusive = (check: DeepA11yCheck, reason: string): void => {
    raw.push({
      code: `${DEEP_A11Y_CODE_PREFIX}inconclusive.${check}`,
      severity: 'MINOR',
      criterion: WCAG.keyboard,
      location: route,
      problem: `The ${CHECK_LABELS[check]} check did not run on ${route}, so a barrier it would have found was not reported: ${reason}.`,
      remedy:
        'Fix the reason above and re-run; until then treat this route as unchecked for that barrier.',
    });
    deps.logger?.warn(`deep a11y: ${check} could not run`, { route, reason: mask(reason) });
  };

  // A config we could not read is reported, not obeyed. Filed under `config`
  // rather than against a check, because it is not one check that failed — it is
  // every one of them, for a reason the spec's author can fix in one line.
  if (config.configError) {
    for (const check of DEEP_A11Y_CHECKS) {
      outcomes.push({ check, status: 'SKIPPED', detail: config.configError, findings: 0 });
    }
    raw.push({
      code: `${DEEP_A11Y_CODE_PREFIX}inconclusive.config`,
      severity: 'MINOR',
      criterion: WCAG.keyboard,
      location: route,
      problem: `No behavioural accessibility check ran on ${route}: ${config.configError}.`,
      remedy: `Correct the deep block in the test's spec. Available checks: ${DEEP_A11Y_CHECKS.join(', ')}.`,
    });
    deps.logger?.warn('deep a11y: the deep block could not be read', {
      route,
      reason: mask(config.configError),
    });
    return { findings: raw.map((f) => toFinding(f, mask)), outcomes };
  }

  const enabled = enabledChecks(config);
  if (enabled.length === 0) {
    // A `deep` block that switches nothing on is almost always a typo, and a
    // silent no-op would let a team believe they are covered.
    raw.push({
      code: `${DEEP_A11Y_CODE_PREFIX}inconclusive.config`,
      severity: 'MINOR',
      criterion: WCAG.keyboard,
      location: route,
      problem:
        'The spec has a `deep` block but every check in it is switched off, so no behavioural accessibility check ran.',
      remedy: `Switch one on by name, e.g. deep: { keyboardTraps: true }. Available: ${DEEP_A11Y_CHECKS.join(', ')}.`,
    });
    return { findings: raw.map((f) => toFinding(f, mask)), outcomes };
  }

  const aborted = (): boolean => deps.signal?.aborted === true;

  const record = async (check: DeepA11yCheck, fn: () => Promise<string>): Promise<void> => {
    if (!config[check].enabled) return;
    if (aborted()) {
      outcomes.push({ check, status: 'SKIPPED', detail: 'the run was cancelled', findings: 0 });
      return;
    }
    const before = raw.length;
    try {
      const detail = await fn();
      outcomes.push({ check, status: 'RAN', detail, findings: raw.length - before });
    } catch (err) {
      inconclusive(check, errText(err));
      outcomes.push({ check, status: 'SKIPPED', detail: errText(err), findings: 0 });
    }
  };

  const collectOptions: CollectOptions = {
    selector: CANDIDATE_SELECTOR,
    dialogSelector: DIALOG_SELECTOR,
    styleProps: FOCUS_STYLE_PROPS,
    maxCandidates: 750,
  };

  // The static pass. Names, traversal, traps and the forced-colors inference all
  // read from it, so a failure here is reported once against each of them.
  let nodes: JSHandle<DomElement[]> | null = null;
  let candidates: ElementSnapshot[] = [];
  let collectError: string | null = null;
  try {
    nodes = await page.evaluateHandle(inPage(collectNodes), collectOptions);
    candidates = await page.evaluate(inPage(describeNodes), { nodes, options: collectOptions });
  } catch (err) {
    collectError = `the page's interactive elements could not be read (${errText(err)})`;
  }

  const byIndex = new Map(candidates.map((el) => [el.index, el] as const));
  let indicators: Array<{ stop: TabStop; indicator: FocusIndicator }> = [];

  try {
    if (collectError) {
      for (const check of ['accessibleNames', 'keyboardTraversal', 'keyboardTraps'] as const) {
        if (config[check].enabled) {
          inconclusive(check, collectError);
          outcomes.push({ check, status: 'SKIPPED', detail: collectError, findings: 0 });
        }
      }
    } else {
      // ── 3. Accessible names ──
      await record('accessibleNames', async () => {
        const options = config.accessibleNames;
        let checked = 0;
        for (const el of candidates) {
          if (!expectsAccessibleName(el)) continue;
          if (options.ignoreSelectors.some((selector) => el.selector.includes(selector))) continue;
          checked++;
          const problem = assessAccessibleName(el, options);
          if (problem) raw.push(nameFinding(problem, route));
        }
        return `${checked} control(s) checked for an accessible name`;
      });

      // ── 1 & 2. The tab ring: traversal and traps share one walk ──
      const wantsRing = config.keyboardTraversal.enabled || config.keyboardTraps.enabled;
      if (wantsRing && nodes) {
        const ringHandle = nodes;
        let walk: { stops: TabStop[]; exhausted: boolean } | null = null;
        let walkError: string | null = null;
        try {
          walk = await walkTabRing(page, ringHandle, {
            maxTabStops: config.keyboardTraversal.maxTabStops,
            budgetMs: config.keyboardTraversal.budgetMs,
            signal: deps.signal ?? null,
          });
        } catch (err) {
          walkError = `the page could not be tabbed through (${errText(err)})`;
        }

        if (!walk) {
          for (const check of ['keyboardTraversal', 'keyboardTraps'] as const) {
            if (config[check].enabled) {
              inconclusive(check, walkError ?? 'the tab ring walk produced nothing');
              outcomes.push({
                check,
                status: 'SKIPPED',
                detail: walkError ?? 'no stops',
                findings: 0,
              });
            }
          }
        } else {
          const ring = analyseTabRing(walk.stops, candidates, { exhausted: walk.exhausted });

          await record('keyboardTraversal', async () => {
            const traversal = config.keyboardTraversal;

            for (const el of ring.unreachable) {
              raw.push({
                code: `${DEEP_A11Y_CODE_PREFIX}keyboard.unreachable`,
                severity: 'SERIOUS',
                criterion: WCAG.keyboard,
                location: `${route} ${el.selector}`,
                problem: `The ${describeElement(el)} at ${el.selector} on ${route} is interactive but never received focus while tabbing through the page.`,
                remedy:
                  el.tag === 'div' || el.tag === 'span'
                    ? 'Use a <button> or <a href>, or give it tabindex="0" and a keydown handler for Enter and Space.'
                    : 'Check for a positive tabindex elsewhere, an ancestor with inert/aria-hidden, or CSS that moves it out of the tab order.',
              });
            }

            for (const el of candidates) {
              if (el.tabIndex > 0 && el.visible) {
                raw.push({
                  code: `${DEEP_A11Y_CODE_PREFIX}keyboard.positive-tabindex`,
                  severity: 'MODERATE',
                  criterion: WCAG.focusOrder,
                  location: `${route} ${el.selector}`,
                  problem: `The ${describeElement(el)} at ${el.selector} has tabindex="${el.tabIndex}", which pulls it in front of every element in the document order.`,
                  remedy:
                    'Use tabindex="0" and put the element where it belongs in the DOM; a positive tabindex has to be maintained across the whole page and silently breaks when anything is added.',
                });
              }
            }

            if (traversal.focusVisible) {
              indicators = [];
              const reported = new Set<number>();
              for (const stop of walk.stops) {
                if (stop.documentLevel || stop.index < 0) continue;
                const baseline = byIndex.get(stop.index);
                if (!baseline) continue;
                const indicator = focusIndicatorDelta(baseline.style, stop.style);
                indicators.push({ stop, indicator });
                if (indicator.visible || reported.has(stop.index)) continue;
                reported.add(stop.index);
                raw.push({
                  code: `${DEEP_A11Y_CODE_PREFIX}keyboard.focus-not-visible`,
                  severity: 'SERIOUS',
                  criterion: WCAG.focusVisible,
                  location: `${route} ${baseline.selector}`,
                  problem: `Tab stop ${stop.position + 1} on ${route}, the ${describeElement(baseline)} at ${baseline.selector}, looks exactly the same focused as unfocused — no outline, box-shadow, border, background, colour or underline changes.`,
                  remedy:
                    'Give it a focus indicator, e.g. :focus-visible { outline: 2px solid; outline-offset: 2px; }. If a reset stylesheet sets outline: none, that is where to look.',
                });
              }
            }

            if (traversal.visualOrder) {
              const rects = new Map(candidates.map((el) => [el.index, el.rect] as const));
              for (const regression of focusOrderRegressions(walk.stops, rects)) {
                const from = byIndex.get(regression.from.index);
                const to = byIndex.get(regression.to.index);
                raw.push({
                  code: `${DEEP_A11Y_CODE_PREFIX}keyboard.focus-order`,
                  severity: 'MODERATE',
                  criterion: WCAG.focusOrder,
                  location: `${route} ${to?.selector ?? regression.to.selector}`,
                  problem: `On ${route} the tab order jumps backwards up the page: from ${from ? describeElement(from) : regression.from.label} at ${from?.selector ?? regression.from.selector} to ${to ? describeElement(to) : regression.to.label} at ${to?.selector ?? regression.to.selector}, which sits ${regression.jumpedUpBy}px higher and does not overlap it.`,
                  remedy:
                    'Reorder the DOM so it matches the reading order, or move the element visually. Confirm by eye first — a deliberate two-column layout can produce this shape.',
                });
              }
            }

            return `${walk.stops.length} tab stop(s) walked${ring.completed ? '' : ' (ring did not close)'}`;
          });

          await record('keyboardTraps', async () => {
            const escapeKeys = config.keyboardTraps.escapeKeys;

            if (ring.stuckAt) {
              const stuck = byIndex.get(ring.stuckAt.index);
              const escape = await probeEscape(
                page,
                ringHandle,
                new Set([ring.stuckAt.index]),
                escapeKeys,
              );
              raw.push({
                code: `${DEEP_A11Y_CODE_PREFIX}keyboard.trap`,
                severity: escape.escaped ? 'SERIOUS' : 'CRITICAL',
                criterion: WCAG.noKeyboardTrap,
                location: `${route} ${stuck?.selector ?? ring.stuckAt.selector}`,
                problem: escape.escaped
                  ? `On ${route}, focus stops moving at the ${stuck ? describeElement(stuck) : ring.stuckAt.label} (${stuck?.selector ?? ring.stuckAt.selector}): Tab does not advance past it. It could only be left with ${escape.via}.`
                  : `On ${route}, focus is TRAPPED at the ${stuck ? describeElement(stuck) : ring.stuckAt.label} (${stuck?.selector ?? ring.stuckAt.selector}): Tab does not advance, Shift+Tab does not go back, and ${escapeKeys.join('/')} did not release it. A keyboard user cannot reach the rest of the page or leave it.`,
                remedy: escape.escaped
                  ? `Let Tab move on, or tell the user about ${escape.via} in the widget's instructions — 2.1.2 allows a non-standard exit only when it is documented.`
                  : 'Stop calling preventDefault() on Tab, or make the widget move focus on to the next element itself. Whatever holds focus must release it.',
              });
            } else if (ring.cycle && ring.cycle.length > 0) {
              const first = ring.cycle[0]!;
              // The whole cycle, not just the stop we happen to be on: moving
              // from one member of it to another is the trap, not an escape.
              const escape = await probeEscape(
                page,
                ringHandle,
                new Set(ring.cycle.map((stop) => stop.index)),
                escapeKeys,
              );
              const members = ring.cycle
                .slice(0, 6)
                .map((stop) => byIndex.get(stop.index)?.selector ?? stop.selector);
              raw.push({
                code: `${DEEP_A11Y_CODE_PREFIX}keyboard.trap`,
                severity: escape.escaped ? 'MODERATE' : 'CRITICAL',
                criterion: WCAG.noKeyboardTrap,
                location: `${route} ${members[0] ?? first.selector}`,
                problem: `On ${route}, Tab cycles forever through ${ring.cycle.length} element(s) (${members.join(', ')}) and never reaches the rest of the page.${escape.escaped ? ` The cycle could be left with ${escape.via}.` : ' Neither Shift+Tab nor ' + escapeKeys.join('/') + ' escaped it.'}`,
                remedy: escape.escaped
                  ? 'If this is a dialog it is behaving correctly while open — check that it is meant to be open on load, and that closing it restores focus.'
                  : 'Release focus at the end of the cycle: a focus trap must be tied to something that closes, and closing it must move focus back out.',
              });
            }

            if (ring.exhausted && !ring.stuckAt && !ring.cycle) {
              inconclusive(
                'keyboardTraps',
                `the walk hit its ${config.keyboardTraversal.maxTabStops}-stop limit without the ring closing, so a trap beyond that point would not have been seen. Raise deep.keyboardTraversal.maxTabStops`,
              );
            }

            return ring.stuckAt || ring.cycle ? 'a trap was found' : 'no trap found';
          });
        }
      }
    }

    // ── 4. Focus management ──
    await record('focusManagement', async () => {
      const options = config.focusManagement;
      if (options.modals.length === 0 && options.routeChanges.length === 0) {
        inconclusive(
          'focusManagement',
          'no modal or route change was configured, and focus management can only be observed by operating something. Add deep.focusManagement.modals: [{ name, trigger }] or .routeChanges: [{ name, trigger }]',
        );
        return 'nothing configured';
      }

      const deadline = Date.now() + options.budgetMs;
      let done = 0;
      for (const modal of options.modals) {
        if (Date.now() > deadline || aborted()) break;
        raw.push(...(await checkModal(deps, modal, route)));
        done++;
      }
      for (const routeChange of options.routeChanges) {
        if (Date.now() > deadline || aborted()) break;
        raw.push(...(await checkRouteChange(deps, routeChange, route)));
        done++;
        // A route change navigates; put the page back where the scan started.
        await deps.navigate();
      }
      return `${done} focus-management scenario(s) exercised`;
    });

    // ── 5. Reduced motion ──
    await record('reducedMotion', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      // Reloaded, not just re-queried: a page that reads the media query once at
      // startup would otherwise be judged on animations it set up before anyone
      // told it the user wanted less motion.
      await deps.navigate();
      const snapshot = await page.evaluate(inPage(readMotion), { maxAnimations: 200 });

      if (!snapshot.reduceMatches) {
        inconclusive(
          'reducedMotion',
          'the browser did not report prefers-reduced-motion: reduce even after emulation, so nothing could be concluded about the page',
        );
        return 'emulation did not take';
      }

      const problems = motionProblems(snapshot, {
        longAnimationMs: config.reducedMotion.longAnimationMs,
      });
      for (const problem of problems) {
        raw.push({
          code:
            problem.kind === 'autoplay'
              ? `${DEEP_A11Y_CODE_PREFIX}motion.autoplay`
              : problem.kind === 'scroll-behaviour'
                ? `${DEEP_A11Y_CODE_PREFIX}motion.smooth-scroll`
                : `${DEEP_A11Y_CODE_PREFIX}motion.not-reduced`,
          severity: problem.endless ? 'SERIOUS' : 'MODERATE',
          criterion: problem.endless ? WCAG.pauseStopHide : WCAG.animationFromInteractions,
          location: `${route} ${problem.target}`,
          problem: `On ${route} with prefers-reduced-motion: reduce, ${problem.target} still moves: ${problem.detail}.${snapshot.hasReducedMotionQuery ? '' : ' No stylesheet on this page mentions prefers-reduced-motion at all.'}`,
          remedy:
            problem.kind === 'scroll-behaviour'
              ? 'Wrap it: @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }.'
              : 'Wrap the motion in @media (prefers-reduced-motion: no-preference), or shorten it to a cross-fade under the reduce query. If the motion is essential, give the user a control that pauses it.',
        });
      }

      if (snapshot.unreadableStylesheets > 0 && problems.length === 0) {
        inconclusive(
          'reducedMotion',
          `${snapshot.unreadableStylesheets} cross-origin stylesheet(s) could not be read, so motion declared in them was judged only by what was running`,
        );
      }

      return `${snapshot.animations.length} animation(s) running under reduce`;
    });

    // ── 5b. Forced colors ──
    await record('forcedColors', async () => {
      await page.emulateMedia({ forcedColors: 'active' });
      await deps.navigate();
      const snapshot = await page.evaluate(inPage(readForcedColors), {
        maxElements: config.forcedColors.maxElements,
      });

      if (!snapshot.forcedMatches) {
        inconclusive(
          'forcedColors',
          'the browser did not report forced-colors: active even after emulation (only Chromium supports it), so nothing could be concluded',
        );
        return 'emulation did not take';
      }

      for (const target of snapshot.adjustNone) {
        raw.push({
          code: `${DEEP_A11Y_CODE_PREFIX}forced-colors.opt-out`,
          severity: 'MODERATE',
          criterion: WCAG.nonTextContrast,
          location: `${route} ${target}`,
          problem: `On ${route}, ${target} sets forced-color-adjust: none, so it keeps the author's colours when a user has chosen their own high-contrast palette.`,
          remedy:
            "Remove it unless the element conveys meaning through colour that cannot survive substitution (a colour picker swatch). Everything else should adopt the user's colours.",
        });
      }

      // Inferred rather than re-walked: box-shadow is not painted in forced
      // colors and author background/text colours are replaced, so a ring built
      // only from those channels is gone for exactly the users who need it.
      const canInferIndicators =
        config.keyboardTraversal.enabled && config.keyboardTraversal.focusVisible;
      if (canInferIndicators && indicators.length === 0) {
        // Traversal was asked for and produced nothing — it failed, or the page
        // has no tab stops. Either way no indicator was examined, and saying
        // nothing here would read as "the indicators are fine".
        inconclusive(
          'forcedColors',
          'no focus indicator could be examined because the keyboard traversal produced no tab stops on this route',
        );
      } else if (canInferIndicators) {
        const lost = new Set<string>();
        for (const { stop, indicator } of indicators) {
          if (!indicator.visible || survivesForcedColors(indicator)) continue;
          const el = byIndex.get(stop.index);
          const selector = el?.selector ?? stop.selector;
          if (lost.has(selector)) continue;
          lost.add(selector);
          raw.push({
            code: `${DEEP_A11Y_CODE_PREFIX}forced-colors.focus-indicator-lost`,
            severity: 'MODERATE',
            criterion: WCAG.nonTextContrast,
            location: `${route} ${selector}`,
            problem: `The focus indicator on ${el ? describeElement(el) : stop.label} at ${selector} is drawn only with ${indicator.via.join(' and ')}, none of which a browser paints in forced-colors mode.`,
            remedy:
              "Add an outline to the focus style. outline: 2px solid transparent in forced-colors mode is repainted in the user's own highlight colour, which is why outline is the channel to rely on.",
          });
        }
      } else if (config.forcedColors.enabled) {
        inconclusive(
          'forcedColors',
          'focus indicators were not examined because deep.keyboardTraversal.focusVisible is off, and the indicator is the thing forced-colors most often destroys',
        );
      }

      if (snapshot.truncated) {
        inconclusive(
          'forcedColors',
          `only the first ${snapshot.scanned} elements were inspected. Raise deep.forcedColors.maxElements to cover the rest`,
        );
      }

      return `${snapshot.scanned} element(s) inspected under forced colors`;
    });
  } finally {
    // Emulation is per-page and this page is reused by the next route.
    await page.emulateMedia({ reducedMotion: null, forcedColors: null }).catch(() => {});
    await nodes?.dispose().catch(() => {});
  }

  return { findings: raw.map((f) => toFinding(f, mask)), outcomes };
}

const NAME_PROBLEM_CODES: Record<NameProblemKind, string> = {
  missing: `${DEEP_A11Y_CODE_PREFIX}name.missing`,
  uninformative: `${DEEP_A11Y_CODE_PREFIX}name.uninformative`,
  'symbol-only': `${DEEP_A11Y_CODE_PREFIX}name.symbol-only`,
  'placeholder-only': `${DEEP_A11Y_CODE_PREFIX}name.placeholder-only`,
  'title-only': `${DEEP_A11Y_CODE_PREFIX}name.title-only`,
  'hidden-from-assistive-tech': `${DEEP_A11Y_CODE_PREFIX}name.hidden`,
  'labelledby-missing-target': `${DEEP_A11Y_CODE_PREFIX}name.labelledby-missing`,
  'conflicting-labels': `${DEEP_A11Y_CODE_PREFIX}name.conflicting`,
};

/**
 * Severity for a name problem, graded by what the user actually loses.
 *
 * No name at all, or a name only assistive technology cannot see, is a control
 * the user cannot identify — SERIOUS. A name that exists but is useless out of
 * context is MODERATE: the user knows something is there and has to guess what.
 */
const NAME_PROBLEM_SEVERITY: Record<NameProblemKind, Finding['severity']> = {
  missing: 'SERIOUS',
  'hidden-from-assistive-tech': 'SERIOUS',
  'labelledby-missing-target': 'SERIOUS',
  'symbol-only': 'SERIOUS',
  uninformative: 'MODERATE',
  'placeholder-only': 'MODERATE',
  'title-only': 'MODERATE',
  'conflicting-labels': 'MINOR',
};

const NAME_PROBLEM_REMEDY: Record<NameProblemKind, string> = {
  missing:
    'Give it an accessible name: visible text inside the control, a <label for> for an input, or aria-label when the design has no room for text.',
  'hidden-from-assistive-tech':
    'Either drop the aria-hidden (and name the control) or take it out of the tab order with tabindex="-1" — an element cannot be both reachable and hidden.',
  'labelledby-missing-target':
    'Point aria-labelledby at an id that exists, or replace it with aria-label. A dangling reference names nothing.',
  'symbol-only':
    'Add aria-label describing the action ("Search products"), and keep the icon as decoration with aria-hidden="true".',
  uninformative:
    'Name it after what it does, not where it goes: "Read the returns policy", not "read more". Screen-reader users list controls out of context.',
  'placeholder-only':
    'Add a <label for>. A placeholder disappears as soon as the field has content, and several screen readers never announce it.',
  'title-only':
    'Add a visible label or aria-label. title only surfaces on mouse hover, so keyboard and touch users never get it.',
  'conflicting-labels':
    'Keep one. aria-labelledby wins in every browser, so delete the aria-label or the aria-labelledby, whichever is not the intended name.',
};

const NAME_PROBLEM_CRITERION: Record<NameProblemKind, WcagCriterion> = {
  missing: WCAG.nameRoleValue,
  'hidden-from-assistive-tech': WCAG.nameRoleValue,
  'labelledby-missing-target': WCAG.nameRoleValue,
  'symbol-only': WCAG.nameRoleValue,
  uninformative: WCAG.linkPurpose,
  'placeholder-only': WCAG.labelsOrInstructions,
  'title-only': WCAG.labelsOrInstructions,
  'conflicting-labels': WCAG.nameRoleValue,
};

function nameFinding(problem: NameProblem, route: string): DeepFindingInput {
  const el = problem.element;
  return {
    code: NAME_PROBLEM_CODES[problem.kind],
    severity: NAME_PROBLEM_SEVERITY[problem.kind],
    criterion: NAME_PROBLEM_CRITERION[problem.kind],
    location: `${route} ${el.selector}`,
    problem: `The ${describeElement(el)} at ${el.selector} on ${route} has a name problem: ${problem.detail}.`,
    remedy: NAME_PROBLEM_REMEDY[problem.kind],
  };
}

// ── The walk ──

interface WalkOptions {
  maxTabStops: number;
  budgetMs: number;
  signal: AbortSignal | null;
}

/**
 * Presses Tab until the ring closes, repeats, or the budget runs out.
 *
 * The ring is "closed" when focus passes through the document (Chromium's
 * wrap-around) or returns to the first element it visited. Everything else — a
 * stop that never moves, a cycle that never reaches the document — is left for
 * `analyseTabRing` to interpret, because deciding "this is a trap" needs the
 * candidate list too.
 */
export async function walkTabRing(
  page: Page,
  nodes: JSHandle<unknown>,
  options: WalkOptions,
): Promise<{ stops: TabStop[]; exhausted: boolean }> {
  const stops: TabStop[] = [];
  const deadline = Date.now() + options.budgetMs;
  // Playwright unwraps a JSHandle argument to the value it points at; the cast
  // is what tells the compiler which value that is.
  const readArg = {
    nodes: nodes as JSHandle<DomElement[]>,
    styleProps: FOCUS_STYLE_PROPS as readonly string[],
    dialogSelector: DIALOG_SELECTOR,
  };

  let firstIndex: number | null = null;

  for (let position = 0; position < options.maxTabStops; position++) {
    if (options.signal?.aborted) return { stops, exhausted: true };
    if (Date.now() > deadline) return { stops, exhausted: true };

    await page.keyboard.press('Tab');
    const stop = { position, ...(await page.evaluate(inPage(readFocus), readArg)) };
    stops.push(stop);

    // The document itself: focus has wrapped past the last control, so the ring
    // is closed and we have seen everything in it.
    if (stop.documentLevel) return { stops, exhausted: false };

    if (firstIndex === null) firstIndex = stop.index;
    else if (stop.index === firstIndex && stop.index >= 0) return { stops, exhausted: false };

    // Stopped moving. `analyseTabRing` needs two identical stops to say so, and
    // it now has them; walking 198 more would prove nothing.
    const previous = stops[stops.length - 2];
    if (previous && !previous.documentLevel && previous.index === stop.index && stop.index >= 0) {
      return { stops, exhausted: false };
    }
  }

  return { stops, exhausted: true };
}

/**
 * Can focus get out of here at all?
 *
 * Tried in the order a user would: Shift+Tab first (the standard way back), then
 * each configured escape key followed by a Tab. WHICH one worked is reported —
 * 2.1.2 allows a non-standard exit only if the user is told about it.
 *
 * `confined` is the set of elements the focus is stuck among, and it is why this
 * takes a SET rather than the one element focus happened to be on. For a stop
 * that never advances that set has one member; for a ring that cycles between a
 * dialog's first and last control it has several, and "focus moved" is not the
 * question — moving from one member of the cycle to another is the trap working
 * as designed. Escaping means reaching something outside the set, or the
 * document itself.
 */
async function probeEscape(
  page: Page,
  nodes: JSHandle<unknown>,
  confined: ReadonlySet<number>,
  escapeKeys: readonly string[],
): Promise<{ escaped: boolean; via: string }> {
  const readArg = {
    nodes: nodes as JSHandle<DomElement[]>,
    styleProps: [] as readonly string[],
    dialogSelector: DIALOG_SELECTOR,
  };
  const out = (stop: Omit<TabStop, 'position'>): boolean =>
    stop.documentLevel || !confined.has(stop.index);

  await page.keyboard.press('Shift+Tab');
  if (out(await page.evaluate(inPage(readFocus), readArg))) {
    return { escaped: true, via: 'Shift+Tab' };
  }

  for (const key of escapeKeys) {
    await page.keyboard.press(key);
    await page.keyboard.press('Tab');
    if (out(await page.evaluate(inPage(readFocus), readArg))) return { escaped: true, via: key };
  }

  return { escaped: false, via: '' };
}

// ── Focus management scenarios ──

type ModalConfig = z.infer<typeof modalSchema>;
type RouteChangeConfig = z.infer<typeof routeChangeSchema>;

/**
 * Open a dialog with the keyboard, look at where focus went, prove it is held,
 * close it, and look at where focus came back to.
 *
 * Opened with focus + Enter rather than a click on purpose: a control that only
 * responds to a mouse is itself a 2.1.1 failure, and clicking it would hide
 * that.
 */
async function checkModal(
  deps: DeepA11yDeps,
  modal: ModalConfig,
  route: string,
): Promise<DeepFindingInput[]> {
  const { page } = deps;
  const out: DeepFindingInput[] = [];
  const where = `${route} → ${modal.name}`;
  const dialogSelector = modal.dialog ?? DIALOG_SELECTOR;

  const trigger = page.locator(modal.trigger).first();
  if ((await trigger.count()) === 0) {
    out.push({
      code: `${DEEP_A11Y_CODE_PREFIX}inconclusive.focusManagement`,
      severity: 'MINOR',
      criterion: WCAG.focusOrder,
      location: where,
      problem: `The modal scenario “${modal.name}” did not run: nothing on ${route} matches its trigger selector ${modal.trigger}.`,
      remedy: 'Fix the selector in deep.focusManagement.modals, or drop the scenario.',
    });
    return out;
  }

  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.locator(dialogSelector).first();
  let opened = await dialog.isVisible().catch(() => false);
  if (!opened) {
    // Fall back to a mouse click. If THAT opens it, the keyboard path is broken
    // and that is the finding.
    await trigger.click({ timeout: 5000 }).catch(() => {});
    opened = await dialog.isVisible().catch(() => false);
    if (opened) {
      out.push({
        code: `${DEEP_A11Y_CODE_PREFIX}keyboard.not-operable`,
        severity: 'SERIOUS',
        criterion: WCAG.keyboard,
        location: `${where} ${modal.trigger}`,
        problem: `The control ${modal.trigger} on ${route} opens “${modal.name}” when clicked but does nothing when it has focus and Enter is pressed.`,
        remedy:
          'Use a <button>, or handle keydown for Enter and Space as well as click. A div with an onclick is invisible to the keyboard.',
      });
    } else {
      out.push({
        code: `${DEEP_A11Y_CODE_PREFIX}inconclusive.focusManagement`,
        severity: 'MINOR',
        criterion: WCAG.focusOrder,
        location: where,
        problem: `The modal scenario “${modal.name}” did not run: ${modal.trigger} did not make ${dialogSelector} visible with either the keyboard or a click.`,
        remedy: 'Check the trigger and dialog selectors in deep.focusManagement.modals.',
      });
      return out;
    }
  }

  const insideDialog = async (): Promise<boolean> =>
    page
      .evaluate(
        inPage((selector: string) => {
          const doc = (globalThis as unknown as DomWindow).document;
          const container = doc.querySelectorAll(selector)[0];
          const active = doc.activeElement;
          return Boolean(container && active && container.contains(active) && active !== doc.body);
        }),
        dialogSelector,
      )
      .catch(() => false);

  if (!(await insideDialog())) {
    out.push({
      code: `${DEEP_A11Y_CODE_PREFIX}focus.modal-not-moved`,
      severity: 'SERIOUS',
      criterion: WCAG.focusOrder,
      location: `${where} ${dialogSelector}`,
      problem: `Opening “${modal.name}” on ${route} left focus outside the dialog, so a screen-reader user is told nothing opened and a keyboard user has to tab through the rest of the page to reach it.`,
      remedy:
        'On open, move focus to the dialog itself (tabindex="-1" plus .focus()) or to its first control, and give the container role="dialog" aria-modal="true".',
    });
  }

  // Does it hold focus while it is open?
  let escapedDialog = false;
  for (let i = 0; i < modal.maxTrapProbes; i++) {
    await page.keyboard.press('Tab');
    if (!(await insideDialog())) {
      escapedDialog = true;
      break;
    }
  }
  if (escapedDialog) {
    out.push({
      code: `${DEEP_A11Y_CODE_PREFIX}focus.modal-not-trapped`,
      severity: 'MODERATE',
      criterion: WCAG.focusOrder,
      location: `${where} ${dialogSelector}`,
      problem: `While “${modal.name}” is open on ${route}, Tab moves focus out of the dialog and into the page behind it, which is still reachable but visually covered.`,
      remedy:
        "Cycle focus between the dialog's first and last focusable elements, or mark the rest of the document inert while the dialog is open.",
    });
  }

  // Close it, the keyboard way first.
  let closed = false;
  if (modal.closeKey) {
    await page.keyboard.press(modal.closeKey);
    closed = !(await dialog.isVisible().catch(() => false));
  }
  if (!closed && modal.close) {
    const closeControl = page.locator(modal.close).first();
    if ((await closeControl.count()) > 0) {
      await closeControl.focus().catch(() => {});
      await page.keyboard.press('Enter');
      closed = !(await dialog.isVisible().catch(() => false));
    }
  }

  if (!closed) {
    out.push({
      code: `${DEEP_A11Y_CODE_PREFIX}focus.modal-not-closable`,
      severity: 'SERIOUS',
      criterion: WCAG.noKeyboardTrap,
      location: `${where} ${dialogSelector}`,
      problem: `“${modal.name}” on ${route} could not be closed from the keyboard: ${modal.closeKey ?? 'no close key'} did not dismiss it${modal.close ? ` and neither did ${modal.close}` : ' and no close control was configured'}.`,
      remedy:
        'Close on Escape, and make sure the close control is a real button that responds to Enter and Space.',
    });
    return out;
  }

  if (modal.expectFocusRestored) {
    const restored = await page
      .evaluate(
        inPage((selector: string) => {
          const doc = (globalThis as unknown as DomWindow).document;
          const target = doc.querySelectorAll(selector)[0];
          return Boolean(target && doc.activeElement === target);
        }),
        modal.trigger,
      )
      .catch(() => false);

    if (!restored) {
      out.push({
        code: `${DEEP_A11Y_CODE_PREFIX}focus.modal-not-restored`,
        severity: 'MODERATE',
        criterion: WCAG.focusOrder,
        location: `${where} ${modal.trigger}`,
        problem: `Closing “${modal.name}” on ${route} did not put focus back on the control that opened it (${modal.trigger}); the user is left wherever the browser defaulted to, usually the top of the document.`,
        remedy:
          'Remember the element that had focus when the dialog opened and call .focus() on it after closing.',
      });
    }
  }

  return out;
}

/**
 * Change the view without a page load and see whether focus was managed.
 *
 * The full-page-load case is deliberately NOT a finding: the browser resets
 * focus to the document and announces the new page itself, which is correct
 * behaviour. Only a same-document (SPA) change has to move focus in code, so the
 * check first establishes which of the two happened — by holding a handle to an
 * object in the page, which a real navigation destroys.
 */
async function checkRouteChange(
  deps: DeepA11yDeps,
  routeChange: RouteChangeConfig,
  route: string,
): Promise<DeepFindingInput[]> {
  const { page } = deps;
  const out: DeepFindingInput[] = [];
  const where = `${route} → ${routeChange.name}`;

  const trigger = page.locator(routeChange.trigger).first();
  if ((await trigger.count()) === 0) {
    out.push({
      code: `${DEEP_A11Y_CODE_PREFIX}inconclusive.focusManagement`,
      severity: 'MINOR',
      criterion: WCAG.focusOrder,
      location: where,
      problem: `The route-change scenario “${routeChange.name}” did not run: nothing on ${route} matches its trigger selector ${routeChange.trigger}.`,
      remedy: 'Fix the selector in deep.focusManagement.routeChanges, or drop the scenario.',
    });
    return out;
  }

  const urlBefore = page.url();
  const token = await page.evaluateHandle(() => ({ live: true }));

  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  const sameDocument = await page
    .evaluate(
      inPage((held: { live: boolean }) => held.live === true),
      token,
    )
    .catch(() => false);
  await token.dispose().catch(() => {});

  if (!sameDocument) {
    // A real navigation. The browser handles focus and the announcement; there
    // is nothing here to fail.
    return out;
  }

  if (page.url() === urlBefore) {
    out.push({
      code: `${DEEP_A11Y_CODE_PREFIX}inconclusive.focusManagement`,
      severity: 'MINOR',
      criterion: WCAG.focusOrder,
      location: where,
      problem: `The route-change scenario “${routeChange.name}” did not run: activating ${routeChange.trigger} with the keyboard changed neither the URL nor the document.`,
      remedy: 'Point the scenario at a control that actually changes the view.',
    });
    return out;
  }

  const focus = await page
    .evaluate(
      inPage((selector: string | null) => {
        const doc = (globalThis as unknown as DomWindow).document;
        const active = doc.activeElement;
        const atDocument = !active || active === doc.body || active === doc.documentElement;
        const expected = selector ? doc.querySelectorAll(selector)[0] : null;
        return {
          atDocument,
          tag: active ? active.tagName.toLowerCase() : 'none',
          inExpected: Boolean(expected && active && expected.contains(active)),
          expectedExists: Boolean(expected),
        };
      }),
      routeChange.expectFocus ?? null,
    )
    .catch(() => null);

  if (!focus) return out;

  if (focus.atDocument) {
    out.push({
      code: `${DEEP_A11Y_CODE_PREFIX}focus.route-change-lost`,
      severity: 'MODERATE',
      criterion: WCAG.focusOrder,
      location: where,
      problem: `Activating ${routeChange.trigger} on ${route} replaced the view without a page load and left focus on <${focus.tag}>. A screen-reader user hears nothing and keeps their old position; a keyboard user starts again from the top of the document.`,
      remedy:
        'Move focus to the new view\'s heading (give it tabindex="-1" and call .focus()) or announce the change in an aria-live region.',
    });
  } else if (routeChange.expectFocus && focus.expectedExists && !focus.inExpected) {
    out.push({
      code: `${DEEP_A11Y_CODE_PREFIX}focus.route-change-lost`,
      severity: 'MODERATE',
      criterion: WCAG.focusOrder,
      location: `${where} ${routeChange.expectFocus}`,
      problem: `Activating ${routeChange.trigger} on ${route} left focus on <${focus.tag}> rather than inside ${routeChange.expectFocus}, where the spec says the new view begins.`,
      remedy: `Call .focus() on ${routeChange.expectFocus} (or an element inside it) once the new view has rendered.`,
    });
  }

  return out;
}
