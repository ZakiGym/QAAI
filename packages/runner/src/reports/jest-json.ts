/**
 * Jest `--json` and Vitest `--reporter=json`, which share a schema.
 *
 * The durations here are already milliseconds — the only format in this
 * directory that needs no conversion, and worth stating explicitly because
 * multiplying them by 1000 "for consistency" is an easy mistake to make.
 *
 * The important case is a **suite that failed to load**. A test file with a
 * syntax error or a missing import produces a `testResults` entry with
 * `status: "failed"`, a `message`, and `assertionResults: []`. Every test in
 * that file simply is not in the report. Summing the assertions gives "0 tests,
 * 0 failures" for a file that could not even be parsed, so the suite-level
 * failure is promoted to a test of its own.
 *
 * `wasInterrupted` marks a run that was killed — its numbers are a partial
 * count of a run that never finished, not the result of a smaller run.
 */

import {
  asArray,
  asString,
  clip,
  isRecord,
  msValue,
  nonEmpty,
  parseJsonLoose,
  toNumber,
} from './common.js';
import { finaliseReport, makeTest, unreadableReport } from './types.js';
import type { ParsedReport, ReportTest, ReportTestStatus } from './types.js';

const FORMAT = 'jest-json' as const;

const STATUSES: Record<string, ReportTestStatus> = {
  passed: 'passed',
  failed: 'failed',
  pending: 'skipped',
  skipped: 'skipped',
  todo: 'skipped',
  disabled: 'skipped',
  focused: 'passed',
};

export function parseJestJson(text: string): ParsedReport {
  const parsed = parseJsonLoose(text);
  const diagnostics = [...parsed.diagnostics];
  let truncated = parsed.truncated;

  if (!parsed.ok || !isRecord(parsed.value)) {
    return unreadableReport(
      FORMAT,
      'The report is not a JSON object — this file is not Jest/Vitest --json output.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  const root = parsed.value;
  const suites = asArray(root['testResults']);
  if (!Array.isArray(root['testResults'])) {
    return unreadableReport(
      FORMAT,
      'No `testResults` array — this JSON is not Jest/Vitest --json output.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  if (root['wasInterrupted'] === true) {
    truncated = true;
    diagnostics.push(
      '`wasInterrupted: true` — Jest was stopped before it finished, so tests are missing.',
    );
  }

  const tests: ReportTest[] = [];
  let fragments = 0;
  for (const raw of suites) {
    if (!isRecord(raw)) continue;
    const file = asString(raw['name']) ?? '';
    const assertions = asArray(raw['assertionResults']);

    for (const a of assertions) {
      if (!isRecord(a)) continue;
      // No `status` at all means this object was recovered from a half-written
      // file. It is a fragment, not a test with an unknown result — inventing
      // a verdict for it would be worse than saying the file is incomplete.
      if (typeof a['status'] !== 'string') {
        fragments += 1;
        continue;
      }
      const title = asString(a['title']) ?? asString(a['fullName']) ?? 'unnamed test';
      const ancestors = asArray(a['ancestorTitles']).filter(
        (x): x is string => typeof x === 'string',
      );
      const status = STATUSES[(asString(a['status']) ?? '').toLowerCase()] ?? 'failed';
      const messages = asArray(a['failureMessages']).filter(
        (x): x is string => typeof x === 'string',
      );

      tests.push(
        makeTest({
          // The describe() chain is the suite; the file alone loses the nesting
          // and the nesting alone loses the file.
          suite: [file, ...ancestors].filter((s) => s !== '').join(' › '),
          name: title,
          status,
          // Already milliseconds. `null` for tests that never ran.
          durationMs: msValue(a['duration']),
          failureMessage: status === 'failed' ? clip(messages.join('\n\n')) || 'failed' : null,
          stack: null,
        }),
      );
    }

    if (assertions.length === 0 && (asString(raw['status']) ?? '') === 'failed') {
      // The file never produced tests — it failed to compile, import, or its
      // top-level code threw. Reporting zero tests here is reporting success.
      const message =
        nonEmpty(asString(raw['message'])) ?? 'The test file failed before any test ran.';
      tests.push(
        makeTest({
          suite: file,
          name: `${file || 'test file'} (suite failed to run)`,
          status: 'failed',
          durationMs: suiteDuration(raw),
          failureMessage: clip(message),
          stack: null,
        }),
      );
    }
  }

  if (fragments > 0) {
    truncated = true;
    diagnostics.push(
      `${fragments} assertion record(s) were incomplete — the file stops mid-write.`,
    );
  }

  // Jest states its own totals; a disagreement means tests are missing from the
  // array, which is exactly what a half-written file looks like.
  const declared = toNumber(root['numTotalTests']);
  const counted = tests.filter((t) => !t.name.endsWith('(suite failed to run)')).length;
  if (declared !== null && declared > counted) {
    truncated = true;
    diagnostics.push(
      `\`numTotalTests: ${declared}\` but the report contains ${counted} assertion result(s).`,
    );
  }

  const start = toNumber(root['startTime']);
  const ends = suites
    .map((s) => (isRecord(s) ? toNumber(s['endTime']) : null))
    .filter((n): n is number => n !== null);
  const durationMs = start !== null && ends.length > 0 ? Math.max(...ends) - start : null;

  return finaliseReport(FORMAT, {
    suiteName:
      suites.length === 1 && isRecord(suites[0])
        ? asString((suites[0] as Record<string, unknown>)['name'])
        : null,
    tests,
    durationMs: durationMs !== null && durationMs >= 0 ? durationMs : null,
    truncated,
    diagnostics,
  });
}

function suiteDuration(suite: Record<string, unknown>): number {
  const start = toNumber(suite['startTime']);
  const end = toNumber(suite['endTime']);
  return start !== null && end !== null && end >= start ? end - start : 0;
}
