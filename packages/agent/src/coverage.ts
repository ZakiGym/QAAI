/**
 * Coverage gap analysis — "which test did you never write?"
 *
 * Every other part of this product reports on tests that exist: which failed,
 * which flaked, which a diff can reach. This one reports on the tests that do
 * not exist, which is the only question a QA lead actually loses sleep over. We
 * already hold both halves of the answer and have never put them side by side:
 * the Flow Map is what the application can do, and the Test rows are what is
 * actually asserted. A gap is a thing in the first that is missing from the
 * second.
 *
 * NOTHING IN THIS FILE CALLS A MODEL. A gap is a claim about the customer's test
 * suite, and a claim we cannot show the working for is worse than no claim at
 * all — it is a confident stranger telling a team their checkout is untested.
 * So every gap carries `evidence`: the literal sentences that justify it ("the
 * crawl reached /refunds from 3 places; no test mentions it"). The model is
 * invited exactly once, at the end, to WRITE the missing test — never to decide
 * that one is missing.
 *
 * Three rules follow from that, and they are the whole design:
 *
 * 1. UNKNOWN IS NOT A GAP. A test that navigates to a URL built at runtime
 *    (`page.goto(url)`) is invisible to static extraction. It might be the one
 *    test covering /refunds. Counting its absence as a gap would be asserting
 *    coverage knowledge we do not have, so those tests go in `unknowns`, are
 *    reported as their own bucket, and cap the confidence of every route gap in
 *    the project.
 *
 * 2. CRYING WOLF IS THE FAILURE MODE. A false "you never test checkout" is not
 *    a minor inaccuracy; it is the thing that makes a team close the tab. So
 *    matching is deliberately ASYMMETRIC: strict where the evidence is strong
 *    (a route literal either appears or it does not) and generous everywhere the
 *    evidence is weak (if any test anywhere mentions a button's label, we do not
 *    claim nobody clicks it).
 *
 * 3. A DETECTOR THAT THROWS MUST NOT TAKE THE REPORT DOWN. The flow map is a
 *    Json column written by an older crawler than the types here describe. Every
 *    reader below is defensive, and anything unreadable is reported in
 *    `unreadable` rather than silently dropped — a gap that vanishes because one
 *    node had a null in it is exactly the silence this feature exists to end.
 *
 * On the input contract: route extraction from Test.code is NOT re-derived here.
 * apps/api/src/lib/impact.ts already does it — string-level, cap-guarded, with
 * template and toHaveURL handling that took real bugs to get right — and this
 * package cannot import from an app. So the caller extracts and passes
 * `routes`, and `apps/api/src/routes/coverage.ts` is the one place that wiring
 * lives. `canonicalRoute` below is then applied to BOTH sides as the comparison
 * key; it is idempotent on impact's `normalizeRoute` output by construction.
 */

import { createHash } from 'node:crypto';
import { locatorsFromFlowMap } from '@qaai/shared';
import type { PlanItem, Priority, Selector, TestType } from '@qaai/shared';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const GAP_KINDS = [
  /** A route in the crawl that no test navigates to. */
  'UNVISITED_ROUTE',
  /** A route the crawler hit an auth wall on, that no *authenticated* test reaches. */
  'UNREACHED_AUTH_ROUTE',
  /** A journey the crawl walked end to end that no single test walks. */
  'UNWALKED_JOURNEY',
  /** A form nobody fills in or submits. */
  'UNSUBMITTED_FORM',
  /** A button or input the crawler found that no test mentions. */
  'UNUSED_AFFORDANCE',
  /** A feature that has tests, all of which only assert the happy path. */
  'NO_NEGATIVE_CASE',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/**
 * How much of this claim rests on something we can point at.
 *
 * HIGH    every test's declared coverage was fully readable and none of it
 *         touches this; the only way we are wrong is if the crawl is wrong.
 * MEDIUM  readable, but something nearby weakens it — a test lands one click
 *         away, or the suite contains tests we could not read.
 * LOW     the detector is a heuristic over human-written English (the
 *         negative-case scan) and deserves a human's eye before it is believed.
 */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Caps. Each one protects the process; each one is reported when it bites. */
const MAX_CODE_CHARS = 400_000;
const MAX_NODES = 2000;
const MAX_GAPS = 300;
const MAX_AFFORDANCE_GAPS = 40;
const MAX_EVIDENCE_TESTS = 5;

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface CoverageTestInput {
  id: string;
  name: string;
  filePath: string;
  feature: string | null;
  priority: Priority;
  testType: TestType;
  tags: string[];
  /**
   * Routes this test navigates to, asserts on, or configures — ALREADY
   * EXTRACTED by the caller with impact.ts's `routeLiteralsFromCode` and
   * `routesFromSpec`. Passing `[]` means "declares none", which is a real and
   * important state; it is not the same as "covers nothing", which is why
   * `code` comes along too.
   */
  routes: string[];
  /**
   * Source. Read here ONLY for things a route list cannot express: whether the
   * test signs in, whether it asserts a failure, whether it navigates to a URL
   * we cannot see, and whether it mentions a given button.
   */
  code: string | null;
  /** Set by the caller when its extractor hit a cap and read `routes` partially. */
  coverageTruncated?: boolean;
}

export interface CoverageInput {
  /** The serialised FlowMap row. Read defensively; any shape is survivable. */
  flowMapGraph: unknown;
  tests: CoverageTestInput[];
  /** Ranked gaps to return. The full count is always reported in `totals`. */
  limit?: number;
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

export interface FormSummary {
  name: string;
  submitLabel: string | null;
  fields: Array<{ label: string; required: boolean; semantic: string }>;
}

/**
 * Everything `planItemForGap` needs to write a proposal, carried on the gap
 * itself. A gap travels from GET /coverage to POST /coverage/:id/propose through
 * a client, so it has to be self-contained — re-deriving it from the report on
 * the way back in is how a proposal ends up describing a different gap than the
 * one the human ticked.
 */
export type GapSubject =
  | {
      kind: 'route';
      route: string;
      title: string;
      behindAuth: boolean;
      forms: FormSummary[];
      /** Actions the crawler used to ARRIVE here — the steps a test must repeat. */
      entryActions: string[];
    }
  | {
      kind: 'journey';
      journeyId: string;
      name: string;
      description: string;
      priority: Priority;
      /** Ordered actions from the crawl: `click "Add to cart"`. */
      steps: string[];
      routes: string[];
    }
  | { kind: 'form'; route: string; form: FormSummary; behindAuth: boolean }
  | {
      kind: 'affordance';
      route: string;
      label: string;
      expression: string;
      controlKind: 'link' | 'button' | 'input';
    }
  | { kind: 'negative'; feature: string; routes: string[]; forms: FormSummary[]; testIds: string[] };

export interface CoverageGap {
  /** Deterministic for a given (kind, subject). Stable across recomputation. */
  id: string;
  kind: GapKind;
  /** One line a human reads first. */
  title: string;
  route: string | null;
  feature: string | null;
  /**
   * The claim's support, in plain English. A gap with an empty evidence array is
   * a bug — nothing below is allowed to emit one.
   */
  evidence: string[];
  confidence: Confidence;
  /** 0–1. Flow-map inbound edges, as the proxy for how much traffic passes here. */
  reachability: number;
  /** 0–1. What breaking this would cost: state changes, privilege, journeys. */
  blastRadius: number;
  /** 0–100. The rank. */
  score: number;
  /** Why the score is what it is, so the ranking can be argued with. */
  scoreWhy: string[];
  /** Tests in the neighbourhood that do not close the gap. */
  relatedTestIds: string[];
  subject: GapSubject;
}

/**
 * A test whose coverage we could not read. Not a gap and not coverage — the
 * third state, reported so nobody reads "12 gaps" as "12 things you don't test".
 */
export interface CoverageUnknown {
  testId: string;
  name: string;
  filePath: string;
  reason: string;
  /** The literal that defeated extraction, when there is one worth showing. */
  sample: string | null;
}

export interface CoverageReport {
  /** False when there is no readable flow map: then we know nothing about the app. */
  crawled: boolean;
  flowMapVersion: number | null;
  baseUrl: string | null;
  gaps: CoverageGap[];
  unknowns: CoverageUnknown[];
  /** Parts of the flow map that could not be read. Never silently dropped. */
  unreadable: string[];
  /** Things a reader must know before trusting the numbers. */
  caveats: string[];
  totals: {
    tests: number;
    testsWithReadableRoutes: number;
    routes: number;
    routesVisited: number;
    journeys: number;
    journeysWalked: number;
    forms: number;
    formsExercised: number;
    affordances: number;
    affordancesUsed: number;
    gaps: number;
    gapsReturned: number;
  };
  /** Changes whenever the answer could change. POST /propose checks it. */
  fingerprint: string;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * The comparison key, applied to BOTH sides.
 *
 * Every framework spells "anything here" differently — `[id]`, `{id}`, `:id`,
 * `$id`, `[...slug]` — and the crawler and the test author will not have picked
 * the same one. Collapsing them onto `:param` and `*` is the only way
 * `/orders/123` in a spec and `/orders/:id` in the flow map are recognised as
 * the same page. On routes that already came through impact.ts's
 * `normalizeRoute` this is a no-op, which is the point: one key, computed the
 * same way, whichever side produced the string.
 */
export function canonicalRoute(raw: string): string {
  const withoutQuery = raw.split('?')[0]!.split('#')[0]!;
  const segments = withoutQuery
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const s = segment.trim().toLowerCase();
      if (!s) return '';
      if (/^\[\[?\.\.\..+\]\]?$/.test(s) || s === '*' || s === '**') return '*';
      if (/^\[.+\]$/.test(s) || /^\{.+\}$/.test(s) || /^[:$].+/.test(s)) return ':param';
      return s;
    })
    .filter(Boolean);

  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * Does this test route land on this crawled route?
 *
 * Strict on length, unlike impact.ts's `routesOverlap`, and the difference is
 * deliberate rather than an oversight. Impact asks "could this change have
 * broken that test?", where over-matching costs a minute of CI, so it treats
 * /checkout as touching /checkout/success. Coverage asks "does any test go
 * here?", where over-matching costs a route that is silently declared covered
 * because a test visited its parent. A test that navigates to /checkout has NOT
 * been to /checkout/success, and saying otherwise is the one lie this module
 * must not tell. The near-miss is not thrown away — it comes back as adjacency,
 * which downgrades the gap's confidence instead of erasing it.
 */
export function routeVisits(testRoute: string, crawledRoute: string): boolean {
  const a = testRoute.split('/').filter(Boolean);
  const b = crawledRoute.split('/').filter(Boolean);

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    // `*` swallows the remainder on either side: /docs/* and /docs/a/b are one place.
    if (left === '*' || right === '*') return true;
    if (left === undefined || right === undefined) return false;
    if (left === right) continue;
    if (left === ':param' || right === ':param') continue;
    return false;
  }
  return true;
}

// ─── The crawl, read defensively ─────────────────────────────────────────────

interface CrawlNode {
  id: string;
  route: string;
  title: string;
  behindAuth: boolean;
  forms: FormSummary[];
  /** Kept in the shape `locatorsFromFlowMap` wants, so it can be reused verbatim. */
  affordances: Array<{ label: string; selector: Selector; kind: 'link' | 'button' | 'input' }>;
  inbound: number;
  outbound: number;
  /** Actions the crawler used to arrive here. */
  entryActions: string[];
}

interface CrawlEdge {
  id: string;
  from: string;
  to: string;
  action: string;
}

interface CrawlJourney {
  id: string;
  name: string;
  description: string;
  priority: Priority;
  edgeIds: string[];
}

interface CrawlModel {
  ok: boolean;
  version: number | null;
  baseUrl: string | null;
  truncatedReason: string | null;
  nodes: CrawlNode[];
  edges: CrawlEdge[];
  journeys: CrawlJourney[];
  features: Array<{ name: string; nodeIds: string[] }>;
  unreadable: string[];
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asPriority(value: unknown): Priority {
  return value === 'CRITICAL_PATH' || value === 'IMPORTANT' || value === 'NICE_TO_HAVE'
    ? value
    : 'IMPORTANT';
}

function readSelector(value: unknown): Selector | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as { strategy?: unknown; value?: unknown; name?: unknown; nth?: unknown; confidence?: unknown };
  if (typeof s.strategy !== 'string' || typeof s.value !== 'string') return null;
  return {
    strategy: s.strategy as Selector['strategy'],
    value: s.value,
    ...(typeof s.name === 'string' ? { name: s.name } : {}),
    ...(typeof s.nth === 'number' ? { nth: s.nth } : {}),
    confidence: typeof s.confidence === 'number' ? s.confidence : 0.5,
  };
}

function readForms(value: unknown, unreadable: string[], where: string): FormSummary[] {
  if (!Array.isArray(value)) return [];
  const out: FormSummary[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      unreadable.push(`a form on ${where} was not an object and was skipped`);
      continue;
    }
    const f = raw as { name?: unknown; fields?: unknown; submit?: unknown };
    const submit = readSelector(f.submit);
    const fields: FormSummary['fields'] = [];
    if (Array.isArray(f.fields)) {
      for (const rawField of f.fields) {
        if (!rawField || typeof rawField !== 'object') continue;
        const x = rawField as { name?: unknown; label?: unknown; required?: unknown; semantic?: unknown };
        const label = str(x.label) || str(x.name);
        if (!label) continue;
        fields.push({
          label,
          required: x.required === true,
          semantic: str(x.semantic, 'unknown'),
        });
      }
    }
    out.push({
      name: str(f.name, 'form'),
      submitLabel: submit ? (submit.name ?? submit.value) : null,
      fields,
    });
  }
  return out;
}

/**
 * Turn the Json column into something this module can reason about, surviving
 * anything. A crawl written by a version of the Explorer that predates a field
 * must degrade to "we know less", never to a 500 — the whole feature is a
 * report, and a report that refuses to render because one node is odd has
 * failed at its only job.
 */
export function readCrawl(graph: unknown): CrawlModel {
  const unreadable: string[] = [];
  const empty: CrawlModel = {
    ok: false,
    version: null,
    baseUrl: null,
    truncatedReason: null,
    nodes: [],
    edges: [],
    journeys: [],
    features: [],
    unreadable,
  };

  if (!graph || typeof graph !== 'object') return empty;
  const g = graph as Record<string, unknown>;
  if (!Array.isArray(g.nodes)) {
    unreadable.push('the flow map has no `nodes` array, so nothing about the app could be read');
    return empty;
  }

  const nodes: CrawlNode[] = [];
  const byId = new Map<string, CrawlNode>();
  let skippedNodes = 0;

  for (const raw of g.nodes.slice(0, MAX_NODES)) {
    if (!raw || typeof raw !== 'object') {
      skippedNodes += 1;
      continue;
    }
    const n = raw as Record<string, unknown>;
    const id = str(n.id);
    if (!id) {
      skippedNodes += 1;
      continue;
    }

    let route: string | null = null;
    if (typeof n.route === 'string' && n.route.startsWith('/')) route = canonicalRoute(n.route);
    else if (typeof n.url === 'string') {
      try {
        route = canonicalRoute(new URL(n.url).pathname);
      } catch {
        route = null;
      }
    }
    if (!route) {
      skippedNodes += 1;
      continue;
    }

    const affordances: CrawlNode['affordances'] = [];
    if (Array.isArray(n.affordances)) {
      for (const rawA of n.affordances) {
        if (!rawA || typeof rawA !== 'object') continue;
        const a = rawA as { label?: unknown; selector?: unknown; kind?: unknown };
        const selector = readSelector(a.selector);
        const label = str(a.label);
        if (!selector || !label) continue;
        const kind = a.kind === 'button' || a.kind === 'input' ? a.kind : 'link';
        affordances.push({ label, selector, kind });
      }
    }

    const node: CrawlNode = {
      id,
      route,
      title: str(n.title, route),
      behindAuth: n.behindAuth === true,
      forms: readForms(n.forms, unreadable, route),
      affordances,
      inbound: 0,
      outbound: 0,
      entryActions: [],
    };
    nodes.push(node);
    // First sighting wins: several states can share a route (cart-empty vs
    // cart-full) and the gap is about the route, not the state.
    if (!byId.has(id)) byId.set(id, node);
  }

  if (skippedNodes > 0) {
    unreadable.push(
      `${skippedNodes} crawled state(s) had no id or no readable route and could not be checked for coverage`,
    );
  }
  if (Array.isArray(g.nodes) && g.nodes.length > MAX_NODES) {
    unreadable.push(
      `the crawl holds ${g.nodes.length} states; only the first ${MAX_NODES} were analysed`,
    );
  }

  const edges: CrawlEdge[] = [];
  if (Array.isArray(g.edges)) {
    for (const raw of g.edges) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      const id = str(e.id);
      const from = str(e.from);
      const to = str(e.to);
      if (!id || !from || !to) continue;
      const edge: CrawlEdge = { id, from, to, action: str(e.action, 'navigate') };
      edges.push(edge);

      const target = byId.get(to);
      const source = byId.get(from);
      // Self-loops are not traffic; a page linking to itself says nothing about
      // how many ways in there are, and counting it inflates every nav bar.
      if (target && from !== to) {
        target.inbound += 1;
        if (target.entryActions.length < 8) target.entryActions.push(edge.action);
      }
      if (source && from !== to) source.outbound += 1;
    }
  }

  const journeys: CrawlJourney[] = [];
  if (Array.isArray(g.journeys)) {
    for (const raw of g.journeys) {
      if (!raw || typeof raw !== 'object') continue;
      const j = raw as Record<string, unknown>;
      const id = str(j.id);
      if (!id || !Array.isArray(j.edgeIds)) continue;
      journeys.push({
        id,
        name: str(j.name, id),
        description: str(j.description),
        priority: asPriority(j.priority),
        edgeIds: j.edgeIds.filter((x): x is string => typeof x === 'string'),
      });
    }
  }

  const features: Array<{ name: string; nodeIds: string[] }> = [];
  if (Array.isArray(g.features)) {
    for (const raw of g.features) {
      if (!raw || typeof raw !== 'object') continue;
      const f = raw as { name?: unknown; nodeIds?: unknown };
      if (typeof f.name !== 'string' || !Array.isArray(f.nodeIds)) continue;
      features.push({
        name: f.name,
        nodeIds: f.nodeIds.filter((x): x is string => typeof x === 'string'),
      });
    }
  }

  return {
    ok: nodes.length > 0,
    version: typeof g.version === 'number' ? g.version : null,
    baseUrl: typeof g.baseUrl === 'string' ? g.baseUrl : null,
    truncatedReason: typeof g.truncatedReason === 'string' ? g.truncatedReason : null,
    nodes,
    edges,
    journeys,
    features,
    unreadable,
  };
}

// ─── What a test says about itself ───────────────────────────────────────────

/**
 * Navigation calls whose destination is not a literal.
 *
 * `page.goto(url)`, `cy.visit(path)`, and `` page.goto(`${base}/orders`) `` all
 * go somewhere real that no amount of string scanning will reveal. This is the
 * single most important detector in the file: without it, a project whose
 * helpers do the navigating would be told every one of its routes is untested.
 */
const NAV_CALL = /\b(?:goto|visit|navigate|navigateTo)\s*\(\s*([^)]{0,120})/g;

/**
 * Sign-in evidence. A route behind auth is only *reached* by a test that gets in.
 *
 * Every pattern here is an ACTION or an injected session, never a bare word.
 * The distinction is the whole point: `await expect(page).toHaveURL(/login/)`
 * is a test asserting it got BOUNCED, and reading the word "login" in it as
 * proof of authentication would close the exact gap that assertion proves
 * exists — the admin page tested only from outside the door.
 */
const AUTH_SIGNAL: RegExp[] = [
  /\b(storagestate|addcookies|addinitscript|setextrahttpheaders|authprofile)\b|auth\.setup/,
  /\b(authorization|bearer\s|accesstoken|access_token|gettoken|apikey|api_key|sessiontoken)\b/,
  /\b(signin|sign_in|login|log_in|logon|loginas|signinas|authenticate|authenticateas)\s*\(/,
  /\bpassword\b[\s\S]{0,120}\.(?:fill|type|sendkeys)\s*\(/,
  /\.(?:fill|type|sendkeys)\s*\([\s\S]{0,60}\bpassword\b/,
];

/**
 * Failure-path evidence, split by how much it proves.
 *
 * STRONG markers are things you only write when you are testing a failure: an
 * error status asserted on a response, an alert role, the words "invalid" or
 * "rejected". WEAK markers (`.not.`, `toBeDisabled`, "empty") show up in happy
 * paths too — a checkout test asserting the error banner is *not* visible is a
 * happy path. So one strong marker counts and it takes two weak ones, which is
 * the least dishonest line to draw over a keyword scan of somebody else's prose.
 *
 * The status-code markers are deliberately anchored to an assertion or a
 * `status` word rather than matching bare numbers. `waitForTimeout(500)` is not
 * a test of a 500, and reading it as one would silently suppress a real gap —
 * the one direction this detector must not fail in.
 */
const NEGATIVE_STRONG: RegExp[] = [
  /\b(invalid|incorrect|wrong|malformed|rejects?|rejected|declines?|declined|denied|forbidden|unauthori[sz]ed|unauthenticated|expired|duplicate|conflict|insufficient|unhappy)\b/,
  /\b(should\s+not|shouldn'?t|must\s+not|cannot|can'?t|fails?|failure|negative\s+case|sad\s+path)\b/,
  /\b(out[-\s]of[-\s]stock|required\s+field|validation\s+error|error\s+message|error\s+state)\b/,
  /(?:status|statuscode|statustext)\W{0,14}(?:400|401|403|404|405|409|410|422|429|500|502|503)\b/,
  /\b(?:tobe|toequal|tohavestatus)\s*\(\s*(?:400|401|403|404|405|409|410|422|429|500|502|503)\s*\)/,
  /getbyrole\(\s*['"`]alert['"`]/,
  /\btoberejected\b|\brejects\./,
];
const NEGATIVE_WEAK =
  /\.not\.|tobedisabled|tohaveattribute\(\s*['"`]aria-invalid|\bempty\b|\bmissing\b|\bboundary\b|edge\s+case|\btimeout\b/g;

interface TestFacts {
  input: CoverageTestInput;
  /** Canonical routes this test declares. */
  routes: string[];
  /** Lowercased code, capped. The haystack for every mention check. */
  haystack: string;
  authenticated: boolean;
  negative: boolean;
  /** Non-null when this test's real coverage cannot be read. */
  unknown: CoverageUnknown | null;
}

function firstDynamicNavArgument(code: string): string | null {
  for (const match of code.matchAll(NAV_CALL)) {
    const arg = match[1]!.trim();
    if (!arg) continue;
    // A literal, or a template whose text starts before the first `${`.
    if (arg.startsWith("'") || arg.startsWith('"')) continue;
    if (arg.startsWith('`') && !arg.startsWith('`${')) continue;
    // A bare `(` is a nested call we cannot see through; everything else here is
    // an identifier, a member expression, or an interpolation-first template.
    return `${match[0].trim().slice(0, 80)}…`;
  }
  return null;
}

function indexTest(test: CoverageTestInput): TestFacts {
  const rawCode = test.code ?? '';
  const oversized = rawCode.length > MAX_CODE_CHARS;
  const code = oversized ? rawCode.slice(0, MAX_CODE_CHARS) : rawCode;
  const haystack = `${code}\n${test.name}\n${test.tags.join(' ')}`.toLowerCase();

  const routes = [...new Set(test.routes.map(canonicalRoute))];

  let unknown: CoverageUnknown | null = null;
  const dynamic = firstDynamicNavArgument(code);
  if (test.coverageTruncated) {
    unknown = {
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      reason:
        'Part of what this test declares was past an internal extraction limit and never read, so what it covers is only partly known.',
      sample: null,
    };
  } else if (oversized) {
    unknown = {
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      reason: `This test is ${rawCode.length} characters; only the first ${MAX_CODE_CHARS} were scanned, so it may navigate somewhere we did not see.`,
      sample: null,
    };
  } else if (dynamic) {
    unknown = {
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      reason:
        'This test navigates to a URL built at runtime, so static extraction cannot say which pages it visits.',
      sample: dynamic,
    };
  } else if (routes.length === 0) {
    unknown = {
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      reason: code
        ? 'No route literal appears anywhere in this test — its navigation probably lives in an imported helper or page object.'
        : 'This test row has no code and declares no route, so nothing about its coverage is visible.',
      sample: null,
    };
  }

  return {
    input: test,
    routes,
    haystack,
    authenticated: signsIn(haystack),
    negative: assertsAFailure(haystack),
    unknown,
  };
}

/** Exported so the heuristics can be argued with in tests rather than only inline. */
export function signsIn(lowercasedHaystack: string): boolean {
  return AUTH_SIGNAL.some((re) => re.test(lowercasedHaystack));
}

export function assertsAFailure(lowercasedHaystack: string): boolean {
  if (NEGATIVE_STRONG.some((re) => re.test(lowercasedHaystack))) return true;
  const weak = [...lowercasedHaystack.matchAll(new RegExp(NEGATIVE_WEAK.source, 'g'))].length;
  return weak >= 2;
}

/** A mention is generous on purpose: see rule 2 in the file header. */
function mentions(facts: TestFacts, needle: string): boolean {
  const trimmed = needle.trim().toLowerCase();
  // Two characters matches everything; a claim built on it is not a claim.
  if (trimmed.length < 3) return false;
  return facts.haystack.includes(trimmed);
}

// ─── Blast radius ────────────────────────────────────────────────────────────

/**
 * Route words that say "money, access, or destruction". This is a heuristic and
 * is labelled as one in `scoreWhy` wherever it fires — the point of showing the
 * score's components is that a team whose money page is called /tarief can see
 * why we ranked it low and tell us so.
 */
const HIGH_VALUE =
  /\b(checkout|payment|pay|billing|invoice|subscribe|subscription|order|orders|cart|basket|purchase|refund|refunds|transfer|withdraw|deposit|payout|login|signin|signup|register|password|reset|account|admin|member|permission|role|users|delete|destroy|export|apikey|api-keys|token|security|2fa|mfa)\b/;
const LOW_VALUE =
  /\b(about|contact|help|faq|docs|doc|blog|news|press|careers|legal|privacy|terms|cookie|cookies|sitemap|changelog|styleguide|robots)\b/;

interface Score {
  reachability: number;
  blastRadius: number;
  score: number;
  why: string[];
}

const KIND_WEIGHT: Record<GapKind, number> = {
  UNVISITED_ROUTE: 1,
  UNREACHED_AUTH_ROUTE: 1,
  UNWALKED_JOURNEY: 0.95,
  UNSUBMITTED_FORM: 0.9,
  NO_NEGATIVE_CASE: 0.7,
  UNUSED_AFFORDANCE: 0.5,
};

function scoreGap(
  kind: GapKind,
  node: CrawlNode | null,
  ctx: { maxInbound: number; maxOutbound: number; journeyPriority: Priority | null; text: string },
): Score {
  const why: string[] = [];

  // Reachability: how many distinct ways in the crawl found. That is the only
  // traffic proxy available without analytics, and it is a good one — a page you
  // can get to from the nav, the footer and a CTA is a page people are on.
  const inbound = node?.inbound ?? 0;
  const reachability = ctx.maxInbound > 0 ? Math.min(1, inbound / ctx.maxInbound) : 0;
  if (inbound > 0) {
    why.push(`the crawl reached it from ${inbound} place${inbound === 1 ? '' : 's'}`);
  } else if (node) {
    why.push('the crawl found no inbound link to it, so it is probably a deep or entry-only page');
  }

  const parts: number[] = [];

  if (ctx.journeyPriority) {
    const weight =
      ctx.journeyPriority === 'CRITICAL_PATH' ? 1 : ctx.journeyPriority === 'IMPORTANT' ? 0.6 : 0.25;
    parts.push(weight);
    why.push(`it sits on a ${ctx.journeyPriority} journey the Explorer already named`);
  }

  if (node?.forms.length) {
    parts.push(1);
    why.push(
      `it carries ${node.forms.length} form${node.forms.length === 1 ? '' : 's'}, so it changes state rather than just rendering`,
    );
  } else if (node) {
    parts.push(0.2);
  }

  if (node?.behindAuth) {
    parts.push(1);
    why.push('it is behind an auth wall, so what breaks there is privileged');
  }

  const outbound = node?.outbound ?? 0;
  if (ctx.maxOutbound > 0) {
    const hub = Math.min(1, outbound / ctx.maxOutbound);
    parts.push(hub);
    if (hub > 0.6) why.push(`it links onward to ${outbound} places, so it is a hub`);
  }

  const text = ctx.text.toLowerCase();
  if (HIGH_VALUE.test(text)) {
    parts.push(1);
    why.push('its name contains a revenue, access, or destructive word (a heuristic)');
  } else if (LOW_VALUE.test(text)) {
    parts.push(0);
    why.push('its name reads like informational content (a heuristic)');
  } else {
    parts.push(0.35);
  }

  const blastRadius = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : 0.35;
  const score = Math.round(100 * KIND_WEIGHT[kind] * (0.45 * reachability + 0.55 * blastRadius));

  return { reachability: round2(reachability), blastRadius: round2(blastRadius), score, why };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── Gap identity ────────────────────────────────────────────────────────────

/**
 * Stable across recomputation for the same subject, so a client can hold a gap
 * id across the round trip to POST /propose. Deliberately NOT derived from the
 * evidence or the score: those move as tests are added, and a human ticking
 * "write this test" means the subject, not the sentence we happened to print.
 */
function gapId(kind: GapKind, ...parts: string[]): string {
  // NUL-separated: it cannot occur in a route, a form name, or a locator, so
  // gapId('X', 'a b') and gapId('X', 'a', 'b') can never collide onto one id.
  const digest = createHash('sha256').update([kind, ...parts].join('\u0000')).digest('hex');
  return `gap_${digest.slice(0, 16)}`;
}

// ─── The analysis ────────────────────────────────────────────────────────────

export function analyzeCoverage(input: CoverageInput): CoverageReport {
  const crawl = readCrawl(input.flowMapGraph);
  const facts = input.tests.map(indexTest);
  const unknowns = facts.map((f) => f.unknown).filter((u): u is CoverageUnknown => u !== null);
  const caveats: string[] = [];

  const emptyTotals = {
    tests: input.tests.length,
    testsWithReadableRoutes: facts.filter((f) => f.routes.length > 0).length,
    routes: 0,
    routesVisited: 0,
    journeys: 0,
    journeysWalked: 0,
    forms: 0,
    formsExercised: 0,
    affordances: 0,
    affordancesUsed: 0,
    gaps: 0,
    gapsReturned: 0,
  };

  if (!crawl.ok) {
    // No map means no claim. "You have no tests for anything" would be true of a
    // project we have simply never looked at, and printing it would be a lie
    // dressed as a finding.
    return {
      crawled: false,
      flowMapVersion: crawl.version,
      baseUrl: crawl.baseUrl,
      gaps: [],
      unknowns,
      unreadable: crawl.unreadable,
      caveats: [
        'This project has no readable crawl, so there is nothing to compare the tests against. Run the Explorer and ask again — coverage gaps are the difference between what the crawler saw and what the suite asserts, and half of that is missing.',
      ],
      totals: emptyTotals,
      fingerprint: fingerprintOf(crawl.version, input.tests, []),
    };
  }

  if (crawl.truncatedReason) {
    caveats.push(
      `The crawl stopped early (${crawl.truncatedReason}), so this is coverage of what was SEEN, not of what exists. Routes the crawler never reached cannot appear as gaps.`,
    );
  }
  if (unknowns.length > 0) {
    caveats.push(
      `${unknowns.length} of ${input.tests.length} test(s) declare no route we can read statically — see \`unknowns\`. Any one of them could be covering a route listed below, so route gaps in this project are capped at MEDIUM confidence.`,
    );
  }
  if (input.tests.length === 0) {
    caveats.push('This project has no enabled tests, so every route the crawl found is a gap.');
  }

  const routeGapConfidence: Confidence = unknowns.length > 0 ? 'MEDIUM' : 'HIGH';

  // ── The route index ────────────────────────────────────────────────────────
  // Several crawled states can share a route. Coverage is a property of the
  // route, so they are folded together and the richest sighting wins.
  const byRoute = new Map<string, CrawlNode>();
  for (const node of crawl.nodes) {
    const existing = byRoute.get(node.route);
    if (!existing) {
      byRoute.set(node.route, { ...node });
      continue;
    }
    existing.inbound += node.inbound;
    existing.outbound += node.outbound;
    existing.behindAuth = existing.behindAuth || node.behindAuth;
    existing.forms = [...existing.forms, ...node.forms];
    existing.affordances = [...existing.affordances, ...node.affordances];
    existing.entryActions = [...existing.entryActions, ...node.entryActions].slice(0, 8);
  }

  const routes = [...byRoute.values()];
  const maxInbound = Math.max(1, ...routes.map((n) => n.inbound));
  const maxOutbound = Math.max(1, ...routes.map((n) => n.outbound));

  const nodeById = new Map(crawl.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(crawl.edges.map((e) => [e.id, e]));

  /** Which routes the crawl links onward to — used for the adjacency downgrade. */
  const neighbours = new Map<string, Set<string>>();
  for (const edge of crawl.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to || from.route === to.route) continue;
    if (!neighbours.has(from.route)) neighbours.set(from.route, new Set());
    neighbours.get(from.route)!.add(to.route);
  }

  /** Journeys, resolved to routes once so several detectors can share the work. */
  const journeyRoutes = new Map<string, string[]>();
  const journeySteps = new Map<string, string[]>();
  const routeJourneyPriority = new Map<string, Priority>();
  const PRIORITY_RANK: Record<Priority, number> = { NICE_TO_HAVE: 0, IMPORTANT: 1, CRITICAL_PATH: 2 };

  for (const journey of crawl.journeys) {
    const ordered: string[] = [];
    const steps: string[] = [];
    let broken = 0;
    for (const edgeId of journey.edgeIds) {
      const edge = edgeById.get(edgeId);
      if (!edge) {
        broken += 1;
        continue;
      }
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (from && ordered[ordered.length - 1] !== from.route) ordered.push(from.route);
      steps.push(edge.action);
      if (to && ordered[ordered.length - 1] !== to.route) ordered.push(to.route);
    }
    if (broken > 0) {
      crawl.unreadable.push(
        `journey "${journey.name}" references ${broken} edge id(s) that are not in the graph; it was scored on the steps that do resolve`,
      );
    }
    journeyRoutes.set(journey.id, ordered);
    journeySteps.set(journey.id, steps);
    for (const route of ordered) {
      const current = routeJourneyPriority.get(route);
      if (!current || PRIORITY_RANK[journey.priority] > PRIORITY_RANK[current]) {
        routeJourneyPriority.set(route, journey.priority);
      }
    }
  }

  /** Which tests visit a given crawled route. */
  const visitorsOf = (route: string): TestFacts[] =>
    facts.filter((f) => f.routes.some((r) => routeVisits(r, route)));

  const gaps: CoverageGap[] = [];
  const visitedRoutes = new Set<string>();
  for (const node of routes) if (visitorsOf(node.route).length > 0) visitedRoutes.add(node.route);

  // ── 1 & 2. Routes nobody visits ────────────────────────────────────────────
  for (const node of routes) {
    if (visitedRoutes.has(node.route)) continue;

    // A test that reaches somewhere one click away is real information: it may
    // well walk on and never write the URL down. It does not close the gap, but
    // it is why this comes back MEDIUM instead of HIGH.
    const adjacentFrom = [...neighbours.entries()]
      .filter(([from, to]) => to.has(node.route) && visitedRoutes.has(from))
      .map(([from]) => from);
    const adjacentTests = adjacentFrom.flatMap((route) => visitorsOf(route));
    const relatedTestIds = [...new Set(adjacentTests.map((f) => f.input.id))].slice(
      0,
      MAX_EVIDENCE_TESTS,
    );

    const kind: GapKind = node.behindAuth ? 'UNREACHED_AUTH_ROUTE' : 'UNVISITED_ROUTE';
    const evidence: string[] = [];

    if (node.inbound > 0) {
      evidence.push(
        `The crawl reached ${node.route} from ${node.inbound} place${node.inbound === 1 ? '' : 's'} (${node.entryActions.slice(0, 3).join('; ') || 'navigation'}).`,
      );
    } else {
      evidence.push(`The crawl recorded ${node.route} ("${node.title}") as a state of the app.`);
    }
    evidence.push(
      input.tests.length === 0
        ? 'This project has no enabled tests at all.'
        : `No route literal in any of the ${input.tests.length} enabled tests resolves to it.`,
    );
    if (node.behindAuth) {
      evidence.push('The crawler hit an auth wall here, so this is a signed-in surface.');
    }
    if (adjacentFrom.length > 0) {
      evidence.push(
        `${relatedTestIds.length} test(s) do reach ${adjacentFrom.slice(0, 3).join(', ')}, which link(s) here — they may click through without writing the URL down.`,
      );
    }

    const scored = scoreGap(kind, node, {
      maxInbound,
      maxOutbound,
      journeyPriority: routeJourneyPriority.get(node.route) ?? null,
      text: `${node.route} ${node.title}`,
    });

    gaps.push({
      id: gapId(kind, node.route),
      kind,
      title: node.behindAuth
        ? `No authenticated test reaches ${node.route}`
        : `Nothing tests ${node.route}`,
      route: node.route,
      feature: featureOf(crawl, node) ?? null,
      evidence,
      confidence: adjacentFrom.length > 0 ? 'MEDIUM' : routeGapConfidence,
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds,
      subject: {
        kind: 'route',
        route: node.route,
        title: node.title,
        behindAuth: node.behindAuth,
        forms: node.forms,
        entryActions: node.entryActions,
      },
    });
  }

  // ── 2b. Auth routes reached only by signed-out tests ───────────────────────
  // A test that navigates to /admin without ever signing in is almost certainly
  // asserting the redirect, not the page. That is a fine test to have and a
  // terrible one to mistake for coverage of what is behind the wall.
  for (const node of routes) {
    if (!node.behindAuth || !visitedRoutes.has(node.route)) continue;
    const visitors = visitorsOf(node.route);
    if (visitors.some((f) => f.authenticated)) continue;

    const scored = scoreGap('UNREACHED_AUTH_ROUTE', node, {
      maxInbound,
      maxOutbound,
      journeyPriority: routeJourneyPriority.get(node.route) ?? null,
      text: `${node.route} ${node.title}`,
    });

    gaps.push({
      id: gapId('UNREACHED_AUTH_ROUTE', node.route, 'signed-out-only'),
      kind: 'UNREACHED_AUTH_ROUTE',
      title: `${node.route} is only ever tested signed out`,
      route: node.route,
      feature: featureOf(crawl, node) ?? null,
      evidence: [
        `The crawler hit an auth wall reaching ${node.route}, so the real page is behind a sign-in.`,
        `${visitors.length} test(s) navigate there — ${visitors
          .slice(0, MAX_EVIDENCE_TESTS)
          .map((f) => `"${f.input.name}"`)
          .join(', ')} — and none of them contains a sign-in step, a stored session, or an auth header.`,
        'That is coverage of the redirect, not of what the page does once you are in.',
      ],
      confidence: 'MEDIUM',
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds: visitors.slice(0, MAX_EVIDENCE_TESTS).map((f) => f.input.id),
      subject: {
        kind: 'route',
        route: node.route,
        title: node.title,
        behindAuth: true,
        forms: node.forms,
        entryActions: node.entryActions,
      },
    });
  }

  // ── 3. Journeys nobody walks ───────────────────────────────────────────────
  let journeysWalked = 0;
  for (const journey of crawl.journeys) {
    const ordered = journeyRoutes.get(journey.id) ?? [];
    if (ordered.length === 0) continue;

    const walkers = facts.filter((f) =>
      ordered.every((route) => f.routes.some((r) => routeVisits(r, route))),
    );
    if (walkers.length > 0) {
      journeysWalked += 1;
      continue;
    }

    const perStep = ordered.map((route) => ({ route, tests: visitorsOf(route) }));
    const coveredSteps = perStep.filter((s) => s.tests.length > 0);
    const partialTestIds = [
      ...new Set(coveredSteps.flatMap((s) => s.tests.map((t) => t.input.id))),
    ].slice(0, MAX_EVIDENCE_TESTS);

    const anchor = ordered
      .map((route) => byRoute.get(route))
      .filter((n): n is CrawlNode => Boolean(n))
      .sort((a, b) => b.inbound - a.inbound)[0] ?? null;

    const scored = scoreGap('UNWALKED_JOURNEY', anchor, {
      maxInbound,
      maxOutbound,
      journeyPriority: journey.priority,
      text: `${journey.name} ${journey.description} ${ordered.join(' ')}`,
    });

    gaps.push({
      id: gapId('UNWALKED_JOURNEY', journey.id),
      kind: 'UNWALKED_JOURNEY',
      title: `No single test walks "${journey.name}"`,
      route: ordered[0] ?? null,
      feature: anchor ? (featureOf(crawl, anchor) ?? null) : null,
      evidence: [
        `The crawl walked this end to end: ${ordered.join(' → ')}.`,
        coveredSteps.length === 0
          ? 'No test visits any step of it.'
          : `${coveredSteps.length} of ${ordered.length} steps are visited (${coveredSteps
              .map((s) => s.route)
              .slice(0, 4)
              .join(', ')}), but by ${partialTestIds.length} different test(s) — nobody walks the whole path, so the hand-offs between steps are unasserted.`,
        `The Explorer rated this journey ${journey.priority}.`,
      ],
      confidence: routeGapConfidence,
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds: partialTestIds,
      subject: {
        kind: 'journey',
        journeyId: journey.id,
        name: journey.name,
        description: journey.description,
        priority: journey.priority,
        steps: journeySteps.get(journey.id) ?? [],
        routes: ordered,
      },
    });
  }

  // ── 4. Forms nobody submits ────────────────────────────────────────────────
  // Generous by design (rule 2): ANY test mentioning the submit label, or a
  // field name alongside a fill call, closes this. A form is the highest-value
  // thing to be wrong about, so we would rather miss a real gap than invent one.
  let totalForms = 0;
  let formsExercised = 0;
  for (const node of routes) {
    for (const form of node.forms) {
      totalForms += 1;
      const submitMentioned =
        form.submitLabel !== null && facts.some((f) => mentions(f, form.submitLabel!));
      const fieldMentioned = facts.some(
        (f) =>
          /\.(fill|type|selectOption|setInputFiles|check|press)\s*\(/.test(f.input.code ?? '') &&
          form.fields.some((field) => mentions(f, field.label)),
      );
      if (submitMentioned || fieldMentioned) {
        formsExercised += 1;
        continue;
      }

      const scored = scoreGap('UNSUBMITTED_FORM', node, {
        maxInbound,
        maxOutbound,
        journeyPriority: routeJourneyPriority.get(node.route) ?? null,
        text: `${node.route} ${node.title} ${form.name} ${form.fields.map((x) => x.label).join(' ')}`,
      });

      const fieldList = form.fields.map((x) => x.label).slice(0, 6);
      gaps.push({
        id: gapId('UNSUBMITTED_FORM', node.route, form.name),
        kind: 'UNSUBMITTED_FORM',
        title: `Nobody submits the "${form.name}" form on ${node.route}`,
        route: node.route,
        feature: featureOf(crawl, node) ?? null,
        evidence: [
          `The crawl found a form "${form.name}" on ${node.route} with ${form.fields.length} field(s)${fieldList.length ? `: ${fieldList.join(', ')}` : ''}.`,
          form.submitLabel
            ? `No test mentions its submit control ("${form.submitLabel}") or fills any of its fields.`
            : 'No test fills any of its fields, and the crawl captured no submit control to look for.',
          'A form is where the application accepts input, so this is untested write path, not untested rendering.',
        ],
        confidence: routeGapConfidence,
        reachability: scored.reachability,
        blastRadius: scored.blastRadius,
        score: scored.score,
        scoreWhy: scored.why,
        relatedTestIds: visitorsOf(node.route)
          .slice(0, MAX_EVIDENCE_TESTS)
          .map((f) => f.input.id),
        subject: { kind: 'form', route: node.route, form, behindAuth: node.behindAuth },
      });
    }
  }

  // ── 5. Affordances nobody uses ─────────────────────────────────────────────
  // `locatorsFromFlowMap` already de-duplicates the whole app's controls by
  // expression and sorts them best-first, which is exactly the universe wanted
  // here — the same "Log out" link on twenty pages must be one gap, not twenty.
  const allLocators = locatorsFromFlowMap({
    nodes: routes.map((n) => ({ route: n.route, affordances: n.affordances })),
  });
  let affordancesUsed = 0;
  const affordanceGaps: CoverageGap[] = [];

  for (const locator of allLocators) {
    const used = facts.some(
      (f) => mentions(f, locator.label) || mentions(f, locator.expression),
    );
    if (used) {
      affordancesUsed += 1;
      continue;
    }
    // Links are left to the route gaps above: "nobody clicks this link" and
    // "nobody tests where it goes" are the same finding, and reporting both
    // doubles the noise for no new information.
    if (locator.kind === 'link') continue;

    const node = byRoute.get(locator.route) ?? null;
    const scored = scoreGap('UNUSED_AFFORDANCE', node, {
      maxInbound,
      maxOutbound,
      journeyPriority: routeJourneyPriority.get(locator.route) ?? null,
      text: `${locator.route} ${locator.label}`,
    });

    affordanceGaps.push({
      id: gapId('UNUSED_AFFORDANCE', locator.route, locator.expression),
      kind: 'UNUSED_AFFORDANCE',
      title: `Nobody clicks "${locator.label}" on ${locator.route}`,
      route: locator.route,
      feature: node ? (featureOf(crawl, node) ?? null) : null,
      evidence: [
        `The crawl found a ${locator.kind} labelled "${locator.label}" on ${locator.route} (${locator.expression}, locator confidence ${locator.confidence.toFixed(2)}).`,
        `Neither that label nor that locator appears in any of the ${input.tests.length} enabled tests.`,
      ],
      confidence: routeGapConfidence,
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds: visitorsOf(locator.route)
        .slice(0, MAX_EVIDENCE_TESTS)
        .map((f) => f.input.id),
      subject: {
        kind: 'affordance',
        route: locator.route,
        label: locator.label,
        expression: locator.expression,
        controlKind: locator.kind,
      },
    });
  }

  affordanceGaps.sort((a, b) => b.score - a.score);
  if (affordanceGaps.length > MAX_AFFORDANCE_GAPS) {
    caveats.push(
      `${affordanceGaps.length} controls are never mentioned by any test; the ${MAX_AFFORDANCE_GAPS} highest-scoring are listed. This usually means the suite is thin rather than that each button is separately worth a test.`,
    );
  }
  gaps.push(...affordanceGaps.slice(0, MAX_AFFORDANCE_GAPS));

  // ── 6. Features tested only on the happy path ──────────────────────────────
  // Scoped to features that can actually FAIL in an interesting way: something
  // with a form, or behind auth, or named like money. Demanding a negative case
  // for the marketing page is the kind of finding that gets a report ignored.
  for (const group of featureGroups(crawl, routes)) {
    const groupTests = [
      ...new Map(
        group.routes
          .flatMap((route) => visitorsOf(route))
          .map((f) => [f.input.id, f] as const),
      ).values(),
    ];
    if (groupTests.length === 0) continue; // that is a route gap, already reported
    if (groupTests.some((f) => f.negative)) continue;

    const groupNodes = group.routes
      .map((route) => byRoute.get(route))
      .filter((n): n is CrawlNode => Boolean(n));
    const forms = groupNodes.flatMap((n) => n.forms);
    const interesting =
      forms.length > 0 ||
      groupNodes.some((n) => n.behindAuth) ||
      HIGH_VALUE.test(`${group.name} ${group.routes.join(' ')}`.toLowerCase());
    if (!interesting) continue;

    const anchor = groupNodes.sort((a, b) => b.inbound - a.inbound)[0] ?? null;
    const scored = scoreGap('NO_NEGATIVE_CASE', anchor, {
      maxInbound,
      maxOutbound,
      journeyPriority: anchor ? (routeJourneyPriority.get(anchor.route) ?? null) : null,
      text: `${group.name} ${group.routes.join(' ')}`,
    });

    gaps.push({
      id: gapId('NO_NEGATIVE_CASE', group.name, ...group.routes),
      kind: 'NO_NEGATIVE_CASE',
      title: `"${group.name}" is only ever tested succeeding`,
      route: anchor?.route ?? group.routes[0] ?? null,
      feature: group.name,
      evidence: [
        `${groupTests.length} test(s) cover ${group.routes.slice(0, 4).join(', ')}: ${groupTests
          .slice(0, MAX_EVIDENCE_TESTS)
          .map((f) => `"${f.input.name}"`)
          .join(', ')}.`,
        'None of them names or asserts a failure — no error status, no validation message, no alert role, no rejected input.',
        forms.length > 0
          ? `This feature accepts input (${forms.length} form(s)), and input validation is only proven by the input that is refused.`
          : 'This feature is behind a permission boundary, and a boundary is only proven by the request that is denied.',
        'This one is a keyword scan of test names and code, so it is the weakest claim in this report — check it before you act on it.',
      ],
      confidence: 'LOW',
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds: groupTests.slice(0, MAX_EVIDENCE_TESTS).map((f) => f.input.id),
      subject: {
        kind: 'negative',
        feature: group.name,
        routes: group.routes,
        forms,
        testIds: groupTests.map((f) => f.input.id),
      },
    });
  }

  // ── Rank and return ────────────────────────────────────────────────────────

  /*
   * Collapse gaps that are the same gap.
   *
   * A dynamic route is crawled once per real URL — five products all normalise
   * to `/products/:param` — and the per-node loops above emit one gap per NODE.
   * `gapId` keys on the logical identity (kind + route + subject), which is
   * correct, so those five arrive carrying ONE id between them.
   *
   * Measured on the seeded project: 24 gaps holding 21 distinct ids, with a
   * single "nobody submits POST /cart/add" occupying ranks 0-3. The top of the
   * differentiator's output was one finding printed four times, which is how a
   * reader decides the list is noise and stops reading.
   *
   * It also had a second-order cost. `/propose` looks gaps up by id, so a user
   * selecting the visible duplicates got a TestPlan with four identical items —
   * duplicate work generated from one fact.
   *
   * Merged rather than dropped: how many crawled pages carry the same untested
   * form is real information, so it is folded into the evidence instead of
   * being thrown away with the copies.
   */
  const byId = new Map<string, CoverageGap>();
  const copiesOf = new Map<string, number>();
  for (const gap of gaps) {
    copiesOf.set(gap.id, (copiesOf.get(gap.id) ?? 0) + 1);
    const existing = byId.get(gap.id);
    // Keep the highest-scoring copy: they are the same finding, and the best
    // ranking evidence among them is the honest one to rank it by.
    if (!existing || gap.score > existing.score) byId.set(gap.id, gap);
  }

  const deduped = [...byId.values()].map((gap) => {
    const pages = copiesOf.get(gap.id) ?? 1;
    if (pages < 2) return gap;
    return {
      ...gap,
      evidence: [
        ...gap.evidence,
        `The crawl found this on ${pages} pages that share the route ${gap.route}; they are one gap, not ${pages}.`,
      ],
    };
  });

  gaps.length = 0;
  gaps.push(...deduped);

  gaps.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const limit = Math.min(input.limit ?? MAX_GAPS, MAX_GAPS);
  const returned = gaps.slice(0, limit);
  if (gaps.length > returned.length) {
    caveats.push(`${gaps.length} gaps found; the ${returned.length} highest-ranked are returned.`);
  }

  return {
    crawled: true,
    flowMapVersion: crawl.version,
    baseUrl: crawl.baseUrl,
    gaps: returned,
    unknowns,
    unreadable: crawl.unreadable,
    caveats,
    totals: {
      tests: input.tests.length,
      testsWithReadableRoutes: facts.filter((f) => f.routes.length > 0).length,
      routes: routes.length,
      routesVisited: visitedRoutes.size,
      journeys: crawl.journeys.length,
      journeysWalked,
      forms: totalForms,
      formsExercised,
      affordances: allLocators.length,
      affordancesUsed,
      gaps: gaps.length,
      gapsReturned: returned.length,
    },
    fingerprint: fingerprintOf(crawl.version, input.tests, gaps),
  };
}

function featureOf(crawl: CrawlModel, node: CrawlNode): string | undefined {
  return crawl.features.find((f) => f.nodeIds.includes(node.id))?.name;
}

/**
 * The units the negative-case check runs over: the Explorer's own feature
 * groupings when it made any, and one group per route otherwise. Falling back to
 * per-route rather than skipping is the fail-open choice — a project whose crawl
 * predates feature inference should still hear that its checkout has no failure
 * test.
 */
function featureGroups(
  crawl: CrawlModel,
  routes: CrawlNode[],
): Array<{ name: string; routes: string[] }> {
  if (crawl.features.length > 0) {
    const byId = new Map(crawl.nodes.map((n) => [n.id, n.route]));
    const groups = crawl.features
      .map((f) => ({
        name: f.name,
        routes: [...new Set(f.nodeIds.map((id) => byId.get(id)).filter((r): r is string => Boolean(r)))],
      }))
      .filter((g) => g.routes.length > 0);
    if (groups.length > 0) return groups;
  }
  return routes.map((n) => ({ name: n.title || n.route, routes: [n.route] }));
}

/**
 * Changes whenever the answer could change: the crawl version, the set of tests,
 * and each test's declared coverage. POST /propose compares it so a human who
 * ticked a gap on a stale screen is told, rather than quietly having a test
 * written for a gap somebody else closed ten minutes ago.
 */
function fingerprintOf(
  version: number | null,
  tests: CoverageTestInput[],
  gaps: CoverageGap[],
): string {
  const hash = createHash('sha256');
  hash.update(`v:${version ?? 'none'}\n`);
  for (const test of [...tests].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`t:${test.id}:${[...test.routes].sort().join(',')}:${test.code?.length ?? 0}\n`);
  }
  for (const id of gaps.map((g) => g.id).sort()) hash.update(`g:${id}\n`);
  return hash.digest('hex').slice(0, 16);
}

// ─── Handing a gap to the Generator ──────────────────────────────────────────

/**
 * Turn a gap into the exact shape the Generator already eats.
 *
 * This is the seam between the deterministic half and the model. Everything the
 * proposal says about the APPLICATION comes from the crawl — the steps are the
 * actions the crawler actually performed, the fields are the fields it actually
 * found — so the model is never asked to invent facts, only to write the code
 * that expresses them. And the rationale IS the evidence, so the test that
 * lands in the repo carries the argument for its own existence.
 *
 * `planItemSchema` in @qaai/shared bounds every field (title 160, rationale
 * 1000, 1–40 steps, 1–20 assertions); the clamps below are those bounds, not
 * arbitrary tidiness. A proposal that violates them is one the plan endpoint
 * would reject at the last moment.
 */
export function planItemForGap(gap: CoverageGap): PlanItem {
  const subject = gap.subject;
  const clamp = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, max - 1)}…`;

  const base = {
    id: gap.id,
    feature: clamp(gap.feature || routeFeatureName(gap.route) || 'Uncovered', 80),
    priority: priorityForGap(gap),
    journeyId: subject.kind === 'journey' ? subject.journeyId : null,
    authProfileId: null,
  };

  let title: string;
  let steps: string[];
  let assertions: string[];
  let testType: TestType;

  switch (subject.kind) {
    case 'journey': {
      title = `Walk "${subject.name}" end to end`;
      testType = 'E2E';
      steps = [
        `Start at ${subject.routes[0] ?? '/'}`,
        ...subject.steps,
        ...(subject.routes.length > 1
          ? [`Confirm the final state is ${subject.routes[subject.routes.length - 1]}`]
          : []),
      ];
      assertions = [
        `The journey completes and the application ends on ${subject.routes[subject.routes.length - 1] ?? subject.routes[0] ?? '/'}`,
        'Each hand-off between steps carries its data forward — assert the value produced by one step is the value the next step uses, not merely that the next page rendered',
      ];
      break;
    }
    case 'form': {
      const required = subject.form.fields.filter((f) => f.required);
      title = `Submit the "${subject.form.name}" form on ${subject.route}`;
      testType = 'E2E';
      steps = [
        `Navigate to ${subject.route}`,
        ...(subject.behindAuth ? ['Sign in first — this page is behind an auth wall'] : []),
        ...subject.form.fields.map(
          (f) => `Fill "${f.label}" with a valid ${f.semantic.replace(/_/g, ' ')} value`,
        ),
        subject.form.submitLabel
          ? `Submit with "${subject.form.submitLabel}"`
          : 'Submit the form',
      ];
      assertions = [
        'The submission is accepted and the resulting state reflects what was entered, not merely that a success message appeared',
        required.length > 0
          ? `Leaving "${required[0]!.label}" empty is refused, and the error names that field`
          : 'Submitting invalid input is refused rather than silently accepted',
      ];
      break;
    }
    case 'affordance': {
      title = `Exercise "${subject.label}" on ${subject.route}`;
      testType = 'E2E';
      steps = [
        `Navigate to ${subject.route}`,
        `Activate the ${subject.controlKind} "${subject.label}" (the crawl located it as ${subject.expression})`,
      ];
      assertions = [
        `Activating "${subject.label}" changes something observable — assert the state it produces, not that the control exists`,
      ];
      break;
    }
    case 'negative': {
      const field = subject.forms.flatMap((f) => f.fields).find((f) => f.required);
      title = `Cover the failure path for ${subject.feature}`;
      testType = subject.forms.length > 0 ? 'E2E' : 'SECURITY_SMOKE';
      steps = [
        `Navigate to ${subject.routes[0] ?? '/'}`,
        field
          ? `Submit with "${field.label}" left empty or set to an invalid value`
          : 'Attempt the action without the permission or precondition it requires',
      ];
      assertions = [
        'The attempt is refused rather than partially applied',
        field
          ? `The refusal is explained in terms a user can act on and names "${field.label}"`
          : 'The response is an explicit denial, and no privileged data appears in it',
        'No state was written — re-reading afterwards shows the original value',
      ];
      break;
    }
    default: {
      title = subject.behindAuth
        ? `Reach ${subject.route} as a signed-in user`
        : `Cover ${subject.route}`;
      testType = subject.behindAuth ? 'SECURITY_SMOKE' : 'E2E';
      steps = [
        ...(subject.behindAuth ? ['Sign in with a profile that can reach this page'] : []),
        ...(subject.entryActions.length > 0
          ? [`Arrive the way the crawler did: ${subject.entryActions[0]}`]
          : []),
        `Navigate to ${subject.route}`,
        ...subject.forms.slice(0, 1).map((f) => `Exercise the "${f.name}" form on the page`),
      ];
      assertions = [
        subject.behindAuth
          ? `A signed-in user sees the real ${subject.route} page rather than a redirect, and a signed-out one does not`
          : `${subject.route} renders its own content — assert something only this page can produce, not that the layout loaded`,
        ...(subject.forms.length > 0
          ? ['The form on the page accepts a valid submission and refuses an invalid one']
          : []),
      ];
      break;
    }
  }

  // Every gap carries evidence by construction, but a proposal with an empty
  // rationale would still be schema-valid and useless, so the fallback is real.
  const rationale =
    gap.evidence.length > 0
      ? gap.evidence.join(' ')
      : `${gap.title}. Found by coverage gap analysis over flow map and test routes.`;

  return {
    ...base,
    title: clamp(title, 160),
    rationale: clamp(rationale, 1000),
    testType,
    steps: steps.filter(Boolean).map((s) => clamp(s, 400)).slice(0, 40),
    assertions: assertions.filter(Boolean).map((s) => clamp(s, 400)).slice(0, 20),
  };
}

/**
 * A gap's score is a heuristic; a journey's priority is a judgement the Explorer
 * made and a human approved. So CRITICAL_PATH is only ever inherited, never
 * invented here — this file is not entitled to tell a team what is critical.
 */
function priorityForGap(gap: CoverageGap): Priority {
  if (gap.subject.kind === 'journey' && gap.subject.priority === 'CRITICAL_PATH') {
    return 'CRITICAL_PATH';
  }
  if (gap.score >= 45) return 'IMPORTANT';
  return 'NICE_TO_HAVE';
}

function routeFeatureName(route: string | null): string | null {
  if (!route) return null;
  const first = route.split('/').filter(Boolean)[0];
  if (!first || first === ':param' || first === '*') return null;
  return first.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
