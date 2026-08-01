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
 *
 * It also inherits hermetic replay (../har.ts), and that is the one place where
 * "identical to E2E" needed a sentence of its own — see below.
 */

import type { ExecutableTest, RunnerPlugin, RunContext, TestExecution } from '@qaai/shared';
import { parseHarConfig } from '../har.js';
import { runE2ETest, validateE2ETest } from './e2e.js';

const SMOKE_TIMEOUT_CEILING_MS = 45_000;

/**
 * A monitoring check that replays a recording cannot see an outage.
 *
 * Hermetic replay is the right default for a suite that must not go red when a
 * third party deploys. It is the exact wrong thing for the run whose whole job
 * is to notice that a third party is down: every request is answered from a
 * file, so the check stays green while the site is on fire.
 *
 * QAAI does not refuse it — a smoke test in a pipeline, gating a deploy against
 * a fixed set of responses, is a legitimate thing to want. But an operator
 * reading a green monitor is entitled to know it was green against a recording,
 * so the result says so, first line, every time.
 */
const REPLAY_WARNING =
  'MONITORING WARNING: this SMOKE test replayed recorded network instead of talking to the live ' +
  'system, so a green result here does NOT mean the environment is up — every response came from ' +
  'a file. Set har.mode to "off" for post-deploy and synthetic monitoring runs.';

export const smokePlugin: RunnerPlugin = {
  type: 'SMOKE',
  validate: validateE2ETest,
  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const execution = await runE2ETest(
      { ...ctx, determinism: { ...ctx.determinism, retryOnce: false } },
      { ...test, timeoutMs: Math.min(test.timeoutMs, SMOKE_TIMEOUT_CEILING_MS) },
    );

    // Read from the same parser the E2E path used, so this warning cannot drift
    // out of step with what actually happened (env override included).
    const { config } = parseHarConfig(test.spec, process.env);
    if (config?.mode !== 'replay') return execution;

    return {
      ...execution,
      errorMessage: execution.errorMessage
        ? `${REPLAY_WARNING}\n\n${execution.errorMessage}`
        : REPLAY_WARNING,
    };
  },
};
