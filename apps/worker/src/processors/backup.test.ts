/**
 * Tests for the nightly backup tick.
 *
 * Written the same way round as retention's: the interesting properties are
 * the ones that stop something bad, so most of these assert what did NOT
 * happen — a failed backup pruning nothing, a stranger's directory surviving
 * the sweep, an unconfigured tick warning instead of throwing. The actual dump
 * path is `backupMain` from packages/cli, proven elsewhere against a live
 * restore (deploy/backup.md §Proof); here it is injected, because a unit test
 * that shells into pg_dump is an integration test with a flaky disguise.
 */

import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The worker's context opens Postgres, Redis and the LLM at import time, so it
// is replaced wholesale; `h.prisma` and `h.config` are mutated per test.
const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    log: string[];
    config: { backupDir: string; backupKeep: number };
    queueAdds: Array<{ queue: string; name: string; opts: Record<string, unknown> }>;
  } => ({
    prisma: {},
    log: [],
    config: { backupDir: '', backupKeep: 7 },
    queueAdds: [],
  }),
);

vi.mock('../context.js', () => ({
  config: h.config,
  connection: {},
  logger: {
    debug: () => {},
    info: (_o: unknown, msg?: string) => h.log.push(`info:${msg ?? ''}`),
    warn: (_o: unknown, msg?: string) => h.log.push(`warn:${msg ?? ''}`),
    error: (_o: unknown, msg?: string) => h.log.push(`error:${msg ?? ''}`),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
}));

// A Queue stand-in that records every add() with the queue it landed on, so the
// dedupe test can assert the one fact BullMQ's repeatable-job dedupe rests on:
// a stable jobId, identical across boots.
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public queueName: string, _opts: unknown) {}
    async add(name: string, _data: unknown, opts: Record<string, unknown>): Promise<void> {
      h.queueAdds.push({ queue: this.queueName, name, opts });
    }
    async close(): Promise<void> {}
  },
}));

const {
  BACKUP_DIR_PREFIX,
  BACKUP_QUEUE,
  STRIPE_EVENT_SEEN_RETENTION_DAYS,
  armBackupSweep,
  backupDirName,
  processBackupTick,
  pruneOldBackups,
  pruneStripeEventsSeen,
} = await import('./backup.js');

const NOW = new Date('2026-08-06T03:00:00.000Z');
const DAY = 86_400_000;
const tick = { at: NOW.toISOString() };

/** A real directory tree in the OS tmpdir — pruning is filesystem behaviour. */
async function backupRoot(dirs: string[], files: string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qaai-backup-test-'));
  for (const d of dirs) {
    await mkdir(join(root, d), { recursive: true });
    // A realistic backup dir is non-empty; rm must be recursive to take it.
    await writeFile(join(root, d, 'manifest.json'), '{}', 'utf8');
  }
  for (const f of files) await writeFile(join(root, f), 'not a backup dir', 'utf8');
  return root;
}

const listed = async (root: string): Promise<string[]> => (await readdir(root)).sort();

/** Prisma stand-in for the Stripe prune, capturing the where clause. */
function fakeStripeTable(opts: { count?: number; throws?: Error } = {}): {
  wheres: Array<Record<string, unknown>>;
} {
  const calls = { wheres: [] as Array<Record<string, unknown>> };
  h.prisma.stripeEventSeen = {
    deleteMany: async (args: { where: Record<string, unknown> }) => {
      if (opts.throws) throw opts.throws;
      calls.wheres.push(args.where);
      return { count: opts.count ?? 0 };
    },
  };
  return calls;
}

beforeEach(() => {
  h.prisma = {};
  h.log = [];
  h.queueAdds = [];
  h.config.backupDir = '';
  h.config.backupKeep = 7;
  fakeStripeTable();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the schedule registration is deduped', () => {
  it('arms the daily tick under one fixed jobId, identical on every boot', async () => {
    // BullMQ de-duplicates repeatable jobs by jobId: two add()s with the same
    // id and repeat spec collapse into one schedule. So the property a restart
    // relies on is exactly this — the id is a constant, not a timestamp or a
    // random suffix, and the repeat spec does not drift between calls.
    await armBackupSweep();
    await armBackupSweep(); // the restart

    expect(h.queueAdds).toHaveLength(2);
    for (const add of h.queueAdds) {
      expect(add.queue).toBe(BACKUP_QUEUE);
      expect(add.opts.jobId).toBe('qaai-backup-tick');
      expect(add.opts.repeat).toEqual({ every: 24 * 60 * 60_000 });
    }
    const [first, second] = h.queueAdds;
    expect(second?.opts.jobId).toBe(first?.opts.jobId);
  });

  it('pins the queue name the worker registration in index.ts drains', () => {
    // Same contract as retention's pinned literal: if this drifts, jobs land in
    // a queue nobody consumes and every nightly backup sits in Redis forever.
    expect(BACKUP_QUEUE).toBe('qaai.backup');
  });
});

describe('the retention-count prune picks the right victims', () => {
  const old1 = `${BACKUP_DIR_PREFIX}2026-08-01T03-00-00-000`;
  const old2 = `${BACKUP_DIR_PREFIX}2026-08-02T03-00-00-000`;
  const old3 = `${BACKUP_DIR_PREFIX}2026-08-03T03-00-00-000`;
  const old4 = `${BACKUP_DIR_PREFIX}2026-08-04T03-00-00-000`;

  it('deletes only the oldest beyond keep, oldest first, and never a stranger', async () => {
    const root = await backupRoot(
      [old2, old4, old1, old3, 'not-a-backup'],
      ['qaai-backup-notes.txt'], // matches the prefix but is a FILE, not ours
    );

    const result = await pruneOldBackups({ dir: root, keep: 2 });

    expect(result.deleted).toEqual([old1, old2]); // oldest first
    expect(result.kept).toEqual([old4, old3]); // newest first
    // The stranger directory and the prefix-matching file both survive: the
    // prune's contract is "directories this scheduler wrote", nothing wider.
    expect(await listed(root)).toEqual(['not-a-backup', old3, old4, 'qaai-backup-notes.txt']);
  });

  it('deletes nothing when there are keep or fewer backups', async () => {
    const root = await backupRoot([old1, old2]);
    const result = await pruneOldBackups({ dir: root, keep: 7 });
    expect(result.deleted).toEqual([]);
    expect(await listed(root)).toEqual([old1, old2]);
  });

  it('never reads keep below one as "delete everything"', async () => {
    // QAAI_BACKUP_KEEP=0 (or garbage that parses to NaN) must not be a licence
    // to remove the backup the tick just wrote. The newest always survives.
    const root = await backupRoot([old1, old2, old3]);
    for (const keep of [0, -5, Number.NaN]) {
      const result = await pruneOldBackups({ dir: root, keep });
      expect(result.kept).toEqual([old3]);
    }
    expect(await listed(root)).toEqual([old3]);
  });
});

describe('the unconfigured path warns and does not throw', () => {
  it('logs one clear warn line naming the fix, runs no backup, and resolves', async () => {
    h.config.backupDir = '';
    const createBackup = vi.fn(async () => 0);

    await expect(processBackupTick(tick, { now: NOW, createBackup })).resolves.toBeUndefined();

    expect(createBackup).not.toHaveBeenCalled();
    const warns = h.log.filter((l) => l.startsWith('warn:'));
    // ONE line per tick — the tick is daily, so one line per day — and it must
    // say what did not happen and which variable fixes it.
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/NO DATABASE BACKUP RAN/);
    expect(warns[0]).toMatch(/QAAI_BACKUP_DIR/);
    expect(h.log.filter((l) => l.startsWith('error:'))).toEqual([]);
  });

  it('still prunes the Stripe event log — the cleanup does not depend on backups', async () => {
    h.config.backupDir = '';
    const stripe = fakeStripeTable({ count: 2 });

    await processBackupTick(tick, { now: NOW, createBackup: vi.fn(async () => 0) });

    expect(stripe.wheres).toHaveLength(1);
  });
});

describe('the Stripe event-log prune', () => {
  it('prunes only rows older than the redelivery horizon', async () => {
    const stripe = fakeStripeTable({ count: 3 });

    await pruneStripeEventsSeen(NOW);

    const where = stripe.wheres[0] as { createdAt: { lt: Date } };
    expect(where.createdAt.lt.toISOString()).toBe(
      new Date(NOW.getTime() - STRIPE_EVENT_SEEN_RETENTION_DAYS * DAY).toISOString(),
    );
  });

  it('a prune failure is logged and does not cost the backup its turn', async () => {
    fakeStripeTable({ throws: new Error('database is on fire') });
    const root = await backupRoot([]);
    h.config.backupDir = root;
    const createBackup = vi.fn(async (args: string[]) => {
      await mkdir(args[args.indexOf('--out') + 1]!, { recursive: true });
      return 0;
    });

    await expect(processBackupTick(tick, { now: NOW, createBackup })).resolves.toBeUndefined();

    expect(createBackup).toHaveBeenCalledOnce();
    expect(h.log.some((l) => l.startsWith('error:') && /StripeEventSeen/.test(l))).toBe(true);
  });
});

describe('the tick itself', () => {
  it('creates into a timestamped subdirectory and prunes only afterwards', async () => {
    const old1 = `${BACKUP_DIR_PREFIX}2026-07-30T03-00-00-000`;
    const old2 = `${BACKUP_DIR_PREFIX}2026-08-05T03-00-00-000`;
    const root = await backupRoot([old1, old2]);
    h.config.backupDir = root;
    h.config.backupKeep = 2;

    const createBackup = vi.fn(async (args: string[]) => {
      // Simulate the CLI: `create` writes the --out directory.
      await mkdir(args[args.indexOf('--out') + 1]!, { recursive: true });
      return 0;
    });

    await processBackupTick(tick, { now: NOW, createBackup });

    expect(createBackup).toHaveBeenCalledWith(['create', '--out', join(root, backupDirName(NOW))]);
    // keep=2 → tonight's backup plus the newest old one survive; oldest goes.
    expect(await listed(root)).toEqual([old2, backupDirName(NOW)]);
  });

  it('a failed backup fails the job and prunes NOTHING — old copies survive', async () => {
    const old1 = `${BACKUP_DIR_PREFIX}2026-07-30T03-00-00-000`;
    const old2 = `${BACKUP_DIR_PREFIX}2026-07-31T03-00-00-000`;
    const old3 = `${BACKUP_DIR_PREFIX}2026-08-01T03-00-00-000`;
    const root = await backupRoot([old1, old2, old3]);
    h.config.backupDir = root;
    h.config.backupKeep = 1;

    await expect(
      processBackupTick(tick, {
        now: NOW,
        createBackup: async () => {
          throw new Error('pg_dump is not on PATH, so nothing was attempted');
        },
      }),
    ).rejects.toThrow(/pg_dump/);

    // The night the backup fails is exactly the night the old copies matter.
    // keep=1 would have removed two of these after a success; after a failure
    // every one of them is still on disk.
    expect(await listed(root)).toEqual([old1, old2, old3]);
  });

  it('treats a nonzero exit code from the shared function as a failure', async () => {
    const root = await backupRoot([]);
    h.config.backupDir = root;

    await expect(
      processBackupTick(tick, { now: NOW, createBackup: async () => 1 }),
    ).rejects.toThrow(/exited 1/);
  });
});
