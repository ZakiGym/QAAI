-- The mutation score, as data instead of as a sentence — plus the mutants that
-- survived.
--
-- WHY THIS EXISTS
--
-- The mutation score is the answer to "do these tests actually assert
-- anything?", it is the one metric no competitor in this space ships, and until
-- this migration it was stored nowhere. `packages/runner/src/plugins/mutation.ts`
-- interpolated it into a Step TITLE —
--
--     "Mutation score 72.4% — 89 of 123 mutants killed (minimum 60%)"
--
-- — and that string was the only record of it. Nothing outside the plugin could
-- read the number: trending it meant a regex over "Step"."title", gating on it
-- was impossible, and alerting on a drop was not even expressible. Once per run
-- the most commercially valuable number this product computes was rendered into
-- prose and thrown away.
--
-- The surviving mutants went the same way, as FAILED steps with the location
-- inside the title, so "which mutants keep surviving across runs?" — the
-- question that tells a team where its suite is thinnest — had no answer either.
--
-- WHY FIVE SCALAR COLUMNS AND NOT ONE JSON COLUMN
--
-- Because the point is the TREND QUERY. "TestResult" already carries
-- ("testId", "createdAt") as an index, so
--
--     SELECT "createdAt", "mutationScore"
--       FROM "TestResult"
--      WHERE "testId" = $1 AND "mutationScore" IS NOT NULL
--   ORDER BY "createdAt" DESC LIMIT 50
--
-- is answered out of that index with no table access for the sort. A jsonb
-- column would make the same read a sequential scan plus a per-row document
-- parse, and would let a writer store a string where the number goes. The same
-- argument as CoverageSnapshot's columns, and the opposite of
-- "TestResult"."network", which is a blob because nothing queries inside it.
--
-- NULL IS "NOT MEASURED". 0.0 IS "EVERY MUTANT SURVIVED".
--
-- These are opposite facts and the columns keep them apart. A score of zero is
-- the WORST result a suite can produce; a project that has never run mutation
-- testing has no result at all. Defaulting the columns to 0 — or back-filling
-- them — would make the two indistinguishable and invert the signal for every
-- row in the table, so every column here is nullable with NO DEFAULT and
-- nothing is back-filled. Three states are reachable and all three are
-- distinguishable:
--
--   all five NULL          no mutation run reported anything.
--   counts set, score NULL a run happened and produced no VALID mutant, so
--                          there was no denominator. "mutationExcluded" says
--                          how many were thrown out.
--   score 0.0              measured, and the suite killed nothing.
--
-- "valid" is deliberately not a column: it is detected + undetected, and a
-- stored copy is one more thing that can disagree with its own inputs.
--
-- SURVIVOR VOLUME, AND WHY THE TWO HALVES ARE ON DIFFERENT CLOCKS
--
-- A 200-mutant run on a 5,000-test suite is a lot of survivor rows, and both
-- obvious policies are wrong in different directions: "only the newest run's"
-- throws away the one thing a survivor list is good for (noticing that the same
-- mutant has survived for six weeks), and "every survivor forever" grows with
-- the RUN RATE rather than with the suite — hourly CI is millions of rows a year
-- describing code that has since been rewritten.
--
--   * THE NUMBERS live on "TestResult" and are kept as long as the result row,
--     which nothing in this product deletes. The trend is permanent.
--   * THE DETAIL lives in "MutationSurvivor" and is pruned at
--     MUTATION_SURVIVOR_RETENTION_DAYS (90, apps/worker/src/processors/retention.ts),
--     which is both the window "TestFlakeHistory" uses and the longest retention
--     any plan buys for the results it describes. Detail never outlives its
--     evidence, and a mutant at line 42 of a file refactored in March is not a
--     task anybody can act on in June.
--
-- A third bound is applied by the writer rather than by the schema:
-- MAX_PERSISTED_SURVIVORS rows per result. The COUNTS stay exact, so the cap
-- truncates the list and never the arithmetic.
--
-- WHY "reason" IS TEXT AND NOT AN ENUM
--
-- It holds 'survived' | 'no-coverage'. apps/api/scripts/check-enums.ts enforces
-- schema/TypeScript parity from a HAND-MAINTAINED list, so a new enum added
-- without an entry in it is an enum with no drift guard — and the drift it hides
-- is a value the database accepts that TypeScript has never heard of. The domain
-- is enforced at the producer instead (`SurvivingMutant['reason']` in
-- packages/shared/src/types.ts; the worker is the only writer). Promote it in
-- the same change that adds its parity entry.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- FIVE ADD COLUMNs on "TestResult", every one of them nullable with no default,
-- so on PostgreSQL 11+ none of them rewrites the table: the catalogue records
-- the new attributes and existing rows are not touched. "TestResult" is the
-- largest table in this product, so that property is the difference between a
-- migration and an outage — a DEFAULT 0 here would be both a table rewrite AND
-- the signal inversion described above.
--
-- One CREATE TABLE plus three index builds, all on an empty relation. The
-- foreign key is declared on "MutationSurvivor", the CHILD, so it takes no lock
-- on "TestResult" rows and it validates against a table that is empty.
--
-- ON DELETE CASCADE, like "Step" and "Finding": a survivor is a detail OF a
-- result and has no meaning once the result is gone. There is no path that
-- deletes a "TestResult" today, which is exactly why the prune in the worker
-- cannot be left to the cascade.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- AlterTable
ALTER TABLE "TestResult" ADD COLUMN     "mutationDetected" INTEGER,
ADD COLUMN     "mutationExcluded" INTEGER,
ADD COLUMN     "mutationMinScore" DOUBLE PRECISION,
ADD COLUMN     "mutationScore" DOUBLE PRECISION,
ADD COLUMN     "mutationUndetected" INTEGER;

-- CreateTable
CREATE TABLE "MutationSurvivor" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "testResultId" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "line" INTEGER,
    "mutator" TEXT NOT NULL,
    "detail" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutationSurvivor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "Show me this result's surviving mutants" — the read the run page and the
-- test-history page both make.
CREATE INDEX "MutationSurvivor_testResultId_idx" ON "MutationSurvivor"("testResultId");

-- CreateIndex
-- "Which files in this org keep surviving?" — the read that turns a score into
-- a work queue. "orgId" is first because the tenant extension makes it an
-- equality on every read, which is also what lets this one index serve the
-- plain org-scoped scan; a separate index on ("orgId") alone would be an
-- identical prefix and pure write amplification.
CREATE INDEX "MutationSurvivor_orgId_file_idx" ON "MutationSurvivor"("orgId", "file");

-- CreateIndex
-- The prune's own column, exactly like "Artifact"."expiresAt". Without it the
-- sweep's "oldest first, past the window" read is a sequential scan and a sort
-- of every survivor the install has ever recorded. No second index in DESC
-- order: a btree scans backwards, so one direction serves both (the same
-- reasoning as the createdAt indexes in 20260824000000_query_plan_indexes).
CREATE INDEX "MutationSurvivor_createdAt_idx" ON "MutationSurvivor"("createdAt");

-- AddForeignKey
ALTER TABLE "MutationSurvivor" ADD CONSTRAINT "MutationSurvivor_testResultId_fkey" FOREIGN KEY ("testResultId") REFERENCES "TestResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;
