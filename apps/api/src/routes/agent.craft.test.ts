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
import { createHash } from 'node:crypto';

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
const { MAX_REFACTOR_CANDIDATES } = await import('@qaai/agent');
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

// ─── The other two operations of the refactor engine ────────────────────────

/**
 * Three specs in one directory that walk the same setup and then check
 * different things.
 *
 * ONE TEST PER FILE, which is how this product's rows actually look and why
 * `findSharedSetup` groups by DIRECTORY: a row's `code` is its whole file, so
 * two rows at one path share every site the analysis records, and the unit of
 * extraction is one block in one file with several of them in a directory.
 */
function sharedSetupSpec(title: string, assertion: string): string {
  return `import { test, expect } from '@playwright/test';

test('${title}', async ({ page }) => {
  await page.goto('/checkout');
  await page.fill('#coupon', 'SAVE10');
  await page.click('#apply');
  ${assertion}
});
`;
}

const TOTAL_SPEC = sharedSetupSpec(
  'shows the total',
  "await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
);
const DISCOUNT_SPEC = sharedSetupSpec(
  'shows the discount line',
  "await expect(page.getByTestId('discount')).toHaveText('-$4.20');",
);
const TAX_SPEC = sharedSetupSpec(
  'shows the tax line',
  "await expect(page.getByTestId('tax')).toHaveText('$3.50');",
);

/** A test whose only assertion is that an element exists. EXISTENCE_ONLY. */
const WEAK_SPEC = `import { test, expect } from '@playwright/test';

test('the pay button is there', async ({ page }) => {
  await page.goto('/pay');
  const btn = page.getByRole('button', { name: 'Pay' });
  await expect(btn).toBeTruthy();
  await expect(page.getByTestId('error')).toBeTruthy();
});
`;

const SETUP_FILES = [
  { id: 'test_total', name: 'shows the total', filePath: 'tests/checkout/total.spec.ts', code: TOTAL_SPEC },
  { id: 'test_discount', name: 'shows the discount line', filePath: 'tests/checkout/discount.spec.ts', code: DISCOUNT_SPEC },
  { id: 'test_tax', name: 'shows the tax line', filePath: 'tests/checkout/tax.spec.ts', code: TAX_SPEC },
] as const;

/** The helper `extractFixture` computes for this directory. Asserted, not guessed. */
const HELPER_PATH = 'tests/checkout/checkout.qaai-setup.ts';

function row(over: Row): Row {
  return {
    orgId: 'org_1',
    projectId: 'proj_1',
    feature: 'checkout',
    type: 'E2E',
    priority: 'IMPORTANT',
    tags: [],
    spec: null,
    flakeRate: 0,
    quarantined: false,
    consecutiveFailures: 0,
    disabledAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    ...over,
  };
}

/** The ledger row that says QAAI owns a spec. Absent, every rewrite is refused. */
function owned(filePath: string, code: string): Row {
  return {
    path: filePath,
    projectId: 'proj_1',
    role: 'SPEC',
    ownership: 'QAAI_OWNED',
    contentHash: createHash('sha256').update(code).digest('hex'),
    bytes: code.length,
    imports: [],
    humanEditedAt: null,
    firstWrittenAt: new Date('2026-10-01T00:00:00Z'),
    lastWrittenAt: new Date('2026-10-01T00:00:00Z'),
  };
}

function useSharedSetupSuite(): void {
  tests = SETUP_FILES.map((file) => row({ ...file }));
  artifacts = SETUP_FILES.map((file) => owned(file.filePath, file.code));
}

function useWeakSuite(): void {
  tests = [
    row({
      id: 'test_weak',
      name: 'the pay button is there',
      filePath: 'tests/pay/pay.spec.ts',
      code: WEAK_SPEC,
      feature: 'pay',
      priority: 'CRITICAL',
    }),
  ];
  artifacts = [owned('tests/pay/pay.spec.ts', WEAK_SPEC)];
}

describe('POST /projects/:projectId/suite-changes/fixtures', () => {
  beforeEach(() => {
    useSharedSetupSuite();
  });

  /*
   * THE WIRING, AND IT IS THE WHOLE POINT. Before this round `extractFixture`
   * had no production caller AND `RefactorFeed` had no `fixtures` member, so
   * there was no cluster to hand it even if something had called it. This test
   * runs the real producer and the real engine through the real route and
   * requires a stored row: unwire either half and it goes red.
   */
  it('turns a shared setup block into a stored proposal', async () => {
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: SETUP_FILES.map((file) => file.filePath) }),
    });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toBe(1);
    expect(res.body.proposed).toHaveLength(1);
    const proposed = res.body.proposed[0] as Row;
    expect(proposed.kind).toBe('EXTRACT_FIXTURE');
    expect(proposed.state).toBe('PROPOSED');
    // The helper the engine computed, in the one directory every member shares.
    expect(proposed.paths).toContain(HELPER_PATH);
    for (const file of SETUP_FILES) expect(proposed.paths).toContain(file.filePath);
    expect(h.audits.map((entry) => entry.action)).toContain('suite-changes.extract-fixture');
  });

  /*
   * THE PRODUCER AND THE ENGINE AGREE ABOUT WHAT A DIRECTORY IS. `directoryOf`
   * in suite-health.ts and `dirOf` in refactor.ts are separate private
   * functions, and a disagreement would mean every cluster is excluded
   * DIFFERENT_DIRECTORY. The proposal above exists only if they agree, and this
   * asserts the consequence rather than the comment.
   */
  it('proposes nothing when the members are in different directories', async () => {
    tests = [
      row({ ...SETUP_FILES[0] }),
      row({ ...SETUP_FILES[1], filePath: 'tests/basket/discount.spec.ts' }),
      row({ ...SETUP_FILES[2], filePath: 'tests/tax/tax.spec.ts' }),
    ];
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: tests.map((test) => test.filePath) }),
    });

    expect(res.body.candidates).toBe(0);
    expect(res.body.proposed).toEqual([]);
  });

  /*
   * NULL IS NOT EMPTY. With no listing the engine refuses TREE_UNKNOWN, and the
   * response says so rather than reporting zero candidates — a refusal and a
   * suite with nothing to extract are different facts.
   */
  it('refuses every extraction, by name, when nobody said what is in the tree', async () => {
    const res = await call('/projects/proj_1/suite-changes/fixtures', { method: 'POST' });

    expect(res.body.proposed).toEqual([]);
    expect(res.body.candidates).toBe(1);
    expect(res.body.treeListing).toBeNull();
    expect(JSON.stringify(res.body.refused)).toContain('TREE_UNKNOWN');
    expect(res.body.why).toMatch(/lets a revert delete it/);
  });

  /*
   * AN EMPTY LISTING IS THE DANGEROUS CASE AND IT IS CAUGHT. `[]` would make
   * every path look free, and the extraction would then record "nothing was
   * here" for a helper path nobody checked. A tree holding these tests cannot
   * be a tree that does not hold their files, so the listing is refused as not
   * being of this tree.
   */
  it('refuses a listing that cannot see the specs it is supposed to contain', async () => {
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: [] }),
    });

    expect(res.body.proposed).toEqual([]);
    expect(JSON.stringify(res.body.refused)).toContain('TREE_LISTING_NOT_OF_THIS_TREE');
    expect(JSON.stringify(res.body.refused)).toContain('missing 3 of the 3 file(s)');
  });

  /*
   * A FILE ALREADY AT THE HELPER PATH IS NOT OVERWRITTEN. This is the refusal
   * the listing exists for, and it comes from the engine rather than this
   * handler.
   */
  it('refuses to write over a file already at the helper path', async () => {
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({
        treeListing: [...SETUP_FILES.map((file) => file.filePath), HELPER_PATH],
      }),
    });

    expect(res.body.proposed).toEqual([]);
    expect(JSON.stringify(res.body.refused)).toContain('PATH_OCCUPIED');
  });

  /*
   * THE UNION IS DISCLOSED AS A COUNT. QAAI adds every path its own rows prove
   * is occupied, which can only cause more refusals — and a caller needs to
   * know its listing was not the whole input.
   */
  it('says how many paths it added from its own records', async () => {
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: SETUP_FILES.map((file) => file.filePath) }),
    });

    expect(res.body.treeListing.pathsClaimed).toBe(3);
    /*
     * ZERO here, and that is a measurement: the ledger and the test rows name
     * exactly the three files the caller already listed. The field matters when
     * they do not — see the next test.
     */
    expect(res.body.treeListing.pathsAddedFromOurRecords).toBe(0);
    expect(res.body.why).toMatch(/QAAI did not list your tree itself/);
  });

  it('adds a path our ledger knows about and the listing did not mention', async () => {
    artifacts = [...artifacts, owned('tests/checkout/old-helper.ts', 'export const x = 1;')];
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: SETUP_FILES.map((file) => file.filePath) }),
    });

    expect(res.body.treeListing.pathsAddedFromOurRecords).toBe(1);
  });

  /*
   * A CLUSTER THAT IS REALLY A DUPLICATE GOES BACK TO THE MERGE. Three specs
   * with identical setup AND identical assertions are near-duplicates;
   * extracting their setup would tidy tests that should have been one and leave
   * the duplication in place.
   */
  it('declines a cluster whose members assert the same thing, naming the merge', async () => {
    const identical = "await expect(page.getByTestId('order-total')).toHaveText('$42.00');";
    tests = SETUP_FILES.map((file, index) =>
      row({
        ...file,
        name: `shows the total ${index}`,
        code: sharedSetupSpec(`shows the total ${index}`, identical),
      }),
    );
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: tests.map((test) => test.filePath) }),
    });

    expect(res.body.proposed).toEqual([]);
    expect(res.body.candidates).toBe(0);
    expect(JSON.stringify(res.body.declined)).toContain('MERGE_NEAR_DUPLICATES is the operation');
  });

  /*
   * NO SETUP IS NOT SHARED SETUP. `setupBlockOf` refuses an empty block as
   * NO_SETUP_BLOCK, so clustering tests whose first statement IS the assertion
   * would produce a candidate the engine is guaranteed to exclude — a proposal
   * pass that reports work it could never do.
   */
  it('does not cluster tests that have no setup before their first assertion', async () => {
    const assertionFirst = (title: string, id: string): string =>
      `import { test, expect } from '@playwright/test';

test('${title}', async ({ page }) => {
  await expect(page.getByTestId('${id}')).toHaveText('1');
  await page.goto('/after');
});
`;
    tests = [
      row({ id: 'test_a', name: 'a', filePath: 'tests/none/a.spec.ts', code: assertionFirst('a', 'x') }),
      row({ id: 'test_b', name: 'b', filePath: 'tests/none/b.spec.ts', code: assertionFirst('b', 'y') }),
    ];
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: tests.map((test) => test.filePath) }),
    });

    expect(res.body.setupClustersFound).toBe(0);
    expect(res.body.proposed).toEqual([]);
  });

  /*
   * NO ASSERTION MEANS NO BOUNDARY. Where the setup ENDS is not knowable, which
   * is the exclusion `extractFixture` makes by the name NO_ASSERTION_BOUNDARY.
   * A test with no assertion is already a HIGH weak-assertion finding; it is
   * not also a fixture candidate.
   */
  it('does not cluster tests that make no assertion at all', async () => {
    const noAssertion = (title: string): string =>
      `import { test } from '@playwright/test';

test('${title}', async ({ page }) => {
  await page.goto('/checkout');
  await page.click('#apply');
});
`;
    tests = [
      row({ id: 'test_a', name: 'a', filePath: 'tests/na/a.spec.ts', code: noAssertion('a') }),
      row({ id: 'test_b', name: 'b', filePath: 'tests/na/b.spec.ts', code: noAssertion('b') }),
    ];
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: tests.map((test) => test.filePath) }),
    });

    expect(res.body.setupClustersFound).toBe(0);
    expect(res.body.proposed).toEqual([]);
  });

  /*
   * BOTH CAPS THAT BIT, AS COUNTS, AND EACH ONE THE REASON THAT ACTUALLY BIT.
   *
   * 101 directories, each with two specs sharing a setup step. Two different
   * caps fire and they are reported separately because they have different
   * fixes: the report's payload slice (`MAX_REPORTED_CLUSTERS`, 100) and the
   * feed's candidate cap (`MAX_REFACTOR_CANDIDATES`, 20). `setupClustersFound`
   * is the TRUE count and not the length of the sliced list, which is the
   * substitution a reader cannot detect.
   */
  it('discloses the payload slice and the candidate cap as separate counts', async () => {
    const spec = (dir: number, title: string, target: string): string =>
      `import { test, expect } from '@playwright/test';

test('${title}', async ({ page }) => {
  await page.goto('/d${dir}');
  await expect(page.getByTestId('${target}')).toHaveText('1');
});
`;
    tests = [];
    for (let dir = 0; dir < 101; dir += 1) {
      tests.push(
        row({ id: `t${dir}a`, name: `d${dir} a`, filePath: `tests/d${dir}/a.spec.ts`, code: spec(dir, `d${dir} a`, 'alpha') }),
        row({ id: `t${dir}b`, name: `d${dir} b`, filePath: `tests/d${dir}/b.spec.ts`, code: spec(dir, `d${dir} b`, 'beta') }),
      );
    }
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: tests.map((test) => test.filePath) }),
    });

    // The TRUE count, not the 100 the payload carries.
    expect(res.body.setupClustersFound).toBe(101);
    expect(res.body.omitted.setupClustersNotListed).toBe(1);
    // And the candidate cap, with its own number and its own limit beside it.
    expect(res.body.candidates).toBe(MAX_REFACTOR_CANDIDATES);
    expect(res.body.omitted.candidates).toBe(80);
    expect(res.body.omitted.candidateCap).toBe(MAX_REFACTOR_CANDIDATES);
  });

  /*
   * THE SAME STEPS IN A DIFFERENT ORDER ARE NOT THE SAME SETUP.
   *
   * `extractBehavior` records every navigation before every action regardless
   * of where they are in the file, so the token list is sorted BY LINE back
   * into source order before it becomes the grouping key. Without that, these
   * two specs key identically, get clustered, and the engine then excludes one
   * as SETUP_NOT_IDENTICAL — which reads to a human as the engine being broken
   * rather than as the cluster being wrong.
   */
  it('does not cluster two tests that run the same steps in a different order', async () => {
    const couponFirst = `import { test, expect } from '@playwright/test';

test('coupon then page', async ({ page }) => {
  await page.fill('#coupon', 'SAVE10');
  await page.goto('/checkout');
  await expect(page.getByTestId('order-total')).toHaveText('$42.00');
});
`;
    const pageFirst = `import { test, expect } from '@playwright/test';

test('page then coupon', async ({ page }) => {
  await page.goto('/checkout');
  await page.fill('#coupon', 'SAVE10');
  await expect(page.getByTestId('discount')).toHaveText('-$4.20');
});
`;
    tests = [
      row({ id: 'test_a', name: 'coupon then page', filePath: 'tests/checkout/a.spec.ts', code: couponFirst }),
      row({ id: 'test_b', name: 'page then coupon', filePath: 'tests/checkout/b.spec.ts', code: pageFirst }),
    ];
    artifacts = [
      owned('tests/checkout/a.spec.ts', couponFirst),
      owned('tests/checkout/b.spec.ts', pageFirst),
    ];
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({
        treeListing: ['tests/checkout/a.spec.ts', 'tests/checkout/b.spec.ts'],
      }),
    });

    expect(res.body.candidates).toBe(0);
    expect(res.body.proposed).toEqual([]);
    expect(res.body.setupClustersFound).toBe(0);
  });

  /*
   * SET EQUALITY, BOTH DIRECTIONS. A member whose assertions are a SUBSET of
   * the first member's is NOT asserting the same thing, and this is the case a
   * one-way `every` reports as identical — which would decline the cluster as a
   * near-duplicate and refuse the extraction that should have been offered.
   *
   * The mutant this exists for: drop `length === size` from
   * `assertionsIdentical` in findSharedSetup. 46 tests stayed green without
   * this one, which is lesson D of this codebase — a presence record and a
   * run-time check are not interchangeable, and a comparison needs the case
   * that distinguishes them.
   */
  it('offers an extraction when one member asserts a SUBSET of another’s claims', async () => {
    const both = sharedSetupSpec(
      'shows the total and the discount',
      "await expect(page.getByTestId('order-total')).toHaveText('$42.00');\n" +
        "  await expect(page.getByTestId('discount')).toHaveText('-$4.20');",
    );
    const one = sharedSetupSpec(
      'shows the total',
      "await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
    );
    tests = [
      row({
        id: 'test_both',
        name: 'shows the total and the discount',
        filePath: 'tests/checkout/both.spec.ts',
        code: both,
      }),
      row({
        id: 'test_one',
        name: 'shows the total',
        filePath: 'tests/checkout/total.spec.ts',
        code: one,
      }),
    ];
    artifacts = [
      owned('tests/checkout/both.spec.ts', both),
      owned('tests/checkout/total.spec.ts', one),
    ];
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({
        treeListing: ['tests/checkout/both.spec.ts', 'tests/checkout/total.spec.ts'],
      }),
    });

    expect(res.body.candidates).toBe(1);
    expect(res.body.proposed).toHaveLength(1);
    // And it was NOT sent back to the merge, which is what the subset would do.
    expect(JSON.stringify(res.body.declined)).not.toContain('MERGE_NEAR_DUPLICATES is the operation');
  });

  /*
   * A TEST WHOSE SOURCE WAS NOT READ COMPLETELY IS NOT IN THE CLUSTER AT ALL.
   * Rule FOUR, applied at FORMATION: the setup boundary for an unread file is a
   * guess, and a cluster keyed on a guess is not evidence. It is already in
   * `unanalyzed` with a reason, so nothing goes missing.
   */
  it('leaves a test whose source could not be read out of the cluster', async () => {
    tests = [
      row({ ...SETUP_FILES[0] }),
      row({ ...SETUP_FILES[1] }),
      // Ends inside an unterminated string, so the file was not fully parsed.
      row({ ...SETUP_FILES[2], code: `${TAX_SPEC}\nconst oops = 'unterminated` }),
    ];
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: SETUP_FILES.map((file) => file.filePath) }),
    });

    expect(res.body.proposed).toHaveLength(1);
    // Two members, not three: the unread one was never a candidate.
    expect(res.body.proposed[0].paths).not.toContain(SETUP_FILES[2].filePath);
    expect(res.body.proposed[0].paths).toContain(SETUP_FILES[0].filePath);
    expect(res.body.proposed[0].paths).toContain(SETUP_FILES[1].filePath);
  });

  /*
   * TWO ROWS AT ONE PATH ARE SET ASIDE AND NAMED. The setup boundary is the
   * file's first assertion, so a second block in that file would be described
   * by the first block's evidence. Declined rather than described wrongly.
   */
  it('names the rows it set aside because their file holds more than one test', async () => {
    tests = [
      ...SETUP_FILES.map((file) => row({ ...file })),
      row({
        id: 'test_second_block',
        name: 'and the shipping line',
        filePath: SETUP_FILES[0].filePath,
        code: TOTAL_SPEC,
      }),
    ];
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: SETUP_FILES.map((file) => file.filePath) }),
    });

    expect(JSON.stringify(res.body.declined)).toContain('more than one');
    expect(JSON.stringify(res.body.declined)).toContain(SETUP_FILES[0].filePath);
  });

  /*
   * A REFUSED LISTING NEVER ECHOES THE PATH IT REFUSED. The entries are
   * customer-authored text; the error names the zod path and the rule.
   */
  it('refuses a malformed listing without quoting the customer’s path back', async () => {
    const res = await call('/projects/proj_1/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: ['x'.repeat(5_000)] }),
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('treeListing');
    expect(JSON.stringify(res.body)).not.toContain('x'.repeat(100));
  });

  it('404s for a project that does not exist', async () => {
    h.db = { ...h.db, project: { findUnique: async () => null } };
    const res = await call('/projects/nope/suite-changes/fixtures', {
      method: 'POST',
      body: JSON.stringify({ treeListing: [] }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:projectId/suite-changes/strengthenings', () => {
  beforeEach(() => {
    useWeakSuite();
  });

  /*
   * THE WIRING. `strengthenAssertions` had no production caller; the merge
   * route counted the candidates and offered no way to act on any of them.
   */
  it('stores the computed rewrite BLOCKED when nobody has run it', async () => {
    const res = await call('/projects/proj_1/suite-changes/strengthenings', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toBe(1);
    expect(res.body.proposed).toHaveLength(1);
    const proposed = res.body.proposed[0] as Row;
    expect(proposed.kind).toBe('STRENGTHEN_ASSERTION');
    /*
     * BLOCKED, NOT PROPOSED. An unverified strengthening has an unknown
     * verdict, and "unknown" stored as a proposal is the pass that means "we
     * did not check". `APPLYABLE_STATES` says false for BLOCKED.
     */
    expect(proposed.state).toBe('BLOCKED');
    expect(proposed.title).toContain('(unverified)');
    expect(String(proposals[0]!.blockedReason)).toContain('STRENGTHENING_UNVERIFIED');
    expect(res.body.needsVerification).toBe(1);
    expect(res.body.trialStates).toEqual({ PASSED: 0, FAILED: 0, UNAVAILABLE: 1 });
  });

  /*
   * PASSES AND FAILS ARE DIFFERENT PROPOSALS. Both are stored and the titles
   * differ, because suppressing the failing one would be a failure suppressed
   * without being counted — and a weak assertion that was hiding a real defect
   * is the most valuable thing this engine produces.
   */
  it('stores a PASSING trial as a tidy-up whose title says it passes', async () => {
    const res = await call('/projects/proj_1/suite-changes/strengthenings', {
      method: 'POST',
      body: JSON.stringify({
        trials: [{ testId: 'test_weak', state: 'PASSED', why: 'ran green on main' }],
      }),
    });

    const proposed = res.body.proposed[0] as Row;
    expect(proposed.state).toBe('PROPOSED');
    expect(proposed.title).toContain('(verified: passes)');
    expect(res.body.trialStates).toEqual({ PASSED: 1, FAILED: 0, UNAVAILABLE: 0 });
    expect(res.body.needsVerification).toBe(0);
  });

  it('stores a FAILING trial as a finding whose title says it fails', async () => {
    const res = await call('/projects/proj_1/suite-changes/strengthenings', {
      method: 'POST',
      body: JSON.stringify({
        trials: [{ testId: 'test_weak', state: 'FAILED', why: 'the element was empty' }],
      }),
    });

    const proposed = res.body.proposed[0] as Row;
    // STILL A PROPOSAL — `STRENGTHENING_FAILED` is the engine's one
    // non-blocking problem precisely so this reaches a human.
    expect(proposed.state).toBe('PROPOSED');
    expect(proposed.title).toContain('FAILS');
    expect(proposed.title).not.toContain('(verified: passes)');
    expect(String(proposals[0]!.blockedReason)).toContain('STRENGTHENING_FAILED');
    expect(res.body.trialStates).toEqual({ PASSED: 0, FAILED: 1, UNAVAILABLE: 0 });
  });

  /*
   * A TRIAL THAT COULD NOT RUN BLOCKS, exactly as never having asked does.
   * UNAVAILABLE is not a pass.
   */
  it('treats a trial that could not run as no trial at all', async () => {
    const res = await call('/projects/proj_1/suite-changes/strengthenings', {
      method: 'POST',
      body: JSON.stringify({
        trials: [{ testId: 'test_weak', state: 'UNAVAILABLE', why: 'the runner timed out' }],
      }),
    });

    expect((res.body.proposed[0] as Row).state).toBe('BLOCKED');
    expect(res.body.needsVerification).toBe(1);
  });

  /*
   * THE VERDICT IS NOT QAAI'S OWN MEASUREMENT AND THE RATIONALE SAYS SO. A
   * reviewer reading "this stronger assertion PASSES" has to be able to tell
   * who ran it, or the sentence is the product claiming a measurement it did
   * not make.
   */
  it('records that the verdict was reported rather than measured here', async () => {
    await call('/projects/proj_1/suite-changes/strengthenings', {
      method: 'POST',
      body: JSON.stringify({
        trials: [{ testId: 'test_weak', state: 'PASSED', why: 'ran green', detail: ['1 passed'] }],
      }),
    });

    expect(String(proposals[0]!.rationale)).toContain('VERDICT SOURCE');
    expect(String(proposals[0]!.rationale)).toContain('did not execute this trial itself');
  });

  /*
   * NOTHING AUTO-APPLIES. `APPLYABLE_STATES` has exactly one `true` key and
   * this endpoint never writes it, whatever the trial said.
   */
  it('never stores a row in the one state that may be applied', async () => {
    for (const state of ['PASSED', 'FAILED', 'UNAVAILABLE'] as const) {
      proposals = [];
      await call('/projects/proj_1/suite-changes/strengthenings', {
        method: 'POST',
        body: JSON.stringify({ trials: [{ testId: 'test_weak', state, why: 'ran' }] }),
      });
      expect(proposals.map((p) => p.state)).not.toContain('APPROVED');
      expect(proposals.map((p) => p.appliedAt)).toEqual([undefined]);
    }
  });

  /*
   * A VERDICT WITH NO EVIDENCE IS REFUSED AT THE EDGE. `why` is required
   * because `verifyStrengthening` interpolates it into the rationale a reviewer
   * reads, and a bare state is the pass that means "we did not check".
   */
  it('refuses a verdict with no reason beside it', async () => {
    const res = await call('/projects/proj_1/suite-changes/strengthenings', {
      method: 'POST',
      body: JSON.stringify({ trials: [{ testId: 'test_weak', state: 'PASSED' }] }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for a project that does not exist', async () => {
    h.db = { ...h.db, project: { findUnique: async () => null } };
    const res = await call('/projects/nope/suite-changes/strengthenings', { method: 'POST' });
    expect(res.status).toBe(404);
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
