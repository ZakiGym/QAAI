-- The enumeration denominator: name the invisible, make the axes countable,
-- give a production crawl an auditable scope, and stop a truncated or degraded
-- crawl from quietly raising the coverage percentage.
--
-- WHY THIS EXISTS
--
-- QAAI's whole product is one sentence: "your app has 412 routes, 25 are
-- covered, here are the 387." Every competitor's denominator is something
-- already touched — mabl crawls a[href] with a 500-page cap, Cypress counts the
-- DOM elements its own tests reached, Meticulous replays recorded sessions — so
-- a surface nothing has ever touched is not merely uncovered for them, it is
-- invisible. That sentence is only worth saying if it is TRUE, and five
-- separate things made it false:
--
--   1. ABSENT WAS NOT UNCOVERED. There was no way to record a surface nothing
--      can crawl: a background job, an outbound email, a webhook receiver, a
--      feature flag, a role, a locale, an error path, a download. "CoverageItem"
--      could only be declared by a source detector or by a crawl, so everything
--      neither can see was missing from the denominator rather than named in
--      it. Absent and uncovered are OPPOSITE facts — absent flatters the
--      number, uncovered lowers it — and we were silently taking the flattering
--      one on the hardest third of every application.
--   2. THE AXES WERE STRINGS IN A BLOB. Roles, locales, devices, flags, jobs
--      and emails existed only as strings inside JSONB: `requiresRoles` on a
--      flow node (which nothing ever writes a value into), a locale list in a
--      spec, a device name in a test title. A string in a blob cannot be
--      listed, counted, scoped or traced to a declarer, so "route × role ×
--      locale" was not a denominator. There was nothing to divide by.
--   3. A PRODUCTION CRAWL HAD NO AUDITABLE SCOPE. `CrawlOptions.excludePatterns`
--      has existed in packages/agent/src/crawler.ts since the beginning and is
--      passed by NO caller, so the scope of a production crawl is five regexes
--      hard-coded in that file. Nothing a customer can read, review or change —
--      which is a problem a security reviewer cannot sign off, not merely an
--      honesty problem.
--   4. CAPS APPLIED WITHOUT BEING DISCLOSED. `maxPages` set one sentence on
--      "truncatedReason" and discarded the queue. `maxDepth` dropped links with
--      no record that a link was dropped. The five default exclusions refused
--      /logout, /delete-*, /destroy and __reset and wrote NOTHING, so a route we
--      refused and a route the application does not serve were indistinguishable
--      afterwards. A 20-button `slice(0, 20)` and a 40-journey limit were
--      anonymous integers. Every one of those caps is a lever that makes the
--      coverage percentage go UP, because truncating shrinks the denominator
--      while the numerator — the tests that already exist — does not.
--   5. A DEGRADED CRAWL REPLACED THE DENOMINATOR. A crawl run while the site
--      was down, rate-limited or logged out returned a small graph, was written
--      as the newest version, and every reader picked it up. The percentage
--      improved on the day the customer's environment fell over and nobody was
--      told.
--
-- WHY `derivedFrom` AND `acceptance` ARE COLUMNS AND NOT GRAPH JSON
--
-- Because they are the WHERE clause of a correct read, and 13 of the 16 flow-map
-- readers in this repo are
-- `findFirst({ where: { projectId }, orderBy: { version: 'desc' } })` — no
-- environment filter, no provenance filter. That produces two wrong answers
-- that look exactly like a right one: a staging crawl at v9 becomes the map a
-- PRODUCTION coverage number is computed from, and `flowMapFromSource` in
-- apps/worker/src/processors/analyze-source.ts writes a map derived from the
-- REPOSITORY with its own version number, so a source-derived map at v9
-- displaces a real crawl at v8 and the denominator becomes "whatever the route
-- table says" with no forms, no states and no affordances. Neither is fixable
-- at the read site, because there was nothing on the row to filter by.
-- `selectFlowMap` in packages/shared/src/flow-map.ts ranks an OBSERVED map
-- above a DECLARED one REGARDLESS OF VERSION: a version is a sequence number,
-- not evidence.
--
-- WHY `atLeastMoreUrls` IS THE MOST IMPORTANT COLUMN HERE
--
-- Because it is the difference between "stopped early" and "at least 240 more
-- in-scope URLs existed". The first is a shrug; the second is a number that
-- tells a reader how wrong the percentage is. It is `unvisitedQueued +
-- beyondDepth` — URLs the crawl actually held in a queue or actually saw past
-- the depth limit — so it is a FLOOR and not an estimate. Refused URLs are
-- deliberately NOT in it (they are known by name, in the graph's exclusion
-- ledger), off-origin URLs are not this application's surface, and unreachable
-- URLs are unknown rather than absent. Inventing a number in the alarming
-- direction is the same sin as inventing one in the flattering direction.
--
-- WHY FOUR NEW ENUMS AND NOT SIX
--
-- "SurfaceSource", "SurfaceExercisability", "SurfaceDimensionKind" and
-- "CrawlAcceptanceState" are closed vocabularies that a reader FILTERS on, so
-- they earn a database type and an entry in apps/api/scripts/check-enums.ts
-- (a new Prisma enum with no entry there is an enum with no drift guard, which
-- is how five TestType members once sat un-migrated and invisible until a row
-- was written). "FlowMap"."convergence" and
-- "CoverageItem"."unexercisableReason" are TEXT instead, following
-- "Project"."closureApprovalPolicy" and "MutationSurvivor"."reason": they are
-- rendered rather than filtered, their domain is enforced at the producer, and
-- a fifth and sixth enum whose only purpose is to need a guard is not a win.
--
-- WHY `sources` IS NULLABLE AND `origin` STAYS
--
-- Three states, and they are the same three "FormField"'s constraint capture
-- established: NULL means this row predates the column and nobody recorded a
-- declarer, a list is the fact, and there is deliberately no empty-list state
-- because an item that exists was declared by something. `origin` (the old
-- two-source summary) stays because 16 readers group and order by it, and it is
-- now DERIVED from `sources` by `originFromSources` — never set independently,
-- or an item's two provenance fields disagree and only one of them is on screen.
--
-- The same three-state rule governs `exercisability`. NULL means nobody
-- classified the item, and `exercisabilityCounts` in
-- packages/shared/src/surface.ts deliberately COUNTS that case. Reading "not
-- classified" as "not allowed to drive" would hold most of an existing
-- install's denominator out on the day of this deploy, and the percentage would
-- jump with nothing anywhere to explain why.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- Four CREATE TYPEs. A new enum type takes no lock on any table.
--
-- Fifteen ADD COLUMNs across four tables — "CoverageItem" (7), "FlowMap" (6),
-- "Environment" (1) — and EVERY ONE is nullable with no default. PostgreSQL
-- records the attribute in the catalogue and touches no row, so none of these
-- is a rewrite. "CoverageItem" is the one that matters: it holds a row per
-- testable thing per project, which is the largest table this change goes
-- anywhere near, and a DEFAULT on a JSONB column there would be the difference
-- between a migration and an outage. (PostgreSQL 11+ would in fact store a
-- non-volatile default in `pg_attribute.atthasmissing` and materialise it on
-- read, as 20261024030000_triage_per_cause relies on — but nullable is also the
-- CORRECT semantics here, so there is nothing to trade off.)
--
-- One CREATE TABLE plus three indexes, all built on an empty relation. Its
-- foreign key is declared on the CHILD, so it takes no lock on "Project"'s rows
-- and validates against an empty table.
--
-- Three CREATE INDEXes on existing tables. These are the only statements here
-- that read data. Plain CREATE INDEX takes a ShareLock and blocks writes to the
-- table for the duration; on an install where "CoverageItem" is large enough to
-- notice, run those three by hand as CREATE INDEX CONCURRENTLY (which cannot
-- run inside the transaction `prisma migrate deploy` wraps this in) and then
-- mark the migration applied. Both index targets are small-cardinality columns
-- on which the planner would otherwise have no choice but a sequential scan.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- CreateEnum
CREATE TYPE "SurfaceSource" AS ENUM ('CRAWL', 'SOURCE', 'SITEMAP', 'OPENAPI', 'TRAFFIC', 'REQUIREMENT', 'MANUAL', 'CATALOGUE');

-- CreateEnum
CREATE TYPE "SurfaceExercisability" AS ENUM ('EXERCISABLE', 'UNEXERCISABLE', 'REFUSED');

-- CreateEnum
CREATE TYPE "SurfaceDimensionKind" AS ENUM ('ROLE', 'LOCALE', 'DEVICE', 'FLAG', 'JOB', 'EMAIL');

-- CreateEnum
CREATE TYPE "CrawlAcceptanceState" AS ENUM ('ACCEPTED', 'CANDIDATE', 'REJECTED');

-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "crawlPolicy" JSONB;

-- AlterTable
ALTER TABLE "CoverageItem" ADD COLUMN     "coordinates" JSONB,
ADD COLUMN     "environmentId" TEXT,
ADD COLUMN     "exerciseDetail" TEXT,
ADD COLUMN     "exercisability" "SurfaceExercisability",
ADD COLUMN     "refusedByRule" TEXT,
ADD COLUMN     "sources" JSONB,
ADD COLUMN     "unexercisableReason" TEXT;

-- AlterTable
ALTER TABLE "FlowMap" ADD COLUMN     "acceptance" "CrawlAcceptanceState",
ADD COLUMN     "acceptanceReason" TEXT,
ADD COLUMN     "atLeastMoreUrls" INTEGER,
ADD COLUMN     "convergence" TEXT,
ADD COLUMN     "derivedFrom" "SurfaceSource",
ADD COLUMN     "excludedCount" INTEGER,
ADD COLUMN     "policyApplied" JSONB;

-- CreateTable
CREATE TABLE "SurfaceDimension" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "SurfaceDimensionKind" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "source" "SurfaceSource" NOT NULL,
    "evidence" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "detail" JSONB NOT NULL,
    "file" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "SurfaceDimension_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- THE IDENTITY. One row per value per dimension per project, which is also what
-- makes the reader's upsert idempotent when two extractors find the same role.
-- `key` holds the APPLICATION's own spelling and is never case-folded: a role
-- the app calls `Admin` and one it calls `admin` are two roles until the
-- customer says otherwise, and folding them here would merge two cells and
-- shrink a denominator with nothing to show for it.
CREATE UNIQUE INDEX "SurfaceDimension_projectId_kind_key_key" ON "SurfaceDimension"("projectId", "kind", "key");

-- CreateIndex
CREATE INDEX "SurfaceDimension_orgId_idx" ON "SurfaceDimension"("orgId");

-- CreateIndex
-- "Every role in this project" — the per-dimension list, and the input to every
-- pairing count in `dimensionDenominator`.
CREATE INDEX "SurfaceDimension_projectId_kind_idx" ON "SurfaceDimension"("projectId", "kind");

-- AddForeignKey
ALTER TABLE "SurfaceDimension" ADD CONSTRAINT "SurfaceDimension_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- The environment-scoped denominator: "every item that applies to THIS
-- environment". `environmentId` is NULL for the source-declared majority and a
-- btree indexes nulls, so the `environmentId IS NULL OR environmentId = $1`
-- that a correct reader writes is answered from here rather than from a scan.
CREATE INDEX "CoverageItem_projectId_environmentId_idx" ON "CoverageItem"("projectId", "environmentId");

-- CreateIndex
-- The two held-out lists the dark-surface report prints BY NAME: "give us a
-- disposable account and we will test these 14", and "your crawl policy refused
-- these 31". Both are small slices of the largest table in the coverage
-- feature, and the second sentence is the only place a reader ever learns that
-- a refusal happened at all.
CREATE INDEX "CoverageItem_projectId_exercisability_idx" ON "CoverageItem"("projectId", "exercisability");

-- CreateIndex
-- THE CORRECT FLOW-MAP READ, which no reader can currently make.
--
-- ("projectId", "environmentId") are equalities on every correct read — an
-- environment filter is a MATCH and not a preference, because a staging crawl
-- is not a weaker measurement of production but a measurement of something
-- else. "acceptance" is the third equality (or a short IN list), and "version"
-- comes last so the btree supplies the ORDER BY scanned backwards and the LIMIT
-- stops early. "FlowMap_projectId_environmentId_version_key" cannot serve this:
-- it has no "acceptance", so filtering on it means reading every version of the
-- environment and sorting in memory.
CREATE INDEX "FlowMap_projectId_environmentId_acceptance_version_idx" ON "FlowMap"("projectId", "environmentId", "acceptance", "version");

-- ─────────────────────────────────────────────────────────────────────────────
-- REVERSING THIS, if the deploy has to be undone.
--
-- Order matters: drop the indexes and the table before the types, or the
-- DROP TYPE fails with a dependency error.
--
-- Nothing below is destructive to pre-existing data — every column dropped was
-- added by this migration and every row that carried a value in one was written
-- after it. The one thing that IS lost is the enumeration accounting itself:
-- after a revert, a truncated crawl is again indistinguishable from a complete
-- one and a degraded crawl is again promoted over a good one. Re-crawl after
-- re-applying rather than trusting the `acceptance` of a map that was written
-- while these columns did not exist.
--
--   DROP INDEX "FlowMap_projectId_environmentId_acceptance_version_idx";
--   DROP INDEX "CoverageItem_projectId_exercisability_idx";
--   DROP INDEX "CoverageItem_projectId_environmentId_idx";
--
--   ALTER TABLE "SurfaceDimension" DROP CONSTRAINT "SurfaceDimension_projectId_fkey";
--   DROP TABLE "SurfaceDimension";
--
--   ALTER TABLE "FlowMap"
--     DROP COLUMN "policyApplied",
--     DROP COLUMN "excludedCount",
--     DROP COLUMN "derivedFrom",
--     DROP COLUMN "convergence",
--     DROP COLUMN "atLeastMoreUrls",
--     DROP COLUMN "acceptanceReason",
--     DROP COLUMN "acceptance";
--
--   ALTER TABLE "CoverageItem"
--     DROP COLUMN "unexercisableReason",
--     DROP COLUMN "sources",
--     DROP COLUMN "refusedByRule",
--     DROP COLUMN "exercisability",
--     DROP COLUMN "exerciseDetail",
--     DROP COLUMN "environmentId",
--     DROP COLUMN "coordinates";
--
--   ALTER TABLE "Environment" DROP COLUMN "crawlPolicy";
--
--   DROP TYPE "CrawlAcceptanceState";
--   DROP TYPE "SurfaceDimensionKind";
--   DROP TYPE "SurfaceExercisability";
--   DROP TYPE "SurfaceSource";
--
-- `prisma migrate resolve --rolled-back 20261024070000_enumeration_denominator`
-- then clears the failed-migration marker. NOT a `--roll-forward`: that marks
-- the migration applied without running anything, which on a database where
-- these statements did not execute leaves Prisma's client generating queries
-- against columns that do not exist.
