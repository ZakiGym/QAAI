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
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.qaai-runs/**'],
  },
});
