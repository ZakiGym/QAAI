-- The coverage denominator: the surface of the application under test, as rows.
--
-- WHY THIS EXISTS
--
-- Coverage was previously derived on every request from the flow map and thrown
-- away. That meant no trend, no gate, nothing to diff a release against, and no
-- way to name a single item in a waiver. A denominator has to be addressable to
-- be defensible, so here it is addressable.
--
-- Purely additive. Three new tables and three new enums. No column is added to
-- and no constraint changed on any existing table — the only touch outside the
-- new relations is Project and User each gaining a child, and those foreign keys
-- are declared on the CHILD, so they take no lock on the parent's rows. On a
-- live database this is three CREATE TABLEs plus index builds on empty
-- relations, which is safe to apply while the API is serving.
--
-- Nothing back-fills. A project with no CoverageItem rows reports "not measured
-- yet" rather than 0%, which is the correct state for every existing install:
-- the feature arrives honest rather than arriving with a number nobody computed.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- CreateEnum
CREATE TYPE "SurfaceKind" AS ENUM ('ROUTE', 'ENDPOINT', 'FORM', 'AUTH_SURFACE', 'ROLE_CELL', 'COMPONENT_STATE', 'FLAG_COMBINATION', 'BACKGROUND_JOB', 'NOTIFICATION', 'ERROR_STATE', 'DEVICE_LOCALE', 'DATA_VARIANT');

-- CreateEnum
CREATE TYPE "SurfaceOrigin" AS ENUM ('SOURCE_ONLY', 'CRAWL_ONLY', 'BOTH');

-- CreateEnum
CREATE TYPE "SurfaceStatus" AS ENUM ('COVERED', 'ASSERTED_NOT_RUN', 'UNCOVERED', 'UNKNOWN', 'WAIVED');

-- CreateTable
CREATE TABLE "CoverageItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "SurfaceKind" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "file" TEXT,
    "line" INTEGER,
    "origin" "SurfaceOrigin" NOT NULL,
    "evidence" TEXT NOT NULL,
    "detector" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "status" "SurfaceStatus" NOT NULL DEFAULT 'UNCOVERED',
    "matches" JSONB NOT NULL DEFAULT '[]',
    "lastRunId" TEXT,
    "lastStatus" "TestResultStatus",
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "mutationKilled" BOOLEAN,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "CoverageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverageWaiver" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "byUserId" TEXT,
    "byEmail" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverageWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverageSnapshot" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "commitSha" TEXT,
    "percent" DOUBLE PRECISION,
    "denominator" INTEGER NOT NULL,
    "covered" INTEGER NOT NULL,
    "assertedNotRun" INTEGER NOT NULL DEFAULT 0,
    "uncovered" INTEGER NOT NULL,
    "unknown" INTEGER NOT NULL DEFAULT 0,
    "waived" INTEGER NOT NULL DEFAULT 0,
    "declaredNeverReached" INTEGER NOT NULL DEFAULT 0,
    "reachedNeverDeclared" INTEGER NOT NULL DEFAULT 0,
    "byKind" JSONB NOT NULL DEFAULT '[]',
    "analysisId" TEXT,
    "flowMapVersion" INTEGER,
    "testCount" INTEGER NOT NULL DEFAULT 0,
    "runId" TEXT,
    "caveats" JSONB NOT NULL DEFAULT '[]',
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoverageItem_projectId_key_key" ON "CoverageItem"("projectId", "key");

-- CreateIndex
CREATE INDEX "CoverageItem_orgId_idx" ON "CoverageItem"("orgId");

-- CreateIndex
CREATE INDEX "CoverageItem_projectId_status_idx" ON "CoverageItem"("projectId", "status");

-- CreateIndex
CREATE INDEX "CoverageItem_projectId_kind_status_idx" ON "CoverageItem"("projectId", "kind", "status");

-- CreateIndex
CREATE INDEX "CoverageItem_projectId_origin_idx" ON "CoverageItem"("projectId", "origin");

-- CreateIndex
CREATE INDEX "CoverageItem_projectId_retiredAt_idx" ON "CoverageItem"("projectId", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageWaiver_itemId_key" ON "CoverageWaiver"("itemId");

-- CreateIndex
CREATE INDEX "CoverageWaiver_orgId_idx" ON "CoverageWaiver"("orgId");

-- CreateIndex
CREATE INDEX "CoverageWaiver_projectId_expiresAt_idx" ON "CoverageWaiver"("projectId", "expiresAt");

-- CreateIndex
CREATE INDEX "CoverageSnapshot_orgId_idx" ON "CoverageSnapshot"("orgId");

-- CreateIndex
CREATE INDEX "CoverageSnapshot_projectId_createdAt_idx" ON "CoverageSnapshot"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "CoverageSnapshot_projectId_commitSha_idx" ON "CoverageSnapshot"("projectId", "commitSha");

-- AddForeignKey
ALTER TABLE "CoverageItem" ADD CONSTRAINT "CoverageItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageWaiver" ADD CONSTRAINT "CoverageWaiver_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CoverageItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageWaiver" ADD CONSTRAINT "CoverageWaiver_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageSnapshot" ADD CONSTRAINT "CoverageSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
