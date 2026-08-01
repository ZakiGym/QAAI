-- Team workflow (§8): test ownership, bulk triage with undo, the nightly
-- digest, and the two columns that finally make `failFast` mean something.
--
-- Additive by construction. Every new table is new; the three columns on "Run"
-- are nullable or defaulted, so every existing row reads exactly as it did
-- before and every code path that never asks about fail-fast behaves
-- identically. `failFast` defaults to false, which is the behaviour every run
-- has had for the life of the product.
--
-- NOT RUN by the change that wrote it. Apply with `npm run db:deploy -w
-- @qaai/api` (or `prisma migrate deploy`).

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "failFast" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stopRequestedAt" TIMESTAMP(3),
ADD COLUMN     "stopReason" TEXT;

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnershipRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "pathPattern" TEXT,
    "testId" TEXT,
    "suiteId" TEXT,
    "feature" TEXT,
    "ownerUserId" TEXT,
    "ownerTeamId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnershipRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageBatch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "runId" TEXT,
    "clusterId" TEXT,
    "action" TEXT NOT NULL,
    "overriddenTo" "Verdict",
    "note" TEXT,
    "appliedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,

    CONSTRAINT "TriageBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageBatchItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "verdictId" TEXT NOT NULL,
    "testResultId" TEXT NOT NULL,
    "previousReviewState" "VerdictReviewState" NOT NULL,
    "previousOverriddenTo" "Verdict",
    "previousReviewedBy" TEXT,
    "previousReviewedAt" TIMESTAMP(3),

    CONSTRAINT "TriageBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestSubscription" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cron" TEXT NOT NULL DEFAULT '0 8 * * *',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notifyVia" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "lastCoveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DigestSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Team_orgId_idx" ON "Team"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_orgId_slug_key" ON "Team"("orgId", "slug");

-- CreateIndex
CREATE INDEX "TeamMember_orgId_idx" ON "TeamMember"("orgId");

-- CreateIndex
CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");

-- CreateIndex
CREATE INDEX "OwnershipRule_orgId_idx" ON "OwnershipRule"("orgId");

-- CreateIndex
CREATE INDEX "OwnershipRule_projectId_position_idx" ON "OwnershipRule"("projectId", "position");

-- CreateIndex
CREATE INDEX "OwnershipRule_testId_idx" ON "OwnershipRule"("testId");

-- CreateIndex
CREATE INDEX "OwnershipRule_suiteId_idx" ON "OwnershipRule"("suiteId");

-- CreateIndex
CREATE INDEX "TriageBatch_orgId_createdAt_idx" ON "TriageBatch"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "TriageBatchItem_orgId_idx" ON "TriageBatchItem"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "TriageBatchItem_batchId_verdictId_key" ON "TriageBatchItem"("batchId", "verdictId");

-- CreateIndex
CREATE UNIQUE INDEX "DigestSubscription_projectId_key" ON "DigestSubscription"("projectId");

-- CreateIndex
CREATE INDEX "DigestSubscription_orgId_idx" ON "DigestSubscription"("orgId");

-- CreateIndex
CREATE INDEX "DigestSubscription_enabled_nextRunAt_idx" ON "DigestSubscription"("enabled", "nextRunAt");

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipRule" ADD CONSTRAINT "OwnershipRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipRule" ADD CONSTRAINT "OwnershipRule_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipRule" ADD CONSTRAINT "OwnershipRule_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "Suite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipRule" ADD CONSTRAINT "OwnershipRule_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipRule" ADD CONSTRAINT "OwnershipRule_ownerTeamId_fkey" FOREIGN KEY ("ownerTeamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageBatch" ADD CONSTRAINT "TriageBatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageBatchItem" ADD CONSTRAINT "TriageBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "TriageBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageBatchItem" ADD CONSTRAINT "TriageBatchItem_verdictId_fkey" FOREIGN KEY ("verdictId") REFERENCES "TriageVerdict"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestSubscription" ADD CONSTRAINT "DigestSubscription_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
