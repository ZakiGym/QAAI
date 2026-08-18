/**
 * Plan limits, and actually enforcing them (§9).
 *
 * `PLAN_LIMITS` has been sitting in @qaai/shared describing four tiers since
 * the beginning, and nothing read it. Every org — including every free one —
 * could create unlimited projects, run unlimited suites, and hold artifacts
 * forever. The tiers were marketing copy, not a product.
 *
 * The rule this file follows: **limits gate the start of work, never the
 * finish.** Refusing to queue a run over quota is fair; killing a run halfway,
 * or hiding results already produced, means charging someone for compute and
 * then withholding the answer. So every check here happens before anything is
 * enqueued.
 */

import { PLAN_LIMITS, type Plan, type PlanLimits } from '@qaai/shared';
import { prisma, unscoped } from './prisma.js';
import { RUNS_METRIC, currentPeriod, effectivePlan, runQuota } from './start-run.js';

/*
 * The billing period key, the paying-status rule and the run ceiling itself now
 * live in start-run.ts. `currentPeriod` is re-exported rather than restated.
 *
 * They moved because apps/worker creates Runs too and cannot import this module
 * — it reaches for the tenancy-extended Prisma client, which reaches for the
 * API's env. A second copy of "which plan is this org metered at" is exactly
 * what let the free-tier run cap be enforced on two of the seven paths that
 * create a run and ignored on the other five.
 */
export { currentPeriod };

export interface PlanState {
  plan: Plan;
  limits: PlanLimits;
  status: string;
  /** True when the org is paying for what it is using. */
  paying: boolean;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export async function planFor(orgId: string): Promise<PlanState> {
  // Read unscoped: billing is looked at from webhook handlers that have no
  // tenant context, and the orgId here is always server-supplied.
  const subscription = await unscoped(() =>
    prisma.subscription.findUnique({
      where: { orgId },
      select: {
        plan: true,
        status: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
      },
    }),
  );

  // The org's own plan is the fallback for every install that never went
  // through Stripe checkout.
  const org = await unscoped(() =>
    prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } }),
  );

  const status = subscription?.status ?? 'active';

  /*
   * With no Subscription row, fall back to Organization.plan.
   *
   * This function used to read the Subscription alone, on the reasoning that
   * Stripe is the source of truth. That is right for anyone who bought through
   * Stripe and wrong for everyone else: a seeded org, a self-hosted install, an
   * enterprise contract signed offline, and any plan an operator set by hand all
   * have `Organization.plan` set and no Subscription at all. Every one of them
   * was silently metered at FREE.
   *
   * It was invisible until sharding, because FREE's other limits are generous
   * enough not to bite — but maxParallelWorkers is 1 on FREE, so every sharding
   * request on the seeded project clamped to a single shard and the feature
   * looked like it did nothing.
   *
   * A Subscription still wins when one exists: that is the paid path, and its
   * status is what decides whether the plan is currently honoured.
   *
   * An org that has stopped paying keeps its plan *label* — so the UI can say
   * "your Team plan is past due" rather than silently pretending they were
   * always free — but is metered at free limits. An org with no Subscription is
   * not "not paying"; it never had one, so its plan is honoured as set.
   *
   * The rule itself is `effectivePlan` in start-run.ts, so the worker's
   * scheduler answers "which plan is this org on" exactly the way this does.
   */
  const { plan, effective, paying } = effectivePlan(subscription, org?.plan ?? null);

  return {
    plan,
    limits: PLAN_LIMITS[effective],
    status,
    paying,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
  };
}

export interface UsageSnapshot {
  runsThisMonth: number;
  projects: number;
}

export async function usageFor(orgId: string): Promise<UsageSnapshot> {
  const [runs, projects] = await Promise.all([
    unscoped(() =>
      prisma.usageRecord.findUnique({
        where: { orgId_metric_period: { orgId, metric: RUNS_METRIC, period: currentPeriod() } },
        select: { quantity: true },
      }),
    ),
    unscoped(() => prisma.project.count({ where: { orgId, archivedAt: null } })),
  ]);

  return {
    // BigInt → number is safe here: the value is a monthly run count, and an
    // org clearing 2^53 runs in a month has a different problem.
    runsThisMonth: Number(runs?.quantity ?? 0n),
    projects,
  };
}

export interface LimitVerdict {
  allowed: boolean;
  /** Written for the person who hit it, not for a log. */
  reason?: string;
  /**
   * Which limit bit — lets the UI deep-link the right upgrade.
   *
   * `concurrency` is the odd one out and worth knowing about: it is the only
   * limit here that is TEMPORARY. Hitting `runs` or `projects` means buying
   * something; hitting `concurrency` means waiting, and the reason string that
   * comes with it says roughly how long. A UI that renders all three as the
   * same "upgrade to continue" wall would be lying about two of them. See
   * lib/concurrency.ts.
   */
  limit?: 'runs' | 'projects' | 'concurrency';
}

/**
 * Can this org start another run?
 *
 * `maxRunsPerMonth: null` means unlimited — every paid tier. Only FREE has a
 * ceiling, which is the point of the ceiling.
 *
 * Advisory, and kept for callers that want to refuse before doing expensive
 * work. It is no longer where the ceiling is ENFORCED: `startRun` asks the same
 * question again at the instant the row would be written, because a check
 * standing apart from the write is a check every new caller can forget to make
 * — and five of the seven forgot.
 */
export async function canStartRun(orgId: string): Promise<LimitVerdict> {
  const quota = await runQuota(prisma, orgId, unscoped);
  if (quota.allowed) return { allowed: true };
  return { allowed: false, limit: 'runs', reason: quota.reason };
}

export async function canCreateProject(orgId: string): Promise<LimitVerdict> {
  const [{ limits, plan }, usage] = await Promise.all([planFor(orgId), usageFor(orgId)]);
  if (usage.projects < limits.maxProjects) return { allowed: true };

  return {
    allowed: false,
    limit: 'projects',
    reason:
      `${PLAN_LIMITS[plan].label} includes ${limits.maxProjects} ` +
      `project${limits.maxProjects === 1 ? '' : 's'}, and you are using ${usage.projects}. ` +
      `Upgrade, or archive one you are finished with.`,
  };
}

export interface OverLimitFlag {
  limit: 'projects' | 'runs';
  used: number;
  max: number;
}

/**
 * The reverse of `canCreateProject` / `canStartRun`: given a plan the org is
 * about to DROP to, name everything already over that plan's ceilings.
 *
 * Deliberately observational. A downgrade never deletes anything — the excess
 * projects stay readable, the run history stays visible — because the customer
 * paid for the tier that produced them. What the lower plan takes away is the
 * ability to create MORE, and the forward checks above already enforce that on
 * every create. This function exists so the downgrade can say out loud what
 * those checks are about to start refusing, in the response and in the audit
 * row, instead of the customer discovering it at the next "New project" click.
 */
export async function overLimitFor(orgId: string, plan: Plan): Promise<OverLimitFlag[]> {
  const limits = PLAN_LIMITS[plan];
  const usage = await usageFor(orgId);

  const flags: OverLimitFlag[] = [];
  if (usage.projects > limits.maxProjects) {
    flags.push({ limit: 'projects', used: usage.projects, max: limits.maxProjects });
  }
  if (limits.maxRunsPerMonth !== null && usage.runsThisMonth > limits.maxRunsPerMonth) {
    flags.push({ limit: 'runs', used: usage.runsThisMonth, max: limits.maxRunsPerMonth });
  }
  return flags;
}

/**
 * Feature gates.
 *
 * SSO and the audit log are the two things `PLAN_LIMITS` marks as paid-tier.
 * They are checked here rather than inline so there is one place to look when
 * asking "what does Business actually get".
 */
export async function hasFeature(orgId: string, feature: 'sso' | 'auditLog'): Promise<boolean> {
  const { limits } = await planFor(orgId);
  return limits[feature];
}
