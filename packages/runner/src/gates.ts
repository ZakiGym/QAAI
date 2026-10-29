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

import {
  BLOCKING_VERDICTS,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  summariseSuppressions,
} from '@qaai/shared';
import type { SuppressionSummary, SuppressionTally } from '@qaai/shared';
import type {
  FindingKind,
  FindingSeverity,
  GateAction,
  GateRescore,
  GateResult,
  GateRule,
  NotRunKind,
  PatchCoverage,
  PerformanceMetric,
  Priority,
  TestResultStatus,
  Verdict,
} from '@qaai/shared';

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
    /**
     * Why this result did not run, when something recorded a reason:
     * `TestResult.notRunKind`, or the tag `parseNotRun` reads back off the
     * message for a row written before that column existed.
     *
     * ABSENT IS NOT `NOT_RUN`. Undefined and null both mean nobody recorded a
     * reason, which is the fifth state `NOT_RUN_KINDS` names in
     * packages/shared/src/constants.ts — a plugin that returned SKIPPED with a
     * plain sentence made no claim about WHY, and inventing one here would put a
     * classification into a denominator that nothing produced.
     *
     * A recorded reason takes the row out of the rate rules, the way a
     * quarantine in force does, and for the reason that vocabulary already
     * states: all four kinds are rows that are not evidence about the
     * application in either direction. Counting a test the environment blocked
     * as a test that did not pass is how one dead staging box came to fail a
     * `MIN_PASS_RATE` gate — and `quarantined: true` was NOT the way to say so,
     * however well it would have worked, because these tests are not
     * quarantined and a surface that reads them as quarantined reports a
     * suppression nobody signed.
     *
     * Every exclusion is counted into the evaluation's detail. An unexplained
     * SKIPPED row stays in the denominator and is reported as unexplained,
     * because dropping it would be this file guessing which of the four kinds
     * applied.
     */
    notRun?: NotRunKind | null;
    verdict: Verdict | null;
    durationMs: number;
  }>;
  /**
   * The suite's quarantine health, when the caller could read it. Absent means
   * "not measured", which produces no evaluation at all rather than a reassuring
   * pass — an unmeasured budget must not look like a budget that is fine.
   */
  quarantine?: QuarantineHealthInput;
  /**
   * ── The measured inputs, and the one rule they all obey ───────────────────
   *
   * ABSENT MEANS NOT MEASURED, and not measured is neither a pass nor a block.
   * Every field below is optional, and a rule whose field is missing produces an
   * UNMEASURED evaluation that says which measurement was missing.
   *
   * The distinction that does the work is between a field that is absent and a
   * field that is present and empty. `findings: { findings: [] }` means the
   * findings were read and there were none, which is a PASS. `findings`
   * undefined means nobody looked, which is not. Collapsing those two is how a
   * gate comes to certify a thing it never examined.
   */
  coverage?: CoverageGateInput;
  patch?: PatchCoverage;
  findings?: FindingsGateInput;
  mutation?: MutationGateInput;
  vitals?: VitalsGateInput;
}

/**
 * The stored coverage snapshot, as a gate rule needs it.
 *
 * `percent` is nullable for the reason `coveragePercent` in
 * packages/shared/src/surface.ts makes it nullable: a zero denominator has no
 * percentage, and printing 0% would be a claim about the customer's app made
 * from our own extractor finding nothing. A null arriving here is UNMEASURED.
 */
export interface CoverageGateInput {
  percent: number | null;
  denominator: number;
  covered: number;
  /** When the snapshot was taken, so an old number can be said to be old. */
  measuredAtIso: string;
  /** The commit it was measured against, when the measurement knew one. */
  commitSha: string | null;
}

/**
 * The findings a run recorded, with every exclusion counted rather than hidden.
 *
 * A finding that is muted, or that belongs to a test whose quarantine is in
 * force, does not gate — `Finding.mutedAt` says so in the schema and quarantine
 * says so everywhere else in this file. But a gate that silently dropped 40
 * muted criticals and reported "0 findings at or above CRITICAL" would be the
 * quarantine defect again in a different table, so the counts travel with the
 * list and reach the evaluation's detail.
 */
export interface FindingsGateInput {
  findings: ReadonlyArray<{
    kind: FindingKind;
    severity: FindingSeverity;
    code: string;
    location: string;
    /** The test that filed it, for a detail a human can act on. */
    testName: string | null;
  }>;
  /** True when the caller's cap dropped rows, so the count is a FLOOR. */
  truncated?: boolean;
  /** Muted findings the caller left out. Reported, never gating. */
  excludedMuted?: number;
  /** Findings from tests whose quarantine is in force. Reported, never gating. */
  excludedQuarantined?: number;
}

/**
 * The run's mutation numbers, pooled.
 *
 * Pooled by MUTANT, not averaged over results: a test with 4 mutants and a test
 * with 400 are not two equal votes on whether this suite asserts anything, and
 * the mean of two percentages would let a tiny well-killed file paper over a
 * large unasserted one.
 */
export interface MutationGateInput {
  /** Results in this run that reported mutation columns at all. */
  resultsWithData: number;
  detected: number;
  undetected: number;
  /** Non-viable mutants, excluded from BOTH sides — an inflated score is worse than none. */
  excluded: number;
}

/**
 * Core Web Vitals, as the product actually persists them: breaches.
 *
 * `performanceTests` is the honesty field. Zero means no performance test ran,
 * so "no breaches" is not an observation about the pages — it is an observation
 * about the suite, and the rule reports UNMEASURED.
 */
export interface VitalsGateInput {
  performanceTests: number;
  breaches: ReadonlyArray<{
    metric: PerformanceMetric;
    /** The path the budget was measured on. */
    location: string;
    message: string;
  }>;
  /**
   * True when the caller's cap dropped rows before the breaches were read, so
   * the count is a FLOOR.
   *
   * Breaches are carried on the SAME findings list `FindingsGateInput` reads,
   * so the same cap drops them — and a breach that lost that race is a breach
   * this rule cannot see. `truncated` without this field is how
   * `MAX_VITAL_BREACHES max: 0` came to report "0 budget breach(es)" on a run
   * that recorded one: the honest answer is the one `MAX_FINDINGS` already
   * gives, so the rule may still FAIL on a capped list and may never CLEAR on
   * one.
   */
  truncated?: boolean;
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
 * How many quarantined rows a caller is expected to read for the NAMES.
 *
 * Exported so the two callers that build a `QuarantineHealthInput` — the run
 * finaliser and the post-triage re-score — cap the same list at the same size.
 * The COUNT that the budget is scored against is never taken from this list;
 * see the comment on `quarantinedCount`.
 */
export const QUARANTINE_NAMES_SCANNED = 200;

/**
 * Classify quarantined rows into the three warnings, from rows a caller read.
 *
 * The classification rules — expired, expiring soon, quarantined-with-no-expiry
 * and old enough to be news — were written inside the worker's finaliser, where
 * a second reader could not reach them. The post-triage re-score is that second
 * reader: it must produce the same quarantine evaluations as finalisation did,
 * because a re-scored gate that quietly dropped the budget BLOCK would be a
 * green-wash performed by the code that exists to stop one.
 *
 * Pure, so both callers keep their own query and share the judgement. The
 * `quarantinedCount` is passed in rather than counted from `rows`: `rows` is
 * CAPPED, and counting from it would make the budget stop working at exactly
 * the size it matters most — a project with 4,000 quarantines would report 200,
 * land under its cap, and the alarm built to catch a suite that has stopped
 * testing anything would go quiet on the worst suite in the install.
 */
export function quarantineHealthFrom(args: {
  totalTests: number;
  /** Suppressions IN FORCE, counted in the database rather than in this list. */
  quarantinedCount: number;
  budgetPercent?: number | null;
  /** A bounded sample of the quarantined rows, oldest first. */
  rows: ReadonlyArray<{
    id: string;
    name: string;
    quarantinedAt: Date | null;
    quarantineExpiresAt: Date | null;
  }>;
  now?: Date;
}): QuarantineHealthInput {
  const now = args.now ?? new Date();
  const soonAt = new Date(now.getTime() + QUARANTINE_EXPIRY_WARNING_DAYS * 86_400_000);
  const unboundedBefore = new Date(now.getTime() - QUARANTINE_MAX_DAYS * 86_400_000);

  const expired: Array<{ testId: string; testName: string }> = [];
  const expiringSoon: Array<{ testId: string; testName: string; expiresAt: Date }> = [];
  const unbounded: Array<{ testId: string; testName: string; quarantinedAt: Date | null }> = [];

  for (const test of args.rows) {
    if (
      !quarantineSuppresses({ quarantined: true, quarantineExpiresAt: test.quarantineExpiresAt }, now)
    ) {
      expired.push({ testId: test.id, testName: test.name });
      continue;
    }
    if (test.quarantineExpiresAt === null) {
      /*
       * A quarantine written before expiry existed. Only reported once it is
       * OLDER than the window it would have had — one taken out this morning by
       * a writer that does not stamp an expiry yet is not news, and reporting it
       * would fire this warning on every run of every install until every
       * writer is updated.
       */
      if (test.quarantinedAt !== null && test.quarantinedAt < unboundedBefore) {
        unbounded.push({ testId: test.id, testName: test.name, quarantinedAt: test.quarantinedAt });
      }
      continue;
    }
    if (test.quarantineExpiresAt <= soonAt) {
      expiringSoon.push({
        testId: test.id,
        testName: test.name,
        expiresAt: test.quarantineExpiresAt,
      });
    }
  }

  return {
    totalTests: args.totalTests,
    quarantinedCount: args.quarantinedCount,
    budgetPercent: args.budgetPercent ?? null,
    expired,
    expiringSoon,
    unbounded,
  };
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

  /*
   * No cast. This kind IS a member of the shared `GateRule` union, and the
   * `as unknown as GateRule` that used to be here dated from when it was not —
   * which meant a typo in this object would have typechecked.
   */
  const rule = (action: 'WARN' | 'BLOCK'): GateRule => ({
    kind: 'MAX_QUARANTINE_PERCENT',
    percent,
    action,
  });

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
    case 'MIN_COVERAGE':
      return `Surface coverage at least ${rule.percent}%`;
    case 'MIN_PATCH_COVERAGE':
      return `Coverage of the changed surface at least ${rule.percent}%`;
    case 'NO_NEW_UNCOVERED_ROUTES':
      return 'No route in this diff without a test';
    case 'MAX_FINDINGS':
      return (
        `No more than ${rule.max} ${rule.atOrAbove}-or-worse finding(s)` +
        (rule.onlyKinds.length ? ` in ${rule.onlyKinds.join('/')}` : '')
      );
    case 'MIN_MUTATION_SCORE':
      return `Mutation score at least ${rule.percent}%`;
    case 'MAX_VITAL_BREACHES':
      return (
        `No more than ${rule.max} ` +
        (rule.metric === 'ANY' ? 'Core Web Vitals' : rule.metric) +
        ' budget breach(es)'
      );
    case 'ENVIRONMENT_AVAILABLE':
      return 'The environment must be usable';
  }
}

/**
 * One rule's answer, in the three states a rule can be in.
 *
 * `passed: null` is the third one and it is not an error state: it is "nobody
 * measured this", which must not pass and must not block. See {@link GateAction}.
 */
interface RuleOutcome {
  passed: boolean | null;
  detail: string;
}

/**
 * The no-answer answer.
 *
 * Every caller passes a sentence that names the MISSING MEASUREMENT and, where
 * one exists, what to turn on — because the failure mode of this state is a
 * team seeing "not measured" on a rule they deliberately configured and having
 * nowhere to go with it.
 */
const unmeasured = (why: string): RuleOutcome => ({ passed: null, detail: `not measured — ${why}` });

/**
 * Index into `FINDING_SEVERITIES`. Lower is worse, because the list is worst-first.
 *
 * ── The decision, and it is a decision ──────────────────────────────────────
 *
 * A severity this build does not recognise ranks as the WORST (rank 0), so it
 * matches every `atOrAbove` threshold and is counted. `FindingSeverity` is a
 * TypeScript union over a TEXT column that plugins write, so an unrecognised
 * value is not hypothetical: an external plugin's JSON, a newer vocabulary, a
 * hand-edited row.
 *
 * The three answers available were ranked as the worst, ranked as the least bad
 * (which is `return 99`, and it is the one this returned nowhere near a test
 * until now), and refusing to score the rule. Dropping it is out: a finding
 * that silently leaves the count is a failure suppressed without being counted,
 * and this build not knowing a word is not evidence about the customer's app.
 * UNMEASURED is out for a narrower reason — the rule can still be FAILED
 * truthfully by the findings it DOES recognise, and converting "one word we do
 * not know" into "nobody counted any of this" loses more than it saves.
 *
 * WHAT IT COSTS, since it is a cost and not a free win: a `max: 0` rule can be
 * failed by a finding whose severity may well have been MINOR. The evaluation's
 * detail therefore SAYS SO — see the `MAX_FINDINGS` arm, which counts the
 * unrecognised severities and names them — so a team reading a block can tell
 * this case from a genuine critical in one sentence rather than by reading our
 * source.
 */
function severityRank(severity: FindingSeverity): number {
  const at = FINDING_SEVERITIES.indexOf(severity);
  return at === -1 ? 0 : at;
}

/** Severities this build has no rank for. Counted into the detail, never dropped. */
function unrecognisedSeverities(
  findings: FindingsGateInput['findings'],
): readonly FindingSeverity[] {
  const unknown = findings
    .map((finding) => finding.severity)
    .filter((severity) => !FINDING_SEVERITIES.includes(severity));
  return [...new Set(unknown)].sort();
}

/** Up to three of anything, then a count. Shared with the quarantine warnings. */
function few(values: readonly string[]): string {
  const head = values.slice(0, 3);
  return values.length > 3 ? `${head.join(', ')} and ${values.length - 3} more` : head.join(', ');
}

/**
 * The rows a RATE may be computed over: gating, and actually attempted.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `GateInput.results` carried no way to say "this did not run", so a test the
 * environment blocked and a test that ran and did not pass were the same row to
 * every rule here. A sharded run with eleven tests behind a dead staging box
 * therefore reported a pass rate of 0% for them: `MIN_PASS_RATE 90` BLOCKED a
 * merge over eleven tests nobody attempted, `MAX_FLAKE_RATE` divided by them,
 * and `MAX_P95_LATENCY_MS` averaged in their placeholder duration of nothing.
 * The run counters had already been fixed to keep these apart; the RULES had
 * not, so the gate went on reading an unusable environment as a failing suite.
 *
 * ── Why not `quarantined: true` ─────────────────────────────────────────────
 *
 * Because it would have worked and it would have lied. Quarantine is a
 * suppression somebody signed, it is counted against a budget, it expires, and
 * every surface renders it as "this test is not gating on purpose". A blocked
 * test is none of those things.
 */
function attempted(rows: GateInput['results']): GateInput['results'] {
  return rows.filter((row) => !row.notRun);
}

/**
 * What a rate's denominator left out, and what it could not explain.
 *
 * Both halves travel into the detail, for the reason `FindingsGateInput`'s
 * counts do: a rate computed over 8 of 11 rows is not a rate over the run, and
 * a reader who cannot see the subtraction cannot tell a healthy suite from a
 * suite three quarters of which did not execute.
 */
function denominatorNote(
  gating: GateInput['results'],
  used: GateInput['results'],
): string {
  const parts: string[] = [];

  const excluded = gating.filter((row) => row.notRun);
  if (excluded.length > 0) {
    const kinds = [...new Set(excluded.map((row) => row.notRun as NotRunKind))].sort();
    parts.push(`${excluded.length} not attempted and left out (${kinds.join(', ')})`);
  }

  /*
   * A SKIPPED row with no recorded kind is NOT taken out. "Not recorded" is the
   * fifth state and it is not a claim that the environment blocked anything, so
   * removing it from the denominator would be this rule deciding, on no
   * evidence, that a skip was unattemptable. It stays in and it is named, which
   * is the one answer that invents nothing.
   */
  const unexplained = used.filter((row) => row.status === 'SKIPPED' && !row.notRun).length;
  if (unexplained > 0) {
    parts.push(
      `${unexplained} skipped result(s) record no reason, so they are still counted — a skip ` +
        `nobody classified is not evidence that it could not be attempted`,
    );
  }

  return parts.length === 0 ? '' : `; ${parts.join('; ')}`;
}

/** The results carrying the verdict one `BLOCK_ON_VERDICT` rule refuses. */
function offendersFor(
  rule: Extract<GateRule, { kind: 'BLOCK_ON_VERDICT' }>,
  gating: GateInput['results'],
): GateInput['results'] {
  return gating.filter(
    (row) =>
      row.verdict === rule.verdict &&
      (rule.onlyPriorities.length === 0 || rule.onlyPriorities.includes(row.priority)),
  );
}

/** The failures one `BLOCK_ON_VERDICT` rule would compare, and cannot yet. */
function untriagedFor(
  rule: Extract<GateRule, { kind: 'BLOCK_ON_VERDICT' }>,
  gating: GateInput['results'],
): GateInput['results'] {
  return gating.filter(
    (row) =>
      row.verdict === null &&
      (row.status === 'FAILED' || row.status === 'TIMED_OUT') &&
      (rule.onlyPriorities.length === 0 || rule.onlyPriorities.includes(row.priority)),
  );
}

/**
 * The failures that stop this rule answering — the ONE definition of "still
 * waiting on triage".
 *
 * Empty means the rule has an answer, which is not the same as "every failure
 * has a verdict": a rule that has already found the verdict it refuses BLOCKS,
 * and waiting for the rest of triage to finish before saying so would hold a
 * decided gate open.
 *
 * It is a function rather than an expression inside the rule's arm because a
 * second reader needs the same answer: the post-triage re-score's guard, in
 * apps/worker/src/processors/checks.ts. That guard asked a different question —
 * any untriaged failure at all, with no quarantine filter and no priority
 * filter — so a run with one untriaged quarantined or IMPORTANT failure beside
 * a triaged CRITICAL_PATH one stayed provisional FOR EVER: the rule stopped
 * waiting and the guard never did. Two predicates for one question is the
 * defect; one function is the fix.
 */
function awaitingVerdict(
  rule: Extract<GateRule, { kind: 'BLOCK_ON_VERDICT' }>,
  gating: GateInput['results'],
): GateInput['results'] {
  if (offendersFor(rule, gating).length > 0) return [];
  return untriagedFor(rule, gating);
}

/**
 * The failures this rule set is still waiting on a verdict for, across every
 * `BLOCK_ON_VERDICT` rule in it. Empty means nothing is gained by scoring the
 * gate again.
 *
 * Quarantine-suppressed rows are excluded here exactly as `evaluateGates`
 * excludes them, because a suppressed failure cannot reach the rule either.
 * The ROWS are returned rather than a boolean so a caller can name the tests it
 * is waiting on; `length > 0` is the guard.
 */
export function untriagedBlockers(
  rules: readonly GateRule[],
  results: GateInput['results'],
): GateInput['results'] {
  const gating = results.filter((row) => !row.quarantined);
  const waiting = new Map<string, GateInput['results'][number]>();
  for (const rule of rules) {
    if (rule.kind !== 'BLOCK_ON_VERDICT') continue;
    for (const row of awaitingVerdict(rule, gating)) waiting.set(row.testId, row);
  }
  return [...waiting.values()];
}

/**
 * Score one rule.
 *
 * Split out of `evaluateGates` when the measurement rules arrived: eleven arms
 * of a switch assigning to two mutable locals is how an arm comes to leave
 * `passed` at its initialised `true` and report a pass it never computed. Each
 * arm now has to RETURN an answer, so a missing one cannot default to green.
 */
function scoreRule(rule: GateRule, gating: GateInput['results'], input: GateInput): RuleOutcome {
  switch (rule.kind) {
    case 'BLOCK_ON_VERDICT': {
      const offenders = offendersFor(rule, gating);
      /*
       * A failure with no verdict is not "no REAL_BUG verdict". It is a failure
       * nobody has triaged yet, and scoring this rule against it is how the
       * default gate reported a pass on a run with real failures — the gate was
       * computed at finalisation, before any verdict row existed. The rule now
       * refuses to answer while a failure that COULD carry the verdict it looks
       * for has none, and `rescoreGate` scores it again once triage has run.
       */
      const untriaged = awaitingVerdict(rule, gating);
      if (untriaged.length > 0) {
        return unmeasured(
          `${untriaged.length} failing test(s) have not been triaged, so there is no verdict to ` +
            `compare: ${few(untriaged.map((o) => o.testName))}. The gate is scored again when ` +
            `triage finishes.`,
        );
      }
      return {
        passed: offenders.length === 0,
        detail:
          offenders.length === 0
            ? `No ${rule.verdict} verdicts`
            : `${offenders.length} ${rule.verdict} verdict(s): ${few(offenders.map((o) => o.testName))}`,
      };
    }

    case 'MAX_FLAKE_RATE': {
      const ran = attempted(gating);
      if (ran.length === 0) {
        return unmeasured(
          'no test in this run both gates and was attempted, so there is no flake rate to ' +
            'compute. A test nobody could attempt is not a test that did not flake.',
        );
      }
      const flaky = ran.filter((r) => r.status === 'FLAKY' || r.retriedAndPassed).length;
      const rate = (flaky / ran.length) * 100;
      return {
        passed: rate <= rule.ratePercent,
        detail:
          `${rate.toFixed(1)}% flaky (${flaky}/${ran.length})` + denominatorNote(gating, ran),
      };
    }

    case 'MAX_P95_LATENCY_MS': {
      const ran = attempted(gating);
      if (ran.length === 0) {
        return unmeasured(
          'no test in this run both gates and was attempted, so there is no p95 to compute. A ' +
            'test that was never started has no duration — its row holds a placeholder, not a ' +
            'measurement.',
        );
      }
      const p95 = percentile(
        ran.map((r) => r.durationMs),
        95,
      );
      return {
        passed: p95 <= rule.ms,
        detail: `p95 was ${p95}ms` + denominatorNote(gating, ran),
      };
    }

    case 'MIN_PASS_RATE': {
      /*
       * An empty gating set used to score 100%, which is the reassuring lie this
       * file exists to end: a run in which every test is quarantined, or which
       * selected nothing, would report a perfect pass rate. There is no rate
       * without a denominator.
       */
      const ran = attempted(gating);
      if (ran.length === 0) {
        return unmeasured(
          'no test in this run both gates and was attempted — every result was quarantined, ' +
            'deselected, or could not be attempted — so there is no pass rate. An empty suite is ' +
            'not a 100% pass rate.',
        );
      }
      const passedCount = ran.filter((r) => r.status === 'PASSED').length;
      const rate = (passedCount / ran.length) * 100;
      return {
        passed: rate >= rule.ratePercent,
        detail:
          `${rate.toFixed(1)}% passed (${passedCount}/${ran.length})` +
          denominatorNote(gating, ran),
      };
    }

    case 'MAX_QUARANTINE_PERCENT': {
      /*
       * Scored by `evaluateQuarantineHealth`, which is appended after the
       * configured rules and reads the PROJECT rather than the run. A project
       * that writes this kind into its own rule list gets the honest answer that
       * its list is not where this rule is read from.
       */
      return unmeasured(
        'the quarantine budget is evaluated from the project, not from a configured rule — the ' +
          'evaluator appends it to every gate and a project cannot configure it away.',
      );
    }

    case 'MIN_COVERAGE': {
      const snapshot = input.coverage;
      if (!snapshot) {
        /*
         * This used to say "this project has no stored coverage snapshot",
         * which is a claim about the customer's data made from our own
         * silence — and a false one on the common path: an absent field means
         * the CALLER assembled no coverage input, which is what every
         * finalisation gate does today. The honest sentence names the read.
         */
        return unmeasured(
          'no coverage snapshot was read by whatever scored this gate, so there is no percentage ' +
            'to hold to a floor. That is NOT the same as this project having none: if a snapshot ' +
            'exists, this rule is being scored somewhere that does not read one, and it will ' +
            'report this on every such run. If none exists, compute one — the coverage endpoint, ' +
            'or the recompute-coverage job.',
        );
      }
      if (snapshot.percent === null) {
        return unmeasured(
          `the coverage denominator is empty (${snapshot.denominator} item(s)), so the percentage ` +
            `is NULL rather than 0 — the extractor found nothing to measure, which is not the ` +
            `same as nothing being covered.`,
        );
      }
      const measuredAt = `measured ${snapshot.measuredAtIso}${
        snapshot.commitSha ? ` at ${snapshot.commitSha.slice(0, 7)}` : ' (no commit recorded)'
      }`;
      return {
        passed: snapshot.percent >= rule.percent,
        detail:
          `${snapshot.percent}% of ${snapshot.denominator} surface item(s) covered ` +
          `(${snapshot.covered}), ${measuredAt}`,
      };
    }

    case 'MIN_PATCH_COVERAGE': {
      const patch = input.patch;
      if (!patch) {
        return unmeasured(
          'no diff was joined to the coverage inventory for this run, so the changed surface is ' +
            'unknown. Patch coverage needs the pull request’s changed files.',
        );
      }
      if (!patch.measured || patch.denominator === 0) {
        return unmeasured(
          patch.caveats[0] ??
            'the diff touched no route the coverage inventory knows, so there is nothing to divide.',
        );
      }
      const percent = patch.percent;
      if (percent === null) {
        return unmeasured('the changed surface has no denominator, so there is no percentage.');
      }
      return {
        passed: percent >= rule.percent,
        detail:
          `${percent}% of the ${patch.denominator} changed route(s) covered (${patch.covered} ` +
          `covered, ${patch.uncovered} with no test, ${patch.assertedNotRun} asserted but never ` +
          `run, ${patch.unknown} unknown, ${patch.waived} waived, ${patch.unrecognised} not in ` +
          `the inventory)` + caveatNote(patch),
      };
    }

    case 'NO_NEW_UNCOVERED_ROUTES': {
      const patch = input.patch;
      if (!patch) {
        return unmeasured(
          'no diff was joined to the coverage inventory for this run, so which routes it touches ' +
            'is unknown.',
        );
      }
      if (!patch.measured || patch.denominator === 0) {
        return unmeasured(
          patch.caveats[0] ??
            `the diff touched no route the coverage inventory knows` +
              (patch.unrecognised > 0
                ? `; ${patch.unrecognised} changed route(s) have no inventory row at all, which is ` +
                  `a new route, a rename or a stale inventory and cannot be told apart from here.`
                : '.'),
        );
      }
      const offenders = patch.routes.filter((route) => route.state === 'UNCOVERED');
      return {
        passed: offenders.length === 0,
        detail:
          (offenders.length === 0
            ? `every one of the ${patch.denominator} changed route(s) the inventory knows has a test`
            : `${offenders.length} changed route(s) have no test: ${few(
                offenders.map((route) => route.route),
              )}`) + caveatNote(patch),
      };
    }

    case 'MAX_FINDINGS': {
      const read = input.findings;
      if (!read) {
        return unmeasured(
          'this run’s findings were not read by whatever scored this gate, so a critical ' +
            'accessibility or security violation could be sitting in one and this rule would not ' +
            'know. A gate scored without a findings read reports this however many findings the ' +
            'run filed, so a project that configured this rule and sees it on every run is ' +
            'reading a gate nobody assembled findings for.',
        );
      }
      /*
       * A filter this build does not understand cannot be applied.
       *
       * `onlyKinds` comes out of a Json column: a project configured against a
       * newer vocabulary (or a hand-edited row) can name a kind this build has
       * never heard of, and the filter would then match nothing and report a
       * clean pass — a gate switched off by a typo. Unknown is unmeasured.
       */
      const unknownKinds = rule.onlyKinds.filter((kind) => !FINDING_KINDS.includes(kind));
      if (unknownKinds.length > 0) {
        return unmeasured(
          `this rule filters on finding kind(s) this build does not know (${few(unknownKinds)}), ` +
            `so the filter cannot be applied — and a filter that matches nothing would report a ` +
            `pass.`,
        );
      }

      const threshold = severityRank(rule.atOrAbove);
      const matching = read.findings.filter(
        (finding) =>
          severityRank(finding.severity) <= threshold &&
          (rule.onlyKinds.length === 0 || rule.onlyKinds.includes(finding.kind)),
      );
      const excluded =
        (read.excludedMuted ?? 0) > 0 || (read.excludedQuarantined ?? 0) > 0
          ? ` (${read.excludedMuted ?? 0} muted and ${read.excludedQuarantined ?? 0} from ` +
            `quarantined test(s) were left out and do not gate)`
          : '';
      /*
       * The cost of ranking an unrecognised severity as the worst, said out
       * loud rather than left in `severityRank`'s docstring: these findings are
       * counted because dropping them would suppress a failure, and a team
       * reading this block has to be able to tell them from a real critical.
       */
      const unknownMatching = matching.filter(
        (finding) => !FINDING_SEVERITIES.includes(finding.severity),
      );
      const unknownNote =
        unknownMatching.length > 0
          ? `. ${unknownMatching.length} of these carry a severity this build does not know ` +
            `(${few(unrecognisedSeverities(unknownMatching))}) and are counted as the worst ` +
            `rather than dropped`
          : '';
      /*
       * A capped list cannot clear this rule. If the caller dropped rows and the
       * ones it kept are under the cap, the honest answer is that nobody counted
       * the rest — a pass here would be a claim about rows no query returned.
       * Over the cap is still a FAIL, because more rows can only make it worse.
       */
      if (read.truncated && matching.length <= rule.max) {
        return unmeasured(
          `the findings list was capped before it was counted, and the ${matching.length} that ` +
            `were read are under the cap of ${rule.max} — so a pass would be a claim about rows ` +
            `nobody counted.${excluded}`,
        );
      }
      return {
        passed: matching.length <= rule.max,
        detail:
          `${matching.length} finding(s) at or above ${rule.atOrAbove}` +
          (rule.onlyKinds.length ? ` in ${rule.onlyKinds.join('/')}` : '') +
          `, cap ${rule.max}` +
          (matching.length > 0
            ? `: ${few(matching.map((f) => `${f.code} at ${f.location}`))}`
            : '') +
          excluded +
          unknownNote,
      };
    }

    case 'MIN_MUTATION_SCORE': {
      const mutation = input.mutation;
      if (!mutation) {
        return unmeasured(
          'no mutation data was read by whatever scored this gate. That is a fact about the read ' +
            'and not about the suite — the mutation columns may well hold a score.',
        );
      }
      if (mutation.resultsWithData === 0) {
        return unmeasured(
          'no mutation test ran in this run — every mutation column is NULL, which means not ' +
            'measured. It is not a score of 0: 0 would mean every mutant survived.',
        );
      }
      const valid = mutation.detected + mutation.undetected;
      if (valid === 0) {
        return unmeasured(
          `a mutation run reported no valid mutant (${mutation.excluded} excluded as non-viable), ` +
            `so there was no denominator to divide by.`,
        );
      }
      const score = Math.round((mutation.detected / valid) * 1000) / 10;
      return {
        passed: score >= rule.percent,
        detail:
          `${score}% of ${valid} valid mutant(s) killed (${mutation.detected} killed, ` +
          `${mutation.undetected} survived, ${mutation.excluded} excluded) across ` +
          `${mutation.resultsWithData} mutation result(s)`,
      };
    }

    case 'MAX_VITAL_BREACHES': {
      const vitals = input.vitals;
      if (!vitals) {
        return unmeasured(
          'no performance data was read by whatever scored this gate, so this says nothing about ' +
            'the budgets — the breaches may well be stored.',
        );
      }
      if (vitals.performanceTests === 0) {
        return unmeasured(
          'no performance test ran in this run, so zero breaches is a fact about the suite rather ' +
            'than about the pages.',
        );
      }
      const matching =
        rule.metric === 'ANY'
          ? vitals.breaches
          : vitals.breaches.filter((breach) => breach.metric === rule.metric);
      /*
       * A capped list cannot clear this rule, for the reason the `MAX_FINDINGS`
       * arm above gives: the breaches ride on the findings list, the findings
       * read is capped, and a pass computed over the rows that happened to fit
       * would be a claim about a budget nobody checked. Over the cap is still a
       * FAIL, because rows nobody read can only make it worse.
       */
      if (vitals.truncated && matching.length <= rule.max) {
        return unmeasured(
          `the findings list the breaches ride on was capped before it was counted, and the ` +
            `${matching.length} breach(es) that were read are within the cap of ${rule.max} — so ` +
            `a pass would be a claim about budgets nobody checked.`,
        );
      }
      return {
        passed: matching.length <= rule.max,
        detail:
          `${matching.length} budget breach(es)` +
          (rule.metric === 'ANY' ? '' : ` on ${rule.metric}`) +
          ` across ${vitals.performanceTests} performance test(s), cap ${rule.max}` +
          (matching.length > 0
            ? `: ${few(matching.map((breach) => `${breach.metric} at ${breach.location}`))}`
            : ''),
      };
    }

    case 'ENVIRONMENT_AVAILABLE': {
      /*
       * UNMEASURED from a CONFIGURED rule, always, and that is not a stub.
       *
       * The real evaluation is built by the run finaliser
       * (`environmentGateEvaluation` in apps/worker/src/processors/run.ts) and
       * APPENDED to the result, the way the quarantine alarm is appended below:
       * it is the only caller that holds the policy this rule needs — which
       * tests were blocked and by name, which failures triage called the
       * environment's fault, and whether NOTHING could be attempted (BLOCK) or
       * only part of the suite (WARN).
       *
       * `GateInput.results[].notRun` now carries the blocked rows, so scoring
       * this here is reachable — and it would be a SECOND implementation of
       * that policy, which is the defect this file's header exists to have
       * ended. A project rule list is also the wrong home for it: a run in
       * which nothing was measured must not be able to merge, and a brake a
       * project can delete is not a brake.
       *
       * So a project that writes this kind into its own rules gets told where
       * the answer actually comes from, rather than a PASS this function has no
       * input to justify. `rescoreGate` carries the finaliser's evaluation
       * forward for the same reason.
       */
      return unmeasured(
        'the environment evaluation is produced by the run finaliser, which knows which tests ' +
          'were blocked and why, and is appended to every gate — a rule configured on the ' +
          'project has nothing here to score, and a PASS would be this file certifying an ' +
          'environment it was given no policy about.',
      );
    }
  }
}

/** The caveats, carried into the sentence a reviewer reads rather than dropped. */
function caveatNote(patch: PatchCoverage): string {
  if (patch.caveats.length === 0) return '';
  const head = patch.caveats.slice(0, 2).join(' ');
  return `. ${head}${patch.caveats.length > 2 ? ` (+${patch.caveats.length - 2} more caveat(s))` : ''}`;
}

export function evaluateGates(rules: GateRule[], input: GateInput): GateResult {
  // Quarantined tests are excluded from every rule, not just the verdict rule —
  // a lane of known-flaky tests must not drag the pass rate below a threshold.
  const gating = input.results.filter((r) => !r.quarantined);
  const evaluations: GateResult['evaluations'] = [];

  for (const rule of rules) {
    const outcome = scoreRule(rule, gating, input);

    /*
     * The three-way. `passed === null` is UNMEASURED and reaches neither the
     * pass column nor the block column; everything else behaves as it always
     * did, with BLOCK_ON_VERDICT the one rule whose failure always blocks.
     */
    const action: GateAction =
      outcome.passed === null
        ? 'UNMEASURED'
        : outcome.passed
          ? 'PASS'
          : rule.kind === 'BLOCK_ON_VERDICT'
            ? 'BLOCK'
            : rule.action;

    evaluations.push({
      rule,
      passed: outcome.passed,
      action,
      detail: `${describe(rule)} — ${outcome.detail}`,
    });
  }

  /*
   * The quarantine alarm is appended AFTER the configured rules, and is not one
   * of them. A project cannot switch it off by writing its own rule list: the
   * budget exists to bound the mechanism that switches signals off, and a brake
   * the thing it brakes can remove is not a brake.
   */
  if (input.quarantine) evaluations.push(...evaluateQuarantineHealth(input.quarantine));

  return {
    passed: evaluations.every((e) => e.action !== 'BLOCK'),
    evaluations,
    /*
     * Counted here rather than left to each surface to derive. A gate showing
     * six rules of which two had no input is not a gate that scored six rules,
     * and the number is what lets a reader see that without reading every
     * detail string.
     */
    unmeasured: evaluations.filter((e) => e.action === 'UNMEASURED').length,
  };
}

/**
 * The default rule set a new project gets (§4). Deliberately conservative:
 * only a real bug on a critical-path test blocks, everything else warns, so a
 * team's first week with QAAI does not turn into a wall of red builds.
 *
 * The measurement rules above — coverage, patch coverage, findings, mutation
 * score, vitals — are deliberately NOT in here. Each of them reads a
 * measurement a given project may not be taking yet, so adding one to the
 * default would hand every new install a gate that reports "not measured" on
 * day one. They are opt-in, and the honest third state is what makes them safe
 * to turn on before the measurement exists rather than after.
 */
export const DEFAULT_GATE_RULES: GateRule[] = [
  { kind: 'BLOCK_ON_VERDICT', verdict: BLOCKING_VERDICTS[0]!, onlyPriorities: ['CRITICAL_PATH'] },
  { kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'WARN' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Re-scoring after triage: what supersedes, and what may never happen quietly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a re-score decided, and whether anything should be written.
 *
 * `gate: null` is the common case on a repeat — a re-score that produces the
 * same evaluations writes nothing at all, which is what makes this idempotent
 * rather than merely repeatable. The checks processor is driven by a sweep that
 * ticks every minute and by webhooks that redeliver, so "runs twice" is the
 * normal case, not the edge one.
 */
export interface GateRescoreDecision {
  /** The result to persist, or null when the re-score changed nothing. */
  gate: GateResult | null;
  changed: boolean;
  /** True when a gate that had already reported a pass now BLOCKS. */
  reversedGreen: boolean;
  /** Printable verbatim: the log line, and the sentence on the row. */
  reason: string;
  /** What the superseded result said, or null when there was nothing to read. */
  previousPassed: boolean | null;
  /** 1 for a first scoring, 2+ for a re-score. */
  generation: number;
  /**
   * Evaluations kept from the stored gate because this re-score did not measure
   * them. Never implicit: a re-score that moved an evaluation it could not
   * recompute has to be able to say how many.
   */
  carriedForward: number;
}

/**
 * Key-sorted JSON, so two objects that mean the same thing compare equal.
 *
 * This is the whole of the idempotence, and it is not pedantry: the previous
 * gate comes back out of a Postgres `jsonb` column, and jsonb does not preserve
 * key order. A plain `JSON.stringify` comparison against a freshly built object
 * would therefore differ on EVERY read, so every sweep tick would decide the
 * gate had changed, rewrite the row and increment the generation — an
 * accumulating counter dressed up as a supersede.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members are dropped by JSON.stringify on the way INTO the
    // column, so they must be dropped on the way out of a fresh object too or
    // an optional field would read as a change.
    .filter(([, held]) => held !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`).join(',')}}`;
}

/**
 * The `passed` flag as the stored value claims it, whether or not the rest of
 * the row is readable.
 *
 * It exists for one case, and that case was found by a test rather than by
 * reasoning: a stored gate that says `passed: false` and carries no readable
 * evaluations. Treating that as "nothing was stored" and replacing it with a
 * freshly computed PASS would clear a block whose reason nobody can account
 * for — a quiet green produced by the function written to stop quiet greens.
 */
function claimedPassed(stored: unknown): boolean | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const held = (stored as { passed?: unknown }).passed;
  return typeof held === 'boolean' ? held : null;
}

/** The stored gate, read the way every Json column in this product is read: defensively. */
function readStoredGate(
  stored: unknown,
): { passed: boolean; evaluations: unknown[]; generation: number } | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const row = stored as Record<string, unknown>;
  if (typeof row.passed !== 'boolean' || !Array.isArray(row.evaluations)) return null;
  const rescored = row.rescored as Record<string, unknown> | undefined | null;
  const generation =
    rescored && typeof rescored.generation === 'number' && Number.isFinite(rescored.generation)
      ? Math.max(1, Math.trunc(rescored.generation))
      : 1;
  return { passed: row.passed, evaluations: row.evaluations, generation };
}

// ─────────────────────────────────────────────────────────────────────────────
// What a re-score may not drop.
//
// THE DEFECT, and it is the worst one re-scoring has had. `evaluateGates`
// cannot produce every evaluation a stored gate holds: the environment line is
// APPENDED by the run finaliser, which is the only caller that knows which
// tests were blocked and why. A re-score replaces the evaluations wholesale —
// that is what "supersede, never accumulate" means — so the first re-score of
// such a gate silently deleted it.
//
// On a WARN that cost the report ("2 test(s) could not be attempted because the
// environment was not usable" simply vanished). On a BLOCK it cleared a
// refusal: a sharded run whose every selected test was of an unsupported type
// took the unattemptable BLOCK — "there is no verdict here, so nothing may
// merge on the strength of it" — and the re-score rewrote the gate
// `passed: true`, relabelled the run PASSED, and reported "2 evaluation(s)
// changed once the verdicts existed". Nothing about the verdicts had changed.
// A green merge box over a run that executed nothing, produced by the function
// written to stop green merge boxes over broken runs.
//
// THE RULE NOW: an evaluation this re-score did not measure is CARRIED FORWARD
// verbatim, or the re-score refuses and says why. It is never dropped, and the
// count is on the decision.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One stored evaluation, read back out of the `jsonb` column defensively.
 *
 * Returns null for anything that is not an evaluation this file could have
 * written. The caller does not treat that as "nothing was there" — see
 * `rescoreGate`, which refuses rather than discarding it.
 */
function readStoredEvaluation(stored: unknown): GateResult['evaluations'][number] | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const row = stored as Record<string, unknown>;
  const rule = row.rule as { kind?: unknown } | undefined | null;
  if (!rule || typeof rule !== 'object' || typeof rule.kind !== 'string') return null;
  const action = row.action;
  if (action !== 'PASS' && action !== 'WARN' && action !== 'BLOCK' && action !== 'UNMEASURED') {
    return null;
  }
  if (typeof row.detail !== 'string') return null;
  if (row.passed !== null && typeof row.passed !== 'boolean') return null;
  return { rule: row.rule as GateRule, passed: row.passed, action, detail: row.detail };
}

/**
 * The evaluation kinds that are APPENDED to a gate rather than configured as a
 * rule — and which are therefore the only ones a re-score can lose by accident.
 *
 * Every other kind is in a gate because the project's rule list put it there,
 * so its absence from a fresh scoring is the customer's own configuration
 * change and superseding it is correct. These two are in a gate because the
 * evaluator or the finaliser appended them, on purpose, where a project could
 * not switch them off:
 *
 *   MAX_QUARANTINE_PERCENT — `evaluateQuarantineHealth`, from the PROJECT's
 *   quarantine state, and only when the caller could read it.
 *   ENVIRONMENT_AVAILABLE — the run finaliser, from facts only it holds.
 *
 * Both exist to bound a mechanism that switches signals off. A re-score that
 * dropped one would be the thing they are a brake on, performed by the brake.
 */
const APPENDED_GATE_KINDS: ReadonlyArray<GateRule['kind']> = [
  'MAX_QUARANTINE_PERCENT',
  'ENVIRONMENT_AVAILABLE',
];

/**
 * The stored evaluations this re-score did not measure, so may not drop.
 *
 * "Did not measure" is the test, not "produced no line of that kind". A
 * re-score can hold a rule of the same kind and still not have scored it: a
 * project that writes `ENVIRONMENT_AVAILABLE` into its own rule list gets an
 * UNMEASURED line saying where that answer really comes from, and reading that
 * line as a recomputation would delete the finaliser's real one. So a stored
 * evaluation is superseded only by an evaluation of its kind that has an answer
 * (`passed !== null`).
 *
 * And only a MEASURED line is carried. An UNMEASURED one is not a measurement
 * anybody is losing — replacing "nobody measured this" with a fresh scoring
 * drops nothing — and carrying it would leave a stale "not measured" line on
 * the gate after the project had removed the rule that produced it.
 *
 * Null means a stored evaluation could not be read at all. The caller refuses
 * the whole re-score in that case: an evaluation nobody can account for must not
 * be deleted on the strength of not understanding it, which is the rule
 * `claimedPassed` already applies one level up.
 */
function carriedEvaluations(
  stored: readonly unknown[],
  next: GateResult,
): GateResult['evaluations'] | null {
  const measured = new Set(
    next.evaluations.filter((e) => e.passed !== null).map((e) => e.rule.kind as string),
  );
  const carried: GateResult['evaluations'] = [];

  for (const row of stored) {
    const evaluation = readStoredEvaluation(row);
    if (!evaluation) return null;
    if (!APPENDED_GATE_KINDS.includes(evaluation.rule.kind)) continue;
    if (evaluation.passed === null) continue;
    if (measured.has(evaluation.rule.kind)) continue;
    carried.push(evaluation);
  }

  return carried;
}

/** The BLOCK details, which is what every "why did this refuse" sentence lists. */
function blockingDetails(gate: GateResult): string[] {
  return gate.evaluations
    .filter((evaluation) => evaluation.action === 'BLOCK')
    .map((evaluation) => evaluation.detail);
}

/**
 * `passed` and `unmeasured`, recomputed over the evaluations that will be
 * stored.
 *
 * The same two expressions `evaluateGates` uses, applied again: a merged gate
 * whose `passed` was computed before the BLOCK was carried back in would be the
 * dropped refusal again, one line further down.
 *
 * `unmeasured` cannot move while only MEASURED evaluations are carried, and it
 * is recomputed anyway — the count and the list have to be produced by one
 * expression, or the next change to what may be carried makes the number a lie
 * about the list beside it.
 */
function withCarried(next: GateResult, carried: GateResult['evaluations']): GateResult {
  const evaluations = [...next.evaluations, ...carried];
  return {
    ...next,
    evaluations,
    passed: evaluations.every((e) => e.action !== 'BLOCK'),
    unmeasured: evaluations.filter((e) => e.action === 'UNMEASURED').length,
  };
}

/**
 * Is this stored gate still waiting on triage?
 *
 * True when a verdict rule came back UNMEASURED, which is what a gate scored at
 * finalisation looks like: the rule every new project gets is scored against
 * triage verdicts and finalisation runs before any verdict exists.
 *
 * The run page already implements this concept by hand — it recomputes
 * "awaiting triage" from the result rows and labels the chip PROVISIONAL — and
 * that was the only place in the product that knew the gate was undecided. A
 * second reader needs it (the checks sweep, to decide whether a run is worth
 * re-scoring), and two implementations of "is this gate decided yet" is how the
 * badge and the merge box come to disagree.
 */
export function gateAwaitsTriage(stored: unknown): boolean {
  const gate = readStoredGate(stored);
  if (!gate) return false;
  return gate.evaluations.some((evaluation) => {
    if (!evaluation || typeof evaluation !== 'object') return false;
    const row = evaluation as { action?: unknown; rule?: { kind?: unknown } };
    return row.action === 'UNMEASURED' && row.rule?.kind === 'BLOCK_ON_VERDICT';
  });
}

/**
 * Score the gate again, now that the verdicts exist, and decide what to write.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `gateResult` was computed in the run finaliser, which runs BEFORE triage. The
 * rule every new project gets is `BLOCK_ON_VERDICT REAL_BUG`; at finalisation
 * no `TriageVerdict` row exists, so the rule found no REAL_BUG verdicts and the
 * gate came back `passed: true` on a run with real failures. The one rule in
 * the default set could not see the verdicts it is named after, and the chip on
 * the run page said GATE — PASS beside "2 failed".
 *
 * ── The four rules this function enforces ───────────────────────────────────
 *
 * 1. SUPERSEDE, NEVER ACCUMULATE. The returned gate replaces the stored one
 *    whole. Nothing is appended, so a redelivered webhook cannot grow a gate.
 * 2. IDENTICAL IS A NO-OP. `gate: null` when the evaluations come out the same,
 *    so the generation counts real changes of mind and not queue retries.
 * 3. A GREEN THAT GOES RED SAYS SO. `reversedGreen` and the `reason` sentence
 *    name the flip. A build whose check went green and then quietly went red is
 *    how a team stops believing the check, so the transition is never silent.
 * 4. AND NOTHING IT DID NOT MEASURE IS DROPPED. Rule 1 is what made this one
 *    necessary: the environment evaluation is appended by the finaliser, so
 *    replacing the evaluations wholesale deleted it — a WARN silently, and the
 *    unattemptable BLOCK by turning a run that executed nothing green. An
 *    appended evaluation this scoring did not measure is carried forward
 *    verbatim and counted (`carriedForward`), and one that cannot be read at
 *    all refuses the whole re-score. See `APPENDED_GATE_KINDS`.
 */
export function rescoreGate(args: {
  /** `Run.gateResult` as the database holds it. */
  stored: unknown;
  /** The freshly evaluated gate. */
  next: GateResult;
  at?: Date;
}): GateRescoreDecision {
  const at = args.at ?? new Date();
  const previous = readStoredGate(args.stored);

  if (!previous) {
    /*
     * An unreadable gate that nonetheless claims a BLOCK is left alone. We
     * cannot say which rule blocked or why, so replacing it with a pass would
     * be clearing a refusal on the strength of not understanding it.
     */
    if (claimedPassed(args.stored) === false) {
      return {
        gate: null,
        changed: false,
        reversedGreen: false,
        previousPassed: false,
        generation: 1,
        carriedForward: 0,
        reason:
          'The stored gate could not be read and it reported a BLOCK, so it stands: a refusal ' +
          'whose reason is unreadable must not be cleared by a re-score that cannot account for it.',
      };
    }

    /*
     * Nothing readable was stored: a run finalised by an older worker, or by a
     * path that evaluated no gate. This is a first scoring rather than a
     * re-score, so it carries no `rescored` block — claiming to supersede a
     * result that never existed would put a `previousPassed` on the row that
     * nothing ever said.
     */
    return {
      gate: args.next,
      changed: true,
      reversedGreen: false,
      previousPassed: null,
      generation: 1,
      carriedForward: 0,
      reason:
        `This run had no readable gate result, so the gate was scored for the first time after ` +
        `triage: ${args.next.passed ? 'nothing blocked' : `BLOCKED — ${few(blockingDetails(args.next))}`}.`,
    };
  }

  /*
   * Everything the stored gate holds that this scoring did not measure, before
   * anything is compared: the comparison, the `passed` flag and the sentence
   * all have to be about the gate that will actually be written.
   */
  const carried = carriedEvaluations(previous.evaluations, args.next);
  if (carried === null) {
    return {
      gate: null,
      changed: false,
      reversedGreen: false,
      previousPassed: previous.passed,
      generation: previous.generation,
      carriedForward: 0,
      reason:
        'The stored gate holds an evaluation this build cannot read, so it stands: a re-score ' +
        'that replaced it would delete a line nobody can account for, and an evaluation that ' +
        'cannot be read cannot be shown to have been recomputed either.',
    };
  }

  const next = carried.length === 0 ? args.next : withCarried(args.next, carried);
  const blocking = blockingDetails(next);
  const carriedNote =
    carried.length === 0
      ? ''
      : ` ${carried.length} evaluation(s) this scoring did not measure were carried forward from ` +
        `the stored gate (${few([...new Set(carried.map((e) => e.rule.kind as string))].sort())}), ` +
        `so nothing it could not recompute was dropped.`;

  const same =
    canonical({ passed: previous.passed, evaluations: previous.evaluations }) ===
    canonical({ passed: next.passed, evaluations: next.evaluations });

  if (same) {
    return {
      gate: null,
      changed: false,
      reversedGreen: false,
      previousPassed: previous.passed,
      generation: previous.generation,
      carriedForward: carried.length,
      reason:
        'The gate was scored again and came out identical; nothing was written.' + carriedNote,
    };
  }

  const reversedGreen = previous.passed && !next.passed;
  const previousSet = new Set(previous.evaluations.map(canonical));
  const changedCount = next.evaluations.filter(
    (evaluation) => !previousSet.has(canonical(evaluation)),
  ).length;
  const generation = previous.generation + 1;

  /*
   * And what the stored gate held that this scoring no longer scores AT ALL.
   *
   * `changedCount` counts the evaluations in the NEW gate that the stored one
   * did not hold, so a rule that simply stopped being scored moves nothing it
   * can see. `rescoreRunGate` scores with the PROJECT's current rule list while
   * the stored gate was written from the run's frozen snapshot, so a project
   * that edits a rule out between finalisation and triage — the ordinary way to
   * stop a gate blocking — hits this: a stored `MAX_FINDINGS` BLOCK was
   * dropped, the gate flipped to PASS, and the sentence accounted for exactly
   * one change, the verdict line. The BLOCK that was the whole reason it went
   * green was named nowhere, and on the pure-removal case the reason read
   * "0 evaluation(s) changed" over a gate it had just rewritten.
   *
   * Dropping them is CORRECT — rule 1, and a rule the project deleted must stop
   * gating — so this reports rather than carries. Compared by KIND, so a rule
   * whose threshold was merely edited stays in `changedCount` where it belongs
   * and only a kind nothing scores any more is named here. Every stored row is
   * readable by now (`carriedEvaluations` refused the re-score otherwise) and
   * the unreadable ones are skipped anyway, because a count that quietly
   * included a row it could not read would be this same defect reversed.
   */
  const nextKinds = new Set(next.evaluations.map((evaluation) => evaluation.rule.kind as string));
  const droppedKinds = [
    ...new Set(
      previous.evaluations
        .flatMap((row) => {
          const evaluation = readStoredEvaluation(row);
          return evaluation ? [evaluation.rule.kind] : [];
        })
        .filter((kind) => !nextKinds.has(kind)),
    ),
  ].sort();
  const droppedNote =
    droppedKinds.length === 0
      ? ''
      : ` ${droppedKinds.length} rule kind(s) the stored gate held are no longer scored at all ` +
        `(${few(droppedKinds)}): the rule list this scoring read does not ask for them, so their ` +
        `evaluations are gone from this gate rather than recomputed.`;

  /*
   * The sentence says WHAT changed and not WHY, which is the correction to a
   * reason that used to read "N evaluation(s) changed once the verdicts
   * existed". This function is handed two gates and no account of what moved
   * between them — the verdicts, a fresh coverage snapshot, a muted finding, a
   * quarantine that expired — and on the defect that reason was printed over,
   * the verdicts were exactly what had NOT changed.
   */
  const reason = reversedGreen
    ? `This run's gate reported a PASS and now BLOCKS, scored again: ${few(blocking)}. The ` +
      `earlier pass is superseded, not deleted (generation ${generation}).${carriedNote}${droppedNote}`
    : !previous.passed && next.passed
      ? `This run's gate BLOCKED and now passes, scored again: ${changedCount} evaluation(s) ` +
        `changed since it was first scored (generation ${generation}). Test failures are counted ` +
        `separately and are not cleared by this.${carriedNote}${droppedNote}`
      : `The gate was scored again; the verdict is unchanged (` +
        `${next.passed ? 'nothing blocks' : 'still blocking'}) and ${changedCount} ` +
        `evaluation(s) changed (generation ${generation}).${carriedNote}${droppedNote}`;

  const rescored: GateRescore = {
    atIso: at.toISOString(),
    generation,
    previousPassed: previous.passed,
    reversedGreen,
    reason,
  };

  return {
    gate: { ...next, rescored },
    changed: true,
    reversedGreen,
    previousPassed: previous.passed,
    generation,
    carriedForward: carried.length,
    reason,
  };
}

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
  /**
   * How many failures were suppressed, so no surface has to pretend they were
   * not there.
   *
   * QUARANTINE PLUS EVERY OTHER KIND. It used to be `counts.quarantinedFailed`
   * alone, which was correct while quarantine was the only thing that could
   * make a red thing stop being red; a known issue, an ENV_ISSUE and a
   * retirement all do now, and a total that counted one of the five would make
   * the other four invisible on the surface a release decision is made from.
   * `suppressions` below breaks it down by kind.
   */
  suppressedFailures: number;
  /**
   * Every suppression that applied to this run, counted by kind, with the
   * sentence this product says out loud: "47 failures by 3 known issues."
   *
   * NEVER NULL and never omitted, because a surface that renders nothing when
   * nothing was suppressed is indistinguishable from one that forgot to ask —
   * `summariseSuppressions` says "Nothing was suppressed." out loud for exactly
   * that reason. A caller that passes no tallies gets that sentence, which is
   * the honest answer for a run with no suppressions and also the answer this
   * function can give without inventing a measurement.
   */
  suppressions: SuppressionSummary;
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
  /**
   * The non-quarantine suppressions that applied to this run, as a group-by
   * over `SuppressionEvent` returns them: one tally per kind.
   *
   * QUARANTINE IS NOT PASSED HERE. It arrives as `counts.quarantinedFailed`,
   * which `tallyResult` is the only writer of, and this function derives its
   * tally from that single number — because quarantine counted twice, once from
   * the counter and once from a ledger row, would be a doubled total on the one
   * surface a release decision is made from. Lesson: two facts in one field is
   * a defect even when both values are correct, and so is one fact in two.
   *
   * OPTIONAL, and absent means "this caller has no ledger to read" rather than
   * "nothing was suppressed": the two are indistinguishable in the TOTAL, which
   * is why the breakdown names the kinds it actually saw and the quarantine
   * tally is always present.
   */
  suppressions?: readonly SuppressionTally[];
}): RunOutcome {
  const { counts, gatePassed } = args;
  const forced = args.forcedStatus ?? null;
  const quarantined = Math.max(0, counts.quarantinedFailed);

  /*
   * The quarantine tally is SYNTHESISED from the counter rather than read from
   * the ledger, and that is the whole reason this function cannot be handed a
   * QUARANTINE tally by a caller. `suppressions` is the number of DISTINCT
   * suppressions, and a run has no way to count distinct quarantines from a
   * failure total — so it reports the failures and, honestly, the same number
   * of quarantines, since each quarantined failure is one quarantined test.
   */
  const tallies: SuppressionTally[] = [
    ...(quarantined > 0
      ? [
          {
            kind: 'QUARANTINE' as const,
            suppressions: quarantined,
            suppressed: quarantined,
            expired: 0,
          },
        ]
      : []),
    ...(args.suppressions ?? []).filter((tally) => tally.kind !== 'QUARANTINE'),
  ];
  const suppressions = summariseSuppressions(tallies);
  const suppressed = suppressions.suppressed;

  /*
   * The quarantine sentence is KEPT VERBATIM, because four other surfaces print
   * it and a reader who has learned what it means should not have to learn
   * again. The suppression disclosure is appended beside it rather than
   * replacing it: it is the only line that names the other four kinds, and a
   * run that passed while a known issue silenced forty failures has to say so
   * here — this `reason` is what the CLI prints and the check shows.
   */
  const quarantineNote =
    quarantined > 0
      ? ` ${quarantined} failing test(s) were quarantined, so they did not fail the build — they are still failing.`
      : '';
  const otherSuppressed = suppressed - quarantined;
  const suppressedNote =
    otherSuppressed > 0 || suppressions.expired > 0
      ? `${quarantineNote} ${suppressions.disclosure}`
      : quarantineNote;

  if (forced === 'CANCELLED') {
    return {
      status: 'CANCELLED',
      // Not a pass and not a failure of the change: nobody wanted the answer.
      // `passed: false` keeps a cancel out of the "it was green" column.
      passed: false,
      suppressedFailures: suppressed,
      suppressions,
      reason: `The run was cancelled, so it has no verdict.${suppressedNote}`,
    };
  }

  if (forced === 'ERRORED') {
    return {
      status: 'ERRORED',
      passed: false,
      suppressedFailures: suppressed,
      suppressions,
      reason: `The run did not finish, so nothing was measured.${suppressedNote}`,
    };
  }

  if (counts.failed > 0) {
    return {
      status: 'FAILED',
      passed: false,
      suppressedFailures: suppressed,
      suppressions,
      reason: `${counts.failed} test(s) failed.${suppressedNote}`,
    };
  }

  if (!gatePassed) {
    return {
      status: 'FAILED',
      passed: false,
      suppressedFailures: suppressed,
      suppressions,
      reason: `Every test that gates passed, and a quality gate blocked the run.${suppressedNote}`,
    };
  }

  return {
    status: 'PASSED',
    passed: true,
    suppressedFailures: suppressed,
    suppressions,
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
