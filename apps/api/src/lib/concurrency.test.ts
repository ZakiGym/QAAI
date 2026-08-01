/**
 * Tests for the org-wide concurrency budget.
 *
 * This module can refuse a customer's CI run, which makes its failure modes
 * asymmetric and worth pinning down one at a time:
 *
 *   - refusing when there IS room is the expensive bug. It looks like an outage
 *     to the person it happens to, and they cannot work around it.
 *   - allowing when there is not is cheap and self-correcting: the pool gets a
 *     little deeper for a little while.
 *
 * So every boundary below is tested from the allowing side as well as the
 * refusing one, and the fail-open behaviour is tested as a contract rather than
 * left as a comment. The database is deliberately absent — the decision, the
 * arithmetic and the wording are all pure functions, which is why they were
 * written as pure functions.
 */

import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS } from '@qaai/shared';
import {
  ORG_CONCURRENCY_FACTOR,
  describeWait,
  orgConcurrencyBudget,
  soonestFreeMs,
  verdictFor,
  type ConcurrencySnapshot,
  type InFlightSlot,
} from './concurrency.js';

const snapshot = (over: Partial<ConcurrencySnapshot>): ConcurrencySnapshot => ({
  inFlight: 0,
  runs: 0,
  budget: 10,
  available: 10,
  freesInMs: null,
  ...over,
});

const slot = (over: Partial<InFlightSlot>): InFlightSlot => ({
  runId: 'run_1',
  running: true,
  startedAt: new Date(0),
  estimatedMs: 60_000,
  ...over,
});

describe('the budget derived from a plan', () => {
  it('is the per-run worker ceiling times the factor, for every plan', () => {
    for (const [plan, limits] of Object.entries(PLAN_LIMITS)) {
      expect(orgConcurrencyBudget(limits), plan).toBe(
        limits.maxParallelWorkers * ORG_CONCURRENCY_FACTOR,
      );
    }
  });

  it('lets the widest run a plan sells coexist with a second one', () => {
    // The whole reason the factor is not 1. A Team org whose 5-shard run is in
    // flight must still be able to start the next pull request's run; a budget
    // equal to maxParallelWorkers would 402 it while the box sat half idle.
    const team = PLAN_LIMITS.TEAM;
    expect(orgConcurrencyBudget(team)).toBeGreaterThanOrEqual(team.maxParallelWorkers * 2);
  });

  it('never returns a budget of zero, whatever the plan says', () => {
    // A bad edit to PLAN_LIMITS must not lock an org out of the product
    // entirely. One run is the floor.
    expect(orgConcurrencyBudget({ ...PLAN_LIMITS.FREE, maxParallelWorkers: 0 })).toBe(1);
    expect(orgConcurrencyBudget({ ...PLAN_LIMITS.FREE, maxParallelWorkers: -3 })).toBe(1);
  });
});

describe('the verdict', () => {
  it('allows while a single slot remains', () => {
    // The boundary from the allowing side. Nine of ten held is not full.
    expect(verdictFor(snapshot({ inFlight: 9, budget: 10, available: 1 }), 'Team').allowed).toBe(
      true,
    );
  });

  it('refuses only when nothing at all is free', () => {
    const verdict = verdictFor(
      snapshot({ inFlight: 10, budget: 10, available: 0, runs: 3 }),
      'Team',
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.limit).toBe('concurrency');
  });

  it('still refuses when the org is somehow over budget', () => {
    // Over-subscription is reachable: the budget shrinks the moment a
    // subscription lapses to FREE limits, while the runs already in flight
    // carry on. `available` is clamped at zero rather than going negative, and
    // the verdict must not read the sign of a subtraction to decide.
    const verdict = verdictFor(snapshot({ inFlight: 40, budget: 10, available: 0 }), 'Free');
    expect(verdict.allowed).toBe(false);
  });

  it('names the plan, the ceiling and what is using it', () => {
    const reason =
      verdictFor(snapshot({ inFlight: 10, budget: 10, available: 0, runs: 3 }), 'Team').reason ??
      '';
    expect(reason).toContain('Team');
    expect(reason).toContain('10');
    expect(reason).toContain('3 runs');
  });

  it('says when capacity frees up, when it can tell', () => {
    const reason =
      verdictFor(
        snapshot({ inFlight: 10, budget: 10, available: 0, runs: 2, freesInMs: 4 * 60_000 }),
        'Team',
      ).reason ?? '';
    expect(reason).toContain('about 4 minutes');
  });

  it('does not invent a time when nothing in flight can predict one', () => {
    // Every slot is queued, so nothing has started and there is no honest
    // estimate. The message must degrade to "as those finish" rather than
    // guessing a number the user would then plan around.
    const reason =
      verdictFor(snapshot({ inFlight: 10, budget: 10, available: 0, runs: 2 }), 'Team').reason ??
      '';
    expect(reason).toContain('as those finish');
    expect(reason).not.toMatch(/\babout\b/);
  });

  it('says "1 run" rather than "1 runs"', () => {
    const reason =
      verdictFor(snapshot({ inFlight: 2, budget: 2, available: 0, runs: 1 }), 'Free').reason ?? '';
    expect(reason).toContain('your 1 run');
    expect(reason).not.toContain('1 runs');
  });

  it('tells the reader waiting is an option, not only upgrading', () => {
    // This limit is temporary, unlike every other one in plan.ts. A message
    // that only offers an upgrade would be selling a fix for a problem that
    // resolves itself in four minutes.
    const reason =
      verdictFor(
        snapshot({ inFlight: 10, budget: 10, available: 0, runs: 2, freesInMs: 90_000 }),
        'Team',
      ).reason ?? '';
    expect(reason.toLowerCase()).toContain('start this run then');
  });
});

describe('predicting when the next slot frees', () => {
  const now = 100_000;

  it('takes the soonest of the running slots', () => {
    const free = soonestFreeMs(
      [
        slot({ startedAt: new Date(now - 10_000), estimatedMs: 60_000 }), // 50s left
        slot({ startedAt: new Date(now - 50_000), estimatedMs: 60_000 }), // 10s left
        slot({ startedAt: new Date(now - 1_000), estimatedMs: 600_000 }), // 599s left
      ],
      now,
    );
    expect(free).toBe(10_000);
  });

  it('ignores queued slots entirely', () => {
    // A queued shard has not started, so the only honest statement about when
    // it finishes is none. Counting it as "0ms elapsed, therefore estimatedMs
    // remaining" would report a slot freeing that has not begun to occupy one.
    expect(soonestFreeMs([slot({ running: false, startedAt: null })], now)).toBeNull();
  });

  it('ignores a running slot the packer had no estimate for', () => {
    // estimatedMs is 0 when the split had no duration history to pack with.
    // Zero is "unknown", not "finishes immediately" — reporting the latter
    // would tell someone to retry now and have them refused again.
    expect(soonestFreeMs([slot({ estimatedMs: 0 })], now)).toBeNull();
  });

  it('reports zero, never a negative, for a slot past its estimate', () => {
    // Long-overrunning tests are exactly the ones holding the pool. A negative
    // here would render as "in about -12 minutes".
    const free = soonestFreeMs(
      [slot({ startedAt: new Date(now - 900_000), estimatedMs: 60_000 })],
      now,
    );
    expect(free).toBe(0);
  });

  it('is null when nothing is in flight', () => {
    expect(soonestFreeMs([], now)).toBeNull();
  });

  it('prefers a known estimate over an unknown sibling', () => {
    const free = soonestFreeMs(
      [
        slot({ estimatedMs: 0 }),
        slot({ running: false, startedAt: null }),
        slot({ startedAt: new Date(now - 5_000), estimatedMs: 30_000 }),
      ],
      now,
    );
    expect(free).toBe(25_000);
  });
});

describe('how a wait is worded', () => {
  it('stays vague, because the input is a prediction', () => {
    expect(describeWait(30_000)).toBe('in under a minute');
    expect(describeWait(0)).toBe('in under a minute');
    expect(describeWait(4 * 60_000)).toBe('in about 4 minutes');
    expect(describeWait(60_000)).toBe('in about 1 minute');
    expect(describeWait(3 * 60 * 60_000)).toBe('in about 3 hours');
  });

  it('returns null for an unknown wait rather than a placeholder string', () => {
    // The caller branches on null to pick a different sentence. A "soon" here
    // would put an unfounded promise in a 402.
    expect(describeWait(null)).toBeNull();
  });

  it('never says "1 minutes" or "1 hours"', () => {
    expect(describeWait(60_000)).not.toContain('minutes');
    expect(describeWait(60 * 60_000)).not.toContain('hours');
  });
});
