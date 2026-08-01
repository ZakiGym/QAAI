/**
 * Build bisect (§5) — "which commit turned this test red?"
 *
 * Two endpoints and no cleverness. POST starts an investigation and hands back
 * its id; GET reports progress, and then the report. The judgement is all in
 * lib/bisect.ts and the work is all in the worker; this file's job is to make
 * both of them addressable.
 *
 * ── Where the state lives ───────────────────────────────────────────────────
 * Nowhere new — this adds no table. An investigation IS three things that
 * already exist:
 *
 *   • an AuditLog row per phase (`bisect.requested`, `bisect.planned`,
 *     `bisect.concluded`), keyed `targetType = 'Bisect'`, `targetId = <id>`
 *   • the probe Runs it created, tagged `bisect:<testId>:<id>` on `triggeredBy`
 *   • a BullMQ job that advances it one step at a time
 *
 * GET therefore reads the database, never Redis. That is deliberate: BullMQ
 * prunes completed jobs after 24 hours, and an answer that expires is not an
 * answer — someone comes back on Monday to the commit that broke their build.
 * It also means the evidence is inspectable in the cockpit like any other run,
 * which is what lets a person disagree with the conclusion.
 *
 * ── A note on what this endpoint does NOT do ────────────────────────────────
 * It does not decide anything. Not even the cheap history-only answer is
 * computed here, though it easily could be — because then there would be two
 * places that can name a commit, and only one of them would be the one the
 * tests cover. POST enqueues; the worker answers, usually in milliseconds.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { notFound } from '../lib/errors.js';
import {
  BISECT_AUDIT_ACTIONS,
  BISECT_AUDIT_TARGET,
  BISECT_QUEUE,
  BISECT_RUN_PREFIX,
  DEFAULT_DEADLINE_MINUTES,
  type BisectJob,
  type BisectReport,
} from '../lib/bisect.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const bisectRouter: Router = Router();

bisectRouter.use(requireAuth);
// Starting one spends CI time; reading one is reading your own org's runs. Both
// sit above VIEWER for the same reason POST /runs does.
bisectRouter.use(requireRole('MEMBER'));

/**
 * The bisect queue's producer.
 *
 * lib/queues.ts cannot express this: `enqueue()` is typed on `keyof JobPayloads`
 * and `queueDepths()` iterates `QUEUE_NAMES`, both of which live in @qaai/shared
 * and are not this change's to edit. So one Queue, lazily constructed, with its
 * own connection.
 *
 * DELETE ALL OF THIS the moment `qaai.bisect` is added to QUEUE_NAMES and
 * `BisectJob` to JobPayloads — then this becomes `enqueue('qaai.bisect', job)`,
 * the depth shows up on /health/ready, and the connection is closed by the
 * shutdown path that already exists rather than by the hook below.
 */
let bisectQueue: Queue | null = null;

function queue(): Queue {
  if (!bisectQueue) {
    bisectQueue = new Queue(BISECT_QUEUE, {
      // maxRetriesPerRequest: null is BullMQ's requirement; without it a job can
      // be dropped rather than retried when Redis blinks.
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      defaultJobOptions: { removeOnComplete: { age: 24 * 3600, count: 500 } },
    });
  }
  return bisectQueue;
}

// The connection above is not known to closeQueues(), and an open ioredis socket
// keeps the event loop alive. Without this the API would sit through its 10s
// shutdown backstop on every deploy.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void bisectQueue?.close().catch(() => {});
  });
}

// ─── POST /bisect ────────────────────────────────────────────────────────────

const startSchema = z.object({
  testId: z.string().min(1),
  /**
   * The window, as two runs. Both optional: without them the search looks back
   * DEFAULT_WINDOW_DAYS. `fromRunId` is the one that matters — widen with it when
   * the report says the test was red as far back as it could see.
   */
  fromRunId: z.string().min(1).nullish(),
  toRunId: z.string().min(1).nullish(),
});

bisectRouter.post('/', async (req, res) => {
  const input = startSchema.parse(req.body);
  const actor = actorOf(req);

  // Tenancy is enforced by the Prisma extension, so another org's test reads as
  // absent — which is exactly what notFound() is for.
  const test = await prisma.test.findUnique({
    where: { id: input.testId },
    select: { id: true, name: true, projectId: true, disabledAt: true },
  });
  if (!test) throw notFound('Test');

  /*
   * One investigation per test at a time.
   *
   * Not a nicety: every probe is a real run holding a real browser, so a button
   * pressed five times would be five searches bidding for the same queue while a
   * build is red — the worst possible moment to be spending it. The second
   * caller gets the first caller's id, which is also the answer they wanted.
   */
  const existing = await findOpenBisect(test.id);
  if (existing) {
    res.status(202).json({
      id: existing,
      testId: test.id,
      status: 'RUNNING',
      reused: true,
      message: 'A bisect for this test is already running; this is that one.',
    });
    return;
  }

  const bisectId = randomUUID();
  const job: BisectJob = {
    orgId: actor.orgId,
    projectId: test.projectId,
    testId: test.id,
    bisectId,
    fromRunId: input.fromRunId ?? null,
    toRunId: input.toRunId ?? null,
    requestedBy: actor.userId || null,
    requestedAt: new Date().toISOString(),
    step: 0,
  };

  /*
   * The audit row is written BEFORE the enqueue, and the order is load-bearing:
   * it is the only record GET can find, so a row without a job reads as an
   * investigation that never advanced, while a job without a row would be work
   * running against an id nobody can look up.
   */
  await audit({
    actor: { ...actor, userAgent: req.headers['user-agent'] ?? null },
    action: BISECT_AUDIT_ACTIONS.requested,
    targetType: BISECT_AUDIT_TARGET,
    targetId: bisectId,
    metadata: {
      bisectId,
      testId: test.id,
      testName: test.name,
      projectId: test.projectId,
      fromRunId: job.fromRunId,
      toRunId: job.toRunId,
      requestedAt: job.requestedAt,
    },
  });

  await queue().add(BISECT_QUEUE, job, { jobId: `bisect-${bisectId}-0`, attempts: 1 });
  logger.info({ bisectId, testId: test.id }, 'bisect requested');

  res.status(202).json({
    id: bisectId,
    testId: test.id,
    status: 'QUEUED',
    reused: false,
    /*
     * Said up front because it changes what someone does next: most bisects are
     * a database query and are finished before the first poll, and the ones that
     * are not are waiting on real test runs and will take minutes, not seconds.
     */
    message:
      'Poll GET /bisect/' +
      bisectId +
      '. If the history already contains the answer it will be there immediately; ' +
      'otherwise it is re-running the test and will take as long as those runs take.',
  });
});

/**
 * An investigation that was requested, has not concluded, and has not aged out.
 *
 * Filtered in JS over a bounded window rather than through a JSON path filter:
 * `metadata` is a schemaless column, the row count inside the deadline is small,
 * and a query that depends on the shape of a JSON blob is a query that breaks
 * silently when the blob changes.
 */
async function findOpenBisect(testId: string): Promise<string | null> {
  const since = new Date(Date.now() - DEFAULT_DEADLINE_MINUTES * 60_000);
  const rows = await prisma.auditLog.findMany({
    where: {
      targetType: BISECT_AUDIT_TARGET,
      action: { in: [BISECT_AUDIT_ACTIONS.requested, BISECT_AUDIT_ACTIONS.concluded] },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { action: true, targetId: true, metadata: true },
  });

  const concluded = new Set(
    rows.filter((r) => r.action === BISECT_AUDIT_ACTIONS.concluded).map((r) => r.targetId),
  );

  for (const row of rows) {
    if (row.action !== BISECT_AUDIT_ACTIONS.requested) continue;
    if (!row.targetId || concluded.has(row.targetId)) continue;
    if (readString(row.metadata, 'testId') !== testId) continue;
    return row.targetId;
  }
  return null;
}

// ─── GET /bisect/:id ─────────────────────────────────────────────────────────

bisectRouter.get('/:id', async (req, res) => {
  const id = String(req.params.id);

  const rows = await prisma.auditLog.findMany({
    where: { targetType: BISECT_AUDIT_TARGET, targetId: id },
    orderBy: { createdAt: 'asc' },
    take: 10,
    select: { action: true, metadata: true, createdAt: true },
  });
  if (rows.length === 0) throw notFound('Bisect');

  const requested = rows.find((r) => r.action === BISECT_AUDIT_ACTIONS.requested);
  const planned = rows.find((r) => r.action === BISECT_AUDIT_ACTIONS.planned);
  const concluded = rows.find((r) => r.action === BISECT_AUDIT_ACTIONS.concluded);

  const testId = readString(requested?.metadata, 'testId');

  /*
   * The probe runs, straight from the runs table. This is the progress bar and
   * it is also the evidence: every id here opens in the cockpit, with the
   * screenshots and the trace of a probe that failed. A bisect whose reasoning
   * cannot be checked is a bisect nobody should act on.
   */
  const probeRuns = await prisma.run.findMany({
    where: { triggeredBy: { startsWith: BISECT_RUN_PREFIX, endsWith: `:${id}` } },
    orderBy: { queuedAt: 'asc' },
    take: 100,
    select: {
      id: true,
      status: true,
      commitSha: true,
      queuedAt: true,
      finishedAt: true,
      results: { select: { status: true, retriedAndPassed: true }, take: 1 },
    },
  });

  const report = readReport(concluded?.metadata);
  const budget = readNumber(planned?.metadata, ['plan', 'budget']);
  const repeats = readNumber(planned?.metadata, ['plan', 'repeats']);
  const probedCommits = new Set(probeRuns.map((r) => r.commitSha).filter(Boolean)).size;

  res.json({
    id,
    testId,
    state: concluded ? 'DONE' : probeRuns.length > 0 ? 'PROBING' : 'QUEUED',
    requestedAt: requested?.createdAt ?? null,
    finishedAt: concluded?.createdAt ?? null,

    progress: {
      phase: concluded ? 'concluded' : planned ? 'probing' : 'reading history',
      /**
       * Null before the plan exists, which is most of a bisect's life and every
       * bisect that history answered on its own. A zero here would read as "0 of
       * 0 probes done" and imply the search had started.
       */
      probeBudget: budget,
      probeRepeats: repeats,
      probesDone: probedCommits,
      runsQueued: probeRuns.length,
      runsFinished: probeRuns.filter((r) => r.finishedAt !== null).length,
    },

    /** Present only once concluded. Until then there is no answer, not a partial one. */
    result: report,

    probeRuns: probeRuns.map((run) => ({
      runId: run.id,
      commitSha: run.commitSha,
      status: run.status,
      result: run.results[0]?.status ?? null,
      retriedAndPassed: run.results[0]?.retriedAndPassed ?? false,
      queuedAt: run.queuedAt,
      finishedAt: run.finishedAt,
    })),
  });
});

// ─── Reading a schemaless column ─────────────────────────────────────────────
//
// `AuditLog.metadata` is Json and is written by the worker, so it is trusted but
// not typed. Everything below degrades to null rather than throwing: a malformed
// row must cost this endpoint one field, not the whole response.

function readString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(metadata: unknown, path: readonly string[]): number | null {
  let cursor: unknown = metadata;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'number' ? cursor : null;
}

function readReport(metadata: unknown): BisectReport | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const report = (metadata as { report?: unknown }).report;
  if (!report || typeof report !== 'object') return null;
  // One structural check. If `status` is missing the blob is not a report, and
  // handing the client half of one is worse than handing it nothing.
  return typeof (report as { status?: unknown }).status === 'string'
    ? (report as BisectReport)
    : null;
}

/*
 * ── Handover ────────────────────────────────────────────────────────────────
 * Two mounts this change does not own, because both files are shared:
 *
 *   apps/api/src/index.ts
 *     import { bisectRouter } from './routes/bisect.js';
 *     app.use('/bisect', bisectRouter);      // next to app.use('/impact', …)
 *
 *   apps/worker/src/index.ts
 *     import { processBisect } from './processors/bisect.js';
 *     import { BISECT_QUEUE, type BisectJob } from '../../api/src/lib/bisect.js';
 *     // Cheap: a tick reads history and queues runs, it never holds a browser.
 *     register<BisectJob>(BISECT_QUEUE, config.concurrency, processBisect);
 *
 * Until the worker registration exists, POST /bisect accepts and GET reports
 * QUEUED forever — which is honest, and is why GET has a 'reading history'
 * phase rather than pretending an answer is coming.
 */
