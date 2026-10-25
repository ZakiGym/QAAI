/**
 * Triage processor (§3.3) and the Healer hand-off (§3.4).
 *
 * ─── What this used to do, and why it was expensive ─────────────────────────
 *
 * It ran once per failing test result and called the model once per run. One
 * dead dependency that takes out 200 tests therefore cost 200 model calls and
 * produced 200 independently-worded verdicts for ONE cause. Worse than the
 * money: 200 agreeing verdicts read like 200 pieces of evidence when they are
 * one sentence restated 200 times, and a reviewer who disagrees with the cause
 * has to disagree 200 times.
 *
 * The clusterer that already knew they were one cause
 * (apps/api/src/lib/cluster.ts) was read-only and ran in the cockpit — after
 * the calls had been made.
 *
 * ─── What it does now ──────────────────────────────────────────────────────
 *
 * The run's failures are clustered FIRST, and the model is asked once per
 * cause. Four things make that safe:
 *
 *  1. THE CLAIM IS AN INSERT, NOT A CHECK. This queue runs at
 *     `concurrency * 2` (src/index.ts), so two jobs for two members of one
 *     cluster really do both look for an existing verdict and both find none.
 *     `RunFailureCluster` has `@@unique([runId, clusterKey])`, so the first
 *     INSERT wins the cause for that run and the loser waits for the winner's
 *     verdict instead of buying a second one. Same shape as `SsoAssertionSeen`:
 *     the insert is the decision.
 *
 *  2. THE WAIT IS BOUNDED AND THE FALLBACK IS HONEST. A waiter that gave up
 *     silently would leave a failure with no verdict at all, so on timeout it
 *     triages itself and `RunFailureCluster.modelCalls` goes to 2. The
 *     accounting records what happened, not what we hoped for.
 *
 *  3. A COPY IS MARKED AS A COPY. `deriveClusterVerdict` prefixes `model` with
 *     `cluster:` and appends one evidence line naming the result the call
 *     actually read. Without it the cost ledger would report 200 cheap-model
 *     calls that never happened, and a reader following "step 3" would be
 *     looking at a different test's trace.
 *
 *  4. MEMBERS ARE ALLOWED TO DIFFER, AND A HUMAN CAN SAY SO. See
 *     "CLUSTER DISAGREEMENT" below.
 *
 * ─── CLUSTER DISAGREEMENT ──────────────────────────────────────────────────
 *
 * Two tests can produce the same signature and genuinely deserve different
 * verdicts: the same "locator not found" from a test whose element was renamed
 * (INTENDED_CHANGE) and from a test whose element is gone because the feature
 * broke (REAL_BUG). Clustering is a claim about the EVIDENCE being the same,
 * not a proof that the causes are.
 *
 * So the per-result `TriageVerdict` row stays the unit of truth, and the design
 * is deliberately asymmetric:
 *
 *  · The cluster's answer is COPIED onto each member, and each copy is
 *    independently reviewable — accept, override or mute it per member exactly
 *    as before. `derivedFromId` says where it came from.
 *  · A reviewer who disagrees about ONE member SPLITS it: POST
 *    /triage/verdicts/:id/retriage with `split: true` supersedes that member's
 *    copy with a fresh first-hand model call on that result alone, and stamps
 *    `splitFromClusterKey`. A split member is never re-attached, because
 *    attachment only ever writes a verdict where there is none.
 *  · The prompt is told that members may differ and to drop its confidence and
 *    say which member bothers it when they might (see the SYSTEM text in
 *    packages/agent/src/triage.ts). An uncertain shared verdict is the signal
 *    that a split is worth making.
 *
 * The alternative — refuse to share a verdict unless the members provably
 * agree — is unbuildable: proving they agree is the model call we are trying
 * not to make 200 times.
 *
 * ─── MUTE ──────────────────────────────────────────────────────────────────
 *
 * A muted cause mints NO verdict. That is what makes it stop paging, and it is
 * concrete rather than hopeful: `GET /badges` counts PENDING verdicts,
 * processors/digest.ts lists verdicts, and the gate blocks on REAL_BUG
 * verdicts, so a cause with no verdict row reaches none of them. It is still
 * recorded (`RunFailureCluster.suppressed`) and still counted
 * (`FailureSignature.suppressedCount`), because "it went quiet" and "it stopped
 * happening" are different facts and a mute that recorded nothing would make
 * them indistinguishable.
 */

import { randomUUID } from 'node:crypto';
import {
  applyHealDiff,
  CORRECTION_HISTORY_DAYS,
  deriveClusterVerdict,
  failureClusterKey,
  isAutoApprovable,
  muteInForce,
  postCheckCode,
  proposeHeal,
  shouldProposeHeal,
  summariseCorrections,
  triageFailure,
  verificationRunTag,
} from '@qaai/agent';
import type { CorrectionRow, OpenHeal, TriageClusterContext } from '@qaai/agent';
import type { FlowMap, StepResult, TestExecution, TestType, TriageJob } from '@qaai/shared';
/*
 * The clusterer lives in the API workspace and the worker shares it rather than
 * keeping a second copy of 400 lines of normalisation regexes — the same
 * arrangement src/index.ts already uses for `CHECKS_QUEUE` in
 * ../../api/src/lib/github-app.js, and for the same reason: two
 * implementations of one normaliser drift the day somebody adds a rule to one.
 *
 * It belongs in @qaai/shared and cannot go there as written: that package's
 * barrel is consumed by the web app's bundler, and `node:crypto` in it breaks
 * the build (see the comment atop packages/shared/src/index.ts). The hash is
 * therefore in @qaai/agent (`failureClusterKey`) and the normaliser is read
 * from here.
 */
import {
  extractFacets,
  labelFor,
  signatureOf,
  type FailureInput,
  type FailureNetworkInput,
  type FailureStepInput,
} from '../../../api/src/lib/cluster.js';
/*
 * The run toll, reached by path for the same reason as the clusterer above: a
 * verification run is a Run, so it goes through the one gate that counts them
 * (apps/api/src/lib/start-run.ts) rather than inserting a row behind the plan's
 * back. processors/flake.ts reaches for it exactly this way.
 */
import { startRun } from '../../../api/src/lib/start-run.js';
import { llm, logger, prisma, publishEvent } from '../context.js';
import { enqueueRun } from '../queues.js';

/**
 * How long a waiter will wait for the cause's owner to publish its verdict.
 *
 * A MUTABLE EXPORTED OBJECT rather than two consts, and deliberately not an
 * environment variable: scripts/check-wiring.ts refuses an env var nobody
 * deploying this could discover, and the tests need to drive the timeout arm
 * without sleeping for twenty seconds. `processTriage`'s signature cannot carry
 * an injection point — src/index.ts registers it as the queue handler and
 * BullMQ passes the Job as the second argument.
 *
 * 20s because the owner's whole job is one structured model call (two when the
 * first pass is uncertain and escalates), and the escalation path is the long
 * one. Past that, paying for a second call is cheaper than a failure with no
 * verdict.
 */
export const CLUSTER_VERDICT_WAIT = { totalMs: 20_000, pollMs: 250 };

/**
 * How many reviewed verdicts are read back to build the project's correction
 * prior. A bound, not a filter: `summariseCorrections` bounds the OUTPUT, and
 * this bounds the READ so a project with 90 000 reviewed verdicts does not
 * stream all of them into a worker to count four pairs.
 */
export const CORRECTION_HISTORY_SAMPLE = 400;

/**
 * How many of the run's failing results are clustered to size the cause.
 *
 * The owner of a cause scans the run's failures so it can tell the model "this
 * covers 43 tests" — cluster size is evidence a single result cannot give. The
 * cap keeps one pathological run (a 20 000-test suite failing whole) from
 * loading every row into the worker.
 *
 * Past the cap the number handed to the PROMPT under-counts, and that is an
 * accepted inaccuracy rather than a hidden one: the figure is already a
 * "so far" count (see `sizeCause`), it is used only as evidence that the cause
 * is shared, and the direction of the error is safe — it makes a large cause
 * look smaller, never a small one look shared. The authoritative count is
 * `RunFailureCluster.members`, which every attach increments and which the
 * cockpit reads.
 */
export const RUN_CLUSTER_SCAN_CAP = 1000;

const DAY_MS = 86_400_000;

/** FLAKY counts: §5 is explicit that a retry which passes is not a pass. */
const FAILING_STATUSES = ['FAILED', 'TIMED_OUT', 'FLAKY'] as const;

/** Prisma's unique-constraint code. Detected structurally so this file does not
 * have to import the generated error class into the worker's type graph. */
function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002');
}

/**
 * `TestResult.network` is a Json column the worker itself writes. Trusted, but
 * schemaless from Prisma's side — read defensively, exactly as
 * routes/clusters.ts does, so a malformed row costs one cause and not the job.
 */
function readFailedRequests(value: unknown): FailureNetworkInput[] {
  if (!Array.isArray(value)) return [];
  const failed: FailureNetworkInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== 'string') continue;
    const status = typeof record.status === 'number' ? record.status : null;
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

/** The clusterer's input shape, from a result row. */
function failureInputOf(row: {
  id: string;
  testId: string;
  status: string;
  errorMessage: string | null;
  retriedAndPassed: boolean;
  network: unknown;
  test: { name: string; filePath: string };
  steps: ReadonlyArray<{
    index: number;
    status: string;
    title: string;
    errorMessage: string | null;
    errorStack: string | null;
    selector: string | null;
    expected: string | null;
    actual: string | null;
  }>;
}): FailureInput {
  return {
    testResultId: row.id,
    testId: row.testId,
    testName: row.test.name,
    filePath: row.test.filePath,
    status: row.status,
    errorMessage: row.errorMessage,
    retriedAndPassed: row.retriedAndPassed,
    steps: row.steps.filter((s) => s.status === 'FAILED') as FailureStepInput[],
    network: readFailedRequests(row.network),
    // Triage is what WRITES the verdict, so at facet-extraction time there is
    // none. The facets never read it; it is the suggestion path in cluster.ts
    // that does, and that path is not reached from here.
    verdict: null,
  };
}

/** Facets, signature, key and label for one failing result. */
function causeOf(row: Parameters<typeof failureInputOf>[0]): {
  clusterKey: string;
  signature: string;
  label: string;
} {
  const facets = extractFacets(failureInputOf(row));
  // `|| 'msg=<none>'` matches clusterFailures() exactly: a failure that
  // normalised to nothing still needs a key, and it must be the SAME key the
  // cockpit shows for it.
  const signature = signatureOf(facets) || 'msg=<none>';
  return { clusterKey: failureClusterKey(signature), signature, label: labelFor(facets) };
}

interface ClaimedCause {
  signatureId: string;
  claimId: string;
  clusterKey: string;
  signature: string;
  label: string;
  /** This job inserted the per-run claim, so it owns the model call. */
  owner: boolean;
  /** This run is the run that minted the identity. */
  firstSeenInProject: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  runsSeen: number;
  mutedUntil: Date | null;
  mutedReason: string | null;
  /** The verdict the owner already published, when there is one. */
  verdictId: string | null;
  /**
   * A mute was in force for this cause while this run executed, so SOME member
   * of it has already returned without minting.
   *
   * Read, not only written, because it is the one state in which waiting for
   * the owner's verdict is waiting for something nobody is going to produce:
   * the mute path claims the cause and deliberately mints nothing. See the
   * attach path.
   */
  suppressed: boolean;
}

/**
 * Records this failure against its cause and tries to claim the cause for this
 * run.
 *
 * Three writes, in an order chosen so a crash between any two of them leaves
 * something true rather than something contradictory:
 *
 *  1. The `FailureSignature` row — created if this is the first time this
 *     project has ever produced this signature. `firstSeenRunId` is set to this
 *     run and never touched again, which is what makes "new in this build" an
 *     equality instead of a window search.
 *  2. The `RunFailureCluster` claim. `firstSeenInProject` is read off the
 *     signature row THIS CALL just minted or fetched, so the two cannot
 *     disagree.
 *  3. The counters. Last, because a counter that is one short is a worse
 *     outcome than a counter that is right and a claim that is missing — the
 *     claim is what prevents a duplicate model call.
 *
 * Both creates race against a sibling job and both handle the loss the same
 * way: catch the unique violation and read the winner's row. That is the whole
 * concurrency design — no advisory locks, no transactions spanning a model
 * call.
 */
async function claimCause(args: {
  orgId: string;
  projectId: string;
  runId: string;
  resultId: string;
  cause: { clusterKey: string; signature: string; label: string };
  now: Date;
  /** A re-triage must not re-count an occurrence it already counted. */
  countOccurrence: boolean;
}): Promise<ClaimedCause> {
  const { orgId, projectId, runId, resultId, cause, now } = args;
  const key = { orgId, projectId, clusterKey: cause.clusterKey };

  let signature = await prisma.failureSignature.findUnique({
    where: { orgId_projectId_clusterKey: key },
  });

  if (!signature) {
    try {
      signature = await prisma.failureSignature.create({
        data: {
          ...key,
          signature: cause.signature,
          label: cause.label,
          firstSeenAt: now,
          firstSeenRunId: runId,
          lastSeenAt: now,
          lastSeenRunId: runId,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      signature = await prisma.failureSignature.findUniqueOrThrow({
        where: { orgId_projectId_clusterKey: key },
      });
    }
  }

  const firstSeenInProject = signature.firstSeenRunId === runId;
  /*
   * Captured before the counter update below. `runsSeen` is "including this
   * run", and reading `signature.runCount` after the increment would add this
   * run twice — on the very first sighting that is the difference between
   * telling the model "seen once" and "seen twice", which is the opposite of
   * what `newInThisBuild` says beside it.
   */
  const runCountBefore = signature.runCount;

  let claim = await prisma.runFailureCluster.findUnique({
    where: { runId_clusterKey: { runId, clusterKey: cause.clusterKey } },
  });
  let owner = false;

  if (!claim) {
    try {
      claim = await prisma.runFailureCluster.create({
        data: {
          orgId,
          runId,
          projectId,
          clusterKey: cause.clusterKey,
          signature: cause.signature,
          label: cause.label,
          ownerResultId: resultId,
          signatureId: signature.id,
          firstSeenInProject,
          createdAt: now,
        },
      });
      owner = true;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      claim = await prisma.runFailureCluster.findUniqueOrThrow({
        where: { runId_clusterKey: { runId, clusterKey: cause.clusterKey } },
      });
    }
  }

  if (args.countOccurrence) {
    await prisma.$transaction([
      prisma.failureSignature.update({
        where: { id: signature.id },
        data: {
          occurrenceCount: { increment: 1 },
          // Once per RUN, and the claim insert is the only event that happens
          // once per run — so the run counter rides on it rather than on a
          // "have I seen this run before" read that two jobs would both lose.
          ...(owner ? { runCount: { increment: 1 } } : {}),
          lastSeenAt: now,
          lastSeenRunId: runId,
        },
      }),
      prisma.runFailureCluster.update({
        where: { id: claim.id },
        data: { members: { increment: 1 } },
      }),
    ]);
  }

  return {
    signatureId: signature.id,
    claimId: claim.id,
    clusterKey: cause.clusterKey,
    signature: cause.signature,
    label: cause.label,
    owner,
    firstSeenInProject,
    firstSeenAt: signature.firstSeenAt,
    lastSeenAt: signature.lastSeenAt,
    runsSeen: runCountBefore + (owner ? 1 : 0),
    mutedUntil: signature.mutedUntil,
    mutedReason: signature.mutedReason,
    verdictId: claim.verdictId,
    suppressed: claim.suppressed,
  };
}

/**
 * Polls the claim for the owner's verdict.
 *
 * Returns null on timeout, and the caller then pays for its own call. A waiter
 * that returned "no verdict, give up" would leave a real failure with no
 * verdict at all, which is a worse product than a second model call.
 */
async function waitForOwnerVerdict(claimId: string): Promise<string | null> {
  const deadline = Date.now() + CLUSTER_VERDICT_WAIT.totalMs;
  for (;;) {
    const claim = await prisma.runFailureCluster.findUnique({
      where: { id: claimId },
      select: { verdictId: true },
    });
    if (claim?.verdictId) return claim.verdictId;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, CLUSTER_VERDICT_WAIT.pollMs));
  }
}

/**
 * The project's own corrections, bounded and recent.
 *
 * `where` is the test's FILE and not a route, because a route is not recorded
 * on a verdict and inventing one would be the exact dishonesty this repo's
 * house style forbids. "Overruled FLAKE to REAL_BUG 6 times (checkout.spec.ts)"
 * is checkable; "on /checkout" would not be.
 */
async function correctionPrior(
  orgId: string,
  projectId: string,
  now: Date,
): Promise<ReturnType<typeof summariseCorrections>> {
  const rows = await prisma.triageVerdict.findMany({
    where: {
      orgId,
      reviewState: { in: ['ACCEPTED', 'OVERRIDDEN'] },
      reviewedAt: { gte: new Date(now.getTime() - CORRECTION_HISTORY_DAYS * DAY_MS) },
      testResult: { run: { projectId } },
    },
    orderBy: { reviewedAt: 'desc' },
    take: CORRECTION_HISTORY_SAMPLE,
    select: {
      verdict: true,
      overriddenTo: true,
      reviewState: true,
      reviewedAt: true,
      testResult: { select: { test: { select: { filePath: true, name: true } } } },
    },
  });

  const mapped: CorrectionRow[] = rows.map((row) => ({
    verdict: row.verdict,
    overriddenTo: row.overriddenTo,
    reviewState: row.reviewState,
    reviewedAt: row.reviewedAt,
    where: basename(row.testResult.test.filePath) || row.testResult.test.name,
  }));

  return summariseCorrections(mapped);
}

function basename(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? null;
}

/**
 * Clusters the run's failures so the owner can tell the model how big the cause
 * is. "So far" is load-bearing and is reported as such: triage is enqueued as
 * each test finishes, so a cause whose first member is triaged while the run is
 * still executing is genuinely smaller at this instant than it will be. The
 * authoritative count is `RunFailureCluster.members`, which every attach bumps.
 */
async function sizeCause(args: {
  orgId: string;
  runId: string;
  clusterKey: string;
  self: { id: string; testName: string };
  label: string;
  signature: string;
}): Promise<TriageClusterContext> {
  const rows = await prisma.testResult.findMany({
    where: { orgId: args.orgId, runId: args.runId, status: { in: [...FAILING_STATUSES] } },
    take: RUN_CLUSTER_SCAN_CAP,
    select: {
      id: true,
      testId: true,
      status: true,
      errorMessage: true,
      retriedAndPassed: true,
      network: true,
      test: { select: { name: true, filePath: true } },
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
    },
  });

  const members = rows.filter(
    (row) =>
      (Boolean(row.errorMessage) || row.steps.length > 0) &&
      causeOf(row).clusterKey === args.clusterKey,
  );

  /*
   * The sample goes first and is deduplicated in: it is a member of its own
   * cause by definition, so the list must never be able to omit it — and the
   * model reads the first names, so the test whose evidence it is about to see
   * should be among them.
   */
  const names = [...new Set([args.self.testName, ...members.map((m) => m.test.name)])];

  return {
    clusterKey: args.clusterKey,
    label: args.label,
    signature: args.signature,
    memberCount: Math.max(members.length, 1),
    memberNames: names,
    retriedAndPassed: members.filter((m) => m.retriedAndPassed).length,
  };
}

export async function processTriage(job: TriageJob): Promise<void> {
  const { orgId, runId, testResultId } = job;
  const now = new Date();

  const result = await prisma.testResult.findFirst({
    where: { id: testResultId, orgId },
    include: {
      test: true,
      steps: { orderBy: { index: 'asc' } },
      findings: true,
      verdict: {
        select: {
          id: true,
          revision: true,
          verdict: true,
          confidence: true,
          explanation: true,
          evidence: true,
          model: true,
          reviewState: true,
          overriddenTo: true,
          reviewedBy: true,
          reviewedAt: true,
          retriageRequestedAt: true,
          retriageRequestedBy: true,
          retriageReason: true,
          splitFromClusterKey: true,
          /*
           * The cause this verdict was published FOR, read so the idempotence
           * skip below can finish a publish that never landed. Nullable in the
           * schema (it predates the column), and a null is left alone rather
           * than recomputed: `causeOf` would answer with TODAY's normalisation
           * rules, and guessing which cause an old verdict belonged to is the
           * kind of invented measurement this file exists to prevent.
           */
          clusterKey: true,
        },
      },
    },
  });
  if (!result) throw new Error(`Test result ${testResultId} not found`);

  const existing = result.verdict;
  const retriage = existing?.retriageRequestedAt ? existing : null;

  /*
   * Idempotence, unchanged: the run job may be retried, and a second verdict
   * row for the same result would double-count in the gate. What is new is the
   * one exception — a human asked for a fresh look, and that request is a
   * column precisely so it survives the worker being cycled.
   */
  if (existing && !retriage) {
    /*
     * ── THE THIRD WAY TO DE-ELECT A CAUSE'S OWNER ──────────────────────────
     *
     * The verdict write and the election are two statements, and this early
     * return is what makes the gap between them permanent. Owner mints V0;
     * `triageVerdict.create` lands; the `runFailureCluster` write that
     * publishes V0 as the cause's answer does not (a reset connection, a
     * SIGTERM mid-rollout). BullMQ redelivers the job, `existing` is V0, and
     * this `return` fires — so `verdictId` stays NULL for a cause that has a
     * paid-for answer sitting on its owner's result. Every remaining member
     * then polls out the full bounded wait and the next one to give up pays
     * for a second call.
     *
     * Two numbers lie while that state stands, which is why this is repaired
     * here and not left to the next build: the cause reports `verdictId: null`
     * and `resolvedAt: null` — "no member published an answer for this run" —
     * when one did, and `modelCalls` reads 2 for a cause that needed 1.
     *
     * So the redelivery FINISHES the publish instead of only declining to
     * repeat it. Same conditional shape as the election itself: `verdictId:
     * null` in the WHERE, so a member that already won the election keeps it
     * and this is a no-op on every ordinary redelivery.
     *
     * `revision === 1` is the one guard that is not about races. A re-triage
     * clears `retriageRequestedAt`, so its product reaches this skip on the
     * next redelivery looking exactly like a first answer — and a re-triage is
     * deliberately never published cause-wide (see the election), because it
     * is one reviewer's answer about one member. Revision is what tells the
     * two apart after the request column has been cleared.
     */
    if (existing.revision === 1 && existing.clusterKey) {
      const finished = await prisma.runFailureCluster.updateMany({
        where: { runId, clusterKey: existing.clusterKey, verdictId: null },
        data: { verdictId: existing.id, resolvedAt: now },
      });
      if (finished.count > 0) {
        logger.info(
          { testResultId, clusterKey: existing.clusterKey, verdictId: existing.id },
          'published a verdict whose election never landed; the cause has its answer',
        );
      }
    }
    logger.debug({ testResultId }, 'already triaged; skipping');
    return;
  }

  const cause = causeOf({
    id: result.id,
    testId: result.testId,
    status: result.status,
    errorMessage: result.errorMessage,
    retriedAndPassed: result.retriedAndPassed,
    network: result.network,
    test: { name: result.test.name, filePath: result.test.filePath },
    steps: result.steps,
  });

  const claimed = await claimCause({
    orgId,
    projectId: result.test.projectId,
    runId,
    resultId: result.id,
    cause,
    now,
    countOccurrence: !retriage,
  });

  /*
   * MUTE. Checked after the occurrence is recorded and before anything is
   * minted: a suppressed cause must stay countable, and the whole point of the
   * mute is that no verdict row appears for anything downstream to page on.
   *
   * A re-triage OVERRIDES the mute. Asking for a fresh verdict on a result
   * whose cause is muted is an explicit, audited human act, and refusing it
   * would make the mute a trap — the one state from which a reviewer cannot ask
   * a question.
   */
  if (!retriage && muteInForce(claimed, now)) {
    await prisma.$transaction([
      prisma.failureSignature.update({
        where: { id: claimed.signatureId },
        data: { suppressedCount: { increment: 1 } },
      }),
      prisma.runFailureCluster.update({
        where: { id: claimed.claimId },
        data: { suppressed: true },
      }),
    ]);

    logger.info(
      {
        testResultId,
        clusterKey: claimed.clusterKey,
        mutedUntil: claimed.mutedUntil?.toISOString(),
      },
      'cause is muted; no verdict minted',
    );

    publishEvent(orgId, {
      runId,
      type: 'verdict.suppressed',
      data: {
        testResultId: result.id,
        testName: result.test.name,
        clusterKey: claimed.clusterKey,
        label: claimed.label,
        mutedUntil: claimed.mutedUntil?.toISOString() ?? null,
        mutedReason: claimed.mutedReason,
      },
      at: now.toISOString(),
    });
    return;
  }

  /*
   * ATTACH. One verdict per cause per run: if the owner has already published,
   * this member takes a marked copy and spends nothing.
   *
   * A re-triage never attaches — the point of asking for a fresh look is a
   * fresh look, and handing back a copy of the answer the reviewer just
   * rejected would be the "re-run triage" button doing nothing all over again.
   */
  if (!retriage && !claimed.owner) {
    /*
     * THE WAIT IS SKIPPED FOR A SUPPRESSED CAUSE. The mute path claims the
     * cause and mints nothing by design, so if the mute expires part-way
     * through a run the remaining members are waiting on an owner that is
     * never going to answer. Before this check each of them burned the full
     * bounded wait — 20s of a worker slot each, for a cause whose first member
     * decided not to produce a verdict at all.
     *
     * The flag is per RUN, so this cannot leak into the next build; and it is
     * only ever read by a member for whom the mute is NOT in force (a muted
     * member returned above), which is exactly "the mute lapsed while this run
     * was executing".
     *
     * The one case it costs something: muted and then UN-muted by hand while an
     * owner that passed the mute check is still mid-call. Then this member
     * declines to wait and buys a second call for the cause — recorded as 2 in
     * `modelCalls`, like every other second call, and the re-election below
     * means the members after it attach to whichever answer landed first.
     */
    const ownerVerdictId =
      claimed.verdictId ?? (claimed.suppressed ? null : await waitForOwnerVerdict(claimed.claimId));
    if (ownerVerdictId) {
      const attached = await attachClusterVerdict({
        orgId,
        runId,
        ownerVerdictId,
        claimed,
        result: { id: result.id, testName: result.test.name },
      });
      /*
       * The ANSWER is shared because it is one cause; the DIFF is not, because
       * it patches this test's own file. Skipping the heal on 199 of 200 stale
       * tests would leave the suite broken while reporting the cause handled,
       * so a derived INTENDED_CHANGE goes to the Healer exactly like a
       * first-hand one. This is the one place the collapse deliberately does
       * NOT apply, and it is why the model-call saving is on triage and not on
       * healing.
       */
      if (attached.verdict.verdict === 'INTENDED_CHANGE') {
        await proposeHealFor(
          orgId,
          result.test,
          attached.verdictId,
          attached.verdict,
          stepResultsOf(result),
        );
      }
      return;
    }
    logger.warn(
      {
        testResultId,
        clusterKey: claimed.clusterKey,
        waitedMs: claimed.suppressed ? 0 : CLUSTER_VERDICT_WAIT.totalMs,
        reason: claimed.suppressed ? 'the cause was suppressed by a mute' : 'the wait expired',
      },
      'no verdict to attach to; triaging this member on its own, and it becomes the cause’s answer',
    );
  }

  const steps = stepResultsOf(result);

  const execution: TestExecution = {
    testId: result.testId,
    status: result.status,
    durationMs: result.durationMs,
    steps,
    network: (result.network as never) ?? [],
    console: (result.consoleLog as never) ?? [],
    videoKey: result.videoKey,
    traceKey: result.traceKey,
    errorMessage: result.errorMessage,
    retriedAndPassed: result.retriedAndPassed,
    findings: result.findings.map((f) => ({
      kind: f.kind,
      severity: f.severity,
      code: f.code,
      message: f.message,
      location: f.location,
      helpUrl: f.helpUrl,
    })),
  };

  const history = await historyFor(orgId, result);

  /*
   * A SPLIT is a deliberately narrow verdict: the reviewer said "the cluster's
   * answer is wrong for THIS test", so the cluster size is exactly the context
   * that misled the last call and it is withheld. The cause identity is not —
   * "this has been failing for three weeks" is still true of this member.
   */
  const splitting = Boolean(retriage?.splitFromClusterKey);

  const cluster = splitting
    ? undefined
    : await sizeCause({
        orgId,
        runId,
        clusterKey: claimed.clusterKey,
        self: { id: result.id, testName: result.test.name },
        label: claimed.label,
        signature: claimed.signature,
      });

  const verdict = await triageFailure(
    llm,
    { orgId, projectId: result.test.projectId, agent: 'TRIAGE', subjectId: result.id },
    {
      testName: result.test.name,
      testCode: result.test.code,
      execution,
      history,
      ...(cluster ? { cluster } : {}),
      cause: {
        firstSeenAt: claimed.firstSeenAt.toISOString(),
        lastSeenAt: claimed.lastSeenAt.toISOString(),
        runsSeen: claimed.runsSeen,
        newInThisBuild: claimed.firstSeenInProject,
      },
      corrections: await correctionPrior(orgId, result.test.projectId, now),
    },
  );

  const stored = retriage
    ? await supersedeVerdict({ orgId, verdict, previous: retriage, runId, claimed })
    : await prisma.triageVerdict.create({
        data: {
          orgId,
          testResultId: result.id,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          explanation: verdict.explanation,
          evidence: verdict.evidence as unknown as object,
          suspectCommit: (verdict.suspectCommit as unknown as object) ?? undefined,
          model: verdict.model,
          runId,
          clusterKey: claimed.clusterKey,
        },
      });

  /*
   * The claim learns the verdict LAST, and that ordering is the thing waiters
   * depend on: a claim that advertised a verdict id before the row existed
   * would hand a waiter an id it cannot read. `modelCalls` is incremented
   * rather than set, so a waiter that timed out and paid for its own call shows
   * up as 2 instead of being rounded back down to the number we wanted.
   */
  await prisma.runFailureCluster.update({
    where: { id: claimed.claimId },
    data: { modelCalls: { increment: 1 } },
  });

  /*
   * ── RE-ELECTION, and why the condition is in the WHERE ─────────────────────
   *
   * This used to be `...(claimed.owner && !retriage ? { verdictId } : {})`,
   * which published the cause's answer only from the job that won the INSERT,
   * and only on that job's first successful pass. `owner` is computed from
   * whether THIS call created the claim row, so it is false on every later
   * pass — and a cause whose elected owner never published was never given
   * another one. Three reachable paths de-elected it permanently:
   *
   *  · THE OWNER'S MODEL CALL THREW. The claim row already exists, so BullMQ's
   *    redelivery of that same job arrives as a waiter, polls for 20s, times
   *    out, pays for its own call — and left `verdictId` NULL, so the next 199
   *    members did the same. One transient 529 turned one model call into 200,
   *    plus 200 × 20s of blocked worker slots. That is the headline claim of
   *    this product reverting to the behaviour it was built to replace.
   *  · A MUTE THAT LAPSED MID-RUN. The mute path claims the cause and mints
   *    nothing, so the first member owned a cause it would never answer.
   *  · THE ELECTION WRITE ITSELF NEVER LANDED. The verdict row exists and this
   *    update did not, and the redelivery used to return at the idempotence
   *    skip without ever publishing it. Repaired at that skip, which finishes
   *    the publish rather than only declining to repeat the call.
   *
   * So the election is CONDITIONAL rather than owner-only: the first verdict
   * for this cause in this run becomes the cause's answer, whoever produced it,
   * and every member after it attaches for free. `verdictId: null` in the WHERE
   * is what makes that safe under `concurrency * 2` — it is the same
   * "the write is the decision" shape as the claim INSERT itself, so two jobs
   * finishing at once cannot overwrite each other's answer and the loser's
   * verdict is still on its own result, reviewable, costed and counted.
   *
   * NOT on a re-triage: a re-triage is a fresh first-hand answer for ONE
   * member (see the attach path), and publishing it as the cause's answer
   * would attach a reviewer's split-off opinion to every other member of the
   * cause they did not ask about.
   *
   * `ownerResultId` is deliberately NOT rewritten. It records who won the
   * claim, which stays true; when it names a different result from the one
   * holding `verdictId`, that divergence IS the record that the first owner
   * never answered. Both are reported by GET /triage/signatures/:clusterKey.
   */
  if (!retriage) {
    const elected = await prisma.runFailureCluster.updateMany({
      where: { id: claimed.claimId, verdictId: null },
      data: { verdictId: stored.id, resolvedAt: now },
    });
    if (elected.count === 0) {
      /*
       * Logged for the claim's winner too, and that is the interesting case: it
       * means a waiter's own call landed first and the elected owner was beaten
       * by the member it was supposed to answer for.
       */
      logger.info(
        { testResultId, clusterKey: claimed.clusterKey, claimedOwner: claimed.owner },
        'another member published this cause’s answer first; this verdict stands on its own result',
      );
    }
  }

  logger.info(
    {
      testResultId,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      clusterKey: claimed.clusterKey,
      clusterMembers: cluster?.memberCount ?? 1,
      retriage: Boolean(retriage),
      split: splitting,
    },
    'verdict recorded',
  );

  publishEvent(orgId, {
    runId,
    type: 'verdict',
    data: {
      testResultId: result.id,
      testName: result.test.name,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      explanation: verdict.explanation,
      clusterKey: claimed.clusterKey,
      derived: false,
      newInThisBuild: claimed.firstSeenInProject,
    },
    at: now.toISOString(),
  });

  if (verdict.verdict === 'INTENDED_CHANGE') {
    await proposeHealFor(orgId, result.test, stored.id, verdict, steps);
  }
}

/**
 * The runner's StepResult shape, from the stored rows. Shared by the first-hand
 * path and the attach path, which both hand steps to the Healer.
 */
function stepResultsOf(result: {
  createdAt: Date;
  steps: ReadonlyArray<{
    index: number;
    title: string;
    status: 'PASSED' | 'FAILED' | 'SKIPPED';
    startedAt: Date | null;
    durationMs: number;
    screenshotKey: string | null;
    errorMessage: string | null;
    errorStack: string | null;
    selector: string | null;
    expected: string | null;
    actual: string | null;
  }>;
}): StepResult[] {
  return result.steps.map((s) => ({
    index: s.index,
    title: s.title,
    status: s.status,
    startedAt: (s.startedAt ?? result.createdAt).toISOString(),
    durationMs: s.durationMs,
    screenshotKey: s.screenshotKey,
    error: s.errorMessage
      ? {
          message: s.errorMessage,
          stack: s.errorStack,
          selector: s.selector,
          expected: s.expected,
          actual: s.actual,
        }
      : null,
  }));
}

/** The per-test history the prompt's flake radar reads (§5). */
async function historyFor(
  orgId: string,
  result: { id: string; testId: string; steps: ReadonlyArray<{ index: number; status: string }> },
): Promise<{
  totalRuns: number;
  failures: number;
  flakeRatePercent: number;
  lastPassedAt: string | null;
  sameStepRepeatedly: boolean;
}> {
  const history = await prisma.testResult.findMany({
    where: { testId: result.testId, orgId, id: { not: result.id } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { status: true, createdAt: true, steps: { select: { index: true, status: true } } },
  });

  const failures = history.filter((h) => h.status === 'FAILED' || h.status === 'TIMED_OUT').length;
  const flakyCount = history.filter((h) => h.status === 'FLAKY').length;
  const lastPassed = history.find((h) => h.status === 'PASSED')?.createdAt ?? null;

  const currentFailingIndex = result.steps.find((s) => s.status === 'FAILED')?.index ?? null;
  const sameStepRepeatedly =
    currentFailingIndex !== null &&
    history
      .slice(0, 5)
      .some((h) => h.steps.some((s) => s.status === 'FAILED' && s.index === currentFailingIndex));

  return {
    totalRuns: history.length,
    failures,
    flakeRatePercent: history.length === 0 ? 0 : ((failures + flakyCount) / history.length) * 100,
    lastPassedAt: lastPassed?.toISOString() ?? null,
    sameStepRepeatedly,
  };
}

/**
 * Writes the cause's verdict onto a member that paid for nothing.
 *
 * `derivedFromId` and the `cluster:` model prefix are what keep this honest —
 * see `deriveClusterVerdict`. Returns what it wrote so the caller can hand a
 * derived INTENDED_CHANGE to the Healer; see the comment at that call site for
 * why healing does not collapse the way triage does.
 */
async function attachClusterVerdict(args: {
  orgId: string;
  runId: string;
  ownerVerdictId: string;
  claimed: ClaimedCause;
  result: { id: string; testName: string };
}): Promise<{ verdictId: string; verdict: Awaited<ReturnType<typeof triageFailure>> }> {
  const { orgId, runId, ownerVerdictId, claimed, result } = args;

  const owner = await prisma.triageVerdict.findUnique({
    where: { id: ownerVerdictId },
    select: {
      verdict: true,
      confidence: true,
      explanation: true,
      evidence: true,
      suspectCommit: true,
      model: true,
      // Read rather than assumed: `deriveClusterVerdict` takes the owner's row
      // as it stands, and a hard-coded 1 here would describe a verdict a
      // reviewer has already re-triaged as though it were the first answer.
      revision: true,
      testResult: { select: { test: { select: { name: true } } } },
    },
  });
  if (!owner) {
    // The owner's row went away between the claim read and here. Nothing
    // sensible to copy, and inventing a verdict is the one thing this product
    // must not do, so the job fails and BullMQ retries it.
    throw new Error(`Cluster owner verdict ${ownerVerdictId} not found`);
  }

  const derived = deriveClusterVerdict(
    {
      verdict: owner.verdict,
      confidence: owner.confidence,
      explanation: owner.explanation,
      evidence: owner.evidence as never,
      suspectCommit: owner.suspectCommit as never,
      model: owner.model,
      /*
       * The cause columns of the row being COPIED FROM, in the state they are
       * genuinely in. `derivedFromId: ownerVerdictId` is the honest value: the
       * sentence this argument finishes is "a model read this result itself",
       * and the answer here is no — this is the copy path and this id is where
       * the answer came from. `revision` is the owner row's; the copy's own row
       * takes the column default of 1, because this is its first answer and
       * nothing of it has been superseded.
       */
      clusterKey: claimed.clusterKey,
      derivedFromId: ownerVerdictId,
      revision: owner.revision,
      splitFromClusterKey: null,
    },
    {
      clusterKey: claimed.clusterKey,
      label: claimed.label,
      ownerTestName: owner.testResult.test.name,
    },
  );

  const created = await prisma.triageVerdict.create({
    select: { id: true },
    data: {
      orgId,
      testResultId: result.id,
      verdict: derived.verdict,
      confidence: derived.confidence,
      explanation: derived.explanation,
      evidence: derived.evidence as unknown as object,
      suspectCommit: (derived.suspectCommit as unknown as object) ?? undefined,
      model: derived.model,
      runId,
      clusterKey: claimed.clusterKey,
      derivedFromId: ownerVerdictId,
    },
  });

  await prisma.runFailureCluster.update({
    where: { id: claimed.claimId },
    data: { attachments: { increment: 1 } },
  });

  logger.info(
    {
      testResultId: result.id,
      clusterKey: claimed.clusterKey,
      derivedFrom: ownerVerdictId,
      verdict: derived.verdict,
    },
    'verdict attached from cause; no model call',
  );

  publishEvent(orgId, {
    runId,
    type: 'verdict',
    data: {
      testResultId: result.id,
      testName: result.testName,
      verdict: derived.verdict,
      confidence: derived.confidence,
      explanation: derived.explanation,
      clusterKey: claimed.clusterKey,
      derived: true,
      newInThisBuild: claimed.firstSeenInProject,
    },
    at: new Date().toISOString(),
  });

  return { verdictId: created.id, verdict: derived };
}

/**
 * Replaces a verdict's contents, after copying what they were into
 * `TriageVerdictRevision`.
 *
 * The copy is the feature. `reviewState` and `overriddenTo` are the only record
 * that a human ever disagreed with the model, they are what the prompt now
 * reads back as a prior, and `TriageVerdict.testResultId` is unique so a fresh
 * verdict has nowhere to go but on top of them. A re-triage that wrote in place
 * would delete the correction history in order to produce a fresh guess.
 *
 * The revision row is written first and the overwrite second: a crash between
 * them leaves a duplicate of the live contents in the history, which a reader
 * can see through, instead of a correction that existed in no row at all.
 */
async function supersedeVerdict(args: {
  orgId: string;
  runId: string;
  claimed: ClaimedCause;
  verdict: Awaited<ReturnType<typeof triageFailure>>;
  previous: {
    id: string;
    revision: number;
    verdict: 'REAL_BUG' | 'INTENDED_CHANGE' | 'FLAKE' | 'ENV_ISSUE';
    confidence: number;
    explanation: string;
    evidence: unknown;
    model: string;
    reviewState: 'PENDING' | 'ACCEPTED' | 'OVERRIDDEN' | 'MUTED';
    overriddenTo: 'REAL_BUG' | 'INTENDED_CHANGE' | 'FLAKE' | 'ENV_ISSUE' | null;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    retriageRequestedBy: string | null;
    retriageReason: string | null;
    splitFromClusterKey: string | null;
  };
}): Promise<{ id: string }> {
  const { orgId, runId, claimed, verdict, previous } = args;

  try {
    await prisma.triageVerdictRevision.create({
      data: {
        orgId,
        verdictId: previous.id,
        revision: previous.revision,
        verdict: previous.verdict,
        confidence: previous.confidence,
        explanation: previous.explanation,
        evidence: previous.evidence as unknown as object,
        model: previous.model,
        reviewState: previous.reviewState,
        overriddenTo: previous.overriddenTo,
        reviewedBy: previous.reviewedBy,
        reviewedAt: previous.reviewedAt,
        supersededBy: previous.retriageRequestedBy,
        reason: previous.retriageReason,
      },
    });
  } catch (err) {
    /*
     * `(verdictId, revision)` is unique, so a redelivered re-triage job finds
     * its own revision row already written. That is success, not a conflict:
     * the history is append-only and the contents being archived are identical.
     */
    if (!isUniqueViolation(err)) throw err;
    logger.debug(
      { verdictId: previous.id, revision: previous.revision },
      'revision already archived; redelivered re-triage',
    );
  }

  return prisma.triageVerdict.update({
    where: { id: previous.id },
    data: {
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      explanation: verdict.explanation,
      evidence: verdict.evidence as unknown as object,
      suspectCommit: (verdict.suspectCommit as unknown as object) ?? null,
      model: verdict.model,
      revision: previous.revision + 1,
      runId,
      clusterKey: claimed.clusterKey,
      /*
       * A fresh first-hand call is not derived from anything, so the pointer is
       * cleared — a re-triage of a copy produces an original.
       */
      derivedFromId: null,
      /*
       * The review resets to PENDING. The old decision is in the revision row;
       * leaving ACCEPTED on top of a verdict the reviewer has never seen would
       * claim an approval nobody gave, and that approval is what gates.
       */
      reviewState: 'PENDING',
      reviewedBy: null,
      reviewedAt: null,
      overriddenTo: null,
      retriageRequestedAt: null,
      retriageRequestedBy: null,
      retriageReason: null,
    },
    select: { id: true },
  });
}

async function proposeHealFor(
  orgId: string,
  /*
   * `type` and `spec` widen this structural parameter for the post-check gates.
   * A spec-driven test keeps its assertions in the spec and its `code` is an
   * inert pointer comment, so a gate handed the code alone would report a
   * perfectly good API test as asserting nothing — and, this being the
   * unattended path, would then decline to auto-apply every heal on one.
   */
  test: {
    id: string;
    projectId: string;
    name: string;
    filePath: string;
    code: string;
    type: TestType;
    spec: unknown;
  },
  verdictId: string,
  verdict: Awaited<ReturnType<typeof triageFailure>>,
  steps: StepResult[],
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: test.projectId },
    select: { autoApproveSelectorHeals: true },
  });

  /*
   * ── THE PER-TEST GUARD, ASKED BEFORE THE STRONG-TIER CALL ──────────────────
   *
   * Triage's own idempotence is per TEST RESULT, and a test that fails on every
   * run produces a new result every run — so this path minted a fresh
   * strong-model proposal every run, and fifty rows in the review queue
   * describing one broken test. `shouldProposeHeal` asks the only question that
   * answers it without a clock: does an open proposal's diff still apply to the
   * code in front of us? If it does, that proposal is still the fix, and this
   * is where declining to buy a near-duplicate actually saves the money.
   *
   * Ordered before `proposeHeal` deliberately. Asking afterwards would spend
   * the call and then throw the answer away, which is the shape of saving that
   * shows up in a changelog and not on a bill.
   */
  const openHeals = await openHealsFor(orgId, test.id);
  const decision = shouldProposeHeal({
    openHeals,
    currentCode: test.code,
    filePath: test.filePath,
  });
  if (!decision.propose) {
    logger.info(
      { testId: test.id, verdictId, reuseId: decision.reuseId, reason: decision.reason },
      'skipping a heal proposal; an open one still applies',
    );
    return;
  }

  // The current crawl's locators give the Healer something real to target
  // instead of guessing at what the renamed element is called now.
  const flowMapRow = await prisma.flowMap.findFirst({
    where: { orgId, projectId: test.projectId },
    orderBy: { version: 'desc' },
  });
  const flowMap = flowMapRow?.graph as unknown as FlowMap | undefined;
  const availableLocators = flowMap?.nodes
    .flatMap((node) =>
      node.affordances.map(
        (a) => `${node.route}: ${a.selector.strategy} "${a.selector.name ?? a.selector.value}"`,
      ),
    )
    .slice(0, 40);

  try {
    const proposal = await proposeHeal(
      llm,
      { orgId, projectId: test.projectId, agent: 'HEALER', subjectId: test.id },
      {
        testName: test.name,
        filePath: test.filePath,
        currentCode: test.code,
        verdict,
        failingStep: steps.find((s) => s.status === 'FAILED') ?? null,
        availableLocators,
      },
    );

    const auto = isAutoApprovable(proposal, project?.autoApproveSelectorHeals ?? false);

    /**
     * Auto-approval has to actually write the code. Recording AUTO_APPLIED while
     * leaving the test untouched would claim work that never happened — and an
     * org that opted in would believe its suite was self-healing when nothing had
     * changed. If the patch refuses to apply, the proposal stays PROPOSED for a
     * human, with the reason attached.
     */
    let state: 'PROPOSED' | 'AUTO_APPLIED' = 'PROPOSED';
    let applyNote: string | null = null;
    /**
     * The `TestVersion` this heal wrote, or null because it wrote none.
     *
     * The revert path in the worker's verification sweep has no other way back:
     * without it, an unattended heal that failed verification could only be
     * undone by guessing which version came before it, and `decideVerification`
     * refuses to revert on a guess. NULL is therefore "nothing was applied",
     * never 0 — version 0 does not exist.
     */
    let appliedVersion: number | null = null;

    if (auto.allowed) {
      /*
       * The path matters more here than anywhere else: this is the one site that
       * writes a model's patch into the customer's test with no human in the
       * loop, and the only thing standing between it and a silently weakened
       * suite is the never-weaken guard. Called without a path that guard runs a
       * JavaScript assertion count, which is 0 before and 0 after in a Go,
       * pytest or JUnit repo — it would have approved the deletion of every
       * assertion in the file.
       */
      const applied = applyHealDiff(test.code, proposal.diff, { filePath: test.filePath });
      if (applied.review) {
        /*
         * Auto-apply is premised on the guard having checked. When the guard
         * says it could not read this file type, that premise is gone, so the
         * proposal goes to a human instead — with the reason, rather than a
         * mysterious refusal.
         */
        applyNote = applied.review;
      } else if (!applied.ok || !applied.code) {
        applyNote = applied.reason ?? 'The diff could not be applied';
      } else {
        /*
         * The same gates a generated test passes through, over the patched file
         * — and held to a HIGHER bar here than anywhere else, because this is
         * the one path that writes a model's code into the customer's
         * repository with nobody reading it.
         *
         * On the two reviewed paths a fixed sleep or a brittle locator is a
         * flag, and a flag is a message to a human. There is no human here, so
         * `autoApplyAllowed` requires every gate that could run to have
         * actually PASSED — no failure, no warning, and no "nobody checked".
         * Auto-apply is premised on the output having been checked; when it was
         * not, the premise is gone and the proposal goes to a person, which is
         * exactly what this path already did for `applied.review` above.
         *
         * `check.allowed` is the stronger refusal — the patched file does not
         * parse — and that one holds on every path, reviewed or not.
         */
        const check = await postCheckCode({
          code: applied.code,
          filePath: test.filePath,
          testType: test.type,
          spec: test.spec,
        });

        if (!check.allowed) {
          applyNote = check.refusal ?? 'The patched file did not pass the post-heal checks';
        } else if (!check.autoApplyAllowed) {
          applyNote = `${check.autoApplyDeclined ?? 'A post-heal check did not pass.'} ${check.checks}`;
        } else {
          const latest = await prisma.testVersion.findFirst({
            where: { testId: test.id },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          const version = (latest?.version ?? 0) + 1;
          await prisma.test.update({
            where: { id: test.id },
            data: {
              code: applied.code,
              versions: {
                create: {
                  orgId,
                  version,
                  code: applied.code,
                  source: 'HEALER',
                  /*
                   * The checks ride into the version history. Nobody saw this
                   * change happen, so the history is the only place the fact
                   * that it WAS checked — and what was not checked — survives.
                   * An unattended write with no record of its gates is the
                   * defect this work exists to close.
                   */
                  message: `Auto-applied selector heal: ${proposal.explanation.slice(0, 200)} — ${check.checks}`,
                },
              },
            },
          });
          state = 'AUTO_APPLIED';
          appliedVersion = version;
        }
      }
    }

    /*
     * The id is minted here rather than by the database so the new row and the
     * supersede that points at it can be written in ONE transaction — the same
     * shape, for the same reason, as `deflakeSweep` in processors/flake.ts. A
     * proposal whose stale siblings were not closed is a review queue with two
     * rows for one test, which is half of what the guard above exists to stop.
     *
     * `decision.staleIds` and nothing wider: those are the open proposals whose
     * diffs no longer apply to this file. An open proposal that still applies
     * is not stale, and closing it would throw away work nobody has reviewed.
     */
    const healId = randomUUID();
    const decidedAt = new Date();

    await prisma.$transaction([
      prisma.healProposal.create({
        data: {
          id: healId,
          orgId,
          testId: test.id,
          verdictId,
          diff: proposal.diff,
          explanation: applyNote
            ? `${proposal.explanation}\n\nAuto-apply was declined: ${applyNote}`
            : proposal.explanation,
          riskLevel: proposal.riskLevel,
          confidence: proposal.confidence,
          state,
          appliedVersion,
        },
      }),
      prisma.healProposal.updateMany({
        where: { id: { in: decision.staleIds } },
        data: { state: 'SUPERSEDED', supersededById: healId, decidedAt },
      }),
    ]);

    /*
     * ── THE UNATTENDED APPLY IS NOW CHECKED ────────────────────────────────
     *
     * `AUTO_APPLIED` was a claim nobody verified on the one path with no human
     * in it. The reviewed path (apps/api/src/routes/agent.ts) started a
     * verification run and the sweep reverted a heal that did not work; this
     * path wrote a model's patch into the customer's test, recorded success and
     * never ran the test again — so an unattended heal that fixed NOTHING
     * stayed in the repository with nobody informed. `verifyAppliedHeals` only
     * ever chases rows that are PENDING, so until this ran it never saw one.
     *
     * AFTER the code is written, and outside the transaction: a run queued
     * before the patch landed could execute the old code and report a failure
     * about a heal that had not been applied, and a crash between the two
     * leaves `verifyState` NULL — "nobody checked", which is what would in fact
     * have happened — rather than a row waiting forever on a run that does not
     * exist.
     */
    if (state === 'AUTO_APPLIED') {
      const verification = await startHealVerification({
        orgId,
        healId,
        testId: test.id,
        projectId: test.projectId,
      });
      await prisma.healProposal.update({
        where: { id: healId },
        data: {
          verifyState: verification.state,
          verifyRunId: verification.runId,
          verifyNote: verification.note,
          // Only an outcome stamps this. PENDING is not an outcome.
          verifiedAt: verification.state === 'UNVERIFIABLE' ? new Date() : null,
        },
      });
      logger.info(
        {
          testId: test.id,
          healId,
          appliedVersion,
          verifyState: verification.state,
          verifyRunId: verification.runId,
        },
        'auto-applied heal is being verified',
      );
    }

    logger.info(
      {
        testId: test.id,
        healId,
        risk: proposal.riskLevel,
        autoApplied: state === 'AUTO_APPLIED',
        superseded: decision.staleIds.length,
        reason: applyNote ?? auto.reason,
      },
      'heal proposed',
    );
  } catch (err) {
    // A failed heal must not fail triage — the verdict is the valuable part.
    logger.error({ err, testId: test.id }, 'heal proposal failed');
  }
}

/** Open proposals for one test, in the shape the lifecycle rules want. */
async function openHealsFor(orgId: string, testId: string): Promise<OpenHeal[]> {
  return await prisma.healProposal.findMany({
    where: { orgId, testId, state: { in: ['PROPOSED', 'APPROVED'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, state: true, riskLevel: true, diff: true, createdAt: true },
  });
}

/**
 * Start the run that checks an unattended heal, and say honestly when none
 * could be started.
 *
 * A near-copy of `startHealVerification` in apps/api/src/routes/agent.ts, which
 * is a module-local function in a route file this workspace must not import —
 * see `needsFromOtherFiles` for the promotion that would collapse the two. The
 * RULES it depends on are already shared (`verificationRunTag`,
 * `decideVerification` in packages/agent/src/healer.ts), so the two copies
 * cannot come to different conclusions about what a verification MEANS; what is
 * duplicated is the plumbing.
 *
 * Every arm that cannot run the test returns UNVERIFIABLE, never PENDING: the
 * sweep chases PENDING rows forever, so a row that nothing is going to check
 * must not claim to be waiting. And never VERIFIED — "we could not look" and
 * "it works" are the two facts this whole path exists to keep apart.
 */
async function startHealVerification(args: {
  orgId: string;
  healId: string;
  testId: string;
  projectId: string;
}): Promise<{ runId: string | null; state: 'PENDING' | 'UNVERIFIABLE'; note: string }> {
  // The environment the test last ran in — the one a re-run must reproduce.
  // Same rule as the flake radar's confirmation runs (`lastEnvironmentFor`).
  const last = await prisma.testResult.findFirst({
    where: { testId: args.testId, orgId: args.orgId },
    orderBy: { createdAt: 'desc' },
    select: { run: { select: { environmentId: true } } },
  });
  const environmentId = last?.run.environmentId;
  if (!environmentId) {
    return {
      runId: null,
      state: 'UNVERIFIABLE',
      note: 'The heal was applied and nobody has checked it: this test has never run, so there is no environment to re-run it in. Run it yourself to find out whether the fix works.',
    };
  }

  /*
   * `advisory`, because this is a background path: throwing on a plan limit
   * would fail the triage job — and with it the verdict, which is the valuable
   * part — over a run we are willing to record as unchecked.
   */
  const started = await startRun({
    db: prisma,
    orgId: args.orgId,
    mode: 'advisory',
    data: {
      orgId: args.orgId,
      projectId: args.projectId,
      environmentId,
      trigger: 'MANUAL',
      triggeredBy: verificationRunTag(args.healId),
      totalCount: 1,
      // One placeholder result: the run processor executes exactly the tests its
      // result rows name, which is how a single-test run is expressed here.
      results: { create: [{ orgId: args.orgId, testId: args.testId, status: 'SKIPPED' as const }] },
    },
  });

  if (!started.created) {
    return {
      runId: null,
      state: 'UNVERIFIABLE',
      note: `The heal was applied and nobody has checked it: the verifying run could not be started. ${started.quota.reason ?? 'This org is at its monthly run limit.'}`,
    };
  }

  try {
    await enqueueRun({ orgId: args.orgId, runId: started.run.id }, { background: true });
  } catch (err) {
    /*
     * A run row with no job would sit PENDING until the sweep's deadline and
     * then report itself unverifiable for the wrong reason. Mark it dead now and
     * say the true one.
     */
    await prisma.run
      .update({
        where: { id: started.run.id },
        data: {
          status: 'ERRORED',
          finishedAt: new Date(),
          errorMessage: 'The heal verification run could not be queued.',
        },
      })
      .catch(() => {});
    logger.error(
      { err, healId: args.healId, runId: started.run.id },
      'could not queue a heal verification run',
    );
    return {
      runId: null,
      state: 'UNVERIFIABLE',
      note: 'The heal was applied and nobody has checked it: the verifying run could not be queued. Run the test yourself to find out whether the fix works.',
    };
  }

  return {
    runId: started.run.id,
    state: 'PENDING',
    note: `Applied with nobody reviewing it, and now being checked: run ${started.run.id} re-runs this test on its own. Until it lands, nobody has confirmed the fix works — and if it fails, the sweep reverts the patch.`,
  };
}
