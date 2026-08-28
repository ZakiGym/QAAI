/**
 * TestRail — not a file format at all, but an API upload keyed on case ids.
 *
 * `POST /index.php?/api/v2/add_results_for_cases/{run_id}` with
 * `{ results: [{ case_id, status_id, comment?, elapsed? }] }`, authenticated
 * with HTTP Basic (email + API key). The reporter builds that body and nothing
 * else: no host, no credential, no network. The caller supplies all three,
 * which is what keeps this file testable and keeps a TestRail API key out of
 * every fixture and every serialised document.
 *
 * ── The three places TestRail refuses what a run actually holds ──────────────
 *
 * 1. **Case ids.** TestRail results attach to CASES, not to test names. QAAI
 *    tests do not carry a TestRail case id, so the only honest source is the
 *    `C1234` convention teams already write into the test title. A test with no
 *    case id is LEFT OUT of the upload and named in `warnings` — silently
 *    dropping it would under-report a failing suite, and inventing an id would
 *    stamp a result onto somebody else's case.
 *
 * 2. **`elapsed` cannot be zero.** TestRail rejects `0s` outright ("Field
 *    :elapsed is not a valid time span"), and its granularity is whole seconds.
 *    So `elapsed` is omitted for an untimed test AND for anything under a
 *    second, rather than rounded to a lie. That is the honesty rule this wave
 *    is built on, enforced by an API that happens to agree.
 *
 * 3. **There is no "skipped".** `status_id` 3 is Untested, and TestRail
 *    explicitly refuses to let `add_results` write it — a case is untested
 *    until something tests it. Skipped tests are therefore omitted, which
 *    leaves the case with whatever status it already had. Mapping them to
 *    Blocked (2) is the common shortcut and it is wrong: "blocked" is a claim
 *    about why a test could not run, and a skipped test in QAAI may simply not
 *    have been selected.
 *
 * A FLAKY result is Passed with a comment saying it needed a retry. It did pass
 * — filing it as Retest would leave a release checklist showing a case that
 * never went green, which is the more expensive wrong answer.
 */

import type {
  Reporter,
  ReportedTest,
  ReporterDocument,
  ReporterOptions,
  ReporterStatus,
  RunReport,
} from './types.js';
import { durationOf, fullNameOf } from './types.js';

/** TestRail's built-in system statuses. 3 (Untested) is deliberately absent. */
export const TESTRAIL_STATUS = { passed: 1, blocked: 2, retest: 4, failed: 5 } as const;

export interface TestRailResult {
  case_id: number;
  status_id: number;
  comment?: string;
  elapsed?: string;
}

export interface TestRailPayload {
  results: TestRailResult[];
}

/**
 * `C1234` anywhere in the suite or the test name.
 *
 * A fixed pattern, never one built from user input — this codebase does not
 * compile regexes from strings it was handed. The bound on the digits is there
 * so a name containing `C` followed by a paragraph of numbers cannot turn into
 * a case id nobody meant.
 */
const CASE_ID = /\bC(\d{1,9})\b/g;

export function caseIdsFor(test: ReportedTest): number[] {
  if (test.caseIds && test.caseIds.length > 0) {
    return [...new Set(test.caseIds.filter((n) => Number.isInteger(n) && n > 0))];
  }
  const found = new Set<number>();
  for (const source of [test.suite ?? '', test.name]) {
    for (const match of source.matchAll(CASE_ID)) {
      const id = Number(match[1]);
      if (Number.isInteger(id) && id > 0) found.add(id);
    }
  }
  return [...found];
}

const STATUS: Record<ReporterStatus, number | null> = {
  passed: TESTRAIL_STATUS.passed,
  failed: TESTRAIL_STATUS.failed,
  // A timeout is a failure of the case; TestRail has no finer word for it, and
  // the comment carries the distinction.
  timedOut: TESTRAIL_STATUS.failed,
  flaky: TESTRAIL_STATUS.passed,
  // See the header: not representable, so not sent.
  skipped: null,
};

/** `elapsed` only when there is a whole second to report. */
export function elapsedFor(test: ReportedTest): string | undefined {
  const ms = durationOf(test);
  if (ms === undefined) return undefined;
  const seconds = Math.round(ms / 1000);
  return seconds > 0 ? `${seconds}s` : undefined;
}

function commentFor(test: ReportedTest): string | undefined {
  const lines: string[] = [];
  if (test.status === 'flaky') lines.push('Passed on retry — QAAI recorded this test as flaky.');
  if (test.status === 'timedOut') lines.push('Timed out.');
  if (test.message) lines.push(test.message);
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

/** Only the two things a name needs: readable, and short enough for the field. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export const testrailReporter: Reporter = {
  name: 'testrail',
  description: 'TestRail results upload, keyed on C1234 case ids in the test name',
  defaultOut: 'testrail-results.json',
  directory: false,

  render(report: RunReport, options?: ReporterOptions): ReporterDocument {
    const warnings: string[] = [];
    const results: TestRailResult[] = [];
    const unmapped: string[] = [];
    const skipped: string[] = [];
    let untimed = 0;

    for (const test of report.tests) {
      const statusId = STATUS[test.status];
      if (statusId === null) {
        skipped.push(fullNameOf(test));
        continue;
      }

      const caseIds = caseIdsFor(test);
      if (caseIds.length === 0) {
        unmapped.push(fullNameOf(test));
        continue;
      }

      const elapsed = elapsedFor(test);
      if (elapsed === undefined) untimed += 1;
      const comment = commentFor(test);

      for (const caseId of caseIds) {
        const result: TestRailResult = { case_id: caseId, status_id: statusId };
        if (comment) result.comment = truncate(comment, 4000);
        if (elapsed) result.elapsed = elapsed;
        results.push(result);
      }
    }

    if (unmapped.length > 0) {
      warnings.push(
        `${unmapped.length} test(s) carry no TestRail case id and were not uploaded — TestRail keys results on cases, and there is nothing in the run to key on. ` +
          `Put the id in the test name as C1234. Not uploaded: ${truncate(unmapped.slice(0, 5).join(', '), 300)}${unmapped.length > 5 ? `, and ${unmapped.length - 5} more` : ''}.`,
      );
    }
    if (skipped.length > 0) {
      warnings.push(
        `${skipped.length} skipped test(s) were left out: TestRail's Untested status cannot be written through add_results, so their cases keep the status they already had.`,
      );
    }
    if (untimed > 0) {
      warnings.push(
        `${untimed} result(s) were sent without an elapsed time — the run had no duration for them, or it was under a second, and TestRail rejects an elapsed of 0.`,
      );
    }

    const payload: TestRailPayload = { results };
    const files = [
      {
        path: 'testrail-results.json',
        contents: JSON.stringify(payload, null, 2) + '\n',
        contentType: 'application/json',
      },
    ];

    // Fail closed twice over: no run id and no results are each a reason to
    // produce a document with nothing to send, rather than a request that would
    // stamp results onto an unrelated TestRail run or upload an empty list and
    // report success.
    const runId = options?.testRailRunId;
    if (runId === undefined) {
      warnings.push(
        'No TestRail run id, so nothing can be uploaded: results attach to a run. Pass --testrail-run <id> or set TESTRAIL_RUN_ID.',
      );
      return { files, warnings };
    }
    if (results.length === 0) {
      warnings.push('Nothing to upload: no test in this run mapped to a TestRail case.');
      return { files, warnings };
    }

    return {
      files,
      warnings,
      upload: {
        service: 'testrail',
        method: 'POST',
        path: `/index.php?/api/v2/add_results_for_cases/${runId}`,
        body: payload,
        summary: `${results.length} result(s) to TestRail run ${runId}`,
      },
    };
  },
};
