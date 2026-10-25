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
 *
 * ─── What a cluster now carries with it ────────────────────────────────────
 *
 * Clustering answered "how many causes are there in this run". It could not
 * answer the question a reviewer asks next, which is "and which of them is
 * NEW?" — because `signatureOf()` produced a stable cause key that was stored
 * nowhere. Each cluster now carries `identity`, read from the rows the worker
 * writes while it triages (`FailureSignature`, `RunFailureCluster`):
 *
 *  · `newInThisBuild` — an EQUALITY against `FailureSignature.firstSeenRunId`,
 *    not a window search over history. This is the single most useful sentence
 *    to put in front of a reviewer: a cause that has failed for three weeks is
 *    somebody's known problem, and a cause ninety seconds old belongs to
 *    whoever just merged.
 *  · `mute` — a suppressed cause appears here with its expiry and its
 *    suppressed count, rather than vanishing. A mute that made the cause
 *    invisible would be a blind spot wearing a feature's clothes.
 *  · `modelCalls` / `attachments` — what triaging this cause actually cost. One
 *    call for forty failures is the claim this product makes about itself, and
 *    it is reported as a number somebody can check rather than as a promise.
 *
 * `identity` is NULL when the worker has not recorded the cause yet, which is
 * genuinely different from "not new" and is never flattened into false. Runs
 * that predate this feature have no identities at all, and say so.
 *
 * THE JOIN. `identity` is keyed on `failureClusterKey(cluster.signature)` —
 * the one implementation of the cause hash (packages/agent/src/triage.ts) —
 * rather than on the clusterer's own `cluster.id`, which is computed from the
 * same signature by a private helper in ../lib/cluster.js. The two are
 * byte-identical today and clusters.test.ts asserts it over a corpus of real
 * failure text. Going through the canonical function means that if they ever
 * drift, an identity reads as MISSING here instead of as somebody else's cause.
 */

import { Router } from 'express';
import { failureClusterKey, muteInForce } from '@qaai/agent';
import { summariseFailure, type FailureSummaryInput } from '@qaai/shared';
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

  const identities = await identitiesFor(run.id, run.projectId, [
    ...report.clusters.map((c) => c.signature),
    ...report.unclustered.map((u) => u.signature),
  ]);

  const byResult = new Map(results.map((r) => [r.id, r]));

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
    clusters: report.clusters.map((cluster) => ({
      ...cluster,
      identity: identities.get(failureClusterKey(cluster.signature)) ?? null,
      /*
       * The deterministic failure box for the member the clusterer sampled, so
       * the cluster view and the result view say the same thing about the same
       * failure instead of two independently-worded sentences. It is computed
       * (no model), and `cause` feeds the identity into its reliability notes —
       * which is how "this cause is new in this build" reaches the one box a
       * reviewer actually reads.
       */
      summary: summaryFor(
        byResult.get(cluster.members[0]?.testResultId ?? ''),
        identities.get(failureClusterKey(cluster.signature)) ?? null,
      ),
    })),
    unclustered: report.unclustered.map((entry) => ({
      ...entry,
      identity: identities.get(failureClusterKey(entry.signature)) ?? null,
      summary: summaryFor(
        byResult.get(entry.member.testResultId),
        identities.get(failureClusterKey(entry.signature)) ?? null,
      ),
    })),
    // `failures` counts what was clusterable, which can be lower than the run's
    // failedCount when a result carried no error text. Both are returned so the
    // UI never has to explain a number it cannot reconcile.
    summary: {
      ...report.summary,
      ...triageCost([...identities.values()], report.summary.clustered),
    },
  });
});

/** What the identity rows say about one cause, in the shape the UI reads. */
interface CauseIdentity {
  clusterKey: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  runsSeen: number;
  occurrences: number;
  /** An equality against `firstSeenRunId`, not a guess. */
  newInThisBuild: boolean;
  /** Failing results in THIS run that the worker attributed to this cause. */
  membersThisRun: number;
  modelCalls: number;
  attachments: number;
  suppressedThisRun: boolean;
  mute: {
    inForce: boolean;
    until: Date;
    reason: string | null;
    by: string | null;
    suppressed: number;
  } | null;
}

/**
 * Reads both identity tables for the causes in this run.
 *
 * Two queries, both index-only in shape: `RunFailureCluster` by
 * (orgId, runId) — which is what makes "new in this build" answerable without a
 * join at all, since `firstSeenInProject` is stamped there — and
 * `FailureSignature` by its unique (orgId, projectId, clusterKey) for the
 * cross-run history. The keys come from the signatures the clusterer just
 * produced, so neither query scans.
 */
async function identitiesFor(
  runId: string,
  projectId: string,
  signatures: readonly string[],
): Promise<Map<string, CauseIdentity>> {
  const keys = [...new Set(signatures.map((s) => failureClusterKey(s)))];
  if (keys.length === 0) return new Map();

  const [occurrences, causes] = await Promise.all([
    prisma.runFailureCluster.findMany({
      where: { runId, clusterKey: { in: keys } },
      select: {
        clusterKey: true,
        members: true,
        modelCalls: true,
        attachments: true,
        suppressed: true,
        firstSeenInProject: true,
      },
    }),
    prisma.failureSignature.findMany({
      where: { projectId, clusterKey: { in: keys } },
      select: {
        clusterKey: true,
        firstSeenAt: true,
        firstSeenRunId: true,
        lastSeenAt: true,
        runCount: true,
        occurrenceCount: true,
        mutedUntil: true,
        mutedReason: true,
        mutedBy: true,
        suppressedCount: true,
      },
    }),
  ]);

  const now = new Date();
  const perRun = new Map(occurrences.map((o) => [o.clusterKey, o]));
  const out = new Map<string, CauseIdentity>();

  for (const cause of causes) {
    const run = perRun.get(cause.clusterKey);
    out.set(cause.clusterKey, {
      clusterKey: cause.clusterKey,
      firstSeenAt: cause.firstSeenAt,
      lastSeenAt: cause.lastSeenAt,
      runsSeen: cause.runCount,
      occurrences: cause.occurrenceCount,
      /*
       * Preferring the per-run flag is not belt-and-braces, it is the correct
       * read: both are written from the same signature row in the worker's
       * claim path, and the per-run one is the value AS OF this run — so a
       * cause first seen here stays "new in this build" when the page is
       * re-opened next week, which the equality on the live row would not.
       */
      newInThisBuild: run ? run.firstSeenInProject : cause.firstSeenRunId === runId,
      membersThisRun: run?.members ?? 0,
      modelCalls: run?.modelCalls ?? 0,
      attachments: run?.attachments ?? 0,
      suppressedThisRun: run?.suppressed ?? false,
      mute: cause.mutedUntil
        ? {
            inForce: muteInForce(cause, now),
            until: cause.mutedUntil,
            reason: cause.mutedReason,
            by: cause.mutedBy,
            suppressed: cause.suppressedCount,
          }
        : null,
    });
  }

  return out;
}

/**
 * What triaging this run's causes cost, and what the per-cause collapse saved.
 *
 * `wouldHaveBeen` is the number of model calls the old once-per-result design
 * would have made for the failures that clustered — which is exactly the
 * clustered-failure count, because that design made one call per failure.
 * `savedCalls` is deliberately floored at 0: a run where a waiter timed out and
 * paid for a second call must not report a negative saving dressed up as a
 * win, and must not report a win it did not get.
 *
 * Null rather than zero when no identity was recorded at all. A run that
 * predates this feature spent its calls; reporting 0 would read as "we saved
 * everything", which is the opposite of the truth.
 */
function triageCost(
  identities: readonly CauseIdentity[],
  clustered: number,
): {
  modelCalls: number | null;
  attachments: number | null;
  wouldHaveBeen: number;
  savedCalls: number | null;
  suppressedCauses: number;
} {
  if (identities.length === 0) {
    return {
      modelCalls: null,
      attachments: null,
      wouldHaveBeen: clustered,
      savedCalls: null,
      suppressedCauses: 0,
    };
  }
  const modelCalls = identities.reduce((sum, i) => sum + i.modelCalls, 0);
  const attachments = identities.reduce((sum, i) => sum + i.attachments, 0);
  return {
    modelCalls,
    attachments,
    wouldHaveBeen: clustered,
    savedCalls: Math.max(0, clustered - modelCalls),
    suppressedCauses: identities.filter((i) => i.suppressedThisRun).length,
  };
}

/**
 * The deterministic failure box for one result, with the cause identity folded
 * in. Returns null when the result is not in hand — which is honest, and the
 * reason `summariseFailure` takes `cause` as optional at all.
 */
function summaryFor(
  result:
    | {
        status: string;
        errorMessage: string | null;
        retriedAndPassed: boolean;
        test: { filePath: string };
        steps: ReadonlyArray<{
          index: number;
          title: string;
          status: string;
          errorMessage: string | null;
          errorStack: string | null;
          selector: string | null;
          expected: string | null;
          actual: string | null;
        }>;
      }
    | undefined,
  identity: CauseIdentity | null,
): ReturnType<typeof summariseFailure> {
  if (!result) return null;
  const input: FailureSummaryInput = {
    status: result.status as FailureSummaryInput['status'],
    errorMessage: result.errorMessage,
    retriedAndPassed: result.retriedAndPassed,
    filePath: result.test.filePath,
    steps: result.steps as FailureSummaryInput['steps'],
    ...(identity
      ? {
          cause: {
            clusterKey: identity.clusterKey,
            firstSeenAt: identity.firstSeenAt.toISOString(),
            lastSeenAt: identity.lastSeenAt.toISOString(),
            runsSeen: identity.runsSeen,
            newInThisBuild: identity.newInThisBuild,
            mutedUntil: identity.mute?.until.toISOString() ?? null,
            mutedReason: identity.mute?.reason ?? null,
          },
        }
      : {}),
  };
  return summariseFailure(input);
}
