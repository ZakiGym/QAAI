/**
 * E2E / UI plugin (§4). Full user journeys with per-step timing, failure
 * screenshot, video, and trace.
 */

import type { ExecutableTest, RunnerPlugin, RunContext, TestExecution } from '@qaai/shared';
import { runPlaywrightSpec } from '../playwright-harness.js';

/**
 * Cheap structural checks before we pay for a browser. These catch the two ways
 * generated code usually goes wrong — an empty file, or prose instead of code —
 * and turn them into a clear message rather than a Playwright compile error.
 */
export function validatePlaywrightSpec(test: ExecutableTest): void {
  if (!test.code.trim()) {
    throw new Error(`Test "${test.name}" has no code`);
  }
  if (!/from\s+['"]@playwright\/test['"]/.test(test.code)) {
    throw new Error(
      `Test "${test.name}" does not import from @playwright/test — the generator produced something that is not a Playwright spec`,
    );
  }
  if (!/\btest\s*\(/.test(test.code)) {
    throw new Error(`Test "${test.name}" declares no test() block`);
  }
}

export const e2ePlugin: RunnerPlugin = {
  type: 'E2E',
  validate: validatePlaywrightSpec,
  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runPlaywrightSpec(ctx, test);
  },
};
