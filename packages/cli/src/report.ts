/**
 * `--reporter` — put a finished run into the tools the team already uses.
 *
 * A QA platform that cannot write into Allure or TestRail is a second place to
 * look, and a second place to look is a place people stop looking. This module
 * is the CLI half of that: it turns the run the API returns into the reporter
 * model, renders the formats, writes the files, and — for TestRail, which is an
 * API rather than a file format — makes the upload.
 *
 * ── Why the formats are implemented twice, and how that is kept safe ─────────
 *
 * The canonical reporters live in `packages/runner/src/reporters/`. This file
 * cannot import them, and the reason is a hard constraint on the published CLI
 * rather than an oversight: `tsconfig.build.json` compiles `src/` with
 * `rootDir: src` and the package ships only `dist/`, so ANY import that reaches
 * outside this directory — even a type-only one — fails the build with TS6059,
 * and would in any case be absent from the tarball a customer installs. The
 * CLI's zero-dependency promise (see index.ts) is what makes `npx @qaai/cli`
 * viable in a CI step that has just exported an API key, and it is not worth
 * trading for tidier imports.
 *
 * So the renderers below are a deliberate mirror. What keeps them from drifting
 * is `report.test.ts`, which imports BOTH implementations — it is a test file,
 * excluded from the build, so it may cross the package boundary — and asserts
 * they produce byte-identical documents for every fixture. Change one without
 * the other and that test goes red.
 *
 * JUnit is the exception, and deliberately: `--reporter junit` fetches
 * `GET /runs/:id/junit.xml`, the same bytes `--junit` has always written. There
 * is exactly one writer of that XML in the CLI's path — the server's — because
 * those bytes are parsed by builds that already exist.
 *
 * The right end state is an API route that serves any format from the runner
 * reporters, at which point everything below except the flag parsing, the file
 * writing and the TestRail upload deletes itself.
 *
 * ── The rule every renderer here obeys ───────────────────────────────────────
 *
 * A missing measurement is ABSENT, never zero. A run with no timing produces an
 * Allure result with no `start`/`stop` and a TestRail result with no `elapsed`,
 * not a document full of confident zeroes. TestRail happens to agree — it
 * rejects an elapsed of 0 outright.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

// ─── The model, mirrored from packages/runner/src/reporters/types.ts ─────────

export type ReporterStatus = 'passed' | 'failed' | 'skipped' | 'flaky' | 'timedOut';

export interface ReportedTest {
  name: string;
  status: ReporterStatus;
  id?: string;
  suite?: string;
  /** ABSENT when the run recorded no timing. Never defaulted to 0. */
  durationMs?: number;
  startedAt?: number;
  finishedAt?: number;
  message?: string;
  stack?: string;
  caseIds?: number[];
}

export interface RunTotals {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
}

export interface RunReport {
  id?: string;
  name?: string;
  startedAt?: number;
  finishedAt?: number;
  commitSha?: string;
  branch?: string;
  environment?: string;
  url?: string;
  totals?: RunTotals;
  tests: ReportedTest[];
}

export interface ReporterFile {
  path: string;
  contents: string;
  contentType: string;
}

export interface ReporterDocument {
  files: ReporterFile[];
  warnings: string[];
  upload?: { service: 'testrail'; method: 'POST'; path: string; body: unknown; summary: string };
}

/** A message already fit to print; index.ts prints it without a stack. */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

// ─── Flags ───────────────────────────────────────────────────────────────────

export interface ReporterRequest {
  name: string;
  /** null means "the reporter's default", which for TestRail is no file at all. */
  out: string | null;
}

export const REPORTER_NAMES = ['junit', 'allure', 'testrail'] as const;

/**
 * `--reporter <name> [--reporter-out <path>]`, repeatable.
 *
 * Parsed from raw argv rather than through index.ts's `parseFlags`, because
 * that collapses a repeated flag to its last value and the whole point here is
 * that a CI step wants Allure AND TestRail from one run. A `--reporter-out`
 * binds to the `--reporter` before it, which is the only reading that stays
 * unambiguous once there is more than one.
 *
 * Refuses an unknown name up front. This runs BEFORE the suite is queued, so a
 * typo costs a second rather than a ten-minute run whose results go nowhere.
 */
export function parseReporterArgs(args: string[]): ReporterRequest[] {
  const requests: ReporterRequest[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--reporter') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new ReportError(`--reporter needs a name: ${REPORTER_NAMES.join(', ')}.`);
      }
      for (const raw of value.split(',')) {
        const name = raw.trim().toLowerCase();
        if (!name) continue;
        if (!(REPORTER_NAMES as readonly string[]).includes(name)) {
          throw new ReportError(
            `Unknown reporter '${raw.trim()}'. Available: ${REPORTER_NAMES.join(', ')}.`,
          );
        }
        requests.push({ name, out: null });
      }
      continue;
    }

    if (arg === '--reporter-out') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new ReportError('--reporter-out needs a path.');
      }
      const last = requests[requests.length - 1];
      if (!last) {
        throw new ReportError('--reporter-out must follow a --reporter it belongs to.');
      }
      last.out = value;
    }
  }

  return requests;
}

/** The TestRail run to post into. Not a secret, so a flag is fine; the key is not. */
export function readTestRailRunId(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
): number | undefined {
  const raw =
    typeof flags['testrail-run'] === 'string' ? flags['testrail-run'] : env.TESTRAIL_RUN_ID;
  if (raw === undefined || raw.trim() === '') return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ReportError(`--testrail-run must be a positive integer, got '${raw}'.`);
  }
  return id;
}

// ─── The API run → the reporter model ────────────────────────────────────────

/** Only the fields this mapping reads; the endpoint returns a great deal more. */
export interface ApiRunPayload {
  id?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  commitSha?: string | null;
  branch?: string | null;
  totalCount?: number;
  passedCount?: number;
  failedCount?: number;
  flakyCount?: number;
  skippedCount?: number;
  environment?: { name?: string | null } | null;
  results?: Array<{
    status?: string;
    durationMs?: number;
    errorMessage?: string | null;
    createdAt?: string | null;
    test?: { id?: string; name?: string; filePath?: string | null } | null;
  }> | null;
}

const STATUS_FROM_API: Record<string, ReporterStatus> = {
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  FLAKY: 'flaky',
  TIMED_OUT: 'timedOut',
};

function epoch(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Map `GET /runs/:runId` onto the reporter model.
 *
 * Two judgement calls, both in the direction of not inventing anything:
 *
 *  - `durationMs` is an `Int @default(0)` column, so a skipped test — one that
 *    never executed — arrives as a confident zero. It is dropped here. A
 *    skipped test has no duration; carrying the zero forward would put `0ms`
 *    into an Allure report as though something had been measured.
 *  - There is no per-test start stamp in the schema, but there IS `createdAt`
 *    on the result row, written by the worker immediately after the test
 *    finishes. It is used as `finishedAt` — accurate to the write latency, and
 *    real, which the alternatives (the run's own start for every test, or
 *    nothing at all) are not. Allure derives `start` from it and the duration.
 */
export function runReportFromApi(run: ApiRunPayload, options: { url?: string } = {}): RunReport {
  const tests: ReportedTest[] = (run.results ?? []).map((result) => {
    const status = STATUS_FROM_API[String(result.status ?? '')] ?? 'failed';
    const raw = result.durationMs;
    const timed =
      typeof raw === 'number' &&
      Number.isFinite(raw) &&
      raw >= 0 &&
      !(raw === 0 && status === 'skipped');

    const test: ReportedTest = {
      name: result.test?.name ?? '(unnamed test)',
      status,
    };
    if (result.test?.id) test.id = result.test.id;
    if (result.test?.filePath) test.suite = result.test.filePath;
    if (timed) test.durationMs = raw;
    const finished = epoch(result.createdAt);
    if (finished !== undefined) test.finishedAt = finished;
    if (result.errorMessage) test.message = result.errorMessage;
    return test;
  });

  const report: RunReport = { tests };
  if (run.id) report.id = run.id;
  if (run.commitSha) report.commitSha = run.commitSha;
  if (run.branch) report.branch = run.branch;
  if (run.environment?.name) report.environment = run.environment.name;
  if (options.url) report.url = options.url;

  const started = epoch(run.startedAt);
  const finished = epoch(run.finishedAt);
  if (started !== undefined) report.startedAt = started;
  if (finished !== undefined) report.finishedAt = finished;

  // The run's own counters, which are the truth for a sharded run. Only taken
  // when they are all there; a half-populated totals block is worse than none.
  if (
    typeof run.totalCount === 'number' &&
    typeof run.passedCount === 'number' &&
    typeof run.failedCount === 'number' &&
    typeof run.skippedCount === 'number' &&
    typeof run.flakyCount === 'number'
  ) {
    report.totals = {
      tests: run.totalCount,
      passed: run.passedCount,
      failed: run.failedCount,
      skipped: run.skippedCount,
      flaky: run.flakyCount,
    };
  }

  return report;
}

// ─── Allure (mirror of packages/runner/src/reporters/allure.ts) ──────────────

function durationOf(test: ReportedTest): number | undefined {
  const ms = test.durationMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  return ms;
}

function fullNameOf(test: ReportedTest): string {
  const suite = test.suite?.trim();
  return suite ? `${suite} > ${test.name}` : test.name;
}

function stableId(...parts: string[]): string {
  const hex = createHash('sha1').update(parts.join(' ')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const ALLURE_STATUS: Record<ReporterStatus, string> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  flaky: 'passed',
  timedOut: 'broken',
};

function allureWindow(test: ReportedTest): { start?: number; stop?: number } {
  const started = typeof test.startedAt === 'number' ? test.startedAt : undefined;
  const finished = typeof test.finishedAt === 'number' ? test.finishedAt : undefined;
  if (started !== undefined && finished !== undefined) return { start: started, stop: finished };
  const ms = durationOf(test);
  if (started !== undefined && ms !== undefined) return { start: started, stop: started + ms };
  if (started !== undefined) return { start: started };
  if (finished !== undefined && ms !== undefined) return { start: finished - ms, stop: finished };
  if (finished !== undefined) return { stop: finished };
  return {};
}

export function renderAllure(report: RunReport): ReporterDocument {
  const warnings: string[] = [];
  const files: ReporterFile[] = report.tests.map((test, index) => {
    const fullName = fullNameOf(test);
    const { start, stop } = allureWindow(test);

    const labels: Array<{ name: string; value: string }> = [{ name: 'framework', value: 'qaai' }];
    if (test.suite?.trim()) labels.push({ name: 'suite', value: test.suite.trim() });
    if (report.environment?.trim())
      labels.push({ name: 'parentSuite', value: report.environment.trim() });
    if (report.branch?.trim()) labels.push({ name: 'tag', value: report.branch.trim() });
    if (test.status === 'flaky') labels.push({ name: 'tag', value: 'flaky' });

    const details: { message?: string; trace?: string; flaky?: boolean } = {};
    if (test.message) details.message = test.message;
    if (test.stack) details.trace = test.stack;
    if (test.status === 'flaky') details.flaky = true;

    const result: Record<string, unknown> = {
      uuid: stableId(report.id ?? '', test.id ?? '', fullName, String(index)),
      historyId: test.id ?? stableId(fullName),
      name: test.name,
      fullName,
      status: ALLURE_STATUS[test.status],
      stage: 'finished',
      labels,
    };
    if (Object.keys(details).length > 0) result.statusDetails = details;
    if (start !== undefined) result.start = start;
    if (stop !== undefined) result.stop = stop;
    if (report.url) result.links = [{ name: 'Run in QAAI', url: report.url, type: 'custom' }];

    return {
      path: `${String(result.uuid)}-result.json`,
      contents: JSON.stringify(orderAllure(result), null, 2) + '\n',
      contentType: 'application/json',
    };
  });

  if (report.url) {
    files.push({
      path: 'executor.json',
      contents:
        JSON.stringify(
          {
            name: 'QAAI',
            type: 'qaai',
            reportUrl: report.url,
            ...(report.id ? { buildName: `run ${report.id}` } : {}),
          },
          null,
          2,
        ) + '\n',
      contentType: 'application/json',
    });
  } else {
    warnings.push(
      'No executor.json: the run carries no URL, and a link back to a report that may not exist is worse than no link.',
    );
  }

  const rows: Array<[string, string]> = [];
  if (report.environment?.trim()) rows.push(['environment', report.environment.trim()]);
  if (report.branch?.trim()) rows.push(['branch', report.branch.trim()]);
  if (report.commitSha?.trim()) rows.push(['commit', report.commitSha.trim()]);
  if (report.id?.trim()) rows.push(['qaai.run', report.id.trim()]);
  if (rows.length > 0) {
    files.push({
      path: 'environment.properties',
      contents: rows.map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, ' ')}`).join('\n') + '\n',
      contentType: 'text/plain',
    });
  }

  const untimed = report.tests.filter(
    (t) => durationOf(t) === undefined && t.startedAt === undefined && t.finishedAt === undefined,
  ).length;
  if (untimed > 0) {
    warnings.push(
      `${untimed} of ${report.tests.length} result(s) have no start/stop: the run recorded no timing for them, and Allure shows an unknown duration rather than 0ms.`,
    );
  }
  if (report.tests.length === 0) {
    warnings.push(
      'The run reported zero tests. The directory is written anyway so `allure generate` sees an empty report rather than a missing one.',
    );
  }

  return { files, warnings };
}

/**
 * JSON.stringify writes keys in insertion order, and the byte-for-byte parity
 * test against the runner reporter therefore depends on that order. Pinning it
 * here means the mirror cannot pass by accident when the two files build their
 * objects in different sequences.
 */
function orderAllure(result: Record<string, unknown>): Record<string, unknown> {
  const ORDER = [
    'uuid',
    'historyId',
    'name',
    'fullName',
    'status',
    'stage',
    'labels',
    'statusDetails',
    'start',
    'stop',
    'links',
  ];
  const ordered: Record<string, unknown> = {};
  for (const key of ORDER) if (key in result) ordered[key] = result[key];
  for (const key of Object.keys(result)) if (!(key in ordered)) ordered[key] = result[key];
  return ordered;
}

// ─── TestRail (mirror of packages/runner/src/reporters/testrail.ts) ──────────

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

const TESTRAIL_STATUS: Record<ReporterStatus, number | null> = {
  passed: 1,
  failed: 5,
  timedOut: 5,
  flaky: 1,
  skipped: null,
};

function elapsedFor(test: ReportedTest): string | undefined {
  const ms = durationOf(test);
  if (ms === undefined) return undefined;
  const seconds = Math.round(ms / 1000);
  return seconds > 0 ? `${seconds}s` : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function renderTestRail(report: RunReport, testRailRunId?: number): ReporterDocument {
  const warnings: string[] = [];
  const results: Array<{ case_id: number; status_id: number; comment?: string; elapsed?: string }> =
    [];
  const unmapped: string[] = [];
  const skipped: string[] = [];
  let untimed = 0;

  for (const test of report.tests) {
    const statusId = TESTRAIL_STATUS[test.status];
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

    const lines: string[] = [];
    if (test.status === 'flaky') lines.push('Passed on retry — QAAI recorded this test as flaky.');
    if (test.status === 'timedOut') lines.push('Timed out.');
    if (test.message) lines.push(test.message);
    const comment = lines.length > 0 ? lines.join('\n\n') : undefined;

    for (const caseId of caseIds) {
      const result: { case_id: number; status_id: number; comment?: string; elapsed?: string } = {
        case_id: caseId,
        status_id: statusId,
      };
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

  const payload = { results };
  const files: ReporterFile[] = [
    {
      path: 'testrail-results.json',
      contents: JSON.stringify(payload, null, 2) + '\n',
      contentType: 'application/json',
    },
  ];

  if (testRailRunId === undefined) {
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
      path: `/index.php?/api/v2/add_results_for_cases/${testRailRunId}`,
      body: payload,
      summary: `${results.length} result(s) to TestRail run ${testRailRunId}`,
    },
  };
}

// ─── TestRail credentials and upload ─────────────────────────────────────────

export interface TestRailCredentials {
  /** Scheme, host and port, validated once. Nothing else may name a host. */
  origin: string;
  user: string;
  apiKey: string;
}

/**
 * Validate the TestRail origin the operator configured, and never take a host
 * from anywhere else.
 *
 * The same discipline as `runner.ts`'s `pinEndpoint`, for the same reason: we
 * are about to attach an API key to a request. The trailing dot is stripped
 * before the check because `acme.testrail.io.` resolves identically and one
 * character quietly defeating a hostname guard is an SSRF this codebase has
 * already paid for once. Embedded credentials are refused — a token in a URL
 * ends up in `ps`, in logs and in shell history. Plain http is refused except
 * on loopback, where it cannot leave the machine.
 */
export function pinTestRailHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ReportError('TESTRAIL_HOST is empty.');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ReportError(
      `TESTRAIL_HOST is not a URL: '${trimmed}'. Use the form https://acme.testrail.io`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new ReportError(
      'TESTRAIL_HOST must not contain credentials. Put them in TESTRAIL_USER and TESTRAIL_API_KEY.',
    );
  }

  const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new ReportError(
      `TESTRAIL_HOST must be https (got '${parsed.protocol}//'). An API key over plain http leaves the machine in clear text.`,
    );
  }

  return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ''}`;
}

/**
 * Credentials come from the environment and ONLY from the environment.
 *
 * There is deliberately no `--testrail-key` flag. Anything in argv is in the
 * CI's own log, in `ps` on a shared build host, and in the shell history of
 * whoever ran it once by hand. The help text says this out loud so nobody has
 * to discover it.
 */
export function readTestRailCredentials(
  env: Record<string, string | undefined>,
): TestRailCredentials {
  const missing = (['TESTRAIL_HOST', 'TESTRAIL_USER', 'TESTRAIL_API_KEY'] as const).filter(
    (key) => !env[key]?.trim(),
  );
  if (missing.length > 0) {
    throw new ReportError(
      `TestRail needs ${missing.join(', ')} in the environment. Credentials are read from the environment on purpose — a flag would put your API key in the CI log and in \`ps\`.`,
    );
  }
  return {
    origin: pinTestRailHost(env.TESTRAIL_HOST!),
    user: env.TESTRAIL_USER!.trim(),
    apiKey: env.TESTRAIL_API_KEY!.trim(),
  };
}

/** Exported so a test can supply one without a network. */
export type ReportFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST the results. Redirects are refused rather than followed: a 3xx while
 * holding an API key is how the key walks out of the building.
 */
export async function uploadToTestRail(
  credentials: TestRailCredentials,
  upload: { path: string; body: unknown },
  fetchImpl: ReportFetch = fetch,
): Promise<void> {
  const auth = Buffer.from(`${credentials.user}:${credentials.apiKey}`, 'utf8').toString('base64');

  let response: Response;
  try {
    response = await fetchImpl(`${credentials.origin}${upload.path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify(upload.body),
    });
  } catch (err) {
    throw new ReportError(`TestRail upload failed: ${err instanceof Error ? err.message : err}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ReportError(
      `TestRail redirected the upload (${response.status}). Refusing to follow it while holding an API key — check TESTRAIL_HOST.`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 400);
    throw new ReportError(
      `TestRail rejected the upload (${response.status})${detail ? `: ${detail}` : ''}`,
    );
  }
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/**
 * A reporter's own filenames are joined to the user's output root, so they are
 * checked the same way the on-prem agent checks a server-supplied path: after
 * normalisation, not by looking for '..'. These names are ours today, which is
 * exactly when a guard is cheap to add.
 */
function safeJoin(root: string, name: string): string {
  if (isAbsolute(name)) throw new ReportError(`Reporter produced an absolute path: ${name}`);
  const target = resolve(root, normalize(name));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new ReportError(`Reporter produced a path outside the output directory: ${name}`);
  }
  return target;
}

export async function writeDocument(
  document: ReporterDocument,
  destination: { root: string; directory: boolean },
): Promise<string[]> {
  const written: string[] = [];

  if (destination.directory) {
    await mkdir(destination.root, { recursive: true });
    for (const file of document.files) {
      const target = safeJoin(destination.root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, 'utf8');
      written.push(target);
    }
    return written;
  }

  const first = document.files[0];
  if (!first) return written;
  const target = resolve(destination.root);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, first.contents, 'utf8');
  written.push(target);
  return written;
}

// ─── The command half ────────────────────────────────────────────────────────

export interface EmitContext {
  report: RunReport;
  requests: ReporterRequest[];
  env: Record<string, string | undefined>;
  testRailRunId?: number;
  /** Fetches the server-rendered JUnit XML. Supplied by index.ts. */
  fetchJunitXml: () => Promise<string>;
  fetchImpl?: ReportFetch;
}

export interface ReportOutcome {
  reporter: string;
  /** Where it landed, for a one-line summary: a path, a directory, or TestRail. */
  destination: string;
  files: string[];
  uploaded: string | null;
  warnings: string[];
}

export interface EmitResult {
  outcomes: ReportOutcome[];
  /** One printable sentence per reporter that could not publish. */
  failures: string[];
}

/**
 * Render, write and upload every requested reporter.
 *
 * Every reporter is attempted even when an earlier one fails, and both halves
 * come back: a broken TestRail credential should not stop the Allure directory
 * being written, and it should not stop the user being TOLD the Allure
 * directory was written. Failures are returned rather than thrown because the
 * caller has to fail the step AND report the successes, and an exception can
 * only carry one of those.
 *
 * What the caller must not do is ignore `failures`. Reporting that silently did
 * nothing is the failure mode this whole module exists to prevent, which is why
 * index.ts turns a non-empty list into a nonzero exit.
 */
export async function emitReports(context: EmitContext): Promise<EmitResult> {
  const outcomes: ReportOutcome[] = [];
  const failures: string[] = [];

  for (const request of context.requests) {
    try {
      outcomes.push(await emitOne(request, context));
    } catch (err) {
      failures.push(`${request.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { outcomes, failures };
}

/**
 * Warn, but do not delete.
 *
 * `allure generate` reads every `-result.json` in the directory, so results
 * left by an earlier run are silently merged into this one's report — two runs
 * shown as one, which is exactly the kind of quiet wrongness this whole module
 * is trying to avoid. The fix is still the operator's to make: `--reporter-out`
 * is a path the user typed, and a reporter that recursively deletes a directory
 * it was handed is one bad flag away from deleting something else.
 */
async function staleAllureResults(root: string): Promise<string[]> {
  const existing = await readdir(root).catch(() => [] as string[]);
  const results = existing.filter((name) => name.endsWith('-result.json'));
  if (results.length === 0) return [];
  return [
    `${root} already contains ${results.length} result file(s) from an earlier run. They are left alone, and \`allure generate\` will merge them into this report — clear the directory first if that is not what you want.`,
  ];
}

async function emitOne(request: ReporterRequest, context: EmitContext): Promise<ReportOutcome> {
  if (request.name === 'junit') {
    // The one format with an installed base: the server's bytes, unaltered.
    const xml = await context.fetchJunitXml();
    const root = request.out ?? 'junit.xml';
    const files = await writeDocument(
      {
        files: [{ path: 'junit.xml', contents: xml, contentType: 'application/xml' }],
        warnings: [],
      },
      { root, directory: false },
    );
    return { reporter: 'junit', destination: root, files, uploaded: null, warnings: [] };
  }

  if (request.name === 'allure') {
    const document = renderAllure(context.report);
    const root = request.out ?? 'allure-results';
    const stale = await staleAllureResults(root);
    const files = await writeDocument(document, { root, directory: true });
    return {
      reporter: 'allure',
      destination: `${files.length} file(s) in ${root}`,
      files,
      uploaded: null,
      warnings: [...document.warnings, ...stale],
    };
  }

  const document = renderTestRail(context.report, context.testRailRunId);
  // The payload file is written only when the user asked for a path: they may
  // want to inspect what would be sent, but nobody wants a stray JSON file in
  // the workspace of a CI step that only asked for an upload.
  const files = request.out
    ? await writeDocument(document, { root: request.out, directory: false })
    : [];

  if (!document.upload) {
    // Fail closed. Asking for a TestRail upload and getting a warning and a
    // zero exit is how a team discovers, weeks later, that nothing was ever
    // published.
    throw new ReportError(
      `nothing was uploaded. ${document.warnings.join(' ') || 'The run produced no uploadable results.'}`,
    );
  }

  const credentials = readTestRailCredentials(context.env);
  await uploadToTestRail(credentials, document.upload, context.fetchImpl);
  return {
    reporter: 'testrail',
    destination: document.upload.summary,
    files,
    uploaded: document.upload.summary,
    warnings: document.warnings,
  };
}
