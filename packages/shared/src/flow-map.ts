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

export interface FormField {
  name: string;
  label: string | null;
  /** HTML input type, or 'select' / 'textarea'. */
  inputType: string;
  required: boolean;
  selector: Selector;
  /** Hint for the faker-based synthetic data generator (§2). */
  semantic:
    | 'email'
    | 'password'
    | 'person_name'
    | 'phone'
    | 'street_address'
    | 'city'
    | 'postal_code'
    | 'country'
    | 'credit_card'
    | 'card_expiry'
    | 'card_cvc'
    | 'date'
    | 'number'
    | 'search'
    | 'freeform'
    | 'unknown';
  /** Present for select/radio. */
  options?: string[];
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
