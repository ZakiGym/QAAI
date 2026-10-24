/**
 * Lifecycle tests for the run processor (§5).
 *
 * Every other test in this directory asks whether a processor produced the
 * right answer. These ask something narrower and more dangerous: whether the
 * processor executed at all, and whether it said so when it stopped.
 *
 * The three failures below were each observed, and each is a case where the
 * worker and the rest of the product disagreed about what a run was:
 *
 *  1. The API wrote CANCELLED, the cockpit said "Run cancelled before it
 *     started", and the worker wrote RUNNING straight over it and drove a
 *     browser through the whole suite — against whatever environment the run
 *     was pointed at, production included. The user pressed Cancel and the
 *     tests ran anyway.
 *  2. Something in the pre-loop setup threw — one rotated vault key did it to
 *     every run in an org — and the run stayed at QUEUED/RUNNING for good. The
 *     elapsed clock never stopped, the gate never resolved, and no
 *     `run.finished` notification was enqueued, so the Slack message and the PR
 *     comment never arrived.
 *  3. A cancel that landed mid-flight bailed with a bare `return`, skipping the
 *     counts, the gate result and the notification, so the cockpit showed a
 *     cancelled run with a blank summary forever.
 *
 * So the assertions here are mostly about absence: no test executed, no status
 * written over someone else's decision — and about the one thing that must
 * always be present, which is a terminal status plus a `run.finished` that
 * somebody downstream can hear.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_NAMES } from '@qaai/shared';
import type { ShardedRunJob } from '@qaai/shared';

// The worker's context opens Postgres, Redis and object storage at import time,
// so it is replaced wholesale; `h.prisma` is swapped per test through the proxy.
interface SeenContext {
  testId: string;
  storageState: unknown;
  /** The materialised repository root the plugin was handed, if any. */
  workspace: string | null;
  /** Which profile's session `storageState` holds, as the context claims. */
  authProfileId: string | null;
}

const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    published: Array<{ orgId: string; type: string; data: Record<string, unknown> }>;
    notified: Array<{ orgId: string; event: string; payload: Record<string, unknown> }>;
    triaged: Array<{ runId: string; testResultId: string }>;
    executed: string[];
    /** What each executed test was actually given — see the workspace and
     * auth-profile suites at the bottom of this file. */
    contexts: SeenContext[];
    log: string[];
    /** Set by a test to make the vault (or another setup step) blow up. */
    secretsThrows: Error | null;
    /** Called after each test executes, so a test can cancel the run mid-flight. */
    afterExecute: ((testId: string) => void) | null;
    /**
     * What each test's plugin reports, by test id. Default PASSED.
     *
     * Added for the quarantine suite, and its absence is part of why the defect
     * survived: every test in this file passed, so the FAILED branch of the
     * counters — the one that fed `Run.failedCount`, the CLI's exit code and
     * the GitHub check — was never executed by a single assertion.
     */
    statusFor: Map<string, string>;
    workers: Array<{ name: string; listeners: Map<string, (...args: never[]) => void> }>;
    /** Profile ids a login was DRIVEN for, in order. Length is the whole point. */
    logins: string[];
    /** Profiles that refuse to sign in, by id. */
    loginRefusals: Map<string, string>;
    /** Overrides the repository materialiser; null runs the real one. */
    materialise: (() => unknown) | null;
    materialiseCalls: number;
    cleanups: number;
  } => ({
    prisma: {},
    published: [],
    notified: [],
    triaged: [],
    executed: [],
    contexts: [],
    log: [],
    secretsThrows: null,
    afterExecute: null,
    statusFor: new Map(),
    workers: [],
    logins: [],
    loginRefusals: new Map(),
    materialise: null,
    materialiseCalls: 0,
    cleanups: 0,
  }),
);

vi.mock('../context.js', () => ({
  config: { concurrency: 2, artifactsLocal: true, anthropicApiKey: 'test' },
  connection: { disconnect: () => {} },
  logger: {
    debug: () => {},
    info: (_o: unknown, msg?: string) => h.log.push(`info:${msg ?? ''}`),
    warn: (_o: unknown, msg?: string) => h.log.push(`warn:${msg ?? ''}`),
    error: (_o: unknown, msg?: string) => h.log.push(`error:${msg ?? ''}`),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  publishEvent: (orgId: string, event: { type: string; data: Record<string, unknown> }) => {
    h.published.push({ orgId, type: event.type, data: event.data });
  },
  storage: {
    put: async () => {},
    putFile: async () => {},
    get: async () => null,
  },
}));

// The queue producers are plumbing; these tests only care WHAT was asked for.
// `enqueueNotify` in particular is the whole point of two of them — it is what
// carries the Slack message and the PR comment.
vi.mock('../queues.js', () => ({
  ANALYZE_SOURCE_QUEUE: 'qaai.analyze-source',
  DELIVERY_JOB: 'delivery',
  armFlakeTick: async () => {},
  armScheduleTick: async () => {},
  closeProducers: async () => {},
  enqueueNotify: async (job: {
    orgId: string;
    event: string;
    payload: Record<string, unknown>;
  }) => {
    h.notified.push(job);
  },
  enqueueTriage: async (job: { runId: string; testResultId: string }) => {
    h.triaged.push(job);
  },
}));

vi.mock('../vault.js', () => ({
  secretsFor: async () => {
    if (h.secretsThrows) throw h.secretsThrows;
    return {};
  },
  open: () => 'access-key',
}));

vi.mock('../grids.js', () => ({ gridWsEndpoint: () => 'wss://grid.example/ws' }));

vi.mock('@qaai/storage', () => ({
  artifactKey: (a: { orgId: string; runId: string; name: string }) =>
    `orgs/${a.orgId}/runs/${a.runId}/${a.name}`,
}));

/*
 * A plugin that records that it RAN. Nothing here cares what a test returns —
 * the question these tests ask is whether the suite was executed at all, and
 * `h.executed` is the answer to it.
 */
/*
 * A PARTIAL mock, and the split is deliberate.
 *
 * The barrel pulls in Playwright, so it cannot be imported whole here — but it
 * used to be replaced whole, with `evaluateGates: () => ({ passed: true })` and
 * `DEFAULT_GATE_RULES: []`. That made the gate unobservable from these tests,
 * and the gate is where the one honoured quarantine rule lived: the processor
 * could have counted a quarantined failure any way it liked and nothing here
 * would have noticed. It did, for as long as the feature existed.
 *
 * So `gates.js` is imported FOR REAL (it depends only on @qaai/shared, no
 * browser) and everything that would open a browser stays a stand-in.
 */
vi.mock('@qaai/runner', async () => ({
  ...(await import('../../../../packages/runner/src/gates.js')),
  reasonUnsupported: (type: string) => `${type} is not supported`,
  /*
   * Standing in for a real browser login. It records WHICH profile and HOW
   * OFTEN, which is the assertion the per-profile cache exists to satisfy: one
   * login per profile per run, including one for a profile that refuses.
   */
  signInWithProfile: async (profile: { id: string; name: string }) => {
    h.logins.push(profile.id);
    const refusal = h.loginRefusals.get(profile.id);
    if (refusal) {
      return { ok: false, storageState: null, message: refusal, expiresAt: null };
    }
    return {
      ok: true,
      storageState: { cookies: [{ name: 'sid', value: `session-for-${profile.id}` }] },
      message: 'signed in',
      expiresAt: new Date(Date.now() + 3600_000),
    };
  },
  pluginFor: () => ({
    validate: () => {},
    execute: async (ctx: Record<string, unknown>, test: { id: string }) => {
      h.executed.push(test.id);
      h.contexts.push({
        testId: test.id,
        storageState: ctx.storageState,
        workspace: (ctx.workspace as { root?: string } | null)?.root ?? null,
        authProfileId: (ctx.authProfileId as string | null) ?? null,
      });
      h.afterExecute?.(test.id);
      const status = (h.statusFor.get(test.id) ?? 'PASSED') as 'PASSED';
      return {
        testId: test.id,
        status,
        durationMs: 10,
        steps: [],
        network: [],
        console: [],
        videoKey: null,
        traceKey: null,
        errorMessage: status === 'PASSED' ? null : `${test.id} failed`,
        retriedAndPassed: false,
        findings: [],
      };
    },
  }),
}));

// run.ts reaches into schedule.ts for the monitor streak; index.ts imports the
// tick from the same module, so one mock serves both.
vi.mock('./schedule.js', () => ({
  recordMonitorResult: async () => {},
  processScheduleTick: async () => {},
}));

/*
 * ── index.ts's own imports ──────────────────────────────────────────────────
 * One test below drives the worker's `failed` handler, which only exists inside
 * index.ts. Importing that file pulls in every processor it registers, and most
 * of them open an LLM client or a browser at import time, so they are stubbed
 * down to the symbols index.ts actually names. `./run.js` is deliberately NOT
 * among them: it is the module under test, and index.ts must get the real one.
 */
vi.mock('./analyze-source.js', () => ({ processAnalyzeSource: async () => {} }));
vi.mock('./explore.js', () => ({ processExplore: async () => {} }));
vi.mock('./generate.js', () => ({ processGenerate: async () => {} }));
vi.mock('./triage.js', () => ({ processTriage: async () => {} }));
vi.mock('./copilot.js', () => ({ processCopilot: async () => {} }));
vi.mock('./edit.js', () => ({ processEdit: async () => {} }));
vi.mock('./notify.js', () => ({ processDelivery: async () => {}, processNotify: async () => {} }));
vi.mock('./import.js', () => ({ processImport: async () => {} }));
vi.mock('./flake.js', () => ({ processFlakeTick: async () => {} }));
vi.mock('./bisect.js', () => ({ processBisect: async () => {} }));
vi.mock('./checks.js', () => ({ armCheckSweep: async () => {}, processChecks: async () => {} }));
vi.mock('./digest.js', () => ({ processDigestTick: async () => {} }));
vi.mock('./retention.js', () => ({
  RETENTION_QUEUE: 'qaai.retention',
  armRetentionSweep: async () => {},
  closeRetentionQueue: async () => {},
  processRetentionTick: async () => {},
}));
vi.mock('./backup.js', () => ({
  BACKUP_QUEUE: 'qaai.backup',
  armBackupSweep: async () => {},
  closeBackupQueue: async () => {},
  processBackupTick: async () => {},
}));
vi.mock('../../../api/src/lib/bisect.js', () => ({ BISECT_QUEUE: 'qaai.bisect' }));
/*
 * `../repo-materialise.js` imports the GitHub App helpers from here too, so the
 * mock has to carry them or the real module cannot even be linked. They are
 * never reached in these tests: `loadAppConfig` returning null is this
 * deployment's actual state, and the fake project has no repository anyway.
 */
vi.mock('../../../api/src/lib/github-app.js', () => ({
  CHECKS_QUEUE: 'qaai.checks',
  GITHUB_API_HOST: 'api.github.com',
  githubRepoSlug: (repo: string) => repo,
  installationToken: async () => 'ghs_never_used',
  loadAppConfig: () => null,
}));

/*
 * The materialiser itself is real unless a test overrides it: the no-repository
 * path needs no network and is worth exercising for real, while the "ready"
 * path cannot be reached without a GitHub, so it is supplied.
 */
vi.mock('../repo-materialise.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repo-materialise.js')>();
  return {
    ...actual,
    materialiseRepoWorkspace: async (
      args: Parameters<typeof actual.materialiseRepoWorkspace>[0],
    ) => {
      h.materialiseCalls += 1;
      return h.materialise
        ? (h.materialise() as Awaited<ReturnType<typeof actual.materialiseRepoWorkspace>>)
        : actual.materialiseRepoWorkspace(args);
    },
  };
});

// A BullMQ stand-in that never touches Redis. It keeps the constructor
// arguments and the listeners, because the listener registered on 'failed' IS
// the fix under test.
vi.mock('bullmq', () => ({
  Worker: class {
    name: string;
    listeners = new Map<string, (...args: never[]) => void>();
    constructor(name: string) {
      this.name = name;
      h.workers.push(this);
    }
    on(event: string, fn: (...args: never[]) => void): this {
      this.listeners.set(event, fn);
      return this;
    }
    async close(): Promise<void> {}
  },
}));

const { failRunFromDeadJob, processRun } = await import('./run.js');

// ─────────────────────────────────────────────────────────────────────────────
// A prisma stand-in around one run
// ─────────────────────────────────────────────────────────────────────────────

interface TestRow {
  id: string;
  name: string;
  type: string;
  code: string;
  filePath: string;
  spec: unknown;
  timeoutMs: number;
  quarantined: boolean;
  /** When the quarantine stops suppressing. Null means "never expires". */
  quarantineExpiresAt: Date | null;
  quarantinedAt: Date | null;
  tags: string[];
  priority: string;
  consecutiveFailures: number;
  /** The role this test runs as; null is anonymous. */
  authProfileId: string | null;
  /** "Meaningless signed out" — survives the profile being deleted. */
  authProfileRequired: boolean;
}

/** An `AuthProfile` row, as the processor reads one. */
interface ProfileRow {
  id: string;
  orgId: string;
  environmentId: string;
  name: string;
  kind: string;
  config: unknown;
  storageState: unknown;
  storageStateExpiresAt: Date | null;
}

interface ResultRow {
  id: string;
  testId: string;
  shardIndex: number | null;
  status: string;
  retriedAndPassed: boolean;
  durationMs: number;
  errorMessage?: string | null;
  test: TestRow;
}

interface RunRow {
  id: string;
  orgId: string;
  projectId: string;
  status: string;
  trigger: string;
  prNumber: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  finalizedAt: Date | null;
  totalCount: number;
  shardCount: number;
  baseUrlOverride: string | null;
  commitSha: string | null;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  skippedCount: number;
  /** Failures a quarantine suppressed. The column the fix added. */
  quarantinedFailedCount: number;
  gateResult: unknown;
  errorMessage: string | null;
}

interface Db {
  run: RunRow;
  results: ResultRow[];
  profiles: ProfileRow[];
  /** Sessions written back to a profile, so a captured login is seen to cache. */
  profileWrites: Array<{ id: string; storageState: unknown }>;
  /** Ordered record of every write to the run row, so a test can see clobbering. */
  runWrites: Array<{ op: 'update' | 'updateMany'; data: Record<string, unknown>; matched: number }>;
  /** Runs updateMany matched, by id — proves an unfiltered where never fans out. */
  otherRuns: RunRow[];
  /** Every flake-trend point written, keyed `testId|yyyy-mm-dd`. */
  flakeHistory: Map<string, FlakeHistoryRow>;
  /** How much of the suite is quarantined, as the budget query would see it. */
  projectTests: TestRow[];
}

/** One `TestFlakeHistory` row, as the upsert maintains it. */
interface FlakeHistoryRow {
  testId: string;
  day: string;
  ratePercent: number;
  peakRatePercent: number;
  worstRunId: string | null;
  sampleSize: number;
  failures: number;
  samples: number;
  quarantined: boolean;
}

const ORG = 'org1';
const RUN = 'run1';

function testRow(id: string, over: Partial<TestRow> = {}): TestRow {
  return {
    id,
    name: `test ${id}`,
    type: 'E2E',
    code: 'await page.goto("/")',
    filePath: `tests/${id}.spec.ts`,
    spec: null,
    timeoutMs: 30_000,
    quarantined: false,
    quarantineExpiresAt: null,
    quarantinedAt: null,
    tags: [],
    priority: 'IMPORTANT',
    consecutiveFailures: 0,
    authProfileId: null,
    authProfileRequired: false,
    ...over,
  };
}

/** One result row around one test, for the suites that need a specific shape. */
function resultFor(id: string, test: Partial<TestRow> = {}): ResultRow {
  return {
    id: `r_${id}`,
    testId: id,
    shardIndex: null,
    status: 'SKIPPED',
    retriedAndPassed: false,
    durationMs: 0,
    test: testRow(id, test),
  };
}

function profileRow(over: Partial<ProfileRow> & { id: string }): ProfileRow {
  return {
    orgId: ORG,
    environmentId: 'env1',
    name: `profile ${over.id}`,
    kind: 'FORM_LOGIN',
    config: {},
    storageState: null,
    storageStateExpiresAt: null,
    ...over,
  };
}

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: RUN,
    orgId: ORG,
    projectId: 'proj1',
    status: 'QUEUED',
    trigger: 'MANUAL',
    prNumber: 42,
    startedAt: null,
    finishedAt: null,
    finalizedAt: null,
    totalCount: 3,
    shardCount: 1,
    baseUrlOverride: null,
    commitSha: null,
    passedCount: 0,
    failedCount: 0,
    flakyCount: 0,
    skippedCount: 0,
    quarantinedFailedCount: 0,
    gateResult: null,
    errorMessage: null,
    ...over,
  };
}

/**
 * Prisma's `undefined` semantics, faithfully: a `where` key whose value is
 * `undefined` is NOT a filter, it is an absent filter, and the row matches
 * regardless. That is not a detail worth papering over in a fake — an id that
 * arrives undefined turns a single-row update into an unscoped one, and one of
 * the tests below exists only because of it.
 */
function runMatches(row: RunRow, where: Record<string, unknown>): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.orgId !== undefined && row.orgId !== where.orgId) return false;
  if ('finalizedAt' in where && where.finalizedAt === null && row.finalizedAt !== null)
    return false;
  if ('startedAt' in where && where.startedAt === null && row.startedAt !== null) return false;
  const status = where.status;
  if (typeof status === 'string' && row.status !== status) return false;
  if (status && typeof status === 'object') {
    const list = (status as { in?: string[] }).in;
    if (Array.isArray(list) && !list.includes(row.status)) return false;
    // `notIn` is how a write refuses to relabel a terminal status. A fake that
    // ignored it would let an unconditional write pass every assertion here,
    // which is the shape of hole that lets a real regression through unseen.
    const excluded = (status as { notIn?: string[] }).notIn;
    if (Array.isArray(excluded) && excluded.includes(row.status)) return false;
  }
  return true;
}

function fakeDb(
  opts: {
    run?: Partial<RunRow>;
    results?: ResultRow[];
    profiles?: ProfileRow[];
    /** Every live test in the project, for the quarantine budget. */
    projectTests?: TestRow[];
    /** The project's own cap, as a percent. Null means the documented default. */
    quarantineBudgetPercent?: number | null;
    /** Mutate the world the instant the processor has taken its snapshot. */
    afterFindFirst?: (db: Db) => void;
  } = {},
): Db {
  const db: Db = {
    run: runRow(opts.run),
    results:
      opts.results ??
      ['r1', 'r2', 'r3'].map((id, i) => ({
        id,
        testId: `t${i + 1}`,
        shardIndex: null,
        status: 'SKIPPED',
        retriedAndPassed: false,
        durationMs: 0,
        test: testRow(`t${i + 1}`),
      })),
    profiles: opts.profiles ?? [],
    profileWrites: [],
    runWrites: [],
    flakeHistory: new Map(),
    /*
     * The project's tests, as the quarantine-budget query sees them. Defaults
     * to the run's own tests, which is the honest shape for an unsharded run of
     * a whole suite; a test that cares about the budget overrides it.
     */
    projectTests: opts.projectTests ?? [],
    otherRuns: [
      runRow({ id: 'run2', status: 'RUNNING' }),
      runRow({ id: 'run3', status: 'QUEUED' }),
    ],
  };

  const runModel = {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      if (!runMatches(db.run, args.where)) return null;
      const snapshot = {
        ...db.run,
        environment: { id: 'env1', baseUrl: 'https://staging.example.com' },
        project: {
          id: 'proj1',
          gateRules: [],
          quarantineBudgetPercent: opts.quarantineBudgetPercent ?? null,
          // No connected repository, which is the common case and the one the
          // repo-dependent types have to be honest about.
          repoFullName: null,
          repoInstallationId: null,
          defaultBranch: 'main',
        },
        results: db.results,
      };
      opts.afterFindFirst?.(db);
      return snapshot;
    },
    findUnique: async () => ({ ...db.run }),
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = [db.run, ...db.otherRuns].filter((r) => runMatches(r, args.where));
      for (const row of rows) Object.assign(row, args.data);
      db.runWrites.push({ op: 'updateMany', data: args.data, matched: rows.length });
      return { count: rows.length };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(db.run, args.data);
      db.runWrites.push({ op: 'update', data: args.data, matched: 1 });
      return { ...db.run };
    },
  };

  const resultModel = {
    findMany: async () =>
      db.results.map((r) => ({
        ...r,
        test: {
          name: r.test.name,
          priority: r.test.priority,
          quarantined: r.test.quarantined,
          // The expiry travels with the flag: `readRunResults` selects it
          // because an expired quarantine GATES AGAIN, and a fake that omitted
          // it would keep honouring a suppression that ran out.
          quarantineExpiresAt: r.test.quarantineExpiresAt,
        },
        verdict: null,
      })),
    groupBy: async () => {
      const byStatus = new Map<string, number>();
      for (const r of db.results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      return [...byStatus].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
    update: async (args: {
      where: { id: string };
      data: { status?: string; errorMessage?: string | null };
    }) => {
      const row = db.results.find((r) => r.id === args.where.id);
      if (row && args.data.status) row.status = args.data.status;
      // The MESSAGE is the product here: an unrunnable test is only honest if
      // it says why, so the fake has to keep it for the assertions to see.
      if (row && 'errorMessage' in args.data) row.errorMessage = args.data.errorMessage ?? null;
      return {};
    },
  };

  const tx = {
    testResult: resultModel,
    step: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    finding: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    artifact: { upsert: async () => ({}) },
    /*
     * The mutation metric's survivor rows. `persistExecution` clears them on
     * EVERY result, with or without mutation data, so stale detail cannot
     * outlive the number it describes — which means this delegate is reached on
     * every run in this file, not only the mutation ones. Without it the call
     * throws, the outer catch turns it into a run-level error, and all 55 tests
     * here finalise ERRORED with the real cause nowhere in the log.
     */
    mutationSurvivor: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
  };

  h.prisma = {
    run: runModel,
    testResult: resultModel,
    organization: { findUniqueOrThrow: async () => ({ plan: 'TEAM' }) },
    // Fixture rows and the auth profile: absent, which is the common case and
    // keeps these tests about the lifecycle rather than the workspace.
    test: {
      /*
       * Two different queries land here: the fixture load (`filePath`
       * startsWith) and the quarantine-budget scan (`quarantined: true`). A
       * fake that answered both with `[]` would silently switch the budget off,
       * which is the shape of hole the original defect lived in.
       */
      findMany: async (args: { where?: Record<string, unknown> } = {}) => {
        if (args.where?.quarantined === true) {
          return db.projectTests
            .filter((t) => t.quarantined)
            .map((t) => ({
              id: t.id,
              name: t.name,
              quarantinedAt: t.quarantinedAt,
              quarantineExpiresAt: t.quarantineExpiresAt,
            }));
        }
        return [];
      },
      /*
       * TWO counts land here, and conflating them is the bug this fake exists
       * to be able to catch: the denominator (`disabledAt: null`) and the
       * suppressions IN FORCE (`quarantined: true` plus the expiry arm). The
       * second is counted in the database precisely because the NAME list is
       * capped, so a fake that answered both with the suite size would hide
       * exactly that.
       */
      count: async (args: { where?: Record<string, unknown> } = {}) => {
        if (args.where?.quarantined !== true) return db.projectTests.length;
        const now = Date.now();
        return db.projectTests.filter(
          (t) =>
            t.quarantined &&
            (t.quarantineExpiresAt === null || t.quarantineExpiresAt.getTime() > now),
        ).length;
      },
      findUnique: async () => ({ consecutiveFailures: 0 }),
      update: async () => ({}),
    },
    /*
     * The flake trend. Modelled as a real per-day upsert rather than a no-op,
     * because "does history ACCUMULATE instead of overwriting" is the question
     * the second half of this change exists to answer, and a fake that swallows
     * the write cannot answer it.
     */
    testFlakeHistory: {
      findUnique: async (args: { where: { testId_day: { testId: string; day: Date } } }) => {
        const key = `${args.where.testId_day.testId}|${args.where.testId_day.day.toISOString().slice(0, 10)}`;
        return db.flakeHistory.get(key) ?? null;
      },
      upsert: async (args: {
        where: { testId_day: { testId: string; day: Date } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { testId, day } = args.where.testId_day;
        const key = `${testId}|${day.toISOString().slice(0, 10)}`;
        const existing = db.flakeHistory.get(key);
        if (!existing) {
          const create = args.create as unknown as FlakeHistoryRow & { day: Date };
          db.flakeHistory.set(key, {
            testId,
            day: day.toISOString().slice(0, 10),
            ratePercent: create.ratePercent,
            peakRatePercent: create.peakRatePercent,
            worstRunId: create.worstRunId ?? null,
            sampleSize: create.sampleSize,
            failures: create.failures,
            samples: 1,
            quarantined: create.quarantined,
          });
          return {};
        }
        const update = args.update;
        existing.ratePercent = update.ratePercent as number;
        existing.sampleSize = update.sampleSize as number;
        existing.failures = update.failures as number;
        existing.quarantined = update.quarantined as boolean;
        /*
         * `samples: { increment: 1 }`, applied the way Prisma would — and read
         * off the PAYLOAD rather than assumed. A fake that incremented
         * unconditionally would pass even if the processor wrote `samples: 1`,
         * which is exactly the overwrite-instead-of-accumulate defect this
         * table exists to fix. (Caught by mutating the processor to do it.)
         */
        const samples = update.samples as { increment?: number } | number | undefined;
        if (typeof samples === 'object' && typeof samples.increment === 'number') {
          existing.samples += samples.increment;
        } else if (typeof samples === 'number') {
          existing.samples = samples;
        }
        if ('peakRatePercent' in update) {
          existing.peakRatePercent = update.peakRatePercent as number;
          existing.worstRunId = (update.worstRunId as string | null) ?? null;
        }
        return {};
      },
    },
    /*
     * `loadProjectPlugins` reads this on every run. Without the delegate the
     * call throws a TypeError, the outer catch turns it into a run-level error,
     * and EVERY test in this file finalises ERRORED — which is a fake failing,
     * not the code. An empty list is the honest default here: these tests are
     * about first-party plugins, and a project with no third-party plugin
     * enabled is the ordinary case.
     */
    pluginEnablement: { findMany: async () => [] },
    integration: { findFirst: async () => null },
    authProfile: {
      /*
       * Two lookups, and the difference matters: by `environmentId` for the
       * run's DEFAULT profile (first by createdAt, which here is array order),
       * and by `id` for a profile a test named. The id lookup is scoped on the
       * org, because a test row's profile id is data — one from another tenant
       * must resolve to nothing rather than to their session.
       */
      findFirst: async (args: {
        where: { id?: string; orgId?: string; environmentId?: string };
      }) => {
        const { id, orgId: scope, environmentId } = args.where;
        if (id !== undefined) {
          return db.profiles.find((p) => p.id === id && p.orgId === scope) ?? null;
        }
        return db.profiles.find((p) => p.environmentId === environmentId) ?? null;
      },
      update: async (args: { where: { id: string }; data: { storageState?: unknown } }) => {
        db.profileWrites.push({ id: args.where.id, storageState: args.data.storageState });
        const row = db.profiles.find((p) => p.id === args.where.id);
        if (row) row.storageState = args.data.storageState;
        return {};
      },
    },
    visualBaseline: { findFirst: async () => null, upsert: async () => ({}) },
    runShard: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findMany: async () => [],
    },
    $transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  };

  return db;
}

const job = (over: Partial<ShardedRunJob> = {}): ShardedRunJob => ({
  orgId: ORG,
  runId: RUN,
  ...over,
});

const published = (type: string) => h.published.filter((e) => e.type === type);

beforeEach(() => {
  h.published = [];
  h.notified = [];
  h.triaged = [];
  h.executed = [];
  h.contexts = [];
  h.log = [];
  h.secretsThrows = null;
  h.afterExecute = null;
  h.statusFor = new Map();
  h.logins = [];
  h.loginRefusals = new Map();
  h.materialise = null;
  h.materialiseCalls = 0;
  h.cleanups = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// (1) Cancel before the job started
// ─────────────────────────────────────────────────────────────────────────────

describe('a run cancelled before its job was picked up', () => {
  it('executes nothing, and does not even reach the vault', async () => {
    // The normal case, not an exotic one: a busy pool is exactly when people
    // reach for Cancel, so the run is still QUEUED when they press it.
    const db = fakeDb({ run: { status: 'CANCELLED' } });
    const secrets = new Error('the vault should never have been opened');
    h.secretsThrows = secrets;

    await processRun(job());

    expect(h.executed).toEqual([]);
    // Nothing was written over the API's decision.
    expect(db.run.status).toBe('CANCELLED');
    expect(db.runWrites).toEqual([]);
    expect(published('run.started')).toEqual([]);
    // `secretsFor` throwing would have surfaced as an ERRORED run; the run is
    // untouched, so the processor bailed before any setup work at all.
    expect(db.run.errorMessage).toBeNull();
  });

  it('does not start a run that was cancelled while its setup was in flight', async () => {
    // The cancel lands after the processor has loaded the run and before it
    // writes RUNNING. The conditional start is the only thing standing between
    // the user pressing Cancel and a browser being driven at production.
    const db = fakeDb({
      run: { status: 'QUEUED' },
      afterFindFirst: (d) => {
        d.run.status = 'CANCELLED';
      },
    });

    await processRun(job());

    expect(h.executed).toEqual([]);
    expect(db.run.status).toBe('CANCELLED');
    // The start attempt happened and matched nothing. That is the fix: an
    // unconditional update here is what used to resurrect a cancelled run.
    expect(db.runWrites).toHaveLength(1);
    expect(db.runWrites[0]).toMatchObject({ op: 'updateMany', matched: 0 });
    expect(published('run.started')).toEqual([]);
    expect(h.log).toContain('info:run is no longer startable; not executing the suite');
  });

  it("refuses a job that does not say which run, rather than executing somebody else's", async () => {
    /*
     * The payload arrives through `as unknown as RunJob` on a BullMQ job, so
     * nothing type-checks it. Prisma reads an undefined `where` value as an
     * ABSENT FILTER, not an impossible one — so an unguarded
     * `findFirst({ where: { id: undefined, orgId: undefined } })` returns the
     * first Run in the table, belonging to whichever tenant sorts first. The
     * processor would then mark THAT run RUNNING and drive a browser through
     * another organisation's suite, against their environment, production
     * included.
     */
    const db = fakeDb({ run: { status: 'QUEUED' } });

    await expect(
      processRun({ orgId: undefined, runId: undefined } as unknown as ShardedRunJob),
    ).rejects.toThrow(/missing orgId or runId/i);

    expect(h.executed).toEqual([]);
    expect(db.runWrites).toEqual([]);
    expect(db.run.status).toBe('QUEUED');
  });

  it('still re-executes a job redelivered for a run already marked RUNNING', async () => {
    // The other half of the same conditional: BullMQ hands a stalled job back,
    // and matching only QUEUED would have it return quietly and leave the run
    // at RUNNING with no verdict, for good.
    const db = fakeDb({ run: { status: 'RUNNING', startedAt: new Date('2026-08-01T00:00:00Z') } });

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2', 't3']);
    expect(db.run.status).toBe('PASSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) A throw before the test loop
// ─────────────────────────────────────────────────────────────────────────────

describe('a failure in the pre-loop setup', () => {
  it('finalises the run ERRORED instead of stranding it, and still notifies', async () => {
    // One rotated vault key stranded every run in an org this way: setup used to
    // sit outside the try, so anything it threw escaped the processor entirely.
    const db = fakeDb({ run: { status: 'QUEUED' } });
    h.secretsThrows = new Error('no key version 2 for this org');

    await expect(processRun(job())).resolves.toBeUndefined();

    expect(h.executed).toEqual([]);
    expect(db.run.status).toBe('ERRORED');
    expect(db.run.errorMessage).toBe('no key version 2 for this org');
    // The clock stopped, the gate resolved, and the run reported.
    expect(db.run.finishedAt).toBeInstanceOf(Date);
    expect((db.run.gateResult as { passed: boolean }).passed).toBe(true);
    expect(
      (db.run.gateResult as { evaluations: Array<{ action: string }> }).evaluations.some(
        (e) => e.action === 'BLOCK',
      ),
    ).toBe(false);
    // The notification is the Slack message and the PR comment. Its absence was
    // the part nobody could see from the cockpit.
    expect(h.notified).toEqual([
      { orgId: ORG, event: 'run.finished', payload: { runId: RUN, prNumber: 42 } },
    ]);
    expect(published('run.finished')).toHaveLength(1);
  });
});

describe('a run job that died before the processor could finalise anything', () => {
  it('is marked ERRORED from the failed handler, with counts and a notification', async () => {
    // Nothing else in the system looks at a permanently failed run job. Without
    // this the run sits at RUNNING forever with the cockpit clock still ticking.
    const db = fakeDb({ run: { status: 'RUNNING', startedAt: new Date() } });
    db.results[0]!.status = 'PASSED';
    db.results[1]!.status = 'FAILED';

    const rescued = await failRunFromDeadJob({
      orgId: ORG,
      runId: RUN,
      errorMessage: 'job stalled more than maxStalledCount times',
    });

    expect(rescued).toBe(true);
    expect(db.run.status).toBe('ERRORED');
    expect(db.run.errorMessage).toBe('job stalled more than maxStalledCount times');
    // Counted off the result rows, because nothing in memory survived the job.
    expect(db.run.passedCount).toBe(1);
    expect(db.run.failedCount).toBe(1);
    expect(db.run.skippedCount).toBe(1);
    expect(h.notified).toHaveLength(1);
    expect(published('run.finished')).toHaveLength(1);
  });

  it('leaves a run that already reported exactly as it was', async () => {
    // A job failing AFTER the run reported is not a reason to rewrite what it
    // said — the claim is conditional on the run still being in flight.
    const db = fakeDb({ run: { status: 'PASSED', finishedAt: new Date(), passedCount: 3 } });

    const rescued = await failRunFromDeadJob({ orgId: ORG, runId: RUN, errorMessage: 'too late' });

    expect(rescued).toBe(false);
    expect(db.run.status).toBe('PASSED');
    expect(db.run.errorMessage).toBeNull();
    expect(h.notified).toEqual([]);
  });

  it('refuses a job whose payload carries no run id, rather than matching every run', async () => {
    /*
     * The rescue reads `orgId` and `runId` straight off `job.data`, and a job
     * shape that predates them (or a hand-enqueued one) leaves both undefined.
     * Prisma reads an undefined `where` value as "no filter", so the claim
     * would stop being scoped to one run and one org: `updateMany` would stamp
     * `finalizedAt` on EVERY queued or running run in the database, across
     * every tenant, and then finalise whichever row `findFirst` happened to
     * return. One malformed job would end every live run on the platform.
     */
    const db = fakeDb({ run: { status: 'RUNNING' } });

    const rescued = await failRunFromDeadJob({
      orgId: undefined as unknown as string,
      runId: undefined as unknown as string,
      errorMessage: 'unparseable job',
    });

    expect(rescued).toBe(false);
    expect(db.run.status).toBe('RUNNING');
    expect(db.run.finalizedAt).toBeNull();
    expect(db.otherRuns.map((r) => r.status)).toEqual(['RUNNING', 'QUEUED']);
    expect(db.otherRuns.every((r) => r.finalizedAt === null)).toBe(true);
    expect(h.notified).toEqual([]);
  });
});

describe("the worker's permanently-failed handler", () => {
  it('hands a dead run job to the rescue so the run stops being stuck', async () => {
    // The handler is the only listener that hears about a job which failed
    // before `processRun` could finalise anything — a throw in setup, or a job
    // BullMQ could not even hand to the processor.
    const db = fakeDb({ run: { status: 'RUNNING', startedAt: new Date() } });

    await import('../index.js');
    const runWorker = h.workers.find((w) => w.name === QUEUE_NAMES.run);
    expect(runWorker, 'the run queue must have a registered worker').toBeDefined();

    const failed = runWorker!.listeners.get('failed');
    expect(failed, "the run worker must listen for 'failed'").toBeDefined();

    (failed as unknown as (job: unknown, err: Error) => void)(
      {
        id: 'j1',
        name: QUEUE_NAMES.run,
        data: { orgId: ORG, runId: RUN },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      new Error('Missing lock for job j1'),
    );

    // The rescue is fire-and-forget inside an event handler, so it settles a
    // tick later rather than being awaited.
    await vi.waitFor(() => expect(db.run.status).toBe('ERRORED'));
    expect(db.run.errorMessage).toBe('Missing lock for job j1');
    expect(h.notified).toHaveLength(1);
    expect(published('run.finished')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Cancel while the suite is running
// ─────────────────────────────────────────────────────────────────────────────

describe('a cancel that lands while the run is being finalised', () => {
  it('is not relabelled ERRORED by the failure path it raced', async () => {
    /*
     * The conditional START closed this at one layer; `finalizeRun`'s write
     * reopened it at the next. Setup throws (so the catch heads for ERRORED),
     * and the cancel lands in between. An unconditional
     * `run.update({ where: { id } })` would stamp ERRORED over CANCELLED, and
     * the cockpit — which already told the user "cancelled" — would flip to a
     * failure they did not cause.
     */
    const db = fakeDb({
      run: { status: 'QUEUED' },
      afterFindFirst: (d) => {
        // Cancelled after the snapshot, so the early bail does not catch it and
        // the conditional start is what stops execution.
        d.run.status = 'CANCELLED';
      },
    });
    h.secretsThrows = new Error('vault unavailable');

    await processRun(job());

    expect(db.run.status).toBe('CANCELLED');
    expect(db.run.errorMessage).toBeNull();
    // A terminal notification for a status the row does not have is the
    // reassuring lie this file exists to avoid.
    expect(h.notified.filter((n) => n.event === 'run.finished')).toEqual([]);
  });
});

describe('a run cancelled while its suite is executing', () => {
  it('stops between tests and still reports counts, a gate and a notification', async () => {
    const db = fakeDb({ run: { status: 'QUEUED' } });
    // The cancel lands while the first test is executing. The loop checks
    // between tests, so exactly one test runs and the rest are left at their
    // placeholder SKIPPED.
    h.afterExecute = (testId) => {
      if (testId === 't1') db.run.status = 'CANCELLED';
    };

    await processRun(job());

    expect(h.executed).toEqual(['t1']);
    expect(db.run.status).toBe('CANCELLED');

    // The summary the cockpit renders. This used to be blank forever: the bare
    // `return` skipped the counts, the gate and the notification alike.
    expect(db.run.passedCount).toBe(1);
    expect(db.run.skippedCount).toBe(2);
    expect(db.run.failedCount).toBe(0);
    expect(db.run.finishedAt).toBeInstanceOf(Date);
    expect((db.run.gateResult as { passed: boolean }).passed).toBe(true);
    expect(
      (db.run.gateResult as { evaluations: Array<{ action: string }> }).evaluations.some(
        (e) => e.action === 'BLOCK',
      ),
    ).toBe(false);

    // And somebody downstream heard about it.
    expect(h.notified).toEqual([
      { orgId: ORG, event: 'run.finished', payload: { runId: RUN, prNumber: 42 } },
    ]);
    const finished = published('run.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]!.data).toMatchObject({ status: 'CANCELLED', passed: 1, skipped: 2 });
  });

  it('counts the result rows rather than the tests this process happened to reach', async () => {
    // The in-memory counters describe only what ran here. On a cancel they are
    // not the run's counts, and reporting them as such under-counts the skips.
    const db = fakeDb({ run: { status: 'QUEUED' } });
    h.afterExecute = () => {
      db.run.status = 'CANCELLED';
    };

    await processRun(job());

    const total = db.run.passedCount + db.run.failedCount + db.run.flakyCount + db.run.skippedCount;
    expect(total).toBe(db.results.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) The customer's repository, or an honest refusal
// ─────────────────────────────────────────────────────────────────────────────

/** A materialised workspace, as the processor sees one. */
const readyWorkspace =
  (root = '/tmp/qaai-repo-test') =>
  () => ({
    kind: 'ready' as const,
    workspace: { root, source: 'acme/app@abc1234', fileCount: 12 },
    bytes: 4096,
    skippedLinks: 0,
    cleanup: async () => {
      h.cleanups += 1;
    },
  });

describe('a repo-dependent test in a project with no connected repository', () => {
  it('is recorded as not evaluated, with the reason, and never executed', async () => {
    /*
     * The whole defect in one test. INTEGRATION, UNIT_GEN and MUTATION run a
     * command inside the customer's repository; the worker used to hand them
     * its OWN working directory, so `npx vitest run` executed QAAI's suite and
     * filed the result as the customer's. With no repository there is nothing
     * to run in, and the only honest answer is to say so.
     *
     * The materialiser here is the real one — a project with no repo needs no
     * network to establish that.
     */
    const db = fakeDb({
      results: [resultFor('t1', { type: 'INTEGRATION' }), resultFor('t2', { type: 'E2E' })],
    });

    await processRun(job());

    // Not a pass, not a bare failure: SKIPPED with a sentence.
    expect(db.results[0]!.status).toBe('SKIPPED');
    expect(db.results[0]!.errorMessage).toMatch(/was not evaluated/);
    expect(db.results[0]!.errorMessage).toMatch(/no connected repository/i);
    expect(db.results[0]!.errorMessage).toMatch(/No result here is a verdict on your application/);
    // The plugin was never reached, so nothing ran anywhere.
    expect(h.executed).toEqual(['t2']);
    // And the rest of the suite still ran, which is the point of a skip.
    expect(db.run.skippedCount).toBe(1);
    expect(db.run.passedCount).toBe(1);
    expect(db.run.status).toBe('PASSED');
  });

  it('asks once for the whole suite, not once per test', async () => {
    const db = fakeDb({
      results: [
        resultFor('t1', { type: 'INTEGRATION' }),
        resultFor('t2', { type: 'UNIT_GEN' }),
        resultFor('t3', { type: 'MUTATION' }),
      ],
    });

    await processRun(job());

    expect(h.materialiseCalls).toBe(1);
    expect(db.results.map((r) => r.status)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED']);
  });

  it('does not fetch a repository for a suite that does not need one', async () => {
    // An E2E-only run must not pay for a download it will never read.
    fakeDb();

    await processRun(job());

    expect(h.materialiseCalls).toBe(0);
    expect(h.executed).toEqual(['t1', 't2', 't3']);
  });
});

describe('a run with a materialised repository', () => {
  it('hands the workspace root to the plugin', async () => {
    h.materialise = readyWorkspace('/tmp/qaai-repo-run1');
    fakeDb({
      results: [resultFor('t1', { type: 'UNIT_GEN' }), resultFor('t2', { type: 'E2E' })],
    });

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2']);
    // Attached to every context, not only the repo-dependent ones: a checkout
    // that exists is a fact about the run, and the plugins that do not need one
    // simply never look.
    expect(h.contexts.map((c) => c.workspace)).toEqual([
      '/tmp/qaai-repo-run1',
      '/tmp/qaai-repo-run1',
    ]);
  });

  it('removes the workspace when the run finishes', async () => {
    h.materialise = readyWorkspace();
    fakeDb({ results: [resultFor('t1', { type: 'INTEGRATION' })] });

    await processRun(job());

    expect(h.cleanups).toBe(1);
  });

  it('removes the workspace when the run throws', async () => {
    /*
     * The `finally` is the claim. A tenant's source tree must not outlive the
     * run that needed it, and a worker that leaks one temp tree per run fills
     * its disk in a day — so the cleanup cannot live on the success path.
     */
    h.materialise = readyWorkspace();
    const db = fakeDb({ results: [resultFor('t1', { type: 'INTEGRATION' })] });
    // Blow up AFTER the workspace exists, inside the loop, where only the
    // run-level catch can see it.
    (h.prisma.test as { update: () => Promise<unknown> }).update = async () => {
      throw new Error('the database went away mid-suite');
    };

    await expect(processRun(job())).resolves.toBeUndefined();

    expect(db.run.status).toBe('ERRORED');
    expect(h.cleanups).toBe(1);
  });

  it('removes the workspace when the run is cancelled mid-suite', async () => {
    h.materialise = readyWorkspace();
    const db = fakeDb({
      results: [resultFor('t1', { type: 'INTEGRATION' }), resultFor('t2', { type: 'INTEGRATION' })],
    });
    h.afterExecute = (testId) => {
      if (testId === 't1') db.run.status = 'CANCELLED';
    };

    await processRun(job());

    expect(db.run.status).toBe('CANCELLED');
    expect(h.cleanups).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4b) Whether a repository is needed is a question about the TEST, not its type
//
// `processRun` asked `REPO_DEPENDENT_TEST_TYPES.has(test.type)` — a static set
// of three — at both of its sites. That is wrong in both directions for four
// more types, and the expensive direction is under-reporting: a suite made
// entirely of CONTRACT, PROTOCOL, MOBILE or declared-command E2E tests
// materialised nothing and then honestly skipped every test in it. Safe, and
// useless. It now asks `testNeedsRepository(row.test)`, which reads the SPEC.
//
// The predicate is unit-tested in repo-materialise. What is tested here is the
// WIRING, which is the half that was wrong — and the fixtures therefore all
// carry a real `spec`. `testNeedsRepository` reads `test.spec`, the run query
// uses `include: { test: true }` so the column is present, and a fixture that
// left `spec` at its default `null` would answer "no checkout needed" for every
// conditional type and pass while proving nothing.
// ─────────────────────────────────────────────────────────────────────────────

describe('a suite whose need for a checkout depends on the spec, not the type', () => {
  it('fetches the repository for a CONTRACT test whose pact is a path in the repo', async () => {
    /*
     * The case that was broken. CONTRACT is not in the static set, so this run
     * used to materialise nothing and then skip the only test in it — a green
     * board over a contract nobody verified.
     */
    const db = fakeDb({
      results: [
        resultFor('t_pact', {
          type: 'CONTRACT',
          spec: { kind: 'pact', pactPath: 'contracts/web-consumer.json' },
        }),
      ],
    });

    await processRun(job());

    // Asked for. There is no repository on the fake project, so the honest
    // outcome is a SKIP that names the gap — never a pass, and never silence.
    expect(h.materialiseCalls).toBe(1);
    expect(h.executed).toEqual([]);
    expect(db.results[0]!.status).toBe('SKIPPED');
    expect(db.results[0]!.errorMessage).toMatch(/was not evaluated/);
    expect(db.results[0]!.errorMessage).toMatch(/no connected repository/i);
  });

  it('executes the same test with no checkout when the pact comes from a broker URL', async () => {
    /*
     * The other direction, and the reason the predicate reads the spec instead
     * of the type: a pact fetched over https touches no file, so this test must
     * not pay for a download — nor be skipped because the project has no
     * repository to download.
     */
    const db = fakeDb({
      results: [
        resultFor('t_broker', {
          type: 'CONTRACT',
          spec: {
            kind: 'pact',
            pactPath: 'https://pact-broker.acme.example/pacts/provider/api/latest',
          },
        }),
      ],
    });

    await processRun(job());

    expect(h.materialiseCalls).toBe(0);
    expect(h.executed).toEqual(['t_broker']);
    /*
     * The per-RESULT status, not the run's. What this section is about is which
     * tests the repo decision lets execute; the run-level verdict is decided by
     * the whole of finalisation and asserting it here would couple these cases
     * to every other part of the processor.
     */
    expect(db.results[0]!.status).toBe('PASSED');
    expect(db.results[0]!.errorMessage).toBeNull();
  });

  it('fetches the repository for an E2E test that declares its own command', async () => {
    // `routeFor` treats a non-empty `command` as the owner's decision to run
    // their own suite, which happens inside their repository. E2E is not in the
    // static set either, so this is the same hole in a far commoner type.
    const db = fakeDb({
      results: [
        resultFor('t_declared', {
          type: 'E2E',
          spec: { command: 'npx playwright test', workingDirectory: 'apps/web' },
        }),
      ],
    });

    await processRun(job());

    expect(h.materialiseCalls).toBe(1);
    expect(h.executed).toEqual([]);
    expect(db.results[0]!.status).toBe('SKIPPED');
  });

  it('runs a harness E2E test with no checkout, even with a spec present', async () => {
    /*
     * A spec that exists and does NOT declare a command. This fixture is the
     * one that would be vacuous if `spec` were left null: `testNeedsRepository`
     * answers false for a null spec too, so a null-spec fixture would pass
     * whether the predicate read the spec or not.
     */
    const db = fakeDb({
      results: [
        resultFor('t_harness', {
          type: 'E2E',
          spec: { viewport: { width: 1280, height: 720 }, retries: 1 },
        }),
      ],
    });

    await processRun(job());

    expect(h.materialiseCalls).toBe(0);
    expect(h.executed).toEqual(['t_harness']);
    expect(db.results[0]!.status).toBe('PASSED');
  });

  it('hands the workspace to the spec-dependent test, and asks for it once', async () => {
    /*
     * BOTH call sites, on one test. Site one is the once-per-run decision to
     * materialise at all; site two is the per-test decision about whether a
     * missing checkout blocks this test. They have to agree, and the dangerous
     * disagreement is the inverse of the original bug: a run that fetched a
     * repository for the suite and then skipped the very test that needed it.
     *
     * One test rather than two deliberately — the point is the agreement
     * between the two sites about one row, and a multi-test fixture would make
     * this case depend on the rest of the suite executing.
     */
    h.materialise = readyWorkspace('/tmp/qaai-repo-contract');
    const db = fakeDb({
      results: [
        resultFor('t_pact', {
          type: 'CONTRACT',
          spec: { kind: 'pact', pactPath: 'contracts/web-consumer.json' },
        }),
      ],
    });

    await processRun(job());

    expect(h.materialiseCalls).toBe(1);
    // Executed, NOT skipped: the checkout it asked for exists.
    expect(h.executed).toEqual(['t_pact']);
    expect(h.contexts.map((c) => c.workspace)).toEqual(['/tmp/qaai-repo-contract']);
    expect(db.results[0]!.status).toBe('PASSED');
    expect(h.cleanups).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) One session per role, and one login per session
// ─────────────────────────────────────────────────────────────────────────────

describe('a suite whose tests name different auth profiles', () => {
  it('runs each test under its own session, and logs in once per profile', async () => {
    /*
     * The defect: a run resolved ONE storage state and applied it to every
     * test, so an admin test and a member test in the same suite could not both
     * be right. Four tests here — admin, member, admin, no profile — prove both
     * halves at once: the sessions are distinct per profile, and the logins are
     * per PROFILE rather than per test.
     */
    const db = fakeDb({
      results: [
        resultFor('t1', { authProfileId: 'p_admin' }),
        resultFor('t2', { authProfileId: 'p_member' }),
        resultFor('t3', { authProfileId: 'p_admin' }),
        resultFor('t4'),
      ],
      profiles: [profileRow({ id: 'p_admin' }), profileRow({ id: 'p_member' })],
    });

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2', 't3', 't4']);
    // Two profiles, two logins — not three, and not four.
    expect(h.logins).toEqual(['p_admin', 'p_member']);

    const byTest = new Map(h.contexts.map((c) => [c.testId, c]));
    expect(byTest.get('t1')!.authProfileId).toBe('p_admin');
    expect(byTest.get('t2')!.authProfileId).toBe('p_member');
    // Same profile, same session…
    expect(byTest.get('t3')!.storageState).toEqual(byTest.get('t1')!.storageState);
    // …different profile, never the same session.
    expect(byTest.get('t2')!.storageState).not.toEqual(byTest.get('t1')!.storageState);
    // A test that named no profile gets the run default, which here is the
    // first profile on the environment and has no cached session.
    expect(byTest.get('t4')!.storageState).toBeNull();
    expect(byTest.get('t4')!.authProfileId).toBeNull();

    // The captured session is cached on the profile, so the next run and the
    // crawler reuse it instead of driving another browser.
    expect(db.profileWrites.map((w) => w.id)).toEqual(['p_admin', 'p_member']);
  });

  it('reuses a session already cached on the profile without logging in', async () => {
    fakeDb({
      results: [resultFor('t1', { authProfileId: 'p_admin' })],
      profiles: [
        profileRow({
          id: 'p_admin',
          storageState: { cookies: [{ name: 'sid', value: 'cached' }] },
          storageStateExpiresAt: new Date(Date.now() + 3600_000),
        }),
      ],
    });

    await processRun(job());

    expect(h.logins).toEqual([]);
    expect(h.contexts[0]!.storageState).toEqual({ cookies: [{ name: 'sid', value: 'cached' }] });
  });

  it('signs in again when the cached session has expired', async () => {
    fakeDb({
      results: [resultFor('t1', { authProfileId: 'p_admin' })],
      profiles: [
        profileRow({
          id: 'p_admin',
          storageState: { cookies: [{ name: 'sid', value: 'stale' }] },
          storageStateExpiresAt: new Date(Date.now() - 1000),
        }),
      ],
    });

    await processRun(job());

    expect(h.logins).toEqual(['p_admin']);
    expect(h.contexts[0]!.storageState).toEqual({
      cookies: [{ name: 'sid', value: 'session-for-p_admin' }],
    });
  });
});

describe('a test whose auth profile cannot be signed in', () => {
  it('fails with the reason, and is never run anonymously', async () => {
    /*
     * The costume change. Falling back to the run default — or to nothing —
     * would run a permission test logged out: the browser gets a login
     * redirect, "no error banner" passes, and a test nobody is really running
     * reports green. FAILED is deliberate: a SKIP does not block a gate.
     */
    h.loginRefusals = new Map([['p_admin', 'the password was rotated']]);
    const db = fakeDb({
      results: [
        resultFor('t1', { authProfileId: 'p_admin' }),
        resultFor('t2', { authProfileId: 'p_admin' }),
        resultFor('t3'),
      ],
      profiles: [profileRow({ id: 'p_admin' })],
    });

    await processRun(job());

    expect(db.results[0]!.status).toBe('FAILED');
    expect(db.results[0]!.errorMessage).toMatch(
      /Could not sign in as auth profile "profile p_admin"/,
    );
    expect(db.results[0]!.errorMessage).toMatch(/the password was rotated/);
    expect(db.results[1]!.status).toBe('FAILED');
    // One login attempt for thirty broken tests, not thirty.
    expect(h.logins).toEqual(['p_admin']);
    // Only the test that named no profile executed.
    expect(h.executed).toEqual(['t3']);
    // A failure blocks: this is the half a skip would have thrown away.
    expect(db.run.status).toBe('FAILED');
    expect(db.run.failedCount).toBe(2);
    // And it reached triage like any other failure.
    expect(h.triaged.map((t) => t.testResultId)).toEqual(['r_t1', 'r_t2']);
  });

  it('refuses a profile that belongs to another environment', async () => {
    // Its cookies are for another host: using them would send staging's session
    // to production, get a login page, and report whatever the test asserted
    // about it.
    const db = fakeDb({
      results: [resultFor('t1', { authProfileId: 'p_other' })],
      profiles: [profileRow({ id: 'p_other', environmentId: 'env2' })],
    });

    await processRun(job());

    expect(db.results[0]!.status).toBe('FAILED');
    expect(db.results[0]!.errorMessage).toMatch(/belongs to a different environment/);
    expect(h.logins).toEqual([]);
    expect(h.executed).toEqual([]);
  });

  it('refuses a profile id that does not exist in this organisation', async () => {
    // A test row's profile id is data. One from another tenant must resolve to
    // nothing rather than to their session.
    const db = fakeDb({
      results: [resultFor('t1', { authProfileId: 'p_someone_elses' })],
      profiles: [profileRow({ id: 'p_mine' })],
    });

    await processRun(job());

    expect(db.results[0]!.status).toBe('FAILED');
    expect(db.results[0]!.errorMessage).toMatch(/no longer exists in this organisation/);
    expect(h.executed).toEqual([]);
  });

  it('fails a test whose role was required and whose binding is gone', async () => {
    /*
     * Deleting a profile nulls `Test.authProfileId` by foreign key and leaves
     * `authProfileRequired` true on purpose. With no binding to resolve, the
     * run default is all that is left — and here there is no default either, so
     * the only alternative to refusing is running a role test signed out.
     */
    const db = fakeDb({ results: [resultFor('t1', { authProfileRequired: true })] });

    await processRun(job());

    expect(db.results[0]!.status).toBe('FAILED');
    expect(db.results[0]!.errorMessage).toMatch(/requiring a signed-in role/);
    expect(db.results[0]!.errorMessage).toMatch(/Re-bind it to a profile/);
    expect(h.executed).toEqual([]);
    expect(h.logins).toEqual([]);
  });

  it('runs a required-role test when the environment has a usable session', async () => {
    // The intent is "not signed out", not "signed in as one specific person",
    // so the run's default session satisfies it.
    const db = fakeDb({
      results: [resultFor('t1', { authProfileRequired: true })],
      profiles: [
        profileRow({
          id: 'p_default',
          storageState: { cookies: [{ name: 'sid', value: 'cached' }] },
          storageStateExpiresAt: new Date(Date.now() + 3600_000),
        }),
      ],
    });

    await processRun(job());

    expect(db.results[0]!.status).toBe('PASSED');
    expect(h.contexts[0]!.authProfileId).toBe('p_default');
    expect(h.logins).toEqual([]);
  });

  it('does not log in for a test that could not have run anyway', async () => {
    // No repository means nothing will execute, so there is nothing to log into
    // an application for.
    const db = fakeDb({
      results: [resultFor('t1', { type: 'UNIT_GEN', authProfileId: 'p_admin' })],
      profiles: [profileRow({ id: 'p_admin' })],
    });

    await processRun(job());

    expect(db.results[0]!.status).toBe('SKIPPED');
    expect(h.logins).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (6) Quarantine: the counter that fed every other consumer
//
// `evaluateGates` filtered quarantined tests out of the gate RULES, and that
// was the only place quarantine was honoured. The counters could not see it —
// the in-loop switch ignored it, and `aggregateCounts` was a
// `groupBy(['status'])`, which Prisma cannot join to a relation's column at all.
// So `Run.failedCount` went above zero, the run was written FAILED, and from
// there the CLI exited 1, the GitHub check went red and the JUnit XML carried a
// <failure> — over a test that had already vanished from every gate rule.
//
// Nothing in this file asserted a count on a FAILING run before now, which is
// precisely why it survived.
// ─────────────────────────────────────────────────────────────────────────────

/** A run of three tests where `t2` is quarantined and all three fail. */
function quarantinedFailureDb(over: Parameters<typeof fakeDb>[0] = {}) {
  const results: ResultRow[] = [
    resultFor('t1'),
    resultFor('t2', {
      quarantined: true,
      quarantinedAt: new Date(),
      quarantineExpiresAt: new Date(Date.now() + 86_400_000),
    }),
    resultFor('t3'),
  ];
  return fakeDb({
    run: { status: 'QUEUED' },
    results,
    projectTests: results.map((r) => r.test),
    ...over,
  });
}

describe('a run whose only failure is a quarantined test', () => {
  beforeEach(() => {
    h.statusFor = new Map([['t2', 'FAILED']]);
  });

  it('is written PASSED, not FAILED', async () => {
    // THE DEFECT. One assertion, and it was never made.
    const db = quarantinedFailureDb();
    await processRun(job());
    expect(db.run.status).toBe('PASSED');
  });

  it('leaves failedCount at zero, which is what every other consumer reads', async () => {
    const db = quarantinedFailureDb();
    await processRun(job());
    expect(db.run.failedCount).toBe(0);
  });

  it('counts it as a QUARANTINED failure, not as a skip and not as nothing', async () => {
    const db = quarantinedFailureDb();
    await processRun(job());
    expect(db.run.quarantinedFailedCount).toBe(1);
    // Folding it into `skipped` would make it indistinguishable from a
    // deliberate skip, which is the same defect in a kinder word.
    expect(db.run.skippedCount).toBe(0);
    expect(db.run.passedCount).toBe(2);
  });

  it('every result lands in exactly one column, so no total double-counts', async () => {
    const db = quarantinedFailureDb();
    await processRun(job());
    const total =
      db.run.passedCount +
      db.run.failedCount +
      db.run.flakyCount +
      db.run.skippedCount +
      db.run.quarantinedFailedCount;
    expect(total).toBe(db.results.length);
  });

  it('says so on the live frame, so the cockpit cannot print a clean green', async () => {
    quarantinedFailureDb();
    await processRun(job());
    const [finished] = published('run.finished');
    expect(finished!.data).toMatchObject({
      status: 'PASSED',
      quarantinedFailed: 1,
      verdict: { passed: true, suppressedFailures: 1 },
    });
    expect(String((finished!.data.verdict as { reason: string }).reason)).toContain('quarantined');
  });

  it('keeps the passing-test COUNT on the frame, beside the boolean verdict', async () => {
    // `...counts` spreads a `passed` number; a top-level `passed: boolean`
    // beside it silently replaced that count. The verdict is nested for that
    // reason, and this is the assertion that says so.
    quarantinedFailureDb();
    await processRun(job());
    const [finished] = published('run.finished');
    expect(finished!.data.passed).toBe(2);
  });

  it('still enqueues triage for it — a suppressed failure is still investigated', async () => {
    quarantinedFailureDb();
    await processRun(job());
    expect(h.triaged.map((t) => t.testResultId)).toContain('r_t2');
  });
});

describe('a quarantine that has expired', () => {
  it('gates again: the run goes FAILED and the failure is counted', async () => {
    h.statusFor = new Map([['t2', 'FAILED']]);
    const results: ResultRow[] = [
      resultFor('t1'),
      resultFor('t2', {
        quarantined: true,
        quarantinedAt: new Date(Date.now() - 60 * 86_400_000),
        // Ran out yesterday. A quarantine with no end date is a deletion nobody
        // signed, so it ends — and ending means the test gates again.
        quarantineExpiresAt: new Date(Date.now() - 86_400_000),
      }),
      resultFor('t3'),
    ];
    const db = fakeDb({
      run: { status: 'QUEUED' },
      results,
      projectTests: results.map((r) => r.test),
    });

    await processRun(job());

    expect(db.run.status).toBe('FAILED');
    expect(db.run.failedCount).toBe(1);
    expect(db.run.quarantinedFailedCount).toBe(0);
  });
});

describe('an unquarantined failure still fails the build', () => {
  it('writes FAILED and counts it, so the fix did not break the normal case', async () => {
    h.statusFor = new Map([['t2', 'FAILED']]);
    const db = fakeDb({ run: { status: 'QUEUED' } });

    await processRun(job());

    expect(db.run.status).toBe('FAILED');
    expect(db.run.failedCount).toBe(1);
    expect(db.run.quarantinedFailedCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (7) The budget, and the rot alarm riding on the gate result
// ─────────────────────────────────────────────────────────────────────────────

describe('the quarantine budget, as a gate', () => {
  function overBudget(quarantineBudgetPercent?: number | null) {
    // Ten live tests in the project, four of them quarantined — 40%, against a
    // default cap of 5% (floor 2).
    const projectTests = Array.from({ length: 10 }, (_, i) =>
      testRow(`p${i}`, {
        quarantined: i < 4,
        quarantinedAt: i < 4 ? new Date() : null,
        quarantineExpiresAt: i < 4 ? new Date(Date.now() + 86_400_000) : null,
      }),
    );
    return fakeDb({
      run: { status: 'QUEUED' },
      projectTests,
      ...(quarantineBudgetPercent === undefined ? {} : { quarantineBudgetPercent }),
    });
  }

  it('BLOCKS a run whose project has suppressed more than its budget', async () => {
    const db = overBudget();
    await processRun(job());

    const gate = db.run.gateResult as {
      passed: boolean;
      evaluations: Array<{ action: string; detail: string }>;
    };
    expect(gate.passed).toBe(false);
    const block = gate.evaluations.find((e) => e.action === 'BLOCK');
    expect(block!.detail).toContain('4 of 10');
    expect(block!.detail).toMatch(/fix or delete/i);
  });

  it('fails the run on that alone, with every test green', async () => {
    const db = overBudget();
    await processRun(job());
    expect(db.run.status).toBe('FAILED');
    expect(db.run.failedCount).toBe(0);
  });

  it('honours a project that raised its own cap, on purpose and in writing', async () => {
    const db = overBudget(50);
    await processRun(job());
    expect((db.run.gateResult as { passed: boolean }).passed).toBe(true);
    expect(db.run.status).toBe('PASSED');
  });

  it('does not count an EXPIRED quarantine against the budget', async () => {
    // It is not suppressing anything any more, so charging the project for it
    // would make the budget tighten on its own over time.
    const projectTests = Array.from({ length: 10 }, (_, i) =>
      testRow(`p${i}`, {
        quarantined: i < 4,
        quarantinedAt: i < 4 ? new Date(Date.now() - 60 * 86_400_000) : null,
        quarantineExpiresAt: i < 4 ? new Date(Date.now() - 86_400_000) : null,
      }),
    );
    const db = fakeDb({ run: { status: 'QUEUED' }, projectTests });

    await processRun(job());

    expect((db.run.gateResult as { passed: boolean }).passed).toBe(true);
    const gate = db.run.gateResult as { evaluations: Array<{ action: string; detail: string }> };
    // And it is still NEWS: they gate again now, and somebody has to know.
    expect(gate.evaluations.some((e) => e.detail.includes('Quarantine expired'))).toBe(true);
  });

  it('WARNS about quarantines with no end date at all', async () => {
    const projectTests = [
      testRow('p0', {
        quarantined: true,
        quarantinedAt: new Date(Date.now() - 60 * 86_400_000),
        quarantineExpiresAt: null,
      }),
      ...Array.from({ length: 99 }, (_, i) => testRow(`q${i}`)),
    ];
    const db = fakeDb({ run: { status: 'QUEUED' }, projectTests });

    await processRun(job());

    const gate = db.run.gateResult as {
      passed: boolean;
      evaluations: Array<{ action: string; detail: string }>;
    };
    const warn = gate.evaluations.find((e) => e.detail.includes('no end date'));
    expect(warn!.action).toBe('WARN');
    // A WARN must not hold a merge.
    expect(gate.passed).toBe(true);
  });

  it('counts the suppressions exactly, not off the capped list of names', async () => {
    /*
     * The list of names the warning prints is capped at 200. An earlier draft
     * of this change counted the budget from THAT list, which meant a project
     * with 4,000 quarantined tests reported 200, landed under its cap, and the
     * alarm built to catch a suite that has stopped testing anything went quiet
     * on the worst suite in the install. 300 quarantined tests out of 400 is
     * past the cap by any reading, and the detail has to say 300.
     */
    const projectTests = Array.from({ length: 400 }, (_, i) =>
      testRow(`p${i}`, {
        quarantined: i < 300,
        quarantinedAt: i < 300 ? new Date() : null,
        quarantineExpiresAt: i < 300 ? new Date(Date.now() + 86_400_000) : null,
      }),
    );
    const db = fakeDb({ run: { status: 'QUEUED' }, projectTests });

    await processRun(job());

    const gate = db.run.gateResult as { evaluations: Array<{ action: string; detail: string }> };
    const block = gate.evaluations.find((e) => e.action === 'BLOCK')!;
    expect(block.detail).toContain('300 of 400');
  });

  it('produces NO quarantine evaluation when the budget could not be read', async () => {
    // An unmeasured budget must not look like a budget that is fine.
    const db = fakeDb({ run: { status: 'QUEUED' } });
    const broken = h.prisma.test as { count: () => Promise<number> };
    broken.count = async () => {
      throw new Error('database unavailable');
    };

    await processRun(job());

    const gate = db.run.gateResult as {
      passed: boolean;
      evaluations: Array<{ rule: { kind: string } }>;
    };
    expect(gate.evaluations.some((e) => e.rule.kind === 'MAX_QUARANTINE_PERCENT')).toBe(false);
    // And the run still finalised rather than dying on a health query.
    expect(db.run.status).toBe('PASSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (8) Flake history: a rate with a direction
// ─────────────────────────────────────────────────────────────────────────────

describe('the flake trend', () => {
  it('writes a point per test, so the rate stops being only its latest value', async () => {
    const db = fakeDb({ run: { status: 'QUEUED' } });
    await processRun(job());

    expect(db.flakeHistory.size).toBe(3);
    const point = [...db.flakeHistory.values()][0]!;
    expect(point.worstRunId).toBe(RUN);
    expect(point.samples).toBe(1);
  });

  it('ACCUMULATES into the day rather than overwriting it', async () => {
    // Two runs in one day. The row is upserted, so the day's sample count goes
    // up and the table stays bounded by (tests x days) rather than by runs.
    const db = fakeDb({ run: { status: 'QUEUED' } });
    await processRun(job());
    db.run.status = 'QUEUED';
    db.run.finishedAt = null;
    await processRun(job());

    expect(db.flakeHistory.size).toBe(3);
    for (const point of db.flakeHistory.values()) expect(point.samples).toBe(2);
  });

  it('keeps the day PEAK, so collapsing a day cannot hide a spike', async () => {
    const db = fakeDb({ run: { status: 'QUEUED' } });
    // First run measures 0% (the fake's recent-results lookup is empty).
    await processRun(job());
    const before = [...db.flakeHistory.values()][0]!;
    expect(before.peakRatePercent).toBe(0);

    // Now the history says half the recent results flaked.
    const results = h.prisma.testResult as { findMany: (args?: unknown) => Promise<unknown> };
    const original = results.findMany;
    results.findMany = async (args?: unknown) => {
      const where = (args as { where?: { testId?: string } } | undefined)?.where;
      if (where?.testId) {
        return [
          { status: 'FLAKY', retriedAndPassed: false },
          { status: 'PASSED', retriedAndPassed: false },
        ];
      }
      return original.call(results, args);
    };
    db.run.status = 'QUEUED';
    db.run.finishedAt = null;
    await processRun(job());

    const after = [...db.flakeHistory.values()][0]!;
    expect(after.ratePercent).toBe(50);
    expect(after.peakRatePercent).toBe(50);
  });

  it('carries the denominator, so a trend cannot be read off a sample of two', async () => {
    const db = fakeDb({ run: { status: 'QUEUED' } });
    const results = h.prisma.testResult as { findMany: (args?: unknown) => Promise<unknown> };
    const original = results.findMany;
    results.findMany = async (args?: unknown) => {
      const where = (args as { where?: { testId?: string } } | undefined)?.where;
      if (where?.testId) return [{ status: 'FLAKY', retriedAndPassed: false }];
      return original.call(results, args);
    };

    await processRun(job());

    const point = [...db.flakeHistory.values()][0]!;
    expect(point.sampleSize).toBe(1);
    expect(point.failures).toBe(1);
    expect(point.ratePercent).toBe(100);
  });

  it('records whether the test was quarantined, so a flat 0% is readable', async () => {
    // Without it a suppressed test reads as a healthy one nobody is gating on.
    const db = quarantinedFailureDb();
    await processRun(job());
    const quarantined = [...db.flakeHistory.values()].find((p) => p.testId === 't2');
    expect(quarantined!.quarantined).toBe(true);
  });

  it('does not fail the run when the trend cannot be written', async () => {
    // The run's verdict is the product; the history is the instrument.
    const db = fakeDb({ run: { status: 'QUEUED' } });
    const history = h.prisma.testFlakeHistory as { findUnique: () => Promise<unknown> };
    history.findUnique = async () => {
      throw new Error('table missing');
    };

    await processRun(job());

    expect(db.run.status).toBe('PASSED');
    expect(h.log).toContain('warn:could not record the flake history point for this test');
  });
});
