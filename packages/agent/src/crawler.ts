/**
 * The Explorer's crawl step (§3.1) — deterministic, no LLM.
 *
 * ── WHAT THIS FILE USED TO BE, AND WHY IT WAS REWRITTEN ─────────────────────
 *
 * It was 629 lines in which the traversal, the DOM reading and the Playwright
 * driving were one function. Three consequences, all of them defects:
 *
 *   1. ALMOST NO TESTS. A function that takes a `Page` can only be tested with
 *      a browser, and the unit suite has none — so the admission rules, the
 *      dedupe key, the budget arithmetic and the "stopped early" sentence were
 *      all unexercised, and the demo-only English phrase list in `stateKeyFor`
 *      was never noticed.
 *   2. SILENT TRUNCATION. `maxPages`, `maxDepth`, `slice(0, 20)` and
 *      `journeys.length < 40` discarded candidates with no count and no name.
 *      A truncated crawl makes the coverage percentage go UP, so every one of
 *      those was a lever that quietly flattered us.
 *   3. SURFACE IT COULD NOT SEE AT ALL. `a[href]` only; `target.hash = ''`
 *      before the dedupe, so a hash-routed SPA enumerated as exactly ONE node;
 *      nothing behind a button, a tab, a wizard step or a search submit; no
 *      sitemap; no network inventory; no probe of an error path.
 *
 * So the shape is now: an ORCHESTRATION (`runCrawl`) that is pure over an
 * injected browser surface, and a thin ADAPTER (`playwrightCrawlAdapter`) that
 * is the only place Playwright appears. The orchestration composes the five
 * modules under `crawl/`:
 *
 *   frontier → what to visit, what it is called, what the budget allows, and
 *              what we did not reach (the known-unknown lower bound)
 *   harvest  → everything a document DECLARES without a click: non-anchor
 *              navigation, sitemaps, sub-documents, the off-origin boundary
 *   interact → what is behind a button, a tab, an accordion, a wizard step
 *   observe  → what the pages CALLED, bounced to and errored with
 *   variants → the device / render / locale / fault / data axes
 *
 * Keeping it LLM-free matters. The model's job is to decide what is worth
 * testing; deciding what EXISTS is a graph traversal, and doing it in code
 * makes it cheap, repeatable and diffable version to version.
 */

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import {
  enumerationOutcome,
  externalParts,
  policyDecision,
  statusClassFor,
  type CapBite,
  type EnumerationOutcome,
  type ExcludedPath,
  type ExternalBoundary,
  type ExternalKind,
  type FlowEdge,
  type FlowMap,
  type FlowNode,
  type FormField,
  type FormModel,
  type Frontier,
  type Plan,
  type Selector,
  type SurfaceDimensionValue,
} from '@qaai/shared';

import {
  CrawlFrontier,
  resolveCrawlBudget,
  restoreFrontier,
  refusalSummary,
  scheduleCrawl,
  serialiseFrontier,
  type CrawlLimitOverrides,
  type CrawlStopReason,
  type CrawlVisitor,
  type DiscoverySource,
  type FrontierEntry,
  type FrontierSnapshot,
  type HashRoutingMode,
  type KnownUnknownAccount,
  type OfferedCandidate,
  type ResolvedCrawlBudget,
} from './crawl/frontier.js';
import {
  harvestDocument,
  navigableDiscoveries,
  seedFromRobotsAndSitemaps,
  sitemapReachability,
  sitemapStaleness,
  toCapBites,
  toExcludedPaths,
  mergeBoundaries,
  axisIsConsistent,
  subDocumentCoverage,
  unreadAppSubDocuments,
  HARVEST_ELEMENT_SELECTOR,
  type BoundaryObservation,
  type Discovery,
  type DiscoveryKind,
  type DocumentSnapshot,
  type HarvestCapBite,
  type HarvestFetcher,
  type SameSiteHost,
  type SeedHarvest,
  type UrlTemplate,
} from './crawl/harvest.js';
import {
  detectRouteMode,
  budgetsFeedTheFrontier,
  describeReplay,
  exploreInteractions,
  implicitRole,
  playwrightInteractionSurface,
  stateSignatureOf,
  type InteractionCrawlResult,
  type InteractionSurface,
  type RawSnapshot,
  type RouteMode,
} from './crawl/interact.js';
import {
  classifyInterstitial,
  classifyNavigationFailure,
  classifyProbe,
  CrawlObserver,
  documentSurfaceFor,
  detectStructuralState,
  planErrorProbes,
  reconcileCalledEndpoints,
  recordBounce,
  structuralStateKeyPart,
  observationCaveats,
  parseStoredObservation,
  type BrowserEventSource,
  type InterstitialFinding,
  type ObservationReport,
  type ObservedNavigation,
  type ObserverCapability,
  type PageStructure,
  type ProbeTarget,
} from './crawl/observe.js';
import {
  attributeVariants,
  capabilitiesOf,
  compareSignatures,
  deviceDimensionValue,
  DEVICE_PROFILES,
  missingCapabilities,
  planVariantCrawl,
  variantContext,
  variantSignatureOf,
  variantSurfaceItems,
  type DataProfile,
  type LocaleInput,
  type LocaleMechanism,
  type VariantAttribution,
  type VariantBrowserSurface,
  type VariantCrawlPlan,
  type VariantNode,
  type VariantObservation,
  type VariantOutcome,
  type VariantPageFacts,
  type VariantRequestObservation,
  type VariantSetup,
  BASELINE_DEVICE_KEY,
  VARIANT_CAPABILITIES,
  VARIANT_CAPABILITY_ADAPTER,
  VARIANT_CAPABILITY_LABELS,
} from './crawl/variants.js';
import type { SurfaceItem } from '@qaai/shared';

/** Collapses `/orders/ORD-1001` → `/orders/:id` so states group sensibly. */
export function normaliseRoute(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment))
        return ':id';
      // Mixed alphanumerics with digits: ORD-1001, cus_a1b2, sku12345.
      if (/\d/.test(segment) && /[a-z]/i.test(segment) && segment.length > 3) return ':id';
      return segment;
    })
    .join('/');
}

/**
 * `autocomplete` token → semantic. Checked BEFORE any name/label guessing,
 * because this one is not a guess: the token vocabulary is specified, and a
 * developer who wrote `autocomplete="cc-number"` has told us what the field is.
 * Every other signal in `semanticFor` is inference from a string somebody chose
 * for other reasons.
 */
const AUTOCOMPLETE_SEMANTICS: Record<string, FormField['semantic']> = {
  email: 'email',
  username: 'username',
  'new-password': 'password',
  'current-password': 'password',
  'cc-number': 'credit_card',
  'cc-exp': 'card_expiry',
  'cc-exp-month': 'card_expiry',
  'cc-exp-year': 'card_expiry',
  'cc-csc': 'card_cvc',
  'cc-name': 'person_name',
  tel: 'phone',
  'tel-national': 'phone',
  name: 'person_name',
  'given-name': 'person_name',
  'family-name': 'person_name',
  'additional-name': 'person_name',
  'street-address': 'street_address',
  'address-line1': 'street_address',
  'address-line2': 'street_address',
  'address-level2': 'city',
  'postal-code': 'postal_code',
  country: 'country',
  'country-name': 'country',
  url: 'url',
  bday: 'date',
  'transaction-amount': 'currency',
};

/**
 * Guesses what a field wants so the synthetic factory can fill it sensibly (§2).
 *
 * `autocomplete` is an optional fourth argument rather than a new required one:
 * the signature is exported and this file is not the only possible caller, and
 * a crawl that predates constraint capture still gets the old answer.
 */
export function semanticFor(
  name: string,
  type: string,
  label: string,
  autocomplete?: string | null,
): FormField['semantic'] {
  const declared = (autocomplete ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((token) => AUTOCOMPLETE_SEMANTICS[token])
    .find((semantic): semantic is FormField['semantic'] => semantic !== undefined);
  if (declared) return declared;

  const hay = `${name} ${label} ${type}`.toLowerCase();
  if (type === 'email' || /\bemail\b/.test(hay)) return 'email';
  if (type === 'password' || /\bpassword\b|\bpasswd\b/.test(hay)) return 'password';
  /*
   * Before the generic `\bname\b` rule, which "username" does not match (no
   * word boundary inside the word) — so a username field used to come back as
   * 'freeform' and got a sentence typed into it.
   */
  if (/\busername\b|\buser[-_]?name\b|\bhandle\b|\bnickname\b/.test(hay)) return 'username';
  if (type === 'search' || /\bsearch\b|\bquery\b/.test(hay)) return 'search';
  if (type === 'tel' || /\bphone\b|\btel\b|\bmobile\b/.test(hay)) return 'phone';
  if (/\bcvc\b|\bcvv\b|security ?code/.test(hay)) return 'card_cvc';
  if (/\bexp(iry|iration)?\b/.test(hay)) return 'card_expiry';
  if (/\bcard\b|\bcc[-_]?number\b/.test(hay)) return 'credit_card';
  if (/\bpostal\b|\bzip\b|\bpostcode\b/.test(hay)) return 'postal_code';
  if (/\bcountry\b/.test(hay)) return 'country';
  if (/\bcity\b|\btown\b/.test(hay)) return 'city';
  if (/\baddress\b|\bstreet\b/.test(hay)) return 'street_address';
  if (/\bname\b/.test(hay)) return 'person_name';
  if (type === 'url' || /\bwebsite\b|\burl\b|\bhomepage\b|\blink\b/.test(hay)) return 'url';
  if (type === 'date' || /\bdate\b|\bdob\b/.test(hay)) return 'date';
  /*
   * Money before the generic number rule. A price input wants "19.99" and a
   * quantity input wants "3"; sending two decimal places to a quantity field is
   * harmless, but sending an integer to a price field tests the one code path
   * that never breaks. `amount` stays under 'number' where it has always been —
   * it is as often a count as a sum, and this rule only claims the words that
   * can only mean money.
   */
  if (/\bprice\b|\bcost\b|\bcurrency\b|\bsubtotal\b|\bfee\b/.test(hay)) return 'currency';
  if (type === 'number' || /\bquantity\b|\bqty\b|\bamount\b/.test(hay)) return 'number';
  if (type === 'textarea' || /\bmessage\b|\bcomment\b|\bnotes?\b/.test(hay)) return 'freeform';
  if (type === 'text') return 'freeform';
  return 'unknown';
}

// ─── The two vocabularies the five modules do not share ─────────────────────

/**
 * `harvest`'s discovery kind → `frontier`'s discovery source.
 *
 * THE DISAGREEMENT THIS RESOLVES: harvest classifies 17 ways a document can
 * declare a URL; the frontier records 8 provenances on the persisted entry.
 * Neither is wrong — one is about markup and one is about what a resumed crawl
 * needs to know — but a crawl that mapped them ad hoc at the call site would
 * file a `<form method=get>` under LINK on one branch and FORM_ACTION on
 * another, and the stored frontier would disagree with itself across a resume.
 *
 * A `Record<DiscoveryKind, …>` and not a switch, so a new discovery kind is a
 * BUILD ERROR here rather than a silent `undefined` that serialises into the
 * snapshot. `crawler.test.ts` checks the keys against `DISCOVERY_KINDS` at run
 * time, which the compiler cannot: `satisfies` catches a missing key and only a
 * run-time comparison catches a stale one.
 */
export const DISCOVERY_SOURCE_FOR_KIND = {
  ANCHOR: 'LINK',
  AREA: 'LINK',
  LINK_REL: 'LINK',
  LINK_HEADER: 'LINK',
  ROLE_LINK: 'LINK',
  DATA_ATTRIBUTE: 'LINK',
  BASE: 'LINK',
  GET_FORM: 'FORM_ACTION',
  POST_FORM: 'FORM_ACTION',
  META_REFRESH: 'REDIRECT',
  REDIRECT: 'REDIRECT',
  SITEMAP_URL: 'SITEMAP',
  SITEMAP_INDEX: 'SITEMAP',
  ROBOTS_SITEMAP: 'SITEMAP',
  /*
   * Not navigable, so never offered to the frontier — but the mapping exists so
   * that a future navigable frame or asset cannot arrive here undeclared.
   */
  FRAME: 'LINK',
  ASSET: 'LINK',
  SCRIPT_HOST: 'LINK',
} satisfies Record<DiscoveryKind, DiscoverySource>;

/** The same mapping onto the off-origin ledger's vocabulary. */
export const EXTERNAL_KIND_FOR_DISCOVERY = {
  ANCHOR: 'LINK',
  AREA: 'LINK',
  LINK_REL: 'LINK',
  LINK_HEADER: 'LINK',
  ROLE_LINK: 'LINK',
  DATA_ATTRIBUTE: 'LINK',
  BASE: 'LINK',
  GET_FORM: 'FORM_ACTION',
  POST_FORM: 'FORM_ACTION',
  META_REFRESH: 'REDIRECT',
  REDIRECT: 'REDIRECT',
  SITEMAP_URL: 'LINK',
  SITEMAP_INDEX: 'LINK',
  ROBOTS_SITEMAP: 'LINK',
  FRAME: 'IFRAME',
  ASSET: 'SCRIPT_HOST',
  SCRIPT_HOST: 'SCRIPT_HOST',
} satisfies Record<DiscoveryKind, ExternalKind>;

// ─── The injected browser surface ────────────────────────────────────────────

/** An `a[download]` — a file, not a page. Found by reading markup, not watching. */
export interface DownloadAnchor {
  href: string;
  filename: string | null;
  label: string | null;
}

/** What driving one variant produced. `facts: null` is reported as unmeasured. */
export interface VariantDrive {
  outcome: VariantOutcome;
  facts: VariantPageFacts | null;
  detail: string;
}

/**
 * ONE browser page, as the orchestration needs it.
 *
 * Every method returns DATA — a snapshot, a structure, a navigation outcome —
 * and never a live handle, which is what lets `runCrawl` be driven by a literal
 * in `crawler.test.ts`. The three-state convention applies throughout: a `null`
 * means the read ran and found nothing, and a method that is absent from the
 * adapter's capability declaration means nobody looked. Neither is ever a zero.
 */
export interface CrawlPage {
  /** Navigates. NEVER throws — a failure is a value, with `failure` set. */
  goto(url: string): Promise<ObservedNavigation>;
  currentUrl(): string;
  title(): Promise<string>;
  /** The harvest input: one `evaluate` worth of facts about the document. */
  documentSnapshot(): Promise<DocumentSnapshot>;
  /**
   * The observe input. NULL when the read could not run — never a zeroed
   * object, because `detectStructuralState(null)` is UNKNOWN and a zeroed
   * object is a measurement.
   */
  pageStructure(): Promise<PageStructure | null>;
  /** The state-signature input, so the URL pass and the interaction pass share one id space. */
  rawSnapshot(): Promise<RawSnapshot | null>;
  forms(): Promise<FormModel[]>;
  affordances(limit: number): Promise<FlowNode['affordances']>;
  downloadAnchors(): Promise<DownloadAnchor[]>;
}

/** One open browser, with its pages, its event source and its variant surface. */
export interface CrawlBrowser {
  /** One page per worker slot, 0-based and stable for the whole crawl. */
  readonly pages: readonly CrawlPage[];
  /**
   * The network/console event source, or NULL when this adapter cannot listen.
   * Null makes every observation capability UNAVAILABLE, which is the honest
   * answer; it is never "the application made no calls".
   */
  readonly events: BrowserEventSource | null;
  readonly observerCapabilities: Partial<Record<ObserverCapability, boolean | string>>;
  /** The interaction pass's surface, or null when it cannot be driven here. */
  readonly interaction: InteractionSurface | null;
  readonly variants: VariantBrowserSurface;
  /** Drives one planned variant against one URL and reads the facts back. */
  driveVariant(setup: VariantSetup, url: string): Promise<VariantDrive>;
  close(): Promise<void>;
}

export interface CrawlOpenInput {
  baseUrl: string;
  /** How many pages to open. `frontier.limits.workers`, after the plan ceiling. */
  workers: number;
  storageState?: unknown;
}

/**
 * The browser, injected. `playwrightCrawlAdapter` is the only implementation
 * that touches a real one; `crawler.test.ts` supplies a fake page graph.
 */
export interface CrawlAdapter {
  open(input: CrawlOpenInput): Promise<CrawlBrowser>;
  /**
   * The text fetcher for robots.txt and sitemaps. NULL means the seeding axis
   * reports UNAVAILABLE rather than "this site publishes no sitemap".
   */
  readonly fetcher: HarvestFetcher | null;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface CrawlOptions {
  baseUrl: string;
  projectId: string;
  environmentId: string;
  version: number;

  /*
   * ── The legacy caps ──────────────────────────────────────────────────────
   *
   * OPTIONAL now, and honoured exactly as before when passed, because `crawl`
   * is a shipped function and a behaviour change for an existing caller is a
   * regression rather than a refactor. A caller that passes `maxPages: 25` gets
   * a 25-page crawl AND a `PAGE_BUDGET` clamp reported in `policyApplied`, so
   * the number is now visible instead of being a constant nobody chose.
   *
   * Omit them and the environment's own `crawlPolicy` decides, clamped by the
   * plan ceiling — which is the point of the slice: a hard-coded 25 is why
   * "100% covered" means "100% of at most 25 states".
   */
  maxPages?: number;
  maxDepth?: number;
  maxMillis?: number;

  /** Playwright storageState, when an auth profile applies (§2). */
  storageState?: unknown;
  /** The role that storageState belongs to, for the access matrix. */
  role?: string | null;

  /**
   * DEPRECATED. Kept because the signature is public; no caller in this repo
   * passes it. A pattern supplied here is honoured and REPORTED in the
   * exclusion ledger — the old behaviour dropped the URL with no record, which
   * made a refused route and a route the application does not serve
   * indistinguishable afterwards. New callers use `CrawlPolicy.excludeGlobs`,
   * which the customer can see and override.
   */
  excludePatterns?: RegExp[];

  /** `Environment.crawlPolicy`, raw from the JSONB column. */
  crawlPolicy?: unknown;
  /** The org's plan, for `PLAN_CRAWL_CEILINGS`. Defaults to TEAM. */
  plan?: Plan;
  /** The limits that are not policy fields: workers, links per page, … */
  limitOverrides?: CrawlLimitOverrides;
  hashRouting?: HashRoutingMode;
  /** A persisted frontier to continue. The whole point of the snapshot. */
  resumeFrom?: FrontierSnapshot | null;

  /** Locales the source analysis declared, for the LOCALE variant axis. */
  locales?: readonly LocaleInput[];
  localeMechanism?: LocaleMechanism;
  /** Data profiles the environment declared, for the DATA variant axis. */
  dataProfiles?: readonly DataProfile[];

  /** Inject a different browser. Defaults to `playwrightCrawlAdapter`. */
  adapter?: CrawlAdapter;
  onProgress?: (message: string) => void;
}

/**
 * Everything one crawl produced, not just the graph.
 *
 * `crawl()` still returns the `FlowMap` alone so every existing caller keeps
 * compiling; the processor uses `crawlApp()` and gets this, because four of
 * these fields have no home on a `FlowMap` and dropping them is how the
 * accounting stops existing the moment the function returns.
 */
export interface CrawlOutcome {
  flowMap: FlowMap;
  /** The persistable frontier. Pass it back as `resumeFrom` to continue. */
  snapshot: FrontierSnapshot;
  account: KnownUnknownAccount;
  budget: ResolvedCrawlBudget;
  observation: ObservationReport;
  interstitial: InterstitialFinding | null;
  stoppedBecause: CrawlStopReason;
  outcome: EnumerationOutcome;
  /**
   * How this application expresses its routes, as DETECTED from the URLs
   * visited.
   *
   * It must be PERSISTED, and this field is why: a re-crawl that decides a
   * different mode re-keys every state, every node id shifts, and the
   * version-to-version diff — a shipped feature — shows the whole graph as
   * rewritten when nothing about the application changed.
   */
  routeMode: RouteMode;
  routeModeWhy: string;
  /** The saturation curve: new nodes per page visited, oldest first. */
  saturation: Array<{ visited: number; nodes: number }>;
  variantPlan: VariantCrawlPlan;
  variantAttribution: VariantAttribution;
  /** New surface the variant pass found, ready for the coverage store. */
  variantSurface: SurfaceItem[];
  /** The DEVICE dimension rows this crawl was driven with. */
  dimensions: SurfaceDimensionValue[];
  /** URL shapes whose instances were NOT enumerated: `/search?q=`. */
  templates: UrlTemplate[];
  /** Same-site hosts named and not measured — the only place they are reported. */
  sameSiteHosts: SameSiteHost[];
  /** Counts only observation and the visitor can see, for `adjudicateCrawl`. */
  degradationCounts: {
    errorNodeCount: number;
    loadFailureCount: number;
    throttledCount: number;
    tlsFailureCount: number;
    authWallBounces: number;
  };
  /** Sitemap URLs the site advertised. `unreachable` is a DEFECT in the app. */
  sitemap: {
    declared: number;
    unreachable: number;
    unchecked: number;
    refused: number;
    undated: number;
    stale: number;
  } | null;
  /** App surface behind a closed shadow root or an unread frame. */
  unreadSubDocuments: number;
  /**
   * Every reason the numbers above are a FLOOR: a cap that bit, a capability
   * nobody had, a resume whose rules changed, a budget the plan clamped. The
   * processor prints these beside anything it quotes.
   */
  caveats: string[];
}

/** What one visit produced. `node: null` for a URL that was a FILE, not a page. */
interface VisitValue {
  node: FlowNode | null;
  /** The identity the frontier queued, for the edge map. */
  identity: string;
  /** The state key the node graph dedupes on: `${route}#${digest}`. */
  stateId: string | null;
  discoveries: Discovery[];
}

// ─── The orchestration ──────────────────────────────────────────────────────

const PROGRESS_NOOP = (): void => {};

/**
 * Runs one crawl against an injected browser.
 *
 * The call order below is load-bearing in four places and each one is a defect
 * if it moves:
 *
 *   • `observer.focus` goes BEFORE `page.goto`, on the REQUESTED route. Focus
 *     after the navigation and the first page's network lands in
 *     `unattributedEvents`; focus on the FINAL route and the network inventory
 *     inherits the same bounce defect as the node graph.
 *   • `frontier.noteCap` for every cap the frontier cannot see goes BEFORE
 *     `frontier.account()`, or the cap ledger is short and `enumerationOutcome`
 *     calls a trimmed crawl CONVERGED.
 *   • `frontier.account()` goes after the schedule resolves, or the lower bound
 *     misses the last page's links.
 *   • `classifyInterstitial` goes AFTER the loop, because `nodeCount` is one of
 *     its signals and a one-node crawl is the signal that catches a bot wall no
 *     phrase list has ever heard of.
 */
export async function runCrawl(
  adapter: CrawlAdapter,
  options: CrawlOptions,
): Promise<CrawlOutcome> {
  const progress = options.onProgress ?? PROGRESS_NOOP;
  const caveats: string[] = [];

  // ── 1. The budget ──
  //
  // A caller-supplied `maxPages`/`maxDepth`/`maxMillis` is folded into the
  // STORED POLICY rather than applied behind it, so it travels through
  // `resolveCrawlPolicy`'s per-field type checking and comes out named in
  // `policyApplied.overridden`. The old code applied it as a bare `>=` with no
  // record anywhere.
  const storedPolicy = withLegacyCaps(options.crawlPolicy, options);
  const budget = resolveCrawlBudget({
    storedPolicy,
    plan: options.plan ?? 'TEAM',
    /*
     * ── THE ONE PLACE PARALLELISM IS TRADED AWAY, AND WHY ───────────────────
     *
     * `CrawlObserver.focus` is a SINGLE attribution block: the network a page
     * fires belongs to the node that was focused when the request went out.
     * With several workers navigating at once those blocks interleave, and a
     * call fired by one page is attributed to another — so the "called from"
     * list in the CALLED_BUT_NEVER_DECLARED finding names the wrong route,
     * which is the kind of wrong a customer notices immediately and never
     * forgets. The inventory wins and the URL pass runs on one page.
     *
     * Forced HERE rather than in the scheduler because `frontier.limits.workers`
     * is what `scheduleCrawl` opens slots from, and a limit of 4 with one page
     * would have four visits sharing one browser tab. It is reported as a
     * caveat below, because a crawl four times slower than its budget allows is
     * a fact about us, not about the application.
     */
    overrides: { ...options.limitOverrides, workers: 1 },
  });
  const policy = budget.policy.policy;
  for (const clamp of budget.clamped) caveats.push(clamp.why);
  for (const rejected of budget.rejected) {
    caveats.push(`the ${rejected.field} override was ignored: ${rejected.why}`);
  }
  for (const key of budget.policy.unknownKeys) {
    caveats.push(`the stored crawl policy has a key this build does not know: ${key}`);
  }

  // ── 2. The frontier, continued or fresh ──
  const frontierOptions = {
    baseUrl: options.baseUrl,
    budget,
    ...(options.hashRouting ? { hashRouting: options.hashRouting } : {}),
  };
  const restored = options.resumeFrom
    ? restoreFrontier(options.resumeFrom, frontierOptions)
    : { frontier: new CrawlFrontier(frontierOptions), warnings: [] as string[] };
  const frontier = restored.frontier;
  // These are the "this resume may enumerate pages twice" sentences. They are
  // warnings and not refusals because resuming under a BIGGER budget is the
  // whole point of a persisted frontier; a caller that ignores them gets a
  // double-counted denominator and this is where it was told.
  caveats.push(...restored.warnings);
  if (options.resumeFrom) {
    progress(`Continuing a previous crawl: ${frontier.pendingCount} URL(s) still queued`);
  }

  // Legacy RegExp excludes, honoured and LEDGERED rather than dropped silently.
  const legacyExcluded: ExcludedPath[] = [];
  const legacyPatterns = options.excludePatterns ?? [];

  const allowedWorkers = options.limitOverrides?.workers ?? DEFAULT_WORKER_ALLOWANCE;
  if (allowedWorkers > 1) {
    caveats.push(
      `the crawl ran on one page although the budget allows ${allowedWorkers}: network ` +
        `attribution is per-navigation and parallel navigations interleave it, so a parallel ` +
        `crawl would name the wrong route as the caller of an endpoint`,
    );
  }
  const browser = await adapter.open({
    baseUrl: options.baseUrl,
    workers: budget.limits.workers,
    ...(options.storageState !== undefined ? { storageState: options.storageState } : {}),
  });

  const observer = new CrawlObserver({
    baseUrl: options.baseUrl,
    policy,
    normaliseRoute,
    capabilities: browser.observerCapabilities,
  });
  const detach = browser.events ? observer.attach(browser.events) : PROGRESS_NOOP;

  const harvestExcluded: ExcludedPath[] = [];
  const harvestCaps: HarvestCapBite[] = [];
  const boundaries: BoundaryObservation[] = [];
  const templates: UrlTemplate[] = [];
  /*
   * identity → the URL to NAVIGATE to.
   *
   * THE DISAGREEMENT THIS RESOLVES, and it is a real defect in the frontier:
   * `CanonicalUrl.url` is the IDENTITY, with its query parameters SORTED, and
   * that is what `frontier.offer` queues. Navigating to it visits a parameter
   * ordering the application never linked. `harvest` splits the two — its
   * `url` keeps the original order and its `identity` is sorted — so the crawl
   * keeps harvest's navigate-URL beside the frontier's identity and navigates
   * to the one the markup actually wrote. The proper fix is a `navigateUrl`
   * field on `CanonicalUrl`; it is requested, and this map is what stands in
   * until it lands.
   */
  const navigateUrls = new Map<string, string>();
  /*
   * Distinct URLs harvest refused or placed off-origin BEFORE the frontier ever
   * saw them.
   *
   * `frontier.offer` is the only admission decision for everything it is
   * OFFERED — but harvest decides scope and policy first, with a better rule
   * sentence than the frontier can produce for a `<base href>` or a robots
   * line, and an unadmitted discovery is never offered. Without these two sets
   * the stored `Frontier.excluded` and `.offOrigin` read as 0 while the
   * exclusion ledger and the boundary inventory are full, which is the "a
   * refused surface recorded the same way as one that does not exist" defect
   * arriving through the accounting rather than through the ledger.
   */
  const offOriginUrls = new Set<string>();
  let unreadSubDocuments = 0;
  let sameSiteHosts: SameSiteHost[] = [];

  let errorNodeCount = 0;
  let throttledCount = 0;
  let tlsFailureCount = 0;
  let unclassifiedNavigations = 0;
  let downloadNavigations = 0;

  let seed: SeedHarvest | null = null;
  let entryStructure: PageStructure | null = null;
  let entryStatus: number | null = null;
  let entryHeaders: Record<string, string> | undefined;

  const seenStates = new Map<string, string>(); // `${route}#${digest}` → nodeId
  const saturation: Array<{ visited: number; nodes: number }> = [];

  try {
    // ── 3. Seed from robots.txt and the sitemaps ──
    //
    // The cheapest complete route list in existence, and nothing read it
    // before: a 412-route application whose crawl reaches 60 pages has 352
    // routes sitting in a file at a known URL.
    if (adapter.fetcher) {
      seed = await seedFromRobotsAndSitemaps({
        baseUrl: options.baseUrl,
        policy,
        fetcher: adapter.fetcher,
        normaliseRoute,
      });
      harvestCaps.push(...seed.caps);
      harvestExcluded.push(...toExcludedPaths(seed.discoveries, { normaliseRoute }));
      boundaries.push(...seed.boundaries);
      for (const discovery of seed.discoveries) {
        if (discovery.navigable && discovery.scope !== 'SAME_ORIGIN') {
          offOriginUrls.add(discovery.identity);
        }
      }
      if (seed.availability.sitemaps.state === 'UNAVAILABLE') {
        caveats.push(`the sitemap axis was not measured: ${seed.availability.sitemaps.reason}`);
      }
      if (seed.availability.robots.state === 'UNAVAILABLE') {
        caveats.push(`robots.txt was not read: ${seed.availability.robots.reason}`);
      }
      const seeded = seed.discoveries.filter(
        (discovery) => discovery.admitted && discovery.navigable,
      );
      for (const discovery of seeded) offerDiscovery(frontier, discovery, null, navigateUrls);
      progress(`Seeded ${seeded.length} URL(s) from robots.txt and the sitemaps`);
    } else {
      caveats.push(
        'robots.txt and the sitemaps were not read: this crawl adapter has no text fetcher, ' +
          'which is not a statement that the application publishes none',
      );
    }

    // The seed is offered BEFORE the base URL so a sitemap's routes are at
    // depth 0 beside it rather than one level below the home page's links.
    if (!options.resumeFrom) frontier.seed(options.baseUrl);

    /*
     * ── THE ROUTE MODE, RE-EVALUATED AS THE SAMPLE GROWS ──────────────────────
     *
     * A route mode decided from ONE URL is unfalsifiable in both directions:
     * one `/#/orders` looks hash-routed and might be a deep link into a
     * path-routed app, and one `/orders` says nothing about whether `#/` is
     * used elsewhere. So it starts UNDETERMINED — a real answer — and is
     * recomputed from the visited set while the sample is still small, which
     * is the only point at which recomputing can change a later state key.
     *
     * I wrote this as a single assignment AFTER the schedule first, and it was
     * dead code: the mode was detected and discarded, so every state signature
     * was keyed as UNDETERMINED and a HASH-mode application's bare `#section`
     * fragments were never considered. The detection has to run DURING the
     * crawl or it has no reader.
     */
    let routeModeSoFar: RouteMode = 'UNDETERMINED';
    let routeModeWhy = 'no URL had been visited when the mode was first needed';
    const ROUTE_MODE_SAMPLE = 10;

    // ── 4. The visitor: the only place a browser is touched per entry ──
    const visit: CrawlVisitor<VisitValue> = async (entry, ctx) => {
      const page = browser.pages[ctx.worker] ?? browser.pages[0];
      if (!page) return { kind: 'ABORT', reason: 'the adapter opened no page' };

      // Focused on the REQUESTED route, before the navigation.
      observer.focus({ route: entry.template, interaction: 'load' });
      progress(`Visiting ${entry.url}`);

      const nav = await page.goto(navigateUrls.get(entry.url) ?? entry.url);

      if (nav.failure) {
        const failure = classifyNavigationFailure(nav.failure, observer.downloadsInFocus());
        if (failure.kind === 'DOWNLOAD') {
          /*
           * The branch that currently swallows every CSV, PDF and XLSX export:
           * `catch { could not load; continue }`. A download is a surface that
           * EXISTS, so it must not be counted as unreachable — `unreachable`
           * means "failed to load, unknown whether it exists", and this loaded.
           * The download event has already produced the `DocumentSurface`; the
           * entry yields a value with no node, because a file is not a page.
           */
          downloadNavigations += 1;
          progress(`  ${entry.url} is a file, not a page — recorded as a document surface`);
          return {
            kind: 'VISITED',
            value: { node: null, identity: entry.url, stateId: null, discoveries: [] },
            finalRoutePath: null,
          };
        }
        if (failure.kind === 'TLS') {
          tlsFailureCount += 1;
          return { kind: 'UNREACHABLE', reason: failure.why };
        }
        if (failure.kind === 'UNCLASSIFIED') unclassifiedNavigations += 1;
        return { kind: 'UNREACHABLE', reason: failure.why };
      }

      if (nav.status !== null && nav.status >= 400) errorNodeCount += 1;
      if (nav.status === 429 || nav.status === 503) throttledCount += 1;

      // ── The bounce ledger ──
      //
      // THE HEADLINE DEFECT IT FIXES: the old code stored the node under
      // `page.url()`, so /admin/billing → /login enumerated /login and
      // /admin/billing appeared NOWHERE. The node is now recorded under the
      // route that was ASKED FOR, carrying the access cell that says where it
      // actually went.
      const bounce = recordBounce(nav, {
        baseUrl: options.baseUrl,
        policy,
        normaliseRoute,
        role: options.role ?? null,
        observedAtIso: new Date().toISOString(),
      });
      observer.addBounce(bounce.record, bounce.cap);

      const structure = await page.pageStructure();
      const structural = detectStructuralState(structure);
      if (entryStructure === null && saturation.length === 0) {
        entryStructure = structure;
        entryStatus = nav.status;
        if (nav.responseHeaders) entryHeaders = nav.responseHeaders;
      }

      /*
       * Recomputed while the sample is small and then left alone: changing the
       * mode late would re-key states the crawl has already recorded, and a
       * node id that shifts between halves of one crawl is worse than a mode
       * decided from ten pages.
       */
      const seen = frontier.visitedUrls();
      if (seen.length <= ROUTE_MODE_SAMPLE) {
        const detected = detectRouteMode([...seen, nav.finalUrl]);
        routeModeSoFar = detected.mode;
        routeModeWhy = detected.why;
      }

      const raw = await page.rawSnapshot();
      const signature =
        raw === null ? null : stateSignatureOf(raw, routeModeSoFar, policy, PRIMITIVES);
      const digest = signature?.digest ?? structuralStateKeyPart(structural);
      /*
       * THE ROUTE, and why it is not `bounce.record.requestedRoute`.
       *
       * The bounce ledger derives its route from a PATHNAME, and a pathname
       * cannot carry a hash route: `/#/orders` has the pathname `/`, so three
       * SPA routes would come back as three nodes all called `/` — the
       * hash-routed defect surviving one level down from the one it was fixed
       * at. The frontier's `routePath` keeps the `#` segment, so the route is
       * taken from the REQUESTED url's canonical routePath and then collapsed
       * by `normaliseRoute`, which keeps today's `/orders/:id` behaviour for
       * everything that is not a hash route. `requestedRoute` is still what the
       * access cell carries, because that is the ledger's own vocabulary.
       */
      const requested = frontier.canonicalise(entry.url);
      const route = requested.ok
        ? normaliseRoute(requested.canonical.routePath)
        : bounce.record.requestedRoute;
      const stateKey = `${structuralStateKeyPart(structural)}/${digest}`;
      const stateId = `${route}#${digest}`;

      let node: FlowNode | null = null;
      const existing = seenStates.get(stateId);
      if (existing === undefined) {
        node = {
          id: '',
          route,
          url: nav.finalUrl,
          title: await page.title(),
          stateKey,
          requiresRoles: [],
          behindAuth: bounce.record.kind === 'AUTH_WALL',
          forms: await page.forms(),
          affordances: await page.affordances(frontier.limits.affordancesPerPage),
          screenshotKey: null,
          /*
           * A ZERO THAT IS NOT A MEASUREMENT, and the only one in this file.
           * `FlowNode.a11yViolationCount` is a required `number`, axe does not
           * run in this pass, and there is nothing else to write. It is
           * inherited from the model rather than introduced here; the one-line
           * fix (`number | null`) is in the report.
           */
          a11yViolationCount: 0,
          status: {
            code: nav.status,
            class: statusClassFor(nav.status),
            // The soft-404 half: a 200 that renders `role=alert` is the case
            // that fools everything, and `shouldGenerateAgainst` refuses both
            // it and a node whose status was never recorded.
            isErrorPage: structural.state === 'ERROR',
          },
          access: [bounce.record.access],
        };
      }

      // ── Harvest: everything the document declares, without a click ──
      const snapshot = await page.documentSnapshot();
      const harvest = harvestDocument(snapshot, {
        baseUrl: options.baseUrl,
        policy,
        fromRoute: route,
        normaliseRoute,
        linksPerDocument: frontier.limits.linksPerPage,
        ...(seed ? { robots: seed.robots } : {}),
      });
      harvestCaps.push(...harvest.caps);
      harvestExcluded.push(...toExcludedPaths(harvest.discoveries, { normaliseRoute }));
      boundaries.push(...harvest.boundaries);
      templates.push(...harvest.templates);
      for (const discovery of harvest.discoveries) {
        if (!discovery.navigable) continue;
        if (discovery.scope === 'OFF_ORIGIN' || discovery.scope === 'SAME_SITE') {
          offOriginUrls.add(discovery.identity);
        }
      }
      /*
       * `found === null` EXACTLY when the axis is UNAVAILABLE. Asserted rather
       * than assumed: an axis reporting MEASURED with a null count, or
       * UNAVAILABLE with a number, is this slice's central lie arriving through
       * the availability layer itself, and it is cheaper to catch here than to
       * read in a report.
       */
      for (const [axis, state] of Object.entries(harvest.availability)) {
        if (axisIsConsistent(state)) continue;
        caveats.push(
          `the ${axis} harvest axis reported ${state.state} with a count of ` +
            `${String(state.found)}, which is inconsistent — treat that axis as unmeasured`,
        );
      }
      const subDocuments = subDocumentCoverage(harvest.subDocuments);
      const unread = unreadAppSubDocuments(harvest.subDocuments);
      unreadSubDocuments += subDocuments.unreadAppSurface;
      if (unread.length > 0) {
        /*
         * NAMED, not just counted. A cross-origin frame is NOT in this list —
         * it is a boundary, not our surface — so every entry here is a piece of
         * the customer's own application we could not look inside, and the path
         * is what tells them which component to open up.
         */
        caveats.push(
          `${unread.length} sub-document(s) of ${route} are this application's own surface and ` +
            `could not be read (${unread
              .slice(0, 3)
              .map((entry) => `${entry.path}: ${entry.unavailable ?? 'unknown'}`)
              .join(', ')}) — that is unmeasured surface, not absent surface`,
        );
      }
      if (harvest.baseHrefIsOffOrigin) {
        caveats.push(
          `${route} declares a <base href> on another origin, so every relative URL in that ` +
            `document belongs to somebody else — nothing from it was followed`,
        );
      }

      // Download anchors: a file found by reading markup rather than by watching.
      for (const anchor of await page.downloadAnchors()) {
        observer.addDocument(
          documentSurfaceFor({
            trigger: 'ANCHOR_DOWNLOAD',
            url: anchor.href,
            method: 'GET',
            filename: anchor.filename,
            contentType: null,
            fromRoute: route,
            interaction: anchor.label ? `click "${anchor.label}"` : `open ${anchor.href}`,
            policy,
            normaliseRoute,
          }),
        );
      }

      const taken = observer.take();
      if (taken.calls.length > 0) {
        progress(`  ${route} called ${taken.calls.length} endpoint(s)`);
      }

      const landed = frontier.canonicalise(page.currentUrl());
      const discovered = admissibleCandidates(harvest, legacyPatterns, legacyExcluded, route);
      for (const discovery of navigableDiscoveries(harvest)) {
        if (!discovery.admitted) continue;
        // Harvest's `url` keeps the ORIGINAL query order and is what the markup
        // actually linked; the frontier's identity sorts it. Keyed on the
        // identity the frontier will queue, so the visit navigates to the one
        // the application wrote. See the `navigateUrls` note above.
        navigateUrls.set(normaliseHashbang(discovery.identity), discovery.url);
      }
      /*
       * The destination of a bounce is OFFERED BACK, so /login gets a node of
       * its own when it is a real route. Without this the sign-in page is a
       * destination nothing enumerates — which is exactly the inverse of the
       * defect above.
       */
      if (bounce.record.kind !== 'NONE' && !bounce.record.originChanged) {
        discovered.push({ url: nav.finalUrl, via: 'REDIRECT', referenceKind: 'REDIRECT' });
      }

      return {
        kind: 'VISITED',
        value: { node, identity: entry.url, stateId, discoveries: harvest.discoveries },
        // REQUIRED: it is what charges a redirect's template budget to the page
        // that was actually served, instead of spending `/orders/:id`'s budget
        // on visits that all saw the sign-in page.
        finalRoutePath: landed.ok ? landed.canonical.routePath : null,
        discovered,
      };
    };

    // ── 5. The schedule ──
    const schedule = await scheduleCrawl<VisitValue>({
      frontier,
      visit,
      perOriginLimit: Math.min(browser.pages.length, 4),
      onProgress: progress,
    });

    // ── 6. Node ids, in the schedule's order and nowhere else ──
    //
    // `schedule.results` is BFS order (depth, then discovery path), which is
    // deterministic however the work was scheduled. Assigning ids anywhere else
    // — inside the visitor, or after a re-sort — makes every `node-N` shift
    // between runs and the version diff shows the whole graph as rewritten.
    const nodes: FlowNode[] = [];
    const nodeIdByIdentity = new Map<string, string>();
    for (const result of schedule.results) {
      const { node, stateId, identity } = result.value;
      if (stateId === null) continue; // a file, not a page
      const already = seenStates.get(stateId);
      if (already !== undefined) {
        nodeIdByIdentity.set(identity, already);
        continue;
      }
      if (node === null) continue;
      const id = `node-${nodes.length}`;
      node.id = id;
      seenStates.set(stateId, id);
      nodeIdByIdentity.set(identity, id);
      nodes.push(node);
      saturation.push({ visited: saturation.length + 1, nodes: nodes.length });
    }

    const edges: FlowEdge[] = [];
    for (const result of schedule.results) {
      const parent = result.entry.discoveredFrom;
      if (parent === null) continue;
      const from = nodeIdByIdentity.get(parent);
      const to = nodeIdByIdentity.get(result.value.identity);
      if (from === undefined || to === undefined || from === to) continue;
      edges.push({
        id: `edge-${edges.length}`,
        from,
        to,
        action: edgeActionFor(result.entry, result.value),
        selector: null,
      });
    }

    // ── 7. The interaction pass: what is behind a button ──
    let interaction: InteractionCrawlResult | null = null;
    if (browser.interaction && nodes.length > 0) {
      progress(`Exploring the controls on ${nodes.length} page(s)`);
      interaction = await exploreInteractions(browser.interaction, {
        baseUrl: options.baseUrl,
        entryUrls: nodes.map((node) => node.url),
        policy,
        primitives: PRIMITIVES,
        // ONE node-id space: the URL pass keys `seenStates` on
        // `${signature.route}#${digest}` and so does this, so a state the URL
        // crawl already reached is the same node rather than a second one.
        nodeIdFor: (signature) => seenStates.get(`${signature.route}#${signature.digest}`) ?? null,
        onProgress: progress,
      });
      for (const gap of interaction.unavailable) {
        caveats.push(`${gap.capability} is unavailable: ${gap.cost}`);
      }
      mergeInteraction(nodes, edges, interaction);
      if (interaction.outcome !== 'CONVERGED') caveats.push(interaction.why);
      /*
       * The invariant that keeps "converged" honest on the interaction side:
       * every budget bite must have fed its `discarded` count into the
       * frontier's `unvisitedQueued`, or a pass that stopped early reports as
       * complete. The module exports the predicate precisely so a caller cannot
       * ignore it; a caller that did would get an inflated convergence, so it
       * is checked here and reported rather than trusted.
       */
      if (!budgetsFeedTheFrontier(interaction)) {
        caveats.push(
          'the interaction pass reported a budget bite its frontier does not account for, so ' +
            'its convergence claim cannot be relied on — treat the control surface as unmeasured',
        );
      }
      for (const node of interaction.nodes) {
        // The replay path is the artefact the Generator needs in order to write
        // a test that REACHES a state behind a button. Printed so an operator
        // can see that the crawl learned a reachable path and not just a node.
        if (node.replay.steps.length > 1) progress(`  ${describeReplay(node.replay)}`);
      }
      for (const budgetBite of interaction.budgets) {
        if (budgetBite.bites > 0) caveats.push(budgetBite.reason);
      }
    } else if (!browser.interaction) {
      caveats.push(
        'nothing behind a button, a tab, an accordion or a wizard step was enumerated: this ' +
          'crawl adapter has no interaction surface. That is not a statement that the ' +
          'application has no such states.',
      );
    }

    // ── 8. Error-path probes ──
    const probePlan = planErrorProbes({
      targets: probeTargetsFrom(nodes, interaction),
      policy,
      policyDecision,
    });
    observer.mergeCaps(probePlan.caps);
    const probePage = browser.pages[0];
    if (probePage) {
      for (const probe of probePlan.probes) {
        observer.focus({ route: probe.template, interaction: `probe ${probe.kind}` });
        const nav = await probePage.goto(probe.url);
        const structure = await probePage.pageStructure();
        observer.addProbe(classifyProbe(probe, nav, structure));
      }
      if (probePlan.probes.length > 0) {
        progress(`Probed ${probePlan.probes.length} error path(s)`);
      }
    }

    // ── 9. The interstitial verdict, which NEEDS the finished node count ──
    const interstitial = classifyInterstitial({
      structure: entryStructure,
      status: entryStatus,
      ...(entryHeaders ? { responseHeaders: entryHeaders } : {}),
      nodeCount: nodes.length,
      distinctTitles: new Set(nodes.map((node) => node.title)).size,
      requestedUrlCount: frontier.visitedCount,
    });
    observer.setInterstitial(interstitial);

    // ── 10. The caps the frontier cannot see ──
    //
    // Each one was a bare `slice()` or `<` with no name and no count. Called
    // BEFORE `frontier.account()`, so the ledger is complete when the lower
    // bound is computed.
    const { capBites, unexpressible } = toCapBites(harvestCaps);
    for (const bite of capBites) frontier.noteCap(bite);
    for (const bite of unexpressible) {
      // `CRAWL_CAPS` has no member for a sitemap or sub-document budget, so
      // filing it under PAGE_BUDGET would be a number in a field readers
      // interpret as something else. It becomes a caveat sentence instead,
      // and the six members that would empty this list are requested.
      if (bite.bites > 0) caveats.push(bite.reason);
    }
    if (interaction) for (const bite of interaction.caps) frontier.noteCap(bite);
    const journeys = deriveJourneys(nodes, edges, frontier.limits.journeyLimit, (bite) => {
      frontier.noteCap(bite);
    });

    // ── 11. The variant axes ──
    const variantNodes: VariantNode[] = nodes.map((node) => ({
      id: node.id,
      route: node.route,
      stateKey: node.stateKey,
      forms: node.forms.length,
      // NULL and not 0 when the affordance read did not run: "nobody counted"
      // is not evidence that a page is empty, and this number decides which
      // pages the variant pass measures at all.
      affordances: node.affordances.length > 0 ? node.affordances.length : null,
    }));
    const available = capabilitiesOf(browser.variants);
    const ctx = variantContext({
      nodes: variantNodes,
      policy,
      available,
      ownOrigins: [new URL(options.baseUrl).origin, ...policy.additionalOrigins],
    });
    const observation = observer.report();
    const variantPlan = planVariantCrawl(ctx, {
      locales: {
        locales: options.locales ?? [],
        ...(options.localeMechanism ? { mechanism: options.localeMechanism } : {}),
        baseUrl: options.baseUrl,
      },
      faults: { requests: faultRequestsFrom(observation, options.baseUrl) },
      data: { profiles: options.dataProfiles ?? [] },
    });
    for (const bite of variantPlan.caps) frontier.noteCap(bite);
    for (const axis of variantPlan.emptyAxes) {
      caveats.push(`the ${axis.axis} variant axis enumerated nothing: ${axis.why}`);
    }
    for (const gap of missingCapabilities(VARIANT_CAPABILITIES, available)) {
      // UNAVAILABLE, never PASS and never 0. A zoom axis nothing can drive is
      // not a zoom axis that works.
      caveats.push(
        `the variant pass cannot ${VARIANT_CAPABILITY_LABELS[gap]} (${VARIANT_CAPABILITY_ADAPTER[gap]}), ` +
          `so every variant needing it is reported UNAVAILABLE rather than passing`,
      );
    }

    const { baseline, observations } = await driveVariants(browser, variantPlan, nodes, progress);
    const variantAttribution = attributeVariants({
      plan: variantPlan.variants,
      baseline,
      observations,
    });
    const variantSurface = variantSurfaceItems(variantAttribution, {
      environmentId: options.environmentId,
    });
    if (variantAttribution.unattributable.length > 0) {
      caveats.push(
        `${variantAttribution.unattributable.length} variant(s) could not be attributed because ` +
          `their baseline was never measured — reported as unmeasured, never as "no difference"`,
      );
    }

    // ── 12. The account. After the schedule AND after every noteCap. ──
    const account = frontier.account();
    const excluded = dedupeExcluded([
      ...account.excluded,
      ...harvestExcluded,
      ...legacyExcluded,
      ...probePlan.refused,
      ...(interaction ? interaction.excluded : []),
      ...variantPlan.refusedBases.map((refusal) => ({
        url: nodes.find((node) => node.id === refusal.nodeId)?.url ?? refusal.base,
        route: refusal.base,
        kind: refusal.kind,
        rule: refusal.rule,
        discoveredFrom: null,
      })),
    ]);

    /*
     * `excluded` is the COUNT OF DISTINCT REFUSED URLS, read off the ledger
     * that is about to be stored rather than from the frontier alone — one
     * `/logout` linked from fifty pages is one refusal, and "your crawl policy
     * refused 31 URLs" is the number a customer wants. `atLeastMoreUrls` is
     * untouched by both: a refused URL is known BY NAME and is therefore not
     * part of "more existed", which is what `frontierSchema` enforces.
     */
    const frontierForMap: Frontier = {
      ...account.frontier,
      excluded: Math.max(account.frontier.excluded, excluded.length),
      offOrigin: Math.max(account.frontier.offOrigin, offOriginUrls.size),
    };

    const inventory = mergeBoundaries(boundaries);
    sameSiteHosts = inventory.sameSite;
    const externals = mergeExternals([
      ...account.externals,
      ...inventory.externals,
      ...observation.externals.map((entry) => ({
        kind: entry.kind,
        origin: entry.origin,
        fromRoute: entry.fromRoute,
        samplePath: entry.samplePath,
        occurrences: entry.occurrences,
      })),
      ...(interaction ? interaction.externals : []),
    ]);

    const caps = frontier.caps();
    const verdict = enumerationOutcome({
      visitedPages: nodes.length,
      frontier: frontierForMap,
      caps,
    });
    caveats.push(...observationCaveats(observation));
    /*
     * "your crawl policy refused 31 URLs", grouped by the RULE that refused
     * them. The old crawl dropped every one with no record at all, so a refused
     * route and a route the application does not serve were indistinguishable
     * afterwards — and this is the only place a customer ever learns a refusal
     * happened.
     */
    caveats.push(...refusalSummary(excluded));
    for (const bite of caps) {
      if (bite.bites > 0) caveats.push(bite.reason);
    }

    const undeclared = reconcileCalledEndpoints(observation.calls, []);
    if (undeclared.calledButNeverDeclared.length > 0) {
      progress(
        `${undeclared.calledButNeverDeclared.length} endpoint(s) the UI calls were not declared ` +
          `by any detector`,
      );
    }

    const flowMap: FlowMap = {
      projectId: options.projectId,
      environmentId: options.environmentId,
      version: options.version,
      baseUrl: options.baseUrl,
      nodes,
      edges,
      journeys,
      features: groupIntoFeatures(nodes),
      exploredAt: new Date().toISOString(),
      /*
       * NEVER null on the strength of the loop exiting. `stoppedBecause` can be
       * CONVERGED while a per-template budget was discarding every instance of
       * `/orders/:id`, so the test is the OUTCOME and the lower bound together.
       */
      /*
       * ...and NOT the two sentences concatenated. `stopSentence` in the
       * frontier already ends with the same "visited N page(s); at least M more
       * in-scope URL(s) were known and not visited; caps that applied: …" tail
       * that `enumerationOutcome` produces, because both render the SAME
       * ledger — so `[schedule.why, verdict.why].join('; ')` printed the lower
       * bound and the whole cap list TWICE, in the one prose field a customer
       * reads. A caveat that repeats itself reads like two findings, and the
       * number it repeats is the number this slice exists to make trustworthy.
       *
       * The containment test rather than dropping `verdict.why` outright: the
       * two sentences are composed in different files and the verdict has at
       * least one thing the schedule cannot say ("no page was successfully
       * loaded", when nothing loaded at all). If they ever drift apart, both
       * survive; while they agree, it is said once.
       */
      truncatedReason:
        verdict.outcome === 'CONVERGED'
          ? null
          : schedule.why.includes(verdict.why)
            ? schedule.why
            : [schedule.why, verdict.why].join('; '),
      policyApplied: budget.policy,
      provenance: { derivedFrom: 'CRAWL', acceptance: 'ACCEPTED', outcome: verdict.outcome },
      acceptance: null,
      caps,
      frontier: frontierForMap,
      excluded,
      externals,
    };

    return {
      flowMap,
      snapshot: serialiseFrontier(frontier),
      account,
      budget,
      observation,
      interstitial,
      stoppedBecause: schedule.stoppedBecause,
      outcome: verdict.outcome,
      routeMode: routeModeSoFar,
      routeModeWhy,
      saturation,
      variantPlan,
      variantAttribution,
      variantSurface,
      dimensions: DEVICE_PROFILES.map((profile) => deviceDimensionValue(profile, 'CATALOGUE')),
      templates,
      sameSiteHosts,
      degradationCounts: {
        errorNodeCount,
        // The scheduler's unreachable list is the honest load-failure count:
        // a DOWNLOAD is not in it, which is the whole point of the fork above.
        loadFailureCount: schedule.unreachable.length,
        throttledCount: Math.max(throttledCount, observation.adjudication.throttled),
        tlsFailureCount: Math.max(tlsFailureCount, observation.adjudication.tlsFailures),
        authWallBounces: observation.adjudication.authWallBounces,
      },
      sitemap: seed ? sitemapReport(seed, nodes) : null,
      unreadSubDocuments,
      caveats: dedupeCaveats([
        ...caveats,
        ...(downloadNavigations > 0
          ? [
              `${downloadNavigations} URL(s) turned out to be files rather than pages; they are ` +
                `recorded as document surfaces and are NOT counted as unreachable`,
            ]
          : []),
        ...(unclassifiedNavigations > 0
          ? [
              `${unclassifiedNavigations} navigation(s) aborted for a reason we could not ` +
                `classify; they are counted as unreachable, which means "unknown whether it ` +
                `exists" and never "absent"`,
            ]
          : []),
      ]),
    };
  } finally {
    detach();
    await browser.close().catch(() => {});
  }
}

/** The two pure functions the modules need from here, as one object. */
const PRIMITIVES = { normaliseRoute, semanticFor };

/**
 * The worker count the budget would have allowed, for the disclosure above.
 * `DEFAULT_CRAWL_LIMITS.workers` without importing the whole record, so the
 * sentence names a real number rather than "more than one".
 */
const DEFAULT_WORKER_ALLOWANCE = 4;

/**
 * The caller's legacy caps, folded into the stored policy.
 *
 * Returns the stored value UNCHANGED when no legacy cap was passed, so an
 * environment that never set a policy still reads as `defaulted: true` rather
 * than as one that chose every default. That distinction is the only way a
 * panel can tell "nobody decided" from "somebody accepted the defaults".
 */
function withLegacyCaps(stored: unknown, options: CrawlOptions): unknown {
  const overrides: Record<string, number> = {};
  if (typeof options.maxPages === 'number') overrides.pageBudget = options.maxPages;
  if (typeof options.maxDepth === 'number') overrides.maxDepth = options.maxDepth;
  if (typeof options.maxMillis === 'number') overrides.wallClockMillis = options.maxMillis;
  if (Object.keys(overrides).length === 0) return stored;
  const base =
    stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  return { ...base, ...overrides };
}

/**
 * Turns a harvest into candidates, and applies the deprecated RegExp excludes.
 *
 * NOTHING ELSE FILTERS. The old code tested `target.origin !== origin`,
 * `excludes.some(...)` and `queued.has(...)` in the visitor, which is three
 * refusals with no record: `frontier.offer` is the ONLY admission decision and
 * it owns the exclusion ledger, the externals ledger, the depth accounting and
 * the budgets. The legacy patterns are the exception and they are LEDGERED.
 */
function admissibleCandidates(
  harvest: { discoveries: Discovery[] },
  patterns: readonly RegExp[],
  ledger: ExcludedPath[],
  fromRoute: string,
): OfferedCandidate[] {
  const out: OfferedCandidate[] = [];
  for (const discovery of harvest.discoveries) {
    if (!discovery.navigable || !discovery.admitted) continue;
    const parts = externalParts(discovery.url);
    const matched = parts ? patterns.find((pattern) => pattern.test(parts.path)) : undefined;
    if (matched) {
      ledger.push({
        url: discovery.url,
        route: discovery.route,
        kind: 'POLICY_EXCLUDE',
        rule: `the caller's deprecated excludePatterns option matched ${String(matched)}`,
        discoveredFrom: fromRoute,
      });
      continue;
    }
    out.push({
      url: normaliseHashbang(discovery.url),
      via: DISCOVERY_SOURCE_FOR_KIND[discovery.kind],
      referenceKind: EXTERNAL_KIND_FOR_DISCOVERY[discovery.kind],
    });
  }
  return out;
}

/**
 * `#!/orders` → `#/orders`, and nothing else.
 *
 * THE FORK THIS CLOSES. There are three answers in this slice to "is this
 * fragment a route": the frontier's AUTO keeps a fragment starting with `/`,
 * harvest's keeps any fragment containing `/`, and interact's keeps `#/` or
 * `#!/`. The frontier owns node identity and therefore wins — but its rule
 * drops the hashbang form outright, which is the whole of AngularJS and a
 * surprising amount of what is still deployed. `#!` and `#` address the same
 * client route, so rewriting the prefix here lets the frontier's own rule keep
 * it, instead of forking the rule or widening it in a file I do not own.
 *
 * Deliberately NOT a general fragment rewrite: `#pricing` must keep collapsing,
 * or one page with twelve jump links becomes thirteen nodes and the denominator
 * inflates in the other direction.
 */
export function normaliseHashbang(url: string): string {
  const marker = url.indexOf('#!/');
  if (marker === -1) return url;
  return `${url.slice(0, marker)}#${url.slice(marker + 2)}`;
}

function offerDiscovery(
  frontier: CrawlFrontier,
  discovery: Discovery,
  parent: FrontierEntry | null,
  navigateUrls: Map<string, string>,
): void {
  navigateUrls.set(normaliseHashbang(discovery.identity), discovery.url);
  frontier.offer(
    {
      url: normaliseHashbang(discovery.url),
      via: DISCOVERY_SOURCE_FOR_KIND[discovery.kind],
      referenceKind: EXTERNAL_KIND_FOR_DISCOVERY[discovery.kind],
    },
    parent,
  );
}

function edgeActionFor(entry: FrontierEntry, value: VisitValue): string {
  const match = value.discoveries.find((discovery) => discovery.identity === entry.url);
  if (match?.label) return `click "${match.label}"`;
  if (entry.discoveredVia === 'SITEMAP') return `open ${entry.template} (from the sitemap)`;
  if (entry.discoveredVia === 'REDIRECT') return `redirected to ${entry.template}`;
  return `open ${entry.template}`;
}

/**
 * Folds the interaction pass's graph fragment into the URL graph.
 *
 * `nodeIdFor` already matched the states both passes reached, so anything still
 * carrying an `istate-` id is genuinely new and is renumbered after the URL
 * nodes — with its edges rewritten, because leaving a stale id in a stored map
 * is a dangling edge nothing can render.
 */
function mergeInteraction(
  nodes: FlowNode[],
  edges: FlowEdge[],
  interaction: InteractionCrawlResult,
): void {
  const rename = new Map<string, string>();
  for (const node of interaction.nodes) {
    if (nodes.some((existing) => existing.id === node.id)) continue;
    const id = `node-${nodes.length}`;
    rename.set(node.id, id);
    nodes.push({ ...node, id });
  }
  for (const edge of interaction.edges) {
    const from = rename.get(edge.from) ?? edge.from;
    const to = rename.get(edge.to) ?? edge.to;
    if (!nodes.some((node) => node.id === from)) continue;
    if (!nodes.some((node) => node.id === to)) continue;
    edges.push({ ...edge, id: `edge-${edges.length}`, from, to });
  }
  for (const group of interaction.formlessForms) {
    const target = nodes.find((node) => node.id === (rename.get(group.stateId) ?? group.stateId));
    if (target) target.forms = [...target.forms, ...group.forms];
  }
}

/** One probe target per DISTINCT template the crawl actually reached. */
function probeTargetsFrom(
  nodes: readonly FlowNode[],
  interaction: InteractionCrawlResult | null,
): ProbeTarget[] {
  const byTemplate = new Map<string, ProbeTarget>();
  for (const node of nodes) {
    if (byTemplate.has(node.route)) continue;
    const params: string[] = [];
    try {
      for (const name of new URL(node.url).searchParams.keys()) params.push(name);
    } catch {
      /* a URL we cannot parse contributes no query names, which is honest. */
    }
    byTemplate.set(node.route, {
      template: node.route,
      sampleUrl: node.url,
      ...(params.length > 0 ? { queryParams: params } : {}),
    });
  }
  for (const control of interaction?.controls ?? []) {
    if (byTemplate.has(control.route)) continue;
    byTemplate.set(control.route, { template: control.route, sampleUrl: control.route });
  }
  return [...byTemplate.values()];
}

/** The observed network, projected onto the fault axis's request shape. */
function faultRequestsFrom(
  observation: ObservationReport,
  baseUrl: string,
): VariantRequestObservation[] {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = baseUrl;
  }
  const out: VariantRequestObservation[] = [];
  for (const call of observation.calls) {
    /*
     * A call nothing was focused for has no issuing route, and the fault axis
     * needs one to scope its matcher. Dropped rather than given a route it did
     * not come from — `unattributedEvents` already counts these, so the gap is
     * reported once and not invented twice.
     */
    if (call.fromRoute === null) continue;
    out.push({
      issuedFromRoute: call.fromRoute,
      method: call.method.toUpperCase(),
      origin: call.offOrigin && call.origin !== null ? call.origin : origin,
      path: call.template,
      // NULL and not 'other' when the transport was never recorded: a request
      // with no recorded resource type ranks below every recorded one rather
      // than being treated as an image.
      resourceType: call.transport === 'OTHER' ? null : call.transport.toLowerCase(),
      occurrences: call.occurrences,
      status: call.status,
    });
  }
  return out;
}

/**
 * Drives the runnable variants, and reports the rest HONESTLY.
 *
 * A variant the adapter cannot set up comes back UNAVAILABLE with the reason; a
 * variant nothing attempted comes back NOT_RUN. Neither is OBSERVED-with-no-
 * difference, which is the one answer that would turn "we did not look" into
 * "the dark theme works".
 */
async function driveVariants(
  browser: CrawlBrowser,
  plan: VariantCrawlPlan,
  nodes: readonly FlowNode[],
  progress: (message: string) => void,
): Promise<{
  baseline: Map<string, VariantPageFacts | null>;
  observations: VariantObservation[];
}> {
  const baseline = new Map<string, VariantPageFacts | null>();
  const observations: VariantObservation[] = [];
  const runnable = plan.variants.filter((variant) => variant.exercise === null);
  if (runnable.length > 0) progress(`Driving ${runnable.length} variant(s)`);

  for (const variant of runnable) {
    const node = nodes.find((candidate) => candidate.id === variant.nodeId);
    if (!node) {
      observations.push({
        variantId: variant.id,
        outcome: 'NOT_RUN',
        facts: null,
        detail: `the baseline node ${variant.nodeId} is not in the finished graph`,
      });
      continue;
    }
    if (!baseline.has(variant.base)) {
      const base = await browser.driveVariant(
        { kind: 'DEVICE', profile: BASELINE_PROFILE },
        node.url,
      );
      // `null` and not an empty facts object: `attributeVariants` sends a
      // variant with no measured baseline to `unattributable`, where every
      // control would otherwise look new.
      baseline.set(variant.base, base.outcome === 'OBSERVED' ? base.facts : null);
    }
    const drive = await browser.driveVariant(variant.setup, node.url);
    /*
     * The three-answer comparison, printed as it happens. `compareSignatures`
     * returns UNMEASURED — never IDENTICAL — when a side is missing, which is
     * the one collapse that would turn "we did not look" into "the dark theme
     * works". `variantSignatureOf` is the null-safe half: facts in, signature
     * or null out, so an unmeasured side cannot be hashed into a false match.
     */
    const verdict = compareSignatures(
      variantSignatureOf(baseline.get(variant.base)),
      variantSignatureOf(drive.facts),
    );
    progress(`  variant ${variant.id} (${variant.axis}): ${drive.outcome} / ${verdict}`);
    observations.push({
      variantId: variant.id,
      outcome: drive.outcome,
      facts: drive.facts,
      detail: drive.detail,
    });
  }
  return { baseline, observations };
}

/** The device the URL pass itself ran at, which every attribution is made against. */
const BASELINE_PROFILE =
  DEVICE_PROFILES.find((profile) => profile.key === BASELINE_DEVICE_KEY) ?? DEVICE_PROFILES[0]!;

/**
 * What the sitemap advertised, and the three answers that must not merge.
 *
 * `unreachable` is a DEFECT IN THE APPLICATION — it advertises a URL it does
 * not serve. `unchecked` is a fact about US and is not a finding. `refused` is
 * known by name. An entry with no `<lastmod>` is `undated` and is in neither
 * the fresh nor the stale bucket.
 */
function sitemapReport(
  seed: SeedHarvest,
  nodes: readonly FlowNode[],
): NonNullable<CrawlOutcome['sitemap']> {
  const statuses = new Map<string, { status: number | null }>();
  for (const node of nodes) statuses.set(node.url, { status: node.status?.code ?? null });
  const reach = sitemapReachability(
    seed.entries.map((entry) => entry.url),
    statuses,
    new Set(seed.discoveries.filter((entry) => !entry.admitted).map((entry) => entry.url)),
  );
  const stale = sitemapStaleness(seed.entries, { now: new Date(), staleAfterDays: 365 });
  return {
    declared: seed.entries.length,
    unreachable: reach.unreachable.length,
    unchecked: reach.unchecked.length,
    refused: reach.refused.length,
    // `undated` is in NEITHER the fresh nor the stale bucket: an entry with no
    // `<lastmod>` is not fresh, and saying so is the whole point of the split.
    undated: stale.undated,
    stale: stale.stale.length,
  };
}

/** One row per refused URL, however many pages linked it. */
function dedupeExcluded(rows: readonly ExcludedPath[]): ExcludedPath[] {
  const byUrl = new Map<string, ExcludedPath>();
  for (const row of rows) if (!byUrl.has(row.url)) byUrl.set(row.url, row);
  return [...byUrl.values()];
}

/** Boundaries from four ledgers, merged by (kind, origin) with occurrences summed. */
function mergeExternals(rows: readonly ExternalBoundary[]): ExternalBoundary[] {
  const byKey = new Map<string, ExternalBoundary>();
  for (const row of rows) {
    const key = `${row.kind}|${row.origin}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { ...row });
      continue;
    }
    existing.occurrences += row.occurrences;
    existing.samplePath = existing.samplePath ?? row.samplePath;
    existing.fromRoute = existing.fromRoute ?? row.fromRoute;
  }
  return [...byKey.values()];
}

function dedupeCaveats(lines: readonly string[]): string[] {
  return [...new Set(lines.filter((line) => line.trim() !== ''))];
}

// ─── The compatibility wrapper ──────────────────────────────────────────────

/**
 * The shipped signature, unchanged in shape and in behaviour for every caller
 * that passes `maxPages`/`maxDepth`/`maxMillis`.
 *
 * It returns the `FlowMap` alone. `crawlApp` returns everything, which is what
 * the processor needs: the frontier snapshot (so a truncated crawl can be
 * CONTINUED), the observation report, the interstitial verdict and the
 * degradation counts have no home on a `FlowMap` and vanish otherwise.
 */
export async function crawl(options: CrawlOptions): Promise<FlowMap> {
  return (await crawlApp(options)).flowMap;
}

export async function crawlApp(options: CrawlOptions): Promise<CrawlOutcome> {
  return runCrawl(options.adapter ?? playwrightCrawlAdapter(), options);
}

// ─── Persisting the frontier, without a column of its own ───────────────────

/**
 * Where the frontier snapshot lives until `FlowMap.frontierSnapshot` exists.
 *
 * The register item is "an incremental crawl that merges into the previous
 * map", and the blocker is that the queue was a local `const` inside `crawl()`:
 * a truncated crawl could never be continued, so an application over the cap
 * could never be fully enumerated however often it ran.
 *
 * `FlowMap.graph` is a `Json` column written whole, so the snapshot rides in it
 * under one reserved key, read and written ONLY through the two functions below
 * so there is exactly one place that knows the convention. It belongs in a
 * column of its own — nullable, no default, so an absent snapshot reads as
 * "this crawl did not record one" rather than as an empty queue — and that is
 * requested; this is what stands in until it lands.
 */
export const CRAWL_RESUME_KEY = '__qaaiFrontierSnapshot';

/**
 * And where the observation report lives, for the same reason.
 *
 * `FlowMap` has no field for it either, and the alternative is worse than a
 * reserved key: `report()` produces a correct object — the endpoints the UI
 * called, the bounce ledger, the runtime errors, the probe verdicts, the
 * documents — and it is THROWN AWAY at the end of the crawl. The whole network
 * inventory is computed and discarded, which is the one failure mode that
 * makes a feature indistinguishable from one that was never built.
 *
 * Read with {@link observationFrom}, which refuses a version it does not know
 * rather than believing half of it.
 */
export const CRAWL_OBSERVATION_KEY = '__qaaiObservation';

/** Writes the snapshot into the stored graph. */
export function withResumePoint(flowMap: FlowMap, snapshot: FrontierSnapshot): object {
  return { ...flowMap, [CRAWL_RESUME_KEY]: snapshot };
}

/** Writes the observation report into the stored graph. */
export function withObservation(graph: object, observation: ObservationReport): object {
  return { ...graph, [CRAWL_OBSERVATION_KEY]: observation };
}

/**
 * Reads one back, through `parseStoredObservation`.
 *
 * NULL for a graph that carries none — which is every map on disk — and that
 * must never render as "this crawl observed nothing". Null too for a version
 * this build does not know, because believing half a report is worse than
 * reporting that we cannot read it.
 */
export function observationFrom(graph: unknown): ObservationReport | null {
  if (graph === null || typeof graph !== 'object') return null;
  return parseStoredObservation((graph as Record<string, unknown>)[CRAWL_OBSERVATION_KEY]);
}

/**
 * Reads one back. NULL for a graph that has none — which is every map on disk —
 * and null for a version this build does not know, rather than believing half
 * of it and restoring a queue whose entries have undefined fields.
 */
export function resumePointFrom(graph: unknown): FrontierSnapshot | null {
  if (graph === null || typeof graph !== 'object') return null;
  const raw = (graph as Record<string, unknown>)[CRAWL_RESUME_KEY];
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const candidate = raw as Partial<FrontierSnapshot>;
  if (candidate.snapshotVersion !== 1) return null;
  if (typeof candidate.baseUrl !== 'string') return null;
  if (!Array.isArray(candidate.queue) || !Array.isArray(candidate.visited)) return null;
  if (candidate.canonicalisation === undefined) return null;
  return raw as FrontierSnapshot;
}

/**
 * Whether continuing is worth it, and the sentence that says so.
 *
 * A snapshot with an empty queue is not a resume point: restoring it would
 * re-seed the base URL, re-visit everything, and produce the same map with one
 * more version number. A snapshot with 240 entries is the difference between an
 * application that can never be fully enumerated and one that can.
 */
export function resumeAdvice(snapshot: FrontierSnapshot | null): {
  resumable: boolean;
  pending: number;
  why: string;
} {
  if (snapshot === null) {
    return {
      resumable: false,
      pending: 0,
      why: 'no previous crawl recorded a frontier, so this one starts from the base URL',
    };
  }
  const pending = snapshot.queue.length + snapshot.beyondDepth.length;
  if (pending === 0) {
    return {
      resumable: false,
      pending: 0,
      why: 'the previous crawl left nothing queued, so there is nothing to continue',
    };
  }
  return {
    resumable: true,
    pending,
    why:
      `the previous crawl left ${pending} in-scope URL(s) unvisited; this run continues from ` +
      `them instead of starting again`,
  };
}

// ─── Journeys and features ──────────────────────────────────────────────────

/**
 * Every shortest path from the entry node to a leaf is a candidate journey.
 *
 * The limit was a bare `journeys.length < 40` — a cap with no name that
 * discarded paths with no count. It is now `frontier.limits.journeyLimit`,
 * clamped by the plan, and it reports a `JOURNEY_LIMIT` bite when it bites.
 */
export function deriveJourneys(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  limit: number,
  noteCap?: (bite: CapBite) => void,
): FlowMap['journeys'] {
  if (nodes.length === 0) return [];

  const outgoing = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const journeys: FlowMap['journeys'] = [];
  const root = nodes[0]!.id;
  const seen = new Set<string>([root]);
  const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: root, path: [] }];
  let discarded = 0;

  while (queue.length > 0) {
    const { nodeId, path } = queue.shift()!;
    const next = outgoing.get(nodeId) ?? [];

    if (next.length === 0 && path.length > 0) {
      if (journeys.length >= limit) {
        discarded += 1;
        continue;
      }
      const target = nodes.find((n) => n.id === nodeId);
      journeys.push({
        id: `journey-${journeys.length}`,
        name: target ? `Reach ${target.title || target.route}` : `Path ${journeys.length}`,
        description: `${path.length}-step path ending at ${target?.route ?? nodeId}`,
        edgeIds: path,
        // Anything gated is on a critical path almost by definition; depth is a
        // rough proxy for importance beyond that.
        priority: target?.behindAuth
          ? 'CRITICAL_PATH'
          : path.length <= 2
            ? 'IMPORTANT'
            : 'NICE_TO_HAVE',
        roles: target?.requiresRoles ?? [],
      });
      continue;
    }

    for (const edge of next) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push({ nodeId: edge.to, path: [...path, edge.id] });
    }
  }

  if (discarded > 0 && noteCap) {
    noteCap({
      cap: 'JOURNEY_LIMIT',
      limit,
      bites: 1,
      discarded,
      scope: null,
      reason:
        `the journey-derivation limit (${limit}) bit and discarded ${discarded} complete ` +
        `path(s); at least that many more journeys existed`,
    });
  }

  return journeys;
}

/** First path segment as the feature name — crude, but it matches how apps are laid out. */
export function groupIntoFeatures(nodes: readonly FlowNode[]): FlowMap['features'] {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const segment = node.route.split('/').filter(Boolean)[0] ?? 'home';
    const name = segment.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    groups.set(name, [...(groups.get(name) ?? []), node.id]);
  }
  return [...groups.entries()].map(([name, nodeIds]) => ({ name, nodeIds }));
}

// ─── The Playwright adapter: the only part a unit test cannot drive ─────────

/**
 * Builds the most resilient locator available for an element (§3.2).
 *
 * Order matters: role+name survives restyling and re-layout; a CSS path breaks
 * the first time someone touches the markup. Confidence is the number the
 * Generator uses to decide whether to flag a test for human review.
 */
async function bestSelector(locator: Locator, fallbackCss: string): Promise<Selector> {
  const info = await locator
    .evaluate((el: Element) => {
      const htmlEl = el as HTMLElement;
      const labels = (el as HTMLInputElement).labels;
      return {
        role: el.getAttribute('role'),
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        ariaLabel: el.getAttribute('aria-label'),
        testId: el.getAttribute('data-testid') ?? el.getAttribute('data-test-id'),
        placeholder: el.getAttribute('placeholder'),
        label: labels && labels.length > 0 ? (labels[0]?.textContent ?? '').trim() : null,
        text: (htmlEl.innerText ?? el.textContent ?? '').trim().slice(0, 80),
      };
    })
    .catch(() => null);

  if (!info) return { strategy: 'CSS', value: fallbackCss, confidence: 0.3 };

  /*
   * ONE implicit-role table in the repo. This function used to carry its own
   * inline map plus a nested ternary for `<input>`; `crawl/interact.ts` has the
   * same table, and two of them disagreeing by one tag means the same control
   * gets two different locators depending on which pass found it. The interact
   * module's is the one with a test, so it wins.
   */
  const role = info.role ?? implicitRole(info.tag, info.type);
  const name = info.ariaLabel ?? info.label ?? info.text;

  if (role && name) {
    return { strategy: 'ROLE', value: role, name, confidence: 0.95 };
  }
  if (info.label) return { strategy: 'LABEL', value: info.label, confidence: 0.9 };
  if (info.testId) return { strategy: 'TEST_ID', value: info.testId, confidence: 0.85 };
  if (info.placeholder)
    return { strategy: 'PLACEHOLDER', value: info.placeholder, confidence: 0.7 };
  if (info.text) return { strategy: 'TEXT', value: info.text, confidence: 0.6 };
  return { strategy: 'CSS', value: fallbackCss, confidence: 0.3 };
}

/**
 * The constraints the DOM already carries, read in one round trip per control.
 *
 * Three states per attribute, and the difference matters: `null` means we
 * looked and the page declares nothing (interesting — an undeclared length
 * limit is the best place to send 10,000 characters); a value is the fact; and
 * absent from an old FlowMap means nobody looked.
 *
 * `min`/`max`/`step` stay STRINGS. `min="2024-01-01"` on a date input is not a
 * number, and parsing here would throw the date cases away.
 */
type FieldConstraints = Pick<
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
>;

async function readConstraints(control: Locator): Promise<Partial<FieldConstraints>> {
  const raw = await control
    .evaluate((el: Element) => {
      const input = el as HTMLInputElement;
      const attr = (name: string): string | null => {
        const value = el.getAttribute(name);
        return value === null || value.trim() === '' ? null : value;
      };
      const length = (name: string): number | null => {
        const value = attr(name);
        if (value === null) return null;
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      };
      const validity: ValidityState | undefined = input.validity;
      const custom =
        validity && validity.customError && input.validationMessage
          ? input.validationMessage
          : null;
      return {
        maxLength: length('maxlength'),
        minLength: length('minlength'),
        min: attr('min'),
        max: attr('max'),
        step: attr('step'),
        pattern: attr('pattern'),
        inputMode: attr('inputmode'),
        autocomplete: attr('autocomplete'),
        accept: attr('accept'),
        multiple: el.hasAttribute('multiple'),
        validationMessage: custom ?? attr('title'),
      };
    })
    .catch(() => null);

  // A control that vanished mid-crawl yields nothing rather than a row of
  // nulls: "we looked and the page declares no maxlength" is a claim, and this
  // is not the case to make it in.
  return raw ?? {};
}

async function extractForms(page: Page): Promise<FormModel[]> {
  const forms: FormModel[] = [];
  const formLocators = await page.locator('form').all();

  for (const [formIndex, form] of formLocators.entries()) {
    const action = (await form.getAttribute('action')) ?? '';
    const method = ((await form.getAttribute('method')) ?? 'get').toLowerCase();
    const cssPath = `form:nth-of-type(${formIndex + 1})`;

    const fields: FormField[] = [];
    const controls = await form.locator('input, select, textarea').all();

    for (const [controlIndex, control] of controls.entries()) {
      const type = (
        (await control.getAttribute('type')) ??
        (await control.evaluate((el) => el.tagName.toLowerCase()))
      ).toLowerCase();
      if (type === 'hidden') continue;

      const name = (await control.getAttribute('name')) ?? `field-${controlIndex}`;
      const label = await control
        .evaluate((el: Element) => {
          const labels = (el as HTMLInputElement).labels;
          return labels && labels.length > 0 ? (labels[0]?.textContent ?? '').trim() : null;
        })
        .catch(() => null);

      const options =
        type === 'select'
          ? await control
              .locator('option')
              .allTextContents()
              .then((texts) => texts.map((t) => t.trim()).filter(Boolean))
              .catch(() => undefined)
          : undefined;

      const constraints = await readConstraints(control);

      fields.push({
        name,
        label,
        inputType: type,
        required: (await control.getAttribute('required')) !== null,
        selector: await bestSelector(control, `${cssPath} [name="${name}"]`),
        semantic: semanticFor(name, type, label ?? '', constraints.autocomplete),
        ...(options && options.length > 0 ? { options } : {}),
        ...constraints,
      });
    }

    const submit = form
      .locator('button[type="submit"], input[type="submit"], button:not([type])')
      .first();
    const hasSubmit = (await submit.count()) > 0;

    forms.push({
      id: `form-${formIndex}`,
      name: action ? `${method.toUpperCase()} ${action}` : `Form ${formIndex + 1}`,
      selector: { strategy: 'CSS', value: cssPath, confidence: 0.5 },
      fields,
      submit: hasSubmit ? await bestSelector(submit, `${cssPath} [type="submit"]`) : null,
    });
  }

  return forms;
}

/** The in-page read that produces a `PageStructure`. All counts, no judgement. */
const STRUCTURE_SCRIPT = `(() => {
  const text = (el) => ((el.innerText || el.textContent || '').trim().slice(0, 120));
  const heading = (el) => {
    let node = el;
    while (node) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-4]$/.test(sib.tagName)) return (sib.textContent || '').trim().slice(0, 120);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  };
  const collections = [];
  for (const el of document.querySelectorAll('tbody, [role="list"], [role="grid"]')) {
    const rows = el.querySelectorAll('tr, [role="row"], [role="listitem"], li').length;
    collections.push({ selector: el.tagName.toLowerCase(), rowCount: rows, heading: heading(el) });
  }
  const status = Array.from(document.querySelectorAll('[role="status"]')).slice(0, 4).map(text);
  const alerts = Array.from(document.querySelectorAll('[role="alert"]')).slice(0, 4).map(text);
  const pristine = Array.from(document.querySelectorAll('form')).filter((form) => {
    const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (!submit || !submit.disabled) return false;
    return Array.from(form.querySelectorAll('input, textarea')).every((f) => !f.value);
  }).length;
  const links = Array.from(document.querySelectorAll('a[href]'));
  return {
    title: document.title,
    ariaBusyCount: document.querySelectorAll('[aria-busy="true"]').length,
    roleStatusTexts: status,
    roleAlertTexts: alerts,
    ariaLiveCount: document.querySelectorAll('[aria-live]:not([role="status"]):not([role="alert"])').length,
    collections,
    skeletonClassCount: Array.from(document.querySelectorAll('[class]')).filter((el) =>
      /skeleton|placeholder|shimmer|animate-pulse/i.test(el.className && el.className.toString ? el.className.toString() : '')).length,
    pristineDisabledSubmitCount: pristine,
    formCount: document.querySelectorAll('form').length,
    linkCount: links.length,
    sameOriginLinkCount: links.filter((a) => { try { return new URL(a.href).origin === location.origin; } catch { return false; } }).length,
    landmarks: ['nav', 'main', 'header', 'footer'].filter((tag) =>
      document.querySelector(tag + ', [role="' + (tag === 'nav' ? 'navigation' : tag === 'main' ? 'main' : tag === 'header' ? 'banner' : 'contentinfo') + '"]') !== null),
    headingTexts: Array.from(document.querySelectorAll('h1, h2')).slice(0, 12).map(text),
    textSample: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 4000),
    scriptOrigins: Array.from(new Set(Array.from(document.querySelectorAll('script[src]')).map((s) => {
      try { return new URL(s.src).origin; } catch { return null; }
    }).filter(Boolean))),
  };
})()`;

/** The accessibility-shaped read that produces a `RawSnapshot`. */
const RAW_SNAPSHOT_SCRIPT = `(() => {
  const roleOf = (el) => el.getAttribute('role') || ({
    A: 'link', BUTTON: 'button', NAV: 'navigation', MAIN: 'main', FORM: 'form',
    TABLE: 'table', UL: 'list', OL: 'list', LI: 'listitem', H1: 'heading', H2: 'heading',
    H3: 'heading', H4: 'heading', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox',
    IMG: 'img', SECTION: 'region', ARTICLE: 'article', TD: 'cell', TH: 'columnheader',
    TR: 'row', LABEL: 'label', P: 'paragraph',
  })[el.tagName] || 'generic';
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') ||
    (el.innerText || el.textContent || '').trim()).slice(0, 80);
  const structure = [];
  const walk = (el, depth) => {
    if (depth > 12 || structure.length > 600) return;
    for (const child of Array.from(el.children)) {
      if (child.hasAttribute('aria-hidden') || child.hidden) continue;
      structure.push({ role: roleOf(child), name: nameOf(child), depth });
      walk(child, depth + 1);
    }
  };
  if (document.body) walk(document.body, 0);
  const dialog = document.querySelector('[role="dialog"]:not([aria-hidden="true"]), dialog[open]');
  return {
    url: location.href,
    title: document.title,
    structure,
    dialogName: dialog ? nameOf(dialog) : null,
    activeMarkers: Array.from(document.querySelectorAll('[aria-current], [data-state="active"]')).slice(0, 12).map(nameOf),
    statusCode: null,
    isErrorPage: document.querySelector('[role="alert"]') !== null,
  };
})()`;

/** The harvest read: every element that can carry a URL, plus every form. */
function documentSnapshotScript(selector: string): string {
  return `(() => {
  const attrsOf = (el) => {
    const out = {};
    for (const a of Array.from(el.attributes)) out[a.name.toLowerCase()] = a.value;
    return out;
  };
  const appRootEl = document.querySelector('#root, #app, #__next, body > main');
  const appRoot = appRootEl ? (appRootEl.id ? '#' + appRootEl.id : appRootEl.tagName.toLowerCase()) : null;
  const portalHostOf = (el) => {
    let node = el;
    while (node && node.parentElement && node.parentElement !== document.body) node = node.parentElement;
    if (!node) return null;
    return node.id ? '#' + node.id : 'body > ' + node.tagName.toLowerCase();
  };
  return {
    url: location.href,
    baseHref: document.querySelector('base[href]') ? document.querySelector('base[href]').getAttribute('href') : null,
    appRoot,
    selector: ${JSON.stringify(selector)},
    elements: Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((el) => ({
      tag: el.tagName.toLowerCase(),
      attrs: attrsOf(el),
      text: ((el.innerText || el.textContent || '').trim().slice(0, 80)) || null,
      outsideAppRoot: appRootEl ? !appRootEl.contains(el) : undefined,
      portalHost: appRootEl && !appRootEl.contains(el) ? portalHostOf(el) : null,
    })),
    forms: Array.from(document.querySelectorAll('form')).map((form) => ({
      action: form.getAttribute('action'),
      method: form.getAttribute('method'),
      label: form.getAttribute('aria-label') || form.getAttribute('name'),
      fields: Array.from(form.querySelectorAll('input, select, textarea')).map((f) => ({
        name: f.getAttribute('name'),
        tag: f.tagName.toLowerCase(),
        type: f.getAttribute('type'),
        value: f.value === undefined ? null : f.value,
        checked: f.checked,
      })),
    })),
  };
})()`;
}

/** The facts a variant comparison is made of. Same reads, one object. */
const VARIANT_FACTS_SCRIPT = `(() => {
  const text = (el) => ((el.innerText || el.textContent || '').trim().slice(0, 120));
  const rows = document.querySelectorAll('tbody tr, [role="row"], [role="listitem"]').length;
  return {
    title: document.title,
    headings: Array.from(document.querySelectorAll('h1, h2')).slice(0, 12).map(text),
    controls: Array.from(document.querySelectorAll('button, a[href], [role="button"], [role="tab"]'))
      .slice(0, 200)
      .map((el) => (el.getAttribute('aria-label') || el.getAttribute('title') || text(el)))
      .filter(Boolean),
    routes: Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map((a) => {
      try { const u = new URL(a.href); return u.origin === location.origin ? u.pathname : null; } catch { return null; }
    }).filter(Boolean))),
    rowCount: rows,
    alerts: Array.from(document.querySelectorAll('[role="alert"]')).slice(0, 4).map(text),
    busy: document.querySelectorAll('[aria-busy="true"]').length > 0,
  };
})()`;

/**
 * The real browser, as thin as it can be.
 *
 * Everything here is a read or a navigation. There is no judgement in this
 * function at all — which is the point: a judgement in the adapter is a
 * judgement no test can reach, and that is how 629 lines came to have almost
 * none. What IS untested is this boundary itself, and it is named in the report
 * rather than covered by a test that proves a mock matches a mock.
 */
export function playwrightCrawlAdapter(): CrawlAdapter {
  return {
    fetcher: {
      async get(url) {
        try {
          const response = await fetch(url, { redirect: 'follow' });
          const body = await response.text().catch(() => null);
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });
          return { status: response.status, body, headers, finalUrl: response.url };
        } catch (err) {
          // NEVER throws: `status: null` is what distinguishes "we could not
          // fetch robots.txt" from "this site publishes none".
          return {
            status: null,
            body: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    async open(input) {
      const browser: Browser = await chromium.launch();
      const makeContext = async (
        overrides: Record<string, unknown> = {},
      ): Promise<BrowserContext> =>
        browser.newContext({
          ...(input.storageState ? { storageState: input.storageState as never } : {}),
          viewport: { width: 1280, height: 900 },
          acceptDownloads: true,
          ...overrides,
        });

      const context = await makeContext();
      const pages: CrawlPage[] = [];
      const rawPages: Page[] = [];
      const headersByPage = new Map<Page, Record<string, string>>();

      for (let slot = 0; slot < Math.max(1, input.workers); slot += 1) {
        const page = await context.newPage();
        rawPages.push(page);
        pages.push(wrapPage(page, headersByPage));
      }

      const events: BrowserEventSource = {
        on(listener) {
          const page = pages.length > 0 ? (context.pages()[0] ?? null) : null;
          if (!page) return () => {};
          const onRequest = (request: import('playwright').Request): void => {
            listener({ kind: 'request', request: rawRequestOf(request) });
          };
          const onResponse = (response: import('playwright').Response): void => {
            listener({
              kind: 'response',
              response: {
                request: rawRequestOf(response.request()),
                status: response.status(),
                contentType: response.headers()['content-type'] ?? null,
                contentDisposition: response.headers()['content-disposition'] ?? null,
                headerNames: Object.keys(response.headers()),
              },
            });
          };
          const onFailed = (request: import('playwright').Request): void => {
            listener({
              kind: 'requestfailed',
              request: rawRequestOf(request),
              errorText: request.failure()?.errorText ?? 'unknown',
            });
          };
          const onConsole = (message: import('playwright').ConsoleMessage): void => {
            listener({
              kind: 'console',
              level: message.type(),
              text: message.text(),
              location: message.location().url,
            });
          };
          const onPageError = (error: Error): void => {
            listener({ kind: 'pageerror', message: error.message, stack: error.stack ?? null });
          };
          const onWebSocket = (socket: import('playwright').WebSocket): void => {
            listener({ kind: 'websocket', url: socket.url() });
          };
          const onDownload = (download: import('playwright').Download): void => {
            listener({
              kind: 'download',
              url: download.url() || null,
              suggestedFilename: download.suggestedFilename(),
              mimeType: null,
            });
          };
          for (const target of context.pages()) {
            target.on('request', onRequest);
            target.on('response', onResponse);
            target.on('requestfailed', onFailed);
            target.on('console', onConsole);
            target.on('pageerror', onPageError);
            target.on('websocket', onWebSocket);
            target.on('download', onDownload);
          }
          return () => {
            for (const target of context.pages()) {
              target.off('request', onRequest);
              target.off('response', onResponse);
              target.off('requestfailed', onFailed);
              target.off('console', onConsole);
              target.off('pageerror', onPageError);
              target.off('websocket', onWebSocket);
              target.off('download', onDownload);
            }
          };
        },
      };

      /*
       * DECLARED, one by one, and nothing is declared that this adapter does
       * not do. `REDIRECT_CHAIN` is absent because nothing here walks
       * `redirectedFrom()`, so every bounce record carries `hops: null` — which
       * the capability report states, instead of an empty chain that would
       * claim "we looked and there were no hops".
       */
      const observerCapabilities = {
        NETWORK_EVENTS: true,
        CONSOLE_EVENTS: true,
        DOWNLOAD_EVENTS: true,
        STRUCTURE_READ: true,
        PROBE_NAVIGATION: true,
      } satisfies Partial<Record<ObserverCapability, boolean | string>>;

      const variants: VariantBrowserSurface = {
        /*
         * DECLARED because a device variant IS drivable here — but the viewport
         * belongs to a browser CONTEXT, not to a page, so the work happens in
         * `driveVariant` where a fresh context can be opened. This method
         * exists so `capabilitiesOf` reports SET_DEVICE as available; a surface
         * that lied here would have the planner emit variants nothing runs.
         */
        async setDevice(profile) {
          void profile;
        },
        async emulateMedia(media) {
          const page = context.pages()[0];
          if (!page) return;
          await page.emulateMedia({
            ...(media.colorScheme ? { colorScheme: media.colorScheme } : {}),
            ...(media.reducedMotion ? { reducedMotion: media.reducedMotion } : {}),
            ...(media.forcedColors ? { forcedColors: media.forcedColors } : {}),
            ...(media.media ? { media: media.media } : {}),
          });
        },
        async setOffline(offline) {
          await context.setOffline(offline);
        },
      };

      let variantContextHandle: BrowserContext | null = null;

      return {
        pages,
        events,
        observerCapabilities,
        /*
         * A real playwright `Page` IS assignable to `PageLike` with no cast —
         * `PlaywrightPageSatisfiesPageLike` in crawl/interact.ts asserts it at
         * compile time, so if playwright drifts one optional parameter away
         * that line goes red in that file rather than this integration silently
         * losing the whole interaction pass.
         */
        interaction: rawPages[0] ? playwrightInteractionSurface(rawPages[0]) : null,
        variants,
        async driveVariant(setup, url) {
          if (setup.kind !== 'DEVICE' && setup.kind !== 'MEDIA' && setup.kind !== 'OFFLINE') {
            return {
              outcome: 'UNAVAILABLE',
              facts: null,
              detail: `this adapter cannot set up a ${setup.kind} variant`,
            };
          }
          try {
            await variantContextHandle?.close().catch(() => {});
            variantContextHandle = await makeContext(
              setup.kind === 'DEVICE'
                ? {
                    viewport: { width: setup.profile.widthPx, height: setup.profile.heightPx },
                    deviceScaleFactor: setup.profile.deviceScaleFactor,
                    hasTouch: setup.profile.touch,
                  }
                : {},
            );
            const page = await variantContextHandle.newPage();
            if (setup.kind === 'MEDIA') {
              await page.emulateMedia({
                ...(setup.media.colorScheme ? { colorScheme: setup.media.colorScheme } : {}),
                ...(setup.media.reducedMotion ? { reducedMotion: setup.media.reducedMotion } : {}),
                ...(setup.media.forcedColors ? { forcedColors: setup.media.forcedColors } : {}),
                ...(setup.media.media ? { media: setup.media.media } : {}),
              });
            }
            if (setup.kind === 'OFFLINE') await variantContextHandle.setOffline(true);
            const response = await page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: 20_000,
            });
            const read =
              await page.evaluate<Omit<VariantPageFacts, 'status'>>(VARIANT_FACTS_SCRIPT);
            return {
              outcome: 'OBSERVED',
              facts: { ...read, status: response?.status() ?? null },
              detail: `read under ${setup.kind}`,
            };
          } catch (err) {
            return {
              outcome: 'FAILED',
              facts: null,
              detail: err instanceof Error ? err.message : String(err),
            };
          }
        },
        async close() {
          await variantContextHandle?.close().catch(() => {});
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        },
      };
    },
  };
}

function rawRequestOf(request: import('playwright').Request): {
  method: string;
  url: string;
  resourceType: string;
  headers: Record<string, string>;
  isNavigation: boolean;
} {
  return {
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    headers: request.headers(),
    isNavigation: request.isNavigationRequest(),
  };
}

function wrapPage(page: Page, headersByPage: Map<Page, Record<string, string>>): CrawlPage {
  return {
    async goto(url) {
      try {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        const headers = response ? await response.allHeaders().catch(() => ({})) : {};
        headersByPage.set(page, headers);
        return {
          requestedUrl: url,
          finalUrl: page.url(),
          status: response?.status() ?? null,
          responseHeaders: headers,
        };
      } catch (err) {
        // A failure is a VALUE. The old code's `catch { continue }` is what
        // swallowed every CSV, PDF and XLSX export in the application.
        return {
          requestedUrl: url,
          finalUrl: page.url(),
          status: null,
          failure: err instanceof Error ? err.message : String(err),
        };
      }
    },
    currentUrl() {
      return page.url();
    },
    async title() {
      return page.title().catch(() => '');
    },
    async documentSnapshot() {
      const read = (await page
        .evaluate(documentSnapshotScript(HARVEST_ELEMENT_SELECTOR))
        .catch(() => null)) as DocumentSnapshot | null;
      const headers = headersByPage.get(page) ?? null;
      if (read === null) {
        // `selector: null` is what makes every axis UNAVAILABLE rather than
        // zero, which is the honest answer when the read did not run.
        return { url: page.url(), elements: [], selector: null, headers };
      }
      return { ...read, headers };
    },
    async pageStructure() {
      // NULL on failure, never a zeroed object: `detectStructuralState(null)`
      // is UNKNOWN and a zeroed object is a measurement.
      return (await page.evaluate(STRUCTURE_SCRIPT).catch(() => null)) as PageStructure | null;
    },
    async rawSnapshot() {
      return (await page.evaluate(RAW_SNAPSHOT_SCRIPT).catch(() => null)) as RawSnapshot | null;
    },
    async forms() {
      return extractForms(page).catch(() => []);
    },
    async affordances(limit) {
      const out: FlowNode['affordances'] = [];
      const controls = await page
        .locator('button, input[type="submit"], [role="button"], [role="tab"]')
        .all()
        .catch(() => []);
      for (const control of controls.slice(0, limit)) {
        const label = (
          (await control.innerText().catch(() => '')) ||
          (await control.getAttribute('aria-label').catch(() => null)) ||
          (await control.getAttribute('title').catch(() => null)) ||
          ''
        ).trim();
        if (!label) continue;
        out.push({ label, selector: await bestSelector(control, 'button'), kind: 'button' });
      }
      return out;
    },
    async downloadAnchors() {
      return await page
        .locator('a[download]')
        .evaluateAll((anchors) =>
          anchors.map((a) => {
            const anchor = a as HTMLAnchorElement;
            return {
              href: anchor.href,
              filename: anchor.getAttribute('download') || null,
              label: (anchor.innerText ?? '').trim().slice(0, 60) || null,
            };
          }),
        )
        .catch(() => []);
    },
  };
}
