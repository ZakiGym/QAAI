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
  evaluateGates,
  quarantineSuppresses,
  reasonUnsupported,
  runOutcome,
  signInWithProfile,
  tallyResult,
  QUARANTINE_EXPIRY_WARNING_DAYS,
  QUARANTINE_MAX_DAYS,
} from '@qaai/runner';
import type { QuarantineHealthInput, RunCountsWithQuarantine } from '@qaai/runner';
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
import { FIXTURE_PREFIX, GRID_INTEGRATION_KINDS, RUN_SHARD_TERMINAL } from '@qaai/shared';
import type { GridIntegrationKind, RunShardRef } from '@qaai/shared';
import { gridWsEndpoint } from '../grids.js';
import { open as openSecret } from '../vault.js';
import type {
  ExecutableTest,
  GateRule,
  MutationRunData,
  RunContext,
  ShardedRunJob,
  TestExecution,
  TestResultStatus,
} from '@qaai/shared';
import { DEFAULT_GATE_RULES } from '@qaai/runner';
import { artifactKey } from '@qaai/storage';
import { logger, prisma, publishEvent, storage } from '../context.js';
import { secretsFor } from '../vault.js';
import { enqueueNotify, enqueueTriage } from '../queues.js';
import { recordMonitorResult } from './schedule.js';

/** Retention window per plan (§5); the sweeper deletes past this. */
const RETENTION_DAYS: Record<string, number> = {
  FREE: 7,
  TEAM: 30,
  BUSINESS: 90,
  ENTERPRISE: 365,
};

/**
 * How many quarantined tests the rot alarm names.
 *
 * The COUNT behind the budget is exact (a `count`, not a length); this bounds
 * only the list of names the warning can print. A suite with 4,000 quarantined
 * tests has a budget problem the first 200 names describe perfectly well, and
 * nothing that runs inside run finalisation gets to be unbounded.
 */
const QUARANTINE_NAMES_SCANNED = 200;

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
      environment: { select: { id: true, baseUrl: true } },
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
    type ResolvedSession = { ok: true; storageState: unknown } | { ok: false; why: string };
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
            baseUrl,
          );
        } catch (err) {
          return {
            ok: false,
            why: `Signing in as "${profile.name}" threw: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          };
        }

        if (!result.ok) {
          return {
            ok: false,
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

    for (const [index, result] of run.results.entries()) {
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
       */
      const current = await prisma.run.findUnique({
        where: { id: run.id },
        select: { status: true, finalizedAt: true },
      });
      if (current?.status === 'CANCELLED' || (shard && current?.finalizedAt)) {
        cancelled = current?.status === 'CANCELLED';
        logger.info(
          { runId: run.id, completed: index, shard: shard?.index },
          cancelled ? 'run cancelled; stopping' : 'run already finalised; stopping',
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
            status: 'SKIPPED',
            errorMessage: reasonUnsupported(test.type),
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
      const baselineRow =
        test.type === 'VISUAL'
          ? await prisma.visualBaseline.findFirst({
              where: { orgId, testId: test.id },
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
      const repoMissing =
        testNeedsRepository(test) && !repoWorkspace
          ? repoUnavailableMessage(
              test.type,
              repoGap ?? 'No repository workspace was prepared for this run.',
            )
          : null;

      /*
       * The session this test runs under. A test that named a profile gets THAT
       * profile's session or no execution at all; a test that named none gets
       * the run default, exactly as before.
       */
      let session: ResolvedSession;
      if (repoMissing) {
        // Nothing is going to execute, so there is nothing to log into an
        // application for.
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
      if (repoMissing) {
        /*
         * No checkout: INTEGRATION, UNIT_GEN and MUTATION all run a command
         * inside the customer's repository, and there is not one. This
         * is the same answer the run already gives for a missing plugin —
         * SKIPPED with the reason — because it is the same kind of fact.
         */
        execution = syntheticExecution(test.id, 'SKIPPED', repoMissing);
        logger.warn(
          { testId: test.id, type: test.type, runId: run.id },
          'repo-dependent test not evaluated: no repository workspace',
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
            testId_viewport_browser: {
              testId: test.id,
              viewport: execution.newBaseline.viewport,
              browser: execution.newBaseline.browser,
            },
          },
          create: {
            orgId,
            projectId: run.projectId,
            testId: test.id,
            viewport: execution.newBaseline.viewport,
            browser: execution.newBaseline.browser,
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
        runId: run.id,
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

  if (shard) {
    // This shard is done moving. Recorded before anything else, because the
    // completion rule below is a question about rows, and a shard that has
    // finished but not said so is a shard that hangs the run.
    await prisma.runShard.updateMany({
      // The worker's client carries no tenancy extension, so every query here
      // scopes itself on the orgId from the job.
      where: { orgId, runId: run.id, index: shard.index },
      data: {
        status: cancelled ? 'CANCELLED' : runErrored ? 'FAILED' : 'COMPLETED',
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        passedCount: counts.passed,
        failedCount: counts.failed,
        flakyCount: counts.flaky,
        skippedCount: counts.skipped,
        quarantinedFailedCount: counts.quarantinedFailed,
        errorMessage: runErrored,
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
     */
    counts: cancelled ? await aggregateCounts(orgId, run.id) : counts,
    errorMessage: runErrored,
    forcedStatus: cancelled ? 'CANCELLED' : runErrored ? 'ERRORED' : null,
  });
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
 */
function syntheticExecution(
  testId: string,
  status: 'SKIPPED' | 'FAILED',
  errorMessage: string,
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
  /** Overrides the pass/fail verdict: the run was cancelled, or a shard died. */
  forcedStatus: 'CANCELLED' | 'ERRORED' | null;
}): Promise<void> {
  const { orgId, run, counts, errorMessage, forcedStatus } = args;

  const gateResult = await evaluateRunGates(
    orgId,
    run.id,
    run.projectId,
    run.gateRules,
    run.quarantineBudgetPercent,
  );

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
  const outcome = runOutcome({ counts, gatePassed: gateResult.passed, forcedStatus });
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
    },
    at: new Date().toISOString(),
  });

  logger.info({ runId: run.id, status, ...counts, reason: outcome.reason }, 'run finished');
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

  const errorMessage =
    broken.length > 0
      ? `${broken.length} of ${shards.length} shards did not complete (${broken
          .map((s) => `shard ${s.index}: ${s.errorMessage ?? s.status.toLowerCase()}`)
          .join('; ')})`
      : null;

  await finalizeRun({
    orgId,
    run,
    counts,
    errorMessage,
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

async function persistExecution(args: {
  orgId: string;
  runId: string;
  testResultId: string;
  execution: TestExecution;
  uploaded: Array<{ key: string; contentType: string }>;
  expiresAt: Date;
}): Promise<void> {
  const { orgId, runId, testResultId, execution, uploaded, expiresAt } = args;

  await prisma.$transaction(async (tx) => {
    await tx.testResult.update({
      where: { id: testResultId },
      data: {
        status: execution.status,
        durationMs: execution.durationMs,
        errorMessage: execution.errorMessage,
        retriedAndPassed: execution.retriedAndPassed,
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

async function evaluateRunGates(
  orgId: string,
  runId: string,
  projectId: string,
  rawRules: unknown,
  budgetPercent?: number | null,
) {
  const rules =
    Array.isArray(rawRules) && rawRules.length > 0 ? (rawRules as GateRule[]) : DEFAULT_GATE_RULES;

  const results = await readRunResults(orgId, runId);
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

    const soonAt = new Date(now.getTime() + QUARANTINE_EXPIRY_WARNING_DAYS * 86_400_000);
    const unboundedBefore = new Date(now.getTime() - QUARANTINE_MAX_DAYS * 86_400_000);

    const expired: Array<{ testId: string; testName: string }> = [];
    const expiringSoon: Array<{ testId: string; testName: string; expiresAt: Date }> = [];
    const unbounded: Array<{ testId: string; testName: string; quarantinedAt: Date | null }> = [];

    for (const test of quarantined) {
      if (
        !quarantineSuppresses(
          { quarantined: true, quarantineExpiresAt: test.quarantineExpiresAt },
          now,
        )
      ) {
        expired.push({ testId: test.id, testName: test.name });
        continue;
      }
      if (test.quarantineExpiresAt === null) {
        /*
         * A quarantine written before expiry existed. Only reported once it is
         * OLDER than the window it would have had — a quarantine taken out this
         * morning by a path that has not learned to stamp an expiry yet is not
         * news, and reporting it would make this warning fire on every run of
         * every install until every writer is updated.
         */
        if (test.quarantinedAt !== null && test.quarantinedAt < unboundedBefore) {
          unbounded.push({
            testId: test.id,
            testName: test.name,
            quarantinedAt: test.quarantinedAt,
          });
        }
        continue;
      }
      if (test.quarantineExpiresAt <= soonAt) {
        expiringSoon.push({
          testId: test.id,
          testName: test.name,
          expiresAt: test.quarantineExpiresAt,
        });
      }
    }

    return {
      quarantine: {
        totalTests,
        quarantinedCount: inForce,
        budgetPercent: budgetPercent ?? null,
        expired,
        expiringSoon,
        unbounded,
      },
    };
  } catch (err) {
    logger.warn(
      { err, projectId },
      'could not read the quarantine budget; the run finalises with no quarantine evaluation',
    );
    return {};
  }
}
