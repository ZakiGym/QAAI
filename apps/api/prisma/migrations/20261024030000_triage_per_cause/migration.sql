-- Triage once per CAUSE, and the feedback loops that make the verdict worth
-- keeping: a persisted cluster identity, a durable mute, a supersede-able
-- verdict, and an override history the prompt can read back.
--
-- WHY THIS EXISTS
--
-- Six defects, one root. `signatureOf()` in apps/api/src/lib/cluster.ts already
-- computed a stable key for a failure CAUSE, and that key was stored nowhere.
-- Everything downstream of "we know these forty failures are one thing" was
-- therefore impossible to build, and six separate features were missing for the
-- same reason:
--
--   1. TRIAGE RAN ONCE PER RESULT. A dependency that takes out 200 tests spent
--      200 model calls and produced 200 independently-worded verdicts for one
--      cause. The clusterer that already knew better was read-only and ran in
--      the cockpit, after the money was gone.
--   2. NO CLUSTER IDENTITY. "Is this the same cause as yesterday?" and "which
--      of these is new in this build?" had no answer, and the second is the
--      most useful sentence a reviewer can be handed.
--   3. NOTHING READ "overriddenTo". The schema's own comment says the override
--      "is what gates and what trains prompts"; no prompt read it, so every
--      project re-made the same wrong call forever.
--   4. "VerdictReviewState.MUTED" WAS WRITE-ONLY. Two endpoints set it, nothing
--      read it, so the next run of a known issue minted a fresh verdict and
--      paged somebody again.
--   5. NO RE-TRIAGE. packages/agent/src/heal-apply.ts tells the reader to
--      "Re-run triage to get a fresh proposal" and there was no mechanism:
--      enqueueTriage dedupes on `triage-<testResultId>` forever and
--      processTriage returns early whenever a verdict row exists.
--   6. NO ACCURACY NUMBER. How often humans overrule the model was not
--      aggregated anywhere, so nobody could say whether triage was working.
--
-- WHY A CLAIM TABLE AND NOT A CHECK
--
-- "RunFailureCluster" exists because the triage queue runs at
-- `WORKER_CONCURRENCY * 2` (apps/worker/src/index.ts). Two jobs for two members
-- of the same cluster really do look for an existing verdict at the same
-- instant, both find none, and both call the model — so the collapse has to
-- rest on a UNIQUE INSERT, not on a read. `RunFailureCluster_runId_clusterKey_key`
-- IS the lock: the first inserter owns the cause for that run and pays for the
-- one model call, and the loser waits for the owner's verdict rather than
-- buying a second one. Same shape as "SsoAssertionSeen" — the INSERT is the
-- decision — except that this row is read back, because it is also the per-run
-- occurrence record and the model-call ledger.
--
-- WHY "modelCalls" AND "attachments" ARE COLUMNS
--
-- "We collapsed 200 failures into one model call" is a claim about money, and a
-- claim about money should be a number a customer can read back rather than a
-- sentence in a changelog. `modelCalls` is normally 1; it is 2 or more only
-- when a waiter's bounded wait expired and it triaged itself, and that case has
-- to stay VISIBLE instead of being rounded down to the number we hoped for.
--
-- HOW "NEW IN THIS BUILD" IS ANSWERED WITHOUT A SCAN
--
-- Two ways, and they cannot disagree because one write makes both:
--
--   · "FailureSignature"."firstSeenRunId" turns the question into an EQUALITY.
--     A cause is new in run R exactly when firstSeenRunId = R. No window, no
--     "have we seen it in the last N runs" scan over "TestResult", and the
--     answer does not change as history grows.
--     "FailureSignature_orgId_projectId_firstSeenRunId_idx" answers "list
--     everything new in this build" as one index range read.
--   · "RunFailureCluster"."firstSeenInProject" is written from the same
--     signature row the claim path just minted or read, so the run page answers
--     the same question from one index read on (orgId, runId) with no join at
--     all. Not one transaction — a path that catches a unique violation cannot
--     share one on PostgreSQL, where a failed statement aborts the whole
--     transaction. One read, two writers of the same value, so they cannot
--     disagree. It is also the value AS OF this run, which is what an old run's
--     page should still show after the cause has recurred.
--
-- WHY THE MUTE IS KEYED ON THE SIGNATURE AND NOT ON THE TEST
--
-- Quarantine keys suppression on a TEST, so it swallows every future failure of
-- that test including ones nobody has looked at — which is why
-- "Test"."quarantineExpiresAt" had to be added. A mute keyed on the SIGNATURE
-- suppresses only the cause that was actually inspected: change the cause and
-- the signature changes with it, and the new cause is loud again with no human
-- action. `mutedUntil` is never "forever" (the writer clamps to MUTE_MAX_DAYS =
-- 14, packages/agent/src/triage.ts), and `suppressedCount` keeps a muted cause
-- COUNTABLE, because "it went quiet" and "it stopped happening" are different
-- facts and a mute that recorded nothing would make them indistinguishable.
--
-- WHY THE REVISION TABLE
--
-- "TriageVerdict"."testResultId" is UNIQUE, so a fresh verdict has nowhere to
-- go but on top of the old one. Overwriting in place would destroy
-- `reviewState` and `overriddenTo` — the only record that the model was ever
-- overruled, and now the input to the prompt's own correction prior. So a
-- re-triage COPIES the current contents into "TriageVerdictRevision" first and
-- then overwrites. Append-only; `(verdictId, revision)` is unique so a
-- redelivered supersede is idempotent rather than doubling the history.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- Eight ADD COLUMNs on "TriageVerdict". Seven are nullable with no default, so
-- the catalogue records the attribute and no row is touched. The eighth,
-- `revision INTEGER NOT NULL DEFAULT 1`, also avoids a rewrite: PostgreSQL 11+
-- stores a non-volatile column default in the catalogue
-- (`pg_attribute.atthasmissing`) and materialises it on read. "TriageVerdict"
-- has one row per failing result ever recorded, so that property is the
-- difference between a migration and an outage.
--
-- Three CREATE TABLEs plus their indexes, all built on empty relations. Every
-- foreign key is declared on the CHILD, so none of them takes a lock on
-- "Project", "TriageVerdict" or anything else's rows, and each validates
-- against an empty table.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- AlterTable
ALTER TABLE "TriageVerdict" ADD COLUMN     "clusterKey" TEXT,
ADD COLUMN     "derivedFromId" TEXT,
ADD COLUMN     "retriageReason" TEXT,
ADD COLUMN     "retriageRequestedAt" TIMESTAMP(3),
ADD COLUMN     "retriageRequestedBy" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "runId" TEXT,
ADD COLUMN     "splitFromClusterKey" TEXT;

-- CreateTable
CREATE TABLE "TriageVerdictRevision" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "verdictId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "verdict" "Verdict" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "reviewState" "VerdictReviewState" NOT NULL,
    "overriddenTo" "Verdict",
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededBy" TEXT,
    "reason" TEXT,

    CONSTRAINT "TriageVerdictRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FailureSignature" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenRunId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenRunId" TEXT NOT NULL,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "mutedUntil" TIMESTAMP(3),
    "mutedAt" TIMESTAMP(3),
    "mutedBy" TEXT,
    "mutedReason" TEXT,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FailureSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunFailureCluster" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ownerResultId" TEXT NOT NULL,
    "verdictId" TEXT,
    "members" INTEGER NOT NULL DEFAULT 0,
    "modelCalls" INTEGER NOT NULL DEFAULT 0,
    "attachments" INTEGER NOT NULL DEFAULT 0,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenInProject" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "signatureId" TEXT,

    CONSTRAINT "RunFailureCluster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "Has this run already answered this cause?" — the read every one of those
-- 200 jobs makes, and the one that decides whether a model call happens.
-- ("runId", "clusterKey") rather than ("clusterKey", "runId") because the
-- attach path always knows the run and the cause together while the cause page
-- goes through ("orgId", "clusterKey") below.
CREATE INDEX "TriageVerdict_runId_clusterKey_idx" ON "TriageVerdict"("runId", "clusterKey");

-- CreateIndex
-- "Every verdict ever reached about this cause" — the cause page, and the
-- per-cause column of the accuracy scorecard.
CREATE INDEX "TriageVerdict_orgId_clusterKey_idx" ON "TriageVerdict"("orgId", "clusterKey");

-- CreateIndex
CREATE UNIQUE INDEX "TriageVerdictRevision_verdictId_revision_key" ON "TriageVerdictRevision"("verdictId", "revision");

-- CreateIndex
-- The history panel on one verdict.
CREATE INDEX "TriageVerdictRevision_orgId_verdictId_idx" ON "TriageVerdictRevision"("orgId", "verdictId");

-- CreateIndex
-- The scorecard's superseded-corrections arm. A correction a human made still
-- counts after a re-triage replaced it; without this index that arm is a
-- sequential scan of every revision the install has ever written.
CREATE INDEX "TriageVerdictRevision_orgId_reviewState_idx" ON "TriageVerdictRevision"("orgId", "reviewState");

-- CreateIndex
-- The identity itself. UNIQUE because a second row for one cause in one project
-- is two answers to "when was this first seen", and the upsert in the worker
-- depends on this constraint to be the arbiter when two jobs mint it at once.
CREATE UNIQUE INDEX "FailureSignature_orgId_projectId_clusterKey_key" ON "FailureSignature"("orgId", "projectId", "clusterKey");

-- CreateIndex
-- "Everything new in this build" for a caller holding a run id and no cluster
-- keys — an equality on three columns, so it is answered from the index.
CREATE INDEX "FailureSignature_orgId_projectId_firstSeenRunId_idx" ON "FailureSignature"("orgId", "projectId", "firstSeenRunId");

-- CreateIndex
-- The cause list, most recently seen first. "orgId" and "projectId" first
-- because both are equalities on every read, which is what lets the index
-- supply the ORDER BY (scanned backwards) so LIMIT can stop early.
CREATE INDEX "FailureSignature_orgId_projectId_lastSeenAt_idx" ON "FailureSignature"("orgId", "projectId", "lastSeenAt");

-- CreateIndex
-- The mute roster. Indexes the column and not a partial "still muted"
-- predicate, because the one screen that reads this wants EXPIRED mutes too —
-- a mute that ran out last night is the thing somebody has to decide about.
CREATE INDEX "FailureSignature_orgId_mutedUntil_idx" ON "FailureSignature"("orgId", "mutedUntil");

-- CreateIndex
-- THE CLAIM. Everything in this migration's first paragraph rests on this one
-- constraint: the first INSERT for a (run, cause) pair owns the model call.
CREATE UNIQUE INDEX "RunFailureCluster_runId_clusterKey_key" ON "RunFailureCluster"("runId", "clusterKey");

-- CreateIndex
-- The run page: every cause in this run, one index read, no join.
CREATE INDEX "RunFailureCluster_orgId_runId_idx" ON "RunFailureCluster"("orgId", "runId");

-- CreateIndex
-- "Which runs did this cause appear in", newest first. "createdAt" last for the
-- same reason as above: the two equalities in front of it are what let the
-- btree supply the ordering.
CREATE INDEX "RunFailureCluster_orgId_clusterKey_createdAt_idx" ON "RunFailureCluster"("orgId", "clusterKey", "createdAt");

-- AddForeignKey
ALTER TABLE "TriageVerdictRevision" ADD CONSTRAINT "TriageVerdictRevision_verdictId_fkey" FOREIGN KEY ("verdictId") REFERENCES "TriageVerdict"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailureSignature" ADD CONSTRAINT "FailureSignature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Nullable, and deliberately NOT the identity: the durable join between a run
-- and a cause is "clusterKey", which survives a signature row being pruned.
ALTER TABLE "RunFailureCluster" ADD CONSTRAINT "RunFailureCluster_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "FailureSignature"("id") ON DELETE CASCADE ON UPDATE CASCADE;
