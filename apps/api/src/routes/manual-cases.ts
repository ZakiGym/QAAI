/**
 * The manual-suite door: the largest existing statement of "what must be
 * tested", and the one QAAI could not read at all.
 *
 *   POST /manual-cases/:projectId               ingest a suite; diff it; persist
 *   GET  /manual-cases/:projectId               the inventory, paged and filtered
 *   GET  /manual-cases/:projectId/backlog       THE number: the automation backlog
 *   POST /manual-cases/:projectId/automated-by  record that a test replaced a case
 *
 * Five readers for five suites (TestRail, Xray, Zephyr, qTest, a CSV export)
 * are written and tested in packages/agent/src/importer.ts, and until this file
 * their output went nowhere: `ManualTestCase` had no writer and no reader
 * anywhere in the repo, which `scripts/check-wiring.ts` reported as a schema
 * entry for a feature that does not exist. Nothing here re-implements a reader.
 *
 * ── WHY A RE-IMPORT RETIRES AND NEVER DELETES ───────────────────────────────
 *
 * A case absent from a re-import is marked `retiredAt` and KEPT IN THE
 * DENOMINATOR. The argument is arithmetic and it is the whole reason this door
 * is careful: a suite uploaded against the wrong project, a CSV truncated by a
 * spreadsheet tool, or an API page that 500'd all declare fewer cases than the
 * real suite, and deleting the difference would make the automation percentage
 * go UP on the strength of a bad import.
 *
 * ── AND WHY A PARTIAL IMPORT RETIRES NOTHING AT ALL ─────────────────────────
 *
 * The same argument one step further, and it is the defect this file guards
 * hardest. "Absent from the import" and "absent from the suite" are the same
 * sentence only when the import was COMPLETE. If the page budget bit, if a page
 * failed to load, if the case cap bit, or if the suite claims more cases than
 * arrived, then the cases we did not read are indistinguishable from the cases
 * that are gone — so NOTHING is retired, the set that would have been retired
 * is reported with its count and its reason, and `retiredWithheld` says so out
 * loud. Retiring on a partial read is how a timed-out fourth page becomes 400
 * retired cases and a flattering number nobody can trace.
 *
 * ── THE STEPS COLUMN, AND THE COLUMN THIS SCHEMA IS MISSING ─────────────────
 *
 * `ManualStepsState` has four members and three of them produce an empty step
 * array for three different reasons: the suite gave one prose blob (we could
 * not COUNT the steps), the suite's steps field is there and empty (zero is
 * true), or the payload has no steps field at all (our silence). `steps` is the
 * only column there is to put that in, so a case WITH step rows stores the
 * documented shape — `[{ ordinal, action, expected }]`, a bare array — and a
 * case with none stores `{ stepsState, rows: [], prose }` instead of a bare
 * `[]` that would read as "this case has no steps". Same device, and same
 * reason, as the absence mark `routes/api-surface.ts` writes into `evidence`:
 * the clean fix is a `stepsState` column, and it is named in this round's
 * handover rather than faked with a number. `stepCount` on the read is NULL for
 * every state but ROWS and DECLARED_EMPTY, because unknown is not zero.
 *
 * ── THIS ROUTER HOLDS NO CREDENTIAL, EVER ───────────────────────────────────
 *
 * `ManualSuiteTransport` carries its own base URL and its own credential, and
 * it reaches this file only through {@link configureManualCasesIo}. Nothing
 * below accepts, stores, forwards or logs a token, and the request this router
 * hands the transport carries a vendor path and query parameters and nothing
 * else. The one place a credential can still leak is a transport's own ERROR
 * MESSAGE — `importManualSuite` puts `err.message` into a gap, and a client
 * that threw `request to https://suite/?api_key=… failed` would put the key in
 * this endpoint's response. Every gap and caveat therefore goes through
 * {@link scrub} before it reaches a response, an audit row or an error.
 */

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MANUAL_TEST_AUTOMATION_LABELS,
  MANUAL_TEST_AUTOMATION_STATUSES,
  SPEC_SOURCE_SYSTEMS,
  manualBacklogTotals,
  manualTestCaseSchema,
} from '@qaai/shared';
import type { ManualTestAutomationStatus, ManualTestCaseInput, SpecSourceSystem } from '@qaai/shared';
import {
  MANUAL_STEPS_STATES,
  MANUAL_STEPS_STATE_LABELS,
  MANUAL_SUITE_AS_SPEC_SOURCE,
  MANUAL_SUITE_SOURCES,
  holdsManualSuite,
  importManualSuite,
  manualCaseContentHash,
  readCsvCases,
  readQTestCases,
  readTestRailCases,
  readXrayTests,
  readZephyrTests,
} from '@qaai/agent';
import type {
  ImportedManualCase,
  ManualImportReport,
  ManualReaderOptions,
  ManualStepsState,
  ManualSuiteSource,
  ManualSuiteTransport,
} from '@qaai/agent';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound, notImplemented } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';

export const manualCasesRouter: Router = Router();

manualCasesRouter.use(requireAuth);

// ─── The injected I/O ────────────────────────────────────────────────────────

interface ManualCasesIo {
  /**
   * The transport an API-backed suite is read through, or null when none is
   * wired.
   *
   * Injected and never constructed here, for two reasons. Rule 8: a reader that
   * reaches for `fetch` at module scope cannot be tested without a server.
   * And the credential: the transport holds its own base URL and its own
   * token, so this router never accepts one in a body, never stores one, and
   * cannot leak one it does not have. `IntegrationKind` has no TESTRAIL, XRAY,
   * ZEPHYR or QTEST member in this install, so there is also no row a
   * customer's suite credential could live on yet — which is why an unwired
   * fetch is a 501 that names both halves rather than an empty success.
   */
  suiteTransport: ManualSuiteTransport | null;
}

let io: ManualCasesIo = { suiteTransport: null };

/**
 * Point this router at its I/O. Returns the previous settings so a caller can
 * restore them, which is what keeps one test from leaking a fake into the next.
 */
export function configureManualCasesIo(next: Partial<ManualCasesIo>): ManualCasesIo {
  const previous = io;
  io = { ...io, ...next };
  return previous;
}

/** The `IntegrationKind` member each API-backed suite would need. None exists. */
const MISSING_CREDENTIAL_HOME: Record<Exclude<ManualSuiteSource, 'CSV'>, string> = {
  TESTRAIL: 'TESTRAIL',
  XRAY: 'XRAY',
  ZEPHYR: 'ZEPHYR',
  QTEST: 'QTEST',
};

// ─── Caps, every one of which is reported ───────────────────────────────────

/**
 * The caps this router applies.
 *
 * Collected in one record because every one of them, if it bites unreported,
 * moves the automation number in the flattering direction: fewer cases stored
 * is a smaller backlog over the same automated count. The response carries the
 * whole table — not only the entries that bit — so a reader can see the limit
 * that did NOT bite and know the number is whole.
 */
const CAPS = {
  /** Bytes of CSV accepted. Refused past this, never truncated. */
  csvBytes: 8_000_000,
  /** Cases persisted from one import. Past this the rest are counted, not stored. */
  cases: 20_000,
  /** Gaps echoed back, so a payload our readers choked on is debuggable. */
  gapsListed: 50,
  /** Per-case dispositions named in one response. */
  changesListed: 500,
  /** Retired (or withheld) cases named in one response. */
  retiredListed: 200,
  /** Pages one fetched import may take, and the cases asked for per page. */
  suitePages: 40,
  suitePageSize: 250,
  /**
   * Rows scanned to answer "what is already stored" and "what is the backlog".
   * A capped scan reports FLOORS and a null ratio, never a partial count in the
   * field a dashboard prints.
   */
  inventoryScan: 50_000,
  /** Default and maximum page size for the inventory read. */
  pageDefault: 100,
  pageMax: 1_000,
} as const;

interface CapHit {
  cap: string;
  limit: number;
  droppedAtLeast: number;
  /**
   * The cap's own sentence, when whoever applied it wrote one.
   *
   * `importManualSuite` computes a far better reason than this file could —
   * it knows the vendor and the claimed total — so its wording is carried
   * through rather than replaced. A cap disclosed as a bare count is half a
   * disclosure: the reader cannot tell what it cost.
   */
  reason?: string;
  /**
   * Whether this cap limited what was READ, or only what is ECHOED BACK.
   *
   * The distinction decides whether absence may be acted on. A cap on the read
   * (the stored scan, the per-import case limit, the page budget) means cases
   * exist that we did not see, so a case missing from this import may simply be
   * one of them and nothing may be retired. A cap on an echo list (the
   * dispositions, the names of the absent) hid nothing from the read, and
   * blocking retirement on one of those would be its own wrong answer: a
   * 600-case import refusing to retire anything because the response could only
   * list 500 dispositions.
   */
  limitsTheRead?: boolean;
}

/**
 * The sentence a reader forwards. Worded once, because the entire value of a
 * disclosed cap is that it reads the same everywhere it appears.
 */
function describeCaps(hits: readonly CapHit[]): string {
  if (hits.length === 0) return 'no cap bit: every case the source offered was accounted for';
  return hits
    .map(
      (hit) =>
        hit.reason ?? `${hit.cap} (limit ${hit.limit}) hid at least ${hit.droppedAtLeast}`,
    )
    .join('; ');
}

/**
 * The gap list, bounded on the way IN and counted whatever the bound did.
 *
 * ── THE DEFECT THIS SHAPE EXISTS TO PREVENT ─────────────────────────────────
 *
 * routes/requirements.ts records it as having shipped once: the reported
 * rejection total WAS the echo list's length, so the cap did not hide the
 * problems — it became the count of them, and an import that dropped 300
 * malformed rows reported 50. `total` is therefore incremented on every call
 * and `lines` stops growing at the limit, so the two numbers are independent
 * and the cap on the list is disclosed as its own bite.
 *
 * Bounded on the way in rather than sliced at serialisation, which also matters
 * at this size: a 20,000-row sheet with a malformed id column would otherwise
 * build a 20,000-entry array in memory for one response that shows 50 of them.
 */
interface GapLog {
  lines: Array<{ externalId: string | null; detail: string }>;
  total: number;
  add(externalId: string | null, detail: string): void;
}

function gapLog(): GapLog {
  const log: GapLog = {
    lines: [],
    total: 0,
    add(externalId, detail) {
      log.total += 1;
      // Scrubbed HERE, once, so no caller can forget: these sentences come
      // from a reader and a transport this router does not own.
      if (log.lines.length < CAPS.gapsListed) {
        log.lines.push({ externalId, detail: scrub(detail) });
      }
    },
  };
  return log;
}

// ─── Redaction ───────────────────────────────────────────────────────────────

/**
 * Credential-shaped parameter names, as the four vendors spell them.
 *
 * TestRail authenticates with `?api_key=`, Zephyr and Xray with a bearer token,
 * qTest with `?access_token=`. A transport that throws with the request URL in
 * the message — which every HTTP client does — therefore puts a live
 * credential into `err.message`, `importManualSuite` copies it verbatim into a
 * gap, and this endpoint would hand it back in a 201 body and write it to the
 * audit log. That is the one way a router holding no credential can still
 * publish one, so the scrub is applied to every string that comes back from a
 * transport or a reader, without exception.
 */
const CREDENTIAL_PARAM =
  /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth|authorization|password|passwd|pwd|secret|session|signature|sig|jwt|private[_-]?token)\b\s*[:=]\s*("?)([^\s&"'<>,;)]+)\2/gi;
const CREDENTIAL_SCHEME = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const CREDENTIAL_IN_URL = /\/\/[^/\s:@]+:[^/\s@]+@/g;

/**
 * Remove anything credential-shaped from text we did not write.
 *
 * Deliberately a blunt instrument. It redacts by PATTERN and not by value,
 * because this router never holds the credential and so cannot match on it —
 * and a redactor that needed the secret in order to hide it would be a reason
 * to accept the secret here, which is the thing being avoided. Over-redacting
 * a gap sentence costs a reader some detail; under-redacting it publishes a
 * customer's API key.
 */
function scrub(text: string): string {
  return text
    .replace(CREDENTIAL_IN_URL, '//[redacted]@')
    .replace(CREDENTIAL_SCHEME, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(CREDENTIAL_PARAM, (_match, name: string) => `${name}=[redacted]`);
}

// ─── The steps column ────────────────────────────────────────────────────────

/**
 * What one row's `steps` column holds, normalised.
 *
 * `state: null` is a row nothing has stated a state for — the column DEFAULT
 * `"[]"`, or a row written by some future writer that stored a bare empty
 * array. It is NOT `DECLARED_EMPTY`: "the suite has a steps field and it is
 * empty" is a fact about the customer's suite, and reading our own default as
 * that fact is exactly the silence-read-as-an-answer defect.
 */
interface StoredSteps {
  state: ManualStepsState | null;
  rows: Array<{ ordinal: number; action: string; expected: string | null }>;
  prose: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stepRow(
  value: unknown,
): { ordinal: number; action: string; expected: string | null } | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.ordinal !== 'number' || typeof value.action !== 'string') return null;
  return {
    ordinal: value.ordinal,
    action: value.action,
    expected: typeof value.expected === 'string' ? value.expected : null,
  };
}

/**
 * The value written to `steps`.
 *
 * ROWS stores the bare array the schema's doc comment describes, so a reader
 * following that comment finds exactly `[{ ordinal, action, expected }]`
 * whenever there are steps. The other three states have no step rows to store
 * and store the state instead — see the header note on the missing column.
 */
function stepsColumnValue(imported: ImportedManualCase): Prisma.InputJsonValue {
  if (imported.steps === 'ROWS') return imported.case.steps as Prisma.InputJsonValue;
  return {
    stepsState: imported.steps,
    rows: [],
    prose: imported.stepProse,
  } as Prisma.InputJsonValue;
}

function readStepsColumn(raw: unknown): StoredSteps {
  if (Array.isArray(raw)) {
    const rows = raw.map(stepRow).filter((row): row is NonNullable<typeof row> => row !== null);
    return rows.length > 0
      ? { state: 'ROWS', rows, prose: null }
      : { state: null, rows: [], prose: null };
  }
  if (isPlainRecord(raw)) {
    const state = raw.stepsState;
    if (
      typeof state === 'string' &&
      (MANUAL_STEPS_STATES as readonly string[]).includes(state)
    ) {
      return {
        state: state as ManualStepsState,
        rows: [],
        prose: typeof raw.prose === 'string' ? raw.prose : null,
      };
    }
  }
  return { state: null, rows: [], prose: null };
}

/**
 * How many steps this case has, or null when that is unknown.
 *
 * DECLARED_EMPTY is the one state where 0 is a measurement. PROSE_NOT_SPLIT and
 * NO_FIELD both produce no rows and mean "not counted" and "not read", and
 * printing 0 for either would make a conversion that read nothing look
 * complete.
 */
function stepCountOf(steps: StoredSteps): number | null {
  if (steps.state === 'ROWS') return steps.rows.length;
  if (steps.state === 'DECLARED_EMPTY') return 0;
  return null;
}

function sameSteps(left: StoredSteps, right: StoredSteps): boolean {
  if (left.state !== right.state || left.prose !== right.prose) return false;
  if (left.rows.length !== right.rows.length) return false;
  return left.rows.every((row, index) => {
    const other = right.rows[index];
    return (
      other !== undefined &&
      row.ordinal === other.ordinal &&
      row.action === other.action &&
      row.expected === other.expected
    );
  });
}

// ─── Shared plumbing ─────────────────────────────────────────────────────────

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

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
 * Copied from routes/api-surface.ts rather than imported from it: a router
 * importing another router's internals couples their module load order for a
 * nine-line helper, and lib/ is the right home if a fourth door needs it.
 *
 * An unknown value must never answer with an empty list. `?automationStatus=
 * AUTOMATE` (one word wrong) answering `[]` reads on screen as "this suite has
 * nothing automated", which is a claim about the customer's work made out of
 * their typo.
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

/** `null` is "the suite does not say", and that sentence is printed everywhere. */
const LAST_EXECUTED_NOTE =
  '`lastExecutedAt: null` is "the suite does not say", which is NOT "never run": a case with no ' +
  'execution history and a case whose suite has no such field look identical in an export, and ' +
  'one of them is a finding.';

/** The label the (AUTOMATED, no test) pair carries wherever it is counted. */
const AUTOMATED_WITH_NO_TEST_LABEL = 'marked automated, and the test that automated it is gone';
const AUTOMATED_WITH_NO_TEST_RULE =
  'ManualTestCase.automatedByTestId is onDelete: SetNull, so deleting a generated test leaves ' +
  'the case marked AUTOMATED with no test behind it. That pair is counted here rather than ' +
  'hidden: it is still counted as automated because the suite says so, and this number is how ' +
  'many of those cases nothing can actually execute.';

// ─── POST /manual-cases/:projectId ──────────────────────────────────────────

const importBody = z
  .object({
    /** Which suite this is. Picks the reader; stored verbatim as the provenance. */
    source: z.enum(MANUAL_SUITE_SOURCES),
    /** CSV only: the sheet itself. */
    content: z.string().min(1).optional(),
    /**
     * One already-fetched vendor page, for the four API suites.
     *
     * The lowest-ceremony import of a TestRail suite and the only one that
     * needs no credential anywhere: the four vendor readers are pure mappers,
     * so a page pasted out of a browser's network tab reads exactly as one
     * fetched by a transport. Treated as DATA throughout — a title that reads
     * like an instruction is stored verbatim and acted on by nothing.
     */
    payload: z.unknown().optional(),
    /** Read the suite through the injected transport, page by page. */
    fetch: z.boolean().default(false),
    /** Extra vendor query parameters: a project id, a JQL filter. Never a credential. */
    query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    pageSize: z.coerce.number().int().min(1).max(CAPS.suitePageSize).optional(),
    /**
     * Opt in to splitting a CSV steps cell on newlines.
     *
     * Off by default, and that default is the honest one: some exports put one
     * step per line and some put a paragraph, so splitting by default turns a
     * two-sentence description into two steps — a count wrong in the direction
     * that makes a conversion look complete.
     */
    splitStepsOnNewline: z.boolean().default(false),
    /** Read and diff, write nothing. The response is identical but `applied`. */
    dryRun: z.boolean().default(false),
  })
  .superRefine((body, ctx) => {
    if (body.source === 'CSV') {
      if (body.content === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['content'],
          message: 'A CSV import needs `content`: the exported sheet itself.',
        });
      }
      if (body.fetch || body.payload !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['source'],
          message:
            'A CSV has no API to page through. Send `content` only — `payload` and `fetch` are ' +
            'for TESTRAIL, XRAY, ZEPHYR and QTEST.',
        });
      }
      return;
    }
    if (body.content !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: '`content` is the CSV sheet. Send `payload` (one vendor page) or `fetch: true`.',
      });
    }
    if ((body.payload === undefined) === !body.fetch) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload'],
        message:
          'Send exactly one of `payload` (a page you already have) or `fetch: true` (read the ' +
          'suite through the configured transport).',
      });
    }
  });

/** How the suite reached us. Reported, because it decides what absence means. */
type ImportInput = 'CSV' | 'PAYLOAD' | 'FETCH';

/** What a re-import did to one case. */
type CaseChange = 'NEW' | 'UNCHANGED' | 'CHANGED' | 'NOT_COMPARABLE' | 'NOT_COMPARED';

interface CaseDisposition {
  externalId: string;
  change: CaseChange;
  detail: string;
  stepsState: ManualStepsState;
  /** Field names that differed from the stored row. Empty means nothing was written. */
  wrote: string[];
  /** The case was retired and the suite declares it again. */
  reinstated: boolean;
}

/** The one shape every reader returns, plus the two things only a fetch knows. */
interface SuiteRead extends ManualImportReport {
  pages: number | null;
  caps: CapHit[];
}

/**
 * The stored facts a re-import has to compare against.
 *
 * `select` is explicit and narrow: the hash that decides CHANGED, the fields
 * the hash does NOT cover (`url`, the steps state, the automation status and
 * the execution date), and `retiredAt`, which decides whether a case the suite
 * declares again is being reinstated.
 */
const STORED_SELECT = {
  id: true,
  externalId: true,
  title: true,
  steps: true,
  expectedResult: true,
  url: true,
  automationStatus: true,
  lastExecutedAt: true,
  contentHash: true,
  retiredAt: true,
} as const;

manualCasesRouter.post(
  '/manual-cases/:projectId',
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

    const source = body.source;
    const sourceSystem: SpecSourceSystem = MANUAL_SUITE_AS_SPEC_SOURCE[source];
    const input: ImportInput =
      source === 'CSV' ? 'CSV' : body.fetch ? 'FETCH' : 'PAYLOAD';
    /*
     * The four API-backed suites as their own type, narrowed ONCE here.
     * `input === 'FETCH'` does not narrow `source` for the compiler, and the
     * alternative is a cast at each of the three places that need it — which is
     * how a fifth source added to `MANUAL_SUITE_SOURCES` would compile against
     * a reader table that has no entry for it.
     */
    const apiSource: Exclude<ManualSuiteSource, 'CSV'> | null =
      source === 'CSV' ? null : source;

    if (input === 'CSV') {
      const bytes = Buffer.byteLength(body.content as string, 'utf8');
      if (bytes > CAPS.csvBytes) {
        // Refused, not truncated. Half a sheet declares fewer cases, and fewer
        // cases is the direction that flatters the automation percentage.
        throw badRequest(
          `That export is ${bytes} bytes and the limit is ${CAPS.csvBytes}. ` +
            'It is refused rather than truncated: a partial sheet declares fewer cases, which ' +
            'would shrink the automation backlog with nothing automated.',
        );
      }
    }

    if (apiSource !== null && input === 'FETCH' && io.suiteTransport === null) {
      /*
       * 501, and it names BOTH halves of the gap. A 200 carrying no cases
       * would say "your suite is empty" — a measured claim about the
       * customer's largest test asset manufactured out of our own missing
       * dependency. The second half matters as much as the first: even with a
       * transport injected there is nowhere for the credential to live, so a
       * caller is told what to fix rather than left to guess.
       */
      throw notImplemented(
        `Reading a ${source} suite over its API — no ManualSuiteTransport is configured on ` +
          '`configureManualCasesIo`, and `IntegrationKind` has no ' +
          `${MISSING_CREDENTIAL_HOME[apiSource]} member for the credential to live on, so ` +
          `nothing was read. Upload one page as \`payload\` instead; the ${source} reader needs ` +
          'no credential at all',
      );
    }

    /*
     * ── WHAT IS ALREADY STORED, BEFORE ANY READING ──────────────────────────
     *
     * Only this (project, sourceSystem): a TestRail import says nothing about
     * a CSV one, and comparing across them would report every case in the
     * other suite as absent.
     *
     * `take` is one past the cap so a truncated scan is DETECTABLE. A truncated
     * scan then disables the whole comparison — `previousHashes: undefined`,
     * which the reader's contract reads as "the caller is not comparing" and
     * answers with `change: null` — because a case whose stored row fell off
     * the end of the scan would classify as NEW, and a NEW classification is
     * what moves `contentChangedAt`.
     */
    const storedRows = await prisma.manualTestCase.findMany({
      where: { projectId: project.id, sourceSystem },
      select: STORED_SELECT,
      take: CAPS.inventoryScan + 1,
    });
    const storedScanTruncated = storedRows.length > CAPS.inventoryScan;
    const stored = storedRows.slice(0, CAPS.inventoryScan);
    const storedByExternalId = new Map(stored.map((row) => [row.externalId, row]));

    const capsThatBit: CapHit[] = [];
    if (storedScanTruncated) {
      capsThatBit.push({
        cap: 'inventoryScan',
        limit: CAPS.inventoryScan,
        droppedAtLeast: 1,
        limitsTheRead: true,
        reason:
          `this project already holds more than ${CAPS.inventoryScan} ${sourceSystem} cases, so ` +
          'the stored set could not be read whole. No case is classified as new, changed or ' +
          'unchanged in this import and nothing is retired: a comparison against a partial ' +
          'stored set would invent edits and retire cases that are still in the suite',
      });
    }

    const options: ManualReaderOptions = storedScanTruncated
      ? { digest: sha256 }
      : {
          digest: sha256,
          previousHashes: new Map(stored.map((row) => [row.externalId, row.contentHash])),
        };

    // ── Read the suite ──────────────────────────────────────────────────────

    let read: SuiteRead;
    if (input === 'CSV') {
      const report = readCsvCases(body.content as string, {
        ...options,
        splitStepsOnNewline: body.splitStepsOnNewline,
      });
      read = { ...report, pages: null, caps: [] };
    } else if (apiSource !== null && input === 'PAYLOAD') {
      /*
       * The vendor mapper, chosen by the source. A `satisfies Record<...>` and
       * not a switch: a sixth member of `MANUAL_SUITE_SOURCES` with no reader
       * fails to compile here, which is the only thing standing between a new
       * source and this endpoint answering 200 with no cases for it.
       */
      const readers = {
        TESTRAIL: readTestRailCases,
        XRAY: readXrayTests,
        ZEPHYR: readZephyrTests,
        QTEST: readQTestCases,
      } as const satisfies Record<
        Exclude<ManualSuiteSource, 'CSV'>,
        (payload: unknown, options: ManualReaderOptions) => ManualImportReport
      >;
      const report = readers[apiSource](body.payload, options);
      read = { ...report, pages: 1, caps: [] };
    } else if (apiSource !== null && io.suiteTransport !== null) {
      const fetched = await importManualSuite({
        transport: io.suiteTransport,
        source: apiSource,
        options,
        pageSize: body.pageSize ?? CAPS.suitePageSize,
        pageBudget: CAPS.suitePages,
        ...(body.query === undefined ? {} : { query: body.query }),
      });
      read = {
        ...fetched,
        pages: fetched.pages,
        /*
         * The importer's own cap ledger, projected onto this response's shape.
         * `discarded` is its LOWER bound on what the cap cost, so it maps onto
         * `droppedAtLeast` unchanged; `bites` (how many times the limit fired)
         * is a different number and is never substituted for it.
         */
        caps: fetched.caps.map((bite) => ({
          cap: bite.cap,
          limit: bite.limit,
          droppedAtLeast: bite.discarded,
          limitsTheRead: true,
          reason: scrub(bite.reason),
        })),
      };
    } else {
      /*
       * Unreachable: the schema's refinements leave exactly three input modes
       * and the 501 above covers the fourth state. It throws rather than
       * falling through to an empty `read`, because an empty read would answer
       * 201 with no cases — "your suite is empty" manufactured out of a
       * combination this router did not expect.
       */
      throw notImplemented(
        `Reading a ${source} suite as ${input} — this combination has no reader, and nothing ` +
          'was read',
      );
    }
    capsThatBit.push(...read.caps);

    /*
     * ── OUR OWN SCHEMA, OVER OUR OWN READERS ────────────────────────────────
     *
     * Validated here even though the readers are ours, for the two reasons
     * routes/api-surface.ts gives: packages/agent is a different package
     * written by different hands and a row that fails the schema would surface
     * as a 500 at the database, and a dropped row is a shrunk denominator — so
     * every rejection is counted and named rather than quietly smaller.
     *
     * The hash is re-derived with `manualCaseContentHash` and compared. If the
     * stored hash described different content from the stored row, the NEXT
     * import would report an edited case as UNCHANGED and drop the customer's
     * change silently, which is the worst outcome this table has.
     */
    const gaps = gapLog();
    for (const gap of read.gaps) gaps.add(gap.externalId, gap.detail);
    const accepted: Array<{ imported: ImportedManualCase; parsed: ManualTestCaseInput }> = [];
    let rejectedHere = 0;
    for (const [index, imported] of read.cases.entries()) {
      const candidate = manualTestCaseSchema.safeParse(imported.case);
      if (!candidate.success) {
        rejectedHere += 1;
        const issue = candidate.error.issues[0];
        gaps.add(
          imported.case.externalId ?? null,
          `cases[${index}] ${(issue?.path ?? []).join('.') || '(root)'}: ` +
            `${issue?.message ?? 'invalid'} — not stored`,
        );
        continue;
      }
      if (manualCaseContentHash(candidate.data, sha256) !== imported.contentHash) {
        rejectedHere += 1;
        gaps.add(
          candidate.data.externalId,
          `cases[${index}]: the reader's content hash does not describe the case it came with, ` +
            'so storing it would make the next import report an edit as UNCHANGED — not stored',
        );
        continue;
      }
      accepted.push({ imported, parsed: candidate.data });
    }

    /*
     * Two rows with the same external id in one payload. The second would
     * overwrite the first through the same unique key with no record that the
     * suite said it twice, so it is counted and dropped.
     */
    const seen = new Set<string>();
    const rows: typeof accepted = [];
    let duplicates = 0;
    for (const entry of accepted) {
      if (seen.has(entry.parsed.externalId)) {
        duplicates += 1;
        continue;
      }
      seen.add(entry.parsed.externalId);
      rows.push(entry);
    }

    let toStore = rows;
    let notStoredByCap = 0;
    if (toStore.length > CAPS.cases) {
      notStoredByCap = toStore.length - CAPS.cases;
      toStore = toStore.slice(0, CAPS.cases);
      capsThatBit.push({
        cap: 'cases',
        limit: CAPS.cases,
        droppedAtLeast: notStoredByCap,
        limitsTheRead: true,
        reason:
          `${notStoredByCap} case(s) past the per-import limit of ${CAPS.cases} were read and ` +
          'NOT stored; they exist in the suite and are not in the backlog number below',
      });
    }

    // ── Persist ─────────────────────────────────────────────────────────────

    const now = new Date();
    const dispositions: CaseDisposition[] = [];
    const counts: Record<CaseChange, number> = {
      NEW: 0,
      UNCHANGED: 0,
      CHANGED: 0,
      NOT_COMPARABLE: 0,
      NOT_COMPARED: 0,
    };
    const stepsByState: Record<ManualStepsState, number> = {
      ROWS: 0,
      PROSE_NOT_SPLIT: 0,
      DECLARED_EMPTY: 0,
      NO_FIELD: 0,
    };
    let writes = 0;
    let reinstated = 0;
    let statusOnlyChanged = 0;

    for (const { imported, parsed } of toStore) {
      stepsByState[imported.steps] += 1;
      const existing = storedByExternalId.get(parsed.externalId);
      /*
       * `imported.change` is null exactly when we supplied no hashes, which is
       * a different fact from NEW — conflating them would report a first import
       * of 1,840 cases as 1,840 edits, and a truncated stored scan as the same.
       */
      const change: CaseChange = imported.change?.kind ?? (existing ? 'NOT_COMPARED' : 'NEW');
      const detail =
        imported.change?.detail ??
        (existing
          ? 'the stored set could not be read whole, so "changed" and "unchanged" are both ' +
            'unprovable for this case'
          : 'no row for this external id exists yet');

      const nextSteps = stepsColumnValue(imported);
      const nextStepsRead = readStepsColumn(nextSteps);

      /*
       * WHICH FIELDS ACTUALLY DIFFER, rather than "the hash changed".
       *
       * The content hash deliberately excludes `automationStatus` and
       * `lastExecutedAt` — being run, or being ticked off as automated, is not
       * an edit to the specification — and it does not cover `url` or the steps
       * STATE either. So an UNCHANGED hash does not mean the row is current: a
       * case the suite marked automated last night hashes identically, and
       * writing nothing would freeze the backlog number this table exists to
       * produce. The hash decides `contentChangedAt`; this list decides whether
       * anything is written at all.
       */
      const differing: string[] = [];
      if (existing) {
        if (existing.title !== parsed.title) differing.push('title');
        if (existing.expectedResult !== parsed.expectedResult) differing.push('expectedResult');
        if (existing.url !== parsed.url) differing.push('url');
        if (!sameSteps(readStepsColumn(existing.steps), nextStepsRead)) differing.push('steps');
        if (existing.automationStatus !== parsed.automationStatus) {
          differing.push('automationStatus');
        }
        const storedExecuted = existing.lastExecutedAt?.getTime() ?? null;
        const nextExecuted = parsed.lastExecutedAt?.getTime() ?? null;
        if (storedExecuted !== nextExecuted) differing.push('lastExecutedAt');
        if (existing.contentHash !== imported.contentHash) differing.push('contentHash');
        if (existing.retiredAt !== null) differing.push('retiredAt');
      }

      const isReinstated = existing?.retiredAt != null;
      counts[change] += 1;
      if (isReinstated) reinstated += 1;
      if (
        existing !== undefined &&
        differing.length > 0 &&
        !differing.some((field) =>
          ['title', 'expectedResult', 'url', 'steps', 'contentHash'].includes(field),
        )
      ) {
        statusOnlyChanged += 1;
      }

      if (dispositions.length < CAPS.changesListed) {
        dispositions.push({
          externalId: parsed.externalId,
          change,
          detail,
          stepsState: imported.steps,
          wrote: differing,
          reinstated: isReinstated,
        });
      }

      // An unchanged re-import writes NOTHING. `lastImportedAt` is `@updatedAt`
      // — a row-write timestamp — so a no-op update purely to move it would
      // churn every case in the suite nightly and turn that column into a false
      // "the specification was touched" signal. See the handover note asking
      // for a `lastSeenAt` column, which is the fact a nightly import does have.
      if (existing !== undefined && differing.length === 0) continue;
      writes += 1;
      if (body.dryRun) continue;

      await prisma.manualTestCase.upsert({
        where: {
          projectId_sourceSystem_externalId: {
            projectId: project.id,
            sourceSystem,
            externalId: parsed.externalId,
          },
        },
        create: {
          orgId: project.orgId,
          projectId: project.id,
          externalId: parsed.externalId,
          sourceSystem,
          title: parsed.title,
          steps: nextSteps,
          expectedResult: parsed.expectedResult,
          url: parsed.url,
          automationStatus: parsed.automationStatus,
          // Null, as the suite reported it. Storing an epoch or the string
          // `never` would be a measured claim we did not make.
          lastExecutedAt: parsed.lastExecutedAt,
          contentHash: imported.contentHash,
        },
        update: {
          title: parsed.title,
          steps: nextSteps,
          expectedResult: parsed.expectedResult,
          url: parsed.url,
          automationStatus: parsed.automationStatus,
          lastExecutedAt: parsed.lastExecutedAt,
          contentHash: imported.contentHash,
          // Only when the content ACTUALLY differed. Stamping it on every
          // import would make "when did this case last change?" answer
          // "whenever a cron last ran", which is not a fact about the case.
          ...(change === 'CHANGED' ? { contentChangedAt: now } : {}),
          // A case the suite returned again is not retired, whatever it was
          // before — a retirement nothing can clear is a false fact for ever.
          ...(isReinstated ? { retiredAt: null } : {}),
        },
        select: { id: true },
      });
    }

    if (dispositions.length < toStore.length) {
      capsThatBit.push({
        cap: 'changesListed',
        limit: CAPS.changesListed,
        droppedAtLeast: toStore.length - dispositions.length,
      });
    }
    if (gaps.total > gaps.lines.length) {
      capsThatBit.push({
        cap: 'gapsListed',
        limit: CAPS.gapsListed,
        droppedAtLeast: gaps.total - gaps.lines.length,
      });
    }

    // ── Absence ─────────────────────────────────────────────────────────────

    /*
     * ── THE GUARD THIS WHOLE FILE IS CAREFUL ABOUT ──────────────────────────
     *
     * "Absent from this import" and "absent from the suite" are the same
     * sentence only when the import was COMPLETE. A spent page budget, a page
     * that 500'd, a case cap, a claimed total larger than what arrived, a
     * truncated stored scan — each means the cases we did not read look exactly
     * like the cases that are gone. Retiring on any of those is how a timed-out
     * page becomes four hundred retired cases and an automation percentage
     * nobody can trace back to a cause.
     */
    const importIsPartial =
      read.truncated || capsThatBit.some((hit) => hit.limitsTheRead === true);
    const importedIds = new Set(toStore.map((entry) => entry.parsed.externalId));
    const absent = stored.filter(
      (row) => row.retiredAt === null && !importedIds.has(row.externalId),
    );
    let retired = 0;
    if (!importIsPartial && !body.dryRun) {
      for (const row of absent) {
        await prisma.manualTestCase.update({
          where: { id: row.id },
          data: { retiredAt: now },
          select: { id: true },
        });
        retired += 1;
      }
    }
    const absentListed = absent.slice(0, CAPS.retiredListed);
    if (absent.length > absentListed.length) {
      capsThatBit.push({
        cap: 'retiredListed',
        limit: CAPS.retiredListed,
        droppedAtLeast: absent.length - absentListed.length,
      });
    }

    const notStated = toStore.filter(
      (entry) => entry.parsed.automationStatus === 'NOT_STATED',
    ).length;

    /*
     * Counts and the source only. No case title, no step text and no payload
     * reaches the audit log: a manual suite is the customer's confidential
     * material, and the same rule routes/traffic.ts and routes/requirements.ts
     * follow for an upload applies here. The gap sentences are scrubbed before
     * they are counted, and only their COUNT is written.
     */
    await audit({
      actor,
      action: 'manualCases.import',
      targetType: 'Project',
      targetId: project.id,
      metadata: {
        source,
        sourceSystem,
        input,
        readByReader: read.cases.length,
        stored: body.dryRun ? 0 : writes,
        rejected: rejectedHere,
        gapsRecorded: gaps.total,
        duplicates,
        retired,
        retiredWithheld: importIsPartial ? absent.length : 0,
        truncated: read.truncated,
        dryRun: body.dryRun,
        capsThatBit,
      },
    });

    res.status(body.dryRun ? 200 : 201).json({
      projectId: project.id,
      applied: !body.dryRun,
      source,
      sourceSystem,
      input,
      totals: {
        /**
         * What the reader produced. The invariants a reader can check:
         * `readByReader === accepted + rejectedHere`,
         * `accepted === stored + duplicates + notStoredByCap`.
         */
        readByReader: read.cases.length,
        accepted: accepted.length,
        rejectedHere,
        duplicates,
        notStoredByCap,
        stored: toStore.length,
        /** Rows actually written. An unchanged re-import writes none. */
        writes,
        ...counts,
        /**
         * Cases whose SPECIFICATION did not change but whose automation status
         * or execution date did. Counted separately because the content hash
         * excludes both on purpose, so this number is the one that keeps the
         * backlog current without claiming the case was edited.
         */
        statusOnlyChanged,
        reinstated,
        retired,
        /** Cases that would have been retired and were not. See `absence`. */
        retiredWithheld: importIsPartial ? absent.length : 0,
        notStated,
        /**
         * How the step rows arrived. Three of the four states produce no rows
         * for three different reasons, and only ROWS makes `stepCount` a
         * measurement.
         */
        stepsByState,
      },
      /** What the suite claims to hold, when it says. Null when it does not. */
      claimedTotal: read.claimedTotal,
      truncated: read.truncated,
      changes: dispositions,
      changesLimit: CAPS.changesListed,
      gaps: gaps.lines,
      gapsLimit: CAPS.gapsListed,
      /** Problems recorded, whether or not the list above could echo them. */
      gapsRecorded: gaps.total,
      gapsTruncated: gaps.total > gaps.lines.length,
      absence: {
        items: absentListed.map((row) => ({
          externalId: row.externalId,
          automationStatus: row.automationStatus,
          retired: !importIsPartial && !body.dryRun,
        })),
        total: absent.length,
        truncated: absent.length > absentListed.length,
        limit: CAPS.retiredListed,
        /** True when nothing was retired because this read was not complete. */
        withheld: importIsPartial,
        rule: importIsPartial
          ? 'this import was PARTIAL (a cap on the READ bit, a page failed, or the suite claims ' +
            'more cases than arrived), so nothing was retired: the cases we did not read are ' +
            'indistinguishable from the cases that are gone, and retiring them would shrink the ' +
            'backlog denominator with nothing automated.'
          : 'a case absent from a re-import is RETIRED and KEPT IN THE DENOMINATOR, never ' +
            'deleted. A suite uploaded against the wrong project would otherwise raise the ' +
            'automation percentage.',
      },
      suite: {
        /** False for CSV: an exported sheet may hold a backlog rather than a suite. */
        holdsManualSuite: holdsManualSuite(source),
        pages: read.pages,
        pageSize: input === 'FETCH' ? (body.pageSize ?? CAPS.suitePageSize) : null,
        transportInjected: io.suiteTransport !== null,
        /**
         * Said on every import, because it is the one thing a reader cannot see
         * from the numbers: this router never holds a suite credential, so it
         * cannot put one in this response — and the gap sentences below, which
         * come from a transport we do not own, are scrubbed before they land
         * here in case the transport put one in an error message.
         */
        credentialNote:
          'this endpoint accepts no credential: a ManualSuiteTransport holds its own base URL ' +
          'and token and is injected, and every gap or caveat it produced is redacted of ' +
          'credential-shaped text before it reaches this response or the audit log.',
      },
      caps: CAPS,
      capsThatBit,
      capRule: describeCaps(capsThatBit),
      warnings: read.caveats.map(scrub),
      lastExecutedNote: LAST_EXECUTED_NOTE,
      stepsStateLabels: MANUAL_STEPS_STATE_LABELS,
    });
  },
);

// ─── POST /manual-cases/:projectId/automated-by ─────────────────────────────

const automatedByBody = z.object({
  externalId: z.string().trim().min(1).max(128),
  sourceSystem: z.enum(SPEC_SOURCE_SYSTEMS),
  /**
   * The generated test that replaced this case. Required, and checked to exist
   * in THIS project: an id that points at nothing would store the exact pair
   * the schema shaped itself to make visible — AUTOMATED with no test — as a
   * fresh inconsistency we created ourselves.
   */
  testId: z.string().trim().min(1).max(64),
});

manualCasesRouter.post(
  '/manual-cases/:projectId/automated-by',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsed = automatedByBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body', {
        fieldErrors: parsed.error.flatten().fieldErrors,
      });
    }
    const { externalId, sourceSystem, testId } = parsed.data;
    const project = await projectOr404(String(req.params.projectId));

    const existing = await prisma.manualTestCase.findUnique({
      where: {
        projectId_sourceSystem_externalId: { projectId: project.id, sourceSystem, externalId },
      },
      select: { id: true, automationStatus: true, automatedByTestId: true },
    });
    if (!existing) throw notFound('Manual test case');

    const test = await prisma.test.findUnique({
      where: { id: testId },
      select: { id: true, projectId: true },
    });
    // A test in another project is as absent as one that does not exist: this
    // is a claim that THIS case is covered, and a cross-project id would make
    // the claim unverifiable from either side.
    if (!test || test.projectId !== project.id) throw notFound('Test');

    const previous = {
      automationStatus: existing.automationStatus,
      automatedByTestId: existing.automatedByTestId,
    };
    await prisma.manualTestCase.update({
      where: { id: existing.id },
      data: { automationStatus: 'AUTOMATED', automatedByTestId: test.id },
      select: { id: true },
    });

    await audit({
      actor: actorOf(req),
      action: 'manualCases.automatedBy',
      targetType: 'ManualTestCase',
      targetId: existing.id,
      metadata: { externalId, sourceSystem, testId: test.id, previous },
    });

    res.status(200).json({
      projectId: project.id,
      externalId,
      sourceSystem,
      automationStatus: 'AUTOMATED',
      automatedByTestId: test.id,
      previous,
      /**
       * Said here because this is the endpoint that creates the pair: deleting
       * the test nulls the link and leaves the case claiming to be automated.
       * The inventory read reports that as its own count rather than hiding it.
       */
      note: AUTOMATED_WITH_NO_TEST_RULE,
    });
  },
);

// ─── GET /manual-cases/:projectId ───────────────────────────────────────────

const readQuery = z.object({
  limit: z.coerce.number().int().min(1).max(CAPS.pageMax).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** Comma-separated ManualTestAutomationStatus values. */
  automationStatus: z.string().optional(),
  /** Comma-separated SpecSourceSystem values — the column's whole domain. */
  sourceSystem: z.string().optional(),
  /**
   * Retired cases are INCLUDED by default, which is the opposite of
   * routes/api-surface.ts and deliberate.
   *
   * There, retirement is a decision a person took and hiding it keeps a
   * worked-through list clean. Here it is OUR mark on a case that did not
   * appear in a re-import, and the case is still in the backlog denominator —
   * so defaulting to EXCLUDE would make this list disagree with
   * `/backlog`, and the person comparing them would conclude one is broken.
   */
  retired: z.enum(['INCLUDE', 'EXCLUDE', 'ONLY']).optional(),
  /**
   * Only the cases marked automated whose test is gone.
   *
   * `z.enum` and NOT `z.coerce.boolean()`: coercion reads the string "false" as
   * `true`, so `?inconsistentOnly=false` would silently narrow the list to the
   * broken rows and a reader would conclude every automated case is broken.
   */
  inconsistentOnly: z.enum(['true', 'false']).optional(),
});

manualCasesRouter.get(
  '/manual-cases/:projectId',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = readQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
    const query = parsed.data;
    const project = await projectOr404(String(req.params.projectId));

    const statuses = parseList<ManualTestAutomationStatus>(
      query.automationStatus,
      MANUAL_TEST_AUTOMATION_STATUSES,
      'automationStatus',
    );
    const systems = parseList<SpecSourceSystem>(
      query.sourceSystem,
      SPEC_SOURCE_SYSTEMS,
      'sourceSystem',
    );

    const retired = query.retired ?? 'INCLUDE';
    /*
     * EVERY FILTER IS IN THE `where`, so it applies BEFORE `take`.
     *
     * A filter applied to the page after it was taken makes a short page look
     * like an exhausted list, and makes `total` disagree with what came back.
     * `inconsistentOnly` is in here too, which is why it can be: the pair it
     * selects is two columns on the row and not a join.
     */
    const where: Prisma.ManualTestCaseWhereInput = { projectId: project.id };
    if (retired === 'EXCLUDE') where.retiredAt = null;
    if (retired === 'ONLY') where.retiredAt = { not: null };
    if (statuses) where.automationStatus = { in: statuses };
    if (systems) where.sourceSystem = { in: systems };
    if (query.inconsistentOnly === 'true') {
      if (statuses && !statuses.includes('AUTOMATED')) {
        /*
         * The two filters cannot both be honoured. A 400 and not an empty
         * list: `[]` here reads as "no case is in this state", which is the
         * answer a reader would act on, when the truth is "you asked for two
         * things that cannot both be true". Same argument as an unknown filter
         * value below.
         */
        throw badRequest(
          '`inconsistentOnly=true` selects cases whose automationStatus is AUTOMATED, and ' +
            `automationStatus=${statuses.join(',')} excludes it. Drop one of the two.`,
        );
      }
      where.automationStatus = 'AUTOMATED';
      where.automatedByTestId = null;
    }

    const limit = query.limit ?? CAPS.pageDefault;
    const offset = query.offset ?? 0;
    const [pageRows, total, automatedWithNoTest] = await Promise.all([
      prisma.manualTestCase.findMany({
        where,
        orderBy: [{ sourceSystem: 'asc' }, { externalId: 'asc' }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          externalId: true,
          sourceSystem: true,
          title: true,
          steps: true,
          expectedResult: true,
          url: true,
          automationStatus: true,
          automatedByTestId: true,
          lastExecutedAt: true,
          contentChangedAt: true,
          firstImportedAt: true,
          lastImportedAt: true,
          retiredAt: true,
        },
      }),
      prisma.manualTestCase.count({ where }),
      /*
       * THE INCONSISTENCY, counted over the whole project and not the page.
       *
       * Exact rather than capped: it is two indexed columns on one table, and a
       * count that only covered the current page would read as "there are 2 of
       * these" when there are two hundred.
       */
      prisma.manualTestCase.count({
        where: { projectId: project.id, automationStatus: 'AUTOMATED', automatedByTestId: null },
      }),
    ]);

    const cases = pageRows.map((row) => {
      const steps = readStepsColumn(row.steps);
      return {
        externalId: row.externalId,
        sourceSystem: row.sourceSystem,
        title: row.title,
        expectedResult: row.expectedResult,
        url: row.url,
        automationStatus: row.automationStatus,
        automationLabel: MANUAL_TEST_AUTOMATION_LABELS[row.automationStatus],
        automatedByTestId: row.automatedByTestId,
        /**
         * The pair the schema was shaped to make visible: a case marked
         * automated whose test has been deleted. Surfaced per row AND counted
         * project-wide, because hiding it would turn a visible defect into a
         * silent downgrade of the customer's suite.
         */
        automatedButTestMissing:
          row.automationStatus === 'AUTOMATED' && row.automatedByTestId === null,
        /** Null when no state was ever stated — not DECLARED_EMPTY, which is a fact. */
        stepsState: steps.state,
        stepsStateLabel: steps.state === null ? null : MANUAL_STEPS_STATE_LABELS[steps.state],
        /** NULL for every state but ROWS and DECLARED_EMPTY: unknown is not zero. */
        stepCount: stepCountOf(steps),
        steps: steps.rows,
        /** The unsplit blob, when the suite gave prose instead of rows. */
        stepProse: steps.prose,
        lastExecutedAtIso: row.lastExecutedAt ? row.lastExecutedAt.toISOString() : null,
        contentChangedAtIso: row.contentChangedAt ? row.contentChangedAt.toISOString() : null,
        firstImportedAtIso: row.firstImportedAt.toISOString(),
        lastImportedAtIso: row.lastImportedAt.toISOString(),
        retiredAtIso: row.retiredAt ? row.retiredAt.toISOString() : null,
      };
    });

    res.json({
      projectId: project.id,
      cases,
      total,
      offset,
      limit,
      truncated: offset + pageRows.length < total,
      filters: {
        retired,
        automationStatus: statuses ?? null,
        sourceSystem: systems ?? null,
        inconsistentOnly: query.inconsistentOnly === 'true',
        note:
          'every filter is applied in the query, before the page is taken, so `total` is the ' +
          'count of what matched and a page shorter than `limit` means the list is exhausted.',
      },
      inconsistencies: {
        automatedWithNoTest,
        label: AUTOMATED_WITH_NO_TEST_LABEL,
        rule: AUTOMATED_WITH_NO_TEST_RULE,
        /** Project-wide and unaffected by the filters above. Said so explicitly. */
        scope: 'the whole project, not this page and not the filters above',
      },
      lastExecutedNote: LAST_EXECUTED_NOTE,
      stepsStateLabels: MANUAL_STEPS_STATE_LABELS,
      caps: CAPS,
    });
  },
);

// ─── GET /manual-cases/:projectId/backlog ───────────────────────────────────

const backlogQuery = z.object({
  /** Comma-separated SpecSourceSystem values: one suite's backlog, not the sum. */
  sourceSystem: z.string().optional(),
});

manualCasesRouter.get(
  '/manual-cases/:projectId/backlog',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = backlogQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
    const project = await projectOr404(String(req.params.projectId));
    const systems = parseList<SpecSourceSystem>(
      parsed.data.sourceSystem,
      SPEC_SOURCE_SYSTEMS,
      'sourceSystem',
    );

    const where: Prisma.ManualTestCaseWhereInput = { projectId: project.id };
    if (systems) where.sourceSystem = { in: systems };

    /*
     * ONE SCAN, AND RETIRED CASES ARE IN IT.
     *
     * A case absent from a re-import is retired and stays in this denominator,
     * because retiring on absence is precisely how a suite uploaded against the
     * wrong project raises the automation percentage. The retired count is
     * reported beside the number so a reader can see how much of the
     * denominator it is — but it is not subtracted, and there is no second
     * percentage over a second denominator for anybody to quote by mistake.
     */
    const scanned = await prisma.manualTestCase.findMany({
      where,
      select: { automationStatus: true, retiredAt: true },
      take: CAPS.inventoryScan + 1,
    });
    const scanTruncated = scanned.length > CAPS.inventoryScan;
    const rows = scanned.slice(0, CAPS.inventoryScan);

    // `manualBacklogTotals` and never a second derivation. NOT_STATED out of
    // the backlog and in the total, and `automatedPercent` null when nothing
    // states a position, are its contract — recomputing them here is how the
    // constant and the thing it governs end up in two files disagreeing.
    const measured = manualBacklogTotals(rows.map((row) => row.automationStatus));
    const automatedWithNoTest = await prisma.manualTestCase.count({
      where: { ...where, automationStatus: 'AUTOMATED', automatedByTestId: null },
    });

    res.json({
      projectId: project.id,
      sourceSystem: systems ?? null,
      totals: {
        ...measured,
        /**
         * NULL when the scan was capped, whatever the arithmetic said.
         *
         * A ratio over a partial scan is a number with an unknown denominator,
         * and printing it is worse than printing nothing. The counts above
         * become FLOORS in the same case and `countsAreFloors` says so.
         */
        automatedPercent: scanTruncated ? null : measured.automatedPercent,
        rule: scanTruncated
          ? `the scan stopped at ${CAPS.inventoryScan} cases, so every count here is a LOWER ` +
            'BOUND and the automation ratio is not computable. Had the scan completed it would ' +
            `have read: ${measured.rule}`
          : measured.rule,
      },
      /** True when a cap bit and the counts above are floors rather than totals. */
      countsAreFloors: scanTruncated,
      retained: {
        retired: rows.filter((row) => row.retiredAt !== null).length,
        rule:
          'cases retired because they were absent from a re-import are IN the denominator above. ' +
          'Dropping them would mean a suite uploaded against the wrong project, or a page that ' +
          'failed to load, raised the automation percentage with nothing automated.',
      },
      inconsistencies: {
        automatedWithNoTest,
        label: AUTOMATED_WITH_NO_TEST_LABEL,
        rule: AUTOMATED_WITH_NO_TEST_RULE,
      },
      scan: {
        limit: CAPS.inventoryScan,
        truncated: scanTruncated,
        scanned: rows.length,
      },
      labels: MANUAL_TEST_AUTOMATION_LABELS,
      /**
       * The one sentence this endpoint must not let a reader get wrong: a
       * tracker's issue count is not a suite's case count, and the two must
       * never be added to make one percentage.
       */
      denominatorNote:
        'one denominator: the manual cases stored for this project (and this sourceSystem, when ' +
        'one is given). A Jira backlog and a TestRail suite are different denominators and are ' +
        'never summed — filter by sourceSystem to ask about one of them.',
      caps: CAPS,
    });
  },
);
