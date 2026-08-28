/**
 * The reporter registry: one name in, one document out.
 *
 * Kept deliberately thin. Everything a caller needs to offer `--reporter` in a
 * CLI, a dropdown in the app, or a new API route is here — the names, the human
 * description for a help screen, whether the output is a file or a directory —
 * so none of that has to be restated at each call site and drift.
 *
 * `resolveReporter` returns null rather than throwing on an unknown name. The
 * caller is always in a better position to say what to do about it (a CLI wants
 * an exit code and a list of valid names; an API wants a 400), and a reporting
 * layer that throws is how a finished run turns into no results at all.
 */

import { allureReporter } from './allure.js';
import { junitReporter } from './junit.js';
import { testrailReporter } from './testrail.js';
import type { Reporter, ReporterDocument, ReporterOptions, RunReport } from './types.js';

export type {
  Reporter,
  ReportedTest,
  ReporterDocument,
  ReporterFile,
  ReporterOptions,
  ReporterStatus,
  ReporterUpload,
  RunReport,
  RunTotals,
} from './types.js';
export { derivedTotals, durationOf, fullNameOf, suiteNameOf, totalsOf } from './types.js';
export { escapeXml, junitReporter, renderJUnitXml } from './junit.js';
export { allureReporter, allureResultFor } from './allure.js';
export type { AllureResult, AllureStatus } from './allure.js';
export { caseIdsFor, elapsedFor, testrailReporter, TESTRAIL_STATUS } from './testrail.js';
export type { TestRailPayload, TestRailResult } from './testrail.js';

export const REPORTERS: readonly Reporter[] = [junitReporter, allureReporter, testrailReporter];

export const REPORTER_NAMES: readonly string[] = REPORTERS.map((r) => r.name);

export function resolveReporter(name: string): Reporter | null {
  const wanted = name.trim().toLowerCase();
  return REPORTERS.find((r) => r.name === wanted) ?? null;
}

/** Render by name. Null when no such reporter — see the note above about throwing. */
export function renderReport(
  name: string,
  report: RunReport,
  options?: ReporterOptions,
): ReporterDocument | null {
  return resolveReporter(name)?.render(report, options) ?? null;
}
