import { describe, expect, it } from 'vitest';
import type { GateResult } from '@qaai/shared';
import {
  gateAwaitsTriage,
  gateBlockReason,
  gateBlockers,
  gateUnmeasuredCount,
  gateWord,
} from './gate';

/**
 * Reading a gate without inventing an answer.
 *
 * Every case here is written against the one mistake this module exists to
 * prevent: treating `passed: null` — NOT MEASURED — as a boolean. The web's own
 * gate type said `passed: boolean`, so `!e.passed` was true for a rule nothing
 * scored, and the run log printed "not measured — …" as the reason a merge was
 * blocked. The expectations are therefore phrased as the product promise
 * ("an unmeasured rule is not the reason a merge was blocked") rather than as a
 * restatement of the filter under test.
 */

type Evaluation = GateResult['evaluations'][number];

const blockOnVerdict: Evaluation['rule'] = {
  kind: 'BLOCK_ON_VERDICT',
  verdict: 'REAL_BUG',
  onlyPriorities: [],
};

const minCoverage: Evaluation['rule'] = {
  kind: 'MIN_COVERAGE',
  percent: 80,
  action: 'BLOCK',
};

/** A rule nothing could score: null, UNMEASURED, and a detail that says so. */
const unmeasured = (rule: Evaluation['rule'], why: string): Evaluation => ({
  rule,
  passed: null,
  action: 'UNMEASURED',
  detail: `not measured — ${why}`,
});

const blocked = (rule: Evaluation['rule'], detail: string): Evaluation => ({
  rule,
  passed: false,
  action: 'BLOCK',
  detail,
});

const passed = (rule: Evaluation['rule'], detail: string): Evaluation => ({
  rule,
  passed: true,
  action: 'PASS',
  detail,
});

const gate = (evaluations: Evaluation[], over: Partial<GateResult> = {}): GateResult => ({
  passed: !evaluations.some((e) => e.action === 'BLOCK'),
  evaluations,
  ...over,
});

describe('gateBlockReason', () => {
  it('does not name an unmeasured rule as the reason a merge was blocked', () => {
    // The exact shape of the defect: the unmeasured rule comes FIRST, so a
    // `!e.passed` scan picks it, and the row reads "no coverage snapshot has
    // been computed" on a run that was blocked by a real bug.
    const result = gate([
      unmeasured(minCoverage, 'no coverage snapshot has been computed for this project'),
      blocked(blockOnVerdict, '1 REAL_BUG verdict blocks this run'),
    ]);
    expect(gateBlockReason(result)).toBe('1 REAL_BUG verdict blocks this run');
  });

  it('is null when nothing blocked, however many rules went unmeasured', () => {
    // Null and not a sentence: a red run with no blocking rule failed its tests
    // or fell over, and both have a better explanation on the row already.
    const result = gate([
      unmeasured(minCoverage, 'no coverage snapshot has been computed for this project'),
      passed(blockOnVerdict, 'no blocking verdict'),
    ]);
    expect(gateBlockReason(result)).toBeNull();
    expect(gateBlockers(result)).toEqual([]);
  });

  it('is null for a run with no gate at all', () => {
    expect(gateBlockReason(null)).toBeNull();
    expect(gateBlockReason(undefined)).toBeNull();
  });

  it('ignores a WARN, which said so and did not hold the merge', () => {
    const result = gate([
      { rule: minCoverage, passed: false, action: 'WARN', detail: 'coverage slipped to 74%' },
    ]);
    expect(gateBlockReason(result)).toBeNull();
  });
});

describe('gateUnmeasuredCount', () => {
  it('prefers the evaluator’s own count', () => {
    const result = gate([unmeasured(minCoverage, 'nothing to measure')], { unmeasured: 1 });
    expect(gateUnmeasuredCount(result)).toBe(1);
  });

  it('cannot report more unmeasured rules than there are rules', () => {
    // The chip renders `evaluations.length - this`, so a stored count that
    // disagrees with the stored array would print "-1 of 1 rules measured".
    const result = gate([unmeasured(minCoverage, 'nothing to measure')], { unmeasured: 7 });
    expect(gateUnmeasuredCount(result)).toBe(1);
  });

  it('counts the rows when the field is absent, rather than reporting none', () => {
    // Gate rows written before `unmeasured` existed would otherwise report 0
    // unmeasured rules while displaying two of them.
    const result = gate([
      unmeasured(minCoverage, 'nothing to measure'),
      unmeasured(blockOnVerdict, 'no verdicts yet'),
      passed(blockOnVerdict, 'fine'),
    ]);
    expect(gateUnmeasuredCount(result)).toBe(2);
  });
});

describe('gateAwaitsTriage', () => {
  it('is true for the gate a run finaliser writes: the verdict rule unmeasured', () => {
    // The definition in packages/runner/src/gates.ts, mirrored: an UNMEASURED
    // BLOCK_ON_VERDICT rule. Finalisation runs before any verdict exists, so
    // the one rule every new project gets has nothing to score.
    const result = gate([unmeasured(blockOnVerdict, 'no verdict has been reached yet')]);
    expect(gateAwaitsTriage(result)).toBe(true);
    expect(gateWord(result)).toBe('PROVISIONAL');
  });

  it('is false when the unmeasured rule is not about verdicts', () => {
    // A project that gates on coverage is not waiting on triage, and the page
    // used to label every un-triaged failure PROVISIONAL regardless.
    const result = gate([unmeasured(minCoverage, 'no coverage snapshot')]);
    expect(gateAwaitsTriage(result)).toBe(false);
    expect(gateWord(result)).toBe('PASS');
  });

  it('is false once the verdict rule has been scored', () => {
    const result = gate([passed(blockOnVerdict, 'no REAL_BUG verdict in this run')]);
    expect(gateAwaitsTriage(result)).toBe(false);
  });
});

describe('gateWord', () => {
  it('says BLOCK for a gate that blocked, even while something is unmeasured', () => {
    const result = gate([
      blocked(blockOnVerdict, '1 REAL_BUG verdict blocks this run'),
      unmeasured(minCoverage, 'no coverage snapshot'),
    ]);
    expect(gateWord(result)).toBe('BLOCK');
  });

  it('never says PASS about a gate it was handed nothing for', () => {
    // A terminal run with no stored gate has not been cleared by anything.
    expect(gateWord(null)).toBe('PROVISIONAL');
  });

  it('says PASS only for a measured, unblocked, non-provisional gate', () => {
    expect(gateWord(gate([passed(blockOnVerdict, 'no blocking verdict')]))).toBe('PASS');
  });
});
