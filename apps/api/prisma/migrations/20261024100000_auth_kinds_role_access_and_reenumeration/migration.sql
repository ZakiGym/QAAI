-- The wall at the edge of the map: the identities QAAI can be, whether it can
-- reach the door at all, what each identity was allowed to see, and what makes
-- any of it happen again tomorrow.
--
-- WHY THIS EXISTS
--
-- 20261024070000 gave the surface registry provenance and 20261024090000 added
-- the sources that declare what no crawl can reach. Both answer "what exists".
-- Neither answers the question that decides whether any of it is REACHABLE:
-- who is asking. Six absences, each of which made a specific sentence
-- unsayable, and each of which read on screen as an application with very
-- little behind its login rather than as a measurement that never happened.
--
--   1. AN APP WHOSE LOGIN IS HARDER THAN A FORM HAD ZERO ENUMERABLE
--      AUTHENTICATED SURFACE. "AuthProfileKind" has named MAGIC_LINK and
--      TOTP_MFA since the beginning and `signInWithProfile` honoured THREE
--      kinds, answering the rest with "needs the mail catcher / TOTP support
--      that is not built yet". So the UI could STORE a kind the login module
--      could not perform — and a passkey app, an SMS-code app and an
--      SSO-fronted app could not even be described. PASSKEY, PHONE_OTP and
--      MOCK_IDP are those three classes of customer.
--   2. THERE WAS NO ROLE AXIS AT ALL. `authProfile.findFirst({ orderBy:
--      createdAt asc })` picks ONE identity for a whole crawl and
--      `FlowNode.requiresRoles` is set to `[]` unconditionally, so "a member
--      gets 403 on /admin" has never been expressible and authorization
--      coverage had no denominator. A 403 is not an absence of surface; it is
--      the correct behaviour OF a surface, and the most expensive defect class
--      a web application has lives exactly there. "RouteAccessCell" is that
--      denominator, and "AuthProfile"."role" is the axis it is indexed on.
--   3. A FAILED LOGIN AND AN EMPTY CRAWL WERE THE SAME ROW — which is to say,
--      no row. Both produce zero cells, so "the admin crawl found no routes a
--      member cannot see" was indistinguishable from "we could not sign in as
--      admin". Those are opposite facts and only one of them is the customer's
--      problem. "RoleCrawlAttempt" is the difference.
--   4. AN APP BEHIND A BOT DEFENCE WAS UNREACHABLE BY EVERY PROFILE KIND AT
--      ONCE and was reported as an application with nothing in it. A reCAPTCHA
--      on the login form means coverage is zero for a reason that has nothing
--      to do with the customer's tests, and "EnvironmentAccess" is where that
--      reason and its remedy live. Nothing in this migration defeats, solves or
--      evades a challenge: every "BotBypassMode" is an action the OWNER of the
--      environment took on their own system.
--   5. THE ONLY CRAWL TRIGGER WAS A HUMAN CLICKING A BUTTON. "Schedule" and
--      "Monitor" both exist and both can only run a SUITE, so nothing
--      re-enumerates on its own: the application grows four routes, the
--      denominator does not, and the coverage percentage RISES. It fails
--      silently and in the flattering direction, which for a product whose
--      whole claim is the denominator is the worst available failure.
--      "ReEnumerationTrigger" is the fix, and NEVER_RUN is stored rather than
--      inferred from a null timestamp a dashboard would render as a clean bill
--      of health.
--   6. CRAWL VERSIONS WERE CLAIMED TO BE DIFFED AND NO DIFF CODE EXISTED.
--      "FlowMap"."version" has been there since the beginning and the cockpit
--      implies the comparison; four new routes with zero tests produced no
--      event at all. "SurfaceDriftRecord" holds the result, and every count on
--      it is NULLABLE because 0 is the value that means "nothing new is
--      untested" and is indistinguishable, once written, from "we never
--      looked".
--
-- THE HONESTY RULES THIS DDL ENCODES, STATED ONCE
--
--   · "RouteAccessCell"."outcome" and ."basis" HAVE NO DEFAULT. A default of
--     ALLOWED would be the lie. A default of NOT_PROBED would let a buggy
--     writer drop a real probe's result and have it read as "we did not ask",
--     which hides the bug instead of surfacing it. With no default the INSERT
--     fails and somebody finds out.
--   · Every count that describes a measurement is NULLABLE and is never
--     DEFAULT 0: "RoleCrawlAttempt"."routesReached", ."routesNewToThisRole",
--     ."atLeastMoreRoutes" and all six counts on "SurfaceDriftRecord". The one
--     count that IS defaulted to 0 is
--     "ReEnumerationTrigger"."consecutiveFailures", because that is a tally of
--     events we caused and not a measurement of the customer's application.
--   · "RouteAccessCell"."role" is NOT NULL and anonymous is spelled
--     '<anonymous>'. A nullable role would break the unique index in the
--     quietest possible way — PostgreSQL treats every NULL as distinct, so the
--     one cell that matters most, what a logged-out visitor gets on /admin,
--     would be re-inserted on every crawl and counted once per crawl.
--   · "EnvironmentAccess" is 1:1 and OPTIONAL. An environment with no row has
--     made no claim; a column set on "Environment" would have had to encode
--     that as provider = NONE, which is a positive assertion that nothing is in
--     the way. The absence of the row is NOT_PROBED.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- CATALOGUE-ONLY IN BOTH DIRECTIONS. There is no table rewrite anywhere in this
-- migration and no row of any existing table is read or written. Specifically:
--
-- NINE CREATE TYPEs. A new enum type takes no lock on any table.
--
-- THREE ALTER TYPE "AuthProfileKind" ADD VALUE. Catalogue-only, no lock on
-- "AuthProfile", and no rewrite — a Postgres enum column stores an OID and
-- adding a label does not touch the heap. REQUIRES POSTGRESQL 12 OR LATER,
-- which is the one version floor in this file and is worth naming: before 12,
-- ALTER TYPE ... ADD VALUE could not run inside a transaction block at all, and
-- `prisma migrate deploy` wraps each migration in one. On 12+ it is allowed
-- provided the new label is not USED in the same transaction, and none of the
-- three is: nothing below defaults to, casts to, or inserts PASSKEY, PHONE_OTP
-- or MOCK_IDP. Do not add such a statement to this file — it would fail with
-- "unsafe use of new value of enum type" on every deploy.
--
-- ONE ALTER TABLE "AuthProfile" ADD COLUMN "role" TEXT. NULLABLE WITH NO
-- DEFAULT, which since PostgreSQL 11 is a catalogue update and not a rewrite,
-- and which here is also the semantically correct choice: null means "nobody
-- said what this profile is", and that must not be read as anonymous. This is
-- the ONLY statement in the file that touches a pre-existing table's
-- definition. It takes ACCESS EXCLUSIVE on "AuthProfile" for the duration of a
-- catalogue update — microseconds on any real table, and "AuthProfile" is one
-- row per configured identity per environment.
--
-- FIVE CREATE TABLEs with their indexes and foreign keys. Every one is built on
-- an EMPTY relation: the tables do not exist until this statement, so their
-- indexes index nothing and their foreign-key constraints validate against no
-- rows. Each foreign key is declared on the CHILD, so adding it takes SHARE
-- ROW EXCLUSIVE on the parent — it blocks concurrent WRITES to the parent for
-- the duration of that one statement, permits reads throughout, and NEVER scans
-- or rewrites the parent's rows. The parents touched that way are "Project",
-- "Environment", "AuthProfile", "FlowMap" and "CoverageItem".
--
-- TWO FOREIGN KEYS POINT AT "FlowMap" FROM THE SAME TABLE
-- ("SurfaceDriftRecord"."currentFlowMapId" and ."baselineFlowMapId"), which is
-- why the schema names those relations "SurfaceDriftCurrent" and
-- "SurfaceDriftBaseline". The names are Prisma-side only and produce no SQL;
-- the constraint names below are Prisma's defaults, derived from the COLUMN,
-- and both are comfortably inside PostgreSQL's 63-byte identifier limit. Every
-- identifier in this file was checked against that limit — the longest is
-- "RouteAccessCell_environmentId_routeTemplate_role_key" at 52 bytes — because
-- PostgreSQL TRUNCATES silently, and a truncated name is one Prisma's
-- introspection will disagree with for ever.
--
-- THE DELETE BEHAVIOURS, AND WHY THEY DIFFER
--
--   CASCADE   on "Project", "Environment" and
--             "SurfaceDriftRecord"."currentFlowMapId". A cell, an attempt, a
--             trigger or a diff has no meaning without the environment it is
--             about, and a drift record has none without the map it describes.
--   SET NULL  on "AuthProfile", "CoverageItem", "RoleCrawlAttempt",
--             "ReEnumerationTrigger", "FlowMap"."lastFlowMapId" and
--             "SurfaceDriftRecord"."baselineFlowMapId". Same argument as
--             "Test"."authProfileId": deleting a profile must not delete the
--             EVIDENCE of what that identity was allowed to see, and deleting
--             an old map must not delete the record that it was once a
--             baseline. The reading afterwards is "this was measured and we no
--             longer know by whom", which is weaker than the original fact and
--             strictly better than its absence.
--
-- WHERE EACH OF THE FIVE TABLES IS READ AND WRITTEN
--
-- All five are minted here and ALL FIVE HAVE BOTH A WRITER AND A READER, in
-- files this migration does not own but which land in the same round. An
-- earlier draft of this section said the opposite — that none of them was wired
-- and that `scripts/check-wiring.ts` would report FIVE DISCONNECTED MODELS — and
-- it is recorded here as having been wrong rather than deleted, because the
-- next person to read it would otherwise go looking for five warnings that are
-- not there and conclude the check had stopped working. `check-wiring` reports
-- 0 disconnected and exactly 4 pre-existing known gaps, none of them from this
-- migration. The doors, so the claim is checkable:
--
--   "RouteAccessCell"       written by apps/worker/src/processors/explore.ts
--                           (upsert, guarded by `shouldReplaceCell`), read by
--                           the GET .../access route in apps/api/src/routes/agent.ts.
--   "RoleCrawlAttempt"      written by the same processor (upsert per
--                           environment+role), read there for `staleRoleAttempts`
--                           and by the same API route.
--   "EnvironmentAccess"     written by the PUT .../access route, read by the GET.
--   "ReEnumerationTrigger"  written and read by apps/api/src/routes/agent.ts and
--                           by apps/worker/src/processors/schedule.ts.
--   "SurfaceDriftRecord"    written by apps/worker/src/processors/schedule.ts,
--                           read by apps/api/src/routes/agent.ts.
--
-- What must still not happen is any of the five being read as a measurement: an
-- empty "RouteAccessCell" is "nobody has probed the authorization axis", NOT
-- "this application has no role restrictions", and an empty
-- "SurfaceDriftRecord" is NOT "no drift".
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterEnum
--
-- The three classes of customer that had no describable login. See the header:
-- catalogue-only, PostgreSQL 12+, and nothing below may use these labels.
ALTER TYPE "AuthProfileKind" ADD VALUE 'PASSKEY';
ALTER TYPE "AuthProfileKind" ADD VALUE 'PHONE_OTP';
ALTER TYPE "AuthProfileKind" ADD VALUE 'MOCK_IDP';

-- CreateEnum
CREATE TYPE "RouteAccessOutcome" AS ENUM ('ALLOWED', 'FORBIDDEN', 'REDIRECTED_TO_LOGIN', 'REDIRECTED_ELSEWHERE', 'NOT_FOUND', 'ERRORED', 'NOT_PROBED');

-- CreateEnum
CREATE TYPE "RouteAccessBasis" AS ENUM ('OBSERVED', 'DECLARED');

-- CreateEnum
CREATE TYPE "RoleCrawlOutcome" AS ENUM ('NEVER_ATTEMPTED', 'LOGIN_UNAVAILABLE', 'LOGIN_FAILED', 'UNREACHABLE_BEHIND_BOT_PROTECTION', 'SKIPPED_BY_POLICY', 'CRAWLED_PARTIAL', 'CRAWLED');

-- CreateEnum
CREATE TYPE "BotProtectionProvider" AS ENUM ('NONE', 'RECAPTCHA', 'HCAPTCHA', 'TURNSTILE', 'WAF', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BotBypassMode" AS ENUM ('NOT_CONFIGURED', 'PROVIDER_TEST_KEYS', 'SIGNED_BYPASS_HEADER', 'ALLOWLISTED_BY_CUSTOMER');

-- CreateEnum
CREATE TYPE "EnvironmentReachability" AS ENUM ('REACHABLE', 'UNREACHABLE_BEHIND_BOT_PROTECTION', 'NOT_PROBED');

-- CreateEnum
CREATE TYPE "ReEnumerationTriggerKind" AS ENUM ('SCHEDULE', 'CI', 'DEPLOY', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReEnumerationRunState" AS ENUM ('NEVER_RUN', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SurfaceDriftComparability" AS ENUM ('COMPARABLE', 'UNCOMPARABLE_NO_BASELINE', 'UNCOMPARABLE_BASELINE_NOT_ACCEPTED', 'NOT_COMPARED');

-- AlterTable
--
-- The role axis. Nullable with no default: null is "nobody said", which is NOT
-- anonymous — `roleKey(null)` spells anonymous '<anonymous>' and that is a
-- claim about a logged-OUT visitor, the opposite of an unlabelled logged-in one.
ALTER TABLE "AuthProfile" ADD COLUMN "role" TEXT;

-- CreateTable
CREATE TABLE "RouteAccessCell" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "routeTemplate" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "outcome" "RouteAccessOutcome" NOT NULL,
    "basis" "RouteAccessBasis" NOT NULL,
    "status" INTEGER,
    "finalUrl" TEXT,
    "probedAt" TIMESTAMP(3),
    "authProfileId" TEXT,
    "attemptId" TEXT,
    "coverageItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteAccessCell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleCrawlAttempt" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "authProfileId" TEXT,
    "outcome" "RoleCrawlOutcome" NOT NULL,
    "detail" TEXT,
    "remedy" TEXT,
    "attemptedAt" TIMESTAMP(3),
    "flowMapId" TEXT,
    "routesReached" INTEGER,
    "routesNewToThisRole" INTEGER,
    "cappedBy" TEXT,
    "atLeastMoreRoutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleCrawlAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvironmentAccess" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "provider" "BotProtectionProvider" NOT NULL DEFAULT 'UNKNOWN',
    "bypassMode" "BotBypassMode" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "bypassHeaderName" TEXT,
    "bypassSecretName" TEXT,
    "extraHeaders" JSONB,
    "reachability" "EnvironmentReachability" NOT NULL DEFAULT 'NOT_PROBED',
    "remedy" TEXT,
    "observedSignal" TEXT,
    "observedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReEnumerationTrigger" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ReEnumerationTriggerKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cron" TEXT,
    "timezone" TEXT,
    "webhookSecretName" TEXT,
    "lastRunState" "ReEnumerationRunState" NOT NULL DEFAULT 'NEVER_RUN',
    "lastRunAt" TIMESTAMP(3),
    "lastFlowMapId" TEXT,
    "lastFailureMessage" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReEnumerationTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurfaceDriftRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "currentFlowMapId" TEXT NOT NULL,
    "baselineFlowMapId" TEXT,
    "comparability" "SurfaceDriftComparability" NOT NULL,
    "routesAdded" INTEGER,
    "routesRemoved" INTEGER,
    "routesChanged" INTEGER,
    "controlsAdded" INTEGER,
    "controlsRemoved" INTEGER,
    "newSurfaceWithoutTests" INTEGER,
    "detail" JSONB,
    "triggerId" TEXT,
    "comparedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurfaceDriftRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RouteAccessCell_environmentId_routeTemplate_role_key" ON "RouteAccessCell"("environmentId", "routeTemplate", "role");

-- CreateIndex
CREATE INDEX "RouteAccessCell_orgId_idx" ON "RouteAccessCell"("orgId");

-- CreateIndex
CREATE INDEX "RouteAccessCell_environmentId_role_outcome_idx" ON "RouteAccessCell"("environmentId", "role", "outcome");

-- CreateIndex
CREATE INDEX "RouteAccessCell_environmentId_outcome_idx" ON "RouteAccessCell"("environmentId", "outcome");

-- CreateIndex
CREATE INDEX "RouteAccessCell_attemptId_idx" ON "RouteAccessCell"("attemptId");

-- CreateIndex
CREATE INDEX "RouteAccessCell_coverageItemId_idx" ON "RouteAccessCell"("coverageItemId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleCrawlAttempt_environmentId_role_key" ON "RoleCrawlAttempt"("environmentId", "role");

-- CreateIndex
CREATE INDEX "RoleCrawlAttempt_orgId_idx" ON "RoleCrawlAttempt"("orgId");

-- CreateIndex
CREATE INDEX "RoleCrawlAttempt_environmentId_outcome_idx" ON "RoleCrawlAttempt"("environmentId", "outcome");

-- CreateIndex
CREATE INDEX "RoleCrawlAttempt_flowMapId_idx" ON "RoleCrawlAttempt"("flowMapId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentAccess_environmentId_key" ON "EnvironmentAccess"("environmentId");

-- CreateIndex
CREATE INDEX "EnvironmentAccess_orgId_idx" ON "EnvironmentAccess"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ReEnumerationTrigger_environmentId_name_key" ON "ReEnumerationTrigger"("environmentId", "name");

-- CreateIndex
CREATE INDEX "ReEnumerationTrigger_orgId_idx" ON "ReEnumerationTrigger"("orgId");

-- CreateIndex
CREATE INDEX "ReEnumerationTrigger_environmentId_kind_enabled_idx" ON "ReEnumerationTrigger"("environmentId", "kind", "enabled");

-- CreateIndex
CREATE INDEX "ReEnumerationTrigger_lastFlowMapId_idx" ON "ReEnumerationTrigger"("lastFlowMapId");

-- CreateIndex
CREATE INDEX "SurfaceDriftRecord_orgId_idx" ON "SurfaceDriftRecord"("orgId");

-- CreateIndex
CREATE INDEX "SurfaceDriftRecord_environmentId_comparedAt_idx" ON "SurfaceDriftRecord"("environmentId", "comparedAt");

-- CreateIndex
CREATE INDEX "SurfaceDriftRecord_currentFlowMapId_idx" ON "SurfaceDriftRecord"("currentFlowMapId");

-- CreateIndex
CREATE INDEX "SurfaceDriftRecord_baselineFlowMapId_idx" ON "SurfaceDriftRecord"("baselineFlowMapId");

-- CreateIndex
CREATE INDEX "SurfaceDriftRecord_triggerId_idx" ON "SurfaceDriftRecord"("triggerId");

-- AddForeignKey
ALTER TABLE "RouteAccessCell" ADD CONSTRAINT "RouteAccessCell_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAccessCell" ADD CONSTRAINT "RouteAccessCell_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAccessCell" ADD CONSTRAINT "RouteAccessCell_authProfileId_fkey" FOREIGN KEY ("authProfileId") REFERENCES "AuthProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAccessCell" ADD CONSTRAINT "RouteAccessCell_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RoleCrawlAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAccessCell" ADD CONSTRAINT "RouteAccessCell_coverageItemId_fkey" FOREIGN KEY ("coverageItemId") REFERENCES "CoverageItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleCrawlAttempt" ADD CONSTRAINT "RoleCrawlAttempt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleCrawlAttempt" ADD CONSTRAINT "RoleCrawlAttempt_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleCrawlAttempt" ADD CONSTRAINT "RoleCrawlAttempt_authProfileId_fkey" FOREIGN KEY ("authProfileId") REFERENCES "AuthProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleCrawlAttempt" ADD CONSTRAINT "RoleCrawlAttempt_flowMapId_fkey" FOREIGN KEY ("flowMapId") REFERENCES "FlowMap"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentAccess" ADD CONSTRAINT "EnvironmentAccess_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReEnumerationTrigger" ADD CONSTRAINT "ReEnumerationTrigger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReEnumerationTrigger" ADD CONSTRAINT "ReEnumerationTrigger_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReEnumerationTrigger" ADD CONSTRAINT "ReEnumerationTrigger_lastFlowMapId_fkey" FOREIGN KEY ("lastFlowMapId") REFERENCES "FlowMap"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurfaceDriftRecord" ADD CONSTRAINT "SurfaceDriftRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurfaceDriftRecord" ADD CONSTRAINT "SurfaceDriftRecord_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurfaceDriftRecord" ADD CONSTRAINT "SurfaceDriftRecord_currentFlowMapId_fkey" FOREIGN KEY ("currentFlowMapId") REFERENCES "FlowMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurfaceDriftRecord" ADD CONSTRAINT "SurfaceDriftRecord_baselineFlowMapId_fkey" FOREIGN KEY ("baselineFlowMapId") REFERENCES "FlowMap"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurfaceDriftRecord" ADD CONSTRAINT "SurfaceDriftRecord_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "ReEnumerationTrigger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- REVERSING THIS, if the deploy has to be undone.
--
-- TWO HALVES WITH VERY DIFFERENT COSTS, and the asymmetry is the whole point of
-- reading this section before deploying.
--
-- THE FIVE TABLES REVERT CLEANLY. Every object dropped below was created by this
-- migration; no pre-existing row is read or written, and no pre-existing table
-- is rewritten. Order matters: drop the foreign keys, then the tables, then the
-- types, or DROP TYPE fails with a dependency error. "RouteAccessCell" must go
-- before "RoleCrawlAttempt" and "SurfaceDriftRecord" before
-- "ReEnumerationTrigger" for the same reason — a child before its parent.
-- `DROP TABLE … CASCADE` would also work and is deliberately not used: it hides
-- exactly the dependency this ordering states.
--
-- WHAT IS LOST, stated plainly. Everything in "RouteAccessCell" and
-- "RoleCrawlAttempt" is re-derivable by re-crawling, at the cost of one crawl
-- per role. "SurfaceDriftRecord" is NOT: a diff is a comparison of two map
-- VERSIONS, and re-crawling produces a new current with no record of what the
-- old comparison said, so the drift history goes and does not come back.
-- "EnvironmentAccess" and "ReEnumerationTrigger" are CONFIGURATION a person
-- typed — a provider, a bypass header name, a cron expression, a webhook secret
-- NAME — and nothing re-derives those. EXPORT "EnvironmentAccess" AND
-- "ReEnumerationTrigger" BEFORE REVERTING.
--
-- THE COLUMN REVERTS CLEANLY AND LOSES THE ROLE AXIS.
-- `ALTER TABLE "AuthProfile" DROP COLUMN "role"` is catalogue-only and takes
-- ACCESS EXCLUSIVE on "AuthProfile" for a moment, exactly like adding it. What
-- goes with it is which identity is which role, which a person configured and
-- nothing re-derives. Export it with the two tables above.
--
-- THE THREE ENUM LABELS CANNOT BE REVERTED, and this is the one irreversible
-- thing in the file. PostgreSQL HAS NO `ALTER TYPE … DROP VALUE`. Removing
-- PASSKEY, PHONE_OTP and MOCK_IDP means creating a new type with the old five
-- labels, rewriting every "AuthProfile" row's column to it with a USING cast,
-- swapping the types and dropping the old one — which is a TABLE REWRITE under
-- ACCESS EXCLUSIVE, the one rewrite this migration avoided in the forward
-- direction, and it FAILS OUTRIGHT if any stored profile uses one of the three
-- new labels. So the rollback plan is to leave them: three unused labels on an
-- enum cost nothing, break nothing, and are invisible to every reader that
-- switches on the five. The statements are written out below anyway, because a
-- revert plan that omits the hard part is not a revert plan.
--
--   ALTER TABLE "SurfaceDriftRecord" DROP CONSTRAINT "SurfaceDriftRecord_triggerId_fkey";
--   ALTER TABLE "SurfaceDriftRecord" DROP CONSTRAINT "SurfaceDriftRecord_baselineFlowMapId_fkey";
--   ALTER TABLE "SurfaceDriftRecord" DROP CONSTRAINT "SurfaceDriftRecord_currentFlowMapId_fkey";
--   ALTER TABLE "SurfaceDriftRecord" DROP CONSTRAINT "SurfaceDriftRecord_environmentId_fkey";
--   ALTER TABLE "SurfaceDriftRecord" DROP CONSTRAINT "SurfaceDriftRecord_projectId_fkey";
--   ALTER TABLE "ReEnumerationTrigger" DROP CONSTRAINT "ReEnumerationTrigger_lastFlowMapId_fkey";
--   ALTER TABLE "ReEnumerationTrigger" DROP CONSTRAINT "ReEnumerationTrigger_environmentId_fkey";
--   ALTER TABLE "ReEnumerationTrigger" DROP CONSTRAINT "ReEnumerationTrigger_projectId_fkey";
--   ALTER TABLE "EnvironmentAccess" DROP CONSTRAINT "EnvironmentAccess_environmentId_fkey";
--   ALTER TABLE "RoleCrawlAttempt" DROP CONSTRAINT "RoleCrawlAttempt_flowMapId_fkey";
--   ALTER TABLE "RoleCrawlAttempt" DROP CONSTRAINT "RoleCrawlAttempt_authProfileId_fkey";
--   ALTER TABLE "RoleCrawlAttempt" DROP CONSTRAINT "RoleCrawlAttempt_environmentId_fkey";
--   ALTER TABLE "RoleCrawlAttempt" DROP CONSTRAINT "RoleCrawlAttempt_projectId_fkey";
--   ALTER TABLE "RouteAccessCell" DROP CONSTRAINT "RouteAccessCell_coverageItemId_fkey";
--   ALTER TABLE "RouteAccessCell" DROP CONSTRAINT "RouteAccessCell_attemptId_fkey";
--   ALTER TABLE "RouteAccessCell" DROP CONSTRAINT "RouteAccessCell_authProfileId_fkey";
--   ALTER TABLE "RouteAccessCell" DROP CONSTRAINT "RouteAccessCell_environmentId_fkey";
--   ALTER TABLE "RouteAccessCell" DROP CONSTRAINT "RouteAccessCell_projectId_fkey";
--
--   DROP TABLE "RouteAccessCell";
--   DROP TABLE "SurfaceDriftRecord";
--   DROP TABLE "ReEnumerationTrigger";
--   DROP TABLE "EnvironmentAccess";
--   DROP TABLE "RoleCrawlAttempt";
--
--   ALTER TABLE "AuthProfile" DROP COLUMN "role";
--
--   DROP TYPE "SurfaceDriftComparability";
--   DROP TYPE "ReEnumerationRunState";
--   DROP TYPE "ReEnumerationTriggerKind";
--   DROP TYPE "EnvironmentReachability";
--   DROP TYPE "BotBypassMode";
--   DROP TYPE "BotProtectionProvider";
--   DROP TYPE "RoleCrawlOutcome";
--   DROP TYPE "RouteAccessBasis";
--   DROP TYPE "RouteAccessOutcome";
--
--   -- The irreversible part. Only if the three labels genuinely must go, only
--   -- with no row using them, and NOT inside the same transaction as anything
--   -- above: this is a table rewrite under ACCESS EXCLUSIVE.
--   ALTER TYPE "AuthProfileKind" RENAME TO "AuthProfileKind_old";
--   CREATE TYPE "AuthProfileKind" AS ENUM ('FORM_LOGIN', 'MAGIC_LINK', 'SSO_BYPASS_TOKEN', 'COOKIE_INJECTION', 'TOTP_MFA');
--   ALTER TABLE "AuthProfile" ALTER COLUMN "kind" TYPE "AuthProfileKind" USING ("kind"::text::"AuthProfileKind");
--   DROP TYPE "AuthProfileKind_old";
