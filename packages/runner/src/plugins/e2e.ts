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
 *
 * This plugin is also where HERMETIC REPLAY is wired in (../har.ts). A test
 * whose spec asks for `har.mode` gets the recorder or the replayer installed
 * into its Playwright process, and — the part that matters — every result says
 * whether the run actually was hermetic. See `runWithHar`.
 */

import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_REPORT_FORMATS, ecosystemById, externalTestSpecSchema, resolveEcosystemCommand } from '@qaai/shared';
import type {
  Ecosystem,
  ExecutableTest,
  ExternalReportFormat,
  ExternalTestSpec,
  NetworkEntry,
  RunContext,
  RunnerPlugin,
  TestExecution,
} from '@qaai/shared';
import {
  archiveRecordedAt,
  parseArchive,
  parseHarConfig,
  readHarRunDir,
  stalenessWarning,
  summariseHarRun,
  unroutableTransports,
} from '../har.js';
import type { HarConfig, HarRunReport, HarRuntimeOptions } from '../har.js';
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

// ─── Hermetic replay ─────────────────────────────────────────────────────────

/**
 * The HAR runtime is copied into the run workspace beside the spec.
 *
 * Beside, rather than at the workspace root, because `test.filePath` can be
 * nested to any depth and a sibling import (`./__qaai_har__.js`) is the one
 * relative path that does not depend on how deep it is. The name matches
 * nothing in Playwright's default `testMatch`, so the runner will not try to
 * collect it as a test.
 */
const HAR_RUNTIME_MODULE = '__qaai_har__.ts';

let harSourceCache: string | null = null;

/**
 * The runtime shipped into the Playwright process is `../har.ts` ITSELF, read
 * off disk and copied verbatim.
 *
 * The alternative — a template string that reimplements matching and redaction
 * for the browser process — is the same logic written twice, and the copy that
 * runs is the one nothing tests. Copying the real module means the matcher the
 * unit tests exercise is byte-for-byte the matcher that decides whether a
 * request is served from a recording. `.js` is tried after `.ts` so a compiled
 * build works too.
 */
async function harRuntimeSource(): Promise<string> {
  if (harSourceCache !== null) return harSourceCache;
  const problems: string[] = [];
  for (const candidate of ['../har.ts', '../har.js']) {
    try {
      const source = await readFile(fileURLToPath(new URL(candidate, import.meta.url)), 'utf8');
      harSourceCache = source;
      return source;
    } catch (err) {
      problems.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`QAAI could not read its own HAR runtime (${problems.join('; ')})`);
}

/** Where the runtime goes, mirroring how the harness places the spec itself. */
function harModuleFixturePath(filePath: string): string | null {
  const cleaned = filePath.replace(/^[/\\]+/, '');
  const withExt = extname(cleaned) ? cleaned : `${cleaned}.spec.ts`;
  const dir = dirname(withExt);
  const rel = normalize(join('tests', dir === '.' ? '' : dir, HAR_RUNTIME_MODULE));
  return rel === '..' || rel.startsWith(`..${sep}`) ? null : rel;
}

/**
 * The block appended to the spec. Appended, not prepended, so every line number
 * in a failure still points at the line the author wrote.
 *
 * `test` is imported here rather than reusing whatever the spec called it: it
 * is the same module instance, so it is the same object, and Playwright records
 * hooks against the file's suite rather than against a test type — which means
 * this also works for a spec that runs on a `base.extend()` fixture of its own.
 */
function harEpilogue(options: HarRuntimeOptions): string {
  const specifier = `./${HAR_RUNTIME_MODULE.replace(/\.ts$/, '.js')}`;
  return `

/* ── injected by QAAI: hermetic network ${options.config.mode} ────────────────
 * Not part of your test. This block exists only inside the temporary run
 * workspace — the spec QAAI stores and exports stays a plain Playwright spec
 * with no QAAI import in it.
 */
import { test as __qaaiTest } from '@playwright/test';
import { installHar as __qaaiInstallHar } from ${JSON.stringify(specifier)};
__qaaiInstallHar(__qaaiTest, ${JSON.stringify(options)});
`;
}

/**
 * Puts the hermeticity verdict where a human will read it: the top of the
 * result message, ahead of the test's own error, because a truncated message
 * must not be the one that loses "this run was not actually hermetic".
 */
function withNotice(execution: TestExecution, notice: string): TestExecution {
  return {
    ...execution,
    errorMessage: execution.errorMessage ? `${notice}\n\n${execution.errorMessage}` : notice,
  };
}

/**
 * The network the run actually made, from the HAR report.
 *
 * E2E has always returned an empty `network` array — Playwright puts network in
 * the trace, not in the JSON report — so interception is the first time triage
 * gets to see the requests. URLs and bodies arrive already redacted, because
 * they were redacted at capture.
 */
function harNetworkEntries(report: HarRunReport | null): NetworkEntry[] {
  return (report?.entries ?? []).map((entry) => ({
    method: entry.method,
    url: entry.url,
    status: entry.status,
    durationMs: entry.durationMs,
    responseBodySnippet: entry.bodySnippet,
  }));
}

/**
 * Run a Playwright spec with record or replay installed.
 *
 * Every exit from this function states the hermeticity of the run. There is no
 * path where interception silently does not happen: a missing recording is a
 * SKIP with the fix, a runtime that would not load is a SKIP that blames QAAI
 * and not the application, and a run that reached the live network says NOT
 * HERMETIC in the first line of its message even when the test passed.
 */
async function runWithHar(
  ctx: RunContext,
  test: ExecutableTest,
  config: HarConfig,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const fixtures = ctx.fixtures ?? {};

  // Replay needs a recording, and the honest time to discover it does not have
  // one is before a browser is paid for. A missing or unreadable recording is a
  // configuration gap: nothing was evaluated, and nothing is claimed about the app.
  let staleness: string | null = null;
  if (config.mode === 'replay') {
    const raw = fixtures[config.path];
    if (raw === undefined) {
      return notEvaluated(
        test,
        startedAt,
        `"${test.name}" asks to replay network from ${config.path}, and this run has no such fixture, so nothing was executed. Record one first: set the test's spec to {"har": {"mode": "record", "path": "${config.path}"}}, run it once against a live environment, then commit the artifact it produces as ${config.path}.`,
      );
    }
    try {
      staleness = stalenessWarning(archiveRecordedAt(parseArchive(raw)), config.maxAgeDays);
    } catch (err) {
      return notEvaluated(
        test,
        startedAt,
        `"${test.name}" was not evaluated: the recording at ${config.path} cannot be read — ${
          err instanceof Error ? err.message : String(err)
        }. Re-record it with har.mode = "record".`,
      );
    }
  }

  const modulePath = harModuleFixturePath(test.filePath);
  let source: string | null = null;
  let setupProblem: string | null = null;
  if (!modulePath) {
    setupProblem = `the test's file path (${test.filePath}) does not resolve inside the run workspace`;
  } else {
    try {
      source = await harRuntimeSource();
    } catch (err) {
      setupProblem = err instanceof Error ? err.message : String(err);
    }
  }

  // QAAI could not set interception up. Running the test anyway is right — the
  // customer still gets their verdict — but the run is not hermetic and the
  // result has to say so rather than let a "replay" label stand.
  if (!modulePath || source === null) {
    const execution = await runPlaywrightSpec(ctx, test);
    return withNotice(
      execution,
      `NOT HERMETIC: HAR ${config.mode} was requested but could not be set up (${setupProblem}); this run used the live network.`,
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'qaai-har-'));
  try {
    const options: HarRuntimeOptions = {
      config,
      baseUrl: ctx.baseUrl,
      // Names only. The Playwright process already has the values in its
      // environment (the harness puts them there); sending them through the
      // workspace would write secrets to disk to stop them reaching disk.
      secretNames: Object.keys(ctx.secrets),
      // A directory, because Playwright loads the spec in the collection
      // process AND in every worker: each one writes its own file here and they
      // are merged below.
      reportDir: dir,
    };

    const execution = await runPlaywrightSpec(
      { ...ctx, fixtures: { ...fixtures, [modulePath]: source } },
      { ...test, code: `${test.code}${harEpilogue(options)}` },
    );

    const { report, archive } = readHarRunDir(dir);

    // Our injected module failed to compile or import. That is QAAI's file in
    // QAAI's workspace, so it is an environment gap — reporting it as a failing
    // test would blame the application for our code.
    if (!report && execution.errorMessage?.includes(HAR_RUNTIME_MODULE.replace(/\.ts$/, ''))) {
      return notEvaluated(
        test,
        startedAt,
        `"${test.name}" was not evaluated: QAAI's hermetic-replay module could not be loaded into the Playwright process. This is a QAAI problem, not a failure of the application under test. Playwright said: ${
          execution.errorMessage ?? '(no output)'
        }`.slice(0, 2000),
      );
    }

    let artifactKey: string | null = null;
    if (config.mode === 'record' && archive && archive.log.entries.length > 0) {
      try {
        // Persistent, not run-scoped: a recording that retention sweeps in
        // thirty days is a recording nobody can replay in thirty-one.
        artifactKey = await ctx.artifacts.putPersistent(
          `${test.id}_network.har.json`,
          Buffer.from(JSON.stringify(archive, null, 2), 'utf8'),
          'application/json',
        );
      } catch (err) {
        ctx.logger.warn('har artifact upload failed', { testId: test.id, err: String(err) });
      }
    }

    /*
     * Read off the ORIGINAL spec, not the one the epilogue was appended to: the
     * epilogue is QAAI's own code, and matching `request` inside it would put a
     * caveat on every run. What matters is whether the CUSTOMER's test sends
     * traffic the route handler is structurally unable to see.
     */
    const unroutable = unroutableTransports(test.code);
    const summary = summariseHarRun(report, config, { staleness, artifactKey, unroutable });
    ctx.logger.info('har run', {
      testId: test.id,
      mode: config.mode,
      hermetic: summary.hermetic,
      served: report?.served ?? 0,
      recorded: report?.recorded ?? 0,
      misses: report?.misses.length ?? 0,
      unroutable,
    });

    return {
      ...withNotice(execution, summary.notice),
      network: [...execution.network, ...harNetworkEntries(report)],
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Execute an E2E test with whatever it is written in. Shared with SMOKE, which
 * differs only in its timeout and its refusal to retry.
 */
export async function runE2ETest(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
  const route = routeFor(test);
  const { config, problem } = parseHarConfig(test.spec, process.env);

  if (route.kind === 'playwright') {
    if (problem) {
      // A HAR config we could not read is not a reason to skip the test, but it
      // is absolutely a reason not to let anyone believe the run was hermetic.
      const execution = await runPlaywrightSpec(ctx, test);
      return withNotice(
        execution,
        `NOT HERMETIC: this test's "har" settings were ignored — ${problem}. The run used the live network.`,
      );
    }
    return config ? runWithHar(ctx, test, config) : runPlaywrightSpec(ctx, test);
  }

  const execution =
    route.kind === 'declared'
      ? await runExternal(ctx, test, route.spec)
      : route.kind === 'catalogue'
        ? await runInEcosystem(ctx, test, route.entry)
        : notEvaluated(
            test,
            Date.now(),
            `"${test.name}" was not evaluated: ${route.why}. Set the test's spec to {"ecosystem": "<id>"} naming a runner from the QAAI catalogue (pytest, junit5-maven, rspec, cypress, …), or to a full external spec ({"command": …, "args": [...], "reportPath": …}) to run it from your own repo.`,
          );

  // Interception lives in the Playwright process, so a routed pytest or RSpec
  // run cannot have it. Saying nothing here would let a spec that asked for
  // replay produce a result that looks hermetic and is not.
  if (config || problem) {
    return withNotice(
      execution,
      'NOT HERMETIC: HAR record/replay is only available for Playwright specs, and this test runs on its own ecosystem\'s runner — the run used the live network. Use your runner\'s own network stubbing, or convert the test to a Playwright spec.',
    );
  }
  return execution;
}

export const e2ePlugin: RunnerPlugin = {
  type: 'E2E',
  validate: validateE2ETest,
  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runE2ETest(ctx, test);
  },
};
