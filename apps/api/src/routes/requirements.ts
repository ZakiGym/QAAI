/**
 * The specification ingest door: the surface a HUMAN declared.
 *
 * Everything else in this product enumerates by reading a machine's output — a
 * crawl, a route table, an OpenAPI document. This router reads the other half,
 * and it is the half an enterprise buyer already has an auditor asking about:
 * the acceptance criteria. `lib/issues.ts` is OUTBOUND ONLY today — QAAI files
 * tickets and has never once read a specification back — so these rows are the
 * whole spec-side denominator.
 *
 *   POST /requirements/:projectId             import (inline, CSV, Markdown,
 *                                              or a customer-owned connector)
 *   GET  /requirements/:projectId             the rows, with `linkState` —
 *                                              `?linkState=NOT_LINKED` is THE
 *                                              report
 *   GET  /requirements/:projectId/traceability requirement → test/surface links
 *   POST /requirements/:projectId/links        assert one link
 *   GET  /requirements/:projectId/connectors   what can be imported here, and
 *                                              what cannot, with the reason
 *
 * ── THE TWO SILENCES THIS FILE REFUSES TO COLLAPSE ─────────────────────────
 *
 * 1. NOT_SEARCHED IS NOT NOT_LINKED. "No test covers this requirement" is the
 *    product's output; "no linker has looked at this requirement" is our own
 *    silence. `count(links) = 0` cannot tell them apart, which is why
 *    `Requirement.linkState` is a stored column and why every read below
 *    reports the NOT_SEARCHED count beside the NOT_LINKED one. A customer who
 *    reads "12 unlinked" without seeing "840 never looked at" has been misled
 *    by arithmetic.
 *
 * 2. UNMAPPED IS NOT A DEFAULT. A tracker's own status word that our table does
 *    not know lands on UNMAPPED with `statusRaw` holding the word, never on
 *    whichever member looked closest — because `requirementCounts` decides
 *    whether a row enters the denominator from that member, and a coverage
 *    percentage must not be moved by a mapping table nobody reviewed.
 *
 * ── CREDENTIALS ────────────────────────────────────────────────────────────
 *
 * A connector's token lives on an `Integration` row the customer owns, is
 * unsealed for the duration of one call, and is never read from the
 * environment. {@link SPEC_CONNECTORS} is the catalogue, and a connector this
 * install cannot hold a credential for answers 501 with the reason — it does
 * not answer 200 with an empty list, because "we imported nothing" and "we
 * could not look" are opposite facts and only one of them is about the
 * customer's specification.
 *
 * ── NOTHING HERE WRITES CoverageItem ───────────────────────────────────────
 *
 * For the same reason routes/api-surface.ts does not: `computeCoverage`
 * retires every registry row its own inputs do not re-declare, so a
 * REQUIREMENT-declared row written from here would be retired by the next
 * recompute. A requirement links TO a registry row (`RequirementLink.target =
 * SURFACE`); it does not mint one.
 */

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ACCEPTANCE_CRITERION_FORMATS,
  REQUIREMENT_LINK_METHODS,
  REQUIREMENT_LINK_STATES,
  REQUIREMENT_STATUSES,
  SPEC_SOURCE_SYSTEMS,
  STRUCTURED_CRITERION_FORMATS,
  TRACEABLE_LINK_CONFIDENCE,
  classifyReimport,
  clampLinkConfidence,
  linkStateFrom,
  linkTargetOfRow,
  linkWasAsserted,
  requirementContentHash,
  requirementCounts,
  requirementImportSchema,
  requirementLinkSchema,
  requirementTestability,
} from '@qaai/shared';
import type {
  AcceptanceCriterionFormat,
  RequirementInput,
  RequirementLinkState,
  RequirementStatus,
  SpecSourceSystem,
} from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound, notImplemented, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { openToken } from '../lib/integrations.js';
import { IssueFilingError, githubRepoSlug, jiraSite } from '../lib/issues.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';
import { Prisma } from '../generated/prisma/client.js';

export const requirementsRouter: Router = Router();

requirementsRouter.use(requireAuth);

// ─── Caps, every one of which is reported ───────────────────────────────────

/**
 * Every limit this router applies, in one table that the response carries.
 *
 * An ingest that silently stops at a thousand rows and reports success is the
 * undisclosed cap that makes a coverage percentage go up: the numerator does
 * not move and the denominator is quietly smaller. So the whole table is in
 * every response — including the limits that did NOT bite, because knowing a
 * cap exists and did not fire is what makes the number whole rather than
 * merely unchallenged.
 */
const CAPS = {
  /** Bytes of CSV or Markdown accepted in one import. Refused past this. */
  documentBytes: 4_000_000,
  /** Requirements persisted in one import. Past this they are counted, not stored. */
  importBatch: 1_000,
  /** Criteria persisted per requirement. `acceptanceCriterionSchema` allows 500. */
  criteriaPerRequirement: 500,
  /** Pages one connector read will fetch before it stops and says so. */
  connectorPages: 20,
  /** Rows one connector page asks for. */
  connectorPageSize: 100,
  /** Per-row change lines echoed back by an import. */
  changesListed: 500,
  /** Parse problems echoed back, so a bad export is debuggable. */
  problemsListed: 50,
  /** Links listed per requirement in the traceability read. */
  linksPerRequirement: 50,
  /** Default and maximum page size for the reads. */
  pageDefault: 100,
  pageMax: 1_000,
} as const;

interface CapHit {
  cap: string;
  limit: number;
  droppedAtLeast: number;
}

/** The sentence a reader forwards. Worded once, so it reads the same everywhere. */
function describeCaps(hits: readonly CapHit[]): string {
  if (hits.length === 0) return 'no cap bit: every row the source offered was accounted for';
  return hits
    .map((hit) => `${hit.cap} (limit ${hit.limit}) hid at least ${hit.droppedAtLeast}`)
    .join('; ');
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The problem log: a capped echo list, and the two counts that must NOT be
 * derived from it.
 *
 * ── THE DEFECT THIS REPLACES ────────────────────────────────────────────────
 *
 * `totals.rejected` was `problems.length`, which was wrong in both directions
 * at once. Too LOW, because every producer stopped appending at
 * `CAPS.problemsListed`: an import of 300 malformed CSV rows reported 50
 * rejected, 250 requirements vanished, and `capRule` said "no cap bit: every
 * row the source offered was accounted for". Too HIGH, because the same array
 * also carried NOTES about rows that imported perfectly well — a Markdown
 * heading whose id had to be synthesised, a Jira description in a format this
 * reader cannot read — so a clean two-requirement Markdown import reported one
 * of them rejected and both of them accepted.
 *
 * So the two kinds are recorded apart. `reject` is for a row that WAS NOT
 * STORED and is the only thing that counts towards `rejected`; `note` is for a
 * fact about a row that was. Both are echoed under the same cap, and `total`
 * counts what was recorded whether or not it fitted, so the cap can disclose
 * what it hid instead of becoming the count.
 */
interface ProblemLog {
  /** The lines echoed back, capped at {@link CAPS.problemsListed}. */
  lines: string[];
  /** Every problem recorded, echoed or not. */
  total: number;
  /** Problems that mean a row was not stored. */
  rejected: number;
  /** A row the source offered and we did not store. */
  reject(line: string): void;
  /** A fact about a row that WAS stored. Never a rejection. */
  note(line: string): void;
  /** Fold another producer's log into this one, counts and all. */
  absorb(other: ProblemLog): void;
}

function problemLog(): ProblemLog {
  const log: ProblemLog = {
    lines: [],
    total: 0,
    rejected: 0,
    reject(line) {
      log.rejected += 1;
      // Delegates the echo so one cap governs both kinds and the line order
      // stays the order the producer found them in.
      log.note(line);
    },
    note(line) {
      log.total += 1;
      if (log.lines.length < CAPS.problemsListed) log.lines.push(line);
    },
    absorb(other) {
      log.rejected += other.rejected;
      for (const line of other.lines) {
        if (log.lines.length < CAPS.problemsListed) log.lines.push(line);
      }
      log.total += other.total;
    },
  };
  return log;
}

// ─── The injected I/O ────────────────────────────────────────────────────────

/**
 * The one network call a connector reader may make.
 *
 * Narrow on purpose, and injected rather than imported: a reader that reaches
 * for `fetch` at module scope cannot be tested without a server, which is how
 * 629 lines of crawler.ts came to have almost no tests. Everything below runs
 * against a fake in the test file, including the pagination and the page cap.
 */
export interface SpecHttpResponse {
  status: number;
  /** The parsed JSON body, or null when the response carried none. */
  json: unknown;
  /** The raw body, for an error message. Never logged. */
  text: string;
}

export interface SpecHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export type SpecHttp = (request: SpecHttpRequest) => Promise<SpecHttpResponse>;

const realHttp: SpecHttp = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    redirect: 'error',
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Left null. A provider that answered with HTML (a login page, a proxy
    // error) has not answered with a specification, and the reader reports
    // that rather than reading an empty object as "no requirements".
    json = null;
  }
  return { status: response.status, json, text };
};

interface RequirementsIo {
  http: SpecHttp;
}

let io: RequirementsIo = { http: realHttp };

/** Point this router at its I/O. Returns the previous settings so a test can restore them. */
export function configureRequirementsIo(next: Partial<RequirementsIo>): RequirementsIo {
  const previous = io;
  io = { ...io, ...next };
  return previous;
}

// ─── The connector catalogue ────────────────────────────────────────────────

/**
 * Why a connector cannot run here. A closed vocabulary because each member has
 * a different remedy, and because "unavailable" with no reason is
 * indistinguishable from a bug in us.
 */
export const CONNECTOR_UNAVAILABLE_REASONS = [
  /** No `IntegrationKind` in this install can hold this provider's credential. */
  'NO_CREDENTIAL_HOME',
  /**
   * `SPEC_SOURCE_SYSTEMS` has no member for this provider, so a row imported
   * from it could not record where it came from. Storing it as MARKDOWN would
   * make the provenance a lie, and provenance is the product.
   */
  'NO_SOURCE_SYSTEM',
  /** The reader is not written yet. Our gap, named as ours. */
  'NO_READER',
  /** The customer has no `Integration` row of the required kind. */
  'NOT_CONFIGURED',
] as const;
export type ConnectorUnavailableReason = (typeof CONNECTOR_UNAVAILABLE_REASONS)[number];

export const CONNECTOR_UNAVAILABLE_LABELS: Record<ConnectorUnavailableReason, string> = {
  NO_CREDENTIAL_HOME:
    'no IntegrationKind in this install can hold this provider’s credential, and a credential ' +
    'must live on a row the customer owns rather than in the environment',
  NO_SOURCE_SYSTEM:
    'SpecSourceSystem has no member for this provider, so an imported row could not record ' +
    'where it came from; recording it as MARKDOWN would make the provenance a lie',
  NO_READER: 'the reader for this provider is not written yet',
  NOT_CONFIGURED: 'this project’s organisation has no integration of the required kind',
};

/**
 * Every provider this door knows about, available or not.
 *
 * THE DISCRIMINANT RECORD AND THE RUN-TIME PARITY TEST ARE BOTH REQUIRED. This
 * is a `Record` keyed on the union, so the compiler refuses to let a member be
 * added without a shape; requirements.test.ts compares the keys against the zod
 * enum's own options at run time, because the compiler cannot see that the write
 * path is missing an arm. Eight GateRule kinds shipped unsaveable for two slices
 * because only one of the two mechanisms existed, and `check:wiring` cannot see
 * that class of defect.
 */
export const SPEC_CONNECTORS = [
  'JIRA',
  'LINEAR',
  'GITHUB_ISSUES',
  'CONFLUENCE',
  'NOTION',
  'GOOGLE_DOCS',
] as const;
export type SpecConnector = (typeof SPEC_CONNECTORS)[number];

/** One provider page or ticket, before it becomes a {@link RequirementInput}. */
interface ConnectorRead {
  rows: RequirementInput[];
  /** Pages actually fetched. */
  pagesFetched: number;
  /** True when the page cap stopped the read with more waiting. */
  moreAvailable: boolean;
  /**
   * Rows the provider handed us, counted before anything dropped one.
   *
   * The denominator of this read: `offered - rows.length` is what the reader
   * could not store, and a response that cannot state it cannot be checked.
   */
  offered: number;
  /** Parse problems, named and counted. A silent drop is a shrunk denominator. */
  problems: ProblemLog;
  /** Acceptance criteria the per-requirement cap dropped, across all rows. */
  criteriaDroppedByCap: number;
}

interface ConnectorContext {
  http: SpecHttp;
  /** The non-secret half of the integration's config. */
  config: Record<string, unknown>;
  /** Unsealed for this call only, never returned in a response or an audit. */
  token: string;
}

interface ConnectorShape {
  /**
   * How an imported row records its origin. Null means this vocabulary cannot,
   * which makes the connector unavailable — see NO_SOURCE_SYSTEM.
   */
  sourceSystem: SpecSourceSystem | null;
  /**
   * Which `Integration.kind` row holds the credential. Null means no kind in
   * this install can, which makes the connector unavailable — and the remedy is
   * a schema change, never an environment variable.
   */
  integrationKind: 'JIRA' | 'LINEAR' | 'GITHUB' | null;
  /** Config keys the reader needs. Reported so a 400 can name the missing one. */
  requiredConfig: readonly string[];
  /**
   * True when a DOCUMENT BODY is the specification — a Confluence page, a
   * Notion page, a Google Doc. Those three need the same criteria extractor the
   * Markdown importer uses and differ only in how the body is fetched, which is
   * why their shapes are declared here rather than left unmentioned.
   */
  bodyIsTheSource: boolean;
  /** Null when not written. The reader, taking its I/O as an argument. */
  read: ((context: ConnectorContext) => Promise<ConnectorRead>) | null;
}

// ─── Status mapping ──────────────────────────────────────────────────────────

/**
 * Tracker status words we recognise, lower-cased.
 *
 * Deliberately short. Every word NOT here becomes UNMAPPED with the raw value
 * on the row, because the alternative — guessing — moves the coverage
 * denominator through `requirementCounts`, and a percentage moved by a mapping
 * table nobody reviewed is the defect `RequirementStatus` has two extra members
 * to prevent.
 */
const STATUS_WORDS: Record<string, RequirementStatus> = {
  draft: 'DRAFT',
  'to do': 'READY',
  todo: 'READY',
  backlog: 'READY',
  ready: 'READY',
  open: 'READY',
  'in progress': 'IN_PROGRESS',
  'in development': 'IN_PROGRESS',
  started: 'IN_PROGRESS',
  'in review': 'IN_PROGRESS',
  done: 'DONE',
  closed: 'DONE',
  complete: 'DONE',
  completed: 'DONE',
  resolved: 'DONE',
  released: 'DONE',
  cancelled: 'OBSOLETE',
  canceled: 'OBSOLETE',
  "won't do": 'OBSOLETE',
  wontfix: 'OBSOLETE',
  duplicate: 'OBSOLETE',
  'not planned': 'OBSOLETE',
};

/**
 * One tracker word → our status, with the raw word kept whenever we failed.
 *
 * Returns NOT_STATED only for genuine absence. `requirementImportSchema`
 * refuses UNMAPPED with no `statusRaw`, so the pair below is the only legal
 * shape for a word we did not recognise.
 */
function mapStatus(raw: string | null | undefined): {
  status: RequirementStatus;
  statusRaw: string | null;
} {
  const word = (raw ?? '').trim();
  if (!word) return { status: 'NOT_STATED', statusRaw: null };
  const mapped = STATUS_WORDS[word.toLowerCase()];
  if (mapped) return { status: mapped, statusRaw: word.slice(0, 200) };
  return { status: 'UNMAPPED', statusRaw: word.slice(0, 200) };
}

// ─── Acceptance criteria, extracted from prose ──────────────────────────────

interface ExtractedCriteria {
  criteria: Array<{
    ordinal: number;
    text: string;
    format: AcceptanceCriterionFormat;
    externalId: string | null;
  }>;
  /**
   * True when any criterion came out of the UNSTRUCTURED fallback.
   *
   * Reported, never hidden: a count derived by splitting sentences is an
   * ESTIMATE, and printing it beside exact counts from a Gherkin block would
   * make a guess look like a measurement. `STRUCTURED_CRITERION_FORMATS` is the
   * line between the two and is what this flag is computed from.
   */
  estimated: boolean;
  /**
   * Criteria this body declared that the per-requirement cap dropped.
   *
   * ── WHY A COUNT AND NOT A SILENT SLICE ────────────────────────────────────
   *
   * `found.slice(0, CAPS.criteriaPerRequirement)` used to return the first 500
   * and say nothing, and an acceptance criterion is a denominator row: a
   * 600-row requirements table imported as 500 criteria, the other 100 stopped
   * being uncovered and became absent, and absent costs nothing while
   * uncovered lowers the percentage. The caller adds this up and the response
   * discloses it as a cap that bit.
   */
  droppedByCap: number;
}

const GHERKIN_START = /^\s*(given)\b/i;
const GHERKIN_CONTINUE = /^\s*(when|then|and|but)\b/i;
const CHECKBOX = /^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/;
const BULLET = /^\s*[-*•]\s+(.+)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.+)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

/**
 * Pull acceptance criteria out of a body.
 *
 * ── The ordering is the whole correctness argument ──────────────────────────
 *
 * A `- [ ] …` line is also a bullet, and a Gherkin block is also a run of
 * bullets in plenty of trackers. Testing in the wrong order turns one scenario
 * into four criteria — which inflates the spec-side denominator and makes
 * "three of four criteria are untested" a sentence about our parser rather than
 * about the application. So: Gherkin blocks first (they absorb their own
 * When/Then/And lines), then checkboxes, then numbered, then bullets, then
 * table rows, and only then the sentence-splitting fallback.
 *
 * The fallback is REPORTED through `estimated` rather than hidden, because a
 * criterion count arrived at by splitting on full stops is a guess.
 */
export function extractCriteria(body: string): ExtractedCriteria {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const found: Array<{ text: string; format: AcceptanceCriterionFormat }> = [];

  let gherkin: string[] | null = null;
  const flushGherkin = () => {
    if (gherkin && gherkin.length > 0) {
      found.push({ text: gherkin.join('\n'), format: 'GIVEN_WHEN_THEN' });
    }
    gherkin = null;
  };

  for (const line of lines) {
    if (gherkin !== null && GHERKIN_CONTINUE.test(line)) {
      gherkin.push(line.trim());
      continue;
    }
    if (GHERKIN_START.test(line)) {
      flushGherkin();
      gherkin = [line.trim()];
      continue;
    }
    flushGherkin();

    const checkbox = CHECKBOX.exec(line);
    if (checkbox?.[2]) {
      found.push({ text: checkbox[2].trim(), format: 'CHECKBOX' });
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered?.[2]) {
      found.push({ text: numbered[2].trim(), format: 'NUMBERED' });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet?.[1]) {
      found.push({ text: bullet[1].trim(), format: 'BULLET' });
      continue;
    }
    if (TABLE_SEPARATOR.test(line)) {
      // The separator proves the row above it was a HEADER, not a criterion.
      // Dropping it here rather than counting it keeps a table's column titles
      // out of the denominator.
      if (found.length > 0 && found[found.length - 1]?.format === 'TABLE_ROW') found.pop();
      continue;
    }
    const table = TABLE_ROW.exec(line);
    if (table?.[1]) {
      found.push({
        text: table[1]
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(' | '),
        format: 'TABLE_ROW',
      });
      continue;
    }
  }
  flushGherkin();

  if (found.length === 0) {
    /*
     * Nothing structured. Split on sentence ends, and SAY it was a split.
     *
     * A body with no structure at all still states acceptance criteria in most
     * trackers, and refusing to extract any would report a requirement as
     * having none — which reads on screen as "nothing to test here".
     */
    const sentences = body
      .replace(/\r\n?/g, '\n')
      .split(/(?<=[.!?])\s+|\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 8);
    for (const sentence of sentences) found.push({ text: sentence, format: 'UNSTRUCTURED' });
  }

  const capped = found.slice(0, CAPS.criteriaPerRequirement);
  return {
    droppedByCap: found.length - capped.length,
    criteria: capped.map((entry, ordinal) => ({
      ordinal,
      text: entry.text.slice(0, 5_000),
      format: entry.format,
      externalId: null,
    })),
    estimated: capped.some((entry) => !STRUCTURED_CRITERION_FORMATS.includes(entry.format)),
  };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/**
 * A CSV reader that handles quoting, because a half-reader is worse than none.
 *
 * An acceptance criterion contains commas and newlines constantly ("Given a
 * cart with 3 items, when the user…"), so splitting on commas would shear every
 * interesting row in half and the damage would look like the customer's data
 * being malformed. RFC 4180 quoting: `""` inside a quoted field is one quote.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const text = content.replace(/\r\n?/g, '\n');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }
    field += char as string;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim().length > 0));
}

/** Header aliases, so a tracker's own export works without being re-typed. */
const CSV_COLUMNS = {
  externalId: ['externalid', 'id', 'key', 'issue key', 'identifier'],
  title: ['title', 'summary', 'name'],
  body: ['body', 'description', 'details'],
  status: ['status', 'state'],
  url: ['url', 'link', 'permalink'],
  criteria: ['criteria', 'acceptance criteria', 'acceptancecriteria'],
} as const;

function headerIndex(header: readonly string[], aliases: readonly string[]): number {
  const normalised = header.map((cell) => cell.trim().toLowerCase());
  for (const alias of aliases) {
    const at = normalised.indexOf(alias);
    if (at >= 0) return at;
  }
  return -1;
}

interface ParsedRows {
  rows: RequirementInput[];
  problems: ProblemLog;
  /**
   * Requirements the document OFFERED, counted before any of them was dropped.
   *
   * `offered - rows.length` is what this parser refused, and it is a count
   * rather than `problems.lines.length`: that list is capped, so deriving the
   * figure from it reported 50 for an import that dropped 300.
   */
  offered: number;
  /** Rows whose id we had to invent. Always disclosed — see the note below. */
  idsSynthesised: number;
  estimatedCriteria: number;
  /** Acceptance criteria the per-requirement cap dropped, across all rows. */
  criteriaDroppedByCap: number;
}

function requirementsFromCsv(content: string, sourceSystem: SpecSourceSystem): ParsedRows {
  const table = parseCsv(content);
  const header = table[0];
  if (!header) throw badRequest('That CSV has no rows.');

  const columns = {
    externalId: headerIndex(header, CSV_COLUMNS.externalId),
    title: headerIndex(header, CSV_COLUMNS.title),
    body: headerIndex(header, CSV_COLUMNS.body),
    status: headerIndex(header, CSV_COLUMNS.status),
    url: headerIndex(header, CSV_COLUMNS.url),
    criteria: headerIndex(header, CSV_COLUMNS.criteria),
  };
  // A missing id column is refused rather than worked around. A synthesised id
  // for a CSV changes when a row is inserted above it, and every link asserted
  // against the old id would silently point at a different requirement.
  if (columns.externalId < 0) {
    throw badRequest(
      `That CSV has no id column. One of ${CSV_COLUMNS.externalId.join(', ')} is required, ` +
        `and the header read: ${header.map((cell) => cell.trim()).join(', ')}.`,
    );
  }
  if (columns.title < 0) {
    throw badRequest(
      `That CSV has no title column. One of ${CSV_COLUMNS.title.join(', ')} is required, ` +
        `and the header read: ${header.map((cell) => cell.trim()).join(', ')}.`,
    );
  }

  const rows: RequirementInput[] = [];
  const problems = problemLog();
  let estimatedCriteria = 0;
  let criteriaDroppedByCap = 0;
  let offered = 0;
  const cell = (row: readonly string[], at: number): string =>
    at < 0 ? '' : (row[at] ?? '').trim();

  for (const [index, row] of table.slice(1).entries()) {
    /*
     * A wholly empty line is not a requirement the document offered, so it is
     * neither counted nor rejected. Every CSV export ends with a newline, and
     * counting that as a dropped requirement would put a phantom row in the
     * rejection count on every single import — a disclosed figure that is
     * wrong by one teaches a reader to stop checking it. Same guard as
     * `readCsvCases` in packages/agent/src/importer.ts.
     */
    if (row.every((value) => value.trim().length === 0)) continue;
    offered += 1;
    const externalId = cell(row, columns.externalId);
    const title = cell(row, columns.title);
    if (!externalId || !title) {
      problems.reject(
        `row ${index + 2}: ${!externalId ? 'no id' : 'no title'} — skipped, not stored`,
      );
      continue;
    }
    const body = cell(row, columns.body);
    const explicit = cell(row, columns.criteria);
    const extracted = extractCriteria(explicit || body);
    if (extracted.estimated) estimatedCriteria += 1;
    criteriaDroppedByCap += extracted.droppedByCap;
    const { status, statusRaw } = mapStatus(cell(row, columns.status));
    const url = cell(row, columns.url);

    rows.push({
      externalId,
      sourceSystem,
      title,
      body,
      status,
      statusRaw,
      url: url && /^https?:\/\//i.test(url) ? url : null,
      criteria: extracted.criteria,
    });
  }
  return { rows, problems, offered, idsSynthesised: 0, estimatedCriteria, criteriaDroppedByCap };
}

// ─── Markdown ────────────────────────────────────────────────────────────────

/** A tracker id at the start of a heading: `PROJ-412`, `#1884`, `AC-3`. */
const HEADING_ID = /^(?:#\s*)?((?:[A-Z][A-Z0-9_]*-\d+)|(?:#\d+))\b/;

function slugId(heading: string): string {
  return (
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 200) || 'untitled'
  );
}

function requirementsFromMarkdown(content: string, sourceSystem: SpecSourceSystem): ParsedRows {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const sections: Array<{ heading: string; body: string[] }> = [];
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (heading?.[2]) {
      sections.push({ heading: heading[2], body: [] });
      continue;
    }
    sections[sections.length - 1]?.body.push(line);
  }
  if (sections.length === 0) {
    throw badRequest(
      'That Markdown has no headings, so there is nothing to give a requirement an id. ' +
        'Put each requirement under a `## PROJ-412 Title` heading, or import it as CSV.',
    );
  }

  const rows: RequirementInput[] = [];
  const problems = problemLog();
  let idsSynthesised = 0;
  let estimatedCriteria = 0;
  let criteriaDroppedByCap = 0;

  for (const section of sections) {
    const matched = HEADING_ID.exec(section.heading.trim());
    const externalId = matched?.[1] ?? slugId(section.heading);
    if (!matched) idsSynthesised += 1;
    const body = section.body.join('\n').trim();
    const extracted = extractCriteria(body);
    if (extracted.estimated) estimatedCriteria += 1;
    criteriaDroppedByCap += extracted.droppedByCap;

    rows.push({
      externalId,
      sourceSystem,
      title: section.heading.replace(HEADING_ID, '').replace(/^[\s—:-]+/, '').trim() ||
        section.heading.trim(),
      body,
      // A Markdown file usually declares no status, and NOT_STATED says exactly
      // that. DRAFT would be a guess that changes whether the row counts.
      status: 'NOT_STATED',
      statusRaw: null,
      url: null,
      criteria: extracted.criteria,
    });
  }
  if (idsSynthesised > 0) {
    /*
     * A NOTE and not a rejection: every one of these rows imported. It lived in
     * the same array as the rejections and `totals.rejected` was that array's
     * length, so a clean two-section Markdown import reported one requirement
     * rejected and both of them accepted.
     */
    problems.note(
      `${idsSynthesised} heading(s) carried no tracker id, so an id was derived from the ` +
        'heading text. Editing such a heading changes the id and orphans every link asserted ' +
        'against it — add `PROJ-412` style ids to make the identity stable.',
    );
  }
  /*
   * Markdown refuses nothing: a section with a heading is a requirement, and a
   * document with no headings at all is a 400 above rather than a partial
   * import. So `offered` is the section count and the two agree by construction
   * — which is a fact worth asserting rather than a coincidence worth assuming.
   */
  return {
    rows,
    problems,
    offered: sections.length,
    idsSynthesised,
    estimatedCriteria,
    criteriaDroppedByCap,
  };
}

// ─── Connector readers ──────────────────────────────────────────────────────

/** A string from unknown JSON, or ''. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Plain text out of Atlassian Document Format.
 *
 * Jira's v3 REST API returns a description as an ADF tree, not a string. Read
 * naively it stringifies to `[object Object]`, which would store a body of
 * punctuation and extract criteria from it — so the walk is explicit, and a
 * shape it cannot read returns null rather than ''. Null reaches the caller as
 * a NAMED problem; '' would reach it as "this ticket has no description", which
 * is a claim about the customer's ticket made from our own gap.
 */
export function plainTextFromAdf(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return null;
  const doc = node as Record<string, unknown>;
  if (typeof doc.text === 'string') return doc.text;
  const children = list(doc.content);
  if (children.length === 0) return typeof doc.type === 'string' ? '' : null;
  const parts: string[] = [];
  for (const child of children) {
    const text = plainTextFromAdf(child);
    if (text === null) return null;
    parts.push(text);
  }
  // Block nodes become their own lines so the criteria extractor can see the
  // bullets Jira stored as separate list items.
  const separator = doc.type === 'paragraph' || doc.type === 'heading' ? '' : '\n';
  return parts.join(separator);
}

const jiraReader = async (context: ConnectorContext): Promise<ConnectorRead> => {
  const site = jiraSite(str(context.config.baseUrl));
  const projectKey = str(context.config.projectKey).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)) {
    throw badRequest('That Jira integration has no project key — set `projectKey` to e.g. "QA".');
  }
  /*
   * Basic for Jira Cloud (email:token) and Bearer for a Data Center PAT, which
   * is the same split `lib/issues.ts` makes on the same config field. Guessing
   * one would make every import 401 against half the installs.
   */
  const authorization = context.config.email
    ? `Basic ${Buffer.from(`${str(context.config.email)}:${context.token}`).toString('base64')}`
    : `Bearer ${context.token}`;

  const rows: RequirementInput[] = [];
  const problems = problemLog();
  let pagesFetched = 0;
  let moreAvailable = false;
  let offered = 0;
  let criteriaDroppedByCap = 0;

  for (let page = 0; page < CAPS.connectorPages; page += 1) {
    const url =
      `${site}/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ${projectKey} ORDER BY key ASC`)}` +
      `&maxResults=${CAPS.connectorPageSize}&startAt=${page * CAPS.connectorPageSize}` +
      '&fields=summary,description,status';
    const response = await io.http({
      url,
      method: 'GET',
      headers: { authorization, accept: 'application/json' },
    });
    pagesFetched += 1;
    if (response.status < 200 || response.status >= 300) {
      throw unprocessable(`Jira answered ${response.status}; nothing was imported.`);
    }
    const payload = record(response.json);
    const issues = list(payload.issues);
    offered += issues.length;
    for (const raw of issues) {
      const issue = record(raw);
      const fields = record(issue.fields);
      const key = str(issue.key);
      const title = str(fields.summary);
      if (!key || !title) {
        problems.reject(`a Jira issue arrived with no ${key ? 'summary' : 'key'}; not stored`);
        continue;
      }
      const description = plainTextFromAdf(fields.description ?? '');
      if (description === null) {
        // A NOTE: this issue imports, with an empty body and our gap named.
        problems.note(
          `${key}: the description is in a format this reader cannot read, so no criteria were ` +
            'extracted from it. Its body is stored empty and that is our gap, not the ticket’s.',
        );
      }
      const body = description ?? '';
      const extracted = extractCriteria(body);
      criteriaDroppedByCap += extracted.droppedByCap;
      const { status, statusRaw } = mapStatus(str(record(fields.status).name));
      rows.push({
        externalId: key,
        sourceSystem: 'JIRA',
        title,
        body,
        status,
        statusRaw,
        url: `${site}/browse/${key}`,
        criteria: extracted.criteria,
      });
    }
    const total = typeof payload.total === 'number' ? payload.total : null;
    const seen = (page + 1) * CAPS.connectorPageSize;
    if (issues.length < CAPS.connectorPageSize || (total !== null && seen >= total)) {
      return { rows, pagesFetched, moreAvailable: false, offered, problems, criteriaDroppedByCap };
    }
    moreAvailable = true;
  }
  return { rows, pagesFetched, moreAvailable, offered, problems, criteriaDroppedByCap };
};

const linearReader = async (context: ConnectorContext): Promise<ConnectorRead> => {
  const teamId = str(context.config.teamId);
  if (!teamId) {
    throw badRequest('That Linear integration has no team — set `teamId` to the team’s id.');
  }
  const rows: RequirementInput[] = [];
  const problems = problemLog();
  let pagesFetched = 0;
  let cursor: string | null = null;
  let moreAvailable = false;
  let offered = 0;
  let criteriaDroppedByCap = 0;

  for (let page = 0; page < CAPS.connectorPages; page += 1) {
    const query = `query($teamId: String!, $first: Int!, $after: String) {
      team(id: $teamId) {
        issues(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { identifier title description url state { name } }
        }
      }
    }`;
    const response = await io.http({
      url: 'https://api.linear.app/graphql',
      method: 'POST',
      headers: { authorization: context.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { teamId, first: CAPS.connectorPageSize, after: cursor },
      }),
    });
    pagesFetched += 1;
    if (response.status < 200 || response.status >= 300) {
      throw unprocessable(`Linear answered ${response.status}; nothing was imported.`);
    }
    const payload = record(response.json);
    if (list(payload.errors).length > 0) {
      throw unprocessable('Linear refused the query; nothing was imported.');
    }
    const issues = record(record(record(payload.data).team).issues);
    const nodes = list(issues.nodes);
    offered += nodes.length;
    for (const raw of nodes) {
      const issue = record(raw);
      const identifier = str(issue.identifier);
      const title = str(issue.title);
      if (!identifier || !title) {
        problems.reject('a Linear issue arrived with no identifier or title; not stored');
        continue;
      }
      const body = str(issue.description);
      const extracted = extractCriteria(body);
      criteriaDroppedByCap += extracted.droppedByCap;
      const { status, statusRaw } = mapStatus(str(record(issue.state).name));
      rows.push({
        externalId: identifier,
        sourceSystem: 'LINEAR',
        title,
        body,
        status,
        statusRaw,
        url: str(issue.url) || null,
        criteria: extracted.criteria,
      });
    }
    const pageInfo = record(issues.pageInfo);
    if (pageInfo.hasNextPage !== true) {
      return { rows, pagesFetched, moreAvailable: false, offered, problems, criteriaDroppedByCap };
    }
    cursor = str(pageInfo.endCursor) || null;
    moreAvailable = true;
  }
  return { rows, pagesFetched, moreAvailable, offered, problems, criteriaDroppedByCap };
};

const githubIssuesReader = async (context: ConnectorContext): Promise<ConnectorRead> => {
  const slug = githubRepoSlug(str(context.config.repo));
  const rows: RequirementInput[] = [];
  const problems = problemLog();
  let pagesFetched = 0;
  let moreAvailable = false;
  let offered = 0;
  let criteriaDroppedByCap = 0;

  for (let page = 1; page <= CAPS.connectorPages; page += 1) {
    const response = await io.http({
      url:
        `https://api.github.com/repos/${slug}/issues?state=all` +
        `&per_page=${CAPS.connectorPageSize}&page=${page}`,
      method: 'GET',
      headers: {
        authorization: `Bearer ${context.token}`,
        accept: 'application/vnd.github+json',
      },
    });
    pagesFetched += 1;
    if (response.status < 200 || response.status >= 300) {
      throw unprocessable(`GitHub answered ${response.status}; nothing was imported.`);
    }
    const issues = list(response.json);
    for (const raw of issues) {
      const issue = record(raw);
      // A pull request is an issue on this endpoint and is not a requirement.
      // Counting them would inflate the spec-side denominator with our own
      // review traffic — so it is not OFFERED either, and `offered` counts
      // what follows this guard rather than the page length.
      if (issue.pull_request !== undefined) continue;
      offered += 1;
      const number = typeof issue.number === 'number' ? issue.number : null;
      const title = str(issue.title);
      if (number === null || !title) {
        problems.reject('a GitHub issue arrived with no number or title; not stored');
        continue;
      }
      const body = str(issue.body);
      const extracted = extractCriteria(body);
      criteriaDroppedByCap += extracted.droppedByCap;
      /*
       * ── WHY GitHub's `open` DOES NOT GO THROUGH THE WORD TABLE ───────────
       *
       * `STATUS_WORDS` maps the word "open" to READY, and that is right for
       * Jira and Linear, where Open is a NAMED WORKFLOW STATE somebody
       * configured to mean "agreed, not built". GitHub's `state` is not a
       * workflow state: it is a binary, and an open issue may be a wish, a
       * draft, a bug or a feature half-built. Reading it as READY would make
       * `requirementTestability` answer NOT_YET_BUILT for every open issue in
       * the repository, which tells a generator to expect its tests to FAIL —
       * a real consequence drawn from one word meaning two different things in
       * two products. So `open` is UNMAPPED with the word on the row, which is
       * exactly what UNMAPPED is for, and `state_reason` is read because it is
       * the only field that separates "we built it" from "we are not going to".
       */
      const reason = str(issue.state_reason);
      const { status, statusRaw } =
        str(issue.state) === 'closed'
          ? mapStatus(reason === 'not_planned' ? 'not planned' : 'closed')
          : { status: 'UNMAPPED' as const, statusRaw: str(issue.state) || 'open' };
      rows.push({
        externalId: `#${number}`,
        sourceSystem: 'GITHUB_ISSUES',
        title,
        body,
        status,
        statusRaw,
        url: str(issue.html_url) || null,
        criteria: extracted.criteria,
      });
    }
    if (issues.length < CAPS.connectorPageSize) {
      return { rows, pagesFetched, moreAvailable: false, offered, problems, criteriaDroppedByCap };
    }
    moreAvailable = true;
  }
  return { rows, pagesFetched, moreAvailable, offered, problems, criteriaDroppedByCap };
};

/**
 * The catalogue. See the note on {@link SPEC_CONNECTORS}: the compiler enforces
 * this record and the test file enforces the record against the zod enum.
 */
export const SPEC_CONNECTOR_SHAPES: Record<SpecConnector, ConnectorShape> = {
  JIRA: {
    sourceSystem: 'JIRA',
    integrationKind: 'JIRA',
    requiredConfig: ['baseUrl', 'projectKey'],
    bodyIsTheSource: false,
    read: jiraReader,
  },
  LINEAR: {
    sourceSystem: 'LINEAR',
    integrationKind: 'LINEAR',
    requiredConfig: ['teamId'],
    bodyIsTheSource: false,
    read: linearReader,
  },
  GITHUB_ISSUES: {
    sourceSystem: 'GITHUB_ISSUES',
    integrationKind: 'GITHUB',
    requiredConfig: ['repo'],
    bodyIsTheSource: false,
    read: githubIssuesReader,
  },
  /*
   * The three document systems.
   *
   * Their shapes are declared rather than omitted because the difference
   * between them and the three above is ONE missing enum member each, and a
   * catalogue that simply did not mention Confluence would read as "QAAI does
   * not support it" when the truth is "the vocabulary cannot record where the
   * row came from". `read` is written the day `SpecSourceSystem` can name them;
   * until then the route answers 501 and says which of the two is missing.
   */
  CONFLUENCE: {
    sourceSystem: null,
    integrationKind: null,
    requiredConfig: ['baseUrl', 'spaceKey'],
    bodyIsTheSource: true,
    read: null,
  },
  NOTION: {
    sourceSystem: null,
    integrationKind: null,
    requiredConfig: ['databaseId'],
    bodyIsTheSource: true,
    read: null,
  },
  GOOGLE_DOCS: {
    sourceSystem: null,
    integrationKind: null,
    requiredConfig: ['documentId'],
    bodyIsTheSource: true,
    read: null,
  },
};

/** Why this connector cannot run, or null when it can. */
function unavailableReason(connector: SpecConnector): ConnectorUnavailableReason | null {
  const shape = SPEC_CONNECTOR_SHAPES[connector];
  if (shape.sourceSystem === null) return 'NO_SOURCE_SYSTEM';
  if (shape.integrationKind === null) return 'NO_CREDENTIAL_HOME';
  if (shape.read === null) return 'NO_READER';
  return null;
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
 * Copied from routes/surface.ts rather than imported from it: a router
 * importing another router's internals couples their module load order for a
 * nine-line helper, and lib/ is the right home if a third door needs it.
 *
 * An unknown value must never answer with an empty list. `?linkState=NOTLINKED`
 * (one character wrong) answering `[]` reads on screen as "every requirement is
 * covered", which is the most dangerous sentence this endpoint can produce.
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

// ─── POST /requirements/:projectId ──────────────────────────────────────────

const importBody = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('INLINE'),
    /**
     * Already in our shape. `requirementImportSchema` is the single legal write
     * path and each row goes through it below.
     *
     * The array bound is DELIBERATELY well above `CAPS.importBatch`, and that
     * is not slack: a schema that refused at `importBatch + 1` would make the
     * disclosed cap unreachable, so the limit would be enforced by a 400 here
     * and by a reported truncation for CSV and connector imports — two
     * behaviours for one documented number, and a cap nobody could ever see
     * bite. One governing cap, disclosed the same way for all four sources.
     */
    requirements: z.array(z.unknown()).min(1).max(CAPS.importBatch * 10),
    dryRun: z.boolean().default(false),
  }),
  z.object({
    source: z.literal('CSV'),
    content: z.string().min(1),
    /**
     * Which system the sheet came OUT of. Defaults to CSV, which is the honest
     * answer for an export nobody told us the origin of — and is a real member
     * of the vocabulary rather than a placeholder.
     */
    sourceSystem: z.enum(SPEC_SOURCE_SYSTEMS).default('CSV'),
    dryRun: z.boolean().default(false),
  }),
  z.object({
    source: z.literal('MARKDOWN'),
    content: z.string().min(1),
    sourceSystem: z.enum(SPEC_SOURCE_SYSTEMS).default('MARKDOWN'),
    dryRun: z.boolean().default(false),
  }),
  z.object({
    source: z.literal('CONNECTOR'),
    connector: z.enum(SPEC_CONNECTORS),
    /** The `Integration` row that holds the credential. Never an env var. */
    integrationId: z.string().trim().min(1).max(64),
    dryRun: z.boolean().default(false),
  }),
]);

/** What a re-import did to one row, as `classifyReimport` classifies it. */
interface ImportChange {
  externalId: string;
  sourceSystem: SpecSourceSystem;
  change: string;
  detail: string;
  criteria: { stored: number; moved: number; changed: number; retired: number };
}

/**
 * Write one requirement and its criteria, returning what changed.
 *
 * ── WHY THE CRITERIA ARE MATCHED BY TEXT BEFORE ORDINAL ────────────────────
 *
 * A criterion's identity is (requirement, ordinal), and a link points at the
 * ROW. Insert a new bullet at the top of a ticket and every ordinal below it
 * shifts by one: matched by ordinal alone, criterion 3 would be "changed" to
 * the text of criterion 2, and a link a person asserted against criterion 3
 * would silently now claim to cover something else. So stored rows are matched
 * to incoming ones BY TEXT first, the survivors keep their ids, and the ordinal
 * move is REPORTED — which is exactly what the schema's note asks for.
 *
 * ── WHY THE ORDINAL SHUFFLE IS TWO-PHASE ───────────────────────────────────
 *
 * `@@unique([requirementId, ordinal])` is enforced per statement, so swapping
 * two criteria by writing 0→1 then 1→0 violates it on the first write. Every
 * moving row therefore goes to a negative ordinal first and then to its
 * destination, inside the transaction, where no reader can see the gap.
 */
async function persistRequirement(
  tx: Prisma.TransactionClient,
  args: {
    orgId: string;
    projectId: string;
    row: RequirementInput;
    now: Date;
  },
): Promise<ImportChange> {
  const { orgId, projectId, row, now } = args;
  const nextHash = requirementContentHash(
    {
      externalId: row.externalId,
      title: row.title,
      body: row.body,
      criteria: row.criteria.map((criterion) => criterion.text),
    },
    sha256,
  );

  const existing = await tx.requirement.findUnique({
    where: {
      projectId_sourceSystem_externalId: {
        projectId,
        sourceSystem: row.sourceSystem,
        externalId: row.externalId,
      },
    },
    select: { id: true, contentHash: true, retiredAt: true },
  });

  // `undefined` for a row that does not exist, the stored value otherwise:
  // `classifyReimport` distinguishes three inputs and not two, and NEW versus
  // NOT_COMPARABLE is the distinction that keeps a customer's edit from being
  // dropped silently.
  const classified = classifyReimport(existing ? existing.contentHash : undefined, nextHash);

  const data = {
    title: row.title,
    body: row.body,
    status: row.status,
    statusRaw: row.statusRaw,
    url: row.url,
    contentHash: nextHash,
    lastImportedAt: now,
    // Only stamped when the content ACTUALLY differed. Stamping it on every
    // import would make "when did this specification last change?" answer
    // "whenever a cron last ran", which is not a fact about the specification.
    ...(classified.kind === 'CHANGED' ? { contentChangedAt: now } : {}),
    // A row the source returned again is not retired, whatever it was before.
    ...(existing?.retiredAt ? { retiredAt: null } : {}),
  };

  const requirement = existing
    ? await tx.requirement.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      })
    : await tx.requirement.create({
        data: {
          orgId,
          projectId,
          externalId: row.externalId,
          sourceSystem: row.sourceSystem,
          ...data,
        },
        select: { id: true },
      });

  const stored = await tx.acceptanceCriterion.findMany({
    where: { requirementId: requirement.id },
    orderBy: { ordinal: 'asc' },
    select: { id: true, ordinal: true, text: true, format: true, retiredAt: true },
  });

  /*
   * TWO FULL PASSES, and the order is the whole correctness argument.
   *
   * Every text match is resolved BEFORE any ordinal match is considered. One
   * interleaved pass gets the common case wrong: insert a bullet at the top and
   * incoming[0] finds no text match, falls through to the ordinal rule, and
   * consumes the stored row whose text is now incoming[1]'s — so the row a
   * person linked to ends up holding different text and the link silently
   * claims to cover something nobody asserted. That is the defect this
   * function exists to prevent, and it survives an interleaved loop.
   */
  const unmatched = [...stored];
  const plan: Array<{ id: string | null; ordinal: number; moved: boolean; changed: boolean }> =
    row.criteria.map((incoming) => ({
      id: null,
      ordinal: incoming.ordinal,
      moved: false,
      changed: false,
    }));

  row.criteria.forEach((incoming, index) => {
    const at = unmatched.findIndex((candidate) => candidate.text === incoming.text);
    if (at < 0) return;
    const match = unmatched.splice(at, 1)[0]!;
    plan[index] = {
      id: match.id,
      ordinal: incoming.ordinal,
      moved: match.ordinal !== incoming.ordinal,
      changed: false,
    };
  });

  row.criteria.forEach((incoming, index) => {
    if (plan[index]!.id !== null) return;
    const at = unmatched.findIndex((candidate) => candidate.ordinal === incoming.ordinal);
    if (at < 0) return;
    const match = unmatched.splice(at, 1)[0]!;
    // Same position, different text: the criterion was EDITED. Its links stay,
    // because a reworded criterion is the same criterion.
    plan[index] = { id: match.id, ordinal: incoming.ordinal, moved: false, changed: true };
  });

  /*
   * Phase one: every row that is moving, and every row about to be vacated,
   * parked on a negative ordinal. Negative is unreachable from the write path
   * (`acceptanceCriterionSchema` enforces `min(0)`), so a row left parked by a
   * crash is visibly wrong rather than quietly occupying a real position.
   */
  const moving = plan.filter((entry) => entry.id !== null && entry.moved);
  for (const [index, entry] of moving.entries()) {
    await tx.acceptanceCriterion.update({
      where: { id: entry.id as string },
      data: { ordinal: -(index + 1) },
      select: { id: true },
    });
  }

  let movedCount = 0;
  let changedCount = 0;
  for (const [index, entry] of plan.entries()) {
    const incoming = row.criteria[index]!;
    if (entry.id === null) {
      await tx.acceptanceCriterion.create({
        data: {
          orgId,
          requirementId: requirement.id,
          ordinal: incoming.ordinal,
          text: incoming.text,
          format: incoming.format,
          externalId: incoming.externalId,
        },
        select: { id: true },
      });
      continue;
    }
    if (entry.moved) movedCount += 1;
    if (entry.changed) changedCount += 1;
    await tx.acceptanceCriterion.update({
      where: { id: entry.id },
      data: {
        ordinal: incoming.ordinal,
        text: incoming.text,
        format: incoming.format,
        externalId: incoming.externalId,
        lastSeenAt: now,
        // Reinstated by its reappearance, like the requirement above: the
        // source states it again, so it is not retired, whatever it was before.
        retiredAt: null,
      },
      select: { id: true },
    });
  }

  /*
   * Criteria the source no longer states are RETIRED, not deleted — the same
   * argument the schema makes for `Requirement.retiredAt`. A criterion that
   * vanishes takes its links with it, and a shrinking spec-side denominator
   * needs an audit trail at least as much as a growing one.
   */
  let retiredCount = 0;
  for (const leftover of unmatched) {
    if (leftover.retiredAt !== null) continue;
    retiredCount += 1;
    await tx.acceptanceCriterion.update({
      where: { id: leftover.id },
      data: { retiredAt: now },
      select: { id: true },
    });
  }

  return {
    externalId: row.externalId,
    sourceSystem: row.sourceSystem,
    change: classified.kind,
    detail: classified.detail,
    criteria: {
      stored: row.criteria.length,
      moved: movedCount,
      changed: changedCount,
      retired: retiredCount,
    },
  };
}

requirementsRouter.post(
  '/requirements/:projectId',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsedBody = importBody.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      throw badRequest(parsedBody.error.issues[0]?.message ?? 'Invalid body', {
        fieldErrors: parsedBody.error.flatten().fieldErrors,
      });
    }
    const body = parsedBody.data;
    const project = await projectOr404(String(req.params.projectId));
    const actor = actorOf(req);

    const capsThatBit: CapHit[] = [];
    const problems = problemLog();
    let candidates: RequirementInput[] = [];
    let sourceLabel: string;
    let estimatedCriteria = 0;
    let criteriaDroppedByCap = 0;
    let idsSynthesised = 0;
    let connectorPages: number | null = null;
    let connectorMore = false;
    /**
     * Requirements the source put in front of us, before any cap, dedupe or
     * rejection. The denominator every other total below is checked against:
     * `offered === accepted + duplicates + rejected + notStoredByCap`.
     */
    let offered = 0;

    if (body.source === 'INLINE') {
      sourceLabel = 'INLINE';
      /*
       * Each row through `requirementImportSchema`, which is the refinement that
       * refuses UNMAPPED with no `statusRaw`. A rejected row is COUNTED and
       * named rather than dropped: a silently smaller import is a silently
       * smaller denominator.
       */
      offered = body.requirements.length;
      for (const [index, raw] of body.requirements.entries()) {
        const candidate = requirementImportSchema.safeParse(raw);
        if (!candidate.success) {
          const issue = candidate.error.issues[0];
          problems.reject(
            `requirements[${index}] ${(issue?.path ?? []).join('.') || '(root)'}: ${
              issue?.message ?? 'invalid'
            } — not stored`,
          );
          continue;
        }
        candidates.push(candidate.data);
      }
    } else if (body.source === 'CSV' || body.source === 'MARKDOWN') {
      const bytes = Buffer.byteLength(body.content, 'utf8');
      if (bytes > CAPS.documentBytes) {
        // Refused, not truncated. Half a CSV imports fewer requirements, and
        // fewer requirements is the direction that flatters the percentage.
        throw badRequest(
          `That document is ${bytes} bytes and the limit is ${CAPS.documentBytes}. It is refused ` +
            'rather than truncated: a partial import declares fewer requirements, which would ' +
            'raise the coverage percentage with nothing tested.',
        );
      }
      sourceLabel = body.source;
      const parsed =
        body.source === 'CSV'
          ? requirementsFromCsv(body.content, body.sourceSystem)
          : requirementsFromMarkdown(body.content, body.sourceSystem);
      candidates = parsed.rows;
      problems.absorb(parsed.problems);
      offered = parsed.offered;
      criteriaDroppedByCap = parsed.criteriaDroppedByCap;
      estimatedCriteria = parsed.estimatedCriteria;
      idsSynthesised = parsed.idsSynthesised;
    } else {
      sourceLabel = `CONNECTOR:${body.connector}`;
      const shape = SPEC_CONNECTOR_SHAPES[body.connector];
      const blocked = unavailableReason(body.connector);
      if (blocked) {
        // 501 and the reason. A 200 with no requirements would say "your
        // Confluence space declares nothing", which is a measured claim made
        // from our own missing enum member.
        throw notImplemented(
          `Importing from ${body.connector} — ${CONNECTOR_UNAVAILABLE_LABELS[blocked]}`,
        );
      }

      const integration = await prisma.integration.findUnique({
        where: { id: body.integrationId },
        select: { id: true, kind: true, config: true, configEnc: true, enabled: true },
      });
      if (!integration) throw notFound('Integration');
      if (integration.kind !== shape.integrationKind) {
        throw badRequest(
          `Integration ${body.integrationId} is a ${integration.kind} integration and ` +
            `${body.connector} needs a ${shape.integrationKind} one.`,
        );
      }
      if (!integration.enabled) {
        throw badRequest(`Integration ${body.integrationId} is disabled.`);
      }
      if (!integration.configEnc) {
        throw badRequest(
          `Integration ${body.integrationId} holds no credential, so nothing was read. ` +
            'A connector’s token lives on this row and never in the environment.',
        );
      }
      const config = record(integration.config);
      const missing = shape.requiredConfig.filter((key) => !str(config[key]));
      if (missing.length > 0) {
        throw badRequest(
          `Integration ${body.integrationId} is missing ${missing.join(', ')}, which ` +
            `${body.connector} needs.`,
        );
      }

      let token: string;
      try {
        token = openToken(
          integration.configEnc,
          typeof config.keyVersion === 'number' ? config.keyVersion : 1,
          project.orgId,
          integration.id,
        );
      } catch {
        // Never echo the failure: the message can carry key material. The
        // remedy is re-entering the credential, and that is what is said.
        throw unprocessable(
          `The credential on integration ${body.integrationId} could not be opened. Re-enter it.`,
        );
      }

      let read: ConnectorRead;
      try {
        read = await (shape.read as NonNullable<ConnectorShape['read']>)({
          http: io.http,
          config,
          token,
        });
      } catch (err) {
        if (err instanceof IssueFilingError) throw badRequest(err.message);
        throw err;
      }
      candidates = read.rows;
      problems.absorb(read.problems);
      offered = read.offered;
      criteriaDroppedByCap = read.criteriaDroppedByCap;
      connectorPages = read.pagesFetched;
      connectorMore = read.moreAvailable;
      estimatedCriteria = read.rows.filter((entry) =>
        entry.criteria.some(
          (criterion) => !STRUCTURED_CRITERION_FORMATS.includes(criterion.format),
        ),
      ).length;
      if (read.moreAvailable) {
        capsThatBit.push({
          cap: 'connectorPages',
          limit: CAPS.connectorPages,
          // A FLOOR and not an estimate: the provider said another page exists,
          // so at least one more row does. Guessing how many would be inventing
          // a number in the alarming direction, which is the same sin as
          // inventing one in the flattering direction.
          droppedAtLeast: 1,
        });
      }
    }

    let notStoredByCap = 0;
    if (candidates.length > CAPS.importBatch) {
      notStoredByCap = candidates.length - CAPS.importBatch;
      capsThatBit.push({
        cap: 'importBatch',
        limit: CAPS.importBatch,
        droppedAtLeast: notStoredByCap,
      });
      candidates = candidates.slice(0, CAPS.importBatch);
    }

    /*
     * Two rows with the same (sourceSystem, externalId) in one import. The
     * second would overwrite the first inside the same transaction with no
     * record that the source said it twice, so it is counted and dropped.
     */
    const seen = new Set<string>();
    const rows: RequirementInput[] = [];
    let duplicates = 0;
    for (const candidate of candidates) {
      const identity = `${candidate.sourceSystem}\u001f${candidate.externalId}`;
      if (seen.has(identity)) {
        duplicates += 1;
        continue;
      }
      seen.add(identity);
      rows.push(candidate);
    }

    const now = new Date();
    const changes: ImportChange[] = [];
    const counts = { NEW: 0, UNCHANGED: 0, CHANGED: 0, NOT_COMPARABLE: 0 };
    let criteriaStored = 0;
    let criteriaMoved = 0;
    let criteriaRetired = 0;

    if (!body.dryRun) {
      for (const row of rows) {
        /*
         * One transaction per requirement, not one for the whole import.
         *
         * A requirement and its criteria must land together — a requirement
         * with half its criteria is a denominator that is wrong in a way nobody
         * can see — but wrapping a thousand of them in one transaction holds a
         * write lock on four tables for the length of a sheet import, and a
         * failure on row 900 would throw away 899 correct imports whose source
         * rows are perfectly good.
         */
        const change = await prisma.$transaction((tx) =>
          persistRequirement(tx, { orgId: project.orgId, projectId: project.id, row, now }),
        );
        counts[change.change as keyof typeof counts] += 1;
        criteriaStored += change.criteria.stored;
        criteriaMoved += change.criteria.moved;
        criteriaRetired += change.criteria.retired;
        if (changes.length < CAPS.changesListed) changes.push(change);
      }
    } else {
      for (const row of rows) criteriaStored += row.criteria.length;
    }

    if (changes.length < rows.length && !body.dryRun) {
      capsThatBit.push({
        cap: 'changesListed',
        limit: CAPS.changesListed,
        droppedAtLeast: rows.length - changes.length,
      });
    }
    /*
     * The per-requirement criteria cap, which used to slice in silence inside
     * `extractCriteria`. An acceptance criterion is a denominator row, so a
     * requirement whose 600 criteria were stored as 500 made the spec-side
     * number smaller with nothing tested — the flattering direction.
     *
     * INLINE imports cannot reach it: `acceptanceCriterionSchema` allows 500
     * and a longer array is a 400 above, so this only ever bites on a parsed
     * or fetched body.
     */
    if (criteriaDroppedByCap > 0) {
      capsThatBit.push({
        cap: 'criteriaPerRequirement',
        limit: CAPS.criteriaPerRequirement,
        droppedAtLeast: criteriaDroppedByCap,
      });
    }
    /*
     * The echo list's own cap, which used to bite in silence — and worse than
     * silence, because `totals.rejected` WAS this list's length, so the cap did
     * not hide the rejections, it became the count of them.
     */
    if (problems.total > problems.lines.length) {
      capsThatBit.push({
        cap: 'problemsListed',
        limit: CAPS.problemsListed,
        droppedAtLeast: problems.total - problems.lines.length,
      });
    }

    // Counts only. No requirement text reaches the audit log: a specification
    // is the customer's confidential material and the same rule
    // routes/traffic.ts follows for an upload applies here.
    await audit({
      actor,
      action: 'requirements.import',
      targetType: 'Project',
      targetId: project.id,
      metadata: {
        source: sourceLabel,
        offered,
        stored: body.dryRun ? 0 : rows.length,
        duplicates,
        rejected: problems.rejected,
        problems: problems.total,
        dryRun: body.dryRun,
        capsThatBit,
      },
    });

    res.status(body.dryRun ? 200 : 201).json({
      projectId: project.id,
      applied: !body.dryRun,
      source: sourceLabel,
      totals: {
        /**
         * Everything the source offered, before any cap, dedupe or rejection.
         *
         * It used to be `candidates.length + duplicates` — computed AFTER the
         * batch cap sliced the list and with the rejected rows already gone —
         * so a CSV offering 300 rows of which 150 had no id reported 150
         * offered, and an import of 1,500 rows reported 1,000. The four
         * dispositions below are exhaustive and add up to this number, which
         * is a property a reader can check rather than a set of figures that
         * each sound plausible alone.
         */
        offered,
        accepted: rows.length,
        duplicates,
        /**
         * Rows the source offered that were NOT STORED.
         *
         * Counted, never derived from `problems`: that list is capped at
         * `problemsLimit`, so an import that dropped 300 malformed rows used to
         * report 50 rejected — and it also carried notes about rows that
         * imported perfectly well, so a clean Markdown import whose headings
         * had no tracker ids reported one of its two requirements rejected.
         */
        rejected: problems.rejected,
        /** Rows the batch cap left unstored. The fourth disposition. */
        notStoredByCap,
        /** Problems recorded, whether or not `problems` below could echo them. */
        problemsRecorded: problems.total,
        ...counts,
        criteriaStored,
        criteriaMoved,
        criteriaRetired,
        /**
         * How many requirements had at least one criterion from the
         * UNSTRUCTURED fallback. An ESTIMATE flag and not a footnote: a
         * criterion count arrived at by splitting sentences must not be printed
         * beside exact ones without saying which it is.
         */
        requirementsWithEstimatedCriteria: estimatedCriteria,
        /**
         * Acceptance criteria the per-requirement cap dropped. A criterion is a
         * denominator row, so this is surface that exists and is not counted —
         * disclosed here and in `capsThatBit` rather than sliced away.
         */
        criteriaDroppedByCap,
        /**
         * Rows whose id we derived from a heading. Disclosed because editing
         * that heading changes the id and orphans every link asserted against
         * it.
         */
        idsSynthesised,
      },
      changes,
      changesLimit: CAPS.changesListed,
      problems: problems.lines,
      problemsLimit: CAPS.problemsListed,
      /** True when the echo list above is shorter than what was recorded. */
      problemsTruncated: problems.total > problems.lines.length,
      connector:
        connectorPages === null
          ? null
          : {
              pagesFetched: connectorPages,
              pageSize: CAPS.connectorPageSize,
              pageLimit: CAPS.connectorPages,
              /** True when the provider said another page exists and we stopped. */
              moreAvailable: connectorMore,
            },
      caps: CAPS,
      capsThatBit,
      capRule: describeCaps(capsThatBit),
      /**
       * Stated on every import, because the number a reader is about to compute
       * from `linkState` depends on it: importing a requirement does not look
       * for a test. Every new row is NOT_SEARCHED, which is our silence and not
       * a finding about the customer's suite.
       */
      linkStateNote:
        'importing does not search for links. New rows are NOT_SEARCHED — our silence — and ' +
        'only a linker moves them to NOT_LINKED, which is the finding.',
    });
  },
);

// ─── GET /requirements/:projectId ───────────────────────────────────────────

const readQuery = z.object({
  limit: z.coerce.number().int().min(1).max(CAPS.pageMax).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** Comma-separated RequirementLinkState values. `NOT_LINKED` is the report. */
  linkState: z.string().optional(),
  /** Comma-separated RequirementStatus values. */
  status: z.string().optional(),
  /** Comma-separated SpecSourceSystem values. */
  sourceSystem: z.string().optional(),
  /**
   * `z.enum` and not `z.coerce.boolean()`: coercion reads the string "false" as
   * `true`, so `?retired=false` would include exactly what it asked to exclude.
   */
  retired: z.enum(['EXCLUDE', 'INCLUDE', 'ONLY']).optional(),
  /** Drop OBSOLETE rows, which `requirementCounts` holds out of the denominator. */
  countingOnly: z.enum(['true', 'false']).optional(),
});

/** The stored-row shape both reads below select. */
const REQUIREMENT_SELECT = {
  id: true,
  externalId: true,
  sourceSystem: true,
  title: true,
  status: true,
  statusRaw: true,
  url: true,
  contentHash: true,
  contentChangedAt: true,
  linkState: true,
  linkedAt: true,
  firstImportedAt: true,
  lastImportedAt: true,
  retiredAt: true,
} as const;

function requirementView(row: {
  id: string;
  externalId: string;
  sourceSystem: SpecSourceSystem;
  title: string;
  status: RequirementStatus;
  statusRaw: string | null;
  url: string | null;
  contentHash: string;
  contentChangedAt: Date | null;
  linkState: RequirementLinkState;
  linkedAt: Date | null;
  firstImportedAt: Date;
  lastImportedAt: Date;
  retiredAt: Date | null;
}) {
  return {
    id: row.id,
    externalId: row.externalId,
    sourceSystem: row.sourceSystem,
    title: row.title,
    status: row.status,
    /** The source system's own word. Required in spirit when status is UNMAPPED. */
    statusRaw: row.statusRaw,
    url: row.url,
    /** `requirementTestability` and never a second derivation of the same thing. */
    testability: requirementTestability(row.status),
    /** Whether this row is in the coverage denominator at all. */
    counts: requirementCounts(row.status),
    linkState: row.linkState,
    linkedAtIso: row.linkedAt ? row.linkedAt.toISOString() : null,
    contentHash: row.contentHash,
    contentChangedAtIso: row.contentChangedAt ? row.contentChangedAt.toISOString() : null,
    firstImportedAtIso: row.firstImportedAt.toISOString(),
    lastImportedAtIso: row.lastImportedAt.toISOString(),
    retiredAtIso: row.retiredAt ? row.retiredAt.toISOString() : null,
  };
}

requirementsRouter.get(
  '/requirements/:projectId',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = readQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
    const query = parsed.data;

    const project = await projectOr404(String(req.params.projectId));
    const linkStates = parseList<RequirementLinkState>(
      query.linkState,
      REQUIREMENT_LINK_STATES,
      'linkState',
    );
    const statuses = parseList<RequirementStatus>(query.status, REQUIREMENT_STATUSES, 'status');
    const systems = parseList<SpecSourceSystem>(
      query.sourceSystem,
      SPEC_SOURCE_SYSTEMS,
      'sourceSystem',
    );

    const retired = query.retired ?? 'EXCLUDE';
    const where: Prisma.RequirementWhereInput = { projectId: project.id };
    if (retired === 'EXCLUDE') where.retiredAt = null;
    if (retired === 'ONLY') where.retiredAt = { not: null };
    if (linkStates) where.linkState = { in: linkStates };
    if (statuses) where.status = { in: statuses };
    if (systems) where.sourceSystem = { in: systems };
    if (query.countingOnly === 'true') {
      /*
       * Driven by `requirementCounts` rather than by a literal `'OBSOLETE'`, so
       * the documented lever governs this filter too. The alternative is this
       * codebase's signature defect: the constant and the thing it claims to
       * govern in different files, so "stop excluding X" edits the constant,
       * passes the tests and ships no change.
       */
      where.status = {
        in: REQUIREMENT_STATUSES.filter((status) => requirementCounts(status)),
      };
    }

    const limit = query.limit ?? CAPS.pageDefault;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      prisma.requirement.findMany({
        where,
        orderBy: [{ sourceSystem: 'asc' }, { externalId: 'asc' }],
        skip: offset,
        take: limit,
        select: REQUIREMENT_SELECT,
      }),
      prisma.requirement.count({ where }),
    ]);

    /*
     * ── THE COUNT THAT KEEPS THE REPORT HONEST ──────────────────────────────
     *
     * Every link state, over the project, regardless of the filter above. A
     * customer who reads "12 NOT_LINKED" without seeing "840 NOT_SEARCHED" has
     * been told that 12 requirements lack tests when the truth is that 840 were
     * never looked at. The two numbers belong in the same response, and the
     * second one is OUR silence rather than their gap.
     */
    const byLinkState = await Promise.all(
      REQUIREMENT_LINK_STATES.map(async (state) => ({
        linkState: state,
        count: await prisma.requirement.count({
          where: { projectId: project.id, retiredAt: null, linkState: state },
        }),
      })),
    );
    const notSearched =
      byLinkState.find((entry) => entry.linkState === 'NOT_SEARCHED')?.count ?? 0;

    res.json({
      projectId: project.id,
      requirements: rows.map(requirementView),
      total,
      offset,
      limit,
      truncated: offset + rows.length < total,
      retired,
      byLinkState,
      linkStateRule:
        `${notSearched} requirement(s) are NOT_SEARCHED: no linker has looked at them, which is ` +
        'our silence and not a finding about the suite. Only NOT_LINKED is a reportable gap.',
      caps: CAPS,
    });
  },
);

// ─── GET /requirements/:projectId/traceability ──────────────────────────────

const traceabilityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(CAPS.pageMax).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** Comma-separated RequirementLinkState values; defaults to every state. */
  linkState: z.string().optional(),
  /** Only links at or above `TRACEABLE_LINK_CONFIDENCE`. */
  traceableOnly: z.enum(['true', 'false']).optional(),
});

requirementsRouter.get(
  '/requirements/:projectId/traceability',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = traceabilityQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
    const query = parsed.data;

    const project = await projectOr404(String(req.params.projectId));
    const linkStates = parseList<RequirementLinkState>(
      query.linkState,
      REQUIREMENT_LINK_STATES,
      'linkState',
    );

    const where: Prisma.RequirementWhereInput = { projectId: project.id, retiredAt: null };
    if (linkStates) where.linkState = { in: linkStates };

    const limit = query.limit ?? CAPS.pageDefault;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      prisma.requirement.findMany({
        where,
        orderBy: [{ sourceSystem: 'asc' }, { externalId: 'asc' }],
        skip: offset,
        take: limit,
        select: {
          ...REQUIREMENT_SELECT,
          criteria: {
            where: { retiredAt: null },
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              ordinal: true,
              text: true,
              format: true,
              linkState: true,
              linkedAt: true,
            },
          },
        },
      }),
      prisma.requirement.count({ where }),
    ]);

    const requirementIds = rows.map((row) => row.id);
    const links =
      requirementIds.length === 0
        ? []
        : await prisma.requirementLink.findMany({
            where: { requirementId: { in: requirementIds } },
            orderBy: { confidence: 'desc' },
            select: {
              id: true,
              requirementId: true,
              criterionId: true,
              testId: true,
              coverageItemId: true,
              method: true,
              confidence: true,
              evidence: true,
              byEmail: true,
              createdAt: true,
            },
          });

    const linksByRequirement = new Map<string, typeof links>();
    for (const link of links) {
      const bucket = linksByRequirement.get(link.requirementId) ?? [];
      bucket.push(link);
      linksByRequirement.set(link.requirementId, bucket);
    }

    let malformedLinks = 0;
    const linkView = (link: (typeof links)[number]) => {
      // `linkTargetOfRow` is the single read path and returns NULL for a row
      // that names both targets or neither. A malformed row is COUNTED and
      // reported rather than silently read as a test link — a row claiming a
      // requirement is covered by nothing must not render as coverage.
      const target = linkTargetOfRow(link);
      if (target === null) malformedLinks += 1;
      return {
        id: link.id,
        criterionId: link.criterionId,
        target,
        method: link.method,
        confidence: link.confidence,
        /** Whether this link may be counted as traceability at all. */
        traceable: link.confidence >= TRACEABLE_LINK_CONFIDENCE,
        /** True only for a link a PERSON asserted. */
        asserted: linkWasAsserted(link.method),
        evidence: link.evidence,
        byEmail: link.byEmail,
        createdAtIso: link.createdAt.toISOString(),
      };
    };

    const matrix = rows.map((row) => {
      const mine = (linksByRequirement.get(row.id) ?? []).map(linkView);
      const shown = mine.filter(
        (link) => query.traceableOnly !== 'true' || link.traceable,
      );
      const page = shown.slice(0, CAPS.linksPerRequirement);
      return {
        ...requirementView(row),
        criteria: row.criteria.map((criterion) => ({
          id: criterion.id,
          ordinal: criterion.ordinal,
          text: criterion.text,
          format: criterion.format,
          /**
           * Per-criterion state, because a requirement can be ASSERTED through
           * one criterion while three others are NOT_LINKED — and a matrix with
           * only requirement-level state reports that as covered.
           */
          linkState: criterion.linkState,
          linkedAtIso: criterion.linkedAt ? criterion.linkedAt.toISOString() : null,
          links: page.filter((link) => link.criterionId === criterion.id),
        })),
        /** Links about the requirement as a whole, rather than one criterion. */
        requirementLevelLinks: page.filter((link) => link.criterionId === null),
        linkTotal: shown.length,
        linkTruncated: shown.length > page.length,
        linkLimit: CAPS.linksPerRequirement,
      };
    });

    res.json({
      projectId: project.id,
      requirements: matrix,
      total,
      offset,
      limit,
      truncated: offset + rows.length < total,
      traceableConfidence: TRACEABLE_LINK_CONFIDENCE,
      /**
       * Rows that name both targets or neither. Reported rather than dropped:
       * they are evidence about OUR linker, and a malformed link quietly
       * skipped is a requirement that looks covered or uncovered for a reason
       * nobody can find.
       */
      malformedLinks,
      caps: CAPS,
    });
  },
);

// ─── POST /requirements/:projectId/links ────────────────────────────────────

const linkBody = requirementLinkSchema.extend({
  /** Which requirement, by the identity the source system gave it. */
  externalId: z.string().trim().min(1).max(200),
  sourceSystem: z.enum(SPEC_SOURCE_SYSTEMS),
});

requirementsRouter.post(
  '/requirements/:projectId/links',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsed = linkBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body', {
        fieldErrors: parsed.error.flatten().fieldErrors,
      });
    }
    const input = parsed.data;
    const project = await projectOr404(String(req.params.projectId));
    const actor = actorOf(req);

    const requirement = await prisma.requirement.findUnique({
      where: {
        projectId_sourceSystem_externalId: {
          projectId: project.id,
          sourceSystem: input.sourceSystem,
          externalId: input.externalId,
        },
      },
      select: { id: true, retiredAt: true },
    });
    if (!requirement) throw notFound('Requirement');

    let criterionId: string | null = null;
    if (input.criterionOrdinal !== null) {
      const criterion = await prisma.acceptanceCriterion.findUnique({
        where: {
          requirementId_ordinal: {
            requirementId: requirement.id,
            ordinal: input.criterionOrdinal,
          },
        },
        select: { id: true, retiredAt: true },
      });
      // Linking to a criterion that is not there would answer "which criterion
      // has no test?" with a link nobody could check.
      if (!criterion) throw notFound('Acceptance criterion');
      if (criterion.retiredAt !== null) {
        throw badRequest(
          'That criterion is retired: the source stopped stating it, so a new link to it ' +
            'would claim coverage of something no specification asks for.',
        );
      }
      criterionId = criterion.id;
    }

    let testId: string | null = null;
    let coverageItemId: string | null = null;
    if (input.target.target === 'TEST') {
      const test = await prisma.test.findUnique({
        where: { id: input.target.testId },
        select: { id: true, projectId: true },
      });
      if (!test || test.projectId !== project.id) throw notFound('Test');
      testId = test.id;
    } else {
      const item = await prisma.coverageItem.findUnique({
        where: { id: input.target.coverageItemId },
        select: { id: true, projectId: true },
      });
      /*
       * A key with no row is a DANGLING REFERENCE in our own extractor, exactly
       * like `dimensionDenominator`'s `undeclaredValues`. Refused and named,
       * never dropped: a requirement linked to a surface we failed to enumerate
       * is evidence about US, and silently discarding the link would hide it.
       */
      if (!item || item.projectId !== project.id) {
        throw notFound('Coverage item — the surface registry has no row with that id');
      }
      coverageItemId = item.id;
    }

    // Reported, never applied in silence: a regex claiming 0.99 would make a
    // requirement read as traced by a guess, and the clamp's own sentence goes
    // into the link's evidence so the cap is auditable on the row itself.
    const clamped = clampLinkConfidence(input.method, input.confidence);
    const evidence = clamped.rule
      ? `${input.evidence} — ${clamped.rule}`.slice(0, 1_000)
      : input.evidence;

    const owner = linkWasAsserted(input.method)
      ? await prisma.user.findUnique({
          where: { id: actor.userId },
          select: { email: true },
        })
      : null;

    /*
     * ── WHY THIS IS findFirst-THEN-WRITE AND NOT upsert ─────────────────────
     *
     * `@@unique([requirementId, criterionId, testId, coverageItemId, method])`
     * does not do what the schema's note hopes for, on PostgreSQL: NULLs
     * compare as distinct in a unique index, so two identical MANUAL links to a
     * test (criterionId and coverageItemId both NULL) are both accepted. Prisma
     * also types the compound selector as five non-null strings, so `upsert`
     * cannot address such a row at all. The duplicate is therefore prevented
     * here, and the schema fix is named in this round's handover.
     */
    const existing = await prisma.requirementLink.findFirst({
      where: {
        requirementId: requirement.id,
        criterionId,
        testId,
        coverageItemId,
        method: input.method,
      },
      select: { id: true },
    });

    const link = existing
      ? await prisma.requirementLink.update({
          where: { id: existing.id },
          data: { confidence: clamped.confidence, evidence },
          select: { id: true, createdAt: true },
        })
      : await prisma.requirementLink.create({
          data: {
            orgId: project.orgId,
            projectId: project.id,
            requirementId: requirement.id,
            criterionId,
            testId,
            coverageItemId,
            method: input.method,
            confidence: clamped.confidence,
            evidence,
            byUserId: linkWasAsserted(input.method) ? actor.userId : null,
            byEmail: owner?.email ?? null,
          },
          select: { id: true, createdAt: true },
        });

    /*
     * `linkState` is stored so it can be indexed, which means it can disagree
     * with the rows it summarises. `linkStateFrom` is the only derivation, and
     * `searched: true` is passed because this request IS the search — zero links
     * means NOT_LINKED only if something looked.
     */
    const now = new Date();
    const requirementMethods = await prisma.requirementLink.findMany({
      where: { requirementId: requirement.id },
      select: { method: true },
    });
    await prisma.requirement.update({
      where: { id: requirement.id },
      data: {
        linkState: linkStateFrom(
          true,
          requirementMethods.map((row) => row.method),
        ),
        linkedAt: now,
      },
      select: { id: true },
    });

    let criterionState: RequirementLinkState | null = null;
    if (criterionId) {
      const criterionMethods = await prisma.requirementLink.findMany({
        where: { criterionId },
        select: { method: true },
      });
      criterionState = linkStateFrom(
        true,
        criterionMethods.map((row) => row.method),
      );
      await prisma.acceptanceCriterion.update({
        where: { id: criterionId },
        data: { linkState: criterionState, linkedAt: now },
        select: { id: true },
      });
    }

    await audit({
      actor,
      action: 'requirements.link',
      targetType: 'Requirement',
      targetId: requirement.id,
      metadata: {
        linkId: link.id,
        method: input.method,
        confidence: clamped.confidence,
        clamped: clamped.clamped,
        target: input.target.target,
        criterionOrdinal: input.criterionOrdinal,
      },
    });

    res.status(existing ? 200 : 201).json({
      linkId: link.id,
      requirementId: requirement.id,
      criterionId,
      method: input.method,
      confidence: clamped.confidence,
      /** True when the method's ceiling bit. The rule is on the row's evidence. */
      clamped: clamped.clamped,
      clampRule: clamped.rule,
      traceable: clamped.confidence >= TRACEABLE_LINK_CONFIDENCE,
      requirementLinkState: linkStateFrom(
        true,
        requirementMethods.map((row) => row.method),
      ),
      criterionLinkState: criterionState,
      createdAtIso: link.createdAt.toISOString(),
    });
  },
);

// ─── GET /requirements/:projectId/connectors ────────────────────────────────

requirementsRouter.get(
  '/requirements/:projectId/connectors',
  requireScope('tests:read'),
  async (req, res) => {
    const project = await projectOr404(String(req.params.projectId));

    /*
     * The integrations that could hold a credential for these connectors.
     * Listed so the response can say NOT_CONFIGURED — "we support Jira and you
     * have not connected one" — separately from NO_READER, which is our gap.
     */
    const integrations = await prisma.integration.findMany({
      where: { kind: { in: ['JIRA', 'LINEAR', 'GITHUB'] } },
      select: { id: true, kind: true, name: true, enabled: true, configEnc: true },
    });

    res.json({
      projectId: project.id,
      connectors: SPEC_CONNECTORS.map((connector) => {
        const shape = SPEC_CONNECTOR_SHAPES[connector];
        const structural = unavailableReason(connector);
        const usable = integrations.filter(
          (integration) =>
            integration.kind === shape.integrationKind &&
            integration.enabled &&
            integration.configEnc !== null,
        );
        const reason = structural ?? (usable.length === 0 ? 'NOT_CONFIGURED' : null);
        return {
          connector,
          available: reason === null,
          /** Null when available. Never omitted when not — see the enum's note. */
          unavailableReason: reason,
          unavailableDetail: reason === null ? null : CONNECTOR_UNAVAILABLE_LABELS[reason],
          sourceSystem: shape.sourceSystem,
          integrationKind: shape.integrationKind,
          requiredConfig: shape.requiredConfig,
          /** True when a document body, rather than a ticket, is the source. */
          bodyIsTheSource: shape.bodyIsTheSource,
          integrations: usable.map((integration) => ({
            id: integration.id,
            name: integration.name,
          })),
        };
      }),
      /** The formats that need no credential at all, and always work. */
      credentialFreeSources: ['INLINE', 'CSV', 'MARKDOWN'],
      criterionFormats: ACCEPTANCE_CRITERION_FORMATS,
      linkMethods: REQUIREMENT_LINK_METHODS,
      caps: CAPS,
    });
  },
);
