/**
 * THE OWNERSHIP LEDGER, FROM AN HTTP REQUEST TO THE ROW IT UPDATES.
 *
 * What is NOT being retested here: the decision layer. `replaceDecision` and
 * both of `pushRepo`'s passes are proved in git.test.ts and, against real git
 * objects, in git.realtree.verify.test.ts. Those files build their ledger BY
 * HAND, with the tree path and the ledger path spelled the same — which is
 * exactly the assumption this file exists to test, because in production they
 * are not the same string.
 *
 * So what is proved here is the SEAM, and only by driving the real route:
 *
 *   1. A REQUEST REACHES THE READER AT ALL. Before this round
 *      `POST /:projectId/git/push` passed no `ownership`, so every path on the
 *      branch resolved UNRECORDED and the second push of a project wrote
 *      nothing. The first test asserts the push was handed a reader and that
 *      the reader answers QAAI_OWNED for a real tree path.
 *
 *   2. THE TWO SPELLINGS MEET. `buildRepoTree` is the REAL one, so the tree
 *      path for a PLAYWRIGHT_TS test is `tests/checkout/...` while the ledger
 *      row — like `Test.filePath` and like `ledgerRowsFor`'s own output — is
 *      `checkout/...`. A reader that looked tree paths up in the ledger
 *      directly answers UNRECORDED for all of them, and the push would then
 *      refuse every file while reporting that nothing claimed it. That is the
 *      mutation this file is built to catch.
 *
 *   3. THE REFRESH LANDS ON THE RIGHT ROW. `ledgerRefresh` comes back keyed by
 *      TREE path and the row to update is keyed by LEDGER path, so the writer
 *      has to translate. A refresh written to the wrong key updates nothing,
 *      and the next push refuses QAAI's own file as BYTES_DIVERGED.
 *
 *   4. A HUMAN'S FILE IS STILL REFUSED once a reader exists, and the scaffolding
 *      QAAI does not own — `playwright.config.ts`, `README.md` — is never
 *      claimed by the reader at all.
 *
 * `pushRepo` is replaced by a thin stand-in that calls the REAL
 * `replaceDecision` for every tree path against a seeded branch. The verdict in
 * every assertion below therefore comes from the shipped gate, not from this
 * file; what the stand-in replaces is the network and the working tree.
 */

import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

interface Hoisted {
  prisma: Record<string, unknown>;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  /** Files already on the branch, as the stand-in push sees them. */
  branch: Map<string, string>;
  /** Every `recordFor` question the push asked, and the verdict it got back. */
  asked: Array<{ path: string; verdict: string }>;
  /** The tree the push was handed, and whether it got a reader at all. */
  lastPush: { tree: Map<string, string>; ownershipSupplied: boolean } | null;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
  audits: [],
  branch: new Map(),
  asked: [],
  lastPush: null,
}));

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
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
 * The tenant scope is real, for the reason projects.tree.test.ts gives: the
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

vi.mock('../lib/audit.js', () => ({
  audit: async (input: Row) => {
    h.audits.push(input);
  },
}));

/*
 * No vault. The token is not the subject here, and decrypting a sealed blob
 * would make every test in this file depend on the key schedule. It is also
 * never asserted on, never logged by the route, and never returned.
 */
vi.mock('../lib/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/integrations.js')>();
  return { ...actual, openToken: () => 'not-a-real-token' };
});

vi.mock('../middleware/auth.js', async () => {
  const { ROLE_RANK } = await import('@qaai/shared');
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole:
      (minimum: keyof typeof ROLE_RANK) => (req: Row, res: Row, next: () => void) => {
        if (ROLE_RANK[req.actor.role as keyof typeof ROLE_RANK] < ROLE_RANK[minimum]) {
          res.status(403).json({ error: { code: 'FORBIDDEN', message: `Requires ${minimum}` } });
          return;
        }
        next();
      },
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

/*
 * A PARTIAL mock: `replaceDecision` is the REAL gate and so is `repoHttpsUrl`.
 * Only `pushRepo` is replaced, and only to stand in for the network and the
 * working tree — the allow/refuse verdict for every path below is computed by
 * the shipped function.
 */
vi.mock('../lib/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/git.js')>();
  return {
    ...actual,
    pushRepo: async (
      tree: Map<string, string>,
      opts: Parameters<typeof actual.pushRepo>[1],
    ): Promise<Awaited<ReturnType<typeof actual.pushRepo>>> => {
      h.lastPush = { tree: new Map(tree), ownershipSupplied: opts.ownership !== undefined };
      const unrecorded = { verdict: 'UNRECORDED' as const, contentHash: null, imports: [] };
      const ledgerRefresh: { path: string; contentHash: string }[] = [];
      const refused: Array<{ path: string; reason: string }> = [];
      let filesWritten = 0;
      let filesCreated = 0;

      for (const [path, content] of tree) {
        const record = opts.ownership ? opts.ownership.recordFor(path) : unrecorded;
        h.asked.push({ path, verdict: record.verdict });
        const onBranch = h.branch.has(path);
        if (!onBranch) {
          // A create destroys nothing and asks the gate nothing, exactly as
          // `pushRepo`'s pass 1 does.
          h.branch.set(path, content);
          filesWritten += 1;
          filesCreated += 1;
          if (opts.ownership) ledgerRefresh.push({ path, contentHash: sha256(content) });
          continue;
        }
        const outcome = actual.replaceDecision({
          record,
          branchBytes: h.branch.get(path) ?? null,
          digest: opts.ownership ? opts.ownership.digest : () => 'no-reader',
        });
        if (!outcome.allowed) {
          refused.push({ path, reason: outcome.reason ?? 'NOT_OURS' });
          continue;
        }
        h.branch.set(path, content);
        filesWritten += 1;
        if (opts.ownership) ledgerRefresh.push({ path, contentHash: sha256(content) });
      }

      return {
        commitSha: 'a'.repeat(40),
        branch: opts.branch,
        repoUrl: 'https://github.com/acme/tests.git',
        fileCount: tree.size,
        filesWritten,
        filesCreated,
        filesRefused: refused as never,
        refusedCount: refused.length,
        filesDeleted: [],
        filesKept: [],
        keptCount: 0,
        contentsOmitted: 0,
        ledgerRefresh,
        ownershipKnown: opts.ownership !== undefined,
        basedOnRemote: true,
      };
    },
  };
});

// ─── Rows ────────────────────────────────────────────────────────────────────

/** The generator's own spelling: PLAYWRIGHT_TS emits no root and leaves it to the exporter. */
const LEDGER_PATH = 'checkout/pay-with-card.spec.ts';
/** What the exporter writes, and therefore what `pushRepo` asks about. */
const TREE_PATH = 'tests/checkout/pay-with-card.spec.ts';
const SPEC_CODE = "import { test } from '@playwright/test';\ntest('pay', async () => {});\n";

let tests: Row[] = [];
let artifacts: Row[] = [];

const KNOWN_FILTERS: Record<string, Set<string>> = {
  test: new Set(['id', 'orgId', 'projectId', 'disabledAt']),
  generatedArtifact: new Set(['id', 'orgId', 'projectId', 'path']),
};

function matchesWhere(model: string, row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!KNOWN_FILTERS[model]!.has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    if (cond === null) return (row[key] ?? null) === null;
    return row[key] === cond;
  });
}

/**
 * `select` is HONOURED, which is the point. A select-blind fake makes deleting
 * a field from a query undetectable — drop `contentHash` from the route's
 * `select` and the reader silently compares against `undefined`.
 */
function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(select)) if (want === true) out[key] = row[key];
  return out;
}

function reset(): void {
  h.audits.length = 0;
  h.asked.length = 0;
  h.lastPush = null;
  h.branch = new Map();
  tests = [
    {
      id: 'test_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      name: 'pay with card',
      type: 'E2E',
      code: SPEC_CODE,
      spec: null,
      filePath: LEDGER_PATH,
      disabledAt: null,
    },
  ];
  artifacts = [
    {
      id: 'art_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      path: LEDGER_PATH,
      role: 'SPEC',
      ownership: 'QAAI_OWNED',
      contentHash: sha256(SPEC_CODE),
      imports: [],
      bytes: SPEC_CODE.length,
    },
  ];

  h.prisma = {
    project: {
      findUnique: async ({ where, select }: { where: Row; select?: Row }) =>
        where.id === 'proj_1'
          ? project(
              {
                id: 'proj_1',
                name: 'Acme',
                slug: 'acme',
                primaryLanguage: 'TYPESCRIPT',
                primaryFramework: 'REACT',
              },
              select,
            )
          : null,
    },
    integration: {
      findUnique: async ({ where, select }: { where: Row; select?: Row }) =>
        where.id === 'int_1'
          ? project(
              {
                id: 'int_1',
                kind: 'GITHUB',
                config: { repo: 'acme/tests', defaultBranch: 'qaai/tests' },
                configEnc: 'sealed',
                enabled: true,
              },
              select,
            )
          : null,
    },
    test: {
      findMany: async ({ where, select }: { where: Row; select?: Row }) =>
        tests.filter((row) => matchesWhere('test', row, where ?? {})).map((row) => project(row, select)),
    },
    environment: { findMany: async () => [] },
    generatedArtifact: {
      findMany: async ({ where, select }: { where: Row; select?: Row }) =>
        artifacts
          .filter((row) => matchesWhere('generatedArtifact', row, where ?? {}))
          .map((row) => project(row, select)),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = artifacts.filter((row) => matchesWhere('generatedArtifact', row, where ?? {}));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    /*
     * The array form, which is what the refresh writer uses. Awaiting each
     * element is what Prisma does and what makes the writer's `updateMany`
     * calls actually run — a fake that returned the unexecuted promises would
     * report a refresh that never happened.
     */
    $transaction: async (ops: unknown) => {
      if (!Array.isArray(ops)) throw new Error('fake prisma: only the array form is used here');
      return Promise.all(ops as Promise<unknown>[]);
    },
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const { projectsRouter } = await import('./projects.js');
  const app = express();
  app.use(express.json());
  app.use('/projects', projectsRouter);
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

async function push(): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${base}/projects/proj_1/git/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ integrationId: 'int_1', confirm: true }),
  });
  return { status: res.status, body: (await res.json()) as Row };
}

// ─── The reader ──────────────────────────────────────────────────────────────

describe('POST /:projectId/git/push supplies the ownership ledger', () => {
  it('hands the push a reader, so the result is not a create-only sync', async () => {
    const res = await push();

    expect(res.status).toBe(200);
    expect(h.lastPush?.ownershipSupplied).toBe(true);
    expect(res.body.push.ownershipKnown).toBe(true);
    const row = h.audits.find((entry) => entry.action === 'git.push');
    expect(row?.metadata.ownershipKnown).toBe(true);
  });

  /*
   * THE SEAM, AND THE ONE ASSERTION THIS FILE EXISTS FOR.
   *
   * The tree path and the ledger path are DIFFERENT STRINGS and both are real:
   * `tests/checkout/...` is what the exporter writes and `checkout/...` is what
   * the generator chose, stored on `Test.filePath` and recorded by
   * `ledgerRowsFor`. Drop `ledgerPaths` from the reader and this is the test
   * that goes red — the verdict becomes UNRECORDED.
   */
  it('answers QAAI_OWNED for the path the EXPORTER writes, not the one the ledger stores', async () => {
    await push();

    expect(h.lastPush?.tree.has(TREE_PATH)).toBe(true);
    expect(h.lastPush?.tree.has(LEDGER_PATH)).toBe(false);
    expect(h.asked).toContainEqual({ path: TREE_PATH, verdict: 'QAAI_OWNED' });
  });

  it('claims none of the scaffolding it does not own', async () => {
    await push();

    const scaffolding = h.asked.filter((entry) => entry.path !== TREE_PATH);
    expect(scaffolding.length).toBeGreaterThan(0);
    expect(scaffolding.map((entry) => entry.path)).toContain('README.md');
    for (const entry of scaffolding) expect(entry.verdict).toBe('UNRECORDED');
  });

  it("refuses a human's own file through the real gate", async () => {
    artifacts[0]!.ownership = 'HUMAN_EDITED';
    h.branch.set(TREE_PATH, 'a person rewrote this');

    const res = await push();

    expect(res.body.push.refusedCount).toBeGreaterThan(0);
    expect(h.branch.get(TREE_PATH)).toBe('a person rewrote this');
  });
});

// ─── The refresh ─────────────────────────────────────────────────────────────

describe('the ledger refresh the push owes', () => {
  /*
   * Without this the hash recorded for a path stays the digest of the FIRST
   * version QAAI ever generated, and the second update QAAI pushes is refused
   * as BYTES_DIVERGED against bytes QAAI itself wrote.
   */
  it('updates the row keyed by the LEDGER path from a refresh keyed by the TREE path', async () => {
    const res = await push();

    expect(res.body.ledgerRefreshed).toBeGreaterThan(0);
    expect(artifacts[0]!.path).toBe(LEDGER_PATH);
    expect(artifacts[0]!.contentHash).toBe(sha256(SPEC_CODE));
    expect(artifacts[0]!.bytes).toBe(SPEC_CODE.length);
  });

  it('records the new bytes after a regeneration, so the next push is not refused', async () => {
    // The row still holds v1's digest, because `ledgerRowsFor` writes
    // `contentHash` once with `skipDuplicates` and never updates it.
    const v2 = `${SPEC_CODE}// regenerated\n`;
    tests[0]!.code = v2;
    h.branch.set(TREE_PATH, SPEC_CODE);

    const first = await push();
    expect(first.body.push.filesWritten).toBe(first.body.push.fileCount);
    expect(artifacts[0]!.contentHash).toBe(sha256(v2));

    /*
     * Second push of the same bytes: the refreshed hash is what the branch now
     * holds, so the real gate allows the spec instead of calling it a human
     * edit. `refusedCount` is NOT zero and must not be asserted as zero — the
     * scaffolding written by the first push is on the branch and no row claims
     * it, so `README.md`, `.gitignore`, `.env.example`, the manifest and the
     * runner config are all correctly refused from here on. That is the
     * fail-closed half of the same change: QAAI creates a config that is
     * missing and never overwrites one that exists.
     */
    h.asked.length = 0;
    const second = await push();
    expect(second.body.push.filesWritten).toBe(1);
    expect(
      (second.body.push.filesRefused as Row[]).map((entry) => entry.path),
    ).not.toContain(TREE_PATH);
    expect(h.branch.get(TREE_PATH)).toBe(v2);
  });

  /*
   * THE THIRD PUSH, AND THE ONLY SHAPE THAT DISTINGUISHES "REFUSES THAT FILE"
   * FROM "REFUSES EVERYTHING".
   *
   * `refuses a human's own file through the real gate` above flips the ledger's
   * own `ownership` to HUMAN_EDITED, so the refusal comes from the VERDICT. The
   * dangerous case is the one where the ledger still says QAAI_OWNED and the
   * BYTES on the branch have moved underneath it: that refusal comes from the
   * recorded `contentHash`, and it is the arm that was mis-firing on every file
   * before the refresh existed.
   *
   * One test row cannot tell the two apart — with a single file, "refused that
   * file" and "refused everything" are the same assertion. So this runs TWO
   * specs through three pushes: push, human edit on one of them, push again.
   * The edited one must be refused and left exactly as the human left it; the
   * untouched one must still be WRITTEN. A guard that refused the pair would
   * pass every assertion in this file that existed before this one.
   */
  it('refuses only the file a human changed, and still writes the one they did not', async () => {
    const SECOND_LEDGER = 'checkout/refund-an-order.spec.ts';
    const SECOND_TREE = 'tests/checkout/refund-an-order.spec.ts';
    const SECOND_CODE = "import { test } from '@playwright/test';\ntest('refund', async () => {});\n";

    tests.push({
      id: 'test_2',
      orgId: 'org_1',
      projectId: 'proj_1',
      name: 'refund an order',
      type: 'E2E',
      code: SECOND_CODE,
      spec: null,
      filePath: SECOND_LEDGER,
      disabledAt: null,
    });
    artifacts.push({
      id: 'art_2',
      orgId: 'org_1',
      projectId: 'proj_1',
      path: SECOND_LEDGER,
      role: 'SPEC',
      ownership: 'QAAI_OWNED',
      contentHash: sha256(SECOND_CODE),
      imports: [],
      bytes: SECOND_CODE.length,
    });

    // PUSH ONE: both specs are new, both land, both rows are refreshed.
    const first = await push();
    expect(first.status).toBe(200);
    expect(h.branch.get(TREE_PATH)).toBe(SPEC_CODE);
    expect(h.branch.get(SECOND_TREE)).toBe(SECOND_CODE);

    /*
     * PUSH TWO, both regenerated. This middle push is not decoration: it is
     * what makes the THIRD push depend on the refresh having happened twice. A
     * run that pushed once and then went straight to the human edit would pass
     * with the refresh switched off entirely, because the second file's bytes
     * would still be the v1 bytes its unrefreshed row recorded.
     */
    tests[0]!.code = `${SPEC_CODE}// v2\n`;
    tests[1]!.code = `${SECOND_CODE}// v2\n`;
    const second = await push();
    expect(second.status).toBe(200);
    expect(h.branch.get(TREE_PATH)).toBe(`${SPEC_CODE}// v2\n`);
    expect(h.branch.get(SECOND_TREE)).toBe(`${SECOND_CODE}// v2\n`);

    /*
     * A HUMAN EDITS ONE OF THEM ON THE BRANCH. The ledger is untouched, so it
     * still records QAAI_OWNED and the digest of the bytes QAAI wrote.
     */
    const BY_HAND = `${SPEC_CODE}// v2\n// a person tightened this assertion by hand\n`;
    h.branch.set(TREE_PATH, BY_HAND);

    // And QAAI regenerates BOTH again, so both are offered as replacements.
    tests[0]!.code = `${SPEC_CODE}// v3\n`;
    tests[1]!.code = `${SECOND_CODE}// v3\n`;

    // PUSH THREE: one refusal, one write.
    const third = await push();
    expect(third.status).toBe(200);

    const refused = third.body.push.filesRefused as Array<{ path: string; reason: string }>;
    const refusedPaths = refused.map((entry) => entry.path);
    // THE HUMAN'S FILE: refused, with the reason that actually bit, and the
    // bytes they wrote are still the bytes on the branch.
    expect(refusedPaths).toContain(TREE_PATH);
    /*
     * THE REASON, AND IT MUST BE THIS ONE. A refusal with NOT_OURS on it would
     * mean the ledger had lost the row; BYTES_DIVERGED is the arm that says
     * "our row claims this path and the bytes on the branch are not the bytes
     * we recorded writing", which is the only arm that can be true here.
     */
    expect(refused.find((entry) => entry.path === TREE_PATH)?.reason).toBe('BYTES_DIVERGED');
    expect(h.branch.get(TREE_PATH)).toBe(BY_HAND);

    // THE FILE NOBODY TOUCHED: not refused, and actually replaced on the branch.
    expect(refusedPaths).not.toContain(SECOND_TREE);
    expect(h.branch.get(SECOND_TREE)).toBe(`${SECOND_CODE}// v3\n`);
    expect(third.body.push.filesWritten).toBeGreaterThan(0);
  });

  it('counts a written path no row claims rather than reporting it as refreshed', async () => {
    const res = await push();

    // Every scaffolding file is written and unclaimed: README, .gitignore,
    // .env.example, the manifest and the runner config.
    expect(res.body.ledgerUnclaimed).toBeGreaterThan(0);
    expect(res.body.ledgerRefreshed + res.body.ledgerUnclaimed).toBe(
      res.body.push.ledgerRefresh.length,
    );
    const row = h.audits.find((entry) => entry.action === 'git.push');
    expect(row?.metadata.ledgerUnclaimed).toBe(res.body.ledgerUnclaimed);
  });
});
