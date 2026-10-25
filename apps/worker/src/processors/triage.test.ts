/**
 * The triage processor: one verdict per CAUSE, and the loops around it.
 *
 * The register defect this file is mostly about is a cost and a quality bug at
 * once: "a 200-test outage spends 200+ model calls and produces 200
 * inconsistent verdicts, though clustering already exists". So the headline
 * test runs an actual 200-result outage through the processor and asserts the
 * model was called ONCE — not that a helper returned the right number, but that
 * the processor, driven 200 times over a store that enforces its own unique
 * constraints, spent one call.
 *
 * The fake Prisma below enforces the two unique indexes the design rests on
 * (`FailureSignature(orgId, projectId, clusterKey)` and
 * `RunFailureCluster(runId, clusterKey)`) and throws P2002 like the real one,
 * because the claim is the whole concurrency design: if the fake shrugged at a
 * duplicate insert, the race test would pass for a reason that has nothing to
 * do with the processor.
 *
 * Nothing here needs an ANTHROPIC_API_KEY. `triageFailure` is stubbed and
 * COUNTED, which is the only way the central claim of this change is checkable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  proposalDiff: string;
  auto: boolean;
  /** Every `triageFailure` call's input, in order. The model-call ledger. */
  triageCalls: Row[];
  /** Resolves each stubbed model call. Replaced by the race test with a gate. */
  triageImpl: (input: Row) => Promise<Row>;
  events: Row[];
  /** Set to make the Healer's model call throw, for the "a heal must not fail
   * triage" guard. */
  healError: Error | null;
  /** Strong-tier Healer calls. The per-test guard's saving is this number. */
  healCalls: number;
  /** The environment the healed test last ran in. Null is a real state — a test
   * that has never run cannot be re-run — and it is what makes an unattended
   * heal UNVERIFIABLE rather than PENDING. */
  environmentId: string | null;
  /** Verification runs this process queued. */
  enqueued: Row[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  proposalDiff: '',
  auto: true,
  triageCalls: [],
  triageImpl: async () => ({
    verdict: 'ENV_ISSUE',
    confidence: 0.9,
    explanation: 'the dependency stopped answering',
    evidence: [{ kind: 'NETWORK', ref: 'r1', detail: 'POST /pay -> 503' }],
    suspectCommit: null,
    model: 'stub',
  }),
  events: [],
  healError: null,
  healCalls: 0,
  environmentId: 'env_1',
  enqueued: [],
}));

vi.mock('../context.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  prisma: new Proxy({}, { get: (_t, k: string) => h.prisma[k] }),
  llm: {},
  publishEvent: (orgId: string, event: Row) => {
    h.events.push({ orgId, ...event });
  },
}));

/*
 * The run queue, stubbed so importing it does not reach for Redis — and so the
 * verification run an unattended heal now starts is observable.
 */
vi.mock('../queues.js', () => ({
  enqueueRun: async (job: Row, opts: Row = {}) => {
    h.enqueued.push({ runId: job.runId, background: opts.background === true });
  },
}));

vi.mock('@qaai/agent', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    triageFailure: async (_llm: unknown, _ctx: unknown, input: Row) => {
      h.triageCalls.push(input);
      return h.triageImpl(input);
    },
    proposeHeal: async () => {
      h.healCalls += 1;
      if (h.healError) throw h.healError;
      return {
        diff: h.proposalDiff,
        explanation: 'retarget the total',
        riskLevel: 'LOW',
        confidence: 0.9,
      };
    },
    isAutoApprovable: () => ({ allowed: h.auto, reason: 'selector-only' }),
  };
});

const { processTriage, CLUSTER_VERDICT_WAIT } = await import('./triage.js');
const { failureClusterKey, verificationRunTag } = await import('@qaai/agent');
const { signatureOf, extractFacets } = await import('../../../api/src/lib/cluster.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CODE = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('checkout charges the right total', async ({ page }) => {",
  "  await page.goto('/checkout');",
  "  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  '});',
].join('\n');

/**
 * Two failure texts that normalise to two DIFFERENT signatures, and one that
 * varies only in the volatile tokens the clusterer scrubs — so "200 failures,
 * one cause" is a real clustering claim and not an artefact of identical
 * strings.
 */
const OUTAGE = (n: number): string =>
  [
    `TimeoutError: locator.click: Timeout ${29_000 + n}ms exceeded.`,
    'Call log:',
    "  - waiting for getByRole('button', { name: 'Checkout' })",
    `    at /Users/dana/app/tests/checkout-${n}.spec.ts:${40 + n}:22`,
  ].join('\n');

const OTHER_CAUSE =
  'Error: expect(received).toBe(expected)\n  Expected: 4\n  Received: 3\n    at /Users/dana/app/tests/cart.spec.ts:41:22';

const SLEEP_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -4,1 +4,2 @@',
  "   await page.goto('/checkout');",
  '+  await page.waitForTimeout(500);',
].join('\n');

const BREAK_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -6,1 +6,1 @@',
  '-});',
  '+}',
].join('\n');

const CLEAN_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -5,1 +5,1 @@',
  "-  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  "+  await expect(page.getByTestId('checkout-total')).toHaveText('$42.00');",
].join('\n');

/** The key the processor will compute for a given failure text. */
function keyOf(errorMessage: string): string {
  return failureClusterKey(
    signatureOf(
      extractFacets({
        testResultId: 'x',
        testId: 'x',
        testName: 'x',
        filePath: 'x',
        status: 'FAILED',
        errorMessage,
        retriedAndPassed: false,
        steps: [],
        network: [],
        verdict: null,
      }),
    ) || 'msg=<none>',
  );
}

// ─── The fake store ──────────────────────────────────────────────────────────

interface Store {
  testResult: Row[];
  triageVerdict: Row[];
  triageVerdictRevision: Row[];
  failureSignature: Row[];
  runFailureCluster: Row[];
  healProposal: Row[];
  testVersionUpdates: Row[];
  /** Runs this process created — the verification of an unattended heal. */
  runs: Row[];
  /** `UsageRecord` upserts, so a run created here is also a run metered. */
  metered: Row[];
  /** How many statements each `$transaction` carried, in order. */
  transactions: number[];
}

let store: Store;
let idSeq = 0;
const nextId = (prefix: string): string => `${prefix}_${(idSeq += 1)}`;

/** `{ increment: n }` and plain assignment, like Prisma's update data. */
function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      row[key] = (row[key] ?? 0) + (value as Row).increment;
    } else {
      row[key] = value;
    }
  }
}

function uniqueViolation(): Error & { code: string } {
  const err = new Error('Unique constraint failed') as Error & { code: string };
  err.code = 'P2002';
  return err;
}

/**
 * A model with real unique-key semantics.
 *
 * `uniques` names the composite keys this model enforces. `create` throws P2002
 * on a duplicate, which is what the claim design depends on — a fake that
 * accepted the second insert would let two jobs both believe they own the
 * cause, and the race test would prove nothing.
 */
function model(
  name: keyof Store,
  uniques: string[][] = [],
  /** Resolves relation fields, so a nested `where`/`select` can be modelled. */
  hydrate?: (row: Row) => Row,
  /**
   * The schema's own column defaults. Not decoration: `TriageVerdict.revision`
   * defaults to 1, and a fake that left it undefined makes `revision + 1` into
   * NaN — which is a green-looking test asserting on a number that does not
   * exist.
   */
  defaults: Row = {},
) {
  const rows = (): Row[] => store[name] as Row[];

  const matchUnique = (where: Row): Row | undefined => {
    if (where.id) return rows().find((r) => r.id === where.id);
    for (const combo of uniques) {
      const compositeName = combo.join('_');
      const nested = where[compositeName] as Row | undefined;
      const fields = nested ?? where;
      if (combo.every((f) => fields[f] !== undefined)) {
        return rows().find((r) => combo.every((f) => r[f] === fields[f]));
      }
    }
    return undefined;
  };

  /**
   * A relation filter, modelled rather than ignored.
   *
   * `correctionPrior` scopes the project's correction history with
   * `testResult: { run: { projectId } }`, and that scoping IS the property
   * under test — a fake that shrugged at the filter would report one project's
   * corrections to another and the test would pass.
   */
  const matchesNested = (value: unknown, cond: Row): boolean => {
    if (!value || typeof value !== 'object') return false;
    const source = value as Row;
    return Object.entries(cond).every(([key, inner]) =>
      inner && typeof inner === 'object' && !(inner instanceof Date)
        ? matchesNested(source[key], inner as Row)
        : source[key] === inner,
    );
  };

  const matchesWhere = (row: Row, where: Row = {}): boolean => {
    const source = hydrate ? hydrate(row) : row;
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'OR') return (cond as Row[]).some((branch) => matchesWhere(row, branch));
      if (cond === null) return (source[key] ?? null) === null;
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as Row;
        if ('in' in c) return (c.in as unknown[]).includes(source[key]);
        if ('not' in c) return source[key] !== c.not;
        if ('gt' in c) return source[key] instanceof Date && source[key] > (c.gt as Date);
        if ('gte' in c) return source[key] instanceof Date && source[key] >= (c.gte as Date);
        if (hydrate) return matchesNested(source[key], c);
        throw new Error(`fake prisma: unsupported ${name} filter ${key}=${JSON.stringify(cond)}`);
      }
      return source[key] === cond;
    });
  };

  const read = (row: Row | undefined): Row | null =>
    row ? (hydrate ? hydrate(row) : row) : null;

  return {
    findUnique: async (args: Row = {}) => read(matchUnique(args.where ?? {})),
    findUniqueOrThrow: async (args: Row = {}) => {
      const found = read(matchUnique(args.where ?? {}));
      if (!found) throw new Error(`fake prisma: no ${name}`);
      return found;
    },
    findFirst: async (args: Row = {}) =>
      read(rows().find((r) => matchesWhere(r, args.where))),
    findMany: async (args: Row = {}) => {
      let out = rows().filter((r) => matchesWhere(r, args.where)).map((r) => hydrate ? hydrate(r) : r);
      const order = Object.entries((args.orderBy ?? {}) as Row)[0];
      if (order) {
        const [field, dir] = order;
        out = [...out].sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          const cmp = av === bv ? 0 : av > bv ? 1 : -1;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      return typeof args.take === 'number' ? out.slice(0, args.take) : out;
    },
    create: async (args: Row = {}) => {
      const data = { ...(args.data as Row) };
      for (const combo of uniques) {
        if (rows().some((r) => combo.every((f) => r[f] === data[f]))) throw uniqueViolation();
      }
      const row = { id: data.id ?? nextId(String(name)), ...defaults, ...data };
      rows().push(row);
      return row;
    },
    update: async (args: Row = {}) => {
      // The STORED row, never a hydrated copy: a fake that mutated the copy
      // would make every write look like it worked and change nothing.
      const found = matchUnique(args.where ?? {});
      if (!found) throw new Error(`fake prisma: no ${name} to update`);
      applyData(found, args.data as Row);
      return found;
    },
    /*
     * A CONDITIONAL write, and the condition is enforced.
     *
     * The cause's answer is published with `verdictId: null` in the WHERE, so
     * the first verdict for a cause wins and a second one cannot overwrite it.
     * A fake that ignored the filter and updated by id would make the
     * re-election tests pass while the race they exist for stayed broken, so
     * the filter runs through `matchesWhere` exactly like a read's.
     */
    updateMany: async (args: Row = {}) => {
      const matched = rows().filter((r) => matchesWhere(r, args.where));
      for (const row of matched) applyData(row, args.data as Row);
      return { count: matched.length };
    },
  };
}

function installDb(): void {
  store = {
    testResult: [],
    triageVerdict: [],
    triageVerdictRevision: [],
    failureSignature: [],
    runFailureCluster: [],
    healProposal: [],
    testVersionUpdates: [],
    runs: [],
    metered: [],
    transactions: [],
  };

  const testResult = model('testResult');
  /*
   * Verdict reads resolve their result, its test and its run, because three of
   * the processor's queries go through that chain: the correction prior scopes
   * by project, and the attach path names the test the evidence was read from.
   */
  const triageVerdict = model(
    'triageVerdict',
    [['testResultId']],
    (row) => {
      const result = store.testResult.find((r) => r.id === row.testResultId);
      return {
        ...row,
        testResult: result
          ? {
              id: result.id,
              runId: result.runId,
              test: result.test,
              run: { projectId: result.test.projectId },
            }
          : undefined,
      };
    },
    {
      revision: 1,
      reviewState: 'PENDING',
      overriddenTo: null,
      reviewedBy: null,
      reviewedAt: null,
      retriageRequestedAt: null,
      retriageRequestedBy: null,
      retriageReason: null,
      splitFromClusterKey: null,
      derivedFromId: null,
      createdAt: new Date('2026-10-24T12:00:00.000Z'),
    },
  );

  h.prisma = {
    testResult: {
      ...testResult,
      /*
       * `include` on the processor's own read, hand-rolled: the row fixtures
       * already carry `test`, `steps`, `findings` and `verdict` is resolved
       * from the verdict table so a supersede sees the live row.
       */
      findFirst: async (args: Row = {}) => {
        /*
         * Two callers, two shapes. The processor's own read is by result id and
         * resolves the verdict; the heal verification's environment lookup is
         * "the most recent result for this TEST" and reads the run it belongs
         * to. Modelled rather than collapsed, because a stand-in that returned
         * null for the second would report every unattended heal as
         * UNVERIFIABLE and the PENDING arm would never be exercised.
         */
        if (args.where?.testId !== undefined) {
          const row = [...store.testResult]
            .reverse()
            .find((r) => r.testId === args.where.testId && r.orgId === args.where.orgId);
          if (!row) return null;
          return { ...row, run: { environmentId: h.environmentId } };
        }
        const row = store.testResult.find(
          (r) => r.id === args.where?.id && r.orgId === args.where?.orgId,
        );
        if (!row) return null;
        const verdict = store.triageVerdict.find((v) => v.testResultId === row.id) ?? null;
        /*
         * `select` is PROJECTED, not ignored. A fake that handed back the whole
         * verdict row let a column be deleted from the processor's select with
         * every test still green — which is how the cause's own `clusterKey`
         * could go unread. Projecting here is what makes the select itself
         * part of what the suite holds.
         */
        const want = (args.include?.verdict as Row | undefined)?.select as Row | undefined;
        if (verdict && want) {
          const projected: Row = {};
          for (const field of Object.keys(want)) {
            if (want[field]) projected[field] = verdict[field];
          }
          return { ...row, verdict: projected };
        }
        return { ...row, verdict };
      },
      findMany: testResult.findMany,
    },
    triageVerdict,
    triageVerdictRevision: model('triageVerdictRevision', [['verdictId', 'revision']]),
    failureSignature: model(
      'failureSignature',
      [['orgId', 'projectId', 'clusterKey']],
      undefined,
      {
        runCount: 0,
        occurrenceCount: 0,
        suppressedCount: 0,
        mutedUntil: null,
        mutedAt: null,
        mutedBy: null,
        mutedReason: null,
      },
    ),
    runFailureCluster: model('runFailureCluster', [['runId', 'clusterKey']], undefined, {
      members: 0,
      modelCalls: 0,
      attachments: 0,
      suppressed: false,
      firstSeenInProject: false,
      verdictId: null,
      resolvedAt: null,
    }),
    project: { findUnique: async () => ({ autoApproveSelectorHeals: true }) },
    flowMap: { findFirst: async () => null },
    testVersion: { findFirst: async () => ({ version: 3 }) },
    test: {
      update: async (args: Row) => {
        store.testVersionUpdates.push(args);
        return {};
      },
    },
    /*
     * A real model now, because the heal path both READS it (the per-test
     * idempotence guard asks what is already open) and writes two statements
     * about it in one transaction (the new row, and the stale ones it
     * supersedes).
     */
    healProposal: model('healProposal', [], undefined, {
      state: 'PROPOSED',
      riskLevel: 'LOW',
      appliedVersion: null,
      supersededById: null,
      decidedAt: null,
      verifyState: null,
      verifyRunId: null,
      verifyNote: null,
      verifiedAt: null,
      createdAt: new Date('2026-10-24T12:00:00.000Z'),
    }),
    /*
     * The run toll, as `startRun` reads it: which plan the org is on and how
     * many runs it has spent this month. A verification run is a Run — it costs
     * a browser and it belongs on the bill — so it goes through the same gate
     * every other run does rather than inserting a row behind the plan's back.
     */
    run: {
      create: async (args: Row = {}) => {
        const row = { id: nextId('run'), ...(args.data as Row) };
        store.runs.push(row);
        return row;
      },
      update: async (args: Row = {}) => {
        const row = store.runs.find((r) => r.id === args.where?.id);
        if (row) applyData(row, args.data as Row);
        return row ?? {};
      },
    },
    subscription: { findUnique: async () => null },
    organization: { findUnique: async () => ({ plan: 'ENTERPRISE' }) },
    usageRecord: {
      findUnique: async () => ({ quantity: 0n }),
      upsert: async (args: Row = {}) => {
        store.metered.push(args.where as Row);
        return {};
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => {
      store.transactions.push(ops.length);
      return Promise.all(ops);
    },
  };
}

/** One failing result row, in the shape the processor reads. */
function seedResult(over: Row = {}): Row {
  const n = store.testResult.length;
  const row = {
    id: `tr_${n}`,
    orgId: 'org',
    runId: 'run_1',
    testId: `t_${n}`,
    status: 'FAILED',
    durationMs: 1,
    createdAt: new Date('2026-10-24T12:00:00.000Z'),
    network: [],
    consoleLog: [],
    videoKey: null,
    traceKey: null,
    errorMessage: OUTAGE(n),
    retriedAndPassed: false,
    findings: [],
    steps: [],
    test: {
      id: `t_${n}`,
      projectId: 'p1',
      name: `checkout ${n}`,
      filePath: `tests/checkout-${n}.spec.ts`,
      code: CODE,
      type: 'E2E',
      spec: null,
    },
    ...over,
  };
  store.testResult.push(row);
  return row;
}

const run = (testResultId: string, runId = 'run_1'): Promise<void> =>
  processTriage({ orgId: 'org', runId, testResultId } as never);

const claim = (clusterKey: string, runId = 'run_1'): Row =>
  store.runFailureCluster.find((c) => c.runId === runId && c.clusterKey === clusterKey)!;

const signature = (clusterKey: string): Row =>
  store.failureSignature.find((s) => s.clusterKey === clusterKey)!;

const verdictFor = (testResultId: string): Row | undefined =>
  store.triageVerdict.find((v) => v.testResultId === testResultId);

const savedWait = { ...CLUSTER_VERDICT_WAIT };

beforeEach(() => {
  idSeq = 0;
  h.triageCalls.length = 0;
  h.events.length = 0;
  h.enqueued.length = 0;
  h.healError = null;
  h.healCalls = 0;
  h.environmentId = 'env_1';
  h.proposalDiff = CLEAN_DIFF;
  h.auto = true;
  h.triageImpl = async () => ({
    verdict: 'ENV_ISSUE',
    confidence: 0.9,
    explanation: 'the dependency stopped answering',
    evidence: [{ kind: 'NETWORK', ref: 'r1', detail: 'POST /pay -> 503' }],
    suspectCommit: null,
    model: 'stub',
  });
  Object.assign(CLUSTER_VERDICT_WAIT, savedWait, { pollMs: 1 });
  installDb();
});

afterEach(() => {
  Object.assign(CLUSTER_VERDICT_WAIT, savedWait);
});

// ─── (a) The 200-test outage ─────────────────────────────────────────────────

describe('a 200-test outage', () => {
  /*
   * THE DEFECT, REPRODUCED AND CLOSED. Before this change the loop below made
   * 200 model calls and wrote 200 independently-worded verdicts. The assertion
   * is on the call ledger, not on a helper's return value, because the claim
   * this product makes is about the calls.
   */
  it('spends ONE model call and still gives every failure a verdict', async () => {
    for (let i = 0; i < 200; i += 1) seedResult();
    for (const row of store.testResult) await run(row.id);

    const key = keyOf(OUTAGE(0));

    expect(h.triageCalls).toHaveLength(1);
    expect(store.triageVerdict).toHaveLength(200);
    expect(store.triageVerdict.every((v) => v.verdict === 'ENV_ISSUE')).toBe(true);
    expect(store.triageVerdict.every((v) => v.clusterKey === key)).toBe(true);

    // The accounting is a stored number, not a hope.
    expect(claim(key).modelCalls).toBe(1);
    expect(claim(key).attachments).toBe(199);
    expect(claim(key).members).toBe(200);
    expect(signature(key).occurrenceCount).toBe(200);
    expect(signature(key).runCount).toBe(1);
  });

  /*
   * The 199 copies must be MARKED. Without this the cost ledger reports 200
   * cheap-model calls that never happened, and 200 agreeing verdicts read as
   * 200 pieces of evidence instead of one.
   */
  it('marks the 199 copies as copies and points them at the test that was read', async () => {
    for (let i = 0; i < 5; i += 1) seedResult();
    for (const row of store.testResult) await run(row.id);

    const owner = store.triageVerdict.filter((v) => v.derivedFromId === null || !v.derivedFromId);
    const copies = store.triageVerdict.filter((v) => v.derivedFromId);

    expect(owner).toHaveLength(1);
    expect(owner[0]!.model).toBe('stub');
    expect(copies).toHaveLength(4);
    expect(copies.every((c) => c.model === 'cluster:stub')).toBe(true);
    expect(copies.every((c) => c.derivedFromId === owner[0]!.id)).toBe(true);

    const note = (copies[0]!.evidence as Row[]).at(-1)!;
    expect(note.detail).toContain('"checkout 0", not from this test');
    expect(note.detail).toContain('re-triage');
  });

  it('tells the model how big the cause is before asking', async () => {
    for (let i = 0; i < 12; i += 1) seedResult();
    for (const row of store.testResult) await run(row.id);

    const cluster = h.triageCalls[0]!.cluster as Row;
    expect(cluster.memberCount).toBe(12);
    expect(cluster.clusterKey).toBe(keyOf(OUTAGE(0)));
    expect(cluster.memberNames.length).toBeGreaterThan(1);
  });

  it('still spends one call per distinct cause', async () => {
    for (let i = 0; i < 4; i += 1) seedResult();
    seedResult({ id: 'tr_other', errorMessage: OTHER_CAUSE });
    for (const row of store.testResult) await run(row.id);

    expect(h.triageCalls).toHaveLength(2);
    expect(store.runFailureCluster).toHaveLength(2);
    expect(store.triageVerdict).toHaveLength(5);
  });

  /*
   * The ANSWER collapses; the DIFF does not, because it patches each test's own
   * file. A derived INTENDED_CHANGE must still reach the Healer, or 199 of 200
   * stale tests stay broken while the cause is reported handled.
   */
  it('still proposes a heal for every member of an INTENDED_CHANGE cause', async () => {
    h.triageImpl = async () => ({
      verdict: 'INTENDED_CHANGE',
      confidence: 0.9,
      explanation: 'the button was renamed',
      evidence: [{ kind: 'STEP', ref: '0', detail: 'locator did not resolve' }],
      suspectCommit: null,
      model: 'stub',
    });
    for (let i = 0; i < 4; i += 1) seedResult();
    for (const row of store.testResult) await run(row.id);

    expect(h.triageCalls).toHaveLength(1);
    expect(store.healProposal).toHaveLength(4);
  });
});

// ─── (b) The claim, under concurrency ────────────────────────────────────────

describe('two jobs for one cause at the same instant', () => {
  /*
   * The triage queue runs at `concurrency * 2`, so this interleave is the
   * normal case and not a corner. The gate holds the first model call open
   * until both jobs have passed the point where they look for an existing
   * verdict — which is exactly the window that made the old "check, then call"
   * design spend two calls.
   */
  it('spends one call: the loser waits for the winner instead of paying', async () => {
    seedResult();
    seedResult();

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    h.triageImpl = async () => {
      calls += 1;
      await gate;
      return {
        verdict: 'ENV_ISSUE',
        confidence: 0.9,
        explanation: 'shared dependency',
        evidence: [{ kind: 'NETWORK', ref: 'r1', detail: '503' }],
        suspectCommit: null,
        model: 'stub',
      };
    };

    const both = Promise.all([run('tr_0'), run('tr_1')]);
    // Let both jobs reach their first await before the owner's call returns.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    release!();
    await both;

    const key = keyOf(OUTAGE(0));
    expect(h.triageCalls).toHaveLength(1);
    expect(store.triageVerdict).toHaveLength(2);
    expect(claim(key).modelCalls).toBe(1);
    expect(claim(key).attachments).toBe(1);
  });

  /*
   * THE P2002 PATH ITSELF, which the test above does NOT reach.
   *
   * Found by a mutation experiment: making the unique-violation handler claim
   * ownership instead of reading the winner's row left every test green,
   * because in the test above the second job always saw the first job's claim
   * row and never attempted its own INSERT. That is the cheap path. The path
   * the unique index exists for is both jobs reading "no claim yet" and BOTH
   * inserting, and it is forced here by blanking the first two composite
   * lookups — the exact interleave a queue running at `concurrency * 2`
   * produces, and the one where a wrong handler buys a second model call.
   */
  it('lets the unique index pick the winner when both jobs insert the claim', async () => {
    seedResult();
    seedResult();

    const real = (h.prisma as Row).runFailureCluster as Row;
    let blanked = 0;
    (h.prisma as Row).runFailureCluster = {
      ...real,
      findUnique: async (args: Row = {}) => {
        if (args.where?.runId_clusterKey && blanked < 2) {
          blanked += 1;
          return null;
        }
        return real.findUnique(args);
      },
    };

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    h.triageImpl = async () => {
      calls += 1;
      await gate;
      return {
        verdict: 'ENV_ISSUE',
        confidence: 0.9,
        explanation: 'shared dependency',
        evidence: [{ kind: 'NETWORK', ref: 'r1', detail: '503' }],
        suspectCommit: null,
        model: 'stub',
      };
    };

    const both = Promise.all([run('tr_0'), run('tr_1')]);
    await new Promise((r) => setTimeout(r, 20));
    release!();
    await both;

    const key = keyOf(OUTAGE(0));
    // Both inserted; exactly one row exists, and exactly one call was made.
    expect(blanked).toBe(2);
    expect(store.runFailureCluster).toHaveLength(1);
    expect(calls).toBe(1);
    expect(h.triageCalls).toHaveLength(1);
    expect(store.triageVerdict).toHaveLength(2);
    expect(claim(key).modelCalls).toBe(1);
    expect(claim(key).attachments).toBe(1);
    // The loser took a marked copy rather than minting a second original.
    const copies = store.triageVerdict.filter((v) => v.derivedFromId);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.model).toBe('cluster:stub');
  });

  /*
   * And when the wait runs out, the processor pays for its own call and the
   * ledger SAYS 2. A waiter that gave up silently would leave a real failure
   * with no verdict; one that reported 1 would be lying about money.
   */
  it('gives up honestly on timeout: a second call, and modelCalls says 2', async () => {
    CLUSTER_VERDICT_WAIT.totalMs = 0;
    seedResult();
    seedResult();

    // The owner's call never completes within this test's lifetime, so the
    // waiter's bounded wait is guaranteed to expire.
    let resolveOwner: ((v: Row) => void) | undefined;
    let first = true;
    h.triageImpl = async () => {
      if (first) {
        first = false;
        return new Promise<Row>((resolve) => {
          resolveOwner = resolve;
        });
      }
      return {
        verdict: 'FLAKE',
        confidence: 0.6,
        explanation: 'triaged on its own after the wait expired',
        evidence: [{ kind: 'HISTORY', ref: 'h', detail: 'x' }],
        suspectCommit: null,
        model: 'stub-2',
      };
    };

    const owner = run('tr_0');
    await new Promise((r) => setTimeout(r, 10));
    await run('tr_1');

    const key = keyOf(OUTAGE(0));
    expect(h.triageCalls).toHaveLength(2);
    expect(verdictFor('tr_1')!.model).toBe('stub-2');
    expect(verdictFor('tr_1')!.derivedFromId).toBeFalsy();
    // Nothing was attached, and the ledger shows the waiter's own call. The
    // owner has not finished paying yet, so its call is not on the ledger
    // either — the increment happens when the verdict lands, not when the call
    // is made, so the number can never run ahead of the work.
    expect(claim(key).modelCalls).toBe(1);
    expect(claim(key).attachments).toBe(0);

    resolveOwner!({
      verdict: 'ENV_ISSUE',
      confidence: 0.9,
      explanation: 'late',
      evidence: [{ kind: 'NETWORK', ref: 'r', detail: 'x' }],
      suspectCommit: null,
      model: 'stub',
    });
    await owner;

    // Both calls are now accounted for. Two, not one: the saving this product
    // claims must not be reported for a call it actually made.
    expect(claim(key).modelCalls).toBe(2);
    expect(store.triageVerdict).toHaveLength(2);
  });
});

// ─── (c) The persisted identity ──────────────────────────────────────────────

describe('cause identity', () => {
  it('is minted on first sight, with this run as firstSeenRunId', async () => {
    seedResult();
    await run('tr_0');

    const key = keyOf(OUTAGE(0));
    expect(signature(key).firstSeenRunId).toBe('run_1');
    expect(signature(key).lastSeenRunId).toBe('run_1');
    expect(claim(key).firstSeenInProject).toBe(true);
    expect(h.triageCalls[0]!.cause).toMatchObject({ newInThisBuild: true, runsSeen: 1 });
  });

  /*
   * NEW IN THIS BUILD IS AN EQUALITY, and this is the test that proves it stays
   * one. The second run sees the same cause, so `firstSeenRunId` must NOT move
   * — if it did, every cause would read as new in every build and the single
   * most useful sentence in the product would be a constant.
   */
  it('does not move firstSeenRunId on a later run, so the second build is not "new"', async () => {
    seedResult();
    await run('tr_0');

    store.testResult.length = 0;
    seedResult({ id: 'tr_next', runId: 'run_2', errorMessage: OUTAGE(0) });
    await run('tr_next', 'run_2');

    const key = keyOf(OUTAGE(0));
    expect(signature(key).firstSeenRunId).toBe('run_1');
    expect(signature(key).lastSeenRunId).toBe('run_2');
    expect(signature(key).runCount).toBe(2);
    expect(claim(key, 'run_2').firstSeenInProject).toBe(false);
    expect(h.triageCalls[1]!.cause).toMatchObject({ newInThisBuild: false });
  });

  it('counts runs once per run and occurrences once per failure', async () => {
    for (let i = 0; i < 3; i += 1) seedResult();
    for (const row of store.testResult) await run(row.id);

    const key = keyOf(OUTAGE(0));
    expect(signature(key).runCount).toBe(1);
    expect(signature(key).occurrenceCount).toBe(3);
  });
});

// ─── (d) Mute ────────────────────────────────────────────────────────────────

describe('a muted cause', () => {
  async function mute(until: Date): Promise<string> {
    seedResult();
    await run('tr_0');
    const key = keyOf(OUTAGE(0));
    applyData(signature(key), {
      mutedUntil: until,
      mutedAt: new Date(),
      mutedBy: 'user_1',
      mutedReason: 'known issue, fix lands next sprint',
    });
    // A second run of the same cause, now that the mute is on.
    store.testResult.length = 0;
    store.triageVerdict.length = 0;
    h.triageCalls.length = 0;
    h.events.length = 0;
    seedResult({ id: 'tr_muted', runId: 'run_2', errorMessage: OUTAGE(0) });
    return key;
  }

  /*
   * NO VERDICT ROW IS THE SUPPRESSION. It is concrete rather than hopeful:
   * GET /badges counts PENDING verdicts, digest.ts lists verdicts and the gate
   * blocks on REAL_BUG verdicts, so a cause with no row reaches none of them.
   */
  it('mints no verdict and makes no model call', async () => {
    const key = await mute(new Date(Date.now() + 86_400_000));
    await run('tr_muted', 'run_2');

    expect(h.triageCalls).toHaveLength(0);
    expect(verdictFor('tr_muted')).toBeUndefined();
    expect(claim(key, 'run_2').suppressed).toBe(true);
  });

  /*
   * ...and it stays COUNTABLE. "It went quiet" and "it stopped happening" are
   * different facts; a mute that recorded nothing makes them indistinguishable,
   * which is how a mute becomes a blind spot.
   */
  it('still counts the occurrence and records what it swallowed', async () => {
    const key = await mute(new Date(Date.now() + 86_400_000));
    await run('tr_muted', 'run_2');

    expect(signature(key).occurrenceCount).toBe(2);
    expect(signature(key).suppressedCount).toBe(1);
    expect(claim(key, 'run_2').members).toBe(1);

    const event = h.events.find((e) => e.type === 'verdict.suppressed');
    expect(event).toBeTruthy();
    expect(event!.data.mutedReason).toBe('known issue, fix lands next sprint');
    // Nothing on the paging channel.
    expect(h.events.some((e) => e.type === 'verdict')).toBe(false);
  });

  /*
   * THE EXPIRY IS THE BRAKE. A mute that outlived its window must mint again on
   * its own, with no human action — that is the whole difference between a mute
   * and the quarantine mistake.
   */
  it('mints again once the mute has expired', async () => {
    await mute(new Date(Date.now() - 1000));
    await run('tr_muted', 'run_2');

    expect(h.triageCalls).toHaveLength(1);
    expect(verdictFor('tr_muted')).toBeTruthy();
  });
});

// ─── (e) Re-triage ───────────────────────────────────────────────────────────

describe('re-triage', () => {
  /** A result with a reviewed verdict and a pending re-triage request. */
  async function withRequest(over: Row = {}): Promise<Row> {
    seedResult();
    await run('tr_0');
    const live = verdictFor('tr_0')!;
    applyData(live, {
      reviewState: 'OVERRIDDEN',
      overriddenTo: 'REAL_BUG',
      reviewedBy: 'user_7',
      reviewedAt: new Date('2026-10-23T09:00:00.000Z'),
      retriageRequestedAt: new Date('2026-10-24T09:00:00.000Z'),
      retriageRequestedBy: 'user_7',
      retriageReason: 'the service was healthy; this is a real bug',
      ...over,
    });
    h.triageCalls.length = 0;
    h.triageImpl = async () => ({
      verdict: 'REAL_BUG',
      confidence: 0.82,
      explanation: 'the total is arithmetically wrong',
      evidence: [{ kind: 'STEP', ref: '0', detail: 'expected 4, got 3' }],
      suspectCommit: null,
      model: 'stub-fresh',
    });
    return live;
  }

  /*
   * THE POINT OF THE WHOLE FEATURE. `reviewState` and `overriddenTo` are the
   * only record that the model was ever wrong, they are what the prompt reads
   * back as a prior, and `testResultId` is unique so a fresh verdict has
   * nowhere to go but on top of them.
   */
  it('archives the human correction before overwriting it', async () => {
    const live = await withRequest();
    await run('tr_0');

    expect(store.triageVerdictRevision).toHaveLength(1);
    const archived = store.triageVerdictRevision[0]!;
    expect(archived).toMatchObject({
      verdictId: live.id,
      revision: 1,
      verdict: 'ENV_ISSUE',
      reviewState: 'OVERRIDDEN',
      overriddenTo: 'REAL_BUG',
      reviewedBy: 'user_7',
      supersededBy: 'user_7',
      reason: 'the service was healthy; this is a real bug',
    });
  });

  it('lands the fresh verdict on the same row at the next revision, pending review', async () => {
    const live = await withRequest();
    await run('tr_0');

    expect(store.triageVerdict).toHaveLength(1);
    expect(live.verdict).toBe('REAL_BUG');
    expect(live.model).toBe('stub-fresh');
    expect(live.revision).toBe(2);
    // A verdict the reviewer has never seen must not carry their approval: the
    // old decision lives in the revision row, and reviewState is what gates.
    expect(live.reviewState).toBe('PENDING');
    expect(live.overriddenTo).toBeNull();
    expect(live.reviewedBy).toBeNull();
    // The request is consumed, so a redelivered job does not re-triage forever.
    expect(live.retriageRequestedAt).toBeNull();
  });

  it('is idempotent when the job is redelivered', async () => {
    const live = await withRequest();
    await run('tr_0');
    // The request is cleared, so a redelivery is the ordinary skip path.
    await run('tr_0');

    expect(h.triageCalls).toHaveLength(1);
    expect(store.triageVerdictRevision).toHaveLength(1);
    expect(live.revision).toBe(2);
  });

  /*
   * A re-triage must NOT attach. Handing back a copy of the answer the reviewer
   * just rejected is the "re-run triage" button doing nothing, which is the
   * defect being fixed.
   */
  it('makes a real call even though the cause already has a verdict', async () => {
    seedResult();
    seedResult();
    await run('tr_0');
    await run('tr_1');
    expect(h.triageCalls).toHaveLength(1);

    const copy = verdictFor('tr_1')!;
    expect(copy.derivedFromId).toBeTruthy();
    applyData(copy, {
      retriageRequestedAt: new Date(),
      retriageRequestedBy: 'user_7',
      retriageReason: 'this one is a real bug',
      splitFromClusterKey: copy.clusterKey,
    });
    h.triageImpl = async () => ({
      verdict: 'REAL_BUG',
      confidence: 0.8,
      explanation: 'split out',
      evidence: [{ kind: 'STEP', ref: '0', detail: 'x' }],
      suspectCommit: null,
      model: 'stub-split',
    });
    await run('tr_1');

    expect(h.triageCalls).toHaveLength(2);
    expect(copy.verdict).toBe('REAL_BUG');
    // A fresh first-hand call is not derived from anything.
    expect(copy.derivedFromId).toBeNull();
  });

  /*
   * A SPLIT WITHHOLDS THE CLUSTER CONTEXT. The reviewer said the cause's answer
   * is wrong for this member, so the cluster size is exactly the evidence that
   * misled the previous call. The cause IDENTITY is still sent — "this has been
   * failing for three weeks" is true of this member too.
   */
  it('withholds the cluster size on a split, but keeps the cause identity', async () => {
    seedResult();
    seedResult();
    await run('tr_0');
    await run('tr_1');

    const copy = verdictFor('tr_1')!;
    applyData(copy, {
      retriageRequestedAt: new Date(),
      retriageRequestedBy: 'u',
      splitFromClusterKey: copy.clusterKey,
    });
    h.triageCalls.length = 0;
    await run('tr_1');

    expect(h.triageCalls).toHaveLength(1);
    expect(h.triageCalls[0]!.cluster).toBeUndefined();
    expect(h.triageCalls[0]!.cause).toMatchObject({ newInThisBuild: true });
  });
});

// ─── (f) The project's own corrections, as a prior ───────────────────────────

describe('override feedback into the prompt', () => {
  /** Reviewed verdicts on this project, from earlier runs. */
  function seedReviewHistory(count: number, over: Row = {}): void {
    for (let i = 0; i < count; i += 1) {
      store.testResult.push({
        id: `hist_tr_${i}`,
        orgId: 'org',
        runId: 'run_old',
        testId: `hist_t_${i}`,
        status: 'FAILED',
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        network: [],
        steps: [],
        findings: [],
        test: {
          id: `hist_t_${i}`,
          projectId: 'p1',
          name: `history ${i}`,
          filePath: 'tests/checkout.spec.ts',
          code: CODE,
          type: 'E2E',
          spec: null,
        },
      });
      store.triageVerdict.push({
        id: `hist_v_${i}`,
        orgId: 'org',
        testResultId: `hist_tr_${i}`,
        verdict: 'FLAKE',
        confidence: 0.6,
        explanation: 'timing',
        model: 'cheap',
        reviewState: 'OVERRIDDEN',
        overriddenTo: 'REAL_BUG',
        reviewedAt: new Date(Date.now() - 86_400_000),
        revision: 1,
        ...over,
      });
    }
  }

  /*
   * THE DEFECT: "nothing reads overriddenTo, so every project re-makes the same
   * wrong call forever". The schema's own comment says the override "is what
   * gates and what trains prompts", and no prompt read it. This is the test
   * that notices if it stops.
   */
  it('feeds the project’s corrections to the prompt as a bounded prior', async () => {
    seedReviewHistory(10);
    seedResult();
    await run('tr_10');

    const corrections = h.triageCalls[0]!.corrections as Row;
    expect(corrections.reviewed).toBe(10);
    expect(corrections.overridden).toBe(10);
    expect(corrections.tooFew).toBeNull();
    expect(corrections.patterns[0]).toMatchObject({
      from: 'FLAKE',
      to: 'REAL_BUG',
      count: 10,
    });
    // The place, so the prior is checkable rather than asserted.
    expect(corrections.patterns[0].where).toContain('checkout.spec.ts');
  });

  it('withholds the prior below the review floor rather than quoting a coincidence', async () => {
    seedReviewHistory(2);
    seedResult();
    await run('tr_2');

    const corrections = h.triageCalls[0]!.corrections as Row;
    expect(corrections.reviewed).toBe(2);
    expect(corrections.tooFew).toMatch(/too few to be a prior/);
    expect(corrections.patterns).toEqual([]);
  });

  /*
   * An unreviewed verdict is not an opinion. Counting PENDING rows would make
   * every project look like it agrees with the model, and the prior would then
   * be a loop that confirms whatever triage already said.
   */
  it('ignores verdicts nobody has reviewed', async () => {
    seedReviewHistory(10, { reviewState: 'PENDING', overriddenTo: null, reviewedAt: null });
    seedResult();
    await run('tr_10');

    expect((h.triageCalls[0]!.corrections as Row).reviewed).toBe(0);
  });
});

// ─── (g) Idempotence, unchanged ──────────────────────────────────────────────

describe('idempotence', () => {
  it('skips a result that already has a verdict and no re-triage request', async () => {
    seedResult();
    await run('tr_0');
    h.triageCalls.length = 0;
    await run('tr_0');

    expect(h.triageCalls).toHaveLength(0);
    expect(store.triageVerdict).toHaveLength(1);
    expect(store.triageVerdictRevision).toHaveLength(0);
  });
});

// ─── (h) The auto-apply wiring, which this change must not disturb ───────────

describe('triage auto-apply wiring', () => {
  beforeEach(() => {
    h.triageImpl = async () => ({
      verdict: 'INTENDED_CHANGE',
      confidence: 0.9,
      explanation: 'selector renamed',
      evidence: [{ kind: 'STEP', ref: '0', detail: 'locator did not resolve' }],
      suspectCommit: null,
      model: 'stub',
    });
  });

  it('auto-applies a clean heal and records the checks in the version message', async () => {
    h.proposalDiff = CLEAN_DIFF;
    seedResult({ testId: 't1', test: specTest() });
    await run('tr_0');

    expect(store.healProposal[0]!.state).toBe('AUTO_APPLIED');
    expect(store.testVersionUpdates).toHaveLength(1);
    const msg = (store.testVersionUpdates[0] as any).data.versions.create.message as string;
    expect(msg).toContain('Checked after patching');
    expect(msg).toContain('no fixed sleep');
  });

  it('refuses to auto-apply a heal that adds a fixed sleep, and says why', async () => {
    h.proposalDiff = SLEEP_DIFF;
    seedResult({ testId: 't1', test: specTest() });
    await run('tr_0');

    expect(store.healProposal[0]!.state).toBe('PROPOSED');
    expect(store.testVersionUpdates).toHaveLength(0);
    expect(store.healProposal[0]!.explanation).toMatch(/Auto-apply was declined/);
    expect(store.healProposal[0]!.explanation).toMatch(/sleeps for a fixed duration/);
    expect(store.healProposal[0]!.explanation).toMatch(/Checked after patching/);
  });

  it('refuses a heal that does not parse', async () => {
    h.proposalDiff = BREAK_DIFF;
    seedResult({ testId: 't1', test: specTest() });
    await run('tr_0');

    expect(store.healProposal[0]!.state).toBe('PROPOSED');
    expect(store.testVersionUpdates).toHaveLength(0);
    expect(store.healProposal[0]!.explanation).toMatch(/does not parse/);
  });
});

/** The diffs above are written against this exact path and code. */
function specTest(): Row {
  return {
    id: 't1',
    projectId: 'p1',
    name: 'checkout',
    filePath: 'tests/checkout.spec.ts',
    code: CODE,
    type: 'E2E',
    spec: null,
  };
}

// ─── (i) The cause owner that never answered ─────────────────────────────────

/**
 * THE DEFECT: `RunFailureCluster.verdictId` was written only by the job that
 * won the INSERT, and only on its first successful pass. A cause whose elected
 * owner never published was therefore never given another one — every later
 * member became a waiter, polled for the full bounded wait, timed out and paid
 * for its own call. One transient model error turned the headline claim (one
 * call per cause) back into the behaviour it was built to replace, and blocked a
 * worker slot per member while doing it.
 *
 * Both triggers are driven through the real processor here, and the assertion is
 * on the model-call ledger, because that is the claim.
 */
describe('a cause whose first owner never publishes', () => {
  const LATE_VERDICT = {
    verdict: 'ENV_ISSUE' as const,
    confidence: 0.9,
    explanation: 'the dependency stopped answering',
    evidence: [{ kind: 'NETWORK' as const, ref: 'r1', detail: 'POST /pay -> 503' }],
    suspectCommit: null,
    model: 'stub-2',
  };

  it('re-elects the next member to publish when the owner’s call throws', async () => {
    // The waiter's bounded wait is irrelevant to the count and would otherwise
    // make this test sleep; the owner is never going to publish.
    CLUSTER_VERDICT_WAIT.totalMs = 0;
    for (let i = 0; i < 5; i += 1) seedResult();

    let first = true;
    h.triageImpl = async () => {
      if (first) {
        first = false;
        throw new Error('529 overloaded');
      }
      return LATE_VERDICT;
    };

    // Exactly what BullMQ sees: the owner's job fails.
    await expect(run('tr_0')).rejects.toThrow('529 overloaded');

    for (const row of store.testResult.slice(1)) await run(row.id);

    const key = keyOf(OUTAGE(0));
    // Two calls: the one that threw, and the one that answered. NOT five.
    expect(h.triageCalls).toHaveLength(2);
    // The answer is the cause's answer, from whoever produced it first.
    expect(claim(key).verdictId).toBe(verdictFor('tr_1')!.id);
    expect(claim(key).resolvedAt).toBeInstanceOf(Date);
    expect(claim(key).attachments).toBe(3);
    expect(claim(key).modelCalls).toBe(1);
    expect(claim(key).members).toBe(5);
    // `ownerResultId` still names the job that won the claim, so the divergence
    // between it and the published verdict is the record of the de-election.
    expect(claim(key).ownerResultId).toBe('tr_0');

    // And the redelivery of the failed job costs nothing: it attaches.
    await run('tr_0');
    expect(h.triageCalls).toHaveLength(2);
    expect(verdictFor('tr_0')!.derivedFromId).toBe(verdictFor('tr_1')!.id);
    expect(store.triageVerdict).toHaveLength(5);
  });

  /**
   * A mute that lapses part-way through a run. The muted first member claims
   * the cause and mints nothing by design, so before this fix every member
   * after the expiry waited out the full bounded wait and then paid.
   */
  it('re-elects after a mute lapses mid-run, instead of paying per member', async () => {
    CLUSTER_VERDICT_WAIT.totalMs = 50;
    seedResult();
    await run('tr_0');

    const key = keyOf(OUTAGE(0));
    applyData(signature(key), {
      mutedUntil: new Date(Date.now() + 86_400_000),
      mutedAt: new Date(),
      mutedBy: 'user_1',
      mutedReason: 'vendor outage, fix lands next sprint',
    });

    store.testResult.length = 0;
    store.triageVerdict.length = 0;
    h.triageCalls.length = 0;
    for (let i = 0; i < 4; i += 1) seedResult({ id: `tr_m${i}`, runId: 'run_2' });
    h.triageImpl = async () => LATE_VERDICT;

    await run('tr_m0', 'run_2');
    expect(h.triageCalls).toHaveLength(0);
    expect(claim(key, 'run_2').suppressed).toBe(true);

    // The mute expires while the run is still executing.
    applyData(signature(key), { mutedUntil: new Date(Date.now() - 1000) });
    for (const id of ['tr_m1', 'tr_m2', 'tr_m3']) await run(id, 'run_2');

    // ONE call for the three remaining members, not three.
    expect(h.triageCalls).toHaveLength(1);
    expect(claim(key, 'run_2').modelCalls).toBe(1);
    expect(claim(key, 'run_2').attachments).toBe(2);
    expect(claim(key, 'run_2').verdictId).toBe(verdictFor('tr_m1')!.id);
    expect(store.triageVerdict).toHaveLength(3);
  });

  /**
   * ...and it does not WAIT first. The suppressed flag says the cause's owner
   * decided not to answer, so polling for its verdict is polling for something
   * nobody is going to write — 20s of a worker slot per member, which is the
   * other half of the measured cost. Counted rather than timed, so the
   * assertion is deterministic.
   */
  it('does not poll for a verdict the muted owner was never going to write', async () => {
    seedResult();
    await run('tr_0');
    const key = keyOf(OUTAGE(0));
    applyData(signature(key), {
      mutedUntil: new Date(Date.now() + 86_400_000),
      mutedReason: 'vendor outage',
    });

    store.testResult.length = 0;
    store.triageVerdict.length = 0;
    h.triageCalls.length = 0;
    seedResult({ id: 'tr_m0', runId: 'run_2' });
    seedResult({ id: 'tr_m1', runId: 'run_2' });
    await run('tr_m0', 'run_2');

    const real = (h.prisma as Row).runFailureCluster as Row;
    let polls = 0;
    (h.prisma as Row).runFailureCluster = {
      ...real,
      findUnique: async (args: Row = {}) => {
        // The wait's own read is the only one that selects verdictId alone.
        if (args.select?.verdictId) polls += 1;
        return real.findUnique(args);
      },
    };

    applyData(signature(key), { mutedUntil: new Date(Date.now() - 1000) });
    await run('tr_m1', 'run_2');

    expect(polls).toBe(0);
    expect(h.triageCalls).toHaveLength(1);
    expect(claim(key, 'run_2').verdictId).toBe(verdictFor('tr_m1')!.id);
  });

  /**
   * The condition is in the WHERE, not in an if: two members finishing their
   * own calls at the same instant must not overwrite each other's answer. The
   * loser's verdict stays on its own result — reviewable, costed and counted —
   * and the cause keeps the first answer published.
   */
  /**
   * The third de-election path, and the one the two above do not reach: the
   * owner's CALL succeeded and the write that publishes its answer did not.
   * The redelivery of that job used to return at the idempotence skip without
   * ever publishing the verdict it found, leaving a cause that reported no
   * answer while holding a paid-for one — and charging the next member for a
   * second call to produce the answer that already existed.
   */
  it('finishes an election that never landed, instead of paying again', async () => {
    CLUSTER_VERDICT_WAIT.totalMs = 0;
    for (let i = 0; i < 5; i += 1) seedResult();

    const real = (h.prisma as Row).runFailureCluster as Row;
    let breakElection = true;
    (h.prisma as Row).runFailureCluster = {
      ...real,
      updateMany: async (args: Row = {}) => {
        // Only the publish, and only once: the model call has already been
        // made and paid for by the time this throws.
        if (breakElection && args.data?.verdictId) {
          breakElection = false;
          throw new Error('connection reset publishing the election');
        }
        return real.updateMany(args);
      },
    };

    await expect(run('tr_0')).rejects.toThrow('connection reset');
    const owned = verdictFor('tr_0')!.id;
    const key = keyOf(OUTAGE(0));
    expect(claim(key).verdictId).toBeNull();

    // Exactly what BullMQ does next.
    await run('tr_0');

    // The redelivery publishes the answer it found rather than only skipping.
    expect(claim(key).verdictId).toBe(owned);
    expect(claim(key).resolvedAt).toBeInstanceOf(Date);
    // ...and it does NOT buy another one to do it.
    expect(h.triageCalls).toHaveLength(1);
    expect(store.triageVerdict).toHaveLength(1);

    // So the other four members attach for free: ONE call for the cause.
    for (const row of store.testResult.slice(1)) await run(row.id);
    expect(h.triageCalls).toHaveLength(1);
    expect(claim(key).modelCalls).toBe(1);
    expect(claim(key).attachments).toBe(4);
    // And publishing on the skip does not re-count the member: the skip fires
    // BEFORE `claimCause`, so the redelivery adds no occurrence of its own.
    expect(claim(key).members).toBe(5);
    expect(signature(key).occurrenceCount).toBe(5);
  });

  /**
   * ...but a re-triage is still never published cause-wide, and the skip is a
   * real back door onto that rule rather than a hypothetical one.
   *
   * `supersedeVerdict` CLEARS `retriageRequestedAt`, so once a re-triage has
   * run, the next redelivery of its job reaches the idempotence skip looking
   * exactly like a first answer. Reached here the only way it can be: the
   * election write fails (so the cause has no answer), a reviewer requests a
   * fresh look at the verdict that is sitting there unpublished, and the
   * redelivery after that re-triage arrives with the request column already
   * cleared. `revision` is the only thing left that tells the two apart, and
   * publishing one reviewer's answer about one member as the whole cause's is
   * what the election's `!retriage` exists to prevent.
   */
  it('does not publish a redelivered re-triage as the whole cause’s answer', async () => {
    CLUSTER_VERDICT_WAIT.totalMs = 0;
    seedResult();

    const real = (h.prisma as Row).runFailureCluster as Row;
    let breakElection = true;
    (h.prisma as Row).runFailureCluster = {
      ...real,
      updateMany: async (args: Row = {}) => {
        if (breakElection && args.data?.verdictId) {
          breakElection = false;
          throw new Error('connection reset publishing the election');
        }
        return real.updateMany(args);
      },
    };

    await expect(run('tr_0')).rejects.toThrow('connection reset');
    const key = keyOf(OUTAGE(0));
    expect(claim(key).verdictId).toBeNull();

    // A reviewer reads the unpublished verdict and asks for a fresh look.
    applyData(verdictFor('tr_0')!, {
      retriageRequestedAt: new Date(),
      retriageRequestedBy: 'user_1',
      retriageReason: 'ENV_ISSUE is wrong, the selector moved',
    });
    h.triageImpl = async () => LATE_VERDICT;

    // The redelivery takes the re-triage path: fresh answer, no election.
    await run('tr_0');
    expect(verdictFor('tr_0')!.revision).toBe(2);
    expect(verdictFor('tr_0')!.retriageRequestedAt).toBeNull();
    expect(claim(key).verdictId).toBeNull();

    // And the redelivery AFTER that — the one the request column no longer
    // marks — must leave it alone.
    await run('tr_0');
    expect(claim(key).verdictId).toBeNull();
    expect(claim(key).resolvedAt).toBeNull();
    expect(h.triageCalls).toHaveLength(2);
  });

  it('publishes the first answer only, and does not overwrite it', async () => {
    CLUSTER_VERDICT_WAIT.totalMs = 0;
    seedResult();
    seedResult();
    seedResult();

    let n = 0;
    h.triageImpl = async () => {
      n += 1;
      throw new Error(`model down ${n}`);
    };
    await expect(run('tr_0')).rejects.toThrow('model down 1');

    h.triageImpl = async () => LATE_VERDICT;
    await run('tr_1');
    const elected = verdictFor('tr_1')!.id;

    // A third member whose own wait expires before tr_1 published would mint
    // its own verdict too; simulated by hiding the published answer from it.
    const real = (h.prisma as Row).runFailureCluster as Row;
    (h.prisma as Row).runFailureCluster = {
      ...real,
      findUnique: async (args: Row = {}) => {
        const found = await real.findUnique(args);
        return found ? { ...found, verdictId: null } : found;
      },
    };
    await run('tr_2');

    const key = keyOf(OUTAGE(0));
    expect(claim(key).verdictId).toBe(elected);
    expect(verdictFor('tr_2')!.derivedFromId).toBeNull();
    expect(claim(key).modelCalls).toBe(2);
  });
});

// ─── (j) Named decisions that survived reversion ─────────────────────────────

describe('a re-triage of a muted cause', () => {
  /** The live verdict on tr_0, with a human's re-triage request stamped on it. */
  async function mutedWithRequest(): Promise<{ key: string; live: Row }> {
    seedResult();
    await run('tr_0');
    const key = keyOf(OUTAGE(0));
    applyData(signature(key), {
      mutedUntil: new Date(Date.now() + 86_400_000),
      mutedAt: new Date(),
      mutedBy: 'user_1',
      mutedReason: 'known issue',
    });
    const live = verdictFor('tr_0')!;
    applyData(live, {
      retriageRequestedAt: new Date(),
      retriageRequestedBy: 'user_7',
      retriageReason: 'is it really the vendor?',
    });
    h.triageCalls.length = 0;
    h.triageImpl = async () => ({
      verdict: 'REAL_BUG',
      confidence: 0.8,
      explanation: 'the service was healthy',
      evidence: [{ kind: 'STEP', ref: '0', detail: 'x' }],
      suspectCommit: null,
      model: 'stub-fresh',
    });
    return { key, live };
  }

  /*
   * A RE-TRIAGE OVERRIDES THE MUTE. Asking for a fresh verdict on a muted cause
   * is an explicit, audited human act; refusing it would make the mute the one
   * state from which a reviewer cannot ask a question, and the "re-run triage"
   * button a silent no-op. Nothing in the suite noticed when this was removed.
   */
  it('is honoured, and mints the fresh verdict', async () => {
    const { live } = await mutedWithRequest();
    await run('tr_0');

    expect(h.triageCalls).toHaveLength(1);
    expect(live.verdict).toBe('REAL_BUG');
    expect(live.revision).toBe(2);
    expect(live.retriageRequestedAt).toBeNull();
  });

  /*
   * ...and the mute's books are not touched by it. A re-triage is not a failure
   * the mute swallowed, so counting it would inflate the one number that says
   * whether a mute is still worth having.
   */
  it('records no suppression for a failure it did not swallow', async () => {
    const { key } = await mutedWithRequest();
    await run('tr_0');

    expect(signature(key).suppressedCount).toBe(0);
    expect(claim(key).suppressed).toBe(false);
    expect(h.events.some((e) => e.type === 'verdict.suppressed')).toBe(false);
  });
});

describe('re-triage accounting', () => {
  /*
   * A RE-TRIAGE MUST NOT RE-COUNT AN OCCURRENCE IT ALREADY COUNTED. The counts
   * are "how often has this cause fired", and asking the model to look again is
   * not the cause firing again — a project that re-triages a flaky cause twice
   * would otherwise read as one that failed three times as often.
   */
  it('does not count the same failure twice', async () => {
    seedResult();
    await run('tr_0');
    const key = keyOf(OUTAGE(0));
    expect(signature(key).occurrenceCount).toBe(1);

    applyData(verdictFor('tr_0')!, {
      retriageRequestedAt: new Date(),
      retriageRequestedBy: 'user_7',
    });
    await run('tr_0');

    expect(signature(key).occurrenceCount).toBe(1);
    expect(signature(key).runCount).toBe(1);
    expect(claim(key).members).toBe(1);
  });
});

// ─── (k) The figures the prompt is given about the cluster ───────────────────

/**
 * Four numbers go into the model's cluster evidence and no test asserted any of
 * them, so the evidence could be silently corrupted — `retriedAndPassed` could
 * become a constant 0 and the only sign would be a worse verdict.
 */
describe('the cluster evidence the prompt is given', () => {
  it('counts the members that passed on retry', async () => {
    for (let i = 0; i < 3; i += 1) seedResult();
    // §5: a retry that passes is not a pass, so FLAKY is a member of the cause.
    seedResult({ status: 'FLAKY', retriedAndPassed: true });
    seedResult({ status: 'FLAKY', retriedAndPassed: true });
    await run('tr_0');

    const cluster = h.triageCalls[0]!.cluster as Row;
    expect(cluster.memberCount).toBe(5);
    expect(cluster.retriedAndPassed).toBe(2);
  });

  it('names the test being triaged first, and names it once', async () => {
    for (let i = 0; i < 3; i += 1) seedResult();
    await run('tr_1');

    const cluster = h.triageCalls[0]!.cluster as Row;
    // The model reads the first names, and the evidence it is about to see
    // belongs to this test.
    expect(cluster.memberNames[0]).toBe('checkout 1');
    expect(new Set(cluster.memberNames).size).toBe((cluster.memberNames as string[]).length);
  });

  it('counts only this cause, not every failure in the run', async () => {
    for (let i = 0; i < 3; i += 1) seedResult();
    seedResult({ errorMessage: OTHER_CAUSE });
    seedResult({ errorMessage: OTHER_CAUSE });
    await run('tr_0');

    const cluster = h.triageCalls[0]!.cluster as Row;
    expect(cluster.memberCount).toBe(3);
    expect(cluster.memberNames).toHaveLength(3);
    expect(cluster.memberNames).not.toContain('checkout 3');
  });

  /*
   * A cause whose evidence will not cluster still covers THIS test. One, never
   * zero: a zero beside a one-name list is a contradiction, and "this cause
   * covers no tests" is not a thing that can be true of a failing test.
   */
  it('reports a cause of one as one', async () => {
    seedResult({ errorMessage: null, steps: [] });
    await run('tr_0');

    const cluster = h.triageCalls[0]!.cluster as Row;
    expect(cluster.memberCount).toBe(1);
    expect(cluster.memberNames).toEqual(['checkout 0']);
  });
});

// ─── (l) The heal hand-off ───────────────────────────────────────────────────

const INTENDED_CHANGE = {
  verdict: 'INTENDED_CHANGE' as const,
  confidence: 0.9,
  explanation: 'the selector was renamed',
  evidence: [{ kind: 'STEP' as const, ref: '0', detail: 'locator did not resolve' }],
  suspectCommit: null,
  model: 'stub',
};

/** A patch against code this test does not contain: stale by definition. */
const STALE_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -5,1 +5,1 @@',
  "-  await expect(page.getByTestId('order-grand-total')).toHaveText('$99.00');",
  "+  await expect(page.getByTestId('checkout-total')).toHaveText('$99.00');",
].join('\n');

function openProposal(over: Row = {}): Row {
  const row = {
    id: `hp_${store.healProposal.length}`,
    orgId: 'org',
    testId: 't1',
    verdictId: 'v_old',
    state: 'PROPOSED',
    riskLevel: 'LOW',
    diff: CLEAN_DIFF,
    explanation: 'retarget the total',
    confidence: 0.9,
    appliedVersion: null,
    supersededById: null,
    decidedAt: null,
    verifyState: null,
    verifyRunId: null,
    verifyNote: null,
    verifiedAt: null,
    createdAt: new Date('2026-10-23T12:00:00.000Z'),
    ...over,
  };
  store.healProposal.push(row);
  return row;
}

describe('a test that already has an open heal proposal', () => {
  beforeEach(() => {
    h.triageImpl = async () => INTENDED_CHANGE;
  });

  /*
   * THE DEFECT: triage's idempotence is per TEST RESULT, and a test that fails
   * every run produces a new result every run — so this path bought a fresh
   * strong-tier Healer call every run and put fifty rows describing one broken
   * test in the review queue. The guard is asked BEFORE the call, which is the
   * only ordering in which it saves anything.
   */
  it('does not buy a second proposal while the open one still applies', async () => {
    openProposal();
    seedResult({ testId: 't1', test: specTest() });
    await run('tr_0');

    expect(h.healCalls).toBe(0);
    expect(store.healProposal).toHaveLength(1);
    // The verdict is unaffected: the saving is on the heal, not on the triage.
    expect(verdictFor('tr_0')!.verdict).toBe('INTENDED_CHANGE');
  });

  /*
   * A proposal whose diff no longer fits the file is stale by definition — the
   * test changed underneath it — so a fresh one is worth paying for, and the
   * stale row must stop waiting for a decision in the same write. Two rows for
   * one test is the other half of the queue-clutter defect.
   */
  it('proposes afresh when the open one no longer applies, and supersedes it atomically', async () => {
    const stale = openProposal({ diff: STALE_DIFF });
    seedResult({ testId: 't1', test: specTest() });
    await run('tr_0');

    expect(h.healCalls).toBe(1);
    expect(store.healProposal).toHaveLength(2);

    const fresh = store.healProposal.find((p) => p.id !== stale.id)!;
    expect(stale.state).toBe('SUPERSEDED');
    expect(stale.supersededById).toBe(fresh.id);
    expect(stale.decidedAt).toBeInstanceOf(Date);
    /*
     * TWO transactions in the whole job, each of two statements: the occurrence
     * counters, then the heal. The second one is the claim being made here —
     * the new row and the closing of the old one move together or not at all —
     * and the exact list is asserted so splitting it into two awaits fails
     * rather than leaving a plausible-looking `at(-1)` behind.
     */
    expect(store.transactions).toEqual([2, 2]);
  });

  it('leaves an open proposal of its own alone when nothing is stale', async () => {
    seedResult({ testId: 't1', test: specTest() });
    await run('tr_0');

    expect(store.healProposal).toHaveLength(1);
    expect(store.healProposal[0]!.state).toBe('AUTO_APPLIED');
    expect(store.healProposal[0]!.supersededById).toBeNull();
  });
});

describe('a heal that cannot be produced', () => {
  /*
   * A FAILED HEAL MUST NOT FAIL TRIAGE — the verdict is the valuable part, and
   * a job that threw here would be retried, re-triaged and would buy the
   * verdict a second time to arrive at the same place.
   */
  it('does not take the verdict down with it', async () => {
    h.triageImpl = async () => INTENDED_CHANGE;
    h.healError = new Error('the healer is unreachable');
    seedResult({ testId: 't1', test: specTest() });

    await expect(run('tr_0')).resolves.toBeUndefined();
    expect(verdictFor('tr_0')!.verdict).toBe('INTENDED_CHANGE');
    expect(store.healProposal).toHaveLength(0);
  });
});

describe('an unattended heal', () => {
  beforeEach(() => {
    h.triageImpl = async () => INTENDED_CHANGE;
    h.proposalDiff = CLEAN_DIFF;
    h.auto = true;
  });

  /*
   * AUTO_APPLIED USED TO BE A CLAIM NOBODY CHECKED. The reviewed path started a
   * verifying run and the sweep reverted a heal that did not work; this path
   * wrote a model's patch into the customer's test, recorded success and never
   * ran the test again. `verifyAppliedHeals` only chases PENDING rows, so until
   * this landed it never saw an unattended one.
   */
  it('starts a verifying run and records what it is waiting on', async () => {
    seedResult({ testId: 't1', test: specTest() });
    await run('tr_0');

    const heal = store.healProposal[0]!;
    expect(heal.state).toBe('AUTO_APPLIED');
    // The version the patch wrote: without it the sweep cannot revert.
    expect(heal.appliedVersion).toBe(4);
    expect(heal.verifyState).toBe('PENDING');
    expect(heal.verifiedAt).toBeNull();

    expect(store.runs).toHaveLength(1);
    const created = store.runs[0]!;
    expect(heal.verifyRunId).toBe(created.id);
    // Tagged so the sweep can find its way back from the run to the proposal.
    expect(created.triggeredBy).toBe(verificationRunTag(heal.id));
    expect(created.environmentId).toBe('env_1');
    expect(created.results.create[0].testId).toBe('t1');
    expect(h.enqueued).toEqual([{ runId: created.id, background: true }]);
    // A verification run is a Run: it costs a browser and it is metered.
    expect(store.metered).toHaveLength(1);
  });

  /*
   * "WE COULD NOT LOOK" IS ITS OWN ANSWER. A test that has never run has no
   * environment to re-run it in, and guessing one would mean running the
   * customer's test against a URL nobody chose. UNVERIFIABLE, stamped — never
   * PENDING, which the sweep would chase forever, and never VERIFIED.
   */
  it('says nobody checked when there is no environment to re-run in', async () => {
    h.environmentId = null;
    seedResult({ testId: 't1', test: specTest() });
    await run('tr_0');

    const heal = store.healProposal[0]!;
    expect(heal.state).toBe('AUTO_APPLIED');
    expect(heal.verifyState).toBe('UNVERIFIABLE');
    expect(heal.verifyRunId).toBeNull();
    expect(heal.verifiedAt).toBeInstanceOf(Date);
    expect(heal.verifyNote).toMatch(/nobody has checked it/);
    expect(store.runs).toHaveLength(0);
    expect(h.enqueued).toHaveLength(0);
  });

  /*
   * A proposal a human still has to approve has had NOTHING applied, so there
   * is nothing to verify. NULL, not UNVERIFIABLE: "nobody applied this" and
   * "this was applied and nobody could check it" are different facts, and the
   * verify column exists to keep them apart.
   */
  it('starts nothing for a proposal that was not applied', async () => {
    h.proposalDiff = SLEEP_DIFF;
    seedResult({ testId: 't1', test: specTest() });
    await run('tr_0');

    const heal = store.healProposal[0]!;
    expect(heal.state).toBe('PROPOSED');
    expect(heal.verifyState).toBeNull();
    expect(heal.appliedVersion).toBeNull();
    expect(store.runs).toHaveLength(0);
  });
});
