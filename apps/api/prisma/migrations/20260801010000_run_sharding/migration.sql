-- Build sharding (§5): the durable record of a run's split.
--
-- Additive by construction. `Run.shardCount` defaults to 1 and
-- `TestResult.shardIndex` is nullable, so every existing row reads exactly as
-- it did before this migration and every code path that never asks for shards
-- behaves identically.

-- CreateEnum
CREATE TYPE "RunShardStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED');

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "finalizedAt" TIMESTAMP(3),
ADD COLUMN     "shardCount" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "TestResult" ADD COLUMN     "shardIndex" INTEGER;

-- CreateTable
CREATE TABLE "RunShard" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "status" "RunShardStatus" NOT NULL DEFAULT 'QUEUED',
    "testCount" INTEGER NOT NULL DEFAULT 0,
    "estimatedMs" INTEGER NOT NULL DEFAULT 0,
    "passedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "flakyCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "RunShard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunShard_orgId_idx" ON "RunShard"("orgId");

-- CreateIndex
CREATE INDEX "RunShard_runId_status_idx" ON "RunShard"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RunShard_runId_index_key" ON "RunShard"("runId", "index");

-- CreateIndex
CREATE INDEX "TestResult_runId_shardIndex_idx" ON "TestResult"("runId", "shardIndex");

-- AddForeignKey
ALTER TABLE "RunShard" ADD CONSTRAINT "RunShard_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
