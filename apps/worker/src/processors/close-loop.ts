/**
 * The close-the-gaps loop: measure, spend a budget closing the worst of what is
 * uncovered, measure again, and STOP when the number has stopped moving.
 *
 * ── THE DEFECTS, VERBATIM FROM THE REGISTER ─────────────────────────────────
 *
 *   "Re-measure loop: a coverage queue that re-crawls, recomputes, snapshots
 *    and stops when the delta is small" — POST /propose queues generation and
 *    ends; there is no loop.
 *
 *   "Budgeted closure campaign with a project coverage target" — caps are per
 *    request (25 proposals, 12/40 plan items) and the overflow becomes prose
 *    telling a human to click again.
 *
 *   "Closure autopilot (scheduled close-the-top-K with an approval policy and a
 *    nightly budget)" — closure is seven manual steps across three screens.
 *
 * All three are one missing component. Everything needed to close a gap already
 * exists and works: the gap report is deterministic, `planItemForGap` turns a
 * gap into a proposal with no model call, the Generator writes the code, and
 * the recompute job re-measures. What was missing is the thing that drives
 * them in a circle on its own and knows when to get out.
 *
 * ── THE ANTI-SPIN ARGUMENT, WHICH IS THE WHOLE DESIGN ───────────────────────
 *
 * A loop whose own output decides whether it runs again is the shape of every
 * runaway worker ever written, and this one spends money: every item is a model
 * call and, eventually, a browser. So the stop is not one rule, it is seven,
 * and seven of the eight branches of `decideTick` are exits:
 *
 *   1. THERE IS NO BUDGET LEFT TO SPEND. One campaign per project per UTC day,
 *      enforced by `@@unique([projectId, dayKey])` on the row. Not a counter
 *      something has to reset — a unique index, which a retry cannot defeat.
 *   2. THE NUMBER HAS STOPPED MOVING. Two consecutive ticks inside
 *      CLOSE_LOOP_SETTLE_DELTA_POINTS and the campaign settles.
 *   3. THE NUMBER CANNOT MOVE. A null percent means an empty denominator — no
 *      source analysis and no crawl — so there is nothing to divide and nothing
 *      a test could change. The campaign stops on the FIRST tick, which is the
 *      specific "a worker that never idles" case this file was asked to rule
 *      out.
 *   4. THERE IS NOTHING LEFT TO PROPOSE. Every remaining gap is already in
 *      flight, or was already attempted and resisted the obvious test
 *      (`rankGapsForClosure` names each exclusion).
 *   5. THE TICK CEILING. CLOSE_LOOP_MAX_TICKS is a dumb hard stop that does not
 *      depend on any of the cleverness above being right, because the cleverness
 *      above is exactly what a bug would be in. It is enforced on BOTH paths —
 *      `decideTick` for a tick that ran and `recordFailedTick` for one that
 *      threw — and the second of those is the half that was missing: a campaign
 *      whose every tick failed was never counted and so could never end. A
 *      ceiling only one path can reach is not a ceiling.
 *   6. THE TARGET WAS MET.
 *   7. NOTHING HERE CAN GENERATE. The one exit that still spends its tick: the
 *      deterministic plan is written and kept, and the loop stops rather than
 *      re-measure a number that nothing can move. See the BLOCKED branch.
 *
 * And the pacing is a column, not a job. There is deliberately no
 * `qaai.close-loop` BullMQ queue: `nextTickAt` on the campaign row is compared
 * against the clock by the 60-second scheduler sweep that already exists and is
 * already registered. That choice costs one join and buys three things — the
 * loop cannot tick faster than the sweep whatever it decides, its state is
 * inspectable in psql rather than in Redis, and there is no new queue to be
 * produced-to and never drained (the bisect lesson that `scripts/check-wiring.ts`
 * exists for).
 *
 * ── WHY TWO NUMBERS, AND WHY THAT IS NOT CHEATING ───────────────────────────
 *
 * The TARGET is measured against the persisted surface denominator
 * (CoverageSnapshot, written by the recompute job): that is the number the
 * product reports and the number a CI gate compares against, so it is the only
 * honest thing to aim at. The WORK is chosen from the flow-map gap report
 * (`analyzeCoverage`), because that is the only producer of actionable gaps —
 * a gap carries the steps a test must repeat and the fields it must fill, and a
 * CoverageItem row carries a key and a label.
 *
 * Those two denominators are not the same, and the loop must never pretend
 * otherwise: closing eight gaps may move the surface percentage by nothing at
 * all, because the surface includes endpoints, auth cells and error states no
 * crawl reached. So the settle rule is DELTA-BASED and causation is never
 * claimed. `lastDeltaPoints` is recorded as what it is — the movement of the
 * reported number between two ticks — and the ledger separately records, per
 * gap, whether the test written for it actually closed it. Reporting the second
 * as if it were the first is the thing that would make this a vanity metric.
 *
 * ── WHAT THIS FILE MAY NEVER DO ─────────────────────────────────────────────
 *
 * Score something it did not measure. A percent of null is logged and stored as
 * null and never as 0; a gap absent from a TRUNCATED report is recorded
 * UNVERIFIABLE and never as closed; a campaign that stopped says which of the
 * seven reasons stopped it, in a sentence, on the row.
 */

import type { ExploreJob, GenerateJob } from '@qaai/shared';
import {
  analyzeCoverage,
  gapProvenance,
  isClosureState,
  planItemForGap,
  rankGapsForClosure,
  verifyClosure,
} from '@qaai/agent';
import type { ClosureState, CoverageGap } from '@qaai/agent';
import { CLOSURE_APPROVAL_POLICIES, FIXTURE_PREFIX } from '@qaai/shared';
import type { ClosureApprovalPolicy, ClosureCampaignState } from '@qaai/shared';
/*
 * Re-exported, not just imported: `approvalPolicyOf` below returns
 * `ClosureApprovalPolicy` and this module is where the closure vocabulary has
 * been imported from since it was written. Promoting it to @qaai/shared without
 * this line would be a rename dressed as a refactor.
 */
export { CLOSURE_APPROVAL_POLICIES, CLOSURE_CAMPAIGN_STATES } from '@qaai/shared';
export type { ClosureApprovalPolicy, ClosureCampaignState } from '@qaai/shared';
/*
 * THE RETIREMENT VOCABULARY, through the package barrels.
 *
 * `retirementAdmissible` is the ONE admission test (a confirmed signal that may
 * be the sole basis for a retirement), `retirementSurfaceEffect` is the ONE
 * place that turns coverage edges into the denominator consequence, and
 * `expiryFor` is the ONE place a review window is clamped. Re-deciding any of
 * the three here would be a second answer to a question a customer loses a test
 * over.
 */
import { retirementSurfaceEffect } from '@qaai/agent';
import type { RetirementCoverageEdge, RetirementRefusal } from '@qaai/agent';
import {
  OBSOLESCENCE_MIN_CONFIRMATIONS,
  expiryFor,
  retirementAdmissible,
} from '@qaai/shared';
import type { ObsolescenceSignal, RetirementState } from '@qaai/shared';
/*
 * The ownership resolver, imported the way notify.ts and digest.ts import it —
 * same function, same precedence. Three answers to "who has to decide whether
 * this test stops existing" would be three answers, and the one on the proposal
 * is the one somebody is held to.
 */
import {
  OWNERSHIP_RULE_SELECT,
  routeOwner,
} from '../../../api/src/lib/ownership.js';
import type { OwnershipRuleInput } from '../../../api/src/lib/ownership.js';
import { config, logger, prisma } from '../context.js';
import { enqueueExplore, enqueueGenerate } from '../queues.js';
import { apiEnvGap, processRecomputeCoverage } from './recompute-coverage.js';
import type { RecomputeCoverageJob, RecomputeOutcome } from './recompute-coverage.js';

// ─── The tunables, every one of them a documented exported constant ──────────

/**
 * "Small" — the delta, in PERCENTAGE POINTS, below which the loop decides the
 * number has stopped moving.
 *
 * Half a point, and the reasoning is arithmetic rather than taste. The reported
 * percentage is `Math.round`-ed to whole-ish precision over a denominator that
 * is typically 50–500 items, so one item closing on a 200-item surface moves it
 * 0.5 points. A threshold BELOW that would make the loop unsettlable — every
 * tick that closed a single item would look like progress — and a threshold
 * above it would discard real single-item progress as noise. 0.5 is therefore
 * "the smallest movement a single closed item can produce on a mid-sized
 * project", which is the only principled place to draw the line.
 *
 * It is compared on the ABSOLUTE delta on purpose: coverage going DOWN by a
 * point is movement, not settlement, and a loop that only noticed improvement
 * would keep ticking through a regression it was causing.
 */
export const CLOSE_LOOP_SETTLE_DELTA_POINTS = 0.5;

/**
 * How many consecutive small-delta ticks settle a campaign.
 *
 * Two, not one, and this is the detail that makes the threshold usable. A tick
 * taken while generation is still in flight has nothing to show yet and its
 * delta is legitimately zero, so a one-tick rule would settle almost every
 * campaign immediately after its first proposal — the loop stopping precisely
 * because its work had not landed. `decideTick` additionally refuses to count a
 * tick toward settling while items are still awaiting generation (see
 * `pendingGeneration`), and this is the belt to that pair of braces.
 */
export const CLOSE_LOOP_SETTLE_TICKS = 2;

/**
 * The dumb hard ceiling.
 *
 * 24 ticks at CLOSE_LOOP_TICK_MS is six hours — one night — after which the
 * campaign stops whatever every other rule thinks. It exists because the other
 * rules are where a bug would be: a stop condition that depends on the delta
 * being computed correctly is no protection against the delta being computed
 * incorrectly. This one depends on nothing but counting.
 */
export const CLOSE_LOOP_MAX_TICKS = 24;

/**
 * Whether the tick about to be recorded is past the hard ceiling.
 *
 * One function because the ceiling is checked in TWO places, and the reason it
 * has to be is the bug this replaced: `decideTick` checked it for a tick that
 * RAN, and nothing checked it for a tick that THREW. The sweep's failure path
 * recorded the error and left `tick` alone, so a campaign whose every tick
 * failed sat at tick 0 in RUNNING for ever, swept every sixty seconds, with
 * `nextTickAt` pushed forward by its own claim — the one state this file's
 * header says a campaign cannot reach. Forty-one failures against a ceiling of
 * twenty-four is not a ceiling.
 *
 * Both callers pass the tick ABOUT TO BE RECORDED (`campaign.tick + 1`), and
 * both compare it the same way, because a ceiling a campaign can cross on one
 * path and not the other is a campaign that cannot end.
 */
export function pastTickCeiling(tick: number): boolean {
  return tick > CLOSE_LOOP_MAX_TICKS;
}

/**
 * How long a tick waits before the next one is due.
 *
 * Fifteen minutes, chosen against the thing the loop is waiting FOR: the
 * Generator writing N tests and the recompute window (RECOMPUTE_WINDOW_MS, 30s)
 * elapsing. A shorter tick measures its own proposals before they have landed
 * and reads the resulting zero delta as settlement; a much longer one cannot
 * finish inside a night.
 */
export const CLOSE_LOOP_TICK_MS = 15 * 60_000;

/** Gaps one tick may propose. A tick's share of the night's budget. */
export const CLOSE_LOOP_DEFAULT_TOP_K = 8;

/**
 * Plan items one night's campaign may EVER propose, when the project has not
 * said otherwise (`Project.closureItemBudget`).
 *
 * This is the money cap. Forty is five full ticks' worth, and it is deliberately
 * of the same order as the per-request caps this feature replaces (25 proposals,
 * 40 plan items) — the point of the campaign is not a bigger number, it is that
 * the overflow becomes QAAI's problem across a night instead of a sentence
 * telling a human to click again.
 */
export const CLOSE_LOOP_DEFAULT_ITEM_BUDGET = 40;

/**
 * Whether the autopilot's items land APPROVED or PROPOSED, when the project has
 * not said (`Project.closureApprovalPolicy`).
 *
 * HUMAN_REVIEW is the default and the migration adds no default to the column,
 * so switching this product on for an existing customer cannot also switch on
 * unattended code generation for them. AUTO_APPROVE is the setting a team opts
 * into once it trusts the loop.
 */
export const CLOSE_LOOP_DEFAULT_APPROVAL_POLICY = 'HUMAN_REVIEW';

/*
 * CLOSURE_APPROVAL_POLICIES, ClosureApprovalPolicy, CLOSURE_CAMPAIGN_STATES and
 * ClosureCampaignState were declared HERE and now live in @qaai/shared, because
 * the API renders a campaign's state and policy and could not name either
 * without importing this processor — which would drag the queue, the browser
 * and the Prisma client into an HTTP read path to borrow eight strings. They are
 * re-exported from this module (see the import block at the top) so the two
 * existing spellings both keep working.
 *
 * CLOSE_LOOP_DEFAULT_APPROVAL_POLICY stays above: it is THIS FILE'S choice of
 * default, not shared vocabulary, and the API has no business inheriting it.
 *
 * `CLOSURE_CAMPAIGN_STATES` is READ AT TYPECHECK TIME, NOT AT RUN TIME, and that
 * is worth saying out loud so nobody mistakes it for a validator: its consumer
 * is the union, which is what stops a writer putting an unknown string in the
 * column. The ledger's own `GapClosure.state` IS validated at run time
 * (`isClosureState`), because that column is read BACK by a decision rule; this
 * one is only ever written.
 */

/**
 * How stale the crawl has to be before a campaign asks for a fresh one.
 *
 * The re-crawl is the "re-crawls" half of the defect and it is the single most
 * expensive thing in this file, so it is bounded twice: at most once per
 * campaign (`recrawlQueuedAt`), which is at most once per project per day by
 * the unique index, and only when the newest FlowMap is older than this. A loop
 * that re-crawled every tick would be a browser farm running until morning.
 */
export const CLOSE_LOOP_RECRAWL_AFTER_MS = 24 * 3_600_000;

/** Crawl bounds for the loop's own re-crawl. Modest: this is unattended. */
export const CLOSE_LOOP_RECRAWL_MAX_PAGES = 60;
export const CLOSE_LOOP_RECRAWL_MAX_DEPTH = 4;

/**
 * How many campaigns one sweep may arm, and how many it may advance.
 *
 * The sweep runs inside the 60-second scheduler tick alongside the cron
 * schedules and the monitors, so an install with two thousand projects must not
 * be able to turn one tick into a twenty-minute job that starves them.
 */
export const CLOSE_LOOP_SWEEP_LIMIT = 20;

/**
 * How many ledger rows one statement batch may carry.
 *
 * CLOSE_LOOP_SWEEP_LIMIT bounds campaigns per tick; this bounds the work inside
 * ONE campaign, which nothing used to. `reconcileLedger` awaited one UPDATE per
 * ledger row, sequentially, and a project accumulates one row per gap it has
 * ever had proposed — so twenty campaigns of three hundred gaps was six
 * thousand round trips in series, inside the 60-second scheduler tick this
 * shares with the cron schedules and the production monitors. The rows whose
 * state did not change are now one `updateMany`, and the ones that did change
 * go out in batches of this size.
 *
 * A hundred rather than the two hundred `persist` in apps/api/src/lib/
 * coverage-store.ts uses, and the difference is the caller: that one runs in a
 * request of its own and this one is a guest in a tick that owes an install's
 * nightlies their turn, so a shorter write transaction is worth more here than
 * a slightly lower statement count.
 */
export const CLOSE_LOOP_LEDGER_WRITE_CHUNK = 100;

// ─── The decision, as a pure function ───────────────────────────────────────

export interface TickInput {
  /** 1-based: the tick about to be recorded. */
  tick: number;
  /** The percentage the snapshot just written reports. NULL means not measured. */
  percent: number | null;
  /** The previous campaign tick's percentage. NULL on the first tick. */
  previousPercent: number | null;
  /** Consecutive small-delta ticks recorded so far. */
  settledTicks: number;
  targetPercent: number;
  /** Items this campaign has already proposed tonight. */
  itemsProposed: number;
  nightlyItemBudget: number;
  topK: number;
  /** Gaps that could be proposed right now, after the ledger's exclusions. */
  selectable: number;
  /**
   * Items proposed earlier that have produced no test yet.
   *
   * Load-bearing, and the reason is in CLOSE_LOOP_SETTLE_TICKS: a tick taken
   * while the Generator is still working has a legitimately zero delta, and
   * counting that as settlement is the loop stopping BECAUSE its work had not
   * landed. While this is non-zero the delta is recorded but not counted.
   */
  pendingGeneration: number;
  /** False when nothing on this deployment can turn an item into code. */
  generatorAvailable: boolean;
}

export interface TickDecision {
  state: ClosureCampaignState;
  /** How many gaps this tick may propose. 0 on every terminal branch. */
  itemBudget: number;
  /** Whether a further tick is scheduled. False on every terminal branch. */
  again: boolean;
  /** The absolute movement since the previous tick, or null if unmeasurable. */
  deltaPoints: number | null;
  /** What `settledTicks` should become. */
  settledTicks: number;
  /** Shown verbatim on the campaign row. */
  reason: string;
}

/**
 * Decide what this tick does and whether there is another one.
 *
 * Pure, and exported, so the seven exits can be argued with in a test rather than
 * inferred from a processor that needs a database. Every branch returns
 * `again: false` except the last.
 */
export function decideTick(input: TickInput): TickDecision {
  const delta =
    input.percent === null || input.previousPercent === null
      ? null
      : Math.round(Math.abs(input.percent - input.previousPercent) * 100) / 100;

  const stop = (state: ClosureCampaignState, reason: string): TickDecision => ({
    state,
    itemBudget: 0,
    again: false,
    deltaPoints: delta,
    // Frozen, not reset: the count is part of why the campaign stopped and
    // zeroing it would erase the evidence for its own decision.
    settledTicks: input.settledTicks,
    reason,
  });

  /*
   * 1. THE NUMBER CANNOT MOVE. An empty denominator is not 0% — it is the
   *    absence of a measurement, and no test anyone writes tonight can change
   *    it, because there is no source analysis and no crawl for a test to be
   *    measured against. This is the exact "a project whose coverage cannot
   *    move" case: it stops on the first tick rather than ticking 24 times to
   *    discover that zero minus zero is small.
   */
  if (input.percent === null) {
    return stop(
      'UNMEASURABLE',
      'Coverage is not measured on this project: the surface denominator is empty, so there is nothing to divide and no test could move the number. Ingest the repository (POST /projects/:id/source) or run the Explorer, then the campaign will arm again tomorrow.',
    );
  }

  if (input.percent >= input.targetPercent) {
    return stop(
      'TARGET_MET',
      `Coverage is ${input.percent}%, at or past this project's target of ${input.targetPercent}%. Nothing further was proposed.`,
    );
  }

  /*
   * 3. THE TICK CEILING, checked before the clever rules rather than after.
   *    It is the only stop that does not depend on the delta arithmetic being
   *    right, which is precisely why it must not sit behind it.
   *
   *    THE COUNT IN THE SENTENCE IS `input.tick`, NOT THE CEILING. This branch
   *    fires on the FIRST tick past the ceiling — `pastTickCeiling` is `>` —
   *    and `processCloseLoopTick` writes that same number to `ClosureCampaign
   *    .tick` in the same statement that writes this sentence to
   *    `stoppedReason`. Naming the constant instead said "has taken 24 ticks"
   *    on a row whose own `tick` column read 25, which is a sentence meant to
   *    be shown verbatim contradicting the column beside it. `recordFailedTick`
   *    already reports the tick it recorded; these are one ceiling reached by
   *    two paths, so they say the same number about it.
   */
  if (pastTickCeiling(input.tick)) {
    return stop(
      'TICK_CEILING',
      `This campaign has taken ${input.tick} ticks, past its hard ceiling of ${CLOSE_LOOP_MAX_TICKS}. It stopped here regardless of whether coverage was still moving; a fresh campaign arms tomorrow.`,
    );
  }

  /*
   * 4. THE NUMBER HAS STOPPED MOVING — but only when there is nothing in
   *    flight that could still move it. See `pendingGeneration`.
   */
  const small = delta !== null && delta < CLOSE_LOOP_SETTLE_DELTA_POINTS;
  const counts = small && input.pendingGeneration === 0;
  const settledTicks = counts ? input.settledTicks + 1 : small ? input.settledTicks : 0;

  if (counts && settledTicks >= CLOSE_LOOP_SETTLE_TICKS) {
    return {
      ...stop(
        'SETTLED',
        `Coverage moved ${delta} point(s) on each of the last ${CLOSE_LOOP_SETTLE_TICKS} ticks, which is under the ${CLOSE_LOOP_SETTLE_DELTA_POINTS}-point settle threshold, and nothing is awaiting generation. The loop stops rather than spending the rest of the budget on work that is not moving the number.`,
      ),
      settledTicks,
    };
  }

  if (input.itemsProposed >= input.nightlyItemBudget) {
    return stop(
      'BUDGET_SPENT',
      `This campaign has proposed its whole nightly budget of ${input.nightlyItemBudget} item(s). Coverage is ${input.percent}% against a target of ${input.targetPercent}%; the next campaign arms tomorrow.`,
    );
  }

  if (input.selectable === 0) {
    return stop(
      'NOTHING_LEFT',
      `Coverage is ${input.percent}% against a target of ${input.targetPercent}%, and no gap is proposable: every one is either already in flight or was already attempted and the test written for it did not close it. Those are in the ledger by name and need a human rather than another generation.`,
    );
  }

  const itemBudget = Math.max(
    1,
    Math.min(input.topK, input.nightlyItemBudget - input.itemsProposed, input.selectable),
  );

  /*
   * 6. GENERATION IS IMPOSSIBLE HERE — SPEND THIS TICK, THEN STOP.
   *
   *    The one branch that is terminal AND still has a budget, and the
   *    asymmetry is deliberate rather than an oversight. A missing model key is
   *    a MISSING TOOL, not a failure: the deterministic half of the work — the
   *    gaps, the ranking, the steps read off the crawl, the assertions — is
   *    exactly as good with no key as with one, and it is already worth having.
   *    POST /coverage/:projectId/propose makes the same call in the same words:
   *    it keeps the plan, declines to queue, and says what to set.
   *
   *    `again: false` is the other half. A SECOND tick would re-measure a number
   *    that cannot have moved, because nothing turned the first tick's items
   *    into tests — which is precisely the spin this file exists to refuse. So
   *    the campaign writes one night's worth of approvable plan and stops.
   */
  if (!input.generatorAvailable) {
    return {
      state: 'BLOCKED',
      itemBudget,
      again: false,
      deltaPoints: delta,
      settledTicks,
      reason: `Proposed up to ${itemBudget} item(s), which are complete and were written from the crawl rather than by a model. Nothing on this deployment can turn them into code, so the loop stops here instead of re-measuring a number that cannot move; approve the plan to generate them.`,
    };
  }

  return {
    state: 'RUNNING',
    itemBudget,
    again: true,
    deltaPoints: delta,
    settledTicks,
    reason:
      delta === null
        ? `First measurement: coverage is ${input.percent}% against a target of ${input.targetPercent}%. Proposing up to ${itemBudget} item(s).`
        : `Coverage is ${input.percent}%, ${delta} point(s) from the last tick, against a target of ${input.targetPercent}%. Proposing up to ${itemBudget} item(s).`,
  };
}

/** The UTC day key that makes one campaign per project per night a constraint. */
export function dayKeyOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Clamp a project's stored policy to the domain, falling back to the default. */
export function approvalPolicyOf(stored: string | null): ClosureApprovalPolicy {
  return (CLOSURE_APPROVAL_POLICIES as readonly string[]).includes(stored ?? '')
    ? (stored as ClosureApprovalPolicy)
    : CLOSE_LOOP_DEFAULT_APPROVAL_POLICY;
}

// ─── Reading the gap report from inside the worker ───────────────────────────

/** What one tick needs to know about the project's gaps right now. */
export interface GapReport {
  /** False when there is no readable crawl. Then closure is unverifiable. */
  crawled: boolean;
  /** True only when every gap found was returned, not a ranked page. */
  complete: boolean;
  gaps: CoverageGap[];
  flowMapId: string | null;
  flowMapVersion: number | null;
  /** The environment the crawl came from — where a re-crawl must be aimed. */
  environmentId: string | null;
  /** When that crawl was taken, for the staleness check. */
  flowMapCreatedAt: Date | null;
}

export type GapReportFn = (projectId: string) => Promise<GapReport>;

let cachedToCoverageInputs: unknown = null;

/**
 * Build the gap report with the worker's own Prisma client.
 *
 * The route-extraction step (`toCoverageInputs`) is imported lazily from
 * apps/api/src/routes/coverage.ts, and that is the SAME documented wall
 * processors/recompute-coverage.ts describes at length rather than a new one:
 * `computeCoverage` already imports that module, so the recompute this tick
 * performs has pulled it in before this line runs. The reason it cannot be a
 * static import is unchanged — the module is an Express router that opens a
 * Redis connection at import time, and the API's env parser underneath it calls
 * `process.exit(1)` on a variable the worker has never needed. `apiEnvGap` is
 * the pre-flight that turns that into a failed job instead of a vanished worker.
 *
 * THE HANDOVER NOTE, which is the same one: `toCoverageInputs` has no business
 * living in a route module. It belongs in the already-pure
 * apps/api/src/lib/impact.ts beside the route extractors it is built from, and
 * `computeCoverage` should take its Prisma client as a parameter the way
 * apps/api/src/lib/start-run.ts does. Then both lazy imports become ordinary
 * ones and this function loses twenty lines.
 */
async function loadToCoverageInputs(): Promise<
  (tests: never[]) => import('@qaai/agent').CoverageTestInput[]
> {
  if (!cachedToCoverageInputs) {
    const gap = apiEnvGap();
    if (gap) {
      throw new Error(
        `Refusing to load the route extractor from apps/api: ${gap}. That module's env parser calls process.exit(1), so importing it here would kill the worker and every in-flight run rather than failing this tick.`,
      );
    }
    const mod = await import('../../../api/src/routes/coverage.js');
    cachedToCoverageInputs = mod.toCoverageInputs;
  }
  return cachedToCoverageInputs as (tests: never[]) => import('@qaai/agent').CoverageTestInput[];
}

/**
 * The default gap report. Mirrors `coverageFor` in apps/api/src/routes/coverage.ts
 * deliberately and in one respect only: the auth profiles come from THE
 * ENVIRONMENT THE CRAWL CAME FROM and not from the project, because a profile
 * holds a session minted against one base URL and a test proposed from a staging
 * crawl must not be offered production's session.
 */
const defaultGapReport: GapReportFn = async (projectId) => {
  const [tests, flowMap] = await Promise.all([
    prisma.test.findMany({
      where: {
        projectId,
        disabledAt: null,
        filePath: { not: { startsWith: FIXTURE_PREFIX } },
      },
      select: {
        id: true,
        name: true,
        filePath: true,
        code: true,
        spec: true,
        tags: true,
        feature: true,
        priority: true,
        type: true,
        authProfileId: true,
        authProfileRequired: true,
      },
    }),
    prisma.flowMap.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { id: true, graph: true, version: true, environmentId: true, createdAt: true },
    }),
  ]);

  const authProfiles = flowMap
    ? await prisma.authProfile.findMany({
        where: { environmentId: flowMap.environmentId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, kind: true },
      })
    : [];

  const toCoverageInputs = await loadToCoverageInputs();
  const report = analyzeCoverage({
    flowMapGraph: flowMap?.graph ?? null,
    tests: toCoverageInputs(tests as never[]),
    authProfiles,
  });

  return {
    crawled: report.crawled,
    // The one fact that keeps the ledger honest: a gap absent from a ranked
    // page has not been shown to be closed.
    complete: report.totals.gapsReturned === report.totals.gaps,
    gaps: report.gaps,
    flowMapId: flowMap?.id ?? null,
    flowMapVersion: flowMap?.version ?? report.flowMapVersion,
    environmentId: flowMap?.environmentId ?? null,
    flowMapCreatedAt: flowMap?.createdAt ?? null,
  };
};

// ─── The injectable surface ──────────────────────────────────────────────────

export interface CloseLoopDeps {
  /** The one true recompute. Real one writes a CoverageSnapshot row. */
  recompute?: (job: RecomputeCoverageJob) => Promise<RecomputeOutcome>;
  gapReport?: GapReportFn;
  enqueueGenerate?: (job: GenerateJob) => Promise<void>;
  enqueueExplore?: (job: ExploreJob) => Promise<void>;
  /**
   * Whether this deployment can turn a plan item into code.
   *
   * Injected rather than read inline so that no test in this repo needs a model
   * key to exercise the loop — every deterministic path here (the gaps, the
   * ranking, the plan items, the ledger, the snapshot, the stop rules) works
   * with no model call at all, and the tests prove that by running without one.
   */
  generatorAvailable?: boolean;
  now?: () => Date;
}

/** One campaign row, as the tick reads it. */
export interface CampaignRow {
  id: string;
  orgId: string;
  projectId: string;
  dayKey: string;
  targetPercent: number;
  topK: number;
  nightlyItemBudget: number;
  approvalPolicy: string;
  tick: number;
  itemsProposed: number;
  settledTicks: number;
  lastPercent: number | null;
  /**
   * The CoverageSnapshot row behind `lastPercent`.
   *
   * Read, not just written, and that is the point of its being here: at the top
   * of tick N it is the stored measurement the delta about to be published is
   * measured AGAINST, and the tick carries it out as
   * `TickOutcome.baselineSnapshotId`. Without it the campaign published a
   * movement whose later operand was traceable to a row and whose earlier one
   * was a float with nothing behind it.
   *
   * Null on a campaign's first tick, and null — never a guess — when the
   * baseline measurement was computed but not persisted.
   */
  lastSnapshotId: string | null;
  recrawlQueuedAt: Date | null;
}

export interface TickOutcome {
  campaignId: string;
  projectId: string;
  tick: number;
  state: ClosureCampaignState;
  /** NULL — never 0 — when there was nothing to divide. */
  percent: number | null;
  deltaPoints: number | null;
  snapshotId: string | null;
  /**
   * The measurement `deltaPoints` was taken against, and the stored row it came
   * from. Both null on the first tick of a campaign, which is a first
   * measurement and not a movement of zero.
   *
   * Reported next to `percent`/`snapshotId` so a delta is auditable from one
   * structure: both of its operands, and the CoverageSnapshot row behind each.
   * `baselineSnapshotId` being null while `baselinePercent` is not means the
   * baseline was never persisted, so the movement is against a number that is
   * in no table — worth knowing before quoting it.
   */
  baselinePercent: number | null;
  baselineSnapshotId: string | null;
  itemsProposed: number;
  /** Ledger rows whose state changed this tick, by new state. */
  closed: number;
  notClosed: number;
  reopened: number;
  unverifiable: number;
  testsLinked: number;
  recrawlQueued: boolean;
  generationQueued: boolean;
  /**
   * `RetirementProposal` rows this tick filed, and the sweep that filed them.
   *
   * NULL — not a zero-filled sweep — when the sweep could not run. A zero in
   * `created` means "we looked and proposed nothing", which is a claim about
   * the project; a null means the question was not asked, which is a claim
   * about us. See the catch at the call site.
   */
  retirements: RetirementProposalSweep | null;
  again: boolean;
  reason: string;
}

// ─── One tick ────────────────────────────────────────────────────────────────

/**
 * Measure, reconcile, decide, spend, record.
 *
 * The order is not arbitrary: provenance is stamped FIRST so that a test the
 * Generator landed since the last tick is known to the ledger before closure is
 * judged. Reversed, every gap whose test had just arrived would be judged with
 * `testId: null` and recorded as "still open, nothing proposed" — the ledger
 * forgetting the work it had itself commissioned.
 */
export async function processCloseLoopTick(
  campaign: CampaignRow,
  deps: CloseLoopDeps = {},
): Promise<TickOutcome> {
  const now = deps.now?.() ?? new Date();
  const recompute = deps.recompute ?? processRecomputeCoverage;
  const gapReport = deps.gapReport ?? defaultGapReport;
  const generatorAvailable = deps.generatorAvailable ?? Boolean(config.anthropicApiKey);
  const tick = campaign.tick + 1;

  // ── 1. Provenance: did the Generator land anything since the last tick? ────
  const testsLinked = await stampProvenance(campaign);

  // ── 2. Re-measure, and store the measurement ──────────────────────────────
  const outcome = await recompute({
    orgId: campaign.orgId,
    projectId: campaign.projectId,
    reason: 'close-loop',
  });

  // ── 3. The gaps as they stand now ─────────────────────────────────────────
  const report = await gapReport(campaign.projectId);

  // ── 4. Verify closure, gap by gap ─────────────────────────────────────────
  const ledger = await reconcileLedger(campaign, report, now);

  // ── 5. What is proposable, after the ledger's exclusions ──────────────────
  const selection = rankGapsForClosure(report.gaps, {
    limit: Math.max(1, campaign.topK),
    ledger: ledger.states,
  });

  const decision = decideTick({
    tick,
    percent: outcome.percent,
    previousPercent: campaign.lastPercent,
    settledTicks: campaign.settledTicks,
    targetPercent: campaign.targetPercent,
    itemsProposed: campaign.itemsProposed,
    nightlyItemBudget: campaign.nightlyItemBudget,
    topK: campaign.topK,
    selectable: selection.gaps.length,
    pendingGeneration: ledger.pendingGeneration,
    generatorAvailable,
  });

  // ── 6. Spend the budget ───────────────────────────────────────────────────
  let proposed = 0;
  let generationQueued = false;
  if (decision.itemBudget > 0 && selection.gaps.length > 0) {
    const spend = await propose({
      campaign,
      gaps: selection.gaps.slice(0, decision.itemBudget),
      report,
      generatorAvailable,
      now,
      enqueue: deps.enqueueGenerate ?? enqueueGenerate,
    });
    proposed = spend.items;
    generationQueued = spend.generationQueued;
  }

  // ── 7. Ask for a fresh crawl, at most once per campaign ───────────────────
  const recrawlQueued = await maybeRecrawl({
    campaign,
    report,
    now,
    enqueue: deps.enqueueExplore ?? enqueueExplore,
  });

  /*
   * ── 8. Propose retiring the tests whose pages are gone ────────────────────
   *
   * THE PRODUCTION CALL SITE for the retirement proposal writer, and the reason
   * it is on this tick rather than in a sweep of its own: the loop has just
   * re-measured coverage, and a test whose route is gone is inflating exactly
   * the numerator it measured. Proposing its retirement here is what keeps the
   * percentage and the suite from disagreeing.
   *
   * IT MUST NOT BE ABLE TO FAIL THE TICK. The measurement and the ledger
   * reconciliation above are the valuable part — a campaign that lost them
   * because a proposal could not be filed would stop advancing — so the error
   * is logged and the tick continues with `retirements: null`, which is NOT the
   * same as a sweep that proposed nothing.
   *
   * Before the campaign update, and wrapped. A throw here must leave the
   * campaign advanced anyway: an un-advanced campaign is RETRIED, and a retried
   * tick re-does every step above this one — a second recompute, a second
   * ledger reconciliation, a second spend of the item budget.
   *
   * The retry does NOT duplicate proposals, and the reason is the idempotence
   * check inside the sweep rather than anything here: a test that already has a
   * PROPOSED, APPROVED or APPLIED proposal is skipped and counted as
   * `alreadyProposed`. That check is a READ and not a constraint —
   * `RetirementProposal` has no unique key on the test — so two ticks running
   * concurrently on one project could still race. The sweep runs one campaign
   * at a time and campaigns are armed once per project per day, which makes the
   * window narrow rather than closed; the real fix is a partial unique index,
   * and it is in the handover.
   */
  const retirements = await proposeRetirements(campaign, now).catch((err: unknown) => {
    logger.error(
      { err, campaignId: campaign.id, projectId: campaign.projectId },
      'could not propose retirements this tick; no proposal was filed and no obsolescence signal was resolved',
    );
    return null;
  });

  // ── 9. Record everything, including why it stopped ────────────────────────
  const terminal = !decision.again;
  await prisma.closureCampaign.update({
    where: { id: campaign.id },
    data: {
      tick,
      state: decision.state,
      settledTicks: decision.settledTicks,
      itemsProposed: campaign.itemsProposed + proposed,
      /*
       * THE CHECKABLE TRIPLE, and what each of the three is for, because two of
       * them have no reader inside this file and that has to be said rather
       * than left to be rediscovered.
       *
       * `lastDeltaPoints` is the claim. `previousPercent` and `lastPercent` are
       * its two operands, stored so the subtraction can be re-done by whoever
       * reads the row instead of taken on trust — the same reason
       * CoverageSnapshot stores `byKind` beside `percent`. `lastSnapshotId` is
       * the provenance of the later operand: the CoverageSnapshot row the
       * number was read out of.
       *
       * The earlier operand's provenance is NOT on this row — there is no
       * column for it — so the traceability the schema comment promises is only
       * complete on the tick itself, where `TickOutcome.baselineSnapshotId`
       * carries it. A campaign surface that renders this row therefore has one
       * half-traceable operand, and that is a real limit, not an oversight:
       * see the handover note.
       */
      previousPercent: campaign.lastPercent,
      lastPercent: outcome.percent,
      lastDeltaPoints: decision.deltaPoints,
      lastSnapshotId: outcome.snapshotId,
      lastTickAt: now,
      // Null when the campaign has stopped: the sweep reads exactly this
      // column, so a terminal campaign is structurally unable to tick again.
      nextTickAt: terminal ? null : new Date(now.getTime() + CLOSE_LOOP_TICK_MS),
      stoppedReason: terminal ? decision.reason : null,
      finishedAt: terminal ? now : null,
      ...(recrawlQueued ? { recrawlQueuedAt: now } : {}),
    },
  });

  const result: TickOutcome = {
    campaignId: campaign.id,
    projectId: campaign.projectId,
    tick,
    state: decision.state,
    percent: outcome.percent,
    deltaPoints: decision.deltaPoints,
    snapshotId: outcome.snapshotId,
    baselinePercent: campaign.lastPercent,
    baselineSnapshotId: campaign.lastSnapshotId,
    itemsProposed: proposed,
    closed: ledger.closed,
    notClosed: ledger.notClosed,
    reopened: ledger.reopened,
    unverifiable: ledger.unverifiable,
    testsLinked,
    recrawlQueued,
    generationQueued,
    retirements,
    again: decision.again,
    reason: decision.reason,
  };

  /*
   * Logged with the skipped list's reasons folded in, because "proposed 3 of
   * 97 gaps" without them is the kind of line that makes an operator assume the
   * loop is broken. A campaign that chose not to act has to be able to say why.
   */
  logger.info(
    {
      ...result,
      skipped: selection.skipped.length,
      skippedWhy: [...new Set(selection.skipped.map((s) => s.why))].slice(0, 4),
      consideredGaps: selection.considered,
      reportComplete: report.complete,
    },
    terminal ? 'closure campaign stopped' : 'closure campaign ticked',
  );

  return result;
}

// ─── Step 1: provenance ──────────────────────────────────────────────────────

/**
 * Copy the gap id from each landed plan item onto the Test it produced, and
 * tell the ledger which test now answers for which gap.
 *
 * THIS IS THE WRITER FOR `Test.gapId`. Generation itself happens in
 * processors/generate.ts, which sets `PlanItem.generatedTestId` and belongs to
 * another agent this round — so the link is made here, on the next tick, from
 * the item's own column. That is a deliberate second-best and it has one real
 * consequence worth stating: a test generated from a plan item that NO campaign
 * is tracking never gets its gap id, because nothing comes back to look. The
 * fix is one line in generate.ts and it is in the handover.
 *
 * `updateMany` with `gapId: null` in the where, so provenance is first-writer-
 * wins and a second tick cannot relabel a test that already names its gap.
 */
async function stampProvenance(campaign: CampaignRow): Promise<number> {
  const waiting = await prisma.gapClosure.findMany({
    where: {
      projectId: campaign.projectId,
      planItemId: { not: null },
      testId: null,
    },
    select: { id: true, gapId: true, planItemId: true },
  });
  if (waiting.length === 0) return 0;

  const items = await prisma.planItem.findMany({
    where: { id: { in: waiting.flatMap((row) => (row.planItemId ? [row.planItemId] : [])) } },
    select: { id: true, gapId: true, generatedTestId: true },
  });
  const testOf = new Map(items.map((item) => [item.id, item.generatedTestId]));

  let linked = 0;
  for (const row of waiting) {
    const testId = row.planItemId ? testOf.get(row.planItemId) : null;
    if (!testId) continue;

    await prisma.test.updateMany({
      where: { id: testId, orgId: campaign.orgId, gapId: null },
      data: { gapId: row.gapId },
    });
    await prisma.gapClosure.update({
      where: { id: row.id },
      data: {
        testId,
        testSeenAt: new Date(),
        // TEST_WRITTEN and not CLOSED. A test existing is not a test that
        // closed anything, and the next step is the one entitled to say so.
        state: 'TEST_WRITTEN',
        why: `Test ${testId} landed from plan item ${row.planItemId}. Whether it actually closed the gap is decided by the next measurement, not by its existence.`,
      },
    });
    linked += 1;
  }
  return linked;
}

// ─── Step 4: verified closure ────────────────────────────────────────────────

interface LedgerOutcome {
  /** Every known gap's current state, for `rankGapsForClosure`. */
  states: Map<string, ClosureState>;
  closed: number;
  notClosed: number;
  reopened: number;
  unverifiable: number;
  /** Items proposed with no test yet — the settle rule reads this. */
  pendingGeneration: number;
}

async function reconcileLedger(
  campaign: CampaignRow,
  report: GapReport,
  now: Date,
): Promise<LedgerOutcome> {
  const rows = await prisma.gapClosure.findMany({
    where: { projectId: campaign.projectId },
    select: { id: true, gapId: true, state: true, planItemId: true, testId: true },
  });

  const openGapIds = new Set(report.gaps.map((gap) => gap.id));
  const evidence = {
    crawled: report.crawled,
    openGapIds,
    complete: report.complete,
  };

  const states = new Map<string, ClosureState>();
  let closed = 0;
  let notClosed = 0;
  let reopened = 0;
  let unverifiable = 0;
  let pendingGeneration = 0;

  /*
   * The writes, collected rather than awaited one at a time. See the batch
   * comment below the loop: this is a guest in the 60-second scheduler tick,
   * and a project accumulates one ledger row per gap it has ever had proposed.
   */
  const unchanged: string[] = [];
  const changed: Array<{ id: string; data: Record<string, unknown> }> = [];

  for (const row of rows) {
    /*
     * `GapClosure.state` is a TEXT column (see the migration header for why it
     * is not a Prisma enum), which means the database will accept anything —
     * a value from a newer deploy, or a hand-written UPDATE in psql. Read back
     * through the domain rather than cast: an unrecognised state falls back to
     * OPEN, which is the conservative direction, because the alternative is a
     * verdict computed from a state the rule has never heard of. It is logged,
     * because a row in a state nothing recognises is somebody's bug.
     */
    let state: ClosureState = 'OPEN';
    if (isClosureState(row.state)) {
      state = row.state;
    } else {
      logger.warn(
        { closureId: row.id, gapId: row.gapId, state: row.state },
        'gap closure row holds a state this build does not recognise; treating it as OPEN',
      );
    }

    const verdict = verifyClosure(
      { gapId: row.gapId, state, planItemId: row.planItemId, testId: row.testId },
      evidence,
    );
    states.set(row.gapId, verdict.state);

    if (verdict.state === 'CLOSED') closed += 1;
    if (verdict.state === 'NOT_CLOSED') notClosed += 1;
    if (verdict.state === 'REOPENED') reopened += 1;
    if (verdict.state === 'UNVERIFIABLE') unverifiable += 1;
    if (verdict.state === 'PROPOSED' || state === 'PROPOSED') {
      if (!row.testId) pendingGeneration += 1;
    }

    /*
     * EVERY row is written, and the old comment here said the opposite.
     *
     * It claimed "only changes are written" and then wrote `lastCheckedAt` on
     * the unchanged ones two lines below — which is the right behaviour, since
     * a row nothing has re-measured for a week is not a row whose state is
     * current and a reader has to be able to tell. So the comment was the
     * wrong half: what a tick must not do is write forty ROWS' WORTH OF STATE
     * it did not change, and what it must not do EITHER is spend forty
     * sequential round trips saying so. Collected here and written in batches
     * below.
     */
    if (!verdict.changed) {
      unchanged.push(row.id);
      continue;
    }

    changed.push({
      id: row.id,
      data: {
        state: verdict.state,
        why: verdict.why,
        lastCheckedAt: now,
        ...(verdict.state === 'CLOSED' ? { closedAt: now } : {}),
        ...(verdict.state === 'REOPENED'
          ? { reopenedAt: now, reopenCount: { increment: 1 } }
          : {}),
      },
    });
  }

  /*
   * One statement for every row whose verdict was unchanged, because the only
   * column that differs between them is one they all get the same value of.
   * This is the overwhelming majority of a steady-state tick: a campaign on a
   * three-hundred-gap project confirms almost all of them and changes a
   * handful.
   */
  if (unchanged.length > 0) {
    await prisma.gapClosure.updateMany({
      where: { id: { in: unchanged } },
      data: { lastCheckedAt: now },
    });
  }

  /*
   * The changed rows cannot be one statement — each carries its own `why`,
   * naming its own test or plan item — so they go out in batches instead, the
   * same shape `persist` in apps/api/src/lib/coverage-store.ts uses for the
   * same reason. The count of round trips is now
   * `ceil(changed / CLOSE_LOOP_LEDGER_WRITE_CHUNK) + 1` rather than
   * `rows.length`, which is what stops one campaign's reconciliation from
   * owning the scheduler tick. Chunked rather than one transaction over
   * everything: each row is independent, and a partial write leaves a ledger
   * the next tick completes.
   */
  for (let offset = 0; offset < changed.length; offset += CLOSE_LOOP_LEDGER_WRITE_CHUNK) {
    const batch = changed.slice(offset, offset + CLOSE_LOOP_LEDGER_WRITE_CHUNK);
    await prisma.$transaction(
      batch.map((write) => prisma.gapClosure.update({ where: { id: write.id }, data: write.data })),
    );
  }

  return { states, closed, notClosed, reopened, unverifiable, pendingGeneration };
}

// ─── Step 6: spend the budget ────────────────────────────────────────────────

/**
 * Turn the chosen gaps into a TestPlan, plan items that NAME THEIR GAP, and
 * ledger rows; then queue generation if anything can generate.
 *
 * The row ids are minted here rather than by the database for the same reason
 * POST /coverage/:projectId/propose mints them: Prisma makes no promise that a
 * nested `create` array comes back in the order it went in, so reading the
 * gap → item mapping off the returned order would be right in testing and
 * wrong, silently, in production. The difference from that endpoint is that the
 * mapping is now WRITTEN — onto `PlanItem.gapId` and into `GapClosure` — rather
 * than returned in one HTTP response and discarded.
 */
async function propose(args: {
  campaign: CampaignRow;
  gaps: CoverageGap[];
  report: GapReport;
  generatorAvailable: boolean;
  now: Date;
  enqueue: (job: GenerateJob) => Promise<void>;
}): Promise<{ items: number; generationQueued: boolean }> {
  const { campaign, gaps, report, now } = args;
  const policy = approvalPolicyOf(campaign.approvalPolicy);

  /*
   * ONE BOOLEAN, READ TWICE, and it must be one because the two reads are the
   * two halves of the same promise: the state the items land in, and whether
   * generation is queued for them.
   *
   * THE DEFECT IT CLOSES. This function used to write the state from the policy
   * and then enqueue generation for EVERY item id regardless of it, and
   * processors/generate.ts selects its items by id with no state filter — so a
   * HUMAN_REVIEW campaign, which is the documented default and the whole reason
   * the migration gives `Project.closureApprovalPolicy` no default, wrote
   * PROPOSED items onto the approval screen and then had a model write the code
   * for them anyway while nobody was awake. The policy was a label on a row,
   * not a brake.
   *
   * It is also the invariant the rest of the product holds and this file was
   * the only one breaking: processors/explore.ts queues generation only inside
   * `if (job.autoApprove)`, and POST /coverage/:projectId/propose marks its
   * items APPROVED precisely because the request IS the approval. Generation
   * follows approval everywhere or it follows it nowhere.
   */
  const approved = policy === 'AUTO_APPROVE';

  /*
   * Built before the write, so a gap whose shape `planItemForGap` cannot
   * express fails this tick's proposal rather than committing half a plan. The
   * campaign survives either way: a throw here is caught by the sweep, which
   * records it against the campaign and tries again on the next tick.
   */
  const built = gaps.map((gap) => ({
    gap,
    provenance: gapProvenance(gap),
    item: planItemForGap(gap),
    rowId: crypto.randomUUID(),
  }));

  const plan = await prisma.testPlan.create({
    data: {
      orgId: campaign.orgId,
      projectId: campaign.projectId,
      flowMapId: report.flowMapId,
      summary: `Closure campaign ${campaign.dayKey}, tick ${campaign.tick + 1}: ${built.length} of the highest-ranked gaps on flow map v${report.flowMapVersion ?? '?'}. Each item names the gap it was minted to close, and the ledger records whether it actually did.`,
      items: {
        create: built.map(({ item, provenance, rowId }) => ({
          id: rowId,
          orgId: campaign.orgId,
          title: item.title,
          rationale: item.rationale,
          feature: item.feature,
          priority: item.priority,
          testType: item.testType,
          steps: item.steps,
          assertions: item.assertions,
          journeyId: item.journeyId,
          authProfileId: item.authProfileId,
          // THE PROVENANCE. The one column that makes closure checkable.
          gapId: provenance.gapId,
          gapKind: provenance.gapKind,
          /*
           * The approval policy. AUTO_APPROVE means the Generator may write
           * code tonight without anyone ticking a box; HUMAN_REVIEW means the
           * items wait on the approval screen, which is what an unattended
           * loop defaults to. The SAME `approved` decides the enqueue below.
           */
          state: approved ? ('APPROVED' as const) : ('PROPOSED' as const),
          ...(approved ? { decidedBy: `close-loop:${campaign.id}`, decidedAt: now } : {}),
        })),
      },
    },
    select: { id: true },
  });

  for (const { provenance, rowId } of built) {
    /*
     * Upsert, keyed on (projectId, gapId). A gap seen before — OPEN, or
     * UNVERIFIABLE from a tick with no crawl — keeps its history and its
     * `reopenCount`; minting a second row would reset exactly the counter that
     * says "your generator keeps producing a test that does not close this".
     */
    await prisma.gapClosure.upsert({
      where: { projectId_gapId: { projectId: campaign.projectId, gapId: provenance.gapId } },
      create: {
        orgId: campaign.orgId,
        projectId: campaign.projectId,
        gapId: provenance.gapId,
        gapKind: provenance.gapKind,
        gapTitle: provenance.gapTitle,
        campaignId: campaign.id,
        planItemId: rowId,
        state: 'PROPOSED',
        why: `Proposed by closure campaign ${campaign.dayKey} at rank score ${provenance.gapScore}. Plan item ${rowId}.`,
        proposedAt: now,
        lastCheckedAt: now,
      },
      update: {
        campaignId: campaign.id,
        planItemId: rowId,
        gapKind: provenance.gapKind,
        gapTitle: provenance.gapTitle,
        state: 'PROPOSED',
        why: `Re-proposed by closure campaign ${campaign.dayKey} at rank score ${provenance.gapScore}. Plan item ${rowId}.`,
        proposedAt: now,
        lastCheckedAt: now,
        // Deliberately NOT cleared: a gap being proposed again does not undo
        // the test that was written for it last time.
      },
    });
  }

  /*
   * THE BRAKE. Nothing is generated from items nobody has approved.
   *
   * The items and the ledger rows above are kept — they are the deterministic
   * half, written from the crawl with no model call, and they are what the
   * approval screen is FOR. The campaign keeps ticking, and that is correct
   * rather than the spin this file refuses: a human approving the plan during
   * the night is a thing that can still move the number, which is exactly what
   * the `generatorAvailable: false` branch has none of. What the campaign will
   * not do is approve on their behalf.
   *
   * `generationQueued: false` is reported honestly all the way out to the
   * tick's log line, so "proposed 8, queued nothing" is readable as the policy
   * working rather than as a broken producer.
   */
  if (!approved) return { items: built.length, generationQueued: false };

  /*
   * Generation needs a model call, and its absence is a MISSING TOOL rather
   * than a failure — exactly as POST /propose treats it. The plan and the
   * ledger rows above were written from the crawl and are already worth
   * having, so they are kept and nothing is queued. `decideTick` then stops the
   * campaign rather than ticking to re-measure a number that cannot move.
   */
  if (!args.generatorAvailable) return { items: built.length, generationQueued: false };

  await args.enqueue({
    orgId: campaign.orgId,
    projectId: campaign.projectId,
    testPlanId: plan.id,
    planItemIds: built.map(({ rowId }) => rowId),
    requestedBy: `close-loop:${campaign.id}`,
  });

  return { items: built.length, generationQueued: true };
}

// ─── Step 7: the re-crawl ────────────────────────────────────────────────────

/**
 * Ask for a fresh crawl, at most once per campaign and only when the newest one
 * is stale.
 *
 * The denominator the loop is trying to move is partly made of what a crawl
 * reached, so a campaign measuring against a six-week-old FlowMap is closing
 * gaps in an application that has since changed. But a crawl holds a browser
 * for minutes, so the two bounds are hard: `recrawlQueuedAt` makes it once per
 * campaign (and the unique day key makes that once per project per day), and
 * CLOSE_LOOP_RECRAWL_AFTER_MS means a project crawled this morning is left
 * alone.
 *
 * A project with no FlowMap at all is NOT crawled from here. There is no
 * environment to aim at — the environment is read off the existing crawl — and
 * guessing one would point an unattended browser at whichever environment
 * happened to be first, which on a project with a production environment is the
 * worst possible guess.
 */
async function maybeRecrawl(args: {
  campaign: CampaignRow;
  report: GapReport;
  now: Date;
  enqueue: (job: ExploreJob) => Promise<void>;
}): Promise<boolean> {
  const { campaign, report, now } = args;
  if (campaign.recrawlQueuedAt) return false;
  if (!report.environmentId || !report.flowMapCreatedAt) return false;
  if (now.getTime() - report.flowMapCreatedAt.getTime() < CLOSE_LOOP_RECRAWL_AFTER_MS) return false;

  try {
    await args.enqueue({
      orgId: campaign.orgId,
      projectId: campaign.projectId,
      environmentId: report.environmentId,
      requestedBy: `close-loop:${campaign.id}`,
      maxPages: CLOSE_LOOP_RECRAWL_MAX_PAGES,
      maxDepth: CLOSE_LOOP_RECRAWL_MAX_DEPTH,
      // Never. The crawl's own plan would bypass this campaign's budget and
      // its approval policy entirely, which is the one thing an autopilot with
      // a cap must not be able to do.
      autoApprove: false,
    });
    return true;
  } catch (err) {
    /*
     * A crawl that could not be queued is not a failed tick. The measurement,
     * the ledger and the proposals are all already done and stored; the loop
     * simply measures against the crawl it has. Throwing here would discard a
     * tick's real work over an optional refresh.
     */
    logger.warn(
      { err, campaignId: campaign.id, projectId: campaign.projectId },
      'could not queue the closure loop re-crawl; this campaign measures against the crawl it has',
    );
    return false;
  }
}


// ─── Step 9: turn confirmed obsolescence into a reviewable proposal ──────────

/**
 * How many retirement proposals one tick may file.
 *
 * Low on purpose, and it is a product decision rather than a query cost. "A
 * reviewer who sees forty bogus proposals once will never read the forty-first"
 * is the rule `OBSOLESCENCE_MIN_CONFIRMATIONS` was chosen under, and a queue of
 * forty CORRECT proposals is just as unreadable. A project with more obsolete
 * tests than this works through them a tick at a time, and the cap is reported
 * as a count and a reason whenever it bites.
 */
export const RETIREMENT_PROPOSALS_PER_TICK = 10;

/**
 * How many unresolved signal rows one tick reads.
 *
 * A DISCLOSURE and not a gate, which is the opposite of the exclusion cap in
 * processors/explore.ts, and the asymmetry is deliberate: a truncated signal
 * list can only make a test look WEAKER than it is, so the cap biting produces
 * a refusal rather than a proposal. Truncating a guard list is dangerous;
 * truncating an evidence list is merely incomplete, and incomplete in the
 * direction that keeps a test running.
 */
export const RETIREMENT_SIGNAL_SCAN_CAP = 1_000;

/** The review window stamped on a proposal, clamped by `expiryFor` to 14 days. */
export const RETIREMENT_REVIEW_DAYS = 7;

/** The states in which a proposal already exists and a second one must not be filed. */
export const RETIREMENT_LIVE_STATES: readonly RetirementState[] = [
  'PROPOSED',
  'APPROVED',
  'APPLIED',
];

/**
 * The refusals THIS sweep decides, as opposed to the ones it reports a zero for.
 *
 * Exported because it is the only thing that stops a zero in
 * `RetirementProposalSweep.refused` meaning two different things — "evaluated,
 * and none" versus "not evaluated here at all". Two facts in one field is a
 * defect even when both values are correct.
 *
 * SUPPRESSION_REFUSED is in the list and the other two are not: this sweep DOES
 * stamp the review window, so it can refuse on the expiry (`expiryFor` returns
 * null rather than substituting a default). What it does not do is construct
 * the suppression itself — that needs a human owner and happens at apply.
 */
export const RETIREMENT_REFUSALS_EVALUATED_IN_THE_LOOP: readonly RetirementRefusal[] = [
  'SIGNALS_NOT_ADMISSIBLE',
  'SUPPRESSION_REFUSED',
];

export interface RetirementProposalSweep {
  /** Tests that arrived here with at least one CONFIRMED unresolved signal. */
  considered: number;
  /** `RetirementProposal` rows written. */
  created: number;
  /** Tests that already had a live proposal. Idempotent: nothing was written. */
  alreadyProposed: number;
  /** Tests already disabled — retired, or disabled by a human. Left alone. */
  alreadyDisabled: number;
  /**
   * Refusals by reason, every key always present.
   *
   * `evaluatedHere` is what stops a zero in this record being two facts in one
   * field. Only the reasons it names are decided by THIS sweep; the others are
   * enforced somewhere else and a zero against them is a statement about where
   * the gate lives, not a measurement made here:
   *
   *   CRAWL_DOES_NOT_SUPPORT_RETIREMENT  enforced in processors/explore.ts,
   *     which writes NO signal from a truncated, un-adjudicated or degraded
   *     crawl — so a test whose evidence came from one has nothing to arrive
   *     here with.
   *   VERDICT_NOT_OBSOLETE  same place: `obsolescenceSignalsFor` files
   *     ROUTE_GONE only for a route absent from BOTH the crawl and the source.
   *   SUPPRESSION_REFUSED  enforced at APPLY, in apps/api/src/routes/tests.ts,
   *     because that is where a retirement starts suppressing anything and
   *     where a named human is present to own it. See the note below.
   */
  refused: Record<RetirementRefusal, number>;
  /** The refusals this sweep itself decides. See `refused`. */
  evaluatedHere: readonly RetirementRefusal[];
  /** Across every proposal written: surfaces that would go back to UNCOVERED. */
  surfacesReturnedToUncovered: number;
  /** Surfaces that would stay covered because another live test reaches them. */
  surfacesStillCovered: number;
  /** TRUE when a cap bit, so every count is a floor. */
  capped: boolean;
  /** The sentence an operator reads. Never only a count. */
  disclosure: string;
}

/**
 * File a `RetirementProposal` for every test whose obsolescence is confirmed.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * `RetirementProposal` HAD NO CREATOR. processors/explore.ts writes
 * `ObsoleteTestSignal` rows on every crawl and processors/triage.ts has a sweep
 * that EXPIRES proposals — reading a table nothing ever inserted into. So
 * `OBSOLESCENCE_MIN_CONFIRMATIONS` guarded a threshold nothing crossed,
 * `retirementAdmissible` was asked by nobody, and the whole feature was one
 * writer away from existing. This is that writer.
 *
 * ── WHY HERE ────────────────────────────────────────────────────────────────
 *
 * The closure loop is the one thing in this system that already asks, on a
 * schedule, "what is the honest state of this project's coverage?" — it
 * re-measures, reconciles its ledger and re-crawls. A test whose page is gone
 * is a coverage fact of exactly that kind: it inflates the numerator with cover
 * that cannot be checked. Proposing its retirement on the same tick that
 * measures the number is what keeps the two from disagreeing.
 *
 * ── WHAT THIS SWEEP MAY NOT DO ──────────────────────────────────────────────
 *
 * IT DOES NOT DISABLE ANYTHING. A proposal is a question put to a human with an
 * expiry on it; `Test.disabledAt` is written only by the apply endpoint, by an
 * ADMIN, in one transaction with the version that makes the revert exact. That
 * separation is rule 11 in its sharpest form — a retirement disables a human's
 * test — and it is why `applySuppression` is NOT called here: a RETIREMENT
 * suppression needs a HUMAN-SET owner (`requiresHumanOwner`), and at propose
 * time there is no human. Calling it here would force this sweep either to
 * refuse every proposal on a project with no explicit assignments, or to lie
 * about the provenance of an owner a glob picked. The constructor is invoked at
 * APPLY, where the actor is a named person and EXPLICIT_ASSIGNMENT is true.
 *
 * `ownerState: UNOWNED` is therefore a real and reportable answer on a
 * proposal, exactly as the schema says: "a retirement nobody owns is a finding,
 * and proposing it to nobody in particular is better than assigning it to
 * whoever is listed first".
 *
 * NO MODEL. The admission is a count against a threshold, the denominator
 * effect is set arithmetic, and the reason sentence is composed from QAAI's own
 * records — the signal KINDS and their counts, never the test's name or the
 * route text the application supplied.
 */
export async function proposeRetirements(
  campaign: Pick<CampaignRow, 'id' | 'orgId' | 'projectId'>,
  now: Date,
): Promise<RetirementProposalSweep> {
  const refused: Record<RetirementRefusal, number> = {
    VERDICT_NOT_OBSOLETE: 0,
    CRAWL_DOES_NOT_SUPPORT_RETIREMENT: 0,
    SIGNALS_NOT_ADMISSIBLE: 0,
    SUPPRESSION_REFUSED: 0,
  };
  const empty = (disclosure: string, capped = false): RetirementProposalSweep => ({
    considered: 0,
    created: 0,
    alreadyProposed: 0,
    alreadyDisabled: 0,
    refused,
    evaluatedHere: RETIREMENT_REFUSALS_EVALUATED_IN_THE_LOOP,
    surfacesReturnedToUncovered: 0,
    surfacesStillCovered: 0,
    capped,
    disclosure,
  });

  const { orgId, projectId } = campaign;

  /*
   * Every UNRESOLVED signal, not only the confirmed ones.
   *
   * `retirementAdmissible` does its own filtering and its REASON differs
   * between "nothing is confirmed yet" and "only weak signals are confirmed" —
   * two findings a user will ask about, and pre-filtering here would collapse
   * them into one. Ordered by test so a test's signals stay together across the
   * cap; see the partial-group drop below, which is what makes that ordering
   * load-bearing rather than cosmetic.
   */
  const rows = await prisma.obsoleteTestSignal.findMany({
    where: { orgId, projectId, resolvedAt: null },
    orderBy: [{ testId: 'asc' }, { kind: 'asc' }, { reference: 'asc' }],
    take: RETIREMENT_SIGNAL_SCAN_CAP + 1,
    select: { id: true, testId: true, kind: true, reference: true, confirmations: true },
  });
  const signalsCapped = rows.length > RETIREMENT_SIGNAL_SCAN_CAP;
  let scanned = rows.slice(0, RETIREMENT_SIGNAL_SCAN_CAP);
  if (signalsCapped) {
    /*
     * DROP THE LAST TEST'S PARTIAL GROUP. Past the cap a test's signal list is
     * a PAGE of its evidence, and a page is exactly how a test with a confirmed
     * ROUTE_GONE comes to look like a test with only a LOCATOR_GONE. The
     * refusal would be in the safe direction, but it would be a refusal with a
     * wrong reason attached — and "only weak signals" is a sentence a customer
     * would act on.
     */
    const lastTestId = scanned[scanned.length - 1]?.testId;
    scanned = scanned.filter((row) => row.testId !== lastTestId);
  }

  const byTest = new Map<string, typeof scanned>();
  for (const row of scanned) {
    const list = byTest.get(row.testId) ?? [];
    list.push(row);
    byTest.set(row.testId, list);
  }
  if (byTest.size === 0) {
    return empty(
      'No unresolved obsolescence signal exists for this project, so no retirement was proposed. That is not a claim that every test is current — it is what the crawls have recorded.',
      signalsCapped,
    );
  }

  const testIds = [...byTest.keys()].sort();
  const [tests, live, rules] = await Promise.all([
    prisma.test.findMany({
      where: { orgId, projectId, id: { in: testIds } },
      select: {
        id: true,
        name: true,
        filePath: true,
        suiteId: true,
        feature: true,
        disabledAt: true,
      },
    }),
    /*
     * The idempotence check. NOT a constraint, and that is stated rather than
     * implied: `RetirementProposal` has no unique key on the test, so two ticks
     * racing on one project could file two proposals for one test. The sweep is
     * armed once per project per day and runs one campaign at a time, so the
     * race is narrow — but the right fix is a partial unique index on
     * `(testId)` restricted to the pending states, which is a migration this
     * round does not own. It is in the handover.
     */
    prisma.retirementProposal.findMany({
      where: { orgId, projectId, testId: { in: testIds }, state: { in: [...RETIREMENT_LIVE_STATES] } },
      select: { testId: true },
    }),
    prisma.ownershipRule.findMany({
      where: { orgId, projectId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: 500,
      select: OWNERSHIP_RULE_SELECT,
    }) as Promise<OwnershipRuleInput[]>,
  ]);

  const testById = new Map(tests.map((test) => [test.id, test]));
  const hasLiveProposal = new Set(live.map((row) => row.testId));

  /*
   * EVERY LIVE EDGE ON EVERY ITEM THESE TESTS TOUCH, in two reads, because the
   * question is not "what does this test cover" but "what would be left
   * covering it". The first read finds the items; the second finds every other
   * test on those items, with `Test.disabledAt` so a disabled test cannot be
   * counted as somebody else's cover — see `retirementSurfaceEffect`.
   */
  const ownEdges = await prisma.testCoverageEdge.findMany({
    where: { orgId, projectId, testId: { in: testIds }, retiredAt: null },
    take: RETIREMENT_SIGNAL_SCAN_CAP + 1,
    select: { itemId: true, testId: true },
  });
  const edgesCapped = ownEdges.length > RETIREMENT_SIGNAL_SCAN_CAP;
  const own = ownEdges.slice(0, RETIREMENT_SIGNAL_SCAN_CAP);
  const itemIds = [...new Set(own.map((edge) => edge.itemId))].sort();
  const siblingEdges =
    itemIds.length === 0
      ? []
      : await prisma.testCoverageEdge.findMany({
          where: { orgId, projectId, itemId: { in: itemIds }, retiredAt: null },
          take: RETIREMENT_SIGNAL_SCAN_CAP + 1,
          select: { itemId: true, testId: true, test: { select: { disabledAt: true } } },
        });
  const siblingsCapped = siblingEdges.length > RETIREMENT_SIGNAL_SCAN_CAP;
  const edges: RetirementCoverageEdge[] = siblingEdges
    .slice(0, RETIREMENT_SIGNAL_SCAN_CAP)
    .map((edge) => ({
      itemId: edge.itemId,
      testId: edge.testId,
      testDisabled: edge.test?.disabledAt != null,
    }));

  /*
   * ── THE EDGE CAP IS A GATE, NOT A DISCLOSURE ──────────────────────────────
   *
   * The opposite of the signal cap above, and the asymmetry is the direction of
   * the error. A truncated SIGNAL list can only make a test look weaker, so the
   * cap produces a refusal and the test keeps running. A truncated EDGE list
   * makes `covers` SMALLER, so `surfacesReturnedToUncovered` understates how
   * much coverage the retirement removes — and that number is STORED on the
   * proposal, with `denominatorNote` composed from it, so the row would tell a
   * reviewer "this returns 1 surface to UNCOVERED" about a retirement that
   * returns forty. A coverage cost reported lower than it is, is the flattering
   * lie this whole feature is arranged against, and a `capped: true` beside it
   * does not fix it: the sentence on the row is what somebody approves.
   *
   * So nothing is proposed, and the reason is the one that actually bit.
   */
  if (edgesCapped || siblingsCapped) {
    return empty(
      `No retirement was proposed: more than ${RETIREMENT_SIGNAL_SCAN_CAP} live coverage edges touch ` +
        'the candidate tests, so the number of surfaces a retirement would return to UNCOVERED ' +
        'could not be computed in full. That number is stored on the proposal and is what a ' +
        'reviewer approves, and one computed from a page of the edges would understate the ' +
        'coverage it costs.',
      true,
    );
  }

  let considered = 0;
  let created = 0;
  let alreadyProposed = 0;
  let alreadyDisabled = 0;
  let returned = 0;
  let stillCovered = 0;
  let proposalCapped = false;

  for (const testId of testIds) {
    const test = testById.get(testId);
    // A signal whose test has been deleted under us. Nothing to propose, and
    // the row will go when the cascade catches up.
    if (!test) continue;
    if (test.disabledAt !== null) {
      alreadyDisabled += 1;
      continue;
    }
    if (hasLiveProposal.has(testId)) {
      alreadyProposed += 1;
      continue;
    }

    const signals: ObsolescenceSignal[] = (byTest.get(testId) ?? []).map((row) => ({
      kind: row.kind,
      reference: row.reference,
      confirmations: row.confirmations,
    }));
    considered += 1;

    /*
     * THE ONE ADMISSION TEST, asked and not re-implemented.
     *
     * It returns a REASON and not a boolean, and the reason is the product:
     * LOCATOR_GONE and ROUTE_UNREACHABLE are `soleBasisForRetirement: false`
     * because both are also exactly what an unauthenticated or interrupted
     * crawl produces, so a test with nothing but those is a FINDING ("this test
     * may be stale") and never a proposal. Collapsing the two is how a test
     * that was merely unreached gets retired, which is the one mistake here
     * that re-crawling cannot undo.
     */
    const admission = retirementAdmissible(signals);
    if (!admission.admissible) {
      refused.SIGNALS_NOT_ADMISSIBLE += 1;
      continue;
    }

    if (created >= RETIREMENT_PROPOSALS_PER_TICK) {
      proposalCapped = true;
      break;
    }

    /*
     * THE DENOMINATOR CONSEQUENCE, COMPUTED BY THE ONE FUNCTION ALLOWED TO.
     *
     * `retirementSurfaceEffect` (@qaai/agent) turns the edges into the
     * `covers` / `alsoCoveredElsewhere` pair and asks
     * `retirementDenominatorEffect` what that does to the measurement. It is
     * not re-derived here, and the DISCLOSURE SENTENCE it returns is stored
     * verbatim rather than re-phrased: the coverage edges it was computed from
     * will have moved by the time a reviewer reads the row, and a sentence
     * rewritten at read time is a sentence that can disagree with the numbers
     * beside it.
     */
    const effect = retirementSurfaceEffect({ testId, edges });

    const routing = routeOwner(
      {
        id: test.id,
        filePath: test.filePath,
        suiteId: test.suiteId,
        feature: test.feature,
      },
      rules,
    );

    const expiresAt = expiryFor('RETIREMENT', now, RETIREMENT_REVIEW_DAYS);
    if (expiresAt === null) {
      /*
       * Unreachable with a positive constant, and checked anyway: `expiryFor`
       * REFUSES rather than substituting a default, and a proposal with no
       * expiry is a proposal that sits in the queue for ever pretending to be a
       * decision somebody is about to make. Counted as a suppression refusal
       * because that is what it is.
       */
      refused.SUPPRESSION_REFUSED += 1;
      continue;
    }

    /*
     * The reason is composed from QAAI'S OWN RECORDS ONLY — the signal kinds
     * and the confirmation threshold. The test's NAME and the route strings in
     * `ObsoleteTestSignal.reference` are the customer's own application text
     * and are deliberately absent: this string lands on a row a reviewer reads
     * and an audit entry, and it must not be composable into an instruction.
     * The same rule `proposeRetirement` states for its own reason sentence.
     */
    const kinds = [...new Set(signals.filter((s) => s.confirmations >= OBSOLESCENCE_MIN_CONFIRMATIONS).map((s) => s.kind))].sort();
    const reason =
      `Obsolete: ${kinds.join(', ')} confirmed by at least ${OBSOLESCENCE_MIN_CONFIRMATIONS} accepted crawls. ` +
      `Retiring this test DISABLES it — the code stays in your repository and in its history. ` +
      effect.disclosure;

    await prisma.retirementProposal.create({
      data: {
        orgId,
        projectId,
        testId,
        state: 'PROPOSED',
        reason,
        ownerUserId: routing.owner?.kind === 'USER' ? routing.owner.userId : null,
        ownerTeamId: routing.owner?.kind === 'TEAM' ? routing.owner.teamId : null,
        ownerState: routing.state,
        ownerProvenance: routing.provenance,
        expiresAt,
        signalIds: (byTest.get(testId) ?? []).map((row) => row.id).sort(),
        surfacesReturnedToUncovered: effect.surfacesReturnedToUncovered,
        surfacesStillCovered: effect.surfacesStillCovered,
        denominatorNote: effect.disclosure,
        /*
         * FALSE until the apply transaction re-opens them. This is the honesty
         * column: an APPLIED retirement with `surfacesReopened: false` is a
         * retirement that improved the coverage number, and writing `true` here
         * — before anything has been re-opened — is the one value that would
         * make that undetectable.
         */
        surfacesReopened: false,
        healProposalId: null,
      },
    });

    created += 1;
    returned += effect.surfacesReturnedToUncovered.length;
    stillCovered += effect.surfacesStillCovered.length;
  }

  /*
   * The edge cap cannot reach here — it returned above — so only two remain,
   * and the reason reported is the one that ACTUALLY bit rather than the first
   * one in the list: the proposal cap is checked first because it is the one
   * that changes what a reader should do next (come back on the next tick).
   */
  const capped = signalsCapped || proposalCapped;
  const cappedWhy = proposalCapped
    ? `the per-tick proposal cap of ${RETIREMENT_PROPOSALS_PER_TICK} bit`
    : signalsCapped
      ? `more than ${RETIREMENT_SIGNAL_SCAN_CAP} unresolved signals exist in this project`
      : null;

  const sweep: RetirementProposalSweep = {
    considered,
    created,
    alreadyProposed,
    alreadyDisabled,
    refused,
    evaluatedHere: RETIREMENT_REFUSALS_EVALUATED_IN_THE_LOOP,
    surfacesReturnedToUncovered: returned,
    surfacesStillCovered: stillCovered,
    capped,
    /*
     * The refusals as loudly as the proposals. "No retirement candidates" and
     * "nine candidates, all refused because only a locator was missing" are
     * completely different facts about a project, and a surface that showed
     * only the first would teach a customer that the feature does nothing.
     */
    disclosure:
      `${created} retirement(s) proposed for review out of ${considered} test(s) with confirmed ` +
      `obsolescence signals` +
      (created > 0
        ? `, which would return ${returned} surface(s) to UNCOVERED (${stillCovered} stay covered by another live test). The coverage percentage goes DOWN, not up.`
        : '.') +
      (refused.SIGNALS_NOT_ADMISSIBLE > 0
        ? ` ${refused.SIGNALS_NOT_ADMISSIBLE} refused as SIGNALS_NOT_ADMISSIBLE — a missing locator or an unreachable route is also what an unauthenticated crawl produces.`
        : '') +
      (alreadyProposed > 0 ? ` ${alreadyProposed} already have a live proposal.` : '') +
      (alreadyDisabled > 0 ? ` ${alreadyDisabled} are already disabled.` : '') +
      (cappedWhy === null ? '' : ` A cap bit (${cappedWhy}), so every count here is a floor.`),
  };

  logger.info({ campaignId: campaign.id, projectId, ...sweep }, 'retirement proposals swept');
  return sweep;
}

// ─── The sweep: arm what is due, advance what is running ─────────────────────

export interface CloseLoopSweep {
  armed: number;
  advanced: number;
  failed: number;
  /**
   * True when MORE campaigns were due than CLOSE_LOOP_SWEEP_LIMIT let this
   * sweep read.
   *
   * The cap itself is right — this is a guest in the 60-second tick — but a cap
   * applied without being disclosed is the lie this product cannot afford, and
   * `{ armed: 20, advanced: 20 }` reads identically whether twenty campaigns
   * were due or two thousand. Nothing is dropped: a campaign the sweep did not
   * reach keeps `nextTickAt` in the past and the rows are taken oldest-due
   * first, so it is strictly a deferral in FIFO order. But it is a deferral
   * worth seeing, because CLOSE_LOOP_TICK_MS is fifteen minutes and an install
   * with more than CLOSE_LOOP_SWEEP_LIMIT campaigns due per minute is one
   * falling permanently behind its own cadence.
   *
   * At-least-one rather than a count, because the count would cost a second
   * query every sixty seconds to sharpen a number nothing branches on. One row
   * past the limit is fetched to learn it.
   */
  moreDue: boolean;
}

/**
 * Called once per scheduler tick. Arms tonight's campaigns and advances the
 * ones whose next tick is due.
 *
 * NEVER THROWS, and that is a contract rather than politeness: this runs inside
 * `processScheduleTick` alongside the cron schedules and the production
 * monitors. A campaign that blows up must not take a customer's nightly suite
 * or their uptime check down with it, and a throw from here would do exactly
 * that — the schedule tick would fail, land in BullMQ's failed set, and the
 * repeatable job's next fire would be the only thing that recovered.
 */
/**
 * Record a tick that threw, and END THE CAMPAIGN once the ceiling is reached.
 *
 * ── THE BUG THIS IS ────────────────────────────────────────────────────────
 *
 * The failure path used to write `lastTickAt` and a sentence and nothing else.
 * `tick` is incremented in exactly one place — the successful tick's own
 * update — so a campaign whose tick threw every time was never counted and
 * never made terminal: RUNNING, tick 0, `nextTickAt` pushed forward every
 * sweep by its own claim, swept again sixty seconds later, for ever. Forty-one
 * failures against a ceiling of twenty-four. The ceiling was the one stop rule
 * advertised as depending on nothing but counting, and nothing was counting.
 *
 * Nor does it clear itself: `armCampaigns` only ever inserts for TODAY, and the
 * sweep reads every RUNNING campaign whose tick is due regardless of its
 * `dayKey`, so last week's stuck row keeps its place in the sweep's twenty
 * alongside tonight's.
 *
 * ── WHY `tick` AND NOT A FAILURE COUNTER ───────────────────────────────────
 *
 * Because a failure counter is a column, and the column that already exists
 * says what is needed: `ClosureCampaign.tick` is documented as "ticks taken,
 * and the hard ceiling's counter". A tick that was taken and threw was taken.
 * Counting it is both the honest reading of the column and the conservative
 * direction — it spends the campaign's budget of attempts, never extends it.
 *
 * ── WHAT THE SENTENCE MAY NOT SAY ──────────────────────────────────────────
 *
 * That anything was measured. A failed tick writes NO percentage: `lastPercent`
 * and `lastSnapshotId` keep whatever the last tick that completed left there,
 * while `lastTickAt` moves to now — so the row's own sentence has to say that
 * the numbers beside it are older than the timestamp above them, or the row
 * reads as a measurement it is not. Nothing here writes 0 in place of a null.
 */
async function recordFailedTick(campaign: CampaignRow, now: Date, err: unknown): Promise<void> {
  const tick = campaign.tick + 1;
  const why = err instanceof Error ? err.message : String(err);
  const terminal = pastTickCeiling(tick);

  await prisma.closureCampaign
    .update({
      where: { id: campaign.id },
      data: {
        tick,
        lastTickAt: now,
        ...(terminal
          ? {
              state: 'TICK_CEILING' satisfies ClosureCampaignState,
              // The same two columns the successful terminal path writes, and
              // for the same reason: the sweep reads `nextTickAt`, so this is
              // what makes the campaign structurally unable to tick again.
              nextTickAt: null,
              finishedAt: now,
              stoppedReason: `This campaign has taken ${tick} ticks, past its hard ceiling of ${CLOSE_LOOP_MAX_TICKS}, and the last one failed: ${why}. It stopped here. Nothing was measured on that tick, so any percentage on this row is from the last tick that completed, not from ${now.toISOString()}; a fresh campaign arms tomorrow.`,
            }
          : {
              stoppedReason: `Tick ${tick} of at most ${CLOSE_LOOP_MAX_TICKS} failed: ${why}. Nothing was measured, so any percentage on this row is from the last tick that completed rather than from ${now.toISOString()}. The campaign is still RUNNING and tries again at its next tick; failed ticks count toward the ceiling, so it cannot fail for ever.`,
            }),
      },
    })
    /*
     * SWALLOWED, BECAUSE THIS FUNCTION MAY NOT THROW — BUT NOT SILENTLY.
     *
     * The catch has to stay: `advanceClosureCampaigns` is contracted never to
     * throw, and a rejection here would escape into the scheduler tick and take
     * a customer's nightlies and monitors with it.
     *
     * What it must not do is vanish, and it used to. This is the write that
     * ENFORCES the ceiling — it is the only thing that increments `tick` on the
     * failure path and the only thing that writes TICK_CEILING and nulls
     * `nextTickAt`. If it fails, the campaign stays RUNNING at its old tick with
     * `nextTickAt` pushed forward by its own claim, and the sweep picks it up
     * again in fifteen minutes having counted nothing: the exact unbounded state
     * this function exists to rule out, reached by the failure of the fix rather
     * than by the original bug. The tick's own error is already logged by the
     * caller; this one was the one nobody could see.
     *
     * Logged at ERROR with both errors, because the two facts a reader needs are
     * "the tick failed" and "and we could not even write that down" — and the
     * second is the one that means the ceiling is not currently enforceable for
     * this row. Nothing is counted as having stopped: `sweep.failed` has already
     * counted the tick, and claiming a terminal state we failed to write is the
     * lie this file refuses in the other direction.
     */
    .catch((writeErr: unknown) => {
      logger.error(
        {
          err: writeErr,
          tickErr: why,
          campaignId: campaign.id,
          projectId: campaign.projectId,
          tick,
          wouldHaveBeenTerminal: terminal,
        },
        'could not record a failed closure tick; this campaign is still RUNNING at its old tick, so the hard ceiling did not advance for it',
      );
    });
}

export async function advanceClosureCampaigns(
  now: Date,
  deps: CloseLoopDeps = {},
): Promise<CloseLoopSweep> {
  const sweep: CloseLoopSweep = { armed: 0, advanced: 0, failed: 0, moreDue: false };

  try {
    sweep.armed = await armCampaigns(now);
  } catch (err) {
    logger.error({ err }, 'could not arm closure campaigns this tick');
  }

  let due: CampaignRow[] = [];
  try {
    due = await prisma.closureCampaign.findMany({
      where: { state: 'RUNNING', nextTickAt: { lte: now } },
      orderBy: { nextTickAt: 'asc' },
      // One past the limit, so the cap can be reported rather than merely
      // applied. See `CloseLoopSweep.moreDue`.
      take: CLOSE_LOOP_SWEEP_LIMIT + 1,
      select: {
        id: true,
        orgId: true,
        projectId: true,
        dayKey: true,
        targetPercent: true,
        topK: true,
        nightlyItemBudget: true,
        approvalPolicy: true,
        tick: true,
        itemsProposed: true,
        settledTicks: true,
        lastPercent: true,
        // The baseline's provenance, so the delta the tick publishes names the
        // stored row each of its operands came from. See `CampaignRow`.
        lastSnapshotId: true,
        recrawlQueuedAt: true,
      },
    });
  } catch (err) {
    logger.error({ err }, 'could not read due closure campaigns this tick');
    return sweep;
  }

  if (due.length > CLOSE_LOOP_SWEEP_LIMIT) {
    sweep.moreDue = true;
    // Dropped from this tick's work, not from the queue — `nextTickAt` is still
    // in the past on every one of them and the read is oldest-due first.
    due = due.slice(0, CLOSE_LOOP_SWEEP_LIMIT);
    logger.warn(
      { limit: CLOSE_LOOP_SWEEP_LIMIT },
      'more closure campaigns are due than one sweep may advance; the rest wait for the next tick',
    );
  }

  for (const campaign of due) {
    /*
     * The tick is CLAIMED before it runs, by pushing `nextTickAt` forward.
     *
     * Two workers can sweep the same second. Without this, both would read the
     * same due campaign and both would propose its top K — the duplicate
     * generation the ledger exists to prevent, arriving by a route the ledger
     * cannot see because neither row has been written yet. The conditional
     * update is the arbiter: exactly one worker's `updateMany` matches, and the
     * loser skips. Same mechanism as `claimShard` in processors/run.ts.
     */
    const claimed = await prisma.closureCampaign
      .updateMany({
        where: { id: campaign.id, state: 'RUNNING', nextTickAt: { lte: now } },
        data: { nextTickAt: new Date(now.getTime() + CLOSE_LOOP_TICK_MS) },
      })
      .catch(() => ({ count: 0 }));
    if (claimed.count === 0) continue;

    try {
      await processCloseLoopTick(campaign, deps);
      sweep.advanced += 1;
    } catch (err) {
      sweep.failed += 1;
      /*
       * Recorded on the row, not only logged, and COUNTED against the ceiling.
       * A campaign that has been failing for four ticks has to be able to say
       * so to whoever opens it, and a log line fifteen minutes ago is not that
       * — and a campaign that has been failing for forty has to stop. See
       * `recordFailedTick`.
       */
      await recordFailedTick(campaign, now, err);
      logger.error(
        { err, campaignId: campaign.id, projectId: campaign.projectId },
        'closure campaign tick failed',
      );
    }
  }

  return sweep;
}

/**
 * Arm one campaign per project per UTC day, for every project that asked.
 *
 * `Project.coverageTargetPercent` is the ON SWITCH: null means no campaign is
 * ever created, which is every project in every existing install until somebody
 * sets it. Archived projects are excluded — an autopilot spending model calls on
 * a project nobody opens is the worst kind of bill.
 *
 * The insert relies on the unique index to be the budget. `skipDuplicates`
 * rather than a read-then-write: two workers arming in the same second would
 * both see "no campaign today" and both insert, and only the constraint can
 * arbitrate that.
 */
async function armCampaigns(now: Date): Promise<number> {
  const dayKey = dayKeyOf(now);

  const projects = await prisma.project.findMany({
    where: {
      archivedAt: null,
      coverageTargetPercent: { not: null },
      // Nothing armed for this project today. The unique index is still the
      // authority; this just keeps the insert small.
      closureCampaigns: { none: { dayKey } },
    },
    take: CLOSE_LOOP_SWEEP_LIMIT,
    select: {
      id: true,
      orgId: true,
      coverageTargetPercent: true,
      closureApprovalPolicy: true,
      closureItemBudget: true,
    },
  });
  if (projects.length === 0) return 0;

  const created = await prisma.closureCampaign.createMany({
    data: projects.map((project) => ({
      orgId: project.orgId,
      projectId: project.id,
      dayKey,
      state: 'RUNNING',
      // Clamped: a target of 140 is a campaign that can never meet its target
      // and would tick to the ceiling every night.
      targetPercent: Math.max(1, Math.min(100, project.coverageTargetPercent ?? 100)),
      topK: CLOSE_LOOP_DEFAULT_TOP_K,
      nightlyItemBudget: Math.max(1, project.closureItemBudget ?? CLOSE_LOOP_DEFAULT_ITEM_BUDGET),
      approvalPolicy: approvalPolicyOf(project.closureApprovalPolicy),
      // Due immediately: the first tick is the measurement, and a campaign that
      // armed at 03:00 and first measured at 03:15 has lost a tick for nothing.
      nextTickAt: now,
    })),
    skipDuplicates: true,
  });

  if (created.count > 0) {
    logger.info({ dayKey, armed: created.count }, 'closure campaigns armed');
  }
  return created.count;
}
