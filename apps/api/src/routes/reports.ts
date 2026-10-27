/**
 * `GET /runs/:runId/report` — the reporter registry's first caller.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * `packages/runner/src/reporters/` holds five finished, tested reporters behind
 * `REPORTERS`, `REPORTER_NAMES`, `resolveReporter` and `renderReport`. Nothing
 * outside those modules' own tests called any of the four. It has been a
 * library surface with no consumer since junit was written; the two reporters
 * the last round added merely made it visible. Correct code with no door is
 * indistinguishable from code that does not exist, and this route is the door.
 *
 * It is not reachable through the CLI either, and that is a hard constraint
 * rather than an oversight: `packages/cli/tsconfig.build.json` compiles `src/`
 * with `rootDir: src` and the package ships only `dist/`, so any import
 * reaching outside that directory fails with TS6059 and would be absent from
 * the tarball a customer installs. So the CLI MIRRORS the renderers, and
 * `packages/cli/src/report.test.ts` holds the two implementations
 * byte-identical. This route is the end state that header names — but the
 * mirror is NOT deleted here. Retiring it is a separate change with its own
 * blast radius, and `report.test.ts` is what currently holds the two halves
 * equal; deleting one side in the same round that adds this route would remove
 * the only thing proving they agree.
 *
 * ── ONE RENDERER, NOT A SIXTH IMPLEMENTATION ────────────────────────────────
 *
 * The bytes come from `renderReport(name, …)` and from nowhere else. The
 * descriptor (`resolveReporter`) is read for the one thing the document cannot
 * say about itself — whether its output is a file or a directory — and the
 * format list in the manifest and in every error comes from `REPORTER_NAMES`,
 * so a reporter added to the registry is offered here the same day without a
 * second edit. There is no `switch` on a format name anywhere below, and
 * adding one would reintroduce exactly the drift the registry exists to stop.
 *
 * ── THE TWO BEHAVIOURS THE MAPPING MUST NOT LOSE ────────────────────────────
 *
 * `runReportFrom` below is the server-side twin of `runReportFromApi` in
 * packages/cli/src/report.ts, and it carries both of that function's hard-won
 * behaviours, because a report that loses either is a report that lies:
 *
 *  1. A QUARANTINED FAILURE IS NEITHER A PASS NOR A PLAIN SKIP. A suppressed
 *     failure arriving as FAILED turned a dashboard red over a failure nobody
 *     could merge against; arriving as a pass is how a team learns in
 *     production that nothing has been tested for a month. It maps to the
 *     `quarantined` status, every reporter decides what that means in its own
 *     vocabulary, and `QUARANTINE_NOTE` travels verbatim.
 *
 *  2. A MISSING MEASUREMENT IS ABSENT, NEVER ZERO. `TestResult.durationMs` is
 *     an `Int @default(0)`, so a test that never executed arrives as a
 *     confident zero. It is dropped. A dashboard showing 0 ms for a skipped
 *     test is a wrong answer where nothing at all would have been a visible gap.
 *
 * ── A DIRECTORY CANNOT BE ONE HTTP BODY ─────────────────────────────────────
 *
 * Allure and the evidence pack render a TREE of files. Two representations,
 * decided from `reporter.directory` and never from a name:
 *
 *  · the document body — a single-file reporter is served as itself with its
 *    own content type; a directory reporter is served as a deterministic ZIP
 *    (lib/zip.ts, fixed timestamps) so re-exporting an unchanged run produces
 *    identical bytes.
 *  · `&meta=1` — the MANIFEST: the file list with real byte counts, the
 *    reporter's own `warnings`, and the upload descriptor if there is one.
 *    This is where a caller sees what the document could not honestly supply,
 *    because a reporter's warnings cannot go in HTTP headers without being
 *    mangled (they contain em dashes, and test names can contain anything at
 *    all including a raw NUL). The body path carries only the COUNT, in
 *    `x-qaai-report-warnings`, which is a count and so is honestly 0.
 *
 * A ZERO-FILE DOCUMENT IS A 501, NOT A 200. An empty `.sarif` reads as "no
 * findings" and an empty JUnit file reads as "nothing failed"; both are the one
 * answer this route may not give. Same for a reporter whose descriptor says
 * `directory: false` and whose render produced more than one file — serving the
 * first would drop the rest silently, which is a failure suppressed without
 * being counted. The manifest reports both cases truthfully instead of
 * refusing, because a manifest saying `files: []` next to the warnings is not a
 * document and cannot be mistaken for one.
 *
 * ── WHY TESTRAIL IS HERE, AND WHY IT IS NOT A 501 ───────────────────────────
 *
 * TestRail is an upload rather than a file format, which is a reason to be
 * careful and not a reason to omit it: `testrailReporter.render` returns a real
 * `testrail-results.json` with `directory: false`, so it is servable as bytes
 * exactly like the other four, and the thing a customer needs from us — the
 * payload, keyed on the C1234 case ids, with the quarantined results filed as
 * Retest — is in that file. What this route does NOT do is perform the upload.
 * It holds no TestRail credential and must not: a connector's credentials
 * belong on a model row the customer owns (the Integration pattern), never in
 * this process's environment. So the `upload` descriptor the reporter returns
 * is DISCLOSED in the manifest with `performed: false` and a sentence saying
 * who is expected to make the request. Answering 501 instead would be wrong in
 * the other direction: the format renders, and refusing it would hide a
 * document that exists.
 *
 * ── NO CAP, AND THAT IS THE DECISION ────────────────────────────────────────
 *
 * There is no `take` on the results read. A JUnit document covering 500 of a
 * run's 5,000 tests is a build reporting that 500 tests ran, which is the exact
 * lie this product exists to refuse — so completeness wins over the memory
 * cost, which is the same trade `GET /runs/:runId/junit.xml` already makes for
 * the same reason. The one cap that can bite is inside the sarif reporter
 * (`MAX_SARIF_RESULTS`), and it bites as a WARNING on the document, which the
 * manifest serves and the body path counts.
 */

import { Router } from 'express';
import { quarantineSuppresses, renderReport, resolveReporter, REPORTER_NAMES } from '@qaai/runner';
import type { ReporterDocument, ReporterOptions, ReporterStatus, RunReport } from '@qaai/runner';
import { prisma } from '../lib/prisma.js';
import { ApiError, badRequest, notFound } from '../lib/errors.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import { zipTree } from '../lib/zip.js';
import type { RepoTree } from '../lib/repo-export.js';
import { env } from '../env.js';

/**
 * `requireAuth` goes on the ROUTE and not on the router, which is the one thing
 * about this file that is about where it gets mounted.
 *
 * `/runs` already has a router: `runsRouter`, which does `runsRouter.use(
 * requireAuth)`. Two routers on the same prefix means every request that one
 * of them does not match falls through the other, and a router-level
 * `requireAuth` here would therefore re-authenticate every `/runs/...` request
 * the OTHER router owns — a second session or API-key lookup per request, on
 * the busiest prefix in the API. Declaring it per route (the shape
 * `routes/share.ts` already uses for `GET /runs/:runId/share`) means this
 * router is a no-op for any path it does not declare, so mount order costs
 * nothing either way. See the note on the route for which order to prefer.
 */
export const reportsRouter: Router = Router();

// ─── The registry, as a narrow injected interface ────────────────────────────

/**
 * Everything this route needs from `packages/runner/src/reporters/`.
 *
 * Narrow and injected for the reason every module in this repo takes its I/O
 * that way: the refusal branches below are reachable from a test with a fake
 * registry, and a guard no test can reach is a guard that is not there. A
 * reporter that renders no file at all is not something any of the five does
 * today — which is precisely why it cannot be proven against the real one.
 *
 * `render` returns `ReporterDocument | null`, mirroring `renderReport`: null
 * for a name the registry does not know. The 400 below catches that first, so a
 * null here means the registry changed between the resolve and the render, and
 * that is reported rather than turned into an empty body.
 */
export interface ReportRegistry {
  /** `REPORTER_NAMES` — the one list this route offers and names in errors. */
  names: readonly string[];
  resolve(
    name: string,
  ): { name: string; description: string; defaultOut: string; directory: boolean } | null;
  render(name: string, report: RunReport, options?: ReporterOptions): ReporterDocument | null;
}

/** The real thing. `resolveReporter` is the only place a name becomes an object. */
export const RUNNER_REGISTRY: ReportRegistry = {
  names: REPORTER_NAMES,
  resolve: (name) => resolveReporter(name),
  render: (name, report, options) => renderReport(name, report, options),
};

// ─── The run → the reporter model ────────────────────────────────────────────

/**
 * Only the columns the mapping reads, named here so the Prisma `select` below
 * and this type cannot drift apart.
 *
 * `environment` and `test` are typed nullable even though both relations are
 * required in the schema. A row whose parent has gone is a cascade race, not an
 * impossibility, and the alternative to handling it is a 500 on a report.
 */
export interface ReportRunRow {
  id: string;
  status: string;
  commitSha: string | null;
  branch: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  totalCount: number;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  skippedCount: number;
  quarantinedFailedCount: number;
  environment: { name: string } | null;
  results: ReadonlyArray<{
    status: string;
    durationMs: number;
    errorMessage: string | null;
    createdAt: Date | null;
    test: {
      id: string;
      name: string;
      filePath: string | null;
      quarantined: boolean;
      quarantineExpiresAt: Date | null;
    } | null;
  }>;
}

/**
 * `TestResultStatus` → the reporter vocabulary.
 *
 * An unrecognised status falls through to `failed`, not to `passed` and not to
 * `skipped`. A status this build has never heard of means the database is ahead
 * of this process, and the one direction a reporting bug must not take is
 * turning something unknown into a green row.
 */
const STATUS_FROM_DB: Record<string, ReporterStatus> = {
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  FLAKY: 'flaky',
  TIMED_OUT: 'timedOut',
};

/** Statuses a quarantine has something to suppress. See `runReportFrom`. */
const SUPPRESSIBLE: ReadonlySet<ReporterStatus> = new Set<ReporterStatus>(['failed', 'timedOut']);

/** Run statuses that mean the run is over and the document covers all of it. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'PASSED',
  'FAILED',
  'CANCELLED',
  'ERRORED',
]);

/**
 * Map the run's own rows onto the model the reporters read.
 *
 * The server-side twin of `runReportFromApi` in packages/cli/src/report.ts, and
 * the four judgement calls are that function's, for its reasons:
 *
 *  - ONE INSTANT for the whole report, not one per result. Two tests whose
 *    quarantines expire inside the same millisecond have to be reported the
 *    same way, and a per-row `new Date()` is a document that can disagree with
 *    itself.
 *  - A QUARANTINE IN FORCE turns a FAILURE into a suppressed failure and
 *    touches nothing else. A quarantined test that PASSED is a pass — the
 *    suppression had nothing to suppress — and a quarantined one that was
 *    SKIPPED is a skip. Rewriting those would stamp "QUARANTINED FAILURE" on a
 *    test that did not fail, which is the same lie pointing the other way.
 *    The question is asked by `quarantineSuppresses` from @qaai/runner, never
 *    by reading `Test.quarantined`: an expired quarantine suppresses nothing.
 *  - A ZERO DURATION ON A SKIP IS NOT A MEASUREMENT. `durationMs` is
 *    `Int @default(0)`, so a test that never executed arrives as 0; it is
 *    dropped, and the reporters then omit the field entirely rather than
 *    writing `time="0.000"`.
 *  - `createdAt` IS the finish stamp. The schema has no per-test start, but the
 *    worker writes the result row immediately after the test finishes, so
 *    `createdAt` is accurate to the write latency and real — which the
 *    alternatives (the run's own start for every test, or nothing) are not.
 *    Allure derives `start` from it and the duration.
 *
 * `name` IS DELIBERATELY NOT SET, and that is a bytes contract rather than an
 * omission: `suiteNameOf` falls back to `qaai`, which is the `<testsuite name>`
 * every customer's CI already parses out of `GET /runs/:runId/junit.xml`.
 * Putting the project or environment name there would change bytes somebody
 * else's build reads.
 */
export function runReportFrom(
  run: ReportRunRow,
  options: { url?: string; now?: Date } = {},
): RunReport {
  const now = options.now ?? new Date();

  const tests = run.results.map((result) => {
    const reported = STATUS_FROM_DB[result.status] ?? 'failed';
    const status: ReporterStatus =
      SUPPRESSIBLE.has(reported) && result.test && quarantineSuppresses(result.test, now)
        ? 'quarantined'
        : reported;

    const raw = result.durationMs;
    const timed =
      typeof raw === 'number' &&
      Number.isFinite(raw) &&
      raw >= 0 &&
      !(raw === 0 && status === 'skipped');

    const test: RunReport['tests'][number] = {
      name: result.test?.name ?? '(unnamed test)',
      status,
    };
    if (result.test?.id) test.id = result.test.id;
    if (result.test?.filePath) test.suite = result.test.filePath;
    if (timed) test.durationMs = raw;
    if (result.createdAt) test.finishedAt = result.createdAt.getTime();
    if (result.errorMessage) test.message = result.errorMessage;
    return test;
  });

  const report: RunReport = { tests };
  report.id = run.id;
  if (run.commitSha) report.commitSha = run.commitSha;
  if (run.branch) report.branch = run.branch;
  if (run.environment?.name) report.environment = run.environment.name;
  if (options.url) report.url = options.url;
  if (run.startedAt) report.startedAt = run.startedAt.getTime();
  if (run.finishedAt) report.finishedAt = run.finishedAt.getTime();

  /*
   * The run's own counters, which are the truth for a SHARDED run: this process
   * holds every result row, but `derivedTotals` recomputed from them would
   * silently disagree with the counters the worker finalised, and the counters
   * are what every other surface in the product shows.
   *
   * All six columns are non-nullable `Int @default(0)`, so unlike the CLI's
   * optional case there is nothing to omit — and that is worth naming rather
   * than papering over: a run finalised before `quarantinedFailedCount`
   * existed carries a real 0 in it, and NOTHING in the row distinguishes that
   * from a measured zero. That is a property of the column, not of this
   * mapping, and it is not something a reporter can be asked to guess at.
   */
  report.totals = {
    tests: run.totalCount,
    passed: run.passedCount,
    failed: run.failedCount,
    skipped: run.skippedCount,
    flaky: run.flakyCount,
    quarantinedFailed: run.quarantinedFailedCount,
  };

  return report;
}

// ─── Reading the run ─────────────────────────────────────────────────────────

/**
 * The project, or a 404 — never a 403.
 *
 * Same shape and same reason as `projectOr404` in routes/measurements.ts:
 * tenancy is enforced by the Prisma extension, so a project in another org
 * reads as absent, and `notFound()` is exactly that answer. A 403 would turn
 * this endpoint into an existence oracle for other orgs' ids.
 *
 * The run's own `findUnique` is already post-filtered by the extension, so this
 * is the second of two doors rather than the only one — and it is not
 * redundant: it is the door the rest of the API uses, and a run whose project
 * has gone must not render a document attributed to nothing.
 */
async function projectOr404(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, orgId: true },
  });
  if (!project) throw notFound('Project');
  return project;
}

/**
 * Every column `runReportFrom` reads, and not one more.
 *
 * Both quarantine columns are selected because the flag alone is not the
 * answer: an expired quarantine suppresses nothing and its failure gates again.
 * Dropping `quarantineExpiresAt` from here would make every expired quarantine
 * read as still in force, which is a suppressed failure nobody is being told
 * about — so it is asserted by a test rather than left to review.
 */
const RUN_SELECT = {
  id: true,
  projectId: true,
  status: true,
  commitSha: true,
  branch: true,
  startedAt: true,
  finishedAt: true,
  totalCount: true,
  passedCount: true,
  failedCount: true,
  flakyCount: true,
  skippedCount: true,
  quarantinedFailedCount: true,
  environment: { select: { name: true } },
  results: {
    select: {
      status: true,
      durationMs: true,
      errorMessage: true,
      createdAt: true,
      test: {
        select: {
          id: true,
          name: true,
          filePath: true,
          quarantined: true,
          quarantineExpiresAt: true,
        },
      },
    },
  },
} as const;

// ─── Query parsing ───────────────────────────────────────────────────────────

/** One string value from a query key, or undefined. Repeated keys are a 400. */
function oneValue(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  throw badRequest(`${field} must be given at most once`);
}

/**
 * The format name, or a 400 THAT NAMES THE VALID FORMATS.
 *
 * Missing is a 400 too, deliberately: a default would mean this route guesses
 * which document a build is about to parse, and a build parsing the wrong bytes
 * reports a result that has nothing to do with the run. 404 is also wrong here
 * and was considered — on a route that exists, "no such format" answering 404
 * reads as "this run has no report", which is a claim about the run.
 */
function formatOr400(registry: ReportRegistry, raw: string | undefined): string {
  const wanted = (raw ?? '').trim().toLowerCase();
  const formats = [...registry.names];
  if (!wanted) {
    throw badRequest(`format is required. Valid formats: ${formats.join(', ')}.`, { formats });
  }
  const reporter = registry.resolve(wanted);
  if (!reporter) {
    throw badRequest(`Unknown report format '${wanted}'. Valid formats: ${formats.join(', ')}.`, {
      formats,
      requested: wanted,
    });
  }
  return reporter.name;
}

/**
 * `?testRailRunId=` — the TestRail run results attach to.
 *
 * Not a secret and not a credential: it is the id of a run in the customer's
 * TestRail, and without it the reporter fails closed and says so in a warning
 * rather than producing a request that would stamp results onto an unrelated
 * TestRail run. Validated here so a typo is a 400 naming the constraint instead
 * of a document that silently carries no upload descriptor.
 */
function testRailRunIdOr400(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const id = Number(raw.trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest(`testRailRunId must be a positive integer, got '${raw}'.`);
  }
  return id;
}

/** `meta=1` / `true`. Anything else in the key is a 400, not a silent false. */
function metaOr400(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false' || value === '') return false;
  throw badRequest(`meta must be one of 1, 0, true, false — got '${raw}'.`);
}

// ─── Serving a rendered document ─────────────────────────────────────────────

const UNSERVABLE = 'REPORT_DOCUMENT_UNSERVABLE';

/**
 * Why these bytes cannot be served, or null when they can.
 *
 * Both branches are the same refusal wearing different clothes: a 200 whose
 * body is not the whole document. An empty `.sarif` reads as "no findings"; the
 * first of several files served alone drops the rest with nothing counting
 * them. The descriptor's `directory` field decides which shape is expected —
 * never the reporter's name, because a sixth reporter would then need an edit
 * here to be served correctly and would silently be served wrongly until it
 * got one.
 */
function unservable(
  reporter: { name: string; directory: boolean },
  document: ReporterDocument,
): ApiError | null {
  if (document.files.length === 0) {
    return new ApiError(
      501,
      UNSERVABLE,
      `The '${reporter.name}' reporter rendered no file for this run, so there is no document to ` +
        `serve. An empty body would read as "nothing was found", which is a claim about the run ` +
        `rather than about this deployment. Add &meta=1 to the same URL for the file list and the ` +
        `reporter's own warnings.`,
      { format: reporter.name, files: 0, directory: reporter.directory },
    );
  }
  if (!reporter.directory && document.files.length > 1) {
    return new ApiError(
      501,
      UNSERVABLE,
      `The '${reporter.name}' reporter declares a single-file output and rendered ` +
        `${document.files.length} files, so no single body is the whole document. Serving one of ` +
        `them would drop the rest with nothing counting them. Add &meta=1 for the file list.`,
      { format: reporter.name, files: document.files.length, directory: false },
    );
  }
  return null;
}

/**
 * The manifest `&meta=1` answers with.
 *
 * This is where the reporter's `warnings` live. They cannot go in HTTP headers:
 * they contain em dashes, and they quote test names, which in this product's
 * own fixtures contain `<`, `&`, quotes and a raw NUL. A header value carrying
 * any of that is either rejected by Node or silently mangled to latin-1, and a
 * mangled warning is worse than a counted one.
 *
 * `bytes` is `Buffer.byteLength`, a real measurement of the rendered file, not
 * `contents.length` — those differ on every non-ASCII character, and the number
 * a caller wants is the size of the download.
 */
function manifestFor(args: {
  reporter: { name: string; description: string; defaultOut: string; directory: boolean };
  document: ReporterDocument;
  registry: ReportRegistry;
  run: { id: string; status: string };
  refusal: ApiError | null;
}): Record<string, unknown> {
  const { reporter, document, registry, run, refusal } = args;
  return {
    run: {
      id: run.id,
      status: run.status,
      /*
       * A report of a QUEUED or RUNNING run is a partial document — the results
       * recorded so far, and the run's counters as they stand. Said out loud
       * rather than inferred from the status, because "the document covers the
       * whole run" is the assumption every consumer of these bytes makes.
       */
      complete: TERMINAL_RUN_STATUSES.has(run.status),
    },
    format: reporter.name,
    description: reporter.description,
    /* The two shapes the body path can take. See the header. */
    kind: reporter.directory ? 'directory' : 'file',
    defaultOut: reporter.defaultOut,
    bodyFilename: reporter.directory ? `${reporter.defaultOut}.zip` : reporter.defaultOut,
    bodyContentType: reporter.directory
      ? 'application/zip'
      : (document.files[0]?.contentType ?? null),
    files: document.files.map((file) => ({
      path: file.path,
      contentType: file.contentType,
      bytes: Buffer.byteLength(file.contents, 'utf8'),
    })),
    warnings: document.warnings,
    upload:
      document.upload === undefined
        ? null
        : {
            service: document.upload.service,
            method: document.upload.method,
            path: document.upload.path,
            summary: document.upload.summary,
            /*
             * NEVER performed here, and the field exists so that is not left to
             * be assumed. This process holds no TestRail credential and must
             * not: a connector's credentials belong on a model row the customer
             * owns, not in this environment. The caller makes this request with
             * its own key, which is also why the reporter models no credential.
             */
            performed: false,
            note:
              'This route renders the payload and performs no upload: it holds no TestRail ' +
              'credential. Make this request yourself with your own TestRail key.',
          },
    /* Always from the registry, so a new reporter is listed without an edit. */
    formats: [...registry.names],
    unservableAsBody: refusal === null ? null : { code: refusal.code, reason: refusal.message },
  };
}

// ─── The route ───────────────────────────────────────────────────────────────

/**
 * The handler, parameterised by the registry.
 *
 * Exported as a factory so a test can drive it against a fake registry: the
 * refusal branches in {@link unservable} describe reporters none of the five
 * real ones is, which is exactly why they cannot be proven against the real
 * registry. The router below wires the real one, and the reporter LOOP in the
 * tests goes through that router — so "every name in REPORTER_NAMES is
 * reachable" is measured on the shipped path, not on the seam.
 */
export function reportHandler(registry: ReportRegistry) {
  return async (
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<void> => {
    const format = formatOr400(registry, oneValue(req.query.format, 'format'));
    const meta = metaOr400(oneValue(req.query.meta, 'meta'));
    const testRailRunId = testRailRunIdOr400(oneValue(req.query.testRailRunId, 'testRailRunId'));

    const run = await prisma.run.findUnique({
      where: { id: String(req.params.runId) },
      select: RUN_SELECT,
    });
    if (!run) throw notFound('Run');
    /* Tenancy's second door, and the one the rest of the API uses. */
    await projectOr404(run.projectId);

    /*
     * The link Allure puts on every result. `WEB_PUBLIC_URL` is this
     * deployment's own configured web address — the same one the invite mails,
     * the issue bodies and the share links are built from — so it is a real
     * link rather than an address guessed from the API's.
     */
    const url = `${env.WEB_PUBLIC_URL.replace(/\/+$/, '')}/runs/${run.id}`;
    const report = runReportFrom(run, { url });

    const reporter = registry.resolve(format);
    if (!reporter) {
      /*
       * `formatOr400` already resolved this name, so reaching here means the
       * registry changed underneath us. Reported, because the alternative is a
       * 200 with an empty body.
       */
      throw new ApiError(
        501,
        UNSERVABLE,
        `The '${format}' reporter resolved and then disappeared from the registry; nothing was ` +
          `rendered.`,
        { format },
      );
    }

    const options: ReporterOptions = {};
    if (testRailRunId !== undefined) options.testRailRunId = testRailRunId;
    const document = registry.render(format, report, options);
    if (!document) {
      throw new ApiError(
        501,
        UNSERVABLE,
        `The '${format}' reporter is in the registry's name list and rendered nothing for this ` +
          `run.`,
        { format },
      );
    }

    const refusal = unservable(reporter, document);

    if (meta) {
      /*
       * The manifest answers even when the body cannot, and names the reason in
       * `unservableAsBody`. A manifest reporting `files: []` beside the
       * warnings is not a document and cannot be mistaken for one, which is the
       * whole difference between it and the 200 the body path refuses to give.
       */
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(manifestFor({ reporter, document, registry, run, refusal }));
      return;
    }

    if (refusal) throw refusal;

    /*
     * Disclosures that survive on the bytes path. `x-qaai-report-warnings` is a
     * COUNT, so 0 is an honest 0 — it is not a measurement that could be
     * missing. The text is at `&meta=1`; see {@link manifestFor}.
     */
    res.setHeader('x-qaai-report-format', reporter.name);
    res.setHeader('x-qaai-report-formats', [...registry.names].join(', '));
    res.setHeader('x-qaai-report-kind', reporter.directory ? 'directory-zip' : 'file');
    res.setHeader('x-qaai-report-files', String(document.files.length));
    res.setHeader('x-qaai-report-warnings', String(document.warnings.length));
    res.setHeader(
      'x-qaai-report-run-complete',
      TERMINAL_RUN_STATUSES.has(run.status) ? 'true' : 'false',
    );
    if (document.upload) res.setHeader('x-qaai-report-upload-performed', 'false');
    /* A report is per-run and per-actor; a shared cache must not hold it. */
    res.setHeader('Cache-Control', 'private, no-store');
    /* These bytes are XML, JSON and SARIF a browser must never sniff into HTML. */
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (reporter.directory) {
      /*
       * One body for a tree. `zipTree` stamps a fixed date on every entry, so
       * two exports of an unchanged run are byte-identical — which is what lets
       * a caller diff two downloads and believe the result.
       */
      const tree: RepoTree = new Map(document.files.map((file) => [file.path, file.contents]));
      const archive = await zipTree(tree);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reporter.defaultOut}.zip"`,
      );
      res.setHeader('Content-Length', String(archive.byteLength));
      res.end(archive);
      return;
    }

    /*
     * `files[0]` is the whole document here: `unservable` has already refused
     * zero files and refused more than one, so this is the single file the
     * descriptor promised. The `?? ''` is the type system's, not a fallback
     * anybody can reach.
     */
    const file = document.files[0];
    res.setHeader('Content-Type', file?.contentType ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${reporter.defaultOut}"`);
    res.send(file?.contents ?? '');
  };
}

/**
 * `GET /runs/:runId/report?format=<name>`
 *
 * `runs:read` rather than `runs:write`: this is a read of a finished run, and a
 * key that may only read runs must be able to fetch the document its CI parses.
 * A session actor carries `['*']`, so a human in the app is unaffected.
 *
 * A SHARE-LINK PATH IS DELIBERATELY NOT ADDED. `shareRouter` already resolves
 * one run through `GET /share/:token`, so a public report would be a widening
 * of that surface — a share link that currently hands out one run's results
 * would start handing out a complete JUnit/SARIF/evidence document — and that
 * belongs in `routes/share.ts`, which owns the token, the revocation and the
 * `X-Robots-Tag`. Not widened here.
 *
 * MOUNT THIS ROUTER AT `/runs` AHEAD OF `runsRouter`. Both are correct, because
 * `runsRouter` declares no path that matches `/:runId/report` — but mounted
 * ahead, this request never enters `runsRouter` and so never pays its
 * router-level `requireAuth` on top of the one below.
 */
reportsRouter.get(
  '/:runId/report',
  requireAuth,
  requireScope('runs:read'),
  reportHandler(RUNNER_REGISTRY),
);
