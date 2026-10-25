/**
 * Tests for suite import, and for READING the manual suite nobody could read.
 *
 * No network and no vendor SDK: every vendor reader takes an already-fetched
 * payload, and the paged fetch takes a one-method transport, so all four
 * dialects and all three of their silences are driven by literals. What is
 * asserted here, in rough order of how much it would cost to get wrong:
 *
 *   1. **`steps: []` NEVER MEANS ONE THING.** A property test walks every
 *      reader and asserts the four-state reading agrees with what the payload
 *      actually held. Reporting zero steps for a project whose cases are prose
 *      makes a conversion look complete when it has read nothing.
 *   2. **An empty automation field is NOT_STATED, never NOT_AUTOMATED.** The
 *      number this protects is one a customer quotes out loud: a backlog of
 *      1,630 at a company whose suite never claimed anything about 1,400 of
 *      them.
 *   3. **A re-import tells CHANGED from UNCHANGED, and both from NEW and
 *      NOT_COMPARABLE.** Plus the two fields deliberately NOT in the hash, each
 *      with its own test, because hashing either would churn the whole table on
 *      the morning after a regression pass.
 *   4. **A page that failed to load is never silently dropped.** The pages that
 *      did load are still returned, and the report says the import is partial —
 *      "reconciled" claimed over a skipped source is the lie this slice names.
 *   5. **The CSV parser survives Excel.** Quoted commas, embedded newlines,
 *      doubled quotes, CRLF and the BOM, which otherwise makes `id` read as
 *      `\uFEFFid` and the whole import report "no id column".
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  MANUAL_STEPS_STATES,
  MANUAL_STEPS_STATE_LABELS,
  MANUAL_SUITE_AS_SPEC_SOURCE,
  MANUAL_SUITE_SOURCES,
  convertPostmanCollection,
  detectFramework,
  holdsManualSuite,
  importManualSuite,
  manualCaseCanonicalText,
  manualCaseContentHash,
  parseCsvRows,
  readCsvCases,
  readQTestCases,
  readTestRailCases,
  readXrayTests,
  readZephyrTests,
  type ImportedManualCase,
  type ManualImportReport,
  type ManualReaderOptions,
  type ManualSuiteResponse,
  type ManualSuiteTransport,
} from './importer.js';

/** A real digest, because the hash's job is to differ when the content does. */
const digest = (canonical: string): string =>
  createHash('sha256').update(canonical).digest('hex');

const options: ManualReaderOptions = { digest };

function only(report: ManualImportReport): ImportedManualCase {
  expect(report.cases, JSON.stringify(report.gaps)).toHaveLength(1);
  return report.cases[0]!;
}

// ─── The framework detector still works ──────────────────────────────────────

describe('detectFramework', () => {
  it('picks the framework with the most evidence across files', () => {
    const result = detectFramework([
      { path: 'cypress/e2e/checkout.cy.ts', content: "cy.visit('/cart');\ncy.get('#pay').click();" },
      { path: 'support/commands.ts', content: 'Cypress.Commands.add("login", () => {});' },
    ]);
    expect(result.framework).toBe('CYPRESS');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('separates Karate from Cucumber, which share .feature and Gherkin keywords', () => {
    const karate = detectFramework([
      {
        path: 'orders.feature',
        content: 'Feature: orders\nScenario: get\n  Given url baseUrl\n  When method get\n  Then status 200',
      },
    ]);
    expect(karate.framework).toBe('KARATE');
  });
});

describe('convertPostmanCollection', () => {
  it('still reads a path through the moved helper, base-URL variable and all', () => {
    /*
     * The Postman path reader moved to `api-surface.ts` so enumeration and the
     * migration wedge cannot come to disagree about which endpoint a request
     * addresses. This is the regression test for that move.
     */
    const [test] = convertPostmanCollection(
      JSON.stringify({
        info: { name: 'Orders' },
        item: [
          {
            name: 'detail',
            request: { method: 'GET', url: { raw: '{{baseUrl}}/orders/{{orderId}}' } },
            event: [
              { listen: 'test', script: { exec: ['pm.expect(pm.response.code).to.equal(200)'] } },
            ],
          },
        ],
      }),
    );
    expect(test?.spec?.steps[0]).toMatchObject({
      method: 'GET',
      // A mid-path `{{var}}` is a real runner template and survives verbatim.
      path: '/orders/{{orderId}}',
      assertions: { status: 200 },
    });
  });
});

// ─── The manual suite vocabulary ─────────────────────────────────────────────

describe('the manual suite vocabulary', () => {
  it('maps every reader onto a SpecSourceSystem the write path accepts', () => {
    // Compiler-enforced in the source; asserted here so the list is visible.
    for (const source of MANUAL_SUITE_SOURCES) {
      expect(MANUAL_SUITE_AS_SPEC_SOURCE[source]).toBe(source);
    }
  });

  it('knows which sources hold a SUITE and which do not', () => {
    /*
     * Load-bearing for one sentence: "your TestRail suite has 1,840 cases". A
     * Jira project's issue count is not that number and must never be added to
     * it. CSV is the honest exception — it may hold either.
     */
    expect(holdsManualSuite('TESTRAIL')).toBe(true);
    expect(holdsManualSuite('XRAY')).toBe(true);
    expect(holdsManualSuite('ZEPHYR')).toBe(true);
    expect(holdsManualSuite('QTEST')).toBe(true);
    expect(holdsManualSuite('CSV')).toBe(false);
  });

  it('labels every steps state', () => {
    for (const state of MANUAL_STEPS_STATES) {
      expect(MANUAL_STEPS_STATE_LABELS[state].length).toBeGreaterThan(0);
    }
  });
});

// ─── TestRail ────────────────────────────────────────────────────────────────

describe('readTestRailCases', () => {
  it('reads structured steps as ROWS, with per-step expectations', () => {
    const report = readTestRailCases(
      {
        size: 1,
        cases: [
          {
            id: 412,
            title: 'Checkout with a saved card',
            custom_steps_separated: [
              { content: 'Open the cart', expected: 'The cart shows 2 items' },
              { content: 'Pay', expected: null },
            ],
            custom_expected: 'An order confirmation is shown',
            custom_automation_type: 'none',
            last_executed_on: 1_700_000_000,
          },
        ],
      },
      options,
    );
    const imported = only(report);
    expect(imported.steps).toBe('ROWS');
    expect(imported.case).toMatchObject({
      externalId: 'C412',
      sourceSystem: 'TESTRAIL',
      automationStatus: 'NOT_AUTOMATED',
      expectedResult: 'An order confirmation is shown',
    });
    expect(imported.case.steps).toEqual([
      { ordinal: 0, action: 'Open the cart', expected: 'The cart shows 2 items' },
      { ordinal: 1, action: 'Pay', expected: null },
    ]);
    // UNIX seconds, which is TestRail's shape, not an ISO string.
    expect(imported.case.lastExecutedAt?.getTime()).toBe(1_700_000_000_000);
  });

  it('reports a prose steps blob as NOT COUNTED and hands the prose back whole', () => {
    /*
     * THE DEFECT THIS PREVENTS: TestRail's default template uses the blob, so
     * reporting zero steps here would report zero steps for every case in a
     * whole project — and a conversion that read nothing would look complete.
     */
    const imported = only(
      readTestRailCases(
        { cases: [{ id: 1, title: 'x', custom_steps: '1. open\n2. pay' }] },
        options,
      ),
    );
    expect(imported.steps).toBe('PROSE_NOT_SPLIT');
    expect(imported.case.steps).toEqual([]);
    expect(imported.stepProse).toBe('1. open\n2. pay');
    expect(imported.notes.join(' ')).toContain('NOT counted');
  });

  it('tells "no steps field at all" from "a steps field that is empty"', () => {
    const noField = only(readTestRailCases({ cases: [{ id: 1, title: 'x' }] }, options));
    expect(noField.steps).toBe('NO_FIELD');

    const empty = only(
      readTestRailCases({ cases: [{ id: 2, title: 'y', custom_steps_separated: [] }] }, options),
    );
    // The one state in which "this case has no steps" is actually true.
    expect(empty.steps).toBe('DECLARED_EMPTY');
  });

  it('refuses to guess what an install-specific automation id means', () => {
    /*
     * `custom_automation_type` is an integer whose labels live in that
     * TestRail's own configuration, which the payload does not carry. Guessing
     * that 1 means automated is a mapping nobody reviewed that moves a coverage
     * percentage.
     */
    const report = readTestRailCases(
      { cases: [{ id: 1, title: 'x', custom_automation_type: 3 }] },
      options,
    );
    expect(only(report).case.automationStatus).toBe('NOT_STATED');
    expect(report.gaps[0]?.detail).toContain('own configuration');
    expect(report.caveats.join(' ')).toContain('never be added to the automation backlog');
  });

  it('is null about the last execution, which is not "never run"', () => {
    const imported = only(readTestRailCases({ cases: [{ id: 1, title: 'x' }] }, options));
    expect(imported.case.lastExecutedAt).toBeNull();
  });

  it('detects truncation from the size the payload reports', () => {
    const report = readTestRailCases(
      { size: 1840, cases: [{ id: 1, title: 'x' }] },
      options,
    );
    expect(report.claimedTotal).toBe(1840);
    expect(report.truncated).toBe(true);
    expect(report.caveats.join(' ')).toContain('at least 1839 more exist');
  });

  it('files a broken row as a gap instead of taking the other rows down with it', () => {
    const report = readTestRailCases(
      { cases: [{ id: 1 }, { id: 2, title: 'good' }, 'not an object'] },
      options,
    );
    expect(report.cases).toHaveLength(1);
    expect(report.gaps).toHaveLength(2);
  });

  it('says plainly that an unreadable payload is OUR silence', () => {
    const report = readTestRailCases({ error: 'nope' }, options);
    expect(report.cases).toEqual([]);
    expect(report.caveats.join(' ')).toContain('must never be rendered as a suite with no cases');
  });
});

// ─── Xray, Zephyr, qTest ─────────────────────────────────────────────────────

describe('readXrayTests', () => {
  it('keeps a step\'s DATA with its action instead of dropping it', () => {
    // `data` is the only part of an Xray step a generated test can actually
    // use, so dropping it loses the step's substance.
    const imported = only(
      readXrayTests(
        {
          tests: [
            {
              key: 'ORD-14',
              summary: 'Pay with a declined card',
              testType: 'Manual',
              steps: [{ action: 'Enter the card', data: '4000 0000 0000 0002', result: 'Declined' }],
            },
          ],
        },
        options,
      ),
    );
    expect(imported.case.steps[0]?.action).toContain('4000 0000 0000 0002');
    expect(imported.case.steps[0]?.expected).toBe('Declined');
    expect(imported.case.automationStatus).toBe('NOT_AUTOMATED');
  });

  it('does not assume an unrecognised test type is manual', () => {
    const report = readXrayTests(
      { tests: [{ key: 'ORD-1', summary: 'x', testType: 'Exploratory' }] },
      options,
    );
    expect(only(report).case.automationStatus).toBe('NOT_STATED');
    expect(report.gaps[0]?.detail).toContain('rather than assumed manual');
  });

  it('reads `isLast: false` as "there is another page"', () => {
    const report = readXrayTests(
      { total: 2, isLast: false, tests: [{ key: 'A-1', summary: 'x' }] },
      options,
    );
    expect(report.truncated).toBe(true);
  });
});

describe('readZephyrTests', () => {
  it('reads the testScript TYPE rather than probing for a steps key', () => {
    /*
     * THE DEFECT THIS PREVENTS: reading only the STEP_BY_STEP shape makes every
     * plain-text project import as "no steps", which is the flattering wrong
     * answer.
     */
    const byStep = only(
      readZephyrTests(
        {
          values: [
            {
              key: 'ORD-T1',
              name: 'Refund',
              testScript: {
                type: 'STEP_BY_STEP',
                steps: [{ description: 'Open the order', expectedResult: 'It is refundable' }],
              },
            },
          ],
        },
        options,
      ),
    );
    expect(byStep.steps).toBe('ROWS');

    const plain = only(
      readZephyrTests(
        {
          values: [
            { key: 'ORD-T2', name: 'Refund', testScript: { type: 'PLAIN_TEXT', text: 'do it' } },
          ],
        },
        options,
      ),
    );
    expect(plain.steps).toBe('PROSE_NOT_SPLIT');
    expect(plain.stepProse).toBe('do it');
  });

  it('files a testScript with neither steps nor text as a gap, not as an empty case', () => {
    const report = readZephyrTests(
      { values: [{ key: 'ORD-T3', name: 'x', testScript: { type: 'BDD' } }] },
      options,
    );
    expect(report.gaps[0]?.detail).toContain('not read at all');
    expect(only(report).steps).toBe('NO_FIELD');
  });

  it('reads the Automation custom field when one exists', () => {
    const imported = only(
      readZephyrTests(
        { values: [{ key: 'A-1', name: 'x', customFields: { Automation: 'Automated' } }] },
        options,
      ),
    );
    expect(imported.case.automationStatus).toBe('AUTOMATED');
  });
});

describe('readQTestCases', () => {
  it('finds the automation property by NAME, never by index', () => {
    /*
     * The `properties` array's order is not stable across qTest projects, so
     * reading `properties[3]` would attribute one project's "Automation" to
     * another's "Priority".
     */
    const imported = only(
      readQTestCases(
        {
          items: [
            {
              pid: 'TC-88',
              name: 'Cancel a subscription',
              test_steps: [{ description: 'Click cancel', expected_result: 'Confirm dialog' }],
              properties: [
                { field_name: 'Priority', field_value: 'High' },
                { field_name: 'Automation Status', field_value: 'planned' },
              ],
              last_executed_date: '2026-03-04T10:00:00.000Z',
              web_url: 'https://q.test/TC-88',
            },
          ],
        },
        options,
      ),
    );
    expect(imported.case).toMatchObject({
      externalId: 'TC-88',
      automationStatus: 'AUTOMATION_PLANNED',
      url: 'https://q.test/TC-88',
    });
    expect(imported.case.lastExecutedAt?.toISOString()).toBe('2026-03-04T10:00:00.000Z');
  });

  it('is NOT_STATED when no automation property exists at all', () => {
    const imported = only(readQTestCases({ items: [{ pid: 'TC-1', name: 'x' }] }, options));
    expect(imported.case.automationStatus).toBe('NOT_STATED');
  });
});

// ─── The property that makes `steps: []` safe ────────────────────────────────

describe('the four-state steps reading agrees with the payload, in every reader', () => {
  const cases: Array<[string, ImportedManualCase, 'ROWS' | 'PROSE_NOT_SPLIT' | 'DECLARED_EMPTY' | 'NO_FIELD']> =
    [
      [
        'testrail rows',
        only(
          readTestRailCases(
            { cases: [{ id: 1, title: 'x', custom_steps_separated: [{ content: 'a' }] }] },
            options,
          ),
        ),
        'ROWS',
      ],
      [
        'testrail prose',
        only(readTestRailCases({ cases: [{ id: 1, title: 'x', custom_steps: 'a' }] }, options)),
        'PROSE_NOT_SPLIT',
      ],
      [
        'testrail empty',
        only(
          readTestRailCases(
            { cases: [{ id: 1, title: 'x', custom_steps_separated: [] }] },
            options,
          ),
        ),
        'DECLARED_EMPTY',
      ],
      [
        'xray no field',
        only(readXrayTests({ tests: [{ key: 'A-1', summary: 'x' }] }, options)),
        'NO_FIELD',
      ],
      [
        'zephyr rows',
        only(
          readZephyrTests(
            {
              values: [
                { key: 'A-1', name: 'x', testScript: { steps: [{ description: 'a' }] } },
              ],
            },
            options,
          ),
        ),
        'ROWS',
      ],
      [
        'qtest rows',
        only(
          readQTestCases({ items: [{ pid: 'T-1', name: 'x', test_steps: [{ description: 'a' }] }] }, options),
        ),
        'ROWS',
      ],
      [
        'csv prose',
        only(readCsvCases('id,title,steps\n1,x,"open the cart"', options)),
        'PROSE_NOT_SPLIT',
      ],
      ['csv no column', only(readCsvCases('id,title\n1,x', options)), 'NO_FIELD'],
    ];

  for (const [name, imported, expected] of cases) {
    it(`holds for ${name}`, () => {
      expect(imported.steps).toBe(expected);
      /*
       * THE INVARIANT: a non-empty `steps` array is possible only under ROWS,
       * and under every other state the count is UNKNOWN rather than zero.
       * Anything else is "a null that became 0" in the field a conversion
       * report divides by.
       */
      if (expected === 'ROWS') expect(imported.case.steps.length).toBeGreaterThan(0);
      else expect(imported.case.steps).toEqual([]);
      // Only PROSE_NOT_SPLIT keeps prose, and it always keeps some.
      if (expected === 'PROSE_NOT_SPLIT') expect(imported.stepProse).not.toBeNull();
      else expect(imported.stepProse).toBeNull();
    });
  }
});

// ─── The content hash ────────────────────────────────────────────────────────

describe('the content hash, and what is deliberately not in it', () => {
  const base = {
    cases: [
      {
        id: 7,
        title: 'Refund an order',
        custom_steps_separated: [{ content: 'Open the order', expected: 'Refund is offered' }],
        custom_expected: 'The refund lands',
        custom_automation_type: 'none',
      },
    ],
  };

  it('is stable across an unedited re-import', () => {
    const first = only(readTestRailCases(base, options)).contentHash;
    const second = only(readTestRailCases(structuredClone(base), options)).contentHash;
    expect(second).toBe(first);
  });

  it('ignores a line-ending change, which a tracker makes on its own', () => {
    /*
     * A tracker's web editor and its REST API disagree about line endings on
     * the same unedited case. Without this, a nightly import reports every
     * multi-line case as CHANGED and the traceability matrix churns for ever.
     */
    const crlf = structuredClone(base);
    crlf.cases[0]!.custom_expected = 'The refund\r\nlands';
    const lf = structuredClone(base);
    lf.cases[0]!.custom_expected = 'The refund\nlands';
    expect(only(readTestRailCases(crlf, options)).contentHash).toBe(
      only(readTestRailCases(lf, options)).contentHash,
    );
  });

  it('keeps the automation status OUT of the hash', () => {
    // A case being ticked off as automated is not an edit to the test.
    const automated = structuredClone(base);
    automated.cases[0]!.custom_automation_type = 'automated';
    expect(only(readTestRailCases(automated, options)).contentHash).toBe(
      only(readTestRailCases(base, options)).contentHash,
    );
    expect(only(readTestRailCases(automated, options)).case.automationStatus).toBe('AUTOMATED');
  });

  it('keeps the last-executed date OUT of the hash', () => {
    // Otherwise every link in a project re-opens the morning after a
    // regression pass.
    const run = structuredClone(base) as Record<string, any>;
    run.cases[0].last_executed_on = 1_700_000_000;
    expect(only(readTestRailCases(run, options)).contentHash).toBe(
      only(readTestRailCases(base, options)).contentHash,
    );
  });

  it('changes when a step\'s text changes', () => {
    const edited = structuredClone(base);
    edited.cases[0]!.custom_steps_separated[0]!.content = 'Open the invoice';
    expect(only(readTestRailCases(edited, options)).contentHash).not.toBe(
      only(readTestRailCases(base, options)).contentHash,
    );
  });

  it('cannot have a step BOUNDARY forged by a step whose action looks like an expectation', () => {
    /*
     * This is what the ordinal prefix is for, and the reorder test below is
     * NOT: a per-step expected result is its own criterion, so without the
     * prefix one step (`a` / expected `b`) canonicalises identically to two
     * steps whose second action is literally `expected: b`. Those are
     * different specifications; one hashing as the other means an edit between
     * them re-imports as UNCHANGED and the customer's change is dropped.
     */
    const oneStepWithExpectation = {
      cases: [
        { id: 9, title: 'x', custom_steps_separated: [{ content: 'a', expected: 'b' }] },
      ],
    };
    const twoStepsThatMimicIt = {
      cases: [
        {
          id: 9,
          title: 'x',
          custom_steps_separated: [{ content: 'a' }, { content: 'expected: b' }],
        },
      ],
    };
    expect(only(readTestRailCases(oneStepWithExpectation, options)).contentHash).not.toBe(
      only(readTestRailCases(twoStepsThatMimicIt, options)).contentHash,
    );
  });

  it('changes when two steps are reordered', () => {
    /*
     * Each step carries its ORDINAL into the canonical text, so two steps
     * cannot be rearranged into the same canonical text as each other — which
     * is how a reordered test case would re-import as UNCHANGED.
     */
    const two = {
      cases: [
        {
          id: 9,
          title: 'x',
          custom_steps_separated: [{ content: 'alpha' }, { content: 'beta' }],
        },
      ],
    };
    const swapped = {
      cases: [
        {
          id: 9,
          title: 'x',
          custom_steps_separated: [{ content: 'beta' }, { content: 'alpha' }],
        },
      ],
    };
    expect(only(readTestRailCases(two, options)).contentHash).not.toBe(
      only(readTestRailCases(swapped, options)).contentHash,
    );
  });

  it('is computed over the canonical text and nothing else', () => {
    const imported = only(readTestRailCases(base, options));
    expect(imported.contentHash).toBe(manualCaseContentHash(imported.case, digest));
    expect(manualCaseCanonicalText(imported.case)).toContain('0. Open the order');
    expect(manualCaseCanonicalText(imported.case)).not.toContain('NOT_AUTOMATED');
  });
});

describe('a re-import tells all four states apart', () => {
  const payload = { cases: [{ id: 7, title: 'Refund an order' }] };
  const stored = only(readTestRailCases(payload, options)).contentHash;

  it('is null when the caller is not comparing at all', () => {
    // Not NEW: "we did not compare" and "we have never seen this" are
    // different facts, and conflating them reports a first import of 1,840
    // cases as 1,840 edits.
    expect(only(readTestRailCases(payload, options)).change).toBeNull();
  });

  it('is NEW for an id with no stored row', () => {
    const report = readTestRailCases(payload, {
      digest,
      previousHashes: new Map([['C999', 'something']]),
    });
    expect(only(report).change?.kind).toBe('NEW');
  });

  it('is UNCHANGED when the hash matches', () => {
    const report = readTestRailCases(payload, {
      digest,
      previousHashes: new Map([['C7', stored]]),
    });
    expect(only(report).change?.kind).toBe('UNCHANGED');
  });

  it('is CHANGED when the source has been edited', () => {
    const report = readTestRailCases(
      { cases: [{ id: 7, title: 'Refund an order quickly' }] },
      { digest, previousHashes: new Map([['C7', stored]]) },
    );
    expect(only(report).change?.kind).toBe('CHANGED');
  });

  it('is NOT_COMPARABLE for a stored row that was never hashed', () => {
    /*
     * Calling it UNCHANGED drops the customer's edit silently; calling it
     * CHANGED re-opens every link on every re-import. Neither is true.
     */
    const report = readTestRailCases(payload, {
      digest,
      previousHashes: new Map([['C7', null]]),
    });
    expect(only(report).change?.kind).toBe('NOT_COMPARABLE');
  });
});

// ─── CSV ─────────────────────────────────────────────────────────────────────

describe('parseCsvRows', () => {
  it('survives what Excel writes: BOM, CRLF, quoted commas, embedded newlines', () => {
    const rows = parseCsvRows(
      '﻿id,title,steps\r\n1,"Pay, then refund","open\nclose"\r\n2,"say ""hi""",x\r\n',
    );
    expect(rows).toEqual([
      ['id', 'title', 'steps'],
      ['1', 'Pay, then refund', 'open\nclose'],
      ['2', 'say "hi"', 'x'],
    ]);
  });

  it('keeps a last row with no trailing newline, and adds no phantom row with one', () => {
    expect(parseCsvRows('a,b\n1,2')).toHaveLength(2);
    expect(parseCsvRows('a,b\n1,2\n')).toHaveLength(2);
  });
});

describe('readCsvCases', () => {
  it('accepts whatever a customer\'s export tool called the columns', () => {
    const report = readCsvCases(
      'Test Case ID,Name,Expected Result,Automation Status\nTC-1,Refund,Money back,Automated',
      options,
    );
    expect(only(report).case).toMatchObject({
      externalId: 'TC-1',
      title: 'Refund',
      expectedResult: 'Money back',
      automationStatus: 'AUTOMATED',
      sourceSystem: 'CSV',
    });
  });

  it('refuses the whole file when there is no stable id column', () => {
    // A case with no stable id duplicates itself every night.
    const report = readCsvCases('title,steps\nRefund,open', options);
    expect(report.cases).toEqual([]);
    expect(report.gaps[0]?.detail).toContain('duplicating itself every night');
  });

  it('says once, not 1,840 times, that there is no automation column', () => {
    const report = readCsvCases('id,title\n1,a\n2,b\n3,c', options);
    expect(report.cases).toHaveLength(3);
    expect(report.gaps.filter((gap) => gap.externalId === null)).toHaveLength(1);
    expect(report.cases.every((entry) => entry.case.automationStatus === 'NOT_STATED')).toBe(true);
  });

  it('does not split a steps cell into steps unless the customer says to', () => {
    /*
     * Splitting on `\n` turns a two-sentence description into two steps — a
     * count that is wrong in the direction that makes a conversion look
     * complete. The opt-in is the customer's, because only they know their
     * export.
     */
    const prose = only(readCsvCases('id,title,steps\n1,x,"open\nclose"', options));
    expect(prose.steps).toBe('PROSE_NOT_SPLIT');

    const split = only(
      readCsvCases('id,title,steps\n1,x,"open\nclose"', { ...options, splitStepsOnNewline: true }),
    );
    expect(split.steps).toBe('ROWS');
    expect(split.case.steps.map((step) => step.action)).toEqual(['open', 'close']);
  });

  it('drops a url that is not a url with a note, rather than throwing the file away', () => {
    const report = readCsvCases('id,title,url\n1,x,TC-1', options);
    const imported = only(report);
    expect(imported.case.url).toBeNull();
    expect(imported.notes.join(' ')).toContain('not an http(s) URL');
  });

  it('never claims a total a CSV cannot report', () => {
    // `cases.length` here would claim the file told us a total it never did,
    // and make a truncated export undetectable.
    const report = readCsvCases('id,title\n1,x', options);
    expect(report.claimedTotal).toBeNull();
    expect(report.truncated).toBe(false);
  });

  it('skips a blank line without filing it as a broken row', () => {
    const report = readCsvCases('id,title\n1,x\n\n2,y\n', options);
    expect(report.cases).toHaveLength(2);
    expect(report.gaps.filter((gap) => gap.externalId !== null)).toEqual([]);
  });

  it('says CSV is not a test-management system, so its count is not a suite count', () => {
    expect(readCsvCases('id,title\n1,x', options).caveats.join(' ')).toContain(
      'not a test-management system',
    );
  });
});

// ─── The paged fetch ─────────────────────────────────────────────────────────

/** A transport that answers from a list of pages and records every request. */
function pagingTransport(pages: Array<Partial<ManualSuiteResponse>>): {
  transport: ManualSuiteTransport;
  asked: Array<{ path: string; query: Record<string, string | number> }>;
} {
  const asked: Array<{ path: string; query: Record<string, string | number> }> = [];
  let index = 0;
  return {
    asked,
    transport: {
      get: async (request) => {
        asked.push({ path: request.path, query: request.query });
        const page = pages[index] ?? { status: 200, body: { cases: [] }, error: null };
        index += 1;
        return { status: 200, body: null, error: null, ...page };
      },
    },
  };
}

describe('importManualSuite', () => {
  it('pages until the suite says it is done, and reports how many pages it read', async () => {
    const { transport, asked } = pagingTransport([
      { body: { size: 3, cases: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }] } },
      { body: { size: 3, cases: [{ id: 3, title: 'c' }] } },
    ]);
    const report = await importManualSuite({
      transport,
      source: 'TESTRAIL',
      options,
      pageSize: 2,
    });
    expect(report.cases.map((entry) => entry.case.externalId)).toEqual(['C1', 'C2', 'C3']);
    expect(report.pages).toBe(2);
    expect(report.truncated).toBe(false);
    expect(asked[1]?.query).toMatchObject({ offset: 2, limit: 2 });
  });

  it('is PARTIAL and says so when a page fails to load', async () => {
    /*
     * THE LIE THIS PREVENTS: "we read your suite and found 1,200 cases", said
     * about a suite whose fourth page 500'd. The pages that loaded are still
     * returned, because throwing them away would be a second wrong answer.
     */
    const { transport } = pagingTransport([
      { body: { size: 400, cases: [{ id: 1, title: 'a' }] } },
      { status: 500, body: null },
    ]);
    const report = await importManualSuite({
      transport,
      source: 'TESTRAIL',
      options,
      pageSize: 1,
    });
    expect(report.cases).toHaveLength(1);
    expect(report.truncated).toBe(true);
    expect(report.caveats.join(' ')).toContain('nothing here is reconciled');
    expect(report.gaps.some((gap) => gap.detail.includes('page 2 failed to load'))).toBe(true);
  });

  it('keeps paging through a SHORT page when the suite says more cases exist', async () => {
    /*
     * THE DEFECT THIS CATCHES, which nothing else here did: stopping on any
     * short page. Some installs return fewer rows than asked for under load,
     * and a loop that reads a short page as the last one silently drops the
     * rest of the suite — an undisclosed truncation, which makes the
     * automation ratio go UP. The suite's own total is what settles it.
     */
    const { transport } = pagingTransport([
      { body: { size: 3, cases: [{ id: 1, title: 'a' }] } },
      { body: { size: 3, cases: [{ id: 2, title: 'b' }, { id: 3, title: 'c' }] } },
    ]);
    const report = await importManualSuite({
      transport,
      source: 'TESTRAIL',
      options,
      pageSize: 2,
    });
    expect(report.cases.map((entry) => entry.case.externalId)).toEqual(['C1', 'C2', 'C3']);
    expect(report.pages).toBe(2);
    expect(report.truncated).toBe(false);
  });

  it('stops on a short page only when the suite reported no total at all', async () => {
    // With no total and no paging flag, a short page is the only remaining
    // evidence that it is the last one — so it is used, and only then.
    const { transport, asked } = pagingTransport([
      { body: { cases: [{ id: 1, title: 'a' }] } },
    ]);
    const report = await importManualSuite({
      transport,
      source: 'TESTRAIL',
      options,
      pageSize: 2,
    });
    expect(asked).toHaveLength(1);
    expect(report.truncated).toBe(false);
  });

  it('turns a thrown transport into a partial import, not an exception', async () => {
    const report = await importManualSuite({
      transport: {
        get: async () => {
          throw new Error('socket hang up');
        },
      },
      source: 'ZEPHYR',
      options,
    });
    expect(report.truncated).toBe(true);
    expect(report.caveats.join(' ')).toContain('socket hang up');
  });

  it('discloses the page budget as a count and a reason when it bites', async () => {
    const { transport } = pagingTransport([
      { body: { size: 500, cases: [{ id: 1, title: 'a' }] } },
      { body: { size: 500, cases: [{ id: 2, title: 'b' }] } },
    ]);
    const report = await importManualSuite({
      transport,
      source: 'TESTRAIL',
      options,
      pageSize: 1,
      pageBudget: 2,
    });
    expect(report.pages).toBe(2);
    const bite = report.caps[0];
    expect(bite).toMatchObject({ cap: 'PAGE_BUDGET', limit: 2, bites: 1, discarded: 498 });
    expect(bite?.reason).toContain('at least 498 more exist');
    expect(report.truncated).toBe(true);
  });

  it('counts at least one unread case when the vendor reported no total', async () => {
    // A lower bound of 1 rather than 0: we know another page exists and we do
    // not know how many cases are on it.
    const { transport } = pagingTransport([
      { body: { isLast: false, values: [{ key: 'A-1', name: 'a' }] } },
    ]);
    const report = await importManualSuite({
      transport,
      source: 'ZEPHYR',
      options,
      pageBudget: 1,
    });
    expect(report.caps[0]).toMatchObject({ cap: 'PAGE_BUDGET', discarded: 1 });
  });

  it('asks qTest for 1-based pages and everyone else for offsets', async () => {
    // qTest's `page` is 1-based; sending 0 returns the first page twice on some
    // installs and nothing on others.
    const qtest = pagingTransport([{ body: { total: 1, items: [{ pid: 'T-1', name: 'a' }] } }]);
    await importManualSuite({ transport: qtest.transport, source: 'QTEST', options });
    expect(qtest.asked[0]?.query).toMatchObject({ page: 1 });

    const xray = pagingTransport([{ body: { total: 1, tests: [{ key: 'A-1', summary: 'a' }] } }]);
    await importManualSuite({ transport: xray.transport, source: 'XRAY', options });
    expect(xray.asked[0]?.query).toMatchObject({ start: 0 });
  });

  it('passes a caller\'s project filter through without owning a credential', async () => {
    /*
     * Rule 4 of this slice: a connector's credentials live on a model row the
     * customer owns, never in process.env and never in this module. All it
     * takes is the query it was given.
     */
    const { transport, asked } = pagingTransport([{ body: { cases: [] } }]);
    await importManualSuite({
      transport,
      source: 'TESTRAIL',
      options,
      query: { suite_id: 4 },
    });
    expect(asked[0]?.query).toMatchObject({ suite_id: 4 });
  });
});
