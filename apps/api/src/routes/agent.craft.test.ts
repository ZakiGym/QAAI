/**
 * The doors for the three tables this round minted and nothing read or wrote.
 *
 * `TestCorrection`, `GeneratedArtifact` and `SuiteChangeProposal` all landed as
 * schema with a comment describing the feature and no code path to it —
 * `check:wiring` flagged every one of them, which is this codebase's signature
 * defect caught by its own ratchet. These tests are about the WIRING, and each
 * is written so that unwiring the thing it covers turns it red.
 *
 * The three properties that carry the weight:
 *
 *   1. A RECORDED CORRECTION FLIPS THE OWNERSHIP LEDGER. That flip is the fact
 *      that makes the next git sync refuse to overwrite a human's edit, and
 *      without it `pushRepo`'s whole guard has nothing to read.
 *   2. EVERY REFUSAL IS NAMED AND COUNTED. `NO_HUMAN_VERSION` is the ordinary
 *      case for a new test and `DIALECT_UNREADABLE` is a problem; summing them
 *      into "skipped" would make the two indistinguishable.
 *   3. APPROVAL IS NOT APPLICATION. `APPLYABLE_STATES` has exactly one `true`
 *      key, and it is APPROVED rather than the producer's own PROPOSED.
 *
 * The Prisma fake HONOURS `select`, because a select-blind fake makes deleting a
 * field from a query undetectable — two defects survived a whole slice behind
 * exactly that.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  db: Record<string, unknown>;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  warnings: Array<{ obj: unknown; msg: string }>;
}

const h = vi.hoisted(
  (): Hoisted => ({
    db: {},
    actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
    audits: [],
    warnings: [],
  }),
);

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://localhost/none',
    ANTHROPIC_API_KEY: '',
  },
  isProd: false,
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (obj: unknown, msg?: string) => {
      h.warnings.push({ obj, msg: msg ?? '' });
    },
    error: () => {},
    fatal: () => {},
  },
  currentRequestId: () => 'req_test',
  setRequestActor: () => {},
  runWithRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
}));

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  return {
    prisma: new Proxy({}, { get: (_t, key: string) => h.db[key] }),
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

vi.mock('../lib/queues.js', () => ({ enqueue: async () => 'job_1' }));
vi.mock('../lib/storage.js', () => ({ storage: {} }));
vi.mock('../lib/events.js', () => ({ publish: () => {}, subscribe: () => () => {} }));
vi.mock('../lib/audit.js', () => ({
  audit: async (entry: Row) => {
    h.audits.push(entry);
  },
}));
vi.mock('../lib/vault.js', () => ({
  open: (valueEnc: string) => valueEnc.replace(/^enc:/, ''),
  seal: (plaintext: string) => ({ valueEnc: `enc:${plaintext}`, keyVersion: 1, hint: 'xxxx' }),
  needsRotation: () => false,
}));

vi.mock('../middleware/auth.js', async () => {
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole: () => (_req: Row, _res: Row, next: () => void) => next(),
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

const express = (await import('express')).default;
const { agentRouter, MAX_CORPUS_SYNC_TESTS } = await import('./agent.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/', agentRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let baseUrl = '';
let server: import('node:http').Server;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

/**
 * A row reduced to the fields a `select` asked for.
 *
 * SELECT-BLIND FAKES ARE WHY THIS EXISTS: a fake that returns the whole row
 * makes deleting a field from a query undetectable, because the assertion
 * downstream still finds the field the real client would not have supplied.
 */
function selected(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return row;
  const out: Row = {};
  for (const [key, wanted] of Object.entries(select)) if (wanted) out[key] = row[key];
  return out;
}

/** Shallow `where` matching, enough for the equality-and-`not` clauses here. */
function matches(row: Row, where: Row): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue;
    const actual = row[key];
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('not' in expected) {
        const not = (expected as Row).not;
        if (not !== null && typeof not === 'object' && 'startsWith' in not) {
          if (String(actual).startsWith(String((not as Row).startsWith))) return false;
          continue;
        }
        if (not === null ? actual === null : actual === not) return false;
        continue;
      }
      if ('some' in expected) continue;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

// ─── The world ───────────────────────────────────────────────────────────────

/** The generator's version of a test, and the reviewer's rewrite of its locator. */
const OURS = `import { test, expect } from '@playwright/test';

test('checkout shows the total', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.locator('div.sc-x7f2 > span:nth-child(3)')).toHaveText('$42.00');
});
`;

const THEIRS = `import { test, expect } from '@playwright/test';

test('checkout shows the total', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByTestId('order-total')).toHaveText('$42.00');
});
`;

let tests: Row[] = [];
let versions: Row[] = [];
let corrections: Row[] = [];
let artifacts: Row[] = [];
let proposals: Row[] = [];
let artifactUpdates: Row[] = [];

beforeEach(() => {
  h.audits = [];
  h.warnings = [];
  artifactUpdates = [];
  tests = [
    {
      id: 'test_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      name: 'checkout shows the total',
      filePath: 'tests/checkout.spec.ts',
      feature: 'checkout',
      type: 'E2E',
      priority: 'IMPORTANT',
      tags: [],
      code: THEIRS,
      spec: null,
      flakeRate: 0,
      quarantined: false,
      consecutiveFailures: 0,
      disabledAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-02T00:00:00Z'),
    },
  ];
  versions = [
    { id: 'ver_1', testId: 'test_1', version: 1, code: OURS, source: 'GENERATOR' },
    { id: 'ver_2', testId: 'test_1', version: 2, code: THEIRS, source: 'HUMAN' },
  ];
  corrections = [];
  artifacts = [
    {
      path: 'tests/checkout.spec.ts',
      projectId: 'proj_1',
      role: 'SPEC',
      ownership: 'QAAI_OWNED',
      testId: 'test_1',
      contentHash: 'ours',
      bytes: OURS.length,
      imports: [],
      humanEditedAt: null,
      firstWrittenAt: new Date('2026-10-01T00:00:00Z'),
      lastWrittenAt: new Date('2026-10-01T00:00:00Z'),
    },
  ];
  proposals = [];

  h.db = {
    project: {
      findUnique: async ({ select }: { select?: Record<string, boolean> }) =>
        selected(
          {
            id: 'proj_1',
            primaryLanguage: 'TYPESCRIPT',
            primaryFramework: 'PLAYWRIGHT',
          },
          select,
        ),
    },
    test: {
      count: async ({ where }: { where: Row }) => tests.filter((row) => matches(row, where ?? {})).length,
      findMany: async ({
        where,
        take,
        select,
      }: {
        where: Row;
        take?: number;
        select?: Record<string, boolean>;
      }) =>
        tests
          .filter((row) => matches(row, where ?? {}))
          .slice(0, take ?? undefined)
          .map((row) => selected(row, select)),
    },
    testVersion: {
      findMany: async ({
        where,
        take,
        select,
      }: {
        where: Row;
        take?: number;
        select?: Record<string, boolean>;
      }) =>
        versions
          .filter((row) => matches(row, where ?? {}))
          .slice(0, take ?? undefined)
          .map((row) => selected(row, select)),
    },
    testCorrection: {
      findMany: async ({
        where,
        take,
        select,
      }: {
        where: Row;
        take?: number;
        select?: Record<string, boolean>;
      }) =>
        corrections
          .filter((row) => matches(row, where ?? {}))
          .slice(0, take ?? undefined)
          .map((row) => selected(row, select)),
      findFirst: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
        const found = corrections.find((row) => matches(row, where ?? {}));
        return found ? selected(found, select) : null;
      },
      create: async ({ data }: { data: Row }) => {
        corrections.push({ id: `corr_${corrections.length + 1}`, createdAt: new Date(), ...data });
        return corrections[corrections.length - 1];
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const found = corrections.find((row) => row.id === where.id)!;
        Object.assign(found, data);
        return found;
      },
    },
    generatedArtifact: {
      findMany: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) =>
        artifacts.filter((row) => matches(row, where ?? {})).map((row) => selected(row, select)),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        artifactUpdates.push({ where, data });
        const hit = artifacts.filter((row) => matches(row, where ?? {}));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    suiteChangeProposal: {
      findMany: async ({
        where,
        take,
        select,
      }: {
        where: Row;
        take?: number;
        select?: Record<string, boolean>;
      }) =>
        proposals
          .filter((row) => matches(row, where ?? {}))
          .slice(0, take ?? undefined)
          .map((row) => selected(row, select)),
      findUnique: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
        const found = proposals.find((row) => row.id === where.id);
        return found ? selected(found, select) : null;
      },
      create: async ({ data, select }: { data: Row; select?: Record<string, boolean> }) => {
        const row = { id: `prop_${proposals.length + 1}`, createdAt: new Date(), ...data };
        proposals.push(row);
        return selected(row, select);
      },
      update: async ({ where, data, select }: { where: Row; data: Row; select?: Record<string, boolean> }) => {
        const found = proposals.find((row) => row.id === where.id)!;
        Object.assign(found, data);
        return selected(found, select);
      },
    },
    flowMap: { findFirst: async () => null },
  };
});

// ─── The correction corpus ───────────────────────────────────────────────────

describe('POST /projects/:projectId/corrections/sync', () => {
  it('records the reviewer rewriting our locator', async () => {
    const res = await call('/projects/proj_1/corrections/sync', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(1);
    expect(corrections).toHaveLength(1);
    const row = corrections[0]!;
    expect(row.testId).toBe('test_1');
    expect(row.generatedVersion).toBe(1);
    expect(row.humanVersion).toBe(2);
    expect(row.kinds).toContain('LOCATOR_CHANGED');
    // The two version ids the Prisma model requires and the strict schema does
    // not declare. A row without them cannot be stored at all.
    expect(row.generatedVersionId).toBe('ver_1');
    expect(row.humanVersionId).toBe('ver_2');
  });

  /*
   * THE PROPERTY THE WHOLE ROUND TURNS ON. A recorded correction IS the evidence
   * that a human took our file over, and HUMAN_EDITED is the fact that makes the
   * next git sync refuse to overwrite their edit. Without this flip,
   * `pushRepo`'s guard reads QAAI_OWNED and replaces their work.
   */
  it('flips the ownership ledger to HUMAN_EDITED', async () => {
    const res = await call('/projects/proj_1/corrections/sync', { method: 'POST' });

    expect(res.body.ownershipFlipped).toEqual(['tests/checkout.spec.ts']);
    expect(artifacts[0]!.ownership).toBe('HUMAN_EDITED');
    expect(artifacts[0]!.humanEditedAt).toBeInstanceOf(Date);
    expect(String(artifacts[0]!.humanEditedHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  /*
   * A ONE-WAY TRANSITION. The ownership is in the WHERE clause, so a row that
   * already says HUMAN_AUTHORED is not rewritten to say QAAI once owned it.
   */
  it('only ever flips a row that says QAAI owns the file', async () => {
    await call('/projects/proj_1/corrections/sync', { method: 'POST' });
    expect(artifactUpdates[0]!.where).toMatchObject({ ownership: 'QAAI_OWNED' });
  });

  /*
   * "Nobody has reviewed this yet" and "we could not read this" are different
   * sentences, and summing them into "skipped" would make a corpus of zero look
   * the same whether the project is new or the classifier is broken.
   */
  it('names each refusal rather than summing them into "skipped"', async () => {
    versions = [{ id: 'ver_1', testId: 'test_1', version: 1, code: OURS, source: 'GENERATOR' }];
    const res = await call('/projects/proj_1/corrections/sync', { method: 'POST' });

    expect(res.body.recorded).toBe(0);
    expect(res.body.refusals).toEqual({ NO_HUMAN_VERSION: 1 });
    // And nothing was claimed about ownership.
    expect(res.body.ownershipFlipped).toEqual([]);
    expect(artifacts[0]!.ownership).toBe('QAAI_OWNED');
  });

  it('refuses a reviewer who saved without changing a byte, by name', async () => {
    versions = [
      { id: 'ver_1', testId: 'test_1', version: 1, code: OURS, source: 'GENERATOR' },
      { id: 'ver_2', testId: 'test_1', version: 2, code: OURS, source: 'HUMAN' },
    ];
    const res = await call('/projects/proj_1/corrections/sync', { method: 'POST' });

    expect(res.body.refusals).toEqual({ NO_CHANGE: 1 });
  });

  /*
   * Re-running the classifier over the same pair must UPDATE rather than
   * accumulate: every count the corpus reports would otherwise include our own
   * re-runs, and the trend line would be an artefact of how often somebody
   * pressed the button.
   */
  it('is idempotent, and says what it left alone', async () => {
    await call('/projects/proj_1/corrections/sync', { method: 'POST' });
    const again = await call('/projects/proj_1/corrections/sync', { method: 'POST' });

    expect(corrections).toHaveLength(1);
    expect(again.body.recorded).toBe(0);
    expect(again.body.unchanged).toBe(1);
  });

  it('discloses the window as a count when the test cap bites', async () => {
    tests = Array.from({ length: MAX_CORPUS_SYNC_TESTS + 3 }, (_unused, i) => ({
      ...tests[0]!,
      id: `test_${i}`,
      filePath: `tests/t${i}.spec.ts`,
    }));
    versions = [];
    const res = await call('/projects/proj_1/corrections/sync', { method: 'POST' });

    expect(res.body.testsExamined).toBe(MAX_CORPUS_SYNC_TESTS);
    /*
     * EXACTLY three, not "at least one". A `take: cap + 1` read can only
     * establish that more exist, so the handler asks for a count — and this is
     * the assertion that keeps it asking: with the `cap + 1` trick this reads 1
     * over a project with five thousand.
     */
    expect(res.body.testsNotExamined).toBe(3);
  });

  it('404s for a project that does not exist', async () => {
    h.db = { ...h.db, project: { findUnique: async () => null } };
    const res = await call('/projects/nope/corrections/sync', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('GET /projects/:projectId/corrections', () => {
  /*
   * An empty corpus must read as "nobody has looked", never as a clean suite.
   * `INSUFFICIENT_DATA` is the honest state, and the counts stay underneath it
   * because counts are facts.
   */
  it('reports INSUFFICIENT_DATA over an empty corpus, with the counts underneath', async () => {
    const res = await call('/projects/proj_1/corrections');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('INSUFFICIENT_DATA');
    expect(res.body.corpusSize).toBe(0);
    expect(res.body.patterns).toEqual([]);
    expect(res.body.byKind).toBeDefined();
  });

  it('queries inside one project, with both ids and no symbol on the clause', async () => {
    let seen: Row | null = null;
    h.db = {
      ...h.db,
      testCorrection: {
        ...(h.db.testCorrection as Row),
        findMany: async ({ where }: { where: Row }) => {
          seen = where;
          return [];
        },
      },
    };
    await call('/projects/proj_1/corrections');

    expect(seen).toEqual({ orgId: 'org_1', projectId: 'proj_1' });
    expect(Object.getOwnPropertySymbols(seen as unknown as object)).toEqual([]);
  });

  /*
   * The BRIEFING is prompt material containing fenced quotes of customer
   * source. A screen that rendered it would be showing QAAI's instructions to
   * itself as though they were advice to the reader.
   */
  it('never returns the prompt briefing', async () => {
    const res = await call('/projects/proj_1/corrections');
    expect(JSON.stringify(res.body)).not.toContain('QAAI-UNTRUSTED-DATA');
    expect(res.body.briefing).toBeUndefined();
  });
});

// ─── The ownership ledger ────────────────────────────────────────────────────

describe('GET /projects/:projectId/artifacts', () => {
  it('reports the ledger and the UPPER BOUND on how much of it QAAI may write', async () => {
    const res = await call('/projects/proj_1/artifacts');

    expect(res.status).toBe(200);
    expect(res.body.artifacts).toHaveLength(1);
    expect(res.body.counts).toEqual({ QAAI_OWNED: 1, HUMAN_EDITED: 0, HUMAN_AUTHORED: 0 });
    /*
     * `writableIfUnchanged` and not `writable`, because this endpoint has not
     * fetched the branch: the verdict permits the write and the sync's own gate
     * also requires the bytes there to hash to `contentHash`. The field name has
     * to carry that, or the number reads as a measurement of the repository.
     */
    expect(res.body.writableIfUnchanged).toBe(1);
    expect(res.body.writable).toBeUndefined();
    // And the sentence a reader is shown says so too, rather than leaving the
    // qualification in a type comment nobody renders.
    expect(res.body.why).toMatch(/contentHash/);
  });

  it('counts a human-edited file as one QAAI may not write', async () => {
    artifacts[0]!.ownership = 'HUMAN_EDITED';
    const res = await call('/projects/proj_1/artifacts');

    expect(res.body.counts).toEqual({ QAAI_OWNED: 0, HUMAN_EDITED: 1, HUMAN_AUTHORED: 0 });
    expect(res.body.writableIfUnchanged).toBe(0);
  });

  /*
   * No file bodies. A hash makes "the bytes on disk are still the bytes we
   * wrote" decidable; a copy of the customer's suite in our tables would be a
   * liability with no consumer.
   */
  it('returns no file contents', async () => {
    const res = await call('/projects/proj_1/artifacts');
    const row = res.body.artifacts[0] as Row;
    expect(row.contentHash).toBe('ours');
    expect(row.content).toBeUndefined();
    expect(row.code).toBeUndefined();
  });

  it('says that an absent row is not a permission', async () => {
    const res = await call('/projects/proj_1/artifacts');
    expect(res.body.why).toMatch(/UNRECORDED, which is NOT a permission/);
  });
});

// ─── Suite-change proposals ──────────────────────────────────────────────────

describe('POST /projects/:projectId/suite-changes', () => {
  it('proposes nothing over a suite with nothing wrong, and says what it read', async () => {
    const res = await call('/projects/proj_1/suite-changes', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(res.body.proposed).toEqual([]);
    expect(res.body.testsRead).toBe(1);
    /*
     * FALSE, and that is correct rather than a bug: a single test carries too
     * few behaviour tokens to be compared with anything, so it was never
     * eligible and the scan is honestly incomplete. The value is reported so an
     * empty proposal list is distinguishable from a scan that never ran — which
     * is exactly the substitution `refactorFeed` refuses to make.
     */
    expect(res.body.duplicateScanComplete).toBe(false);
  });

  /*
   * Fixture extraction and assertion strengthening are UNAVAILABLE here rather
   * than unimplemented, and the reasons are facts about this request: an
   * extraction invents a path and needs a listing of the customer's tree to
   * prove nothing is there (reverting a creation DELETES the file), and a
   * strengthening has an unknown verdict until it has actually been run.
   */
  it('says why it cannot offer an extraction or a strengthening', async () => {
    const res = await call('/projects/proj_1/suite-changes', { method: 'POST' });

    expect(res.body.extractionUnavailable).toMatch(/reverting a creation DELETES the file/);
    expect(res.body.needsVerification).toBeGreaterThanOrEqual(0);
  });

  it('declines a differing duplicate cluster by name rather than merging it', async () => {
    /*
     * Two tests over the same route where one asserts something the other does
     * not. `refactorFeed` declines it, and the response says so — that member
     * is frequently the only test that catches a regression.
     */
    tests = [
      { ...tests[0]!, id: 'test_a', filePath: 'tests/a.spec.ts', code: OURS },
      {
        ...tests[0]!,
        id: 'test_b',
        filePath: 'tests/a.spec.ts',
        code: `${OURS}\ntest('and the tax line', async ({ page }) => {\n  await expect(page.getByTestId('tax')).toHaveText('$3.50');\n});\n`,
      },
    ];
    const res = await call('/projects/proj_1/suite-changes', { method: 'POST' });

    expect(res.body.proposed).toEqual([]);
    // Either the feed declined it or the engine refused it; both are reported
    // with a reason, and neither silently merges.
    const reasons = JSON.stringify([res.body.declined, res.body.refused]);
    expect(reasons.length).toBeGreaterThan(5);
  });

  it('404s for a project that does not exist', async () => {
    h.db = { ...h.db, project: { findUnique: async () => null } };
    const res = await call('/projects/nope/suite-changes', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('GET /projects/:projectId/suite-changes', () => {
  beforeEach(() => {
    proposals = [
      {
        id: 'prop_1',
        orgId: 'org_1',
        projectId: 'proj_1',
        kind: 'MERGE_NEAR_DUPLICATES',
        state: 'PROPOSED',
        title: 'Merge two tests of the same journey',
        rationale: 'They walk the same routes and make the same assertions.',
        before: { dialect: 'JS_EXPECT', artifacts: [] },
        after: { dialect: 'JS_EXPECT', artifacts: [] },
        paths: ['tests/a.spec.ts'],
        dependentTestIds: [],
        dependentPaths: [],
        decidedBy: null,
        decidedAt: null,
        appliedAt: null,
        revertedAt: null,
        blockedReason: null,
        createdAt: new Date('2026-10-20T00:00:00Z'),
      },
    ];
  });

  /*
   * `applyable` is read from `APPLYABLE_STATES`, whose only `true` key is
   * APPROVED — NOT the producer's own PROPOSED. A screen that computed this
   * itself would be a second opinion about whether a write is permitted.
   */
  it('reports a PROPOSED row as not yet applyable', async () => {
    const res = await call('/projects/proj_1/suite-changes');

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0].applyable).toBe(false);
    /*
     * A merge DOES alter what the suite checks, so it carries the higher review
     * bar. Read from `CHANGE_ALTERS_BEHAVIOUR` rather than restated, so this
     * screen and the apply path cannot disagree about it.
     */
    expect(res.body.proposals[0].altersBehaviour).toBe(true);
  });

  it('says that nothing here deletes a test', async () => {
    const res = await call('/projects/proj_1/suite-changes');
    expect(res.body.why).toMatch(/Nothing here deletes a test/);
  });
});

describe('POST /suite-changes/:proposalId/decide', () => {
  beforeEach(() => {
    proposals = [
      {
        id: 'prop_1',
        projectId: 'proj_1',
        state: 'PROPOSED',
        kind: 'MERGE_NEAR_DUPLICATES',
        paths: ['tests/a.spec.ts'],
      },
    ];
  });

  it('approves without applying anything', async () => {
    const res = await call('/suite-changes/prop_1/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'APPROVED' }),
    });

    expect(res.status).toBe(200);
    expect(res.body.proposal.state).toBe('APPROVED');
    expect(res.body.applyable).toBe(true);
    // Approval is a decision; applying is a write. Nothing was applied.
    expect(proposals[0]!.appliedAt).toBeUndefined();
    expect(h.audits.map((entry) => entry.action)).toContain('suite-changes.decide');
  });

  it('records a rejection as a decision rather than deleting the row', async () => {
    const res = await call('/suite-changes/prop_1/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'REJECTED' }),
    });

    expect(res.body.proposal.state).toBe('REJECTED');
    expect(res.body.applyable).toBe(false);
    expect(proposals).toHaveLength(1);
  });

  /*
   * A decided proposal is kept rather than reopened: the trail of what was
   * approved and what happened next is the only evidence that refactoring is
   * worth offering at all.
   */
  it('refuses to re-decide a decided proposal', async () => {
    proposals[0]!.state = 'APPROVED';
    const res = await call('/suite-changes/prop_1/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'REJECTED' }),
    });

    expect(res.status).toBe(409);
  });

  it('refuses a decision that is neither approval nor rejection', async () => {
    const res = await call('/suite-changes/prop_1/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'APPLIED' }),
    });

    expect(res.status).toBe(400);
  });

  it('404s for a proposal that does not exist', async () => {
    const res = await call('/suite-changes/nope/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'APPROVED' }),
    });
    expect(res.status).toBe(404);
  });
});
