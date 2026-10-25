-- Gap → plan item → test provenance, and the budgeted campaign that closes gaps
-- on its own.
--
-- WHY THIS EXISTS
--
-- Two defects from the register, and they are the same defect seen from both
-- ends.
--
--   "Gap → plan item → test provenance and verified closure — the
--    gapId→planItemId map is returned in the HTTP response only and PlanItem
--    has no gap column, so QAAI cannot say 'this gap is closed by this test' or
--    notice that it is not."
--
--   "Budgeted closure campaign with a project coverage target — caps are per
--    request (25 proposals, 12/40 plan items) and the overflow becomes prose
--    telling a human to click again."
--
-- POST /coverage/:projectId/propose already computed the mapping. It mints the
-- PlanItem row ids itself — precisely because Prisma makes no promise about the
-- order a nested `create` array comes back in — and returns
-- `mapping: [{ gapId, planItemId }]`. That array lived for the length of one
-- HTTP response and was then discarded. So the loop the product is sold on had
-- no memory: a gap whose test was written, bound, and passed, and which the next
-- analysis reported again, was indistinguishable from a gap nobody had ever
-- looked at. Four columns and two tables are what turn that from a hope into a
-- checkable claim.
--
-- WHY THE GAP ID IS ON THE TEST AS WELL AS THE PLAN ITEM
--
-- Because closure has to be checkable from the TEST side. The question is "this
-- gap is open again — which test was supposed to have closed it, and does that
-- test still exist, still run, and still assert what it was written to assert?".
-- Walking "Test" → "PlanItem" → gap answers it only while the plan survives, and
-- a "TestPlan" is deletable (it cascades from the project, and old plans are
-- prunable), so the provenance would evaporate exactly when the loop needed it.
-- A denormalised id is one more thing that can disagree with its source; a
-- provenance trail that disappears is worse.
--
-- WHY THREE TEXT COLUMNS WHERE ENUMS WOULD READ BETTER
--
-- "GapClosure"."state", "ClosureCampaign"."state" and
-- "ClosureCampaign"."approvalPolicy" hold closed domains and are TEXT anyway.
-- apps/api/scripts/check-enums.ts enforces schema/TypeScript parity from a
-- HAND-MAINTAINED list, so a new Prisma enum added without an entry in that
-- list is an enum with no drift guard — and the drift it hides is a value the
-- database accepts that TypeScript has never heard of. The domains are enforced
-- at the producer instead (CLOSURE_STATES in packages/agent/src/coverage.ts;
-- CLOSURE_CAMPAIGN_STATES and CLOSURE_APPROVAL_POLICIES in
-- apps/worker/src/processors/close-loop.ts), which is exactly what
-- "MutationSurvivor"."reason" does and for exactly the same reason. Promote them
-- in the same change that adds their parity entries.
--
-- WHY @@unique("projectId", "dayKey") IS THE NIGHTLY BUDGET
--
-- A budget enforced by a counter is a budget that something has to remember to
-- reset, and a retry defeats it. A budget enforced by a unique index cannot be
-- defeated: a campaign that spends its allowance, settles, or gives up CANNOT be
-- replaced until the UTC day rolls over, because the insert collides. The
-- autopilot's ceiling is therefore a property of the schema rather than of the
-- code that is supposed to respect it.
--
-- NULL IS "NOT MEASURED", NEVER 0 — AGAIN
--
-- "ClosureCampaign"."lastPercent", ."previousPercent" and ."lastDeltaPoints"
-- are nullable with no default, for the same reason "CoverageSnapshot"."percent"
-- is: a project with no source analysis and no crawl has an empty denominator
-- and therefore no percentage. Recording that as 0.0 would make "we cannot see
-- your application" indistinguishable from "nothing in your application is
-- covered" — and would then SETTLE the campaign on a delta of zero between two
-- numbers that never existed, which is the loop deciding it has finished
-- because it never started.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- Seven ADD COLUMNs, every one nullable with no default, so on PostgreSQL 11+
-- none of them rewrites its table: the catalogue records the new attributes and
-- existing rows are untouched. "Test" and "PlanItem" are large tables on a
-- long-lived install, so that property is the difference between a migration and
-- an outage. Nothing is back-filled, and that is a decision rather than an
-- omission — back-filling a gap id onto the Explorer's cold plan items would
-- invent a provenance that never existed, and the honest value for every row
-- written before this migration is NULL.
--
-- Two CREATE TABLEs plus their index builds, all on empty relations. Both
-- foreign keys are declared on the CHILD tables, so neither takes a lock on
-- "Project" rows, and both validate against a table that is empty.
--
-- The three "Project" columns are the ON SWITCH and the brakes for the
-- autopilot, and they are nullable rather than defaulted so that this migration
-- cannot switch anything on. A project that has never asked for a closure
-- campaign has "coverageTargetPercent" NULL and no campaign is ever armed for
-- it — which is every project in every existing install the moment this applies.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "closureApprovalPolicy" TEXT,
ADD COLUMN     "closureItemBudget" INTEGER,
ADD COLUMN     "coverageTargetPercent" INTEGER;

-- AlterTable
ALTER TABLE "PlanItem" ADD COLUMN     "gapId" TEXT,
ADD COLUMN     "gapKind" TEXT;

-- AlterTable
ALTER TABLE "Test" ADD COLUMN     "gapId" TEXT;

-- CreateIndex
-- "Which item was minted for this gap?" — asked once per ledger row per
-- close-loop tick while closure is reconciled. Without it that is a scan of
-- every plan item the install has ever produced.
CREATE INDEX "PlanItem_gapId_idx" ON "PlanItem"("gapId");

-- CreateIndex
-- "Which test was written to close this gap?" — the read behind every
-- re-opened-gap finding, and the one that has to be fast enough to run for
-- every row in the ledger on a single tick.
CREATE INDEX "Test_gapId_idx" ON "Test"("gapId");

-- CreateTable
CREATE TABLE "GapClosure" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "gapId" TEXT NOT NULL,
    "gapKind" TEXT NOT NULL,
    "gapTitle" TEXT NOT NULL,
    "campaignId" TEXT,
    "planItemId" TEXT,
    "testId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "why" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "proposedAt" TIMESTAMP(3),
    "testSeenAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GapClosure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClosureCampaign" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RUNNING',
    "targetPercent" INTEGER NOT NULL,
    "topK" INTEGER NOT NULL,
    "nightlyItemBudget" INTEGER NOT NULL,
    "approvalPolicy" TEXT NOT NULL,
    "tick" INTEGER NOT NULL DEFAULT 0,
    "itemsProposed" INTEGER NOT NULL DEFAULT 0,
    "settledTicks" INTEGER NOT NULL DEFAULT 0,
    "lastPercent" DOUBLE PRECISION,
    "previousPercent" DOUBLE PRECISION,
    "lastDeltaPoints" DOUBLE PRECISION,
    "lastSnapshotId" TEXT,
    "recrawlQueuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTickAt" TIMESTAMP(3),
    "nextTickAt" TIMESTAMP(3),
    "stoppedReason" TEXT,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ClosureCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The idempotence key for the ledger upsert: one row per gap per project, so a
-- redelivered tick cannot mint a second history for the same gap.
CREATE UNIQUE INDEX "GapClosure_projectId_gapId_key" ON "GapClosure"("projectId", "gapId");

-- CreateIndex
-- The tenant extension makes "orgId" an equality on every read, so this one
-- index serves the plain org-scoped scan. The same reasoning as every other
-- ("orgId") index in this schema.
CREATE INDEX "GapClosure_orgId_idx" ON "GapClosure"("orgId");

-- CreateIndex
-- "Which gaps in this project are NOT_CLOSED?" — the read that turns the ledger
-- into a finding rather than a log.
CREATE INDEX "GapClosure_projectId_state_idx" ON "GapClosure"("projectId", "state");

-- CreateIndex
-- "What did last night's campaign touch?"
CREATE INDEX "GapClosure_campaignId_idx" ON "GapClosure"("campaignId");

-- CreateIndex
-- The reverse read: when a test is deleted or disabled, the gaps it was holding
-- closed have to re-open, and without this that is a scan of the whole ledger.
CREATE INDEX "GapClosure_testId_idx" ON "GapClosure"("testId");

-- CreateIndex
-- THIS INDEX IS THE NIGHTLY BUDGET. See the header: a budget enforced by a
-- counter can be defeated by a retry; one enforced by a unique index cannot.
CREATE UNIQUE INDEX "ClosureCampaign_projectId_dayKey_key" ON "ClosureCampaign"("projectId", "dayKey");

-- CreateIndex
CREATE INDEX "ClosureCampaign_orgId_idx" ON "ClosureCampaign"("orgId");

-- CreateIndex
-- The 60-second scheduler sweep's own query: "every RUNNING campaign whose tick
-- is due". Both columns in this order, so the sweep is an index range scan and
-- not a scan of every campaign the install has ever armed. Without it the
-- autopilot's cost grows with history rather than with what is running.
CREATE INDEX "ClosureCampaign_state_nextTickAt_idx" ON "ClosureCampaign"("state", "nextTickAt");

-- AddForeignKey
ALTER TABLE "GapClosure" ADD CONSTRAINT "GapClosure_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosureCampaign" ADD CONSTRAINT "ClosureCampaign_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
