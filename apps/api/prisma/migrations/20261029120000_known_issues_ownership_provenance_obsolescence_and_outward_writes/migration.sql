-- Where a loop ENDS: the durable mute, the provenance of an owner, the test
-- whose surface is gone, and the two outward-facing writes that had no record.
--
-- WHY THIS EXISTS
--
-- Four loops in this product produced a finding and had nowhere to put it:
--
--   1. "VerdictReviewState"."MUTED" was written by two endpoints and read by
--      NOTHING. So the next run of an already-triaged failure minted a fresh
--      verdict and a fresh strong-model heal: noise and cost, forever, for a
--      failure a human had already judged. "KnownIssue" is the durable mute.
--   2. Every surface rendered an owner identically, so "Dana owns this because
--      Dana said so" and "the payments team owns this because somebody once
--      wrote a catch-all glob" were the same pixel. "OwnerProvenance" is the
--      difference, and it is also the gate on suppression: a glob may route a
--      failure, it may not decide the failure stops counting.
--   3. Nothing flagged a test whose routes or locators are gone from the latest
--      crawl, so a removed feature left a test that STILL COUNTED AS COVERAGE
--      and every rename cost a failing run plus a heal a set difference would
--      have predicted for free. "ObsoleteTestSignal" and "RetirementProposal"
--      are that path.
--   4. "HealProposal"."prUrl" was documented as "PR opened when the repo is
--      connected" and NOTHING WROTE IT -- a doc comment that contradicted the
--      code under it. "PullRequestRecord" is the writer's record and the
--      idempotence key that stops a retried CI step opening a second PR.
--
-- THE INVARIANT EVERY SUPPRESSION TABLE HERE ENFORCES
--
-- A suppression is COUNTED, OWNED, EXPIRING and REVERSIBLE -- and AN EXPIRED
-- SUPPRESSION DOES NOT SUPPRESS. "KnownIssue"."expiresAt" is therefore NOT
-- NULL, with no default and no sentinel far-future value, which is the opposite
-- of every suppression already in this schema: "Test"."quarantineExpiresAt" is
-- null on every quarantine written before that column existed, and
-- "CoverageWaiver"."expiresAt" is still nullable today. There is exactly one
-- check -- `isInForce` in packages/shared/src/suppression.ts -- so an expired
-- mute cannot behave like a live one at one call site and a dead one at
-- another, which is precisely the shape the quarantine bug had.
--
-- NOT NULL WITHOUT A DEFAULT IS SAFE HERE because all five tables are NEW.
-- Nothing is back-filled, so no existing row has to be given an expiry it never
-- agreed to. (Back-filling an expiry onto quarantines a customer never signed
-- would turn thousands of suppressed failures red in one deploy -- a migration
-- deciding to break a build, which is why "Test"."quarantineExpiresAt" stayed
-- nullable and the gate WARNs about the unbounded rows instead.)
--
-- THE CHECK CONSTRAINTS ARE THE POINT OF THE TWO OWNER PAIRS
--
-- "KnownIssue" and "RetirementProposal" each carry ownerUserId/ownerTeamId, and
-- Prisma cannot express "exactly one of these". Convention is not enough here:
-- both null is not a mute, it is a silence with nobody's name on it, which is
-- the single thing this whole change exists to prevent. So two CHECKs, written
-- by hand below. "RetirementProposal" admits BOTH null -- an unowned retirement
-- is a real and reportable answer, better than assigning it to whoever is
-- listed first -- but never both set.
--
-- FOUR ENUMS, AND WHAT EACH EARNED ITS POSTGRES TYPE WITH
--
-- The house rule, recorded by 20261027150000 and the migrations before it: a
-- Prisma enum is for a value that is GROUPED ON or FILTERED ON, and everything
-- else is TEXT with its domain enforced at the producer. All four are:
--
--   "SuppressionKind"         "47 failures suppressed by 3 known issues" is a
--                             group-by over this column, and that sentence is
--                             the one that keeps the feature honest.
--   "OwnerProvenance"         "how many of this project's owners were actually
--                             set by a person?" is the question that says
--                             whether an ownership table is real or whether one
--                             catch-all is routing everything.
--   "ObsolescenceSignalKind"  route-gone versus locator-not-found is the
--                             difference between a cleanup list and a crawl
--                             that forgot to log in.
--   "RetirementState"         every review list filters on it.
--
-- All four are paired in apps/api/scripts/check-enums.ts in the same change, so
-- `check:enums` reports 55 pairs where it reported 51. None exists in any
-- deployed database, so the LIVE half still reports 9 compared and the rest
-- absent with a remedy -- a migration that has not been deployed is a deploy
-- step, not drift.
--
-- "DENOMINATOR_EFFECTS" IS NOT HERE, ON PURPOSE. What a suppression does to the
-- coverage denominator is a FUNCTION of its kind (`denominatorEffectOf`), and a
-- stored copy would be two facts in one field -- the row and the disclosure
-- beside it computed from different values, which is the defect
-- `houseStyle.planned` already shipped once. Its parity is against
-- `denominatorEffectSchema.options` in packages/shared/src/suppression.test.ts.
-- Same for "SUPPRESSION_TARGET_SCOPES", "SUPPRESSION_REFUSALS",
-- "OWNER_STRENGTHS", "OWNABLE_SUBJECTS", "PR_PURPOSES",
-- "PR_RECORD_STATES" and "RECORDING_PROMOTION_STATES": none is a column, or the
-- column is TEXT and nothing groups on it.

-- CreateEnum
CREATE TYPE "SuppressionKind" AS ENUM ('QUARANTINE', 'MUTE', 'ENV_ISSUE', 'COVERAGE_WAIVER', 'RETIREMENT');

-- CreateEnum
CREATE TYPE "OwnerProvenance" AS ENUM ('EXPLICIT_ASSIGNMENT', 'RULE_TEST', 'RULE_SUITE', 'RULE_FEATURE', 'RULE_PATH', 'CODEOWNERS_IMPORT', 'LAST_EDITOR', 'INHERITED', 'NONE');

-- CreateEnum
CREATE TYPE "ObsolescenceSignalKind" AS ENUM ('ROUTE_GONE', 'LOCATOR_GONE', 'ROUTE_UNREACHABLE', 'FEATURE_GONE');

-- CreateEnum
CREATE TYPE "RetirementState" AS ENUM ('PROPOSED', 'APPROVED', 'APPLIED', 'REJECTED', 'REVERTED', 'EXPIRED');

-- AlterTable
--
-- Both nullable, and their null means the same thing the existing
-- "ownerState"'s null means: nothing has tried to route this verdict yet.
-- "knownIssueId" is a plain id and NOT a foreign key on purpose -- the
-- verdict's record of having been muted must survive the mute being deleted,
-- and a cascade would erase the evidence along with the decision.
ALTER TABLE "TriageVerdict" ADD COLUMN "ownerProvenance" "OwnerProvenance";
ALTER TABLE "TriageVerdict" ADD COLUMN "knownIssueId" TEXT;

-- AlterTable
--
-- "prUrl" finally gets a writer. "prRecordId" points at the row that holds the
-- idempotence key, so a second apply of the same heal finds the PR already open.
ALTER TABLE "HealProposal" ADD COLUMN "prRecordId" TEXT;

-- CreateTable
CREATE TABLE "KnownIssue" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "signatures" TEXT[],
    "ownerUserId" TEXT,
    "ownerTeamId" TEXT,
    "ownerProvenance" "OwnerProvenance" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "trackerIssueId" TEXT,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "firstMatchedAt" TIMESTAMP(3),
    "lastMatchedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokedReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnownIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnownIssueMatch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "knownIssueId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnownIssueMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- THE COUNTED LEDGER, and the most important table here. Five private counters
-- (Run.suppressedFailures, FailureSignature.suppressedCount, and three kinds
-- that counted themselves nowhere) meant five chances for a surface to read
-- four of them. Every kind writes here and every surface reads here, so "47
-- failures suppressed by 3 known issues" is one query.
--
-- A row with "inForce" = false and "suppressed" = 0 is the PROOF an expiry
-- worked: without it, "the mute expired and the failure went red" and "nobody
-- ever asked" are the same absence.
CREATE TABLE "SuppressionEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "SuppressionKind" NOT NULL,
    "targetScope" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "sourceId" TEXT,
    "suppressed" INTEGER NOT NULL DEFAULT 0,
    "inForce" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "ownerTeamId" TEXT,
    "ownerState" TEXT NOT NULL,
    "ownerProvenance" "OwnerProvenance" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObsoleteTestSignal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "kind" "ObsolescenceSignalKind" NOT NULL,
    "reference" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "lastFlowMapId" TEXT NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "dismissedBy" TEXT,
    "dismissedReason" TEXT,

    CONSTRAINT "ObsoleteTestSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetirementProposal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "state" "RetirementState" NOT NULL DEFAULT 'PROPOSED',
    "reason" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "ownerTeamId" TEXT,
    "ownerState" TEXT NOT NULL,
    "ownerProvenance" "OwnerProvenance" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "signalIds" TEXT[],
    "surfacesReturnedToUncovered" TEXT[],
    "surfacesStillCovered" TEXT[],
    "denominatorNote" TEXT NOT NULL,
    "surfacesReopened" BOOLEAN NOT NULL DEFAULT false,
    "healProposalId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "appliedBy" TEXT,
    "disabledVersion" INTEGER,
    "revertedAt" TIMESTAMP(3),
    "revertedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetirementProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" "IntegrationKind" NOT NULL,
    "integrationId" TEXT,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "baseRef" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "causeKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'REQUESTED',
    "number" INTEGER,
    "url" TEXT,
    "failureNote" TEXT,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "filePaths" TEXT[],
    "preservedPaths" TEXT[],
    "openedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequestRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingPromotion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT,
    "recordingKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CAPTURED',
    "promotedTestId" TEXT,
    "rejectedReason" TEXT,
    "recordedBy" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedBy" TEXT,
    "promotedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnownIssue_orgId_projectId_expiresAt_idx" ON "KnownIssue"("orgId", "projectId", "expiresAt");

-- CreateIndex
--
-- GIN, so "which known issue covers this cause?" is an index lookup instead of
-- a scan of every mute the install has ever written. That read happens once per
-- failing cluster per run, which on a 200-test outage is the read that decides
-- whether a model call happens at all.
CREATE INDEX "KnownIssue_signatures_idx" ON "KnownIssue" USING GIN ("signatures");

-- CreateIndex
--
-- THE CLAIM. A retried run finaliser must not file a second match for one cause
-- in one run, because the match rows are the evidence behind "this mute has
-- silenced 1,340 failures" and a double count makes that number fiction.
CREATE UNIQUE INDEX "KnownIssueMatch_knownIssueId_runId_clusterKey_key" ON "KnownIssueMatch"("knownIssueId", "runId", "clusterKey");

-- CreateIndex
CREATE INDEX "KnownIssueMatch_orgId_matchedAt_idx" ON "KnownIssueMatch"("orgId", "matchedAt");

-- CreateIndex
--
-- THE CLAIM. A redelivered run finaliser must not double-count a suppression:
-- these rows ARE the count, and a doubled count is exactly as dishonest as a
-- missing one.
CREATE UNIQUE INDEX "SuppressionEvent_runId_kind_targetKey_key" ON "SuppressionEvent"("runId", "kind", "targetKey");

-- CreateIndex
CREATE INDEX "SuppressionEvent_projectId_kind_createdAt_idx" ON "SuppressionEvent"("projectId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "SuppressionEvent_orgId_createdAt_idx" ON "SuppressionEvent"("orgId", "createdAt");

-- CreateIndex
--
-- One LIVE signal per (test, kind, reference). A new crawl that still cannot
-- find the same route increments "confirmations" on this row rather than filing
-- a second one -- which is what makes "two consecutive crawls agreed" a fact
-- rather than a count of rows that happen to exist.
CREATE UNIQUE INDEX "ObsoleteTestSignal_testId_kind_reference_key" ON "ObsoleteTestSignal"("testId", "kind", "reference");

-- CreateIndex
CREATE INDEX "ObsoleteTestSignal_projectId_resolvedAt_idx" ON "ObsoleteTestSignal"("projectId", "resolvedAt");

-- CreateIndex
CREATE INDEX "ObsoleteTestSignal_orgId_kind_idx" ON "ObsoleteTestSignal"("orgId", "kind");

-- CreateIndex
CREATE INDEX "RetirementProposal_projectId_state_idx" ON "RetirementProposal"("projectId", "state");

-- CreateIndex
CREATE INDEX "RetirementProposal_orgId_expiresAt_idx" ON "RetirementProposal"("orgId", "expiresAt");

-- CreateIndex
CREATE INDEX "RetirementProposal_testId_idx" ON "RetirementProposal"("testId");

-- CreateIndex
--
-- ONE PR PER CAUSE. Opening a pull request is an outward-facing write into
-- somebody else's repository: a retried CI step, a redelivered webhook or a
-- double-clicked button must find this row and link to the PR already open.
-- The same shape "TrackerIssue"."causeKey" uses, and for the same reason.
CREATE UNIQUE INDEX "PullRequestRecord_orgId_causeKey_key" ON "PullRequestRecord"("orgId", "causeKey");

-- CreateIndex
CREATE INDEX "PullRequestRecord_projectId_state_idx" ON "PullRequestRecord"("projectId", "state");

-- CreateIndex
--
-- The promotion claim: the same recording promoted twice finds this row and
-- links to the test it already made, instead of making a second test from one
-- session.
CREATE UNIQUE INDEX "RecordingPromotion_projectId_recordingKey_key" ON "RecordingPromotion"("projectId", "recordingKey");

-- CreateIndex
CREATE INDEX "RecordingPromotion_projectId_state_idx" ON "RecordingPromotion"("projectId", "state");

-- AddForeignKey
ALTER TABLE "KnownIssue" ADD CONSTRAINT "KnownIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnownIssueMatch" ADD CONSTRAINT "KnownIssueMatch_knownIssueId_fkey" FOREIGN KEY ("knownIssueId") REFERENCES "KnownIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObsoleteTestSignal" ADD CONSTRAINT "ObsoleteTestSignal_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetirementProposal" ADD CONSTRAINT "RetirementProposal_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestRecord" ADD CONSTRAINT "PullRequestRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingPromotion" ADD CONSTRAINT "RecordingPromotion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE TWO CHECK CONSTRAINTS PRISMA CANNOT EXPRESS
--
-- "exactly one owner" is not a convention, it is the invariant. A KnownIssue
-- with neither owner set is a silence with nobody's name on it, which is the
-- single thing this change exists to prevent -- and a row with BOTH set routes
-- the renewal to two places, so whoever does not act assumes the other did.
--
-- "RetirementProposal" admits NEITHER, deliberately: an unowned retirement is a
-- real and reportable answer (`unownedFinding`, packages/shared/src/ownership.ts)
-- and surfacing it is better than assigning the decision to whoever happens to
-- be listed first. It still refuses BOTH.
--
-- Written by hand because `prisma migrate` cannot generate a CHECK and
-- `prisma db pull` will not see it -- which means a future `migrate dev` may
-- report it as drift. Keep it: the alternative is an invariant enforced only by
-- the zod schema, and a zod schema is not reached by a backfill script, a
-- support query or a psql session.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "KnownIssue" ADD CONSTRAINT "KnownIssue_one_owner"
  CHECK (("ownerUserId" IS NOT NULL AND "ownerTeamId" IS NULL)
      OR ("ownerUserId" IS NULL AND "ownerTeamId" IS NOT NULL));

ALTER TABLE "RetirementProposal" ADD CONSTRAINT "RetirementProposal_at_most_one_owner"
  CHECK (NOT ("ownerUserId" IS NOT NULL AND "ownerTeamId" IS NOT NULL));

-- ─────────────────────────────────────────────────────────────────────────────
-- TO REVERT, in this order (the reverse of the above):
--
--   ALTER TABLE "RetirementProposal" DROP CONSTRAINT "RetirementProposal_at_most_one_owner";
--   ALTER TABLE "KnownIssue" DROP CONSTRAINT "KnownIssue_one_owner";
--   ALTER TABLE "RecordingPromotion" DROP CONSTRAINT "RecordingPromotion_projectId_fkey";
--   ALTER TABLE "PullRequestRecord" DROP CONSTRAINT "PullRequestRecord_projectId_fkey";
--   ALTER TABLE "RetirementProposal" DROP CONSTRAINT "RetirementProposal_testId_fkey";
--   ALTER TABLE "ObsoleteTestSignal" DROP CONSTRAINT "ObsoleteTestSignal_testId_fkey";
--   ALTER TABLE "KnownIssueMatch" DROP CONSTRAINT "KnownIssueMatch_knownIssueId_fkey";
--   ALTER TABLE "KnownIssue" DROP CONSTRAINT "KnownIssue_projectId_fkey";
--   DROP TABLE "RecordingPromotion";
--   DROP TABLE "PullRequestRecord";
--   DROP TABLE "RetirementProposal";
--   DROP TABLE "ObsoleteTestSignal";
--   DROP TABLE "KnownIssueMatch";
--   DROP TABLE "KnownIssue";
--   DROP TABLE "SuppressionEvent";
--   ALTER TABLE "HealProposal" DROP COLUMN "prRecordId";
--   ALTER TABLE "TriageVerdict" DROP COLUMN "knownIssueId";
--   ALTER TABLE "TriageVerdict" DROP COLUMN "ownerProvenance";
--   DROP TYPE "RetirementState";
--   DROP TYPE "ObsolescenceSignalKind";
--   DROP TYPE "OwnerProvenance";
--   DROP TYPE "SuppressionKind";
--
-- WHAT A REVERT COSTS, stated rather than discovered. Dropping "KnownIssue"
-- DROPS EVERY MUTE, so every cause somebody triaged goes loud again on the next
-- run and mints a fresh verdict and a fresh strong-model heal -- the original
-- defect, restored, and at full model cost on the first run after the revert.
-- Dropping "PullRequestRecord" DROPS THE IDEMPOTENCE KEY, so the next apply of
-- a heal that already has a PR open opens a second one in the customer's
-- repository. A revert therefore has to be paired with disarming the PR path,
-- not only with this SQL.
--
-- Dropping "SuppressionEvent" DROPS THE ONLY CROSS-KIND COUNT, so every surface
-- falls back to the five private counters it was built to replace and a
-- suppressed failure stops being countable -- which is the one lie this feature
-- exists to prevent. All four enums have a writing column in this same
-- migration ("SuppressionKind" on "SuppressionEvent", "OwnerProvenance" on four
-- tables, "ObsolescenceSignalKind" on "ObsoleteTestSignal", "RetirementState"
-- on "RetirementProposal"): a minted type owes a writer in the round that mints
-- it.
-- ─────────────────────────────────────────────────────────────────────────────
