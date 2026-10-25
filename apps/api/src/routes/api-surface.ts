/**
 * The API-document ingest door: the half of the denominator a crawl cannot see.
 *
 * `/surface` reconciles what the SOURCE declares against what a crawl reached.
 * This router adds the third declarer, and it is the one customers already
 * maintain: an OpenAPI, Swagger, AsyncAPI or Postman document. Until now that
 * document was parsed only inside the CONTRACT runner and thrown away when the
 * run ended, so the single richest machine-written statement of an
 * application's surface — every method, path template, parameter bound and
 * declared security requirement — was read once and discarded.
 *
 *   POST /api-surface/:projectId          ingest a document; diff it; persist
 *   GET  /api-surface/:projectId          the operations, their verification
 *                                          state, and what the registry knows
 *   POST /api-surface/:projectId/retire   retire one operation, on purpose
 *
 * ── WHY A RE-UPLOAD NEVER DELETES ──────────────────────────────────────────
 *
 * An operation that disappears from a new version of a document is REPORTED as
 * absent and left in the denominator. The reason is arithmetic: a document
 * uploaded against the wrong project, truncated by a CI step, or exported from
 * a half-migrated gateway declares fewer operations than the real one, and
 * deleting the difference would make the coverage percentage go UP on the
 * strength of a bad upload. So absence is a MARK plus a line in the response,
 * and retiring is a separate, audited, deliberate request — the same shape as a
 * coverage waiver, for the same reason.
 *
 * ── WHY THIS ROUTER DOES NOT WRITE CoverageItem ROWS ───────────────────────
 *
 * `CoverageItem` is the one surface registry and these operations belong in it.
 * They are not written here yet, and that is deliberate rather than lazy:
 * `computeCoverage` in lib/coverage-store.ts ends with
 *
 *     updateMany({ where: { key: { notIn: seenKeys } }, data: { retiredAt } })
 *
 * and `seenKeys` comes from the codebase analysis and the flow map. An
 * OPENAPI-declared row written from here would therefore be retired by the next
 * `POST /surface/:projectId/recompute` — a denominator that shrinks silently,
 * which is the exact defect this slice exists to end. So this router owns
 * `ApiOperation` as the authoritative API inventory, READS the registry to
 * report each operation's coverage state, and reports `declaredNotInRegistry`
 * as the headline number. Unioning the two is one change in coverage-store.ts;
 * until it lands, the honest thing is to name the gap rather than to write rows
 * that something else will quietly bury.
 *
 * ── THE PARSER IS INJECTED ─────────────────────────────────────────────────
 *
 * Parsing lives in packages/agent and reaches this router through
 * {@link configureApiSurfaceIo}. Nothing in this file imports a parser, a
 * fetcher or a resolver at module scope, so every path below — including the
 * one where the document is fetched over the network — is exercised in the test
 * file with a fake. When no parser is wired, the route answers 501 and names
 * the export it looked for; it never answers 200 with an empty operation list,
 * because "we could not read it" and "it declares nothing" are opposite facts.
 */

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ANONYMOUS_ACCESS_DECLARED,
  API_AUTH_DECLARATIONS,
  API_AUTH_DECLARATION_LABELS,
  API_OPERATION_METHODS,
  API_OPERATION_VERIFICATIONS,
  COVERED_STATUSES,
  EXCLUDED_STATUSES,
  NOT_PROBED_REASONS,
  apiOperationSchema,
  exclusionsByRule,
  originFromSources,
  resolveCrawlPolicy,
  surfaceKey,
} from '@qaai/shared';
import type {
  ApiAuthDeclaration,
  ApiOperationInput,
  ApiOperationVerification,
  SurfaceOrigin,
  SurfaceSource,
  SurfaceStatus,
} from '@qaai/shared';
/*
 * The SSRF guard is on a SUBPATH and not in the barrel, exactly as
 * lib/issues.ts and lib/sso.ts import it: `private-address.ts` reaches for
 * `node:dns`, and a Node builtin in `packages/shared/src/index.ts` breaks every
 * web page that imports a value from @qaai/shared.
 */
import { classifyHost, resolvesPublicly } from '@qaai/shared/private-address';
import type { LookupFn } from '@qaai/shared/private-address';
/*
 * ── WHY THE PROBER IS A STATIC IMPORT AND THE INGEST IS NOT ─────────────────
 *
 * `resolveIngest` below looks `ingestApiDocument` up by name because, when that
 * door was written, the export DID NOT EXIST — a static import of a name that
 * is not there fails the whole package's typecheck and would have taken both
 * endpoints down with it. These five exports exist today, this file already
 * takes a static dependency on @qaai/agent for `endpointIdentity`, and a
 * dynamic lookup of a function that is present would buy nothing and cost the
 * compiler's check that the call below matches the prober's signature.
 *
 * `probeApiOperations` is imported and CALLED, never reimplemented:
 * `verificationAfterProbe` in particular is the reason a confirmed operation
 * does not flicker back to declared every time staging has a bad minute, and
 * the only way for this door to get that wrong is to decide it itself.
 */
import {
  API_PROBE_FINDING_LABELS,
  DEFAULT_API_SURFACE_CAPS,
  SAFE_PROBE_METHODS,
  SYSTEM_PROBE_CLOCK,
  apiSurfaceCapBites,
  endpointIdentity,
  probeApiOperations,
  verificationAfterProbe,
} from '@qaai/agent';
import type {
  ApiProbeClock,
  ApiProbeCredential,
  ApiProbeTarget,
  ApiProbeTransport,
} from '@qaai/agent';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound, notImplemented, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';

export const apiSurfaceRouter: Router = Router();

apiSurfaceRouter.use(requireAuth);

// ─── The injected I/O ────────────────────────────────────────────────────────

/**
 * What a document fetch returns. Deliberately not a `Response`: the only things
 * this router needs are the status, the body and how many bytes arrived, and a
 * narrow shape is the difference between a testable module and 629 lines of
 * crawler.ts with no tests because every path needs a browser.
 */
export interface FetchedDocument {
  status: number;
  /** The body as text. Empty string when the response had none. */
  text: string;
  /** Bytes actually read, which is what the size cap is measured against. */
  bytes: number;
  contentType: string | null;
  /**
   * True when the read STOPPED at the byte cap rather than reaching the end.
   *
   * `bytes` is then a FLOOR and not the document's size, and the refusal below
   * says "at least N bytes" instead of naming a figure the reader would take
   * for the whole document. Optional because a fetcher that reads to the end —
   * every fake in the test file — has nothing to disclose, and `undefined`
   * there means exactly that rather than a `false` nobody measured.
   */
  cappedAtLimit?: boolean;
}

export type DocumentFetch = (url: string) => Promise<FetchedDocument>;

/**
 * What an ingest produced.
 *
 * Declared STRUCTURALLY here rather than imported from packages/agent, and the
 * reason is rule 8 rather than taste: the ingest is a module this router does
 * not own, it is resolved by name at call time (see {@link resolveIngest}), and
 * a static import would make this whole door fail to compile on the day that
 * module is mid-rewrite. The shape mirrors `ApiDocumentIngest` in
 * packages/agent/src/api-surface.ts field for field; the parity is asserted in
 * the test file against the real module when it is present.
 *
 * `caps` is the ingest's own cap ledger. It is merged into this router's and
 * reported as one list: a cap applied in packages/agent raises the coverage
 * percentage exactly as hard as one applied here, so the response cannot afford
 * to disclose only the caps it owns.
 */
export interface ApiDocumentIngestResult {
  /** The ingest's verdict on what the document IS. Reported beside the hint. */
  kind: string;
  /** The version the document claims, verbatim. Null when it claims none. */
  version: string | null;
  /** Operations in document order, each already through `apiOperationSchema`. */
  operations: unknown[];
  /** What the document did not say, named. Carried through untouched. */
  gaps?: unknown[];
  /** `{ cap, limit, bites, discarded, reason }` — the ingest's cap bites. */
  caps?: Array<{ cap: string; limit: number; discarded?: number; bites?: number; reason?: string }>;
  /** What a reader must know before trusting any number derived from this. */
  caveats?: string[];
}

export interface IngestRequest {
  /** The DECODED document. This router decodes; the ingest parses. */
  document: unknown;
  /** The document's reference, which goes verbatim onto every operation. */
  sourceDocument: string;
}

export type ApiDocumentIngestFn = (
  request: IngestRequest,
) => ApiDocumentIngestResult | Promise<ApiDocumentIngestResult>;

interface ApiSurfaceIo {
  ingest: ApiDocumentIngestFn | null;
  fetchDocument: DocumentFetch;
  lookup: LookupFn | undefined;
  /**
   * The transport the prober issues its requests through. NULL BY DEFAULT, and
   * that default is the honest one: nothing in this build wires a real HTTP
   * transport in, so `POST …/probe` answers 501 and names it rather than
   * answering 200 with an empty observation — "we issued no requests" and
   * "your application answered nothing" are opposite facts, and the second one
   * is a measured claim about a customer's system.
   */
  probeTransport: ApiProbeTransport | null;
  /**
   * The credential the prober may use for the second half of an auth probe.
   *
   * Null by default, and the consequence is DISCLOSED on every probe response:
   * with no credential an operation that refuses anonymously leaves
   * `authRequiredInFact` NULL — undetermined, because one anonymous 401 does
   * not establish that a credential would have been accepted. Wiring this to
   * the customer's own sealed `Integration.configEnc` row is named in the
   * handover; it is deliberately NOT read from `process.env`, and the headers
   * never leave the transport.
   */
  probeCredential: ApiProbeCredential | null;
  /**
   * The clock the probe run is timed by — the prober's rate limit AND the
   * `observedAt` written onto every probe row. Injected so a test can freeze
   * it: `new Date()` inline at the write site would make the row's timestamp
   * untestable and would drift from the clock the prober itself charged its
   * rate limit against.
   */
  probeClock: ApiProbeClock;
}

/**
 * The real fetch adapter: thin on purpose.
 *
 * It enforces the byte cap while reading rather than after, so a hostile or
 * misconfigured server cannot make this process hold a gigabyte before the
 * limit is noticed. A body that exceeds the cap is REFUSED rather than
 * truncated, because half a JSON document parses into fewer operations and
 * "fewer operations" is the direction that flatters the number.
 */
const realFetch: DocumentFetch = async (url) => {
  const response = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'application/json, application/yaml, text/yaml, text/plain' },
    /*
     * A timeout, because a cap nobody applies is not a cap. Without one a
     * server that accepts the connection and then holds it open pins this
     * request — and the Node worker thread behind it — until something else
     * gives up, and nothing in the response would ever say why.
     */
    signal: AbortSignal.timeout(DOCUMENT_FETCH_TIMEOUT_MS),
  });
  const contentType = response.headers.get('content-type');
  const stream = response.body;
  /*
   * A 204, a HEAD-like answer, or a runtime that hands back no stream. Empty
   * string with `bytes: 0`, which the caller refuses with "answered N with an
   * empty body" rather than parsing into zero operations.
   */
  if (stream === null) return { status: response.status, text: '', bytes: 0, contentType };

  /*
   * READ IN CHUNKS AND STOP AT THE CAP, which is what the comment above has
   * always claimed and what `await response.text()` did not do: that buffered
   * the whole body first and the limit was compared afterwards, so a hostile
   * or misconfigured server could make this process hold an arbitrary amount
   * of memory before anything noticed. The cap is still a REFUSAL and never a
   * truncation — half a JSON document parses into fewer operations, and fewer
   * operations is the direction that flatters the percentage — so what stops
   * here is the READING, and the caller turns it into a 400.
   */
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > CAPS.documentBytes) {
      await reader.cancel();
      return { status: response.status, text, bytes, contentType, cappedAtLimit: true };
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return { status: response.status, text, bytes, contentType, cappedAtLimit: false };
};

/**
 * Resolve the ingest out of @qaai/agent at CALL time.
 *
 * A dynamic import and a shape check rather than a static import, for one
 * reason worth stating: `ingestApiDocument` lives in a module this router does
 * not own, and a static import of an export that moves or is mid-rewrite fails
 * the whole package's typecheck — which would take both endpoints below down
 * with it. Looked up by name and reported as missing, this door works the day
 * the export is in the barrel and answers 501 honestly before then.
 */
const INGEST_EXPORT = 'ingestApiDocument';

let io: ApiSurfaceIo = {
  ingest: null,
  fetchDocument: realFetch,
  lookup: undefined,
  probeTransport: null,
  probeCredential: null,
  probeClock: SYSTEM_PROBE_CLOCK,
};

/**
 * Point this router at its I/O. Called by the test file with fakes, and by
 * whatever wires the real ingest in once packages/agent exports it.
 *
 * Returns the previous settings so a caller can restore them, which is what
 * keeps one test from leaking a fake into the next.
 */
export function configureApiSurfaceIo(next: Partial<ApiSurfaceIo>): ApiSurfaceIo {
  const previous = io;
  io = { ...io, ...next };
  return previous;
}

/**
 * The ingest, or null when none is wired.
 *
 * Tries the injected one first, then @qaai/agent's named export. The import is
 * wrapped because a package that throws at import time must produce a 501 with
 * a named reason rather than a 500 with a stack trace.
 */
async function resolveIngest(): Promise<ApiDocumentIngestFn | null> {
  if (io.ingest) return io.ingest;
  try {
    const agent = (await import('@qaai/agent')) as Record<string, unknown>;
    const candidate = agent[INGEST_EXPORT];
    return typeof candidate === 'function' ? (candidate as ApiDocumentIngestFn) : null;
  } catch {
    return null;
  }
}

// ─── Caps, every one of which is reported ───────────────────────────────────

/**
 * The caps this router applies.
 *
 * Collected in one record because every one of them, if it bites unreported,
 * moves the coverage percentage in the flattering direction: fewer operations
 * stored is a smaller denominator over the same numerator. The response carries
 * this whole table — not only the entries that bit — so a reader can see the
 * limit that did NOT bite and know the number is whole.
 */
/**
 * How long one document fetch may take before it is abandoned.
 *
 * A fetch with no timeout is an unbounded hold on a request this server took
 * from a caller, and the abort surfaces as a 400 naming the remote rather than
 * as a request that never answers.
 */
const DOCUMENT_FETCH_TIMEOUT_MS = 20_000;

const CAPS = {
  /** Bytes of document accepted, inline or fetched. Refused past this, never cut. */
  documentBytes: 8_000_000,
  /** Operations persisted from one import. Past this the rest are counted, not stored. */
  operations: 5_000,
  /** Rejected-operation reasons echoed back, so a bad document is debuggable. */
  rejectionsListed: 25,
  /** Absent operations named in one response. */
  removedListed: 200,
  /** Per-operation changes named in one response. */
  changesListed: 500,
  /** Operations and registry rows scanned for the reconciliation count. */
  reconcileScan: 10_000,
  /** Default and maximum page size for the read. */
  pageDefault: 100,
  pageMax: 1_000,
  /**
   * Operations handed to the prober in ONE request.
   *
   * Lower than `operations` on purpose and for two different reasons. The
   * probe writes land in one transaction, and a transaction holding thousands
   * of statements open against a customer's database is its own outage. And
   * every probe is unsolicited traffic at somebody's running application: the
   * honest move when this bites is to say "500 of your 1,840 declared
   * operations were probed" and let the caller page on, rather than to quietly
   * probe all of them. The prober's own `probeBudget` is usually the tighter
   * limit; both are reported.
   */
  probeTargets: 500,
  /** Findings echoed in one probe response. */
  findingsListed: 200,
  /** Refused probes named in one response, beside the full count. */
  refusedListed: 200,
  /**
   * Probe rows read PER OPERATION when folding "the newest probe" onto a read.
   *
   * One probe run writes at most four rows for one operation, so eight covers
   * the newest observation twice over. When this cap bites, an operation with
   * no row inside the window is reported NOT_READ and never NEVER_PROBED —
   * see {@link newestObservationOf}.
   */
  probesPerOperationRead: 8,
  /** Operations scanned for the auth-disagreement report. */
  disagreementScan: 1_000,
} as const;

interface CapHit {
  cap: string;
  limit: number;
  droppedAtLeast: number;
}

/**
 * The sentence a reader forwards. Worded once, because the entire value of a
 * disclosed cap is that it reads the same everywhere it appears.
 */
function describeCaps(hits: readonly CapHit[]): string {
  if (hits.length === 0) return 'no cap bit: everything the document declared was accounted for';
  return hits
    .map((hit) => `${hit.cap} (limit ${hit.limit}) hid at least ${hit.droppedAtLeast}`)
    .join('; ');
}

// ─── Canonical content, and the hash a re-import compares ───────────────────

/**
 * A character no document field can contain, used as the field separator.
 * Same device as `requirementCanonicalText` in packages/shared, for the same
 * reason: two fields must not be rearrangeable into one canonical string.
 */
const CANONICAL_SEPARATOR = '\u001f';

/**
 * JSON with object keys in a stable order.
 *
 * `JSON.stringify` preserves insertion order, and a YAML parser's key order
 * follows the document — so re-exporting the same spec from a different tool
 * would produce a different hash and report every operation as CHANGED. That
 * would re-open every link and churn the report until people stop reading it,
 * which is the failure mode `classifyReimport`'s NOT_COMPARABLE member exists
 * to keep rare.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(',')}}`;
}

/**
 * The facts of one operation, as a canonical string.
 *
 * ── What is deliberately NOT in it, each a false CHANGED we would ship ─────
 *
 *   · `evidence`. It is OUR sentence about the row, not the document's content,
 *     and it carries the absence mark below. In the hash, every absent
 *     operation would read as edited on every subsequent import, for ever.
 *   · `sourceDocument`. Provenance. A document that moved from a repo path to a
 *     URL has not been edited, and hashing its location would re-declare every
 *     operation in a project the day a CI job changed how it uploads.
 *   · `verification`, `notProbedReason`, `lastProbedAt`. Those are what WE
 *     observed, and a probe landing must not make the document look edited.
 *
 * Parameters keep their DECLARED ORDER. They are a list in the document and
 * reordering them is an edit to it; sorting here would hide that, and the one
 * consumer (boundary generation) walks them in order.
 */
function operationCanonicalText(operation: {
  method: string;
  pathTemplate: string;
  operationId: string | null;
  authDeclaration: string;
  parameters: unknown;
  requestShape: unknown;
  responseShapes: unknown;
}): string {
  return [
    operation.method.toUpperCase(),
    operation.pathTemplate,
    operation.operationId ?? '',
    operation.authDeclaration,
    stableJson(operation.parameters ?? []),
    stableJson(operation.requestShape ?? null),
    stableJson(operation.responseShapes ?? null),
  ].join(CANONICAL_SEPARATOR);
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * A nullable Json column's write value.
 *
 * `Prisma.DbNull` and NOT `Prisma.JsonNull`, and the two are not
 * interchangeable: `JsonNull` stores the JSON *value* `null` in the column,
 * which reads back as `null` from a row that HAS a value, while `DbNull` stores
 * SQL NULL, which is the column's documented meaning — "the document declared
 * none". Store the first and `requestShape === null` stops being able to tell
 * "the document declares an empty body" from "the document declares nothing",
 * which is the silence-read-as-an-answer defect in miniature.
 */
function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  /*
   * The cast is explicit, and it is narrow on purpose: `unknown` happens to be
   * assignable to this return type only because `typeof Prisma.DbNull` widens
   * the union, so without it the compiler would stop objecting to a value that
   * cannot be serialised. Every caller's value came out of `JSON.parse`, which
   * is what makes the cast true.
   */
  return value === null || value === undefined
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

// ─── The absence mark ────────────────────────────────────────────────────────

/**
 * The sentinel that makes the absence mark removable.
 *
 * `ApiOperation` has no column for "the document stopped declaring this", so
 * the fact is written into `evidence` — where a human reading the row sees it,
 * which is the point. The sentinel exists so a second absent import REPLACES
 * the mark instead of appending a second copy: a row re-imported weekly for a
 * year would otherwise carry 52 of them and `evidence` would stop being a
 * sentence.
 *
 * The clean fix is a column, and it is named in this round's handover. Until
 * then this is a mark a person can read and a machine can remove, which is
 * strictly better than retiring the row or saying nothing.
 */
const ABSENCE_SENTINEL = ' — [ABSENT FROM ITS DOCUMENT';

/** Strip any previous absence mark, leaving the original evidence sentence. */
function withoutAbsenceMark(evidence: string): string {
  const at = evidence.indexOf(ABSENCE_SENTINEL);
  return at < 0 ? evidence : evidence.slice(0, at);
}

/**
 * Re-mark an operation its document no longer declares.
 *
 * ── WHY THE MARK CARRIES A DATE AND NOT A TIMESTAMP ────────────────────────
 *
 * So that marking twice produces the SAME STRING, and a re-import of a
 * still-wrong document writes nothing. With a millisecond in it the mark
 * differed on every import, so an hourly CI upload rewrote `evidence` on every
 * absent operation for ever — churn with no new fact in it, and a doc comment
 * one line above claiming idempotence that the code did not deliver. A mutation
 * run caught it as a test that passed or failed depending on whether two
 * requests landed in the same millisecond.
 *
 * A date is what the mark is FOR: it says "a human should look at this, and it
 * has been true since the 3rd". Nothing reads it as an instant.
 */
function withAbsenceMark(evidence: string, atIso: string): string {
  const base = withoutAbsenceMark(evidence);
  const day = atIso.slice(0, 10);
  const mark =
    `${ABSENCE_SENTINEL} as of ${day}: the document that declared it no longer does. ` +
    `NOT retired — a document uploaded wrongly would otherwise shrink the denominator. ` +
    `Retire it deliberately with POST /api-surface/:projectId/retire]`;
  return `${base}${mark}`.slice(0, 1_000);
}

// ─── Shared plumbing ─────────────────────────────────────────────────────────

async function projectOr404(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, orgId: true, name: true },
  });
  if (!project) throw notFound('Project');
  return project;
}

/**
 * Parses a comma-separated enum list, 400ing on an unknown name.
 *
 * The same shape as `parseList` in routes/surface.ts, and copied rather than
 * imported: a router importing another router's internals couples their module
 * load order for a nine-line helper. If a third ingest door needs it, lib/ is
 * the right home.
 *
 * An unknown filter value must never answer with an empty list — `?auth=NON`
 * (one letter short of NONE) reading as "no operation is declared public" is
 * the opposite of the truth and the most dangerous answer this endpoint has.
 */
function parseList<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  const bad = parts.filter((part) => !allowed.includes(part as T));
  if (bad.length > 0) {
    throw badRequest(
      `Unknown ${field}: ${bad.join(', ')}. Valid values are ${allowed.join(', ')}.`,
    );
  }
  return parts as T[];
}

/**
 * The registry key an operation would occupy.
 *
 * Built with `surfaceKey` and `endpointIdentity` and NEVER by hand: six writers
 * have to agree on this string byte for byte or the same endpoint enters the
 * inventory twice and the denominator inflates. `canonicalRoute` inside
 * `endpointIdentity` collapses `/orders/{id}`, `/orders/[id]` and
 * `/orders/:orderId` onto `/orders/:param`, which is what lets a document's
 * operation match a crawled call at all.
 *
 * One consequence worth knowing: a document that declares the same endpoint
 * twice under two parameter names keeps TWO `ApiOperation` rows — the identity
 * there is the document's own spelling, by design — and both map to one
 * registry key. The reconciliation count below therefore compares a document's
 * spelling count against the registry's canonical count, and the two can differ
 * for a malformed document. That is visible in `declaredOperations` rather than
 * hidden, which is the right place for it.
 */
function registryKeyFor(method: string, pathTemplate: string): string {
  return surfaceKey('ENDPOINT', endpointIdentity(method, pathTemplate));
}

/**
 * The declarers recorded on a `CoverageItem` row, as a typed list.
 *
 * `sources` is `Json?` and its three states are the contract: absent/null means
 * nobody recorded a declarer (which `originFromSources` answers with null, not
 * with a guess), and a list is the fact. Unknown strings are dropped rather
 * than passed through, so a row written by a future writer cannot put a value
 * the vocabulary does not hold into a response.
 */
function sourcesOf(raw: unknown): SurfaceSource[] | null {
  if (!Array.isArray(raw)) return null;
  const known = raw.filter((entry): entry is SurfaceSource =>
    (['CRAWL', 'SOURCE', 'SITEMAP', 'OPENAPI', 'TRAFFIC', 'REQUIREMENT', 'MANUAL', 'CATALOGUE'] as const).includes(
      entry as SurfaceSource,
    ),
  );
  return known;
}

interface RegistryView {
  key: string;
  /** Null when the registry has no LIVE row for this operation. */
  status: SurfaceStatus | null;
  /** Null when the row records no declarer — never defaulted to a guess. */
  origin: SurfaceOrigin | null;
  sources: SurfaceSource[] | null
  ;
  inRegistry: boolean;
  /**
   * Whether the registry HAD a row for this operation and it was retired.
   *
   * ── WHY THIS IS NOT FOLDED INTO `inRegistry: false` ──────────────────────
   *
   * Because the two facts have opposite remedies and the common case is the
   * one that was being mislabelled. `computeCoverage` retires every registry
   * row its own inputs do not re-declare, so an endpoint this document
   * declares will routinely have a RETIRED `CoverageItem` — and reading that
   * as "no row at all" made the reconciliation sentence below say "no crawl
   * and no source detector has ever seen them" about surfaces a crawl had
   * seen and something later retired. One of those is a gap in our
   * enumeration; the other is a decision somebody took. Three states:
   * `false` means a live row is absent and the registry never held one,
   * `true` means it held one and it is retired, and `null` means this row's
   * retirement was not looked at.
   */
  retiredInRegistry: boolean | null;
}

// ─── POST /api-surface/:projectId ───────────────────────────────────────────

const ingestBody = z
  .object({
    /** The document itself. Mutually exclusive with `url`. */
    document: z.string().min(1).optional(),
    /** Where to fetch it from. Mutually exclusive with `document`. */
    url: z.string().trim().url().max(2_000).optional(),
    /**
     * What to call this document in `ApiOperation.sourceDocument`. Defaults to
     * the URL, or to a fixed label for an inline upload — never to a timestamp,
     * which would make every upload a new document and every operation a
     * redeclaration.
     */
    sourceDocument: z.string().trim().min(1).max(2_000).optional(),
    /**
     * A hint. The parser decides and its verdict is reported beside this, so a
     * caller who said OPENAPI and uploaded a Postman collection is told.
     *
     * The authoritative vocabulary belongs to the parser; this list is the one
     * this router will forward, and an unknown value is a 400 rather than a
     * silent AUTO — a typo that falls back to detection is a typo nobody ever
     * finds.
     */
    format: z.enum(['AUTO', 'OPENAPI', 'SWAGGER', 'ASYNCAPI', 'POSTMAN']).default('AUTO'),
    /** Parse and diff, write nothing. The response is identical but `applied`. */
    dryRun: z.boolean().default(false),
  })
  .refine((body) => (body.document === undefined) !== (body.url === undefined), {
    message: 'Send exactly one of `document` (the text) or `url` (where to fetch it).',
    path: ['document'],
  });

/** What one parsed operation turned out to be, against what is stored. */
type OperationChange = 'NEW' | 'UNCHANGED' | 'CHANGED' | 'REDECLARED' | 'REINSTATED';

interface ChangeRow {
  key: string;
  method: string;
  pathTemplate: string;
  change: OperationChange;
  detail: string;
}

/**
 * Fetch a document, refusing the hosts a URL ingest must not reach.
 *
 * This endpoint takes a URL from a caller and makes this server open it, which
 * is the shape of every SSRF. `resolvesPublicly` is a CHECK and not a pin — the
 * connection resolves the name again — and this router must not describe it as
 * a guarantee; it is the same defence routes/issues.ts applies to a Jira base
 * URL, applied in the same place.
 */
async function fetchDocumentOr400(url: string): Promise<FetchedDocument> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest(`"${url}" is not a URL this server can open.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw badRequest(`Refusing ${parsed.protocol} — a document URL must be http or https.`);
  }

  const host = classifyHost(parsed.hostname);
  if (host.kind === 'ambiguous') {
    throw badRequest(`Refusing ${parsed.hostname}: ${host.why}.`);
  }
  const verdict = await resolvesPublicly(parsed.hostname, io.lookup);
  if (!verdict.ok) throw badRequest(verdict.reason);

  let fetched: FetchedDocument;
  try {
    fetched = await io.fetchDocument(parsed.toString());
  } catch (err) {
    // The remote's failure is the caller's problem to fix and must not surface
    // as an opaque 500 from this process.
    throw badRequest(
      `Fetching ${parsed.toString()} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    throw badRequest(`${parsed.toString()} answered ${fetched.status}; no document was read.`);
  }
  if (fetched.bytes > CAPS.documentBytes) {
    // Refused, not truncated. Half a document parses into fewer operations,
    // and fewer operations is the direction that flatters the percentage.
    //
    // "at least" when the read stopped at the cap: `bytes` is then a floor on
    // the document's size and naming it as the size would be inventing a
    // figure for something that was never read to the end.
    const size = fetched.cappedAtLimit === true ? `at least ${fetched.bytes}` : `${fetched.bytes}`;
    throw badRequest(
      `That document is ${size} bytes and the limit is ${CAPS.documentBytes}. ` +
        'It is refused rather than truncated: a partial document declares fewer operations, ' +
        'which would raise the coverage percentage without anything being tested.',
    );
  }
  if (!fetched.text.trim()) {
    throw badRequest(`${parsed.toString()} answered ${fetched.status} with an empty body.`);
  }
  return fetched;
}

apiSurfaceRouter.post(
  '/api-surface/:projectId',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsedBody = ingestBody.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      throw badRequest(parsedBody.error.issues[0]?.message ?? 'Invalid body', {
        fieldErrors: parsedBody.error.flatten().fieldErrors,
      });
    }
    const body = parsedBody.data;
    const project = await projectOr404(String(req.params.projectId));

    const ingest = await resolveIngest();
    if (!ingest) {
      // 501 and the export's name. Answering 200 with no operations would say
      // "this document declares nothing", which is a measured claim about the
      // customer's application made from our own missing dependency.
      throw notImplemented(
        `API document ingest — @qaai/agent exports no \`${INGEST_EXPORT}\`, so nothing was read`,
      );
    }

    let text: string;
    let sourceDocument: string;
    let fetchedBytes: number | null = null;
    if (body.url !== undefined) {
      const fetched = await fetchDocumentOr400(body.url);
      text = fetched.text;
      fetchedBytes = fetched.bytes;
      sourceDocument = body.sourceDocument ?? body.url;
    } else {
      text = body.document as string;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > CAPS.documentBytes) {
        throw badRequest(
          `That document is ${bytes} bytes and the limit is ${CAPS.documentBytes}. ` +
            'It is refused rather than truncated: a partial document declares fewer operations, ' +
            'which would raise the coverage percentage without anything being tested.',
        );
      }
      sourceDocument = body.sourceDocument ?? 'inline upload';
    }

    const documentHash = sha256(text);

    /*
     * ── DECODING IS THIS ROUTER'S JOB; PARSING IS THE INGEST'S ──────────────
     *
     * `ingestApiDocument` takes an already-decoded document, so the bytes stop
     * here. There is no YAML decoder in this build — `yaml` is not a dependency
     * of any workspace — and a YAML OpenAPI document is therefore REFUSED with
     * a 422 that says so. It is not handed on as a string to come back as "this
     * document declares no operations": "we cannot read it" and "it declares
     * nothing" are opposite facts, and the second one is a claim about the
     * customer's application made out of a missing dependency.
     */
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw unprocessable(
        'That document is not JSON. This build has no YAML decoder, so it was NOT read and ' +
          'nothing is claimed about what it declares — convert it to JSON and upload again.',
      );
    }

    let ingested: ApiDocumentIngestResult;
    try {
      ingested = await ingest({ document, sourceDocument });
    } catch (err) {
      // A document we cannot read is the caller's to fix, and the message says
      // what the ingest objected to. Never a 500, and never an empty success.
      throw badRequest(
        `That document could not be parsed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }

    /*
     * The parser's output is validated here even though the parser is ours.
     *
     * Two reasons. It is a different package written by different hands, and a
     * row that fails `apiOperationSchema` would otherwise reach a `create` and
     * surface as a 500 at the database. And a dropped row is a shrunk
     * denominator: every rejection is counted and the first few are echoed with
     * their reason, so a systematically wrong parse is visible rather than
     * quietly smaller.
     */
    const accepted: ApiOperationInput[] = [];
    const rejections: Array<{ index: number; reason: string }> = [];
    for (const [index, raw] of ingested.operations.entries()) {
      const candidate = apiOperationSchema.safeParse(raw);
      if (!candidate.success) {
        if (rejections.length < CAPS.rejectionsListed) {
          const issue = candidate.error.issues[0];
          rejections.push({
            index,
            reason: `${(issue?.path ?? []).join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`,
          });
        }
        continue;
      }
      accepted.push(candidate.data);
    }
    const rejectedCount = ingested.operations.length - accepted.length;

    /*
     * Two documents can declare the same operation, and the identity is
     * (method, pathTemplate) by design — see the note on ApiOperation's unique
     * constraint. Deduplicating here keeps one import from issuing two upserts
     * against one row, where the second would silently win with no record that
     * the document said it twice.
     */
    const byIdentity = new Map<string, ApiOperationInput>();
    let duplicateDeclarations = 0;
    for (const operation of accepted) {
      const identity = `${operation.method.toUpperCase()} ${operation.pathTemplate}`;
      if (byIdentity.has(identity)) {
        duplicateDeclarations += 1;
        continue;
      }
      byIdentity.set(identity, operation);
    }

    /*
     * The ingest's cap ledger, projected onto this response's shape.
     *
     * `discarded` is the ingest's own LOWER bound on what a cap cost — it
     * counts candidates it actually held and dropped — so it maps onto
     * `droppedAtLeast` unchanged. `bites` (how many times the limit fired) is a
     * different number and is NOT substituted for it: reporting "the operation
     * budget hid at least 1" when it fired once but discarded 900 would be a
     * disclosed cap with an invented size, which is its own kind of lie.
     */
    const capsThatBit: CapHit[] = (ingested.caps ?? []).map((bite) => ({
      cap: bite.cap,
      limit: bite.limit,
      droppedAtLeast: bite.discarded ?? 0,
    }));
    let toStore = [...byIdentity.values()];
    if (toStore.length > CAPS.operations) {
      const dropped = toStore.length - CAPS.operations;
      toStore = toStore.slice(0, CAPS.operations);
      capsThatBit.push({ cap: 'operations', limit: CAPS.operations, droppedAtLeast: dropped });
    }

    /*
     * Everything already stored for this project that either this document
     * declares now or declared before. `select` is explicit and narrow: the
     * compare fields, the document reference, and `retiredAt` — which decides
     * whether a redeclared operation is being reinstated.
     */
    const stored = await prisma.apiOperation.findMany({
      where: { projectId: project.id },
      select: {
        id: true,
        method: true,
        pathTemplate: true,
        operationId: true,
        authDeclaration: true,
        parameters: true,
        requestShape: true,
        responseShapes: true,
        sourceDocument: true,
        evidence: true,
        retiredAt: true,
      },
    });
    const storedByIdentity = new Map(
      stored.map((row) => [`${row.method.toUpperCase()} ${row.pathTemplate}`, row]),
    );

    const now = new Date();
    const nowIso = now.toISOString();
    const changes: ChangeRow[] = [];
    const counts = { new: 0, unchanged: 0, changed: 0, redeclared: 0, reinstated: 0 };
    /** Operations that were marked absent and are declared again. See below. */
    let absenceMarksCleared = 0;
    const writes: Array<() => Promise<unknown>> = [];

    for (const operation of toStore) {
      const identity = `${operation.method.toUpperCase()} ${operation.pathTemplate}`;
      const existing = storedByIdentity.get(identity);
      const key = registryKeyFor(operation.method, operation.pathTemplate);
      const nextHash = sha256(operationCanonicalText(operation));

      const record = (change: OperationChange, detail: string) => {
        counts[
          change === 'NEW'
            ? 'new'
            : change === 'UNCHANGED'
              ? 'unchanged'
              : change === 'CHANGED'
                ? 'changed'
                : change === 'REDECLARED'
                  ? 'redeclared'
                  : 'reinstated'
        ] += 1;
        if (changes.length < CAPS.changesListed) {
          changes.push({
            key,
            method: operation.method,
            pathTemplate: operation.pathTemplate,
            change,
            detail,
          });
        }
      };

      if (!existing) {
        record('NEW', 'no row for this method and path template existed');
        writes.push(() =>
          prisma.apiOperation.create({
            data: {
              orgId: project.orgId,
              projectId: project.id,
              method: operation.method,
              pathTemplate: operation.pathTemplate,
              operationId: operation.operationId,
              sourceDocument,
              evidence: operation.evidence,
              authDeclaration: operation.authDeclaration,
              parameters: operation.parameters,
              requestShape: jsonOrNull(operation.requestShape),
              responseShapes: jsonOrNull(operation.responseShapes),
            },
            select: { id: true },
          }),
        );
        continue;
      }

      const data: Prisma.ApiOperationUpdateInput = {
        operationId: operation.operationId,
        sourceDocument,
        authDeclaration: operation.authDeclaration,
        parameters: operation.parameters,
        requestShape: jsonOrNull(operation.requestShape),
        responseShapes: jsonOrNull(operation.responseShapes),
        evidence: operation.evidence,
        lastSeenAt: now,
      };

      if (existing.retiredAt !== null) {
        /*
         * A retired operation the document declares again. Reinstated, and
         * REPORTED as reinstated: somebody retired this row on purpose, and a
         * later document quietly resurrecting it without a line in the response
         * is a denominator that grew for a reason nobody can find.
         */
        data.retiredAt = null;
        record('REINSTATED', 'a retired operation is declared again by this document');
      } else if (existing.sourceDocument !== sourceDocument) {
        /*
         * The row exists and another declarer wrote it — a source detector, a
         * crawl, or a second document.
         *
         * This is NOT "changed". `classifyReimport`'s NOT_COMPARABLE member
         * names exactly this case: there is no previous version of THIS
         * document to diff against, so "the source has been edited" is
         * unprovable. Calling it CHANGED would re-declare the whole API on the
         * day a customer uploads a second spec.
         */
        record(
          'REDECLARED',
          `previously declared by ${existing.sourceDocument}; this document now declares it, ` +
            'so "changed" and "unchanged" are both unprovable against it',
        );
      } else {
        const previousHash = sha256(
          operationCanonicalText({
            method: existing.method,
            pathTemplate: existing.pathTemplate,
            operationId: existing.operationId,
            authDeclaration: existing.authDeclaration,
            parameters: existing.parameters,
            requestShape: existing.requestShape,
            responseShapes: existing.responseShapes,
          }),
        );
        if (previousHash === nextHash) {
          /*
           * Nothing but `lastSeenAt` — and the absence mark, if one is there.
           *
           * ── THE DEFECT THIS `wasAbsent` BRANCH FIXES ─────────────────────
           *
           * `evidence` is deliberately NOT in the canonical hash, so an
           * operation that was marked ABSENT and is then declared again hashes
           * UNCHANGED. Without clearing the mark here, that row kept "ABSENT
           * FROM ITS DOCUMENT" for ever: the document declares it, the report
           * says it does not, and nothing a customer can do removes the line.
           * A stale mark is a false fact on a dashboard, so the mark goes and
           * the clearing is COUNTED rather than done silently.
           */
          const wasAbsent = existing.evidence.includes(ABSENCE_SENTINEL);
          if (wasAbsent) absenceMarksCleared += 1;
          record(
            'UNCHANGED',
            wasAbsent
              ? 'the operation hashes identically to the stored row, and the absence mark is ' +
                  'cleared: this document declares it again'
              : 'the operation hashes identically to the stored row',
          );
          writes.push(() =>
            prisma.apiOperation.update({
              where: { id: existing.id },
              data: {
                lastSeenAt: now,
                ...(wasAbsent ? { evidence: operation.evidence } : {}),
              },
              select: { id: true },
            }),
          );
          continue;
        }
        record('CHANGED', 'the operation differs from the stored copy of the same document');
      }

      writes.push(() =>
        prisma.apiOperation.update({ where: { id: existing.id }, data, select: { id: true } }),
      );
    }

    /*
     * What this document used to declare and no longer does.
     *
     * Only rows whose `sourceDocument` is THIS document: an operation a source
     * detector found is not missing from an OpenAPI file that never claimed it,
     * and treating it as absent would put a mark on a row this import has no
     * opinion about.
     */
    const absent = stored.filter(
      (row) =>
        row.sourceDocument === sourceDocument &&
        row.retiredAt === null &&
        !byIdentity.has(`${row.method.toUpperCase()} ${row.pathTemplate}`),
    );
    for (const row of absent) {
      const marked = withAbsenceMark(row.evidence, nowIso);
      // Already marked today: no write at all. The row is still counted and
      // still listed in `removed` — the response is about what IS, not about
      // what this request happened to touch.
      if (marked === row.evidence) continue;
      writes.push(() =>
        prisma.apiOperation.update({
          where: { id: row.id },
          data: { evidence: marked },
          select: { id: true },
        }),
      );
    }

    if (!body.dryRun) {
      // Sequential rather than Promise.all: these are upserts against one
      // table and a large document would otherwise open five thousand
      // connections at once. The import is not on a latency budget.
      for (const write of writes) await write();
    }

    const removedListed = absent.slice(0, CAPS.removedListed);
    const absentCapBit = absent.length > removedListed.length;
    if (absentCapBit) {
      capsThatBit.push({
        cap: 'removedListed',
        limit: CAPS.removedListed,
        droppedAtLeast: absent.length - removedListed.length,
      });
    }
    if (changes.length < counts.new + counts.unchanged + counts.changed + counts.redeclared + counts.reinstated) {
      capsThatBit.push({
        cap: 'changesListed',
        limit: CAPS.changesListed,
        droppedAtLeast:
          counts.new +
          counts.unchanged +
          counts.changed +
          counts.redeclared +
          counts.reinstated -
          changes.length,
      });
    }

    const actor = actorOf(req);
    // Counts and a hash. The document body is not written to the audit log,
    // to a row, or to a log line — the same rule routes/traffic.ts follows.
    await audit({
      actor,
      action: 'apiSurface.ingest',
      targetType: 'Project',
      targetId: project.id,
      metadata: {
        sourceDocument,
        documentHash,
        format: ingested.kind,
        declared: ingested.operations.length,
        stored: toStore.length,
        rejected: rejectedCount,
        absent: absent.length,
        dryRun: body.dryRun,
        capsThatBit,
      },
    });

    res.status(body.dryRun ? 200 : 201).json({
      projectId: project.id,
      applied: !body.dryRun,
      sourceDocument,
      documentHash,
      /**
       * The hash is COMPUTED and not STORED, and saying so is the difference
       * between a fact and a claim. No column holds a document-level hash, so
       * this router cannot answer "we have seen this exact document before" —
       * it answers the stronger per-operation question instead, by hashing each
       * stored row's own facts. A caller that wants document-level idempotency
       * compares this value itself.
       */
      documentHashStored: false,
      documentHashNote:
        'computed from the uploaded bytes for this response only; no column stores it, so ' +
        'idempotency is decided per operation by comparing each stored row’s own facts',
      bytes: fetchedBytes ?? Buffer.byteLength(text, 'utf8'),
      format: { requested: body.format, detected: ingested.kind },
      totals: {
        declaredByDocument: ingested.operations.length,
        accepted: accepted.length,
        rejected: rejectedCount,
        duplicateDeclarations,
        stored: toStore.length,
        ...counts,
        absentFromDocument: absent.length,
        /**
         * Operations that carried an absence mark and are declared again. A
         * count rather than a silent cleanup: a row that stopped being absent
         * is a denominator fact changing, and the response says which rows.
         */
        absenceMarksCleared,
      },
      changes,
      changesLimit: CAPS.changesListed,
      /**
       * Named, not deleted. `requiresDecision` is the flag a cockpit reads to
       * offer the retire button; nothing here retires anything.
       */
      removed: {
        items: removedListed.map((row) => ({
          key: registryKeyFor(row.method, row.pathTemplate),
          method: row.method,
          pathTemplate: row.pathTemplate,
          requiresDecision: true,
          retireWith: `POST /api-surface/${project.id}/retire`,
        })),
        total: absent.length,
        truncated: absentCapBit,
        limit: CAPS.removedListed,
        rule:
          'an operation missing from a new version of a document is marked and kept. A document ' +
          'uploaded wrongly would otherwise shrink the denominator and raise the coverage ' +
          'percentage with nothing tested.',
      },
      rejections,
      rejectionsLimit: CAPS.rejectionsListed,
      caps: CAPS,
      /**
       * The one cap in that table this router does not own.
       *
       * An inline `document` arrives through the API's global JSON body parser,
       * whose limit is smaller than `documentBytes` — so for an inline upload
       * the EFFECTIVE limit is the parser's, and a larger body is refused by it
       * with a 413 before this handler runs. Printing `documentBytes` on its
       * own would advertise an allowance an inline caller cannot use, and the
       * 413 says nothing about which limit it was. Fetching by `url` has no
       * body parser in front of it and gets the whole allowance.
       */
      inlineLimitNote:
        'an inline `document` also passes through the API’s global JSON body limit, which is ' +
        'smaller than documentBytes; a larger inline body is refused by the body parser with a ' +
        '413 before this endpoint sees it. Send `url` instead to use the full allowance.',
      capsThatBit,
      capRule: describeCaps(capsThatBit),
      /**
       * The ingest's caveats, plus the one this router can see that it cannot:
       * the caller declared a format and the document is a different one. That
       * mismatch is the difference between "QAAI read my gateway spec" and
       * "QAAI read the Postman collection I uploaded by mistake", and nobody
       * finds it if both sides silently believe themselves.
       */
      warnings: [
        ...(ingested.caveats ?? []),
        ...(body.format !== 'AUTO' && ingested.kind !== body.format
          ? [
              `you declared format ${body.format} and the ingest read this document as ` +
                `${ingested.kind}; the operations below come from what it actually is`,
            ]
          : []),
      ],
      ingest: {
        export: INGEST_EXPORT,
        injected: io.ingest !== null,
        documentKind: ingested.kind,
        documentVersion: ingested.version,
        /** Carried through untouched: what the document did NOT say, named. */
        gaps: ingested.gaps ?? [],
      },
    });
  },
);

// ─── POST /api-surface/:projectId/retire ────────────────────────────────────

const retireBody = z.object({
  method: z.enum(API_OPERATION_METHODS),
  pathTemplate: z.string().trim().min(1).max(2_000),
  /**
   * Required, and not allowed to be a shrug — the same contract as a coverage
   * waiver's reason. Retiring takes a surface out of the denominator, and one
   * with no stated reason is indistinguishable from a number being gamed.
   */
  reason: z.string().trim().min(10).max(1_000),
});

apiSurfaceRouter.post(
  '/api-surface/:projectId/retire',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsed = retireBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
    const { method, pathTemplate, reason } = parsed.data;
    const project = await projectOr404(String(req.params.projectId));

    const operation = await prisma.apiOperation.findUnique({
      where: {
        projectId_method_pathTemplate: { projectId: project.id, method, pathTemplate },
      },
      select: { id: true, evidence: true, retiredAt: true },
    });
    // Retiring something that is not in the inventory would record an exclusion
    // for a row nobody can see, which is worse than refusing.
    if (!operation) throw notFound('API operation');
    if (operation.retiredAt !== null) {
      throw badRequest('That operation is already retired.');
    }

    const actor = actorOf(req);
    const at = new Date();
    await prisma.apiOperation.update({
      where: { id: operation.id },
      data: {
        retiredAt: at,
        /*
         * The absence mark goes, and the reason replaces it. Leaving the mark
         * on a retired row would say both "not retired, decide about this" and
         * "retired", and a reader cannot act on a row that says both.
         */
        evidence: `${withoutAbsenceMark(operation.evidence)} — retired ${at.toISOString()}: ${reason}`.slice(
          0,
          1_000,
        ),
      },
      select: { id: true },
    });

    await audit({
      actor,
      action: 'apiSurface.retire',
      targetType: 'ApiOperation',
      targetId: operation.id,
      metadata: { method, pathTemplate, reason },
    });

    res.status(200).json({
      projectId: project.id,
      key: registryKeyFor(method, pathTemplate),
      retiredAt: at.toISOString(),
      reason,
    });
  },
);

// ─── The probe rows: reading them back, which is the same shape twice ───────

/**
 * One `ApiOperationProbe` row, as every read below needs it.
 *
 * Declared rather than inferred so that the `select` in
 * {@link readProbeWindow} and the response shapes cannot drift apart: the
 * whole point of this table is that `status`, `verbAllowed` and
 * `authRequiredInFact` are three-state, and a field quietly dropped from a
 * query reads back as `undefined` — which `JSON.stringify` deletes, so the
 * response would not even carry a null.
 */
interface ProbeRowRead {
  id: string;
  operationId: string;
  status: number | null;
  verbAllowed: boolean | null;
  authRequiredInFact: boolean | null;
  answered: boolean;
  detail: string;
  observedAt: Date;
  environmentId: string | null;
}

const PROBE_ROW_SELECT = {
  id: true,
  operationId: true,
  status: true,
  verbAllowed: true,
  authRequiredInFact: true,
  answered: true,
  detail: true,
  observedAt: true,
  environmentId: true,
} as const;

/** The row as a response carries it. A null STAYS null; nothing is coalesced. */
function probeRowView(row: ProbeRowRead): {
  status: number | null;
  answered: boolean;
  verbAllowed: boolean | null;
  authRequiredInFact: boolean | null;
  detail: string;
  observedAtIso: string;
  environmentId: string | null;
} {
  return {
    /*
     * `?? 0` ANYWHERE IN THIS FUNCTION WOULD BE THE DEFECT THE TABLE EXISTS TO
     * PREVENT. `status: null` means nothing answered; a 0 would read as a
     * status, and `verbAllowed: false` is "the application refused the verb"
     * where null is "a 404 settled nothing".
     */
    status: row.status,
    answered: row.answered,
    verbAllowed: row.verbAllowed,
    authRequiredInFact: row.authRequiredInFact,
    detail: row.detail,
    observedAtIso: row.observedAt.toISOString(),
    environmentId: row.environmentId,
  };
}

interface ProbeWindow {
  /** Rows per operation id, NEWEST FIRST. */
  byOperation: Map<string, ProbeRowRead[]>;
  /**
   * True when this window's own cap bit, which changes the meaning of an
   * operation that has no rows in it from "never probed" to "not read".
   */
  truncated: boolean;
  limit: number;
}

/**
 * The newest probe rows for a set of operations, in ONE query.
 *
 * ── WHY THE ORDER IS (operationId, observedAt desc) AND NOT observedAt ALONE ─
 *
 * Because a global `observedAt desc` with a take is a lie waiting to happen: a
 * chatty operation with a thousand recent rows would crowd another operation's
 * rows out of the window entirely, and that operation would then be reported
 * with no newest probe — which reads as "nothing has ever probed this". With
 * the rows grouped by operation first, every operation up to the last one in
 * the window has its NEWEST rows (that is what the per-group `observedAt desc`
 * guarantees), and what truncation costs is whole operations at the tail
 * rather than a random operation's history. Those are then reported NOT_READ.
 *
 * `@@index([operationId, observedAt])` on the model is exactly this query.
 */
async function readProbeWindow(operationIds: readonly string[]): Promise<ProbeWindow> {
  if (operationIds.length === 0) {
    return { byOperation: new Map(), truncated: false, limit: CAPS.probesPerOperationRead };
  }
  // One past the window, which is how truncation is DETECTED rather than
  // assumed: `rows.length === take` can only happen if at least one more row
  // existed.
  const take = operationIds.length * CAPS.probesPerOperationRead + 1;
  const rows = await prisma.apiOperationProbe.findMany({
    where: { operationId: { in: [...operationIds] } },
    orderBy: [{ operationId: 'asc' }, { observedAt: 'desc' }],
    take,
    select: PROBE_ROW_SELECT,
  });

  const byOperation = new Map<string, ProbeRowRead[]>();
  for (const row of rows) {
    const list = byOperation.get(row.operationId);
    if (list) list.push(row);
    else byOperation.set(row.operationId, [row]);
  }
  return {
    byOperation,
    truncated: rows.length === take,
    limit: CAPS.probesPerOperationRead,
  };
}

/**
 * How much one probe row DETERMINED, used only to break a tie.
 *
 * One probe run writes up to four rows for one operation — the declared
 * request, the credentialled half, a bad id, an undeclared verb — and they
 * share the run's `observedAt`, because they are one observation. So "the
 * newest probe" is ambiguous inside a run, and `ApiOperationProbe` has no
 * `kind` column to disambiguate it with (the prober's `ApiProbeKind` has no
 * home on the row). Picking the row that determined the most facts is the
 * least misleading answer available: it prefers the row that established
 * `authRequiredInFact` over the OPTIONS probe that established nothing, so the
 * operation read and the disagreement read below cannot contradict each other
 * inside one report.
 */
function determinationScore(row: ProbeRowRead): number {
  return (
    (row.authRequiredInFact !== null ? 4 : 0) +
    (row.verbAllowed !== null ? 2 : 0) +
    (row.answered ? 1 : 0)
  );
}

/** Three states, because `null` cannot mean both "never" and "not looked at". */
type ProbeReadState = 'OBSERVED' | 'NEVER_PROBED' | 'NOT_READ';

/**
 * The newest observation for one operation, folded for a read.
 *
 * NEVER_PROBED is only ever answered when the window was COMPLETE. When the
 * window's cap bit, an operation with no rows in it is NOT_READ — we did not
 * look, which is not the same fact as "nothing has asked this application
 * about this operation", and the two have different remedies.
 */
function newestObservationOf(
  window: ProbeWindow,
  operationId: string,
): {
  state: ProbeReadState;
  probe: ReturnType<typeof probeRowView> | null;
  /** How many rows shared that `observedAt` — the rest are in the history read. */
  probesInObservation: number;
} {
  const rows = window.byOperation.get(operationId);
  if (!rows || rows.length === 0) {
    return {
      state: window.truncated ? 'NOT_READ' : 'NEVER_PROBED',
      probe: null,
      probesInObservation: 0,
    };
  }
  // Rows arrive newest first, so the head carries the newest observation's time.
  const newestAt = rows[0]!.observedAt.getTime();
  const sameObservation = rows.filter((row) => row.observedAt.getTime() === newestAt);
  let best = sameObservation[0]!;
  for (const row of sameObservation.slice(1)) {
    const better = determinationScore(row) - determinationScore(best);
    // The id is an ARBITRARY but stable tiebreak between two equally
    // determined rows of one observation; `probesInObservation` discloses that
    // there were others and the history read has all of them.
    if (better > 0 || (better === 0 && row.id < best.id)) best = row;
  }
  return {
    state: 'OBSERVED',
    probe: probeRowView(best),
    probesInObservation: sameObservation.length,
  };
}

/**
 * What the APPLICATION said about authentication, as opposed to the newest row.
 *
 * ── WHY THIS IS NOT `newestProbe.authRequiredInFact` ────────────────────────
 *
 * Because a later row with a null would then erase an earlier row's finding,
 * and the report would say "we could not judge this" about an operation we
 * judged. Null on a row means NOT DETERMINED BY THAT ROW — it is not a
 * retraction — so the answer is the newest row that determined anything, with
 * the date it determined it on, which is what lets a reader see a stale
 * finding as stale instead of as current.
 */
function determinedAuthOf(rows: readonly ProbeRowRead[] | undefined): {
  value: boolean | null;
  observedAtIso: string | null;
} {
  for (const row of rows ?? []) {
    if (row.authRequiredInFact !== null) {
      return { value: row.authRequiredInFact, observedAtIso: row.observedAt.toISOString() };
    }
  }
  return { value: null, observedAtIso: null };
}

// ─── POST /api-surface/:projectId/probe ─────────────────────────────────────

/**
 * The probe door: what answered when we actually asked.
 *
 * `ApiOperation.verification` has had exactly one writer since the model
 * landed — the ingest above, which writes DECLARED — and `ApiOperationProbe`
 * had none at all. The prober in packages/agent/src/api-surface.ts is built
 * and tested and its output went nowhere, so the question a customer most
 * wants answered about an API document ("is any of this actually deployed, and
 * does the application agree with the document about who may call it?") was a
 * schema entry for a feature that did not exist. This is its door.
 *
 * ── THE RULES, EVERY ONE OF WHICH IS A SAFETY RULE ──────────────────────────
 *
 *   · READ-ONLY BY DEFAULT. `SAFE_PROBE_METHODS` and nothing else, unless BOTH
 *     `allowUnsafeVerbs` (this request) and `policy.allowDestructive` (the
 *     environment's stored policy) are set. The prober enforces the two-key
 *     rule; this door's job is to pass the two keys SEPARATELY and never to
 *     synthesise one from the other — "this environment is disposable" and
 *     "send a DELETE at it" are different claims by different people.
 *   · A REFUSAL IS RECORDED. Everything the prober declined comes back in
 *     `refused` with the rule that declined it, and the operation's
 *     verification becomes NOT_PROBED with its reason. A refused surface and a
 *     surface that does not exist are opposite facts.
 *   · THE HOST IS CLASSIFIED BEFORE ANYTHING CONNECTS. An environment's base
 *     URL is customer-supplied data, so it goes through `classifyHost` and
 *     `resolvesPublicly` exactly as a document URL does, and the transport is
 *     not reached at all when the host is refused.
 *   · NO TRANSPORT IS A 501. A 200 reading "0 probes, nothing disagrees" is a
 *     measured claim about the customer's application manufactured out of our
 *     own missing dependency.
 *   · A CREDENTIAL VALUE IS NEVER WRITTEN DOWN — not to a probe row, not to
 *     the audit log, not to a response, not truncated and not hashed. The
 *     credential's LABEL appears in the prober's `detail` sentences by design
 *     ("`staging token` was accepted (200)"); its headers never leave the
 *     transport.
 */

const probeBody = z.object({
  /**
   * Where to probe. Optional, and its absence is a FIRST-CLASS case rather
   * than an error: with no environment there is no base URL, every operation
   * comes back NOT_PROBED / NO_BASE_URL, and that is a configuration a
   * customer fixes in a minute — nothing like "this operation does not exist".
   */
  environmentId: z.string().trim().min(1).max(200).optional(),
  /** Comma-separated HTTP methods, or UNKNOWN. Applied BEFORE the target cap. */
  method: z.string().optional(),
  /** Comma-separated ApiAuthDeclaration values. */
  auth: z.string().optional(),
  /** Comma-separated ApiOperationVerification values. */
  verification: z.string().optional(),
  /**
   * One of the two keys that allow a verb outside {@link SAFE_PROBE_METHODS}.
   * The other is `allowDestructive` on the environment's stored crawl policy,
   * and NEITHER implies the other.
   */
  allowUnsafeVerbs: z.boolean().default(false),
});

/**
 * Refuse a base URL this server must not open.
 *
 * The same defence `fetchDocumentOr400` applies to a document URL, applied to
 * an environment's base URL for the same reason: it is customer-supplied data
 * that makes this server open a connection, which is the shape of every SSRF.
 * `resolvesPublicly` is a CHECK and not a pin — the connection resolves the
 * name again — and this router must not describe it as a guarantee.
 */
async function probeBaseUrlOr400(baseUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw badRequest(
      `That environment's base URL (${baseUrl}) is not a URL this server can open, so no probe ` +
        'was issued.',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw badRequest(`Refusing ${parsed.protocol} — a base URL must be http or https.`);
  }
  const host = classifyHost(parsed.hostname);
  if (host.kind === 'ambiguous') {
    throw badRequest(`Refusing to probe ${parsed.hostname}: ${host.why}.`);
  }
  const verdict = await resolvesPublicly(parsed.hostname, io.lookup);
  if (!verdict.ok) throw badRequest(verdict.reason);
  return parsed;
}

apiSurfaceRouter.post(
  '/api-surface/:projectId/probe',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsedBody = probeBody.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      throw badRequest(parsedBody.error.issues[0]?.message ?? 'Invalid body', {
        fieldErrors: parsedBody.error.flatten().fieldErrors,
      });
    }
    const body = parsedBody.data;
    // BEFORE the 501, so another org's project is a 404 whatever is wired.
    const project = await projectOr404(String(req.params.projectId));

    const transport = io.probeTransport;
    if (!transport) {
      throw notImplemented(
        'API operation probing — no probe transport is wired, so NO request was issued and ' +
          'nothing is claimed about any operation',
      );
    }

    const methods = parseList(body.method, API_OPERATION_METHODS, 'method');
    const auths = parseList<ApiAuthDeclaration>(body.auth, API_AUTH_DECLARATIONS, 'auth');
    const verifications = parseList<ApiOperationVerification>(
      body.verification,
      API_OPERATION_VERIFICATIONS,
      'verification',
    );

    /*
     * The environment, when one was named.
     *
     * A cross-ORG environment cannot be found at all (the tenancy extension
     * post-filters the unique lookup), and an environment belonging to another
     * PROJECT in the same org is a 404 here on purpose: a probe filed against
     * it would record observations about a place these operations do not live,
     * and the probe row's `environmentId` is the only thing that says where
     * the observation happened.
     */
    let environmentId: string | null = null;
    let baseUrl: string | null = null;
    let storedPolicy: unknown = null;
    if (body.environmentId !== undefined) {
      const environment = await prisma.environment.findUnique({
        where: { id: body.environmentId },
        select: { id: true, projectId: true, baseUrl: true, crawlPolicy: true },
      });
      if (!environment || environment.projectId !== project.id) throw notFound('Environment');
      environmentId = environment.id;
      // A blank column is NO base URL, not a base URL of ''. Probing `''`
      // would join every path onto nothing and report whatever that answered.
      baseUrl = environment.baseUrl.trim() === '' ? null : environment.baseUrl;
      storedPolicy = environment.crawlPolicy;
    }
    /*
     * `resolveCrawlPolicy` and never a hand-rolled default: it is the only
     * implementation of the glob dialect the panel previews, it type-checks
     * each stored field rather than casting (a `pageBudget: "1000"` string is
     * a cap that silently stops applying), and it reports whether the
     * environment CHOSE this policy or inherited it — which is the difference
     * between a decision somebody can be held to and a default nobody saw.
     */
    const applied = resolveCrawlPolicy(storedPolicy);
    if (baseUrl !== null) await probeBaseUrlOr400(baseUrl);

    /*
     * The targets. FILTERS GO IN THE QUERY, THE CAP GOES AFTER THEM: a cap
     * applied first would probe 500 arbitrary operations and then filter them
     * down to nine, and the response would read as "nine of your operations
     * match" — a count of what survived our own truncation, reported as a
     * count of the customer's API.
     */
    const where: Prisma.ApiOperationWhereInput = { projectId: project.id, retiredAt: null };
    if (methods) where.method = { in: methods };
    if (auths) where.authDeclaration = { in: auths };
    if (verifications) where.verification = { in: verifications };

    const [matching, targetRows] = await Promise.all([
      prisma.apiOperation.count({ where }),
      prisma.apiOperation.findMany({
        where,
        orderBy: [{ pathTemplate: 'asc' }, { method: 'asc' }],
        take: CAPS.probeTargets,
        select: {
          id: true,
          method: true,
          pathTemplate: true,
          authDeclaration: true,
          verification: true,
          notProbedReason: true,
          lastProbedAt: true,
        },
      }),
    ]);

    const capsThatBit: CapHit[] = [];
    if (matching > targetRows.length) {
      capsThatBit.push({
        cap: 'probeTargets',
        limit: CAPS.probeTargets,
        droppedAtLeast: matching - targetRows.length,
      });
    }

    /*
     * `operationKey` is the prober's own `${method} ${pathTemplate}` and this
     * map must agree with it byte for byte, which is why both sides are built
     * from the same row rather than from two spellings of the same idea.
     */
    const byKey = new Map(targetRows.map((row) => [`${row.method} ${row.pathTemplate}`, row]));
    const targets: ApiProbeTarget[] = targetRows.map((row) => ({
      method: row.method as ApiProbeTarget['method'],
      pathTemplate: row.pathTemplate,
      authDeclaration: row.authDeclaration,
      /*
       * The ROW id, which is what `ApiOperationProbe.operationId` is a foreign
       * key to — NOT `ApiOperation.operationId`, which is the document's own
       * `operationId` string and is null for most operations. Two different
       * fields one letter apart in meaning, and confusing them would attribute
       * every probe to nothing.
       */
      operationId: row.id,
    }));

    /*
     * ONE `observedAt` FOR THE RUN, read from the injected clock before the
     * first request.
     *
     * Rows written by one run share it, which is what makes them identifiable
     * as one observation — the prober returns up to four outcomes per
     * operation and they are one look at the application, not four. `new
     * Date()` here would make the row's time untestable and would drift from
     * the clock the prober charges its own rate limit against.
     */
    const observedAt = new Date(io.probeClock.now());

    const report = await probeApiOperations({
      transport,
      baseUrl,
      operations: targets,
      policy: applied.policy,
      credential: io.probeCredential,
      clock: io.probeClock,
      allowUnsafeVerbs: body.allowUnsafeVerbs,
    });

    // ── The probe rows ───────────────────────────────────────────────────
    const probeWrites: Array<Prisma.PrismaPromise<unknown>> = [];
    /** Outcomes we could not attribute to a row. Disclosed, never dropped quietly. */
    const unattributed: string[] = [];
    /** Operation row ids this run actually observed — the only ones that may get `lastProbedAt`. */
    const probedRowIds = new Set<string>();
    for (const outcome of report.probes) {
      const rowId = outcome.operationId ?? byKey.get(outcome.operationKey)?.id ?? null;
      if (rowId === null) {
        /*
         * Unreachable from this door, which passes a row id on every target —
         * and recorded anyway rather than `continue`d, because `operationId`
         * is optional in `ApiProbeTarget` and a future caller that omits it
         * would otherwise lose observations in silence. A dropped observation
         * that nothing counts is the shape of every number in this product
         * that turned out to be wrong.
         */
        unattributed.push(outcome.operationKey);
        continue;
      }
      probedRowIds.add(rowId);
      probeWrites.push(
        prisma.apiOperationProbe.create({
          /*
           * FIELD FOR FIELD FROM `outcome.fact`, which IS the row's shape.
           * Nothing is derived here and nothing is defaulted: `status` stays
           * null when nothing answered (never 0), `verbAllowed` stays null
           * when a 404 settled nothing, `authRequiredInFact` stays null unless
           * both halves were sent, and `detail` is always the prober's
           * sentence rather than ''.
           */
          data: {
            orgId: project.orgId,
            operationId: rowId,
            /*
             * A BARE COLUMN with no relation, as the model says: an
             * observation is a historical fact about a place that existed, and
             * deleting the environment row must not delete the evidence. Null
             * when the request named no environment.
             */
            environmentId,
            status: outcome.fact.status,
            verbAllowed: outcome.fact.verbAllowed,
            authRequiredInFact: outcome.fact.authRequiredInFact,
            answered: outcome.fact.answered,
            detail: outcome.fact.detail,
            observedAt,
          },
          select: { id: true },
        }),
      );
    }

    // ── The verdict on each operation ────────────────────────────────────
    interface VerificationChange {
      key: string;
      from: ApiOperationVerification;
      to: ApiOperationVerification;
      /** True when a standing CONFIRMED outranked this probe's verdict. */
      keptConfirmed: boolean;
      notProbedReason: string | null;
      detail: string;
    }
    const changes: VerificationChange[] = [];
    /**
     * Every change there WAS, not every change that fitted in `changes`.
     *
     * Counted separately so the cap below can report what it actually cost. A
     * cap disclosed with a size nobody measured — "the list limit hid at least
     * 0" — teaches a reader to skip the disclosure, which is worse than a cap
     * that was never mentioned.
     */
    let changesTotal = 0;
    const updates: Array<Prisma.PrismaPromise<unknown>> = [];
    const verdictCounts: Record<ApiOperationVerification, number> = {
      DECLARED: 0,
      CONFIRMED: 0,
      NO_ANSWER: 0,
      NOT_PROBED: 0,
    };
    const notProbedByReason: Record<string, number> = Object.fromEntries(
      NOT_PROBED_REASONS.map((reason) => [reason, 0]),
    );
    /**
     * NOT_PROBED verdicts carrying a reason this build's vocabulary does not
     * hold. A measured zero today — and the reason it is counted rather than
     * assumed is that `notProbedReason` with no readable value is
     * indistinguishable from a bug in the prober, which is the one thing the
     * model's own comment says a reader must be able to see.
     */
    let notProbedWithUnknownReason = 0;
    let keptConfirmed = 0;
    /** Verdicts about an operation this request did not select. Disclosed. */
    const unmatchedVerdicts: string[] = [];

    for (const verdict of report.verdicts) {
      const row = byKey.get(verdict.operationKey);
      if (!row) {
        unmatchedVerdicts.push(verdict.operationKey);
        continue;
      }
      verdictCounts[verdict.verification] += 1;
      if (verdict.verification === 'NOT_PROBED') {
        const reason = verdict.notProbedReason;
        if (reason !== null && reason in notProbedByReason) {
          notProbedByReason[reason] = (notProbedByReason[reason] ?? 0) + 1;
        } else {
          notProbedWithUnknownReason += 1;
        }
      }

      /*
       * ── THE ONE LINE THIS WHOLE ENDPOINT TURNS ON ───────────────────────
       *
       * THROUGH `verificationAfterProbe` AND NEVER BY ASSIGNMENT. A 404 and a
       * 502 both produce the verdict DECLARED, meaning "this probe did not
       * confirm" — and assigning that would DOWNGRADE an operation a previous
       * probe genuinely confirmed. The customer would then watch confirmed
       * operations flicker back to declared every time their staging gateway
       * had a bad minute, and would stop believing the column. An observation
       * may raise what we know and may never silently lower it; the evidence
       * that something stopped answering lives in the probe rows, where "it
       * answered last week and does not now" is a statement about
       * observations rather than a claim this column cannot defend.
       */
      const stored = verificationAfterProbe(row.verification, verdict.verification);
      const outranked = stored !== verdict.verification;
      if (outranked) keptConfirmed += 1;
      /*
       * Set EXACTLY when the stored verification is NOT_PROBED, and cleared
       * otherwise. A reason left behind on a row that has since been confirmed
       * is a false sentence on a dashboard ("the probe budget was spent")
       * beside a fact that contradicts it.
       */
      const notProbedReason = stored === 'NOT_PROBED' ? verdict.notProbedReason : null;
      const probed = probedRowIds.has(row.id);

      if (
        stored !== row.verification ||
        notProbedReason !== row.notProbedReason ||
        (probed && row.lastProbedAt?.getTime() !== observedAt.getTime())
      ) {
        updates.push(
          prisma.apiOperation.update({
            where: { id: row.id },
            data: {
              verification: stored,
              notProbedReason,
              /*
               * ONLY for an operation this run actually probed. An operation
               * the prober refused has never been asked anything, and a
               * `lastProbedAt` on it would be a timestamp for a probe that
               * never happened — the most quietly misleading field available,
               * because every reader treats it as evidence of a look.
               */
              ...(probed ? { lastProbedAt: observedAt } : {}),
            },
            select: { id: true },
          }),
        );
      }
      if (stored !== row.verification || outranked) {
        changesTotal += 1;
        if (changes.length < CAPS.changesListed) {
          changes.push({
            key: verdict.operationKey,
            from: row.verification,
            to: stored,
            keptConfirmed: outranked,
            notProbedReason,
            detail: outranked
              ? `this probe concluded ${verdict.verification} and the row keeps CONFIRMED: ` +
                `an earlier probe proved this path is routed, and ${verdict.verification} is ` +
                'not evidence that it stopped being. The probe row holds what was seen. ' +
                `(${verdict.detail})`
              : verdict.detail,
          });
        }
      }
    }
    /*
     * Unreachable while `probeTargets` (500) is not greater than
     * `changesListed` (500) — one verdict per selected operation is the most
     * there can be. Written anyway, and with the exact cost rather than a
     * guess, so that raising the target cap can never silently truncate this
     * list: the way a cap starts biting is that somebody raises a different
     * number.
     */
    if (changesTotal > changes.length) {
      capsThatBit.push({
        cap: 'changesListed',
        limit: CAPS.changesListed,
        droppedAtLeast: changesTotal - changes.length,
      });
    }

    /*
     * One transaction, probe rows first.
     *
     * The ARRAY form, as routes/record.ts and routes/agent.ts use it. Both
     * halves of an observation land together or neither does: a `lastProbedAt`
     * with no probe row behind it is a timestamp for evidence that does not
     * exist, and a probe row whose operation still says "never probed" is the
     * same inconsistency the other way round.
     */
    if (probeWrites.length > 0 || updates.length > 0) {
      await prisma.$transaction([...probeWrites, ...updates]);
    }

    // ── The findings, which are REPORTED AND NOT STORED ──────────────────
    const findings: Array<Record<string, unknown>> = [];
    let findingsTotal = 0;
    for (const outcome of report.probes) {
      for (const finding of outcome.findings) {
        findingsTotal += 1;
        if (findings.length >= CAPS.findingsListed) continue;
        findings.push({
          key: outcome.operationKey,
          method: outcome.method,
          url: outcome.url,
          ...finding,
          label: API_PROBE_FINDING_LABELS[finding.kind],
        });
      }
    }
    if (findingsTotal > findings.length) {
      capsThatBit.push({
        cap: 'findingsListed',
        limit: CAPS.findingsListed,
        droppedAtLeast: findingsTotal - findings.length,
      });
    }

    const refusedListed = report.refused.slice(0, CAPS.refusedListed);
    if (report.refused.length > refusedListed.length) {
      capsThatBit.push({
        cap: 'refusedListed',
        limit: CAPS.refusedListed,
        droppedAtLeast: report.refused.length - refusedListed.length,
      });
    }

    /*
     * The prober's own cap ledger, projected onto the shared `CapBite` shape —
     * and `unexpressible` printed BESIDE it rather than dropped. Today every
     * one of this module's caps lands there, because `CRAWL_CAPS` has no
     * member for a probe budget or a request rate; a cap that bit and has no
     * home in the shared vocabulary is still a cap that bit.
     */
    const probeCaps = apiSurfaceCapBites(report.caps);

    const actor = actorOf(req);
    await audit({
      actor,
      action: 'apiSurface.probe',
      targetType: 'Project',
      targetId: project.id,
      metadata: {
        environmentId,
        /*
         * THE HOST AND NOT THE URL. A base URL can carry a query string, and
         * an API key in a query string written to the audit log is a
         * credential in a log line — which rule 12 forbids whether or not
         * anybody expected the URL to hold one.
         */
        baseUrlHost: baseUrl === null ? null : new URL(baseUrl).host,
        targets: targetRows.length,
        matching,
        probesWritten: probeWrites.length,
        operationsUpdated: updates.length,
        verdicts: verdictCounts,
        refused: report.refused.length,
        findings: findingsTotal,
        allowUnsafeVerbs: body.allowUnsafeVerbs,
        allowDestructive: applied.policy.allowDestructive,
        /*
         * WHETHER a credential was used, never WHICH or what it is. Not the
         * value, not a hash of it, and not the label either — the label is the
         * customer's own free text and this is the one place it buys nothing.
         */
        credentialWired: io.probeCredential !== null,
        capsThatBit,
      },
    });

    res.status(200).json({
      projectId: project.id,
      /*
       * 200 and not 201. The response is a REPORT about an observation run,
       * and a run that wrote no probe rows at all — no base URL, every verb
       * refused — is not a failure and is not a creation either. A status that
       * changed with whether anything was written would be read as success and
       * failure rather than as two different observations.
       */
      environmentId,
      baseUrl,
      observedAtIso: observedAt.toISOString(),
      targets: {
        selected: targetRows.length,
        matchingFilter: matching,
        limit: CAPS.probeTargets,
        truncated: matching > targetRows.length,
        filters: {
          method: methods ?? null,
          auth: auths ?? null,
          verification: verifications ?? null,
          note: 'filters are applied in the query, before the target cap, so `matchingFilter` is a count of your operations and not of what survived our truncation',
        },
      },
      probes: {
        written: probeWrites.length,
        /** Outcomes no operation row could be found for. Zero is a measurement. */
        unattributed: unattributed.length,
        unattributedKeys: unattributed.slice(0, 25),
      },
      verdicts: {
        counts: verdictCounts,
        notProbedByReason,
        notProbedWithUnknownReason,
        /**
         * Operations whose row kept a standing CONFIRMED because this probe's
         * verdict was weaker. Reported because it is a decision this endpoint
         * took about the customer's data, and because the alternative —
         * assigning the verdict — is the defect `verificationAfterProbe`
         * exists to prevent.
         */
        keptConfirmed,
        unmatched: unmatchedVerdicts.length,
        operationsUpdated: updates.length,
        changes,
        changesTotal,
        changesLimit: CAPS.changesListed,
        changesTruncated: changesTotal > changes.length,
      },
      findings: {
        items: findings,
        total: findingsTotal,
        truncated: findingsTotal > findings.length,
        limit: CAPS.findingsListed,
        /**
         * NOT STORED, and saying so is the difference between a fact and a
         * claim. `ApiOperationProbe` has no column for a finding, so these are
         * derivable from this response and from the probe rows' statuses and
         * NOT from re-reading the history later. The schema change that would
         * persist them is named in this round's handover.
         */
        stored: false,
        storedNote:
          'findings are computed from this run and are NOT persisted: ApiOperationProbe has no ' +
          'column for them, so GET /api-surface/:projectId/probes will not show them again',
      },
      refused: {
        items: refusedListed,
        total: report.refused.length,
        truncated: report.refused.length > refusedListed.length,
        limit: CAPS.refusedListed,
        byRule: exclusionsByRule(report.refused),
        rule:
          'a probe we declined is RECORDED with the rule that declined it, and the operation is ' +
          'NOT_PROBED with its reason. A refused surface and a surface that does not exist are ' +
          'opposite facts, and a silent skip records them identically.',
      },
      safety: {
        safeMethods: SAFE_PROBE_METHODS,
        allowUnsafeVerbs: body.allowUnsafeVerbs,
        allowDestructive: applied.policy.allowDestructive,
        rule:
          'a verb outside safeMethods takes BOTH allowUnsafeVerbs on the request AND ' +
          'allowDestructive on the environment’s crawl policy; neither implies the other, and ' +
          'with one of them a probe that would mutate data is refused and recorded.',
      },
      policy: {
        /** True when this environment never chose a policy and the build's default applies. */
        defaulted: applied.defaulted,
        chosenFields: applied.overridden,
        unknownKeys: applied.unknownKeys,
      },
      credential: {
        wired: io.probeCredential !== null,
        label: io.probeCredential?.label ?? null,
        note:
          io.probeCredential === null
            ? 'no credential is wired into this door, so an operation that refuses an anonymous ' +
              'request leaves `authRequiredInFact` NULL — undetermined for want of the second ' +
              'half of the evidence, which is not the same as "authentication is not required"'
            : 'the credential’s headers are sent by the transport and are never written to a ' +
              'probe row, to the audit log or to this response',
      },
      sampleValues: {
        supplied: false,
        note:
          'this door supplies no observed values for path parameters, so an operation with a ' +
          '`{id}` is probed with the sentinel id and no separate bad-id probe is issued for it — ' +
          'it would be the same request twice. The prober’s caveats say so per run.',
      },
      caps: CAPS,
      capsThatBit,
      capRule: describeCaps(capsThatBit),
      probeCaps: {
        limits: DEFAULT_API_SURFACE_CAPS,
        bites: probeCaps.capBites,
        /** Caps that bit and have no member in the shared vocabulary. Printed, never dropped. */
        unexpressible: probeCaps.unexpressible,
        /** Milliseconds spent waiting on the rate limit. A cap that costs wall clock. */
        rateLimitWaitMs: report.rateLimitWaitMs,
        /**
         * Follow-up probes the budget stopped on operations that WERE probed —
         * a different number from the operations nothing probed at all, and
         * never added to it. Zero is a measurement.
         */
        followUpsStoppedByBudget: report.followUpsStoppedByBudget,
      },
      caveats: [
        ...report.caveats,
        ...(targetRows.length === 0
          ? [
              'no declared operation matched, so nothing was probed and nothing is claimed: ' +
                'upload a document to POST /api-surface/:projectId first, or widen the filters',
            ]
          : []),
        ...(baseUrl === null
          ? [
              'no environment base URL, so every operation is NOT_PROBED / NO_BASE_URL. That is ' +
                'a configuration gap and says nothing about whether any operation exists',
            ]
          : []),
        ...(unattributed.length > 0
          ? [
              `${unattributed.length} probe outcome(s) could not be attributed to an operation ` +
                'row and were NOT stored; that is a defect in this door and not a fact about ' +
                'the application',
            ]
          : []),
      ],
    });
  },
);

// ─── GET /api-surface/:projectId ────────────────────────────────────────────

const readQuery = z.object({
  limit: z.coerce.number().int().min(1).max(CAPS.pageMax).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** Comma-separated ApiOperationVerification values. */
  verification: z.string().optional(),
  /** Comma-separated ApiAuthDeclaration values. */
  auth: z.string().optional(),
  /** Comma-separated HTTP methods, or UNKNOWN. */
  method: z.string().optional(),
  /**
   * Retired rows are EXCLUDED by default and the response says so. They are
   * not deleted, so a reader must be able to ask for them; defaulting to
   * including them would put deliberately-retired surfaces back in a list
   * somebody is working through.
   */
  retired: z.enum(['EXCLUDE', 'INCLUDE', 'ONLY']).optional(),
  /** Only operations whose declaring document is this one. */
  document: z.string().trim().min(1).max(2_000).optional(),
  /**
   * Only operations the registry has no row for — the headline list.
   *
   * `z.enum` and NOT `z.coerce.boolean()`: coercion reads the string "false"
   * as `true`, so `?notInRegistry=false` would silently filter the list down to
   * the gaps and a reader would conclude every operation is missing from the
   * registry.
   */
  notInRegistry: z.enum(['true', 'false']).optional(),
});

apiSurfaceRouter.get(
  '/api-surface/:projectId',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = readQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
    const query = parsed.data;

    const project = await projectOr404(String(req.params.projectId));
    const verifications = parseList<ApiOperationVerification>(
      query.verification,
      API_OPERATION_VERIFICATIONS,
      'verification',
    );
    const auths = parseList<ApiAuthDeclaration>(query.auth, API_AUTH_DECLARATIONS, 'auth');
    const methods = parseList(query.method, API_OPERATION_METHODS, 'method');

    const retired = query.retired ?? 'EXCLUDE';
    const where: Prisma.ApiOperationWhereInput = { projectId: project.id };
    if (retired === 'EXCLUDE') where.retiredAt = null;
    if (retired === 'ONLY') where.retiredAt = { not: null };
    if (verifications) where.verification = { in: verifications };
    if (auths) where.authDeclaration = { in: auths };
    if (methods) where.method = { in: methods };
    if (query.document) where.sourceDocument = query.document;

    /*
     * The page, and the COUNT separately.
     *
     * `total` is the full number whatever the page holds. A report that says
     * "12 declared operations" while holding back 400 is the quiet truncation
     * that makes a number untrustworthy, and this endpoint's whole job is to be
     * the number somebody forwards.
     */
    const limit = query.limit ?? CAPS.pageDefault;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      prisma.apiOperation.findMany({
        where,
        orderBy: [{ pathTemplate: 'asc' }, { method: 'asc' }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          method: true,
          pathTemplate: true,
          operationId: true,
          sourceDocument: true,
          evidence: true,
          authDeclaration: true,
          parameters: true,
          verification: true,
          notProbedReason: true,
          lastProbedAt: true,
          firstSeenAt: true,
          lastSeenAt: true,
          retiredAt: true,
        },
      }),
      prisma.apiOperation.count({ where }),
    ]);

    /*
     * The registry's view of the operations ON THIS PAGE, by key. Bounded by
     * the page size rather than by the project, so this read cannot become the
     * scan that makes the endpoint slow for the customer with 40,000 routes.
     */
    const pageKeys = rows.map((row) => registryKeyFor(row.method, row.pathTemplate));
    const registryRows =
      pageKeys.length === 0
        ? []
        : await prisma.coverageItem.findMany({
            where: { projectId: project.id, key: { in: pageKeys } },
            select: { key: true, status: true, sources: true, retiredAt: true },
          });
    const registryByKey = new Map(registryRows.map((row) => [row.key, row]));

    /*
     * The newest probe for each operation ON THIS PAGE, which is the half of
     * this read that was missing: `verification` said what we believe and
     * nothing said what we SAW. Bounded by the page rather than by the
     * project, for the same reason the registry lookup above is.
     */
    const probeWindow = await readProbeWindow(rows.map((row) => row.id));

    const viewFor = (key: string): RegistryView => {
      const row = registryByKey.get(key);
      if (!row || row.retiredAt !== null) {
        return {
          key,
          status: null,
          origin: null,
          sources: null,
          inRegistry: false,
          // `true` is a row that was there and was retired — a decision
          // somebody took — and `false` is a key the registry has never held.
          retiredInRegistry: row ? true : false,
        };
      }
      const sources = sourcesOf(row.sources);
      return {
        key,
        status: row.status,
        // `originFromSources` and never a second derivation: an item's two
        // provenance fields disagreeing is how only one of them ends up on
        // screen. Null for a row that recorded no declarer — never a guess.
        origin: sources === null ? null : originFromSources(sources),
        sources,
        inRegistry: true,
        retiredInRegistry: false,
      };
    };

    const page = rows
      .map((row) => {
        const key = registryKeyFor(row.method, row.pathTemplate);
        const observation = newestObservationOf(probeWindow, row.id);
        const determinedAuth = determinedAuthOf(probeWindow.byOperation.get(row.id));
        return {
          key,
          method: row.method,
          pathTemplate: row.pathTemplate,
          operationId: row.operationId,
          sourceDocument: row.sourceDocument,
          evidence: row.evidence,
          authDeclaration: row.authDeclaration,
          parameterCount: Array.isArray(row.parameters) ? row.parameters.length : 0,
          verification: row.verification,
          notProbedReason: row.notProbedReason,
          lastProbedAtIso: row.lastProbedAt ? row.lastProbedAt.toISOString() : null,
          firstSeenAtIso: row.firstSeenAt.toISOString(),
          lastSeenAtIso: row.lastSeenAt.toISOString(),
          retiredAtIso: row.retiredAt ? row.retiredAt.toISOString() : null,
          /** Whether the document stopped declaring it. See the absence mark. */
          absentFromDocument: row.evidence.includes(ABSENCE_SENTINEL),
          registry: viewFor(key),
          /**
           * OBSERVED, NEVER_PROBED or NOT_READ. Three states because a null
           * `newestProbe` cannot mean both "nothing has ever asked this
           * application about this operation" and "our own read cap stopped
           * before this row" — one is a gap in the measurement and the other
           * is a gap in the reading, and they have different remedies.
           */
          probeState: observation.state,
          /** The newest probe, with every null left as null. */
          newestProbe: observation.probe,
          /** How many probe rows shared that observation. See the history read. */
          probesInNewestObservation: observation.probesInObservation,
          /**
           * The newest probe that DETERMINED whether authentication is
           * required in fact, which is deliberately not read off
           * `newestProbe`: a later row's null is "that row determined
           * nothing", never a retraction, and reading it as one would report
           * "we could not judge this" about an operation we judged.
           */
          authRequiredInFact: determinedAuth.value,
          authRequiredInFactObservedAtIso: determinedAuth.observedAtIso,
        };
      });
    /*
     * The registry filter runs AFTER the page was taken, so a page can come
     * back shorter than `limit` while more rows remain — and `total` is the
     * unfiltered count, which a reader comparing it with the list length would
     * otherwise read as "most of these are in the registry" or as a bug. Both
     * numbers are reported with the count the filter removed, rather than one
     * of them being quietly inconsistent with the other.
     */
    const operations = page.filter(
      (operation) => query.notInRegistry !== 'true' || !operation.registry.inRegistry,
    );

    /*
     * ── THE HEADLINE, AND THE CAP ON IT ──────────────────────────────────────
     *
     * "Your document declares 412 operations and the registry holds 25 of
     * them" is the sentence this whole router exists to make sayable. It needs
     * both key sets, which is a scan, so it is capped — and a capped count is
     * reported as a FLOOR and never as the answer. `declaredNotInRegistry` goes
     * NULL when the cap bit, because an undisclosed cap here would make the
     * number smaller, and smaller is the direction that flatters us.
     */
    const [declaredKeys, registryKeys] = await Promise.all([
      prisma.apiOperation.findMany({
        where: { projectId: project.id, retiredAt: null },
        select: { method: true, pathTemplate: true },
        take: CAPS.reconcileScan + 1,
      }),
      prisma.coverageItem.findMany({
        where: { projectId: project.id, kind: 'ENDPOINT', retiredAt: null },
        select: { key: true, status: true },
        take: CAPS.reconcileScan + 1,
      }),
    ]);
    const scanTruncated =
      declaredKeys.length > CAPS.reconcileScan || registryKeys.length > CAPS.reconcileScan;
    const registryKeySet = new Set(
      registryKeys.slice(0, CAPS.reconcileScan).map((row) => row.key),
    );
    const scannedDeclared = declaredKeys.slice(0, CAPS.reconcileScan);
    const missing = scannedDeclared.filter(
      (row) => !registryKeySet.has(registryKeyFor(row.method, row.pathTemplate)),
    ).length;

    /*
     * Covered and excluded are counted through `COVERED_STATUSES` and
     * `EXCLUDED_STATUSES` rather than string literals, so the documented lever
     * governs this count too. The alternative — `status === 'COVERED'` — is
     * this codebase's signature defect: the constant and the thing it claims to
     * govern in different files, so "stop counting X as covered" edits the
     * constant, passes the tests, and ships no change.
     */
    const scannedRegistry = registryKeys.slice(0, CAPS.reconcileScan);
    const registryCovered = scannedRegistry.filter((row) =>
      COVERED_STATUSES.includes(row.status),
    ).length;
    const registryExcluded = scannedRegistry.filter((row) =>
      EXCLUDED_STATUSES.includes(row.status),
    ).length;

    res.json({
      projectId: project.id,
      operations,
      total,
      offset,
      limit,
      truncated: offset + rows.length < total,
      retired,
      /**
       * The post-page filter, disclosed. `total` counts rows BEFORE it, so a
       * short page is not an exhausted list.
       */
      /**
       * The probe fold's own cap, disclosed whether or not it bit.
       *
       * When `truncated` is true, an operation on this page reporting
       * NEVER_PROBED would be a claim this read did not establish, so those
       * operations come back NOT_READ instead. The history read has the rest.
       */
      probeWindow: {
        rowsPerOperation: probeWindow.limit,
        truncated: probeWindow.truncated,
        rule: probeWindow.truncated
          ? `at least one operation on this page has more than ${probeWindow.limit} probe rows, ` +
            'so operations with no row in the window are reported NOT_READ rather than ' +
            'NEVER_PROBED — we did not look, which is not the same as nothing having looked'
          : `every probe row needed was read (up to ${probeWindow.limit} per operation), so ` +
            'NEVER_PROBED on this page means exactly that',
        historyAt: `GET /api-surface/${project.id}/probes`,
      },
      notInRegistryFilter: {
        applied: query.notInRegistry === 'true',
        removedFromPage: page.length - operations.length,
        note:
          '`total` is the count before this filter, which is applied after the page is taken: a ' +
          'page shorter than `limit` does not mean the list is exhausted. Page on with `offset`.',
      },
      reconciliation: {
        declaredOperations: scannedDeclared.length,
        registryEndpointItems: scannedRegistry.length,
        registryCovered,
        registryExcluded,
        /**
         * Null when the scan was capped. Not 0, and not the partial count: a
         * floor belongs in `atLeastDeclaredNotInRegistry`, where it cannot be
         * mistaken for the answer.
         */
        declaredNotInRegistry: scanTruncated ? null : missing,
        atLeastDeclaredNotInRegistry: scanTruncated ? missing : null,
        scanLimit: CAPS.reconcileScan,
        scanTruncated,
        /*
         * "no LIVE row", not "nothing has ever seen them".
         *
         * The registry side of this comparison filters `retiredAt: null`, so a
         * declared operation whose `CoverageItem` was retired — which
         * `computeCoverage` does to every row its own inputs do not re-declare
         * — counts as missing here. Saying "no crawl and no source detector has
         * ever seen them" about those is a claim about our enumeration that the
         * rows themselves contradict, and the two have different remedies:
         * enumerate the one, un-retire or re-declare the other. The per-row
         * `registry.retiredInRegistry` tells them apart on the page.
         */
        rule: scanTruncated
          ? `the scan stopped at ${CAPS.reconcileScan} rows on at least one side, so at least ` +
            `${missing} declared operations have no live row in the surface registry and the ` +
            'exact number is unknown'
          : `${missing} of ${scannedDeclared.length} declared operations have no live row in the ` +
            'surface registry: either nothing has ever enumerated them, or a row existed and was ' +
            'retired. `registry.retiredInRegistry` on each operation says which.',
        /**
         * Why the two inventories are still two. Stated on every read, because
         * a reader comparing these numbers with `/surface`'s will otherwise
         * assume one of them is wrong.
         */
        note:
          'ApiOperation rows are not written into CoverageItem by this router: computeCoverage ' +
          'retires every registry row its own inputs do not re-declare, so an OPENAPI row ' +
          'written here would be retired by the next recompute.',
      },
      caps: CAPS,
    });
  },
);

// ─── GET /api-surface/:projectId/probes ─────────────────────────────────────

const probesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(CAPS.pageMax).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /**
   * One operation's ROW id — `ApiOperation.id`, not the document's
   * `operationId`. An id this project does not hold is a 404 and never an
   * empty page: `[]` would read as "nothing has ever probed that operation",
   * which is a measured claim about the application made out of a typo.
   */
  operationId: z.string().trim().min(1).max(200).optional(),
  /** Only observations made in this environment. */
  environmentId: z.string().trim().min(1).max(200).optional(),
  /**
   * `z.enum` and NOT `z.coerce.boolean()`, which reads the string "false" as
   * `true` — so `?answered=false` would silently return the probes that DID
   * answer, which is the exact opposite of the question.
   */
  answered: z.enum(['true', 'false']).optional(),
});

apiSurfaceRouter.get(
  '/api-surface/:projectId/probes',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = probesQuery.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', {
        fieldErrors: parsed.error.flatten().fieldErrors,
      });
    }
    const query = parsed.data;
    const project = await projectOr404(String(req.params.projectId));

    if (query.operationId !== undefined) {
      /*
       * Resolved before the read so that an unknown id is a 404 rather than an
       * empty list. The lookup is scoped to the project for the same reason
       * the relation filter below is: an operation id belonging to another
       * project would otherwise answer with that project's probes.
       */
      const operation = await prisma.apiOperation.findUnique({
        where: { id: query.operationId },
        select: { id: true, projectId: true },
      });
      if (!operation || operation.projectId !== project.id) throw notFound('API operation');
    }

    /*
     * ── THE RELATION FILTER IS THE TENANCY BOUNDARY ────────────────────────
     *
     * `ApiOperationProbe` has an `orgId` (so the tenancy extension scopes it)
     * and NO `projectId` — a probe belongs to a project only through its
     * operation. So `operation: { projectId }` is the only thing standing
     * between this read and another project's observations inside the same
     * org, and it is in the WHERE rather than applied afterwards: a
     * post-filter would make `total` a count of the whole org's probes.
     */
    const where: Prisma.ApiOperationProbeWhereInput = {
      operation: { projectId: project.id },
    };
    if (query.operationId !== undefined) where.operationId = query.operationId;
    if (query.environmentId !== undefined) where.environmentId = query.environmentId;
    if (query.answered !== undefined) where.answered = query.answered === 'true';

    /*
     * THE FILTERS ARE IN THE QUERY AND THE CAP IS THE `take` AFTER THEM, and
     * `total` is counted under the same filters. A cap applied first would
     * page 100 arbitrary probes and then filter them, so a page could come
     * back empty while hundreds of matching probes existed — an empty answer
     * manufactured by our own pagination.
     */
    const limit = query.limit ?? CAPS.pageDefault;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      prisma.apiOperationProbe.findMany({
        where,
        // Newest first. The id is a stable tiebreak inside one observation,
        // where several rows share the run's `observedAt` by design.
        orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
        select: PROBE_ROW_SELECT,
      }),
      prisma.apiOperationProbe.count({ where }),
    ]);

    /*
     * The operations these probes are about, so a reader does not have to join
     * by hand. Bounded by the page: one lookup of the ids on it, never a scan.
     */
    const operationIds = [...new Set(rows.map((row) => row.operationId))];
    const operations =
      operationIds.length === 0
        ? []
        : await prisma.apiOperation.findMany({
            where: { id: { in: operationIds } },
            select: { id: true, method: true, pathTemplate: true, authDeclaration: true },
          });
    const operationById = new Map(operations.map((row) => [row.id, row]));

    res.json({
      projectId: project.id,
      probes: rows.map((row) => {
        const operation = operationById.get(row.operationId);
        return {
          id: row.id,
          operationId: row.operationId,
          /** Null only if the operation row is gone, which the FK cascade forbids. */
          key:
            operation === undefined
              ? null
              : registryKeyFor(operation.method, operation.pathTemplate),
          method: operation?.method ?? null,
          pathTemplate: operation?.pathTemplate ?? null,
          /** What the DOCUMENT declared, beside what the application did. */
          authDeclaration: operation?.authDeclaration ?? null,
          ...probeRowView(row),
        };
      }),
      total,
      offset,
      limit,
      truncated: offset + rows.length < total,
      filters: {
        operationId: query.operationId ?? null,
        environmentId: query.environmentId ?? null,
        answered: query.answered ?? null,
        note: 'filters are applied in the query and `total` is counted under the same filters, so a short page means the list is exhausted and never that the filter ran after the cap',
      },
      caps: CAPS,
      rule:
        'one probe RUN writes several rows for one operation — the declared request, the ' +
        'credentialled half, a bad id, an undeclared verb — and they share that run’s ' +
        '`observedAt` because they are one observation. A null status means nothing answered ' +
        'and is never a 0; a null `verbAllowed` or `authRequiredInFact` means that row ' +
        'determined nothing, and is never a false.',
    });
  },
);

// ─── GET /api-surface/:projectId/auth-disagreements ─────────────────────────

/**
 * The declarations under which the document TOOK A POSITION about who may call
 * an operation, and can therefore be contradicted by the application.
 *
 * Built from {@link ANONYMOUS_ACCESS_DECLARED} plus REQUIRED rather than
 * written out, so the vocabulary stays the lever: a sixth declaration lands in
 * exactly one of these two lists and is never silently dropped from both.
 */
const AUTH_POSITIONS: readonly ApiAuthDeclaration[] = ['REQUIRED', ...ANONYMOUS_ACCESS_DECLARED];
/** UNSTATED and NOT_READ — our silence or theirs. Nothing to disagree with. */
const AUTH_SILENT: readonly ApiAuthDeclaration[] = API_AUTH_DECLARATIONS.filter(
  (declaration) => !AUTH_POSITIONS.includes(declaration),
);

const disagreementsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(CAPS.pageMax).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * The one report this table exists to produce.
 *
 * `authDeclaration` is a claim about the DOCUMENT. `authRequiredInFact` is the
 * only place in the product where the APPLICATION says who may call an
 * operation. When they disagree, a client written from the document is either
 * about to break or has been reading a document that understates what is
 * public — and both are things somebody wants to know today.
 *
 * ── THE TWO NUMBERS THAT MUST NEVER BE ADDED ────────────────────────────────
 *
 * A DISAGREEMENT is a measured contradiction. A CANNOT JUDGE is a measurement
 * we did not complete: `authRequiredInFact` is null because only half the
 * evidence was sent — an anonymous refusal with no credential to try — or
 * because nothing probed the operation at all. Summing them into one
 * "problems" figure would report our own missing credential as a defect in the
 * customer's application, which is the single most expensive lie available
 * here. They are reported as separate counts with separate sentences and the
 * response says so in `rule`.
 */
apiSurfaceRouter.get(
  '/api-surface/:projectId/auth-disagreements',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = disagreementsQuery.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', {
        fieldErrors: parsed.error.flatten().fieldErrors,
      });
    }
    const query = parsed.data;
    const project = await projectOr404(String(req.params.projectId));

    const live = { projectId: project.id, retiredAt: null } as const;
    const [withPosition, documentSilent, scanned] = await Promise.all([
      prisma.apiOperation.count({
        where: { ...live, authDeclaration: { in: [...AUTH_POSITIONS] } },
      }),
      prisma.apiOperation.count({
        where: { ...live, authDeclaration: { in: [...AUTH_SILENT] } },
      }),
      prisma.apiOperation.findMany({
        // The filter is in the query, so the scan cap below spends itself on
        // operations that can actually disagree.
        where: { ...live, authDeclaration: { in: [...AUTH_POSITIONS] } },
        orderBy: [{ pathTemplate: 'asc' }, { method: 'asc' }],
        take: CAPS.disagreementScan,
        select: {
          id: true,
          method: true,
          pathTemplate: true,
          authDeclaration: true,
          verification: true,
        },
      }),
    ]);
    const scanTruncated = withPosition > scanned.length;
    const probeWindow = await readProbeWindow(scanned.map((row) => row.id));

    interface Disagreement {
      key: string;
      method: string;
      pathTemplate: string;
      authDeclaration: ApiAuthDeclaration;
      authRequiredInFact: boolean;
      observedAtIso: string | null;
      kind: 'DECLARED_PUBLIC_BUT_REQUIRED' | 'DECLARED_PRIVATE_BUT_OPEN';
      evidence: string;
    }
    const disagreements: Disagreement[] = [];
    let agree = 0;
    const cannotJudge = { probedButUndetermined: 0, neverProbed: 0, notRead: 0 };

    for (const row of scanned) {
      const rows = probeWindow.byOperation.get(row.id);
      const determined = determinedAuthOf(rows);
      if (determined.value === null) {
        /*
         * Three reasons for a null, kept apart because the remedy differs:
         * wire a credential, run a probe, or raise the read window. Rolling
         * them into one number would make "we never asked" and "we asked and
         * could not tell" the same fact.
         */
        const state = newestObservationOf(probeWindow, row.id).state;
        if (state === 'OBSERVED') cannotJudge.probedButUndetermined += 1;
        else if (state === 'NEVER_PROBED') cannotJudge.neverProbed += 1;
        else cannotJudge.notRead += 1;
        continue;
      }

      const declaresAnonymous = ANONYMOUS_ACCESS_DECLARED.includes(row.authDeclaration);
      const disagrees = declaresAnonymous === determined.value;
      if (!disagrees) {
        agree += 1;
        continue;
      }
      const key = registryKeyFor(row.method, row.pathTemplate);
      const declaration = API_AUTH_DECLARATION_LABELS[row.authDeclaration];
      disagreements.push({
        key,
        method: row.method,
        pathTemplate: row.pathTemplate,
        authDeclaration: row.authDeclaration,
        authRequiredInFact: determined.value,
        observedAtIso: determined.observedAtIso,
        kind: determined.value ? 'DECLARED_PUBLIC_BUT_REQUIRED' : 'DECLARED_PRIVATE_BUT_OPEN',
        /*
         * The sentence a reader forwards, with the DATE it was observed on, so
         * a finding from three weeks ago cannot be mistaken for one from this
         * morning.
         */
        evidence: determined.value
          ? `${row.method} ${row.pathTemplate}: the document says ${declaration}, and a probe ` +
            `on ${determined.observedAtIso ?? 'an unknown date'} found that authentication IS ` +
            'required in fact — an anonymous request was refused and the same request with a ' +
            'credential was not. A client written from the document will be refused.'
          : `${row.method} ${row.pathTemplate}: the document says ${declaration}, and a probe ` +
            `on ${determined.observedAtIso ?? 'an unknown date'} found that authentication is ` +
            'NOT required in fact — the application served the request without a credential. ' +
            'The document understates what is public.',
      });
    }

    const limit = query.limit ?? CAPS.pageDefault;
    const offset = query.offset ?? 0;
    // Computed over the scanned set and then paged, so `total` is the whole
    // list and a short page is a page rather than an exhausted list.
    const items = disagreements.slice(offset, offset + limit);
    const cannotJudgeTotal =
      cannotJudge.probedButUndetermined + cannotJudge.neverProbed + cannotJudge.notRead;

    res.json({
      projectId: project.id,
      disagreements: items,
      total: disagreements.length,
      offset,
      limit,
      truncated: offset + items.length < disagreements.length,
      counts: {
        operationsWithAPosition: withPosition,
        operationsScanned: scanned.length,
        /**
         * The document said nothing, so there is nothing to contradict. Its
         * own number and NOT part of `cannotJudge`: silence in the document is
         * not a measurement we failed to make.
         */
        documentTookNoPosition: documentSilent,
        /**
         * Null when the scan was capped, with the floor beside it. A partial
         * count in the field a dashboard prints is how a capped scan becomes a
         * reassuring number.
         */
        disagree: scanTruncated ? null : disagreements.length,
        atLeastDisagree: scanTruncated ? disagreements.length : null,
        agree: scanTruncated ? null : agree,
        atLeastAgree: scanTruncated ? agree : null,
        cannotJudge: scanTruncated ? null : cannotJudgeTotal,
        atLeastCannotJudge: scanTruncated ? cannotJudgeTotal : null,
        /**
         * Why each unjudged operation is unjudged, over the scanned set.
         * `probedButUndetermined` is usually "no credential was wired, so one
         * anonymous refusal is all the evidence there is".
         */
        cannotJudgeBreakdown: cannotJudge,
        scanLimit: CAPS.disagreementScan,
        scanTruncated,
      },
      rule:
        '`disagree` and `cannotJudge` are different facts and MUST NOT be added. The first is a ' +
        'measured contradiction between the document and the application. The second is a ' +
        'measurement that was not completed — `authRequiredInFact` is null because only half ' +
        'the evidence was sent (an anonymous refusal with no credential to try), or because ' +
        'nothing probed the operation at all. Adding them reports our own missing credential as ' +
        'a defect in your application.',
      /**
       * The half of this report that cannot fire yet, said plainly.
       *
       * Nothing in this build ever writes `authRequiredInFact: false` — the
       * prober sets it to `true` when a credential is accepted where an
       * anonymous request was refused, and leaves it null otherwise. So
       * DECLARED_PRIVATE_BUT_OPEN is computed here and will be empty today
       * even where it is true: the prober raises it as a FINDING on the probe
       * response, and `ApiOperationProbe` has no column for a finding. The
       * check is written rather than omitted so that it reports the day a
       * writer records a determined `false`, and this note is here so nobody
       * reads an empty list as "no operation is open that should not be".
       */
      coverage: {
        canReport: ['DECLARED_PUBLIC_BUT_REQUIRED'],
        cannotReportYet: ['DECLARED_PRIVATE_BUT_OPEN'],
        note:
          'no writer in this build records `authRequiredInFact: false`, so an operation the ' +
          'document calls private that serves anonymous requests is NOT in this list today. The ' +
          'prober raises it as the DECLARED_PRIVATE_BUT_OPEN finding on POST ' +
          '/api-surface/:projectId/probe, and ApiOperationProbe has no column for a finding — so ' +
          'an empty list here is not evidence that nothing is open.',
      },
      caps: CAPS,
      probeWindow: { rowsPerOperation: probeWindow.limit, truncated: probeWindow.truncated },
    });
  },
);
