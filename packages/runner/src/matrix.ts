/**
 * THE MATRIX RESOLVER — turning a declared cell set into actual executions, and
 * routing every result to the row that can be read back.
 *
 * ── WHAT THE KEYSTONE LEFT AND WHAT THIS FILE ADDS ──────────────────────────
 *
 * packages/shared/src/browser-matrix.ts defines what a CELL is, what a
 * deployment reported about itself, and what one cell RESOLVES to against it. It
 * is pure vocabulary and arithmetic, with no opinion about execution. Nothing
 * turned a cell set into runs, nothing decided which cells belong in a
 * denominator, and nothing routed a per-cell verdict onto a `TestResultVariant`
 * row — so the widened axes were a shape a customer could store and no runner
 * could honour.
 *
 * This is that half: expand, resolve, split, execute, and report. Six decisions
 * in it are load-bearing enough to state up front.
 *
 * ── 1. THE DECLARED PAIRINGS, NEVER THE FULL CROSS PRODUCT ──────────────────
 *
 * {@link planMatrix} takes EITHER an explicit cell list or axes to expand, and
 * refuses both at once. An explicit list is the declared pairings and is honoured
 * exactly — it is never re-expanded into a product — which is the same rule
 * `dimensionDenominator` in packages/shared/src/surface.ts enforces for the
 * surface axes and states in its own `rule` sentence: a route × role cell and a
 * route × locale cell are two things to test, and multiplying the axes together
 * asserts an interaction nobody declared. Axes are expanded by
 * `enumerateMatrix`, which is where the product and the cap disclosure already
 * live; this file does not re-implement either.
 *
 * ── 2. A CELL THAT COULD NOT RUN IS A TYPED NOT_RUN, NOT A FAILURE ──────────
 *
 * A missing WebKit binary is not a product defect. {@link rollUpVerdict}
 * EXCLUDES every not-run cell from the worst-wins reduction, so one uninstalled
 * browser cannot turn a green test red — and the parent result cannot be reported
 * as passing on the strength of cells that never executed either, which is why
 * the roll-up returns the counts beside the status rather than just the status.
 * {@link NOT_RUN_KIND_FOR_CELL} is the mapping, as a `Record` over
 * `MatrixCellStatus`, so a seventh status breaks the compile instead of silently
 * becoming a failure.
 *
 * ── 3. AN UNPROBED CELL IS ATTEMPTED, NOT REFUSED ───────────────────────────
 *
 * `NOT_CHECKED` means nobody probed, and `cellCounts` keeps it in the
 * denominator for the reason `UNEXERCISABLE_CELL_STATUSES` records: dropping it
 * would let a deployment that never ran a preflight shed every cell it could not
 * prove it could run, and the percentage would rise for a probe nobody executed.
 * So an unprobed cell is EXECUTED and the attempt is the evidence. What it must
 * not do is come back AVAILABLE — and it does not, because `resolveMatrixCell`
 * refuses to.
 *
 * ── 4. AN UNVARIED CELL WRITES NO VARIANT ROW, AND THAT IS A REFUSAL ────────
 *
 * `planMeasurements` in packages/shared/src/measurement-rows.ts refuses a cell
 * with all five dimensions `'<unvaried>'`, because one such row duplicates the
 * roll-up and makes an unvaried run indistinguishable from a deliberate one-cell
 * matrix. It cannot catch this case on its own: `variantBrowserKey({})` returns
 * `'<default>'`, NOT `'<unvaried>'`, so an unvaried cell slips past
 * `variedNothing` on a different sentinel. {@link variantsFor} refuses it here,
 * names the cell, and reports the omission rather than dropping it — see the note
 * on that function, which is the one defect in this file that another file's
 * guard would not have caught.
 *
 * ── 5. A VISUAL STATE THAT WAS NOT REACHED WRITES NO BASELINE. EVER. ────────
 *
 * The worst outcome a visual matrix has is not a missing capture, it is a capture
 * of the DEFAULT rendering filed under the name of a state nobody saw: it looks
 * fine, somebody approves it, and every future run of that cell passes while the
 * real error state stays untested behind a green row, permanently.
 * {@link recordCapture} DISCARDS the image when the reason means the state was
 * never on screen, records that it discarded one and why, and
 * {@link mayWriteBaseline} is the single predicate the writer asks.
 *
 * ── 6. NO BROWSER IN HERE ───────────────────────────────────────────────────
 *
 * {@link runVisualMatrix} takes the state-reacher and the capturer as INJECTED
 * narrow functions. There is no playwright import in this file, no `fetch` and no
 * clock, so every path including the orchestration is exercised by
 * matrix.test.ts with fakes. The one real adapter is a dozen lines in
 * plugins/visual.ts, which is where a `Page` belongs.
 */

import {
  ANONYMOUS_ROLE,
  NEVER_CAPTURABLE_UNREACHED_REASONS,
  UNVARIED,
  baselineViewportKey,
  cellCounts,
  enumerateMatrix,
  matrixCellKey,
  resolveMatrixCell,
  variantBrowserKey,
  variantViewportKey,
  variedAxes,
} from '@qaai/shared';
import type {
  DeploymentBrowsers,
  InteractionState,
  MatrixAxes,
  MatrixCapBite,
  MatrixCell,
  MatrixCellResolution,
  MatrixCellStatus,
  NotRunKind,
  StateUnreachedReason,
  TestResultStatus,
  TestResultVariant,
  TestVariantKey,
} from '@qaai/shared';

// ─── Which NotRunKind a refused cell gets ────────────────────────────────────

/**
 * The six cell statuses mapped onto the four `NotRunKind`s, or `null` for the
 * two that RUN.
 *
 * ── WHY A `Record` AND NOT A SWITCH ────────────────────────────────────────
 *
 * A seventh `MatrixCellStatus` is a compile error here rather than a cell that
 * falls through a `default:` and is reported as a failure. The same mechanism and
 * the same argument as `PLAYWRIGHT_CHANNEL`: a status with no mapping would
 * execute SOMETHING and label it with the requested cell's name.
 *
 * ── WHY THE PAIRS ARE SPLIT THE WAY THEY ARE ───────────────────────────────
 *
 * `BLOCKED_BY_ENV` for MISSING and WRONG_VERSION, because both have a remedy a
 * human can carry out on this machine — install it, upgrade it, pin it — and the
 * resolution's `remedy` field says which. `UNSUPPORTED` for
 * UNSUPPORTED_COMBINATION and NEEDS_BROWSER_GRID, because neither does: there is
 * no Firefox beta to install anywhere on earth, and no install on this image is
 * ever going to be Safari. Collapsing those two pairs into one word would send a
 * reader to run `npx playwright install` for a build that was never published,
 * which is advice that cannot be followed and is worse than silence.
 *
 * `CANCELLED` and `NOT_RUN` never appear: the first is a fact about a human
 * stopping a run and the second is the weakest of the four and the only honest
 * reading of a row nobody wrote to. Neither is ever a conclusion a resolution
 * licenses, and defaulting a resolved cell to `NOT_RUN` would put a claim in the
 * database that this file did not make.
 */
export const NOT_RUN_KIND_FOR_CELL: Record<MatrixCellStatus, NotRunKind | null> = {
  AVAILABLE: null,
  NOT_CHECKED: null,
  MISSING: 'BLOCKED_BY_ENV',
  WRONG_VERSION: 'BLOCKED_BY_ENV',
  UNSUPPORTED_COMBINATION: 'UNSUPPORTED',
  NEEDS_BROWSER_GRID: 'UNSUPPORTED',
};

/**
 * Worst-wins ranking over `TestResultStatus`.
 *
 * The same five numbers as the private `STATUS_SEVERITY` in
 * packages/runner/src/playwright-harness.ts, EXPORTED here so there is one copy.
 * Two implementations of a worst-wins ranking is how a roll-up comes to disagree
 * with a screen's sort, and the harness's copy is private, so a second reader had
 * no way to reach it. See this file's handover note: the harness should import
 * this and delete its own.
 *
 * TIMED_OUT above FAILED on purpose and not by accident of ordering: a timeout
 * is a failure whose cause is unknown, so it is the one a reader must see first.
 * SKIPPED at the bottom, below PASSED, which matters for a matrix — a cell that
 * was skipped must not drag a test whose other cells passed down to SKIPPED, and
 * the not-run exclusion in {@link rollUpVerdict} is the other half of that.
 */
export const CELL_STATUS_SEVERITY: Record<TestResultStatus, number> = {
  TIMED_OUT: 4,
  FAILED: 3,
  FLAKY: 2,
  PASSED: 1,
  SKIPPED: 0,
};

// ─── Planning ────────────────────────────────────────────────────────────────

/**
 * What to plan, and against what.
 *
 * `cells` and `axes` are both optional and exactly one must be given.
 * {@link planMatrix} REFUSES both-or-neither rather than preferring one, for the
 * reason the whole file turns on: a caller that passed both has two different
 * statements about what this test covers and nothing here can tell which one they
 * meant. Picking the richer would silently discard the other.
 */
export interface MatrixPlanInput {
  /** The declared pairings, honoured exactly. Never re-expanded into a product. */
  readonly cells?: readonly MatrixCell[];
  /** Axes to expand, through `enumerateMatrix`, which owns the cap disclosure. */
  readonly axes?: MatrixAxes;
  /** Required and never ambient. The seed decides which cells a cap loses. */
  readonly seed: string;
  /** The cap. Reported as a count AND a reason when it bites. */
  readonly maxCells: number;
  /** What the deployment reported. Absent = nothing was probed. */
  readonly deployment?: DeploymentBrowsers;
}

/** A cell this deployment will attempt. */
export interface MatrixExecution {
  readonly cell: MatrixCell;
  readonly resolution: MatrixCellResolution;
  /**
   * True when nobody probed what this cell needs, so the attempt itself is the
   * only evidence there will be. Carried so a reporter can say "attempted
   * unprobed" rather than implying the capability was confirmed first.
   */
  readonly unprobed: boolean;
}

/** A cell this deployment refused, with the typed reason and the remedy. */
export interface MatrixRefusal {
  readonly cell: MatrixCell;
  readonly resolution: MatrixCellResolution;
  /**
   * The typed NOT_RUN. `kind` comes from {@link NOT_RUN_KIND_FOR_CELL} and `why`
   * carries the resolution's own detail AND remedy, because a classification
   * nobody can act on is a classification that gets ignored.
   */
  readonly notRun: { readonly kind: NotRunKind; readonly why: string };
}

/**
 * The arithmetic, with every term a count so the division is checkable.
 *
 * `scored` is the denominator a percentage may use and it is computed from
 * `cellCounts`, never re-decided here: an unprobed cell is IN and a refused one
 * is OUT, which is the rule `UNEXERCISABLE_CELL_STATUSES` states and this file
 * must not hold a second opinion about.
 */
export interface MatrixDenominator {
  /** The full declared product or pairing count, before any cap. */
  readonly declared: number;
  /** Cells this plan actually holds, after the cap. */
  readonly planned: number;
  /** Cells that will be attempted. */
  readonly attempted: number;
  /** Of those, how many were never probed. */
  readonly unprobed: number;
  /** Cells refused, which leave BOTH halves of any ratio. */
  readonly refused: number;
  /** The denominator a percentage over this matrix may divide by. */
  readonly scored: number;
  readonly byStatus: Readonly<Record<MatrixCellStatus, number>>;
  /** The arithmetic as a sentence, so a reader can check it. */
  readonly rule: string;
}

export interface MatrixPlan {
  readonly runnable: readonly MatrixExecution[];
  readonly refused: readonly MatrixRefusal[];
  readonly denominator: MatrixDenominator;
  /** Non-null exactly when the cap bit. A cap that did not bite says nothing. */
  readonly capBite: MatrixCapBite | null;
  /**
   * Authoring refusals, RETURNED and never thrown.
   *
   * A plan with problems carries no cells, so nothing can run on a
   * half-understood declaration — but the caller gets the sentences and decides
   * whether that is a 400 or a counted, logged refusal. The same arrangement as
   * `MeasurementPlan`, and for the same reason: only one of the two callers has
   * an HTTP status to give.
   */
  readonly problems: readonly string[];
}

const EMPTY_BY_STATUS: Readonly<Record<MatrixCellStatus, number>> = {
  AVAILABLE: 0,
  MISSING: 0,
  WRONG_VERSION: 0,
  NOT_CHECKED: 0,
  UNSUPPORTED_COMBINATION: 0,
  NEEDS_BROWSER_GRID: 0,
};

function refusedPlan(problems: readonly string[]): MatrixPlan {
  return {
    runnable: [],
    refused: [],
    capBite: null,
    problems,
    denominator: {
      declared: 0,
      planned: 0,
      attempted: 0,
      unprobed: 0,
      refused: 0,
      scored: 0,
      byStatus: EMPTY_BY_STATUS,
      rule: 'nothing was planned, because the declaration could not be read',
    },
  };
}

/**
 * Expand the declared cells, resolve each against the deployment, and split them
 * into what will run and what was refused.
 *
 * DETERMINISTIC: the seed is required, there is no `Math.random` and no clock,
 * and the only thing the seed decides is which cells a bitten cap loses — never
 * the order, which `enumerateMatrix` guarantees and this function does not
 * disturb. The same seed and the same axes produce byte-identical plans.
 */
export function planMatrix(input: MatrixPlanInput): MatrixPlan {
  const hasCells = input.cells !== undefined;
  const hasAxes = input.axes !== undefined;

  if (hasCells && hasAxes) {
    return refusedPlan([
      'both an explicit cell list and a set of axes were given, which are two different statements ' +
        'about what this test covers. Nothing here can tell which was meant, and honouring the ' +
        'richer one would silently discard the other.',
    ]);
  }
  if (!hasCells && !hasAxes) {
    return refusedPlan([
      'neither a cell list nor a set of axes was given, so there is nothing to expand. An UNVARIED ' +
        'run is expressed as one empty cell, which is a different thing from no declaration at all.',
    ]);
  }
  if (input.seed.length === 0) {
    return refusedPlan([
      'the run seed is empty. A cap that bites picks its subset from the seed, so an empty seed ' +
        'makes the take unreproducible — and an unreproducible subset cannot be compared to the ' +
        'last run of the same suite.',
    ]);
  }

  let cells: readonly MatrixCell[];
  let declared: number;
  let capBite: MatrixCapBite | null;

  if (input.axes !== undefined) {
    const enumeration = enumerateMatrix(input.axes, {
      seed: input.seed,
      maxCells: input.maxCells,
    });
    cells = enumeration.cells;
    declared = enumeration.declared;
    capBite = enumeration.capBite;
  } else {
    /*
     * An explicit list is the DECLARED PAIRINGS and is taken as given. It is not
     * re-expanded, not deduplicated into a product and not reordered — but it IS
     * capped, by the same rule and with the same disclosure, because a stored
     * list of two hundred pairings is as expensive to run as a product of two
     * hundred and a silent truncation of either reads as a narrower matrix
     * somebody chose.
     */
    const all = input.cells ?? [];
    declared = all.length;
    if (input.maxCells <= 0) {
      cells = [];
      capBite = {
        cap: 'maxCells',
        limit: input.maxCells,
        taken: 0,
        atLeastMore: declared,
        detail:
          `maxCells is ${input.maxCells}, so none of the ${declared} declared pairing(s) was planned. ` +
          'This is a configuration refusal, not a matrix with nothing in it.',
      };
    } else if (declared <= input.maxCells) {
      cells = all;
      capBite = null;
    } else {
      cells = all.slice(0, input.maxCells);
      capBite = {
        cap: 'maxCells',
        limit: input.maxCells,
        taken: input.maxCells,
        atLeastMore: declared - input.maxCells,
        detail:
          `${declared} pairing(s) were declared and the limit is ${input.maxCells}, so ` +
          `${declared - input.maxCells} were not run. The first ${input.maxCells} in declared order ` +
          'were taken — a declared pairing list has an author-chosen order, so a seeded sample of it ' +
          'would discard that intent. Any percentage over these is a percentage over a prefix.',
      };
    }
  }

  const problems: string[] = [];
  const seenKeys = new Set<string>();
  const runnable: MatrixExecution[] = [];
  const refused: MatrixRefusal[] = [];
  const byStatus: Record<MatrixCellStatus, number> = { ...EMPTY_BY_STATUS };

  for (const cell of cells) {
    const key = matrixCellKey(cell);
    if (seenKeys.has(key)) {
      /*
       * Two cells with one key would write one `TestResultVariant` row twice —
       * refused by the unique index, or worse, upserted so that one cell's
       * verdict silently becomes the other's. Reported rather than deduplicated:
       * a declaration with a duplicate in it is a declaration whose author
       * believed they were covering two things.
       */
      problems.push(
        `the cell ${JSON.stringify(key)} is declared more than once. Two cells with one key write one ` +
          "variant row, so the second cell's verdict would either be refused by the unique index or " +
          "overwrite the first cell's — and a matrix that keeps one of two disagreeing answers is " +
          'worse than one that refuses both.',
      );
      continue;
    }
    seenKeys.add(key);

    const resolution = resolveMatrixCell(cell, input.deployment ?? {});
    byStatus[resolution.status] += 1;

    const notRunKind = NOT_RUN_KIND_FOR_CELL[resolution.status];
    if (notRunKind === null) {
      runnable.push({
        cell,
        resolution,
        unprobed: resolution.status === 'NOT_CHECKED',
      });
      continue;
    }
    refused.push({
      cell,
      resolution,
      notRun: {
        kind: notRunKind,
        why:
          resolution.remedy === null
            ? resolution.detail
            : `${resolution.detail}. ${resolution.remedy}`,
      },
    });
  }

  if (problems.length > 0) return refusedPlan(problems);

  const unprobed = runnable.filter((execution) => execution.unprobed).length;
  const scored = MATRIX_CELL_STATUSES_IN_PLAN.reduce(
    (running, status) => running + (cellCounts(status) ? byStatus[status] : 0),
    0,
  );

  return {
    runnable,
    refused,
    capBite,
    problems: [],
    denominator: {
      declared,
      planned: cells.length,
      attempted: runnable.length,
      unprobed,
      refused: refused.length,
      scored,
      byStatus,
      rule:
        `${cells.length} cell(s) planned out of ${declared} declared; ${runnable.length} will be ` +
        `attempted (${unprobed} of them never probed, so the attempt is the only evidence) and ` +
        `${refused.length} were refused and leave BOTH halves of any ratio. The denominator is ` +
        `${scored}: an unprobed cell stays in it, because dropping it would let a deployment that ` +
        'never ran a preflight shed every cell it could not prove it could run.' +
        (capBite === null ? '' : ` A cap bit: ${capBite.detail}`),
    },
  };
}

/**
 * The six statuses, iterated for the denominator sum.
 *
 * Derived from {@link NOT_RUN_KIND_FOR_CELL}'s keys rather than imported as a
 * list, because that `Record` is already the compiler-enforced presence record
 * for this union in this file — and a second list here would be a second thing to
 * keep in step with a seventh status.
 */
const MATRIX_CELL_STATUSES_IN_PLAN = Object.keys(
  NOT_RUN_KIND_FOR_CELL,
) as ReadonlyArray<MatrixCellStatus>;

// ─── Routing a cell's result onto a variant row ──────────────────────────────

/**
 * The three dimensions a CELL does not carry.
 *
 * `TestResultVariant` has five — browser, viewport, locale, role, environment —
 * and a `MatrixCell` supplies the first three. Role and environment come from the
 * execution around it, and `environment` has no default and no sentinel for the
 * reason `visualCaptureSchema.environmentId` records at length: the unique key
 * used to be (test, viewport, browser), so STAGING AND PRODUCTION SHARED A ROW
 * and whichever ran first became the other's reference.
 */
export interface VariantContext {
  /** The role this execution ran as. `ANONYMOUS_ROLE` for logged out. */
  readonly role?: string;
  /** The environment id. Required: a defaulted scope is the shared-row defect. */
  readonly environment: string;
}

/**
 * The five-dimension key for one cell.
 *
 * Browser and viewport come from `variantBrowserKey` and `variantViewportKey`,
 * which are the ONLY producers of those two strings in the product — the reason
 * the matrix widened without adding a column to the largest table in it. Locale
 * comes off the cell, and an absent one is `UNVARIED` rather than the image's
 * actual locale: reporting the host's locale for a cell that expressed no opinion
 * about locale would be claiming a dimension nobody varied.
 *
 * `role` defaults to `ANONYMOUS_ROLE` and NOT to `UNVARIED`, and the two are
 * genuinely different: "nobody varied the role" and "this ran as a logged-out
 * visitor" are different facts, only one is a claim about the application, and
 * `ANONYMOUS_ROLE` already owns the second. A caller that varied nothing about
 * identity passes `UNVARIED` explicitly.
 */
export function variantKeyFor(cell: MatrixCell, context: VariantContext): TestVariantKey {
  return {
    browser: variantBrowserKey(cell),
    viewport: variantViewportKey(cell),
    locale: cell.locale ?? UNVARIED,
    role: context.role ?? ANONYMOUS_ROLE,
    environment: context.environment,
  };
}

/** What one attempted cell actually did, as the caller reports it back. */
export interface CellOutcome {
  readonly cell: MatrixCell;
  readonly status: TestResultStatus;
  readonly durationMs: number;
  readonly errorMessage?: string | null;
  readonly retriedAndPassed?: boolean;
}

export interface VariantsResult {
  readonly variants: readonly TestResultVariant[];
  /**
   * Cells that produced NO row, each with the reason.
   *
   * A list and not a count, and never silent: a cell omitted without a sentence
   * is indistinguishable from a cell the plan never held, and the difference is
   * whether the matrix has a hole in it.
   */
  readonly omitted: readonly { readonly cell: MatrixCell; readonly why: string }[];
}

/**
 * Turn a plan and its outcomes into `TestResultVariant` rows.
 *
 * ── THE REFUSAL THAT NO OTHER FILE'S GUARD WOULD HAVE CAUGHT ────────────────
 *
 * `planMeasurements` refuses a cell whose five dimensions are ALL `'<unvaried>'`,
 * because such a row duplicates the worst-wins roll-up `TestResult` already
 * holds and makes an unvaried execution indistinguishable from a one-cell matrix
 * somebody configured on purpose. It cannot catch the case that arises HERE:
 * `variantBrowserKey({})` returns `'<default>'` — the sentinel for "this cell
 * expressed no opinion about the engine" — which is NOT `'<unvaried>'`, so an
 * unvaried cell sails past `variedNothing` on a different sentinel and the
 * duplicate row is written after all.
 *
 * So this function asks `variedAxes(cell)` — the cell's own authority on what it
 * varied — and omits a cell that varied nothing unless the ROLE or the
 * ENVIRONMENT was varied instead, which are the two dimensions a cell cannot
 * carry and which make a row meaningful on their own.
 *
 * ── A REFUSED CELL GETS A ROW, AND THAT IS THE POINT OF THE ROW ─────────────
 *
 * A refused cell is reported with `status: 'SKIPPED'` and its typed `notRun`, and
 * `errorMessage: null` — because `planMeasurements` refuses a cell carrying both,
 * there being one message column, and the not-run sentence is the one worth
 * keeping. A REFUSED cell and a cell that DOES NOT EXIST must not be recorded the
 * same way: the first is a row saying "this deployment cannot run WebKit, here is
 * the remedy", and the second is silence.
 */
export function variantsFor(
  plan: MatrixPlan,
  context: VariantContext,
  outcomes: readonly CellOutcome[],
): VariantsResult {
  const variants: TestResultVariant[] = [];
  const omitted: Array<{ cell: MatrixCell; why: string }> = [];
  const byKey = new Map<string, CellOutcome>();
  for (const outcome of outcomes) byKey.set(matrixCellKey(outcome.cell), outcome);

  const identityVaried =
    (context.role !== undefined && context.role !== UNVARIED) || context.environment !== UNVARIED;

  const emit = (cell: MatrixCell, build: () => TestResultVariant): void => {
    if (variedAxes(cell).length === 0 && !identityVaried) {
      omitted.push({
        cell,
        why:
          'this cell varied no axis and neither the role nor the environment was varied either, so ' +
          'its row would duplicate the worst-wins roll-up `TestResult` already holds — and one ' +
          'all-default row makes an unvaried execution indistinguishable from a deliberate one-cell ' +
          "matrix. Note that `variedNothing` in measurement-rows.ts cannot catch this: the browser " +
          "key of an unvaried cell is '<default>', not '<unvaried>'.",
      });
      return;
    }
    variants.push(build());
  };

  for (const execution of plan.runnable) {
    const key = matrixCellKey(execution.cell);
    const outcome = byKey.get(key);
    if (outcome === undefined) {
      /*
       * A planned cell with no reported outcome. NOT_RUN is the correct kind and
       * is the weakest of the four: nobody said why, and the honest sentence is
       * that the row was never written to. Inventing a failure here would report
       * a defect in the customer's application from the fact that OUR runner
       * lost a result.
       */
      emit(execution.cell, () => ({
        key: variantKeyFor(execution.cell, context),
        status: 'SKIPPED',
        durationMs: 0,
        errorMessage: null,
        retriedAndPassed: false,
        notRun: {
          kind: 'NOT_RUN',
          why:
            'this cell was planned and attempted and no outcome came back for it, so nothing is ' +
            'known about it in either direction. It is not a pass and it is not a failure.',
        },
      }));
      continue;
    }
    emit(execution.cell, () => ({
      key: variantKeyFor(execution.cell, context),
      status: outcome.status,
      durationMs: outcome.durationMs,
      errorMessage: outcome.errorMessage ?? null,
      retriedAndPassed: outcome.retriedAndPassed ?? false,
      notRun: null,
    }));
  }

  for (const refusal of plan.refused) {
    emit(refusal.cell, () => ({
      key: variantKeyFor(refusal.cell, context),
      status: 'SKIPPED',
      durationMs: 0,
      /*
       * NULL, and the not-run sentence carries the whole message.
       * `planMeasurements` refuses a cell that reports both, there being one
       * message column — so sending both would lose a run over a reporting
       * problem.
       */
      errorMessage: null,
      retriedAndPassed: false,
      notRun: refusal.notRun,
    }));
  }

  return { variants, omitted };
}

// ─── Rolling the cells up ────────────────────────────────────────────────────

export interface MatrixVerdict {
  readonly status: TestResultStatus;
  /** Cells whose verdict counted towards the status above. */
  readonly scored: number;
  /** Cells excluded because nothing ran in them. */
  readonly notRun: number;
  /**
   * Set when EVERY cell was a not-run, so the parent has nothing to report
   * either. Null whenever at least one cell was scored — a test with one real
   * result is not a not-run test.
   */
  readonly parentNotRun: { readonly kind: NotRunKind; readonly why: string } | null;
  readonly rule: string;
}

/**
 * Worst-wins across the cells, with every not-run cell EXCLUDED.
 *
 * ── WHY THE EXCLUSION IS THE WHOLE FUNCTION ─────────────────────────────────
 *
 * A missing WebKit binary is not a product defect. If a refused cell entered the
 * reduction it would arrive as SKIPPED, which ranks below PASSED, so a run on an
 * image with no WebKit would report the test as having passed — on the strength
 * of two cells out of three — and nothing in the status would say the third never
 * executed. Worse, a reader who moved SKIPPED above PASSED to fix that would turn
 * every uninstalled browser into a red test and the matrix would be switched off
 * within a week. Neither is right, because the status is the wrong place to carry
 * it: the counts are, which is why they are returned beside it and why
 * `scored` is part of the answer rather than something a caller recomputes.
 *
 * ── AND WHEN EVERY CELL WAS REFUSED ─────────────────────────────────────────
 *
 * The parent is a not-run too, and `parentNotRun` says so with the STRONGEST
 * reason present — `UNSUPPORTED` over `BLOCKED_BY_ENV` over `CANCELLED` over
 * `NOT_RUN` — because "no install will ever satisfy this" is the fact the reader
 * needs and "nobody probed" is the one that must not hide it. Reporting such a
 * test as PASSED (nothing failed) or as FAILED (nothing passed) are both claims
 * about an application nothing was executed against.
 */
export function rollUpVerdict(variants: readonly TestResultVariant[]): MatrixVerdict {
  const scored = variants.filter((variant) => !variant.notRun);
  const skipped = variants.filter((variant) => Boolean(variant.notRun));

  if (variants.length === 0) {
    return {
      status: 'SKIPPED',
      scored: 0,
      notRun: 0,
      parentNotRun: {
        kind: 'NOT_RUN',
        why: 'no cells were reported at all, so there is nothing to roll up.',
      },
      rule: 'no cells, so no verdict was derived from any.',
    };
  }

  if (scored.length === 0) {
    const kind = strongestNotRunKind(skipped);
    return {
      status: 'SKIPPED',
      scored: 0,
      notRun: skipped.length,
      parentNotRun: {
        kind,
        why:
          `all ${skipped.length} cell(s) of this matrix were not run, so nothing was executed against ` +
          'the application. This is neither a pass nor a failure: ' +
          (skipped
            .map((variant) => variant.notRun?.why)
            .find((why) => why !== undefined && why !== null) ?? 'no reason was recorded.'),
      },
      rule:
        `0 of ${variants.length} cell(s) produced a verdict; the other ${skipped.length} were typed ` +
        'not-runs and are excluded from worst-wins, so the parent is a not-run as well.',
    };
  }

  let worst: TestResultStatus = 'SKIPPED';
  for (const variant of scored) {
    if (CELL_STATUS_SEVERITY[variant.status] > CELL_STATUS_SEVERITY[worst]) {
      worst = variant.status;
    }
  }

  return {
    status: worst,
    scored: scored.length,
    notRun: skipped.length,
    parentNotRun: null,
    rule:
      `worst of ${scored.length} scored cell(s) is ${worst}; ${skipped.length} not-run cell(s) were ` +
      'excluded, because a browser this image does not have is not a defect in the application ' +
      'under test.',
  };
}

/**
 * The strongest not-run kind in a set, worst-first.
 *
 * The order is the information content: `UNSUPPORTED` means no install ever
 * satisfies this, `BLOCKED_BY_ENV` means one would, `CANCELLED` means a human
 * stopped it, and `NOT_RUN` means nobody recorded anything. A parent that
 * reported the weakest present would hide "this can never run here" behind
 * "nobody probed", which is the pair of sentences `MatrixCellStatus` was widened
 * to six members to keep apart.
 */
function strongestNotRunKind(variants: readonly TestResultVariant[]): NotRunKind {
  const order: readonly NotRunKind[] = ['UNSUPPORTED', 'BLOCKED_BY_ENV', 'CANCELLED', 'NOT_RUN'];
  for (const kind of order) {
    if (variants.some((variant) => variant.notRun?.kind === kind)) return kind;
  }
  return 'NOT_RUN';
}

// ─── The visual matrix ───────────────────────────────────────────────────────

/**
 * The cell a pre-matrix VISUAL spec has always been, built from its viewport.
 *
 * ── BYTE-IDENTICAL, WHICH IS THE POINT ─────────────────────────────────────
 *
 * `plugins/visual.ts` writes its baseline under `viewport:
 * \`${spec.viewport.width}x${spec.viewport.height}\`` and `browser: 'chromium'`.
 * Running the default 1280x800 spec through this function and then through
 * `baselineViewportKey(cell, 'DEFAULT')` and `variantBrowserKey(cell)` produces
 * `'1280x800'` and `'chromium'` — exactly those two strings, byte for byte. So a
 * plugin that adopts the matrix keeps matching every baseline a customer has
 * already approved, and nobody is forced into a re-approval sweep by an upgrade.
 * There is a test for precisely that, because it is the kind of invariant that is
 * true until somebody appends a separator.
 *
 * `engine: 'chromium'` is named explicitly rather than left absent, because the
 * existing writer hard-codes `'chromium'` and an absent engine would key as
 * `'<default>'` — a different string, and every existing baseline would stop
 * matching on the first run after the upgrade.
 */
export function floorCellFor(viewport: { width: number; height: number }): MatrixCell {
  return {
    engine: 'chromium',
    device: { kind: 'VIEWPORT', viewport: { width: viewport.width, height: viewport.height } },
  };
}

/** One (cell, state) pair to capture, with the baseline key it will be filed under. */
export interface VisualCapturePlan {
  readonly cell: MatrixCell;
  readonly state: InteractionState;
  /** `VisualBaseline.viewport` for this pair. The only producer of that string. */
  readonly baselineViewport: string;
  /** `VisualBaseline.browser` for this pair. */
  readonly baselineBrowser: string;
}

/**
 * Every (cell, state) pair, in declared order.
 *
 * DEFAULT is the implicit state: a spec that names none captures the page as it
 * arrives, which is what every spec written before the matrix existed does. The
 * product here is deliberate and is NOT the cross-product objection: a visual
 * capture of a cell in a state is one indivisible thing to look at, so the pairs
 * ARE the declared items — unlike a route × role × locale cell, which is three
 * independent axes and is counted by addition.
 */
export function planVisualCaptures(
  cells: readonly MatrixCell[],
  states?: readonly InteractionState[],
): readonly VisualCapturePlan[] {
  const wanted: readonly InteractionState[] =
    states !== undefined && states.length > 0 ? states : ['DEFAULT'];
  const plans: VisualCapturePlan[] = [];
  for (const cell of cells) {
    for (const state of wanted) {
      plans.push({
        cell,
        state,
        baselineViewport: baselineViewportKey(cell, state),
        baselineBrowser: variantBrowserKey(cell),
      });
    }
  }
  return plans;
}

/** Did the reacher get the surface into the state? */
export type StateReachOutcome =
  | { readonly reached: true }
  | {
      readonly reached: false;
      readonly reason: StateUnreachedReason;
      /** One sentence a human can act on. NO_TRIGGER_FOUND is useless without it. */
      readonly detail: string;
    };

/**
 * Reach one state on one cell. INJECTED, so no `Page` reaches this module.
 *
 * It returns a verdict and is expected never to throw — but
 * {@link runVisualMatrix} wraps it anyway, because a reacher that threw and was
 * not caught would lose the whole matrix over one unreachable dropdown.
 */
export type StateReacher = (
  plan: VisualCapturePlan,
) => StateReachOutcome | Promise<StateReachOutcome>;

/** Capture the current rendering and return the stored key, or null. */
export type StateCapturer = (plan: VisualCapturePlan) => string | null | Promise<string | null>;

/**
 * ONE CAPTURE'S EVIDENCE, in the shape `visualCaptureSchema` validates, plus
 * what this module had to decide on the way.
 *
 * `imageDiscarded` has no column and never will: it exists so the DECISION to
 * throw an image away is reported rather than merely taken. A capture silently
 * dropped and a capture never attempted look the same in the stored row, and only
 * one of them means our reacher has a bug.
 */
export interface VisualCaptureRecord {
  readonly cell: MatrixCell;
  readonly state: InteractionState;
  readonly reached: boolean;
  readonly unreachedReason: StateUnreachedReason | null;
  readonly unreachedDetail: string | null;
  readonly imageKey: string | null;
  readonly environmentId: string;
  readonly baselineViewport: string;
  readonly baselineBrowser: string;
  /** True when an image existed and was thrown away. Reported, never silent. */
  readonly imageDiscarded: boolean;
  /** Why it was discarded, or null. */
  readonly discardReason: string | null;
}

/**
 * Decide what one attempt is allowed to record.
 *
 * ── THE WORST OUTCOME A VISUAL MATRIX HAS, REFUSED HERE ─────────────────────
 *
 * It is not a missing capture. It is a capture of the WRONG THING filed under the
 * right name: the test asked for the ERROR state, nothing triggered validation,
 * the screenshot was taken anyway, it looks fine, somebody approves it — and the
 * baseline now permanently asserts the DEFAULT rendering under the name of a
 * state nobody ever saw. Every future run of that cell passes and the error
 * rendering is untested for ever with a green row above it. Falsely green, and
 * permanently, which is the one failure mode in this product that gets worse with
 * time rather than being noticed.
 *
 * So when the state was not reached for a reason in
 * `NEVER_CAPTURABLE_UNREACHED_REASONS` — which is every reason that means the
 * state was never on screen — the image is DROPPED, and the drop is recorded.
 * Membership is asked of that exported list rather than re-decided here, so this
 * module and `visualCaptureSchema`'s own refinement cannot come to disagree about
 * which reasons those are.
 */
export function recordCapture(args: {
  readonly plan: VisualCapturePlan;
  readonly outcome: StateReachOutcome;
  readonly imageKey: string | null;
  readonly environmentId: string;
}): VisualCaptureRecord {
  const { plan, outcome, environmentId } = args;
  const base = {
    cell: plan.cell,
    state: plan.state,
    environmentId,
    baselineViewport: plan.baselineViewport,
    baselineBrowser: plan.baselineBrowser,
  } as const;

  if (outcome.reached) {
    return {
      ...base,
      reached: true,
      unreachedReason: null,
      unreachedDetail: null,
      imageKey: args.imageKey,
      imageDiscarded: false,
      discardReason: null,
    };
  }

  const neverOnScreen = NEVER_CAPTURABLE_UNREACHED_REASONS.includes(outcome.reason);
  const discarding = neverOnScreen && args.imageKey !== null;

  return {
    ...base,
    reached: false,
    unreachedReason: outcome.reason,
    unreachedDetail: outcome.detail,
    imageKey: discarding || neverOnScreen ? null : args.imageKey,
    imageDiscarded: discarding,
    discardReason: discarding
      ? `the ${plan.state} state was never on screen (${outcome.reason}), so this capture is of ` +
        `something else. Filing it as the ${plan.state} baseline would make every future run of ` +
        'this cell falsely green, permanently.'
      : null,
  };
}

/**
 * May a baseline be written or compared for this capture?
 *
 * ONE predicate, asked by the writer, so the rule is not re-derived at each call
 * site. An unreached state is not a baseline and an absent image is not one
 * either — and the second half matters: a writer that checked only `reached`
 * would try to persist a null key for a state that was reached and whose capture
 * failed.
 */
export function mayWriteBaseline(record: VisualCaptureRecord): boolean {
  return record.reached && record.imageKey !== null;
}

export interface VisualMatrixDeps {
  readonly plan: MatrixPlan;
  readonly states?: readonly InteractionState[];
  readonly environmentId: string;
  readonly reach: StateReacher;
  readonly capture: StateCapturer;
}

export interface VisualMatrixResult {
  readonly captures: readonly VisualCaptureRecord[];
  /**
   * (cell, state) pairs that were never ATTEMPTED because the cell itself could
   * not run.
   *
   * Kept apart from an UNREACHED state, and the distinction is exactly the one
   * this round is about: UNREACHED is a fact about the application's surface
   * ("nothing on the page opens that menu") and NOT_RUN is a fact about this
   * image ("there is no WebKit here"). Recording them the same way would put our
   * missing binary into the customer's defect list.
   */
  readonly notRun: readonly {
    readonly cell: MatrixCell;
    readonly state: InteractionState;
    readonly notRun: { readonly kind: NotRunKind; readonly why: string };
  }[];
  /** Captures whose image was discarded, so the count is visible in a report. */
  readonly discarded: number;
  /** Reached states, for the "which states did this route never reach" question. */
  readonly reached: number;
}

/**
 * Drive the visual matrix: reach each state, capture it, and record what
 * happened.
 *
 * NEVER THROWS. A reacher or a capturer that fails leaves a record with
 * `ENGINE_CANNOT_SIMULATE` and the message, because a thrown reacher whose
 * exception escapes loses every remaining cell in the matrix — and an exception
 * swallowed without a record is a state silently reported as reachable-and-clean.
 */
export async function runVisualMatrix(deps: VisualMatrixDeps): Promise<VisualMatrixResult> {
  const captures: VisualCaptureRecord[] = [];
  const notRun: VisualMatrixResult['notRun'][number][] = [];
  const states: readonly InteractionState[] =
    deps.states !== undefined && deps.states.length > 0 ? deps.states : ['DEFAULT'];

  for (const refusal of deps.plan.refused) {
    for (const state of states) {
      notRun.push({ cell: refusal.cell, state, notRun: refusal.notRun });
    }
  }

  for (const plan of planVisualCaptures(
    deps.plan.runnable.map((execution) => execution.cell),
    states,
  )) {
    let outcome: StateReachOutcome;
    try {
      outcome = await deps.reach(plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captures.push(
        recordCapture({
          plan,
          outcome: {
            reached: false,
            reason: 'ENGINE_CANNOT_SIMULATE',
            detail: `reaching the ${plan.state} state failed: ${message}`,
          },
          imageKey: null,
          environmentId: deps.environmentId,
        }),
      );
      continue;
    }

    /*
     * THE CAPTURE IS NOT EVEN ATTEMPTED WHEN THE STATE WAS NOT REACHED. Taking
     * the shot and relying on `recordCapture` to drop it would work, and it would
     * also put an image of the wrong rendering into the artifact store where a
     * later reader could pick it up as evidence of the named state.
     */
    if (!outcome.reached) {
      captures.push(
        recordCapture({ plan, outcome, imageKey: null, environmentId: deps.environmentId }),
      );
      continue;
    }

    let imageKey: string | null;
    try {
      imageKey = await deps.capture(plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captures.push(
        recordCapture({
          plan,
          outcome: {
            reached: false,
            reason: 'ENGINE_CANNOT_SIMULATE',
            detail: `the ${plan.state} state was reached and the capture failed: ${message}`,
          },
          imageKey: null,
          environmentId: deps.environmentId,
        }),
      );
      continue;
    }

    captures.push(recordCapture({ plan, outcome, imageKey, environmentId: deps.environmentId }));
  }

  return {
    captures,
    notRun,
    discarded: captures.filter((record) => record.imageDiscarded).length,
    reached: captures.filter((record) => record.reached).length,
  };
}
