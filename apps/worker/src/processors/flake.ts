/**
 * Flake confirmation and auto-quarantine (§5).
 *
 * The flake radar has always computed `flakeRate`, `consecutiveFailures` and
 * `lastRunAt` on Test, and nothing ever acted on them. This is what acts — but
 * only on evidence it produced itself.
 *
 * ── The shape of it ─────────────────────────────────────────────────────────
 * A suspicion ("it passed on retry", "it flipped between runs") is not a
 * measurement. When one appears, this opens an INVESTIGATION: N re-runs of that
 * one test, against the same environment, queued behind everything else, and
 * the answer it reports is "failed 3 of 10" rather than a number derived from
 * whatever happened to be in the history table.
 *
 * A confirmation re-run is a real Run row going through the real run queue on
 * purpose. A rate measured through a private execution path is a measurement of
 * the private path, not of the test — and the evidence stays inspectable in the
 * cockpit, which is what lets a human disagree with the decision. Every such run
 * is stamped `triggeredBy = flake-radar:<testId>:<investigationId>`.
 *
 * ── Where the state lives ───────────────────────────────────────────────────
 * Nowhere new. An investigation IS its Run rows, and it is over when an AuditLog
 * row says so. That is deliberate: this feature adds no table, survives a worker
 * restart mid-investigation, and cannot leave a half-finished investigation
 * pinned in Redis where nobody can see it. The audit row is written in the same
 * transaction as the quarantine flip, because a decision nobody can see did not
 * happen.
 *
 * ── Quarantine is not the product; it is the brake ──────────────────────────
 * Quarantine SUPPRESSES a signal. For a long time it was the ONLY thing
 * downstream of the word "flake", which meant this product's answer to "your
 * test is unreliable" was "fine, we will stop listening to it". Three sweeps
 * added to the tick close that:
 *
 *   `deflakeSweep`        turns a FLAKE verdict into a REPAIR — model-free
 *                         where the defect is deterministic (a fixed sleep, an
 *                         un-awaited action), and an honest "no fix, here is
 *                         why" where it is not. See packages/agent/src/deflake.ts.
 *   `verifyAppliedHeals`  re-runs the test after a heal is applied, because
 *                         APPLIED was a claim nobody checked — and a heal
 *                         recorded APPLIED while still red tells a human the
 *                         problem is handled.
 *   `driftSweep`          compares the suite against the newest crawl, so a
 *                         renamed locator is reported BEFORE it costs a failing
 *                         run, and a test whose page no longer exists is
 *                         proposed for retirement instead of being healed
 *                         forever against a page that is gone.
 *
 * ── Which way it fails ──────────────────────────────────────────────────────
 * A quarantined test still RUNS; it just stops gating. So quarantine SUPPRESSES
 * a signal, and every uncertainty here resolves towards not suppressing:
 * not enough usable samples, a REAL_BUG verdict in the window, a critical-path
 * test, a policy that will not parse, a query that throws — all of them mean
 * "leave it gating". Release, which restores gating, is the safe direction and
 * needs only the same evidence bar.
 *
 * Follows the repeating-sweep pattern in schedule.ts: one tick, no per-test
 * timers. Timers drift, do not survive a restart, and stop silently.
 */

import { randomUUID } from 'node:crypto';
import {
  AUTO_QUARANTINE_REASON_PREFIX,
  FIXTURE_PREFIX,
  FLAKE_AUDIT_ACTIONS,
  FLAKE_POLICY_DEFAULTS,
  FLAKE_RUN_PREFIX,
  HEAL_AUDIT_ACTIONS,
  MANUAL_QUARANTINE_ACTIONS,
  TERMINAL_RUN_STATUSES,
  resolveFlakePolicy,
} from '@qaai/shared';
import type {
  CrawlAcceptanceState,
  FlakePolicy,
  FlowMap,
  Priority,
  RunStatus,
  TestResultStatus,
} from '@qaai/shared';
/*
 * The budget, the expiry and what "quarantine in force" means all live in
 * packages/runner/src/gates.ts — the module that already owned the one rule
 * quarantine had. They are imported rather than re-stated here because the
 * other door to quarantine (apps/api/src/routes/tests.ts, where a person flips
 * the switch) has to enforce the SAME cap, and two implementations of a budget
 * is how two doors come to disagree about it.
 */
import {
  checkQuarantineBudget,
  quarantineExpiryFrom,
  quarantineSuppresses,
  QUARANTINE_MAX_DAYS,
} from '@qaai/runner';
import type { QuarantineBudgetVerdict } from '@qaai/runner';
/*
 * The heal lifecycle rules. Pure decisions, no Prisma — the verdict about what a
 * verification means and which proposals a new one replaces lives beside the
 * Healer itself, so the API's approval route and this sweep cannot come to
 * different conclusions about the same row.
 */
import {
  auditTestsAgainstCrawl,
  decideVerification,
  driftCheck,
  parseVerificationRunTag,
  planSupersede,
  proposeDeflake,
  shouldProposeHeal,
} from '@qaai/agent';
import type { HealVerifyState, OpenHeal, TestSurfaceReport } from '@qaai/agent';
/*
 * One remaining relative import, and a narrower reason than the three this file
 * used to carry.
 *
 * `deflake.js` and `obsolete.js` are now in the package barrel, so they come in
 * through the `@qaai/agent` line above like everything else. `suite-health.js`
 * is not exported from it — promoting that module is somebody else's change —
 * and this is a TYPE-ONLY import, so it is erased at build time and reaches no
 * runtime code across the boundary.
 */
import type { SuiteHealthTestInput } from '../../../../packages/agent/src/suite-health.js';
// One toll for every path that creates a Run: the plan gate and the usage
// counter. It lives in the API workspace and takes its Prisma client as an
// argument so this file can call the same implementation POST /runs does.
import { startRun } from '../../../api/src/lib/start-run.js';
import { logger, prisma } from '../context.js';
import { enqueueRun, enqueueVerifyHeal } from '../queues.js';
/*
 * The queue-driven half of heal verification, and the reason this import exists
 * rather than a second copy of the plumbing.
 *
 * `processors/verify-heal.ts` owns the START (one implementation, replacing the
 * module-local copies this file's own sweep could not reach), the report
 * vocabulary and `needsVerificationStart` — the predicate that finds the heal
 * `verifyAppliedHeals` below is structurally unable to see. This file owns the
 * WRITE. Types only from the port interfaces, plus the one predicate; nothing
 * in verify-heal.ts imports this file back, so there is no cycle.
 */
import { needsVerificationStart } from './verify-heal.js';
import type {
  RunEnqueuer,
  RunStarter,
  StartRefusal,
  VerificationRecorder,
  VerifyHealStore,
  VerifyLog,
} from './verify-heal.js';

/** Empty — the tick sweeps for suspects and in-flight investigations itself. */
export interface FlakeTickJob {
  at: string;
}

/**
 * Global ceiling on investigations in flight, across every org.
 *
 * The per-project policy bounds how much one project can ask for; this bounds
 * what the whole fleet can spend on measuring itself. Confirmation runs are
 * background work by construction (see `enqueueRun`'s background priority), but
 * background work still occupies a worker while it holds a browser.
 */
const MAX_CONCURRENT_INVESTIGATIONS = Number(process.env.QAAI_FLAKE_MAX_INVESTIGATIONS ?? 3);

/** How far back the suspect scan looks. Comfortably wider than the tick. */
const SUSPECT_LOOKBACK_MINUTES = 90;

/** Hard cap on the suspect scan, so one busy hour cannot make the tick unbounded. */
const SUSPECT_SCAN_LIMIT = 500;

/** How far back the sweep looks for in-flight investigations. */
const INVESTIGATION_SCAN_HOURS = 24;

/** Ceiling on the release scan, which is a plain "what is quarantined" query. */
const RELEASE_SCAN_LIMIT = 200;

/**
 * How long a flake-trend point is kept.
 *
 * 90 days, which is the longest retention any plan buys for the results the
 * trend is computed FROM (`RETENTION_DAYS.BUSINESS` in processors/run.ts, with
 * ENTERPRISE at 365). Keeping trend points past the results behind them would
 * leave a line nobody can audit — "the rate was 40% that Tuesday" with no rows
 * to check it against — and a trend you cannot check is a trend you should not
 * act on.
 *
 * WHAT IT LOSES: anything older than a quarter. A year-over-year comparison is
 * not available from this table and is not meant to be; a longer trend belongs
 * in a monthly rollup, not in a bigger window here.
 */
const FLAKE_HISTORY_RETENTION_DAYS = 90;

/**
 * Rows deleted per tick by the retention prune.
 *
 * Bounded for the same reason every other sweep in this file is: one busy
 * project must not hold the tick open. Whatever is left over waits for the next
 * tick — the table is already bounded by (tests x days), so falling behind
 * costs disk, never correctness.
 */
const FLAKE_HISTORY_PRUNE_LIMIT = 5_000;

const TERMINAL: readonly string[] = TERMINAL_RUN_STATUSES;

// ─────────────────────────────────────────────────────────────────────────────
// Tunables for the three sweeps below. Exported constants rather than
// environment variables, deliberately: scripts/check-wiring.ts fails an env var
// nobody deploying this could discover, and none of these is a knob an operator
// should be guessing at. A project-level column is the right home for anything
// a customer genuinely needs to differ on — `FlakePolicy` is where that goes.
// ─────────────────────────────────────────────────────────────────────────────

/*
 * The audit actions the heal lane writes — the only record these sweeps leave.
 *
 * They live in packages/shared/src/constants.ts now, beside
 * `FLAKE_AUDIT_ACTIONS`: this file WRITES the rows and the audit-log reader in
 * the API RENDERS them, and an action string declared in a worker processor
 * could not be named by the surface that displays it without importing the
 * processor. Re-exported because flake.test.ts destructures it out of this
 * module, and because every reader already here keeps working unchanged.
 */
export { HEAL_AUDIT_ACTIONS };

/**
 * How long a verifying run has to produce a terminal status before the heal is
 * recorded UNVERIFIABLE.
 *
 * Longer than a flake investigation's deadline, because a verification is ONE
 * run rather than ten, and because the cost of being early here is the worst
 * outcome this feature has: "nobody checked" written about a run that was about
 * to come back green. 90 minutes is comfortably past any single-test run that is
 * going to finish at all.
 */
export const HEAL_VERIFY_DEADLINE_MINUTES = 90;

/** Ceiling on the verification sweep, so one install cannot hold the tick open. */
const HEAL_VERIFY_SCAN_LIMIT = 50;

/**
 * How far back the deflake sweep looks for FLAKE verdicts.
 *
 * Wide enough that a verdict filed while the worker was down is still picked up,
 * and narrow enough that the sweep is not re-reading last month's verdicts
 * forever. The per-test cooldown below is what actually stops repetition.
 */
const DEFLAKE_VERDICT_LOOKBACK_HOURS = 24;

const DEFLAKE_SCAN_LIMIT = 200;

/**
 * Deflake proposals written per tick, across every org.
 *
 * The analysis is deterministic and cheap, but each proposal is a row in
 * somebody's review queue. Five per tick is a few dozen an hour, which is more
 * than any team can read; the cap exists so a project that goes wholesale flaky
 * cannot bury its own queue in one afternoon.
 */
const DEFLAKE_PROPOSALS_PER_TICK = 5;

/**
 * How long before the same test is analysed for a deflake again.
 *
 * Applies to the UNFIXABLE answer in particular: "QAAI looked and has no
 * automatic fix" is worth recording once, not once every five minutes forever.
 */
const DEFLAKE_RETRY_HOURS = 24;

/** Flow maps read per tick, before reducing to the newest per project. */
const DRIFT_FLOWMAP_SCAN_LIMIT = 50;

/** Tests compared per project per crawl. */
const DRIFT_TEST_SCAN_LIMIT = 500;

/**
 * Route items read per project per crawl — the SOURCE side of a retirement.
 *
 * This cap is the dangerous one in this file, and it is read one row over it on
 * purpose so that "there are more" is a FACT and not an inference. The declared
 * -route list is one of the two independent negatives a retirement rests on: on
 * a project with more route items than this, a route the source genuinely
 * declares does not come back, arrives at `obsolete.ts` as `declared: false`,
 * and the cap manufactures a retirement proposal for a test whose page is
 * perfectly fine. So beyond it the whole project's source side is declared
 * TRUNCATED and every proposal for that crawl is withheld — the same way
 * `truncatedReason` withholds them on the crawl side — and the audit row
 * records that the cap bit.
 *
 * The ORDER BY matters for the same reason the cap does: without one, Postgres
 * returns whichever 2,000 rows it likes, so this sweep and GET /agent/drift
 * could read different subsets of the same table and reach different verdicts
 * about the same test. `key` is unique per (project, kind) and indexed.
 */
const DRIFT_ROUTE_ITEM_SCAN_LIMIT = 2_000;

/** Drift warnings kept in the audit row. The full list is recomputable on read. */
const DRIFT_WARNINGS_RECORDED = 50;

/**
 * Retirement proposals minted per project per crawl.
 *
 * Low on purpose. A crawl that suddenly reaches nothing — a base URL that
 * changed, an environment that was down in a way the crawler read as empty —
 * would otherwise propose retiring the customer's entire suite in one tick.
 * `obsolete.ts` refuses to propose on a truncated crawl, which catches most of
 * that; this is the backstop for the case where the crawl believed it was
 * complete.
 */
const RETIREMENTS_PER_PROJECT_PER_CRAWL = 10;

// ─────────────────────────────────────────────────────────────────────────────
// The decision, as pure functions. Everything below this line that matters is
// testable without a database, because the interesting failure modes are all
// judgement calls rather than queries.
// ─────────────────────────────────────────────────────────────────────────────

export interface FlakeSample {
  /** Terminal status of the confirmation run itself. */
  runStatus: RunStatus | string;
  /** Result recorded for the test under investigation, when there was one. */
  status: TestResultStatus | null;
  retriedAndPassed: boolean;
}

export interface FlakeMeasurement {
  failed: number;
  /** Samples that actually measured something. The denominator. */
  of: number;
  ratePercent: number;
  /** Samples thrown away: the run errored, was cancelled, or never executed. */
  discarded: number;
}

/**
 * Turn samples into a rate.
 *
 * A run that ERRORED or was CANCELLED, or that recorded SKIPPED because no
 * plugin supports the type, says nothing about the test — counting it either way
 * would be an opinion about our own infrastructure. It is discarded, and the
 * denominator shrinks, which pushes the result towards "not enough evidence".
 *
 * A pass that only happened on retry counts as a failure. That is the whole
 * definition of a flake, and it is the same rule `retriedAndPassed` encodes for
 * the quality gate.
 */
export function measureSamples(samples: readonly FlakeSample[]): FlakeMeasurement {
  let failed = 0;
  let of = 0;
  let discarded = 0;

  for (const sample of samples) {
    const runUsable = sample.runStatus === 'PASSED' || sample.runStatus === 'FAILED';
    const executed = sample.status !== null && sample.status !== 'SKIPPED';
    if (!runUsable || !executed) {
      discarded += 1;
      continue;
    }
    of += 1;
    if (sample.status !== 'PASSED' || sample.retriedAndPassed) failed += 1;
  }

  return { failed, of, ratePercent: of === 0 ? 0 : (failed / of) * 100, discarded };
}

/** "failed 3 of 10 confirmation re-runs (30%)" — the phrase every reason uses. */
export function describeMeasurement(m: FlakeMeasurement): string {
  return `failed ${m.failed} of ${m.of} confirmation re-runs (${Math.round(m.ratePercent)}%)`;
}

export type FlakeAction = 'QUARANTINE' | 'RELEASE' | 'NONE';

export interface FlakeDecision {
  action: FlakeAction;
  /** Always says why, always carries the measured rate. Written to the audit row. */
  reason: string;
}

export interface FlakeDecisionInput {
  policy: FlakePolicy;
  measurement: FlakeMeasurement;
  quarantined: boolean;
  /** Only a quarantine QAAI can prove it wrote may be lifted by QAAI. */
  machineQuarantined: boolean;
  priority: Priority;
  /** When a failure of this test was last triaged REAL_BUG, inside the window. */
  realBugTriagedAt: Date | null;
  /**
   * Whether the project has room for another quarantine. Absent means the
   * budget could not be read, and an unreadable budget does NOT block a
   * quarantine — the measurement is the evidence this file exists to act on,
   * and refusing on a failed count would be refusing on no information.
   */
  budget?: QuarantineBudgetVerdict;
}

/**
 * The whole policy, in one place.
 *
 * Deliberately stateless about which direction the investigation was opened in.
 * A test can be quarantined by something else while its investigation is in
 * flight (the run finaliser does exactly that), so the decision is made from the
 * state that exists NOW plus the rate that was just measured — never from an
 * intent recorded ten runs ago.
 */
export function decideFlakeAction(input: FlakeDecisionInput): FlakeDecision {
  const { policy, measurement: m, quarantined, machineQuarantined, priority } = input;
  const measured = describeMeasurement(m);

  if (m.of < policy.minSamples) {
    return {
      action: 'NONE',
      reason:
        `Only ${m.of} of ${policy.samples} confirmation re-runs produced a usable result ` +
        `(${m.discarded} discarded), below the ${policy.minSamples} this project requires. ` +
        `No action taken — a quarantine on thin evidence is how a real bug goes quiet.`,
    };
  }

  /*
   * The two states that must never be suppressed, checked before anything else.
   *
   * A test that failed EVERY sample is not flaky, it is broken — quarantining it
   * would hide a deterministic failure behind the word "flake". And a failure a
   * triager already called a REAL_BUG is the exact case the product exists to
   * surface. If either is true and we are holding the quarantine, we let go of
   * it: restoring the gate is always the safe direction.
   */
  const failedEverySample = m.of > 0 && m.failed === m.of;
  if (failedEverySample || input.realBugTriagedAt) {
    const why = failedEverySample
      ? `It ${measured} — every single one. That is a consistent failure, not a flake.`
      : `A failure of this test was triaged REAL_BUG on ${input.realBugTriagedAt!.toISOString().slice(0, 10)}, ` +
        `and it ${measured}.`;

    if (quarantined && machineQuarantined && policy.autoRelease) {
      return { action: 'RELEASE', reason: `Auto-released: ${why} Releasing it so it gates again.` };
    }
    return { action: 'NONE', reason: `${why} Left gating.` };
  }

  if (m.ratePercent > policy.quarantineRatePercent) {
    if (priority === 'CRITICAL_PATH' && policy.protectCriticalPath) {
      return {
        action: 'NONE',
        reason:
          `It ${measured}, above the ${policy.quarantineRatePercent}% threshold, but it is a ` +
          `critical-path test. Quarantining one of those needs a person, so it keeps gating — ` +
          `quarantine it by hand if that is what you want.`,
      };
    }
    if (!policy.autoQuarantine) {
      return {
        action: 'NONE',
        reason:
          `It ${measured}, above the ${policy.quarantineRatePercent}% threshold, but ` +
          `auto-quarantine is off for this project. Recorded as evidence only.`,
      };
    }
    if (quarantined && !machineQuarantined) {
      // It is already where we would put it, but a person put it there. Taking
      // ownership by overwriting their reason would make this ours to release
      // later, and quietly undoing a human decision is not a thing we do.
      return {
        action: 'NONE',
        reason:
          `It ${measured}, above the ${policy.quarantineRatePercent}% threshold, and a person ` +
          `had already quarantined it. Their quarantine stands, and this is the evidence for it.`,
      };
    }
    /*
     * ── The budget refusal ────────────────────────────────────────────────
     *
     * Checked LAST, after every other reason to leave a test gating, because it
     * is the only one that is about the SUITE rather than about this test. A
     * test over the quarantine threshold in a suite that has already spent its
     * budget keeps gating, and the reason says what clears it: fix one of the
     * quarantined tests, or delete it.
     *
     * The alternative — quarantine anyway and warn — is what this defect was.
     * An escape hatch that always opens is not a budget, and a suite where a
     * quarter of the tests have stopped gating is a suite nobody is testing,
     * however loudly the dashboard says so.
     */
    if (input.budget && !input.budget.allowed) {
      return {
        action: 'NONE',
        reason:
          `It ${measured}, above the ${policy.quarantineRatePercent}% threshold, but this ` +
          `project is at its quarantine budget. ${input.budget.reason} It keeps gating.`,
      };
    }

    return {
      action: 'QUARANTINE',
      reason:
        `${AUTO_QUARANTINE_REASON_PREFIX}: it ${measured}, above this project's ` +
        `${policy.quarantineRatePercent}% threshold. It still runs — it just stops gating, and ` +
        `only for ${QUARANTINE_MAX_DAYS} days: a quarantine with no end date is a deletion ` +
        `nobody signed, so it expires and starts gating again unless it is fixed, deleted or ` +
        `quarantined again on purpose. Disagree? Un-quarantine it and it gates again immediately.`,
    };
  }

  if (quarantined && m.ratePercent <= policy.releaseRatePercent) {
    if (!machineQuarantined) {
      return {
        action: 'NONE',
        reason:
          `It ${measured}, at or below the ${policy.releaseRatePercent}% release threshold, but ` +
          `a person quarantined this test. Only a person takes it back out.`,
      };
    }
    if (!policy.autoRelease) {
      return {
        action: 'NONE',
        reason:
          `It ${measured}, at or below the ${policy.releaseRatePercent}% release threshold, but ` +
          `auto-release is off for this project. It stays quarantined.`,
      };
    }
    return {
      action: 'RELEASE',
      reason:
        `Auto-released: it ${measured}, at or below this project's ${policy.releaseRatePercent}% ` +
        `release threshold, so it looks stable again. It gates from now on.`,
    };
  }

  return {
    action: 'NONE',
    reason:
      `It ${measured} — between the ${policy.releaseRatePercent}% release and ` +
      `${policy.quarantineRatePercent}% quarantine thresholds. Left exactly as it was.`,
  };
}

/**
 * Did QAAI put this test in quarantine, or did a person?
 *
 * The audit log is the answer when it has one: whoever acted last owns the
 * state. Without a row, the only evidence is the reason string the run finaliser
 * writes, and anything unrecognised is treated as a person's decision. Being
 * wrong in that direction leaves a flaky test quarantined; being wrong the other
 * way silently overrides a human, which is worse.
 */
export function isMachineQuarantine(args: {
  quarantineReason: string | null;
  lastQuarantineAuditAction: string | null;
}): boolean {
  if (args.lastQuarantineAuditAction === FLAKE_AUDIT_ACTIONS.quarantined) return true;
  if (
    args.lastQuarantineAuditAction &&
    MANUAL_QUARANTINE_ACTIONS.includes(args.lastQuarantineAuditAction as never)
  ) {
    return false;
  }
  return (args.quarantineReason ?? '').startsWith(AUTO_QUARANTINE_REASON_PREFIX);
}

/** `flake-radar:<testId>:<investigationId>` — the whole investigation, in a string. */
export function investigationTag(testId: string, investigationId: string): string {
  return `${FLAKE_RUN_PREFIX}${testId}:${investigationId}`;
}

export function parseInvestigationTag(
  triggeredBy: string | null | undefined,
): { testId: string; investigationId: string } | null {
  if (typeof triggeredBy !== 'string' || !triggeredBy.startsWith(FLAKE_RUN_PREFIX)) return null;
  const [testId, investigationId] = triggeredBy.slice(FLAKE_RUN_PREFIX.length).split(':');
  if (!testId || !investigationId) return null;
  return { testId, investigationId };
}

export interface SuspectRow {
  testId: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  status: TestResultStatus | string;
  retriedAndPassed: boolean;
  /**
   * True for a run QAAI started to measure or check something, rather than a run
   * of the customer's suite. Excluded from the suspect scan.
   *
   * TWO kinds qualify, and the second was a hole. A flake investigation's
   * confirmation runs obviously must not feed the scan — an investigation would
   * keep re-suspecting the test it is currently measuring. A HEAL VERIFICATION
   * run is the same shape and the same problem: it runs one test, on purpose,
   * right after that test's code changed, and a verification that fails is
   * precisely the "it passed and failed across recent runs" pattern the scan
   * reads as instability. Left in, every applied heal that did not work would
   * open a flake investigation about a test we already know is broken, and spend
   * ten more runs confirming it.
   */
  fromConfirmationRun: boolean;
}

export interface Suspect {
  testId: string;
  orgId: string;
  projectId: string;
  /** The environment the suspicion arose in — the one to re-run against. */
  environmentId: string;
  why: string;
}

/**
 * Which tests look flaky, from recent results alone (newest first).
 *
 * Two signals, both cheap and both classic: a test that passed only on retry,
 * and a test that flipped between passing and failing across runs. Neither is
 * evidence — that is what the investigation is for — so this is allowed to be
 * generous. It is NOT allowed to consider confirmation runs, or an
 * investigation would keep re-suspecting the test it is currently measuring.
 */
export function findSuspects(rows: readonly SuspectRow[]): Suspect[] {
  const byTest = new Map<string, SuspectRow[]>();
  for (const row of rows) {
    if (row.fromConfirmationRun) continue;
    const list = byTest.get(row.testId);
    if (list) list.push(row);
    else byTest.set(row.testId, [row]);
  }

  const suspects: Suspect[] = [];
  for (const [testId, results] of byTest) {
    const retried = results.some((r) => r.retriedAndPassed);
    const flaky = results.some((r) => r.status === 'FLAKY');
    const passed = results.some((r) => r.status === 'PASSED');
    const failed = results.some((r) => r.status === 'FAILED' || r.status === 'TIMED_OUT');

    const why = retried
      ? 'it passed only on retry'
      : flaky
        ? 'it was recorded as flaky'
        : passed && failed
          ? 'it passed and failed across recent runs without anyone changing it'
          : null;
    if (!why) continue;

    // Newest first, so the head is where the suspicion arose.
    const head = results[0]!;
    suspects.push({
      testId,
      orgId: head.orgId,
      projectId: head.projectId,
      environmentId: head.environmentId,
      why,
    });
  }
  return suspects;
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweep.
// ─────────────────────────────────────────────────────────────────────────────

interface InvestigationGroup {
  testId: string;
  investigationId: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  runs: Array<{
    id: string;
    status: string;
    queuedAt: Date;
    results: Array<{ testId: string; status: TestResultStatus; retriedAndPassed: boolean }>;
  }>;
}

export async function processFlakeTick(_job: FlakeTickJob): Promise<void> {
  if ((process.env.QAAI_FLAKE_AUTOMATION ?? '').toLowerCase() === 'off') {
    logger.debug('flake automation is switched off by QAAI_FLAKE_AUTOMATION');
    return;
  }

  const now = new Date();
  // One policy read per project per tick, not one per investigation.
  const policies = new Map<string, FlakePolicy>();

  const active = await advanceInvestigations(now, policies);
  await openInvestigations(now, policies, active);

  /*
   * ── The three sweeps that turn a flake into a fix ──────────────────────────
   *
   * Each one is independent, bounded, and `.catch()`ed: this tick is shared by
   * every org on the install, so one project's bad row must never stop another
   * project's measurement. Nothing is decided by a sweep that threw, so nothing
   * is suppressed and the next tick retries.
   *
   * WHY THEY LIVE IN THIS FILE. All three are periodic comparisons over test
   * health that need no new table — which is the shape this file already is
   * (see "Where the state lives" above). `driftSweep` in particular should
   * ideally be called by processors/explore.ts the moment a crawl finishes
   * rather than noticed afterwards; it keys off the FlowMap id so it runs
   * exactly once per crawl either way, and moving the call there later changes
   * nothing about the function.
   *
   * This paragraph used to end "and registering a new queue means editing
   * packages/shared's QUEUE_NAMES and the worker's registry, neither of which
   * this change owns". That is no longer true of the file it sits in:
   * `startVerificationHoles` below PRODUCES to `VERIFY_HEAL_QUEUE`, declared in
   * ../queues.ts and consumed in ../index.ts, the same way `ANALYZE_SOURCE_QUEUE`
   * and `PREFLIGHT_QUEUE` are. Corrected rather than left, because a doc comment
   * that contradicts the code under it is a sentence a reviewer trusts instead
   * of testing.
   */
  await verifyAppliedHeals(now).catch((err) =>
    logger.error({ err }, 'could not advance heal verification; it will be retried next tick'),
  );
  /*
   * ── AND THE HEAL THE SWEEP ABOVE IS STRUCTURALLY UNABLE TO SEE ────────────
   *
   * `verifyAppliedHeals` chases `verifyState: 'PENDING'`. A heal whose apply
   * committed and whose verification start then failed — the process died
   * between the transaction and the update, which both apply paths document as
   * leaving the column NULL — is APPLIED in the customer's test with
   * `verifyState: null` FOR EVER, and no query above can find it. This is the
   * one that does. Separately `.catch()`ed, because the two sweeps answer
   * different questions and a Redis blip in the enqueue must not cost the
   * reader above its retry.
   */
  await startVerificationHoles(now).catch((err) =>
    logger.error(
      { err },
      'could not sweep for applied heals with no verification; it will be retried next tick',
    ),
  );
  await deflakeSweep(now).catch((err) =>
    logger.error({ err }, 'could not propose deflakes; it will be retried next tick'),
  );
  await driftSweep().catch((err) =>
    logger.error({ err }, 'could not run the drift check; it will be retried next tick'),
  );

  /*
   * Retention for the flake trend. Here rather than in the run processor
   * because that would mean a bounded delete per test per run — thousands of
   * pointless statements an hour — and never throws into the tick, because a
   * sweep that stopped measuring flakes in order to tidy up a table would be
   * trading the product for the housekeeping.
   */
  await pruneFlakeHistory(now).catch((err) =>
    logger.warn({ err }, 'could not prune the flake history; it will be retried next tick'),
  );
}

/**
 * Delete flake-trend points past the retention window.
 *
 * Returns how many went, so the sweep's own test can prove the window is
 * applied rather than assumed.
 */
export async function pruneFlakeHistory(now: Date): Promise<number> {
  const before = new Date(now.getTime() - FLAKE_HISTORY_RETENTION_DAYS * 86_400_000);
  /*
   * `deleteMany` cannot take a LIMIT in Prisma, so the bound is applied by
   * selecting the ids first. Oldest first: a prune that falls behind must make
   * progress from the far end rather than nibbling at a random slice.
   */
  const doomed = await prisma.testFlakeHistory.findMany({
    where: { day: { lt: before } },
    orderBy: { day: 'asc' },
    take: FLAKE_HISTORY_PRUNE_LIMIT,
    select: { id: true },
  });
  if (doomed.length === 0) return 0;

  const gone = await prisma.testFlakeHistory.deleteMany({
    where: { id: { in: doomed.map((row) => row.id) } },
  });
  logger.info(
    { deleted: gone.count, olderThan: before.toISOString().slice(0, 10) },
    'pruned flake history past its retention window',
  );
  return gone.count;
}

/**
 * Has this project got room for another quarantine?
 *
 * Returns `undefined` when the count could not be read, and the decision then
 * proceeds WITHOUT a budget — see `FlakeDecisionInput.budget`. That is the only
 * uncertainty in this file that does not resolve towards "leave it gating", and
 * deliberately: every other uncertainty here is about the TEST, where caution
 * means not suppressing. This one is about a count, and refusing a measured
 * quarantine because a `count()` failed would be refusing on no information at
 * all — the measurement is the evidence, and it is already in hand.
 */
async function quarantineBudgetFor(
  orgId: string,
  projectId: string,
  testId: string,
  alreadyQuarantined: boolean,
  now: Date,
): Promise<QuarantineBudgetVerdict | undefined> {
  try {
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: { quarantineBudgetPercent: true },
    });

    /*
     * Both counted in the database rather than by reading the rows.
     *
     * Expired quarantines do not count against the budget: they are not
     * suppressing anything any more — the test gates again — so charging the
     * project for them would make the budget tighten on its own over time and
     * refuse a quarantine the suite had room for. That is the `OR` arm, and it
     * is the same rule `quarantineSuppresses` applies, expressed as SQL.
     *
     * The test under investigation is excluded, so re-measuring it cannot
     * charge the budget twice for one suppression.
     *
     * A `count` and not a `findMany`: this runs once per investigation on the
     * sweep's tick, and a project with 4,000 quarantined tests is exactly the
     * project the budget exists for. Pulling its rows into memory to measure
     * them would make the check most expensive on the suite it matters most on.
     */
    const [totalTests, inForce] = await Promise.all([
      prisma.test.count({ where: { orgId, projectId, disabledAt: null } }),
      prisma.test.count({
        where: {
          orgId,
          projectId,
          disabledAt: null,
          quarantined: true,
          id: { not: testId },
          OR: [{ quarantineExpiresAt: null }, { quarantineExpiresAt: { gt: now } }],
        },
      }),
    ]);

    return checkQuarantineBudget({
      totalTests,
      quarantinedCount: inForce,
      budgetPercent: project?.quarantineBudgetPercent ?? null,
      alreadyQuarantined,
    });
  } catch (err) {
    logger.warn(
      { err, projectId, testId },
      'could not read the quarantine budget; deciding on the measurement alone',
    );
    return undefined;
  }
}

interface ActiveInvestigations {
  total: number;
  byProject: Map<string, number>;
  tests: Set<string>;
}

/**
 * Move every in-flight investigation forward by at most one step: queue the next
 * sample, or conclude.
 *
 * One sample in flight at a time, per investigation. Ten runs queued at once
 * would be ten browsers held to answer a question nobody is waiting on; one at a
 * time also means an investigation is trivially interruptible — cancel the run
 * that is in flight and the investigation stops with it.
 */
async function advanceInvestigations(
  now: Date,
  policies: Map<string, FlakePolicy>,
): Promise<ActiveInvestigations> {
  const active: ActiveInvestigations = { total: 0, byProject: new Map(), tests: new Set() };

  /*
   * The one query in this file that touches every org at once, five minutes
   * apart, forever — so it is the one that has to be an index lookup rather
   * than a scan. It is served by Run(triggeredBy text_pattern_ops, queuedAt),
   * added in 20260824000000_query_plan_indexes, and three things about it are
   * load-bearing:
   *
   *   - `startsWith`, not `contains` and not a regex. Prisma turns it into
   *     LIKE 'flake-radar:%', which is the only shape a btree can answer; any
   *     other match on this column goes straight back to reading the table.
   *   - the operator class on that index. The database collates en_US, and
   *     under a non-C collation a DEFAULT btree cannot serve a prefix LIKE at
   *     all — the same index without text_pattern_ops is never opened.
   *   - the 24h floor stays in this where. It is the second index column, so
   *     the bound is applied inside the index; drop it and the sweep starts
   *     fetching every confirmation run the install has ever made.
   *
   * Measured on 301,500 runs: full scan, 1,052 buffers, 5.0 ms -> index scan,
   * 35 buffers, 0.09 ms.
   */
  const runs = await prisma.run.findMany({
    where: {
      triggeredBy: { startsWith: FLAKE_RUN_PREFIX },
      queuedAt: { gte: new Date(now.getTime() - INVESTIGATION_SCAN_HOURS * 3_600_000) },
    },
    orderBy: { queuedAt: 'asc' },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      environmentId: true,
      status: true,
      triggeredBy: true,
      queuedAt: true,
      results: { select: { testId: true, status: true, retriedAndPassed: true } },
    },
  });

  const groups = new Map<string, InvestigationGroup>();
  for (const run of runs) {
    const parsed = parseInvestigationTag(run.triggeredBy);
    if (!parsed) continue;
    const key = run.triggeredBy!;
    const group = groups.get(key);
    if (group) {
      group.runs.push(run);
      continue;
    }
    groups.set(key, {
      ...parsed,
      orgId: run.orgId,
      projectId: run.projectId,
      environmentId: run.environmentId,
      runs: [run],
    });
  }

  for (const group of groups.values()) {
    try {
      const stillOpen = await advanceOne(group, now, policies);
      if (!stillOpen) continue;
      active.total += 1;
      active.tests.add(group.testId);
      active.byProject.set(group.projectId, (active.byProject.get(group.projectId) ?? 0) + 1);
    } catch (err) {
      // One test's investigation must never stop the sweep for every other org.
      // Nothing was decided, so nothing was suppressed: the next tick retries.
      logger.error(
        { err, testId: group.testId, investigationId: group.investigationId },
        'could not advance a flake investigation',
      );
      active.total += 1;
      active.tests.add(group.testId);
    }
  }

  return active;
}

/** @returns true while the investigation is still open. */
async function advanceOne(
  group: InvestigationGroup,
  now: Date,
  policies: Map<string, FlakePolicy>,
): Promise<boolean> {
  const { orgId, projectId, testId, investigationId } = group;
  const startedAt = group.runs[0]!.queuedAt;

  // Concluded already? The audit row is the record, and it is the only one.
  const decided = await prisma.auditLog.findFirst({
    where: {
      orgId,
      targetType: 'Test',
      targetId: testId,
      action: { in: Object.values(FLAKE_AUDIT_ACTIONS) },
      createdAt: { gte: startedAt },
    },
    select: { id: true },
  });
  if (decided) return false;

  const test = await prisma.test.findFirst({
    where: { id: testId, orgId },
    select: {
      id: true,
      name: true,
      priority: true,
      quarantined: true,
      quarantineReason: true,
      quarantineExpiresAt: true,
      disabledAt: true,
      filePath: true,
    },
  });

  const policy = await flakePolicyFor(projectId, policies);

  if (!test || test.disabledAt) {
    await concludeAbandoned(group, 'The test was deleted or disabled while it was being measured.');
    return false;
  }
  if (!policy.confirm) {
    await concludeAbandoned(
      group,
      'Flake confirmation was switched off for this project mid-investigation.',
    );
    return false;
  }

  const cancelled = group.runs.find((r) => r.status === 'CANCELLED');
  if (cancelled) {
    await concludeAbandoned(
      group,
      `A person cancelled confirmation run ${cancelled.id}, so the measurement is incomplete and nothing was decided.`,
    );
    return false;
  }

  const pending = group.runs.filter((r) => !TERMINAL.includes(r.status));
  if (pending.length > 0) {
    const deadline = new Date(startedAt.getTime() + policy.investigationDeadlineMinutes * 60_000);
    if (now > deadline) {
      // Stop the queued work too: an abandoned investigation must not leave runs
      // behind that execute hours later against a decision already written.
      await prisma.run.updateMany({
        where: {
          id: { in: pending.map((r) => r.id) },
          orgId,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        data: { status: 'CANCELLED', finishedAt: now },
      });
      await concludeAbandoned(
        group,
        `It did not finish within ${policy.investigationDeadlineMinutes} minutes, so it was abandoned and its remaining runs cancelled.`,
      );
      return false;
    }
    return true;
  }

  // Bounded: `samples` attempts, ever. Errored attempts are not retried — they
  // shrink the denominator instead, which pushes towards "not enough evidence".
  if (group.runs.length < policy.samples) {
    const sample = await queueSample(group, policy, group.runs.length + 1);
    if (sample && 'refused' in sample) {
      /*
       * The cap will not clear before this investigation's deadline, so waiting
       * on it would end in an abandonment whose stated reason was the timeout
       * rather than the truth. Say the truth now, in the audit row that is the
       * only record this investigation ever leaves.
       */
      await concludeAbandoned(
        group,
        `${sample.refused} The remaining confirmation runs were not started, so nothing was measured.`,
      );
      return false;
    }
    return true;
  }

  const samples: FlakeSample[] = group.runs.map((run) => {
    const result = run.results.find((r) => r.testId === testId) ?? null;
    return {
      runStatus: run.status,
      status: result?.status ?? null,
      retriedAndPassed: result?.retriedAndPassed ?? false,
    };
  });
  const measurement = measureSamples(samples);

  const [lastQuarantineAudit, realBug, budget] = await Promise.all([
    prisma.auditLog.findFirst({
      where: {
        orgId,
        targetType: 'Test',
        targetId: testId,
        action: {
          in: [
            ...MANUAL_QUARANTINE_ACTIONS,
            FLAKE_AUDIT_ACTIONS.quarantined,
            FLAKE_AUDIT_ACTIONS.released,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { action: true },
    }),
    findRecentRealBugVerdict(orgId, testId, policy, now),
    /*
     * "Already quarantined" means the suppression is IN FORCE, not that the
     * column is true. Renewing a quarantine that EXPIRED is a new suppression —
     * the test had started gating again — so it is charged to the budget like
     * any other. Passing the raw column here would have left a hole wide enough
     * to drive the whole feature through: a project over budget could renew its
     * expired quarantines forever and never be refused once.
     */
    quarantineBudgetFor(orgId, projectId, testId, quarantineSuppresses(test, now), now),
  ]);

  const decision = decideFlakeAction({
    policy,
    measurement,
    quarantined: test.quarantined,
    machineQuarantined: isMachineQuarantine({
      quarantineReason: test.quarantineReason,
      lastQuarantineAuditAction: lastQuarantineAudit?.action ?? null,
    }),
    priority: test.priority,
    realBugTriagedAt: realBug,
    ...(budget ? { budget } : {}),
  });

  await conclude(group, decision, measurement, policy, test.quarantined);
  logger.info(
    {
      testId,
      investigationId,
      action: decision.action,
      failed: measurement.failed,
      of: measurement.of,
    },
    'flake investigation concluded',
  );
  return false;
}

/**
 * The REAL_BUG veto.
 *
 * A human override beats the model, always — the same rule the quality gate
 * uses. A verdict a person overrode away from REAL_BUG does not veto, and one a
 * person overrode INTO REAL_BUG does.
 */
async function findRecentRealBugVerdict(
  orgId: string,
  testId: string,
  policy: FlakePolicy,
  now: Date,
): Promise<Date | null> {
  const since = new Date(now.getTime() - policy.realBugLookbackDays * 86_400_000);
  const verdict = await prisma.triageVerdict.findFirst({
    where: {
      orgId,
      createdAt: { gte: since },
      testResult: { testId },
      OR: [
        { reviewState: 'OVERRIDDEN', overriddenTo: 'REAL_BUG' },
        { reviewState: { not: 'OVERRIDDEN' }, verdict: 'REAL_BUG' },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return verdict?.createdAt ?? null;
}

/**
 * Create the next confirmation run and queue it behind everything else.
 *
 * Three outcomes. A run id; `null` for the ordinary "not now" — the project is
 * busy and the next tick is five minutes away; and `refused`, which is the org
 * being at its monthly run cap. The last one is worth distinguishing because it
 * will not clear on its own: an investigation waiting for it would sit open
 * until its deadline and then report itself abandoned for no stated reason, so
 * the caller ends it now and says why.
 */
type SampleOutcome = { runId: string } | { refused: string } | null;

async function queueSample(
  group: InvestigationGroup,
  policy: FlakePolicy,
  index: number,
): Promise<SampleOutcome> {
  const { orgId, projectId, environmentId, testId, investigationId } = group;

  /*
   * Yield to real work. A project already stacking up runs does not need ours in
   * the queue as well — the measurement is never urgent, and the next tick is
   * five minutes away. BullMQ's priority (see queues.ts) keeps a confirmation
   * run behind every unprioritised job; this keeps it out of the queue entirely.
   */
  const waiting = await prisma.run.count({
    where: {
      projectId,
      status: 'QUEUED',
      // `triggeredBy` is nullable, and `not: { startsWith }` in Prisma resolves
      // to NULL — so it silently DROPS every row with no trigger. Those rows are
      // the schedules and monitors, which is precisely the work we are trying to
      // yield to, so the null arm has to be spelled out.
      OR: [{ triggeredBy: null }, { triggeredBy: { not: { startsWith: FLAKE_RUN_PREFIX } } }],
    },
  });
  if (waiting >= policy.maxQueuedRunsBeforeYielding) {
    logger.debug(
      { projectId, waiting },
      'holding a flake confirmation run back; the project is busy',
    );
    return null;
  }

  /*
   * Gate, create, count — `advisory`, because this is a sweep: throwing here
   * would fail the whole flake tick for every other org sharing it, and it is
   * the caller's job to decide what a refused sample means for the measurement
   * in front of it.
   */
  const started = await startRun({
    db: prisma,
    orgId,
    mode: 'advisory',
    data: {
      orgId,
      projectId,
      environmentId,
      trigger: 'MANUAL',
      triggeredBy: investigationTag(testId, investigationId),
      totalCount: 1,
      results: { create: [{ orgId, testId, status: 'SKIPPED' as const }] },
    },
  });

  if (!started.created) {
    logger.warn(
      { testId, investigationId, orgId, sample: index, of: policy.samples },
      'flake confirmation run refused: the org is at its monthly run limit',
    );
    return { refused: started.quota.reason ?? 'This org is at its monthly run limit.' };
  }
  const run = started.run;

  try {
    await enqueueRun({ orgId, runId: run.id }, { background: true });
  } catch (err) {
    // A run row with no job would hold the investigation open until its
    // deadline. Mark it dead now so the sweep counts it as a discarded sample.
    await prisma.run
      .update({
        where: { id: run.id },
        data: {
          status: 'ERRORED',
          finishedAt: new Date(),
          errorMessage: 'The flake confirmation run could not be queued.',
        },
      })
      .catch(() => {});
    logger.error({ err, testId, runId: run.id }, 'could not queue a flake confirmation run');
    return null;
  }

  logger.info(
    { testId, investigationId, runId: run.id, sample: index, of: policy.samples },
    'queued a flake confirmation run',
  );
  return { runId: run.id };
}

/** Write the decision and its evidence, atomically. */
async function conclude(
  group: InvestigationGroup,
  decision: FlakeDecision,
  measurement: FlakeMeasurement,
  policy: FlakePolicy,
  alreadyQuarantined: boolean,
): Promise<void> {
  const { orgId, testId, investigationId } = group;
  const metadata = {
    investigationId,
    decision: decision.action,
    reason: decision.reason,
    measured: {
      failed: measurement.failed,
      of: measurement.of,
      ratePercent: Math.round(measurement.ratePercent * 10) / 10,
      discarded: measurement.discarded,
    },
    policy: {
      samples: policy.samples,
      minSamples: policy.minSamples,
      quarantineRatePercent: policy.quarantineRatePercent,
      releaseRatePercent: policy.releaseRatePercent,
    },
    runIds: group.runs.map((r) => r.id),
  };

  const auditRow = (action: string) => ({
    data: { orgId, userId: null, action, targetType: 'Test', targetId: testId, metadata },
  });

  if (decision.action === 'QUARANTINE') {
    const now = new Date();
    // One transaction: a quarantine whose audit row failed to write is a
    // suppressed signal nobody can explain, and it would also be re-decided on
    // every tick because the audit row is what marks an investigation closed.
    await prisma.$transaction([
      prisma.test.update({
        where: { id: testId },
        data: {
          quarantined: true,
          // Preserve the original date if something else quarantined it first;
          // the audit row records when the measurement landed.
          ...(alreadyQuarantined ? {} : { quarantinedAt: now }),
          quarantineReason: decision.reason,
          /*
           * The end date, always. Re-stamped even when the test was already
           * quarantined, and that is the point of re-measuring: a test this
           * investigation has just confirmed is still flaky has EARNED another
           * window, where one that is never looked at again runs out. Quarantine
           * is a loan that can be renewed on evidence, not a one-way door.
           */
          quarantineExpiresAt: quarantineExpiryFrom(now),
        },
      }),
      prisma.auditLog.create(auditRow(FLAKE_AUDIT_ACTIONS.quarantined)),
    ]);
    return;
  }

  if (decision.action === 'RELEASE') {
    await prisma.$transaction([
      prisma.test.update({
        where: { id: testId },
        // The reason is cleared with the quarantine. A stale "why it was
        // quarantined" on a test that is not quarantined is how the next reader
        // gets the story wrong.
        // The expiry goes with the quarantine, for the same reason the reason
        // does: a stale end date on a test that is not quarantined is how the
        // next reader gets the story wrong.
        data: {
          quarantined: false,
          quarantinedAt: null,
          quarantineReason: null,
          quarantineExpiresAt: null,
        },
      }),
      prisma.auditLog.create(auditRow(FLAKE_AUDIT_ACTIONS.released)),
    ]);
    return;
  }

  await prisma.auditLog.create(auditRow(FLAKE_AUDIT_ACTIONS.measured));
}

async function concludeAbandoned(group: InvestigationGroup, why: string): Promise<void> {
  await prisma.auditLog.create({
    data: {
      orgId: group.orgId,
      userId: null,
      action: FLAKE_AUDIT_ACTIONS.abandoned,
      targetType: 'Test',
      targetId: group.testId,
      metadata: {
        investigationId: group.investigationId,
        reason: why,
        runIds: group.runs.map((r) => r.id),
      },
    },
  });
  logger.info(
    { testId: group.testId, investigationId: group.investigationId, why },
    'flake investigation abandoned',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening new investigations.
// ─────────────────────────────────────────────────────────────────────────────

interface Candidate {
  testId: string;
  orgId: string;
  projectId: string;
  environmentId: string | null;
  why: string;
  /** A quarantined test is being measured for release, not for quarantine. */
  forRelease: boolean;
}

async function openInvestigations(
  now: Date,
  policies: Map<string, FlakePolicy>,
  active: ActiveInvestigations,
): Promise<void> {
  let capacity = MAX_CONCURRENT_INVESTIGATIONS - active.total;
  if (capacity <= 0) {
    logger.debug({ inFlight: active.total }, 'flake investigations are at capacity');
    return;
  }

  const candidates = [...(await suspectCandidates(now)), ...(await releaseCandidates())];

  for (const candidate of candidates) {
    if (capacity <= 0) break;
    if (active.tests.has(candidate.testId)) continue;
    // One investigation per project at a time: a project full of flaky tests
    // must not be able to fill the fleet's budget by itself.
    if ((active.byProject.get(candidate.projectId) ?? 0) > 0) continue;

    try {
      const opened = await openOne(candidate, now, policies);
      if (!opened) continue;
    } catch (err) {
      logger.error({ err, testId: candidate.testId }, 'could not open a flake investigation');
      continue;
    }

    capacity -= 1;
    active.total += 1;
    active.tests.add(candidate.testId);
    active.byProject.set(candidate.projectId, (active.byProject.get(candidate.projectId) ?? 0) + 1);
  }
}

async function openOne(
  candidate: Candidate,
  now: Date,
  policies: Map<string, FlakePolicy>,
): Promise<boolean> {
  const policy = await flakePolicyFor(candidate.projectId, policies);
  if (!policy.confirm) return false;

  const test = await prisma.test.findFirst({
    where: { id: candidate.testId, orgId: candidate.orgId },
    select: {
      id: true,
      name: true,
      filePath: true,
      disabledAt: true,
      quarantined: true,
      quarantineReason: true,
    },
  });
  // Fixtures are test data, not tests — they never run and never gate.
  if (!test || test.disabledAt || test.filePath.startsWith(FIXTURE_PREFIX)) return false;

  const environmentId = candidate.environmentId ?? (await lastEnvironmentFor(candidate));
  if (!environmentId) return false;

  if (candidate.forRelease && !test.quarantined) return false;
  if (!candidate.forRelease && test.quarantined) return false;

  // Cooldown, measured from the last thing we said about this test. A quarantined
  // test is re-measured on the slower recheck cadence; a suspect gets the
  // reinvestigate cooldown, so a permanently unstable test cannot re-open an
  // investigation every hour forever.
  const cooldownHours = candidate.forRelease
    ? policy.recheckQuarantinedAfterHours
    : policy.reinvestigateAfterHours;
  const recent = await prisma.auditLog.findFirst({
    where: {
      orgId: candidate.orgId,
      targetType: 'Test',
      targetId: candidate.testId,
      action: { in: Object.values(FLAKE_AUDIT_ACTIONS) },
      createdAt: { gte: new Date(now.getTime() - cooldownHours * 3_600_000) },
    },
    select: { id: true },
  });
  if (recent) return false;

  if (candidate.forRelease) {
    const lastQuarantineAudit = await prisma.auditLog.findFirst({
      where: {
        orgId: candidate.orgId,
        targetType: 'Test',
        targetId: candidate.testId,
        action: {
          in: [
            ...MANUAL_QUARANTINE_ACTIONS,
            FLAKE_AUDIT_ACTIONS.quarantined,
            FLAKE_AUDIT_ACTIONS.released,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { action: true },
    });
    // Nothing to release: a person's quarantine stays until a person lifts it,
    // so measuring it would burn runs on a decision we would never take.
    if (
      !isMachineQuarantine({
        quarantineReason: test.quarantineReason,
        lastQuarantineAuditAction: lastQuarantineAudit?.action ?? null,
      })
    ) {
      return false;
    }
  }

  const group: InvestigationGroup = {
    testId: candidate.testId,
    investigationId: randomUUID().slice(0, 8),
    orgId: candidate.orgId,
    projectId: candidate.projectId,
    environmentId,
    runs: [],
  };

  // Refused and busy both mean "not started"; queueSample has already said
  // which at warn, and an investigation that never opened leaves nothing behind
  // to correct.
  const sample = await queueSample(group, policy, 1);
  if (!sample || 'refused' in sample) return false;

  logger.info(
    {
      testId: candidate.testId,
      investigationId: group.investigationId,
      why: candidate.why,
      samples: policy.samples,
    },
    candidate.forRelease
      ? 'measuring a quarantined test to see whether it can be released'
      : 'confirming a suspected flake',
  );
  return true;
}

/** Tests that looked unstable in the recent past. */
async function suspectCandidates(now: Date): Promise<Candidate[]> {
  const rows = await prisma.testResult.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - SUSPECT_LOOKBACK_MINUTES * 60_000) } },
    orderBy: { createdAt: 'desc' },
    take: SUSPECT_SCAN_LIMIT,
    select: {
      testId: true,
      orgId: true,
      status: true,
      retriedAndPassed: true,
      run: { select: { projectId: true, environmentId: true, triggeredBy: true } },
    },
  });

  return findSuspects(
    rows.map((row) => ({
      testId: row.testId,
      orgId: row.orgId,
      projectId: row.run.projectId,
      environmentId: row.run.environmentId,
      status: row.status,
      retriedAndPassed: row.retriedAndPassed,
      fromConfirmationRun:
        parseInvestigationTag(row.run.triggeredBy) !== null ||
        parseVerificationRunTag(row.run.triggeredBy) !== null,
    })),
  ).map((suspect) => ({ ...suspect, forRelease: false }));
}

/**
 * Quarantined tests, re-measured so quarantine is not a one-way door.
 *
 * A test that stopped gating and was never looked at again is how a suite
 * quietly stops testing anything.
 */
async function releaseCandidates(): Promise<Candidate[]> {
  const tests = await prisma.test.findMany({
    where: { quarantined: true, disabledAt: null },
    orderBy: { quarantinedAt: 'asc' },
    take: RELEASE_SCAN_LIMIT,
    select: { id: true, orgId: true, projectId: true },
  });

  return tests.map((test) => ({
    testId: test.id,
    orgId: test.orgId,
    projectId: test.projectId,
    environmentId: null,
    why: 'it is quarantined and due to be re-measured',
    forRelease: true,
  }));
}

/** The environment a test last ran in — the one a re-run must reproduce. */
async function lastEnvironmentFor(candidate: Candidate): Promise<string | null> {
  const last = await prisma.testResult.findFirst({
    where: { testId: candidate.testId, orgId: candidate.orgId },
    orderBy: { createdAt: 'desc' },
    select: { run: { select: { environmentId: true } } },
  });
  return last?.run.environmentId ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-project policy.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether `Project.flakePolicy` exists yet, probed once per process.
 *
 * The column is not in the schema at the time of writing — that migration
 * belongs to whoever owns schema.prisma — so this reads it only if it is there
 * and falls back to the conservative defaults if it is not. The moment the
 * column lands, per-project policy starts working with no code change; until
 * then every project gets the same defaults, which is the honest behaviour
 * rather than a knob that silently does nothing.
 */
let policyColumnExists: boolean | null = null;

async function flakePolicyFor(
  projectId: string,
  cache: Map<string, FlakePolicy>,
): Promise<FlakePolicy> {
  const cached = cache.get(projectId);
  if (cached) return cached;

  let policy = FLAKE_POLICY_DEFAULTS;
  try {
    if (policyColumnExists === null) {
      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        select column_name from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'Project'
           and column_name = 'flakePolicy'`;
      policyColumnExists = columns.length > 0;
      if (!policyColumnExists) {
        logger.info(
          'Project.flakePolicy does not exist yet; every project uses the default flake policy',
        );
      }
    }

    if (policyColumnExists) {
      const rows = await prisma.$queryRaw<Array<{ flakePolicy: unknown }>>`
        select "flakePolicy" from "Project" where id = ${projectId}`;
      policy = resolveFlakePolicy(rows[0]?.flakePolicy);
    }
  } catch (err) {
    // Defaults are conservative, so a policy we cannot read costs caution, not
    // safety. Loud, because a project that configured a policy is entitled to it.
    logger.warn({ err, projectId }, 'could not read the project flake policy; using the defaults');
  }

  cache.set(projectId, policy);
  return policy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verifying a heal that was applied.
//
// `HealProposal.state = 'APPLIED'` used to be a claim nobody checked. Both apply
// paths wrote the patched code, wrote a TestVersion, flipped the state, and
// never ran the test again — so a heal that applied cleanly, parsed, kept every
// assertion and fixed NOTHING was recorded as applied, and the next human to
// look saw a handled problem where there was a red test. That is worse than no
// healing: an unhealed failure at least stays on the board.
//
// The apply paths start the run (they are the ones holding the environment and
// the plan toll); this sweep is what reads it back. Same division as the flake
// investigations above, and for the same reason: a worker restart must not lose
// the answer.
// ─────────────────────────────────────────────────────────────────────────────

interface PendingVerification {
  id: string;
  orgId: string;
  testId: string;
  state: string;
  verifyRunId: string | null;
  appliedVersion: number | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export async function verifyAppliedHeals(now: Date): Promise<void> {
  /*
   * Served by HealProposal(verifyState), added in
   * 20261024051000_heal_verification_and_supersede. The overwhelming majority of
   * rows have the column NULL — nobody applied them — so the PENDING set this
   * reads is tiny however many proposals the install has ever made.
   */
  const pending = (await prisma.healProposal.findMany({
    where: { verifyState: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: HEAL_VERIFY_SCAN_LIMIT,
    select: {
      id: true,
      orgId: true,
      testId: true,
      state: true,
      verifyRunId: true,
      appliedVersion: true,
      decidedAt: true,
      createdAt: true,
    },
  })) as PendingVerification[];

  for (const heal of pending) {
    try {
      await advanceVerification(heal, now);
    } catch (err) {
      // One heal's verification must never stop the sweep for every other org.
      // Nothing was written, so the row stays PENDING and the next tick retries.
      logger.error({ err, healId: heal.id }, 'could not advance a heal verification');
    }
  }
}

/**
 * Read the verifying run back and write the verdict, for ONE pending heal.
 *
 * NULL means NOTHING WAS WRITTEN: the run has not reached a terminal status and
 * is still inside its deadline, which is not an outcome. It is distinct from
 * every `VerificationWrite` — including the UNVERIFIABLE ones — because "still
 * running" and "we could not look" are different facts about the same heal, and
 * a caller that collapsed them would report a verification as concluded while
 * its run was still executing.
 */
async function advanceVerification(
  heal: PendingVerification,
  now: Date,
): Promise<VerificationWrite | null> {
  const startedAt = heal.decidedAt ?? heal.createdAt;

  const run = heal.verifyRunId
    ? await prisma.run.findFirst({
        where: { id: heal.verifyRunId, orgId: heal.orgId },
        select: {
          id: true,
          status: true,
          results: {
            where: { testId: heal.testId },
            select: { status: true, retriedAndPassed: true },
          },
        },
      })
    : null;

  /*
   * No run at all. Either the apply path recorded PENDING without an id — which
   * would be a bug, and this is how it becomes visible rather than a row stuck
   * PENDING forever — or a person deleted the run. Both are "nobody checked",
   * which is the answer this feature exists to be able to give.
   */
  if (!run) {
    return await recordVerification(heal, now, {
      state: 'UNVERIFIABLE',
      revert: false,
      passedOnRetry: false,
      note: heal.verifyRunId
        ? `The heal was applied and nobody has confirmed it works: the run that was checking it (${heal.verifyRunId}) is gone. The test has NOT been shown to pass — re-run it.`
        : 'The heal was applied and no verifying run was ever started, so nobody has confirmed it works. The test has NOT been shown to pass — re-run it.',
    });
  }

  if (!TERMINAL.includes(run.status)) {
    const deadline = new Date(startedAt.getTime() + HEAL_VERIFY_DEADLINE_MINUTES * 60_000);
    // Nothing written, and that is the honest answer: the run is still going.
    if (now <= deadline) return null;

    // Stop the queued work too: a verification nobody is waiting on any more
    // must not execute hours later against a verdict already written.
    await prisma.run
      .updateMany({
        where: { id: run.id, orgId: heal.orgId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'CANCELLED', finishedAt: now },
      })
      .catch(() => {});

    return await recordVerification(heal, now, {
      state: 'UNVERIFIABLE',
      revert: false,
      passedOnRetry: false,
      note:
        `The heal was applied and nobody has confirmed it works: the verifying run did not finish ` +
        `within ${HEAL_VERIFY_DEADLINE_MINUTES} minutes and was cancelled. The test has NOT been ` +
        `shown to pass — re-run it.`,
    });
  }

  const result = run.results[0] ?? null;
  const outcome = decideVerification({
    healState: heal.state,
    runStatus: run.status,
    resultStatus: result?.status ?? null,
    retriedAndPassed: result?.retriedAndPassed ?? false,
    appliedVersion: heal.appliedVersion,
  });

  return await recordVerification(heal, now, outcome);
}

/**
 * What {@link recordVerification} ACTUALLY DID, returned rather than only
 * logged.
 *
 * ── WHY THIS IS A RETURN VALUE AND NOT A LOG LINE ──────────────────────────
 *
 * `reverted` was a local variable. The only assertion anywhere that a revert
 * had happened was `processVerifyHeal`'s, against a FAKE recorder that was told
 * what to say — so the one write in this product that CHANGES A CUSTOMER'S TEST
 * BEHIND THEIR BACK was pinned nowhere against the code that performs it. A
 * rollback nobody has watched is a rollback.
 *
 * THREE FIELDS AND NOT ONE, because `reverted: false` has three distinct
 * causes and a caller that needed to tell them apart had to re-derive the rules:
 *
 *   · the decision never asked for a revert (a human approved this heal);
 *   · it asked and the history could not support it (`revertRefusal`);
 *   · it asked and it happened (`revertedToVersion` names the version restored,
 *     and `appendedVersion` the NEW version row the restore was appended as —
 *     append, never rewind).
 *
 * `revertedToVersion` is NULL and never 0 when nothing was restored: version 0
 * does not exist, and a zero here would name a version to a reader with
 * confidence.
 */
export interface VerificationWrite {
  readonly state: HealVerifyState;
  /** TRUE only when a new TestVersion carrying the previous code was written. */
  readonly reverted: boolean;
  /** The version whose code was restored. Null when nothing was restored. */
  readonly revertedToVersion: number | null;
  /** The version number the restore was APPENDED as. Null when nothing was. */
  readonly appendedVersion: number | null;
  /**
   * Why a revert the decision asked for did not happen. Null when none was
   * asked for, and null when one happened.
   *
   * A revert that was wanted and refused is a cap that bit: the patch is still
   * in the customer's test, and the reason has to travel with the count.
   */
  readonly revertRefusal: 'NO_PREDECESSOR_VERSION' | null;
  /** The sentence written to `verifyNote`, after any refusal was appended. */
  readonly note: string;
}

/**
 * Write the verdict, and the revert when there is one, atomically.
 *
 * A revert whose audit row failed to write is a change to the customer's test
 * that nobody can explain; a proposal whose state flipped without the code
 * moving is a lie in the other direction. One transaction, like the quarantine
 * flip above.
 *
 * EXPORTED, because this is the ONE implementation of "what does a verification
 * do to the customer's code" and `processors/verify-heal.ts` now reaches it
 * through {@link healVerificationPorts} rather than carrying a second copy. Two
 * implementations of that question is how a product comes to tell a customer
 * two different answers about the same heal.
 */
export async function recordVerification(
  heal: PendingVerification,
  now: Date,
  outcome: ReturnType<typeof decideVerification>,
): Promise<VerificationWrite> {
  let note = outcome.note;
  let reverting = outcome.revert;
  let restored: { code: string; version: number } | null = null;
  let revertRefusal: VerificationWrite['revertRefusal'] = null;

  if (reverting && heal.appliedVersion !== null) {
    const previous = await prisma.testVersion.findFirst({
      where: { testId: heal.testId, version: heal.appliedVersion - 1 },
      select: { code: true, version: true },
    });
    if (previous) restored = previous;
    else {
      /*
       * The decision said revert and the history cannot support it. Writing
       * "whatever came before", guessed, could put a version of the test in the
       * customer's repository that this heal never replaced — so the patch
       * stays and the note says so, loudly, instead.
       */
      reverting = false;
      revertRefusal = 'NO_PREDECESSOR_VERSION';
      note = `${note} In the event it could NOT be reverted: version ${heal.appliedVersion - 1} is not in this test's history. Revert it by hand.`;
    }
  }

  const action = reverting
    ? HEAL_AUDIT_ACTIONS.reverted
    : outcome.state === 'VERIFIED'
      ? HEAL_AUDIT_ACTIONS.verified
      : outcome.state === 'UNVERIFIABLE'
        ? HEAL_AUDIT_ACTIONS.unverifiable
        : HEAL_AUDIT_ACTIONS.verificationFailed;

  const writes: unknown[] = [
    prisma.healProposal.update({
      where: { id: heal.id },
      /*
       * `state` is deliberately NOT touched, on either path.
       *
       * A reverted proposal keeps AUTO_APPLIED — it WAS auto-applied, and that
       * is what happened — rather than going back to PROPOSED. Putting it back
       * in the review queue would offer a human a fix we now have evidence does
       * not work, which is how a product recommends the same wrong answer
       * forever. The next triage proposes afresh instead; `shouldProposeHeal`
       * only ever reuses an OPEN proposal.
       */
      data: { verifyState: outcome.state, verifiedAt: now, verifyNote: note },
    }),
    prisma.auditLog.create({
      data: {
        orgId: heal.orgId,
        userId: null,
        action,
        targetType: 'HealProposal',
        targetId: heal.id,
        metadata: {
          testId: heal.testId,
          healState: heal.state,
          verifyState: outcome.state,
          reverted: reverting,
          revertedToVersion: restored?.version ?? null,
          passedOnRetry: outcome.passedOnRetry,
          runId: heal.verifyRunId,
          note,
        },
      },
    }),
  ];

  let appendedVersion: number | null = null;
  if (reverting && restored) {
    const latest = await prisma.testVersion.findFirst({
      where: { testId: heal.testId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    appendedVersion = (latest?.version ?? restored.version) + 1;
    writes.push(
      prisma.test.update({
        where: { id: heal.testId },
        data: {
          code: restored.code,
          /*
           * Append, never rewind. The reverted code goes in as a NEW version
           * rather than deleting the heal's version row: the history of what was
           * written to a customer's test is not ours to edit, and "what did QAAI
           * do to this test and when" is the question asked after exactly this
           * kind of incident.
           */
          versions: {
            create: {
              orgId: heal.orgId,
              version: appendedVersion,
              code: restored.code,
              source: 'HEALER',
              message: `Reverted an auto-applied heal that failed verification, back to version ${restored.version}. ${note}`.slice(
                0,
                2_000,
              ),
            },
          },
        },
      }),
    );
  }

  await prisma.$transaction(writes as never);

  logger.info(
    {
      healId: heal.id,
      testId: heal.testId,
      verifyState: outcome.state,
      reverted: reverting,
      /*
       * The two numbers, as FIELDS. "Reverted" alone cannot answer "to what",
       * which is the first question asked when somebody notices their test
       * changed — and `appendedVersion` is the proof that the restore was
       * APPENDED rather than rewinding the history.
       */
      revertedToVersion: restored?.version ?? null,
      appendedVersion,
      revertRefusal,
    },
    'heal verification recorded',
  );

  return {
    state: outcome.state,
    reverted: reverting,
    revertedToVersion: restored?.version ?? null,
    appendedVersion,
    revertRefusal,
    note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The heal nothing would ever have checked, and the ports the queue reaches
// this file's write through.
//
// `verifyAppliedHeals` above scans `where: { verifyState: 'PENDING' }`. Both
// apply paths document that a crash between the code transaction and the
// verification start leaves the column NULL — honest about what happened, and
// it means the patch is in the customer's test with NOTHING that will ever
// re-measure it, INVISIBLE to the one sweep that looks. `needsVerificationStart`
// (processors/verify-heal.ts) is the predicate that finds those rows;
// `startVerificationHoles` is the query, and the job it enqueues is what starts
// the run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far back the hole sweep looks for an applied heal with no verification
 * state.
 *
 * A BOUND, and it is disclosed. There is no index on `HealProposal.decidedAt`,
 * so this is a window over the `verifyState` index's NULL section rather than a
 * seek — which is survivable at this cadence and is stated in the sweep's own
 * log line rather than left for somebody to discover. A heal applied longer ago
 * than this and never verified stays unverified: that is a gap, not a pass, and
 * the count below says so.
 */
export const HEAL_VERIFY_START_LOOKBACK_DAYS = 7;

/** Ceiling on one hole sweep, so one install cannot hold the tick open. */
const HEAL_VERIFY_HOLE_SCAN_LIMIT = 50;

export interface VerificationHoleSweep {
  /** Rows the query returned inside the window. */
  readonly scanned: number;
  /** Jobs enqueued — one per heal, de-duplicated by the per-heal job id. */
  readonly enqueued: number;
  /**
   * TRUE when {@link HEAL_VERIFY_HOLE_SCAN_LIMIT} bit, so `scanned` is a FLOOR.
   *
   * A cap applied without being disclosed is one of the lies this product
   * cannot afford, and the reason reported is the one that actually bit.
   */
  readonly capped: boolean;
  /** Why each row the query returned was not enqueued, counted by reason. */
  readonly refusals: Partial<Record<StartRefusal, number>>;
  /** Enqueues that threw. The row stays NULL and the next tick retries it. */
  readonly failed: number;
}

/**
 * Find the applied heals nothing is going to check, and ask for one each.
 *
 * It ENQUEUES rather than starting the run inline, for the reason the apply
 * paths give for starting outside their own transaction: a start is a plan toll,
 * a Run row and a queue write, and a tick that did fifty of those inline would
 * hold the one lane every org's flake measurement shares. The job id is per
 * heal, so a hole still open on the next tick collapses onto the one job
 * instead of starting a second run for the same patch.
 */
export async function startVerificationHoles(now: Date): Promise<VerificationHoleSweep> {
  const since = new Date(now.getTime() - HEAL_VERIFY_START_LOOKBACK_DAYS * 24 * 60 * 60_000);
  const rows = await prisma.healProposal.findMany({
    where: {
      verifyState: null,
      state: { in: ['APPLIED', 'AUTO_APPLIED'] },
      decidedAt: { gte: since },
    },
    orderBy: { decidedAt: 'asc' },
    take: HEAL_VERIFY_HOLE_SCAN_LIMIT + 1,
    select: { id: true, orgId: true, state: true, verifyState: true, decidedAt: true },
  });

  const capped = rows.length > HEAL_VERIFY_HOLE_SCAN_LIMIT;
  const scanned = capped ? HEAL_VERIFY_HOLE_SCAN_LIMIT : rows.length;
  const refusals: Partial<Record<StartRefusal, number>> = {};
  let enqueued = 0;
  let failed = 0;

  for (const heal of rows.slice(0, scanned)) {
    /*
     * The predicate and not an inline condition, so this sweep and the processor
     * agree about what a hole IS — including the grace period, without which
     * every heal would get a second verification started the moment it was
     * applied, racing the apply path's own.
     */
    const need = needsVerificationStart(heal, now);
    if (!need.start) {
      refusals[need.refusal] = (refusals[need.refusal] ?? 0) + 1;
      continue;
    }
    try {
      await enqueueVerifyHeal({ orgId: heal.orgId, healId: heal.id, reason: 'SWEEP_FOUND_NO_START' });
      enqueued += 1;
    } catch (err) {
      // Nothing was written, so the row stays NULL and the next tick retries.
      // One org's Redis blip must not stop the sweep for every other org.
      failed += 1;
      logger.error({ err, healId: heal.id }, 'could not queue a heal verification start');
    }
  }

  logger.info(
    {
      scanned,
      enqueued,
      capped,
      failed,
      refusals,
      lookbackDays: HEAL_VERIFY_START_LOOKBACK_DAYS,
      /*
       * The cap AND the reason, in the same line. `scanned` is a floor when
       * `capped` is true, and a reader who saw only the number would read a
       * truncated sweep as a complete one.
       */
      cappedAt: capped ? HEAL_VERIFY_HOLE_SCAN_LIMIT : null,
    },
    capped
      ? `${enqueued} applied heal(s) had no verification started; the sweep stopped at ${HEAL_VERIFY_HOLE_SCAN_LIMIT} and the rest are picked up next tick`
      : `${enqueued} applied heal(s) had no verification started`,
  );

  return { scanned, enqueued, capped, refusals, failed };
}

/**
 * The production ports `processVerifyHeal` runs over.
 *
 * ── WHY THIS LIVES HERE AND NOT IN verify-heal.ts ──────────────────────────
 *
 * Everything it needs is already imported by THIS file — `prisma`, `logger`,
 * `enqueueRun`, and `startRun` from the API's lib, which is the one toll every
 * path that creates a Run goes through. verify-heal.ts deliberately imports
 * none of them: that is what lets its tests run with no database, no queue and
 * no network, and adding them there would also have meant a new relative
 * cross-workspace import.
 *
 * `recorder` is the load-bearing one. It is `advanceVerification` above —
 * decide, write the state, write the audit row, append the revert, in one
 * transaction — so the queue path and this file's own sweep share ONE
 * implementation of "what does a verification mean and what does it do to the
 * customer's code". Two implementations of that is how a product tells a
 * customer two different answers about the same heal.
 */
export function healVerificationPorts(): {
  store: VerifyHealStore;
  runs: RunStarter;
  queue: RunEnqueuer;
  recorder: VerificationRecorder;
  log: VerifyLog;
} {
  const store: VerifyHealStore = {
    async loadHeal({ orgId, healId }) {
      return await prisma.healProposal.findFirst({
        where: { id: healId, orgId },
        select: {
          id: true,
          orgId: true,
          testId: true,
          state: true,
          verifyState: true,
          verifyRunId: true,
          appliedVersion: true,
          decidedAt: true,
          createdAt: true,
          // The project is on the TEST, not the proposal: a verification run is
          // a Run, and a Run needs a project. Two reads would be two chances for
          // the test to have been deleted in between.
          test: { select: { projectId: true } },
        },
      }).then((row) =>
        row === null ? null : { ...row, projectId: row.test.projectId },
      );
    },
    async lastEnvironmentFor({ orgId, testId }) {
      // The environment the test last ran in — the one a re-run must reproduce.
      // Same rule as the flake radar's confirmation runs above.
      const last = await prisma.testResult.findFirst({
        where: { testId, orgId },
        orderBy: { createdAt: 'desc' },
        select: { run: { select: { environmentId: true } } },
      });
      return last === null ? null : { environmentId: last.run.environmentId };
    },
    async abandonRun({ runId, reason }) {
      await prisma.run.update({
        where: { id: runId },
        data: { status: 'ERRORED', finishedAt: new Date(), errorMessage: reason },
      });
    },
    async recordStart({ healId, verifyRunId, verifyState, verifyNote, verifiedAt }) {
      await prisma.healProposal.update({
        where: { id: healId },
        data: { verifyRunId, verifyState, verifyNote, verifiedAt },
      });
    },
  };

  const runs: RunStarter = {
    async start({ orgId, projectId, environmentId, testId, triggeredBy }) {
      /*
       * `advisory`, because this is a background path: throwing on a plan limit
       * would fail the job over a run we are willing to record as unchecked,
       * and "applied, nobody checked, here is why" is a true sentence while "we
       * could not apply your fix because of your plan" is a worse product.
       */
      const started = await startRun({
        db: prisma,
        orgId,
        mode: 'advisory',
        data: {
          orgId,
          projectId,
          environmentId,
          trigger: 'MANUAL',
          triggeredBy,
          totalCount: 1,
          // One placeholder result: the run processor executes exactly the tests
          // its result rows name, which is how a single-test run is expressed.
          results: { create: [{ orgId, testId, status: 'SKIPPED' as const }] },
        },
      });
      return started.created
        ? { created: true, runId: started.run.id }
        : { created: false, reason: started.quota.reason ?? null };
    },
  };

  const queue: RunEnqueuer = {
    async enqueue({ orgId, runId }) {
      await enqueueRun({ orgId, runId }, { background: true });
    },
  };

  const recorder: VerificationRecorder = {
    async record(args) {
      const write = await advanceVerification(
        {
          id: args.healId,
          orgId: args.orgId,
          testId: args.testId,
          state: args.healState,
          verifyRunId: args.verifyRunId,
          appliedVersion: args.appliedVersion,
          decidedAt: args.decidedAt,
          createdAt: args.createdAt,
        },
        args.now,
      );
      /*
       * NULL IS "NOTHING WAS WRITTEN", and it is reported as such rather than
       * as a PENDING outcome: the run has not finished and is still inside its
       * deadline. `wrote: false` is what keeps the caller from logging a
       * verification as re-measured when nothing was measured.
       */
      return write === null
        ? { wrote: false, state: 'PENDING', reverted: false, revertedToVersion: null }
        : {
            wrote: true,
            state: write.state,
            reverted: write.reverted,
            revertedToVersion: write.revertedToVersion,
          };
    },
  };

  return { store, runs, queue, recorder, log: logger };
}

// ─────────────────────────────────────────────────────────────────────────────
// Turning a FLAKE verdict into a repair.
//
// Triage could say FLAKE and the only machinery downstream of that word was
// quarantine, which stops the test gating and leaves the flake exactly where it
// was. This sweep is the other half: for each recently-flagged flake, ask
// `proposeDeflake` for the repair and put it where a person can accept it.
//
// The analysis calls NO MODEL. A fixed sleep and an un-awaited action are
// deterministic findings with deterministic fixes, and everything else is
// reported as named-but-not-patched rather than guessed at — see
// packages/agent/src/deflake.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Open proposals for one test, in the shape the lifecycle rules want. */
async function openHealsFor(orgId: string, testId: string): Promise<OpenHeal[]> {
  return await prisma.healProposal.findMany({
    where: { orgId, testId, state: { in: ['PROPOSED', 'APPROVED'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, state: true, riskLevel: true, diff: true, createdAt: true },
  });
}

interface FlakeVerdictRow {
  id: string;
  orgId: string;
  explanation: string;
  testResult: { testId: string; errorMessage: string | null };
}

export async function deflakeSweep(now: Date): Promise<void> {
  const since = new Date(now.getTime() - DEFLAKE_VERDICT_LOOKBACK_HOURS * 3_600_000);

  /*
   * A human override beats the model, in both directions — the same rule
   * `findRecentRealBugVerdict` applies above. A verdict somebody overrode AWAY
   * from FLAKE is not a flake, and one overridden INTO FLAKE is.
   */
  const verdicts = (await prisma.triageVerdict.findMany({
    where: {
      createdAt: { gte: since },
      OR: [
        { reviewState: 'OVERRIDDEN', overriddenTo: 'FLAKE' },
        { reviewState: { not: 'OVERRIDDEN' }, verdict: 'FLAKE' },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: DEFLAKE_SCAN_LIMIT,
    select: {
      id: true,
      orgId: true,
      explanation: true,
      testResult: { select: { testId: true, errorMessage: true } },
    },
  })) as FlakeVerdictRow[];

  const seen = new Set<string>();
  let budget = DEFLAKE_PROPOSALS_PER_TICK;

  for (const verdict of verdicts) {
    if (budget <= 0) break;
    const testId = verdict.testResult.testId;
    // Newest verdict per test only: the older ones describe the same test.
    if (seen.has(testId)) continue;
    seen.add(testId);

    try {
      if (await deflakeOne(verdict, now)) budget -= 1;
    } catch (err) {
      logger.error({ err, testId, verdictId: verdict.id }, 'could not propose a deflake');
    }
  }
}

/** @returns true when something was written (a proposal or an honest refusal). */
async function deflakeOne(verdict: FlakeVerdictRow, now: Date): Promise<boolean> {
  const { orgId } = verdict;
  const testId = verdict.testResult.testId;

  /*
   * The cooldown, and it covers the UNFIXABLE answer as much as the fixable
   * one. "QAAI looked and has no automatic fix" is worth recording once, not
   * once every five minutes for as long as the test keeps failing.
   */
  const recent = await prisma.auditLog.findFirst({
    where: {
      orgId,
      targetType: 'Test',
      targetId: testId,
      action: { in: [HEAL_AUDIT_ACTIONS.deflakeProposed, HEAL_AUDIT_ACTIONS.deflakeUnfixable] },
      createdAt: { gte: new Date(now.getTime() - DEFLAKE_RETRY_HOURS * 3_600_000) },
    },
    select: { id: true },
  });
  if (recent) return false;

  const test = await prisma.test.findFirst({
    where: { id: testId, orgId },
    select: {
      id: true,
      name: true,
      filePath: true,
      code: true,
      disabledAt: true,
      projectId: true,
    },
  });
  // Fixtures are test data, not tests — they never run and never gate.
  if (!test || test.disabledAt || test.filePath.startsWith(FIXTURE_PREFIX)) return false;

  const openHeals = await openHealsFor(orgId, testId);
  const decision = shouldProposeHeal({
    openHeals,
    currentCode: test.code,
    filePath: test.filePath,
  });
  if (!decision.propose) {
    // The per-TEST guard. Without it one permanently flaky test would mint a
    // fresh proposal on every tick and fill the review queue by itself.
    logger.debug({ testId, reuseId: decision.reuseId }, 'skipping a deflake proposal');
    return false;
  }

  const proposal = proposeDeflake({
    testName: test.name,
    filePath: test.filePath,
    code: test.code,
    evidence: {
      verdictExplanation: verdict.explanation,
      failureMessage: verdict.testResult.errorMessage,
    },
  });

  const findings = proposal.findings.map((finding) => ({
    kind: finding.kind,
    line: finding.line,
    quote: finding.quote,
    why: finding.why,
    repair: finding.repair,
    patched: finding.patched,
  }));

  if (!proposal.fixable) {
    /*
     * No HealProposal row, and that is the deliberate choice: a proposal with
     * an empty diff is a row in a review queue with a dead Approve button. The
     * finding is recorded in the audit log — the same place every other
     * decision this file makes is recorded — so "QAAI analysed this flake and
     * had no automatic fix, for this reason" is answerable, rather than being
     * silently absent.
     */
    await prisma.auditLog.create({
      data: {
        orgId,
        userId: null,
        action: HEAL_AUDIT_ACTIONS.deflakeUnfixable,
        targetType: 'Test',
        targetId: testId,
        metadata: {
          verdictId: verdict.id,
          reason: proposal.unfixableReason,
          explanation: proposal.explanation,
          recommendations: proposal.recommendations,
          dialect: proposal.dialect,
          findings,
        },
      },
    });
    logger.info(
      { testId, reason: proposal.unfixableReason, findings: findings.length },
      'deflake analysed with no automatic fix',
    );
    return true;
  }

  /*
   * The id is minted here rather than by the database so the new row and the
   * supersede that points at it can be written in ONE transaction. A proposal
   * whose siblings were not closed is a review queue with two rows for one
   * test, which is the defect this supersede exists to fix.
   */
  const healId = randomUUID();
  const plan = planSupersede({
    incomingId: healId,
    incomingRiskLevel: proposal.riskLevel,
    // Only the proposals the guard above called STALE. An open patch that still
    // applies is a fix for a different problem on the same test, and closing it
    // would throw away work nobody reviewed.
    openHeals: openHeals.filter((heal) => decision.staleIds.includes(heal.id)),
  });

  await prisma.$transaction([
    prisma.healProposal.create({
      data: {
        id: healId,
        orgId,
        testId,
        verdictId: verdict.id,
        diff: proposal.diff,
        explanation: proposal.explanation,
        // STRUCTURAL, always: a deflake rewrites how a test waits, which is
        // never selector-only and so never eligible for unattended apply.
        riskLevel: 'STRUCTURAL',
        confidence: proposal.confidence,
        evidence: {
          kind: 'DEFLAKE',
          findings,
          recommendations: proposal.recommendations,
          assertionsBefore: proposal.assertionsBefore,
          assertionsAfter: proposal.assertionsAfter,
          dialect: proposal.dialect,
        },
      },
    }),
    prisma.healProposal.updateMany({
      where: { id: { in: plan.ids } },
      data: { state: 'SUPERSEDED', supersededById: healId, decidedAt: now },
    }),
    prisma.auditLog.create({
      data: {
        orgId,
        userId: null,
        action: HEAL_AUDIT_ACTIONS.deflakeProposed,
        targetType: 'Test',
        targetId: testId,
        metadata: {
          healId,
          verdictId: verdict.id,
          confidence: proposal.confidence,
          superseded: plan.ids,
          supersedeReason: plan.reason,
          assertionsBefore: proposal.assertionsBefore,
          assertionsAfter: proposal.assertionsAfter,
          findings,
        },
      },
    }),
  ]);

  logger.info(
    { testId, healId, confidence: proposal.confidence, superseded: plan.ids.length },
    'proposed a deflake fix',
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pre-failure drift check, and retirement proposals.
//
// The Explorer re-crawls and knows, that instant, which locators a test uses
// that the application no longer shows. Nothing looked — so every rename cost a
// failing CI run, a triage call and a heal proposal before anyone heard about
// it, when the information was in the flow map before the run started.
//
// Keyed on the FlowMap ROW ID, so this runs exactly once per crawl however often
// the tick fires. The audit row IS the state, like everything else in this file.
// ─────────────────────────────────────────────────────────────────────────────

interface CrawlRow {
  id: string;
  orgId: string;
  projectId: string;
  version: number;
  graph: unknown;
  truncatedReason: string | null;
  acceptance: CrawlAcceptanceState | null;
  acceptanceReason: string | null;
}

/**
 * Takes no clock, unlike its two siblings: nothing here is time-based. A crawl
 * is checked exactly once — the audit row keyed on the FlowMap id is the only
 * state — so there is no window, no deadline and no cooldown to measure.
 *
 * WHAT IT LOSES, stated because it is a real limitation: the scan reads the
 * `DRIFT_FLOWMAP_SCAN_LIMIT` most recent flow maps across the whole install. On
 * an install where more than that many crawls land between two ticks, a quiet
 * project's crawl can be pushed out of the window and never checked. The fix is
 * for processors/explore.ts to call this (or its per-project equivalent) when a
 * crawl finishes, which is where this belongs anyway — see the tick.
 */
export async function driftSweep(): Promise<void> {
  const crawls = (await prisma.flowMap.findMany({
    orderBy: { createdAt: 'desc' },
    take: DRIFT_FLOWMAP_SCAN_LIMIT,
    select: {
      id: true,
      orgId: true,
      projectId: true,
      version: true,
      graph: true,
      truncatedReason: true,
      acceptance: true,
      acceptanceReason: true,
    },
  })) as CrawlRow[];

  // Newest per project. A project that re-crawled twice between ticks is
  // compared against the newer crawl only — the older one's answer is stale by
  // definition, and spending the comparison on it would be spending it on a
  // question nobody asked.
  const newest = new Map<string, CrawlRow>();
  for (const crawl of crawls) if (!newest.has(crawl.projectId)) newest.set(crawl.projectId, crawl);

  for (const crawl of newest.values()) {
    try {
      await driftOne(crawl);
    } catch (err) {
      logger.error(
        { err, projectId: crawl.projectId, flowMapId: crawl.id },
        'could not check a project for drift',
      );
    }
  }
}

async function driftOne(crawl: CrawlRow): Promise<void> {
  const already = await prisma.auditLog.findFirst({
    where: {
      orgId: crawl.orgId,
      targetType: 'FlowMap',
      targetId: crawl.id,
      action: HEAL_AUDIT_ACTIONS.driftChecked,
    },
    select: { id: true },
  });
  if (already) return;

  const testRows = await prisma.test.findMany({
    where: { orgId: crawl.orgId, projectId: crawl.projectId, disabledAt: null },
    orderBy: { createdAt: 'asc' },
    // One over the cap, so the audit row can state that more exist rather than
    // reporting `testsCompared` as though it were the project's whole suite.
    take: DRIFT_TEST_SCAN_LIMIT + 1,
    select: {
      id: true,
      name: true,
      filePath: true,
      type: true,
      priority: true,
      feature: true,
      tags: true,
      code: true,
      spec: true,
      flakeRate: true,
      quarantined: true,
      consecutiveFailures: true,
    },
  });
  const testsTruncated = testRows.length > DRIFT_TEST_SCAN_LIMIT;
  const tests = testRows.slice(0, DRIFT_TEST_SCAN_LIMIT);

  /*
   * ── The input that decides whether a retirement is even possible ───────────
   *
   * `declaredRoutes` is NULL when no source analysis has run, and null is not an
   * empty list: with nothing having read the code, "the source does not declare
   * this route" is the absence of a detector rather than a fact about the
   * application, and `obsolete.ts` withholds every retirement proposal on that
   * basis. The probe is for any SOURCE-origin item of ANY kind, because source
   * analysis is what produces endpoints, forms and auth surfaces — a project
   * whose code declares no page routes at all would otherwise read as having no
   * source analysis.
   */
  const sourceItems = await prisma.coverageItem.count({
    where: {
      orgId: crawl.orgId,
      projectId: crawl.projectId,
      origin: { in: ['SOURCE_ONLY', 'BOTH'] },
    },
  });
  const routeItemRows = await prisma.coverageItem.findMany({
    where: { orgId: crawl.orgId, projectId: crawl.projectId, kind: 'ROUTE' },
    orderBy: { key: 'asc' },
    take: DRIFT_ROUTE_ITEM_SCAN_LIMIT + 1,
    select: { key: true, origin: true, retiredAt: true },
  });
  const routeItemsTruncated = routeItemRows.length > DRIFT_ROUTE_ITEM_SCAN_LIMIT;
  const routeItems = routeItemRows.slice(0, DRIFT_ROUTE_ITEM_SCAN_LIMIT);

  const routeOf = (key: string): string => key.replace(/^ROUTE:/, '');
  const declaredRoutes =
    sourceItems > 0
      ? routeItems.filter((item) => item.origin !== 'CRAWL_ONLY').map((item) => routeOf(item.key))
      : null;
  const retiredRoutes = routeItems
    .filter((item) => item.retiredAt !== null)
    .map((item) => routeOf(item.key));

  const report = auditTestsAgainstCrawl({
    tests: tests
      // Fixtures are test data, not tests.
      .filter((test) => !test.filePath.startsWith(FIXTURE_PREFIX))
      .map((test) => test as unknown as SuiteHealthTestInput),
    flowMap: readFlowMap(crawl),
    declaredRoutes,
    /*
     * The source-side fence. Beyond the cap the declared list is a page of the
     * project's route items rather than the list, so "the source does not
     * declare this route" stops being a fact — and every retirement proposal
     * for this crawl is withheld rather than resting on it.
     */
    declaredRoutesTruncatedReason: routeItemsTruncated
      ? `QAAI read the first ${DRIFT_ROUTE_ITEM_SCAN_LIMIT} route items of this project and there are more`
      : null,
    retiredRoutes,
  });
  const check = driftCheck(report);

  const retirements = await proposeRetirements(crawl, report);

  await prisma.auditLog.create({
    data: {
      orgId: crawl.orgId,
      userId: null,
      action: HEAL_AUDIT_ACTIONS.driftChecked,
      targetType: 'FlowMap',
      targetId: crawl.id,
      metadata: {
        projectId: crawl.projectId,
        crawlVersion: crawl.version,
        testsCompared: report.tests.length,
        /*
         * Both caps, stated. `testsCompared: 12` on a project with nine hundred
         * tests is a number that gets read as the whole suite, and
         * `routesCompared` was not recorded at all — so nothing anywhere said
         * that the authority for one of the two negatives behind a retirement
         * had been truncated. A count with no "more exist" beside it is how a
         * cap becomes a silent claim.
         */
        testsTruncated,
        testScanLimit: DRIFT_TEST_SCAN_LIMIT,
        routesCompared: routeItems.length,
        routeItemsTruncated,
        routeItemScanLimit: DRIFT_ROUTE_ITEM_SCAN_LIMIT,
        summary: check.summary,
        // Capped: the audit row is a record, not the report. Recomputing the
        // whole thing is a read away (GET /agent/projects/:id/drift).
        warnings: check.warnings.slice(0, DRIFT_WARNINGS_RECORDED).map((warning) => ({
          testId: warning.testId,
          name: warning.name,
          priority: warning.priority,
          missing: warning.missing,
        })),
        warningsTruncated: Math.max(0, check.warnings.length - DRIFT_WARNINGS_RECORDED),
        retirementsProposed: retirements,
        // The caveats ride along, because a count without them is the kind of
        // number that gets quoted on its own six months later.
        caveats: report.caveats,
      },
    },
  });

  logger.info(
    {
      projectId: crawl.projectId,
      crawlVersion: crawl.version,
      drifted: check.warnings.length,
      obsolete: check.obsoleteCount,
      retirementsProposed: retirements.length,
    },
    'drift check complete',
  );
}

/** The stored graph, or null when it is not a shape this can read. */
function readFlowMap(crawl: CrawlRow): FlowMap | null {
  const graph = crawl.graph as Partial<FlowMap> | null;
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) return null;
  return {
    projectId: crawl.projectId,
    environmentId: typeof graph.environmentId === 'string' ? graph.environmentId : '',
    baseUrl: typeof graph.baseUrl === 'string' ? graph.baseUrl : '',
    nodes: graph.nodes,
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    journeys: Array.isArray(graph.journeys) ? graph.journeys : [],
    features: Array.isArray(graph.features) ? graph.features : [],
    exploredAt: typeof graph.exploredAt === 'string' ? graph.exploredAt : '',
    /*
     * The ROW is the authority on these two, not the blob. A `graph` written by
     * an older crawler may carry neither, and a missing `truncatedReason` read
     * as "the crawl was complete" is precisely the mistake that would let a
     * truncated crawl retire somebody's tests.
     */
    version: crawl.version,
    truncatedReason: crawl.truncatedReason,
    /*
     * THE ROW, NOT THE BLOB — and this field is the reason that rule exists.
     *
     * THE DEFECT THIS FIXES: this reconstruction rebuilt the FlowMap
     * field-by-field and dropped `acceptance`, so `crawlSurfaceOf` read it as
     * `null` for every crawl ever written and `retirementBlockedBy` answered
     * "never adjudicated" for all of them. The retirement path was dead in
     * production — a CORRECT gate reading a field nobody passed it — while the
     * only thing that noticed was two red tests in this file.
     *
     * Only `state` and `reasons` are reconstructed, because they are the only
     * two `retirementBlockedBy` asks for and the row stores no more than that.
     * `degradations` and the two comparison counts live in the blob's own
     * acceptance object when there is one; inventing zeros for them here would
     * be reporting an unmeasured count as a measured one.
     */
    acceptance:
      crawl.acceptance === null
        ? null
        : {
            state: crawl.acceptance,
            reasons: crawl.acceptanceReason === null ? [] : [crawl.acceptanceReason],
            degradations: [],
            comparedToVersion: null,
            previousNodeCount: null,
          },
  };
}

/** Route checks as plain JSON, for the `evidence` column and the audit row. */
function routesAsJson(
  routes: TestSurfaceReport['routes'],
): Array<{ route: string; reached: boolean; declared: boolean; retired: boolean }> {
  return routes.map((route) => ({
    route: route.route,
    reached: route.reached,
    declared: route.declared,
    retired: route.retired,
  }));
}

/**
 * Mint RETIRE proposals for the tests `obsolete.ts` is willing to call obsolete.
 *
 * Every guard that matters is upstream of here — a retirement is only ever
 * proposed when source analysis exists, the crawl ran to completion, the test
 * was read in full and every route it drives is absent from both sides. This
 * function adds two more: a cap per crawl, and the per-test lifecycle guard, so
 * a project cannot accumulate one retirement row per tick for the same test.
 */
async function proposeRetirements(
  crawl: CrawlRow,
  report: ReturnType<typeof auditTestsAgainstCrawl>,
): Promise<Array<{ testId: string; healId: string; confidence: number }>> {
  const out: Array<{ testId: string; healId: string; confidence: number }> = [];

  const obsolete = report.tests.filter(
    (test): test is TestSurfaceReport & { retirement: NonNullable<TestSurfaceReport['retirement']> } =>
      test.verdict === 'OBSOLETE' && test.retirement !== null,
  );

  for (const test of obsolete) {
    if (out.length >= RETIREMENTS_PER_PROJECT_PER_CRAWL) break;

    const openHeals = await openHealsFor(crawl.orgId, test.testId);
    const decision = shouldProposeHeal({
      openHeals,
      currentCode: '',
      kind: 'RETIREMENT',
    });
    if (!decision.propose) continue;

    const healId = randomUUID();
    await prisma.$transaction([
      prisma.healProposal.create({
        data: {
          id: healId,
          orgId: crawl.orgId,
          testId: test.testId,
          verdictId: null,
          /*
           * EMPTY, on purpose and documented on the column. A retirement is not
           * a patch: `applyHealDiff` refuses a diff that removes a test block,
           * and that refusal is correct — so this is applied by DISABLING the
           * test, which is reversible, rather than by deleting the customer's
           * code, which is not.
           */
          diff: '',
          explanation: test.retirement.explanation,
          riskLevel: 'RETIRE',
          confidence: test.retirement.confidence,
          evidence: {
            kind: 'RETIREMENT',
            crawlVersion: crawl.version,
            routes: routesAsJson(test.routes),
            evidence: test.retirement.evidence,
            caveats: test.caveats,
          },
        },
      }),
      prisma.auditLog.create({
        data: {
          orgId: crawl.orgId,
          userId: null,
          action: HEAL_AUDIT_ACTIONS.retirementProposed,
          targetType: 'Test',
          targetId: test.testId,
          metadata: {
            healId,
            crawlVersion: crawl.version,
            confidence: test.retirement.confidence,
            routes: routesAsJson(test.routes),
            evidence: test.retirement.evidence,
          },
        },
      }),
    ]);

    out.push({ testId: test.testId, healId, confidence: test.retirement.confidence });
    logger.info(
      { testId: test.testId, healId, confidence: test.retirement.confidence },
      'proposed retiring an obsolete test',
    );
  }

  return out;
}
