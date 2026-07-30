/**
 * Smoke plugin (§4) — the tagged critical-path subset used for post-deploy and
 * synthetic monitoring checks.
 *
 * Mechanically identical to E2E; the difference is intent, and intent shows up
 * as a shorter timeout and no retry. A smoke run exists to answer "is prod
 * broken right now", so it should fail fast and never mask a real outage behind
 * a retry that happened to pass.
 */

import type { ExecutableTest, RunnerPlugin, RunContext, TestExecution } from '@qaai/shared';
import { runPlaywrightSpec } from '../playwright-harness.js';
import { validatePlaywrightSpec } from './e2e.js';

const SMOKE_TIMEOUT_CEILING_MS = 45_000;

export const smokePlugin: RunnerPlugin = {
  type: 'SMOKE',
  validate: validatePlaywrightSpec,
  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runPlaywrightSpec(
      { ...ctx, determinism: { ...ctx.determinism, retryOnce: false } },
      { ...test, timeoutMs: Math.min(test.timeoutMs, SMOKE_TIMEOUT_CEILING_MS) },
    );
  },
};
