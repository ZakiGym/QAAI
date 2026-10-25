/**
 * `GET /clusters/run/:runId` — and the drift guard the whole cause feature
 * rests on.
 *
 * THE PARITY TEST IS THE IMPORTANT ONE. `apps/api/src/lib/cluster.ts` computes
 * a cluster's id with a private `clusterId()` helper (sha1 of the signature,
 * first 12 hex). The worker, the mute, the persisted identity and every link
 * the cockpit has ever shared key on that same string, and they get it from
 * `failureClusterKey` in @qaai/agent — the one implementation that is reachable
 * from both workspaces.
 *
 * Two derivations of one key drift the day somebody changes a slice length or a
 * hash, and the drift is SILENT: the new key simply reads as a cause nobody has
 * ever seen, so every identity is orphaned, every mute stops applying and every
 * "new in this build" badge turns on at once. Nothing else in the system would
 * go red. So the parity is asserted here, over a corpus of real failure text,
 * and it is the test that must never be deleted.
 *
 * Harness: the same shape as projects.quarantine.test.ts — a mocked prisma
 * module with a REAL AsyncLocalStorage tenant scope and the real router driven
 * over a loopback socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { failureClusterKey } from '@qaai/agent';
import {
  clusterFailures,
  extractFacets,
  signatureOf,
  type FailureInput,
} from '../lib/cluster.js';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
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

// ─── The corpus ──────────────────────────────────────────────────────────────

/**
 * Real failure shapes, one per distinct cause, chosen to exercise every facet
 * the signature is built from: transport, an HTTP status, a locator, a value
 * assertion, a visual diff, an un-normalisable message, and a failure with no
 * message at all.
 */
const CORPUS: Array<{ name: string; errorMessage: string | null; step?: Row }> = [
  {
    name: 'connection refused',
    errorMessage:
      'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/login\n  at /Users/dana/app/tests/login.spec.ts:7:14',
  },
  {
    name: 'a 503 from an api',
    errorMessage:
      'Expected HTTP 200, got 503 for GET https://api.acme.io/v2/orders/8813?ts=1753931234567',
  },
  {
    name: 'a locator timeout',
    errorMessage: [
      'TimeoutError: locator.click: Timeout 30000ms exceeded.',
      'Call log:',
      "  - waiting for getByRole('button', { name: 'Checkout' })",
    ].join('\n'),
  },
  {
    name: 'a wrong value',
    errorMessage:
      'Error: expect(received).toBe(expected)\n  Expected: 4\n  Received: 3\n    at /Users/dana/app/tests/cart.spec.ts:41:22',
  },
  {
    name: 'a visual diff',
    errorMessage: '1842 pixels changed (0.9%), over the 0.1% this test allows',
  },
  {
    name: 'a strict mode violation',
    errorMessage:
      "Error: strict mode violation: getByTestId('row') resolved to 4 elements\n    at /Users/dana/app/tests/table.spec.ts:18:9",
  },
  {
    name: 'a module that will not load',
    errorMessage: "Cannot find module '../helpers/auth' imported from /app/tests/auth.spec.ts",
  },
  {
    name: 'an unrecognisable message',
    errorMessage: 'nope',
  },
  {
    name: 'an assertion recorded only on the step',
    errorMessage: null,
    step: {
      index: 2,
      status: 'FAILED',
      title: 'the total is right',
      errorMessage: 'the cart said 12, expected 10',
      errorStack: null,
      selector: null,
      expected: '10',
      actual: '12',
    },
  },
];

function failureOf(entry: (typeof CORPUS)[number], i: number): FailureInput {
  return {
    testResultId: `tr_${i}`,
    testId: `t_${i}`,
    testName: entry.name,
    filePath: `tests/${i}.spec.ts`,
    status: 'FAILED',
    errorMessage: entry.errorMessage,
    retriedAndPassed: false,
    steps: entry.step ? [entry.step as never] : [],
    network: [],
    verdict: null,
  };
}

describe('the cause key is the clusterer’s own id', () => {
  /*
   * Asserted over `unclustered` rather than `clusters` because a cluster needs
   * two members and this corpus is deliberately one failure per cause — and the
   * unclustered entries carry the same `id` from the same helper, so the parity
   * is the same parity.
   */
  it('failureClusterKey(signature) equals cluster.ts’s id, for every shape in the corpus', () => {
    const report = clusterFailures(CORPUS.map(failureOf));
    const entries = [
      ...report.clusters.map((c) => ({ id: c.id, signature: c.signature })),
      ...report.unclustered.map((u) => ({ id: u.id, signature: u.signature })),
    ];

    // The corpus must actually have produced entries, or this test would pass
    // by asserting nothing — the classic way a drift guard rots.
    expect(entries).toHaveLength(CORPUS.length);

    for (const entry of entries) {
      expect(failureClusterKey(entry.signature)).toBe(entry.id);
    }
  });

  it('agrees on a grouped cluster too, where two failures differ only in noise', () => {
    const noisy = (n: number): FailureInput => ({
      ...failureOf(CORPUS[2]!, n),
      errorMessage: [
        `TimeoutError: locator.click: Timeout ${30_000 + n}ms exceeded.`,
        'Call log:',
        "  - waiting for getByRole('button', { name: 'Checkout' })",
        `    at /Users/dana/app/tests/checkout-${n}.spec.ts:${40 + n}:22`,
      ].join('\n'),
    });

    const report = clusterFailures([noisy(1), noisy(2), noisy(3)]);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]!.count).toBe(3);
    expect(failureClusterKey(report.clusters[0]!.signature)).toBe(report.clusters[0]!.id);
  });

  it('agrees on the empty-signature fallback', () => {
    // A failure that normalises to nothing still needs a key, and
    // clusterFailures substitutes 'msg=<none>'. The worker computes its key the
    // same way, so both must land on the same string.
    const blank: FailureInput = { ...failureOf(CORPUS[0]!, 99), errorMessage: '   ', steps: [] };
    const report = clusterFailures([blank]);
    const entry = report.unclustered[0]!;
    expect(signatureOf(extractFacets(blank)) || 'msg=<none>').toBe(entry.signature);
    expect(failureClusterKey(entry.signature)).toBe(entry.id);
  });
});

// ─── The endpoint ────────────────────────────────────────────────────────────

const OUTAGE = (n: number): string =>
  [
    `TimeoutError: locator.click: Timeout ${30_000 + n}ms exceeded.`,
    'Call log:',
    "  - waiting for getByRole('button', { name: 'Checkout' })",
    `    at /Users/dana/app/tests/checkout-${n}.spec.ts:${40 + n}:22`,
  ].join('\n');

const OUTAGE_KEY = failureClusterKey(
  signatureOf(
    extractFacets({
      testResultId: 'x',
      testId: 'x',
      testName: 'x',
      filePath: 'x',
      status: 'FAILED',
      errorMessage: OUTAGE(0),
      retriedAndPassed: false,
      steps: [],
      network: [],
      verdict: null,
    }),
  ),
);

interface Store {
  run: Row[];
  testResult: Row[];
  runFailureCluster: Row[];
  failureSignature: Row[];
}

let store: Store;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(row[key]);
      if ('gt' in c) return row[key] instanceof Date && row[key] > (c.gt as Date);
      throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
    }
    return row[key] === cond;
  });
}

function install(over: Partial<Store> = {}): void {
  store = {
    run: [
      {
        id: 'run_1',
        orgId: 'org_1',
        projectId: 'proj_1',
        status: 'FAILED',
        totalCount: 200,
        failedCount: 3,
        flakyCount: 0,
        finishedAt: new Date('2026-10-24T12:00:00.000Z'),
      },
    ],
    testResult: [0, 1, 2].map((n) => ({
      id: `tr_${n}`,
      orgId: 'org_1',
      runId: 'run_1',
      testId: `t_${n}`,
      status: 'FAILED',
      errorMessage: OUTAGE(n),
      retriedAndPassed: false,
      network: [],
      test: { name: `checkout ${n}`, filePath: `tests/checkout-${n}.spec.ts` },
      steps: [],
      verdict: null,
    })),
    runFailureCluster: [],
    failureSignature: [],
    ...over,
  };

  const list = (name: keyof Store) => ({
    findMany: async (args: Row = {}) => store[name].filter((r) => matches(r, args.where)),
  });

  h.prisma = {
    run: {
      findUnique: async (args: Row = {}) =>
        store.run.find((r) => r.id === args.where?.id && r.orgId === h.actor.orgId) ?? null,
    },
    testResult: list('testResult'),
    runFailureCluster: list('runFailureCluster'),
    failureSignature: list('failureSignature'),
  };
}

function seedIdentity(over: Row = {}): void {
  store.runFailureCluster.push({
    runId: 'run_1',
    clusterKey: OUTAGE_KEY,
    members: 3,
    modelCalls: 1,
    attachments: 2,
    suppressed: false,
    firstSeenInProject: true,
    ...(over.run ?? {}),
  });
  store.failureSignature.push({
    projectId: 'proj_1',
    clusterKey: OUTAGE_KEY,
    firstSeenAt: new Date('2026-10-24T11:00:00.000Z'),
    firstSeenRunId: 'run_1',
    lastSeenAt: new Date('2026-10-24T12:00:00.000Z'),
    runCount: 1,
    occurrenceCount: 3,
    mutedUntil: null,
    mutedReason: null,
    mutedBy: null,
    suppressedCount: 0,
    ...(over.cause ?? {}),
  });
}

const express = (await import('express')).default;
const { clustersRouter } = await import('./clusters.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/clusters', clustersRouter);
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

async function get(path: string): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  install();
});

describe('GET /clusters/run/:runId', () => {
  it('groups the outage and attaches the persisted identity', async () => {
    seedIdentity();
    const { status, body } = await get('/clusters/run/run_1');

    expect(status).toBe(200);
    expect(body.clusters).toHaveLength(1);
    const cluster = body.clusters[0];
    expect(cluster.id).toBe(OUTAGE_KEY);
    expect(cluster.identity).toMatchObject({
      clusterKey: OUTAGE_KEY,
      newInThisBuild: true,
      runsSeen: 1,
      membersThisRun: 3,
      modelCalls: 1,
      attachments: 2,
    });
  });

  /*
   * The cost claim, as data. "One call for three failures" is what this product
   * says about itself, and the number has to be readable rather than asserted
   * in a changelog.
   */
  it('reports what triage cost and what the collapse saved', async () => {
    seedIdentity();
    const { body } = await get('/clusters/run/run_1');
    expect(body.summary).toMatchObject({
      clustered: 3,
      modelCalls: 1,
      attachments: 2,
      wouldHaveBeen: 3,
      savedCalls: 2,
    });
  });

  /*
   * NULL, NOT ZERO. A run that predates the feature spent its calls; reporting
   * 0 would read as "we saved everything", which is the opposite of the truth.
   */
  it('reports the cost as unmeasured when no identity was recorded', async () => {
    const { body } = await get('/clusters/run/run_1');
    expect(body.clusters[0].identity).toBeNull();
    expect(body.summary.modelCalls).toBeNull();
    expect(body.summary.savedCalls).toBeNull();
    expect(body.summary.wouldHaveBeen).toBe(3);
  });

  it('never reports a negative saving when a waiter paid for a second call', async () => {
    seedIdentity({ run: { modelCalls: 5, attachments: 0 } });
    const { body } = await get('/clusters/run/run_1');
    expect(body.summary.modelCalls).toBe(5);
    expect(body.summary.savedCalls).toBe(0);
  });

  /*
   * "New in this build" comes off the per-run flag, which is the value AS OF
   * this run. Reading the live signature row instead would turn the badge off
   * on this page as soon as a later run saw the same cause — rewriting history
   * for the person who came back to look at it.
   */
  it('keeps new-in-this-build true on an old run after the cause recurs', async () => {
    seedIdentity({
      cause: { firstSeenRunId: 'run_1', runCount: 4, lastSeenAt: new Date() },
      run: { firstSeenInProject: true },
    });
    store.failureSignature[0]!.firstSeenRunId = 'run_0_earlier_render';
    const { body } = await get('/clusters/run/run_1');
    expect(body.clusters[0].identity.newInThisBuild).toBe(true);
  });

  it('shows a muted cause rather than hiding it', async () => {
    const until = new Date(Date.now() + 86_400_000);
    seedIdentity({
      run: { suppressed: true, modelCalls: 0, attachments: 0 },
      cause: { mutedUntil: until, mutedReason: 'known issue', mutedBy: 'user_9', suppressedCount: 7 },
    });
    const { body } = await get('/clusters/run/run_1');

    expect(body.clusters[0].identity.mute).toMatchObject({
      inForce: true,
      reason: 'known issue',
      suppressed: 7,
    });
    expect(body.clusters[0].identity.suppressedThisRun).toBe(true);
    expect(body.summary.suppressedCauses).toBe(1);
  });

  it('reports an expired mute as not in force, without hiding that it existed', async () => {
    seedIdentity({
      cause: { mutedUntil: new Date(Date.now() - 1000), mutedReason: 'was known' },
    });
    const { body } = await get('/clusters/run/run_1');
    expect(body.clusters[0].identity.mute.inForce).toBe(false);
    expect(body.clusters[0].identity.mute.reason).toBe('was known');
  });

  /*
   * The identity reaches the box a reviewer actually reads. Without this the
   * cause history is a field in a payload that no screen is obliged to render.
   */
  it('folds the cause into the deterministic failure summary’s notes', async () => {
    seedIdentity();
    const { body } = await get('/clusters/run/run_1');
    const signals = body.clusters[0].summary.notes.map((n: Row) => n.signal);
    expect(signals).toContain('CAUSE_NEW_IN_BUILD');
    expect(body.clusters[0].summary.kind).toBe('SELECTOR_NOT_FOUND');
  });

  it('says the cause is not new when it is not', async () => {
    seedIdentity({
      run: { firstSeenInProject: false },
      cause: { firstSeenRunId: 'run_0', runCount: 9 },
    });
    const { body } = await get('/clusters/run/run_1');
    const notes = body.clusters[0].summary.notes as Row[];
    expect(notes.map((n) => n.signal)).toContain('CAUSE_SEEN_BEFORE');
    expect(notes.find((n) => n.signal === 'CAUSE_SEEN_BEFORE')!.sentence).toMatch(
      /appeared in 9 runs/,
    );
  });

  it('404s a run in another org rather than confirming it exists', async () => {
    h.actor = { userId: 'user_2', orgId: 'org_2', role: 'MEMBER', ip: null };
    const { status, body } = await get('/clusters/run/run_1');
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain('proj_1');
  });
});
