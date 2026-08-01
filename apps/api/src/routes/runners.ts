/**
 * On-prem runner agents (ENTERPRISE) — the wire.
 *
 * Two audiences, one router, and they share nothing but the mount point:
 *
 *  - `/runners/agent/*` is spoken by a process inside a customer's network. It
 *    authenticates with a runner token, and every call it can make is either a
 *    question ("is there work?") or a report about work it already holds. There
 *    is no endpoint here that lets an agent choose what it is sent, no endpoint
 *    that names another org, and no endpoint that returns anything about the
 *    platform beyond the job in its hands.
 *  - `/runners` and `/runners/:runnerId` are the admin surface: register,
 *    rotate, revoke. ADMIN-only, session or API key, audited.
 *
 * The agent half is mounted FIRST and terminates its own 404s, so a malformed
 * agent path can never fall through into the admin half and be answered with a
 * 401 that implies the route exists.
 *
 * Direction of travel, once more because it is the entire design: every byte
 * here moves in response to a request the agent made. We never dial out to a
 * runner, and nothing in this file could — there is no address to dial.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { z } from 'zod';
import { STEP_STATUSES, TEST_RESULT_STATUSES } from '@qaai/shared';
import { artifactKey } from '@qaai/storage';
import { prisma, unscoped, withTenant } from '../lib/prisma.js';
import { hashToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { storage } from '../lib/storage.js';
import { publish } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import {
  MAX_ARTIFACT_BYTES,
  MAX_LOG_LINES_PER_CALL,
  MAX_RESULTS_PER_BATCH,
  RUNNER_HEARTBEAT_MS,
  RUNNER_LEASE_MS,
  RUNNER_LONG_POLL_MS,
  buildAssignment,
  claimNextJob,
  createRunnerJobs,
  dedupeKeyFor,
  finalizeIfComplete,
  finalizePendingRuns,
  isOnline,
  looksLikeRunnerToken,
  mintRunnerToken,
  parseCapabilities,
  reapExpiredLeases,
  releaseRunnerJobs,
  renewLease,
  requireLease,
  requirementsForTests,
  retentionDaysFor,
  skipUnservableJobs,
} from '../lib/runners.js';
import type { RunnerCapabilities } from '../lib/runners.js';

interface RunnerActor {
  id: string;
  orgId: string;
  name: string;
  pools: string[];
  capabilities: RunnerCapabilities;
}

declare module 'express-serve-static-core' {
  interface Request {
    runner?: RunnerActor;
  }
}

export const runnersRouter: Router = Router();
const agentRouter: Router = Router();

/** The fencing token, on every call an agent makes about work it holds. */
const LEASE_HEADER = 'x-qaai-lease';

// ─── Agent authentication ────────────────────────────────────────────────────

/**
 * Resolve a runner token, or refuse.
 *
 * Deliberately NOT `requireAuth`: a runner is not a user and has no role, no
 * membership and no session. Giving it an ActorContext would put it one
 * `requireRole` mistake away from the rest of the API, so it gets its own
 * narrow identity that only the handlers below understand.
 *
 * `unscoped` on the lookup is the same necessity as the session and API-key
 * paths: no tenant is in scope until the token has told us which org this is.
 * Every query after it runs inside `withTenant`, so a compromised runner token
 * still cannot see another customer's run.
 */
async function requireRunner(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const raw = header?.startsWith('Bearer ')
    ? header.slice(7).trim()
    : typeof req.headers['x-runner-token'] === 'string'
      ? req.headers['x-runner-token'].trim()
      : '';

  if (!raw || !looksLikeRunnerToken(raw)) {
    next(unauthorized('A runner token is required'));
    return;
  }

  const runner = await unscoped(() =>
    prisma.runner.findUnique({
      where: { tokenHash: hashToken(raw) },
      select: {
        id: true,
        orgId: true,
        name: true,
        pools: true,
        capabilities: true,
        revokedAt: true,
      },
    }),
  );

  // Revoked reads exactly like unknown. A revoked token must not be able to
  // confirm that it was ever real.
  if (!runner || runner.revokedAt) {
    next(unauthorized('That runner token is not valid'));
    return;
  }

  req.runner = {
    id: runner.id,
    orgId: runner.orgId,
    name: runner.name,
    pools: runner.pools,
    capabilities: parseCapabilities(runner.capabilities),
  };

  // Proof of life. Every authenticated call refreshes it, which is what makes
  // "online" derivable without a status column that nothing would ever set to
  // OFFLINE — the process that would write it is the one that died.
  void unscoped(() =>
    prisma.runner.update({ where: { id: runner.id }, data: { lastSeenAt: new Date() } }),
  ).catch(() => {});

  void withTenant(runner.orgId, () => next());
}

function runnerOf(req: Request): RunnerActor {
  if (!req.runner) throw unauthorized('A runner token is required');
  return req.runner;
}

function leaseOf(req: Request): string {
  const lease = req.headers[LEASE_HEADER];
  const value = typeof lease === 'string' ? lease.trim() : '';
  if (!value) throw badRequest(`Send the lease you were given in the ${LEASE_HEADER} header`);
  return value;
}

agentRouter.use(requireRunner);

// ─── Agent: hello ────────────────────────────────────────────────────────────

const capabilitiesSchema = z.object({
  browsers: z.array(z.string()).max(64).optional(),
  testTypes: z.array(z.string()).max(64).optional(),
  languages: z.array(z.string()).max(64).optional(),
  toolchains: z.array(z.string()).max(64).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
});

const helloSchema = z.object({
  capabilities: capabilitiesSchema.optional(),
  agentVersion: z.string().max(64).optional(),
  platform: z.string().max(64).optional(),
});

/**
 * The agent introduces itself and says what it can do.
 *
 * Capabilities are stored but never trusted for authorisation — they can only
 * ever cause LESS work to be offered. Pools are deliberately NOT settable here:
 * routing is an administrator's decision, and an agent that could name its own
 * pool could pull work its operator meant for a different network segment.
 */
agentRouter.post('/hello', async (req, res) => {
  const runner = runnerOf(req);
  const input = helloSchema.parse(req.body ?? {});
  const capabilities = parseCapabilities(input.capabilities ?? {});

  await prisma.runner.update({
    where: { id: runner.id },
    data: {
      capabilities: capabilities as unknown as object,
      agentVersion: input.agentVersion ?? null,
      platform: input.platform ?? null,
      lastSeenAt: new Date(),
    },
  });

  res.json({
    runner: { id: runner.id, name: runner.name, pools: runner.pools },
    capabilities,
    poll: {
      longPollSeconds: Math.round(RUNNER_LONG_POLL_MS / 1000),
      heartbeatSeconds: Math.round(RUNNER_HEARTBEAT_MS / 1000),
      leaseSeconds: Math.round(RUNNER_LEASE_MS / 1000),
    },
  });
});

// ─── Agent: claim (the long poll) ────────────────────────────────────────────

/**
 * When each org's queue was last swept for work nobody can run.
 *
 * The sweep has to be driven by something, and the only thing that reliably
 * happens is agents polling. Hanging it off the poll means the reaper runs on
 * exactly the channel that proves the pool is alive — and the throttle keeps a
 * fleet of twenty agents from doing it twenty times a second.
 *
 * In-process, so a horizontally scaled API sweeps once per instance. That is a
 * duplicate of a conditional, idempotent update, not a correctness problem.
 */
const lastSweptAt = new Map<string, number>();
const SWEEP_EVERY_MS = 60_000;

async function sweepOrg(orgId: string): Promise<void> {
  const last = lastSweptAt.get(orgId) ?? 0;
  if (Date.now() - last < SWEEP_EVERY_MS) return;
  lastSweptAt.set(orgId, Date.now());

  // Both failures are logged and swallowed: a sweep that throws must not turn a
  // healthy agent's poll into an error, and neither must it stop the claim
  // below from handing out work.
  await reapExpiredLeases(orgId).catch((err) =>
    logger.error({ err, orgId }, 'runner lease reap failed'),
  );
  const skipped = await skipUnservableJobs(orgId).catch((err) => {
    logger.error({ err, orgId }, 'runner unservable sweep failed');
    return [];
  });
  for (const job of skipped) {
    // The cockpit is watching the run, not the queue. Say it there too — as a
    // log line, because the run is not finished until `finalizePendingRuns`
    // says so, and it says so below.
    publish(orgId, {
      runId: job.runId,
      type: 'log',
      data: { level: 'error', text: job.reason, onPrem: true, skipped: true },
      at: new Date().toISOString(),
    });
  }

  /*
   * Both branches above make jobs terminal without anybody calling `complete`,
   * so both can leave a run whose last job is finished and whose verdict was
   * never written. This is the backstop that closes it — and it covers the
   * reaper's ABANDONED jobs too, which nothing else would.
   */
  await finalizePendingRuns(orgId).catch((err) =>
    logger.error({ err, orgId }, 'could not finalise stalled on-prem runs'),
  );
}

const claimSchema = z.object({ capabilities: capabilitiesSchema.optional() });

/**
 * Ask for work, and wait a while for it.
 *
 * A long poll rather than a socket: it survives every corporate proxy, needs no
 * protocol upgrade, and an agent that dies mid-poll costs us one hung request
 * that the timeout closes. 204 means "nothing right now, ask again" and is the
 * normal answer on a quiet suite — it is not an error and must not be logged as
 * one, or a healthy fleet fills the log at one line per agent per 25 seconds.
 */
agentRouter.post('/claim', async (req, res) => {
  const runner = runnerOf(req);
  const input = claimSchema.parse(req.body ?? {});

  // A capability refresh on the poll means installing chromium and restarting
  // the agent is enough — no admin action, no re-registration.
  const capabilities = input.capabilities
    ? parseCapabilities(input.capabilities)
    : runner.capabilities;
  if (input.capabilities) {
    await prisma.runner
      .update({ where: { id: runner.id }, data: { capabilities: capabilities as unknown as object } })
      .catch(() => {});
  }

  await sweepOrg(runner.orgId);

  const deadline = Date.now() + RUNNER_LONG_POLL_MS;
  let claim = await claimNextJob({
    orgId: runner.orgId,
    runnerId: runner.id,
    capabilities,
    pools: runner.pools,
  });

  while (!claim && Date.now() < deadline) {
    // The agent hung up — stop holding a database connection for a reply
    // nobody will read.
    if (req.socket.destroyed || res.writableEnded) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    claim = await claimNextJob({
      orgId: runner.orgId,
      runnerId: runner.id,
      capabilities,
      pools: runner.pools,
    });
  }

  if (!claim) {
    res.status(204).end();
    return;
  }

  const assignment = await buildAssignment(runner.orgId, claim);
  if (!assignment) {
    /*
     * The run vanished under a claimed job — deleted, or its org purged. Put
     * the job out of its misery rather than leaving a lease to expire three
     * times over: there is nothing to execute and no runner will do better.
     */
    await prisma.runnerJob.updateMany({
      where: { id: claim.id, leaseId: claim.leaseId },
      data: {
        status: 'CANCELLED',
        leaseId: null,
        finishedAt: new Date(),
        errorMessage: 'The run this work belonged to no longer exists.',
      },
    });
    res.status(204).end();
    return;
  }

  await prisma.runner.update({ where: { id: runner.id }, data: { lastClaimAt: new Date() } });

  /*
   * Five runners claim five slices at once, and the run starts once.
   *
   * The conditional update is the arbiter, exactly as it is on the sharded
   * cloud path: `startedAt: null` matches for one of them, and only that one
   * announces the run. Publishing first and updating after — which is what this
   * did before — showed the cockpit the same run beginning five times.
   */
  const first = await prisma.run.updateMany({
    where: { id: assignment.runId, startedAt: null },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  if (first.count === 1) {
    publish(runner.orgId, {
      runId: assignment.runId,
      type: 'run.started',
      data: { total: assignment.tests.length, baseUrl: assignment.environment.baseUrl, onPrem: true },
      at: new Date().toISOString(),
    });
  }

  // The slice itself is progress, not a lifecycle event — `run.started` and
  // `run.finished` mean the RUN, and overloading them with per-slice news is
  // how a cockpit ends up announcing a finished run that is still executing.
  publish(runner.orgId, {
    runId: assignment.runId,
    type: 'log',
    data: {
      level: 'info',
      text: `runner "${runner.name}" picked up ${assignment.tests.length} test(s)${
        assignment.shardIndex === null ? '' : ` for shard ${assignment.shardIndex}`
      }`,
      onPrem: true,
    },
    at: new Date().toISOString(),
  });

  res.json({ job: assignment });
});

// ─── Agent: heartbeat ────────────────────────────────────────────────────────

/**
 * Proof of life for one job.
 *
 * A 409 here is the agent being told it lost the lease, and it is the ONLY
 * warning it will get. Its own loop is expected to stop on it — see the
 * `LeaseLostError` path in packages/cli/src/runner.ts — because everything it
 * writes from here on is refused anyway.
 */
agentRouter.post('/jobs/:jobId/heartbeat', async (req, res) => {
  const held = await renewLease({
    jobId: String(req.params.jobId),
    leaseId: leaseOf(req),
    running: true,
  });
  if (!held) {
    // Re-assert through the shared checker so the message says which of the two
    // things happened, rather than a bare 409.
    await requireLease(String(req.params.jobId), leaseOf(req));
  }
  res.json({ ok: true, leaseSeconds: Math.round(RUNNER_LEASE_MS / 1000) });
});

/**
 * Hand a job back before the lease lapses.
 *
 * What a graceful shutdown calls. Without it a rolling restart of a runner
 * fleet costs every in-flight job a full lease timeout of doing nothing, which
 * on a nightly suite is ninety seconds of dead air per agent per deploy.
 *
 * `attempt` is deliberately NOT decremented. An agent that restarts in a loop
 * has burned real attempts, and pretending otherwise would let it re-offer the
 * same work forever instead of the job eventually being ABANDONED with a
 * sentence pointing at the host that keeps dying.
 */
agentRouter.post('/jobs/:jobId/release', async (req, res) => {
  const runner = runnerOf(req);
  const job = await requireLease(String(req.params.jobId), leaseOf(req));

  await prisma.runnerJob.updateMany({
    where: { id: job.id, leaseId: leaseOf(req) },
    data: {
      status: 'QUEUED',
      leaseId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      startedAt: null,
      errorMessage: `Runner "${runner.name}" was shut down while holding this work; re-queued.`,
    },
  });

  res.json({ ok: true });
});

// ─── Agent: results ──────────────────────────────────────────────────────────

const stepSchema = z.object({
  index: z.number().int().min(0).max(10_000),
  title: z.string().max(500),
  status: z.enum(STEP_STATUSES),
  startedAt: z.string().max(64).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).default(0),
  screenshotKey: z.string().max(500).nullish(),
  error: z
    .object({
      message: z.string().max(5_000),
      stack: z.string().max(10_000).nullish(),
      selector: z.string().max(1_000).nullish(),
      expected: z.string().max(2_000).nullish(),
      actual: z.string().max(2_000).nullish(),
    })
    .nullish(),
});

const findingSchema = z.object({
  kind: z.enum(['ACCESSIBILITY', 'SECURITY', 'PERFORMANCE', 'LOCALIZATION', 'VISUAL']),
  severity: z.enum(['CRITICAL', 'SERIOUS', 'MODERATE', 'MINOR']),
  code: z.string().max(200),
  message: z.string().max(2_000),
  location: z.string().max(1_000),
  helpUrl: z.string().max(500).nullish(),
});

const executionSchema = z.object({
  testId: z.string().min(1).max(64),
  status: z.enum(TEST_RESULT_STATUSES),
  durationMs: z.number().int().min(0).max(86_400_000).default(0),
  errorMessage: z.string().max(10_000).nullish(),
  retriedAndPassed: z.boolean().default(false),
  steps: z.array(stepSchema).max(500).default([]),
  network: z.array(z.unknown()).max(1_000).default([]),
  console: z.array(z.unknown()).max(1_000).default([]),
  videoKey: z.string().max(500).nullish(),
  traceKey: z.string().max(500).nullish(),
  findings: z.array(findingSchema).max(500).default([]),
});

const resultsSchema = z.object({
  results: z.array(executionSchema).min(1).max(MAX_RESULTS_PER_BATCH),
});

/**
 * Stream results back, a batch at a time.
 *
 * Written against the pre-created TestResult rows rather than inserted, exactly
 * as the cloud worker does — the placeholder row already carries the run, the
 * test and the shard, and matching on (runId, testId) means a redelivered batch
 * overwrites instead of duplicating. That idempotency is what lets an agent
 * retry a failed POST without thinking about it, which is the only way "never
 * let a reporting problem lose a run" is achievable from inside a network we
 * cannot see.
 *
 * Every write is scoped to the leased job's own run. An agent cannot report a
 * result for a run it does not hold, and cannot report for a test outside its
 * slice: `updateMany` on the run's rows simply matches nothing.
 */
agentRouter.post('/jobs/:jobId/results', async (req, res) => {
  const runner = runnerOf(req);
  const job = await requireLease(String(req.params.jobId), leaseOf(req));
  const input = resultsSchema.parse(req.body);

  let accepted = 0;
  const unknownTests: string[] = [];

  for (const execution of input.results) {
    const result = await prisma.testResult.findFirst({
      where: {
        runId: job.runId,
        testId: execution.testId,
        ...(job.shardIndex === null ? {} : { shardIndex: job.shardIndex }),
      },
      select: { id: true, testId: true },
    });

    /*
     * A result for a test that is not in this slice is dropped, not an error.
     * The agent may be a version behind and running a test the run no longer
     * contains; failing the whole batch would lose the twenty results that ARE
     * valid, which is precisely the reporting problem that must never cost a
     * run its verdict.
     */
    if (!result) {
      unknownTests.push(execution.testId);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.testResult.update({
        where: { id: result.id },
        data: {
          status: execution.status,
          durationMs: execution.durationMs,
          errorMessage: execution.errorMessage ?? null,
          retriedAndPassed: execution.retriedAndPassed,
          network: execution.network as unknown as object,
          consoleLog: execution.console as unknown as object,
          videoKey: execution.videoKey ?? null,
          traceKey: execution.traceKey ?? null,
        },
      });

      // Replace rather than append: a re-reported test must not double its steps.
      await tx.step.deleteMany({ where: { testResultId: result.id } });
      if (execution.steps.length > 0) {
        await tx.step.createMany({
          data: execution.steps.map((step) => ({
            orgId: runner.orgId,
            testResultId: result.id,
            index: step.index,
            title: step.title,
            status: step.status,
            durationMs: step.durationMs,
            screenshotKey: step.screenshotKey ?? null,
            errorMessage: step.error?.message ?? null,
            errorStack: step.error?.stack ?? null,
            selector: step.error?.selector ?? null,
            expected: step.error?.expected ?? null,
            actual: step.error?.actual ?? null,
            startedAt: step.startedAt ? new Date(step.startedAt) : null,
          })),
        });
      }

      await tx.finding.deleteMany({ where: { testResultId: result.id } });
      if (execution.findings.length > 0) {
        await tx.finding.createMany({
          data: execution.findings.map((finding) => ({
            orgId: runner.orgId,
            testResultId: result.id,
            kind: finding.kind,
            severity: finding.severity,
            code: finding.code,
            message: finding.message,
            location: finding.location,
            helpUrl: finding.helpUrl ?? null,
          })),
        });
      }
    });

    accepted += 1;
    publish(runner.orgId, {
      runId: job.runId,
      type: 'test.finished',
      data: {
        testId: execution.testId,
        status: execution.status,
        durationMs: execution.durationMs,
        onPrem: true,
      },
      at: new Date().toISOString(),
    });
  }

  if (unknownTests.length > 0) {
    logger.warn(
      { jobId: job.id, runId: job.runId, tests: unknownTests.slice(0, 10) },
      'on-prem runner reported results for tests outside its slice; dropped',
    );
  }

  // Reporting is work, so it renews the lease. A suite of long tests that
  // reports steadily should never be reaped for silence.
  await renewLease({ jobId: job.id, leaseId: leaseOf(req), running: true });

  res.json({ accepted, dropped: unknownTests.length });
});

// ─── Agent: logs ─────────────────────────────────────────────────────────────

const logsSchema = z.object({
  lines: z
    .array(
      z.object({
        level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        text: z.string().max(2_000),
        at: z.string().max(64).optional(),
      }),
    )
    .max(MAX_LOG_LINES_PER_CALL),
});

/**
 * The agent's console, relayed to whoever is watching the run.
 *
 * Never persisted. These lines come from a customer's own machine and can
 * contain anything that machine printed — the run's evidence is the results and
 * the artifacts, and a log line is a convenience for the person watching right
 * now.
 */
agentRouter.post('/jobs/:jobId/logs', async (req, res) => {
  const runner = runnerOf(req);
  const job = await requireLease(String(req.params.jobId), leaseOf(req));
  const input = logsSchema.parse(req.body);

  for (const line of input.lines) {
    publish(runner.orgId, {
      runId: job.runId,
      type: 'log',
      data: { level: line.level, text: line.text, runner: runner.name, onPrem: true },
      at: line.at ?? new Date().toISOString(),
    });
  }

  await renewLease({ jobId: job.id, leaseId: leaseOf(req), running: true });
  res.json({ accepted: input.lines.length });
});

// ─── Agent: artifacts ────────────────────────────────────────────────────────

/**
 * A screenshot, a video, a trace — the bytes, over the same authenticated
 * channel, because a customer's runner cannot reach our object store directly
 * and we are not handing out storage credentials to a process we do not run.
 *
 * The name is sanitised by `artifactKey` into a run-scoped key, so a caller
 * cannot choose where in the bucket its bytes land or overwrite another run's
 * trace. The raw parser is mounted on this path alone; everywhere else in this
 * router takes JSON.
 */
agentRouter.post(
  '/jobs/:jobId/artifacts',
  express.raw({ type: () => true, limit: MAX_ARTIFACT_BYTES }),
  async (req, res) => {
    const runner = runnerOf(req);
    const job = await requireLease(String(req.params.jobId), leaseOf(req));

    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!name) throw badRequest('Name the artifact with ?name=<filename>');

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      // Names the likely cause: a JSON content-type is consumed by the global
      // parser before this route's raw parser ever sees the stream, and the
      // symptom is an empty body rather than an obvious error.
      throw badRequest(
        'The artifact body was empty. Send the bytes with content-type application/octet-stream.',
      );
    }

    const contentType =
      typeof req.query.contentType === 'string'
        ? req.query.contentType.slice(0, 128)
        : 'application/octet-stream';

    const key = artifactKey({ orgId: runner.orgId, runId: job.runId, name });
    await storage.put(key, body, contentType);

    const org = await prisma.organization.findUnique({
      where: { id: runner.orgId },
      select: { plan: true },
    });
    const expiresAt = new Date(Date.now() + retentionDaysFor(org?.plan ?? 'FREE') * 86_400_000);

    // Upsert: a retried upload must not collide on the unique key and cost the
    // agent an artifact it already stored successfully.
    await prisma.artifact.upsert({
      where: { key },
      create: {
        orgId: runner.orgId,
        runId: job.runId,
        key,
        contentType,
        sizeBytes: body.length,
        expiresAt,
      },
      update: { sizeBytes: body.length, contentType },
    });

    await renewLease({ jobId: job.id, leaseId: leaseOf(req), running: true });
    res.status(201).json({ key });
  },
);

// ─── Agent: complete ─────────────────────────────────────────────────────────

const completeSchema = z.object({
  status: z.enum(['COMPLETED', 'FAILED', 'CANCELLED']).default('COMPLETED'),
  errorMessage: z.string().max(4_000).nullish(),
});

/**
 * The agent is done with this job.
 *
 * FAILED here means the AGENT failed — it could not start the executor, the
 * workspace would not materialise — not that tests failed. Tests failing is a
 * result, and results arrive on the endpoint above. That distinction is why a
 * missing toolchain must reach us as a SKIP and not as this.
 *
 * Finalisation is attempted but never allowed to fail the response: the job is
 * already terminal by then, and an agent that saw a 500 would retry a call that
 * cannot succeed twice. The next completion, or the next poll's sweep, closes
 * the run instead.
 */
agentRouter.post('/jobs/:jobId/complete', async (req, res) => {
  const runner = runnerOf(req);
  const job = await requireLease(String(req.params.jobId), leaseOf(req));
  const input = completeSchema.parse(req.body ?? {});

  await prisma.runnerJob.updateMany({
    where: { id: job.id, leaseId: leaseOf(req) },
    data: {
      status: input.status,
      // The lease is dropped with the job. Nothing more may be written under it.
      leaseId: null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
      errorMessage: input.errorMessage ?? null,
    },
  });

  // A slice finishing is progress. `run.finished` is published by
  // `finalizeIfComplete` and only when EVERY job is done — a merge gate keys off
  // that event, and one shard reporting it early is the worst bug this feature
  // could ship.
  publish(runner.orgId, {
    runId: job.runId,
    type: 'log',
    data: {
      level: input.status === 'COMPLETED' ? 'info' : 'error',
      text: `runner "${runner.name}" finished its work: ${input.status.toLowerCase()}${
        input.errorMessage ? ` — ${input.errorMessage}` : ''
      }`,
      onPrem: true,
    },
    at: new Date().toISOString(),
  });

  const finalized = await finalizeIfComplete(runner.orgId, job.runId).catch((err) => {
    logger.error({ err, runId: job.runId }, 'could not finalise an on-prem run');
    return false;
  });

  res.json({ ok: true, finalized });
});

/** Terminate the agent surface here, so nothing falls through into admin auth. */
agentRouter.use((_req, _res, next) => next(notFound('Runner endpoint')));

runnersRouter.use('/agent', agentRouter);

// ─── Admin ───────────────────────────────────────────────────────────────────
//
// Route order is load-bearing below: `/queue` is a literal that would be
// swallowed by a `POST /:runnerId` if anyone ever adds one. If you need a route
// on a single runner, give it a suffix (`/:runnerId/rotate`) like the two that
// already exist.

runnersRouter.use(requireAuth);

/** The fleet, with liveness derived rather than stored. */
runnersRouter.get('/', async (_req, res) => {
  const runners = await prisma.runner.findMany({
    where: { revokedAt: null },
    orderBy: { createdAt: 'desc' },
    // The hash is never returned; the prefix is the only recoverable part.
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      pools: true,
      capabilities: true,
      agentVersion: true,
      platform: true,
      lastSeenAt: true,
      lastClaimAt: true,
      tokenRotatedAt: true,
      createdAt: true,
    },
  });

  res.json({
    runners: runners.map((runner) => ({
      ...runner,
      capabilities: parseCapabilities(runner.capabilities),
      online: isOnline(runner.lastSeenAt),
    })),
  });
});

/**
 * What the on-prem pool is being asked to do, and what is stuck.
 *
 * Sweeps before it answers, and that is not an optimisation.
 *
 * The sweep is normally driven by agents polling — which works precisely as
 * long as there is an agent. The case that most needs sweeping is the one where
 * there is NOT: an org whose only runner was decommissioned has jobs nobody
 * will ever claim, so nothing polls, so nothing declares them unservable, so
 * the run hangs RUNNING forever with no explanation anywhere. An admin opening
 * this screen is exactly the moment that has to resolve, so opening it does.
 *
 * (`sweepOrg` throttles itself per org, so a dashboard on a refresh timer costs
 * one sweep a minute.)
 */
runnersRouter.get('/queue', async (req, res) => {
  const actor = actorOf(req);
  await sweepOrg(actor.orgId).catch(() => {});

  const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
  const jobs = await prisma.runnerJob.findMany({
    where: { ...(runId ? { runId } : {}) },
    orderBy: { queuedAt: 'desc' },
    take: 200,
    select: {
      id: true,
      runId: true,
      shardIndex: true,
      status: true,
      pool: true,
      requirements: true,
      runnerId: true,
      attempt: true,
      maxAttempts: true,
      queuedAt: true,
      claimedAt: true,
      finishedAt: true,
      leaseExpiresAt: true,
      errorMessage: true,
    },
  });
  res.json({ jobs });
});

const createRunnerSchema = z.object({
  name: z.string().min(1).max(120),
  pools: z.array(z.string().min(1).max(64)).max(16).default([]),
});

/**
 * Register a runner and mint its token.
 *
 * The token is shown exactly once, like an API key and an invite link. There is
 * no way to see it again — losing it means rotating, which is one call and
 * leaves an audit trail saying so.
 */
runnersRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = createRunnerSchema.parse(req.body ?? {});
  const token = mintRunnerToken();

  const runner = await prisma.runner.create({
    data: {
      orgId: actor.orgId,
      name: input.name,
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      pools: input.pools,
      createdBy: actor.userId || null,
    },
    select: { id: true, name: true, tokenPrefix: true, pools: true, createdAt: true },
  });

  await audit({
    actor,
    action: 'runner.create',
    targetType: 'Runner',
    targetId: runner.id,
    // The prefix, never the token. An audit log that records credentials is a
    // credential store with worse access control.
    metadata: { name: runner.name, pools: runner.pools, tokenPrefix: runner.tokenPrefix },
  });

  res.status(201).json({ runner, token: token.raw });
});

/**
 * Rotate a runner's token.
 *
 * The old token stops working the instant this returns, so the agent's next
 * call fails and the operator has to paste the new one. That is the intended
 * shape: a rotation with an overlap window is a rotation that does not revoke
 * anything, and the reason to rotate is usually that the old value leaked.
 *
 * In-flight work is released rather than abandoned — the runner is losing its
 * credential, not its competence, and the job goes straight back to the queue
 * for whichever agent authenticates next.
 */
runnersRouter.post('/:runnerId/rotate', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const runner = await prisma.runner.findUnique({ where: { id: String(req.params.runnerId) } });
  if (!runner || runner.revokedAt) throw notFound('Runner');

  const token = mintRunnerToken();
  await prisma.runner.update({
    where: { id: runner.id },
    data: { tokenHash: token.hash, tokenPrefix: token.prefix, tokenRotatedAt: new Date() },
  });

  const released = await releaseRunnerJobs(
    runner.id,
    'The token for the runner holding this work was rotated; re-queued for another runner.',
  );

  await audit({
    actor,
    action: 'runner.token.rotate',
    targetType: 'Runner',
    targetId: runner.id,
    metadata: {
      name: runner.name,
      previousTokenPrefix: runner.tokenPrefix,
      tokenPrefix: token.prefix,
      releasedJobs: released,
    },
  });

  res.json({ runner: { id: runner.id, name: runner.name, tokenPrefix: token.prefix }, token: token.raw });
});

/**
 * Revoke a runner.
 *
 * A timestamp, not a delete: the audit trail has to keep pointing at a row that
 * still exists, and "which runner ran this" must stay answerable for every job
 * it ever executed.
 */
runnersRouter.delete('/:runnerId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const runner = await prisma.runner.findUnique({ where: { id: String(req.params.runnerId) } });
  if (!runner) throw notFound('Runner');

  await prisma.runner.update({ where: { id: runner.id }, data: { revokedAt: new Date() } });
  const released = await releaseRunnerJobs(
    runner.id,
    'The runner holding this work was revoked; re-queued for another runner.',
  );

  await audit({
    actor,
    action: 'runner.revoke',
    targetType: 'Runner',
    targetId: runner.id,
    metadata: { name: runner.name, tokenPrefix: runner.tokenPrefix, releasedJobs: released },
  });

  res.json({ ok: true, releasedJobs: released });
});

const dispatchSchema = z.object({ runId: z.string().min(1).max(64) });

/**
 * Re-create the jobs for a run that is already dispatched on-prem.
 *
 * The repair tool, and deliberately not a way to move a run onto the on-prem
 * pool. It refuses unless `Run.runnerPool` is already set, because that column
 * is the record that no queue job was enqueued for this run — creating runner
 * jobs for a run the cloud worker also holds would execute the suite twice, in
 * two places, against the same environment.
 *
 * Idempotent, so it is safe to call twice and safe to call while a runner is
 * mid-job: `createRunnerJobs` skips duplicates on the dedupe key.
 */
runnersRouter.post('/queue', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = dispatchSchema.parse(req.body ?? {});

  const run = await prisma.run.findUnique({
    where: { id: input.runId },
    select: { id: true, runnerPool: true, shardCount: true, finalizedAt: true },
  });
  if (!run) throw notFound('Run');
  if (!run.runnerPool) {
    throw badRequest(
      'That run was not dispatched to an on-prem pool. Set a runner pool on the environment and start a new run — ' +
        'creating runner jobs for a run the cloud worker is also holding would execute it twice.',
    );
  }
  if (run.finalizedAt) throw badRequest('That run has already reported; start a new one.');

  const results = await prisma.testResult.findMany({
    where: { runId: run.id },
    select: { shardIndex: true, test: { select: { type: true } } },
  });
  if (results.length === 0) throw badRequest('That run has no tests to dispatch.');

  const bySlice = new Map<number | null, Array<{ type: (typeof results)[number]['test']['type'] }>>();
  for (const result of results) {
    const slice = bySlice.get(result.shardIndex) ?? [];
    slice.push({ type: result.test.type });
    bySlice.set(result.shardIndex, slice);
  }

  const created = await createRunnerJobs({
    orgId: actor.orgId,
    runId: run.id,
    pool: run.runnerPool,
    slices: [...bySlice.entries()].map(([shardIndex, tests]) => ({
      shardIndex,
      requirements: requirementsForTests(tests),
    })),
  });

  await audit({
    actor,
    action: 'runner.job.dispatch',
    targetType: 'Run',
    targetId: run.id,
    metadata: { pool: run.runnerPool, created, slices: bySlice.size },
  });

  res.status(created > 0 ? 201 : 200).json({
    created,
    // Named so an operator can see which slice already existed rather than
    // wondering why "created" is less than the number of shards.
    dedupeKeys: [...bySlice.keys()].map((shardIndex) => dedupeKeyFor(run.id, shardIndex)),
  });
});
