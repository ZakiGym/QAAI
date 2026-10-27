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
    /**
     * The base-URL probe the REAL preflight is given. The preflight itself is
     * imported for real (it depends on node:fs and @qaai/shared, no browser);
     * only its one network call is a stand-in, because a unit test that reaches
     * the network is not a unit test and a suite that fails on a train is a
     * suite people delete.
     */
    probe: (
      url: string,
      timeoutMs: number,
    ) => Promise<{
      reached: boolean;
      status: number | null;
      detail: string;
    }>;
    /** Likewise the runnability probes: PATH and the browser install. */
    probes: {
      onPath?: (binary: string) => boolean;
      browserInstalled?: (engine: string) => boolean | null;
      platform?: string;
    };
    /** Every base-URL probe attempt, so the retry policy is observable. */
    probeCalls: number;
    /**
     * Test types this build has NO plugin for.
     *
     * The registry answers every type, which is why the loop's own
     * "no plugin for this type" branch was unreachable from this file — and
     * therefore untested, including the typed reason it writes. Reaching it
     * needs both halves: no plugin, AND a preflight that did not run (a working
     * preflight refuses the type before the loop, which is the whole point of
     * it).
     */
    pluginless: Set<string>;
    /**
     * What each test's plugin reports as its MATRIX and its NUMBERS, by test id.
     *
     * `TestExecution.variants` and `.metrics` are the two channels no plugin
     * fills yet — they landed with the models and the validators and nothing in
     * between — so the only way to exercise the writer is to supply them here,
     * exactly as a plugin eventually will. The payloads are deliberately raw
     * `unknown`: the worker validates them through the same two shared
     * validators the agent's POST body is built from, and a fixture already
     * narrowed to the parsed type could not reach that refusal at all.
     */
    measurements: Map<string, { variants?: unknown[]; metrics?: unknown[] }>;
    /** Every `logger.warn`, with its FIELDS — the only disclosure channel the
     * worker has when it refuses a report. */
    warned: Array<{ fields: Record<string, unknown>; msg: string }>;
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
    probe: async () => ({ reached: true, status: 200, detail: 'answered HTTP 200' }),
    probes: { onPath: () => true, browserInstalled: () => true, platform: 'linux' },
    probeCalls: 0,
    pluginless: new Set<string>(),
    measurements: new Map<string, { variants?: unknown[]; metrics?: unknown[] }>(),
    warned: [],
  }),
);

vi.mock('../context.js', () => ({
  config: { concurrency: 2, artifactsLocal: true, anthropicApiKey: 'test' },
  connection: { disconnect: () => {} },
  logger: {
    debug: () => {},
    info: (_o: unknown, msg?: string) => h.log.push(`info:${msg ?? ''}`),
    warn: (o: unknown, msg?: string) => {
      h.log.push(`warn:${msg ?? ''}`);
      // The FIELDS as well as the message. A refusal that is only counted in
      // an object nobody can read is not disclosed, so the object is kept.
      h.warned.push({ fields: (o ?? {}) as Record<string, unknown>, msg: msg ?? '' });
    },
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
vi.mock('@qaai/runner', async () => {
  const gates = await import('../../../../packages/runner/src/gates.js');
  /*
   * The PREFLIGHT is imported for real, for exactly the reason `gates.js` is:
   * a stubbed preflight would make the thing under test unobservable. Its only
   * two impure edges are injected — the base-URL request and the PATH/browser
   * probes — so what runs here is the real decision logic over inputs a test
   * controls, rather than a stand-in agreeing with whatever the processor does.
   */
  const preflight = await import('../../../../packages/runner/src/preflight.js');
  return {
    ...gates,
    ...preflight,
    environmentPreflight: (args: Parameters<typeof preflight.environmentPreflight>[0]) =>
      preflight.environmentPreflight({
        ...args,
        probe: async (url: string, timeoutMs: number) => {
          h.probeCalls += 1;
          return h.probe(url, timeoutMs);
        },
        // No real waiting between retry attempts; the policy is asserted by
        // counting attempts, not by timing them.
        sleep: async () => {},
      }),
    runnabilityFor: (
      types: readonly string[],
      opts: { hasPlugin?: (type: string) => boolean } = {},
    ) =>
      preflight.checkRunnability(types as never, {
        probes: h.probes,
        pluginless: (type) =>
          (opts.hasPlugin?.(type) ?? true) ? null : `${type} is not supported`,
      }),
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
    pluginFor: (type: string) =>
      h.pluginless.has(type)
        ? null
        : {
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
                // The matrix and the readings, as a plugin will report them.
                ...(h.measurements.get(test.id) ?? {}),
              };
            },
          },
  };
});

/*
 * run.ts reaches into schedule.ts for the monitor streak and for the fail-fast
 * rule; index.ts imports the tick from the same module, so one mock serves all
 * three.
 *
 * The REAL module cannot be imported here, even partially: it pulls in
 * apps/api's `start-run.js` and the closure loop, which between them want an
 * environment, a queue and a browser. So `failFastTripped` is a stand-in that
 * mirrors schedule.ts's rule, built on the runner's own
 * `quarantineSuppresses` so that at least the quarantine arm is the real one —
 * and what the tests below pin is the half that lives in run.ts: that the loop
 * consults the rule with the right DATA (the status, `retriedAndPassed`, and
 * the quarantine columns including the expiry), and obeys the answer. The rule
 * itself is schedule.ts's own suite to own.
 */
vi.mock('./schedule.js', async () => {
  const { quarantineSuppresses } = await import('../../../../packages/runner/src/gates.js');
  return {
    recordMonitorResult: async () => {},
    processScheduleTick: async () => {},
    failFastStopReason: (testName: string | null) =>
      testName
        ? `Fail-fast: "${testName}" failed, so the rest of this run was not executed.`
        : 'Fail-fast: a test failed, so the rest of this run was not executed.',
    failFastTripped: (
      result: {
        status: string;
        retriedAndPassed: boolean;
        test: { quarantined: boolean; quarantineExpiresAt: Date | null };
      },
      now: Date,
    ) => {
      if (result.status !== 'FAILED' && result.status !== 'TIMED_OUT') return false;
      if (result.retriedAndPassed) return false;
      return !quarantineSuppresses(result.test, now);
    },
  };
});

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

/** One row from `prisma/schema.prisma` that could be stored or read back. */
type MeasuredRow = Record<string, unknown>;

/** `select`, honoured — see the delegates that use it. */
function projectRow(row: MeasuredRow, select?: Record<string, boolean>): MeasuredRow {
  if (!select) return { ...row };
  const out: MeasuredRow = {};
  for (const [key, want] of Object.entries(select)) if (want) out[key] = row[key];
  return out;
}

interface ResultRow {
  id: string;
  /**
   * The parent's own run, modelled because the cell and reading rows COPY it.
   * `run.id` is the same value today, which is exactly why it is read off the
   * result instead: the two tables denormalise `runId` and never update it, so
   * the column has to come from the row the write is attached to rather than
   * from whatever the loop happens to have in hand.
   */
  runId: string;
  testId: string;
  shardIndex: number | null;
  status: string;
  retriedAndPassed: boolean;
  durationMs: number;
  errorMessage?: string | null;
  /**
   * The typed reason as a COLUMN rather than as a tag in the message.
   *
   * Modelled because it is the half a surface can GROUP BY, and because a fake
   * that dropped it would let the processor write the tag and nothing else —
   * which is the state the column was shipped in: correct, queryable, empty.
   */
  notRunKind?: string | null;
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
  /** §5 fail-fast: stop at the first real failure. */
  failFast: boolean;
  /**
   * Set the moment something decides this run should stop early — the inline
   * check in the loop, the sweep in schedule.ts, or a person pressing stop.
   * Deliberately NOT a cancel: a fail-fast stop is a FAILED run that chose not
   * to finish.
   */
  stopRequestedAt: Date | null;
  stopReason: string | null;
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
  /**
   * Triage verdicts that EXIST at finalisation, by test id.
   *
   * The fake returned `verdict: null` unconditionally, and that is a large part
   * of why ENV_ISSUE could lead nowhere unnoticed: the one input that
   * distinguishes "a credential expired" from "the code is broken" was
   * unreachable from every test in this file.
   */
  verdicts: Map<string, { verdict: string; overriddenTo: string | null; reviewState: string }>;
  /** Every `TestResultVariant` row that exists, as the writer leaves it. */
  variantRows: MeasuredRow[];
  /** Every `TestMetricSample` row that exists. */
  readingRows: MeasuredRow[];
  /**
   * The measurement writes in order.
   *
   * An in-memory fake has no rollback, so "these rows were REPLACED rather than
   * appended" is only observable as an order: both deletes before both inserts.
   * Dropping either `deleteMany` from the processor passes every count
   * assertion on a first delivery and only shows up on a retry.
   */
  measurementOps: string[];
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
    runId: RUN,
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
    failFast: false,
    stopRequestedAt: null,
    stopReason: null,
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
  /*
   * `stopRequestedAt: null` is the first-writer-wins claim the inline fail-fast
   * check shares with the sweep and with POST /team/runs/:runId/stop. A fake
   * that ignored it would let a second writer overwrite the reason on the row,
   * so the run's story would be whoever wrote LAST rather than whoever actually
   * stopped it.
   */
  if ('stopRequestedAt' in where && where.stopRequestedAt === null && row.stopRequestedAt !== null)
    return false;
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
    /** Triage verdicts already recorded when the run finalises. */
    verdicts?: Record<string, string>;
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
        runId: RUN,
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
    verdicts: new Map(
      Object.entries(opts.verdicts ?? {}).map(([testId, verdict]) => [
        testId,
        { verdict, overriddenTo: null, reviewState: 'PENDING' },
      ]),
    ),
    otherRuns: [
      runRow({ id: 'run2', status: 'RUNNING' }),
      runRow({ id: 'run3', status: 'QUEUED' }),
    ],
    variantRows: [],
    readingRows: [],
    measurementOps: [],
  };

  const runModel = {
    findFirst: async (args: {
      where: Record<string, unknown>;
      include?: { results?: { where?: { shardIndex?: number } } };
    }) => {
      if (!runMatches(db.run, args.where)) return null;
      /*
       * The SHARD FILTER, honoured. The processor passes
       * `results: { where: { shardIndex } }` so a shard executes only its own
       * slice, and a fake that returned every row would have each shard run the
       * whole suite — which would make the completion rule, the per-shard
       * counts and every assertion about a sibling's untouched rows
       * meaningless.
       */
      const shardIndex = args.include?.results?.where?.shardIndex;
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
        results:
          shardIndex === undefined
            ? db.results
            : db.results.filter((r) => r.shardIndex === shardIndex),
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
        verdict: db.verdicts.get(r.testId) ?? null,
      })),
    groupBy: async () => {
      const byStatus = new Map<string, number>();
      for (const r of db.results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      return [...byStatus].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
    update: async (args: {
      where: { id: string };
      data: { status?: string; errorMessage?: string | null; notRunKind?: string | null };
    }) => {
      const row = db.results.find((r) => r.id === args.where.id);
      if (row && args.data.status) row.status = args.data.status;
      // The MESSAGE is the product here: an unrunnable test is only honest if
      // it says why, so the fake has to keep it for the assertions to see.
      if (row && 'errorMessage' in args.data) row.errorMessage = args.data.errorMessage ?? null;
      /*
       * And the COLUMN, kept separately from the message rather than derived
       * from it. A fake that reparsed the tag out of `errorMessage` would
       * report a kind for a row the processor never wrote one to, which is the
       * "a null that became a value" mistake performed by the test harness.
       */
      if (row && 'notRunKind' in args.data) row.notRunKind = args.data.notRunKind ?? null;
      return {};
    },
    /*
     * The bulk stamp that records WHY untouched placeholders did not run.
     *
     * Its `where` is modelled faithfully and that is the whole value of it:
     * `errorMessage: null` is what keeps the stamp off rows the execution loop
     * already wrote, and a fake that ignored the filter would pass even if the
     * processor relabelled a plugin's own skip as "cancelled". (Confirmed by
     * mutation: dropping the filter from the processor is caught here.)
     */
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: { errorMessage?: string | null; notRunKind?: string | null };
    }) => {
      const matched = db.results.filter((r) => {
        if (args.where.status !== undefined && r.status !== args.where.status) return false;
        if ('errorMessage' in args.where && args.where.errorMessage === null) {
          if (r.errorMessage !== null && r.errorMessage !== undefined) return false;
        }
        if (args.where.shardIndex !== undefined && r.shardIndex !== args.where.shardIndex) {
          return false;
        }
        return true;
      });
      for (const row of matched) {
        row.errorMessage = args.data.errorMessage ?? null;
        if ('notRunKind' in args.data) row.notRunKind = args.data.notRunKind ?? null;
      }
      return { count: matched.length };
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
    /*
     * ── THE MATRIX AND THE READINGS ───────────────────────────────────────
     *
     * On `tx` and NOT at the top level, because that is where the writer
     * reaches them. A delegate added to `h.prisma` instead would leave the
     * transaction's `tx` argument without one, and the failure arrives as a
     * TypeError the run-level catch turns into "ERRORED" with the real cause
     * nowhere — which is how a whole slice of this file once went red at once.
     *
     * Rows are STORED rather than counted, because what the tests ask is which
     * columns were written: a fake returning `{ count: n }` cannot tell a cell
     * whose five dimensions were all written from one that left two to the
     * database.
     */
    testResultVariant: {
      deleteMany: async (args: { where: { testResultId: string } }) => {
        db.measurementOps.push('variant.deleteMany');
        const kept = db.variantRows.filter((row) => row.testResultId !== args.where.testResultId);
        const removed = db.variantRows.length - kept.length;
        db.variantRows.splice(0, db.variantRows.length, ...kept);
        return { count: removed };
      },
      /*
       * `select` HONOURED, and it is load-bearing: the writer maps each reading
       * onto its cell by the `id` this returns. A fake that answered with the
       * whole row regardless would make deleting `id: true` from the select
       * invisible — and the writer would then file every per-cell reading
       * against the whole test.
       */
      createManyAndReturn: async (args: {
        data: MeasuredRow[];
        select?: Record<string, boolean>;
      }) => {
        db.measurementOps.push('variant.createManyAndReturn');
        return args.data.map((row) => {
          const stored = { id: `variant_${db.variantRows.length + 1}`, ...row };
          db.variantRows.push(stored);
          return projectRow(stored, args.select);
        });
      },
    },
    testMetricSample: {
      deleteMany: async (args: { where: { testResultId: string } }) => {
        db.measurementOps.push('reading.deleteMany');
        const kept = db.readingRows.filter((row) => row.testResultId !== args.where.testResultId);
        const removed = db.readingRows.length - kept.length;
        db.readingRows.splice(0, db.readingRows.length, ...kept);
        return { count: removed };
      },
      createMany: async (args: { data: MeasuredRow[] }) => {
        db.measurementOps.push('reading.createMany');
        for (const row of args.data) {
          db.readingRows.push({ id: `reading_${db.readingRows.length + 1}`, ...row });
        }
        return { count: args.data.length };
      },
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
  h.probe = async () => ({ reached: true, status: 200, detail: 'answered HTTP 200' });
  h.probes = { onPath: () => true, browserInstalled: () => true, platform: 'linux' };
  h.probeCalls = 0;
  h.pluginless = new Set<string>();
  h.measurements = new Map();
  h.warned = [];
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

// ─────────────────────────────────────────────────────────────────────────────
// (9) An unusable environment is not a suite of test failures
//
// The defect, stated as the customer experienced it: the VPN tunnel to staging
// dropped, and QAAI reported eleven failing tests, a red board, a pass rate
// down eleven, a coverage number down eleven and a pull-request comment naming
// eleven "failures" — with the one fact that mattered, that NOTHING had been
// measured, appearing nowhere at all. A red build caused by a dead host was
// byte-identical to a red build caused by a bug.
//
// So these assertions are about three things that must never be confused:
//
//   · a run that COULD NOT be attempted is ERRORED with ENVIRONMENT_UNAVAILABLE
//     and a BLOCKing gate line — not PASSED over untouched placeholder rows,
//     and not FAILED as though the application had been judged;
//   · a result QAAI could not attempt carries a TYPED reason, so "nobody wrote
//     this yet", "this cannot run here" and "a person stopped the run" stop
//     being one SKIPPED; and
//   · the preflight is an instrument, so when the instrument breaks the suite
//     executes exactly as it did before the instrument existed.
// ─────────────────────────────────────────────────────────────────────────────

/** A base URL that is not listening at all. */
const deadHost = async () => ({
  reached: false,
  status: null,
  detail: 'the connection was refused',
});

describe('a run whose environment never answered', () => {
  it('executes nothing and reports ERRORED, not PASSED and not FAILED', async () => {
    const db = fakeDb();
    h.probe = deadHost;

    await processRun(job());

    expect(h.executed).toEqual([]);
    /*
     * The two wrong answers, ruled out by name. PASSED is what a bare `return`
     * from the preflight would have produced — three placeholder SKIPPED rows,
     * zero failures, a clean green board over a suite that never ran. FAILED is
     * what executing the suite anyway produced before the preflight existed.
     */
    expect(db.run.status).toBe('ERRORED');
    expect(db.run.failedCount).toBe(0);
    expect(db.run.skippedCount).toBe(3);
  });

  it('says ENVIRONMENT_UNAVAILABLE on the run, with the reason', async () => {
    const db = fakeDb();
    h.probe = deadHost;

    await processRun(job());

    expect(db.run.errorMessage).toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/connection was refused/);
    expect(db.run.errorMessage).toMatch(/not on your application/);
  });

  it('BLOCKS the gate, because nothing may merge on a run that did not happen', async () => {
    const db = fakeDb();
    h.probe = deadHost;

    await processRun(job());

    const gate = db.run.gateResult as {
      passed: boolean;
      evaluations: Array<{ action: string; detail: string }>;
    };
    expect(gate.passed).toBe(false);
    const blocking = gate.evaluations.filter((e) => e.action === 'BLOCK');
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.detail).toMatch(/nothing in this run could be attempted/i);
    expect(blocking[0]!.detail).toMatch(/nothing may merge/i);
  });

  it('tags every result BLOCKED_BY_ENV with the reason', async () => {
    const db = fakeDb();
    h.probe = deadHost;

    await processRun(job());

    for (const row of db.results) {
      expect(row.status).toBe('SKIPPED');
      expect(row.errorMessage).toMatch(/^\[BLOCKED_BY_ENV\]/);
      expect(row.errorMessage).toMatch(/verdict on the environment, not on your application/i);
    }
  });

  it('still notifies, so the team hears that the environment is down', async () => {
    // The whole value of an alert is that somebody receives it. A run that
    // reports an environment fault into a database nobody is watching is the
    // "correct code wired to nothing" shape this repo has a CI check for.
    fakeDb();
    h.probe = deadHost;

    await processRun(job());

    expect(h.notified.map((n) => n.event)).toContain('run.finished');
    const [finished] = published('run.finished');
    expect(finished!.data.environment).toMatchObject({ unattemptable: true, blockedByEnv: 3 });
  });

  it('publishes a live frame naming the failed check', async () => {
    fakeDb();
    h.probe = deadHost;

    await processRun(job());

    const [frame] = published('run.environment');
    expect(frame).toBeTruthy();
    expect(frame!.data.reason).toMatch(/connection was refused/);
    const checks = frame!.data.checks as Array<{ name: string; kind: string }>;
    expect(checks.map((c) => c.name)).toEqual(['BASE_URL']);
    expect(checks[0]!.kind).toBe('BLOCKED_BY_ENV');
  });

  it('retries the probe before condemning the run', async () => {
    // One unlucky packet must never cancel a suite: a false negative here costs
    // every test in the run, not one.
    fakeDb();
    h.probe = deadHost;

    await processRun(job());

    expect(h.probeCalls).toBe(3);
  });

  it('runs the whole suite when the first attempt was the unlucky one', async () => {
    const db = fakeDb();
    let attempts = 0;
    h.probe = async () => {
      attempts += 1;
      return attempts === 1
        ? { reached: false, status: null, detail: 'the connection was reset' }
        : { reached: true, status: 200, detail: 'answered HTTP 200' };
    };

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2', 't3']);
    expect(db.run.status).toBe('PASSED');
    // Second attempt succeeded, so the third was never made.
    expect(h.probeCalls).toBe(2);
  });

  it('does not treat a 500 from the application as an unusable environment', async () => {
    /*
     * The most important assertion in this file. A 5xx from the app under test
     * is very possibly THE BUG, and a preflight that refused to run on one
     * would suppress exactly the run that was about to catch an outage.
     */
    const db = fakeDb();
    h.probe = async () => ({
      reached: true,
      status: 500,
      detail: 'answered HTTP 500',
    });

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2', 't3']);
    expect(db.run.status).toBe('PASSED');
    expect(published('run.environment')).toEqual([]);
  });

  it('does not probe a login against a host that is not listening', async () => {
    // A failed login against a dead host measures the host a second time and
    // reports it as a credential problem, sending the reader to rotate a
    // password that was never broken.
    fakeDb({
      results: [resultFor('t1', { authProfileId: 'p_admin' })],
      profiles: [profileRow({ id: 'p_admin' })],
    });
    h.probe = deadHost;

    await processRun(job());

    expect(h.logins).toEqual([]);
  });
});

describe('a run whose only identity no longer signs in', () => {
  it('reports ENVIRONMENT_UNAVAILABLE instead of a wall of failing tests', async () => {
    /*
     * The register defect in one test: "a broken login turns into N test
     * failures that poison the pass rate AND the coverage number". Two tests
     * on one rotated password used to be two FAILED rows.
     */
    const db = fakeDb({
      results: [
        resultFor('t1', { authProfileId: 'p_admin' }),
        resultFor('t2', { authProfileId: 'p_admin' }),
      ],
      profiles: [profileRow({ id: 'p_admin' })],
    });
    h.loginRefusals.set('p_admin', 'the password was rejected');

    await processRun(job());

    expect(h.executed).toEqual([]);
    expect(db.run.status).toBe('ERRORED');
    expect(db.run.failedCount).toBe(0);
    expect(db.run.errorMessage).toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/no longer works/);
    // One login for one profile, probe included — not one per test.
    expect(h.logins).toEqual(['p_admin']);
  });

  it('still FAILS a test whose binding is broken rather than its environment', async () => {
    /*
     * The other half, and the line this change refuses to cross. A profile
     * somebody DELETED is a defect in the suite — a test claiming a role it
     * cannot have — and a skip does not block a gate, so filing it as "the
     * environment" would let a suite whose permission tests stopped running
     * keep merging green. Only a credential the application actually REFUSED
     * counts as the environment.
     */
    const db = fakeDb({
      results: [resultFor('t1', { authProfileId: 'p_gone' })],
      profiles: [],
    });

    await processRun(job());

    expect(db.results[0]!.status).toBe('FAILED');
    expect(db.run.status).toBe('FAILED');
    expect(db.run.errorMessage).toBeNull();
  });
});

describe('a test type this deployment cannot execute', () => {
  it('is UNSUPPORTED before the run, not a plugin discovering ENOENT after it', async () => {
    /*
     * A LOAD test on an image with no k6. `plugins/load.ts` already handled
     * this honestly — it spawns k6, reads ENOENT and reports SKIPPED with an
     * install line — but only after the run had been queued, scheduled and
     * started. The preflight answers it for free, before anything executes,
     * and the reason is now typed rather than a sentence.
     */
    const db = fakeDb({
      results: [resultFor('t1', { type: 'LOAD' }), resultFor('t2', { type: 'E2E' })],
    });
    h.probes = {
      onPath: (binary) => binary !== 'k6',
      browserInstalled: () => true,
      platform: 'linux',
    };

    await processRun(job());

    expect(h.executed).toEqual(['t2']);
    expect(db.results[0]!.status).toBe('SKIPPED');
    expect(db.results[0]!.errorMessage).toMatch(/^\[UNSUPPORTED\]/);
    expect(db.results[0]!.errorMessage).toMatch(/cannot execute LOAD tests/);
    // The install line, because a refusal with no remedy is a wall.
    expect(db.results[0]!.errorMessage).toMatch(/brew install k6/);
  });

  it('distinguishes "this cannot run here" from "the environment is broken"', async () => {
    // One SKIPPED used to carry both. The tags are the fix, and they point at
    // different people: one installs a tool on the worker, the other fixes the
    // thing under test.
    const db = fakeDb({
      results: [resultFor('t1', { type: 'LOAD' }), resultFor('t2', { type: 'UNIT_GEN' })],
    });
    h.probes = {
      onPath: (binary) => binary !== 'k6',
      browserInstalled: () => true,
      platform: 'linux',
    };

    await processRun(job());

    expect(db.results[0]!.errorMessage).toMatch(/^\[UNSUPPORTED\]/);
    // UNIT_GEN needs a checkout, and this project has no repository.
    expect(db.results[1]!.errorMessage).toMatch(/^\[BLOCKED_BY_ENV\]/);
  });

  it('WARNS on the gate rather than blocking, when the rest of the suite ran', async () => {
    /*
     * The policy, asserted so it is a decision rather than an accident: 400
     * passing tests are still 400 passing tests, and holding every release
     * because one type has no tool is how a brake gets switched off by the
     * people it protects. The cost is real and is named in run.ts: such a run
     * CAN still report PASSED with tests nobody executed.
     */
    const db = fakeDb({
      results: [resultFor('t1', { type: 'LOAD' }), resultFor('t2', { type: 'E2E' })],
    });
    h.probes = {
      onPath: (binary) => binary !== 'k6',
      browserInstalled: () => true,
      platform: 'linux',
    };

    await processRun(job());

    const gate = db.run.gateResult as {
      passed: boolean;
      evaluations: Array<{ action: string; detail: string }>;
    };
    expect(gate.passed).toBe(true);
    const warned = gate.evaluations.filter(
      (e) => e.action === 'WARN' && /deployment cannot execute/i.test(e.detail),
    );
    expect(warned).toHaveLength(1);
    expect(db.run.status).toBe('PASSED');
  });

  it('never refuses a type whose tool the spec chooses', async () => {
    /*
     * Lighthouse is optional — plugins/performance.ts falls back to its own
     * collector "which costs the audit detail and nothing else" — and which
     * engines a CROSS_BROWSER test wants is in its own spec. Refusing either
     * would refuse a test that works, which is the preflight causing the very
     * outcome it exists to prevent.
     */
    const db = fakeDb({
      results: [
        resultFor('t1', { type: 'PERFORMANCE' }),
        resultFor('t2', { type: 'CROSS_BROWSER' }),
      ],
    });
    h.probes = {
      onPath: (binary) => binary !== 'lighthouse',
      browserInstalled: (engine) => engine === 'chromium',
      platform: 'linux',
    };

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2']);
    expect(db.run.status).toBe('PASSED');
  });
});

describe('ENV_ISSUE, the triage verdict that used to lead nowhere', () => {
  it('reports ERRORED rather than FAILED when every failure was the environment', async () => {
    /*
     * THE DEFECT. `BLOCKING_VERDICTS` is REAL_BUG alone, so an ENV_ISSUE never
     * blocked the gate — and it did not have to, because the FAILED result had
     * already put the run at FAILED through `counts.failed`. A board red from
     * an expired credential was indistinguishable from a board red from a bug.
     */
    const db = fakeDb({
      results: [resultFor('t1'), resultFor('t2')],
      verdicts: { t2: 'ENV_ISSUE' },
    });
    h.statusFor = new Map([['t2', 'FAILED']]);

    await processRun(job());

    expect(db.run.status).toBe('ERRORED');
    expect(db.run.errorMessage).toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/triaged as environment issues/);
  });

  it('does not rewrite the counters, so the five columns still sum to the results', async () => {
    /*
     * Deliberately NOT suppressed in the counts. `failedCount` still says one
     * test failed, because one did; moving it to a sixth bucket needs a column
     * this change does not own, and moving it into `skipped` is the same
     * mistake in a kinder word that gates.ts already refuses for quarantine.
     */
    const db = fakeDb({
      results: [resultFor('t1'), resultFor('t2')],
      verdicts: { t2: 'ENV_ISSUE' },
    });
    h.statusFor = new Map([['t2', 'FAILED']]);

    await processRun(job());

    expect(db.run.failedCount).toBe(1);
    expect(db.run.skippedCount).toBe(0);
    const total =
      db.run.passedCount +
      db.run.failedCount +
      db.run.flakyCount +
      db.run.skippedCount +
      db.run.quarantinedFailedCount;
    expect(total).toBe(db.results.length);
  });

  it('suppresses the gate rather than failing it, and alerts', async () => {
    // `BLOCKING_VERDICTS` says ENV_ISSUE "alerts but never gates". The WARN is
    // the alert — it reaches the chat message, the check summary, the CLI's
    // output and the run page through plumbing that already exists.
    const db = fakeDb({
      results: [resultFor('t1'), resultFor('t2')],
      verdicts: { t2: 'ENV_ISSUE' },
    });
    h.statusFor = new Map([['t2', 'FAILED']]);

    await processRun(job());

    const gate = db.run.gateResult as {
      passed: boolean;
      evaluations: Array<{ action: string; detail: string }>;
    };
    expect(gate.evaluations.some((e) => e.action === 'BLOCK')).toBe(false);
    expect(
      gate.evaluations.filter(
        (e) => e.action === 'WARN' && /triaged as environment issues/.test(e.detail),
      ),
    ).toHaveLength(1);
    expect(h.notified.map((n) => n.event)).toContain('run.finished');
    const [finished] = published('run.finished');
    expect(finished!.data.environment).toMatchObject({ envIssueFailures: 1 });
  });

  it('still reports FAILED when a real bug failed alongside the environment one', async () => {
    // The run must not be excused by one environment failure. Only when EVERY
    // gating failure was the environment's does the verdict change.
    const db = fakeDb({
      results: [resultFor('t1'), resultFor('t2'), resultFor('t3')],
      verdicts: { t2: 'ENV_ISSUE' },
    });
    h.statusFor = new Map([
      ['t2', 'FAILED'],
      ['t3', 'FAILED'],
    ]);

    await processRun(job());

    expect(db.run.status).toBe('FAILED');
    expect(db.run.errorMessage).toBeNull();
  });

  it('honours a human override of the verdict, exactly as the gate does', async () => {
    const db = fakeDb({ results: [resultFor('t1')], verdicts: {} });
    db.verdicts.set('t1', {
      verdict: 'REAL_BUG',
      overriddenTo: 'ENV_ISSUE',
      reviewState: 'OVERRIDDEN',
    });
    h.statusFor = new Map([['t1', 'FAILED']]);

    await processRun(job());

    expect(db.run.status).toBe('ERRORED');
  });
});

describe('the typed reason a result did not run', () => {
  it('stamps CANCELLED on the tests a cancel never reached', async () => {
    /*
     * A placeholder SKIPPED and a deliberate skip were one value. "A person
     * stopped this" and "a worker died holding it" lead to different actions —
     * one is nothing to do, the other is a re-run — and the suite could not
     * tell them apart.
     */
    const db = fakeDb();
    h.afterExecute = (testId) => {
      if (testId === 't1') db.run.status = 'CANCELLED';
    };

    await processRun(job());

    expect(h.executed).toEqual(['t1']);
    expect(db.results[1]!.errorMessage).toMatch(/^\[CANCELLED\]/);
    expect(db.results[2]!.errorMessage).toMatch(/^\[CANCELLED\]/);
    expect(db.run.status).toBe('CANCELLED');
  });

  it('never relabels a result the execution loop already explained', async () => {
    /*
     * `errorMessage: null` is the whole safety of the bulk stamp: a row with a
     * message was written by the loop, which knew more than a sweep does. A
     * cancel must not rewrite "no repository checkout" as "cancelled".
     */
    const db = fakeDb({
      results: [
        resultFor('t1', { type: 'UNIT_GEN' }),
        resultFor('t2', { type: 'E2E' }),
        resultFor('t3', { type: 'E2E' }),
      ],
    });
    h.afterExecute = (testId) => {
      if (testId === 't2') db.run.status = 'CANCELLED';
    };

    await processRun(job());

    expect(db.results[0]!.errorMessage).toMatch(/^\[BLOCKED_BY_ENV\]/);
    expect(db.results[0]!.errorMessage).toMatch(/was not evaluated/);
    expect(db.results[2]!.errorMessage).toMatch(/^\[CANCELLED\]/);
  });

  it('tags an unsupported TYPE separately from an unusable environment', async () => {
    const db = fakeDb({ results: [resultFor('t1', { type: 'E2E' })] });
    // The registry has a plugin for every type, so the only way to be
    // pluginless here is the mock's own lookup saying so.
    h.probes = { onPath: () => true, browserInstalled: () => false, platform: 'linux' };

    await processRun(job());

    expect(db.results[0]!.errorMessage).toMatch(/^\[UNSUPPORTED\]/);
    expect(db.results[0]!.errorMessage).toMatch(/npx playwright install/);
    expect(db.run.status).toBe('ERRORED');
  });
});

describe('the preflight as an instrument', () => {
  it('executes the suite exactly as before when the preflight itself breaks', async () => {
    /*
     * The rule the whole feature rests on, and the same one `loadProjectPlugins`
     * is written under: a broken instrument must not cost a customer their CI
     * run. A `TypeError` in a PATH probe falls back to the behaviour that
     * existed before any of this, where a missing tool surfaces as the plugin's
     * own ENOENT skip.
     */
    const db = fakeDb();
    const explode = (): never => {
      throw new Error('the probe exploded');
    };
    h.probes = { onPath: explode, browserInstalled: explode };

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2', 't3']);
    expect(db.run.status).toBe('PASSED');
    expect(h.log).toContain(
      'error:the environment preflight itself failed; executing the suite as if it had not run',
    );
  });

  it('adds no logins to a run that was already authenticating', async () => {
    /*
     * The probe IS the login the run was going to perform — it goes through the
     * run's own session cache. A preflight that signed in separately would
     * charge every authenticated run a second browser launch per profile, which
     * is a tax on every customer to catch an occasional rotated password.
     */
    fakeDb({
      results: [
        resultFor('t1', { authProfileId: 'p_admin' }),
        resultFor('t2', { authProfileId: 'p_admin' }),
        resultFor('t3', { authProfileId: 'p_member' }),
      ],
      profiles: [profileRow({ id: 'p_admin' }), profileRow({ id: 'p_member' })],
    });

    await processRun(job());

    expect(h.logins).toEqual(['p_admin', 'p_member']);
    expect(h.executed).toEqual(['t1', 't2', 't3']);
  });

  it('probes nothing for a suite that never touches the environment over HTTP', async () => {
    // A CLI-only suite has nothing to be right or wrong about, and a probe it
    // did not need is a request somebody else's server has to answer.
    fakeDb({ results: [resultFor('t1', { type: 'CLI' })] });

    await processRun(job());

    expect(h.probeCalls).toBe(0);
    expect(h.executed).toEqual(['t1']);
  });
});

describe('a sharded run whose slices could not be attempted', () => {
  /**
   * A minimal `RunShard` table, installed over the one `fakeDb` provides.
   *
   * Enough of it to be honest about the three queries the completion rule makes
   * — the claim, the reap, and "are my siblings done?" — because the question
   * this suite asks is whether a SHARDED run reports an unusable environment
   * the same way an unsharded one does, and that answer is produced entirely by
   * those three.
   */
  /**
   * One result per shard, each routed to its own slice.
   *
   * `shardIndex` is what makes a sharded run sharded — the processor filters on
   * it so a shard executes only its own tests — and a slice with no rows in it
   * is NOT unattemptable, it is empty. Leaving these null made every shard read
   * as a shard with nothing to do, which is a different (and correct) answer to
   * a different question.
   */
  const slicedResults = (count = 2) =>
    Array.from({ length: count }, (_, index) => ({
      ...resultFor(`t${index + 1}`),
      shardIndex: index,
    }));

  function withShards(count: number) {
    const rows = Array.from({ length: count }, (_, index) => ({
      index,
      status: 'QUEUED',
      errorMessage: null as string | null,
    }));
    const matches = (row: (typeof rows)[number], where: Record<string, unknown>): boolean => {
      if (where.index !== undefined && row.index !== where.index) return false;
      if (typeof where.status === 'string' && row.status !== where.status) return false;
      if (Array.isArray(where.OR)) {
        return (where.OR as Array<Record<string, unknown>>).some(
          (arm) => typeof arm.status !== 'string' || arm.status === row.status,
        );
      }
      return true;
    };
    h.prisma.runShard = {
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hit = rows.filter((row) => matches(row, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
      findUnique: async (args: { where: { runId_index: { index: number } } }) =>
        rows.find((row) => row.index === args.where.runId_index.index) ?? null,
      findMany: async () => rows.map((row) => ({ ...row })),
    };
    return rows;
  }

  it('marks its shard FAILED, so siblings cannot finalise the run as a clean pass', async () => {
    /*
     * The worst outcome available here. A shard that executed nothing and
     * reported COMPLETED would let the last sibling finalise the run over
     * placeholder rows — a green board across a suite that never ran, which is
     * the single failure the whole sharding feature was written to prevent.
     */
    fakeDb({ run: { shardCount: 2, totalCount: 2 }, results: slicedResults() });
    const shards = withShards(2);
    h.probe = deadHost;

    await processRun(job({ shard: { index: 0, count: 2 } }));

    expect(h.executed).toEqual([]);
    expect(shards[0]!.status).toBe('FAILED');
    expect(shards[0]!.errorMessage).toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    // Sibling still QUEUED, so nothing has finalised yet.
    expect(shards[1]!.status).toBe('QUEUED');
  });

  it('reports ENVIRONMENT_UNAVAILABLE in the run message, not buried inside it', async () => {
    /*
     * Composing the shards' messages used to bury the marker mid-string — "2 of
     * 2 shards did not complete (shard 0: ENVIRONMENT_UNAVAILABLE: …)" — and a
     * prefix in the middle of a sentence is not a prefix. The identical
     * unsharded run said so in its first word; this one could not be
     * distinguished from a run whose workers crashed.
     */
    const db = fakeDb({ run: { shardCount: 1, totalCount: 1 }, results: slicedResults(1) });
    withShards(1);
    h.probe = deadHost;

    await processRun(job({ shard: { index: 0, count: 1 } }));

    expect(db.run.status).toBe('ERRORED');
    expect(db.run.errorMessage).toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/could not be attempted/);
    expect(db.run.errorMessage).toMatch(/connection was refused/);
  });

  it('derives the BLOCKing gate line from the rows, since no shard holds the whole run', async () => {
    // A shard knows its own slice was unattemptable and nothing about its
    // siblings'. The run-level answer therefore comes from the result rows,
    // which are the only place that holds the whole run.
    const db = fakeDb({ run: { shardCount: 1, totalCount: 1 }, results: slicedResults(1) });
    withShards(1);
    h.probe = deadHost;

    await processRun(job({ shard: { index: 0, count: 1 } }));

    const gate = db.run.gateResult as {
      passed: boolean;
      evaluations: Array<{ action: string; detail: string }>;
    };
    expect(gate.passed).toBe(false);
    expect(gate.evaluations.some((e) => e.action === 'BLOCK')).toBe(true);
  });

  it('keeps the plain wording when a shard died for a reason that was not the environment', async () => {
    // One shard whose worker blew up alongside one whose environment was down
    // is a run that failed for two reasons, and naming only the kinder one
    // would be the reassuring half of a true answer.
    const db = fakeDb({ run: { shardCount: 2, totalCount: 2 }, results: slicedResults() });
    const shards = withShards(2);
    shards[1]!.status = 'FAILED';
    shards[1]!.errorMessage = 'the worker ran out of memory';
    h.probe = deadHost;

    await processRun(job({ shard: { index: 0, count: 2 } }));

    expect(db.run.status).toBe('ERRORED');
    expect(db.run.errorMessage).not.toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/2 of 2 shards did not complete/);
    expect(db.run.errorMessage).toMatch(/ran out of memory/);
  });

  it('does not claim the whole run was unattemptable when a sibling finished', async () => {
    /*
     * THE SELF-CONTRADICTING RUN. This is the probe, verbatim: two shards, the
     * first one env-dead, the second COMPLETED with a pass. The run used to
     * report `ENVIRONMENT_UNAVAILABLE: 1 of 2 shards could not be attempted`
     * while its own gate line said only PART of the suite was blocked and
     * `gateResult.passed` was true — because the hoist asked "was every BROKEN
     * shard environmental?", which is not the question the marker answers.
     *
     * @qaai/shared documents the prefix as meaning "a run the environment made
     * impossible". One of these two tests was executed and passed, so this run
     * is not that, and a program reading the one machine-readable field would
     * have been told it was.
     */
    const db = fakeDb({
      run: { shardCount: 2, totalCount: 2 },
      results: [
        { ...resultFor('t1'), shardIndex: 0 },
        // The sibling's slice, already executed and green.
        { ...resultFor('t2'), shardIndex: 1, status: 'PASSED', errorMessage: null },
      ],
    });
    const shards = withShards(2);
    shards[1]!.status = 'COMPLETED';
    h.probe = deadHost;

    await processRun(job({ shard: { index: 0, count: 2 } }));

    // Still ERRORED, and still says a shard could not be attempted — what it
    // no longer says is that the RUN could not be.
    expect(db.run.status).toBe('ERRORED');
    expect(db.run.errorMessage).not.toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/1 of 2 shards could not be attempted/);
    expect(db.run.errorMessage).toMatch(/connection was refused/);

    // And the gate agrees with the message now, rather than contradicting it.
    const gate = db.run.gateResult as {
      passed: boolean;
      evaluations: Array<{ action: string; detail: string }>;
    };
    expect(gate.passed).toBe(true);
    expect(
      gate.evaluations.some((e) => e.action === 'WARN' && /^Environment —/.test(e.detail)),
    ).toBe(true);
    expect(gate.evaluations.some((e) => e.action === 'BLOCK')).toBe(false);
    expect(db.run.passedCount).toBe(1);
    expect(db.run.skippedCount).toBe(1);
  });

  it('reports a MISSING TOOL as this deployment’s gap, not the environment’s', async () => {
    /*
     * The same hoist, with the other marker. A shard of LOAD tests on an image
     * with no k6 is a hole in OUR image: "install k6" and "check your VPN" are
     * advice for different people, and the run-level field used to give the
     * second answer to the first problem.
     */
    const db = fakeDb({
      run: { shardCount: 1, totalCount: 1 },
      results: [{ ...resultFor('t1', { type: 'LOAD' }), shardIndex: 0 }],
    });
    const shards = withShards(1);
    h.probes = {
      onPath: (binary) => binary !== 'k6',
      browserInstalled: () => true,
      platform: 'linux',
    };

    await processRun(job({ shard: { index: 0, count: 1 } }));

    expect(shards[0]!.errorMessage).toMatch(/^TOOLING_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/^TOOLING_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/brew install k6/);
    expect(db.run.status).toBe('ERRORED');
  });

  it('keeps the plain wording when the shards failed for two different gaps', async () => {
    /*
     * One shard with no k6 beside one whose host never answered is a run that
     * failed for two reasons, and hoisting either marker would name one of them
     * as the whole cause. Same rule as the dead-worker case above, one level
     * finer: "every one of them, and the same one".
     */
    const db = fakeDb({ run: { shardCount: 2, totalCount: 2 }, results: slicedResults() });
    const shards = withShards(2);
    shards[1]!.status = 'FAILED';
    shards[1]!.errorMessage = 'ENVIRONMENT_UNAVAILABLE: the connection was refused.';
    h.probes = {
      onPath: (binary) => binary !== 'k6',
      browserInstalled: () => true,
      platform: 'linux',
    };
    db.results[0]!.test.type = 'LOAD';

    await processRun(job({ shard: { index: 0, count: 2 } }));

    expect(db.run.errorMessage).not.toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    expect(db.run.errorMessage).not.toMatch(/^TOOLING_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/2 of 2 shards did not complete/);
    // Both causes survive into the composed sentence.
    expect(db.run.errorMessage).toMatch(/TOOLING_UNAVAILABLE/);
    expect(db.run.errorMessage).toMatch(/connection was refused/);
  });
});

describe('the tests a dead shard never reached', () => {
  it('records NOT_RUN rather than leaving them indistinguishable from a skip', async () => {
    /*
     * A shard whose worker died leaves its slice sitting at the placeholder
     * SKIPPED that run creation wrote, and that placeholder was
     * indistinguishable from a test somebody deliberately skipped. "Nobody
     * reached this" and "this was skipped on purpose" lead to different actions
     * — one is a re-run, the other is nothing — and the suite could not tell
     * them apart.
     *
     * NOT_RUN is deliberately the weakest of the four kinds: this process knows
     * only that the shard ended and that nothing wrote to these rows.
     */
    const db = fakeDb({
      run: { shardCount: 2, totalCount: 2 },
      results: [
        { ...resultFor('t1'), shardIndex: 0 },
        { ...resultFor('t2'), shardIndex: 1 },
      ],
    });
    const rows = Array.from({ length: 2 }, (_, index) => ({
      index,
      status: index === 1 ? 'ABANDONED' : 'QUEUED',
      errorMessage: index === 1 ? 'No heartbeat for 300s — the worker is gone.' : null,
    }));
    h.prisma.runShard = {
      updateMany: async (args: { where: { index?: number }; data: Record<string, unknown> }) => {
        const hit = rows.filter(
          (r) => args.where.index === undefined || r.index === args.where.index,
        );
        // Only the claim/finish path writes here in this test; the reaper's
        // RUNNING filter matches nothing because neither shard is RUNNING.
        if (args.where.index !== undefined) for (const r of hit) Object.assign(r, args.data);
        return { count: args.where.index === undefined ? 0 : hit.length };
      },
      findUnique: async (args: { where: { runId_index: { index: number } } }) =>
        rows.find((r) => r.index === args.where.runId_index.index) ?? null,
      findMany: async () => rows.map((r) => ({ ...r })),
    };

    await processRun(job({ shard: { index: 0, count: 2 } }));

    // Shard 0's own test ran and is untouched by the stamp.
    expect(h.executed).toEqual(['t1']);
    expect(db.results[0]!.status).toBe('PASSED');
    // Shard 1's never did, and now says so.
    expect(db.results[1]!.status).toBe('SKIPPED');
    expect(db.results[1]!.errorMessage).toMatch(/^\[NOT_RUN\]/);
    expect(db.results[1]!.errorMessage).toMatch(/Shard 1 did not complete/);
    expect(db.results[1]!.errorMessage).toMatch(/No heartbeat/);
    // And the run cannot report a pass over a slice that never executed.
    expect(db.run.status).toBe('ERRORED');
  });

  it('never stamps a sibling slice another worker is still executing', async () => {
    /*
     * The scoping, and it is not hypothetical: five shards poll the same run
     * row, so a cancel is seen by whichever shard looks next. An unscoped stamp
     * from shard 0 would write "cancelled" onto shard 1's untouched rows while
     * shard 1 is still running those very tests — and shard 1 would then
     * persist real results over a message claiming nobody ran them, or lose the
     * race and leave a lie on the row.
     */
    const db = fakeDb({
      run: { shardCount: 2, totalCount: 3 },
      results: [
        { ...resultFor('t1'), shardIndex: 0 },
        { ...resultFor('t2'), shardIndex: 0 },
        { ...resultFor('t3'), shardIndex: 1 },
      ],
    });
    const rows = [
      { index: 0, status: 'QUEUED', errorMessage: null as string | null },
      // Alive and still working: its slice is nobody else's to label.
      { index: 1, status: 'RUNNING', errorMessage: null as string | null },
    ];
    h.prisma.runShard = {
      updateMany: async (args: { where: { index?: number }; data: Record<string, unknown> }) => {
        if (args.where.index === undefined) return { count: 0 };
        const hit = rows.filter((r) => r.index === args.where.index);
        for (const r of hit) Object.assign(r, args.data);
        return { count: hit.length };
      },
      findUnique: async (args: { where: { runId_index: { index: number } } }) =>
        rows.find((r) => r.index === args.where.runId_index.index) ?? null,
      findMany: async () => rows.map((r) => ({ ...r })),
    };
    h.afterExecute = (testId) => {
      if (testId === 't1') db.run.status = 'CANCELLED';
    };

    await processRun(job({ shard: { index: 0, count: 2 } }));

    expect(h.executed).toEqual(['t1']);
    // This shard's own unreached test is labelled.
    expect(db.results[1]!.errorMessage).toMatch(/^\[CANCELLED\]/);
    // The live sibling's is untouched — still the placeholder it was created as.
    expect(db.results[2]!.errorMessage ?? null).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (10) Fail-fast, and the stop request nothing used to read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE DEFECT, VERBATIM: "Enforce fail-fast and the stop request in the worker —
 * the column, the migration, the endpoint and the user-facing promise all
 * exist; the consumer does not, so a stop request is ignored."
 *
 * Four surfaces promised this behaviour. `createRunSchema` accepts `failFast`,
 * POST /runs reports it back, `Run.failFast`/`stopRequestedAt`/`stopReason` are
 * columns with a migration behind them, the sweep in schedule.ts writes the
 * request once a minute, and POST /team/runs/:runId/stop told the caller the
 * worker "checks between tests". The poll read `status` and `finalizedAt` and
 * nothing else, so a fail-fast run executed all 5,000 tests after the first
 * failure and a person pressing stop was ignored until the run ended on its own.
 *
 * The assertions are mostly about what must NOT happen: no test executed after
 * the stop, and — the one that matters most — the run must not be relabelled
 * CANCELLED. Cancelled means nobody wanted the answer; a fail-fast stop means
 * the answer arrived early and was bad, and filing the second as the first puts
 * a broken build in the same bucket as an abandoned one.
 */
describe('a fail-fast run that hits a real failure', () => {
  const failing = (over: Partial<RunRow> = {}) => {
    const db = fakeDb({ run: { failFast: true, totalCount: 3, ...over } });
    h.statusFor.set('t1', 'FAILED');
    return db;
  };

  it('stops after the failure instead of executing the rest of the suite', async () => {
    const db = failing();

    await processRun(job());

    // t1 ran and failed; t2 and t3 were never started.
    expect(h.executed).toEqual(['t1']);
    expect(db.run.stopRequestedAt).toBeInstanceOf(Date);
    expect(db.run.stopReason).toBe(
      'Fail-fast: "test t1" failed, so the rest of this run was not executed.',
    );
  });

  it('finalises FAILED on its real counts, and is never relabelled CANCELLED', async () => {
    const db = failing();

    await processRun(job());

    /*
     * The whole point of keeping `cancelled` false. CANCELLED would answer
     * `passed: false` too, so the mistake would be invisible in the one place
     * people look — and it would say a person abandoned a run that in fact
     * failed, which is the opposite of what happened.
     */
    expect(db.run.status).toBe('FAILED');
    expect(db.run.failedCount).toBe(1);
    /*
     * And the five columns still sum to the number of results. The in-memory
     * counters describe only the test this process reached, so the summary is
     * re-counted off the rows exactly as a cancel re-counts it; keeping them
     * would have written `skippedCount: 0` over two SKIPPED results.
     */
    expect(db.run.skippedCount).toBe(2);
    expect(
      db.run.passedCount +
        db.run.failedCount +
        db.run.flakyCount +
        db.run.skippedCount +
        db.run.quarantinedFailedCount,
    ).toBe(db.results.length);
  });

  it('records the tests it never reached as NOT_RUN, in the column as well as the tag', async () => {
    const db = failing();

    await processRun(job());

    for (const row of db.results.slice(1)) {
      expect(row.status).toBe('SKIPPED');
      // NOT_RUN and deliberately not CANCELLED: nobody reached these, and
      // nobody decided anything about them either.
      expect(row.errorMessage).toMatch(/^\[NOT_RUN\]/);
      expect(row.errorMessage).toMatch(/Fail-fast/);
      // The queryable half. A prefix on a text column cannot be GROUP BY'd.
      expect(row.notRunKind).toBe('NOT_RUN');
    }
    // The failure itself keeps its own message and carries NO kind: it ran.
    expect(db.results[0]!.notRunKind ?? null).toBeNull();
  });

  it('says on the live frame that the run was halted, and how many were missed', async () => {
    failing();

    await processRun(job());

    const finished = published('run.finished')[0]!.data as {
      stopped: { reason: string; notReached: number } | null;
      environment: { notReached: number; notRecorded: number };
    };
    /*
     * Published rather than left to be inferred. A stopped run finalises on its
     * real counts, which is right here because the counts are red — but a run
     * halted while everything was green would report PASSED over tests nobody
     * executed, so the FACT of the stop has to reach a surface either way.
     */
    expect(finished.stopped).not.toBeNull();
    expect(finished.stopped!.notReached).toBe(2);
    expect(finished.stopped!.reason).toMatch(/Fail-fast/);
    // Counted as NOT REACHED, not as unexplained: these rows carry a reason.
    expect(finished.environment.notReached).toBe(2);
    expect(finished.environment.notRecorded).toBe(0);
  });

  it('does not stop on a failure a quarantine in force has suppressed', async () => {
    /*
     * A quarantined failure is a failure somebody explicitly switched off. It
     * does not reach `failedCount` and it does not gate, so stopping a
     * 5,000-test run on one would make quarantine suppress a failure
     * everywhere except the one place where it ends the build early.
     */
    const db = fakeDb({
      run: { failFast: true, totalCount: 2 },
      results: [
        resultFor('t1', {
          quarantined: true,
          quarantineExpiresAt: new Date(Date.now() + 86_400_000),
        }),
        resultFor('t2'),
      ],
    });
    h.statusFor.set('t1', 'FAILED');

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2']);
    expect(db.run.stopRequestedAt).toBeNull();
  });

  it('does stop on a failure whose quarantine has EXPIRED', async () => {
    // The expiry arm, which is why the loop hands over the columns rather than
    // the raw flag: a quarantine that ran out last week suppresses nothing.
    const db = fakeDb({
      run: { failFast: true, totalCount: 2 },
      results: [
        resultFor('t1', {
          quarantined: true,
          quarantineExpiresAt: new Date(Date.now() - 86_400_000),
        }),
        resultFor('t2'),
      ],
    });
    h.statusFor.set('t1', 'FAILED');

    await processRun(job());

    expect(h.executed).toEqual(['t1']);
    expect(db.run.stopRequestedAt).toBeInstanceOf(Date);
  });

  it('leaves the reason written by whoever asked first', async () => {
    /*
     * Idempotent by construction: the request is only ever written once, by the
     * first writer. This sweep, a person in the cockpit and this loop can all
     * race on the same run, and the row has to end up with one story.
     */
    const db = fakeDb({
      run: {
        failFast: true,
        totalCount: 3,
        stopRequestedAt: new Date(Date.now() - 1000),
        stopReason: 'Stopped by a reviewer from the cockpit.',
      },
    });
    h.statusFor.set('t1', 'FAILED');

    await processRun(job());

    expect(db.run.stopReason).toBe('Stopped by a reviewer from the cockpit.');
    // And the pre-existing request stopped the run before anything executed.
    expect(h.executed).toEqual([]);
  });

  it('runs the whole suite when fail-fast was not asked for', async () => {
    // The normal case, so the brake cannot be applied to runs that never asked.
    const db = fakeDb({ run: { totalCount: 3 } });
    h.statusFor.set('t1', 'FAILED');

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2', 't3']);
    expect(db.run.stopRequestedAt).toBeNull();
    expect(db.run.status).toBe('FAILED');
  });
});

describe('a run a person asked to stop', () => {
  it('stops between tests, and is not reported as a cancel', async () => {
    /*
     * POST /team/runs/:runId/stop writes `stopRequestedAt` and deliberately not
     * `status = CANCELLED`, and told the caller the worker checks between
     * tests. It did not. This is that promise, kept — and the run keeps the
     * verdict its results earned rather than being filed as abandoned.
     */
    const db = fakeDb({ run: { totalCount: 3 } });
    h.afterExecute = (testId) => {
      if (testId !== 't1') return;
      db.run.stopRequestedAt = new Date();
      db.run.stopReason = 'Stopped by a reviewer: the staging data is wrong.';
    };

    await processRun(job());

    expect(h.executed).toEqual(['t1']);
    expect(db.run.status).not.toBe('CANCELLED');
    expect(db.results[1]!.errorMessage).toMatch(/^\[NOT_RUN\]/);
    expect(db.results[1]!.errorMessage).toMatch(/the staging data is wrong/);
    /*
     * The known gap, asserted so that nobody mistakes it for an accident: with
     * one passing test and two nobody reached, this run reports PASSED. It is
     * the same hole a partially-blocked environment leaves, it needs the same
     * fix (a MIN_ATTEMPTED_RATE gate rule, which needs a `GateRule` kind this
     * change cannot add), and until then the stop is on the frame and on the
     * rows rather than in the verdict.
     */
    expect(db.run.status).toBe('PASSED');
    const finished = published('run.finished')[0]!.data as { stopped: { notReached: number } };
    expect(finished.stopped.notReached).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (11) The environment and the image are different gaps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * packages/runner/src/preflight.ts calls this conflation the design's central
 * error, in these words: "install k6" is useless advice for a down staging box,
 * and "check your VPN" is useless advice for a worker image that never had
 * Lighthouse in it.
 *
 * The per-test rows have been honest about it since the typed kinds landed —
 * `[UNSUPPORTED]` for a missing tool, `[BLOCKED_BY_ENV]` for an unusable
 * environment — and the gate detail says "install the missing tool on the
 * worker". The ONE MACHINE-READABLE RUN-LEVEL FACT said the opposite: a run of
 * two LOAD tests on an image with no k6 reported
 * `ENVIRONMENT_UNAVAILABLE: … missing k6`, and @qaai/shared documents that
 * prefix as meaning "a run the environment made impossible".
 */
describe('a run nothing could be attempted in because a TOOL is missing', () => {
  const noK6 = (): void => {
    h.probes = {
      onPath: (binary) => binary !== 'k6',
      browserInstalled: () => true,
      platform: 'linux',
    };
  };

  it('does not report the customer’s environment as unavailable', async () => {
    const db = fakeDb({
      run: { totalCount: 2 },
      results: [resultFor('t1', { type: 'LOAD' }), resultFor('t2', { type: 'LOAD' })],
    });
    noK6();

    await processRun(job());

    expect(h.executed).toEqual([]);
    // The marker names the right party, and the sentence after it is still
    // complete English for a surface that has never heard of either prefix.
    expect(db.run.errorMessage).not.toMatch(/ENVIRONMENT_UNAVAILABLE/);
    expect(db.run.errorMessage).toMatch(/^TOOLING_UNAVAILABLE:/);
    expect(db.run.errorMessage).toMatch(/cannot execute LOAD tests/);
    expect(db.run.errorMessage).toMatch(/brew install k6/);
  });

  it('is still ERRORED, still BLOCKs the gate, and still measures nothing', async () => {
    /*
     * The verdict does not soften because the gap is ours rather than theirs.
     * There is no evidence about this change either way, so nothing may merge
     * on the strength of it.
     */
    const db = fakeDb({
      run: { totalCount: 2 },
      results: [resultFor('t1', { type: 'LOAD' }), resultFor('t2', { type: 'LOAD' })],
    });
    noK6();

    await processRun(job());

    expect(db.run.status).toBe('ERRORED');
    expect(db.run.failedCount).toBe(0);
    expect(db.run.skippedCount).toBe(2);
    const gate = db.run.gateResult as {
      passed: boolean;
      evaluations: Array<{ action: string; detail: string }>;
    };
    expect(gate.passed).toBe(false);
    expect(
      gate.evaluations.some(
        (e) => e.action === 'BLOCK' && /install the missing tool on the worker/.test(e.detail),
      ),
    ).toBe(true);
  });

  it('writes UNSUPPORTED into the column as well as the tag, on every row', async () => {
    /*
     * The column is the half that can answer "how many of this month's skips
     * were the environment's fault?" — a GROUP BY rather than a regex over a
     * text column. It shipped correct, queryable and EMPTY: nothing wrote it.
     */
    const db = fakeDb({
      run: { totalCount: 2 },
      results: [resultFor('t1', { type: 'LOAD' }), resultFor('t2', { type: 'LOAD' })],
    });
    noK6();

    await processRun(job());

    for (const row of db.results) {
      expect(row.notRunKind).toBe('UNSUPPORTED');
      expect(row.errorMessage).toMatch(/^\[UNSUPPORTED\]/);
    }
  });

  it('blames the ENVIRONMENT when the same run also could not reach the host', async () => {
    /*
     * A mixed run is a run that failed for two reasons, and the environment IS
     * implicated in it — so the marker names the environment, and the sentence
     * widens to the summary rather than leading with one cause under a marker
     * that names the other.
     */
    const db = fakeDb({
      run: { totalCount: 2 },
      results: [resultFor('t1', { type: 'LOAD' }), resultFor('t2', { type: 'E2E' })],
    });
    noK6();
    h.probe = deadHost;

    await processRun(job());

    expect(db.run.errorMessage).toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    // Both halves named, because both have to be fixed.
    expect(db.run.errorMessage).toMatch(/LOAD/);
    expect(db.run.errorMessage).toMatch(/connection was refused/);
    // And the rows still carry their own, different kinds.
    expect(db.results[0]!.notRunKind).toBe('UNSUPPORTED');
    expect(db.results[1]!.notRunKind).toBe('BLOCKED_BY_ENV');
  });

  it('keeps blaming the environment when the environment is the only cause', async () => {
    // The case that already worked, pinned so the new marker cannot capture it.
    const db = fakeDb();
    h.probe = deadHost;

    await processRun(job());

    expect(db.run.errorMessage).toMatch(/^ENVIRONMENT_UNAVAILABLE:/);
    for (const row of db.results) expect(row.notRunKind).toBe('BLOCKED_BY_ENV');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (12) The bulk stamp, and the two filters that keep it honest
// ─────────────────────────────────────────────────────────────────────────────

describe('the bulk stamp that records why a result did not run', () => {
  it('never writes a cancellation onto a test that executed and passed', async () => {
    /*
     * `status: 'SKIPPED'` is the other half of the stamp's safety and it was
     * untested: a passing result has `errorMessage: null`, so without the
     * status filter the message filter alone would match EVERY PASSING TEST IN
     * THE RUN, and a cancel would write "the run was cancelled before this
     * test was reached" onto results that ran and passed. A lie about a pass is
     * the most expensive one this file can tell.
     */
    const db = fakeDb();
    h.afterExecute = (testId) => {
      if (testId === 't1') db.run.status = 'CANCELLED';
    };

    await processRun(job());

    expect(h.executed).toEqual(['t1']);
    expect(db.results[0]!.status).toBe('PASSED');
    expect(db.results[0]!.errorMessage ?? null).toBeNull();
    expect(db.results[0]!.notRunKind ?? null).toBeNull();
    // The rows nobody reached are the only ones labelled.
    expect(db.results[1]!.notRunKind).toBe('CANCELLED');
    expect(db.results[2]!.notRunKind).toBe('CANCELLED');
  });

  it('counts a NOT_RUN row as not reached, never as unexplained', async () => {
    /*
     * `untagged` is documented as "SKIPPED rows carrying no typed reason", and
     * NOT_RUN rows — which DO carry one — were added to that same count three
     * lines below the comment. The two facts have different remedies: a dead
     * shard's slice is a re-run, and an untagged skip is a writer that has not
     * learned to tag yet.
     */
    const db = fakeDb({
      run: { shardCount: 2, totalCount: 2 },
      results: [
        { ...resultFor('t1'), shardIndex: 0 },
        { ...resultFor('t2'), shardIndex: 1 },
      ],
    });
    const rows = [
      { index: 0, status: 'QUEUED', errorMessage: null as string | null },
      {
        index: 1,
        status: 'ABANDONED',
        errorMessage: 'No heartbeat for 300s — the worker is gone.',
      },
    ];
    h.prisma.runShard = {
      updateMany: async (args: { where: { index?: number }; data: Record<string, unknown> }) => {
        if (args.where.index === undefined) return { count: 0 };
        const hit = rows.filter((r) => r.index === args.where.index);
        for (const r of hit) Object.assign(r, args.data);
        return { count: hit.length };
      },
      findUnique: async (args: { where: { runId_index: { index: number } } }) =>
        rows.find((r) => r.index === args.where.runId_index.index) ?? null,
      findMany: async () => rows.map((r) => ({ ...r })),
    };

    await processRun(job({ shard: { index: 0, count: 2 } }));

    expect(db.results[1]!.notRunKind).toBe('NOT_RUN');
    const finished = published('run.finished')[0]!.data as {
      environment: { notReached: number; notRecorded: number };
    };
    expect(finished.environment.notReached).toBe(1);
    expect(finished.environment.notRecorded).toBe(0);
  });

  it('leaves a row nothing explained in the unexplained count', async () => {
    /*
     * The honesty field, still honest. A plugin that returns SKIPPED with a
     * plain sentence has made no claim about which of the four reasons
     * applies, and NULL is the fifth state — "not recorded" — which is not
     * NOT_RUN and must not be folded into it.
     */
    const db = fakeDb({ run: { totalCount: 1 }, results: [resultFor('t1')] });
    h.statusFor.set('t1', 'SKIPPED');

    await processRun(job());

    expect(db.results[0]!.notRunKind ?? null).toBeNull();
    const finished = published('run.finished')[0]!.data as {
      environment: { notReached: number; notRecorded: number };
    };
    expect(finished.environment.notRecorded).toBe(1);
    expect(finished.environment.notReached).toBe(0);
  });
});

describe('a run only PART of which could be attempted', () => {
  it('writes the kind on the blocked row while the rest of the suite executes', async () => {
    /*
     * The other write path. An unattemptable run labels its rows in one bulk
     * pass before the loop; a PARTIALLY blocked one goes through the loop,
     * which builds a synthetic execution and hands it to `persistExecution` —
     * so the kind has to travel as DATA on the execution rather than be
     * re-read out of the message that was just formatted from it.
     *
     * This is also the shape that gives a plugin somewhere to put its own
     * claim: a plugin that returns SKIPPED because its tool is missing can now
     * say which of the four reasons applies, and the worker persists it.
     */
    const db = fakeDb({
      run: { totalCount: 2 },
      results: [resultFor('t1', { type: 'LOAD' }), resultFor('t2', { type: 'E2E' })],
    });
    h.probes = {
      onPath: (binary) => binary !== 'k6',
      browserInstalled: () => true,
      platform: 'linux',
    };

    await processRun(job());

    // The E2E test ran, so this is not the unattemptable path.
    expect(h.executed).toEqual(['t2']);
    expect(db.results[0]!.notRunKind).toBe('UNSUPPORTED');
    expect(db.results[0]!.errorMessage).toMatch(/^\[UNSUPPORTED\]/);
    // And the one that ran carries no kind: it was measured.
    expect(db.results[1]!.notRunKind ?? null).toBeNull();
    // The run-level marker stays out of it entirely — part of the suite ran.
    expect(db.run.errorMessage ?? null).toBeNull();
    expect(db.run.status).toBe('PASSED');
  });
});

describe('a test type nothing in this build can execute', () => {
  it('is SKIPPED with the typed reason in the column, not just in the message', async () => {
    /*
     * The loop's own "no plugin for this type" branch, which was unreachable
     * from this file and therefore untested — including the kind it writes.
     *
     * It takes BOTH halves to get here, and that is worth saying because it is
     * the design working: with a healthy preflight, a type with no plugin is
     * refused before the loop (`hasPlugin` feeds `runnabilityFor`). This branch
     * is the fallback for a run whose preflight itself broke — the instrument
     * failing must cost the run nothing — and it has to be as honest as the
     * preflight would have been, because the row it writes is the only thing a
     * reader sees.
     */
    const db = fakeDb({
      run: { totalCount: 2 },
      results: [resultFor('t1', { type: 'E2E' }), resultFor('t2', { type: 'LOAD' })],
    });
    // No plugin for E2E, and a PATH probe that throws while answering for LOAD
    // — so the preflight gives up entirely and the loop is what meets the
    // pluginless type. (A preflight that survives refuses it first, which is
    // why the second half is needed to reach this branch at all.)
    h.pluginless = new Set(['E2E']);
    const explode = (): never => {
      throw new Error('the probe exploded');
    };
    h.probes = { onPath: explode, browserInstalled: explode };

    await processRun(job());

    expect(h.log).toContain(
      'error:the environment preflight itself failed; executing the suite as if it had not run',
    );
    // The type with a plugin still runs: a broken instrument costs nothing.
    expect(h.executed).toEqual(['t2']);
    expect(db.results[0]!.status).toBe('SKIPPED');
    expect(db.results[0]!.errorMessage).toMatch(/^\[UNSUPPORTED\]/);
    /*
     * "Nobody built this yet" and "this cannot run here" were one SKIPPED for
     * the whole life of this file; the kind is the distinction, and it has to
     * be in the COLUMN to be countable. A message prefix cannot be grouped by.
     */
    expect(db.results[0]!.notRunKind).toBe('UNSUPPORTED');
    // And the executed one carries no kind at all: it was measured.
    expect(db.results[1]!.notRunKind ?? null).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (13) The matrix and the readings — the cloud half of the measurement writer
//
// `TestResultVariant` and `TestMetricSample` are the two tables that say WHERE
// a test passed and WHAT it measured, and both shipped with no writer at all:
// correct schema, correct validators, nothing persisting a row. There are TWO
// ingest doors — this one and `POST /runners/agent/jobs/:jobId/results` — and a
// customer's matrix must not depend on which runner they happen to use, so the
// row building is one block of source shared by both files and
// apps/api/src/routes/runners.test.ts holds the two copies byte-identical.
//
// What these tests are about, in order of how expensive the bug would be:
//
//   1. The five dimensions are each WRITTEN. They are NOT NULL with no database
//      default, so a writer that omitted one would succeed and store whatever
//      the database filled in — and the six-column unique index would then
//      count the default cell once per run, for ever.
//   2. `notRunKind` absent is NULL, which is a fifth state and is NOT NOT_RUN.
//   3. A null reading stays NULL with its reason. An LCP of 0 ms is a page that
//      painted instantly; a product that writes 0 for "not measured" reports
//      its blind spots as its best results.
//   4. A whole-test reading carries `variantId: null` AND the '<unvaried>' key,
//      because a unique index over the nullable id would re-insert the same
//      metric once per run for ever.
//   5. The writes REPLACE. A retried run job must not double a cell.
//   6. A refusal costs the MEASUREMENTS and nothing else, and is counted.
// ─────────────────────────────────────────────────────────────────────────────

/** The same two cells the agent route's own suite reports. */
const CHROMIUM_CELL = {
  browser: 'chromium',
  viewport: '1280x720',
  locale: 'en-US',
  // A REAL ANSWER, not a missing one: this cell ran as a logged-out visitor.
  role: '<anonymous>',
  environment: 'env_1',
};
const WEBKIT_CELL = { ...CHROMIUM_CELL, browser: 'webkit' };

/** The key format both ingest paths write. See `variantKeyOf` in run.ts. */
const cellKey = (cell: typeof CHROMIUM_CELL): string =>
  JSON.stringify([cell.browser, cell.viewport, cell.locale, cell.role, cell.environment]);

/**
 * ONE reported matrix, mirroring `MATRIX_BATCH` in
 * apps/api/src/routes/runners.test.ts cell for cell and reading for reading.
 *
 * It carries, on purpose: a cell that passed and a cell that failed for the
 * same test (the sentence `TestResult.status` cannot say), the same metric
 * measured in one cell and UNMEASURED in the other, and a whole-test reading
 * whose value is 0 — a pixel-perfect visual diff, the best possible result and
 * the exact number a writer that confuses null with zero destroys.
 */
const REPORTED_MATRIX = {
  variants: [
    {
      key: CHROMIUM_CELL,
      status: 'PASSED',
      durationMs: 1_200,
      metrics: [{ name: 'lcp', value: 812.5, unit: 'MILLISECONDS', direction: 'LOWER_IS_BETTER' }],
    },
    {
      key: WEBKIT_CELL,
      status: 'FAILED',
      durationMs: 2_400,
      errorMessage: 'expected the cart badge to read 1',
      metrics: [
        {
          name: 'lcp',
          value: null,
          unavailableReason: 'the trace carried no paint entry',
          unit: 'MILLISECONDS',
          direction: 'LOWER_IS_BETTER',
        },
      ],
    },
  ],
  metrics: [{ name: 'visual_diff_ratio', value: 0, unit: 'RATIO', direction: 'LOWER_IS_BETTER' }],
};

describe('the matrix writer', () => {
  it('writes one cell per reported cell, with all five dimensions explicit', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    h.measurements.set('t1', REPORTED_MATRIX);

    await processRun(job());

    expect(db.variantRows).toHaveLength(2);
    /*
     * EVERY DIMENSION ASSERTED BY NAME, and every parent column with it. The
     * dimensions are NOT NULL with no default, so omitting one does not fail —
     * it stores the column the database chose. Dropping any of these five keys
     * from the writer's row object turns this assertion red.
     */
    expect(db.variantRows[0]).toMatchObject({
      orgId: ORG,
      testResultId: 'r_t1',
      runId: RUN,
      testId: 't1',
      browser: 'chromium',
      viewport: '1280x720',
      locale: 'en-US',
      role: '<anonymous>',
      environment: 'env_1',
      status: 'PASSED',
      durationMs: 1_200,
      errorMessage: null,
      notRunKind: null,
      retriedAndPassed: false,
    });
    expect(db.variantRows[1]).toMatchObject({
      browser: 'webkit',
      viewport: '1280x720',
      locale: 'en-US',
      role: '<anonymous>',
      environment: 'env_1',
      status: 'FAILED',
      durationMs: 2_400,
      errorMessage: 'expected the cart badge to read 1',
      notRunKind: null,
    });
    for (const row of db.variantRows) {
      for (const dimension of ['browser', 'viewport', 'locale', 'role', 'environment']) {
        expect(row[dimension], `${dimension} was left to the database`).toEqual(
          expect.any(String),
        );
      }
    }
  });

  it('keeps the per-cell verdicts beside the worst-wins roll-up', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    h.statusFor.set('t1', 'FAILED');
    h.measurements.set('t1', REPORTED_MATRIX);

    await processRun(job());

    // "Did it pass?" is the result's question and "where did it pass?" is the
    // cells'; overwriting either with the other makes a matrix one wrong answer.
    expect(db.results[0]!.status).toBe('FAILED');
    expect(db.variantRows.map((row) => row.status)).toEqual(['PASSED', 'FAILED']);
  });

  it('writes the readings the agent path writes, for the matrix the agent path reports', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    h.measurements.set('t1', REPORTED_MATRIX);

    await processRun(job());

    /*
     * THE EQUIVALENCE, asserted as a whole row set rather than field by field.
     * Two ingest paths that drift are how one customer's matrix comes to
     * disagree with another's, and the assertion below is the same list the
     * agent route's "attaches a cell reading to the cell that reported it" and
     * "writes a whole-test reading with a null variantId" tests make — the only
     * legitimate differences being the tenancy and parent ids, which come from
     * each door's own scope.
     */
    const byName = (name: string, key: string): MeasuredRow =>
      db.readingRows.find((row) => row.name === name && row.variantKey === key)!;

    expect(db.readingRows).toHaveLength(3);

    expect(byName('lcp', cellKey(CHROMIUM_CELL))).toMatchObject({
      orgId: ORG,
      projectId: 'proj1',
      runId: RUN,
      testId: 't1',
      testResultId: 'r_t1',
      variantId: db.variantRows[0]!.id,
      variantKey: cellKey(CHROMIUM_CELL),
      value: 812.5,
      unavailableReason: null,
      unit: 'MILLISECONDS',
      direction: 'LOWER_IS_BETTER',
    });

    /*
     * THE SAME METRIC, UNMEASURED IN THE OTHER CELL. Null with a reason, never
     * 0: an LCP of 0 ms is a page that painted instantly, which is the best
     * result there is, and writing it here would report a blind spot as one.
     */
    expect(byName('lcp', cellKey(WEBKIT_CELL))).toMatchObject({
      variantId: db.variantRows[1]!.id,
      value: null,
      unavailableReason: 'the trace carried no paint entry',
    });

    /*
     * BOTH HALVES OF THE WHOLE-TEST READING. `variantId` is the join and
     * `variantKey` is the identity, and the unique index is over the KEY: a
     * unique over the nullable id would treat every whole-test reading as
     * distinct — every NULL is distinct in PostgreSQL — and the same metric
     * would be inserted once per run for ever. Dropping the sentinel write
     * turns this red.
     */
    const whole = byName('visual_diff_ratio', '<unvaried>');
    expect(whole.variantId).toBeNull();
    expect(whole.variantKey).toBe('<unvaried>');
    // 0 IS A MEASUREMENT: a pixel-perfect diff. Not null, and not absent.
    expect(whole.value).toBe(0);
    expect(whole.unavailableReason).toBeNull();
  });

  it('stores notRunKind as null when absent, and the kind plus its sentence when given', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    h.measurements.set('t1', {
      variants: [
        { key: CHROMIUM_CELL, status: 'PASSED', durationMs: 10 },
        {
          key: WEBKIT_CELL,
          status: 'SKIPPED',
          durationMs: 0,
          notRun: { kind: 'UNSUPPORTED', why: 'this image has no WebKit build' },
        },
      ],
    });

    await processRun(job());

    /*
     * NULL, AND NULL IS A FIFTH STATE THAT IS NOT NOT_RUN. The cell ran; the
     * producer made no claim about why it measured nothing because there is
     * nothing to claim. A default of NOT_RUN would put a sentence in the
     * database that no plugin ever said.
     */
    expect(db.variantRows[0]!.notRunKind).toBeNull();
    expect(db.variantRows[1]!.notRunKind).toBe('UNSUPPORTED');
    // The `why` has no column of its own, so it goes where the parent result's
    // does — tagged, so `parseNotRun` reads the kind back off it.
    expect(db.variantRows[1]!.errorMessage).toBe('[UNSUPPORTED] this image has no WebKit build');
  });
});

describe('replacing a reported matrix', () => {
  it('deletes before it inserts, both tables, inside the result transaction', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    h.measurements.set('t1', REPORTED_MATRIX);

    await processRun(job());

    /*
     * The readings' delete FIRST and explicitly. A whole-test reading has
     * `variantId: null` and therefore nothing to cascade from, so a
     * variant-only delete would leave the last attempt's number beside this
     * attempt's cells. Replacing either delete with nothing passes every count
     * assertion on a first delivery, so the ORDER is what gets asserted.
     */
    expect(db.measurementOps).toEqual([
      'reading.deleteMany',
      'variant.deleteMany',
      'variant.createManyAndReturn',
      'reading.createMany',
    ]);
  });

  it('clears a previous attempt\'s cells and readings instead of doubling them', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    // What a retried BullMQ job finds: last attempt's rows, already stored.
    db.variantRows.push({ id: 'stale_cell', testResultId: 'r_t1', browser: 'firefox' });
    db.readingRows.push({ id: 'stale_reading', testResultId: 'r_t1', name: 'lcp' });
    h.measurements.set('t1', REPORTED_MATRIX);

    await processRun(job());

    expect(db.variantRows.map((row) => row.id)).not.toContain('stale_cell');
    expect(db.readingRows.map((row) => row.id)).not.toContain('stale_reading');
    expect(db.variantRows).toHaveLength(2);
    expect(db.readingRows).toHaveLength(3);
  });

  it('clears a matrix the next attempt no longer reports', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    db.variantRows.push({ id: 'stale_cell', testResultId: 'r_t1', browser: 'firefype' });
    db.readingRows.push({ id: 'stale_reading', testResultId: 'r_t1', name: 'lcp' });
    // Nothing reported this time — same argument as the survivor rows: stale
    // evidence must not outlive the number it describes.
    h.measurements.set('t1', {});

    await processRun(job());

    expect(db.variantRows).toHaveLength(0);
    expect(db.readingRows).toHaveLength(0);
  });

  it('reads the cell\'s run off the parent row, not off the run in hand', async () => {
    const parent = resultFor('t1');
    /*
     * A state the database cannot actually reach — `run.results` is a relation
     * read, so a result's `runId` is always this run's — and asserted anyway,
     * because it is the ONLY way to tell `result.runId` apart from `run.id`
     * here. What is being pinned is that the denormalised column is COPIED FROM
     * THE ROW THE WRITE HANGS OFF: a later refactor that reads the result rows
     * from anywhere else still writes the run those rows belong to, instead of
     * stamping whichever run the loop happened to be holding.
     *
     * Without this, swapping `result.runId` for `run.id` in the writer survives
     * every other test in this file, because the two are the same string.
     */
    parent.runId = 'run_off_the_parent_row';
    const db = fakeDb({ results: [parent] });
    h.measurements.set('t1', {
      variants: [{ key: CHROMIUM_CELL, status: 'PASSED', durationMs: 1 }],
      metrics: [{ name: 'lcp', value: 1, unit: 'MILLISECONDS', direction: 'LOWER_IS_BETTER' }],
    });

    await processRun(job());

    expect(db.variantRows[0]!.runId).toBe('run_off_the_parent_row');
    expect(db.readingRows[0]!.runId).toBe('run_off_the_parent_row');
  });

  it('leaves another result\'s cells alone', async () => {
    const db = fakeDb({ results: [resultFor('t1'), resultFor('t2')] });
    h.measurements.set('t1', { variants: [{ key: CHROMIUM_CELL, status: 'PASSED', durationMs: 1 }] });
    h.measurements.set('t2', { variants: [{ key: WEBKIT_CELL, status: 'PASSED', durationMs: 2 }] });

    await processRun(job());

    expect(db.variantRows).toHaveLength(2);
    expect(db.variantRows.map((row) => row.testResultId)).toEqual(['r_t1', 'r_t2']);
  });
});

describe('a report the worker cannot store', () => {
  it('refuses an unexplained null reading, counts it, and stores the result anyway', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    h.measurements.set('t1', {
      // A null with no reason is indistinguishable from a writer's bug and will
      // be read as zero by the first consumer that forgets to check.
      metrics: [{ name: 'lcp', value: null, unit: 'MILLISECONDS', direction: 'LOWER_IS_BETTER' }],
    });

    await processRun(job());

    expect(db.readingRows).toHaveLength(0);
    /*
     * THE RESULT STILL LANDS. A reporting problem must never cost a run its
     * verdict — that is the whole contract of this ingest path — so the refusal
     * costs the MEASUREMENTS and nothing else.
     */
    expect(db.results[0]!.status).toBe('PASSED');
    expect(db.run.status).toBe('PASSED');

    /*
     * AND IT IS DISCLOSED. There is no caller here to hand a 400 to, so the log
     * is the only channel: how many readings were reported, and why none of
     * them could be stored. Silence would be a measurement that vanished and
     * read afterwards as "never taken".
     */
    const refusal = h.warned.find((line) => line.msg.startsWith('measurements refused'))!;
    expect(refusal).toBeDefined();
    expect(refusal.fields).toMatchObject({ runId: RUN, testId: 't1', readingsReported: 1 });
    expect(String(refusal.fields.reason)).toContain('reading 0 is not a valid metric');
    // The FIELD, never its contents: a dimension and a metric name are both
    // producer-supplied text, and a raw one in a log line is a forged log line.
    expect(String(refusal.fields.reason)).toContain('unavailableReason');
  });

  it('refuses the whole matrix when one cell is a duplicate, and writes none of it', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    h.measurements.set('t1', {
      variants: [
        { key: CHROMIUM_CELL, status: 'PASSED', durationMs: 1 },
        { key: CHROMIUM_CELL, status: 'FAILED', durationMs: 2 },
      ],
    });

    await processRun(job());

    /*
     * ALL OR NOTHING. A partially stored matrix is indistinguishable from a
     * narrower matrix somebody configured on purpose, which is the one thing
     * this table exists to be able to tell apart.
     */
    expect(db.variantRows).toHaveLength(0);
    const refusal = h.warned.find((line) => line.msg.startsWith('measurements refused'))!;
    expect(refusal.fields).toMatchObject({ cellsReported: 2 });
    expect(String(refusal.fields.reason)).toContain('twice');
  });

  it('refuses a cell with nothing varied rather than duplicating the roll-up', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    h.measurements.set('t1', { variants: [{ key: {}, status: 'PASSED', durationMs: 1 }] });

    await processRun(job());

    expect(db.variantRows).toHaveLength(0);
    const refusal = h.warned.find((line) => line.msg.startsWith('measurements refused'))!;
    expect(String(refusal.fields.reason)).toContain('none of the five dimensions varied');
  });

  it('refuses a reading whose cell was not reported, instead of filing it under the test', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });
    h.measurements.set('t1', {
      variants: [{ key: CHROMIUM_CELL, status: 'PASSED', durationMs: 1 }],
      metrics: [
        {
          name: 'lcp',
          value: 900,
          unit: 'MILLISECONDS',
          direction: 'LOWER_IS_BETTER',
          variant: WEBKIT_CELL,
        },
      ],
    });

    await processRun(job());

    // Writing it with `variantId: null` would reattribute a WebKit measurement
    // to the whole test — a per-cell number silently becoming a per-test claim.
    expect(db.readingRows).toHaveLength(0);
    expect(db.variantRows).toHaveLength(0);
    const refusal = h.warned.find((line) => line.msg.startsWith('measurements refused'))!;
    expect(String(refusal.fields.reason)).toContain('which this batch did not report');
    expect(String(refusal.fields.reason)).toContain('webkit');
  });

  it('reports nothing and refuses nothing when a plugin measures nothing', async () => {
    const db = fakeDb({ results: [resultFor('t1')] });

    await processRun(job());

    /*
     * The ordinary case, and the one the model's own comment turns on: a run
     * with no variation writes NO ROWS. Absent means "this execution was not
     * varied", and one synthetic row would make it indistinguishable from a
     * deliberate one-cell matrix. No refusal is logged either — there is
     * nothing to refuse.
     */
    expect(db.variantRows).toHaveLength(0);
    expect(db.readingRows).toHaveLength(0);
    expect(h.warned.filter((line) => line.msg.startsWith('measurements refused'))).toHaveLength(0);
    // The deletes still ran, so a matrix that stopped being reported stops
    // existing rather than lingering from the previous attempt.
    expect(db.measurementOps).toEqual(['reading.deleteMany', 'variant.deleteMany']);
  });
});
