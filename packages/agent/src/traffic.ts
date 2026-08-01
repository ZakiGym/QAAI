/**
 * Traffic ingest — turning what users actually did into the tests to write next.
 *
 * QAAI could already record its own network inside a run (packages/runner's
 * har.ts). This module is the other direction: a customer hands us traffic from
 * OUTSIDE a test — a HAR export, a week of nginx access logs, an OpenTelemetry
 * span dump — and we tell them which journeys their users really walk, how
 * often, and which of those the suite does not cover yet.
 *
 * ── REDACTION IS THE FIRST THING THAT HAPPENS, AND IT IS NOT NEGOTIABLE ──────
 *
 * Production traffic is the most dangerous payload this product will ever
 * accept. It carries session cookies, Authorization headers, PII in query
 * strings, card numbers in paths, whole request and response bodies. So the
 * pipeline is shaped so that redaction cannot be skipped or deferred:
 *
 *     raw bytes ─▶ parser ─▶ RawEntry  (in memory, for this call only)
 *                                │
 *                                ▼  toEvents() — the only door out
 *                            TrafficEvent   method · route template · status ·
 *                                           timing · salted grouping key
 *
 * `RawEntry` is not exported and is never returned. Nothing downstream of
 * `toEvents` can see a header, a cookie, a body, an IP address or a query
 * VALUE, because those are not fields on `TrafficEvent` — they were dropped
 * while the upload was still a string in this process, before anything was
 * ranked, and long before a caller could persist a journey or write an
 * artifact. Redacting on display would mean the secret lived in the database in
 * between, and "we hide it in the UI" is exactly the guarantee that fails the
 * one time somebody reads the row some other way.
 *
 * Specifically, on the way in:
 *   - Request and response BODIES are never read. Not scanned, not truncated —
 *     not read. They are counted, so the report can say they were dropped.
 *   - HEADERS are read only to derive an identity and are not retained. The
 *     identity is HMAC'd under a salt generated for this analysis alone, so the
 *     stored key groups requests within this one upload and is worthless
 *     anywhere else: it cannot be reversed, and it cannot be joined against a
 *     second upload to re-identify a user.
 *   - Query VALUES are dropped wholesale — every one, not only the
 *     credential-looking ones, because `?q=my+diagnosis` is as sensitive as
 *     `?token=…`. Parameter NAMES survive: a name is route shape, a value is
 *     user data.
 *   - PATH SEGMENTS are classified before anything else looks at them. Emails,
 *     card numbers (Luhn-checked), phone numbers, national ids, JWTs and opaque
 *     tokens become placeholders even when they appear exactly once — the
 *     frequency pass further down would not catch a singleton, and "it only
 *     leaked once" is still a leak.
 *
 * Everything removed is COUNTED BY CATEGORY and reported (`RedactionReport`),
 * because a customer deciding whether to upload their production traffic
 * deserves an itemised answer rather than a promise.
 *
 * ── THE ARGUMENT ────────────────────────────────────────────────────────────
 *
 * The reason to write one test before another is that more users walk it. So
 * the ranking reports the real percentage, of real sessions, from their own
 * traffic — and a journey the suite already covers is not proposed at all.
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomBytes } from 'node:crypto';
import type { Priority, TestType } from '@qaai/shared';

// ─── Public shapes ───────────────────────────────────────────────────────────

export const TRAFFIC_FORMATS = ['HAR', 'ACCESS_LOG', 'OTLP'] as const;
export type TrafficFormat = (typeof TRAFFIC_FORMATS)[number];

/** Which signal grouped an entry into a session, best first. */
export const IDENTITY_SOURCES = [
  'SESSION_ID', // OTLP `session.id` — the application told us outright
  'SESSION_COOKIE', // a cookie whose name says session
  'END_USER_ID', // OTLP `enduser.id` / an access log's authenticated user
  'TRACE_ID', // ONE distributed request, not one user — see identityFor()
  'IP_UA', // the classic fallback; NAT makes it lossy
  'UPLOAD_SCOPE', // a HAR is one browser by construction; the file is the client
  'NONE', // nothing at all to group on
] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export const REDACTION_KINDS = [
  'REQUEST_BODY',
  'RESPONSE_BODY',
  'HEADER',
  'COOKIE',
  'QUERY_VALUE',
  'URL_CREDENTIALS',
  'IP_ADDRESS',
  'USER_AGENT',
  'USER_IDENTIFIER',
  'EMAIL',
  'PHONE',
  'CARD_NUMBER',
  'NATIONAL_ID',
  'JWT',
  'OPAQUE_TOKEN',
  'PATH_IDENTIFIER',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export interface RedactionReport {
  /** Says in its own words that this is not a display filter. */
  when: string;
  /** Categories removed before an event existed, with counts. */
  counts: Record<RedactionKind, number>;
  /** Never read at all — a different guarantee from "read and masked". */
  neverRead: string[];
  identityHashing: string;
  /** Query parameter names retained; the values were not. Capped for size. */
  queryParamNamesKept: string[];
  note: string;
}

export type ContentKind = 'html' | 'json' | 'other' | 'mixed' | 'unknown';

/** One request, after redaction. Every field here is safe to persist. */
export interface TrafficEvent {
  /** Epoch ms. */
  at: number;
  method: string;
  /** Parameterised, PII-classified path. Never a raw URL. */
  route: string;
  /** Host as sent, lowercased. Null when the source gave a relative target. */
  host: string | null;
  status: number | null;
  durationMs: number | null;
  contentKind: ContentKind;
  /** Query parameter NAMES only, sorted. The values were dropped. */
  queryKeys: string[];
  /** HMAC of the identity under this analysis's salt. Not reversible, not portable. */
  identityKey: string;
  identitySource: IdentitySource;
  /** True when the source published the route template itself (OTLP http.route). */
  routeFromSource: boolean;
  isStaticAsset: boolean;
  isBot: boolean;
}

export interface TrafficSession {
  key: string;
  identitySource: IdentitySource;
  events: TrafficEvent[];
  startedAt: number;
  endedAt: number;
  /** True when the session hit MAX_STEPS_PER_SESSION and was cut short. */
  truncated: boolean;
}

export interface StepKey {
  method: string;
  route: string;
}

export interface JourneyStep extends StepKey {
  /** Most common status across observations of this step. */
  status: number | null;
  /** Share of observations that returned >= 400. */
  errorRate: number;
  /** Times this step was observed across every session on this journey. */
  count: number;
  /** Consecutive repeats collapsed into this step (polling, retries). */
  repeats: number;
}

export interface JourneyCoverage {
  status: 'COVERED' | 'PARTIAL' | 'UNCOVERED';
  /** The best single test's share of the journey's steps, 0–1. */
  matchedRatio: number;
  matchedTests: Array<{ id: string; name: string; matchedSteps: number }>;
  /** "POST /checkout" for every step no test mentions. */
  missingSteps: string[];
  /** Why the reader should not over-trust this. */
  basis: string;
}

export interface Journey {
  /** Deterministic hash of the step sequence — safe to round-trip via a client. */
  id: string;
  name: string;
  feature: string;
  steps: JourneyStep[];
  /** Sessions whose whole canonical path is exactly this. */
  sessionCount: number;
  /** …as a share of all sessions, 0–1. The headline number. */
  sessionShare: number;
  /** Sessions that contain this sequence, alone or inside a longer path. */
  containingSessionCount: number;
  containingSessionShare: number;
  requestCount: number;
  /** Median wall-clock of the journey, when the source carried timings. */
  medianDurationMs: number | null;
  /** Share of this journey's requests that failed in production. */
  errorRate: number;
  firstSeen: string;
  lastSeen: string;
  contentKind: ContentKind;
  identitySources: IdentitySource[];
  suggestedTestType: TestType;
  suggestedPriority: Priority;
  coverage: JourneyCoverage;
}

/** A position collapsed by the frequency pass, so the guess stays arguable. */
export interface ParameterisationNote {
  template: string;
  distinctValues: number;
  observations: number;
  reason: string;
}

export interface TrafficTotals {
  /** Entries the parser recognised. */
  parsed: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  /** Line numbers only — a malformed log line is exactly what not to echo. */
  unparsedLineNumbers: number[];
  /** Requests that survived filtering and were sessionised. */
  requests: number;
  staticAssetsFiltered: number;
  botRequestsFiltered: number;
  sessions: number;
  truncated: boolean;
}

export interface TrafficAnalysis {
  format: TrafficFormat;
  redaction: RedactionReport;
  totals: TrafficTotals;
  window: { from: string; to: string } | null;
  journeys: Journey[];
  parameterisation: ParameterisationNote[];
  identityBreakdown: Partial<Record<IdentitySource, number>>;
  warnings: string[];
}

/** The suite as this module needs to see it, so the API can hand over rows. */
export interface ExistingTest {
  id: string;
  name: string;
  code: string;
  filePath?: string | null;
  /** API and protocol tests keep their request chain here, not in code. */
  spec?: unknown;
}

/** Everything the Generator needs, derived deterministically from a journey. */
export interface PlanItemDraft {
  title: string;
  rationale: string;
  feature: string;
  priority: Priority;
  testType: TestType;
  steps: string[];
  assertions: string[];
  journeyId: string;
}

export interface AnalyzeOptions {
  format?: TrafficFormat | 'AUTO';
  /** Gap that ends a session. Thirty minutes is the analytics convention. */
  sessionGapMs?: number;
  /** Hard cap on one session's span, so a monitor's stream is not one journey. */
  maxSessionMs?: number;
  maxEntries?: number;
  maxJourneys?: number;
  /** Fixed salt, for deterministic tests. Random per analysis otherwise. */
  identitySalt?: string;
  includeStaticAssets?: boolean;
  includeBots?: boolean;
  /** Cross-reference target. Omitted means every journey reports UNCOVERED. */
  existingTests?: readonly ExistingTest[];
  /** Distinct sibling values before a path position collapses to :param. */
  paramDistinctThreshold?: number;
}

// ─── Caps ────────────────────────────────────────────────────────────────────

export const MAX_INPUT_BYTES = 24 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 250_000;
export const DEFAULT_SESSION_GAP_MS = 30 * 60_000;
export const DEFAULT_MAX_SESSION_MS = 4 * 60 * 60_000;
export const MAX_STEPS_PER_SESSION = 40;
export const DEFAULT_MAX_JOURNEYS = 25;
export const DEFAULT_PARAM_DISTINCT_THRESHOLD = 8;
/** Beyond this, containment scanning stops earning its milliseconds. */
const MAX_RANKED_CANDIDATES = 40;
const MAX_UNPARSED_REPORTED = 50;
const MAX_QUERY_NAMES_REPORTED = 60;
/** A tree node with fewer observations than this is too small to guess from. */
const PARAM_MIN_OBSERVATIONS = 8;

// ─────────────────────────────────────────────────────────────────────────────
// 1. REDACTION.  Everything below runs before a TrafficEvent exists.
// ─────────────────────────────────────────────────────────────────────────────

export const PLACEHOLDER = {
  email: ':email',
  phone: ':phone',
  card: ':card',
  nationalId: ':national-id',
  token: ':token',
  uuid: ':uuid',
  hash: ':hash',
  date: ':date',
  id: ':id',
  param: ':param',
} as const;

function emptyCounts(): Record<RedactionKind, number> {
  const out = {} as Record<RedactionKind, number>;
  for (const kind of REDACTION_KINDS) out[kind] = 0;
  return out;
}

/**
 * The running tally, and the only holder of the identity salt.
 *
 * Exported because the API route re-runs sanitisation on anything a client
 * sends back, and it should be able to report what that second pass removed —
 * a journey list that has been through a browser is untrusted input again.
 */
export class Redactor {
  readonly counts: Record<RedactionKind, number> = emptyCounts();
  readonly queryNames = new Set<string>();
  private readonly salt: string;

  constructor(salt?: string) {
    // A random salt per analysis is the point, not an oversight: it makes the
    // stored key useless for correlating a user across two uploads, and useless
    // to anyone who later reads the table. Tests pass a fixed one.
    this.salt = salt ?? randomBytes(32).toString('hex');
  }

  count(kind: RedactionKind, by = 1): void {
    this.counts[kind] += by;
  }

  /** One-way, salted, truncated: enough to group, not enough to identify. */
  hash(source: IdentitySource, value: string): string {
    return createHmac('sha256', this.salt).update(`${source} ${value}`).digest('hex').slice(0, 16);
  }
}

const LUHN_CANDIDATE = /^[0-9](?:[0-9 -]{11,21})[0-9]$/;

/** Card numbers are what nobody forgives; check properly, not by length. */
export function looksLikeCardNumber(raw: string): boolean {
  if (!LUHN_CANDIDATE.test(raw)) return false;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const EMAIL_RE = /^[^\s@/]+@[^\s@/]+\.[A-Za-z]{2,}$/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const HEX_HASH_RE = /^[0-9a-f]{12,}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;
const NUMERIC_RE = /^[0-9]+$/;
const NATIONAL_ID_RE = /^\d{3}-\d{2}-\d{4}$/;
const PHONE_RE = /^\+?[0-9][0-9().\- ]{6,18}[0-9]$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Long, mixed-class and not a word: an API key or an opaque session token. */
function looksLikeOpaqueToken(seg: string): boolean {
  if (seg.length < 20) return false;
  const classes = Number(/[a-z]/.test(seg)) + Number(/[A-Z]/.test(seg)) + Number(/[0-9]/.test(seg));
  return classes >= 2 && /^[A-Za-z0-9_\-+/=.]+$/.test(seg);
}

export type SegmentKind =
  | 'literal'
  | 'email'
  | 'phone'
  | 'card'
  | 'nationalId'
  | 'jwt'
  | 'token'
  | 'uuid'
  | 'hash'
  | 'date'
  | 'id';

export interface ClassifiedSegment {
  /** What goes into the route: a literal, or a placeholder. */
  text: string;
  kind: SegmentKind;
}

/**
 * Classifies ONE path segment.
 *
 * Runs on every segment of every entry, ahead of the frequency pass, because a
 * card number that appears once must still never be stored and statistical
 * parameterisation leaves singletons alone.
 */
export function classifySegment(rawSegment: string, redactor?: Redactor): ClassifiedSegment {
  let seg = rawSegment;
  // Percent-encoding is not obfuscation. Decode before deciding, so that
  // /users/john%40example.com is caught as an email.
  try {
    seg = decodeURIComponent(seg);
  } catch {
    /* malformed escape — judge it exactly as it was sent */
  }

  const hit = (kind: SegmentKind, text: string, counted: RedactionKind): ClassifiedSegment => {
    redactor?.count(counted);
    return { text, kind };
  };

  if (EMAIL_RE.test(seg)) return hit('email', PLACEHOLDER.email, 'EMAIL');
  if (looksLikeCardNumber(seg)) return hit('card', PLACEHOLDER.card, 'CARD_NUMBER');
  if (NATIONAL_ID_RE.test(seg)) return hit('nationalId', PLACEHOLDER.nationalId, 'NATIONAL_ID');
  if (JWT_RE.test(seg)) return hit('jwt', PLACEHOLDER.token, 'JWT');
  if (UUID_RE.test(seg) || ULID_RE.test(seg) || OBJECT_ID_RE.test(seg)) {
    return hit('uuid', PLACEHOLDER.uuid, 'PATH_IDENTIFIER');
  }
  if (ISO_DATE_RE.test(seg)) return hit('date', PLACEHOLDER.date, 'PATH_IDENTIFIER');
  if (NUMERIC_RE.test(seg)) return hit('id', PLACEHOLDER.id, 'PATH_IDENTIFIER');
  // Phones before hashes: +1-555-0100 is not a hex hash, but a run of digits
  // with separators is exactly what a phone number looks like.
  if (PHONE_RE.test(seg) && seg.replace(/[^0-9]/g, '').length >= 8) {
    return hit('phone', PLACEHOLDER.phone, 'PHONE');
  }
  if (HEX_HASH_RE.test(seg)) return hit('hash', PLACEHOLDER.hash, 'PATH_IDENTIFIER');
  if (looksLikeOpaqueToken(seg)) return hit('token', PLACEHOLDER.token, 'OPAQUE_TOKEN');

  // A surviving literal is route vocabulary — but scrub anything embedded in it
  // and cap the length, so `order-jane@example.com-final` cannot ride through.
  return { text: scrubLiteral(seg, redactor), kind: 'literal' };
}

const EMBEDDED_EMAIL = /[^\s@/]+@[^\s@/]+\.[A-Za-z]{2,}/g;
const EMBEDDED_JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const EMBEDDED_NATIONAL_ID = /\d{3}-\d{2}-\d{4}/g;
const EMBEDDED_LONG_DIGITS = /\d{13,19}/g;

function scrubLiteral(seg: string, redactor?: Redactor): string {
  let out = seg.replace(CONTROL_CHARS, '');
  out = out.replace(EMBEDDED_EMAIL, () => {
    redactor?.count('EMAIL');
    return PLACEHOLDER.email;
  });
  out = out.replace(EMBEDDED_JWT, () => {
    redactor?.count('JWT');
    return PLACEHOLDER.token;
  });
  out = out.replace(EMBEDDED_NATIONAL_ID, () => {
    redactor?.count('NATIONAL_ID');
    return PLACEHOLDER.nationalId;
  });
  out = out.replace(EMBEDDED_LONG_DIGITS, (m) => {
    if (!looksLikeCardNumber(m)) return m;
    redactor?.count('CARD_NUMBER');
    return PLACEHOLDER.card;
  });
  return out.length > 64 ? `${out.slice(0, 64)}…` : out;
}

export interface SanitisedTarget {
  segments: ClassifiedSegment[];
  queryKeys: string[];
  host: string | null;
}

/**
 * Splits a request target into a classified path and the NAMES of its query
 * parameters. Values do not survive this function — there is no code path in
 * this file that keeps one.
 */
export function sanitisePath(target: string, redactor?: Redactor): SanitisedTarget {
  let pathname = target;
  let search = '';
  let host: string | null = null;

  try {
    // The base makes a relative target parse; an absolute target ignores it.
    const url = new URL(target, 'http://traffic.invalid');
    pathname = url.pathname;
    search = url.search;
    host = url.host && url.host !== 'traffic.invalid' ? url.host.toLowerCase() : null;
    if (url.username || url.password) redactor?.count('URL_CREDENTIALS');
  } catch {
    const q = target.indexOf('?');
    if (q >= 0) {
      pathname = target.slice(0, q);
      search = target.slice(q);
    }
  }

  const queryKeys: string[] = [];
  if (search.length > 1) {
    for (const part of search.slice(1).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const rawName = eq === -1 ? part : part.slice(0, eq);
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
      name = name.replace(CONTROL_CHARS, '').slice(0, 48);
      if (name) queryKeys.push(name);
      // Every value goes, credential-shaped or not: `?q=<free text>` is user
      // data too, and a rule with exceptions is a rule that leaks.
      if (eq !== -1) redactor?.count('QUERY_VALUE');
    }
  }

  const segments = pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => classifySegment(s, redactor));

  const uniqueKeys = [...new Set(queryKeys)].sort();
  if (redactor) for (const key of uniqueKeys) redactor.queryNames.add(key);
  return { segments, queryKeys: uniqueKeys, host };
}

export function buildRedactionReport(redactor: Redactor): RedactionReport {
  return {
    when: 'on ingest, before any journey was assembled and before anything could be persisted',
    counts: { ...redactor.counts },
    neverRead: [
      'request bodies',
      'response bodies',
      'header values (read only to derive a grouping key, never retained)',
      'cookie values',
      'query-string values',
      'client IP addresses',
      'User-Agent strings',
    ],
    identityHashing:
      'Session cookies, end-user ids, trace ids and IP+User-Agent pairs were HMAC-SHA256’d under ' +
      'a salt generated for this analysis alone, then truncated to 16 hex characters. The result ' +
      'groups requests within this upload and is useless outside it: it cannot be reversed, and ' +
      'it cannot be joined against another upload to re-identify anyone.',
    queryParamNamesKept: [...redactor.queryNames].sort().slice(0, MAX_QUERY_NAMES_REPORTED),
    note:
      'Paths were parameterised and every segment classified before storage: emails, card numbers ' +
      '(Luhn-checked), phone numbers, national ids, JWTs and opaque tokens became placeholders ' +
      'even where they appeared only once. What remains is method, route template, status, timing ' +
      'and a salted grouping key. Nothing else from the upload survived, and the upload itself is ' +
      'not retained.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Parsers.  RawEntry is internal and never leaves this module.
// ─────────────────────────────────────────────────────────────────────────────

interface RawEntry {
  at: number;
  method: string;
  /** Raw target — the only raw URL in the module, and it dies in toEvents(). */
  target: string;
  status: number | null;
  durationMs: number | null;
  mimeType: string | null;
  cookieHeader: string | null;
  ip: string | null;
  userAgent: string | null;
  traceId: string | null;
  sessionId: string | null;
  endUserId: string | null;
  /** OTLP `http.route`: the application's own template, better than our guess. */
  routeHint: string | null;
  hostHint: string | null;
  /**
   * Last-resort grouping key from the container itself. A HAR is one browser by
   * construction, so an export with no cookies is still one user's session —
   * far more useful than treating every request as its own session.
   */
  uploadScope: string | null;
}

interface ParseResult {
  entries: RawEntry[];
  skipped: number;
  skippedReasons: Record<string, number>;
  unparsedLineNumbers: number[];
  truncated: boolean;
  warnings: string[];
  /** What the parser saw and refused to read; folded into the report later. */
  tally: Partial<Record<RedactionKind, number>>;
}

function emptyParse(): ParseResult {
  return {
    entries: [],
    skipped: 0,
    skippedReasons: {},
    unparsedLineNumbers: [],
    truncated: false,
    warnings: [],
    tally: {},
  };
}

function skip(result: ParseResult, reason: string): void {
  result.skipped += 1;
  result.skippedReasons[reason] = (result.skippedReasons[reason] ?? 0) + 1;
}

function tally(result: ParseResult, kind: RedactionKind, by = 1): void {
  result.tally[kind] = (result.tally[kind] ?? 0) + by;
}

export function detectFormat(input: string | Record<string, unknown>): TrafficFormat | null {
  if (typeof input !== 'string') {
    const root = input;
    if (root && typeof root.log === 'object' && root.log !== null) return 'HAR';
    if (Array.isArray(root?.resourceSpans) || Array.isArray(root?.resource_spans)) return 'OTLP';
    return null;
  }

  const trimmed = input.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const head = trimmed.slice(0, 8192);
    if (/"resource_?[sS]pans"/.test(head)) return 'OTLP';
    if (/"log"\s*:/.test(head)) return 'HAR';
    try {
      return detectFormat(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      /* fall through to the line formats */
    }
  }

  for (const line of trimmed.split('\n').slice(0, 40)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('{') && /"resource_?[sS]pans"/.test(t)) return 'OTLP';
    if (CLF_SHAPE.test(t)) return 'ACCESS_LOG';
  }
  return null;
}

// ── HAR ──────────────────────────────────────────────────────────────────────

/**
 * Read structurally rather than by importing the runner's HAR module: the agent
 * package does not depend on @qaai/runner (and must not — that file is copied
 * verbatim into the Playwright process, a different lifecycle), and a HAR that
 * arrives here was written by DevTools, Charles or a proxy at least as often as
 * by us. So this is tolerant: anything with a method, a URL and a timestamp is
 * an entry, and everything else is counted as skipped.
 */
function parseHar(root: unknown, max: number): ParseResult {
  const result = emptyParse();
  const log = (root as { log?: { entries?: unknown } } | null)?.log;
  const entries = Array.isArray(log?.entries) ? log.entries : null;
  if (!entries) {
    result.warnings.push('No `log.entries` array — that is not a HAR file.');
    return result;
  }

  for (const raw of entries) {
    if (result.entries.length >= max) {
      result.truncated = true;
      break;
    }
    const entry = raw as Record<string, unknown>;
    const request = entry.request as Record<string, unknown> | undefined;
    const response = entry.response as Record<string, unknown> | undefined;
    const url = typeof request?.url === 'string' ? request.url : null;
    const method = typeof request?.method === 'string' ? request.method : null;
    if (!request || !url || !method) {
      skip(result, 'entry has no request method or url');
      continue;
    }

    const at = typeof entry.startedDateTime === 'string' ? Date.parse(entry.startedDateTime) : NaN;
    if (Number.isNaN(at)) {
      skip(result, 'entry has no parseable startedDateTime');
      continue;
    }

    // Bodies are counted here and never read: `postData.text` and
    // `response.content.text` are not referenced anywhere in this file.
    if (request.postData) tally(result, 'REQUEST_BODY');
    const content = response?.content as Record<string, unknown> | undefined;
    if (content && (content.text !== undefined || Number(content.size ?? 0) > 0)) {
      tally(result, 'RESPONSE_BODY');
    }

    const headers = harHeaders(request.headers, result);
    const cookieHeader = headers.cookie ?? harCookieHeader(request.cookies, result);

    result.entries.push({
      at,
      method: method.toUpperCase(),
      target: url,
      status: typeof response?.status === 'number' ? response.status : null,
      durationMs: typeof entry.time === 'number' && entry.time >= 0 ? entry.time : null,
      mimeType: typeof content?.mimeType === 'string' ? content.mimeType : null,
      cookieHeader,
      // `serverIPAddress` is the SERVER's address, not the client's — it says
      // nothing about who was browsing, so it is not used as an identity.
      ip: null,
      userAgent: headers['user-agent'] ?? null,
      traceId: traceIdFromTraceparent(headers.traceparent ?? null),
      sessionId: null,
      endUserId: null,
      routeHint: null,
      hostHint: null,
      uploadScope: typeof entry.pageref === 'string' ? `har:${entry.pageref}` : 'har:upload',
    });
  }
  return result;
}

function harHeaders(raw: unknown, result: ParseResult): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const header = item as { name?: unknown; value?: unknown };
    if (typeof header?.name !== 'string' || typeof header?.value !== 'string') continue;
    out[header.name.toLowerCase()] = header.value;
  }
  // Every header value was read to find at most two of them, and none is kept.
  tally(result, 'HEADER', Object.keys(out).length);
  return out;
}

function harCookieHeader(raw: unknown, result: ParseResult): string | null {
  if (!Array.isArray(raw)) return null;
  const parts: string[] = [];
  for (const item of raw) {
    const cookie = item as { name?: unknown; value?: unknown };
    if (typeof cookie?.name === 'string' && typeof cookie?.value === 'string') {
      parts.push(`${cookie.name}=${cookie.value}`);
    }
  }
  if (parts.length > 0) tally(result, 'COOKIE', parts.length);
  return parts.length > 0 ? parts.join('; ') : null;
}

function traceIdFromTraceparent(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split('-');
  return parts.length >= 3 && parts[1] ? parts[1] : null;
}

// ── Access logs (Common / Combined) ──────────────────────────────────────────

/**
 * Deliberately not one strict regex over the whole line.
 *
 * Real access logs are Combined-plus-something: a virtual host in front, an
 * X-Forwarded-For LIST where the client should be, a response time bolted on
 * the end. Anchoring on the two structures every variant shares — the bracketed
 * timestamp and the quoted request line — parses all of those, where a strict
 * `^(\S+) (\S+) (\S+) \[…\]` gives up at the first comma in an XFF list.
 */
const CLF_SHAPE = /\[[^\]]+\]\s+"[A-Za-z]+ [^"]*"/;
const CLF_CORE = /^(.*?)\s*\[([^\]]+)\]\s+"([^"]*)"\s+(\d{3}|-)\s+(\S+)(.*)$/;
const CLF_TIME = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const IP_LIKE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f]*:[0-9a-f:]+$/i;

export function parseClfTimestamp(raw: string): number | null {
  const m = CLF_TIME.exec(raw.trim());
  if (!m) {
    const iso = Date.parse(raw);
    return Number.isNaN(iso) ? null : iso;
  }
  const [, dd, mon, yyyy, hh, mm, ss, tz] = m;
  const monthIndex = MONTHS.indexOf((mon ?? '').toLowerCase());
  if (monthIndex === -1) return null;
  const base = Date.UTC(Number(yyyy), monthIndex, Number(dd), Number(hh), Number(mm), Number(ss));
  if (!tz) return base;
  // "+0200" means local is ahead of UTC, so UTC is the stamp MINUS the offset.
  const sign = tz.startsWith('-') ? 1 : -1;
  const offsetMinutes = Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5));
  return base + sign * offsetMinutes * 60_000;
}

function parseAccessLog(text: string, max: number): ParseResult {
  const result = emptyParse();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue;
    if (result.entries.length >= max) {
      result.truncated = true;
      break;
    }

    const m = CLF_CORE.exec(line);
    if (!m) {
      // Line NUMBERS only. A malformed access-log line is precisely the content
      // this module exists to keep out of the database and out of a report.
      if (result.unparsedLineNumbers.length < MAX_UNPARSED_REPORTED) {
        result.unparsedLineNumbers.push(i + 1);
      }
      skip(result, 'line does not match Common/Combined Log Format');
      continue;
    }

    const [, prefix = '', stamp = '', requestLine = '', statusRaw = '', , trailer = ''] = m;
    const at = parseClfTimestamp(stamp);
    if (at === null) {
      if (result.unparsedLineNumbers.length < MAX_UNPARSED_REPORTED) {
        result.unparsedLineNumbers.push(i + 1);
      }
      skip(result, 'timestamp is not in CLF or ISO form');
      continue;
    }

    const requestParts = requestLine.split(/\s+/);
    const method = (requestParts[0] ?? '').toUpperCase();
    const target = requestParts[1] ?? '';
    if (!/^[A-Z]{3,10}$/.test(method) || !target) {
      skip(result, 'request line is not "METHOD TARGET PROTOCOL"');
      continue;
    }

    // The prefix is `[vhost] client ident authuser`. The client is the first
    // IP-shaped token (an XFF list's first element is the real client); the
    // last token is the authenticated username. Both are identifiers, both are
    // hashed downstream, neither is stored.
    const prefixTokens = prefix.trim().split(/\s+/).filter(Boolean);
    const clientToken = prefixTokens.find((t) => IP_LIKE.test(t.replace(/,$/, '')));
    const ip = clientToken ? clientToken.replace(/,$/, '') : (prefixTokens[0] ?? null);
    const authUser = prefixTokens.length >= 2 ? prefixTokens[prefixTokens.length - 1] : null;
    if (ip) tally(result, 'IP_ADDRESS');

    const quoted = [...trailer.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((q) => q[1] ?? '');
    const userAgent = quoted.length >= 2 ? (quoted[1] ?? null) : null;
    if (userAgent) tally(result, 'USER_AGENT');

    result.entries.push({
      at,
      method,
      target,
      status: statusRaw === '-' ? null : Number(statusRaw),
      // Some formats append $request_time, but its position is not reliable
      // across variants, so timing is reported unknown rather than guessed.
      durationMs: null,
      mimeType: null,
      cookieHeader: null,
      ip: ip && ip !== '-' ? ip : null,
      userAgent,
      traceId: null,
      sessionId: null,
      endUserId: authUser && authUser !== '-' ? authUser : null,
      routeHint: null,
      hostHint: null,
      uploadScope: null,
    });
  }

  if (result.entries.length > 0 && result.entries.every((e) => !e.userAgent)) {
    result.warnings.push(
      'These look like Common (not Combined) Log Format lines: no User-Agent, so sessions were ' +
        'grouped by IP alone and everyone behind one NAT collapses into a single user.',
    );
  }
  return result;
}

// ── OTLP JSON ────────────────────────────────────────────────────────────────

function attrValue(value: unknown): string | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return null;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.intValue === 'string' || typeof v.intValue === 'number') return String(v.intValue);
  if (typeof v.doubleValue === 'number') return String(v.doubleValue);
  if (typeof v.boolValue === 'boolean') return String(v.boolValue);
  return null;
}

function attrsToMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const attr = item as { key?: unknown; value?: unknown };
    if (typeof attr?.key !== 'string') continue;
    const value = attrValue(attr.value);
    if (value !== null) out[attr.key] = value;
  }
  return out;
}

function firstOf(map: Record<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = map[key];
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

function nanosToMs(raw: unknown): number | null {
  if (typeof raw === 'number') return raw / 1e6;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(BigInt(raw) / 1_000_000n);
  return null;
}

/** Span names are conventionally "GET /orders/{id}" — a template in disguise. */
function routeFromSpanName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  return /^[A-Z]{3,10}\s+(\/\S*)$/.exec(name.trim())?.[1] ?? null;
}

function joinPathAndQuery(path: string | null, query: string | null): string | null {
  if (!path) return null;
  return query ? `${path}?${query}` : path;
}

/**
 * OTLP is span-shaped, not request-shaped, so most of the work is deciding
 * which spans are HTTP requests at all. A database span or a queue-consumer
 * span is not a step in a user journey, and counting it as one would put noise
 * at the top of the ranking — the one place noise costs the most.
 */
function parseOtlp(root: unknown, max: number): ParseResult {
  const result = emptyParse();
  const container = root as { resourceSpans?: unknown; resource_spans?: unknown } | null;
  const resourceSpans = container?.resourceSpans ?? container?.resource_spans;
  if (!Array.isArray(resourceSpans)) {
    result.warnings.push('No `resourceSpans` array — that is not an OTLP JSON export.');
    return result;
  }

  for (const rs of resourceSpans) {
    const block = rs as Record<string, unknown>;
    const resourceAttrs = attrsToMap(
      (block.resource as Record<string, unknown> | undefined)?.attributes,
    );
    const scopeSpans = [block.scopeSpans, block.scope_spans, block.instrumentationLibrarySpans].find(
      (candidate): candidate is unknown[] => Array.isArray(candidate),
    );
    if (!scopeSpans) continue;

    for (const ss of scopeSpans) {
      const spans = (ss as { spans?: unknown }).spans;
      if (!Array.isArray(spans)) continue;

      for (const item of spans) {
        if (result.entries.length >= max) {
          result.truncated = true;
          return result;
        }
        const span = item as Record<string, unknown>;
        const attrs = { ...resourceAttrs, ...attrsToMap(span.attributes) };

        const method = firstOf(attrs, ['http.request.method', 'http.method']);
        if (!method) {
          skip(result, 'span carries no HTTP method (not a request)');
          continue;
        }
        const kind = span.kind;
        const known = kind === undefined || kind === null;
        const isServer = kind === 2 || kind === 'SPAN_KIND_SERVER';
        const isClient = kind === 3 || kind === 'SPAN_KIND_CLIENT';
        if (!known && !isServer && !isClient) {
          skip(result, 'span is neither a server nor a client HTTP span');
          continue;
        }

        const target =
          firstOf(attrs, ['url.full', 'http.url']) ??
          joinPathAndQuery(firstOf(attrs, ['url.path', 'http.target']), firstOf(attrs, ['url.query']));
        if (!target) {
          skip(result, 'HTTP span carries no url.path / http.target');
          continue;
        }

        const startMs = nanosToMs(span.startTimeUnixNano ?? span.start_time_unix_nano);
        if (startMs === null) {
          skip(result, 'span has no parseable startTimeUnixNano');
          continue;
        }
        const endMs = nanosToMs(span.endTimeUnixNano ?? span.end_time_unix_nano);
        const statusRaw = firstOf(attrs, ['http.response.status_code', 'http.status_code']);
        const cookie = firstOf(attrs, ['http.request.header.cookie']);
        if (cookie) tally(result, 'COOKIE');
        const ip = firstOf(attrs, ['client.address', 'net.peer.ip', 'http.client_ip']);
        if (ip) tally(result, 'IP_ADDRESS');
        const userAgent = firstOf(attrs, ['user_agent.original', 'http.user_agent']);
        if (userAgent) tally(result, 'USER_AGENT');

        result.entries.push({
          at: Math.round(startMs),
          method: method.toUpperCase(),
          target,
          status: statusRaw !== null && /^\d+$/.test(statusRaw) ? Number(statusRaw) : null,
          durationMs: endMs !== null ? Math.max(0, Math.round(endMs - startMs)) : null,
          mimeType: firstOf(attrs, [
            'http.response.header.content-type',
            'http.response_content_type',
          ]),
          cookieHeader: cookie,
          ip,
          userAgent,
          traceId: typeof span.traceId === 'string' ? span.traceId : null,
          sessionId: firstOf(attrs, ['session.id']),
          endUserId: firstOf(attrs, ['enduser.id', 'user.id']),
          // The application published its own route template. Trust it over our
          // statistics — it cannot be wrong about its own routing table.
          routeHint: firstOf(attrs, ['http.route']) ?? routeFromSpanName(span.name),
          hostHint: firstOf(attrs, ['server.address', 'http.host', 'net.host.name']),
          uploadScope: null,
        });
      }
    }
  }
  return result;
}

/** OTLP is very often shipped as one batch per line, which is not one document. */
function parseOtlpNdjson(text: string, max: number): ParseResult {
  const merged = emptyParse();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (merged.unparsedLineNumbers.length < MAX_UNPARSED_REPORTED) {
        merged.unparsedLineNumbers.push(i + 1);
      }
      skip(merged, 'line is not valid JSON');
      continue;
    }

    const one = parseOtlp(parsed, max - merged.entries.length);
    merged.entries.push(...one.entries);
    merged.skipped += one.skipped;
    for (const [reason, count] of Object.entries(one.skippedReasons)) {
      merged.skippedReasons[reason] = (merged.skippedReasons[reason] ?? 0) + count;
    }
    for (const [kind, count] of Object.entries(one.tally)) {
      tally(merged, kind as RedactionKind, count ?? 0);
    }
    merged.truncated ||= one.truncated;
    if (merged.entries.length >= max) {
      merged.truncated = true;
      break;
    }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Raw → redacted events
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_COOKIE_NAMES = new Set([
  'sid',
  'sessionid',
  'session_id',
  'session',
  'connect.sid',
  'jsessionid',
  'phpsessid',
  'laravel_session',
  '_session_id',
  'asp.net_sessionid',
  '__session',
  'qaai_session',
]);

/** Reads a session cookie's VALUE only to hash it; keeps neither name nor value. */
function sessionCookieValue(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (!value) continue;
    if (SESSION_COOKIE_NAMES.has(name) || /session|(^|_)sid$/.test(name)) return value;
  }
  return null;
}

const BOT_UA =
  /bot|crawler|spider|slurp|curl\/|wget|python-requests|go-http-client|okhttp|headlesschrome|phantomjs|pingdom|uptimerobot|newrelic|datadog|monitoring|checkly|synthetics|zabbix|nagios/i;

const STATIC_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'css',
  'map',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'ico',
  'webp',
  'avif',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp4',
  'webm',
  'mp3',
]);

const NOISE_ROUTES = new Set([
  '/health',
  '/healthz',
  '/health/ready',
  '/ping',
  '/metrics',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
]);

function contentKindOf(mimeType: string | null): ContentKind {
  if (!mimeType) return 'unknown';
  const m = mimeType.toLowerCase();
  if (m.includes('html')) return 'html';
  if (m.includes('json') || m.includes('graphql')) return 'json';
  return 'other';
}

interface IdentityDecision {
  key: string;
  source: IdentitySource;
}

function identityFor(entry: RawEntry, redactor: Redactor): IdentityDecision {
  if (entry.sessionId) {
    redactor.count('USER_IDENTIFIER');
    return { key: redactor.hash('SESSION_ID', entry.sessionId), source: 'SESSION_ID' };
  }
  const cookie = sessionCookieValue(entry.cookieHeader);
  if (cookie) {
    redactor.count('COOKIE');
    return { key: redactor.hash('SESSION_COOKIE', cookie), source: 'SESSION_COOKIE' };
  }
  if (entry.endUserId) {
    redactor.count('USER_IDENTIFIER');
    return { key: redactor.hash('END_USER_ID', entry.endUserId), source: 'END_USER_ID' };
  }
  if (entry.traceId) {
    // Honest caveat, kept beside the code that does it: a trace id identifies
    // ONE distributed request, not one user. Grouping by it yields journeys of
    // fan-out rather than journeys of navigation, which is why it ranks below
    // session.id and the session cookie.
    return { key: redactor.hash('TRACE_ID', entry.traceId), source: 'TRACE_ID' };
  }
  if (entry.ip) {
    redactor.count('IP_ADDRESS');
    if (entry.userAgent) redactor.count('USER_AGENT');
    return { key: redactor.hash('IP_UA', `${entry.ip} ${entry.userAgent ?? ''}`), source: 'IP_UA' };
  }
  if (entry.uploadScope) {
    return { key: redactor.hash('UPLOAD_SCOPE', entry.uploadScope), source: 'UPLOAD_SCOPE' };
  }
  return { key: '', source: 'NONE' };
}

interface EventsResult {
  events: TrafficEvent[];
  parameterisation: ParameterisationNote[];
  unattributed: number;
}

/**
 * The only door out of the raw data.
 *
 * Two passes, because parameterisation cannot tell an id from a route name
 * until it has seen every path — but the per-segment classification that
 * removes PII happens in the FIRST pass, so no raw segment is still alive
 * during the second.
 */
function toEvents(
  raw: readonly RawEntry[],
  redactor: Redactor,
  opts: { paramDistinctThreshold: number },
): EventsResult {
  interface Staged {
    entry: RawEntry;
    segments: ClassifiedSegment[];
    queryKeys: string[];
    host: string | null;
    identity: IdentityDecision;
    declaredRoute: string | null;
  }

  const staged: Staged[] = [];
  let unattributed = 0;

  for (const entry of raw) {
    const sanitised = sanitisePath(entry.target, redactor);
    const identity = identityFor(entry, redactor);
    if (identity.source === 'NONE') unattributed += 1;

    // An application-declared template ({id}, :id, <id>) is still classified,
    // because "the app said so" is not a reason to trust a segment that turns
    // out to be an email address.
    const declaredRoute = entry.routeHint
      ? routeOf(sanitisePath(entry.routeHint, redactor).segments)
      : null;

    staged.push({
      entry,
      segments: sanitised.segments,
      queryKeys: sanitised.queryKeys,
      host: sanitised.host ?? entry.hostHint?.toLowerCase() ?? null,
      identity,
      declaredRoute,
    });
  }

  const { templates, notes } = buildRouteTemplates(
    staged.map((s) => s.segments),
    opts.paramDistinctThreshold,
  );

  const events = staged.map((s, index): TrafficEvent => {
    const route = s.declaredRoute ?? templates[index] ?? '/';
    const lastSegment = s.segments[s.segments.length - 1]?.text ?? '';
    const dot = lastSegment.lastIndexOf('.');
    const extension = dot > 0 ? lastSegment.slice(dot + 1).toLowerCase() : '';

    return {
      at: s.entry.at,
      method: s.entry.method,
      route,
      host: s.host,
      status: s.entry.status,
      durationMs: s.entry.durationMs,
      contentKind: contentKindOf(s.entry.mimeType),
      queryKeys: s.queryKeys,
      // An entry with no identity signal at all becomes its own session rather
      // than joining one big fictitious one. A journey we cannot evidence is
      // worse than no journey.
      identityKey: s.identity.key || `unattributed:${index}`,
      identitySource: s.identity.source,
      routeFromSource: s.declaredRoute !== null,
      isStaticAsset: STATIC_EXTENSIONS.has(extension) || NOISE_ROUTES.has(route),
      isBot: BOT_UA.test(s.entry.userAgent ?? ''),
    };
  });

  return { events, parameterisation: notes, unattributed };
}

/** `{id}` and `<id>` are the same statement as `:id`; say it one way. */
function normaliseTemplateSegment(text: string): string {
  const m = /^[{<](.+)[}>]$/.exec(text);
  return m?.[1] ? `:${m[1]}` : text;
}

function routeOf(segments: readonly ClassifiedSegment[]): string {
  if (segments.length === 0) return '/';
  return `/${segments.map((s) => normaliseTemplateSegment(s.text)).join('/')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Parameterisation — /orders/1001 and /orders/1002 are one journey
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Syntactic classification already collapsed the obvious identifiers. This
 * second pass catches the ones only the corpus can reveal —
 * `/products/red-running-shoe`, `/u/jsmith` — by looking at how many distinct
 * values share a position under the same parent.
 *
 * The guard that matters is the RATIO. Ten top-level pages each hit fifty times
 * are ten routes (ratio 0.02); ten values each hit once at the same position
 * are ten identifiers (ratio 1.0). Requiring a distinct-count floor AND a high
 * ratio AND a minimum sample is what stops `/login`, `/cart` and `/help` from
 * being collapsed into `/:param` on a site with many top-level pages.
 *
 * Every collapse is reported, because this is the one step in the pipeline that
 * is a judgement call and the customer should be able to disagree with it.
 */
export function buildRouteTemplates(
  paths: readonly (readonly ClassifiedSegment[])[],
  distinctThreshold = DEFAULT_PARAM_DISTINCT_THRESHOLD,
): { templates: string[]; notes: ParameterisationNote[] } {
  const templates = new Array<string>(paths.length).fill('/');
  const notes: ParameterisationNote[] = [];

  interface Rec {
    index: number;
    segments: readonly ClassifiedSegment[];
  }

  const walk = (prefix: string[], group: Rec[], depth: number): void => {
    const here = prefix.length === 0 ? '/' : `/${prefix.join('/')}`;
    for (const rec of group) {
      if (rec.segments.length === depth) templates[rec.index] = here;
    }

    const deeper = group.filter((rec) => rec.segments.length > depth);
    if (deeper.length === 0) return;

    const buckets = new Map<string, Rec[]>();
    for (const rec of deeper) {
      const key = normaliseTemplateSegment(rec.segments[depth]?.text ?? '');
      const list = buckets.get(key);
      if (list) list.push(rec);
      else buckets.set(key, [rec]);
    }

    const literalKeys = [...buckets.keys()].filter((k) => !k.startsWith(':'));
    const literalObservations = literalKeys.reduce((sum, k) => sum + (buckets.get(k)?.length ?? 0), 0);
    const ratio = literalObservations > 0 ? literalKeys.length / literalObservations : 0;

    if (
      literalKeys.length >= distinctThreshold &&
      literalObservations >= PARAM_MIN_OBSERVATIONS &&
      ratio >= 0.5
    ) {
      const merged: Rec[] = [];
      for (const key of literalKeys) {
        merged.push(...(buckets.get(key) ?? []));
        buckets.delete(key);
      }
      notes.push({
        template: `${here === '/' ? '' : here}/${PLACEHOLDER.param}`,
        distinctValues: literalKeys.length,
        observations: literalObservations,
        reason:
          `${literalKeys.length} distinct values across ${literalObservations} requests at this ` +
          'position — high cardinality with few repeats reads as an identifier, not a page.',
      });
      const existing = buckets.get(PLACEHOLDER.param);
      if (existing) existing.push(...merged);
      else buckets.set(PLACEHOLDER.param, merged);
    }

    // Sorted, so the output does not depend on input order.
    for (const key of [...buckets.keys()].sort()) {
      walk([...prefix, key], buckets.get(key) ?? [], depth + 1);
    }
  };

  walk(
    [],
    paths.map((segments, index) => ({ index, segments })),
    0,
  );

  return { templates, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Sessionisation
// ─────────────────────────────────────────────────────────────────────────────

export function sessionise(
  events: readonly TrafficEvent[],
  opts: { sessionGapMs?: number; maxSessionMs?: number } = {},
): TrafficSession[] {
  const gap = opts.sessionGapMs ?? DEFAULT_SESSION_GAP_MS;
  const maxSpan = opts.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;

  const byIdentity = new Map<string, TrafficEvent[]>();
  for (const event of events) {
    const list = byIdentity.get(event.identityKey);
    if (list) list.push(event);
    else byIdentity.set(event.identityKey, [event]);
  }

  const sessions: TrafficSession[] = [];
  for (const [key, list] of [...byIdentity.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Stable ordering within equal timestamps: an access log has one-second
    // resolution, so several requests land on the same tick and their order
    // must not vary between runs of the same upload.
    const ordered = [...list].sort(
      (a, b) => a.at - b.at || a.route.localeCompare(b.route) || a.method.localeCompare(b.method),
    );

    let current: TrafficEvent[] = [];
    let truncated = false;

    const flush = (): void => {
      if (current.length === 0) return;
      const first = current[0]!;
      const last = current[current.length - 1]!;
      sessions.push({
        key: `${key}:${first.at}`,
        identitySource: first.identitySource,
        events: current,
        startedAt: first.at,
        endedAt: last.at,
        truncated,
      });
      current = [];
      truncated = false;
    };

    for (const event of ordered) {
      const previous = current[current.length - 1];
      const start = current[0];
      const gapExceeded = previous !== undefined && event.at - previous.at > gap;
      const spanExceeded = start !== undefined && event.at - start.at > maxSpan;
      if (gapExceeded || spanExceeded) flush();

      if (current.length >= MAX_STEPS_PER_SESSION) {
        // A session this long is a crawler or a tab left open for a day, and
        // its tail adds nothing but noise to the ranking. Cut it, and say so.
        truncated = true;
        continue;
      }
      current.push(event);
    }
    flush();
  }

  return sessions.sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Journeys and ranking
// ─────────────────────────────────────────────────────────────────────────────

export function stepKey(step: StepKey): string {
  return `${step.method} ${step.route}`;
}

export function journeySignature(steps: readonly StepKey[]): string {
  return steps.map(stepKey).join(' → ');
}

/** Deterministic id — a client can round-trip it and the API can re-derive it. */
export function journeyIdOf(steps: readonly StepKey[]): string {
  return createHmac('sha256', 'qaai.traffic.journey')
    .update(journeySignature(steps))
    .digest('hex')
    .slice(0, 20);
}

interface CanonicalSession {
  session: TrafficSession;
  steps: Array<{ key: StepKey; events: TrafficEvent[] }>;
  signature: string;
}

/** Consecutive repeats are polling, not steps: three cart reads are one read. */
function canonicalise(session: TrafficSession): CanonicalSession {
  const steps: CanonicalSession['steps'] = [];
  for (const event of session.events) {
    const previous = steps[steps.length - 1];
    if (previous && previous.key.method === event.method && previous.key.route === event.route) {
      previous.events.push(event);
      continue;
    }
    steps.push({ key: { method: event.method, route: event.route }, events: [event] });
  }
  return { session, steps, signature: journeySignature(steps.map((s) => s.key)) };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function modalStatus(events: readonly TrafficEvent[]): number | null {
  const counts = new Map<number, number>();
  for (const event of events) {
    if (event.status === null) continue;
    counts.set(event.status, (counts.get(event.status) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [status, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = status;
      bestCount = count;
    }
  }
  return best;
}

/** Is `needle` a contiguous run inside `haystack`? */
function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function mergeContentKinds(events: readonly TrafficEvent[]): ContentKind {
  const kinds = new Set(events.map((e) => e.contentKind).filter((k) => k !== 'unknown'));
  if (kinds.size === 0) return 'unknown';
  if (kinds.size === 1) return [...kinds][0]!;
  return 'mixed';
}

export interface RankOptions {
  maxJourneys?: number;
  existingTests?: readonly ExistingTest[];
}

/**
 * Ranks journeys by how many sessions walk them.
 *
 * Two percentages are reported and they answer different questions.
 * `sessionShare` is the share of sessions whose ENTIRE path is this journey —
 * precise, and brittle, because one extra step forks a new journey.
 * `containingSessionShare` is the share of sessions that contain the sequence
 * anywhere. The second is the number to quote at a customer ("60% of your
 * sessions walk this"), the first is the number that says how uniform they are.
 * Reporting only one of them would be a claim the data does not support.
 */
export function rankJourneys(
  sessions: readonly TrafficSession[],
  opts: RankOptions = {},
): Journey[] {
  const maxJourneys = Math.min(opts.maxJourneys ?? DEFAULT_MAX_JOURNEYS, MAX_RANKED_CANDIDATES);
  const canonical = sessions.map(canonicalise).filter((c) => c.steps.length > 0);
  const totalSessions = canonical.length;
  if (totalSessions === 0) return [];

  const groups = new Map<string, CanonicalSession[]>();
  for (const c of canonical) {
    const list = groups.get(c.signature);
    if (list) list.push(c);
    else groups.set(c.signature, [c]);
  }

  const ordered = [...groups.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    const aRequests = a[1].reduce((n, c) => n + c.session.events.length, 0);
    const bRequests = b[1].reduce((n, c) => n + c.session.events.length, 0);
    if (bRequests !== aRequests) return bRequests - aRequests;
    return a[0].localeCompare(b[0]); // deterministic tie-break
  });

  const allSignatures = canonical.map((c) => c.steps.map((s) => stepKey(s.key)));

  return ordered.slice(0, maxJourneys).map(([, members]) => {
    const first = members[0]!;
    const steps: JourneyStep[] = first.steps.map((_, i) => {
      const observations = members.flatMap((m) => m.steps[i]?.events ?? []);
      const key = first.steps[i]!.key;
      const withStatus = observations.filter((e) => e.status !== null);
      const failures = withStatus.filter((e) => (e.status ?? 0) >= 400).length;
      return {
        method: key.method,
        route: key.route,
        status: modalStatus(observations),
        errorRate: withStatus.length > 0 ? failures / withStatus.length : 0,
        count: observations.length,
        repeats: observations.length - members.length,
      };
    });

    const keys = steps.map(stepKey);
    const containing = allSignatures.filter((sig) => containsSequence(sig, keys)).length;
    const allEvents = members.flatMap((m) => m.session.events);
    const withStatus = allEvents.filter((e) => e.status !== null);
    const errors = withStatus.filter((e) => (e.status ?? 0) >= 400).length;
    const durations = members
      .map((m) => m.session.endedAt - m.session.startedAt)
      .filter((d) => d > 0);
    const contentKind = mergeContentKinds(allEvents);
    const sessionShare = members.length / totalSessions;

    return {
      id: journeyIdOf(steps),
      name: journeyName(steps),
      feature: featureOf(steps),
      steps,
      sessionCount: members.length,
      sessionShare,
      containingSessionCount: containing,
      containingSessionShare: containing / totalSessions,
      requestCount: allEvents.length,
      medianDurationMs: median(durations),
      errorRate: withStatus.length > 0 ? errors / withStatus.length : 0,
      firstSeen: new Date(Math.min(...members.map((m) => m.session.startedAt))).toISOString(),
      lastSeen: new Date(Math.max(...members.map((m) => m.session.endedAt))).toISOString(),
      contentKind,
      identitySources: [...new Set(members.map((m) => m.session.identitySource))].sort(),
      // A journey of JSON calls is an API test; anything that navigated HTML is
      // a browser journey. Unknown content (an access log carries none) leans
      // E2E, because that is what a page-shaped path usually was.
      suggestedTestType: contentKind === 'json' ? 'API' : 'E2E',
      suggestedPriority:
        sessionShare >= 0.2 ? 'CRITICAL_PATH' : sessionShare >= 0.05 ? 'IMPORTANT' : 'NICE_TO_HAVE',
      coverage: crossReferenceSteps(steps, opts.existingTests ?? []),
    };
  });
}

const STOP_SEGMENTS = new Set(['api', 'v1', 'v2', 'v3', 'graphql', 'public', 'www', 'app']);

function featureOf(steps: readonly JourneyStep[]): string {
  // The feature is the most specific thing the journey ENDS at: a journey that
  // finishes at /checkout is a checkout journey even if it started at /.
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    for (const seg of (steps[i]?.route ?? '').split('/').filter(Boolean)) {
      if (seg.startsWith(':') || STOP_SEGMENTS.has(seg)) continue;
      return seg
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .slice(0, 60);
    }
  }
  return 'Traffic';
}

function journeyName(steps: readonly JourneyStep[]): string {
  const shown = steps.slice(0, 6).map((s) => s.route);
  const suffix = steps.length > 6 ? ` (+${steps.length - 6} more)` : '';
  return `${shown.join(' → ')}${suffix}`.slice(0, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Cross-reference: a journey the suite already covers is not a proposal
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_LITERAL = /(['"`])((?:https?:\/\/[^'"`\s]*)?\/[^'"`\s]*)\1/g;
const INTERPOLATION = /\$\{[^}]*\}|\{\{[^}]*\}\}/g;

/**
 * Route shapes are compared with every placeholder flattened: `/orders/:id`,
 * `/orders/:orderId` and `/orders/{id}` are the same route, and a coverage
 * check that says otherwise would propose a test that already exists.
 */
export function routeShape(route: string): string {
  return route
    .toLowerCase()
    .split('/')
    .map((seg) => (seg.startsWith(':') ? ':*' : seg))
    .join('/');
}

/** Every path-shaped string literal in a test, normalised the way traffic is. */
export function routesMentionedIn(test: ExistingTest): Set<string> {
  const haystacks = [test.code ?? ''];
  if (test.spec !== undefined && test.spec !== null) {
    try {
      haystacks.push(JSON.stringify(test.spec));
    } catch {
      /* a spec that will not serialise contributes nothing */
    }
  }

  const out = new Set<string>();
  for (const haystack of haystacks) {
    for (const match of haystack.matchAll(ROUTE_LITERAL)) {
      const literal = match[2];
      if (!literal) continue;
      // `/orders/${orderId}` is a parameterised route in disguise; turn the
      // interpolation into a placeholder before classifying.
      const withPlaceholders = literal.replace(INTERPOLATION, ':param');
      out.add(routeShape(routeOf(sanitisePath(withPlaceholders).segments)));
    }
  }
  return out;
}

/**
 * Matching is on route text, not execution, and the returned `basis` says so.
 *
 * Overclaiming coverage is the expensive mistake: it hides a journey nobody
 * actually tests. Underclaiming only costs a duplicate proposal that a human
 * declines in one click — so the thresholds lean towards proposing.
 */
export function crossReferenceSteps(
  steps: readonly StepKey[],
  tests: readonly ExistingTest[],
): JourneyCoverage {
  const basis =
    'Route templates mentioned in each test’s source (and its API spec) matched against the ' +
    'journey’s steps, with placeholders flattened. Text matching, not execution: a test that ' +
    'names a route but never exercises it reads here as covering it.';

  if (steps.length === 0 || tests.length === 0) {
    return {
      status: 'UNCOVERED',
      matchedRatio: 0,
      matchedTests: [],
      missingSteps: steps.map(stepKey),
      basis,
    };
  }

  const wanted = steps.map((s) => routeShape(s.route));
  let best: { matched: boolean[]; count: number } | null = null;
  const matchedTests: JourneyCoverage['matchedTests'] = [];

  for (const test of tests) {
    const routes = routesMentionedIn(test);
    const matched = wanted.map((route) => routes.has(route));
    const count = matched.filter(Boolean).length;
    if (count === 0) continue;
    matchedTests.push({ id: test.id, name: test.name, matchedSteps: count });
    if (!best || count > best.count) best = { matched, count };
  }

  const ratio = best ? best.count / steps.length : 0;
  const bestMatched = best?.matched;
  const missingSteps = bestMatched
    ? steps.filter((_, i) => !bestMatched[i]).map(stepKey)
    : steps.map(stepKey);

  return {
    status: ratio >= 0.8 ? 'COVERED' : ratio >= 0.4 ? 'PARTIAL' : 'UNCOVERED',
    matchedRatio: ratio,
    matchedTests: matchedTests
      .sort((a, b) => b.matchedSteps - a.matchedSteps || a.id.localeCompare(b.id))
      .slice(0, 10),
    missingSteps,
    basis,
  };
}

export function crossReference(
  journeys: readonly Journey[],
  tests: readonly ExistingTest[],
): Journey[] {
  return journeys.map((journey) => ({
    ...journey,
    coverage: crossReferenceSteps(journey.steps, tests),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Journey → plan item (what the Generator actually reads)
// ─────────────────────────────────────────────────────────────────────────────

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Deterministic: no model turns a journey into a plan item.
 *
 * The Generator writes the CODE. The argument for writing it at all is
 * arithmetic over the customer's own traffic, and arithmetic should not be
 * paraphrased by a language model — a hallucinated percentage would discredit
 * the only claim this feature makes.
 */
export function journeyToPlanItem(
  journey: Journey,
  context: { totalSessions: number; source: TrafficFormat; testType?: TestType },
): PlanItemDraft {
  const verb = journey.contentKind === 'json' ? 'Call' : 'Open';
  const parameterised = journey.steps.filter((s) => s.route.includes(':'));

  const steps = journey.steps.map((step, i) => {
    const status = step.status !== null ? `, which returns ${step.status} in production` : '';
    const repeats =
      step.repeats > 0
        ? ` (production repeats this call ${step.repeats} more times across these sessions; once is enough for a test)`
        : '';
    return `${i + 1}. ${verb} ${step.method} ${step.route}${status}${repeats}.`;
  });

  if (parameterised.length > 0) {
    steps.push(
      `${journey.steps.length + 1}. The routes ${parameterised
        .map((s) => s.route)
        .join(', ')} carry an identifier that was stripped on ingest. Create or look up a real ` +
        'record inside the test and use its id — never hard-code one taken from production.',
    );
  }

  const assertions = journey.steps.map((step) =>
    step.status !== null
      ? `${step.method} ${step.route} responds ${step.status}, as it does for ${percent(
          1 - step.errorRate,
        )} of real requests.`
      : `${step.method} ${step.route} responds successfully.`,
  );
  assertions.push('No step in the journey returns a 5xx.');
  if (journey.contentKind !== 'json') {
    assertions.push(
      'The state reached at the end of the journey shows the outcome a user would expect — assert on meaning, not on markup.',
    );
  }

  const sourceLabel =
    context.source === 'ACCESS_LOG'
      ? 'access logs'
      : context.source === 'OTLP'
        ? 'OpenTelemetry spans'
        : 'a HAR capture';

  const rationale =
    `Reconstructed from ${sourceLabel} taken from production. ${journey.sessionCount} of ` +
    `${context.totalSessions} sessions (${percent(journey.sessionShare)}) walked exactly this ` +
    `path, and ${percent(journey.containingSessionShare)} of sessions contain it. ` +
    `${journey.requestCount} requests between ${journey.firstSeen} and ${journey.lastSeen}` +
    `${journey.errorRate > 0 ? `, ${percent(journey.errorRate)} of which failed in production` : ''}. ` +
    `The suite covers it today: ${journey.coverage.status.toLowerCase()}` +
    `${
      journey.coverage.matchedTests.length > 0
        ? ` (closest existing test: "${journey.coverage.matchedTests[0]!.name}")`
        : ''
    }.`;

  return {
    title: `${journey.feature}: ${journey.name}`.slice(0, 160),
    rationale,
    feature: journey.feature,
    priority: journey.suggestedPriority,
    testType: context.testType ?? journey.suggestedTestType,
    steps,
    assertions,
    journeyId: journey.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. The entry point
// ─────────────────────────────────────────────────────────────────────────────

export class TrafficFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrafficFormatError';
  }
}

function parseInput(
  input: string | Record<string, unknown>,
  format: TrafficFormat,
  max: number,
): ParseResult {
  if (format === 'ACCESS_LOG') {
    if (typeof input !== 'string') {
      throw new TrafficFormatError('Access logs must be uploaded as text, not as JSON.');
    }
    return parseAccessLog(input, max);
  }

  let document: unknown = input;
  if (typeof input === 'string') {
    try {
      document = JSON.parse(input);
    } catch (err) {
      // OTLP is very often shipped one batch per line, which is not a valid
      // JSON document as a whole. Try that before declaring the upload broken.
      if (format === 'OTLP') {
        const ndjson = parseOtlpNdjson(input, max);
        if (ndjson.entries.length > 0) return ndjson;
      }
      throw new TrafficFormatError(
        `Upload is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }

  return format === 'HAR' ? parseHar(document, max) : parseOtlp(document, max);
}

export function analyzeTraffic(
  input: string | Record<string, unknown>,
  opts: AnalyzeOptions = {},
): TrafficAnalysis {
  if (typeof input === 'string' && Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    throw new TrafficFormatError(
      `Upload is larger than ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)}MB — narrow the time ` +
        'window or split the file.',
    );
  }

  const requested = opts.format && opts.format !== 'AUTO' ? opts.format : null;
  const format = requested ?? detectFormat(input);
  if (!format) {
    throw new TrafficFormatError(
      'Could not tell what this is. Accepted: a HAR file (`log.entries`), Common/Combined ' +
        'access-log lines, or OpenTelemetry OTLP JSON (`resourceSpans`).',
    );
  }

  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const redactor = new Redactor(opts.identitySalt);
  const parsed = parseInput(input, format, max);

  // Fold in what the parsers saw and refused to read, so the report counts the
  // bodies and headers that never reached an event.
  for (const [kind, count] of Object.entries(parsed.tally)) {
    redactor.count(kind as RedactionKind, count ?? 0);
  }

  const { events, parameterisation, unattributed } = toEvents(parsed.entries, redactor, {
    paramDistinctThreshold: opts.paramDistinctThreshold ?? DEFAULT_PARAM_DISTINCT_THRESHOLD,
  });

  const warnings = [...parsed.warnings];
  const staticAssets = events.filter((e) => e.isStaticAsset).length;
  const botRequests = events.filter((e) => e.isBot).length;

  const kept = events.filter(
    (event) =>
      (opts.includeStaticAssets === true || !event.isStaticAsset) &&
      (opts.includeBots === true || !event.isBot),
  );

  const sessions = sessionise(kept, {
    sessionGapMs: opts.sessionGapMs ?? DEFAULT_SESSION_GAP_MS,
    maxSessionMs: opts.maxSessionMs ?? DEFAULT_MAX_SESSION_MS,
  });

  const identityBreakdown: Partial<Record<IdentitySource, number>> = {};
  for (const session of sessions) {
    identityBreakdown[session.identitySource] = (identityBreakdown[session.identitySource] ?? 0) + 1;
  }

  if (unattributed > 0) {
    warnings.push(
      `${unattributed} requests carried no session cookie, trace id or client address. Each was ` +
        'treated as its own session, so they cannot form a multi-step journey.',
    );
  }
  if ((identityBreakdown.UPLOAD_SCOPE ?? 0) > 0) {
    warnings.push(
      'This upload carried no session cookie or trace id, so the whole file was treated as one ' +
        'client and split into sessions by inactivity. That is right for a HAR (one browser, one ' +
        'person) and wrong for a multi-user export.',
    );
  }
  if ((identityBreakdown.TRACE_ID ?? 0) > 0) {
    warnings.push(
      'Some sessions were grouped by trace id, which identifies one distributed request rather ' +
        'than one user. Those journeys describe service fan-out, not navigation — export a ' +
        '`session.id` attribute if you want user journeys from spans.',
    );
  }
  if (botRequests > 0 && opts.includeBots !== true) {
    warnings.push(
      `${botRequests} requests came from bots, crawlers or uptime monitors and were excluded — ` +
        'they would otherwise dominate the ranking with paths no human walks.',
    );
  }
  if (parsed.truncated) {
    warnings.push(
      `Stopped after ${max} entries. The ranking describes that prefix of the upload, not all of it.`,
    );
  }
  if (sessions.length > 0 && sessions.length < 5) {
    warnings.push(
      `Only ${sessions.length} sessions in this upload. Frequencies from a sample this small are ` +
        'descriptive, not predictive — upload a longer window before ranking on them.',
    );
  }
  if (opts.existingTests === undefined) {
    warnings.push('No existing tests were supplied, so every journey is reported as uncovered.');
  }

  const journeys = rankJourneys(sessions, {
    maxJourneys: opts.maxJourneys ?? DEFAULT_MAX_JOURNEYS,
    existingTests: opts.existingTests ?? [],
  });

  const times = kept.map((e) => e.at);
  const window =
    times.length > 0
      ? {
          from: new Date(Math.min(...times)).toISOString(),
          to: new Date(Math.max(...times)).toISOString(),
        }
      : null;

  return {
    format,
    redaction: buildRedactionReport(redactor),
    totals: {
      parsed: parsed.entries.length,
      skipped: parsed.skipped,
      skippedReasons: parsed.skippedReasons,
      unparsedLineNumbers: parsed.unparsedLineNumbers,
      requests: kept.length,
      staticAssetsFiltered: opts.includeStaticAssets === true ? 0 : staticAssets,
      botRequestsFiltered: opts.includeBots === true ? 0 : botRequests,
      sessions: sessions.length,
      truncated: parsed.truncated,
    },
    window,
    journeys,
    parameterisation,
    identityBreakdown,
    warnings,
  };
}
