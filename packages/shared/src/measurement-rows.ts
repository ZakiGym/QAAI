/*
 * THE ONE ROW BUILDER BOTH RESULT-INGEST PATHS CALL.
 *
 * There are TWO result-ingest paths — the on-prem agent's
 * `POST /runners/agent/jobs/:jobId/results` and the cloud worker's own loop —
 * and a customer's matrix must not depend on which runner they happen to use.
 * One copy of the row builder is the only way to guarantee that, and it cannot
 * live in either workspace: the worker must not import an express router and
 * the API must not import the worker's BullMQ context. So it lives here, and
 * both of them import it.
 *
 * It was duplicated byte for byte in those two files for one slice, pinned by a
 * test that read both off disk, because this file was not writable in the round
 * that built it. The pin and the duplication are gone; this module is the pin.
 *
 * That property is also why the FIVE HONESTY COLUMNS — `matrixCell`,
 * `cellStatus`, `cellRemedy`, `notAsserted` and `notAssertedReason` — are
 * written here rather than in either caller. They were added, schema'd and
 * refined by one round and then written by nobody, so a pass with a hole in it
 * was indistinguishable from a pass. A writer in one ingest path only would have
 * been worse than none: a customer's holes would depend on which runner they
 * happen to use.
 *
 * NOTHING IN HERE THROWS AND NOTHING IN HERE LOGS. A refusal is RETURNED,
 * because only one of the two callers has a caller of its own to answer: the
 * route turns it into a 400 that names the bound, and the worker — which has no
 * HTTP status to give and must not lose a run over a reporting problem — counts
 * it and says so in the log. And a message assembled here can be read back by a
 * customer's agent, so it names a cell by its JSON-escaped key and a reading by
 * its already-validated identifier, never by raw payload text.
 *
 * Belongs on the package barrel and passes its standing test: types, pure
 * arithmetic and string building only — no `node:` builtin, no Prisma client,
 * no zod — so the web bundler can eat it like the rest of this package.
 */
import type { NotRunKind, TestResultStatus } from './constants';
import { notRunMessage } from './constants';
/*
 * The cell vocabulary and the two key functions, imported rather than restated.
 *
 * `variantBrowserKey` and `variantViewportKey` are the ONLY producers of the two
 * TEXT columns that make up a row's identity, which is the property the whole
 * matrix design rests on — so the consistency check below has to ask them rather
 * than re-derive the packing. ./browser-matrix.ts imports nothing but ./types,
 * so this stays a module of types, pure arithmetic and string building: no
 * `node:` builtin, no Prisma client, no zod, and the web bundler can still eat
 * it.
 */
import { cellCounts, variantBrowserKey, variantViewportKey } from './browser-matrix';
import type { MatrixCell, MatrixCellStatus } from './browser-matrix';
import type { UnassertedReason } from './test-type-decl';
import type {
  MetricDirection,
  MetricUnit,
  TestMetric,
  TestResultVariant,
  TestVariantKey,
} from './types';
import { UNVARIED } from './types';

/**
 * How many cells one execution may report.
 *
 * Five browsers x five viewports x eight locales is 200, which is wider than
 * any matrix in the sample configurations and wide enough that a producer
 * hitting it is in a loop rather than being thorough. The cap is a REFUSAL and
 * never a truncation: a variant list cut off at a limit is a matrix with holes,
 * and a hole in a matrix reads as "this cell was not varied" — which is the
 * one sentence this table exists to be able to tell apart from "it failed
 * here".
 */
export const MAX_VARIANTS_PER_EXECUTION = 200;

/**
 * How many readings one execution may report, counting every cell's and the
 * whole-test ones together.
 *
 * Separate from the per-cell bound `testResultVariantSchema` already applies,
 * because the two multiply: 200 cells at 40 readings each would be 8,000 rows
 * from one test, and fifty of those in one batch is a quarter of a million
 * inserts inside fifty transactions. 500 is the product's own ceiling on what
 * one test can be said to have measured, and like the cell bound it is a
 * refusal — a reading dropped over a limit is a number the trend query will
 * never know was taken.
 */
export const MAX_READINGS_PER_EXECUTION = 500;

/**
 * The cell's identity as one string, for `TestMetricSample.variantKey`.
 *
 * JSON, not `browser|viewport|locale|role|environment`, and the reason is
 * INJECTIVITY. A dimension is free text — `variantDimension` bounds its length
 * and reserves angle brackets for the sentinels, and that is all — so a
 * viewport literally named `a|b` would join to the same string as the pair
 * (`a`, `b`), and the unique index `(testResultId, variantKey, name)` would
 * then let one cell's reading silently overwrite another cell's. JSON escapes
 * its own delimiters, so two different cells cannot produce one key.
 *
 * The ARRAY form and not an object: this value is compared with `===`, and two
 * objects carrying the same five dimensions in a different property order are
 * different JSON. The array fixes the order at the call site instead.
 *
 * It is also what makes a refusal message safe to assemble. A dimension may
 * contain a newline — nothing forbids one — and a raw newline in an error
 * message is a forged log line; `JSON.stringify` escapes it to `\n`.
 */
export function variantKeyOf(key: TestVariantKey): string {
  return JSON.stringify([key.browser, key.viewport, key.locale, key.role, key.environment]);
}

/** True only when NOTHING was varied — see the refusal that uses it. */
function variedNothing(key: TestVariantKey): boolean {
  return (
    key.browser === UNVARIED &&
    key.viewport === UNVARIED &&
    key.locale === UNVARIED &&
    key.role === UNVARIED &&
    key.environment === UNVARIED
  );
}

/**
 * Where a cell and a reading get their tenancy and their parentage.
 *
 * `runId` and `testId` are DENORMALISED onto both tables so the two reads they
 * exist for — "this run's WebKit failures" and "this test's de-DE history" —
 * need no join. They are copied from the parent `TestResult` row and from the
 * `Run` that owns it, never from the reported payload: a body-supplied runId is
 * a cross-run write waiting to happen, and a body-supplied projectId is the
 * same hole one table over.
 */
export interface MeasurementParent {
  orgId: string;
  projectId: string;
  runId: string;
  testId: string;
  testResultId: string;
}

/**
 * THE FIVE HONESTY COLUMNS, as a producer hands them over.
 *
 * Shaped to match `testResultVariantCellSchema` in ./schemas.ts member for
 * member, and validated BY it — never re-checked here. That schema owns the two
 * pairings with teeth (a `notAsserted` list with no reason, and a reason with
 * nothing listed, are both refused; so is a remedy for a cell nobody probed),
 * and this module cannot import it: it is a zod object and this file carries no
 * zod. A second hand-rolled copy of those refinements is a second place for the
 * rule to be wrong, so the ingest paths parse and this function maps.
 *
 * `cell` is OPTIONAL on the variant below and absent means NO CLAIM WAS MADE —
 * the same fifth state `notRunKind` has, and the reason every one of these five
 * columns is nullable with no database default. A producer that reports no cell
 * evidence gets NULLs, not an AVAILABLE cell and not a zero.
 */
export interface ReportedCellEvidence {
  /** The resolved cell: the detail behind the identity the two keys carry. */
  readonly matrixCell: MatrixCell;
  /** AVAILABLE for a cell that ran. The other five mean no evidence exists. */
  readonly cellStatus: MatrixCellStatus;
  /** Null for AVAILABLE and NOT_CHECKED, a next action for the other four. */
  readonly cellRemedy: string | null;
  /** Assertions this cell did NOT make. Empty is the claim that it made them all. */
  readonly notAsserted: readonly string[];
  /** Required exactly when `notAsserted` is non-empty. */
  readonly notAssertedReason: UnassertedReason | null;
}

/**
 * A reported cell, with the per-cell evidence a widened matrix can carry.
 *
 * ── WHY THIS WIDENS `TestResultVariant` INSTEAD OF REPLACING IT ─────────────
 *
 * `cell` is OPTIONAL, so every existing producer — `variantsFor` in
 * packages/runner/src/matrix.ts, the on-prem agent's batch, every plugin that
 * reports a matrix today — keeps compiling and keeps meaning exactly what it
 * meant. That is the same arrangement `TestExecution.notRun`, `.mutation` and
 * `.newBaseline` have, and for the same reason: a plugin-produced extra that the
 * WORKER persists, because the runner has no database access by design.
 *
 * Declared HERE and not in ./types.ts purely because this round does not own
 * that file. `export * from './measurement-rows'` already puts it on the package
 * barrel, so a producer imports it from `@qaai/shared` like anything else and
 * nothing reaches across the workspace boundary by relative path to find it.
 */
export interface MeasuredVariant extends TestResultVariant {
  readonly cell?: ReportedCellEvidence | null;
}

/**
 * A JSON document, in the one shape a Prisma `Json?` write input accepts.
 *
 * ── WHY A TYPE AND NOT A CAST AT EACH CALL SITE ─────────────────────────────
 *
 * Prisma's `InputJsonObject` is `{ readonly [Key in string]?: ... }` — a mapped
 * INDEX SIGNATURE — and a TypeScript interface has none, so `MatrixCell` is not
 * assignable to it however correct the value is. Each ingest path could cast at
 * its own `createMany`, and then the row builder's output type would be the one
 * thing both paths had to work around separately: the second one to be written
 * would reach for `as unknown as object`, which stops the compiler objecting to
 * a value that cannot be serialised at all.
 *
 * So the shape is named ONCE, here, and `VariantRow` carries it. Declared with
 * no Prisma import, because this module is on the @qaai/shared barrel the web
 * app's bundler consumes.
 */
type JsonLeaf = string | number | boolean | null;
export interface JsonObjectValue {
  readonly [key: string]: JsonLeaf | JsonObjectValue | JsonArrayValue | undefined;
}
export type JsonArrayValue = ReadonlyArray<JsonLeaf | JsonObjectValue | JsonArrayValue>;

/**
 * The resolved cell as it is written: a `MatrixCell`, still readable as one.
 *
 * The INTERSECTION and not a replacement, so `row.matrixCell?.engine` still
 * type-checks everywhere downstream. A plain `JsonObjectValue` would have
 * compiled and thrown the cell's whole shape away at the only boundary where a
 * reader can still see it.
 */
export type MatrixCellJson = MatrixCell & JsonObjectValue;

/** One `TestResultVariant` insert, with every column written explicitly. */
export interface VariantRow {
  orgId: string;
  testResultId: string;
  runId: string;
  testId: string;
  browser: string;
  viewport: string;
  locale: string;
  role: string;
  environment: string;
  status: TestResultStatus;
  durationMs: number;
  errorMessage: string | null;
  notRunKind: NotRunKind | null;
  retriedAndPassed: boolean;
  /**
   * ── THE FIVE HONESTY COLUMNS ────────────────────────────────────────────
   *
   * All five written on EVERY row, present-and-null when nothing was reported,
   * for the reason `mutationColumns` in apps/worker/src/processors/run.ts
   * records at length: Prisma reads an ABSENT key as "leave the column alone",
   * so a writer that omitted them would take the database's default — and the
   * default for `matrixCell` and `cellStatus` is the right answer only by
   * accident today and would be the wrong one the moment this write becomes an
   * upsert.
   *
   * `matrixCell` is the ONE EXCEPTION, and it is `undefined` rather than `null`
   * for a reason worth stating because it looks like the mistake this file
   * spends a page warning about.
   *
   * The column is `Json?`, and in a Prisma write a nullable Json column does
   * NOT take a JS `null`: SQL NULL is the sentinel `Prisma.DbNull` and the JSON
   * *value* null is `Prisma.JsonNull`, two different facts Prisma refuses to let
   * one spelling mean. This module cannot produce either — it is on the
   * @qaai/shared barrel the web app's bundler consumes, and a Prisma import
   * here breaks every page that reads a value out of the package, which is the
   * same argument `requirements.ts` makes about `node:crypto`.
   *
   * `undefined` is correct HERE, and only here, because both ingest paths
   * DELETE AND THEN CREATE: an INSERT that does not name a column takes the
   * column's default, which for this one is SQL NULL. The key is still
   * REQUIRED, so the compiler makes every writer name it and a forgotten cell
   * cannot look like an absent one.
   *
   * A FUTURE WRITER THAT TURNS EITHER PATH INTO AN UPSERT OWES A `Prisma.DbNull`
   * HERE. On an update Prisma reads an absent key as "leave the column alone",
   * so an undefined would keep the previous attempt's resolved cell sitting
   * beside this attempt's results — exactly the stale-detail defect the survivor
   * rows' unconditional delete exists to prevent, one column over.
   */
  matrixCell: MatrixCellJson | undefined;
  cellStatus: MatrixCellStatus | null;
  cellRemedy: string | null;
  /**
   * `String[] @default([])`, so there is NO NULL TO WRITE and `[]` is the floor
   * rather than a claim. A reader asking "did this cell assert everything?"
   * must check `cellStatus IS NOT NULL` first: `[]` beside a null `cellStatus`
   * is a row nobody recorded evidence for, and reading it as "asserted
   * everything" is the flattering half of the lie this column exists to expose.
   */
  notAsserted: string[];
  notAssertedReason: UnassertedReason | null;
}

/**
 * One `TestMetricSample` insert, minus `variantId`.
 *
 * The id is not knowable until the cells have been inserted, so the caller
 * fills it from the ids it got back, keyed on this `variantKey`. The key itself
 * is written either way — it is NOT NULL precisely so that the unique index
 * constrains the whole-test case, which a unique over a nullable id would not.
 */
export interface ReadingRow {
  orgId: string;
  projectId: string;
  runId: string;
  testId: string;
  testResultId: string;
  variantKey: string;
  name: string;
  value: number | null;
  unavailableReason: string | null;
  unit: MetricUnit;
  direction: MetricDirection;
}

/**
 * The rows one execution's measurements become, or the one sentence saying why
 * none of them may be written.
 *
 * ALL-OR-NOTHING ON PURPOSE. A partially written matrix is indistinguishable
 * from a narrower matrix somebody configured, and a partially written metric
 * set is a trend with a gap nothing records. So every check below returns
 * before a single row is handed back.
 */
export type MeasurementPlan =
  { ok: true; variants: VariantRow[]; readings: ReadingRow[] } | { ok: false; why: string };

export function planMeasurements(
  parent: MeasurementParent,
  variants: readonly MeasuredVariant[],
  wholeTestMetrics: readonly TestMetric[],
): MeasurementPlan {
  if (variants.length > MAX_VARIANTS_PER_EXECUTION) {
    return {
      ok: false,
      why:
        `reported ${variants.length} matrix cells; at most ${MAX_VARIANTS_PER_EXECUTION} per test. ` +
        'Nothing was stored: a truncated cell list is a matrix with holes, and a hole reads as ' +
        '"this cell was not varied".',
    };
  }

  const variantRows: VariantRow[] = [];
  const readings: ReadingRow[] = [];
  /** Cell keys this batch actually reported — the orphan check's whole basis. */
  const cells = new Set<string>();
  /** `variantKey` + name, which is the unique index this write must not break. */
  const seen = new Set<string>();

  for (const variant of variants) {
    const key = variantKeyOf(variant.key);

    /*
     * A cell that varied NOTHING is the roll-up written a second time.
     * `TestResult` already holds that answer, and a synthetic all-sentinel row
     * beside it would make an unvaried execution indistinguishable from a
     * one-browser matrix somebody chose on purpose — which is the one
     * distinction this table was added to be able to make.
     */
    if (variedNothing(variant.key)) {
      return {
        ok: false,
        why:
          'reported a cell with none of the five dimensions varied. An unvaried execution reports ' +
          'no cells at all; one all-<unvaried> row would duplicate the roll-up and make an ' +
          'unvaried run look like a deliberate one-cell matrix.',
      };
    }

    if (cells.has(key)) {
      return {
        ok: false,
        why:
          `reported the cell ${key} twice. The cell is the row's identity, so the second one would ` +
          'either be refused by the unique index or overwrite the first — and a matrix that ' +
          'silently keeps one of two disagreeing answers is worse than one that refuses both.',
      };
    }
    cells.add(key);

    /*
     * `notRun.why` has no column of its own: `notRunKind` is the queryable half
     * and the sentence goes where the parent result's does, tagged by
     * `notRunMessage` so `parseNotRun` reads it back. Which means a cell that
     * ALSO reports an error message is asking for one of the two sentences to
     * be thrown away, and silently dropping either is the loss this refusal
     * exists to prevent.
     */
    if (variant.notRun && variant.errorMessage !== null) {
      return {
        ok: false,
        why:
          `reported both an error message and a not-run reason for the cell ${key}. There is one ` +
          'message column, so storing it would drop one of the two sentences. Send the failure, ' +
          'or send why nothing ran.',
      };
    }

    /*
     * ── THE IDENTITY AND THE DETAIL MUST DESCRIBE THE SAME CELL ───────────
     *
     * `matrixCell` is the resolved cell and the two TEXT columns are the row's
     * identity; the schema's own note says the JSON's key "must equal the
     * stored browser/viewport pair" and NOTHING ENFORCED IT. It could not:
     * `testResultVariantCellSchema` validates the cell alone and never sees the
     * key, and this function is the only place that holds both.
     *
     * Unchecked, a producer that packed the cell for one row and the key for
     * another writes a row the matrix view renders as chrome-beta while the
     * results in it came from bundled chromium — and because the view GROUPS on
     * the identity, nothing downstream can notice. Refused rather than
     * corrected towards either side, because nothing here can tell which of the
     * two the producer meant.
     *
     * Both keys are named through `JSON.stringify`: a locale, a timezone and a
     * device name are free text, and a raw newline in a message a customer's
     * agent reads back is a forged log line.
     */
    if (variant.cell) {
      const expected = [
        variantBrowserKey(variant.cell.matrixCell),
        variantViewportKey(variant.cell.matrixCell),
      ] as const;
      if (expected[0] !== variant.key.browser || expected[1] !== variant.key.viewport) {
        return {
          ok: false,
          why:
            `the cell ${key} carries a resolved cell whose own identity is ` +
            `${JSON.stringify(expected)}. The two TEXT columns ARE the row's identity and the JSON ` +
            'is the detail behind it, so a disagreement is one row describing two different cells ' +
            '— and the matrix view groups on the identity, so it would render this cell\'s channel ' +
            "against another cell's results. Nothing here can tell which of the two is wrong.",
        };
      }

      /*
       * A CELL THIS DEPLOYMENT COULD NOT RUN CANNOT HAVE A VERDICT.
       *
       * MISSING, WRONG_VERSION, UNSUPPORTED_COMBINATION and NEEDS_BROWSER_GRID
       * all mean no evidence was produced — `cellCounts` is the one authority on
       * that and is asked rather than re-listed — so a row carrying one of them
       * beside PASSED is a cell that cannot fail counted in the numerator, which
       * is the lie in the customer's favour this whole column exists to kill. It
       * is just as wrong beside FAILED: a defect reported against the customer's
       * application from the fact that OUR image is missing a browser.
       *
       * SKIPPED is the only honest verdict for such a cell, and that is exactly
       * what makes `cellStatus` worth having: the row is still written, still
       * in the denominator, and now says WHICH of the six reasons applied —
       * which is the distinction from a placeholder nobody reached.
       */
      if (!cellCounts(variant.cell.cellStatus) && variant.status !== 'SKIPPED') {
        return {
          ok: false,
          why:
            `the cell ${key} reports a status of ${JSON.stringify(variant.status)} beside a cell ` +
            `status of ${JSON.stringify(variant.cell.cellStatus)}, which means no evidence was ` +
            'produced here. A verdict on a cell that could not run is counted in a percentage as a ' +
            'cell that can never fail; send SKIPPED, and the cell status is what says why.',
        };
      }
    }

    variantRows.push({
      orgId: parent.orgId,
      testResultId: parent.testResultId,
      runId: parent.runId,
      testId: parent.testId,
      /*
       * THE FIVE DIMENSIONS, EACH WRITTEN. They are NOT NULL with no database
       * default, and that is the point: a writer that omitted one and let the
       * column fill itself would count the default cell once per run, because
       * the row's identity is the six-column unique index over exactly these.
       */
      browser: variant.key.browser,
      viewport: variant.key.viewport,
      locale: variant.key.locale,
      role: variant.key.role,
      environment: variant.key.environment,
      status: variant.status,
      durationMs: variant.durationMs,
      errorMessage: variant.notRun
        ? notRunMessage(variant.notRun.kind, variant.notRun.why)
        : variant.errorMessage,
      /*
       * NULL WHEN ABSENT, AND ABSENT IS NOT `NOT_RUN`. Identical contract to
       * `TestResult.notRunKind`: undefined means the producer made no claim
       * about why this cell measured nothing, which is a fifth state, and
       * defaulting it to NOT_RUN would put a claim in the database that nothing
       * produced. Written explicitly rather than omitted so a redelivered batch
       * clears a kind that no longer applies.
       */
      notRunKind: variant.notRun?.kind ?? null,
      retriedAndPassed: variant.retriedAndPassed,
      /*
       * ── THE FIVE HONESTY COLUMNS, WRITTEN ─────────────────────────────
       *
       * The round before this one added the columns, the schema and the
       * refinements, and then nothing called any of it: five NULLs for ever,
       * and a pass with a hole in it indistinguishable from a pass. This is the
       * writer.
       *
       * `cellStatus` and `cellRemedy` come off the CELL RESOLUTION and never
       * off `variant.status` or `variant.notRun`. They answer a different
       * question — "could this deployment run this cell" rather than "what did
       * running it conclude" — and deriving either from the verdict is how a
       * refused cell becomes an ordinary SKIPPED again, which is the exact
       * collapse that let a matrix percentage include cells that can never
       * fail.
       *
       * EVERY FIELD PASSED THROUGH, none re-decided. `cellRemedy` is null
       * beside AVAILABLE and NOT_CHECKED and a sentence beside the other four
       * because `testResultVariantCellSchema` already refused every other
       * combination; `notAssertedReason` is non-null exactly when `notAsserted`
       * is non-empty for the same reason. Re-deriving either here would be a
       * second opinion about a rule that already has one.
       *
       * ALL FIVE ARE NULL — not AVAILABLE, not `[]`-as-a-claim — when the
       * producer reported no cell. An unmeasured thing is null with a reason
       * and stays IN the denominator: the ROW IS STILL WRITTEN, which is what
       * keeps the cell counted, and `cellStatus IS NULL` is the honest reading
       * that nobody recorded anything about it.
       */
      /*
       * The cast adds an index signature and nothing else, and it is true by
       * construction: `matrixCellSchema` is `.strict()`, so this object holds
       * only the nine axes it declares — enum members, dotted numerals, short
       * strings and two small objects of the same — which is JSON. See
       * `MatrixCellJson`.
       */
      matrixCell: variant.cell?.matrixCell as MatrixCellJson | undefined,
      cellStatus: variant.cell?.cellStatus ?? null,
      cellRemedy: variant.cell?.cellRemedy ?? null,
      /*
       * COPIED, not aliased. The row is handed to a Prisma `createMany` and the
       * producer's array is `readonly`; sharing it would let a caller mutating
       * its own report change a row already planned, and all-or-nothing
       * planning is the one property this function guarantees.
       */
      notAsserted: variant.cell ? [...variant.cell.notAsserted] : [],
      notAssertedReason: variant.cell?.notAssertedReason ?? null,
    });

    for (const metric of variant.metrics ?? []) {
      /*
       * A reading nested under a cell belongs to THAT cell. If it names one at
       * all it must name its own, because writing it under the parent anyway
       * would file a WebKit number against Chromium and writing it under the
       * cell it names would move a reading out of the cell that reported it.
       */
      if (metric.variant && variantKeyOf(metric.variant) !== key) {
        return {
          ok: false,
          why:
            `the reading "${metric.name}" is nested under the cell ${key} but names ` +
            `${variantKeyOf(metric.variant)}. One of those two is wrong and nothing here can tell ` +
            'which, so neither is stored.',
        };
      }
      const duplicate = pushReading(parent, readings, seen, metric, key);
      if (duplicate) return duplicate;
    }
  }

  for (const metric of wholeTestMetrics) {
    /*
     * A whole-test reading carries the '<unvaried>' sentinel, NOT null, beside
     * a null `variantId`. Both halves, always: the id is the join and the key
     * is the identity, and a unique index over a nullable id would treat every
     * whole-test reading as distinct — PostgreSQL's NULLs — so the same metric
     * would be inserted once per run for ever.
     */
    const key = metric.variant ? variantKeyOf(metric.variant) : UNVARIED;

    /*
     * A reading for a cell this batch did not report. Storing it with a null
     * `variantId` would silently reattribute a WebKit measurement to the whole
     * test, which is the quietest way a per-cell number becomes a per-test
     * claim; storing it against a cell row that does not exist is not possible
     * at all. So it is refused, and the refusal names the cell.
     */
    if (key !== UNVARIED && !cells.has(key)) {
      return {
        ok: false,
        why:
          `the reading "${metric.name}" names the cell ${key}, which this batch did not report. ` +
          'Report the cell with the reading, or send the reading as a whole-test one; filing it ' +
          "under the whole test instead would turn one cell's measurement into the test's.",
      };
    }

    const duplicate = pushReading(parent, readings, seen, metric, key);
    if (duplicate) return duplicate;
  }

  if (readings.length > MAX_READINGS_PER_EXECUTION) {
    return {
      ok: false,
      why:
        `reported ${readings.length} readings; at most ${MAX_READINGS_PER_EXECUTION} per test. ` +
        'Nothing was stored: a reading dropped over a limit is a number the trend query will ' +
        'never know was taken.',
    };
  }

  return { ok: true, variants: variantRows, readings };
}

/**
 * Append one reading, or return the refusal that says it is a duplicate.
 *
 * Split out because the duplicate check has to hold across BOTH loops above —
 * a whole-test reading and a cell reading can collide on `(variantKey, name)`
 * just as two cell readings can, and `(testResultId, variantKey, name)` is the
 * unique index that would otherwise decide which of the two survives.
 *
 * `metric.name` is interpolated into the message, which is only safe because
 * `testMetricSchema` has already narrowed it to `[a-z0-9][a-z0-9_.:-]*` — no
 * newline, no quote, no control character. Nothing else from the payload goes
 * into a message un-escaped.
 */
function pushReading(
  parent: MeasurementParent,
  readings: ReadingRow[],
  seen: Set<string>,
  metric: TestMetric,
  variantKey: string,
): { ok: false; why: string } | null {
  // A NUL separator, so `name` cannot contain it and two different pairs
  // cannot share one guard key.
  const guard = `${variantKey}\u0000${metric.name}`;
  if (seen.has(guard)) {
    return {
      ok: false,
      why:
        `reported the reading "${metric.name}" twice for the cell ${variantKey}. One metric has one ` +
        'value per cell per result; storing both would keep whichever landed last and call it the ' +
        'measurement.',
    };
  }
  seen.add(guard);

  readings.push({
    orgId: parent.orgId,
    projectId: parent.projectId,
    runId: parent.runId,
    testId: parent.testId,
    testResultId: parent.testResultId,
    variantKey,
    name: metric.name,
    /*
     * THE NUMBER, OR NULL FOR "WE TRIED AND COULD NOT MEASURE IT" — never 0.
     * An LCP of 0 ms is a page that painted instantly, a p95 of 0 is a load
     * test that never ran, a visual diff ratio of 0 is a pixel-perfect match.
     * Both halves of the pairing are already enforced by `testMetricSchema` —
     * a reason is required exactly when the value is null and forbidden when it
     * is not — so they are passed through rather than re-checked here, because
     * a second hand-rolled check is a second place for the rule to be wrong.
     */
    value: metric.value,
    unavailableReason: metric.unavailableReason,
    unit: metric.unit,
    direction: metric.direction,
  });
  return null;
}
