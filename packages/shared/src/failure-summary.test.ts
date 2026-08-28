import { describe, expect, it } from 'vitest';
import {
  FAILURE_KINDS,
  FAILURE_KIND_LABELS,
  classifyFailureKind,
  summariseFailure,
  type FailureKind,
  type FailureSummaryInput,
  type FailureSummaryStep,
} from './failure-summary';

/**
 * Every string in the CASES table below was copied out of the code that emits
 * it — playwright-harness.ts, or a plugin under packages/runner/src/plugins —
 * rather than written to suit the classifier. That is the only version of this
 * test worth having: a table of prose invented here would assert that the
 * regexes match the regexes, and this repo has shipped that mistake before.
 *
 * Each row is a failure a reader would meet, and the assertion is the KIND,
 * because the kind is what tells them which screen to open next.
 */

function step(over: Partial<FailureSummaryStep> = {}): FailureSummaryStep {
  return {
    index: 0,
    title: 'Click the submit button',
    status: 'FAILED',
    errorMessage: null,
    selector: null,
    expected: null,
    actual: null,
    ...over,
  };
}

function failure(over: Partial<FailureSummaryInput> = {}): FailureSummaryInput {
  return { status: 'FAILED', errorMessage: null, ...over };
}

// ─── Real captured failure text, by source ───────────────────────────────────

/** playwright-harness.ts → parseStepError(): Playwright's own message shapes. */
const PW_SELECTOR_MISS = [
  'locator.click: Timeout 30000ms exceeded.',
  'Call log:',
  "  - waiting for locator('#submit-order')",
].join('\n');

const PW_STRICT_MODE = [
  "locator.click: Error: strict mode violation: locator('button') resolved to 3 elements:",
  '    1) <button id="a">Save</button>',
  '    2) <button id="b">Save draft</button>',
  '    3) <button id="c">Save and close</button>',
].join('\n');

const PW_ELEMENT_DISABLED = [
  'locator.click: Timeout 30000ms exceeded.',
  'Call log:',
  "  - waiting for locator('#pay')",
  '  - locator resolved to <button disabled id="pay">Pay</button>',
  '  - element is not enabled',
].join('\n');

const PW_OVERLAY = [
  'locator.click: Timeout 30000ms exceeded.',
  'Call log:',
  "  - waiting for locator('#accept')",
  '  - <div class="cookie-banner">…</div> intercepts pointer events',
].join('\n');

const PW_NAV_NETWORKIDLE = [
  'page.goto: Timeout 30000ms exceeded.',
  'Call log:',
  '  - navigating to "https://staging.example.com/checkout", waiting until "networkidle"',
].join('\n');

const PW_NAV_REFUSED = 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/';

const PW_ASSERTION = [
  'Error: expect(received).toHaveText(expected)',
  '',
  'Expected string: "2"',
  'Received string: "3"',
].join('\n');

const PW_PAGE_ERROR =
  "page.evaluate: TypeError: Cannot read properties of undefined (reading 'id')";

const PW_TEST_TIMEOUT = 'Test timeout of 30000ms exceeded.';

/** playwright-harness.ts, the two branches that produce no report at all. */
const PW_NO_REPORT = 'Playwright produced no report.\nerror TS2307: Cannot resolve ../fixtures';
const PW_PROCESS_TIMEOUT = 'Playwright did not finish within 900s';
const PW_BROWSER_MISSING =
  'chromium is not installed on this worker, so the test was not evaluated. ' +
  'Run `npx playwright install chromium`.';

/** load.ts */
const K6_MISSING =
  'k6 is not installed on this worker. Install it (brew install k6) and re-run — the test itself was not evaluated.';
const K6_NO_SUMMARY = 'k6 produced no summary (exit 1). level=error msg="dial tcp: i/o timeout"';
const K6_P95 = 'p95 was 812ms, over the 500ms threshold';
const K6_ERROR_RATE = '23.50% of requests failed, over the 1.00% threshold';
const K6_NO_REQUESTS = 'k6 sent no requests — check the target URL';
const K6_BAD_SPEC =
  'Load test "Checkout under load" has an invalid spec — scenario.vus: expected number, received string';

/** visual.ts */
const VISUAL_DIFF = '1284 pixels changed (0.412%), over the 0.100% this test allows';
const VISUAL_SIZE =
  'The rendered size changed: baseline 1280×720, now 1280×900. A pixel diff across different sizes ' +
  'is not meaningful, so review the layout change and re-approve the baseline if it is intended.';

/** accessibility.ts */
const AXE_CRITICALS = '3 critical accessibility violation(s): color-contrast, image-alt';
const AXE_UNSCANNED = 'One or more routes could not be scanned';

/** security-smoke.ts */
const SECURITY = '2 security finding(s): missing-csp, cookie-not-httponly';

/** api.ts */
const API_STATUS = 'Expected HTTP 200, got HTTP 500';
const API_CHAIN = 'step "create order": Expected HTTP 201, got HTTP 500';
const API_BODY = 'Body at "data.total" was 4200, expected 4500';
const API_TRANSPORT = 'Request failed: fetch failed';
const API_LATENCY = 'Took 812ms, budget is 500ms';
const API_UNFILLED =
  'Step "checkout" uses {{coupon}}, which no dataset column, variable, secret or earlier extraction ' +
  'provides — no case was executed. The dataset has "user", "total".';

/** database.ts */
const DB_CONNECT =
  'Could not connect to shopdb on db.internal:5432: password authentication failed for user "qaai"';
const DB_ROWS = 'Expected 3 row(s), got 0';

/** contract.ts */
const CONTRACT_REQUIRED = 'response.body.items.0 is missing the required property "currency"';
const CONTRACT_TYPE = 'response.body.total is string, the document declares number';
const CONTRACT_UNREACHABLE = 'The provider could not be reached: ECONNREFUSED 10.0.0.4:8080';

/** external.ts */
const EXTERNAL_LOAD_GAP =
  'The suite could not be loaded, so no test was evaluated: ModuleNotFoundError: No module named ' +
  "'playwright'. This is a dependency missing from the worker, not a failure of the application " +
  'under test — install it in the worker image and re-run.';
const EXTERNAL_NO_REPORT =
  'No report found at reports/junit.xml. Point reportPath at the file your runner writes.';

/** mobile.ts */
const MOBILE_MISSING =
  '`appium` is not installed on this worker, so the test was not evaluated. Install it with: npm i -g appium.';
const MOBILE_EACCES =
  '`maestro` is present but not executable on this worker (EACCES). Fix its permissions ' +
  '(`chmod +x maestro`) and re-run.';
const MOBILE_STOPPED =
  '`maestro test flow.yaml` exceeded 600s and was stopped. Last output: Running flow…';

/** performance.ts */
const PERF_BUDGET =
  'Largest Contentful Paint was 4,100ms (median of 5), over the 2,500ms budget. 1 of 5 loads were ' +
  'inside the budget, so treat this as a signal to investigate rather than a settled regression.';

/** protocol.ts */
const PROTOCOL_NO_ERRORS = 'Expected the operation to return errors, but "errors" was empty';
const PROTOCOL_NO_DATA = 'Response carried neither "data" nor "errors"';

const CASES: ReadonlyArray<readonly [string, string, FailureKind, Partial<FailureSummaryInput>?]> = [
  // Environment gaps: nothing was evaluated, and none of these is the app's fault.
  ['playwright: browser engine absent', PW_BROWSER_MISSING, 'ENVIRONMENT', { status: 'SKIPPED' }],
  ['k6: binary absent', K6_MISSING, 'ENVIRONMENT', { status: 'SKIPPED' }],
  ['mobile: driver absent', MOBILE_MISSING, 'ENVIRONMENT', { status: 'SKIPPED' }],
  ['mobile: driver not executable', MOBILE_EACCES, 'ENVIRONMENT', { status: 'SKIPPED' }],
  ['external: suite would not import', EXTERNAL_LOAD_GAP, 'ENVIRONMENT', { status: 'SKIPPED' }],
  ['external: no report written', EXTERNAL_NO_REPORT, 'ENVIRONMENT', { status: 'SKIPPED' }],

  // The test's own inputs.
  ['load: malformed spec', K6_BAD_SPEC, 'FIXTURE'],
  ['api: placeholder nothing fills', API_UNFILLED, 'FIXTURE'],

  // The runner itself produced nothing.
  ['playwright: no report', PW_NO_REPORT, 'CRASH'],
  ['playwright: process never returned', PW_PROCESS_TIMEOUT, 'CRASH'],
  ['k6: no summary', K6_NO_SUMMARY, 'CRASH'],

  // Transport.
  ['api: transport error', API_TRANSPORT, 'NETWORK'],
  ['database: connection refused', DB_CONNECT, 'NETWORK'],
  ['contract: provider unreachable', CONTRACT_UNREACHABLE, 'NETWORK'],
  ['playwright: goto refused', PW_NAV_REFUSED, 'NETWORK'],

  ['playwright: networkidle never fired', PW_NAV_NETWORKIDLE, 'NAVIGATION'],

  // Locators.
  ['playwright: strict mode violation', PW_STRICT_MODE, 'SELECTOR_AMBIGUOUS'],
  ['playwright: element disabled', PW_ELEMENT_DISABLED, 'ELEMENT_STATE'],
  ['playwright: overlay intercepts the click', PW_OVERLAY, 'ELEMENT_STATE'],
  ['playwright: locator matched nothing', PW_SELECTOR_MISS, 'SELECTOR_NOT_FOUND'],

  ['playwright: uncaught page error', PW_PAGE_ERROR, 'PAGE_ERROR'],

  // Type-led kinds.
  ['visual: pixel diff', VISUAL_DIFF, 'VISUAL_DIFF', { testType: 'VISUAL' }],
  ['visual: size changed', VISUAL_SIZE, 'VISUAL_DIFF', { testType: 'VISUAL' }],
  ['a11y: critical violations', AXE_CRITICALS, 'ACCESSIBILITY', { testType: 'ACCESSIBILITY' }],
  ['a11y: route unscannable', AXE_UNSCANNED, 'ACCESSIBILITY', { testType: 'ACCESSIBILITY' }],
  ['security: blocking findings', SECURITY, 'SECURITY', { testType: 'SECURITY_SMOKE' }],
  ['contract: required property missing', CONTRACT_REQUIRED, 'CONTRACT', { testType: 'CONTRACT' }],
  ['contract: type drift', CONTRACT_TYPE, 'CONTRACT', { testType: 'CONTRACT' }],

  // Numbers against numbers the run owner chose.
  ['load: p95 over threshold', K6_P95, 'BUDGET', { testType: 'LOAD' }],
  ['load: error rate over threshold', K6_ERROR_RATE, 'BUDGET', { testType: 'LOAD' }],
  ['load: no requests sent', K6_NO_REQUESTS, 'BUDGET', { testType: 'LOAD' }],
  ['api: latency budget', API_LATENCY, 'BUDGET'],
  ['performance: LCP budget', PERF_BUDGET, 'BUDGET', { testType: 'PERFORMANCE' }],

  // Assertions.
  ['playwright: expect mismatch', PW_ASSERTION, 'ASSERTION'],
  ['api: status mismatch', API_STATUS, 'ASSERTION'],
  ['api: chained hop mismatch', API_CHAIN, 'ASSERTION'],
  ['api: body mismatch', API_BODY, 'ASSERTION'],
  ['database: row count', DB_ROWS, 'ASSERTION'],
  ['protocol: expected errors', PROTOCOL_NO_ERRORS, 'ASSERTION'],
  ['protocol: neither data nor errors', PROTOCOL_NO_DATA, 'ASSERTION'],

  // Clock.
  ['playwright: bare test timeout', PW_TEST_TIMEOUT, 'TIMEOUT'],
  ['mobile: driver stopped at the cap', MOBILE_STOPPED, 'TIMEOUT'],
];

describe('classifyFailureKind', () => {
  // A plain loop rather than `it.each`: the table's tuples are heterogeneous,
  // and `it.each` widens every column to the union of all four.
  for (const [name, text, expected, over] of CASES) {
    it(name, () => {
      expect(classifyFailureKind(failure({ errorMessage: text, ...over }))).toBe(expected);
    });
  }

  it('reads the failing step, not the test-level summary, when both exist', () => {
    // The test-level message on an E2E result carries an appended determinism
    // hint; the step's message is the one that names the actual failure.
    const summary = summariseFailure(
      failure({
        errorMessage: `${PW_TEST_TIMEOUT}\n\nRe-run this order with QAAI_SEED=8823`,
        steps: [step({ errorMessage: PW_SELECTOR_MISS, selector: "locator('#submit-order')" })],
      }),
    );
    expect(summary?.kind).toBe('SELECTOR_NOT_FOUND');
    expect(summary?.headline).not.toContain('QAAI_SEED');
  });
});

/**
 * Order is the classifier, so the orderings that were actually argued for get
 * their own tests. Each of these texts matches two rules; the assertion is
 * that the one which implies the right FIRST MOVE wins.
 */
describe('precedence between rules that both match', () => {
  const contest = (text: string, over: Partial<FailureSummaryInput> = {}) =>
    classifyFailureKind(failure({ errorMessage: text, ...over }));

  it('a refused connection during goto is a network failure, not a navigation one', () => {
    expect(PW_NAV_REFUSED).toMatch(/page\.goto/);
    expect(contest(PW_NAV_REFUSED)).toBe('NETWORK');
  });

  it('a goto that timed out is a navigation failure, not a bare timeout', () => {
    expect(PW_NAV_NETWORKIDLE).toMatch(/Timeout \d+ms exceeded/);
    expect(contest(PW_NAV_NETWORKIDLE)).toBe('NAVIGATION');
  });

  it('a locator that timed out is a selector failure, not a bare timeout', () => {
    expect(PW_SELECTOR_MISS).toMatch(/Timeout \d+ms exceeded/);
    expect(contest(PW_SELECTOR_MISS)).toBe('SELECTOR_NOT_FOUND');
  });

  it('an element that was found but disabled is not reported as a missing selector', () => {
    expect(PW_ELEMENT_DISABLED).toMatch(/waiting for locator\(/);
    expect(contest(PW_ELEMENT_DISABLED)).toBe('ELEMENT_STATE');
  });

  it('a missing dependency wins over the timeout wording in the same message', () => {
    const both =
      '`appium` is not installed on this worker, so the test was not evaluated. ' +
      'Install it with: npm i -g appium. Timeout 30000ms exceeded.';
    expect(contest(both, { status: 'SKIPPED' })).toBe('ENVIRONMENT');
  });

  it('an assertion with both sides recorded beats the timeout it was retried under', () => {
    const summary = summariseFailure(
      failure({
        steps: [
          step({
            errorMessage: PW_ASSERTION,
            expected: '"2"',
            actual: '"3"',
          }),
        ],
      }),
    );
    expect(summary?.kind).toBe('ASSERTION');
  });
});

describe('the headline', () => {
  it('speaks in the words of the assertion, not the stack', () => {
    const summary = summariseFailure(
      failure({
        steps: [step({ errorMessage: PW_ASSERTION, expected: '"3"', actual: '"2"' })],
      }),
    );
    expect(summary?.headline).toBe('Expected "3", got "2"');
  });

  it('names the locator that matched nothing', () => {
    const summary = summariseFailure(
      failure({ steps: [step({ errorMessage: PW_SELECTOR_MISS })] }),
    );
    expect(summary?.headline).toBe("Nothing on the page matched locator('#submit-order')");
  });

  it('counts the elements an ambiguous locator matched', () => {
    const summary = summariseFailure(failure({ steps: [step({ errorMessage: PW_STRICT_MODE })] }));
    expect(summary?.headline).toBe(
      "locator('button') matched 3 elements, and the step needs exactly one",
    );
  });

  it('says how long a bare timeout waited, in the step that was waiting', () => {
    const summary = summariseFailure(
      failure({
        status: 'TIMED_OUT',
        steps: [step({ title: 'Wait for the receipt', errorMessage: PW_TEST_TIMEOUT })],
      }),
    );
    expect(summary?.headline).toBe('Timed out after 30s in "Wait for the receipt"');
  });

  it('drops the call log and the stack frames', () => {
    const summary = summariseFailure(
      failure({
        errorMessage: ['Error: something specific broke', 'Call log:', '  - waiting', '    at spec.ts:4:1'].join(
          '\n',
        ),
      }),
    );
    expect(summary?.headline).toBe('something specific broke');
  });

  it('truncates rather than pasting a paragraph at the top of the run', () => {
    const summary = summariseFailure(failure({ errorMessage: `${'x'.repeat(400)} tail` }));
    expect(summary?.headline.length).toBeLessThanOrEqual(200);
    expect(summary?.headline.endsWith('…')).toBe(true);
  });
});

describe('a failure it cannot classify', () => {
  const nonsense = 'Widget reconciliation aborted at phase 3 (code 0x8817)';

  it('says so instead of inventing a kind', () => {
    const summary = summariseFailure(failure({ errorMessage: nonsense }));
    expect(summary?.classified).toBe(false);
    expect(summary?.kind).toBe('UNKNOWN');
  });

  it('shows the raw error verbatim as the headline', () => {
    const summary = summariseFailure(failure({ errorMessage: nonsense }));
    expect(summary?.headline).toBe(nonsense);
    expect(summary?.raw).toBe(nonsense);
  });

  it('offers no next action, because it has no idea what the next action is', () => {
    expect(summariseFailure(failure({ errorMessage: nonsense }))?.nextAction).toBeNull();
  });

  it('still says something when the runner recorded no message at all', () => {
    const summary = summariseFailure(failure({ errorMessage: null }));
    expect(summary?.headline).toBe('The test failed and left no error message.');
    expect(summary?.classified).toBe(false);
    expect(summary?.raw).toBeNull();
  });
});

describe('the next action', () => {
  it('is silent for the kinds whose headline already is the whole story', () => {
    for (const [text, over] of [
      [API_STATUS, {}],
      [K6_P95, { testType: 'LOAD' }],
      [SECURITY, { testType: 'SECURITY_SMOKE' }],
    ] as const) {
      expect(summariseFailure(failure({ errorMessage: text, ...over }))?.nextAction).toBeNull();
    }
  });

  it('is present for the kinds whose first move is not obvious', () => {
    for (const [text, kind] of [
      [PW_SELECTOR_MISS, 'SELECTOR_NOT_FOUND'],
      [PW_BROWSER_MISSING, 'ENVIRONMENT'],
      [API_TRANSPORT, 'NETWORK'],
    ] as const) {
      const summary = summariseFailure(failure({ errorMessage: text, status: 'FAILED' }));
      expect(summary?.kind).toBe(kind);
      expect(summary?.nextAction).toBeTruthy();
    }
  });

  it('adds the networkidle clause only when the failure actually waited on networkidle', () => {
    const idle = summariseFailure(failure({ errorMessage: PW_NAV_NETWORKIDLE }));
    const plain = summariseFailure(
      failure({ errorMessage: 'page.goto: Timeout 30000ms exceeded.' }),
    );
    expect(idle?.nextAction).toContain('never reaches networkidle');
    expect(plain?.nextAction).not.toContain('never reaches networkidle');
  });
});

describe('where it broke', () => {
  it('prefers the spec frame over the library frame in the stack', () => {
    const summary = summariseFailure(
      failure({
        filePath: 'tests/checkout.spec.ts',
        steps: [
          step({
            errorMessage: PW_ASSERTION,
            errorStack: [
              'Error: expect(received).toHaveText(expected)',
              '    at /app/node_modules/@playwright/test/lib/expect.js:412:19',
              '    at /workspace/tests/checkout.spec.ts:37:22',
            ].join('\n'),
          }),
        ],
      }),
    );
    expect(summary?.location.line).toBe(37);
    expect(summary?.location.file).toBe('/workspace/tests/checkout.spec.ts');
  });

  it('never points at node_modules when the stack names nothing else', () => {
    const summary = summariseFailure(
      failure({
        steps: [
          step({
            errorMessage: PW_ASSERTION,
            errorStack: '    at /app/node_modules/@playwright/test/lib/expect.js:412:19',
          }),
        ],
      }),
    );
    expect(summary?.location.file).toBeNull();
    expect(summary?.location.line).toBeNull();
  });

  it('falls back to the test file when there is no stack, and reports the step', () => {
    const summary = summariseFailure(
      failure({
        filePath: 'tests/checkout.spec.ts',
        steps: [step({ index: 4, title: 'Submit the order', errorMessage: PW_SELECTOR_MISS })],
      }),
    );
    expect(summary?.location.file).toBe('tests/checkout.spec.ts');
    expect(summary?.location.line).toBeNull();
    expect(summary?.location.step).toEqual({ index: 4, title: 'Submit the order' });
  });

  it('recovers the locator from the call log when the caller never parsed one', () => {
    // The comparison screen has an error message and no steps at all.
    const summary = summariseFailure(failure({ errorMessage: PW_SELECTOR_MISS }));
    expect(summary?.location.selector).toBe("locator('#submit-order')");
    expect(summary?.location.step).toBeNull();
  });
});

describe('whether it looks flaky', () => {
  it('calls a retry that passed a flake candidate, because that one is observed', () => {
    const summary = summariseFailure(
      failure({ status: 'FLAKY', retriedAndPassed: true, errorMessage: PW_ASSERTION }),
    );
    expect(summary?.notes).toHaveLength(1);
    expect(summary?.notes[0]?.signal).toBe('RETRIED_AND_PASSED');
    expect(summary?.notes[0]?.looksFlaky).toBe(true);
  });

  it('reports a pass on the previous run as new, and refuses to call it flaky', () => {
    const summary = summariseFailure(
      failure({ errorMessage: PW_ASSERTION, previousOutcome: 'PASSED' }),
    );
    expect(summary?.notes[0]?.signal).toBe('NEW_SINCE_LAST_RUN');
    expect(summary?.notes[0]?.looksFlaky).toBe(false);
  });

  it('reports a failure on the previous run as not a one-off', () => {
    const summary = summariseFailure(
      failure({ errorMessage: PW_ASSERTION, previousOutcome: 'TIMED_OUT' }),
    );
    expect(summary?.notes[0]?.signal).toBe('FAILING_BEFORE');
  });

  it('says nothing at all when the history is unknown', () => {
    expect(summariseFailure(failure({ errorMessage: PW_ASSERTION }))?.notes).toEqual([]);
    expect(
      summariseFailure(failure({ errorMessage: PW_ASSERTION, previousOutcome: 'SKIPPED' }))?.notes,
    ).toEqual([]);
  });

  it('carries both signals when both are true', () => {
    const summary = summariseFailure(
      failure({ retriedAndPassed: true, errorMessage: PW_ASSERTION, previousOutcome: 'FAILED' }),
    );
    expect(summary?.notes.map((n) => n.signal)).toEqual(['RETRIED_AND_PASSED', 'FAILING_BEFORE']);
  });
});

describe('when there is nothing to explain', () => {
  it('returns null for a clean pass', () => {
    expect(summariseFailure(failure({ status: 'PASSED' }))).toBeNull();
  });

  it('returns null for a skip the runner said nothing about', () => {
    expect(summariseFailure(failure({ status: 'SKIPPED' }))).toBeNull();
  });

  it('still summarises a pass that needed a retry — that is not a pass', () => {
    const summary = summariseFailure(failure({ status: 'PASSED', retriedAndPassed: true }));
    expect(summary?.notes[0]?.signal).toBe('RETRIED_AND_PASSED');
    expect(summary?.headline).toBe('The test failed on its first attempt and left no message.');
  });
});

describe('the kind table', () => {
  it('labels every kind', () => {
    for (const kind of FAILURE_KINDS) {
      expect(FAILURE_KIND_LABELS[kind]).toBeTruthy();
    }
  });

  it('exercises every kind except UNKNOWN in the captured-text table', () => {
    // UNKNOWN is unreachable from a table of recognised text by construction —
    // it has its own describe block above. Every other kind must be backed by a
    // real message, or it is a rule nobody has ever seen fire.
    const covered = new Set(CASES.map(([, , kind]) => kind));
    expect(FAILURE_KINDS.filter((k) => k !== 'UNKNOWN' && !covered.has(k))).toEqual([]);
  });
});
