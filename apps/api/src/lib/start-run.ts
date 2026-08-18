/**
 * Creating a Run, and the two tolls that go with it (§9).
 *
 * A run is not free. It costs a browser, a worker slot, and — on FREE — one of
 * a hundred runs a month. So creating one has always been meant to do three
 * things in this order: ask whether the org may, write the row, count it.
 *
 * Only two of the seven places that create a Run did all three. `POST /runs`
 * and `POST /repro` paid both tolls. The pull-request webhook, the GitHub App
 * re-run button, the scheduler, the bisect prober, the flake confirmer and the
 * copilot's `run_tests` tool paid neither, and the two halves of that disagreed
 * in opposite directions:
 *
 *   • The FREE ceiling was bypassable permanently. Anyone who made a nightly
 *     schedule instead of pressing Run got unlimited browsers on a free
 *     account — and because nothing on that path moved the counter, `POST /runs`
 *     never refused either. The tier's only meaningful limit was decorative.
 *   • `GET /billing` reported `usage.runsThisMonth` off a counter that five of
 *     the seven paths never incremented. Every paying customer's usage screen
 *     was wrong by however much of their testing was automated, which for a CI
 *     product is nearly all of it.
 *
 * The toll therefore lives here, once, and all seven paths go through
 * `startRun`. Two copies of a toll is how this drifted in the first place.
 *
 * ── Why this module takes its Prisma client as an argument ──────────────────
 * Four of the seven callers are in apps/worker, a different workspace. It
 * cannot import lib/plan.ts: that module reaches for the API's tenancy-extended
 * Prisma singleton, which reaches for the API's env, which would drag the whole
 * server into the worker process. So nothing here touches process state — the
 * client and the tenancy escape hatch arrive as parameters, exactly like
 * lib/bisect.ts and lib/ownership.ts, which the worker already imports across
 * the workspace boundary by relative path.
 *
 * ── Two modes, because a queue is not a request ─────────────────────────────
 * `enforce` throws 402 at the person who asked, which is right for an HTTP
 * caller and wrong for a cron: a scheduled tick that throws vanishes into the
 * queue's failed set and the customer's nightly silently stops — a worse bug
 * than the one being fixed. `advisory` returns the refusal instead, and each
 * background caller reports it through whatever it already uses to say what
 * happened: the bisect report, the flake investigation's audit row, the
 * webhook's `ignored` reason, the copilot tool's `error`.
 *
 * ── Metering is unconditional ───────────────────────────────────────────────
 * If this function creates a Run, it increments `runs`. There is no path, mode
 * or trigger that gets one for free — that exemption is precisely what made the
 * counter a lie. The converse holds as well: a refusal writes no Run row, so it
 * counts nothing, and an org already over its cap does not watch its usage
 * climb for work that never ran.
 */

import { PLAN_LIMITS, type Plan } from '@qaai/shared';
import { planLimit } from './errors.js';
import type { Prisma, PrismaClient, Run } from '../generated/prisma/client.js';

/** The metric key on UsageRecord that `GET /billing` reads back as usage. */
export const RUNS_METRIC = 'runs';

/**
 * The slice of the Prisma client the toll needs.
 *
 * Both clients satisfy it structurally: the API's tenancy-extended one (cast
 * back to the base client's type in lib/prisma.ts) and the worker's raw one,
 * which is generated from this same schema.
 */
export type RunStore = Pick<PrismaClient, 'run' | 'usageRecord' | 'subscription' | 'organization'>;

/**
 * The Run row a caller wants written — exactly what would have gone to
 * `prisma.run.create({ data })`, unchanged. Every caller writes a different
 * shape (shards, a base-URL override, a bisect tag), and none of that is this
 * module's business; the toll is.
 */
export type RunCreateData = Prisma.RunUncheckedCreateInput;

/**
 * How to run a read that must escape the caller's tenant scope.
 *
 * The API passes `unscoped`, because a plan is read from places that have no
 * org in scope — the Stripe webhook, the GitHub webhook before the repo is
 * matched. The worker's client has no tenancy layer at all, so it passes
 * nothing and the identity runner below applies.
 */
export type Unscope = <T>(fn: () => Promise<T>) => Promise<T>;

const runDirectly: Unscope = (fn) => fn();

/** The first instant of the current UTC billing month — the UsageRecord key. */
export function currentPeriod(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * A subscription in a non-paying state falls back to FREE limits rather than to
 * nothing. Stripe reports `past_due` for a card that failed to charge, which is
 * very often a bank blip and not a decision to stop paying; locking a team out
 * of their CI over that is a way to lose the customer.
 */
const PAYING_STATUSES = new Set(['active', 'trialing']);

/**
 * Which plan an org is metered at, given what Stripe says and what the row says.
 *
 * `plan` is what was BOUGHT — the label the UI shows, so it can say "your Team
 * plan is past due" rather than pretending the org was always free. `effective`
 * is what the limits come from.
 *
 * With no Subscription row at all, `Organization.plan` is the answer: a seeded
 * org, a self-hosted install, an enterprise contract signed offline and any
 * plan an operator set by hand all have it set and never went through Stripe
 * checkout. An org that never had a subscription is not "not paying".
 */
export function effectivePlan(
  subscription: { plan: Plan; status: string } | null,
  orgPlan: Plan | null,
): { plan: Plan; effective: Plan; paying: boolean } {
  const plan = subscription?.plan ?? orgPlan ?? 'FREE';
  const paying = subscription ? PAYING_STATUSES.has(subscription.status) : false;
  const effective: Plan = !subscription || paying || plan === 'FREE' ? plan : 'FREE';
  return { plan, effective, paying };
}

export interface RunQuota {
  /** What the org bought. The label the UI shows. */
  plan: Plan;
  /** What it is metered at. Differs from `plan` only while a card is failing. */
  effective: Plan;
  /** `null` means unlimited — every paid tier. Only FREE has a ceiling. */
  cap: number | null;
  used: number;
  allowed: boolean;
  /** Written for the person who hit it, not for a log. Set only when refused. */
  reason?: string;
}

/**
 * May this org start another run this month, and how close is it?
 *
 * Reads the same UsageRecord row `startRun` increments, so the ceiling can
 * never disagree with the meter.
 */
export async function runQuota(
  db: RunStore,
  orgId: string,
  unscope: Unscope = runDirectly,
): Promise<RunQuota> {
  const [subscription, org, usage] = await Promise.all([
    unscope(() =>
      db.subscription.findUnique({ where: { orgId }, select: { plan: true, status: true } }),
    ),
    unscope(() => db.organization.findUnique({ where: { id: orgId }, select: { plan: true } })),
    unscope(() =>
      db.usageRecord.findUnique({
        where: { orgId_metric_period: { orgId, metric: RUNS_METRIC, period: currentPeriod() } },
        select: { quantity: true },
      }),
    ),
  ]);

  const { plan, effective } = effectivePlan(subscription, org?.plan ?? null);
  const cap = PLAN_LIMITS[effective].maxRunsPerMonth;
  // BigInt → number is safe here: the value is a monthly run count, and an org
  // clearing 2^53 runs in a month has a different problem.
  const used = Number(usage?.quantity ?? 0n);

  if (cap === null || used < cap) return { plan, effective, cap, used, allowed: true };

  return {
    plan,
    effective,
    cap,
    used,
    allowed: false,
    // Names the plan they bought, not the one they are metered at, so a
    // past-due Team org is not told it is on Free.
    reason:
      `You have used all ${cap} runs included with ${PLAN_LIMITS[plan].label} this month. ` +
      `They reset on the 1st — or upgrade for unlimited runs.`,
  };
}

/**
 * `enforce` throws 402 at an HTTP caller. `advisory` hands the refusal back for
 * a background path to record. Explicit at every call site — there is no
 * default, because guessing wrong in either direction is a bug that hides.
 */
export type StartRunMode = 'enforce' | 'advisory';

export interface StartRunArgs {
  db: RunStore;
  orgId: string;
  mode: StartRunMode;
  data: RunCreateData;
  unscope?: Unscope;
  /**
   * Appended to the refusal message in `enforce` mode, for a caller that has
   * something specific to add about what did and did not survive the refusal.
   */
  note?: string;
}

export type StartRunResult =
  | { created: true; run: Run; quota: RunQuota }
  | { created: false; run: null; quota: RunQuota };

/**
 * Gate, create, count. The only supported way to bring a Run into existence.
 *
 * The gate is asked here rather than trusted to the caller because five of the
 * seven callers did not ask it. A caller may of course check earlier as well —
 * `POST /runs` does, so that a run which cannot happen does not pay for an
 * impact analysis first — but the check that decides is this one, taken against
 * the counter as it stands at the moment the row would be written.
 */
export async function startRun(
  args: StartRunArgs & { mode: 'enforce' },
): Promise<{ created: true; run: Run; quota: RunQuota }>;
export async function startRun(
  args: StartRunArgs & { mode: 'advisory' },
): Promise<StartRunResult>;
export async function startRun(args: StartRunArgs): Promise<StartRunResult> {
  const { db, orgId, mode, data, unscope = runDirectly, note } = args;

  const quota = await runQuota(db, orgId, unscope);
  if (!quota.allowed) {
    if (mode === 'enforce') {
      throw planLimit([quota.reason ?? 'Plan limit reached', note].filter(Boolean).join(' '), {
        limit: 'maxRunsPerMonth',
        plan: quota.plan,
      });
    }
    return { created: false, run: null, quota };
  }

  const run: Run = await db.run.create({ data });

  /*
   * The count, immediately after the row and never conditionally.
   *
   * Unscoped on purpose: the row carries its own orgId, and this has to behave
   * identically whether it is called inside a request's tenant scope or from a
   * worker whose client has no tenancy layer at all.
   *
   * Not wrapped in a try. A run this process could not meter is a run the
   * billing screen will under-report forever, and the failure that produces it
   * (the database is gone) is one the caller needs to see rather than one to
   * paper over — the same reasoning that has always applied on `POST /runs`.
   */
  const period = currentPeriod();
  await unscope(() =>
    db.usageRecord.upsert({
      where: { orgId_metric_period: { orgId, metric: RUNS_METRIC, period } },
      create: { orgId, metric: RUNS_METRIC, period, quantity: 1n },
      update: { quantity: { increment: 1n } },
    }),
  );

  return { created: true, run, quota };
}
