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
/**
 * `.probe/**` and `.verify-probes/**` are the third and fourth, for the same
 * reason as the two above with the irony that this file's own doc block
 * describes the class of bug and still let it happen twice.
 *
 * They are the scratch directories agents working on this repo write their
 * reproductions into — a one-off `it()` that proves a hole exists, a probe that
 * drives a function nobody has a caller for. A DOT-LEADING directory looks
 * excluded and is not: vitest globs with `dot: true`, so MEASURED on this tree,
 * `.probe/scratch.test.ts` was collected by `npx vitest list .probe` before
 * this line and is not after it. One session's probe scratch put ~29 tests into
 * `npx vitest run` and moved the suite count TWICE, which means the integrator
 * comparing "16,185 passing" against the baseline was comparing two different
 * denominators — a measured number that was not measured.
 *
 * `.probe*` AND NOT `.probe`, because the NAME is not stable and that was
 * measured rather than guessed: while this line was being written a sibling
 * agent's `.probe-projects-route/` appeared at this root holding `probe1.ts`
 * and `probe2.mts`. Those two are not collected — they are not `*.test.ts` —
 * but the next one is one rename away, and an exclude that only matches the
 * exact spelling somebody used last time is an exclude that works once.
 *
 * EXCLUDED AND NOT DELETED, deliberately. The directory is somebody else's
 * work; nothing here may remove it, and a cleanup step that did would be a
 * worse defect than the one it tidied.
 */
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.qaai-runs/**',
      'e2e/**',
      '.probe*/**',
      '.verify-probes/**',
    ],
  },
});
