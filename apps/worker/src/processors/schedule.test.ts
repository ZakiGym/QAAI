/**
 * Tests for the scheduler tick's three newest responsibilities.
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
 *
 * ── RE-ENUMERATION ──────────────────────────────────────────────────────────
 *
 * THE DEFECT: the only crawl trigger in this product is a human clicking a
 * button, so the DENOMINATOR goes stale on its own and the coverage percentage
 * rises with nobody told. The cases below are the ways a re-enumeration trigger
 * is worse than none:
 *
 *   • firing the instant somebody creates it, because the cron was anchored at
 *     the epoch rather than at `createdAt`
 *   • firing a second browser at a project that is already being crawled, which
 *     BullMQ silently deduplicates — leaving a trigger RUNNING against a job
 *     that does not exist
 *   • a crawl that never landed recorded as a crawl that found nothing. Those
 *     are opposite facts and only one of them is the customer's problem
 *   • `newSurfaceWithoutTests: 0` written when testedness was never read. Zero
 *     is the value a dashboard paints green
 *   • `comparedAt` stamped on a comparison that did not run, which is how "no
 *     drift since the last crawl" gets claimed by a code path that never looked
 *   • a cap deferring fourteen due triggers and reporting nothing
 *   • a raw error string on `lastFailureMessage`, which is a customer-visible
 *     column and a crawl error can carry the URL it was reaching
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: that a human is NOTIFIED. The drift
 * event is written as an `AuditLog` row, which the API's audit reader renders;
 * `processNotify` has no 'surface.drifted' case, so the chat and webhook
 * fan-out does not happen and nothing below asserts that it does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * TYPE-ONLY, so it is erased before `vi.mock` hoisting matters, and worth having
 * rather than another `Row`: `reEnumerationIsDue` is a pure rule with seven
 * inputs, and a fixture typed as `Record<string, any>` would let a renamed field
 * sail through every dueness test below as `undefined`.
 */
import type { TriggerRow } from './schedule.js';

type Row = Record<string, any>;

/** A trigger row plus the columns the sweep writes but the rule does not read. */
interface TriggerFixture extends TriggerRow {
  lastFlowMapId: string | null;
  lastFailureMessage: string | null;
  consecutiveFailures: number;
}

interface Hoisted {
  prisma: Record<string, unknown>;
  log: Array<{ level: string; msg: string; obj: Row }>;
  runsEnqueued: Row[];
  exploresEnqueued: Row[];
  /** Set by the one test that proves a failed enqueue releases the claim. */
  exploreThrows: boolean;
  notified: Row[];
  campaignSweeps: Date[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  log: [],
  runsEnqueued: [],
  exploresEnqueued: [],
  exploreThrows: false,
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
  /*
   * CAPTURED, and the payload is asserted on. `maxPages: 0` is not a
   * placeholder — the explore processor reads a non-positive budget as "no
   * caller override, let Environment.crawlPolicy decide" — so a test that did
   * not look at the job would pass against a re-enumeration hard-coded to 60
   * pages, which is the bug that made "100% covered" mean "100% of at most 25
   * states".
   */
  enqueueExplore: async (job: Row) => {
    if (h.exploreThrows) throw new Error('redis is down');
    h.exploresEnqueued.push(job);
  },
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
  RE_ENUMERATION_AUDIT_ACTIONS,
  RE_ENUMERATION_RUN_TIMEOUT_MS,
  RE_ENUMERATION_SETTLE_LIMIT,
  RE_ENUMERATION_SWEEP_LIMIT,
  RE_ENUMERATION_TESTED_ROUTE_LIMIT,
  failFastStopReason,
  failFastTripped,
  fireReEnumeration,
  processScheduleTick,
  reEnumerationIsDue,
} = await import('./schedule.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW_MS = new Date('2026-10-24T03:00:00.000Z').getTime();

interface Store {
  runs: Row[];
  results: Row[];
  triggers: Row[];
  flowMaps: Row[];
  drifts: Row[];
  coverageItems: Row[];
  audits: Row[];
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

/**
 * The `where` clauses the re-enumeration sweep actually sends, and no others.
 *
 * `lastRunState: { not: 'RUNNING' }` and the `lastRunAt` equality are modelled
 * because together they ARE the first-writer-wins claim: a fake that ignored
 * either would let two ticks fire two crawls at one application and this
 * file's race test would pass against a sweep that has no claim in it.
 */
function matchesTrigger(row: Row, where: Row): boolean {
  if (where.id && row.id !== where.id) return false;
  if (where.projectId && row.projectId !== where.projectId) return false;
  if (where.enabled !== undefined && row.enabled !== where.enabled) return false;
  if (where.kind && row.kind !== where.kind) return false;
  if (typeof where.lastRunState === 'string' && row.lastRunState !== where.lastRunState) {
    return false;
  }
  if (where.lastRunState?.not && row.lastRunState === where.lastRunState.not) return false;
  if (where.lastRunAt !== undefined) {
    const want = where.lastRunAt === null ? null : (where.lastRunAt as Date).getTime();
    const have =
      row.lastRunAt === null || row.lastRunAt === undefined
        ? null
        : (row.lastRunAt as Date).getTime();
    if (want !== have) return false;
  }
  return true;
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
    /*
     * ── The re-enumeration tables ─────────────────────────────────────────
     *
     * `take` is HONOURED everywhere below, for the same reason the testResult
     * fake honours it: the sweep asks for ONE ROW PAST each of its limits and
     * decides whether the cap bit from the length of what came back. A fake
     * that returned everything would report "no cap bit" for a store that
     * trips three of them, and every disclosure assertion in this file would
     * pass against a sweep with no disclosure in it.
     */
    reEnumerationTrigger: {
      findMany: async ({ where = {}, take, orderBy }: Row = {}) => {
        const found = store.triggers.filter((row) => matchesTrigger(row, where));
        const key = orderBy?.lastRunAt ? 'lastRunAt' : 'createdAt';
        found.sort((a, b) => (a[key]?.getTime() ?? 0) - (b[key]?.getTime() ?? 0));
        return found.slice(0, take ?? found.length).map((row) => ({ ...row }));
      },
      findFirst: async ({ where = {} }: Row = {}) => {
        const found = store.triggers.find((row) => matchesTrigger(row, where));
        return found ? { ...found } : null;
      },
      updateMany: async ({ where = {}, data }: Row = {}) => {
        const found = store.triggers.filter((row) => matchesTrigger(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      },
      update: async ({ where = {}, data }: Row = {}) => {
        const row = store.triggers.find((t) => t.id === where.id);
        if (!row) throw new Error(`no trigger ${String(where.id)}`);
        for (const [field, value] of Object.entries(data as Row)) {
          // `{ increment: n }` is modelled rather than stubbed: the whole point
          // of consecutiveFailures is that it is a tally, and a fake that
          // overwrote it with an object would make "broken for six days"
          // unassertable.
          if (value && typeof value === 'object' && 'increment' in value) {
            row[field] = (row[field] ?? 0) + (value as Row).increment;
          } else {
            row[field] = value;
          }
        }
        return { ...row };
      },
    },
    flowMap: {
      findFirst: async ({ where = {} }: Row = {}) => {
        const found = store.flowMaps
          .filter((row) => {
            if (where.environmentId && row.environmentId !== where.environmentId) return false;
            if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
            if (where.version?.lt !== undefined && !(row.version < where.version.lt)) return false;
            return true;
          })
          .sort((a, b) => b.version - a.version);
        return found[0] ? { ...found[0] } : null;
      },
    },
    surfaceDriftRecord: {
      findFirst: async ({ where = {} }: Row = {}) => {
        const found = store.drifts.find(
          (row) =>
            (!where.currentFlowMapId || row.currentFlowMapId === where.currentFlowMapId) &&
            (where.triggerId === undefined || row.triggerId === where.triggerId),
        );
        return found ? { ...found } : null;
      },
      create: async ({ data }: Row = {}) => {
        const row = { id: `drift_${store.drifts.length + 1}`, ...data };
        store.drifts.push(row);
        return { ...row };
      },
    },
    coverageItem: {
      findMany: async ({ where = {}, take }: Row = {}) => {
        const found = store.coverageItems.filter((row) => {
          if (where.projectId && row.projectId !== where.projectId) return false;
          if (where.kind && row.kind !== where.kind) return false;
          return true;
        });
        return found.slice(0, take ?? found.length).map((row) => ({ ...row }));
      },
    },
    auditLog: {
      create: async ({ data }: Row = {}) => {
        store.audits.push({ ...data });
        return { ...data };
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
  h.exploresEnqueued = [];
  h.exploreThrows = false;
  h.notified = [];
  h.campaignSweeps = [];
  store = {
    runs: [],
    results: [],
    triggers: [],
    flowMaps: [],
    drifts: [],
    coverageItems: [],
    audits: [],
  };
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

// ─── Re-enumeration ──────────────────────────────────────────────────────────

const CREATED_MS = new Date('2026-10-20T12:00:00.000Z').getTime();

const trigger = (over: Partial<TriggerFixture> = {}): TriggerFixture => ({
  id: 'trg_1',
  orgId: 'org_1',
  projectId: 'proj_1',
  environmentId: 'env_prod',
  name: 'nightly re-enumeration',
  kind: 'SCHEDULE',
  enabled: true,
  // Every night at 02:00, which is in the past relative to NOW_MS (03:00) and
  // in the future relative to CREATED_MS, so the anchor is observable.
  cron: '0 2 * * *',
  timezone: 'UTC',
  lastRunState: 'NEVER_RUN',
  lastRunAt: null,
  lastFlowMapId: null,
  lastFailureMessage: null,
  consecutiveFailures: 0,
  createdAt: new Date(CREATED_MS),
  ...over,
});

/** A stored FlowMap row, graph and all. */
const flowMapRow = (over: Row = {}): Row => ({
  id: 'fm_2',
  environmentId: 'env_prod',
  version: 2,
  acceptance: 'ACCEPTED',
  createdAt: new Date(NOW_MS),
  graph: {
    projectId: 'proj_1',
    environmentId: 'env_prod',
    version: 2,
    baseUrl: 'https://app.example.com',
    nodes: [],
    edges: [],
    journeys: [],
    features: [],
    exploredAt: new Date(NOW_MS).toISOString(),
    truncatedReason: null,
  },
  ...over,
});

const routeNode = (route: string): Row => ({
  id: route,
  route,
  url: `https://app.example.com${route}`,
  title: route,
  stateKey: 'default',
  requiresRoles: [],
  behindAuth: false,
  forms: [],
  affordances: [],
  screenshotKey: null,
  a11yViolationCount: 0,
});

/** Two accepted maps of one environment, the newer one with an extra route. */
function twoCrawls(extraRoutes: string[]): void {
  store.flowMaps.push(
    flowMapRow({
      id: 'fm_1',
      version: 1,
      createdAt: new Date(CREATED_MS),
      graph: { ...(flowMapRow().graph as Row), version: 1, nodes: [routeNode('/')] },
    }),
    flowMapRow({
      id: 'fm_2',
      version: 2,
      createdAt: new Date(NOW_MS),
      graph: {
        ...(flowMapRow().graph as Row),
        version: 2,
        nodes: [routeNode('/'), ...extraRoutes.map(routeNode)],
      },
    }),
  );
}

/** One ROUTE coverage item, so testedness is READABLE rather than unmeasured. */
const routeItem = (route: string, status: string): Row => ({
  projectId: 'proj_1',
  kind: 'ROUTE',
  key: `ROUTE:${route}`,
  status,
});

describe('reEnumerationIsDue', () => {
  it('anchors a never-run trigger on createdAt, so creating one does not crawl at once', () => {
    /*
     * `new Date(0)` was the obvious anchor and is the bug: every cron's next
     * fire after 1970 is in the deep past, so a browser would start at the
     * customer's application while somebody was still typing the form. The
     * trigger below was created at noon and is next due at 02:00, which has
     * already passed by NOW_MS — so it IS due; the test that matters is the one
     * below it, where it is not.
     */
    expect(reEnumerationIsDue(trigger(), new Date(NOW_MS)).due).toBe(true);

    const justCreated = trigger({ createdAt: new Date(NOW_MS - 1000) });
    const verdict = reEnumerationIsDue(justCreated, new Date(NOW_MS));
    expect(verdict.due).toBe(false);
    expect(verdict.why).toContain('next due');
  });

  it('is not due while a crawl is in flight', () => {
    // A minutely cron would otherwise fire sixty crawls an hour at an
    // application that is answering one.
    const verdict = reEnumerationIsDue(
      trigger({ cron: '* * * * *', lastRunState: 'RUNNING', lastRunAt: new Date(NOW_MS - 60_000) }),
      new Date(NOW_MS),
    );
    expect(verdict.due).toBe(false);
    expect(verdict.why).toContain('already in flight');
  });

  it('is not due when disabled, and says so rather than silently returning false', () => {
    expect(reEnumerationIsDue(trigger({ enabled: false }), new Date(NOW_MS))).toEqual({
      due: false,
      why: 'the trigger is disabled',
    });
  });

  it.each(['CI', 'DEPLOY', 'MANUAL'] as const)(
    'does not poll a %s trigger — it is fired by its caller',
    (kind) => {
      const verdict = reEnumerationIsDue(trigger({ kind }), new Date(NOW_MS));
      expect(verdict.due).toBe(false);
      expect(verdict.why).toContain('fired by its caller');
    },
  );

  it('is not due on an unparseable cron, and does not throw', () => {
    const verdict = reEnumerationIsDue(trigger({ cron: 'every other tuesday' }), new Date(NOW_MS));
    expect(verdict.due).toBe(false);
    expect(verdict.why).toContain('unparseable');
  });

  it('is not due when a SCHEDULE trigger has no cron at all', () => {
    expect(reEnumerationIsDue(trigger({ cron: null }), new Date(NOW_MS)).due).toBe(false);
  });
});

describe('firing a re-enumeration', () => {
  it('claims the trigger RUNNING and asks for a crawl at the environment’s own width', async () => {
    store.triggers.push(trigger());

    await processScheduleTick({ at: '' });

    expect(store.triggers[0]!.lastRunState).toBe('RUNNING');
    expect(store.triggers[0]!.lastRunAt).toEqual(new Date(NOW_MS));
    expect(h.exploresEnqueued).toHaveLength(1);
    const job = h.exploresEnqueued[0]!;
    expect(job.projectId).toBe('proj_1');
    expect(job.environmentId).toBe('env_prod');
    expect(job.requestedBy).toBe('re-enumeration:trg_1');
    /*
     * ZERO, and it is load-bearing. The explore processor reads a non-positive
     * budget as "no caller override — Environment.crawlPolicy decides". A
     * hard-coded 60 here would re-enumerate a 412-route application as 60
     * routes every night and call the difference drift.
     */
    expect(job.maxPages).toBe(0);
    expect(job.maxDepth).toBe(0);
    // An unattended crawl that also generated and approved tests is an
    // autopilot nobody asked for.
    expect(job.autoApprove).toBe(false);
  });

  it('claims first-writer-wins, so a tick and a deploy webhook cannot double-fire', async () => {
    /*
     * `fireReEnumeration` is the ONE implementation of the claim precisely
     * because four kinds of caller can reach it — this tick, a CI step, a
     * deploy webhook, a person clicking — and two of them will eventually read
     * the same row in the same second. The `updateMany` is conditional on the
     * `lastRunAt` that was read, so the loser matches no rows.
     *
     * Without the condition both callers fire, two browsers hit the customer's
     * application, and two drift records get written for one change.
     */
    const row = trigger();
    store.triggers.push(row);
    // Both callers hold the row AS THEY READ IT, which is the race.
    const asRead = { ...row };

    const first = await fireReEnumeration({ trigger: asRead, now: new Date(NOW_MS) });
    const second = await fireReEnumeration({ trigger: asRead, now: new Date(NOW_MS) });

    expect(first).toEqual({ fired: true });
    expect(second.fired).toBe(false);
    expect('why' in second && second.why).toContain('claimed this trigger first');
    expect(h.exploresEnqueued).toHaveLength(1);
    expect(store.triggers[0]!.lastRunState).toBe('RUNNING');
  });

  it('fires ONE crawl per project and discloses the deferral with a reason', async () => {
    /*
     * `enqueueExplore` pins the BullMQ job id to the project, so a second crawl
     * of the same project is silently deduplicated — and the second trigger
     * would sit RUNNING against a job that does not exist until it timed out
     * and reported a crawl failure that never happened.
     */
    store.triggers.push(
      trigger({ id: 'trg_a', environmentId: 'env_a' }),
      trigger({ id: 'trg_b', environmentId: 'env_b', createdAt: new Date(CREATED_MS + 1000) }),
    );

    await processScheduleTick({ at: '' });

    expect(h.exploresEnqueued).toHaveLength(1);
    const states = store.triggers.map((t) => t.lastRunState).sort();
    expect(states).toEqual(['NEVER_RUN', 'RUNNING']);
    // The deferred one stays NEVER_RUN — which is not "no drift" — and the tick
    // SAYS a cap bit, with the count beside it.
    const line = h.log.find((entry) => entry.obj.reEnumerationDeferred !== undefined);
    expect(line?.obj.reEnumerationDeferred).toBe(1);
    expect(String(line?.obj.reEnumerationCaps)).toContain('already in flight');
  });

  it('discloses the sweep limit as a count, not as silence', async () => {
    /*
     * The triggers are deliberately NOT DUE — created a second ago, next due at
     * 02:00 tomorrow. The limit is applied to the QUERY, before dueness is
     * considered, so this isolates the one cap under test: a tick that fired
     * nothing because it never looked is a completely different fact from a
     * tick that fired nothing because nothing was due.
     */
    for (let i = 0; i <= RE_ENUMERATION_SWEEP_LIMIT; i += 1) {
      store.triggers.push(
        trigger({
          id: `trg_${i}`,
          projectId: `proj_${i}`,
          createdAt: new Date(NOW_MS - 1000 + i),
        }),
      );
    }

    await processScheduleTick({ at: '' });

    expect(h.exploresEnqueued).toHaveLength(0);
    const line = h.log.find((entry) => entry.obj.reEnumerationCaps !== undefined);
    expect(line?.obj.reEnumerationDeferred).toBe(1);
    expect(String(line?.obj.reEnumerationCaps)).toContain(
      `sweep limit of ${RE_ENUMERATION_SWEEP_LIMIT}`,
    );
    expect(String(line?.obj.reEnumerationCaps)).toContain('at least 1 more');
  });

  it('discloses the settle limit too, so an install with a backlog can see it', async () => {
    // Both caps can bite in one tick and both are named. A single "deferred"
    // number with no reasons beside it is the adjective this file refuses.
    for (let i = 0; i <= RE_ENUMERATION_SETTLE_LIMIT; i += 1) {
      store.triggers.push(
        trigger({
          id: `trg_${i}`,
          projectId: `proj_${i}`,
          lastRunState: 'RUNNING',
          lastRunAt: new Date(NOW_MS - 60_000 + i),
        }),
      );
    }

    await processScheduleTick({ at: '' });

    const line = h.log.find((entry) => entry.obj.reEnumerationCaps !== undefined);
    expect(line?.obj.reEnumerationDeferred).toBe(1);
    expect(String(line?.obj.reEnumerationCaps)).toContain(
      `settle limit of ${RE_ENUMERATION_SETTLE_LIMIT}`,
    );
    // The 20 it DID look at are still crawling, which is not a cap biting.
    expect(line?.obj.reEnumerationInFlight).toBe(RE_ENUMERATION_SETTLE_LIMIT);
  });

  it('releases the claim when the crawl could not be queued, so the trigger stays due', async () => {
    /*
     * A queue that would not take the job is a fact about US. A trigger left
     * RUNNING would wait out the timeout and then be reported as a crawl that
     * failed — a fact about the customer's application, and the wrong one.
     */
    store.triggers.push(trigger());
    h.exploreThrows = true;

    await processScheduleTick({ at: '' });

    expect(store.triggers[0]!.lastRunState).toBe('NEVER_RUN');
    expect(store.triggers[0]!.lastRunAt).toBeNull();
    expect(h.log.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('settling a re-enumeration', () => {
  const running = (over: Row = {}): Row =>
    trigger({ lastRunState: 'RUNNING', lastRunAt: new Date(NOW_MS - 60_000), ...over });

  it('writes the drift record, succeeds the trigger and raises the new-surface event', async () => {
    store.triggers.push(running());
    twoCrawls(['/refunds', '/exports']);
    store.coverageItems.push(routeItem('/', 'COVERED'));

    await processScheduleTick({ at: '' });

    expect(store.drifts).toHaveLength(1);
    const drift = store.drifts[0]!;
    expect(drift.comparability).toBe('COMPARABLE');
    expect(drift.currentFlowMapId).toBe('fm_2');
    expect(drift.baselineFlowMapId).toBe('fm_1');
    expect(drift.routesAdded).toBe(2);
    expect(drift.routesRemoved).toBe(0);
    // THE number. Two new routes, neither of them in the coverage registry.
    expect(drift.newSurfaceWithoutTests).toBe(2);
    expect(drift.comparedAt).toEqual(new Date(NOW_MS));
    expect(drift.triggerId).toBe('trg_1');

    expect(store.triggers[0]!.lastRunState).toBe('SUCCEEDED');
    expect(store.triggers[0]!.lastFlowMapId).toBe('fm_2');
    expect(store.triggers[0]!.consecutiveFailures).toBe(0);

    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]!.action).toBe(RE_ENUMERATION_AUDIT_ACTIONS.newSurface);
    expect((store.audits[0]!.metadata as Row).newSurfaceWithoutTests).toBe(2);
  });

  it('records a comparison that found nothing as its OWN event, not as silence', async () => {
    store.triggers.push(running());
    twoCrawls([]);
    store.coverageItems.push(routeItem('/', 'COVERED'));

    await processScheduleTick({ at: '' });

    expect(store.drifts[0]!.newSurfaceWithoutTests).toBe(0);
    /*
     * "No drift" is only worth reading when somebody can see the comparison
     * happened. A blank feed and a feed that says "compared, nothing new" are
     * different facts.
     */
    expect(store.audits[0]!.action).toBe(RE_ENUMERATION_AUDIT_ACTIONS.compared);
  });

  it('writes NULL counts and NULL comparedAt when there is no baseline', async () => {
    store.triggers.push(running());
    store.flowMaps.push(
      flowMapRow({ graph: { ...(flowMapRow().graph as Row), nodes: [routeNode('/')] } }),
    );
    store.coverageItems.push(routeItem('/', 'UNCOVERED'));

    await processScheduleTick({ at: '' });

    const drift = store.drifts[0]!;
    expect(drift.comparability).toBe('UNCOMPARABLE_NO_BASELINE');
    // Not 0 and not 1. The first crawl of an environment has every route "new",
    // which is true and would be a drift event on day one for every customer.
    expect(drift.routesAdded).toBeUndefined();
    expect(drift.newSurfaceWithoutTests).toBeUndefined();
    expect(drift.detail).toBeUndefined();
    // A timestamp on a comparison that did not run is how "no drift since the
    // last crawl" gets claimed by a code path that never looked.
    expect(drift.comparedAt).toBeNull();
    expect(store.audits[0]!.action).toBe(RE_ENUMERATION_AUDIT_ACTIONS.uncomparable);
  });

  it('refuses a CANDIDATE baseline rather than reporting its gaps as new surface', async () => {
    store.triggers.push(running());
    twoCrawls(['/refunds']);
    store.flowMaps[0]!.acceptance = 'CANDIDATE';
    store.coverageItems.push(routeItem('/', 'COVERED'));

    await processScheduleTick({ at: '' });

    expect(store.drifts[0]!.comparability).toBe('UNCOMPARABLE_BASELINE_NOT_ACCEPTED');
    expect(store.drifts[0]!.newSurfaceWithoutTests).toBeUndefined();
    expect(store.triggers[0]!.lastRunState).toBe('SUCCEEDED');
  });

  it('leaves a trigger RUNNING while the crawl is still going, and writes nothing', async () => {
    store.triggers.push(running());
    // No FlowMap landed yet, and we are well inside the timeout.

    await processScheduleTick({ at: '' });

    expect(store.triggers[0]!.lastRunState).toBe('RUNNING');
    expect(store.drifts).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it('records a crawl that never landed as FAILED — not as a crawl that found nothing', async () => {
    /*
     * THE TWO OPPOSITE FACTS. "We could not re-enumerate" is our problem;
     * "nothing changed" is a claim about the customer's application. Collapsing
     * them is the lie this whole round exists to stop.
     */
    store.triggers.push(
      running({ lastRunAt: new Date(NOW_MS - RE_ENUMERATION_RUN_TIMEOUT_MS - 1000) }),
    );

    await processScheduleTick({ at: '' });

    expect(store.triggers[0]!.lastRunState).toBe('FAILED');
    expect(store.triggers[0]!.consecutiveFailures).toBe(1);
    expect(store.triggers[0]!.lastFailureMessage).toContain('NOT re-enumerated');
    // NO drift record. A failed crawl has nothing to compare.
    expect(store.drifts).toHaveLength(0);
  });

  it('never puts a raw error on the customer-visible failure column', async () => {
    store.triggers.push(running());
    twoCrawls(['/refunds']);
    const db = makeDb();
    h.prisma = {
      ...db,
      coverageItem: {
        findMany: async () => {
          // A message of exactly the shape that must not reach a column a
          // customer reads: a URL with a token in it.
          throw new Error('connect ECONNREFUSED https://app.example.com/?bypass=s3cr3t');
        },
      },
    };

    await processScheduleTick({ at: '' });

    expect(store.triggers[0]!.lastRunState).toBe('FAILED');
    expect(store.triggers[0]!.lastFailureMessage).not.toContain('s3cr3t');
    expect(store.triggers[0]!.lastFailureMessage).toContain('no drift is being claimed');
    expect(store.drifts).toHaveLength(0);
  });

  it('is idempotent: a second settle of the same crawl writes one record', async () => {
    store.triggers.push(running());
    twoCrawls(['/refunds']);
    store.coverageItems.push(routeItem('/', 'COVERED'));

    await processScheduleTick({ at: '' });
    // Put it back in flight, as a tick that died between the two writes would.
    store.triggers[0]!.lastRunState = 'RUNNING';
    await processScheduleTick({ at: '' });

    expect(store.drifts).toHaveLength(1);
  });
});

describe('establishing which routes have tests', () => {
  const running = (): Row =>
    trigger({ lastRunState: 'RUNNING', lastRunAt: new Date(NOW_MS - 60_000) });

  it('reports NULL, never 0, when coverage was never computed for the project', async () => {
    store.triggers.push(running());
    twoCrawls(['/refunds']);
    // No CoverageItem rows at all.

    await processScheduleTick({ at: '' });

    const drift = store.drifts[0]!;
    expect(drift.comparability).toBe('COMPARABLE');
    expect(drift.routesAdded).toBe(1);
    // NULL, because reporting 1 would assert "this route has no test" on the
    // strength of a registry nobody has populated.
    expect(drift.newSurfaceWithoutTests).toBeNull();
    expect((drift.detail as Row).testednessUnmeasuredBecause).toContain('never been computed');
    // And it does not raise the new-surface event on an unmeasured number.
    expect(store.audits[0]!.action).toBe(RE_ENUMERATION_AUDIT_ACTIONS.compared);
  });

  it('reports NULL when the tested-route limit bit, rather than a partial set', async () => {
    store.triggers.push(running());
    twoCrawls(['/refunds']);
    for (let i = 0; i <= RE_ENUMERATION_TESTED_ROUTE_LIMIT; i += 1) {
      store.coverageItems.push(routeItem(`/r${i}`, 'UNCOVERED'));
    }

    await processScheduleTick({ at: '' });

    /*
     * A truncated tested set UNDER-states testedness, which OVER-states
     * untested new surface. A floor in the alarming direction is the same sin
     * as one in the flattering direction.
     */
    expect(store.drifts[0]!.newSurfaceWithoutTests).toBeNull();
    expect((store.drifts[0]!.detail as Row).testednessUnmeasuredBecause).toContain('NOT zero');
  });

  it('treats a WAIVED or UNKNOWN route as one it must not call untested', async () => {
    store.triggers.push(running());
    twoCrawls(['/waived', '/unknown', '/plain']);
    store.coverageItems.push(
      routeItem('/', 'COVERED'),
      routeItem('/waived', 'WAIVED'),
      routeItem('/unknown', 'UNKNOWN'),
      routeItem('/plain', 'UNCOVERED'),
    );

    await processScheduleTick({ at: '' });

    /*
     * Only UNCOVERED supports the sentence "this route has no test". WAIVED was
     * taken out of the denominator by a human; UNKNOWN means a test navigates
     * to a URL built at run time and might be the only test covering it —
     * surface-coverage.ts's rule 2, which this is a reader of and not a second
     * opinion about.
     */
    expect(store.drifts[0]!.routesAdded).toBe(3);
    expect(store.drifts[0]!.newSurfaceWithoutTests).toBe(1);
  });
});

describe('the re-enumeration sweep cannot take the tick down', () => {
  it('still sweeps fail-fast when the trigger query fails', async () => {
    store.runs.push(failFastRun());
    store.results.push(result());
    const db = makeDb();
    h.prisma = {
      ...db,
      reEnumerationTrigger: {
        findMany: async () => {
          throw new Error('no connection');
        },
      },
    };

    await expect(processScheduleTick({ at: '' })).resolves.toBeUndefined();
    // The customer's fail-fast run is still stopped, and the monitors still ran.
    expect(store.runs[0]!.stopRequestedAt).toBeInstanceOf(Date);
    expect(h.log.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('runs AFTER the schedules and the monitors', async () => {
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
      reEnumerationTrigger: {
        ...(db.reEnumerationTrigger as Row),
        findMany: async (args: Row) => {
          order.push('re-enumeration');
          return (db.reEnumerationTrigger as Row).findMany(args);
        },
      },
    };

    await processScheduleTick({ at: '' });

    // A nightly suite that fired four seconds late because a drift diff was
    // reading two 400-route graphs is the wrong trade.
    expect(order[0]).toBe('schedules');
    expect(order[1]).toBe('monitors');
    expect(order.includes('re-enumeration')).toBe(true);
    expect(order.indexOf('re-enumeration')).toBeGreaterThan(order.indexOf('monitors'));
  });
});
