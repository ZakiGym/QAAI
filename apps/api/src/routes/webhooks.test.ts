/**
 * WHERE A QAAI PULL REQUEST ENDS, FROM A SIGNED DELIVERY TO THE ROW IT MOVES.
 *
 * `recordPullRequestMerged` had NO CALLER anywhere in this repository and there
 * was no code at all for the other ending, so every record the open path wrote
 * sat at OPEN for ever. What is proved here is the DOOR, by posting real signed
 * bodies at the real router:
 *
 *   1. A MERGE LANDS. The record moves to MERGED and the coverage recompute runs
 *      against the row's OWN project — not against anything the payload named.
 *
 *   2. MERGED AND RE-MEASURED ARE TWO FACTS. A recompute that throws leaves the
 *      merge recorded and `remeasured: false` beside it. One field for both
 *      would make a stale coverage number indistinguishable from a fresh one.
 *
 *   3. AN UNMERGED CLOSE LANDS TOO, as CLOSED, and re-measures NOTHING — nothing
 *      reached the trunk, so the denominator did not change.
 *
 *   4. THE ROW IS CHOSEN BY THE HEAD BRANCH AND NEVER BY THE PAYLOAD'S NUMBER.
 *      The fake prisma THROWS on any filter the route is not supposed to use, so
 *      a future edit that selected a record by `pull_request.number` — an
 *      attacker-chosen integer — fails here rather than in production.
 *
 *   5. A HOSTILE HEAD REF REACHES NO QUERY. `qaaiBranchShape` is a shape gate,
 *      so `main`, `qaai/heal/../../etc/passwd` and a 4KB ref are refused before
 *      prisma is touched at all.
 *
 *   6. NOTHING HAPPENS WITHOUT THE SIGNATURE.
 *
 * NO NETWORK AND NO DATABASE. `computeCoverage` is mocked because the real one
 * opens Postgres on import; everything about the record itself — the store, the
 * merge policy, the close policy, the shape gate — is the SHIPPED code.
 */

import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

/**
 * The HMAC secret, written with SPACES so it holds no credential-shaped run.
 *
 * `redactSecrets` treats any run of 20 or more `[A-Za-z0-9_-]` characters as a
 * credential, and GitHub push protection has already rejected a finished, green
 * commit in this repository for a key-shaped literal in a test. A webhook secret
 * has no provider prefix to compose from, so the defence here is the opposite
 * one: a sentence cannot match the pattern at all, and `createHmac` does not
 * care what the bytes look like.
 */
const SECRET = 'not a real secret: fabricated for this test';

interface Hoisted {
  prisma: Record<string, unknown>;
  /** Every audit row written through `pullRequestAudit`'s prisma create. */
  audits: Row[];
  /** Every `computeCoverage` call, so "was it re-measured, and over what" is checkable. */
  recomputes: Array<{ orgId: string; projectId: string; persist: boolean | undefined }>;
  /** Set to make the recompute fail, for the two-facts-two-fields test. */
  recomputeThrows: boolean;
  /** Filters the fake was asked for and refused. A non-empty list is a defect. */
  rejectedFilters: string[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  audits: [],
  recomputes: [],
  recomputeThrows: false,
  rejectedFilters: [],
}));

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    GITHUB_WEBHOOK_SECRET: SECRET,
  },
  isProd: false,
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  },
  currentRequestId: () => 'req_test',
  setRequestActor: () => {},
  runWithRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
}));

/*
 * The tenant scope is real, for the reason the other route tests give: the
 * route's queries run in the async continuation of `withTenant`, so a plain
 * variable would be restored before they ran.
 */
vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  return {
    prisma: new Proxy({}, { get: (_t, key: string) => (h.prisma as Row)[key] }),
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

/*
 * `registerStripeWebhook` runs at import time and the billing module builds a
 * Stripe client. Stubbed to a no-op: this file is about the pull-request half of
 * this router and billing has its own two test files.
 */
vi.mock('./billing.js', () => ({ registerStripeWebhook: () => {} }));

vi.mock('../lib/start-run.js', () => ({
  startRun: async () => ({ created: false, quota: { reason: 'not exercised here' } }),
  effectivePlan: async () => null,
}));

/*
 * The ONLY mocked part of the subject. `computeCoverage` reads a dozen tables
 * and opens Postgres on import; what this file needs to know is whether the
 * merge path reached it, with which project, and what happens when it fails.
 */
vi.mock('../lib/coverage-store.js', () => ({
  computeCoverage: async (options: { orgId: string; projectId: string; persist?: boolean }) => {
    h.recomputes.push({
      orgId: options.orgId,
      projectId: options.projectId,
      persist: options.persist,
    });
    if (h.recomputeThrows) throw new Error('redis is down');
    return { snapshotId: 'snap_1' };
  },
}));

// ─── Rows ────────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const PROJECT = 'proj_1';
const REPO = 'acme/app';
/** 64 lowercase hex, as `prCauseKey` produces. Not a real hash of anything. */
const CAUSE = 'b'.repeat(64);
/** What `branchNameFor({ purpose: 'HEAL', causeKey: CAUSE })` composes. */
const BRANCH = `qaai/heal/${CAUSE.slice(0, 12)}`;

/** The columns `PullRequestRecordRow` names. The fake honours `select` over these. */
let records: Row[] = [];

/**
 * The filters each delegate is ALLOWED to be asked for.
 *
 * Anything else throws and is recorded. This is the assertion behind "the row is
 * chosen by a value QAAI wrote": `number` is absent from this set, so a route
 * that resolved a record by `pull_request.number` would fail every test in this
 * file instead of shipping.
 */
const KNOWN_FILTERS: Record<string, Set<string>> = {
  pullRequestRecord: new Set(['id', 'orgId', 'branch', 'causeKey']),
};

function matchesWhere(model: string, row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!KNOWN_FILTERS[model]!.has(key)) {
      h.rejectedFilters.push(`${model}.${key}`);
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    if (cond === null) return (row[key] ?? null) === null;
    return row[key] === cond;
  });
}

/**
 * `select` is HONOURED, which is the point. A select-blind fake makes deleting a
 * field from a query undetectable — drop `causeKey` from the branch resolver's
 * select and the merge would be recorded against `undefined`.
 */
function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(select)) if (want === true) out[key] = row[key];
  return out;
}

function reset(): void {
  h.audits.length = 0;
  h.recomputes.length = 0;
  h.rejectedFilters.length = 0;
  h.recomputeThrows = false;
  records = [
    {
      id: 'pr_1',
      orgId: ORG,
      projectId: PROJECT,
      repo: REPO,
      branch: BRANCH,
      baseRef: 'main',
      purpose: 'HEAL',
      causeKey: CAUSE,
      state: 'OPEN',
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
    },
  ];

  h.prisma = {
    integration: {
      findFirst: async ({ select }: { select?: Row }) =>
        project({ id: 'int_1', orgId: ORG, projectId: PROJECT }, select),
    },
    pullRequestRecord: {
      /** `take` is honoured, because the ambiguity refusal rests on it. */
      findMany: async ({ where, select, take }: { where: Row; select?: Row; take?: number }) => {
        const hit = records.filter((row) => matchesWhere('pullRequestRecord', row, where ?? {}));
        return (take === undefined ? hit : hit.slice(0, take)).map((row) => project(row, select));
      },
      findFirst: async ({ where, select }: { where: Row; select?: Row }) => {
        const hit = records.find((row) => matchesWhere('pullRequestRecord', row, where ?? {}));
        return hit ? project(hit, select) : null;
      },
      update: async ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
        const hit = records.find((row) => matchesWhere('pullRequestRecord', row, where ?? {}));
        if (!hit) throw new Error('fake prisma: no such record');
        Object.assign(hit, data);
        return project(hit, select);
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        h.audits.push(data);
        return { id: `audit_${h.audits.length}` };
      },
    },
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const { webhooksRouter } = await import('./webhooks.js');
  const app = express();
  /*
   * `express.raw`, exactly as index.ts mounts it: the HMAC is verified over the
   * bytes GitHub signed, and a JSON parser in front of this would re-serialise
   * them into a body whose signature no longer matches.
   */
  app.use('/webhooks', express.raw({ type: '*/*' }), webhooksRouter);
  app.use((err: Row, _req: Row, res: Row, _next: unknown) => {
    res.status(err.status ?? 500).json({ error: { message: err.message } });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(reset);

/** One signed delivery. `sign: false` posts the same body with a wrong digest. */
async function deliver(
  payload: unknown,
  opts: { event?: string; sign?: boolean } = {},
): Promise<{ status: number; body: Row }> {
  const raw = JSON.stringify(payload);
  const digest = `sha256=${createHmac('sha256', opts.sign === false ? 'wrong' : SECRET)
    .update(raw)
    .digest('hex')}`;
  const res = await fetch(`${base}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': opts.event ?? 'pull_request',
      'x-hub-signature-256': digest,
    },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as Row };
}

/** A `closed` delivery for the seeded record's branch. */
function closedEvent(opts: { merged: boolean; ref?: string; number?: number }): unknown {
  return {
    action: 'closed',
    pull_request: {
      number: opts.number ?? 7,
      merged: opts.merged,
      head: { ref: opts.ref ?? BRANCH, sha: 'c'.repeat(40) },
      base: { ref: 'main' },
    },
    repository: { full_name: REPO },
  };
}

// ─── The merge ───────────────────────────────────────────────────────────────

describe('POST /webhooks/github records a merged pull request', () => {
  it('moves the record to MERGED and re-measures the ROW\'s project', async () => {
    const res = await deliver(closedEvent({ merged: true }));

    expect(res.status).toBe(200);
    expect(res.body.pullRequest).toMatchObject({ outcome: 'MERGED', remeasured: true });
    expect(records[0]!.state).toBe('MERGED');
    expect(h.recomputes).toEqual([{ orgId: ORG, projectId: PROJECT, persist: true }]);
    const audit = h.audits.find((row) => row.action === 'pull-request.merged');
    expect(audit?.targetId).toBe('pr_1');
    expect(audit?.metadata.remeasured).toBe(true);
    // Nobody asked: the actor on this path is GitHub, not a QAAI user.
    expect(audit?.userId).toBeNull();
  });

  /*
   * TWO FACTS, TWO FIELDS. The state write commits and the recompute can fail,
   * and a reader has to be able to tell a stale coverage number from a fresh
   * one. Folding these into one field is the defect `healVerificationDisplay`
   * was corrected for last round.
   */
  it('records the merge and says the coverage was NOT re-measured when the recompute fails', async () => {
    h.recomputeThrows = true;

    const res = await deliver(closedEvent({ merged: true }));

    expect(res.status).toBe(200);
    expect(res.body.pullRequest.outcome).toBe('MERGED');
    expect(res.body.pullRequest.remeasured).toBe(false);
    expect(records[0]!.state).toBe('MERGED');
    expect(h.audits.find((row) => row.action === 'pull-request.merged')?.metadata.remeasured).toBe(
      false,
    );
  });

  it('is idempotent: a redelivered merge re-measures nothing a second time', async () => {
    await deliver(closedEvent({ merged: true }));
    const again = await deliver(closedEvent({ merged: true }));

    expect(again.body.pullRequest.outcome).toBe('ALREADY_MERGED');
    expect(again.body.pullRequest.remeasured).toBe(false);
    expect(h.recomputes).toHaveLength(1);
  });

  /*
   * THE ASSERTION THE WHOLE FAKE IS SHAPED FOR. `pull_request.number` is the
   * host's identifier and an attacker-chosen integer; the row is resolved from
   * the head branch, which is a value QAAI composed and stored. The payload here
   * carries a number that matches NO record, and the merge still lands.
   */
  it('resolves the row from the head branch, never from the number in the payload', async () => {
    const res = await deliver(closedEvent({ merged: true, number: 4242 }));

    expect(res.body.pullRequest.outcome).toBe('MERGED');
    expect(records[0]!.state).toBe('MERGED');
    expect(h.rejectedFilters).toEqual([]);
  });
});

// ─── The close that is not a merge ───────────────────────────────────────────

describe('POST /webhooks/github records a pull request closed without merging', () => {
  it('moves the record to CLOSED and re-measures nothing', async () => {
    const res = await deliver(closedEvent({ merged: false }));

    expect(res.status).toBe(200);
    expect(res.body.pullRequest).toMatchObject({ outcome: 'CLOSED', remeasured: false });
    expect(records[0]!.state).toBe('CLOSED');
    // Nothing reached the trunk, so the denominator did not change.
    expect(h.recomputes).toEqual([]);
    const audit = h.audits.find((row) => row.action === 'pull-request.closed');
    expect(audit?.metadata.previousState).toBe('OPEN');
    expect(audit?.metadata.remeasured).toBe(false);
  });

  /*
   * REQUESTED is the row the open path writes BEFORE it calls the host. A close
   * for that branch is the evidence that whatever happened is over, and leaving
   * it at REQUESTED would leave "we were about to" standing for ever.
   */
  it('closes a REQUESTED row, which is the one a crash mid-call leaves behind', async () => {
    records[0]!.state = 'REQUESTED';
    records[0]!.number = null;
    records[0]!.url = null;

    const res = await deliver(closedEvent({ merged: false }));

    expect(res.body.pullRequest.outcome).toBe('CLOSED');
    expect(records[0]!.state).toBe('CLOSED');
    expect(h.audits.find((row) => row.action === 'pull-request.closed')?.metadata.previousState).toBe(
      'REQUESTED',
    );
  });

  /*
   * GitHub sends `closed` for a merge too, so the two events differ only by a
   * boolean. A replay, a trimmed delivery or a bug that dropped `merged` must
   * not overwrite a merge QAAI already recorded and re-measured for.
   */
  it('refuses to downgrade a MERGED record to CLOSED', async () => {
    records[0]!.state = 'MERGED';

    const res = await deliver(closedEvent({ merged: false }));

    expect(res.body.pullRequest.outcome).toBe('WOULD_DOWNGRADE_MERGE');
    expect(records[0]!.state).toBe('MERGED');
    expect(h.audits).toHaveLength(0);
  });

  it('treats a missing `merged` as a close and not as a merge', async () => {
    const res = await deliver({
      action: 'closed',
      pull_request: { number: 7, head: { ref: BRANCH }, base: { ref: 'main' } },
      repository: { full_name: REPO },
    });

    expect(res.body.pullRequest.outcome).toBe('CLOSED');
    expect(h.recomputes).toEqual([]);
  });

  it('is idempotent: a redelivered close writes nothing twice', async () => {
    await deliver(closedEvent({ merged: false }));
    const again = await deliver(closedEvent({ merged: false }));

    expect(again.body.pullRequest.outcome).toBe('ALREADY_CLOSED');
    expect(h.audits.filter((row) => row.action === 'pull-request.closed')).toHaveLength(1);
  });

  /*
   * A DRAFT PULL REQUEST STILL HAS A RECORD. The draft check used to sit above
   * everything and would have skipped this, which is one of the ways a row
   * stayed at OPEN for ever.
   */
  it('reconciles a draft pull request that was closed', async () => {
    const res = await deliver({
      action: 'closed',
      pull_request: {
        number: 7,
        merged: false,
        draft: true,
        head: { ref: BRANCH },
        base: { ref: 'main' },
      },
      repository: { full_name: REPO },
    });

    expect(res.body.pullRequest.outcome).toBe('CLOSED');
    expect(records[0]!.state).toBe('CLOSED');
  });
});

// ─── What the payload is not allowed to do ───────────────────────────────────

describe('POST /webhooks/github refuses a head ref QAAI did not compose', () => {
  /*
   * Each of these is refused BEFORE a query runs. The branch is the only thing
   * that selects a row, so the shape gate is the whole perimeter.
   */
  const hostile = [
    'main',
    'qaai/heal/../../../etc/passwd',
    'qaai/heal/ZZZZZZZZZZZZ',
    'qaai/nonsense/aaaaaaaaaaaa',
    'qaai/heal/aaaaaaaaaaaa\n',
    'refs/heads/qaai/heal/aaaaaaaaaaaa',
    `qaai/heal/${'a'.repeat(4000)}`,
  ];

  for (const ref of hostile) {
    it(`ignores ${JSON.stringify(ref.slice(0, 40))} without touching a record`, async () => {
      const res = await deliver(closedEvent({ merged: true, ref }));

      expect(res.status).toBe(200);
      expect(res.body.pullRequest.outcome).toBe('NOT_A_QAAI_BRANCH');
      expect(records[0]!.state).toBe('OPEN');
      expect(h.recomputes).toEqual([]);
      expect(h.audits).toHaveLength(0);
    });
  }

  it('answers NOT_OURS for a well-formed QAAI branch no record claims', async () => {
    const res = await deliver(
      closedEvent({ merged: true, ref: `qaai/tests/${'f'.repeat(12)}` }),
    );

    expect(res.body.pullRequest.outcome).toBe('NOT_OURS');
    expect(records[0]!.state).toBe('OPEN');
    expect(h.recomputes).toEqual([]);
  });

  /*
   * The branch carries only 12 of the cause key's 64 characters, so two causes
   * CAN collide on it. Picking one would attribute a merged change to the wrong
   * cause and re-measure the wrong project.
   */
  it('refuses an ambiguous branch rather than picking a row', async () => {
    records.push({ ...records[0]!, id: 'pr_2', causeKey: 'c'.repeat(64) });

    const res = await deliver(closedEvent({ merged: true }));

    expect(res.body.pullRequest.outcome).toBe('AMBIGUOUS');
    expect(res.body.pullRequest.note).toContain('2 pull-request records');
    expect(records.every((row) => row.state === 'OPEN')).toBe(true);
    expect(h.recomputes).toEqual([]);
    expect(h.audits).toHaveLength(0);
  });

  it('writes nothing when the signature does not match', async () => {
    const res = await deliver(closedEvent({ merged: true }), { sign: false });

    expect(res.status).toBe(401);
    expect(records[0]!.state).toBe('OPEN');
    expect(h.audits).toHaveLength(0);
    expect(h.recomputes).toEqual([]);
  });

  it('still ignores the actions that are neither runnable nor a close', async () => {
    const res = await deliver({
      action: 'labeled',
      pull_request: { number: 7, head: { ref: BRANCH } },
      repository: { full_name: REPO },
    });

    expect(res.body.ignored).toBe('action labeled');
    expect(records[0]!.state).toBe('OPEN');
  });
});
