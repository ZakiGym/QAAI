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
import {
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

const FIXTURES: Array<[string, RunReport]> = [
  ['failures', withFailures],
  ['flakes', withFlakes],
  ['skips', withSkips],
  ['zero tests', emptyRun],
  ['xml-hostile names', hostile],
  ['no timings', untimed],
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
