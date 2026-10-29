/**
 * Promote a captured recording into a COMMITTED FIXTURE.
 *
 * ─── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * The record-to-replay loop is broken at its last step. A capture produces a
 * HAR or a response set, the runner tells the user IN PROSE to commit the
 * artifact by hand, and there is no promote path at all — so the one thing that
 * makes a recording worth keeping (a committed fixture the suite can replay
 * deterministically, in CI, with no live dependency) is a manual copy somebody
 * does once and never again.
 *
 * ─── AND THE REASON IT IS NOT A COPY ─────────────────────────────────────────
 *
 * A CAPTURED RECORDING IS REAL TRAFFIC. It holds the session cookie of whoever
 * recorded it, their bearer token, every API key the application sends in a
 * header, and whatever personal data the bodies carried. Promoting that into a
 * committed fixture writes all of it into the customer's REPOSITORY, where it is
 * cloned onto every laptop, mirrored by every CI runner and, for a repository
 * that is ever made public, published. A leak in a fixture is not a leak that
 * can be revoked by deleting a row: it is in the history.
 *
 * So this module is arranged around one rule and its consequence.
 *
 *   THE RULE: SCRUB BY DEFAULT, AND AN ALLOWLIST OF APPROVED CONTENT RATHER
 *   THAN A BLOCKLIST OF BAD CONTENT. Nothing survives into a fixture unless the
 *   customer named it. Every header is dropped unless its name is on
 *   {@link SAFE_HEADER_NAMES} or in the customer's approval; every query
 *   parameter is dropped unless its name is approved; every body is dropped
 *   whole unless the exchange AND the exact field paths are approved. A
 *   blocklist would be the wrong shape for the same reason
 *   `ALWAYS_REDACT_KEYS` in packages/shared/src/mask.ts records: a list of bad
 *   names reads as though it covers a family and covers precisely the spellings
 *   written in it, so `token` redacts and `bypassToken` does not.
 *
 *   THE CONSEQUENCE: WHAT CANNOT BE SCRUBBED IS REFUSED, NOT WARNED ABOUT. A
 *   fixture that still holds a credential-shaped value after scrubbing is not
 *   promoted. There is no "promote anyway", because a warning on a screen is
 *   not a thing a repository's history respects.
 *
 * ─── AND NOTHING IS SILENT ───────────────────────────────────────────────────
 *
 * Every removal is COUNTED BY KIND and reported, with a total beside any capped
 * list so a capped list cannot read as the whole list — {@link PromotionReport}.
 * A recording that was scrubbed down to nothing says so rather than producing an
 * empty fixture that passes. Every cap that BIT is reported as a count and a
 * reason; a cap that did not bite reports nothing, because a disclosure nobody
 * needs is how real disclosures stop being read.
 *
 * ─── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
 *
 * It never writes a file and never commits. It produces an {@link ArtifactSet},
 * and the ownership vocabulary in packages/shared/src/artifact-set.ts decides
 * what may happen to it: a path QAAI has never written is UNRECORDED, which
 * earns a PROPOSED_EDIT and not a write. That is the fail-closed direction and
 * the opposite of what `pushRepo` does.
 *
 * It also makes no network call, spawns no process and reads no file. The
 * recording arrives as data — see {@link CapturedExchange} — because 629 lines
 * of crawler.ts went almost untested for exactly the opposite reason. There is
 * no model in this path either: redaction by shape and by allowlist is
 * deterministic, which is what makes it testable and what makes it work with no
 * model key at all.
 */

import {
  MAX_ARTIFACT_CHARS,
  destinationDecision,
  dispositionFor,
  resolveOwnership,
} from '@qaai/shared';
import type { ArtifactLedgerEntry, ArtifactSet, GeneratedArtifact } from '@qaai/shared';

// ─── What a capture hands us ─────────────────────────────────────────────────

/** One header, as captured. Names are compared lower-cased; the case is kept for nothing. */
export interface CapturedHeader {
  readonly name: string;
  readonly value: string;
}

/**
 * One request/response pair out of a recording.
 *
 * Deliberately NOT the HAR shape. A HAR carries timings, cache entries, page
 * references, a `_initiator` and whatever the capturing tool decided to add,
 * and a promoter that took the whole document would have to decide, field by
 * field, which of those are safe — on a schema it does not control. This is the
 * narrow projection a fixture actually needs, so the HAR reader's job is to fill
 * in these seven fields and nothing it forgot can leak through.
 */
export interface CapturedExchange {
  readonly method: string;
  /** Absolute, as recorded. Made relative to the environment's base URL here. */
  readonly url: string;
  readonly status: number;
  readonly requestHeaders: readonly CapturedHeader[];
  readonly responseHeaders: readonly CapturedHeader[];
  /** Raw text. Parsed as JSON only when the customer approved fields in it. */
  readonly requestBody: string | null;
  readonly responseBody: string | null;
}

// ─── Caps ────────────────────────────────────────────────────────────────────

/**
 * How many exchanges one promotion may carry.
 *
 * A browsing session records thousands; a fixture a human will review is tens.
 * REPORTED when it bites — a fixture that silently covered the first 200 of 900
 * exchanges would replay most of a flow and fail the rest, which reads as a
 * broken application rather than a truncated recording.
 */
export const MAX_PROMOTED_EXCHANGES = 200;

/** Per-body ceiling. A response longer than this is a document, not test data. */
export const MAX_BODY_CHARS = 20_000;

/** Headers read per exchange. A recording with more is a recording with a generated header set. */
export const MAX_HEADERS_PER_EXCHANGE = 60;

/** The fixture itself, bounded by what an artifact may hold. */
export const MAX_FIXTURE_CHARS = MAX_ARTIFACT_CHARS;

// ─── Credential shapes ───────────────────────────────────────────────────────

/**
 * The shapes a credential takes, as a closed vocabulary.
 *
 * Shape detection is the SECOND line and not the first: the allowlist is what
 * keeps credentials out, and this is what catches one that arrives somewhere the
 * allowlist cannot reach — a token in a URL path segment, a bearer value in a
 * field the customer approved for a different reason. It is deliberately
 * over-eager. A false positive costs a customer one un-approved field; a false
 * negative is a token in a git history.
 */
export const CREDENTIAL_SHAPES = [
  /** `eyJ….eyJ….sig`. A session, almost always. */
  'JWT',
  /** `-----BEGIN …`. A private key or a certificate. */
  'PEM_BLOCK',
  /** `Bearer …`, `Basic …`, `Token …` — an auth scheme with a value after it. */
  'AUTH_SCHEME',
  /** A provider's own prefix: `ghp_`, `sk-`, `xoxb-`, `AKIA`, `AIza`, `glpat-`. */
  'PROVIDER_TOKEN',
  /** A long opaque mixed-case run. What a session id and an API key look like when nothing labels them. */
  'OPAQUE_SECRET',
] as const;
export type CredentialShape = (typeof CREDENTIAL_SHAPES)[number];

/**
 * What each shape is, in a sentence a refusal can print.
 *
 * A `satisfies Record<CredentialShape, …>`, so a sixth shape cannot be added
 * without a sentence for the human who has to act on it. NOT ONE OF THESE
 * SENTENCES QUOTES THE VALUE, and that is the rule rather than a style choice:
 * the thing being described is a credential, and a refusal that echoed it would
 * put it in a log, an audit row and an HTTP response at once.
 */
export const CREDENTIAL_SHAPE_WHY = {
  JWT: 'a JSON Web Token — three base64url segments separated by dots, which is what a signed session looks like',
  PEM_BLOCK: 'a PEM block — a private key or a certificate',
  AUTH_SCHEME: 'an HTTP authentication scheme followed by a value',
  PROVIDER_TOKEN: "a token carrying a known provider's prefix",
  OPAQUE_SECRET:
    'a long opaque mixed-case string, which is what an API key or a session id looks like when nothing labels it',
} as const satisfies Record<CredentialShape, string>;

/** Below this length an opaque run is too likely to be ordinary data. Mirrors mask.ts's floor logic. */
const MIN_OPAQUE_LENGTH = 32;

const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const AUTH_SCHEME = /^(?:bearer|basic|token|digest|negotiate)\s+\S/i;
const PROVIDER_TOKEN =
  /(?:gh[pousr]_|github_pat_|sk-|sk_live_|sk_test_|rk_live_|xox[baprs]-|xapp-|AKIA|ASIA|AIza|glpat-|npm_|SG\.|shpat_|dop_v1_)[A-Za-z0-9_-]{8,}/;
const OPAQUE = /^[A-Za-z0-9+/_=-]+$/;

/**
 * The shape this value has, or null.
 *
 * Returns the SHAPE and never the value, for the reason
 * {@link CREDENTIAL_SHAPE_WHY} gives. Callers that need to say where it was
 * found use a path from QAAI's own records — the allowlist entry the customer
 * typed — never a key read out of the capture, which is attacker-influenced
 * text and would compose a refusal message out of whatever it said.
 */
export function credentialShapeOf(value: string): CredentialShape | null {
  if (value.includes('-----BEGIN')) return 'PEM_BLOCK';
  if (JWT.test(value)) return 'JWT';
  if (AUTH_SCHEME.test(value)) return 'AUTH_SCHEME';
  if (PROVIDER_TOKEN.test(value)) return 'PROVIDER_TOKEN';
  if (
    value.length >= MIN_OPAQUE_LENGTH &&
    OPAQUE.test(value) &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value)
  ) {
    return 'OPAQUE_SECRET';
  }
  return null;
}

/**
 * Every credential shape anywhere in a block of text.
 *
 * The final sweep runs over the SERIALISED fixture, which is why this is
 * token-wise rather than whole-string: a token in a URL path segment
 * (`/oauth/callback/ghp_…`) is in no header, no query parameter and no approved
 * field, so the allowlist never sees it. That case is the reason this function
 * exists, and it is a real one rather than a theoretical one.
 */
export function credentialShapesIn(text: string): CredentialShape[] {
  const found = new Set<CredentialShape>();
  if (text.includes('-----BEGIN')) found.add('PEM_BLOCK');
  for (const token of text.split(/[\s"'`,;(){}[\]<>]+|%20/)) {
    if (!token) continue;
    const whole = credentialShapeOf(token);
    if (whole) found.add(whole);
    // A token lifted out of a path or a query string: `callback/ghp_x` and
    // `t=eyJ.eyJ.sig` both hide a credential inside a larger token.
    for (const part of token.split(/[/?&=#:]+/)) {
      if (!part) continue;
      const shape = credentialShapeOf(part);
      if (shape) found.add(shape);
    }
  }
  return [...found];
}

// ─── The allowlist ───────────────────────────────────────────────────────────

/**
 * Headers that survive without the customer naming them.
 *
 * Content negotiation only, and every one of them is a value the application
 * chose rather than a value that identifies the person who recorded. `etag`,
 * `if-none-match` and `vary` are NOT here although they look harmless: an ETag
 * is an opaque server-chosen string and more than one framework derives it from
 * a session. The list is short on purpose — the customer's approval is the way
 * to widen it, per recording, in a place somebody reviewed.
 */
export const SAFE_HEADER_NAMES: readonly string[] = [
  'accept',
  'accept-language',
  'content-type',
];

/**
 * WHAT THE CUSTOMER APPROVED. The allowlist, and the only thing that lets
 * content through.
 *
 * Every field defaults to EMPTY, and an empty approval promotes a fixture of
 * methods, paths and status codes — which is a useful fixture and a safe one.
 * That default is the design: the question a reviewer asks is "what did they
 * approve", not "what did QAAI decide to strip".
 *
 * `bodyFields` is EXACT-PATH and not prefix-matching, and that is the load-
 * bearing choice in this interface. A prefix (`data.*`) would let a key nobody
 * reviewed arrive inside an approved subtree, and the refusal naming it would
 * then be composed out of a key read from the capture — attacker-influenced
 * text in a message a human and a model both read. With exact paths, every
 * surviving value sits at a path the customer typed, so a refusal can name
 * WHERE without quoting anything from the recording.
 */
export interface FixtureApproval {
  /** Extra request/response header names, lower-cased. */
  readonly headerNames?: readonly string[];
  /** Query parameter names that may keep their values. */
  readonly queryParams?: readonly string[];
  /** `METHOD /path` keys whose bodies may be considered at all. {@link exchangeKeyOf}. */
  readonly bodyExchangeKeys?: readonly string[];
  /** Exact dotted paths inside an approved body. `data.items.0.sku`, never `data.*`. */
  readonly bodyFields?: readonly string[];
  /** Hosts other than the environment's own that may appear. Third-party traffic is dropped by default. */
  readonly extraHosts?: readonly string[];
}

/** The deterministic identity of an exchange: what the customer approves by. */
export function exchangeKeyOf(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

// ─── What was removed ────────────────────────────────────────────────────────

/**
 * The kinds of removal, closed so every one can be counted and none can arrive
 * as an unreported difference between what was recorded and what was committed.
 */
export const REDACTION_KINDS = [
  'AUTH_HEADER',
  'COOKIE_HEADER',
  'SET_COOKIE',
  'UNAPPROVED_HEADER',
  'UNAPPROVED_QUERY_PARAM',
  'UNAPPROVED_BODY',
  'UNAPPROVED_BODY_FIELD',
  'BASIC_AUTH_IN_URL',
  'CREDENTIAL_SHAPED_HEADER',
  'CREDENTIAL_SHAPED_QUERY_PARAM',
  'OVERSIZE_BODY',
  'FOREIGN_HOST_EXCHANGE',
  'UNPARSEABLE_EXCHANGE',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/**
 * What each kind means, for the report a human signs off on.
 *
 * `satisfies Record<RedactionKind, …>`, so a fourteenth kind cannot be counted
 * under a label nobody wrote. The phrasing says what was REMOVED rather than
 * what was found, because the report is read by somebody deciding whether the
 * fixture is safe to commit, not by somebody debugging the capture.
 */
export const REDACTION_WHY = {
  AUTH_HEADER: 'Authorization headers removed',
  COOKIE_HEADER: 'Cookie headers removed',
  SET_COOKIE: 'Set-Cookie response headers removed',
  UNAPPROVED_HEADER: 'headers removed because their names were not approved',
  UNAPPROVED_QUERY_PARAM: 'query parameter values removed because their names were not approved',
  UNAPPROVED_BODY: 'bodies dropped whole because the exchange was not approved for bodies',
  UNAPPROVED_BODY_FIELD: 'body fields removed because their exact paths were not approved',
  BASIC_AUTH_IN_URL: 'embedded user:password credentials stripped from a URL',
  CREDENTIAL_SHAPED_HEADER: 'approved headers removed anyway because the value was credential-shaped',
  CREDENTIAL_SHAPED_QUERY_PARAM:
    'approved query parameters removed anyway because the value was credential-shaped',
  OVERSIZE_BODY: 'bodies dropped for exceeding the size ceiling',
  FOREIGN_HOST_EXCHANGE: 'exchanges dropped for a host other than the environment under test',
  UNPARSEABLE_EXCHANGE: 'exchanges dropped because their URL could not be parsed',
} as const satisfies Record<RedactionKind, string>;

/** One removal. Carries no value, ever — see {@link CREDENTIAL_SHAPE_WHY}. */
export interface Redaction {
  readonly kind: RedactionKind;
  /**
   * WHERE, when QAAI can say so from its own records: a header name it matched
   * against its own allowlist, an approved field path the customer typed, an
   * exchange key QAAI composed from a method and a path it already validated.
   * Null when the only available answer would have to be quoted out of the
   * capture.
   */
  readonly at: string | null;
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * Why a promotion did not happen. Closed, so a caller handles every reason and
 * a new one cannot arrive as a silent success.
 */
export const PROMOTION_REFUSALS = [
  /** A credential shape survived the scrub. The one refusal that must never be downgraded. */
  'CREDENTIAL_SURVIVED',
  /** A value at a path the CUSTOMER approved is credential-shaped. They must un-approve it. */
  'CREDENTIAL_IN_APPROVED_CONTENT',
  /** Nothing is left. A recording scrubbed to nothing is not a fixture. */
  'EMPTY_AFTER_SCRUB',
  /** An approved body is not JSON, so its fields cannot be addressed and the rest cannot be dropped. */
  'OPAQUE_APPROVED_BODY',
  /** The destination is not a path QAAI may write. {@link destinationDecision}. */
  'DESTINATION_REFUSED',
  /** The fixture is larger than an artifact may hold. */
  'FIXTURE_TOO_LARGE',
  /** The base URL the recording is being made relative to is not a URL. */
  'BAD_BASE_URL',
] as const;
export type PromotionRefusal = (typeof PROMOTION_REFUSALS)[number];

/**
 * What to do about each refusal. A `satisfies Record<…>`, because a refusal a
 * customer cannot act on is a dead end with a code on it.
 */
export const PROMOTION_REFUSAL_WHY = {
  CREDENTIAL_SURVIVED:
    'A credential-shaped value was still present after scrubbing — probably inside a URL path, where no header or field allowlist can reach it. The recording was NOT promoted. Re-record without authenticating through a URL, or remove those exchanges.',
  CREDENTIAL_IN_APPROVED_CONTENT:
    'A value at a path you approved is credential-shaped. Un-approve that path and promote again; QAAI will not commit it on the strength of the approval, because an approval is about which data is interesting and not about whether it is a secret.',
  EMPTY_AFTER_SCRUB:
    'Everything in this recording was removed by scrubbing, so there is no fixture to commit. Approve the fields you need, or re-record against an environment whose traffic you can share.',
  OPAQUE_APPROVED_BODY:
    'A body you approved fields in is not JSON, so individual fields cannot be kept and the rest dropped. Un-approve the body, or capture it as JSON.',
  DESTINATION_REFUSED:
    'QAAI may not write a file at that path. Choose a path inside the directory this repository keeps its tests in.',
  FIXTURE_TOO_LARGE:
    'The scrubbed fixture is larger than one artifact may hold. Narrow the recording, or raise the exchange cap deliberately.',
  BAD_BASE_URL:
    "The environment's base URL could not be parsed, so recorded URLs cannot be made relative to it. A fixture of absolute URLs is a fixture that only replays against one machine.",
} as const satisfies Record<PromotionRefusal, string>;

/** A refusal, with the one place QAAI can safely name. */
export interface RefusalDetail {
  readonly reason: PromotionRefusal;
  /** A path from the allowlist, a header name, or a credential SHAPE. Never a captured value. */
  readonly at: string | null;
  readonly why: string;
}

// ─── Scrubbing ───────────────────────────────────────────────────────────────

/** An exchange as it will be committed. No headers survive unnamed. */
export interface ScrubbedExchange {
  readonly key: string;
  readonly method: string;
  /** Relative to the environment's base URL, with approved query parameters only. */
  readonly path: string;
  readonly status: number;
  readonly requestHeaders: Record<string, string>;
  readonly responseHeaders: Record<string, string>;
  /** Only the approved field paths. Null when no body survived. */
  readonly responseFields: Record<string, unknown> | null;
}

const ALWAYS_DROP_REQUEST: ReadonlyArray<[string, RedactionKind]> = [
  ['authorization', 'AUTH_HEADER'],
  ['proxy-authorization', 'AUTH_HEADER'],
  ['cookie', 'COOKIE_HEADER'],
];

function lower(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Read a value at an exact dotted path. `data.items.0.sku`.
 *
 * Numeric segments index arrays. Returns `undefined` for a path that is not
 * there, which the caller reports as a field that was approved and absent —
 * NOT as a field that was dropped, because those are different facts and a
 * reviewer comparing the report against the recording would be told the wrong
 * one.
 */
export function valueAtPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      cursor = cursor[index];
      continue;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Keep the approved headers and drop everything else, counting each removal.
 *
 * The order is load-bearing. The always-dropped names are removed FIRST and
 * counted under their own kind, so a customer who approved `cookie` by mistake
 * does not get it committed — an approval widens what is interesting, it never
 * overrides what is a credential. Then an approved header whose value is
 * credential-shaped is dropped too, under a kind that says so, because the same
 * argument applies one level down.
 */
function scrubHeaders(
  headers: readonly CapturedHeader[],
  approvedNames: ReadonlySet<string>,
  redactions: Redaction[],
  direction: 'request' | 'response',
): { kept: Record<string, string>; capped: number } {
  const read = headers.slice(0, MAX_HEADERS_PER_EXCHANGE);
  const kept: Record<string, string> = {};

  for (const header of read) {
    const name = lower(header.name);

    if (direction === 'response' && name === 'set-cookie') {
      redactions.push({ kind: 'SET_COOKIE', at: name });
      continue;
    }
    const always = ALWAYS_DROP_REQUEST.find(([spelling]) => spelling === name);
    if (always) {
      redactions.push({ kind: always[1], at: name });
      continue;
    }
    if (!approvedNames.has(name)) {
      redactions.push({ kind: 'UNAPPROVED_HEADER', at: name });
      continue;
    }
    if (credentialShapeOf(header.value) !== null) {
      redactions.push({ kind: 'CREDENTIAL_SHAPED_HEADER', at: name });
      continue;
    }
    kept[name] = header.value;
  }

  return { kept, capped: headers.length - read.length };
}

// ─── The convention a fixture is written in ──────────────────────────────────

/**
 * How a repository expresses a response set.
 *
 * Only the two shapes this round can produce DETERMINISTICALLY, and the naming
 * says what each is rather than what it is for. A convention that needed a
 * model to emit handler code does not belong here: the deterministic path is
 * the one that must work, and both of these are a serialisation of the same
 * scrubbed data.
 */
export const FIXTURE_CONVENTIONS = ['JSON_RESPONSE_SET', 'HAR_SUBSET'] as const;
export type FixtureConvention = (typeof FIXTURE_CONVENTIONS)[number];

/**
 * The file extension and the one-line description for each convention.
 * `satisfies Record<…>`, so a third convention cannot ship with no file name.
 */
export const FIXTURE_CONVENTION_SPEC = {
  JSON_RESPONSE_SET: {
    extension: '.json',
    why: 'A map of `METHOD /path` to the scrubbed response, which a route handler can replay directly.',
  },
  HAR_SUBSET: {
    extension: '.har.json',
    why: 'The scrubbed exchanges as a HAR-shaped list, for tooling that already reads HAR.',
  },
} as const satisfies Record<FixtureConvention, { extension: string; why: string }>;

/**
 * Serialise, canonically.
 *
 * Keys are SORTED and the indentation is fixed, because the output is committed:
 * two promotions of the same traffic must produce byte-identical files, or every
 * re-record is a diff nobody can read and the idempotence of the whole promotion
 * path is decided by object key order.
 */
function serialise(convention: FixtureConvention, exchanges: readonly ScrubbedExchange[]): string {
  if (convention === 'HAR_SUBSET') {
    return `${JSON.stringify({ log: { version: '1.2', entries: exchanges } }, sortedKeys, 2)}\n`;
  }
  const byKey: Record<string, unknown> = {};
  for (const exchange of exchanges) byKey[exchange.key] = exchange;
  return `${JSON.stringify(byKey, sortedKeys, 2)}\n`;
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

// ─── The report ──────────────────────────────────────────────────────────────

/** How many redaction kinds a one-line summary names before it starts counting. */
export const MAX_KINDS_NAMED = 6;

export interface CapDisclosure {
  readonly what: string;
  readonly count: number;
  readonly reason: string;
}

/**
 * What a promotion did, whether or not it succeeded.
 *
 * Returned on BOTH paths on purpose. A refusal that reported nothing about what
 * was scrubbed would leave a customer guessing which approval to change, and a
 * success that reported nothing would be a commit of real traffic nobody
 * checked.
 */
export interface PromotionReport {
  readonly exchangesIn: number;
  readonly exchangesPromoted: number;
  readonly redactions: readonly Redaction[];
  /** Per kind, walked over {@link REDACTION_KINDS} so a kind with none is still considered. */
  readonly byKind: ReadonlyArray<{ kind: RedactionKind; count: number }>;
  readonly redactionTotal: number;
  /** Every cap that BIT. Empty when none did — never a zero row. */
  readonly caps: readonly CapDisclosure[];
  readonly refusals: readonly RefusalDetail[];
  /** The sentence that keeps this honest. See {@link summariseRedactions}. */
  readonly disclosure: string;
}

/**
 * The counted rule, as a sentence.
 *
 * "61 values removed from 8 exchanges: 12 Authorization headers removed, …" —
 * and when more kinds fired than are named, the TOTAL is still the total, so a
 * capped list cannot read as the whole list. Zero is reported OUT LOUD, because
 * a report that renders nothing is indistinguishable from one that forgot to
 * ask.
 */
export function summariseRedactions(
  redactions: readonly Redaction[],
  exchanges: number,
): string {
  if (redactions.length === 0) {
    return `Nothing was removed from ${exchanges} exchange${exchanges === 1 ? '' : 's'}.`;
  }
  const counts = countByKind(redactions).filter((row) => row.count > 0);
  counts.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const named = counts.slice(0, MAX_KINDS_NAMED);
  const head = `${redactions.length} value${redactions.length === 1 ? '' : 's'} removed from ${exchanges} exchange${exchanges === 1 ? '' : 's'}`;
  const detail = named.map((row) => `${row.count} ${REDACTION_WHY[row.kind]}`).join('; ');
  const rest =
    counts.length > named.length
      ? ` (and ${counts.length - named.length} further kind${counts.length - named.length === 1 ? '' : 's'}, all counted in the ${redactions.length})`
      : '';
  return `${head}: ${detail}${rest}.`;
}

/**
 * Walks {@link REDACTION_KINDS} rather than the rows, so a kind nothing fired
 * is a kind this function still considered and reports as zero — a
 * `for (const r of redactions)` silently drops the kinds that produced none,
 * and a reader cannot tell "none happened" from "not looked at".
 */
export function countByKind(
  redactions: readonly Redaction[],
): Array<{ kind: RedactionKind; count: number }> {
  return REDACTION_KINDS.map((kind) => ({
    kind,
    count: redactions.filter((redaction) => redaction.kind === kind).length,
  }));
}

// ─── Promotion ───────────────────────────────────────────────────────────────

export interface PromoteArgs {
  readonly exchanges: readonly CapturedExchange[];
  /** The environment's base URL. Recorded URLs are made relative to it. */
  readonly baseUrl: string;
  readonly approval: FixtureApproval;
  readonly convention: FixtureConvention;
  /** Repo-relative, WITHOUT the extension — this module supplies it per convention. */
  readonly destinationStem: string;
  /** What QAAI has written before, so a human's file is never overwritten. */
  readonly ledger?: readonly ArtifactLedgerEntry[];
  /** The digest of the bytes currently at the destination, or null when nothing is there. */
  readonly onDiskHash?: string | null;
  /** Injected, for the reason artifact-set.ts records: `node:crypto` in shared 500s the web app. */
  readonly digest: (input: string) => string;
}

export type PromotionResult =
  | { readonly ok: true; readonly set: ArtifactSet; readonly report: PromotionReport }
  | { readonly ok: false; readonly report: PromotionReport };

/**
 * Turn a recording into a proposed fixture, or refuse.
 *
 * ─── THE ORDER OF OPERATIONS IS THE SECURITY ARGUMENT ───────────────────────
 *
 *   1. The destination is checked FIRST, before anything is scrubbed. A path
 *      QAAI may not write is a refusal that costs nothing, and doing it last
 *      would mean scrubbing a thousand exchanges to find out.
 *   2. Each exchange is reduced to what the allowlist admits. Nothing is
 *      "cleaned"; things are either named or gone.
 *   3. The SERIALISED result is swept for credential shapes. This is the step
 *      that catches what the allowlist structurally cannot reach, and it is why
 *      a promotion can be refused after a successful scrub.
 *   4. Only then is an artifact built — and its disposition comes from the
 *      ledger, so a path QAAI has never written earns PROPOSED_EDIT and not a
 *      write.
 *
 * It returns a REPORT on both paths and it never throws for a bad recording: a
 * promotion that threw would tell a customer nothing about which approval to
 * change.
 */
export function promoteRecording(args: PromoteArgs): PromotionResult {
  const redactions: Redaction[] = [];
  const refusals: RefusalDetail[] = [];
  const caps: CapDisclosure[] = [];
  const exchangesIn = args.exchanges.length;

  const refuse = (reason: PromotionRefusal, at: string | null = null): void => {
    refusals.push({ reason, at, why: PROMOTION_REFUSAL_WHY[reason] });
  };

  const extension = FIXTURE_CONVENTION_SPEC[args.convention].extension;
  const path = `${args.destinationStem}${extension}`;

  const destination = destinationDecision({ path });
  if (destination.verdict === 'REFUSED') {
    /*
     * `destination.subject` is a directory segment this path already cleared
     * the malformed check for, or the empty string — never a quoted path. That
     * is artifact-set.ts's own rule and the reason it is safe to carry here.
     */
    refuse('DESTINATION_REFUSED', destination.subject || null);
    return { ok: false, report: report() };
  }

  let base: URL;
  try {
    base = new URL(args.baseUrl);
  } catch {
    refuse('BAD_BASE_URL');
    return { ok: false, report: report() };
  }

  const approvedHeaders = new Set<string>([
    ...SAFE_HEADER_NAMES,
    ...(args.approval.headerNames ?? []).map(lower),
  ]);
  const approvedParams = new Set((args.approval.queryParams ?? []).map((p) => p.trim()));
  const approvedBodyKeys = new Set(args.approval.bodyExchangeKeys ?? []);
  const approvedFields = args.approval.bodyFields ?? [];
  const allowedHosts = new Set<string>([
    base.host.toLowerCase(),
    ...(args.approval.extraHosts ?? []).map((h) => h.trim().toLowerCase()),
  ]);

  const read = args.exchanges.slice(0, MAX_PROMOTED_EXCHANGES);
  if (args.exchanges.length > read.length) {
    caps.push({
      what: 'exchanges',
      count: args.exchanges.length - read.length,
      reason: `Only the first ${MAX_PROMOTED_EXCHANGES} exchanges were promoted. The rest are NOT in the fixture, so a replay of this flow stops where they would have been.`,
    });
  }

  const scrubbed: ScrubbedExchange[] = [];
  let headersCapped = 0;

  for (const exchange of read) {
    let url: URL;
    try {
      /*
       * ABSOLUTE ONLY, and `base` is deliberately NOT passed as the second
       * argument. Resolving against the base would make every unparseable
       * string a RELATIVE PATH ON THE ENVIRONMENT'S OWN HOST — `ht tp://%%%`
       * becomes `https://shop.example.test/ht tp://%%%` — which attributes
       * traffic of unknown origin to the application under test and walks it
       * straight past the foreign-host check below. A recording whose origin
       * QAAI cannot determine is dropped and counted.
       */
      url = new URL(exchange.url);
    } catch {
      redactions.push({ kind: 'UNPARSEABLE_EXCHANGE', at: null });
      continue;
    }

    if (url.username || url.password) {
      // Stripped rather than refused: the credentials are IN THE URL and
      // removing them is a scrub that works. `URL` already parsed them off, so
      // nothing below can carry them.
      redactions.push({ kind: 'BASIC_AUTH_IN_URL', at: null });
    }

    if (!allowedHosts.has(url.host.toLowerCase())) {
      // Third-party traffic — analytics, a CDN, an identity provider — carries
      // tokens QAAI has no way to reason about and the application under test
      // does not serve. Dropped and counted, never kept "because it is only
      // analytics".
      redactions.push({ kind: 'FOREIGN_HOST_EXCHANGE', at: null });
      continue;
    }

    const query = new URLSearchParams();
    for (const [name, value] of url.searchParams) {
      if (!approvedParams.has(name)) {
        redactions.push({ kind: 'UNAPPROVED_QUERY_PARAM', at: null });
        continue;
      }
      if (credentialShapeOf(value) !== null) {
        // `name` came from the customer's own allowlist, so naming it is safe.
        redactions.push({ kind: 'CREDENTIAL_SHAPED_QUERY_PARAM', at: name });
        continue;
      }
      query.append(name, value);
    }

    const search = query.toString();
    const key = exchangeKeyOf(exchange.method, url.pathname);
    const request = scrubHeaders(exchange.requestHeaders, approvedHeaders, redactions, 'request');
    const response = scrubHeaders(
      exchange.responseHeaders,
      approvedHeaders,
      redactions,
      'response',
    );
    headersCapped += request.capped + response.capped;

    let responseFields: Record<string, unknown> | null = null;
    const body = exchange.responseBody;

    if (body !== null && body !== '') {
      if (!approvedBodyKeys.has(key)) {
        redactions.push({ kind: 'UNAPPROVED_BODY', at: key });
      } else if (body.length > MAX_BODY_CHARS) {
        redactions.push({ kind: 'OVERSIZE_BODY', at: key });
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          // An approved body that is not JSON cannot have its fields addressed,
          // so there is no way to keep the approved part and drop the rest.
          // Refusing beats committing the whole thing.
          refuse('OPAQUE_APPROVED_BODY', key);
          parsed = undefined;
        }
        if (parsed !== undefined) {
          const fields: Record<string, unknown> = {};
          for (const field of approvedFields) {
            const value = valueAtPath(parsed, field);
            if (value === undefined) continue;
            if (typeof value === 'string' && credentialShapeOf(value) !== null) {
              // The path is the customer's own text, so naming it is safe — and
              // naming it is the whole point: it is the one thing they can change.
              refuse('CREDENTIAL_IN_APPROVED_CONTENT', field);
              continue;
            }
            fields[field] = value;
          }
          const dropped = countTopLevel(parsed) - Object.keys(fields).length;
          if (dropped > 0) {
            redactions.push({ kind: 'UNAPPROVED_BODY_FIELD', at: key });
          }
          responseFields = Object.keys(fields).length > 0 ? fields : null;
        }
      }
    }

    scrubbed.push({
      key,
      method: exchange.method.toUpperCase(),
      path: search ? `${url.pathname}?${search}` : url.pathname,
      status: exchange.status,
      requestHeaders: request.kept,
      responseHeaders: response.kept,
      responseFields,
    });
  }

  if (headersCapped > 0) {
    caps.push({
      what: 'headers',
      count: headersCapped,
      reason: `Only the first ${MAX_HEADERS_PER_EXCHANGE} headers of each exchange were read. The rest were neither kept nor scrubbed — they are simply absent from the fixture.`,
    });
  }

  if (refusals.length > 0) return { ok: false, report: report() };

  if (scrubbed.length === 0) {
    refuse('EMPTY_AFTER_SCRUB');
    return { ok: false, report: report() };
  }

  const content = serialise(args.convention, scrubbed);

  /*
   * THE FINAL SWEEP. Everything above is an allowlist, and an allowlist cannot
   * reach a credential that is part of a URL PATH rather than a header, a query
   * parameter or a field — `/oauth/callback/ghp_…` is in none of the three. The
   * refusal names the SHAPE and never the value.
   */
  const survived = credentialShapesIn(content);
  if (survived.length > 0) {
    for (const shape of survived) {
      refusals.push({
        reason: 'CREDENTIAL_SURVIVED',
        at: shape,
        why: `${PROMOTION_REFUSAL_WHY.CREDENTIAL_SURVIVED} What was found looks like ${CREDENTIAL_SHAPE_WHY[shape]}.`,
      });
    }
    return { ok: false, report: report(scrubbed.length) };
  }

  if (content.length > MAX_FIXTURE_CHARS) {
    refuse('FIXTURE_TOO_LARGE');
    return { ok: false, report: report(scrubbed.length) };
  }

  /*
   * The disposition is DERIVED from the ledger and never chosen. A path QAAI
   * has never written resolves to UNRECORDED, which `dispositionFor` turns into
   * PROPOSED_EDIT — so the default direction for a fixture inside a customer's
   * repository is "ask", and the only way to get a write is a path whose bytes
   * on disk are still the bytes QAAI last wrote there.
   */
  const ledger = args.ledger ?? [];
  const verdict = resolveOwnership(ledger, path);
  const ledgerHash = ledger.find((entry) => entry.path === path)?.contentHash ?? null;
  const onDiskHash = args.onDiskHash ?? null;
  const disposition = dispositionFor({ verdict, ledgerHash, onDiskHash });

  const artifact: GeneratedArtifact = {
    role: 'DATASET',
    path,
    content,
    disposition,
    ownership: verdict,
    imports: [],
    basedOnHash: disposition === 'NEW' ? null : args.digest(content),
    why: `${FIXTURE_CONVENTION_SPEC[args.convention].why} Promoted from a recording of ${scrubbed.length} exchange${scrubbed.length === 1 ? '' : 's'}; ${summariseRedactions(redactions, scrubbed.length)}`,
  };

  return {
    ok: true,
    set: { artifacts: [artifact], dialect: null },
    report: report(scrubbed.length),
  };

  function report(promoted = 0): PromotionReport {
    return {
      exchangesIn,
      exchangesPromoted: promoted,
      redactions,
      byKind: countByKind(redactions),
      redactionTotal: redactions.length,
      caps,
      refusals,
      disclosure: summariseRedactions(redactions, exchangesIn),
    };
  }
}

/**
 * How many top-level things a parsed body has, for the "fields were dropped"
 * count.
 *
 * TOP LEVEL ONLY, and the comment is here because the number is otherwise
 * misleading: it is a count of what a reviewer can SEE was dropped, not a deep
 * field census. A deep census would be a better number and a worse one too —
 * it would read as a promise that every nested field was individually
 * considered, and the approval is exact-path precisely because they are not.
 */
function countTopLevel(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed !== null && typeof parsed === 'object') return Object.keys(parsed).length;
  return 1;
}
