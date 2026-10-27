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
import { externalTestSpecSchema } from '@qaai/shared';
import type {
  ConsoleEntry,
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
import { childEnv } from '../child-env.js';
import { resolveInsideWorkspace, runWorkspaceOf } from '../run-workspace.js';

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
      });
    }

    return runExternal(ctx, test, spec, {
      workspace: workspace.root,
      workspaceKind: 'MATERIALISED_REPOSITORY',
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
}

export async function runExternal(
  ctx: RunContext,
  test: ExecutableTest,
  spec: ExternalTestSpec,
  options: RunExternalOptions,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const workspace = options.workspace;

  const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
    testId: test.id,
    durationMs: 0,
    network: [],
    console: options.extraConsole ?? [],
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

  // Only the secrets the spec asks for, so a test cannot vacuum the whole vault
  // into a third-party process's environment.
  const exposed: Record<string, string> = {};
  for (const name of spec.secretNames) {
    const value = ctx.secrets[name];
    if (value !== undefined) exposed[name] = value;
  }

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
        extra: { ...spec.env, QAAI_BASE_URL: ctx.baseUrl, CI: '1' },
        secrets: exposed,
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
