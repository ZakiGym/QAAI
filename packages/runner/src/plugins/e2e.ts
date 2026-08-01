/**
 * E2E / UI plugin (§4). Full user journeys with per-step timing, failure
 * screenshot, video, and trace.
 *
 * Playwright TypeScript runs natively, through the harness, exactly as it always
 * has — that is the path with steps, artifacts, traces and healing behind it.
 *
 * It is not the only path any more. QAAI generates E2E tests for 39 ecosystems,
 * and a pytest module, an RSpec feature spec or a JUnit class arriving here used
 * to fail validation with "does not import from @playwright/test" — a message
 * that describes QAAI's limitation while looking like a verdict on the test. So
 * anything that is not a Playwright spec is ROUTED: QAAI runs the ecosystem's
 * own command from the catalogue in @qaai/shared and reads the report that tool
 * already knows how to write, through the same `runExternal` the INTEGRATION
 * plugin uses. No second spawner, no second report reader.
 *
 * Four rules hold the routing honest, and all four exist because the
 * alternative blames the application under test:
 *
 *  - An ecosystem we cannot identify is SKIPPED with the one thing to configure.
 *    Guessing a runner and reporting its startup error as a test failure is the
 *    worst outcome available.
 *  - A runner that needs the customer's project — a pom, a Gemfile, a
 *    node_modules — is SKIPPED before it is spawned, because QAAI holds the test
 *    and not the repo. See STANDALONE_MANAGERS.
 *  - A runner that was told where to write its report, exited non-zero and wrote
 *    nothing did not evaluate anything; that is a SKIP with the install hint,
 *    never a failure.
 *  - A runner whose report QAAI cannot read from a single file — a Surefire
 *    glob, a `go test -json` stream — falls back to the process's own exit code
 *    rather than inventing per-test rows it does not have.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { EXTERNAL_REPORT_FORMATS, ecosystemById, externalTestSpecSchema, resolveEcosystemCommand } from '@qaai/shared';
import type {
  Ecosystem,
  ExecutableTest,
  ExternalReportFormat,
  ExternalTestSpec,
  RunContext,
  RunnerPlugin,
  TestExecution,
} from '@qaai/shared';
import { runPlaywrightSpec } from '../playwright-harness.js';
import { runExternal } from './external.js';

/** The import that makes a file a Playwright spec, and nothing else does. */
const PLAYWRIGHT_IMPORT = /from\s+['"]@playwright\/test['"]/;

/**
 * Cheap structural checks before we pay for a browser. These catch the two ways
 * generated code usually goes wrong — an empty file, or prose instead of code —
 * and turn them into a clear message rather than a Playwright compile error.
 */
export function validatePlaywrightSpec(test: ExecutableTest): void {
  if (!test.code.trim()) {
    throw new Error(`Test "${test.name}" has no code`);
  }
  if (!PLAYWRIGHT_IMPORT.test(test.code)) {
    throw new Error(
      `Test "${test.name}" does not import from @playwright/test — the generator produced something that is not a Playwright spec`,
    );
  }
  if (!/\btest\s*\(/.test(test.code)) {
    throw new Error(`Test "${test.name}" declares no test() block`);
  }
}

// ─── Which runner owns this test ─────────────────────────────────────────────

type Route =
  /** A Playwright TypeScript spec: the native harness, unchanged. */
  | { kind: 'playwright' }
  /** The test carries its own command; the owner has already decided. */
  | { kind: 'declared'; spec: ExternalTestSpec }
  /** A catalogue runner, named by the spec or inferred from the source. */
  | { kind: 'catalogue'; entry: Ecosystem }
  /** Nothing to run it with. The message says what to configure. */
  | { kind: 'unknown'; why: string };

function specRecord(spec: unknown): Record<string, unknown> | null {
  return typeof spec === 'object' && spec !== null && !Array.isArray(spec)
    ? (spec as Record<string, unknown>)
    : null;
}

/**
 * Source evidence for a runner, in priority order.
 *
 * An import beats an extension: `.test.ts` is Jest, Vitest, Nightwatch and
 * Puppeteer all at once, and only the source says which. The extension-only
 * entries at the bottom are the languages where the file name IS the convention
 * — pytest collects `test_*.py`, Go collects `*_test.go` — so there is nothing
 * more to ask.
 *
 * Every `id` is checked against the catalogue at call time; an entry naming a
 * runner that no longer exists degrades to "cannot tell", never to a bad spawn.
 */
interface RunnerHint {
  readonly id: string;
  readonly file?: RegExp;
  readonly code?: RegExp;
}

const RUNNER_HINTS: readonly RunnerHint[] = [
  // Evidence in the source first — extensions are ambiguous, imports are not.
  { id: 'cypress', file: /\.cy\.[cm]?[jt]sx?$/ },
  { id: 'testcafe', code: /from\s+['"]testcafe['"]/ },
  { id: 'webdriverio', code: /@wdio\/globals|\bbrowser\.\$\$?\(|\bbrowser\.url\(/ },
  { id: 'nightwatch', code: /\bbrowser\.assert\.|\bbrowser\.end\(/ },
  { id: 'jest', code: /from\s+['"]puppeteer['"]|@jest\/globals|\bjest\.(fn|spyOn|useFakeTimers)\(/ },
  { id: 'vitest', code: /from\s+['"]vitest['"]/ },

  { id: 'testng', file: /\.java$/, code: /org\.testng/ },
  { id: 'junit5-maven', file: /\.java$/ },
  { id: 'junit5-gradle', file: /\.kts?$/ },

  { id: 'nunit', file: /\.cs$/, code: /using\s+NUnit/ },
  { id: 'xunit', file: /\.cs$/, code: /using\s+Xunit/ },
  { id: 'mstest', file: /\.cs$/, code: /Microsoft\.VisualStudio\.TestTools/ },
  // Every .NET record spawns the same `dotnet test --logger trx`, so an
  // unidentified C# file is safe to route through any of them.
  { id: 'nunit', file: /\.cs$/ },

  { id: 'pytest', file: /\.py$/ },
  { id: 'robot-framework', file: /\.robot$/ },
  { id: 'rspec', file: /_spec\.rb$/ },
  { id: 'minitest', file: /_test\.rb$/ },
  { id: 'go-test', file: /_test\.go$/ },
  { id: 'pest', file: /\.php$/, code: /\buses\(|^\s*(it|test)\(/m },
  { id: 'phpunit', file: /\.php$/ },
];

function inferEcosystem(test: ExecutableTest): Ecosystem | null {
  for (const hint of RUNNER_HINTS) {
    if (hint.file && !hint.file.test(test.filePath)) continue;
    if (hint.code && !hint.code.test(test.code)) continue;
    const entry = ecosystemById(hint.id);
    if (entry) return entry;
  }
  return null;
}

export function routeFor(test: ExecutableTest): Route {
  const spec = specRecord(test.spec);

  // An explicit command is the owner's decision and outranks everything.
  if (spec && typeof spec.command === 'string' && spec.command.trim() !== '') {
    const parsed = externalTestSpecSchema.safeParse(spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { kind: 'unknown', why: `its external spec is invalid — ${issues}` };
    }
    return { kind: 'declared', spec: parsed.data };
  }

  const named = spec
    ? [spec.ecosystem, spec.ecosystemId, spec.runner].find((v) => typeof v === 'string')
    : undefined;
  if (typeof named === 'string') {
    const entry = ecosystemById(named);
    return entry
      ? { kind: 'catalogue', entry }
      : {
          kind: 'unknown',
          why: `its spec names the runner "${named}", which is not in the QAAI ecosystem catalogue`,
        };
  }

  if (PLAYWRIGHT_IMPORT.test(test.code)) return { kind: 'playwright' };

  const inferred = inferEcosystem(test);
  if (inferred) return { kind: 'catalogue', entry: inferred };

  return {
    kind: 'unknown',
    why: `it is not a Playwright TypeScript spec and nothing in ${test.filePath || 'its source'} identifies a test runner`,
  };
}

/**
 * Validation follows the route. The Playwright checks are exactly the ones this
 * plugin has always applied — they just no longer fire at a pytest module, whose
 * only crime was being written in Python.
 *
 * An unroutable test does NOT throw: the run records it as SKIPPED with the
 * thing to configure, because "QAAI cannot run this" is not a test failure.
 */
export function validateE2ETest(test: ExecutableTest): void {
  const route = routeFor(test);
  if (route.kind === 'playwright') {
    validatePlaywrightSpec(test);
    return;
  }
  if (route.kind === 'declared') return;
  if (!test.code.trim()) {
    throw new Error(`Test "${test.name}" has no code`);
  }
}

// ─── Running someone else's runner ───────────────────────────────────────────

/**
 * Where a routed test is materialised.
 *
 * `runExternal` resolves its workspace from `process.cwd()`, so the scratch tree
 * has to live under it — the same trade the Playwright harness makes when it
 * writes specs beside the installed `@playwright/test`. Each run gets its own
 * directory and it is removed afterwards, in a finally, whatever the outcome.
 */
const SCRATCH_ROOT = '.qaai-external';

/** Refuses a path that escapes the scratch workspace. filePath is model-authored. */
function safeWorkspacePath(dir: string, filePath: string): string {
  const cleaned = filePath.replace(/^[/\\]+/, '');
  const full = resolve(join(dir, cleaned));
  const root = resolve(dir);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Refusing to write outside the workspace: ${filePath}`);
  }
  return full;
}

/**
 * Runners that can execute a single file with nothing else around it.
 *
 * This is the line between "QAAI can run your test" and "QAAI can run your
 * project". `python3 -m pytest tests/x.py` works in an empty directory; `mvn
 * test` wants a pom, `bundle exec rspec` a Gemfile, `npx cypress run` a
 * node_modules and a config. QAAI holds the test, not the repo, so for anything
 * outside this set the only honest answer is to say so before spawning —
 * spawning anyway produces "there is no POM in this directory" filed as a test
 * failure, which reads as a verdict on the application.
 *
 * A repo that IS present is served by the other route: a spec with its own
 * command and cwd runs inside it, exactly as the INTEGRATION plugin does.
 */
const STANDALONE_MANAGERS = new Set<string>(['pip', 'deno', 'bun']);

/**
 * The report format to ask `runExternal` for.
 *
 * `REPORT_FORMAT_INFO[…].externalSpecFormat` looks like the answer and is not:
 * it was written when `runExternal` parsed everything as JUnit XML, so it still
 * says `null` for the formats the reports/ directory has had parsers for since.
 * Membership of EXTERNAL_REPORT_FORMATS is the current truth.
 *
 * Anything QAAI cannot read from one named file — a Surefire glob, `go test
 * -json` on stdout, a runner with no report at all — becomes the exit code.
 * That is a real, if coarse, verdict; a parser pointed at a file that will never
 * exist would report "not evaluated" for a suite that ran.
 */
function reportFormatFor(entry: Ecosystem): ExternalReportFormat {
  if (entry.reportTarget !== 'file' || !entry.reportPath) return 'exit-code';
  return (EXTERNAL_REPORT_FORMATS as readonly string[]).includes(entry.reportFormat)
    ? (entry.reportFormat as ExternalReportFormat)
    : 'exit-code';
}

/**
 * The variable each runner reads its base URL from. QAAI_BASE_URL is always set
 * (by `runExternal`), but a tool that configures its own base URL only honours
 * its own name for it — pytest-base-url will not read ours, and a suite that
 * silently tests localhost is worse than one that fails to start.
 */
const BASE_URL_ENV: Record<string, readonly string[]> = {
  playwright: ['PLAYWRIGHT_BASE_URL'],
  cypress: ['CYPRESS_BASE_URL'],
  pytest: ['PYTEST_BASE_URL'],
};

function notEvaluated(test: ExecutableTest, startedAt: number, why: string): TestExecution {
  return {
    testId: test.id,
    status: 'SKIPPED',
    durationMs: Date.now() - startedAt,
    steps: [],
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    errorMessage: why,
    retriedAndPassed: false,
    findings: [],
  };
}

/**
 * Run one generated test through its own ecosystem's command.
 *
 * The workspace holds the test file at its own path plus the run's fixtures, so
 * `tests/checkout/test_cart.py` is collected by pytest exactly as it would be in
 * the customer's repo. What it does NOT hold is the customer's project: a test
 * that imports application code needs the repo, and that case is what a declared
 * external spec (command + cwd) is for.
 */
async function runInEcosystem(
  ctx: RunContext,
  test: ExecutableTest,
  entry: Ecosystem,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const workspace = process.cwd();
  // Ids are database cuids, but they end up as a real directory name, so they
  // are treated as untrusted the same way `test.filePath` is.
  const slug = `${ctx.runId}-${test.id}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = join(workspace, SCRATCH_ROOT, slug);

  if (!STANDALONE_MANAGERS.has(entry.packageManager)) {
    return notEvaluated(
      test,
      startedAt,
      `"${test.name}" is a ${entry.label} test, and ${entry.label} runs from your project — QAAI has the test but not the repo it belongs to, so nothing was executed rather than reporting a startup error as a failure. Two ways to run it: export the repo (it ships with the manifest and config ${entry.label} needs) and run it in your CI, or give this test a spec with its own command and cwd so QAAI runs it inside a checkout. Install: ${entry.installHint}`,
    );
  }

  let resolved: { command: string; args: string[]; env: Record<string, string> };
  try {
    resolved = resolveEcosystemCommand(entry, entry.reportPath || null);
  } catch (err) {
    return notEvaluated(
      test,
      startedAt,
      `${entry.label} needs a report location QAAI could not supply (${err instanceof Error ? err.message : String(err)}). Give the test an explicit spec with the command to run.`,
    );
  }

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return notEvaluated(
      test,
      startedAt,
      `QAAI could not create a workspace under ${SCRATCH_ROOT}/ to run ${entry.label} (${err instanceof Error ? err.message : String(err)}), so "${test.name}" was not evaluated.`,
    );
  }

  try {
    const target = safeWorkspacePath(dir, test.filePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, test.code, 'utf8');

    // Test data, so a test can read `fixtures/users.json` off disk — the same
    // contract the Playwright harness gives its specs.
    for (const [fixturePath, content] of Object.entries(ctx.fixtures ?? {})) {
      const fixture = safeWorkspacePath(dir, fixturePath);
      await mkdir(dirname(fixture), { recursive: true });
      await writeFile(fixture, content, 'utf8');
    }

    const baseUrlEnv = Object.fromEntries(
      [...(BASE_URL_ENV[entry.id] ?? []), 'BASE_URL'].map((name) => [name, ctx.baseUrl]),
    );

    const spec: ExternalTestSpec = {
      command: resolved.command,
      args: resolved.args,
      env: { ...resolved.env, ...baseUrlEnv },
      // The environment's secrets, by name — the same set the native harness
      // puts in a Playwright spec's environment.
      secretNames: Object.keys(ctx.secrets),
      reportPath: entry.reportPath || 'report.xml',
      reportFormat: reportFormatFor(entry),
      timeoutSeconds: Math.max(1, Math.min(3600, Math.ceil(test.timeoutMs / 1000))),
      cwd: relative(workspace, dir),
    };

    const execution = await runExternal(ctx, test, spec);

    // A runner that was told where to write its report, exited non-zero, and
    // wrote nothing did not evaluate the test — it failed to start. A missing
    // interpreter module, an uninstalled plugin, a dependency the generated test
    // imports: all setup, none of them a verdict on the application. The report
    // is the evidence, and there is none.
    if (
      execution.status === 'FAILED' &&
      spec.reportFormat !== 'exit-code' &&
      execution.steps.length === 0
    ) {
      return notEvaluated(
        test,
        startedAt,
        `${entry.label} exited without writing ${spec.reportPath}, so "${test.name}" was not evaluated — it ran in a workspace holding only the generated test, and ${entry.label} may need dependencies or project files QAAI does not have. Install: ${entry.installHint}. ${entry.label} said: ${execution.errorMessage ?? '(no output)'}`.slice(
          0,
          2000,
        ),
      );
    }

    // A skip means nothing ran, and the reader's next question is always "with
    // what, and how do I get it" — so the routing decision is stated there.
    return execution.status === 'SKIPPED'
      ? {
          ...execution,
          errorMessage: `${execution.errorMessage ?? 'Not evaluated.'} QAAI routed this test to ${entry.label} (${entry.command}); install it with: ${entry.installHint}`,
        }
      : execution;
  } catch (err) {
    return notEvaluated(
      test,
      startedAt,
      `QAAI could not prepare "${test.name}" for ${entry.label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Execute an E2E test with whatever it is written in. Shared with SMOKE, which
 * differs only in its timeout and its refusal to retry.
 */
export function runE2ETest(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
  const route = routeFor(test);
  switch (route.kind) {
    case 'playwright':
      return runPlaywrightSpec(ctx, test);
    case 'declared':
      return runExternal(ctx, test, route.spec);
    case 'catalogue':
      return runInEcosystem(ctx, test, route.entry);
    case 'unknown':
      return Promise.resolve(
        notEvaluated(
          test,
          Date.now(),
          `"${test.name}" was not evaluated: ${route.why}. Set the test's spec to {"ecosystem": "<id>"} naming a runner from the QAAI catalogue (pytest, junit5-maven, rspec, cypress, …), or to a full external spec ({"command": …, "args": [...], "reportPath": …}) to run it from your own repo.`,
        ),
      );
  }
}

export const e2ePlugin: RunnerPlugin = {
  type: 'E2E',
  validate: validateE2ETest,
  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runE2ETest(ctx, test);
  },
};
