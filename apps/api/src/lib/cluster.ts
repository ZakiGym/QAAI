/**
 * Failure clustering (§3.3) — forty tests failed, one thing broke.
 *
 * When a shared dependency dies, a suite does not produce one failure. It
 * produces every failure downstream of that dependency, each with its own test
 * name, its own screenshot, and its own triage card. Working through them one at
 * a time is the tax this product exists to remove: the answer to all forty is
 * the same sentence, and a human should read it once.
 *
 * The whole job is normalisation. Two failures belong together when what broke
 * is the same, and the raw error text never says that directly — it is buried
 * under absolute paths, line numbers, timestamps, cuids, ports, and whatever
 * dynamic value happened to be interpolated into the message on that run. So
 * every volatile token is replaced with a placeholder and what remains — the
 * error class, the assertion, the locator, the endpoint — becomes the signature.
 * Equal signatures cluster.
 *
 * The rules are deliberately asymmetric about quoted strings, and that is the
 * subtlest decision in here: a quoted value inside a *locator* is source code
 * (`getByRole('button', { name: 'Save' })`) and must survive, or every locator
 * failure in the suite collapses into one meaningless cluster. A quoted value
 * inside a *message* is runtime data and must not survive, or nothing groups.
 * Same characters, opposite treatment, decided by which facet they sit in.
 *
 * ─── Normalisation examples (raw input -> signature) ────────────────────────
 *
 *  in   Error: expect(received).toBe(expected)
 *         Expected: 4
 *         Received: 3
 *           at /Users/dana/app/tests/cart.spec.ts:41:22
 *  out  class=Error | assert=toBe | msg=error: expect(received).tobe(expected)
 *       | expected: <n> | received: <n>
 *
 *  in   page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/login
 *  out  class=net::ERR_CONNECTION_REFUSED | call=page.goto |
 *       url=http://localhost/login | msg=page.goto:
 *       net::err_connection_refused at http://localhost/login
 *
 *  in   TimeoutError: locator.click: Timeout 30000ms exceeded.
 *       Call log:
 *         - waiting for getByRole('button', { name: 'Checkout' })
 *  out  class=TimeoutError | call=locator.click |
 *       selector=getByRole('button', { name: 'Checkout' }) |
 *       msg=timeouterror: locator.click: timeout <n>ms exceeded.
 *
 *  in   Expected HTTP 200, got 503 for GET
 *       https://api.acme.io/v2/orders/8813?ts=1753931234567
 *  out  assert=http-status | url=https://api.acme.io/v2/orders/<id>?ts |
 *       http=503 | msg=expected http <n>, got <n> for get
 *       https://api.acme.io/v2/orders/<id>?ts
 *
 *  in   Error: expect(locator).toBeVisible() failed
 *       Locator:  getByTestId('cart-total')
 *       Expected: visible
 *       Received: hidden
 *       Timeout:  5000ms
 *       Call log: …
 *  out  class=Error | assert=toBeVisible | selector=getByTestId('cart-total') |
 *       msg=error: expect(locator).tobevisible() failed | expected: visible |
 *       received: hidden
 *
 * The fourth is the point of the feature: forty tests hitting forty different
 * order ids at forty different millisecond timestamps on forty different worker
 * ports produce one signature, and a person reads one sentence.
 */

import { createHash } from 'node:crypto';
import type { Verdict } from '@qaai/shared';

// ─── Input ───────────────────────────────────────────────────────────────────

export interface FailureStepInput {
  index: number;
  status: string;
  title: string;
  errorMessage: string | null;
  errorStack: string | null;
  /** The locator that failed. Already parsed out by the runner — trust it. */
  selector: string | null;
  expected: string | null;
  actual: string | null;
}

export interface FailureNetworkInput {
  method: string;
  url: string;
  status: number | null;
}

export interface FailureInput {
  testResultId: string;
  testId: string;
  testName: string;
  filePath: string | null;
  status: string;
  errorMessage: string | null;
  retriedAndPassed: boolean;
  steps: FailureStepInput[];
  network: FailureNetworkInput[];
  /** What triage already decided, if it ran. A human override outranks it. */
  verdict: { verdict: Verdict; overriddenTo: Verdict | null; reviewState: string } | null;
}

// ─── Output ──────────────────────────────────────────────────────────────────

/** The facts that survive normalisation. Everything else is noise by definition. */
export interface FailureFacets {
  /** `TimeoutError`, `net::ERR_CONNECTION_REFUSED`, `ECONNREFUSED`, … */
  errorClass: string | null;
  /** The Playwright call that threw: `page.goto`, `locator.click`. */
  call: string | null;
  /** The matcher that failed: `toBeVisible`, `toHaveText`, `http-status`. */
  assertion: string | null;
  /** The locator, kept close to verbatim — it is code, not data. */
  selector: string | null;
  /** Failing URL or endpoint, with dynamic path segments and query values gone. */
  endpoint: string | null;
  httpStatus: number | null;
  /** What is left of the message once the above are lifted out and scrubbed. */
  message: string;
}

export interface ClusterMember {
  testResultId: string;
  testId: string;
  testName: string;
  filePath: string | null;
  status: string;
  retriedAndPassed: boolean;
  /** The verdict already on this result, if any — shown so an override is visible. */
  verdict: Verdict | null;
}

export interface ClusterVerdictSuggestion {
  verdict: Verdict;
  /** Where the suggestion came from, so the UI never presents a guess as a finding. */
  basis: 'HUMAN_OVERRIDE' | 'TRIAGE_MAJORITY' | 'SIGNATURE';
  /** Written for the person deciding whether to accept it for the whole cluster. */
  reason: string;
}

export interface FailureCluster {
  /** Stable across runs for the same signature, so the UI can key and link on it. */
  id: string;
  signature: string;
  /** What a person would call this cause, in a sentence they could repeat aloud. */
  label: string;
  count: number;
  facets: FailureFacets;
  members: ClusterMember[];
  suggested: ClusterVerdictSuggestion;
  /** One member's untouched error text, so a human can audit the grouping. */
  sample: string;
}

/** A failure that matched nothing else. Same shape minus the plural claims. */
export interface UnclusteredFailure {
  id: string;
  signature: string;
  label: string;
  facets: FailureFacets;
  member: ClusterMember;
  sample: string;
  /** Why it stands alone: nothing matched, or the error carried no usable signal. */
  reason: 'ONLY_OCCURRENCE' | 'NO_SIGNAL';
}

export interface ClusterReport {
  clusters: FailureCluster[];
  unclustered: UnclusteredFailure[];
  summary: {
    failures: number;
    clustered: number;
    clusters: number;
    /** Size of the biggest cluster — the headline number for the cockpit. */
    largestCluster: number;
  };
}

// ─── Scrubbing ───────────────────────────────────────────────────────────────

/**
 * The volatile-token rules, in the order they must run.
 *
 * Order is load-bearing, not stylistic. Timestamps and ids are digit soup; if
 * the plain-number rule ran first there would be nothing left for them to
 * match, and `2026-07-31T03:42:11.123Z` would scrub to `<n>-<n>-<n>t<n>...`,
 * which is unique per run and clusters nothing. Broad rules run last.
 */
function scrubVolatile(text: string): string {
  return (
    text
      // 1. URLs first, and normalised in place rather than deleted: the host and
      //    the route shape are exactly what distinguishes one shared failure
      //    from another. First because `normaliseUrl` wants the address intact —
      //    once the timestamp rule has been through a query string there is no
      //    longer a URL there to parse.
      .replace(/\bhttps?:\/\/[^\s'"`<>)\]]+/gi, (m) => normaliseUrl(m))
      // 2. ISO-8601 — the longest, most structured digit run in any log.
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
      // 3. Bare clock times, which is how most test reporters stamp a line.
      .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<ts>')
      // 4. Epoch stamps, in seconds or millis. Ten digits is year 2001 onward,
      //    so nothing a test legitimately asserts on lands in this range.
      .replace(/\b\d{10,13}\b/g, '<ts>')
      // 5. uuid v1–v5.
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
      // 6. cuid / cuid2 — every primary key this product mints, and they show up
      //    inside its own error strings ("Environment not found: clx3k…").
      //    Requiring both a letter and a digit keeps ordinary long words out.
      .replace(/\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{20,32}\b/g, '<id>')
      // 7. Filesystem paths. Matched by known roots or by a source-file
      //    extension rather than by "starts with a slash", because `/api/orders`
      //    also starts with a slash and losing the endpoint would defeat the
      //    entire exercise.
      .replace(
        /(?:[A-Za-z]:\\|\/)(?:Users|home|var|tmp|opt|app|private|root|workspace|builds|actions-runner|github)\b[^\s'"`<>()]*/g,
        '<path>',
      )
      .replace(
        /(?:[\w.@~-]+[/\\])+[\w.@~-]+\.(?:m?[cjt]sx?|json|snap|png|jpg|zip|log|xml)(?::\d+(?::\d+)?)?/g,
        '<path>',
      )
      // 8. A line:col pair left dangling once its path is gone.
      .replace(/:\d+:\d+(?!\w)/g, ':<line>')
      // 9. IPv4, before plain numbers get at the octets. Docker hands these out
      //    per container, so the literal address is noise, not a fact.
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
      // 10. Ports on a surviving host. A worker picks its dev-server port at
      //     random, so :5173 and :5174 are the same server.
      .replace(
        /(?<![\w.])(localhost|<ip>|[a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d{2,5})(?![\w.])/gi,
        '$1',
      )
      // 11. Hex ids — shas, ETags, object ids. Needs at least one letter and one
      //     digit so that neither a decimal count nor the word "deadbeef" is hit.
      .replace(/\b(?:0x)?(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, '<hex>')
      // 12. Quoted values. The single-quote rule refuses a quote flanked by
      //     letters, because `doesn't` would otherwise open a quote that closes
      //     halfway down the message and swallows the diagnosis with it.
      .replace(/"[^"\n]{0,200}"/g, '<str>')
      .replace(/`[^`\n]{0,200}`/g, '<str>')
      .replace(/(?<![A-Za-z])'[^'\n]{0,200}'(?![A-Za-z])/g, '<str>')
      // 13. Everything numeric that is left: timeouts, counts, percentages,
      //     durations. A 5s timeout and a 30s timeout are the same failure.
      //
      //     Deliberately not `\b`-anchored on the right: there is no word
      //     boundary between `30000` and `ms`, so a trailing `\b` leaves every
      //     Playwright timeout carrying its own duration and two identical
      //     failures never meet. The left-hand lookbehind still protects route
      //     names and identifiers — `v2` and `sha1` keep their digits.
      .replace(/(?<![\w.])\d+(?:[.,]\d+)*/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      // Case is never the difference between two causes, and runners disagree
      // about it ("Element is not visible" vs "element is not visible").
      .toLowerCase()
  );
}

/**
 * Scrubbing for text that is code rather than prose — locators, mostly.
 *
 * Same id/number/timestamp rules, but quoted strings are left alone. See the
 * module comment: the quotes in `getByText('Order #48213')` hold one dynamic
 * value and one stable one, and only the number should go.
 */
function scrubCode(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{20,32}\b/g, '<id>')
    .replace(/\b(?:0x)?(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\b\d{10,13}\b/g, '<ts>')
    .replace(/(?<![\w.])\d+(?:[.,]\d+)*/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A path segment that is an identifier rather than a route name. */
function isDynamicSegment(segment: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^\d+$/.test(segment)) return true;
  if (/^(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{20,}$/.test(segment)) return true;
  if (/^(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12,}$/i.test(segment)) return true;
  // A slug carrying an id: `order-48213`, `user_9931_settings`. Three digits is
  // the threshold that keeps `checkout-v2` and `api-2fa` as route names.
  if ((segment.match(/\d/g)?.length ?? 0) >= 3) return true;
  return false;
}

function normalisePath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (isDynamicSegment(segment) ? '<id>' : segment.toLowerCase()))
    .join('/');
}

/**
 * Ephemeral hostnames. A preview deploy gets a fresh subdomain per PR, so the
 * literal host would make today's cluster and yesterday's look unrelated even
 * though the cause is identical.
 */
function normaliseHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .split('.')
    .map((label) => (/^(?:pr|preview|deploy|build|branch|commit)[-_][\w-]+$/.test(label) ? '<preview>' : label))
    .join('.');
}

/**
 * Reduces a URL to the endpoint it identifies: no port, no query values, no
 * fragment, dynamic path segments replaced. Query parameter *names* survive
 * because `/search?q` and `/search?cursor` are different endpoints in practice,
 * while their values are per-test data.
 */
export function normaliseUrl(raw: string): string {
  // Prose puts punctuation right up against a URL; a trailing `.` or `)` is
  // sentence, not address.
  const trimmed = raw.replace(/[),.;:'"`\]]+$/, '');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // A bare path — the API plugin writes step titles as `GET /api/orders/8813`.
    const [path = trimmed, query] = trimmed.split('?');
    const names = query
      ? [...new Set(query.split('&').map((p) => p.split('=')[0] ?? ''))].filter(Boolean).sort()
      : [];
    return `${normalisePath(path)}${names.length ? `?${names.join('&')}` : ''}`;
  }

  const names = [...new Set(url.searchParams.keys())].sort();
  return `${url.protocol}//${normaliseHost(url.hostname)}${normalisePath(url.pathname)}${
    names.length ? `?${names.join('&')}` : ''
  }`;
}

// ─── Facet extraction ────────────────────────────────────────────────────────

/** Transport-level failures. These are the strongest cluster keys there are. */
const NET_ERROR = /net::ERR_[A-Z_]+/;

const SYSCALL_ERROR =
  /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|EACCES|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID|ERR_MODULE_NOT_FOUND)\b/;

/** The optional prefix is what lets a bare `Error:` match as well as `TypeError:`. */
const ERROR_CLASS = /\b((?:[A-Z][A-Za-z]*)?(?:Error|Exception))\b/;

/**
 * Playwright prefixes its failures with the call that threw:
 * `locator.click: Timeout …`, sometimes behind an error class first
 * (`TimeoutError: locator.click: …`), which the optional group allows for.
 */
const PW_CALL = /(?:^|\n)\s*(?:[A-Za-z]\w*(?:Error|Exception):\s*)?([a-z]\w*(?:\.[a-z]\w*)+)\s*:/;

const MATCHER = /\bexpect(?:\.soft)?\([^)]*\)\s*\.\s*(?:not\s*\.\s*)?(to[A-Z]\w*)/;
const MATCHER_BARE = /\.(to(?:Be|Have|Contain|Equal|Match|Throw)[A-Za-z]*)\s*\(/;

/**
 * This product's own assertion phrasings, from the API / visual / load plugins.
 * They are not Playwright matchers and would otherwise fall through to the
 * free-text path, where a per-test value would keep them from ever grouping.
 */
const OWN_ASSERTIONS: Array<[RegExp, string]> = [
  [/\bExpected HTTP \d+, got \d+/i, 'http-status'],
  [/\bRequest failed:/i, 'request-transport'],
  [/\bBody at "[^"]*" was /i, 'body-value'],
  [/\bResponse body does not contain\b/i, 'body-contains'],
  [/\bResponse was not valid JSON\b/i, 'body-json'],
  [/\bCould not extract\b/i, 'body-extract'],
  [/\bbudget is \d+ms\b/i, 'latency-budget'],
  [/\bdiffers from the baseline\b|\bvisual baseline\b|\bbaseline by [\d.]+%/i, 'visual-diff'],
];

const STATUS_PATTERNS: RegExp[] = [
  /\bExpected HTTP \d+, got (\d{3})\b/i,
  /->\s*(\d{3})\b/,
  /\bstatus(?: code)?\s*[:=]?\s*(\d{3})\b/i,
  /\bHTTP\s+(\d{3})\b/,
  /\b(\d{3})\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Unauthorized|Forbidden|Not Found|Bad Request|Too Many Requests)\b/i,
];

const LOCATOR_LINE = /(?:^|\n)\s*Locator:\s*(.+)/;
const WAITING_FOR = /waiting for\s+(.+?)(?:\n|$)/;
const INLINE_LOCATOR =
  /(?:page\.|frame\.)?(?:locator|getBy[A-Z]\w*|frameLocator)\((?:[^()]|\([^()]*\))*\)(?:\s*\.\s*(?:first|last|nth\([^)]*\)|filter\((?:[^()]|\([^()]*\))*\)))*/;

/**
 * `waiting for …` is Playwright's most reliable locator line, but it also
 * reports navigations ("waiting for navigation until 'load'"). Only the ones
 * that name an element are taken; the rest belong in the message, where they
 * still cluster, rather than in a facet the UI renders as a selector.
 */
function looksLikeLocator(value: string): boolean {
  return /(?:locator|getBy[A-Z]\w*|frameLocator)\(|^[#.[]|^\w+\[/.test(value.trim());
}

/**
 * Keeps the first line plus the expected/actual pair, and throws the rest away.
 *
 * Everything below that in a Playwright error is a call log and a stack trace:
 * per-test by construction, several kilobytes long, and guaranteed to make two
 * identical failures look different. The Expected/Received lines are the one
 * exception worth rescuing — they are the diagnosis.
 */
function condenseMessage(raw: string): string {
  const lines = raw.split('\n');
  const head = lines.find((l) => l.trim().length > 0)?.trim() ?? '';
  const expected = lines.find((l) => /^\s*Expected(?:\s\w+)?:/.test(l))?.trim();
  const received = lines.find((l) => /^\s*(?:Received|Actual)(?:\s\w+)?:/.test(l))?.trim();
  return [head, expected, received].filter(Boolean).join(' | ');
}

/** Trims a facet so one runaway locator cannot dominate a signature. */
function cap(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

export function extractFacets(input: FailureInput): FailureFacets {
  // The failing step is a better source than the top-level message: the runner
  // has already parsed the locator and the expected/actual out of it.
  const failingStep =
    input.steps.find((s) => s.status === 'FAILED' && (s.errorMessage || s.selector)) ??
    input.steps.find((s) => s.status === 'FAILED');

  const raw = failingStep?.errorMessage ?? input.errorMessage ?? '';
  // The stack is searched for a locator only; its frames are per-test noise.
  const searchable = `${raw}\n${failingStep?.errorStack ?? ''}`;

  const errorClass =
    NET_ERROR.exec(searchable)?.[0] ??
    SYSCALL_ERROR.exec(searchable)?.[1] ??
    ERROR_CLASS.exec(searchable)?.[1] ??
    null;

  const call = PW_CALL.exec(raw)?.[1] ?? null;

  const assertion =
    MATCHER.exec(searchable)?.[1] ??
    MATCHER_BARE.exec(searchable)?.[1] ??
    OWN_ASSERTIONS.find(([re]) => re.test(raw))?.[1] ??
    // No named matcher, but the runner still parsed a wanted-vs-got pair.
    (failingStep?.expected || failingStep?.actual ? 'expected-vs-actual' : null);

  const waitingFor = WAITING_FOR.exec(searchable)?.[1];
  const rawSelector =
    failingStep?.selector ??
    LOCATOR_LINE.exec(searchable)?.[1] ??
    (waitingFor && looksLikeLocator(waitingFor) ? waitingFor : undefined) ??
    INLINE_LOCATOR.exec(searchable)?.[0] ??
    null;
  const selector = rawSelector ? cap(scrubCode(rawSelector), 160) : null;

  // Endpoint, best source first: the URL named in the error, then the request
  // the browser actually saw fail. Step titles are mined for a route but never
  // for prose — a title is per-test and would stop anything from grouping.
  //
  // Only a *failing* request counts. Falling back to the first request of the
  // page would staple whichever document happened to load first onto a locator
  // failure that has nothing to do with it, and two identical failures on two
  // different pages would stop matching.
  const failedRequest = input.network.find((n) => n.status === null || n.status >= 400) ?? null;
  const titleRoute = failingStep
    ? /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s—|]*)/.exec(failingStep.title)?.[1]
    : undefined;
  const rawEndpoint =
    /\bhttps?:\/\/[^\s'"`<>)\]]+/i.exec(searchable)?.[0] ??
    failedRequest?.url ??
    titleRoute ??
    null;
  const endpoint = rawEndpoint ? cap(normaliseUrl(rawEndpoint), 200) : null;

  let httpStatus: number | null = null;
  for (const pattern of STATUS_PATTERNS) {
    const hit = pattern.exec(raw)?.[1];
    if (hit) {
      httpStatus = Number(hit);
      break;
    }
  }
  if (httpStatus === null && failedRequest?.status != null && failedRequest.status >= 400) {
    httpStatus = failedRequest.status;
  }

  const message = cap(scrubVolatile(condenseMessage(raw)), 240);

  return { errorClass, call, assertion, selector, endpoint, httpStatus, message };
}

/**
 * Facets, joined in a fixed order so the string is deterministic and a human can
 * read it. The signature is part of the API — the cockpit shows it under the
 * label — so it is built to be legible, not to be short.
 */
export function signatureOf(facets: FailureFacets): string {
  return [
    facets.errorClass && `class=${facets.errorClass}`,
    facets.call && `call=${facets.call}`,
    facets.assertion && `assert=${facets.assertion}`,
    facets.selector && `selector=${facets.selector}`,
    facets.endpoint && `url=${facets.endpoint}`,
    facets.httpStatus !== null && `http=${facets.httpStatus}`,
    facets.message && `msg=${facets.message}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' | ');
}

/**
 * True when the signature is built out of something and not out of nothing.
 *
 * A failure whose entire message scrubbed away to `<n>` or `<str>` carries no
 * evidence, and grouping several of those together would assert a shared cause
 * that was never observed. Those go to `unclustered` instead.
 */
function hasSignal(facets: FailureFacets): boolean {
  if (facets.errorClass || facets.call || facets.assertion) return true;
  if (facets.selector || facets.endpoint || facets.httpStatus !== null) return true;
  const words = facets.message.replace(/<\w+>/g, ' ').match(/[a-z]{3,}/g) ?? [];
  return words.length >= 3;
}

// ─── Labelling ───────────────────────────────────────────────────────────────

/*
 * Split by regex rather than by `new URL`, because a normalised endpoint is no
 * longer a legal URL — it is a URL with `<id>` where the ids were, and the URL
 * parser percent-encodes the angle brackets straight back into the label.
 */
const SPLIT_ENDPOINT = /^[a-z][\w+.-]*:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i;

function hostOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  return SPLIT_ENDPOINT.exec(endpoint)?.[1] || null;
}

function routeOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  const parts = SPLIT_ENDPOINT.exec(endpoint);
  if (!parts) return endpoint;
  return `${parts[2] || '/'}${parts[3] ?? ''}`;
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * What a person would call this cause.
 *
 * Deliberately count-independent — no "40 tests are…" — because the count is
 * already on screen next to it, and a label that reads correctly for a cluster
 * of two and a cluster of two hundred is a label the UI can put anywhere.
 */
export function labelFor(facets: FailureFacets): string {
  const { errorClass, assertion, selector, httpStatus, message } = facets;
  const host = hostOf(facets.endpoint);
  const route = routeOf(facets.endpoint);
  // Hostnames are never sentence-cased below: "Staging.acme.io" is not a place
  // that exists, and half these labels already open with a verbatim locator.
  const where = host ?? route ?? 'the target host';
  const shortSelector = selector ? cap(selector, 60) : null;

  // Transport: nothing further up the stack is meaningful if the socket failed.
  if (errorClass === 'ECONNREFUSED' || /CONNECTION_REFUSED/.test(errorClass ?? '')) {
    return `Nothing is answering at ${where}`;
  }
  if (errorClass === 'ENOTFOUND' || /NAME_NOT_RESOLVED/.test(errorClass ?? '')) {
    return `${where} does not resolve`;
  }
  if (/CERT|SSL|TLS/.test(errorClass ?? '')) {
    return `The TLS certificate for ${where} is being rejected`;
  }
  if (
    errorClass === 'ETIMEDOUT' ||
    /ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH/.test(errorClass ?? '')
  ) {
    return `The connection to ${where} keeps dropping`;
  }
  if (errorClass === 'ERR_MODULE_NOT_FOUND' || /cannot find module|failed to compile|no report/.test(message)) {
    return 'The suite is not compiling';
  }
  if (/is not installed on this worker/.test(message)) {
    return 'A required tool is missing from the worker';
  }

  // Response status. Ordered by what the number actually tells a human.
  if (httpStatus !== null && httpStatus >= 500) {
    return `${route ?? 'The API'} is returning ${httpStatus}`;
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return `${route ?? 'The API'} answers ${httpStatus} — the session is not being accepted`;
  }
  if (httpStatus === 404) {
    return `${route ?? 'An endpoint'} is a 404 — the route moved or was renamed`;
  }
  if (httpStatus === 429) {
    return `${where} is rate-limiting the suite`;
  }
  if (httpStatus !== null && httpStatus >= 400) {
    return `${route ?? 'The API'} is returning ${httpStatus}`;
  }

  if (assertion === 'visual-diff') return 'The page no longer matches its visual baseline';
  if (assertion === 'latency-budget') return `${route ?? 'The app'} is over its latency budget`;

  // Locator failures — the single most common shape of a shared-cause cluster.
  if (shortSelector) {
    if (/not visible|to be visible|hidden/.test(message)) {
      return `${shortSelector} is on the page but not visible`;
    }
    if (/not attached|detached/.test(message)) {
      return `${shortSelector} is detaching before the test can use it`;
    }
    if (/resolved to \d|<n> elements|strict mode violation/.test(message)) {
      return `${shortSelector} now matches more than one element`;
    }
    if (/timeout|timed out|waiting for|not found|no element/.test(message)) {
      return `${shortSelector} never appears`;
    }
    if (assertion && /text|value|attribute|class|title/i.test(assertion)) {
      return `The content of ${shortSelector} is not what the tests expect`;
    }
    return `${shortSelector} is failing ${assertion ?? 'its check'}`;
  }

  if (assertion === 'toHaveURL') return `The app does not navigate to ${route ?? 'the expected URL'}`;
  if (assertion && /^to(Be|Equal|HaveCount|HaveLength|BeCloseTo)/.test(assertion)) {
    return `${assertion} is failing — the app is producing a different value`;
  }
  if (assertion === 'http-status') return `${route ?? 'An endpoint'} is answering with the wrong status`;
  if (assertion?.startsWith('body-')) return `${route ?? 'An endpoint'} is returning the wrong body`;

  if (errorClass === 'TimeoutError' || /timeout|timed out/.test(message)) {
    return 'The same step times out every time';
  }

  // Nothing matched a known shape: show the scrubbed message rather than invent
  // a category. An honest "here is the error" beats a confident wrong noun.
  return message ? sentenceCase(cap(message, 90)) : (errorClass ?? 'Unrecognised failure');
}

// ─── Suggested verdict ───────────────────────────────────────────────────────

/**
 * Below this, a repeated timeout is plausibly a genuine flake. At or above it,
 * "twenty independent tests each got unlucky in the same place in the same
 * minute" stops being the simple explanation and a shared dependency starts
 * being one. Cluster size is evidence that a per-test view cannot see, which is
 * the reason this endpoint exists at all.
 */
const FLAKE_CEILING = 5;

function mode<T>(values: T[]): { value: T; count: number } | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { value: T; count: number } | null = null;
  for (const [value, count] of counts) {
    if (!best || count > best.count) best = { value, count };
  }
  return best;
}

function verdictFromSignature(
  facets: FailureFacets,
  stats: { count: number; retriedAndPassed: number },
): { verdict: Verdict; reason: string } {
  const { errorClass, assertion, selector, httpStatus, message } = facets;
  const big = stats.count >= FLAKE_CEILING;

  // 1. Transport and toolchain. The app was never given a chance to be wrong.
  if (NET_ERROR.test(errorClass ?? '') || SYSCALL_ERROR.test(errorClass ?? '')) {
    return {
      verdict: 'ENV_ISSUE',
      reason: `Every failure here is ${errorClass} — the request never reached an application, so nothing about the app is under test.`,
    };
  }
  if (/cannot find module|no report|is not installed on this worker|did not finish within/.test(message)) {
    return {
      verdict: 'ENV_ISSUE',
      reason: 'The suite did not get as far as running — this is a worker or build problem, not a product one.',
    };
  }

  // 2. Wrong value beats every other signal, including a passing retry. This is
  //    triage's rule 1 and the two subsystems must not contradict each other.
  if (assertion && /^to(Be|Equal|HaveCount|HaveLength|BeCloseTo)$|^body-value$/.test(assertion)) {
    return {
      verdict: 'REAL_BUG',
      reason: 'The app produced a different value than the assertion requires. A wrong value is not a flake, however many tests saw it.',
    };
  }

  // 3. Response status, read the way triage reads it, so a cluster and a
  //    per-test verdict never disagree about the same 500.
  if (httpStatus !== null && httpStatus >= 500) {
    return {
      verdict: 'ENV_ISSUE',
      reason: `The service answered ${httpStatus} for all of these. Confirm the dependency is healthy before triaging any of them individually — if it is, this is a real server bug and should be re-filed as one.`,
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      verdict: 'ENV_ISSUE',
      reason: 'Auth was rejected across the whole cluster, which usually means expired seed credentials rather than a permission bug.',
    };
  }
  if (httpStatus === 429) {
    return {
      verdict: 'ENV_ISSUE',
      reason: 'The suite is being rate-limited. Nothing here is evidence about the application.',
    };
  }
  if (httpStatus === 404) {
    return {
      verdict: 'INTENDED_CHANGE',
      reason: 'The endpoint these tests call is gone. If the route was renamed on purpose the tests are stale.',
    };
  }

  // 4. Passing on retry (§5). Held until after the value and status checks so it
  //    can never talk anyone out of a wrong number.
  if (stats.retriedAndPassed * 2 > stats.count) {
    return big
      ? {
          verdict: 'ENV_ISSUE',
          reason: `${stats.retriedAndPassed} of ${stats.count} passed on retry. That many recovering together points at something shared that was briefly slow, not at ${stats.count} independently flaky tests.`,
        }
      : {
          verdict: 'FLAKE',
          reason: 'Most of these passed on retry, which §5 treats as flake evidence rather than a pass.',
        };
  }

  // 5. The element moved, was renamed, or the copy changed.
  if (selector && /not found|no element|timeout|timed out|waiting for|not visible|to be visible|detached/.test(message)) {
    return {
      verdict: 'INTENDED_CHANGE',
      reason: 'One locator stopped resolving for all of these at once, which is what a rename or a layout change looks like. Check the diff before healing.',
    };
  }
  if (assertion && /^to(HaveText|ContainText|HaveValue|HaveAttribute|HaveClass|HaveTitle|HaveURL)$/.test(assertion)) {
    return {
      verdict: 'INTENDED_CHANGE',
      reason: 'The same visible content changed under all of these — usually a copy or routing change the tests have not caught up with.',
    };
  }
  if (assertion === 'visual-diff') {
    return {
      verdict: 'INTENDED_CHANGE',
      reason: 'A shared layout or style change moved every one of these off its baseline. Re-approve the baselines if it was intentional.',
    };
  }

  // 6. A bare timeout with nothing else to go on.
  if (errorClass === 'TimeoutError' || /timeout|timed out/.test(message)) {
    return big
      ? {
          verdict: 'ENV_ISSUE',
          reason: `${stats.count} tests timing out in the same place in one run is a dependency that stopped responding, not ${stats.count} coincidences.`,
        }
      : {
          verdict: 'FLAKE',
          reason: 'A small number of timeouts at the same point, with no other signal — treat as flaky until it recurs.',
        };
  }

  // 7. Unknown. Fail loud: an unexplained failure repeated across the suite is
  //    the last thing that should be waved through as noise.
  return {
    verdict: 'REAL_BUG',
    reason: 'Nothing in the signature explains this away, so it is left blocking. Triage one member to find out what the other members are.',
  };
}

function suggestVerdict(
  facets: FailureFacets,
  members: ClusterMember[],
  failures: FailureInput[],
): ClusterVerdictSuggestion {
  // A human who already overruled triage on one of these has said more about
  // the cause than any heuristic in this file can. Their call carries.
  const overrides = failures
    .map((f) => f.verdict?.overriddenTo)
    .filter((v): v is Verdict => Boolean(v));
  const override = mode(overrides);
  if (override) {
    return {
      verdict: override.value,
      basis: 'HUMAN_OVERRIDE',
      reason: `A reviewer already called ${override.count} of these ${override.value}. The rest of the cluster shares their signature.`,
    };
  }

  // Otherwise defer to triage where triage has spoken for most of the cluster.
  const triaged = failures.map((f) => f.verdict?.verdict).filter((v): v is Verdict => Boolean(v));
  const agreed = mode(triaged);
  if (agreed && triaged.length * 2 >= members.length && agreed.count * 2 > triaged.length) {
    return {
      verdict: agreed.value,
      basis: 'TRIAGE_MAJORITY',
      reason: `Triage reached ${agreed.value} on ${agreed.count} of the ${triaged.length} members it has looked at.`,
    };
  }

  const { verdict, reason } = verdictFromSignature(facets, {
    count: members.length,
    retriedAndPassed: failures.filter((f) => f.retriedAndPassed).length,
  });
  return { verdict, basis: 'SIGNATURE', reason };
}

// ─── Clustering ──────────────────────────────────────────────────────────────

function memberOf(input: FailureInput): ClusterMember {
  return {
    testResultId: input.testResultId,
    testId: input.testId,
    testName: input.testName,
    filePath: input.filePath,
    status: input.status,
    retriedAndPassed: input.retriedAndPassed,
    verdict: input.verdict?.overriddenTo ?? input.verdict?.verdict ?? null,
  };
}

/** Short, stable, and derived only from the signature — the same cause keeps its id across runs. */
function clusterId(signature: string): string {
  return createHash('sha1').update(signature).digest('hex').slice(0, 12);
}

/** One member's raw error, untruncated enough to check the grouping by eye. */
function sampleOf(input: FailureInput): string {
  const failing = input.steps.find((s) => s.status === 'FAILED' && s.errorMessage);
  return cap((failing?.errorMessage ?? input.errorMessage ?? '').trim(), 600);
}

export interface ClusterOptions {
  /**
   * A cluster of one is not a cluster. Grouping a lone failure under a heading
   * implies a pattern the run did not show, so singletons are returned as
   * `unclustered` and the UI can say so plainly.
   */
  minClusterSize?: number;
}

export function clusterFailures(
  failures: FailureInput[],
  options: ClusterOptions = {},
): ClusterReport {
  const minClusterSize = Math.max(2, options.minClusterSize ?? 2);

  const groups = new Map<string, { facets: FailureFacets; items: FailureInput[]; signal: boolean }>();
  for (const failure of failures) {
    const facets = extractFacets(failure);
    const signature = signatureOf(facets) || 'msg=<none>';
    const existing = groups.get(signature);
    if (existing) existing.items.push(failure);
    else groups.set(signature, { facets, items: [failure], signal: hasSignal(facets) });
  }

  const clusters: FailureCluster[] = [];
  const unclustered: UnclusteredFailure[] = [];

  for (const [signature, group] of groups) {
    const label = labelFor(group.facets);

    if (group.items.length < minClusterSize || !group.signal) {
      for (const item of group.items) {
        unclustered.push({
          id: clusterId(signature),
          signature,
          label,
          facets: group.facets,
          member: memberOf(item),
          sample: sampleOf(item),
          reason: group.signal ? 'ONLY_OCCURRENCE' : 'NO_SIGNAL',
        });
      }
      continue;
    }

    const members = group.items.map(memberOf);
    clusters.push({
      id: clusterId(signature),
      signature,
      label,
      count: members.length,
      facets: group.facets,
      members,
      suggested: suggestVerdict(group.facets, members, group.items),
      sample: sampleOf(group.items[0]!),
    });
  }

  // Biggest cause first — that is the one worth a person's next ten minutes.
  // Signature breaks ties so the order is stable between two identical requests.
  clusters.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
  unclustered.sort((a, b) => a.member.testName.localeCompare(b.member.testName));

  return {
    clusters,
    unclustered,
    summary: {
      failures: failures.length,
      clustered: clusters.reduce((sum, c) => sum + c.count, 0),
      clusters: clusters.length,
      largestCluster: clusters[0]?.count ?? 0,
    },
  };
}
