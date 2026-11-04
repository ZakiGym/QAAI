/**
 * Run any test tool QAAI does not implement natively (§4).
 *
 * Vitest, Jest, Mocha, AVA, node:test, Bun, Deno, Cypress, Nightwatch, TestCafe,
 * CodeceptJS, Newman, Pa11y, Lighthouse CI, BackstopJS, Maestro, Detox — the
 * list is long and it will keep growing, so QAAI does not reimplement any of
 * them. It runs the tool's own command and reads the report the tool already
 * knows how to emit.
 *
 * This is the honest version of "we support your framework": your suite runs on
 * its own runner, with its own config and plugins, and QAAI supplies the
 * environment, the secrets, the scheduling, the history, and the triage.
 *
 * Reading the report is the second half of that promise, and all of it lives in
 * ../reports — one parser per format, every one returning the same normalised
 * shape. This plugin does not know whether the tool wrote JUnit XML, TAP, TRX,
 * or `go test -json`, which is the point.
 *
 * Security note: the command is spawned WITHOUT a shell, and args are passed as
 * an array. A test spec is org-authored data, and `shell: true` here would turn
 * it into remote code execution via string interpolation.
 *
 * ── Where it runs, and the defect that is ───────────────────────────────────
 *
 * The workspace used to be `process.cwd()`. On the cloud worker that is QAAI's
 * own checkout, so `npx vitest run` ran QAAI's suite and reported it as the
 * customer's, and `cwd: '../..'` walked out of the monorepo entirely. Both
 * types this plugin serves now execute inside the run's MATERIALISED
 * REPOSITORY (`runWorkspaceOf(ctx)`, written by the worker — see
 * apps/worker/src/repo-materialise.ts), and when there is no repository they
 * report that they were not evaluated instead of producing a verdict about the
 * wrong tree.
 *
 * ── UNIT_GEN: the generated file has to exist ───────────────────────────────
 *
 * A UNIT_GEN test is a file QAAI wrote; its command names that file. Nothing
 * ever put it on disk, so the command pointed at a path that did not exist and
 * the type could not run at all. {@link writeGeneratedTest} writes `test.code`
 * to `test.filePath` — repo-root-relative, the same meaning that path has in
 * the export and in the customer's own tree — before the command is spawned.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { controlEnforces, controlMode, externalTestSpecSchema } from '@qaai/shared';
import type {
  ConsoleEntry,
  ControlMode,
  ExecutableTest,
  ExternalTestSpec,
  RunContext,
  RunnerPlugin,
  TestExecution,
} from '@qaai/shared';
import type { ParsedReport } from '../reports/types.js';
import {
  detectReportFormat,
  parseReport,
  resolveReportFormat,
  summariseReport,
  toStepResults,
} from '../reports/index.js';
import { childEnv, isInterpreterEnvKey } from '../child-env.js';
import { resolveInsideWorkspace, runWorkspaceOf } from '../run-workspace.js';
import {
  resolveScopedSecrets,
  scopeAudit,
  unscopedSecrets,
  withheldNote,
} from '../secrets.js';
import type { ScopableSecret, SecretScopeRow, SecretTarget } from '../secrets.js';

/** Guard: a spec-supplied report path must stay inside the workspace. */
export function safeReportPath(workspace: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new Error('reportPath must be relative to the workspace');
  const full = resolve(join(workspace, relPath));
  if (full !== resolve(workspace) && !full.startsWith(resolve(workspace) + sep)) {
    throw new Error('reportPath escapes the workspace');
  }
  return full;
}

/**
 * "QAAI could not run this", in the shape the rest of the repo uses for it.
 *
 * SKIPPED plus a sentence naming what to configure — the same answer a missing
 * plugin (`reasonUnsupported`), an uninstalled browser engine and an absent
 * mutation tool already give. Never a pass, and never a FAILED that reads as a
 * verdict on the customer's application.
 */
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
 * A test that can never run AS WRITTEN, which is a different thing.
 *
 * A `filePath` that escapes the workspace is not an environment gap somebody
 * could install their way out of — it is a broken test, and the only person who
 * can fix it is the one looking at the suite. A SKIP would hide it behind "not
 * evaluated" while the gate stayed green, so it fails, loudly, with the path.
 */
function unrunnableAsWritten(
  test: ExecutableTest,
  startedAt: number,
  why: string,
): TestExecution {
  return { ...notEvaluated(test, startedAt, why), status: 'FAILED' };
}

export const externalPlugin: RunnerPlugin = {
  type: 'INTEGRATION',

  validate(test: ExecutableTest): void {
    const parsed = externalTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`External test "${test.name}" has an invalid spec — ${issues}`);
    }
  },

  async execute(ctx, test) {
    const startedAt = Date.now();
    const spec = externalTestSpecSchema.parse(test.spec);

    /*
     * The run processor already skips a repo-dependent test when no workspace
     * was materialised, and says precisely why. This is the second lock: the
     * plugin must not be runnable against the worker's own directory even if a
     * future caller forgets, because that is the whole defect.
     */
    const workspace = runWorkspaceOf(ctx);
    if (!workspace) {
      return notEvaluated(
        test,
        startedAt,
        `"${test.name}" runs your own command inside your repository, and this run has no ` +
          'checkout of it, so nothing was executed. Connect the project to its repository ' +
          '(Project settings → Repository) and re-run.',
      );
    }

    // The generated source for a UNIT_GEN test. INTEGRATION deliberately gets
    // none: its spec points at the customer's existing suite, and writing a
    // QAAI-held blob into their tree is a change nobody asked for.
    if (test.type === 'UNIT_GEN') {
      const written = await writeGeneratedTest(workspace.root, test);
      if (!written.ok) return unrunnableAsWritten(test, startedAt, written.why);
      return runExternal(ctx, test, spec, {
        workspace: workspace.root,
        // Both types this plugin serves run in the CUSTOMER'S checkout, which is
        // the one tree QAAI installs nothing in. Stated here, where it is known,
        // rather than defaulted in `runExternal`, where it is not.
        workspaceKind: 'MATERIALISED_REPOSITORY',
        extraConsole: written.console,
        security: securityInputsOf(ctx),
      });
    }

    return runExternal(ctx, test, spec, {
      workspace: workspace.root,
      workspaceKind: 'MATERIALISED_REPOSITORY',
      security: securityInputsOf(ctx),
    });
  },
};

/**
 * Put the generated test on disk at `test.filePath`, inside the workspace.
 *
 * Two hazards, both decided here rather than left to the caller:
 *
 *  **Traversal.** `filePath` is model-authored and this write happens as the
 *  WORKER, which holds VAULT_MASTER_KEY — so an absolute path or one containing
 *  `..` is refused outright by {@link resolveInsideWorkspace}. It is not
 *  sanitised into something safe: a path that was wrong should be reported as
 *  wrong, not quietly relocated.
 *
 *  **Clobbering.** The materialised repository very often ALREADY has a file
 *  here, because committing QAAI's generated tests is the advertised workflow.
 *  Refusing in that case would make the feature destroy itself the moment it
 *  succeeded — every UNIT_GEN test would stop running as soon as it was pushed.
 *  So the version QAAI holds for this test wins (it is the test being run, and
 *  it is the code the cockpit shows), the workspace is a throwaway copy so the
 *  customer's real repository is never touched, and when the contents differ it
 *  is SAID: a console line on the result, which is where someone reading the
 *  run will see it. Overwritten, never silently.
 */
async function writeGeneratedTest(
  root: string,
  test: ExecutableTest,
): Promise<{ ok: true; console: ConsoleEntry[] } | { ok: false; why: string }> {
  if (!test.filePath.trim()) {
    return {
      ok: false,
      why: `"${test.name}" is a generated unit test with no file path, so there is nowhere to write it and nothing for the command to run.`,
    };
  }

  const target = resolveInsideWorkspace(root, test.filePath);
  if (!target) {
    return {
      ok: false,
      why:
        `Refusing to write "${test.name}" to ${test.filePath}: a generated test's path must be ` +
        'relative to the repository root and must not climb out of it. Nothing was executed.',
    };
  }

  const existing = await readFile(target, 'utf8').catch(() => null);
  const notes: ConsoleEntry[] = [];
  if (existing !== null && existing !== test.code) {
    notes.push({
      level: 'warn',
      text:
        `${test.filePath} already exists in the checked-out repository and differs from the ` +
        'version QAAI holds for this test. The run used QAAI\'s version — your repository was ' +
        'not modified. Push the generated test, or point this test at a different path.',
      at: new Date().toISOString(),
    });
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, test.code, 'utf8');
  return { ok: true, console: notes };
}

/** Shared by the external plugin and any type that wants to shell out. */
/**
 * The signatures every ecosystem uses when a suite fails to import.
 *
 * Matched against failure MESSAGES only, never against a test name — a test
 * legitimately called "reports a helpful error when the module is missing"
 * must not be swept up.
 */
const LOAD_ERROR = new RegExp(
  [
    'ModuleNotFoundError',
    'ImportError',
    'No module named',
    "Cannot find module",
    'ERR_MODULE_NOT_FOUND',
    'NoClassDefFoundError',
    'ClassNotFoundException',
    'could not resolve',
    'collection failure',
    'error during collection',
    'LoadError',
    'cannot load such file',
    'undefined method .* for nil',
    'package .* is not in',
    'error: could not compile',
  ].join('|'),
  'i',
);

/**
 * Returns the load-error message when EVERY failure in the report is one, or
 * null when any failure looks like a real assertion.
 */
export function onlyLoadErrors(parsed: ParsedReport): string | null {
  const failures = parsed.tests.filter((t) => t.status === 'failed');
  if (failures.length === 0) return null;

  const messages = failures.map((t) =>
    `${t.failureMessage ?? ''} ${t.stack ?? ''}`.trim(),
  );
  if (!messages.every((m) => LOAD_ERROR.test(m))) return null;

  // Report the first one, trimmed to a sentence a person can act on.
  return (messages[0] ?? 'the suite failed to load').split('\n')[0]!.slice(0, 300);
}

/**
 * WHICH tree the command ran in, because it decides the remedy for a suite that
 * could not load.
 *
 * ── The wrong sentence this exists to stop ─────────────────────────────────
 *
 * The load-gap path below used to say, for every caller: "This is a dependency
 * missing from the worker — install it in the worker image and re-run." That is
 * right for QAAI's own scratch trees and WRONG for the two types this plugin
 * exists to serve. INTEGRATION and UNIT_GEN execute inside the run's
 * MATERIALISED REPOSITORY, and `materialiseRepoWorkspace` extracts the tarball
 * and runs no package manager — no `npm ci`, no `pip install`, nothing —
 * deliberately, because running a third-party repository's install hooks on the
 * worker is arbitrary code execution. So the usual cause of
 * `Cannot find module` there is QAAI's own documented default, the worker image
 * is fine, and the remedy named a change nobody can make to fix it. A remedy
 * that cannot work is worse than no remedy: it sends the reader to the wrong
 * place and spends their afternoon there.
 *
 * ABSENT is a third answer and not a default for one of the two. A caller that
 * does not say which tree it built gets a sentence naming both causes, because
 * "we do not know which tree this was" is the truth in that case and picking
 * the likelier one is how the wrong sentence got written the first time.
 */
export const EXTERNAL_WORKSPACE_KINDS = [
  /** The customer's repository, checked out for this run. Nothing is installed in it. */
  'MATERIALISED_REPOSITORY',
  /** A throwaway tree QAAI built for one test, beside QAAI's own dependencies. */
  'SCRATCH_TREE',
] as const;
export type ExternalWorkspaceKind = (typeof EXTERNAL_WORKSPACE_KINDS)[number];

const EXTERNAL_WORKSPACE_KIND_PRESENT: Record<ExternalWorkspaceKind, true> = {
  MATERIALISED_REPOSITORY: true,
  SCRATCH_TREE: true,
};

/** Derived, never hand-listed. */
export const EXTERNAL_WORKSPACE_KIND_LIST = Object.keys(
  EXTERNAL_WORKSPACE_KIND_PRESENT,
) as ReadonlyArray<ExternalWorkspaceKind>;

/**
 * The sentence a suite that could not load carries.
 *
 * Exported so it is tested directly: the three branches differ only in prose,
 * which is exactly the kind of difference that rots silently behind a status
 * assertion. The status is SKIPPED in all three cases and always was — a
 * configuration gap is not a verdict on the application — so a test that only
 * checks the status cannot tell the right sentence from the wrong one.
 */
export function loadGapRemedy(
  loadGap: string,
  kind: ExternalWorkspaceKind | undefined,
): string {
  const head = `The suite could not be loaded, so no test was evaluated: ${loadGap}.`;
  const notTheApp = 'This is a configuration gap, not a failure of the application under test.';

  if (kind === 'MATERIALISED_REPOSITORY') {
    return (
      `${head} ${notTheApp} QAAI checks your repository out for the run and installs NOTHING ` +
      'in it — running a repository\'s own install hooks on the worker is arbitrary code ' +
      'execution, so it is not done by default. Either have this test\'s command install its ' +
      'dependencies first (for example `npm ci && npx vitest run …`), or commit a vendored ' +
      'dependency tree. Installing anything in QAAI\'s worker image will not fix this.'
    );
  }
  if (kind === 'SCRATCH_TREE') {
    return (
      `${head} ${notTheApp} This ran in a scratch tree QAAI built, so the missing dependency ` +
      'is one the worker image is expected to provide — install it in the image and re-run.'
    );
  }
  return (
    `${head} ${notTheApp} The caller did not record which tree this ran in, so the cause is ` +
    'one of two: a dependency missing from QAAI\'s worker image, or — if this ran inside a ' +
    'checkout of your repository — the dependencies QAAI deliberately does not install there. ' +
    'Check which directory the command ran in before acting on either.'
  );
}


// ─── The command allowlist, and the planted binary it exists to stop ─────────

/**
 * A test spec names its own executable. `spec.command` is a MEMBER-authored
 * string that reaches `spawn()` with the worker's filesystem, the worker's
 * network and the worker's PATH, which is how `psql`, `redis-cli`, `mc` and
 * `curl` were all one spec field away from our own postgres, redis and MinIO.
 * The spawn is already shell-free and already argv-array — that stopped string
 * interpolation and nothing else.
 *
 * ── WHAT THIS CONTROL ACTUALLY REMOVES ─────────────────────────────────────
 *
 * Four things, each of them reproduced before it was fixed:
 *
 *  1. THE PLANTED BINARY. `spec.command` could be a path, and the tenant can
 *     WRITE to the workspace — `test.code` goes to `test.filePath`, fixtures go
 *     to their own paths, and the customer's own repository is extracted there.
 *     So `./planted`, `node_modules/.bin/anything` or an absolute path executed
 *     a file the TENANT had put on disk. A command must now be a BARE NAME: no
 *     `/`, no `\`, no `.` segment, nothing the operating system would resolve
 *     against a directory. Only a binary the worker IMAGE put on PATH can run.
 *
 *  2. THE PATH OVERRIDE, which defeats (1) on its own and was live. `spec.env`
 *     flows into `childEnv({ extra })`, which applies extras AFTER the
 *     passthrough and therefore OVERWRITES `PATH` — and `isForbiddenChildEnvKey`
 *     does not screen `PATH`, because the name contains none of the secret-ish
 *     substrings. libuv resolves the executable using the PATH in the env object
 *     it is handed, so `env: { PATH: '<the workspace>' }` plus a planted file
 *     named `vitest` turns an allowlisted bare name back into tenant code.
 *     {@link screenSpecEnv} is that fix, and it covers the whole family:
 *     `NODE_OPTIONS` (`--require` runs before the first line of the runner),
 *     `PYTHONPATH` (this environment's own instructions warn that a planted
 *     `json.py` runs on `import json`), `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`,
 *     `RUBYOPT`, `PERL5OPT`, `JAVA_TOOL_OPTIONS`, `CLASSPATH`.
 *
 *  3. THE SHELL, which `shell: false` does not fully close. `npx -c '<string>'`
 *     and `npm run '<script>'` both hand text to a shell on the child's own
 *     initiative, so an argv array does not save us. `-c`/`--call` is refused,
 *     and a script name must be a single `[A-Za-z0-9:._-]+` token — which is
 *     what makes `npm run 'test; curl http://…'` a refusal rather than a
 *     request.
 *
 *  4. THE GENERAL-PURPOSE TOOL. `sh`, `bash`, `env`, `xargs`, `curl`, `psql`,
 *     `aws` are simply not on the list, and nothing is on it by default.
 *
 * ── WHAT IT DOES NOT DO, STATED HERE SO NOBODY RELIES ON IT ────────────────
 *
 * It does not contain the test code. Every runner on this list exists to load
 * and execute files from the workspace, and those files are the tenant's. A
 * vitest spec can open a socket with `node:net`; `pytest` can import anything;
 * `node --test` and `node -e` are the same amount of power as either. So this
 * allowlist narrows WHICH PROCESS STARTS and WHAT ENVIRONMENT IT STARTS IN —
 * it is not a sandbox, and `plugins/sandbox.ts` makes the same distinction at
 * length for plugin code: the only real containment against hostile tenant code
 * is outside the process (a container with no egress, Node's permission model).
 * Describing this as "tests cannot reach the database" would be the kind of
 * false assurance an operator then builds on.
 *
 * ── THE BRAKE, AND THE LEGITIMATE THING ENFORCE BREAKS ─────────────────────
 *
 * `./gradlew` and `./mvnw` are repo-committed wrapper scripts, they are the
 * documented way to run a Java or Kotlin suite, and they are relative paths to
 * a file in the workspace — which is to say they are indistinguishable, to this
 * control, from the planted binary in (1). They are also, in all likelihood,
 * what some existing customer's INTEGRATION test says today. So the command
 * rule defaults to **OBSERVE**: it runs the command, counts the refusal and
 * says so on the result, and the count is the list of specs somebody has to
 * look at before arming it.
 *
 * {@link screenSpecEnv} defaults to **ENFORCE** instead, and the asymmetry is
 * deliberate rather than an oversight: a tenant spec that sets `PATH`,
 * `NODE_OPTIONS` or `LD_PRELOAD` is not a workflow QAAI has ever documented,
 * `childEnv` already drops a comparable class of names without asking, and (2)
 * is the hole that makes (1) pointless. Enforcing it drops those variables from
 * the child's environment — the command still runs, and the count is reported.
 */

/** How this runner's arguments are read. */
export const RUNNER_ARG_RULES = [
  /** The runner's own flags. Unrestricted — see "what it does not do" above. */
  'DIRECT',
  /** `npx <runner> …`: the first positional must itself be an allowed runner. */
  'PACKAGE_RUNNER',
  /** `npm run <script>`: a subcommand, then a token a shell cannot be hidden in. */
  'SCRIPT_RUNNER',
  /** `python -m <module>`: the module must be a test module, not a program. */
  'MODULE_RUNNER',
] as const;
export type RunnerArgRule = (typeof RUNNER_ARG_RULES)[number];

/**
 * The known test runners, by bare executable name.
 *
 * A name is here because somebody runs a SUITE with it. `curl`, `sh`, `psql`,
 * `aws` and `mc` are absent and that absence is the point; so is the absence of
 * a wildcard. The list will grow — the honest answer to a customer whose runner
 * is missing is to add it here, not to let the field be free text, and the
 * OBSERVE count is how we learn which names to add.
 */
export const EXTERNAL_RUNNERS: Readonly<Record<string, RunnerArgRule>> = {
  // JS / TS
  vitest: 'DIRECT',
  jest: 'DIRECT',
  mocha: 'DIRECT',
  ava: 'DIRECT',
  tap: 'DIRECT',
  tape: 'DIRECT',
  jasmine: 'DIRECT',
  karma: 'DIRECT',
  cypress: 'DIRECT',
  playwright: 'DIRECT',
  nightwatch: 'DIRECT',
  testcafe: 'DIRECT',
  codeceptjs: 'DIRECT',
  wdio: 'DIRECT',
  newman: 'DIRECT',
  pa11y: 'DIRECT',
  'pa11y-ci': 'DIRECT',
  lhci: 'DIRECT',
  backstop: 'DIRECT',
  k6: 'DIRECT',
  artillery: 'DIRECT',
  // `node` is the node:test runner, and `node -e` is no more powerful than any
  // test file an allowed runner loads. See "what it does not do".
  node: 'DIRECT',
  deno: 'DIRECT',
  bun: 'SCRIPT_RUNNER',

  // Package-manager fronts. These take the real runner as their first argument.
  npx: 'PACKAGE_RUNNER',
  bunx: 'PACKAGE_RUNNER',
  npm: 'SCRIPT_RUNNER',
  yarn: 'SCRIPT_RUNNER',
  pnpm: 'SCRIPT_RUNNER',

  // Python
  pytest: 'DIRECT',
  tox: 'DIRECT',
  nox: 'DIRECT',
  behave: 'DIRECT',
  robot: 'DIRECT',
  locust: 'DIRECT',
  python: 'MODULE_RUNNER',
  python3: 'MODULE_RUNNER',

  // Ruby
  rspec: 'DIRECT',
  cucumber: 'DIRECT',
  rake: 'DIRECT',
  bundle: 'PACKAGE_RUNNER',

  // JVM
  mvn: 'DIRECT',
  gradle: 'DIRECT',

  // Go, .NET, PHP, Rust
  go: 'DIRECT',
  gotestsum: 'DIRECT',
  dotnet: 'DIRECT',
  phpunit: 'DIRECT',
  pest: 'DIRECT',
  composer: 'SCRIPT_RUNNER',
  cargo: 'DIRECT',

  // Mobile
  maestro: 'DIRECT',
  detox: 'DIRECT',
  flutter: 'DIRECT',
  xcodebuild: 'DIRECT',
};

/** Derived from the table, never hand-listed. */
export const EXTERNAL_RUNNER_NAMES = Object.keys(EXTERNAL_RUNNERS);

/** Subcommands a SCRIPT_RUNNER may be given. Nothing that installs or publishes. */
const SCRIPT_SUBCOMMANDS = new Set(['run', 'run-script', 'test', 'exec', 'x']);

/**
 * Modules `python -m` may run. Each one is a test harness; none is a shell, an
 * HTTP client or an interactive interpreter. `-m http.server` and `-m pip` are
 * the kind of thing this excludes.
 */
const PYTHON_TEST_MODULES = new Set(['pytest', 'unittest', 'nose2', 'robot', 'behave', 'tox', 'nox']);

/**
 * A script name npm, yarn or pnpm may be asked for.
 *
 * Strict because these package managers hand the script BODY to a shell, so the
 * name is the one argument where a metacharacter is not inert. A name outside
 * this alphabet cannot be a real npm script and can be a command.
 */
const SCRIPT_TOKEN = /^[A-Za-z0-9:._-]{1,80}$/;

/**
 * Environment names a tenant spec may not set, because each one changes how an
 * allowed interpreter LOADS CODE before the first line of the test runs — or,
 * for `PATH`, which binary "an allowed bare name" resolves to.
 *
 * THE LIST NOW LIVES IN `../child-env.ts` AND IS RE-EXPORTED HERE, which is a
 * fix and not a tidy-up. `Secret.name` is `/^[A-Z][A-Z0-9_]*$/`, so `PATH` is a
 * legal secret name, and `childEnv` applied `secrets` after these screened
 * extras and without screening them — so defect (2) in this file's header was
 * still reachable by writing a secret row instead of a `spec.env` entry.
 * Reproduced with a real spawn before it was moved. One list, applied at the
 * single point every spawn in this package goes through, plus this screen on
 * top of it because THIS one reports what it refused on the test's result.
 */
export { isInterpreterEnvKey };

/** Why a command was refused. Operator-facing; see {@link EXTERNAL_COMMAND_REFUSAL_SENTENCE}. */
export const COMMAND_REFUSALS = [
  /** A path, not a bare name — so it could resolve to a file the tenant wrote. */
  'NOT_A_BARE_NAME',
  /** A bare name, but not one of the known runners. */
  'NOT_AN_ALLOWED_RUNNER',
  /** `npx -c '<string>'` and friends: an argument a shell will read. */
  'SHELL_STRING_ARGUMENT',
  /** `npx <x>` / `npm exec <x>` where `<x>` is not itself an allowed runner. */
  'NESTED_COMMAND_NOT_ALLOWED',
  /** A subcommand outside the small set a script runner may be given. */
  'SUBCOMMAND_NOT_ALLOWED',
  /** A script name a shell could hide a second command in. */
  'SCRIPT_NAME_NOT_A_TOKEN',
  /** `python -m <something that is not a test module>`, or no `-m` at all. */
  'MODULE_NOT_ALLOWED',
] as const;
export type CommandRefusal = (typeof COMMAND_REFUSALS)[number];

/** Compile-time presence; the run-time half is the parity test on the list. */
const COMMAND_REFUSAL_PRESENT: Record<CommandRefusal, true> = {
  NOT_A_BARE_NAME: true,
  NOT_AN_ALLOWED_RUNNER: true,
  SHELL_STRING_ARGUMENT: true,
  NESTED_COMMAND_NOT_ALLOWED: true,
  SUBCOMMAND_NOT_ALLOWED: true,
  SCRIPT_NAME_NOT_A_TOKEN: true,
  MODULE_NOT_ALLOWED: true,
};

/** Derived, never hand-listed. */
export const COMMAND_REFUSAL_LIST = Object.keys(
  COMMAND_REFUSAL_PRESENT,
) as ReadonlyArray<CommandRefusal>;

/**
 * ONE SENTENCE FOR EVERY REFUSAL, and it is the same sentence for all seven.
 *
 * The same rule `EGRESS_REFUSAL_SENTENCE` states in packages/shared/src/egress.ts.
 * A message that said "`psql` is not an allowed runner" while another said
 * "`/opt/acme/bin/suite` is not a bare name" would tell a tenant which binaries
 * exist on our worker and, by elimination, what the allowlist holds — turning a
 * refusal into a probe. The reason lives on {@link CommandVerdict.refusal},
 * which is read inside the tenant's own run record by somebody who is allowed
 * to know.
 *
 * It names NO command, NO path and NO allowlist entry. It does name the one
 * thing the author can act on: that the command has to be a test runner's bare
 * name, and that QAAI will add a runner it does not know yet.
 *
 * It deliberately says NOTHING about what happened to the run, because that
 * depends on the mode and the same string is used in both. A sentence reading
 * "nothing was executed" on an OBSERVE path, where the command ran, is a
 * message that contradicts the code under it — which in this round's rules is a
 * defect in its own right, and it was one here until the suite caught it.
 * {@link EXTERNAL_COMMAND_ENFORCED} and {@link EXTERNAL_COMMAND_OBSERVED} add
 * the outcome.
 */
export const EXTERNAL_COMMAND_REFUSAL_SENTENCE =
  'This test names a command QAAI will not run. A test command must be the bare name of a ' +
  'test runner — not a path, not a shell invocation, and not a name with another command ' +
  'hidden in its arguments. If your suite runs on a tool QAAI does not know yet, ask ' +
  'support to add it.';

/** What the author is told when the allowlist is enforced. */
export const EXTERNAL_COMMAND_ENFORCED = `${EXTERNAL_COMMAND_REFUSAL_SENTENCE} Nothing was executed.`;

/** And when it is only observed — which is the default. See the section header. */
export const EXTERNAL_COMMAND_OBSERVED =
  `${EXTERNAL_COMMAND_REFUSAL_SENTENCE} QAAI is in observe mode for test commands, so this ` +
  'one WAS executed and the refusal was only counted. Change the command before it is enforced.';

export type CommandVerdict =
  | { readonly allowed: true; readonly runner: string }
  | { readonly allowed: false; readonly refusal: CommandRefusal; readonly detail: string };

/** A bare executable name: no directory separator, no `.` or `..` segment, no NUL. */
function isBareName(command: string): boolean {
  if (command.length === 0 || command.length > 80) return false;
  if (command !== command.trim()) return false;
  // A separator in either slash direction, a drive letter, or a shell/control
  // character. `shell: false` makes metacharacters inert as ARGUMENTS, but a
  // command containing one was never going to be a binary name.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command) && command !== '.' && command !== '..';
}

/** The first argument that is not a flag, with its index. */
function firstPositional(args: readonly string[]): { value: string; index: number } | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith('-')) continue;
    return { value: arg, index: i };
  }
  return null;
}

/**
 * MAY THIS SPEC'S COMMAND RUN. Pure: no filesystem probe, no `which`, no spawn.
 *
 * Deliberately NOT a check against what is installed. Asking the filesystem
 * "does this binary exist" would make the answer depend on the worker image and
 * would make the refusal an existence oracle — the two things rule 12 of this
 * round forbids. A command not on the list is refused whether or not it is
 * installed, and a command on the list that is absent is reported as "not
 * installed on this worker" by the existing ENOENT path, which is a different
 * and honest answer.
 */
export function classifyExternalCommand(spec: {
  command: string;
  args: readonly string[];
}): CommandVerdict {
  const { command, args } = spec;

  if (!isBareName(command)) {
    return {
      allowed: false,
      refusal: 'NOT_A_BARE_NAME',
      // `detail` is operator-facing and may quote the spec, which is the
      // tenant's own text inside the tenant's own run.
      detail: `command "${command}" is a path or contains a character a binary name cannot`,
    };
  }

  const rule = EXTERNAL_RUNNERS[command];
  if (!rule) {
    return {
      allowed: false,
      refusal: 'NOT_AN_ALLOWED_RUNNER',
      detail: `"${command}" is not a known test runner`,
    };
  }

  // `-c`/`--call` makes npx run a string through a shell, and `-p`/`--package`
  // decouples the package that is installed from the binary that is run, so the
  // positional stops being the thing we checked.
  if (rule === 'PACKAGE_RUNNER' || rule === 'SCRIPT_RUNNER') {
    const shellFlag = args.find(
      (arg) =>
        arg === '-c' ||
        arg === '--call' ||
        arg === '-p' ||
        arg === '--package' ||
        arg.startsWith('--package='),
    );
    if (shellFlag !== undefined) {
      return {
        allowed: false,
        refusal: 'SHELL_STRING_ARGUMENT',
        detail: `"${command} ${shellFlag}" hands a string to a shell or re-points the binary`,
      };
    }
  }

  switch (rule) {
    case 'DIRECT':
      return { allowed: true, runner: command };

    case 'PACKAGE_RUNNER': {
      const nested = firstPositional(args);
      if (!nested) {
        return {
          allowed: false,
          refusal: 'NESTED_COMMAND_NOT_ALLOWED',
          detail: `"${command}" was given no runner to run`,
        };
      }
      // `bundle exec rspec` — step over the subcommand and check what follows.
      const target =
        nested.value === 'exec' || nested.value === 'run'
          ? firstPositional(args.slice(nested.index + 1))
          : nested;
      if (!target || !isBareName(target.value) || !EXTERNAL_RUNNERS[target.value]) {
        return {
          allowed: false,
          refusal: 'NESTED_COMMAND_NOT_ALLOWED',
          detail: `"${command}" was asked to run "${target?.value ?? ''}", which is not a known test runner`,
        };
      }
      return { allowed: true, runner: `${command} ${target.value}` };
    }

    case 'SCRIPT_RUNNER': {
      const sub = firstPositional(args);
      if (!sub || !SCRIPT_SUBCOMMANDS.has(sub.value)) {
        return {
          allowed: false,
          refusal: 'SUBCOMMAND_NOT_ALLOWED',
          detail: `"${command} ${sub?.value ?? ''}" is not one of ${[...SCRIPT_SUBCOMMANDS].join(', ')}`,
        };
      }
      const rest = firstPositional(args.slice(sub.index + 1));
      // `exec`/`x` run a binary, so they are checked as a nested command.
      if (sub.value === 'exec' || sub.value === 'x') {
        if (!rest || !isBareName(rest.value) || !EXTERNAL_RUNNERS[rest.value]) {
          return {
            allowed: false,
            refusal: 'NESTED_COMMAND_NOT_ALLOWED',
            detail: `"${command} ${sub.value}" was asked to run "${rest?.value ?? ''}"`,
          };
        }
        return { allowed: true, runner: `${command} ${sub.value} ${rest.value}` };
      }
      // `test` needs no script name; `run` does, and it reaches a shell.
      if (!rest) {
        if (sub.value === 'test') return { allowed: true, runner: `${command} test` };
        return {
          allowed: false,
          refusal: 'SCRIPT_NAME_NOT_A_TOKEN',
          detail: `"${command} ${sub.value}" was given no script name`,
        };
      }
      if (!SCRIPT_TOKEN.test(rest.value)) {
        return {
          allowed: false,
          refusal: 'SCRIPT_NAME_NOT_A_TOKEN',
          detail: `"${rest.value}" is not a single script name, and npm hands a script to a shell`,
        };
      }
      return { allowed: true, runner: `${command} ${sub.value} ${rest.value}` };
    }

    case 'MODULE_RUNNER': {
      const flagIndex = args.findIndex((arg) => arg === '-m');
      const moduleName = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
      if (moduleName === undefined || !PYTHON_TEST_MODULES.has(moduleName)) {
        return {
          allowed: false,
          refusal: 'MODULE_NOT_ALLOWED',
          detail: `"${command}" may only run a test module with -m; it was given "${moduleName ?? ''}"`,
        };
      }
      return { allowed: true, runner: `${command} -m ${moduleName}` };
    }
  }
}

/**
 * The tenant's `spec.env`, minus the variables that would change how an allowed
 * interpreter loads code — or which binary an allowed bare name resolves to.
 *
 * ENFORCE drops them and the command still runs. OBSERVE passes them through
 * and counts, which is the honest reading of a brake, but note the default is
 * ENFORCE here: see the asymmetry argued in the section header. Either way the
 * count is reported, because a cap applied without being counted is one of the
 * lies this product cannot afford.
 *
 * The count is the whole report. The KEY NAMES are not surfaced to the author:
 * a tenant may name a variable anything, including something that is itself a
 * credential reference, and `childEnv` already drops a comparable class of
 * names without printing them.
 */
export function screenSpecEnv(
  env: Readonly<Record<string, string>>,
  mode: ControlMode,
): { env: Record<string, string>; refused: number } {
  const out: Record<string, string> = {};
  let refused = 0;
  for (const [key, value] of Object.entries(env)) {
    if (isInterpreterEnvKey(key)) {
      refused += 1;
      if (controlEnforces(mode)) continue;
    }
    out[key] = value;
  }
  return { env: out, refused };
}

/**
 * The brake defaults, in one place because they are the first thing a reviewer
 * checks and the easiest thing to lose in a refactor.
 *
 * NEITHER OF THESE IS IN `SECURITY_CONTROLS` YET. That list is
 * @qaai/shared's and is owned elsewhere this round, so these two modes are
 * parameters with stated defaults rather than an invented second vocabulary:
 * the `ControlMode` type, `controlEnforces` and the OBSERVE-must-count rule are
 * all the house's. The hand-off notes for this round ask for
 * `EXTERNAL_COMMAND_ALLOWLIST` and `EXTERNAL_SPEC_ENV_SCREEN` members so the
 * mode can be stored per organisation like the other thirteen; until then the
 * caller passes it and absence means the default below.
 */
export const COMMAND_POLICY_DEFAULTS = {
  /** OBSERVE: `./gradlew` and `./mvnw` are legitimate and would be refused. */
  command: 'OBSERVE',
  /** ENFORCE: no documented workflow sets PATH or NODE_OPTIONS in a spec. */
  specEnv: 'ENFORCE',
} as const satisfies Record<'command' | 'specEnv', ControlMode>;

/**
 * THE FACTS THESE TWO CONTROLS NEED FROM THE RUN, which `RunContext` does not
 * carry yet.
 *
 * `RunContext.secrets` is a flat name→value map: no `Secret.id`, so nothing in
 * it can be matched against a `SecretScope.secretId`, and no `suiteId`, so the
 * SUITE scope kind cannot be decided. The run processor is the only place that
 * can supply either, and apps/worker/src/processors/run.ts is not this agent's
 * file this round — so the shape it has to adopt is declared HERE, read off the
 * context structurally, and named in the hand-off notes with the exact edit.
 *
 * That is not a loophole. A context with none of these fields resolves to
 * `source: 'UNAVAILABLE'`, which is reported as NOT MEASURED rather than as a
 * clean zero, and in ENFORCE it withholds every secret. Which is also why the
 * scoping control's house default is OBSERVE: see
 * `SECURITY_CONTROL_BRAKES.SECRET_TEST_SCOPING`.
 */
export interface RunnerSecurityInputs {
  /** `Organization.securityControlModes`, straight from the row. Parsed defensively. */
  readonly securityControlModes?: unknown;
  /** The environment's secrets WITH their ids, so scope rows can be matched. */
  readonly scopableSecrets?: readonly ScopableSecret[];
  /** The scope rows, or `'UNAVAILABLE'` when the read did not happen. */
  readonly secretScopes?: readonly SecretScopeRow[] | 'UNAVAILABLE';
  /** `Run.suiteId`. A run-level fact; `ExecutableTest` has no suite. */
  readonly suiteId?: string | null;
}

/**
 * The two keys this file would read out of `Organization.securityControlModes`
 * if `SECURITY_CONTROLS` had members for them. It does not yet — see
 * {@link COMMAND_POLICY_DEFAULTS} — so the keys are named here so that the
 * stored value and the reader cannot be spelt differently when the members land.
 */
export const COMMAND_POLICY_CONTROL_KEYS = {
  command: 'EXTERNAL_COMMAND_ALLOWLIST',
  specEnv: 'EXTERNAL_SPEC_ENV_SCREEN',
} as const;

/**
 * `controlMode()`'s semantics for a control the shared list does not name yet:
 * never throws, and an absent, malformed or unknown stored value resolves to
 * the stated default rather than to the permissive answer.
 */
function policyMode(stored: unknown, key: string, fallback: ControlMode): ControlMode {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return fallback;
  const raw = (stored as Record<string, unknown>)[key];
  return raw === 'OBSERVE' || raw === 'ENFORCE' ? raw : fallback;
}

/** The mode for the command allowlist. Default OBSERVE; the header says why. */
export function commandPolicyMode(security: RunnerSecurityInputs | undefined): ControlMode {
  return policyMode(
    security?.securityControlModes,
    COMMAND_POLICY_CONTROL_KEYS.command,
    COMMAND_POLICY_DEFAULTS.command,
  );
}

/** The mode for the spec-env screen. Default ENFORCE; the header says why. */
export function specEnvPolicyMode(security: RunnerSecurityInputs | undefined): ControlMode {
  return policyMode(
    security?.securityControlModes,
    COMMAND_POLICY_CONTROL_KEYS.specEnv,
    COMMAND_POLICY_DEFAULTS.specEnv,
  );
}

/**
 * Read the security inputs off a `RunContext`.
 *
 * Structural, because the fields are not declared on the type yet. Every field
 * is validated rather than trusted: an array where an object belongs, or a
 * string where the scope rows belong, resolves to the fail-closed answer and
 * not to a crash — a control that throws on a malformed row is a control that
 * is off for as long as the row is malformed.
 */
export function securityInputsOf(ctx: RunContext): RunnerSecurityInputs {
  const bag = ctx as RunContext & Partial<RunnerSecurityInputs>;
  const scopes = bag.secretScopes;
  return {
    securityControlModes: bag.securityControlModes,
    scopableSecrets: Array.isArray(bag.scopableSecrets) ? bag.scopableSecrets : undefined,
    secretScopes: scopes === 'UNAVAILABLE' || Array.isArray(scopes) ? scopes : undefined,
    suiteId: typeof bag.suiteId === 'string' ? bag.suiteId : null,
  };
}

/**
 * WHAT THIS TEST MAY RECEIVE, from whichever source the run supplied.
 *
 * One function so the two paths cannot drift: with ids and rows it is a real
 * measurement; without them it is `unscopedSecrets`, whose `source` says
 * UNAVAILABLE so the count is never reported as a measured zero.
 */
function scopedSecretsFor(
  ctx: RunContext,
  test: ExecutableTest,
  spec: ExternalTestSpec,
  security: RunnerSecurityInputs,
): ReturnType<typeof resolveScopedSecrets> {
  const target: SecretTarget = {
    testId: test.id,
    testType: test.type,
    suiteId: security.suiteId ?? null,
    authProfileId: test.authProfileId ?? null,
  };
  const mode = controlMode('SECRET_TEST_SCOPING', security.securityControlModes);

  if (security.scopableSecrets && security.secretScopes !== undefined) {
    return resolveScopedSecrets({
      secrets: security.scopableSecrets,
      scopes: security.secretScopes,
      target,
      mode,
      requested: spec.secretNames,
    });
  }
  return unscopedSecrets(ctx.secrets, target, mode, spec.secretNames);
}

export interface RunExternalOptions {
  /**
   * The directory `spec.cwd` is resolved against — this run's materialised
   * repository, or a scratch tree a caller made for one test.
   *
   * REQUIRED, and deliberately so. It was optional, defaulting to
   * `process.cwd()`, which on the worker is QAAI's own checkout: a customer's
   * command then ran against OUR source tree and reported a verdict about the
   * wrong repository. The last caller that relied on the fallback was the E2E
   * plugin's in-ecosystem route, which now makes its scratch tree under the
   * system temp directory and passes it here. A required field means the next
   * caller that forgets is a compile error rather than a wrong answer.
   */
  workspace: string;
  /**
   * Which tree that is. OPTIONAL, and absence is reported as absence — see
   * {@link EXTERNAL_WORKSPACE_KINDS}. It is read on exactly one path: the
   * remedy for a suite that could not load.
   */
  workspaceKind?: ExternalWorkspaceKind;
  /** Notes to surface on the result — see {@link writeGeneratedTest}. */
  extraConsole?: ConsoleEntry[];
  /**
   * The modes and the scope rows for the three controls in this file. OPTIONAL,
   * and absence is the fail-closed default rather than a bypass — see
   * {@link RunnerSecurityInputs}.
   */
  security?: RunnerSecurityInputs;
}

export async function runExternal(
  ctx: RunContext,
  test: ExecutableTest,
  spec: ExternalTestSpec,
  options: RunExternalOptions,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const workspace = options.workspace;

  // One array, so every note this function adds lands on every return path.
  const notes: ConsoleEntry[] = [...(options.extraConsole ?? [])];
  const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
    testId: test.id,
    durationMs: 0,
    network: [],
    console: notes,
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings: [],
  };

  /*
   * `spec.cwd` is MEMBER-authored and was interpolated straight into
   * `join(workspace, spec.cwd)`, so `../..` ran the command outside the
   * workspace — on the old `process.cwd()` base, outside the monorepo. The
   * schema caps its length and nothing else, so the guard has to be here.
   */
  const workDir =
    spec.cwd === '' || spec.cwd === '.'
      ? resolve(workspace)
      : resolveInsideWorkspace(workspace, spec.cwd);
  if (!workDir) {
    return {
      ...base,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      steps: [],
      errorMessage:
        `This test's working directory ("${spec.cwd}") is not inside the repository, so nothing ` +
        'was executed. Set `cwd` to a path relative to the repository root.',
    };
  }

  /*
   * MAY THIS COMMAND RUN AT ALL. Before the secrets are resolved and before
   * anything is spawned, because a refused command must not reach either.
   *
   * ENFORCE is a FAILED and not a SKIPPED: a command QAAI will not run is a
   * test that can never run AS WRITTEN, the only person who can fix it is the
   * one looking at the suite, and a skip would leave the gate green forever.
   * Same argument `unrunnableAsWritten` makes about an escaping `filePath`.
   *
   * NOT in `validate()`, which is where a reader might look for it first.
   * `validate` takes no `RunContext`, so it cannot read the org's mode — a
   * refusal there would be unconditional, which for THIS control means
   * breaking every customer whose suite runs on `./gradlew` with no brake and
   * no count. It also throws rather than returning a status, so the uniform
   * sentence would arrive as an exception message on an unknown path.
   */
  const commandVerdict = classifyExternalCommand(spec);
  const commandMode = commandPolicyMode(options.security);
  if (!commandVerdict.allowed) {
    // Operator-facing, inside the tenant's own run: the reason and the spec's
    // own text. The sentence the TENANT sees names neither.
    ctx.logger.warn('external test command is not on the runner allowlist', {
      refusal: commandVerdict.refusal,
      detail: commandVerdict.detail,
      mode: commandMode,
    });
    if (controlEnforces(commandMode)) {
      return {
        ...base,
        status: 'FAILED',
        durationMs: Date.now() - startedAt,
        steps: [],
        errorMessage: EXTERNAL_COMMAND_ENFORCED,
      };
    }
    // OBSERVE: it runs, and the refusal is COUNTED where a human will see it.
    // One note per run is the counter — "how many tests carry this" is the
    // worklist for arming the control, and it is the only thing OBSERVE owes.
    notes.push({
      level: 'warn',
      text: EXTERNAL_COMMAND_OBSERVED,
      at: new Date().toISOString(),
    });
  }

  /*
   * WHICH SECRETS THIS TEST MAY RECEIVE. `spec.secretNames` was already the
   * test's own narrowing, and a test asking for everything is not a refusal —
   * the vault had no opinion at all. ../secrets.ts is the opinion; see its
   * header for why the absence of a scope row is the denial.
   */
  const scoped = scopedSecretsFor(ctx, test, spec, options.security ?? {});
  const exposed = scoped.values;
  const scopeNote = withheldNote(scoped);
  if (scopeNote) {
    notes.push({ level: 'warn', text: scopeNote, at: new Date().toISOString() });
    // Counts and causes, never a name or a value. See `scopeAudit`.
    ctx.logger.warn('per-test secret scoping withheld secrets', scopeAudit(scoped));
  }

  /*
   * The tenant's extra environment, minus the variables that would re-point an
   * allowed interpreter — `PATH` above all, which `childEnv` applies AFTER the
   * passthrough and therefore lets a spec overwrite, and which libuv uses to
   * resolve the executable. Without this screen the bare-name rule above is
   * decoration.
   */
  const specEnvMode = specEnvPolicyMode(options.security);
  const screened = screenSpecEnv(spec.env, specEnvMode);
  if (screened.refused > 0) {
    notes.push({
      level: 'warn',
      text:
        `${screened.refused} environment variable(s) in this test's spec change how an ` +
        'interpreter loads code, or which binary a command name resolves to, and were ' +
        `${controlEnforces(specEnvMode) ? 'NOT passed to the child process' : 'passed anyway because QAAI is in observe mode for them'}. ` +
        'Set these in the worker image, not in a test spec.',
      at: new Date().toISOString(),
    });
  }

  /*
   * THE OTHER HALF OF THE SAME SCREEN, and the one that was missing.
   *
   * `screened` above covers `spec.env`. A `Secret.name` is
   * `/^[A-Z][A-Z0-9_]*$/`, so `PATH` is a legal secret name too, and a secret
   * reaches the child through `childEnv({ secrets })` — which used to apply the
   * map LAST and unscreened, straight over the screened extras. `childEnv` now
   * withholds those names itself; this sink is how the test's author is told,
   * because a refusal nobody reports is half a defect.
   */
  const secretsWithheld: string[] = [];

  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    spawnError?: string;
    timedOut?: boolean;
  }>((done) => {
    const child = spawn(spec.command, spec.args, {
      cwd: workDir,
      // Allowlisted, not inherited: `spec.command` is an executable a MEMBER
      // named, so this child is tenant-controlled and must not see the
      // platform's keys. See child-env.ts.
      env: childEnv({
        extra: { ...screened.env, QAAI_BASE_URL: ctx.baseUrl, CI: '1' },
        secrets: exposed,
        withheld: secretsWithheld,
      }),
      // Never a shell: the spec is data, and interpolation here would be RCE.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString().slice(0, 200_000);
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString().slice(0, 200_000);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, spec.timeoutSeconds * 1000);

    const onAbort = () => child.kill('SIGTERM');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) =>
      done({ code: null, stdout, stderr, spawnError: (err as NodeJS.ErrnoException).code }),
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      done({ code, stdout, stderr, timedOut });
    });
  });

  if (secretsWithheld.length > 0) {
    /*
     * A COUNT AND NOT THE NAMES. The names are the tenant's own secret names
     * and they would be read back by whoever can see the run — which is the
     * same person who wrote them, so the risk is small, but a note on a test
     * result is the wrong place to start listing credential names. The remedy
     * does not need them: there is exactly one answer, and it is below.
     */
    notes.push({
      level: 'warn',
      text:
        `${secretsWithheld.length} secret(s) in this environment are named after a variable that ` +
        'changes how an interpreter loads code, or which binary a command name resolves to, and ' +
        'were NOT passed to the child process. Rename them; set interpreter variables in the ' +
        'worker image, never as a secret.',
      at: new Date().toISOString(),
    });
    // Operator-facing, inside the tenant's own run. The NAMES are safe here and
    // are what an operator needs to find the rows; no value is read.
    ctx.logger.warn('secrets named after an interpreter variable were withheld', {
      names: secretsWithheld,
    });
  }

  if (result.spawnError === 'ENOENT') {
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps: [],
      errorMessage: `\`${spec.command}\` is not installed on this worker, so the test was not evaluated.`,
    };
  }

  if (result.timedOut) {
    return {
      ...base,
      status: 'TIMED_OUT',
      durationMs: Date.now() - startedAt,
      steps: [],
      errorMessage: `\`${spec.command}\` exceeded ${spec.timeoutSeconds}s and was stopped.`,
    };
  }

  // Exit-code mode: no report to read, the process's own verdict is the result.
  if (spec.reportFormat === 'exit-code') {
    const ok = result.code === 0;
    return {
      ...base,
      status: ok ? 'PASSED' : 'FAILED',
      durationMs: Date.now() - startedAt,
      steps: [],
      errorMessage: ok
        ? null
        : (result.stderr || result.stdout).slice(-2000) || `exit ${result.code}`,
    };
  }

  let report = '';
  try {
    report = await readFile(safeReportPath(workDir, spec.reportPath), 'utf8');
  } catch {
    // A missing report with a clean exit means the tool ran but wrote nowhere we
    // looked — report that honestly rather than inventing a pass.
    return {
      ...base,
      status: result.code === 0 ? 'SKIPPED' : 'FAILED',
      durationMs: Date.now() - startedAt,
      steps: [],
      errorMessage:
        result.code === 0
          ? `No report found at ${spec.reportPath}. Point reportPath at the file your runner writes.`
          : (result.stderr || result.stdout).slice(-2000) || `exit ${result.code}`,
    };
  }

  // `auto` (and the legacy `json-summary` id) sniff the file; everything else
  // reads it as the format the spec declared, and says so when that fails.
  const declared = resolveReportFormat(spec.reportFormat);
  const format = declared ?? detectReportFormat(report);
  if (!format) {
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps: [],
      errorMessage: `The report at ${spec.reportPath} is not in a format QAAI recognises. Set reportFormat explicitly.`,
    };
  }

  const parsed = parseReport(format, report);
  const steps = toStepResults(parsed, new Date(startedAt));
  const summary = summariseReport(parsed, spec.reportPath);

  // A report we could not read, from a process that said it failed, is a
  // failure — the tool's own exit code is the evidence we still have. The
  // reverse never applies: a clean exit cannot upgrade an unreadable or empty
  // report into a pass, because there is nothing there to have passed.
  const status =
    summary.status === 'SKIPPED' && result.code !== 0 && parsed.presence !== 'ok'
      ? 'FAILED'
      : summary.status;

  /*
   * A suite that could not even LOAD is a configuration gap, not a failing test.
   *
   * The report is well-formed, so nothing above catches it — but every "failure"
   * in it is a collection error reading `ModuleNotFoundError: No module named
   * 'playwright'`, or `Cannot find module`, or `NoClassDefFoundError`. That is a
   * dependency that was not where the command looked, and recording it as FAILED
   * blames the customer's application for a configuration gap. This repo has now
   * fixed that same mistake three times — a missing Firefox binary, a missing
   * mutation tool, a missing CLI — and it came back through the one path that
   * does produce a readable report.
   *
   * WHOSE gap it is depends on WHICH TREE the command ran in, which is why the
   * remedy comes from {@link loadGapRemedy} rather than being written here: in
   * QAAI's own scratch tree it is the worker image, and in the customer's
   * materialised checkout it is the install QAAI deliberately does not perform.
   * One sentence for both was wrong for the second, and the second is the case
   * INTEGRATION and UNIT_GEN are always in.
   *
   * Deliberately narrow: it only downgrades when EVERY failure looks like a load
   * error. A suite where one test fails on a bad import and forty pass is still
   * a failing suite, and is left alone.
   */
  const loadGap = onlyLoadErrors(parsed);

  const hint =
    declared && parsed.presence === 'unreadable'
      ? ` The file looks like ${detectReportFormat(report) ?? 'no format QAAI knows'}, not ${format}.`
      : '';

  return {
    ...base,
    status: loadGap ? 'SKIPPED' : status,
    durationMs: Date.now() - startedAt,
    steps,
    errorMessage: loadGap
      ? loadGapRemedy(loadGap, options.workspaceKind)
      : summary.errorMessage
        ? `${summary.errorMessage}${hint}`.slice(0, 2000)
        : null,
  };
}
