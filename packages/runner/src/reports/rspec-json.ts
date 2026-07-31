/**
 * RSpec `--format json`.
 *
 * A clean schema, with two things that need attention.
 *
 * **`errors_outside_of_examples_count`.** When a spec file raises at load time,
 * RSpec reports zero examples, zero failures, and a non-zero count in that one
 * field. Every other number in the document says the run was fine. Ignoring it
 * turns "the suite could not be loaded" into a passing run of nothing.
 *
 * **Shared stdout.** RSpec writes JSON to stdout, and anything else the process
 * prints — a `puts` in a spec, a deprecation warning, a second formatter from
 * `.rspec` — lands in the same stream. The report is carved out of the noise
 * rather than rejected.
 *
 * `run_time` is seconds. `pending` is a skip, and its `pending_message` is the
 * reason.
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

const FORMAT = 'rspec-json' as const;

const STATUSES: Record<string, ReportTestStatus> = {
  passed: 'passed',
  failed: 'failed',
  pending: 'skipped',
};

export function parseRSpecJson(text: string): ParsedReport {
  const parsed = parseJsonLoose(text);
  const diagnostics = [...parsed.diagnostics];
  let truncated = parsed.truncated;

  if (!parsed.ok || !isRecord(parsed.value)) {
    return unreadableReport(
      FORMAT,
      'The report is not a JSON object — this file is not `rspec --format json` output.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  const root = parsed.value;
  if (!Array.isArray(root['examples'])) {
    return unreadableReport(FORMAT, 'No `examples` array — this JSON is not an RSpec report.', {
      truncated,
      diagnostics,
    });
  }

  const tests: ReportTest[] = [];
  let fragments = 0;
  for (const raw of root['examples']) {
    if (!isRecord(raw)) continue;
    // An example object with no `status` came out of a truncated file. It is a
    // fragment, not an example with an unrecognised result.
    if (typeof raw['status'] !== 'string') {
      fragments += 1;
      continue;
    }

    const description = asString(raw['description']) ?? 'unnamed example';
    const full = asString(raw['full_description']) ?? description;
    // full_description is the describe/context chain plus the example; the
    // chain alone is the suite.
    const suite = full.endsWith(description)
      ? full.slice(0, full.length - description.length).trim()
      : '';
    const status = STATUSES[(asString(raw['status']) ?? '').toLowerCase()] ?? 'failed';

    const exception = isRecord(raw['exception']) ? raw['exception'] : null;
    const klass = exception ? nonEmpty(asString(exception['class'])) : null;
    const message = exception ? nonEmpty(asString(exception['message'])) : null;
    const backtrace = exception
      ? asArray(exception['backtrace']).filter((x): x is string => typeof x === 'string')
      : [];

    tests.push(
      makeTest({
        suite: suite || (asString(raw['file_path']) ?? ''),
        name: description,
        status,
        durationMs: secondsToMs(raw['run_time']),
        failureMessage:
          status === 'failed'
            ? clip([klass, message].filter(Boolean).join(': ') || 'failed')
            : null,
        stack: backtrace.length > 0 ? clip(backtrace.join('\n')) : null,
      }),
    );
  }

  if (fragments > 0) {
    truncated = true;
    diagnostics.push(`${fragments} example record(s) were incomplete — the file stops mid-write.`);
  }

  const summary = isRecord(root['summary']) ? root['summary'] : null;

  if (summary) {
    const declared = toNumber(summary['example_count']);
    if (declared !== null && declared > tests.length) {
      truncated = true;
      diagnostics.push(
        `summary.example_count is ${declared} but the report contains ${tests.length} example(s).`,
      );
    }

    const outside = toNumber(summary['errors_outside_of_examples_count']) ?? 0;
    if (outside > 0) {
      // These never appear as examples — the file raised before RSpec could
      // define any. Without this, the run reads as an empty success.
      //
      // `messages` carries the actual LoadError, which is the only place the
      // cause appears anywhere in the document.
      const messages = asArray(root['messages'])
        .filter((m): m is string => typeof m === 'string')
        .map((m) => m.trim())
        .filter((m) => m !== '');

      tests.push(
        makeTest({
          suite: '',
          name: `${outside} error(s) occurred outside of examples`,
          status: 'failed',
          durationMs: 0,
          failureMessage: clip(
            messages.join('\n\n') ||
              nonEmpty(asString(root['summary_line'])) ||
              'RSpec raised while loading spec files, so some examples were never defined.',
          ),
          stack: null,
        }),
      );
    }
  }

  return finaliseReport(FORMAT, {
    suiteName: null,
    tests,
    durationMs:
      summary && summary['duration'] !== undefined ? secondsToMs(summary['duration']) : null,
    truncated,
    diagnostics,
  });
}
