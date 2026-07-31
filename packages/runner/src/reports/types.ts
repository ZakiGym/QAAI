/**
 * The one shape every result parser returns.
 *
 * A plugin should never care which tool wrote the report it is reading. It asks
 * for `ParsedReport` and gets the same fields whether the file was Surefire XML,
 * a TAP stream, or `go test -json`. Everything format-specific — seconds vs
 * nanoseconds, `NotExecuted` vs `pending` vs `# SKIP`, rollup rows that would
 * double-count — is resolved before it crosses this boundary.
 *
 * Two invariants hold for every parser in this directory:
 *
 *  1. Parsing NEVER throws. A malformed report is a reporting problem; a thrown
 *     exception turns it into a lost run. Every parser returns what it could
 *     read plus a diagnostic explaining the rest.
 *
 *  2. "No report" is not "zero failures". `presence` separates *the runner said
 *     it ran no tests* from *the runner never wrote anything*, because the
 *     second one rendered green is how a broken CI job impersonates a healthy
 *     suite. Nothing here may collapse the two.
 */

/** Normalised across every format: NotExecuted, pending, ignored and `# SKIP` all land on 'skipped'. */
export type ReportTestStatus = 'passed' | 'failed' | 'skipped';

/** One test, as the tool reported it. */
export interface ReportTest {
  /**
   * Whatever the format groups tests by — Java class, spec file, Go package,
   * Gherkin feature, TAP subtest path. Empty when the format has no grouping.
   */
  suite: string;
  name: string;
  status: ReportTestStatus;
  durationMs: number;
  /** Only on 'failed'. The assertion text, not the stack. */
  failureMessage: string | null;
  /** Only when the format carries a stack/traceback apart from the message. */
  stack: string | null;
}

export interface ReportTotals {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  /** The run duration the report claims; falls back to the sum of the tests. */
  durationMs: number;
}

/**
 * Whether there was a report at all — deliberately separate from the pass/fail
 * verdict, so a caller cannot accidentally read "nothing went wrong" out of
 * "nothing was written".
 *
 *  - 'ok'         a report was read. `totals.tests === 0` here genuinely means
 *                 the runner selected no tests.
 *  - 'empty'      the file held no content. The runner never wrote a result.
 *  - 'unreadable' there was content, but nothing in it belonged to this format.
 */
export type ReportPresence = 'ok' | 'empty' | 'unreadable';

export const REPORT_FORMATS = [
  'junit-xml',
  'tap',
  'go-json',
  'trx',
  'nunit3',
  'jest-json',
  'pytest-json',
  'rspec-json',
  'cucumber-json',
] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ParsedReport {
  format: ReportFormat;
  presence: ReportPresence;
  /** The run/suite the report names as a whole, when it names one. */
  suiteName: string | null;
  tests: ReportTest[];
  totals: ReportTotals;
  /**
   * The file stops mid-token, or its own plan/counters promise more tests than
   * it contains — the classic signature of a runner killed mid-write. The tests
   * above are still real; there are just more that never made it to disk.
   */
  truncated: boolean;
  /** Non-fatal complaints, safe to show a user. Never a reason to discard results. */
  diagnostics: string[];
}

/** A parser's working set, before totals are computed. */
export interface ReportDraft {
  suiteName?: string | null;
  tests?: ReportTest[];
  /** Overrides the summed duration when the report states its own wall clock. */
  durationMs?: number | null;
  truncated?: boolean;
  diagnostics?: string[];
  presence?: ReportPresence;
}

/** Build a `ParsedReport`, deriving the totals so no parser can miscount them. */
export function finaliseReport(format: ReportFormat, draft: ReportDraft): ParsedReport {
  const tests = draft.tests ?? [];
  const summed = tests.reduce(
    (acc, t) => acc + (Number.isFinite(t.durationMs) ? t.durationMs : 0),
    0,
  );
  const claimed = draft.durationMs;

  return {
    format,
    presence: draft.presence ?? 'ok',
    suiteName: draft.suiteName ?? null,
    tests,
    totals: {
      tests: tests.length,
      passed: tests.filter((t) => t.status === 'passed').length,
      failed: tests.filter((t) => t.status === 'failed').length,
      skipped: tests.filter((t) => t.status === 'skipped').length,
      durationMs:
        typeof claimed === 'number' && Number.isFinite(claimed)
          ? Math.round(claimed)
          : Math.round(summed),
    },
    truncated: draft.truncated ?? false,
    diagnostics: draft.diagnostics ?? [],
  };
}

/** The file was blank. Distinct from a report that ran nothing — see `ReportPresence`. */
export function emptyReport(format: ReportFormat): ParsedReport {
  return finaliseReport(format, {
    presence: 'empty',
    diagnostics: [`The ${format} report was empty — the runner never wrote a result.`],
  });
}

/**
 * There was content and none of it was this format. Kept as a result rather
 * than an exception: the caller still needs the diagnostic, and a throw here
 * would take down a run that merely pointed `reportPath` at the wrong file.
 */
export function unreadableReport(
  format: ReportFormat,
  why: string,
  partial?: ReportDraft,
): ParsedReport {
  return finaliseReport(format, {
    ...partial,
    presence: 'unreadable',
    diagnostics: [why, ...(partial?.diagnostics ?? [])],
  });
}

/** Convenience for the parsers, which all build tests the same way. */
export function makeTest(
  t: Partial<ReportTest> & { name: string; status: ReportTestStatus },
): ReportTest {
  return {
    suite: t.suite ?? '',
    name: t.name,
    status: t.status,
    durationMs: Number.isFinite(t.durationMs) ? Math.max(0, Math.round(t.durationMs as number)) : 0,
    failureMessage:
      t.status === 'failed' ? (t.failureMessage ?? 'failed') : (t.failureMessage ?? null),
    stack: t.stack ?? null,
  };
}
