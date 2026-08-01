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
 */

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { visualTestSpecSchema } from '@qaai/shared';
import { acquireBrowser } from '../browser-pool.js';
import type { BrowserContext } from 'playwright';
import type {
  ExecutableTest,
  Finding,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
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

    const viewportLabel = `${spec.viewport.width}x${spec.viewport.height}`;

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
        steps.push(
          step(2, 'Baseline captured — nothing to compare against yet', 'PASSED', undefined, actualKey),
        );
        return {
          ...base,
          status: 'PASSED',
          durationMs: Date.now() - startedAt,
          steps,
          errorMessage: null,
          newBaseline: { imageKey, viewport: viewportLabel, browser: 'chromium' },
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
