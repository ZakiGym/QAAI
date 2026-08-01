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

import { evaluateGates, pluginFor, reasonUnsupported } from '@qaai/runner';
import { FIXTURE_PREFIX, GRID_INTEGRATION_KINDS, RUN_SHARD_TERMINAL } from '@qaai/shared';
import type { GridIntegrationKind, RunShardRef } from '@qaai/shared';
import { gridWsEndpoint } from '../grids.js';
import { open as openSecret } from '../vault.js';
import type {
  ExecutableTest,
  GateRule,
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

interface RunCounts {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

export async function processRun(job: ShardedRunJob): Promise<void> {
  const { orgId, runId } = job;
  const shard: RunShardRef | null = job.shard ?? null;

  const run = await prisma.run.findFirst({
    where: { id: runId, orgId },
    include: {
      environment: { select: { id: true, baseUrl: true } },
      project: { select: { id: true, gateRules: true } },
      // A shard executes only its own slice. An unsharded job passes no filter
      // and gets every result, which is the whole suite.
      results: { where: shard ? { shardIndex: shard.index } : {}, include: { test: true } },
    },
  });
  if (!run) throw new Error(`Run ${runId} not found for org ${orgId}`);

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
      );
    }
  }

  const authProfile = await prisma.authProfile.findFirst({
    where: { orgId, environmentId: run.environment.id },
    orderBy: { createdAt: 'asc' },
    select: { storageState: true, storageStateExpiresAt: true },
  });
  const storageState =
    authProfile?.storageState &&
    (!authProfile.storageStateExpiresAt || authProfile.storageStateExpiresAt > new Date())
      ? authProfile.storageState
      : null;

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
    await prisma.run.update({
      where: { id: run.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    publishEvent(orgId, {
      runId: run.id,
      type: 'run.started',
      data: { total: run.results.length, baseUrl },
      at: new Date().toISOString(),
    });
  }

  // Proof of life for this shard, on a timer. It dies with the process, which
  // is exactly the signal the siblings' reaper is looking for.
  const heartbeat = shard
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

  const controller = new AbortController();
  const counts: RunCounts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  let runErrored: string | null = null;
  let cancelled = false;

  try {
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
        if (!shard) {
          publishEvent(orgId, {
            runId: run.id,
            type: 'run.finished',
            data: { status: 'CANCELLED', completed: index, total: run.results.length },
            at: new Date().toISOString(),
          });
          return;
        }
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

      const plugin = pluginFor(test.type);
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
      };

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
        storageState,
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

      let execution: TestExecution;
      try {
        plugin.validate(executable);
        execution = await plugin.execute(context, executable);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, testId: test.id }, 'plugin threw');
        execution = {
          testId: test.id,
          status: 'FAILED',
          durationMs: 0,
          steps: [],
          network: [],
          console: [],
          videoKey: null,
          traceKey: null,
          errorMessage: message,
          retriedAndPassed: false,
          findings: [],
        };
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

      switch (execution.status) {
        case 'PASSED':
          counts.passed += 1;
          break;
        case 'FLAKY':
          counts.flaky += 1;
          break;
        case 'SKIPPED':
          counts.skipped += 1;
          break;
        default:
          counts.failed += 1;
      }

      await updateFlakeStats(test.id, execution.status, execution.retriedAndPassed);

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
        trigger: run.trigger,
        prNumber: run.prNumber,
        gateRules: run.project.gateRules,
      },
      shardIndex: shard.index,
    });
    return;
  }

  await finalizeRun({
    orgId,
    run: {
      id: run.id,
      trigger: run.trigger,
      prNumber: run.prNumber,
      gateRules: run.project.gateRules,
    },
    counts,
    errorMessage: runErrored,
    forcedStatus: runErrored ? 'ERRORED' : null,
  });
}

/**
 * Write the run's terminal state: gates, counts, monitor streak, notification,
 * SSE. Called once per run — inline by an unsharded job, or by whichever shard
 * won the finalisation claim.
 */
async function finalizeRun(args: {
  orgId: string;
  run: { id: string; trigger: string; prNumber: number | null; gateRules: unknown };
  counts: RunCounts;
  errorMessage: string | null;
  /** Overrides the pass/fail verdict: the run was cancelled, or a shard died. */
  forcedStatus: 'CANCELLED' | 'ERRORED' | null;
}): Promise<void> {
  const { orgId, run, counts, errorMessage, forcedStatus } = args;

  const gateResult = await evaluateRunGates(orgId, run.id, run.gateRules);

  const status =
    forcedStatus ?? (counts.failed > 0 || !gateResult.passed ? 'FAILED' : ('PASSED' as const));

  await prisma.run.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt: new Date(),
      passedCount: counts.passed,
      failedCount: counts.failed,
      flakyCount: counts.flaky,
      skippedCount: counts.skipped,
      gateResult: gateResult as unknown as object,
      errorMessage,
    },
  });

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
    data: { status, ...counts, gatePassed: gateResult.passed },
    at: new Date().toISOString(),
  });

  logger.info({ runId: run.id, status, ...counts }, 'run finished');
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
 * QUEUED shards are deliberately NOT reaped. A shard sitting in the queue has
 * not been picked up yet, which on a busy pool is normal and expected: with
 * four workers and fifteen shards, the last shard is queued for as long as the
 * first eleven take. Reaping on age would abandon work that was about to run.
 * The consequence is honest and worth stating — if a shard's queue job is lost
 * outright (a flushed Redis), the run stays RUNNING until someone re-runs it.
 * A maximum-run-age sweep belongs in the scheduler tick, not here, because this
 * function only ever executes when some *other* shard finishes.
 *
 * The update is conditional on the same staleness it tested, so a shard that
 * comes back to life between the read and the write keeps its slice.
 */
async function reapDeadShards(orgId: string, runId: string): Promise<number> {
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
  return reaped.count;
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
  run: { id: string; trigger: string; prNumber: number | null; gateRules: unknown };
  /** The shard that finished, or null when the scheduler sweep is asking. */
  shardIndex: number | null;
}): Promise<void> {
  const { orgId, run, shardIndex } = args;
  const bySweep = shardIndex === null;

  await reapDeadShards(orgId, run.id);

  const shards = await prisma.runShard.findMany({
    where: { orgId, runId: run.id },
    select: { index: true, status: true, errorMessage: true },
    orderBy: { index: 'asc' },
  });

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
 */
export async function sweepStalledShardedRuns(): Promise<number> {
  // Only runs old enough that a dead shard would already be past the staleness
  // window. Younger ones cannot have anything to reap, and a shard that is
  // simply queued behind a busy pool must never be mistaken for a dead one.
  const before = new Date(Date.now() - STALE_SHARD_MS);

  const candidates = await prisma.run.findMany({
    where: {
      status: 'RUNNING',
      shardCount: { gt: 1 },
      finalizedAt: null,
      startedAt: { lt: before },
    },
    select: {
      id: true,
      orgId: true,
      trigger: true,
      prNumber: true,
      project: { select: { gateRules: true } },
    },
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
          trigger: run.trigger,
          prNumber: run.prNumber,
          gateRules: run.project.gateRules,
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
 */
async function aggregateCounts(orgId: string, runId: string): Promise<RunCounts> {
  const grouped = await prisma.testResult.groupBy({
    by: ['status'],
    where: { orgId, runId },
    _count: { _all: true },
  });

  const counts: RunCounts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const row of grouped) {
    const n = row._count._all;
    if (row.status === 'PASSED') counts.passed += n;
    else if (row.status === 'FLAKY') counts.flaky += n;
    else if (row.status === 'SKIPPED') counts.skipped += n;
    // FAILED and TIMED_OUT both mean the test did not pass.
    else counts.failed += n;
  }
  return counts;
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
 */
async function updateFlakeStats(
  testId: string,
  status: TestResultStatus,
  retriedAndPassed: boolean,
): Promise<void> {
  const recent = await prisma.testResult.findMany({
    where: { testId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { status: true, retriedAndPassed: true },
  });

  const flaky = recent.filter((r) => r.status === 'FLAKY' || r.retriedAndPassed).length;
  const flakeRate = recent.length === 0 ? 0 : (flaky / recent.length) * 100;

  const test = await prisma.test.findUnique({
    where: { id: testId },
    select: { consecutiveFailures: true, quarantined: true },
  });

  const consecutiveFailures =
    status === 'PASSED' ? 0 : (test?.consecutiveFailures ?? 0) + (status === 'FAILED' ? 1 : 0);

  // Auto-quarantine: a test flaking more than a fifth of the time is noise, and
  // noise that gates a build gets the whole gate ignored. It keeps running.
  const shouldQuarantine = !test?.quarantined && flakeRate > 20 && recent.length >= 5;

  await prisma.test.update({
    where: { id: testId },
    data: {
      flakeRate,
      lastRunAt: new Date(),
      consecutiveFailures,
      ...(shouldQuarantine
        ? {
            quarantined: true,
            quarantinedAt: new Date(),
            quarantineReason: `Auto-quarantined at a ${flakeRate.toFixed(0)}% flake rate over the last ${recent.length} runs`,
          }
        : {}),
    },
  });
}

async function evaluateRunGates(orgId: string, runId: string, rawRules: unknown) {
  const rules =
    Array.isArray(rawRules) && rawRules.length > 0 ? (rawRules as GateRule[]) : DEFAULT_GATE_RULES;

  const results = await prisma.testResult.findMany({
    where: { runId, orgId },
    include: {
      test: { select: { name: true, priority: true, quarantined: true } },
      verdict: {
        select: { verdict: true, overriddenTo: true, reviewState: true },
      },
    },
  });

  return evaluateGates(rules, {
    results: results.map((r) => ({
      testId: r.testId,
      testName: r.test.name,
      status: r.status,
      priority: r.test.priority,
      quarantined: r.test.quarantined,
      retriedAndPassed: r.retriedAndPassed,
      // A human override beats the model, always.
      verdict:
        r.verdict?.reviewState === 'OVERRIDDEN'
          ? (r.verdict.overriddenTo ?? r.verdict.verdict)
          : (r.verdict?.verdict ?? null),
      durationMs: r.durationMs,
    })),
  });
}
