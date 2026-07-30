/**
 * Cross-browser and localisation testing (§4).
 *
 * Both are the same idea — run the identical spec more than once under a
 * different `use` block — so they are one file with two exported plugins rather
 * than two near-copies that drift apart.
 *
 * Playwright runs the matrix itself, and its JSON reporter already emits one
 * result per project, so the harness's existing parsing gives per-browser and
 * per-locale steps for free. A spec that passes in Chromium and fails in WebKit
 * reports as a failure with the WebKit step red — which is the whole point, and
 * is why this is a matrix rather than three separate tests.
 */

import { crossBrowserSpecSchema, localizationSpecSchema } from '@qaai/shared';
import type {
  ExecutableTest,
  RunContext,
  RunnerPlugin,
  TestExecution,
} from '@qaai/shared';
import { runPlaywrightSpec } from '../playwright-harness.js';

/** Chromium is always included: a matrix without the default browser hides regressions. */
function browserProjects(browsers: string[]): Array<{ name: string; browserName: string }> {
  const unique = [...new Set(['chromium', ...browsers])];
  return unique.map((browserName) => ({ name: browserName, browserName }));
}

export const crossBrowserPlugin: RunnerPlugin = {
  type: 'CROSS_BROWSER',

  validate(test: ExecutableTest): void {
    const parsed = crossBrowserSpecSchema.safeParse(test.spec ?? {});
    if (!parsed.success) {
      throw new Error(
        `Cross-browser test "${test.name}" has an invalid spec — ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = crossBrowserSpecSchema.parse(test.spec ?? {});
    return runPlaywrightSpec(ctx, test, { projects: browserProjects(spec.browsers) });
  },
};

export const localizationPlugin: RunnerPlugin = {
  type: 'LOCALIZATION',

  validate(test: ExecutableTest): void {
    const parsed = localizationSpecSchema.safeParse(test.spec ?? {});
    if (!parsed.success) {
      throw new Error(
        `Localization test "${test.name}" has an invalid spec — ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = localizationSpecSchema.parse(test.spec ?? {});
    return runPlaywrightSpec(ctx, test, {
      // The timezone travels with the locale: half of localisation bugs are
      // date and currency formatting, which a locale alone does not exercise.
      projects: spec.locales.map((locale) => ({
        name: locale.tag,
        locale: locale.tag,
        ...(locale.timezone ? { timezoneId: locale.timezone } : {}),
      })),
    });
  },
};
