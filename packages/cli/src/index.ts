#!/usr/bin/env node
/**
 * The `qaai` CLI (§6) — run a suite from any CI and get a real exit code.
 *
 * The design constraint that shapes everything: this is what makes a QA
 * platform CI-native rather than a dashboard. A green/red build has to hinge on
 * a nonzero exit, and the CI's own reporting has to work, so JUnit XML is a
 * first-class output. Everything else is convenience around those two facts.
 *
 * No dependencies beyond @qaai/shared and Node built-ins — a CLI that drags a
 * tree of packages into every customer's CI is a CLI nobody installs.
 */

import { writeFile } from 'node:fs/promises';
import { argv, env, exit, stderr, stdout } from 'node:process';

interface GlobalOptions {
  apiUrl: string;
  apiKey: string;
  json: boolean;
}

class CliError extends Error {}

function readGlobals(args: string[]): { opts: GlobalOptions; rest: string[] } {
  const rest: string[] = [];
  const opts: GlobalOptions = {
    apiUrl: env.QAAI_API_URL ?? 'http://localhost:4000',
    // A CI never sees a cookie, so the CLI authenticates with an API key — the
    // same keys the platform issues for exactly this (§1).
    apiKey: env.QAAI_API_KEY ?? '',
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--api-url') opts.apiUrl = args[++i] ?? opts.apiUrl;
    else if (arg === '--api-key') opts.apiKey = args[++i] ?? opts.apiKey;
    else if (arg === '--json') opts.json = true;
    else rest.push(arg);
  }
  return { opts, rest };
}

/** Flags after the subcommand: `--env staging --suite smoke --wait`. */
function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

async function apiCall<T>(
  opts: GlobalOptions,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!opts.apiKey) {
    throw new CliError('No API key. Set QAAI_API_KEY or pass --api-key. Create one in Settings.');
  }

  const response = await fetch(`${opts.apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new CliError(
      detail?.error?.message ?? `${init.method ?? 'GET'} ${path} failed with ${response.status}`,
    );
  }

  return (await response.json()) as T;
}

const TERMINAL = new Set(['PASSED', 'FAILED', 'CANCELLED', 'ERRORED']);

interface RunView {
  id: string;
  status: string;
  totalCount: number;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  skippedCount: number;
  gateResult: { passed: boolean; evaluations: Array<{ action: string; detail: string }> } | null;
}

// ─── qaai run ────────────────────────────────────────────────────────────────

async function cmdRun(opts: GlobalOptions, args: string[]): Promise<number> {
  const flags = parseFlags(args);

  const environmentId = flags.env as string | undefined;
  const projectId = flags.project as string | undefined;
  if (!environmentId) {
    throw new CliError(
      '--env <environmentId> is required. Copy it from the environment in the app.',
    );
  }

  /*
   * Wait by default; `--no-wait` to fire and forget.
   *
   * `flags.wait !== false` alone never saw `--no-wait`: parseFlags stores the
   * flag under the key it was written with, so `--no-wait` lands as
   * `flags['no-wait']` and `flags.wait` stays undefined. The documented flag
   * (docs/ci.md, and this file's own --help) has therefore been a no-op — every
   * `--no-wait` run polled to completion anyway. Noticed while adding
   * `--reporter`, which genuinely cannot run against an unfinished run.
   */
  const wait = flags['no-wait'] !== true && flags.wait !== false;
  const junitPath = flags.junit as string | undefined;

  /*
   * Reporters are resolved BEFORE the run is queued. A misspelled --reporter
   * should cost a second, not a ten-minute suite whose results then go nowhere.
   * The module is imported only when the flag is present, for the same reason
   * `backup` and `runner` are lazy: `qaai status` should not pay for it.
   */
  const reporting = args.includes('--reporter') ? await import('./report.js') : null;
  const reporterRequests = reporting ? reporting.parseReporterArgs(args) : [];
  const testRailRunId = reporting ? reporting.readTestRailRunId(flags, env) : undefined;
  if (reporterRequests.length > 0 && !wait) {
    throw new CliError(
      '--reporter needs a finished run to report on, so it cannot be combined with --no-wait.',
    );
  }

  const body: Record<string, unknown> = {
    environmentId,
    trigger: 'CI',
    ...(projectId ? { projectId } : {}),
    ...(flags.suite ? { suiteId: flags.suite } : {}),
    ...(flags.commit ? { commitSha: flags.commit } : {}),
  };

  const { run } = await apiCall<{ run: { id: string } }>(opts, '/runs', { method: 'POST', body });

  if (!opts.json) stderr.write(`Run ${run.id} queued.\n`);

  if (!wait) {
    if (opts.json) stdout.write(JSON.stringify({ runId: run.id, status: 'queued' }) + '\n');
    else stdout.write(`${run.id}\n`);
    return 0;
  }

  // Poll to a terminal state. A CLI that returns before the run finishes cannot
  // set a meaningful exit code, which defeats the entire purpose.
  const started = Date.now();
  const timeoutMs = Number(flags.timeout ?? 600) * 1000;
  let view: RunView | null = null;

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 4000));
    const result = await apiCall<{ run: RunView }>(opts, `/runs/${run.id}`);
    view = result.run;
    if (!opts.json && !TERMINAL.has(view.status)) {
      stderr.write(`  ${view.status}  ${view.passedCount} passed, ${view.failedCount} failed\r`);
    }
    if (TERMINAL.has(view.status)) break;
  }

  if (!view) throw new CliError('Timed out before the run started');

  if (junitPath) {
    const xml = await fetchJunit(opts, run.id);
    await writeFile(junitPath, xml, 'utf8');
    if (!opts.json) stderr.write(`\nJUnit XML written to ${junitPath}\n`);
  }

  /*
   * Reporting happens after the run is terminal and before the verdict is
   * printed, so a reporting failure can still change the exit code. The run's
   * full detail — every result, not just the counters `RunView` carries — is
   * fetched once, here, because that is the only shape the reporters can work
   * from.
   */
  let reports: import('./report.js').EmitResult = { outcomes: [], failures: [] };

  if (reporting && reporterRequests.length > 0) {
    const detail = await apiCall<{ run: import('./report.js').ApiRunPayload }>(
      opts,
      `/runs/${run.id}`,
    );
    // Only a URL the operator actually configured. Guessing a web address from
    // the API's would put a dead link in every Allure report.
    const appUrl = env.QAAI_APP_URL?.replace(/\/+$/, '');
    reports = await reporting.emitReports({
      report: reporting.runReportFromApi(
        detail.run,
        appUrl ? { url: `${appUrl}/runs/${run.id}` } : {},
      ),
      requests: reporterRequests,
      env,
      ...(testRailRunId === undefined ? {} : { testRailRunId }),
      fetchJunitXml: () => fetchJunit(opts, run.id),
    });

    if (!opts.json) {
      stderr.write('\n');
      for (const outcome of reports.outcomes) {
        stderr.write(`${outcome.reporter}: ${outcome.destination}\n`);
        // Warnings are what a reporter left out. Printing them is the whole
        // difference between a document that is short and one that lies.
        for (const warning of outcome.warnings) stderr.write(`  ! ${warning}\n`);
      }
      // Printed even when the tests passed, and the exit code below agrees.
      for (const failure of reports.failures) stderr.write(`reporting failed — ${failure}\n`);
    }
  }

  const gateBlocked = view.gateResult ? !view.gateResult.passed : false;
  // Exit nonzero on any failure OR a blocking gate — the build must go red.
  const failed =
    view.failedCount > 0 || view.status === 'FAILED' || view.status === 'ERRORED' || gateBlocked;

  if (opts.json) {
    stdout.write(
      JSON.stringify({
        ...view,
        ci: { failed, reportingFailed: reports.failures.length > 0 },
        ...(reporterRequests.length > 0 ? { reports } : {}),
      }) + '\n',
    );
  } else {
    stderr.write('\n');
    stdout.write(
      `${failed ? '✗' : '✓'} ${view.status}  ` +
        `${view.passedCount} passed · ${view.failedCount} failed · ` +
        `${view.flakyCount} flaky · ${view.skippedCount} skipped\n`,
    );
    for (const evaluation of view.gateResult?.evaluations ?? []) {
      if (evaluation.action === 'BLOCK') stdout.write(`  gate BLOCK — ${evaluation.detail}\n`);
    }
  }

  if (failed) return 1;
  // A run that passed and whose results never reached the dashboard is not a
  // green step. 2 rather than 1 so a pipeline can tell "the tests failed" from
  // "the tests passed and the report did not ship".
  return reports.failures.length > 0 ? 2 : 0;
}

// ─── qaai deploy-check ───────────────────────────────────────────────────────

/**
 * Post-deploy smoke (§6). Identical to `run` but pins the trigger and the suite
 * to the smoke set, so a deploy pipeline reads as intent rather than a pile of
 * flags. A nonzero exit is what a rollback step keys off.
 */
async function cmdDeployCheck(opts: GlobalOptions, args: string[]): Promise<number> {
  const flags = parseFlags(args);
  /*
   * The reporter flags are forwarded from raw argv rather than through
   * `flags`, because they are repeatable and order-sensitive — a
   * `--reporter-out` belongs to the `--reporter` before it — and `parseFlags`
   * keeps only the last value of a repeated flag.
   */
  const reporterArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== '--reporter' && arg !== '--reporter-out' && arg !== '--testrail-run') continue;
    reporterArgs.push(arg);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      reporterArgs.push(next);
      i++;
    }
  }

  return cmdRun(opts, [
    ...reporterArgs,
    ...(flags.env ? ['--env', String(flags.env)] : []),
    ...(flags.junit ? ['--junit', String(flags.junit)] : []),
    ...(flags.commit ? ['--commit', String(flags.commit)] : []),
    '--suite',
    String(flags.suite ?? 'smoke'),
    '--wait',
  ]);
}

// ─── qaai status ─────────────────────────────────────────────────────────────

async function cmdStatus(opts: GlobalOptions, args: string[]): Promise<number> {
  const runId = args.find((a) => !a.startsWith('--'));
  if (!runId) throw new CliError('Usage: qaai status <runId>');

  const { run } = await apiCall<{ run: RunView }>(opts, `/runs/${runId}`);
  if (opts.json) {
    stdout.write(JSON.stringify(run) + '\n');
  } else {
    stdout.write(
      `${run.status}  ${run.passedCount} passed · ${run.failedCount} failed · ${run.flakyCount} flaky\n`,
    );
  }
  return run.failedCount > 0 ? 1 : 0;
}

async function fetchJunit(opts: GlobalOptions, runId: string): Promise<string> {
  const response = await fetch(`${opts.apiUrl}/runs/${runId}/junit.xml`, {
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  if (!response.ok) throw new CliError(`Could not fetch JUnit XML (${response.status})`);
  return response.text();
}

// ─── Help ────────────────────────────────────────────────────────────────────

const HELP = `qaai — run QAAI test suites from any CI

Usage:
  qaai run --env <id> [options]         Run a suite and wait for the verdict
  qaai deploy-check --env <id> [opts]   Post-deploy smoke run (exit 1 on failure)
  qaai status <runId>                   Print the status of a run
  qaai backup <create|verify|restore>   Back up or restore the database
  qaai runner [--api-url <url>]         Run tests inside your own network

Run options:
  --env <id>          Environment to run against (required)
  --suite <id>        Run only this suite (default: the whole project)
  --commit <sha>      Attach a commit to the run
  --junit <path>      Write JUnit XML to this path for the CI to report
  --no-wait           Queue the run and return its id without waiting
  --timeout <sec>     Give up waiting after this many seconds (default 600)

Reporters (repeatable, and composable with --junit):
  --reporter <name>   junit | allure | testrail
  --reporter-out <p>  Where the --reporter before it writes. Defaults:
                      junit -> junit.xml, allure -> allure-results/ (a
                      directory), testrail -> uploaded, no file written
  --testrail-run <id> The TestRail run to add results to

    qaai run --env <id> --reporter allure --reporter-out ./allure-results \\
                        --reporter testrail --testrail-run 4821

  TestRail keys results on case ids, so put the id in the test name as C1234;
  tests without one are named in a warning rather than uploaded to a guess.

Global:
  --api-url <url>     Default: $QAAI_API_URL or http://localhost:4000
  --api-key <key>     Default: $QAAI_API_KEY
  --json              Machine-readable output

Environment:
  QAAI_API_KEY        API key for the run (or --api-key)
  QAAI_APP_URL        Your QAAI web address, used to link Allure results back
                      to the run. Omitted rather than guessed.
  TESTRAIL_HOST       https://acme.testrail.io
  TESTRAIL_USER       The TestRail account email
  TESTRAIL_API_KEY    From TestRail: My Settings -> API Keys
  TESTRAIL_RUN_ID     Alternative to --testrail-run

TestRail credentials are read from the environment and there is deliberately no
flag for them: anything in argv shows up in the CI log, in \`ps\` on a shared
build host, and in the shell history of whoever ran it once by hand.

Exit code is nonzero when any test failed or a quality gate blocked, so your
build goes red without any extra scripting. Exit 2 means the run itself passed
but a reporter could not publish — a step that never delivered its results is
not a green step.`;

/*
 * `backup` and `runner` live in their own modules because each is substantial,
 * and each self-invokes when run directly. That left them reachable only as
 * `tsx packages/cli/src/backup.ts` — the CLI's own dispatcher had never heard of
 * them, so `qaai backup` was an unknown command and the on-prem runner agent, a
 * thing a customer is meant to install, had no name.
 *
 * Imported lazily: both pull in heavy dependencies, and `qaai status` should not
 * pay for a Postgres client it will never use.
 */
async function main(): Promise<number> {
  const { opts, rest } = readGlobals(argv.slice(2));
  const command = rest.shift();

  switch (command) {
    case 'run':
      return cmdRun(opts, rest);
    case 'deploy-check':
      return cmdDeployCheck(opts, rest);
    case 'status':
      return cmdStatus(opts, rest);
    case 'backup':
    case 'restore': {
      const { backupMain } = await import('./backup.js');
      // The subcommand is part of backup's own argv grammar (`backup create`,
      // `backup restore`), so it is put back rather than swallowed here.
      return backupMain(command === 'restore' ? ['restore', ...rest] : rest);
    }
    case 'runner': {
      const { runnerMain } = await import('./runner.js');
      return runnerMain(rest);
    }
    case 'help':
    case '--help':
    case undefined:
      stdout.write(HELP + '\n');
      return 0;
    default:
      stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
      return 2;
  }
}

main()
  .then((code) => exit(code))
  .catch((err) => {
    // A ReportError from ./report.js is already a printable sentence, exactly
    // like a CliError. It is matched by name rather than by class so this file
    // does not have to import the reporting module eagerly to catch it.
    const printable =
      err instanceof CliError || (err instanceof Error && err.name === 'ReportError');
    stderr.write(`${printable ? err.message : `Unexpected error: ${err}`}\n`);
    exit(2);
  });
