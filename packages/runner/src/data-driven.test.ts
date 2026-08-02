/**
 * Data-driven testing, tested against a real HTTP server.
 *
 * The feature's value is a claim about REPORTING — "case 17 of 30 failed" —
 * so most of what is asserted here is the shape of the result rather than the
 * fact that a request happened: which steps exist, what they are called, which
 * ones are red, and what the summary says. A version of this feature that runs
 * thirty cases and reports one aggregate status would pass a naive test suite
 * and be worthless.
 *
 * The rest is the two ways it can be dangerous or dishonest:
 *
 *   - dangerous: rows are org-authored content, so a cell must never be able to
 *     read a secret, add a field to a JSON body, or send a request somewhere
 *     other than the environment under test.
 *   - dishonest: a dataset that produced no cases, or whose cases never ran,
 *     must never report PASSED, and a malformed CSV must never report FAILED —
 *     the first hides a hole, the second blames the application for a typo in a
 *     spreadsheet.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutableTest, RunContext, StepResult } from '@qaai/shared';
import { apiPlugin } from './plugins/api.js';
import {
  DatasetConfigError,
  formatDatasetSummary,
  interpolateByName,
  interpolateJsonValue,
  loadDataset,
  parseCsv,
  parseDatasetConfig,
  parseJsonRows,
  summariseDataset,
} from './data-driven.js';

// ─── A server that records what it was asked ─────────────────────────────────

let server: Server;
let baseUrl: string;
let port: number;
/** Every path the server was asked for, in order. Cleared per test. */
let hits: string[] = [];
/** Bodies received on POST, so a JSON-injection attempt is visible. */
let bodies: unknown[] = [];

const DISCOUNTS: Record<string, number> = { SAVE10: 10, SAVE20: 20, FREESHIP: 0 };

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hits.push(`${req.method} ${req.url}`);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          bodies.push(JSON.parse(raw));
        } catch {
          bodies.push(raw);
        }
        json(200, { ok: true });
      });
      return;
    }

    // A discount that exists is 200; one that does not is 404. Three of the
    // fixtures below are deliberately unknown, which is what makes the "which
    // cases failed" assertions mean anything.
    const discount = /^\/discounts\/(.*)$/.exec(url.pathname);
    if (discount) {
      const code = decodeURIComponent(discount[1]!);
      return code in DISCOUNTS
        ? json(200, { code, percent: DISCOUNTS[code] })
        : json(404, { error: 'no such code' });
    }

    if (url.pathname === '/echo') return json(200, Object.fromEntries(url.searchParams));
    return json(404, { error: 'no route' });
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
});

beforeEach(() => {
  hits = [];
  bodies = [];
});

function context(
  fixtures: Record<string, string> = {},
  secrets: Record<string, string> = {},
): RunContext & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl,
    secrets,
    fixtures,
    grid: null,
    visualBaseline: null,
    storageState: null,
    artifacts: {
      put: async () => '',
      putFile: async () => '',
      get: async () => null,
      putPersistent: async () => '',
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (msg) => warnings.push(msg),
      error: () => {},
      step: () => {},
    },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    warnings,
  };
}

function apiTest(spec: unknown): ExecutableTest {
  return {
    id: 'test_1',
    name: 'discount codes',
    type: 'API',
    code: '',
    filePath: 'tests/discounts.api.json',
    spec,
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
  };
}

/** The one-step chain most of these tests use: look a discount code up. */
const LOOKUP_STEPS = [
  {
    name: 'look the code up',
    method: 'GET',
    path: '/discounts/{{code}}',
    assertions: { status: 200 },
  },
];

/** Steps only, without the summary step the plugin appends. */
function caseSteps(steps: StepResult[]): StepResult[] {
  return steps.slice(0, -1);
}

function lastStep(steps: StepResult[]): StepResult {
  return steps[steps.length - 1]!;
}

// ─── The point of the feature ────────────────────────────────────────────────

describe('one test, many cases', () => {
  const CSV = [
    'code,percent',
    'SAVE10,10',
    'NOPE,0',
    'SAVE20,20',
    'ALSO_GONE,0',
    'FREESHIP,0',
  ].join('\n');

  it('runs every row, and each row is its own step with its own status', async () => {
    const execution = await apiPlugin.execute(
      context({ 'fixtures/discounts.csv': CSV }),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'file', path: 'fixtures/discounts.csv' } }),
    );

    // Five cases plus the summary. NOT one step for "the test".
    expect(execution.steps).toHaveLength(6);
    expect(caseSteps(execution.steps).map((s) => s.title)).toEqual([
      'case 1 of 5 — "SAVE10"',
      'case 2 of 5 — "NOPE"',
      'case 3 of 5 — "SAVE20"',
      'case 4 of 5 — "ALSO_GONE"',
      'case 5 of 5 — "FREESHIP"',
    ]);
    expect(caseSteps(execution.steps).map((s) => s.status)).toEqual([
      'PASSED',
      'FAILED',
      'PASSED',
      'FAILED',
      'PASSED',
    ]);
    expect(execution.status).toBe('FAILED');
  });

  it('a failing row does not stop the rest — every case is still asked', async () => {
    await apiPlugin.execute(
      context({ 'fixtures/discounts.csv': CSV }),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'file', path: 'fixtures/discounts.csv' } }),
    );

    // Row 2 failed. Rows 3, 4 and 5 were still sent — the whole value of the
    // feature is knowing WHICH cases fail, and that only exists if they all run.
    expect(hits).toEqual([
      'GET /discounts/SAVE10',
      'GET /discounts/NOPE',
      'GET /discounts/SAVE20',
      'GET /discounts/ALSO_GONE',
      'GET /discounts/FREESHIP',
    ]);
  });

  it('names the failing cases by their key column, never by index', async () => {
    const execution = await apiPlugin.execute(
      context({ 'fixtures/discounts.csv': CSV }),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'file', path: 'fixtures/discounts.csv' } }),
    );

    const summary = lastStep(execution.steps);
    expect(summary.title).toBe('3 of 5 cases passed, 2 failed');
    expect(summary.error?.message).toContain('Failing: "NOPE", "ALSO_GONE"');
    expect(execution.errorMessage).toContain('"NOPE"');
    expect(execution.errorMessage).toContain('"ALSO_GONE"');
    // And the detail of the first failure is still there to act on.
    expect(execution.errorMessage).toContain('Expected HTTP 200, got 404');
  });

  it('carries which hop of the chain broke into the row that broke', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: [
          {
            name: 'look the code up',
            method: 'GET',
            path: '/discounts/{{code}}',
            assertions: { status: 200 },
          },
          {
            name: 'echo it back',
            method: 'GET',
            path: '/echo?code={{code}}',
            assertions: { status: 200 },
          },
        ],
        dataset: { source: 'inline', rows: [{ code: 'SAVE10' }, { code: 'NOPE' }] },
      }),
    );

    expect(caseSteps(execution.steps).map((s) => s.status)).toEqual(['PASSED', 'FAILED']);
    expect(caseSteps(execution.steps)[1]!.error?.message).toBe(
      'step "look the code up": Expected HTTP 200, got 404',
    );
    // The failed hop stopped ITS OWN chain — the second hop of row 2 never ran —
    // without stopping the dataset.
    expect(hits).toEqual(['GET /discounts/SAVE10', 'GET /echo?code=SAVE10', 'GET /discounts/NOPE']);
  });

  it('a fully passing dataset passes, with the summary still on the record', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: LOOKUP_STEPS,
        dataset: { source: 'inline', rows: [{ code: 'SAVE10' }, { code: 'SAVE20' }] },
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toBeNull();
    expect(lastStep(execution.steps)).toMatchObject({
      title: '2 of 2 cases passed',
      status: 'PASSED',
      error: null,
    });
  });
});

// ─── A dataset must never make a test dishonest ──────────────────────────────

describe('a dataset that produced nothing cannot pass', () => {
  it('an empty CSV is SKIPPED, not PASSED, and sends nothing', async () => {
    const execution = await apiPlugin.execute(
      context({ 'fixtures/empty.csv': 'code,percent\n' }),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'file', path: 'fixtures/empty.csv' } }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('no rows');
    expect(hits).toEqual([]);
  });

  it('an empty inline dataset is SKIPPED', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'inline', rows: [] } }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('cannot pass');
  });

  it('a cancelled dataset reports its cases as not evaluated, never as passed', async () => {
    const ctx = context();
    const controller = new AbortController();
    controller.abort();

    const execution = await apiPlugin.execute(
      { ...ctx, signal: controller.signal },
      apiTest({
        steps: LOOKUP_STEPS,
        dataset: { source: 'inline', rows: [{ code: 'SAVE10' }, { code: 'SAVE20' }] },
      }),
    );

    expect(hits).toEqual([]);
    expect(caseSteps(execution.steps).every((s) => s.status === 'SKIPPED')).toBe(true);
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('2 not evaluated');
  });
});

describe('a configuration gap is skipped, never failed', () => {
  it('a malformed CSV is SKIPPED with the line number, and nothing is sent', async () => {
    const broken = ['code,percent', 'SAVE10,10', '"UNTERMINATED,20', 'SAVE20,20'].join('\n');
    const execution = await apiPlugin.execute(
      context({ 'fixtures/discounts.csv': broken }),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'file', path: 'fixtures/discounts.csv' } }),
    );

    // FAILED here would blame the application under test for a typo in a
    // spreadsheet. The line number is what makes it a one-pass fix.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('never closed');
    expect(execution.errorMessage).toContain('(line 3)');
    expect(hits).toEqual([]);
  });

  it('a row with the wrong number of values names its line', async () => {
    const ragged = ['code,percent', 'SAVE10,10', 'OOPS,20,extra'].join('\n');
    const execution = await apiPlugin.execute(
      context({ 'fixtures/d.csv': ragged }),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'file', path: 'fixtures/d.csv' } }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('3 value(s) where the header declares 2');
    expect(execution.errorMessage).toContain('(line 3)');
  });

  it('a missing fixture is SKIPPED with where to put it', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'file', path: 'fixtures/nope.csv' } }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('fixtures/nope.csv');
    expect(execution.errorMessage).toContain('fixtures/');
  });

  it('an oversized dataset is refused with the count, before anything is sent', async () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => ({ code: `C${i}` }));
    const execution = await apiPlugin.execute(
      context(),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'inline', rows } }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('100,000 cases');
    expect(execution.errorMessage).toContain('1,000');
    expect(hits).toEqual([]);
  });

  it('an oversized generated range is refused the same way', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: [
          { name: 'echo', method: 'GET', path: '/echo?n={{n}}', assertions: { status: 200 } },
        ],
        dataset: { source: 'range', column: 'n', from: 1, to: 50_000 },
      }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('50,000 cases');
    expect(hits).toEqual([]);
  });

  it('a malformed dataset block is never treated as "no dataset"', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({ steps: LOOKUP_STEPS, dataset: { source: 'spreadsheet', path: 'x.csv' } }),
    );

    // Running the chain once with {{code}} still in the URL, and calling that a
    // result, is the exact suppression this must not do.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('dataset block is invalid');
    expect(hits).toEqual([]);
  });

  it('a placeholder no column can fill is refused up front, naming it', async () => {
    const execution = await apiPlugin.execute(
      context({ 'fixtures/d.csv': 'discount_code\nSAVE10\nSAVE20' }),
      apiTest({
        steps: [
          {
            name: 'look up',
            method: 'GET',
            path: '/discounts/{{discountCode}}',
            assertions: { status: 200 },
          },
        ],
        dataset: { source: 'file', path: 'fixtures/d.csv' },
      }),
    );

    // Without this check every row 404s and two red cases accuse the
    // application of a bug it does not have.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('{{discountCode}}');
    expect(execution.errorMessage).toContain('"discount_code"');
    expect(hits).toEqual([]);
  });

  it('still allows a placeholder an earlier step extracts', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: [
          {
            name: 'look up',
            method: 'GET',
            path: '/discounts/{{code}}',
            assertions: { status: 200 },
            extract: { percent: 'percent' },
          },
          { name: 'echo', method: 'GET', path: '/echo?p={{percent}}', assertions: { status: 200 } },
        ],
        dataset: { source: 'inline', rows: [{ code: 'SAVE10' }] },
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(hits).toEqual(['GET /discounts/SAVE10', 'GET /echo?p=10']);
  });
});

// ─── A row supplies the expectation too, not only the input ──────────────────

describe('a row drives the assertion as well as the request', () => {
  it('interpolates bodyContains per row', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: [
          {
            name: 'look up',
            method: 'GET',
            path: '/discounts/{{code}}',
            assertions: { status: 200, bodyContains: '"percent":{{percent}}' },
          },
        ],
        dataset: {
          source: 'inline',
          rows: [
            { code: 'SAVE10', percent: 10 },
            { code: 'SAVE20', percent: 99 },
          ],
        },
      }),
    );

    expect(caseSteps(execution.steps).map((s) => s.status)).toEqual(['PASSED', 'FAILED']);
    // The message quotes the interpolated expectation, not the template.
    expect(caseSteps(execution.steps)[1]!.error?.message).toContain('percent\\":99');
    expect(caseSteps(execution.steps)[1]!.error?.message).not.toContain('{{percent}}');
  });

  it('matches a text cell against a JSON number, because every CSV cell is text', async () => {
    const execution = await apiPlugin.execute(
      context({ 'fixtures/d.csv': 'code,percent\nSAVE10,10\nSAVE20,20\nFREESHIP,7' }),
      apiTest({
        steps: [
          {
            name: 'look up',
            method: 'GET',
            path: '/discounts/{{code}}',
            assertions: { status: 200, bodyMatches: { percent: '{{percent}}' } },
          },
        ],
        dataset: { source: 'file', path: 'fixtures/d.csv' },
      }),
    );

    // FREESHIP really is 0, not 7. The other two would be thirty false failures
    // in any engine that answers `"10" is not 10`.
    expect(caseSteps(execution.steps).map((s) => s.status)).toEqual(['PASSED', 'PASSED', 'FAILED']);
    expect(execution.errorMessage).toContain('Failing: "FREESHIP"');
  });

  it('leaves a literal expectation written in the spec strictly typed', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: [
          {
            name: 'look up',
            method: 'GET',
            path: '/discounts/SAVE10',
            // No placeholder: the author chose the type, and "10" is not 10.
            assertions: { status: 200, bodyMatches: { percent: '10' } },
          },
        ],
      }),
    );
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('was 10, expected "10"');
  });

  it('refuses a misspelled expectation column up front, like any other', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: [
          {
            name: 'look up',
            method: 'GET',
            path: '/discounts/{{code}}',
            assertions: { status: 200, bodyContains: '{{expectedName}}' },
          },
        ],
        dataset: { source: 'inline', rows: [{ code: 'SAVE10', expected_name: 'ten' }] },
      }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('{{expectedName}}');
    expect(hits).toEqual([]);
  });
});

// ─── A row is data, and data must not become code or credentials ─────────────

describe('a row is data, not a template', () => {
  it('a cell holding {{SECRET}} is text, not a lookup', async () => {
    const ctx = context({}, { VAULT_TOKEN: 'sk-live-do-not-leak' });
    const execution = await apiPlugin.execute(
      ctx,
      apiTest({
        steps: [
          { name: 'echo', method: 'GET', path: '/echo?v={{value}}', assertions: { status: 200 } },
        ],
        dataset: { source: 'inline', rows: [{ value: '{{VAULT_TOKEN}}' }] },
      }),
    );

    expect(execution.status).toBe('PASSED');
    // Substituted text is never rescanned, so the cell stays a literal and the
    // vault is not reachable from a spreadsheet.
    expect(hits[0]).toBe('GET /echo?v={{VAULT_TOKEN}}');
    expect(JSON.stringify(execution)).not.toContain('sk-live-do-not-leak');
  });

  it('a cell cannot add a field to a JSON body', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: [
          {
            name: 'post it',
            method: 'POST',
            path: '/orders',
            body: { note: '{{note}}', admin: false },
            assertions: { status: 200 },
          },
        ],
        dataset: { source: 'inline', rows: [{ note: 'x","admin":true,"junk":"' }] },
      }),
    );

    expect(execution.status).toBe('PASSED');
    // Textual splicing would have produced {"note":"x","admin":true,...}. The
    // value stays a value.
    expect(bodies[0]).toEqual({ note: 'x","admin":true,"junk":"', admin: false });
  });

  it('a cell containing $& is inserted literally', () => {
    expect(interpolateByName('/x/{{v}}', { v: '$&$1$`' })).toBe('/x/$&$1$`');
  });

  it('interpolates into keys and nested values, and leaves non-strings alone', () => {
    expect(
      interpolateJsonValue({ '{{k}}': ['{{v}}', 7, null, { deep: '{{v}}' }] }, { k: 'id', v: 'A' }),
    ).toEqual({ id: ['A', 7, null, { deep: 'A' }] });
  });

  it('refuses to send a request a cell pointed off the base URL', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: [
          { name: 'echo', method: 'GET', path: '{{host}}/echo', assertions: { status: 200 } },
        ],
        dataset: { source: 'inline', rows: [{ host: 'https://exfil.example' }] },
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(caseSteps(execution.steps)[0]!.error?.message).toContain('exfil.example');
    expect(caseSteps(execution.steps)[0]!.error?.message).toContain('was not sent');
    expect(hits).toEqual([]);
  });

  it('but a SPEC variable may still point a test anywhere', async () => {
    // Same server, different origin — the spec is trusted to choose, data is not.
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        variables: { apiBase: `http://localhost:${port}` },
        steps: [
          { name: 'echo', method: 'GET', path: '{{apiBase}}/echo', assertions: { status: 200 } },
        ],
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(hits).toEqual(['GET /echo']);
  });
});

// ─── Nothing changes for a test without a dataset ────────────────────────────

describe('a test with no dataset behaves exactly as before', () => {
  it('reports one step per hop, titled by method and path', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        variables: { code: 'SAVE10' },
        steps: [
          {
            name: 'look up',
            method: 'GET',
            path: '/discounts/{{code}}',
            assertions: { status: 200 },
          },
          { name: 'echo', method: 'GET', path: '/echo?a=1', assertions: { status: 200 } },
        ],
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(execution.steps.map((s) => s.title)).toEqual([
      'GET /discounts/{{code}} — look up',
      'GET /echo?a=1 — echo',
    ]);
  });

  it('still skips the rest of a chain once a hop fails', async () => {
    const execution = await apiPlugin.execute(
      context(),
      apiTest({
        steps: [
          { name: 'look up', method: 'GET', path: '/discounts/NOPE', assertions: { status: 200 } },
          { name: 'echo', method: 'GET', path: '/echo?a=1', assertions: { status: 200 } },
        ],
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.steps.map((s) => s.status)).toEqual(['FAILED', 'SKIPPED']);
    expect(execution.errorMessage).toBe('Expected HTTP 200, got 404');
    expect(hits).toEqual(['GET /discounts/NOPE']);
  });
});

// ─── Sources ─────────────────────────────────────────────────────────────────

describe('dataset sources', () => {
  it('reads a JSON fixture', () => {
    const rows = loadDataset(
      { source: 'file', path: 'fixtures/d.json', format: 'auto' },
      { 'fixtures/d.json': '[{"code":"A","percent":10},{"code":"B","percent":20}]' },
    );
    expect(rows.map((r) => r.values)).toEqual([
      { code: 'A', percent: '10' },
      { code: 'B', percent: '20' },
    ]);
  });

  it('finds a fixture written with or without the fixtures/ prefix', () => {
    const rows = loadDataset(
      { source: 'file', path: 'd.csv', format: 'auto' },
      {
        'fixtures/d.csv': 'code\nA',
      },
    );
    expect(rows).toHaveLength(1);
  });

  it('generates an inclusive range, including decimal steps', () => {
    expect(
      loadDataset({ source: 'range', column: 'qty', from: 1, to: 4, step: 1 }).map((r) => r.key),
    ).toEqual(['1', '2', '3', '4']);
    // 0.1 steps in binary floating point are how a boundary-value dataset
    // silently loses its last case.
    expect(
      loadDataset({ source: 'range', column: 'x', from: 0, to: 0.3, step: 0.1 }).map((r) => r.key),
    ).toEqual(['0', '0.1', '0.2', '0.3']);
  });

  it('refuses a range that counts down rather than producing nothing', () => {
    expect(() => loadDataset({ source: 'range', column: 'n', from: 10, to: 1, step: 1 })).toThrow(
      /counts down/,
    );
  });

  it('fills a ragged JSON row so a missing cell is empty, not an unresolved name', () => {
    const rows = loadDataset(
      { source: 'file', path: 'd.json', format: 'json' },
      { 'd.json': '[{"a":"1","b":"2"},{"a":"3"}]' },
    );
    expect(rows[1]!.values).toEqual({ a: '3', b: '' });
  });

  it('rejects a JSON dataset that is not an array of flat objects', () => {
    expect(() => parseJsonRows('{"a":1}')).toThrow(/array of row objects/);
    expect(() => parseJsonRows('[{"a":{"b":1}}]')).toThrow(/only carry a string, number/);
  });

  it('gives a line number for invalid JSON', () => {
    let error: DatasetConfigError | null = null;
    try {
      parseJsonRows('[\n  {"a": 1},\n  {"a": 1,}\n]');
    } catch (err) {
      error = err as DatasetConfigError;
    }
    expect(error).toBeInstanceOf(DatasetConfigError);
    expect(error!.line).toBe(3);
  });

  it('is still a configuration error when V8 offers no position at all', () => {
    // The snippet-form message ("Unexpected token 'o', ...") carries neither a
    // line nor an offset. Losing the line number must not turn a bad fixture
    // into a failing test.
    let error: DatasetConfigError | null = null;
    try {
      parseJsonRows('[\n  {"a": 1},\n  {"a": oops}\n]');
    } catch (err) {
      error = err as DatasetConfigError;
    }
    expect(error).toBeInstanceOf(DatasetConfigError);
    expect(error!.detail).toContain('is not valid JSON');
  });
});

// ─── CSV ─────────────────────────────────────────────────────────────────────

describe('CSV', () => {
  it('handles quotes, embedded commas, embedded newlines, CRLF and a BOM', () => {
    const csv = '﻿code,note\r\nA,"has, a comma"\r\nB,"has\na newline"\r\nC,"a ""quote"""\r\n';
    expect(parseCsv(csv).rows).toEqual([
      { code: 'A', note: 'has, a comma' },
      { code: 'B', note: 'has\na newline' },
      { code: 'C', note: 'a "quote"' },
    ]);
  });

  it('counts an embedded newline against the file, so later line numbers are right', () => {
    let error: DatasetConfigError | null = null;
    try {
      parseCsv('code,note\nA,"two\nlines"\nB,extra,field\n');
    } catch (err) {
      error = err as DatasetConfigError;
    }
    // The B row is physically on line 4 because the quoted value used two lines.
    expect(error!.line).toBe(4);
  });

  it('rejects text after a closing quote instead of guessing', () => {
    expect(() => parseCsv('code\n"A"B\n')).toThrow(/after a closing quote/);
  });

  it('rejects a column name that could never be a placeholder', () => {
    expect(() => parseCsv('discount code\nA')).toThrow(/\{\{placeholder\}\}/);
    expect(() => parseCsv('code,code\nA,B')).toThrow(/two columns named/);
    expect(() => parseCsv('code,\nA,B')).toThrow(/empty column name/);
  });

  it('ignores blank lines and a trailing newline', () => {
    expect(parseCsv('code\nA\n\nB\n').rows).toEqual([{ code: 'A' }, { code: 'B' }]);
  });

  it('keeps an empty cell as an empty value rather than dropping the row', () => {
    expect(parseCsv('a,b\n,2\n').rows).toEqual([{ a: '', b: '2' }]);
  });
});

// ─── Naming rows ─────────────────────────────────────────────────────────────

describe('naming a row', () => {
  it('uses the declared key column', () => {
    const rows = loadDataset({
      source: 'inline',
      keyColumn: 'label',
      rows: [{ id: '1', label: 'euros' }],
    });
    expect(rows[0]!.key).toBe('euros');
  });

  it('falls back to a conventionally named column, then to the first one', () => {
    expect(loadDataset({ source: 'inline', rows: [{ n: '1', code: 'SAVE10' }] })[0]!.key).toBe(
      'SAVE10',
    );
    expect(loadDataset({ source: 'inline', rows: [{ n: '1', z: '2' }] })[0]!.key).toBe('1');
  });

  it('falls back to a positional name when the key cell is blank', () => {
    expect(loadDataset({ source: 'inline', rows: [{ code: '  ' }] })[0]!.key).toBe('row 1');
  });

  it('rejects a key column the dataset does not have', () => {
    expect(() => loadDataset({ source: 'inline', keyColumn: 'nope', rows: [{ a: '1' }] })).toThrow(
      /not a column/,
    );
  });
});

// ─── The summary ─────────────────────────────────────────────────────────────

describe('the summary', () => {
  const outcomes = (n: number, failing: number[]): Parameters<typeof summariseDataset>[0] =>
    Array.from({ length: n }, (_, i) => ({
      index: i,
      key: `CASE${i + 1}`,
      status: failing.includes(i) ? ('FAILED' as const) : ('PASSED' as const),
    }));

  it('counts, and names the failures', () => {
    const summary = summariseDataset(outcomes(30, [16]));
    expect(summary).toMatchObject({ total: 30, passed: 29, failed: 1, failedKeys: ['CASE17'] });
    expect(formatDatasetSummary(summary)).toBe('30 cases: 29 passed, 1 failed. Failing: "CASE17".');
  });

  it('abbreviates a long list rather than printing a hundred names', () => {
    const line = formatDatasetSummary(summariseDataset(outcomes(30, [...Array(15).keys()])));
    expect(line).toContain('and 5 more');
  });

  it('reports unevaluated cases separately from failures', () => {
    const line = formatDatasetSummary(
      summariseDataset([
        { index: 0, key: 'A', status: 'PASSED' },
        { index: 1, key: 'B', status: 'SKIPPED' },
      ]),
    );
    expect(line).toBe('2 cases: 1 passed, 0 failed, 1 not evaluated. Not evaluated: "B".');
  });
});

// ─── Opting in ───────────────────────────────────────────────────────────────

describe('parseDatasetConfig', () => {
  it('is null for every spec that has no block', () => {
    expect(parseDatasetConfig({ steps: [] })).toBeNull();
    expect(parseDatasetConfig(null)).toBeNull();
    expect(parseDatasetConfig({ dataset: null })).toBeNull();
  });

  it('throws for a block that is present and wrong, naming what is wrong', () => {
    expect(() =>
      parseDatasetConfig({ dataset: { source: 'inline', rows: [{ 'a b': 1 }] } }),
    ).toThrow(/a column name must start with a letter/);
    expect(() => parseDatasetConfig({ dataset: { source: 'file', path: '/etc/passwd' } })).toThrow(
      /relative path/,
    );
    expect(() =>
      parseDatasetConfig({ dataset: { source: 'range', column: 'n', from: 1, to: 5, step: 0 } }),
    ).toThrow(/step/);
  });
});
