/**
 * The nightly backup tick — the roadmap line this closes is "a backup command
 * nobody runs is not a backup".
 *
 * `qaai backup create` (packages/cli/src/backup.ts) already exists and has been
 * PROVEN against a live restore (deploy/backup.md §Proof). This file does not
 * reimplement one line of it: the tick imports `backupMain` and calls it
 * in-process, exactly as `qaai backup create --out <dir>` would, so the dump,
 * the manifest, the refuse-to-overwrite rule and the vault-key fingerprint are
 * all the same code the restore was proven against. No shell-out either — a
 * worker container has no `qaai` on PATH, and a spawn would re-introduce the
 * argv/credential hazards that file was written to avoid.
 *
 * ── The three rules ─────────────────────────────────────────────────────────
 *
 * 1. **Unconfigured must be loud.** With QAAI_BACKUP_DIR unset the tick does
 *    not silently no-op: it logs ONE line at warn, every day, saying that no
 *    backup ran and exactly which variable fixes it. A platform that quietly
 *    has no backups is the failure mode; a daily warn line is the cheapest
 *    possible alarm against it.
 *
 * 2. **Prune only after a proven success, and only our own directories.** The
 *    CLI's own rule is "this tool never deletes a backup" — right for a tool a
 *    human runs mid-incident, wrong for a scheduler, because a disk that fills
 *    at day 90 is a backup system that killed the database it protected. So
 *    the sweep keeps the newest QAAI_BACKUP_KEEP (default 7) and deletes the
 *    rest — but ONLY after tonight's backup completed, so a failing backup can
 *    never eat the last good copies, and ONLY directories matching our own
 *    `qaai-backup-<stamp>` naming, so a stranger's file in the same directory
 *    is never touched.
 *
 * 3. **The Stripe event-log prune rides the same tick and depends on nothing.**
 *    StripeEventSeen is the webhook replay guard (apps/api/src/routes/
 *    billing.ts): one row per processed event id, and no other cleanup exists.
 *    Stripe redelivers within days, so rows older than 30 days can never
 *    dedupe anything again — they are dead weight in a table that otherwise
 *    grows forever. The prune runs whether or not backups are configured, and
 *    a prune failure never costs the backup its turn (nor vice versa).
 */

import { Queue } from 'bullmq';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
/*
 * WHY THIS IMPORT IS A RELATIVE PATH: packages/cli publishes only its built
 * `dist/` as a bin (`"bin": { "qaai": "dist/index.js" }`, no `exports` map), so
 * there is no package specifier that resolves to this source file. The same
 * workaround, for the same reason, is documented at the top of ./retention.ts
 * for @qaai/storage's gc module. The specifier resolves identically under tsc,
 * tsx and vitest. Importing it is side-effect free: backup.ts only runs its
 * entry point when argv[1] is the file itself.
 */
import { backupMain } from '../../../../packages/cli/src/backup.js';
import { config, connection, logger, prisma } from '../context.js';

/**
 * Its own queue, like retention and flake. NOT in `QUEUE_NAMES`
 * (packages/shared) for the same reason retention's is not — that file has an
 * owner and this wave is not it. `npm run check:wiring` pins the producer to
 * the consumer registration in index.ts.
 */
export const BACKUP_QUEUE = 'qaai.backup';

export interface BackupTickJob {
  at: string;
}

/**
 * Stripe's own redelivery horizon is 72 hours (it retries failed webhooks for
 * up to three days, and manual resends from the dashboard are of recent
 * events). 30 days is that horizon with a 10x margin: far past any redelivery
 * the guard could still catch, small enough that the table stays the size of a
 * month of billing traffic instead of the lifetime of the install.
 */
export const STRIPE_EVENT_SEEN_RETENTION_DAYS = 30;

/**
 * The naming contract between "create a backup" and "prune old backups".
 * Everything the sweep deletes starts with this prefix; everything else in
 * QAAI_BACKUP_DIR — an operator's manual dump, a README, a lost+found — is
 * invisible to the prune by construction.
 */
export const BACKUP_DIR_PREFIX = 'qaai-backup-';

/**
 * Same stamp format as the CLI's own default `--out` (backup.ts `stamp()`):
 * ISO-8601 UTC with `:` and `.` made filesystem-safe. Fixed width, so
 * lexicographic order IS chronological order — which is what lets the prune
 * sort by name instead of trusting directory mtimes a restore or rsync would
 * have rewritten.
 */
export function backupDirName(now: Date): string {
  return `${BACKUP_DIR_PREFIX}${now.toISOString().replace(/[:.]/g, '-').replace('Z', '')}`;
}

// ─── Pruning: keep the newest N, delete the rest ─────────────────────────────

export interface PruneResult {
  /** Newest first. */
  kept: string[];
  /** What was actually removed, oldest first. */
  deleted: string[];
}

/**
 * Delete every `qaai-backup-*` DIRECTORY in `dir` beyond the newest `keep`.
 *
 * `keep` is clamped to at least 1: "keep the last N" must never be able to
 * mean "delete the backup we just wrote", no matter what a typo in
 * QAAI_BACKUP_KEEP says. Victims are removed oldest-first, so if the loop dies
 * half-way the survivors are the newest copies — the ones a recovery wants.
 *
 * Files matching the prefix are ignored (isDirectory check): a
 * `qaai-backup-notes.txt` an operator left beside the dumps is not ours.
 */
export async function pruneOldBackups(args: { dir: string; keep: number }): Promise<PruneResult> {
  const keep = Math.max(1, Math.floor(Number.isFinite(args.keep) ? args.keep : 1));

  const entries = await readdir(args.dir, { withFileTypes: true });
  const backups = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(BACKUP_DIR_PREFIX))
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first — the stamp sorts lexicographically

  const kept = backups.slice(0, keep);
  const victims = backups.slice(keep).reverse(); // delete oldest first

  for (const name of victims) {
    await rm(join(args.dir, name), { recursive: true, force: true });
  }

  return { kept, deleted: victims };
}

// ─── The Stripe event-log prune ──────────────────────────────────────────────

/**
 * Drop replay-guard rows old enough that no redelivery can ever match them.
 *
 * A plain `deleteMany` on `createdAt`, unbatched on purpose: the table gains
 * one row per Stripe event and this runs daily, so a steady state deletes one
 * day's worth of billing events — dozens, not millions. The day that stops
 * being true is the day billing volume is a nicer problem to have.
 */
export async function pruneStripeEventsSeen(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STRIPE_EVENT_SEEN_RETENTION_DAYS * 86_400_000);
  const removed = await prisma.stripeEventSeen.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (removed.count > 0) {
    logger.info(
      { removed: removed.count, olderThanDays: STRIPE_EVENT_SEEN_RETENTION_DAYS },
      'backup tick: pruned processed Stripe webhook event ids past the redelivery horizon',
    );
  }
  return removed.count;
}

// ─── The tick ────────────────────────────────────────────────────────────────

export interface BackupTickOptions {
  now?: Date;
  /**
   * Injected in tests; production is the real `backupMain` from the CLI —
   * the one code path a restore has been proven against.
   */
  createBackup?: (args: string[]) => Promise<number>;
}

/**
 * Order of operations, and why:
 *
 *   1. Stripe prune — first and fenced, so a backup failure (the likelier of
 *      the two, it needs pg_dump on PATH) cannot starve the table cleanup, and
 *      a database hiccup during the prune cannot cost the backup its turn.
 *   2. The backup itself. A thrown error propagates: the BullMQ job goes
 *      FAILED, which is exactly what the ops surfacing should see. A backup
 *      that failed and reported success would be this repo's cardinal sin.
 *   3. Retention prune — strictly after step 2 returned success. Reaching here
 *      means a new good copy exists, so deleting the oldest is safe by
 *      construction; a night the backup fails deletes nothing.
 */
export async function processBackupTick(
  _job: BackupTickJob,
  opts: BackupTickOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const createBackup = opts.createBackup ?? backupMain;

  try {
    await pruneStripeEventsSeen(now);
  } catch (err) {
    logger.error(
      { err },
      'backup tick: pruning StripeEventSeen failed; continuing to the backup itself',
    );
  }

  const dir = config.backupDir;
  if (!dir) {
    // THE loud line. One per tick — the tick is daily, so one per day — at
    // warn, not debug, because "we have no backups" is operator news, not
    // developer trivia. Everything needed to fix it is in the message.
    logger.warn(
      { fix: 'set QAAI_BACKUP_DIR' },
      'backup tick: NO DATABASE BACKUP RAN — backups are not configured. Set QAAI_BACKUP_DIR to a ' +
        'writable directory on storage that does not share a disk with Postgres (see .env.example ' +
        'and deploy/backup.md), restart the worker, and a dump + manifest will be written there ' +
        'daily. Until then this install has no scheduled backups.',
    );
    return;
  }

  const outDir = join(dir, backupDirName(now));
  // `backupMain(['create', …])` either returns EXIT_OK or throws a BackupError
  // with a message already fit to print; the register() wrapper in index.ts
  // logs it and marks the job FAILED. It writes its own progress to
  // stdout/stderr — tolerated rather than captured, because capturing it would
  // mean forking the one backup path that has been proven end to end.
  const code = await createBackup(['create', '--out', outDir]);
  if (code !== 0) {
    throw new Error(
      `backup tick: \`qaai backup create\` exited ${code} — tonight's backup did not complete, and nothing was pruned`,
    );
  }
  logger.info({ outDir }, 'backup tick: nightly database backup written');

  const { kept, deleted } = await pruneOldBackups({ dir, keep: config.backupKeep });
  if (deleted.length > 0) {
    logger.info(
      { deleted, keeping: kept.length },
      'backup tick: pruned backups beyond the retention count',
    );
  }
}

// ─── Queue wiring ────────────────────────────────────────────────────────────

let backupQueue: Queue | null = null;

/**
 * Built lazily, so importing this module for a unit test does not open a Redis
 * connection — same shape and same reason as retention.ts.
 */
function queue(): Queue {
  backupQueue ??= new Queue(BACKUP_QUEUE, { connection });
  return backupQueue;
}

/**
 * Arm the daily backup. A BullMQ repeatable job is de-duplicated by its jobId,
 * so calling this on every boot is safe: a restart (or ten restarts) leaves
 * exactly one schedule, where a setInterval would leave one per surviving
 * process and a cron entry would leave none inside the container at all.
 *
 * Daily, matching the retention sweep's reasoning: a backup that runs rarely
 * enough to be readable in the log is one whose failures somebody notices, and
 * the recovery-point objective this sets (up to 24h of loss) is stated in
 * deploy/backup.md rather than implied.
 */
export async function armBackupSweep(): Promise<void> {
  await queue().add(
    'tick',
    { at: new Date().toISOString() } satisfies BackupTickJob,
    {
      repeat: { every: 24 * 60 * 60_000 },
      jobId: 'qaai-backup-tick',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

export async function closeBackupQueue(): Promise<void> {
  if (backupQueue) await backupQueue.close();
  backupQueue = null;
}
