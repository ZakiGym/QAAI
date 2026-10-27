-- The dimensions, the rollups, the export envelope, and the harness that
-- measures the measurer.
--
-- WHY THIS EXISTS
--
-- 20261024070000 built the surface registry, 20261024090000 added the declarers
-- that name what no crawl can reach, 20261024100000 added the identity asking,
-- and 20261025100000 built the NUMERATOR: the ladder, the provenance edges, the
-- variant matrix and the metric channel. Between them the product can say
-- "61% navigated, 34% passing" about a list of routes, endpoints, forms and
-- auth surfaces.
--
-- What none of them can say is anything BELOW an item, anything ABOUT a test
-- type, anything to a person who is not looking at one authenticated screen, or
-- anything at all about whether the number is true. Six absences, each of which
-- is a lie in the only sentence this company has:
--
--   1. COVERAGE WAS A SINGLE BOOLEAN PER ROUTE. packages/agent/src/coverage.ts
--      folds every state of a route into one entry with the comment "because
--      coverage is a property of the route". It is not. A route serving an empty
--      list, a 403 and a pagination boundary is three things to test, and before
--      "CoverageItemState" the second and third were not UNCOVERED — they were
--      absent from the inventory. Absent raises the percentage; uncovered lowers
--      it. Those are opposite facts and the product was reporting the flattering
--      one.
--   2. A FORM WAS ONE BOOLEAN. It counted as exercised if any test mentioned its
--      submit label or one field label near a .fill(). So a fourteen-field
--      checkout form with one test that types into the email box was 100% of the
--      FORM axis, and `required`, `semantic` and every boundary case were counted
--      by nobody. "CoverageFormField" makes each field a cell and each validation
--      RULE derived from it a cell, on two separate denominators that are never
--      summed.
--   3. COVERAGE WAS TYPE-BLIND. A PERFORMANCE test marked /checkout fully
--      visited exactly as an E2E did, so "routes with an ACCESSIBILITY test: 3
--      of 14" could not be said. Nineteen test types against one boolean.
--      "CoverageTypeObligation" makes the obligation a FACT ABOUT THE ROUTE
--      rather than a global default — and the default owes NOTHING, because
--      nineteen fabricated denominators is a worse defect than one boolean.
--   4. A PERCENTAGE COULD INCLUDE TESTS THAT ALWAYS SKIP. The worker image has
--      no k6, Lighthouse, Stryker, Maestro, Firefox or WebKit; those plugins
--      degrade to SKIPPED, and nothing anywhere said which of the nineteen types
--      a deployment can execute. A pass rate containing un-failable tests is a
--      pass that means "we did not check". "DeploymentCapability" is the record,
--      with NOT_CHECKED kept strictly apart from MISSING.
--   5. ONE GLOBAL PERCENTAGE COULD BE ASSIGNED TO NOBODY. Gaps carry a `feature`
--      string and the totals were global only, so "Payments is at 31%, owned by
--      Team Billing" was unsayable — and the number nobody owns is the number
--      nobody moves. "CoverageRollup" gives every feature and every team its OWN
--      numerator and denominator, and "CoverageHistory" gives each of them a
--      direction with the comparability that says whether its delta is allowed
--      to exist at all.
--   6. NOTHING MEASURED THE MEASURER. No ground truth, no seeded-fault
--      benchmark, no back-test against the customer's own bug history. A
--      catch-all route literal once gave 100% coverage and SURVIVED, because
--      nothing was checking. "BenchmarkRun" / "BenchmarkFaultResult" record what
--      share of individually switchable seeded defects the suite actually
--      caught, per fault CLASS; "ValidityBacktest" asks whether "covered" tracks
--      escaped defects, with its n always beside it and INSUFFICIENT_DATA as a
--      first-class answer.
--
-- And one that is not a measurement at all but a false red:
-- "VisualBaseline" was unique on (test, viewport, browser), so STAGING AND
-- PRODUCTION SHARED A REFERENCE IMAGE. Whichever environment ran first captured
-- the baseline and every later diff on the other was measured against it, so a
-- staging capture silently became the production reference and the red it
-- produced was permanently false — nobody could fix it by changing the
-- application, because the application was not what differed. A visual suite
-- that cannot be made green is a visual suite that gets switched off.
--
-- THE HONESTY RULES THIS DDL ENCODES, STATED ONCE
--
--   · AN UNMEASURED AXIS IS NOT 0%. "DimensionUnmeasuredReason" is an ENUM and
--     not TEXT — unlike "CoverageItem"."unexercisableReason" and
--     "TestCoverageEdge"."cappedBy", which are TEXT precisely because nothing
--     filters on them. This one is grouped by: the report lists the axes we do
--     not measure separately from the ones a cap truncated, because the first is
--     work for us and the second is a budget to raise. Every table below that
--     stores a measurement stores this beside it.
--   · NOT MEASURED IS NULL, NEVER 0. Every `tier` column is NULLABLE WITH NO
--     DEFAULT: a default of DECLARED would mint a claim nothing produced, which
--     is the same argument "TestCoverageEdge"."tier" records. Every `percent` is
--     nullable. "BenchmarkRun"."detectedCount" is nullable, because 0 detected is
--     a result — a terrible one — and "we did not finish" is not a result at all.
--     "ValidityBacktest"."escapedRateCovered" is nullable, because a zero escaped
--     rate on covered surface is the most flattering number this product could
--     print and it is exactly what a back-test over three tickets produces.
--   · A NULL AND A FALSE ARE DIFFERENT FACTS. "CoverageFormField"."required" is
--     a nullable boolean on purpose: null means the reader could not read the
--     attribute, false means it looked and the field is optional. Collapsing the
--     first into the second removes the cell from the denominator and raises the
--     percentage. "CoverageFormField"."constraint" is NULL when the constraints
--     were never read at all — `detectForms` reads none of them on the source
--     path, so ten of twenty boundary classes are unreachable from there, and
--     that has to be NAMEABLE rather than presented as a field with nothing to
--     test.
--   · A CAP THAT BIT IS A COUNT AND A REASON. "CoverageRollup"."caps" and
--     "BenchmarkRun"."caveats" default to '[]' — an empty list is a positive and
--     verifiable claim that nothing was truncated — while no COUNT in this
--     migration is defaulted, because an empty count would be a claim about the
--     customer's application.
--   · THE SCOPE OF AN ATTESTATION IS NOT OPTIONAL.
--     "CoverageAttestation"."scopeStatement", ."unmeasured" and ."caps" are NOT
--     NULL WITH NO DEFAULT, so the INSERT fails without them. A reader given a
--     percentage and no scope does not conclude "scope unknown"; they conclude
--     "87% of the application, and the other 13% is ordinary untested code". If
--     nine axes were never measured and a page budget truncated the crawl, that
--     reader has been told something false by a document containing no false
--     sentence. Omission is the lie.
--   · A UNIQUE INDEX MAY NOT CONTAIN A NULLABLE DISCRIMINATOR. PostgreSQL treats
--     NULLs as DISTINCT, so UNIQUE(snapshotId, dimension, feature, teamId) would
--     let the headline row — all three null — be written an unbounded number of
--     times and the writer's upsert would silently stop being idempotent. Every
--     duplicate is a second denominator for the same subject, which is how one
--     screen comes to disagree with another about the same percentage. So
--     "CoverageRollup" and "CoverageHistory" are unique on a NOT NULL `scopeKey`
--     built by `rollupScopeKey` in packages/shared/src/coverage-dimensions.ts,
--     with the three nullable columns kept beside it as what a reader filters on.
--     "DeploymentCapability"."deploymentKey" uses the sentinel '<self>' for the
--     same reason.
--
-- WHAT THIS MIGRATION DOES NOT DO
--
-- It adds no column to "CoverageItem"'s measurement, does not touch
-- "TestCoverageEdge"'s unique key, and does not alter "TestResult". Every
-- existing reader keeps the contract it was written against. The one DESTRUCTIVE
-- step is "VisualBaseline"'s unique index, and it is dealt with explicitly and
-- disclosed below rather than discovered.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The vocabularies
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "CoverageDimensionKind" AS ENUM ('PAGE_STATE', 'ERROR_STATE', 'DATA_VARIANT', 'FORM_FIELD', 'VALIDATION_RULE', 'COMPONENT', 'COMPONENT_STATE', 'TEST_TYPE', 'DEVICE_LOCALE', 'FLAG_COMBINATION', 'ROLE_CELL', 'BACKGROUND_JOB', 'NOTIFICATION');

-- CreateEnum
CREATE TYPE "CoverageCellKind" AS ENUM ('PAGE_DEFAULT', 'PAGE_LOADING', 'PAGE_EMPTY', 'PAGE_SLOW', 'PAGE_INTERSTITIAL', 'PAGE_REDIRECTED', 'ERROR_UNAUTHENTICATED', 'ERROR_FORBIDDEN', 'ERROR_NOT_FOUND', 'ERROR_SERVER', 'ERROR_VALIDATION', 'DATA_NONE', 'DATA_ONE', 'DATA_MANY', 'DATA_PAGE_BOUNDARY', 'DATA_MAXIMUM', 'DATA_MALFORMED', 'FORM_FIELD', 'RULE_REQUIRED', 'RULE_LENGTH', 'RULE_RANGE', 'RULE_STEP', 'RULE_PATTERN', 'RULE_SEMANTIC', 'COMPONENT', 'COMPONENT_DEFAULT', 'COMPONENT_LOADING', 'COMPONENT_EMPTY', 'COMPONENT_ERROR', 'COMPONENT_FORBIDDEN', 'COMPONENT_SLOW');

-- CreateEnum
CREATE TYPE "DimensionUnmeasuredReason" AS ENUM ('NO_EXTRACTOR', 'NOT_ENUMERATED', 'EXTRACTOR_RETURNED_UNKNOWN', 'HELD_OUT', 'CAP_BIT');

-- CreateEnum
CREATE TYPE "DeploymentCapabilityStatus" AS ENUM ('AVAILABLE', 'MISSING', 'WRONG_VERSION', 'NOT_CHECKED');

-- CreateEnum
CREATE TYPE "FaultDetectionOutcome" AS ENUM ('DETECTED', 'MISSED', 'NOT_EXERCISED', 'BASELINE_DIRTY');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Configuration the customer owns
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable: which test types each axis owes. NULLABLE WITH NO DEFAULT — null
-- is "this project never stated its obligations" and '{}' is "it considered the
-- question and owes nothing", and the UI can say which. A default here would
-- have minted an obligation per axis per project in one statement.
ALTER TABLE "Project" ADD COLUMN "typeObligationPolicy" JSONB;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The snapshot grows a direction, and the means to refuse one
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
-- All four of the first group are NULLABLE WITH NO DEFAULT, and null is
-- load-bearing: every snapshot written before today has none of them, and that
-- state is UNCOMPARABLE_FINGERPRINT_MISSING rather than comparable. Defaulting
-- "crawlVersion" to the current build would claim an old snapshot was measured
-- by today's enumerator.
ALTER TABLE "CoverageSnapshot" ADD COLUMN "crawlVersion" TEXT;
ALTER TABLE "CoverageSnapshot" ADD COLUMN "crawlFingerprint" TEXT;
ALTER TABLE "CoverageSnapshot" ADD COLUMN "denominatorDefinition" TEXT;
ALTER TABLE "CoverageSnapshot" ADD COLUMN "previousSnapshotId" TEXT;
ALTER TABLE "CoverageSnapshot" ADD COLUMN "deltaPercent" DOUBLE PRECISION;
-- 'NOT_COMPARED' and not 'COMPARABLE', which is the whole point: a row written
-- by a writer that never compared anything has not established comparability,
-- and COMPARABLE as a default would produce confident deltas across unknown
-- boundaries for every snapshot in the table.
ALTER TABLE "CoverageSnapshot" ADD COLUMN "comparability" TEXT NOT NULL DEFAULT 'NOT_COMPARED';
ALTER TABLE "CoverageSnapshot" ADD COLUMN "comparabilityDetail" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. VisualBaseline: the false red, and the safe way out of it
-- ─────────────────────────────────────────────────────────────────────────────
--
-- THIS IS THE ONE STEP WITH A BLAST RADIUS, SO IT IS SPELLED OUT.
--
-- The column is added WITH a default so that existing rows are backfilled in
-- one statement, then the default is DROPPED so that every new row must name the
-- environment it was captured in. A permanent default is how the
-- shared-reference defect comes back one writer at a time.
--
-- Existing rows are attributed to '<unattributed>' (UNATTRIBUTED_ENVIRONMENT in
-- @qaai/shared) and NOT to a guessed environment. There is no way to know which
-- environment an old capture came from, and attributing a possibly-staging image
-- to production would be inventing the exact fact this column exists to record.
--
-- THE DISCLOSED CONSEQUENCE: because the unique key now includes the
-- environment, a reader filtering on it finds no baseline for any real
-- environment and the next run captures a fresh one per (test, viewport,
-- browser, environment). That is one re-approval per visual test on deploy. It
-- is the SAFE failure — a missing baseline asks a human, where a wrong baseline
-- produces a red nobody can clear — and it is stated here rather than
-- discovered. Rows are NOT deleted: the old images stay addressable under
-- '<unattributed>' so an operator who knows which environment captured them can
-- re-attribute by hand.
ALTER TABLE "VisualBaseline" ADD COLUMN "environmentId" TEXT NOT NULL DEFAULT '<unattributed>';
ALTER TABLE "VisualBaseline" ALTER COLUMN "environmentId" DROP DEFAULT;

-- DropIndex: the unique key that made staging and production share a reference.
DROP INDEX "VisualBaseline_testId_viewport_browser_key";

-- CreateIndex
CREATE UNIQUE INDEX "VisualBaseline_testId_viewport_browser_environmentId_key" ON "VisualBaseline"("testId", "viewport", "browser", "environmentId");

-- CreateIndex
CREATE INDEX "VisualBaseline_projectId_environmentId_idx" ON "VisualBaseline"("projectId", "environmentId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. What lives below an item
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "CoverageItemState" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "stateKey" TEXT NOT NULL,
    "kind" "CoverageCellKind" NOT NULL,
    "label" TEXT NOT NULL,
    "origin" "SurfaceSource" NOT NULL,
    "evidence" TEXT NOT NULL,
    "parentStateKey" TEXT,
    "observedAt" TIMESTAMP(3),
    "exercisability" "SurfaceExercisability",
    "unexercisableReason" TEXT,
    "refusedByRule" TEXT,
    "exerciseDetail" TEXT,
    "tier" "CoverageTier",
    "tierCappedBy" TEXT,
    "lastConfirmedRunId" TEXT,
    "unmeasuredReason" "DimensionUnmeasuredReason",
    "unmeasuredDetail" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "CoverageItemState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverageFormField" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "kind" "CoverageCellKind" NOT NULL,
    "label" TEXT NOT NULL,
    "parentFieldKey" TEXT,
    "inputType" TEXT,
    "required" BOOLEAN,
    "semantic" TEXT,
    "constraint" JSONB,
    "constraintsRead" BOOLEAN NOT NULL DEFAULT false,
    "origin" "SurfaceSource" NOT NULL,
    "evidence" TEXT NOT NULL,
    "exercisability" "SurfaceExercisability",
    "unexercisableReason" TEXT,
    "refusedByRule" TEXT,
    "exerciseDetail" TEXT,
    "tier" "CoverageTier",
    "tierCappedBy" TEXT,
    "lastConfirmedRunId" TEXT,
    "unmeasuredReason" "DimensionUnmeasuredReason",
    "unmeasuredDetail" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "CoverageFormField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverageTypeObligation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "testType" "TestType" NOT NULL,
    "declaredBy" "SurfaceSource" NOT NULL,
    "evidence" TEXT NOT NULL,
    "tier" "CoverageTier",
    "tierCappedBy" TEXT,
    "lastConfirmedRunId" TEXT,
    "unmeasuredReason" "DimensionUnmeasuredReason",
    "unmeasuredDetail" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "CoverageTypeObligation_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The rollups, so a percentage can be assigned to somebody
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "CoverageRollup" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "dimension" "CoverageDimensionKind",
    "feature" TEXT,
    "teamId" TEXT,
    "numerator" INTEGER NOT NULL,
    "denominator" INTEGER NOT NULL,
    "percent" DOUBLE PRECISION,
    "tier" "CoverageTier" NOT NULL,
    "unmeasured" INTEGER NOT NULL DEFAULT 0,
    "unmeasuredReason" "DimensionUnmeasuredReason",
    "unmeasuredDetail" TEXT,
    "caps" JSONB NOT NULL DEFAULT '[]',
    "exclusions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverageRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverageHistory" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "dimension" "CoverageDimensionKind",
    "feature" TEXT,
    "teamId" TEXT,
    "numerator" INTEGER NOT NULL,
    "denominator" INTEGER NOT NULL,
    "percent" DOUBLE PRECISION,
    "tier" "CoverageTier" NOT NULL,
    "crawlFingerprint" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousSnapshotId" TEXT,
    "previousPercent" DOUBLE PRECISION,
    "deltaPercent" DOUBLE PRECISION,
    "comparability" TEXT NOT NULL DEFAULT 'NOT_COMPARED',
    "comparabilityDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverageHistory_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. What this deployment can actually run
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
-- "orgId" is NULLABLE here and nowhere else in this migration: the cloud image
-- is a property of the INSTALL and belongs to no org, while an on-prem runner
-- pool belongs to one and genuinely has different binaries.
CREATE TABLE "DeploymentCapability" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "deploymentKey" TEXT NOT NULL DEFAULT '<self>',
    "testType" "TestType" NOT NULL,
    "status" "DeploymentCapabilityStatus" NOT NULL,
    "detail" TEXT NOT NULL,
    "remedy" TEXT,
    "requiredBinary" TEXT,
    "requiredVersion" TEXT,
    "observedVersion" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentCapability_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. The number leaving the screen
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
-- "scopeStatement", "unmeasured" and "caps" are NOT NULL WITH NO DEFAULT, so an
-- attestation with no scope cannot be inserted. See the honesty rules above:
-- omission is the lie, and '[]' here would be the claim that nothing was
-- unmeasured in a round that added thirteen axes.
CREATE TABLE "CoverageAttestation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "snapshotId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "crawlVersion" TEXT NOT NULL,
    "crawlFingerprint" TEXT,
    "denominatorDefinition" TEXT NOT NULL,
    "percent" DOUBLE PRECISION,
    "denominator" INTEGER NOT NULL,
    "covered" INTEGER NOT NULL,
    "scopeStatement" TEXT NOT NULL,
    "unmeasured" JSONB NOT NULL,
    "caps" JSONB NOT NULL,
    "issuedByUserId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shareId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverageAttestation_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Measuring the measurer
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "ValidityBacktest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "snapshotId" TEXT,
    "windowStartAt" TIMESTAMP(3) NOT NULL,
    "windowEndAt" TIMESTAMP(3) NOT NULL,
    "defectCount" INTEGER NOT NULL,
    "coveredSurfaceCount" INTEGER NOT NULL,
    "uncoveredSurfaceCount" INTEGER NOT NULL,
    "defectsOnCovered" INTEGER NOT NULL,
    "defectsOnUncovered" INTEGER NOT NULL,
    "escapedRateCovered" DOUBLE PRECISION,
    "escapedRateUncovered" DOUBLE PRECISION,
    "verdict" TEXT NOT NULL,
    "verdictDetail" TEXT NOT NULL,
    "minimumDefects" INTEGER NOT NULL,
    "defectSource" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidityBacktest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "suiteId" TEXT,
    "runId" TEXT,
    "faultCount" INTEGER NOT NULL,
    "detectedCount" INTEGER,
    "missedCount" INTEGER,
    "notExercisedCount" INTEGER,
    "baselineCleanBefore" BOOLEAN NOT NULL,
    "baselineCleanAfter" BOOLEAN,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "caveats" JSONB NOT NULL DEFAULT '[]',
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenchmarkRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkFaultResult" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "benchmarkRunId" TEXT NOT NULL,
    "faultId" TEXT NOT NULL,
    "faultClass" TEXT NOT NULL,
    "surfaceItemKey" TEXT,
    "outcome" "FaultDetectionOutcome" NOT NULL,
    "detail" TEXT NOT NULL,
    "detectedByTestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenchmarkFaultResult_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateIndex
CREATE UNIQUE INDEX "CoverageItemState_itemId_stateKey_key" ON "CoverageItemState"("itemId", "stateKey");

-- CreateIndex
CREATE INDEX "CoverageItemState_orgId_idx" ON "CoverageItemState"("orgId");

-- CreateIndex
CREATE INDEX "CoverageItemState_itemId_kind_idx" ON "CoverageItemState"("itemId", "kind");

-- CreateIndex
-- The per-dimension denominator. The dimension is DERIVED from "kind" through
-- CELL_KIND_DIMENSION in @qaai/shared, so the reader filters `kind IN (…)` from
-- that record rather than storing the dimension twice and letting the two
-- disagree about a row.
CREATE INDEX "CoverageItemState_projectId_kind_retiredAt_idx" ON "CoverageItemState"("projectId", "kind", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageFormField_itemId_fieldKey_key" ON "CoverageFormField"("itemId", "fieldKey");

-- CreateIndex
CREATE INDEX "CoverageFormField_orgId_idx" ON "CoverageFormField"("orgId");

-- CreateIndex
CREATE INDEX "CoverageFormField_itemId_kind_idx" ON "CoverageFormField"("itemId", "kind");

-- CreateIndex
CREATE INDEX "CoverageFormField_projectId_kind_retiredAt_idx" ON "CoverageFormField"("projectId", "kind", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageTypeObligation_itemId_testType_key" ON "CoverageTypeObligation"("itemId", "testType");

-- CreateIndex
CREATE INDEX "CoverageTypeObligation_orgId_idx" ON "CoverageTypeObligation"("orgId");

-- CreateIndex
-- "every route that owes an ACCESSIBILITY test, and which of them have one" —
-- the read that makes the sentence sayable.
CREATE INDEX "CoverageTypeObligation_projectId_testType_retiredAt_idx" ON "CoverageTypeObligation"("projectId", "testType", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageRollup_snapshotId_scopeKey_key" ON "CoverageRollup"("snapshotId", "scopeKey");

-- CreateIndex
CREATE INDEX "CoverageRollup_orgId_idx" ON "CoverageRollup"("orgId");

-- CreateIndex
CREATE INDEX "CoverageRollup_projectId_scopeKey_createdAt_idx" ON "CoverageRollup"("projectId", "scopeKey", "createdAt");

-- CreateIndex
CREATE INDEX "CoverageRollup_projectId_dimension_createdAt_idx" ON "CoverageRollup"("projectId", "dimension", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageHistory_snapshotId_scopeKey_key" ON "CoverageHistory"("snapshotId", "scopeKey");

-- CreateIndex
CREATE INDEX "CoverageHistory_orgId_idx" ON "CoverageHistory"("orgId");

-- CreateIndex
CREATE INDEX "CoverageHistory_projectId_scopeKey_createdAt_idx" ON "CoverageHistory"("projectId", "scopeKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentCapability_deploymentKey_testType_key" ON "DeploymentCapability"("deploymentKey", "testType");

-- CreateIndex
CREATE INDEX "DeploymentCapability_orgId_idx" ON "DeploymentCapability"("orgId");

-- CreateIndex
CREATE INDEX "DeploymentCapability_deploymentKey_status_idx" ON "DeploymentCapability"("deploymentKey", "status");

-- CreateIndex
-- One attestation per claim per project. Re-exporting an unchanged measurement
-- returns the same row rather than minting a second document that says the same
-- thing with a different id, which is what makes "is this the PDF you were
-- sent?" answerable.
CREATE UNIQUE INDEX "CoverageAttestation_projectId_fingerprint_key" ON "CoverageAttestation"("projectId", "fingerprint");

-- CreateIndex
CREATE INDEX "CoverageAttestation_orgId_idx" ON "CoverageAttestation"("orgId");

-- CreateIndex
CREATE INDEX "CoverageAttestation_projectId_issuedAt_idx" ON "CoverageAttestation"("projectId", "issuedAt");

-- CreateIndex
CREATE INDEX "ValidityBacktest_orgId_idx" ON "ValidityBacktest"("orgId");

-- CreateIndex
CREATE INDEX "ValidityBacktest_projectId_createdAt_idx" ON "ValidityBacktest"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "BenchmarkRun_orgId_idx" ON "BenchmarkRun"("orgId");

-- CreateIndex
CREATE INDEX "BenchmarkRun_projectId_createdAt_idx" ON "BenchmarkRun"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BenchmarkFaultResult_benchmarkRunId_faultId_key" ON "BenchmarkFaultResult"("benchmarkRunId", "faultId");

-- CreateIndex
CREATE INDEX "BenchmarkFaultResult_orgId_idx" ON "BenchmarkFaultResult"("orgId");

-- CreateIndex
-- "the detection rate per fault class" — the only honest shape of that number.
-- One blended percentage is a marketing figure; "we catch 90% of broken
-- validations and 20% of silent failures" is a finding a team acts on.
CREATE INDEX "BenchmarkFaultResult_benchmarkRunId_faultClass_idx" ON "BenchmarkFaultResult"("benchmarkRunId", "faultClass");

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Foreign keys
-- ─────────────────────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "CoverageItemState" ADD CONSTRAINT "CoverageItemState_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CoverageItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageFormField" ADD CONSTRAINT "CoverageFormField_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CoverageItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageTypeObligation" ADD CONSTRAINT "CoverageTypeObligation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CoverageItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageRollup" ADD CONSTRAINT "CoverageRollup_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CoverageSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageHistory" ADD CONSTRAINT "CoverageHistory_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CoverageSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageAttestation" ADD CONSTRAINT "CoverageAttestation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidityBacktest" ADD CONSTRAINT "ValidityBacktest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkRun" ADD CONSTRAINT "BenchmarkRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkFaultResult" ADD CONSTRAINT "BenchmarkFaultResult_benchmarkRunId_fkey" FOREIGN KEY ("benchmarkRunId") REFERENCES "BenchmarkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
