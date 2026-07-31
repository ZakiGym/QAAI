/**
 * Failure clusters for a run (§3.3) — the "what actually broke" view.
 *
 * The cockpit's run page lists failures one per row, which is the right shape
 * when three tests failed and the wrong one when forty did. This endpoint reads
 * the same results and answers the question a person actually has on a red
 * build: how many *causes* are there, and which one is biggest.
 *
 * Read-only and derived. Nothing here writes a verdict — `suggested` is a
 * recommendation attached to a group, and accepting it stays a human action
 * through the existing triage-review path, per §3.3's rule that QAAI never
 * silently decides.
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { notFound } from '../lib/errors.js';
import { clusterFailures, type FailureInput, type FailureNetworkInput } from '../lib/cluster.js';
import { requireAuth } from '../middleware/auth.js';

export const clustersRouter: Router = Router();

clustersRouter.use(requireAuth);

/**
 * FLAKY is in here alongside FAILED and TIMED_OUT because §5 is explicit that a
 * retry which passes is not a pass. A flake that shares its signature with
 * twenty hard failures is evidence about the same cause, and hiding it would
 * make the biggest cluster look smaller than it is.
 */
const FAILING_STATUSES = ['FAILED', 'TIMED_OUT', 'FLAKY'] as const;

/**
 * `TestResult.network` is a Json column holding NetworkEntry[]. It is written by
 * the worker, so it is trusted, but it is still schemaless from Prisma's side —
 * parsed defensively so a malformed row degrades one cluster rather than 500ing
 * the whole page.
 */
function readFailedRequests(value: unknown): FailureNetworkInput[] {
  if (!Array.isArray(value)) return [];

  const failed: FailureNetworkInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== 'string') continue;

    const status = typeof record.status === 'number' ? record.status : null;
    // Only requests that failed are evidence about a failure. A full page load
    // is hundreds of successful entries and none of them explain anything.
    if (status !== null && status < 400) continue;

    failed.push({
      method: typeof record.method === 'string' ? record.method : 'GET',
      url: record.url,
      status,
    });
    if (failed.length >= 25) break;
  }
  return failed;
}

clustersRouter.get('/run/:runId', async (req, res) => {
  // Tenancy is enforced by the Prisma extension, so a run belonging to another
  // org reads as absent — which is the behaviour notFound() exists to give.
  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    select: {
      id: true,
      status: true,
      projectId: true,
      totalCount: true,
      failedCount: true,
      flakyCount: true,
      finishedAt: true,
    },
  });
  if (!run) throw notFound('Run');

  const results = await prisma.testResult.findMany({
    where: { runId: run.id, status: { in: [...FAILING_STATUSES] } },
    select: {
      id: true,
      testId: true,
      status: true,
      errorMessage: true,
      retriedAndPassed: true,
      network: true,
      test: { select: { name: true, filePath: true } },
      // Only the failed steps: the passing ones describe what worked, and the
      // clusterer reads a step for the locator and the expected/actual it
      // already parsed out of the failure.
      steps: {
        where: { status: 'FAILED' },
        orderBy: { index: 'asc' },
        select: {
          index: true,
          status: true,
          title: true,
          errorMessage: true,
          errorStack: true,
          selector: true,
          expected: true,
          actual: true,
        },
      },
      verdict: { select: { verdict: true, overriddenTo: true, reviewState: true } },
    },
  });

  const failures: FailureInput[] = results
    // A FLAKY result whose final attempt passed can carry no error text at all.
    // There is nothing to normalise, so it is dropped rather than parked in
    // `unclustered` as a row that says nothing — which is the same reason a
    // cluster of one is not a cluster.
    .filter((r) => Boolean(r.errorMessage) || r.steps.length > 0)
    .map((r) => ({
      testResultId: r.id,
      testId: r.testId,
      testName: r.test.name,
      filePath: r.test.filePath,
      status: r.status,
      errorMessage: r.errorMessage,
      retriedAndPassed: r.retriedAndPassed,
      steps: r.steps,
      network: readFailedRequests(r.network),
      verdict: r.verdict,
    }));

  const report = clusterFailures(failures);

  res.json({
    run: {
      id: run.id,
      projectId: run.projectId,
      status: run.status,
      totalCount: run.totalCount,
      failedCount: run.failedCount,
      flakyCount: run.flakyCount,
      finishedAt: run.finishedAt,
    },
    clusters: report.clusters,
    unclustered: report.unclustered,
    // `failures` counts what was clusterable, which can be lower than the run's
    // failedCount when a result carried no error text. Both are returned so the
    // UI never has to explain a number it cannot reconcile.
    summary: report.summary,
  });
});
