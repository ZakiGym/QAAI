-- Quarantine: a counted suppression, a budget, an expiry — and flake rate with
-- a direction.
--
-- WHY THIS EXISTS
--
-- Three defects, one shape. All three are a signal switched off with nothing
-- recording that it was off.
--
-- 1. QUARANTINE SUPPRESSED THE SIGNAL WITHOUT STOPPING THE GATE.
--    `evaluateGates` filtered quarantined tests out of the gate rules and that
--    was the only place quarantine was honoured. `Run.failedCount` counted a
--    quarantined test's failure as a plain failure, so the run was written
--    FAILED, the CLI exited 1, the GitHub check went red and the JUnit XML
--    carried a <failure>. The team stopped SEEING the failure and still could
--    not merge — the worst of both. `Run.quarantinedFailedCount` is where those
--    failures go now: counted, named, and out of the gate.
--
--    Deliberately NOT added to `skippedCount`. A deliberate skip and a failure
--    somebody switched off are different facts, and a surface that prints them
--    as one number is how a suite with forty quarantined tests shows a clean
--    green board.
--
-- 2. QUARANTINE WAS UNBOUNDED AND HAD NO END DATE.
--    Nothing refused the 40th quarantine and nobody was paged, so a quarter of
--    a suite could stop gating silently. `Project.quarantineBudgetPercent` is
--    the cap (null = the documented default in packages/runner/src/gates.ts),
--    and `Test.quarantineExpiresAt` is the end date, because a quarantine with
--    no end date is a deletion nobody signed.
--
-- 3. `Test.flakeRate` WAS OVERWRITTEN EVERY RUN, SO ROT HAD NO DIRECTION.
--    "Is this suite getting worse?" was unanswerable. `TestFlakeHistory` keeps
--    one row per test per UTC day — the unique constraint IS the aggregation,
--    so the table grows with tests x days and not with the run rate. What that
--    loses is written out in full on the model in schema.prisma: intra-day
--    shape, all but the worst run id, anything past 90 days, and any day with
--    no runs (absence means "not measured", never "0% flaky").
--
-- WHAT NOTHING HERE DOES
--
-- No column is back-filled, and that is a decision rather than an omission.
--
--   * `Run.quarantinedFailedCount` stays 0 on every existing run. Recomputing
--     it would mean re-reading every historical result against today's
--     quarantine flags, and a test quarantined last week was NOT quarantined
--     during a run from last month — the back-fill would invent suppressions
--     that never happened and silently rewrite the verdict of runs that have
--     already been reported to a pull request.
--
--   * `Test.quarantineExpiresAt` stays NULL on every existing quarantine, and
--     NULL is honoured as "never expires". Stamping an expiry on quarantines a
--     customer never agreed to would turn every suppressed failure older than
--     two weeks red in one deploy — a schema migration deciding to break a
--     build. The gate WARNs about them by name instead, which is the loud,
--     reversible version of the same news.
--
--   * `TestFlakeHistory` starts empty. The first trend appears after the first
--     run, and a project with no rows reports "not measured yet" rather than a
--     flat 0% line nobody computed. CoverageSnapshot arrived the same way and
--     for the same reason.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- FOUR ADD COLUMNs (Project, Test, Run, RunShard), each either nullable or with
-- a constant default, so on PostgreSQL 11+ none of them rewrites its table: the
-- default is recorded in the catalogue and existing rows are not touched. One
-- CREATE TABLE plus three index builds, all on an empty relation.
--
-- ONE index on an existing table: "Test"(projectId, quarantined), which the
-- budget check queries before every quarantine and once per run finalisation.
-- That build takes a lock blocking writes to "Test" for its duration; on an
-- install large enough for that to matter, create it CONCURRENTLY by hand
-- outside the migration and let this statement be the no-op it then is.
--
-- The foreign key is declared on "TestFlakeHistory", the CHILD, so it takes no
-- lock on "Test" rows, and it validates against a table that is empty.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "quarantineBudgetPercent" INTEGER;

-- AlterTable
ALTER TABLE "Test" ADD COLUMN     "quarantineExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "quarantinedFailedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RunShard" ADD COLUMN     "quarantinedFailedCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TestFlakeHistory" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "ratePercent" DOUBLE PRECISION NOT NULL,
    "peakRatePercent" DOUBLE PRECISION NOT NULL,
    "worstAt" TIMESTAMP(3) NOT NULL,
    "worstRunId" TEXT,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "samples" INTEGER NOT NULL DEFAULT 1,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestFlakeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The aggregation, as a constraint. The per-day upsert relies on it, so N
-- measurements a day become one row whether or not a writer remembers to
-- collapse them — and it doubles as the index for "show me this test's trend".
--
-- There is deliberately NO second index on ("testId", "day" DESC). A btree
-- scans backwards, so a single-direction sort needs no matching index
-- direction; the same reasoning is written out on the createdAt indexes in
-- 20260824000000_query_plan_indexes. A second index here would be write
-- amplification on the hottest table this change adds, for nothing.
CREATE UNIQUE INDEX "TestFlakeHistory_testId_day_key" ON "TestFlakeHistory"("testId", "day");

-- CreateIndex
CREATE INDEX "TestFlakeHistory_orgId_idx" ON "TestFlakeHistory"("orgId");

-- CreateIndex
-- "Is this PROJECT getting worse?", and the sweep's own retention delete.
CREATE INDEX "TestFlakeHistory_projectId_day_idx" ON "TestFlakeHistory"("projectId", "day");

-- CreateIndex
-- The budget check's own query: "how many tests in this project are quarantined
-- right now?", asked before every quarantine and once per run finalisation.
-- Without it that is a full scan of the project's tests.
CREATE INDEX "Test_projectId_quarantined_idx" ON "Test"("projectId", "quarantined");

-- AddForeignKey
ALTER TABLE "TestFlakeHistory" ADD CONSTRAINT "TestFlakeHistory_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;
