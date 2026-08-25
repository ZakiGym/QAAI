/**
 * On-prem runner agents (ENTERPRISE) — the server half.
 *
 * The design decision everything here follows from: **the agent polls out.** An
 * enterprise will not open an inbound port for a SaaS vendor, and a protocol
 * that needs one is dead on arrival. So we never dial a runner. We answer one.
 * There is no "dispatch to runner" call anywhere in this codebase, and there
 * must never be — a customer's staging network is unreachable from ours, which
 * is the entire reason the feature exists.
 *
 * What that costs us is liveness. A BullMQ worker dies and Redis notices; an
 * agent behind a customer's firewall dies and we get *nothing* — no RST, no
 * timeout, no signal of any kind. A missing heartbeat is the only evidence we
 * will ever have. So this module reuses the lease/heartbeat/reap machinery from
 * `apps/worker/src/processors/run.ts` rather than inventing a second one with a
 * different set of bugs, and adds the one thing the shard case does not need:
 *
 *   **A fencing token.** Every claim mints a fresh `leaseId`, and every later
 *   call must present it. A runner whose VM was paused for ten minutes comes
 *   back believing it still owns the job — it does not, the reaper gave it to
 *   somebody else — and its writes must bounce. Without the fence,
 *   "reclaimable" and "never executes twice" cannot both be true.
 *
 * Two house rules shape the rest:
 *
 *  - **A missing tool is SKIPPED, never FAILED.** If no runner in the pool has
 *    the browser or the binary a job needs, nothing about the customer's
 *    application was tested. Red would be a lie and green would be worse, so
 *    the job is SKIPPED with a sentence naming what to install.
 *  - **Suppressing a signal fails open and is audited.** A SKIP is a
 *    suppression. It happens only after a grace period (a runner that is
 *    restarting is not a runner that is missing), only on positive evidence
 *    that nothing in the org can serve the work, and it always writes an audit
 *    row. When in doubt the job stays queued.
 */

import { randomUUID } from 'node:crypto';
import { DEFAULT_GATE_RULES, evaluateGates } from '@qaai/runner';
import { PLAN_LIMITS, QUEUE_NAMES, TEST_TYPES } from '@qaai/shared';
import type { GateRule, TestType } from '@qaai/shared';
import { prisma } from './prisma.js';
import { generateToken, hashToken } from './crypto.js';
import { open as openSecret } from './vault.js';
import { audit } from './audit.js';
import { enqueue } from './queues.js';
import { publish } from './events.js';
import { logger } from './logger.js';
import { conflict } from './errors.js';

// ─── Timings ─────────────────────────────────────────────────────────────────

/**
 * How often an agent stamps proof of life, and how long a lease survives
 * without one.
 *
 * The ratio matters more than either number. At 15s/90s a runner may miss five
 * consecutive heartbeats — a GC pause, a saturated corporate proxy, a DNS blip
 * — before anyone takes its work away. Reaping a live runner is the expensive
 * mistake: the job is handed to a second agent while the first is still driving
 * a browser against the customer's staging environment, which is the one thing
 * the fencing token exists to make survivable rather than catastrophic.
 */
export const RUNNER_HEARTBEAT_MS = 15_000;
export const RUNNER_LEASE_MS = 90_000;

/** A runner that has not called in this long is shown as offline. */
export const RUNNER_ONLINE_MS = 60_000;

/**
 * How long a claim request is held open before answering "nothing yet".
 *
 * Under the 30s idle timeout that nginx, ALB and most corporate egress proxies
 * default to. A long poll that outlives the proxy in front of it is not a long
 * poll, it is an error every 30 seconds.
 */
export const RUNNER_LONG_POLL_MS = 25_000;

/**
 * How long a job waits for a capable runner before we declare that none is
 * coming.
 *
 * This is the fail-open window. Agents restart — a deploy, a reboot, a
 * `systemctl restart` — and during that minute the org genuinely has no runner
 * that can serve anything. Skipping on that evidence would silently drop a
 * suite because someone patched a box. Fifteen minutes is long enough that the
 * answer is "it is not coming back" rather than "it is coming back".
 */
export const RUNNER_UNSERVABLE_GRACE_MS = 15 * 60_000;

/** Agent-supplied payload ceilings. Everything here arrives from outside. */
export const MAX_RESULTS_PER_BATCH = 50;
export const MAX_LOG_LINES_PER_CALL = 200;
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** Runner tokens are visibly not API keys, so neither can be pasted for the other. */
export const RUNNER_TOKEN_PREFIX = 'qaai_rt_';

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * What a runner says it can do.
 *
 * Reported by the agent, re-validated here, and used for exactly one thing:
 * deciding what NOT to send it. It can never grant privilege — a runner that
 * claims every capability in the world still only ever receives its own org's
 * jobs, because the token is what scopes it and the token is not in this shape.
 */
export interface RunnerCapabilities {
  /** 'chromium' | 'firefox' | 'webkit', as Playwright names them. */
  browsers: string[];
  /** TestTypes this agent is willing to execute. */
  testTypes: TestType[];
  /** 'typescript', 'python' — for suites whose specs are not JS. */
  languages: string[];
  /** Binaries on PATH: 'node', 'npx', 'k6', 'psql', 'appium'. */
  toolchains: string[];
  /** How many jobs this agent will hold at once. Clamped to something sane. */
  maxConcurrency: number;
}

/** What a job needs before it can be offered to a runner. */
export interface JobRequirements {
  testTypes: TestType[];
  browsers: string[];
  toolchains: string[];
}

const EMPTY_CAPABILITIES: RunnerCapabilities = {
  browsers: [],
  testTypes: [],
  languages: [],
  toolchains: [],
  maxConcurrency: 1,
};

/** Per-list and per-entry ceilings. This JSON is written by a remote process. */
const MAX_LIST = 64;
const MAX_ENTRY = 64;

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    // Lowercased and trimmed so `Chromium`, `chromium ` and `chromium` are one
    // capability rather than three that fail to match a requirement.
    const normalised = value.trim().toLowerCase().slice(0, MAX_ENTRY);
    if (normalised) out.add(normalised);
    if (out.size >= MAX_LIST) break;
  }
  return [...out];
}

/**
 * Read an agent's capability report into the typed shape, dropping anything
 * unrecognised.
 *
 * Unknown TestTypes are discarded rather than kept: the only consumer is the
 * matcher, and a member that no job can ever require is dead weight in a Json
 * column that a remote process controls the size of.
 */
export function parseCapabilities(raw: unknown): RunnerCapabilities {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_CAPABILITIES };
  const c = raw as Record<string, unknown>;

  const known = new Set<string>(TEST_TYPES);
  const testTypes = Array.isArray(c.testTypes)
    ? [
        ...new Set(
          c.testTypes
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim().toUpperCase())
            .filter((v): v is TestType => known.has(v)),
        ),
      ]
    : [];

  const concurrency = Number(c.maxConcurrency);
  return {
    browsers: stringList(c.browsers),
    testTypes,
    languages: stringList(c.languages),
    toolchains: stringList(c.toolchains),
    maxConcurrency:
      Number.isFinite(concurrency) && concurrency >= 1 ? Math.min(Math.floor(concurrency), 64) : 1,
  };
}

/**
 * TestTypes that drive a real browser, and therefore need one installed.
 *
 * Mirrors which plugins in `packages/runner/src/registry.ts` reach for
 * Playwright. It is a routing hint, not a contract: getting it wrong sends a
 * job to a runner that then reports SKIPPED with the missing browser named,
 * which is the same honest outcome by a slower path.
 */
const BROWSER_TEST_TYPES: ReadonlySet<TestType> = new Set<TestType>([
  'E2E',
  'SMOKE',
  'VISUAL',
  'ACCESSIBILITY',
  'CROSS_BROWSER',
  'LOCALIZATION',
  'SECURITY_SMOKE',
  'EMAIL_OTP',
  // Core Web Vitals are collected inside a real Chromium — a runner without one
  // can only report the whole test SKIPPED.
  'PERFORMANCE',
]);

/**
 * Binaries a type shells out to, named exactly as they appear on PATH so the
 * agent's probe and this requirement are the same string. `k6` is the model
 * case: the LOAD plugin already skips with "k6 is not installed… install it
 * (brew install k6)" when it is missing locally, and this is the same sentence
 * moved one hop earlier, before the job is ever offered.
 */
const TOOLCHAIN_FOR_TYPE: Partial<Record<TestType, string>> = {
  LOAD: 'k6',
  DATABASE: 'psql',
  MOBILE: 'appium',
};

/** What the tests in one slice collectively need. */
export function requirementsForTests(tests: ReadonlyArray<{ type: TestType }>): JobRequirements {
  const testTypes = [...new Set(tests.map((t) => t.type))];
  const toolchains = new Set<string>();
  let needsBrowser = false;

  for (const type of testTypes) {
    if (BROWSER_TEST_TYPES.has(type)) needsBrowser = true;
    const binary = TOOLCHAIN_FOR_TYPE[type];
    if (binary) toolchains.add(binary);
  }

  return {
    testTypes,
    // Chromium only. Asking for the browser a CROSS_BROWSER matrix actually
    // names would mean reading every test's spec here, and the plugin re-checks
    // it anyway — this is the floor, not the whole answer.
    browsers: needsBrowser ? ['chromium'] : [],
    toolchains: [...toolchains],
  };
}

/**
 * What this runner is missing for this job, phrased for a human.
 *
 * Empty means it can serve the job. The strings are fragments — "the chromium
 * browser", "the k6 binary" — because they end up in one sentence listing
 * everything the whole pool lacks.
 */
export function missingCapabilities(
  requirements: JobRequirements,
  capabilities: RunnerCapabilities,
): string[] {
  const missing: string[] = [];

  for (const browser of requirements.browsers) {
    if (!capabilities.browsers.includes(browser)) missing.push(`the ${browser} browser`);
  }
  for (const binary of requirements.toolchains) {
    if (!capabilities.toolchains.includes(binary)) missing.push(`the ${binary} binary`);
  }
  for (const type of requirements.testTypes) {
    /*
     * An empty testTypes list means "did not say", not "cannot run anything".
     * Older agents predate the field, and treating silence as refusal would
     * strand every job in the pool the day one connects.
     */
    if (capabilities.testTypes.length > 0 && !capabilities.testTypes.includes(type)) {
      missing.push(`support for ${type} tests`);
    }
  }
  return missing;
}

export function canServe(
  requirements: JobRequirements,
  capabilities: RunnerCapabilities,
): boolean {
  return missingCapabilities(requirements, capabilities).length === 0;
}

/**
 * Pool routing.
 *
 * A runner that names no pools serves every pool in its org — the common
 * deployment is one pool and one agent, and making that case require matching
 * strings on both sides is how a customer's first runner sits idle next to a
 * job it could have run. A runner that DOES name pools serves only those,
 * because at that point someone has deliberately partitioned their fleet.
 */
export function servesPool(runnerPools: readonly string[], jobPool: string | null): boolean {
  if (runnerPools.length === 0) return true;
  if (!jobPool) return true;
  return runnerPools.includes(jobPool);
}

export interface RunnerSnapshot {
  id: string;
  name: string;
  pools: string[];
  capabilities: unknown;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export function isOnline(lastSeenAt: Date | null, now = Date.now()): boolean {
  return lastSeenAt !== null && now - lastSeenAt.getTime() < RUNNER_ONLINE_MS;
}

/**
 * The five ways a pool can stand in relation to a piece of work.
 *
 * Ordered by what has to be fixed, which is also the order they are checked:
 * you cannot have the wrong pool before you have a runner, and you cannot lack
 * chromium before you are online.
 */
export type PoolReadinessCode =
  | 'ready'
  | 'no-runners'
  | 'no-pool-runners'
  | 'none-online'
  | 'missing-capabilities';

export interface PoolReadiness {
  code: PoolReadinessCode;
  ready: boolean;
  /** Registered, unrevoked runners that serve this pool, in registration order. */
  serving: RunnerSnapshot[];
  /** How many of those checked in inside the online window. */
  online: number;
  /**
   * The union of what the ONLINE runners lack, as sentence fragments. Empty
   * unless `code` is `missing-capabilities`: a pool with nobody online has no
   * shortfall to report, it has nobody to report one about.
   */
  missing: string[];
}

/**
 * Where a pool stands, as facts rather than prose.
 *
 * Extracted so the two sentences that describe it — the past-tense one written
 * onto a suppressed job by the sweep, and the future-tense one shown to
 * whoever just started a run — are two renderings of ONE judgement. They are
 * written for different moments and must read differently, but "is there a
 * runner for this" is not allowed to have two answers depending on which of
 * them you happen to be reading.
 */
export function assessPool(
  requirements: JobRequirements,
  pool: string | null,
  runners: readonly RunnerSnapshot[],
  now = Date.now(),
): PoolReadiness {
  const live = runners.filter((r) => !r.revokedAt);
  const serving = live.filter((r) => servesPool(r.pools, pool));
  const onlineRunners = serving.filter((r) => isOnline(r.lastSeenAt, now));
  const base = { serving, online: onlineRunners.length };

  if (live.length === 0) return { code: 'no-runners', ready: false, missing: [], ...base };
  if (serving.length === 0) return { code: 'no-pool-runners', ready: false, missing: [], ...base };
  if (onlineRunners.length === 0) return { code: 'none-online', ready: false, missing: [], ...base };

  // Online, but possibly not equipped. Report the union of what is missing
  // rather than one runner's shortfall: "install chromium" is actionable,
  // "runner build-02 lacks chromium" invites installing it on the wrong box.
  const shortfalls = onlineRunners.map((r) =>
    missingCapabilities(requirements, parseCapabilities(r.capabilities)),
  );
  if (shortfalls.some((m) => m.length === 0)) {
    return { code: 'ready', ready: true, missing: [], ...base };
  }
  return {
    code: 'missing-capabilities',
    ready: false,
    missing: [...new Set(shortfalls.flat())],
    ...base,
  };
}

/** `" in the \"eu-staging\" pool"`, or nothing at all for the default pool. */
function poolClause(pool: string | null): string {
  return pool ? ` in the "${pool}" pool` : '';
}

/**
 * Why nothing in this org can run this job — or null when something can.
 *
 * Null is the fail-open answer and it is returned generously: if any runner
 * that is currently online could serve the work, the job waits, however long it
 * has already waited. Only a positive "nobody can" produces a sentence, and
 * that sentence is the entire user-facing explanation of a suppressed test, so
 * it names what to install and where.
 *
 * Past tense throughout, because by the time anyone reads it the tests have
 * already been reported SKIPPED. `describeDispatch` below is the same facts in
 * the tense of a run that has just been queued.
 */
export function describeUnservable(
  requirements: JobRequirements,
  pool: string | null,
  runners: readonly RunnerSnapshot[],
  now = Date.now(),
): string | null {
  const state = assessPool(requirements, pool, runners, now);
  const where = poolClause(pool);

  switch (state.code) {
    case 'ready':
      return null;
    case 'no-runners':
      return (
        `No on-prem runner has been registered for this organisation, so these tests never ran. ` +
        `Register one in Settings → Runners and start the agent on a host inside the network ` +
        `(\`qaai runner --api-url <your QAAI URL> --token <runner token>\`).`
      );
    case 'no-pool-runners':
      return (
        `No on-prem runner${where} is registered, so these tests never ran. ` +
        `Add "${pool}" to the pools of an existing runner, or register one for it in Settings → Runners.`
      );
    case 'none-online':
      return (
        `No on-prem runner${where} has checked in recently, so these tests never ran. ` +
        `Registered runners: ${state.serving.map((r) => r.name).slice(0, 5).join(', ')}. ` +
        `Start the agent on those hosts — it only makes outbound ` +
        `HTTPS to QAAI, so nothing needs to be opened inbound.`
      );
    case 'missing-capabilities':
      return (
        `No on-prem runner${where} has ${state.missing.join(', ')}, so these tests never ran. ` +
        `Install what is missing on a runner host and restart the agent — it re-reports its ` +
        `capabilities on every connect.`
      );
  }
}

/**
 * What to tell the caller who just pointed a run at an on-prem pool.
 *
 * This is the honesty fix the whole feature turns on. A run dispatched to a
 * pool that nothing is listening to sits QUEUED and looks *exactly* like a run
 * that is executing slowly — same status, same spinner, same absence of
 * results — and stays that way for the fifteen minutes the sweep waits before
 * it will say anything at all. Fifteen minutes of "is it working?" is how a
 * customer concludes the feature is broken, and they are not wrong to.
 *
 * So the moment the jobs are created we look at the pool and, if nothing there
 * can take them, say so in the response — before anyone has had to wonder.
 * Null when the pool is ready, because a warning that fires on the happy path
 * is a warning people learn to scroll past.
 *
 * Deliberately NOT a refusal. The run is still created, the jobs are still
 * queued, and an agent that starts thirty seconds later picks them up
 * normally — a runner restarting during a deploy is the common case, and
 * rejecting the run would turn a hiccup into a failed build.
 */
export function describeDispatch(
  requirements: JobRequirements,
  pool: string | null,
  runners: readonly RunnerSnapshot[],
  now = Date.now(),
): string | null {
  const state = assessPool(requirements, pool, runners, now);
  const where = poolClause(pool);
  const grace =
    `Nothing needs to be opened inbound — the agent polls out — and if nothing claims this work ` +
    `within ${Math.round(RUNNER_UNSERVABLE_GRACE_MS / 60_000)} minutes QAAI reports the tests as ` +
    `skipped rather than leaving the run hanging.`;

  switch (state.code) {
    case 'ready':
      return null;
    case 'no-runners':
      return (
        `This run was sent to your on-prem pool, but no runner is registered for this ` +
        `organisation, so nothing will claim it. Register one in Settings → Runners and start ` +
        `the agent on a host that can reach this environment. ${grace}`
      );
    case 'no-pool-runners':
      return (
        `This run was sent to the "${pool}" pool, and no registered runner serves it, so nothing ` +
        `will claim it. Add "${pool}" to the pools of an existing runner, or register one for ` +
        `it in Settings → Runners. ${grace}`
      );
    case 'none-online':
      return (
        `No on-prem runner${where} has checked in within the last minute, so nothing is claiming ` +
        `work there right now. Registered runners: ` +
        `${state.serving.map((r) => r.name).slice(0, 5).join(', ')}. If one is restarting this ` +
        `resolves on its own. ${grace}`
      );
    case 'missing-capabilities':
      return (
        `The runners${where} are online, but none of them has ${state.missing.join(', ')}, so ` +
        `this run will not be claimed. Install what is missing on a runner host and restart the ` +
        `agent — it re-reports its capabilities on every connect. ${grace}`
      );
  }
}

// ─── The fleet, by pool ──────────────────────────────────────────────────────

/** A runner as the pools view reads it: liveness plus when it last took work. */
export interface PoolFleetMember extends RunnerSnapshot {
  lastClaimAt: Date | null;
}

export interface PoolMemberView {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: Date | null;
  lastClaimAt: Date | null;
  /** True when this runner names no pools and therefore serves all of them. */
  servesAll: boolean;
}

export interface PoolSummary {
  /** Null is the default pool — where a run whose environment names none would go. */
  pool: string | null;
  code: PoolReadinessCode;
  ready: boolean;
  runners: PoolMemberView[];
  online: number;
  /** The environments whose runs route here. Empty means nothing will ever queue. */
  environments: Array<{ id: string; projectId: string; name: string }>;
  queued: number;
  inFlight: number;
  /**
   * The newest claim by any runner serving this pool.
   *
   * The single most useful fact on the runners screen, and the one nothing
   * rendered before: "online" says a process is running, `lastClaimAt` says it
   * is actually asking for work. An agent wedged after a bad deploy heartbeats
   * happily and claims nothing, which from every other angle looks healthy.
   */
  lastClaimAt: Date | null;
  /** One sentence for the screen. Always present — a healthy pool says so too. */
  note: string;
}

const NAMES_SHOWN = 4;

function joinNames(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(', ');
  return names.length > NAMES_SHOWN ? `${shown} and ${names.length - NAMES_SHOWN} more` : shown;
}

/**
 * The pools an org actually has, and whether anything is listening to each.
 *
 * This exists to answer one support question — "I registered a runner and
 * nothing happens" — from the screen instead of from a database. Three
 * independent things have to line up before a single test executes on-prem: an
 * environment has to name a pool, a runner has to serve that pool, and its
 * agent has to be running. Each of those was visible somewhere, none of them
 * together, and the mismatch is invisible precisely because every individual
 * piece looks fine.
 *
 * So the pool is the row, not the runner: a pool with an environment pointing
 * at it and no runner serving it is a broken configuration that renders as
 * nothing at all on a list of runners.
 *
 * Pure, and everything it needs is passed in — the route does the reading, and
 * the arithmetic is testable without a database.
 */
export function summarisePools(args: {
  runners: readonly PoolFleetMember[];
  environments: readonly { id: string; projectId: string; name: string; runnerPool: string | null }[];
  /**
   * Live job counts per (pool, status) — a `groupBy`, not a page of rows. A
   * `take` here would silently under-count the pool with the most work in it,
   * which is precisely the pool anyone is looking at this screen about.
   */
  jobs: readonly { pool: string | null; status: RunnerJobStatus; count: number }[];
  now?: number;
}): PoolSummary[] {
  const now = args.now ?? Date.now();
  const live = args.runners.filter((r) => !r.revokedAt);

  /*
   * Which pools to show. The union of everything that names one, because each
   * source alone hides a different failure: only-runners hides an environment
   * pointed at a pool nobody serves, only-environments hides a runner sitting
   * in a pool nothing routes to, and only-jobs hides both until a run is
   * already stuck.
   *
   * The default pool (null) appears only when work is actually queued for it —
   * an org with no on-prem environments should not be shown an empty row for a
   * pool it has never used.
   */
  const named = new Set<string>();
  for (const runner of live) for (const pool of runner.pools) named.add(pool);
  for (const environment of args.environments) {
    if (environment.runnerPool) named.add(environment.runnerPool);
  }
  for (const job of args.jobs) if (job.pool && job.count > 0) named.add(job.pool);

  const pools: Array<string | null> = [...named].sort((a, b) => a.localeCompare(b));
  if (args.jobs.some((job) => job.pool === null && job.count > 0)) pools.push(null);

  return pools.map((pool) => {
    const serving = live.filter((r) => servesPool(r.pools, pool));
    const environments = args.environments
      .filter((e) => e.runnerPool === pool)
      .map((e) => ({ id: e.id, projectId: e.projectId, name: e.name }));
    const forPool = args.jobs.filter((job) => job.pool === pool);
    const total = (statuses: readonly RunnerJobStatus[]): number =>
      forPool.reduce((sum, job) => (statuses.includes(job.status) ? sum + job.count : sum), 0);
    const queued = total(['QUEUED']);
    const inFlight = total(['CLAIMED', 'RUNNING']);

    /*
     * Capabilities are deliberately not assessed here. Whether a runner has
     * chromium is a question about a JOB, and answering it at pool level would
     * mean inventing a job that does not exist — so this asks the part that IS
     * a property of the pool: is anyone registered, and is anyone up.
     */
    const state = assessPool({ testTypes: [], browsers: [], toolchains: [] }, pool, live, now);

    const claims = serving
      .map((r) => r.lastClaimAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime());

    return {
      pool,
      code: state.code,
      ready: state.ready,
      online: state.online,
      environments,
      queued,
      inFlight,
      lastClaimAt: claims[0] ?? null,
      runners: serving.map((r) => ({
        id: r.id,
        name: r.name,
        online: isOnline(r.lastSeenAt, now),
        lastSeenAt: r.lastSeenAt,
        lastClaimAt: r.lastClaimAt,
        servesAll: r.pools.length === 0,
      })),
      note: poolNote({
        pool,
        code: state.code,
        online: state.online,
        serving: serving.map((r) => r.name),
        environments: environments.length,
        queued,
        inFlight,
      }),
    };
  });
}

/**
 * The row's sentence.
 *
 * Written so that the FIRST clause is always the thing to fix. A pool that is
 * healthy but that nothing routes to is still a misconfiguration — it is the
 * exact state an operator reaches after registering their first runner and
 * stopping — so it gets said out loud rather than rendering as a reassuring
 * green row.
 */
function poolNote(s: {
  pool: string | null;
  code: PoolReadinessCode;
  online: number;
  serving: string[];
  environments: number;
  queued: number;
  inFlight: number;
}): string {
  const where = s.pool ? `the "${s.pool}" pool` : 'the default pool';
  const routed =
    s.environments === 0
      ? `No environment points at ${where}, so nothing will ever be queued for it — set the pool on an environment to send its runs here.`
      : `${s.environments} environment${s.environments === 1 ? '' : 's'} route${s.environments === 1 ? 's' : ''} here.`;

  switch (s.code) {
    case 'no-runners':
    case 'no-pool-runners':
      return (
        `No runner serves ${where}. ` +
        (s.environments === 0
          ? `Nothing points at it either, so it is inert.`
          : `${s.environments} environment${s.environments === 1 ? '' : 's'} route${s.environments === 1 ? 's' : ''} here, so their runs queue with nobody to claim them and are reported skipped after ${Math.round(RUNNER_UNSERVABLE_GRACE_MS / 60_000)} minutes.`)
      );
    case 'none-online':
      return (
        `None of the ${s.serving.length} runner${s.serving.length === 1 ? '' : 's'} registered for ${where} has checked in within the last minute — ${joinNames(s.serving)}. ` +
        (s.queued > 0
          ? `${s.queued} job${s.queued === 1 ? ' is' : 's are'} waiting on them.`
          : `Nothing is queued, so nothing is stuck yet.`)
      );
    default:
      if (s.queued > 0) {
        return (
          `${s.queued} job${s.queued === 1 ? '' : 's'} waiting and ${s.inFlight} in flight, with ` +
          `${s.online} runner${s.online === 1 ? '' : 's'} online. ${routed}`
        );
      }
      return (
        `${s.online} runner${s.online === 1 ? '' : 's'} online and idle` +
        (s.inFlight > 0 ? `, ${s.inFlight} job${s.inFlight === 1 ? '' : 's'} in flight` : '') +
        `. ${routed}`
      );
  }
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export interface MintedRunnerToken {
  /** Shown to the admin exactly once, then unrecoverable. */
  raw: string;
  hash: string;
  prefix: string;
}

/**
 * Mint a runner token.
 *
 * Hashed, not sealed. The vault exists for secrets we have to hand back to
 * something — an issue tracker PAT, a grid access key — and this is never
 * replayed anywhere: it arrives on a request and is compared. Storing only the
 * hash means a database read gives an attacker nothing that authenticates,
 * which is the same trade `generateApiKey` makes and for the same reason.
 */
export function mintRunnerToken(): MintedRunnerToken {
  const raw = `${RUNNER_TOKEN_PREFIX}${generateToken(32)}`;
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, RUNNER_TOKEN_PREFIX.length + 8) };
}

export function looksLikeRunnerToken(raw: string): boolean {
  return raw.startsWith(RUNNER_TOKEN_PREFIX);
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export interface RunnerSlice {
  /** Null for an unsharded run — the same convention TestResult.shardIndex uses. */
  shardIndex: number | null;
  requirements: JobRequirements;
}

export function dedupeKeyFor(runId: string, shardIndex: number | null): string {
  return `${runId}:${shardIndex ?? 'all'}`;
}

/**
 * Create the jobs for a run that is executing on-prem.
 *
 * Idempotent on `dedupeKey`, which is what makes it safe to call from a retried
 * request, from the repair endpoint, and from `runs.ts` at creation time.
 * `skipDuplicates` rather than an upsert loop: re-offering a job that a runner
 * is already executing would be the double-execution bug this whole module is
 * arranged to prevent.
 *
 * NOTE for whoever wires this into `routes/runs.ts`: a run dispatched here must
 * NOT also be enqueued on `QUEUE_NAMES.run`. Exactly one of the two paths owns a
 * run, and `Run.runnerPool` being non-null is the record of which.
 */
export async function createRunnerJobs(args: {
  orgId: string;
  runId: string;
  pool: string | null;
  slices: readonly RunnerSlice[];
}): Promise<number> {
  const { orgId, runId, pool, slices } = args;
  if (slices.length === 0) return 0;

  const created = await prisma.runnerJob.createMany({
    data: slices.map((slice) => ({
      orgId,
      runId,
      shardIndex: slice.shardIndex,
      dedupeKey: dedupeKeyFor(runId, slice.shardIndex),
      requirements: slice.requirements as unknown as object,
      pool,
    })),
    skipDuplicates: true,
  });

  logger.info({ runId, pool, jobs: created.count }, 'dispatched run to the on-prem pool');
  return created.count;
}

// ─── Claiming, leasing, reaping ──────────────────────────────────────────────

export interface ClaimedJob {
  id: string;
  runId: string;
  shardIndex: number | null;
  /** The fencing token. Every later call by this runner must carry it. */
  leaseId: string;
  leaseExpiresAt: Date;
  attempt: number;
}

/** Statuses that mean a runner currently holds the job. */
const HELD: readonly ('CLAIMED' | 'RUNNING')[] = ['CLAIMED', 'RUNNING'];

function leaseDeadline(from = Date.now()): Date {
  return new Date(from + RUNNER_LEASE_MS);
}

/**
 * Hand the oldest job this runner can actually serve to this runner.
 *
 * The conditional update is the lock, exactly as in `claimShard`: the write
 * matches only while the row is still QUEUED, so of N agents polling at the
 * same instant exactly one gets `count === 1` and the losers move to the next
 * candidate. No advisory lock and no Redis key — the database already
 * serialises this for free.
 *
 * Candidates are filtered in application code rather than SQL because the match
 * is a set-containment question over JSON that Postgres would need a bespoke
 * index to answer, and the queue depth this reads (`take`) is bounded.
 */
export async function claimNextJob(args: {
  orgId: string;
  runnerId: string;
  capabilities: RunnerCapabilities;
  pools: readonly string[];
}): Promise<ClaimedJob | null> {
  const { orgId, runnerId, capabilities, pools } = args;

  // Reclaim before offering. A dead runner's job is the most valuable thing in
  // the queue — it is the one somebody is already waiting on.
  await reapExpiredLeases(orgId);

  const candidates = await prisma.runnerJob.findMany({
    where: { orgId, status: 'QUEUED' },
    orderBy: { queuedAt: 'asc' },
    take: 25,
    select: { id: true, runId: true, shardIndex: true, pool: true, requirements: true },
  });

  for (const candidate of candidates) {
    if (!servesPool(pools, candidate.pool)) continue;
    if (!canServe(parseRequirements(candidate.requirements), capabilities)) continue;

    const leaseId = randomUUID();
    const expires = leaseDeadline();
    const now = new Date();

    const claim = await prisma.runnerJob.updateMany({
      where: { id: candidate.id, status: 'QUEUED' },
      data: {
        status: 'CLAIMED',
        runnerId,
        leaseId,
        leaseExpiresAt: expires,
        claimedAt: now,
        heartbeatAt: now,
        // Counts claims, not retries of a test. A job claimed three times is a
        // job three runners died holding, and offering it forever is how a run
        // hangs for a day instead of reporting that its pool is broken.
        attempt: { increment: 1 },
        errorMessage: null,
      },
    });
    if (claim.count === 0) continue; // another runner won it; try the next

    const claimed = await prisma.runnerJob.findUnique({
      where: { id: candidate.id },
      select: { attempt: true },
    });

    logger.info({ jobId: candidate.id, runnerId, runId: candidate.runId }, 'runner claimed a job');
    return {
      id: candidate.id,
      runId: candidate.runId,
      shardIndex: candidate.shardIndex,
      leaseId,
      leaseExpiresAt: expires,
      attempt: claimed?.attempt ?? 1,
    };
  }

  return null;
}

export function parseRequirements(raw: unknown): JobRequirements {
  if (!raw || typeof raw !== 'object') return { testTypes: [], browsers: [], toolchains: [] };
  const r = raw as Record<string, unknown>;
  const known = new Set<string>(TEST_TYPES);
  return {
    testTypes: Array.isArray(r.testTypes)
      ? r.testTypes.filter((v): v is TestType => typeof v === 'string' && known.has(v))
      : [],
    browsers: stringList(r.browsers),
    toolchains: stringList(r.toolchains),
  };
}

/**
 * Renew a lease, or tell the caller it lost one.
 *
 * The `leaseId` in the where clause is the fence. A runner that was reaped and
 * has come back matches nothing here, gets `false`, and its own loop stops
 * before it writes a single result into work that now belongs to someone else.
 */
export async function renewLease(args: {
  jobId: string;
  leaseId: string;
  running?: boolean;
}): Promise<boolean> {
  const now = new Date();
  const renewed = await prisma.runnerJob.updateMany({
    where: { id: args.jobId, leaseId: args.leaseId, status: { in: [...HELD] } },
    data: {
      ...(args.running ? { status: 'RUNNING' as const, startedAt: now } : {}),
      heartbeatAt: now,
      leaseExpiresAt: leaseDeadline(now.getTime()),
    },
  });
  return renewed.count === 1;
}

/**
 * Assert that the caller still holds this job, and hand back the row.
 *
 * Every write path an agent can reach goes through here first. Losing the race
 * is a 409 rather than a 403: the runner did nothing wrong, the world moved.
 */
export async function requireLease(jobId: string, leaseId: string) {
  const job = await prisma.runnerJob.findUnique({ where: { id: jobId } });
  if (!job || job.leaseId !== leaseId || !HELD.includes(job.status as 'CLAIMED' | 'RUNNING')) {
    throw conflict(
      'That lease is no longer valid — the job was reclaimed or has already finished. ' +
        'Stop work on it and claim another; anything written under the old lease is refused.',
    );
  }
  if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() < Date.now()) {
    throw conflict(
      'That lease expired before this call arrived. The job has been offered to another runner; ' +
        'heartbeat at least every ' +
        `${RUNNER_HEARTBEAT_MS / 1000}s to hold one.`,
    );
  }
  return job;
}

/**
 * Reap jobs whose runner went silent.
 *
 * The rule, stated plainly: **a held job whose lease has expired is given back
 * to the queue, and a job that has burned its attempts is ABANDONED.** Something
 * has to say so, or one crashed agent leaves a run RUNNING forever and the
 * suite it was gating never reports at all.
 *
 * `leaseId: null` on the requeue is not tidiness — it is the fence being
 * dropped. The old agent can still be alive and mid-test; clearing the id is
 * what guarantees its eventual write is refused rather than landing on top of
 * the runner that has since redone the work.
 *
 * The two updates have complementary attempt guards, so a job can never be both
 * requeued and abandoned by the same sweep.
 */
export async function reapExpiredLeases(orgId?: string): Promise<{ requeued: number; abandoned: number }> {
  const now = new Date();
  const scope = orgId ? { orgId } : {};

  const requeued = await prisma.runnerJob.updateMany({
    where: {
      ...scope,
      status: { in: [...HELD] },
      leaseExpiresAt: { lt: now },
      attempt: { lt: prisma.runnerJob.fields.maxAttempts },
    },
    data: {
      status: 'QUEUED',
      leaseId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      startedAt: null,
      errorMessage: `No heartbeat for ${Math.round(RUNNER_LEASE_MS / 1000)}s — the runner holding this work is gone. Re-queued for another runner.`,
    },
  });

  const abandoned = await prisma.runnerJob.updateMany({
    where: {
      ...scope,
      status: { in: [...HELD] },
      leaseExpiresAt: { lt: now },
      attempt: { gte: prisma.runnerJob.fields.maxAttempts },
    },
    data: {
      status: 'ABANDONED',
      leaseId: null,
      finishedAt: now,
      errorMessage:
        'Claimed and dropped by an on-prem runner too many times — every runner that took this work stopped responding. ' +
        'The tests in it did not run. Check the agent logs on those hosts, then re-run.',
    },
  });

  if (requeued.count > 0 || abandoned.count > 0) {
    logger.error(
      { requeued: requeued.count, abandoned: abandoned.count, orgId },
      'reaped on-prem runner jobs whose lease expired',
    );
  }
  return { requeued: requeued.count, abandoned: abandoned.count };
}

/**
 * Release a runner's in-flight work back to the queue.
 *
 * Used by revocation and rotation. Both mean "this agent is no longer allowed
 * to talk to us", and leaving its jobs leased until they time out would strand
 * them for a minute and a half for no reason. Clearing `leaseId` fences the old
 * process out immediately.
 */
export async function releaseRunnerJobs(runnerId: string, why: string): Promise<number> {
  const released = await prisma.runnerJob.updateMany({
    where: { runnerId, status: { in: [...HELD] } },
    data: {
      status: 'QUEUED',
      leaseId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      startedAt: null,
      errorMessage: why,
    },
  });
  return released.count;
}

// ─── Suppression: the SKIP path ──────────────────────────────────────────────

export interface SkippedJob {
  jobId: string;
  runId: string;
  shardIndex: number | null;
  reason: string;
  results: number;
}

/**
 * Skip jobs that nothing in the org can serve, and say what is missing.
 *
 * This is the one place in this module that suppresses a signal, so it is the
 * one place that has to be paranoid:
 *
 *  - It waits `RUNNER_UNSERVABLE_GRACE_MS`. A runner mid-restart is not a
 *    missing runner.
 *  - It skips only on `describeUnservable` returning a reason, which requires
 *    positive evidence that no online runner in the pool can serve the work.
 *  - The status write is conditional on the job still being QUEUED, so a runner
 *    that connected between the read and the write keeps the job.
 *  - Every skip writes an audit row naming the run and the reason. A suppressed
 *    test that nobody can find later is a suppressed test that ships a bug.
 *  - The TestResult rows are stamped with the same sentence, because the person
 *    looking at the run is not the person reading the audit log.
 *
 * Returns what it did so the caller can report it; throwing is left to
 * propagate — a sweep that cannot read the runner table must not conclude that
 * there are none.
 */
export async function skipUnservableJobs(orgId: string, now = new Date()): Promise<SkippedJob[]> {
  const stale = new Date(now.getTime() - RUNNER_UNSERVABLE_GRACE_MS);

  const waiting = await prisma.runnerJob.findMany({
    where: { orgId, status: 'QUEUED', queuedAt: { lt: stale } },
    select: { id: true, runId: true, shardIndex: true, pool: true, requirements: true },
    take: 100,
  });
  if (waiting.length === 0) return [];

  const runners = await prisma.runner.findMany({
    where: { orgId },
    select: {
      id: true,
      name: true,
      pools: true,
      capabilities: true,
      lastSeenAt: true,
      revokedAt: true,
    },
  });

  const skipped: SkippedJob[] = [];

  for (const job of waiting) {
    const reason = describeUnservable(
      parseRequirements(job.requirements),
      job.pool,
      runners,
      now.getTime(),
    );
    if (!reason) continue;

    const claimed = await prisma.runnerJob.updateMany({
      where: { id: job.id, status: 'QUEUED' },
      data: { status: 'SKIPPED', finishedAt: now, errorMessage: reason },
    });
    if (claimed.count === 0) continue; // a runner took it first — good

    /*
     * The tests themselves. SKIPPED, never FAILED: nothing about the
     * application was exercised, and a red build here would send someone
     * hunting a bug that was never observed.
     */
    const marked = await prisma.testResult.updateMany({
      where: {
        runId: job.runId,
        ...(job.shardIndex === null ? {} : { shardIndex: job.shardIndex }),
      },
      data: { status: 'SKIPPED', errorMessage: reason },
    });

    await audit({
      // A sweep has no user behind it; `userId: ''` becomes null and reads as
      // "system" in Settings → Audit log.
      actor: { userId: '', orgId, ip: null, impersonatedBy: null },
      action: 'runner.job.skip',
      targetType: 'RunnerJob',
      targetId: job.id,
      metadata: {
        runId: job.runId,
        shardIndex: job.shardIndex,
        pool: job.pool,
        results: marked.count,
        reason,
      },
    });

    logger.error(
      { jobId: job.id, runId: job.runId, results: marked.count, reason },
      'no on-prem runner could serve a job; skipped',
    );
    skipped.push({
      jobId: job.id,
      runId: job.runId,
      shardIndex: job.shardIndex,
      reason,
      results: marked.count,
    });
  }

  return skipped;
}

// ─── The work itself ─────────────────────────────────────────────────────────

/** One test, as an agent receives it. Shaped like `ExecutableTest` on purpose. */
export interface RunnerTest {
  id: string;
  name: string;
  type: TestType;
  code: string;
  filePath: string;
  spec: unknown;
  timeoutMs: number;
  quarantined: boolean;
  tags: string[];
}

export interface JobAssignment {
  jobId: string;
  leaseId: string;
  runId: string;
  shardIndex: number | null;
  attempt: number;
  /** Seconds until the lease lapses, so the agent can size its own timer. */
  leaseSeconds: number;
  heartbeatSeconds: number;
  projectId: string;
  environment: { id: string; name: string; baseUrl: string };
  tests: RunnerTest[];
  /**
   * Environment secrets, decrypted.
   *
   * They have to travel: a login test cannot log in without them, and the whole
   * premise is that the agent — not us — can reach the application. The channel
   * is TLS to a host the agent pinned at startup, authenticated by a token
   * scoped to this org, and this payload is never logged, never audited and
   * never written to an artifact. It is the highest-value thing this API
   * returns, which is why the runner token is worth revoking properly.
   */
  secrets: Record<string, string>;
  fixtures: Record<string, string>;
  determinism: { randomSeed: number; waitForNetworkIdle: boolean; retryOnce: boolean };
}

/**
 * Everything the claimed slice needs to execute, read fresh.
 *
 * Ids, then a re-read — the same rule the queue payloads follow. A job can sit
 * in the queue for an hour, and an agent that acted on a snapshot taken at
 * dispatch would run tests that have since been disabled or edited.
 */
export async function buildAssignment(
  orgId: string,
  claim: ClaimedJob,
): Promise<JobAssignment | null> {
  const run = await prisma.run.findFirst({
    where: { id: claim.runId, orgId },
    select: {
      id: true,
      projectId: true,
      baseUrlOverride: true,
      environment: { select: { id: true, name: true, baseUrl: true } },
      results: {
        where: claim.shardIndex === null ? {} : { shardIndex: claim.shardIndex },
        select: { test: true },
      },
    },
  });
  if (!run) return null;

  const secretRows = await prisma.secret.findMany({
    where: { environmentId: run.environment.id },
    select: { name: true, valueEnc: true, keyVersion: true },
  });
  const secrets: Record<string, string> = {};
  for (const row of secretRows) {
    try {
      secrets[row.name] = openSecret(row.valueEnc, row.keyVersion, orgId, row.name);
    } catch (err) {
      // One unreadable secret must not cost the whole run its other twenty.
      // The test that needed it fails on its own terms, with its own message.
      logger.error({ err, secret: row.name }, 'could not decrypt a secret for an on-prem runner');
    }
  }

  const fixtureRows = await prisma.test.findMany({
    where: { projectId: run.projectId, disabledAt: null, filePath: { startsWith: 'fixtures/' } },
    select: { filePath: true, code: true, spec: true },
  });

  return {
    jobId: claim.id,
    leaseId: claim.leaseId,
    runId: run.id,
    shardIndex: claim.shardIndex,
    attempt: claim.attempt,
    leaseSeconds: Math.round(RUNNER_LEASE_MS / 1000),
    heartbeatSeconds: Math.round(RUNNER_HEARTBEAT_MS / 1000),
    projectId: run.projectId,
    environment: {
      id: run.environment.id,
      name: run.environment.name,
      baseUrl: run.baseUrlOverride ?? run.environment.baseUrl,
    },
    tests: run.results.map((result) => ({
      id: result.test.id,
      name: result.test.name,
      type: result.test.type,
      code: result.test.code,
      filePath: result.test.filePath,
      spec: result.test.spec,
      timeoutMs: result.test.timeoutMs,
      quarantined: result.test.quarantined,
      tags: result.test.tags,
    })),
    secrets,
    fixtures: Object.fromEntries(
      fixtureRows.map((row) => [
        row.filePath,
        row.spec !== null && row.spec !== undefined ? JSON.stringify(row.spec, null, 2) : row.code,
      ]),
    ),
    determinism: {
      // Seeded from the run id, exactly as the cloud path seeds it, so an
      // on-prem re-run of the same run reproduces the same synthetic data.
      randomSeed: [...run.id].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7),
      waitForNetworkIdle: true,
      retryOnce: true,
    },
  };
}

/** Artifact retention for an org's plan, so an on-prem artifact expires like any other. */
export function retentionDaysFor(plan: string): number {
  return PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS]?.artifactRetentionDays ?? 30;
}

// ─── Finalisation ────────────────────────────────────────────────────────────

/**
 * The TypeScript twin of the `RunnerJobStatus` Prisma enum.
 *
 * Deliberately here rather than in `@qaai/shared`, and therefore deliberately
 * absent from the PAIRS list in `apps/api/scripts/check-enums.ts`: nothing
 * outside this module and its router reads a runner-job status, so a shared
 * mirror would be a second definition to keep in sync for no consumer. Add both
 * if the cockpit ever renders the queue.
 */
export type RunnerJobStatus =
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ABANDONED'
  | 'SKIPPED';

/**
 * A job that will not execute another test.
 *
 * The same definition the sharded run's completion rule needs, for the same
 * reason `RUN_SHARD_TERMINAL` is exported rather than re-listed at each call
 * site: two lists that disagree is how "the run passed while shard 3 was still
 * running" gets shipped.
 */
export const TERMINAL_JOB: readonly RunnerJobStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ABANDONED',
  'SKIPPED',
];

/**
 * Finalise every on-prem run whose jobs are all done but which never reported.
 *
 * The gap this closes: `finalizeIfComplete` normally runs off an agent's
 * `complete` call, and the last job of a run does not always end that way. A
 * job ABANDONED by the reaper, or SKIPPED by the unservable sweep, becomes
 * terminal without anybody calling anything — and if it was the last one, the
 * run sits RUNNING forever with a verdict nobody will ever write. That is a
 * reporting problem losing a run, which is the one outcome this codebase does
 * not accept.
 *
 * Cheap enough to run on every sweep: one indexed, distinct query that returns
 * nothing in the normal case.
 */
export async function finalizePendingRuns(orgId: string, limit = 25): Promise<number> {
  const pending = await prisma.runnerJob.findMany({
    where: { orgId, status: { in: [...TERMINAL_JOB] }, run: { finalizedAt: null } },
    select: { runId: true },
    distinct: ['runId'],
    take: limit,
  });

  let finalized = 0;
  for (const row of pending) {
    // Per-run catch: one run that cannot finalise must not strand the others.
    const done = await finalizeIfComplete(orgId, row.runId).catch((err: unknown) => {
      logger.error({ err, runId: row.runId }, 'could not finalise a stalled on-prem run');
      return false;
    });
    if (done) finalized += 1;
  }
  return finalized;
}

/**
 * Write an on-prem run's terminal state, once, when every job is done.
 *
 * The cloud path gets this for free: the worker that finishes the last shard
 * calls `finalizeRun`. Nothing on this path runs in our process at all, so the
 * rule has to live where the agents' calls land — and it is the same rule, with
 * the same tiebreak. **A run is finished when EVERY job is finished, never
 * before**, and the conditional UPDATE on `finalizedAt` matches only while the
 * column is null, so of two agents completing at the same instant exactly one
 * writes the verdict.
 *
 * Never throws into the caller's response. A completion that succeeded and then
 * failed to finalise must not be reported to the agent as a failure — it would
 * retry, and the retry cannot help. The run is left for the next completion or
 * the sweep to finalise, which is the "a reporting problem must never lose a
 * run" rule applied to the only place it can go wrong here.
 */
export async function finalizeIfComplete(orgId: string, runId: string): Promise<boolean> {
  const jobs = await prisma.runnerJob.findMany({
    where: { runId },
    select: { status: true, errorMessage: true },
  });
  if (jobs.length === 0) return false;
  if (!jobs.every((j) => TERMINAL_JOB.includes(j.status))) return false;

  // The claim. Losing it means a sibling is already writing the verdict.
  const claim = await prisma.run.updateMany({
    where: { id: runId, finalizedAt: null },
    data: { finalizedAt: new Date() },
  });
  if (claim.count === 0) return false;

  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      trigger: true,
      prNumber: true,
      project: { select: { gateRules: true } },
    },
  });
  if (!run) return false;

  const results = await prisma.testResult.findMany({
    where: { runId },
    include: {
      test: { select: { name: true, priority: true, quarantined: true } },
      verdict: { select: { verdict: true, overriddenTo: true, reviewState: true } },
    },
  });

  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const result of results) {
    if (result.status === 'PASSED') counts.passed += 1;
    else if (result.status === 'FLAKY') counts.flaky += 1;
    else if (result.status === 'SKIPPED') counts.skipped += 1;
    else counts.failed += 1;
  }

  const rules = Array.isArray(run.project.gateRules) && run.project.gateRules.length > 0
    ? (run.project.gateRules as unknown as GateRule[])
    : DEFAULT_GATE_RULES;

  const gateResult = evaluateGates(rules, {
    results: results.map((r) => ({
      testId: r.testId,
      testName: r.test.name,
      status: r.status,
      priority: r.test.priority,
      quarantined: r.test.quarantined,
      retriedAndPassed: r.retriedAndPassed,
      verdict:
        r.verdict?.reviewState === 'OVERRIDDEN'
          ? (r.verdict.overriddenTo ?? r.verdict.verdict)
          : (r.verdict?.verdict ?? null),
      durationMs: r.durationMs,
    })),
  });

  /*
   * Two shapes of "nothing was tested", and both must go out red.
   *
   * A run whose jobs were all SKIPPED executed no tests at all — the pool could
   * not serve them — and a suppressed signal that reports PASSED is a green
   * build over an untested application, which is the worst outcome this product
   * can produce. An ABANDONED job is the same thing by a different route: a
   * runner took the work and died with it.
   *
   * SKIPPED is still the right status for the JOB and for its tests (nothing
   * failed, and nothing about the application was learned). It is the RUN that
   * has to be honest about having no verdict.
   */
  const abandoned = jobs.filter((j) => j.status === 'ABANDONED');
  const skipped = jobs.filter((j) => j.status === 'SKIPPED');
  const nothingRan = skipped.length === jobs.length;

  const status =
    abandoned.length > 0 || nothingRan
      ? ('ERRORED' as const)
      : counts.failed > 0 || !gateResult.passed
        ? ('FAILED' as const)
        : ('PASSED' as const);

  const errorMessage =
    [...abandoned, ...skipped]
      .map((j) => j.errorMessage)
      .filter((m): m is string => !!m)
      .join(' ')
      .slice(0, 2_000) || null;

  await prisma.run.update({
    where: { id: runId },
    data: {
      status,
      finishedAt: new Date(),
      passedCount: counts.passed,
      failedCount: counts.failed,
      flakyCount: counts.flaky,
      skippedCount: counts.skipped,
      // Prisma Json input needs an index signature; a typed interface has none.
      gateResult: gateResult as unknown as object,
      errorMessage,
    },
  });

  // Fire and forget, both of them: a notification that cannot be enqueued must
  // never un-finalise a run that has already reported.
  await enqueue(QUEUE_NAMES.notify, {
    orgId,
    event: 'run.finished',
    payload: { runId, ...(run.prNumber ? { prNumber: run.prNumber } : {}) },
  }).catch((err) => logger.warn({ err, runId }, 'could not enqueue the on-prem run notification'));

  publish(orgId, {
    runId,
    type: 'run.finished',
    data: { status, ...counts, gatePassed: gateResult.passed, onPrem: true },
    at: new Date().toISOString(),
  });

  logger.info({ runId, status, ...counts }, 'on-prem run finished');
  return true;
}
