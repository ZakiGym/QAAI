/**
 * Smoke plugin (§4) — the tagged critical-path subset used for post-deploy and
 * synthetic monitoring checks.
 *
 * Mechanically identical to E2E; the difference is intent, and intent shows up
 * as a shorter timeout and no retry. A smoke run exists to answer "is prod
 * broken right now", so it should fail fast and never mask a real outage behind
 * a retry that happened to pass.
 *
 * Identical includes the routing: a smoke test written in pytest or RSpec runs
 * through its own runner here for the same reason it does in E2E, and it
 * inherits the same ceiling — `timeoutMs` is what the routed command is given
 * for its whole run.
 */

import type { ExecutableTest, RunnerPlugin, RunContext, TestExecution } from '@qaai/shared';
import { runE2ETest, validateE2ETest } from './e2e.js';

const SMOKE_TIMEOUT_CEILING_MS = 45_000;

export const smokePlugin: RunnerPlugin = {
  type: 'SMOKE',
  validate: validateE2ETest,
  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runE2ETest(
      { ...ctx, determinism: { ...ctx.determinism, retryOnce: false } },
      { ...test, timeoutMs: Math.min(test.timeoutMs, SMOKE_TIMEOUT_CEILING_MS) },
    );
  },
};
