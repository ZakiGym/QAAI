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
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { externalTestSpecSchema } from '@qaai/shared';
import type {
  ExecutableTest,
  ExternalTestSpec,
  RunContext,
  RunnerPlugin,
  TestExecution,
} from '@qaai/shared';
import {
  detectReportFormat,
  parseReport,
  resolveReportFormat,
  summariseReport,
  toStepResults,
} from '../reports/index.js';

/** Guard: a spec-supplied report path must stay inside the workspace. */
export function safeReportPath(workspace: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new Error('reportPath must be relative to the workspace');
  const full = resolve(join(workspace, relPath));
  if (full !== resolve(workspace) && !full.startsWith(resolve(workspace) + sep)) {
    throw new Error('reportPath escapes the workspace');
  }
  return full;
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

  execute: (ctx, test) => runExternal(ctx, test, externalTestSpecSchema.parse(test.spec)),
};

/** Shared by the external plugin and any type that wants to shell out. */
export async function runExternal(
  ctx: RunContext,
  test: ExecutableTest,
  spec: ExternalTestSpec,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const workspace = process.cwd();

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
      cwd: join(workspace, spec.cwd),
      env: {
        ...process.env,
        ...spec.env,
        ...exposed,
        QAAI_BASE_URL: ctx.baseUrl,
        CI: '1',
      },
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
    report = await readFile(safeReportPath(join(workspace, spec.cwd), spec.reportPath), 'utf8');
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

  const hint =
    declared && parsed.presence === 'unreadable'
      ? ` The file looks like ${detectReportFormat(report) ?? 'no format QAAI knows'}, not ${format}.`
      : '';

  return {
    ...base,
    status,
    durationMs: Date.now() - startedAt,
    steps,
    errorMessage: summary.errorMessage ? `${summary.errorMessage}${hint}`.slice(0, 2000) : null,
  };
}
