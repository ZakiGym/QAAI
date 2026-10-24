-- Bind a role to a test: the auth profile a test executes as.
--
-- WHY THIS EXISTS
--
-- A session was chosen per RUN and never per test, so an admin test and a
-- member test could not sit in the same suite. Role-differentiated testing was
-- not merely unsupported, it was inexpressible — PlanItem.authProfileId has
-- existed since the init migration and every producer wrote NULL into it,
-- because there was nowhere on Test for the value to land.
--
-- It also closed a loop in coverage analysis. The UNREACHED_AUTH_ROUTE gap
-- ("no authenticated test reaches /admin/users") could only be answered with a
-- test that asserts anonymous denial, which does not reach the page, so the
-- gap was re-reported on the next analysis for ever. Two columns is what makes
-- that loop converge.
--
-- WHY TWO COLUMNS AND NOT ONE
--
-- "authProfileId" is the BINDING. "authProfileRequired" is the INTENT, and it
-- is a separate column precisely so that the foreign key below can be
-- ON DELETE SET NULL without the result being silent.
--
--   Cascade  — deleting a stale auth profile would delete the customer's
--              tests. The code is the asset; the session is a credential.
--              Never.
--   Restrict — "delete this profile" becomes an error no customer can clear
--              without hunting down every test that references it by hand.
--   SetNull  — correct for the binding, and on its own the worst of the three
--              for the customer: the test keeps running, anonymously, passes
--              whatever an anonymous visitor can see, and is counted as
--              coverage of a page it never reached.
--
-- So SetNull leaves (authProfileRequired = true, authProfileId = NULL) — a
-- state nothing else in the system can produce. Coverage analysis reads it as
-- NOT authenticated and names the broken binding in its evidence, which
-- re-opens the gap the test was written to close instead of quietly reporting
-- it as covered.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- Two ADD COLUMNs on "Test". Both are nullable or have a constant default, so
-- on PostgreSQL 11+ neither rewrites the table: the default is recorded in the
-- catalogue and existing rows are not touched. No backfill — every test that
-- exists today runs anonymously and NULL/false says exactly that, which is the
-- honest state for every existing install rather than a guess.
--
-- The foreign key is declared on "Test", the CHILD, so it takes no lock on
-- "AuthProfile" rows. ADD CONSTRAINT does validate the existing rows, which is
-- a scan of "Test" under a lock that blocks writes to it; the column it
-- validates was created NULL on every row a microsecond earlier, so the scan
-- finds nothing to check. On an install large enough for that to matter, split
-- the constraint into NOT VALID plus a later VALIDATE CONSTRAINT.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- AlterTable
ALTER TABLE "Test" ADD COLUMN     "authProfileId" TEXT,
ADD COLUMN     "authProfileRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
-- Both directions of "which tests run as this role?": the cockpit's filter, and
-- the read the profile-deletion path needs to tell an operator what they are
-- about to unbind. Without it either one is a full scan of every test in the
-- install.
CREATE INDEX "Test_authProfileId_idx" ON "Test"("authProfileId");

-- AddForeignKey
ALTER TABLE "Test" ADD CONSTRAINT "Test_authProfileId_fkey" FOREIGN KEY ("authProfileId") REFERENCES "AuthProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
