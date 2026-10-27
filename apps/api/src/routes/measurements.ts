/**
 * The READ side of the measurement tables — the doors `TestResultVariant` and
 * `TestMetricSample` were shipped without.
 *
 * ── The defect, stated plainly ──────────────────────────────────────────────
 *
 * The slice before this one added two tables, four indexes and a validated
 * shape for every reading a plugin can produce, and then stopped. Nothing in
 * the repo selected a row out of either of them. A model with no reader is a
 * schema entry for a feature that does not exist: `@@index([projectId, name,
 * createdAt])` was written for a trend query that had no caller, and
 * `@@index([runId, status])` was written for a matrix view that had no
 * endpoint. `scripts/check-wiring.ts` reported both as DISCONNECTED and it was
 * right to.
 *
 * This router is those two reads and nothing else. It writes no row, computes
 * no score and invents no cell.
 *
 *   GET /measurements/:projectId/matrix         the variant matrix
 *   GET /measurements/:projectId/metrics        one metric's trend
 *   GET /measurements/:projectId/metrics/names  which metric names exist
 *
 * ── THE ONE RULE THE WHOLE FILE TURNS ON ────────────────────────────────────
 *
 * A measurement that was not taken is never reported as a measurement. That
 * splits into three concrete refusals, each of which has a test:
 *
 *   A CELL NOBODY REPORTED IS NOT A CELL. The matrix emits the combinations a
 *   runner actually reported and never the cartesian product of the dimension
 *   values it saw. Five browsers × three viewports is fifteen cells only if
 *   somebody ran fifteen cells; multiplying the dimension counts would
 *   manufacture a denominator nobody measured, and every percentage over it
 *   would be a number about an imaginary matrix. So `unreportedCells` is NULL
 *   with a sentence saying why, not 0 and not a product.
 *
 *   A NULL READING STAYS A NULL POINT. `TestMetricSample.value` is nullable
 *   because "we tried and could not measure it" is a different fact from zero,
 *   and for every metric this product collects the two are opposite signals: an
 *   LCP of 0 ms is a page that painted instantly, a p95 of 0 is a load test
 *   that never ran, a visual diff ratio of 0 is a pixel-perfect match. A trend
 *   chart that plots an unavailable reading at 0 draws the best possible result
 *   where the truth is a blind spot. So a null point travels as `value: null`
 *   carrying its `unavailableReason`, and `measured` and `unavailable` are two
 *   separate counts that this file never adds together.
 *
 *   AN UNKNOWN FILTER IS A 400. `?status=ERROR` answering `[]` reads as
 *   "nothing failed", which is the most dangerous wrong answer either of these
 *   endpoints can give. Every query object is `.strict()` for the same reason
 *   one level up: a misspelt filter NAME that is quietly ignored reads as "no
 *   filter was applied", and the caller gets a wider answer than the one they
 *   asked about with nothing to tell them.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DECIDE ─────────────────────────────
 *
 * The encoding of `TestMetricSample.variantKey`. That string is the WRITER's,
 * and this reader only echoes it — the cell filter below is expressed in the
 * five columns `TestResultVariant` actually has, resolved through the relation,
 * so no second vocabulary for one key can come into existence here. Two halves
 * of a composite key invented in two files is how they come to disagree.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  METRIC_DIRECTIONS,
  METRIC_UNITS,
  TEST_RESULT_STATUSES,
  UNVARIED,
  testMetricSchema,
  testVariantKeySchema,
  type MetricDirection,
  type MetricUnit,
  type NotRunKind,
  type TestResultStatus,
} from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ApiError, badRequest, notFound } from '../lib/errors.js';
import { requireAuth, requireScope } from '../middleware/auth.js';

export const measurementsRouter: Router = Router();

measurementsRouter.use(requireAuth);

// ─── Caps, every one of which is reported ───────────────────────────────────

/**
 * The caps this router applies.
 *
 * Returned WHOLE on every response rather than only the entries that bit,
 * copying `CODE_COVERAGE_CAPS` in code-coverage.ts: the entire value of a
 * disclosed cap is that a reader can see the limit which did NOT bite and know
 * the number beside it is intact.
 */
export const MEASUREMENT_CAPS = {
  /** Cells one matrix page carries. Default, and the ceiling a caller may ask for. */
  matrixCellsDefault: 200,
  matrixCellsMax: 500,
  /**
   * Distinct values reported per dimension. Realistically unreachable — a
   * project has a handful of browsers — and disclosed anyway, because a cap
   * nobody can see is a cap somebody will mistake for the whole set.
   */
  dimensionValuesMax: 100,
  /** Points one trend page carries. */
  seriesPointsDefault: 200,
  seriesPointsMax: 1000,
  /** `(name, unit, direction)` groups one names page carries. */
  nameGroupsDefault: 200,
  nameGroupsMax: 500,
} as const;

const CAPS = MEASUREMENT_CAPS;

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * The project, or a 404 — never a 403.
 *
 * Tenancy is enforced by the Prisma extension, so a project in another org
 * reads as absent, which is exactly the answer `notFound()` gives. A 403 here
 * would turn this endpoint into an existence oracle for other orgs' project
 * ids.
 */
async function projectOr404(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, orgId: true },
  });
  if (!project) throw notFound('Project');
  return project;
}

/**
 * Parses a comma-separated enum list, 400ing on an unknown name.
 *
 * The same shape as `parseList` in routes/surface.ts and routes/api-surface.ts,
 * and copied for the reason stated there: a router importing another router's
 * internals couples their module load order for a nine-line helper.
 *
 * The 400 NAMES THE VALID VALUES, and that is the point of the helper. An
 * unknown filter value answering with an empty list is the worst answer this
 * endpoint has: `?status=ERROR` — a plausible spelling that is not one of the
 * five — reading as "no cell in this project failed" inverts the signal the
 * caller asked for.
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

/** The 400 a zod query failure becomes, with the field errors attached. */
function queryOr400<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', {
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    });
  }
  return parsed.data;
}

/**
 * 503 and the names of the tables, when the migration that declares them has
 * not been applied to this database.
 *
 * ── WHY THIS EXISTS AND WHY IT IS NOT A 500 ─────────────────────────────────
 *
 * The migration for these two tables is written and, on the tree this door was
 * built in, NOT APPLIED — `apps/api/scripts/check-enums.ts` reports 28 declared
 * types the database has never seen. Against such a database Prisma raises
 * P2021 ("the table does not exist") or P2022 ("the column does not exist") and
 * the terminal error handler turns anything that is not an `ApiError` into an
 * opaque 500. A 500 says "we broke". The truth is "this install has not run the
 * migration", which is a deployment gap and says NOTHING about how much of the
 * customer's matrix has been exercised.
 *
 * 503 rather than the 501 the house pattern uses for a missing code dependency,
 * following `storeUnavailable()` in code-coverage.ts verbatim, because the two
 * causes are different and a reader paged by this needs to know which: 501
 * there means "this build has no parser", 503 here means "this database has no
 * table". Neither is ever a 200 carrying an empty list — an empty matrix is a
 * measured claim that a customer's suite has been run in no browser, and
 * manufacturing it out of our own un-applied migration is the exact lie this
 * product cannot afford.
 */
const MEASUREMENT_TABLES = ['TestResultVariant', 'TestMetricSample'] as const;

const schemaUnavailable = (): ApiError =>
  new ApiError(
    503,
    'MEASUREMENT_SCHEMA_UNAVAILABLE',
    'Measurement storage is not available on this deployment: the database has no ' +
      `${MEASUREMENT_TABLES.join('/')} table, so the migration that declares them has not been ` +
      'applied. Nothing was read. This is a deployment gap and says nothing about what your ' +
      'suite has measured.',
    { tables: [...MEASUREMENT_TABLES] },
  );

/**
 * Runs a read and turns "the schema is not there" into {@link schemaUnavailable}.
 *
 * The error codes are duck-typed rather than matched against
 * `PrismaClientKnownRequestError`. Two reasons, and the second is the one that
 * matters: the generated client is re-emitted by `prisma generate` and
 * importing an error class from it to compare `instanceof` couples this file to
 * that output, and a test can produce `{ code: 'P2021' }` but cannot produce an
 * instance of a class whose constructor it has mocked away. A guard no test can
 * reach is a guard that is not there.
 *
 * Nothing is logged. The error carries a table name and no customer data, and a
 * handler that logged it would be one more place a stack trace with a
 * connection string in it could end up.
 */
async function readOrUnavailable<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'P2021' || code === 'P2022') throw schemaUnavailable();
    throw error;
  }
}

/** An id as it arrives in a query string: trimmed, bounded, never empty. */
const idFilter = z.string().trim().min(1).max(200);

/**
 * One variant dimension, as a FILTER.
 *
 * Taken off `testVariantKeySchema`'s own shape and `.unwrap()`ped out of its
 * `.default(UNVARIED)`, so the length bound and the sentinel rule stay in one
 * place — and so that an ABSENT filter stays absent. Keeping the default would
 * turn "the caller did not filter by browser" into "the caller asked for the
 * cells where nobody varied the browser", which is a different and much smaller
 * answer returned under the caller's own question.
 */
const dimensionFilter = {
  browser: testVariantKeySchema.shape.browser.unwrap().optional(),
  viewport: testVariantKeySchema.shape.viewport.unwrap().optional(),
  locale: testVariantKeySchema.shape.locale.unwrap().optional(),
  role: testVariantKeySchema.shape.role.unwrap().optional(),
  environment: testVariantKeySchema.shape.environment.unwrap().optional(),
} as const;

/** The five dimension names, in the order the composite unique index declares them. */
const DIMENSIONS = ['browser', 'viewport', 'locale', 'role', 'environment'] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** One distinct value of one dimension, and how many cells reported it. */
interface DimensionValueCount {
  value: string;
  cells: number;
}

/**
 * The five "how many distinct values did this dimension have" queries, written
 * out one per dimension.
 *
 * NOT a loop over {@link DIMENSIONS} with a computed `by: [dimension]`, and the
 * reason is Prisma's own types rather than taste: `groupBy` correlates `by`,
 * `orderBy` and the result shape through the literal key, so a computed key
 * widens all three to `string` and the call stops being checked at exactly the
 * point where a typo would silently group by the wrong column. Five literal
 * calls cost five lines and keep the correlation.
 */
const DIMENSION_VALUE_COUNTS: Record<
  Dimension,
  (where: Prisma.TestResultVariantWhereInput, take: number) => Promise<DimensionValueCount[]>
> = {
  browser: async (where, take) =>
    (
      await prisma.testResultVariant.groupBy({
        by: ['browser'],
        where,
        _count: { _all: true },
        orderBy: { browser: 'asc' },
        take,
      })
    ).map((row) => ({ value: row.browser, cells: row._count._all })),
  viewport: async (where, take) =>
    (
      await prisma.testResultVariant.groupBy({
        by: ['viewport'],
        where,
        _count: { _all: true },
        orderBy: { viewport: 'asc' },
        take,
      })
    ).map((row) => ({ value: row.viewport, cells: row._count._all })),
  locale: async (where, take) =>
    (
      await prisma.testResultVariant.groupBy({
        by: ['locale'],
        where,
        _count: { _all: true },
        orderBy: { locale: 'asc' },
        take,
      })
    ).map((row) => ({ value: row.locale, cells: row._count._all })),
  role: async (where, take) =>
    (
      await prisma.testResultVariant.groupBy({
        by: ['role'],
        where,
        _count: { _all: true },
        orderBy: { role: 'asc' },
        take,
      })
    ).map((row) => ({ value: row.role, cells: row._count._all })),
  environment: async (where, take) =>
    (
      await prisma.testResultVariant.groupBy({
        by: ['environment'],
        where,
        _count: { _all: true },
        orderBy: { environment: 'asc' },
        take,
      })
    ).map((row) => ({ value: row.environment, cells: row._count._all })),
};

/**
 * A window over `createdAt`, or a 400 when it is inside out.
 *
 * `since` after `until` describes an empty interval, and an empty interval
 * answers `[]` — "this metric has never been measured" — for a project that
 * measures it hourly. A caller who inverted two parameters gets told.
 */
function windowOr400(since: Date | undefined, until: Date | undefined) {
  if (since && until && since.getTime() > until.getTime()) {
    throw badRequest(
      'That window is inside out: `since` is after `until`, which matches no reading at all. ' +
        'An empty answer from an empty window reads as "never measured", so it is refused ' +
        'instead.',
    );
  }
  if (!since && !until) return undefined;
  return {
    ...(since ? { gte: since } : {}),
    ...(until ? { lte: until } : {}),
  };
}

// ─── GET /measurements/:projectId/matrix ────────────────────────────────────

const matrixQuery = z
  .object({
    runId: idFilter.optional(),
    testId: idFilter.optional(),
    /** Comma-separated `TestResultStatus` values. An unknown one is a 400. */
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(CAPS.matrixCellsMax).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/** One reported cell, exactly as the row holds it. */
interface MatrixCell {
  browser: string;
  viewport: string;
  locale: string;
  role: string;
  environment: string;
  status: TestResultStatus;
  durationMs: number;
  errorMessage: string | null;
  /**
   * §5 — a retry that passes is not a pass, per cell as well as per test. It
   * travels as its own flag and is never folded into `status`: a reader asking
   * "is this green?" and a reader asking "is this stable?" want different
   * answers out of the same row.
   */
  retriedAndPassed: boolean;
  /**
   * NULL IS A FIFTH STATE AND IT IS NOT `NOT_RUN`. Passed through untouched —
   * coalescing it to a string would put a claim in the response that no runner
   * made, which is the same defect the column's own doc comment forbids on the
   * way in.
   */
  notRunKind: NotRunKind | null;
  /** Which run reported this cell. See `reporting.perRunRule`. */
  runId: string;
  reportedAt: Date;
}

measurementsRouter.get('/:projectId/matrix', requireScope('tests:read'), async (req, res) => {
  const query = queryOr400(matrixQuery, req.query);
  const project = await projectOr404(String(req.params.projectId));
  const statuses = parseList<TestResultStatus>(query.status, TEST_RESULT_STATUSES, 'status');

  /*
   * `TestResultVariant` carries orgId, runId and testId AND NO projectId, so
   * the tenancy extension's orgId filter is NOT enough on its own: a sibling
   * project inside the same org would answer this request. The project scope
   * therefore goes through the relation, `Test.projectId` being the only
   * column that holds it.
   *
   * Through `test` rather than through `run` deliberately: the response is
   * grouped per test, and scoping on the same row the grouping is keyed by
   * means the two cannot disagree for a run that was imported against one
   * project while its tests belong to another.
   */
  const where: Prisma.TestResultVariantWhereInput = {
    testResult: { test: { projectId: project.id } },
    ...(query.runId ? { runId: query.runId } : {}),
    ...(query.testId ? { testId: query.testId } : {}),
    ...(statuses ? { status: { in: statuses } } : {}),
  };

  const limit = query.limit ?? CAPS.matrixCellsDefault;
  const offset = query.offset ?? 0;

  /*
   * THE FILTERS ARE IN THE `where` AND THE CAP IS A `take`, in that order, so
   * the page is a page of the filtered set and `total` is the size of the
   * filtered set. A cap applied before a filter would page over rows the caller
   * excluded and report a total nobody asked for.
   *
   * Ordered by test first and then by the five dimensions in the order the
   * composite unique declares them, so (a) two calls a second apart page over
   * the same rows and (b) one test's cells are CONTIGUOUS, which is what makes
   * the group-edge disclosure below exact instead of a guess.
   */
  const orderBy: Prisma.TestResultVariantOrderByWithRelationInput[] = [
    { testId: 'asc' },
    { browser: 'asc' },
    { viewport: 'asc' },
    { locale: 'asc' },
    { role: 'asc' },
    { environment: 'asc' },
    { runId: 'asc' },
    { id: 'asc' },
  ];

  const select = {
    id: true,
    testId: true,
    runId: true,
    browser: true,
    viewport: true,
    locale: true,
    role: true,
    environment: true,
    status: true,
    durationMs: true,
    errorMessage: true,
    retriedAndPassed: true,
    notRunKind: true,
    createdAt: true,
  } as const;

  /*
   * ONE row either side of the page, fetched in the same query.
   *
   * Pagination here is over CELLS and the response groups them by test, so a
   * page boundary can fall in the middle of a test's cells — and a group that
   * says "this test has two cells" when it has seven is a cap that bit without
   * being disclosed. With the order above, only the first and last group on a
   * page can be cut, and the row immediately before and after the page is
   * enough to know whether they were. Reading them costs nothing extra: it is
   * the same index scan, two rows wider.
   */
  const probeSkip = offset > 0 ? offset - 1 : 0;
  const probeTake = limit + (offset > 0 ? 2 : 1);

  const [probed, total, dimensionGroups] = await readOrUnavailable(() =>
    Promise.all([
      prisma.testResultVariant.findMany({
        where,
        orderBy,
        skip: probeSkip,
        take: probeTake,
        select,
      }),
      prisma.testResultVariant.count({ where }),
      /*
       * THE DIMENSION VALUES, COUNTED PER DIMENSION AND NEVER MULTIPLIED.
       *
       * "We test one browser thoroughly" and "we test five browsers" are the
       * two readings a matrix has to be able to tell apart, and the cell list
       * alone cannot say it — a page of 200 cells could be one browser or
       * twenty. These are five `groupBy`s over the FILTERED set, so each count
       * describes the whole answer and not the page.
       *
       * One over the cap, so a cap that bit is known rather than guessed at.
       * Their product is NOT returned and must not be computed by a caller:
       * see `reporting.dimensionProductIsNotADenominator`.
       */
      Promise.all(
        DIMENSIONS.map((dimension) =>
          DIMENSION_VALUE_COUNTS[dimension](where, CAPS.dimensionValuesMax + 1),
        ),
      ),
    ]),
  );

  const before = offset > 0 ? (probed[0] ?? null) : null;
  const page = (offset > 0 ? probed.slice(1) : probed).slice(0, limit);
  const after = probed[(offset > 0 ? 1 : 0) + limit] ?? null;

  /*
   * The test NAME, fetched for the page's tests only.
   *
   * A matrix keyed by cuid is not a table a human can read, and the name is the
   * one thing that makes a row identifiable. A separate bounded query rather
   * than a nested select so the page size bounds it; a test id with no row
   * reports `name: null` rather than inventing a label for a test that is no
   * longer there.
   */
  const testIds = [...new Set(page.map((row) => row.testId))];
  const tests = testIds.length
    ? await prisma.test.findMany({
        where: { id: { in: testIds } },
        select: { id: true, name: true, filePath: true },
      })
    : [];
  const testById = new Map(tests.map((test) => [test.id, test]));

  /* Grouped in the page's own order, which is already test-major. */
  const groups: Array<{
    testId: string;
    name: string | null;
    filePath: string | null;
    cellsOnPage: number;
    /** True when a page boundary cut this test's cell list. Read it before counting. */
    cutByPageBoundary: boolean;
    cells: MatrixCell[];
  }> = [];

  for (const row of page) {
    let group = groups.at(-1);
    if (!group || group.testId !== row.testId) {
      const test = testById.get(row.testId);
      group = {
        testId: row.testId,
        name: test?.name ?? null,
        filePath: test?.filePath ?? null,
        cellsOnPage: 0,
        cutByPageBoundary: false,
        cells: [],
      };
      groups.push(group);
    }
    group.cells.push({
      browser: row.browser,
      viewport: row.viewport,
      locale: row.locale,
      role: row.role,
      environment: row.environment,
      /*
       * NO CAST on `status` or `notRunKind`. The Prisma enum and the shared
       * constant are two declarations of one vocabulary — `check:enums` diffs
       * them — and assigning one to the other unasserted is a free compile-time
       * check that they still agree. A cast here would silence exactly the
       * drift that check exists to catch.
       */
      status: row.status,
      durationMs: row.durationMs,
      // Passed through whole. The column is bounded at write time by
      // `testResultVariantSchema` (5 000 chars), so truncating here would be a
      // second, undisclosed cap on a field that already has a disclosed one.
      errorMessage: row.errorMessage,
      retriedAndPassed: row.retriedAndPassed,
      notRunKind: row.notRunKind,
      runId: row.runId,
      reportedAt: row.createdAt,
    });
    group.cellsOnPage += 1;
  }

  const firstGroup = groups[0];
  const lastGroup = groups.at(-1);
  if (firstGroup && before && before.testId === firstGroup.testId) {
    firstGroup.cutByPageBoundary = true;
  }
  if (lastGroup && after && after.testId === lastGroup.testId) {
    lastGroup.cutByPageBoundary = true;
  }

  /** One dimension's distinct values, with the cap that may have hidden some. */
  const dimensions = {} as Record<
    Dimension,
    {
      values: Array<{ value: string; cells: number; unvaried: boolean }>;
      /**
       * Distinct values in `values` above. NOT "on this page of cells" — these
       * counts are over the whole FILTERED set, which is the only scope at
       * which "we test five browsers" is a true sentence. A name implying the
       * page would contradict the query that produced it.
       */
      distinctValuesListed: number;
      truncated: boolean;
      limit: number;
      /** Non-null only when the cap bit, and then it says what it hid. */
      truncatedReason: string | null;
    }
  >;

  DIMENSIONS.forEach((dimension, index) => {
    const rows = dimensionGroups[index] ?? [];
    const truncated = rows.length > CAPS.dimensionValuesMax;
    const kept = truncated ? rows.slice(0, CAPS.dimensionValuesMax) : rows;
    dimensions[dimension] = {
      values: kept.map(({ value, cells }) => {
        return {
          value,
          cells,
          /*
           * Flagged rather than left for a caller to compare against a string
           * literal. '<unvaried>' means NOBODY VARIED THIS DIMENSION, which is
           * a statement about our configuration; on `role`, '<anonymous>' means
           * the test ran as a logged-out visitor, which is a statement about
           * the application — a real answer and not a missing one, so it is
           * deliberately NOT flagged here.
           */
          unvaried: value === UNVARIED,
        };
      }),
      distinctValuesListed: kept.length,
      truncated,
      limit: CAPS.dimensionValuesMax,
      truncatedReason: truncated
        ? `more than ${CAPS.dimensionValuesMax} distinct ${dimension} values were reported; ` +
          `this list is the first ${CAPS.dimensionValuesMax} in ascending order and at least ` +
          '1 more exists'
        : null,
    };
  });

  const returned = page.length;
  const atLeastMore = Math.max(0, total - offset - returned);

  res.json({
    projectId: project.id,
    filters: {
      runId: query.runId ?? null,
      testId: query.testId ?? null,
      status: statuses ?? null,
      /** Named so a 400 and a legitimately empty answer cannot be confused. */
      validStatuses: TEST_RESULT_STATUSES,
    },
    tests: groups,
    cells: {
      onPage: returned,
      /** The whole filtered count, whatever the page holds. */
      total,
      offset,
      limit,
      truncated: offset + returned < total,
      /**
       * What the cap hid, as a count. Zero when nothing was hidden; the pair of
       * this and `truncatedReason` is the disclosure, and neither half is useful
       * alone.
       */
      truncatedBy: atLeastMore,
      truncatedReason:
        atLeastMore > 0
          ? `this page carries ${returned} of ${total} matching cells (limit ${limit}, offset ` +
            `${offset}); at least ${atLeastMore} more existed`
          : null,
    },
    dimensions,
    reporting: {
      /**
       * NULL, NOT 0, AND NOT A PRODUCT. We do not know how many cells were
       * never reported, because nothing in this product holds a declared matrix
       * to subtract the reported cells from. Reporting 0 would claim complete
       * coverage of a matrix nobody defined.
       */
      unreportedCells: null,
      unreportedCellsWhy:
        'every cell below was reported by a runner; QAAI holds no declared matrix to compare ' +
        'against, so the number of combinations that were never run is unknown rather than 0',
      dimensionScope:
        'the per-dimension counts describe every cell matching the filters, not the cells on ' +
        'this page: a 2-cell page can sit under a browser count of 5',
      dimensionProductIsNotADenominator:
        'the per-dimension counts above must not be multiplied together. 5 browsers x 3 ' +
        'viewports is 15 cells only if 15 cells were run; the product is a denominator nobody ' +
        'measured and any percentage over it describes an imaginary matrix',
      skippedIsNotUnreported:
        'a cell with status SKIPPED ran and measured nothing, and a cell that is absent from ' +
        'this response was never reported at all. The two are different answers and only the ' +
        'first one appears here',
      retriedAndPassedRule:
        'a cell with retriedAndPassed true is not a pass; the flag is carried beside the status ' +
        'and never folded into it',
      notRunKindRule:
        'notRunKind null is a fifth state and it is not NOT_RUN; it is returned as null and ' +
        'never coalesced to a string',
      perRunRule:
        'cells are not deduplicated across runs. Without a runId filter the same combination ' +
        'appears once per run that reported it, because two runs of one cell with two statuses ' +
        'are two measurements and merging them would hide one',
      pageRule:
        'pagination is over cells, not tests, so a test group may be cut by a page boundary — ' +
        '`cutByPageBoundary` says which, and `cellsOnPage` counts this page only',
    },
    caps: CAPS,
  });
});

// ─── GET /measurements/:projectId/metrics ───────────────────────────────────

/**
 * The metric NAME, taken off `testMetricSchema`'s own field.
 *
 * Not a copy of its regex. The name is the key `@@index([projectId, name,
 * createdAt])` is sorted on and the key a trend GROUPs by, so the spelling a
 * read accepts and the spelling a write accepts have to be the same spelling or
 * a reading becomes unreachable through the door it was written for. Reusing
 * the field makes that structural instead of a convention.
 *
 * It is also what makes the name safe to echo in the sentences below: it is an
 * identifier, bounded at 120 characters, and it is never written to a log.
 */
const metricNameFilter = testMetricSchema.shape.name;

const metricsQuery = z
  .object({
    name: metricNameFilter,
    testId: idFilter.optional(),
    runId: idFilter.optional(),
    /**
     * Which readings to include. A reading about the whole test has
     * `variantId` NULL and carries the `<unvaried>` sentinel in `variantKey`;
     * a reading about one cell has both. Mixing them on one axis is legitimate
     * and so is asking for either half, but it has to be asked for.
     */
    scope: z.enum(['ALL', 'WHOLE_TEST', 'CELL']).optional(),
    ...dimensionFilter,
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    order: z.enum(['OLDEST_FIRST', 'NEWEST_FIRST']).optional(),
    limit: z.coerce.number().int().min(1).max(CAPS.seriesPointsMax).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

measurementsRouter.get('/:projectId/metrics', requireScope('tests:read'), async (req, res) => {
  /*
   * `name` is required, and the 400 for a missing one is written here rather
   * than left to zod's "expected string, received undefined". A trend with no
   * name is every metric this project has ever recorded on one axis — LCP in
   * milliseconds beside a visual diff ratio — which is a chart that cannot be
   * read and a number that cannot be compared.
   */
  if (req.query.name === undefined) {
    throw badRequest(
      '`name` is required. A trend is a series of one metric: without a name this endpoint ' +
        'would plot every reading in the project on one axis, mixing units. Ask ' +
        'GET /measurements/:projectId/metrics/names for the names that exist.',
    );
  }

  const query = queryOr400(metricsQuery, req.query);
  const project = await projectOr404(String(req.params.projectId));

  const scope = query.scope ?? 'ALL';
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, query[dimension]]).filter(
      ([, value]) => value !== undefined,
    ),
  ) as Partial<Record<Dimension, string>>;
  const hasDimensionFilter = Object.keys(dimensions).length > 0;

  /*
   * A dimension filter asks about a cell, and a whole-test reading belongs to
   * no cell — so the two together match nothing. Answering `[]` would say "this
   * metric has never been measured in Chromium" to a caller who asked a
   * contradictory question, which is a pass that means "we did not check".
   */
  if (hasDimensionFilter && scope === 'WHOLE_TEST') {
    throw badRequest(
      `scope=WHOLE_TEST excludes every reading that belongs to a cell, and ` +
        `${Object.keys(dimensions).join(', ')} is a filter on a cell, so together they match no ` +
        'reading at all. Drop one: scope=CELL filters within cells, scope=ALL includes both.',
      { fieldErrors: { scope: ['contradicts the cell dimension filter'] } },
    );
  }

  const createdAt = windowOr400(query.since, query.until);

  const where: Prisma.TestMetricSampleWhereInput = {
    projectId: project.id,
    name: query.name,
    ...(query.testId ? { testId: query.testId } : {}),
    ...(query.runId ? { runId: query.runId } : {}),
    /*
     * `variantId`, not `variantKey`. The sentinel in `variantKey` is the
     * WRITER's encoding of "no cell" and this reader does not own it; the
     * nullable foreign key says the same thing in a column whose meaning is
     * fixed by the schema.
     */
    ...(scope === 'WHOLE_TEST' ? { variantId: null } : {}),
    ...(scope === 'CELL' ? { variantId: { not: null } } : {}),
    /*
     * The cell filter goes through the RELATION, in the five columns
     * `TestResultVariant` actually has. Spelling a composite `variantKey` here
     * would be this file inventing a second encoding of a key whose first
     * encoding lives in the writer — which is how two halves of one key come to
     * disagree. A relation filter also excludes `variantId: null` rows by
     * construction, which is the correct answer: a whole-test reading is not in
     * any browser.
     */
    ...(hasDimensionFilter ? { variant: dimensions } : {}),
    ...(createdAt ? { createdAt } : {}),
  };

  const limit = query.limit ?? CAPS.seriesPointsDefault;
  const offset = query.offset ?? 0;
  const newestFirst = query.order === 'NEWEST_FIRST';

  const [rows, readings, measured, unavailable, unitGroups] = await readOrUnavailable(() =>
    Promise.all([
      prisma.testMetricSample.findMany({
        where,
        /*
         * `createdAt` then `id`: two readings can share a timestamp to the
         * millisecond — one run writes every cell's reading in one transaction
         * — and an order that is not total pages non-deterministically, which
         * duplicates one point and drops another.
         */
        orderBy: newestFirst
          ? [{ createdAt: 'desc' }, { id: 'desc' }]
          : [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          value: true,
          unavailableReason: true,
          unit: true,
          direction: true,
          variantId: true,
          variantKey: true,
          runId: true,
          testId: true,
          testResultId: true,
          createdAt: true,
        },
      }),
      prisma.testMetricSample.count({ where }),
      /*
       * TWO COUNTS, QUERIED SEPARATELY, AND NOTHING ADDS THEM.
       *
       * `measured` is how many readings produced a number and `unavailable` is
       * how many tried and could not. Their ratio is not a coverage figure and
       * this endpoint computes no percentage from them: "we measured LCP 40
       * times out of 50 attempts" is a statement about our instrumentation, and
       * printing it as a percentage next to coverage percentages invites it to
       * be read as one.
       */
      prisma.testMetricSample.count({ where: { ...where, value: { not: null } } }),
      prisma.testMetricSample.count({ where: { ...where, value: null } }),
      /*
       * The units and directions present across the WHOLE filtered series, not
       * just this page. A series-level unit claimed from a page is a claim about
       * rows nobody looked at.
       */
      prisma.testMetricSample.groupBy({
        by: ['unit', 'direction'],
        where,
        _count: { _all: true },
        /* One object: see the note on the same call in /metrics/names. */
        orderBy: { unit: 'asc', direction: 'asc' },
        /*
         * Bounded by the vocabulary itself. There cannot be more
         * (unit, direction) pairs than the product of the two closed lists, so
         * this `take` is a ceiling that CANNOT bite rather than a cap that
         * might — which is why no cap is disclosed for it. If the database ever
         * holds a unit outside `METRIC_UNITS` the take could cut, and that is
         * exactly the drift `unrecognisedUnits` below reports.
         */
        take: METRIC_UNITS.length * METRIC_DIRECTIONS.length,
      }),
    ]),
  );

  const unitsSeen = unitGroups.map((row) => ({
    unit: String(row.unit),
    direction: String(row.direction),
    readings: row._count._all,
  }));

  /*
   * ONE unit for the series, or NULL and the conflict spelled out.
   *
   * Two plugins recording `http_req_duration_p95` in MILLISECONDS and in
   * SECONDS produce one name and two scales, and a chart that puts both on one
   * axis draws a 60x improvement where nothing changed. So a series whose
   * readings disagree has no unit, and the units it saw are named instead of
   * one of them being picked.
   *
   * A unit the database holds and `METRIC_UNITS` does not know is treated the
   * same way, and that case is not hypothetical here: the enums are declared in
   * two places and `check:enums` exists because they drift. A unit the web app
   * cannot render would otherwise print as a bare number beside numbers that
   * have units, which is the misreading `METRIC_UNITS`' own comment warns about.
   */
  const unrecognisedUnits = [
    ...new Set(
      unitsSeen
        .map((seen) => seen.unit)
        .filter((unit) => !(METRIC_UNITS as readonly string[]).includes(unit)),
    ),
  ];
  const distinctUnits = [...new Set(unitsSeen.map((seen) => seen.unit))];
  const distinctDirections = [...new Set(unitsSeen.map((seen) => seen.direction))];
  const agreedUnit =
    distinctUnits.length === 1 && unrecognisedUnits.length === 0
      ? (distinctUnits[0] as MetricUnit)
      : null;
  const agreedDirection =
    distinctDirections.length === 1 ? (distinctDirections[0] as MetricDirection) : null;

  const returned = rows.length;
  const atLeastMore = Math.max(0, readings - offset - returned);

  res.json({
    projectId: project.id,
    name: query.name,
    filters: {
      testId: query.testId ?? null,
      runId: query.runId ?? null,
      scope,
      cell: hasDimensionFilter ? dimensions : null,
      since: query.since ?? null,
      until: query.until ?? null,
      order: newestFirst ? 'NEWEST_FIRST' : 'OLDEST_FIRST',
    },
    /**
     * The series unit, or null when its readings disagree. `unitsSeen` is the
     * decomposition either way — a single-unit series reports the same unit
     * there, so a caller never has to branch to find out what it is made of.
     */
    unit: agreedUnit,
    direction: agreedDirection,
    unitsSeen,
    unitConflict:
      agreedUnit === null && readings > 0
        ? `this series mixes ${distinctUnits.join(', ')}; it has no single unit and must not be ` +
          'plotted on one axis'
        : null,
    unrecognisedUnits,
    /**
     * A NULL READING IS A NULL POINT. `value` stays null and
     * `unavailableReason` says why — the reason is required by
     * `testMetricSchema` exactly when the value is absent, so a null point here
     * always carries one.
     */
    points: rows.map((row) => ({
      at: row.createdAt,
      value: row.value,
      unavailableReason: row.unavailableReason,
      /** False means this point has no number. It does not mean the number is 0. */
      measured: row.value !== null,
      unit: row.unit,
      direction: row.direction,
      runId: row.runId,
      testId: row.testId,
      testResultId: row.testResultId,
      /**
       * Echoed as stored, never parsed. The composition of this string belongs
       * to the writer; `variantId` is the join and `cell` below is the readable
       * form, resolved from the variant row rather than from this string.
       */
      variantKey: row.variantKey,
      variantId: row.variantId,
    })),
    counts: {
      /** Readings matching the filters, measured and unavailable together. */
      readings,
      /** Produced a number. */
      measured,
      /** Tried and could not. Each one carries its own reason on its point. */
      unavailable,
      onPage: returned,
      noPercentage:
        'measured and unavailable are two counts and this endpoint does not divide them. The ' +
        'ratio describes our instrumentation, not the customer’s coverage, and printing it ' +
        'as a percentage beside coverage percentages invites it to be read as one',
    },
    page: {
      offset,
      limit,
      truncated: offset + returned < readings,
      truncatedBy: atLeastMore,
      truncatedReason:
        atLeastMore > 0
          ? `this page carries ${returned} of ${readings} matching readings (limit ${limit}, ` +
            `offset ${offset}); at least ${atLeastMore} more existed`
          : null,
    },
    /**
     * THE EXPLICIT STATEMENT, and the reason this endpoint cannot answer an
     * unknown name with a quiet `[]`. An empty series is the absence of a
     * measurement; a 0-valued point would be a measurement of zero, and for
     * every metric this product collects those are opposite claims.
     */
    empty:
      readings === 0
        ? {
            why:
              `No readings are stored under the metric name "${query.name}" for this project ` +
              'with these filters.',
            statement:
              'This is the absence of a measurement, not a measurement of zero: no point is ' +
              'emitted and no value is inferred. Check the name against ' +
              'GET /measurements/:projectId/metrics/names before concluding the metric is flat.',
          }
        : null,
    caps: CAPS,
  });
});

// ─── GET /measurements/:projectId/metrics/names ─────────────────────────────

const namesQuery = z
  .object({
    testId: idFilter.optional(),
    runId: idFilter.optional(),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(CAPS.nameGroupsMax).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * What names exist, so a caller never has to guess one.
 *
 * The trend endpoint above refuses to invent a point for a name it has never
 * seen, which means a caller who misspells a name gets a correct empty answer
 * and no way to tell it from a metric that stopped being collected. This is
 * that way: the names, with how many readings each has and how many of them
 * produced a number.
 */
measurementsRouter.get(
  '/:projectId/metrics/names',
  requireScope('tests:read'),
  async (req, res) => {
    const query = queryOr400(namesQuery, req.query);
    const project = await projectOr404(String(req.params.projectId));
    const createdAt = windowOr400(query.since, query.until);

    const where: Prisma.TestMetricSampleWhereInput = {
      projectId: project.id,
      ...(query.testId ? { testId: query.testId } : {}),
      ...(query.runId ? { runId: query.runId } : {}),
      ...(createdAt ? { createdAt } : {}),
    };

    const limit = query.limit ?? CAPS.nameGroupsDefault;
    const offset = query.offset ?? 0;

    /*
     * Grouped by `(name, unit, direction)` and not by `name` alone, because a
     * name recorded in two units is the one thing a caller most needs to see
     * BEFORE they chart it — and the trend endpoint reports that conflict
     * anyway, so a names list that hid it would disagree with the next request.
     *
     * `_count: { _all, value }` is two numbers out of one scan: `_all` counts
     * the rows and `value` counts the rows whose value is NOT NULL, which is
     * precisely `measured`. `unavailable` is the difference — the one
     * subtraction in this file, and it is within a single denominator.
     */
    const groups = await readOrUnavailable(() =>
      prisma.testMetricSample.groupBy({
        by: ['name', 'unit', 'direction'],
        where,
        _count: { _all: true, value: true },
        /*
         * One `orderBy` OBJECT, not an array of three. Prisma's `groupBy`
         * correlates `by` with `orderBy` through the literal keys, and the
         * array form widens the element type to a union — which it then reports
         * as a field missing from `by`. One object orders by the same three
         * columns in the same order.
         */
        orderBy: { name: 'asc', unit: 'asc', direction: 'asc' },
        skip: offset,
        take: limit + 1,
      }),
    );

    const truncated = groups.length > limit;
    const kept = truncated ? groups.slice(0, limit) : groups;

    const names: Array<{
      name: string;
      readings: number;
      measured: number;
      unavailable: number;
      units: Array<{
        unit: string;
        direction: string;
        readings: number;
        measured: number;
        unavailable: number;
      }>;
      /** True when the group cap cut this name's unit breakdown. */
      cutByPageBoundary: boolean;
    }> = [];

    for (const group of kept) {
      /*
       * `_count.value` is the count of rows whose `value` is NOT NULL, which is
       * the definition of `measured`. The subtraction below is the only one in
       * this file and it stays inside one denominator: these are two counts of
       * the same group of rows, not two denominators being reconciled.
       */
      const readings = group._count._all;
      const measured = group._count.value;
      const entry = {
        unit: group.unit,
        direction: group.direction,
        readings,
        measured,
        unavailable: readings - measured,
      };
      let bucket = names.at(-1);
      if (!bucket || bucket.name !== group.name) {
        bucket = {
          name: group.name,
          readings: 0,
          measured: 0,
          unavailable: 0,
          units: [],
          cutByPageBoundary: false,
        };
        names.push(bucket);
      }
      bucket.units.push(entry);
      bucket.readings += entry.readings;
      bucket.measured += entry.measured;
      bucket.unavailable += entry.unavailable;
    }

    /*
     * The cap cuts the GROUP list, and a name's totals here are summed over the
     * groups on this page — so a name straddling the boundary is understated.
     * With the order above only the first and last name can be, and both are
     * knowable without another query: the first when `offset > 0` (the group
     * before the page may share its name) and the last when the list is
     * truncated (the group after it may).
     */
    const first = names[0];
    const last = names.at(-1);
    if (first && offset > 0) first.cutByPageBoundary = true;
    if (last && truncated) {
      const next = groups[limit];
      if (next && next.name === last.name) last.cutByPageBoundary = true;
    }

    res.json({
      projectId: project.id,
      filters: {
        testId: query.testId ?? null,
        runId: query.runId ?? null,
        since: query.since ?? null,
        until: query.until ?? null,
      },
      names,
      page: {
        /** `(name, unit, direction)` groups on this page, not names. */
        groupsOnPage: kept.length,
        offset,
        limit,
        truncated,
        truncatedReason: truncated
          ? `more than ${limit} (name, unit, direction) groups matched; this page is the first ` +
            `${limit} in ascending order and at least 1 more existed. Page on with offset=` +
            `${offset + limit}`
          : null,
        /**
         * Deliberately absent: a total group count would cost a second scan of
         * the same index for a number this list does not need. `truncated` plus
         * `truncatedReason` is the disclosure, and neither claims a total.
         */
        total: null,
      },
      reporting: {
        measuredIsNotAPercentage:
          'readings, measured and unavailable are three counts. unavailable is readings minus ' +
          'measured within one denominator; none of the three is divided by another here',
        cutRule:
          'a name whose cutByPageBoundary is true has its readings counted over this page only ' +
          'and is understated; page on before trusting its totals',
      },
      caps: CAPS,
    });
  },
);
