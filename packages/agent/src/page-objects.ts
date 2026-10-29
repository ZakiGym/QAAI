/**
 * PAGE-OBJECT SYNTHESIS — the page object the crawl already knows how to write.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * Five separate prompts in packages/agent/src/ecosystem-prompts.ts tell the
 * model to use a Page Object once a plan touches more than one page, and until
 * `artifactSetSchema` landed the output shape could carry ONE `code` and ONE
 * `filePath` — so the only thing the model could do with that instruction was
 * ignore it, or inline the page object into the spec. Setup therefore got
 * copy-pasted into every test, which is simultaneously the thing reviewers
 * delete tests for and the thing that makes a suite unmaintainable.
 *
 * ── Why no model is called from this file ──────────────────────────────────
 *
 * The crawl already produced the locators, the forms, the controls and the
 * navigation edges for each page. That is EVERYTHING a page object contains:
 * named accessors over observed locators, a method per observed navigation, and
 * a filler per observed form. There is nothing left to invent, and the rule
 * `locators.ts` already lives by applies — "a suggestion that is merely
 * plausible is worse than none when the whole point is that the locator
 * exists". So this module is deterministic, pure, and testable with no API key;
 * a model may narrate what it produced and may never produce it.
 *
 * In particular this module NEVER derives a locator the crawl did not sight.
 * A `getByRole('link', { name: 'Checkout' })` synthesised from a CSS sighting
 * plus a label is a locator nobody has ever run, dressed in the costume of the
 * most reliable kind there is. See {@link chooseSighting} for the one choice
 * that IS made — between two sightings the crawl really did record.
 *
 * ── Brittle locators are REPORTED, never wrapped ───────────────────────────
 *
 * Wrapping `div.sc-x7f2 > span:nth-child(3)` in a method called
 * `orderTotal()` does not make it less brittle; it makes the flake harder to
 * find, because the next reader sees a tidy page object and not a selector
 * coupled to a build-time class hash. So a page whose sighted locators are ALL
 * brittle is refused by name ({@link PAGE_OBJECT_REFUSALS}' `ALL_LOCATORS_BRITTLE`)
 * and every synthesis — refused or not — carries its {@link LocatorBrittleness}
 * counts. The threshold is `BRITTLE_LOCATOR_FAIL_RATIO`, imported from
 * admission.ts rather than restated, because "how brittle is too brittle" must
 * have one answer in this product and suite-health.ts records what happens when
 * one question gets two vocabularies.
 *
 * ── Every crawled string in here is UNTRUSTED ──────────────────────────────
 *
 * A route, an affordance's label, a form field's name, an edge's action text
 * and a select option are all page content, which in a real deployment is
 * attacker-influenced — and this module's output is written into the customer's
 * repository. So the rule is structural rather than hopeful:
 *
 *   · Untrusted text reaches generated source ONLY inside a string literal
 *     escaped by that language's own quoter ({@link tsLiteral},
 *     {@link pyLiteral}). It is never placed in a COMMENT, where a
 *     close-comment sequence inside it would end the comment and begin code,
 *     and it never becomes an identifier unsanitised.
 *   · An identifier is derived through {@link identifierFrom}, which emits
 *     `[A-Za-z_$][A-Za-z0-9_$]*` and nothing else.
 *   · A route decides a FILE NAME, so it must pass {@link safeRoute} or the
 *     page is refused with `UNSAFE_ROUTE`. Rule: untrusted text never decides
 *     a path.
 *
 * page-objects.test.ts pins all three as properties over hostile inputs, not as
 * examples.
 */

import type {
  DialectId,
  FormField,
  FormFieldSemantic,
  FormModel,
  Selector,
  SelectorStrategy,
} from '@qaai/shared';
import { locatorExpression } from '@qaai/shared';
import { BRITTLE_LOCATOR_FAIL_RATIO } from './admission.js';
import { ECOSYSTEMS, type EcosystemId } from './ecosystem-prompts.js';
import type { LocatorStrategy, StyleProfile } from '@qaai/shared';
import { CONFIDENCE_IS_USABLE } from '@qaai/shared';

/*
 * The two imports above cross the workspace boundary, which is a defect and is
 * recorded as one — the same one `authz-probe.ts` carries for the same reason.
 * `packages/shared/src/style-profile.ts` is not on its package barrel, so none
 * of the house-style vocabulary is reachable through `@qaai/shared`.
 * `packages/shared/src/index.ts` belongs to another change in this round; the
 * one-line fix is in this slice's handover, and when it lands both lines become
 * `@qaai/shared`.
 */

// ─── Caps, each one disclosed where it bites ────────────────────────────────

/**
 * Named accessors on one page object. A page with more controls than this is a
 * data grid, and generating 300 getters over its cells produces a file nobody
 * reads and a diff nobody reviews.
 *
 * What is dropped is reported as a count and a reason in
 * {@link PageObjectModel.omitted} — never silently, because a page object
 * missing the control a spec needs reads as a generation bug rather than a cap.
 */
export const MAX_ACCESSORS_PER_PAGE = 40;

/** Navigation methods. Past this the page is a nav bar, not a page. */
export const MAX_NAVIGATIONS_PER_PAGE = 20;

/** Forms per page. Six is a checkout page with every address variant open. */
export const MAX_FORMS_PER_PAGE = 6;

/** Fields per filler. A longer form is a wizard and belongs to several. */
export const MAX_FIELDS_PER_FORM = 30;

/** An identifier derived from a label. Long enough to stay readable, short enough to stay a name. */
export const MAX_IDENTIFIER_CHARS = 60;

/**
 * A crawled string inside a generated literal.
 *
 * Bounded for the same reason `fenceUntrusted` bounds a prompt span: an
 * accessible name is a few words, and a page that returns 40kB of text as one
 * element's label is either broken or hostile.
 *
 * A TRUNCATED LOCATOR DOES NOT MATCH, so this cap is reported where it bites —
 * {@link buildModel} counts the strings it shortened into
 * {@link PageObjectModel.omitted}. A reviewer who was not told would go looking
 * for the bug in the application, which is a cap applied without being
 * disclosed wearing a day of somebody's time.
 */
export const MAX_LITERAL_CHARS = 200;

/** A route, as a string. Longer than this and it is a payload. */
export const MAX_ROUTE_CHARS = 200;

/**
 * The confidence below which the Explorer's own documentation says a locator
 * needs a human eye: `Selector.confidence` in packages/shared/src/flow-map.ts
 * states "anything below 0.6 gets a review flag on generation".
 *
 * That sentence was prose in a doc comment and nothing in the repository was a
 * value for it. This is that value. It is deliberately the same number rather
 * than a new judgement, so there is one definition of "the crawl was not sure".
 */
export const LOCATOR_REVIEW_CONFIDENCE = 0.6;

// ─── Brittleness: one question, one vocabulary ──────────────────────────────

/**
 * Is a locator reached by THIS STRATEGY coupled to something that is not the
 * behaviour?
 *
 * Compiler-enforced over `SelectorStrategy`, so a seventh strategy cannot be
 * added to the crawl without deciding this. Only CSS is true, and that matches
 * both of the places this product already decided it: `SELECTOR_STRATEGIES` in
 * flow-map.ts is ranked most→least resilient with CSS last and commented "last
 * resort", and admission.ts's LOCATORS gate counts role/label/text/test-id
 * calls as resilient and everything structural as brittle.
 *
 * This records the STRATEGY-level judgement, which is all a crawled `Selector`
 * carries. The gate's finer judgement — a generated class hash, a positional
 * chain, an absolute XPath — operates on rendered source and stays its job;
 * duplicating its regexes here would be the second vocabulary for one question
 * that suite-health.ts's two assertion lexicons already cost this repo a slice.
 */
export const STRATEGY_IS_BRITTLE = {
  ROLE: false,
  LABEL: false,
  PLACEHOLDER: false,
  TEXT: false,
  TEST_ID: false,
  CSS: true,
} as const satisfies Record<SelectorStrategy, boolean>;

/**
 * Resilience rank, lowest first — `SELECTOR_STRATEGIES`' own order, as a
 * lookup.
 *
 * Compiler-enforced for the same reason the record above is. The list in
 * flow-map.ts is already ordered; this makes the order comparable without a
 * second opinion about what it is.
 */
export const STRATEGY_RESILIENCE_RANK = {
  ROLE: 0,
  LABEL: 1,
  PLACEHOLDER: 2,
  TEXT: 3,
  TEST_ID: 4,
  CSS: 5,
} as const satisfies Record<SelectorStrategy, number>;

/**
 * The style profile's `locatorStrategy` vocabulary is NOT the crawl's: it has
 * XPATH and PAGE_OBJECT, which no `Selector` can be, and it lacks PLACEHOLDER.
 *
 * Null means "this preference says nothing about which sighting to prefer",
 * which is the honest answer for both of the members that are not selector
 * strategies at all: PAGE_OBJECT is a statement that specs contain no locators
 * (the strongest signal there is, and an argument FOR this module rather than a
 * choice between sightings), and XPATH is a strategy this crawl never emits.
 *
 * Compiler-enforced over `LOCATOR_STRATEGIES`, so a member added to the profile
 * vocabulary cannot silently mean "no preference".
 */
export const PREFERRED_SIGHTING_STRATEGY = {
  ROLE: 'ROLE',
  LABEL: 'LABEL',
  TEST_ID: 'TEST_ID',
  TEXT: 'TEXT',
  CSS: null,
  XPATH: null,
  PAGE_OBJECT: null,
} as const satisfies Record<LocatorStrategy, SelectorStrategy | null>;

/** Why one sighted locator is weaker than the strategy name alone suggests. */
export const BRITTLE_CAUSES = [
  /** The strategy itself couples to DOM shape. See {@link STRATEGY_IS_BRITTLE}. */
  'STRATEGY',
  /** The Explorer's own confidence is below {@link LOCATOR_REVIEW_CONFIDENCE}. */
  'LOW_CONFIDENCE',
] as const;
export type BrittleCause = (typeof BRITTLE_CAUSES)[number];

/** Does this cause mean the APPLICATION is hard to test, or that the CRAWL was unsure? */
export const CAUSE_IS_APPLICATION_FAULT = {
  STRATEGY: true,
  LOW_CONFIDENCE: false,
} as const satisfies Record<BrittleCause, boolean>;

/**
 * How many of a page's sighted locators are brittle, and why.
 *
 * `brittle: 0` here is a MEASUREMENT: every sighting was classified, so "none
 * were brittle" is something we looked for. A page with no sightings at all
 * reports `total: 0` and is refused with `NO_CONTROLS` rather than reported as
 * perfectly clean.
 */
export interface LocatorBrittleness {
  readonly total: number;
  readonly brittle: number;
  /** Causes seen, each with its count. Sorted for a stable diff. */
  readonly causes: readonly { readonly cause: BrittleCause; readonly count: number }[];
  /** `brittle / total`, or 0 when nothing was sighted. Compare with {@link BRITTLE_LOCATOR_FAIL_RATIO}. */
  readonly ratio: number;
}

function brittleCauses(selector: Selector): readonly BrittleCause[] {
  const causes: BrittleCause[] = [];
  if (STRATEGY_IS_BRITTLE[selector.strategy]) causes.push('STRATEGY');
  if (selector.confidence < LOCATOR_REVIEW_CONFIDENCE) causes.push('LOW_CONFIDENCE');
  return causes;
}

function measureBrittleness(selectors: readonly Selector[]): LocatorBrittleness {
  const counts = new Map<BrittleCause, number>();
  let brittle = 0;
  for (const selector of selectors) {
    const causes = brittleCauses(selector);
    if (causes.length > 0) brittle += 1;
    for (const cause of causes) counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return {
    total: selectors.length,
    brittle,
    causes: [...counts.entries()]
      .map(([cause, count]) => ({ cause, count }))
      .sort((a, b) => byCodeUnit(a.cause, b.cause)),
    ratio: selectors.length === 0 ? 0 : brittle / selectors.length,
  };
}

// ─── Untrusted text: identifiers, literals and routes ───────────────────────

/**
 * A route that may decide a file name.
 *
 * Deliberately a whitelist and deliberately narrow: a route reaches this module
 * from a crawl of somebody's application, a link on a page can say anything, and
 * this string ends up both in a generated `goto()` literal and in a FILE NAME.
 * `..`, a backslash, a backtick, a `$`, a quote and a newline are all absent
 * from this class, so the escaping below is a second line of defence rather than
 * the only one.
 */
const SAFE_ROUTE_CHARS = /^\/[A-Za-z0-9/:._~-]*$/;

/**
 * Is this a route a generated file may be named after and navigate to?
 *
 * The character class alone is NOT enough, and that was found by this module's
 * own test rather than by reasoning: `/../../etc/passwd` is made entirely of
 * admitted characters. A `..` segment is not a route — the crawl normalises
 * routes and never produces one — so a route carrying one is either a broken
 * normalisation or a crafted link, and both are refusals. `.` alone goes with
 * it for the same reason.
 */
function safeRoute(route: string): boolean {
  if (!SAFE_ROUTE_CHARS.test(route)) return false;
  return !route.split('/').some((segment) => segment === '..' || segment === '.');
}

/** A dynamic segment, as the crawl normalises it: `/orders/:id`. */
const ROUTE_PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

/** Control characters and the Unicode direction overrides that hide code in plain sight. */
const UNSAFE_LITERAL_CHARS = new RegExp(
  '[' +
    '\\u0000-\\u001f\\u007f-\\u009f' + // C0 and C1 controls
    '\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069' + // zero-width and bidi overrides
    '\\ufeff' + // byte-order mark
    ']',
  'gu',
);

/**
 * Order two strings by CODE UNIT, not by locale.
 *
 * `String.prototype.localeCompare` with no locale argument uses the HOST's
 * default collation, which differs between machines and ICU versions. Every
 * tie-break in this module and in artifacts.ts decides the BYTES of a generated
 * file — which accessor is declared first, which of two candidate page objects
 * is reused — so a locale-dependent comparator would make "byte-identical on
 * two runs" true on one developer's laptop and false in CI. That is the kind of
 * determinism claim that is worse than no claim.
 */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Split on case boundaries and separators, the way ecosystem-prompts.ts already does. */
function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/**
 * An identifier from untrusted text, or the fallback.
 *
 * Emits `[A-Za-z_$][A-Za-z0-9_$]*` and nothing else, by construction rather
 * than by escaping: every character that is not `[A-Za-z0-9]` is a word
 * boundary and is dropped. A label of `"; drop table tests; --` therefore
 * yields `dropTableTests`, which is an ugly method name and not a statement.
 *
 * Leading digits are legal in a label and illegal in an identifier, so a
 * `"2 day shipping"` option becomes `n2DayShipping` — the same problem
 * `className` in ecosystem-prompts.ts solves with a `Test` prefix, solved the
 * same way.
 */
export function identifierFrom(input: string, fallback: string): string {
  const parts = words(input.slice(0, MAX_IDENTIFIER_CHARS * 3));
  if (parts.length === 0) return fallback;
  const head = parts[0]!.toLowerCase();
  const camel =
    head +
    parts
      .slice(1)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');
  const bounded = camel.slice(0, MAX_IDENTIFIER_CHARS);
  if (bounded.length === 0) return fallback;
  return /^[A-Za-z_$]/.test(bounded) ? bounded : `n${bounded}`;
}

/** The same derivation, in the PascalCase a class name needs. */
export function classNameFrom(input: string, fallback: string): string {
  const identifier = identifierFrom(input, fallback);
  return identifier.charAt(0).toUpperCase() + identifier.slice(1);
}

/**
 * camelCase → snake_case, for the languages whose identifiers are snake.
 *
 * Two passes, and the first one is why: a run of capitals has to break before
 * the last one, or `oBrienSBill` becomes `o_brien_sbill` — one word short of
 * readable, and the kind of generated name a reviewer rewrites.
 */
export function toSnake(identifier: string): string {
  return identifier
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * THE ONE POLICY FOR CROSSING INTO GENERATED SOURCE: bound it, and drop what
 * cannot be part of an accessible name.
 *
 * Every control and direction-override character is DROPPED rather than
 * escaped. A newline cannot be part of a label, and a raw one inside a
 * single-quoted JS string is an UNTERMINATED LITERAL — a generated file that
 * does not parse, which reads to a reviewer as a broken generator rather than
 * as a hostile page. A right-to-left override is a review-evasion trick, not a
 * label: it makes a diff read one way and execute another.
 *
 * Applied in THREE places and written once, which is the point:
 * {@link tsLiteral}, {@link pyLiteral}, and {@link boundedSelector} — the last
 * because the TypeScript renderer quotes through `locatorExpression` in
 * @qaai/shared, which escapes a quote and a backslash correctly and bounds
 * nothing. That gap shipped a 212-character locator and a raw newline past both
 * quoters until this module's own truncation test caught it.
 */
function safeLiteralText(input: string): string {
  return input.slice(0, MAX_LITERAL_CHARS).replace(UNSAFE_LITERAL_CHARS, '');
}

/**
 * Untrusted text as a JS/TS single-quoted literal, with the quotes.
 *
 * Backslash first — reversing the order would re-escape the escapes and let
 * `\'` through as a closing quote.
 */
export function tsLiteral(input: string): string {
  return `'${safeLiteralText(input).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The same, as a Python double-quoted literal. */
export function pyLiteral(input: string): string {
  return `"${safeLiteralText(input).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A selector whose crawled strings have been through {@link safeLiteralText}.
 *
 * Applied in {@link buildModel}, so the MODEL carries bounded strings and every
 * renderer — including one a caller injects — inherits the bound rather than
 * having to remember it. Putting it in the renderers would mean the next
 * renderer added is the one that forgets.
 */
export function boundedSelector(selector: Selector): Selector {
  return {
    ...selector,
    value: safeLiteralText(selector.value),
    ...(selector.name === undefined ? {} : { name: safeLiteralText(selector.name) }),
  };
}

/** A route slug safe to use as a file name: `/orders/:id` → `orders-id`. */
export function routeSlug(route: string): string {
  const parts = route
    .split('/')
    .flatMap((segment) => words(segment))
    .map((part) => part.toLowerCase());
  return parts.length === 0 ? 'root' : parts.join('-').slice(0, MAX_IDENTIFIER_CHARS);
}

// ─── The input: what a page is, narrowly ────────────────────────────────────

/** One interactive element the crawl sighted, in the shape `FlowNode.affordances` holds. */
export interface SightedAffordance {
  readonly label: string;
  readonly selector: Selector;
  readonly kind: 'link' | 'button' | 'input';
}

/** One navigation out of this page, from a `FlowEdge` whose `from` is this node. */
export interface SightedNavigation {
  /** The Explorer's own description. UNTRUSTED, and never rendered — see the header. */
  readonly action: string;
  /** The control that traverses it, when the edge had one. Null means "navigate by URL". */
  readonly selector: Selector | null;
  /** The route this lands on. Decides the method name, so it goes through {@link safeRoute}. */
  readonly toRoute: string;
}

/**
 * One page, as a page object needs it.
 *
 * Narrower than `FlowNode` on purpose: this module must be callable from a
 * crawl, from an imported suite and from a test, and a function that demands a
 * whole `FlowMap` is a function with no unit test. {@link pageSourcesFrom}
 * builds these from a flow map, and is the only place the node→edge join
 * happens.
 */
export interface PageSource {
  readonly route: string;
  readonly affordances: readonly SightedAffordance[];
  readonly forms: readonly FormModel[];
  readonly navigations: readonly SightedNavigation[];
}

/** The shape {@link pageSourcesFrom} reads: nodes with ids and routes, and edges between them. */
export interface FlowMapPageInput {
  readonly nodes: readonly {
    readonly id: string;
    readonly route: string;
    readonly affordances: readonly SightedAffordance[];
    readonly forms: readonly FormModel[];
  }[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly action: string;
    readonly selector: Selector | null;
  }[];
}

/**
 * One {@link PageSource} per node, with the node's outgoing edges resolved to
 * routes.
 *
 * An edge whose `to` names a node this map does not contain is DROPPED and
 * counted by the caller's `omitted`, not silently resolved to the edge's own
 * page: a self-navigation that is really a dangling pointer would render a
 * method that goes nowhere.
 */
export function pageSourcesFrom(flowMap: FlowMapPageInput): readonly PageSource[] {
  const routeById = new Map(flowMap.nodes.map((node) => [node.id, node.route]));
  return flowMap.nodes.map((node) => ({
    route: node.route,
    affordances: node.affordances,
    forms: node.forms,
    navigations: flowMap.edges
      .filter((edge) => edge.from === node.id)
      .flatMap((edge) => {
        const toRoute = routeById.get(edge.to);
        return toRoute === undefined
          ? []
          : [{ action: edge.action, selector: edge.selector, toRoute }];
      }),
  }));
}

// ─── The model: a page object, before any language ──────────────────────────

/** One named accessor over one sighted locator. */
export interface PageObjectAccessor {
  /** camelCase, from {@link identifierFrom}. Renderers re-case it. */
  readonly name: string;
  readonly kind: 'link' | 'button' | 'input';
  readonly strategy: SelectorStrategy;
  readonly confidence: number;
  /** The locator call, without a root — `locatorExpression`'s output for TS. */
  readonly selector: Selector;
  /** Non-empty when this accessor wraps something a reviewer must look at. */
  readonly brittleCauses: readonly BrittleCause[];
}

/** One navigation method. */
export interface PageObjectNavigation {
  readonly name: string;
  readonly toRoute: string;
  /** The control to click, or null for a direct `goto`. */
  readonly selector: Selector | null;
}

/** One field of a form filler, with the semantic the data generator keys on. */
export interface PageObjectField {
  /** The parameter name. camelCase, derived from the field's own name or label. */
  readonly name: string;
  /** The crawled field name, for the data generator and the dataset file. */
  readonly fieldName: string;
  readonly semantic: FormFieldSemantic;
  readonly required: boolean;
  readonly selector: Selector;
  /** How the value gets in: the only three a page object can drive without a path. */
  readonly how: 'FILL' | 'SELECT' | 'CHECK';
}

/** One form, as a filler and a submitter. */
export interface PageObjectFiller {
  /** `fillSignUpForm`. */
  readonly name: string;
  /** `submitSignUpForm`, present only when the crawl sighted a submit control. */
  readonly submitName: string | null;
  readonly fields: readonly PageObjectField[];
  readonly submit: Selector | null;
}

/** Something this page object does NOT contain, and why. Every cap that bit is here. */
export interface PageObjectOmission {
  readonly what: string;
  readonly why: string;
  readonly count: number;
}

/** A page object, language-independent. {@link PageObjectRenderer} turns it into source. */
export interface PageObjectModel {
  /** The normalised route, already checked against {@link safeRoute}. */
  readonly route: string;
  /** `CartPage`. */
  readonly className: string;
  /** Dynamic segments, in route order, as identifiers: `/orders/:id` → `['id']`. */
  readonly routeParams: readonly string[];
  readonly accessors: readonly PageObjectAccessor[];
  readonly navigations: readonly PageObjectNavigation[];
  readonly fillers: readonly PageObjectFiller[];
  readonly brittleness: LocatorBrittleness;
  readonly omitted: readonly PageObjectOmission[];
}

// ─── Refusal ────────────────────────────────────────────────────────────────

/** Why a page got no page object. Closed, so no caller can treat a refusal as an empty one. */
export const PAGE_OBJECT_REFUSALS = [
  /** The crawl sighted no control, no form and no navigation on this page. */
  'NO_CONTROLS',
  /**
   * Every sighted locator is brittle. Wrapping it in a nice method name hides
   * the flake instead of removing it, so this is a FINDING about the
   * application and not a page object.
   */
  'ALL_LOCATORS_BRITTLE',
  /** The route does not match {@link safeRoute}, and a route decides a file name. */
  'UNSAFE_ROUTE',
  /** No built-in renderer for this ecosystem. See {@link PAGE_OBJECT_RENDERERS}. */
  'NO_RENDERER',
] as const;
export type PageObjectRefusal = (typeof PAGE_OBJECT_REFUSALS)[number];

/**
 * Does this refusal say something about the CUSTOMER'S APPLICATION, or about
 * QAAI'S REACH?
 *
 * The distinction is the one `UNAVAILABLE is not PASS` makes in admission.ts,
 * and it decides where the sentence goes: an application fault is a finding
 * worth reporting to the customer ("this page can only be reached by CSS
 * selectors"), and our own limit is an UNAVAILABLE we must not dress up as one.
 * Compiler-enforced so a fifth refusal has to choose.
 */
export const REFUSAL_IS_APPLICATION_FINDING = {
  NO_CONTROLS: true,
  ALL_LOCATORS_BRITTLE: true,
  UNSAFE_ROUTE: true,
  NO_RENDERER: false,
} as const satisfies Record<PageObjectRefusal, boolean>;

/** Synthesised, or refused with a reason — never an empty page object. */
export type PageObjectSynthesis =
  | {
      readonly state: 'SYNTHESISED';
      readonly model: PageObjectModel;
      /** The rendered source, and the renderer that produced it. */
      readonly source: string;
      readonly rendererId: EcosystemId;
      readonly fileName: string;
    }
  | {
      readonly state: 'REFUSED';
      readonly reason: PageObjectRefusal;
      readonly why: string;
      /** Measured even on a refusal: `ALL_LOCATORS_BRITTLE` is a count, not an adjective. */
      readonly brittleness: LocatorBrittleness;
    };

// ─── Choosing between sightings ─────────────────────────────────────────────

/** A normalised control identity within one page: the same control, sighted twice. */
function controlKey(affordance: SightedAffordance): string {
  return `${affordance.kind}\u0000${affordance.label.trim().toLowerCase()}`;
}

/**
 * THE ONE CHOICE THIS MODULE MAKES, and the one place the style profile bites.
 *
 * A crawl can sight the same control twice with two different strategies — a
 * role and a CSS fallback for one button. `controlsFromFlowMap` keeps both,
 * correctly, because they are two different locator expressions. A page object
 * must pick one.
 *
 * The order is:
 *
 *  1. THE PROJECT'S OWN PREFERENCE, when the profile states one at MEDIUM or
 *     above and that preference is a strategy the crawl emits and is NOT
 *     brittle. A generated `getByRole` in a suite built entirely on `data-qa`
 *     attributes is still a file that was not written here — which is the whole
 *     argument of style-profile.ts — and that file's own words settle the
 *     collision this creates: "the gate wins on CSS chains and this wins on the
 *     choice between role, label, text and test-id". So a preference for CSS or
 *     XPATH buys nothing: {@link PREFERRED_SIGHTING_STRATEGY} maps both to null.
 *  2. RESILIENCE, by {@link STRATEGY_RESILIENCE_RANK}.
 *  3. The Explorer's confidence, descending.
 *  4. The rendered expression, ascending — so two runs over one crawl produce
 *     the same page object and a diff shows a change in the application.
 */
export function chooseSighting(
  sightings: readonly SightedAffordance[],
  preferred: SelectorStrategy | null,
): SightedAffordance {
  const ranked = [...sightings].sort((a, b) => {
    if (preferred) {
      const aPreferred = a.selector.strategy === preferred ? 0 : 1;
      const bPreferred = b.selector.strategy === preferred ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    }
    const rank =
      STRATEGY_RESILIENCE_RANK[a.selector.strategy] - STRATEGY_RESILIENCE_RANK[b.selector.strategy];
    if (rank !== 0) return rank;
    if (a.selector.confidence !== b.selector.confidence) {
      return b.selector.confidence - a.selector.confidence;
    }
    return byCodeUnit(locatorExpression(a.selector), locatorExpression(b.selector));
  });
  return ranked[0]!;
}

/**
 * The strategy this project prefers, or null.
 *
 * Null for an UNKNOWN or LOW observation — `CONFIDENCE_IS_USABLE` is the record
 * that decides it, and a weakly-attested preference stated as a rule produces a
 * page object that matches nothing in the repository, which is worse than the
 * ecosystem default.
 */
export function preferredStrategy(profile: StyleProfile): SelectorStrategy | null {
  const observation = profile.locatorStrategy;
  if (!CONFIDENCE_IS_USABLE[observation.confidence] || observation.value === null) return null;
  return PREFERRED_SIGHTING_STRATEGY[observation.value];
}

// ─── Synthesis ──────────────────────────────────────────────────────────────

/** Unique names within one class, resolved deterministically rather than silently. */
function uniqueNamer(): (candidate: string) => string {
  const used = new Set<string>(['page', 'goto', 'route', 'constructor']);
  return (candidate) => {
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const next = `${candidate}${suffix}`;
      if (!used.has(next)) {
        used.add(next);
        return next;
      }
    }
    /*
     * A thousand controls on one page all deriving the same identifier. The cap
     * above it (MAX_ACCESSORS_PER_PAGE) makes this unreachable in practice; it
     * is written rather than thrown because an unreachable throw in a pure
     * function is a crash nobody can test, and a deterministic ugly name is a
     * reviewable outcome.
     */
    used.add(`${candidate}Overflow`);
    return `${candidate}Overflow`;
  };
}

/**
 * How a field's value gets in, from what the page declared.
 *
 * ── `field.inputType` IS DEREFERENCED, AND THE GUARD IS AT THE BOUNDARY ────
 *
 * `FormField.inputType` is declared required and non-nullable, so this line is
 * type-safe and a `?.` here would be a guard against a shape the type forbids.
 * The reachable defect was never in this function: `FlowMap.graph` is a Json
 * column, the generate processor used to turn it into a `FlowMap` by double
 * cast, and a stored crawl written before the field existed therefore arrived
 * here as `undefined.toLowerCase()` — an untraceable `TypeError` that took the
 * whole generate item down. That was LATENT while generation produced one file
 * and became reachable the moment the plan was wired in.
 *
 * It is closed by `readFlowGraph` in apps/worker/src/processors/generate.ts,
 * which PARSES the column: a field with no `inputType` is refused there with
 * the zod PATH reported and never the value, and the plan is then not computed
 * at all — so nothing in this file is ever handed a field the schema refused.
 * A SECOND guard here would be a second opinion about one question, and the
 * cheaper kind of wrong: it would turn a refused crawl into a page object
 * silently missing its accessors. If another caller of
 * {@link synthesisePageObject} ever appears, IT owes the parse.
 */
function howToFill(field: FormField): PageObjectField['how'] | null {
  const type = field.inputType.toLowerCase();
  if (type === 'select' || (field.options && field.options.length > 0)) return 'SELECT';
  if (type === 'checkbox' || type === 'radio') return 'CHECK';
  /*
   * A file input needs a PATH, and the only paths available here are derived
   * from crawled text — which rule 10 forbids from deciding a path, and which
   * would in any case point at a fixture the customer's suite does not have. So
   * a file field is omitted with a reason rather than filled with a guess.
   */
  if (type === 'file') return null;
  if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') return null;
  return 'FILL';
}

/** The suffix a form's methods are named after: `signUp` → `fillSignUpForm`. */
function formNoun(form: FormModel, index: number): string {
  const base = form.name.trim() || form.id.trim();
  const identifier = identifierFrom(base, `form${index + 1}`);
  return identifier.charAt(0).toUpperCase() + identifier.slice(1);
}

export interface SynthesisArgs {
  readonly page: PageSource;
  readonly profile: StyleProfile;
  /** Which ecosystem's source to render. A page object in a language the shop does not use is deleted. */
  readonly ecosystemId: EcosystemId;
  /** Override or extend the built-in renderers. Injected so a 40th ecosystem needs no edit here. */
  readonly renderers?: Partial<Record<EcosystemId, PageObjectRenderer>>;
  /**
   * The file-name stem, in the repository's OWN naming convention.
   *
   * Supplied by the planner, which is the only caller that has read the style
   * profile's `naming` field. Omitted here means {@link routeSlug} — the
   * ecosystem default, which is kebab — and a caller that omits it gets a name
   * that is conventional somewhere rather than one that is conventional HERE.
   */
  readonly fileStem?: string;
}

/**
 * The page object for one page, or the reason there is none.
 *
 * Deterministic: the same page and the same profile produce byte-identical
 * source in every process, forever. page-objects.test.ts pins that as a
 * property, because a page object that differs run to run produces a diff on
 * every generation and a reviewer who stops reading them.
 */
export function synthesisePageObject(args: SynthesisArgs): PageObjectSynthesis {
  const { page, profile, ecosystemId } = args;
  const renderer = args.renderers?.[ecosystemId] ?? PAGE_OBJECT_RENDERERS[ecosystemId];

  const sighted = [
    ...page.affordances.map((affordance) => affordance.selector),
    ...page.forms.flatMap((form) => [
      ...form.fields.map((field) => field.selector),
      ...(form.submit ? [form.submit] : []),
    ]),
    ...page.navigations.flatMap((navigation) => (navigation.selector ? [navigation.selector] : [])),
  ];
  const brittleness = measureBrittleness(sighted);

  if (page.route.length > MAX_ROUTE_CHARS || !safeRoute(page.route)) {
    return {
      state: 'REFUSED',
      reason: 'UNSAFE_ROUTE',
      /*
       * The route is NOT quoted back here. It is the untrusted value that
       * failed the check, this sentence travels into logs and review text, and
       * a refusal reason is not a place to carry the payload that caused it.
       * Its length is a fact about it that cannot be one.
       */
      why:
        `This page's route is not a plain relative path (${page.route.length} character(s)), and a ` +
        'route decides a generated file name, so no page object was synthesised for it.',
      brittleness,
    };
  }

  if (sighted.length === 0) {
    return {
      state: 'REFUSED',
      reason: 'NO_CONTROLS',
      why:
        'The crawl sighted no control, no form field and no navigation control on this page, so ' +
        'there is nothing for a page object to name.',
      brittleness,
    };
  }

  if (brittleness.ratio >= 1) {
    return {
      state: 'REFUSED',
      reason: 'ALL_LOCATORS_BRITTLE',
      why:
        `All ${brittleness.total} locator(s) sighted on this page are brittle ` +
        `(${brittleness.causes.map((c) => `${c.cause}: ${c.count}`).join(', ')}). Wrapping them in ` +
        'method names would hide the flake rather than remove it, so this page needs a stable ' +
        'attribute or an accessible name before it can have a page object.',
      brittleness,
    };
  }

  if (!renderer) {
    return {
      state: 'REFUSED',
      reason: 'NO_RENDERER',
      why:
        `No page-object renderer is built in for ${ECOSYSTEMS[ecosystemId].label}, so none was ` +
        'written. A page object in a language this project does not use is a file its reviewers ' +
        'delete; inject a renderer for it rather than accepting one in another language.',
      brittleness,
    };
  }

  const model = buildModel(page, preferredStrategy(profile));
  return {
    state: 'SYNTHESISED',
    model,
    source: renderer.render(model),
    rendererId: ecosystemId,
    fileName: renderer.fileName(args.fileStem ?? routeSlug(model.route)),
  };
}

function buildModel(page: PageSource, preferred: SelectorStrategy | null): PageObjectModel {
  const omitted: PageObjectOmission[] = [];
  const name = uniqueNamer();
  /*
   * Bound every crawled string on its way into the model, and COUNT the ones
   * that changed.
   *
   * The count has to be taken HERE, against the original, because the model
   * only ever holds the bounded form — an earlier version measured the model's
   * own selectors and therefore always found zero, which is a cap applied
   * without being disclosed hiding behind a disclosure. Its own test caught it.
   *
   * A stripped character counts as well as a shortened string: a locator with a
   * zero-width space removed from it no longer matches the element it named,
   * which is the same defect by a different route.
   */
  let locatorsAltered = 0;
  const bound = (selector: Selector): Selector => {
    const next = boundedSelector(selector);
    if (next.value !== selector.value || next.name !== selector.name) locatorsAltered += 1;
    return next;
  };
  const segments = page.route.split('/').filter(Boolean);
  const routeParams = segments.flatMap((segment) => {
    const match = ROUTE_PARAM.exec(segment);
    return match ? [match[1]!] : [];
  });

  // ── Accessors, one per distinct control ──────────────────────────────────
  const byControl = new Map<string, SightedAffordance[]>();
  for (const affordance of page.affordances) {
    const key = controlKey(affordance);
    byControl.set(key, [...(byControl.get(key) ?? []), affordance]);
  }
  const collapsed = [...byControl.values()].reduce(
    (total, group) => total + Math.max(0, group.length - 1),
    0,
  );
  if (collapsed > 0) {
    omitted.push({
      what: 'duplicate sightings of one control',
      why:
        'The crawl sighted these controls more than once; one accessor was written per control, ' +
        'preferring this project’s own locator strategy and then the more resilient one.',
      count: collapsed,
    });
  }

  const chosen = [...byControl.values()]
    .map((group) => chooseSighting(group, preferred))
    .sort((a, b) => byCodeUnit(a.label, b.label) || byCodeUnit(a.kind, b.kind));
  if (chosen.length > MAX_ACCESSORS_PER_PAGE) {
    omitted.push({
      what: 'controls past the per-page accessor cap',
      why: `This page has ${chosen.length} distinct controls and the cap is ${MAX_ACCESSORS_PER_PAGE}; the rest are not in this page object and a spec that needs one must locate it itself.`,
      count: chosen.length - MAX_ACCESSORS_PER_PAGE,
    });
  }
  const accessors: PageObjectAccessor[] = chosen
    .slice(0, MAX_ACCESSORS_PER_PAGE)
    .map((affordance, index) => ({
      name: name(
        `${identifierFrom(affordance.label, `control${index + 1}`)}${
          affordance.kind === 'link' ? 'Link' : affordance.kind === 'button' ? 'Button' : 'Field'
        }`,
      ),
      kind: affordance.kind,
      strategy: affordance.selector.strategy,
      confidence: affordance.selector.confidence,
      selector: bound(affordance.selector),
      brittleCauses: brittleCauses(affordance.selector),
    }));

  // ── Navigations, one per distinct destination ────────────────────────────
  const byRoute = new Map<string, SightedNavigation>();
  let unsafeDestinations = 0;
  for (const navigation of page.navigations) {
    if (!safeRoute(navigation.toRoute) || navigation.toRoute.length > MAX_ROUTE_CHARS) {
      unsafeDestinations += 1;
      continue;
    }
    const existing = byRoute.get(navigation.toRoute);
    /*
     * Two edges to one destination: keep the one with a control, then the
     * better locator. A `goto` method and a `click` method to the same place
     * are one navigation with two spellings, and the click is the one a test
     * exercises.
     */
    if (!existing) {
      byRoute.set(navigation.toRoute, navigation);
      continue;
    }
    if (!existing.selector && navigation.selector) {
      byRoute.set(navigation.toRoute, navigation);
      continue;
    }
    if (existing.selector && navigation.selector) {
      const better = chooseSighting(
        [
          { label: '', kind: 'link', selector: existing.selector },
          { label: '', kind: 'link', selector: navigation.selector },
        ],
        preferred,
      );
      if (better.selector === navigation.selector) byRoute.set(navigation.toRoute, navigation);
    }
  }
  if (unsafeDestinations > 0) {
    omitted.push({
      what: 'navigations to a destination that is not a plain relative path',
      why:
        'A destination route decides a generated method name and a generated literal, so a route ' +
        'outside the safe character class was dropped rather than escaped.',
      count: unsafeDestinations,
    });
  }
  const destinations = [...byRoute.values()].sort((a, b) => byCodeUnit(a.toRoute, b.toRoute));
  if (destinations.length > MAX_NAVIGATIONS_PER_PAGE) {
    omitted.push({
      what: 'navigations past the per-page cap',
      why: `This page links onward to ${destinations.length} places and the cap is ${MAX_NAVIGATIONS_PER_PAGE}.`,
      count: destinations.length - MAX_NAVIGATIONS_PER_PAGE,
    });
  }
  const navigations: PageObjectNavigation[] = destinations
    .slice(0, MAX_NAVIGATIONS_PER_PAGE)
    .map((navigation, index) => ({
      name: name(`goTo${classNameFrom(routeSlug(navigation.toRoute), `page${index + 1}`)}`),
      toRoute: navigation.toRoute,
      selector: navigation.selector === null ? null : bound(navigation.selector),
    }));

  // ── Fillers, one per form ────────────────────────────────────────────────
  if (page.forms.length > MAX_FORMS_PER_PAGE) {
    omitted.push({
      what: 'forms past the per-page cap',
      why: `This page carries ${page.forms.length} forms and the cap is ${MAX_FORMS_PER_PAGE}.`,
      count: page.forms.length - MAX_FORMS_PER_PAGE,
    });
  }
  const fillers: PageObjectFiller[] = [];
  let undrivableFields = 0;
  for (const [index, form] of page.forms.slice(0, MAX_FORMS_PER_PAGE).entries()) {
    const noun = formNoun(form, index);
    const fieldNamer = uniqueNamer();
    const usable = form.fields.filter((field) => howToFill(field) !== null);
    undrivableFields += form.fields.length - usable.length;
    if (usable.length > MAX_FIELDS_PER_FORM) {
      omitted.push({
        what: `fields of form ${index + 1} past the cap`,
        why: `The form declares ${usable.length} drivable fields and the cap is ${MAX_FIELDS_PER_FORM}.`,
        count: usable.length - MAX_FIELDS_PER_FORM,
      });
    }
    const fields: PageObjectField[] = usable
      .slice(0, MAX_FIELDS_PER_FORM)
      .map((field, fieldIndex) => ({
        name: fieldNamer(
          identifierFrom(field.name || field.label || '', `field${fieldIndex + 1}`),
        ),
        fieldName: field.name,
        semantic: field.semantic,
        required: field.required,
        selector: bound(field.selector),
        // Non-null by the filter above; `howToFill` is called twice rather than
        // threaded through, because a cached `how` and a re-derived one are two
        // answers to one question.
        how: howToFill(field)!,
      }));
    if (fields.length === 0) continue;
    fillers.push({
      name: name(`fill${noun}Form`),
      submitName: form.submit ? name(`submit${noun}Form`) : null,
      fields,
      submit: form.submit === null ? null : bound(form.submit),
    });
  }
  if (undrivableFields > 0) {
    omitted.push({
      what: 'form fields a page object cannot drive',
      why:
        'A file input needs a path the suite owns and a hidden input is not a control, so neither ' +
        'is in a filler. A spec that needs them sets them itself.',
      count: undrivableFields,
    });
  }

  const sighted = [
    ...accessors.map((accessor) => accessor.selector),
    ...fillers.flatMap((filler) => [
      ...filler.fields.map((field) => field.selector),
      ...(filler.submit ? [filler.submit] : []),
    ]),
    ...navigations.flatMap((navigation) => (navigation.selector ? [navigation.selector] : [])),
  ];

  if (locatorsAltered > 0) {
    omitted.push({
      what: 'locator strings shortened to the literal cap, or stripped of characters a label cannot contain',
      why: `These locators named a string longer than ${MAX_LITERAL_CHARS} characters, or one containing a control or direction-override character, so the generated literal is not what the page returned and will not match. Give the element a stable attribute, or locate it in the spec.`,
      count: locatorsAltered,
    });
  }

  return {
    route: page.route,
    className: `${classNameFrom(routeSlug(page.route), 'page')}Page`,
    routeParams,
    accessors,
    navigations,
    fillers,
    // Measured over what the page object ACTUALLY contains, not over what the
    // page offered: the refusal check above already used the wider set, and a
    // reviewer reading this file needs the number for this file.
    brittleness: measureBrittleness(sighted),
    omitted,
  };
}

// ─── Renderers ──────────────────────────────────────────────────────────────

/**
 * A language's page-object syntax. INJECTABLE, which is the point.
 *
 * `CONVERT_SYSTEM` in importer.ts hard-codes Playwright TypeScript, so a Java
 * or Python shop that imports its suite gets a rewrite into a language it does
 * not use and deletes it. The shape above this line is language-independent
 * precisely so that this file does not repeat that mistake, and
 * {@link PAGE_OBJECT_RENDERERS} is a TOTAL record over every ecosystem id —
 * `null` where there is no renderer — so a 40th ecosystem cannot quietly fall
 * through to TypeScript.
 */
export interface PageObjectRenderer {
  /** The assertion dialect this language's tests use. See {@link rendersNoAssertions}. */
  readonly dialect: DialectId;
  readonly render: (model: PageObjectModel) => string;
  /**
   * The file name, from a stem the CALLER has already cased.
   *
   * The stem is the project's convention and the suffix and extension are the
   * language's, which is the only split that works: a Python module may not
   * contain a hyphen however kebab-case the rest of the repository is, and a
   * `.page.ts` file in a repository of `.po.ts` files is a file that was not
   * written here.
   */
  readonly fileName: (stem: string) => string;
}

/** `/orders/:id` as a TS template literal, with `:id` becoming a parameter read. */
function tsRouteExpression(model: PageObjectModel): string {
  if (model.routeParams.length === 0) return tsLiteral(model.route);
  const body = model.route
    .split('/')
    .map((segment) => {
      const match = ROUTE_PARAM.exec(segment);
      return match ? `\${params.${match[1]!}}` : segment;
    })
    .join('/');
  // Safe inside a template literal because `safeRoute` admits neither a
  // backtick nor a `$`, so the only interpolation in the string is this one.
  return `\`${body}\``;
}

function pyRouteExpression(model: PageObjectModel): string {
  if (model.routeParams.length === 0) return pyLiteral(model.route);
  const body = model.route
    .split('/')
    .map((segment) => {
      const match = ROUTE_PARAM.exec(segment);
      return match ? `{${match[1]!}}` : segment;
    })
    .join('/');
  return `f"${body}"`;
}

const TS_HEADER = [
  '/*',
  ' * Generated by QAAI from a crawl of this application. Every locator below was',
  ' * OBSERVED on the page; none was inferred. Assertions belong in the spec that',
  ' * imports this file, never here.',
  ' */',
].join('\n');

const PY_HEADER = [
  '"""Generated by QAAI from a crawl of this application.',
  '',
  'Every locator below was OBSERVED on the page; none was inferred. Assertions',
  'belong in the test that imports this file, never here.',
  '"""',
].join('\n');

/** The review note for a brittle accessor — OUR words and a count, never the label. */
function brittleNote(accessor: PageObjectAccessor): string | null {
  if (accessor.brittleCauses.length === 0) return null;
  const reasons = accessor.brittleCauses
    .map((cause) =>
      cause === 'STRATEGY'
        ? 'reached by CSS, so it is coupled to DOM shape'
        : `the crawl's confidence was ${accessor.confidence.toFixed(2)}, below ${LOCATOR_REVIEW_CONFIDENCE}`,
    )
    .join('; ');
  return `REVIEW: ${reasons}.`;
}

const PLAYWRIGHT_TS_RENDERER: PageObjectRenderer = {
  dialect: 'JS_EXPECT',
  fileName: (stem) => `${stem}.page.ts`,
  render: (model) => {
    const lines: string[] = [TS_HEADER, "import type { Locator, Page } from '@playwright/test';", ''];
    lines.push(`export class ${model.className} {`);
    lines.push(`  static readonly route = ${tsLiteral(model.route)};`, '');
    lines.push('  constructor(private readonly page: Page) {}', '');

    const gotoArgs =
      model.routeParams.length === 0
        ? ''
        : `params: { ${model.routeParams.map((param) => `${param}: string`).join('; ')} }`;
    lines.push(`  async goto(${gotoArgs}): Promise<void> {`);
    lines.push(`    await this.page.goto(${tsRouteExpression(model)});`);
    lines.push('  }');

    for (const accessor of model.accessors) {
      const note = brittleNote(accessor);
      lines.push('');
      if (note) lines.push(`  /** ${note} */`);
      lines.push(`  get ${accessor.name}(): Locator {`);
      lines.push(`    return this.page.${locatorExpression(accessor.selector)};`);
      lines.push('  }');
    }

    for (const navigation of model.navigations) {
      lines.push('');
      lines.push(`  async ${navigation.name}(): Promise<void> {`);
      lines.push(
        navigation.selector
          ? `    await this.page.${locatorExpression(navigation.selector)}.click();`
          : `    await this.page.goto(${tsLiteral(navigation.toRoute)});`,
      );
      lines.push('  }');
    }

    for (const filler of model.fillers) {
      const signature = filler.fields.map((field) => `${field.name}: string`).join('; ');
      lines.push('');
      lines.push(`  /** Field semantics: ${semanticSummary(filler)}. */`);
      lines.push(`  async ${filler.name}(values: { ${signature} }): Promise<void> {`);
      for (const field of filler.fields) {
        const locator = `this.page.${locatorExpression(field.selector)}`;
        lines.push(
          field.how === 'FILL'
            ? `    await ${locator}.fill(values.${field.name});`
            : field.how === 'SELECT'
              ? `    await ${locator}.selectOption(values.${field.name});`
              : `    await ${locator}.setChecked(values.${field.name} === 'true');`,
        );
      }
      lines.push('  }');
      if (filler.submitName && filler.submit) {
        lines.push('');
        lines.push(`  async ${filler.submitName}(): Promise<void> {`);
        lines.push(`    await this.page.${locatorExpression(filler.submit)}.click();`);
        lines.push('  }');
      }
    }

    lines.push('}', '');
    return lines.join('\n');
  },
};

/**
 * The field semantics, as a sentence.
 *
 * Every value here is from the closed `FORM_FIELD_SEMANTICS` vocabulary and the
 * field names are already identifiers, so this is the one generated comment
 * whose content is not untrusted — it is OUR vocabulary over sanitised names.
 */
function semanticSummary(filler: PageObjectFiller): string {
  return filler.fields
    .map((field) => `${field.name}=${field.semantic}${field.required ? ' (required)' : ''}`)
    .join(', ');
}

/** Playwright Python's sync API. `page.get_by_role("button", name="…")`. */
function pyLocatorExpression(selector: Selector): string {
  const { strategy, value, name, nth } = selector;
  let call: string;
  switch (strategy) {
    case 'ROLE':
      call = name
        ? `get_by_role(${pyLiteral(value)}, name=${pyLiteral(name)})`
        : `get_by_role(${pyLiteral(value)})`;
      break;
    case 'LABEL':
      call = `get_by_label(${pyLiteral(name ?? value)})`;
      break;
    case 'PLACEHOLDER':
      call = `get_by_placeholder(${pyLiteral(name ?? value)})`;
      break;
    case 'TEXT':
      call = `get_by_text(${pyLiteral(name ?? value)})`;
      break;
    case 'TEST_ID':
      call = `get_by_test_id(${pyLiteral(value)})`;
      break;
    case 'CSS':
    default:
      call = `locator(${pyLiteral(value)})`;
      break;
  }
  return nth === undefined ? call : `${call}.nth(${nth})`;
}

const PLAYWRIGHT_PYTHON_RENDERER: PageObjectRenderer = {
  dialect: 'PY_ASSERT',
  /*
   * The hyphens go, whatever the project's naming convention says. A Python
   * module name may not contain one — `import orders-id_page` is a syntax
   * error — so this is a LANGUAGE rule overriding a naming convention, which is
   * the one direction that override is allowed to run.
   */
  fileName: (stem) => `${stem.replace(/-/g, '_')}_page.py`,
  render: (model) => {
    const lines: string[] = [PY_HEADER, '', 'from playwright.sync_api import Locator, Page', ''];
    lines.push('', `class ${model.className}:`);
    lines.push(`    route = ${pyLiteral(model.route)}`, '');
    lines.push('    def __init__(self, page: Page) -> None:');
    lines.push('        self.page = page', '');

    const gotoArgs = model.routeParams.map((param) => `, ${param}: str`).join('');
    lines.push(`    def goto(self${gotoArgs}) -> None:`);
    lines.push(`        self.page.goto(${pyRouteExpression(model)})`);

    for (const accessor of model.accessors) {
      const note = brittleNote(accessor);
      lines.push('');
      lines.push('    @property');
      lines.push(`    def ${toSnake(accessor.name)}(self) -> Locator:`);
      if (note) lines.push(`        """${note}"""`);
      lines.push(`        return self.page.${pyLocatorExpression(accessor.selector)}`);
    }

    for (const navigation of model.navigations) {
      lines.push('');
      lines.push(`    def ${toSnake(navigation.name)}(self) -> None:`);
      lines.push(
        navigation.selector
          ? `        self.page.${pyLocatorExpression(navigation.selector)}.click()`
          : `        self.page.goto(${pyLiteral(navigation.toRoute)})`,
      );
    }

    for (const filler of model.fillers) {
      lines.push('');
      lines.push(`    def ${toSnake(filler.name)}(self, values: dict[str, str]) -> None:`);
      lines.push(`        """Field semantics: ${semanticSummary(filler)}."""`);
      for (const field of filler.fields) {
        const locator = `self.page.${pyLocatorExpression(field.selector)}`;
        const key = pyLiteral(field.name);
        lines.push(
          field.how === 'FILL'
            ? `        ${locator}.fill(values[${key}])`
            : field.how === 'SELECT'
              ? `        ${locator}.select_option(values[${key}])`
              : `        ${locator}.set_checked(values[${key}] == "true")`,
        );
      }
      if (filler.submitName && filler.submit) {
        lines.push('');
        lines.push(`    def ${toSnake(filler.submitName)}(self) -> None:`);
        lines.push(`        self.page.${pyLocatorExpression(filler.submit)}.click()`);
      }
    }

    lines.push('');
    return lines.join('\n');
  },
};

/**
 * WHICH ECOSYSTEMS HAVE A PAGE-OBJECT RENDERER, as a total record.
 *
 * `null` is a DECISION and not an omission: a Cypress page object is not a
 * Playwright page object with the words changed (`cy.findByRole` is a command
 * chain, not a `Locator`), a Robot Framework resource file is not a class, and
 * a `.feature` file has no page objects at all. Emitting TypeScript for any of
 * them is the `CONVERT_SYSTEM` defect this round exists to fix, so the honest
 * answer is `NO_RENDERER` — an UNAVAILABLE, never a PASS — and a caller that
 * needs one injects it through {@link SynthesisArgs.renderers}.
 *
 * Total over `EcosystemId`, so adding the 40th ecosystem fails to compile until
 * somebody decides.
 */
export const PAGE_OBJECT_RENDERERS = {
  PLAYWRIGHT_TS: PLAYWRIGHT_TS_RENDERER,
  CYPRESS: null,
  WEBDRIVERIO: null,
  PUPPETEER: null,
  NIGHTWATCH: null,
  TESTCAFE: null,
  JEST: null,
  VITEST: null,
  PLAYWRIGHT_PYTHON: PLAYWRIGHT_PYTHON_RENDERER,
  SELENIUM_PYTHON: null,
  APPIUM_PYTHON: null,
  PYTEST: null,
  UNITTEST: null,
  ROBOT: null,
  PLAYWRIGHT_JAVA: null,
  SELENIUM_JAVA: null,
  APPIUM_JAVA: null,
  JUNIT5: null,
  TESTNG: null,
  PLAYWRIGHT_KOTLIN: null,
  SELENIUM_KOTLIN: null,
  ESPRESSO: null,
  JUNIT5_KOTLIN: null,
  PLAYWRIGHT_CSHARP: null,
  SELENIUM_CSHARP: null,
  NUNIT: null,
  XUNIT: null,
  CAPYBARA_RSPEC: null,
  SELENIUM_RUBY: null,
  RSPEC: null,
  MINITEST: null,
  PLAYWRIGHT_GO: null,
  CHROMEDP: null,
  GO_TEST: null,
  PANTHER: null,
  CODECEPTION: null,
  PHPUNIT: null,
  PEST: null,
  CUCUMBER: null,
} as const satisfies Record<EcosystemId, PageObjectRenderer | null>;

/**
 * The ratio at which a page is too brittle to wrap, restated from the gate.
 *
 * Exported so the planner and the tests compare against the SAME number the
 * admission gate fails on, rather than a local copy of it. A page object is
 * refused only at a ratio of 1 — every sighting brittle — because a page object
 * over nine good locators and one CSS fallback is still the right file; this
 * number is what the planner reports as "worth a human's eye" short of refusal.
 */
export const PAGE_OBJECT_REVIEW_RATIO = BRITTLE_LOCATOR_FAIL_RATIO;
