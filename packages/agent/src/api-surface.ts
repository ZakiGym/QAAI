/**
 * The backend's whole surface: what a document DECLARES, what a schema EXPOSES,
 * and what the running application actually ANSWERS.
 *
 * ── THE THREE DEFECTS THIS FILE EXISTS TO END ───────────────────────────────
 *
 * 1. THE RICHEST DECLARATION OF AN API IS READ AND THROWN AWAY. OpenAPI is
 *    parsed in exactly one place — `packages/runner/src/plugins/contract.ts`,
 *    inside the CONTRACT runner — and only for the operations a human already
 *    listed in a test spec. The moment the run ends, the methods, the path
 *    templates, the declared auth and every parameter bound are gone. So the
 *    one artifact that answers "how many operations does this backend have"
 *    has never once been allowed to contribute to the denominator, and the
 *    `HttpEndpoint` rows that do survive are UNKNOWN-verb declarations nothing
 *    verifies.
 *
 * 2. A GRAPHQL BACKEND'S DENOMINATOR IS WHATEVER SOMEBODY TYPED. The protocol
 *    runner's `introspect` flag fetches a schema and uses it for one thing:
 *    checking that the ROOT FIELDS of the operations a human already wrote
 *    exist. Nothing walks the schema. A backend with 300 queries and 140
 *    mutations enumerates as however many `operations` entries are in the spec
 *    file, which is a measurement of the spec file.
 *
 * 3. PHANTOM ENDPOINTS INFLATE THE DENOMINATOR AND REAL ONES ARE MISSED. An
 *    `HttpEndpoint` is a method and a path that a detector thought it saw.
 *    Nothing ever asks the application. A route that was deleted last quarter
 *    still divides the coverage percentage; a verb the document declares and
 *    the gateway refuses looks identical to one that works.
 *
 * ── WHAT IS NOT IN THIS FILE, ON PURPOSE ────────────────────────────────────
 *
 * No `fetch`, no vendor SDK, no `node:fs`, no model. Every reader takes its I/O
 * as a one-method injected interface — {@link GraphqlTransport},
 * {@link ApiProbeTransport} — and every parser takes an already-decoded value.
 * `crawler.ts` is 629 lines with almost no tests because it holds its browser;
 * that shape is what this file is written against. Enumeration is parsing and
 * graph work and is 100% model-free: a denominator whose working we cannot show
 * is worse than no denominator.
 *
 * ── THE SILENCES THIS FILE REFUSES TO SPELL AS ANSWERS ──────────────────────
 *
 *   · A document that declares no security for an operation and a document we
 *     never read are `NONE` and `NOT_READ`. The second must never generate a
 *     negative-auth test, because the 401 it gets would be reported as the
 *     application correctly refusing anonymous access — a passing test that
 *     asserted nothing. `API_AUTH_DECLARATIONS` in @qaai/shared owns this
 *     distinction; every path below produces one of its five members and never
 *     a boolean.
 *   · A `$ref` we did not follow leaves the bounds it would have carried
 *     ABSENT, never null, and files an {@link ApiIngestGap}. Absent means "this
 *     reader did not capture that constraint"; null means "the declaration
 *     states no bound". A `maxLength` of null read as "no limit" is a negative
 *     test that posts 10,000 characters at an operation whose document never
 *     promised to reject it, and then reports the 500 as the customer's defect.
 *   · Introspection being switched off is {@link GraphqlSchemaState}
 *     INTROSPECTION_REFUSED with `operationsFound: null`. "This API has no
 *     operations" is a different sentence and this module cannot say it.
 *   · A probe that got nothing is NO_ANSWER. A probe we chose not to issue is
 *     NOT_PROBED with a {@link NotProbedReason}. Neither is "does not exist",
 *     and there is no REFUTED state anywhere below, because a 404 cannot tell
 *     an undeployed operation from a feature flag, a stale gateway or an
 *     authorisation wall that hides existence.
 *   · Every cap that BIT is a count AND a reason. An undisclosed cap on an
 *     ingest makes the coverage percentage go UP, which is the one direction
 *     this product may never be wrong in.
 */

import {
  ANONYMOUS_ACCESS_DECLARED,
  API_OPERATION_METHODS,
  apiOperationSchema,
  policyDecision,
  surfaceKey,
  type ApiAuthDeclaration,
  type ApiOperationInput,
  type ApiOperationMethod,
  type ApiOperationProbeFact,
  type ApiOperationVerification,
  type ApiParameterBound,
  type ApiParameterLocation,
  type CapBite,
  type CrawlCap,
  type CrawlPolicy,
  type ExcludedPath,
  type ExclusionKind,
  type NotProbedReason,
} from '@qaai/shared';
import { z } from 'zod';
/*
 * PROBE_BAD_ID is IMPORTED and not re-decided. `crawl/observe.ts` already
 * argued out which id a negative probe should use — `0`, because a random id
 * might exist and a large one overflows a 32-bit column and turns the probe
 * into a bug report about our probe — and a second sentinel here would mean two
 * modules asking the same application two different questions and reporting
 * both as "a bad id".
 */
import { PROBE_BAD_ID } from './crawl/observe.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. WHAT KIND OF DOCUMENT IS THIS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The document shapes this module reads, plus the two refusals.
 *
 * UNRECOGNISED and NOT_JSON are members rather than thrown errors because an
 * ingest runs over whatever a customer pointed us at, and "we could not tell
 * what this file is" has to be a reportable fact. A thrown error ends the whole
 * ingest, so one unreadable file in a folder of twelve would take the other
 * eleven with it.
 *
 * ASYNCAPI is one member and not two: 2.x and 3.x move the operation out of the
 * channel and into an `operations` map, which {@link ingestApiDocument} handles
 * by reading both shapes, and `version` on the result carries which it was.
 */
export const API_DOCUMENT_KINDS = [
  'OPENAPI_3',
  'SWAGGER_2',
  'ASYNCAPI',
  'POSTMAN',
  /** Decoded fine, and nothing in it identifies a format we read. */
  'UNRECOGNISED',
  /**
   * Not a decoded object at all — a YAML string, a buffer, a null.
   *
   * This module takes a DECODED value on purpose: a YAML parser is a
   * dependency, and the contract runner already reports "YAML needs a parser"
   * as SKIPPED rather than FAILED. The caller decodes; this member is what it
   * gets when it did not.
   */
  'NOT_JSON',
] as const;
export type ApiDocumentKind = (typeof API_DOCUMENT_KINDS)[number];

export const API_DOCUMENT_KIND_LABELS: Record<ApiDocumentKind, string> = {
  OPENAPI_3: 'an OpenAPI 3.x document',
  SWAGGER_2: 'a Swagger 2.0 document',
  ASYNCAPI: 'an AsyncAPI document',
  POSTMAN: 'a Postman collection',
  UNRECOGNISED: 'a JSON document in no format this reader knows',
  NOT_JSON: 'not a decoded JSON value — a string, a buffer or null',
};

/** True when `value` is a plain keyed object, which every probe below needs. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Which format a decoded document is, and the version it claims.
 *
 * Keys on the version field each format is REQUIRED to carry — `openapi`,
 * `swagger`, `asyncapi`, `info.schema` — rather than on the presence of
 * `paths`. Swagger 2.0 and OpenAPI 3.x both have `paths` and put bodies and
 * security in different places, so guessing from `paths` picks the wrong body
 * reader half the time and silently produces operations with no request shape.
 */
export function detectApiDocumentKind(document: unknown): {
  kind: ApiDocumentKind;
  /** The version string the document claims, verbatim. Null when it claims none. */
  version: string | null;
  detail: string;
} {
  if (!isRecord(document)) {
    return {
      kind: 'NOT_JSON',
      version: null,
      detail: 'the value handed to the ingest is not a decoded JSON object',
    };
  }

  const openapi = asString(document.openapi);
  if (openapi !== null) {
    return { kind: 'OPENAPI_3', version: openapi, detail: `openapi: ${openapi}` };
  }
  const swagger = asString(document.swagger);
  if (swagger !== null) {
    return { kind: 'SWAGGER_2', version: swagger, detail: `swagger: ${swagger}` };
  }
  const asyncapi = asString(document.asyncapi);
  if (asyncapi !== null) {
    return { kind: 'ASYNCAPI', version: asyncapi, detail: `asyncapi: ${asyncapi}` };
  }

  /*
   * Postman has no version field of its own; `info.schema` is a URL naming the
   * collection schema version, and `item` is the only array every collection
   * has. Both are required here so a hand-written `{ item: [] }` is not read as
   * a collection — the same structural check `importer.ts` makes, for the same
   * reason.
   */
  const info = isRecord(document.info) ? document.info : null;
  const schema = info ? asString(info.schema) : null;
  if (Array.isArray(document.item) && (schema !== null || info?._postman_id !== undefined)) {
    return {
      kind: 'POSTMAN',
      version: schema,
      detail: schema ?? 'a collection with a _postman_id and no schema URL',
    };
  }

  return {
    kind: 'UNRECOGNISED',
    version: null,
    detail:
      'no `openapi`, `swagger` or `asyncapi` version field, and not a Postman collection; ' +
      'nothing in this document identifies a format this reader knows',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GAPS: EVERY PLACE THE READER STOPPED, NAMED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ways this reader can fall short of the document.
 *
 * A closed vocabulary because the report groups by it and because each one has
 * a different remedy — and above all because the alternative to a named gap is
 * a FIELD THAT IS SIMPLY MISSING, which a downstream reader cannot tell from a
 * declaration that states no bound. That confusion has one direction: it makes
 * our numbers look better than they are.
 */
export const API_INGEST_GAPS = [
  /**
   * A `$ref` pointing outside this document (`http(s)://`, or another file).
   *
   * NOT followed: fetching it needs I/O this module does not own, and silently
   * resolving it against the local document would be worse — it would quietly
   * bind a name in `components` that happens to collide. The operation is still
   * emitted; the bounds it would have carried are absent and this says why.
   */
  'REMOTE_REF_NOT_FOLLOWED',
  /** A local `$ref` whose JSON pointer resolves to nothing in this document. */
  'LOCAL_REF_UNRESOLVED',
  /** A `$ref` chain that points back at itself. Stopped, and named. */
  'REF_CYCLE',
  /** A `$ref` chain deeper than the cap. The cap is disclosed beside it. */
  'REF_DEPTH_EXCEEDED',
  /**
   * A schema built with `allOf` / `oneOf` / `anyOf` / `not`.
   *
   * Composition is where a real JSON-schema implementation starts, and writing
   * half of one here would produce bounds that are right for the simple cases
   * and confidently wrong for the rest. The operation is emitted with no bounds
   * from this schema and the gap says which keyword stopped the read.
   */
  'COMPOSED_SCHEMA_NOT_READ',
  /**
   * A request body in a media type this reader does not take bounds from:
   * `multipart/form-data`, `application/octet-stream`, `text/plain`.
   */
  'BODY_MEDIA_TYPE_NOT_READ',
  /** An operation body that is a bare schema with no named properties. */
  'BODY_PROPERTIES_NOT_NAMED',
  /**
   * A body property that is itself an object or an array.
   *
   * Its OWN bounds are read; the bounds of its children are not, because
   * `a.b.c` is not a parameter name any request builder here would know what to
   * do with. Without this gap the nested property arrives looking like a field
   * whose declaration states no limits, which is the three-state rule's absent
   * case leaking in through a different door: a reader cannot tell "this object
   * declares nothing" from "we did not descend into it".
   */
  'NESTED_SHAPE_NOT_DESCENDED',
  /**
   * The operation names a security scheme the document never defines.
   *
   * It still counts as REQUIRED — the operation asked for authentication, and
   * which scheme it is does not change that — but a generator cannot build a
   * credential for it, so the gap is what stops it being silently skipped.
   */
  'SECURITY_SCHEME_UNDEFINED',
  /**
   * An AsyncAPI channel whose bindings do not describe an HTTP operation.
   *
   * A Kafka topic is a real surface and it is NOT an `ApiOperation`: it has no
   * method and no path, and minting `UNKNOWN /topic-name` would put a row in a
   * table whose identity is `(method, pathTemplate)` for a thing that has
   * neither. `BackgroundSurfaceFact` is where it belongs; this records that we
   * saw it and did not file it here.
   */
  'CHANNEL_NOT_HTTP',
  /** A path item whose verbs are unreadable: not an object, or empty. */
  'PATH_ITEM_UNREADABLE',
  /** An entry this reader skipped because it is not an operation at all. */
  'NOT_AN_OPERATION',
] as const;
export type ApiIngestGapKind = (typeof API_INGEST_GAPS)[number];

export const API_INGEST_GAP_LABELS: Record<ApiIngestGapKind, string> = {
  REMOTE_REF_NOT_FOLLOWED: 'a $ref into another document was not followed',
  LOCAL_REF_UNRESOLVED: 'a local $ref pointed at nothing',
  REF_CYCLE: 'a $ref chain pointed back at itself',
  REF_DEPTH_EXCEEDED: 'a $ref chain was deeper than the cap',
  COMPOSED_SCHEMA_NOT_READ: 'a composed schema (allOf/oneOf/anyOf) was not read',
  BODY_MEDIA_TYPE_NOT_READ: 'a request body media type this reader takes no bounds from',
  BODY_PROPERTIES_NOT_NAMED: 'a request body with no named properties',
  NESTED_SHAPE_NOT_DESCENDED: 'a body property is an object or array this reader did not descend into',
  SECURITY_SCHEME_UNDEFINED: 'an operation names a security scheme the document does not define',
  CHANNEL_NOT_HTTP: 'an AsyncAPI channel that is not an HTTP operation',
  PATH_ITEM_UNREADABLE: 'a path item whose verbs could not be read',
  NOT_AN_OPERATION: 'an entry that is not an operation',
};

/**
 * One place the reader stopped short.
 *
 * `pointer` is a JSON pointer into the document — `/paths/~1orders/get` — so a
 * human can open the file at the exact place. Required: a gap with no location
 * is a caveat nobody can act on, and a report full of unlocatable caveats is a
 * report people learn to scroll past.
 */
export interface ApiIngestGap {
  kind: ApiIngestGapKind;
  pointer: string;
  /** The sentence the report prints. Always written, never defaulted to ''. */
  detail: string;
}

/** JSON-pointer escaping, so a path template with slashes survives a pointer. */
function pointerSegment(raw: string): string {
  return raw.replace(/~/g, '~0').replace(/\//g, '~1');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. AXIS AVAILABILITY: MEASURED, OR NOT LOOKED AT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The separately-measurable, separately-absent parts of an API read.
 *
 * The point of listing them is `found: null`. A document with no security
 * schemes and a document whose security section this reader never reached both
 * produce zero declarations, and only one of them supports the sentence "this
 * API declares no authentication". Mirrors `HarvestAxisState` in
 * `crawl/harvest.ts` deliberately — same three fields, same invariant — so a
 * reader of either file recognises the shape.
 */
export const API_SURFACE_AXES = [
  'OPERATIONS',
  'PARAMETERS',
  'AUTH',
  'REQUEST_BODIES',
  'RESPONSES',
] as const;
export type ApiSurfaceAxis = (typeof API_SURFACE_AXES)[number];

export const API_SURFACE_AXIS_LABELS: Record<ApiSurfaceAxis, string> = {
  OPERATIONS: 'operations',
  PARAMETERS: 'parameter bounds',
  AUTH: 'declared authentication',
  REQUEST_BODIES: 'request bodies',
  RESPONSES: 'declared responses',
};

/**
 * One axis's result. `found` is null EXACTLY when `state` is UNAVAILABLE, and
 * {@link apiAxisIsConsistent} asserts it, so a writer that reports an
 * unavailable axis as zero fails a test instead of shipping a flattering
 * number.
 */
export interface ApiSurfaceAxisState {
  state: 'MEASURED' | 'UNAVAILABLE';
  found: number | null;
  /** Required when UNAVAILABLE: what stopped us looking. */
  reason: string | null;
}

/** Whether an axis's own fields agree. See {@link ApiSurfaceAxisState}. */
export function apiAxisIsConsistent(axis: ApiSurfaceAxisState): boolean {
  return axis.state === 'UNAVAILABLE'
    ? axis.found === null && axis.reason !== null
    : axis.found !== null && axis.reason === null;
}

function axisMeasured(found: number): ApiSurfaceAxisState {
  return { state: 'MEASURED', found, reason: null };
}

function axisUnavailable(reason: string): ApiSurfaceAxisState {
  return { state: 'UNAVAILABLE', found: null, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CAPS, DISCLOSED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every limit this module can apply.
 *
 * Separate from `CRAWL_CAPS` because four of the five have no member there and
 * @qaai/shared is not this agent's file this round.
 * {@link API_SURFACE_CAP_AS_CRAWL_CAP} maps the one that does have a home and
 * names the four that do not, so {@link apiSurfaceCapBites} hands the
 * integrator an explicit `unexpressible` list instead of losing a cap that bit.
 * The same shape `crawl/harvest.ts` uses, for the same reason.
 */
export const API_SURFACE_CAPS = [
  /** How many operations one document may contribute. */
  'OPERATION_BUDGET',
  /** How deep a `$ref` chain is followed before it is abandoned. */
  'REF_DEPTH',
  /** How many probes one run may issue. */
  'PROBE_BUDGET',
  /**
   * The same budget, spent before a FOLLOW-UP probe on an operation that was
   * itself probed.
   *
   * Its own member rather than more `discarded` on PROBE_BUDGET, because the
   * two things one budget stops are different facts with different arithmetic.
   * PROBE_BUDGET's `discarded` counts operations that were never probed at all
   * — a floor on "at least N more operations existed" — and folding in the
   * credentialled half of an auth probe, a bad-id probe or an undeclared-verb
   * probe would inflate that figure with operations we DID reach. What this one
   * costs is a QUESTION left unasked about an operation that has a verdict:
   * `authRequiredInFact` stays null, no bad id was tried, no undocumented verb
   * was looked for. Both are disclosed; neither is reported as the other.
   */
  'PROBE_FOLLOW_UP_BUDGET',
  /**
   * The minimum gap between two probe requests.
   *
   * A rate limit is a cap like any other and it BITES by delaying; a run that
   * ran out of wall clock because it was politely waiting has probed fewer
   * operations than it was asked to, and the report has to be able to say so.
   */
  'PROBE_RATE',
  /** How many GraphQL types the introspection walk reads. */
  'INTROSPECTION_TYPE_BUDGET',
] as const;
export type ApiSurfaceCap = (typeof API_SURFACE_CAPS)[number];

export const API_SURFACE_CAP_LABELS: Record<ApiSurfaceCap, string> = {
  OPERATION_BUDGET: 'the per-document operation budget',
  REF_DEPTH: 'the $ref depth limit',
  PROBE_BUDGET: 'the probe budget',
  PROBE_FOLLOW_UP_BUDGET: 'the probe budget, spent before a follow-up probe',
  PROBE_RATE: 'the probe rate limit',
  INTROSPECTION_TYPE_BUDGET: 'the introspection type budget',
};

/**
 * Where each cap lands in the shared vocabulary.
 *
 * Compiler-enforced, so a new cap must declare whether it has a home. The four
 * nulls are not an oversight: `CRAWL_CAPS` has no member for a `$ref` depth or
 * a request rate, and filing a probe budget under PAGE_BUDGET would put a
 * number in a field every reader interprets as pages.
 */
export const API_SURFACE_CAP_AS_CRAWL_CAP = {
  OPERATION_BUDGET: null,
  REF_DEPTH: null,
  PROBE_BUDGET: null,
  PROBE_FOLLOW_UP_BUDGET: null,
  PROBE_RATE: null,
  INTROSPECTION_TYPE_BUDGET: null,
} as const satisfies Record<ApiSurfaceCap, CrawlCap | null>;

/** Structurally `CapBite`, with this module's own cap vocabulary. */
export interface ApiSurfaceCapBite {
  cap: ApiSurfaceCap;
  limit: number;
  bites: number;
  /** Candidates it discarded. A LOWER bound on what it cost. */
  discarded: number;
  scope: string | null;
  reason: string;
}

/**
 * Projects this module's cap bites onto the shared `CapBite` shape.
 *
 * Returns the ones it could not express rather than dropping them, and the
 * field is named so that losing them takes a deliberate act. Today that is all
 * of them; the remedy is five lines in `CRAWL_CAPS`, and until they land a
 * caller prints `unexpressible` beside the flow map's caps or an ingest budget
 * is a cap that bit in silence.
 */
export function apiSurfaceCapBites(bites: readonly ApiSurfaceCapBite[]): {
  capBites: CapBite[];
  unexpressible: ApiSurfaceCapBite[];
} {
  const capBites: CapBite[] = [];
  const unexpressible: ApiSurfaceCapBite[] = [];
  for (const bite of bites) {
    const mapped = API_SURFACE_CAP_AS_CRAWL_CAP[bite.cap];
    if (mapped === null) {
      unexpressible.push(bite);
      continue;
    }
    capBites.push({
      cap: mapped,
      limit: bite.limit,
      bites: bite.bites,
      discarded: bite.discarded,
      scope: bite.scope,
      reason: bite.reason,
    });
  }
  return { capBites, unexpressible };
}

export interface ApiSurfaceCaps {
  operationBudget: number;
  refDepth: number;
  probeBudget: number;
  /** Milliseconds between two probe requests. 0 disables the wait. */
  probeMinIntervalMs: number;
  introspectionTypeBudget: number;
}

/**
 * The defaults, and why each number is the number.
 *
 * `operationBudget: 5000` — a gateway spec for a large estate runs to a few
 * thousand operations and we would rather hold all of them than truncate a
 * denominator; the cap exists to stop a generated document, not a real one.
 *
 * `refDepth: 20` — the same depth the contract runner's resolver uses, so a
 * document that resolves there resolves here.
 *
 * `probeBudget: 200` and `probeMinIntervalMs: 100` — ten requests a second
 * against a customer's environment, for twenty seconds. The limit is low on
 * purpose: this is unsolicited traffic at somebody's running application, and
 * the honest move when it bites is to say "200 of your 1,840 operations were
 * probed" rather than to quietly probe all of them.
 */
export const DEFAULT_API_SURFACE_CAPS: ApiSurfaceCaps = {
  operationBudget: 5_000,
  refDepth: 20,
  probeBudget: 200,
  probeMinIntervalMs: 100,
  introspectionTypeBudget: 2_000,
};

/**
 * Names three scopes and says how many more there were.
 *
 * Empty gives null: no scope recorded is not the same fact as a scope of ''.
 */
function scopeSentence(scopes: readonly string[]): string | null {
  if (scopes.length === 0) return null;
  const shown = scopes.slice(0, 3);
  const rest = scopes.length - shown.length;
  return rest === 0 ? shown.join(', ') : `${shown.join(', ')} (+${rest} more)`;
}

/** Accumulates cap bites so one cap produces one row with a total. */
class CapLedger {
  private readonly tallies = new Map<
    ApiSurfaceCap,
    { limit: number; bites: number; discarded: number; scopes: Set<string> }
  >();

  bite(cap: ApiSurfaceCap, limit: number, scope: string, discarded: number): void {
    const tally = this.tallies.get(cap) ?? { limit, bites: 0, discarded: 0, scopes: new Set() };
    tally.bites += 1;
    tally.discarded += discarded;
    tally.scopes.add(scope);
    this.tallies.set(cap, tally);
  }

  bites(suffix: (cap: ApiSurfaceCap, discarded: number) => string): ApiSurfaceCapBite[] {
    return [...this.tallies.entries()].map(([cap, tally]) => ({
      cap,
      limit: tally.limit,
      bites: tally.bites,
      discarded: tally.discarded,
      /*
       * Three scopes, AND A COUNT OF THE REST. `scope` is a sentence for a
       * human and three names is enough of one, but a bare `slice(0, 3)` is a
       * cap inside a cap disclosure: a budget that bit on forty operations
       * named three and read as though those were all of them. `bites` and
       * `discarded` were always whole; this makes the sentence say so too.
       */
      scope: scopeSentence([...tally.scopes]),
      reason: suffix(cap, tally.discarded),
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. $REF RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/** True for a `$ref` that points outside this document. */
function isRemoteRef(ref: string): boolean {
  return !ref.startsWith('#');
}

/**
 * Follows a `$ref` chain inside one document.
 *
 * Returns the resolved value, or null AND a gap. Never returns a partially
 * resolved value with no gap, which is the failure mode that matters: a
 * resolver that returns `{}` on a miss produces a schema with no keywords, and
 * a schema with no keywords is indistinguishable from a declaration that states
 * no bounds.
 *
 * Remote refs are a REFUSAL and not a failure. The remedy is an injected
 * fetcher, which belongs to whoever owns the ingest's I/O; until then a
 * customer reading the report sees "14 operations have bounds we did not read,
 * because their schemas live in `common.yaml`" instead of 14 operations that
 * silently declare nothing.
 */
function resolveRef(
  document: Record<string, unknown>,
  node: unknown,
  pointer: string,
  depthLimit: number,
): { value: unknown; gap: ApiIngestGap | null } {
  const seen = new Set<string>();
  let current = node;

  for (let depth = 0; depth <= depthLimit; depth += 1) {
    if (!isRecord(current)) return { value: current, gap: null };
    const ref = asString(current.$ref);
    if (ref === null) return { value: current, gap: null };

    if (isRemoteRef(ref)) {
      return {
        value: null,
        gap: {
          kind: 'REMOTE_REF_NOT_FOLLOWED',
          pointer,
          detail:
            `\`${ref}\` points outside this document; nothing here fetches it, so the bounds ` +
            'it declares are NOT captured — they are absent rather than stated as none',
        },
      };
    }
    if (seen.has(ref)) {
      return {
        value: null,
        gap: {
          kind: 'REF_CYCLE',
          pointer,
          detail: `the $ref chain returns to \`${ref}\`; stopped rather than followed for ever`,
        },
      };
    }
    seen.add(ref);

    const target = followPointer(document, ref.slice(1));
    if (target === undefined) {
      return {
        value: null,
        gap: {
          kind: 'LOCAL_REF_UNRESOLVED',
          pointer,
          detail: `\`${ref}\` resolves to nothing in this document`,
        },
      };
    }
    current = target;
  }

  return {
    value: null,
    gap: {
      kind: 'REF_DEPTH_EXCEEDED',
      pointer,
      detail: `the $ref chain is deeper than ${depthLimit}; abandoned, and this says so`,
    },
  };
}

/** Walks a `/`-separated JSON pointer. `undefined` means "nothing is there". */
function followPointer(document: Record<string, unknown>, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return document;
  let current: unknown = document;
  for (const rawSegment of pointer.replace(/^\//, '').split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      if (!(segment in current)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** The composition keywords this reader does not implement. */
const COMPOSITION_KEYWORDS = ['allOf', 'oneOf', 'anyOf', 'not'] as const;

function composedBy(schema: Record<string, unknown>): string | null {
  for (const keyword of COMPOSITION_KEYWORDS) {
    if (schema[keyword] !== undefined) return keyword;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. PARAMETER BOUNDS
// ─────────────────────────────────────────────────────────────────────────────

const LOCATION_BY_DOCUMENT_WORD: Record<string, ApiParameterLocation> = {
  path: 'PATH',
  query: 'QUERY',
  header: 'HEADER',
  cookie: 'COOKIE',
  body: 'BODY',
  formData: 'BODY',
};

/**
 * Lifts the bounds out of one schema object.
 *
 * ── THE THREE-STATE RULE, IMPLEMENTED ───────────────────────────────────────
 *
 * Every bound below is set to `schema[keyword] ?? null` and never left out,
 * BECAUSE THE SCHEMA WAS READ. Reading a schema and finding no `maximum` is a
 * declaration that there is no maximum, which is `null`. The other state —
 * the key absent entirely — is produced by the CALLER, which omits this call
 * when the schema could not be read at all (a remote `$ref`, a composition) and
 * files a gap instead. Those two paths must stay distinct: collapsing them is
 * how a reader's own blind spot gets reported as the application's missing
 * validation.
 *
 * `format` is read into `type` as `string/date-time` rather than dropped,
 * because a negative test built from `type: string` alone will happily send
 * `"x"` at a field documented as a date and call the 400 a defect.
 */
function boundsFromSchema(schema: Record<string, unknown>): Pick<
  ApiParameterBound,
  'type' | 'minimum' | 'maximum' | 'minLength' | 'maxLength' | 'pattern' | 'enumValues'
> {
  const declaredType = asString(schema.type);
  const format = asString(schema.format);
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.map((member) => (typeof member === 'string' ? member : JSON.stringify(member)))
    : null;

  return {
    type: declaredType === null ? null : format === null ? declaredType : `${declaredType}/${format}`,
    minimum: asNumber(schema.minimum),
    maximum: asNumber(schema.maximum),
    minLength: asNumber(schema.minLength),
    maxLength: asNumber(schema.maxLength),
    pattern: asString(schema.pattern),
    enumValues,
  };
}

/**
 * One parameter object → one bound, with the document's two layouts handled.
 *
 * OpenAPI 3.x nests the schema (`{ name, in, schema: { type, maximum } }`);
 * Swagger 2.0 puts the keywords on the parameter itself
 * (`{ name, in, type, maximum }`). Reading only the 3.x shape against a 2.0
 * document produces a parameter list with every bound null — "this API declares
 * no limits on anything" — which is the most flattering possible wrong answer,
 * because it suppresses every negative test the document entitles us to write.
 */
function parameterBound(
  document: Record<string, unknown>,
  raw: unknown,
  pointer: string,
  depthLimit: number,
): { bound: ApiParameterBound | null; gaps: ApiIngestGap[] } {
  const gaps: ApiIngestGap[] = [];
  const resolved = resolveRef(document, raw, pointer, depthLimit);
  if (resolved.gap) gaps.push(resolved.gap);
  if (!isRecord(resolved.value)) return { bound: null, gaps };
  const parameter = resolved.value;

  const name = asString(parameter.name);
  const where = asString(parameter.in);
  if (name === null || where === null) {
    gaps.push({
      kind: 'NOT_AN_OPERATION',
      pointer,
      detail: 'a parameter entry with no `name` or no `in`; not a parameter this reader can place',
    });
    return { bound: null, gaps };
  }
  const location = LOCATION_BY_DOCUMENT_WORD[where];
  if (location === undefined) {
    gaps.push({
      kind: 'NOT_AN_OPERATION',
      pointer,
      detail: `a parameter declared \`in: ${where}\`, which is not one of path/query/header/cookie/body`,
    });
    return { bound: null, gaps };
  }

  /*
   * `required` is three-state and the null matters. OpenAPI defaults it to
   * false for everything except a path parameter, and treating that default as
   * a declaration is how "this field is optional" gets asserted about a field
   * the author simply never annotated. A PATH parameter is the one case where
   * the specification makes it mandatory, so `true` there is the document
   * speaking and not us guessing.
   */
  const required =
    typeof parameter.required === 'boolean'
      ? parameter.required
      : location === 'PATH'
        ? true
        : null;

  // Swagger 2.0 keeps the keywords on the parameter; 3.x nests them.
  const nested = parameter.schema;
  if (nested !== undefined) {
    const schema = resolveRef(document, nested, `${pointer}/schema`, depthLimit);
    if (schema.gap) gaps.push(schema.gap);
    if (!isRecord(schema.value)) {
      // Unreadable schema: the bounds stay ABSENT, with the gap above saying why.
      return { bound: { name, location, required, type: null }, gaps };
    }
    const composition = composedBy(schema.value);
    if (composition !== null) {
      gaps.push({
        kind: 'COMPOSED_SCHEMA_NOT_READ',
        pointer: `${pointer}/schema`,
        detail:
          `\`${name}\` is declared with \`${composition}\`; this reader does not compose schemas, ` +
          'so its bounds are absent rather than stated as none',
      });
      return { bound: { name, location, required, type: null }, gaps };
    }
    return { bound: { name, location, required, ...boundsFromSchema(schema.value) }, gaps };
  }

  return { bound: { name, location, required, ...boundsFromSchema(parameter) }, gaps };
}

/**
 * The top-level properties of a request body, as BODY-located bounds.
 *
 * Only the top level, stated rather than hidden: a nested object's properties
 * are reachable and are not flattened, because `a.b.c` is not a parameter name
 * any request builder here would know what to do with. The body schema itself
 * is kept whole on `requestShape`, so nothing is lost — the bounds are the
 * subset `boundaryEdges` can act on.
 */
function bodyBounds(
  document: Record<string, unknown>,
  schemaNode: unknown,
  pointer: string,
  depthLimit: number,
): { bounds: ApiParameterBound[]; shape: unknown; gaps: ApiIngestGap[] } {
  const gaps: ApiIngestGap[] = [];
  const resolved = resolveRef(document, schemaNode, pointer, depthLimit);
  if (resolved.gap) gaps.push(resolved.gap);
  if (!isRecord(resolved.value)) return { bounds: [], shape: null, gaps };
  const schema = resolved.value;

  const composition = composedBy(schema);
  if (composition !== null) {
    gaps.push({
      kind: 'COMPOSED_SCHEMA_NOT_READ',
      pointer,
      detail:
        `the request body is declared with \`${composition}\`; its property bounds are absent ` +
        'rather than stated as none, and the whole schema is kept on `requestShape`',
    });
    return { bounds: [], shape: schema, gaps };
  }

  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (properties === null) {
    gaps.push({
      kind: 'BODY_PROPERTIES_NOT_NAMED',
      pointer,
      detail:
        'the request body schema names no properties, so there are no per-field bounds to take; ' +
        'the schema itself is kept on `requestShape`',
    });
    return { bounds: [], shape: schema, gaps };
  }

  const requiredNames = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  /*
   * `schema.required` ABSENT and `schema.required: []` are both "no property is
   * required", and that is one fact, so both produce `required: false`. The
   * state this does NOT produce is null, because we read the schema: a body
   * schema that lists no required properties has declared that none are.
   */
  const bounds: ApiParameterBound[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const propertyPointer = `${pointer}/properties/${pointerSegment(name)}`;
    const property = resolveRef(document, raw, propertyPointer, depthLimit);
    if (property.gap) gaps.push(property.gap);
    if (!isRecord(property.value)) {
      bounds.push({ name, location: 'BODY', required: requiredNames.has(name), type: null });
      continue;
    }
    const propertyComposition = composedBy(property.value);
    if (propertyComposition !== null) {
      gaps.push({
        kind: 'COMPOSED_SCHEMA_NOT_READ',
        pointer: propertyPointer,
        detail:
          `\`${name}\` is declared with \`${propertyComposition}\`; its bounds are absent ` +
          'rather than stated as none',
      });
      bounds.push({ name, location: 'BODY', required: requiredNames.has(name), type: null });
      continue;
    }
    /*
     * A nested object or array is a real surface whose children we do not
     * descend into. Said out loud, because the bound we DO push carries
     * `minimum: null`, `maxLength: null` and so on — which reads as "this
     * field's declaration states no limits" when the truth is that the limits
     * live one level down and nobody looked.
     */
    const declaredType = asString(property.value.type);
    const hasChildren =
      isRecord(property.value.properties) || property.value.items !== undefined;
    if (hasChildren || declaredType === 'object' || declaredType === 'array') {
      gaps.push({
        kind: 'NESTED_SHAPE_NOT_DESCENDED',
        pointer: propertyPointer,
        detail:
          `\`${name}\` is ${declaredType ?? 'a nested shape'}; its own bounds are read and its ` +
          "children's are NOT, so any constraint declared inside it is absent from this " +
          'operation rather than stated as none. The whole schema is kept on `requestShape`',
      });
    }
    bounds.push({
      name,
      location: 'BODY',
      required: requiredNames.has(name),
      ...boundsFromSchema(property.value),
    });
  }

  return { bounds, shape: schema, gaps };
}

/** Media types a body's bounds are taken from. Everything else is a named gap. */
const BOUNDED_BODY_MEDIA_TYPES = [
  'application/json',
  'application/problem+json',
  'application/x-www-form-urlencoded',
] as const;

function boundableMediaType(mediaType: string): boolean {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    BOUNDED_BODY_MEDIA_TYPES.some((known) => known === base) ||
    base.endsWith('+json')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. DECLARED AUTH — THE FIVE-VALUED ANSWER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads one operation's declared auth out of a `security` array.
 *
 * ── THE FOUR CASES, AND THE ONE EVERY PARSER GETS WRONG ─────────────────────
 *
 *   security absent         → inherit the document's global default
 *   security: []            → NONE. The operation explicitly opts out.
 *   security: [{}, {...}]   → OPTIONAL. An empty REQUIREMENT OBJECT inside the
 *                             array declares anonymous access legal alongside
 *                             the authenticated alternative. This is the one
 *                             that gets read as REQUIRED, and the cost of
 *                             getting it wrong is a negative-auth test that is
 *                             never generated for an endpoint that really is
 *                             open to the internet.
 *   security: [{ oauth: [] }] → REQUIRED. The empty ARRAY there is the scope
 *                             list, not an empty requirement; `{ oauth: [] }`
 *                             means "oauth, no particular scope".
 *
 * Returns null when `security` is absent, so the caller can tell "the operation
 * is silent" from "the operation declared none" and apply the global default to
 * the first without erasing the second.
 */
function authFromSecurity(security: unknown): ApiAuthDeclaration | null {
  if (!Array.isArray(security)) return null;
  if (security.length === 0) return 'NONE';
  const hasEmptyRequirement = security.some(
    (entry) => isRecord(entry) && Object.keys(entry).length === 0,
  );
  const hasNamedRequirement = security.some(
    (entry) => isRecord(entry) && Object.keys(entry).length > 0,
  );
  if (hasEmptyRequirement && hasNamedRequirement) return 'OPTIONAL';
  if (hasEmptyRequirement) return 'NONE';
  return 'REQUIRED';
}

/** Every security scheme name an operation's `security` array mentions. */
function securitySchemeNames(security: unknown): string[] {
  if (!Array.isArray(security)) return [];
  const names: string[] = [];
  for (const entry of security) {
    if (!isRecord(entry)) continue;
    names.push(...Object.keys(entry));
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE INGEST
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiDocumentIngestInput {
  /** An already-decoded document. See {@link API_DOCUMENT_KINDS} NOT_JSON. */
  document: unknown;
  /**
   * Which document this is: a URL, or a repo-relative path. Goes verbatim onto
   * every operation's `sourceDocument`, because an operation with no provenance
   * cannot be re-read, re-diffed or disputed.
   */
  sourceDocument: string;
  caps?: Partial<ApiSurfaceCaps>;
}

export interface ApiDocumentIngest {
  kind: ApiDocumentKind;
  /** The version the document claims, verbatim. Null when it claims none. */
  version: string | null;
  /** Operations in document order, each already through `apiOperationSchema`. */
  operations: ApiOperationInput[];
  gaps: ApiIngestGap[];
  caps: ApiSurfaceCapBite[];
  availability: Record<ApiSurfaceAxis, ApiSurfaceAxisState>;
  /**
   * What a reader must know before trusting any number derived from this.
   * Never empty by default — a silent ingest is an overconfident one.
   */
  caveats: string[];
}

/** Verbs a path item may carry. `trace` included; `parameters` is not a verb. */
const PATH_ITEM_VERBS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

/**
 * Parses one API document into operations with their bounds and declared auth.
 *
 * ── WHAT "HANDLED BOTH" MEANS, EXACTLY ──────────────────────────────────────
 *
 * OpenAPI 3.x and Swagger 2.0 differ in three places and all three are read:
 *
 *   bodies    3.x: `requestBody.content[mediaType].schema`
 *             2.0: a `parameters` entry with `in: body` and a `schema`, or
 *                  several with `in: formData`
 *   schemas   3.x: `components.schemas`, parameters nest a `schema`
 *             2.0: `definitions`, parameters carry the keywords inline
 *   auth      3.x: `components.securitySchemes`
 *             2.0: `securityDefinitions`
 *
 * AsyncAPI is read for its HTTP-bound channels only, and every channel that is
 * not HTTP is reported as a CHANNEL_NOT_HTTP gap rather than filed as an
 * operation with no method. A Kafka topic is a real surface that belongs on
 * `BackgroundSurfaceFact`, and `UNKNOWN /orders.created` in a table keyed on
 * `(method, pathTemplate)` would be a row about a thing that has neither.
 *
 * Postman is read for its requests. A collection is the only one of the four
 * that is a record of what somebody CALLED rather than what the server
 * declares, so its operations carry `authDeclaration: 'NOT_READ'` — a
 * collection with no auth header is not a server declaring the endpoint public.
 */
export function ingestApiDocument(input: ApiDocumentIngestInput): ApiDocumentIngest {
  const caps = { ...DEFAULT_API_SURFACE_CAPS, ...input.caps };
  const detected = detectApiDocumentKind(input.document);
  const gaps: ApiIngestGap[] = [];
  const ledger = new CapLedger();

  if (!isRecord(input.document)) {
    return unreadableIngest(detected, `${detected.detail}; nothing was parsed`);
  }
  if (detected.kind === 'UNRECOGNISED') {
    return unreadableIngest(detected, detected.detail);
  }

  const document = input.document;
  const emitted: ApiOperationInput[] = [];
  let parameterCount = 0;
  let bodyCount = 0;
  let responseCount = 0;

  const emit = (operation: ApiOperationInput, scope: string): void => {
    if (emitted.length >= caps.operationBudget) {
      ledger.bite('OPERATION_BUDGET', caps.operationBudget, scope, 1);
      return;
    }
    emitted.push(operation);
  };

  switch (detected.kind) {
    case 'OPENAPI_3':
    case 'SWAGGER_2': {
      const swagger = detected.kind === 'SWAGGER_2';
      const globalAuth = authFromSecurity(document.security);
      const schemeNames = new Set(
        Object.keys(
          (swagger
            ? isRecord(document.securityDefinitions)
              ? document.securityDefinitions
              : {}
            : isRecord(document.components) && isRecord(document.components.securitySchemes)
              ? document.components.securitySchemes
              : {}) as Record<string, unknown>,
        ),
      );

      const paths = isRecord(document.paths) ? document.paths : null;
      if (paths === null) {
        gaps.push({
          kind: 'PATH_ITEM_UNREADABLE',
          pointer: '/paths',
          detail: 'the document has no `paths` object, so no operation could be read from it',
        });
        break;
      }

      for (const [template, rawItem] of Object.entries(paths)) {
        const itemPointer = `/paths/${pointerSegment(template)}`;
        if (!template.startsWith('/')) {
          gaps.push({
            kind: 'NOT_AN_OPERATION',
            pointer: itemPointer,
            detail: `\`${template}\` is not a path (a path template must start with "/")`,
          });
          continue;
        }
        const item = resolveRef(document, rawItem, itemPointer, caps.refDepth);
        if (item.gap) gaps.push(item.gap);
        if (!isRecord(item.value)) {
          gaps.push({
            kind: 'PATH_ITEM_UNREADABLE',
            pointer: itemPointer,
            detail: 'the path item is not an object, so its verbs could not be read',
          });
          continue;
        }

        // Path-level parameters apply to every verb under the item.
        const sharedBounds: ApiParameterBound[] = [];
        if (Array.isArray(item.value.parameters)) {
          item.value.parameters.forEach((raw, index) => {
            const result = parameterBound(
              document,
              raw,
              `${itemPointer}/parameters/${index}`,
              caps.refDepth,
            );
            gaps.push(...result.gaps);
            if (result.bound) sharedBounds.push(result.bound);
          });
        }

        let verbsRead = 0;
        for (const verb of PATH_ITEM_VERBS) {
          const rawOperation = item.value[verb];
          if (!isRecord(rawOperation)) continue;
          verbsRead += 1;
          const pointer = `${itemPointer}/${verb}`;
          const method = verb.toUpperCase() as ApiOperationMethod;

          const bounds = [...sharedBounds];
          if (Array.isArray(rawOperation.parameters)) {
            rawOperation.parameters.forEach((raw, index) => {
              const result = parameterBound(
                document,
                raw,
                `${pointer}/parameters/${index}`,
                caps.refDepth,
              );
              gaps.push(...result.gaps);
              if (!result.bound) return;
              /*
               * An operation-level parameter with the same name and location as
               * a path-level one REPLACES it, per both specifications. A naive
               * concatenation yields two bounds for one parameter, and
               * `boundaryEdges` would then generate two contradictory negative
               * tests for the same field — one from each declaration.
               */
              const existing = bounds.findIndex(
                (bound) =>
                  bound.name === result.bound?.name && bound.location === result.bound.location,
              );
              if (existing >= 0) bounds.splice(existing, 1, result.bound);
              else bounds.push(result.bound);
            });
          }

          // ── Bodies: the one place the two formats diverge most ───────────
          let requestShape: unknown = null;
          if (swagger) {
            /*
             * Swagger 2.0 has already given us the body: it arrives as a
             * `parameters` entry with `in: body`, which `parameterBound` placed
             * at BODY. What it did NOT do is expand that entry's schema into
             * per-property bounds, so do that here and replace the single
             * opaque BODY bound with the properties it stands for.
             */
            const bodyIndex = Array.isArray(rawOperation.parameters)
              ? rawOperation.parameters.findIndex(
                  (raw) => isRecord(raw) && asString(raw.in) === 'body',
                )
              : -1;
            if (bodyIndex >= 0) {
              const rawBody = (rawOperation.parameters as unknown[])[bodyIndex];
              const schemaNode = isRecord(rawBody) ? rawBody.schema : undefined;
              const body = bodyBounds(
                document,
                schemaNode,
                `${pointer}/parameters/${bodyIndex}/schema`,
                caps.refDepth,
              );
              gaps.push(...body.gaps);
              requestShape = body.shape;
              if (body.shape !== null) bodyCount += 1;
              const opaque = bounds.findIndex(
                (bound) =>
                  bound.location === 'BODY' &&
                  bound.name === (isRecord(rawBody) ? asString(rawBody.name) : null),
              );
              if (opaque >= 0) bounds.splice(opaque, 1);
              bounds.push(...body.bounds);
            }
          } else {
            const requestBody = resolveRef(
              document,
              rawOperation.requestBody,
              `${pointer}/requestBody`,
              caps.refDepth,
            );
            if (requestBody.gap) gaps.push(requestBody.gap);
            if (isRecord(requestBody.value)) {
              bodyCount += 1;
              const content = isRecord(requestBody.value.content)
                ? requestBody.value.content
                : null;
              const bodyRequired =
                typeof requestBody.value.required === 'boolean'
                  ? requestBody.value.required
                  : false;
              if (content === null) {
                gaps.push({
                  kind: 'BODY_PROPERTIES_NOT_NAMED',
                  pointer: `${pointer}/requestBody`,
                  detail: 'the request body declares no `content`, so no media type could be read',
                });
              } else {
                const chosen = Object.keys(content).find(boundableMediaType);
                if (chosen === undefined) {
                  gaps.push({
                    kind: 'BODY_MEDIA_TYPE_NOT_READ',
                    pointer: `${pointer}/requestBody/content`,
                    detail:
                      `the body is declared only as ${Object.keys(content).join(', ')}; ` +
                      'this reader takes bounds from JSON and form-encoded bodies, so these ' +
                      'bounds are absent rather than stated as none',
                  });
                } else {
                  const mediaObject = content[chosen];
                  const body = bodyBounds(
                    document,
                    isRecord(mediaObject) ? mediaObject.schema : undefined,
                    `${pointer}/requestBody/content/${pointerSegment(chosen)}/schema`,
                    caps.refDepth,
                  );
                  gaps.push(...body.gaps);
                  requestShape = body.shape;
                  /*
                   * A body-level `required: false` overrides the schema's own
                   * per-property requirement: a property that is required
                   * INSIDE an optional body is only required once the body is
                   * sent. Asserting "this field is required" of a field in a
                   * body nobody has to send is a negative test that fails
                   * against a correct application.
                   */
                  bounds.push(
                    ...body.bounds.map((bound) =>
                      bodyRequired ? bound : { ...bound, required: false },
                    ),
                  );
                }
              }
            }
          }

          // ── Declared auth ────────────────────────────────────────────────
          const operationAuth = authFromSecurity(rawOperation.security);
          const declaration: ApiAuthDeclaration =
            operationAuth ??
            globalAuth ??
            /*
             * Neither the operation nor the document said anything. UNSTATED
             * and not NONE: the document is silent, which is a fact about the
             * document, and NOT_READ would be a lie in the other direction
             * because we did read one.
             */
            'UNSTATED';
          for (const name of securitySchemeNames(rawOperation.security ?? document.security)) {
            if (!schemeNames.has(name)) {
              gaps.push({
                kind: 'SECURITY_SCHEME_UNDEFINED',
                pointer: `${pointer}/security`,
                detail:
                  `the operation requires \`${name}\`, which this document never defines; ` +
                  'the requirement counts, and no credential can be built for it',
              });
            }
          }

          const responses = isRecord(rawOperation.responses) ? rawOperation.responses : null;
          if (responses !== null) responseCount += 1;
          parameterCount += bounds.length;

          emit(
            apiOperationSchema.parse({
              method,
              pathTemplate: template,
              operationId: asString(rawOperation.operationId),
              sourceDocument: input.sourceDocument,
              authDeclaration: declaration,
              parameters: bounds,
              requestShape,
              responseShapes: responses,
              evidence:
                `${API_DOCUMENT_KIND_LABELS[detected.kind]} at ${input.sourceDocument} declares ` +
                `${method} ${template} with ${bounds.length} parameter(s); auth: ${declaration}`,
            } satisfies ApiOperationInput),
            `${method} ${template}`,
          );
        }

        if (verbsRead === 0) {
          gaps.push({
            kind: 'PATH_ITEM_UNREADABLE',
            pointer: itemPointer,
            detail: 'the path item declares no readable verb',
          });
        }
      }
      break;
    }

    case 'ASYNCAPI': {
      /*
       * AsyncAPI 2.x hangs `subscribe`/`publish` off each channel; 3.x moves
       * them into a top-level `operations` map that points back at a channel.
       * Both are read, and in both the only channels that become an
       * `ApiOperation` are the ones whose bindings say HTTP — because those are
       * the only ones that HAVE a method and a path.
       *
       * ── WHERE THE METHOD ACTUALLY LIVES, AND THE DEFECT OF ASSUMING ────────
       *
       * The HTTP bindings specification puts `method` on the OPERATION binding
       * and reserves the channel binding object for future use with no
       * properties at all. So a spec-conformant document carries it at
       * `channels.X.publish.bindings.http.method` (2.x) or
       * `operations.Y.bindings.http.method` pointing at `channels/X` (3.x), and
       * a reader that looked only at `channels.X.bindings.http` found nothing
       * on every correct document — filing each HTTP channel as a
       * CHANNEL_NOT_HTTP gap and dropping a real, routed, testable surface out
       * of the denominator. The channel's own binding is still read FIRST,
       * because plenty of hand-written documents put it there and a reader that
       * refused them would be right about the spec and wrong about the world.
       */
      const channels = isRecord(document.channels) ? document.channels : {};
      /**
       * The operation-level HTTP bindings for one channel, by channel name.
       *
       * Built before the channel walk so a 3.x `operations` map — which points
       * AT a channel through a `$ref` rather than being nested in it — can be
       * read without a second pass over the channels.
       */
      const operationHttp = new Map<string, Record<string, unknown>>();
      const noteOperationHttp = (channelName: string, rawOperation: unknown): void => {
        if (!isRecord(rawOperation)) return;
        const bindings = isRecord(rawOperation.bindings) ? rawOperation.bindings : null;
        const http = bindings !== null && isRecord(bindings.http) ? bindings.http : null;
        if (http === null) return;
        // First declaration wins: a channel with both a publish and a subscribe
        // HTTP binding is one path, and the second would silently replace the
        // first with no record that the document declared two.
        if (!operationHttp.has(channelName)) operationHttp.set(channelName, http);
      };
      // 2.x: the operation is nested in its channel.
      for (const [name, rawChannel] of Object.entries(channels)) {
        if (!isRecord(rawChannel)) continue;
        noteOperationHttp(name, rawChannel.publish);
        noteOperationHttp(name, rawChannel.subscribe);
      }
      // 3.x: the operation is top-level and names its channel by $ref.
      if (isRecord(document.operations)) {
        for (const [operationName, rawOperation] of Object.entries(document.operations)) {
          if (!isRecord(rawOperation)) continue;
          const ref = isRecord(rawOperation.channel) ? asString(rawOperation.channel.$ref) : null;
          /*
           * `#/channels/<name>` is the only form that names a channel in THIS
           * document. A ref into another file is not followed here for the same
           * reason no other remote ref is, and the gap says so rather than the
           * operation being guessed at.
           */
          const match = ref === null ? null : /^#\/channels\/(.+)$/.exec(ref);
          const channelName = match?.[1] === undefined ? null : decodeURIComponent(
            match[1].replace(/~1/g, '/').replace(/~0/g, '~'),
          );
          if (channelName === null) {
            if (ref !== null && isRecord(rawOperation.bindings)) {
              gaps.push({
                kind: 'REMOTE_REF_NOT_FOLLOWED',
                pointer: `/operations/${pointerSegment(operationName)}/channel`,
                detail:
                  `the operation points at \`${ref}\`, which is not a channel in this document; ` +
                  'its HTTP binding could not be attached to a path and the channel it names is ' +
                  'absent from these operations rather than absent from the API',
              });
            }
            continue;
          }
          noteOperationHttp(channelName, rawOperation);
        }
      }
      for (const [name, rawChannel] of Object.entries(channels)) {
        const pointer = `/channels/${pointerSegment(name)}`;
        const channel = resolveRef(document, rawChannel, pointer, caps.refDepth);
        if (channel.gap) gaps.push(channel.gap);
        if (!isRecord(channel.value)) {
          gaps.push({
            kind: 'PATH_ITEM_UNREADABLE',
            pointer,
            detail: 'the channel is not an object, so nothing could be read from it',
          });
          continue;
        }
        const bindings = isRecord(channel.value.bindings) ? channel.value.bindings : null;
        const channelHttp = bindings !== null && isRecord(bindings.http) ? bindings.http : null;
        // The channel's own binding first, then the operation's — which is
        // where the specification actually puts `method`. See the note above.
        const http = channelHttp ?? operationHttp.get(name) ?? null;
        if (http === null) {
          gaps.push({
            kind: 'CHANNEL_NOT_HTTP',
            pointer,
            detail:
              `\`${name}\` has no HTTP binding on the channel or on either of its operations, so ` +
              'it has neither a method nor a path; it is a real surface and belongs on the ' +
              'background-surface inventory, not in this table',
          });
          continue;
        }
        const method = (asString(http.method) ?? 'UNKNOWN').toUpperCase();
        const resolvedMethod = (
          API_OPERATION_METHODS as readonly string[]
        ).includes(method)
          ? (method as ApiOperationMethod)
          : 'UNKNOWN';
        const address = asString(channel.value.address) ?? name;
        const template = address.startsWith('/') ? address : `/${address}`;
        parameterCount += 0;
        emit(
          apiOperationSchema.parse({
            method: resolvedMethod,
            pathTemplate: template,
            operationId: asString(channel.value.title),
            sourceDocument: input.sourceDocument,
            /*
             * An AsyncAPI channel's `security` lives on the SERVER, not the
             * channel, so a channel is silent about auth by construction.
             * UNSTATED says that; NONE would claim the document declared the
             * channel public.
             */
            authDeclaration: 'UNSTATED',
            parameters: [],
            requestShape: null,
            responseShapes: null,
            evidence:
              `an AsyncAPI document at ${input.sourceDocument} binds channel \`${name}\` to ` +
              `${resolvedMethod} ${template}`,
          } satisfies ApiOperationInput),
          template,
        );
      }
      break;
    }

    case 'POSTMAN': {
      const walk = (items: unknown, trail: readonly string[], pointer: string): void => {
        if (!Array.isArray(items)) return;
        items.forEach((raw, index) => {
          const itemPointer = `${pointer}/${index}`;
          if (!isRecord(raw)) return;
          const name = asString(raw.name);
          if (Array.isArray(raw.item)) {
            walk(raw.item, [...trail, name ?? 'group'], `${itemPointer}/item`);
            return;
          }
          const request = isRecord(raw.request) ? raw.request : null;
          if (request === null) {
            gaps.push({
              kind: 'NOT_AN_OPERATION',
              pointer: itemPointer,
              detail: `\`${name ?? 'an item'}\` is neither a folder nor a request`,
            });
            return;
          }
          const rawMethod = (asString(request.method) ?? 'GET').toUpperCase();
          const method = (API_OPERATION_METHODS as readonly string[]).includes(rawMethod)
            ? (rawMethod as ApiOperationMethod)
            : 'UNKNOWN';
          const rawUrl =
            typeof request.url === 'string'
              ? request.url
              : isRecord(request.url)
                ? asString(request.url.raw)
                : null;
          const template = postmanRequestTemplate(rawUrl);
          emit(
            apiOperationSchema.parse({
              method,
              pathTemplate: template,
              operationId: name,
              sourceDocument: input.sourceDocument,
              /*
               * A collection records what a human CALLED. The absence of an
               * Authorization header in a saved request is not a server
               * declaring the endpoint public, so NOT_READ — our silence, which
               * is what it is.
               */
              authDeclaration: 'NOT_READ',
              parameters: [],
              requestShape: null,
              responseShapes: null,
              evidence:
                `a Postman collection at ${input.sourceDocument} contains ` +
                `${[...trail, name ?? `${method} ${template}`].filter(Boolean).join(' / ')}`,
            } satisfies ApiOperationInput),
            `${method} ${template}`,
          );
        });
      };
      walk(document.item, [], '/item');
      break;
    }

    /*
     * NOT_JSON is unreachable here — the `isRecord` guard above returned for
     * it — and the case is kept so the switch stays EXHAUSTIVE over
     * `ApiDocumentKind`. UNRECOGNISED is deliberately absent for the same
     * reason in reverse: it also returns early, and TypeScript rejects a case
     * for a member the narrowing has already removed, which is exactly the
     * compile error that catches a future member added with no branch.
     */
    case 'NOT_JSON':
      break;
  }

  // ── Availability, per axis ───────────────────────────────────────────────
  const documentary = detected.kind === 'OPENAPI_3' || detected.kind === 'SWAGGER_2';
  const availability: Record<ApiSurfaceAxis, ApiSurfaceAxisState> = {
    OPERATIONS: axisMeasured(emitted.length),
    PARAMETERS: documentary
      ? axisMeasured(parameterCount)
      : axisUnavailable(
          `${API_DOCUMENT_KIND_LABELS[detected.kind]} declares no parameter bounds this reader ` +
            'takes, so the absence of bounds here is ours and not the API\'s',
        ),
    AUTH: documentary
      ? axisMeasured(emitted.filter((operation) => operation.authDeclaration !== 'UNSTATED').length)
      : axisUnavailable(
          `${API_DOCUMENT_KIND_LABELS[detected.kind]} does not declare per-operation security`,
        ),
    REQUEST_BODIES: documentary
      ? axisMeasured(bodyCount)
      : axisUnavailable(
          `${API_DOCUMENT_KIND_LABELS[detected.kind]} was not read for request bodies`,
        ),
    RESPONSES: documentary
      ? axisMeasured(responseCount)
      : axisUnavailable(
          `${API_DOCUMENT_KIND_LABELS[detected.kind]} was not read for declared responses`,
        ),
  };

  const caveats: string[] = [];
  if (emitted.length === 0) {
    caveats.push(
      `no operation was read from ${input.sourceDocument}; this is a fact about the document ` +
        'and never evidence that the API has none',
    );
  }
  const remote = gaps.filter((gap) => gap.kind === 'REMOTE_REF_NOT_FOLLOWED').length;
  if (remote > 0) {
    caveats.push(
      `${remote} $ref(s) point into another document and were not followed; the bounds they ` +
        'declare are absent from these operations, not absent from the API',
    );
  }
  const composed = gaps.filter((gap) => gap.kind === 'COMPOSED_SCHEMA_NOT_READ').length;
  if (composed > 0) {
    caveats.push(
      `${composed} schema(s) are built with allOf/oneOf/anyOf and were not composed; their ` +
        'bounds are absent rather than stated as none',
    );
  }
  const channels = gaps.filter((gap) => gap.kind === 'CHANNEL_NOT_HTTP').length;
  if (channels > 0) {
    caveats.push(
      `${channels} AsyncAPI channel(s) are not HTTP; they are real surfaces and belong on the ` +
        'background-surface inventory rather than in the operation table',
    );
  }
  const nested = gaps.filter((gap) => gap.kind === 'NESTED_SHAPE_NOT_DESCENDED').length;
  if (nested > 0) {
    caveats.push(
      `${nested} body propert(ies) are nested objects or arrays this reader did not descend ` +
        'into; constraints declared inside them are absent from these operations, not absent ' +
        'from the API',
    );
  }
  const unstated = emitted.filter((operation) => operation.authDeclaration === 'UNSTATED').length;
  if (unstated > 0) {
    caveats.push(
      `${unstated} operation(s) are silent about authentication; a 401 from any of them proves ` +
        'nothing, so no negative-auth assertion may be generated from them',
    );
  }

  return {
    kind: detected.kind,
    version: detected.version,
    operations: emitted,
    gaps,
    caps: ledger.bites(
      (cap, discarded) =>
        `${API_SURFACE_CAP_LABELS[cap]} stopped ${discarded} operation(s) from ` +
        `${input.sourceDocument}; at least that many more are declared`,
    ),
    availability,
    caveats,
  };
}

/** An ingest that read nothing, with every axis honestly unavailable. */
function unreadableIngest(
  detected: { kind: ApiDocumentKind; version: string | null; detail: string },
  reason: string,
): ApiDocumentIngest {
  const availability = {} as Record<ApiSurfaceAxis, ApiSurfaceAxisState>;
  for (const axis of API_SURFACE_AXES) availability[axis] = axisUnavailable(reason);
  return {
    kind: detected.kind,
    version: detected.version,
    operations: [],
    gaps: [],
    caps: [],
    availability,
    caveats: [
      `nothing was read: ${reason}. Zero operations here is OUR silence and must never be ` +
        'rendered as an API with no operations',
    ],
  };
}

/**
 * The path (and query) a Postman request addresses.
 *
 * ── WHY THIS LIVES HERE AND `importer.ts` CALLS IT ──────────────────────────
 *
 * It was `extractPath`, private to `importer.ts`, where it had the two things a
 * naive version gets wrong already argued out in its comments. Enumeration
 * needs the same answer, and two implementations of "which path does this
 * request address" would eventually disagree — at which point the migration
 * wedge and the denominator would be describing different endpoints from one
 * collection. It moved to the lower-level module rather than being copied, and
 * `importer.ts` now imports it: this file holds no model and no SDK, so the
 * edge runs the cheap way round.
 *
 * The two mistakes it exists to avoid, preserved verbatim from where it lived:
 *  - A leading `{{baseUrl}}` maps to the environment's base URL and is stripped.
 *  - But a `{{var}}` INSIDE the path (`/users/{{userId}}`) is a real template
 *    variable the QAAI API runner interpolates, so it is preserved verbatim.
 *    Replacing every `{{var}}` to force the string through `new URL()` baked
 *    the placeholder scheme into the middle of the path — the earlier bug.
 */
export function postmanRequestPath(raw: string | undefined): string {
  if (!raw) return '/';

  // Drop a single leading base-URL variable, e.g. `{{baseUrl}}`.
  let rest = raw.replace(/^\s*\{\{[^}]+\}\}/, '');

  // If what remains still starts with a real scheme+host, parse that off —
  // mid-path `{{var}}` tokens survive because they are never at the front.
  if (/^https?:\/\//i.test(rest)) {
    try {
      const url = new URL(rest);
      rest = url.pathname + url.search;
    } catch {
      /* fall through to the string handling below */
    }
  }

  if (!rest) return '/';
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/**
 * The same path as a PATH TEMPLATE, which is what the operation table stores.
 *
 * Two transforms on top of {@link postmanRequestPath}, and both are about
 * identity rather than tidiness: the query string is dropped because
 * `ApiOperation` is keyed on `(method, pathTemplate)` and `/orders?page=2`
 * would otherwise be a second operation, and `{{userId}}` becomes `{userId}`
 * so a collection and an OpenAPI document that declare the same endpoint land
 * on the same key instead of doubling the denominator.
 */
export function postmanRequestTemplate(raw: string | null | undefined): string {
  const path = postmanRequestPath(raw ?? undefined);
  const withoutQuery = path.split('?')[0] ?? path;
  const template = withoutQuery.replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => `{${name}}`);
  return template.length > 0 ? template : '/';
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. THE GRAPHQL INTROSPECTION WALK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The introspection document this module sends.
 *
 * Hand-written rather than taken from `graphql-js`, for the reason rule 8 of
 * this slice states: a vendor SDK at the top of a module is an untestable
 * dependency, and this is a string. Seven levels of `ofType` because that is
 * what `[[Int!]!]!` needs and a six-level unwrap silently reports the innermost
 * type as null — which would read as "this argument has no type".
 *
 * `includeDeprecated: true` on fields and `args`, deliberately: a deprecated
 * mutation is still a surface a customer's clients still call, and leaving it
 * out would shrink the denominator by exactly the operations most likely to be
 * broken.
 */
export const GRAPHQL_INTROSPECTION_DOCUMENT = `query QaaiIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        args { ...InputValue }
        type { ...TypeRef }
      }
      inputFields(includeDeprecated: true) { ...InputValue }
      enumValues(includeDeprecated: true) { name }
    }
  }
}
fragment InputValue on __InputValue {
  name
  defaultValue
  type { ...TypeRef }
}
fragment TypeRef on __Type {
  kind name ofType {
    kind name ofType {
      kind name ofType {
        kind name ofType {
          kind name ofType {
            kind name ofType {
              kind name ofType {
                kind name
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * What we know about the schema after trying to read it.
 *
 * INTROSPECTION_REFUSED is the member this whole item turns on. Introspection
 * is switched OFF in most production deployments — it is a hardening decision,
 * not a fault — and the two sentences "introspection is disabled, so we do not
 * know how many operations this API has" and "this API has no operations" are
 * opposite claims. Reporting the second would hand a customer a denominator of
 * zero and a coverage percentage of 100.
 */
export const GRAPHQL_SCHEMA_STATES = [
  /** A schema came back and was walked. */
  'MEASURED',
  /** The server answered and refused to introspect. UNKNOWN, not empty. */
  'INTROSPECTION_REFUSED',
  /** Nothing answered: connection refused, DNS, timeout. */
  'NO_ANSWER',
  /** Something answered and it was not an introspection result. */
  'UNREADABLE',
  /** No transport was supplied. We did not look. */
  'NOT_ATTEMPTED',
] as const;
export type GraphqlSchemaState = (typeof GRAPHQL_SCHEMA_STATES)[number];

export const GRAPHQL_SCHEMA_STATE_LABELS: Record<GraphqlSchemaState, string> = {
  MEASURED: 'the schema was introspected and walked',
  INTROSPECTION_REFUSED: 'introspection is disabled — the operation count is unknown, not zero',
  NO_ANSWER: 'nothing answered the introspection request',
  UNREADABLE: 'something answered and it was not an introspection result',
  NOT_ATTEMPTED: 'no introspection was attempted',
};

/** The three GraphQL root operation types, which are the three denominators. */
export const GRAPHQL_ROOTS = ['QUERY', 'MUTATION', 'SUBSCRIPTION'] as const;
export type GraphqlRoot = (typeof GRAPHQL_ROOTS)[number];

/**
 * One root field: one GraphQL operation, and one surface.
 *
 * `mutating` is `root === 'MUTATION'` and is carried explicitly rather than
 * re-derived at each call site, because it is the field that decides whether a
 * generated test may drive it at all. A query is safe to send; a mutation
 * against a customer's environment is not.
 */
export interface GraphqlOperation {
  root: GraphqlRoot;
  /** The field name as the schema spells it. */
  field: string;
  /** `Query.orders` — what a report prints and what identity is built from. */
  path: string;
  /** The declared return type, unwrapped to its name. Null when unreadable. */
  returnType: string | null;
  /** True when the return type is non-null at its outermost level. */
  returnNonNull: boolean;
  /** The field's arguments as bounds, so negative cases have numbers to use. */
  arguments: ApiParameterBound[];
  deprecated: boolean;
  mutating: boolean;
  evidence: string;
}

/** One input object type and the constraints its fields declare. */
export interface GraphqlInputType {
  name: string;
  fields: ApiParameterBound[];
}

/** A transport that can POST one GraphQL document. Injected; see rule 8. */
export interface GraphqlTransport {
  post(request: { document: string }): Promise<GraphqlTransportResponse>;
}

export interface GraphqlTransportResponse {
  /** The HTTP status. Null when nothing answered at all. */
  status: number | null;
  /** The decoded response body, or null when there was none. */
  body: unknown;
  /** A transport-level failure. Null on any answer, including a 500. */
  error: string | null;
}

export interface GraphqlSchemaReading {
  state: GraphqlSchemaState;
  /**
   * How many root fields were found. NULL unless `state` is MEASURED.
   *
   * The null is the entire point of this interface. `0` here would be a
   * measurement; under every other state it is our ignorance, and
   * {@link graphqlReadingIsConsistent} asserts the two never mix.
   */
  operationsFound: number | null;
  operations: GraphqlOperation[];
  inputTypes: GraphqlInputType[];
  /** Required unless MEASURED: what stopped the read. */
  reason: string | null;
  gaps: ApiIngestGap[];
  caps: ApiSurfaceCapBite[];
}

/**
 * Whether a reading's own fields agree.
 *
 * Asserted in the tests over every state, so a future contributor who reports
 * `operationsFound: 0` on a refused introspection fails a test rather than
 * shipping a 100% coverage number for a backend nobody measured.
 */
export function graphqlReadingIsConsistent(reading: GraphqlSchemaReading): boolean {
  if (reading.state === 'MEASURED') {
    return (
      reading.operationsFound === reading.operations.length &&
      reading.operationsFound !== null &&
      reading.reason === null
    );
  }
  return (
    reading.operationsFound === null && reading.operations.length === 0 && reading.reason !== null
  );
}

/** Unwraps NON_NULL / LIST wrappers to the named type underneath. */
function unwrapTypeRef(node: unknown): { name: string | null; nonNull: boolean } {
  let current = node;
  let nonNull = false;
  let depth = 0;
  while (isRecord(current) && depth < 12) {
    const kind = asString(current.kind);
    if (depth === 0 && kind === 'NON_NULL') nonNull = true;
    const name = asString(current.name);
    if (name !== null) return { name, nonNull };
    current = current.ofType;
    depth += 1;
  }
  return { name: null, nonNull };
}

/**
 * One `__InputValue` → one bound.
 *
 * ── WHAT GRAPHQL DOES AND DOES NOT TELL US ──────────────────────────────────
 *
 * It tells us the type and whether it is non-null, which is `required`. It
 * tells us the members of an enum, which is `enumValues`. It tells us NOTHING
 * about `minimum`, `maxLength` or `pattern` — GraphQL has no such keywords, and
 * the custom scalars teams use for them (`EmailAddress`, `PositiveInt`) carry
 * their rules in a resolver we cannot see.
 *
 * So those keys are left ABSENT and not null, which is the three-state contract
 * doing its job: `maxLength: null` here would mean "the schema declares no
 * length limit", and the schema declares nothing at all because the language
 * has no way to. A negative test built from a null would post a 10,000
 * character string at a field whose resolver rejects 256, and then report the
 * rejection as a defect.
 */
function graphqlArgumentBound(
  node: unknown,
  enumMembers: ReadonlyMap<string, string[]>,
): ApiParameterBound | null {
  if (!isRecord(node)) return null;
  const name = asString(node.name);
  if (name === null) return null;
  const type = unwrapTypeRef(node.type);
  const members = type.name === null ? undefined : enumMembers.get(type.name);
  return {
    name,
    /*
     * BODY, because a GraphQL argument travels in the POST body's `variables`.
     * QUERY would be wrong in the way that matters: a generator reading QUERY
     * builds `?orderId=1`, which a GraphQL endpoint ignores entirely, and the
     * resulting 200 would be reported as the argument being accepted.
     */
    location: 'BODY',
    required: type.nonNull,
    type: type.name,
    ...(members === undefined ? {} : { enumValues: members }),
  };
}

/**
 * Walks an introspection payload into operations and input types.
 *
 * Pure: takes the decoded response body and returns the reading. The transport
 * is somebody else's problem, which is why every state below — including the
 * refusal — is driven by a literal in the test file rather than by a server.
 */
export function walkIntrospection(
  body: unknown,
  options?: { caps?: Partial<ApiSurfaceCaps> },
): GraphqlSchemaReading {
  const caps = { ...DEFAULT_API_SURFACE_CAPS, ...options?.caps };
  const gaps: ApiIngestGap[] = [];
  const ledger = new CapLedger();

  const envelope = isRecord(body) ? body : null;
  if (envelope === null) {
    return refusedReading('UNREADABLE', 'the response body is not a JSON object');
  }

  /*
   * THE REFUSAL CHECK RUNS FIRST, and before the `data` check, because a server
   * with introspection disabled answers 200 with `{ errors: [...] }` and often
   * with `data: null`. Reading that as "a schema with no types" is the exact
   * defect this item exists to prevent, and it is one `??` away at all times.
   */
  const errors = Array.isArray(envelope.errors) ? envelope.errors : null;
  const schemaNode = isRecord(envelope.data) ? envelope.data.__schema : undefined;
  if (errors !== null && errors.length > 0 && !isRecord(schemaNode)) {
    const messages = errors
      .map((entry) => (isRecord(entry) ? asString(entry.message) : null))
      .filter((message): message is string => message !== null);
    const introspectionWords = /introspect|__schema|disabled|not allowed|forbidden/i;
    const refused = messages.some((message) => introspectionWords.test(message));
    return refusedReading(
      refused ? 'INTROSPECTION_REFUSED' : 'UNREADABLE',
      refused
        ? `the server refused introspection: ${messages.join('; ')}. The operation count is ` +
            'UNKNOWN — this is not an API with no operations'
        : `the server answered with errors and no schema: ${messages.join('; ') || 'no message'}`,
    );
  }
  if (!isRecord(schemaNode)) {
    return refusedReading(
      'UNREADABLE',
      'the response carries no `data.__schema`, so there was no schema to walk',
    );
  }

  const rootNames = new Map<string, GraphqlRoot>();
  for (const [key, root] of [
    ['queryType', 'QUERY'],
    ['mutationType', 'MUTATION'],
    ['subscriptionType', 'SUBSCRIPTION'],
  ] as const) {
    const node = schemaNode[key];
    const name = isRecord(node) ? asString(node.name) : null;
    if (name !== null) rootNames.set(name, root);
  }

  const rawTypes = Array.isArray(schemaNode.types) ? schemaNode.types : [];
  const types: Record<string, unknown>[] = [];
  for (const entry of rawTypes) {
    if (types.length >= caps.introspectionTypeBudget) {
      ledger.bite('INTROSPECTION_TYPE_BUDGET', caps.introspectionTypeBudget, '__schema.types', 1);
      continue;
    }
    if (isRecord(entry)) types.push(entry);
  }

  // Enum members first: an argument's enum is a different type in the list.
  const enumMembers = new Map<string, string[]>();
  for (const type of types) {
    if (asString(type.kind) !== 'ENUM') continue;
    const name = asString(type.name);
    if (name === null) continue;
    const values = Array.isArray(type.enumValues) ? type.enumValues : [];
    enumMembers.set(
      name,
      values
        .map((value) => (isRecord(value) ? asString(value.name) : null))
        .filter((value): value is string => value !== null),
    );
  }

  const operations: GraphqlOperation[] = [];
  const inputTypes: GraphqlInputType[] = [];

  for (const type of types) {
    const typeName = asString(type.name);
    if (typeName === null) continue;

    if (asString(type.kind) === 'INPUT_OBJECT') {
      const rawFields = Array.isArray(type.inputFields) ? type.inputFields : [];
      inputTypes.push({
        name: typeName,
        fields: rawFields
          .map((field) => graphqlArgumentBound(field, enumMembers))
          .filter((bound): bound is ApiParameterBound => bound !== null),
      });
      continue;
    }

    const root = rootNames.get(typeName);
    if (root === undefined) continue;

    const rawFields = Array.isArray(type.fields) ? type.fields : null;
    if (rawFields === null) {
      gaps.push({
        kind: 'PATH_ITEM_UNREADABLE',
        pointer: `/data/__schema/types/${pointerSegment(typeName)}`,
        detail:
          `the schema names \`${typeName}\` as its ${root.toLowerCase()} root and exposes no ` +
          'readable field list for it, so its operations are unknown rather than absent',
      });
      continue;
    }

    for (const rawField of rawFields) {
      if (!isRecord(rawField)) continue;
      const field = asString(rawField.name);
      if (field === null) continue;
      const returned = unwrapTypeRef(rawField.type);
      const args = Array.isArray(rawField.args) ? rawField.args : [];
      operations.push({
        root,
        field,
        path: `${typeName}.${field}`,
        returnType: returned.name,
        returnNonNull: returned.nonNull,
        arguments: args
          .map((argument) => graphqlArgumentBound(argument, enumMembers))
          .filter((bound): bound is ApiParameterBound => bound !== null),
        deprecated: rawField.isDeprecated === true,
        mutating: root === 'MUTATION',
        evidence:
          `GraphQL introspection exposes \`${field}\` on \`${typeName}\` (${root.toLowerCase()}) ` +
          `with ${args.length} argument(s)`,
      });
    }
  }

  return {
    state: 'MEASURED',
    operationsFound: operations.length,
    operations,
    inputTypes,
    reason: null,
    gaps,
    caps: ledger.bites(
      (cap, discarded) =>
        `${API_SURFACE_CAP_LABELS[cap]} stopped ${discarded} type(s) being read; at least that ` +
        'many more types exist in this schema',
    ),
  };
}

function refusedReading(state: GraphqlSchemaState, reason: string): GraphqlSchemaReading {
  return {
    state,
    operationsFound: null,
    operations: [],
    inputTypes: [],
    reason,
    gaps: [],
    caps: [],
  };
}

/**
 * Sends the introspection document and walks what comes back.
 *
 * Thin by design: every decision worth testing is in {@link walkIntrospection},
 * and all this adds is the transport call and the two states only it can
 * observe — NOT_ATTEMPTED when no transport was given, and NO_ANSWER when the
 * transport reports a failure.
 *
 * A non-2xx WITH a readable GraphQL envelope is still walked, because a server
 * that refuses introspection commonly answers 400 with the refusal in
 * `errors`, and treating the status as the answer would record it as
 * UNREADABLE and lose the distinction this item is about.
 */
export async function introspectGraphqlSchema(input: {
  transport: GraphqlTransport | null;
  caps?: Partial<ApiSurfaceCaps>;
}): Promise<GraphqlSchemaReading> {
  if (input.transport === null) {
    return refusedReading(
      'NOT_ATTEMPTED',
      'no GraphQL transport was supplied, so no introspection was attempted',
    );
  }

  let response: GraphqlTransportResponse;
  try {
    response = await input.transport.post({ document: GRAPHQL_INTROSPECTION_DOCUMENT });
  } catch (err) {
    return refusedReading(
      'NO_ANSWER',
      `the introspection request threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.error !== null || response.status === null) {
    return refusedReading(
      'NO_ANSWER',
      response.error ??
        'nothing answered the introspection request, so the operation count is unknown',
    );
  }

  const reading = walkIntrospection(response.body, { caps: input.caps });
  if (reading.state === 'UNREADABLE' && response.status >= 400) {
    return refusedReading(
      'UNREADABLE',
      `the endpoint answered ${response.status} and the body was not an introspection result`,
    );
  }
  return reading;
}

/**
 * The surface-registry identity of one GraphQL root field.
 *
 * ── WHY A GRAPHQL FIELD IS NOT AN `ApiOperation` ROW ────────────────────────
 *
 * `ApiOperation` is keyed `@@unique([projectId, method, pathTemplate])`, and
 * every field of a GraphQL schema is reached by `POST /graphql`. Three hundred
 * queries would collapse into one row — a denominator of 1 for a backend with
 * 440 operations, which is the single worst number this file could produce.
 *
 * So the registry holds them, because `CoverageItem`'s identity is a free-form
 * string: `ENDPOINT:POST /graphql#Query.orders`. The `#` is deliberate and is
 * not a URL fragment — it is the separator that keeps a field name out of the
 * path, so `parseSurfaceKey` still returns a path a human recognises.
 *
 * The ONE `ApiOperation` row that is true about a GraphQL backend is the
 * transport endpoint itself, which {@link graphqlEndpointOperation} builds.
 */
export function graphqlSurfaceIdentity(endpointPath: string, operation: GraphqlOperation): string {
  return surfaceKey('ENDPOINT', `POST ${endpointPath}#${operation.path}`);
}

/**
 * The one HTTP operation a GraphQL backend declares: its transport endpoint.
 *
 * `authDeclaration` is NOT_READ unless the caller knows better, and that is the
 * honest value: introspection says nothing about authentication. A schema that
 * introspects anonymously has told us that INTROSPECTION is open, which is not
 * the same as `orders` being open, and recording NONE here would authorise a
 * negative-auth test against every mutation in the schema.
 */
export function graphqlEndpointOperation(input: {
  endpointPath: string;
  sourceDocument: string;
  reading: GraphqlSchemaReading;
  authDeclaration?: ApiAuthDeclaration;
}): ApiOperationInput {
  const { reading } = input;
  const count = reading.operationsFound;
  return apiOperationSchema.parse({
    method: 'POST',
    pathTemplate: input.endpointPath,
    operationId: null,
    sourceDocument: input.sourceDocument,
    authDeclaration: input.authDeclaration ?? 'NOT_READ',
    parameters: [],
    requestShape: null,
    responseShapes: null,
    evidence:
      count === null
        ? `a GraphQL endpoint at ${input.endpointPath}; ${GRAPHQL_SCHEMA_STATE_LABELS[reading.state]}` +
          ` — the number of operations behind it is unknown (${reading.reason ?? 'no reason recorded'})`
        : `a GraphQL endpoint at ${input.endpointPath} whose schema exposes ${count} root field(s)`,
  } satisfies ApiOperationInput);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. ENDPOINT PROBING
// ─────────────────────────────────────────────────────────────────────────────

/** The verbs a probe may issue with no credential and no permission. */
export const SAFE_PROBE_METHODS: readonly ApiOperationMethod[] = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Why a probe was issued, which decides what its answer means.
 *
 * Separate from `crawl/observe.ts`'s `PROBE_KINDS`: those probe PAGE templates
 * through a browser for the ERROR_STATE axis, these probe API operations for
 * existence, verb and auth. Two vocabularies because the questions differ; the
 * BAD_ID sentinel is imported from there rather than re-decided, so the two
 * modules at least ask the application the same bad-id question.
 */
export const API_PROBE_KINDS = [
  /** The declared verb, anonymously. Does anything answer at all? */
  'DECLARED_ANONYMOUS',
  /** The declared verb with a credential. Only sent after an anonymous refusal. */
  'DECLARED_AUTHENTICATED',
  /** A path parameter replaced with an id that cannot exist. */
  'BAD_ID',
  /** A safe verb the operation does not declare. Reads the `Allow` header. */
  'UNDECLARED_VERB',
] as const;
export type ApiProbeKind = (typeof API_PROBE_KINDS)[number];

export const API_PROBE_KIND_LABELS: Record<ApiProbeKind, string> = {
  DECLARED_ANONYMOUS: 'the declared verb, with no credential',
  DECLARED_AUTHENTICATED: 'the declared verb, with a credential',
  BAD_ID: 'an identifier that cannot exist',
  UNDECLARED_VERB: 'a safe verb the operation does not declare',
};

/** One operation to probe. */
export interface ApiProbeTarget {
  method: ApiOperationMethod;
  /** `/orders/{id}` or `/orders/:id`. Both spellings are handled. */
  pathTemplate: string;
  authDeclaration: ApiAuthDeclaration;
  /** The operation row's id, so probe rows can be attributed. Null before it is written. */
  operationId?: string | null;
  /**
   * Real values for the path parameters, keyed by name, when anything observed
   * some — a crawl, traffic, a seeded fixture.
   *
   * ── WHY THIS FIELD DECIDES WHETHER A BAD-ID PROBE EXISTS AT ALL ───────────
   *
   * `GET /orders/{id}` cannot be sent as written, so SOMETHING has to go in
   * that slot. With no sample the only honest filler is the sentinel, and then
   * the declared probe IS the bad-id probe: issuing a second request to the
   * same URL and reporting it as a separate negative test would be two rows of
   * evidence from one observation. So when a parameter falls back to the
   * sentinel, the bad-id probe is SKIPPED and the caveat says why; when every
   * parameter has a real value, the two requests differ and both are issued.
   */
  sampleValues?: Record<string, string>;
}

export interface ApiProbeRequest {
  method: string;
  /** The absolute URL, already joined to the environment's base. */
  url: string;
  /** Headers to send. A credential, when one is being used, is already in here. */
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface ApiProbeResponse {
  /** The HTTP status. Null when nothing answered. */
  status: number | null;
  /** Response headers, lower-cased keys. `allow` is the one that is read. */
  headers: Record<string, string>;
  /** A transport-level failure. Null on any answer, including a 500. */
  error: string | null;
}

/** A transport that can issue one HTTP request. Injected; see rule 8. */
export interface ApiProbeTransport {
  send(request: ApiProbeRequest): Promise<ApiProbeResponse>;
}

/**
 * A credential to prove an operation really is protected.
 *
 * ── WHY THIS IS A HEADER BAG AND NOT AN ENV VAR ─────────────────────────────
 *
 * Rule 4 of this slice: a connector's credentials belong on a model row the
 * customer owns — the `Integration` pattern, whose `configEnc` is the sealed
 * column — never in `process.env`. This module takes the already-unsealed
 * headers and never learns where they came from, which is also what makes the
 * auth half of a probe testable with a literal.
 */
export interface ApiProbeCredential {
  headers: Record<string, string>;
  /** What it is, for the probe's `detail`. Never the value. */
  label: string;
}

/** A clock, injected so the rate limit is testable without waiting. */
export interface ApiProbeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The real clock. The one adapter in this module, and it is four lines. */
export const SYSTEM_PROBE_CLOCK: ApiProbeClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The findings a probe can produce, as a discriminated union.
 *
 * ── WHY A UNION WITH A ZOD SCHEMA AND A PRESENCE RECORD ─────────────────────
 *
 * Because eight `GateRule` kinds shipped UNSAVEABLE for two slices in this
 * codebase: the union was in one file and the schema in another, nothing in CI
 * can see that class of defect, and a union member with no write path is live
 * code in a reached file. So both halves are here, three lines apart, and
 * `api-surface.test.ts` compares the zod union's own options against
 * {@link API_PROBE_FINDING_KINDS} at run time. A tenth member that forgets its
 * schema entry fails a test; a tenth member that forgets the record fails the
 * compiler.
 *
 * Each member is a DISAGREEMENT between what a document declared and what the
 * application did, which is the only reason to probe at all. None of them is
 * ever "this operation does not exist" — see {@link DECLARED_BUT_NOT_ROUTED}.
 */
export type ApiProbeFinding =
  | {
      /**
       * The document declares anonymous access legal and the application
       * refused. One of the two findings a customer acts on the same day: it is
       * either a documentation defect or a client that is about to break.
       */
      kind: 'DECLARED_PUBLIC_BUT_REFUSED';
      status: number;
    }
  | {
      /**
       * The document requires authentication and an anonymous request
       * succeeded. The other same-day finding, and the more expensive one.
       */
      kind: 'DECLARED_PRIVATE_BUT_OPEN';
      status: number;
    }
  | {
      /**
       * The operation answered 404.
       *
       * NAMED "NOT_ROUTED" AND NOT "ABSENT", and it leaves the operation's
       * verification exactly where it was. A stale gateway, a feature flag that
       * is off, an authorisation wall that hides existence and a genuinely
       * undeployed operation all return this and cannot be told apart from
       * outside. The finding is a statement about what we observed.
       */
      kind: 'DECLARED_BUT_NOT_ROUTED';
      status: number;
    }
  | {
      /** The declared verb came back 405. The document and the router disagree. */
      kind: 'DECLARED_VERB_REFUSED';
      status: number;
      /** The `Allow` header's verbs, when it sent one. */
      allowed: string[];
    }
  | {
      /**
       * A safe verb the document does NOT declare answered anyway.
       *
       * An undeclared verb that works is undocumented surface: it is in the
       * application and in nobody's denominator, which is the exact shape of
       * thing this product exists to find.
       */
      kind: 'UNDECLARED_VERB_ANSWERS';
      status: number;
      method: string;
    }
  | {
      /** An id that cannot exist came back 2xx. Either a shell page or someone else's record. */
      kind: 'BAD_ID_ACCEPTED';
      status: number;
    }
  | {
      /** An id that cannot exist came back 5xx. Not an error path — a defect. */
      kind: 'BAD_ID_FAULTED';
      status: number;
    }
  | {
      /** The declared request faulted. Reported as observed, never as coverage. */
      kind: 'SERVER_FAULT';
      status: number;
    };

/**
 * Every discriminant {@link ApiProbeFinding} has, as a run-time value. The
 * compiler enforces this record; the test file enforces the zod union against
 * it.
 */
const API_PROBE_FINDING_PRESENT: Record<ApiProbeFinding['kind'], true> = {
  DECLARED_PUBLIC_BUT_REFUSED: true,
  DECLARED_PRIVATE_BUT_OPEN: true,
  DECLARED_BUT_NOT_ROUTED: true,
  DECLARED_VERB_REFUSED: true,
  UNDECLARED_VERB_ANSWERS: true,
  BAD_ID_ACCEPTED: true,
  SERVER_FAULT: true,
  BAD_ID_FAULTED: true,
};

export const API_PROBE_FINDING_KINDS = Object.keys(
  API_PROBE_FINDING_PRESENT,
) as ReadonlyArray<ApiProbeFinding['kind']>;

export type ApiProbeFindingKind = ApiProbeFinding['kind'];

export const API_PROBE_FINDING_LABELS: Record<ApiProbeFindingKind, string> = {
  DECLARED_PUBLIC_BUT_REFUSED: 'the document declares anonymous access and the API refused it',
  DECLARED_PRIVATE_BUT_OPEN: 'the document requires authentication and an anonymous call succeeded',
  DECLARED_BUT_NOT_ROUTED: 'a declared operation answered 404 — unknown, never proven absent',
  DECLARED_VERB_REFUSED: 'a declared verb answered 405',
  UNDECLARED_VERB_ANSWERS: 'a verb the document does not declare answered anyway',
  BAD_ID_ACCEPTED: 'an identifier that cannot exist was accepted',
  BAD_ID_FAULTED: 'an identifier that cannot exist produced a server fault',
  SERVER_FAULT: 'the declared request produced a server fault',
};

const status = z.number().int().min(100).max(599);

/**
 * The write path for a finding. See the note on {@link ApiProbeFinding} for why
 * this is in the same file as the union and not in `schemas.ts`.
 */
export const apiProbeFindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('DECLARED_PUBLIC_BUT_REFUSED'), status }),
  z.object({ kind: z.literal('DECLARED_PRIVATE_BUT_OPEN'), status }),
  z.object({ kind: z.literal('DECLARED_BUT_NOT_ROUTED'), status }),
  z.object({
    kind: z.literal('DECLARED_VERB_REFUSED'),
    status,
    allowed: z.array(z.string().trim().min(1).max(20)).max(20).default([]),
  }),
  z.object({
    kind: z.literal('UNDECLARED_VERB_ANSWERS'),
    status,
    method: z.string().trim().min(1).max(20),
  }),
  z.object({ kind: z.literal('BAD_ID_ACCEPTED'), status }),
  z.object({ kind: z.literal('BAD_ID_FAULTED'), status }),
  z.object({ kind: z.literal('SERVER_FAULT'), status }),
]);

/** One probe's outcome: the row to write, the finding, and what it was. */
export interface ApiProbeOutcome {
  kind: ApiProbeKind;
  /** `GET /orders/{id}` — which operation this is about. */
  operationKey: string;
  /** The operation row's id when the caller knew it. */
  operationId: string | null;
  /** The URL that was requested, so the evidence is re-runnable. */
  url: string;
  method: string;
  /** Exactly the shared `ApiOperationProbe` row shape. Nothing extra. */
  fact: ApiOperationProbeFact;
  findings: ApiProbeFinding[];
}

/** What the probe concluded about one operation. */
export interface ApiOperationVerdict {
  operationKey: string;
  operationId: string | null;
  verification: ApiOperationVerification;
  /** Set exactly when `verification` is NOT_PROBED. Null otherwise. */
  notProbedReason: NotProbedReason | null;
  /** Null unless both halves of the auth probe were sent. See the shared note. */
  authRequiredInFact: boolean | null;
  detail: string;
}

/**
 * The verification to STORE, given what the row already held.
 *
 * ── WHY THIS IS A FUNCTION AND NOT THE CALLER'S `??` ────────────────────────
 *
 * Because `ApiOperationVerdict.verification` is what THIS PROBE established,
 * and writing it straight onto the row is wrong in one specific, expensive
 * direction: a 404 or a 5xx produces the verdict DECLARED, meaning "this probe
 * did not confirm", and a writer that assigns it would DOWNGRADE an operation
 * that a previous probe genuinely confirmed. The customer then watches
 * confirmed operations flicker back to declared every time their staging
 * gateway has a bad minute, and stops believing the column.
 *
 * The rule, which is the same one the shared vocabulary states for why there is
 * no REFUTED member: an observation may raise what we know and may never
 * silently lower it. Only CONFIRMED is a promotion; NO_ANSWER and NOT_PROBED
 * are recorded on a row that has never been confirmed and are otherwise kept
 * off it, with the probe row holding what was actually seen either way.
 */
export function verificationAfterProbe(
  previous: ApiOperationVerification | null | undefined,
  verdict: ApiOperationVerification,
): ApiOperationVerification {
  // A confirmation is always worth storing: it is the strongest thing we have.
  if (verdict === 'CONFIRMED') return 'CONFIRMED';
  /*
   * Nothing else may displace a standing CONFIRMED. The evidence that it is no
   * longer routed lives in the probe rows, where "it answered last week and
   * does not now" is derivable as a statement about observations — rather than
   * being baked into this column as a claim we cannot defend.
   */
  if (previous === 'CONFIRMED') return 'CONFIRMED';
  return verdict;
}

export interface ApiProbeInput {
  transport: ApiProbeTransport;
  /**
   * The environment's base URL. NULL is a first-class input: every operation
   * then comes back NOT_PROBED / NO_BASE_URL, which is a configuration a
   * customer fixes in a minute and is nothing at all like "does not exist".
   */
  baseUrl: string | null;
  operations: readonly ApiProbeTarget[];
  policy: CrawlPolicy;
  credential?: ApiProbeCredential | null;
  clock?: ApiProbeClock;
  caps?: Partial<ApiSurfaceCaps>;
  timeoutMs?: number;
  /**
   * Allow verbs outside {@link SAFE_PROBE_METHODS}.
   *
   * Default false, and it takes BOTH this and `policy.allowDestructive` to
   * issue one — the same two-key rule `policyDecision` applies to a destructive
   * path, for the same reason: "this environment is disposable" and "send a
   * DELETE at it" are different claims.
   */
  allowUnsafeVerbs?: boolean;
}

export interface ApiProbeReport {
  probes: ApiProbeOutcome[];
  verdicts: ApiOperationVerdict[];
  /**
   * Every probe we declined to issue, with the rule that declined it.
   *
   * A refusal in this ledger is a thing a customer can choose to allow. A
   * silent `continue` is a surface that, as far as any reader can tell, does
   * not exist — which is the defect the whole exercisability vocabulary in
   * @qaai/shared was built to end.
   */
  refused: ExcludedPath[];
  caps: ApiSurfaceCapBite[];
  /** Milliseconds spent waiting on the rate limit. Disclosed, not hidden. */
  rateLimitWaitMs: number;
  /**
   * Follow-up probes the budget stopped on operations that WERE probed.
   *
   * A separate number from the PROBE_BUDGET cap's `discarded`, which counts
   * operations nothing probed at all. Zero here is a measurement: it means the
   * budget never cut a follow-up short, not that nobody counted.
   */
  followUpsStoppedByBudget: number;
  caveats: string[];
}

/** `GET /orders/{id}` — the key a verdict and a probe share. */
function operationKeyOf(target: ApiProbeTarget): string {
  return `${target.method} ${target.pathTemplate}`;
}

/** Swaps every path parameter for the sentinel id. Handles `{id}` and `:id`. */
function badIdPath(template: string): string {
  return template
    .replace(/\{[^}]+\}/g, PROBE_BAD_ID)
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, PROBE_BAD_ID);
}

function hasPathParameter(template: string): boolean {
  return /\{[^}]+\}/.test(template) || /:[A-Za-z_][A-Za-z0-9_]*/.test(template);
}

/**
 * Fills a template's parameters so it can actually be requested.
 *
 * `sentinelUsed` is the half that matters: it reports whether any slot was
 * filled with {@link PROBE_BAD_ID} for want of a real value, which is what
 * decides whether a separate bad-id probe would be a second observation or the
 * same one twice. See {@link ApiProbeTarget.sampleValues}.
 */
function fillTemplate(
  template: string,
  samples: Record<string, string> | undefined,
): { path: string; sentinelUsed: boolean } {
  let sentinelUsed = false;
  const fill = (name: string): string => {
    const sample = samples?.[name];
    if (sample !== undefined && sample.length > 0) return encodeURIComponent(sample);
    sentinelUsed = true;
    return PROBE_BAD_ID;
  };
  const path = template
    .replace(/\{([^}]+)\}/g, (_match, name: string) => fill(name))
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => fill(name));
  return { path, sentinelUsed };
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function allowVerbs(headers: Record<string, string>): string[] {
  const header = headers.allow ?? headers.Allow;
  if (typeof header !== 'string') return [];
  return header
    .split(',')
    .map((verb) => verb.trim().toUpperCase())
    .filter((verb) => verb.length > 0);
}

/**
 * Whether a status PROVES the path is routed.
 *
 * 404 is excluded for the reason the shared vocabulary states at length: it
 * cannot distinguish an undeployed operation from a flag, a stale gateway or a
 * hidden authorisation wall.
 *
 * 5xx is ALSO excluded, which is the less obvious call. A blanket 502 from a
 * load balancer answers every path in the application identically, so taking it
 * as proof of routing would CONFIRM every operation in a document against a
 * backend that is simply down — and a confirmed operation is one a reader
 * believes. The probe row still records the status and raises SERVER_FAULT, so
 * nothing is lost; what is withheld is the word "confirmed".
 */
function statusProvesRouted(code: number): boolean {
  if (code === 404) return false;
  if (code >= 500) return false;
  return code >= 200;
}

/** A refusal and a verdict, written together so neither can be forgotten. */
interface Refusal {
  excluded: ExcludedPath;
  verdict: ApiOperationVerdict;
}

function refuse(
  target: ApiProbeTarget,
  url: string,
  kind: ExclusionKind,
  rule: string,
  reason: NotProbedReason,
  detail: string,
): Refusal {
  const key = operationKeyOf(target);
  return {
    excluded: {
      url,
      route: target.pathTemplate,
      kind,
      rule,
      discoveredFrom: `api probe (${key})`,
    },
    verdict: {
      operationKey: key,
      operationId: target.operationId ?? null,
      verification: 'NOT_PROBED',
      notProbedReason: reason,
      authRequiredInFact: null,
      detail,
    },
  };
}

/**
 * Probes declared operations against a running application.
 *
 * ── THE FOUR HARD RULES, IN THE ORDER THEY ARE ENFORCED ─────────────────────
 *
 * 1. READ-ONLY BY DEFAULT. Only {@link SAFE_PROBE_METHODS} leave this function
 *    unless BOTH `allowUnsafeVerbs` and `policy.allowDestructive` are set. A
 *    probe that would mutate customer data is REFUSED AND RECORDED, never
 *    skipped, so the report can say "we did not probe your 41 POST operations
 *    and here is the switch that would let us".
 * 2. THE POLICY GATE RUNS BEFORE THE BUDGET GATE. A probe we were never
 *    permitted to issue must be recorded as refused by its rule and must not be
 *    hidden behind a budget decision — and `discarded` on the budget then
 *    counts only probes we were willing AND allowed to issue, so "at least N
 *    more operations existed" is not inflated with paths we would never visit.
 * 3. THE RATE LIMIT IS A CAP AND IS DISCLOSED WHEN IT BITES. It bites by
 *    delaying rather than by discarding, so its `discarded` is 0 and its
 *    `reason` carries the milliseconds. A zero that is a measurement, exactly
 *    as `CapBite.discarded` requires.
 * 4. A NON-ANSWER IS `NO_ANSWER`. `answered: false`, `status: null`, and the
 *    verification is NO_ANSWER — never a status of 0, never absent.
 */
export async function probeApiOperations(input: ApiProbeInput): Promise<ApiProbeReport> {
  const caps = { ...DEFAULT_API_SURFACE_CAPS, ...input.caps };
  const clock = input.clock ?? SYSTEM_PROBE_CLOCK;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const ledger = new CapLedger();

  const probes: ApiProbeOutcome[] = [];
  const verdicts: ApiOperationVerdict[] = [];
  const refused: ExcludedPath[] = [];
  let rateLimitWaitMs = 0;
  let issued = 0;
  let lastSentAt: number | null = null;

  const take = (refusal: Refusal): void => {
    refused.push(refusal.excluded);
    verdicts.push(refusal.verdict);
  };

  if (input.baseUrl === null) {
    for (const target of input.operations) {
      verdicts.push({
        operationKey: operationKeyOf(target),
        operationId: target.operationId ?? null,
        verification: 'NOT_PROBED',
        notProbedReason: 'NO_BASE_URL',
        authRequiredInFact: null,
        detail:
          'the environment has no base URL, so there was nowhere to send a request; this is a ' +
          'configuration gap and says nothing about whether the operation exists',
      });
    }
    return {
      probes,
      verdicts,
      refused,
      caps: [],
      rateLimitWaitMs: 0,
      // Nothing was issued, so nothing was cut short. A measured zero.
      followUpsStoppedByBudget: 0,
      caveats: [
        `${input.operations.length} operation(s) were not probed: the environment has no base URL`,
      ],
    };
  }
  const baseUrl = input.baseUrl;

  /** Issues one request, charging the rate limit and the budget first. */
  const send = async (
    method: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<ApiProbeResponse> => {
    if (caps.probeMinIntervalMs > 0 && lastSentAt !== null) {
      const elapsed = clock.now() - lastSentAt;
      const wait = caps.probeMinIntervalMs - elapsed;
      if (wait > 0) {
        /*
         * `discarded: 0` and a REAL zero: the rate limit never throws a probe
         * away, it delays it. The cost is in the reason, in milliseconds, so a
         * run that spent eleven seconds being polite can say so.
         */
        ledger.bite('PROBE_RATE', caps.probeMinIntervalMs, `${method} ${path}`, 0);
        rateLimitWaitMs += wait;
        await clock.sleep(wait);
      }
    }
    issued += 1;
    lastSentAt = clock.now();
    const url = joinUrl(baseUrl, path);
    try {
      return await input.transport.send({ method, url, headers, timeoutMs });
    } catch (err) {
      return {
        status: null,
        headers: {},
        error: `the probe threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  const record = (
    target: ApiProbeTarget,
    kind: ApiProbeKind,
    method: string,
    path: string,
    response: ApiProbeResponse,
    findings: ApiProbeFinding[],
    detail: string,
    authRequiredInFact: boolean | null,
    verbAllowed: boolean | null,
  ): void => {
    probes.push({
      kind,
      operationKey: operationKeyOf(target),
      operationId: target.operationId ?? null,
      url: joinUrl(baseUrl, path),
      method,
      fact: {
        status: response.status,
        verbAllowed,
        authRequiredInFact,
        answered: response.status !== null,
        detail,
      },
      findings,
    });
  };

  let sentinelDeclaredProbes = 0;
  /**
   * Follow-up probes the budget stopped, per kind.
   *
   * ── THE DEFECT THIS COUNTER EXISTS TO END ──────────────────────────────────
   *
   * The three follow-ups below used to be guarded by a bare
   * `issued < caps.probeBudget` and nothing else. When that guard failed the
   * probe was skipped in SILENCE: no ledger bite, no caveat, and — for the
   * credentialled half — an `authRequiredInFact: null` whose own documentation
   * says null means NOT DETERMINED and that the reason belongs on the row. A
   * reader then saw an operation that answered 401, a credential configured on
   * the project, and no explanation at all for the null. That is the
   * undisclosed cap this product may never ship: a cap that bit, moved a
   * measurement to "unknown", and left no trace.
   */
  const followUpsStopped = new Map<ApiProbeKind, number>();
  const stoppedByBudget = (kind: ApiProbeKind, key: string): void => {
    followUpsStopped.set(kind, (followUpsStopped.get(kind) ?? 0) + 1);
    /*
     * `discarded: 1` on ITS OWN cap member, never on PROBE_BUDGET: that one's
     * discarded count is the floor on operations nothing probed at all, and an
     * operation we reached must not be added to it. See the note on
     * {@link API_SURFACE_CAPS}.
     */
    ledger.bite(
      'PROBE_FOLLOW_UP_BUDGET',
      caps.probeBudget,
      `${key} (${API_PROBE_KIND_LABELS[kind]})`,
      1,
    );
  };

  for (const target of input.operations) {
    const key = operationKeyOf(target);
    const filled = fillTemplate(target.pathTemplate, target.sampleValues);
    const path = filled.path;
    const url = joinUrl(baseUrl, path);

    // ── Gate 1: the verb ─────────────────────────────────────────────────
    /*
     * THE UNKNOWN CHECK RUNS FIRST, and the order is the honesty. An UNKNOWN
     * verb is not in `SAFE_PROBE_METHODS`, so a safety check placed before this
     * one reports "this would mutate data in your environment" about an
     * operation whose verbs we simply could not read — a claim about the
     * customer's API made out of our own blind spot, and the remedy a reader
     * would reach for (allowDestructive) would not help.
     */
    if (target.method === 'UNKNOWN') {
      take(
        refuse(
          target,
          url,
          'UNSAFE_METHOD',
          'the operation\'s verb is UNKNOWN, so there is no request to send',
          'UNSAFE_VERB',
          `${key} carries no readable verb, so no probe could be built; the operation stays ` +
            'declared and unverified rather than being probed with a guessed method',
        ),
      );
      continue;
    }

    const safe = SAFE_PROBE_METHODS.includes(target.method);
    const unsafeAllowed = input.allowUnsafeVerbs === true && input.policy.allowDestructive;
    if (!safe && !unsafeAllowed) {
      take(
        refuse(
          target,
          url,
          'UNSAFE_METHOD',
          input.allowUnsafeVerbs === true
            ? 'allowUnsafeVerbs is set and policy.allowDestructive is not; both are required'
            : 'probing is read-only by default: only GET, HEAD and OPTIONS are issued',
          'UNSAFE_VERB',
          `${key} would mutate data in this environment, so it was refused and recorded rather ` +
            'than issued; nothing is claimed about it in either direction',
        ),
      );
      continue;
    }
    // ── Gate 2: the policy ───────────────────────────────────────────────
    const decision = policyDecision(input.policy, path);
    if (!decision.admitted) {
      take(
        refuse(
          target,
          url,
          'POLICY_EXCLUDE',
          decision.rule,
          'REFUSED_BY_POLICY',
          `${key} is excluded by the crawl policy (${decision.rule}); we did not look, on purpose`,
        ),
      );
      continue;
    }

    // ── Gate 3: the budget ───────────────────────────────────────────────
    if (issued >= caps.probeBudget) {
      ledger.bite('PROBE_BUDGET', caps.probeBudget, key, 1);
      verdicts.push({
        operationKey: key,
        operationId: target.operationId ?? null,
        verification: 'NOT_PROBED',
        notProbedReason: 'BUDGET_SPENT',
        authRequiredInFact: null,
        detail:
          `the probe budget of ${caps.probeBudget} request(s) was spent before ${key} was ` +
          'reached; at least one more operation was declared and not verified',
      });
      continue;
    }

    // ── The declared, anonymous request ──────────────────────────────────
    const anonymous = await send(target.method, path, { accept: '*/*' });
    const findings: ApiProbeFinding[] = [];
    let authRequiredInFact: boolean | null = null;
    let verbAllowed: boolean | null = null;

    if (anonymous.status === null) {
      record(
        target,
        'DECLARED_ANONYMOUS',
        target.method,
        path,
        anonymous,
        findings,
        anonymous.error ??
          'nothing answered, so nothing is claimed about this operation in either direction',
        null,
        null,
      );
      verdicts.push({
        operationKey: key,
        operationId: target.operationId ?? null,
        verification: 'NO_ANSWER',
        notProbedReason: null,
        authRequiredInFact: null,
        detail:
          `${key} was probed and nothing answered (${anonymous.error ?? 'no detail'}); that is ` +
          'UNKNOWN, not absent',
      });
      continue;
    }

    const code = anonymous.status;
    const refusedAnonymously = code === 401 || code === 403;

    if (code === 404) findings.push({ kind: 'DECLARED_BUT_NOT_ROUTED', status: code });
    if (code === 405) {
      verbAllowed = false;
      findings.push({
        kind: 'DECLARED_VERB_REFUSED',
        status: code,
        allowed: allowVerbs(anonymous.headers),
      });
    } else if (code !== 404) {
      /*
       * A status that is not 405 and not 404 means the router accepted the
       * VERB. 404 is left as null rather than true: a path that does not route
       * says nothing about which verbs it would accept if it did.
       */
      verbAllowed = true;
    }
    if (code >= 500) findings.push({ kind: 'SERVER_FAULT', status: code });
    if (filled.sentinelUsed) {
      /*
       * No real value was available for at least one path parameter, so this
       * request carried the sentinel id — which makes it a bad-id probe as well
       * as the declared one, and its findings belong on this row rather than on
       * a duplicate request to the same URL.
       */
      sentinelDeclaredProbes += 1;
      if (code >= 200 && code < 300) findings.push({ kind: 'BAD_ID_ACCEPTED', status: code });
      if (code >= 500) findings.push({ kind: 'BAD_ID_FAULTED', status: code });
    }
    if (refusedAnonymously && ANONYMOUS_ACCESS_DECLARED.includes(target.authDeclaration)) {
      findings.push({ kind: 'DECLARED_PUBLIC_BUT_REFUSED', status: code });
    }
    if (code >= 200 && code < 300 && target.authDeclaration === 'REQUIRED') {
      findings.push({ kind: 'DECLARED_PRIVATE_BUT_OPEN', status: code });
    }

    // ── The authenticated half, only when there is a reason to send it ───
    const credential = input.credential ?? null;
    let authDetail = '';
    if (refusedAnonymously && credential !== null && issued >= caps.probeBudget) {
      /*
       * The budget, not the evidence, is why this is undetermined — and saying
       * so is the whole difference between "we asked and could not tell" and
       * "we never asked". The remedy is a bigger budget, which only a reader
       * who is told can reach for.
       */
      stoppedByBudget('DECLARED_AUTHENTICATED', key);
      authDetail =
        ` the credentialled half was NOT sent: the probe budget of ${caps.probeBudget} ` +
        'request(s) was spent, so whether authentication is required IN FACT is undetermined ' +
        'for want of a request rather than for want of an answer';
    } else if (refusedAnonymously && credential !== null) {
      const authed = await send(target.method, path, { accept: '*/*', ...credential.headers });
      const authedCode = authed.status;
      /*
       * `authRequiredInFact` is set TRUE only when the anonymous call was
       * refused AND the credentialled one was not. An anonymous 401 on its own
       * does not establish it — the operation may be 401-ing everybody,
       * including us — and recording `true` from half the evidence is how the
       * document and the application come to agree on paper about an operation
       * that is broken for every caller.
       */
      if (authedCode === null) {
        authDetail = ` the credentialled half got no answer (${authed.error ?? 'no detail'}), so ` +
          'whether authentication is required IN FACT is undetermined';
      } else if (authedCode === 401 || authedCode === 403) {
        authDetail = ` \`${credential.label}\` was refused as well (${authedCode}), so this may be ` +
          'refusing everybody rather than requiring a credential; undetermined';
      } else {
        authRequiredInFact = true;
        authDetail = ` \`${credential.label}\` was accepted (${authedCode}) where an anonymous ` +
          'request was not, which establishes that authentication is required in fact';
      }
      record(
        target,
        'DECLARED_AUTHENTICATED',
        target.method,
        path,
        authed,
        [],
        `${key} with ${credential.label}:${authDetail}`,
        authRequiredInFact,
        null,
      );
    } else if (refusedAnonymously && credential === null) {
      authDetail =
        ' no credential was supplied, so whether this requires authentication IN FACT is ' +
        'undetermined — one anonymous refusal does not establish it';
    }

    record(
      target,
      'DECLARED_ANONYMOUS',
      target.method,
      path,
      anonymous,
      findings,
      `${key} answered ${code} to an anonymous request.${authDetail}`,
      authRequiredInFact,
      verbAllowed,
    );

    // ── A bad id, for a parameterised path we have real values for ───────
    /*
     * The budget is deliberately NOT one of these conditions. A probe we were
     * never going to issue (no path parameter, an unsafe verb, an auth wall)
     * is not a probe the budget stopped, and charging it to the cap would
     * disclose a cost the cap never imposed — which teaches a reader to ignore
     * the disclosure. So the WANT is decided first and the budget second.
     */
    const wantsBadId =
      hasPathParameter(target.pathTemplate) &&
      !filled.sentinelUsed &&
      (target.method === 'GET' || target.method === 'HEAD') &&
      !refusedAnonymously &&
      code !== 404;
    if (wantsBadId && issued >= caps.probeBudget) stoppedByBudget('BAD_ID', key);
    if (wantsBadId && issued < caps.probeBudget) {
      /*
       * `!filled.sentinelUsed` is the guard that stops this being the same
       * request twice: without real sample values the declared probe already
       * carried the sentinel, and its findings were attached above.
       *
       * Skipped too when the anonymous call was refused or 404'd, which is not
       * an optimisation: a bad-id probe against an operation that 401s every
       * caller measures the auth wall, and reporting its 401 as "a bad id was
       * rejected" would credit the application with validation it never ran.
       */
      const badPath = badIdPath(target.pathTemplate);
      const bad = await send(target.method, badPath, { accept: '*/*' });
      const badFindings: ApiProbeFinding[] = [];
      if (bad.status !== null && bad.status >= 200 && bad.status < 300) {
        badFindings.push({ kind: 'BAD_ID_ACCEPTED', status: bad.status });
      }
      if (bad.status !== null && bad.status >= 500) {
        badFindings.push({ kind: 'BAD_ID_FAULTED', status: bad.status });
      }
      record(
        target,
        'BAD_ID',
        target.method,
        badPath,
        bad,
        badFindings,
        bad.status === null
          ? `${key} with the id \`${PROBE_BAD_ID}\` got no answer (${bad.error ?? 'no detail'})`
          : `${key} with the id \`${PROBE_BAD_ID}\` answered ${bad.status}`,
        null,
        null,
      );
    }

    // ── An undeclared safe verb, to find undocumented surface ────────────
    const wantsUndeclaredVerb =
      target.method === 'GET' && code !== 404 && !refusedAnonymously;
    if (wantsUndeclaredVerb && issued >= caps.probeBudget) {
      stoppedByBudget('UNDECLARED_VERB', key);
    }
    if (wantsUndeclaredVerb && issued < caps.probeBudget) {
      const probeVerb = 'OPTIONS';
      const other = await send(probeVerb, path, { accept: '*/*' });
      const otherFindings: ApiProbeFinding[] = [];
      let otherAllowed: boolean | null = null;
      if (other.status !== null) {
        if (other.status === 405) otherAllowed = false;
        else if (other.status !== 404) {
          otherAllowed = true;
          otherFindings.push({
            kind: 'UNDECLARED_VERB_ANSWERS',
            status: other.status,
            method: probeVerb,
          });
        }
      }
      record(
        target,
        'UNDECLARED_VERB',
        probeVerb,
        path,
        other,
        otherFindings,
        other.status === null
          ? `${probeVerb} ${target.pathTemplate} got no answer (${other.error ?? 'no detail'})`
          : `${probeVerb} ${target.pathTemplate} answered ${other.status}, and the document ` +
            `declares only ${target.method}`,
        null,
        otherAllowed,
      );
    }

    verdicts.push({
      operationKey: key,
      operationId: target.operationId ?? null,
      verification: statusProvesRouted(code) ? 'CONFIRMED' : 'DECLARED',
      notProbedReason: null,
      authRequiredInFact,
      detail: statusProvesRouted(code)
        ? `${key} answered ${code}, which proves the path is routed`
        : `${key} answered ${code}, which does not prove the path is routed; the operation stays ` +
          'DECLARED and the probe row carries what was seen',
    });
  }

  const caveats: string[] = [];
  const notProbed = verdicts.filter((verdict) => verdict.verification === 'NOT_PROBED');
  if (notProbed.length > 0) {
    caveats.push(
      `${notProbed.length} operation(s) were NOT PROBED; each carries the reason, and none of ` +
        'them is evidence that the operation does not exist',
    );
  }
  const noAnswer = verdicts.filter((verdict) => verdict.verification === 'NO_ANSWER').length;
  if (noAnswer > 0) {
    caveats.push(
      `${noAnswer} operation(s) were probed and nothing answered; that is unknown, not absent`,
    );
  }
  const followUpsTotal = [...followUpsStopped.values()].reduce((sum, count) => sum + count, 0);
  if (followUpsTotal > 0) {
    caveats.push(
      `the probe budget of ${caps.probeBudget} request(s) also stopped ${followUpsTotal} ` +
        'follow-up probe(s) on operations that WERE probed (' +
        [...followUpsStopped.entries()]
          .map(([kind, count]) => `${count} × ${API_PROBE_KIND_LABELS[kind]}`)
          .join('; ') +
        '); those questions are UNASKED for those operations rather than answered — no bad id ' +
        'was tried, no undocumented verb was looked for, and any `authRequiredInFact` left null ' +
        'is null for want of a request',
    );
  }
  if (sentinelDeclaredProbes > 0) {
    caveats.push(
      `${sentinelDeclaredProbes} operation(s) have path parameters and no observed sample value, ` +
        `so their declared probe necessarily carried the id \`${PROBE_BAD_ID}\`; no separate ` +
        'bad-id probe was issued for them, because it would be the same request twice',
    );
  }
  if (rateLimitWaitMs > 0) {
    caveats.push(
      `${rateLimitWaitMs}ms was spent waiting on the ${caps.probeMinIntervalMs}ms probe rate ` +
        'limit; a run that hits its wall clock has probed fewer operations because of it',
    );
  }
  if (input.credential === null || input.credential === undefined) {
    const refusals = probes.filter(
      (probe) => probe.fact.status === 401 || probe.fact.status === 403,
    ).length;
    if (refusals > 0) {
      caveats.push(
        `${refusals} probe(s) were refused and no credential was supplied, so whether those ` +
          'operations require authentication IN FACT is undetermined rather than true',
      );
    }
  }

  return {
    probes,
    verdicts,
    refused,
    caps: ledger.bites((cap, discarded) => {
      if (cap === 'PROBE_RATE') {
        return (
          `${API_SURFACE_CAP_LABELS[cap]} delayed this run by ${rateLimitWaitMs}ms in total; it ` +
          'discards nothing and costs wall clock'
        );
      }
      if (cap === 'PROBE_FOLLOW_UP_BUDGET') {
        return (
          `the probe budget was spent before ${discarded} follow-up probe(s) could be issued ` +
          'against operations that WERE probed, so those questions are unasked for them; this is ' +
          'NOT a count of operations nothing probed at all — PROBE_BUDGET carries that'
        );
      }
      return (
        `${API_SURFACE_CAP_LABELS[cap]} stopped ${discarded} operation(s) being probed; at ` +
        'least that many more were declared and not verified'
      );
    }),
    rateLimitWaitMs,
    followUpsStoppedByBudget: followUpsTotal,
    caveats,
  };
}
