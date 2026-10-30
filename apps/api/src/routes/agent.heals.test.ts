import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_PREFIX, PLAN_LIMITS } from '@qaai/shared';

type Row = Record<string, any>;

interface Hoisted {
  db: Record<string, unknown>;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  /** Every job the route produced: queue, payload and BullMQ options. */
  enqueued: Array<{ queue: string; payload: unknown; opts: unknown }>;
}

const h = vi.hoisted(
  (): Hoisted => ({
    db: {},
    actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
    audits: [],
    enqueued: [],
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
  logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} },
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
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) => store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

vi.mock('../lib/queues.js', () => ({
  /*
   * RECORDED, not swallowed. The apply path no longer starts the verification
   * run inline — it enqueues `qaai.verify-heal` — so this mock's arguments are
   * the only evidence that anything will ever re-measure the patch.
   */
  enqueue: async (queue: string, payload: unknown, opts: unknown) => {
    h.enqueued.push({ queue, payload, opts });
    return 'job_1';
  },
}));
vi.mock('../lib/storage.js', () => ({ storage: {} }));
vi.mock('../lib/events.js', () => ({ publish: () => {}, subscribe: () => () => {} }));
vi.mock('../lib/audit.js', () => ({
  audit: async (entry: Row) => {
    h.audits.push(entry);
  },
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
const { agentRouter } = await import('./agent.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/agent', agentRouter);
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

const CODE = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('checkout charges the right total', async ({ page }) => {",
  "  await page.goto('/checkout');",
  "  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  '});',
].join('\n');

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

/**
 * A heal row as the routes read it, including the columns added with heal
 * verification and superseding.
 */
function healRow(over: Row = {}): Row {
  return {
    id: 'heal_1',
    orgId: 'org_1',
    testId: 't1',
    verdictId: null,
    diff: CLEAN_DIFF,
    explanation: 'retarget the total',
    riskLevel: 'SELECTOR_ONLY',
    confidence: 0.9,
    state: 'PROPOSED',
    supersededById: null,
    appliedVersion: null,
    verifyRunId: null,
    verifyState: null,
    verifiedAt: null,
    verifyNote: null,
    evidence: null,
    createdAt: new Date('2026-10-22T10:00:00Z'),
    test: {
      id: 't1',
      name: 'checkout',
      filePath: 'tests/checkout.spec.ts',
      code: CODE,
      type: 'E2E',
      spec: null,
      projectId: 'proj_1',
    },
    ...over,
  };
}

const RETIRE_HEAL = healRow({
  id: 'heal_retire',
  riskLevel: 'RETIRE',
  diff: '',
  explanation: '"checkout" drives a route the application no longer has (/checkout).',
  confidence: 0.9,
  evidence: { kind: 'RETIREMENT', routes: [{ route: '/checkout', reached: false }] },
});

interface Scenario {
  /** The row every heal read returns. */
  heal?: Row;
  /** Other open proposals for the same test — the supersede candidates. */
  openHeals?: Row[];
  /** False when the test has never run, so there is no environment to re-run in. */
  hasPreviousRun?: boolean;
  /** The org's plan and month-to-date run count, as the run toll reads them. */
  plan?: string;
  runsThisMonth?: number;
}

const calls = {
  testUpdates: [] as Row[],
  healUpdates: [] as Row[],
  healUpdateMany: [] as Row[],
  runsCreated: [] as Row[],
  metered: [] as string[],
};

function install(scenario: Scenario = {}): void {
  calls.testUpdates.length = 0;
  calls.healUpdates.length = 0;
  h.enqueued.length = 0;
  calls.healUpdateMany.length = 0;
  calls.runsCreated.length = 0;
  calls.metered.length = 0;

  const heal = scenario.heal ?? healRow();

  h.db = {
    healProposal: {
      /*
       * Two callers, told apart the way Prisma itself would: the list route
       * joins the test (`include`), `openHealsFor` selects columns. Modelled
       * rather than collapsed, because the list route returning the supersede
       * candidates is how the first version of this fake made six tests pass
       * for the wrong reason.
       */
      findMany: async (args: Row = {}) =>
        args.include ? [heal] : (scenario.openHeals ?? []),
      findUnique: async () => heal,
      update: async (args: Row) => {
        calls.healUpdates.push(args);
        return { id: heal.id, state: 'APPLIED' };
      },
      updateMany: async (args: Row) => {
        calls.healUpdateMany.push(args);
        return { count: (args.where?.id?.in ?? []).length };
      },
    },
    testVersion: { findFirst: async () => ({ version: 3 }) },
    test: {
      update: async (args: Row) => {
        calls.testUpdates.push(args);
        return {};
      },
    },
    testResult: {
      findFirst: async () =>
        scenario.hasPreviousRun === false ? null : { run: { environmentId: 'env_1' } },
    },
    run: {
      create: async (args: Row) => {
        calls.runsCreated.push(args.data);
        return { id: 'run_verify_1' };
      },
      update: async () => ({}),
    },
    // Billing, as the run toll reads it. A verification run is a run: it costs a
    // browser and it belongs on the bill.
    subscription: { findUnique: async () => null },
    organization: { findUnique: async () => ({ plan: scenario.plan ?? 'ENTERPRISE' }) },
    usageRecord: {
      findUnique: async () => ({ quantity: BigInt(scenario.runsThisMonth ?? 0) }),
      upsert: async (args: Row) => {
        calls.metered.push(String(args.where.orgId_metric_period.metric));
        return {};
      },
    },
    $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  };
}

beforeEach(() => {
  h.audits.length = 0;
});

describe('GET /agent/heals preview', () => {
  it('carries the gate flags and the checks that ran', async () => {
    install({ heal: healRow({ diff: SLEEP_DIFF }) });
    const { body } = await call('/agent/heals');

    expect(body.heals[0].preview.applies).toBe(true);
    expect(body.heals[0].preview.kind).toBe('PATCH');
    expect(String(body.heals[0].preview.flags.join(' '))).toMatch(/sleeps for a fixed duration/);
    expect(String(body.heals[0].preview.checks)).toContain('Checked after patching');
  });

  it('marks a heal that does not parse as not applicable, with the reason', async () => {
    install({ heal: healRow({ diff: BREAK_DIFF }) });
    const { body } = await call('/agent/heals');

    expect(body.heals[0].preview.applies).toBe(false);
    expect(String(body.heals[0].preview.reason)).toMatch(/does not parse/);
  });

  it('says nobody has verified an applied heal, rather than nothing at all', async () => {
    // THE DEFECT: `state: APPLIED` was a claim nobody checked, and the screen
    // showed it as a handled problem.
    install({ heal: healRow({ state: 'APPLIED', verifyState: null }) });
    const { body } = await call('/agent/heals?state=all');

    expect(body.heals[0].verification.claimsFixed).toBe(false);
    expect(String(body.heals[0].verification.note)).toMatch(/nobody has confirmed/);
  });

  it('claims a heal is fixed only when a run executed the test and it passed', async () => {
    install({
      heal: healRow({
        state: 'APPLIED',
        verifyState: 'VERIFIED',
        verifyNote: 'The heal works: the test passed in the verifying run.',
        verifyRunId: 'run_9',
      }),
    });
    const { body } = await call('/agent/heals?state=all');
    expect(body.heals[0].verification.claimsFixed).toBe(true);
    expect(body.heals[0].verification.runId).toBe('run_9');
  });

  it('does not claim a heal is fixed when the verification could not run', async () => {
    install({
      heal: healRow({ state: 'AUTO_APPLIED', verifyState: 'UNVERIFIABLE', verifyNote: 'no env' }),
    });
    const { body } = await call('/agent/heals?state=all');
    expect(body.heals[0].verification.claimsFixed).toBe(false);
    expect(body.heals[0].verification.state).toBe('UNVERIFIABLE');
  });

  it('refuses to interpret a verification state it does not recognise', async () => {
    // `verifyState` is a TEXT column whose domain is enforced at the producer, so
    // the read end has to cope with a value it has never heard of — and must not
    // let it fall through into "not verified", which reads as a measured failure.
    install({ heal: healRow({ state: 'APPLIED', verifyState: 'LOOKS_FINE' }) });
    const { body } = await call('/agent/heals?state=all');

    expect(body.heals[0].verification.claimsFixed).toBe(false);
    expect(String(body.heals[0].verification.note)).toMatch(/does not recognise/);
    expect(String(body.heals[0].verification.note)).toMatch(/nothing can be concluded/);
  });

  it('never runs a retirement through the applier', async () => {
    // It carries no diff, so the applier would refuse it for having none and the
    // row would render as "this heal is broken" — wrong, and not actionable.
    install({ heal: RETIRE_HEAL });
    const { body } = await call('/agent/heals');

    expect(body.heals[0].preview.kind).toBe('RETIREMENT');
    expect(body.heals[0].preview.applies).toBe(true);
    expect(body.heals[0].preview.code).toBeNull();
    expect(body.heals[0].preview.reason).toBeNull();
    // And the one thing a reviewer must read before accepting it.
    expect(String(body.heals[0].preview.review)).toMatch(/could not REACH looks very like/);
    expect(String(body.heals[0].preview.checks)).toMatch(/a retirement changes no code/i);
  });
});

describe('POST /agent/heals/:id/decide', () => {
  it('422s a heal whose patched file does not parse', async () => {
    install({ heal: healRow({ diff: BREAK_DIFF }) });
    const { status, body } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(status).toBe(422);
    expect(String(body.error?.message)).toMatch(/does not parse/);
    expect(calls.testUpdates).toHaveLength(0);
    // Nothing was applied, so nothing may have been queued to verify.
    expect(calls.runsCreated).toHaveLength(0);
  });

  it('applies a flagged heal and records the flags and checks', async () => {
    install({ heal: healRow({ diff: SLEEP_DIFF }) });
    const { status, body } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(status).toBe(200);
    expect(calls.testUpdates).toHaveLength(1);
    const data = calls.testUpdates[0]!.data;
    expect(String(data.versions.create.message)).toMatch(/sleeps for a fixed duration/);
    expect(String(data.versions.create.message)).toContain('Checked after patching');
    expect(String(data.reviewFlags.join(' '))).toMatch(/sleeps for a fixed duration/);
    expect(String(body.note)).toMatch(/sleeps for a fixed duration/);
    expect(h.audits[0]!.metadata.checks).toContain('Checked after patching');
  });

  it('applies a clean heal with no flags but still records what ran', async () => {
    install();
    const { status } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(status).toBe(200);
    const data = calls.testUpdates[0]!.data;
    expect(data.reviewFlags).toEqual([]);
    expect(String(data.versions.create.message)).toContain('Checked after patching');
  });
});

describe('verifying an applied heal', () => {
  /*
   * ── THE CONTRACT CHANGED, AND IT CHANGED ON PURPOSE ───────────────────────
   *
   * This route used to START THE RUN INLINE through a module-local
   * `startHealVerification` — the THIRD copy of that function, beside one in
   * apps/worker/src/processors/triage.ts and the real one in
   * processors/verify-heal.ts that nothing imported. Two of the three each wrote
   * the same four `verifyState` columns afterwards, which is how `verifiedAt`
   * came to be stamped on one path and not the other.
   *
   * The inline call also had a hole the comment above it admitted: a crash
   * between writing the patch and starting the run left `verifyState` NULL, and
   * a NULL row is invisible to `verifyAppliedHeals` — a model's patch sitting in
   * a customer's test with nothing that would ever re-measure it. A JOB survives
   * that crash.
   *
   * So this route now ENQUEUES, and what it owes is narrower and checkable: ask
   * for the verification, de-duplicate per heal, and CLAIM NOTHING about a run
   * that does not exist yet. The three behaviours the old tests covered — a test
   * that never ran is UNVERIFIABLE, the quota never refuses the approval — are
   * the consumer's, and are tested in processors/verify-heal.test.ts.
   */
  it('asks for the verification through the queue, instead of a third copy of the start', async () => {
    install();
    const { body } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    // NO RUN IS CREATED HERE any more. The consumer creates it.
    expect(calls.runsCreated).toHaveLength(0);

    expect(h.enqueued).toHaveLength(1);
    const job = h.enqueued[0]!;
    expect(job.queue).toBe('qaai.verify-heal');
    expect(job.payload).toEqual({ orgId: 'org_1', healId: 'heal_1', reason: 'APPLY' });

    /*
     * BOTH REMOVAL FLAGS, on a per-entity job id. A BullMQ job id is a Redis
     * key: with `removeOnComplete` alone, a FAILED first verification keeps the
     * id and every later verification of that heal is silently dropped for
     * ever while `add()` still returns an id. That is a heal nothing ever
     * re-measures — the defect the queue exists to close.
     */
    expect(job.opts).toEqual({
      jobId: 'verify-heal-heal_1',
      removeOnComplete: true,
      removeOnFail: true,
    });

    /*
     * AND NO CLAIM ABOUT A STATE THAT DOES NOT EXIST. This used to write
     * `verifyState: 'PENDING'` here; at this instant the column is NULL and
     * there is no run, so PENDING would be a thing reported as measured that
     * was not measured. The CONSUMER is the one writer of those four columns.
     */
    expect(
      calls.healUpdates.find((args) => args.data.verifyState !== undefined),
    ).toBeUndefined();
    expect(String(body.note)).toMatch(/nothing has confirmed the fix yet/);

    // The audit row makes the weakest true claim and no stronger one.
    expect(h.audits[0]!.metadata.verification).toEqual({
      state: null,
      runId: null,
      requested: true,
    });
  });

  it('leaves `verifyState` NULL, which is the state the hole sweep recovers', async () => {
    /*
     * NULL IS LOAD-BEARING. The sweep in apps/worker/src/processors/flake.ts
     * looks for exactly `verifyState: null` on a recently-decided heal and
     * starts the verification itself. Writing UNVERIFIABLE here when the
     * enqueue fails would make the row invisible to the only thing that would
     * have rescued it.
     */
    install();
    await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    for (const update of calls.healUpdates) {
      expect(update.data.verifyState).toBeUndefined();
      expect(update.data.verifyRunId).toBeUndefined();
      expect(update.data.verifiedAt).toBeUndefined();
    }
  });

  it('records the version it wrote, so a failed verification can be reverted', async () => {
    install();
    await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    const applied = calls.healUpdates.find((args) => args.data.state === 'APPLIED')!;
    expect(applied.data.appliedVersion).toBe(4); // testVersion.findFirst said 3
    expect(h.audits[0]!.metadata.appliedVersion).toBe(4);
  });

  it('still applies the patch when the test has never run — the environment is the consumer problem', async () => {
    /*
     * "This test has never run, so there is no environment to re-run it in" is
     * now `startHealVerification`'s answer in processors/verify-heal.ts, which
     * writes UNVERIFIABLE itself (pinned in processors/verify-heal.test.ts).
     * What this route owes is that the APPLY still succeeds and the
     * verification is still asked for: the alternative — deciding here that
     * nothing can check it — would need this file to re-read the environment,
     * which is the duplication the collapse removed.
     */
    install({ hasPreviousRun: false });
    const { status, body } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(status).toBe(200);
    expect(calls.testUpdates).toHaveLength(1);
    expect(calls.runsCreated).toHaveLength(0);
    expect(h.enqueued).toHaveLength(1);
    expect(String(body.note)).toMatch(/nothing has confirmed the fix yet/);
  });

  it('never refuses the approval because the org is out of runs', async () => {
    /*
     * The toll is advisory on purpose: throwing 402 would refuse the FIX over
     * the VERIFICATION and leave the customer with a broken test and a billing
     * message. The quota is now the CONSUMER's to meter — it is the thing that
     * creates the run — and what this route must not do is let the quota reach
     * the approval at all. Nothing here reads a plan limit any more, which is
     * the strongest form of that guarantee.
     */
    install({ plan: 'FREE', runsThisMonth: PLAN_LIMITS.FREE.maxRunsPerMonth ?? 100 });
    const { status } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(status).toBe(200);
    expect(calls.testUpdates).toHaveLength(1);
    // No run created, nothing metered, and the verification still requested.
    expect(calls.runsCreated).toHaveLength(0);
    expect(calls.metered).toEqual([]);
    expect(h.enqueued).toHaveLength(1);
  });
});

describe('superseding on apply', () => {
  it('closes the other open proposals for the same test', async () => {
    install({
      openHeals: [
        { id: 'older', state: 'PROPOSED', riskLevel: 'SELECTOR_ONLY', diff: CLEAN_DIFF, createdAt: new Date('2026-10-20T10:00:00Z') },
        { id: 'heal_1', state: 'PROPOSED', riskLevel: 'SELECTOR_ONLY', diff: CLEAN_DIFF, createdAt: new Date('2026-10-22T10:00:00Z') },
      ],
    });
    const { body } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    const supersede = calls.healUpdateMany[0]!;
    expect(supersede.where.id.in).toEqual(['older']);
    expect(supersede.data).toMatchObject({ state: 'SUPERSEDED', supersededById: 'heal_1' });
    expect(h.audits[0]!.metadata.superseded).toEqual(['older']);
    expect(String(body.note)).toMatch(/1 other open proposal/);
  });

  it('leaves an open retirement alone: it is a different question', async () => {
    install({
      openHeals: [
        { id: 'retire', state: 'PROPOSED', riskLevel: 'RETIRE', diff: '', createdAt: new Date('2026-10-20T10:00:00Z') },
      ],
    });
    await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });
    expect(calls.healUpdateMany[0]!.where.id.in).toEqual([]);
  });
});

describe('accepting a retirement', () => {
  it('disables the test instead of deleting it, and verifies nothing', async () => {
    install({ heal: RETIRE_HEAL });
    const { status, body } = await call('/agent/heals/heal_retire/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(status).toBe(200);
    // Disabled — reversible. Nothing about the code or its history is touched.
    expect(calls.testUpdates).toHaveLength(1);
    expect(calls.testUpdates[0]!.where.id).toBe('t1');
    expect(Object.keys(calls.testUpdates[0]!.data)).toEqual(['disabledAt']);
    expect(calls.testUpdates[0]!.data.disabledAt).toBeInstanceOf(Date);

    // And no verification is claimed: there is no code change to re-run.
    const update = calls.healUpdates[0]!;
    expect(update.data.state).toBe('APPLIED');
    expect(update.data.verifyState).toBeUndefined();
    expect(String(update.data.verifyNote)).toMatch(/nothing was verified/);
    expect(calls.runsCreated).toHaveLength(0);

    expect(h.audits[0]!.action).toBe('heal.retire');
    expect(String(body.note)).toMatch(/stops running and stops gating/);
    expect(String(body.note)).toMatch(/un-disable it/);
  });

  it('closes the open patch proposals with it, since the test no longer runs', async () => {
    install({
      heal: RETIRE_HEAL,
      openHeals: [
        { id: 'patch', state: 'PROPOSED', riskLevel: 'SELECTOR_ONLY', diff: CLEAN_DIFF, createdAt: new Date('2026-10-20T10:00:00Z') },
        { id: 'heal_retire', state: 'PROPOSED', riskLevel: 'RETIRE', diff: '', createdAt: new Date('2026-10-22T10:00:00Z') },
      ],
    });
    const { body } = await call('/agent/heals/heal_retire/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(calls.healUpdateMany[0]!.where.id.in).toEqual(['patch']);
    expect(String(body.note)).toMatch(/1 open fix proposal/);
  });

  it('rejects a retirement without touching the test', async () => {
    install({ heal: RETIRE_HEAL });
    const { status } = await call('/agent/heals/heal_retire/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: false }),
    });

    expect(status).toBe(200);
    expect(calls.testUpdates).toHaveLength(0);
    expect(h.audits[0]!.action).toBe('heal.reject');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /agent/projects/:projectId/drift — the read half of the drift feature,
// which shipped with NO tests at all.
//
// It is the screen a person decides a retirement on, and it loads its own five
// queries: the same analysis as the worker's `driftSweep`, over inputs read
// separately. "The decision is shared so the two cannot disagree" is only true
// while the INPUTS agree too, which is what most of this block is about.
// ─────────────────────────────────────────────────────────────────────────────

const DRIFT_CODE = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('checkout completes', async ({ page }) => {",
  "  await page.goto('/checkout');",
  "  await page.getByRole('button', { name: 'Pay' }).click();",
  "  await expect(page.getByTestId('receipt')).toBeVisible();",
  '});',
].join('\n');

const driftTest = (over: Row = {}): Row => ({
  id: 't1',
  name: 'checkout completes',
  filePath: 'tests/checkout.spec.ts',
  type: 'E2E',
  priority: 'IMPORTANT',
  feature: 'checkout',
  tags: [],
  code: DRIFT_CODE,
  spec: null,
  flakeRate: 0,
  quarantined: false,
  consecutiveFailures: 0,
  ...over,
});

const crawlNode = (route: string, affordances: Row[] = []): Row => ({
  id: `n-${route}`,
  route,
  url: `https://app.test${route}`,
  title: route,
  stateKey: 'default',
  requiresRoles: [],
  behindAuth: false,
  forms: [],
  affordances,
  screenshotKey: null,
  a11yViolationCount: 0,
});

const payButton = {
  label: 'Place order',
  kind: 'button',
  selector: { strategy: 'ROLE', value: 'button', name: 'Place order', confidence: 0.9 },
};

interface DriftScenario {
  project?: Row | null;
  crawl?: Row | null;
  tests?: Row[];
  routeItems?: Array<{ key: string; origin: string; retiredAt: Date | null }>;
}

const driftCalls = {
  coverageQueries: [] as Row[],
  testQueries: [] as Row[],
  crawlQueries: [] as Row[],
};

function installDrift(scenario: DriftScenario = {}): void {
  driftCalls.coverageQueries.length = 0;
  driftCalls.testQueries.length = 0;
  driftCalls.crawlQueries.length = 0;
  const routeItems = scenario.routeItems ?? [{ key: 'ROUTE:/checkout', origin: 'BOTH', retiredAt: null }];

  h.db = {
    project: {
      findUnique: async () =>
        scenario.project === undefined ? { id: 'proj_1' } : scenario.project,
    },
    flowMap: {
      findFirst: async (args: Row = {}) => {
        driftCalls.crawlQueries.push(args);
        if (scenario.crawl !== undefined) return scenario.crawl;
        return {
          id: 'fm_1',
          version: 9,
          graph: {
            baseUrl: 'https://app.test',
            nodes: [crawlNode('/checkout')],
            exploredAt: '2026-10-24T00:00:00.000Z',
          },
          truncatedReason: null,
          createdAt: new Date('2026-10-24T01:00:00Z'),
        };
      },
    },
    test: {
      // `take` honoured, like the database: a fake that ignores it cannot show
      // a cap biting.
      findMany: async (args: Row = {}) => {
        driftCalls.testQueries.push(args);
        const all = scenario.tests ?? [driftTest()];
        return typeof args.take === 'number' ? all.slice(0, args.take) : all;
      },
    },
    coverageItem: {
      count: async () => routeItems.filter((item) => item.origin !== 'CRAWL_ONLY').length,
      findMany: async (args: Row = {}) => {
        driftCalls.coverageQueries.push(args);
        const all = [...routeItems].sort((a, b) => a.key.localeCompare(b.key));
        return typeof args.take === 'number' ? all.slice(0, args.take) : all;
      },
    },
  };
}

describe('GET /agent/projects/:projectId/drift', () => {
  it('404s on a project that does not exist', async () => {
    installDrift({ project: null });
    const { status } = await call('/agent/projects/proj_missing/drift');
    expect(status).toBe(404);
  });

  it('warns about a locator the newest crawl did not see', async () => {
    installDrift({
      crawl: {
        id: 'fm_1',
        version: 9,
        graph: {
          baseUrl: 'https://app.test',
          nodes: [crawlNode('/checkout', [payButton])],
          exploredAt: '2026-10-24T00:00:00.000Z',
        },
        truncatedReason: null,
        createdAt: new Date('2026-10-24T01:00:00Z'),
      },
    });

    const { status, body } = await call('/agent/projects/proj_1/drift');

    expect(status).toBe(200);
    expect(body.crawlVersion).toBe(9);
    expect(body.sourceAnalysed).toBe(true);
    expect(body.drift.warnings).toHaveLength(1);
    expect(body.drift.warnings[0].missing[0].locator).toBe('role=button[pay]');
    expect(body.tests[0].verdict).toBe('DRIFTED');
  });

  it('returns every verdict, not only the warnings, so they have a denominator', async () => {
    // A screen showing six drifted tests out of an unstated total cannot be
    // acted on, and the UNREACHED and UNMEASURED rows are what make the
    // OBSOLETE ones trustworthy.
    installDrift({
      crawl: null,
      tests: [driftTest()],
    });

    const { body } = await call('/agent/projects/proj_1/drift');

    expect(body.crawlVersion).toBeNull();
    expect(body.tests[0].verdict).toBe('UNMEASURED');
    expect(body.drift.summary).toMatchObject({ UNMEASURED: 1, OBSOLETE: 0 });
    expect(String(body.drift.caveats.join(' '))).toMatch(/Nothing has crawled/);
  });

  it('reads the crawl the worker reads, so the screen and the queue agree', async () => {
    // `FlowMap.version` is sequenced per (project, ENVIRONMENT), so ordering by
    // it picks the crawl from whichever environment has been crawled most often
    // — a months-old staging crawl beating this morning's production one.
    // `driftSweep` orders by createdAt desc; so must this, or the screen and the
    // queue are describing different crawls.
    installDrift();
    await call('/agent/projects/proj_1/drift');

    expect(driftCalls.crawlQueries).toHaveLength(1);
    expect(driftCalls.crawlQueries[0]!.orderBy).toEqual({ createdAt: 'desc' });
    expect(driftCalls.testQueries[0]!.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('refuses to propose a retirement from a CAPPED route-item list, and says so', async () => {
    /*
     * THE DEFECT: `take: 2000` with no ORDER BY on the authority for one of the
     * two independent negatives a retirement rests on. Past the cap a route the
     * source DOES declare does not come back and reads as `declared: false` —
     * so the cap could manufacture a retirement proposal for a test whose page
     * is fine, which is the one mistake this feature calls unrecoverable.
     */
    installDrift({
      crawl: {
        id: 'fm_1',
        version: 9,
        graph: {
          baseUrl: 'https://app.test',
          nodes: [crawlNode('/orders')],
          exploredAt: '2026-10-24T00:00:00.000Z',
        },
        truncatedReason: null,
        createdAt: new Date('2026-10-24T01:00:00Z'),
      },
      routeItems: [
        { key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null },
        ...Array.from({ length: 2_000 }, (_, i) => ({
          key: `ROUTE:/filler-${String(i).padStart(4, '0')}`,
          origin: 'BOTH',
          retiredAt: null,
        })),
      ],
    });

    const { body } = await call('/agent/projects/proj_1/drift');

    expect(body.tests[0].verdict).toBe('UNMEASURED');
    expect(body.tests[0].retirement).toBeNull();
    expect(body.routeItemsTruncated).toBe(true);
    expect(body.routesCompared).toBe(2_000);
    expect(String(body.declaredRoutesTruncatedReason)).toMatch(/there are more/);
    expect(String(body.drift.caveats.join(' '))).toMatch(
      /capped before it reached this comparison/,
    );
  });

  it('reads the route items in a defined order and one row over the cap', async () => {
    // Without the ORDER BY the two readers of this table can be handed
    // different subsets and reach different verdicts about one test.
    installDrift();
    await call('/agent/projects/proj_1/drift');

    expect(driftCalls.coverageQueries).toHaveLength(1);
    expect(driftCalls.coverageQueries[0]!.orderBy).toEqual({ key: 'asc' });
    expect(driftCalls.coverageQueries[0]!.take).toBe(2_001);
    expect(driftCalls.testQueries[0]!.take).toBe(501);
  });

  it('discloses both caps rather than reporting a page as the whole project', async () => {
    installDrift({ tests: Array.from({ length: 501 }, (_, i) => driftTest({ id: `t${i}` })) });

    const { body } = await call('/agent/projects/proj_1/drift');

    expect(body.testsCompared).toBe(500);
    expect(body.testsTruncated).toBe(true);
    expect(body.testScanLimit).toBe(500);
    expect(body.routeItemsTruncated).toBe(false);
    expect(body.declaredRoutesTruncatedReason).toBeNull();
  });

  it('never judges a fixture, because the queue never acts on one', async () => {
    installDrift({ tests: [driftTest({ filePath: `${FIXTURE_PREFIX}users.json` })] });

    const { body } = await call('/agent/projects/proj_1/drift');

    expect(body.tests).toEqual([]);
    expect(body.testsCompared).toBe(0);
  });

  it('proposes nothing when no source analysis has run', async () => {
    installDrift({
      crawl: {
        id: 'fm_1',
        version: 9,
        graph: {
          baseUrl: 'https://app.test',
          nodes: [crawlNode('/orders')],
          exploredAt: '2026-10-24T00:00:00.000Z',
        },
        truncatedReason: null,
        createdAt: new Date('2026-10-24T01:00:00Z'),
      },
      // Crawl-only: nothing has read the code, so "not declared" is the absence
      // of a detector rather than a fact.
      routeItems: [{ key: 'ROUTE:/orders', origin: 'CRAWL_ONLY', retiredAt: null }],
    });

    const { body } = await call('/agent/projects/proj_1/drift');

    expect(body.sourceAnalysed).toBe(false);
    expect(body.tests[0].verdict).toBe('UNMEASURED');
    expect(body.tests[0].retirement).toBeNull();
    expect(String(body.drift.caveats.join(' '))).toMatch(/No source analysis/);
  });

  it('treats a truncated crawl as the row says, not as the stored graph says', async () => {
    // The row is the authority: a `graph` written by an older crawler carries
    // no `truncatedReason`, and a missing one read as "complete" is what would
    // let a truncated crawl retire somebody's tests.
    installDrift({
      crawl: {
        id: 'fm_1',
        version: 9,
        graph: {
          baseUrl: 'https://app.test',
          nodes: [crawlNode('/orders')],
          exploredAt: '2026-10-24T00:00:00.000Z',
        },
        truncatedReason: 'page budget exhausted after 25 pages',
        createdAt: new Date('2026-10-24T01:00:00Z'),
      },
      routeItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });

    const { body } = await call('/agent/projects/proj_1/drift');

    expect(body.tests[0].verdict).toBe('UNMEASURED');
    expect(body.tests[0].retirement).toBeNull();
    expect(String(body.tests[0].evidence.join(' '))).toMatch(/stopped early/);
  });

  it('never reports a partly-unreached test as CURRENT', async () => {
    // The verdict that did not exist: one route reached, one not. It used to
    // fall through to CURRENT with an empty caveats array and the sentence
    // "every route this test drives was reached by the newest crawl".
    installDrift({
      tests: [
        driftTest({
          code: [
            "import { test, expect } from '@playwright/test';",
            "test('two pages', async ({ page }) => {",
            "  await page.goto('/checkout');",
            "  await page.goto('/invoice');",
            "  await expect(page.getByTestId('receipt')).toBeVisible();",
            '});',
          ].join('\n'),
        }),
      ],
      routeItems: [
        { key: 'ROUTE:/checkout', origin: 'BOTH', retiredAt: null },
        { key: 'ROUTE:/invoice', origin: 'BOTH', retiredAt: null },
      ],
    });

    const { body } = await call('/agent/projects/proj_1/drift');

    expect(body.tests[0].verdict).toBe('PARTLY_UNREACHED');
    expect(body.tests[0].caveats).not.toEqual([]);
    expect(body.tests[0].retirement).toBeNull();
    expect(body.drift.summary.PARTLY_UNREACHED).toBe(1);
    // Not a warning either: there is nothing to act on about a page nobody
    // loaded, and the count is in the summary for a reader to see.
    expect(body.drift.warnings).toEqual([]);
  });
});
