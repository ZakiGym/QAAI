/**
 * Line and branch coverage — THE HALF OF THE MEASUREMENT NOTHING COULD RECEIVE.
 *
 * ── The defect, stated plainly ──────────────────────────────────────────────
 *
 * There is no instrumentation anywhere in this product, so the only question it
 * could answer was "which crawled surface does a test MENTION". When a buyer
 * says "coverage" they mean the other thing: which LINES did my suite execute.
 * Their own CI already computes that — every c8, vitest and jest run can emit
 * it — and QAAI had no door to put it through. So an untested server branch
 * could never be named by file and line even when the number sat in an artifact
 * on the customer's own build.
 *
 * And the gate rules the previous slice shipped make that concrete:
 * `MIN_PATCH_COVERAGE` is a saveable rule, and the only `PatchCoverage` in the
 * product is ROUTE-shaped — "of the routes this diff touches, how many have a
 * test". That is a useful number and it is not the one a PR gate is asked for.
 * A reviewer wants "you added 40 lines and 9 of them are executed by nothing",
 * and nothing in this repo could produce that sentence.
 *
 *   POST /code-coverage/:projectId          ingest one c8/V8 or Istanbul payload
 *   GET  /code-coverage/:projectId/files    the per-file roll-up
 *   GET  /code-coverage/:projectId/uncovered  which lines/branches, ranked
 *   POST /code-coverage/:projectId/patch    coverage of the lines a change touched
 *
 * ── WHAT THIS ENDPOINT MUST NEVER DO ────────────────────────────────────────
 *
 * Partially ingest. A coverage payload that is too large, too old, or about a
 * commit this project has never heard of is REFUSED with a reason and nothing
 * is written. The reason is not fastidiousness: every partial ingest moves the
 * number in the flattering direction or in an unknowable one, and a percentage
 * computed from three quarters of a payload is indistinguishable, afterwards,
 * from one computed from all of it. Same judgement as `fetchDocumentOr400` in
 * api-surface.ts — the cap stops the READING and becomes a 4xx, never a quiet
 * truncation.
 *
 * Report a line count it did not measure. A V8 payload is byte OFFSETS into a
 * script. Turning those into line numbers needs the script's text, and this API
 * stores paths and no file contents (`CodebaseSnapshot.paths` says so in the
 * schema). So a V8 entry with no `source`, or whose source is compiler output
 * with a `sourceMappingURL` we cannot follow, is UNMAPPED — named, counted, and
 * never folded into "0% covered". Zero covered lines is a measurement; it is
 * the worst possible result and it is not what "we could not read this" means.
 *
 * Double-count. The same payload posted twice — a retried CI step, two shards
 * uploading the same artifact — must not produce two uploads. Every ingest is
 * keyed by a hash of its own facts and a repeat is answered 200 with
 * `idempotent: true` and the id of the upload that already holds it.
 *
 * ── WHY THE STORE IS INJECTED AND WHY IT CAN BE ABSENT ──────────────────────
 *
 * The two tables this router reads and writes — `CodeCoverageUpload` and
 * `CodeCoverageFile` — are not in schema.prisma yet; the DDL is handed to the
 * schema's owner. Rather than ship a door that cannot compile until that lands,
 * the persistence is a narrow injected port and its one adapter resolves the
 * Prisma delegates BY NAME at call time, exactly as `resolveIngest` in
 * api-surface.ts resolves an agent export that did not exist when its door was
 * written. When the delegates are absent every endpoint answers 503 with the
 * table names in the message. A 503 is the only honest answer: 200 with an
 * empty list would say "your suite executes none of your code", which is a
 * measured claim about the customer made out of our own missing migration.
 */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ApiError, badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';

export const codeCoverageRouter: Router = Router();

codeCoverageRouter.use(requireAuth);

// ─── The rows, and the sentinels ────────────────────────────────────────────

/**
 * `'<unvaried>'`, the variant sentinel, spelled the same here as in
 * `TestResultVariant`.
 *
 * NOT NULL and a sentinel rather than a nullable column, for the reason that
 * schema's own comment gives: PostgreSQL treats every NULL as distinct, so a
 * unique index over a nullable variant would let the default cell — the one
 * almost every upload belongs to — re-insert on every run and be counted once
 * per run. The idempotency key below is only a key because this value exists.
 */
const UNVARIED = '<unvaried>';

/** Why a file's coverage could not be expressed as line numbers of source. */
const UNMAPPED_REASONS = {
  /**
   * A V8 entry with byte offsets and no `source`. The offsets are real and we
   * cannot turn them into lines, because no file contents are stored anywhere
   * in this product.
   */
  NO_SOURCE_TEXT:
    'the payload gave byte offsets and no source text, and QAAI stores file paths without ' +
    'contents, so the offsets cannot become line numbers',
  /**
   * A V8 entry whose source carries `//# sourceMappingURL=`, i.e. it is
   * compiler output. Its line numbers are the BUNDLER's, and naming "line 412
   * of dist/index.js" to somebody who wrote TypeScript is a wrong answer that
   * looks exactly like a right one.
   */
  SOURCE_MAP_UNRESOLVED:
    'the source is compiler output carrying a sourceMappingURL this API cannot follow, so its ' +
    'line numbers belong to the emitted file and not to anything the author wrote',
} as const;

type UnmappedReason = keyof typeof UNMAPPED_REASONS;

/**
 * The payload dialects this door reads.
 *
 * Exported because the body validator's options are built from it and the
 * parity test asserts the two halves agree — see
 * {@link COVERAGE_FORMAT_PRESENT}.
 */
export const COVERAGE_FORMATS = ['ISTANBUL', 'V8'] as const;
const FORMATS = COVERAGE_FORMATS;
type CoverageFormat = (typeof FORMATS)[number];

/**
 * A compiler-enforced presence record over {@link CoverageFormat}, paired with
 * the runtime parity test in the test file.
 *
 * This codebase requires BOTH halves for any vocabulary with a write path:
 * eight GateRule kinds shipped unsaveable for two slices because only one of
 * the two existed, and `check:wiring` cannot see that class of defect. The
 * record makes adding a member to the union a compile error here; the parity
 * test makes adding one here without teaching the parser a test failure.
 */
export const COVERAGE_FORMAT_PRESENT: Record<CoverageFormat, true> = {
  ISTANBUL: true,
  V8: true,
};

/**
 * One `CodeCoverageUpload` row, as this router reads it.
 *
 * The shape is declared here and not imported from the generated Prisma client
 * for the reason in the header: the table does not exist yet, so a type that
 * came from the client would not compile. When the migration lands this
 * interface is the contract the adapter is checked against.
 */
export interface CodeCoverageUploadRow {
  id: string;
  orgId: string;
  projectId: string;
  /** The commit the payload is about. Always known to the project — see `commitKnown`. */
  commitSha: string;
  /** The run it was taken from, when it was taken from one. */
  runId: string | null;
  /** The test it is about, for a per-test upload. Null for a whole-run payload. */
  testId: string | null;
  /** `TestResultVariant.id`, when the uploader named a cell. */
  variantId: string | null;
  /** The cell's identity, `'<unvaried>'` for an unvaried upload. Never null. */
  variantKey: string;
  format: CoverageFormat;
  /** sha256 over the canonical facts. The idempotency key. */
  payloadHash: string;
  /** Bytes of payload accepted. */
  bytes: number;
  /** When the producer says it measured. Rejected past `CAPS.maxPayloadAgeMs`. */
  generatedAt: Date;
  /** Files in the payload, including unmapped ones. The denominator's width. */
  fileCount: number;
  /** Files whose coverage became line numbers. */
  mappedFileCount: number;
  /** Files that did not. Counted, never dropped and never read as zero. */
  unmappedFileCount: number;
  /** Files whose path is not in the project's source-tree snapshot. */
  notInSourceTreeCount: number;
  /**
   * Totals over the MAPPED files only, and NULL when there are none.
   *
   * Null rather than 0 for the whole-upload rule this product turns on: 0 found
   * lines would read as "this payload measured nothing executable", and a
   * payload of 400 unmapped files measured nothing we could READ, which is a
   * different sentence. `percent` follows the same rule as
   * `CoverageSnapshot.percent` — null, never 0 and never 100, when there is
   * nothing to divide.
   */
  linesFound: number | null;
  linesCovered: number | null;
  branchesFound: number | null;
  branchesCovered: number | null;
  /** Every cap that BIT, as `CapHit[]`. `[]` is a positive claim that none did. */
  caps: unknown;
  createdAt: Date;
}

/** One `CodeCoverageFile` row. One per source file per upload. */
export interface CodeCoverageFileRow {
  id: string;
  uploadId: string;
  /** Repo-relative where we could make it so, else the payload's own spelling. */
  path: string;
  /** The payload's untouched key, kept so a producer can match our answer to its own. */
  rawPath: string;
  /** True when `path` is in the project's `CodebaseSnapshot.paths`. */
  inSourceTree: boolean;
  /** False when the coverage could not become line numbers. */
  mapped: boolean;
  /** Set exactly when `mapped` is false. */
  unmappedReason: UnmappedReason | null;
  /**
   * NULL on an unmapped file, never 0. Same rule as the upload totals: a file
   * we could not read has no line count, and 0 found lines is a claim that the
   * file contains no executable code.
   */
  linesFound: number | null;
  linesCovered: number | null;
  branchesFound: number | null;
  branchesCovered: number | null;
  /**
   * `linesFound - linesCovered`, stored so the ranked read can ORDER BY it and
   * the "only files with a gap" filter is an index scan rather than a fetch of
   * every row. NULL on an unmapped file.
   */
  uncoveredLineCount: number | null;
  uncoveredBranchCount: number | null;
  /**
   * The uncovered line numbers, ascending — TRUNCATED at
   * `CAPS.uncoveredLinesPerFile`.
   *
   * This array is a convenience and NEVER the arithmetic. `uncoveredLineCount`
   * above is the authority, and `uncoveredLinesTruncated` says when the list is
   * shorter than the count. A reader that measured `uncoveredLines.length`
   * would report 500 gaps in a file with 9,000, which is the precise shape of a
   * cap that bit without being disclosed.
   */
  uncoveredLines: number[];
  uncoveredLinesTruncated: boolean;
  /** `{ line, index, type }[]`, truncated at `CAPS.uncoveredBranchesPerFile`. */
  uncoveredBranches: unknown;
  uncoveredBranchesTruncated: boolean;
}

/** What `createUpload` is handed. Ids and timestamps are the store's. */
type UploadInsert = Omit<CodeCoverageUploadRow, 'id' | 'createdAt'>;
type FileInsert = Omit<CodeCoverageFileRow, 'id' | 'uploadId'>;

// ─── The injected store ─────────────────────────────────────────────────────

/** Which files a read wants. Translated to Prisma `where` by the adapter. */
export interface FileFilter {
  uploadId: string;
  /** Undefined means both. */
  inSourceTree?: boolean;
  /** True restricts to files with at least one uncovered line or branch. */
  withGapsOnly?: boolean;
  /** True restricts to mapped files; false to unmapped ones. */
  mapped?: boolean;
}

/**
 * The persistence this router needs, and nothing else.
 *
 * ── Why every read carries `select` ─────────────────────────────────────────
 *
 * Because two defects survived a whole slice behind select-blind fakes. A fake
 * that ignores `select` returns the whole row, so deleting a field from a query
 * changes nothing a test can see — the response keeps the field, the assertion
 * keeps passing, and production loses it. Here `select` is a
 * `Record<K, true>` and the return is `Pick<Row, K>`, so the compiler carries
 * the projection through and a fake cannot be select-blind without failing to
 * typecheck.
 *
 * ── Why the write is one semantic call and not three delegate calls ─────────
 *
 * Because an upload and its files are ONE fact. A transaction that wrote the
 * upload row and then failed on the files would leave a row claiming to have
 * measured a payload whose measurements are not there — reported, afterwards,
 * as a project whose every file is 0% covered. So the boundary is the port's,
 * the adapter runs it inside `$transaction`, and no caller can get half of it.
 */
export interface CodeCoverageStore {
  /** The idempotency probe. Null when this payload has never been accepted. */
  findUploadByHash<K extends keyof CodeCoverageUploadRow>(args: {
    where: { projectId: string; payloadHash: string };
    select: Readonly<Record<K, true>>;
  }): Promise<Pick<CodeCoverageUploadRow, K> | null>;

  /**
   * The newest upload matching the filter — what every read is computed
   * against. Newest and not an aggregate of all of them: merging two uploads
   * taken at different commits produces a number about no commit at all.
   */
  findNewestUpload<K extends keyof CodeCoverageUploadRow>(args: {
    where: { projectId: string; commitSha?: string; runId?: string; testId?: string };
    select: Readonly<Record<K, true>>;
  }): Promise<Pick<CodeCoverageUploadRow, K> | null>;

  findFiles<K extends keyof CodeCoverageFileRow>(args: {
    where: FileFilter;
    /** `GAPS` ranks by uncovered lines descending; `PATH` is alphabetical. */
    orderBy: 'GAPS' | 'PATH';
    skip: number;
    take: number;
    select: Readonly<Record<K, true>>;
  }): Promise<Array<Pick<CodeCoverageFileRow, K>>>;

  countFiles(args: { where: FileFilter }): Promise<number>;

  /** The patch read: only the files a diff names, by path. */
  findFilesByPath<K extends keyof CodeCoverageFileRow>(args: {
    where: { uploadId: string; paths: readonly string[] };
    select: Readonly<Record<K, true>>;
  }): Promise<Array<Pick<CodeCoverageFileRow, K>>>;

  /** The whole ingest, atomically. See the note above. */
  createUpload(args: {
    upload: UploadInsert;
    files: readonly FileInsert[];
  }): Promise<{ id: string; createdAt: Date }>;
}

/** The I/O this router takes. */
export interface CodeCoverageIo {
  /** Null means "resolve the Prisma-backed one at call time". */
  store: CodeCoverageStore | null;
  /** So "too old" is testable without waiting a week. */
  now: () => Date;
}

let io: CodeCoverageIo = { store: null, now: () => new Date() };

/**
 * Point this router at its I/O. Returns the previous settings so a test can
 * restore them — the same contract as `configureApiSurfaceIo`, and for the same
 * reason: one test leaking a fake into the next is a whole afternoon.
 */
export function configureCodeCoverageIo(next: Partial<CodeCoverageIo>): CodeCoverageIo {
  const previous = io;
  io = { ...io, ...next };
  return previous;
}

/** The Prisma delegate names this router's adapter looks for. */
const UPLOAD_DELEGATE = 'codeCoverageUpload';
const FILE_DELEGATE = 'codeCoverageFile';

/**
 * 503 and the table names.
 *
 * Not 200-with-nothing, which would report a customer's suite as executing none
 * of their code, and not 500, which says "we broke" when the truth is "this
 * install has not run the migration". `errors.ts` has no helper at this status
 * because `health.ts` is the only other place that needs one, and it builds its
 * own the same way.
 */
const storeUnavailable = (): ApiError =>
  new ApiError(
    503,
    'CODE_COVERAGE_STORE_UNAVAILABLE',
    `Line coverage storage is not available on this deployment: the Prisma client exposes no ` +
      `\`${UPLOAD_DELEGATE}\`/\`${FILE_DELEGATE}\` delegate, so the CodeCoverageUpload and ` +
      `CodeCoverageFile tables have not been migrated. Nothing was read and nothing was ` +
      `written. This is a deployment gap and says nothing about how much of your code is ` +
      `covered.`,
    { delegates: [UPLOAD_DELEGATE, FILE_DELEGATE] },
  );

/**
 * The shape the adapter needs off a delegate it cannot name at compile time.
 *
 * `unknown` arguments and `unknown` results deliberately: this is the ONE place
 * the untyped boundary lives, the typed contract is {@link CodeCoverageStore}
 * above, and widening it here is what keeps every caller checked. The dynamic
 * lookup is the same device as `(prisma as unknown as Record<string, ...>)[model]`
 * in export-org.ts.
 */
interface UntypedDelegate {
  findFirst: (args: unknown) => Promise<unknown>;
  findMany: (args: unknown) => Promise<unknown>;
  count: (args: unknown) => Promise<unknown>;
  create: (args: unknown) => Promise<unknown>;
  createMany: (args: unknown) => Promise<unknown>;
}

const isDelegate = (value: unknown): value is UntypedDelegate => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.findFirst === 'function' &&
    typeof candidate.findMany === 'function' &&
    typeof candidate.count === 'function' &&
    typeof candidate.create === 'function' &&
    typeof candidate.createMany === 'function'
  );
};

/**
 * The untyped boundary's one cast, named so it is searchable.
 *
 * A delegate resolved by name returns `unknown`, and the method being
 * implemented knows the shape it promised, so `T` comes from the contextual
 * return type. It is a cast and not a validation on purpose: Prisma's own
 * `select` decides the shape, the interface above declares it, and a runtime
 * re-check here would be this file asserting something it cannot know better
 * than the client does. Every such cast is in `prismaStore` and nowhere else.
 */
const asSelected = <T>(value: unknown): T => value as T;

/** `FileFilter` → a Prisma `where`. The only translation the adapter performs. */
function fileWhere(filter: FileFilter): Record<string, unknown> {
  const where: Record<string, unknown> = { uploadId: filter.uploadId };
  if (filter.inSourceTree !== undefined) where.inSourceTree = filter.inSourceTree;
  if (filter.mapped !== undefined) where.mapped = filter.mapped;
  if (filter.withGapsOnly === true) {
    where.OR = [{ uncoveredLineCount: { gt: 0 } }, { uncoveredBranchCount: { gt: 0 } }];
  }
  return where;
}

/**
 * The Prisma-backed store, or null when the tables are not there.
 *
 * Thin on purpose. Everything arguable — what a cap does, what counts as
 * uncovered, what the percentage is when the denominator is empty — is above
 * this line and tested with a fake; this function translates and forwards.
 */
function prismaStore(): CodeCoverageStore | null {
  const client = prisma as unknown as Record<string, unknown> & {
    $transaction?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  const uploads = client[UPLOAD_DELEGATE];
  const files = client[FILE_DELEGATE];
  if (!isDelegate(uploads) || !isDelegate(files)) return null;
  const transaction = client.$transaction;
  if (typeof transaction !== 'function') return null;

  return {
    findUploadByHash: async (args) =>
      asSelected(await uploads.findFirst({ where: args.where, select: args.select })),
    findNewestUpload: async (args) =>
      asSelected(
        await uploads.findFirst({
          where: args.where,
          orderBy: { createdAt: 'desc' },
          select: args.select,
        }),
      ),
    findFiles: async (args) =>
      asSelected(
        await files.findMany({
          where: fileWhere(args.where),
          orderBy:
            args.orderBy === 'GAPS'
              ? [{ uncoveredLineCount: 'desc' }, { path: 'asc' }]
              : [{ path: 'asc' }],
          skip: args.skip,
          take: args.take,
          select: args.select,
        }),
      ),
    countFiles: async (args) => Number(await files.count({ where: fileWhere(args.where) })),
    findFilesByPath: async (args) =>
      asSelected(
        await files.findMany({
          where: { uploadId: args.where.uploadId, path: { in: [...args.where.paths] } },
          select: args.select,
        }),
      ),
    createUpload: async (args) =>
      /*
       * ONE transaction. A new delegate used inside `$transaction` must be
       * reached off the `tx` handle and not off the top-level client — at the
       * top level the write escapes the transaction, which changes nothing
       * visible until the day the second statement fails.
       */
      (await transaction(async (tx) => {
        const scoped = tx as Record<string, unknown>;
        const txUploads = scoped[UPLOAD_DELEGATE];
        const txFiles = scoped[FILE_DELEGATE];
        if (!isDelegate(txUploads) || !isDelegate(txFiles)) throw storeUnavailable();
        const created = (await txUploads.create({
          data: args.upload,
          select: { id: true, createdAt: true },
        })) as { id: string; createdAt: Date };
        if (args.files.length > 0) {
          await txFiles.createMany({
            data: args.files.map((file) => ({ ...file, uploadId: created.id })),
          });
        }
        return created;
      })) as { id: string; createdAt: Date },
  };
}

/** The store, or a 503. Every handler's first line after validation. */
function requireStore(): CodeCoverageStore {
  const store = io.store ?? prismaStore();
  if (!store) throw storeUnavailable();
  return store;
}

// ─── Caps, every one of which is reported ───────────────────────────────────

/**
 * The caps this router applies.
 *
 * Collected in one record and returned WHOLE on every response, not only the
 * entries that bit, because the entire value of a disclosed cap is that a
 * reader can see the limit that did NOT bite and know the number is intact.
 * Lifted straight from `CAPS` in api-surface.ts so that the two ingest doors
 * read the same.
 */
export const CODE_COVERAGE_CAPS = {
  /**
   * Bytes of payload accepted. REFUSED past this, never cut — see
   * `inlineLimitNote` below for the smaller limit that actually applies.
   */
  payloadBytes: 16_000_000,
  /**
   * Files persisted from one payload. Past this the payload is REFUSED.
   *
   * Unlike api-surface's `operations`, which stores the first N and counts the
   * rest, because a truncated set of FILES makes every roll-up wrong in a
   * direction nobody can predict: drop the uncovered files and the percentage
   * rises, drop the covered ones and it falls, and either way the stored number
   * is about a project that does not exist. A refusal is recoverable; a stored
   * lie is not.
   */
  files: 20_000,
  /** How old a payload may be. Past this it describes code nobody is shipping. */
  maxPayloadAgeMs: 7 * 24 * 60 * 60 * 1_000,
  /**
   * How far into the future a `generatedAt` may sit before it is refused.
   *
   * CI clocks drift; a payload stamped next March does not. Accepting one would
   * make it the newest upload for this project for five months, so every read
   * would answer from it however many correct payloads arrived afterwards.
   */
  clockSkewMs: 5 * 60 * 1_000,
  /** Uncovered line numbers LISTED per file row. Truncates; the count does not. */
  uncoveredLinesPerFile: 500,
  /** Uncovered branches listed per file row. Truncates; the count does not. */
  uncoveredBranchesPerFile: 200,
  /** Source-tree paths read when resolving payload paths. */
  sourceTreePaths: 100_000,
  /** Changed paths accepted by /patch in one request. REFUSED past this. */
  patchPaths: 2_000,
  /** Changed lines accepted per path. REFUSED past this. */
  patchLinesPerPath: 10_000,
  /** Per-file entries named in one /patch response, beside the full count. */
  patchFilesListed: 500,
  /**
   * Characters of one file path accepted.
   *
   * A payload path is a key in somebody else's JSON and is otherwise unbounded.
   * `path` is half of a unique index, and PostgreSQL refuses a btree entry past
   * roughly 2,700 bytes — so without this the pathological case is not a 400,
   * it is the INSERT failing at the end of the transaction and surfacing as a
   * 500 with no reason the caller can act on.
   */
  pathChars: 1_000,
  /** Default and maximum page size for the reads. */
  pageDefault: 100,
  pageMax: 1_000,
} as const;

/**
 * Exported so a CI client can size a payload BEFORE spending a minute
 * uploading one this door will refuse, and read as `CAPS` below because the
 * handlers quote it constantly.
 */
const CAPS = CODE_COVERAGE_CAPS;

interface CapHit {
  cap: string;
  limit: number;
  /** How much the cap hid. For a refusal, how much over the limit the payload was. */
  droppedAtLeast: number;
}

/**
 * The sentence a reader forwards. Worded once, because the value of a disclosed
 * cap is that it reads the same everywhere it appears.
 */
function describeCaps(hits: readonly CapHit[]): string {
  if (hits.length === 0) return 'no cap bit: every file in the payload is accounted for';
  return hits
    .map((hit) => `${hit.cap} (limit ${hit.limit}) hid at least ${hit.droppedAtLeast}`)
    .join('; ');
}

/**
 * The one cap this router applies and does not own.
 *
 * `CAPS.payloadBytes` is this door's allowance. A payload arrives through the
 * API's global JSON body parser, whose limit is smaller, so a larger body is
 * refused by IT with a 413 before this handler runs — and that 413 says nothing
 * about which limit it was. Printing `payloadBytes` alone would advertise an
 * allowance no caller can use. Identical note, identical reason, as
 * `inlineLimitNote` in api-surface.ts.
 */
const INLINE_LIMIT_NOTE =
  'a payload also passes through the API’s global JSON body limit, which is smaller than ' +
  'payloadBytes; a larger body is refused by the body parser with a 413 before this endpoint ' +
  'sees it. Split the payload per test, or raise the limit for this route.';

// ─── The payload dialects ───────────────────────────────────────────────────

/**
 * Istanbul's `coverage-final.json`, as loosely as it can be read while still
 * being read correctly.
 *
 * `passthrough`/`catchall` rather than a strict shape, because `fnMap`, `f` and
 * the half-dozen keys istanbul has added over the years are not this door's
 * business and refusing a payload for carrying them would reject every real
 * one. What IS pinned is the four structures the line and branch arithmetic
 * reads, so a payload missing them is a 400 naming the key rather than a silent
 * zero.
 */
const istanbulPosition = z.looseObject({ line: z.number().int().min(0) });
const istanbulLoc = z.looseObject({
  start: istanbulPosition,
  end: istanbulPosition.optional(),
});

const istanbulFile = z.looseObject({
  path: z.string().optional(),
  statementMap: z.record(z.string(), istanbulLoc),
  s: z.record(z.string(), z.number()),
  branchMap: z
    .record(
      z.string(),
      z.looseObject({
        loc: istanbulLoc.optional(),
        type: z.string().optional(),
        locations: z.array(istanbulLoc.nullable()).optional(),
      }),
    )
    .optional(),
  b: z.record(z.string(), z.array(z.number())).optional(),
});

const istanbulPayload = z.record(z.string(), istanbulFile);

/**
 * V8 / c8 raw coverage, as `NODE_V8_COVERAGE` writes it, with the one extension
 * that makes it mappable: an optional `source`.
 *
 * c8 reads the file off disk to do this conversion. This process cannot — it
 * has a path and no filesystem anywhere near the customer's repo — so the
 * uploader may include the text, and when it does not, the file is UNMAPPED and
 * said to be.
 */
const v8Range = z.object({
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  count: z.number().int().min(0),
});

const v8Script = z.looseObject({
  url: z.string(),
  source: z.string().optional(),
  functions: z.array(
    z.looseObject({ ranges: z.array(v8Range), isBlockCoverage: z.boolean().optional() }),
  ),
});

const v8Payload = z.looseObject({ result: z.array(v8Script) });

/** One file's measurement, dialect-independent. */
interface MeasuredFile {
  rawPath: string;
  mapped: boolean;
  unmappedReason: UnmappedReason | null;
  linesFound: number | null;
  linesCovered: number | null;
  branchesFound: number | null;
  branchesCovered: number | null;
  uncoveredLines: number[];
  uncoveredBranches: Array<{ line: number; index: number; type: string }>;
}

/**
 * Which dialect this is, structurally.
 *
 * By SHAPE and not by a `format` field the caller sends, because the caller's
 * declaration and the bytes disagree often enough to matter — api-surface
 * learned the same thing and reports the mismatch as a warning. Here the
 * declared format is honoured as a REQUIREMENT when given (a payload that is
 * not what the caller said is a 400, not a silent reinterpretation), and
 * detection is what `AUTO` uses.
 */
function detectFormat(payload: unknown): CoverageFormat | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.result)) return 'V8';
  // Istanbul is a bare map of path → file coverage, so it is identified by one
  // of its values having a statementMap rather than by a wrapper key.
  for (const value of Object.values(record)) {
    if (typeof value === 'object' && value !== null && 'statementMap' in value) return 'ISTANBUL';
  }
  return null;
}

/**
 * Istanbul → lines and branches.
 *
 * LINE COVERAGE IS DERIVED FROM STATEMENTS, taking the MAXIMUM count per line,
 * which is what istanbul-lib-coverage's own `getLineCoverage` does. The maximum
 * and not the minimum: a line holding two statements, one of which ran, is a
 * line that ran. Using the minimum would report executed code as dead, and this
 * product's one job is to be the number somebody forwards.
 *
 * A file with an empty `statementMap` is MAPPED with `linesFound: 0`. That is a
 * real measurement and not an absence — a file of only type declarations has no
 * executable statement — and it is why `linesFound` is 0 here and null on an
 * unmapped file.
 */
function measureIstanbul(rawPath: string, file: z.infer<typeof istanbulFile>): MeasuredFile {
  const lineHits = new Map<number, number>();
  for (const [id, loc] of Object.entries(file.statementMap)) {
    const line = loc.start.line;
    if (line <= 0) continue;
    const count = file.s[id] ?? 0;
    const previous = lineHits.get(line);
    if (previous === undefined || previous < count) lineHits.set(line, count);
  }

  const uncoveredLines: number[] = [];
  let linesCovered = 0;
  for (const [line, count] of [...lineHits.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > 0) linesCovered += 1;
    else uncoveredLines.push(line);
  }

  const uncoveredBranches: MeasuredFile['uncoveredBranches'] = [];
  let branchesFound = 0;
  let branchesCovered = 0;
  for (const [id, meta] of Object.entries(file.branchMap ?? {})) {
    const counts = file.b?.[id];
    if (!counts) continue;
    const locations = meta.locations ?? [];
    for (let index = 0; index < counts.length; index += 1) {
      branchesFound += 1;
      if ((counts[index] ?? 0) > 0) {
        branchesCovered += 1;
        continue;
      }
      /*
       * A branch location can be null in istanbul's own output — an implicit
       * else has no source range — so the branch's own `loc` is the fallback.
       * Line 0 rather than dropping the entry: the branch IS uncovered, and
       * losing it because we could not place it would lower the only count that
       * matters here.
       */
      const line = locations[index]?.start.line ?? meta.loc?.start.line ?? 0;
      uncoveredBranches.push({ line, index, type: meta.type ?? 'unknown' });
    }
  }

  return {
    rawPath,
    mapped: true,
    unmappedReason: null,
    linesFound: lineHits.size,
    linesCovered,
    branchesFound,
    branchesCovered,
    uncoveredLines,
    uncoveredBranches,
  };
}

/**
 * V8 byte offsets → line coverage, given the script's text.
 *
 * The rule, which is c8's: build a per-character count by applying the ranges
 * OUTERMOST FIRST so an inner range overwrites its enclosing one — V8 reports a
 * function's range and then the uncovered blocks inside it, and applying them
 * in payload order would let the function's count paint over the zeroes. Then a
 * line is FOUND if it holds a non-whitespace character inside any range at all,
 * and COVERED if any of those characters has a count above zero.
 *
 * Non-whitespace only, because a blank line and a closing brace are not
 * coverable and counting them inflates both halves of the fraction — the
 * denominator more than the numerator in a file with early returns, which makes
 * a badly-tested file look better than it is.
 */
function measureV8Source(
  rawPath: string,
  source: string,
  script: z.infer<typeof v8Script>,
): MeasuredFile {
  const counts = new Int32Array(source.length).fill(-1);
  const ranges = script.functions
    .flatMap((fn) => fn.ranges)
    .slice()
    .sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.startOffset, source.length));
    const end = Math.max(start, Math.min(range.endOffset, source.length));
    for (let at = start; at < end; at += 1) counts[at] = range.count;
  }

  let line = 1;
  let lineFound = false;
  let lineCovered = false;
  const uncoveredLines: number[] = [];
  let linesFound = 0;
  let linesCovered = 0;

  const endLine = (): void => {
    if (!lineFound) return;
    linesFound += 1;
    if (lineCovered) linesCovered += 1;
    else uncoveredLines.push(line);
  };

  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    if (char === '\n') {
      endLine();
      line += 1;
      lineFound = false;
      lineCovered = false;
      continue;
    }
    if (char === undefined || char === ' ' || char === '\t' || char === '\r') continue;
    const count = counts[at] ?? -1;
    if (count < 0) continue;
    lineFound = true;
    if (count > 0) lineCovered = true;
  }
  endLine();

  return {
    rawPath,
    mapped: true,
    unmappedReason: null,
    linesFound,
    linesCovered,
    /*
     * V8 block coverage is per RANGE, not per branch, and the ranges do not
     * carry which conditional they belong to. So branches are NOT MEASURED
     * here, and that is NULL rather than 0 — a branch count of 0 would read as
     * "this file has no conditionals", which is a statement about the
     * customer's code made out of a dialect's silence. The Istanbul reporter
     * (`c8 --reporter=json`) carries real branch data; this is the raw dialect.
     */
    branchesFound: null,
    branchesCovered: null,
    uncoveredLines,
    uncoveredBranches: [],
  };
}

/** The V8 entry we cannot place in source, named and counted. */
function unmappedFile(rawPath: string, reason: UnmappedReason): MeasuredFile {
  return {
    rawPath,
    mapped: false,
    unmappedReason: reason,
    linesFound: null,
    linesCovered: null,
    branchesFound: null,
    branchesCovered: null,
    uncoveredLines: [],
    uncoveredBranches: [],
  };
}

/** `//# sourceMappingURL=` / `//@ sourceMappingURL=`, in either comment form. */
const SOURCE_MAPPING_URL = /\/[/*][#@]\s*sourceMappingURL\s*=/;

function measureV8(payload: z.infer<typeof v8Payload>): MeasuredFile[] {
  return payload.result.map((script) => {
    const rawPath = script.url;
    if (script.source === undefined) return unmappedFile(rawPath, 'NO_SOURCE_TEXT');
    if (SOURCE_MAPPING_URL.test(script.source)) {
      return unmappedFile(rawPath, 'SOURCE_MAP_UNRESOLVED');
    }
    return measureV8Source(rawPath, script.source, script);
  });
}

// ─── Resolving a payload path against the project's source tree ─────────────

/**
 * The payload's paths are absolute, or `file://`, or relative to a working
 * directory this process has never seen. The project's own tree is
 * `CodebaseSnapshot.paths` — repo-relative, no contents — so resolution is a
 * SUFFIX match against it, longest first.
 *
 * Suffix and not exact, because `/home/runner/work/app/app/src/billing.ts` and
 * `src/billing.ts` are the same file and no amount of string equality will say
 * so. Longest-first, because `src/billing.ts` and `vendor/src/billing.ts` both
 * end in `src/billing.ts` and the longer match is the one that is actually
 * about that file.
 *
 * AMBIGUITY IS NOT RESOLVED SILENTLY. Two tree paths that both suffix-match and
 * are the same length is a real repo shape — two workspaces with the same file
 * name — and picking one would attribute coverage to a file that may not have
 * run. Those arrive as `inSourceTree: false`, keeping the payload's own
 * spelling, and the count is in the response.
 */
/**
 * The spelling a path is compared and stored under when it could not be placed
 * in the source tree.
 *
 * Factored out of the resolver because TWO callers have to agree on it exactly:
 * the resolver, and the duplicate check below. If they disagree,
 * `file:///x/a.ts` and `/x/a.ts` pass the duplicate check as two files and then
 * store as one path twice, which violates the `(uploadId, path)` unique and
 * fails the whole ingest at the last statement of the transaction.
 */
export function normalisePayloadPath(rawPath: string): string {
  return rawPath
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

export function resolveAgainstTree(
  rawPath: string,
  tree: ReadonlyMap<string, readonly string[]>,
): { path: string; inSourceTree: boolean } {
  const normalised = normalisePayloadPath(rawPath);
  const segments = normalised.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === undefined) return { path: normalised, inSourceTree: false };

  const candidates = tree.get(last);
  if (!candidates || candidates.length === 0) return { path: normalised, inSourceTree: false };

  let best: string | null = null;
  let bestLength = 0;
  let ambiguous = false;
  for (const candidate of candidates) {
    const candidateSegments = candidate.split('/').filter(Boolean);
    if (candidateSegments.length > segments.length) continue;
    const tail = segments.slice(segments.length - candidateSegments.length);
    if (tail.join('/') !== candidateSegments.join('/')) continue;
    if (candidateSegments.length > bestLength) {
      best = candidate;
      bestLength = candidateSegments.length;
      ambiguous = false;
    } else if (candidateSegments.length === bestLength && candidate !== best) {
      ambiguous = true;
    }
  }

  if (best === null || ambiguous) return { path: normalised, inSourceTree: false };
  return { path: best, inSourceTree: true };
}

/** Tree paths indexed by basename, so resolution is not O(files x tree). */
function indexTree(paths: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const path of paths) {
    const normalised = path.replace(/\\/g, '/').replace(/^\.\//, '');
    const segments = normalised.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last === undefined) continue;
    const bucket = index.get(last);
    if (bucket) bucket.push(normalised);
    else index.set(last, [normalised]);
  }
  return index;
}

// ─── The idempotency key ────────────────────────────────────────────────────

/**
 * A character no path or sha can contain, used as the field separator.
 *
 * Same device and same reason as `CANONICAL_SEPARATOR` in api-surface.ts: with
 * a printable separator two fields can be rearranged into one canonical string,
 * so `a|b` and `a|b` would hash identically for different payloads.
 */
const CANONICAL_SEPARATOR = '\u001f';

/**
 * The payload's identity.
 *
 * ── What is in the key, and why each ────────────────────────────────────────
 *
 * The SCOPE — project, commit, run, test, variant — because the same byte-identical
 * payload legitimately describes two different things when it is uploaded for
 * two different cells, and collapsing those would lose a whole matrix row.
 * The FORMAT, because the same facts read through two dialects produce different
 * line arithmetic and storing one as the other's duplicate would hide that.
 * The MEASUREMENTS, per file, sorted — not the raw bytes. Two c8 runs of the
 * same suite emit the same coverage with keys in a different order and
 * `generatedAt` a second apart, and hashing the bytes would store that as two
 * uploads and let every read answer from whichever arrived last.
 *
 * `generatedAt` is deliberately NOT in the key, which is the whole point: a
 * re-upload of the same measurements an hour later is the same measurement.
 */
function payloadKey(input: {
  projectId: string;
  commitSha: string;
  runId: string | null;
  testId: string | null;
  variantKey: string;
  format: CoverageFormat;
  files: readonly MeasuredFile[];
}): string {
  const parts = [
    input.projectId,
    input.commitSha,
    input.runId ?? UNVARIED,
    input.testId ?? UNVARIED,
    input.variantKey,
    input.format,
  ];
  const fileParts = input.files
    .map((file) =>
      [
        file.rawPath,
        file.mapped ? 'M' : `U:${file.unmappedReason ?? ''}`,
        file.linesFound ?? '',
        file.linesCovered ?? '',
        file.branchesFound ?? '',
        file.branchesCovered ?? '',
        file.uncoveredLines.join(','),
      ].join(CANONICAL_SEPARATOR),
    )
    .sort();
  return createHash('sha256')
    .update([...parts, ...fileParts].join(CANONICAL_SEPARATOR))
    .digest('hex');
}

/** How the key was built, said out loud in the response. */
const IDEMPOTENCY_RULE =
  'keyed by sha256 over (projectId, commitSha, runId, testId, variantKey, format) and every ' +
  'file’s own measurements, sorted. Byte order, key order and generatedAt are NOT in the key, ' +
  'so a re-upload of the same measurements is recognised as the same upload and stored once.';

// ─── Arithmetic ─────────────────────────────────────────────────────────────

/**
 * `covered / found` as a percentage to one decimal, or NULL.
 *
 * NULL and never 0 and never 100 when there is nothing to divide — the rule
 * `CoverageSnapshot.percent` is documented with and the one every reader of
 * this product's numbers depends on. An empty denominator means our extractor
 * found nothing, and printing either end of the scale would be a claim about
 * the customer's code made out of our own silence.
 */
function percentOf(covered: number | null, found: number | null): number | null {
  if (covered === null || found === null || found <= 0) return null;
  return Math.round((covered / found) * 1_000) / 10;
}

/** Upload-level totals over the MAPPED files only, each null when there are none. */
function totalsOf(files: readonly MeasuredFile[]): {
  linesFound: number | null;
  linesCovered: number | null;
  branchesFound: number | null;
  branchesCovered: number | null;
} {
  let lineFiles = 0;
  let branchFiles = 0;
  let linesFound = 0;
  let linesCovered = 0;
  let branchesFound = 0;
  let branchesCovered = 0;
  for (const file of files) {
    if (file.linesFound !== null && file.linesCovered !== null) {
      lineFiles += 1;
      linesFound += file.linesFound;
      linesCovered += file.linesCovered;
    }
    if (file.branchesFound !== null && file.branchesCovered !== null) {
      branchFiles += 1;
      branchesFound += file.branchesFound;
      branchesCovered += file.branchesCovered;
    }
  }
  return {
    linesFound: lineFiles > 0 ? linesFound : null,
    linesCovered: lineFiles > 0 ? linesCovered : null,
    branchesFound: branchFiles > 0 ? branchesFound : null,
    branchesCovered: branchFiles > 0 ? branchesCovered : null,
  };
}

// ─── Shared plumbing ────────────────────────────────────────────────────────

/**
 * The same helper as surface.ts and api-surface.ts, copied for the reason
 * api-surface's copy records: a router importing another router's internals
 * couples their module load order for a nine-line function.
 */
async function projectOr404(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, orgId: true, name: true },
  });
  if (!project) throw notFound('Project');
  return project;
}

/**
 * Is this a commit the project has ever heard of?
 *
 * Checked against `Run.commitSha` and `CoverageSnapshot.commitSha` — the two
 * places this product records a commit it has measured something at. A payload
 * for an unknown commit is REFUSED, and the reason is not pedantry: patch
 * coverage joins stored lines to a diff AT A COMMIT, and a payload filed under
 * a sha nothing else in the install shares can never be joined to anything. It
 * would sit there as the newest upload for the project and answer every read
 * with measurements of code that was never in this repo.
 */
async function commitIsKnown(projectId: string, commitSha: string): Promise<boolean> {
  const [run, snapshot] = await Promise.all([
    prisma.run.findFirst({ where: { projectId, commitSha }, select: { id: true } }),
    prisma.coverageSnapshot.findFirst({ where: { projectId, commitSha }, select: { id: true } }),
  ]);
  return run !== null || snapshot !== null;
}

/** The project's source tree, as the resolver wants it, plus whether it exists. */
async function sourceTreeOf(projectId: string): Promise<{
  index: ReadonlyMap<string, readonly string[]>;
  snapshotId: string | null;
  pathCount: number;
  capped: boolean;
}> {
  const snapshot = await prisma.codebaseSnapshot.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, paths: true },
  });
  if (!snapshot) return { index: new Map(), snapshotId: null, pathCount: 0, capped: false };
  const raw = Array.isArray(snapshot.paths) ? snapshot.paths : [];
  const paths = raw.filter((entry): entry is string => typeof entry === 'string');
  const capped = paths.length > CAPS.sourceTreePaths;
  const taken = capped ? paths.slice(0, CAPS.sourceTreePaths) : paths;
  return {
    index: indexTree(taken),
    snapshotId: snapshot.id,
    pathCount: taken.length,
    capped,
  };
}

// ─── POST /code-coverage/:projectId ─────────────────────────────────────────

const commitShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,40}$/i, 'commitSha must be a 7–40 character hex sha');

/**
 * Exported for the parity test, which reads THIS schema's options rather than a
 * second copy of the list — a parity test against a list it also owns proves
 * nothing.
 */
export const codeCoverageIngestBody = z.object({
  /**
   * REQUIRED, and validated against the project's own history.
   *
   * Not optional-with-a-fallback-to-the-run's-sha, because the two must AGREE
   * and the only way to notice that they do not is to be given both. A payload
   * uploaded against the wrong commit is the one input that makes patch
   * coverage confidently wrong rather than unavailable.
   */
  commitSha: commitShaSchema,
  /** ISO. Refused when older than `CAPS.maxPayloadAgeMs` or in the future. */
  generatedAt: z.string().datetime(),
  /**
   * `AUTO` detects by shape. A named format is a REQUIREMENT: a payload that is
   * not what the caller said is refused rather than reinterpreted, because the
   * two dialects produce different line arithmetic and a caller who sent the
   * wrong artifact needs to be told, not accommodated.
   */
  format: z.enum(['AUTO', ...FORMATS]).default('AUTO'),
  /** The run this was measured during, when it was measured during one. */
  runId: z.string().trim().min(1).max(200).optional(),
  /** The test it is about, for a per-test payload. Absent means whole-run. */
  testId: z.string().trim().min(1).max(200).optional(),
  /** `TestResultVariant.id`, when the uploader knows the cell. */
  variantId: z.string().trim().min(1).max(200).optional(),
  /**
   * The cell's identity. Defaults to the `'<unvaried>'` sentinel rather than
   * being nullable, so the idempotency key always has a value to hash — see
   * {@link UNVARIED}.
   */
  variantKey: z.string().trim().min(1).max(200).default(UNVARIED),
  /** The coverage itself, in one of the two dialects. */
  payload: z.unknown(),
});

codeCoverageRouter.post(
  '/code-coverage/:projectId',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsed = codeCoverageIngestBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body', {
        fieldErrors: parsed.error.flatten().fieldErrors,
      });
    }
    const body = parsed.data;
    const project = await projectOr404(String(req.params.projectId));
    const store = requireStore();
    const now = io.now();

    if (body.payload === undefined || body.payload === null) {
      throw badRequest(
        '`payload` is required. An ingest with no payload would be stored as an upload that ' +
          'measured nothing, which reads afterwards as a project with no covered lines.',
      );
    }

    /*
     * SIZE FIRST, before any parse.
     *
     * Measured off the payload as re-serialised, which is the honest number to
     * compare against a cap this router owns: the request's own byte length is
     * the body parser's business and it has already made its decision by now
     * (see INLINE_LIMIT_NOTE). Refused, never truncated.
     */
    const bytes = Buffer.byteLength(JSON.stringify(body.payload), 'utf8');
    if (bytes > CAPS.payloadBytes) {
      throw badRequest(
        `That payload is ${bytes} bytes and the limit is ${CAPS.payloadBytes}. It is refused ` +
          'rather than truncated: a partial coverage payload stores a roll-up about a project ' +
          'that does not exist, and nothing afterwards can tell it from a whole one.',
        {
          caps: CAPS,
          capsThatBit: [
            {
              cap: 'payloadBytes',
              limit: CAPS.payloadBytes,
              droppedAtLeast: bytes - CAPS.payloadBytes,
            },
          ],
          inlineLimitNote: INLINE_LIMIT_NOTE,
        },
      );
    }

    /*
     * AGE SECOND. A payload measured a fortnight ago describes code nobody is
     * shipping, and a payload stamped next March would stay the newest upload
     * for this project for five months and answer every read however many
     * correct payloads arrived after it.
     */
    const generatedAt = new Date(body.generatedAt);
    const ageMs = now.getTime() - generatedAt.getTime();
    if (ageMs > CAPS.maxPayloadAgeMs) {
      throw unprocessable(
        `That payload was generated ${Math.floor(ageMs / 86_400_000)} day(s) ago and the limit ` +
          `is ${Math.floor(CAPS.maxPayloadAgeMs / 86_400_000)} day(s). It is refused rather than ` +
          'stored: it would become the newest coverage for this project and answer every read ' +
          'with measurements of code that has since changed.',
        { generatedAt: generatedAt.toISOString(), ageMs, maxPayloadAgeMs: CAPS.maxPayloadAgeMs },
      );
    }
    if (ageMs < -CAPS.clockSkewMs) {
      throw unprocessable(
        `That payload is stamped ${generatedAt.toISOString()}, which is in the future by more ` +
          `than the ${CAPS.clockSkewMs}ms clock-skew allowance. It is refused rather than ` +
          'stored: a future timestamp outranks every correct payload that arrives afterwards.',
        {
          generatedAt: generatedAt.toISOString(),
          nowIso: now.toISOString(),
          clockSkewMs: CAPS.clockSkewMs,
        },
      );
    }

    /* THIRD: the commit. See `commitIsKnown` for why an unknown one is refused. */
    const commitSha = body.commitSha.toLowerCase();
    if (!(await commitIsKnown(project.id, commitSha))) {
      throw unprocessable(
        `This project has no run and no coverage snapshot at commit ${commitSha}, so a payload ` +
          'filed under it could never be joined to a diff or to a run. Nothing was stored. ' +
          'Record the run first, or upload against a commit this project has measured.',
        { commitSha, checked: ['Run.commitSha', 'CoverageSnapshot.commitSha'] },
      );
    }

    /*
     * The run and the test, both scoped to this project. A payload naming
     * another project's run would attach measurements across a tenant
     * boundary; `withTenant` already scopes the read, and a miss is a 404 on
     * the named thing rather than a silently-dropped column.
     */
    let runId: string | null = null;
    if (body.runId !== undefined) {
      const run = await prisma.run.findUnique({
        where: { id: body.runId },
        select: { id: true, projectId: true, commitSha: true },
      });
      if (!run || run.projectId !== project.id) throw notFound('Run');
      /*
       * The run's own sha wins the argument by being compared, not by being
       * used. A mismatch means the uploader is about to file this run's
       * coverage under someone else's commit, which is exactly the input that
       * makes patch coverage wrong instead of absent.
       */
      if (run.commitSha !== null && run.commitSha.toLowerCase() !== commitSha) {
        throw conflict(
          `Run ${run.id} is at commit ${run.commitSha} and this payload declares ${commitSha}. ` +
            'Nothing was stored: coverage filed under the wrong commit joins a diff to lines ' +
            'that were never in it.',
          { runCommitSha: run.commitSha, payloadCommitSha: commitSha },
        );
      }
      runId = run.id;
    }

    let testId: string | null = null;
    if (body.testId !== undefined) {
      const test = await prisma.test.findUnique({
        where: { id: body.testId },
        select: { id: true, projectId: true },
      });
      if (!test || test.projectId !== project.id) throw notFound('Test');
      testId = test.id;
    }

    /* The dialect. */
    const detected = detectFormat(body.payload);
    if (detected === null) {
      throw badRequest(
        'That payload is neither Istanbul (a map of path → { statementMap, s, … }) nor V8 ' +
          '(`{ result: [{ url, functions }] }`). It is refused rather than read as empty: an ' +
          'unreadable payload stored as zero files reports a suite that executes nothing.',
        { formats: FORMATS },
      );
    }
    if (body.format !== 'AUTO' && body.format !== detected) {
      throw badRequest(
        `You declared format ${body.format} and this payload is ${detected}. It is refused ` +
          'rather than reinterpreted: the two dialects produce different line arithmetic, and a ' +
          'caller who uploaded the wrong artifact needs to know that rather than get a number.',
        { declared: body.format, detected },
      );
    }

    let measured: MeasuredFile[];
    if (detected === 'ISTANBUL') {
      const payload = istanbulPayload.safeParse(body.payload);
      if (!payload.success) {
        throw badRequest(
          `That Istanbul payload is missing a structure the arithmetic reads: ` +
            `${payload.error.issues[0]?.path.join('.') ?? '(root)'} — ` +
            `${payload.error.issues[0]?.message ?? 'invalid'}. Nothing was stored.`,
          { fieldErrors: payload.error.flatten().fieldErrors },
        );
      }
      measured = Object.entries(payload.data).map(([key, file]) =>
        measureIstanbul(file.path ?? key, file),
      );
    } else {
      const payload = v8Payload.safeParse(body.payload);
      if (!payload.success) {
        throw badRequest(
          `That V8 payload is malformed: ${payload.error.issues[0]?.path.join('.') ?? '(root)'} — ` +
            `${payload.error.issues[0]?.message ?? 'invalid'}. Nothing was stored.`,
          { fieldErrors: payload.error.flatten().fieldErrors },
        );
      }
      measured = measureV8(payload.data);
    }

    /*
     * THE ROW CAP, as a refusal. See `CAPS.files` for why this one does not
     * store the first N like api-surface's `operations` does.
     */
    if (measured.length > CAPS.files) {
      throw unprocessable(
        `That payload carries ${measured.length} files and the limit is ${CAPS.files}. It is ` +
          'refused rather than cut: dropping files moves the roll-up in a direction nobody can ' +
          'predict — drop the uncovered ones and the percentage rises, drop the covered ones ' +
          'and it falls — and the stored number would be about a project that does not exist.',
        {
          caps: CAPS,
          capsThatBit: [
            { cap: 'files', limit: CAPS.files, droppedAtLeast: measured.length - CAPS.files },
          ],
        },
      );
    }

    /*
     * A PATH TOO LONG TO INDEX. See `CAPS.pathChars`: refused here with the
     * path named, rather than as a 500 from the last statement of the write.
     */
    const overLong = measured.filter(
      (file) => normalisePayloadPath(file.rawPath).length > CAPS.pathChars,
    );
    if (overLong.length > 0) {
      throw unprocessable(
        `${overLong.length} path(s) in this payload are longer than ${CAPS.pathChars} ` +
          'characters, which is past what the path index can hold. Nothing was stored.',
        {
          caps: CAPS,
          capsThatBit: [
            { cap: 'pathChars', limit: CAPS.pathChars, droppedAtLeast: overLong.length },
          ],
          paths: overLong.slice(0, 5).map((file) => file.rawPath.slice(0, 120)),
        },
      );
    }

    /*
     * THE SAME FILE TWICE.
     *
     * A V8 `result` can carry two entries for one url — the same module loaded
     * in two workers — and an Istanbul document can be assembled by hand from
     * two shards. Either way there are two measurements of one file and three
     * ways to handle it, two of which are lies: summing them invents a number
     * neither producer reported, and keeping one silently discards half the
     * evidence while reporting success. So it is refused, and the message names
     * the tool whose job the merge actually is.
     *
     * It is also what makes `(uploadId, path)` unique holdable. Without this
     * check the duplicate reaches the insert and fails the whole transaction at
     * its last statement, which is a 500 where a 422 with a reason belongs.
     */
    const seenPaths = new Map<string, number>();
    for (const file of measured) {
      const key = normalisePayloadPath(file.rawPath);
      seenPaths.set(key, (seenPaths.get(key) ?? 0) + 1);
    }
    const duplicated = [...seenPaths.entries()].filter(([, count]) => count > 1);
    if (duplicated.length > 0) {
      throw unprocessable(
        `This payload measures ${duplicated.length} file(s) more than once, starting with ` +
          `${duplicated[0]?.[0]}. Nothing was stored: QAAI will not merge two measurements of ` +
          'one file, because the merge rule belongs to whatever produced them (c8 merges its own ' +
          'V8 fragments; nyc merges Istanbul documents). Merge before uploading, or upload each ' +
          'fragment as its own variant.',
        {
          duplicatePaths: duplicated.slice(0, 25).map(([path, count]) => ({ path, count })),
          duplicatePathsTotal: duplicated.length,
        },
      );
    }

    /* IDEMPOTENCY, before any write. */
    const payloadHash = payloadKey({
      projectId: project.id,
      commitSha,
      runId,
      testId,
      variantKey: body.variantKey,
      format: detected,
      files: measured,
    });
    const existing = await store.findUploadByHash({
      where: { projectId: project.id, payloadHash },
      select: { id: true, createdAt: true, fileCount: true },
    });
    if (existing) {
      res.json({
        uploadId: existing.id,
        idempotent: true,
        /*
         * 200 and not 409. A retried CI step uploading the same artifact is
         * doing the right thing and must not see a failure; what it must not do
         * is cause a second upload, and it has not.
         */
        duplicateOf: {
          uploadId: existing.id,
          createdAt: existing.createdAt,
          fileCount: existing.fileCount,
        },
        idempotencyRule: IDEMPOTENCY_RULE,
        stored: { files: 0 },
        message: 'this payload was already accepted; nothing was written a second time',
      });
      return;
    }

    /* Resolution against the source tree. */
    const tree = await sourceTreeOf(project.id);
    const capsThatBit: CapHit[] = [];
    if (tree.capped) {
      capsThatBit.push({
        cap: 'sourceTreePaths',
        limit: CAPS.sourceTreePaths,
        droppedAtLeast: 1,
      });
    }

    /*
     * TWO PAYLOAD PATHS THAT LAND ON ONE SOURCE FILE.
     *
     * `/ci/a/src/billing.ts` and `/ci/b/src/billing.ts` both suffix-match
     * `src/billing.ts` — a monorepo building the same package twice. That is
     * the same ambiguity `resolveAgainstTree` refuses to guess at, seen from
     * the other side: there it is one path matching two tree entries, here it
     * is two paths matching one. So it gets the same answer. BOTH revert to
     * their own spelling with `inSourceTree: false`, which keeps the
     * denominator whole, keeps every stored `path` distinct, and keeps us from
     * attributing one file's coverage to a build it did not come from.
     */
    const treeClaims = new Map<string, number>();
    const resolutions = measured.map((file) => resolveAgainstTree(file.rawPath, tree.index));
    for (const resolution of resolutions) {
      if (!resolution.inSourceTree) continue;
      treeClaims.set(resolution.path, (treeClaims.get(resolution.path) ?? 0) + 1);
    }
    const collidedPaths = [...treeClaims.entries()]
      .filter(([, count]) => count > 1)
      .map(([path]) => path);
    const collided = new Set(collidedPaths);

    let mappedFileCount = 0;
    let unmappedFileCount = 0;
    let notInSourceTreeCount = 0;
    let linesTruncatedFiles = 0;
    let branchesTruncatedFiles = 0;

    const files: FileInsert[] = measured.map((file, index) => {
      const matched = resolutions[index] ?? { path: file.rawPath, inSourceTree: false };
      const resolved =
        matched.inSourceTree && collided.has(matched.path)
          ? { path: normalisePayloadPath(file.rawPath), inSourceTree: false }
          : matched;
      if (file.mapped) mappedFileCount += 1;
      else unmappedFileCount += 1;
      if (!resolved.inSourceTree) notInSourceTreeCount += 1;

      const uncoveredLineCount =
        file.linesFound === null || file.linesCovered === null
          ? null
          : file.linesFound - file.linesCovered;
      const uncoveredBranchCount =
        file.branchesFound === null || file.branchesCovered === null
          ? null
          : file.branchesFound - file.branchesCovered;

      const linesTruncated = file.uncoveredLines.length > CAPS.uncoveredLinesPerFile;
      if (linesTruncated) linesTruncatedFiles += 1;
      const branchesTruncated = file.uncoveredBranches.length > CAPS.uncoveredBranchesPerFile;
      if (branchesTruncated) branchesTruncatedFiles += 1;

      return {
        path: resolved.path,
        rawPath: file.rawPath,
        inSourceTree: resolved.inSourceTree,
        mapped: file.mapped,
        unmappedReason: file.unmappedReason,
        linesFound: file.linesFound,
        linesCovered: file.linesCovered,
        branchesFound: file.branchesFound,
        branchesCovered: file.branchesCovered,
        uncoveredLineCount,
        uncoveredBranchCount,
        /*
         * The LIST truncates and the COUNT above does not. That asymmetry is
         * the whole disclosure: a reader that measures the array gets 500, a
         * reader that reads the count gets the truth, and
         * `uncoveredLinesTruncated` is how the first reader finds out.
         */
        uncoveredLines: file.uncoveredLines.slice(0, CAPS.uncoveredLinesPerFile),
        uncoveredLinesTruncated: linesTruncated,
        uncoveredBranches: file.uncoveredBranches.slice(0, CAPS.uncoveredBranchesPerFile),
        uncoveredBranchesTruncated: branchesTruncated,
      };
    });

    if (linesTruncatedFiles > 0) {
      capsThatBit.push({
        cap: 'uncoveredLinesPerFile',
        limit: CAPS.uncoveredLinesPerFile,
        droppedAtLeast: linesTruncatedFiles,
      });
    }
    if (branchesTruncatedFiles > 0) {
      capsThatBit.push({
        cap: 'uncoveredBranchesPerFile',
        limit: CAPS.uncoveredBranchesPerFile,
        droppedAtLeast: branchesTruncatedFiles,
      });
    }

    const totals = totalsOf(measured);
    const created = await store.createUpload({
      upload: {
        orgId: project.orgId,
        projectId: project.id,
        commitSha,
        runId,
        testId,
        variantId: body.variantId ?? null,
        variantKey: body.variantKey,
        format: detected,
        payloadHash,
        bytes,
        generatedAt,
        fileCount: files.length,
        mappedFileCount,
        unmappedFileCount,
        notInSourceTreeCount,
        ...totals,
        caps: capsThatBit,
      },
      files,
    });

    const actor = actorOf(req);
    await audit({
      actor,
      action: 'code_coverage.ingest',
      targetType: 'Project',
      targetId: project.id,
      metadata: {
        uploadId: created.id,
        commitSha,
        format: detected,
        fileCount: files.length,
        unmappedFileCount,
        bytes,
      },
    });

    res.json({
      uploadId: created.id,
      idempotent: false,
      idempotencyRule: IDEMPOTENCY_RULE,
      commitSha,
      format: { requested: body.format, detected },
      scope: { runId, testId, variantId: body.variantId ?? null, variantKey: body.variantKey },
      generatedAt: generatedAt.toISOString(),
      bytes,
      totals: {
        files: files.length,
        mapped: mappedFileCount,
        /*
         * UNMAPPED IS NOT ZERO-COVERED. Named as its own count, kept out of
         * every percentage below, and the reasons are echoed so the uploader
         * can fix the artifact rather than conclude their suite runs nothing.
         */
        unmapped: unmappedFileCount,
        notInSourceTree: notInSourceTreeCount,
        ...totals,
        linePercent: percentOf(totals.linesCovered, totals.linesFound),
        branchPercent: percentOf(totals.branchesCovered, totals.branchesFound),
      },
      unmapped: {
        count: unmappedFileCount,
        reasons: Object.fromEntries(
          (Object.keys(UNMAPPED_REASONS) as UnmappedReason[])
            .map(
              (reason) =>
                [reason, measured.filter((f) => f.unmappedReason === reason).length] as const,
            )
            .filter(([, count]) => count > 0),
        ),
        rule:
          'an unmapped file is counted and stored, and it is in NO percentage on this response. ' +
          'Folding it into the denominator as zero-covered would report our inability to read ' +
          'the artifact as the customer’s suite running none of their code.',
        reasonText: UNMAPPED_REASONS,
      },
      sourceTree: {
        snapshotId: tree.snapshotId,
        pathCount: tree.pathCount,
        /*
         * Named and counted. A collision is the one case where `notInSourceTree`
         * is caused by US rather than by the customer's artifact, so a reader
         * who sees that count rise has to be able to tell which it was.
         */
        pathCollisions: collidedPaths.length,
        collidedPaths: collidedPaths.slice(0, 25),
        collisionRule:
          'two payload paths that suffix-match one repo path are BOTH left unresolved rather ' +
          'than merged or arbitrarily assigned; they keep their own spelling and stay in the ' +
          'denominator',
        /*
         * No snapshot is not "nothing matched". With no source tree every path
         * is `inSourceTree: false` for a reason that is about this install's
         * setup, and a reader has to be able to tell that from a payload full
         * of paths that genuinely are not in the repo.
         */
        resolved: tree.snapshotId !== null,
        note:
          tree.snapshotId === null
            ? 'no CodebaseSnapshot exists for this project, so no payload path could be resolved ' +
              'to a repo-relative path. Upload the source (POST /source/:projectId) to get file ' +
              'paths a reviewer can open.'
            : 'payload paths are suffix-matched against the snapshot’s paths, longest match ' +
              'first; an ambiguous match is left unresolved rather than guessed',
      },
      caps: CAPS,
      capsThatBit,
      capRule: describeCaps(capsThatBit),
      inlineLimitNote: INLINE_LIMIT_NOTE,
    });
  },
);

// ─── The read scope, shared by the three reads ──────────────────────────────

const scopeQuery = {
  /** Which commit to read. Default: the newest upload, whatever commit it is at. */
  commitSha: commitShaSchema.optional(),
  runId: z.string().trim().min(1).max(200).optional(),
  testId: z.string().trim().min(1).max(200).optional(),
};

/** The upload every read answers from, or a 404 that says what was looked for. */
async function uploadForRead(
  store: CodeCoverageStore,
  projectId: string,
  scope: { commitSha?: string; runId?: string; testId?: string },
) {
  const upload = await store.findNewestUpload({
    where: {
      projectId,
      ...(scope.commitSha ? { commitSha: scope.commitSha.toLowerCase() } : {}),
      ...(scope.runId ? { runId: scope.runId } : {}),
      ...(scope.testId ? { testId: scope.testId } : {}),
    },
    select: {
      id: true,
      commitSha: true,
      runId: true,
      testId: true,
      variantKey: true,
      format: true,
      generatedAt: true,
      createdAt: true,
      fileCount: true,
      mappedFileCount: true,
      unmappedFileCount: true,
      notInSourceTreeCount: true,
      linesFound: true,
      linesCovered: true,
      branchesFound: true,
      branchesCovered: true,
      caps: true,
    },
  });
  if (!upload) {
    throw notFound(
      'Line coverage for this project' +
        (scope.commitSha || scope.runId || scope.testId ? ' at that scope' : ''),
    );
  }
  return upload;
}

/** The header every read repeats, so a number is never quoted without its scope. */
function uploadHeader(upload: Awaited<ReturnType<typeof uploadForRead>>) {
  return {
    uploadId: upload.id,
    commitSha: upload.commitSha,
    runId: upload.runId,
    testId: upload.testId,
    variantKey: upload.variantKey,
    format: upload.format,
    generatedAt: upload.generatedAt.toISOString(),
    ingestedAt: upload.createdAt.toISOString(),
    totals: {
      files: upload.fileCount,
      mapped: upload.mappedFileCount,
      unmapped: upload.unmappedFileCount,
      notInSourceTree: upload.notInSourceTreeCount,
      linesFound: upload.linesFound,
      linesCovered: upload.linesCovered,
      branchesFound: upload.branchesFound,
      branchesCovered: upload.branchesCovered,
      linePercent: percentOf(upload.linesCovered, upload.linesFound),
      branchPercent: percentOf(upload.branchesCovered, upload.branchesFound),
    },
    /** The caps that bit WHEN THIS WAS INGESTED, carried forward. */
    ingestCapsThatBit: upload.caps,
  };
}

// ─── GET /code-coverage/:projectId/files ────────────────────────────────────

const filesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(CAPS.pageMax).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    /**
     * `z.enum` and not `z.coerce.boolean()`, which reads the string "false" as
     * `true` — so `?withGapsOnly=false` would silently return only the files
     * with gaps and a reader would conclude every file is uncovered.
     */
    withGapsOnly: z.enum(['true', 'false']).optional(),
    inSourceTree: z.enum(['true', 'false']).optional(),
    mapped: z.enum(['true', 'false']).optional(),
    order: z.enum(['GAPS', 'PATH']).optional(),
    ...scopeQuery,
  })
  .strict();

codeCoverageRouter.get(
  '/code-coverage/:projectId/files',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = filesQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
    const query = parsed.data;
    const project = await projectOr404(String(req.params.projectId));
    const store = requireStore();
    const upload = await uploadForRead(store, project.id, query);

    const where: FileFilter = {
      uploadId: upload.id,
      ...(query.withGapsOnly === 'true' ? { withGapsOnly: true } : {}),
      ...(query.inSourceTree === undefined ? {} : { inSourceTree: query.inSourceTree === 'true' }),
      ...(query.mapped === undefined ? {} : { mapped: query.mapped === 'true' }),
    };
    const limit = query.limit ?? CAPS.pageDefault;
    const offset = query.offset ?? 0;

    const [rows, total] = await Promise.all([
      store.findFiles({
        where,
        orderBy: query.order ?? 'PATH',
        skip: offset,
        take: limit,
        select: {
          path: true,
          rawPath: true,
          inSourceTree: true,
          mapped: true,
          unmappedReason: true,
          linesFound: true,
          linesCovered: true,
          branchesFound: true,
          branchesCovered: true,
          uncoveredLineCount: true,
          uncoveredBranchCount: true,
        },
      }),
      store.countFiles({ where }),
    ]);

    res.json({
      ...uploadHeader(upload),
      files: rows.map((row) => ({
        ...row,
        unmappedReasonText: row.unmappedReason ? UNMAPPED_REASONS[row.unmappedReason] : null,
        /* Null, not 0, on an unmapped file — the whole rule, per row. */
        linePercent: percentOf(row.linesCovered, row.linesFound),
        branchPercent: percentOf(row.branchesCovered, row.branchesFound),
      })),
      /* `total` is the full number whatever the page holds. */
      total,
      offset,
      limit,
      truncated: offset + rows.length < total,
      pageRule:
        'a page shorter than `limit` does not mean the list is exhausted; `total` is the whole ' +
        'count and `offset` pages on',
      caps: CAPS,
    });
  },
);

// ─── GET /code-coverage/:projectId/uncovered ────────────────────────────────

const uncoveredQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(CAPS.pageMax).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    inSourceTree: z.enum(['true', 'false']).optional(),
    ...scopeQuery,
  })
  .strict();

/**
 * "Which lines and branches of which files is nothing executing?" — ranked.
 *
 * Ranked by UNCOVERED LINE COUNT, descending, and nothing cleverer. There is a
 * risk weighting this could apply and it is deliberately not applied here: the
 * declared criticality a customer owns lives on `Project.coverageConfig`, and
 * a ranking that mixed a stored weight with one this file invented would be
 * unexplainable at exactly the moment somebody disagrees with it. A count is
 * arguable from the row beside it.
 *
 * UNMAPPED FILES ARE EXCLUDED from this list, because the list's whole job is
 * to name a file and a line a reviewer can open and an unmapped file has no
 * line to name. They are not hidden: the count is in the header and in
 * `excluded` below.
 */
codeCoverageRouter.get(
  '/code-coverage/:projectId/uncovered',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = uncoveredQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
    const query = parsed.data;
    const project = await projectOr404(String(req.params.projectId));
    const store = requireStore();
    const upload = await uploadForRead(store, project.id, query);

    const where: FileFilter = {
      uploadId: upload.id,
      withGapsOnly: true,
      mapped: true,
      ...(query.inSourceTree === undefined ? {} : { inSourceTree: query.inSourceTree === 'true' }),
    };
    const limit = query.limit ?? CAPS.pageDefault;
    const offset = query.offset ?? 0;

    const [rows, total] = await Promise.all([
      store.findFiles({
        where,
        orderBy: 'GAPS',
        skip: offset,
        take: limit,
        select: {
          path: true,
          rawPath: true,
          inSourceTree: true,
          linesFound: true,
          linesCovered: true,
          uncoveredLineCount: true,
          uncoveredLines: true,
          uncoveredLinesTruncated: true,
          uncoveredBranchCount: true,
          uncoveredBranches: true,
          uncoveredBranchesTruncated: true,
        },
      }),
      store.countFiles({ where }),
    ]);

    res.json({
      ...uploadHeader(upload),
      ranking: 'uncoveredLineCount descending, then path ascending',
      rankingNote:
        'a count and not a risk score: the declared criticality a customer owns is not read ' +
        'here, so every position in this list is arguable from the row beside it',
      files: rows.map((row) => ({
        path: row.path,
        rawPath: row.rawPath,
        inSourceTree: row.inSourceTree,
        linesFound: row.linesFound,
        linesCovered: row.linesCovered,
        linePercent: percentOf(row.linesCovered, row.linesFound),
        uncoveredLineCount: row.uncoveredLineCount,
        uncoveredLines: row.uncoveredLines,
        /*
         * The two facts a reader needs to not misread the array: whether it is
         * the whole list, and what the whole list's length is.
         */
        uncoveredLinesListed: row.uncoveredLines.length,
        uncoveredLinesTruncated: row.uncoveredLinesTruncated,
        uncoveredBranchCount: row.uncoveredBranchCount,
        uncoveredBranches: row.uncoveredBranches,
        uncoveredBranchesTruncated: row.uncoveredBranchesTruncated,
      })),
      total,
      offset,
      limit,
      truncated: offset + rows.length < total,
      excluded: {
        unmappedFiles: upload.unmappedFileCount,
        rule:
          'unmapped files cannot name a line, so they are not in this list. They are IN the ' +
          'header’s file count and they are not counted as covered anywhere.',
      },
      caps: CAPS,
      listCaps: {
        uncoveredLinesPerFile: CAPS.uncoveredLinesPerFile,
        uncoveredBranchesPerFile: CAPS.uncoveredBranchesPerFile,
        rule:
          '`uncoveredLines` is capped per file and `uncoveredLineCount` is not. Read the count ' +
          'for arithmetic and the array for navigation.',
      },
    });
  },
);

// ─── POST /code-coverage/:projectId/patch ───────────────────────────────────

const patchBody = z.object({
  /**
   * The diff, as a PR gate has it: the lines this change ADDED or CHANGED, per
   * path. Deleted lines are deliberately absent — a line that is gone cannot be
   * covered and counting it would make deleting dead code lower your patch
   * coverage.
   */
  changed: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(1_000),
        lines: z.array(z.number().int().min(1)),
      }),
    )
    .min(1),
  /**
   * True when the caller could not read the whole diff. An incomplete diff
   * cannot produce a trustworthy denominator, and the caller is the only party
   * who knows — the same field, for the same reason, as
   * `patchCoverage({ diffTruncated })` in lib/impact.ts.
   */
  diffTruncated: z.boolean().default(false),
  ...scopeQuery,
});

/**
 * PATCH COVERAGE — "you changed 40 lines and 9 of them are executed by nothing".
 *
 * ── Why this is a POST that writes nothing ──────────────────────────────────
 *
 * Because the diff is the input and a diff does not fit in a query string. Same
 * shape as POST /impact/analyze, which also computes and stores nothing.
 *
 * ── The three buckets, and why the third is not folded into the second ──────
 *
 *   covered       a changed line the upload says was executed
 *   uncovered     a changed line the upload says was not
 *   notMeasured   a changed line in a file this upload has no row for, or has
 *                 an UNMAPPED row for
 *
 * `notMeasured` is kept out of the denominator and never counted as uncovered,
 * which is the same judgement `NOT_IN_INVENTORY` records in `PatchCoverage`: a
 * file with no coverage row is usually a file the coverage run did not
 * instrument — a config, a migration, a generated client — and calling those
 * untested lines would make every PR fail the gate for reasons nobody can act
 * on. It is also, honestly, the bucket that can hide a real problem, so it is
 * reported as a count, with the paths named, and `measured` is false when it is
 * the ONLY bucket with anything in it.
 */
codeCoverageRouter.post(
  '/code-coverage/:projectId/patch',
  requireScope('tests:read'),
  async (req, res) => {
    const parsed = patchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body', {
        fieldErrors: parsed.error.flatten().fieldErrors,
      });
    }
    const body = parsed.data;
    const project = await projectOr404(String(req.params.projectId));
    const store = requireStore();

    /*
     * The diff caps REFUSE. A truncated diff makes patch coverage meaningless
     * in the flattering direction — the lines that did not fit are the ones
     * that would have failed the gate — and lib/impact.ts refuses for the same
     * reason rather than reporting a percentage of what it managed to read.
     */
    if (body.diffTruncated) {
      throw unprocessable(
        'The caller reported the diff as truncated, so the changed-line denominator is ' +
          'incomplete. Refused rather than answered: the lines that did not fit are exactly the ' +
          'ones a gate would have caught.',
        { diffTruncated: true },
      );
    }
    if (body.changed.length > CAPS.patchPaths) {
      throw unprocessable(
        `That diff names ${body.changed.length} paths and the limit is ${CAPS.patchPaths}. ` +
          'Refused rather than cut, for the reason above.',
        {
          caps: CAPS,
          capsThatBit: [
            {
              cap: 'patchPaths',
              limit: CAPS.patchPaths,
              droppedAtLeast: body.changed.length - CAPS.patchPaths,
            },
          ],
        },
      );
    }
    const overLongPath = body.changed.find((entry) => entry.lines.length > CAPS.patchLinesPerPath);
    if (overLongPath) {
      throw unprocessable(
        `${overLongPath.path} carries ${overLongPath.lines.length} changed lines and the limit ` +
          `is ${CAPS.patchLinesPerPath}. Refused rather than cut, for the reason above.`,
        {
          caps: CAPS,
          capsThatBit: [
            {
              cap: 'patchLinesPerPath',
              limit: CAPS.patchLinesPerPath,
              droppedAtLeast: overLongPath.lines.length - CAPS.patchLinesPerPath,
            },
          ],
        },
      );
    }

    const upload = await uploadForRead(store, project.id, body);

    /*
     * The diff's paths, resolved against the source tree the SAME WAY the
     * payload's were. Both sides have to pass through one resolver or they
     * cannot meet: a diff says `src/billing.ts` and a payload said
     * `/home/runner/work/app/app/src/billing.ts`, and only a shared
     * normalisation makes those the same file.
     */
    const tree = await sourceTreeOf(project.id);
    const byResolvedPath = new Map<string, { declared: string; lines: Set<number> }>();
    for (const entry of body.changed) {
      const resolved = resolveAgainstTree(entry.path, tree.index);
      const existing = byResolvedPath.get(resolved.path);
      if (existing) {
        for (const line of entry.lines) existing.lines.add(line);
      } else {
        byResolvedPath.set(resolved.path, { declared: entry.path, lines: new Set(entry.lines) });
      }
    }

    const rows = await store.findFilesByPath({
      where: { uploadId: upload.id, paths: [...byResolvedPath.keys()] },
      select: {
        path: true,
        mapped: true,
        unmappedReason: true,
        uncoveredLines: true,
        uncoveredLinesTruncated: true,
        linesFound: true,
      },
    });
    const rowByPath = new Map(rows.map((row) => [row.path, row]));

    let covered = 0;
    let uncovered = 0;
    let notMeasuredLines = 0;
    const caveats: string[] = [];
    const perFile: Array<{
      path: string;
      declaredPath: string;
      changedLines: number;
      covered: number;
      uncovered: number;
      notMeasured: number;
      percent: number | null;
      uncoveredLines: number[];
      state: 'MEASURED' | 'UNMAPPED' | 'NO_COVERAGE_ROW' | 'LIST_TRUNCATED';
    }> = [];

    for (const [path, entry] of byResolvedPath) {
      const row = rowByPath.get(path);
      const changedLines = [...entry.lines].sort((a, b) => a - b);

      if (!row || !row.mapped) {
        notMeasuredLines += changedLines.length;
        perFile.push({
          path,
          declaredPath: entry.declared,
          changedLines: changedLines.length,
          covered: 0,
          uncovered: 0,
          notMeasured: changedLines.length,
          /* Null, not 0: no measurement to divide. */
          percent: null,
          uncoveredLines: [],
          state: !row ? 'NO_COVERAGE_ROW' : 'UNMAPPED',
        });
        continue;
      }

      /*
       * THE ONE PLACE A TRUNCATED LIST WOULD HAVE LIED.
       *
       * Patch coverage asks "is line 412 uncovered?", and the only per-line
       * evidence stored is `uncoveredLines`, which is capped. If that cap bit
       * for this file, absence from the array does NOT mean the line is
       * covered — it may simply be past the cap — and answering "covered" would
       * be the exact forbidden shape: a cap biting unreported, in the
       * flattering direction, on the number a PR gate blocks on. So the file is
       * NOT MEASURED, with its own state, and the caveat names it.
       */
      if (row.uncoveredLinesTruncated) {
        notMeasuredLines += changedLines.length;
        perFile.push({
          path,
          declaredPath: entry.declared,
          changedLines: changedLines.length,
          covered: 0,
          uncovered: 0,
          notMeasured: changedLines.length,
          percent: null,
          uncoveredLines: [],
          state: 'LIST_TRUNCATED',
        });
        caveats.push(
          `${path}: the stored uncovered-line list hit the ${CAPS.uncoveredLinesPerFile}-line ` +
            'cap, so absence from it is not evidence a line is covered. This file’s changed ' +
            'lines are NOT MEASURED rather than counted as covered.',
        );
        continue;
      }

      /*
       * COVERED IS INFERRED FROM ABSENCE, AND THAT INFERENCE CAN BE WRONG.
       *
       * `uncoveredLines` is the only per-line evidence stored, so a changed line
       * is called covered because it is NOT in that list. A line with nothing
       * coverable on it is not in that list either. On an ISTANBUL upload, where
       * the statement map is the authority, a changed comment, blank line or
       * closing brace has no statement, never appears, and is counted here as
       * COVERED: six changed lines of which three carry no statement come back
       * 4 covered / 2 uncovered — 66.7% — where the executable truth is 1 of 3.
       *
       * It is disclosed rather than corrected because correcting it needs the
       * COVERED (or found) line list stored per file, which is a column on a
       * table that is not in schema.prisma yet. Disclosed is survivable;
       * silent was not, and `denominatorRule` alone read as though every line
       * in the denominator had been measured. `coveredRule` on the response and
       * the caveat below are that disclosure, and the count travels with it so
       * a reader can see how much of their number rests on the inference.
       */
      const uncoveredSet = new Set(row.uncoveredLines);
      let fileCovered = 0;
      let fileUncovered = 0;
      const fileUncoveredLines: number[] = [];
      for (const line of changedLines) {
        if (uncoveredSet.has(line)) {
          fileUncovered += 1;
          fileUncoveredLines.push(line);
        } else {
          fileCovered += 1;
        }
      }
      covered += fileCovered;
      uncovered += fileUncovered;
      perFile.push({
        path,
        declaredPath: entry.declared,
        changedLines: changedLines.length,
        covered: fileCovered,
        uncovered: fileUncovered,
        notMeasured: 0,
        percent: percentOf(fileCovered, fileCovered + fileUncovered),
        uncoveredLines: fileUncoveredLines,
        state: 'MEASURED',
      });
    }

    const denominator = covered + uncovered;
    /*
     * `measured` is the field a gate rule must read before it reads `percent`.
     * False means "we did not check", and a gate that reported PASS off a false
     * `measured` would be the single worst defect this endpoint could ship:
     * a green PR check that checked nothing.
     */
    const measured = denominator > 0;
    if (!measured) {
      caveats.unshift(
        notMeasuredLines > 0
          ? `none of the ${notMeasuredLines} changed line(s) is in a file this upload measured, ` +
              'so there is nothing to divide. This is UNMEASURED and not 0%.'
          : 'the diff named no lines, so there is nothing to divide.',
      );
    }
    if (covered > 0) {
      /*
       * The inference, counted. See the loop above: this many changed lines are
       * in the numerator because they are ABSENT from a stored uncovered-line
       * list, which is also where a line with nothing coverable on it sits.
       */
      caveats.push(
        `${covered} of the ${denominator} changed line(s) are counted as covered because they ` +
          'are absent from the stored uncovered-line list. A changed line with nothing coverable ' +
          `on it is absent too — on an ${upload.format} upload that is any line the dialect ` +
          'placed no statement or range on — so this figure is an upper bound on the executable ' +
          'lines of this diff that ran.',
      );
    }
    if (upload.unmappedFileCount > 0) {
      caveats.push(
        `${upload.unmappedFileCount} file(s) in the upload this is computed from are UNMAPPED, ` +
          'so a changed line in one of them is not measured either way.',
      );
    }
    if (tree.snapshotId === null) {
      caveats.push(
        'no CodebaseSnapshot exists for this project, so neither the diff’s paths nor the ' +
          'payload’s were resolved to repo-relative paths; they matched only if the two sides ' +
          'already spelled them the same way.',
      );
    }

    const listed = perFile
      .slice()
      .sort((a, b) => b.uncovered - a.uncovered || a.path.localeCompare(b.path))
      .slice(0, CAPS.patchFilesListed);
    const capsThatBit: CapHit[] =
      perFile.length > CAPS.patchFilesListed
        ? [
            {
              cap: 'patchFilesListed',
              limit: CAPS.patchFilesListed,
              droppedAtLeast: perFile.length - CAPS.patchFilesListed,
            },
          ]
        : [];

    res.json({
      ...uploadHeader(upload),
      patch: {
        /* Counts, so the division is checkable by hand. */
        denominator,
        covered,
        uncovered,
        notMeasured: notMeasuredLines,
        percent: percentOf(covered, denominator),
        measured,
        measuredRule:
          'read `measured` before `percent`. False means this endpoint did not check, and a ' +
          'gate must report UNMEASURED rather than treat it as 0%.',
        denominatorRule:
          'the denominator is changed lines in files this upload MEASURED. Lines in files with ' +
          'no coverage row, with an unmapped row, or whose stored uncovered-line list was ' +
          'capped are counted in `notMeasured` and are in NO percentage.',
        coveredRule:
          'a changed line is counted covered by ABSENCE from the stored uncovered-line list, ' +
          'which is the only per-line evidence this upload holds. A changed line with nothing ' +
          'coverable on it — no statement in an Istanbul map, no range in a V8 payload: a ' +
          'comment, a blank line, a closing brace — is absent for that reason instead, and is ' +
          'counted covered too. So `covered` and `percent` are an UPPER BOUND on the executable ' +
          'changed lines that ran, not a measurement of them. Storing the covered-line list per ' +
          'file is what would make this exact.',
      },
      files: listed,
      filesTotal: perFile.length,
      filesListed: listed.length,
      caveats,
      caps: CAPS,
      capsThatBit,
      capRule: describeCaps(capsThatBit),
    });
  },
);
