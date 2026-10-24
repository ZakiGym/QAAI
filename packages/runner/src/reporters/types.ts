/**
 * The reporter interface: a finished run goes in, a document comes out.
 *
 * This is the mirror image of `../reports/`. That directory READS what other
 * people's tools wrote; this one WRITES what other people's dashboards read. A
 * QA platform that cannot put its results where the team already looks is a
 * second place to look, and loses.
 *
 * Two rules shape every type here, and both exist because a reporting bug is
 * uniquely expensive — it is believed.
 *
 * 1. **A reporter does no I/O.** It returns `ReporterFile[]` (and, for a
 *    service upload, a described request) and the caller writes or sends them.
 *    A reporter that opens a file handle is a reporter that can only be tested
 *    against a filesystem, which in practice means it is tested once and then
 *    never again. Everything in this directory is pure and synchronous.
 *
 * 2. **A missing field is absent, never zero.** `durationMs` is optional and
 *    the reporters omit the output field entirely when it is not set. A
 *    dashboard showing 0 ms for every test is worse than one showing nothing:
 *    the first is a wrong answer, the second is a visible gap. The same rule
 *    covers start/stop timestamps and TestRail's `elapsed`, which the API
 *    rejects outright when it is zero.
 *
 * Credentials are deliberately not modelled. A reporter describes the request
 * it wants made; the caller attaches the secret at send time. That keeps the
 * pure part testable without a vault and keeps a token out of anything that
 * gets serialised into a document.
 */

/**
 * Statuses as the platform records them, normalised to lower camel.
 *
 * `flaky` and `timedOut` are kept distinct rather than folded into pass/fail
 * because the formats disagree about them, and the disagreement is the whole
 * point of having three reporters: JUnit has no vocabulary for a flake, Allure
 * has a first-class `flaky` marker, and TestRail wants a human-readable comment.
 * Collapsing them here would make all three wrong in the same way.
 *
 * ── `quarantined`, and why it is a status rather than a flag ─────────────────
 *
 * A quarantined test that failed is a FOURTH thing, exactly as
 * `Run.quarantinedFailedCount` is a fourth counter (see
 * packages/runner/src/gates.ts). Before it existed, every reporter here filed
 * such a test as `failed`, so the one output a team reads in their own
 * dashboard went red over a failure the gate had already agreed to ignore:
 * quarantine released the merge and left the dashboard broken, which is the
 * mirror image of the original defect and just as useless.
 *
 * It is a STATUS and not a `quarantined?: boolean` beside the status because
 * every reporter has to make a positive decision about it — Allure mutes it,
 * TestRail files it as Retest, JUnit renders it `<skipped>` with a message that
 * says it failed — and a boolean that each format may or may not consult is how
 * one of them quietly keeps calling it a plain failure. The cost is real and
 * worth naming: FAILED and TIMED_OUT both collapse into `quarantined`, so the
 * reporters cannot say which it was. None of the three formats has a word for
 * "suppressed timeout" anyway, and all three carry the original message.
 *
 * The rule every format below obeys, and the only one that matters: a
 * suppressed failure must NOT read as a pass, and must NOT read as a plain
 * skip. Those are the two ways a team finds out in production that nothing has
 * been tested for a month.
 */
export type ReporterStatus = 'passed' | 'failed' | 'skipped' | 'flaky' | 'timedOut' | 'quarantined';

/**
 * The sentence every format uses, verbatim, for a suppressed failure.
 *
 * One string so the three reporters cannot disagree about what quarantine
 * means, and so the CLI's mirror (packages/cli/src/report.ts) has something
 * exact to be byte-identical to. Transcribed from
 * `GET /runs/:runId/junit.xml` in apps/api/src/routes/runs.ts, which is the
 * shipped writer of the one output machines nobody here controls already parse.
 *
 * TODO(shared-types): this and `ReporterStatus` belong in
 * packages/shared/src/types.ts next to `TestResultStatus`, so the API, the
 * worker and both reporter implementations draw the wording from one place.
 * That file is another agent's this wave — see the report.
 */
export const QUARANTINE_NOTE =
  'QUARANTINED FAILURE — this test FAILED and its failure is suppressed by quarantine, ' +
  'so it did not fail the build. It is not a skipped test: it ran, and it failed.';

/** One executed test, as the run recorded it. */
export interface ReportedTest {
  name: string;
  status: ReporterStatus;
  /** The platform's stable test id. Used as Allure's `historyId` when present. */
  id?: string;
  /** Grouping — suite name or spec file. Absent when the run has no grouping. */
  suite?: string;
  /** Wall clock. ABSENT when the run recorded no timing; never defaulted to 0. */
  durationMs?: number;
  /** Epoch ms. Absent unless the run actually stamped them. */
  startedAt?: number;
  finishedAt?: number;
  /** The failure text, not the stack. Absent on a test that did not fail. */
  message?: string;
  stack?: string;
  /**
   * TestRail case ids, when something upstream already knows them. Left absent
   * by the platform today, which is why the TestRail reporter falls back to the
   * `C1234` convention in the test name and says so when it finds nothing.
   */
  caseIds?: number[];
}

/**
 * The run's own counters.
 *
 * Carried rather than derived because the platform's counters are the source of
 * truth for a sharded run: the caller may hold only its own slice of results
 * while `totalCount` covers the whole run. `derivedTotals` fills these in when
 * the caller genuinely has everything, and mirrors the worker's own arithmetic
 * (apps/worker/src/processors/run.ts) — TIMED_OUT counts as a failure, FLAKY
 * counts as neither a pass nor a failure.
 */
export interface RunTotals {
  tests: number;
  passed: number;
  /** Failures that GATE. A suppressed failure is not one of these. */
  failed: number;
  skipped: number;
  flaky: number;
  /**
   * Failures a quarantine in force suppressed — `Run.quarantinedFailedCount`.
   *
   * A FOURTH number, deliberately not a slice of `failed` and deliberately not
   * folded into `skipped`: a deliberate skip and a failure somebody switched
   * off are different facts (see packages/runner/src/gates.ts). Optional only
   * because a caller holding a run finalised by an older worker genuinely does
   * not have it; absent means "not measured", never zero. The JUnit reporter,
   * which is the only reader of `RunTotals`, says what it does when it is
   * missing.
   */
  quarantinedFailed?: number;
}

/** A finished run, in the only shape the reporters read. */
export interface RunReport {
  /** The platform run id. Used to make per-run-unique ids deterministic. */
  id?: string;
  /** Suite name for the document. Defaults to `qaai`, which is what CI parses today. */
  name?: string;
  startedAt?: number;
  finishedAt?: number;
  commitSha?: string;
  branch?: string;
  environment?: string;
  /** Link back to the run in the app. Emitted by Allure; never invented. */
  url?: string;
  totals?: RunTotals;
  tests: ReportedTest[];
}

/** One file of the document, with a path relative to the output root. */
export interface ReporterFile {
  path: string;
  contents: string;
  contentType: string;
}

/**
 * A request the caller should make on the reporter's behalf.
 *
 * `path` is relative to a host the CALLER holds, and there is no field for a
 * credential anywhere in this type. Both are deliberate: a reporter that took a
 * host would be a reporter that could be pointed at an attacker's server by
 * whatever produced the run, and a reporter that took an API key would be a
 * reporter whose test fixtures contain one.
 */
export interface ReporterUpload {
  service: 'testrail';
  method: 'POST';
  path: string;
  body: unknown;
  /** One line describing the effect, for a dry-run or a confirmation prompt. */
  summary: string;
}

export interface ReporterDocument {
  files: ReporterFile[];
  /**
   * What the run could not honestly supply — a test with no TestRail case id, a
   * name XML cannot carry. Never a reason to fail, always a reason to print:
   * the alternative is a file that looks complete and is not.
   */
  warnings: string[];
  upload?: ReporterUpload;
}

export interface ReporterOptions {
  /** The TestRail run to post results into. Not a secret; the API key is. */
  testRailRunId?: number;
}

export interface Reporter {
  name: string;
  /** One line for `--help`. */
  description: string;
  /** Where the document goes when the user names no path. */
  defaultOut: string;
  /** True when the output root is a directory (Allure) rather than one file. */
  directory: boolean;
  render(report: RunReport, options?: ReporterOptions): ReporterDocument;
}

/**
 * Totals from the results in hand.
 *
 * Only correct when the caller holds every result of the run, which is why the
 * reporters prefer `report.totals` and fall back to this.
 */
export function derivedTotals(tests: readonly ReportedTest[]): RunTotals {
  const count = (s: ReporterStatus): number => tests.filter((t) => t.status === s).length;
  return {
    tests: tests.length,
    passed: count('passed'),
    // A timeout is a failure of the test, and the worker counts it as one.
    failed: count('failed') + count('timedOut'),
    skipped: count('skipped'),
    flaky: count('flaky'),
    /*
     * Its own column, so the five numbers still add up to `tests`:
     * `passed + failed + flaky + skipped + quarantinedFailed === tests`, which
     * is the invariant `tallyResult` maintains in gates.ts. Adding it to
     * `failed` is the defect this wave closes; adding it to `skipped` is the
     * same defect wearing a kinder word.
     */
    quarantinedFailed: count('quarantined'),
  };
}

export function totalsOf(report: RunReport): RunTotals {
  return report.totals ?? derivedTotals(report.tests);
}

/** The run's own name for itself, or the name every existing CI parser expects. */
export function suiteNameOf(report: RunReport): string {
  const name = report.name?.trim();
  return name ? name : 'qaai';
}

/**
 * A duration only when the run actually has one.
 *
 * Rejects the non-finite and the negative as well as the absent, because the
 * one thing a reporter must never do is turn a broken number into a plausible
 * one. Zero is kept: a test really can finish inside a millisecond, and the
 * formats that cannot express that (TestRail's `elapsed`) drop it themselves.
 */
export function durationOf(test: ReportedTest): number | undefined {
  const ms = test.durationMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  return ms;
}

/** `Suite > name`, or just the name when the run has no grouping. */
export function fullNameOf(test: ReportedTest): string {
  const suite = test.suite?.trim();
  return suite ? `${suite} > ${test.name}` : test.name;
}
