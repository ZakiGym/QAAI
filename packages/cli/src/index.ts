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

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { argv, env, exit, stderr, stdout } from 'node:process';
/*
 * The exit code is NOT computed in this file any more. `./verdict.js` reads the
 * server's answer, and the header of that module explains why five places each
 * deciding red/green for themselves is what let quarantine suppress a signal
 * without stopping the gate.
 */
import { summaryLine, verdictOf } from './verdict.js';
/*
 * The run request's grammar, its refusals and the selection honesty rules live
 * in `./run-request.js` because THIS file is the published `bin` and
 * self-invokes on import, so nothing can import it to test it. That module's
 * header says why the `invokedDirectly` guard `runner.ts` uses is not available
 * to the bin.
 */
import {
  EXTRA_FLAGS,
  NOT_FULL_SUITE_NOTE,
  RUN_EXIT,
  REQUEST_FLAG_SPECS,
  TRANSPORT_FLAGS,
  changedPathsFromGit,
  checkApiUrl,
  echoRefusals,
  fallbackLine,
  parseRunCommand,
  redirectRefusal,
  refusalLines,
  rerunLines,
  runExitCode,
  scopedGateReport,
  selectionOutcome,
  shardDisclosure,
  suppressionLines,
} from './run-request.js';
import type {
  GitSurface,
  ImpactAnalysisView,
  RerunView,
  RunRequestBody,
  SelectionOutcome,
} from './run-request.js';

interface GlobalOptions {
  apiUrl: string;
  apiKey: string;
  json: boolean;
}

class CliError extends Error {}

/**
 * Git, bound to the real thing.
 *
 * The only `child_process` call in the CLI's run path, and it is an adapter
 * rather than logic: every decision made from its output is in
 * `./run-request.js` against a fake, because 629 lines of crawler.ts had almost
 * no tests for exactly this reason.
 *
 * `execFile` and not a shell. A ref reaches this from `--impact-base`, and a
 * shell would make `main; rm -rf .` a command rather than an unknown ref.
 */
const realGit: GitSurface = {
  run: (args) =>
    new Promise((resolve) => {
      execFile('git', [...args], { encoding: 'utf8', timeout: 30_000 }, (error, stdout_) => {
        if (error) resolve({ ok: false });
        else resolve({ ok: true, stdout: stdout_ });
      });
    }),
};

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

  /*
   * The URL the key is about to be sent to, checked before it is sent. A
   * `--api-url` carrying userinfo would put the credential in a URL, which is
   * the one place a token is guaranteed to be logged — by the proxy, by the
   * runner, and by `set -x`. The refusal names the FLAG and never the value.
   */
  const checked = checkApiUrl(opts.apiUrl);
  if (!checked.ok) {
    throw new CliError(
      checked.code === 'CREDENTIAL_IN_URL'
        ? '--api-url must not carry a username or password. A URL with credentials in it ends up in the CI log.'
        : '--api-url must be an http:// or https:// URL.',
    );
  }

  const response = await fetch(`${opts.apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    /*
     * Node's fetch follows redirects by default and the Authorization header
     * rides along, so a 302 from a customer-named host to anywhere else is this
     * customer's API key handed to a third party. Refused instead, and the
     * Location is NOT printed — an attacker who could set it would otherwise
     * get a string of their choosing into the CI log.
     */
    redirect: 'manual',
  });

  const redirect = redirectRefusal(response.status);
  if (redirect) throw new CliError(redirect);

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
  /** Failures a quarantine suppressed. Absent on a server older than the field. */
  quarantinedFailedCount?: number;
  /** What the server GRANTED, which is not always what `--shards` asked for. */
  shardCount?: number;
  /**
   * Read back so the CLI can refuse to report a target it was not given. See
   * `echoRefusals` — neither field has a writer on any create path today.
   */
  baseUrlOverride?: string | null;
  branch?: string | null;
  /** The cross-kind suppression ledger. Absent on a server that has none yet. */
  suppressions?: {
    failuresSuppressed: number;
    knownIssues: number;
    quarantines: number;
    waivers: number;
    expiredAndSilencedNothing: number;
  } | null;
  gateResult: {
    passed: boolean;
    /*
     * `rule.kind` is carried, not just the action and the detail: it is what
     * lets a SELECTED run tell a rule scored over its own results from one
     * scored over the project, and therefore which gate passes it is not
     * entitled to claim. See `GATE_RULE_SCOPE`.
     */
    evaluations: Array<{ rule?: { kind?: string } | null; action: string; detail: string }>;
  } | null;
  /**
   * The server's verdict — the single source of truth for "did this run pass".
   * Optional because a customer's CI will point an updated CLI at an older
   * QAAI; `verdictOf` degrades for exactly that case and says so.
   */
  verdict?: {
    passed: boolean;
    status?: string;
    suppressedFailures?: number;
    reason?: string;
  } | null;
}

// ─── qaai run ────────────────────────────────────────────────────────────────

async function cmdRun(opts: GlobalOptions, args: string[]): Promise<number> {
  const flags = parseFlags(args);

  /*
   * The whole grammar, validated before anything is queued — and STRICTLY: a
   * misspelled flag is a refusal rather than a silently ignored one, which is
   * what `--no-wait` was for the life of that feature. `parseFlags` stored it
   * under the key it was written with, so `flags.wait !== false` never saw it,
   * every `--no-wait` run polled to completion anyway, and the documentation
   * had been wrong since it was written.
   *
   * A refusal reports a PATH and a CODE and never the offending value: a CLI
   * that echoes argv into a CI log, a PR comment or a model's context is the
   * same leak that put `Unrecognized key: "IGNORE THE PLAN ABOVE…"` into a flag
   * message.
   */
  const parsed = parseRunCommand(args);
  if (!parsed.ok) {
    throw new CliError(
      `Cannot run:\n${refusalLines(parsed.refusals)
        .map((line) => `  ${line}`)
        .join('\n')}\n\nSee \`qaai help\` for what each flag does to the run.`,
    );
  }
  const command = parsed.command;
  const body: RunRequestBody = { ...command.request };
  const wait = command.wait;
  const junitPath = command.junit ?? undefined;

  /*
   * Reporters are resolved BEFORE the run is queued. A misspelled --reporter
   * should cost a second, not a ten-minute suite whose results then go nowhere.
   * The module is imported only when the flag is present, for the same reason
   * `backup` and `runner` are lazy: `qaai status` should not pay for it.
   */
  const reporting = args.includes('--reporter') ? await import('./report.js') : null;
  const reporterRequests = reporting ? reporting.parseReporterArgs(args) : [];
  const testRailRunId = reporting ? reporting.readTestRailRunId(flags, env) : undefined;

  /*
   * How this run's test set was decided, and therefore what its verdict is
   * allowed to claim. Resolved before the run is queued because an impact
   * fallback has to be printed whether or not the run later passes.
   */
  let selection: SelectionOutcome = selectionOutcome({
    how: command.explicitTestIds
      ? 'explicit-test-ids'
      : (body.changedPaths?.length ?? 0) > 0
        ? 'changed-paths'
        : 'none',
  });
  const notices: string[] = [];

  if (command.impact) {
    const diff = await changedPathsFromGit(realGit, command.impact.base);
    if (!diff.ok) {
      /*
       * THE RULE THAT MAKES THIS SAFE TO SHIP: where impact cannot be computed,
       * the answer is the FULL SUITE and a loud reason. Never a silent subset —
       * a green build that tested almost nothing is worse than a red one. The
       * commonest case by far is a shallow clone, which is `actions/checkout`'s
       * DEFAULT, so this line will be read often and has to say what to change.
       */
      notices.push(fallbackLine(diff));
      if (command.impact.analyseOnly) {
        // To stderr under --json too: the whole answer of an `--impact-only`
        // that could not compute a diff IS the reason, and a reason nobody is
        // shown is how a team comes to trust a selection that never happened.
        stderr.write(`${notices.join('\n')}\n`);
        if (opts.json) {
          stdout.write(
            JSON.stringify({ impact: null, fallback: diff.fallback, notices }) + '\n',
          );
        }
        return RUN_EXIT.OK;
      }
    } else {
      const analysis = await apiCall<ImpactAnalysisView>(opts, '/impact/analyze', {
        method: 'POST',
        body: { projectId: body.projectId, changedPaths: diff.paths },
      });

      if (command.impact.analyseOnly) {
        if (opts.json) stdout.write(JSON.stringify({ impact: analysis }) + '\n');
        else {
          stdout.write(
            `${analysis.strategy} (${analysis.confidence}) — ${analysis.reason}\n` +
              `${analysis.totals.run} of ${analysis.totals.tests} tests would run; ` +
              `${analysis.totals.skip} would be skipped.\n` +
              `${analysis.testIds.join('\n')}\n`,
          );
        }
        return RUN_EXIT.OK;
      }

      if (analysis.strategy === 'SELECTIVE') {
        body.testIds = analysis.testIds;
        body.changedPaths = diff.paths;
        selection = selectionOutcome({
          how: 'impact',
          selected: analysis.totals.run,
          skipped: analysis.totals.skip,
        });
        notices.push(
          `impact: ${analysis.strategy} (${analysis.confidence}) from ${diff.paths.length} ` +
            `changed path(s) against ${diff.base} — ${analysis.reason}`,
        );
      } else {
        /*
         * RUN_EVERYTHING and SMOKE_FLOOR are not selections this CLI pins. The
         * analysis's `testIds` are the whole candidate set at the moment it
         * answered, and freezing that list would quietly exclude a test added
         * between the two calls. Sending no selection lets the server build the
         * set, which is the safe answer and the one impact.ts argues for.
         */
        notices.push(
          `impact: ${analysis.strategy} (${analysis.confidence}) — ${analysis.reason}. ` +
            'Nothing was selected out; the full suite ran.',
        );
      }
    }
  }

  /*
   * `--rerun-failures-of` drives POST /runs/:runId/rerun-failures rather than
   * POST /runs. Everything needed was already on the server and nothing joined
   * the two, so the only way to re-check six failures was to spend another
   * 5,000 browser-minutes.
   */
  let rerun: RerunView | null = null;
  let runId: string;
  if (command.rerunFailuresOf !== null) {
    rerun = await apiCall<RerunView>(opts, `/runs/${command.rerunFailuresOf}/rerun-failures`, {
      method: 'POST',
      body: {
        includeFlaky: command.includeFlaky,
        ...(body.failFast === true ? { failFast: true } : {}),
      },
    });
    runId = rerun.run.id;
    selection = selectionOutcome({
      how: 'rerun-failures',
      selected: rerun.reran,
      skipped: Math.max(0, rerun.ofTotal - rerun.reran),
    });
    notices.push(...rerunLines(rerun));
  } else {
    const created = await apiCall<{ run: { id: string } }>(opts, '/runs', {
      method: 'POST',
      body,
    });
    runId = created.run.id;
  }
  const run = { id: runId };

  /*
   * The notices go to STDERR even under --json, and are carried in the payload
   * as well.
   *
   * Both, and not either: stdout under --json is the machine's, so a notice
   * written there would corrupt it — but a `--json` run whose impact fallback
   * went nowhere would be a CI step that silently ran the whole suite (or a
   * selected sliver of it) with the reason printed to no one. The build log is
   * stderr, and that is where a human reads why.
   */
  if (!opts.json) stderr.write(`Run ${run.id} queued.\n`);
  for (const notice of notices) stderr.write(`${notice}\n`);

  if (!wait) {
    if (opts.json) {
      stdout.write(JSON.stringify({ runId: run.id, status: 'queued', ci: { notices } }) + '\n');
    } else stdout.write(`${run.id}\n`);
    return RUN_EXIT.OK;
  }

  // Poll to a terminal state. A CLI that returns before the run finishes cannot
  // set a meaningful exit code, which defeats the entire purpose.
  const started = Date.now();
  const timeoutMs = command.timeoutSeconds * 1000;
  let view: RunView | null = null;

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 4000));
    const result = await apiCall<{ run: RunView }>(opts, `/runs/${run.id}`);
    view = result.run;
    if (!opts.json && !TERMINAL.has(view.status)) {
      // The suppressed count rides along live. A progress line that says "0
      // failed" while three quarantined tests are failing is the small version
      // of the lie this whole change removes.
      const quarantined = view.quarantinedFailedCount ?? 0;
      stderr.write(
        `  ${view.status}  ${view.passedCount} passed, ${view.failedCount} failed` +
          `${quarantined > 0 ? `, ${quarantined} quarantined and failing` : ''}\r`,
      );
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

  /*
   * One call, and no expression of this file's own. See ./verdict.ts for what
   * the five competing expressions cost.
   */
  const verdict = verdictOf(view);
  const failed = !verdict.passed;

  /*
   * The caps the server applied, and the fields it dropped. Both are "a thing
   * reported as done that was not done" if they go unsaid: a team that asked
   * for 8 shards and silently got 1 is paying for a parallelism it does not
   * have, and a `--base-url` the server never recorded means the run executed
   * against a DIFFERENT application from the one this log names.
   */
  const dropped = echoRefusals(body, view);
  const shardNote = shardDisclosure(body.shards, view.shardCount);
  const disclosures = [...(shardNote === null ? [] : [shardNote]), ...dropped];

  /*
   * Which gate passes a SELECTED run is not entitled to claim for the suite.
   * Only a PASS is withheld: a BLOCK on a subset is still a BLOCK, and an
   * UNMEASURED evaluation already says it has no answer.
   */
  const scoped = scopedGateReport(view.gateResult?.evaluations ?? [], selection.scope);
  const code = runExitCode({
    verdictPassed: verdict.passed,
    unhonouredRequest: dropped.length > 0,
    scope: selection.scope,
    requireFullSuite: command.requireFullSuite,
    reportingFailures: reports.failures.length,
  });

  if (opts.json) {
    stdout.write(
      JSON.stringify({
        ...view,
        ci: {
          failed,
          exitCode: code,
          reportingFailed: reports.failures.length > 0,
          // Carried so a pipeline can gate on suppression itself — "fail my
          // build if anything is quarantined and failing" is a policy a team
          // should be able to write, and it needs the number.
          suppressedFailures: verdict.suppressedFailures,
          verdictSource: verdict.source,
          reason: verdict.reason,
          /*
           * `selected`/`skipped` are NULL rather than 0 when the server decided
           * the set and did not say how many it held back. A null that became 0
           * would read as "nothing was skipped", which is the opposite of the
           * truth on exactly the runs this field exists for.
           */
          scope: selection.scope,
          selection,
          gateNotFullSuite: scoped.withheld,
          disclosures,
          /** Everything the build log was told, so a reader of the JSON sees it too. */
          notices,
        },
        ...(reporterRequests.length > 0 ? { reports } : {}),
        ...(rerun ? { rerunOf: rerun.ofRun, reran: rerun.reran } : {}),
      }) + '\n',
    );
  } else {
    stderr.write('\n');
    stdout.write(`${summaryLine(view, verdict)}\n`);
    /*
     * Printed on a GREEN run too, which is the point. A run that passed because
     * its failures were quarantined has to say so in the build log, or the log
     * is the thing that teaches the team the suite is fine.
     */
    if (verdict.suppressedFailures > 0) {
      stdout.write(
        `  ${verdict.suppressedFailures} failing test(s) are quarantined, so they did not fail ` +
          `this build. They are still failing — quarantine stops the gate, not the failure.\n`,
      );
    }
    for (const evaluation of view.gateResult?.evaluations ?? []) {
      if (evaluation.action === 'BLOCK') stdout.write(`  gate BLOCK — ${evaluation.detail}\n`);
      // WARN evaluations used to be dropped on the floor, and the quarantine
      // budget's "near the cap" and "a quarantine expired" alarms are WARNs.
      // An alarm nobody prints is not an alarm.
      else if (evaluation.action === 'WARN') stdout.write(`  gate warn — ${evaluation.detail}\n`);
    }
    /*
     * The scope line is printed on a GREEN selective run, which is the whole
     * point: "✓ 12 passed" with nothing beside it is how a team comes to read a
     * green tick as a statement about 5,000 tests.
     */
    if (selection.scope === 'SELECTED') stdout.write(`  ${selection.disclosure}\n`);
    for (const line of scoped.lines) stdout.write(`${line}\n`);
    for (const line of disclosures) stdout.write(`  ${line}\n`);
    if (command.suppressions) {
      for (const line of suppressionLines(view)) stdout.write(`  ${line}\n`);
    }
    if (code === RUN_EXIT.NOT_FULL_SUITE) stdout.write(`  ${NOT_FULL_SUITE_NOTE}\n`);
  }

  return code;
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
  const verdict = verdictOf(run);
  if (opts.json) {
    stdout.write(JSON.stringify({ ...run, ci: { failed: !verdict.passed, ...verdict } }) + '\n');
  } else {
    stdout.write(`${summaryLine(run, verdict)}\n`);
    if (verdict.suppressedFailures > 0) {
      stdout.write(
        `  ${verdict.suppressedFailures} failing test(s) are quarantined and did not fail the build.\n`,
      );
    }
  }
  /*
   * Was `run.failedCount > 0`, which is the same defect in miniature: a
   * quarantined failure exited 1 here too, and a gate that blocked a run with
   * every test green exited 0. One verdict, both answers.
   *
   * A run that has not FINISHED exits 0 regardless. `status` is a query, not a
   * gate — `runOutcome` reports an unfinished run as `passed: false` because it
   * has no verdict yet, and turning "still running" into a failed step would
   * break every pipeline that polls this command.
   */
  if (!TERMINAL.has(run.status)) return 0;
  return verdict.passed ? 0 : 1;
}

async function fetchJunit(opts: GlobalOptions, runId: string): Promise<string> {
  const response = await fetch(`${opts.apiUrl}/runs/${runId}/junit.xml`, {
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  if (!response.ok) throw new CliError(`Could not fetch JUnit XML (${response.status})`);
  return response.text();
}

// ─── Help ────────────────────────────────────────────────────────────────────

/**
 * `--help`, rendered FROM the flag tables rather than written beside them.
 *
 * A hand-written help block is how `--no-wait` came to be documented for a
 * feature that did not work: the text and the parser were two statements about
 * one thing. Here there is one statement — add a knob to `createRunSchema`,
 * `RUN_FLAGS` fails to compile until it is named, and the help gains a line.
 */
function helpBlock(): string {
  const wrap = (flag: string, help: string): string => {
    const head = `  --${flag}`.padEnd(24, ' ');
    const words = help.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      if (current.length + word.length + 1 > 52) {
        lines.push(current);
        current = word;
      } else current = current === '' ? word : `${current} ${word}`;
    }
    if (current !== '') lines.push(current);
    return lines.map((line, index) => (index === 0 ? head + line : ' '.repeat(24) + line)).join('\n');
  };

  const request = REQUEST_FLAG_SPECS.map((spec) => wrap(spec.flag, spec.help));
  const extra = Object.entries(EXTRA_FLAGS).map(([flag, help]) => wrap(flag, help));
  const transport = Object.entries(TRANSPORT_FLAGS)
    .filter(([flag]) => flag !== 'reporter' && flag !== 'reporter-out' && flag !== 'testrail-run')
    .map(([flag, help]) => wrap(flag, help));
  return [...request, ...extra, ...transport].join('\n');
}

const HELP = `qaai — run QAAI test suites from any CI

Usage:
  qaai run --env <id> [options]         Run a suite and wait for the verdict
  qaai deploy-check --env <id> [opts]   Post-deploy smoke run (exit 1 on failure)
  qaai status <runId>                   Print the status of a run
  qaai coverage --project <id>          What has nothing ever tested? (--min to gate)
  qaai bench [--app-root <path>]        How accurate is QAAI itself? (\`qaai bench\` for detail)
  qaai backup <create|verify|restore>   Back up or restore the database
  qaai runner [--api-url <url>]         Run tests inside your own network

Run options — every knob POST /runs has, and what each one does to the run:
${helpBlock()}
Impact selection is NEVER silent. A run that executed 12 of 5,000 tests prints
what it SELECTED and what it SKIPPED on the GREEN path too, and a gate rule
scored from the run's own results is reported as scoped to that subset rather
than as a suite pass. Where the diff cannot be computed — no git, a SHALLOW
clone (which is actions/checkout's default), an unknown base — the FULL SUITE
runs and the reason is printed. Use --require-full-suite in the job that must
gate the whole suite: it exits 3 on a selected run.

Coverage options (qaai coverage, full detail in \`qaai coverage\` with no args):
  --project <id>      The project to report on (required)
  --min <percent>     Fail the build below this floor. Exit 1 below it, and
                      exit 3 — a different failure — when there is nothing to
                      divide, because coverage that was never computed did not
                      drop. Exit 2 stays "the gate never ran".
  --limit <n>         How many items to print (default 50). Whatever is held
                      back is counted out loud; the totals are always complete.
  --kind/--status/--origin   Narrow the list
                      Default status is UNCOVERED, which is the point of it.

Reporters (repeatable, and composable with --junit):
  --reporter <name>   junit | allure | testrail  (sarif, evidence-pack: exist, but
                      are rendered by @qaai/runner, not by this CLI)
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
build host, and in the shell history of whoever ran it once by hand. The same is
true of \`--api-key\`; prefer QAAI_API_KEY.

Exit codes:
  0  Nothing that gates failed.
  1  A test that GATES failed, or a quality gate blocked. A quarantined test's
     failure does NOT fail the build — it is reported on its own line and
     counted in \`ci.suppressedFailures\` under --json, because quarantine stops
     the gate and never the failure.
  2  The gate could not be delivered: bad flags, no API key, the API could not
     be reached, a reporter could not publish, or the server dropped a field
     this CLI sent (so the run that happened is not the run that was asked for).
  3  The run PASSED and it executed a SELECTED subset while --require-full-suite
     was set. Your tests did not fail; the suite was not run. Same meaning as
     \`qaai coverage\`'s exit 3 — the gate could not be answered.`;

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
    /*
     * Lazy like `backup` and `runner`, and for the same reason: `qaai status`
     * should not pay to load a renderer it will never use. Its own exit codes
     * are richer than this file's (3 means "nothing was measured", which is
     * neither a failure of the tests nor of the transport), so the command owns
     * the whole mapping and returns the code rather than throwing.
     */
    case 'coverage': {
      const { cmdCoverage } = await import('./commands/coverage.js');
      return cmdCoverage(opts, rest);
    }
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
    /*
     * `qaai bench` — the harness that measures the MEASURER, and the only
     * command here whose subject is QAAI rather than the customer's
     * application: ground-truth precision and recall against
     * apps/demo/src/surface.json, and seeded-fault detection per fault class.
     *
     * It was built, tested and reachable from nothing but its own test file, so
     * `check:wiring` reported it under `package-exports` — this codebase's
     * signature defect, and a particularly bad one here: a catch-all route
     * literal once produced 100% coverage and survived a whole round precisely
     * because nothing was checking the measurement against a known answer.
     *
     * Lazy like `coverage`, `backup` and `runner`, and for the same reason: it
     * pulls in a JUnit parser and a child-process runner, and `qaai status`
     * should not pay to load either. Its exit codes are its own
     * (`BENCH_EXIT.USAGE`, and a nonzero when a precision or recall FLOOR is
     * breached), so the command owns the whole mapping and returns the code
     * rather than throwing.
     */
    case 'bench': {
      const { cmdBench } = await import('./bench.js');
      return cmdBench(opts, rest);
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
