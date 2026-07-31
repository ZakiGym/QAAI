/**
 * Parser tests, driven by real fixtures.
 *
 * The fixtures under __fixtures__ are the shapes the tools actually emit, not
 * schemas invented here — Surefire's `<flakyFailure>`, jest-junit's duplicated
 * `classname`, node:test's indented subtests, .NET's `TimeSpan` durations,
 * behave's seconds where cucumber has nanoseconds. Every one of those is a real
 * difference that a "we parse JUnit" claim quietly gets wrong.
 *
 * Three properties matter more than any individual assertion, and are asserted
 * for every format:
 *
 *   1. no parser throws, on any input;
 *   2. an empty report is never a pass;
 *   3. "0 tests" and "no report" are distinguishable.
 *
 * The last section proves all three exhaustively over the whole registry, so a
 * format added later cannot quietly opt out of them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repairTruncatedJson, timeSpanToMs } from './common.js';
import {
  detectReportFormat,
  parseCucumberJson,
  parseGoJson,
  parseJestJson,
  parseJUnitXml,
  parseNUnit3,
  parsePytestJson,
  parseReport,
  parseRSpecJson,
  parseTap,
  parseTrx,
  REPORT_FORMATS,
  resolveReportFormat,
  summariseReport,
  toStepResults,
} from './index.js';
import type { ParsedReport, ReportTest } from './types.js';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

/** Terser assertions: the four fields a caller actually branches on. */
const shape = (t: ReportTest) => ({
  suite: t.suite,
  name: t.name,
  status: t.status,
  durationMs: t.durationMs,
});
const byName = (r: ParsedReport, name: string): ReportTest => {
  const found = r.tests.find((t) => t.name === name);
  if (!found)
    throw new Error(`no test named "${name}" in [${r.tests.map((t) => t.name).join(', ')}]`);
  return found;
};

// ─── junit-xml ───────────────────────────────────────────────────────────────

describe('junit-xml — Surefire', () => {
  const report = parseJUnitXml(fixture('junit-surefire.xml'));

  it('reads the bare <testsuite> root Surefire writes, with no <testsuites> wrapper', () => {
    expect(report.presence).toBe('ok');
    expect(report.suiteName).toBe('com.example.calc.CalculatorTest');
    expect(report.totals).toEqual({ tests: 5, passed: 2, failed: 2, skipped: 1, durationMs: 1216 });
  });

  it('treats <error> as a failure and converts seconds to milliseconds', () => {
    expect(shape(byName(report, 'dividesTwoNumbers'))).toEqual({
      suite: 'com.example.calc.CalculatorTest',
      name: 'dividesTwoNumbers',
      status: 'failed',
      durationMs: 3,
    });
    expect(byName(report, 'throwsOnDivideByZero').status).toBe('failed');
    expect(byName(report, 'throwsOnDivideByZero').failureMessage).toContain('divisor');
  });

  it('splits the message attribute from the stack in the element body', () => {
    const failed = byName(report, 'dividesTwoNumbers');
    expect(failed.failureMessage).toBe('expected: <2> but was: <3>');
    expect(failed.stack).toContain(
      'at com.example.calc.CalculatorTest.dividesTwoNumbers(CalculatorTest.java:42)',
    );
  });

  it('counts a <flakyFailure> rerun as PASSED, because that test passed on retry', () => {
    // Surefire records the failed attempts of a test that eventually passed.
    // Matching `<failure` loosely marks a green suite red forever.
    expect(shape(byName(report, 'flakyNetworkCall'))).toEqual({
      suite: 'com.example.calc.CalculatorTest',
      name: 'flakyNetworkCall',
      status: 'passed',
      durationMs: 1204,
    });
    expect(report.diagnostics.join(' ')).toContain('passed on retry');
  });

  it('reads <skipped> as skipped rather than as a pass', () => {
    expect(byName(report, 'skippedUntilTicket123').status).toBe('skipped');
  });
});

describe('junit-xml — pytest', () => {
  const report = parseJUnitXml(fixture('junit-pytest.xml'));

  it('descends through the <testsuites> wrapper pytest adds', () => {
    expect(report.presence).toBe('ok');
    expect(report.suiteName).toBe('pytest');
    expect(report.totals).toEqual({ tests: 4, passed: 2, failed: 1, skipped: 1, durationMs: 147 });
  });

  it('uses the dotted classname as the suite', () => {
    expect(shape(byName(report, 'test_adds_item'))).toEqual({
      suite: 'tests.test_cart',
      name: 'test_adds_item',
      status: 'passed',
      durationMs: 1,
    });
  });

  it('decodes the entities pytest escapes into the failure body', () => {
    const failed = byName(report, 'test_total_with_tax');
    expect(failed.failureMessage).toBe('assert 10.8 == 10.79');
    expect(failed.stack).toContain('assert cart.total(tax=0.2) == 10.79');
    expect(failed.stack).toContain('<bound method Cart.total of Cart(items=1)>');
  });
});

describe('junit-xml — a real pytest 8.4 run whose counters do not add up', () => {
  // Captured from an actual `pytest --junitxml` run. pytest counts phase
  // reports, not elements: a test that PASSES and then errors in teardown is
  // counted twice, so `tests="6"` sits on a file with five <testcase> elements
  // and nothing whatsoever wrong with it.
  const report = parseJUnitXml(fixture('junit-pytest-teardown-error.xml'));

  it('does not call an intact file truncated because an emitter counts differently', () => {
    expect(report.truncated).toBe(false);
    // The disagreement is still worth saying; it just is not evidence of loss.
    expect(report.diagnostics.join(' ')).toContain('declares 6 tests but the file contains 5');
  });

  it('reads the teardown error as a failure of the test it belongs to', () => {
    const failed = byName(report, 'test_teardown_leaks');
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toContain('failed on teardown');
    expect(failed.failureMessage).toContain('connection pool was not drained');
  });

  it('reads an xfail written as <skipped type="pytest.xfail">', () => {
    expect(byName(report, 'test_legacy_rounding').status).toBe('skipped');
    expect(report.totals).toEqual({ tests: 5, passed: 1, failed: 2, skipped: 2, durationMs: 21 });
  });

  it('decodes &#10; inside a message attribute', () => {
    expect(byName(report, 'test_total_with_tax').failureMessage).toBe(
      'assert 10.8 == 10.79\n +  where 10.8 = total(tax=0.2)\n +    where total = <test_cart.Cart object at 0x108ca2610>.total',
    );
  });
});

describe('junit-xml — jest-junit', () => {
  const report = parseJUnitXml(fixture('junit-jest.xml'));

  it('does not repeat the title when jest sets classname and name identically', () => {
    // jest-junit's default templates put the same string in both attributes.
    expect(shape(byName(report, 'total sums line items'))).toEqual({
      suite: 'src/checkout/total.test.ts',
      name: 'total sums line items',
      status: 'passed',
      durationMs: 6,
    });
    expect(toStepResults(report)[0]?.title).toBe(
      'src/checkout/total.test.ts › total sums line items',
    );
  });

  it('recovers the message from the body when <failure> has no message attribute', () => {
    const failed = byName(report, 'total applies the tax rate');
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toBe(
      'Error: expect(received).toBe(expected) // Object.is equality',
    );
    expect(failed.stack).toContain('/repo/src/checkout/total.test.ts:22:31');
  });

  it('prefers the <testsuites> wall clock over the sum of the tests', () => {
    expect(report.totals).toEqual({ tests: 4, passed: 2, failed: 1, skipped: 1, durationMs: 2311 });
  });
});

describe('junit-xml — the empty and the broken', () => {
  it('reads a valid report of zero tests as a REPORT, not as an absence', () => {
    const report = parseJUnitXml(fixture('junit-zero-tests.xml'));
    expect(report.presence).toBe('ok');
    expect(report.totals.tests).toBe(0);
    expect(report.truncated).toBe(false);
    // …and zero tests is still not a pass.
    expect(summariseReport(report).status).toBe('SKIPPED');
    expect(summariseReport(report).errorMessage).toContain('no tests');
  });

  it('keeps the tests that reached disk when the writer was killed mid-tag', () => {
    const report = parseJUnitXml(fixture('junit-truncated.xml'));
    expect(report.tests.map((t) => t.name)).toEqual(['addsTwoNumbers', 'subtractsTwoNumbers']);
    expect(report.truncated).toBe(true);
    expect(report.diagnostics.join(' ')).toContain('declares 5 tests');
  });

  it('refuses to call a truncated all-green report a pass', () => {
    const report = parseJUnitXml(fixture('junit-truncated.xml'));
    expect(report.totals.failed).toBe(0);
    expect(summariseReport(report).status).toBe('FAILED');
    expect(summariseReport(report).errorMessage).toContain('incomplete');
  });

  it('ignores test cases printed into <system-out> by the tests themselves', () => {
    const xml = `<testsuite name="s" tests="1">
      <testcase name="real" time="0.001"/>
      <system-out><![CDATA[]]></system-out>
    </testsuite>`;
    // The CDATA above is what a tool printing XML looks like once escaped; the
    // element form below is the case that a naive regex would swallow.
    const withNoise = `<testsuite name="s" tests="1">
      <testcase name="real" time="0.001"/>
      <system-out><testcase name="printed by the test" time="9"/></system-out>
    </testsuite>`;
    expect(parseJUnitXml(xml).totals.tests).toBe(1);
    expect(parseJUnitXml(withNoise).tests.map((t) => t.name)).toEqual(['real']);
  });

  it('handles an unescaped > inside an attribute value, which is legal XML', () => {
    const xml =
      `<testsuite name="s" tests="1"><testcase name="renders <Cart> => total" classname="Ui" time="0.5"/></testsuite>`.replace(
        '<Cart>',
        '&lt;Cart&gt;',
      );
    const report = parseJUnitXml(xml);
    expect(report.tests.map((t) => t.name)).toEqual(['renders <Cart> => total']);
    expect(report.tests[0]?.durationMs).toBe(500);
  });

  it('promotes a suite-level <error> to a failing test rather than losing it', () => {
    const xml = `<testsuite name="com.example.BootTest" tests="0" errors="1">
      <error message="Could not initialise DataSource" type="java.lang.IllegalStateException">at Boot.main(Boot.java:9)</error>
    </testsuite>`;
    const report = parseJUnitXml(xml);
    expect(report.totals.failed).toBe(1);
    expect(report.tests[0]?.failureMessage).toBe('Could not initialise DataSource');
  });
});

// ─── tap ─────────────────────────────────────────────────────────────────────

describe('tap — node:test subtests', () => {
  // Captured from a real `node --test --test-reporter=tap` run (node 25).
  const report = parseTap(fixture('tap-node-test.tap'));

  it('reports the leaf tests once, not the leaves plus their rollup point', () => {
    // node's own trailer says "# tests 4 / # fail 2" because it counts the
    // parent alongside its children. There are three tests.
    expect(report.tests.map((t) => t.name)).toEqual([
      'adds an item',
      'applies the tax rate',
      'handles foreign currency',
    ]);
    expect(report.totals).toEqual({ tests: 3, passed: 1, failed: 1, skipped: 1, durationMs: 0 });
  });

  it('uses the enclosing subtest as the suite', () => {
    expect(report.tests.every((t) => t.suite === 'cart')).toBe(true);
  });

  it('reads the YAML diagnostics block, including its block scalars', () => {
    const failed = byName(report, 'applies the tax rate');
    // node:test names the key `error`, not the spec's `message`, and writes it
    // as a `|-` block with a trailing blank line inside.
    expect(failed.failureMessage).toBe('Expected values to be strictly equal:\n\n10.8 !== 10.79');
    expect(failed.stack).toContain('TestContext.<anonymous> (/repo/cart.test.js:6:55)');
    expect(failed.stack).toContain(
      'async startSubtestAfterBootstrap (node:internal/test_runner/harness:358:3)',
    );
  });

  it('reads duration_ms out of the YAML, since TAP has no duration of its own', () => {
    // 0.488625 ms — sub-millisecond, and milliseconds are the unit the rest of
    // the system speaks, so it rounds to 0 rather than being scaled up.
    expect(byName(report, 'applies the tax rate').durationMs).toBe(0);
    expect(byName(report, 'applies the tax rate').status).toBe('failed');
  });

  it('treats a `# SKIP` directive as skipped even though the line says ok', () => {
    expect(byName(report, 'handles foreign currency').status).toBe('skipped');
  });
});

describe('tap — flat tape output', () => {
  // Captured from a real `tape` run. tape indents its YAML keys past the `---`,
  // where node:test does not; both are valid TAP 13 and both have to work.
  const report = parseTap(fixture('tap-tape.tap'));

  it('reads tape’s deeper-indented YAML keys', () => {
    const failed = byName(report, 'should be deeply equivalent');
    expect(failed.status).toBe('failed');
    // tape supplies no `message`; the reader assembles one from the operator
    // and the two values, which is the only description of the failure it gives.
    expect(failed.failureMessage).toBe(
      'operator: deepEqual\nexpected: { total: 10.79 }\nactual: { total: 10.8 }',
    );
    expect(failed.stack).toContain(
      'at Test.tapeDeepEqual (/repo/node_modules/tape/lib/test.js:815:7)',
    );
  });

  it('follows the TAP spec on TODO: a `not ok … # TODO` is not a failure', () => {
    // tape agrees — its own trailer reads "# pass 2 / # fail 1" for a file with
    // two `not ok` lines, because the TODO one is an acknowledged known-bad
    // test and does not count against the run.
    expect(byName(report, 'write this').status).toBe('skipped');
    expect(report.totals).toEqual({ tests: 3, passed: 1, failed: 1, skipped: 1, durationMs: 0 });
  });
});

describe('tap — truncated', () => {
  const report = parseTap(fixture('tap-truncated.tap'));

  it('uses the plan to prove tests are missing', () => {
    expect(report.tests).toHaveLength(3);
    expect(report.truncated).toBe(true);
    expect(report.diagnostics.join(' ')).toContain('plans 40 tests');
  });

  it('notices the unterminated YAML block', () => {
    expect(report.diagnostics.join(' ')).toContain('never closed');
    expect(byName(report, 'migrates the schema').failureMessage).toBe(
      'relation "users" already exists',
    );
  });

  it('reports a header-only stream as written-but-empty, never as a pass', () => {
    const report = parseTap('TAP version 13\n');
    expect(report.presence).toBe('ok');
    expect(report.totals.tests).toBe(0);
    expect(report.truncated).toBe(true);
    expect(summariseReport(report).status).not.toBe('PASSED');
  });

  it('honours a `1..0 # SKIP` plan as a real report of nothing', () => {
    const report = parseTap('TAP version 13\n1..0 # SKIP no database configured\n');
    expect(report.presence).toBe('ok');
    expect(report.totals.tests).toBe(0);
    expect(report.diagnostics.join(' ')).toContain('no database configured');
  });

  it('records a Bail out! as a stop, not as the end of a healthy run', () => {
    const report = parseTap('TAP version 13\n1..3\nok 1 - first\nBail out! database is on fire\n');
    expect(report.truncated).toBe(true);
    expect(report.diagnostics.join(' ')).toContain('database is on fire');
  });
});

// ─── go-json ─────────────────────────────────────────────────────────────────

describe('go-json', () => {
  const report = parseGoJson(fixture('go-test.jsonl'));

  it('counts tests, and never the package-level events that look just like them', () => {
    expect(report.tests.map((t) => t.name)).toEqual([
      'TestAddItem',
      'TestTotal/no_tax',
      'TestTotal/with_tax',
      'TestCheckoutIntegration',
    ]);
    expect(report.totals).toEqual({ tests: 4, passed: 2, failed: 1, skipped: 1, durationMs: 105 });
  });

  it('drops the parent of a subtest, which only fails because its child did', () => {
    expect(report.tests.find((t) => t.name === 'TestTotal')).toBeUndefined();
    expect(report.totals.failed).toBe(1);
  });

  it('keeps a parent that failed on its own, with no failing subtest', () => {
    const ndjson = [
      '{"Action":"run","Package":"p","Test":"TestParent"}',
      '{"Action":"run","Package":"p","Test":"TestParent/child"}',
      '{"Action":"pass","Package":"p","Test":"TestParent/child","Elapsed":0.001}',
      '{"Action":"output","Package":"p","Test":"TestParent","Output":"    p_test.go:9: cleanup failed\\n"}',
      '{"Action":"fail","Package":"p","Test":"TestParent","Elapsed":0.004}',
    ].join('\n');
    const parsed = parseGoJson(ndjson);
    expect(parsed.tests.map((t) => `${t.name}:${t.status}`)).toEqual([
      'TestParent:failed',
      'TestParent/child:passed',
    ]);
  });

  it('converts Elapsed seconds to milliseconds', () => {
    expect(byName(report, 'TestAddItem').durationMs).toBe(2);
    expect(byName(report, 'TestTotal/no_tax').durationMs).toBe(1);
  });

  it('strips go test framing from the failure message', () => {
    const failed = byName(report, 'TestTotal/with_tax');
    expect(failed.failureMessage).toContain('cart_test.go:41: total with tax = 10.8, want 10.79');
    expect(failed.failureMessage).not.toContain('=== RUN');
  });

  it('turns a package that failed to BUILD into a failing test', () => {
    // The headline case: a build error produces no test events at all, so
    // counting events reports "0 tests, nothing failed" for code that does not
    // compile.
    const build = parseGoJson(fixture('go-build-failed.jsonl'));
    expect(build.totals.tests).toBe(1);
    expect(build.totals.failed).toBe(1);
    expect(build.tests[0]?.name).toContain('package failed before any test ran');
    expect(build.tests[0]?.failureMessage).toContain('undefined: NewCheckout');
    expect(summariseReport(build).status).toBe('FAILED');
  });

  it('flags a test that started and never reported, and the half-written last line', () => {
    const report = parseGoJson(fixture('go-truncated.jsonl'));
    expect(report.truncated).toBe(true);
    expect(byName(report, 'TestAddItem').status).toBe('passed');
    expect(byName(report, 'TestTotal').status).toBe('failed');
    expect(byName(report, 'TestTotal').failureMessage).toContain('never reported a result');
  });
});

// ─── trx ─────────────────────────────────────────────────────────────────────

describe('trx', () => {
  const report = parseTrx(fixture('dotnet.trx'));

  it('parses TimeSpan durations as 100-nanosecond ticks, not milliseconds', () => {
    // "00:00:01.2345678" is 1.2345678 s = 1234.5678 ms. The fraction is seven
    // digits of 100 ns ticks; reading it as milliseconds gives 1 234 567 ms —
    // twenty minutes for a one-second test.
    expect(byName(report, 'Divide_ByZero_Throws').durationMs).toBe(1235);
    expect(byName(report, 'Add_ReturnsSum').durationMs).toBe(12); // 00:00:00.0123456
  });

  it('converts the whole TimeSpan grammar', () => {
    expect(timeSpanToMs('00:00:00.0123456')).toBe(12);
    expect(timeSpanToMs('00:01:02.5000000')).toBe(62500);
    expect(timeSpanToMs('1.02:00:00.0000000')).toBe(93_600_000);
    expect(timeSpanToMs('00:00:00')).toBe(0);
    expect(timeSpanToMs('nonsense')).toBe(0);
    expect(timeSpanToMs(undefined)).toBe(0);
  });

  it('reports xUnit theory rows and not their rollup parent', () => {
    expect(report.tests.map((t) => t.name)).toEqual([
      'Add_ReturnsSum',
      'Divide_ByZero_Throws',
      'Persists_ToDatabase',
      'Rounds(value: 1.005)',
      'Rounds(value: 2.675)',
    ]);
    // durationMs is the run's own wall clock from <Times>, not the sum of the
    // tests — parallel test hosts make those two very different numbers.
    expect(report.totals).toEqual({ tests: 5, passed: 2, failed: 2, skipped: 1, durationMs: 2123 });
  });

  it('takes the class from <TestDefinitions> rather than splitting the dotted name', () => {
    expect(byName(report, 'Rounds(value: 2.675)').suite).toBe('Shop.Tests.CalculatorTests');
  });

  it('maps NotExecuted to skipped', () => {
    expect(byName(report, 'Persists_ToDatabase').status).toBe('skipped');
  });

  it('decodes the hex character references TRX uses for every newline', () => {
    const failed = byName(report, 'Divide_ByZero_Throws');
    expect(failed.failureMessage).toBe(
      'Assert.Throws() Failure: No exception was thrown\r\nExpected: typeof(System.DivideByZeroException)',
    );
    expect(failed.stack).toContain('CalculatorTests.cs:line 42');
  });
});

// ─── nunit3 ──────────────────────────────────────────────────────────────────

describe('nunit3', () => {
  const report = parseNUnit3(fixture('nunit3.xml'));

  it('reads seconds — the same project’s TRX reports the same numbers as TimeSpans', () => {
    expect(byName(report, 'Add_ReturnsSum').durationMs).toBe(2);
    expect(byName(report, 'Divide_ByZero_Throws').durationMs).toBe(15);
    expect(report.totals.durationMs).toBe(512);
  });

  it('uses the nearest enclosing fixture as the suite, not the assembly', () => {
    expect(byName(report, 'Add_ReturnsSum').suite).toBe('Shop.Tests.CalculatorTests');
  });

  it('splits <message> from <stack-trace>', () => {
    const failed = byName(report, 'Divide_ByZero_Throws');
    expect(failed.failureMessage).toBe(
      'Expected: <System.DivideByZeroException>\n  But was:  no exception thrown',
    );
    expect(failed.stack).toContain('CalculatorTests.cs:line 42');
  });

  it('maps Ignored to skipped', () => {
    expect(byName(report, 'Persists_ToDatabase').status).toBe('skipped');
  });

  it('keeps a fixture whose OneTimeSetUp exploded, which has no test cases at all', () => {
    const failed = byName(report, 'CheckoutTests (suite-level failure)');
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toContain('STRIPE_KEY is not configured');
    expect(report.totals).toEqual({ tests: 5, passed: 2, failed: 2, skipped: 1, durationMs: 512 });
  });

  it('names an NUnit 2 file instead of silently reporting nothing', () => {
    const v2 = parseNUnit3(
      '<?xml version="1.0"?><test-results total="3"><test-suite name="x"/></test-results>',
    );
    expect(v2.presence).toBe('unreadable');
    expect(v2.diagnostics.join(' ')).toContain('NUnit 2');
  });
});

// ─── jest-json ───────────────────────────────────────────────────────────────

describe('jest-json', () => {
  const report = parseJestJson(fixture('jest.json'));

  it('keeps durations as milliseconds — this format needs no conversion', () => {
    expect(byName(report, 'sums line items').durationMs).toBe(6);
    expect(byName(report, 'applies the tax rate').durationMs).toBe(3);
    expect(byName(report, 'handles foreign currency').durationMs).toBe(0); // duration: null
  });

  it('builds the suite from the file plus the describe() chain', () => {
    expect(byName(report, 'sums line items').suite).toBe(
      '/repo/src/checkout/total.test.ts › total',
    );
  });

  it('maps pending to skipped', () => {
    expect(byName(report, 'handles foreign currency').status).toBe('skipped');
  });

  it('turns a suite that failed to import into a failing test', () => {
    // The suite has zero assertionResults: every test in that file is simply
    // absent from the report. Counting assertions alone reports it as clean.
    const broken = report.tests.find((t) => t.name.includes('suite failed to run'));
    expect(broken?.status).toBe('failed');
    expect(broken?.failureMessage).toContain("Cannot find module '../lib/pricing'");
    expect(report.totals).toEqual({ tests: 5, passed: 2, failed: 2, skipped: 1, durationMs: 2104 });
    expect(summariseReport(report).status).toBe('FAILED');
  });

  it('reads Vitest’s --reporter=json, which shares the schema', () => {
    const vitest = parseJestJson(fixture('vitest.json'));
    expect(vitest.totals).toEqual({ tests: 3, passed: 1, failed: 1, skipped: 1, durationMs: 420 });
    expect(byName(vitest, 'falls back to role').durationMs).toBe(12); // 11.9032 ms
    expect(byName(vitest, 'falls back to role').failureMessage).toContain(
      "expected 'button' to be 'link'",
    );
    expect(byName(vitest, 'escapes quotes').status).toBe('skipped');
  });

  it('recovers the tests that reached disk from a half-written file', () => {
    const report = parseJestJson(fixture('jest-truncated.json'));
    expect(report.tests.map((t) => t.name)).toEqual(['sums line items', 'rounds half up']);
    expect(report.truncated).toBe(true);
    expect(report.diagnostics.join(' ')).toContain('stops mid-write');
    // The third record is a fragment with no status. Guessing a verdict for it
    // would be inventing one, so it is dropped and counted.
    expect(report.diagnostics.join(' ')).toContain('incomplete');
    expect(report.totals.failed).toBe(0);
    expect(summariseReport(report).status).toBe('FAILED'); // …and still not a pass
  });

  it('recovers a REAL half-written file — a genuine vitest report cut mid-record', () => {
    // Produced by truncating an actual `vitest --reporter=json` file, which is
    // byte-for-byte what a killed writer leaves behind. It stops inside an
    // `ancestorTitles` array, so nothing after the last complete record can be
    // trusted, and the numbers Jest states up front no longer match.
    const report = parseJestJson(fixture('vitest-truncated.json'));
    expect(report.presence).toBe('ok');
    expect(report.truncated).toBe(true);
    expect(report.tests.length).toBeGreaterThan(5);
    expect(report.tests.length).toBeLessThan(23);
    expect(report.totals.failed).toBe(0); // every recovered test passed…
    expect(summariseReport(report).status).toBe('FAILED'); // …and it is still not a pass
    expect(summariseReport(report).errorMessage).toContain('incomplete');
    expect(report.diagnostics.join(' ')).toContain('numTotalTests: 23');
  });

  it('flags an interrupted run', () => {
    const report = parseJestJson('{"numTotalTests":1,"wasInterrupted":true,"testResults":[]}');
    expect(report.truncated).toBe(true);
    expect(report.diagnostics.join(' ')).toContain('wasInterrupted');
  });
});

// ─── pytest-json ─────────────────────────────────────────────────────────────

describe('pytest-json', () => {
  const report = parsePytestJson(fixture('pytest.json'));

  it('sums setup, call and teardown, in seconds, into one duration', () => {
    expect(byName(report, 'test_adds_item').durationMs).toBe(1); // 0.000123 + 0.001235 + 0.000046
    expect(byName(report, 'TestTotals::test_total_with_tax').durationMs).toBe(5);
    expect(report.totals.durationMs).toBe(234);
  });

  it('splits the nodeid into file and test', () => {
    expect(shape(byName(report, 'TestTotals::test_total_with_tax'))).toEqual({
      suite: 'tests/test_cart.py',
      name: 'TestTotals::test_total_with_tax',
      status: 'failed',
      durationMs: 5,
    });
  });

  it('prefers the one-line crash message and keeps longrepr as the stack', () => {
    const failed = byName(report, 'TestTotals::test_total_with_tax');
    expect(failed.failureMessage).toBe('assert 10.8 == 10.79\n  at /repo/tests/test_cart.py:31');
    expect(failed.stack).toContain('def test_total_with_tax(self):');
  });

  it('finds a failure that happened in teardown, not in call', () => {
    const failed = byName(report, 'test_teardown_leaks');
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toContain('teardown:');
    expect(failed.failureMessage).toContain('connection pool was not drained');
  });

  it('treats xfailed as skipped — an expected failure is not a failure', () => {
    expect(byName(report, 'test_legacy_rounding').status).toBe('skipped');
  });

  it('reads the skip that resolved during setup', () => {
    expect(byName(report, 'test_checkout_needs_network').status).toBe('skipped');
    expect(report.totals).toEqual({ tests: 5, passed: 1, failed: 2, skipped: 2, durationMs: 234 });
  });

  it('turns a collection error into a failing test', () => {
    const json = JSON.stringify({
      exitcode: 2,
      summary: { total: 0, collected: 0 },
      collectors: [
        {
          nodeid: 'tests/test_broken.py',
          outcome: 'failed',
          longrepr: "ImportError: No module named 'stripe'",
        },
      ],
      tests: [],
    });
    const report = parsePytestJson(json);
    expect(report.totals.failed).toBe(1);
    expect(report.tests[0]?.failureMessage).toContain('No module named');
    expect(summariseReport(report).status).toBe('FAILED');
  });

  it('says so when pytest exited non-zero but no test is recorded as failed', () => {
    const json = JSON.stringify({ exitcode: 5, summary: { total: 0 }, tests: [] });
    const report = parsePytestJson(json);
    expect(report.diagnostics.join(' ')).toContain('exited 5');
    expect(summariseReport(report).status).not.toBe('PASSED');
  });
});

// ─── rspec-json ──────────────────────────────────────────────────────────────

describe('rspec-json', () => {
  // Captured from a real `rspec --format json` run (rspec-core 3.13.6).
  const report = parseRSpecJson(fixture('rspec.json'));

  it('reads run_time seconds and the describe chain', () => {
    expect(shape(byName(report, 'adds an item'))).toEqual({
      suite: 'Cart#add',
      name: 'adds an item',
      status: 'passed',
      durationMs: 0, // 0.000229 s
    });
    expect(report.totals).toEqual({ tests: 3, passed: 1, failed: 1, skipped: 1, durationMs: 3 });
  });

  it('maps pending to skipped', () => {
    expect(byName(report, 'handles foreign currency').status).toBe('skipped');
  });

  it('joins the exception class to its message and keeps the backtrace', () => {
    const failed = byName(report, 'applies the tax rate');
    expect(failed.durationMs).toBe(2); // 0.001994 s
    expect(failed.failureMessage).toContain('RSpec::Expectations::ExpectationNotMetError');
    expect(failed.failureMessage).toContain('expected: 10.79');
    expect(failed.stack).toContain('./spec/cart_spec.rb:15');
  });

  it('carves the JSON out of stdout the runner shared with something else', () => {
    const report = parseRSpecJson(fixture('rspec-stdout-noise.json'));
    expect(report.presence).toBe('ok');
    expect(report.diagnostics.join(' ')).toContain('Ignored non-JSON text');
  });

  it('does not report a spec file that failed to LOAD as an empty green run', () => {
    // A real load-error report: zero examples, zero failures, and the whole
    // truth in one field. Every other number in the document says it was fine.
    const report = parseRSpecJson(fixture('rspec-load-error.json'));
    expect(report.totals).toEqual({ tests: 1, passed: 0, failed: 1, skipped: 0, durationMs: 0 });
    expect(report.tests[0]?.name).toContain('outside of examples');
    // `messages` is the only place the actual cause appears.
    expect(report.tests[0]?.failureMessage).toContain(
      'cannot load such file -- definitely_not_a_gem',
    );
    expect(summariseReport(report).status).toBe('FAILED');
  });
});

// ─── cucumber-json ───────────────────────────────────────────────────────────

describe('cucumber-json — Cucumber', () => {
  const report = parseCucumberJson(fixture('cucumber-js.json'));

  it('counts scenarios, not steps, and never counts a background', () => {
    expect(report.tests.map((t) => t.name)).toEqual([
      'Add two numbers',
      'Divide by zero',
      'Apply a coupon',
      'Refund an order',
    ]);
    expect(report.tests.every((t) => t.suite === 'Calculator')).toBe(true);
  });

  it('sums step durations as nanoseconds', () => {
    // 1_234_567 + 234_567 + 345_678 ns = 1.814812 ms.
    expect(byName(report, 'Add two numbers').durationMs).toBe(2);
    expect(byName(report, 'Divide by zero').durationMs).toBe(3);
  });

  it('takes the worst step status as the scenario status', () => {
    const failed = byName(report, 'Divide by zero');
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toContain('When I divide by 0');
    expect(failed.failureMessage).toContain("expected 'Infinity' to equal 'Error'");
  });

  it('fails a scenario whose Before hook threw, though every step is "skipped"', () => {
    const failed = byName(report, 'Apply a coupon');
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toContain('Before hook');
    expect(failed.failureMessage).toContain('coupon service unavailable');
  });

  it('fails a scenario with an undefined step rather than passing what never ran', () => {
    const failed = byName(report, 'Refund an order');
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toContain('No step definition matches this step');
    expect(report.totals).toEqual({ tests: 4, passed: 1, failed: 3, skipped: 0, durationMs: 9 });
  });
});

describe('cucumber-json — Behave', () => {
  // Captured from a real `behave -f json` run (behave 1.3.3).
  const report = parseCucumberJson(fixture('behave.json'));

  it('detects the dialect from `location` where cucumber writes `uri`', () => {
    expect(report.diagnostics.join(' ')).toContain('seconds, not nanoseconds');
  });

  it('reads durations as SECONDS, so sub-millisecond steps stay sub-millisecond', () => {
    // Read as cucumber's nanoseconds, 0.00032 s becomes 0 — which is also what
    // it rounds to here, so the assertion that matters is the other direction:
    // a behave scenario must never be inflated into nanosecond-scale numbers.
    expect(byName(report, 'Add two numbers').durationMs).toBe(0);
    expect(report.totals.durationMs).toBeLessThan(10);
  });

  it('takes the scenario status behave states, and its error_message', () => {
    const failed = byName(report, 'Apply the tax rate');
    expect(failed.status).toBe('failed');
    expect(failed.failureMessage).toContain('Then the total with tax is 10.79');
    expect(failed.failureMessage).toContain('expected total 10.79 with tax, got 10.8');
  });

  it('still reads behave 1.2.6, which wrote error_message as an array of lines', () => {
    const legacy = JSON.stringify([
      {
        keyword: 'Feature',
        name: 'Shopping cart',
        location: 'features/cart.feature:1',
        status: 'failed',
        elements: [
          {
            type: 'scenario',
            keyword: 'Scenario',
            name: 'Apply the tax rate',
            location: 'features/cart.feature:9',
            status: 'failed',
            steps: [
              {
                keyword: 'Then',
                name: 'the total with tax is 10.79',
                result: {
                  status: 'failed',
                  duration: 0.0021,
                  error_message: [
                    'Traceback (most recent call last):',
                    '  assert total == 10.79',
                    'AssertionError',
                  ],
                },
              },
            ],
          },
        ],
      },
    ]);
    const report = parseCucumberJson(legacy);
    expect(report.tests[0]?.failureMessage).toContain('AssertionError');
    expect(report.tests[0]?.durationMs).toBe(2);
  });

  it('uses the feature name as the suite', () => {
    expect(report.tests.every((t) => t.suite === 'Shopping cart')).toBe(true);
    expect(report.totals.tests).toBe(2);
    expect(report.totals.passed).toBe(1);
    expect(report.totals.failed).toBe(1);
  });
});

// ─── the registry ────────────────────────────────────────────────────────────

describe('the dispatcher', () => {
  it('resolves the legacy `junit` id so specs written before the parsers keep working', () => {
    expect(resolveReportFormat('junit')).toBe('junit-xml');
    expect(resolveReportFormat('JUnit-XML')).toBe('junit-xml');
    expect(resolveReportFormat('vitest')).toBe('jest-json');
    expect(resolveReportFormat('behave')).toBe('cucumber-json');
    expect(resolveReportFormat('nonsense')).toBeNull();
  });

  it('sniffs the format when the spec does not name one', () => {
    expect(detectReportFormat(fixture('junit-surefire.xml'))).toBe('junit-xml');
    expect(detectReportFormat(fixture('junit-jest.xml'))).toBe('junit-xml');
    expect(detectReportFormat(fixture('tap-tape.tap'))).toBe('tap');
    expect(detectReportFormat(fixture('go-test.jsonl'))).toBe('go-json');
    expect(detectReportFormat(fixture('dotnet.trx'))).toBe('trx');
    expect(detectReportFormat(fixture('nunit3.xml'))).toBe('nunit3');
    expect(detectReportFormat(fixture('jest.json'))).toBe('jest-json');
    expect(detectReportFormat(fixture('pytest.json'))).toBe('pytest-json');
    expect(detectReportFormat(fixture('cucumber-js.json'))).toBe('cucumber-json');
    expect(detectReportFormat(fixture('rspec.json'))).toBe('rspec-json');
    expect(detectReportFormat(fixture('not-a-report.html'))).toBeNull();
    expect(detectReportFormat('')).toBeNull();
  });

  // `auto` is the default, so a format the parser handles but detection cannot
  // route to is a report we throw away. Both files below are real RSpec output.
  it('sniffs RSpec even when the run produced no examples to look at', () => {
    // A load error is the run where reading the report matters most, and it is
    // exactly the run with no `full_description` anywhere in the file.
    expect(detectReportFormat(fixture('rspec-load-error.json'))).toBe('rspec-json');
    expect(summariseReport(parseReport('rspec-json', fixture('rspec-load-error.json'))).status).toBe(
      'FAILED',
    );
  });

  it('finds the report inside a runner that shared stdout', () => {
    expect(detectReportFormat(fixture('rspec-stdout-noise.json'))).toBe('rspec-json');
    expect(
      summariseReport(parseReport('rspec-json', fixture('rspec-stdout-noise.json'))).status,
    ).toBe('FAILED');
  });

  it('does not read a stray bracket in a log as a Cucumber report', () => {
    // "A top-level array is Cucumber" is only safe for a file that starts with
    // the document. Applied to text carved out of noise it would make every log
    // line containing a bracket look like a suite that passed.
    expect(detectReportFormat('npm warn deprecated foo\n[2026-07-31] starting\n')).toBeNull();
    expect(detectReportFormat('some preamble\n{"unrelated":true}\n')).toBeNull();
    expect(detectReportFormat('preamble\n[{"elements":[],"name":"Cart"}]')).toBe('cucumber-json');
  });

  it('lays steps out end to end so the cockpit scrubber has an order', () => {
    const report = parseJUnitXml(fixture('junit-surefire.xml'));
    const t0 = new Date('2026-07-31T10:00:00.000Z');
    const steps = toStepResults(report, t0);

    expect(steps.map((s) => s.status)).toEqual(['PASSED', 'FAILED', 'FAILED', 'SKIPPED', 'PASSED']);
    expect(steps[0]?.startedAt).toBe('2026-07-31T10:00:00.000Z');
    expect(steps[1]?.startedAt).toBe('2026-07-31T10:00:00.008Z'); // after an 8 ms test
    expect(steps[1]?.error?.message).toBe('expected: <2> but was: <3>');
    expect(steps[1]?.error?.stack).toContain('CalculatorTest.java:42');
    expect(steps[0]?.error).toBeNull();
  });
});

// ─── the invariants, over every format ───────────────────────────────────────

describe('every parser, on every hostile input', () => {
  const hostile: Record<string, string> = {
    // A real zero-byte file, read from disk: the exact artefact a runner that
    // opened its report and died before writing leaves behind.
    'an empty file': fixture('empty.txt'),
    'whitespace only': fixture('whitespace.txt'),
    'an nginx 404 page': fixture('not-a-report.html'),
    'a lone NUL byte': '\0',
    'a half-written XML tag': '<testsuite name="unfinis',
    'a lone closing tag': '</testsuite>',
    'NDJSON of the wrong shape': '{"level":"info"}\n{"level":"info"}',
    'unbalanced XML': '<testsuite><testcase name="a"><failure>oh no',
    'a bare JSON fragment': '{"tests": [{"name":',
    'a JSON array of nothing': '[]',
    'a JSON scalar': '42',
    'binary-ish noise': '\u0001\u0002\u0003\uFFFD\u0000<>&"\'',
    'a very deep nest': `${'['.repeat(500)}${']'.repeat(500)}`,
    'a naked BOM': '\uFEFF',
  };

  for (const format of REPORT_FORMATS) {
    describe(format, () => {
      for (const [label, input] of Object.entries(hostile)) {
        it(`does not throw on ${label}`, () => {
          expect(() => parseReport(format, input)).not.toThrow();
        });

        it(`never reports ${label} as a pass`, () => {
          const report = parseReport(format, input);
          expect(report.totals.passed).toBe(0);
          expect(summariseReport(report).status).not.toBe('PASSED');
        });
      }

      it('distinguishes "no report" from "0 tests"', () => {
        const absent = parseReport(format, fixture('empty.txt'));
        expect(absent.presence).toBe('empty');
        expect(absent.totals.tests).toBe(0);
        expect(summariseReport(absent).errorMessage).toContain('never wrote a result');

        // …and the message for a real report of nothing says something else.
        const unreadable = parseReport(format, fixture('not-a-report.html'));
        expect(unreadable.presence).toBe('unreadable');
        expect(summariseReport(unreadable).errorMessage).not.toContain('never wrote a result');
      });

      it('always returns a fully formed report object', () => {
        const report = parseReport(format, fixture('not-a-report.html'));
        expect(report.format).toBe(format);
        expect(Array.isArray(report.tests)).toBe(true);
        expect(Array.isArray(report.diagnostics)).toBe(true);
        expect(report.totals.tests).toBe(report.tests.length);
        expect(typeof report.totals.durationMs).toBe('number');
      });
    });
  }

  it('reads every fixture with every parser without throwing', () => {
    const fixtures = [
      'junit-surefire.xml',
      'junit-pytest.xml',
      'junit-pytest-teardown-error.xml',
      'junit-jest.xml',
      'junit-zero-tests.xml',
      'junit-truncated.xml',
      'tap-node-test.tap',
      'tap-tape.tap',
      'tap-truncated.tap',
      'go-test.jsonl',
      'go-build-failed.jsonl',
      'go-truncated.jsonl',
      'dotnet.trx',
      'nunit3.xml',
      'jest.json',
      'vitest.json',
      'jest-truncated.json',
      'vitest-truncated.json',
      'pytest.json',
      'rspec.json',
      'rspec-load-error.json',
      'rspec-stdout-noise.json',
      'cucumber-js.json',
      'behave.json',
    ];

    // Cross-parsing is what a mis-set `reportFormat` does in production, and it
    // must produce a diagnostic rather than an exception or a phantom pass.
    for (const name of fixtures) {
      const text = fixture(name);
      for (const format of REPORT_FORMATS) {
        const report = parseReport(format, text);
        expect(report.format).toBe(format);
        if (report.presence !== 'ok') expect(report.diagnostics.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('the JSON repairer', () => {
  it('closes a document cut after a complete value', () => {
    const repaired = repairTruncatedJson('{"a":[{"x":1},{"y":2},{"z"');
    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired as string)).toEqual({ a: [{ x: 1 }, { y: 2 }] });
  });

  it('drops a fragment it cannot prove is a complete value', () => {
    const repaired = repairTruncatedJson('{"a":[1,2,3');
    expect(JSON.parse(repaired as string)).toEqual({ a: [1, 2] });
  });

  it('leaves well-formed JSON alone', () => {
    expect(repairTruncatedJson('{"a":1}')).toBeNull();
  });

  it('is not fooled by a brace inside a string', () => {
    const repaired = repairTruncatedJson('{"a":["}]",{"b":2},"tru');
    expect(JSON.parse(repaired as string)).toEqual({ a: ['}]', { b: 2 }] });
  });
});
