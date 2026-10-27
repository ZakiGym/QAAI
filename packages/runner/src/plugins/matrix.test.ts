/**
 * The matrix plugin — the production caller `packages/runner/src/matrix.ts`
 * did not have.
 *
 * No browser and no Playwright here, and none is needed: `runMatrixCells` takes
 * the thing that runs a spec as an INJECTED function, so every path that matters
 * — per-cell verdicts, a refused cell excluded from worst-wins, every cell
 * refused, cancellation, an unhonourable axis — is driven with a fake that
 * returns a `TestExecution`. What a real Playwright run does with one project is
 * `playwright-harness.test.ts`'s subject and is not re-proved here.
 *
 * The test this file exists for is "keeps a chromium pass and a webkit failure
 * apart on their own variant rows". Before this round the plugin handed three
 * projects to one harness call, the harness reduced them worst-wins into one
 * `TestResult`, and "passes in Chromium, fails in WebKit" was stored as "failed".
 * `TestResultVariant` existed, the worker persisted it and the API served it, and
 * no plugin in the product ever emitted one.
 */

import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_ROLE,
  BROWSER_CHANNEL_LIST,
  CHANNEL_ENGINE,
  DEFAULT_ENGINE_KEY,
  UNVARIED,
  crossBrowserSpecSchema,
  planMeasurements,
  testResultVariantSchema,
  testVariantKeySchema,
  variedAxes,
} from '@qaai/shared';
import type {
  ArtifactSink,
  BrowserVersionRange,
  ExecutableTest,
  MatrixAxes,
  MatrixCell,
  RunContext,
  TestExecution,
  TestResultStatus,
  TestVariantKey,
} from '@qaai/shared';
import { planMatrix, variantsFor } from '../matrix.js';
import type { MatrixPlan } from '../matrix.js';
import {
  HARNESS_HONOURS,
  MATRIX_MAX_CELLS,
  VERSION_PIN_ENGINE,
  cellLabel,
  crossBrowserPlan,
  crossBrowserPlugin,
  engineAxisFor,
  harnessSupport,
  localizationPlan,
  projectForCell,
  refuseUnhonourableCells,
  runMatrixCells,
} from './matrix.js';
import type { CellRun } from './matrix.js';

/** A pin with a reason, because `BrowserVersionRange.why` is not optional. */
const VERSION_RANGE: BrowserVersionRange = {
  atLeast: '120',
  below: null,
  why: 'the dialog element only became stylable here',
};

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

function makeContext(signal = new AbortController().signal): RunContext {
  return {
    runId: 'run_matrix_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_staging',
    baseUrl: 'http://127.0.0.1:1',
    secrets: {},
    storageState: null,
    artifacts,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: () => {},
    },
    signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: true,
      retryOnce: false,
    },
  };
}

const test: ExecutableTest = {
  id: 't_matrix',
  name: 'the checkout page renders everywhere',
  type: 'CROSS_BROWSER',
  code: "import { test } from '@playwright/test';",
  filePath: 'tests/cross-browser/checkout.spec.ts',
  spec: {},
  timeoutMs: 30_000,
  quarantined: false,
  tags: [],
};

function execution(status: TestResultStatus, errorMessage: string | null = null): TestExecution {
  return {
    testId: test.id,
    status,
    durationMs: 11,
    steps: [
      {
        index: 0,
        title: 'Opened /checkout',
        status: status === 'PASSED' ? 'PASSED' : 'FAILED',
        startedAt: new Date().toISOString(),
        durationMs: 11,
        screenshotKey: null,
        error: null,
      },
    ],
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    errorMessage,
    retriedAndPassed: false,
    findings: [],
  };
}

/** A fake spec runner whose verdict depends on which engine the cell named. */
function runnerByEngine(verdicts: Readonly<Record<string, TestResultStatus>>): {
  run: (cell: CellRun) => Promise<TestExecution>;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    run: async ({ cell }) => {
      const engine = cell.engine ?? '<default>';
      seen.push(engine);
      const status = verdicts[engine] ?? 'PASSED';
      return execution(status, status === 'PASSED' ? null : `${engine} could not find the button`);
    },
  };
}

describe('a cell is a cell, and a verdict belongs to one', () => {
  it('keeps a chromium pass and a webkit failure apart on their own variant rows', async () => {
    const plan = crossBrowserPlan({ browsers: ['chromium', 'webkit'] }, 'seed');
    const { run, seen } = runnerByEngine({ chromium: 'PASSED', webkit: 'FAILED' });

    const result = await runMatrixCells({ ctx: makeContext(), test, plan, run });

    expect(seen).toEqual(['chromium', 'webkit']);
    expect(result.variants).toHaveLength(2);
    expect(result.variants?.map((variant) => [variant.key.browser, variant.status])).toEqual([
      ['chromium', 'PASSED'],
      ['webkit', 'FAILED'],
    ]);
    // Worst-wins on the PARENT, with the per-cell truth underneath it rather
        // than instead of it. Both halves, which is the whole point.
    expect(result.status).toBe('FAILED');
    expect(result.errorMessage).toContain('[webkit]');
  });

  it('carries the environment onto every row and never defaults it', () => {
    const plan = crossBrowserPlan({ browsers: ['chromium'] }, 'seed');
    expect(plan.runnable).toHaveLength(1);
    return runMatrixCells({
      ctx: makeContext(),
      test,
      plan,
      run: async () => execution('PASSED'),
    }).then((result) => {
      /*
       * `environmentId` and not a sentinel: the unique key used to be
       * (test, viewport, browser), so staging and production shared a row and
       * whichever ran first became the other's reference.
       */
      expect(result.variants?.[0]?.key.environment).toBe('env_staging');
      expect(result.variants?.[0]?.key.role).toBe(ANONYMOUS_ROLE);
      expect(result.variants?.[0]?.key.locale).toBe(UNVARIED);
    });
  });

  it("labels the row with the test's own profile rather than claiming it ran logged out", async () => {
    const plan = crossBrowserPlan({ browsers: ['chromium'] }, 'seed');
    const result = await runMatrixCells({
      ctx: makeContext(),
      test: { ...test, authProfileId: 'ap_admin' },
      plan,
      run: async () => execution('PASSED'),
    });
    expect(result.variants?.[0]?.key.role).toBe('ap_admin');
  });
});

describe('a browser this image does not have is not a product defect', () => {
  it('does not let a refused cell drag a passing test down, and says it was excluded', async () => {
    const plan = planMatrix({
      cells: [{ engine: 'chromium' }, { engine: 'webkit' }],
      seed: 'seed',
      maxCells: MATRIX_MAX_CELLS,
      deployment: { engines: { chromium: true, webkit: false } },
    });
    expect(plan.refused).toHaveLength(1);

    const { run, seen } = runnerByEngine({ chromium: 'PASSED' });
    const result = await runMatrixCells({ ctx: makeContext(), test, plan, run });

    // The missing binary was never launched, and the test is still green.
    expect(seen).toEqual(['chromium']);
    expect(result.status).toBe('PASSED');
    const webkitRow = result.variants?.find((variant) => variant.key.browser === 'webkit');
    expect(webkitRow?.status).toBe('SKIPPED');
    expect(webkitRow?.notRun?.kind).toBe('BLOCKED_BY_ENV');
    // And `errorMessage` stays null beside the typed not-run: `planMeasurements`
    // refuses a cell that reports both, there being one message column.
    expect(webkitRow?.errorMessage).toBeNull();
  });

  it('reports a matrix with nothing runnable as a not-run, never as a pass or a failure', async () => {
    const plan = planMatrix({
      cells: [{ engine: 'webkit' }, { engine: 'firefox' }],
      seed: 'seed',
      maxCells: MATRIX_MAX_CELLS,
      deployment: { engines: { webkit: false, firefox: false } },
    });

    const result = await runMatrixCells({
      ctx: makeContext(),
      test,
      plan,
      run: async () => {
        throw new Error('no cell should have been run');
      },
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(result.errorMessage).toContain('[BLOCKED_BY_ENV]');
  });

  it('stops at a cancelled signal and records the rest as not run rather than as skipped', async () => {
    const controller = new AbortController();
    controller.abort();
    const plan = crossBrowserPlan({ browsers: ['chromium', 'firefox'] }, 'seed');

    const result = await runMatrixCells({
      ctx: makeContext(controller.signal),
      test,
      plan,
      run: async () => {
        throw new Error('a cancelled run must launch nothing');
      },
    });

    expect(result.variants?.every((variant) => variant.notRun?.kind === 'NOT_RUN')).toBe(true);
    expect(result.console.some((entry) => entry.text.includes('cancelled after 0'))).toBe(true);
  });
});

describe('a cell this harness cannot express is refused, not mislabelled', () => {
  it('refuses a colour-scheme cell with the remedy, and keeps it in the denominator', () => {
    const plan = planMatrix({
      cells: [{ engine: 'chromium' }, { engine: 'chromium', colourScheme: 'DARK' }],
      seed: 'seed',
      maxCells: MATRIX_MAX_CELLS,
    });
    const scoredBefore = plan.denominator.scored;

    const narrowed = refuseUnhonourableCells(plan);

    expect(narrowed.runnable).toHaveLength(1);
    expect(narrowed.refused).toHaveLength(1);
    expect(narrowed.refused[0]?.notRun.kind).toBe('UNSUPPORTED');
    expect(narrowed.refused[0]?.notRun.why).toContain('colourScheme');
    expect(narrowed.refused[0]?.notRun.why).toContain('playwright-harness.ts');
    /*
     * A cell refused for OUR missing plumbing stays IN the denominator. Dropping
     * it would make the percentage rise because we stopped trying, which is the
     * one arithmetic this product cannot afford.
     */
    expect(narrowed.denominator.scored).toBe(scoredBefore);
    expect(narrowed.denominator.attempted).toBe(1);
    expect(narrowed.denominator.refused).toBe(1);
  });

  it('honours engine, locale and timezone and nothing it has not got a field for', () => {
    expect(harnessSupport({ engine: 'firefox', locale: 'de-DE', timezone: 'Europe/Berlin' }).honoured).toBe(
      true,
    );
    const cells: MatrixCell[] = [
      { engine: 'chromium', reducedMotion: 'REDUCE' },
      { engine: 'chromium', forcedColors: 'ACTIVE' },
      { engine: 'chromium', channel: 'CHROME_BETA' },
      { device: { kind: 'PRESET', preset: 'IPHONE_14' } },
      { engine: 'chromium', version: { kind: 'RANGE', range: VERSION_RANGE } },
    ];
    for (const cell of cells) {
      expect(harnessSupport(cell).honoured).toBe(false);
    }
  });

  it('keeps its honoured-axis record in step with the cell vocabulary', () => {
    /*
     * RUN-TIME PARITY against `variedAxes`, which is the only authority on what
     * a cell can vary. The compiler already refuses a tenth key missing from
     * `HARNESS_HONOURS`; this is the other half — a key here that `variedAxes`
     * never reports would be an axis this file believes in and the vocabulary
     * does not, so `harnessSupport` would silently honour something that cannot
     * reach it.
     */
    const everything: MatrixCell = {
      engine: 'chromium',
      channel: 'CHROME',
      version: { kind: 'RANGE', range: VERSION_RANGE },
      device: { kind: 'PRESET', preset: 'IPHONE_14' },
      colourScheme: 'DARK',
      reducedMotion: 'REDUCE',
      forcedColors: 'ACTIVE',
      locale: 'de-DE',
      timezone: 'Europe/Berlin',
    };
    expect(new Set(variedAxes(everything))).toEqual(new Set(Object.keys(HARNESS_HONOURS)));
  });

  it('composes a refusal the WRITE PATH accepts, for every axis it can refuse at once', () => {
    /*
     * THE DEFECT THIS PINS, which cost a round: the refusal sentence is 482
     * characters of template plus the axis names, and `notRun.why` on
     * `testResultVariantSchema` was bounded at 500. One unhonourable axis fit.
     * Two did not — `colourScheme, reducedMotion` is 509 — and
     * `validateMeasurements` refuses a matrix WHOLE on its first bad cell, so a
     * CROSS_BROWSER spec declaring `colourSchemes` beside `reducedMotion` wrote
     * ZERO variant rows for the whole run for one log line. Every existing test
     * drove a cell varying exactly ONE axis, so nothing was red.
     *
     * Driven as a PLAN through `variantsFor` and then through the shared
     * validator, because that is the chain apps/worker/src/processors/run.ts and
     * apps/api/src/routes/runners.ts both run: asserting a length here would
     * pin this file's arithmetic against a number copied from the schema, and
     * the schema is what has to accept it.
     *
     * The cell is DERIVED from `HARNESS_HONOURS`, not hand-written, so a
     * seventh unhonourable axis lengthens this sentence and fails HERE rather
     * than in production.
     */
    const everyRefusableAxis: MatrixCell = {
      /*
       * The engine is NAMED even though it is the one axis the harness honours.
       * `matrixCellSchema` refuses a channel or a version with no engine — a
       * version range is a claim about one engine's release train — so a cell
       * without it could never reach a column, and a test built on one would
       * prove nothing about what the write path accepts.
       */
      engine: 'chromium',
      channel: 'CHROME',
      version: { kind: 'RANGE', range: VERSION_RANGE },
      device: { kind: 'PRESET', preset: 'IPHONE_14' },
      colourScheme: 'DARK',
      reducedMotion: 'REDUCE',
      forcedColors: 'ACTIVE',
    };
    const unhonourable = Object.entries(HARNESS_HONOURS)
      .filter(([, honoured]) => !honoured)
      .map(([axis]) => axis);
    const support = harnessSupport(everyRefusableAxis);
    expect(support.honoured).toBe(false);
    // Every axis it can refuse, IN the sentence — which is what makes the
    // sentence as long as it can get, and therefore what this test measures.
    for (const axis of unhonourable) {
      expect(support.honoured ? '' : support.why).toContain(axis);
    }

    const plan = refuseUnhonourableCells(
      planMatrix({ cells: [everyRefusableAxis], seed: 'seed', maxCells: 8 }),
    );
    expect(plan.refused).toHaveLength(1);

    const { variants } = variantsFor(plan, { environment: 'env-1' }, []);
    expect(variants).toHaveLength(1);
    for (const variant of variants) {
      const parsed = testResultVariantSchema.safeParse(variant);
      // The PATHS, never the sentence: a failure here must name the field, the
      // way `validateMeasurements` does, rather than print a refusal nobody can
      // read in a diff.
      expect(
        parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
      ).toEqual([]);
    }
  });

  it('leaves a plan it can honour entirely alone, object identity included', () => {
    const plan = crossBrowserPlan({ browsers: ['chromium', 'firefox'] }, 'seed');
    // Identity, not deep equality: a needless copy is how a `denominator`
    // recount lands on a plan that did not need one.
    expect(refuseUnhonourableCells(plan)).toBe(plan);
  });
});

describe('what the declaration means', () => {
  it('builds one project per engine, byte-identical to the pre-matrix one', () => {
    expect(projectForCell({ engine: 'chromium' })).toEqual({
      name: 'chromium',
      browserName: 'chromium',
    });
  });

  it('puts a locale and its timezone in one project and leaves the engine to the config', () => {
    expect(projectForCell({ locale: 'de-DE', timezone: 'Europe/Berlin' })).toEqual({
      name: 'de-DE-Europe-Berlin',
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
    });
  });

  it('names a localisation cell by what varies, not by the default-engine sentinel', () => {
    expect(cellLabel({ locale: 'de-DE' })).toBe('de-DE');
    expect(cellLabel({ engine: 'webkit' })).toBe('webkit');
  });

  it('forces chromium into a declared engine axis', () => {
    expect(engineAxisFor({ engines: ['webkit'] })).toEqual({ engines: ['chromium', 'webkit'] });
    expect(engineAxisFor({ engines: ['chromium', 'firefox'] })).toEqual({
      engines: ['chromium', 'firefox'],
    });
  });

  it('leaves an absent engine axis absent for every axis that names no engine', () => {
    /*
     * An absent engine axis means "whatever this deployment launches", the
     * generated config launches chromium, and adding the axis would turn a
     * deliberate don't-care into a claim about the engine. `'<default>'` is the
     * real answer for these cells, not a gap — which is what every LOCALIZATION
     * cell is.
     */
    expect(engineAxisFor({})).toEqual({});
    expect(engineAxisFor({ locales: ['de-DE'], timezones: ['Europe/Berlin'] })).toEqual({});
    expect(engineAxisFor({ devices: [{ kind: 'PRESET', preset: 'IPHONE_14' }] })).toEqual({});
    expect(engineAxisFor({ colourSchemes: ['DARK'], forcedColors: ['ACTIVE'] })).toEqual({});
    /*
     * BUNDLED and UNPINNED anchor NOTHING, and that is the whole reason this
     * function is a per-value question rather than a per-axis one. Both mean
     * "the build this deployment already runs" — `matrixCellSchema` exempts
     * them from its two engine refinements for exactly that reason — so forcing
     * chromium here would invent a claim, and `variantBrowserKey` already keys
     * both as `'<default>'`, byte-identical to before this repair.
     */
    expect(engineAxisFor({ channels: ['BUNDLED'] })).toEqual({});
    expect(engineAxisFor({ versions: [{ kind: 'UNPINNED' }] })).toEqual({});
  });

  it('anchors a channel or a version RANGE that declared no engine, asking CHANNEL_ENGINE', () => {
    /*
     * THE D2 DEFECT. A channel or a version range is a statement ABOUT an
     * engine, so the don't-care is not available: the cell `{ channel: 'MSEDGE_DEV' }`
     * keys `'<default>:MSEDGE_DEV'`, an angle bracket mid-composite, which both
     * ingest paths refuse — and a matrix is refused WHOLE on its first bad cell,
     * so the run wrote zero rows behind one log line.
     *
     * The engine is read out of `CHANNEL_ENGINE` here rather than spelled, so a
     * channel of some other engine anchors to ITS engine rather than being
     * filed under a chromium build nobody launched.
     */
    for (const channel of BROWSER_CHANNEL_LIST) {
      const owner = CHANNEL_ENGINE[channel];
      expect(engineAxisFor({ channels: [channel] })).toEqual(
        owner === null ? {} : { engines: [owner] },
      );
    }

    expect(engineAxisFor({ versions: [{ kind: 'RANGE', range: VERSION_RANGE }] })).toEqual({
      engines: [VERSION_PIN_ENGINE],
    });

    // One anchored value is enough to anchor the axis: its unanchored siblings
    // cross with the same engine, and the two keys stay distinct.
    expect(engineAxisFor({ channels: ['BUNDLED', 'MSEDGE_DEV'] })).toEqual({
      engines: ['chromium'],
    });
    expect(
      engineAxisFor({ versions: [{ kind: 'UNPINNED' }, { kind: 'RANGE', range: VERSION_RANGE }] }),
    ).toEqual({ engines: [VERSION_PIN_ENGINE] });
  });

  it('keeps the anchored BUNDLED sibling runnable and its project byte-identical', () => {
    /*
     * Naming the engine must not cost a cell its place in the numerator. The
     * BUNDLED sibling of an anchored channels axis is `{ engine: 'chromium',
     * channel: 'BUNDLED' }`, and `variedAxes` does not count a BUNDLED channel
     * as varied — so `harnessSupport` still honours it, it still RUNS, and the
     * project it produces is `{ name: 'chromium', browserName: 'chromium' }`:
     * byte for byte what `browserProjects` produced before the matrix existed,
     * which keeps the project name in every artifact path where it was.
     *
     * The refused sibling is the one carrying the channel, and it stays IN the
     * denominator — `scored` counts both cells.
     */
    const plan = crossBrowserPlan(
      { browsers: ['chromium'], matrix: { channels: ['BUNDLED', 'MSEDGE_DEV'] } },
      'seed',
    );
    expect(plan.runnable.map((execution) => execution.cell)).toEqual([
      { engine: 'chromium', channel: 'BUNDLED' },
    ]);
    expect(plan.refused.map((refusal) => refusal.cell.channel)).toEqual(['MSEDGE_DEV']);
    expect(projectForCell(plan.runnable[0]!.cell)).toEqual({
      name: 'chromium',
      browserName: 'chromium',
    });
    expect(plan.denominator.scored).toBe(2);
  });

  it('deduplicates a repeated browser instead of refusing the spec over a duplicate key', () => {
    const plan = crossBrowserPlan({ browsers: ['chromium', 'chromium', 'firefox'] }, 'seed');
    expect(plan.problems).toEqual([]);
    expect(plan.runnable.map((execution) => execution.cell.engine)).toEqual(['chromium', 'firefox']);
  });

  it('always includes chromium even when the spec names only another engine', () => {
    const plan = crossBrowserPlan({ browsers: ['webkit'] }, 'seed');
    expect(plan.runnable.map((execution) => execution.cell.engine)).toEqual(['chromium', 'webkit']);
  });

  it('treats each locale and timezone as a declared pairing, never as a cross product', () => {
    const plan = localizationPlan(
      {
        locales: [
          { tag: 'de-DE', timezone: 'Europe/Berlin' },
          { tag: 'ja-JP', timezone: 'Asia/Tokyo' },
        ],
      },
      'seed',
    );
    // TWO cells. A product of the two axes would be four and would assert
    // de-DE in Asia/Tokyo, which nobody declared.
    expect(plan.runnable).toHaveLength(2);
    expect(plan.runnable.map((execution) => execution.cell)).toEqual([
      { locale: 'de-DE', timezone: 'Europe/Berlin' },
      { locale: 'ja-JP', timezone: 'Asia/Tokyo' },
    ]);
  });

  it('refuses a declaration it could not read rather than running a prefix of it', async () => {
    const refused: MatrixPlan = planMatrix({
      cells: [{ engine: 'chromium' }, { engine: 'chromium' }],
      seed: 'seed',
      maxCells: MATRIX_MAX_CELLS,
    });
    expect(refused.problems.length).toBeGreaterThan(0);

    const result = await runMatrixCells({
      ctx: makeContext(),
      test,
      plan: refused,
      run: async () => {
        throw new Error('a plan with problems must run nothing');
      },
    });
    expect(result.status).toBe('SKIPPED');
    expect(result.notRun?.kind).toBe('NOT_RUN');
    /*
     * ABSENT, not an empty array. "This execution was not varied" is what
     * undefined means on this field, and an empty list would be the claim that
     * we looked at the cells and found none — which is not what happened.
     */
    expect(result.variants).toBeUndefined();
  });
});

describe('the plugins are still the plugins', () => {
  it('validates the two spec shapes and rejects a malformed one by name', () => {
    expect(() => crossBrowserPlugin.validate({ ...test, spec: { browsers: [] } })).toThrow(
      /invalid spec/,
    );
    expect(() => crossBrowserPlugin.validate({ ...test, spec: {} })).not.toThrow();
  });
});

/**
 * ── THE GATE THAT WAS MISSING, AND THE DEFECT IT LETS THROUGH ───────────────
 *
 * Everything above drives the plugin with hand-written cells, and so does
 * `matrix.test.ts` next door. Both were green while the two SHIPPED plans
 * produced variant keys that the write path REFUSES:
 *
 *   · `localizationPlan` makes cells of a locale and a timezone and no engine,
 *     so `variantBrowserKey` returns `'<default>'` — which `testVariantKeySchema`
 *     refused, because angle brackets are reserved for values that are exactly a
 *     sentinel.
 *   · a declared colour scheme, reduced-motion or forced-colors cell keyed as
 *     `'<unvaried>+dark'`, refused for the same reason.
 *
 * And `validateMeasurements` refuses a matrix WHOLE on its first bad cell —
 * there being no such thing as half a matrix — so the cost was not one bad row.
 * EVERY LOCALIZATION run wrote zero variant rows, and one dark cell in a
 * cross-browser matrix took every passing chromium row down with it. All of it
 * for one log line, with no red test, no disconnected module and nothing for
 * `check:wiring` to see: the producer was correct, the schema was correct, and
 * they disagreed about a vocabulary.
 *
 * So this suite asserts the JOIN rather than either side, and it drives the real
 * plans rather than a cell somebody chose: a test that picks its own cell picks
 * one that works, which is exactly how both halves shipped green.
 */
describe('every key the shipped plans produce is a key the write path accepts', () => {
  const context = { role: 'admin', environment: 'env_live_1' } as const;

  /** Every row of a plan, checked against the validator the worker runs. */
  const keysOf = (plan: MatrixPlan): Array<{ key: TestVariantKey; accepted: boolean }> =>
    variantsFor(plan, context, []).variants.map((variant) => ({
      key: variant.key,
      accepted: testVariantKeySchema.safeParse(variant.key).success,
    }));

  it('accepts every cell a LOCALIZATION spec declares, engine or no engine', () => {
    const plan = localizationPlan(
      { locales: [{ tag: 'de-DE', timezone: 'Europe/Berlin' }, { tag: 'fr-FR' }] },
      'seed',
    );
    const rows = keysOf(plan);
    expect(rows).toHaveLength(2);
    // The sentinel IS the right answer — a locale names no browser — so this
    // asserts it is produced AND admitted, not that it was avoided.
    expect(rows.map((row) => row.key.browser)).toEqual([DEFAULT_ENGINE_KEY, DEFAULT_ENGINE_KEY]);
    expect(rows.every((row) => row.accepted)).toBe(true);
  });

  it('accepts a declared rendering preference, on the refused row as well', () => {
    /*
     * The harness cannot express a colour scheme today, so this cell is REFUSED
     * by `refuseUnhonourableCells` — and a refused cell still gets a row, which
     * is the point of the row. The refused row carries a key too, so the
     * unaccepted key took the whole matrix down from the refusal path, not the
     * execution path. That is why this drives the refusal and not a pass.
     */
    const plan = crossBrowserPlan(
      { browsers: ['chromium'], matrix: { engines: ['chromium'], colourSchemes: ['DARK'] } },
      'seed',
    );
    expect(plan.refused).toHaveLength(1);
    const rows = keysOf(plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key.viewport).toBe('dark');
    expect(rows[0]?.accepted).toBe(true);
  });

  it('accepts every row of every plan these two plugins can build', () => {
    /*
     * The sweep, so a THIRD axis added to either plan cannot repeat this. Each
     * entry is a declaration a customer can write today; the assertion is that
     * no declaration produces a row the write path drops.
     */
    const plans: Array<readonly [string, MatrixPlan]> = [
      ['engines', crossBrowserPlan({ browsers: ['chromium', 'webkit', 'firefox'] }, 'seed')],
      [
        'engines + channel',
        crossBrowserPlan(
          { browsers: ['chromium'], matrix: { engines: ['chromium'], channels: ['CHROME'] } },
          'seed',
        ),
      ],
      [
        'engines + version pin',
        crossBrowserPlan(
          {
            browsers: ['chromium'],
            matrix: {
              engines: ['chromium'],
              versions: [{ kind: 'RANGE', range: VERSION_RANGE }],
            },
          },
          'seed',
        ),
      ],
      [
        'reduced motion',
        crossBrowserPlan(
          {
            browsers: ['chromium'],
            matrix: { engines: ['chromium'], reducedMotion: ['REDUCE'] },
          },
          'seed',
        ),
      ],
      [
        'forced colors',
        crossBrowserPlan(
          { browsers: ['chromium'], matrix: { engines: ['chromium'], forcedColors: ['ACTIVE'] } },
          'seed',
        ),
      ],
      [
        'device preset',
        crossBrowserPlan(
          {
            browsers: ['chromium'],
            matrix: { engines: ['chromium'], devices: [{ kind: 'PRESET', preset: 'IPHONE_14' }] },
          },
          'seed',
        ),
      ],
      ['locales only', localizationPlan({ locales: [{ tag: 'ja-JP' }] }, 'seed')],
      [
        'locale + timezone',
        localizationPlan({ locales: [{ tag: 'ar-EG', timezone: 'Africa/Cairo' }] }, 'seed'),
      ],
    ];

    const rejected: string[] = [];
    for (const [label, plan] of plans) {
      const rows = keysOf(plan);
      // A plan that produced no row at all would pass the acceptance check
      // vacuously, which is the one way this sweep could lie.
      expect(rows.length, `${label} produced no rows`).toBeGreaterThan(0);
      for (const row of rows) {
        if (!row.accepted) rejected.push(`${label}: ${row.key.browser} / ${row.key.viewport}`);
      }
    }
    expect(rejected).toEqual([]);
  });

  /**
   * One declaration per axis `crossBrowserSpecSchema` ACCEPTS, derived from that
   * schema's own shape and not from a list here.
   *
   * A mapped type over `MatrixAxes` with `-?`, so a TENTH AXIS IS A COMPILE
   * ERROR rather than an axis this sweep quietly never drives — the same reason
   * `HARNESS_HONOURS` is a `Record` — and the run-time parity against the spec
   * schema's keys below is the other half, for an axis renamed rather than
   * added.
   *
   * Two values wherever the vocabulary has a BOUNDARY in it, because that is
   * where the D2 defect lived: `channels` and `versions` each pair the value
   * that anchors an engine with the value that does NOT, so the sweep drives
   * both the anchored cell and its unanchored sibling and would catch either
   * one losing its row or the two colliding on one.
   */
  type AxisSamples = { [A in keyof MatrixAxes]-?: NonNullable<MatrixAxes[A]> };

  const AXIS_SAMPLES: AxisSamples = {
    engines: ['webkit'],
    channels: ['BUNDLED', 'MSEDGE_DEV'],
    versions: [{ kind: 'UNPINNED' }, { kind: 'RANGE', range: VERSION_RANGE }],
    devices: [{ kind: 'PRESET', preset: 'IPAD_PRO_11' }],
    colourSchemes: ['DARK'],
    reducedMotion: ['REDUCE'],
    forcedColors: ['ACTIVE'],
    locales: ['de-DE'],
    timezones: ['Europe/Berlin'],
  };

  it('drives every axis the spec schema accepts, and samples all of them', () => {
    /*
     * The sweep below is only as wide as this record, so the record has to be as
     * wide as the schema. An axis renamed in `matrixAxesSchema` is not a compile
     * error here — `MatrixAxes` is a hand-written interface beside it — so this
     * is the run-time half.
     */
    const declared = Object.keys(crossBrowserSpecSchema.shape.matrix.unwrap().shape);
    expect(new Set(Object.keys(AXIS_SAMPLES))).toEqual(new Set(declared));
  });

  it('stores every row of every single-axis declaration, engine named or not', () => {
    /*
     * ── THE D2 DEFECT, AND WHY NO EXISTING TEST SAW IT ────────────────────────
     *
     * `engineAxisWithChromium` forced chromium into a DECLARED engine axis and
     * not into an ABSENT one, so a spec naming `channels` or `versions` and no
     * `engines` produced engine-less cells: `{ channel: 'MSEDGE_DEV' }` keys
     * `'<default>:MSEDGE_DEV'` and `{ version: RANGE }` keys `'<default>@>=120'`,
     * and both ingest paths refuse those TWICE — at `key.browser`, because
     * `variantDimension` reserves an angle bracket for a value that is exactly a
     * sentinel, and at `cell.matrixCell.engine`. `validateMeasurements` refuses
     * a matrix WHOLE on its first bad cell, so such a run wrote ZERO variant
     * rows behind one logger.warn, and on the agent path the cell 400s a POST
     * carrying a whole batch of results.
     *
     * Every entry of the sweep above this one names `engines: ['chromium']`
     * explicitly, which is exactly how this shipped green. So this one names NO
     * engines at all, and it ENDS AT THE VALIDATOR rather than at the key: the
     * two paths that matter are `testResultVariantSchema` — what
     * apps/api/src/routes/runners.ts parses the whole batch through — and
     * `planMeasurements`, which both ingest paths run, and a test asserting the
     * key reads 'chromium:MSEDGE_DEV' would have proved neither.
     *
     * Reported as zod PATHS and never as the value: a variant key is
     * customer-authored text, the way `validateMeasurements` treats it.
     */
    const axes = Object.keys(AXIS_SAMPLES) as Array<keyof MatrixAxes>;
    const refused: string[] = [];

    for (const axis of axes) {
      // A computed key cannot be narrowed to one optional property, so the cast
      // is here rather than in the record, which stays fully typed.
      const matrix = { [axis]: AXIS_SAMPLES[axis] } as MatrixAxes;
      const spec = crossBrowserSpecSchema.parse({ browsers: ['chromium'], matrix });
      const plan = crossBrowserPlan(spec, 'seed');
      const { variants, omitted } = variantsFor(plan, context, []);

      // A plan with no rows would pass every acceptance check vacuously, and an
      // omission is a cell with no row at all — both are holes, not passes.
      expect(variants.length, `${axis} produced no rows`).toBeGreaterThan(0);
      expect(omitted.map((omission) => omission.why), `${axis} omitted a cell`).toEqual([]);

      const parsed = variants.map((variant) => testResultVariantSchema.safeParse(variant));
      for (const [index, result] of parsed.entries()) {
        if (!result.success) {
          refused.push(
            `${axis}[${index}]: ${result.error.issues
              .map((issue) => issue.path.join('.') || '(root)')
              .join(', ')}`,
          );
        }
      }
      if (parsed.every((result) => result.success)) {
        const written = planMeasurements(
          { orgId: 'org_1', projectId: 'proj_1', runId: 'run_1', testId: 't_1', testResultId: 'tr_1' },
          parsed.map((result) => result.data),
          [],
        );
        if (!written.ok) refused.push(`${axis}: planMeasurements refused`);
        else expect(written.variants, `${axis} lost a row in the plan`).toHaveLength(variants.length);
      }
    }

    expect(refused).toEqual([]);
  });

  it('keeps a cell that named no engine on the default sentinel, stored and not refused', () => {
    /*
     * The narrowness half of the repair, and it is a REAL ANSWER rather than a
     * gap: a locale, a timezone, a device and a rendering preference name no
     * browser, so `'<default>'` is what those cells key and the write path
     * admits it. Anchoring them to chromium would have turned a deliberate
     * don't-care into a claim about the engine — which is the defect in the
     * other direction, and it would be invisible because the row would store.
     */
    const plans: Array<readonly [string, MatrixPlan]> = [
      [
        'locale + timezone pairing',
        localizationPlan({ locales: [{ tag: 'de-DE', timezone: 'Europe/Berlin' }] }, 'seed'),
      ],
      ['locale alone', localizationPlan({ locales: [{ tag: 'fr-FR' }] }, 'seed')],
      [
        'device preset, no engines axis',
        crossBrowserPlan(
          {
            browsers: ['chromium'],
            matrix: { devices: [{ kind: 'PRESET', preset: 'IPAD_PRO_11' }] },
          },
          'seed',
        ),
      ],
      [
        'colour scheme, no engines axis',
        crossBrowserPlan({ browsers: ['chromium'], matrix: { colourSchemes: ['DARK'] } }, 'seed'),
      ],
      [
        'BUNDLED channel, which anchors nothing',
        crossBrowserPlan({ browsers: ['chromium'], matrix: { channels: ['BUNDLED'] } }, 'seed'),
      ],
      [
        'UNPINNED version, which anchors nothing',
        crossBrowserPlan(
          { browsers: ['chromium'], matrix: { versions: [{ kind: 'UNPINNED' }] } },
          'seed',
        ),
      ],
    ];

    for (const [label, plan] of plans) {
      const { variants } = variantsFor(plan, context, []);
      expect(variants.length, `${label} produced no rows`).toBeGreaterThan(0);
      for (const variant of variants) {
        expect(variant.key.browser, label).toBe(DEFAULT_ENGINE_KEY);
        expect(variant.cell?.matrixCell.engine, label).toBeUndefined();
        const parsed = testResultVariantSchema.safeParse(variant);
        expect(
          parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')),
          label,
        ).toEqual([]);
      }
    }
  });

  it('carries the resolved cell onto every row, so the honesty columns have a writer', () => {
    /*
     * The five columns — matrixCell, cellStatus, cellRemedy, notAsserted,
     * notAssertedReason — shipped with a migration, a schema, a row builder and
     * an index, and NO WRITER, so all five were NULL for ever and a pass with a
     * hole in it was indistinguishable from a pass. `variantsFor` is the one
     * producer that already held a full resolution per cell and emitted none of
     * it. Asserted through the real plans for the same reason as above.
     */
    const plan = crossBrowserPlan({ browsers: ['chromium', 'webkit'] }, 'seed');
    const { variants } = variantsFor(plan, context, []);
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      expect(variant.cell).toBeDefined();
      expect(variant.cell?.matrixCell).toBeDefined();
      // The STATUS, taken off the resolution and never off the verdict: "could
      // this deployment run this cell" and "what did running it conclude" are
      // different questions, and deriving one from the other is how a refused
      // cell collapses back into an ordinary SKIPPED.
      expect(variant.cell?.cellStatus).toBe('NOT_CHECKED');
      // NOT_CHECKED carries no remedy: there is no advice for a question
      // nobody asked, and the schema refuses one.
      expect(variant.cell?.cellRemedy).toBeNull();
    }
    expect(variants.map((variant) => variant.cell?.matrixCell)).toEqual([
      { engine: 'chromium' },
      { engine: 'webkit' },
    ]);
  });
});
