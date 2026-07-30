-- CreateEnum
CREATE TYPE "ImportState" AS ENUM ('DETECTED', 'CONVERTING', 'DONE', 'ERRORED');

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "framework" TEXT NOT NULL,
    "detectionConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "files" JSONB NOT NULL,
    "state" "ImportState" NOT NULL DEFAULT 'DETECTED',
    "summary" TEXT,
    "convertedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_orgId_projectId_idx" ON "ImportBatch"("orgId", "projectId");
