/**
 * Tests for the scheduler tick's two newest responsibilities.
 *
 * ── THE FAIL-FAST SWEEP ─────────────────────────────────────────────────────
 *
 * THE DEFECT, VERBATIM: "Enforce fail-fast and the stop request in the worker —
 * the column, the migration, the endpoint and the user-facing promise all
 * exist; the consumer does not, so a stop request is ignored."
 *
 * The cases below are the ways a stop sweep is worse than no stop sweep:
 *
 *   • stopping a 5,000-test suite on a FLAKE — a failure that passed on retry.
 *     That is the single fastest way to make a team switch the feature off.
 *   • stopping on a QUARANTINED failure. Quarantine is a decision to suppress a
 *     failure; honouring it everywhere except in the one place where it ends
 *     the build early would make it the opposite of what it says.
 *   • writing `status = CANCELLED`, which files a broken build under a word
 *     that means "nobody wanted the answer".
 *   • racing a human who pressed stop, and leaving the run with two stories.
 *   • taking a customer's nightly suite down because one run could not be read.
 *
 * ── WHAT IS DELIBERATELY NOT TESTED HERE ────────────────────────────────────
 *
 * That the run actually STOPS. The between-tests poll in
 * apps/worker/src/processors/run.ts reads `status` and `finalizedAt` and not
 * `stopRequestedAt`, so the request written here is not yet obeyed. That file
 * belongs to another agent this round; the three-line change is in this
 * change's handover and nothing here claims the behaviour it would add.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  log: Array<{ level: string; msg: string; obj: Row }>;
  runsEnqueued: Row[];
  notified: Row[];
  campaignSweeps: Date[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  log: [],
  runsEnqueued: [],
  notified: [],
  campaignSweeps: [],
}));

vi.mock('../context.js', () => {
  const record =
    (level: string) =>
    (obj: Row, msg?: string): void => {
      h.log.push({ level, msg: msg ?? '', obj });
    };
  return {
    config: {},
    connection: {},
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  };
});

vi.mock('../queues.js', () => ({
  enqueueRun: async (job: Row) => {
    h.runsEnqueued.push(job);
  },
  enqueueNotify: async (job: Row) => {
    h.notified.push(job);
  },
  enqueueExplore: async () => {},
  enqueueGenerate: async () => {},
}));

/*
 * The closure sweep is proven in close-loop.test.ts; here it only has to be
 * CALLED, and with the tick's own clock. Stubbing it also keeps this suite's
 * fail-fast assertions from depending on the campaign machinery's fakes.
 */
vi.mock('./close-loop.js', () => ({
  advanceClosureCampaigns: async (now: Date) => {
    h.campaignSweeps.push(now);
    return { armed: 0, advanced: 0, failed: 0, moreDue: false };
  },
}));

const {
  FAIL_FAST_FAILURE_SCAN_LIMIT,
  FAIL_FAST_SWEEP_LIMIT,
  failFastStopReason,
  failFastTripped,
  processScheduleTick,
} = await import('./schedule.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW_MS = new Date('2026-10-24T03:00:00.000Z').getTime();

interface Store {
  runs: Row[];
  results: Row[];
}

let store: Store;

/** One result row, in the exact shape `failFastTripped` is entitled to read. */
interface ResultRow {
  runId: string;
  status: string;
  retriedAndPassed: boolean;
  createdAt: Date;
  test: { name: string; quarantined: boolean; quarantineExpiresAt: Date | null };
}

function result(over: Partial<ResultRow> = {}): ResultRow {
  return {
    runId: 'run_1',
    status: 'FAILED',
    retriedAndPassed: false,
    createdAt: new Date(NOW_MS),
    test: { name: 'checkout', quarantined: false, quarantineExpiresAt: null },
    ...over,
  };
}

function makeDb(): Record<string, unknown> {
  return {
    // The parts of the tick this suite is not about. Empty is a valid state:
    // an install with no schedules and no monitors still sweeps.
    schedule: { findMany: async () => [], update: async () => ({}) },
    monitor: { findMany: async () => [], update: async () => ({}) },
    test: { findMany: async () => [] },
    testResult: {
      /*
       * `take` is HONOURED, and it has to be: the sweep now asks for one row
       * past its scan limit and decides whether it was truncated from the
       * length of what came back. A fake that ignored `take` would hand it
       * every row and report "not truncated" for a store that is, which would
       * make the disclosure test pass against a sweep that had no disclosure
       * in it.
       */
      findMany: async ({ where = {}, take }: Row = {}) => {
        const found = store.results
          .filter((row) => {
            if (where.runId && row.runId !== where.runId) return false;
            if (where.status?.in && !where.status.in.includes(row.status)) return false;
            if (where.durationMs?.gt !== undefined) return false;
            return true;
          })
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((row) => ({ ...row }));
        return found.slice(0, take ?? found.length);
      },
    },
    run: {
      findMany: async ({ where = {}, take }: Row = {}) => {
        const found = store.runs.filter((run) => {
          if (where.failFast !== undefined && run.failFast !== where.failFast) return false;
          if (where.stopRequestedAt === null && run.stopRequestedAt != null) return false;
          if (where.status?.in && !where.status.in.includes(run.status)) return false;
          return true;
        });
        return found.slice(0, take ?? found.length).map((row) => ({ ...row }));
      },
      updateMany: async ({ where = {}, data }: Row = {}) => {
        const found = store.runs.filter((run) => {
          if (where.id && run.id !== where.id) return false;
          // The conditional claim. Modelled, because it is the entire
          // first-writer-wins guarantee.
          if (where.stopRequestedAt === null && run.stopRequestedAt != null) return false;
          if (where.status?.in && !where.status.in.includes(run.status)) return false;
          return true;
        });
        for (const run of found) Object.assign(run, data);
        return { count: found.length };
      },
    },
  };
}

/*
 * The clock is frozen, because `processScheduleTick` reads `new Date()` itself
 * and the quarantine rule compares an expiry against it. Without this, a
 * fixture expiring at "NOW_MS + 1000" is in the PAST on any real day after the
 * one NOW_MS names, and the suppressed-failure test would pass in 2026 and
 * start failing in 2027 — a test that rots into the opposite of its own claim.
 */
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  h.log = [];
  h.runsEnqueued = [];
  h.notified = [];
  h.campaignSweeps = [];
  store = { runs: [], results: [] };
  h.prisma = makeDb();
});

afterEach(() => {
  vi.useRealTimers();
});

const failFastRun = (over: Row = {}): Row => ({
  id: 'run_1',
  orgId: 'org_1',
  failFast: true,
  status: 'RUNNING',
  stopRequestedAt: null,
  stopReason: null,
  ...over,
});

// ─── The rule ────────────────────────────────────────────────────────────────

describe('failFastTripped', () => {
  it('trips on a plain failure and on a timeout', () => {
    expect(failFastTripped(result(), new Date(NOW_MS))).toBe(true);
    expect(failFastTripped(result({ status: 'TIMED_OUT' }), new Date(NOW_MS))).toBe(true);
  });

  it('does not trip on a pass, a skip or a flaky result', () => {
    for (const status of ['PASSED', 'SKIPPED', 'FLAKY']) {
      expect(failFastTripped(result({ status }), new Date(NOW_MS))).toBe(false);
    }
  });

  it('does not trip on a retry that passed', () => {
    // A flake is not a broken build, and halting a 5,000-test suite on one is
    // how this feature gets switched off for good.
    expect(failFastTripped(result({ retriedAndPassed: true }), new Date(NOW_MS))).toBe(false);
  });

  it('does not trip on a failure a quarantine in force suppresses', () => {
    const quarantined = result({
      test: {
        name: 'flaky-checkout',
        quarantined: true,
        quarantineExpiresAt: new Date(NOW_MS + 86_400_000),
      },
    });
    expect(failFastTripped(quarantined, new Date(NOW_MS))).toBe(false);
  });

  it('DOES trip on a failure whose quarantine has expired', () => {
    /*
     * An expired quarantine GATES AGAIN — `quarantineSuppresses` is the one
     * definition of that and this sweep asks it rather than reading
     * `Test.quarantined`. Reading the flag directly is how a suite with forty
     * expired quarantines reports a clean green board.
     */
    const expired = result({
      test: {
        name: 'checkout',
        quarantined: true,
        quarantineExpiresAt: new Date(NOW_MS - 1000),
      },
    });
    expect(failFastTripped(expired, new Date(NOW_MS))).toBe(true);
  });
});

describe('failFastStopReason', () => {
  it('names the test, because three surfaces render this string verbatim', () => {
    expect(failFastStopReason('checkout')).toContain('"checkout"');
    expect(failFastStopReason(null)).toContain('a test failed');
  });
});

// ─── The sweep ───────────────────────────────────────────────────────────────

describe('the fail-fast sweep', () => {
  it('writes the stop request, with the failing test named', async () => {
    store.runs.push(failFastRun());
    store.results.push(result());

    await processScheduleTick({ at: new Date(NOW_MS).toISOString() });

    expect(store.runs[0]!.stopRequestedAt).toBeInstanceOf(Date);
    expect(store.runs[0]!.stopReason).toContain('"checkout"');
    /*
     * `status` is UNTOUCHED, and this is the assertion that keeps the feature
     * honest. A fail-fast stop is a FAILED run that chose not to finish; filing
     * it as CANCELLED would hide a broken build behind a word that means
     * "nobody wanted the answer".
     */
    expect(store.runs[0]!.status).toBe('RUNNING');
    expect(h.log.some((entry) => entry.msg === 'fail-fast tripped: stop requested')).toBe(true);
  });

  it('ignores a run that did not ask for fail-fast', async () => {
    store.runs.push(failFastRun({ failFast: false }));
    store.results.push(result());

    await processScheduleTick({ at: '' });
    expect(store.runs[0]!.stopRequestedAt).toBeNull();
  });

  it('ignores a run that has already finished', async () => {
    store.runs.push(failFastRun({ status: 'FAILED' }));
    store.results.push(result());

    await processScheduleTick({ at: '' });
    expect(store.runs[0]!.stopRequestedAt).toBeNull();
  });

  it('never overwrites a stop a human already requested', async () => {
    const requestedAt = new Date(NOW_MS - 60_000);
    store.runs.push(
      failFastRun({ stopRequestedAt: requestedAt, stopReason: 'Stopped by a reviewer: enough.' }),
    );
    store.results.push(result());

    await processScheduleTick({ at: '' });

    // One run, one story. The first writer's reason is the one on the row.
    expect(store.runs[0]!.stopRequestedAt).toBe(requestedAt);
    expect(store.runs[0]!.stopReason).toContain('Stopped by a reviewer');
  });

  it('loses the race to a human who pressed stop between the read and the write', async () => {
    /*
     * MUTATION-FOUND GAP. The previous test ("never overwrites a stop a human
     * already requested") passes even against an UNCONDITIONAL update, because
     * the sweep's own `findMany` filter already excludes a run that has been
     * stopped. The race that the conditional UPDATE actually protects against
     * is narrower and real: the run is unstopped when the sweep reads it, and a
     * reviewer presses stop in the milliseconds while the results are being
     * read. Without the condition, this sweep then overwrites their reason and
     * the run ends up with two stories — the exact thing POST
     * /team/runs/:runId/stop writes its own conditional UPDATE to prevent.
     */
    const humanAt = new Date(NOW_MS + 500);
    store.runs.push(failFastRun());
    store.results.push(result());

    const db = makeDb();
    h.prisma = {
      ...db,
      testResult: {
        findMany: async (args: Row) => {
          // The human gets there while we are reading the results.
          store.runs[0]!.stopRequestedAt = humanAt;
          store.runs[0]!.stopReason = 'Stopped by a reviewer: I have seen enough.';
          return (db.testResult as Row).findMany(args);
        },
      },
    };

    await processScheduleTick({ at: '' });

    expect(store.runs[0]!.stopRequestedAt).toBe(humanAt);
    expect(store.runs[0]!.stopReason).toContain('Stopped by a reviewer');
    // And the sweep did not announce a stop it did not write.
    expect(h.log.some((entry) => entry.msg === 'fail-fast tripped: stop requested')).toBe(false);
  });

  it('leaves a fail-fast run with no real failure alone', async () => {
    store.runs.push(failFastRun());
    store.results.push(result({ status: 'PASSED' }));
    store.results.push(result({ retriedAndPassed: true }));
    store.results.push(
      result({
        test: {
          name: 'known-flake',
          quarantined: true,
          quarantineExpiresAt: new Date(NOW_MS + 1000),
        },
      }),
    );

    await processScheduleTick({ at: '' });
    expect(store.runs[0]!.stopRequestedAt).toBeNull();
  });

  it('names the FIRST real failure, in execution order', async () => {
    store.runs.push(failFastRun());
    store.results.push(
      result({
        createdAt: new Date(NOW_MS + 2000),
        test: { name: 'later', quarantined: false, quarantineExpiresAt: null },
      }),
    );
    store.results.push(
      result({
        createdAt: new Date(NOW_MS),
        test: { name: 'earlier', quarantined: false, quarantineExpiresAt: null },
      }),
    );

    await processScheduleTick({ at: '' });
    expect(store.runs[0]!.stopReason).toContain('"earlier"');
  });

  it('is bounded, so one tick cannot starve the nightlies behind it', async () => {
    let asked = 0;
    const db = makeDb();
    h.prisma = {
      ...db,
      run: {
        ...(db.run as Row),
        findMany: async ({ take }: Row = {}) => {
          asked = take;
          return [];
        },
      },
    };

    await processScheduleTick({ at: '' });
    expect(asked).toBe(FAIL_FAST_SWEEP_LIMIT);
  });

  /*
   * THE CAP ON THE FAILURES READ, AND ITS DISCLOSURE.
   *
   * It was `take: 25`, hard-coded and silent, and the hole is specific: a
   * fail-fast run whose oldest 25 failures are all quarantined or
   * retried-into-passes is never asked to stop, and since the sweep re-reads
   * the same oldest 25 every sixty seconds it never will be, however many real
   * failures sit past them. The run finishes in full while its owner has been
   * told it would stop early — a failure suppressed without being counted.
   */
  it('reads one row past its scan limit, so it can tell "none" from "none that I read"', async () => {
    store.runs.push(failFastRun());
    let asked = 0;
    const db = makeDb();
    h.prisma = {
      ...db,
      testResult: {
        findMany: async (args: Row) => {
          asked = args.take;
          return (db.testResult as Row).findMany(args);
        },
      },
    };

    await processScheduleTick({ at: '' });
    expect(asked).toBe(FAIL_FAST_FAILURE_SCAN_LIMIT + 1);
  });

  it('counts and reports a run it could not decide, instead of leaving it alone quietly', async () => {
    store.runs.push(failFastRun());
    /*
     * One more suppressed failure than the sweep will read. Every one of them
     * is quarantined, so nothing trips — and there is a row past the limit, so
     * "nothing tripped" is not a finding about the run, it is a statement about
     * how far the sweep looked.
     */
    for (let i = 0; i <= FAIL_FAST_FAILURE_SCAN_LIMIT; i += 1) {
      store.results.push(
        result({
          createdAt: new Date(NOW_MS - 100_000 + i),
          test: {
            name: `suppressed_${i}`,
            quarantined: true,
            quarantineExpiresAt: new Date(NOW_MS + 60_000),
          },
        }),
      );
    }

    await processScheduleTick({ at: '' });

    // Not stopped — correctly, since no failure it read counts.
    expect(store.runs[0]!.stopRequestedAt).toBeNull();

    // But SAID so, with both numbers, and counted on the tick's own line.
    const undecided = h.log.find((entry) => entry.msg.includes('fail-fast undecided'));
    expect(undecided).toBeDefined();
    expect(undecided!.level).toBe('warn');
    expect(undecided!.obj).toMatchObject({
      runId: 'run_1',
      limit: FAIL_FAST_FAILURE_SCAN_LIMIT,
    });
    const tick = h.log.find((entry) => entry.msg.startsWith('schedule tick:'));
    expect(tick?.obj).toMatchObject({ stopsRequested: 0, stopsUndecided: 1 });
  });

  it('stays silent about a run whose failures it read to the end', async () => {
    // The other half, and the one that stops the disclosure becoming noise: a
    // run with a handful of suppressed failures and nothing past them is a run
    // the sweep genuinely decided. Nothing undecided, no warning.
    store.runs.push(failFastRun());
    store.results.push(
      result({
        test: {
          name: 'suppressed',
          quarantined: true,
          quarantineExpiresAt: new Date(NOW_MS + 60_000),
        },
      }),
    );

    await processScheduleTick({ at: '' });

    expect(store.runs[0]!.stopRequestedAt).toBeNull();
    expect(h.log.some((entry) => entry.msg.includes('fail-fast undecided'))).toBe(false);
  });

  /*
   * ── THE BOUNDARY, WHICH IS WHERE A DISCLOSURE TURNS INTO A FALSE ONE ──────
   *
   * The two tests above sit at 201 rows and at 1. Neither touches EXACTLY
   * FAIL_FAST_FAILURE_SCAN_LIMIT, and that is the one count where `truncated`
   * can be wrong in the direction nothing else here checks: `page.length >=
   * LIMIT` instead of `> LIMIT` survives both of them, and it reports a run
   * whose failures were read to the very last one as "more exist past the scan
   * limit".
   *
   * That is the mirror of the defect this limit was introduced to fix, and it
   * is the worse half to leave untested. An undisclosed cap hides a real
   * failure; a cap disclosed that was NOT hit manufactures an `undecided`
   * count and a WARN naming a run the sweep decided correctly — so the one
   * number built to mean "I did not look far enough" starts firing on runs
   * where it looked far enough, and an operator learns to ignore it. A
   * disclosure nobody believes protects nothing.
   *
   * 200 suppressed failures and nothing past them: the sweep read the run to
   * the end, decided it, and must say nothing.
   */
  it('says nothing about a run with exactly as many failures as it agreed to read', async () => {
    store.runs.push(failFastRun());
    for (let i = 0; i < FAIL_FAST_FAILURE_SCAN_LIMIT; i += 1) {
      store.results.push(
        result({
          createdAt: new Date(NOW_MS - 100_000 + i),
          test: {
            name: `suppressed_${i}`,
            quarantined: true,
            quarantineExpiresAt: new Date(NOW_MS + 60_000),
          },
        }),
      );
    }

    await processScheduleTick({ at: '' });

    // Not stopped, and correctly so: every failure in the run is suppressed.
    expect(store.runs[0]!.stopRequestedAt).toBeNull();
    // Not UNDECIDED either, because there was nothing it did not read.
    expect(h.log.some((entry) => entry.msg.includes('fail-fast undecided'))).toBe(false);
    /*
     * And the tick's summary line does not fire at all, which is the same rule
     * one level up: nothing was requested, nothing was undecided and no
     * campaign moved, so there is nothing to report. A tick that logged
     * `stopsUndecided: 0` every sixty seconds of an idle install is how the
     * non-zero case stops being visible.
     */
    expect(h.log.some((entry) => entry.msg.startsWith('schedule tick:'))).toBe(false);
  });

  it('does not take the tick down when one run cannot be read', async () => {
    store.runs.push(failFastRun({ id: 'run_bad' }), failFastRun({ id: 'run_good' }));
    store.results.push(result({ runId: 'run_good' }));

    const db = makeDb();
    h.prisma = {
      ...db,
      testResult: {
        findMany: async (args: Row) => {
          if (args.where?.runId === 'run_bad') throw new Error('this row is corrupt');
          return (db.testResult as Row).findMany(args);
        },
      },
    };

    await processScheduleTick({ at: '' });

    // Per-run, so one unreadable run does not cost the other 199 theirs.
    expect(store.runs.find((r) => r.id === 'run_good')!.stopRequestedAt).toBeInstanceOf(Date);
    expect(h.log.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('does not take the tick down when the whole query fails', async () => {
    const db = makeDb();
    h.prisma = {
      ...db,
      run: {
        findMany: async () => {
          throw new Error('no connection');
        },
      },
    };

    // A scheduler tick that throws lands in BullMQ's failed set, and the
    // customer's nightly silently stops firing.
    await expect(processScheduleTick({ at: '' })).resolves.toBeUndefined();
    expect(h.log.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('the closure campaign sweep rides this tick', () => {
  it('is called with the tick’s own clock', async () => {
    await processScheduleTick({ at: '' });
    expect(h.campaignSweeps).toHaveLength(1);
    expect(h.campaignSweeps[0]).toBeInstanceOf(Date);
  });

  it('runs after the schedules and the monitors, not before them', async () => {
    const order: string[] = [];
    const db = makeDb();
    h.prisma = {
      ...db,
      schedule: {
        findMany: async () => {
          order.push('schedules');
          return [];
        },
        update: async () => ({}),
      },
      monitor: {
        findMany: async () => {
          order.push('monitors');
          return [];
        },
        update: async () => ({}),
      },
      run: {
        ...(db.run as Row),
        findMany: async () => {
          order.push('fail-fast');
          return [];
        },
      },
    };

    await processScheduleTick({ at: '' });

    /*
     * A nightly suite that fired four seconds late because a closure campaign
     * was measuring is a worse trade than a campaign that measures four seconds
     * later. Both sweeps are work nobody is waiting on.
     */
    expect(order).toEqual(['schedules', 'monitors', 'fail-fast']);
    expect(h.campaignSweeps).toHaveLength(1);
  });
});
