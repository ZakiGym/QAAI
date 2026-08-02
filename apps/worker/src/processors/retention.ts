/**
 * Artifact retention (§5) — the sweep that finally enforces the policy.
 *
 * `PLAN_LIMITS` has declared `artifactRetentionDays` (7/30/90/365) since the
 * beginning and the worker has been stamping `Artifact.expiresAt` from it for
 * just as long. Nothing ever read that column. Every screenshot, video and trace
 * this product has ever captured is still in the bucket — a cost problem that
 * turns into a compliance problem the first time a customer exercises a deletion
 * right and we have to answer "when will it actually be gone?".
 *
 * ── This deletes customer data, so read the failure directions first ────────
 *
 * Every other sweep in this repo (schedule, flake, digest) fails by doing too
 * much work or saying too much. This one fails by destroying evidence that
 * cannot be recreated: the trace of the run that proved the bug, the video the
 * support ticket links to, the screenshot a visual baseline was approved from.
 * There is no undo. So every uncertainty resolves the same way — KEEP:
 *
 *   • no `expiresAt`            → keep. An unstamped row means whatever wrote it
 *                                 did not know the plan. The sweep does not get
 *                                 to invent one on its behalf.
 *   • run not finished          → keep. Bytes may still be arriving.
 *   • triage still open on it   → keep. Somebody is looking at this failure.
 *   • a visual baseline points at the key → keep. Approving a run screenshot as
 *                                 the baseline makes a run-scoped key outlive
 *                                 its run; deleting it silently un-baselines the
 *                                 test and the next run "passes" against nothing.
 *   • key does not parse, or its embedded org/run disagrees with the row → keep.
 *   • the org's CURRENT plan has not expired it yet → keep (see below).
 *   • the storage backend is unhappy → stop the whole sweep.
 *
 * ── Dry run is the default, everywhere ──────────────────────────────────────
 *
 * A sweep reports what it WOULD delete, with counts and bytes broken down by
 * org, and deletes nothing. Turning that into real deletion needs BOTH a job
 * that asks for it and `QAAI_RETENTION_APPLY=true` on the worker. The env gate
 * is deliberately not overridable from the job payload: enabling destruction is
 * a deployment decision an operator makes once, having read a dry run, and not
 * something an HTTP request can switch on. A job that asks to apply on a worker
 * where the gate is off is downgraded to a dry run and says so.
 *
 * ── Objects first, then rows ────────────────────────────────────────────────
 *
 * Always that order, and only for keys the backend CONFIRMED it deleted. The two
 * ways to get this wrong are not symmetric:
 *
 *   row deleted, object survives → an object nobody can find, on the bill
 *                                  forever, attributable to no customer.
 *   object deleted, row survives → a 404 in the cockpit, and the next sweep
 *                                  tidies the row up. Recoverable.
 *
 * So when anything is unclear the row stays. This is also why `deleteObjects`
 * reports per-key rather than throwing: only the confirmed keys lose their rows.
 *
 * ── Bounded and resumable ───────────────────────────────────────────────────
 *
 * Keyset pagination on `Artifact.id` (unique, so the ordering is total),
 * `batchSize` rows per batch and `maxBatches` batches per tick. Deleting 400k
 * objects in one transaction is an outage; deleting them 500 at a time across
 * ticks is a background task. The cursor is returned so a caller can resume, and
 * because the sweep never holds a transaction open across a network call to
 * object storage, a worker that dies mid-sweep loses nothing but its place.
 */

import { Queue } from 'bullmq';
import { PLAN_LIMITS, TERMINAL_RUN_STATUSES } from '@qaai/shared';
import type { Plan } from '@qaai/shared';
import { defaultLocalArtifactRoot } from '@qaai/storage';
/*
 * WHY THIS IMPORT IS A RELATIVE PATH: @qaai/storage exports only its barrel
 * (`"exports": { ".": "./src/index.ts" }`) and `gc.ts` is a second entry point.
 * Adding it to that barrel is a one-line change to a file this wave does not
 * own — see `needsOwnerDecision`. The same workaround, for the same reason, is
 * documented at the top of apps/api/src/routes/suite-health.ts. The specifier
 * resolves identically under tsc, tsx and vitest.
 */
import {
  ALL_RUN_ARTIFACTS_PREFIX,
  StorageGcError,
  classifyStrayKey,
  createStorageGc,
  decideArtifact,
  humanBytes,
} from '../../../../packages/storage/src/gc.js';
import type { KeepReason, StorageGc, StrayKind } from '../../../../packages/storage/src/gc.js';
import { config, connection, logger, prisma } from '../context.js';

/**
 * Its own queue, like flake and bisect.
 *
 * NOT in `QUEUE_NAMES` (packages/shared) only because this wave does not own
 * that file — see `needsOwnerDecision`. `apps/api/src/routes/retention.ts`
 * carries the same literal and a matching comment; the test pins the string so
 * the two cannot drift apart silently.
 */
export const RETENTION_QUEUE = 'qaai.retention';

export interface RetentionJob {
  at: string;
  /** Actually delete. Absent or false is a dry run, which is the default. */
  apply?: boolean;
  /** Confine the sweep to one org. Absent sweeps every org. */
  orgId?: string | null;
  /** Rows examined per batch. */
  batchSize?: number;
  /** Batches per tick. The product of the two bounds one tick's blast radius. */
  maxBatches?: number;
  /** Also walk object storage looking for objects with no row. Read-only. */
  scanStray?: boolean;
  /** Who asked for this, for the audit row. */
  requestedBy?: string | null;
}

// ─── Configuration ───────────────────────────────────────────────────────────

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  // NaN and negatives fall back rather than propagating into a window
  // calculation, where NaN would make every comparison false and quietly turn
  // the safety check off.
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * The deployment-level opt-in. Read once at import: flipping destruction on
 * should require a restart, so an operator can point at the process that has it
 * and know it did not change under them.
 */
export const APPLY_ENABLED = process.env.QAAI_RETENTION_APPLY === 'true';

/**
 * How far past `expiresAt` a row has to be before it is a candidate.
 *
 * Clock skew between the worker that stamped the expiry and the one sweeping is
 * measured in seconds, not hours — but the cost of the grace period is a day of
 * storage and the cost of not having it is deleting an artifact the moment it is
 * technically eligible, with no margin at all on the boundary that matters most.
 */
export const DEFAULT_GRACE_MS = envNumber('QAAI_RETENTION_GRACE_HOURS', 24) * 3_600_000;

/**
 * How long a triage decision counts as "someone is still working on this".
 *
 * A window rather than "any PENDING verdict", and that distinction decides
 * whether this feature works at all. Verdicts are created PENDING and most are
 * never reviewed, so "keep anything with a PENDING verdict" would exempt every
 * failing run forever — retention that deletes only the artifacts of runs that
 * passed is not retention. The window says: recently failed and not yet looked
 * at is active; a year-old PENDING verdict nobody opened is not.
 */
export const DEFAULT_ACTIVE_TRIAGE_MS = envNumber('QAAI_RETENTION_TRIAGE_WINDOW_DAYS', 30) * 86_400_000;

export const DEFAULT_BATCH_SIZE = envNumber('QAAI_RETENTION_BATCH_SIZE', 500);
export const DEFAULT_MAX_BATCHES = envNumber('QAAI_RETENTION_MAX_BATCHES', 20);

/**
 * Ceiling on the per-batch verdict lookup. Hitting it means the batch touched
 * more triage rows than we are willing to read, and the response is to treat
 * EVERY run in the batch as active rather than to answer from a truncated set —
 * a partial answer to "is anyone looking at this?" is a wrong answer in the
 * direction that deletes things.
 */
const MAX_VERDICTS_PER_BATCH = 5_000;

/** Keys recorded verbatim in an audit row before it starts sampling. */
const AUDIT_KEY_LIMIT = 200;

// ─── The decision, as a pure function ────────────────────────────────────────

/*
 * The policy itself lives in packages/storage/src/gc.ts, and is re-exported here
 * so this module's public surface (and its tests) read as one thing.
 *
 * It is there rather than here because apps/api/src/routes/retention.ts has to
 * apply the IDENTICAL predicate to show an operator what this sweep would
 * delete. A preview computed by a second implementation is a number somebody
 * believes and then enables destruction on the strength of; there is exactly one
 * definition, and both callers import it.
 */
export { decideArtifact } from '../../../../packages/storage/src/gc.js';
export type {
  ArtifactCandidate,
  KeepReason,
  PolicyContext,
  SweepVerdict,
} from '../../../../packages/storage/src/gc.js';

/** Retention days for a plan, defaulting to the most generous thing we can justify. */
export function retentionDaysForPlan(plan: string | null | undefined): number {
  const limits = PLAN_LIMITS[plan as Plan];
  // An unrecognised plan string is a schema drift, not a licence to delete
  // sooner. FREE's 7 days would be the aggressive read; ENTERPRISE's 365 is the
  // one that cannot destroy anything.
  return limits?.artifactRetentionDays ?? PLAN_LIMITS.ENTERPRISE.artifactRetentionDays;
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface OrgTotals {
  orgId: string;
  artifacts: number;
  bytes: number;
  runs: number;
}

export interface SweepReport {
  /** What actually happened. False means nothing was deleted. */
  applied: boolean;
  /** What the job asked for. Differs from `applied` when the env gate is off. */
  requestedApply: boolean;
  examined: number;
  /** Rows that passed every check. In a dry run this is the blast radius. */
  deletable: number;
  deletableBytes: number;
  /** Why the rest were kept. The sum of the values is `examined - deletable`. */
  kept: Partial<Record<KeepReason, number>>;
  /** Deletable rows whose object was already gone. Row-only cleanup. */
  orphanRows: number;
  /** Keys the backend could not answer for. Neither object nor row was touched. */
  skipped: Array<{ key: string; reason: string }>;
  objectsDeleted: number;
  bytesDeleted: number;
  rowsDeleted: number;
  byOrg: OrgTotals[];
  batches: number;
  /** Resume here. Null means the sweep reached the end of the candidates. */
  cursor: string | null;
  more: boolean;
  /** Set when the sweep stopped early. Null when it finished its bounds. */
  stoppedBecause: string | null;
  stray: StrayReport | null;
  durationMs: number;
  /** One line an operator can paste into a ticket. */
  summary: string;
}

export interface StrayReport {
  scanned: number;
  byKind: Record<StrayKind, { objects: number; bytes: number }>;
  /** Bounded sample. Nothing here is ever deleted by this code. */
  sample: Array<{ key: string; kind: StrayKind; sizeBytes: number }>;
  cursor: string | null;
  truncated: boolean;
}

// ─── Storage handle ──────────────────────────────────────────────────────────

let gcHandle: StorageGc | null = null;

/**
 * Built from the same env `context.ts` builds `storage` from — line for line,
 * including `defaultLocalArtifactRoot()`.
 *
 * Duplicated rather than imported because `context.ts` exports the built handle
 * and not the config behind it, and this wave does not own that file. The two
 * MUST describe the same bucket and the same local root: a sweeper pointed
 * anywhere else sees every object as absent and deletes the rows for a bucket
 * full of surviving data. Any change to the storage block in `context.ts` has to
 * be mirrored here. See `needsOwnerDecision` — one exported `storageConfig`
 * there removes this hazard entirely.
 */
function defaultGc(): StorageGc {
  gcHandle ??= createStorageGc({
    backend: config.artifactsLocal ? 'local' : 's3',
    bucket: process.env.S3_BUCKET ?? 'qaai-artifacts',
    rootDir: defaultLocalArtifactRoot(),
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  });
  return gcHandle;
}

export interface SweepOptions {
  apply?: boolean;
  orgId?: string | null;
  batchSize?: number;
  maxBatches?: number;
  scanStray?: boolean;
  cursor?: string | null;
  now?: Date;
  graceMs?: number;
  activeTriageMs?: number;
  requestedBy?: string | null;
  /** Injected in tests; production uses the env-built handle. */
  gc?: StorageGc;
}

// ─── The sweep ───────────────────────────────────────────────────────────────

interface RawCandidate {
  id: string;
  orgId: string;
  runId: string;
  key: string;
  sizeBytes: number;
  createdAt: Date;
  expiresAt: Date | null;
  run: { status: string; finishedAt: Date | null };
}

export async function sweepExpiredArtifacts(opts: SweepOptions = {}): Promise<SweepReport> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const activeTriageMs = opts.activeTriageMs ?? DEFAULT_ACTIVE_TRIAGE_MS;
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, 5_000));
  const maxBatches = Math.max(1, Math.min(opts.maxBatches ?? DEFAULT_MAX_BATCHES, 500));
  const gc = opts.gc ?? defaultGc();

  const requestedApply = opts.apply === true;
  // BOTH gates. The job asking is not enough; the deployment has to have said
  // yes too, by restarting with QAAI_RETENTION_APPLY=true.
  const applied = requestedApply && APPLY_ENABLED;

  const report: SweepReport = {
    applied,
    requestedApply,
    examined: 0,
    deletable: 0,
    deletableBytes: 0,
    kept: {},
    orphanRows: 0,
    skipped: [],
    objectsDeleted: 0,
    bytesDeleted: 0,
    rowsDeleted: 0,
    byOrg: [],
    batches: 0,
    cursor: opts.cursor ?? null,
    more: false,
    stoppedBecause: null,
    stray: null,
    durationMs: 0,
    summary: '',
  };

  if (requestedApply && !APPLY_ENABLED) {
    logger.warn(
      { orgId: opts.orgId ?? null, requestedBy: opts.requestedBy ?? null },
      'retention: a sweep asked to delete but QAAI_RETENTION_APPLY is not "true" on this worker — running as a dry run',
    );
  }

  const orgTotals = new Map<string, { artifacts: number; bytes: number; runs: Set<string> }>();
  const cutoff = new Date(now.getTime() - graceMs);

  for (let batch = 0; batch < maxBatches; batch += 1) {
    /*
     * Keyset on `id`, not on `expiresAt`.
     *
     * `id` is unique, so the ordering is total and a cursor cannot straddle ties
     * — which `expiresAt` can, since a run's artifacts are all stamped in one
     * transaction and share it to the millisecond. Paging by a non-unique column
     * silently skips rows, and rows skipped by a retention sweep are rows that
     * are never deleted and never reported. Processing order does not otherwise
     * matter: everything matched here is already past its expiry.
     */
    const rows = (await prisma.artifact.findMany({
      where: {
        expiresAt: { not: null, lt: cutoff },
        ...(opts.orgId ? { orgId: opts.orgId } : {}),
        ...(report.cursor ? { id: { gt: report.cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
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
    })) as RawCandidate[];

    if (rows.length === 0) {
      report.cursor = null;
      break;
    }

    report.batches += 1;
    report.examined += rows.length;
    const lastRow = rows[rows.length - 1];
    report.cursor = lastRow ? lastRow.id : report.cursor;

    const context = await gatherBatchContext(rows, { now, activeTriageMs });

    const deletable: RawCandidate[] = [];
    for (const row of rows) {
      const verdict = decideArtifact(
        {
          id: row.id,
          orgId: row.orgId,
          runId: row.runId,
          key: row.key,
          sizeBytes: row.sizeBytes,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          runStatus: row.run.status,
          runFinishedAt: row.run.finishedAt,
          // The fallback is the longest window that exists, not the shortest:
          // an org whose plan could not be resolved at all must not be swept on
          // FREE's seven days.
          orgRetentionDays:
            context.retentionDays.get(row.orgId) ?? PLAN_LIMITS.ENTERPRISE.artifactRetentionDays,
          triageActive: context.activeRuns.has(row.runId),
          usedAsVisualBaseline: context.baselineKeys.has(row.key),
        },
        { now, graceMs, terminalStatuses: TERMINAL_RUN_STATUSES },
      );

      if (verdict.delete) {
        deletable.push(row);
      } else {
        report.kept[verdict.reason] = (report.kept[verdict.reason] ?? 0) + 1;
      }
    }

    /*
     * Measure before deciding anything, and let a missing object mean "already
     * gone" rather than "delete the row and hope".
     *
     * `stat` is the load-bearing call: it returns null ONLY for a confirmed
     * absence and throws for a backend that could not answer, which is why an
     * S3 outage stops this loop instead of turning into a mass row deletion.
     */
    const present: Array<{ row: RawCandidate; bytes: number }> = [];
    const orphanRowIds: string[] = [];
    let stopped: string | null = null;

    for (const row of deletable) {
      try {
        const object = await gc.stat(row.key);
        if (object === null) {
          orphanRowIds.push(row.id);
          report.orphanRows += 1;
          // Bytes come from the row here; there is nothing left to measure.
          tally(orgTotals, row.orgId, row.runId, row.sizeBytes);
          report.deletable += 1;
          report.deletableBytes += row.sizeBytes;
          continue;
        }
        // Prefer the measured size. `Artifact.sizeBytes` defaults to 0 and the
        // cloud run path never fills it in, so a report built from rows alone
        // would tell an operator the blast radius is zero bytes.
        const bytes = object.sizeBytes || row.sizeBytes;
        present.push({ row, bytes });
        tally(orgTotals, row.orgId, row.runId, bytes);
        report.deletable += 1;
        report.deletableBytes += bytes;
      } catch (err) {
        if (err instanceof StorageGcError && err.scope === 'object') {
          // One strange key. Skip it, keep both halves, carry on.
          report.skipped.push({ key: row.key, reason: err.message });
          continue;
        }
        stopped = `storage backend failed on ${row.key}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }

    if (stopped) {
      report.stoppedBecause = stopped;
      logger.error({ stopped, batch }, 'retention: stopping the sweep, the storage backend is unhealthy');
      break;
    }

    if (applied) {
      const outcome = await deleteBatch({ gc, present, orphanRowIds, report, orgTotals });
      if (outcome.stoppedBecause) {
        report.stoppedBecause = outcome.stoppedBecause;
        break;
      }
    }

    // A short page means the candidate set is exhausted; anything else and there
    // is more behind the cursor.
    if (rows.length < batchSize) {
      report.cursor = null;
      break;
    }
    if (batch === maxBatches - 1) report.more = true;
  }

  report.byOrg = [...orgTotals.entries()]
    .map(([orgId, t]) => ({ orgId, artifacts: t.artifacts, bytes: t.bytes, runs: t.runs.size }))
    .sort((a, b) => b.bytes - a.bytes);

  if (opts.scanStray) {
    try {
      report.stray = await scanStrayObjects({
        gc,
        prefix: opts.orgId ? `org/${opts.orgId}/run/` : ALL_RUN_ARTIFACTS_PREFIX,
      });
    } catch (err) {
      // The stray scan is a report, not a sweep. Its failure must not colour the
      // result of the deletion pass that already succeeded.
      logger.warn({ err }, 'retention: the stray-object scan failed');
    }
  }

  report.durationMs = Date.now() - startedAt;
  report.summary = summarise(report);

  if (applied) await auditSweep(report, opts.requestedBy ?? null);

  logger[report.stoppedBecause ? 'error' : 'info'](
    {
      applied: report.applied,
      requestedApply: report.requestedApply,
      examined: report.examined,
      deletable: report.deletable,
      bytes: report.deletableBytes,
      objectsDeleted: report.objectsDeleted,
      rowsDeleted: report.rowsDeleted,
      orphanRows: report.orphanRows,
      skipped: report.skipped.length,
      kept: report.kept,
      stoppedBecause: report.stoppedBecause,
      more: report.more,
    },
    report.summary,
  );

  return report;
}

function tally(
  totals: Map<string, { artifacts: number; bytes: number; runs: Set<string> }>,
  orgId: string,
  runId: string,
  bytes: number,
): void {
  const entry = totals.get(orgId) ?? { artifacts: 0, bytes: 0, runs: new Set<string>() };
  entry.artifacts += 1;
  entry.bytes += bytes;
  entry.runs.add(runId);
  totals.set(orgId, entry);
}

/**
 * Objects first, then the rows for the keys the backend confirmed.
 *
 * The row deletion is `deleteMany` over an explicit id list rather than a
 * re-derived `where` clause. Re-deriving the predicate would mean a second
 * evaluation of "what is expired", and any drift between the two — a clock tick,
 * a run that finished in between — deletes rows this pass never checked.
 */
async function deleteBatch(args: {
  gc: StorageGc;
  present: Array<{ row: RawCandidate; bytes: number }>;
  orphanRowIds: string[];
  report: SweepReport;
  orgTotals: Map<string, { artifacts: number; bytes: number; runs: Set<string> }>;
}): Promise<{ stoppedBecause: string | null }> {
  const { gc, present, orphanRowIds, report } = args;

  // Rows whose object was already absent. Nothing to lose by dropping the
  // pointer, and leaving them means the same missing object is re-statted on
  // every future sweep forever.
  if (orphanRowIds.length > 0) {
    const removed = await prisma.artifact.deleteMany({ where: { id: { in: orphanRowIds } } });
    report.rowsDeleted += removed.count;
  }

  if (present.length === 0) return { stoppedBecause: null };

  const byKey = new Map(present.map((p) => [p.row.key, p]));
  const outcome = await gc.deleteObjects([...byKey.keys()]);

  const confirmed = outcome.deleted.filter((k) => byKey.has(k));
  const ids: string[] = [];
  for (const key of confirmed) {
    const hit = byKey.get(key);
    if (!hit) continue;
    ids.push(hit.row.id);
    report.bytesDeleted += hit.bytes;
  }
  report.objectsDeleted += confirmed.length;

  if (ids.length > 0) {
    const removed = await prisma.artifact.deleteMany({ where: { id: { in: ids } } });
    report.rowsDeleted += removed.count;
  }

  if (outcome.failed.length > 0) {
    /*
     * Some objects survived, or we cannot prove they did not. Their rows are
     * untouched — which is the recoverable side — and the sweep stops rather
     * than working through the rest of the backlog against a store that is
     * evidently unwell.
     */
    const sample = outcome.failed.slice(0, 5).map((f) => `${f.key} (${f.reason})`);
    logger.error(
      { failed: outcome.failed.length, sample },
      'retention: object deletion failed; the rows for those keys were kept',
    );
    return {
      stoppedBecause: `${outcome.failed.length} object(s) could not be deleted; their rows were kept. First: ${sample[0] ?? 'unknown'}`,
    };
  }

  return { stoppedBecause: null };
}

// ─── Per-batch context ───────────────────────────────────────────────────────

interface BatchContext {
  retentionDays: Map<string, number>;
  activeRuns: Set<string>;
  baselineKeys: Set<string>;
}

/**
 * Everything the decision needs that is not on the artifact row, fetched once
 * per batch rather than once per row.
 *
 * All four queries are bounded by the batch's own id lists, and each one fails
 * toward KEEP: an org whose plan cannot be read gets the longest window, a
 * verdict scan that overflows marks every run active.
 */
async function gatherBatchContext(
  rows: readonly RawCandidate[],
  ctx: { now: Date; activeTriageMs: number },
): Promise<BatchContext> {
  const orgIds = [...new Set(rows.map((r) => r.orgId))];
  const runIds = [...new Set(rows.map((r) => r.runId))];
  const keys = rows.map((r) => r.key);

  const [orgs, subscriptions, baselines] = await Promise.all([
    prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, plan: true } }),
    prisma.subscription.findMany({
      where: { orgId: { in: orgIds } },
      select: { orgId: true, plan: true },
    }),
    /*
     * A visual baseline can point at a run-scoped key: POST
     * /projects/.../baselines takes `imageKey` from the request body, so
     * approving a screenshot straight out of a run makes that run's artifact the
     * thing every future visual comparison is judged against. Deleting it would
     * not fail anything — `artifacts.get` treats a missing baseline as "capture
     * a new one" — it would silently re-baseline the test against whatever the
     * next run happened to render, which is a test that has stopped testing.
     */
    prisma.visualBaseline.findMany({
      where: { imageKey: { in: keys } },
      select: { imageKey: true },
    }),
  ]);

  const retentionDays = new Map<string, number>();
  for (const orgId of orgIds) {
    // Longest of everything we know about this org. Both records are legitimate
    // sources (a self-hosted or contract org has no Subscription at all), and
    // taking the maximum is the only combination that cannot delete early.
    const fromOrg = retentionDaysForPlan(orgs.find((o) => o.id === orgId)?.plan);
    const fromSub = subscriptions.some((s) => s.orgId === orgId)
      ? retentionDaysForPlan(subscriptions.find((s) => s.orgId === orgId)?.plan)
      : 0;
    retentionDays.set(orgId, Math.max(fromOrg, fromSub));
  }

  return {
    retentionDays,
    activeRuns: await findActivelyTriagedRuns(runIds, ctx),
    baselineKeys: new Set(baselines.map((b) => b.imageKey)),
  };
}

/**
 * Which of these runs somebody is still working on.
 *
 * "Active" is deliberately narrower than "has a verdict" and wider than "is
 * PENDING". The four signals, each of which means a human is (or recently was)
 * looking at this run's evidence:
 *
 *   • a verdict carries an `issueUrl` — a bug was filed from it and the ticket
 *     links to these artifacts. No time window: tickets stay open for months.
 *   • a verdict was reviewed inside the window — the decision is fresh and the
 *     evidence is what someone would re-open to change their mind.
 *   • a verdict is still PENDING and the run finished inside the window — triage
 *     genuinely has not happened yet.
 *   • an open HealProposal hangs off one of its verdicts — somebody has to look
 *     at the failure to approve or reject the diff.
 */
export async function findActivelyTriagedRuns(
  runIds: readonly string[],
  ctx: { now: Date; activeTriageMs: number },
): Promise<Set<string>> {
  const active = new Set<string>();
  if (runIds.length === 0) return active;

  const windowStart = new Date(ctx.now.getTime() - ctx.activeTriageMs);

  const verdicts = await prisma.triageVerdict.findMany({
    where: { testResult: { runId: { in: [...runIds] } } },
    take: MAX_VERDICTS_PER_BATCH + 1,
    select: {
      id: true,
      issueUrl: true,
      reviewState: true,
      reviewedAt: true,
      testResult: { select: { runId: true, run: { select: { finishedAt: true } } } },
    },
  });

  if (verdicts.length > MAX_VERDICTS_PER_BATCH) {
    // Too many to reason about. Rather than answer from a truncated set, call
    // every run in the batch active — the sweep does less work this tick and
    // deletes nothing it could not account for.
    logger.warn(
      { runIds: runIds.length, cap: MAX_VERDICTS_PER_BATCH },
      'retention: too many verdicts to evaluate; treating every run in the batch as under active triage',
    );
    for (const id of runIds) active.add(id);
    return active;
  }

  const openHealVerdictIds = new Set<string>();
  const verdictIds = verdicts.map((v) => v.id);
  if (verdictIds.length > 0) {
    const heals = await prisma.healProposal.findMany({
      where: { state: 'PROPOSED', verdictId: { in: verdictIds } },
      select: { verdictId: true },
    });
    for (const h of heals) if (h.verdictId) openHealVerdictIds.add(h.verdictId);
  }

  for (const v of verdicts) {
    const runId = v.testResult.runId;
    const finishedAt = v.testResult.run.finishedAt;

    if (v.issueUrl) {
      active.add(runId);
      continue;
    }
    if (v.reviewedAt && v.reviewedAt >= windowStart) {
      active.add(runId);
      continue;
    }
    if (v.reviewState === 'PENDING' && finishedAt && finishedAt >= windowStart) {
      active.add(runId);
      continue;
    }
    if (openHealVerdictIds.has(v.id)) active.add(runId);
  }

  /*
   * A bulk triage that has not been undone is also active: `POST /triage/batch`
   * writes the previous state of every verdict it touched so the action can be
   * reversed, and reversing it is a decision someone makes while looking at the
   * failures. Cheap to check and bounded by the same run list.
   */
  const batches = await prisma.triageBatch.findMany({
    where: { runId: { in: [...runIds] }, undoneAt: null, createdAt: { gte: windowStart } },
    select: { runId: true },
  });
  for (const b of batches) if (b.runId) active.add(b.runId);

  return active;
}

// ─── Orphans, both directions ────────────────────────────────────────────────

const STRAY_KINDS: readonly StrayKind[] = ['persistent', 'run-artifact', 'unknown'];

/**
 * Objects with no row. REPORTED, never deleted.
 *
 * This is the direction that turns a bug into data loss, so the rule is
 * absolute: nothing in this codebase deletes an object because the database does
 * not mention it. Two reasons, either one sufficient. First, `orgs/<id>/
 * persistent/` — every visual baseline — is row-less by design, so "no row"
 * genuinely means "keep" for a whole namespace. Second, the run path uploads
 * bytes and writes the Artifact row afterwards, so every run in flight has
 * objects that are momentarily row-less; a scan racing one would delete the
 * screenshots of a run that is still executing.
 *
 * What it is for is answering "what is in the bucket that we are not accounting
 * for, and what is it costing?" — a number for a human to act on.
 */
export async function scanStrayObjects(args: {
  gc?: StorageGc;
  prefix?: string;
  cursor?: string | null;
  maxObjects?: number;
  pageSize?: number;
}): Promise<StrayReport> {
  const gc = args.gc ?? defaultGc();
  const prefix = args.prefix ?? '';
  const maxObjects = Math.max(1, Math.min(args.maxObjects ?? 20_000, 200_000));
  const pageSize = Math.max(1, Math.min(args.pageSize ?? 1_000, 1_000));

  const byKind = Object.fromEntries(
    STRAY_KINDS.map((k) => [k, { objects: 0, bytes: 0 }]),
  ) as Record<StrayKind, { objects: number; bytes: number }>;

  const report: StrayReport = {
    scanned: 0,
    byKind,
    sample: [],
    cursor: args.cursor ?? null,
    truncated: false,
  };

  let cursor = args.cursor ?? null;
  do {
    const page = await gc.list(prefix, { cursor, limit: pageSize });
    cursor = page.cursor;
    report.cursor = cursor;
    if (page.objects.length === 0) break;
    report.scanned += page.objects.length;

    const keys = page.objects.map((o) => o.key);
    const [known, baselines] = await Promise.all([
      prisma.artifact.findMany({ where: { key: { in: keys } }, select: { key: true } }),
      // A baseline is "accounted for" too, even though it has no Artifact row.
      prisma.visualBaseline.findMany({
        where: { imageKey: { in: keys } },
        select: { imageKey: true },
      }),
    ]);
    const accounted = new Set<string>([
      ...known.map((k) => k.key),
      ...baselines.map((b) => b.imageKey),
    ]);

    for (const object of page.objects) {
      if (accounted.has(object.key)) continue;
      const kind = classifyStrayKey(object.key);
      const bucket = byKind[kind];
      bucket.objects += 1;
      bucket.bytes += object.sizeBytes;
      if (report.sample.length < AUDIT_KEY_LIMIT) {
        report.sample.push({ key: object.key, kind, sizeBytes: object.sizeBytes });
      }
    }

    if (report.scanned >= maxObjects) {
      report.truncated = true;
      break;
    }
  } while (cursor);

  return report;
}

export interface MissingObjectReport {
  examined: number;
  /** Rows whose object the backend confirmed is not there. */
  missing: Array<{ id: string; orgId: string; runId: string; key: string }>;
  /** Rows whose size was 0 and has now been measured (only when backfilling). */
  backfilled: number;
  skipped: Array<{ key: string; reason: string }>;
  cursor: string | null;
  stoppedBecause: string | null;
}

/**
 * The other direction: rows pointing at objects that are not there.
 *
 * Read-only by default. `backfill` is the one write it can make, and it is
 * additive: `Artifact.sizeBytes` defaults to 0 and the cloud run path never sets
 * it (only the on-prem upload endpoint does), so per-org usage computed from
 * rows understates by roughly everything. Measuring the object and writing the
 * real number back is how that becomes answerable — it deletes nothing and, at
 * worst, records a size.
 *
 * It does NOT delete the rows it finds missing. A row with no object is
 * harmless — the artifact endpoint 404s cleanly on it — and deleting live rows
 * on the strength of a `stat` is exactly the shape of the outage this file is
 * written to avoid. Expired rows in that state are cleaned up by the sweep,
 * which has already established they were due for deletion anyway.
 */
export async function scanMissingObjects(args: {
  gc?: StorageGc;
  orgId?: string | null;
  limit?: number;
  cursor?: string | null;
  backfill?: boolean;
}): Promise<MissingObjectReport> {
  const gc = args.gc ?? defaultGc();
  const limit = Math.max(1, Math.min(args.limit ?? 1_000, 10_000));

  const report: MissingObjectReport = {
    examined: 0,
    missing: [],
    backfilled: 0,
    skipped: [],
    cursor: args.cursor ?? null,
    stoppedBecause: null,
  };

  const rows = await prisma.artifact.findMany({
    where: {
      ...(args.orgId ? { orgId: args.orgId } : {}),
      ...(report.cursor ? { id: { gt: report.cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true, orgId: true, runId: true, key: true, sizeBytes: true },
  });

  for (const row of rows) {
    report.examined += 1;
    report.cursor = row.id;
    try {
      const object = await gc.stat(row.key);
      if (object === null) {
        report.missing.push({ id: row.id, orgId: row.orgId, runId: row.runId, key: row.key });
        continue;
      }
      if (args.backfill && row.sizeBytes === 0 && object.sizeBytes > 0) {
        await prisma.artifact.update({
          where: { id: row.id },
          data: { sizeBytes: object.sizeBytes },
        });
        report.backfilled += 1;
      }
    } catch (err) {
      if (err instanceof StorageGcError && err.scope === 'object') {
        report.skipped.push({ key: row.key, reason: err.message });
        continue;
      }
      report.stoppedBecause = `storage backend failed on ${row.key}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
  }

  if (rows.length < limit && !report.stoppedBecause) report.cursor = null;
  return report;
}

// ─── Audit ───────────────────────────────────────────────────────────────────

/**
 * One AuditLog row per org per sweep, written only when something was actually
 * deleted. A dry run deletes nothing and gets a log line instead — auditing
 * every scheduled preview would bury the rows that record real deletions under
 * four a day that record none.
 *
 * `userId` is null and `action` says `retention.sweep`: the actor is the system.
 * `requestedBy` carries the human when a sweep was asked for through the API.
 */
async function auditSweep(report: SweepReport, requestedBy: string | null): Promise<void> {
  for (const org of report.byOrg) {
    try {
      await prisma.auditLog.create({
        data: {
          orgId: org.orgId,
          userId: requestedBy,
          action: 'retention.sweep',
          targetType: 'Artifact',
          targetId: null,
          metadata: {
            artifacts: org.artifacts,
            bytes: org.bytes,
            bytesHuman: humanBytes(org.bytes),
            runs: org.runs,
            objectsDeleted: report.objectsDeleted,
            rowsDeleted: report.rowsDeleted,
            orphanRowsDeleted: report.orphanRows,
            skipped: report.skipped.length,
            kept: report.kept,
            batches: report.batches,
            more: report.more,
            stoppedBecause: report.stoppedBecause,
            requestedBy,
          },
        },
      });
    } catch (err) {
      // Loud, and never fatal: an audit failure must not leave the sweep
      // half-finished. The deletion has already happened; losing the row would
      // be worse if it also aborted the rest of the batch.
      logger.error({ err, orgId: org.orgId }, 'retention: audit write failed');
    }
  }
}

function summarise(r: SweepReport): string {
  const head = r.applied
    ? `retention: deleted ${r.objectsDeleted} object(s) and ${r.rowsDeleted} row(s), ${humanBytes(r.bytesDeleted)}`
    : `retention DRY RUN: would delete ${r.deletable} artifact(s), ${humanBytes(r.deletableBytes)}`;
  const parts = [head, `examined ${r.examined} across ${r.byOrg.length} org(s)`];
  if (r.orphanRows > 0) parts.push(`${r.orphanRows} row(s) had no object`);
  if (r.skipped.length > 0) parts.push(`${r.skipped.length} key(s) skipped`);
  if (r.more) parts.push('more remain');
  if (r.stoppedBecause) parts.push(`STOPPED: ${r.stoppedBecause}`);
  return parts.join('; ');
}

// ─── Queue wiring ────────────────────────────────────────────────────────────

/**
 * The tick. Dry run unless the job asks AND the deployment allows.
 *
 * Wrapped so a failing sweep is logged with its report rather than only its
 * stack: the interesting part of a retention failure is almost always what it
 * had already decided when it stopped.
 */
export async function processRetentionTick(job: RetentionJob): Promise<void> {
  await sweepExpiredArtifacts({
    apply: job.apply === true,
    orgId: job.orgId ?? null,
    batchSize: job.batchSize,
    maxBatches: job.maxBatches,
    scanStray: job.scanStray === true,
    requestedBy: job.requestedBy ?? null,
  });
}

let retentionQueue: Queue | null = null;

/**
 * Built lazily, so importing this module for a unit test does not open a Redis
 * connection. (`queues.ts` builds its producers at import time; that file is not
 * ours to change and a retention test must not need a live Redis.)
 */
function queue(): Queue {
  retentionQueue ??= new Queue(RETENTION_QUEUE, { connection });
  return retentionQueue;
}

/**
 * Arm the daily sweep. Repeatable job, de-duplicated by key, so calling it on
 * every boot is safe and the sweep exists for as long as a worker does.
 *
 * Daily rather than hourly on purpose: retention is not urgent — an artifact
 * that lives one extra day costs a fraction of a cent — and a sweep that runs
 * rarely is a sweep whose dry-run output somebody actually reads.
 *
 * The payload says `apply: true` unconditionally, and that is not a mistake. A
 * repeatable job's payload is frozen at the moment it is first armed, so baking
 * `APPLY_ENABLED` into it would pin whatever the env said on the day this queue
 * key was created — an operator who later set QAAI_RETENTION_APPLY=true and
 * restarted would get a dry run forever and no explanation. The decision is made
 * at execution time instead, by `sweepExpiredArtifacts`, where it reads the env
 * of the process actually doing the deleting.
 */
export async function armRetentionSweep(): Promise<void> {
  await queue().add(
    'tick',
    { at: new Date().toISOString(), apply: true } satisfies RetentionJob,
    {
      repeat: { every: 24 * 60 * 60_000 },
      jobId: 'qaai-retention-tick',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

/** Queue an ad-hoc sweep (the API's opt-in endpoint). */
export async function enqueueRetentionSweep(job: RetentionJob): Promise<void> {
  await queue().add(RETENTION_QUEUE, job, { attempts: 1 });
}

export async function closeRetentionQueue(): Promise<void> {
  if (retentionQueue) await retentionQueue.close();
  retentionQueue = null;
}
