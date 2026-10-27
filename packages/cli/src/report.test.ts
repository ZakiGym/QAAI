/**
 * What these tests are for, in the order that matters.
 *
 *  1. **The mirror cannot drift.** `report.ts` re-implements the Allure and
 *     TestRail renderers because the published CLI may not import across the
 *     package boundary (see the header there). This file may — it is excluded
 *     from the build — so it imports BOTH implementations and asserts they
 *     produce byte-identical documents for every fixture. That is the only
 *     thing standing between "two implementations" and "two behaviours", and
 *     it is worth more than every other test here: its two sides come from
 *     genuinely different code.
 *
 *  2. **Credentials never reach argv.** A TestRail API key in a flag is a key
 *     in the CI log and in `ps`. The credential reader takes an environment and
 *     nothing else, the host is validated before anything is sent to it, and a
 *     redirect while holding the key is refused rather than followed.
 *
 *  3. **Nothing is invented.** The API's `durationMs` column defaults to 0, so
 *     a skipped test arrives as a confident zero; it must not leave the mapping
 *     as one.
 *
 *  4. **Reporting fails loudly.** Asking for a TestRail upload and getting a
 *     silent zero exit is how a team finds out weeks later that nothing was
 *     ever published.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allureReporter } from '../../runner/src/reporters/allure.js';
import { testrailReporter } from '../../runner/src/reporters/testrail.js';
/*
 * The registry itself, so the mirrored name list below cannot drift from it.
 * Crossing the package boundary is permitted HERE and nowhere else in this
 * package: a test file is excluded from `tsconfig.build.json` and never reaches
 * the published tarball. See the header of report.ts.
 */
import { REPORTERS } from '../../runner/src/reporters/index.js';
/*
 * The two things the CLI re-implements because it may not import them, and
 * which therefore have to be asserted equal to the originals here: the
 * quarantine sentence, and the expiry rule that decides who gets it.
 */
import { QUARANTINE_NOTE as RUNNER_QUARANTINE_NOTE } from '../../runner/src/reporters/types.js';
import { quarantineSuppresses } from '../../runner/src/gates.js';
import {
  CLI_RENDERABLE_REPORTERS,
  CLI_UNAVAILABLE_REPORTERS,
  QUARANTINE_NOTE,
  REPORTER_NAMES,
  ReportError,
  caseIdsFor,
  emitReports,
  parseReporterArgs,
  pinTestRailHost,
  readTestRailCredentials,
  readTestRailRunId,
  renderAllure,
  renderTestRail,
  runReportFromApi,
  uploadToTestRail,
  writeDocument,
  type ReportFetch,
  type RunReport,
} from './report.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const withFailures: RunReport = {
  id: 'run_1',
  environment: 'staging',
  branch: 'main',
  commitSha: 'deadbeef',
  totals: { tests: 3, passed: 1, failed: 2, skipped: 0, flaky: 0 },
  tests: [
    {
      id: 't1',
      name: 'C101 checkout charges the card',
      status: 'passed',
      durationMs: 1500,
      finishedAt: 1_700_000_001_000,
    },
    {
      id: 't2',
      suite: 'e2e/checkout.spec.ts',
      name: 'C102 declined card shows an error',
      status: 'failed',
      durationMs: 812,
      finishedAt: 1_700_000_002_000,
      message: 'expected "Declined" to be visible',
      stack: 'at checkout.spec.ts:14',
    },
    {
      id: 't3',
      name: 'C103 search results load',
      status: 'timedOut',
      durationMs: 30000,
      message: 'Timeout 30000ms exceeded.',
    },
  ],
};

const withFlakes: RunReport = {
  id: 'run_2',
  tests: [
    { name: 'C1 login happy path', status: 'passed', durationMs: 640 },
    {
      name: 'C2 login remembers me',
      status: 'flaky',
      durationMs: 2100,
      message: 'first attempt: element not attached',
    },
  ],
};

const withSkips: RunReport = {
  id: 'run_3',
  url: 'https://qaai.example.com/runs/run_3',
  tests: [
    { name: 'C10 invoice pdf', status: 'passed', durationMs: 300 },
    { name: 'C11 dunning email', status: 'skipped' },
    { name: 'C12 proration', status: 'skipped' },
  ],
};

const emptyRun: RunReport = { id: 'run_4', tests: [] };

const hostile: RunReport = {
  id: 'run_5',
  tests: [
    { name: 'a < b && c > d — "quoted" and \'single\'', status: 'passed', durationMs: 12 },
    {
      name: 'C7 renders <script>alert("x")</script>',
      status: 'failed',
      durationMs: 45,
      message: 'expected <div class="ok"> & got \'bad\'',
    },
    { name: 'name with a NUL \u0000 and an escape \u001B[31m', status: 'passed', durationMs: 7 },
  ],
};

const untimed: RunReport = {
  id: 'run_6',
  tests: [
    { name: 'C42 imported case with no timing', status: 'passed' },
    { name: 'C43 also untimed', status: 'failed', message: 'boom' },
  ],
};

/**
 * A suppressed failure beside a real one, a deliberate skip and a pass — so the
 * mirror has to agree about all four, in both formats, including the sentence
 * and the TestRail status id. One of the quarantined tests has no error text,
 * which is the case where Allure's `muted` would otherwise render a grey row
 * with nothing on it.
 */
const withQuarantine: RunReport = {
  id: 'run_7',
  environment: 'staging',
  totals: { tests: 4, passed: 1, failed: 1, skipped: 1, flaky: 0, quarantinedFailed: 2 },
  tests: [
    { id: 'q1', name: 'C300 cart adds an item', status: 'passed', durationMs: 410 },
    {
      id: 'q2',
      name: 'C301 cart applies a coupon',
      status: 'failed',
      durationMs: 980,
      message: 'expected "10% off" to be visible',
    },
    {
      id: 'q3',
      suite: 'e2e/cart.spec.ts',
      name: 'C302 cart recalculates tax',
      status: 'quarantined',
      durationMs: 1200,
      message: 'expected total 11.00, got 10.00',
      stack: 'at cart.spec.ts:41',
    },
    { id: 'q4', name: 'C303 cart saves for later', status: 'quarantined', durationMs: 700 },
  ],
};

const FIXTURES: Array<[string, RunReport]> = [
  ['failures', withFailures],
  ['flakes', withFlakes],
  ['skips', withSkips],
  ['zero tests', emptyRun],
  ['xml-hostile names', hostile],
  ['no timings', untimed],
  ['quarantined failures', withQuarantine],
];

// ─── 1. The mirror ───────────────────────────────────────────────────────────

describe('the CLI renderers mirror packages/runner/src/reporters', () => {
  for (const [label, report] of FIXTURES) {
    it(`allure — ${label}`, () => {
      // The same object through both implementations. It typechecks against
      // both models, so a change to either model breaks this file too.
      expect(renderAllure(report)).toEqual(allureReporter.render(report));
    });

    it(`testrail — ${label}`, () => {
      expect(renderTestRail(report, 4821)).toEqual(
        testrailReporter.render(report, { testRailRunId: 4821 }),
      );
      expect(renderTestRail(report)).toEqual(testrailReporter.render(report));
    });
  }
});

// ─── 2. Flags ────────────────────────────────────────────────────────────────

describe('parseReporterArgs', () => {
  it('binds each --reporter-out to the reporter before it', () => {
    expect(
      parseReporterArgs([
        '--env',
        'e1',
        '--reporter',
        'allure',
        '--reporter-out',
        './allure-results',
        '--reporter',
        'testrail',
      ]),
    ).toEqual([
      { name: 'allure', out: './allure-results' },
      { name: 'testrail', out: null },
    ]);
  });

  it('accepts a comma-separated list and normalises case', () => {
    expect(parseReporterArgs(['--reporter', 'JUnit, allure'])).toEqual([
      { name: 'junit', out: null },
      { name: 'allure', out: null },
    ]);
  });

  it('refuses an unknown reporter before the run is ever queued', () => {
    expect(() => parseReporterArgs(['--reporter', 'allure2'])).toThrow(
      /Unknown reporter 'allure2'/,
    );
    expect(() => parseReporterArgs(['--reporter'])).toThrow(/needs a name/);
    expect(() => parseReporterArgs(['--reporter', '--junit'])).toThrow(/needs a name/);
    expect(() => parseReporterArgs(['--reporter-out', 'x'])).toThrow(/must follow a --reporter/);
    expect(() => parseReporterArgs(['--reporter', 'junit', '--reporter-out'])).toThrow(
      /needs a path/,
    );
  });

  it('finds nothing when nothing was asked for', () => {
    expect(parseReporterArgs(['--env', 'e1', '--junit', 'r.xml'])).toEqual([]);
  });

  /**
   * A REGISTERED REPORTER THIS CLI CANNOT WRITE IS REFUSED BY NAME, NOT DENIED.
   *
   * `sarif` and `evidence-pack` are real, selectable reporters. "Unknown
   * reporter 'sarif'" would be a false statement that sends a user off to build
   * a SARIF exporter QAAI already has, so the refusal has to be the other
   * sentence — and the two must stay distinguishable, which is what the
   * negative assertion on /Unknown reporter/ is for.
   */
  it('refuses a reporter that exists but cannot be rendered here, and says which', () => {
    for (const name of Object.keys(CLI_UNAVAILABLE_REPORTERS)) {
      let message = '';
      try {
        parseReporterArgs(['--reporter', name]);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, name).toMatch(new RegExp(`The '${name}' reporter exists`));
      // NOT the unknown-name sentence. Collapsing the two is the defect.
      expect(message, name).not.toMatch(/Unknown reporter/);
      // And it says where the format can be had, rather than only that it cannot.
      expect(message, name).toContain('@qaai/runner');
      // Plus what IS renderable, so the refusal is actionable in one read.
      expect(message, name).toContain('junit, allure, testrail');
    }
  });

  it('still refuses a name nobody has ever heard of, with the other sentence', () => {
    expect(() => parseReporterArgs(['--reporter', 'sarifff'])).toThrow(
      /Unknown reporter 'sarifff'/,
    );
    // The unknown-name list offers every RECOGNISED name, including the two
    // that are refused above: a user who typed `sarifff` meant `sarif`, and a
    // list that omitted it would not help them.
    expect(() => parseReporterArgs(['--reporter', 'sarifff'])).toThrow(/sarif/);
  });

  it('refuses an unavailable name even in the middle of a comma list', () => {
    expect(() => parseReporterArgs(['--reporter', 'allure,sarif,testrail'])).toThrow(
      /The 'sarif' reporter exists/,
    );
  });
});

// ─── 2b. The name lists cannot drift ─────────────────────────────────────────

/**
 * The published CLI mirrors the registry's names because it may not import it
 * at run time (see the header of report.ts). This is the parity test that makes
 * the mirror safe — and it is the one that was missing: `sarif` and
 * `evidence-pack` were registered in @qaai/runner and absent from this list,
 * so `--reporter sarif` answered "Unknown reporter".
 */
describe('the CLI name list mirrors the runner registry', () => {
  const registryNames = REPORTERS.map((reporter) => reporter.name);

  it('recognises every reporter the registry offers', () => {
    expect([...REPORTER_NAMES].sort()).toEqual([...registryNames].sort());
  });

  it('classifies every recognised name as renderable here or not, exactly once', () => {
    const renderable = new Set<string>(CLI_RENDERABLE_REPORTERS);
    const unavailable = new Set(Object.keys(CLI_UNAVAILABLE_REPORTERS));

    for (const name of REPORTER_NAMES) {
      // Exactly one of the two, so a name can never be both offered and
      // refused — or, worse, neither, which is how it reaches `emitOne` with
      // no branch of its own.
      expect([renderable.has(name), unavailable.has(name)].filter(Boolean), name).toHaveLength(1);
    }
    expect(renderable.size + unavailable.size).toBe(REPORTER_NAMES.length);
  });

  it('gives every unavailable reporter a reason a user can act on', () => {
    for (const [name, reason] of Object.entries(CLI_UNAVAILABLE_REPORTERS)) {
      expect(registryNames, name).toContain(name);
      expect(reason.length, name).toBeGreaterThan(40);
      expect(reason, name).toContain('@qaai/runner');
    }
  });

  /**
   * THE HELP TEXT AND THE RESOLVABLE NAMES CANNOT DRIFT.
   *
   * index.ts is read as a FILE and not imported: it carries a shebang, holds
   * `HELP` as a module-local const, and self-invokes `main()`, so importing it
   * would run the CLI inside the test process.
   */
  it('documents every recognised reporter in the --reporter help line', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8');
    const start = source.indexOf('  --reporter <name>');
    expect(start).toBeGreaterThan(-1);
    // The flag's own entry: from its line to the next flag's.
    const entry = source.slice(start, source.indexOf('  --reporter-out', start));

    for (const name of REPORTER_NAMES) {
      expect(entry, `--reporter help text does not mention '${name}'`).toContain(name);
    }
  });
});

describe('readTestRailRunId', () => {
  it('prefers the flag, falls back to the environment', () => {
    expect(readTestRailRunId({ 'testrail-run': '12' }, {})).toBe(12);
    expect(readTestRailRunId({}, { TESTRAIL_RUN_ID: '34' })).toBe(34);
    expect(readTestRailRunId({}, {})).toBeUndefined();
  });

  it('refuses anything that is not a run id', () => {
    expect(() => readTestRailRunId({ 'testrail-run': 'abc' }, {})).toThrow(/positive integer/);
    expect(() => readTestRailRunId({ 'testrail-run': '-1' }, {})).toThrow(/positive integer/);
    expect(() => readTestRailRunId({ 'testrail-run': '1.5' }, {})).toThrow(/positive integer/);
  });
});

// ─── 3. The API run → the model ──────────────────────────────────────────────

describe('runReportFromApi', () => {
  const payload = {
    id: 'run_x',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:05:00.000Z',
    commitSha: 'abc123',
    branch: 'feat/x',
    totalCount: 3,
    passedCount: 1,
    failedCount: 1,
    flakyCount: 0,
    skippedCount: 1,
    environment: { name: 'staging' },
    results: [
      {
        status: 'PASSED',
        durationMs: 1200,
        errorMessage: null,
        createdAt: '2026-01-01T10:01:00.000Z',
        test: { id: 't1', name: 'checkout', filePath: 'e2e/checkout.spec.ts' },
      },
      {
        status: 'SKIPPED',
        durationMs: 0,
        errorMessage: null,
        createdAt: '2026-01-01T10:02:00.000Z',
        test: { id: 't2', name: 'dunning' },
      },
      {
        status: 'TIMED_OUT',
        durationMs: 30000,
        errorMessage: 'Timeout 30000ms exceeded.',
        createdAt: '2026-01-01T10:03:00.000Z',
        test: { id: 't3', name: 'search' },
      },
    ],
  };

  it('carries the run’s own counters rather than recounting them', () => {
    // They are the truth for a sharded run, where the caller may hold one slice.
    expect(runReportFromApi(payload).totals).toEqual({
      tests: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      flaky: 0,
    });
  });

  it('drops the zero duration the schema puts on a skipped test', () => {
    const report = runReportFromApi(payload);
    expect(report.tests[0]!.durationMs).toBe(1200);
    // `durationMs Int @default(0)`: a test that never ran has no duration, and
    // 0ms in an Allure report is a measurement somebody will believe.
    expect(report.tests[1]!).not.toHaveProperty('durationMs');
    expect(report.tests[2]!.durationMs).toBe(30000);
  });

  it('uses the result row’s createdAt as the finish stamp', () => {
    const report = runReportFromApi(payload);
    expect(report.tests[0]!.finishedAt).toBe(Date.parse('2026-01-01T10:01:00.000Z'));
    // …which lets Allure place a real window rather than an invented one.
    const [result] = renderAllure(report).files;
    const parsed = JSON.parse(result!.contents) as { start: number; stop: number };
    expect(parsed.stop - parsed.start).toBe(1200);
  });

  it('maps every status the platform can store, and never invents a pass', () => {
    const report = runReportFromApi(payload);
    expect(report.tests.map((t) => t.status)).toEqual(['passed', 'skipped', 'timedOut']);
    // An unrecognised status must not become a pass.
    const odd = runReportFromApi({ results: [{ status: 'WHAT', test: { name: 'x' } }] });
    expect(odd.tests[0]!.status).toBe('failed');
  });

  it('omits totals when the payload is missing any of them', () => {
    expect(runReportFromApi({ totalCount: 3, results: [] }).totals).toBeUndefined();
  });

  it('links back to the run only when given a URL', () => {
    expect(runReportFromApi(payload).url).toBeUndefined();
    expect(runReportFromApi(payload, { url: 'https://app/runs/run_x' }).url).toBe(
      'https://app/runs/run_x',
    );
  });
});

// ─── 3b. Quarantine: the mapping, and the rule behind it ─────────────────────

/**
 * What this section is for.
 *
 * `--reporter allure` used to turn a team's dashboard red over a failure the
 * gate had already cleared, because the mapping above knew only `result.status`
 * and the platform does not store "quarantined" as a status. It now reads the
 * test's two quarantine columns, which `GET /runs/:runId` selects.
 *
 * Three things have to hold, and the third is the one that will rot:
 *   • a suppressed FAILURE becomes `quarantined`;
 *   • a quarantined test that passed or was skipped is left alone;
 *   • the CLI's local copy of the expiry rule answers exactly what
 *     `quarantineSuppresses` answers. That copy exists because the published
 *     CLI may not import across the package boundary; this file may, so the
 *     agreement is asserted against the real function rather than trusted.
 */
describe('runReportFromApi and quarantine', () => {
  const DAY = 86_400_000;
  const result = (over: Record<string, unknown> = {}) => ({
    status: 'FAILED',
    durationMs: 500,
    errorMessage: 'boom',
    createdAt: '2026-01-01T10:00:00.000Z',
    test: { id: 't1', name: 'a test', quarantined: true, quarantineExpiresAt: null },
    ...over,
  });

  it('uses the same sentence the runner reporters use, to the byte', () => {
    // A mirrored sentence that drifts by a comma is a different claim in a
    // customer's dashboard, and nothing else in this repo would notice.
    expect(QUARANTINE_NOTE).toBe(RUNNER_QUARANTINE_NOTE);
  });

  it('turns a suppressed failure into the quarantined status, and a timeout too', () => {
    expect(runReportFromApi({ results: [result()] }).tests[0]!.status).toBe('quarantined');
    expect(runReportFromApi({ results: [result({ status: 'TIMED_OUT' })] }).tests[0]!.status).toBe(
      'quarantined',
    );
  });

  it('leaves a quarantined test that did not fail exactly as it was', () => {
    /*
     * A quarantine that had nothing to suppress. Rewriting these would stamp
     * "QUARANTINED FAILURE" onto a test that passed, which is the same lie
     * pointing the other way.
     */
    expect(runReportFromApi({ results: [result({ status: 'PASSED' })] }).tests[0]!.status).toBe(
      'passed',
    );
    expect(
      runReportFromApi({ results: [result({ status: 'SKIPPED', durationMs: 0 })] }).tests[0]!
        .status,
    ).toBe('skipped');
    expect(runReportFromApi({ results: [result({ status: 'FLAKY' })] }).tests[0]!.status).toBe(
      'flaky',
    );
  });

  it('agrees with quarantineSuppresses in packages/runner/src/gates.ts on every expiry', () => {
    const now = new Date();
    const cases: Array<{ quarantined: boolean; quarantineExpiresAt: string | null }> = [
      // Not quarantined at all.
      { quarantined: false, quarantineExpiresAt: null },
      { quarantined: false, quarantineExpiresAt: new Date(now.getTime() + DAY).toISOString() },
      // No expiry: written before expiry existed, and HONOURED — back-filling
      // one would turn thousands of suppressed failures red in a deploy.
      { quarantined: true, quarantineExpiresAt: null },
      // In force, and run out.
      { quarantined: true, quarantineExpiresAt: new Date(now.getTime() + DAY).toISOString() },
      { quarantined: true, quarantineExpiresAt: new Date(now.getTime() - DAY).toISOString() },
      // Unparseable: honoured, because a bad date string must not be the thing
      // that reddens somebody's build.
      { quarantined: true, quarantineExpiresAt: 'not a date' },
    ];

    for (const columns of cases) {
      const report = runReportFromApi({ results: [result({ test: { name: 't', ...columns } })] });
      const suppressed = quarantineSuppresses(
        {
          quarantined: columns.quarantined,
          quarantineExpiresAt: columns.quarantineExpiresAt,
        },
        now,
      );
      expect(report.tests[0]!.status).toBe(suppressed ? 'quarantined' : 'failed');
    }
  });

  it('carries the fourth counter when the server sends it, and omits it when not', () => {
    const counters = {
      totalCount: 3,
      passedCount: 1,
      failedCount: 1,
      flakyCount: 0,
      skippedCount: 0,
      results: [],
    };
    expect(runReportFromApi({ ...counters, quarantinedFailedCount: 2 }).totals).toEqual({
      tests: 3,
      passed: 1,
      failed: 1,
      skipped: 0,
      flaky: 0,
      quarantinedFailed: 2,
    });
    /*
     * An API older than the quarantine fix. The other five totals must still
     * arrive — making the new counter part of the presence check would mean
     * every un-upgraded server produced no totals at all.
     */
    const old = runReportFromApi(counters);
    expect(old.totals).not.toHaveProperty('quarantinedFailed');
    expect(old.totals?.tests).toBe(3);
  });

  it('says the right thing in both formats, and never a pass or a plain skip', () => {
    const report = runReportFromApi({
      results: [
        result({
          test: { id: 't1', name: 'C9 tax', quarantined: true, quarantineExpiresAt: null },
          errorMessage: 'expected 11.00, got 10.00',
        }),
      ],
    });

    const allure = JSON.parse(renderAllure(report).files[0]!.contents) as {
      status: string;
      statusDetails: { message: string; muted?: boolean };
      labels: Array<{ name: string; value: string }>;
    };
    expect(allure.status).toBe('failed');
    expect(allure.statusDetails.muted).toBe(true);
    expect(allure.statusDetails.message).toMatch(/^QUARANTINED FAILURE/);
    expect(allure.statusDetails.message).toContain('expected 11.00, got 10.00');
    expect(allure.labels).toContainEqual({ name: 'tag', value: 'quarantined' });

    const document = renderTestRail(report, 9);
    const body = JSON.parse(document.files[0]!.contents) as {
      results: Array<{ case_id: number; status_id: number; comment?: string }>;
    };
    // Retest (4), and SENT: an omitted result leaves the case on its last
    // status, which on a case that was green last week is a failure reading as
    // a pass.
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.status_id).toBe(4);
    expect(body.results[0]!.comment).toMatch(/^QUARANTINED FAILURE/);
    expect(document.warnings.join(' ')).toContain('sent as Retest rather than Failed');
  });
});

// ─── 4. TestRail: the host, the credentials, the upload ──────────────────────

describe('pinTestRailHost', () => {
  it('freezes an https origin and keeps a non-default port', () => {
    expect(pinTestRailHost('https://acme.testrail.io/')).toBe('https://acme.testrail.io');
    expect(pinTestRailHost('https://tr.acme.com:8443')).toBe('https://tr.acme.com:8443');
  });

  it('normalises the trailing dot before deciding anything', () => {
    // `acme.testrail.io.` resolves identically; a guard that misses it is the
    // SSRF this codebase has already shipped once.
    expect(pinTestRailHost('https://acme.testrail.io.')).toBe('https://acme.testrail.io');
    expect(pinTestRailHost('http://localhost.:9000')).toBe('http://localhost:9000');
  });

  it('refuses plain http off loopback, and credentials in the URL', () => {
    expect(() => pinTestRailHost('http://acme.testrail.io')).toThrow(/must be https/);
    expect(pinTestRailHost('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(() => pinTestRailHost('https://user:key@acme.testrail.io')).toThrow(
      /must not contain credentials/,
    );
    expect(() => pinTestRailHost('not a url')).toThrow(/is not a URL/);
    expect(() => pinTestRailHost('  ')).toThrow(/is empty/);
  });
});

describe('readTestRailCredentials', () => {
  it('names exactly what is missing, and says why there is no flag', () => {
    try {
      readTestRailCredentials({ TESTRAIL_HOST: 'https://acme.testrail.io' });
      throw new Error('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('TESTRAIL_USER');
      expect(message).toContain('TESTRAIL_API_KEY');
      expect(message).not.toContain('TESTRAIL_HOST,');
      expect(message).toContain('CI log');
    }
  });

  it('reads all three from the environment', () => {
    expect(
      readTestRailCredentials({
        TESTRAIL_HOST: 'https://acme.testrail.io',
        TESTRAIL_USER: ' qa@acme.com ',
        TESTRAIL_API_KEY: ' secret ',
      }),
    ).toEqual({ origin: 'https://acme.testrail.io', user: 'qa@acme.com', apiKey: 'secret' });
  });
});

describe('uploadToTestRail', () => {
  const credentials = { origin: 'https://acme.testrail.io', user: 'qa@acme.com', apiKey: 'k3y' };
  const upload = { path: '/index.php?/api/v2/add_results_for_cases/7', body: { results: [] } };

  it('posts basic-auth JSON to the pinned origin and refuses to follow a redirect', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const ok: ReportFetch = async (url, init) => {
      seen.push({ url, init });
      return new Response('{"ok":true}', { status: 200 });
    };
    await uploadToTestRail(credentials, upload, ok);

    expect(seen[0]!.url).toBe('https://acme.testrail.io/index.php?/api/v2/add_results_for_cases/7');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('qa@acme.com:k3y').toString('base64')}`,
    );
    // A 3xx while holding an API key is how the key walks out of the building.
    expect(seen[0]!.init.redirect).toBe('manual');
  });

  it('treats a redirect as a failure, not a destination', async () => {
    const redirecting: ReportFetch = async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    await expect(uploadToTestRail(credentials, upload, redirecting)).rejects.toThrow(
      /Refusing to follow it/,
    );
  });

  it('surfaces TestRail’s own complaint without echoing the key', async () => {
    const rejecting: ReportFetch = async () =>
      new Response('{"error":"Field :elapsed is not a valid time span."}', { status: 400 });
    await expect(uploadToTestRail(credentials, upload, rejecting)).rejects.toThrow(/400.*elapsed/s);
  });

  it('turns a transport failure into a printable sentence', async () => {
    const dead: ReportFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(uploadToTestRail(credentials, upload, dead)).rejects.toBeInstanceOf(ReportError);
  });
});

// ─── 5. Writing ──────────────────────────────────────────────────────────────

describe('writeDocument', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaai-report-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a directory reporter as a directory', async () => {
    const document = renderAllure(withFailures);
    const root = join(dir, 'allure-results');
    const written = await writeDocument(document, { root, directory: true });
    expect(written).toHaveLength(document.files.length);
    expect(readdirSync(root).filter((f) => f.endsWith('-result.json'))).toHaveLength(3);
  });

  it('writes a single-file reporter to exactly the path the user named', async () => {
    const target = join(dir, 'nested', 'testrail.json');
    const written = await writeDocument(renderTestRail(withFlakes, 1), {
      root: target,
      directory: false,
    });
    expect(written).toEqual([target]);
    expect(JSON.parse(readFileSync(target, 'utf8')).results).toHaveLength(2);
  });

  it('refuses a reporter filename that would escape the output directory', async () => {
    await expect(
      writeDocument(
        {
          files: [{ path: '../escaped.json', contents: '{}', contentType: 'application/json' }],
          warnings: [],
        },
        { root: join(dir, 'out'), directory: true },
      ),
    ).rejects.toThrow(/outside the output directory/);
  });
});

// ─── 6. emitReports ──────────────────────────────────────────────────────────

describe('emitReports', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaai-emit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const credentials = {
    TESTRAIL_HOST: 'https://acme.testrail.io',
    TESTRAIL_USER: 'qa@acme.com',
    TESTRAIL_API_KEY: 'k3y',
  };

  /**
   * A NAME WITH NO RENDERER FAILS. IT DOES NOT POST TO TESTRAIL.
   *
   * `emitOne` used to end with the TestRail branch and no `if`, so any request
   * that reached it without matching `junit` or `allure` rendered a TestRail
   * payload and tried to upload it. That was harmless only while the name list
   * held exactly the three names with branches; it became live the moment the
   * list grew to recognise the reporters this CLI cannot render.
   *
   * The request is hand-made on purpose. `parseReporterArgs` refuses these
   * names, so this is the only way to arrive the way the bug would: through a
   * caller that built the list some other way.
   */
  it('fails loudly on a reporter it has no renderer for, and uploads nothing', async () => {
    let fetched = 0;
    const { outcomes, failures } = await emitReports({
      report: withFailures,
      requests: [{ name: 'sarif', out: join(dir, 'qaai.sarif') }],
      env: credentials,
      testRailRunId: 4821,
      fetchJunitXml: async () => '',
      fetchImpl: async () => {
        fetched += 1;
        return new Response('{}', { status: 200 });
      },
    });

    expect(outcomes).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no renderer in this CLI for the 'sarif' reporter/);
    // The two things the fall-through did that nobody asked for.
    expect(fetched, 'a reporter with no renderer must not reach TestRail').toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes the server’s JUnit bytes unaltered', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites/>\n';
    const target = join(dir, 'results.xml');
    const { outcomes, failures } = await emitReports({
      report: withFailures,
      requests: [{ name: 'junit', out: target }],
      env: {},
      fetchJunitXml: async () => xml,
    });
    // Not re-rendered locally: those bytes are parsed by builds that exist.
    expect(readFileSync(target, 'utf8')).toBe(xml);
    expect(failures).toEqual([]);
    expect(outcomes[0]).toMatchObject({ reporter: 'junit', uploaded: null });
  });

  it('warns rather than deletes when the allure directory already holds a run', async () => {
    const allureDir = join(dir, 'allure-results');
    const first = await emitReports({
      report: withFailures,
      requests: [{ name: 'allure', out: allureDir }],
      env: {},
      fetchJunitXml: async () => '',
    });
    expect(first.outcomes[0]!.warnings.join(' ')).not.toContain('earlier run');

    // A different run into the same directory: `allure generate` would merge
    // the two into one report, so the user is told — and nothing is deleted.
    const second = await emitReports({
      report: { ...withFlakes, id: 'run_other' },
      requests: [{ name: 'allure', out: allureDir }],
      env: {},
      fetchJunitXml: async () => '',
    });
    expect(second.outcomes[0]!.warnings.join(' ')).toContain('already contains 3 result file(s)');
    expect(readdirSync(allureDir).filter((f) => f.endsWith('-result.json'))).toHaveLength(5);
  });

  it('uploads to TestRail and reports what it sent', async () => {
    let body: unknown;
    const { outcomes, failures } = await emitReports({
      report: withFailures,
      requests: [{ name: 'testrail', out: null }],
      env: credentials,
      testRailRunId: 4821,
      fetchJunitXml: async () => '',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(typeof init.body === 'string' ? init.body : '');
        return new Response('{}', { status: 200 });
      },
    });
    expect(failures).toEqual([]);
    expect((body as { results: unknown[] }).results).toHaveLength(3);
    expect(outcomes[0]!.uploaded).toBe('3 result(s) to TestRail run 4821');
    // No file unless one was asked for: a CI step that wanted an upload does
    // not want a stray JSON in its workspace.
    expect(outcomes[0]!.files).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fails loudly when TestRail has nothing it could upload', async () => {
    const { outcomes, failures } = await emitReports({
      report: { tests: [{ name: 'no case id here', status: 'passed', durationMs: 1000 }] },
      requests: [{ name: 'testrail', out: null }],
      env: credentials,
      testRailRunId: 1,
      fetchJunitXml: async () => '',
    });
    // Not an outcome, and not silence: index.ts turns this into a nonzero exit.
    expect(outcomes).toEqual([]);
    expect(failures.join(' ')).toMatch(/testrail: nothing was uploaded/);
  });

  it('refuses to upload without credentials, and says where they belong', async () => {
    const { failures } = await emitReports({
      report: withFailures,
      requests: [{ name: 'testrail', out: null }],
      env: {},
      testRailRunId: 4821,
      fetchJunitXml: async () => '',
    });
    expect(failures.join(' ')).toMatch(/TESTRAIL_HOST, TESTRAIL_USER, TESTRAIL_API_KEY/);
  });

  it('still writes the reporters that can work when one of them cannot', async () => {
    const allureDir = join(dir, 'allure-results');
    const { outcomes, failures } = await emitReports({
      report: withFailures,
      requests: [
        { name: 'allure', out: allureDir },
        { name: 'testrail', out: null },
      ],
      env: {},
      testRailRunId: 4821,
      fetchJunitXml: async () => '',
    });
    // A broken TestRail credential is not a reason for the Allure directory to
    // go unwritten — nor for the user not to be told it was written.
    expect(failures.map((f) => f.split(':')[0])).toEqual(['testrail']);
    expect(outcomes.map((o) => o.reporter)).toEqual(['allure']);
    expect(readdirSync(allureDir).length).toBeGreaterThan(0);
  });
});

// ─── 7. Case ids ─────────────────────────────────────────────────────────────

describe('caseIdsFor', () => {
  it('reads the convention teams actually write, and nothing looser', () => {
    expect(caseIdsFor({ name: 'C123 does a thing', status: 'passed' })).toEqual([123]);
    expect(caseIdsFor({ name: 'covers C1 and C2', status: 'passed' })).toEqual([1, 2]);
    expect(caseIdsFor({ name: 'ABC123 unrelated', status: 'passed' })).toEqual([]);
    expect(caseIdsFor({ name: 'C1 x', status: 'passed', caseIds: [500] })).toEqual([500]);
  });
});
