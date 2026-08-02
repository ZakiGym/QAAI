/**
 * Artifact retention, from the operator's side (§5, §9).
 *
 * Three endpoints, and the split between them is the whole design:
 *
 *   GET  /retention/usage    what you are storing, and what it costs      MEMBER
 *   GET  /retention/preview  what a sweep would delete, before it does    ADMIN
 *   POST /retention/sweep    ask for one                                  OWNER
 *
 * Two of the three are read-only and neither of those can delete anything, on
 * any code path, under any parameter. The third does not delete either — it
 * enqueues, and the worker decides. That indirection is deliberate: object
 * deletion belongs to the process that owns the storage handle and the
 * conservative sweep engine, not to an HTTP handler where a timeout halfway
 * through leaves a batch half-applied with nobody holding the report.
 *
 * ── Why the preview is not its own implementation ───────────────────────────
 *
 * `decideArtifact` is imported from packages/storage and is the SAME function
 * the worker's sweep calls per row. A preview computed by a second copy of the
 * rules is a number somebody reads, believes, and switches destruction on the
 * strength of — and the day the two drift is the day it becomes a lie. The one
 * check the preview cannot afford to run per request is the active-triage
 * lookup, so it passes `triageActive: false`, which can only ever make the
 * preview report MORE than the sweep will delete. That direction is on purpose:
 * an operator who is shown 5,000 and loses 4,200 is never surprised by a
 * deletion they did not expect. The response says so in `upperBound`.
 *
 * ── Why the numbers come with a caveat attached ─────────────────────────────
 *
 * `Artifact.sizeBytes` defaults to 0 and only the on-prem upload endpoint
 * (routes/runners.ts) ever sets it — the cloud run path in the worker writes the
 * row without a size. So a byte total summed from rows understates, badly, and
 * every response here carries `measurement.complete` and the count of rows it
 * could not measure rather than printing a confident wrong number. See
 * `needsOwnerDecision`.
 */

import { Router } from 'express';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { PLAN_LIMITS, TERMINAL_RUN_STATUSES } from '@qaai/shared';
import type { Plan } from '@qaai/shared';
/*
 * WHY THIS IMPORT IS A RELATIVE PATH: @qaai/storage exports only its barrel
 * (`"exports": { ".": "./src/index.ts" }`) and `gc.ts` is a second entry point.
 * Adding it there is a one-line change to a file this wave does not own — see
 * `needsOwnerDecision`. The same workaround is documented at the top of
 * routes/suite-health.ts. The specifier resolves identically under tsc and tsx.
 */
import { decideArtifact, humanBytes } from '../../../../packages/storage/src/gc.js';
import type { KeepReason } from '../../../../packages/storage/src/gc.js';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { badRequest } from '../lib/errors.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const retentionRouter: Router = Router();

retentionRouter.use(requireAuth);

/**
 * Must match RETENTION_QUEUE in apps/worker/src/processors/retention.ts.
 *
 * Two constants rather than one because `QUEUE_NAMES` lives in @qaai/shared,
 * which this wave does not own, and neither app may import the other's module
 * here (the worker's processor opens Postgres, Redis and the LLM at import). The
 * worker's unit test pins this exact literal. If they ever diverge, every sweep
 * requested through this endpoint lands in a queue nobody drains and sits in
 * Redis until it is evicted, silently. See `needsOwnerDecision`.
 */
const RETENTION_QUEUE = 'qaai.retention';

/** How long a preview will look, per request. A guard, not an opinion. */
const MAX_PREVIEW_ROWS = 1_000;

/** Keys echoed back in a preview. Enough to eyeball, not enough to be a payload. */
const SAMPLE_LIMIT = 25;

/**
 * The retention window this org gets, in days: the longest any plan record
 * gives it.
 *
 * Mirrors `retentionDaysForPlan` in the worker's processor, including the
 * ENTERPRISE fallback for an unrecognised plan string — an unknown plan is
 * schema drift, not a licence to delete sooner. Deliberately NOT
 * `lib/plan.ts#planFor`, which resolves what an org may DO (and drops a
 * past-due subscription to FREE limits). Applying that here would shorten a
 * customer's retention because their card bounced, which is a way to destroy
 * data over a bank blip.
 */
function retentionDaysForPlan(plan: string | null | undefined): number {
  return (
    PLAN_LIMITS[plan as Plan]?.artifactRetentionDays ?? PLAN_LIMITS.ENTERPRISE.artifactRetentionDays
  );
}

async function retentionDaysFor(orgId: string): Promise<{ days: number; plan: string }> {
  const [org, subscription] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } }),
    prisma.subscription.findUnique({ where: { orgId }, select: { plan: true } }),
  ]);
  const fromOrg = retentionDaysForPlan(org?.plan);
  const fromSub = subscription ? retentionDaysForPlan(subscription.plan) : 0;
  // Report the plan that PRODUCED the window, not whichever record happened to
  // be checked last. An org sitting on a BUSINESS record with a TEAM
  // subscription would otherwise be told "plan: TEAM, retentionDays: 90", which
  // reads as a bug in the number rather than as the deliberate max() it is.
  return fromSub > fromOrg
    ? { days: fromSub, plan: subscription?.plan ?? 'FREE' }
    : { days: fromOrg, plan: org?.plan ?? 'FREE' };
}

// ─── GET /retention/usage ────────────────────────────────────────────────────

/**
 * "You are using 4.2 GB of your 30-day retention."
 *
 * Aggregates only — no key lists, no storage calls, nothing that grows with the
 * org. MEMBER rather than ADMIN because this is the number a team looks at
 * before wondering why their bill moved, and hiding it behind an admin role is
 * how people find out from the invoice instead.
 */
retentionRouter.get('/usage', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 86_400_000);

  // Tenancy is enforced by the Prisma extension, so every aggregate below is
  // already confined to this org; there is no orgId in any of these filters and
  // there must not be one.
  const [all, expired, expiringSoon, noExpiry, unmeasured, oldest] = await Promise.all([
    prisma.artifact.aggregate({ _count: { _all: true }, _sum: { sizeBytes: true } }),
    prisma.artifact.aggregate({
      where: { expiresAt: { not: null, lt: now } },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    }),
    prisma.artifact.aggregate({
      where: { expiresAt: { not: null, gte: now, lt: soon } },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    }),
    prisma.artifact.count({ where: { expiresAt: null } }),
    prisma.artifact.count({ where: { sizeBytes: 0 } }),
    prisma.artifact.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);

  const total = all._count._all;
  const recorded = all._sum.sizeBytes ?? 0;
  const { days, plan } = await retentionDaysFor(actor.orgId);

  res.json({
    plan,
    retentionDays: days,
    artifacts: {
      total,
      expired: expired._count._all,
      expiringWithin7Days: expiringSoon._count._all,
      /*
       * Rows carrying no expiry at all. Surfaced rather than folded into the
       * total because they are the ones retention will never touch — an artifact
       * with no stamp is kept forever by design (the sweep refuses to invent a
       * window), so a number climbing here is a bug upstream in whatever wrote
       * them, showing up as an unexplained bill.
       */
      noExpiry,
    },
    bytes: {
      recorded,
      recordedHuman: humanBytes(recorded),
      expired: expired._sum.sizeBytes ?? 0,
      expiredHuman: humanBytes(expired._sum.sizeBytes ?? 0),
    },
    measurement: {
      complete: unmeasured === 0,
      unmeasuredArtifacts: unmeasured,
      note:
        unmeasured === 0
          ? 'Every artifact has a recorded size.'
          : `${unmeasured} of ${total} artifacts have no recorded size, so the byte totals above are a floor, not a total. Sizes are recorded at upload by on-prem runners; cloud runs do not record one yet.`,
    },
    oldestArtifactAt: oldest?.createdAt ?? null,
  });
});

// ─── GET /retention/preview ──────────────────────────────────────────────────

const previewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PREVIEW_ROWS).optional(),
  cursor: z.string().min(1).optional(),
  /** Hours past expiry before a row counts. Matches the worker's default. */
  graceHours: z.coerce.number().min(0).max(24 * 365).optional(),
});

/**
 * The blast radius, before anything happens.
 *
 * ADMIN, because "here are the keys we are about to destroy" is an
 * administrative question even though it changes nothing. Read-only in the
 * strongest sense: this handler holds no storage client and calls no mutating
 * Prisma method.
 */
retentionRouter.get('/preview', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = previewQuery.parse(req.query);
  const now = new Date();
  const graceMs = (input.graceHours ?? 24) * 3_600_000;
  const limit = input.limit ?? 200;
  const cutoff = new Date(now.getTime() - graceMs);

  const rows = await prisma.artifact.findMany({
    where: {
      expiresAt: { not: null, lt: cutoff },
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
    },
    // Keyset on the unique id, exactly as the sweep pages, so "page 2 of the
    // preview" and "batch 2 of the sweep" are the same rows in the same order.
    orderBy: { id: 'asc' },
    take: limit,
    select: {
      id: true,
      orgId: true,
      runId: true,
      key: true,
      sizeBytes: true,
      createdAt: true,
      expiresAt: true,
      run: { select: { status: true, finishedAt: true } },
    },
  });

  const { days } = await retentionDaysFor(actor.orgId);

  // The cheap half of the sweep's context. The expensive half — is anyone still
  // triaging this run — is skipped; see `upperBound` below.
  const baselineKeys = new Set(
    (
      await prisma.visualBaseline.findMany({
        where: { imageKey: { in: rows.map((r) => r.key) } },
        select: { imageKey: true },
      })
    ).map((b) => b.imageKey),
  );

  const kept: Partial<Record<KeepReason, number>> = {};
  const deletable: typeof rows = [];
  let deletableBytes = 0;
  let unmeasured = 0;

  for (const r of rows) {
    const verdict = decideArtifact(
      {
        id: r.id,
        orgId: r.orgId,
        runId: r.runId,
        key: r.key,
        sizeBytes: r.sizeBytes,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        runStatus: r.run.status,
        runFinishedAt: r.run.finishedAt,
        orgRetentionDays: days,
        // Not evaluated here. Setting it false can only make this report larger
        // than the sweep's, never smaller.
        triageActive: false,
        usedAsVisualBaseline: baselineKeys.has(r.key),
      },
      { now, graceMs, terminalStatuses: TERMINAL_RUN_STATUSES },
    );

    if (verdict.delete) {
      deletable.push(r);
      deletableBytes += r.sizeBytes;
      if (r.sizeBytes === 0) unmeasured += 1;
    } else {
      kept[verdict.reason] = (kept[verdict.reason] ?? 0) + 1;
    }
  }

  const last = rows[rows.length - 1];
  res.json({
    examined: rows.length,
    deletable: deletable.length,
    kept,
    bytes: { recorded: deletableBytes, recordedHuman: humanBytes(deletableBytes) },
    measurement: {
      complete: unmeasured === 0,
      unmeasuredArtifacts: unmeasured,
      note:
        unmeasured === 0
          ? 'Every artifact listed has a recorded size.'
          : `${unmeasured} of the ${deletable.length} deletable artifacts have no recorded size; the worker measures each object as it sweeps and its report carries the real figure.`,
    },
    /*
     * Stated, not implied. This number is what the sweep would delete MINUS
     * whatever it keeps for active triage, so it is a ceiling. A preview that
     * under-reported would be the dangerous shape: an operator enabling
     * deletion having been shown a smaller number than they are about to lose.
     */
    upperBound: true,
    upperBoundNote:
      'Excludes the active-triage check, which the sweep also applies. The sweep may keep more than this; it will never delete more.',
    runs: [...new Set(deletable.map((r) => r.runId))].length,
    sample: deletable.slice(0, SAMPLE_LIMIT).map((r) => ({
      key: r.key,
      runId: r.runId,
      sizeBytes: r.sizeBytes,
      expiredAt: r.expiresAt,
    })),
    cursor: rows.length === limit && last ? last.id : null,
    more: rows.length === limit,
  });
});

// ─── POST /retention/sweep ───────────────────────────────────────────────────

const sweepSchema = z.object({
  /** Absent or false means a dry run. There is no way to make true the default. */
  apply: z.boolean().default(false),
  /**
   * Must equal the caller's own org id when `apply` is true.
   *
   * Not a ceremony. `{"apply":true}` is four characters away from a curl that
   * was meant to be a preview, and the thing on the other side is irreversible.
   * Requiring the operator to name the org they are about to delete from means
   * an accidental request fails with a message instead of succeeding.
   */
  confirm: z.string().min(1).optional(),
  batchSize: z.number().int().min(1).max(5_000).optional(),
  maxBatches: z.number().int().min(1).max(500).optional(),
  /** Also produce the objects-with-no-row report. Read-only; nothing is deleted. */
  scanStray: z.boolean().default(false),
});

/**
 * Ask the worker for a sweep of THIS org.
 *
 * OWNER-only, and org-scoped with no way to widen it: `orgId` on the job is the
 * caller's own, taken from the session and never from the body. There is no
 * fleet-wide sweep reachable from the API at all — that one exists only as the
 * worker's scheduled tick, where no request can reach it.
 *
 * Even with `apply: true` this endpoint cannot guarantee a deletion. The worker
 * refuses to delete unless its own QAAI_RETENTION_APPLY is set, which is where
 * that decision belongs: in the deployment doing the deleting, made once by an
 * operator who has read a dry run, not in whatever HTTP call arrives next.
 */
retentionRouter.post('/sweep', requireRole('OWNER'), async (req, res) => {
  const actor = actorOf(req);
  const input = sweepSchema.parse(req.body ?? {});

  if (input.apply && input.confirm !== actor.orgId) {
    throw badRequest(
      'Deleting artifacts is irreversible. Send "confirm" set to your organization id to proceed, or omit "apply" for a dry run.',
      { expected: 'confirm === your organization id', apply: input.apply },
    );
  }

  const job = {
    at: new Date().toISOString(),
    apply: input.apply,
    // From the session, never the body. A sweep cannot be aimed at another org.
    orgId: actor.orgId,
    batchSize: input.batchSize,
    maxBatches: input.maxBatches,
    scanStray: input.scanStray,
    requestedBy: actor.userId || null,
  };

  /*
   * Audited before it is enqueued, and audited whether or not it deletes
   * anything. This row records that a human ASKED; the worker writes its own
   * `retention.sweep` row recording what was actually removed. Both are needed —
   * a request that never produced a deletion row is exactly the trail you want
   * when someone asks why a sweep did nothing.
   */
  await audit({
    actor: { ...actor, userAgent: req.headers['user-agent'] ?? null },
    action: 'retention.sweep.requested',
    targetType: 'Artifact',
    targetId: null,
    metadata: {
      apply: input.apply,
      batchSize: input.batchSize ?? null,
      maxBatches: input.maxBatches ?? null,
      scanStray: input.scanStray,
    },
  });

  const enqueued = await queue().add(RETENTION_QUEUE, job, { attempts: 1 });
  logger.info(
    { jobId: enqueued.id, apply: input.apply, orgId: actor.orgId },
    'retention sweep requested',
  );

  res.status(202).json({
    jobId: String(enqueued.id),
    apply: input.apply,
    orgId: actor.orgId,
    message: input.apply
      ? 'Sweep queued. It will delete only if this deployment has QAAI_RETENTION_APPLY=true; otherwise it runs as a dry run and reports what it would have deleted.'
      : 'Dry run queued. Nothing will be deleted; the worker logs what it would have removed.',
  });
});

// ─── Queue producer ──────────────────────────────────────────────────────────

/**
 * lib/queues.ts cannot express this: `enqueue()` is typed on `keyof JobPayloads`
 * and `queueDepths()` iterates `QUEUE_NAMES`, both in @qaai/shared and not this
 * wave's to edit. So one Queue, lazily constructed, exactly as routes/bisect.ts
 * does for the same reason.
 *
 * DELETE ALL OF THIS once `qaai.retention` is in QUEUE_NAMES and `RetentionJob`
 * is in JobPayloads — this becomes `enqueue('qaai.retention', job)`, the depth
 * appears on /health/ready, and the existing shutdown path closes it.
 */
let retentionQueue: Queue | null = null;

function queue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(RETENTION_QUEUE, {
      // BullMQ's requirement; without it a job can be dropped rather than
      // retried when Redis blinks.
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      defaultJobOptions: { removeOnComplete: { age: 24 * 3600, count: 500 } },
    });
  }
  return retentionQueue;
}

// The connection above is not known to closeQueues(), and an open ioredis socket
// keeps the event loop alive. Without this the API sits through its 10s shutdown
// backstop on every deploy.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void retentionQueue?.close().catch(() => {});
  });
}
