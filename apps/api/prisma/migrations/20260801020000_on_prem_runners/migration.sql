-- On-prem runner agents (ENTERPRISE).
--
-- Additive by construction, exactly like the sharding migration. Both new
-- columns are nullable with no default, so every existing Environment and Run
-- reads as "cloud worker" — which is what they are — and no code path that
-- never asks about runners can observe a difference.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- CreateEnum
CREATE TYPE "RunnerJobStatus" AS ENUM ('QUEUED', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "runnerPool" TEXT;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "runnerPool" TEXT;

-- CreateTable
CREATE TABLE "Runner" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "pools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agentVersion" TEXT,
    "platform" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastClaimAt" TIMESTAMP(3),
    "tokenRotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Runner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunnerJob" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "shardIndex" INTEGER,
    "status" "RunnerJobStatus" NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT NOT NULL,
    "requirements" JSONB NOT NULL DEFAULT '{}',
    "pool" TEXT,
    "runnerId" TEXT,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "RunnerJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Runner_tokenHash_key" ON "Runner"("tokenHash");

-- CreateIndex
CREATE INDEX "Runner_orgId_idx" ON "Runner"("orgId");

-- CreateIndex
CREATE INDEX "Runner_tokenPrefix_idx" ON "Runner"("tokenPrefix");

-- CreateIndex
-- The idempotency key. A composite unique on (runId, shardIndex) would not do
-- this job: Postgres treats NULLs as distinct, so the unsharded case — the
-- common one — would accept a duplicate and the suite would execute twice.
CREATE UNIQUE INDEX "RunnerJob_dedupeKey_key" ON "RunnerJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "RunnerJob_orgId_idx" ON "RunnerJob"("orgId");

-- CreateIndex
CREATE INDEX "RunnerJob_runId_idx" ON "RunnerJob"("runId");

-- CreateIndex
CREATE INDEX "RunnerJob_runnerId_idx" ON "RunnerJob"("runnerId");

-- CreateIndex
CREATE INDEX "RunnerJob_orgId_status_queuedAt_idx" ON "RunnerJob"("orgId", "status", "queuedAt");

-- CreateIndex
CREATE INDEX "RunnerJob_status_leaseExpiresAt_idx" ON "RunnerJob"("status", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "Runner" ADD CONSTRAINT "Runner_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunnerJob" ADD CONSTRAINT "RunnerJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL rather than CASCADE: deleting a runner must not delete the record of
-- the work it did. `runnerId` is the first thing anyone asks about when an
-- on-prem result looks wrong, but it is not what makes the row meaningful.
ALTER TABLE "RunnerJob" ADD CONSTRAINT "RunnerJob_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "Runner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
