/**
 * Result-format registry: pick a parser by format id, get one shape back.
 *
 * QAAI runs other people's test tools rather than reimplementing them (§4), so
 * the only thing standing between "your suite runs" and "your suite reports" is
 * whether we can read what the tool wrote. This is that layer, and everything
 * in it is written for one rule: **a reporting problem must never become a lost
 * run.** No parser throws, an unreadable file comes back as a diagnostic, and
 * nothing that failed to produce results is allowed to look like a pass.
 */

import type { StepResult, TestResultStatus } from '@qaai/shared';
import { stripBom } from './common.js';
import { parseCucumberJson } from './cucumber-json.js';
import { parseGoJson } from './go-json.js';
import { parseJestJson } from './jest-json.js';
import { parseJUnitXml } from './junit-xml.js';
import { parseNUnit3 } from './nunit3.js';
import { parsePytestJson } from './pytest-json.js';
import { parseRSpecJson } from './rspec-json.js';
import { parseTap } from './tap.js';
import { parseTrx } from './trx.js';
import { emptyReport, finaliseReport, REPORT_FORMATS } from './types.js';
import type { ParsedReport, ReportFormat, ReportTest } from './types.js';

export type {
  ParsedReport,
  ReportDraft,
  ReportFormat,
  ReportPresence,
  ReportTest,
  ReportTestStatus,
  ReportTotals,
} from './types.js';
export { REPORT_FORMATS } from './types.js';
export { parseCucumberJson } from './cucumber-json.js';
export { parseGoJson } from './go-json.js';
export { parseJestJson } from './jest-json.js';
export { parseJUnitXml } from './junit-xml.js';
export { parseNUnit3 } from './nunit3.js';
export { parsePytestJson } from './pytest-json.js';
export { parseRSpecJson } from './rspec-json.js';
export { parseTap } from './tap.js';
export { parseTrx } from './trx.js';

type Parser = (text: string) => ParsedReport;

const PARSERS: Record<ReportFormat, Parser> = {
  'junit-xml': parseJUnitXml,
  tap: parseTap,
  'go-json': parseGoJson,
  trx: parseTrx,
  nunit3: parseNUnit3,
  'jest-json': parseJestJson,
  'pytest-json': parsePytestJson,
  'rspec-json': parseRSpecJson,
  'cucumber-json': parseCucumberJson,
};

/**
 * Spellings that resolve to a format id. `junit` is the id specs used before
 * the other parsers existed and must keep working; the rest are the names
 * people reach for from the tool they are configuring.
 */
const ALIASES: Record<string, ReportFormat> = {
  junit: 'junit-xml',
  'junit-xml': 'junit-xml',
  xunit: 'junit-xml',
  surefire: 'junit-xml',
  tap: 'tap',
  tap13: 'tap',
  tap14: 'tap',
  'go-json': 'go-json',
  gotest: 'go-json',
  trx: 'trx',
  nunit3: 'nunit3',
  nunit: 'nunit3',
  'jest-json': 'jest-json',
  jest: 'jest-json',
  vitest: 'jest-json',
  'pytest-json': 'pytest-json',
  pytest: 'pytest-json',
  'rspec-json': 'rspec-json',
  rspec: 'rspec-json',
  'cucumber-json': 'cucumber-json',
  cucumber: 'cucumber-json',
  behave: 'cucumber-json',
};

export function resolveReportFormat(id: string): ReportFormat | null {
  return ALIASES[id.trim().toLowerCase()] ?? null;
}

export function isReportFormat(id: string): id is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(id);
}

/**
 * Read a report.
 *
 * `text` is the file exactly as it was on disk. An empty file short-circuits
 * before any parser sees it: there is no format-specific way to read nothing,
 * and every parser would otherwise have to re-derive the same answer.
 */
export function parseReport(format: ReportFormat, text: string): ParsedReport {
  if (stripBom(text ?? '').trim() === '') return emptyReport(format);

  const parser = PARSERS[format];
  try {
    return parser(text);
  } catch (err) {
    // Belt and braces. Every parser is written not to throw, but a parser that
    // throws must still not take the run down with it — that would turn a
    // reporting bug into a lost result, which is the one outcome this module
    // exists to prevent.
    return finaliseReport(format, {
      presence: 'unreadable',
      diagnostics: [
        `The ${format} parser failed on this file: ${err instanceof Error ? err.message : String(err)}`,
      ],
    });
  }
}

/**
 * Guess the format from the content. Used when a spec says `auto`, and as the
 * hint in the error message when a report does not match the declared format.
 */
export function detectReportFormat(text: string): ReportFormat | null {
  const head = stripBom(text).slice(0, 8000);
  const trimmed = head.trimStart();
  if (trimmed === '') return null;

  if (/^\s*TAP\s+version\s+\d+/im.test(head) || /^\s*(not )?ok\s+\d+/m.test(head)) return 'tap';

  const direct = sniff(head, trimmed, true);
  if (direct) return direct;

  // The document does not start where the file does. Runners share stdout — an
  // RSpec load error, a `.rspec` with a second formatter, npm's own preamble —
  // and `parseJsonLoose` already recovers the report from the middle of the
  // noise. Detection has to reach the same file, or `auto` refuses a report the
  // parser could have read.
  if (trimmed[0] !== '<' && trimmed[0] !== '{' && trimmed[0] !== '[') {
    const at = firstOpener(head);
    if (at >= 0) {
      const carved = head.slice(at);
      // Signatures only on this path: a bare `[` in a log line is not a
      // Cucumber report, and guessing from position would make any stray
      // bracket look like one.
      return sniff(carved, carved, false);
    }
  }

  return null;
}

/** Index of the first `<`, `{` or `[` in the head, or -1. */
function firstOpener(head: string): number {
  const candidates = [head.indexOf('<'), head.indexOf('{'), head.indexOf('[')].filter((n) => n >= 0);
  return candidates.length === 0 ? -1 : Math.min(...candidates);
}

/**
 * The signature table. `positional` allows the one rule that reads the opening
 * character rather than a key — a top-level array is Cucumber — which is safe
 * for a file that starts with the document and not for one carved out of noise.
 */
function sniff(head: string, trimmed: string, positional: boolean): ReportFormat | null {
  if (trimmed.startsWith('<')) {
    if (/<TestRun\b/i.test(head)) return 'trx';
    if (/<test-run\b/.test(head)) return 'nunit3';
    if (/<test-results\b/.test(head)) return 'nunit3'; // NUnit2; the parser names it
    if (/<testsuites?\b/i.test(head) || /<testcase\b/i.test(head)) return 'junit-xml';
    return null;
  }

  if (trimmed.startsWith('[')) {
    if (positional) return 'cucumber-json';
    return /"elements"\s*:/.test(head) || /"keyword"\s*:/.test(head) ? 'cucumber-json' : null;
  }

  if (trimmed.startsWith('{')) {
    // NDJSON: `go test -json` is one object per line, so a second `{` at the
    // start of a later line is the tell.
    if (/"Action"\s*:\s*"(run|pass|fail|skip|output|start)"/.test(head)) return 'go-json';
    if (/"testResults"\s*:/.test(head) || /"numTotalTests"\s*:/.test(head)) return 'jest-json';
    // `summary_line` and `errors_outside_of_examples_count` are RSpec's alone,
    // and unlike `full_description` they survive a run with zero examples —
    // which is exactly the shape a load error produces, and the one case where
    // reading the report matters most.
    if (/"summary_line"\s*:/.test(head)) return 'rspec-json';
    if (/"errors_outside_of_examples_count"\s*:/.test(head)) return 'rspec-json';
    if (/"examples"\s*:/.test(head) && /"full_description"\s*:/.test(head)) return 'rspec-json';
    if (/"nodeid"\s*:/.test(head) || /"exitcode"\s*:/.test(head)) return 'pytest-json';
    return null;
  }

  return null;
}

// ─── Bridging to the runner's own result shape ───────────────────────────────

/**
 * Turn a parsed report into the `StepResult[]` every plugin already returns, so
 * a plugin does not care which format it read.
 *
 * Steps are laid out end to end from `startedAt`. The formats do not record
 * when each test began — only how long it took — and a scrubber that shows
 * every step starting at the same instant is worse than one that shows them in
 * the order and proportion the report actually gives us.
 */
export function toStepResults(report: ParsedReport, startedAt: Date = new Date()): StepResult[] {
  let cursor = startedAt.getTime();

  return report.tests.map((test, index) => {
    const at = new Date(cursor).toISOString();
    cursor += test.durationMs;

    return {
      index,
      title: stepTitle(test),
      status: test.status === 'passed' ? 'PASSED' : test.status === 'failed' ? 'FAILED' : 'SKIPPED',
      startedAt: at,
      durationMs: test.durationMs,
      screenshotKey: null,
      error:
        test.status === 'failed'
          ? {
              message: test.failureMessage ?? 'failed',
              stack: test.stack,
              selector: null,
              expected: null,
              actual: null,
            }
          : null,
    } satisfies StepResult;
  });
}

function stepTitle(test: ReportTest): string {
  return test.suite && test.suite !== test.name ? `${test.suite} › ${test.name}` : test.name;
}

/**
 * The run-level verdict for a report, with the "no report" cases kept out of
 * PASSED.
 *
 * A report that was never written, or that could not be read, resolves to
 * SKIPPED — "not evaluated", which is what actually happened — never to PASSED.
 * The caller still holds the process exit code and should escalate to FAILED
 * when the tool itself said it failed; what it must not do is invent a pass
 * from an absence.
 */
export function summariseReport(
  report: ParsedReport,
  reportPath?: string,
): {
  status: TestResultStatus;
  errorMessage: string | null;
} {
  const where = reportPath ? ` at ${reportPath}` : '';

  if (report.presence === 'empty') {
    return {
      status: 'SKIPPED',
      errorMessage: `The ${report.format} report${where} was empty — the runner never wrote a result, so nothing was evaluated.`,
    };
  }

  if (report.presence === 'unreadable') {
    return {
      status: 'SKIPPED',
      errorMessage: [
        `The report${where} could not be read as ${report.format}.`,
        ...report.diagnostics,
      ].join(' '),
    };
  }

  const { failed, tests } = report.totals;

  if (failed > 0) {
    const first = report.tests.find((t) => t.status === 'failed');
    const head = `${failed} of ${tests} failed. First: ${first ? stepTitle(first) : ''} — ${first?.failureMessage ?? ''}`;
    return { status: 'FAILED', errorMessage: withDiagnostics(head, report).slice(0, 2000) };
  }

  if (tests === 0) {
    // A real report that selected nothing. Different from an empty file, and
    // still not a pass: a filter that matches no tests is a broken filter.
    return {
      status: 'SKIPPED',
      errorMessage: withDiagnostics(
        `The ${report.format} report${where} is valid but contains no tests.`,
        report,
      ),
    };
  }

  if (report.truncated) {
    // Everything we read passed, but the report says there was more. Calling
    // that a pass is calling a partial run a complete one.
    return {
      status: 'FAILED',
      errorMessage: withDiagnostics(
        `The report${where} is incomplete — ${tests} test(s) were read but the run did not finish writing.`,
        report,
      ).slice(0, 2000),
    };
  }

  return { status: 'PASSED', errorMessage: null };
}

function withDiagnostics(head: string, report: ParsedReport): string {
  return report.diagnostics.length > 0 ? `${head} (${report.diagnostics.join(' ')})` : head;
}
