/**
 * The Flow Map (§3.1) — the Explorer's model of the application under test.
 *
 * It is deliberately a *graph over states*, not a list of pages: the same URL
 * can be several distinct states (logged out / logged in / cart non-empty), and
 * the interesting test material lives in the transitions between them.
 */

import type { Priority, TestType } from './constants';
/*
 * A VALUE import, and the module graph it makes is deliberate:
 * flow-map → surface → constants, with no edge back. `selectFlowMap` below has
 * to know which declarers OBSERVED the application answering, and a second
 * local list of them is exactly the fork this file is not allowed to make —
 * the whole reason a source-derived map could displace a real crawl is that
 * "where did this come from" was spelled differently in every reader.
 */
import { isObservedSource, type SurfaceSource } from './surface';

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

  /*
   * ─── The honesty fields ────────────────────────────────────────────────────
   *
   * Both OPTIONAL, and the three states are the same ones `FormField`'s
   * constraint capture established: absent means this crawl predates the
   * capture, null means we looked and there is nothing, a value is the fact.
   *
   * The distinction is load-bearing here in a way it is not for a maxlength. A
   * node with no recorded status is not a healthy node — see
   * `shouldGenerateAgainst`, which refuses to write a happy-path test against
   * one rather than assuming 200.
   */

  /**
   * The HTTP status this node's navigation produced, so a 404 page stops being
   * an ordinary route. See {@link NodeStatus}.
   */
  status?: NodeStatus | null;
  /**
   * The route × role access matrix: what each role got when it asked for this
   * route. Empty array means the question was asked of no role; absent means
   * this crawl could not ask. See {@link RouteAccess}.
   */
  access?: RouteAccess[];
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
  /**
   * Set when exploration stopped early (budget, depth cap, crash).
   *
   * KEPT, and kept deliberately: twenty readers render it and it is the
   * sentence on every stored map. It is also not enough on its own — it can say
   * "stopped early" and never "at least 240 more URLs existed" — which is what
   * `frontier` below is for. A writer sets both.
   */
  truncatedReason: string | null;

  /*
   * ─── The accounting that makes the denominator defensible ──────────────────
   *
   * Every member below is OPTIONAL because a FlowMap is stored and every crawl
   * already on disk has none of them. Absent means "this crawl did not account
   * for it", which is a true and useful sentence; it must never be rendered as
   * a zero. A report reading `caps: undefined` as "no cap bit" would claim a
   * complete enumeration on behalf of the 60-page crawl that produced it.
   */

  /** The policy in force, and which of its fields anybody actually chose. */
  policyApplied?: AppliedCrawlPolicy | null;
  /** Which declarer produced this map, and whether it may be measured against. */
  provenance?: FlowMapProvenance | null;
  /** The adjudication: accepted, held as a candidate, or rejected, and why. */
  acceptance?: CrawlAcceptance | null;
  /** Every cap that bit, as a count and a reason. Empty array = none did. */
  caps?: CapBite[];
  /** What was known and not visited, including the stored lower bound. */
  frontier?: Frontier | null;
  /** Every URL a rule refused, and the rule that refused it. */
  excluded?: ExcludedPath[];
  /**
   * The off-origin boundary. A third-party IdP's form is not this
   * application's route, and counting it as one produces coverage gaps for
   * somebody else's page.
   */
  externals?: ExternalBoundary[];
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

// ─── Enumeration honesty: what the crawl refused, missed, and did not know ───

/*
 * EVERYTHING BELOW THIS LINE EXISTS BECAUSE A TRUNCATED CRAWL MAKES THE
 * COVERAGE PERCENTAGE GO UP.
 *
 * That sentence is the whole justification and it is worth being precise about.
 * The denominator is the surface we enumerated. Stop enumerating early and the
 * denominator shrinks while the numerator — the tests that already exist — does
 * not, so the number improves. Every cap in the crawler is therefore a lever
 * that silently flatters us, and today every one of them is applied without
 * being recorded:
 *
 *   · `maxPages` sets one sentence on `truncatedReason` and discards the queue.
 *   · `maxDepth` drops links with no record that a link was dropped.
 *   · `DEFAULT_EXCLUDES` refuses /logout, /delete-*, /destroy and __reset and
 *     writes nothing at all, so a route we refused and a route the application
 *     does not serve are indistinguishable afterwards.
 *   · a 20-button `slice(0, 20)` and a 40-journey limit are hard-coded with no
 *     name, no disclosure and no count.
 *   · a crawl run while the site was down returns an empty graph that REPLACES
 *     the previous denominator.
 *
 * So the rule these types enforce: every budget, take, limit and timeout that
 * BIT is reported as a count AND as a reason, and the frontier it discarded
 * becomes a stored lower bound, so a report can say "at least 240 more URLs
 * existed" instead of "stopped early".
 */

// ─── The crawl policy, which is the auditable scope ─────────────────────────

/**
 * The scope a crawl was permitted, stored on the environment it applies to.
 *
 * `CrawlOptions.excludePatterns` exists today, is declared as `RegExp[]`, and
 * is passed by NO caller in the repository — so a production crawl's scope is
 * whatever five regexes happen to be hard-coded in `DEFAULT_EXCLUDES`, and
 * there is nothing a customer can read, review or change. A production
 * enumeration with no auditable scope is not something a security reviewer can
 * sign off, which is a commercial problem as much as an honesty one.
 *
 * Globs and not `RegExp`, deliberately. This is STORED (as JSON, on
 * `Environment.crawlPolicy`) and a `RegExp` does not survive JSON: it
 * serialises to `{}`. It is also read and written by humans in a panel, where
 * `/admin/**` is reviewable and `^\\/admin\\/.*$` is not. The glob dialect is
 * the small one everyone already knows — `*` within a segment, `**` across
 * segments, `?` for one character — and `matchesGlob` below is its only
 * implementation, so the panel's preview and the crawler's decision cannot
 * disagree.
 */
export interface CrawlPolicy {
  /**
   * Paths the crawl may visit. EMPTY MEANS EVERYTHING on the origin, which is
   * the only sane default for a tool whose job is to find what you forgot —
   * an include list defaults to measuring exactly the surface you already
   * thought of.
   */
  includeGlobs: string[];
  /** Paths the crawl must not visit. Applied after `includeGlobs`. */
  excludeGlobs: string[];
  /**
   * Query parameters stripped before a URL becomes an identity.
   *
   * Without this a tracking parameter mints a new node per inbound link and a
   * 60-page budget is spent on one page: `?utm_source=a` and `?utm_source=b`
   * are the same state and today they are two.
   */
  ignoredQueryParams: string[];
  /**
   * How many pages one ROUTE TEMPLATE may contribute. `/orders/:id` has ten
   * thousand instances and they are one thing to test; without a per-template
   * budget a single list page consumes the whole crawl, which is the most
   * common way an enumeration of a real application fails.
   */
  perTemplatePageBudget: number;
  /** The overall page budget. */
  pageBudget: number;
  maxDepth: number;
  wallClockMillis: number;
  /**
   * Only GET and HEAD may be issued directly. True by default: a crawl that
   * POSTs during discovery places orders.
   *
   * This does not forbid exercising a form — it forbids the CRAWLER from doing
   * it unasked. A generated test submitting a form is a test, with a plan and
   * an approval behind it.
   */
  safeMethodsOnly: boolean;
  /**
   * Whether destructive paths may be driven at all, and which ones.
   *
   * Two fields rather than one because "yes, destructive is allowed here" is
   * not the same permission as "these specific paths are allowed". A throwaway
   * seeded environment wants the first; a staging environment that shares a
   * database with something real wants the second and nothing more.
   */
  allowDestructive: boolean;
  destructiveAllowGlobs: string[];
  /**
   * Origins other than the base URL that are still part of this application —
   * an auth subdomain, a CDN-hosted single-page app. Everything else is an
   * external boundary and is NOT the app's own surface.
   */
  additionalOrigins: string[];
}

/**
 * The defaults, and every one of them is chosen to be safe against a PRODUCTION
 * application rather than convenient against a demo.
 *
 * The caps are larger than today's hard-coded 60 pages and depth 6 because
 * those numbers were not a safety decision — they were a "make the demo
 * finish" decision, and they are the reason a 412-route application enumerates
 * as 60 routes and reports a coverage percentage computed over one seventh of
 * itself. Safety here is about what the crawl DOES (no writes, no destruction,
 * no session loss, no off-origin traffic), not about how much of the customer's
 * own application it is allowed to look at.
 */
export const DEFAULT_CRAWL_POLICY: CrawlPolicy = {
  includeGlobs: [],
  /*
   * The five patterns `DEFAULT_EXCLUDES` hard-codes in crawler.ts, as globs and
   * now visible to the customer who is subject to them. They stay excluded by
   * DEFAULT and are now OVERRIDABLE, which they were not: a seeded throwaway
   * environment has every reason to want /logout enumerated.
   */
  excludeGlobs: [
    '/logout',
    '/logout/**',
    '/sign-out',
    '/signout',
    '/delete-**',
    '/destroy**',
    '/__reset**',
  ],
  ignoredQueryParams: [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'gclid',
    'fbclid',
    'ref',
    'referrer',
    '_ga',
  ],
  perTemplatePageBudget: 25,
  pageBudget: 1_000,
  maxDepth: 12,
  wallClockMillis: 15 * 60 * 1_000,
  safeMethodsOnly: true,
  allowDestructive: false,
  destructiveAllowGlobs: [],
  additionalOrigins: [],
};

/**
 * The policy as it was ACTUALLY applied, which is what a report has to show.
 *
 * `overridden` names the fields the environment set, so a reader can tell a
 * deliberate 50-page budget from this build's default — and so a customer
 * arguing about a number can see whether they chose the cap that produced it.
 * Without this the stored policy and the policy in force are the same JSON and
 * nobody can tell which parts anyone ever decided.
 */
export interface AppliedCrawlPolicy {
  policy: CrawlPolicy;
  /** Fields the environment set. Everything else came from the default. */
  overridden: Array<keyof CrawlPolicy>;
  /** Keys in the stored policy that are not fields of `CrawlPolicy`. */
  unknownKeys: string[];
  /**
   * True when the environment had no policy at all. Distinct from an
   * environment that stored an empty object: one never decided, the other
   * decided to accept every default, and only the second is a decision.
   */
  defaulted: boolean;
}

/**
 * Merges a stored policy over the defaults, field by field, and says which
 * fields the row actually set.
 *
 * Takes `unknown` because the source is a JSONB column: anything can be in
 * there, including a policy written by a newer build. An unknown key is
 * REPORTED rather than dropped silently or merged blindly — a field name
 * nobody recognises is either our bug or a downgrade, and both deserve a line
 * in the report rather than a shrug.
 */
export function resolveCrawlPolicy(stored: unknown): AppliedCrawlPolicy {
  if (stored === null || stored === undefined) {
    return {
      policy: { ...DEFAULT_CRAWL_POLICY },
      overridden: [],
      unknownKeys: [],
      defaulted: true,
    };
  }
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    return {
      policy: { ...DEFAULT_CRAWL_POLICY },
      overridden: [],
      unknownKeys: ['<not an object>'],
      defaulted: true,
    };
  }

  const row = stored as Record<string, unknown>;
  const policy: CrawlPolicy = { ...DEFAULT_CRAWL_POLICY };
  const overridden: Array<keyof CrawlPolicy> = [];
  const unknownKeys: string[] = [];
  const fields = Object.keys(DEFAULT_CRAWL_POLICY) as Array<keyof CrawlPolicy>;

  for (const key of Object.keys(row)) {
    if (!(fields as string[]).includes(key)) unknownKeys.push(key);
  }

  for (const field of fields) {
    const value = row[field];
    if (value === undefined) continue;
    const fallback = DEFAULT_CRAWL_POLICY[field];
    /*
     * Type-checked per field rather than cast. A JSONB column holding
     * `pageBudget: "1000"` would otherwise put a STRING where the crawler
     * compares a number, and `nodes.length >= "1000"` is false for every crawl
     * that will ever run — a cap that silently stops applying, which is the
     * worst direction for this particular field to fail in.
     */
    if (Array.isArray(fallback)) {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) continue;
      (policy[field] as string[]) = [...(value as string[])];
    } else if (typeof fallback === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
      (policy[field] as number) = value;
    } else {
      if (typeof value !== 'boolean') continue;
      (policy[field] as boolean) = value;
    }
    overridden.push(field);
  }

  return { policy, overridden, unknownKeys, defaulted: false };
}

/**
 * The glob dialect, and the only implementation of it.
 *
 * `**` crosses `/`, `*` does not, `?` is one character that is not `/`. Written
 * out rather than taken from a dependency because the panel's preview and the
 * crawler's decision have to agree exactly, and because a glob library's
 * surprises (brace expansion, dotfile rules, negation) would be surprises about
 * which part of a customer's production application we visited.
 */
export function matchesGlob(glob: string, path: string): boolean {
  const pattern = glob
    .split('')
    .map((char, index, all) => {
      if (char === '*') {
        if (all[index - 1] === '*') return '';
        if (all[index + 1] === '*') return '.*';
        return '[^/]*';
      }
      if (char === '?') return '[^/]';
      return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${pattern}$`).test(path);
}

/**
 * Whether the policy admits a path, and WHICH rule decided.
 *
 * Returns the rule rather than a boolean because a refusal with no rule is the
 * defect this whole file is about. The caller records the returned `rule` in
 * the exclusion ledger, so every refused URL can be traced to one line of one
 * policy a human wrote.
 */
export function policyDecision(
  policy: CrawlPolicy,
  path: string,
): { admitted: boolean; rule: string } {
  if (policy.includeGlobs.length > 0) {
    const hit = policy.includeGlobs.find((glob) => matchesGlob(glob, path));
    if (hit === undefined) return { admitted: false, rule: 'includeGlobs: no pattern matched' };
  }
  const excluded = policy.excludeGlobs.find((glob) => matchesGlob(glob, path));
  if (excluded !== undefined) {
    /*
     * An explicit destructive allowance beats an exclude glob, and only an
     * EXPLICIT one: `allowDestructive` on its own is not enough, because "this
     * environment is disposable" is a different claim from "drive the logout
     * link". Requiring both means a customer who flips the environment-wide
     * switch does not silently acquire permission to end their own session on
     * every crawl.
     */
    const allowed =
      policy.allowDestructive &&
      policy.destructiveAllowGlobs.some((glob) => matchesGlob(glob, path));
    if (!allowed) return { admitted: false, rule: `excludeGlobs: ${excluded}` };
    return { admitted: true, rule: `destructiveAllowGlobs: ${excluded} overridden` };
  }
  return { admitted: true, rule: 'admitted' };
}

// ─── The excluded-path ledger ───────────────────────────────────────────────

/**
 * Why a URL was refused. A REFUSED surface and a NONEXISTENT surface are
 * opposite facts and today they are recorded identically — which is to say,
 * not at all.
 */
export const EXCLUSION_KINDS = [
  /** Following it would log the crawl out. */
  'SESSION_ENDING',
  /** It looks like it deletes something. */
  'DESTRUCTIVE',
  /** An `excludeGlobs` pattern matched. */
  'POLICY_EXCLUDE',
  /** `includeGlobs` is set and nothing matched. */
  'POLICY_NOT_INCLUDED',
  /** A different origin. Someone else's application. */
  'OFF_ORIGIN',
  /** It needs a method `safeMethodsOnly` forbids. */
  'UNSAFE_METHOD',
  /** mailto:, tel:, javascript:, data: — not a page. */
  'UNSUPPORTED_SCHEME',
] as const;
export type ExclusionKind = (typeof EXCLUSION_KINDS)[number];

export const EXCLUSION_KIND_LABELS: Record<ExclusionKind, string> = {
  SESSION_ENDING: 'would end the session',
  DESTRUCTIVE: 'looks destructive',
  POLICY_EXCLUDE: 'excluded by the crawl policy',
  POLICY_NOT_INCLUDED: 'outside the crawl policy’s include list',
  OFF_ORIGIN: 'a different origin',
  UNSAFE_METHOD: 'needs a method the policy forbids',
  UNSUPPORTED_SCHEME: 'not an http(s) URL',
};

/**
 * One refused URL. Recorded so the report can say "we refused 31 URLs, here
 * they are, and here is the rule that refused each one".
 */
export interface ExcludedPath {
  /** The URL as discovered, with the ignored query parameters already stripped. */
  url: string;
  /** Normalised route, when it could be derived. */
  route: string | null;
  kind: ExclusionKind;
  /**
   * The rule that decided, from `policyDecision` — a line a human can look up
   * in the environment's policy, never a dumped regex.
   */
  rule: string;
  /** Where it was linked from, so a customer can decide to allow it. */
  discoveredFrom: string | null;
}

/** Refusals grouped by the rule that made them, which is how a panel renders. */
export function exclusionsByRule(
  excluded: readonly ExcludedPath[],
): Array<{ rule: string; kind: ExclusionKind; count: number; sample: string[] }> {
  const groups = new Map<string, { kind: ExclusionKind; urls: string[] }>();
  for (const entry of excluded) {
    const group = groups.get(entry.rule) ?? { kind: entry.kind, urls: [] };
    group.urls.push(entry.url);
    groups.set(entry.rule, group);
  }
  return [...groups.entries()]
    .map(([rule, group]) => ({
      rule,
      kind: group.kind,
      count: group.urls.length,
      // Five, and the COUNT is beside it, so a truncated sample can never be
      // mistaken for the whole list.
      sample: group.urls.slice(0, 5),
    }))
    .sort((left, right) => right.count - left.count);
}

// ─── The off-origin boundary ────────────────────────────────────────────────

/**
 * Something outside the application that the application reaches.
 *
 * Today a third-party identity provider's login form is counted as the app's
 * own route, with its own form fields, and QAAI reports coverage gaps for
 * someone else's page. That is worse than a wrong number: it is a list of
 * recommended tests a customer cannot possibly write.
 */
export const EXTERNAL_KINDS = [
  'REDIRECT',
  'IFRAME',
  'SCRIPT_HOST',
  'FORM_ACTION',
  'LINK',
  'WEBSOCKET',
] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];

export interface ExternalBoundary {
  kind: ExternalKind;
  /**
   * Scheme, host and port. ORIGIN ONLY, never a full URL: a redirect to an IdP
   * carries the tenant, the user hint and a state token in its query string,
   * and a flow map is stored, exported and rendered in a cockpit. There is no
   * version of this product that needs those values.
   */
  origin: string;
  /** The in-app route that reaches it. */
  fromRoute: string | null;
  /** First PATH seen at that origin, for recognisability. Never the query. */
  samplePath: string | null;
  occurrences: number;
}

/**
 * Whether a URL belongs to the application under test.
 *
 * Origin equality — scheme, host AND port — plus the policy's
 * `additionalOrigins`. Not a suffix test: `evil-example.com` ends with
 * `example.com`, and a crawl that followed it would be enumerating somebody
 * else's site into our customer's denominator.
 */
export function isOwnOrigin(baseUrl: string, candidate: string, policy?: CrawlPolicy): boolean {
  let ours: string;
  let theirs: string;
  try {
    ours = new URL(baseUrl).origin;
    theirs = new URL(candidate).origin;
  } catch {
    return false;
  }
  if (ours === theirs) return true;
  return (policy?.additionalOrigins ?? []).some((origin) => {
    try {
      return new URL(origin).origin === theirs;
    } catch {
      return false;
    }
  });
}

/** Origin and path of a URL, with the query and fragment dropped. */
export function externalParts(url: string): { origin: string; path: string } | null {
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, path: parsed.pathname };
  } catch {
    return null;
  }
}

// ─── Caps: every limit that bit, as a count and a reason ────────────────────

/**
 * The caps a crawl can hit. Named, because an anonymous cap cannot be
 * disclosed — four of these are hard-coded integers in crawler.ts today with no
 * name, no configuration and no record that they applied.
 */
export const CRAWL_CAPS = [
  'PAGE_BUDGET',
  'PER_TEMPLATE_BUDGET',
  'DEPTH',
  'WALL_CLOCK',
  'LINKS_PER_PAGE',
  'AFFORDANCES_PER_PAGE',
  'JOURNEY_LIMIT',
  'QUEUE_SIZE',
] as const;
export type CrawlCap = (typeof CRAWL_CAPS)[number];

export const CRAWL_CAP_LABELS: Record<CrawlCap, string> = {
  PAGE_BUDGET: 'the overall page budget',
  PER_TEMPLATE_BUDGET: 'the per-route-template page budget',
  DEPTH: 'the depth limit',
  WALL_CLOCK: 'the wall-clock limit',
  LINKS_PER_PAGE: 'the per-page link limit',
  AFFORDANCES_PER_PAGE: 'the per-page affordance limit',
  JOURNEY_LIMIT: 'the journey-derivation limit',
  QUEUE_SIZE: 'the frontier queue limit',
};

/**
 * One cap, and what it cost.
 *
 * `discarded` is the field that matters and it is the one a naive
 * implementation leaves out. "The page budget bit" is a fact about us;
 * "the page budget bit and discarded 240 queued URLs" is a fact about how
 * wrong the percentage is. A cap that bit with `discarded: 0` is honest and
 * cheap — the wall clock expiring on an empty queue costs nothing — and the
 * zero has to be a measurement rather than an omission, which is why the field
 * is required.
 */
export interface CapBite {
  cap: CrawlCap;
  /** The limit as applied, after the policy was resolved. */
  limit: number;
  /** How many times it stopped something. */
  bites: number;
  /** Candidates it discarded. The lower bound on what it cost. */
  discarded: number;
  /** Where, for a per-page or per-template cap: the route or the URL. */
  scope: string | null;
  /** The sentence the report prints. */
  reason: string;
}

/** Only the caps that actually bit. A cap that did not bite is not a caveat. */
export function capsThatBit(caps: readonly CapBite[]): CapBite[] {
  return caps.filter((cap) => cap.bites > 0);
}

/** Everything the caps threw away, summed. Feeds the known-unknown lower bound. */
export function discardedByCaps(caps: readonly CapBite[]): number {
  return capsThatBit(caps).reduce((running, cap) => running + cap.discarded, 0);
}

// ─── The frontier, and the lower bound that replaces "stopped early" ────────

/**
 * What enumeration knew about and did not visit.
 *
 * Five separate counts, because collapsing them is how a report comes to say
 * something false:
 *
 *   unvisitedQueued  in scope, discovered, never visited. UNKNOWN surface.
 *   beyondDepth      in scope, seen past the depth limit. UNKNOWN surface.
 *   excluded         in scope and REFUSED. Known by name — see the ledger.
 *   offOrigin        not ours. Not surface at all.
 *   unreachable      failed to load. Unknown whether it exists.
 *
 * Only the first two feed `atLeastMoreUrls`, and the reason is the honesty rule
 * this product turns on. A refused URL is KNOWN — we can name it, so it is not
 * part of "more existed". An off-origin URL is not the app's surface. An
 * unreachable URL is unknown-not-absent and claiming it as missing surface
 * would be inventing a number in the alarming direction, which is the same sin
 * as inventing one in the flattering direction.
 */
export interface Frontier {
  unvisitedQueued: number;
  beyondDepth: number;
  excluded: number;
  offOrigin: number;
  unreachable: number;
  /**
   * The stored lower bound: AT LEAST this many more distinct in-scope URLs
   * existed and were not enumerated.
   *
   * Stored rather than derived at read time because the queue it was computed
   * from is gone the moment the crawl ends — which is exactly why no report has
   * ever been able to say it. Always equal to `lowerBoundMoreUrls(frontier)`;
   * `frontierIsConsistent` asserts that, so a writer that invents a number
   * fails a test rather than shipping it.
   */
  atLeastMoreUrls: number;
  /** A bounded sample, so the lower bound is auditable rather than asserted. */
  sample: string[];
  /** True when `sample` is shorter than the frontier it came from. */
  sampleTruncated: boolean;
}

/**
 * The lower bound on in-scope URLs enumeration did not reach.
 *
 * A LOWER bound and never an estimate: these are URLs we actually held in a
 * queue or actually saw past the depth limit. The true number is larger — every
 * one of those pages has links of its own — and saying "at least" is the only
 * defensible form of the sentence.
 */
export function lowerBoundMoreUrls(
  frontier: Pick<Frontier, 'unvisitedQueued' | 'beyondDepth'>,
): number {
  return frontier.unvisitedQueued + frontier.beyondDepth;
}

/** Whether a stored frontier's own lower bound agrees with its counts. */
export function frontierIsConsistent(frontier: Frontier): boolean {
  return frontier.atLeastMoreUrls === lowerBoundMoreUrls(frontier);
}

export const EMPTY_FRONTIER: Frontier = {
  unvisitedQueued: 0,
  beyondDepth: 0,
  excluded: 0,
  offOrigin: 0,
  unreachable: 0,
  atLeastMoreUrls: 0,
  sample: [],
  sampleTruncated: false,
};

// ─── Converged, or merely stopped ───────────────────────────────────────────

/**
 * How enumeration ended, and the distinction the product is not allowed to
 * blur.
 *
 * CONVERGED means there was nothing left to visit. STOPPED means we ran out of
 * budget while there was. Those produce the same `nodes.length` and completely
 * different denominators, and "enumeration converged" is the single most
 * tempting false sentence available to this feature — it is what every cap
 * makes a crawl look like from the inside.
 */
export const ENUMERATION_OUTCOMES = ['CONVERGED', 'STOPPED', 'FAILED'] as const;
export type EnumerationOutcome = (typeof ENUMERATION_OUTCOMES)[number];

export const ENUMERATION_OUTCOME_LABELS: Record<EnumerationOutcome, string> = {
  CONVERGED: 'every discovered URL in scope was visited',
  STOPPED: 'a budget ran out while URLs were still queued',
  FAILED: 'nothing was enumerated',
};

/**
 * Decides which of the three it was, from the frontier and the cap ledger.
 *
 * CONVERGED requires all three: pages visited, an empty frontier, and no cap
 * that bit. The third condition is the one worth stating — a crawl can empty
 * its queue while a per-template budget was silently dropping every instance
 * of `/orders/:id`, and that is not convergence, it is convergence over a
 * surface we trimmed.
 */
export function enumerationOutcome(input: {
  visitedPages: number;
  frontier: Frontier;
  caps: readonly CapBite[];
}): { outcome: EnumerationOutcome; why: string } {
  if (input.visitedPages === 0) {
    return { outcome: 'FAILED', why: 'no page was successfully loaded' };
  }
  const bit = capsThatBit(input.caps);
  const pending = lowerBoundMoreUrls(input.frontier);
  if (pending === 0 && bit.length === 0) {
    return {
      outcome: 'CONVERGED',
      why: `visited ${input.visitedPages} page(s); nothing was left in scope and no cap applied`,
    };
  }
  const named = bit.map((cap) => `${CRAWL_CAP_LABELS[cap.cap]} (${cap.discarded} discarded)`);
  return {
    outcome: 'STOPPED',
    why:
      `visited ${input.visitedPages} page(s); at least ${pending} more in-scope URL(s) were ` +
      `known and not visited` +
      (named.length > 0 ? `; caps that applied: ${named.join(', ')}` : ''),
  };
}

// ─── Acceptance: a degraded crawl must not become the denominator ───────────

/**
 * Whether this crawl is allowed to BE the denominator.
 *
 * A crawl run while the site was down, rate-limited or logged out returns a
 * small graph. Today that graph is written as the newest version and every
 * reader picks it up, so the denominator collapses, the numerator does not, and
 * the coverage percentage goes UP on the day the customer's staging environment
 * fell over. Nobody is told; the number simply improves.
 *
 * So a crawl is adjudicated before it is promoted. A degraded one is held as a
 * CANDIDATE: stored, visible, diffable, and NOT the thing anything measures
 * against until a human or a later clean crawl resolves it.
 */
export const CRAWL_ACCEPTANCE_STATES = ['ACCEPTED', 'CANDIDATE', 'REJECTED'] as const;
export type CrawlAcceptanceState = (typeof CRAWL_ACCEPTANCE_STATES)[number];

export const CRAWL_ACCEPTANCE_LABELS: Record<CrawlAcceptanceState, string> = {
  ACCEPTED: 'measured against',
  CANDIDATE: 'held — degraded, and not measured against',
  REJECTED: 'discarded — nothing usable was enumerated',
};

/** The observable conditions that make a crawl untrustworthy as a denominator. */
export const CRAWL_DEGRADATIONS = [
  'SITE_DOWN',
  'RATE_LIMITED',
  'NOT_LOGGED_IN',
  'TLS_ERROR',
  'MOSTLY_ERRORS',
  'SHRANK',
  'NO_PAGES',
] as const;
export type CrawlDegradationKind = (typeof CRAWL_DEGRADATIONS)[number];

export const CRAWL_DEGRADATION_LABELS: Record<CrawlDegradationKind, string> = {
  SITE_DOWN: 'the site did not answer',
  RATE_LIMITED: 'the site rate-limited the crawl',
  NOT_LOGGED_IN: 'the session was not authenticated',
  TLS_ERROR: 'the certificate could not be verified',
  MOSTLY_ERRORS: 'most pages answered 4xx or 5xx',
  SHRANK: 'it enumerated far less than the last accepted crawl',
  NO_PAGES: 'no page was enumerated',
};

export interface CrawlDegradation {
  kind: CrawlDegradationKind;
  /** The evidence, in the customer's terms. */
  detail: string;
  /** How many observations support it. */
  count: number;
}

export interface CrawlAcceptance {
  state: CrawlAcceptanceState;
  /** Why, as sentences. Never empty for CANDIDATE or REJECTED. */
  reasons: string[];
  degradations: CrawlDegradation[];
  /** The accepted version this was compared against, when there was one. */
  comparedToVersion: number | null;
  previousNodeCount: number | null;
}

/**
 * How far an enumeration may fall below the last accepted one before it is held
 * as a candidate rather than promoted.
 *
 * 40% is deliberately loose. An application genuinely loses routes — a feature
 * is deleted, a section is moved behind a flag — and holding every shrink for
 * review would make the mechanism one people switch off. What it has to catch
 * is the collapse: 412 routes becoming 3 because the login expired.
 */
export const CRAWL_SHRINK_CANDIDATE_PERCENT = 40;

/**
 * Adjudicates a finished crawl.
 *
 * Deterministic and model-free, like everything in enumeration. The inputs are
 * counts the crawl already has; none of them requires a judgement call.
 */
export function adjudicateCrawl(input: {
  nodeCount: number;
  /** Nodes whose response was 4xx or 5xx. */
  errorNodeCount: number;
  /** Navigations that threw — DNS, connection refused, timeout. */
  loadFailureCount: number;
  /** Responses that were 429 or 503. */
  throttledCount: number;
  /** True when an auth profile was supplied and the crawl hit an auth wall anyway. */
  expectedAuthButHitWall: boolean;
  /** True when a navigation failed TLS verification. */
  tlsFailureCount?: number;
  /** The last ACCEPTED crawl for this environment, when there is one. */
  previous?: { version: number; nodeCount: number } | null;
  shrinkPercent?: number;
}): CrawlAcceptance {
  const degradations: CrawlDegradation[] = [];
  const reasons: string[] = [];
  const previous = input.previous ?? null;

  if (input.nodeCount === 0) {
    degradations.push({
      kind: input.loadFailureCount > 0 ? 'SITE_DOWN' : 'NO_PAGES',
      detail:
        input.loadFailureCount > 0
          ? `${input.loadFailureCount} navigation(s) failed and nothing was enumerated`
          : 'nothing was enumerated',
      count: Math.max(input.loadFailureCount, 1),
    });
    reasons.push(
      'nothing was enumerated, so this crawl cannot be a denominator — the previous one stands',
    );
    return {
      state: 'REJECTED',
      reasons,
      degradations,
      comparedToVersion: previous?.version ?? null,
      previousNodeCount: previous?.nodeCount ?? null,
    };
  }

  if (input.throttledCount > 0) {
    degradations.push({
      kind: 'RATE_LIMITED',
      detail: `${input.throttledCount} response(s) were 429 or 503`,
      count: input.throttledCount,
    });
  }
  if (input.expectedAuthButHitWall) {
    degradations.push({
      kind: 'NOT_LOGGED_IN',
      detail: 'an auth profile was supplied and the crawl was still redirected to a login page',
      count: 1,
    });
  }
  if ((input.tlsFailureCount ?? 0) > 0) {
    degradations.push({
      kind: 'TLS_ERROR',
      detail: `${input.tlsFailureCount} navigation(s) failed certificate verification`,
      count: input.tlsFailureCount ?? 0,
    });
  }
  /*
   * Strictly more than half, so a two-page crawl with one error page is not
   * degraded. `>=` here would hold a candidate for every tiny application that
   * has a 404 test fixture linked from its home page.
   */
  if (input.errorNodeCount * 2 > input.nodeCount) {
    degradations.push({
      kind: 'MOSTLY_ERRORS',
      detail: `${input.errorNodeCount} of ${input.nodeCount} page(s) answered 4xx or 5xx`,
      count: input.errorNodeCount,
    });
  }
  if (previous && previous.nodeCount > 0) {
    const threshold = input.shrinkPercent ?? CRAWL_SHRINK_CANDIDATE_PERCENT;
    const dropPercent = ((previous.nodeCount - input.nodeCount) / previous.nodeCount) * 100;
    if (dropPercent > threshold) {
      degradations.push({
        kind: 'SHRANK',
        detail:
          `${input.nodeCount} page(s) against ${previous.nodeCount} in accepted v${previous.version} — ` +
          `down ${Math.round(dropPercent)}%, past the ${threshold}% hold threshold`,
        count: previous.nodeCount - input.nodeCount,
      });
    }
  }

  if (degradations.length === 0) {
    return {
      state: 'ACCEPTED',
      reasons: [],
      degradations,
      comparedToVersion: previous?.version ?? null,
      previousNodeCount: previous?.nodeCount ?? null,
    };
  }

  return {
    state: 'CANDIDATE',
    reasons: degradations.map(
      (degradation) => `${CRAWL_DEGRADATION_LABELS[degradation.kind]} — ${degradation.detail}`,
    ),
    degradations,
    comparedToVersion: previous?.version ?? null,
    previousNodeCount: previous?.nodeCount ?? null,
  };
}

// ─── Provenance and environment scoping: choosing the right map ─────────────

/**
 * The columns a reader needs to choose a flow map correctly.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * Sixteen call sites read a flow map and thirteen of them do it as
 * `findFirst({ where: { projectId }, orderBy: { version: 'desc' } })`. No
 * environment filter and no provenance filter, which produces two wrong answers
 * that look identical to a right one:
 *
 *   · A staging crawl at v9 becomes the map a PRODUCTION coverage number is
 *     computed from. Different routes, different roles, different flags.
 *   · `flowMapFromSource` in analyze-source.ts writes a map DERIVED FROM THE
 *     REPOSITORY with its own version number, so a source-derived map at v9
 *     displaces a real crawl at v8 and the denominator silently becomes
 *     "whatever the route table says" — with no forms, no states and no
 *     affordances.
 *
 * Neither can be fixed at the read site alone: there is nothing on the row to
 * filter by. These fields are that something.
 */
export interface FlowMapProvenance {
  /** Which declarer produced it. See `SURFACE_SOURCES`. */
  derivedFrom: SurfaceSource;
  /** Whether it may be measured against. */
  acceptance: CrawlAcceptanceState;
  /** Converged, or merely stopped. */
  outcome: EnumerationOutcome;
}

/** A row as `selectFlowMap` needs to see it — the columns, not the graph. */
export interface FlowMapCandidate {
  id: string;
  version: number;
  environmentId: string;
  /**
   * Null for every row written before provenance existed. Treated as UNKNOWN
   * and ranked between accepted and candidate — not as CRAWL, which would be a
   * guess, and the guess would be wrong for every map `flowMapFromSource` ever
   * wrote.
   */
  derivedFrom: SurfaceSource | null;
  /** Null for every row written before acceptance existed. */
  acceptance: CrawlAcceptanceState | null;
  createdAtIso: string;
}

export interface FlowMapSelection {
  chosen: FlowMapCandidate | null;
  /** Why that one. Printed in the report beside whatever was measured. */
  why: string;
  /** Every row that was passed over, and the rule that passed it over. */
  rejected: Array<{ id: string; why: string }>;
}

/**
 * Chooses the flow map a measurement may use.
 *
 * The rules, in order, and each one exists because of a specific wrong answer:
 *
 *   1. The environment must MATCH. Not "prefer" — match. A staging crawl is not
 *      a weaker measurement of production, it is a measurement of something
 *      else, and falling back to it is how a prod coverage number comes to be
 *      computed over staging's routes.
 *   2. REJECTED is never chosen.
 *   3. ACCEPTED outranks legacy-null outranks CANDIDATE, and this rank comes
 *      FIRST — ahead of provenance. CANDIDATE is not "a worse map", it is a map
 *      carrying an explicit "nothing measures against this", and nothing should
 *      be able to overrule that while an unheld row exists. Legacy-null sits in
 *      the middle because it is unlabelled rather than held: it is the state
 *      every row in every existing install is in, and ranking it below a
 *      deliberately-held crawl would make this function choose the degraded map
 *      on the day it ships.
 *   4. An OBSERVED map outranks a DECLARED one REGARDLESS OF VERSION. A crawl
 *      saw the application answer; a source-derived map read a route table.
 *      Version is a sequence number, not evidence, and letting it decide is
 *      what lets v9-from-source displace v8-from-crawl.
 *   5. Then the highest version, then the newest row.
 *
 * Rules 3 and 4 were originally the other way round, and a test caught it: a
 * CANDIDATE crawl (observed, explicitly held) outranked a legacy row (unknown
 * provenance, never adjudicated), which is the one outcome the acceptance
 * mechanism exists to prevent. The consequence of the order as it now stands is
 * worth stating plainly, because it is a real trade: a clean SOURCE-derived map
 * will be chosen over a CANDIDATE crawl. That is deliberate. The displacement
 * defect was a source map winning on its VERSION NUMBER against a crawl nobody
 * had any complaint about; choosing it over a crawl we have adjudicated as
 * degraded is a decision, and the `why` string says which one was made.
 *
 * `allowCandidate` defaults to FALSE. A caller that would rather measure
 * against a degraded crawl than against nothing has to say so, and then the
 * caveat travels with the number.
 */
export function selectFlowMap(
  rows: readonly FlowMapCandidate[],
  options: { environmentId: string; allowCandidate?: boolean },
): FlowMapSelection {
  const rejected: Array<{ id: string; why: string }> = [];
  const eligible: FlowMapCandidate[] = [];

  for (const row of rows) {
    if (row.environmentId !== options.environmentId) {
      rejected.push({
        id: row.id,
        why: `environment ${row.environmentId} is not ${options.environmentId} — a crawl of another environment measures another application`,
      });
      continue;
    }
    if (row.acceptance === 'REJECTED') {
      rejected.push({ id: row.id, why: 'adjudicated REJECTED: nothing usable was enumerated' });
      continue;
    }
    if (row.acceptance === 'CANDIDATE' && options.allowCandidate !== true) {
      rejected.push({
        id: row.id,
        why: 'held as a CANDIDATE: a degraded crawl, and the caller did not accept one',
      });
      continue;
    }
    eligible.push(row);
  }

  if (eligible.length === 0) {
    return {
      chosen: null,
      why: `no flow map is eligible for environment ${options.environmentId}`,
      rejected,
    };
  }

  const observedRank = (row: FlowMapCandidate) =>
    row.derivedFrom !== null && isObservedSource(row.derivedFrom) ? 1 : 0;
  const acceptanceRank = (row: FlowMapCandidate) =>
    row.acceptance === 'ACCEPTED' ? 2 : row.acceptance === null ? 1 : 0;

  const ordered = [...eligible].sort(
    (left, right) =>
      // Acceptance first. See rule 3 above: a CANDIDATE carries an explicit
      // "nothing measures against this", and provenance must not overrule it.
      acceptanceRank(right) - acceptanceRank(left) ||
      observedRank(right) - observedRank(left) ||
      right.version - left.version ||
      right.createdAtIso.localeCompare(left.createdAtIso),
  );

  const chosen = ordered[0]!;
  for (const row of ordered.slice(1)) {
    rejected.push({ id: row.id, why: `outranked by ${chosen.id}` });
  }

  const provenance =
    chosen.derivedFrom === null
      ? 'provenance not recorded'
      : isObservedSource(chosen.derivedFrom)
        ? `observed (${chosen.derivedFrom})`
        : `declared (${chosen.derivedFrom}) — no observed map exists for this environment`;
  const acceptance =
    chosen.acceptance === null
      ? 'acceptance not recorded'
      : chosen.acceptance === 'CANDIDATE'
        ? 'held as a CANDIDATE — this measurement rests on a degraded crawl'
        : 'accepted';

  return {
    chosen,
    why: `v${chosen.version} of environment ${chosen.environmentId}: ${provenance}, ${acceptance}`,
    rejected,
  };
}

// ─── The route × role access matrix ─────────────────────────────────────────

/**
 * What one role got when it asked for one route.
 *
 * `FlowNode.requiresRoles` is a `string[]` that nothing ever writes a value
 * into — the crawler sets `requiresRoles: []` unconditionally — so the sentence
 * "a member gets 403 on /admin" has never been expressible and authorization
 * coverage has no denominator at all. A 403 is not an absence of surface; it is
 * the correct behaviour of a surface, and a product that cannot say so cannot
 * test the single most expensive class of defect a web application has.
 */
export const ACCESS_OUTCOMES = ['ALLOWED', 'DENIED', 'REDIRECTED', 'UNKNOWN'] as const;
export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number];

export const ACCESS_OUTCOME_LABELS: Record<AccessOutcome, string> = {
  ALLOWED: 'served the route',
  DENIED: 'refused with a status',
  REDIRECTED: 'sent somewhere else',
  UNKNOWN: 'not measured',
};

export interface RouteAccess {
  /** The role as the application spells it, or null for anonymous. */
  role: string | null;
  outcome: AccessOutcome;
  /**
   * The status observed. NULL when `basis` is DECLARED — the source said a role
   * is required and no request was made, so there is no status to report.
   * Writing 403 there would be inventing a measurement.
   */
  status: number | null;
  /** Normalised destination of a REDIRECTED outcome. */
  destinationRoute: string | null;
  /**
   * OBSERVED means we asked as that role and this is what came back. DECLARED
   * means the source says so. They are not interchangeable: a declared
   * restriction that the application does not actually enforce is the defect.
   */
  basis: 'OBSERVED' | 'DECLARED';
  observedAtIso: string | null;
}

/** An access cell is measured only when somebody actually asked. */
export function isAccessMeasured(access: RouteAccess): boolean {
  return access.basis === 'OBSERVED' && access.outcome !== 'UNKNOWN';
}

/**
 * The authorization denominator for one node: how many (route, role) cells have
 * a measured outcome, and how many the project's roles imply.
 *
 * `unmeasured` is reported and is never folded into `denominator`. A cell
 * nobody asked about is not a passing cell and not a failing one — and the
 * product's whole claim is that it names the ones nobody asked about.
 */
export function accessCoverage(
  access: readonly RouteAccess[],
  roles: readonly string[],
): { measured: number; declaredOnly: number; unmeasured: number; cells: number } {
  const measuredRoles = new Set<string>();
  let declaredOnly = 0;
  for (const entry of access) {
    const key = entry.role ?? '<anonymous>';
    if (isAccessMeasured(entry)) {
      measuredRoles.add(key);
      continue;
    }
    if (entry.basis === 'DECLARED') declaredOnly += 1;
  }
  // Anonymous counts as a role on this axis: "can a logged-out visitor reach
  // /admin" is the first question anybody asks, and leaving it out of the cell
  // count would make the one cell that matters most invisible.
  const cells = roles.length + 1;
  return {
    measured: measuredRoles.size,
    declaredOnly,
    unmeasured: Math.max(cells - measuredRoles.size, 0),
    cells,
  };
}

// ─── 4xx and 5xx as first-class nodes ───────────────────────────────────────

/**
 * The status a node's navigation produced.
 *
 * The crawler sees it — `if (response && response.status() >= 400)` — and
 * writes it to a progress callback that is printed and discarded. The node is
 * then stored as an ordinary route, so the generator writes a test asserting
 * that a page which does not exist loads correctly, and that test PASSES
 * against the 404 page forever.
 */
export const NODE_STATUS_CLASSES = [
  'OK',
  'REDIRECT',
  'CLIENT_ERROR',
  'SERVER_ERROR',
  'UNKNOWN',
] as const;
export type NodeStatusClass = (typeof NODE_STATUS_CLASSES)[number];

export interface NodeStatus {
  /**
   * The status code. NULL when the navigation produced no response at all — a
   * same-document SPA transition, or a `goto` that threw. Null is not 200.
   */
  code: number | null;
  class: NodeStatusClass;
  /**
   * True when the body is the application's error page rather than the route's
   * content. Separate from `class` because a soft 404 answers 200 with an error
   * page, and that is the case that fools everything.
   */
  isErrorPage: boolean;
}

/** Classifies a status code. Null and nonsense both come back UNKNOWN, not OK. */
export function statusClassFor(code: number | null | undefined): NodeStatusClass {
  if (code === null || code === undefined || !Number.isFinite(code)) return 'UNKNOWN';
  if (code >= 200 && code < 300) return 'OK';
  if (code >= 300 && code < 400) return 'REDIRECT';
  if (code >= 400 && code < 500) return 'CLIENT_ERROR';
  if (code >= 500 && code < 600) return 'SERVER_ERROR';
  return 'UNKNOWN';
}

/**
 * Whether a generator may write a happy-path test against this node.
 *
 * NO for an error status, NO for a soft error page, and NO when the status was
 * never recorded. That last one is the interesting case: a node from a crawl
 * that predates status capture has `status: undefined`, and treating it as
 * healthy would re-create the exact defect for every map already on disk. The
 * caller's remedy is to re-crawl, which is cheap; writing a passing test
 * against a 404 page is not.
 *
 * An error node is still a NODE — it stays in the graph and in the inventory,
 * on the ERROR_STATE axis, where it is worth a test that asserts the error.
 */
export function shouldGenerateAgainst(node: Pick<FlowNode, 'status'>): boolean {
  const status = node.status;
  if (status === undefined || status === null) return false;
  if (status.isErrorPage) return false;
  return status.class === 'OK' || status.class === 'REDIRECT';
}
