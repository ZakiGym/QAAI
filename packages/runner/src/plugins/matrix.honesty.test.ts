/**
 * What the matrix plugins' rows SAY about a cell, driven through the validators
 * the worker and the agent route both run.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM matrix.test.ts ─────────────────────────
 *
 * That file proves the JOIN between the plans and the write path (every key a
 * shipped plan produces is a key the schema admits). This one proves what the
 * five honesty columns CLAIM, which is a different question and the one the
 * columns exist for: `notAsserted: []` beside a non-null `cellStatus` reads as
 * "this cell made every assertion the test contains". That reading was true for
 * a cell that ran and FALSE for one that did not — `evidenceFor` wrote the same
 * empty list on every row, including the rows stored beside `status: SKIPPED`
 * for a cell the harness refused to run. A zero where the honest answer was
 * "the whole test, and here is why not".
 *
 * Every row below goes through `testResultVariantSchema` and `planMeasurements`
 * and not just through `variantsFor`, because the producer being right and the
 * validator being right are two facts, and a matrix is refused WHOLE on the
 * first cell that disagrees.
 */

import { describe, expect, it } from 'vitest';
import {
  MATRIX_CELL_STATUSES,
  MAX_VARIANT_ERROR_MESSAGE,
  NOT_RUN_KINDS,
  UNASSERTED_REASON_LIST,
  planMeasurements,
  testResultVariantCellSchema,
  testResultVariantSchema,
  unassertedReasonSchema,
} from '@qaai/shared';
import type {
  ArtifactSink,
  ExecutableTest,
  MatrixCellResolution,
  RunContext,
  TestExecution,
} from '@qaai/shared';
import { fitCellMessage, planMatrix, unassertedForUnrunCell, variantsFor } from '../matrix.js';
import { crossBrowserPlan, runMatrixCells } from './matrix.js';

const PARENT = {
  orgId: 'org_1',
  projectId: 'proj_1',
  runId: 'run_1',
  testId: 'test_1',
  testResultId: 'tr_1',
} as const;

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

function makeContext(): RunContext {
  return {
    runId: 'run_matrix_honesty',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_staging',
    baseUrl: 'http://127.0.0.1:1',
    secrets: {},
    storageState: null,
    artifacts,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, step: () => {} },
    signal: new AbortController().signal,
    determinism: { freezeClockAt: null, randomSeed: 1, waitForNetworkIdle: false, retryOnce: false },
  };
}

const TEST: ExecutableTest = {
  id: 'test_1',
  name: 'checkout renders',
  type: 'CROSS_BROWSER',
  code: '',
  filePath: 'matrix/checkout.json',
  spec: {},
  timeoutMs: 60_000,
  quarantined: false,
  tags: [],
};

function execution(over: Partial<TestExecution>): TestExecution {
  return {
    testId: 'test_1',
    status: 'PASSED',
    durationMs: 5,
    steps: [],
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    errorMessage: null,
    retriedAndPassed: false,
    findings: [],
    ...over,
  };
}

describe('a cell that did not run does not claim to have asserted everything', () => {
  it('lists the whole test as unasserted for a cell the harness refused', () => {
    /*
     * The harness carries browserName, locale and timezoneId and nothing else, so
     * a dark-mode cell is refused as UNSUPPORTED and stored SKIPPED. It executed
     * nothing. Before this, its row said `notAsserted: []`.
     */
    const plan = crossBrowserPlan(
      { browsers: ['chromium'], matrix: { engines: ['chromium'], colourSchemes: ['DARK'] } },
      'seed',
    );
    expect(plan.refused).toHaveLength(1);
    const { variants } = variantsFor(plan, { environment: 'env_1' }, []);
    expect(variants).toHaveLength(1);
    const row = variants[0];
    expect(row?.status).toBe('SKIPPED');
    expect(row?.cell?.notAsserted.length).toBeGreaterThan(0);
    // Our missing plumbing, not an install and not a provider limit.
    expect(row?.cell?.notAssertedReason).toBe('NOT_IMPLEMENTED');
  });

  it('is stored: the row passes the validator and the planner, with the hole in the column', () => {
    const plan = crossBrowserPlan(
      { browsers: ['chromium'], matrix: { engines: ['chromium'], colourSchemes: ['DARK'] } },
      'seed',
    );
    const { variants } = variantsFor(plan, { environment: 'env_1' }, []);
    const parsed = variants.map((variant) => testResultVariantSchema.parse(variant));
    const written = planMeasurements(PARENT, parsed, []);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.variants).toHaveLength(1);
    expect(written.variants[0]?.notAsserted.length).toBeGreaterThan(0);
    expect(written.variants[0]?.notAssertedReason).toBe('NOT_IMPLEMENTED');
  });

  it('files a cell the deployment cannot run under CAPABILITY_ABSENT, not under our own gap', () => {
    // WebKit reported absent: a real MISSING, which `cellCounts` says leaves the
    // ratio. Our refusal to run it is a fact about the image, not about the harness.
    const plan = planMatrix({
      cells: [{ engine: 'webkit' }],
      seed: 'seed',
      maxCells: 5,
      deployment: { engines: { webkit: false } },
    });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.resolution.status).toBe('MISSING');
    const { variants } = variantsFor(plan, { environment: 'env_1' }, []);
    expect(variants[0]?.cell?.notAssertedReason).toBe('CAPABILITY_ABSENT');
    expect(variants[0]?.cell?.notAsserted.length).toBeGreaterThan(0);
  });

  it('files a planned cell that never reported under SURFACE_UNREACHED', () => {
    const plan = crossBrowserPlan({ browsers: ['chromium', 'webkit'] }, 'seed');
    // No outcomes at all: every planned cell is a row nobody wrote to.
    const { variants } = variantsFor(plan, { environment: 'env_1' }, []);
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      expect(variant.notRun?.kind).toBe('NOT_RUN');
      expect(variant.cell?.notAsserted.length).toBeGreaterThan(0);
      expect(variant.cell?.notAssertedReason).toBe('SURFACE_UNREACHED');
    }
  });

  it('stores the refused row of a channel axis that named no engine, hole and all', () => {
    /*
     * ── THE D2 DEFECT, ON THE PATH THAT WRITES THE ROW ────────────────────────
     *
     * A spec may declare `channels` and no `engines`, and until `engineAxisFor`
     * anchored it the plan produced `{ channel: 'MSEDGE_DEV' }` — keyed
     * `'<default>:MSEDGE_DEV'`, an angle bracket mid-composite, which both
     * ingest paths refuse. `validateMeasurements` refuses a matrix WHOLE on its
     * first bad cell, so the whole run's rows went with it: the refused channel
     * cell AND its perfectly storable BUNDLED sibling, for one logger.warn.
     *
     * Driven to `planMeasurements` and not to `variantsFor`, because the
     * producer being right and the validator accepting it are two facts, and
     * this file's subject is what the five columns claim once they are STORED.
     * The refusal here is still OUR missing plumbing — the generated Playwright
     * project has no `channel` field — so NOT_IMPLEMENTED, and the cell stays in
     * the denominator.
     */
    const plan = crossBrowserPlan(
      { browsers: ['chromium'], matrix: { channels: ['BUNDLED', 'MSEDGE_DEV'] } },
      'seed',
    );
    expect(plan.refused).toHaveLength(1);
    const { variants } = variantsFor(plan, { environment: 'env_1' }, []);
    const parsed = variants.map((variant) => testResultVariantSchema.parse(variant));
    const written = planMeasurements(PARENT, parsed, []);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    // BOTH cells: the refused one and the sibling it used to take down with it.
    // The sibling is NOT_RUN rather than passing — no outcome was reported for
    // it here — which is why the refused row is found by its KIND and not by
    // "the one with a kind".
    expect(written.variants).toHaveLength(2);
    expect(written.variants.map((row) => row.notRunKind)).toEqual(['NOT_RUN', 'UNSUPPORTED']);
    const refusedRow = written.variants.find((row) => row.notRunKind === 'UNSUPPORTED');
    expect(refusedRow?.notAssertedReason).toBe('NOT_IMPLEMENTED');
    expect(refusedRow?.notAsserted.length).toBeGreaterThan(0);
  });

  it('keeps the empty list for a cell that RAN — the claim stands where it is true', () => {
    const plan = crossBrowserPlan({ browsers: ['chromium', 'webkit'] }, 'seed');
    const { variants } = variantsFor(
      plan,
      { environment: 'env_1' },
      plan.runnable.map((execution) => ({
        cell: execution.cell,
        status: 'PASSED' as const,
        durationMs: 12,
      })),
    );
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      expect(variant.status).toBe('PASSED');
      expect(variant.cell?.notAsserted).toEqual([]);
      expect(variant.cell?.notAssertedReason).toBeNull();
    }
  });

  it('produces evidence the cell schema admits for every status and every kind', () => {
    /*
     * The presence record for the mapping: every (status, kind) pair this function
     * can be asked about yields a reason that is a member of the keystone's
     * vocabulary AND a cell the schema's two pairings (a list needs a reason, a
     * reason needs a list) accept. Derived from the exported lists, so a seventh
     * status or a fifth kind lengthens this loop instead of silently missing it.
     */
    for (const status of MATRIX_CELL_STATUSES) {
      for (const kind of NOT_RUN_KINDS) {
        const resolution: MatrixCellResolution = {
          status,
          detail: 'a detail',
          remedy: status === 'AVAILABLE' || status === 'NOT_CHECKED' ? null : 'a remedy',
        } as MatrixCellResolution;
        const unasserted = unassertedForUnrunCell(resolution, kind);
        expect(UNASSERTED_REASON_LIST).toContain(unasserted.reason);
        expect(unassertedReasonSchema.options).toContain(unasserted.reason);
        expect(unasserted.assertion.length).toBeGreaterThan(0);
        expect(unasserted.assertion.length).toBeLessThanOrEqual(300);
        const cell = testResultVariantCellSchema.safeParse({
          matrixCell: { engine: 'chromium' },
          cellStatus: status,
          cellRemedy: resolution.remedy,
          notAsserted: [unasserted.assertion],
          notAssertedReason: unasserted.reason,
        });
        expect(cell.success, `${status} / ${kind}`).toBe(true);
      }
    }
  });

  it('never quotes customer text in the sentence it writes to the column', () => {
    const plan = crossBrowserPlan(
      {
        browsers: ['chromium'],
        matrix: { engines: ['chromium'], locales: ['x-hostile-tag'], colourSchemes: ['DARK'] },
      },
      'seed',
    );
    const { variants } = variantsFor(plan, { environment: 'env_1' }, []);
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) {
      expect(JSON.stringify(variant.cell?.notAsserted)).not.toContain('x-hostile-tag');
    }
  });
});

describe('a long failure message costs one cell its tail, never the matrix its rows', () => {
  it('stores a failing cell whose message is longer than the row allows', async () => {
    /*
     * A Playwright assertion message carries its call log, and a strict-mode
     * violation lists every element it matched. Twelve thousand characters is not
     * exotic. The validator refuses a variant over the bound and the worker
     * refuses the matrix WHOLE, so this one webkit failure used to take the
     * passing chromium row down with it — exactly when a per-cell row mattered.
     */
    const plan = crossBrowserPlan({ browsers: ['chromium', 'webkit'] }, 'seed');
    const long = `expect(locator).toHaveText()\n${'Call log: '.padEnd(12_000, 'x')}`;
    const result = await runMatrixCells({
      ctx: makeContext(),
      test: TEST,
      plan,
      run: async ({ cell }) =>
        cell.engine === 'webkit'
          ? execution({ status: 'FAILED', errorMessage: long })
          : execution({ status: 'PASSED' }),
    });

    expect(result.variants).toHaveLength(2);
    const parsed = (result.variants ?? []).map((variant) => testResultVariantSchema.safeParse(variant));
    expect(parsed.map((entry) => entry.success)).toEqual([true, true]);

    const failing = (result.variants ?? []).find((variant) => variant.status === 'FAILED');
    expect(failing?.errorMessage?.length).toBeLessThanOrEqual(MAX_VARIANT_ERROR_MESSAGE);
    // Said, not silent: the marker names the original length.
    expect(failing?.errorMessage).toContain('shortened from');
    expect(failing?.errorMessage).toContain(String(long.length));
    // The head — what failed — is the part that survives.
    expect(failing?.errorMessage?.startsWith('expect(locator).toHaveText()')).toBe(true);

    const planned = planMeasurements(
      PARENT,
      (result.variants ?? []).map((variant) => testResultVariantSchema.parse(variant)),
      [],
    );
    expect(planned.ok).toBe(true);
  });

  it('leaves a message at the bound alone, and a null one null', () => {
    const exact = 'e'.repeat(MAX_VARIANT_ERROR_MESSAGE);
    expect(fitCellMessage(exact)).toBe(exact);
    expect(fitCellMessage(null)).toBeNull();
    expect(fitCellMessage(undefined)).toBeNull();
    expect(fitCellMessage('short')).toBe('short');
    const over = fitCellMessage('e'.repeat(MAX_VARIANT_ERROR_MESSAGE + 1));
    expect(over?.length).toBe(MAX_VARIANT_ERROR_MESSAGE);
  });
});
