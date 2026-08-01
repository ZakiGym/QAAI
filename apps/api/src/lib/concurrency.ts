/**
 * The org-wide concurrency budget (§9), and the hole it closes.
 *
 * `PLAN_LIMITS.maxParallelWorkers` caps shards PER RUN. Nothing capped an org.
 * So an Enterprise org could start four 50-shard runs back to back and have 200
 * browser jobs sitting in the pool, every one of them "within plan" — because
 * each run individually was. The pool is shared, so the org that did it starved
 * every other tenant on the box, and the only signal anyone got was that their
 * own runs stopped starting.
 *
 * ── What is being counted ───────────────────────────────────────────────────
 * A worker slot, not a run. A sharded run holds one slot per shard that is
 * QUEUED or RUNNING; an unsharded run holds exactly one. That is the unit that
 * actually consumes a browser, and counting runs instead would let a single
 * 50-shard run look identical to a single one-test smoke check.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * **An org may hold `maxParallelWorkers × 2` worker slots at once. A request
 * that would start with none free is refused, with the plan's number, what is
 * using it, and when the next slot is expected back.**
 *
 * Two, rather than one. Setting the org budget equal to `maxParallelWorkers`
 * reads tidier and is wrong in the ordinary case: a single run at full width
 * would saturate the org, so the second pull request of the morning gets a 402
 * while the box is half idle. Doubling it lets the widest run the plan sells
 * coexist with another of the same width — two PRs, or a PR alongside the
 * nightly schedule — and still turns the four-50-shard-run case from 200 queued
 * jobs into 100. The multiplier is one constant, named, in one place, precisely
 * because it is a pricing decision rather than a technical one.
 *
 * ── This gate fails OPEN ────────────────────────────────────────────────────
 * If the count cannot be taken — the database is unhappy, a query times out —
 * the answer is ALLOW. A budget is a fairness mechanism, and being briefly
 * unfair is a far smaller harm than refusing a customer's CI run because a
 * SELECT failed. The refusal path must be reached on purpose, never by
 * accident.
 */

import { PLAN_LIMITS, type PlanLimits } from '@qaai/shared';
import { prisma, unscoped } from './prisma.js';
import { planFor, type LimitVerdict } from './plan.js';
import { logger } from './logger.js';

/**
 * How many times its per-run worker ceiling an org may hold in total.
 *
 * Change this and you change what every plan is worth; see the note above on
 * why it is not 1.
 */
export const ORG_CONCURRENCY_FACTOR = 2;

/**
 * A ceiling on how many shard rows are read to take the count.
 *
 * The largest budget any plan grants is ENTERPRISE's 50 × 2 = 100, so reading
 * 500 rows and stopping is not an approximation that can change an answer: any
 * org at 500 in-flight slots is over every budget that exists, and the verdict
 * is the same whether the true figure is 500 or 5000. Bounding it keeps a
 * runaway tenant from turning this check into the slowest query on the page.
 */
const SHARD_SCAN_LIMIT = 500;

/** A slot currently held, and what is known about when it will be given back. */
export interface InFlightSlot {
  runId: string;
  running: boolean;
  /** When the shard started, for a RUNNING one. Null while queued. */
  startedAt: Date | null;
  /** The packer's duration prediction for this slice, or 0 when it had none. */
  estimatedMs: number;
}

export interface ConcurrencySnapshot {
  /** Worker slots held right now: shards in flight, plus unsharded runs. */
  inFlight: number;
  /** Distinct runs those slots belong to — for the message, not the maths. */
  runs: number;
  budget: number;
  /** Slots free right now; never negative. */
  available: number;
  /**
   * Milliseconds until the next slot is predicted to free, or null when nothing
   * in flight has a usable prediction. Null means "unknown", and the message
   * says so rather than inventing a number.
   */
  freesInMs: number | null;
}

/** The org-wide ceiling for a plan. */
export function orgConcurrencyBudget(limits: PlanLimits): number {
  // Never below 1: a plan whose per-run ceiling was set to 0 by a bad edit must
  // still let an org run one test, not lock it out of the product entirely.
  return Math.max(1, limits.maxParallelWorkers * ORG_CONCURRENCY_FACTOR);
}

/**
 * When the first slot comes back, in milliseconds, or null if nothing can say.
 *
 * Built on `RunShard.estimatedMs`, which the duration-balanced packer already
 * wrote when it decided the split — so this reuses a prediction that exists
 * rather than inventing a second one that could disagree with it.
 *
 * Only RUNNING slots are consulted. A QUEUED slot has not started, so the only
 * honest thing to say about when it finishes is nothing; and a slot already
 * past its estimate reports 0 rather than a negative number, which reads as
 * "any moment now" and is the truth.
 */
export function soonestFreeMs(slots: InFlightSlot[], now: number): number | null {
  let soonest: number | null = null;
  for (const slot of slots) {
    if (!slot.running || !slot.startedAt || slot.estimatedMs <= 0) continue;
    const remaining = Math.max(0, slot.estimatedMs - (now - slot.startedAt.getTime()));
    if (soonest === null || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

/**
 * A duration a person would say out loud. Deliberately vague at every scale —
 * the input is a prediction from historical test durations, and "in about 4
 * minutes" is honest about that in a way "in 3m 47s" is not.
 */
export function describeWait(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 60_000) return 'in under a minute';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The decision, as a pure function of the snapshot — no clock, no database.
 *
 * Kept separate from the query above it so the interesting part is testable
 * without a Postgres: every boundary, every message, and the fail-open path.
 */
export function verdictFor(snapshot: ConcurrencySnapshot, planLabel: string): LimitVerdict {
  if (snapshot.available > 0) return { allowed: true };

  const when = describeWait(snapshot.freesInMs);
  const runs = `${snapshot.runs} run${snapshot.runs === 1 ? '' : 's'}`;

  return {
    allowed: false,
    limit: 'concurrency',
    reason:
      `${planLabel} runs up to ${snapshot.budget} test workers at once, and all ${snapshot.budget} ` +
      `are busy across your ${runs}. ` +
      // Naming the moment when it can be named is the difference between a
      // limit and a wall. When it cannot, say that plainly instead of guessing.
      (when
        ? `The next one should free up ${when} — start this run then, or upgrade for more parallelism.`
        : `Capacity frees up as those finish — or upgrade for more parallelism.`),
  };
}

/**
 * Count what this org is holding, right now.
 *
 * Read unscoped with an explicit `orgId`, matching plan.ts next door: the id is
 * always server-supplied, and this is asked from places that have no tenant
 * scope open.
 */
export async function concurrencySnapshot(orgId: string): Promise<ConcurrencySnapshot> {
  const { limits } = await planFor(orgId);
  return snapshotWith(orgId, limits);
}

/**
 * The counting half, given a plan that has already been read.
 *
 * Split out so the callers that need the plan for something else — the label in
 * the refusal message, say — do not read the Subscription and Organization rows
 * a second time to get the same answer.
 */
async function snapshotWith(orgId: string, limits: PlanLimits): Promise<ConcurrencySnapshot> {
  const budget = orgConcurrencyBudget(limits);

  const [shards, unshardedRuns] = await Promise.all([
    unscoped(() =>
      prisma.runShard.findMany({
        where: {
          orgId,
          status: { in: ['QUEUED', 'RUNNING'] },
          // A shard belonging to a run that already reported is not holding
          // anything, whatever its own row still says.
          run: { finalizedAt: null },
        },
        select: { runId: true, status: true, startedAt: true, estimatedMs: true },
        take: SHARD_SCAN_LIMIT,
      }),
    ),
    unscoped(() =>
      prisma.run.count({
        where: {
          orgId,
          status: { in: ['QUEUED', 'RUNNING'] },
          // Sharded runs are counted through their shard rows above; counting
          // the run as well would charge a 50-shard run for 51 slots.
          shardCount: { lte: 1 },
          finalizedAt: null,
        },
      }),
    ),
  ]);

  const slots: InFlightSlot[] = shards.map((s) => ({
    runId: s.runId,
    running: s.status === 'RUNNING',
    startedAt: s.startedAt,
    estimatedMs: s.estimatedMs,
  }));

  const inFlight = slots.length + unshardedRuns;
  const runs = new Set(slots.map((s) => s.runId)).size + unshardedRuns;

  return {
    inFlight,
    runs,
    budget,
    available: Math.max(0, budget - inFlight),
    freesInMs: soonestFreeMs(slots, Date.now()),
  };
}

/**
 * Can this org put another run into the pool?
 *
 * The one function the create-run route needs. It answers "is there any room at
 * all"; how WIDE the run may then go is a separate clamp — see
 * `availableWorkers` below, which the shard planner can take as a second
 * ceiling alongside `maxParallelWorkers`.
 *
 * Refusing outright when the whole request does not fit would be the wrong
 * shape: an org with 40 of 100 slots free asking for a 50-shard run should get
 * 40 shards, not a 402. Only "no room whatsoever" is a refusal.
 */
export async function canStartConcurrentRun(orgId: string): Promise<LimitVerdict> {
  try {
    const { plan, limits } = await planFor(orgId);
    const snapshot = await snapshotWith(orgId, limits);
    return verdictFor(snapshot, PLAN_LIMITS[plan].label);
  } catch (err) {
    /*
     * Fail open, loudly. See the header: a fairness gate that cannot take its
     * measurement must let the work through, because the alternative is
     * charging a customer for a plan and then refusing their CI run over a
     * failed SELECT. The log line is what makes the silence noticeable.
     */
    logger.error({ err, orgId }, 'could not measure org concurrency; allowing the run');
    return { allowed: true };
  }
}

/**
 * How many workers this org may still put in the pool.
 *
 * Returned as a number rather than a verdict because its caller is a clamp, not
 * a gate: the shard planner should take `Math.min(requested, maxParallelWorkers,
 * available, testCount)`. Fails open at the plan's per-run ceiling, so a
 * measurement failure can only ever restore today's behaviour and never tighten
 * it by accident.
 */
export async function availableWorkers(orgId: string): Promise<number> {
  try {
    const snapshot = await concurrencySnapshot(orgId);
    return snapshot.available;
  } catch (err) {
    logger.error({ err, orgId }, 'could not measure org concurrency; not clamping the split');
    const { limits } = await planFor(orgId);
    return limits.maxParallelWorkers;
  }
}
