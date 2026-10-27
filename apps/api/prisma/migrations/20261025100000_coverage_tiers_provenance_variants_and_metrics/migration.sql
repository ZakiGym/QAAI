-- The measurement. Three ENUMERATE slices built the denominator; nothing built
-- the thing that divides into it.
--
-- WHY THIS EXISTS
--
-- 20261024070000 gave the surface registry provenance, 20261024090000 added the
-- sources that declare what no crawl can reach, and 20261024100000 added the
-- identity asking. All three answer "what exists". NONE of them touches the
-- NUMERATOR, and every sentence the numerator supports today is false in the
-- direction that flatters us. Six absences, each of which makes a specific
-- claim unsayable:
--
--   1. "COVERED" WAS A BOOLEAN MEANING "SOME TEST MENTIONS IT". There was no
--      requirement that the test ASSERTS anything, that it PASSED, that it RAN,
--      or that it is not quarantined. So a test that always fails closed a gap
--      — while every gate in the product excluded that same test from every
--      rule. The two halves of the product disagreed about whether a red test
--      was evidence, and only the flattering half was on screen. "CoverageTier"
--      is the ladder: DECLARED → NAVIGATED → ASSERTED → PASSING → FRESH, with
--      the evidence each rung demands named in
--      packages/shared/src/coverage-tiers.ts.
--   2. THE NUMERATOR LINK WAS A REGEX RECOMPUTED PER REQUEST, with no identity
--      and no history. So coverage COULD NOT FALL when a test was deleted,
--      renamed, disabled or quarantined: the link simply stopped being derived,
--      and an item covered yesterday became indistinguishable from one never
--      covered at all. A number structurally incapable of going down for the
--      most common reason it should is not a measurement. "TestCoverageEdge" is
--      that identity, with its source, its tier, the run that last confirmed it
--      and a "retiredAt" — which is how coverage goes down WITH AN AUDIT TRAIL
--      rather than quietly.
--   3. THERE WAS NO WAY TO SAY WHAT A TEST IS FOR. Many tests are unreadable to
--      a static extractor — a page object, a fixture-driven table test, a helper
--      that builds its URL from a factory — so the product asked customers to
--      believe a coverage number and gave them no way to correct it.
--      "Test"."covers" is the declaration. It feeds a SPEC edge whose ceiling is
--      DECLARED, so it can never reach PASSING without a run: if it could,
--      `covers: ['ROUTE:/billing']` would be a one-line way to manufacture a
--      green report and this column would be the largest hole in the product
--      rather than the fix for one.
--   4. "TestResult" IS UNIQUE ON (runId, testId) AND REDUCES WORST-WINS. So
--      "passes in Chromium, fails in WebKit" is stored as "failed", "covered in
--      WebKit and in de-DE" is not merely unsaid but unmeasurable, and the
--      DEVICE_LOCALE and ROLE_CELL axes of the denominator have no per-variant
--      evidence to rest on at all. "TestResultVariant" is that evidence. THE
--      ROLL-UP IS UNCHANGED — see the TestResult section below.
--   5. EVERY NUMBER A PLUGIN PRODUCES SURVIVED ONLY AS PROSE INSIDE A STEP
--      TITLE. 20261024-era work gave the mutation score five scalar columns,
--      correctly, because it is ONE known metric with a known denominator. LCP,
--      CLS, INP, k6's p95 and error rate and the visual diff ratio got nothing —
--      so "MAX_VITAL_BREACHES" and "MAX_P95_LATENCY_MS" are gate rules that
--      exist, are saveable, and have no stored number to read. "TestMetricSample"
--      is the open channel: a row per reading, name + value + unit + direction +
--      the cell it came from.
--   6. "Test"."flakeRate" IS OVERWRITTEN ON EVERY RUN and the suite-health score
--      is recomputed per request, so rot has no DIRECTION — the premise of the
--      entire suite-health lens was unmeasurable. "TestFlakeHistory" fixed the
--      PER-TEST half and cannot fix this one, and not for want of a GROUP BY:
--      weak assertions, near-duplicates, obsolete tests and the quarantine
--      budget are properties of the SUITE, computed from test SOURCE, and
--      nothing ever stored one of them. "SuiteHealthSnapshot" is the trend.
--
-- And one more, which is configuration rather than measurement:
-- "Project"."coverageConfig". Risk ranking is an English money-word regex and it
-- is \b-bounded, so `/pay_now` and `/checkoutConfirm` both miss. No regex fixes
-- that, because the question is not how a route is spelled but what it does, and
-- the only party who knows is the team that wrote it — a code comment already
-- invited them to "tell us so" with nowhere in the product to do it.
--
-- THE HONESTY RULES THIS DDL ENCODES, STATED ONCE
--
--   · "TestCoverageEdge"."tier" AND ."source" HAVE NO DEFAULT. A default tier of
--     DECLARED would mint a claim nothing produced. A default source would let a
--     writer's bug read as a regex match. With no default the INSERT fails and
--     somebody finds out — the same argument "RouteAccessCell"."outcome" records.
--   · EVERY MEASUREMENT ON "SuiteHealthSnapshot" IS NULLABLE AND NONE IS
--     DEFAULT 0. For five of the ten, 0 is the BEST POSSIBLE RESULT ("we scanned
--     every test and found no weak assertions"), so writing it for a scan that
--     never ran is the most flattering lie this product could tell about itself.
--     Same rule as "SurfaceDriftRecord"'s six counts and
--     "TestResult"."mutationScore". The ONE defaulted column is ."caveats" = [],
--     because an empty caveat list is a positive, verifiable claim that nothing
--     was truncated — not a measurement of the customer's suite.
--   · "TestMetricSample"."value" IS NULLABLE AND CARRIES A REQUIRED REASON WHEN
--     NULL (enforced by `testMetricSchema`). An LCP of 0 ms is a page that
--     painted instantly, a p95 of 0 is a load test that never ran, a visual diff
--     ratio of 0 is a pixel-perfect match. A product that writes 0 for "not
--     measured" reports its own blind spots as its best results.
--   · EVERY DIMENSION OF A VARIANT KEY IS NOT NULL, with '<unvaried>' and
--     '<anonymous>' as the sentinels, and no DEFAULT in the database — the
--     producer must state all five. A nullable dimension would break the unique
--     index in the quietest possible way: PostgreSQL treats every NULL as
--     DISTINCT, so the DEFAULT CELL — the one almost every test runs in — would
--     re-insert on every run and be counted once per run. This is exactly the
--     defect "RouteAccessCell"."role" records, repeated here because it is
--     repeatable.
--   · "TestMetricSample"."variantKey" EXISTS ALONGSIDE ."variantId" ON PURPOSE.
--     The id is the join and is nullable (a whole-test reading belongs to no
--     cell); the key is the IDENTITY and is NOT NULL, so the unique index below
--     actually constrains the common case instead of admitting one duplicate
--     whole-test reading per run for ever. Same NULL argument as above.
--   · "Project"."coverageConfig" IS NULLABLE WITH NO DEFAULT. `{}` would claim a
--     customer had reviewed their scope and declared nothing out of it, which is
--     a positive assertion. Null is "nobody configured this". Same judgement as
--     ."quarantineBudgetPercent" and ."coverageTargetPercent".
--   · "Test"."covers" IS `TEXT[] DEFAULT ARRAY[]::TEXT[]`, and the default IS
--     honest here where it would not be on a count: `[]` means "this test
--     declares nothing", which is the ordinary case for every hand-written and
--     imported test. There is no fourth state between "declares nothing" and
--     "declares an empty list".
--
-- WHAT THIS DOES TO "TestResult", WHICH IS THE LARGEST TABLE IN THE PRODUCT
--
-- IT ADDS NO COLUMN TO IT. That is the headline and it is the reason the two new
-- child tables carry a denormalised "runId"/"testId" instead. A column with a
-- DEFAULT on "TestResult" forces a table rewrite on every customer's database
-- under ACCESS EXCLUSIVE, and this round deliberately takes none.
--
-- Exactly three things in this file touch "TestResult" at all:
--
--   · ALTER TABLE "TestResultVariant" ADD CONSTRAINT …_testResultId_fkey
--   · ALTER TABLE "TestMetricSample"  ADD CONSTRAINT …_testResultId_fkey
--   · the Prisma-side relation fields ."variants" and ."metricSamples", which
--     produce NO SQL whatsoever.
--
-- Each foreign key is declared on the CHILD, so adding it takes SHARE ROW
-- EXCLUSIVE on "TestResult": it blocks concurrent WRITES to it for the duration
-- of that ONE statement, permits reads throughout, and NEVER scans or rewrites
-- its rows. The validation scans the CHILD, and both children are empty — they
-- do not exist until this migration. On a busy install these two statements are
-- the only moment anything here contends with the run finaliser, and they are
-- microseconds each.
--
-- The (runId, testId) unique constraint on "TestResult" and the worst-wins
-- roll-up that fills it are UNTOUCHED. Every existing reader of
-- "TestResult"."status" keeps the contract it was written against. The variant
-- rows are ADDITIONAL EVIDENCE underneath that contract: a reader asking "did it
-- pass?" wants the roll-up, a reader asking "where did it pass?" wants the
-- cells, and reconciling the two by overwriting either is how a matrix becomes a
-- single wrong answer.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- CATALOGUE-ONLY IN BOTH DIRECTIONS. No table is rewritten and no row of any
-- existing table is read or written. Specifically:
--
-- FOUR CREATE TYPEs. A new enum type takes no lock on any table. There is NO
-- `ALTER TYPE … ADD VALUE` in this file, so the PostgreSQL 12 floor the previous
-- migration documents does not apply here.
--
-- TWO ALTER TABLE … ADD COLUMN, on "Test" and on "Project". Both are the
-- lock-free kind:
--
--   "Project"."coverageConfig" JSONB — NULLABLE WITH NO DEFAULT, which has been
--   a pure catalogue update since PostgreSQL 11 and is also the semantically
--   correct choice (see the honesty rules above).
--
--   "Test"."covers" TEXT[] DEFAULT ARRAY[]::TEXT[] — a column WITH a default,
--   which is the one case worth spelling out. Since PostgreSQL 11 a DEFAULT that
--   is NOT VOLATILE is stored once in pg_attribute as a missing-value and
--   materialised on read, so no heap page is touched; `ARRAY[]::text[]` is an
--   immutable expression and qualifies. A volatile default (`now()`,
--   `gen_random_uuid()`) would NOT, and would rewrite the whole table — do not
--   change this default to one. "Test" is one row per test, orders of magnitude
--   smaller than "TestResult", and even so it is not rewritten.
--
-- Both ALTER TABLEs take ACCESS EXCLUSIVE for the duration of a catalogue
-- update — microseconds — and neither blocks anything measurable.
--
-- FOUR CREATE TABLEs with their indexes and foreign keys. Every one is built on
-- an EMPTY relation: the tables do not exist until this statement, so their
-- indexes index nothing and their foreign-key constraints validate against no
-- rows. The parents touched that way are "Test", "CoverageItem", "TestResult",
-- "TestResultVariant" and "Project".
--
-- THE DELETE BEHAVIOURS, AND WHY THEY ARE ALL CASCADE
--
-- Unlike the previous migration, which needed SET NULL in six places to keep
-- EVIDENCE alive past the thing that produced it, every child here is MEANINGLESS
-- without its parent and would be actively misleading if it survived:
--
--   "TestCoverageEdge"   → "Test" and "CoverageItem". An edge is a claim that
--                          THIS test covers THIS item. With either gone the row
--                          is a numerator entry pointing at nothing, which would
--                          hold coverage UP after the test was deleted — the
--                          exact defect this table exists to fix.
--   "TestResultVariant"  → "TestResult". A cell of a result that no longer
--                          exists.
--   "TestMetricSample"   → "TestResult" and "TestResultVariant". A reading about
--                          a result that no longer exists. The ."variantId"
--                          cascade is why a whole-test reading keeps its NULL id
--                          and its NOT NULL ."variantKey": deleting a cell must
--                          not take the test-level reading with it.
--   "SuiteHealthSnapshot"→ "Project".
--
-- Project deletion already cascades to these through Run → TestResult, so no
-- direct Project foreign key is declared on the two result-scoped tables.
--
-- EVERY IDENTIFIER WAS CHECKED AGAINST POSTGRESQL'S 63-BYTE LIMIT, because
-- PostgreSQL TRUNCATES SILENTLY and a truncated name is one Prisma's
-- introspection will disagree with for ever — a previous round paid for that
-- with permanent phantom drift on every `migrate dev`. The longest of the 35
-- identifiers here is "TestMetricSample_testResultId_variantKey_name_key" at 49
-- bytes.
--
-- EXACTLY ONE CONSTRAINT IS NAMED EXPLICITLY IN schema.prisma (`map:`), and it
-- is named because it has to be: Prisma's derived name for the six-column
-- variant cell key is
-- "TestResultVariant_testResultId_browser_viewport_locale_role_environment_key"
-- at 75 bytes, which PostgreSQL would silently cut to 63. The other two uniques
-- in this round (41 and 49 bytes) are left to Prisma's own naming on purpose —
-- a `map:` that was not required would make the one that IS required look like
-- a style preference.
--
-- WHAT IS NOT WIRED YET, RATHER THAN LEAVING IT TO BE DISCOVERED
--
-- THIS MIGRATION MINTS FOUR DISCONNECTED MODELS. The write paths and read paths
-- for all four live in files this change does not own and land beside it in the
-- same round, built by five parallel agents on the vocabulary in
-- packages/shared/src/coverage-tiers.ts, types.ts and schemas.ts. Until those
-- doors land, `scripts/check-wiring.ts` will report "TestCoverageEdge",
-- "TestResultVariant", "TestMetricSample" and "SuiteHealthSnapshot" as tables
-- nothing reads or writes, and the slice cannot ship. The round before the
-- previous one paid an entire extra repair pass for shipping two such tables
-- WITHOUT saying so, which is why this paragraph exists: a migration whose
-- disconnection is a surprise is the specific mistake being avoided. The
-- baseline this landed on is 0 disconnected and exactly 4 pre-existing known
-- gaps (OAuthAccount, FeatureFlag, FeatureFlagOverride and the FeatureFlag
-- store); none of those four is cleared or changed by this file.
--
-- What must still not happen is any of the four being read as a measurement: an
-- empty "TestCoverageEdge" is "nothing has computed provenance yet", NOT "no test
-- covers anything", and an empty "SuiteHealthSnapshot" is NOT a healthy suite.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "CoverageTier" AS ENUM ('DECLARED', 'NAVIGATED', 'ASSERTED', 'PASSING', 'FRESH');

-- CreateEnum
CREATE TYPE "CoverageEdgeSource" AS ENUM ('STATIC', 'SPEC', 'RUNTIME');

-- CreateEnum
CREATE TYPE "MetricUnit" AS ENUM ('MILLISECONDS', 'SECONDS', 'BYTES', 'COUNT', 'PERCENT', 'RATIO', 'SCORE', 'REQUESTS_PER_SECOND', 'PIXELS');

-- CreateEnum
CREATE TYPE "MetricDirection" AS ENUM ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER');

-- AlterTable
--
-- The declaration. See the header: a SPEC edge's ceiling is DECLARED, so this
-- column cannot manufacture a passing report. The default is immutable, so this
-- is a catalogue update and not a rewrite.
ALTER TABLE "Test" ADD COLUMN "covers" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
--
-- The scope and criticality its owner declares. Nullable with no default: `{}`
-- would claim a customer had reviewed their scope and declared nothing out of it.
ALTER TABLE "Project" ADD COLUMN "coverageConfig" JSONB;

-- CreateTable
CREATE TABLE "TestCoverageEdge" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "source" "CoverageEdgeSource" NOT NULL,
    "tier" "CoverageTier" NOT NULL,
    "cappedBy" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" TEXT NOT NULL,
    "lastConfirmedRunId" TEXT,
    "lastConfirmedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "TestCoverageEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestResultVariant" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "testResultId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "viewport" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" "TestResultStatus" NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "retriedAndPassed" BOOLEAN NOT NULL DEFAULT false,
    "notRunKind" "NotRunKind",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestResultVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestMetricSample" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "testResultId" TEXT NOT NULL,
    "variantId" TEXT,
    "name" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "unavailableReason" TEXT,
    "unit" "MetricUnit" NOT NULL,
    "direction" "MetricDirection" NOT NULL,
    "variantKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestMetricSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuiteHealthSnapshot" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "commitSha" TEXT,
    "runId" TEXT,
    "testCount" INTEGER,
    "quarantinedCount" INTEGER,
    "flakyCount" INTEGER,
    "weakAssertionCount" INTEGER,
    "duplicateCount" INTEGER,
    "obsoleteCount" INTEGER,
    "passRatePercent" DOUBLE PRECISION,
    "medianDurationMs" INTEGER,
    "p95DurationMs" INTEGER,
    "score" DOUBLE PRECISION,
    "caveats" JSONB NOT NULL DEFAULT '[]',
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuiteHealthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TestCoverageEdge_itemId_testId_source_key" ON "TestCoverageEdge"("itemId", "testId", "source");

-- CreateIndex
CREATE INDEX "TestCoverageEdge_orgId_idx" ON "TestCoverageEdge"("orgId");

-- CreateIndex
CREATE INDEX "TestCoverageEdge_itemId_tier_idx" ON "TestCoverageEdge"("itemId", "tier");

-- CreateIndex
CREATE INDEX "TestCoverageEdge_testId_idx" ON "TestCoverageEdge"("testId");

-- CreateIndex
CREATE INDEX "TestCoverageEdge_projectId_retiredAt_idx" ON "TestCoverageEdge"("projectId", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "TestResultVariant_cell_key" ON "TestResultVariant"("testResultId", "browser", "viewport", "locale", "role", "environment");

-- CreateIndex
CREATE INDEX "TestResultVariant_orgId_idx" ON "TestResultVariant"("orgId");

-- CreateIndex
CREATE INDEX "TestResultVariant_runId_status_idx" ON "TestResultVariant"("runId", "status");

-- CreateIndex
CREATE INDEX "TestResultVariant_testId_createdAt_idx" ON "TestResultVariant"("testId", "createdAt");

-- CreateIndex
CREATE INDEX "TestResultVariant_testResultId_idx" ON "TestResultVariant"("testResultId");

-- CreateIndex
CREATE UNIQUE INDEX "TestMetricSample_testResultId_variantKey_name_key" ON "TestMetricSample"("testResultId", "variantKey", "name");

-- CreateIndex
CREATE INDEX "TestMetricSample_orgId_idx" ON "TestMetricSample"("orgId");

-- CreateIndex
CREATE INDEX "TestMetricSample_projectId_name_createdAt_idx" ON "TestMetricSample"("projectId", "name", "createdAt");

-- CreateIndex
CREATE INDEX "TestMetricSample_testId_name_createdAt_idx" ON "TestMetricSample"("testId", "name", "createdAt");

-- CreateIndex
CREATE INDEX "TestMetricSample_runId_idx" ON "TestMetricSample"("runId");

-- CreateIndex
CREATE INDEX "TestMetricSample_variantId_idx" ON "TestMetricSample"("variantId");

-- CreateIndex
CREATE INDEX "SuiteHealthSnapshot_orgId_idx" ON "SuiteHealthSnapshot"("orgId");

-- CreateIndex
CREATE INDEX "SuiteHealthSnapshot_projectId_createdAt_idx" ON "SuiteHealthSnapshot"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SuiteHealthSnapshot_projectId_commitSha_idx" ON "SuiteHealthSnapshot"("projectId", "commitSha");

-- AddForeignKey
ALTER TABLE "TestCoverageEdge" ADD CONSTRAINT "TestCoverageEdge_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCoverageEdge" ADD CONSTRAINT "TestCoverageEdge_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CoverageItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- ONE OF THE TWO STATEMENTS IN THIS FILE THAT TOUCH "TestResult". SHARE ROW
-- EXCLUSIVE on it for the duration of this statement; the scan is of the empty
-- CHILD. See the TestResult section of the header.
ALTER TABLE "TestResultVariant" ADD CONSTRAINT "TestResultVariant_testResultId_fkey" FOREIGN KEY ("testResultId") REFERENCES "TestResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- THE SECOND AND LAST STATEMENT THAT TOUCHES "TestResult". Same lock, same
-- empty-child scan.
ALTER TABLE "TestMetricSample" ADD CONSTRAINT "TestMetricSample_testResultId_fkey" FOREIGN KEY ("testResultId") REFERENCES "TestResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMetricSample" ADD CONSTRAINT "TestMetricSample_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "TestResultVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuiteHealthSnapshot" ADD CONSTRAINT "SuiteHealthSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- REVERSING THIS, if the deploy has to be undone.
--
-- BOTH DIRECTIONS ARE CLEAN, WHICH IS THE DIFFERENCE FROM THE PREVIOUS
-- MIGRATION. There is no `ALTER TYPE … ADD VALUE` in the forward direction, so
-- there is no irreversible half: PostgreSQL has no `ALTER TYPE … DROP VALUE`,
-- but nothing here adds a label to a pre-existing type, so nothing here needs
-- one removed. Every object dropped below was created by this file.
--
-- ORDER MATTERS. Drop the foreign keys, then the tables, then the types, or
-- DROP TYPE fails with a dependency error. "TestMetricSample" must go before
-- "TestResultVariant" — a child before its parent. `DROP TABLE … CASCADE` would
-- also work and is deliberately not used: it hides exactly the dependency this
-- ordering states.
--
-- WHAT IS LOST, STATED PLAINLY RATHER THAN DISCOVERED.
--
--   RE-DERIVABLE, at the cost of one analysis and one run:
--   "TestCoverageEdge" (recomputed by the extractor and the run finaliser) and
--   "TestResultVariant" plus "TestMetricSample" FOR THE CURRENT RUN.
--
--   NOT RE-DERIVABLE, and this is the part to export first:
--   · "SuiteHealthSnapshot" IS THE TREND. Re-measuring produces today's reading
--     and no record of what last month's said. The history goes and does not
--     come back — the same argument as "SurfaceDriftRecord".
--   · "TestMetricSample" AND "TestResultVariant" FOR EVERY PAST RUN. A p95 or an
--     LCP is a measurement of a moment; re-running measures a different moment.
--   · "TestCoverageEdge"."retiredAt" AND ."firstSeenAt" are the audit trail of
--     coverage having FALLEN. Re-deriving produces the current edges with
--     today's timestamps and no memory of what was retired, which is precisely
--     the fact this table was added to preserve.
--   · "Test"."covers" IS A DECLARATION A PERSON OR A GENERATOR TYPED. Nothing
--     re-derives it; the static extractor's guess is not the same thing.
--     EXPORT IT BEFORE REVERTING.
--   · "Project"."coverageConfig" IS CONFIGURATION A PERSON TYPED — criticality,
--     out-of-scope globs, weights and the out-of-scope brake. Nothing
--     re-derives it. EXPORT IT TOO.
--
--   ALTER TABLE "SuiteHealthSnapshot" DROP CONSTRAINT "SuiteHealthSnapshot_projectId_fkey";
--   ALTER TABLE "TestMetricSample" DROP CONSTRAINT "TestMetricSample_variantId_fkey";
--   ALTER TABLE "TestMetricSample" DROP CONSTRAINT "TestMetricSample_testResultId_fkey";
--   ALTER TABLE "TestResultVariant" DROP CONSTRAINT "TestResultVariant_testResultId_fkey";
--   ALTER TABLE "TestCoverageEdge" DROP CONSTRAINT "TestCoverageEdge_itemId_fkey";
--   ALTER TABLE "TestCoverageEdge" DROP CONSTRAINT "TestCoverageEdge_testId_fkey";
--
--   DROP TABLE "TestMetricSample";
--   DROP TABLE "TestResultVariant";
--   DROP TABLE "TestCoverageEdge";
--   DROP TABLE "SuiteHealthSnapshot";
--
--   -- Catalogue-only in this direction too, and on "Test" and "Project" rather
--   -- than on "TestResult", which this file never altered.
--   ALTER TABLE "Test" DROP COLUMN "covers";
--   ALTER TABLE "Project" DROP COLUMN "coverageConfig";
--
--   DROP TYPE "MetricDirection";
--   DROP TYPE "MetricUnit";
--   DROP TYPE "CoverageEdgeSource";
--   DROP TYPE "CoverageTier";
