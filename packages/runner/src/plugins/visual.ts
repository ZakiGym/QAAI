/**
 * Visual regression (§4 VISUAL).
 *
 * Screenshot the page, compare it pixel-by-pixel against an approved baseline,
 * and fail when more of the image changed than the test allows. QAAI keeps its
 * own baselines rather than requiring Percy or Applitools — a visual test should
 * not need a second vendor and a second bill to work.
 *
 * Three decisions worth stating, because they are what makes visual testing
 * usable rather than a permanent source of false alarms:
 *
 *  - **The first run cannot fail.** With no baseline there is nothing to compare
 *    to, so the run captures one and passes, saying plainly that it did. A test
 *    that fails the first time it is ever run teaches people to ignore it.
 *  - **Animations are disabled and fonts are waited for.** The overwhelming
 *    majority of "visual regressions" are a spinner mid-rotation or text
 *    reflowing as a webfont lands. Both are removed before the shutter.
 *  - **A size change is reported as a size change.** Comparing images of
 *    different dimensions pixel-wise produces a meaningless 90%-different
 *    number; saying "the layout height went from 900 to 1180" is the actual
 *    finding.
 *
 * ── THE BASELINE KEY, AND THE DEFECT THAT WAS ONE LINE AWAY ─────────────────
 *
 * This file used to compute its own label — `` `${spec.viewport.width}x${
 * spec.viewport.height}` `` — and write its baseline under it with a hard-coded
 * `browser: 'chromium'`. `VisualBaseline`'s unique key is
 * (testId, viewport, browser, environmentId), and `baselineViewportKey` /
 * `variantBrowserKey` in packages/shared/src/browser-matrix.ts were written
 * PRECISELY to be the only producers of those two strings — so that a light
 * capture and a dark capture, or a DEFAULT and an ERROR capture, land on
 * DIFFERENT rows. Computing the label here instead meant every cell of a
 * declared matrix would upsert onto ONE row: whichever ran last would become the
 * others' reference, somebody would approve it, and every later diff would be
 * measured against the wrong rendering. One image approved and asserted for the
 * whole matrix.
 *
 * The keys now come from {@link planVisualBaselines}, which goes through
 * `floorCellFor`, `planVisualCaptures` and `recordCapture`. The invariant that
 * made the switch safe rather than catastrophic: an unvaried DEFAULT-state cell
 * produces `1280x800` and `chromium` BYTE FOR BYTE, which is exactly what this
 * file wrote before, so no baseline a customer has already approved stops
 * matching and nobody is forced into a re-approval sweep. `floorCellFor` names
 * `engine: 'chromium'` explicitly for that reason — an absent engine keys as
 * `'<default>'`, a different string, and every existing baseline would miss on
 * the first run after deploy.
 *
 * ── WHAT THIS FILE STILL DOES NOT DO, SAID OUT LOUD ─────────────────────────
 *
 * It captures ONE (cell, state) pair. `RunContext.visualBaseline` carries one
 * image and `TestExecution.newBaseline` carries one row, so there is no slot a
 * second cell's reference could be fetched from or approved into. Every other
 * declared pair is reported — as a SKIPPED step and a console line naming the
 * cell, the state and the reason — rather than being quietly folded into the one
 * capture. An unmeasured cell is null with a reason and stays in the count; it
 * is never a zero nobody read. `TEST_TYPE_DECLARATIONS.VISUAL.knownUnasserted`
 * declares both holes and stays true.
 */

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { matrixCellKey, notRunMessage, visualTestSpecSchema } from '@qaai/shared';
import { acquireBrowser } from '../browser-pool.js';
/*
 * One direction only: `plugins/matrix.ts` does not import this file, so there
 * is no cycle. See the spread in `planVisualBaselines` for why it is the
 * ANCHORING half and not `engineAxisFor`.
 */
import { dedupeAxisValues, impliedEngineAxis } from './matrix.js';
import {
  floorCellFor,
  mayWriteBaseline,
  planMatrix,
  planVisualCaptures,
  recordCapture,
  type MatrixPlan,
  type VisualCapturePlan,
  type VisualCaptureRecord,
} from '../matrix.js';
import type { BrowserContext } from 'playwright';
import type {
  ExecutableTest,
  Finding,
  MatrixCell,
  NotRunKind,
  RunContext,
  RunnerPlugin,
  StateUnreachedReason,
  StepResult,
  TestExecution,
  VisualTestSpec,
} from '@qaai/shared';

function step(
  index: number,
  title: string,
  status: 'PASSED' | 'FAILED' | 'SKIPPED',
  message?: string,
  screenshotKey: string | null = null,
): StepResult {
  return {
    index,
    title,
    status,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    screenshotKey,
    error:
      status === 'FAILED'
        ? { message: message ?? 'failed', stack: null, selector: null, expected: null, actual: null }
        : null,
  };
}

/** Paint the ignore regions solid on BOTH images so the diff cannot see them. */
function maskRegions(
  png: PNG,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): void {
  for (const region of regions) {
    const x0 = Math.max(0, Math.floor(region.x));
    const y0 = Math.max(0, Math.floor(region.y));
    const x1 = Math.min(png.width, Math.ceil(region.x + region.width));
    const y1 = Math.min(png.height, Math.ceil(region.y + region.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (png.width * y + x) << 2;
        png.data[i] = 0;
        png.data[i + 1] = 0;
        png.data[i + 2] = 0;
        png.data[i + 3] = 255;
      }
    }
  }
}

/**
 * The cap on cells one visual declaration may expand to.
 *
 * This plugin captures one pair, so the cap is not a cost control — it is what
 * keeps the DISCLOSURE bounded. An uncapped `matrix` of nine axes is a product in
 * the thousands, and a step list or a console pane built from it is a denial of
 * service on the person reading the run. `planMatrix` reports the bite as a count
 * and a reason, so a reader is told the list is a prefix rather than discovering
 * it.
 */
export const VISUAL_MAX_CELLS = 12;

/** One declared (cell, state) pair this execution did NOT capture, and why. */
export interface UncapturedPair {
  readonly plan: VisualCapturePlan;
  readonly reason: StateUnreachedReason;
  readonly why: string;
}

export interface VisualBaselinePlan {
  /** The declared matrix, as `planMatrix` resolved it. Carries the cap and the refusals. */
  readonly matrix: MatrixPlan;
  /**
   * The ONE pair this execution captures, compares and may approve, or null when
   * there is none — which is a refusal, never a silent fall-back to "whatever
   * state the page happened to be in".
   */
  readonly captured: VisualCapturePlan | null;
  readonly uncaptured: readonly UncapturedPair[];
  /** Why nothing is captured. Non-null exactly when `captured` is null. */
  readonly refusal: { readonly kind: NotRunKind; readonly why: string } | null;
}

/**
 * Work out which baseline row this execution owns, and name every pair it does
 * not.
 *
 * ── THE CAPTURED PAIR IS ALWAYS THE FLOOR CELL IN THE DEFAULT STATE ─────────
 *
 * Not "the first runnable cell of the declared matrix", and the difference is
 * the whole safety argument. The browser context below is built from
 * `spec.viewport` and nothing else — it applies no colour scheme, no reduced
 * motion, no forced colors and no device preset — so the only cell whose NAME
 * matches what is actually rendered is `floorCellFor(spec.viewport)`. Capturing
 * a declared dark-mode cell with a light-mode context and filing it under the
 * dark key would be the falsely-green baseline this round exists to refuse,
 * moved one level down.
 *
 * `spec.viewport` is a declared cell either way: `visualTestSpecSchema.matrix`
 * states that when `matrix` is present, `viewport` is the FIRST cell rather than
 * the only one. So the pair captured here is always one the author asked for.
 *
 * ── AND A DECLARATION THAT COULD NOT BE READ CAPTURES NOTHING ───────────────
 *
 * `planMatrix` returns authoring problems rather than throwing — a duplicate
 * cell key, both a list and axes, an empty seed. Capturing "the first cell" of a
 * declaration nobody could read and approving it as the reference is a write
 * made on a half-understood statement, so this refuses instead and hands the
 * sentences back.
 */
export function planVisualBaselines(spec: VisualTestSpec, seed: string): VisualBaselinePlan {
  const floor = floorCellFor(spec.viewport);
  /*
   * ── ONE DECISION WRITTEN TWICE IS NOT TWO CELLS, ON THIS PATH TOO ─────────
   *
   * `visualTestSpecSchema.matrix` is the same `matrixAxesSchema` the
   * CROSS_BROWSER spec carries, and it accepts the same repeat:
   * `{ locales: ['de-DE', 'de-DE'] }`, `{ colourSchemes: ['DARK', 'DARK'] }` and
   * `{ engines: ['webkit', 'webkit'] }` are all VALID. Each expanded to two
   * identical cells, `planMatrix` reported the duplicate as a problem, and the
   * `matrix.problems` refusal below returned the WHOLE TEST as NOT_RUN — no
   * capture, no comparison, no baseline — for a harmless repeat. Observed on
   * all of them before this line existed.
   *
   * The same function, deduplicated by deep value, as `crossBrowserPlan` asks
   * of the same axes: two answers to one question diverge, and the argument for
   * deduplicating rather than refusing is in `dedupeAxisValues`'s own note. A
   * duplicate CELL from two DIFFERENT declarations is still reported by
   * `planMatrix`; only one value typed twice is dropped here.
   */
  const declared = spec.matrix !== undefined ? dedupeAxisValues(spec.matrix) : undefined;
  const matrix =
    declared !== undefined
      ? planMatrix({
          /*
           * ── AN ENGINE-LESS CHANNEL OR VERSION CELL, ON THIS PATH TOO ──────
           *
           * `visualTestSpecSchema.matrix` is the SAME `matrixAxesSchema` the
           * CROSS_BROWSER spec carries, so a visual declaration can say
           * `channels: ['MSEDGE_DEV']` with no `engines` — and until this
           * spread, that planned the cell `{ channel: 'MSEDGE_DEV' }`, which
           * `variantBrowserKey` names `'<default>:MSEDGE_DEV'`. That label is
           * self-contradictory twice over: it claims nobody chose an engine
           * and then names a build of one, and it puts an angle bracket
           * mid-composite — the exact shape `variantDimension` refuses and
           * `matrixCellSchema` would never have accepted as a declaration.
           *
           * NOT A STORABILITY DEFECT ON THIS PATH TODAY, said plainly because
           * the difference matters for how hard this is leaned on: nothing
           * here goes through `variantsFor`, so no `testResultVariantSchema`
           * refuses it and no run loses its rows. The cell appears in a
           * disclosure step and a `logger.warn`, and only the FLOOR cell ever
           * becomes a `VisualBaseline` row. What it is, is the same latent
           * disagreement between a producer and a validator that cost five
           * rounds of repairs — this one waiting for the day somebody wires
           * the visual matrix to a variant row, at which point it arrives
           * already live, exactly as the cross-browser one did.
           *
           * `impliedEngineAxis` AND NOT `engineAxisFor`, and the difference is
           * the whole reason that function is split. `engineAxisFor` also
           * forces chromium into a DECLARED axis — a rule
           * `crossBrowserSpecSchema` states and `visualTestSpecSchema` does
           * not. Applying it here would add a chromium cell to every
           * `engines: ['webkit']` visual declaration: a cell this plugin
           * cannot capture (the context below is built from `spec.viewport`
           * and the floor cell is already chromium), reported as one more
           * uncaptured pair, and charged against `VISUAL_MAX_CELLS` — so the
           * disclosure of the cells the author DID ask for gets narrower.
           */
          axes: { ...declared, ...impliedEngineAxis(declared) },
          seed,
          maxCells: VISUAL_MAX_CELLS,
        })
      : planMatrix({ cells: [floor], seed, maxCells: VISUAL_MAX_CELLS });

  if (matrix.problems.length > 0) {
    return {
      matrix,
      captured: null,
      uncaptured: [],
      refusal: { kind: 'NOT_RUN', why: matrix.problems.join(' ') },
    };
  }

  /*
   * The floor cell first, then every OTHER declared cell. Deduplicated on
   * `matrixCellKey` rather than on object identity, because a declaration whose
   * axes happen to name the floor viewport produces an equal cell from a
   * different object — and listing it twice would report one pair as two
   * uncaptured ones.
   */
  const floorKey = matrixCellKey(floor);
  const cells: MatrixCell[] = [
    floor,
    ...matrix.runnable
      .map((execution) => execution.cell)
      .filter((cell) => matrixCellKey(cell) !== floorKey),
  ];

  const pairs = planVisualCaptures(cells, spec.states);
  const captured = pairs.find((pair) => pair.cell === floor && pair.state === 'DEFAULT') ?? null;

  const uncaptured: UncapturedPair[] = pairs
    .filter((pair) => pair !== captured)
    .map((pair) => ({
      plan: pair,
      /*
       * NOT_ATTEMPTED for both groups, and it is the weakest reason on purpose:
       * nobody tried. NO_TRIGGER_FOUND would claim we looked for a way into the
       * state and the surface had none, which is a statement about the
       * customer's application that this plugin has not earned.
       */
      reason: 'NOT_ATTEMPTED',
      why:
        pair.cell === floor
          ? `the ${pair.state} state was never reached: nothing in this plugin interacts with the ` +
            'page before the shutter fires. A screenshot taken without reaching it would be the ' +
            `DEFAULT rendering filed as ${pair.state}, which looks fine, gets approved, and makes ` +
            'every future run of this cell falsely green for ever.'
          : 'this cell was not captured: RunContext.visualBaseline carries ONE image and ' +
            'TestExecution.newBaseline carries ONE row, so there is no reference for a second ' +
            'cell to be diffed against and no slot for it to be approved into. Reported rather ' +
            "than folded into the captured cell's baseline, which is the defect that would make " +
            'one approved image the assertion for the whole matrix.',
    }));

  return {
    matrix,
    captured,
    uncaptured,
    refusal:
      captured === null
        ? {
            kind: 'NOT_RUN',
            why:
              'this spec names interaction states and DEFAULT is not among them, and nothing here ' +
              'reaches a state before capturing. Capturing the page as it arrives and filing it ' +
              'under a named state is the one outcome worse than capturing nothing, so nothing ' +
              'was captured. Add DEFAULT to `states`, or leave `states` absent.',
          }
        : null,
  };
}

/**
 * An artifact FILE name for a baseline key.
 *
 * The key itself is never rewritten — it is the row identity. A key can contain
 * `+`, `/` and `#` (`1280x800+dark#ERROR`), and `#` truncates a URL at the
 * fragment while `/` invents a directory, so the path gets a flattened form. A
 * plain `1280x800` passes through UNCHANGED, which is what keeps every existing
 * artifact path byte-identical.
 */
export function artifactLabel(baselineViewport: string): string {
  return baselineViewport.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** How many uncaptured pairs get named in the disclosure before it says "and N more". */
const DISCLOSED_PAIRS = 5;

/**
 * One step saying what was declared and not captured.
 *
 * BOUNDED, because a 12-cell matrix across 14 states is 168 pairs and a step per
 * pair is a denial of service on the person reading the run. The count is always
 * exact; the list is a prefix and says so.
 */
function uncapturedStep(index: number, records: readonly VisualCaptureRecord[]): StepResult | null {
  const unreached = records.filter((record) => !mayWriteBaseline(record));
  if (unreached.length === 0) return null;
  const named = unreached
    .slice(0, DISCLOSED_PAIRS)
    .map((record) => `${record.baselineBrowser} ${record.baselineViewport}`)
    .join(', ');
  const more = unreached.length > DISCLOSED_PAIRS ? `, and ${unreached.length - DISCLOSED_PAIRS} more` : '';
  return step(
    index,
    `${unreached.length} declared capture(s) were not taken`,
    'SKIPPED',
    `${named}${more}. ${unreached[0]?.unreachedDetail ?? ''}`,
  );
}

export const visualPlugin: RunnerPlugin = {
  type: 'VISUAL',

  validate(test: ExecutableTest): void {
    const parsed = visualTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`Visual test "${test.name}" has an invalid spec — ${issues}`);
    }
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = visualTestSpecSchema.parse(test.spec);
    const startedAt = Date.now();
    const steps: StepResult[] = [];
    const findings: Finding[] = [];

    const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
      testId: test.id,
      durationMs: 0,
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      retriedAndPassed: false,
      findings,
    };

    /*
     * THE BASELINE KEY, AND EVERY PAIR THIS EXECUTION IS NOT GOING TO CAPTURE.
     *
     * `baselineViewport` and `baselineBrowser` on the captured pair are produced
     * by `baselineViewportKey` and `variantBrowserKey` — the only producers of
     * those two strings in the product — and for the unvaried default spec they
     * are `1280x800` and `chromium`, byte for byte what this file wrote when it
     * built the label itself. That identity is the reason this switch does not
     * force a re-approval sweep onto every customer.
     */
    const baselines = planVisualBaselines(spec, ctx.runId);

    if (baselines.captured === null) {
      const refusal = baselines.refusal ?? {
        kind: 'NOT_RUN' as const,
        why: 'no (cell, state) pair could be captured and no reason was recorded.',
      };
      steps.push(step(0, 'Nothing was captured', 'SKIPPED', refusal.why));
      return {
        ...base,
        status: 'SKIPPED',
        durationMs: Date.now() - startedAt,
        steps,
        errorMessage: notRunMessage(refusal.kind, refusal.why),
        notRun: refusal,
      };
    }

    const captured = baselines.captured;
    /*
     * The artifact PATH, which cannot hold a `#` or a `/`. The row identity —
     * `captured.baselineViewport` — is used verbatim on `newBaseline` and is
     * never path-flattened. For an unvaried default spec the two are the same
     * string, `1280x800`, which is what keeps every existing artifact key and
     * every approved baseline matching.
     */
    const viewportLabel = artifactLabel(captured.baselineViewport);

    /** Every pair that was declared and not reached, as the records a gate reads. */
    const unreachedRecords = baselines.uncaptured.map((pair) =>
      recordCapture({
        plan: pair.plan,
        outcome: { reached: false, reason: pair.reason, detail: pair.why },
        imageKey: null,
        environmentId: ctx.environmentId,
      }),
    );

    if (baselines.matrix.capBite !== null) {
      ctx.logger.warn('visual matrix cap bit', {
        testId: test.id,
        detail: baselines.matrix.capBite.detail,
      });
    }

    /*
     * Cells the DEPLOYMENT refused — a Firefox beta that was never published, a
     * pinned Safari version no install on this image can be. Kept apart from
     * `uncaptured` above, and the distinction is the one this round is about:
     * uncaptured is a fact about THIS PLUGIN ("one baseline slot"), refused is a
     * fact about the image or the world. Recording them the same way would put
     * our missing binary into the customer's defect list. Bounded, because a
     * refusal list built from a capped product is still a list a reader has to
     * get through.
     */
    if (baselines.matrix.refused.length > 0) {
      ctx.logger.warn('visual matrix cells refused by this deployment', {
        testId: test.id,
        count: baselines.matrix.refused.length,
        cells: baselines.matrix.refused
          .slice(0, DISCLOSED_PAIRS)
          .map((refusal) => `${matrixCellKey(refusal.cell)}: ${refusal.notRun.kind}`),
      });
    }

    // Borrowed from the pool, so a suite of visual tests pays for one browser
    // rather than one per screenshot. The context is per-test and disposable:
    // the viewport below is exactly the kind of state that must not leak into
    // whatever runs next.
    const lease = await acquireBrowser();
    let context: BrowserContext | null = null;

    try {
      context = await lease.browser.newContext({
        viewport: spec.viewport,
        deviceScaleFactor: 1,
        ...(ctx.storageState ? { storageState: ctx.storageState as never } : {}),
      });
      const page = await context.newPage();

      const url = /^https?:\/\//i.test(spec.path)
        ? spec.path
        : new URL(spec.path, ctx.baseUrl).toString();

      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      steps.push(step(0, `Opened ${spec.path}`, 'PASSED'));

      // Everything below removes a known source of false positives.
      await page.addStyleTag({
        content: `*, *::before, *::after {
          animation: none !important;
          transition: none !important;
          caret-color: transparent !important;
        }
        ::-webkit-scrollbar { display: none !important; }`,
      });
      // Runs in the page, not in Node — hence the local DOM typing rather than
      // widening this package's lib to include "dom".
      await page.evaluate(() => {
        const d = (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } }).document;
        return d?.fonts?.ready ?? null;
      });
      if (spec.settleMs > 0) await page.waitForTimeout(spec.settleMs);

      const target = spec.selector ? page.locator(spec.selector).first() : page;
      const shotBuffer = spec.selector
        ? await (target as ReturnType<typeof page.locator>).screenshot({ animations: 'disabled' })
        : await page.screenshot({ fullPage: spec.fullPage, animations: 'disabled' });

      steps.push(step(1, 'Captured the screenshot', 'PASSED'));

      const actualKey = await ctx.artifacts.put(
        `visual/${test.id}-${viewportLabel}-actual.png`,
        shotBuffer,
        'image/png',
      );

      // ── First run: capture and approve, never fail ──────────────────────────
      const baselineBytes = ctx.visualBaseline
        ? await ctx.artifacts.get(ctx.visualBaseline.imageKey)
        : null;

      if (!baselineBytes) {
        const imageKey = await ctx.artifacts.putPersistent(
          `baselines/${test.id}-${viewportLabel}.png`,
          shotBuffer,
          'image/png',
        );

        /*
         * ── THE GATE, ASKED RATHER THAN REMEMBERED ────────────────────────────
         *
         * Every declared pair becomes a record and `mayWriteBaseline` decides
         * which of them may be persisted. That is one predicate instead of an
         * `if` at each call site, and it closes two holes this branch had: an
         * unreached state can never be filed as a baseline (the records above
         * are all `reached: false`, so none of them survives the filter), and an
         * empty key coming back from the artifact store can never be written as
         * a `VisualBaseline` row pointing at nothing.
         */
        const writable = [
          recordCapture({
            plan: captured,
            outcome: { reached: true },
            imageKey: imageKey.length > 0 ? imageKey : null,
            environmentId: ctx.environmentId,
          }),
          ...unreachedRecords,
        ].filter(mayWriteBaseline);

        const approved = writable[0];
        steps.push(
          step(
            2,
            approved
              ? 'Baseline captured — nothing to compare against yet'
              : 'The capture was taken and could not be approved',
            approved ? 'PASSED' : 'FAILED',
            approved
              ? undefined
              : 'the artifact store returned no key for the capture, so no baseline row was ' +
                'written — a row pointing at nothing would fail every future run of this test ' +
                'with a missing-baseline error that looks like a product defect.',
            actualKey,
          ),
        );
        const disclosure = uncapturedStep(steps.length, unreachedRecords);
        if (disclosure) steps.push(disclosure);

        return {
          ...base,
          status: approved ? 'PASSED' : 'FAILED',
          durationMs: Date.now() - startedAt,
          steps,
          errorMessage: approved ? null : 'the capture was stored under no key, so no baseline was approved',
          ...(approved && approved.imageKey !== null
            ? {
                newBaseline: {
                  imageKey: approved.imageKey,
                  viewport: approved.baselineViewport,
                  browser: approved.baselineBrowser,
                },
              }
            : {}),
        };
      }

      // ── Compare ────────────────────────────────────────────────────────────
      const baselinePng = PNG.sync.read(baselineBytes);
      const actualPng = PNG.sync.read(Buffer.from(shotBuffer));

      if (baselinePng.width !== actualPng.width || baselinePng.height !== actualPng.height) {
        const message =
          `The rendered size changed: baseline ${baselinePng.width}×${baselinePng.height}, ` +
          `now ${actualPng.width}×${actualPng.height}. A pixel diff across different sizes is not meaningful, ` +
          `so review the layout change and re-approve the baseline if it is intended.`;
        steps.push(step(2, 'Compared against the baseline', 'FAILED', message, actualKey));
        findings.push({
          kind: 'VISUAL',
          severity: 'SERIOUS',
          code: 'visual.size-changed',
          message,
          location: spec.selector ?? spec.path,
          helpUrl: null,
        });
        const sizeDisclosure = uncapturedStep(steps.length, unreachedRecords);
        if (sizeDisclosure) steps.push(sizeDisclosure);
        return {
          ...base,
          status: 'FAILED',
          durationMs: Date.now() - startedAt,
          steps,
          errorMessage: message,
        };
      }

      const regions = ctx.visualBaseline?.ignoreRegions ?? spec.ignoreRegions;
      if (regions.length > 0) {
        maskRegions(baselinePng, regions);
        maskRegions(actualPng, regions);
      }

      const diff = new PNG({ width: baselinePng.width, height: baselinePng.height });
      const changedPixels = pixelmatch(
        baselinePng.data,
        actualPng.data,
        diff.data,
        baselinePng.width,
        baselinePng.height,
        { threshold: spec.pixelThreshold, includeAA: false },
      );

      const totalPixels = baselinePng.width * baselinePng.height;
      const changedRatio = totalPixels === 0 ? 0 : changedPixels / totalPixels;
      const withinTolerance = changedRatio <= spec.maxDiffRatio;

      // The diff image is only worth storing (and looking at) when it failed.
      let diffKey: string | null = null;
      if (!withinTolerance) {
        diffKey = await ctx.artifacts.put(
          `visual/${test.id}-${viewportLabel}-diff.png`,
          PNG.sync.write(diff),
          'image/png',
        );
      }

      const pct = (changedRatio * 100).toFixed(3);
      const allowed = (spec.maxDiffRatio * 100).toFixed(3);
      const message = `${changedPixels} pixels changed (${pct}%), over the ${allowed}% this test allows`;

      steps.push(
        step(
          2,
          withinTolerance
            ? `Matched the baseline (${pct}% changed, within ${allowed}%)`
            : 'Compared against the baseline',
          withinTolerance ? 'PASSED' : 'FAILED',
          message,
          diffKey ?? actualKey,
        ),
      );

      if (!withinTolerance) {
        findings.push({
          kind: 'VISUAL',
          severity: changedRatio > 0.1 ? 'SERIOUS' : 'MODERATE',
          code: 'visual.diff',
          message,
          location: spec.selector ?? spec.path,
          helpUrl: null,
        });
      }

      const disclosure = uncapturedStep(steps.length, unreachedRecords);
      if (disclosure) steps.push(disclosure);

      return {
        ...base,
        status: withinTolerance ? 'PASSED' : 'FAILED',
        durationMs: Date.now() - startedAt,
        steps,
        errorMessage: withinTolerance ? null : message,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The visual test could not run';
      steps.push(step(steps.length, 'Visual check', 'FAILED', message));
      return {
        ...base,
        status: 'FAILED',
        durationMs: Date.now() - startedAt,
        steps,
        errorMessage: message,
      };
    } finally {
      // Closed here rather than left to the pool's safety net, because this
      // test's viewport and storage state end when this test does.
      if (context) await context.close().catch(() => {});
      await lease.release();
    }
  },
};
