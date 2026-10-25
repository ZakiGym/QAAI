/**
 * Observation — everything the crawl can learn by WATCHING rather than by
 * navigating.
 *
 * A link crawl answers "what pages are there". This module answers the six
 * questions a link crawl cannot even ask: what did the UI CALL, where was the
 * request actually SENT, was this the application at all, which routes ANSWER
 * with an error, what BROKE while the page ran, which states are LOADING or
 * EMPTY rather than populated, and what DOCUMENTS the app produces. None of it
 * costs an extra navigation: the browser already emits every one of these
 * events and crawler.ts currently throws all of them away.
 *
 * ── THE SEVEN DEFECTS THIS FILE EXISTS TO FIX ───────────────────────────────
 *
 *  1. The network is never recorded. A crawl of a single-page application sees
 *     one document request and forty XHRs it does not look at, so QAAI cannot
 *     say "your UI calls POST /api/refunds and nothing in your repo declares
 *     it" — the CALLED_BUT_NEVER_DECLARED finding, which is the most valuable
 *     sentence this product can say about a backend.
 *
 *  2. A bounce is attributed to the WRONG ROUTE. crawler.ts reads `page.url()`
 *     after `goto` and stores the node under the FINAL url, so a gated
 *     /admin/billing that redirects to /login is enumerated as /login — twice,
 *     three times, forty times — and /admin/billing, the thing we actually
 *     asked for, appears nowhere. The auth-wall denominator is therefore wrong
 *     in the most common application shape there is.
 *
 *  3. A bot wall is enumerated as the application. A Cloudflare challenge, a
 *     consent wall, a maintenance page or a geo-block answers every URL, so the
 *     crawl records ONE node, finds no links, empties its queue, and reports
 *     `truncatedReason: null` — a silent total failure presented as a complete
 *     enumeration. That is the worst available outcome: the denominator becomes
 *     1 and the coverage percentage goes UP.
 *
 *  4. 4xx and 5xx are not nodes. `if (response.status() >= 400)` writes a line
 *     to a progress callback and the page is stored as an ordinary route, so
 *     the generator writes a happy-path test against a 404 page and that test
 *     passes forever. Nothing probes the error paths on purpose either, so the
 *     negative half of every detail route is unenumerated by construction.
 *
 *  5. Runtime errors are a log line. `pageerror`, `console.error`,
 *     `requestfailed`, CSP violations and mixed content are free enumeration
 *     AND free negative-test seeds, and they are discarded.
 *
 *  6. Empty-state detection is THREE ENGLISH SENTENCES. crawler.ts:213 tests
 *     /your cart is empty|no orders yet|no products match/, which exist only in
 *     QAAI's own demo app — so the feature works on the demo and nowhere else,
 *     and every real customer's empty state is recorded as 'populated'.
 *
 *  7. Downloads are dropped. A navigation that produces a file makes `goto`
 *     throw, which lands in the `could not load` branch, so CSV/PDF/XLSX
 *     exports — business-critical in every B2B application — are not surface at
 *     all. They are recorded as nothing, not even as unreachable.
 *
 * ── THE RULES THIS FILE LIVES BY ────────────────────────────────────────────
 *
 *  1. **The browser surface is INJECTED.** Nothing here imports playwright.
 *     The adapter hands us plain data — {@link BrowserEvent}s, a
 *     {@link ObservedNavigation}, a {@link PageStructure} — and every classifier
 *     below is a pure function over those. That is not fastidiousness: 629
 *     lines of crawler.ts have almost no tests precisely because its logic is
 *     welded to a `Page`, and this module's judgement calls (is this a bot wall?
 *     is this list empty or loading?) are exactly the kind that must be cheap
 *     to keep correct.
 *
 *  2. **UNAVAILABLE is not a negative result.** A capability the adapter does
 *     not provide is reported as UNAVAILABLE — see {@link CapabilityReport}. A
 *     structure read that could not run returns UNKNOWN, never POPULATED; a
 *     redirect chain the adapter cannot report is `null`, never `[]`. "We
 *     looked and there was nothing" and "we could not look" are different
 *     facts and this module never collapses them.
 *
 *  3. **Every cap is disclosed with a count.** Each limit below reports as an
 *     {@link ObservationCapBite} carrying `bites` AND `discarded`, so the
 *     report can always say "at least N more existed". A silently truncated
 *     observation makes the coverage percentage go up, which is the one
 *     direction this product may never be wrong in.
 *
 *  4. **A REFUSAL IS RECORDED.** A probe the policy forbids becomes an
 *     {@link ExcludedPath} naming the rule, never a silent `continue`. A
 *     surface we were not allowed to look at and a surface that does not exist
 *     are opposite facts.
 *
 *  5. **Redaction happens before a record exists**, on the same pattern as
 *     traffic.ts and using its implementation rather than a second one. Request
 *     and response BODIES are never read. Header VALUES are read to derive a
 *     name list and a count and are not retained — there is no field on
 *     {@link ObservedCall} that can hold one, so no later change can leak an
 *     Authorization value by forgetting to mask it. Query VALUES are dropped
 *     wholesale; parameter NAMES survive, because a name is route shape and a
 *     value is user data.
 */

import {
  externalParts,
  isOwnOrigin,
  statusClassFor,
  surfaceKey,
  type CapBite,
  type CrawlAcceptance,
  type CrawlDegradation,
  type CrawlPolicy,
  type ExcludedPath,
  type ExclusionKind,
  type NodeStatus,
  type NodeStatusClass,
  type RouteAccess,
  type SurfaceExercise,
  type SurfaceKind,
  type SurfaceSource,
} from '@qaai/shared';
/*
 * Redaction and path canonicalisation come from traffic.ts and are NOT
 * reimplemented here. The classifier that turns `/orders/ORD-1001` into
 * `/orders/:id` has to produce the same template for a recorded XHR as it does
 * for an uploaded HAR, or the two halves of the endpoint inventory will never
 * reconcile and every endpoint will appear twice under slightly different
 * names. `classifySegment` also Luhn-checks card numbers and catches singleton
 * emails, which a second hand-rolled parameteriser would not.
 */
import { PLACEHOLDER, Redactor, sanitisePath } from '../traffic.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. THE INJECTED BROWSER SURFACE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What this module needs a browser to be able to do, as named capabilities.
 *
 * Named rather than assumed, because the adapter is allowed to be partial. A
 * CDP-only capability is missing under WebKit; a download sink is missing when
 * the worker has no writable temp directory; a redirect chain is missing from
 * any adapter that only reports the final response. Each absence has to reach
 * the report as UNAVAILABLE rather than as an empty result, or a customer reads
 * "no runtime errors" from a crawl that was never listening for them.
 */
export const OBSERVER_CAPABILITIES = [
  /** request / response / requestfailed events. */
  'NETWORK_EVENTS',
  /** console and pageerror events. */
  'CONSOLE_EVENTS',
  /** download events — needed for a blob export, which has no URL. */
  'DOWNLOAD_EVENTS',
  /** The full redirect hop chain, not just the final response. */
  'REDIRECT_CHAIN',
  /** One in-page structural read per node. */
  'STRUCTURE_READ',
  /** A deliberate extra GET, for the error-path probes. */
  'PROBE_NAVIGATION',
] as const;
export type ObserverCapability = (typeof OBSERVER_CAPABILITIES)[number];

export const OBSERVER_CAPABILITY_LABELS: Record<ObserverCapability, string> = {
  NETWORK_EVENTS: 'the network event stream',
  CONSOLE_EVENTS: 'the console and page-error stream',
  DOWNLOAD_EVENTS: 'download events',
  REDIRECT_CHAIN: 'the redirect hop chain',
  STRUCTURE_READ: 'the in-page structural read',
  PROBE_NAVIGATION: 'deliberate error-path probes',
};

/** A capability, and whether it was actually there. UNAVAILABLE is not false. */
export interface CapabilityReport {
  capability: ObserverCapability;
  state: 'AVAILABLE' | 'UNAVAILABLE';
  /** Always written. "UNAVAILABLE" with no reason is not a disclosure. */
  why: string;
}

/**
 * One request, as the adapter reports it.
 *
 * `headers` is the dangerous field and it is shaped to be safe by
 * construction: it enters this module, its NAMES are kept, and it is never
 * stored on anything this module returns. {@link ObservedCall} has no field
 * that could hold a header value, so there is no code path — present or future
 * — in which an Authorization value is persisted.
 */
export interface RawRequest {
  method: string;
  url: string;
  /**
   * The adapter's own resource-type word. Playwright's vocabulary ('xhr',
   * 'fetch', 'document', 'websocket', 'eventsource', 'ping', 'image', …) is the
   * one {@link transportFor} understands; anything it does not recognise comes
   * back OTHER rather than being guessed into a transport.
   */
  resourceType?: string | null;
  /** Read for names and a count. Never retained. See the note above. */
  headers?: Record<string, string>;
  /** True when the adapter knows this request was a top-level navigation. */
  isNavigation?: boolean;
}

/** One response. Three headers are read; the body is not read at all. */
export interface RawResponse {
  request: RawRequest;
  status: number;
  contentType?: string | null;
  /**
   * `Content-Disposition`. The DISPOSITION TYPE is what makes this a document
   * surface; the filename is scrubbed through the literal classifier before it
   * is kept, because `invoice-jane@example.com.pdf` is a real filename shape.
   */
  contentDisposition?: string | null;
  /**
   * The hop chain that led here, oldest first, EXCLUDING this response's own
   * URL. `undefined` means the adapter cannot report hops — which is why
   * {@link BounceRecord.hops} is nullable rather than defaulted to `[]`.
   */
  redirectChain?: string[];
  /** Response header names only, for the ones the adapter chooses to pass. */
  headerNames?: string[];
}

/** Everything the event source can emit. One union, so a fake is trivial. */
export type BrowserEvent =
  | { kind: 'request'; request: RawRequest }
  | { kind: 'response'; response: RawResponse }
  | { kind: 'requestfailed'; request: RawRequest; errorText: string }
  | { kind: 'websocket'; url: string; fromRoute?: string | null }
  | { kind: 'console'; level: string; text: string; location?: string | null }
  | { kind: 'pageerror'; message: string; stack?: string | null }
  | {
      kind: 'download';
      /** Null for a blob export: the file never had a URL. */
      url: string | null;
      suggestedFilename?: string | null;
      mimeType?: string | null;
    };

/**
 * The event source. ONE method, because that is all the module needs and
 * because a one-method interface is one a test can implement in four lines.
 */
export interface BrowserEventSource {
  /** Subscribes. The returned function unsubscribes. */
  on(listener: (event: BrowserEvent) => void): () => void;
}

/**
 * One navigation as OBSERVED: what was asked for, what came back, and the hops
 * in between.
 *
 * NOT the same thing as `interact.ts`'s `ObservedNavigation`, which is the
 * RESULT of driving a page (ok / url / status / error) and does not carry the
 * requested URL at all. The distinction is this module's whole item 2: the
 * requested URL is the fact a bounce ledger exists to keep, and an outcome
 * shape that only knows where it ended up is exactly how /admin/billing came
 * to be enumerated as /login. An integrator pairing the two must supply
 * `requestedUrl` from the queue item, not from the outcome.
 *
 * `status: null` is a real and common answer — a same-document SPA transition
 * produces no response — and it is never 200. `failure` set means `goto` threw,
 * which is the branch that currently swallows every download.
 */
export interface ObservedNavigation {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  /** Oldest first, excluding `finalUrl`. `undefined` = the adapter cannot say. */
  hops?: string[];
  /** The adapter's error text when the navigation threw. */
  failure?: string | null;
  /** Response headers the adapter chose to pass, lower-cased names. */
  responseHeaders?: Record<string, string>;
}

/**
 * The in-page structural read: one `evaluate` per node, as plain data.
 *
 * Every field is a COUNT or a short string, deliberately. The adapter does the
 * DOM walk and this module does the judging, so the judging is testable without
 * a browser — which is the whole reason crawler.ts's three-English-sentences
 * heuristic was never noticed to be demo-only.
 */
export interface PageStructure {
  title: string;
  /** Elements carrying `aria-busy="true"`. The strongest loading signal there is. */
  ariaBusyCount: number;
  /** Text of `role="status"` regions, capped by the adapter. */
  roleStatusTexts: string[];
  /** Text of `role="alert"` regions. */
  roleAlertTexts: string[];
  /** `aria-live` regions that are not already counted as status/alert. */
  ariaLiveCount: number;
  /**
   * Collections and their row counts, with the nearest preceding heading.
   * A `tbody` with zero rows under a heading is an EMPTY STATE in any
   * language; the heading is what distinguishes it from a page with no table.
   */
  collections: Array<{ selector: string; rowCount: number; heading: string | null }>;
  /** Elements whose class name looks like a skeleton placeholder. */
  skeletonClassCount: number;
  /** Forms whose submit control is disabled and whose fields are all empty. */
  pristineDisabledSubmitCount: number;
  formCount: number;
  linkCount: number;
  /** Links to the application's own origin. Zero of these is the chrome signal. */
  sameOriginLinkCount: number;
  /** Landmarks present: 'nav', 'main', 'header', 'footer'. */
  landmarks: string[];
  headingTexts: string[];
  /**
   * A capped slice of body text, used ONLY for the weak phrase signals. Capped
   * by the adapter; this module never asks for a whole page of text.
   */
  textSample: string;
  /** Script hosts the page loaded from, origin only. Feeds the bot-wall signal. */
  scriptOrigins?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CAPS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The caps observation applies, named.
 *
 * A separate vocabulary from `CRAWL_CAPS` in @qaai/shared and deliberately so:
 * those eight are the TRAVERSAL's caps (page budget, depth, wall clock) and
 * these are the OBSERVATION's. Folding mine into that list would need an edit
 * to a file this change does not own, and inventing a `cap` value it does not
 * contain would produce a `CapBite` whose label lookup is `undefined`. The
 * SHAPE is shared — {@link ObservationCapBite} is `CapBite` with this `cap`
 * union — so a change to the cap-disclosure contract breaks this file at
 * compile time rather than drifting away from it.
 */
export const OBSERVATION_CAPS = [
  'CALLS_PER_NODE',
  'CALLS_TOTAL',
  'ERRORS_PER_NODE',
  'ERROR_SIGNATURES_TOTAL',
  'ERROR_SAMPLE_ROUTES',
  'DOCUMENTS_PER_NODE',
  'BOUNCE_HOPS',
  'PROBES_PER_TEMPLATE',
  'PROBES_TOTAL',
] as const;
export type ObservationCap = (typeof OBSERVATION_CAPS)[number];

export const OBSERVATION_CAP_LABELS: Record<ObservationCap, string> = {
  CALLS_PER_NODE: 'the per-node network-call limit',
  CALLS_TOTAL: 'the whole-crawl network-call limit',
  ERRORS_PER_NODE: 'the per-node runtime-error limit',
  ERROR_SIGNATURES_TOTAL: 'the distinct-runtime-error limit',
  ERROR_SAMPLE_ROUTES: 'the per-error route-sample limit',
  DOCUMENTS_PER_NODE: 'the per-node document limit',
  BOUNCE_HOPS: 'the redirect-hop limit',
  PROBES_PER_TEMPLATE: 'the per-template error-probe limit',
  PROBES_TOTAL: 'the whole-crawl error-probe limit',
};

/**
 * `CapBite` with this module's cap vocabulary. `Omit`+intersection rather than
 * a fresh interface, so `bites` and `discarded` cannot quietly stop being
 * required here if the shared contract changes.
 */
export type ObservationCapBite = Omit<CapBite, 'cap'> & { cap: ObservationCap };

export interface ObservationCaps {
  callsPerNode: number;
  callsTotal: number;
  errorsPerNode: number;
  errorSignaturesTotal: number;
  errorSampleRoutes: number;
  documentsPerNode: number;
  bounceHops: number;
  probesPerTemplate: number;
  probesTotal: number;
}

/**
 * The defaults, and each one is a number somebody chose rather than a round
 * number that felt safe.
 *
 * `callsPerNode: 200` — a heavy dashboard issues 60–120 requests on first
 * paint; 200 leaves room for a chatty one without letting a polling widget
 * consume the whole report. `errorSignaturesTotal: 500` — a broken build emits
 * the same error on every page, and the signature dedupe collapses those to
 * one, so 500 DISTINCT errors is already a pathological application and a
 * number worth printing as itself. `probesTotal: 50` — a probe is a real extra
 * request against a customer's environment, and fifty is the most this module
 * will spend uninvited.
 */
export const DEFAULT_OBSERVATION_CAPS: ObservationCaps = {
  callsPerNode: 200,
  callsTotal: 5_000,
  errorsPerNode: 50,
  errorSignaturesTotal: 500,
  errorSampleRoutes: 5,
  documentsPerNode: 20,
  bounceHops: 10,
  probesPerTemplate: 3,
  probesTotal: 50,
};

/** The running tally for one cap. Internal; `capBites()` is the door out. */
interface CapTally {
  bites: number;
  discarded: number;
  scopes: Set<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ITEM 1 — THE RUNTIME NETWORK INVENTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a call was made. The distinction is not cosmetic: an XHR to
 * `/api/orders` is an endpoint the UI depends on, a WebSocket to `/ws` is a
 * surface no HTTP test can touch at all, and a BEACON fires on unload and will
 * never be observed by a test that navigates away cleanly.
 */
export const CALL_TRANSPORTS = [
  'XHR',
  'FETCH',
  'WEBSOCKET',
  'EVENT_SOURCE',
  'BEACON',
  'NAVIGATION',
  /** A document, stylesheet, image or font. Not an API call. */
  'ASSET',
  /** The adapter's word was not one we know. Never guessed into another. */
  'OTHER',
] as const;
export type CallTransport = (typeof CALL_TRANSPORTS)[number];

/** The transports that are API surface. An asset is not an endpoint. */
export const API_TRANSPORTS: readonly CallTransport[] = [
  'XHR',
  'FETCH',
  'WEBSOCKET',
  'EVENT_SOURCE',
  'BEACON',
];

/**
 * Header names this module flags as credential-bearing.
 *
 * The NAME is kept and the value is not. That asymmetry is the useful one:
 * "this endpoint is called with an Authorization header" is exactly the fact a
 * test needs in order to know it must authenticate, and the value is exactly
 * the fact nothing may ever store.
 */
export const CREDENTIAL_HEADER_NAMES: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'authentication',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
];

/**
 * One endpoint the UI actually called, attributed to the node and interaction
 * that caused it.
 *
 * There is no body field, no header-value field and no query-value field, and
 * that is the guarantee rather than a convention.
 */
export interface ObservedCall {
  transport: CallTransport;
  method: string;
  /** Canonical, parameterised, redacted path. `/orders/:id`, never `/orders/ORD-1001`. */
  template: string;
  origin: string | null;
  /** True when the call left the application's own origins. Someone else's API. */
  offOrigin: boolean;
  /** Null when nothing ever answered — a pending or failed request. Never 0, never 200. */
  status: number | null;
  statusClass: NodeStatusClass;
  contentType: string | null;
  /** Parameter NAMES, with the policy's ignored parameters removed. */
  queryParams: string[];
  /** Request header NAMES. Values are not in this object and never were. */
  headerNames: string[];
  /** Names from {@link CREDENTIAL_HEADER_NAMES} that were present. */
  credentialHeaderNames: string[];
  occurrences: number;
  /** The route of the node that was open. Null when nothing was focused yet. */
  fromRoute: string | null;
  /** The interaction the crawl was performing. Null when it was a plain load. */
  interaction: string | null;
  /** The adapter's failure text, when the request failed. */
  failure: string | null;
}

/** The identity two observations of the same endpoint collapse onto. */
export function callIdentity(call: Pick<ObservedCall, 'method' | 'template'>): string {
  return `${call.method.toUpperCase()} ${call.template}`;
}

/**
 * The `CoverageItem.key` an observed call becomes.
 *
 * Built with `surfaceKey` from @qaai/shared and never by hand: six writers have
 * to agree on this string byte for byte or the same endpoint enters the
 * inventory twice and the denominator inflates.
 */
export function callSurfaceKey(call: Pick<ObservedCall, 'method' | 'template'>): string {
  return surfaceKey('ENDPOINT', callIdentity(call));
}

/** Playwright's resource-type vocabulary → ours. Unknown words stay OTHER. */
export function transportFor(resourceType: string | null | undefined): CallTransport {
  switch ((resourceType ?? '').toLowerCase()) {
    case 'xhr':
      return 'XHR';
    case 'fetch':
      return 'FETCH';
    case 'websocket':
      return 'WEBSOCKET';
    case 'eventsource':
      return 'EVENT_SOURCE';
    case 'ping':
      return 'BEACON';
    case 'document':
      return 'NAVIGATION';
    case 'stylesheet':
    case 'image':
    case 'media':
    case 'font':
    case 'script':
    case 'manifest':
    case 'texttrack':
      return 'ASSET';
    case '':
      return 'OTHER';
    default:
      return 'OTHER';
  }
}

/**
 * Canonicalises a URL into a template, drops every query value, and strips the
 * policy's ignored parameters.
 *
 * TWO PASSES, and they are two because they answer different questions.
 *
 *   SAFETY comes first: `sanitisePath` from traffic.ts classifies every segment
 *   before anything looks at it, so a card number (Luhn-checked), an email, a
 *   JWT or an opaque token becomes a placeholder even where it appears exactly
 *   once. A hand-rolled parameteriser would miss the singleton, and "it only
 *   leaked once" is still a leak.
 *
 *   IDENTITY comes second: `normaliseRoute` — the crawler's own function,
 *   injected — collapses the application's own id SHAPES, which the safety pass
 *   deliberately leaves alone. `ORD-1001` is not a secret and not a number, so
 *   the classifier keeps it as a literal; the crawler collapses it to `:id`.
 *   Both passes must run or the two halves of the endpoint inventory never
 *   reconcile: `/orders/ORD-1001` from a recorded XHR and `/orders/:id` from
 *   the route table would be two items, the denominator would grow by one per
 *   order in the customer's database, and the CALLED_BUT_NEVER_DECLARED finding
 *   would fire on every single one of them.
 *
 * WHEN `normaliseRoute` IS OMITTED the template is redacted but NOT collapsed,
 * which is safe and less precise. The recorder requires it
 * ({@link ObserveOptions.normaliseRoute}) precisely so the integration cannot
 * take that path by accident.
 *
 * The ignored-parameter strip is this function's own job and is policy-driven:
 * `?utm_source=a` and `?utm_source=b` are the same endpoint, and without the
 * strip a tracking parameter mints a new "endpoint" per inbound link.
 */
export function canonicalCall(
  url: string,
  policy: Pick<CrawlPolicy, 'ignoredQueryParams'>,
  options?: { redactor?: Redactor; normaliseRoute?: (pathname: string) => string },
): { template: string; origin: string | null; queryParams: string[] } {
  const sanitised = sanitisePath(url, options?.redactor);
  const redacted = `/${sanitised.segments.map((segment) => segment.text).join('/')}`;
  const ignored = new Set(policy.ignoredQueryParams.map((name) => name.toLowerCase()));
  return {
    template: options?.normaliseRoute ? options.normaliseRoute(redacted) : redacted,
    origin: externalParts(url)?.origin ?? null,
    queryParams: sanitised.queryKeys.filter((name) => !ignored.has(name.toLowerCase())),
  };
}

/**
 * A URL safe to STORE: scheme, host, port and a classified path, with every
 * query value dropped.
 *
 * MY OWN TEST CAUGHT THIS. The bounce ledger recorded `finalUrl` verbatim, so
 * a redirect to an identity provider stored `?state=<token>&client_id=<id>` in
 * the flow map — which is exported, diffed and rendered in a cockpit.
 * `ExternalBoundary` in @qaai/shared is origin-only for exactly this reason,
 * and a second place that kept the full URL would have undone that decision
 * without anybody editing the file it was made in.
 *
 * The path is CLASSIFIED but not collapsed: a bounce record is about one
 * concrete navigation, so `/orders/ORD-1001` stays recognisable while a card
 * number or an email in the path becomes a placeholder.
 */
export function sanitisedUrl(url: string, redactor?: Redactor): string {
  const parts = externalParts(url);
  if (!parts) return url.split('?')[0] ?? url;
  const sanitised = sanitisePath(url, redactor);
  return `${parts.origin}/${sanitised.segments.map((segment) => segment.text).join('/')}`;
}

/**
 * A call the UI makes that nothing in the repository declares.
 *
 * THE FINDING THIS WHOLE ITEM EXISTS FOR. A source analysis reads route tables
 * and server handlers; it cannot see an endpoint reached through a generated
 * client, a proxy rewrite, a third-party SDK or a path assembled from a
 * variable. The UI calling it is proof it exists, which no competitor's
 * denominator can produce.
 */
export interface UndeclaredCallFinding {
  /** `ENDPOINT:GET /api/orders/:id`. The key the inventory would store. */
  key: string;
  label: string;
  method: string;
  template: string;
  /** Routes whose pages made the call, capped and counted. */
  calledFrom: string[];
  occurrences: number;
  /** Distinct statuses observed, sorted. A 401-only endpoint is a different fact. */
  statuses: number[];
  /** True when the call carried a credential header. It needs authentication. */
  needsCredentials: boolean;
  /** The sentence that justifies the finding, in the customer's terms. */
  evidence: string;
}

/**
 * Reconciles what the UI called against what the repository declares.
 *
 * Both directions, because both are diagnostic and the second is free:
 *
 *   calledButNeverDeclared  the UI calls it; no detector found it. Either a
 *                           client we cannot read, or a route table we failed
 *                           to parse — and the second is evidence about OUR
 *                           extractor, which it would be dishonest to suppress.
 *   declaredButNeverCalled  the repository declares it; nothing called it
 *                           during this crawl. NOT "dead code": the crawl
 *                           reached a fraction of the app, so this is a
 *                           candidate list and the caller must say so.
 *
 * `declaredKeys` are `surfaceKey('ENDPOINT', …)` strings, so the comparison
 * happens in one vocabulary rather than by string-munging two.
 */
export function reconcileCalledEndpoints(
  calls: readonly ObservedCall[],
  declaredKeys: Iterable<string>,
  options?: { maxRoutesPerFinding?: number },
): {
  calledButNeverDeclared: UndeclaredCallFinding[];
  declaredAndCalled: string[];
  declaredButNeverCalled: string[];
} {
  const maxRoutes = options?.maxRoutesPerFinding ?? 5;
  const declared = new Set(declaredKeys);
  const grouped = new Map<
    string,
    {
      call: ObservedCall;
      occurrences: number;
      routes: Set<string>;
      statuses: Set<number>;
      credentials: boolean;
    }
  >();

  for (const call of calls) {
    // An asset is not an endpoint, and a 404 image would otherwise be reported
    // as an undeclared API the customer must go and document.
    if (!API_TRANSPORTS.includes(call.transport)) continue;
    if (call.offOrigin) continue;
    const key = callSurfaceKey(call);
    const group = grouped.get(key) ?? {
      call,
      occurrences: 0,
      routes: new Set<string>(),
      statuses: new Set<number>(),
      credentials: false,
    };
    group.occurrences += call.occurrences;
    if (call.fromRoute) group.routes.add(call.fromRoute);
    if (call.status !== null) group.statuses.add(call.status);
    if (call.credentialHeaderNames.length > 0) group.credentials = true;
    grouped.set(key, group);
  }

  const calledButNeverDeclared: UndeclaredCallFinding[] = [];
  const declaredAndCalled: string[] = [];

  for (const [key, group] of grouped) {
    if (declared.has(key)) {
      declaredAndCalled.push(key);
      continue;
    }
    const routes = [...group.routes];
    const shown = routes.slice(0, maxRoutes);
    calledButNeverDeclared.push({
      key,
      label: callIdentity(group.call),
      method: group.call.method.toUpperCase(),
      template: group.call.template,
      calledFrom: shown,
      occurrences: group.occurrences,
      statuses: [...group.statuses].sort((left, right) => left - right),
      needsCredentials: group.credentials,
      evidence:
        `the UI called it ${group.occurrences} time(s) from ${routes.length} route(s)` +
        (shown.length > 0 ? ` (${shown.join(', ')})` : '') +
        (routes.length > shown.length ? ` and ${routes.length - shown.length} more` : '') +
        '; no source detector declared it',
    });
  }

  const declaredButNeverCalled = [...declared].filter((key) => !grouped.has(key)).sort();

  return {
    calledButNeverDeclared: calledButNeverDeclared.sort(
      (left, right) => right.occurrences - left.occurrences,
    ),
    declaredAndCalled: declaredAndCalled.sort(),
    declaredButNeverCalled,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ITEM 2 — THE REDIRECT AND BOUNCE LEDGER
// ─────────────────────────────────────────────────────────────────────────────

export const BOUNCE_KINDS = [
  /** Asked for it, got it. */
  'NONE',
  /** Redirected within the application. */
  'SAME_ORIGIN_REDIRECT',
  /** Redirected to something that looks like a sign-in surface. */
  'AUTH_WALL',
  /** Redirected off the application's origins — an IdP, a marketing site. */
  'OFF_ORIGIN',
  /** The URL changed with no response: a client-side route guard. */
  'SOFT_NAVIGATION',
  /** It answered with a status of its own and did not move. */
  'ERROR_STATUS',
] as const;
export type BounceKind = (typeof BOUNCE_KINDS)[number];

export const BOUNCE_KIND_LABELS: Record<BounceKind, string> = {
  NONE: 'served the route that was requested',
  SAME_ORIGIN_REDIRECT: 'redirected elsewhere in the application',
  AUTH_WALL: 'bounced to a sign-in surface',
  OFF_ORIGIN: 'bounced to another origin',
  SOFT_NAVIGATION: 'the client changed the URL with no server response',
  ERROR_STATUS: 'answered with an error status',
};

export interface BounceHop {
  /** Path only. A hop to an IdP carries a state token in its query string. */
  path: string;
  origin: string;
}

/**
 * One navigation, recorded against the url that was REQUESTED.
 *
 * The defect in one sentence: crawler.ts stores the node under `page.url()`,
 * which is where it ENDED UP. So /admin/billing → /login stores a /login node
 * and /admin/billing is never in the graph — not as covered, not as uncovered,
 * not as gated. This record is the thing that makes "we asked for
 * /admin/billing and were sent to /login" expressible.
 */
export interface BounceRecord {
  /** Sanitised — see {@link sanitisedUrl}. Never the query string. */
  requestedUrl: string;
  requestedRoute: string;
  /** Sanitised. A bounce to an identity provider carries a state token. */
  finalUrl: string;
  finalRoute: string;
  /**
   * Query parameter NAMES on the destination, which is route shape rather than
   * user data. `?next=/admin/billing` tells a reader the application
   * round-trips the gated route it refused; the VALUE goes with every other
   * value.
   */
  finalQueryParams: string[];
  status: number | null;
  /**
   * The hop chain, or NULL when the adapter cannot report hops. Not `[]`: an
   * empty chain means "we looked and there were no hops", which is a claim this
   * module is not always entitled to make.
   */
  hops: BounceHop[] | null;
  hopsTruncated: boolean;
  originChanged: boolean;
  kind: BounceKind;
  /**
   * The access cell this bounce earned FOR THE REQUESTED ROUTE, ready to push
   * onto `FlowNode.access`. Basis is always OBSERVED here — we asked and this
   * is what came back.
   */
  access: RouteAccess;
}

/**
 * Paths that are a sign-in surface. Narrow on purpose: `/auth` catches
 * `/authorize` and an IdP callback, both of which genuinely are the auth wall,
 * while a word-boundary match keeps `/authors` out of it.
 */
const AUTH_PATH_RE = /\/(login|log-in|signin|sign-in|auth|authorize|sso|session\/new)(\/|$)/i;

/** Whether a path looks like a sign-in surface. Exported so the crawl agrees with us. */
export function looksLikeAuthPath(pathname: string): boolean {
  return AUTH_PATH_RE.test(pathname);
}

/**
 * Records one navigation as a bounce.
 *
 * `normaliseRoute` is injected rather than imported from crawler.ts: this
 * module must not depend on the file that is about to be rewritten around it,
 * and the caller already has the function. Passing it keeps ONE
 * parameterisation in play rather than two that disagree about `/orders/42`.
 */
export function recordBounce(
  nav: ObservedNavigation,
  options: {
    baseUrl: string;
    policy?: CrawlPolicy;
    /** The crawler's `normaliseRoute`. */
    normaliseRoute: (pathname: string) => string;
    /** The role the request was made as; null for anonymous. */
    role?: string | null;
    observedAtIso: string;
    maxHops?: number;
  },
): { record: BounceRecord; cap: ObservationCapBite | null } {
  const maxHops = options.maxHops ?? DEFAULT_OBSERVATION_CAPS.bounceHops;
  const requested = externalParts(nav.requestedUrl);
  const final = externalParts(nav.finalUrl);
  const requestedRoute = requested ? options.normaliseRoute(requested.path) : nav.requestedUrl;
  const finalRoute = final ? options.normaliseRoute(final.path) : nav.finalUrl;
  const originChanged = !isOwnOrigin(options.baseUrl, nav.finalUrl, options.policy);
  // Names only, and the policy's ignored parameters removed, so a tracking
  // parameter on a login redirect does not read as part of the app's shape.
  const finalParams = canonicalCall(
    nav.finalUrl,
    options.policy ?? { ignoredQueryParams: [] },
  ).queryParams;

  let hops: BounceHop[] | null = null;
  let hopsTruncated = false;
  let cap: ObservationCapBite | null = null;
  if (nav.hops !== undefined) {
    const parts = nav.hops.map(externalParts).filter((part): part is NonNullable<typeof part> => {
      return part !== null;
    });
    const kept = parts.slice(0, maxHops);
    hops = kept.map((part) => ({ path: part.path, origin: part.origin }));
    hopsTruncated = parts.length > kept.length;
    if (hopsTruncated) {
      const discarded = parts.length - kept.length;
      cap = {
        cap: 'BOUNCE_HOPS',
        limit: maxHops,
        bites: 1,
        discarded,
        scope: requestedRoute,
        reason:
          `${OBSERVATION_CAP_LABELS.BOUNCE_HOPS} stopped the chain for ${requestedRoute} at ` +
          `${maxHops} hop(s); at least ${discarded} more hop(s) followed`,
      };
    }
  }

  const moved = nav.finalUrl !== nav.requestedUrl;
  const finalPath = final?.path ?? '';
  let kind: BounceKind;
  if (!moved) {
    kind = nav.status !== null && nav.status >= 400 ? 'ERROR_STATUS' : 'NONE';
  } else if (originChanged) {
    kind = 'OFF_ORIGIN';
  } else if (looksLikeAuthPath(finalPath)) {
    kind = 'AUTH_WALL';
  } else if (nav.status === null) {
    // The URL changed and nothing answered: a client-side guard moved us. Worth
    // its own kind because a test for it asserts on the router, not on a status.
    kind = 'SOFT_NAVIGATION';
  } else {
    kind = 'SAME_ORIGIN_REDIRECT';
  }

  const outcome: RouteAccess['outcome'] =
    kind === 'NONE'
      ? 'ALLOWED'
      : kind === 'ERROR_STATUS'
        ? 'DENIED'
        : // AUTH_WALL, OFF_ORIGIN, SAME_ORIGIN_REDIRECT and SOFT_NAVIGATION all
          // mean the same thing about the route we asked for: we did not get it,
          // and we were sent somewhere. REDIRECTED carries the destination,
          // which is the part a reader needs.
          'REDIRECTED';

  return {
    record: {
      requestedUrl: sanitisedUrl(nav.requestedUrl),
      requestedRoute,
      finalUrl: sanitisedUrl(nav.finalUrl),
      finalRoute,
      finalQueryParams: finalParams,
      status: nav.status,
      hops,
      hopsTruncated,
      originChanged,
      kind,
      access: {
        role: options.role ?? null,
        outcome,
        status: nav.status,
        destinationRoute: outcome === 'REDIRECTED' ? finalRoute : null,
        basis: 'OBSERVED',
        observedAtIso: options.observedAtIso,
      },
    },
    cap,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ITEM 3 — THE INTERSTITIAL AND BOT-WALL CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

export const INTERSTITIAL_KINDS = [
  'NONE',
  'BOT_CHALLENGE',
  'CONSENT_WALL',
  'MAINTENANCE',
  'GEO_BLOCK',
  'AGE_GATE',
  'LOGIN_WALL',
] as const;
export type InterstitialKind = (typeof INTERSTITIAL_KINDS)[number];

export const INTERSTITIAL_KIND_LABELS: Record<InterstitialKind, string> = {
  NONE: 'the application answered',
  BOT_CHALLENGE: 'a bot-protection challenge answered instead of the application',
  CONSENT_WALL: 'a consent wall answered instead of the application',
  MAINTENANCE: 'a maintenance page answered instead of the application',
  GEO_BLOCK: 'the application refused this location',
  AGE_GATE: 'an age gate answered instead of the application',
  LOGIN_WALL: 'a sign-in wall answered every URL',
};

/**
 * The signals, each one named so a reader can discount a weak one.
 *
 * STRONG signals are things only an interstitial produces: a vendor's own
 * response header, a 451, a challenge script host, a one-node crawl whose
 * single node has no application chrome at all. WEAK signals are English
 * phrases — they are kept because they are genuinely informative when they
 * agree with a strong signal, and they are never sufficient alone, because the
 * three-English-sentences heuristic in crawler.ts is the exact mistake this
 * module exists to stop repeating. A customer's app in German would be
 * classified as fine by a phrase list and as blocked by the structure.
 */
export const INTERSTITIAL_SIGNALS = [
  'CHALLENGE_HEADER',
  'CHALLENGE_SCRIPT_HOST',
  'CHALLENGE_STATUS',
  'RETRY_AFTER',
  'LEGAL_BLOCK_STATUS',
  'MAINTENANCE_STATUS',
  'NO_APP_CHROME',
  'SINGLE_NODE_CRAWL',
  'EVERY_ROUTE_SAME_TITLE',
  'PHRASE',
] as const;
export type InterstitialSignalId = (typeof INTERSTITIAL_SIGNALS)[number];

export interface InterstitialSignal {
  signal: InterstitialSignalId;
  strength: 'STRONG' | 'WEAK';
  detail: string;
}

export interface InterstitialFinding {
  kind: InterstitialKind;
  /** Every signal that fired, so a reader can see what the verdict rests on. */
  signals: InterstitialSignal[];
  /**
   * True only when a STRONG signal fired. This is the flag that stops the crawl
   * reporting a complete enumeration of one page, so a phrase match may not
   * set it.
   */
  blocksEnumeration: boolean;
  /** The sentence the crawl's report prints. Never null when it blocks. */
  reason: string | null;
  /**
   * A `CrawlDegradation` ONLY when one of the existing seven kinds honestly
   * describes what we saw. Null otherwise — see the comment on
   * {@link holdForInterstitial} for why that null is not a shrug.
   */
  degradation: CrawlDegradation | null;
}

/** Response-header names that only a challenge or a maintenance page sets. */
const CHALLENGE_HEADERS: readonly string[] = [
  'cf-mitigated',
  'cf-chl-bypass',
  'x-datadome',
  'x-datadome-cid',
  'x-iinfo',
  'x-sucuri-id',
  'x-akamai-bot-manager',
  'x-maintenance-mode',
  'x-maintenance',
];

/** Hosts that serve a challenge and never an application. */
const CHALLENGE_SCRIPT_HOSTS: readonly string[] = [
  'challenges.cloudflare.com',
  'js.datadome.co',
  'geo.captcha-delivery.com',
  'www.google.com/recaptcha',
  'hcaptcha.com',
  'newassets.hcaptcha.com',
];

/**
 * The weak phrase list. English only, and that is a stated limitation rather
 * than an oversight: a phrase list cannot be completed, so the module is built
 * so that completing it would not change any verdict.
 */
const INTERSTITIAL_PHRASES: ReadonlyArray<{ kind: InterstitialKind; re: RegExp }> = [
  { kind: 'BOT_CHALLENGE', re: /verify(?:ing)? (?:you are|that you are) (?:a )?human/i },
  { kind: 'BOT_CHALLENGE', re: /checking your browser|just a moment|attention required/i },
  { kind: 'BOT_CHALLENGE', re: /enable javascript and cookies to continue/i },
  { kind: 'CONSENT_WALL', re: /we (?:use|and our partners use) cookies/i },
  { kind: 'CONSENT_WALL', re: /accept all cookies|manage (?:your )?(?:cookie )?preferences/i },
  { kind: 'MAINTENANCE', re: /under maintenance|scheduled maintenance|be right back/i },
  { kind: 'GEO_BLOCK', re: /not available in your (?:country|region|location)/i },
  { kind: 'AGE_GATE', re: /are you (?:over|at least) \d{2}|confirm your age/i },
];

export interface InterstitialInput {
  /** The structure read for the node, or null when the read could not run. */
  structure: PageStructure | null;
  status: number | null;
  /** Lower-cased response header names → values, as the adapter passed them. */
  responseHeaders?: Record<string, string>;
  /** How many nodes the whole crawl enumerated. 1 is the signal. */
  nodeCount: number;
  /** Distinct page titles across the crawl. 1 across many URLs is the signal. */
  distinctTitles?: number;
  /** How many URLs were requested, for the every-route-same-title signal. */
  requestedUrlCount?: number;
}

/**
 * Decides whether the crawl was looking at the application.
 *
 * The one rule that matters: `blocksEnumeration` requires a STRONG signal. A
 * false positive here holds a good crawl for review, which is loud and
 * recoverable. A false negative reports a wall as a complete enumeration of a
 * one-page application, which raises the coverage percentage and tells nobody.
 */
export function classifyInterstitial(input: InterstitialInput): InterstitialFinding {
  const signals: InterstitialSignal[] = [];
  const headers = input.responseHeaders ?? {};
  const structure = input.structure;
  /*
   * Claims are COLLECTED and resolved at the end rather than folded into a
   * mutable `kind`, and the first one wins. Order is the precedence: a vendor's
   * own response header is a more specific fact than a page that merely has no
   * links, which is in turn more specific than an English phrase.
   */
  const claims: InterstitialKind[] = [];
  const claim = (next: InterstitialKind): void => {
    claims.push(next);
  };

  for (const name of CHALLENGE_HEADERS) {
    const value = headers[name];
    if (value === undefined) continue;
    const maintenance = name.startsWith('x-maintenance');
    signals.push({
      signal: 'CHALLENGE_HEADER',
      strength: 'STRONG',
      detail: `the response carried ${name}`,
    });
    claim(maintenance ? 'MAINTENANCE' : 'BOT_CHALLENGE');
  }

  for (const host of structure?.scriptOrigins ?? []) {
    const hit = CHALLENGE_SCRIPT_HOSTS.find((known) => host.toLowerCase().includes(known));
    if (hit === undefined) continue;
    signals.push({
      signal: 'CHALLENGE_SCRIPT_HOST',
      strength: 'STRONG',
      detail: `the page loaded a challenge script from ${hit}`,
    });
    claim('BOT_CHALLENGE');
  }

  if (input.status === 403 && headers['server']?.toLowerCase().includes('cloudflare')) {
    signals.push({
      signal: 'CHALLENGE_STATUS',
      strength: 'STRONG',
      detail: 'a 403 from a Cloudflare edge, which an application does not serve for its own pages',
    });
    claim('BOT_CHALLENGE');
  }
  if (input.status === 451) {
    signals.push({
      signal: 'LEGAL_BLOCK_STATUS',
      strength: 'STRONG',
      detail: '451 Unavailable For Legal Reasons',
    });
    claim('GEO_BLOCK');
  }
  if (input.status === 503) {
    signals.push({
      signal: 'MAINTENANCE_STATUS',
      strength: 'STRONG',
      detail: '503 Service Unavailable',
    });
    claim('MAINTENANCE');
  }
  if (headers['retry-after'] !== undefined) {
    signals.push({
      signal: 'RETRY_AFTER',
      strength: 'WEAK',
      detail: `the response asked us to retry after ${headers['retry-after']}`,
    });
  }

  /*
   * THE STRUCTURAL SIGNAL, and the one that catches a vendor we have never
   * heard of. An application's page has chrome: links to itself, a landmark, a
   * form, something. A challenge page has a heading, a spinner and nothing
   * else. Requiring BOTH no-chrome AND a one-node crawl is what keeps this off
   * a legitimate single-page landing site, which has links.
   */
  if (structure) {
    const noChrome =
      structure.sameOriginLinkCount === 0 &&
      structure.formCount === 0 &&
      structure.landmarks.length === 0;
    if (noChrome) {
      signals.push({
        signal: 'NO_APP_CHROME',
        strength: input.nodeCount <= 1 ? 'STRONG' : 'WEAK',
        detail:
          'the page has no same-origin links, no form and no landmark — ' +
          `and the crawl enumerated ${input.nodeCount} node(s)`,
      });
      if (input.nodeCount <= 1) {
        signals.push({
          signal: 'SINGLE_NODE_CRAWL',
          strength: 'STRONG',
          detail: 'the whole crawl enumerated one node, which answered with no application chrome',
        });
        claim(input.status !== null && input.status >= 400 ? 'BOT_CHALLENGE' : 'CONSENT_WALL');
      }
    }
  }

  const requested = input.requestedUrlCount ?? 0;
  if (input.distinctTitles === 1 && requested >= 3) {
    signals.push({
      signal: 'EVERY_ROUTE_SAME_TITLE',
      strength: 'STRONG',
      detail: `${requested} different URLs all returned the same page title`,
    });
    claim('LOGIN_WALL');
  }

  for (const phrase of INTERSTITIAL_PHRASES) {
    const haystack = `${structure?.title ?? ''} ${structure?.textSample ?? ''}`;
    if (!phrase.re.test(haystack)) continue;
    signals.push({
      signal: 'PHRASE',
      strength: 'WEAK',
      detail: `the page text matches a known ${phrase.kind} phrase (English only — a weak signal)`,
    });
    claim(phrase.kind);
  }

  const kind: InterstitialKind = claims[0] ?? 'NONE';
  const strong = signals.filter((signal) => signal.strength === 'STRONG');
  const blocksEnumeration = strong.length > 0 && kind !== 'NONE';

  if (!blocksEnumeration) {
    return {
      // A phrase-only match names what it saw but claims nothing: the kind is
      // reported, the block is not. A page that says "we use cookies" in a
      // banner above a working application is the common case.
      kind: strong.length > 0 ? kind : 'NONE',
      signals,
      blocksEnumeration: false,
      reason: null,
      degradation: null,
    };
  }

  const reason =
    `${INTERSTITIAL_KIND_LABELS[kind]} — this was not the application. ` +
    `Evidence: ${strong.map((signal) => signal.detail).join('; ')}.`;

  /*
   * A degradation only where an existing kind is TRUE of what we saw.
   *
   * CRAWL_DEGRADATIONS has seven members and none of them is "a wall answered
   * instead of your app". Mapping a consent wall onto SITE_DOWN would be a
   * fabricated measurement, which is the one thing this slice may not do, so
   * the mapping is made only where it is honest: a 503 maintenance page really
   * is the site not answering, and a 429 challenge really is rate limiting. For
   * everything else the degradation is null and the sentence carries the fact —
   * see needsFromOtherFiles for the one-line addition that closes this.
   */
  let degradation: CrawlDegradation | null = null;
  if (input.status === 503) {
    degradation = { kind: 'SITE_DOWN', detail: `503 at the entry point — ${reason}`, count: 1 };
  } else if (input.status === 429) {
    degradation = { kind: 'RATE_LIMITED', detail: reason, count: 1 };
  } else if (kind === 'LOGIN_WALL') {
    degradation = { kind: 'NOT_LOGGED_IN', detail: reason, count: 1 };
  }

  return { kind, signals, blocksEnumeration, reason, degradation };
}

/**
 * Folds an interstitial finding into a crawl's adjudication.
 *
 * `adjudicateCrawl` builds its degradations from counts and cannot see a wall:
 * a Cloudflare challenge answering 200 on every URL produces one node, no
 * errors, no throttling and no auth wall, so it adjudicates ACCEPTED and
 * becomes the denominator. This is the hold.
 *
 * It only ever makes the verdict WORSE, never better, and it never invents a
 * degradation kind — when none of the seven fits, the reason sentence carries
 * the fact alone. A CANDIDATE with a reason and no degradation is still refused
 * by nothing in `crawlAcceptanceSchema`, which requires a reason and not a
 * degradation, and that is the right asymmetry: the human-readable sentence is
 * the part a customer acts on.
 */
export function holdForInterstitial(
  acceptance: CrawlAcceptance,
  finding: InterstitialFinding,
): CrawlAcceptance {
  if (!finding.blocksEnumeration || finding.reason === null) return acceptance;
  if (acceptance.state === 'REJECTED') {
    // Already the worst verdict. Add the evidence; do not change the state.
    return { ...acceptance, reasons: [...acceptance.reasons, finding.reason] };
  }
  return {
    ...acceptance,
    state: 'CANDIDATE',
    reasons: [...acceptance.reasons, finding.reason],
    degradations: finding.degradation
      ? [...acceptance.degradations, finding.degradation]
      : acceptance.degradations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ITEM 4 — ERROR-PATH ENUMERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three probes, and each one is a GET.
 *
 * `safeMethodsOnly` is the default and this module respects it rather than
 * arguing with it, which is why UNSUPPORTED_METHOD is interesting: the probe
 * that would prove "PUT /orders/:id answers 405" cannot be issued under the
 * default policy, so it is RECORDED AS REFUSED with the rule that refused it.
 * A refusal in the ledger is a thing a customer can choose to allow; a silent
 * `continue` is a surface that does not exist as far as anyone can tell.
 */
export const PROBE_KINDS = [
  /** A detail template with an id that cannot exist: /orders/:id → /orders/0. */
  'BAD_ID',
  /** The same URL with a method the route should refuse. */
  'UNSUPPORTED_METHOD',
  /** A route whose query parameters were all dropped. */
  'MISSING_REQUIRED_QUERY',
] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

export const PROBE_KIND_LABELS: Record<ProbeKind, string> = {
  BAD_ID: 'a detail route asked for a record that cannot exist',
  UNSUPPORTED_METHOD: 'a route asked with a method it should refuse',
  MISSING_REQUIRED_QUERY: 'a route asked without its query parameters',
};

/**
 * The id used for a BAD_ID probe.
 *
 * `0` and not a random number, and not a large one either. A random id might
 * exist. A large one (999999999) overflows a 32-bit column in some
 * applications and produces a 500 rather than the 404 the probe is testing
 * for, which turns a negative-path probe into a bug report about our probe.
 * `0` is a valid integer literal that no auto-increment key is ever assigned.
 */
export const PROBE_BAD_ID = '0';

/** A probe we intend to issue, or would have. */
export interface ErrorProbe {
  kind: ProbeKind;
  method: string;
  /** The absolute URL to request. */
  url: string;
  /** The template it probes, for attribution. */
  template: string;
  /** Why this probe exists, in the customer's terms. */
  why: string;
  /** What a correct application does. The assertion a generated test inherits. */
  expectation: string;
}

/** A template the crawl actually saw, which is what a probe is derived from. */
export interface ProbeTarget {
  /** Normalised template: `/orders/:id`. */
  template: string;
  /** A real URL observed for it, which the probe mutates. */
  sampleUrl: string;
  /** Query parameter names seen on it, for the MISSING_REQUIRED_QUERY probe. */
  queryParams?: string[];
}

/**
 * Plans the probes for a crawl, and records every one the policy refuses.
 *
 * Deterministic: same templates in, same probes out, so a probe appearing or
 * disappearing between crawls is a fact about the application rather than about
 * us. Nothing here issues a request — the caller does, through the injected
 * navigation — which is what makes the planning testable.
 */
export function planErrorProbes(input: {
  targets: readonly ProbeTarget[];
  policy: CrawlPolicy;
  /** The decision function from @qaai/shared, injected so one rule set applies. */
  policyDecision: (policy: CrawlPolicy, path: string) => { admitted: boolean; rule: string };
  caps?: Partial<ObservationCaps>;
}): { probes: ErrorProbe[]; refused: ExcludedPath[]; caps: ObservationCapBite[] } {
  const caps = { ...DEFAULT_OBSERVATION_CAPS, ...input.caps };
  const probes: ErrorProbe[] = [];
  const refused: ExcludedPath[] = [];
  const perTemplate = new Map<string, number>();
  const tallies = new Map<ObservationCap, CapTally>();

  const bite = (cap: ObservationCap, scope: string, discarded: number): void => {
    const tally = tallies.get(cap) ?? { bites: 0, discarded: 0, scopes: new Set<string>() };
    tally.bites += 1;
    tally.discarded += discarded;
    tally.scopes.add(scope);
    tallies.set(cap, tally);
  };

  /*
   * `kind` is an `ExclusionKind` literal, so removing a member from the shared
   * vocabulary breaks this line at compile time. An earlier version looked the
   * kind up by index and fell back to POLICY_EXCLUDE on a miss, which would
   * have reported a safety refusal as a policy refusal — a quietly wrong
   * ledger entry, and the ledger is the only place a refusal is ever seen.
   */
  const refuse = (probe: ErrorProbe, kind: ExclusionKind, rule: string): void => {
    refused.push({
      url: probe.url,
      route: probe.template,
      kind,
      rule,
      discoveredFrom: `error-path probe (${probe.kind})`,
    });
  };

  for (const target of input.targets) {
    const candidates = probeCandidatesFor(target);
    for (const probe of candidates) {
      /*
       * FOUR GATES, and the ORDER is the honesty.
       *
       * The two POLICY gates run first, so a probe we were never permitted to
       * issue is always recorded as REFUSED with the rule that refused it — it
       * is not a budget decision and must not be hidden behind one. The method
       * gate is first of those because `policyDecision` only judges PATHS and
       * would admit a DELETE to an admitted path, which under `safeMethodsOnly`
       * is precisely the request that must never leave this process.
       *
       * The two CAP gates run last, so `discarded` counts only probes we were
       * willing and allowed to issue. Charging the cap for a probe the policy
       * would have refused anyway would inflate "at least N more error paths
       * existed" with paths we would never have looked at.
       */
      if (input.policy.safeMethodsOnly && probe.method !== 'GET' && probe.method !== 'HEAD') {
        refuse(probe, 'UNSAFE_METHOD', 'safeMethodsOnly: only GET and HEAD are issued');
        continue;
      }
      const path = externalParts(probe.url)?.path ?? probe.template;
      const decision = input.policyDecision(input.policy, path);
      if (!decision.admitted) {
        refuse(probe, 'POLICY_EXCLUDE', decision.rule);
        continue;
      }

      if (probes.length >= caps.probesTotal) {
        bite('PROBES_TOTAL', target.template, 1);
        continue;
      }
      const used = perTemplate.get(target.template) ?? 0;
      if (used >= caps.probesPerTemplate) {
        bite('PROBES_PER_TEMPLATE', target.template, 1);
        continue;
      }

      probes.push(probe);
      perTemplate.set(target.template, used + 1);
    }
  }

  return {
    probes,
    refused,
    caps: [...tallies.entries()].map(([cap, tally]) => ({
      cap,
      limit: cap === 'PROBES_TOTAL' ? caps.probesTotal : caps.probesPerTemplate,
      bites: tally.bites,
      discarded: tally.discarded,
      scope: [...tally.scopes].slice(0, 3).join(', ') || null,
      reason:
        `${OBSERVATION_CAP_LABELS[cap]} stopped ${tally.discarded} probe(s) across ` +
        `${tally.scopes.size} template(s); at least that many error paths were not enumerated`,
    })),
  };
}

/** The candidate probes for one template, before the policy has its say. */
function probeCandidatesFor(target: ProbeTarget): ErrorProbe[] {
  const out: ErrorProbe[] = [];
  const parts = externalParts(target.sampleUrl);
  if (!parts) return out;
  const base = target.sampleUrl.slice(0, target.sampleUrl.length - parts.path.length);

  // BAD_ID, only for a template that actually HAS a parameter. Probing
  // /settings with a bad id is meaningless and would spend the budget.
  if (/:[A-Za-z_]|\/:id|:id\b/.test(target.template) || target.template.includes(PLACEHOLDER.id)) {
    const path = target.template
      .replace(/:(?:id|uuid|token|hash|date|param|email|phone|card|national-id)\b/g, PROBE_BAD_ID)
      .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, PROBE_BAD_ID);
    out.push({
      kind: 'BAD_ID',
      method: 'GET',
      url: `${base}${path}`,
      template: target.template,
      why: `${target.template} takes an identifier; nothing enumerates what it does with a bad one`,
      expectation: 'a 404 (or a 403), with an error page the user can act on — never a 500',
    });
    out.push({
      kind: 'UNSUPPORTED_METHOD',
      method: 'DELETE',
      url: target.sampleUrl,
      template: target.template,
      why: `${target.template} should refuse a method it does not implement`,
      expectation: 'a 405 with an Allow header, never a 200 and never a 500',
    });
  }

  if ((target.queryParams ?? []).length > 0) {
    out.push({
      kind: 'MISSING_REQUIRED_QUERY',
      method: 'GET',
      url: `${base}${parts.path}`,
      template: target.template,
      why:
        `${target.template} was only ever seen with ${(target.queryParams ?? []).join(', ')}; ` +
        'what it does without them is unenumerated',
      expectation: 'a usable page or a 400 — never a blank screen and never a 500',
    });
  }

  return out;
}

export const PROBE_VERDICTS = [
  /** It answered with an error, as it should. A real, testable error path. */
  'ERROR_PATH_CONFIRMED',
  /** 200 with an error page: the soft 404 that fools every other tool. */
  'SOFT_ERROR',
  /** 200 with content. The application accepted input that cannot be valid. */
  'ACCEPTED_BAD_INPUT',
  /** A 5xx. Not an error path — a defect. */
  'SERVER_FAULT',
  /** Nothing answered, or the probe could not be issued. Never a pass. */
  'UNMEASURED',
] as const;
export type ProbeVerdict = (typeof PROBE_VERDICTS)[number];

export interface ProbeResult {
  probe: ErrorProbe;
  verdict: ProbeVerdict;
  /** Ready to put on `FlowNode.status`. `code: null` is never 200. */
  status: NodeStatus;
  /** The sentence the report prints. */
  detail: string;
  /** True when this is worth a node of its own on the ERROR_STATE axis. */
  isSurface: boolean;
}

/**
 * Judges one probe's answer.
 *
 * ACCEPTED_BAD_INPUT is the finding that earns this item: a detail route that
 * answers 200 for an id that cannot exist is either rendering a shell with no
 * data (a blank-screen defect nobody tests) or serving somebody else's record.
 * SOFT_ERROR is the second: a 200 with an error page is the single case that
 * makes every other tool's enumeration wrong, because status alone says fine.
 */
export function classifyProbe(
  probe: ErrorProbe,
  nav: ObservedNavigation,
  structure: PageStructure | null,
): ProbeResult {
  const statusClass = statusClassFor(nav.status);
  const structural = detectStructuralState(structure);
  const isErrorPage = structural.state === 'ERROR';

  if (nav.failure || nav.status === null) {
    return {
      probe,
      verdict: 'UNMEASURED',
      status: { code: nav.status, class: statusClass, isErrorPage },
      detail:
        nav.failure ??
        'the probe produced no response at all, so nothing is claimed about this error path',
      isSurface: false,
    };
  }

  if (statusClass === 'SERVER_ERROR') {
    return {
      probe,
      verdict: 'SERVER_FAULT',
      status: { code: nav.status, class: statusClass, isErrorPage },
      detail: `${probe.template} answered ${nav.status} — ${probe.expectation}`,
      isSurface: true,
    };
  }
  if (statusClass === 'CLIENT_ERROR') {
    return {
      probe,
      verdict: 'ERROR_PATH_CONFIRMED',
      status: { code: nav.status, class: statusClass, isErrorPage },
      detail: `${probe.template} answered ${nav.status}, which is a real error state to assert on`,
      isSurface: true,
    };
  }
  if (isErrorPage) {
    return {
      probe,
      verdict: 'SOFT_ERROR',
      status: { code: nav.status, class: statusClass, isErrorPage: true },
      detail:
        `${probe.template} answered ${nav.status} and rendered an error state — a soft error. ` +
        `Signals: ${structural.signals.map((hit) => hit.signal).join(', ')}`,
      isSurface: true,
    };
  }

  return {
    probe,
    verdict: 'ACCEPTED_BAD_INPUT',
    status: { code: nav.status, class: statusClass, isErrorPage: false },
    detail:
      `${probe.template} answered ${nav.status} for ${probe.kind === 'BAD_ID' ? 'an id that cannot exist' : 'an input it should refuse'}` +
      ` — ${probe.expectation}`,
    isSurface: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. ITEM 5 — THE RUNTIME ERROR LEDGER
// ─────────────────────────────────────────────────────────────────────────────

export const RUNTIME_ERROR_KINDS = [
  /** An uncaught exception. The page is broken, whatever the status said. */
  'PAGE_ERROR',
  /** console.error. Weaker evidence; applications log deliberately. */
  'CONSOLE_ERROR',
  /** A subresource or XHR that never completed. */
  'REQUEST_FAILED',
  /** A Content-Security-Policy violation: a real, reportable defect. */
  'CSP_VIOLATION',
  /** http:// content on an https:// page. Blocked by the browser, so a defect. */
  'MIXED_CONTENT',
] as const;
export type RuntimeErrorKind = (typeof RUNTIME_ERROR_KINDS)[number];

export const RUNTIME_ERROR_KIND_LABELS: Record<RuntimeErrorKind, string> = {
  PAGE_ERROR: 'an uncaught exception',
  CONSOLE_ERROR: 'a console error',
  REQUEST_FAILED: 'a request that never completed',
  CSP_VIOLATION: 'a Content-Security-Policy violation',
  MIXED_CONTENT: 'mixed content on a secure page',
};

/**
 * One distinct runtime error, deduplicated by signature.
 *
 * Deduplicated and not listed raw, because a React render loop emits the same
 * exception two thousand times in one page load and a raw list would be the
 * whole report. The `occurrences` count is what carries that fact instead.
 */
export interface RuntimeErrorEntry {
  kind: RuntimeErrorKind;
  /** The dedupe key. Stable across runs: no numbers, no ids, no urls. */
  signature: string;
  /** The first message seen for this signature, redacted and capped. */
  message: string;
  /** Extra context: the failing URL's template, the console location. */
  detail: string | null;
  occurrences: number;
  firstRoute: string | null;
  /** Routes it was seen on, capped — the cap is disclosed. */
  sampleRoutes: string[];
  sampleRoutesTruncated: boolean;
  /**
   * The negative test this error seeds, in one sentence. Free test material:
   * an uncaught exception on a page is an assertion waiting to be written.
   */
  seed: string;
}

const CSP_RE = /content security policy|refused to (?:load|execute|connect)|csp/i;
const MIXED_CONTENT_RE = /mixed content|was loaded over https.*requested an insecure/i;
const TLS_FAILURE_RE = /ERR_CERT|ERR_SSL|certificate/i;

/** Which kind a console line actually is. CSP and mixed content hide inside console.error. */
export function runtimeErrorKindForConsole(level: string, text: string): RuntimeErrorKind | null {
  const isError = level.toLowerCase() === 'error';
  if (MIXED_CONTENT_RE.test(text)) return 'MIXED_CONTENT';
  if (CSP_RE.test(text)) return 'CSP_VIOLATION';
  // A warning that is not CSP or mixed content is not an error. Recording
  // console.warn as a defect would bury the real findings under deprecations.
  return isError ? 'CONSOLE_ERROR' : null;
}

/**
 * The dedupe signature: the message with everything variable removed.
 *
 * Numbers, ids, uuids, quoted strings and URLs all go, because they are what
 * differs between two occurrences of ONE defect — `Cannot read 'name' of
 * undefined at Order 41` and `… at Order 42` are one error, and a signature
 * that keeps the number reports them as two. URLs go through the same
 * parameteriser as everything else, so the signature is stable across
 * environments too: a stack frame from staging and one from production
 * collapse.
 */
export function runtimeErrorSignature(kind: RuntimeErrorKind, message: string): string {
  const collapsed = message
    .replace(/https?:\/\/[^\s"')]+/g, (url) => {
      const parts = externalParts(url);
      return parts ? `<url${canonicalCall(url, { ignoredQueryParams: [] }).template}>` : '<url>';
    })
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hash>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/["'`][^"'`]{0,80}["'`]/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 160);
  return `${kind}:${collapsed}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ITEM 6 — STRUCTURAL EMPTY / LOADING / ERROR DETECTION
// ─────────────────────────────────────────────────────────────────────────────

export const STRUCTURAL_STATES = ['LOADING', 'EMPTY', 'ERROR', 'POPULATED', 'UNKNOWN'] as const;
export type StructuralState = (typeof STRUCTURAL_STATES)[number];

export const STRUCTURAL_STATE_LABELS: Record<StructuralState, string> = {
  LOADING: 'still loading',
  EMPTY: 'an empty state',
  ERROR: 'an error state',
  POPULATED: 'populated',
  UNKNOWN: 'not determined',
};

/**
 * The signals, strongest first, each one named in the record so a reader can
 * discount a weak one.
 *
 * ARIA first because it is the only signal a developer wrote ON PURPOSE to
 * mean exactly this: `aria-busy="true"` means loading, `role="alert"` means
 * something went wrong, and both are specified rather than inferred. The
 * skeleton-class heuristic and the English phrases are the guesses, and they
 * are marked as guesses.
 */
export const STRUCTURAL_SIGNALS = [
  'ARIA_BUSY',
  'ROLE_ALERT',
  'ROLE_STATUS',
  'ARIA_LIVE',
  'EMPTY_COLLECTION_WITH_HEADING',
  'SKELETON_CLASS',
  'DISABLED_SUBMIT_ON_PRISTINE_FORM',
  'ERROR_PHRASE',
  'EMPTY_PHRASE',
  'POPULATED_COLLECTION',
] as const;
export type StructuralSignalId = (typeof STRUCTURAL_SIGNALS)[number];

export interface StructuralSignalHit {
  signal: StructuralSignalId;
  /**
   * STRONG for a signal the application author wrote to mean this. WEAK for a
   * heuristic — a class name, an English phrase. A verdict resting only on WEAK
   * signals reports `basis: 'WEAK_ONLY'`, which is what lets a reader distrust
   * it instead of being told a confident wrong answer.
   */
  strength: 'STRONG' | 'WEAK';
  state: StructuralState;
  detail: string;
}

export interface StructuralVerdict {
  state: StructuralState;
  signals: StructuralSignalHit[];
  basis: 'STRONG' | 'WEAK_ONLY' | 'NONE';
  /** Always written. For UNKNOWN it says why we could not tell. */
  why: string;
}

/**
 * The English phrases, kept as a WEAK signal and never as the only one.
 *
 * crawler.ts's three sentences are the first three entries. They are kept
 * because a page that says "no orders yet" IS an empty state and the phrase is
 * real evidence — what was wrong was that it was the ONLY evidence, so the
 * feature worked on QAAI's demo app and nowhere else on earth.
 */
const EMPTY_PHRASES =
  /your cart is empty|no orders yet|no products match|nothing (?:here|to show)|no results|no items|empty|get started by/i;
const ERROR_PHRASES =
  /something went wrong|an error occurred|failed to load|try again|unexpected error|not found/i;

/**
 * Decides whether a page is loading, empty, in error, or populated.
 *
 * Returns UNKNOWN — not POPULATED — when the structure read could not run.
 * crawler.ts's `stateKeyFor` currently catches its own exception and returns
 * `'default'`, which is then stored as a state key as though it were a reading;
 * and when the read succeeds it says `empty ? 'empty' : 'populated'`, so every
 * page whose empty state is not in English becomes 'populated'. Both of those
 * are claims made without evidence, and both are fixed here by having a fourth
 * answer available.
 */
export function detectStructuralState(structure: PageStructure | null): StructuralVerdict {
  if (!structure) {
    return {
      state: 'UNKNOWN',
      signals: [],
      basis: 'NONE',
      why: 'the structural read did not run, so this page’s state was not measured',
    };
  }

  const signals: StructuralSignalHit[] = [];

  if (structure.ariaBusyCount > 0) {
    signals.push({
      signal: 'ARIA_BUSY',
      strength: 'STRONG',
      state: 'LOADING',
      detail: `${structure.ariaBusyCount} element(s) carry aria-busy="true"`,
    });
  }
  if (structure.roleAlertTexts.length > 0) {
    signals.push({
      signal: 'ROLE_ALERT',
      strength: 'STRONG',
      state: 'ERROR',
      detail: `${structure.roleAlertTexts.length} role="alert" region(s)`,
    });
  }
  if (structure.roleStatusTexts.length > 0) {
    /*
     * role=status is genuinely ambiguous — it is used for "Loading…" and for
     * "3 results". So it votes for LOADING only when a phrase agrees, and
     * otherwise it is recorded as a signal that fired without deciding
     * anything. Recording it either way matters: a reader seeing ROLE_STATUS in
     * the list can go and look.
     */
    const loading = /loading|please wait|fetching|saving/i.test(
      structure.roleStatusTexts.join(' '),
    );
    signals.push({
      signal: 'ROLE_STATUS',
      strength: loading ? 'STRONG' : 'WEAK',
      state: loading ? 'LOADING' : 'UNKNOWN',
      detail: `role="status" said ${JSON.stringify(structure.roleStatusTexts.slice(0, 2))}`,
    });
  }
  if (structure.ariaLiveCount > 0) {
    signals.push({
      signal: 'ARIA_LIVE',
      strength: 'WEAK',
      state: 'UNKNOWN',
      detail: `${structure.ariaLiveCount} aria-live region(s) — the page updates in place`,
    });
  }
  if (structure.skeletonClassCount > 0) {
    signals.push({
      signal: 'SKELETON_CLASS',
      strength: 'WEAK',
      state: 'LOADING',
      detail: `${structure.skeletonClassCount} element(s) have a skeleton-shaped class name`,
    });
  }

  const emptyCollections = structure.collections.filter(
    (collection) => collection.rowCount === 0 && collection.heading !== null,
  );
  const fullCollections = structure.collections.filter((collection) => collection.rowCount > 0);
  if (emptyCollections.length > 0 && fullCollections.length === 0) {
    signals.push({
      signal: 'EMPTY_COLLECTION_WITH_HEADING',
      strength: 'STRONG',
      state: 'EMPTY',
      detail:
        `${emptyCollections.length} collection(s) with a heading and no rows ` +
        `(${emptyCollections.map((collection) => collection.selector).join(', ')})`,
    });
  }
  if (fullCollections.length > 0) {
    signals.push({
      signal: 'POPULATED_COLLECTION',
      strength: 'STRONG',
      state: 'POPULATED',
      detail: `${fullCollections.length} collection(s) with rows`,
    });
  }
  if (structure.pristineDisabledSubmitCount > 0) {
    signals.push({
      signal: 'DISABLED_SUBMIT_ON_PRISTINE_FORM',
      strength: 'STRONG',
      state: 'EMPTY',
      detail:
        `${structure.pristineDisabledSubmitCount} form(s) have a disabled submit and no filled ` +
        'field — the untouched state of a form, which is a state worth a test',
    });
  }

  if (ERROR_PHRASES.test(structure.textSample)) {
    signals.push({
      signal: 'ERROR_PHRASE',
      strength: 'WEAK',
      state: 'ERROR',
      detail: 'the page text matches a known English error phrase (weak — English only)',
    });
  }
  if (EMPTY_PHRASES.test(structure.textSample)) {
    signals.push({
      signal: 'EMPTY_PHRASE',
      strength: 'WEAK',
      state: 'EMPTY',
      detail: 'the page text matches a known English empty-state phrase (weak — English only)',
    });
  }

  /*
   * Precedence: ERROR, then LOADING, then EMPTY, then POPULATED. Error first
   * because an error page that also looks empty is an error page, and
   * generating a happy-path test against it is the defect `shouldGenerateAgainst`
   * exists to prevent. Loading before empty because a list that has not
   * arrived is not a list that is empty — calling it empty invents a state the
   * application does not have and a test for it would be flaky forever.
   */
  const strong = signals.filter((hit) => hit.strength === 'STRONG' && hit.state !== 'UNKNOWN');
  const weak = signals.filter((hit) => hit.strength === 'WEAK' && hit.state !== 'UNKNOWN');
  const order: StructuralState[] = ['ERROR', 'LOADING', 'EMPTY', 'POPULATED'];

  for (const state of order) {
    if (strong.some((hit) => hit.state === state)) {
      return {
        state,
        signals,
        basis: 'STRONG',
        why: strong
          .filter((hit) => hit.state === state)
          .map((hit) => hit.detail)
          .join('; '),
      };
    }
  }
  for (const state of order) {
    if (weak.some((hit) => hit.state === state)) {
      return {
        state,
        signals,
        basis: 'WEAK_ONLY',
        why: `only weak signals fired — ${weak
          .filter((hit) => hit.state === state)
          .map((hit) => hit.detail)
          .join('; ')}. Discount this verdict accordingly.`,
      };
    }
  }

  /*
   * No signal fired at all. That is UNKNOWN and not POPULATED: a page with no
   * collection, no aria and no phrase has told us nothing about its state, and
   * "populated" is a claim. The practical consequence is that a plain content
   * page reads UNKNOWN, which is correct — it has no empty/loading/error state
   * to enumerate.
   */
  return {
    state: 'UNKNOWN',
    signals,
    basis: 'NONE',
    why: 'the page carries no state signal — no aria, no collection, no form, no known phrase',
  };
}

/**
 * The state-key fragment the crawl should use in place of
 * `signals.empty ? 'empty' : 'populated'`.
 *
 * Carries the BASIS as well as the state, because two nodes whose emptiness was
 * decided on different evidence are not reliably the same state, and silently
 * merging them loses one.
 */
export function structuralStateKeyPart(verdict: StructuralVerdict): string {
  return `${verdict.state.toLowerCase()}:${verdict.basis.toLowerCase()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. ITEM 7 — DOWNLOAD / EXPORT / DOCUMENT SURFACE
// ─────────────────────────────────────────────────────────────────────────────

export const DOCUMENT_KINDS = [
  'CSV',
  'XLSX',
  'PDF',
  'DOCX',
  'JSON',
  'XML',
  'ZIP',
  'TEXT',
  'IMAGE',
  'PRINT',
  'OTHER',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOWNLOAD_TRIGGERS = [
  /** `<a download>` — declared in the markup, found without clicking anything. */
  'ANCHOR_DOWNLOAD',
  /** A response carrying `Content-Disposition: attachment`. */
  'CONTENT_DISPOSITION',
  /** A download event with no URL: the file was built in the browser. */
  'BLOB_EXPORT',
  /** A print route or a print stylesheet. */
  'PRINT_ROUTE',
  /** A navigation that aborted because the browser downloaded the target. */
  'NAVIGATION_DOWNLOAD',
] as const;
export type DownloadTrigger = (typeof DOWNLOAD_TRIGGERS)[number];

/**
 * A document the application produces.
 *
 * `bodyRead: false` is a literal type and not a comment. The body of an export
 * is the customer's data — a CSV of every member, a PDF invoice — and this
 * module does not read, hash, size or store it. The surface is the OPERATION
 * that produces the file, which is the thing a test drives.
 */
export interface DocumentSurface {
  /**
   * The `CoverageItem.key`, or NULL when no existing axis describes it.
   *
   * Null for a BLOB_EXPORT, and the null is the honest answer rather than a
   * gap: a file the browser assembles has no method and no path, so it is not
   * an ENDPOINT, and `SURFACE_KINDS` has no DOCUMENT axis. Forcing it onto
   * ROUTE would collide with the page's own route key and inflate the
   * denominator by one phantom route per export button. See `axisReason`.
   */
  key: string | null;
  axis: SurfaceKind | null;
  /** Why there is no axis, when there is none. Null when `axis` is set. */
  axisReason: string | null;
  label: string;
  documentKind: DocumentKind;
  trigger: DownloadTrigger;
  /** The interaction that produces it, in the customer's words. */
  interaction: string;
  fromRoute: string | null;
  /** Method and canonical template, when the document has a URL. */
  request: { method: string; template: string } | null;
  /** A literal. The body was never read; see the note above. */
  bodyRead: false;
  /** Always `['CRAWL']` here — this module only ever observes. */
  sources: SurfaceSource[];
  /** Whether a test can drive it, and why not when it cannot. */
  exercise: SurfaceExercise;
}

const EXTENSION_KINDS: ReadonlyArray<{ re: RegExp; kind: DocumentKind }> = [
  { re: /\.csv$/i, kind: 'CSV' },
  { re: /\.(?:xlsx|xls|xlsm)$/i, kind: 'XLSX' },
  { re: /\.pdf$/i, kind: 'PDF' },
  { re: /\.(?:docx|doc|rtf)$/i, kind: 'DOCX' },
  { re: /\.json$/i, kind: 'JSON' },
  { re: /\.xml$/i, kind: 'XML' },
  { re: /\.(?:zip|tar|gz|7z)$/i, kind: 'ZIP' },
  { re: /\.(?:txt|md|log)$/i, kind: 'TEXT' },
  { re: /\.(?:png|jpe?g|gif|svg|webp)$/i, kind: 'IMAGE' },
];

const MIME_KINDS: ReadonlyArray<{ re: RegExp; kind: DocumentKind }> = [
  { re: /text\/csv|application\/csv/i, kind: 'CSV' },
  { re: /spreadsheetml|ms-excel/i, kind: 'XLSX' },
  { re: /application\/pdf/i, kind: 'PDF' },
  { re: /wordprocessingml|msword/i, kind: 'DOCX' },
  { re: /application\/(?:json|ld\+json)/i, kind: 'JSON' },
  { re: /(?:application|text)\/xml/i, kind: 'XML' },
  { re: /application\/(?:zip|x-tar|gzip)/i, kind: 'ZIP' },
  { re: /^text\/plain/i, kind: 'TEXT' },
  { re: /^image\//i, kind: 'IMAGE' },
];

/** Names the document's type from a filename and a content type. Unknown stays OTHER. */
export function documentKindFor(
  filename: string | null | undefined,
  contentType: string | null | undefined,
): DocumentKind {
  // The filename first: `Content-Type: application/octet-stream` is what a
  // badly-configured export server sends for a CSV, and the extension is the
  // more specific fact in that extremely common case.
  for (const entry of EXTENSION_KINDS) {
    if (filename && entry.re.test(filename)) return entry.kind;
  }
  for (const entry of MIME_KINDS) {
    if (contentType && entry.re.test(contentType)) return entry.kind;
  }
  return 'OTHER';
}

/** Whether a `Content-Disposition` header makes this a download. */
export function isAttachment(contentDisposition: string | null | undefined): boolean {
  return /^\s*attachment\b/i.test(contentDisposition ?? '');
}

/** The `filename=` from a Content-Disposition, scrubbed. Null when absent. */
export function dispositionFilename(contentDisposition: string | null | undefined): string | null {
  const raw = contentDisposition ?? '';
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(raw);
  const name = match?.[1]?.trim();
  if (!name) return null;
  /*
   * Through the same classifier as a path segment, because an export filename
   * is a real place customer data appears: `invoice-jane@example.com-2024.pdf`
   * and `statement-4242424242424242.csv` are both filenames applications
   * genuinely generate, and the extension is the only part we need.
   */
  const sanitised = sanitisePath(`/${name}`);
  return sanitised.segments[0]?.text ?? null;
}

/**
 * Builds the document surface for one observation.
 *
 * `normaliseRoute` is injected for the same reason as in `recordBounce`: one
 * parameterisation, and no dependency on the file being rewritten around this
 * one.
 */
export function documentSurfaceFor(input: {
  trigger: DownloadTrigger;
  url: string | null;
  method?: string;
  filename?: string | null;
  contentType?: string | null;
  fromRoute: string | null;
  interaction: string;
  policy: Pick<CrawlPolicy, 'ignoredQueryParams'>;
  /** The crawler's `normaliseRoute`, so an export's template matches its route. */
  normaliseRoute?: (pathname: string) => string;
}): DocumentSurface {
  const documentKind = documentKindFor(input.filename, input.contentType);
  const method = (input.method ?? 'GET').toUpperCase();

  if (input.url === null) {
    return {
      key: null,
      axis: null,
      axisReason:
        'the file is assembled in the browser, so it has no method and no path; SURFACE_KINDS has ' +
        'no DOCUMENT axis and forcing it onto ROUTE would mint a phantom route per export button',
      label: `${documentKind} export from ${input.fromRoute ?? 'an unknown route'}`,
      documentKind,
      trigger: input.trigger,
      interaction: input.interaction,
      fromRoute: input.fromRoute,
      request: null,
      bodyRead: false,
      sources: ['CRAWL'],
      exercise: {
        state: 'UNEXERCISABLE',
        reason: 'CAPABILITY_UNAVAILABLE',
        detail:
          'driving a client-assembled export needs a download sink to assert the file contents; ' +
          'the operation is named here, and nothing is claimed about its output',
      },
    };
  }

  const canonical = canonicalCall(input.url, input.policy, {
    ...(input.normaliseRoute ? { normaliseRoute: input.normaliseRoute } : {}),
  });
  const identity = `${method} ${canonical.template}`;
  return {
    key: surfaceKey('ENDPOINT', identity),
    axis: 'ENDPOINT',
    axisReason: null,
    label: identity,
    documentKind,
    trigger: input.trigger,
    interaction: input.interaction,
    fromRoute: input.fromRoute,
    request: { method, template: canonical.template },
    bodyRead: false,
    sources: ['CRAWL'],
    exercise: {
      state: 'EXERCISABLE',
      detail:
        `a test can request ${identity} and assert the response is a ${documentKind} ` +
        'without reading the body',
    },
  };
}

/**
 * What a failed navigation actually was.
 *
 * THE DEFECT: crawler.ts has one `catch { progress('could not load'); continue; }`,
 * and a download navigation lands in it — Chromium aborts the navigation and
 * `goto` throws `net::ERR_ABORTED`. So every CSV, PDF and XLSX export reachable
 * by a link is recorded as nothing at all: not as surface, not even as an
 * unreachable URL. This function is the fork in that branch.
 */
export const NAVIGATION_FAILURE_KINDS = [
  /** The navigation aborted because the browser downloaded the target. */
  'DOWNLOAD',
  /** TLS verification failed. Feeds `adjudicateCrawl`'s tlsFailureCount. */
  'TLS',
  /** DNS, connection refused, timeout. Genuinely unreachable. */
  'UNREACHABLE',
  /** The adapter reported a failure we do not recognise. Never guessed. */
  'UNCLASSIFIED',
] as const;
export type NavigationFailureKind = (typeof NAVIGATION_FAILURE_KINDS)[number];

const ABORT_RE = /ERR_ABORTED|net::ERR_BLOCKED_BY_RESPONSE|Download is starting/i;

/**
 * Classifies a navigation failure, using the download events that arrived
 * alongside it as the evidence.
 *
 * An abort WITH a download event is a download. An abort WITHOUT one is
 * UNCLASSIFIED rather than UNREACHABLE: an abort has several causes (a
 * client-side redirect racing the load, a blocked response) and claiming the
 * URL does not exist would put a real route into the unreachable count, where
 * it inflates nothing but is simply wrong.
 */
export function classifyNavigationFailure(
  errorText: string,
  downloadsDuringNavigation: number,
): { kind: NavigationFailureKind; why: string } {
  if (TLS_FAILURE_RE.test(errorText)) {
    return { kind: 'TLS', why: `certificate verification failed: ${errorText}` };
  }
  if (ABORT_RE.test(errorText)) {
    return downloadsDuringNavigation > 0
      ? {
          kind: 'DOWNLOAD',
          why: 'the navigation aborted and a download started — the URL serves a file, not a page',
        }
      : {
          kind: 'UNCLASSIFIED',
          why:
            `the navigation aborted (${errorText}) and no download followed; the cause is not ` +
            'determined, so this URL is neither recorded as surface nor as unreachable',
        };
  }
  if (
    /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ETIMEDOUT|Timeout|ERR_EMPTY_RESPONSE/i.test(errorText)
  ) {
    return { kind: 'UNREACHABLE', why: errorText };
  }
  return {
    kind: 'UNCLASSIFIED',
    why: `the navigation failed with an error this module does not classify: ${errorText}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. THE RECORDER
// ─────────────────────────────────────────────────────────────────────────────

/** What the crawl was doing when an event arrived. */
export interface ObservationFocus {
  /** The node's normalised route. Null while a navigation is still in flight. */
  route: string | null;
  /**
   * The interaction being performed: 'load', 'click "Export CSV"', 'submit
   * form-0'. This is the field that makes the network inventory actionable —
   * "POST /api/refunds is called when you press Refund" is a test; "POST
   * /api/refunds exists" is a line in a list.
   */
  interaction: string | null;
}

/** One runtime error as seen at ONE node. The full ledger is crawl-wide. */
export interface NodeErrorSighting {
  signature: string;
  kind: RuntimeErrorKind;
  message: string;
  /** Occurrences AT THIS NODE, not across the crawl. */
  occurrences: number;
}

/** Everything observed while one node was focused. */
export interface NodeObservation {
  route: string | null;
  interaction: string | null;
  calls: ObservedCall[];
  callsTruncated: boolean;
  errors: NodeErrorSighting[];
  errorsTruncated: boolean;
  documents: DocumentSurface[];
  documentsTruncated: boolean;
  /** Download events during this focus. Feeds {@link classifyNavigationFailure}. */
  downloadCount: number;
  /** Off-origin WebSocket origins this node opened. */
  websocketOrigins: string[];
}

/** The whole-crawl observation. This is the object the integrator persists. */
export interface ObservationReport {
  /** Bumped when the stored shape changes, so a reader can refuse an old one. */
  version: 1;
  capabilities: CapabilityReport[];
  calls: ObservedCall[];
  errors: RuntimeErrorEntry[];
  documents: DocumentSurface[];
  bounces: BounceRecord[];
  probes: ProbeResult[];
  /** The entry point's verdict, when one was classified. Null = not classified. */
  interstitial: InterstitialFinding | null;
  /** Off-origin boundaries the NETWORK revealed — not links, calls. */
  externals: Array<{
    kind: 'SCRIPT_HOST' | 'WEBSOCKET';
    origin: string;
    samplePath: string | null;
    fromRoute: string | null;
    occurrences: number;
  }>;
  /**
   * The counts `adjudicateCrawl` needs that only observation can see. The
   * caller passes them straight through; this module does not adjudicate.
   */
  adjudication: {
    throttled: number;
    tlsFailures: number;
    authWallBounces: number;
    serverErrorResponses: number;
  };
  /** Every cap that bit, with `bites` and `discarded`. Empty = none did. */
  caps: ObservationCapBite[];
  /**
   * Events that arrived before any node was focused, or after the last one was
   * taken. Counted rather than dropped: an adapter that attaches late loses
   * the first page's network, and a silent zero would read as a quiet page.
   */
  unattributedEvents: number;
}

export interface ObserveOptions {
  baseUrl: string;
  policy: CrawlPolicy;
  /**
   * The crawler's `normaliseRoute`. REQUIRED, and required rather than
   * defaulted: see {@link canonicalCall}. Without it every observed call keeps
   * the application's own id shapes and one endpoint enters the inventory once
   * per record in the customer's database.
   */
  normaliseRoute: (pathname: string) => string;
  caps?: Partial<ObservationCaps>;
  /**
   * What the adapter can actually do. ANYTHING NOT DECLARED IS UNAVAILABLE —
   * the default direction is "we were not listening", never "there was nothing
   * to hear". An adapter that forgets to declare `CONSOLE_EVENTS` produces a
   * report that says the console was not observed, which is true, rather than
   * one that says the application logged no errors, which would not be.
   */
  capabilities?: Partial<Record<ObserverCapability, boolean | string>>;
  /** Fixed salt for the shared redactor. Tests pass one; production does not. */
  redactionSalt?: string;
}

/**
 * The recorder.
 *
 * Stateful on purpose — events arrive asynchronously and have to be attributed
 * to the node and interaction that caused them, which is a fact only the
 * sequence knows. Everything that makes a JUDGEMENT is a pure function above;
 * this class only attributes, counts and caps.
 *
 * ── Attribution, and the one case it gets right that a naive version does not ─
 *
 * A response can arrive AFTER the crawl has moved on — a slow analytics POST
 * outlives the page that fired it. So a pending request holds a reference to
 * the record it belongs to, and a late response updates THAT record rather than
 * the node that happens to be focused when it lands. Without this, a dashboard's
 * slow call is attributed to the next page the crawl visited, and the
 * "called from" list in the CALLED_BUT_NEVER_DECLARED finding names the wrong
 * route — which is the kind of wrong a customer notices immediately and never
 * forgets.
 */
export class CrawlObserver {
  private readonly options: ObserveOptions;
  private readonly caps: ObservationCaps;
  private readonly redactor: Redactor;

  /** The current focus block. Null until `focus` is called. */
  private current: {
    focus: ObservationFocus;
    calls: Map<string, ObservedCall>;
    callsDiscarded: number;
    errors: Map<string, NodeErrorSighting>;
    errorsDiscarded: number;
    documents: DocumentSurface[];
    documentsDiscarded: number;
    downloads: number;
    websocketOrigins: Set<string>;
  } | null = null;

  private readonly allCalls: ObservedCall[] = [];
  private readonly pending = new Map<string, ObservedCall>();
  private readonly errorLedger = new Map<string, RuntimeErrorEntry>();
  private readonly allDocuments: DocumentSurface[] = [];
  private readonly bounces: BounceRecord[] = [];
  private readonly probes: ProbeResult[] = [];
  private readonly externals = new Map<
    string,
    {
      kind: 'SCRIPT_HOST' | 'WEBSOCKET';
      origin: string;
      samplePath: string | null;
      fromRoute: string | null;
      occurrences: number;
    }
  >();
  private readonly tallies = new Map<ObservationCap, CapTally>();
  private interstitial: InterstitialFinding | null = null;
  private unattributed = 0;
  private throttled = 0;
  private tlsFailures = 0;
  private serverErrorResponses = 0;
  private callsTotal = 0;
  private errorSignaturesDiscarded = 0;

  constructor(options: ObserveOptions) {
    this.options = options;
    this.caps = { ...DEFAULT_OBSERVATION_CAPS, ...options.caps };
    this.redactor = new Redactor(options.redactionSalt);
  }

  /** Subscribes to the event source. The returned function unsubscribes. */
  attach(source: BrowserEventSource): () => void {
    return source.on((event) => {
      this.handle(event);
    });
  }

  /**
   * Starts a new attribution block. Call it before each navigation and before
   * each interaction whose network you want attributed separately.
   */
  focus(focus: ObservationFocus): void {
    this.current = {
      focus,
      calls: new Map(),
      callsDiscarded: 0,
      errors: new Map(),
      errorsDiscarded: 0,
      documents: [],
      documentsDiscarded: 0,
      downloads: 0,
      websocketOrigins: new Set(),
    };
  }

  /** How many downloads have arrived in the current focus block. */
  downloadsInFocus(): number {
    return this.current?.downloads ?? 0;
  }

  /** The observation for the focused block. Does NOT clear it; `focus` does. */
  take(): NodeObservation {
    const block = this.current;
    if (!block) {
      return {
        route: null,
        interaction: null,
        calls: [],
        callsTruncated: false,
        errors: [],
        errorsTruncated: false,
        documents: [],
        documentsTruncated: false,
        downloadCount: 0,
        websocketOrigins: [],
      };
    }
    return {
      route: block.focus.route,
      interaction: block.focus.interaction,
      calls: [...block.calls.values()],
      callsTruncated: block.callsDiscarded > 0,
      errors: [...block.errors.values()],
      errorsTruncated: block.errorsDiscarded > 0,
      documents: [...block.documents],
      documentsTruncated: block.documentsDiscarded > 0,
      downloadCount: block.downloads,
      websocketOrigins: [...block.websocketOrigins],
    };
  }

  /** Records a bounce, and folds in the hop cap if it bit. */
  addBounce(record: BounceRecord, cap?: ObservationCapBite | null): void {
    this.bounces.push(record);
    if (record.kind === 'AUTH_WALL') this.authWalls += 1;
    if (cap) this.mergeCap(cap);
  }

  /** Records the entry point's interstitial verdict. */
  setInterstitial(finding: InterstitialFinding): void {
    this.interstitial = finding;
  }

  /** Records one probe result. */
  addProbe(result: ProbeResult): void {
    this.probes.push(result);
  }

  /** Records a document found by reading the markup rather than by watching. */
  addDocument(surface: DocumentSurface): void {
    this.keepDocument(surface);
  }

  /** Folds in caps produced by a pure planner, e.g. `planErrorProbes`. */
  mergeCaps(caps: readonly ObservationCapBite[]): void {
    for (const cap of caps) this.mergeCap(cap);
  }

  private authWalls = 0;

  report(): ObservationReport {
    return {
      version: 1,
      capabilities: this.capabilityReport(),
      calls: [...this.allCalls],
      errors: [...this.errorLedger.values()].sort(
        (left, right) => right.occurrences - left.occurrences,
      ),
      documents: [...this.allDocuments],
      bounces: [...this.bounces],
      probes: [...this.probes],
      interstitial: this.interstitial,
      externals: [...this.externals.values()].sort(
        (left, right) => right.occurrences - left.occurrences,
      ),
      adjudication: {
        throttled: this.throttled,
        tlsFailures: this.tlsFailures,
        authWallBounces: this.authWalls,
        serverErrorResponses: this.serverErrorResponses,
      },
      caps: this.capBites(),
      unattributedEvents: this.unattributed,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private capabilityReport(): CapabilityReport[] {
    const declared = this.options.capabilities ?? {};
    return OBSERVER_CAPABILITIES.map((capability) => {
      const value = declared[capability];
      if (value === undefined || value === false) {
        return {
          capability,
          state: 'UNAVAILABLE' as const,
          why:
            typeof value === 'string'
              ? value
              : `the adapter did not declare ${OBSERVER_CAPABILITY_LABELS[capability]}, so nothing ` +
                'here was measured — this is not a claim that there was nothing to see',
        };
      }
      return {
        capability,
        state: 'AVAILABLE' as const,
        why: typeof value === 'string' ? value : `${OBSERVER_CAPABILITY_LABELS[capability]} was on`,
      };
    });
  }

  private bite(cap: ObservationCap, scope: string | null, discarded: number): void {
    const tally = this.tallies.get(cap) ?? { bites: 0, discarded: 0, scopes: new Set<string>() };
    tally.bites += 1;
    tally.discarded += discarded;
    if (scope) tally.scopes.add(scope);
    this.tallies.set(cap, tally);
  }

  private mergeCap(cap: ObservationCapBite): void {
    const tally = this.tallies.get(cap.cap) ?? {
      bites: 0,
      discarded: 0,
      scopes: new Set<string>(),
    };
    tally.bites += cap.bites;
    tally.discarded += cap.discarded;
    if (cap.scope) tally.scopes.add(cap.scope);
    this.tallies.set(cap.cap, tally);
  }

  private limitFor(cap: ObservationCap): number {
    switch (cap) {
      case 'CALLS_PER_NODE':
        return this.caps.callsPerNode;
      case 'CALLS_TOTAL':
        return this.caps.callsTotal;
      case 'ERRORS_PER_NODE':
        return this.caps.errorsPerNode;
      case 'ERROR_SIGNATURES_TOTAL':
        return this.caps.errorSignaturesTotal;
      case 'ERROR_SAMPLE_ROUTES':
        return this.caps.errorSampleRoutes;
      case 'DOCUMENTS_PER_NODE':
        return this.caps.documentsPerNode;
      case 'BOUNCE_HOPS':
        return this.caps.bounceHops;
      case 'PROBES_PER_TEMPLATE':
        return this.caps.probesPerTemplate;
      case 'PROBES_TOTAL':
        return this.caps.probesTotal;
    }
  }

  private capBites(): ObservationCapBite[] {
    return [...this.tallies.entries()]
      .filter(([, tally]) => tally.bites > 0)
      .map(([cap, tally]) => ({
        cap,
        limit: this.limitFor(cap),
        bites: tally.bites,
        discarded: tally.discarded,
        scope: [...tally.scopes].slice(0, 3).join(', ') || null,
        reason:
          `${OBSERVATION_CAP_LABELS[cap]} bit ${tally.bites} time(s) and discarded ` +
          `${tally.discarded} observation(s)` +
          (tally.scopes.size > 0 ? ` across ${tally.scopes.size} scope(s)` : '') +
          '; at least that many more existed',
      }));
  }

  private handle(event: BrowserEvent): void {
    switch (event.kind) {
      case 'request':
        this.onRequest(event.request);
        return;
      case 'response':
        this.onResponse(event.response);
        return;
      case 'requestfailed':
        this.onRequestFailed(event.request, event.errorText);
        return;
      case 'websocket':
        this.onWebSocket(event.url);
        return;
      case 'console': {
        const kind = runtimeErrorKindForConsole(event.level, event.text);
        if (kind === null) return;
        this.recordError(kind, event.text, event.location ?? null);
        return;
      }
      case 'pageerror':
        this.recordError('PAGE_ERROR', event.message, event.stack ?? null);
        return;
      case 'download':
        this.onDownload(event);
        return;
    }
  }

  /** One canonicalisation for the whole recorder: redact, then collapse. */
  private canonical(url: string): {
    template: string;
    origin: string | null;
    queryParams: string[];
  } {
    return canonicalCall(url, this.options.policy, {
      redactor: this.redactor,
      normaliseRoute: this.options.normaliseRoute,
    });
  }

  private pendingKey(request: RawRequest): string {
    return `${request.method.toUpperCase()} ${request.url}`;
  }

  private onRequest(request: RawRequest): void {
    const block = this.current;
    if (!block) {
      this.unattributed += 1;
      return;
    }
    if (this.callsTotal >= this.caps.callsTotal) {
      block.callsDiscarded += 1;
      this.bite('CALLS_TOTAL', block.focus.route, 1);
      return;
    }

    const canonical = this.canonical(request.url);
    const transport = request.isNavigation ? 'NAVIGATION' : transportFor(request.resourceType);
    /*
     * Header values are read HERE and nowhere else, and only to produce two
     * lists of NAMES. `headers` is not stored on the record and `ObservedCall`
     * has no field that could hold a value, so this is the only place in the
     * module where a secret is in scope at all — which is what makes the
     * guarantee auditable rather than aspirational.
     */
    const headerNames = Object.keys(request.headers ?? {})
      .map((name) => name.toLowerCase())
      .sort();
    const credentialHeaderNames = headerNames.filter((name) =>
      CREDENTIAL_HEADER_NAMES.includes(name),
    );
    if (credentialHeaderNames.length > 0)
      this.redactor.count('HEADER', credentialHeaderNames.length);

    const identity = `${transport} ${request.method.toUpperCase()} ${canonical.template} ${canonical.origin ?? ''}`;
    const existing = block.calls.get(identity);
    if (existing) {
      existing.occurrences += 1;
      this.pending.set(this.pendingKey(request), existing);
      return;
    }

    if (block.calls.size >= this.caps.callsPerNode) {
      block.callsDiscarded += 1;
      this.bite('CALLS_PER_NODE', block.focus.route, 1);
      return;
    }

    const offOrigin = !isOwnOrigin(this.options.baseUrl, request.url, this.options.policy);
    const call: ObservedCall = {
      transport,
      method: request.method.toUpperCase(),
      template: canonical.template,
      origin: canonical.origin,
      offOrigin,
      // Null, and null is the honest value: nothing has answered yet. A reader
      // that saw 0 here would read "status zero", and a reader that saw 200
      // would be reading a fact nobody measured.
      status: null,
      statusClass: 'UNKNOWN',
      contentType: null,
      queryParams: canonical.queryParams,
      headerNames,
      credentialHeaderNames,
      occurrences: 1,
      fromRoute: block.focus.route,
      interaction: block.focus.interaction,
      failure: null,
    };
    block.calls.set(identity, call);
    this.allCalls.push(call);
    this.callsTotal += 1;
    this.pending.set(this.pendingKey(request), call);

    if (offOrigin && API_TRANSPORTS.includes(transport)) {
      this.recordExternal('SCRIPT_HOST', request.url, block.focus.route);
    }
  }

  private onResponse(response: RawResponse): void {
    const key = this.pendingKey(response.request);
    const call = this.pending.get(key);
    if (response.status === 429 || response.status === 503) this.throttled += 1;
    if (response.status >= 500) this.serverErrorResponses += 1;

    /*
     * A download found by WATCHING: `Content-Disposition: attachment` on any
     * response, whether or not a navigation was involved. This is how an export
     * triggered by a button — which produces no navigation at all — becomes
     * surface.
     */
    if (isAttachment(response.contentDisposition)) {
      const filename = dispositionFilename(response.contentDisposition);
      this.keepDocument(
        documentSurfaceFor({
          trigger: 'CONTENT_DISPOSITION',
          url: response.request.url,
          method: response.request.method,
          filename,
          contentType: response.contentType ?? null,
          fromRoute: call?.fromRoute ?? this.current?.focus.route ?? null,
          interaction: call?.interaction ?? this.current?.focus.interaction ?? 'a response',
          policy: this.options.policy,
          normaliseRoute: this.options.normaliseRoute,
        }),
      );
    }

    if (!call) {
      // A response with no request we recorded: the request arrived before the
      // first `focus`, or past a cap. Counted, never silently dropped.
      this.unattributed += 1;
      return;
    }
    call.status = response.status;
    call.statusClass = statusClassFor(response.status);
    call.contentType = response.contentType ?? null;
    this.pending.delete(key);
  }

  private onRequestFailed(request: RawRequest, errorText: string): void {
    if (TLS_FAILURE_RE.test(errorText)) this.tlsFailures += 1;
    const key = this.pendingKey(request);
    const call = this.pending.get(key);
    if (call) {
      call.failure = errorText;
      this.pending.delete(key);
    }
    /*
     * A failed request is a runtime error AND an enumeration fact, so it is
     * recorded in both places. An aborted download is neither — it is how a
     * download looks from the network's side — so it is excluded here and
     * handled by the download event instead.
     */
    if (ABORT_RE.test(errorText)) return;
    const canonical = this.canonical(request.url);
    this.recordError(
      'REQUEST_FAILED',
      `${request.method.toUpperCase()} ${canonical.template} failed: ${errorText}`,
      null,
    );
  }

  private onWebSocket(url: string): void {
    const block = this.current;
    if (!block) {
      this.unattributed += 1;
      return;
    }
    if (isOwnOrigin(this.options.baseUrl, url, this.options.policy)) {
      const canonical = this.canonical(url);
      const identity = `WEBSOCKET WS ${canonical.template} ${canonical.origin ?? ''}`;
      const existing = block.calls.get(identity);
      if (existing) {
        existing.occurrences += 1;
        return;
      }
      if (block.calls.size >= this.caps.callsPerNode) {
        block.callsDiscarded += 1;
        this.bite('CALLS_PER_NODE', block.focus.route, 1);
        return;
      }
      const call: ObservedCall = {
        transport: 'WEBSOCKET',
        // Not GET. A socket has no method, and writing GET here would put a
        // fictional HTTP operation into the endpoint inventory.
        method: 'WS',
        template: canonical.template,
        origin: canonical.origin,
        offOrigin: false,
        status: null,
        statusClass: 'UNKNOWN',
        contentType: null,
        queryParams: canonical.queryParams,
        headerNames: [],
        credentialHeaderNames: [],
        occurrences: 1,
        fromRoute: block.focus.route,
        interaction: block.focus.interaction,
        failure: null,
      };
      block.calls.set(identity, call);
      this.allCalls.push(call);
      this.callsTotal += 1;
      return;
    }
    const parts = externalParts(url);
    if (parts) block.websocketOrigins.add(parts.origin);
    this.recordExternal('WEBSOCKET', url, block.focus.route);
  }

  private onDownload(event: Extract<BrowserEvent, { kind: 'download' }>): void {
    const block = this.current;
    if (!block) {
      this.unattributed += 1;
      return;
    }
    block.downloads += 1;
    this.keepDocument(
      documentSurfaceFor({
        trigger: event.url === null ? 'BLOB_EXPORT' : 'NAVIGATION_DOWNLOAD',
        url: event.url,
        method: 'GET',
        filename: event.suggestedFilename ?? null,
        contentType: event.mimeType ?? null,
        fromRoute: block.focus.route,
        interaction: block.focus.interaction ?? 'a download',
        policy: this.options.policy,
        normaliseRoute: this.options.normaliseRoute,
      }),
    );
  }

  private keepDocument(surface: DocumentSurface): void {
    const block = this.current;
    /*
     * Deduplicated on the key, with a null key (a blob export) deduplicated on
     * route + interaction + type instead. Without the second rule every click
     * of an export button mints a surface and the document inventory counts
     * one button ten times.
     *
     * DEDUPE BEFORE THE CAP, which is the order `recordRequest` already uses
     * twenty lines of reasoning away and the order this one did not. Charging
     * the cap first means a page whose single export button is clicked thirty
     * times reports `DOCUMENTS_PER_NODE` with ten `discarded` — "at least ten
     * more documents existed" — when every one of them was the document
     * already in the list. A cap's `discarded` count is the one number a
     * reader is invited to treat as a floor on what was missed, so charging it
     * for a repeat of something we KEPT invents that floor. The probe planner
     * states the same rule for itself: `discarded` counts only what we were
     * willing and able to record.
     */
    const identity =
      surface.key ??
      `BLOB ${surface.fromRoute ?? ''} ${surface.interaction} ${surface.documentKind}`;
    if (this.documentIdentities.has(identity)) return;
    if (block && block.documents.length >= this.caps.documentsPerNode) {
      block.documentsDiscarded += 1;
      this.bite('DOCUMENTS_PER_NODE', block.focus.route, 1);
      return;
    }
    this.documentIdentities.add(identity);
    this.allDocuments.push(surface);
    block?.documents.push(surface);
  }

  private readonly documentIdentities = new Set<string>();

  private recordExternal(
    kind: 'SCRIPT_HOST' | 'WEBSOCKET',
    url: string,
    fromRoute: string | null,
  ): void {
    const parts = externalParts(url);
    if (!parts) return;
    const key = `${kind} ${parts.origin}`;
    const existing = this.externals.get(key);
    if (existing) {
      existing.occurrences += 1;
      return;
    }
    // Origin and PATH only, never the query: a third-party call carries an api
    // key, a tenant and a user hint in its query string, and a flow map is
    // stored, exported and rendered in a cockpit.
    this.externals.set(key, {
      kind,
      origin: parts.origin,
      samplePath: parts.path,
      fromRoute,
      occurrences: 1,
    });
  }

  private recordError(kind: RuntimeErrorKind, message: string, detail: string | null): void {
    const block = this.current;
    const route = block?.focus.route ?? null;
    const signature = runtimeErrorSignature(kind, message);

    if (block) {
      if (block.errors.size >= this.caps.errorsPerNode && !block.errors.has(signature)) {
        block.errorsDiscarded += 1;
        this.bite('ERRORS_PER_NODE', route, 1);
        return;
      }
      const sighting = block.errors.get(signature);
      if (sighting) {
        sighting.occurrences += 1;
      } else {
        block.errors.set(signature, {
          signature,
          kind,
          message: message.slice(0, 300),
          occurrences: 1,
        });
      }
    } else {
      this.unattributed += 1;
    }

    const entry = this.errorLedger.get(signature);
    if (entry) {
      entry.occurrences += 1;
      if (route && !entry.sampleRoutes.includes(route)) {
        if (entry.sampleRoutes.length >= this.caps.errorSampleRoutes) {
          entry.sampleRoutesTruncated = true;
          this.bite('ERROR_SAMPLE_ROUTES', signature, 1);
        } else {
          entry.sampleRoutes.push(route);
        }
      }
      return;
    }

    if (this.errorLedger.size >= this.caps.errorSignaturesTotal) {
      this.errorSignaturesDiscarded += 1;
      this.bite('ERROR_SIGNATURES_TOTAL', route, 1);
      return;
    }

    this.errorLedger.set(signature, {
      kind,
      signature,
      message: message.slice(0, 300),
      detail: detail === null ? null : detail.slice(0, 300),
      occurrences: 1,
      firstRoute: route,
      sampleRoutes: route ? [route] : [],
      sampleRoutesTruncated: false,
      seed: seedFor(kind, route),
    });
  }
}

/** The negative test an error seeds, in one sentence a plan item can carry. */
function seedFor(kind: RuntimeErrorKind, route: string | null): string {
  const where = route ? `on ${route}` : 'somewhere in the crawl';
  switch (kind) {
    case 'PAGE_ERROR':
      return `assert no uncaught exception is thrown while ${where} loads`;
    case 'CONSOLE_ERROR':
      return `assert the console carries no error while ${where} loads`;
    case 'REQUEST_FAILED':
      return `assert every request ${where} issues completes`;
    case 'CSP_VIOLATION':
      return `assert ${where} loads with no Content-Security-Policy violation`;
    case 'MIXED_CONTENT':
      return `assert ${where} loads no insecure subresource`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. READING ONE BACK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses a stored observation report, and returns NULL for anything it cannot
 * read.
 *
 * Null means "this crawl has no observation" — which is true of every flow map
 * already on disk and must never be rendered as "this crawl observed nothing".
 * A version this build does not know also comes back null rather than being
 * partially believed: half a report read by the wrong reader is how a cap that
 * bit stops being disclosed.
 */
export function parseStoredObservation(value: unknown): ObservationReport | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['version'] !== 1) return null;
  const list = (key: string): unknown[] => (Array.isArray(row[key]) ? (row[key] as unknown[]) : []);
  const adjudication =
    typeof row['adjudication'] === 'object' && row['adjudication'] !== null
      ? (row['adjudication'] as Record<string, unknown>)
      : {};
  const count = (key: string): number =>
    typeof adjudication[key] === 'number' ? (adjudication[key] as number) : 0;

  return {
    version: 1,
    capabilities: list('capabilities') as CapabilityReport[],
    calls: list('calls') as ObservedCall[],
    errors: list('errors') as RuntimeErrorEntry[],
    documents: list('documents') as DocumentSurface[],
    bounces: list('bounces') as BounceRecord[],
    probes: list('probes') as ProbeResult[],
    interstitial:
      typeof row['interstitial'] === 'object' && row['interstitial'] !== null
        ? (row['interstitial'] as InterstitialFinding)
        : null,
    externals: list('externals') as ObservationReport['externals'],
    adjudication: {
      throttled: count('throttled'),
      tlsFailures: count('tlsFailures'),
      authWallBounces: count('authWallBounces'),
      serverErrorResponses: count('serverErrorResponses'),
    },
    caps: list('caps') as ObservationCapBite[],
    unattributedEvents:
      typeof row['unattributedEvents'] === 'number' ? (row['unattributedEvents'] as number) : 0,
  };
}

/**
 * The sentences a report prints about what observation could and could not see.
 *
 * Collected in one function because the disclosure is the product: a cap that
 * bit, a capability that was missing and an unattributed event are each a
 * reason the numbers above them are a floor rather than a total, and a reader
 * who has to assemble that themselves will not.
 */
export function observationCaveats(report: ObservationReport): string[] {
  const out: string[] = [];
  for (const capability of report.capabilities) {
    if (capability.state === 'UNAVAILABLE') {
      out.push(
        `${OBSERVER_CAPABILITY_LABELS[capability.capability]} was not available: ${capability.why}`,
      );
    }
  }
  for (const cap of report.caps) out.push(cap.reason);
  if (report.unattributedEvents > 0) {
    out.push(
      `${report.unattributedEvents} browser event(s) arrived with no node focused and could not ` +
        'be attributed; they are counted here and not in any node',
    );
  }
  if (report.interstitial?.blocksEnumeration && report.interstitial.reason) {
    out.push(report.interstitial.reason);
  }
  return out;
}
