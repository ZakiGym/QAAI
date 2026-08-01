/**
 * Safety tests for build bisect.
 *
 * This module points at a commit and, by implication, at whoever wrote it. Its
 * failure mode is not an error — it is a confident, well-formatted accusation of
 * the wrong change, which someone then spends an afternoon reverting. The
 * contract, stated in bisect.ts and enforced here, is:
 *
 *   **Any doubt must widen the answer, never sharpen it.**
 *
 * Every case below is a way the search could have produced a crisp suspect it
 * had no right to: a flaky test, a retry laundered into a green, a cancelled run
 * read as a failure, a commit QAAI cannot actually re-run. Each one has to come
 * out as a refusal, a range, or a caveat — never as a commit sha on its own.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeHistory,
  applyProbe,
  buildTimeline,
  findBoundary,
  measureFlake,
  nextProbe,
  probeBudget,
  type BisectRunRow,
} from './bisect.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Outcome =
  | 'pass'
  | 'fail'
  | 'timeout'
  | 'retry-pass'
  /** The run errored or was cancelled: it measured nothing. */
  | 'errored'
  | 'cancelled'
  /** The run reported, but recorded no result for this test. */
  | 'absent'
  | 'skipped';

let tick = 0;
const nextAt = (): Date => new Date(Date.UTC(2026, 0, 1, 0, tick++));

interface RowOptions {
  /** A commit-pinned preview URL makes the commit probeable. */
  pinned?: boolean;
  at?: Date;
  triggeredBy?: string | null;
}

function row(commitSha: string | null, outcome: Outcome, opts: RowOptions = {}): BisectRunRow {
  const runStatus =
    outcome === 'errored'
      ? 'ERRORED'
      : outcome === 'cancelled'
        ? 'CANCELLED'
        : outcome === 'pass' || outcome === 'retry-pass'
          ? 'PASSED'
          : outcome === 'absent' || outcome === 'skipped'
            ? 'PASSED'
            : 'FAILED';

  const result =
    outcome === 'errored' || outcome === 'cancelled' || outcome === 'absent'
      ? null
      : {
          status:
            outcome === 'fail'
              ? 'FAILED'
              : outcome === 'timeout'
                ? 'TIMED_OUT'
                : outcome === 'skipped'
                  ? 'SKIPPED'
                  : 'PASSED',
          retriedAndPassed: outcome === 'retry-pass',
        };

  return {
    runId: `run-${tick}-${commitSha ?? 'none'}`,
    commitSha,
    runStatus,
    triggeredBy: opts.triggeredBy ?? null,
    queuedAt: opts.at ?? nextAt(),
    environmentId: 'env-1',
    baseUrlOverride: opts.pinned ? `https://preview-${commitSha}.example.com` : null,
    result,
  };
}

/** `'c1:pass c2:fail'` — a whole history in one string, oldest first. */
function history(spec: string, opts: { pinned?: boolean } = {}): BisectRunRow[] {
  tick = 0;
  return spec
    .trim()
    .split(/\s+/)
    .map((part) => {
      const [sha, outcome] = part.split(':');
      return row(sha!, outcome as Outcome, { pinned: opts.pinned });
    });
}

// ─── History alone, which is the point ───────────────────────────────────────

describe('history first: the cheap answer, when the cheap answer is sound', () => {
  it('names the commit and runs nothing when green and red are adjacent', () => {
    const result = analyzeHistory(history('c1:pass c2:pass c3:fail c4:fail'));

    expect(result.status).toBe('ANSWERED');
    expect(result.suspect?.commitSha).toBe('c3');
    expect(result.lastGood?.commitSha).toBe('c2');
    expect(result.plan).toBeNull();
    expect(result.summary).toContain('No re-runs were needed');
  });

  it('explains the most recent regression, not the first one', () => {
    // Broke at c2, fixed at c4, broke again at c6. Someone asking today is
    // asking about c6; c2 is context, and saying "c2" would be wrong.
    const result = analyzeHistory(history('c1:pass c2:fail c3:fail c4:pass c5:pass c6:fail'));

    expect(result.suspect?.commitSha).toBe('c6');
    expect(result.boundary.priorRegressions).toBe(1);
    expect(result.caveats.join(' ')).toContain('went red and green again');
  });

  it('walks back past commits with no result to find the real last green', () => {
    const rows = [
      ...history('c1:pass'),
      row('c2', 'errored'),
      row('c3', 'fail'),
      row('c4', 'fail'),
    ];
    const result = analyzeHistory(rows);

    // c2 measured nothing, so it is the search space — not the suspect, and not
    // a green the answer can lean on.
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.boundary.firstRed?.commitSha).toBe('c3');
    expect(result.boundary.lastGreen?.commitSha).toBe('c1');
    expect(result.boundary.unknown.map((c) => c.commitSha)).toEqual(['c2']);
  });
});

// ─── The accusations it must not make ────────────────────────────────────────

describe('a flaky test is never bisected', () => {
  it('refuses when the test disagreed with itself often enough to be measured', () => {
    // Four commits each run twice; one gave both answers. 25% is noise enough
    // that a three-step search lands on the wrong commit more often than not.
    const rows = [
      row('c1', 'pass'),
      row('c1', 'pass'),
      row('c2', 'pass'),
      row('c2', 'fail'),
      row('c3', 'pass'),
      row('c3', 'pass'),
      row('c4', 'fail'),
      row('c4', 'fail'),
    ];
    const result = analyzeHistory(rows);

    expect(result.status).toBe('REFUSED');
    expect(result.suspect).toBeNull();
    expect(result.summary).toContain('Refusing to bisect');
    // The refusal carries the measurement, so it can be argued with.
    expect(result.summary).toContain('25%');
  });

  it('refuses when the test both passes and fails at the newest commit', () => {
    const rows = [row('c1', 'pass'), row('c2', 'fail'), row('c2', 'pass')];
    const result = analyzeHistory(rows, { maxFlakePercent: 100 });

    expect(result.status).toBe('REFUSED');
    expect(result.summary).toContain('flaky test, not a regression');
  });

  it('refuses when a commit inside the boundary gave both answers', () => {
    // The rate is under the threshold, so the search would have proceeded — and
    // it would have had to call c2 either green or red to do it.
    const rows = [
      row('c1', 'pass'),
      row('c2', 'pass'),
      row('c2', 'fail'),
      row('c3', 'fail'),
      row('c4', 'fail'),
    ];
    const result = analyzeHistory(rows, { maxFlakePercent: 100 });

    expect(result.status).toBe('REFUSED');
    expect(result.suspect).toBeNull();
    expect(result.summary).toContain('cannot be called either way');
  });

  it('never reads an unmeasured test as a stable one', () => {
    const result = analyzeHistory(history('c1:pass c2:pass c3:fail'));

    expect(result.flake.measured).toBe(false);
    expect(result.flake.ratePercent).toBe(0);
    // A rate of 0 that nobody measured must not read as evidence of stability.
    expect(result.caveats.join(' ')).toContain('Stability was not measured');
    expect(result.confidence).toBe('probable');
  });

  it('demands repeats per probe until stability is measured, and one when it is', () => {
    const unmeasured = analyzeHistory([
      row('c1', 'pass', { pinned: true }),
      row('c2', 'absent', { pinned: true }),
      row('c3', 'absent', { pinned: true }),
      row('c4', 'fail', { pinned: true }),
    ]);
    expect(unmeasured.status).toBe('NEEDS_PROBES');
    expect(unmeasured.plan?.repeats).toBe(3);
    expect(unmeasured.plan?.repeatsReason).toContain('rather than trusting a single result');

    const measured = analyzeHistory([
      row('c1', 'pass', { pinned: true }),
      row('c1', 'pass', { pinned: true }),
      row('c2', 'pass', { pinned: true }),
      row('c2', 'pass', { pinned: true }),
      row('c3', 'absent', { pinned: true }),
      row('c4', 'absent', { pinned: true }),
      row('c5', 'fail', { pinned: true }),
    ]);
    expect(measured.plan?.repeats).toBe(1);
    expect(measured.plan?.repeatsReason).toContain('never disagreed with itself');
  });
});

describe('a result that is not evidence is never treated as evidence', () => {
  it('does not let a retry-that-passed stand as the last green', () => {
    // §5: a retry that passes is not a pass. If c2 counted as green the answer
    // would be c3, and the commit that actually broke it would be exonerated.
    const result = analyzeHistory(history('c1:pass c2:retry-pass c3:fail'), {
      maxFlakePercent: 100,
    });

    expect(result.boundary.lastGreen?.commitSha).toBe('c1');
    expect(result.boundary.firstRed?.commitSha).toBe('c2');
  });

  it('does not read a cancelled or errored run as a failure', () => {
    const rows = [row('c1', 'pass'), row('c2', 'cancelled'), row('c3', 'errored')];
    const timeline = buildTimeline(rows);

    expect(timeline.commits.map((c) => c.verdict)).toEqual(['GREEN', 'UNUSABLE', 'UNUSABLE']);
    // Nothing is red, so there is nothing to explain.
    expect(analyzeHistory(rows).status).toBe('REFUSED');
  });

  it('does not read a SKIPPED result as a pass', () => {
    const timeline = buildTimeline([row('c1', 'skipped')]);
    expect(timeline.commits[0]!.verdict).toBe('UNUSABLE');
    expect(timeline.commits[0]!.discarded).toBe(1);
  });

  it('drops runs with no commit sha instead of placing them somewhere', () => {
    // Flake-radar confirmation runs look exactly like this. Attaching them to a
    // neighbouring commit would smear one commit's evidence across the timeline.
    const rows = [row('c1', 'pass'), row(null, 'fail'), row('c2', 'fail')];
    const timeline = buildTimeline(rows);

    expect(timeline.commits.map((c) => c.commitSha)).toEqual(['c1', 'c2']);
    expect(timeline.runsWithoutCommit).toBe(1);
    expect(analyzeHistory(rows).caveats.join(' ')).toContain('carried no commit sha');
  });
});

describe('it refuses rather than guessing when there is nothing to search', () => {
  it('says so when the test is passing at the newest commit', () => {
    const result = analyzeHistory(history('c1:fail c2:pass'));
    expect(result.status).toBe('REFUSED');
    expect(result.summary).toContain('is passing');
  });

  it('says so when the test is red as far back as the window goes', () => {
    const result = analyzeHistory(history('c1:fail c2:fail c3:fail'));
    expect(result.status).toBe('REFUSED');
    expect(result.suspect).toBeNull();
    expect(result.summary).toContain('no green side');
  });

  it('says so when CI never sent a commit sha', () => {
    const result = analyzeHistory([row(null, 'pass'), row(null, 'fail')]);
    expect(result.status).toBe('REFUSED');
    expect(result.summary).toContain('commitSha');
  });
});

// ─── What a probe can and cannot reach ───────────────────────────────────────

describe('a commit QAAI cannot re-run is reported as a range, not narrowed away', () => {
  it('gives back the range when no commit in it has a pinned URL', () => {
    // Re-running an unpinned commit would hit the shared environment URL, which
    // serves whatever is deployed NOW. The result would be labelled with an old
    // sha and be entirely fictional.
    const rows = [row('c1', 'pass'), row('c2', 'absent'), row('c3', 'absent'), row('c4', 'fail')];
    const result = analyzeHistory(rows);

    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.suspect).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.summary).toContain('none can be re-run');
    expect(result.caveats.join(' ')).toContain('cannot be re-run');
  });

  it('plans probes only over the commits it can actually reach', () => {
    const rows = [
      row('c1', 'pass'),
      row('c2', 'absent', { pinned: true }),
      row('c3', 'absent'),
      row('c4', 'fail'),
    ];
    const result = analyzeHistory(rows);

    expect(result.status).toBe('NEEDS_PROBES');
    expect(result.plan?.candidates).toEqual([
      { commitSha: 'c2', probeable: true },
      { commitSha: 'c3', probeable: false },
    ]);
  });
});

describe('the budget is bounded and stated', () => {
  it('is ceil(log2(n + 1))', () => {
    expect(probeBudget(0)).toBe(0);
    expect(probeBudget(1)).toBe(1);
    expect(probeBudget(3)).toBe(2);
    expect(probeBudget(7)).toBe(3);
    expect(probeBudget(8)).toBe(4);
    expect(probeBudget(1000)).toBe(10);
  });

  it('never plans more runs than the ceiling allows', () => {
    const rows = [row('c1', 'pass', { pinned: true })];
    for (let i = 2; i < 400; i++) rows.push(row(`c${i}`, 'absent', { pinned: true }));
    rows.push(row('c400', 'fail', { pinned: true }));

    const result = analyzeHistory(rows, { maxProbeRuns: 6 });
    expect(result.plan!.fullBudget).toBeGreaterThan(result.plan!.budget);
    expect(result.plan!.budget * result.plan!.repeats).toBeLessThanOrEqual(6);
  });

  it('reports a range rather than starting a search it cannot finish at all', () => {
    const rows = [
      row('c1', 'pass', { pinned: true }),
      row('c2', 'absent', { pinned: true }),
      row('c3', 'fail', { pinned: true }),
    ];
    // Repeats of 3 with a 2-run ceiling leaves room for zero probes.
    const result = analyzeHistory(rows, { maxProbeRuns: 2 });
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.summary).toContain('ceiling');
  });
});

// ─── The stepper ─────────────────────────────────────────────────────────────

describe('the binary search', () => {
  const allProbeable = [true, true, true, true, true, true, true];

  it('starts in the middle and converges on the boundary', () => {
    let state = { greenAt: -1, redAt: 7 };
    const visited: number[] = [];

    for (let i = 0; i < 10; i++) {
      const step = nextProbe(state, allProbeable);
      if (step.kind !== 'probe') break;
      visited.push(step.index);
      // Truth: everything from index 4 on is red.
      state = applyProbe(state, step.index, step.index >= 4 ? 'RED' : 'GREEN');
    }

    expect(nextProbe(state, allProbeable)).toEqual({ kind: 'converged' });
    expect(state.redAt).toBe(4);
    expect(state.greenAt).toBe(3);
    // Bounded by ceil(log2(8)) = 3.
    expect(visited.length).toBeLessThanOrEqual(probeBudget(7));
  });

  it('stops immediately when the range is already one step wide', () => {
    expect(nextProbe({ greenAt: 2, redAt: 3 }, allProbeable)).toEqual({ kind: 'converged' });
  });

  it('falls back to the nearest reachable commit when the midpoint is not', () => {
    const probeable = [true, false, false, false, true];
    const step = nextProbe({ greenAt: -1, redAt: 5 }, probeable);
    expect(step).toEqual({ kind: 'probe', index: 0 });
  });

  it('says it is out of reachable commits rather than picking one it cannot run', () => {
    const probeable = [false, false, false];
    expect(nextProbe({ greenAt: -1, redAt: 3 }, probeable)).toEqual({ kind: 'unprobeable' });
  });

  it('only ever narrows the range', () => {
    // A late GREEN older than one already known must not widen the search back
    // out — a search that can move backwards does not terminate.
    const state = applyProbe({ greenAt: 4, redAt: 6 }, 1, 'GREEN');
    expect(state).toEqual({ greenAt: 4, redAt: 6 });
    expect(applyProbe({ greenAt: 0, redAt: 2 }, 5, 'RED')).toEqual({ greenAt: 0, redAt: 2 });
  });
});

// ─── The report itself ───────────────────────────────────────────────────────

describe('the answer never reads as more certain than it is', () => {
  it('always states that QAAI does not know the commit graph', () => {
    for (const rows of [
      history('c1:pass c2:fail'),
      history('c1:fail c2:fail'),
      history('c1:pass c2:pass'),
    ]) {
      const caveats = analyzeHistory(rows).caveats;
      expect(caveats.length).toBeGreaterThan(0);
      expect(caveats[0]).toContain('not by git parentage');
    }
  });

  it('downgrades a boundary whose commits were run out of order', () => {
    const t0 = new Date(Date.UTC(2026, 0, 1, 0, 0));
    const rows = [
      row('c1', 'pass', { at: new Date(t0.getTime()) }),
      row('c1', 'pass', { at: new Date(t0.getTime() + 60_000) }),
      row('c2', 'pass', { at: new Date(t0.getTime() + 30_000) }),
      row('c2', 'pass', { at: new Date(t0.getTime() + 40_000) }),
      // c3's runs straddle c4's, so their relative order is inferred.
      row('c3', 'pass', { at: new Date(t0.getTime() + 120_000) }),
      row('c3', 'pass', { at: new Date(t0.getTime() + 400_000) }),
      row('c4', 'fail', { at: new Date(t0.getTime() + 300_000) }),
      row('c4', 'fail', { at: new Date(t0.getTime() + 500_000) }),
    ];
    const result = analyzeHistory(rows);

    expect(result.status).toBe('ANSWERED');
    expect(result.suspect?.commitSha).toBe('c4');
    expect(result.confidence).toBe('probable');
    expect(result.caveats.join(' ')).toContain('out of order');
  });

  it('does not let its own probes make the timeline look reordered', () => {
    // A probe IS a run of an old commit happening now. If that counted as CI
    // testing commits out of order, every bisect that actually probed would
    // caveat its own answer as untrustworthy — which is the answer the probes
    // were run to produce.
    const t0 = Date.UTC(2026, 0, 1);
    const rows = [
      row('c1', 'pass', { at: new Date(t0) }),
      row('c2', 'pass', { at: new Date(t0 + 60_000) }),
      row('c3', 'fail', { at: new Date(t0 + 120_000) }),
      // The probe, queued an hour after c3's run and stamped with c2's sha.
      row('c2', 'pass', { at: new Date(t0 + 3_600_000), triggeredBy: 'bisect:test-1:inv-1' }),
    ];
    const timeline = buildTimeline(rows, 'inv-1');

    expect(timeline.commits.map((c) => c.reordered)).toEqual([false, false, false]);
    expect(timeline.commits[1]!.probed).toBe(true);
    expect(analyzeHistory(rows, { bisectId: 'inv-1' }).caveats.join(' ')).not.toContain(
      'out of order',
    );
  });

  it('is confirmed only when both sides are clean and stability was measured', () => {
    const result = analyzeHistory([
      row('c1', 'pass'),
      row('c1', 'pass'),
      row('c2', 'pass'),
      row('c2', 'pass'),
      row('c3', 'fail'),
      row('c3', 'fail'),
    ]);

    expect(result.status).toBe('ANSWERED');
    expect(result.suspect?.commitSha).toBe('c3');
    expect(result.confidence).toBe('confirmed');
  });
});

describe('the measurement itself', () => {
  it('counts only commits that were run more than once', () => {
    const timeline = buildTimeline([
      row('c1', 'pass'),
      row('c2', 'pass'),
      row('c2', 'fail'),
      row('c3', 'fail'),
      row('c3', 'fail'),
    ]);
    const flake = measureFlake(timeline.commits);

    expect(flake.repeatedCommits).toBe(2);
    expect(flake.disagreeingCommits).toBe(1);
    expect(flake.ratePercent).toBe(50);
    expect(flake.measured).toBe(true);
  });

  it('reports zero as unmeasured when nothing was ever repeated', () => {
    const flake = measureFlake(buildTimeline(history('c1:pass c2:fail')).commits);
    expect(flake.ratePercent).toBe(0);
    expect(flake.measured).toBe(false);
  });
});

describe('the boundary walk', () => {
  it('finds nothing to explain when there are no verdicts at all', () => {
    const boundary = findBoundary(buildTimeline([row('c1', 'errored')]).commits);
    expect(boundary.head).toBeNull();
    expect(boundary.firstRed).toBeNull();
  });

  it('picks the oldest commit in the red streak, not the newest', () => {
    const boundary = findBoundary(
      buildTimeline(history('c1:pass c2:fail c3:fail c4:timeout')).commits,
    );
    expect(boundary.firstRed?.commitSha).toBe('c2');
    expect(boundary.head?.commitSha).toBe('c4');
  });
});
