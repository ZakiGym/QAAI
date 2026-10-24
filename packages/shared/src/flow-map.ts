/**
 * The Flow Map (§3.1) — the Explorer's model of the application under test.
 *
 * It is deliberately a *graph over states*, not a list of pages: the same URL
 * can be several distinct states (logged out / logged in / cart non-empty), and
 * the interesting test material lives in the transitions between them.
 */

import type { Priority, TestType } from './constants';

/** How a locator was derived. Ranked most→least resilient (§3.2). */
export const SELECTOR_STRATEGIES = [
  'ROLE', // getByRole('button', { name: 'Check out' }) — survives restyling
  'LABEL', // getByLabel('Email')
  'PLACEHOLDER',
  'TEXT',
  'TEST_ID', // data-testid, when the app provides one
  'CSS', // last resort; the generator flags these for review
] as const;
export type SelectorStrategy = (typeof SELECTOR_STRATEGIES)[number];

export interface Selector {
  strategy: SelectorStrategy;
  /** e.g. 'button' for ROLE, 'Email' for LABEL. */
  value: string;
  /** Accessible name / expected text, when the strategy takes one. */
  name?: string;
  /** Disambiguator when several elements match. */
  nth?: number;
  /**
   * 0–1. How confident the Explorer is that this locator uniquely and stably
   * identifies the element. Anything below 0.6 gets a review flag on generation.
   */
  confidence: number;
}

/**
 * The data-generation vocabulary, as a VALUE and not only a type.
 *
 * It was a bare union inline on `FormField.semantic`, which meant every runtime
 * consumer that has to validate an incoming hint hand-copied the list —
 * `apps/worker/src/processors/analyze-source.ts` still holds such a copy, and a
 * hand-copy of a union is a list that silently stops matching it. Exporting the
 * array gives those callers something to narrow against instead.
 *
 * `url`, `username` and `currency` are the three additions. They are not
 * cosmetic: a field the crawler could only call 'unknown' or 'freeform' got a
 * freeform string, so a URL input was tested with "lorem ipsum" and a price
 * input with prose. Everything else in this list predates this change and keeps
 * its exact spelling, because the names travel in stored FlowMap JSON.
 */
export const FORM_FIELD_SEMANTICS = [
  'email',
  'password',
  'username',
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
  'currency',
  'url',
  'search',
  'freeform',
  'unknown',
] as const;

export type FormFieldSemantic = (typeof FORM_FIELD_SEMANTICS)[number];

export interface FormField {
  name: string;
  label: string | null;
  /** HTML input type, or 'select' / 'textarea'. */
  inputType: string;
  required: boolean;
  selector: Selector;
  /** Hint for the synthetic data generator (§2); see `synthetic.ts`. */
  semantic: FormFieldSemantic;
  /** Present for select/radio. */
  options?: string[];

  /*
   * ─── Real constraints, read off the DOM ────────────────────────────────────
   *
   * THE DEFECT THESE PREVENT: without them a boundary test is unreachable *by
   * construction*. "Submit one character over the limit" is not a judgement the
   * model can make up — the limit is a number the page already carries in an
   * attribute, and dropping it on the floor during the crawl is why the whole
   * negative half of testing had nothing to stand on.
   *
   * Every one is OPTIONAL and distinguishes three states, which a plain
   * `number` could not:
   *   • absent / undefined → this crawl predates the capture (old FlowMap JSON)
   *   • null               → the crawl looked and the page declares nothing
   *   • a value            → the page declares it
   *
   * That distinction is load-bearing. "No maxlength declared" is a much more
   * interesting place to send a 10,000-character string than a field that
   * declares one, and a consumer that cannot tell "not declared" from "not
   * captured" will either miss those fields or cry wolf on every old crawl.
   *
   * `min`/`max`/`step` are strings, not numbers, because the attributes are not
   * numbers: `min` is "2024-01-01" on a date input, "08:00" on a time input and
   * "1" on a number input. Parsing at capture time would throw the date cases
   * away.
   */

  /** `maxlength`. The single most useful number on the page for negative tests. */
  maxLength?: number | null;
  /** `minlength`. */
  minLength?: number | null;
  /** `min` verbatim — numeric, date, time or week, whatever the input type says. */
  min?: string | null;
  /** `max` verbatim. */
  max?: string | null;
  /** `step` verbatim, including the literal "any". */
  step?: string | null;
  /** `pattern` source, verbatim and NOT compiled — an invalid one must not throw. */
  pattern?: string | null;
  /** `inputmode`: numeric/tel/email/decimal/… A claim about the keyboard, and a hint. */
  inputMode?: string | null;
  /** `autocomplete` token: the most reliable semantic signal a form ever gives. */
  autocomplete?: string | null;
  /** `accept` on a file input, e.g. "image/png,.pdf". */
  accept?: string | null;
  /** `multiple` on a file input or select. */
  multiple?: boolean;
  /**
   * The message the PAGE says it will show — `title` on a patterned input, or
   * `validationMessage` when the browser has already computed one.
   *
   * Captured because the strongest form of a negative assertion is the app's
   * own words. A test that asserts "some error appeared" passes when the wrong
   * error appears; one that asserts this string does not.
   */
  validationMessage?: string | null;
}

export interface FormModel {
  id: string;
  name: string;
  selector: Selector;
  fields: FormField[];
  submit: Selector | null;
}

export interface FlowNode {
  id: string;
  /** Normalised path with dynamic segments collapsed: /orders/:id */
  route: string;
  url: string;
  title: string;
  /** Distinguishes states that share a route: 'cart-empty' vs 'cart-has-items'. */
  stateKey: string;
  /** Roles that can reach this node. Empty = reachable logged out. */
  requiresRoles: string[];
  /** True when the Explorer hit an auth wall reaching this node. */
  behindAuth: boolean;
  forms: FormModel[];
  /** Interactive elements the Explorer found but did not follow. */
  affordances: Array<{ label: string; selector: Selector; kind: 'link' | 'button' | 'input' }>;
  /** Artifact key for the screenshot captured at this node. */
  screenshotKey: string | null;
  /** axe-core violations seen on this node during exploration (§4 accessibility). */
  a11yViolationCount: number;
}

export interface FlowEdge {
  id: string;
  from: string; // FlowNode.id
  to: string; // FlowNode.id
  /** What the Explorer did to traverse: 'click "Add to cart"', 'submit login form'. */
  action: string;
  selector: Selector | null;
  /** Set when traversal requires filling a form first. */
  formId?: string;
}

/** A named user journey — a path through the graph worth testing as a unit. */
export interface Journey {
  id: string;
  name: string;
  description: string;
  /** Ordered FlowEdge ids. */
  edgeIds: string[];
  priority: Priority;
  /** Roles this journey is meaningful for; empty = anonymous. */
  roles: string[];
}

export interface FlowMap {
  projectId: string;
  environmentId: string;
  /** Bumped every time the Explorer re-crawls; the cockpit diffs versions. */
  version: number;
  baseUrl: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  journeys: Journey[];
  /** Feature groupings the Explorer inferred, used to group the suite tree. */
  features: Array<{ name: string; nodeIds: string[] }>;
  exploredAt: string; // ISO
  /** Set when exploration stopped early (budget, depth cap, crash). */
  truncatedReason: string | null;
}

// ─── The proposed plan (§3.1 output) ─────────────────────────────────────────

export interface PlanItem {
  id: string;
  /** Plain-English title a PM could read: "Checkout with a saved card". */
  title: string;
  /** Why this matters, in one or two sentences. */
  rationale: string;
  feature: string;
  priority: Priority;
  testType: TestType;
  /** Ordered plain-English steps; the Generator turns these into code. */
  steps: string[];
  /** Plain-English assertions — meaning, not pixels (§3.2). */
  assertions: string[];
  /** Journey this came from, when derived from the graph rather than proposed cold. */
  journeyId: string | null;
  /** Auth profile needed, if any. */
  authProfileId: string | null;
}

export interface TestPlan {
  flowMapVersion: number;
  items: PlanItem[];
  /** Explorer's own summary shown above the approval list in onboarding. */
  summary: string;
  /** Flows the Explorer found but chose not to propose, with the reason. */
  skipped: Array<{ what: string; why: string }>;
}
