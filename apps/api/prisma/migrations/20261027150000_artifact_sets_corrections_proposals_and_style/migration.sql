-- The craft: multi-file generated output, who owns each file, what reviewers
-- change about it, and what QAAI may only ever PROPOSE.
--
-- WHY THIS EXISTS
--
-- `generatedTestSchema` carried ONE `code` and ONE `filePath`, so a page
-- object, a shared fixture or a dataset file was impossible BY CONSTRUCTION --
-- while five prompts in packages/agent/src/ecosystem-prompts.ts tell the model
-- to use page objects. Setup was therefore copy-pasted into every spec, which
-- is both the thing reviewers delete generated tests for and the thing that
-- makes a suite unmaintainable. A deleted test is worse than no test: it cost a
-- reviewer an hour and left the coverage number exactly where it was.
--
-- THE RULE EVERY TABLE HERE ENFORCES
--
-- OWNERSHIP IS A RECORDED FACT. `pushRepo` (apps/api/src/lib/git.ts:143) `git
-- rm`s every tracked file absent from the tree it is handed -- it INFERS
-- ownership from absence, so it erases a human's edits in the same branch.
-- "GeneratedArtifact" is the ledger that makes the question answerable, and the
-- ABSENCE of a row means NOT OURS, which is the fail-closed direction.
-- `WRITABLE_BY_OWNERSHIP` in packages/shared/src/artifact-set.ts has exactly
-- one `true` key and it is true only when the bytes on disk are the bytes QAAI
-- last wrote.
--
-- FIVE ENUMS, AND WHAT EACH ONE EARNED ITS POSTGRES TYPE WITH
--
-- The house rule, recorded by 20261027120000_deployment_browser_capability and
-- by the dimension pairs before it: a Prisma enum is for a value that is
-- GROUPED ON or FILTERED ON, and everything else is TEXT with its domain
-- enforced at the producer. All five below are grouped on:
--
--   "ArtifactRole"       "how much of what we own is shared infrastructure and
--                        how much is specs" -- the number that says whether page
--                        objects are being produced or setup is still copied.
--   "ArtifactOwnership"  filtered on every apply ("everything I may write") and
--                        grouped in the cockpit ("everything a human took
--                        over"). A value missing from this type could not be
--                        stored, which for HUMAN_EDITED means the row that stops
--                        QAAI overwriting a human's edit would fail to insert --
--                        and the next run would find a QAAI_OWNED row and
--                        overwrite the edit. The worst failure in this schema.
--   "CorrectionKind"     the corpus's whole question is `GROUP BY kind`.
--   "SuiteChangeKind"    acceptance rate per kind is the only evidence that
--                        refactoring is worth offering at all.
--   "SuiteChangeState"   every review list filters on it.
--
-- All five are paired in apps/api/scripts/check-enums.ts in the same change, so
-- `check:enums` reports 51 pairs where it reported 46. None of them exists in
-- any deployed database yet, so the LIVE half still reports 9 of 51 compared and
-- 42 absent with a remedy -- a migration that has not been deployed is a deploy
-- step, not drift.
--
-- `ArtifactDisposition` IS NOT HERE, ON PURPOSE. NEW / UPDATE_OWNED /
-- PROPOSED_EDIT is a REQUEST made at one moment against a ledger that may have
-- moved. Storing it would create a second, older opinion about whether a write
-- is permitted, and the first thing a second opinion does is diverge. It is
-- re-derived from the stored ownership by `dispositionFor` on every apply, and
-- its parity is in packages/shared/src/artifact-set.test.ts against the zod
-- schema's own `.options` -- the same arrangement `BROWSER_ENGINES` and
-- `UNIQUENESS_SCOPES` have, and for the same reason: there is no column for it
-- to drift from.
--
-- TWO COLUMNS ON "Project", AND WHY THEY DO NOT REWRITE IT
--
-- `styleProfile` and `styleProfileComputedAt` are the computed house-style
-- profile: a CACHE of facts that live in the customer's repository, one per
-- scope, recomputed wholesale, never queried by field. A table would be one row
-- per project whose only query is by projectId, plus a second place for the
-- timestamp to drift from.
--
-- Both are `ADD COLUMN ... NULL` WITH NO DEFAULT, which is metadata-only in
-- PostgreSQL 11+ -- no table rewrite and no ACCESS EXCLUSIVE lock held while one
-- happens. That is the assertion the previous rounds asked for by name about
-- "TestResult", applied here to the table every other row in this product hangs
-- off. NULL means NOT COMPUTED; `{}` would be a profile confidently reporting no
-- conventions, which is a different and false claim.
--
-- NO INDEX ON "GeneratedArtifact"."imports", DELIBERATELY. The containment query
-- `imports @> ARRAY[path]` is how "who depends on this page object" is answered,
-- and a GIN index is what it would want -- but schema.prisma cannot express one
-- without an `ops` class this repo has never used, so declaring it in SQL only
-- would introduce drift `prisma migrate diff` reports for ever. The query is
-- bounded by "projectId", which IS indexed, and a project holds hundreds of
-- artifacts rather than millions.
--
-- WRITTEN BY HAND. `prisma migrate dev` was not run -- the round's rules forbid
-- it -- so this file is hand-authored against a `prisma validate`-clean schema
-- and a regenerated client. It has NOT been applied.

-- CreateEnum
CREATE TYPE "ArtifactRole" AS ENUM ('DATASET', 'HELPER', 'FIXTURE', 'PAGE_OBJECT', 'SPEC', 'SNAPSHOT', 'CONFIG_FRAGMENT');

-- CreateEnum
CREATE TYPE "ArtifactOwnership" AS ENUM ('QAAI_OWNED', 'HUMAN_EDITED', 'HUMAN_AUTHORED');

-- CreateEnum
CREATE TYPE "CorrectionKind" AS ENUM ('LOCATOR_CHANGED', 'ASSERTION_STRENGTHENED', 'ASSERTION_WEAKENED', 'WAIT_REMOVED', 'HELPER_SUBSTITUTED', 'FILE_MOVED', 'DATA_EXTRACTED', 'TEST_SPLIT', 'TEST_DELETED', 'NAMING_CHANGED', 'FORMATTING_ONLY', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "SuiteChangeKind" AS ENUM ('EXTRACT_FIXTURE', 'EXTRACT_PAGE_OBJECT', 'EXTRACT_DATASET', 'MERGE_NEAR_DUPLICATES', 'STRENGTHEN_ASSERTION', 'REMOVE_FIXED_SLEEP', 'REPLACE_BRITTLE_LOCATOR', 'PARAMETERISE_CASES', 'SPLIT_TEST', 'MOVE_FILE', 'ADOPT_HOUSE_STYLE');

-- CreateEnum
CREATE TYPE "SuiteChangeState" AS ENUM ('PROPOSED', 'APPROVED', 'APPLIED', 'REVERTED', 'REJECTED', 'SUPERSEDED', 'BLOCKED');

-- AlterTable: metadata-only. See the header.
ALTER TABLE "Project" ADD COLUMN "styleProfile" JSONB;
ALTER TABLE "Project" ADD COLUMN "styleProfileComputedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "GeneratedArtifact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "role" "ArtifactRole" NOT NULL,
    "ownership" "ArtifactOwnership" NOT NULL,
    "testId" TEXT,
    "contentHash" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "imports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "humanEditedAt" TIMESTAMP(3),
    "humanEditedHash" TEXT,
    "writtenByRunId" TEXT,
    "firstWrittenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastWrittenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestCorrection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "generatedVersion" INTEGER NOT NULL,
    "humanVersion" INTEGER NOT NULL,
    "generatedVersionId" TEXT NOT NULL,
    "humanVersionId" TEXT NOT NULL,
    "kinds" "CorrectionKind"[],
    "items" JSONB NOT NULL DEFAULT '[]',
    "surface" TEXT,
    "addedLines" INTEGER NOT NULL DEFAULT 0,
    "removedLines" INTEGER NOT NULL DEFAULT 0,
    "unclassifiedCount" INTEGER NOT NULL DEFAULT 0,
    "itemsOmitted" INTEGER NOT NULL DEFAULT 0,
    "classifierVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuiteChangeProposal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "SuiteChangeKind" NOT NULL,
    "state" "SuiteChangeState" NOT NULL DEFAULT 'PROPOSED',
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dependentTestIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dependentPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "revert" JSONB NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "revertedBy" TEXT,
    "supersededById" TEXT,
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuiteChangeProposal_pkey" PRIMARY KEY ("id")
);

-- ONE FACT PER PATH PER PROJECT. Two rows for one path would be two answers to
-- "may QAAI write this", and the permissive one would win by whichever the
-- query happened to return first.
-- CreateIndex
CREATE UNIQUE INDEX "GeneratedArtifact_projectId_path_key" ON "GeneratedArtifact"("projectId", "path");

-- CreateIndex
CREATE INDEX "GeneratedArtifact_orgId_idx" ON "GeneratedArtifact"("orgId");

-- CreateIndex
CREATE INDEX "GeneratedArtifact_projectId_role_idx" ON "GeneratedArtifact"("projectId", "role");

-- CreateIndex
CREATE INDEX "GeneratedArtifact_projectId_ownership_idx" ON "GeneratedArtifact"("projectId", "ownership");

-- CreateIndex
CREATE INDEX "GeneratedArtifact_testId_idx" ON "GeneratedArtifact"("testId");

-- One correction per (test, generated version, human version). Re-running the
-- classifier over the same pair must UPDATE rather than accumulate, or the
-- group-by counts our own re-runs.
-- CreateIndex
CREATE UNIQUE INDEX "TestCorrection_testId_generatedVersionId_humanVersionId_key" ON "TestCorrection"("testId", "generatedVersionId", "humanVersionId");

-- CreateIndex
CREATE INDEX "TestCorrection_orgId_idx" ON "TestCorrection"("orgId");

-- CreateIndex
CREATE INDEX "TestCorrection_projectId_createdAt_idx" ON "TestCorrection"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "TestCorrection_projectId_testId_idx" ON "TestCorrection"("projectId", "testId");

-- CreateIndex
CREATE INDEX "SuiteChangeProposal_orgId_idx" ON "SuiteChangeProposal"("orgId");

-- CreateIndex
CREATE INDEX "SuiteChangeProposal_projectId_state_createdAt_idx" ON "SuiteChangeProposal"("projectId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "SuiteChangeProposal_projectId_kind_state_idx" ON "SuiteChangeProposal"("projectId", "kind", "state");

-- AddForeignKey
ALTER TABLE "GeneratedArtifact" ADD CONSTRAINT "GeneratedArtifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCorrection" ADD CONSTRAINT "TestCorrection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuiteChangeProposal" ADD CONSTRAINT "SuiteChangeProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- TO REVERT, in this order (the reverse of the above):
--
--   ALTER TABLE "SuiteChangeProposal" DROP CONSTRAINT "SuiteChangeProposal_projectId_fkey";
--   ALTER TABLE "TestCorrection" DROP CONSTRAINT "TestCorrection_projectId_fkey";
--   ALTER TABLE "GeneratedArtifact" DROP CONSTRAINT "GeneratedArtifact_projectId_fkey";
--   DROP TABLE "SuiteChangeProposal";
--   DROP TABLE "TestCorrection";
--   DROP TABLE "GeneratedArtifact";
--   ALTER TABLE "Project" DROP COLUMN "styleProfileComputedAt";
--   ALTER TABLE "Project" DROP COLUMN "styleProfile";
--   DROP TYPE "SuiteChangeState";
--   DROP TYPE "SuiteChangeKind";
--   DROP TYPE "CorrectionKind";
--   DROP TYPE "ArtifactOwnership";
--   DROP TYPE "ArtifactRole";
--
-- Dropping "GeneratedArtifact" LOSES THE OWNERSHIP LEDGER, which is the fact
-- that stops `pushRepo` erasing human edits. A revert therefore has to be
-- paired with disarming the write path, not only with this SQL -- otherwise
-- every path reads as UNRECORDED, which fails closed (nothing is written) but
-- also means no generated artifact can be updated again until the ledger is
-- rebuilt.
-- ─────────────────────────────────────────────────────────────────────────────
