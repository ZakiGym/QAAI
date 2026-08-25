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
  MANUAL_QUARANTINE_ACTIONS,
  TERMINAL_RUN_STATUSES,
  resolveFlakePolicy,
} from '@qaai/shared';
import type { FlakePolicy, Priority, RunStatus, TestResultStatus } from '@qaai/shared';
// One toll for every path that creates a Run: the plan gate and the usage
// counter. It lives in the API workspace and takes its Prisma client as an
// argument so this file can call the same implementation POST /runs does.
import { startRun } from '../../../api/src/lib/start-run.js';
import { logger, prisma } from '../context.js';
import { enqueueRun } from '../queues.js';

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

const TERMINAL: readonly string[] = TERMINAL_RUN_STATUSES;

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
    return {
      action: 'QUARANTINE',
      reason:
        `${AUTO_QUARANTINE_REASON_PREFIX}: it ${measured}, above this project's ` +
        `${policy.quarantineRatePercent}% threshold. It still runs — it just stops gating. ` +
        `Disagree? Un-quarantine it and it gates again immediately.`,
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
  /** Confirmation runs are excluded: an investigation must not feed itself. */
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

  const [lastQuarantineAudit, realBug] = await Promise.all([
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
          ...(alreadyQuarantined ? {} : { quarantinedAt: new Date() }),
          quarantineReason: decision.reason,
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
        data: { quarantined: false, quarantinedAt: null, quarantineReason: null },
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
      fromConfirmationRun: parseInvestigationTag(row.run.triggeredBy) !== null,
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
