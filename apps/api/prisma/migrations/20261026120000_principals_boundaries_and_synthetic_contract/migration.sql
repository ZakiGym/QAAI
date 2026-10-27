-- Principals, boundary classes, and the synthetic-data contract.
--
-- WHY THIS EXISTS
--
-- Everything before this migration enumerates an application's surface and
-- measures how much of it a suite reaches. What none of it can do is write a
-- test that FINDS A BUG, and the reasons are structural rather than a matter of
-- effort:
--
--   1. ONE storageState PER RUN. So "user A can read user B's invoice" was
--      inexpressible, and the IDOR check fetched ids ANONYMOUSLY and asked
--      whether an anonymous visitor is denied -- which every application gets
--      right. Invite-and-accept and submit-and-approve had no second actor to
--      be. Nothing could sweep the enumerated endpoints with tenant A's token
--      against tenant B's ids, which is the bug class that ends a company.
--
--   2. ONE SHARED ACCOUNT, SO `/logout` WAS SKIP-LISTED. Logout, session
--      expiry, signup, password reset, email verification and lockout -- the
--      highest-risk flows any application has -- were never driven, because
--      driving any of them against the only way in destroys the only way in.
--      So the most dangerous flows were the only untested ones.
--
--   3. ONE WHOLE FEATURE BECAME ONE NEGATIVE TEST, derived from the FIRST
--      required field. Nothing enumerated empty, too-long, wrong-type,
--      off-by-one, Luhn-invalid or future-date. The negative half of testing
--      did not exist, and the positive half is the half that finds no bugs.
--
-- This migration adds the vocabulary for all three. It adds NO TABLE: every
-- column lands on a model that already has a read path, because a correct
-- Prisma model connected to nothing is this codebase's signature defect and
-- three keystones in a row shipped one.
--
-- WRITTEN BY HAND. `prisma migrate dev` was not run (no database is reachable
-- here and the round's rules forbid it), so this file is hand-authored against
-- a `prisma validate`-clean schema rather than generated. It has NOT been
-- applied -- `check-enums.ts` will report the two new types as declared and
-- absent from the live database until `prisma migrate deploy` runs, which is
-- the correct and honest reading of an undeployed migration.

-- CreateEnum
--
-- May a scenario destroy this identity? Three members and not a boolean:
-- ANONYMOUS has no account to destroy, so both booleans are lies about it, and
-- collapsing that distinction files an UNEXERCISABLE surface as an exercisable
-- one.
CREATE TYPE "PrincipalKind" AS ENUM ('PERSISTENT', 'DISPOSABLE', 'ANONYMOUS');

-- CreateEnum
--
-- Where a principal is in its life. Three of the ten exist purely to stop a
-- lie: PROVISION_FAILED is not DECLARED (a check that did not happen is not a
-- check that has not happened yet), DESTRUCTION_REFUSED is not ACTIVE (the
-- principal is intact and the scenario did NOT run), and UNAVAILABLE is not
-- PROVISION_FAILED (bot protection is a customer configuration with its own
-- remedy, not a failure).
CREATE TYPE "PrincipalLifecycle" AS ENUM ('DECLARED', 'PROVISIONING', 'PROVISION_FAILED', 'ACTIVE', 'SIGNED_OUT', 'SESSION_EXPIRED', 'LOCKED_OUT', 'DESTROYED', 'DESTRUCTION_REFUSED', 'UNAVAILABLE');

-- AlterTable
--
-- DEFAULT 'PERSISTENT' IS THE WHOLE SAFETY STORY OF THIS MIGRATION. Every row
-- that exists today is the customer's own account, so PERSISTENT is the only
-- correct back-fill -- and the two mistakes do not cost the same. Wrongly
-- marking the customer's account disposable costs them their production login;
-- wrongly marking a throwaway persistent costs one scenario reported as
-- UNEXERCISABLE with a remedy printed beside it. The default is the one whose
-- failure is cheap. A later migration must NEVER back-fill DISPOSABLE onto
-- existing rows.
ALTER TABLE "AuthProfile" ADD COLUMN "principalKind" "PrincipalKind" NOT NULL DEFAULT 'PERSISTENT';
-- ACTIVE, because a profile that exists and holds a storageState is by
-- definition one we have signed in as.
ALTER TABLE "AuthProfile" ADD COLUMN "principalLifecycle" "PrincipalLifecycle" NOT NULL DEFAULT 'ACTIVE';
-- Nullable with no default, and it stays null on every PERSISTENT row for
-- ever: nothing created them. `proveDisposable` REQUIRES this column to be
-- non-empty, because "disposable" with no creator is a claim nobody made --
-- the fastest way to delete the customer's account is to copy the shared
-- session into a new profile and label it DISPOSABLE.
ALTER TABLE "AuthProfile" ADD COLUMN "createdByScenario" TEXT;
ALTER TABLE "AuthProfile" ADD COLUMN "disposedAt" TIMESTAMP(3);
-- The tenant as the APPLICATION UNDER TEST spells it. Null is NOT a tenant:
-- the cross-tenant sweep refuses with NO_TENANCY rather than comparing null
-- against null and reporting that no leakage was found.
ALTER TABLE "AuthProfile" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AuthProfile" ADD COLUMN "tenantLabel" TEXT;

-- AlterTable
--
-- The actors a test needs when one identity is not enough. Json and not a join
-- table: a principal is SCENARIO-LOCAL -- a name the test uses for an actor,
-- with no identity or lifetime outside it -- and a join table would invite two
-- tests to share a disposable principal, which is one destructive scenario
-- destroying another test's actor mid-run.
ALTER TABLE "Test" ADD COLUMN "principals" JSONB;

-- AlterTable
ALTER TABLE "PlanItem" ADD COLUMN "principals" JSONB;
-- The boundary class this item attacks, or null for a positive-path item.
-- TEXT and not an enum on the same judgement as `PlanItem.gapKind`: nothing
-- filters rows on it, so an enum would be one more Postgres type whose only
-- job is to need a drift guard. The domain is enforced at the producer by
-- `boundaryClassSchema`.
ALTER TABLE "PlanItem" ADD COLUMN "boundaryClass" TEXT;

-- CreateIndex
--
-- "Is there a disposable identity in this environment?" -- the read every
-- destructive scenario makes before it will run at all, and the answer decides
-- whether it runs or is recorded as UNEXERCISABLE. Without this it is a scan of
-- every profile in the install, once per scenario.
CREATE INDEX "AuthProfile_environmentId_principalKind_idx" ON "AuthProfile"("environmentId", "principalKind");

-- CreateIndex
--
-- "Which identities belong to the other tenant?" -- the cross-tenant sweep's
-- own query, once per sweep per tenant pair.
CREATE INDEX "AuthProfile_tenantId_idx" ON "AuthProfile"("tenantId");
