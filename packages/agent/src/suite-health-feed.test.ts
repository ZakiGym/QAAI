/**
 * The path from a finding to a change, which did not exist.
 *
 * This module has named duplicate clusters and weak assertions since it was
 * written, and NOTHING COULD ACT ON THEM: the suite only ever grew. These tests
 * are about the four refusals in `refactorFeed`, because each one is a way this
 * feature could destroy a reviewer's work:
 *
 *   • a cluster whose members differ is not merged — that member is frequently
 *     the only test that catches a regression;
 *   • a cluster spanning files is not merged — a cross-file merge deletes a file;
 *   • an INCOMPLETE scan proposes nothing — its clusters are a floor, and
 *     merging three of five leaves two near-duplicates where there were five;
 *   • a finding about a test whose source was not read completely is not acted
 *     on.
 *
 * And every refusal is RETURNED. A finding silently not acted on reads as a
 * finding nobody found, which is the state this whole file is trying to leave.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_REFACTOR_CANDIDATES,
  WEAKNESS_IS_STRENGTHENABLE,
  analyzeSuiteHealth,
  refactorFeed,
} from './suite-health.js';
import type { SuiteHealthReport, WeakAssertionKind } from './suite-health.js';

function cluster(over: Partial<SuiteHealthReport['duplicateClusters'][number]> = {}) {
  return {
    testIds: ['t1', 't2'],
    size: 2,
    members: [
      {
        testId: 't1',
        name: 'checkout total',
        filePath: 'tests/checkout.spec.ts',
        feature: 'checkout',
        priority: 'IMPORTANT' as const,
      },
      {
        testId: 't2',
        name: 'checkout total again',
        filePath: 'tests/checkout.spec.ts',
        feature: 'checkout',
        priority: 'IMPORTANT' as const,
      },
    ],
    sharedRoutes: ['/checkout'],
    sharedActions: ['click Checkout'],
    sharedAssertions: ['total'],
    membersDiffer: false,
    recommendation: 'Compare them.',
    ...over,
  };
}

function weak(over: Partial<SuiteHealthReport['weakAssertions'][number]> = {}) {
  return {
    kind: 'EXISTENCE_ONLY' as WeakAssertionKind,
    severity: 'HIGH' as const,
    testId: 't9',
    testName: 'cart loads',
    filePath: 'tests/cart.spec.ts',
    feature: 'cart',
    line: 7,
    quote: 'await expect(page.getByTestId("total")).toBeVisible();',
    why: 'It proves the element exists and nothing about its value.',
    assertInstead: 'Assert the total reads $42.00.',
    ...over,
  };
}

function report(over: Partial<SuiteHealthReport> = {}): SuiteHealthReport {
  return {
    duplicateClusters: [],
    weakAssertions: [],
    unanalyzed: [],
    limits: { duplicateScanComplete: true, duplicateScanNote: null },
    ...over,
  } as unknown as SuiteHealthReport;
}

describe('a duplicate cluster', () => {
  it('becomes a merge candidate when its members agree and share one file', () => {
    const feed = refactorFeed(report({ duplicateClusters: [cluster()] }));

    expect(feed.merges).toHaveLength(1);
    expect(feed.merges[0]?.testIds).toEqual(['t1', 't2']);
    // The finding is quoted into the proposal's rationale, so a reviewer reads
    // WHY this was offered rather than only what it does.
    expect(feed.merges[0]?.finding).toMatch(/walk the same routes \(\/checkout\)/);
    expect(feed.declined).toEqual([]);
  });

  /*
   * REFUSAL ONE, and it is rule ONE of this module as a behaviour: a duplicate
   * that differs in one assertion is frequently the only test that catches a
   * regression.
   */
  it('is declined, by name, when one member asserts something the others do not', () => {
    const feed = refactorFeed(
      report({ duplicateClusters: [cluster({ membersDiffer: true })] }),
    );

    expect(feed.merges).toEqual([]);
    expect(feed.declined).toHaveLength(1);
    expect(feed.declined[0]?.operation).toBe('MERGE_NEAR_DUPLICATES');
    expect(feed.declined[0]?.testIds).toEqual(['t1', 't2']);
    expect(feed.declined[0]?.why).toMatch(/would drop a check/);
  });

  it('is declined when it spans files, because a cross-file merge deletes one', () => {
    const spanning = cluster({
      members: [
        {
          testId: 't1',
          name: 'a',
          filePath: 'tests/a.spec.ts',
          feature: null,
          priority: 'IMPORTANT' as const,
        },
        {
          testId: 't2',
          name: 'b',
          filePath: 'tests/b.spec.ts',
          feature: null,
          priority: 'IMPORTANT' as const,
        },
      ],
    });
    const feed = refactorFeed(report({ duplicateClusters: [spanning] }));

    expect(feed.merges).toEqual([]);
    expect(feed.declined[0]?.why).toMatch(/spans 2 files/);
  });

  /*
   * REFUSAL THREE. `scoreSuiteHealth` already refuses to GRADE duplication off
   * an incomplete scan; this refuses to ACT on one, and for a sharper reason —
   * merging three members of a cluster that is really five leaves two
   * near-duplicates where there were five.
   */
  it('proposes nothing at all when the scan did not complete, and says why', () => {
    const feed = refactorFeed(
      report({
        duplicateClusters: [cluster()],
        limits: {
          duplicateScanComplete: false,
          duplicateScanNote: 'the pair cap was reached',
        } as SuiteHealthReport['limits'],
      }),
    );

    expect(feed.merges).toEqual([]);
    expect(feed.declined).toHaveLength(1);
    expect(feed.declined[0]?.why).toMatch(/FLOOR rather than a total/);
    expect(feed.declined[0]?.why).toMatch(/the pair cap was reached/);
    // The cluster's tests are NAMED in the refusal, so the finding is traceable
    // rather than merely absent.
    expect(feed.declined[0]?.testIds).toEqual(['t1', 't2']);
  });

  it('is declined when a member was never read completely', () => {
    const feed = refactorFeed(
      report({
        duplicateClusters: [cluster()],
        unanalyzed: [
          { testId: 't2', name: 'b', filePath: 'tests/checkout.spec.ts', reason: 'too large' },
        ],
      }),
    );

    expect(feed.merges).toEqual([]);
    expect(feed.declined[0]?.why).toMatch(/not read completely/);
  });
});

describe('a weak assertion', () => {
  it('becomes a strengthening candidate, carrying the finding verbatim', () => {
    const feed = refactorFeed(report({ weakAssertions: [weak()] }));

    expect(feed.strengthenings).toHaveLength(1);
    expect(feed.strengthenings[0]?.testId).toBe('t9');
    expect(feed.strengthenings[0]?.finding).toMatch(/\[HIGH\] EXISTENCE_ONLY in "cart loads"/);
    expect(feed.strengthenings[0]?.finding).toMatch(/Assert the total reads \$42\.00\./);
  });

  /*
   * A missing error path is a NEW TEST, not a rewrite of this one, and a
   * swallowed assertion needs CONTROL FLOW changed — which
   * `strengthenAssertions` never does. Proposing either would produce a diff
   * that does not do what the proposal's title says.
   */
  it('is declined when strengthening is not the shape of the fix', () => {
    const feed = refactorFeed(
      report({
        weakAssertions: [
          weak({ kind: 'NO_NEGATIVE_PATH', testId: 'tn' }),
          weak({ kind: 'SWALLOWED_ASSERTION', testId: 'ts' }),
        ],
      }),
    );

    expect(feed.strengthenings).toEqual([]);
    expect(feed.declined.map((entry) => entry.testIds[0])).toEqual(['tn', 'ts']);
    expect(feed.declined[0]?.why).toMatch(/new test, not a rewrite/);
    expect(feed.declined[1]?.why).toMatch(/changes what the test does/);
  });

  it('decides for every weakness kind whether strengthening is the fix', () => {
    /*
     * The run-time half of a compiler-enforced record. The compiler proves every
     * key exists; this proves the keys are the vocabulary's own rather than a
     * stale copy, which is what breaks when a seventh kind is added above.
     */
    expect(Object.keys(WEAKNESS_IS_STRENGTHENABLE).sort()).toEqual(
      [
        'EXISTENCE_ONLY',
        'NO_ASSERTIONS',
        'NO_NEGATIVE_PATH',
        'SWALLOWED_ASSERTION',
        'TRANSPORT_ONLY',
        'VOLATILE_ASSERTION',
      ].sort(),
    );
  });
});

describe('the candidate cap', () => {
  /*
   * A cap that BIT, reported as a count. A caller that saw twenty merges has to
   * be able to tell "there were twenty" from "there were twenty of ninety" —
   * otherwise a review queue that looks finished is a review queue with seventy
   * findings behind it.
   */
  it('is disclosed as a count rather than a shorter list', () => {
    const clusters = Array.from({ length: MAX_REFACTOR_CANDIDATES + 5 }, (_unused, i) =>
      cluster({
        testIds: [`a${i}`, `b${i}`],
        members: [
          {
            testId: `a${i}`,
            name: `a${i}`,
            filePath: `tests/f${i}.spec.ts`,
            feature: null,
            priority: 'IMPORTANT' as const,
          },
          {
            testId: `b${i}`,
            name: `b${i}`,
            filePath: `tests/f${i}.spec.ts`,
            feature: null,
            priority: 'IMPORTANT' as const,
          },
        ],
      }),
    );
    const weaknesses = Array.from({ length: MAX_REFACTOR_CANDIDATES + 3 }, (_unused, i) =>
      weak({ testId: `w${i}` }),
    );

    const feed = refactorFeed(
      report({ duplicateClusters: clusters, weakAssertions: weaknesses }),
    );

    expect(feed.merges).toHaveLength(MAX_REFACTOR_CANDIDATES);
    expect(feed.omitted.merges).toBe(5);
    expect(feed.strengthenings).toHaveLength(MAX_REFACTOR_CANDIDATES);
    expect(feed.omitted.strengthenings).toBe(3);
  });
});

describe('an empty report', () => {
  it('proposes nothing and declines nothing, which are different from each other', () => {
    const feed = refactorFeed(report());
    expect(feed).toEqual({
      merges: [],
      strengthenings: [],
      declined: [],
      omitted: { merges: 0, strengthenings: 0 },
    });
  });
});


describe('an incomplete scan always says why', () => {
  /*
   * THE INVARIANT `refactorFeed` DEPENDS ON. `complete: false` has three
   * causes — a pair cap, a token too common to expand, and a test that was
   * never eligible to be compared — and only the first two had a sentence
   * behind them. The third is reached by the smallest possible suite, so
   * `duplicateScanNote` came back NULL and every downstream reader had to
   * invent a reason. `refactorFeed` invented "a cap was reached", which was
   * false, and `scoreSuiteHealth` papered over it with "no test could be
   * compared", which is nearly right and is not the measurement.
   *
   * This is asserted over the REAL `analyzeSuiteHealth` rather than a
   * hand-built report, because the hand-built reports above can only pin what
   * `refactorFeed` does with a note — not that a note exists to be read.
   */
  it('names the tests it was never able to compare', () => {
    const report = analyzeSuiteHealth({
      tests: [
        {
          id: 't1',
          name: 'cart loads',
          filePath: 'tests/cart.spec.ts',
          type: 'E2E',
          priority: 'IMPORTANT',
          feature: 'cart',
          tags: [],
          code: `import { test, expect } from '@playwright/test';
test('cart loads', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByTestId('total')).toHaveText('$1.00');
});
`,
          spec: null,
          flakeRate: 0,
          quarantined: false,
          consecutiveFailures: 0,
        },
      ],
    });

    expect(report.limits.duplicateScanComplete).toBe(false);
    expect(report.limits.duplicateScanNote).not.toBeNull();
    expect(report.limits.duplicateScanNote).toMatch(/never eligible to be compared/);

    // And the feed quotes that note rather than inventing a cause.
    const feed = refactorFeed(report);
    expect(feed.merges).toEqual([]);
    expect(feed.declined[0]?.why).toMatch(/never eligible to be compared/);
    expect(feed.declined[0]?.why).not.toMatch(/a cap was reached/);
  });
});
