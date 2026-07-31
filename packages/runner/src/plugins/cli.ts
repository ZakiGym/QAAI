/**
 * CLI testing (§4 CLI).
 *
 * An enormous amount of software is a command-line tool, and almost none of it
 * is covered by a browser test. This runs one command with args and stdin and
 * asserts on what came back: exit code, stdout, stderr, duration.
 *
 * Two decisions carry most of the value:
 *
 *  - Output is NORMALISED before comparison — CRLF to LF, trailing whitespace
 *    per line stripped, trailing blank lines dropped. Line endings and one extra
 *    newline are the overwhelming majority of false CLI failures, and a test
 *    that fails for that reason teaches people to ignore the suite.
 *  - A missing binary is SKIPPED with an install hint, never FAILED. The tool
 *    not being on the worker is a configuration gap; calling it a failure blames
 *    the software under test for something QAAI did not install.
 *
 * Security: the command is spawned WITHOUT a shell and args are passed as an
 * array. A spec is org-authored data; `shell: true` here would turn a test spec
 * into remote code execution via string interpolation.
 */

import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { cliTestSpecSchema, createMasker } from '@qaai/shared';
import type {
  CliTestSpec,
  ExecutableTest,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';

/** Per-stream capture cap. Matches the external plugin. */
const OUTPUT_LIMIT = 200_000;

/**
 * Make two pieces of terminal output comparable without hiding real differences.
 *
 * CRLF becomes LF (a Windows runner and a Linux runner must agree), each line
 * loses its trailing spaces and tabs (invisible in a terminal, invisible in a
 * diff, fatal to an equality check), and trailing blank lines go (whether a tool
 * ends with a newline is a style choice, not behaviour). Interior blank lines
 * and leading whitespace are preserved — those are content.
 */
export function normalizeOutput(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** Guard: a spec-supplied working directory must stay inside the workspace. */
function safeCwd(workspace: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new Error('cwd must be relative to the workspace');
  const full = resolve(join(workspace, relPath));
  const root = resolve(workspace);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('cwd escapes the workspace');
  }
  return full;
}

/** Trimmed one-line rendering of the command, for step titles. */
function describeCommand(spec: CliTestSpec): string {
  const line = [spec.command, ...spec.args].join(' ');
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** A short, quoted excerpt of a stream, for the "actual" side of a failure. */
function excerpt(text: string, limit = 400): string {
  if (text === '') return '(empty)';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  spawnError: string | null;
  timedOut: boolean;
}

async function runCommand(
  ctx: RunContext,
  spec: CliTestSpec,
  cwd: string,
  env: Record<string, string>,
): Promise<CommandResult> {
  const startedAt = Date.now();

  return new Promise<CommandResult>((done) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      env,
      // Never a shell: the spec is data, and interpolation here would be RCE.
      shell: false,
      stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += b.toString();
    });

    if (spec.stdin !== undefined && child.stdin) {
      // A tool that exits before reading stdin (`head -1`) gives us EPIPE. That
      // is the tool behaving normally, not a test error.
      child.stdin.on('error', () => undefined);
      child.stdin.end(spec.stdin);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // SIGTERM is a request. Something ignoring it must not hold the run open.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, spec.timeoutSeconds * 1000);

    const onAbort = () => child.kill('SIGTERM');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const settle = (result: Omit<CommandResult, 'durationMs' | 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      done({
        ...result,
        stdout: stdout.slice(0, OUTPUT_LIMIT),
        stderr: stderr.slice(0, OUTPUT_LIMIT),
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (err) =>
      settle({
        code: null,
        signal: null,
        spawnError: (err as NodeJS.ErrnoException).code ?? err.message,
        timedOut,
      }),
    );
    child.on('close', (code, signal) => settle({ code, signal, spawnError: null, timedOut }));
  });
}

export const cliPlugin: RunnerPlugin = {
  type: 'CLI',

  validate(test: ExecutableTest): void {
    const parsed = cliTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`CLI test "${test.name}" has an invalid spec — ${issues}`);
    }
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = cliTestSpecSchema.parse(test.spec);
    const startedAt = Date.now();
    const mask = createMasker(Object.values(ctx.secrets));

    const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
      testId: test.id,
      durationMs: 0,
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      retriedAndPassed: false,
      findings: [],
    };

    const finish = (
      status: TestExecution['status'],
      steps: StepResult[],
      errorMessage: string | null,
    ): TestExecution => ({
      ...base,
      status,
      durationMs: Date.now() - startedAt,
      steps,
      errorMessage: errorMessage === null ? null : mask(errorMessage),
    });

    let cwd: string;
    try {
      cwd = safeCwd(process.cwd(), spec.cwd);
    } catch (err) {
      return finish('FAILED', [], err instanceof Error ? err.message : String(err));
    }

    // Only the secrets the spec names, so a test cannot vacuum the whole vault
    // into a third-party process's environment.
    const exposed: Record<string, string> = {};
    for (const name of spec.secretNames) {
      const value = ctx.secrets[name];
      if (value !== undefined) exposed[name] = value;
    }
    const missingSecrets = spec.secretNames.filter((n) => ctx.secrets[n] === undefined);
    if (missingSecrets.length > 0) {
      // A secret the command needs but the environment does not have is a
      // configuration gap, same class as a missing binary.
      return finish(
        'SKIPPED',
        [],
        `The secret${missingSecrets.length > 1 ? 's' : ''} ${missingSecrets.join(', ')} ${missingSecrets.length > 1 ? 'are' : 'is'} not set on this environment, so the command was not run.`,
      );
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...spec.env,
      ...exposed,
      QAAI_BASE_URL: ctx.baseUrl,
      CI: '1',
    };

    if (ctx.signal.aborted) {
      return finish('SKIPPED', [], 'The run was cancelled before the command started.');
    }

    const result = await runCommand(ctx, spec, cwd, env);
    const commandLine = mask(describeCommand(spec));

    if (result.spawnError === 'ENOENT') {
      // The binary is not on this worker. This is the bug that has been fixed
      // twice in this repo: never FAILED.
      const hint = spec.installHint
        ? ` Install it with: ${spec.installHint}`
        : ` Install it on the worker (or add it to the worker image) and re-run.`;
      return finish(
        'SKIPPED',
        [],
        `\`${spec.command}\` is not installed on this worker, so the test was not evaluated.${hint}`,
      );
    }

    if (result.spawnError === 'EACCES') {
      return finish(
        'SKIPPED',
        [],
        `\`${spec.command}\` is present but not executable on this worker (EACCES), so the test was not evaluated.`,
      );
    }

    if (result.spawnError !== null) {
      return finish('FAILED', [], `Could not run \`${commandLine}\`: ${result.spawnError}`);
    }

    if (result.timedOut) {
      return finish(
        'TIMED_OUT',
        [],
        `\`${commandLine}\` exceeded ${spec.timeoutSeconds}s and was stopped. Last stderr: ${mask(excerpt(normalizeOutput(result.stderr), 500))}`,
      );
    }

    // ─── Assertions, one cockpit step each ───────────────────────────────────

    const steps: StepResult[] = [];
    const push = (
      title: string,
      ok: boolean,
      message: string,
      expected: string | null = null,
      actual: string | null = null,
      durationMs = 0,
    ): void => {
      const index = steps.length;
      const status: StepResult['status'] = ok ? 'PASSED' : 'FAILED';
      steps.push({
        index,
        title,
        status,
        startedAt: new Date().toISOString(),
        durationMs,
        screenshotKey: null,
        error: ok
          ? null
          : {
              message: mask(message),
              stack: null,
              selector: null,
              expected: expected === null ? null : mask(expected),
              actual: actual === null ? null : mask(actual),
            },
      });
      ctx.logger.step({ testId: test.id, index, title, status });
    };

    const expectations = spec.expect;
    const normalize = (text: string): string =>
      expectations.normalizeWhitespace ? normalizeOutput(text) : text;

    const stdout = normalize(result.stdout);
    const stderr = normalize(result.stderr);
    const exited =
      result.signal !== null ? `terminated by ${result.signal}` : `exit code ${result.code}`;

    if (expectations.exitCode === null) {
      push(`Ran \`${commandLine}\` (${exited})`, true, '', null, null, result.durationMs);
    } else {
      const ok = result.signal === null && result.code === expectations.exitCode;
      push(
        `Ran \`${commandLine}\` — expected exit ${expectations.exitCode}`,
        ok,
        ok
          ? ''
          : `The command ${exited}. stderr: ${excerpt(stderr, 600)}`,
        `exit code ${expectations.exitCode}`,
        exited,
        result.durationMs,
      );
    }

    for (const [stream, text] of [
      ['stdout', stdout],
      ['stderr', stderr],
    ] as const) {
      const want = expectations[stream];
      if (!want) continue;

      if (want.empty !== undefined) {
        const isEmpty = text === '';
        push(
          `${stream} is ${want.empty ? 'empty' : 'not empty'}`,
          isEmpty === want.empty,
          want.empty
            ? `${stream} was not empty: ${excerpt(text)}`
            : `${stream} was empty, expected output`,
          want.empty ? '(empty)' : '(some output)',
          excerpt(text),
        );
      }

      if (want.equals !== undefined) {
        const expected = normalize(want.equals);
        push(
          `${stream} equals the expected output`,
          text === expected,
          `${stream} did not match the expected output`,
          excerpt(expected),
          excerpt(text),
        );
      }

      for (const needle of want.contains) {
        const wanted = normalize(needle);
        push(
          `${stream} contains ${JSON.stringify(needle)}`,
          text.includes(wanted),
          `${stream} does not contain ${JSON.stringify(needle)}`,
          needle,
          excerpt(text),
        );
      }

      for (const needle of want.notContains) {
        const unwanted = normalize(needle);
        push(
          `${stream} does not contain ${JSON.stringify(needle)}`,
          !text.includes(unwanted),
          `${stream} contains ${JSON.stringify(needle)}, which it should not`,
          `no ${JSON.stringify(needle)}`,
          excerpt(text),
        );
      }

      if (want.matches !== undefined) {
        // The source compiled at validation time, so this cannot throw here.
        const re = new RegExp(want.matches, want.matchFlags);
        push(
          `${stream} matches /${want.matches}/${want.matchFlags}`,
          re.test(text),
          `${stream} does not match /${want.matches}/${want.matchFlags}`,
          `/${want.matches}/${want.matchFlags}`,
          excerpt(text),
        );
      }
    }

    if (expectations.maxDurationMs !== undefined) {
      push(
        `Finished within ${expectations.maxDurationMs}ms`,
        result.durationMs <= expectations.maxDurationMs,
        `Took ${result.durationMs}ms, budget is ${expectations.maxDurationMs}ms`,
        `≤ ${expectations.maxDurationMs}ms`,
        `${result.durationMs}ms`,
      );
    }

    const failed = steps.filter((s) => s.status === 'FAILED');
    return finish(
      failed.length > 0 ? 'FAILED' : 'PASSED',
      steps,
      failed.length > 0
        ? `${failed.length} of ${steps.length} checks failed. First: ${failed[0]?.error?.message ?? ''}`
        : null,
    );
  },
};
