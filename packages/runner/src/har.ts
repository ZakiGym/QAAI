/**
 * Hermetic replay — record the network once, serve it forever.
 *
 * A suite at the mercy of a third-party API is a suite that goes red when
 * someone else deploys. This module lets a run capture every request/response
 * pair it makes into a HAR-shaped artifact, and lets a later run serve those
 * responses back so that nothing leaves the machine.
 *
 * Four decisions are worth defending, because each of them is the difference
 * between a hermetic run and a run that merely claims to be one:
 *
 *  1. A MISS IS NEVER SILENT. In replay, a request with no recording is
 *     aborted by default — nothing reaches the network, which is the whole
 *     promise — and every miss is reported back to the plugin, which puts it
 *     in the result. `onMiss: 'passthrough'` exists because sometimes you want
 *     the run to finish, but it does not get to be quiet about it: a run with
 *     even one passthrough is reported as NOT HERMETIC, in the result, whether
 *     the test passed or failed. A silent passthrough that quietly makes a
 *     "hermetic" run non-hermetic is a lie, and this file refuses to tell it.
 *
 *  2. MATCHING IS NORMALISED, NOT EXACT. Exact URL matching makes a recording
 *     useless within a day: one cache-buster, one `?t=1738…`, one reordered
 *     query string and every entry misses. Requests are keyed on method plus a
 *     normalised URL — volatile params dropped, remaining params sorted, host
 *     lowercased, default port and fragment removed — and the drop-list is
 *     configurable per test.
 *
 *  3. CREDENTIALS ARE STRIPPED ON THE WAY IN. A recording is an artifact; it
 *     can be downloaded, attached to a ticket, committed as a fixture. So
 *     `Authorization`, `Cookie`, `Set-Cookie`, API-key headers, credential-ish
 *     query params, bearer tokens and JWTs in bodies, and the values of this
 *     environment's own secrets are replaced at CAPTURE time. Redacting on the
 *     way out would mean the secret existed on disk in between, and "we redact
 *     it when you export it" is exactly the guarantee that fails the one time
 *     someone reads the file some other way. The archive says so about itself,
 *     in `log._qaai.redaction`.
 *
 *  4. RECORDINGS GO STALE, AND SAY SO. The archive carries `recordedAt`; a
 *     replay off an old recording carries a warning into the result. It is a
 *     warning and not a failure, because "this recording is three months old"
 *     is not a verdict on the application under test.
 *
 * This file is also SHIPPED INTO THE PLAYWRIGHT PROCESS: the e2e plugin copies
 * this exact source next to the generated spec so that `installHar` can install
 * the route handler in-process. That is why it imports nothing but node
 * builtins and describes Playwright's objects structurally — one file, one
 * implementation, tested once, with no chance of the recorder and the matcher
 * drifting apart.
 */

import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Configuration ───────────────────────────────────────────────────────────

/** `off` is the default everywhere; enabling this is always explicit. */
export type HarMode = 'off' | 'record' | 'replay';

/**
 * What happens to a replayed request that has no recording.
 *
 * `abort` keeps the promise (nothing reaches the network) and usually fails the
 * test, which is honest but brittle when a recording is merely incomplete.
 * `passthrough` lets it out to the live network, which is convenient and
 * destroys hermeticity — so it is never the default and never silent.
 */
export type HarMissRule = 'abort' | 'passthrough';

/**
 * `all` intercepts everything, including the application's own origin: the
 * strict reading of "nothing reaches the network". `third-party` intercepts
 * only other origins, which is the pragmatic reading — the app under test
 * serves itself, and only its dependencies are frozen.
 */
export type HarScope = 'all' | 'third-party';

export interface HarNormalisation {
  /** Query parameter names dropped before matching. Case-insensitive. */
  dropQueryParams: string[];
  /** Regex sources; a parameter whose NAME matches any of them is dropped. */
  dropQueryParamPatterns: string[];
  /** Drop the query string entirely. Blunt, occasionally exactly right. */
  ignoreQuery: boolean;
  /** Match on path only. Makes a recording portable and collisions possible. */
  ignoreHost: boolean;
}

export interface HarConfig {
  mode: Exclude<HarMode, 'off'>;
  /** Where the recording lives, as a fixture path relative to the workspace. */
  path: string;
  onMiss: HarMissRule;
  scope: HarScope;
  normalise: HarNormalisation;
  /** Regex sources; a URL matching any of them is never recorded or served. */
  exclude: string[];
  /** Replaying a recording older than this warns. `null` disables the check. */
  maxAgeDays: number | null;
  /** Per-response body cap; bigger bodies are recorded without their content. */
  maxEntryBytes: number;
  /** Whole-archive body budget, so one run cannot write a gigabyte artifact. */
  maxTotalBytes: number;
}

export const REDACTED = '[REDACTED]';

/** Used when a test enables HAR without naming a file. */
export const DEFAULT_HAR_PATH = 'fixtures/network.har.json';

/**
 * Query params that change on every request and mean nothing to the response.
 * Dropping these by default is what makes a recording last longer than a day.
 */
export const DEFAULT_VOLATILE_QUERY_PARAMS: readonly string[] = [
  '_',
  'cb',
  'cachebuster',
  'cache_buster',
  'cachebust',
  'ts',
  'timestamp',
  'time',
  'rand',
  'random',
  'nonce',
  'requestid',
  'request_id',
  'traceid',
  'trace_id',
  'correlationid',
  'correlation_id',
  'sessionstart',
  '_ts',
  '_t',
  '__cf_bm',
];

/** Analytics and tracing prefixes, as regex sources. */
export const DEFAULT_VOLATILE_QUERY_PATTERNS: readonly string[] = ['^utm_', '^ga_', '^_ga'];

export function defaultNormalisation(): HarNormalisation {
  return {
    dropQueryParams: [...DEFAULT_VOLATILE_QUERY_PARAMS],
    dropQueryParamPatterns: [...DEFAULT_VOLATILE_QUERY_PATTERNS],
    ignoreQuery: false,
    ignoreHost: false,
  };
}

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_ENTRY_BYTES = 512_000;
const DEFAULT_MAX_TOTAL_BYTES = 24_000_000;

export interface HarConfigResult {
  /** null means "HAR is off for this test" — the default, and not a problem. */
  config: HarConfig | null;
  /**
   * Set when the test ASKED for record/replay and QAAI could not honour the
   * request. Never swallowed: the caller reports it, because a test that
   * believes it is hermetic and is not is the failure mode this whole module
   * exists to prevent.
   */
  problem: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown, fallback: string[]): string[] | null {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function positiveInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/** A regex source we can actually compile, or the reason we cannot. */
function badPattern(sources: readonly string[]): string | null {
  for (const source of sources) {
    try {
      new RegExp(source);
    } catch (err) {
      return `${JSON.stringify(source)} is not a valid regular expression (${
        err instanceof Error ? err.message : String(err)
      })`;
    }
  }
  return null;
}

/**
 * Reads HAR settings off a test's `spec` — the free-form, plugin-validated slot
 * every runner plugin already uses — with `QAAI_HAR_MODE` as a whole-run
 * override so a suite can be re-recorded without editing every test's spec.
 *
 * The env var can only turn a mode ON or switch it; it deliberately cannot
 * point at a different file, because a run-wide "write everything here" would
 * have every test in the suite overwriting one archive.
 */
export function parseHarConfig(
  spec: unknown,
  env: Record<string, string | undefined> = {},
): HarConfigResult {
  const specRecord = asRecord(spec);
  const raw = specRecord ? asRecord(specRecord.har) : null;
  const envMode = env.QAAI_HAR_MODE?.trim().toLowerCase();

  if (specRecord && specRecord.har !== undefined && !raw) {
    return { config: null, problem: 'the test spec\'s "har" key is not an object' };
  }

  const modeValue = envMode ?? (raw && typeof raw.mode === 'string' ? raw.mode.toLowerCase() : 'off');
  if (modeValue !== 'off' && modeValue !== 'record' && modeValue !== 'replay') {
    return {
      config: null,
      problem: `"${modeValue}" is not a HAR mode — use "record", "replay", or "off"`,
    };
  }
  if (modeValue === 'off') return { config: null, problem: null };

  const path = raw && typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : DEFAULT_HAR_PATH;
  if (path.startsWith('/') || path.includes('..')) {
    return {
      config: null,
      problem: `the recording path ${JSON.stringify(path)} must be relative to the workspace and may not contain ".."`,
    };
  }

  const onMissValue = raw && typeof raw.onMiss === 'string' ? raw.onMiss.toLowerCase() : 'abort';
  if (onMissValue !== 'abort' && onMissValue !== 'passthrough') {
    return {
      config: null,
      problem: `"${onMissValue}" is not a miss rule — use "abort" (hermetic) or "passthrough" (not hermetic)`,
    };
  }

  const scopeValue = raw && typeof raw.scope === 'string' ? raw.scope.toLowerCase() : 'all';
  if (scopeValue !== 'all' && scopeValue !== 'third-party') {
    return { config: null, problem: `"${scopeValue}" is not a scope — use "all" or "third-party"` };
  }

  const normaliseRaw = raw ? asRecord(raw.normalise) : null;
  if (raw && raw.normalise !== undefined && !normaliseRaw) {
    return { config: null, problem: 'har.normalise must be an object' };
  }
  const base = defaultNormalisation();
  const dropQueryParams = stringArray(normaliseRaw?.dropQueryParams, base.dropQueryParams);
  const dropQueryParamPatterns = stringArray(
    normaliseRaw?.dropQueryParamPatterns,
    base.dropQueryParamPatterns,
  );
  if (!dropQueryParams || !dropQueryParamPatterns) {
    return { config: null, problem: 'har.normalise drop lists must be arrays of strings' };
  }
  const patternProblem = badPattern(dropQueryParamPatterns);
  if (patternProblem) return { config: null, problem: `har.normalise: ${patternProblem}` };

  const exclude = stringArray(raw?.exclude, []);
  if (!exclude) return { config: null, problem: 'har.exclude must be an array of strings' };
  const excludeProblem = badPattern(exclude);
  if (excludeProblem) return { config: null, problem: `har.exclude: ${excludeProblem}` };

  const maxAgeDays =
    raw?.maxAgeDays === null
      ? null
      : positiveInt(raw?.maxAgeDays, DEFAULT_MAX_AGE_DAYS);
  if (maxAgeDays === null && raw?.maxAgeDays !== null && raw?.maxAgeDays !== undefined) {
    return { config: null, problem: 'har.maxAgeDays must be a positive number, or null to disable' };
  }
  const maxEntryBytes = positiveInt(raw?.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES);
  const maxTotalBytes = positiveInt(raw?.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  if (maxEntryBytes === null || maxTotalBytes === null) {
    return { config: null, problem: 'har byte limits must be positive numbers' };
  }

  return {
    config: {
      mode: modeValue,
      path,
      onMiss: onMissValue,
      scope: scopeValue,
      normalise: {
        dropQueryParams,
        dropQueryParamPatterns,
        ignoreQuery: normaliseRaw?.ignoreQuery === true,
        ignoreHost: normaliseRaw?.ignoreHost === true,
      },
      exclude,
      maxAgeDays,
      maxEntryBytes,
      maxTotalBytes,
    },
    problem: null,
  };
}

// ─── Matching ────────────────────────────────────────────────────────────────

/** The token a recorded URL uses in place of the environment's base URL. */
export const BASE_URL_TOKEN = '{{baseUrl}}';

function compilePatterns(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const source of sources) {
    try {
      out.push(new RegExp(source));
    } catch {
      // Validated by parseHarConfig; a bad one here is skipped rather than
      // thrown, because a regex must never be the thing that kills a run.
    }
  }
  return out;
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, '');
}

/**
 * Canonical form of a URL for matching purposes.
 *
 * Beyond the configured drops this always: removes the fragment (never sent),
 * removes credentials, lowercases the host, removes a default port, collapses
 * duplicate slashes, and sorts the surviving query parameters — none of which
 * a server can distinguish, and all of which change between two runs of the
 * same test.
 *
 * `baseUrl`, when given, is folded into {@link BASE_URL_TOKEN} so a recording
 * made against staging replays against a preview host. That is the same trick
 * record mode plays on generated specs, for the same reason.
 */
export function normaliseUrl(rawUrl: string, n: HarNormalisation, baseUrl?: string | null): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not absolute (a data: or relative URL slipped through) — matched verbatim.
    return rawUrl;
  }

  url.hash = '';
  url.username = '';
  url.password = '';
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  let search = '';
  if (!n.ignoreQuery) {
    const drop = new Set(n.dropQueryParams.map((p) => p.toLowerCase()));
    const patterns = compilePatterns(n.dropQueryParamPatterns);
    const credential = new Set(CREDENTIAL_QUERY_PARAMS);
    const kept: Array<[string, string]> = [];
    for (const [key, value] of url.searchParams) {
      if (drop.has(key.toLowerCase())) continue;
      if (patterns.some((re) => re.test(key))) continue;
      // A credential in a query string is neutralised HERE, in the matching
      // key, not only in the stored copy. Two reasons, and both are bugs this
      // caught: a key built from the raw URL puts the token in the run report,
      // and a recording keyed on a token can never match again once the token
      // rotates — which is the one thing a token is guaranteed to do. The name
      // is kept so `?token=x&id=1` and `?token=x&id=2` stay different requests.
      kept.push([key, credential.has(key.toLowerCase()) ? REDACTED : value]);
    }
    kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
    const params = new URLSearchParams();
    for (const [key, value] of kept) params.append(key, value);
    const encoded = params.toString();
    search = encoded ? `?${encoded}` : '';
  }

  const path = url.pathname.replace(/\/{2,}/g, '/');
  // `data:`, `blob:` and friends parse but have no authority, and inventing a
  // `//` for them turns `data:text/plain,x` into `data://text/plain,x`.
  const origin = n.ignoreHost
    ? ''
    : url.host
      ? `${url.protocol}//${url.host.toLowerCase()}`
      : url.protocol;
  const out = `${origin}${path}${search}`;

  if (!n.ignoreHost && baseUrl) {
    let base: URL | null = null;
    try {
      base = new URL(baseUrl);
    } catch {
      base = null;
    }
    if (base) {
      const basePrefix = trimTrailingSlash(
        `${base.protocol}//${base.host.toLowerCase()}${base.pathname.replace(/\/{2,}/g, '/')}`,
      );
      if (out === basePrefix) return `${BASE_URL_TOKEN}/`;
      if (out.startsWith(`${basePrefix}/`) || out.startsWith(`${basePrefix}?`)) {
        return BASE_URL_TOKEN + out.slice(basePrefix.length);
      }
    }
  }

  return out;
}

/** The key an entry is stored and looked up under. */
export function matchKey(
  method: string,
  url: string,
  n: HarNormalisation,
  baseUrl?: string | null,
): string {
  return `${method.toUpperCase()} ${normaliseUrl(url, n, baseUrl)}`;
}

/** True when `url` is served by somewhere other than the app under test. */
export function isThirdParty(url: string, baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(url).origin !== new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export function matchesAny(url: string, patterns: readonly string[]): boolean {
  return compilePatterns(patterns).some((re) => re.test(url));
}

// ─── Redaction ───────────────────────────────────────────────────────────────

/**
 * Headers whose value is a credential, near enough that no recording should
 * ever hold one.
 *
 * This list is deliberately duplicated from `@qaai/shared`'s masking chokepoint
 * rather than imported: this module is copied verbatim into the Playwright
 * process, where a cross-package import would not resolve. A recorder that
 * cannot start is a recorder that redacts nothing.
 */
export const CREDENTIAL_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
  'x-goog-api-key',
  'authentication',
];

/** Query parameter names that carry a credential in the URL itself. */
export const CREDENTIAL_QUERY_PARAMS: readonly string[] = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth',
  'apikey',
  'api_key',
  'key',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'sig',
  'signature',
  'session',
  'sessionid',
  'session_id',
  'code',
  'otp',
  'totp',
];

/** JWTs and bearer tokens survive header stripping by hiding in bodies. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Values shorter than this match too much ordinary text to be masked safely. */
const MIN_MASKABLE_LENGTH = 6;

/**
 * Replaces credential-shaped text and this environment's own secret values.
 * Applied to every body and every surviving header value BEFORE the entry is
 * held in memory, let alone written.
 */
export function redactText(text: string, secretValues: readonly string[] = []): string {
  let out = text.replace(JWT, REDACTED).replace(BEARER, (m) => `${m.split(/\s+/)[0]} ${REDACTED}`);
  const values = [...new Set(secretValues)]
    .filter((v) => typeof v === 'string' && v.length >= MIN_MASKABLE_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (values.length > 0) {
    out = out.replace(new RegExp(values.map(escapeRegExp).join('|'), 'g'), REDACTED);
  }
  return out;
}

/** Strips credential query params from a URL that is about to be stored. */
export function redactUrl(rawUrl: string, secretValues: readonly string[] = []): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return redactText(rawUrl, secretValues);
  }
  if (url.username) url.username = REDACTED;
  if (url.password) url.password = REDACTED;
  const deny = new Set(CREDENTIAL_QUERY_PARAMS);
  for (const key of [...url.searchParams.keys()]) {
    if (deny.has(key.toLowerCase())) url.searchParams.set(key, REDACTED);
  }
  return redactText(url.toString(), secretValues);
}

export interface HarHeader {
  name: string;
  value: string;
}

/**
 * Header list for the archive: credential headers are replaced (not dropped —
 * the reader should see that a recording had an Authorization header and that
 * QAAI took it out), and hop-by-hop / encoding headers are removed because the
 * body we store is already decoded and a stale `content-encoding` would make
 * replay serve garbage.
 */
const DROPPED_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

export function redactHeaders(
  headers: Record<string, string>,
  secretValues: readonly string[] = [],
): HarHeader[] {
  const deny = new Set(CREDENTIAL_HEADERS);
  const out: HarHeader[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (DROPPED_HEADERS.has(lower)) continue;
    out.push({ name, value: deny.has(lower) ? REDACTED : redactText(String(value), secretValues) });
  }
  return out;
}

/** The self-description stored in every archive, so the file explains itself. */
export function describeRedaction(secretNames: readonly string[]): Record<string, unknown> {
  return {
    when: 'at capture time, before anything was written to disk',
    headers: CREDENTIAL_HEADERS,
    queryParams: CREDENTIAL_QUERY_PARAMS,
    bodyPatterns: ['JWT', 'Bearer/Basic credentials', 'environment secret values'],
    environmentSecretsMasked: [...secretNames].sort(),
    note:
      'Credential headers, credential-shaped query parameters, bearer tokens and JWTs in bodies, ' +
      'and the values of this environment\'s secrets were replaced with "' +
      REDACTED +
      '" as each entry was captured. They were never written to disk in the clear. ' +
      'Recordings are still test data: review before sharing.',
  };
}

// ─── Archive shape (HAR 1.2 plus a `_qaai` extension) ────────────────────────

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: 'base64';
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: never[];
    headers: HarHeader[];
    queryString: HarHeader[];
    postData?: { mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: never[];
    headers: HarHeader[];
    content: HarContent;
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _qaai?: { key?: string; truncated?: boolean };
}

export interface HarArchive {
  log: {
    version: string;
    creator: { name: string; version: string };
    pages: never[];
    entries: HarEntry[];
    _qaai?: {
      recordedAt?: string;
      baseUrl?: string | null;
      normalise?: HarNormalisation;
      scope?: HarScope;
      redaction?: Record<string, unknown>;
      truncatedEntries?: number;
    };
  };
}

export const HAR_CREATOR = 'QAAI hermetic replay';

export function createArchive(meta: {
  recordedAt: string;
  baseUrl: string | null;
  normalise: HarNormalisation;
  scope: HarScope;
  secretNames: readonly string[];
}): HarArchive {
  return {
    log: {
      version: '1.2',
      creator: { name: HAR_CREATOR, version: '1' },
      pages: [],
      entries: [],
      _qaai: {
        recordedAt: meta.recordedAt,
        baseUrl: meta.baseUrl,
        normalise: meta.normalise,
        scope: meta.scope,
        redaction: describeRedaction(meta.secretNames),
        truncatedEntries: 0,
      },
    },
  };
}

/**
 * Reads an archive, and refuses one it cannot use.
 *
 * Deliberately tolerant of HARs QAAI did not write — a DevTools export or a
 * Playwright `recordHar` file replays fine, it just has no `_qaai` block, so
 * its age is inferred from its first entry.
 */
export function parseArchive(json: string): HarArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`it is not valid JSON (${err instanceof Error ? err.message : String(err)})`, {
      cause: err,
    });
  }
  const root = asRecord(parsed);
  const log = root ? asRecord(root.log) : null;
  if (!log || !Array.isArray(log.entries)) {
    throw new Error('it has no `log.entries` array — that is not a HAR file');
  }
  return parsed as HarArchive;
}

/** When the archive was captured, from our metadata or its oldest entry. */
export function archiveRecordedAt(archive: HarArchive): string | null {
  const meta = archive.log._qaai?.recordedAt;
  if (typeof meta === 'string' && !Number.isNaN(Date.parse(meta))) return meta;
  for (const entry of archive.log.entries) {
    if (typeof entry.startedDateTime === 'string' && !Number.isNaN(Date.parse(entry.startedDateTime))) {
      return entry.startedDateTime;
    }
  }
  return null;
}

/**
 * The staleness warning, or null when the recording is fresh enough.
 *
 * A warning, never a failure: an old recording is a reason to look, not a
 * verdict on the application under test.
 */
export function stalenessWarning(
  recordedAt: string | null,
  maxAgeDays: number | null,
  now: number = Date.now(),
): string | null {
  if (maxAgeDays === null) return null;
  if (!recordedAt) {
    return 'This recording does not say when it was captured, so its age cannot be checked — re-record it to get a timestamp.';
  }
  const at = Date.parse(recordedAt);
  if (Number.isNaN(at)) {
    return `This recording's timestamp (${recordedAt}) is unreadable, so its age cannot be checked.`;
  }
  const ageDays = Math.floor((now - at) / 86_400_000);
  if (ageDays < maxAgeDays) return null;
  return `This recording is ${ageDays} days old (captured ${recordedAt}); anything it replays is ${ageDays}-day-old behaviour. Re-record with har.mode = "record".`;
}

/**
 * Index an archive for lookup.
 *
 * A key can hold several entries — polling endpoints answer differently each
 * time — so they are kept in recorded order and served in that order, with the
 * last one repeating once the sequence is exhausted. That is the behaviour a
 * test that polls until ready needs, and repeating beats running out.
 */
export function indexArchive(
  archive: HarArchive,
  n: HarNormalisation,
  baseUrl: string | null,
): Map<string, HarEntry[]> {
  const index = new Map<string, HarEntry[]>();
  for (const entry of archive.log.entries) {
    const method = entry.request?.method ?? 'GET';
    const url = entry.request?.url ?? '';
    // A URL already folded to the token is re-keyed as-is; expanding it against
    // this run's base URL and normalising again would be a no-op at best.
    const key = url.startsWith(BASE_URL_TOKEN)
      ? `${method.toUpperCase()} ${url}`
      : matchKey(method, url, n, baseUrl);
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}

/** Decodes a stored response body back into bytes for `route.fulfill`. */
export function entryBody(entry: HarEntry): Buffer {
  const content = entry.response?.content;
  if (!content || typeof content.text !== 'string') return Buffer.alloc(0);
  return content.encoding === 'base64'
    ? Buffer.from(content.text, 'base64')
    : Buffer.from(content.text, 'utf8');
}

/** Header list back to the map `route.fulfill` wants, minus what must not be replayed. */
export function entryHeaders(entry: HarEntry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of entry.response?.headers ?? []) {
    const lower = header.name.toLowerCase();
    // Never replay a Set-Cookie (it is [REDACTED] anyway) and never replay an
    // encoding or length that describes bytes we no longer have.
    if (lower === 'set-cookie' || DROPPED_HEADERS.has(lower)) continue;
    out[header.name] = header.value;
  }
  return out;
}

// ─── The run report — how a run proves it was hermetic ───────────────────────

export interface HarMiss {
  method: string;
  url: string;
  key: string;
  /** What the handler did about it. */
  action: 'aborted' | 'passed-through';
}

export interface HarNetworkEntry {
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  bodySnippet: string | null;
}

/** Written by the Playwright process, read by the plugin. The only IPC here. */
export interface HarRunReport {
  mode: HarMode;
  /** Requests served from the recording. */
  served: number;
  /** Requests captured (record mode). */
  recorded: number;
  /** Requests dropped by `exclude`; hermetic, but the app did not get a response. */
  excluded: number;
  misses: HarMiss[];
  /** Truthful even when the handler never ran; see `summariseHarRun`. */
  installError: string | null;
  /** Where the recording was written, in record mode. */
  wrote: string | null;
  bytes: number;
  truncatedEntries: number;
  entries: HarNetworkEntry[];
}

export function emptyReport(mode: HarMode): HarRunReport {
  return {
    mode,
    served: 0,
    recorded: 0,
    excluded: 0,
    misses: [],
    installError: null,
    wrote: null,
    bytes: 0,
    truncatedEntries: 0,
    entries: [],
  };
}

export interface HarSummary {
  /** False whenever anything could have reached the live network. */
  hermetic: boolean;
  /** Prepended to the execution's message. Never null when HAR was enabled. */
  notice: string;
}

const MAX_LISTED_MISSES = 8;

/**
 * Transports `context.route()` cannot see, matched against the spec's source.
 *
 * Playwright's routing intercepts what the BROWSER sends. `APIRequestContext` —
 * reached as `page.request`, `context.request`, or the `request` fixture — is a
 * separate HTTP client living in the Node process, and it goes straight to the
 * network no matter what handler is installed on the context.
 *
 * Observed, not inferred: a replay run whose spec called
 * `page.request.get('/api/never-recorded')` came back with a real 404 from the
 * live server, while the report still said `served: 1, misses: 2` and the run
 * was summarised HERMETIC. That is the exact silent passthrough the top of this
 * file promises never to produce, so it has to be detected and said out loud.
 *
 * Detection is source-level and deliberately generous — it costs a caveat on a
 * spec that merely mentions the fixture, and the alternative costs the guarantee.
 */
const UNROUTABLE_TRANSPORTS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\bpage\s*\.\s*request\b/, what: 'page.request' },
  { pattern: /\bcontext\s*\.\s*request\b/, what: 'context.request' },
  // The `request` fixture, destructured out of a test's arguments.
  { pattern: /\(\s*\{[^}]*\brequest\b[^}]*\}\s*\)/, what: 'the `request` fixture' },
  // A bare `request.get(...)` off the destructured fixture. The lookbehind keeps
  // `page.request.get(...)` from being reported twice under two names.
  {
    pattern: /(?<![.\w])request\s*\.\s*(get|post|put|patch|delete|head|fetch)\s*\(/,
    what: 'request.<method>()',
  },
];

/**
 * Which uninterceptable transports this spec uses, in the order listed above.
 *
 * Empty means the spec's traffic all goes through the browser, which is what
 * the route handler can actually see.
 */
export function unroutableTransports(source: string): string[] {
  const found: string[] = [];
  for (const { pattern, what } of UNROUTABLE_TRANSPORTS) {
    if (pattern.test(source) && !found.includes(what)) found.push(what);
  }
  return found;
}

/**
 * Turns a run report into the sentence that goes in the result.
 *
 * This is the visibility guarantee, and it is written to fail OPEN: a MISSING
 * report is not treated as "nothing happened", it is treated as "we cannot
 * prove this run was hermetic", because a recorder that never started and a
 * recorder with nothing to do look identical from the outside, and only one of
 * them is safe to call hermetic.
 */
export function summariseHarRun(
  report: HarRunReport | null,
  config: HarConfig,
  extras: {
    staleness?: string | null;
    artifactKey?: string | null;
    /** From `unroutableTransports(spec)`. Non-empty forfeits hermeticity. */
    unroutable?: readonly string[];
  } = {},
): HarSummary {
  const staleness = extras.staleness ? `\n${extras.staleness}` : '';
  const unroutable = extras.unroutable ?? [];
  /*
   * Leads the notice, and is checked before the report is even consulted: these
   * requests never reach the route handler, so no amount of `served` proves they
   * did not leave the machine. A caveat placed after "HERMETIC" would be read as
   * a footnote to a guarantee that no longer holds.
   */
  const unroutableNotice =
    unroutable.length === 0
      ? ''
      : config.mode === 'record'
        ? `INCOMPLETE RECORDING: this test sends requests through ${unroutable.join(', ')}. ` +
          'Playwright records what the browser sends; APIRequestContext is a separate HTTP client ' +
          'in the Node process, so those requests were never intercepted and are NOT in the ' +
          'recording — a replay off it will let them reach the live network. Move them into the ' +
          'page (fetch/XHR from the application) to bring them under hermetic replay.'
        : `NOT HERMETIC: this test sends requests through ${unroutable.join(', ')}. ` +
          'Playwright routes what the browser sends; APIRequestContext is a separate HTTP client ' +
          'in the Node process, so those requests reached the live network and are absent from ' +
          'both the recording and the miss list below. Move them into the page (fetch/XHR from ' +
          'the application) to bring them under hermetic replay.';
  const withUnroutable = (summary: HarSummary): HarSummary =>
    unroutable.length === 0
      ? summary
      : { hermetic: false, notice: `${unroutableNotice}\n\n${summary.notice}` };

  if (!report) {
    return withUnroutable({
      hermetic: false,
      notice:
        `NOT HERMETIC: QAAI asked for HAR ${config.mode} but the Playwright process wrote no ` +
        'network report, so there is no evidence any request was intercepted. Treat this run as ' +
        'having used the live network.' +
        staleness,
    });
  }

  if (report.installError) {
    return withUnroutable({
      hermetic: false,
      notice:
        `NOT HERMETIC: HAR ${config.mode} did not complete (${report.installError}), so this run ` +
        'cannot be treated as isolated from the live network. The test result below is real — it ' +
        'was simply not hermetic.' +
        staleness,
    });
  }

  const passedThrough = report.misses.filter((m) => m.action === 'passed-through');
  const aborted = report.misses.filter((m) => m.action === 'aborted');
  const list = (misses: HarMiss[]): string =>
    misses
      .slice(0, MAX_LISTED_MISSES)
      .map((m) => `  ${m.method} ${m.url}`)
      .join('\n') + (misses.length > MAX_LISTED_MISSES ? `\n  …and ${misses.length - MAX_LISTED_MISSES} more` : '');

  if (config.mode === 'record') {
    const truncated = report.truncatedEntries
      ? ` ${report.truncatedEntries} response(s) exceeded the ${config.maxEntryBytes}-byte body cap and were recorded without their content.`
      : '';
    const stored = extras.artifactKey
      ? ` Stored as artifact ${extras.artifactKey}; commit it as ${config.path} to replay it.`
      : report.recorded === 0
        ? ' Nothing was intercepted, so there is no recording to replay — check that the test actually makes requests, and that har.scope and har.exclude are not filtering them all out.'
        : ' QAAI could not store it as an artifact, so there is nothing to replay yet.';
    // A request the recorder could not complete is a hole in the recording, and
    // the time to say so is now — not on the replay run, as a mysterious miss.
    const holes =
      report.misses.length > 0
        ? `\n\n${report.misses.length} request(s) could not be captured and are missing from the ` +
          `recording; replaying it will block them:\n${list(report.misses)}`
        : '';
    return withUnroutable({
      hermetic: false,
      notice:
        `HAR RECORD: captured ${report.recorded} request(s) (${report.bytes} bytes) from the LIVE ` +
        `network — a recording run is never hermetic by definition.${stored}${truncated} ` +
        'Credentials were stripped as each entry was captured: Authorization/Cookie-class headers, ' +
        'credential query parameters, bearer tokens and JWTs in bodies, and this environment\'s ' +
        'secret values were replaced with ' +
        REDACTED +
        ' before anything was written.' +
        holes,
    });
  }

  const parts: string[] = [];
  if (passedThrough.length > 0) {
    parts.push(
      `NOT HERMETIC: ${passedThrough.length} request(s) had no recording and were let through to ` +
        `the live network (har.onMiss = "passthrough"):\n${list(passedThrough)}\n` +
        'Re-record with har.mode = "record", or set har.onMiss = "abort" to keep the run hermetic.',
    );
  }
  if (aborted.length > 0) {
    parts.push(
      `${aborted.length} request(s) had no recording and were BLOCKED (nothing reached the ` +
        `network):\n${list(aborted)}\n` +
        'A blocked request usually fails the test. That is a stale or incomplete recording, not ' +
        'necessarily a bug in the application — re-record with har.mode = "record", or widen ' +
        'har.normalise.dropQueryParams if the URL only differs by a volatile parameter.',
    );
  }
  // The word HERMETIC is only ever printed when it is true of the WHOLE run. An
  // uninterceptable transport makes it false regardless of what the report says,
  // so that branch reports what was served and leaves the verdict to the caveat.
  if (parts.length === 0 && unroutable.length === 0) {
    parts.push(
      `HERMETIC: all ${report.served} request(s) were served from ${config.path}; nothing reached ` +
        'the network.',
    );
  } else {
    // The verdict leads. Where the recording came from is context, and context
    // goes after the sentence a reader must not scroll past.
    parts.push(`HAR REPLAY from ${config.path}: ${report.served} request(s) served.`);
  }
  if (report.excluded > 0) {
    parts.push(`${report.excluded} request(s) matched har.exclude and were blocked without a response.`);
  }

  return withUnroutable({
    hermetic: passedThrough.length === 0,
    notice: parts.join('\n\n') + staleness,
  });
}

// ─── Runtime: the route handler that runs inside the Playwright process ──────

/**
 * Playwright's objects, described structurally.
 *
 * Importing `@playwright/test` here would be a runtime dependency in a file
 * that also runs inside the worker; describing the three methods we use keeps
 * this module dependency-free AND makes the handler unit-testable with plain
 * fakes, which is how the record and replay paths below are actually tested.
 */
export interface HarRouteRequest {
  method(): string;
  url(): string;
  headers(): Record<string, string>;
  postData(): string | null;
}

export interface HarApiResponse {
  status(): number;
  statusText(): string;
  headers(): Record<string, string>;
  body(): Promise<Buffer | Uint8Array>;
}

export interface HarRoute {
  request(): HarRouteRequest;
  fetch(options?: { maxRedirects?: number }): Promise<HarApiResponse>;
  fulfill(options: {
    status?: number;
    headers?: Record<string, string>;
    body?: Buffer | string;
    contentType?: string;
  }): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  fallback?(): Promise<void>;
  continue(): Promise<void>;
}

export interface HarBrowserContext {
  route(
    url: string,
    handler: (route: HarRoute) => Promise<void> | void,
  ): Promise<void>;
}

export interface HarTestType {
  beforeEach(fn: (args: { context: HarBrowserContext }) => Promise<void> | void): void;
  afterEach(fn: (args: unknown) => Promise<void> | void): void;
}

export interface HarRuntimeOptions {
  config: HarConfig;
  baseUrl: string | null;
  /** Names only. The values are read from this process's env, never written. */
  secretNames: string[];
  /**
   * Absolute directory for this run's report and recording. A DIRECTORY, not a
   * file, and that distinction cost a working feature once already.
   *
   * Playwright loads a spec file at least twice — once in the main process to
   * collect the tests, once in each worker that runs them — so `installHar`
   * runs more than once per run. With one fixed filename the collection
   * process, which executes no test and therefore records nothing, wrote its
   * empty report over the worker's real one on the way out, and the run
   * reported zero requests intercepted while the recording it actually made was
   * deleted with the temp directory. Every process writes its own file here and
   * the plugin merges them, so no process can lose another's evidence.
   */
  reportDir: string;
}

const REPORT_PREFIX = 'run-report';
const RECORDING_PREFIX = 'recording';

/** Distinguishes two loads of the module inside a single worker process. */
let installSequence = 0;

const MAX_REPORTED_ENTRIES = 500;
const BODY_SNIPPET_BYTES = 2000;

/**
 * Flush-on-exit, registered once.
 *
 * A worker that is SIGKILLed on timeout never reaches `afterEach`, and losing
 * the recording is annoying while losing the run report is worse — it is the
 * only evidence the run was hermetic. Writing it from `exit` works because
 * `writeFileSync` is synchronous, which is the only kind of work an exit
 * handler gets to do. One handler for many installs, the same shape record.ts
 * uses for its child processes, so a process with several spec files loaded
 * does not accumulate listeners.
 */
const pendingFlushes = new Set<() => void>();
let exitHandlerRegistered = false;

function registerFlush(flush: () => void): void {
  pendingFlushes.add(flush);
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on('exit', () => {
    for (const pending of pendingFlushes) {
      try {
        pending();
      } catch {
        /* an exit handler has nowhere to report to */
      }
    }
  });
}

function isTextual(mimeType: string): boolean {
  return /^(text\/|application\/(json|javascript|xml|xhtml|x-www-form-urlencoded|graphql)|image\/svg)/i.test(
    mimeType,
  );
}

function queryStringOf(url: string): HarHeader[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/**
 * Installs record or replay on every browser context the test opens.
 *
 * Nothing in here is allowed to throw out: a bug in QAAI's interception must
 * not become a failing test for the customer's application. Every failure path
 * lands in the report as `installError` or a miss, and the plugin turns that
 * into a visible NOT HERMETIC notice rather than a verdict.
 */
export function installHar(test: HarTestType, options: HarRuntimeOptions): void {
  const report = emptyReport(options.config.mode);
  const { config, baseUrl } = options;

  installSequence += 1;
  const stamp = `${process.pid}-${installSequence}`;
  const reportPath = join(options.reportDir, `${REPORT_PREFIX}.${stamp}.json`);
  const recordingPath = join(options.reportDir, `${RECORDING_PREFIX}.${stamp}.har.json`);

  const write = (): void => {
    try {
      writeFileSync(reportPath, JSON.stringify(report), 'utf8');
    } catch {
      // The sidecar is how this run proves it was hermetic. If it cannot be
      // written the plugin sees no report and says so — which is the correct,
      // fail-open answer, so there is nothing to do here but not crash.
    }
  };

  try {
    const secretValues = options.secretNames
      .map((name) => process.env[name])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);

    let index = new Map<string, HarEntry[]>();
    const cursor = new Map<string, number>();
    let archive: HarArchive | null = null;
    let totalBytes = 0;

    if (config.mode === 'replay') {
      const raw = readFileSync(config.path, 'utf8');
      index = indexArchive(parseArchive(raw), config.normalise, baseUrl);
    } else {
      archive = createArchive({
        recordedAt: new Date().toISOString(),
        baseUrl,
        normalise: config.normalise,
        scope: config.scope,
        secretNames: options.secretNames,
      });
    }

    const flush = (): void => {
      if (archive) {
        try {
          archive.log._qaai!.truncatedEntries = report.truncatedEntries;
          writeFileSync(recordingPath, JSON.stringify(archive, null, 2), 'utf8');
          report.wrote = recordingPath;
        } catch (err) {
          report.installError = `the recording could not be written: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
      write();
    };

    const noteEntry = (entry: HarNetworkEntry): void => {
      if (report.entries.length < MAX_REPORTED_ENTRIES) report.entries.push(entry);
    };

    const handler = async (route: HarRoute): Promise<void> => {
      const request = route.request();
      const method = request.method();
      const url = request.url();

      // Out of scope, or explicitly excluded. Both are blocked rather than let
      // through: "hermetic" has to mean it, and an excluded analytics beacon
      // that still reaches Google is not excluded.
      if (matchesAny(url, config.exclude)) {
        report.excluded += 1;
        await route.abort('blockedbyclient');
        return;
      }
      if (config.scope === 'third-party' && !isThirdParty(url, baseUrl)) {
        await route.continue();
        return;
      }

      const key = matchKey(method, url, config.normalise, baseUrl);

      if (config.mode === 'replay') {
        const bucket = index.get(key);
        if (!bucket || bucket.length === 0) {
          // The key is built from the RAW url because that is what has to
          // match; the reported key is rebuilt from the redacted one, or a
          // token in a query string would ride out in the run report.
          const safeUrl = redactUrl(url, secretValues);
          const miss: HarMiss = {
            method,
            url: safeUrl,
            key: matchKey(method, safeUrl, config.normalise, baseUrl),
            action: config.onMiss === 'passthrough' ? 'passed-through' : 'aborted',
          };
          report.misses.push(miss);
          noteEntry({
            method,
            url: miss.url,
            status: null,
            durationMs: 0,
            bodySnippet:
              miss.action === 'aborted'
                ? 'no recording for this request — blocked'
                : 'no recording for this request — sent to the live network',
          });
          write();
          if (config.onMiss === 'passthrough') await route.continue();
          else await route.abort('failed');
          return;
        }

        const at = cursor.get(key) ?? 0;
        // Repeat the last recorded response once the sequence is exhausted: a
        // test that polls four times off a recording of three is better served
        // a stale answer than a blocked request.
        const entry = bucket[Math.min(at, bucket.length - 1)]!;
        cursor.set(key, at + 1);
        report.served += 1;
        noteEntry({
          method,
          url: redactUrl(url, secretValues),
          status: entry.response?.status ?? 200,
          durationMs: 0,
          bodySnippet: null,
        });
        await route.fulfill({
          status: entry.response?.status ?? 200,
          headers: entryHeaders(entry),
          body: entryBody(entry),
        });
        return;
      }

      // ── record ──
      const startedAt = Date.now();
      let response: HarApiResponse;
      try {
        // maxRedirects 0 keeps each hop as its own entry, so replay reproduces
        // the redirect the browser actually followed instead of collapsing it.
        response = await route.fetch({ maxRedirects: 0 });
      } catch {
        try {
          response = await route.fetch();
        } catch (err) {
          // The real request failed. That is the application's business, not
          // ours: hand it back to Playwright and record nothing.
          const safeUrl = redactUrl(url, secretValues);
          report.misses.push({
            method,
            url: safeUrl,
            key: matchKey(method, safeUrl, config.normalise, baseUrl),
            action: 'passed-through',
          });
          write();
          await route.abort('failed').catch(() => undefined);
          void err;
          return;
        }
      }

      const durationMs = Date.now() - startedAt;
      const raw = Buffer.from(await response.body());
      const headers = response.headers();
      const mimeType = headers['content-type'] ?? 'application/octet-stream';
      const overEntryCap = raw.byteLength > config.maxEntryBytes;
      const overTotalCap = totalBytes + raw.byteLength > config.maxTotalBytes;
      const keepBody = !overEntryCap && !overTotalCap;
      if (!keepBody) report.truncatedEntries += 1;
      else totalBytes += raw.byteLength;

      const textual = isTextual(mimeType);
      const content: HarContent = keepBody
        ? textual
          ? { size: raw.byteLength, mimeType, text: redactText(raw.toString('utf8'), secretValues) }
          : { size: raw.byteLength, mimeType, text: raw.toString('base64'), encoding: 'base64' }
        : { size: raw.byteLength, mimeType };

      const postData = request.postData();
      // Everything stored is derived from the redacted URL, including the key —
      // a raw key in `_qaai` would put the credential straight back into the
      // artifact that redaction just took it out of.
      const safeUrl = redactUrl(url, secretValues);
      const storedUrl = normaliseUrl(safeUrl, config.normalise, baseUrl);
      const entry: HarEntry = {
        startedDateTime: new Date(startedAt).toISOString(),
        time: durationMs,
        request: {
          method,
          url: storedUrl,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: redactHeaders(request.headers(), secretValues),
          queryString: queryStringOf(safeUrl),
          ...(postData ? { postData: { mimeType, text: redactText(postData, secretValues) } } : {}),
          headersSize: -1,
          bodySize: postData ? Buffer.byteLength(postData) : 0,
        },
        response: {
          status: response.status(),
          statusText: response.statusText(),
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: redactHeaders(headers, secretValues),
          content,
          redirectURL: headers.location ? redactUrl(headers.location, secretValues) : '',
          headersSize: -1,
          bodySize: raw.byteLength,
        },
        cache: {},
        timings: { send: -1, wait: durationMs, receive: -1 },
        _qaai: {
          key: `${method.toUpperCase()} ${storedUrl}`,
          ...(keepBody ? {} : { truncated: true }),
        },
      };
      archive!.log.entries.push(entry);
      report.recorded += 1;
      report.bytes = totalBytes;
      noteEntry({
        method,
        url: redactUrl(url, secretValues),
        status: entry.response.status,
        durationMs,
        bodySnippet:
          entry.response.status >= 400 && typeof content.text === 'string' && textual
            ? content.text.slice(0, BODY_SNIPPET_BYTES)
            : null,
      });

      await route.fulfill({
        status: entry.response.status,
        headers: entryHeaders(entry),
        body: raw,
      });
    };

    test.beforeEach(async ({ context }) => {
      await context.route('**/*', (route) => {
        // A throw inside a route handler hangs the request until it times out,
        // which would look like the application being slow. Anything unexpected
        // falls back to letting the request continue, and is recorded as a
        // passthrough so the run is reported as not hermetic.
        return Promise.resolve(handler(route)).catch(async (err: unknown) => {
          report.misses.push({
            method: 'UNKNOWN',
            url: `handler error: ${err instanceof Error ? err.message : String(err)}`,
            key: '',
            action: 'passed-through',
          });
          write();
          await route.continue().catch(() => undefined);
        });
      });
    });

    test.afterEach(() => {
      flush();
    });
    registerFlush(flush);

    write();
  } catch (err) {
    report.installError = err instanceof Error ? err.message : String(err);
    write();
  }
}

/**
 * Fold every process's report into one.
 *
 * Counters add, misses and entries concatenate, and install errors are kept —
 * all of them, joined, because the process that failed to install is not
 * necessarily the process that wrote the last file. Returns null only when
 * there was nothing to read at all, which `summariseHarRun` reads as "we cannot
 * prove this run was hermetic".
 */
export function mergeRunReports(reports: readonly HarRunReport[]): HarRunReport | null {
  if (reports.length === 0) return null;
  const merged = emptyReport(reports[0]!.mode);
  const errors: string[] = [];
  for (const report of reports) {
    merged.served += report.served ?? 0;
    merged.recorded += report.recorded ?? 0;
    merged.excluded += report.excluded ?? 0;
    merged.bytes += report.bytes ?? 0;
    merged.truncatedEntries += report.truncatedEntries ?? 0;
    merged.misses.push(...(report.misses ?? []));
    for (const entry of report.entries ?? []) {
      if (merged.entries.length < MAX_REPORTED_ENTRIES) merged.entries.push(entry);
    }
    if (report.installError && !errors.includes(report.installError)) errors.push(report.installError);
    if (report.wrote) merged.wrote = report.wrote;
  }
  merged.installError = errors.length > 0 ? errors.join('; ') : null;
  return merged;
}

/**
 * Fold every process's recording into one archive.
 *
 * A union of entries: the collection process contributes an empty archive and
 * therefore nothing, and a matrix run where two browsers recorded the same
 * endpoint contributes both responses, which replay serves in order. Losing a
 * worker's entries because another worker also wrote a file is the failure mode
 * that matters here, so nothing is discarded.
 */
export function mergeArchives(archives: readonly HarArchive[]): HarArchive | null {
  const withEntries = archives.filter((a) => a.log.entries.length > 0);
  if (withEntries.length === 0) return archives[0] ?? null;
  const base = withEntries[0]!;
  const merged: HarArchive = {
    log: { ...base.log, entries: [...base.log.entries] },
  };
  for (const archive of withEntries.slice(1)) merged.log.entries.push(...archive.log.entries);
  if (merged.log._qaai) {
    merged.log._qaai = {
      ...merged.log._qaai,
      truncatedEntries: withEntries.reduce((n, a) => n + (a.log._qaai?.truncatedEntries ?? 0), 0),
    };
  }
  return merged;
}

/**
 * Reads everything {@link installHar} wrote for one run.
 *
 * Anything unreadable is skipped rather than thrown: a half-written file from a
 * killed process must not cost us the reports that ARE readable, because losing
 * them means losing the run's only evidence about its own hermeticity.
 */
export function readHarRunDir(dir: string): {
  report: HarRunReport | null;
  archive: HarArchive | null;
} {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { report: null, archive: null };
  }

  const reports: HarRunReport[] = [];
  const archives: HarArchive[] = [];
  for (const name of names.sort()) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    if (name.startsWith(`${REPORT_PREFIX}.`)) {
      try {
        const record = asRecord(JSON.parse(raw));
        if (record && Array.isArray(record.misses)) reports.push(record as unknown as HarRunReport);
      } catch {
        continue;
      }
    } else if (name.startsWith(`${RECORDING_PREFIX}.`)) {
      try {
        archives.push(parseArchive(raw));
      } catch {
        continue;
      }
    }
  }

  return { report: mergeRunReports(reports), archive: mergeArchives(archives) };
}
