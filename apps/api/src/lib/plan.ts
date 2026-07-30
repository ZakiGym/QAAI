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

/** The first instant of the current UTC billing month. */
export function currentPeriod(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * A subscription in a non-paying state falls back to FREE limits rather than
 * to nothing.
 *
 * Stripe reports `past_due` for a card that failed to charge, which is very
 * often a bank blip and not a decision to stop paying. Locking a team out of
 * their CI over that is a way to lose the customer; dropping them to free
 * limits is a way to get them to update the card.
 */
const PAYING_STATUSES = new Set(['active', 'trialing']);

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

  const status = subscription?.status ?? 'active';
  const paying = subscription ? PAYING_STATUSES.has(status) : false;

  // An org that has stopped paying keeps its plan *label* — so the UI can say
  // "your Team plan is past due" rather than silently pretending they were
  // always free — but is metered at free limits.
  const plan = subscription?.plan ?? 'FREE';
  const effective: Plan = paying || plan === 'FREE' ? plan : 'FREE';

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
        where: { orgId_metric_period: { orgId, metric: 'runs', period: currentPeriod() } },
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
  /** Which limit bit — lets the UI deep-link the right upgrade. */
  limit?: 'runs' | 'projects';
}

/**
 * Can this org start another run?
 *
 * `maxRunsPerMonth: null` means unlimited — every paid tier. Only FREE has a
 * ceiling, which is the point of the ceiling.
 */
export async function canStartRun(orgId: string): Promise<LimitVerdict> {
  const [{ limits, plan }, usage] = await Promise.all([planFor(orgId), usageFor(orgId)]);
  const cap = limits.maxRunsPerMonth;
  if (cap === null || usage.runsThisMonth < cap) return { allowed: true };

  return {
    allowed: false,
    limit: 'runs',
    reason:
      `You have used all ${cap} runs included with ${PLAN_LIMITS[plan].label} this month. ` +
      `They reset on the 1st — or upgrade for unlimited runs.`,
  };
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
