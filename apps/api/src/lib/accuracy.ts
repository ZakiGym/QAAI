/**
 * Accuracy — the numbers QAAI reports about ITSELF.
 *
 * Every other figure this product prints is a claim about the customer's
 * application. These five are claims about us, and until this file existed
 * there were none of them:
 *
 *   1. VALIDITY. Does "covered" predict quality? Join the org's own reported
 *      defects onto the surface items they landed on and compare the escaped-
 *      defect rate on covered surface against uncovered surface.
 *   2. GENERATION SURVIVAL. `TestVersion.source` and `Test.disabledAt` have
 *      been written since the first migration and aggregated by nothing, so the
 *      share of generated tests a human later rewrote, disabled, quarantined or
 *      saw go red on its first run was unknown — which means nothing could tell
 *      whether generation was getting better or worse.
 *   3. YIELD. Acceptance rate, first-run pass rate, heal success rate. Three
 *      numbers the product's own README implies and no endpoint computes.
 *   4. TRIAGE ACCURACY. `TriageVerdict.overriddenTo` is, in the schema's own
 *      words, "what gates and what trains prompts", and the only aggregate
 *      anywhere was a PENDING count. Per verdict KIND, because a model that is
 *      right about FLAKE and wrong about ENV_ISSUE is not "85% accurate".
 *   5. SEEDED-FAULT DETECTION, aggregated per fault class from the rows
 *      `qaai bench` writes.
 *
 * ── THE RULE THIS WHOLE FILE IS ARRANGED AROUND ─────────────────────────────
 *
 * EVERY NUMBER HERE CARRIES ITS n AND ITS DEFINITION. A validity figure over
 * four defects is worse than no validity figure, because it will be quoted; an
 * override rate that blends four verdict kinds is worse than four rates,
 * because it cannot be acted on. So INSUFFICIENT_DATA is a first-class answer
 * with the count beside it, a rate whose denominator is zero is NULL rather
 * than 0, and there is no function below that returns a single blended
 * percentage.
 *
 * ── AND THE WORD THIS FILE MAY NOT USE ──────────────────────────────────────
 *
 * Nothing here presents a correlation as a cause. The field is `escapedRate`,
 * the verdict is `SUFFICIENT`, and neither is ever `PROVEN` or `PREDICTS`. A
 * team whose covered surface has fewer escaped defects may have written better
 * tests, or may have covered the easy half of the application first. This file
 * reports the two rates and the n; it does not tell anybody why.
 *
 * ── PURE FUNCTIONS OVER INJECTED ROWS ───────────────────────────────────────
 *
 * The arithmetic takes rows and returns answers — no Prisma, no Express, no
 * clock except where one is passed in. The route in the Surface phase is a thin
 * caller, and `GET /validity` can be tested without a database. The three
 * persistence helpers at the BOTTOM of the file are the exception and are
 * deliberately dull: they take a narrow client interface, honour `select`, and
 * contain no judgement at all.
 */

import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { SurfaceStatus, TestResultStatus, TestType, Verdict } from '@qaai/shared';
import {
  COVERED_STATUSES,
  EXCLUDED_STATUSES,
  HEAL_STATES,
  VERDICTS,
  coveragePercent,
  faultDetectionOutcomeSchema,
  validityBacktestSchema,
  validityVerdictSchema,
} from '@qaai/shared';
import type { HealState } from '@qaai/shared';
import type { PlanItemState, VerdictReviewState } from '../generated/prisma/client.js';

/*
 * The two self-measurement vocabularies, taken from the validators rather than
 * from the `const` arrays behind them.
 *
 * `VALIDITY_VERDICTS` and `FAULT_DETECTION_OUTCOMES` live in
 * packages/shared/src/coverage-dimensions.ts, which is not on
 * packages/shared/src/index.ts — so they cannot be imported here without
 * reaching across the workspace by relative path, which compiles and silently
 * bypasses the package entry point. The schemas built from them ARE on the
 * barrel, and going through the validator is the stronger choice anyway: it is
 * the write path, so a verdict this file could produce and the API would refuse
 * is a compile error rather than a 400 in production.
 *
 * The one-line barrel addition is in this round's needsFromOtherFiles. When it
 * lands these three declarations become plain imports and nothing else changes.
 */
export type ValidityVerdict = z.infer<typeof validityVerdictSchema>;
export type FaultDetectionOutcome = z.infer<typeof faultDetectionOutcomeSchema>;

/**
 * The fewest defects a validity back-test will compute a rate from.
 *
 * MUST EQUAL `MINIMUM_BACKTEST_DEFECTS`, and accuracy.test.ts holds it there by
 * reading the default `validityBacktestSchema` applies to `minimumDefects` —
 * which is that constant, through the barrel. A local copy with no guard would
 * be the drift this codebase has paid for twice; a local copy WITH a guard is
 * the same arrangement `commands/coverage.ts` uses for the surface vocabulary.
 *
 * Thirty is a judgement rather than a theorem: below it a single mis-attributed
 * ticket moves the reported rate by more than three percentage points, which is
 * larger than any difference this product would claim to have found.
 */
export const MINIMUM_VALIDITY_DEFECTS = 30;

/** Both rates, their inputs, and what we are willing to say about them. */
export interface ValidityBacktest {
  windowStartAt: Date;
  windowEndAt: Date;
  /** THE n. Every number below is meaningless without these five. */
  defectCount: number;
  coveredSurfaceCount: number;
  uncoveredSurfaceCount: number;
  defectsOnCovered: number;
  defectsOnUncovered: number;
  /** Defects per surface item. NULL when the verdict is not SUFFICIENT — never 0. */
  escapedRateCovered: number | null;
  escapedRateUncovered: number | null;
  verdict: ValidityVerdict;
  /** The sentence, with the n in it. "INSUFFICIENT_DATA" on its own is not actionable. */
  verdictDetail: string;
  /** The threshold that was APPLIED, disclosed rather than implied. */
  minimumDefects: number;
  /** Which tracker and which query. A rate whose input nobody can name is unreproducible. */
  defectSource: string;
  fingerprint: string;
  /** Defects that landed on a surface item nobody has a status for. Reported, never dropped. */
  defectsOnUnknownSurface: number;
  /** Defects on WAIVED surface. Out of both rates, because the item left the denominator. */
  defectsOnWaivedSurface: number;
}

/** One reported defect, and where it landed. */
export interface DefectRow {
  id: string;
  /** `CoverageItem.key` values this defect was attributed to. May be empty. */
  surfaceKeys: readonly string[];
  reportedAt: Date;
}

/** One surface item's coverage status, as the snapshot recorded it. */
export interface SurfaceStatusRow {
  key: string;
  status: SurfaceStatus;
}

/**
 * Does covered surface escape fewer defects than uncovered surface?
 *
 * ── WHAT THIS DOES AND DOES NOT CLAIM ───────────────────────────────────────
 *
 * It reports two rates and five counts. It does not claim causation, it does
 * not fit a line, and it does not produce a single "validity score" — because
 * the question a buyer asks ("does your number mean anything?") is answered by
 * seeing both rates and the n, and is NOT answered by a scalar they cannot
 * interrogate.
 *
 * ── THE FOUR WAYS THIS COULD HAVE BEEN FLATTERING ───────────────────────────
 *
 * Each of these is a specific decision below, and three of them push the
 * result in our favour if you get them wrong:
 *
 *   1. ASSERTED_NOT_RUN IS NOT COVERED. A static match is not an observed
 *      execution, so those items sit on the uncovered side. Counting them as
 *      covered would move defects onto the covered side with no test having
 *      run.
 *   2. A DEFECT ON AN UNKNOWN KEY IS NOT A DEFECT ON UNCOVERED SURFACE. It is
 *      reported as its own count. Filing it under uncovered would inflate the
 *      uncovered rate, which is the direction that makes coverage look useful.
 *   3. A WAIVED ITEM IS OUT OF BOTH SIDES. It left the denominator with an
 *      owner and an expiry, so it cannot be scored on either.
 *   4. A DEFECT ON BOTH SIDES COUNTS ON BOTH SIDES. A ticket attributed to a
 *      covered route and an uncovered endpoint is evidence about each, and the
 *      parts are therefore allowed to exceed the whole — which is why
 *      `defectCount` is reported separately and
 *      `defectsOnCovered + defectsOnUncovered` is never summed into it.
 */
export function backtestValidity(input: {
  defects: readonly DefectRow[];
  surfaces: readonly SurfaceStatusRow[];
  windowStartAt: Date;
  windowEndAt: Date;
  /** Which tracker, and which query. Required: an unnamed input is unreproducible. */
  defectSource: string;
  minimumDefects?: number;
}): ValidityBacktest {
  const minimumDefects = input.minimumDefects ?? MINIMUM_VALIDITY_DEFECTS;
  const covered = new Set<string>();
  const uncovered = new Set<string>();
  const waived = new Set<string>();

  for (const row of input.surfaces) {
    if (EXCLUDED_STATUSES.includes(row.status)) {
      waived.add(row.key);
    } else if (COVERED_STATUSES.includes(row.status)) {
      covered.add(row.key);
    } else {
      // UNCOVERED, ASSERTED_NOT_RUN and UNKNOWN. All three are "no observed
      // execution", and UNKNOWN stays in rather than being dropped — a
      // denominator that shrinks when an extractor gets worse is a denominator
      // that can be improved by breaking something.
      uncovered.add(row.key);
    }
  }

  const inWindow = input.defects.filter(
    (defect) =>
      defect.reportedAt.getTime() >= input.windowStartAt.getTime() &&
      defect.reportedAt.getTime() <= input.windowEndAt.getTime(),
  );

  let defectsOnCovered = 0;
  let defectsOnUncovered = 0;
  let defectsOnUnknownSurface = 0;
  let defectsOnWaivedSurface = 0;

  for (const defect of inWindow) {
    const keys = new Set(defect.surfaceKeys);
    const onCovered = [...keys].some((key) => covered.has(key));
    const onUncovered = [...keys].some((key) => uncovered.has(key));
    const onWaived = [...keys].some((key) => waived.has(key));
    if (onCovered) defectsOnCovered += 1;
    if (onUncovered) defectsOnUncovered += 1;
    if (!onCovered && !onUncovered) {
      if (onWaived) defectsOnWaivedSurface += 1;
      else defectsOnUnknownSurface += 1;
    }
  }

  const defectCount = inWindow.length;
  const sufficient = defectCount >= minimumDefects;
  const verdict: ValidityVerdict = sufficient ? 'SUFFICIENT' : 'INSUFFICIENT_DATA';

  // `rate` is defects PER SURFACE ITEM and is null whenever there is nothing to
  // divide — which includes the case where the verdict is insufficient, because
  // a rate printed beside INSUFFICIENT_DATA is the number that gets quoted.
  const rate = (defects: number, items: number): number | null =>
    sufficient && items > 0 ? Math.round((defects / items) * 1000) / 1000 : null;

  const fingerprint = fingerprintOf([
    'validity',
    input.windowStartAt.toISOString(),
    input.windowEndAt.toISOString(),
    input.defectSource,
    String(minimumDefects),
    String(covered.size),
    String(uncovered.size),
    ...inWindow.map((defect) => defect.id).sort(),
  ]);

  return {
    windowStartAt: input.windowStartAt,
    windowEndAt: input.windowEndAt,
    defectCount,
    coveredSurfaceCount: covered.size,
    uncoveredSurfaceCount: uncovered.size,
    defectsOnCovered,
    defectsOnUncovered,
    escapedRateCovered: rate(defectsOnCovered, covered.size),
    escapedRateUncovered: rate(defectsOnUncovered, uncovered.size),
    verdict,
    verdictDetail: sufficient
      ? `${defectCount} defect(s) in the window, at or above the ${minimumDefects} this ` +
        `comparison needs. ${defectsOnCovered} landed on covered surface (${covered.size} ` +
        `item(s)) and ${defectsOnUncovered} on uncovered (${uncovered.size} item(s)). The two ` +
        'rates are a comparison, not a causal claim: covered surface may have better tests, or ' +
        'it may be the easier half of the application.'
      : `${defectCount} defect(s) in the window, below the ${minimumDefects} this comparison ` +
        'needs. No rate is reported — at this n a single mis-attributed ticket would move it ' +
        'by more than any difference the result could claim to have found.',
    minimumDefects,
    defectSource: input.defectSource,
    fingerprint,
    defectsOnUnknownSurface,
    defectsOnWaivedSurface,
  };
}

// ─── Generation survival ────────────────────────────────────────────────────

/**
 * What became of one generated test.
 *
 * Ordered by how strong a signal each is, worst first, and the ORDER IS THE
 * PRECEDENCE: a test that was human-edited and then disabled is counted once,
 * as DISABLED. Without a stated precedence the same test lands in two buckets
 * and the percentages add up to more than 100, which is the shape of bug that
 * makes a whole dashboard untrustworthy.
 */
export const GENERATION_OUTCOMES = [
  /** Somebody turned it off. The strongest possible rejection. */
  'DISABLED',
  /**
   * A human wrote a new version over it. THE STRONGEST NEGATIVE SIGNAL THIS
   * PRODUCT CAN COLLECT: the test was kept and it was wrong, and a person spent
   * their time fixing what generation produced.
   */
  'REWRITTEN_BY_HUMAN',
  /** Quarantined. Still in the suite, gating nothing. */
  'QUARANTINED',
  /** Red the first time it ever ran, so it never worked at all. */
  'RED_ON_FIRST_RUN',
  /** The healer rewrote it and no human had to. A weak negative, not a failure. */
  'HEALED',
  /**
   * Never run. NOT a survival and NOT a failure — it is excluded from the rate
   * and counted beside it, because a generated test nobody has executed tells
   * us nothing about generation.
   */
  'NEVER_RUN',
  /** Still here, never edited by a person, green on its first run. */
  'KEPT',
] as const;
export type GenerationOutcome = (typeof GENERATION_OUTCOMES)[number];

const GENERATION_OUTCOME_PRESENT: Record<GenerationOutcome, true> = {
  DISABLED: true,
  REWRITTEN_BY_HUMAN: true,
  QUARANTINED: true,
  RED_ON_FIRST_RUN: true,
  HEALED: true,
  NEVER_RUN: true,
  KEPT: true,
};

/**
 * The presence record, and why there are two of these for one list.
 *
 * The pattern this codebase enforces for a vocabulary: a compiler-enforced
 * presence `Record` AND a run-time parity check. Eight GateRule kinds shipped
 * unsaveable for two slices because only one of the two existed. This
 * vocabulary has no zod schema (it is derived, never stored), so the run-time
 * half is the test that asserts this record's keys equal the array.
 */
export const GENERATION_OUTCOME_KINDS = Object.keys(
  GENERATION_OUTCOME_PRESENT,
) as ReadonlyArray<GenerationOutcome>;

/** The outcomes that are neither a survival nor a failure, so neither half of the rate. */
export const UNRATED_GENERATION_OUTCOMES: readonly GenerationOutcome[] = ['NEVER_RUN'];

export interface GeneratedTestRow {
  testId: string;
  type: TestType;
  /** The generator or model that produced it. NULL when the row predates the field. */
  producer: string | null;
  /** When the generated version was written. The cohort is derived from this. */
  generatedAt: Date;
  /** `TestVersion.source` of every version AFTER the generated one, in order. */
  laterSources: readonly string[];
  disabledAt: Date | null;
  quarantined: boolean;
  /**
   * The status of its first run. NULL means it has never run, which is NOT the
   * same as passing and is the distinction the whole metric turns on.
   */
  firstRunStatus: TestResultStatus | null;
}

/** First match wins. See {@link GENERATION_OUTCOMES} for why the order is the contract. */
export function generationOutcomeOf(row: GeneratedTestRow): GenerationOutcome {
  if (row.disabledAt !== null) return 'DISABLED';
  if (row.laterSources.includes('HUMAN')) return 'REWRITTEN_BY_HUMAN';
  if (row.quarantined) return 'QUARANTINED';
  if (row.firstRunStatus === null) {
    // Checked BEFORE the red branch cannot be: a null status is not a failure.
    // Checked after QUARANTINED on purpose — a quarantined test that never ran
    // was still rejected by somebody.
    return 'NEVER_RUN';
  }
  if (row.firstRunStatus === 'FAILED' || row.firstRunStatus === 'TIMED_OUT') {
    return 'RED_ON_FIRST_RUN';
  }
  if (row.laterSources.includes('HEAL')) return 'HEALED';
  return 'KEPT';
}

export interface GenerationSurvival {
  /** `cohort:2026-W43`, `type:E2E`, `producer:claude-opus-5`, or `all`. */
  group: string;
  total: number;
  counts: Readonly<Record<GenerationOutcome, number>>;
  /** total − NEVER_RUN. The n the percentage is over. */
  rated: number;
  /** KEPT / rated. NULL when nothing could be rated. */
  survivalPercent: number | null;
  /** REWRITTEN_BY_HUMAN / rated. The signal worth acting on. */
  humanRewritePercent: number | null;
}

function survivalOf(group: string, rows: readonly GeneratedTestRow[]): GenerationSurvival {
  const counts: Record<GenerationOutcome, number> = {
    DISABLED: 0,
    REWRITTEN_BY_HUMAN: 0,
    QUARANTINED: 0,
    RED_ON_FIRST_RUN: 0,
    HEALED: 0,
    NEVER_RUN: 0,
    KEPT: 0,
  };
  for (const row of rows) counts[generationOutcomeOf(row)] += 1;
  const rated = rows.length - counts.NEVER_RUN;
  return {
    group,
    total: rows.length,
    counts,
    rated,
    survivalPercent: coveragePercent(counts.KEPT, rated),
    humanRewritePercent: coveragePercent(counts.REWRITTEN_BY_HUMAN, rated),
  };
}

/**
 * ISO week of generation, as the cohort key.
 *
 * A week and not a day, because generation volume is bursty and a daily cohort
 * of three tests reports 33% survival swings as trend. ISO rather than
 * calendar, so a cohort never spans a year boundary ambiguously.
 */
export function generationCohort(at: Date): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // ISO weeks run Monday–Sunday and belong to the year containing their
  // Thursday, which is what the two shifts below implement.
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Survival by cohort, by test type and by producer — and never one number.
 *
 * Three groupings and an `all` row. The `all` row is included because a reader
 * needs the total n, and it is the only blended figure in this file: a single
 * survival percentage is still interpretable (it is one population), unlike a
 * blended detection rate across fault classes, which averages unlike things.
 */
export function generationSurvival(rows: readonly GeneratedTestRow[]): {
  overall: GenerationSurvival;
  byCohort: readonly GenerationSurvival[];
  byType: readonly GenerationSurvival[];
  byProducer: readonly GenerationSurvival[];
} {
  const group = (key: (row: GeneratedTestRow) => string): GenerationSurvival[] => {
    const buckets = new Map<string, GeneratedTestRow[]>();
    for (const row of rows) {
      const name = key(row);
      const bucket = buckets.get(name) ?? [];
      bucket.push(row);
      buckets.set(name, bucket);
    }
    return [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, bucket]) => survivalOf(name, bucket));
  };

  return {
    overall: survivalOf('all', rows),
    byCohort: group((row) => `cohort:${generationCohort(row.generatedAt)}`),
    byType: group((row) => `type:${row.type}`),
    // `producer:<unattributed>` and not a dropped row: rows written before the
    // field existed are a real population and excluding them would make the
    // producer table disagree with the overall n.
    byProducer: group((row) => `producer:${row.producer ?? '<unattributed>'}`),
  };
}

// ─── Yield ──────────────────────────────────────────────────────────────────

export interface ProposalRow {
  id: string;
  state: PlanItemState;
}

export interface HealProposalRow {
  id: string;
  state: HealState;
}

export interface FirstRunRow {
  testId: string;
  status: TestResultStatus;
}

export interface YieldTelemetry {
  /** APPROVED+GENERATED / decided. NULL when nothing has been decided yet. */
  acceptancePercent: number | null;
  proposalsDecided: number;
  proposalsPending: number;
  /** APPLIED+AUTO_APPLIED / decided heals. NULL when none were decided. */
  healSuccessPercent: number | null;
  healsDecided: number;
  healsPending: number;
  /** PASSED / first runs. NULL when no generated test has run. */
  firstRunPassPercent: number | null;
  firstRuns: number;
  /** Counted and excluded: a flaky first run is not a pass and not a failure. */
  firstRunsFlaky: number;
}

/**
 * Acceptance, heal success and first-run pass — each over its DECIDED
 * population, with the pending count beside it.
 *
 * Dividing by the total instead of by the decided set is the mistake that makes
 * every one of these numbers drift downward as a review queue grows: a team
 * that accepted every proposal it looked at and has forty waiting would read
 * as 20% acceptance. So PENDING is its own number, and `null` is the answer
 * when nothing has been decided — not 0, which would say every proposal was
 * rejected.
 */
export function yieldTelemetry(input: {
  proposals: readonly ProposalRow[];
  heals: readonly HealProposalRow[];
  firstRuns: readonly FirstRunRow[];
}): YieldTelemetry {
  const accepted = input.proposals.filter(
    (row) => row.state === 'APPROVED' || row.state === 'GENERATED',
  ).length;
  const rejected = input.proposals.filter((row) => row.state === 'REJECTED').length;
  const proposalsPending = input.proposals.filter((row) => row.state === 'PROPOSED').length;

  const healApplied = input.heals.filter(
    (row) => row.state === 'APPLIED' || row.state === 'AUTO_APPLIED',
  ).length;
  const healRejected = input.heals.filter((row) => row.state === 'REJECTED').length;
  /*
   * SUPERSEDED is in neither half, and it is the member that makes this
   * function worth reading. It means "replaced by a newer proposal for the same
   * test" — nobody judged it. Counting it as a failure would make the heal
   * success rate fall every time the healer retried, which is the opposite of
   * what a retry means.
   */
  const healsPending = input.heals.filter(
    (row) => row.state === 'PROPOSED' || row.state === 'APPROVED',
  ).length;

  const passed = input.firstRuns.filter((row) => row.status === 'PASSED').length;
  const flaky = input.firstRuns.filter((row) => row.status === 'FLAKY').length;

  return {
    acceptancePercent: coveragePercent(accepted, accepted + rejected),
    proposalsDecided: accepted + rejected,
    proposalsPending,
    healSuccessPercent: coveragePercent(healApplied, healApplied + healRejected),
    healsDecided: healApplied + healRejected,
    healsPending,
    firstRunPassPercent: coveragePercent(passed, input.firstRuns.length - flaky),
    firstRuns: input.firstRuns.length,
    firstRunsFlaky: flaky,
  };
}

// ─── Triage accuracy ────────────────────────────────────────────────────────

export interface TriageVerdictRow {
  id: string;
  verdict: Verdict;
  reviewState: VerdictReviewState;
  /** The verdict a human put in its place. Null unless reviewState is OVERRIDDEN. */
  overriddenTo: Verdict | null;
}

export interface TriageVerdictAccuracy {
  /** The verdict the MODEL produced. The rate is about this kind. */
  verdict: Verdict;
  accepted: number;
  overridden: number;
  /** Reviewed = accepted + overridden. The n. */
  reviewed: number;
  pending: number;
  muted: number;
  /** overridden / reviewed. NULL when nothing of this kind was reviewed. */
  overridePercent: number | null;
  /** What humans changed it TO, counted. The shape of the model's error. */
  overriddenTo: Readonly<Record<Verdict, number>>;
}

export interface TriageAccuracy {
  byVerdict: readonly TriageVerdictAccuracy[];
  /** Totals as COUNTS. There is deliberately no overall override percentage. */
  totals: { accepted: number; overridden: number; reviewed: number; pending: number; muted: number };
  /**
   * Rows whose reviewState says OVERRIDDEN and whose `overriddenTo` is null.
   * A data defect, reported rather than silently treated as an acceptance —
   * which is the direction that flatters the model.
   */
  overriddenWithNoReplacement: number;
}

/**
 * The override rate, PER VERDICT KIND.
 *
 * ── WHY THERE IS NO SINGLE NUMBER ───────────────────────────────────────────
 *
 * "85% accurate" is unactionable and usually wrong in a specific way: a triage
 * model that is right about FLAKE (the common case) and wrong about ENV_ISSUE
 * (the rare one) scores well and is useless, because ENV_ISSUE is the verdict
 * that stops a team investigating a bug that is not theirs. Four rates make
 * that visible; one hides it. The totals below are COUNTS, which a reader can
 * re-divide, and not a percentage, which they cannot un-blend.
 *
 * ── AND WHY A MUTE IS NOT AN ACCEPTANCE ─────────────────────────────────────
 *
 * MUTED is its own column. A human who muted a signature did not agree with the
 * verdict, they stopped hearing about it; folding those into `accepted` would
 * make the model look better the more people switched it off.
 */
export function triageAccuracy(rows: readonly TriageVerdictRow[]): TriageAccuracy {
  const byVerdict: TriageVerdictAccuracy[] = [];
  let overriddenWithNoReplacement = 0;

  for (const verdict of VERDICTS) {
    const group = rows.filter((row) => row.verdict === verdict);
    const accepted = group.filter((row) => row.reviewState === 'ACCEPTED').length;
    const overriddenRows = group.filter((row) => row.reviewState === 'OVERRIDDEN');
    const overriddenTo: Record<Verdict, number> = {
      REAL_BUG: 0,
      INTENDED_CHANGE: 0,
      FLAKE: 0,
      ENV_ISSUE: 0,
    };
    for (const row of overriddenRows) {
      if (row.overriddenTo === null) overriddenWithNoReplacement += 1;
      else overriddenTo[row.overriddenTo] += 1;
    }
    byVerdict.push({
      verdict,
      accepted,
      overridden: overriddenRows.length,
      reviewed: accepted + overriddenRows.length,
      pending: group.filter((row) => row.reviewState === 'PENDING').length,
      muted: group.filter((row) => row.reviewState === 'MUTED').length,
      overridePercent: coveragePercent(overriddenRows.length, accepted + overriddenRows.length),
      overriddenTo,
    });
  }

  return {
    byVerdict,
    totals: {
      accepted: byVerdict.reduce((sum, row) => sum + row.accepted, 0),
      overridden: byVerdict.reduce((sum, row) => sum + row.overridden, 0),
      reviewed: byVerdict.reduce((sum, row) => sum + row.reviewed, 0),
      pending: byVerdict.reduce((sum, row) => sum + row.pending, 0),
      muted: byVerdict.reduce((sum, row) => sum + row.muted, 0),
    },
    overriddenWithNoReplacement,
  };
}

// ─── Seeded-fault detection, aggregated ─────────────────────────────────────

export interface FaultResultRow {
  faultId: string;
  faultClass: string;
  outcome: FaultDetectionOutcome;
}

export interface FaultClassDetection {
  faultClass: string;
  detected: number;
  missed: number;
  notExercised: number;
  /** detected + missed. The n. */
  rated: number;
  /** detected / rated. NULL when nothing of this class could be rated. */
  detectionPercent: number | null;
}

/**
 * The detection rate per class, from the rows `qaai bench` wrote.
 *
 * The same arithmetic as `faultRatesByClass` in packages/cli/src/bench.ts, and
 * deliberately a second implementation. The CLI publishes with ZERO runtime
 * dependencies and cannot import a value from this workspace or from
 * @qaai/shared, so the two cannot share a function today.
 *
 * NOTHING CURRENTLY HOLDS THEM IN STEP, and that is a real gap rather than an
 * acceptable one: no test can import both, because apps/api does not depend on
 * @qaai/cli and nothing should make it. The fix is a shared module both read —
 * one in @qaai/shared for the API and a mirrored `const` in the CLI with a
 * parity test, the arrangement `commands/coverage.ts` already uses for the
 * surface vocabulary. It is named in this round's needsFromOtherFiles. Until it
 * lands, a change to either implementation has to be made to both by hand, and
 * the two differ in exactly one documented way: this one drops BASELINE_DIRTY
 * rows, which the CLI never produces because it refuses the whole run instead.
 *
 * BASELINE_DIRTY rows are excluded from every count: the bench writes that
 * outcome when a reading is void, and a void reading is not a miss.
 */
export function faultClassDetection(
  rows: readonly FaultResultRow[],
): readonly FaultClassDetection[] {
  const buckets = new Map<string, FaultResultRow[]>();
  for (const row of rows) {
    if (row.outcome === 'BASELINE_DIRTY') continue;
    const bucket = buckets.get(row.faultClass) ?? [];
    bucket.push(row);
    buckets.set(row.faultClass, bucket);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([faultClass, group]) => {
      const detected = group.filter((row) => row.outcome === 'DETECTED').length;
      const missed = group.filter((row) => row.outcome === 'MISSED').length;
      return {
        faultClass,
        detected,
        missed,
        notExercised: group.filter((row) => row.outcome === 'NOT_EXERCISED').length,
        rated: detected + missed,
        detectionPercent: coveragePercent(detected, detected + missed),
      };
    });
}

// ─── Persistence: the doors, and nothing else ───────────────────────────────

/*
 * Narrow delegate interfaces rather than `PrismaClient`.
 *
 * Two reasons, and the second is the one that matters. The first is testability:
 * the fakes in accuracy.test.ts are a dozen lines and honour `select`, because a
 * select-blind fake makes deleting a field from a query undetectable and two
 * defects have already survived a whole slice behind one. The second is that a
 * module typed against the whole client can reach any table, and this one has
 * business with exactly three.
 */

export interface ValidityBacktestRecord {
  id: string;
  verdict: string;
  defectCount: number;
  escapedRateCovered: number | null;
  escapedRateUncovered: number | null;
  minimumDefects: number;
  defectSource: string;
  fingerprint: string;
  createdAt: Date;
}

export interface AccuracyClient {
  validityBacktest: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<Record<string, unknown> | null>;
  };
  benchmarkRun: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }): Promise<Record<string, unknown> | null>;
  };
  benchmarkFaultResult: {
    findMany(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<Array<Record<string, unknown>>>;
  };
}

/**
 * Write one validity back-test.
 *
 * The payload goes through `validityBacktestSchema` first, and that is not
 * belt-and-braces: the schema is the only thing standing between this table and
 * a row that says SUFFICIENT beside a defect count below its own threshold, or
 * a rate beside INSUFFICIENT_DATA. Validating here means a bug in
 * `backtestValidity` is a 500 at the write rather than a flattering row a buyer
 * is later shown.
 */
export async function persistValidityBacktest(
  client: AccuracyClient,
  input: { orgId: string; projectId: string; snapshotId: string | null; backtest: ValidityBacktest },
): Promise<{ id: string }> {
  const payload = validityBacktestSchema.parse({
    snapshotId: input.snapshotId,
    windowStartAtIso: input.backtest.windowStartAt.toISOString(),
    windowEndAtIso: input.backtest.windowEndAt.toISOString(),
    defectCount: input.backtest.defectCount,
    coveredSurfaceCount: input.backtest.coveredSurfaceCount,
    uncoveredSurfaceCount: input.backtest.uncoveredSurfaceCount,
    // The parts may exceed the whole only because a defect can land on both
    // sides; `min` is applied so a genuine over-count fails the schema instead
    // of being clamped silently here.
    defectsOnCovered: input.backtest.defectsOnCovered,
    defectsOnUncovered: input.backtest.defectsOnUncovered,
    escapedRateCovered: input.backtest.escapedRateCovered,
    escapedRateUncovered: input.backtest.escapedRateUncovered,
    verdict: input.backtest.verdict,
    verdictDetail: input.backtest.verdictDetail,
    minimumDefects: input.backtest.minimumDefects,
    defectSource: input.backtest.defectSource,
    fingerprint: input.backtest.fingerprint,
  });

  return client.validityBacktest.create({
    data: {
      orgId: input.orgId,
      projectId: input.projectId,
      snapshotId: payload.snapshotId,
      windowStartAt: new Date(payload.windowStartAtIso),
      windowEndAt: new Date(payload.windowEndAtIso),
      defectCount: payload.defectCount,
      coveredSurfaceCount: payload.coveredSurfaceCount,
      uncoveredSurfaceCount: payload.uncoveredSurfaceCount,
      defectsOnCovered: payload.defectsOnCovered,
      defectsOnUncovered: payload.defectsOnUncovered,
      escapedRateCovered: payload.escapedRateCovered,
      escapedRateUncovered: payload.escapedRateUncovered,
      verdict: payload.verdict,
      verdictDetail: payload.verdictDetail,
      minimumDefects: payload.minimumDefects,
      defectSource: payload.defectSource,
      fingerprint: payload.fingerprint,
    },
  });
}

/** The read half. `GET /validity` is a thin caller over this. */
export async function loadLatestValidityBacktest(
  client: AccuracyClient,
  input: { orgId: string; projectId: string },
): Promise<ValidityBacktestRecord | null> {
  const row = await client.validityBacktest.findFirst({
    where: { orgId: input.orgId, projectId: input.projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      verdict: true,
      defectCount: true,
      escapedRateCovered: true,
      escapedRateUncovered: true,
      minimumDefects: true,
      defectSource: true,
      fingerprint: true,
      createdAt: true,
    },
  });
  return row === null ? null : (row as unknown as ValidityBacktestRecord);
}

export interface BenchmarkRunInput {
  orgId: string;
  projectId: string;
  seed: string;
  suiteId: string | null;
  runId: string | null;
  faultCount: number;
  /** NULL when the bench did not complete. 0 detected is a result; unfinished is not. */
  detectedCount: number | null;
  missedCount: number | null;
  notExercisedCount: number | null;
  baselineCleanBefore: boolean;
  baselineCleanAfter: boolean | null;
  startedAt: Date;
  finishedAt: Date | null;
  caveats: readonly string[];
  results: readonly {
    faultId: string;
    faultClass: string;
    surfaceItemKey: string | null;
    outcome: FaultDetectionOutcome;
    detail: string;
    detectedByTestId: string | null;
  }[];
}

/**
 * Write a benchmark run and its per-fault results as ONE statement.
 *
 * Nested rather than two calls, so the write is atomic without a transaction: a
 * run row with half its results is a class rate computed over a partial
 * population, which is worse than no row at all because it looks complete. The
 * unique constraint on (benchmarkRunId, faultId) then makes the whole thing
 * idempotent on a retry.
 *
 * `finishedAt` non-null with any count null is refused by
 * `benchmarkRunSchema`, which is the guard that stops a detection-only run
 * being persisted as a finished benchmark with two invented zeros.
 */
export async function persistBenchmarkRun(
  client: AccuracyClient,
  input: BenchmarkRunInput,
): Promise<{ id: string }> {
  return client.benchmarkRun.create({
    data: {
      orgId: input.orgId,
      projectId: input.projectId,
      seed: input.seed,
      suiteId: input.suiteId,
      runId: input.runId,
      faultCount: input.faultCount,
      detectedCount: input.detectedCount,
      missedCount: input.missedCount,
      notExercisedCount: input.notExercisedCount,
      baselineCleanBefore: input.baselineCleanBefore,
      baselineCleanAfter: input.baselineCleanAfter,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      caveats: [...input.caveats],
      fingerprint: fingerprintOf([
        'bench',
        input.seed,
        String(input.faultCount),
        ...input.results.map((result) => `${result.faultId}:${result.outcome}`).sort(),
      ]),
      faultResults: {
        create: input.results.map((result) => ({
          orgId: input.orgId,
          faultId: result.faultId,
          faultClass: result.faultClass,
          surfaceItemKey: result.surfaceItemKey,
          outcome: result.outcome,
          detail: result.detail,
          detectedByTestId: result.detectedByTestId,
        })),
      },
    },
  });
}

export interface BenchmarkRunSummary {
  id: string;
  seed: string;
  faultCount: number;
  detectedCount: number | null;
  missedCount: number | null;
  notExercisedCount: number | null;
  baselineCleanBefore: boolean;
  baselineCleanAfter: boolean | null;
  finishedAt: Date | null;
  caveats: unknown;
  /** Per class, computed from the rows rather than stored — see {@link faultClassDetection}. */
  byClass: readonly FaultClassDetection[];
  /**
   * False when nothing in the summary may be quoted: the baseline was dirty at
   * one end, or the run never finished. Derived here so no caller has to
   * remember the rule.
   */
  quotable: boolean;
}

/** The read half of the benchmark, and the only place the class rates are derived. */
export async function loadLatestBenchmarkRun(
  client: AccuracyClient,
  input: { orgId: string; projectId: string },
): Promise<BenchmarkRunSummary | null> {
  const run = await client.benchmarkRun.findFirst({
    where: { orgId: input.orgId, projectId: input.projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      seed: true,
      faultCount: true,
      detectedCount: true,
      missedCount: true,
      notExercisedCount: true,
      baselineCleanBefore: true,
      baselineCleanAfter: true,
      finishedAt: true,
      caveats: true,
    },
  });
  if (run === null) return null;

  const results = await client.benchmarkFaultResult.findMany({
    where: { orgId: input.orgId, benchmarkRunId: String(run.id) },
    select: { faultId: true, faultClass: true, outcome: true },
  });

  const summary = run as unknown as Omit<BenchmarkRunSummary, 'byClass' | 'quotable'>;
  return {
    ...summary,
    byClass: faultClassDetection(results as unknown as FaultResultRow[]),
    quotable:
      summary.baselineCleanBefore && summary.baselineCleanAfter === true && summary.finishedAt !== null,
  };
}

/**
 * A stable digest of the inputs a figure was computed from.
 *
 * Sorted and joined with a separator that cannot appear in an id, so two runs
 * over the same rows produce the same fingerprint and a reader can tell "this
 * is the same measurement" from "this is a new one that happens to agree".
 */
function fingerprintOf(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 64);
}

/** Exported for the parity test that holds the local mirrors to the shared lists. */
export const ACCURACY_VOCABULARY = { HEAL_STATES, VERDICTS, GENERATION_OUTCOME_KINDS } as const;
