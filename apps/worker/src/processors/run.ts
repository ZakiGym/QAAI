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
 */

import { evaluateGates, pluginFor, reasonUnsupported } from '@qaai/runner';
import { FIXTURE_PREFIX, GRID_INTEGRATION_KINDS } from '@qaai/shared';
import type { GridIntegrationKind } from '@qaai/shared';
import { gridWsEndpoint } from '../grids.js';
import { open as openSecret } from '../vault.js';
import type {
  ExecutableTest,
  GateRule,
  RunContext,
  RunJob,
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

export async function processRun(job: RunJob): Promise<void> {
  const { orgId, runId } = job;

  const run = await prisma.run.findFirst({
    where: { id: runId, orgId },
    include: {
      environment: { select: { id: true, baseUrl: true } },
      project: { select: { id: true, gateRules: true } },
      results: { include: { test: true } },
    },
  });
  if (!run) throw new Error(`Run ${runId} not found for org ${orgId}`);

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
      row.spec !== null && row.spec !== undefined
        ? JSON.stringify(row.spec, null, 2)
        : row.code,
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

  const controller = new AbortController();
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  let runErrored: string | null = null;

  try {
    for (const result of run.results) {
      const test = result.test;

      publishEvent(orgId, {
        runId: run.id,
        type: 'test.started',
        data: { testId: test.id, name: test.name, type: test.type },
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
    logger.error({ err, runId: run.id }, 'run aborted');
  }

  const gateResult = await evaluateRunGates(orgId, run.id, run.project.gateRules);

  const status = runErrored
    ? 'ERRORED'
    : counts.failed > 0 || !gateResult.passed
      ? 'FAILED'
      : 'PASSED';

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
      errorMessage: runErrored,
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
