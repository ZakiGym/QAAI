/**
 * Reporter tests. What each section is actually here to catch:
 *
 *  1. **JUnit byte drift.** The bytes `qaai run --junit` produces are parsed by
 *     customers' CI today. `apiRouteJunit` below is an INDEPENDENT
 *     transcription of `GET /runs/:runId/junit.xml`
 *     (apps/api/src/routes/runs.ts) — written from the route, not from the
 *     reporter — and every fixture is asserted equal through both. An assertion
 *     whose two sides both come from the reporter would prove nothing; this one
 *     fails the moment the reporter and the shipped route disagree by a space.
 *
 *  2. **Invented data.** Every reporter, over every fixture, is checked never
 *     to emit a timing field for a test the run never timed. A zero there is
 *     the specific bug that makes a dashboard confidently wrong.
 *
 *  3. **The fixtures that break writers in production.** A run with failures,
 *     one with flakes, one with skips, one with zero tests, and one whose test
 *     names carry `<`, `&`, quotes and a raw NUL. That last one is how JUnit
 *     writers break: the file is produced, the CI cannot parse it, and the
 *     build reports nothing rather than failing.
 *
 *  4. **TestRail's refusals.** No case id, no run id, a skipped test, a
 *     sub-second duration — each one must produce a warning and an omission,
 *     never a plausible-looking upload.
 *
 * The round-trip in section 1 runs the rendered XML back through this repo's
 * own JUnit PARSER (`../reports/junit-xml.js`), which was written by somebody
 * else for the opposite purpose. Two implementations that have to agree is
 * worth more than any hand-written expected string.
 */

import { describe, expect, it } from 'vitest';
import { parseJUnitXml } from '../reports/junit-xml.js';
import { allureReporter, type AllureResult } from './allure.js';
import { junitReporter, renderJUnitXml } from './junit.js';
import { REPORTERS, REPORTER_NAMES, renderReport, resolveReporter } from './index.js';
import { caseIdsFor, elapsedFor, testrailReporter, type TestRailPayload } from './testrail.js';
import type { ReportedTest, RunReport } from './types.js';

// ─── Fixtures, in the shape the platform stores ──────────────────────────────

type PlatformStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'FLAKY' | 'TIMED_OUT';

interface PlatformResult {
  name: string;
  status: PlatformStatus;
  durationMs: number;
  errorMessage: string | null;
}

interface PlatformRun {
  totalCount: number;
  failedCount: number;
  skippedCount: number;
  results: PlatformResult[];
}

const REPORTED: Record<PlatformStatus, ReportedTest['status']> = {
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  FLAKY: 'flaky',
  TIMED_OUT: 'timedOut',
};

function toRunReport(run: PlatformRun): RunReport {
  return {
    id: 'run_fixture',
    totals: {
      tests: run.totalCount,
      passed: run.results.filter((r) => r.status === 'PASSED').length,
      failed: run.failedCount,
      skipped: run.skippedCount,
      flaky: run.results.filter((r) => r.status === 'FLAKY').length,
    },
    tests: run.results.map((r) => ({
      name: r.name,
      status: REPORTED[r.status],
      durationMs: r.durationMs,
      ...(r.errorMessage === null ? {} : { message: r.errorMessage }),
    })),
  };
}

/**
 * A transcription of apps/api/src/routes/runs.ts `GET /:runId/junit.xml`.
 *
 * Copied from the route deliberately, and it must keep being a copy: this is
 * the oracle the reporter is measured against, so "fix" it only when the route
 * itself changes.
 */
function apiRouteJunit(run: PlatformRun): string {
  const escape = (v: string): string =>
    v.replace(
      /[<>&"']/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
    );

  const cases = run.results
    .map((r) => {
      const time = (r.durationMs / 1000).toFixed(3);
      const name = escape(r.name);
      if (r.status === 'PASSED') return `    <testcase name="${name}" time="${time}"/>`;
      if (r.status === 'SKIPPED')
        return `    <testcase name="${name}" time="${time}"><skipped/></testcase>`;
      return `    <testcase name="${name}" time="${time}"><failure message="${escape(
        r.errorMessage ?? 'failed',
      )}"/></testcase>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="qaai" tests="${run.totalCount}" failures="${run.failedCount}" skipped="${run.skippedCount}">\n${cases}\n  </testsuite>\n</testsuites>\n`;
}

const withFailures: PlatformRun = {
  totalCount: 3,
  failedCount: 2,
  skippedCount: 0,
  results: [
    { name: 'checkout · card is charged', status: 'PASSED', durationMs: 1500, errorMessage: null },
    {
      name: 'checkout · declined card shows an error',
      status: 'FAILED',
      durationMs: 812,
      errorMessage: 'expected "Declined" to be visible',
    },
    {
      name: 'search · results load',
      status: 'TIMED_OUT',
      durationMs: 30000,
      errorMessage: 'Timeout 30000ms exceeded.',
    },
  ],
};

const withFlakes: PlatformRun = {
  totalCount: 2,
  failedCount: 0,
  skippedCount: 0,
  results: [
    { name: 'login · happy path', status: 'PASSED', durationMs: 640, errorMessage: null },
    {
      name: 'login · remembers me',
      status: 'FLAKY',
      durationMs: 2100,
      errorMessage: 'first attempt: element not attached',
    },
  ],
};

const withSkips: PlatformRun = {
  totalCount: 3,
  failedCount: 0,
  skippedCount: 2,
  results: [
    { name: 'billing · invoice pdf', status: 'PASSED', durationMs: 300, errorMessage: null },
    { name: 'billing · dunning email', status: 'SKIPPED', durationMs: 0, errorMessage: null },
    { name: 'billing · proration', status: 'SKIPPED', durationMs: 0, errorMessage: null },
  ],
};

const emptyRun: PlatformRun = { totalCount: 0, failedCount: 0, skippedCount: 0, results: [] };

/** `\u0000` is the one that turns a report into a file no CI can read. */
const hostile: PlatformRun = {
  totalCount: 3,
  failedCount: 1,
  skippedCount: 0,
  results: [
    {
      name: 'a < b && c > d — "quoted" and \'single\'',
      status: 'PASSED',
      durationMs: 12,
      errorMessage: null,
    },
    {
      name: 'renders <script>alert("x")</script> safely',
      status: 'FAILED',
      durationMs: 45,
      errorMessage: 'expected <div class="ok"> & got <div class=\'bad\'>',
    },
    {
      name: 'name with a NUL \u0000 and an escape \u001B[31m',
      status: 'PASSED',
      durationMs: 7,
      errorMessage: null,
    },
  ],
};

const PLATFORM_FIXTURES: Array<[string, PlatformRun]> = [
  ['failures', withFailures],
  ['flakes', withFlakes],
  ['skips', withSkips],
  ['zero tests', emptyRun],
  ['xml-hostile names', hostile],
];

/** The case the platform cannot produce today, and every reporter must survive. */
const untimed: RunReport = {
  id: 'run_untimed',
  tests: [
    { name: 'C42 imported case with no timing', status: 'passed' },
    { name: 'C43 also untimed', status: 'failed', message: 'boom' },
  ],
};

// ─── 1. JUnit: the bytes must not move ───────────────────────────────────────

describe('junit reporter', () => {
  for (const [label, run] of PLATFORM_FIXTURES) {
    it(`matches the API route byte for byte — ${label}`, () => {
      const ours = renderJUnitXml(toRunReport(run));
      const theirs = apiRouteJunit(run);
      // The NUL fixture is the documented exception: the route emits a byte no
      // XML parser accepts, so the reporter drops it and only that.
      const expected =
        label === 'xml-hostile names'
          ? // eslint-disable-next-line no-control-regex -- the point of the fixture.
            theirs.replace(/[\u0000\u001B]/g, '')
          : theirs;
      expect(ours).toBe(expected);
    });
  }

  it('round-trips through this repo’s own JUnit parser', () => {
    const xml = renderJUnitXml(toRunReport(withFailures));
    const parsed = parseJUnitXml(xml);
    expect(parsed.presence).toBe('ok');
    expect(parsed.tests.map((t) => t.status)).toEqual(['passed', 'failed', 'failed']);
    expect(parsed.tests[0]!.name).toBe('checkout · card is charged');
    expect(parsed.tests[0]!.durationMs).toBe(1500);
    expect(parsed.tests[1]!.failureMessage).toBe('expected "Declined" to be visible');
  });

  it('keeps a zero-test run parseable rather than empty', () => {
    const xml = renderJUnitXml(toRunReport(emptyRun));
    expect(xml).toContain('tests="0"');
    const parsed = parseJUnitXml(xml);
    // "The suite selected no tests" — NOT "there was no report".
    expect(parsed.presence).toBe('ok');
    expect(parsed.totals.tests).toBe(0);
  });

  it('leaves an unparseable name behind — control characters do not survive', () => {
    const xml = renderJUnitXml(toRunReport(hostile));
    // eslint-disable-next-line no-control-regex -- the point of the assertion.
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(xml).toContain(
      'a &lt; b &amp;&amp; c &gt; d — &quot;quoted&quot; and &apos;single&apos;',
    );
    const parsed = parseJUnitXml(xml);
    expect(parsed.tests).toHaveLength(3);
    expect(parsed.tests[2]!.name).toBe('name with a NUL  and an escape [31m');
  });

  it('warns about what it changed and what it lacked', () => {
    const doc = junitReporter.render(toRunReport(hostile));
    expect(doc.warnings.join(' ')).toContain('control characters');
    expect(junitReporter.render(untimed).warnings.join(' ')).toContain('no timing');
  });

  it('omits the time attribute entirely when the run never timed the test', () => {
    const xml = renderJUnitXml(untimed);
    expect(xml).not.toContain('time=');
    expect(xml).toContain('<testcase name="C42 imported case with no timing"/>');
  });

  it('derives the suite attributes when the run carries no counters', () => {
    const xml = renderJUnitXml({
      tests: [
        { name: 'a', status: 'passed', durationMs: 1 },
        { name: 'b', status: 'failed', durationMs: 1 },
        { name: 'c', status: 'timedOut', durationMs: 1 },
        { name: 'd', status: 'skipped', durationMs: 1 },
        { name: 'e', status: 'flaky', durationMs: 1 },
      ],
    });
    // Mirrors the worker: TIMED_OUT counts as a failure, FLAKY counts as
    // neither a pass nor a failure.
    expect(xml).toContain('tests="5" failures="2" skipped="1"');
  });
});

// ─── 2. Allure ───────────────────────────────────────────────────────────────

function allureResults(doc: { files: Array<{ path: string; contents: string }> }): AllureResult[] {
  return doc.files
    .filter((f) => f.path.endsWith('-result.json'))
    .map((f) => JSON.parse(f.contents) as AllureResult);
}

describe('allure reporter', () => {
  it('writes one -result.json per test, in the shape allure generate reads', () => {
    const doc = allureReporter.render(toRunReport(withFailures));
    const results = allureResults(doc);
    expect(results).toHaveLength(3);
    // The only non-result file here is the environment block; executor.json
    // needs a run URL this fixture does not have.
    expect(doc.files.map((f) => f.path).filter((p) => !p.endsWith('-result.json'))).toEqual([
      'environment.properties',
    ]);
    expect(results[0]).toMatchObject({
      name: 'checkout · card is charged',
      fullName: 'checkout · card is charged',
      status: 'passed',
      stage: 'finished',
    });
    expect(results[0]!.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('splits failed from broken, and marks a flake as a flaky pass', () => {
    const failures = allureResults(allureReporter.render(toRunReport(withFailures)));
    expect(failures[1]!.status).toBe('failed');
    expect(failures[2]!.status).toBe('broken');

    const flakes = allureResults(allureReporter.render(toRunReport(withFlakes)));
    expect(flakes[1]!.status).toBe('passed');
    expect(flakes[1]!.statusDetails?.flaky).toBe(true);
    expect(flakes[1]!.statusDetails?.message).toBe('first attempt: element not attached');
    expect(flakes[1]!.labels).toContainEqual({ name: 'tag', value: 'flaky' });
  });

  it('omits start and stop rather than writing 0 for an untimed test', () => {
    const results = allureResults(allureReporter.render(untimed));
    for (const result of results) {
      expect(result).not.toHaveProperty('start');
      expect(result).not.toHaveProperty('stop');
    }
    expect(allureReporter.render(untimed).warnings.join(' ')).toContain('no start/stop');
  });

  it('derives stop from a start plus a duration, which is a derivation and not a guess', () => {
    const results = allureResults(
      allureReporter.render({
        id: 'r',
        tests: [{ name: 't', status: 'passed', startedAt: 1_700_000_000_000, durationMs: 250 }],
      }),
    );
    expect(results[0]!.start).toBe(1_700_000_000_000);
    expect(results[0]!.stop).toBe(1_700_000_000_250);
  });

  it('keeps historyId free of the run id so history survives across runs', () => {
    const one = allureResults(allureReporter.render({ id: 'run_1', tests: untimed.tests }));
    const two = allureResults(allureReporter.render({ id: 'run_2', tests: untimed.tests }));
    expect(one[0]!.historyId).toBe(two[0]!.historyId);
    // …while the per-result uuid must differ, or two runs merged into one
    // directory would overwrite each other.
    expect(one[0]!.uuid).not.toBe(two[0]!.uuid);
  });

  it('is deterministic — the same run renders to the same filenames', () => {
    const a = allureReporter.render(toRunReport(withSkips));
    const b = allureReporter.render(toRunReport(withSkips));
    expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path));
    expect(a.files.map((f) => f.contents)).toEqual(b.files.map((f) => f.contents));
  });

  it('writes executor.json only when the run knows its own URL', () => {
    const without = allureReporter.render(toRunReport(withSkips));
    expect(without.files.some((f) => f.path === 'executor.json')).toBe(false);
    expect(without.warnings.join(' ')).toContain('executor.json');

    const withUrl = allureReporter.render({
      ...toRunReport(withSkips),
      url: 'https://qaai.example.com/runs/run_fixture',
      branch: 'main',
      commitSha: 'deadbee',
      environment: 'staging',
    });
    const executor = withUrl.files.find((f) => f.path === 'executor.json');
    expect(executor).toBeDefined();
    expect(JSON.parse(executor!.contents)).toMatchObject({ type: 'qaai' });
    const properties = withUrl.files.find((f) => f.path === 'environment.properties');
    expect(properties!.contents).toContain('branch=main');
    expect(properties!.contents).toContain('commit=deadbee');
  });

  it('produces a directory for a zero-test run instead of nothing at all', () => {
    const doc = allureReporter.render(toRunReport(emptyRun));
    expect(allureResults(doc)).toHaveLength(0);
    expect(doc.warnings.join(' ')).toContain('zero tests');
  });
});

// ─── 3. TestRail ─────────────────────────────────────────────────────────────

function payload(contents: string): TestRailPayload {
  return JSON.parse(contents) as TestRailPayload;
}

describe('testrail reporter', () => {
  const mapped: RunReport = {
    id: 'run_tr',
    tests: [
      { name: 'C101 checkout charges the card', status: 'passed', durationMs: 4200 },
      {
        name: 'C102 declined card shows an error',
        status: 'failed',
        durationMs: 900,
        message: 'expected "Declined" to be visible',
      },
      {
        name: 'C103 login remembers me',
        status: 'flaky',
        durationMs: 2100,
        message: 'first attempt failed',
      },
      {
        name: 'C104 slow search',
        status: 'timedOut',
        durationMs: 30000,
        message: 'Timeout 30000ms exceeded.',
      },
      { name: 'C105 dunning email', status: 'skipped' },
      { name: 'unmapped test with no case id', status: 'passed', durationMs: 1000 },
    ],
  };

  it('keys results on case ids and maps the statuses TestRail actually has', () => {
    const doc = testrailReporter.render(mapped, { testRailRunId: 77 });
    const body = payload(doc.files[0]!.contents);
    expect(body.results).toEqual([
      { case_id: 101, status_id: 1, elapsed: '4s' },
      {
        case_id: 102,
        status_id: 5,
        comment: 'expected "Declined" to be visible',
        elapsed: '1s',
      },
      {
        case_id: 103,
        status_id: 1,
        comment: 'Passed on retry — QAAI recorded this test as flaky.\n\nfirst attempt failed',
        elapsed: '2s',
      },
      {
        case_id: 104,
        status_id: 5,
        comment: 'Timed out.\n\nTimeout 30000ms exceeded.',
        elapsed: '30s',
      },
    ]);
  });

  it('describes the upload without ever holding a host or a credential', () => {
    const doc = testrailReporter.render(mapped, { testRailRunId: 77 });
    expect(doc.upload).toMatchObject({
      service: 'testrail',
      method: 'POST',
      path: '/index.php?/api/v2/add_results_for_cases/77',
    });
    expect(JSON.stringify(doc.upload)).not.toMatch(/https?:\/\//);
  });

  it('leaves out what TestRail cannot represent, and says so', () => {
    const warnings = testrailReporter.render(mapped, { testRailRunId: 77 }).warnings.join(' ');
    expect(warnings).toContain('no TestRail case id');
    expect(warnings).toContain('unmapped test with no case id');
    expect(warnings).toContain('Untested status cannot be written');
  });

  it('omits elapsed rather than sending a zero TestRail would reject', () => {
    const doc = testrailReporter.render(
      {
        tests: [
          { name: 'C1 sub-second', status: 'passed', durationMs: 400 },
          { name: 'C2 untimed', status: 'passed' },
        ],
      },
      { testRailRunId: 3 },
    );
    const body = payload(doc.files[0]!.contents);
    expect(body.results).toEqual([
      { case_id: 1, status_id: 1 },
      { case_id: 2, status_id: 1 },
    ]);
    expect(doc.warnings.join(' ')).toContain('elapsed of 0');
  });

  it('refuses to produce an upload without a run id', () => {
    const doc = testrailReporter.render(mapped);
    expect(doc.upload).toBeUndefined();
    expect(doc.warnings.join(' ')).toContain('No TestRail run id');
    // The payload is still written, so `--reporter-out` can show what would go.
    expect(payload(doc.files[0]!.contents).results.length).toBeGreaterThan(0);
  });

  it('refuses to produce an empty upload', () => {
    const doc = testrailReporter.render(
      { tests: [{ name: 'nothing mappable here', status: 'passed', durationMs: 1000 }] },
      { testRailRunId: 9 },
    );
    expect(doc.upload).toBeUndefined();
    expect(doc.warnings.join(' ')).toContain('no test in this run mapped');
  });

  it('reads case ids the way teams actually write them', () => {
    expect(caseIdsFor({ name: 'C123 does a thing', status: 'passed' })).toEqual([123]);
    expect(caseIdsFor({ name: 'covers C1 and C2', status: 'passed' })).toEqual([1, 2]);
    expect(caseIdsFor({ suite: 'C9 suite', name: 'test', status: 'passed' })).toEqual([9]);
    // Not a case id: no word boundary, and nothing that is merely C-shaped.
    expect(caseIdsFor({ name: 'ABC123 unrelated', status: 'passed' })).toEqual([]);
    expect(caseIdsFor({ name: 'C0 is not a case', status: 'passed' })).toEqual([]);
    // An explicit id always wins over the convention.
    expect(caseIdsFor({ name: 'C1 x', status: 'passed', caseIds: [500] })).toEqual([500]);
  });

  it('rounds elapsed to whole seconds and drops what rounds to none', () => {
    expect(elapsedFor({ name: 'x', status: 'passed', durationMs: 1500 })).toBe('2s');
    expect(elapsedFor({ name: 'x', status: 'passed', durationMs: 499 })).toBeUndefined();
    expect(elapsedFor({ name: 'x', status: 'passed' })).toBeUndefined();
    expect(elapsedFor({ name: 'x', status: 'passed', durationMs: Number.NaN })).toBeUndefined();
  });
});

// ─── 4. Properties every reporter must hold ──────────────────────────────────

describe('the registry', () => {
  const ALL: RunReport[] = [...PLATFORM_FIXTURES.map(([, run]) => toRunReport(run)), untimed];

  it('resolves by name and refuses an unknown one without throwing', () => {
    expect(REPORTER_NAMES).toEqual(['junit', 'allure', 'testrail']);
    expect(resolveReporter('JUnit')?.name).toBe('junit');
    expect(resolveReporter('nope')).toBeNull();
    expect(renderReport('nope', untimed)).toBeNull();
    expect(renderReport('junit', untimed)?.files).toHaveLength(1);
  });

  it('never throws, on any fixture', () => {
    for (const reporter of REPORTERS) {
      for (const report of ALL) {
        expect(() => reporter.render(report, { testRailRunId: 1 })).not.toThrow();
      }
    }
  });

  it('always produces named files with content types', () => {
    for (const reporter of REPORTERS) {
      for (const report of ALL) {
        for (const file of reporter.render(report, { testRailRunId: 1 }).files) {
          expect(file.path).not.toBe('');
          expect(file.path).not.toContain('..');
          expect(file.contentType).toMatch(/\//);
        }
      }
    }
  });

  /**
   * The rule this whole directory is built on. An untimed test must never reach
   * a document as a zero: `time="0.000"`, `"start": 0`, `"elapsed": "0s"` are
   * each a measurement somebody will believe.
   */
  it('never invents a timing for a test the run did not time', () => {
    for (const reporter of REPORTERS) {
      const doc = reporter.render(untimed, { testRailRunId: 1 });
      const text = doc.files.map((f) => f.contents).join('\n');
      expect(text).not.toContain('time="0.000"');
      expect(text).not.toContain('"elapsed"');
      expect(text).not.toContain('"start": 0');
      expect(text).not.toContain('"stop": 0');
    }
  });

  it('says out loud when it left something out', () => {
    for (const reporter of REPORTERS) {
      expect(reporter.render(untimed, { testRailRunId: 1 }).warnings.length).toBeGreaterThan(0);
    }
  });
});
