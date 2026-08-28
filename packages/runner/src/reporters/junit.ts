/**
 * JUnit XML — the format every CI already knows how to render.
 *
 * ── The constraint that outranks every opinion in this file ──────────────────
 *
 * This output is ALREADY PARSED IN PRODUCTION. `qaai run --junit results.xml`
 * has been documented since docs/ci.md was written, and the bytes it produces
 * come from `GET /runs/:runId/junit.xml` (apps/api/src/routes/runs.ts). Moving
 * that behind an interface is only worth doing if the bytes are identical, so
 * the layout below — two-space indent on `<testsuite>`, four on `<testcase>`,
 * the self-closing pass case, `&apos;` for a quote, the trailing newline, even
 * the blank line a run with zero tests leaves between the tags — is transcribed
 * from that route rather than rewritten. `reporters.test.ts` asserts it against
 * an independent transcription of the route's algorithm over every fixture; if
 * someone "tidies" a space here, that test goes red before a customer's build
 * does.
 *
 * Two consequences of that constraint are worth naming, because they read as
 * bugs and are not going to be fixed here:
 *
 *  - A FLAKY test is rendered as `<failure>`. JUnit has no vocabulary for "it
 *    passed on the retry" (Surefire's `<flakyFailure>` is a Surefire
 *    extension), and the route has always emitted a failure element here. The
 *    `failures` ATTRIBUTE meanwhile comes from the run's own counter, which
 *    excludes flakes — so the attribute and the elements can disagree. That is
 *    today's behaviour, and changing it moves numbers on dashboards people
 *    watch. The Allure reporter, which has no installed base, gets it right.
 *  - `tests`/`failures`/`skipped` come from the run's counters rather than from
 *    the cases present, so a caller holding one shard's results still describes
 *    the whole run.
 *
 * The ONE deliberate difference from the route is documented on XML_ILLEGAL.
 */

import type { Reporter, ReportedTest, ReporterDocument, ReporterFile, RunReport } from './types.js';
import { durationOf, suiteNameOf, totalsOf } from './types.js';

/** Exactly the route's map, applied in exactly its single pass. */
const ENTITIES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * The characters XML 1.0 forbids outright: C0 controls other than tab, LF and
 * CR. Deliberately NOT the 0x7F–0x9F range, which XML 1.0 permits — stripping
 * those would change the bytes of documents that parse fine today.
 *
 * This is the one place this reporter can differ from the API route, and the
 * case is narrow enough to be worth it. A test name carrying a raw NUL or a
 * stray 0x1B — a generated name, a fuzzed input, a truncated buffer — produces
 * a document NO XML parser will accept, and there is no escape available:
 * `&#x0;` is illegal too. The only two options are "drop them" and "hand the CI
 * a file it cannot read". Dropping changes bytes only for a document that was
 * already unparseable, which is what makes it allowed to change bytes at all,
 * and the caller is told in `warnings` rather than left to wonder.
 */
// eslint-disable-next-line no-control-regex -- the illegal set is defined by codepoint.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function escapeXml(value: string): string {
  return value.replace(XML_ILLEGAL, '').replace(/[<>&"']/g, (c) => ENTITIES[c]!);
}

function hasIllegal(value: string): boolean {
  // `test` on a /g regex is stateful; a fresh literal per call avoids the
  // every-other-call-lies bug that pattern is famous for.
  // eslint-disable-next-line no-control-regex -- same illegal set as above.
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
}

/** ` time="3.500"`, or nothing at all when the run never timed the test. */
function timeAttr(test: ReportedTest): string {
  const ms = durationOf(test);
  // Absent, not zero: a dashboard reading 0.000 for every test believes it.
  return ms === undefined ? '' : ` time="${(ms / 1000).toFixed(3)}"`;
}

function renderCase(test: ReportedTest): string {
  const name = escapeXml(test.name);
  const time = timeAttr(test);
  if (test.status === 'passed') return `    <testcase name="${name}"${time}/>`;
  if (test.status === 'skipped') return `    <testcase name="${name}"${time}><skipped/></testcase>`;
  return `    <testcase name="${name}"${time}><failure message="${escapeXml(
    test.message ?? 'failed',
  )}"/></testcase>`;
}

export function renderJUnitXml(report: RunReport): string {
  const totals = totalsOf(report);
  const cases = report.tests.map(renderCase).join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${escapeXml(
      suiteNameOf(report),
    )}" tests="${totals.tests}" failures="${totals.failed}" skipped="${totals.skipped}">\n` +
    `${cases}\n  </testsuite>\n</testsuites>\n`
  );
}

export const junitReporter: Reporter = {
  name: 'junit',
  description: 'JUnit XML — read natively by GitHub Actions, GitLab, Jenkins and CircleCI',
  defaultOut: 'junit.xml',
  directory: false,

  render(report: RunReport): ReporterDocument {
    const warnings: string[] = [];

    const mangled = report.tests.filter((t) => hasIllegal(t.name) || hasIllegal(t.message ?? ''));
    if (mangled.length > 0) {
      warnings.push(
        `${mangled.length} test name(s) or message(s) contained control characters XML 1.0 cannot ` +
          `represent; they were removed so the file stays parseable (first: ${JSON.stringify(mangled[0]!.name)}).`,
      );
    }

    const untimed = report.tests.filter((t) => durationOf(t) === undefined).length;
    if (untimed > 0) {
      warnings.push(
        `${untimed} of ${report.tests.length} test(s) carry no timing; their <testcase> has no time attribute rather than a fabricated 0.000.`,
      );
    }

    const file: ReporterFile = {
      path: 'junit.xml',
      contents: renderJUnitXml(report),
      contentType: 'application/xml',
    };
    return { files: [file], warnings };
  },
};
