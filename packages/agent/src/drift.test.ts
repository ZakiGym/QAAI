/**
 * Tests for the pre-failure selector drift check.
 *
 * The dangerous failure of this module is the CONFIDENT WRONG REWRITE: a
 * locator repointed at the wrong element produces a test that passes while
 * asserting nothing about the thing it was written for, and nobody looks at it
 * again. A failing run, by comparison, costs a CI cycle and tells the truth.
 *
 * So most of this file is about REFUSING to propose a repair, and each refusal
 * names the condition that made the answer ambiguous. The two tests that DO
 * expect a proposal both check that exactly one candidate survived every
 * filter.
 */

import { describe, expect, it } from 'vitest';
import type { CrawlAcceptance, FlowMap, FlowNode, Selector } from '@qaai/shared';
import {
  DRIFT_MAX_NAME_LENGTH,
  DRIFT_STATE_RULES,
  DRIFT_STATES,
  crawlIndex,
  driftReport,
  headlineFor,
  locatorParts,
} from './drift.js';
import type { SuiteHealthTestInput } from './suite-health.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const role = (value: string, name: string): Selector => ({
  strategy: 'ROLE',
  value,
  name,
  confidence: 0.9,
});

const testId = (value: string): Selector => ({ strategy: 'TEST_ID', value, confidence: 0.9 });

const accepted = (): CrawlAcceptance => ({
  state: 'ACCEPTED',
  reasons: [],
  degradations: [],
  comparedToVersion: null,
  previousNodeCount: null,
});

const node = (route: string, selectors: Selector[]): FlowNode => ({
  id: `n-${route}`,
  route,
  url: `https://app.test${route}`,
  title: route,
  stateKey: 'default',
  requiresRoles: [],
  behindAuth: false,
  forms: [],
  affordances: selectors.map((selector) => ({
    label: selector.name ?? selector.value,
    selector,
    kind: 'button' as const,
  })),
  screenshotKey: null,
  a11yViolationCount: 0,
});

const flowMap = (nodes: FlowNode[]): FlowMap => ({
  projectId: 'p1',
  environmentId: 'e1',
  version: 9,
  baseUrl: 'https://app.test',
  nodes,
  edges: [],
  journeys: [],
  features: [],
  exploredAt: '2026-10-29T00:00:00.000Z',
  truncatedReason: null,
  acceptance: accepted(),
});

/** A test that navigates to /checkout and clicks a button named "Pay". */
const payTest = (over: Partial<SuiteHealthTestInput> = {}): SuiteHealthTestInput => ({
  id: 't1',
  name: 'checkout completes',
  filePath: 'tests/checkout.spec.ts',
  type: 'E2E',
  priority: 'IMPORTANT',
  feature: 'checkout',
  tags: [],
  code: [
    "import { test, expect } from '@playwright/test';",
    "test('checkout completes', async ({ page }) => {",
    "  await page.goto('/checkout');",
    "  await page.getByRole('button', { name: 'Pay' }).click();",
    '});',
  ].join('\n'),
  spec: null,
  flakeRate: 0,
  quarantined: false,
  consecutiveFailures: 0,
  ...over,
});

const onlyFinding = (report: ReturnType<typeof driftReport>) => {
  expect(report.tests).toHaveLength(1);
  const findings = report.tests[0]!.findings;
  expect(findings).toHaveLength(1);
  return findings[0]!;
};

// ─── The vocabulary ──────────────────────────────────────────────────────────

describe('every drift state says whether the test fails and whether QAAI can fix it', () => {
  it('names every state in the rule table', () => {
    // A `satisfies Record<DriftState, …>` cannot be written without naming
    // every member, so a sixth state is a compile error rather than a state
    // with no failure prediction. This is the run-time half.
    for (const state of DRIFT_STATES) {
      expect(DRIFT_STATE_RULES[state]).toBeDefined();
    }
    expect(Object.keys(DRIFT_STATE_RULES).sort()).toEqual([...DRIFT_STATES].sort());
  });

  it('lets only the two explainable states be repaired', () => {
    // MOVED is deliberately NOT repairable: the locator is right and the
    // navigation is wrong, and QAAI cannot know which page the test meant.
    const repairable = DRIFT_STATES.filter((state) => DRIFT_STATE_RULES[state].repairable);
    expect(repairable).toEqual(['NAME_CHANGED', 'ROLE_CHANGED']);
  });

  it('never claims an UNCOMPARABLE locator will pass', () => {
    // A pass that means "we did not check" is the lie this row prevents.
    expect(DRIFT_STATE_RULES.UNCOMPARABLE.willFail).toBe(false);
    expect(DRIFT_STATE_RULES.UNCOMPARABLE.repairable).toBe(false);
  });
});

describe('parsing a locator into the parts the comparison needs', () => {
  it('splits a role locator into its role and its accessible name', () => {
    expect(locatorParts('role=button[pay]')).toEqual({
      key: 'role',
      value: 'button',
      name: 'pay',
      identity: 'role=button[pay]',
      chained: false,
    });
  });

  it('strips the positional modifiers before comparing', () => {
    // `.first()` narrows a selection; it does not change which element KIND the
    // test is talking about, and the crawl records the affordance without it.
    expect(locatorParts('role=row[order 7]:first')?.identity).toBe('role=row[order 7]');
  });

  it('marks a chain as chained, so no repair is ever proposed for one', () => {
    expect(locatorParts('role=dialog[confirm]>text=ok')?.chained).toBe(true);
  });

  it('refuses a CSS locator and one held in a variable', () => {
    expect(locatorParts('css=#pay')).toBeNull();
    expect(locatorParts('var=paybutton')).toBeNull();
    expect(locatorParts('unknown')).toBeNull();
  });
});

// ─── The four things that can happen to a locator ────────────────────────────

describe('a locator that is still there', () => {
  it('is PRESENT and predicts no failure', () => {
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([node('/checkout', [role('button', 'Pay')])]),
    });
    expect(onlyFinding(report).state).toBe('PRESENT');
    expect(report.testsThatWillFail).toBe(0);
    expect(report.headline).toMatch(/Nothing is predicted to fail/);
  });
});

describe('a rename the crawl already knows about', () => {
  it('is NAME_CHANGED with a deterministic replacement and no model', () => {
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([node('/checkout', [role('button', 'Pay now')])]),
    });
    const finding = onlyFinding(report);
    expect(finding.state).toBe('NAME_CHANGED');
    expect(finding.proposal).toBe("page.getByRole('button', { name: 'Pay now' })");
    expect(finding.refusal).toBeNull();
    expect(finding.why).toMatch(/needs no model/);
    expect(report.deterministicallyRepairable).toBe(1);
    expect(report.headline).toBe(
      '1 test will fail on the next run unless 1 locator is updated. Every one has exactly one unambiguous new target, so QAAI can rewrite them all with no model.',
    );
  });

  it('escapes the page text instead of concatenating it', () => {
    /*
     * An accessible name is PAGE TEXT and this string is written into the
     * customer's source. It goes through `locatorExpression`, which is the one
     * function that escapes a quote and a backslash — a hand-built string here
     * would emit source that does not parse, or worse, source that parses into
     * something else.
     */
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([node('/checkout', [role('button', "Pay O'Brien's \\ invoice")])]),
    });
    const finding = onlyFinding(report);
    expect(finding.state).toBe('NAME_CHANGED');
    expect(finding.proposal).toBe(
      "page.getByRole('button', { name: 'Pay O\\'Brien\\'s \\\\ invoice' })",
    );
  });

  it('refuses a candidate whose name is too long to write into source', () => {
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([node('/checkout', [role('button', 'x'.repeat(DRIFT_MAX_NAME_LENGTH + 1))])]),
    });
    const finding = onlyFinding(report);
    expect(finding.state).toBe('NAME_CHANGED');
    expect(finding.proposal).toBeNull();
    expect(finding.refusal).toBe('CANDIDATE_NAME_UNUSABLE');
    // The cap BIT, so it is reported as a count with a reason.
    expect(report.refusals.CANDIDATE_NAME_UNUSABLE).toBe(1);
    expect(report.caveats.join(' ')).toMatch(/not usable as source/);
    // And the finding still predicts the failure: the test breaks either way.
    expect(report.testsThatWillFail).toBe(1);
    expect(report.deterministicallyRepairable).toBe(0);
  });

  it('refuses a candidate whose name carries a line break', () => {
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([node('/checkout', [role('button', 'Pay\nnow, today')])]),
    });
    expect(onlyFinding(report).refusal).toBe('CANDIDATE_NAME_UNUSABLE');
  });
});

describe('a role that changed', () => {
  it('is ROLE_CHANGED when the same name appears under exactly one other role', () => {
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([node('/checkout', [role('link', 'Pay')])]),
    });
    const finding = onlyFinding(report);
    expect(finding.state).toBe('ROLE_CHANGED');
    expect(finding.proposal).toBe("page.getByRole('link', { name: 'Pay' })");
    expect(finding.why).toMatch(/its role changed/);
  });
});

describe('an element that moved to another page', () => {
  it('is MOVED, and no locator rewrite is offered', () => {
    /*
     * The locator is correct. The test is on the wrong page, and QAAI has no
     * way to know which page it MEANT — so this is a state of its own rather
     * than a GONE with a note, and it carries no proposal.
     */
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([
        node('/checkout', [role('button', 'Continue')]),
        node('/basket', [role('button', 'Pay')]),
      ]),
    });
    const finding = onlyFinding(report);
    expect(finding.state).toBe('MOVED');
    expect(finding.proposal).toBeNull();
    expect(finding.refusal).toBeNull();
    expect(finding.why).toMatch(/on \/basket/);
    expect(finding.why).toMatch(/the navigation is what moved/);
    expect(report.testsThatWillFail).toBe(1);
    expect(report.deterministicallyRepairable).toBe(0);
  });
});

describe('an element that is simply gone', () => {
  it('is GONE with no refusal, because there was nothing to refuse', () => {
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([node('/checkout', [testId('receipt')])]),
    });
    const finding = onlyFinding(report);
    expect(finding.state).toBe('GONE');
    expect(finding.proposal).toBeNull();
    expect(finding.refusal).toBeNull();
    expect(finding.candidateCount).toBe(0);
    expect(finding.why).toMatch(/offers nothing with the same role/);
  });
});

// ─── The refusals. The most important tests in the file. ─────────────────────

describe('a confident wrong rewrite is worse than a failing run', () => {
  it('refuses when two elements could be the rename', () => {
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([
        node('/checkout', [role('button', 'Pay now'), role('button', 'Pay later')]),
      ]),
    });
    const finding = onlyFinding(report);
    expect(finding.state).toBe('GONE');
    expect(finding.proposal).toBeNull();
    expect(finding.refusal).toBe('AMBIGUOUS_CANDIDATES');
    expect(finding.candidateCount).toBe(2);
    // The candidates are SHOWN, so a human can finish what QAAI would not guess.
    expect(finding.candidates).toEqual([
      "page.getByRole('button', { name: 'Pay later' })",
      "page.getByRole('button', { name: 'Pay now' })",
    ]);
    expect(report.refusals.AMBIGUOUS_CANDIDATES).toBe(1);
    expect(report.headline).toMatch(/every repair is a human decision/);
  });

  it('refuses when a name change AND a role change both explain it', () => {
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([node('/checkout', [role('button', 'Pay now'), role('link', 'Pay')])]),
    });
    const finding = onlyFinding(report);
    expect(finding.refusal).toBe('CONFLICTING_EXPLANATIONS');
    expect(finding.proposal).toBeNull();
    expect(finding.why).toMatch(/proposes neither/);
  });

  it('refuses to rewrite a chained locator at all', () => {
    const report = driftReport({
      tests: [
        payTest({
          code: [
            "test('confirm', async ({ page }) => {",
            "  await page.goto('/checkout');",
            "  await page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'OK' }).click();",
            '});',
          ].join('\n'),
        }),
      ],
      flowMap: flowMap([node('/checkout', [role('dialog', 'Confirm payment')])]),
    });
    const finding = onlyFinding(report);
    expect(finding.refusal).toBe('CHAINED_LOCATOR');
    expect(finding.proposal).toBeNull();
    expect(finding.why).toMatch(/which segment of a chain moved/);
  });

  it('does not treat another test’s live control as this one renamed', () => {
    /*
     * THE DEFECT THIS PREVENTS: /checkout has both "Pay now" and "Pay later".
     * A second test drives "Pay later" successfully, so it is a live control
     * and not a rename of "Pay". Without the claimed-identity filter the
     * repair would be refused as AMBIGUOUS — correct refusal, wrong reason —
     * and with a naive filter it would be PROPOSED, which is the wrong rewrite.
     */
    const report = driftReport({
      tests: [
        payTest(),
        payTest({
          id: 't2',
          name: 'pay later',
          code: [
            "test('pay later', async ({ page }) => {",
            "  await page.goto('/checkout');",
            "  await page.getByRole('button', { name: 'Pay later' }).click();",
            '});',
          ].join('\n'),
        }),
      ],
      flowMap: flowMap([
        node('/checkout', [role('button', 'Pay now'), role('button', 'Pay later')]),
      ]),
    });

    const drifted = report.tests.find((test) => test.testId === 't1')!;
    expect(drifted.findings[0]!.state).toBe('NAME_CHANGED');
    // "Pay later" is excluded as claimed, leaving exactly one candidate.
    expect(drifted.findings[0]!.proposal).toBe("page.getByRole('button', { name: 'Pay now' })");
    const live = report.tests.find((test) => test.testId === 't2')!;
    expect(live.findings[0]!.state).toBe('PRESENT');
  });
});

// ─── What is never claimed ───────────────────────────────────────────────────

describe('what this check refuses to measure', () => {
  it('says UNMEASURED, not "no drift", when nothing has been crawled', () => {
    // The two look identical from a dashboard and only one of them is good news.
    const report = driftReport({ tests: [payTest()], flowMap: null });
    expect(report.tests).toEqual([]);
    expect(report.testsThatWillFail).toBe(0);
    expect(report.headline).toMatch(/nothing could be compared/);
    expect(report.caveats.join(' ')).toMatch(/not "no drift"/);
  });

  it('makes no claim about a test whose pages the crawl never reached', () => {
    // On a page the crawl never loaded every locator is trivially missing, and
    // the report would be noise by construction.
    const report = driftReport({
      tests: [payTest()],
      flowMap: flowMap([node('/admin', [role('button', 'Suspend')])]),
    });
    expect(report.tests).toEqual([]);
    expect(report.counts.GONE).toBe(0);
    expect(report.testsThatWillFail).toBe(0);
  });

  it('makes no claim about a test it could not read in full', () => {
    const report = driftReport({
      // An unterminated template literal leaves the comment stripper inside a
      // string, which is what `behavior.incomplete` reports.
      tests: [payTest({ code: 'const a = `unterminated' })],
      flowMap: flowMap([node('/checkout', [role('button', 'Pay')])]),
    });
    expect(report.tests).toEqual([]);
  });

  it('reports an uncomparable locator as UNCOMPARABLE and predicts nothing', () => {
    const report = driftReport({
      tests: [
        payTest({
          code: [
            "test('pay', async ({ page }) => {",
            "  await page.goto('/checkout');",
            "  await page.click('#pay');",
            '});',
          ].join('\n'),
        }),
      ],
      flowMap: flowMap([node('/checkout', [role('button', 'Pay')])]),
    });
    expect(onlyFinding(report).state).toBe('UNCOMPARABLE');
    expect(report.testsThatWillFail).toBe(0);
    expect(report.caveats.join(' ')).toMatch(/could not be compared at all/);
  });

  it('discloses a crawl that was not ACCEPTED instead of hiding the warnings', () => {
    /*
     * A drift warning from a degraded crawl is a cheap hint that costs nothing
     * when it is wrong — the opposite of a retirement, which is refused
     * outright on the same crawl. The asymmetry is stated rather than assumed.
     */
    const map = flowMap([node('/checkout', [role('button', 'Pay now')])]);
    const report = driftReport({
      tests: [payTest()],
      flowMap: { ...map, acceptance: { ...accepted(), state: 'CANDIDATE', reasons: ['shrank'] } },
    });
    expect(report.crawlAcceptance).toBe('CANDIDATE');
    expect(report.testsThatWillFail).toBe(1);
    expect(report.caveats.join(' ')).toMatch(/adjudicated CANDIDATE rather than ACCEPTED/);
    expect(report.caveats.join(' ')).toMatch(/refused outright/);
  });

  it('discloses the cap when it bites, with the total it bit at', () => {
    const tests = Array.from({ length: 5 }, (_, index) =>
      payTest({ id: `t${index}`, name: `pay ${index}` }),
    );
    const report = driftReport({
      tests,
      flowMap: flowMap([node('/checkout', [testId('receipt')])]),
      maxWarnings: 2,
    });
    expect(report.tests).toHaveLength(2);
    expect(report.cappedAt).toBe(5);
    // A capped list can never read as the whole list: the total is in the text
    // and the headline counts every failing test, not the listed ones.
    expect(report.caveats.join(' ')).toMatch(/5 tests have drifted locators and the first 2/);
    expect(report.testsThatWillFail).toBe(5);
  });
});

// ─── The headline ────────────────────────────────────────────────────────────

describe('the cheapest number in the product', () => {
  it('reports zero out loud', () => {
    // A surface that renders nothing when nothing drifted is indistinguishable
    // from one that forgot to ask.
    expect(headlineFor(0, 0, 0)).toMatch(/Nothing is predicted to fail/);
  });

  it('singularises, so the sentence reads like a sentence', () => {
    expect(headlineFor(1, 1, 1)).toMatch(/^1 test will fail .* unless 1 locator is updated\./);
    expect(headlineFor(2, 3, 0)).toMatch(/^2 tests will fail .* unless 3 locators are updated\./);
  });

  it('distinguishes all-repairable, some-repairable and none-repairable', () => {
    expect(headlineFor(2, 4, 4)).toMatch(/rewrite them all with no model/);
    expect(headlineFor(2, 4, 1)).toMatch(/1 of them have exactly one unambiguous new target/);
    expect(headlineFor(2, 4, 0)).toMatch(/every repair is a human decision/);
  });
});

// ─── The crawl index ─────────────────────────────────────────────────────────

describe('reading the crawl', () => {
  it('indexes affordances AND form fields, per route', () => {
    const withForm: FlowNode = {
      ...node('/signup', []),
      forms: [
        {
          id: 'f1',
          name: 'signup',
          selector: testId('signup-form'),
          fields: [
            {
              name: 'email',
              label: 'Email',
              inputType: 'email',
              required: true,
              semantic: 'email',
              selector: { strategy: 'LABEL', value: 'Email', confidence: 0.9 },
            },
          ],
          submit: role('button', 'Create account'),
        },
      ],
    };
    const index = crawlIndex(flowMap([withForm]));
    expect(index.routes).toEqual(['/signup']);
    expect([...index.byIdentity.keys()].sort()).toEqual([
      'label=email',
      'role=button[create account]',
      'testid=signup-form',
    ]);
  });

  it('counts a CSS affordance as uncomparable rather than as an element', () => {
    const index = crawlIndex(
      flowMap([node('/checkout', [{ strategy: 'CSS', value: '.btn-pay', confidence: 0.4 }])]),
    );
    expect(index.elements).toEqual([]);
    expect(index.uncomparable).toBe(1);
  });

  it('survives a stored flow map with missing arrays', () => {
    // A stored FlowMap is JSON written by an older crawler. A missing
    // `affordances` must narrow the comparison, not throw inside a sweep.
    const broken = {
      ...flowMap([]),
      nodes: [{ route: '/checkout' }],
    } as unknown as FlowMap;
    expect(() => crawlIndex(broken)).not.toThrow();
    expect(crawlIndex(broken).routes).toEqual(['/checkout']);
  });
});
