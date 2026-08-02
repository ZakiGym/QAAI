/**
 * Safety tests for the retention sweep.
 *
 * Every other processor in this repo fails by doing the wrong work. This one
 * fails by destroying evidence there is no copy of, so the tests are written the
 * other way round from usual: almost none of them check that something WAS
 * deleted, and nearly all of them check that something was NOT.
 *
 * The scenario the whole file exists for is in "when the store cannot answer".
 * If `stat` ever reports a backend outage as "the object is not there", this
 * sweep deletes every artifact row in the database while every byte survives in
 * the bucket — an unattributable bill and a cockpit full of dead links, in one
 * pass, unrecoverable. Those tests are the reason `StorageGcError.scope` exists.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_RUN_STATUSES } from '@qaai/shared';

/*
 * The gate has to be ON for the module under test, because a dry run is a
 * boring test: it proves nothing about the deletion path. `APPLY_ENABLED` is
 * read once at import, so it is set here, before the dynamic import below — and
 * the one test that needs it OFF re-imports the module with its own env.
 */
process.env.QAAI_RETENTION_APPLY = 'true';

// The worker's context opens Postgres, Redis and the LLM at import time, so it
// is replaced wholesale; `h.prisma` is swapped per test through the proxy.
const h = vi.hoisted(
  (): { prisma: Record<string, unknown>; log: string[] } => ({ prisma: {}, log: [] }),
);

vi.mock('../context.js', () => ({
  config: { artifactsLocal: true },
  connection: {},
  logger: {
    debug: () => {},
    info: () => {},
    warn: (_o: unknown, msg?: string) => h.log.push(`warn:${msg ?? ''}`),
    error: (_o: unknown, msg?: string) => h.log.push(`error:${msg ?? ''}`),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
}));

const {
  RETENTION_QUEUE,
  decideArtifact,
  retentionDaysForPlan,
  scanMissingObjects,
  scanStrayObjects,
  sweepExpiredArtifacts,
} = await import('./retention.js');

const { StorageGcError, classifyStrayKey, parseRunArtifactKey } = await import(
  '../../../../packages/storage/src/gc.js'
);
type StorageGc = import('../../../../packages/storage/src/gc.js').StorageGc;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-08-01T12:00:00.000Z');
const DAY = 86_400_000;

type Candidate = Parameters<typeof decideArtifact>[0];

/** A candidate that every rule clears. Each test spoils exactly one thing. */
const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'art1',
  orgId: 'org1',
  runId: 'run1',
  key: 'org/org1/run/run1/screenshot.png',
  sizeBytes: 1_000,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-08T00:00:00.000Z'),
  runStatus: 'FAILED',
  runFinishedAt: new Date('2026-01-01T01:00:00.000Z'),
  orgRetentionDays: 7,
  triageActive: false,
  usedAsVisualBaseline: false,
  ...over,
});

const decide = (over: Partial<Candidate> = {}) =>
  decideArtifact(candidate(over), {
    now: NOW,
    graceMs: DAY,
    // The real list, from @qaai/shared, so a status added to the schema and not
    // to that constant fails here rather than being read as "still running".
    terminalStatuses: TERMINAL_RUN_STATUSES,
  });

/** A row as `artifact.findMany` returns it. */
interface Row {
  id: string;
  orgId: string;
  runId: string;
  key: string;
  sizeBytes: number;
  createdAt: Date;
  expiresAt: Date | null;
  run: { status: string; finishedAt: Date | null };
}

const row = (over: Partial<Row> & { id: string }): Row => ({
  orgId: 'org1',
  runId: 'run1',
  key: `org/org1/run/run1/${over.id}.png`,
  sizeBytes: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-08T00:00:00.000Z'),
  run: { status: 'FAILED', finishedAt: new Date('2026-01-01T01:00:00.000Z') },
  ...over,
});

interface DbState {
  artifacts?: Row[];
  orgs?: Array<{ id: string; plan: string }>;
  subscriptions?: Array<{ orgId: string; plan: string }>;
  baselines?: Array<{ imageKey: string }>;
  verdicts?: Array<Record<string, unknown>>;
  heals?: Array<{ verdictId: string }>;
  batches?: Array<{ runId: string }>;
}

interface Calls {
  ops: string[];
  deletedIds: string[];
  audits: Array<{ orgId: string; action: string; metadata: Record<string, unknown> }>;
  artifactWhere: Array<Record<string, unknown>>;
  updates: Array<{ id: string; sizeBytes: number }>;
}

/**
 * A prisma stand-in narrow enough to read. It honours only the filters the
 * sweep actually relies on — the id cursor, `take`, and the org filter — because
 * a fake that quietly ignores the cursor would let a paging bug pass.
 *
 * `ops` is shared with `fakeGc` on purpose: object deletions and row deletions
 * have to land in ONE sequence, or the ordering the whole design rests on
 * ("objects first, then rows") cannot be asserted at all.
 */
function fakeDb(state: DbState, ops: string[] = []): Calls {
  const artifacts = [...(state.artifacts ?? [])];
  const calls: Calls = { ops, deletedIds: [], audits: [], artifactWhere: [], updates: [] };

  h.prisma = {
    artifact: {
      findMany: async (args: {
        where?: Record<string, unknown>;
        take?: number;
        select?: unknown;
      }) => {
        const where = args.where ?? {};
        calls.artifactWhere.push(where);
        const gt = (where.id as { gt?: string } | undefined)?.gt;
        const orgId = where.orgId as string | undefined;
        const lt = (where.expiresAt as { lt?: Date } | undefined)?.lt;
        const hasExpiryFilter = where.expiresAt !== undefined;
        return artifacts
          .filter((a) => (gt ? a.id > gt : true))
          .filter((a) => (orgId ? a.orgId === orgId : true))
          .filter((a) => (hasExpiryFilter ? a.expiresAt !== null : true))
          .filter((a) => (lt && a.expiresAt ? a.expiresAt < lt : true))
          .sort((x, y) => (x.id < y.id ? -1 : 1))
          .slice(0, args.take ?? artifacts.length);
      },
      deleteMany: async (args: { where: { id: { in: string[] } } }) => {
        const ids = args.where.id.in;
        calls.ops.push(`rows:${ids.join(',')}`);
        calls.deletedIds.push(...ids);
        for (const id of ids) {
          const idx = artifacts.findIndex((a) => a.id === id);
          if (idx >= 0) artifacts.splice(idx, 1);
        }
        return { count: ids.length };
      },
      update: async (args: { where: { id: string }; data: { sizeBytes: number } }) => {
        calls.updates.push({ id: args.where.id, sizeBytes: args.data.sizeBytes });
        return {};
      },
    },
    organization: { findMany: async () => state.orgs ?? [] },
    subscription: { findMany: async () => state.subscriptions ?? [] },
    visualBaseline: { findMany: async () => state.baselines ?? [] },
    triageVerdict: { findMany: async () => state.verdicts ?? [] },
    healProposal: { findMany: async () => state.heals ?? [] },
    triageBatch: { findMany: async () => state.batches ?? [] },
    auditLog: {
      create: async (args: {
        data: { orgId: string; action: string; metadata: Record<string, unknown> };
      }) => {
        calls.audits.push(args.data);
        return {};
      },
    },
  };

  return calls;
}

/** A storage stand-in whose behaviour per key is spelled out by the test. */
function fakeGc(opts: {
  objects?: Record<string, number>;
  statThrows?: Record<string, Error>;
  deleteFails?: Record<string, string>;
  list?: Array<{ key: string; sizeBytes: number }>;
  ops: string[];
}): StorageGc {
  return {
    async list(prefix, o) {
      const all = (opts.list ?? []).filter((x) => x.key.startsWith(prefix));
      const after = o?.cursor ?? null;
      const page = all.filter((x) => (after ? x.key > after : true)).slice(0, o?.limit ?? 1000);
      const last = page[page.length - 1];
      const more = page.length > 0 && last ? all.some((x) => x.key > last.key) : false;
      return {
        objects: page.map((x) => ({ ...x, lastModified: null })),
        cursor: more && last ? last.key : null,
      };
    },
    async stat(key) {
      opts.ops.push(`stat:${key}`);
      const boom = opts.statThrows?.[key];
      if (boom) throw boom;
      const size = opts.objects?.[key];
      return size === undefined ? null : { key, sizeBytes: size, lastModified: null };
    },
    async deleteObjects(keys) {
      opts.ops.push(`objects:${[...keys].join(',')}`);
      const deleted: string[] = [];
      const failed: Array<{ key: string; reason: string }> = [];
      for (const key of keys) {
        const reason = opts.deleteFails?.[key];
        if (reason) failed.push({ key, reason });
        else deleted.push(key);
      }
      return { deleted, failed };
    },
  };
}

beforeEach(() => {
  h.prisma = {};
  h.log = [];
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the artifacts that must never be deleted', () => {
  it('keeps a row with no expiresAt stamped on it', () => {
    // An unstamped row means whatever wrote it did not know the org's plan.
    // Inventing a retention window on its behalf is how you delete a
    // hand-uploaded artifact or one written by a version that predates the
    // stamp.
    const d = decide({ expiresAt: null });
    expect(d.delete).toBe(false);
    expect(d).toMatchObject({ reason: 'no-expiry-stamped' });
  });

  it('keeps an artifact whose expiry is still in the future', () => {
    expect(decide({ expiresAt: new Date('2026-09-01T00:00:00.000Z') })).toMatchObject({
      delete: false,
      reason: 'not-yet-expired',
    });
  });

  it('keeps an artifact that expired inside the grace period', () => {
    // Expired two hours ago. Technically eligible, and deleting on that margin
    // means trusting two machines' clocks to agree to the second.
    expect(decide({ expiresAt: new Date('2026-08-01T10:00:00.000Z') })).toMatchObject({
      delete: false,
      reason: 'within-grace-period',
    });
  });

  it('deletes only once past the grace period, never at the boundary', () => {
    const exactly = new Date(NOW.getTime() - DAY);
    expect(decide({ expiresAt: exactly })).toMatchObject({ reason: 'within-grace-period' });
    expect(decide({ expiresAt: new Date(exactly.getTime() - 1) }).delete).toBe(true);
  });

  it('keeps artifacts of a run that is still executing', () => {
    // The run has been RUNNING for longer than the whole retention window,
    // which is a stuck run — something to investigate, not something to delete
    // the evidence of.
    for (const status of ['QUEUED', 'RUNNING']) {
      expect(decide({ runStatus: status })).toMatchObject({
        delete: false,
        reason: 'run-not-terminal',
      });
    }
  });

  it('keeps artifacts of a terminal run that never recorded finishedAt', () => {
    expect(decide({ runStatus: 'ERRORED', runFinishedAt: null })).toMatchObject({
      delete: false,
      reason: 'run-not-finished',
    });
  });

  it('keeps an artifact the org now pays to keep after a plan upgrade', () => {
    // Stamped 7 days on FREE, org is now BUSINESS. The stamp says delete; the
    // plan the customer is paying for today says 90 days, and that wins.
    const created = new Date(NOW.getTime() - 30 * DAY);
    const d = decide({
      createdAt: created,
      expiresAt: new Date(created.getTime() + 7 * DAY),
      orgRetentionDays: 90,
    });
    expect(d).toMatchObject({ delete: false, reason: 'plan-window-still-open' });
  });

  it('does not delete a downgraded org’s history the moment the plan changes', () => {
    // ENTERPRISE stamp of 365 days, org has dropped to FREE's 7. Nothing is
    // deleted early: `expiresAt` is still in the future and that check comes
    // first. A downgrade is a billing event, not a delete request.
    const created = new Date(NOW.getTime() - 30 * DAY);
    expect(
      decide({
        createdAt: created,
        expiresAt: new Date(created.getTime() + 365 * DAY),
        orgRetentionDays: 7,
      }),
    ).toMatchObject({ delete: false, reason: 'not-yet-expired' });
  });

  it('keeps an artifact of a run somebody is still triaging', () => {
    expect(decide({ triageActive: true })).toMatchObject({
      delete: false,
      reason: 'triage-active',
    });
  });

  it('keeps an artifact a visual baseline points at', () => {
    /*
     * The one that is easy to miss. POST /projects/:id/baselines takes imageKey
     * from the request body, so approving a screenshot straight out of a run
     * makes a run-scoped artifact the thing every future visual comparison is
     * judged against. Deleting it fails nothing loudly — the runner treats a
     * missing baseline as "capture a new one" — it silently re-baselines the
     * test against whatever the next run rendered. The test keeps passing and
     * has stopped testing.
     */
    expect(decide({ usedAsVisualBaseline: true })).toMatchObject({
      delete: false,
      reason: 'visual-baseline',
    });
  });

  it('keeps a key it cannot parse as a run artifact', () => {
    for (const key of ['orgs/org1/persistent/baseline.png', 'weird', '', 'org/org1/run/run1']) {
      expect(decide({ key })).toMatchObject({ delete: false, reason: 'key-unparseable' });
    }
  });

  it('keeps an artifact whose key and row disagree about who owns it', () => {
    // One of the two is wrong and there is no way to tell which from here.
    // Deleting on the row's word means deleting another tenant's object.
    expect(decide({ key: 'org/OTHER/run/run1/a.png' })).toMatchObject({
      delete: false,
      reason: 'key-mismatch',
    });
    expect(decide({ key: 'org/org1/run/OTHER/a.png' })).toMatchObject({
      delete: false,
      reason: 'key-mismatch',
    });
  });

  it('deletes only when every rule is clear', () => {
    expect(decide().delete).toBe(true);
  });
});

describe('an unrecognised plan is not a licence to delete sooner', () => {
  it('gives an unknown plan string the longest window we have', () => {
    expect(retentionDaysForPlan('FREE')).toBe(7);
    expect(retentionDaysForPlan('ENTERPRISE')).toBe(365);
    // Schema drift, a typo, a plan added to the database and not to the code —
    // all of them read as "keep", never as FREE's seven days.
    expect(retentionDaysForPlan('PLATINUM')).toBe(365);
    expect(retentionDaysForPlan(null)).toBe(365);
    expect(retentionDaysForPlan(undefined)).toBe(365);
  });

  it('keeps everything for an org whose row cannot be read at all', async () => {
    // No Organization row comes back, so no plan is known. The sweep must not
    // fall through to the shortest window.
    const ops: string[] = [];
    const calls = fakeDb({ artifacts: [row({ id: 'a1' })], orgs: [] });
    const report = await sweepExpiredArtifacts({
      apply: true,
      now: NOW,
      gc: fakeGc({ ops, objects: { 'org/org1/run/run1/a1.png': 10 } }),
    });

    expect(report.deletable).toBe(0);
    expect(report.kept['plan-window-still-open']).toBe(1);
    expect(calls.deletedIds).toEqual([]);
    expect(ops).toEqual([]);
  });
});

describe('when the store cannot answer', () => {
  /*
   * The reason this file exists. `stat` returning null means "confirmed absent";
   * anything else must not be turned into an absence. Collapsing the two deletes
   * the entire artifact table during an S3 outage.
   */

  it('stops the sweep and deletes nothing when the backend fails', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' }), row({ id: 'a2' }), row({ id: 'a3' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });

    const report = await sweepExpiredArtifacts({
      apply: true,
      now: NOW,
      gc: fakeGc({
        ops,
        objects: { 'org/org1/run/run1/a1.png': 10, 'org/org1/run/run1/a3.png': 10 },
        statThrows: {
          'org/org1/run/run1/a2.png': new StorageGcError(
            'connection refused',
            'backend',
            'org/org1/run/run1/a2.png',
          ),
        },
      }),
    });

    expect(report.stoppedBecause).toMatch(/connection refused/);
    // Not one row, not even a1's, whose object was statted successfully before
    // the failure. A half-applied batch is the thing that leaves rows pointing
    // at objects nobody can find.
    expect(calls.deletedIds).toEqual([]);
    expect(report.rowsDeleted).toBe(0);
    expect(report.objectsDeleted).toBe(0);
    expect(ops.some((o) => o.startsWith('objects:'))).toBe(false);
  });

  it('treats an unclassified throw as a backend failure, not an absence', async () => {
    // A plain Error carries no scope. Defaulting it to "this key is fine to
    // skip" would be the safe-looking choice and the wrong one.
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });

    const report = await sweepExpiredArtifacts({
      apply: true,
      now: NOW,
      gc: fakeGc({ ops, statThrows: { 'org/org1/run/run1/a1.png': new Error('ETIMEDOUT') } }),
    });

    expect(report.stoppedBecause).toMatch(/ETIMEDOUT/);
    expect(calls.deletedIds).toEqual([]);
  });

  it('skips one strange key without wedging the whole sweep', async () => {
    // Object-scoped: this key is odd, the store is fine. The sweep keeps both
    // halves of the odd one and gets on with the rest, because one bad key must
    // not stop retention for the entire fleet.
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' }), row({ id: 'a2' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });

    const report = await sweepExpiredArtifacts({
      apply: true,
      now: NOW,
      gc: fakeGc({
        ops,
        objects: { 'org/org1/run/run1/a2.png': 20 },
        statThrows: {
          'org/org1/run/run1/a1.png': new StorageGcError(
            'is a directory, not an object',
            'object',
            'org/org1/run/run1/a1.png',
          ),
        },
      }),
    });

    expect(report.stoppedBecause).toBeNull();
    expect(report.skipped).toEqual([
      { key: 'org/org1/run/run1/a1.png', reason: 'is a directory, not an object' },
    ]);
    expect(calls.deletedIds).toEqual(['a2']);
  });

  it('keeps the rows of objects the backend refused to delete, and stops', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' }), row({ id: 'a2' }), row({ id: 'a3' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });

    const report = await sweepExpiredArtifacts({
      apply: true,
      now: NOW,
      gc: fakeGc({
        ops,
        objects: {
          'org/org1/run/run1/a1.png': 10,
          'org/org1/run/run1/a2.png': 10,
          'org/org1/run/run1/a3.png': 10,
        },
        deleteFails: { 'org/org1/run/run1/a2.png': 'AccessDenied' },
      }),
    });

    // a2's object survived, so a2's row survives with it. Losing the pointer to
    // an object we cannot then find is the worst outcome available here.
    expect(calls.deletedIds.sort()).toEqual(['a1', 'a3']);
    expect(report.objectsDeleted).toBe(2);
    expect(report.stoppedBecause).toMatch(/AccessDenied/);
  });
});

describe('dry run is the default and it is genuinely dry', () => {
  it('deletes nothing at all when apply was not asked for', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' }), row({ id: 'a2' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });

    const report = await sweepExpiredArtifacts({
      now: NOW,
      gc: fakeGc({
        ops,
        objects: { 'org/org1/run/run1/a1.png': 400, 'org/org1/run/run1/a2.png': 600 },
      }),
    });

    expect(report.applied).toBe(false);
    expect(calls.deletedIds).toEqual([]);
    expect(ops.some((o) => o.startsWith('objects:'))).toBe(false);
    // But the blast radius is fully reported, which is the entire point.
    expect(report.deletable).toBe(2);
    expect(report.deletableBytes).toBe(1_000);
    expect(report.byOrg).toEqual([{ orgId: 'org1', artifacts: 2, bytes: 1_000, runs: 1 }]);
    expect(report.summary).toContain('DRY RUN');
  });

  it('does not clean up rows with missing objects during a dry run either', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });

    const report = await sweepExpiredArtifacts({ now: NOW, gc: fakeGc({ ops, objects: {} }) });

    expect(report.orphanRows).toBe(1);
    expect(calls.deletedIds).toEqual([]);
  });

  it('writes no audit row for a dry run', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });
    await sweepExpiredArtifacts({
      now: NOW,
      gc: fakeGc({ ops, objects: { 'org/org1/run/run1/a1.png': 5 } }),
    });
    // Four scheduled previews a day that each record "deleted nothing" would
    // bury the rows that record real deletions.
    expect(calls.audits).toEqual([]);
  });

  it('reports bytes measured from storage, not the zeroes on the rows', async () => {
    /*
     * `Artifact.sizeBytes` defaults to 0 and the cloud run path (run.ts's
     * artifact upsert) never fills it in — only the on-prem upload endpoint
     * does. A blast-radius report built from the rows alone would tell an
     * operator that deleting 40,000 artifacts frees zero bytes.
     */
    const ops: string[] = [];
    fakeDb({
      artifacts: [row({ id: 'a1', sizeBytes: 0 })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });
    const report = await sweepExpiredArtifacts({
      now: NOW,
      gc: fakeGc({ ops, objects: { 'org/org1/run/run1/a1.png': 5_242_880 } }),
    });
    expect(report.deletableBytes).toBe(5_242_880);
    expect(report.summary).toContain('5.24 MB');
  });
});

describe('the two gates', () => {
  it('downgrades an apply request to a dry run when the deployment has not opted in', async () => {
    // A fresh module instance with the env gate off. An HTTP request must not be
    // able to switch destruction on for a deployment that has not enabled it.
    vi.resetModules();
    const previous = process.env.QAAI_RETENTION_APPLY;
    process.env.QAAI_RETENTION_APPLY = 'false';
    try {
      const mod = await import('./retention.js');
      const ops: string[] = [];
      const calls = fakeDb({
        artifacts: [row({ id: 'a1' })],
        orgs: [{ id: 'org1', plan: 'FREE' }],
      });

      const report = await mod.sweepExpiredArtifacts({
        apply: true,
        now: NOW,
        gc: fakeGc({ ops, objects: { 'org/org1/run/run1/a1.png': 10 } }),
      });

      expect(report.requestedApply).toBe(true);
      expect(report.applied).toBe(false);
      expect(calls.deletedIds).toEqual([]);
      expect(h.log.some((l) => l.startsWith('warn:'))).toBe(true);
    } finally {
      process.env.QAAI_RETENTION_APPLY = previous;
      vi.resetModules();
    }
  });
});

describe('objects first, then rows', () => {
  it('never deletes a row before the object it points at', async () => {
    const ops: string[] = [];
    fakeDb(
      {
        artifacts: [row({ id: 'a1' }), row({ id: 'a2' })],
        orgs: [{ id: 'org1', plan: 'FREE' }],
      },
      ops,
    );

    await sweepExpiredArtifacts({
      apply: true,
      now: NOW,
      gc: fakeGc({
        ops,
        objects: { 'org/org1/run/run1/a1.png': 1, 'org/org1/run/run1/a2.png': 1 },
      }),
    });

    const objectsAt = ops.findIndex((o) => o.startsWith('objects:'));
    const rowsAt = ops.findIndex((o) => o.startsWith('rows:'));
    expect(objectsAt).toBeGreaterThanOrEqual(0);
    expect(rowsAt).toBeGreaterThan(objectsAt);
  });

  it('drops a row whose object is already gone, and asks storage to delete nothing', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });

    const report = await sweepExpiredArtifacts({
      apply: true,
      now: NOW,
      gc: fakeGc({ ops, objects: {} }),
    });

    expect(report.orphanRows).toBe(1);
    expect(calls.deletedIds).toEqual(['a1']);
    expect(ops.filter((o) => o.startsWith('objects:'))).toEqual([]);
  });
});

describe('bounded and resumable', () => {
  it('stops at maxBatches and hands back a cursor to resume from', async () => {
    const artifacts = Array.from({ length: 250 }, (_, i) =>
      row({ id: `a${String(i).padStart(3, '0')}` }),
    );
    const objects = Object.fromEntries(artifacts.map((a) => [a.key, 4]));
    const ops: string[] = [];
    fakeDb({ artifacts, orgs: [{ id: 'org1', plan: 'FREE' }] });

    const report = await sweepExpiredArtifacts({
      now: NOW,
      batchSize: 100,
      maxBatches: 2,
      gc: fakeGc({ ops, objects }),
    });

    // 200 of 250 examined, and the sweep says so rather than pretending it saw
    // everything. Deleting 400k objects in one pass is an outage.
    expect(report.examined).toBe(200);
    expect(report.batches).toBe(2);
    expect(report.more).toBe(true);
    expect(report.cursor).toBe('a199');
  });

  it('resumes strictly after the cursor it was given', async () => {
    const artifacts = [row({ id: 'a1' }), row({ id: 'a2' }), row({ id: 'a3' })];
    const ops: string[] = [];
    const calls = fakeDb({ artifacts, orgs: [{ id: 'org1', plan: 'FREE' }] });

    const report = await sweepExpiredArtifacts({
      now: NOW,
      cursor: 'a1',
      gc: fakeGc({ ops, objects: Object.fromEntries(artifacts.map((a) => [a.key, 1])) }),
    });

    expect(report.examined).toBe(2);
    expect(calls.artifactWhere[0]).toMatchObject({ id: { gt: 'a1' } });
  });

  it('confines a sweep to one org when asked', async () => {
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' }), row({ id: 'b1', orgId: 'org2' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });
    const ops: string[] = [];
    await sweepExpiredArtifacts({ now: NOW, orgId: 'org1', gc: fakeGc({ ops, objects: {} }) });
    expect(calls.artifactWhere[0]).toMatchObject({ orgId: 'org1' });
  });

  it('only ever considers rows that carry an expiry, and only past the cutoff', async () => {
    const calls = fakeDb({ artifacts: [], orgs: [] });
    const ops: string[] = [];
    await sweepExpiredArtifacts({ now: NOW, graceMs: DAY, gc: fakeGc({ ops }) });
    const where = calls.artifactWhere[0] as { expiresAt: { not: null; lt: Date } };
    expect(where.expiresAt.not).toBeNull();
    expect(where.expiresAt.lt.toISOString()).toBe('2026-07-31T12:00:00.000Z');
  });
});

describe('every deletion is audited', () => {
  it('writes one row per org with what was deleted and how much', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [
        row({ id: 'a1' }),
        row({ id: 'a2', runId: 'run2', key: 'org/org1/run/run2/a2.png' }),
        row({ id: 'b1', orgId: 'org2', runId: 'r9', key: 'org/org2/run/r9/b1.png' }),
      ],
      orgs: [
        { id: 'org1', plan: 'FREE' },
        { id: 'org2', plan: 'FREE' },
      ],
    });

    await sweepExpiredArtifacts({
      apply: true,
      now: NOW,
      requestedBy: 'user_42',
      gc: fakeGc({
        ops,
        objects: {
          'org/org1/run/run1/a1.png': 1_000,
          'org/org1/run/run2/a2.png': 2_000,
          'org/org2/run/r9/b1.png': 500,
        },
      }),
    });

    expect(calls.audits.map((a) => a.orgId).sort()).toEqual(['org1', 'org2']);
    const org1 = calls.audits.find((a) => a.orgId === 'org1');
    expect(org1?.action).toBe('retention.sweep');
    expect(org1?.metadata).toMatchObject({
      artifacts: 2,
      bytes: 3_000,
      bytesHuman: '3.00 kB',
      runs: 2,
      requestedBy: 'user_42',
    });
  });

  it('does not abort the sweep when the audit write fails', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' })],
      orgs: [{ id: 'org1', plan: 'FREE' }],
    });
    h.prisma.auditLog = {
      create: async () => {
        throw new Error('audit table is on fire');
      },
    };

    // The deletion has already happened by the time the audit is written;
    // throwing here would only make the outcome less knowable, not less real.
    const report = await sweepExpiredArtifacts({
      apply: true,
      now: NOW,
      gc: fakeGc({ ops, objects: { 'org/org1/run/run1/a1.png': 1 } }),
    });

    expect(report.rowsDeleted).toBe(1);
    expect(calls.deletedIds).toEqual(['a1']);
    expect(h.log.some((l) => l.startsWith('error:'))).toBe(true);
  });
});

describe('objects with no row are reported, never deleted', () => {
  it('never asks storage to delete anything', async () => {
    const ops: string[] = [];
    fakeDb({});
    await scanStrayObjects({
      gc: fakeGc({
        ops,
        list: [
          { key: 'org/org1/run/run1/a.png', sizeBytes: 100 },
          { key: 'orgs/org1/persistent/baseline.png', sizeBytes: 200 },
          { key: 'something/else', sizeBytes: 300 },
        ],
      }),
      prefix: '',
    });
    expect(ops.filter((o) => o.startsWith('objects:'))).toEqual([]);
  });

  it('classifies a visual baseline as expected, not as garbage', async () => {
    /*
     * `orgs/<id>/persistent/` is row-less BY DESIGN — run.ts's `putPersistent`
     * writes there precisely so a baseline outlives the run that captured it.
     * Any orphan scan that read "no row" as "delete" would wipe every visual
     * baseline in the install on its first pass.
     */
    const ops: string[] = [];
    fakeDb({});
    const report = await scanStrayObjects({
      gc: fakeGc({
        ops,
        list: [
          { key: 'orgs/org1/persistent/home-chromium.png', sizeBytes: 2_000 },
          { key: 'org/org1/run/gone/x.png', sizeBytes: 1_000 },
          { key: 'stray/thing.bin', sizeBytes: 7 },
        ],
      }),
      prefix: '',
    });

    expect(report.scanned).toBe(3);
    expect(report.byKind.persistent).toEqual({ objects: 1, bytes: 2_000 });
    expect(report.byKind['run-artifact']).toEqual({ objects: 1, bytes: 1_000 });
    expect(report.byKind.unknown).toEqual({ objects: 1, bytes: 7 });
  });

  it('does not report an object that a row or a baseline accounts for', async () => {
    const ops: string[] = [];
    fakeDb({});
    h.prisma.artifact = { findMany: async () => [{ key: 'org/org1/run/run1/a.png' }] };
    h.prisma.visualBaseline = {
      findMany: async () => [{ imageKey: 'orgs/org1/persistent/b.png' }],
    };

    const report = await scanStrayObjects({
      gc: fakeGc({
        ops,
        list: [
          { key: 'org/org1/run/run1/a.png', sizeBytes: 1 },
          { key: 'orgs/org1/persistent/b.png', sizeBytes: 1 },
        ],
      }),
      prefix: '',
    });

    expect(report.byKind['run-artifact'].objects).toBe(0);
    expect(report.byKind.persistent.objects).toBe(0);
  });
});

describe('rows with no object are reported, never deleted', () => {
  it('lists missing objects without touching a single row', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1' }), row({ id: 'a2' })],
    });

    const report = await scanMissingObjects({
      gc: fakeGc({ ops, objects: { 'org/org1/run/run1/a2.png': 9 } }),
    });

    expect(report.missing.map((m) => m.id)).toEqual(['a1']);
    // A live row with no object is harmless — the artifact endpoint 404s on it.
    // Deleting it on the strength of one stat is the outage this file avoids.
    expect(calls.deletedIds).toEqual([]);
  });

  it('backfills a measured size only when asked, and only over a zero', async () => {
    const ops: string[] = [];
    const calls = fakeDb({
      artifacts: [row({ id: 'a1', sizeBytes: 0 }), row({ id: 'a2', sizeBytes: 123 })],
    });

    await scanMissingObjects({
      backfill: true,
      gc: fakeGc({
        ops,
        objects: { 'org/org1/run/run1/a1.png': 4_096, 'org/org1/run/run1/a2.png': 4_096 },
      }),
    });

    // a2 already had a number on it; a measurement must not overwrite one that
    // was recorded at upload time.
    expect(calls.updates).toEqual([{ id: 'a1', sizeBytes: 4_096 }]);
  });

  it('stops on a backend failure rather than reporting every row as missing', async () => {
    const ops: string[] = [];
    fakeDb({ artifacts: [row({ id: 'a1' }), row({ id: 'a2' })] });

    const report = await scanMissingObjects({
      gc: fakeGc({
        ops,
        objects: { 'org/org1/run/run1/a2.png': 5 },
        statThrows: {
          'org/org1/run/run1/a1.png': new StorageGcError('503 from the bucket', 'backend', null),
        },
      }),
    });

    // The whole point: an unreachable store must not produce a report saying
    // every artifact row is dangling. That report is what someone would act on.
    expect(report.stoppedBecause).toMatch(/503 from the bucket/);
    expect(report.missing).toEqual([]);
  });
});

describe('key parsing is strict', () => {
  it('accepts only the exact run-artifact shape', () => {
    expect(parseRunArtifactKey('org/o1/run/r1/shot.png')).toEqual({
      orgId: 'o1',
      runId: 'r1',
      name: 'shot.png',
    });
    for (const bad of [
      'org/o1/run/r1',
      'org/o1/run/r1/a/b',
      'orgs/o1/persistent/x.png',
      'org//run/r1/x.png',
      'ORG/o1/run/r1/x.png',
      '',
    ]) {
      expect(parseRunArtifactKey(bad)).toBeNull();
    }
  });

  it('never classifies a persistent key as a deletable run artifact', () => {
    expect(classifyStrayKey('orgs/o1/persistent/x.png')).toBe('persistent');
    expect(classifyStrayKey('org/o1/run/r1/x.png')).toBe('run-artifact');
    expect(classifyStrayKey('anything/else')).toBe('unknown');
  });
});

describe('the queue name is pinned', () => {
  it('matches the literal apps/api/src/routes/retention.ts carries', () => {
    // The two constants live in different apps because neither may edit
    // packages/shared's QUEUE_NAMES. If this ever changes, the API enqueues into
    // a queue nobody drains and every requested sweep sits in Redis forever.
    expect(RETENTION_QUEUE).toBe('qaai.retention');
  });
});
