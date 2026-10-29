/**
 * Run processor (§5) — the heart of execution.
 *
 * Executes each test in a run through its plugin, persists results, artifacts,
 * steps and findings, updates the flake radar, enqueues triage for every
 * failure, and evaluates the quality gates.
 *
 * Ordering matters at the end: gates are evaluated *after* triage has been
 * enqueued but scored on the verdicts that exist at finalisation. A run whose
 * triage is still in flight reports its gate as provisional rather than
 * blocking a merge on a verdict nobody has produced yet.
 *
 * ── Sharding ────────────────────────────────────────────────────────────────
 * A job may carry a `shard`, in which case it executes only the slice of tests
 * routed to that shard (`TestResult.shardIndex`) and hands finalisation to the
 * distributed rule in `completeShardedRun` below. A job WITHOUT a shard — every
 * run from a schedule, a monitor, or a caller who did not ask — runs the whole
 * suite and finalises inline, exactly as it did before sharding existed. That
 * split is deliberate: the unsharded path touches no new table, so a sharding
 * bug cannot reach a run that never asked to be sharded.
 */

import {
  emptyRunCounts,
  environmentBlock,
  environmentPreflight,
  evaluateGates,
  preflightSummary,
  quarantineSuppresses,
  reasonUnsupported,
  repoWorkspaceCheck,
  runnabilityFor,
  runOutcome,
  signInWithProfile,
  tallyResult,
  unattemptable,
  /*
   * The quarantine classification and the cap it reads, both imported rather
   * than restated. This file used to carry its own copy of each: the four rules
   * (expired, expiring soon, unbounded-and-old-enough-to-be-news) were written
   * out here and again in gates.ts for the post-triage re-score, and a
   * re-scored gate that disagreed with finalisation about "expiring soon" would
   * be a green-wash performed by the code that exists to stop one.
   */
  quarantineHealthFrom,
  QUARANTINE_NAMES_SCANNED,
} from '@qaai/runner';
import type {
  QuarantineHealthInput,
  RequiredIdentity,
  RunCountsWithQuarantine,
  SessionProbeResult,
} from '@qaai/runner';
import type { SuppressionKind, SuppressionTally } from '@qaai/shared';
import { loadProjectPlugins, resolveTestPlugin } from '../lib/plugin-loading.js';
import {
  testNeedsRepository,
  materialiseRepoWorkspace,
  repoUnavailableMessage,
  type MaterialisedWorkspace,
} from '../repo-materialise.js';
/*
 * Imported by path rather than from '@qaai/runner': these live in the runner
 * package but not on its `index.ts` barrel, which this change does not own.
 * The worker already reaches into a sibling workspace the same way — see the
 * GitHub App import in processors/checks.ts.
 */
import {
  attachAuthProfile,
  attachRunWorkspace,
} from '../../../../packages/runner/src/run-workspace.js';
import {
  FIXTURE_PREFIX,
  GRID_INTEGRATION_KINDS,
  RUN_SHARD_TERMINAL,
  UNVARIED,
  environmentUnavailableMessage,
  environmentUnavailableReason,
  notRunMessage,
  parseNotRun,
  planMeasurements,
  testMetricSchema,
  /*
   * The variant validator, which now carries the per-cell evidence too.
   *
   * `testResultVariantCellSchema` existed, with both its pairings, and NOTHING
   * CALLED IT — which is why `matrixCell`, `cellStatus`, `cellRemedy`,
   * `notAsserted` and `notAssertedReason` were five NULLs for ever. It is
   * reached from here still, but THROUGH this schema rather than beside it:
   * `testResultVariantSchema.cell` references it, so one parse admits the
   * evidence on BOTH ingest paths — this one and the on-prem agent's in
   * apps/api/src/routes/runners.ts, which is built from the same validator and
   * which silently dropped the field while this file read around it.
   */
  testResultVariantSchema,
  variantKeyOf,
} from '@qaai/shared';
import type {
  GridIntegrationKind,
  MeasuredVariant,
  MeasurementPlan,
  NotRunKind,
  RunShardRef,
  TestMetric,
} from '@qaai/shared';
import { gridWsEndpoint } from '../grids.js';
import { open as openSecret } from '../vault.js';
import type {
  ExecutableTest,
  GateResult,
  GateRule,
  MutationRunData,
  RunContext,
  ShardedRunJob,
  TestExecution,
  TestResultStatus,
  TestType,
} from '@qaai/shared';
import { DEFAULT_GATE_RULES } from '@qaai/runner';
import { artifactKey } from '@qaai/storage';
import { logger, prisma, publishEvent, storage } from '../context.js';
import { secretsFor } from '../vault.js';
import { enqueueNotify, enqueueTriage } from '../queues.js';
/*
 * `failFastTripped` and `failFastStopReason` are imported rather than restated,
 * and that is the whole point of taking them from here: the 60-second sweep in
 * schedule.ts and the inline check in this loop write the SAME column, so a
 * second copy of "does this failure trip fail-fast" would be two writers able
 * to disagree about whether a run should have stopped — and the sentence on
 * `Run.stopReason` is read verbatim by three surfaces, so there must be exactly
 * one of it.
 */
import { failFastStopReason, failFastTripped, recordMonitorResult } from './schedule.js';

/** Retention window per plan (§5); the sweeper deletes past this. */
const RETENTION_DAYS: Record<string, number> = {
  FREE: 7,
  TEAM: 30,
  BUSINESS: 90,
  ENTERPRISE: 365,
};

/*
 * How many quarantined tests the rot alarm names used to be declared here, as
 * its own `const QUARANTINE_NAMES_SCANNED = 200`. It is now imported from
 * @qaai/runner beside `quarantineHealthFrom`, because the cap and the
 * classification have to travel together: this finaliser and the post-triage
 * re-score both build a `QuarantineHealthInput`, and two callers reading
 * different numbers of names is how one of them comes to report a different set
 * of warnings about the same suite.
 */

/**
 * How many recent results one flake-rate measurement is computed over.
 *
 * Was a bare `50` inside `updateFlakeStats`. Named because it is now the
 * DENOMINATOR a stored trend point carries (`TestFlakeHistory.sampleSize`), and
 * a trend whose window silently changed between two points is not a trend.
 */
const FLAKE_WINDOW = 50;

/** How often a running shard stamps `heartbeatAt`. */
const SHARD_HEARTBEAT_MS = 30_000;

/**
 * How long a shard may go without a heartbeat before its siblings declare it
 * dead. Ten missed beats: long enough to ride out a paused event loop or a
 * database blip, short enough that a genuinely dead worker does not hold a run
 * open for the rest of the afternoon.
 *
 * The heartbeat runs on a timer rather than after each test on purpose — a
 * load test can legitimately execute for twenty minutes, and a per-test stamp
 * would have its siblings reap a shard that is working perfectly.
 */
const STALE_SHARD_MS = 5 * 60_000;

/**
 * How long a shard may sit QUEUED before the sweep declares its job lost.
 *
 * ── The rule, stated plainly ────────────────────────────────────────────────
 * **A shard that has been QUEUED for more than two hours is declared ABANDONED
 * by the scheduler sweep, and only by the scheduler sweep.**
 *
 * Two hours is not a guess at how long a queue is; it is a deliberate refusal
 * to guess. A queued shard is the NORMAL state on a busy pool — four workers
 * and fifteen shards means the last one waits for the first eleven, and a load
 * test in front of it can legitimately execute for twenty minutes. There is no
 * signal that distinguishes "waiting its turn" from "its job no longer exists",
 * because a lost job leaves nothing behind to look at: BullMQ's queue is the
 * only record that it was ever enqueued, and a flushed Redis takes that with
 * it. All that is left is age.
 *
 * So the threshold is set where the two errors stop being symmetrical. Reaping
 * too early throws away tests that were about to run and reports a run as
 * ERRORED that would have passed — the worst outcome this product can produce.
 * Reaping too late costs a stuck run some extra hours of being stuck. At two
 * hours a shard is either behind a backlog so deep that its verdict is already
 * worthless, or its job is genuinely gone; and the reap does not destroy
 * anything, because the run finalises ERRORED naming the shard and a human
 * re-runs it. Nothing is silently skipped: an abandoned shard can never let a
 * run report PASSED.
 *
 * It is deliberately more than twenty times STALE_SHARD_MS. A missing heartbeat
 * is positive evidence that a worker died; sitting in a queue is evidence of
 * nothing, so it takes far longer to act on.
 */
const STALE_QUEUED_SHARD_MS = 2 * 60 * 60_000;

/**
 * The run's tallies. Owned by `@qaai/runner` rather than declared here, because
 * this file declaring its own four-field shape is how `counts.failed` came to
 * mean something different from what the gate meant by a failure.
 *
 * `quarantinedFailed` is the fourth category: a failure a quarantine in force
 * suppressed. It is counted and reported, and it never reaches `failed`, so it
 * can never reach the run's status, the CLI's exit code or the GitHub check.
 */
type RunCounts = RunCountsWithQuarantine;

/**
 * ── The environment rule, stated once ───────────────────────────────────────
 *
 * **A test QAAI could not attempt is never reported as a pass and never as a
 * failure of the application. A run in which NOTHING could be attempted is
 * neither a green build nor a red one: it is ERRORED, with
 * ENVIRONMENT_UNAVAILABLE and a BLOCKing gate evaluation, because there is no
 * verdict to be had and nothing may merge on the strength of one.**
 *
 * Three cases, three different reports, and the whole point is that they stop
 * being the same report:
 *
 *  1. NOTHING COULD BE ATTEMPTED (the base URL is down, the only login is
 *     broken, the one type in the suite has no tool on this image). Every
 *     result is `[BLOCKED_BY_ENV]`/`[UNSUPPORTED]` with the reason, no test is
 *     executed, the run is ERRORED, the gate BLOCKs, and `Run.errorMessage`
 *     opens with ENVIRONMENT_UNAVAILABLE. Previously: N failing tests, a red
 *     board, a poisoned pass rate and a poisoned coverage number, with the
 *     cause nowhere.
 *
 *  2. SOME TESTS WERE BLOCKED. The rest execute and report normally; the
 *     blocked ones are not-run with their reason and a WARN evaluation names
 *     them. Deliberately a WARN and not a BLOCK: a suite in which one role's
 *     password rotated still has 400 tests worth of signal, and holding every
 *     merge on that is how a brake gets switched off. The gap this leaves is
 *     named in the report rather than pretended away — a run CAN still report
 *     PASSED with tests nobody ran, and the honest fix is a configurable
 *     `MIN_ATTEMPTED_RATE` gate rule, which belongs in gates.ts.
 *
 *  3. EVERY GATING FAILURE WAS TRIAGED ENV_ISSUE. The run is ERRORED rather
 *     than FAILED, so a board red from an expired credential stops looking
 *     exactly like a board red from a bug. The counts are NOT rewritten: the
 *     five columns still sum to the number of results, and `failedCount` still
 *     says three tests failed, because they did — what changes is that the run
 *     says the environment was the cause instead of implying the code was.
 */

/**
 * A gate evaluation about the ENVIRONMENT, rather than about the tests.
 *
 * No cast. `ENVIRONMENT_AVAILABLE` is a member of the shared `GateRule` union
 * now, so a typo in this object fails to compile instead of typechecking its
 * way into a stored gate result. The DETAIL still carries the whole message,
 * because that is what every surface actually renders (`blockingGateRules` in
 * processors/notify.ts reads `detail`, the GitHub check summary prints it, the
 * CLI prints it).
 *
 * It rides the gate result rather than a new notification channel for the
 * reason gates.ts gives for the quarantine alarm: a gate evaluation already
 * reaches the chat alert, the check summary, the CLI's BLOCK lines and the run
 * page's gate chip, through plumbing that is already tested. A fifth channel
 * nobody subscribes to is how PAGERDUTY ended up in the Prisma enum and
 * nowhere else.
 */
const ENVIRONMENT_GATE_RULE = (action: 'WARN' | 'BLOCK'): GateRule => ({
  kind: 'ENVIRONMENT_AVAILABLE',
  action,
});

/**
 * Opening words of `Run.errorMessage` on a run THIS DEPLOYMENT could not
 * attempt, as opposed to one the environment made impossible.
 *
 * ── The misattribution this exists to end ───────────────────────────────────
 *
 * `ENVIRONMENT_UNAVAILABLE` is documented in @qaai/shared as meaning "a run the
 * environment made impossible", and until now it was also what a run of two
 * LOAD tests on a worker image with no k6 reported. The rows were tagged
 * `[UNSUPPORTED]` correctly and the gate detail correctly said "install the
 * missing tool on the worker", but the one MACHINE-READABLE run-level fact
 * named the customer's environment for a hole in ours. preflight.ts says the
 * conflation is the design's central error, in these words: "install k6" is
 * useless advice for a down staging box and "check your VPN" is useless advice
 * for a worker image that never had Lighthouse in it.
 *
 * ── Why a second prefix and not a field ─────────────────────────────────────
 *
 * For the reason @qaai/shared gives for the first one: `RunStatus` is a
 * Postgres enum every consumer switches on exhaustively, so the KIND rides on
 * `errorMessage` and the sentence after it is complete English. The cost is the
 * same cost, stated there and inherited here: a prefix on a free-text column
 * cannot be filtered in SQL.
 *
 * ── Why it is declared HERE and not beside its sibling ──────────────────────
 *
 * packages/shared/src/constants.ts is not this change's file. Nothing outside
 * this module reads either marker today (`environmentUnavailableReason` has
 * exactly one caller, below), so a local declaration is reachable by everything
 * that needs it. It belongs next to `ENVIRONMENT_UNAVAILABLE_PREFIX` with its
 * own reader the moment a surface wants to tell the two apart — see the
 * handover.
 */
const TOOLING_UNAVAILABLE_PREFIX = 'TOOLING_UNAVAILABLE:';

/**
 * The run-level message for a slice nothing could be attempted in.
 *
 * The KIND decides the marker, and it is the per-test kind the preflight
 * already produced rather than a second judgement: `UNSUPPORTED` means every
 * blocked test was blocked by something missing on this image, and anything
 * else means the thing under test is implicated. A mixed run reports the
 * environment, because the environment IS implicated in it.
 */
function runGapMessage(kind: NotRunKind, reason: string): string {
  return kind === 'UNSUPPORTED'
    ? `${TOOLING_UNAVAILABLE_PREFIX} ${reason}`
    : environmentUnavailableMessage(reason);
}

/**
 * Read a run-level gap marker back off a stored message, or null for a message
 * that carries neither.
 *
 * Null is the honest answer for a shard that died holding the job, a vault key
 * that rotated, or anything else that is not a gap: `completeShardedRun` uses
 * exactly that to refuse to hoist a marker onto a run that failed for two
 * different reasons.
 */
function runGapReason(
  errorMessage: string | null | undefined,
): { kind: NotRunKind; reason: string } | null {
  const environment = environmentUnavailableReason(errorMessage);
  if (environment !== null) return { kind: 'BLOCKED_BY_ENV', reason: environment };
  if (typeof errorMessage === 'string' && errorMessage.startsWith(TOOLING_UNAVAILABLE_PREFIX)) {
    return {
      kind: 'UNSUPPORTED',
      reason: errorMessage.slice(TOOLING_UNAVAILABLE_PREFIX.length).trim(),
    };
  }
  return null;
}

/** One row of a `GateResult`. Named locally because nothing exports the element type. */
type GateResultEvaluation = GateResult['evaluations'][number];

/** How many blocked tests an environment gate detail names before it counts. */
const ENVIRONMENT_NAMES_LISTED = 3;

export async function processRun(job: ShardedRunJob): Promise<void> {
  const { orgId, runId } = job;
  const shard: RunShardRef | null = job.shard ?? null;

  /*
   * Refuse a job that does not say WHICH run, before touching the database.
   *
   * `failRunFromDeadJob` below carries the same guard and the same reasoning,
   * but this is the call site where it matters more. Prisma reads an undefined
   * `where` value as an ABSENT FILTER, not an impossible one — so
   * `findFirst({ where: { id: undefined, orgId: undefined } })` does not return
   * null, it returns the first Run in the table, belonging to whichever tenant
   * happens to sort first. This function would then mark that run RUNNING,
   * open a browser, and execute somebody else's suite against somebody else's
   * environment — production included — while publishing events on an
   * undefined org channel.
   *
   * The payload reaches here through `as unknown as RunJob` on a BullMQ job, so
   * the type system is not checking it and cannot: the only thing standing
   * between a malformed producer and a cross-tenant run is this line.
   */
  if (!orgId || !runId) {
    logger.error({ orgId, runId }, 'run job carried no org or run id; refusing to execute');
    throw new Error('Run job is missing orgId or runId; refusing to execute an unscoped run');
  }

  const run = await prisma.run.findFirst({
    where: { id: runId, orgId },
    include: {
      /*
       * `kind` is read for `SignInContext.environmentKind`, which is required
       * with no default: `signInWithProfile` refuses MOCK_IDP on PRODUCTION —
       * minting an assertion against a real system is forging a real identity
       * — and a refusal that depends on a caller remembering an argument is not
       * a refusal. Same reason explore.ts selects it.
       */
      environment: { select: { id: true, baseUrl: true, kind: true } },
      project: {
        select: {
          id: true,
          gateRules: true,
          // The cap on how much of this suite may stop gating. Read with the
          // gate rules because it IS one: see evaluateQuarantineHealth.
          quarantineBudgetPercent: true,
          // The connected repository: what a repo-dependent test executes
          // inside. See repo-materialise.ts.
          repoFullName: true,
          repoInstallationId: true,
          defaultBranch: true,
        },
      },
      // A shard executes only its own slice. An unsharded job passes no filter
      // and gets every result, which is the whole suite.
      results: { where: shard ? { shardIndex: shard.index } : {}, include: { test: true } },
    },
  });
  if (!run) throw new Error(`Run ${runId} not found for org ${orgId}`);

  /*
   * Cancelled before this job was ever picked up, which is the NORMAL case: the
   * pool is busy, the run sits QUEUED, and a busy pool is exactly when people
   * reach for Cancel. The API wrote CANCELLED and the cockpit already said "Run
   * cancelled before it started"; executing the suite now would make a liar of
   * both — and would drive a browser at whatever environment the run was
   * pointed at, production included. Bailing here (rather than only at the
   * conditional start below) also means the job costs nothing: no vault reads,
   * no fixture load, no grid session.
   */
  if (run.status === 'CANCELLED') {
    logger.info(
      { runId: run.id, shard: shard?.index },
      'run was cancelled before this job started; not executing',
    );
    return;
  }

  /*
   * A shard that arrives after the run has already been declared finished — a
   * redelivered job, or one whose slice was reaped as abandoned — must not
   * execute. Its results would land under a run that has already reported its
   * verdict, notified a pull request and released a merge.
   */
  if (shard && run.finalizedAt) {
    logger.warn(
      { runId: run.id, shard: shard.index, finalizedAt: run.finalizedAt },
      'shard job arrived after the run was finalised; not executing',
    );
    return;
  }

  if (shard && !(await claimShard(orgId, run.id, shard))) return;

  const controller = new AbortController();
  const counts: RunCounts = emptyRunCounts();
  let runErrored: string | null = null;
  let cancelled = false;
  /*
   * Assigned inside the try, declared out here so the finally can always stop
   * it. Everything below — the grid endpoint, the vault, the fixtures, the auth
   * profile — used to run OUTSIDE the try. Anything it threw escaped the
   * processor entirely: the run sat at QUEUED/RUNNING for good, its elapsed
   * clock never started, its gate never resolved, and no `run.finished`
   * notification was enqueued, so the Slack message and the PR comment simply
   * never arrived. One rotated vault key stranded every run in an org that way.
   * Setup lives inside the try now, so a failure in it takes the same path a
   * broken test does and the run finalises ERRORED with the reason on it.
   */
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  /*
   * The run's checkout of the customer's repository, and the reason there is
   * none. Declared out here for the same reason the heartbeat is: the `finally`
   * must be able to delete the workspace on EVERY exit — a clean finish, a
   * cancel that breaks out of the loop, and a throw from anywhere in setup or
   * the suite. A tree left behind on a shared worker is both a disk leak and
   * one tenant's source code sitting on disk after their run ended.
   */
  let repoWorkspace: MaterialisedWorkspace | null = null;
  let repoGap: string | null = null;
  /*
   * The preflight's answer, and — separately — whether it concluded that
   * nothing in this run could be attempted. Declared out here because the
   * finalisation below the try has to be able to say so: a run that was never
   * attempted must not fall through to the ordinary pass/fail verdict, which
   * over a suite of untouched placeholder rows would compute PASSED.
   */
  let preflight: PreflightDecision | null = null;
  /**
   * Why nothing in this slice could be attempted, and WHICH KIND of gap it was.
   *
   * A string used to be enough because there was one answer: the environment.
   * It is a kind and a sentence now because the two causes need different
   * people — `UNSUPPORTED` is somebody installing a tool on this image,
   * `BLOCKED_BY_ENV` is somebody fixing the thing under test — and the run-level
   * message is the only machine-readable place that distinction could live.
   */
  let runGap: { kind: NotRunKind; why: string } | null = null;
  /**
   * The sentence on `Run.stopReason` when something asked this run to stop
   * early, read by the poll below.
   *
   * Separate from `cancelled` on purpose, and that separation is the feature:
   * `Run.stopRequestedAt` is documented as NOT being a cancel — a fail-fast
   * stop is a FAILED run that chose not to finish — so filing it as CANCELLED
   * would hide a broken build behind a word that means "nobody wanted the
   * answer", and would rewrite the counts off the result rows as a cancel does.
   */
  let stopRequested: string | null = null;

  try {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { plan: true },
    });
    const retentionDays = RETENTION_DAYS[org.plan] ?? 30;
    const expiresAt = new Date(Date.now() + retentionDays * 86_400_000);

    const baseUrl = run.baseUrlOverride ?? run.environment.baseUrl;
    const secrets = await secretsFor(orgId, run.environment.id);

    // Test data lives as Test rows under `fixtures/`; every workspace gets a copy
    // so a spec can read its data off disk. Loaded once per run, not per test.
    const fixtureRows = await prisma.test.findMany({
      where: {
        orgId,
        projectId: run.projectId,
        // Matches the export's filter, so the workspace and a pushed repo can never
        // disagree about which fixtures exist.
        disabledAt: null,
        filePath: { startsWith: FIXTURE_PREFIX },
      },
      select: { filePath: true, code: true, spec: true },
    });
    const fixtures = Object.fromEntries(
      fixtureRows.map((row) => [
        row.filePath,
        // A fixture edited as JSON is stored in `spec`; anything else keeps its raw
        // text in `code`. Prefer whichever actually holds content.
        row.spec !== null && row.spec !== undefined ? JSON.stringify(row.spec, null, 2) : row.code,
      ]),
    );

    /**
     * A configured cloud grid moves the browser off this machine (§6). The
     * endpoint carries the provider's access key, so it is built here from the
     * vault and kept in memory — never logged, never written to an exported repo.
     */
    let grid: { provider: string; wsEndpoint: string } | null = null;
    const gridIntegration = await prisma.integration.findFirst({
      where: { orgId, enabled: true, kind: { in: [...GRID_INTEGRATION_KINDS] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, config: true, configEnc: true },
    });
    if (gridIntegration?.configEnc) {
      try {
        const cfg = (gridIntegration.config ?? {}) as {
          username?: string;
          keyVersion?: number;
          os?: string;
          browser?: string;
          browserVersion?: string;
        };
        const accessKey = openSecret(
          gridIntegration.configEnc,
          cfg.keyVersion ?? 1,
          orgId,
          `integration:${gridIntegration.id}`,
        );
        grid = {
          provider: gridIntegration.kind,
          wsEndpoint: gridWsEndpoint(
            gridIntegration.kind as GridIntegrationKind,
            { username: cfg.username ?? '', accessKey },
            {
              os: cfg.os,
              browser: cfg.browser,
              browserVersion: cfg.browserVersion,
              buildName: `QAAI ${run.id.slice(-8)}`,
              sessionName: `QAAI run ${run.id.slice(-8)}`,
            },
          ),
        };
        logger.info({ provider: gridIntegration.kind }, 'running on a cloud grid');
      } catch (err) {
        // A broken grid config must not silently fall back to a local browser —
        // the customer asked for Safari on Windows and would get Chromium here.
        throw new Error(
          `Cloud grid ${gridIntegration.kind} is configured but its credentials could not be used: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
          // The message says what broke; the cause says which of the vault open,
          // the key version lookup or the endpoint build actually threw. That
          // stack is the whole diagnosis, and this error ends up in a run's
          // errorMessage being read by someone who was not here when it happened.
          { cause: err },
        );
      }
    }

    /*
     * ── The run's DEFAULT identity ───────────────────────────────────────────
     *
     * The first auth profile on the environment, exactly as before, and it
     * still does NOT log in: a test that named no profile claimed no role, so
     * running it with whatever cached session exists (or none) is honest, and
     * driving a browser login at the start of every run would be a new cost
     * every existing run pays. Its id is read now as well as its state, so a
     * test that explicitly names the default profile is satisfied BY the
     * default rather than logging in a second time for the same identity.
     */
    const authProfile = await prisma.authProfile.findFirst({
      where: { orgId, environmentId: run.environment.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, storageState: true, storageStateExpiresAt: true },
    });
    const defaultSession =
      authProfile?.storageState &&
      (!authProfile.storageStateExpiresAt || authProfile.storageStateExpiresAt > new Date())
        ? authProfile
        : null;
    const storageState = defaultSession?.storageState ?? null;
    const defaultProfileId = defaultSession?.id ?? null;

    /*
     * ── One session per PROFILE per run ──────────────────────────────────────
     *
     * A test can name its own `authProfileId`, so a suite holds an admin test
     * and a member test and both have to be right. The cache is keyed by
     * profile id, which gives exactly the two properties that matter: two tests
     * on the same profile share one session (one login, not one per test), and
     * two tests on different profiles can never share one.
     *
     * FAILURES are cached too, and that is the important half. Thirty tests
     * behind a profile whose password was rotated must cost ONE browser launch
     * and thirty identical, instant, honest failures — not thirty logins, each
     * taking a browser and thirty seconds, against an app that is going to
     * refuse all of them.
     */
    /*
     * ── Why a refusal carries a FAULT ────────────────────────────────────────
     *
     * "The password rotated" and "this test points at a profile somebody
     * deleted" both used to be one `{ ok: false, why }`, and they are opposite
     * facts: the first means nothing was measured and the application is not to
     * blame, the second is a defect in the SUITE that has to gate. The
     * preflight needs the difference in order to decide whether a run was
     * unattemptable or merely wrong, so the refusal says which it is rather
     * than leaving a reader of the sentence to infer it.
     */
    type ResolvedSession =
      | { ok: true; storageState: unknown }
      | { ok: false; why: string; fault: 'CONFIG' | 'ENVIRONMENT' };
    const sessions = new Map<string, ResolvedSession>();
    if (defaultProfileId) sessions.set(defaultProfileId, { ok: true, storageState });

    const resolveSession = async (profileId: string): Promise<ResolvedSession> => {
      const cached = sessions.get(profileId);
      if (cached) return cached;

      const resolved = await (async (): Promise<ResolvedSession> => {
        const profile = await prisma.authProfile.findFirst({
          // Scoped on the org, because a test row's profile id is data: an id
          // from another tenant must resolve to nothing rather than to their
          // session.
          where: { id: profileId, orgId },
          select: {
            id: true,
            name: true,
            kind: true,
            config: true,
            environmentId: true,
            storageState: true,
            storageStateExpiresAt: true,
          },
        });
        if (!profile) {
          return {
            ok: false,
            fault: 'CONFIG',
            why: `This test runs as auth profile ${profileId}, which no longer exists in this organisation.`,
          };
        }
        if (profile.environmentId !== run.environment.id) {
          /*
           * A profile belongs to ONE environment, and its session is cookies
           * for that environment's host. Using a staging profile against
           * production would send staging's cookies to production, get a login
           * redirect, and report whatever the test asserted about the login
           * page. Refusing is the only honest answer.
           */
          return {
            ok: false,
            fault: 'CONFIG',
            why: `Auth profile "${profile.name}" belongs to a different environment, so it cannot be used for this run.`,
          };
        }

        const fresh =
          profile.storageState &&
          (!profile.storageStateExpiresAt || profile.storageStateExpiresAt > new Date());
        if (fresh) return { ok: true, storageState: profile.storageState };

        // No usable session: sign in now. This is the step that never existed —
        // a run could only ever use a session somebody had captured by hand.
        let result;
        try {
          result = await signInWithProfile(
            { id: profile.id, name: profile.name, kind: profile.kind, config: profile.config },
            secrets,
            // `environmentKind` is required with no default, because MOCK_IDP
            // is refused on PRODUCTION and a refusal that depends on a caller
            // remembering an argument is not a refusal. `baseUrl` is the run's,
            // so a `baseUrlOverride` still decides where the login happens.
            { environmentKind: run.environment.kind, baseUrl },
          );
        } catch (err) {
          return {
            ok: false,
            // The attempt was MADE and the environment did not complete it.
            fault: 'ENVIRONMENT',
            why: `Signing in as "${profile.name}" threw: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          };
        }

        if (!result.ok) {
          return {
            ok: false,
            fault: 'ENVIRONMENT',
            why: `Could not sign in as auth profile "${profile.name}": ${result.message}`,
          };
        }
        if (!result.storageState) {
          /*
           * `ok` with no session is a real case: an SSO bypass TOKEN is a
           * request header, not a browser session, so there is nothing to hand
           * a spec. Treating it as success would run a role test logged out and
           * most assertions would pass, so it is a refusal with the reason.
           */
          return {
            ok: false,
            // A product gap in how this profile KIND works, not an outage.
            fault: 'CONFIG',
            why:
              `Auth profile "${profile.name}" is a ${profile.kind}, which produces a request header ` +
              'rather than a browser session, so a test cannot be run as that role yet.',
          };
        }

        // Persisted so the next run — and the crawler — reuse it instead of
        // logging in again. A write failure costs a re-login, never the run.
        await prisma.authProfile
          .update({
            where: { id: profile.id },
            data: {
              storageState: result.storageState,
              storageStateExpiresAt: result.expiresAt,
            },
          })
          .catch((err) => logger.warn({ err, profileId }, 'could not cache the captured session'));

        logger.info({ runId: run.id, profileId }, 'signed in for this run');
        return { ok: true, storageState: result.storageState };
      })();

      sessions.set(profileId, resolved);
      return resolved;
    };

    if (shard) {
      /*
       * Five shards start at once, and the run starts once. The conditional
       * update is the arbiter: `startedAt: null` matches for exactly one of them,
       * so exactly one publishes `run.started` and the cockpit does not show the
       * run beginning five times.
       */
      const first = await prisma.run.updateMany({
        where: { id: run.id, startedAt: null },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
      if (first.count === 1) {
        publishEvent(orgId, {
          runId: run.id,
          type: 'run.started',
          data: { total: run.totalCount, baseUrl, shards: shard.count },
          at: new Date().toISOString(),
        });
      }
      publishEvent(orgId, {
        runId: run.id,
        type: 'shard.started',
        data: { shard: shard.index, shards: shard.count, tests: run.results.length },
        at: new Date().toISOString(),
      });
    } else {
      /*
       * The unsharded start is conditional too, for the reason the sharded one
       * above already was: the status this writes must never be allowed to
       * overwrite a decision somebody else made about this run.
       *
       * It used to be an unconditional `update`. A run cancelled while QUEUED —
       * again, the normal case on a busy pool — had CANCELLED written by the
       * API, and this line put it straight back to RUNNING and executed the
       * whole suite anyway, against the environment it was pointed at.
       *
       * RUNNING is accepted alongside QUEUED so a job BullMQ redelivers after
       * its worker stalled still re-executes: matching only QUEUED would have
       * that job return quietly and leave the run at RUNNING with no verdict
       * for good, since the sharded sweep does not look at unsharded runs.
       * CANCELLED and every terminal status match neither, which is the point.
       */
      const started = await prisma.run.updateMany({
        where: { id: run.id, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
      if (started.count === 0) {
        const current = await prisma.run.findUnique({
          where: { id: run.id },
          select: { status: true },
        });
        logger.info(
          { runId: run.id, status: current?.status },
          'run is no longer startable; not executing the suite',
        );
        return;
      }
      publishEvent(orgId, {
        runId: run.id,
        type: 'run.started',
        data: { total: run.results.length, baseUrl },
        at: new Date().toISOString(),
      });
    }

    // Proof of life for this shard, on a timer. It dies with the process, which
    // is exactly the signal the siblings' reaper is looking for.
    heartbeat = shard
      ? setInterval(() => {
          void prisma.runShard
            .updateMany({
              where: { orgId, runId: run.id, index: shard.index, status: 'RUNNING' },
              data: { heartbeatAt: new Date() },
            })
            .catch((err) => logger.debug({ err, runId: run.id }, 'shard heartbeat failed'));
        }, SHARD_HEARTBEAT_MS)
      : null;
    // Never hold the process open for a heartbeat.
    heartbeat?.unref?.();

    /*
     * The plugins this org enabled on this project (§4).
     *
     * Read once per run rather than per test — the answer cannot change
     * mid-suite without making half the results mean something different from
     * the other half — and read AFTER the run has been declared started, so a
     * run that turns out not to be startable costs the registry nothing.
     *
     * `loadProjectPlugins` never throws and never fails a run. Every plugin it
     * refuses is reported here as a plugin fault, on its own event and its own
     * log line, and then the suite executes exactly as it would have. That is
     * the rule the whole feature rests on: somebody else's broken plugin must
     * never be reported as the customer's broken application, and must never
     * be the reason a merge is blocked.
     */
    const projectPlugins = await loadProjectPlugins(prisma, {
      orgId,
      projectId: run.projectId,
    });
    for (const admission of projectPlugins.admissions) {
      if (!admission.fault) continue;
      logger.warn(
        {
          runId: run.id,
          pluginId: admission.pluginId,
          plugin: admission.label,
          publisher: admission.publisher,
          kind: admission.fault.kind,
        },
        'installed plugin was not run',
      );
      publishEvent(orgId, {
        runId: run.id,
        type: 'plugin.fault',
        data: {
          pluginId: admission.pluginId,
          plugin: admission.label,
          publisher: admission.publisher,
          kind: admission.fault.kind,
          message: admission.fault.message,
        },
        at: new Date().toISOString(),
      });
    }

    /*
     * ── The customer's repository, once per run ──────────────────────────────
     *
     * Only when the suite actually contains a test that needs it: an E2E-only
     * run must not pay for a download it will never read, and a project with no
     * connected repository must not be told about it on every run.
     *
     * The materialiser never throws for an expected condition — see its header
     * — so a project with no repo, an unconfigured GitHub App, a 404 or a
     * hostile archive all come back as a reason, which every repo-dependent
     * test in the loop then carries as its own SKIPPED message.
     */
    /*
     * Per test, spec included — not a set of three types.
     *
     * Reading `REPO_DEPENDENT_TEST_TYPES` alone meant a suite made entirely of
     * CONTRACT, PROTOCOL, MOBILE or declared-command E2E tests materialised
     * nothing and then honestly skipped every test in it: safe, and useless.
     * Those four need a checkout only sometimes — a pact broker URL does not, a
     * pact path does — which is a question only the spec can answer.
     */
    const needsRepo = run.results.some((row) => testNeedsRepository(row.test));
    if (needsRepo) {
      const outcome = await materialiseRepoWorkspace({
        runId: run.id,
        repo: {
          repoFullName: run.project.repoFullName,
          repoInstallationId: run.project.repoInstallationId,
          defaultBranch: run.project.defaultBranch,
          // A CI run is about ONE commit, and that is the tree its verdict has
          // to describe. Without one, the project's default branch is the only
          // defensible answer.
          commitSha: run.commitSha,
        },
        unseal: openSecret,
        signal: controller.signal,
      });

      if (outcome.kind === 'ready') {
        repoWorkspace = outcome;
        logger.info(
          {
            runId: run.id,
            source: outcome.workspace.source,
            files: outcome.workspace.fileCount,
            bytes: outcome.bytes,
            skippedLinks: outcome.skippedLinks,
          },
          'materialised the project repository for this run',
        );
        if (outcome.skippedLinks > 0) {
          // Not fatal, but a build that needed a symlink will fail oddly and
          // this is the breadcrumb for it.
          logger.warn(
            { runId: run.id, skippedLinks: outcome.skippedLinks },
            'repository contained link entries, which were not created',
          );
        }
      } else {
        repoGap = outcome.why;
        logger.warn({ runId: run.id, why: outcome.why }, 'no repository workspace for this run');
      }
    }

    /*
     * ── The preflight, once per run, before any test ─────────────────────────
     *
     * Three questions, in the order it costs least to be wrong about them:
     * what this image can execute at all (local `stat` calls), whether the base
     * URL answers (one request, retried — see PREFLIGHT_PROBE_ATTEMPTS), and
     * whether the identities this suite needs still sign in.
     *
     * The login probe is the run's OWN `resolveSession`, so the probe IS the
     * login the suite was about to perform and the cache then satisfies every
     * test behind that profile. A preflight that signed in separately would
     * charge every authenticated run a second browser launch per profile to
     * catch an occasional rotated password, which is a tax nobody agreed to.
     *
     * Identities are probed only for tests that could otherwise have run:
     * driving a login for a test whose checkout is missing, or whose type has
     * no tool on this image, buys a browser launch for a result that is already
     * decided. That is also the existing behaviour this must not regress — see
     * "does not log in for a test that could not have run anyway" in run.test.ts.
     */
    const selected = run.results.map((row) => ({
      id: row.test.id,
      type: row.test.type,
      name: row.test.name,
      authProfileId: row.test.authProfileId,
    }));

    /*
     * Why this test cannot be attempted, or null. ONE implementation, called by
     * both the unattemptable path above and the execution loop below — the two
     * used to word the same fact differently, and the difference was visible to
     * a customer: a CONTRACT test whose pact lives in a missing checkout got
     * the per-type sentence in one path and the run-level one in the other.
     *
     * The repository comes first because its sentence names the TYPE and what
     * that type does with a checkout, which is what a reader of one result
     * needs; the preflight's repo check carries the run-level wording and is
     * there for the gate line and the unattemptable decision.
     *
     * A LOGIN block is deliberately NOT returned here. A test whose role could
     * not be signed in is recorded FAILED by the session path below, and that
     * is a decision this change does not reverse: a skip does not block a gate,
     * so a suite whose permission tests quietly stopped running would keep
     * merging green. The login check still counts toward "could ANYTHING have
     * been attempted", which is how a run whose single identity is broken
     * reports ENVIRONMENT_UNAVAILABLE instead of a wall of red.
     */
    const notRunReason = (test: {
      id: string;
      type: TestType;
      spec?: unknown;
    }): { kind: NotRunKind; why: string } | null => {
      if (testNeedsRepository(test) && !repoWorkspace) {
        return {
          kind: 'BLOCKED_BY_ENV',
          why: repoUnavailableMessage(
            test.type,
            repoGap ?? 'No repository workspace was prepared for this run.',
          ),
        };
      }
      const block = preflight?.blocked.get(test.id) ?? null;
      if (block === null || block.check === 'LOGIN') return null;
      return { kind: block.kind, why: block.why };
    };
    preflight = await safePreflight({
      runId: run.id,
      baseUrl,
      tests: selected,
      /*
       * The run's own plugin lookup, installed third-party plugins included.
       * Asking the registry alone would report a type as unsupported that THIS
       * project can run perfectly well through an installed plugin, and the
       * preflight would then refuse tests it was about to execute.
       */
      hasPlugin: (type) => resolveTestPlugin(type, projectPlugins) !== null,
      repo: needsRepo
        ? {
            available: repoWorkspace !== null,
            /*
             * Deliberately type-free, unlike the per-test sentence below: this
             * detail describes the RUN's missing checkout and is used for the
             * unattemptable decision and the gate line. The result rows keep
             * `repoUnavailableMessage(test.type, …)`, which names the type and
             * is the sentence a reader of one result needs.
             */
            why:
              'This run needs a checkout of your repository and QAAI could not materialise one, ' +
              `so the tests that execute inside it were not evaluated. ${
                repoGap ?? 'No repository workspace was prepared for this run.'
              }`,
            testIds: run.results
              .filter((row) => testNeedsRepository(row.test))
              .map((row) => row.test.id),
          }
        : null,
      signIn: async (profileId: string) => {
        const session = await resolveSession(profileId);
        return session.ok
          ? { ok: true as const }
          : { ok: false as const, fault: session.fault, why: session.why };
      },
    });

    /*
     * The frame the cockpit needs in order not to render a mystery. It is its
     * own event type on the existing SSE channel, exactly as `plugin.fault` is
     * — a new TYPE on plumbing that already works, rather than a new channel.
     * Published only when something is actually wrong: a green preflight on
     * every run is noise, and noise is how a signal gets filtered out.
     */
    const decision = preflight;
    const troubles = decision.checks.filter((check) => check.outcome === 'UNAVAILABLE');
    if (troubles.length > 0) {
      publishEvent(orgId, {
        runId: run.id,
        type: 'run.environment',
        data: {
          ...(shard ? { shard: shard.index } : {}),
          reason: decision.reason,
          durationMs: decision.durationMs,
          checks: troubles.map((check) => ({
            name: check.name,
            kind: check.kind,
            detail: check.detail,
          })),
        },
        at: new Date().toISOString(),
      });
      logger.warn(
        { runId: run.id, shard: shard?.index, checks: troubles.map((c) => c.name) },
        'environment preflight found problems',
      );
    }

    /*
     * Nothing in this slice could have been attempted. Executing it anyway
     * would manufacture a failure per test for one cause, which is the defect
     * this whole preflight exists to delete: the pass rate and the coverage
     * number would both move, and the move would be about a VPN tunnel.
     *
     * Every result gets the typed reason instead, and the run reports ERRORED
     * with ENVIRONMENT_UNAVAILABLE below — not PASSED over a suite of untouched
     * placeholders, which is what a bare `return` here would have produced.
     */
    if (decision.unattemptable) {
      /*
       * `decision.gapKind` rather than a hard-coded BLOCKED_BY_ENV, which is
       * what this fallback used to be. It is the kind the preflight's own
       * per-test blocks already agree on, so a slice of LOAD tests on an image
       * with no k6 reports a TOOLING gap at run level and not a lie about the
       * customer's staging box. `BLOCKED_BY_ENV` remains the fallback for the
       * one case `gapKind` cannot answer — a decision that says unattemptable
       * with no blocks behind it, which is not reachable today and is the safer
       * of the two to guess, since it points at the thing under test rather
       * than claiming a hole in this deployment.
       */
      const gap = {
        kind: decision.gapKind ?? ('BLOCKED_BY_ENV' as const),
        why: decision.reason ?? 'The environment this run points at could not be used at all.',
      };
      runGap = gap;
      for (const result of run.results) {
        const reason = notRunReason(result.test) ?? gap;
        counts.skipped += 1;
        await prisma.testResult.update({
          where: { id: result.id },
          data: {
            status: 'SKIPPED',
            // The kind in the COLUMN as well as in the tag. See `stampNotRun`
            // for why both, and why neither has a default.
            notRunKind: reason.kind,
            errorMessage: notRunMessage(reason.kind, reason.why),
          },
        });
      }
      logger.error(
        { runId: run.id, shard: shard?.index, kind: gap.kind, reason: gap.why },
        gap.kind === 'UNSUPPORTED'
          ? 'run not attempted: this deployment cannot execute these tests'
          : 'run not attempted: the environment is unavailable',
      );
    }

    /*
     * An unattemptable slice executes nothing — and the loop is SKIPPED rather
     * than returned from, so the finalisation below still writes a terminal
     * status, a gate result and a `run.finished` notification. A bare `return`
     * here is the defect this file's own history records twice: the run sits at
     * RUNNING for good, the cockpit's clock never stops, and the Slack message
     * and the PR comment never arrive.
     */
    const toExecute: Array<[number, (typeof run.results)[number]]> = runGap
      ? []
      : [...run.results.entries()];

    for (const [index, result] of toExecute) {
      const test = result.test;

      /*
       * Cooperative cancellation, checked between tests.
       *
       * A run could not be stopped at all — while one was in flight the
       * cockpit's only control was a disabled Re-run button. Killing the worker
       * process is not an option, since it is running every other org's runs
       * too, so the cancel endpoint writes the status and this loop notices.
       *
       * Between tests rather than mid-test: a half-executed test would be
       * recorded as a failure, which is exactly the false signal this product
       * exists to remove. The cost is that cancelling waits for the current
       * test to finish, and that is the right trade.
       *
       * Every shard polls this same row, so one cancel stops all of them — the
       * mechanism scales to a sharded run without needing to reach individual
       * workers. `finalizedAt` is checked alongside it so a shard that was
       * reaped as dead, and has since come back, stops instead of writing
       * results into a run that already reported.
       *
       * ── The stop request, which is the third reason to stop ───────────────
       *
       * `Run.stopRequestedAt` is written by three parties — the inline
       * fail-fast check at the bottom of this loop, the 60-second sweep in
       * schedule.ts that catches a fail-fast run whose worker died, and a
       * person pressing stop in the cockpit — and until now NOTHING READ IT.
       * Four surfaces promised the behaviour: `createRunSchema` accepts
       * `failFast`, POST /runs reports it back, the columns and their migration
       * exist, and POST /team/runs/:runId/stop told the caller the worker
       * "checks between tests". It did not, so a fail-fast run ran all 5,000
       * tests and a stop request was a row nobody obeyed.
       *
       * This poll is the single place that acts on it, whoever wrote it. One
       * decision point rather than a `break` at each writer, because five
       * shards and three writers must not be able to tell different stories
       * about why a run stopped.
       *
       * `cancelled` STAYS FALSE for a stop request, and that is the whole care
       * in this branch: a cancel recounts the result rows and finalises
       * CANCELLED, while a stop request must finalise on its real counts —
       * FAILED, with the failure that tripped it — per the schema comment on
       * `Run.stopRequestedAt`.
       */
      const current = await prisma.run.findUnique({
        where: { id: run.id },
        select: { status: true, finalizedAt: true, stopRequestedAt: true, stopReason: true },
      });
      if (
        current?.status === 'CANCELLED' ||
        current?.stopRequestedAt != null ||
        (shard && current?.finalizedAt)
      ) {
        cancelled = current?.status === 'CANCELLED';
        stopRequested =
          !cancelled && current?.stopRequestedAt != null
            ? (current.stopReason ??
              'This run was asked to stop early, and the request carried no reason.')
            : null;
        logger.info(
          { runId: run.id, completed: index, shard: shard?.index, stopRequested },
          cancelled
            ? 'run cancelled; stopping'
            : stopRequested
              ? 'stop requested; not executing the rest of this slice'
              : 'run already finalised; stopping',
        );
        /*
         * Break rather than return, on both paths. An unsharded cancel used to
         * publish a bare `run.finished` here and return: the counts, the gate
         * result and the `run.finished` NOTIFICATION were all skipped, so the
         * cockpit rendered a cancelled run with a blank summary forever and
         * nobody who subscribes to a finished run ever heard about it. Falling
         * out of the loop hands both paths to the finalisation below, which
         * already knows how to write a forced status.
         */
        break;
      }

      publishEvent(orgId, {
        runId: run.id,
        type: 'test.started',
        data: {
          testId: test.id,
          name: test.name,
          type: test.type,
          // Progress, so the cockpit can say "4 of 11" rather than leaving the
          // user to guess whether anything is happening at all. On a sharded
          // run these count the shard's own slice — five workers cannot share
          // one counter without a round trip per test — so the shard is named
          // alongside them and `runTotal` carries the suite-wide figure.
          index,
          total: run.results.length,
          ...(shard ? { shard: shard.index, shards: shard.count, runTotal: run.totalCount } : {}),
        },
        at: new Date().toISOString(),
      });

      /*
       * First-party first, unconditionally — `resolveTestPlugin` does not
       * consult the installed map for a type QAAI implements, so no registry
       * row can put third-party code in front of the built-in plugin for E2E.
       */
      const plugin = resolveTestPlugin(test.type, projectPlugins);
      if (!plugin) {
        // A missing plugin is a product gap, not a test failure — recording it as
        // SKIPPED with the reason keeps the run honest and the UI truthful.
        counts.skipped += 1;
        await prisma.testResult.update({
          where: { id: result.id },
          data: {
            // Tagged UNSUPPORTED rather than left as a bare sentence: "nobody
            // built this yet" and "this cannot run here" were the same SKIPPED
            // for the whole life of this file, and that is the distinction.
            status: 'SKIPPED',
            notRunKind: 'UNSUPPORTED',
            errorMessage: notRunMessage('UNSUPPORTED', reasonUnsupported(test.type)),
          },
        });
        logger.warn({ testId: test.id, type: test.type }, 'no runner plugin; skipping');
        continue;
      }

      const executable: ExecutableTest = {
        id: test.id,
        name: test.name,
        type: test.type,
        code: test.code,
        filePath: test.filePath,
        spec: test.spec,
        timeoutMs: test.timeoutMs,
        quarantined: test.quarantined,
        tags: test.tags,
        /*
         * The role this test executes as, and whether it is meaningless
         * without one. Carried to the plugin rather than resolved there: the
         * runner has no database, and the harness needs the INTENT to be able
         * to refuse a test whose binding was deleted instead of running it
         * signed out. See packages/runner/src/run-workspace.ts.
         */
        authProfileId: test.authProfileId,
        authProfileRequired: test.authProfileRequired ?? false,
      };

      const declaredProfileId = test.authProfileId ?? null;

      const uploaded: Array<{ key: string; contentType: string }> = [];

      // Visual tests compare against an approved baseline. Resolved here so the
      // runner never needs database access.
      /*
       * SCOPED TO THIS RUN'S ENVIRONMENT, and that clause is the whole reason
       * `VisualBaseline.environmentId` exists.
       *
       * This read was `{ orgId, testId }` with `orderBy: updatedAt desc`, which
       * is "whichever baseline for this test was approved most recently,
       * wherever it was captured". With one image per (test, viewport,
       * browser) that was merely imprecise; with the environment in the key it
       * is the defect the column was added to remove, running in the opposite
       * direction — a staging capture approved this morning would be diffed
       * against production this afternoon, and every red it produced would be
       * permanently false.
       *
       * A test with no baseline for THIS environment resolves to null, which
       * the visual plugin already treats as "first run: capture and approve".
       * That is the safe failure and it is the one the migration discloses: one
       * re-approval per test per environment, rather than a diff against a
       * reference whose environment nobody recorded.
       */
      const baselineRow =
        test.type === 'VISUAL'
          ? await prisma.visualBaseline.findFirst({
              where: { orgId, testId: test.id, environmentId: run.environment.id },
              orderBy: { updatedAt: 'desc' },
              select: { imageKey: true, ignoreRegions: true },
            })
          : null;

      /*
       * ── The two reasons this test cannot be executed ───────────────────────
       *
       * No checkout to run in, and no session to run as. Both are resolved
       * BEFORE the context is built, because both decide what goes into it, and
       * both are the same rule in different clothes: a test QAAI cannot run is
       * reported as not having run. Never as a pass.
       */
      const notRun = notRunReason(test);

      /*
       * The session this test runs under. A test that named a profile gets THAT
       * profile's session or no execution at all; a test that named none gets
       * the run default, exactly as before.
       */
      let session: ResolvedSession;
      if (notRun) {
        // Nothing is going to execute, so there is nothing to log into an
        // application for — whether the gap is a missing checkout, a dead base
        // URL or a tool this image does not have. A browser launch for a result
        // that is already decided is a launch nobody gets anything for.
        session = { ok: true, storageState: null };
      } else if (declaredProfileId) {
        session = await resolveSession(declaredProfileId);
      } else if (test.authProfileRequired && !storageState) {
        /*
         * A BROKEN BINDING: the test says it is meaningless signed out, and it
         * has no profile to be signed in as because the profile was deleted out
         * from under it (`onDelete: SetNull` nulls the binding and deliberately
         * leaves the intent behind). Falling through to the run default — which
         * here is nothing at all — would run it anonymously, and an anonymous
         * browser on a page behind a login passes most assertions.
         */
        session = {
          ok: false,
          // The binding was deleted out from under the test: a suite defect.
          fault: 'CONFIG',
          why:
            'This test is marked as requiring a signed-in role, and the auth profile it was ' +
            'bound to no longer exists — so it was not run rather than run signed out. ' +
            'Re-bind it to a profile in the test editor.',
        };
      } else {
        session = { ok: true, storageState };
      }

      const context: RunContext = {
        runId: run.id,
        orgId,
        projectId: run.projectId,
        environmentId: run.environment.id,
        baseUrl,
        secrets,
        fixtures,
        grid,
        visualBaseline: baselineRow
          ? {
              imageKey: baselineRow.imageKey,
              ignoreRegions: (baselineRow.ignoreRegions ?? []) as Array<{
                x: number;
                y: number;
                width: number;
                height: number;
              }>,
            }
          : null,
        storageState: session.ok ? session.storageState : null,
        signal: controller.signal,
        determinism: {
          freezeClockAt: null,
          // Seeded from the run id so a re-run of the same run reproduces the
          // same synthetic data, while a new run gets fresh values.
          randomSeed: [...run.id].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7),
          waitForNetworkIdle: true,
          retryOnce: true,
        },
        artifacts: {
          async put(name, body, contentType) {
            const key = artifactKey({ orgId, runId: run.id, name });
            await storage.put(key, Buffer.from(body), contentType);
            uploaded.push({ key, contentType });
            return key;
          },
          async putFile(name, absolutePath, contentType) {
            const key = artifactKey({ orgId, runId: run.id, name });
            await storage.putFile(key, absolutePath, contentType);
            uploaded.push({ key, contentType });
            return key;
          },
          async get(key) {
            // A missing baseline is an expected state (first run, or swept by
            // retention), not an error — the plugin treats null as "capture one".
            return storage.get(key).catch(() => null);
          },
          async putPersistent(name, body, contentType) {
            // Deliberately NOT run-scoped: a baseline has to outlive the run
            // that captured it, and the retention sweeper works by run prefix.
            const key = `orgs/${orgId}/persistent/${name}`;
            await storage.put(key, Buffer.from(body), contentType);
            return key;
          },
        },
        logger: {
          debug: (msg, meta) => logger.debug({ ...meta, testId: test.id }, msg),
          info: (msg, meta) => logger.info({ ...meta, testId: test.id }, msg),
          warn: (msg, meta) => logger.warn({ ...meta, testId: test.id }, msg),
          error: (msg, meta) => logger.error({ ...meta, testId: test.id }, msg),
          step: (event) =>
            publishEvent(orgId, {
              runId: run.id,
              type: 'step',
              data: event,
              at: new Date().toISOString(),
            }),
        },
      };

      /*
       * The two channels `RunContext` does not carry yet — the materialised
       * repository and whose session is in `storageState`. Both are set through
       * the runner's own accessors so the field names exist in exactly one
       * place. See packages/runner/src/run-workspace.ts.
       *
       * The profile id is attached only when a session was actually resolved: a
       * context that claims an identity it does not hold is worse than one that
       * claims none, and it is what the harness's refusal keys on.
       */
      attachRunWorkspace(context, repoWorkspace?.workspace ?? null);
      attachAuthProfile(context, session.ok ? (declaredProfileId ?? defaultProfileId) : null);

      let execution: TestExecution;
      if (notRun) {
        /*
         * QAAI could not attempt this one: no checkout to run the customer's
         * command inside, a base URL that never answered, or a type whose tool
         * is not on this image. SKIPPED with a TYPED reason — the same answer
         * the run already gave for a missing plugin, except that the reason is
         * now machine-readable, which is the half that was missing.
         *
         * The kind is the actionable part: `UNSUPPORTED` is fixed by installing
         * something on the worker and `BLOCKED_BY_ENV` by fixing the thing
         * under test, and a reader who cannot tell them apart cannot act on
         * either.
         */
        execution = syntheticExecution(
          test.id,
          'SKIPPED',
          notRunMessage(notRun.kind, notRun.why),
          // The kind as DATA as well as in the tag, so `persistExecution` can
          // write the column. Without it the one party that knows which of the
          // four reasons applies would hand on only a string again.
          notRun,
        );
        logger.warn(
          { testId: test.id, type: test.type, runId: run.id, kind: notRun.kind },
          'test not evaluated: QAAI could not attempt it',
        );
      } else if (!session.ok) {
        /*
         * FAILED, not SKIPPED, and the distinction is the whole point: a skip
         * does not block a gate, so a suite whose permission tests quietly
         * stopped running would keep merging green. The test asked to run as a
         * role, the role could not be produced, and nothing was executed
         * anonymously in its place.
         */
        execution = syntheticExecution(test.id, 'FAILED', session.why);
        logger.warn(
          { testId: test.id, profileId: declaredProfileId, runId: run.id },
          'test not executed: its auth profile could not be signed in',
        );
      } else {
        try {
          plugin.validate(executable);
          execution = await plugin.execute(context, executable);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, testId: test.id }, 'plugin threw');
          execution = syntheticExecution(test.id, 'FAILED', message);
        }
      }

      // A first-run visual capture becomes the approved baseline. Recorded here
      // rather than in the plugin, which has no database access by design.
      if (execution.newBaseline) {
        await prisma.visualBaseline.upsert({
          where: {
            /*
             * FOUR MEMBERS, AND THE FOURTH IS THE WHOLE POINT.
             *
             * This key was `(testId, viewport, browser)`, so staging and
             * production SHARED a reference image for one test: a staging
             * capture silently became the production baseline, and every red it
             * produced afterwards was permanently false. `VisualBaseline` grew
             * `environmentId` for exactly that, with NO DEFAULT — a defaulted
             * sentinel is how the shared-reference defect comes back one writer
             * at a time — so this writer has to name the environment it
             * captured in, and `run.environment.id` is the only environment it
             * has an observation FROM.
             *
             * The safe failure on deploy is one re-approval per test per
             * environment: existing rows carry `<unattributed>`, which this key
             * never matches, so the first run after the migration captures a
             * fresh baseline rather than diffing against a reference whose
             * environment nobody recorded.
             */
            testId_viewport_browser_environmentId: {
              testId: test.id,
              viewport: execution.newBaseline.viewport,
              browser: execution.newBaseline.browser,
              environmentId: run.environment.id,
            },
          },
          create: {
            orgId,
            projectId: run.projectId,
            testId: test.id,
            viewport: execution.newBaseline.viewport,
            browser: execution.newBaseline.browser,
            environmentId: run.environment.id,
            imageKey: execution.newBaseline.imageKey,
          },
          update: { imageKey: execution.newBaseline.imageKey },
        });
        logger.info(
          { testId: test.id, viewport: execution.newBaseline.viewport },
          'visual baseline captured',
        );
      }

      await persistExecution({
        orgId,
        projectId: run.projectId,
        /*
         * `runId` and `testId` COME FROM THE PARENT ROW, which is the row this
         * loop is already holding — not from `execution`, whose `testId` is the
         * producer's claim about which test it ran. The two tables denormalise
         * both columns and never update them, so whatever is written here is
         * the only answer their reads will ever get.
         */
        runId: result.runId,
        testId: result.testId,
        testResultId: result.id,
        execution,
        uploaded,
        expiresAt,
      });

      /*
       * The one line the original defect was missing. A quarantined test's
       * failure lands in `quarantinedFailed`, never in `failed`, so it cannot
       * turn the run red through the counters — which is how it used to reach
       * the CLI's exit code and the GitHub check despite the gate ignoring it.
       *
       * `quarantineSuppresses` rather than `test.quarantined`: a quarantine
       * past its expiry gates again.
       */
      tallyResult(counts, {
        status: execution.status,
        quarantineInForce: quarantineSuppresses(test, new Date()),
      });

      /*
       * ── FAIL-FAST, at the first real failure ──────────────────────────────
       *
       * The sweep in schedule.ts already wrote this request once a minute, so
       * the behaviour existed with up to sixty seconds of a 5,000-test suite
       * still to run after the suite had already failed. Writing it here makes
       * the stop immediate; the sweep stays, because it is the only thing that
       * can request a stop for a fail-fast run whose worker died holding it.
       *
       * `failFastTripped` rather than a local rule, for the reason given at the
       * import: two writers of one column must not be able to disagree about
       * what trips it. It refuses a retry that passed (flaky, not broken) and a
       * failure a quarantine in force has suppressed (switched off on purpose),
       * which are the two ways this could otherwise end a run that still had
       * real answers to give.
       *
       * The conditional UPDATE is the same one the sweep and
       * POST /team/runs/:runId/stop use, so the first writer wins and the row
       * names whoever actually stopped it. STATUS IS NOT TOUCHED here and
       * `finalizedAt` is not either: both belong to the finalisation below, and
       * writing them from the side is how a run comes to report a verdict twice.
       *
       * It does not break out of the loop. The poll at the top of the next
       * iteration is what reads the request — including the request a SIBLING
       * shard just wrote — and nothing else executes in between.
       */
      if (
        run.failFast &&
        failFastTripped(
          {
            status: execution.status,
            retriedAndPassed: execution.retriedAndPassed,
            test: {
              quarantined: test.quarantined,
              quarantineExpiresAt: test.quarantineExpiresAt,
            },
          },
          new Date(),
        )
      ) {
        const stop = await prisma.run.updateMany({
          where: { id: run.id, stopRequestedAt: null, status: { in: ['QUEUED', 'RUNNING'] } },
          data: { stopRequestedAt: new Date(), stopReason: failFastStopReason(test.name) },
        });
        if (stop.count > 0) {
          logger.warn(
            { runId: run.id, shard: shard?.index, testId: test.id, test: test.name },
            'fail-fast tripped: stop requested',
          );
        }
      }

      await updateFlakeStats({
        orgId,
        projectId: run.projectId,
        runId: run.id,
        testId: test.id,
        status: execution.status,
        quarantined: test.quarantined,
      });

      publishEvent(orgId, {
        runId: run.id,
        type: 'test.finished',
        data: {
          testId: test.id,
          name: test.name,
          status: execution.status,
          durationMs: execution.durationMs,
          findings: execution.findings.length,
        },
        at: new Date().toISOString(),
      });

      // Anything that is not a clean pass goes to Triage — including a flake,
      // because "why is this flaky" is a verdict worth having (§3.3).
      if (execution.status !== 'PASSED' && execution.status !== 'SKIPPED') {
        await enqueueTriage({ orgId, runId: run.id, testResultId: result.id });
      }
    }
  } catch (err) {
    // The loop already converts a plugin throwing into a FAILED result, so
    // reaching here means the infrastructure around it broke — the database,
    // Redis, or artifact storage. That is a run-level error, not a test failure.
    runErrored = err instanceof Error ? err.message : String(err);
    controller.abort();
    logger.error({ err, runId: run.id, shard: shard?.index }, 'run aborted');
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    /*
     * The workspace goes away on every exit: a clean finish, a cancel that
     * broke out of the loop, and a throw from anywhere above. A tenant's source
     * tree must not outlive the run that needed it, and a worker that leaks one
     * temp tree per run fills its disk in a day.
     */
    if (repoWorkspace) {
      await repoWorkspace.cleanup();
      logger.debug({ runId: run.id }, 'removed the run workspace');
    }
  }

  /*
   * A cancel stopped the loop part-way, so some of this slice's results are
   * still sitting at the placeholder SKIPPED that run creation wrote. Stamping
   * them CANCELLED is the difference between "a person stopped this" and "a
   * worker died holding it" — the two facts that shared one SKIPPED, and the
   * two that a reader needs to tell apart before deciding whether to re-run.
   *
   * One `updateMany`, and only over rows nothing has written to.
   */
  if (cancelled) {
    await stampNotRun(
      orgId,
      run.id,
      shard,
      'CANCELLED',
      'The run was cancelled before this test was reached.',
    );
  } else if (stopRequested) {
    /*
     * A stop request left the same untouched placeholders behind, and they get
     * NOT_RUN rather than CANCELLED: nobody reached these, and nobody decided
     * anything about them either. CANCELLED would say a person stopped the run,
     * which is exactly the claim `Run.stopRequestedAt` is documented as NOT
     * making — a fail-fast stop is a FAILED run that chose not to finish.
     *
     * NOT_RUN is also the weakest of the four kinds, which is the right
     * strength here: the reason carries the sentence whoever requested the stop
     * wrote, and this process knows nothing beyond it.
     */
    await stampNotRun(
      orgId,
      run.id,
      shard,
      'NOT_RUN',
      `${stopRequested} This test was never reached.`,
    );
  }

  if (shard) {
    // This shard is done moving. Recorded before anything else, because the
    // completion rule below is a question about rows, and a shard that has
    // finished but not said so is a shard that hangs the run.
    await prisma.runShard.updateMany({
      // The worker's client carries no tenancy extension, so every query here
      // scopes itself on the orgId from the job.
      where: { orgId, runId: run.id, index: shard.index },
      data: {
        /*
         * A gap marks the shard FAILED, and that is deliberate rather than lazy
         * reuse. `completeShardedRun` forces the RUN to ERRORED when any shard
         * did not complete, which is exactly the verdict an unattemptable slice
         * must produce — a shard that executed nothing and reported COMPLETED
         * would let its siblings finalise the run as a clean pass over
         * placeholder rows. The reason travels on the shard's own
         * `errorMessage`, carrying the marker for the kind of gap it was, which
         * is what lets `completeShardedRun` compose a run-level message that
         * names the same cause.
         *
         * A shard that STOPPED EARLY reports COMPLETED, and that is a choice
         * rather than an oversight. FAILED would force the whole run to ERRORED
         * — "the run did not finish, so nothing was measured" — when a
         * fail-fast stop is a run that measured exactly the failure it stopped
         * on; CANCELLED would say a person abandoned it. There is no shard
         * status for "stopped on purpose", so the fact lives where it can be
         * read instead: `Run.stopRequestedAt`/`stopReason` on the run, the
         * shard's own `skippedCount`, and a `[NOT_RUN]` tag with the reason on
         * every row nobody reached.
         */
        status: cancelled ? 'CANCELLED' : runErrored || runGap ? 'FAILED' : 'COMPLETED',
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        passedCount: counts.passed,
        failedCount: counts.failed,
        flakyCount: counts.flaky,
        skippedCount: counts.skipped,
        quarantinedFailedCount: counts.quarantinedFailed,
        errorMessage: runErrored ?? (runGap ? runGapMessage(runGap.kind, runGap.why) : null),
      },
    });

    publishEvent(orgId, {
      runId: run.id,
      type: 'shard.finished',
      data: { shard: shard.index, shards: shard.count, ...counts, errored: runErrored !== null },
      at: new Date().toISOString(),
    });

    await completeShardedRun({
      orgId,
      run: {
        id: run.id,
        projectId: run.projectId,
        trigger: run.trigger,
        prNumber: run.prNumber,
        gateRules: run.project.gateRules,
        quarantineBudgetPercent: run.project.quarantineBudgetPercent,
      },
      shardIndex: shard.index,
    });
    return;
  }

  await finalizeRun({
    orgId,
    run: {
      id: run.id,
      projectId: run.projectId,
      trigger: run.trigger,
      prNumber: run.prNumber,
      gateRules: run.project.gateRules,
      quarantineBudgetPercent: run.project.quarantineBudgetPercent,
    },
    /*
     * A cancelled run stopped part-way, so the in-memory counters describe the
     * tests this process happened to reach and nothing else — the rest are
     * still sitting at their placeholder SKIPPED. The result rows are what the
     * cockpit renders, so they are what the summary is counted from, exactly as
     * `completeShardedRun` does it. A run that ran to the end keeps its own
     * counters: they are already the same numbers, without the extra query.
     *
     * A STOP REQUEST is the same shape and is counted the same way. Keeping the
     * in-memory counters here would write `skippedCount: 0` onto a run with two
     * SKIPPED results in it — the five columns would stop summing to the number
     * of results, which is the invariant every surface's arithmetic rests on.
     * Only the DENOMINATOR changes; the failure that tripped fail-fast is still
     * counted as a failure, so the verdict is still FAILED.
     */
    counts: cancelled || stopRequested ? await aggregateCounts(orgId, run.id) : counts,
    /*
     * An unattemptable run carries its marker and the reason, and ERRORED —
     * which `runOutcome` already words as "the run did not finish, so nothing
     * was measured" and already answers `passed: false` for. Not a green build,
     * not a red one: the third state, which is the only honest verdict on a
     * suite nobody could execute.
     *
     * The marker is applied HERE rather than deferred to `finalizeRun` (as the
     * sharded path defers it) because this path is the one that knows: an
     * unsharded run's slice IS the whole run, so `unattemptable: true` below is
     * not a guess about the siblings' rows — there are none.
     *
     * A stop request deliberately adds NOTHING here. It is not a run-level
     * error and must not read as one: the run finalises on its real counts, so
     * the verdict is FAILED with the failure that tripped it, and the sentence
     * lives on `Run.stopReason` where three surfaces already render it.
     */
    errorMessage: runErrored ?? (runGap ? runGapMessage(runGap.kind, runGap.why) : null),
    forcedStatus: cancelled ? 'CANCELLED' : runErrored || runGap ? 'ERRORED' : null,
    unattemptable: runGap !== null,
  });
}

/**
 * Stamp a typed not-run reason onto results nothing has written to.
 *
 * `errorMessage: null` is the filter and it is the whole safety of this: a row
 * carrying a message has been written by the execution loop (a plugin's own
 * skip, a repository gap, an unsupported type) and must not be relabelled by a
 * bulk update that knows less than the loop did. Only the untouched
 * placeholders are claimed.
 *
 * Scoped to the shard when there is one — a cancel seen by shard 2 says nothing
 * about shard 5's rows, which another worker is still executing.
 *
 * ── Why the kind is written TWICE ───────────────────────────────────────────
 *
 * `TestResult.notRunKind` is the queryable home: "how many of this month's
 * skips were the environment's fault?" is a GROUP BY against a column and a
 * regex against a message, and the second one is not an answer anybody gets.
 * The TAG stays because it is what a surface renders, because the sentence
 * after it is complete English, and because every row written before the column
 * existed carries the tag and nothing else — so `parseNotRun` is still the only
 * way to classify an old row. A reader holding both prefers the column.
 *
 * NEITHER HAS A DEFAULT. NULL and an absent tag both spell the same fifth
 * state, "not recorded", and that is not `NOT_RUN`: NOT_RUN is a claim — the
 * weakest of the four, but still a claim — and writing it where nothing made
 * one would put a sentence in the database that no code produced.
 */
async function stampNotRun(
  orgId: string,
  runId: string,
  shard: RunShardRef | null,
  kind: NotRunKind,
  why: string,
): Promise<void> {
  const stamped = await prisma.testResult.updateMany({
    where: {
      orgId,
      runId,
      /*
       * SKIPPED, and the status filter is as load-bearing as the message one.
       * Without it a cancel's bulk stamp would reach a PASSED row whose
       * `errorMessage` is null — which is every passing test in the run — and
       * write "the run was cancelled before this test was reached" onto results
       * that were executed and passed. Rows the loop wrote are not this
       * update's to relabel, and a pass is the most expensive one to lie about.
       */
      status: 'SKIPPED',
      errorMessage: null,
      ...(shard ? { shardIndex: shard.index } : {}),
    },
    data: { notRunKind: kind, errorMessage: notRunMessage(kind, why) },
  });
  if (stamped.count > 0) {
    logger.info(
      { runId, shard: shard?.index, kind, results: stamped.count },
      'recorded why these results did not run',
    );
  }
}

/**
 * How many suppression-ledger rows one run's summary is folded from.
 *
 * A BOUND that is reported when it bites, never a silent take. One row per
 * (cause, kind) per run, so a 200-test outage under three mutes writes three —
 * past this cap a run had thousands of distinct suppressed causes, which is
 * itself the finding, and the summary under-counts rather than lying about
 * having seen everything.
 */
export const SUPPRESSION_LEDGER_SCAN_CAP = 2_000;

/**
 * This run's suppressions, tallied by kind, for `runOutcome`.
 *
 * FOLDED IN TYPESCRIPT RATHER THAN BY `groupBy`, and the reason is the number
 * that matters: `suppressions` is DISTINCT suppressing rows, not ledger rows. A
 * `groupBy(['kind'])` with `_count` would report three known issues as three
 * when they silenced one cause each and as one when one mute silenced three
 * causes — and the headline sentence is "47 failures by 3 known issues", so the
 * second number has to be distinct `sourceId`s. Prisma cannot count distinct
 * values inside a group-by, so the rows are read and folded here.
 *
 * QUARANTINE ROWS ARE EXCLUDED at the source. `runOutcome` synthesises the
 * quarantine tally from `counts.quarantinedFailed`, which `tallyResult` is the
 * only writer of; letting a ledger row through as well would double the one
 * total a release decision reads.
 */
async function suppressionTalliesFor(
  orgId: string,
  runId: string,
): Promise<{ tallies: SuppressionTally[]; capped: number | null }> {
  const rows = await prisma.suppressionEvent
    .findMany({
      where: { orgId, runId, kind: { not: 'QUARANTINE' } },
      take: SUPPRESSION_LEDGER_SCAN_CAP + 1,
      select: { kind: true, sourceId: true, suppressed: true, inForce: true },
    })
    .catch((err: unknown) => {
      /*
       * A read that failed is NOT "nothing was suppressed". The finalisation
       * must not fail over a summary, so the error is logged and the summary is
       * omitted — which makes `runOutcome` say "Nothing was suppressed.", and
       * that is the one arm of this function that is not honest. It is
       * reachable only if the ledger table is unreadable while the rest of the
       * finalisation's writes succeed; the log line is what a reader has.
       */
      logger.error(
        { err, runId },
        'could not read the suppression ledger; this run’s summary will under-report what was silenced',
      );
      return null;
    });
  if (rows === null) return { tallies: [], capped: null };

  const capped = rows.length > SUPPRESSION_LEDGER_SCAN_CAP ? rows.length : null;
  if (capped !== null) {
    logger.warn(
      { runId, cap: SUPPRESSION_LEDGER_SCAN_CAP, read: capped },
      'the suppression ledger read hit its cap; the run’s suppression summary under-counts',
    );
  }

  const byKind = new Map<
    SuppressionKind,
    { suppressed: number; live: Set<string>; dead: Set<string> }
  >();
  for (const row of rows.slice(0, SUPPRESSION_LEDGER_SCAN_CAP)) {
    /*
     * NO CAST. `SuppressionEvent.kind` is a Postgres enum, so Prisma already
     * types it as the union and an assertion here would only hide the day the
     * two vocabularies stop agreeing — which is exactly the thing a drift guard
     * exists to make loud.
     */
    const kind: SuppressionKind = row.kind;
    const tally = byKind.get(kind) ?? { suppressed: 0, live: new Set(), dead: new Set() };
    tally.suppressed += row.suppressed;
    // `sourceId` is nullable in the schema; a row with none still counts as one
    // suppression, identified by nothing, rather than being dropped.
    (row.inForce ? tally.live : tally.dead).add(row.sourceId ?? `<unidentified:${kind}>`);
    byKind.set(kind, tally);
  }

  return {
    capped,
    tallies: [...byKind.entries()].map(([kind, tally]) => ({
      kind,
      suppressions: tally.live.size,
      suppressed: tally.suppressed,
      expired: tally.dead.size,
    })),
  };
}

/** A test, as the preflight needs to see it. */
interface PreflightTest {
  id: string;
  type: TestType;
  name: string;
  authProfileId: string | null;
}

/**
 * The preflight's answer, flattened into data this processor can act on.
 *
 * Deliberately NOT the runner's `EnvironmentPreflight` passed straight through.
 * The execution loop needs one question answered per test — "can this be
 * attempted, and if not, what do I write on it?" — and resolving that into a
 * Map here keeps every call into the preflight API inside one try/catch. A
 * preflight is an instrument: if the instrument breaks, the suite must execute
 * exactly as it did before the instrument existed, and that promise is only
 * keepable if there is no second call site to throw from halfway through.
 */
interface PreflightDecision {
  /** Every check, for the live frame. Flattened to strings; nothing branches on it. */
  checks: Array<{ name: string; kind: NotRunKind; outcome: string; detail: string }>;
  durationMs: number;
  /** testId → why it cannot be attempted. Empty on a clean preflight. */
  blocked: Map<string, { kind: NotRunKind; why: string; check: string }>;
  /** Nothing in this slice could be attempted. */
  unattemptable: boolean;
  /**
   * WHICH kind of gap made it unattemptable, set only when `unattemptable`.
   *
   * `UNSUPPORTED` means every blocked test was blocked by something missing on
   * THIS IMAGE; anything else means the thing under test is implicated. It is
   * what picks the run-level marker, and it exists because those two reports go
   * to different people — see `TOOLING_UNAVAILABLE_PREFIX`.
   */
  gapKind: NotRunKind | null;
  /** One sentence, set only when `unattemptable`. */
  reason: string | null;
}

/**
 * The identities this suite actually needs, grouped by profile.
 *
 * Grouped rather than per test, because the probe is a LOGIN: thirty tests on
 * one profile is one credential to check, and asking thirty times would be
 * thirty browser launches against an app that is going to answer identically.
 *
 * `decided` drops tests whose result is already settled — their type has no
 * tool on this image, or their checkout is missing. A login probe for those
 * buys a browser launch and changes nothing, and preserving that is also the
 * existing behaviour the suite guards ("does not log in for a test that could
 * not have run anyway").
 *
 * A profile is named by its FIRST test's name rather than by the profile's own
 * name, which the run processor does not have here. That is a worse sentence
 * than it could be and is called out so nobody mistakes it for intent.
 */
export function requiredIdentities(
  tests: readonly PreflightTest[],
  decided: (test: PreflightTest) => boolean,
): RequiredIdentity[] {
  const byProfile = new Map<string, { label: string; testIds: string[] }>();
  for (const test of tests) {
    if (test.authProfileId === null || decided(test)) continue;
    const entry = byProfile.get(test.authProfileId) ?? {
      label: `the role "${test.name}" runs as`,
      testIds: [],
    };
    entry.testIds.push(test.id);
    byProfile.set(test.authProfileId, entry);
  }
  return [...byProfile].map(([profileId, entry]) => ({
    profileId,
    label: entry.label,
    testIds: entry.testIds,
  }));
}

/**
 * The preflight, wrapped so it can never be the reason a run does not happen.
 *
 * This is the rule the whole feature rests on, and it is the same one
 * `loadProjectPlugins` is written under: a preflight is an INSTRUMENT. If the
 * instrument breaks, the suite executes exactly as it did before the instrument
 * existed — a `TypeError` in a PATH probe must not cost a customer their CI
 * run. So every failure here resolves to an empty, all-clear preflight, which
 * blocks nothing and claims nothing, and says so in the log.
 *
 * Note what that means and does not mean: a BROKEN preflight produces the old
 * behaviour (tests run, and a missing tool surfaces as the plugin's own ENOENT
 * skip). It never produces a green run over tests nobody executed, because it
 * never marks anything as not-run.
 */
async function safePreflight(args: {
  runId: string;
  baseUrl: string;
  tests: readonly PreflightTest[];
  hasPlugin: (type: TestType) => boolean;
  repo: { available: boolean; why: string; testIds: readonly string[] } | null;
  signIn: (profileId: string) => Promise<SessionProbeResult>;
}): Promise<PreflightDecision> {
  const types = [...new Set(args.tests.map((test) => test.type))];
  try {
    const runnability = await runnabilityFor(types, { hasPlugin: args.hasPlugin });
    const unrunnable = new Set(
      runnability.filter((entry) => entry.runnable === false).map((entry) => entry.type),
    );
    const repoBlocked = new Set(
      args.repo && !args.repo.available ? args.repo.testIds : ([] as readonly string[]),
    );

    const preflight = await environmentPreflight({
      baseUrl: args.baseUrl,
      types,
      runnability,
      contributed: args.repo ? [repoWorkspaceCheck(args.repo)] : [],
      identities: requiredIdentities(
        args.tests,
        (test) => unrunnable.has(test.type) || repoBlocked.has(test.id),
      ),
      signIn: args.signIn,
    });

    /*
     * The per-test answer is RESOLVED HERE, into a plain Map, rather than asked
     * of the runner once per test inside the loop. Two reasons, and the second
     * one is the load-bearing one:
     *
     *  · the decision for a given test cannot change mid-suite, so asking it
     *    1,000 times is 1,000 scans over the same handful of checks; and
     *  · every call into the preflight API now lives inside this one
     *    try/catch. That is what makes the fail-open promise above true in
     *    practice: there is no second call site that can throw halfway through
     *    the suite, after results have already been written.
     */
    const blocked = new Map<string, { kind: NotRunKind; why: string; check: string }>();
    for (const test of args.tests) {
      const block = environmentBlock(preflight, test);
      if (block) blocked.set(test.id, { kind: block.kind, why: block.why, check: block.check });
    }

    const nothingRunnable = unattemptable(preflight, args.tests);
    /*
     * WHICH KIND of gap this is, decided from the per-test blocks rather than
     * from the first UNAVAILABLE check.
     *
     * "Every blocked test was blocked by a missing TOOL" is the only condition
     * under which this deployment, rather than the thing under test, is the
     * thing to fix — and it is deliberately "every one of them", the same rule
     * `completeShardedRun` applies to its shards: a slice where one type has no
     * tool and the base URL is also dead is a run that failed for two reasons,
     * and naming only the hole in our image would be the reassuring half of a
     * true answer.
     *
     * The blocks honour the preflight's order of explanation (tooling before
     * the base URL before the login), which is what makes this read the way a
     * human would act: an image with no k6 will still have no k6 after the VPN
     * is fixed.
     */
    const blockedKinds = new Set([...blocked.values()].map((block) => block.kind));
    const gapKind: NotRunKind | null = !nothingRunnable
      ? null
      : blockedKinds.size === 1 && blockedKinds.has('UNSUPPORTED')
        ? 'UNSUPPORTED'
        : 'BLOCKED_BY_ENV';
    return {
      checks: preflight.checks.map((check) => ({
        name: String(check.name),
        kind: check.kind,
        outcome: check.outcome,
        detail: check.detail,
      })),
      durationMs: preflight.durationMs,
      blocked,
      unattemptable: nothingRunnable,
      gapKind,
      /*
       * `preflight.reason` is the FIRST unavailable check's sentence, which is
       * the right one to lead with while the blocks agree about what went
       * wrong. When they do NOT — some tests blocked by a tool, others by the
       * environment — leading with one of them would describe half the cause
       * under a marker that names the other half, so the summary is used
       * instead and it names up to three of them.
       */
      reason: nothingRunnable
        ? blockedKinds.size > 1
          ? preflightSummary(preflight)
          : (preflight.reason ?? preflightSummary(preflight))
        : null,
    };
  } catch (err) {
    logger.error(
      { err, runId: args.runId },
      'the environment preflight itself failed; executing the suite as if it had not run',
    );
    return {
      checks: [],
      durationMs: 0,
      blocked: new Map(),
      unattemptable: false,
      gapKind: null,
      reason: null,
    };
  }
}

/**
 * A result the worker produced itself, without a plugin running anything.
 *
 * Two conditions reach for it, and the STATUS is the difference between them:
 * SKIPPED for "QAAI could not run this" (no repository checked out — the same
 * answer `reasonUnsupported` gives for a missing plugin), FAILED for "this test
 * asked for something that could not be produced" (a role whose profile would
 * not sign in). A skip does not block a gate and a failure does, which is
 * exactly the right way round: an environment gap is not the application's
 * fault, and a permission test that silently stopped running is not a pass.
 *
 * `durationMs` is zero because nothing was executed. Reporting an invented
 * duration here would put the test on the slowest-test list for work that never
 * happened.
 *
 * (The doc comment used to sit forty lines above the function, over
 * `interface PreflightTest`, describing neither.)
 */
function syntheticExecution(
  testId: string,
  status: 'SKIPPED' | 'FAILED',
  errorMessage: string,
  /**
   * The typed reason, when the caller has one.
   *
   * Threaded through rather than re-derived by `persistExecution` out of the
   * message it was handed, because the caller holds the kind as DATA and the
   * message is where it goes to become a string. Absent for the one caller that
   * has no kind — a test whose auth profile would not sign in, which is a
   * FAILED result and not a not-run at all — and absent is not `NOT_RUN`.
   */
  notRun?: { kind: NotRunKind; why: string },
): TestExecution {
  return {
    testId,
    status,
    durationMs: 0,
    steps: [],
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    errorMessage,
    retriedAndPassed: false,
    ...(notRun ? { notRun } : {}),
    findings: [],
  };
}

/**
 * Write the terminal state for a run whose JOB died.
 *
 * The processor's own failure path (above) covers everything that throws while
 * it is executing. This covers what is left: a job that never reached the
 * processor's try at all, or one whose failure handling itself blew up. BullMQ
 * hands those to `worker.on('failed')` and, before this existed, nothing else
 * ever looked at them — the run stayed at QUEUED or RUNNING permanently, the
 * cockpit's elapsed clock ran forever against a run nobody was executing, and
 * the `run.finished` notification that carries the Slack message and the PR
 * comment was never enqueued.
 *
 * The conditional update is the claim, the same one `completeShardedRun` uses:
 * `finalizedAt: null` matches once, so a run this rescues cannot also be
 * finalised by a shard. The status filter is what keeps it honest — a run that
 * already reported PASSED, FAILED or CANCELLED keeps that verdict, because a
 * job failing AFTER the run reported is not a reason to rewrite what it said.
 *
 * Returns whether it actually wrote anything, so the caller can log the
 * difference between a rescue and a no-op.
 */
export async function failRunFromDeadJob(args: {
  orgId: string;
  runId: string;
  errorMessage: string;
}): Promise<boolean> {
  const { orgId, runId, errorMessage } = args;

  /*
   * The caller reads these two straight off `job.data`, and a job BullMQ could
   * deserialise but that carries the wrong shape — one enqueued by an older
   * build, or by hand — leaves them undefined. Prisma reads an undefined
   * `where` value as "no filter", not as "matches nothing", so the claim below
   * would stop being scoped to one run and one org: `updateMany` would stamp
   * `finalizedAt` on every QUEUED or RUNNING run in the database across every
   * tenant, and `finalizeRun` would then write a terminal status and fire a
   * notification for whichever row `findFirst` happened to return first. One
   * malformed job would end every live run on the platform, in other people's
   * organisations, with a PR comment each.
   *
   * There is nothing to rescue without a run id, so this refuses rather than
   * guesses — and says so loudly, because a run job with no run in it is a
   * producer bug somebody needs to see.
   */
  if (!orgId || !runId) {
    logger.error(
      { orgId, runId, errorMessage },
      'a dead run job carried no org or run id; refusing to finalise an unscoped set of runs',
    );
    return false;
  }

  const run = await prisma.run.findFirst({
    where: { id: runId, orgId },
    select: {
      id: true,
      projectId: true,
      trigger: true,
      prNumber: true,
      project: { select: { gateRules: true, quarantineBudgetPercent: true } },
    },
  });
  if (!run) return false;

  // Counted before the claim rather than after: nothing is writing results to a
  // run whose job is dead, and reading first keeps this to a single write.
  const counts = await aggregateCounts(orgId, runId);

  const claim = await prisma.run.updateMany({
    where: { id: runId, orgId, finalizedAt: null, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { finalizedAt: new Date() },
  });
  if (claim.count === 0) return false;

  await finalizeRun({
    orgId,
    run: {
      id: run.id,
      projectId: run.projectId,
      trigger: run.trigger,
      prNumber: run.prNumber,
      gateRules: run.project.gateRules,
      quarantineBudgetPercent: run.project.quarantineBudgetPercent,
    },
    counts,
    errorMessage,
    forcedStatus: 'ERRORED',
  });
  return true;
}

/**
 * Write the run's terminal state: gates, counts, monitor streak, notification,
 * SSE. Called once per run — inline by an unsharded job, or by whichever shard
 * won the finalisation claim.
 */
async function finalizeRun(args: {
  orgId: string;
  run: {
    id: string;
    projectId: string;
    trigger: string;
    prNumber: number | null;
    gateRules: unknown;
    /** Null means "never configured"; the gate falls back to the documented default. */
    quarantineBudgetPercent?: number | null;
  };
  counts: RunCounts;
  errorMessage: string | null;
  /**
   * A run-level marker this function may hoist onto the front of
   * `errorMessage`, but ONLY if the run turns out to have been unattemptable.
   *
   * The sharded path cannot decide that itself and used to decide it anyway: it
   * hoisted ENVIRONMENT_UNAVAILABLE whenever every BROKEN shard was
   * environmental, which is not the same question as whether the RUN was
   * attemptable. Two shards, one env-dead and one that COMPLETED with a pass,
   * produced a run that said ENVIRONMENT_UNAVAILABLE while its own gate line
   * said part of the suite ran and `gateResult.passed` was true — a run
   * contradicting itself in the one field a program reads.
   *
   * So the detail arrives plain and the marker arrives separately, and the
   * prefix goes on only beside `unattemptable`, which is the meaning
   * @qaai/shared documents for it.
   */
  gapMarker?: NotRunKind | null;
  /** Overrides the pass/fail verdict: the run was cancelled, or a shard died. */
  forcedStatus: 'CANCELLED' | 'ERRORED' | null;
  /**
   * The preflight concluded that NOTHING in this run could be attempted. Set by
   * the processor, which is the only caller that knows; the sharded and
   * dead-job paths leave it out and the environment facts are read back off the
   * result rows instead, so all three paths report the same way.
   */
  unattemptable?: boolean;
}): Promise<void> {
  const { orgId, run, counts, forcedStatus } = args;
  let errorMessage = args.errorMessage;

  /*
   * ONE read of the result rows, for three questions that must agree about
   * them: the gate's evaluations, the environment summary, and (on the paths
   * that recount) the counters. Two reads is how a gate came to be scored
   * against a different set of rows than the counts were.
   */
  const rows = await readRunResults(orgId, run.id);
  const environment = environmentSummary(rows);

  /*
   * Whether something asked this run to stop early, read off the row rather
   * than carried in from the caller — for the reason the environment summary is
   * derived from the result rows: a SHARD knows it stopped and not whether its
   * siblings did, `failRunFromDeadJob` knows nothing at all, and all three
   * paths have to report the same run. The request may have been written by the
   * inline fail-fast check, by the sweep in schedule.ts, or by a person
   * pressing stop in the cockpit; none of them is this function's business, and
   * the sentence they wrote is what gets reported.
   */
  const stop = await prisma.run
    .findUnique({ where: { id: run.id }, select: { stopRequestedAt: true, stopReason: true } })
    .catch((err: unknown) => {
      /*
       * Logged rather than swallowed. A run must not fail to finalise because
       * one read failed — the `updateMany` two statements down would fail too,
       * so this is close to unreachable — but the frame below would then say
       * `stopped: null` for a run that may well have been halted, and a
       * "nothing happened" that is really "we could not look" is the one shape
       * of silence this file exists to remove.
       */
      logger.warn(
        { err, runId: run.id },
        'could not read whether this run was asked to stop; the finished frame will not say',
      );
      return null;
    });
  const stopped =
    stop?.stopRequestedAt != null
      ? { at: stop.stopRequestedAt, reason: stop.stopReason ?? null }
      : null;

  /*
   * ── THE SUPPRESSION LEDGER, READ ONCE, BEFORE THE GATE ───────────────────
   *
   * "47 failures suppressed by 3 known issues" has to appear on the surface a
   * release decision is made from, or a team learns to ignore the board — which
   * is the one thing that would make this product worse than nothing. Until
   * this read existed, `runOutcome` could only see QUARANTINE, so a run that
   * passed while a known issue silenced forty failures said nothing at all.
   *
   * Read BEFORE the gate, because `runOutcome` composes the sentence the CLI
   * prints and the GitHub check shows, and a sentence computed after the
   * verdict is a sentence the verdict cannot mention.
   */
  const suppressions = await suppressionTalliesFor(orgId, run.id);

  const gateResult = await evaluateRunGates(
    orgId,
    rows,
    run.projectId,
    run.gateRules,
    run.quarantineBudgetPercent,
  );

  /*
   * ── The environment, as a gate evaluation ────────────────────────────────
   *
   * BLOCK when nothing could be attempted: there is no evidence about this
   * change, and a merge gate must not open on a run that did not happen. WARN
   * when only part of the suite was blocked, or when failures were triaged as
   * the environment's fault — a WARN is still rendered by the chat alert, the
   * check summary, the CLI and the run page, and it does not hold a release
   * hostage to one rotated password.
   *
   * Appended after `evaluateGates` rather than inside it because a project's
   * own rule list must not be able to switch it off, which is the same reason
   * the quarantine alarm is appended there. `passed` is recomputed from the
   * evaluations, since `evaluateGates` could not see this one.
   */
  /*
   * Derived when the caller did not say, so the three finalisation paths cannot
   * disagree: a SHARD knows its own slice was unattemptable but not whether its
   * siblings' were, and `failRunFromDeadJob` knows nothing at all. "Every row
   * in the run is blocked or unsupported" is the same question asked of the
   * rows, and the rows are the only place that holds the whole run.
   */
  const unattemptable =
    args.unattemptable ??
    (rows.length > 0 &&
      environment.blockedByEnv.length + environment.unsupported.length === rows.length);

  const environmentEvaluation = environmentGateEvaluation(environment, unattemptable);
  if (environmentEvaluation) {
    gateResult.evaluations.push(environmentEvaluation);
    gateResult.passed = gateResult.evaluations.every((e) => e.action !== 'BLOCK');
  }

  /*
   * The marker, now that `unattemptable` has been derived from the rows — the
   * only place that holds the whole run. See `gapMarker` above for the
   * self-contradicting run this ordering exists to prevent. A caller that
   * passes no marker is unaffected: the unsharded path has already applied its
   * own, because its slice IS the run.
   */
  if (args.gapMarker != null && errorMessage !== null && unattemptable) {
    errorMessage = runGapMessage(args.gapMarker, errorMessage);
  }

  /*
   * ── ENV_ISSUE, finally leading somewhere ─────────────────────────────────
   *
   * The fourth triage verdict has existed since the beginning and changed
   * nothing: `BLOCKING_VERDICTS` is REAL_BUG alone, so an ENV_ISSUE never
   * blocked the gate — and it did not have to, because the FAILED result had
   * already put the run's status at FAILED through `counts.failed`. A board red
   * from an expired credential was byte-identical to a board red from a bug.
   *
   * So when every failure that gates was triaged ENV_ISSUE, the run reports
   * ERRORED-with-a-reason instead of FAILED. What is deliberately NOT done is
   * rewriting the counters: `failedCount` still says three tests failed,
   * because three tests did fail, and the five columns still sum to the number
   * of results. Moving those failures into a sixth bucket would need a column
   * this change does not own — see the report — and moving them into `skipped`
   * is the same mistake in a kinder word that gates.ts already refuses for
   * quarantine.
   *
   * Only when nobody has already decided: a cancel, a dead shard or an
   * unattemptable run has a better answer than this one, and the `errorMessage`
   * guard keeps this from overwriting theirs.
   */
  let forced = forcedStatus;
  if (
    forced === null &&
    errorMessage === null &&
    environment.envIssueFailures.length > 0 &&
    environment.envIssueFailures.length >= environment.gatingFailures
  ) {
    forced = 'ERRORED';
    errorMessage = environmentUnavailableMessage(
      `All ${environment.gatingFailures} failing test(s) in this run were triaged as environment ` +
        `issues rather than defects (${nameList(environment.envIssueFailures)}). The run is not a ` +
        'verdict on your application; fix the environment and re-run.',
    );
  }

  /*
   * The verdict is NOT computed here any more.
   *
   * It was `counts.failed > 0 || !gateResult.passed`, and four other places in
   * the product wrote their own version of the same expression off a different
   * field — the CLI's exit code, the GitHub check's conclusion, the JUnit
   * XML's `failures` attribute, the on-prem finaliser. Fixing quarantine in one
   * of them was invisible to the other four, which is exactly how quarantine
   * came to suppress the signal without stopping the gate. `runOutcome` is the
   * only function allowed to answer the question; see packages/runner/gates.ts.
   */
  const outcome = runOutcome({
    counts,
    gatePassed: gateResult.passed,
    forcedStatus: forced,
    suppressions: suppressions.tallies,
  });
  const status = outcome.status;

  /*
   * A cancel that lands while setup is in flight must still win.
   *
   * This write used to be unconditional, which reopened the defect the
   * conditional start was added to close, one layer down: a run cancelled
   * after `secretsFor` was awaited and before the catch ran would be stamped
   * ERRORED here, and the cockpit — which already said "cancelled" — would
   * flip to a failure the user did not cause. `updateMany` with the status
   * filter makes the cancel authoritative: CANCELLED is terminal, and nothing
   * that arrives afterwards may relabel it.
   *
   * A cancel is still allowed to be WRITTEN by this function (forcedStatus
   * 'CANCELLED' is how a mid-flight stop finalises), so CANCELLED is excluded
   * from the filter only when it is not the status being written.
   */
  const wrote = await prisma.run.updateMany({
    where:
      status === 'CANCELLED' ? { id: run.id } : { id: run.id, status: { notIn: ['CANCELLED'] } },
    data: {
      status,
      finishedAt: new Date(),
      passedCount: counts.passed,
      failedCount: counts.failed,
      flakyCount: counts.flaky,
      skippedCount: counts.skipped,
      quarantinedFailedCount: counts.quarantinedFailed,
      gateResult: gateResult as unknown as object,
      errorMessage,
    },
  });

  /*
   * Nothing was written, so the run is already CANCELLED. Everything below —
   * the monitor streak, the notification, the SSE frame — describes a terminal
   * state this call did not produce; sending it would announce a status the row
   * does not have, which is the reassuring-lie failure this file exists to avoid.
   */
  if (wrote.count === 0) {
    logger.info({ runId: run.id, status }, 'run was cancelled first; not relabelling it');
    return;
  }

  // A monitor-triggered run updates its streak, and pages once the threshold
  // is crossed rather than on every blip.
  if (run.trigger === 'MONITOR') {
    await recordMonitorResult(orgId, run.id, status).catch((err) =>
      logger.warn({ err, runId: run.id }, 'could not record the monitor result'),
    );
  }

  /**
   * Every finished run notifies. The processor decides who hears about it: a
   * PR-triggered run gets a comment, and any failing run reaches chat. Gating
   * the enqueue on prNumber (as this used to) meant a nightly schedule could
   * fail all night in silence, which is the exact failure a schedule exists to
   * prevent.
   *
   * Fire-and-forget: a notification that fails to send must never fail the run
   * that produced it.
   */
  await enqueueNotify({
    orgId,
    event: 'run.finished',
    payload: { runId: run.id, ...(run.prNumber ? { prNumber: run.prNumber } : {}) },
  }).catch((err) => logger.warn({ err, runId: run.id }, 'could not enqueue the notification'));

  publishEvent(orgId, {
    runId: run.id,
    type: 'run.finished',
    data: {
      status,
      ...counts,
      gatePassed: gateResult.passed,
      /*
       * Carried on the frame rather than left to the cockpit to re-derive. A
       * run that passed with suppressed failures must be able to SAY so live,
       * not only once somebody opens the run page.
       *
       * NESTED under `verdict`, and that is not tidiness: `...counts` already
       * spreads a `passed` key holding the number of PASSING TESTS, and a
       * top-level `passed: boolean` beside it silently replaced that count with
       * `false` on every cancelled run. Caught by the cockpit's own test, which
       * is the reason it has one.
       */
      verdict: {
        passed: outcome.passed,
        suppressedFailures: outcome.suppressedFailures,
        reason: outcome.reason,
      },
      /*
       * The environment's own line on the frame, nested for exactly the reason
       * `verdict` is: `...counts` already spreads keys, and a top-level
       * `blocked` or `unsupported` beside it is one rename away from silently
       * replacing a count. A run that reports PASSED with eleven tests nobody
       * could execute has to be able to SAY so live, not only once somebody
       * opens the run page.
       */
      environment: {
        unattemptable,
        blockedByEnv: environment.blockedByEnv.length,
        unsupported: environment.unsupported.length,
        cancelled: environment.cancelled,
        /*
         * Two fields, because they were one and the one was wrong.
         * `notReached` is rows tagged NOT_RUN — a dead shard's slice, or the
         * tail of a run that stopped early — and `notRecorded` is rows carrying
         * no reason at all. `notRecorded` keeps its name so the cockpit's
         * existing read keeps working, and it now means what it says.
         */
        notReached: environment.notRun,
        notRecorded: environment.untagged,
        envIssueFailures: environment.envIssueFailures.length,
      },
      /*
       * THE STOP, on the frame, and why it has to be on it.
       *
       * A stopped run finalises on its real counts, which is right for the case
       * that writes the request most often: fail-fast trips on a real failure,
       * so the run is FAILED and the verdict already says so. It is NOT the
       * whole story for a person pressing stop on a suite that was green so far
       * — that run reports PASSED with tests nobody executed, which is the hole
       * this file's header already names for a partially-blocked environment,
       * and the same honest remedy applies: a configurable MIN_ATTEMPTED_RATE
       * gate rule, which needs a `GateRule` kind this change cannot add (see
       * the handover). Until that exists the stop is PUBLISHED rather than
       * pretended away — the frame carries that the run was halted, how many
       * tests were never reached, and the sentence whoever halted it wrote.
       */
      stopped: stopped
        ? { at: stopped.at.toISOString(), reason: stopped.reason, notReached: environment.notRun }
        : null,
    },
    at: new Date().toISOString(),
  });

  logger.info(
    {
      runId: run.id,
      status,
      ...counts,
      reason: outcome.reason,
      blockedByEnv: environment.blockedByEnv.length,
      unsupported: environment.unsupported.length,
      notReached: environment.notRun,
      notRecorded: environment.untagged,
      envIssueFailures: environment.envIssueFailures.length,
      stopRequested: stopped !== null,
    },
    'run finished',
  );
}

/**
 * Take ownership of a shard's slice, or decline to run it.
 *
 * The conditional update is the lock. A shard is claimable when it is QUEUED,
 * or when it is RUNNING but has stopped breathing — BullMQ moves a stalled job
 * back to the queue when the worker holding it dies, and a redelivered job
 * picking its own slice back up is much better than leaving it to be reaped.
 * Anything else (terminal, or actively held by a live worker) means this job
 * must not execute, and returning false is how it says so.
 */
async function claimShard(orgId: string, runId: string, shard: RunShardRef): Promise<boolean> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_SHARD_MS);

  const claim = await prisma.runShard.updateMany({
    where: {
      orgId,
      runId,
      index: shard.index,
      OR: [
        { status: 'QUEUED' },
        { status: 'RUNNING', heartbeatAt: { lt: staleBefore } },
        { status: 'RUNNING', heartbeatAt: null, startedAt: { lt: staleBefore } },
      ],
    },
    data: { status: 'RUNNING', startedAt: now, heartbeatAt: now, errorMessage: null },
  });
  if (claim.count > 0) return true;

  const row = await prisma.runShard.findUnique({
    where: { runId_index: { runId, index: shard.index } },
    select: { status: true },
  });

  /*
   * No row at all means the queue job and the split disagree — most likely a
   * job enqueued before the shard tables existed. Guessing is the dangerous
   * option: without `shardIndex` to filter on, the slice query returns nothing
   * and the run would report a clean pass over zero tests.
   */
  if (!row) {
    throw new Error(
      `Run ${runId} has no shard ${shard.index}; refusing to run a slice whose membership is unknown`,
    );
  }

  logger.info(
    { runId, shard: shard.index, status: row.status },
    'shard not claimable; it is already finished or another worker holds it',
  );
  return false;
}

/**
 * Reap shards whose worker died.
 *
 * The rule, stated plainly: **a RUNNING shard that has not stamped a heartbeat
 * for STALE_SHARD_MS is declared ABANDONED, and its run can never report
 * PASSED.** Something has to say so, or one crashed worker leaves a run RUNNING
 * forever and the suite it was gating never reports at all.
 *
 * QUEUED shards are reaped only on age, only by the scheduler sweep, and only
 * past STALE_QUEUED_SHARD_MS — see `queuedSince` below. A shard sitting in the
 * queue has not been picked up yet, which on a busy pool is normal and expected:
 * with four workers and fifteen shards, the last shard is queued for as long as
 * the first eleven take. Reaping one on the sibling path would abandon work that
 * was about to run, so this function's callers on that path pass null and the
 * queue is left alone entirely.
 *
 * The update is conditional on the same staleness it tested, so a shard that
 * comes back to life between the read and the write keeps its slice. The same
 * holds for the queued sweep: a worker that picks the job up first wins the
 * `status: 'QUEUED'` match, and one that picks it up after the reap finds the
 * row ABANDONED and `claimShard` declines it. There is no window in which both
 * happen.
 */
async function reapDeadShards(
  orgId: string,
  runId: string,
  /**
   * When set, ALSO reap shards that have been QUEUED since before this instant
   * — their queue job is gone and nothing will ever pick them up. Null on the
   * sibling path, where a queued shard means "not yet", not "never".
   */
  queuedSince: Date | null = null,
): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_SHARD_MS);

  const reaped = await prisma.runShard.updateMany({
    where: {
      orgId,
      runId,
      status: 'RUNNING',
      OR: [
        { heartbeatAt: { lt: staleBefore } },
        { heartbeatAt: null, startedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: 'ABANDONED',
      finishedAt: new Date(),
      errorMessage: `No heartbeat for ${Math.round(STALE_SHARD_MS / 1000)}s — the worker running this shard is gone, and the tests in it did not run.`,
    },
  });

  if (reaped.count > 0) {
    logger.error({ runId, shards: reaped.count }, 'reaped shards whose worker went silent');
  }
  if (!queuedSince) return reaped.count;

  /*
   * The lost-job case. This shard was never picked up by anybody: no startedAt,
   * no heartbeat, nothing above would ever match it, and `completeShardedRun`
   * counts it as pending forever. It is the reason a sharded run whose jobs are
   * flushed out of Redis hangs with no verdict.
   *
   * Filtered on the shard's own `queuedAt` rather than the run's age, because
   * that is when THIS slice started waiting.
   */
  const lost = await prisma.runShard.updateMany({
    where: { orgId, runId, status: 'QUEUED', queuedAt: { lt: queuedSince } },
    data: {
      status: 'ABANDONED',
      finishedAt: new Date(),
      errorMessage:
        `Queued for over ${Math.round(STALE_QUEUED_SHARD_MS / 60_000)} minutes and never picked up — ` +
        `the job for this shard is gone. The tests in it did not run; re-run to execute them.`,
    },
  });

  if (lost.count > 0) {
    logger.error(
      { runId, shards: lost.count, queuedSince },
      'reaped shards whose queue job was never delivered',
    );
  }
  return reaped.count + lost.count;
}

/**
 * The completion rule for a sharded run, and the single invariant this whole
 * feature stands on:
 *
 *   **A sharded run is finished when EVERY shard is finished. Never before.**
 *
 * The failure this exists to prevent is specific and would be the worst bug in
 * the product: shard 1 finishes green, writes PASSED, a merge gate opens, and
 * shard 3 is still executing the tests that would have failed. So no shard
 * writes the run's status on its own behalf. Each one records that *it* is
 * done, then asks whether every sibling is; the last one to be able to answer
 * yes finalises.
 *
 * Two shards can answer yes at the same instant. The tiebreak is a conditional
 * UPDATE on `finalizedAt`: it matches only while the column is null, so exactly
 * one of them gets a row back and the loser returns. No advisory lock, no
 * Redis key — the database already serialises this for free.
 *
 * Order is load-bearing. The caller marks its own shard terminal *before*
 * calling in, so the last shard to commit is guaranteed to see a complete
 * picture. Read-then-mark would let two shards each see the other as still
 * running and neither would finalise.
 */
async function completeShardedRun(args: {
  orgId: string;
  run: {
    id: string;
    projectId: string;
    trigger: string;
    prNumber: number | null;
    gateRules: unknown;
    quarantineBudgetPercent?: number | null;
  };
  /** The shard that finished, or null when the scheduler sweep is asking. */
  shardIndex: number | null;
}): Promise<void> {
  const { orgId, run, shardIndex } = args;
  const bySweep = shardIndex === null;

  /*
   * Only the sweep may reap on queue age. A shard finishing has no idea how
   * long the pool is, and reaping a sibling that is simply waiting its turn
   * would skip its tests — so the sibling path passes null and never touches a
   * QUEUED row.
   */
  await reapDeadShards(
    orgId,
    run.id,
    bySweep ? new Date(Date.now() - STALE_QUEUED_SHARD_MS) : null,
  );

  const shards = await prisma.runShard.findMany({
    where: { orgId, runId: run.id },
    select: { index: true, status: true, errorMessage: true },
    orderBy: { index: 'asc' },
  });

  /*
   * No shard rows at all. Every check below is a question about rows, and an
   * empty set answers all of them with "nothing is pending" — which would
   * finalise the run on the spot, over placeholder results, as a clean pass
   * across a suite that never executed. That is the single worst outcome this
   * feature has, so it is refused rather than reasoned about.
   *
   * Callers are supposed to make it impossible: a shard only calls in after
   * writing its own row, and the sweep filters on `shardCount > 1`. Reaching
   * here anyway means the run row and the shard table disagree, and a run stuck
   * with no verdict is a much better failure than a green one.
   */
  if (shards.length === 0) {
    logger.error(
      { runId: run.id, shard: shardIndex },
      'a run marked as sharded has no shard rows; refusing to finalise a suite whose slices are unknown',
    );
    return;
  }

  const pending = shards.filter((s) => !RUN_SHARD_TERMINAL.includes(s.status));
  if (pending.length > 0) {
    // The sweep asks about every long-running sharded run once a minute, and
    // "still running" is its normal answer — that is a debug line, not news.
    const say = bySweep ? logger.debug.bind(logger) : logger.info.bind(logger);
    say(
      { runId: run.id, shard: shardIndex, waitingOn: pending.map((s) => s.index) },
      bySweep
        ? 'sweep: the run is still waiting on shards that are alive'
        : 'shard finished; the run is still waiting on its siblings',
    );
    return;
  }

  const claim = await prisma.run.updateMany({
    where: { id: run.id, orgId, finalizedAt: null },
    data: { finalizedAt: new Date() },
  });
  if (claim.count === 0) {
    logger.info(
      { runId: run.id, shard: shardIndex },
      'another shard is finalising this run; standing down',
    );
    return;
  }

  const counts = await aggregateCounts(orgId, run.id);
  const current = await prisma.run.findUnique({
    where: { id: run.id },
    select: { status: true },
  });

  const cancelled = current?.status === 'CANCELLED' || shards.some((s) => s.status === 'CANCELLED');
  // A shard that died or blew up leaves tests that never executed. Those results
  // are still sitting at their placeholder SKIPPED, so the counts are honest —
  // but the run's verdict must not be: an incomplete suite cannot pass a gate.
  const broken = shards.filter((s) => s.status === 'ABANDONED' || s.status === 'FAILED');

  /*
   * ── The sharded run's own run-level marker ───────────────────────────────
   *
   * Composing the shards' messages buried the prefix mid-string — "2 of 2
   * shards did not complete (shard 0: ENVIRONMENT_UNAVAILABLE: …)" — and a
   * prefix in the middle of a sentence is not a prefix: nothing downstream
   * could tell that a sharded run had been unattemptable, while the identical
   * unsharded run said so in its first word. So when every shard that failed
   * failed for THE SAME KIND of gap, the composed message carries that marker
   * at the front and the per-shard detail follows it.
   *
   * "Every one of them, and the same one" rather than "any of them": a shard
   * whose worker blew up alongside one whose environment was down is a run that
   * failed for two reasons, and naming only the kinder one would be the
   * reassuring half of a true answer. A shard with no k6 alongside one with a
   * dead base URL is the same situation in a subtler form, and gets the same
   * answer — the plain wording, with both sentences in it.
   *
   * The marker is HANDED TO `finalizeRun` rather than applied here, because
   * whether the RUN was unattemptable is a question about its rows and this
   * function cannot see them: see `gapMarker` on that function.
   */
  const brokenGaps = broken.map((s) => runGapReason(s.errorMessage));
  const gapKinds = new Set(brokenGaps.map((gap) => gap?.kind ?? null));
  const gapMarker: NotRunKind | null =
    broken.length > 0 && gapKinds.size === 1 && !gapKinds.has(null)
      ? (brokenGaps[0]?.kind ?? null)
      : null;
  const shardDetail = broken
    .map(
      (s, i) =>
        `shard ${s.index}: ${(gapMarker ? brokenGaps[i]?.reason : s.errorMessage) ?? s.status.toLowerCase()}`,
    )
    .join('; ');

  const errorMessage =
    broken.length === 0
      ? null
      : gapMarker
        ? `${broken.length} of ${shards.length} shards could not be attempted (${shardDetail})`
        : `${broken.length} of ${shards.length} shards did not complete (${shardDetail})`;

  /*
   * A dead or failed shard leaves its slice sitting at the placeholder SKIPPED,
   * and that placeholder used to be indistinguishable from a test somebody
   * deliberately skipped — the exact confusion the typed kinds exist to end.
   * NOT_RUN is the honest label: nobody reached these, and this process cannot
   * say why beyond what the shard's own `errorMessage` recorded.
   *
   * One `updateMany` per broken shard, over rows nothing has written to, after
   * the counts were read (the status does not change, only the message, so the
   * order costs nothing but is worth being deliberate about).
   */
  for (const dead of broken) {
    await stampNotRun(
      orgId,
      run.id,
      { index: dead.index, count: shards.length },
      'NOT_RUN',
      `Shard ${dead.index} did not complete, so this test was never reached. ${
        dead.errorMessage ?? `The shard ended ${dead.status.toLowerCase()}.`
      }`,
    );
  }

  await finalizeRun({
    orgId,
    run,
    counts,
    errorMessage,
    gapMarker,
    forcedStatus: cancelled ? 'CANCELLED' : broken.length > 0 ? 'ERRORED' : null,
  });
}

/**
 * The safety net under the completion rule: sweep sharded runs nobody will
 * finish.
 *
 * `completeShardedRun` only ever executes when *some* shard finishes, and that
 * is the hole. Kill the worker holding shard 0 while its siblings are seconds
 * from done, and the siblings finish first: each one looks, sees shard 0 still
 * RUNNING with a heartbeat forty seconds old — not yet stale — and stands down.
 * After that nothing ever asks again. BullMQ redelivers the dead shard's job
 * about thirty seconds later, `claimShard` correctly declines because the
 * heartbeat is still fresh, and the run sits at RUNNING for good: no verdict, no
 * notification, and a merge gate waiting on a run that will never report.
 *
 * That was observed, not theorised — a three-shard run held RUNNING for eight
 * minutes after its worker was killed, with every sibling terminal.
 *
 * So the reaper needs a caller that does not depend on a shard finishing. This
 * is it, on the scheduler's one-minute tick, and it is deliberately the same
 * code path: reap what is stale, and if that leaves every shard terminal,
 * finalise exactly as the last shard would have. A run with living shards is
 * untouched however long it takes.
 *
 * ── The second hole: a run that never started ───────────────────────────────
 * This used to look only at runs already in RUNNING, which meant it could not
 * see the case where the jobs are lost while every shard is still QUEUED — a
 * flushed Redis, or a queue drained by hand. Nothing had picked a slice up, so
 * `startedAt` was null and the run's status was still QUEUED, and the sweep's
 * own filter excluded it from the sweep that exists to rescue it. That run hung
 * forever with no verdict at all.
 *
 * Both statuses are candidates now, aged on `queuedAt` (which every run has)
 * rather than `startedAt` (which a never-started run does not). `queuedAt` is
 * always at or before `startedAt`, so this admits strictly more than the old
 * filter did and can never miss a run it used to catch — the reaping conditions,
 * not the prefilter, are what decide anything.
 */
export async function sweepStalledShardedRuns(): Promise<number> {
  // Only runs old enough that a dead shard would already be past the staleness
  // window. Younger ones cannot have anything to reap, and a shard that is
  // simply queued behind a busy pool must never be mistaken for a dead one —
  // that one is held to the far longer STALE_QUEUED_SHARD_MS, applied per shard
  // inside reapDeadShards.
  const before = new Date(Date.now() - STALE_SHARD_MS);

  const candidates = await prisma.run.findMany({
    where: {
      status: { in: ['QUEUED', 'RUNNING'] },
      /*
       * Sharded runs only, and this filter is load-bearing rather than an
       * optimisation. An UNSHARDED run has no RunShard rows, so handing one to
       * `completeShardedRun` would ask "are all its shards terminal?" of an
       * empty set. That guard is now inside the function too, but the run also
       * simply does not belong here: a stuck unsharded run needs a different
       * remedy, and inventing one on this tick is how a suite that never
       * executed reports a clean pass.
       */
      shardCount: { gt: 1 },
      finalizedAt: null,
      queuedAt: { lt: before },
    },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      trigger: true,
      prNumber: true,
      project: { select: { gateRules: true, quarantineBudgetPercent: true } },
    },
    // Oldest first. With the cap below, a pool holding more than 100 live
    // sharded runs would otherwise leave the same unlucky run unswept tick
    // after tick — and age is exactly the signal that says which ones are worth
    // looking at, since a healthy run leaves the candidate set by finishing.
    orderBy: { queuedAt: 'asc' },
    // A bounded sweep: whatever is left waits for the next tick rather than
    // holding the tick open behind an unbounded scan.
    take: 100,
  });

  let finalised = 0;
  for (const run of candidates) {
    try {
      const before = await prisma.run.findUnique({
        where: { id: run.id },
        select: { finalizedAt: true },
      });
      await completeShardedRun({
        orgId: run.orgId,
        run: {
          id: run.id,
          projectId: run.projectId,
          trigger: run.trigger,
          prNumber: run.prNumber,
          gateRules: run.project.gateRules,
          quarantineBudgetPercent: run.project.quarantineBudgetPercent,
        },
        shardIndex: null,
      });
      const after = await prisma.run.findUnique({
        where: { id: run.id },
        select: { finalizedAt: true, status: true },
      });
      if (before?.finalizedAt === null && after?.finalizedAt !== null) {
        finalised += 1;
        logger.error(
          { runId: run.id, status: after?.status },
          'sweep finalised a sharded run whose worker never came back',
        );
      }
    } catch (err) {
      // One unfinishable run must not stop the sweep reaching the next.
      logger.error({ err, runId: run.id }, 'could not sweep this sharded run');
    }
  }
  return finalised;
}

/**
 * Counts for the whole run, read back from the result rows.
 *
 * A shard sees only its own slice, so the in-memory counters that serve an
 * unsharded run cannot add up here. Summing the per-shard counters would work
 * on a good day and lie on a bad one — an abandoned shard's counters were never
 * written. The result rows are what the cockpit renders and what the gate
 * scores, so counting them is counting the thing itself rather than a report
 * of it. Tests that never ran are still at their placeholder SKIPPED and are
 * counted as skipped, which is exactly what happened to them.
 *
 * ── Why this is no longer a `groupBy` ───────────────────────────────────────
 *
 * It was `groupBy({ by: ['status'] })`, and that is a large part of why the
 * quarantine defect survived: Prisma cannot group by a RELATION's column, so
 * this function was structurally incapable of seeing `Test.quarantined`. A
 * quarantined failure therefore landed in `counts.failed` on every sharded run,
 * every dead-job rescue and every cancel, and from there in the run's status.
 *
 * So it reads the rows and the quarantine state with them. That is the same
 * read `evaluateRunGates` already made a line later, which is why the two are
 * one query now (`readRunResults`) instead of two — the recount is cheaper than
 * the pair it replaces, not more expensive.
 */
async function aggregateCounts(orgId: string, runId: string): Promise<RunCounts> {
  return tallyRows(await readRunResults(orgId, runId));
}

/** The shape every verdict in this file is computed from. One read, two uses. */
type RunResultRow = Awaited<ReturnType<typeof readRunResults>>[number];

async function readRunResults(orgId: string, runId: string) {
  return prisma.testResult.findMany({
    where: { runId, orgId },
    select: {
      testId: true,
      status: true,
      retriedAndPassed: true,
      durationMs: true,
      /*
       * The message, because it carries the typed not-run tag (see
       * `notRunMessage` in @qaai/shared). Without it a SKIPPED row is just a
       * skip again at finalisation, and "eleven tests were blocked by a dead
       * staging box" could not be said on the frame, in the log, or on the
       * gate — which is the whole defect this read exists to close.
       */
      errorMessage: true,
      test: {
        select: {
          name: true,
          priority: true,
          quarantined: true,
          // The expiry, because an expired quarantine GATES AGAIN. Reading
          // `quarantined` alone would keep honouring a suppression that ran
          // out two weeks ago.
          quarantineExpiresAt: true,
        },
      },
      verdict: { select: { verdict: true, overriddenTo: true, reviewState: true } },
    },
  });
}

/**
 * What the environment did to this run, read off the rows it produced.
 *
 * Derived from the PERSISTED results rather than carried in memory, and that is
 * what lets all three finalisation paths say the same thing: the unsharded
 * processor, `completeShardedRun` (where five workers each hold a fifth of the
 * picture and none of them holds the run's) and `failRunFromDeadJob` (where the
 * process that had the picture is gone). A field on an in-memory counter would
 * be correct on exactly one of those three.
 *
 * `untagged` is the honesty field. A SKIPPED row with no tag is NOT scored as
 * any kind — a plugin's own "k6 is not installed" skip still writes a bare
 * sentence today, and rows written before the tag existed carry nothing. They
 * are counted as unexplained rather than folded into the nearest category,
 * because folding them in would invent the very distinction this is here to
 * report.
 */
interface EnvironmentSummary {
  /** Failures that GATE, quarantine-suppressed ones excluded. The denominator. */
  gatingFailures: number;
  /** Gating failures a human or the triage agent called the environment's fault. */
  envIssueFailures: Array<{ testName: string }>;
  blockedByEnv: Array<{ testName: string }>;
  unsupported: Array<{ testName: string }>;
  cancelled: number;
  /**
   * SKIPPED rows tagged NOT_RUN: nobody reached them, and nothing knows why
   * beyond that.
   *
   * Its own field, and it used to be added to `untagged`, under a doc comment
   * on that field saying "carrying no typed reason" — so the count of rows
   * nothing had explained silently included the rows something HAD explained,
   * and the comment contradicted the code three lines below it. They are
   * different facts with different remedies: a dead shard's slice is a re-run,
   * and an untagged skip is a writer that has not learned to tag yet.
   */
  notRun: number;
  /**
   * SKIPPED rows carrying no typed reason at all. Reported, never classified.
   *
   * A plugin's own "k6 is not installed" skip still writes a bare sentence
   * today, and rows written before the tag existed carry nothing. Folding them
   * into the nearest category would invent the very distinction this is here to
   * report.
   */
  untagged: number;
}

function environmentSummary(
  rows: readonly RunResultRow[],
  now: Date = new Date(),
): EnvironmentSummary {
  const summary: EnvironmentSummary = {
    gatingFailures: 0,
    envIssueFailures: [],
    blockedByEnv: [],
    unsupported: [],
    cancelled: 0,
    notRun: 0,
    untagged: 0,
  };

  for (const row of rows) {
    const testName = row.test.name;

    if (row.status === 'SKIPPED') {
      const tag = parseNotRun(row.errorMessage);
      if (tag === null) {
        summary.untagged += 1;
      } else if (tag.kind === 'BLOCKED_BY_ENV') {
        summary.blockedByEnv.push({ testName });
      } else if (tag.kind === 'UNSUPPORTED') {
        summary.unsupported.push({ testName });
      } else if (tag.kind === 'CANCELLED') {
        summary.cancelled += 1;
      } else {
        /*
         * NOT_RUN: recorded, and deliberately in no other bucket. "Nobody
         * reached this" is weaker than every other claim here — but it IS a
         * claim, which is why it no longer lands in `untagged` beside the rows
         * nothing said anything about.
         */
        summary.notRun += 1;
      }
      continue;
    }

    if (row.status !== 'FAILED' && row.status !== 'TIMED_OUT') continue;
    // A quarantine in force already keeps this failure out of `counts.failed`,
    // so counting it here would double-suppress and let one quarantined
    // environment failure decide the whole run's verdict.
    if (quarantineSuppresses(row.test, now)) continue;

    summary.gatingFailures += 1;
    // A human override beats the model, always — the same rule the gate applies.
    const verdict =
      row.verdict?.reviewState === 'OVERRIDDEN'
        ? (row.verdict.overriddenTo ?? row.verdict.verdict)
        : (row.verdict?.verdict ?? null);
    if (verdict === 'ENV_ISSUE') summary.envIssueFailures.push({ testName });
  }

  return summary;
}

/** Up to three names, then a count. Same shape, and same reason, as gates.ts. */
function nameList(rows: ReadonlyArray<{ testName: string }>): string {
  const head = rows.slice(0, ENVIRONMENT_NAMES_LISTED).map((r) => r.testName);
  return rows.length > ENVIRONMENT_NAMES_LISTED
    ? `${head.join(', ')} and ${rows.length - ENVIRONMENT_NAMES_LISTED} more`
    : head.join(', ');
}

/**
 * The environment's gate line, or null when there is nothing to say.
 *
 * BLOCK for an unattemptable run and WARN for everything else, which is the
 * policy decision in this change and is worth stating plainly:
 *
 *  · BLOCK when NOTHING ran. There is no evidence about the change, so no merge
 *    may open on the strength of this run. The status is ERRORED beside it, so
 *    a reader sees "could not run" rather than "failed".
 *  · WARN when only part of the suite was blocked. 400 passing tests are still
 *    400 passing tests, and holding every release because one role's password
 *    rotated is how a brake gets switched off by the people it protects. The
 *    cost is named rather than hidden: such a run CAN still report PASSED with
 *    tests nobody executed, and the honest remedy is a project-configurable
 *    minimum-attempted rule in gates.ts — see the report.
 *  · WARN for ENV_ISSUE failures, because `BLOCKING_VERDICTS` says ENV_ISSUE
 *    "alerts but never gates" and this is the alert. The run's ERRORED status,
 *    written above, is what keeps it out of the green column.
 */
function environmentGateEvaluation(
  summary: EnvironmentSummary,
  unattemptable: boolean,
): GateResultEvaluation | null {
  const notRun = summary.blockedByEnv.length + summary.unsupported.length;
  if (notRun === 0 && summary.envIssueFailures.length === 0) return null;

  const parts: string[] = [];
  if (summary.blockedByEnv.length > 0) {
    parts.push(
      `${summary.blockedByEnv.length} test(s) could not be attempted because the environment was ` +
        `not usable (${nameList(summary.blockedByEnv)})`,
    );
  }
  if (summary.unsupported.length > 0) {
    parts.push(
      `${summary.unsupported.length} test(s) are of a type this deployment cannot execute ` +
        `(${nameList(summary.unsupported)}) — install the missing tool on the worker`,
    );
  }
  if (summary.envIssueFailures.length > 0) {
    parts.push(
      `${summary.envIssueFailures.length} failure(s) were triaged as environment issues rather ` +
        `than defects (${nameList(summary.envIssueFailures)})`,
    );
  }

  const action = unattemptable ? 'BLOCK' : 'WARN';
  return {
    rule: ENVIRONMENT_GATE_RULE(action),
    passed: false,
    action,
    detail: unattemptable
      ? `Environment — nothing in this run could be attempted: ${parts.join('; ')}. ` +
        'There is no verdict here, so nothing may merge on the strength of it.'
      : `Environment — ${parts.join('; ')}. None of this is a verdict on your application.`,
  };
}

function tallyRows(rows: readonly RunResultRow[], now: Date = new Date()): RunCounts {
  const counts = emptyRunCounts();
  for (const row of rows) {
    tallyResult(counts, {
      status: row.status,
      quarantineInForce: quarantineSuppresses(row.test, now),
    });
  }
  return counts;
}

/**
 * How many surviving mutants one result may store.
 *
 * 500, which is the ceiling `mutationTestSpecSchema.maxSurvivorsReported`
 * allows a spec to ask for — so the stored detail can never be narrower than
 * what a customer is able to request on screen. The cap exists because a
 * whole-module mutation run can report thousands of survivors and one
 * `createMany` inside the result transaction is not the place to find that out.
 *
 * It truncates the LIST and never the ARITHMETIC: `mutationUndetected` on the
 * result row is the tool's own exact count, written from the same record, so a
 * capped result still reports how many survived and the rows are honestly the
 * first N of them. A cap that also reduced the count would be a schema decision
 * quietly improving a customer's mutation score.
 */
export const MAX_PERSISTED_SURVIVORS = 500;

/**
 * The five mutation columns for one execution — ALL of them, on every write.
 *
 * ── The defect this function exists to prevent ─────────────────────────────
 *
 * `mutationScore` NULL means "mutation testing did not run here".
 * `mutationScore` 0 means "every single mutant survived", which is the worst
 * result a suite can produce. Writing 0 for the first case inverts the signal
 * completely: a project that has never measured its suite would be
 * indistinguishable from one whose tests assert nothing, and the number exists
 * precisely to tell those two apart.
 *
 * So this returns an explicit `null` for every column when there is no mutation
 * data, rather than omitting the keys. That is not cosmetic — Prisma reads an
 * ABSENT key as "leave the column alone", so omitting them would leave a
 * re-run's stale score sitting on a result whose plugin reported nothing this
 * time. Present-and-null is the only spelling that means "not measured", and
 * being the single place all five columns are computed is what keeps a future
 * caller from writing four of them.
 *
 * `score` is passed through as-is, null included: a run that produced no VALID
 * mutant has no denominator, and its counts are still facts worth keeping
 * (`excluded: 12, score: null` says "twelve mutants, none of them buildable").
 * That is a third state, distinct from both "not measured" and 0, and the
 * nullability of the score column is what expresses it.
 */
export function mutationColumns(data: MutationRunData | null | undefined): {
  mutationScore: number | null;
  mutationDetected: number | null;
  mutationUndetected: number | null;
  mutationExcluded: number | null;
  mutationMinScore: number | null;
} {
  if (data === null || data === undefined) {
    return {
      mutationScore: null,
      mutationDetected: null,
      mutationUndetected: null,
      mutationExcluded: null,
      mutationMinScore: null,
    };
  }
  return {
    mutationScore: data.score,
    mutationDetected: data.detected,
    mutationUndetected: data.undetected,
    mutationExcluded: data.excluded,
    mutationMinScore: data.minScore,
  };
}

/**
 * The inserted cell's id, or an exception.
 *
 * Reached only if a reading survived `planMeasurements` naming a cell that was
 * not inserted — which this file's own code cannot produce, because the orphan
 * refusal in there is exactly that check. So it is deliberately loud: the only
 * alternative is `variantId: null`, which would file one cell's measurement
 * under the whole test and report it as a measured fact about the test. A loud
 * failure beats a quiet lie.
 *
 * The key is safe to name — `variantKeyOf` produced it, so it is JSON-escaped.
 */
function cellIdFor(ids: ReadonlyMap<string, string>, variantKey: string): string {
  const id = ids.get(variantKey);
  if (id === undefined) {
    throw new Error(`no inserted cell for ${variantKey}; refusing to file it under the whole test`);
  }
  return id;
}

/**
 * The reported matrix and readings, validated — or a counted refusal.
 *
 * The AGENT path gets this for free: `executionSchema` in
 * apps/api/src/routes/runners.ts is built from these same two validators, so
 * both ingest paths admit exactly the same shapes. That is the whole reason it
 * is done here too rather than trusting the in-process producer: a plugin is
 * still a producer, a third-party plugin is an UNTRUSTED one, and a customer's
 * matrix must not depend on which runner happened to run the test.
 *
 * A malformed report costs its MEASUREMENTS and nothing else. The result, its
 * steps and its findings are still persisted, because a reporting problem must
 * never cost a run its verdict — and the refusal is counted and named in the
 * log, which is the only channel this side has, there being no caller to
 * answer with a 400.
 *
 * Validated ELEMENT BY ELEMENT and then refused WHOLE. A partially stored
 * matrix is indistinguishable from a narrower matrix somebody configured, so
 * there is no half-write here: the first bad cell refuses all of them.
 */
function validateMeasurements(
  execution: TestExecution,
): { ok: true; variants: MeasuredVariant[]; metrics: TestMetric[] } | { ok: false; why: string } {
  const variants: MeasuredVariant[] = [];
  for (const [index, variant] of (execution.variants ?? []).entries()) {
    const parsed = testResultVariantSchema.safeParse(variant);
    /*
     * The PATHS, never the values. A dimension is free text and a metric name
     * is customer-supplied; both land in a log line here, and zod's issue
     * paths are field names and array indices, which cannot forge one.
     */
    if (!parsed.success) {
      return { ok: false, why: `cell ${index} is not a valid variant: ${issuePathsOf(parsed)}` };
    }

    /*
     * ── THE PER-CELL EVIDENCE, OWNED BY THE SCHEMA AND NOT RE-READ HERE ────
     *
     * This branch used to read `variant.cell` off the raw object BEFORE the
     * parse and validate it separately, and it had to:
     * `testResultVariantSchema` is a plain `z.object` and not `.strict()`, so
     * an unknown key is SILENTLY DROPPED. A plugin could report all five
     * honesty columns and `parsed.data` would not carry them — five NULLs
     * written with no refusal and no log line.
     *
     * The field is now ON that schema, so `parsed.data.cell` IS the validated
     * evidence and the second read became unreachable: it parsed the same value
     * against the same schema, so its refusal branch could only have fired if a
     * schema disagreed with itself. A dead branch under a comment swearing it
     * is the defence is worse than no branch, so it is gone.
     *
     * WHAT THE MOVE BUYS, which is the reason for it: the AGENT path.
     * apps/api/src/routes/runners.ts builds its `executionSchema` from this
     * same validator, and before the field existed an on-prem agent's reported
     * cell was dropped on the floor there with nothing reading around it. One
     * schema now admits it on both paths, which is the single property
     * measurement-rows.ts exists to guarantee: a customer's honesty columns
     * must not depend on which runner happened to run the test.
     *
     * The refusal is unchanged in every respect that matters. A malformed cell
     * still costs the MEASUREMENTS and nothing else — the result, its steps and
     * its findings persist, because a reporting problem must never cost a run
     * its verdict — and it is still named by FIELD and never by content: the
     * path is now `cell.notAssertedReason` rather than a second sentence, and a
     * zod issue path is field names and array indices, which cannot carry a
     * remedy sentence or an unasserted assertion into a log line.
     *
     * ABSENT IS NOT AVAILABLE. The field defaults to `null`, which means the
     * producer made no claim about this cell's runnability or its holes — the
     * fifth state every one of the five columns spells NULL — and the row is
     * still written, so the cell stays in the denominator.
     */
    variants.push(parsed.data);
  }

  const metrics: TestMetric[] = [];
  for (const [index, metric] of (execution.metrics ?? []).entries()) {
    const parsed = testMetricSchema.safeParse(metric);
    if (!parsed.success) {
      return { ok: false, why: `reading ${index} is not a valid metric: ${issuePathsOf(parsed)}` };
    }
    metrics.push(parsed.data);
  }

  return { ok: true, variants, metrics };
}

/** Which FIELDS a parse objected to, with none of their contents. */
function issuePathsOf(parsed: {
  error: { issues: ReadonlyArray<{ path: PropertyKey[] }> };
}): string {
  const paths = parsed.error.issues.slice(0, 5).map((issue) => issue.path.join('.') || '(root)');
  const extra = parsed.error.issues.length - paths.length;
  return extra > 0 ? `${paths.join(', ')} (+${extra} more)` : paths.join(', ');
}

async function persistExecution(args: {
  orgId: string;
  /**
   * The run's project, for `TestMetricSample.projectId` — which carries the
   * trend index `(projectId, name, createdAt)`, the read that table exists for.
   * Threaded in rather than looked up here, because the caller already holds
   * the run row and a second read could disagree with it.
   */
  projectId: string;
  runId: string;
  /** Copied from the parent `TestResult` row, never from the execution. */
  testId: string;
  testResultId: string;
  execution: TestExecution;
  uploaded: Array<{ key: string; contentType: string }>;
  expiresAt: Date;
}): Promise<void> {
  const { orgId, projectId, runId, testId, testResultId, execution, uploaded, expiresAt } = args;

  /*
   * ── THE MATRIX AND THE READINGS, DECIDED BEFORE THE TRANSACTION OPENS ─────
   *
   * Planned out here so a refusal costs nothing: no partial write, and no
   * rollback of a result that was perfectly good. `planMeasurements` is the
   * same function the on-prem agent's POST calls, over the same validated
   * shapes, so the two ingest paths write the same rows for the same input.
   */
  const validated = validateMeasurements(execution);
  const plan: MeasurementPlan = validated.ok
    ? planMeasurements(
        { orgId, projectId, runId, testId, testResultId },
        validated.variants,
        validated.metrics,
      )
    : { ok: false, why: validated.why };
  if (!plan.ok) {
    /*
     * COUNTED AND NAMED, not swallowed. There is no caller to hand a 400 to, so
     * the log is the disclosure: how many cells and readings were reported, and
     * the one sentence saying why none of them could be stored. Silence here
     * would be a matrix that vanished and read afterwards as "not varied".
     */
    logger.warn(
      {
        runId,
        testId,
        cellsReported: execution.variants?.length ?? 0,
        readingsReported: execution.metrics?.length ?? 0,
        reason: plan.why,
      },
      'measurements refused: the result, its steps and its findings were still stored',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.testResult.update({
      where: { id: testResultId },
      data: {
        status: execution.status,
        durationMs: execution.durationMs,
        errorMessage: execution.errorMessage,
        retriedAndPassed: execution.retriedAndPassed,
        /*
         * WHY this result has nothing measured in it, as a queryable column.
         *
         * `execution.notRun` rather than a re-reading of the message: the
         * producer holds the kind as data — the worker's own not-run branch
         * threads it through `syntheticExecution`, and a PLUGIN can now declare
         * its own ("k6 is not installed on this image") — and parsing it back
         * out of a string it just formatted would be this file guessing at a
         * fact it was handed.
         *
         * NULL when absent, and absent is NOT `NOT_RUN`. Undefined means the
         * producer made no claim about why, which is the fifth state both this
         * column and `parseNotRun` spell NULL; defaulting to NOT_RUN would put
         * a claim in the database that nothing produced. Written explicitly on
         * EVERY result for the reason `mutationColumns` is — a redelivered job
         * re-persisting a result must clear a kind that no longer applies, and
         * a column left out of the update keeps whatever it held before.
         */
        notRunKind: execution.notRun?.kind ?? null,
        network: execution.network as unknown as object,
        consoleLog: execution.console as unknown as object,
        videoKey: execution.videoKey,
        traceKey: execution.traceKey,
        /*
         * The mutation metric channel. Every column every time, explicitly null
         * when nothing measured — see `mutationColumns`, which is also why this
         * is a spread of a named function rather than five inline fields: the
         * null-versus-zero rule has one implementation and one place to read it.
         */
        ...mutationColumns(execution.mutation),
      },
    });

    // Replace rather than append: a retried run job must not double up steps.
    await tx.step.deleteMany({ where: { testResultId } });
    if (execution.steps.length > 0) {
      await tx.step.createMany({
        data: execution.steps.map((step) => ({
          orgId,
          testResultId,
          index: step.index,
          title: step.title.slice(0, 500),
          status: step.status,
          durationMs: step.durationMs,
          screenshotKey: step.screenshotKey,
          errorMessage: step.error?.message.slice(0, 5000) ?? null,
          errorStack: step.error?.stack?.slice(0, 10000) ?? null,
          selector: step.error?.selector ?? null,
          expected: step.error?.expected ?? null,
          actual: step.error?.actual ?? null,
          startedAt: new Date(step.startedAt),
        })),
      });
    }

    await tx.finding.deleteMany({ where: { testResultId } });
    if (execution.findings.length > 0) {
      await tx.finding.createMany({
        data: execution.findings.map((finding) => ({
          orgId,
          testResultId,
          kind: finding.kind,
          severity: finding.severity,
          code: finding.code,
          message: finding.message.slice(0, 2000),
          location: finding.location.slice(0, 1000),
          helpUrl: finding.helpUrl,
        })),
      });
    }

    /*
     * Surviving mutants — the actionable half of a mutation run, and the reason
     * the score is worth storing at all: "`>` became `>=` at src/cart.ts:42 and
     * every test still passed" names one missing assertion.
     *
     * Deleted-then-created like the steps and findings above, for the same
     * reason: a retried run job must not double up the rows. The delete runs
     * even when there is no mutation data, which is the half that matters —
     * without it, a result whose MUTATION test was later changed to report
     * nothing would keep serving the previous run's survivors next to a NULL
     * score, and the detail would outlive the number it belongs to.
     */
    await tx.mutationSurvivor.deleteMany({ where: { testResultId } });
    const survivors = execution.mutation?.survivors ?? [];
    if (survivors.length > 0) {
      await tx.mutationSurvivor.createMany({
        data: survivors.slice(0, MAX_PERSISTED_SURVIVORS).map((mutant) => ({
          orgId,
          testResultId,
          file: mutant.file.slice(0, 1000),
          // Null, never 0: line 0 does not exist, and a zero would send a
          // reader to the top of the file with confidence.
          line: mutant.line,
          mutator: mutant.mutator.slice(0, 200),
          detail: mutant.detail?.slice(0, 2000) ?? null,
          reason: mutant.reason,
        })),
      });
    }

    /*
     * ── THE MATRIX AND THE READINGS ───────────────────────────────────────
     *
     * The same writes the on-prem agent's POST makes, in the same order, from
     * the same planned rows — see apps/api/src/routes/runners.ts. Two ingest
     * paths that drift are how one customer's matrix comes to disagree with
     * another's, so the row building is one shared block and only the plumbing
     * around it differs.
     *
     * REPLACE, NOT APPEND, in the same transaction as the steps and findings:
     * a retried run job must not double a cell or a reading, and a doubled
     * cell would be refused by `TestResultVariant_cell_key` and take the whole
     * result's write down with it.
     *
     * The readings are deleted FIRST and explicitly. They cascade from their
     * CELL, so a whole-test reading — `variantId: null` by design — has nothing
     * to cascade from and would outlive a variant-only delete, leaving the last
     * attempt's number beside this attempt's cells.
     *
     * Both deletes run even when there is nothing to write, including when the
     * report was REFUSED above, which is the half that matters: a test that
     * stopped reporting a matrix must stop having one rather than keep serving
     * the previous attempt's cells for ever. Same argument as the survivor rows.
     */
    await tx.testMetricSample.deleteMany({ where: { testResultId } });
    await tx.testResultVariant.deleteMany({ where: { testResultId } });

    const cells = plan.ok ? plan.variants : [];
    const readings = plan.ok ? plan.readings : [];

    /*
     * `createManyAndReturn`, because the readings need each cell's id and
     * nothing else can supply it. Mapped back by the five dimensions the insert
     * RETURNED and never by position: relying on insert order would
     * mis-attribute every reading the first time it did not hold, silently.
     */
    const inserted =
      cells.length > 0
        ? await tx.testResultVariant.createManyAndReturn({
            /*
             * The planned rows, every column included and none of them
             * rewritten here — the five honesty ones among them. `matrixCell`
             * is `undefined` rather than null on a cell nobody reported
             * evidence for, which on an INSERT is the column's default and so
             * is SQL NULL; `VariantRow`'s own note has the whole argument and
             * the warning for anybody who makes this an upsert.
             */
            data: cells,
            select: {
              id: true,
              browser: true,
              viewport: true,
              locale: true,
              role: true,
              environment: true,
            },
          })
        : [];
    const idByCell = new Map(inserted.map((cell) => [variantKeyOf(cell), cell.id]));

    if (readings.length > 0) {
      await tx.testMetricSample.createMany({
        data: readings.map((reading) => ({
          ...reading,
          /*
           * NULL for a whole-test reading, the cell's id for a cell's — and
           * `variantKey` is written in BOTH cases, carrying '<unvaried>' for
           * the first. The id is the join, the key is the identity, and the
           * unique index is over the key because a unique over the nullable id
           * would treat every whole-test reading as distinct and insert the
           * same metric once per run for ever.
           */
          variantId:
            reading.variantKey === UNVARIED ? null : cellIdFor(idByCell, reading.variantKey),
        })),
      });
    }

    for (const artifact of uploaded) {
      await tx.artifact.upsert({
        where: { key: artifact.key },
        create: {
          orgId,
          runId,
          key: artifact.key,
          contentType: artifact.contentType,
          expiresAt,
        },
        update: {},
      });
    }
  });
}

/**
 * Flake radar (§5). Maintained incrementally on write rather than computed on
 * read — the cockpit sorts and filters on flake rate, and a scan of every past
 * result per test would make the suite tree slow the moment history exists.
 *
 * It took a `retriedAndPassed` argument and never read it. Not an oversight
 * worth restoring: `persistExecution` writes the current result BEFORE this is
 * called, so the row is already inside the fifty this reads back and passing
 * the flag in would have counted it twice. The parameter is gone rather than
 * underscore-prefixed so nobody re-plumbs it on the assumption it was needed.
 */
async function updateFlakeStats(args: {
  orgId: string;
  projectId: string;
  runId: string;
  testId: string;
  status: TestResultStatus;
  /** The raw column, recorded alongside the rate so a flat 0% is readable. */
  quarantined: boolean;
}): Promise<void> {
  const { orgId, projectId, runId, testId, status } = args;
  const recent = await prisma.testResult.findMany({
    where: { testId },
    orderBy: { createdAt: 'desc' },
    take: FLAKE_WINDOW,
    select: { status: true, retriedAndPassed: true },
  });

  const flaky = recent.filter((r) => r.status === 'FLAKY' || r.retriedAndPassed).length;
  const flakeRate = recent.length === 0 ? 0 : (flaky / recent.length) * 100;

  const test = await prisma.test.findUnique({
    where: { id: testId },
    // `quarantined` was read only by the auto-quarantine that used to live
    // here; the streak is all this function needs now.
    select: { consecutiveFailures: true },
  });

  const consecutiveFailures =
    status === 'PASSED' ? 0 : (test?.consecutiveFailures ?? 0) + (status === 'FAILED' ? 1 : 0);

  /*
   * This function records the flake RATE. It deliberately no longer decides
   * anything.
   *
   * It used to auto-quarantine inline: `flakeRate > 20 && recent.length >= 5`.
   * That predates processors/flake.ts, and once that existed the two were
   * competing policies over the same column — with the weaker one winning,
   * because it fired first, on every run.
   *
   * Weaker in every respect that matters. It had no REAL_BUG veto, so a test
   * whose failures a human had already triaged as a genuine bug could be
   * quarantined and quietly stop gating — verified: a CRITICAL_PATH test with
   * five REAL_BUG verdicts was quarantined at "83% flake rate" here. It had no
   * critical-path protection. It acted on five runs where the policy requires a
   * minimum sample size. It wrote NO audit row, so the suppression was
   * invisible. And "flaked 20% of the last 5 runs" is a suspicion, where
   * flake.ts re-runs the test and measures the actual rate.
   *
   * Suppressing a signal is the most dangerous thing this product does, so it
   * happens in exactly one place, with evidence, and always audited.
   */
  await prisma.test.update({
    where: { id: testId },
    data: { flakeRate, lastRunAt: new Date(), consecutiveFailures },
  });

  /*
   * ── And the history, which is the second half of the defect ───────────────
   *
   * The line above OVERWRITES `Test.flakeRate`, and until now that was the
   * only record there was. So rot had no direction: a test that had been
   * degrading for three weeks looked identical to one that flaked this
   * morning, the suite-health score was recomputed per request from whatever
   * happened to be current, and "is this getting worse?" had no answer in the
   * database at all.
   *
   * Fire-and-forget, and last. A trend row that cannot be written must never
   * fail the run that produced it — the run's own verdict is the product, the
   * history is the instrument.
   */
  await recordFlakeHistory({
    orgId,
    projectId,
    runId,
    testId,
    ratePercent: flakeRate,
    sampleSize: recent.length,
    failures: flaky,
    quarantined: args.quarantined,
  }).catch((err) =>
    logger.warn({ err, testId }, 'could not record the flake history point for this test'),
  );
}

/**
 * Append one point to a test's flake trend, collapsed to its UTC day.
 *
 * ── The retention rule, and what it loses ───────────────────────────────────
 *
 * One row per test per UTC day. The `(testId, day)` unique constraint IS the
 * aggregation — an upsert either creates the day or folds into it — so a
 * 5,000-test suite running hourly writes 120,000 measurements a day and stores
 * 5,000 rows. Without that, the same suite would add 43 million rows a year to
 * a table the suite tree sorts on.
 *
 * The day keeps its LAST rate (where it ended up) and its PEAK (so collapsing a
 * day cannot hide a spike), with the run that produced the peak. What is lost:
 * the shape of the day between those two numbers, the other runs' ids, and
 * everything past the retention window. A day with no runs has NO ROW, and a
 * reader must treat absence as "not measured" rather than filling it with zero
 * — a gap filled with 0% invents a recovery that never happened.
 *
 * Pruning is NOT done here. A delete on every test of every run is thousands of
 * pointless statements an hour; the flake sweep does it once per tick, bounded
 * — see `pruneFlakeHistory` in processors/flake.ts.
 */
export async function recordFlakeHistory(point: {
  orgId: string;
  projectId: string;
  runId: string | null;
  testId: string;
  ratePercent: number;
  sampleSize: number;
  failures: number;
  quarantined: boolean;
  at?: Date;
}): Promise<void> {
  const at = point.at ?? new Date();
  const day = utcDay(at);

  const existing = await prisma.testFlakeHistory.findUnique({
    where: { testId_day: { testId: point.testId, day } },
    select: { peakRatePercent: true, samples: true },
  });

  /*
   * The peak is a MAX across the day, so a read-then-write race between two
   * workers finishing the same test in the same minute can only ever lose a
   * peak, never invent one. That is the right direction for a trend line: a
   * lost peak understates the rot by one reading, while a lost `ratePercent`
   * would misreport where the day ended up.
   */
  const peakSoFar = existing?.peakRatePercent ?? -1;
  const beatsPeak = point.ratePercent > peakSoFar;

  await prisma.testFlakeHistory.upsert({
    where: { testId_day: { testId: point.testId, day } },
    create: {
      orgId: point.orgId,
      projectId: point.projectId,
      testId: point.testId,
      day,
      ratePercent: point.ratePercent,
      peakRatePercent: point.ratePercent,
      worstAt: at,
      worstRunId: point.runId,
      sampleSize: point.sampleSize,
      failures: point.failures,
      samples: 1,
      quarantined: point.quarantined,
    },
    update: {
      ratePercent: point.ratePercent,
      sampleSize: point.sampleSize,
      failures: point.failures,
      quarantined: point.quarantined,
      samples: { increment: 1 },
      ...(beatsPeak
        ? { peakRatePercent: point.ratePercent, worstAt: at, worstRunId: point.runId }
        : {}),
    },
  });
}

/** Midnight UTC. The bucket key, and the reason this table is bounded. */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/*
 * Takes the ROWS rather than re-reading them. `finalizeRun` already needs the
 * same read for the environment summary, and two reads of the same rows is how
 * a gate came to be scored against a different set of results than the counts
 * were computed from.
 */
async function evaluateRunGates(
  orgId: string,
  results: readonly RunResultRow[],
  projectId: string,
  rawRules: unknown,
  budgetPercent?: number | null,
) {
  const rules =
    Array.isArray(rawRules) && rawRules.length > 0 ? (rawRules as GateRule[]) : DEFAULT_GATE_RULES;

  const now = new Date();

  return evaluateGates(rules, {
    results: results.map((r) => ({
      testId: r.testId,
      testName: r.test.name,
      status: r.status,
      priority: r.test.priority,
      // The suppression as it stands NOW, expiry included — not the raw column.
      quarantined: quarantineSuppresses(r.test, now),
      retriedAndPassed: r.retriedAndPassed,
      // A human override beats the model, always.
      verdict:
        r.verdict?.reviewState === 'OVERRIDDEN'
          ? (r.verdict.overriddenTo ?? r.verdict.verdict)
          : (r.verdict?.verdict ?? null),
      durationMs: r.durationMs,
    })),
    ...(await quarantineHealthFor(orgId, projectId, budgetPercent, now)),
  });
}

/**
 * The quarantine budget and the rot alarm, read once per finalisation.
 *
 * Returns `{}` on any failure, which produces no quarantine evaluation at all —
 * deliberately NOT a passing one. A budget nobody could measure must not look
 * like a budget that is fine, and a run must never fail to finalise because a
 * health query threw.
 *
 * Scoped to the PROJECT rather than the run: the question is "how much of this
 * suite has stopped gating", and a run that selected eleven tests says nothing
 * about the other four thousand.
 */
async function quarantineHealthFor(
  orgId: string,
  projectId: string,
  budgetPercent: number | null | undefined,
  now: Date,
): Promise<{ quarantine?: QuarantineHealthInput }> {
  try {
    const [totalTests, inForce, quarantined] = await Promise.all([
      // `disabledAt: null` on all three: a disabled test neither gates nor
      // counts against the budget, and letting it into the denominator alone
      // would make the budget quietly looser the more dead tests a suite has.
      prisma.test.count({ where: { orgId, projectId, disabledAt: null } }),
      /*
       * The suppressions actually IN FORCE, counted in the database rather than
       * in the loop below — because the loop reads a CAPPED list.
       *
       * Counting from that list would silently stop the budget working at the
       * exact size it matters most: a project with 4,000 quarantined tests
       * would report 200, land under its cap, and the alarm built to catch a
       * suite that has stopped testing anything would go quiet on the worst
       * suite in the install. The expiry arm is the same rule
       * `quarantineSuppresses` applies, expressed as SQL.
       */
      prisma.test.count({
        where: {
          orgId,
          projectId,
          disabledAt: null,
          quarantined: true,
          OR: [{ quarantineExpiresAt: null }, { quarantineExpiresAt: { gt: now } }],
        },
      }),
      prisma.test.findMany({
        where: { orgId, projectId, disabledAt: null, quarantined: true },
        select: { id: true, name: true, quarantinedAt: true, quarantineExpiresAt: true },
        // Bounded, like every other customer-sized list in this product. The
        // count above is exact; only the NAMES in the warning are capped.
        take: QUARANTINE_NAMES_SCANNED,
        orderBy: { quarantinedAt: 'asc' },
      }),
    ]);

    /*
     * The classification is `quarantineHealthFrom`'s, not this file's.
     *
     * All four rules — expired, expiring soon, quarantined-with-no-expiry-and
     * -old-enough-to-be-news, and the fact that the COUNT must not be taken
     * from the capped list — were written out here and again in gates.ts for
     * the post-triage re-score. Two copies that agree today are the dangerous
     * state: nothing goes red when they drift, and a re-scored gate that had
     * quietly stopped reporting an expiring quarantine would be a green-wash
     * performed by the code that exists to stop one.
     *
     * The QUERIES stay here, because they are this caller's: the worker's
     * client carries no tenancy extension, so the org scope is explicit above.
     */
    return {
      quarantine: quarantineHealthFrom({
        totalTests,
        quarantinedCount: inForce,
        budgetPercent: budgetPercent ?? null,
        rows: quarantined,
        now,
      }),
    };
  } catch (err) {
    logger.warn(
      { err, projectId },
      'could not read the quarantine budget; the run finalises with no quarantine evaluation',
    );
    return {};
  }
}
