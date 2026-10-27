/**
 * The properties the matrix resolver lives or die on:
 *
 *  1. A CELL THAT COULD NOT RUN IS NOT A FAILURE AND NOT A PASS. A missing
 *     WebKit binary is a fact about this image, and both of the obvious
 *     treatments are wrong: let it into worst-wins as a SKIP and a run on an
 *     image with no WebKit reports the test as passing, with nothing saying the
 *     third cell never executed; rank SKIP above PASS to fix that and every
 *     uninstalled browser turns a test red and the matrix is switched off within
 *     a week. The counts are the answer, which is why they are returned beside
 *     the status.
 *  2. AN UNPROBED CELL IS ATTEMPTED AND STAYS IN THE DENOMINATOR. Dropping it
 *     would let a deployment that never ran a preflight shed every cell it could
 *     not prove it could run, and the percentage would rise for a probe nobody
 *     executed.
 *  3. A STATE THAT WAS NOT REACHED WRITES NO BASELINE. EVER. This is the one
 *     failure mode in the product that gets WORSE with time instead of being
 *     noticed: the capture is of the default rendering, it looks fine, somebody
 *     approves it, and the baseline asserts the named state for ever behind a
 *     green row.
 *  4. THE EXISTING BASELINES KEEP MATCHING. `floorCellFor` plus the keystone's
 *     two key producers must emit the two strings plugins/visual.ts already
 *     writes, byte for byte, or every customer is forced into a re-approval
 *     sweep by an upgrade.
 *  5. THE DECLARED PAIRINGS, NEVER A CROSS PRODUCT, and a cap that bit is a
 *     count AND a reason.
 *  6. DETERMINISM: same seed, byte-identical plan.
 *
 * No playwright anywhere in this file. The orchestration is driven with injected
 * fakes, including the two failure paths, which is why it has tests at all.
 */

import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_ROLE,
  MATRIX_CELL_STATUSES,
  UNVARIED,
  baselineViewportKey,
  cellCounts,
  planMeasurements,
  variantBrowserKey,
  visualCaptureSchema,
} from '@qaai/shared';
import type {
  DeploymentBrowsers,
  InteractionState,
  MatrixCell,
  MeasurementParent,
  TestResultVariant,
} from '@qaai/shared';
import {
  CELL_STATUS_SEVERITY,
  NOT_RUN_KIND_FOR_CELL,
  floorCellFor,
  mayWriteBaseline,
  planMatrix,
  planVisualCaptures,
  recordCapture,
  rollUpVerdict,
  runVisualMatrix,
  variantKeyFor,
  variantsFor,
} from './matrix.js';
import type { StateReachOutcome, VisualCapturePlan } from './matrix.js';

const SEED = 'run-7f3a';

const CHROMIUM: MatrixCell = { engine: 'chromium' };
const FIREFOX: MatrixCell = { engine: 'firefox' };
const WEBKIT: MatrixCell = { engine: 'webkit' };

const PARENT: MeasurementParent = {
  orgId: 'org_1',
  projectId: 'proj_1',
  runId: 'run_1',
  testId: 'test_1',
  testResultId: 'tr_1',
};

function plan(
  cells: readonly MatrixCell[],
  deployment: DeploymentBrowsers = {},
  maxCells = 50,
): ReturnType<typeof planMatrix> {
  return planMatrix({ cells, seed: SEED, maxCells, deployment });
}

// ─── The status mapping ──────────────────────────────────────────────────────

describe('NOT_RUN_KIND_FOR_CELL', () => {
  it('names every cell status, so a seventh one cannot fall through as a failure', () => {
    expect(Object.keys(NOT_RUN_KIND_FOR_CELL).sort()).toEqual([...MATRIX_CELL_STATUSES].sort());
  });

  it('lets exactly the two executable statuses through', () => {
    const executable = Object.entries(NOT_RUN_KIND_FOR_CELL)
      .filter(([, kind]) => kind === null)
      .map(([status]) => status)
      .sort();
    expect(executable).toEqual(['AVAILABLE', 'NOT_CHECKED']);
  });

  it('keeps "install something" apart from "no install will ever do"', () => {
    /*
     * Collapsing these two pairs into one word sends a reader to run
     * `npx playwright install` for a Firefox beta that was never published — advice
     * that cannot be followed, which is worse than silence.
     */
    expect(NOT_RUN_KIND_FOR_CELL.MISSING).toBe('BLOCKED_BY_ENV');
    expect(NOT_RUN_KIND_FOR_CELL.WRONG_VERSION).toBe('BLOCKED_BY_ENV');
    expect(NOT_RUN_KIND_FOR_CELL.UNSUPPORTED_COMBINATION).toBe('UNSUPPORTED');
    expect(NOT_RUN_KIND_FOR_CELL.NEEDS_BROWSER_GRID).toBe('UNSUPPORTED');
  });

  it('never concludes CANCELLED or NOT_RUN from a resolution', () => {
    // Both are facts a resolution does not license: one is a human stopping a
    // run, the other is the honest reading of a row nobody wrote to.
    const kinds = Object.values(NOT_RUN_KIND_FOR_CELL);
    expect(kinds).not.toContain('CANCELLED');
    expect(kinds).not.toContain('NOT_RUN');
  });

  it('agrees with the keystone about which statuses may be scored', () => {
    for (const status of MATRIX_CELL_STATUSES) {
      // One rule, in one place: a refused cell is exactly a cell with a NotRunKind.
      expect(cellCounts(status)).toBe(NOT_RUN_KIND_FOR_CELL[status] === null);
    }
  });

  it('ranks a timeout above a failure and a skip below a pass', () => {
    expect(CELL_STATUS_SEVERITY.TIMED_OUT).toBeGreaterThan(CELL_STATUS_SEVERITY.FAILED);
    expect(CELL_STATUS_SEVERITY.FAILED).toBeGreaterThan(CELL_STATUS_SEVERITY.FLAKY);
    expect(CELL_STATUS_SEVERITY.PASSED).toBeGreaterThan(CELL_STATUS_SEVERITY.SKIPPED);
  });
});

// ─── Planning ────────────────────────────────────────────────────────────────

describe('planMatrix refuses a declaration it cannot read, and returns the refusal', () => {
  it('refuses both a cell list and axes at once', () => {
    const refused = planMatrix({
      cells: [CHROMIUM],
      axes: { engines: ['chromium'] },
      seed: SEED,
      maxCells: 10,
    });
    expect(refused.problems.join(' ')).toContain('two different statements');
    expect(refused.runnable).toEqual([]);
    expect(refused.denominator.scored).toBe(0);
  });

  it('refuses neither, and says an unvaried run is one empty cell', () => {
    const refused = planMatrix({ seed: SEED, maxCells: 10 });
    expect(refused.problems.join(' ')).toContain('one empty cell');
  });

  it('refuses an empty seed, because an unreproducible take cannot be compared', () => {
    const refused = planMatrix({ cells: [CHROMIUM], seed: '', maxCells: 10 });
    expect(refused.problems.join(' ')).toContain('unreproducible');
  });

  it('refuses a duplicate cell rather than silently deduplicating it', () => {
    const refused = plan([CHROMIUM, { engine: 'chromium' }]);
    expect(refused.problems.join(' ')).toContain('declared more than once');
    expect(refused.problems.join(' ')).toContain('one of two disagreeing answers');
    expect(refused.runnable).toEqual([]);
  });
});

describe('planMatrix honours the declared pairings and never expands them', () => {
  it('plans exactly the cells it was given, in order', () => {
    /*
     * Two declared pairings out of a 2x2 product stay two. The cross product
     * asserts an interaction nobody declared, which is the rule
     * `dimensionDenominator` states for the surface axes and this file inherits.
     */
    const pairings: readonly MatrixCell[] = [
      { engine: 'chromium', colourScheme: 'LIGHT' },
      { engine: 'webkit', colourScheme: 'DARK' },
    ];
    const planned = plan(pairings, { engines: { chromium: true, webkit: true } });
    expect(planned.denominator.declared).toBe(2);
    expect(planned.denominator.planned).toBe(2);
    expect(planned.runnable.map((execution) => execution.cell)).toEqual([...pairings]);
  });

  it('expands axes through the keystone, and discloses the cap it reports', () => {
    const planned = planMatrix({
      axes: { engines: ['chromium', 'firefox', 'webkit'], colourSchemes: ['LIGHT', 'DARK'] },
      seed: SEED,
      maxCells: 2,
      deployment: { engines: { chromium: true, firefox: true, webkit: true } },
    });
    expect(planned.denominator.declared).toBe(6);
    expect(planned.denominator.planned).toBe(2);
    expect(planned.capBite?.taken).toBe(2);
    expect(planned.capBite?.atLeastMore).toBe(4);
    expect(planned.capBite?.detail).toContain('not over the matrix');
    expect(planned.denominator.rule).toContain('A cap bit');
  });

  it('caps a declared pairing list by its author-chosen PREFIX, not by a seeded sample', () => {
    const planned = plan([CHROMIUM, FIREFOX, WEBKIT], { engines: { chromium: true } }, 1);
    expect(planned.denominator.planned).toBe(1);
    expect(planned.runnable[0]?.cell).toEqual(CHROMIUM);
    expect(planned.capBite?.atLeastMore).toBe(2);
    expect(planned.capBite?.detail).toContain('declared order');
  });

  it('refuses a zero cap rather than returning a matrix with nothing in it', () => {
    const planned = plan([CHROMIUM, FIREFOX], {}, 0);
    expect(planned.runnable).toEqual([]);
    expect(planned.capBite?.detail).toContain('configuration refusal');
  });

  it('is byte-identical for the same seed', () => {
    const axes = { engines: ['chromium', 'firefox', 'webkit'] as const, colourSchemes: ['LIGHT', 'DARK'] as const };
    const once = planMatrix({ axes, seed: SEED, maxCells: 3 });
    const twice = planMatrix({ axes, seed: SEED, maxCells: 3 });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe('planMatrix splits what will run from what was refused', () => {
  it('ATTEMPTS an unprobed cell and keeps it in the denominator', () => {
    const planned = plan([CHROMIUM]);
    expect(planned.runnable).toHaveLength(1);
    expect(planned.runnable[0]?.unprobed).toBe(true);
    expect(planned.runnable[0]?.resolution.status).toBe('NOT_CHECKED');
    expect(planned.denominator.scored).toBe(1);
    expect(planned.denominator.unprobed).toBe(1);
    expect(planned.denominator.rule).toContain('the attempt is the only evidence');
  });

  it('never reports an unprobed cell as AVAILABLE', () => {
    // The keystone's refusal, re-asserted at the layer that acts on it: an empty
    // capability must not become a confirmed one by passing through here.
    expect(plan([CHROMIUM]).runnable[0]?.resolution.status).not.toBe('AVAILABLE');
  });

  it('refuses a missing browser as BLOCKED_BY_ENV and takes it OUT of the denominator', () => {
    const planned = plan([CHROMIUM, WEBKIT], {
      engines: { chromium: true, webkit: false },
    });
    expect(planned.runnable.map((execution) => execution.cell)).toEqual([CHROMIUM]);
    expect(planned.refused).toHaveLength(1);
    expect(planned.refused[0]?.notRun.kind).toBe('BLOCKED_BY_ENV');
    expect(planned.refused[0]?.notRun.why).toContain('npx playwright install');
    expect(planned.denominator.scored).toBe(1);
    expect(planned.denominator.refused).toBe(1);
    expect(planned.denominator.byStatus.MISSING).toBe(1);
  });

  it('refuses a pinned Safari version as UNSUPPORTED, with the grid remedy', () => {
    const planned = plan([
      {
        engine: 'webkit',
        version: { kind: 'RANGE', range: { atLeast: '17', below: null, why: 'a customer pin' } },
      },
    ]);
    expect(planned.refused[0]?.notRun.kind).toBe('UNSUPPORTED');
    expect(planned.refused[0]?.notRun.why).toContain('webkit is not Safari');
    expect(planned.refused[0]?.notRun.why).toContain('device farm');
    expect(planned.denominator.scored).toBe(0);
  });

  it('refuses a Firefox beta as UNSUPPORTED, not as something to install', () => {
    const planned = plan([{ engine: 'firefox', channel: 'CHROME_BETA' }]);
    expect(planned.refused[0]?.resolution.status).toBe('UNSUPPORTED_COMBINATION');
    expect(planned.refused[0]?.notRun.kind).toBe('UNSUPPORTED');
    expect(planned.refused[0]?.notRun.why).not.toContain('npx playwright install');
  });

  it('refuses an out-of-window version as BLOCKED_BY_ENV, and carries the pin reason', () => {
    const planned = plan(
      [
        {
          engine: 'chromium',
          version: {
            kind: 'RANGE',
            range: { atLeast: '120', below: null, why: 'closedby landed in 120' },
          },
        },
      ],
      { engines: { chromium: true }, versions: { chromium: '118.0.5993.70' } },
    );
    expect(planned.refused[0]?.resolution.status).toBe('WRONG_VERSION');
    expect(planned.refused[0]?.notRun.kind).toBe('BLOCKED_BY_ENV');
    expect(planned.refused[0]?.notRun.why).toContain('closedby landed in 120');
    expect(planned.refused[0]?.resolution.observedVersion).toBe('118.0.5993.70');
  });
});

// ─── Variant routing ─────────────────────────────────────────────────────────

describe('variantKeyFor', () => {
  it('keeps an unvaried locale as the sentinel rather than reporting the host locale', () => {
    const key = variantKeyFor(CHROMIUM, { environment: 'env_1' });
    expect(key.locale).toBe(UNVARIED);
    expect(key.browser).toBe('chromium');
  });

  it('defaults the role to anonymous, which is a different fact from unvaried', () => {
    // "Nobody varied the role" and "this ran as a logged-out visitor" are
    // different sentences; only one is a claim about the application.
    expect(variantKeyFor(CHROMIUM, { environment: 'env_1' }).role).toBe(ANONYMOUS_ROLE);
    expect(variantKeyFor(CHROMIUM, { environment: 'env_1', role: UNVARIED }).role).toBe(UNVARIED);
    expect(variantKeyFor(CHROMIUM, { environment: 'env_1', role: 'admin' }).role).toBe('admin');
  });

  it('carries the cell locale through', () => {
    expect(
      variantKeyFor({ engine: 'chromium', locale: 'de-DE' }, { environment: 'env_1' }).locale,
    ).toBe('de-DE');
  });
});

describe('variantsFor', () => {
  const context = { environment: 'env_1', role: 'admin' } as const;

  it('reports a verdict per attempted cell', () => {
    const planned = plan([CHROMIUM, FIREFOX], { engines: { chromium: true, firefox: true } });
    const { variants, omitted } = variantsFor(planned, context, [
      { cell: CHROMIUM, status: 'PASSED', durationMs: 120 },
      { cell: FIREFOX, status: 'FAILED', durationMs: 90, errorMessage: 'locator not found' },
    ]);
    expect(omitted).toEqual([]);
    expect(variants.map((variant) => [variant.key.browser, variant.status])).toEqual([
      ['chromium', 'PASSED'],
      ['firefox', 'FAILED'],
    ]);
  });

  it('OMITS an unvaried cell, which the shared row builder cannot catch', () => {
    /*
     * The defect in this file that no other file's guard would have found.
     * `variedNothing` in measurement-rows.ts refuses a row whose five dimensions
     * are all '<unvaried>' — and `variantBrowserKey({})` returns '<default>', a
     * DIFFERENT sentinel, so an unvaried cell sails past it and the duplicate
     * roll-up row is written after all.
     */
    const planned = plan([{}]);
    const { variants, omitted } = variantsFor(
      planned,
      { environment: UNVARIED, role: UNVARIED },
      [{ cell: {}, status: 'PASSED', durationMs: 5 }],
    );
    expect(variants).toEqual([]);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]?.why).toContain("'<default>', not '<unvaried>'");

    // Proof the hazard is real: the row the omission prevented would have been
    // ACCEPTED by the shared builder, duplicating the worst-wins roll-up.
    const wouldHaveBeenWritten: TestResultVariant = {
      key: variantKeyFor({}, { environment: UNVARIED, role: UNVARIED }),
      status: 'PASSED',
      durationMs: 5,
      errorMessage: null,
      retriedAndPassed: false,
    };
    expect(planMeasurements(PARENT, [wouldHaveBeenWritten], []).ok).toBe(true);
  });

  it('keeps an unvaried cell when the ENVIRONMENT is what varied', () => {
    const planned = plan([{}]);
    const { variants, omitted } = variantsFor(planned, context, [
      { cell: {}, status: 'PASSED', durationMs: 5 },
    ]);
    expect(omitted).toEqual([]);
    expect(variants).toHaveLength(1);
  });

  it('gives a refused cell a row, with the typed reason and NO error message', () => {
    /*
     * A REFUSED surface and one that DOES NOT EXIST must not be recorded the same
     * way. And `errorMessage` is null because `planMeasurements` refuses a cell
     * carrying both, there being one message column — sending both would lose the
     * run over a reporting problem.
     */
    const planned = plan([CHROMIUM, WEBKIT], { engines: { chromium: true, webkit: false } });
    const { variants } = variantsFor(planned, context, [
      { cell: CHROMIUM, status: 'PASSED', durationMs: 50 },
    ]);
    const refused = variants.find((variant) => variant.key.browser === 'webkit');
    expect(refused?.status).toBe('SKIPPED');
    expect(refused?.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(refused?.errorMessage).toBeNull();
  });

  it('reports a planned cell with no outcome as NOT_RUN, never as a failure', () => {
    // Our runner losing a result is not a defect in the customer's application.
    const planned = plan([CHROMIUM], { engines: { chromium: true } });
    const { variants } = variantsFor(planned, context, []);
    expect(variants[0]?.status).toBe('SKIPPED');
    expect(variants[0]?.notRun?.kind).toBe('NOT_RUN');
    expect(variants[0]?.notRun?.why).toContain('not a pass and it is not a failure');
  });

  it('produces rows the one shared row builder accepts', () => {
    /*
     * The integration that matters: these rows are written by `planMeasurements`,
     * which has six refusals of its own. A resolver whose output that builder
     * rejects is a resolver whose results never reach the database.
     */
    const planned = plan([CHROMIUM, FIREFOX, WEBKIT], {
      engines: { chromium: true, firefox: true, webkit: false },
    });
    const { variants } = variantsFor(planned, context, [
      { cell: CHROMIUM, status: 'PASSED', durationMs: 100 },
      { cell: FIREFOX, status: 'FAILED', durationMs: 80, errorMessage: 'boom' },
    ]);
    const result = planMeasurements(PARENT, variants, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.variants).toHaveLength(3);
      expect(result.variants.map((row) => row.notRunKind)).toEqual([null, null, 'BLOCKED_BY_ENV']);
      // The not-run sentence survives, tagged, in the one message column.
      expect(result.variants[2]?.errorMessage).toContain('[BLOCKED_BY_ENV]');
    }
  });
});

// ─── Rolling up ──────────────────────────────────────────────────────────────

describe('rollUpVerdict', () => {
  const cell = (
    browser: string,
    status: TestResultVariant['status'],
    notRun?: TestResultVariant['notRun'],
  ): TestResultVariant => ({
    key: { browser, viewport: UNVARIED, locale: UNVARIED, role: 'admin', environment: 'env_1' },
    status,
    durationMs: 1,
    errorMessage: null,
    retriedAndPassed: false,
    notRun: notRun ?? null,
  });

  it('takes the worst of the scored cells', () => {
    const verdict = rollUpVerdict([
      cell('chromium', 'PASSED'),
      cell('firefox', 'FAILED'),
      cell('webkit', 'PASSED'),
    ]);
    expect(verdict.status).toBe('FAILED');
    expect(verdict.scored).toBe(3);
    expect(verdict.notRun).toBe(0);
    expect(verdict.parentNotRun).toBeNull();
  });

  it('EXCLUDES a not-run cell, so an uninstalled browser cannot fail a test', () => {
    const verdict = rollUpVerdict([
      cell('chromium', 'PASSED'),
      cell('webkit', 'SKIPPED', { kind: 'BLOCKED_BY_ENV', why: 'no webkit here' }),
    ]);
    expect(verdict.status).toBe('PASSED');
    expect(verdict.scored).toBe(1);
    expect(verdict.notRun).toBe(1);
    expect(verdict.rule).toContain('not a defect in the application under test');
  });

  it('does not let a not-run cell be mistaken for a pass either — the counts say so', () => {
    // A status alone cannot carry "two of three cells ran". The counts can, which
    // is why they are part of the answer rather than something a caller recomputes.
    const verdict = rollUpVerdict([
      cell('chromium', 'PASSED'),
      cell('firefox', 'SKIPPED', { kind: 'BLOCKED_BY_ENV', why: 'no firefox' }),
      cell('webkit', 'SKIPPED', { kind: 'UNSUPPORTED', why: 'needs a grid' }),
    ]);
    expect(verdict.status).toBe('PASSED');
    expect(verdict.scored).toBe(1);
    expect(verdict.notRun).toBe(2);
  });

  it('makes the PARENT a not-run when every cell was one, with the strongest reason', () => {
    /*
     * UNSUPPORTED over BLOCKED_BY_ENV: "no install will ever satisfy this" is the
     * fact the reader needs, and reporting the weaker one would hide it. PASSED
     * (nothing failed) and FAILED (nothing passed) are both claims about an
     * application nothing was executed against.
     */
    const verdict = rollUpVerdict([
      cell('firefox', 'SKIPPED', { kind: 'BLOCKED_BY_ENV', why: 'no firefox here' }),
      cell('webkit', 'SKIPPED', { kind: 'UNSUPPORTED', why: 'needs a browser grid' }),
    ]);
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.scored).toBe(0);
    expect(verdict.parentNotRun?.kind).toBe('UNSUPPORTED');
    expect(verdict.parentNotRun?.why).toContain('neither a pass nor a failure');
  });

  it('reports no cells as NOT_RUN rather than as a verdict', () => {
    const verdict = rollUpVerdict([]);
    expect(verdict.parentNotRun?.kind).toBe('NOT_RUN');
    expect(verdict.scored).toBe(0);
  });

  it('prefers a timeout to a failure, so the unknown cause is seen first', () => {
    expect(
      rollUpVerdict([cell('chromium', 'FAILED'), cell('firefox', 'TIMED_OUT')]).status,
    ).toBe('TIMED_OUT');
  });

  it('lets one flaky cell surface above the cells that passed', () => {
    expect(rollUpVerdict([cell('chromium', 'PASSED'), cell('firefox', 'FLAKY')]).status).toBe(
      'FLAKY',
    );
  });
});

// ─── The visual matrix ───────────────────────────────────────────────────────

describe('floorCellFor keeps every approved baseline matching', () => {
  it('is byte-identical to the pre-matrix writer for the default spec', () => {
    /*
     * plugins/visual.ts writes `viewport: `${width}x${height}`` and
     * `browser: 'chromium'`. If either string moves by one character, every
     * baseline a customer has ever approved stops matching on the first run after
     * the upgrade and they are forced into a re-approval sweep.
     */
    const floor = floorCellFor({ width: 1280, height: 800 });
    expect(baselineViewportKey(floor, 'DEFAULT')).toBe('1280x800');
    expect(variantBrowserKey(floor)).toBe('chromium');
  });

  it('names chromium explicitly, because an absent engine keys as <default>', () => {
    expect(variantBrowserKey({ device: floorCellFor({ width: 1280, height: 800 }).device })).toBe(
      '<default>',
    );
  });

  it('separates every named state from the default under the same four-column key', () => {
    const floor = floorCellFor({ width: 1280, height: 800 });
    const keys = (['DEFAULT', 'ERROR', 'LOADING', 'EMPTY'] as const).map((state) =>
      baselineViewportKey(floor, state),
    );
    expect(new Set(keys).size).toBe(4);
    expect(keys).toEqual(['1280x800', '1280x800#ERROR', '1280x800#LOADING', '1280x800#EMPTY']);
  });

  it('separates light from dark, which would otherwise upsert onto one row', () => {
    const light = baselineViewportKey({ ...CHROMIUM, colourScheme: 'LIGHT' }, 'DEFAULT');
    const dark = baselineViewportKey({ ...CHROMIUM, colourScheme: 'DARK' }, 'DEFAULT');
    expect(light).not.toBe(dark);
  });
});

describe('planVisualCaptures', () => {
  it('captures the page as it arrives when no state was named', () => {
    const plans = planVisualCaptures([CHROMIUM]);
    expect(plans.map((entry) => entry.state)).toEqual(['DEFAULT']);
  });

  it('pairs every cell with every named state, in declared order', () => {
    const plans = planVisualCaptures([CHROMIUM, FIREFOX], ['DEFAULT', 'ERROR']);
    expect(plans.map((entry) => `${variantBrowserKey(entry.cell)}/${entry.state}`)).toEqual([
      'chromium/DEFAULT',
      'chromium/ERROR',
      'firefox/DEFAULT',
      'firefox/ERROR',
    ]);
  });

  it('carries the baseline keys the writer will use', () => {
    const [first] = planVisualCaptures([floorCellFor({ width: 375, height: 812 })], ['HOVER']);
    expect(first?.baselineViewport).toBe('375x812#HOVER');
    expect(first?.baselineBrowser).toBe('chromium');
  });
});

describe('recordCapture refuses the worst outcome a visual matrix has', () => {
  const capturePlan: VisualCapturePlan = {
    cell: CHROMIUM,
    state: 'ERROR',
    baselineViewport: '1280x800#ERROR',
    baselineBrowser: 'chromium',
  };

  it('keeps the image for a state that was actually on screen', () => {
    const record = recordCapture({
      plan: capturePlan,
      outcome: { reached: true },
      imageKey: 'visual/a.png',
      environmentId: 'env_1',
    });
    expect(record.reached).toBe(true);
    expect(record.imageKey).toBe('visual/a.png');
    expect(record.unreachedReason).toBeNull();
    expect(record.imageDiscarded).toBe(false);
    expect(mayWriteBaseline(record)).toBe(true);
  });

  it('DISCARDS an image for a state that was never on screen, and says it did', () => {
    /*
     * The failure mode that gets worse with time: the capture is of the DEFAULT
     * rendering, it looks fine, somebody approves it, and the baseline asserts
     * the ERROR state for ever while the real one stays untested behind a green
     * row. Every future run of that cell passes.
     */
    const record = recordCapture({
      plan: capturePlan,
      outcome: {
        reached: false,
        reason: 'NO_TRIGGER_FOUND',
        detail: 'nothing on the page submits the form',
      },
      imageKey: 'visual/wrong.png',
      environmentId: 'env_1',
    });
    expect(record.imageKey).toBeNull();
    expect(record.imageDiscarded).toBe(true);
    expect(record.discardReason).toContain('falsely green, permanently');
    expect(mayWriteBaseline(record)).toBe(false);
  });

  it.each([
    'NO_TRIGGER_FOUND',
    'TRIGGER_NOT_VISIBLE',
    'REQUIRES_DATA',
    'REQUIRES_PRINCIPAL',
    'ENGINE_CANNOT_SIMULATE',
    'TIMED_OUT',
    'NOT_ATTEMPTED',
  ] as const)('drops the image for %s, asking the keystone rather than re-deciding', (reason) => {
    const record = recordCapture({
      plan: capturePlan,
      outcome: { reached: false, reason, detail: 'why' },
      imageKey: 'visual/wrong.png',
      environmentId: 'env_1',
    });
    expect(record.imageKey).toBeNull();
    expect(mayWriteBaseline(record)).toBe(false);
  });

  it('refuses a baseline for a reached state whose capture produced nothing', () => {
    // A writer that checked only `reached` would try to persist a null key.
    const record = recordCapture({
      plan: capturePlan,
      outcome: { reached: true },
      imageKey: null,
      environmentId: 'env_1',
    });
    expect(mayWriteBaseline(record)).toBe(false);
  });

  it('produces evidence the stored shape accepts, in every case', () => {
    /*
     * `visualCaptureSchema` carries four refinements of its own, including the one
     * that refuses an image beside a never-on-screen reason. A recorder whose
     * output that schema rejects is a recorder whose evidence never gets stored.
     */
    const outcomes: readonly StateReachOutcome[] = [
      { reached: true },
      { reached: false, reason: 'NO_TRIGGER_FOUND', detail: 'no submit control' },
      { reached: false, reason: 'TIMED_OUT', detail: 'the wait for the skeleton expired' },
    ];
    for (const outcome of outcomes) {
      const record = recordCapture({
        plan: capturePlan,
        outcome,
        imageKey: 'visual/a.png',
        environmentId: 'env_1',
      });
      const parsed = visualCaptureSchema.safeParse({
        cell: record.cell,
        state: record.state,
        reached: record.reached,
        ...(record.unreachedReason === null ? {} : { unreachedReason: record.unreachedReason }),
        ...(record.unreachedDetail === null ? {} : { unreachedDetail: record.unreachedDetail }),
        imageKey: record.imageKey,
        environmentId: record.environmentId,
      });
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    }
  });
});

describe('runVisualMatrix', () => {
  const states: readonly InteractionState[] = ['DEFAULT', 'ERROR'];

  it('keeps a refused CELL apart from an unreached STATE', () => {
    /*
     * UNREACHED is a fact about the application's surface ("nothing opens that
     * menu"); NOT_RUN is a fact about this image ("there is no WebKit here").
     * Recording them the same way would put our missing binary into the
     * customer's defect list.
     */
    const planned = plan([CHROMIUM, WEBKIT], { engines: { chromium: true, webkit: false } });
    return runVisualMatrix({
      plan: planned,
      states,
      environmentId: 'env_1',
      reach: (entry) =>
        entry.state === 'ERROR'
          ? { reached: false, reason: 'NO_TRIGGER_FOUND', detail: 'no submit control' }
          : { reached: true },
      capture: () => 'visual/a.png',
    }).then((result) => {
      expect(result.notRun).toHaveLength(2);
      expect(result.notRun.every((entry) => entry.notRun.kind === 'BLOCKED_BY_ENV')).toBe(true);
      expect(result.captures).toHaveLength(2);
      expect(result.reached).toBe(1);
      const unreached = result.captures.find((record) => !record.reached);
      expect(unreached?.unreachedReason).toBe('NO_TRIGGER_FOUND');
      // Not discarded: no capture was ever taken for it, which is different.
      expect(unreached?.imageDiscarded).toBe(false);
    });
  });

  it('does not even ATTEMPT a capture for a state it could not reach', async () => {
    /*
     * Relying on `recordCapture` to drop the image would work and would also put
     * a picture of the wrong rendering into the artifact store, where a later
     * reader can pick it up as evidence of the named state.
     */
    const captured: string[] = [];
    await runVisualMatrix({
      plan: plan([CHROMIUM], { engines: { chromium: true } }),
      states,
      environmentId: 'env_1',
      reach: (entry) =>
        entry.state === 'ERROR'
          ? { reached: false, reason: 'REQUIRES_DATA', detail: 'the fixture seeded no rows' }
          : { reached: true },
      capture: (entry) => {
        captured.push(entry.state);
        return 'visual/a.png';
      },
    });
    expect(captured).toEqual(['DEFAULT']);
  });

  it('survives a reacher that throws, and loses no other cell to it', async () => {
    const result = await runVisualMatrix({
      plan: plan([CHROMIUM, FIREFOX], { engines: { chromium: true, firefox: true } }),
      states: ['DEFAULT'],
      environmentId: 'env_1',
      reach: (entry) => {
        if (variantBrowserKey(entry.cell) === 'chromium') throw new Error('page crashed');
        return { reached: true };
      },
      capture: () => 'visual/a.png',
    });
    expect(result.captures).toHaveLength(2);
    expect(result.captures[0]?.unreachedReason).toBe('ENGINE_CANNOT_SIMULATE');
    expect(result.captures[0]?.unreachedDetail).toContain('page crashed');
    expect(result.captures[1]?.reached).toBe(true);
  });

  it('survives a capturer that throws, and records that the state WAS reached', async () => {
    const result = await runVisualMatrix({
      plan: plan([CHROMIUM], { engines: { chromium: true } }),
      states: ['DEFAULT'],
      environmentId: 'env_1',
      reach: () => ({ reached: true }),
      capture: () => {
        throw new Error('artifact store refused the upload');
      },
    });
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]?.imageKey).toBeNull();
    expect(result.captures[0]?.unreachedDetail).toContain('was reached and the capture failed');
    expect(mayWriteBaseline(result.captures[0]!)).toBe(false);
  });

  it('handles an async reacher and capturer, which is what the real adapter is', async () => {
    const result = await runVisualMatrix({
      plan: plan([CHROMIUM], { engines: { chromium: true } }),
      states: ['DEFAULT'],
      environmentId: 'env_1',
      reach: () => Promise.resolve<StateReachOutcome>({ reached: true }),
      capture: () => Promise.resolve('visual/a.png'),
    });
    expect(result.captures[0]?.imageKey).toBe('visual/a.png');
    expect(result.reached).toBe(1);
  });

  it('counts the discards, so a report can show them', async () => {
    /*
     * A capturer that hands back a key for a state that was not reached is a bug
     * in an adapter, and this is the arrangement that makes the bug VISIBLE
     * rather than silently absorbed.
     */
    const planned = plan([CHROMIUM], { engines: { chromium: true } });
    const record = recordCapture({
      plan: planVisualCaptures([CHROMIUM], ['ERROR'])[0]!,
      outcome: { reached: false, reason: 'TIMED_OUT', detail: 'expired' },
      imageKey: 'visual/wrong.png',
      environmentId: 'env_1',
    });
    expect(record.imageDiscarded).toBe(true);

    const result = await runVisualMatrix({
      plan: planned,
      states: ['DEFAULT'],
      environmentId: 'env_1',
      reach: () => ({ reached: true }),
      capture: () => 'visual/a.png',
    });
    expect(result.discarded).toBe(0);
  });
});
