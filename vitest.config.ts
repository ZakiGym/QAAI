import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The unit suite, and the one directory it must never look in.
 *
 * `.qaai-runs/` is where the Playwright harness materialises a workspace per
 * run: a generated spec, a playwright.config.ts, a fixtures folder. The harness
 * removes it when the run ends — but a worker that is killed mid-run (or a
 * machine that reboots) leaves one behind, and the specs inside it match
 * vitest's default include. `npx vitest run` then tries to collect a Playwright
 * spec and fails with "Playwright Test did not expect test() to be called
 * here", in a file nobody wrote and no test owns.
 *
 * That is a crashed run breaking an unrelated command, so the fix belongs here
 * rather than in a cleanup nobody can guarantee runs. Observed: three such
 * directories survived killing a worker to test shard recovery, and the suite
 * went from 8 files passing to 3 files failing without a line of source
 * changing.
 */
/**
 * `e2e/**` is the second directory, for the same reason and with the same
 * symptom. It is the dogfood suite: Playwright specs with their own
 * `e2e/playwright.config.ts`, which run against a live stack and cannot be
 * collected by vitest. Left in, they produced the exact error the note above
 * describes — "Playwright Test did not expect test.describe() to be called
 * here" — six times, so `npm test` at the repo root exited 1 on a clean
 * checkout even with all 2056 unit tests passing. A test command that is red
 * when nothing is wrong is a test command people stop reading.
 *
 * Run that suite with `npm run test:e2e`, which uses its own config.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.qaai-runs/**', 'e2e/**'],
  },
});
