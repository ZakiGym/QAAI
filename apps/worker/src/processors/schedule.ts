/**
 * The scheduler tick (§6) — nightly runs and production monitors.
 *
 * One repeating job sweeps everything that is due rather than one timer per
 * schedule. That is deliberate: per-schedule timers drift, do not survive a
 * restart, and silently stop when a worker is replaced — a scheduler that
 * quietly stops is worse than no scheduler, because the green dashboard is a
 * lie about tests that never ran.
 *
 * Both kinds are idempotent under a double tick: a schedule advances its
 * `nextRunAt` before enqueuing, and a monitor stamps `lastCheckedAt` the same
 * way, so a retry cannot double-fire a run.
 */

import { CronExpressionParser } from 'cron-parser';
import type { ScheduleTickJob } from '@qaai/shared';
import { logger, prisma } from '../context.js';
import { enqueueRun, enqueueNotify } from '../queues.js';

/** Next fire time for a cron expression, or null when it is unparseable. */
function nextFireTime(cron: string, timezone: string, after: Date): Date | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone })
      .next()
      .toDate();
  } catch {
    return null;
  }
}

/** Queue a run of a suite, returning the run id. Shared by both paths. */
async function queueRun(args: {
  orgId: string;
  projectId: string;
  environmentId: string;
  suiteId: string;
  trigger: 'SCHEDULE' | 'MONITOR';
}): Promise<string | null> {
  const tests = await prisma.test.findMany({
    where: {
      orgId: args.orgId,
      projectId: args.projectId,
      disabledAt: null,
      suiteId: args.suiteId,
      filePath: { not: { startsWith: 'fixtures/' } },
    },
    select: { id: true },
  });
  if (tests.length === 0) return null;

  const run = await prisma.run.create({
    data: {
      orgId: args.orgId,
      projectId: args.projectId,
      environmentId: args.environmentId,
      suiteId: args.suiteId,
      trigger: args.trigger,
      totalCount: tests.length,
      results: {
        create: tests.map((t) => ({ orgId: args.orgId, testId: t.id, status: 'SKIPPED' as const })),
      },
    },
    select: { id: true },
  });

  await enqueueRun({ orgId: args.orgId, runId: run.id });
  return run.id;
}

export async function processScheduleTick(_job: ScheduleTickJob): Promise<void> {
  const now = new Date();

  // ── Cron schedules ────────────────────────────────────────────────────────
  const schedules = await prisma.schedule.findMany({
    where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      environmentId: true,
      suiteId: true,
      name: true,
      cron: true,
      timezone: true,
      nextRunAt: true,
    },
  });

  for (const schedule of schedules) {
    const next = nextFireTime(schedule.cron, schedule.timezone, now);
    if (!next) {
      // An unparseable cron would otherwise be retried every tick forever.
      logger.warn({ scheduleId: schedule.id, cron: schedule.cron }, 'disabling an invalid cron');
      await prisma.schedule.update({ where: { id: schedule.id }, data: { enabled: false } });
      continue;
    }

    // Claim BEFORE enqueuing: if the run fails to queue we lose one cycle,
    // which is far better than firing the same schedule twice.
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { nextRunAt: next, lastRunAt: schedule.nextRunAt ? now : null },
    });

    // A first sight of a schedule only arms it — firing immediately would mean
    // creating a nightly job at 2pm ran it at 2pm.
    if (!schedule.nextRunAt) {
      logger.info({ scheduleId: schedule.id, next }, 'schedule armed');
      continue;
    }

    const runId = await queueRun({ ...schedule, trigger: 'SCHEDULE' });
    logger.info({ scheduleId: schedule.id, runId, next }, 'schedule fired');
  }

  // ── Monitors ──────────────────────────────────────────────────────────────
  const monitors = await prisma.monitor.findMany({
    where: { enabled: true },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      environmentId: true,
      suiteId: true,
      name: true,
      intervalMinutes: true,
      lastCheckedAt: true,
      lastStatus: true,
      consecutiveFailures: true,
      failureThreshold: true,
    },
  });

  for (const monitor of monitors) {
    const dueAt = monitor.lastCheckedAt
      ? new Date(monitor.lastCheckedAt.getTime() + monitor.intervalMinutes * 60_000)
      : new Date(0);
    if (dueAt > now) continue;

    await prisma.monitor.update({ where: { id: monitor.id }, data: { lastCheckedAt: now } });

    const runId = await queueRun({ ...monitor, trigger: 'MONITOR' });
    if (runId) logger.info({ monitorId: monitor.id, runId }, 'monitor check queued');
  }
}

/**
 * Called when a monitor-triggered run finishes: track the streak and alert once
 * the threshold is crossed.
 *
 * Alerting on a streak rather than on every failure is the whole point — a
 * monitor that pages on one blip trains people to mute it.
 */
export async function recordMonitorResult(
  orgId: string,
  runId: string,
  status: string,
): Promise<void> {
  const run = await prisma.run.findFirst({
    where: { id: runId, orgId },
    select: { suiteId: true, environmentId: true, projectId: true },
  });
  if (!run?.suiteId) return;

  const monitor = await prisma.monitor.findFirst({
    where: {
      orgId,
      projectId: run.projectId,
      suiteId: run.suiteId,
      environmentId: run.environmentId,
      enabled: true,
    },
    select: { id: true, name: true, consecutiveFailures: true, failureThreshold: true },
  });
  if (!monitor) return;

  const failed = status !== 'PASSED';
  const streak = failed ? monitor.consecutiveFailures + 1 : 0;

  await prisma.monitor.update({
    where: { id: monitor.id },
    data: { consecutiveFailures: streak, lastStatus: status as never },
  });

  // Fire exactly on the crossing, not on every failure beyond it.
  if (failed && streak === monitor.failureThreshold) {
    await enqueueNotify({
      orgId,
      event: 'monitor.down',
      payload: { monitorId: monitor.id, name: monitor.name, runId, streak },
    }).catch(() => {});
    logger.warn({ monitorId: monitor.id, streak }, 'monitor threshold crossed');
  }
}
