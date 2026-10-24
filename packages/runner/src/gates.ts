/**
 * Quality gates (§4), and the ONE definition of "did this run pass".
 *
 * Two rules the evaluator enforces regardless of configuration:
 *  - Quarantined tests never block. They still run and still record history,
 *    but a flaky test in the quarantine lane cannot fail a build (§5).
 *  - A test that passed only on retry counts as flaky, not as a pass (§5).
 *
 * ── The defect this file is now the answer to ───────────────────────────────
 *
 * `evaluateGates` honoured quarantine and NOTHING else did. The run counters
 * (`apps/worker/src/processors/run.ts`) counted a quarantined test's failure as
 * a plain failure, so `Run.failedCount` went above zero, so the run was written
 * FAILED, so the CLI exited 1, the GitHub check went red and the JUnit XML
 * carried a `<failure>`. Quarantine therefore suppressed the SIGNAL — the test
 * vanished from the gate rules and from the quality page's gate detail — while
 * leaving the GATE in place. The worst of both: the team stopped seeing the
 * failure and still could not merge.
 *
 * The cause was architectural rather than a typo. Five places each decided
 * red/green for themselves off a different field, so a fix in one of them was
 * invisible to the other four. So "did this run pass" is defined HERE, once,
 * in `runOutcome`, and every server-side consumer calls it. The CLI cannot
 * import this module (it ships zero dependencies on purpose — see
 * packages/cli/src/index.ts), so it reads the answer off the API response
 * instead of computing a sixth one.
 *
 * ── And the honesty rule that comes with it ─────────────────────────────────
 *
 * A suppressed failure is still REPORTED as a suppressed failure. Quarantined
 * failures are counted separately — `quarantinedFailed` — and never folded into
 * `skipped`, because a suite where forty tests are quarantined and the board is
 * green is how a team finds out in production that nothing has been tested for
 * a month. A deliberate skip and a failure somebody switched off are different
 * facts and this product refuses to print them as the same number.
 */

import { BLOCKING_VERDICTS } from '@qaai/shared';
import type { GateResult, GateRule, Priority, TestResultStatus, Verdict } from '@qaai/shared';

export interface GateInput {
  results: Array<{
    testId: string;
    testName: string;
    status: TestResultStatus;
    priority: Priority;
    /**
     * Whether the quarantine is IN FORCE for this run — not whether the column
     * is true. An expired quarantine gates again (see `quarantineSuppresses`),
     * so callers pass the answer rather than the raw flag.
     */
    quarantined: boolean;
    retriedAndPassed: boolean;
    verdict: Verdict | null;
    durationMs: number;
  }>;
  /**
   * The suite's quarantine health, when the caller could read it. Absent means
   * "not measured", which produces no evaluation at all rather than a reassuring
   * pass — an unmeasured budget must not look like a budget that is fine.
   */
  quarantine?: QuarantineHealthInput;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quarantine: the budget, the expiry, and what "in force" means.
//
// An escape hatch with no bound is not a safety feature. Nothing refused the
// 40th quarantine and nobody was paged, so a quarter of a suite could stop
// gating while the board stayed green. Everything in this section exists to
// make quarantine a LOAN rather than a deletion nobody signed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much of a suite may be quarantined before quarantining is refused.
 *
 * 5%, and the number is picked against an existing one rather than invented:
 * the suite-health lens in packages/agent/src/suite-health.ts already scores
 * quarantine share 100 at 0% and 0 at 10%. A budget at 5% therefore bites at
 * the point where that score has already halved — late enough that a team's
 * first flaky week is not blocked, early enough that the refusal arrives while
 * the suite is still worth something. A project may raise or lower it with
 * `Project.quarantineBudgetPercent`; it is a documented project setting and
 * deliberately NOT an environment variable, because a brake nobody deploying
 * this could discover is not a brake.
 */
export const QUARANTINE_BUDGET_PERCENT_DEFAULT = 5;

/**
 * The floor on the budget, in tests, however small the suite.
 *
 * 5% of a 10-test suite is half a test, and a budget that refuses the FIRST
 * quarantine in a small suite does not protect anybody — it just means the
 * escape hatch does not exist, and a team with no escape hatch deletes the
 * test instead, which is strictly worse. So a suite always gets two. What this
 * loses is stated plainly: a 10-test suite can reach 20% quarantined before it
 * is refused, and that is the price of the hatch existing at all.
 */
export const QUARANTINE_BUDGET_FLOOR = 2;

/**
 * How long a quarantine lasts before it stops suppressing anything.
 *
 * A quarantine with no end date is a deletion nobody signed. Fourteen days is
 * two working weeks: long enough to land a real fix behind a release train,
 * short enough that "we'll get to it" does not become "nobody has run this
 * since March".
 *
 * What expiry does NOT do is clear the flag. Deleting the row's quarantine
 * would erase the reason and fight the measured auto-release in
 * processors/flake.ts, which owns that column. An expired quarantine simply
 * stops being honoured: the test gates again, the row still says what was
 * suppressed and when, and the surfaces can say "this quarantine expired".
 * Reversible, auditable, and loud — which no silent expiry is.
 */
export const QUARANTINE_MAX_DAYS = 14;

/** How close to the budget counts as "near it", for the warning. */
export const QUARANTINE_NEAR_BUDGET_FRACTION = 0.8;

/** How many days before expiry the warning starts. */
export const QUARANTINE_EXPIRY_WARNING_DAYS = 3;

/**
 * Is this test's quarantine in force right now?
 *
 * The one question every gate, counter and check must ask, in place of reading
 * `Test.quarantined` directly. A null expiry is a quarantine written before
 * expiry existed, and it is honoured — back-filling an expiry onto rows a
 * customer never agreed to would turn thousands of suppressed failures red in
 * one deploy, which is a schema migration deciding to break a build.
 */
export function quarantineSuppresses(
  test: { quarantined: boolean; quarantineExpiresAt?: Date | string | null },
  now: Date = new Date(),
): boolean {
  if (!test.quarantined) return false;
  const expires = test.quarantineExpiresAt;
  if (expires === null || expires === undefined) return true;
  const at = expires instanceof Date ? expires : new Date(expires);
  // An unparseable expiry keeps the quarantine. The alternative is a bad date
  // string turning a suppressed failure into a red build nobody asked for.
  if (Number.isNaN(at.getTime())) return true;
  return at.getTime() > now.getTime();
}

/** When a quarantine taken out now should run out. */
export function quarantineExpiryFrom(now: Date, days: number = QUARANTINE_MAX_DAYS): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

/**
 * How many quarantines a suite of this size is allowed.
 *
 * `Math.floor`, not `ceil`: on a boundary the direction that refuses is the
 * direction that keeps a signal on.
 */
export function quarantineBudget(args: { totalTests: number; budgetPercent?: number | null }): {
  allowed: number;
  percent: number;
} {
  const percent =
    typeof args.budgetPercent === 'number' && Number.isFinite(args.budgetPercent)
      ? Math.min(100, Math.max(0, args.budgetPercent))
      : QUARANTINE_BUDGET_PERCENT_DEFAULT;
  const total = Math.max(0, Math.trunc(args.totalTests));
  const fromPercent = Math.floor((total * percent) / 100);
  return { allowed: Math.max(QUARANTINE_BUDGET_FLOOR, fromPercent), percent };
}

export interface QuarantineBudgetVerdict {
  allowed: boolean;
  /** Quarantines in force before this one. */
  current: number;
  /** The cap this suite is under. */
  limit: number;
  percent: number;
  /** Share of the suite that would be quarantined if this one went through. */
  wouldBePercent: number;
  /** True when the suite is at or past `QUARANTINE_NEAR_BUDGET_FRACTION` of the cap. */
  nearLimit: boolean;
  /** Always says why, and always says what to do instead. Written to the audit row. */
  reason: string;
}

/**
 * May one more test be quarantined?
 *
 * Pure, so both writers can share it: the auto-quarantine in
 * `apps/worker/src/processors/flake.ts` and the by-hand switch in
 * `apps/api/src/routes/tests.ts`. Two implementations of a budget is how the
 * two doors come to disagree about the cap.
 *
 * A refusal names the two things that actually clear it — fix the test, or
 * delete it — because "budget exceeded" with no instruction is a wall, and a
 * wall gets routed around by someone raising the budget to 100.
 */
export function checkQuarantineBudget(args: {
  totalTests: number;
  /** Quarantines already in force. Expired ones are NOT in force; see above. */
  quarantinedCount: number;
  budgetPercent?: number | null;
  /** Already quarantined, being re-decided rather than newly suppressed. */
  alreadyQuarantined?: boolean;
}): QuarantineBudgetVerdict {
  const { allowed: limit, percent } = quarantineBudget(args);
  const current = Math.max(0, Math.trunc(args.quarantinedCount));
  const total = Math.max(0, Math.trunc(args.totalTests));
  const after = args.alreadyQuarantined ? current : current + 1;
  const wouldBePercent = total === 0 ? 0 : Math.round((after / total) * 1000) / 10;
  const nearLimit = limit > 0 && after >= Math.ceil(limit * QUARANTINE_NEAR_BUDGET_FRACTION);

  /*
   * Re-deciding a test that is ALREADY quarantined is never refused. The
   * suppression exists either way, and refusing here would only stop the audit
   * row and the reason being updated — it would hide the state rather than
   * change it. The budget guards the act of switching a NEW signal off.
   */
  if (args.alreadyQuarantined) {
    return {
      allowed: true,
      current,
      limit,
      percent,
      wouldBePercent,
      nearLimit,
      reason: `Already quarantined; ${current} of ${total} test(s) are suppressed (cap ${limit}).`,
    };
  }

  if (after > limit) {
    return {
      allowed: false,
      current,
      limit,
      percent,
      wouldBePercent,
      nearLimit: true,
      reason:
        `Refused: ${current} of ${total} test(s) in this project are already quarantined, which ` +
        `is this project's cap of ${limit} (${percent}% of the suite, floor ${QUARANTINE_BUDGET_FLOOR}). ` +
        `Quarantining another would leave ${wouldBePercent}% of the suite not gating anything. ` +
        `Fix one of the quarantined tests or delete it — a suite that suppresses more than its ` +
        `budget is not being tested, and an unbounded escape hatch is not a safety feature. ` +
        `If the cap is genuinely wrong for this project, raise Project.quarantineBudgetPercent ` +
        `on purpose and in writing.`,
    };
  }

  return {
    allowed: true,
    current,
    limit,
    percent,
    wouldBePercent,
    nearLimit,
    reason: nearLimit
      ? `Allowed, but this is ${after} of a cap of ${limit} (${wouldBePercent}% of the suite). ` +
        `The next one or two will be refused.`
      : `Allowed: ${after} of a cap of ${limit} (${wouldBePercent}% of the suite).`,
  };
}

export interface QuarantineHealthInput {
  /** Live tests in the project. The denominator. */
  totalTests: number;
  /** Quarantines IN FORCE — expired ones excluded. */
  quarantinedCount: number;
  budgetPercent?: number | null;
  /** Quarantines whose expiry has passed, so these tests gate again. */
  expired?: Array<{ testId: string; testName: string }>;
  /** Quarantines inside `QUARANTINE_EXPIRY_WARNING_DAYS` of running out. */
  expiringSoon?: Array<{ testId: string; testName: string; expiresAt: Date }>;
  /** Quarantines older than the cap but with no expiry stamped. */
  unbounded?: Array<{ testId: string; testName: string; quarantinedAt: Date | null }>;
}

/**
 * The rot alarm, as gate evaluations.
 *
 * It deliberately invents no channel. A gate evaluation is already rendered by
 * every surface that matters — the chat alert (`blockingGateRules`), the GitHub
 * check summary, the CLI's printed BLOCK lines and its `--json`, and the run
 * page's gate chip — so quarantine rot reaches exactly the people a red run
 * reaches, through plumbing that is already tested, instead of through a fifth
 * notification path nobody subscribes to.
 *
 * Over budget BLOCKS. That is the point of a budget: a suite that has
 * suppressed more than its cap is not meaningfully tested, and holding the
 * merge is the only sentence loud enough to be heard. Everything else — near
 * the cap, an expired quarantine now gating again, a quarantine with no end
 * date at all — WARNs, because each of those is news rather than a reason to
 * stop a release.
 */
export function evaluateQuarantineHealth(input: QuarantineHealthInput): GateResult['evaluations'] {
  const { allowed: limit, percent } = quarantineBudget(input);
  const total = Math.max(0, Math.trunc(input.totalTests));
  const current = Math.max(0, Math.trunc(input.quarantinedCount));
  const share = total === 0 ? 0 : Math.round((current / total) * 1000) / 10;
  const evaluations: GateResult['evaluations'] = [];

  const rule = (action: 'WARN' | 'BLOCK'): GateRule =>
    ({ kind: 'MAX_QUARANTINE_PERCENT', percent, action }) as unknown as GateRule;

  const overBudget = current > limit;
  const nearBudget =
    !overBudget && limit > 0 && current >= Math.ceil(limit * QUARANTINE_NEAR_BUDGET_FRACTION);

  if (overBudget) {
    evaluations.push({
      rule: rule('BLOCK'),
      passed: false,
      action: 'BLOCK',
      detail:
        `Quarantine budget — ${current} of ${total} test(s) (${share}%) are quarantined and no ` +
        `longer gate anything, above this project's cap of ${limit} (${percent}%). Fix or delete ` +
        `a quarantined test. A green board over a suite this suppressed is not a passing suite.`,
    });
  } else {
    evaluations.push({
      rule: rule('WARN'),
      passed: !nearBudget,
      action: nearBudget ? 'WARN' : 'PASS',
      detail: nearBudget
        ? `Quarantine budget — ${current} of ${total} test(s) (${share}%) are quarantined, close ` +
          `to this project's cap of ${limit} (${percent}%). The next quarantine may be refused.`
        : `Quarantine budget — ${current} of ${total} test(s) (${share}%) quarantined, cap ${limit} (${percent}%).`,
    });
  }

  const expired = input.expired ?? [];
  if (expired.length > 0) {
    evaluations.push({
      rule: rule('WARN'),
      passed: false,
      action: 'WARN',
      detail:
        `Quarantine expired — ${expired.length} test(s) are past their ${QUARANTINE_MAX_DAYS}-day ` +
        `quarantine and GATE AGAIN from now on: ${names(expired)}. A quarantine is a loan, not a ` +
        `deletion; fix them, delete them, or quarantine them again on purpose.`,
    });
  }

  const soon = input.expiringSoon ?? [];
  if (soon.length > 0) {
    evaluations.push({
      rule: rule('WARN'),
      passed: false,
      action: 'WARN',
      detail:
        `Quarantine expiring — ${soon.length} test(s) start gating again within ` +
        `${QUARANTINE_EXPIRY_WARNING_DAYS} days: ${names(soon)}.`,
    });
  }

  const unbounded = input.unbounded ?? [];
  if (unbounded.length > 0) {
    evaluations.push({
      rule: rule('WARN'),
      passed: false,
      action: 'WARN',
      detail:
        `Quarantine with no end date — ${unbounded.length} test(s) have been quarantined longer ` +
        `than ${QUARANTINE_MAX_DAYS} days with no expiry stamped: ${names(unbounded)}. These ` +
        `predate the expiry rule and are still suppressing; they will keep suppressing until ` +
        `somebody decides otherwise.`,
    });
  }

  return evaluations;
}

/** Up to three names, then a count. A gate detail nobody can read is not a warning. */
function names(rows: ReadonlyArray<{ testName: string }>): string {
  const head = rows.slice(0, 3).map((r) => r.testName);
  return rows.length > 3 ? `${head.join(', ')} and ${rows.length - 3} more` : head.join(', ');
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: for p95 of 20 samples this is the 19th, which is what people
  // mean by "p95" in a CI report.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function describe(rule: GateRule): string {
  switch (rule.kind) {
    case 'BLOCK_ON_VERDICT':
      return `Block on ${rule.verdict}${
        rule.onlyPriorities.length ? ` (${rule.onlyPriorities.join(', ')})` : ''
      }`;
    case 'MAX_FLAKE_RATE':
      return `Flake rate under ${rule.ratePercent}%`;
    case 'MAX_P95_LATENCY_MS':
      return `p95 under ${rule.ms}ms`;
    case 'MIN_PASS_RATE':
      return `Pass rate at least ${rule.ratePercent}%`;
    case 'MAX_QUARANTINE_PERCENT':
      return `No more than ${rule.percent}% of the suite quarantined`;
  }
}

export function evaluateGates(rules: GateRule[], input: GateInput): GateResult {
  // Quarantined tests are excluded from every rule, not just the verdict rule —
  // a lane of known-flaky tests must not drag the pass rate below a threshold.
  const gating = input.results.filter((r) => !r.quarantined);
  const evaluations: GateResult['evaluations'] = [];

  for (const rule of rules) {
    let passed = true;
    let detail = '';

    switch (rule.kind) {
      case 'BLOCK_ON_VERDICT': {
        const offenders = gating.filter(
          (r) =>
            r.verdict === rule.verdict &&
            (rule.onlyPriorities.length === 0 || rule.onlyPriorities.includes(r.priority)),
        );
        passed = offenders.length === 0;
        detail = passed
          ? `No ${rule.verdict} verdicts`
          : `${offenders.length} ${rule.verdict} verdict(s): ${offenders
              .slice(0, 3)
              .map((o) => o.testName)
              .join(', ')}${offenders.length > 3 ? '…' : ''}`;
        break;
      }

      case 'MAX_FLAKE_RATE': {
        const flaky = gating.filter((r) => r.status === 'FLAKY' || r.retriedAndPassed).length;
        const rate = gating.length === 0 ? 0 : (flaky / gating.length) * 100;
        passed = rate <= rule.ratePercent;
        detail = `${rate.toFixed(1)}% flaky (${flaky}/${gating.length})`;
        break;
      }

      case 'MAX_P95_LATENCY_MS': {
        const p95 = percentile(
          gating.map((r) => r.durationMs),
          95,
        );
        passed = p95 <= rule.ms;
        detail = `p95 was ${p95}ms`;
        break;
      }

      case 'MIN_PASS_RATE': {
        const passedCount = gating.filter((r) => r.status === 'PASSED').length;
        const rate = gating.length === 0 ? 100 : (passedCount / gating.length) * 100;
        passed = rate >= rule.ratePercent;
        detail = `${rate.toFixed(1)}% passed (${passedCount}/${gating.length})`;
        break;
      }
    }

    const action: 'WARN' | 'BLOCK' | 'PASS' = passed
      ? 'PASS'
      : rule.kind === 'BLOCK_ON_VERDICT'
        ? 'BLOCK'
        : rule.action;

    evaluations.push({ rule, passed, action, detail: `${describe(rule)} — ${detail}` });
  }

  /*
   * The quarantine alarm is appended AFTER the configured rules, and is not one
   * of them. A project cannot switch it off by writing its own rule list: the
   * budget exists to bound the mechanism that switches signals off, and a brake
   * the thing it brakes can remove is not a brake.
   */
  if (input.quarantine) evaluations.push(...evaluateQuarantineHealth(input.quarantine));

  return { passed: evaluations.every((e) => e.action !== 'BLOCK'), evaluations };
}

/**
 * The default rule set a new project gets (§4). Deliberately conservative:
 * only a real bug on a critical-path test blocks, everything else warns, so a
 * team's first week with QAAI does not turn into a wall of red builds.
 */
export const DEFAULT_GATE_RULES: GateRule[] = [
  { kind: 'BLOCK_ON_VERDICT', verdict: BLOCKING_VERDICTS[0]!, onlyPriorities: ['CRITICAL_PATH'] },
  { kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'WARN' },
];

// ─────────────────────────────────────────────────────────────────────────────
// "Did this run pass" — the single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A run's tallies, with suppressed failures kept apart from everything else.
 *
 * `quarantinedFailed` is a FOURTH category and not a slice of `failed` or of
 * `skipped`. Folding it into `failed` is the defect this whole change exists to
 * close; folding it into `skipped` would be the same mistake wearing a kinder
 * word, because a deliberate skip and a failure somebody switched off are
 * different facts and a reader cannot act on them with the same information.
 *
 * `passed + failed + flaky + skipped + quarantinedFailed` is the number of
 * results, so no total double-counts.
 */
export interface RunCountsWithQuarantine {
  passed: number;
  /** Failures that GATE. A quarantined test's failure is not one of these. */
  failed: number;
  flaky: number;
  skipped: number;
  /** Failures a quarantine in force suppressed. Reported, never gating. */
  quarantinedFailed: number;
}

export type RunTerminalStatus = 'PASSED' | 'FAILED' | 'CANCELLED' | 'ERRORED';

export interface RunOutcome {
  status: RunTerminalStatus;
  /** The one boolean every consumer keys off. `false` means the build goes red. */
  passed: boolean;
  /** How many failures were suppressed, so no surface has to pretend they were not there. */
  suppressedFailures: number;
  /**
   * One sentence, printable verbatim. The CLI prints it, the check shows it, and
   * a run that passed WITH suppressed failures says so instead of saying nothing.
   */
  reason: string;
}

/**
 * The only function allowed to answer "did this run pass".
 *
 * Every server-side consumer calls it: the worker's finaliser, the on-prem
 * finaliser, the API's run response, the GitHub check, the JUnit XML. The CLI
 * reads the answer off the API rather than computing its own — see
 * `packages/cli/src/index.ts`.
 *
 * A quarantined failure cannot reach `counts.failed`, so it cannot reach this
 * function's verdict either. It reaches the `reason`, every time, because a
 * green run with suppressed failures that does not mention them is the exact
 * reassuring lie that let a team ship against an untested suite for a month.
 */
export function runOutcome(args: {
  counts: RunCountsWithQuarantine;
  /** `GateResult.passed`. True when nothing BLOCKed. */
  gatePassed: boolean;
  /** Set when the verdict is not the tests': a cancel, or a run that blew up. */
  forcedStatus?: 'CANCELLED' | 'ERRORED' | null;
}): RunOutcome {
  const { counts, gatePassed } = args;
  const forced = args.forcedStatus ?? null;
  const suppressed = Math.max(0, counts.quarantinedFailed);
  const suppressedNote =
    suppressed > 0
      ? ` ${suppressed} failing test(s) were quarantined, so they did not fail the build — they are still failing.`
      : '';

  if (forced === 'CANCELLED') {
    return {
      status: 'CANCELLED',
      // Not a pass and not a failure of the change: nobody wanted the answer.
      // `passed: false` keeps a cancel out of the "it was green" column.
      passed: false,
      suppressedFailures: suppressed,
      reason: `The run was cancelled, so it has no verdict.${suppressedNote}`,
    };
  }

  if (forced === 'ERRORED') {
    return {
      status: 'ERRORED',
      passed: false,
      suppressedFailures: suppressed,
      reason: `The run did not finish, so nothing was measured.${suppressedNote}`,
    };
  }

  if (counts.failed > 0) {
    return {
      status: 'FAILED',
      passed: false,
      suppressedFailures: suppressed,
      reason: `${counts.failed} test(s) failed.${suppressedNote}`,
    };
  }

  if (!gatePassed) {
    return {
      status: 'FAILED',
      passed: false,
      suppressedFailures: suppressed,
      reason: `Every test that gates passed, and a quality gate blocked the run.${suppressedNote}`,
    };
  }

  return {
    status: 'PASSED',
    passed: true,
    suppressedFailures: suppressed,
    reason: `${counts.passed} test(s) passed and nothing that gates failed.${suppressedNote}`,
  };
}

/**
 * Tally one result, honouring quarantine.
 *
 * The counters used to be four `switch` arms in the worker's execution loop and
 * a `groupBy('status')` in its aggregator, neither of which could see
 * `Test.quarantined` — the aggregator literally could not, because Prisma
 * cannot group by a relation's column. Both now call this, so the in-loop
 * tally and the recount from rows can no longer disagree about one run.
 */
export function tallyResult(
  counts: RunCountsWithQuarantine,
  result: { status: TestResultStatus | string; quarantineInForce: boolean },
): void {
  switch (result.status) {
    case 'PASSED':
      counts.passed += 1;
      return;
    case 'FLAKY':
      counts.flaky += 1;
      return;
    case 'SKIPPED':
      counts.skipped += 1;
      return;
    default:
      // FAILED and TIMED_OUT both mean the test did not pass. Which column it
      // lands in is the entire fix.
      if (result.quarantineInForce) counts.quarantinedFailed += 1;
      else counts.failed += 1;
  }
}

/** A zeroed tally. */
export function emptyRunCounts(): RunCountsWithQuarantine {
  return { passed: 0, failed: 0, flaky: 0, skipped: 0, quarantinedFailed: 0 };
}
