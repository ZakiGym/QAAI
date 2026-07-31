/**
 * pytest, via the `pytest-json-report` plugin
 * (`pytest --json-report --json-report-file=…`).
 *
 * The duration of a test is not one number. pytest runs three phases — setup,
 * call, teardown — each with its own outcome and its own duration in SECONDS,
 * and the interesting ones do not always live in `call`:
 *
 *  - a fixture that raises puts the failure in `setup` and leaves `call` absent
 *    entirely, so reading only `call` reports the test as having no failure;
 *  - `@pytest.mark.skip` resolves in `setup`, with the reason in its `longrepr`;
 *  - a teardown that raises fails a test whose `call` passed.
 *
 * `xfailed` is an expected failure and is not a failure. `xpassed` is a test
 * that was expected to fail and did not — only a failure under
 * `strict=True`, which the report does not tell us, so it is reported as a pass
 * and left to pytest's own exit code to escalate.
 *
 * A collection error produces a report with an empty `tests` array and a failed
 * entry in `collectors`. That is a suite that could not be imported, and it is
 * promoted to a failing test rather than counted as nothing.
 */

import {
  asArray,
  asString,
  clip,
  isRecord,
  nonEmpty,
  parseJsonLoose,
  secondsToMs,
  toNumber,
} from './common.js';
import { finaliseReport, makeTest, unreadableReport } from './types.js';
import type { ParsedReport, ReportTest, ReportTestStatus } from './types.js';

const FORMAT = 'pytest-json' as const;

const OUTCOMES: Record<string, ReportTestStatus> = {
  passed: 'passed',
  failed: 'failed',
  error: 'failed',
  skipped: 'skipped',
  xfailed: 'skipped',
  xpassed: 'passed',
  rerun: 'skipped',
};

const PHASES = ['setup', 'call', 'teardown'] as const;

export function parsePytestJson(text: string): ParsedReport {
  const parsed = parseJsonLoose(text);
  const diagnostics = [...parsed.diagnostics];
  let truncated = parsed.truncated;

  if (!parsed.ok || !isRecord(parsed.value)) {
    return unreadableReport(
      FORMAT,
      'The report is not a JSON object — this file is not a pytest-json-report file.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  const root = parsed.value;
  const hasTests = Array.isArray(root['tests']);
  const hasSummary = isRecord(root['summary']);
  if (!hasTests && !hasSummary && !Array.isArray(root['collectors'])) {
    return unreadableReport(
      FORMAT,
      'No `tests`, `summary`, or `collectors` key — this is not pytest-json-report output.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  const tests: ReportTest[] = [];
  let fragments = 0;
  for (const raw of asArray(root['tests'])) {
    if (!isRecord(raw)) continue;
    // A record with no `outcome` is a half-written object recovered from a
    // truncated file, not a test with an unrecognised result. Guessing a status
    // for it would invent a verdict; it is counted and named instead.
    if (typeof raw['outcome'] !== 'string') {
      fragments += 1;
      continue;
    }
    tests.push(toTest(raw));
  }
  if (fragments > 0) {
    truncated = true;
    diagnostics.push(
      `${fragments} test record(s) were incomplete and had no outcome — the file stops mid-write.`,
    );
  }

  // Collection failures: the module never imported, so none of its tests exist.
  for (const raw of asArray(root['collectors'])) {
    if (!isRecord(raw)) continue;
    if ((asString(raw['outcome']) ?? '') !== 'failed') continue;
    const nodeid = asString(raw['nodeid']) ?? '';
    tests.push(
      makeTest({
        suite: nodeid,
        name: `${nodeid || 'collection'} (collection error)`,
        status: 'failed',
        durationMs: 0,
        failureMessage: clip(
          nonEmpty(asString(raw['longrepr'])) ?? 'pytest could not collect this module.',
        ),
        stack: null,
      }),
    );
  }

  const summary = isRecord(root['summary']) ? root['summary'] : null;
  if (summary) {
    const declared = toNumber(summary['total']) ?? toNumber(summary['collected']);
    const counted = tests.filter((t) => !t.name.endsWith('(collection error)')).length;
    if (declared !== null && declared > counted) {
      truncated = true;
      diagnostics.push(`summary.total is ${declared} but the report contains ${counted} test(s).`);
    }
  }

  const exitcode = toNumber(root['exitcode']);
  if (exitcode !== null && exitcode !== 0 && tests.every((t) => t.status !== 'failed')) {
    // pytest exit codes: 1 tests failed, 2 interrupted, 3 internal error,
    // 4 usage error, 5 no tests collected. None of them are a green run, and
    // none of them are visible in the per-test records.
    diagnostics.push(
      `pytest exited ${exitcode} but no test is recorded as failed — the run did not complete normally.`,
    );
    if (exitcode !== 5) truncated = truncated || exitcode === 2;
  }

  return finaliseReport(FORMAT, {
    suiteName: nonEmpty(asString(root['root'])),
    tests,
    durationMs: root['duration'] === undefined ? null : secondsToMs(root['duration']),
    truncated,
    diagnostics,
  });
}

function toTest(raw: Record<string, unknown>): ReportTest {
  const nodeid = asString(raw['nodeid']) ?? 'unnamed test';
  const split = nodeid.indexOf('::');
  const suite = split > 0 ? nodeid.slice(0, split) : '';
  const name = split > 0 ? nodeid.slice(split + 2) : nodeid;

  const status = OUTCOMES[(asString(raw['outcome']) ?? '').toLowerCase()] ?? 'failed';

  // Every phase that ran contributes to the wall clock of the test. Summed in
  // seconds and converted once: rounding each phase first loses a millisecond
  // per phase on tests that take microseconds, which is most of them.
  let durationSeconds = 0;
  let failureText: string | null = null;
  let crash: string | null = null;

  for (const phase of PHASES) {
    const p = raw[phase];
    if (!isRecord(p)) continue;
    durationSeconds += toNumber(p['duration']) ?? 0;

    const phaseOutcome = (asString(p['outcome']) ?? '').toLowerCase();
    if (phaseOutcome !== 'failed' && phaseOutcome !== 'error') continue;

    const longrepr = nonEmpty(asString(p['longrepr']));
    if (longrepr && !failureText)
      failureText = phase === 'call' ? longrepr : `${phase}: ${longrepr}`;

    const crashInfo = p['crash'];
    if (isRecord(crashInfo) && !crash) {
      const message = nonEmpty(asString(crashInfo['message']));
      const path = asString(crashInfo['path']);
      const lineno = toNumber(crashInfo['lineno']);
      if (message) crash = path ? `${message}\n  at ${path}:${lineno ?? '?'}` : message;
    }
  }

  const durationMs = secondsToMs(durationSeconds);

  if (status === 'failed') {
    return makeTest({
      suite,
      name,
      status,
      durationMs,
      // `crash` is the one-line assertion; `longrepr` is the whole pytest
      // report block, which belongs in the stack rather than the headline.
      failureMessage: clip(crash ?? failureText ?? 'failed'),
      stack: crash && failureText && failureText !== crash ? clip(failureText) : null,
    });
  }

  return makeTest({ suite, name, status, durationMs });
}
