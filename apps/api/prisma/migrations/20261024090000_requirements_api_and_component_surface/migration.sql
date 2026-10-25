-- The non-crawl half of enumeration: the surface a HUMAN declared, the surface
-- a DOCUMENT declares, the components and background surfaces nothing crawls,
-- and the journeys real users actually took.
--
-- WHY THIS EXISTS
--
-- A crawl can only ever report what it REACHED. 20261024070000 gave the
-- registry provenance so a crawl's reach and a source's declaration could be
-- told apart; this adds the SOURCES that declare things no crawl can reach at
-- all. Six absences, each of which made a specific sentence unsayable:
--
--   1. NO REQUIREMENT ENTITY. "Which acceptance criterion has no test?" is the
--      enterprise question and the whole of Xray's and Zephyr's traceability
--      product. QAAI could not ask it, because there was nothing to ask it
--      about. Nor could it ever select a behaviour that is SPECIFIED AND NOT
--      YET BUILT for generation — the one surface no extractor and no crawl can
--      find, because there is nothing to extract and nothing to reach, and also
--      the only surface where a generated test is useful BEFORE the feature
--      lands.
--   2. NO LINK PROVENANCE. A link a human asserted and a link a regex guessed
--      would have read the same. A traceability matrix that renders those
--      identically launders a guess into an audit artifact, which is worse than
--      having no matrix at all. "RequirementLink"."method" and "confidence" are
--      that column, and `clampLinkConfidence` caps what each method may claim.
--   3. OPENAPI WAS PARSED AND THROWN AWAY. The richest declaration of an
--      application's surface that exists was read inside the CONTRACT runner
--      and discarded when the run ended, every run. So the request shapes, the
--      declared auth and — the part that matters most — every parameter bound
--      were unavailable to boundary and negative-case generation. The
--      "HttpEndpoint" rows that did survive are UNKNOWN-verb declarations
--      nothing has ever verified.
--   4. NO COMPONENT INVENTORY ANYWHERE IN THE REPO. UNIT_GEN and
--      component-state coverage therefore had no denominator at all — not a low
--      one, an ABSENT one. "Not just the happy path" was an adjective, because
--      there was nothing to count.
--   5. `POST /traffic/:projectId/analyze` WROTE NOTHING. Observed journeys, real
--      session frequencies and a coverage cross-reference were computed and
--      vanished with the HTTP response. The third enumeration source did not
--      outlive one request, and the caps it applied vanished with it.
--   6. ABSENT WAS NOT UNCOVERED, AGAIN. A cron entry, a queue consumer, a
--      webhook receiver, an upload handler, a websocket, a server action, a tRPC
--      procedure: nothing crawls them and no route table declares them.
--      `BackgroundSurfaceFact` in packages/shared/src/api-surface.ts gives each
--      one a typed shape that goes in "CoverageItem"."meta", on the axis
--      `DIMENSION_AXIS` already assigns — so they are NAMED and COUNTED rather
--      than missing.
--
-- WHY THERE IS NO NEW SURFACE REGISTRY
--
-- "CoverageItem" IS the registry and there is deliberately no second one. An
-- API operation, a component state and a background job each become a
-- "CoverageItem" on one of the twelve "SurfaceKind" axes with "sources" naming
-- the declarer. The tables below hold the DETAIL a registry row cannot — a
-- parameter's declared bounds, a requirement's criteria as rows, what a probe
-- actually saw — plus the one thing a JSON blob can never be: addressable.
-- Three disjoint inventories of one application on three screens is the defect
-- this round exists to end; a fourth would be an expensive way to make it worse.
--
-- WHY "RequirementLinkState" IS A COLUMN AND NOT `count(links) = 0`
--
-- Because "requirements with no test" is THE report this feature exists to
-- produce, and the absence of rows cannot be indexed, cannot be ordered by,
-- and — the point — cannot be told apart from the absence of a LINKER. A
-- `LEFT JOIN … WHERE link.id IS NULL` silently includes every requirement
-- imported five minutes ago that nothing has looked at yet, and so reports OUR
-- SILENCE as the customer's gap. NOT_SEARCHED is the default on insert because
-- the default then states the truth, and `linkedAt` makes that silence
-- auditable rather than asserted. `linkStateFrom` in
-- packages/shared/src/requirements.ts is the only derivation, exactly as
-- `originFromSources` is for "CoverageItem"."origin".
--
-- WHY TEN NEW ENUMS AND NOT SIXTEEN
--
-- Each of the ten is a closed vocabulary a reader FILTERS on, which is what
-- earns a database type and an entry in apps/api/scripts/check-enums.ts (a new
-- Prisma enum with no entry there is an enum with no drift guard, which is how
-- five TestType members once sat un-migrated and invisible until an insert
-- failed at run time). Six more vocabularies in this change are TEXT instead —
-- "ApiOperation"."method" and "notProbedReason", "TrafficIngest"."format",
-- "ObservedJourney"."coverageStatus", "ComponentItem"."detector",
-- "Requirement"."statusRaw" — following "Project"."closureApprovalPolicy",
-- "MutationSurvivor"."reason" and "CoverageItem"."unexercisableReason": they
-- are rendered rather than filtered, their domain is enforced at the producer,
-- and an enum whose only purpose is to need a guard is not a win.
--
-- THE SILENCES THAT ARE STORED AS THEIR OWN VALUES
--
-- Every one of these is a fact we would otherwise have invented:
--
--   · "ApiAuthDeclaration".UNSTATED vs .NONE vs .NOT_READ — "the document is
--     silent here", "the document declares no auth here", and "we never read a
--     document". Collapsed into a boolean, every operation whose document we
--     did not read reads as PUBLIC; a negative-auth test is generated, it gets
--     a 401, and the 401 is reported as the application correctly refusing
--     anonymous access. A passing test that asserted nothing.
--   · "ApiOperationVerification".NOT_PROBED is a cap, a missing base URL or a
--     policy refusal — with the reason on the row — and must never render as
--     "does not exist". There is deliberately no REFUTED member: an unreloaded
--     gateway, a flag that is off, an authorisation wall that hides existence
--     and a genuinely undeployed operation all return the same 404 and cannot
--     be told apart from outside.
--   · "ApiOperationProbe"."authRequiredInFact" is NULL unless both an anonymous
--     and a credentialed request were sent. One anonymous 401 does not
--     establish it — the operation may be 401-ing everybody, including us.
--   · "ComponentItem"."hasCatalogueEntry" is three-state. NULL means no
--     catalogue was read; FALSE means one was and this component is not in it.
--     NULL read as FALSE reports "nothing is in Storybook" about a project
--     whose Storybook we never looked for.
--   · "ManualTestAutomationStatus".NOT_STATED vs .NOT_AUTOMATED. TestRail's
--     automation field is optional and most installs leave it empty; folding
--     empty into NOT_AUTOMATED would let us quote a backlog of 1,630 cases at a
--     customer whose suite never claimed anything about 1,400 of them.
--   · "ManualTestCase"."lastExecutedAt" NULL is "the suite does not say", which
--     is not "never run" — a case with no execution history and a case whose
--     suite has no such field look identical in a CSV export, and one of them
--     is a finding.
--   · "ObservedJourney"."medianDurationMs" is NULL when the source carried no
--     timings. Not 0, which reads as instantaneous.
--   · "TrafficIngest"."capsThatBit" is every cap that ACTUALLY BIT, with the
--     limit it was set to and a FLOOR for what it hid. An empty array means
--     none did, which is a different and far better fact than an empty array
--     because nobody looked. `POST /traffic/:projectId/analyze` applies at
--     least four caps today — 50,000 entries, 500 tests compared, a
--     `maxJourneys` of up to 40, and a per-session step limit — and every one
--     of them is a lever that makes the coverage percentage go UP, because
--     truncating shrinks the denominator while the numerator does not move.
--
-- NOTHING RAW IS PERSISTED BY ANY OF THIS. "ObservedJourney"."steps" holds the
-- parameterised, PII-classified routes `analyzeTraffic` produces and never a
-- raw URL; "TrafficIngest" stores counts and no content at all. The uploads
-- themselves are still never written anywhere, which is the property
-- apps/api/src/routes/traffic.ts was built around.
--
-- NO NEW ENVIRONMENT VARIABLES. A connector's credentials live on an
-- "Integration" row the customer owns, which is what
-- "TrafficIngest"."integrationId" points at.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- CATALOGUE-ONLY, with one exception, and the exception is worth naming first.
--
-- Ten CREATE TYPEs. A new enum type takes no lock on any table.
--
-- Ten CREATE TABLEs with their indexes and foreign keys. Every one is built on
-- an EMPTY relation: the tables do not exist until this statement, so their
-- indexes index nothing and their foreign keys validate against nothing. Each
-- foreign key is declared on the CHILD — the new table — so it takes a brief
-- lock on the parent's definition to add the constraint and NEVER scans or
-- rewrites the parent's rows. "Project", "Test", "User" and "CoverageItem" are
-- the parents touched that way.
--
-- NO EXISTING TABLE GAINS A COLUMN, so there is no rewrite anywhere in this
-- migration and nothing to say about volatile defaults. The relation fields
-- added to "Project", "Test", "User" and "CoverageItem" in schema.prisma are
-- Prisma-side only: a `Requirement[]` on the parent is the reverse side of the
-- child's foreign key and produces no SQL.
--
-- THE ONE EXCEPTION: the five-column unique on "RequirementLink" is named
-- EXPLICITLY, `RequirementLink_claim_key`, because Prisma's generated name
-- would be 74 bytes and PostgreSQL silently truncates identifiers at 63. Had it
-- been left to default, this hand-written DDL and Prisma's introspection would
-- have disagreed about the constraint's name for ever, and every subsequent
-- `migrate dev` would have reported drift it could not fix. The `map:` in
-- schema.prisma and the name below must stay in step.
--
-- One thing to know before deploying: EIGHT of the ten tables have a read and
-- a write path in the same change as this migration, and TWO do not.
-- `scripts/check-wiring.ts` names the two:
--
--   · "ManualTestCase"    — the TestRail/Xray import writes nothing into it
--                           yet, so `manualBacklogTotals` has no rows to count.
--   · "ApiOperationProbe" — nothing probes. "ApiOperation"."verification" is
--                           therefore DECLARED for every row, which is the
--                           honest value and not a placeholder, and
--                           `notProbedReason` stays null because NOT_PROBED is
--                           never set either.
--
-- Both are reported DISCONNECTED, and that is CORRECT — a schema entry for a
-- feature that does not exist is exactly what the check is for. What must not
-- happen is the pair being read as a measurement: an empty "ManualTestCase" is
-- "nobody has imported a suite", NOT "this customer has no manual backlog",
-- and the two tables' readers landing is the signal that this is finished.
--
-- An earlier draft of this header said all ten would report disconnected. That
-- was written before the readers landed beside it and is simply wrong; the
-- count the check prints is two, and a deploy that sees ten has lost eight
-- files.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- CreateEnum
CREATE TYPE "SpecSourceSystem" AS ENUM ('JIRA', 'LINEAR', 'AZURE_DEVOPS', 'GITHUB_ISSUES', 'XRAY', 'ZEPHYR', 'TESTRAIL', 'QTEST', 'MARKDOWN', 'CSV', 'MANUAL');

-- CreateEnum
CREATE TYPE "RequirementStatus" AS ENUM ('DRAFT', 'READY', 'IN_PROGRESS', 'DONE', 'OBSOLETE', 'UNMAPPED', 'NOT_STATED');

-- CreateEnum
CREATE TYPE "AcceptanceCriterionFormat" AS ENUM ('GIVEN_WHEN_THEN', 'BULLET', 'NUMBERED', 'CHECKBOX', 'TABLE_ROW', 'UNSTRUCTURED');

-- CreateEnum
CREATE TYPE "RequirementLinkMethod" AS ENUM ('MANUAL', 'ID_IN_ANNOTATION', 'ID_IN_TEST_NAME', 'SURFACE_MATCH');

-- CreateEnum
CREATE TYPE "RequirementLinkState" AS ENUM ('NOT_SEARCHED', 'NOT_LINKED', 'INFERRED', 'ASSERTED');

-- CreateEnum
CREATE TYPE "ManualTestAutomationStatus" AS ENUM ('NOT_AUTOMATED', 'AUTOMATION_PLANNED', 'AUTOMATED', 'CANNOT_AUTOMATE', 'OBSOLETE', 'NOT_STATED');

-- CreateEnum
CREATE TYPE "ApiAuthDeclaration" AS ENUM ('REQUIRED', 'OPTIONAL', 'NONE', 'UNSTATED', 'NOT_READ');

-- CreateEnum
CREATE TYPE "ApiOperationVerification" AS ENUM ('DECLARED', 'CONFIRMED', 'NO_ANSWER', 'NOT_PROBED');

-- CreateEnum
CREATE TYPE "ComponentItemKind" AS ENUM ('COMPONENT', 'PAGE', 'LAYOUT', 'HOOK', 'CONTEXT_PROVIDER', 'UTILITY');

-- CreateEnum
CREATE TYPE "ComponentStateKind" AS ENUM ('DEFAULT', 'LOADING', 'EMPTY', 'ERROR', 'FORBIDDEN', 'SLOW');

-- CreateTable
CREATE TABLE "Requirement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceSystem" "SpecSourceSystem" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "status" "RequirementStatus" NOT NULL,
    "statusRaw" TEXT,
    "url" TEXT,
    "contentHash" TEXT NOT NULL,
    "contentChangedAt" TIMESTAMP(3),
    "linkState" "RequirementLinkState" NOT NULL DEFAULT 'NOT_SEARCHED',
    "linkedAt" TIMESTAMP(3),
    "firstImportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastImportedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "Requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcceptanceCriterion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "format" "AcceptanceCriterionFormat" NOT NULL,
    "externalId" TEXT,
    "linkState" "RequirementLinkState" NOT NULL DEFAULT 'NOT_SEARCHED',
    "linkedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "AcceptanceCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "criterionId" TEXT,
    "testId" TEXT,
    "coverageItemId" TEXT,
    "method" "RequirementLinkMethod" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" TEXT NOT NULL,
    "byUserId" TEXT,
    "byEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequirementLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualTestCase" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceSystem" "SpecSourceSystem" NOT NULL,
    "title" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "expectedResult" TEXT,
    "url" TEXT,
    "automationStatus" "ManualTestAutomationStatus" NOT NULL,
    "automatedByTestId" TEXT,
    "lastExecutedAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "contentChangedAt" TIMESTAMP(3),
    "firstImportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastImportedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "ManualTestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiOperation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "pathTemplate" TEXT NOT NULL,
    "operationId" TEXT,
    "sourceDocument" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "authDeclaration" "ApiAuthDeclaration" NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '[]',
    "requestShape" JSONB,
    "responseShapes" JSONB,
    "verification" "ApiOperationVerification" NOT NULL DEFAULT 'DECLARED',
    "notProbedReason" TEXT,
    "lastProbedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "ApiOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiOperationProbe" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "environmentId" TEXT,
    "status" INTEGER,
    "verbAllowed" BOOLEAN,
    "authRequiredInFact" BOOLEAN,
    "answered" BOOLEAN NOT NULL,
    "detail" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiOperationProbe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComponentItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "modulePath" TEXT NOT NULL,
    "exportName" TEXT NOT NULL,
    "kind" "ComponentItemKind" NOT NULL,
    "propsSummary" TEXT,
    "hasCatalogueEntry" BOOLEAN,
    "catalogueRef" TEXT,
    "evidence" TEXT NOT NULL,
    "detector" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "ComponentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComponentState" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "kind" "ComponentStateKind" NOT NULL,
    "source" "SurfaceSource" NOT NULL,
    "evidence" TEXT NOT NULL,
    "coverageItemKey" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "ComponentState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficIngest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT,
    "format" TEXT NOT NULL,
    "integrationId" TEXT,
    "observedFrom" TIMESTAMP(3),
    "observedTo" TIMESTAMP(3),
    "entriesParsed" INTEGER NOT NULL,
    "entriesSkipped" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL,
    "journeysStored" INTEGER NOT NULL,
    "journeysDroppedByCap" INTEGER NOT NULL DEFAULT 0,
    "capsThatBit" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedBy" TEXT,

    CONSTRAINT "TrafficIngest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObservedJourney" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ingestId" TEXT NOT NULL,
    "journeyKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "sessionCount" INTEGER NOT NULL,
    "sessionShare" DOUBLE PRECISION NOT NULL,
    "requestCount" INTEGER NOT NULL,
    "errorRate" DOUBLE PRECISION NOT NULL,
    "medianDurationMs" INTEGER,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "ingestCount" INTEGER NOT NULL DEFAULT 1,
    "coverageStatus" TEXT NOT NULL,
    "matchedRatio" DOUBLE PRECISION NOT NULL,
    "missingSteps" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObservedJourney_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- THE IDENTITY. Two trackers may both have a `PROJ-412` and they are not the
-- same requirement, so the system is in the key. This is also what makes the
-- importer's upsert idempotent on a re-import.
CREATE UNIQUE INDEX "Requirement_projectId_sourceSystem_externalId_key" ON "Requirement"("projectId", "sourceSystem", "externalId");

-- CreateIndex
CREATE INDEX "Requirement_orgId_idx" ON "Requirement"("orgId");

-- CreateIndex
-- THE REPORT: "every requirement in this project that no test covers", ordered
-- and paged. Without it that is a scan of every requirement in the install, on
-- a screen a customer opens daily.
CREATE INDEX "Requirement_projectId_linkState_idx" ON "Requirement"("projectId", "linkState");

-- CreateIndex
-- The generation filter. A READY requirement's test is expected to FAIL (the
-- feature is not built) and an OBSOLETE one is not a gap at all, so selection
-- reads by status rather than over everything.
CREATE INDEX "Requirement_projectId_status_idx" ON "Requirement"("projectId", "status");

-- CreateIndex
CREATE INDEX "Requirement_projectId_retiredAt_idx" ON "Requirement"("projectId", "retiredAt");

-- CreateIndex
-- An ordinal is part of a criterion's identity, so a re-import compares the
-- text AT an ordinal and reports a MOVE. Treating a moved criterion as a delete
-- plus an insert would retire a link somebody asserted by hand.
CREATE UNIQUE INDEX "AcceptanceCriterion_requirementId_ordinal_key" ON "AcceptanceCriterion"("requirementId", "ordinal");

-- CreateIndex
CREATE INDEX "AcceptanceCriterion_orgId_idx" ON "AcceptanceCriterion"("orgId");

-- CreateIndex
-- The column the enterprise question is actually asked against. A requirement
-- can be ASSERTED through one criterion while three others are NOT_LINKED, and
-- a matrix with only requirement-level state reports that as covered.
CREATE INDEX "AcceptanceCriterion_linkState_idx" ON "AcceptanceCriterion"("linkState");

-- CreateIndex
-- ONE CLAIM PER (requirement, criterion, target, method), and the name is
-- hand-written because Prisma's would be 74 bytes — see the note above.
--
-- The method is in the key on purpose: the same test may be linked to one
-- criterion by an annotation AND by a surface match, and those are two separate
-- pieces of evidence worth keeping apart. The same method asserting the same
-- thing twice is a duplicate, which is what makes the linker's upsert
-- idempotent.
--
-- NOTE for anyone reading this as an invariant: in PostgreSQL a unique index
-- does NOT constrain rows whose key contains a NULL, and `criterionId`,
-- `testId` and `coverageItemId` are all nullable. So this prevents a duplicate
-- claim about a criterion, and does NOT prevent two identical requirement-level
-- claims. The importer dedupes those; the index is not load-bearing for it, and
-- saying so here is cheaper than someone later discovering it in production.
CREATE UNIQUE INDEX "RequirementLink_claim_key" ON "RequirementLink"("requirementId", "criterionId", "testId", "coverageItemId", "method");

-- CreateIndex
CREATE INDEX "RequirementLink_orgId_idx" ON "RequirementLink"("orgId");

-- CreateIndex
-- "Every guessed link in this project" — the audit read that lets a customer
-- see what the matrix is resting on before they sign anything.
CREATE INDEX "RequirementLink_projectId_method_idx" ON "RequirementLink"("projectId", "method");

-- CreateIndex
CREATE INDEX "RequirementLink_requirementId_idx" ON "RequirementLink"("requirementId");

-- CreateIndex
CREATE INDEX "RequirementLink_criterionId_idx" ON "RequirementLink"("criterionId");

-- CreateIndex
-- "Which requirements does this test cover?" — the reverse read, made by the
-- test detail page and by impact analysis.
CREATE INDEX "RequirementLink_testId_idx" ON "RequirementLink"("testId");

-- CreateIndex
CREATE INDEX "RequirementLink_coverageItemId_idx" ON "RequirementLink"("coverageItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualTestCase_projectId_sourceSystem_externalId_key" ON "ManualTestCase"("projectId", "sourceSystem", "externalId");

-- CreateIndex
CREATE INDEX "ManualTestCase_orgId_idx" ON "ManualTestCase"("orgId");

-- CreateIndex
-- The backlog read: "every case in this project that is not automated", grouped
-- by status. The one number this table exists to produce — and the reason
-- NOT_STATED is its own enum member rather than folded into NOT_AUTOMATED.
CREATE INDEX "ManualTestCase_projectId_automationStatus_idx" ON "ManualTestCase"("projectId", "automationStatus");

-- CreateIndex
CREATE INDEX "ManualTestCase_automatedByTestId_idx" ON "ManualTestCase"("automatedByTestId");

-- CreateIndex
CREATE INDEX "ManualTestCase_projectId_retiredAt_idx" ON "ManualTestCase"("projectId", "retiredAt");

-- CreateIndex
-- THE IDENTITY, and `sourceDocument` is deliberately NOT in it: the same
-- operation declared by two documents is one operation, and keying on the
-- document would double the denominator for every customer who publishes both a
-- gateway spec and a service spec.
CREATE UNIQUE INDEX "ApiOperation_projectId_method_pathTemplate_key" ON "ApiOperation"("projectId", "method", "pathTemplate");

-- CreateIndex
CREATE INDEX "ApiOperation_orgId_idx" ON "ApiOperation"("orgId");

-- CreateIndex
-- "Which declared operations has nothing ever confirmed?" — what makes
-- DECLARED-versus-CONFIRMED a report rather than a column nobody reads.
CREATE INDEX "ApiOperation_projectId_verification_idx" ON "ApiOperation"("projectId", "verification");

-- CreateIndex
-- "Which operations does the document say are public?" — the input to
-- negative-auth generation, which must only run where the document took a
-- position (OPTIONAL or NONE) and never on UNSTATED or NOT_READ.
CREATE INDEX "ApiOperation_projectId_authDeclaration_idx" ON "ApiOperation"("projectId", "authDeclaration");

-- CreateIndex
CREATE INDEX "ApiOperation_projectId_retiredAt_idx" ON "ApiOperation"("projectId", "retiredAt");

-- CreateIndex
CREATE INDEX "ApiOperationProbe_orgId_idx" ON "ApiOperationProbe"("orgId");

-- CreateIndex
-- "The newest probe for this operation", which is every read this table has.
CREATE INDEX "ApiOperationProbe_operationId_observedAt_idx" ON "ApiOperationProbe"("operationId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ComponentItem_projectId_modulePath_exportName_key" ON "ComponentItem"("projectId", "modulePath", "exportName");

-- CreateIndex
CREATE INDEX "ComponentItem_orgId_idx" ON "ComponentItem"("orgId");

-- CreateIndex
-- The UNIT_GEN denominator: "every COMPONENT in this project". Filtered by kind
-- because PAGE and LAYOUT are already counted on the ROUTE axis, and adding
-- them again divides the same application by a larger number.
CREATE INDEX "ComponentItem_projectId_kind_idx" ON "ComponentItem"("projectId", "kind");

-- CreateIndex
CREATE INDEX "ComponentItem_projectId_retiredAt_idx" ON "ComponentItem"("projectId", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ComponentState_componentId_kind_key" ON "ComponentState"("componentId", "kind");

-- CreateIndex
CREATE INDEX "ComponentState_orgId_idx" ON "ComponentState"("orgId");

-- CreateIndex
-- "How many non-DEFAULT states does this project declare, and how many are
-- covered?" — the claim "not just the happy path" rests on.
CREATE INDEX "ComponentState_kind_idx" ON "ComponentState"("kind");

-- CreateIndex
CREATE INDEX "TrafficIngest_orgId_idx" ON "TrafficIngest"("orgId");

-- CreateIndex
CREATE INDEX "TrafficIngest_projectId_createdAt_idx" ON "TrafficIngest"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ObservedJourney_projectId_journeyKey_key" ON "ObservedJourney"("projectId", "journeyKey");

-- CreateIndex
CREATE INDEX "ObservedJourney_orgId_idx" ON "ObservedJourney"("orgId");

-- CreateIndex
-- "The journeys most users take that no test covers" — ordered by share,
-- filtered by status. The one read this table exists for, and the reason
-- `coverageStatus` comes before `sessionShare`: the status is an equality and
-- the share supplies the ORDER BY scanned backwards, so the LIMIT stops early.
CREATE INDEX "ObservedJourney_projectId_coverageStatus_sessionShare_idx" ON "ObservedJourney"("projectId", "coverageStatus", "sessionShare");

-- CreateIndex
CREATE INDEX "ObservedJourney_ingestId_idx" ON "ObservedJourney"("ingestId");

-- AddForeignKey
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcceptanceCriterion" ADD CONSTRAINT "AcceptanceCriterion_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementLink" ADD CONSTRAINT "RequirementLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementLink" ADD CONSTRAINT "RequirementLink_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementLink" ADD CONSTRAINT "RequirementLink_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "AcceptanceCriterion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementLink" ADD CONSTRAINT "RequirementLink_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementLink" ADD CONSTRAINT "RequirementLink_coverageItemId_fkey" FOREIGN KEY ("coverageItemId") REFERENCES "CoverageItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, not Cascade. A link's author leaving the organisation must not delete
-- the CLAIM they made — `byEmail` is what survives, exactly as on
-- "CoverageWaiver", because a waiver or a traceability claim with no owner is a
-- silent exclusion.
ALTER TABLE "RequirementLink" ADD CONSTRAINT "RequirementLink_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualTestCase" ADD CONSTRAINT "ManualTestCase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, not Cascade: deleting a generated test must not delete the
-- customer's manual case. The pair (automationStatus AUTOMATED, id NULL) is
-- then a visible, queryable inconsistency — a case marked automated whose test
-- is gone — rather than a silent downgrade of their suite.
ALTER TABLE "ManualTestCase" ADD CONSTRAINT "ManualTestCase_automatedByTestId_fkey" FOREIGN KEY ("automatedByTestId") REFERENCES "Test"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiOperation" ADD CONSTRAINT "ApiOperation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiOperationProbe" ADD CONSTRAINT "ApiOperationProbe_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "ApiOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentItem" ADD CONSTRAINT "ComponentItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentState" ADD CONSTRAINT "ComponentState_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "ComponentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficIngest" ADD CONSTRAINT "TrafficIngest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservedJourney" ADD CONSTRAINT "ObservedJourney_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservedJourney" ADD CONSTRAINT "ObservedJourney_ingestId_fkey" FOREIGN KEY ("ingestId") REFERENCES "TrafficIngest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- REVERSING THIS, if the deploy has to be undone.
--
-- Order matters: drop the foreign keys and the tables before the types, or the
-- DROP TYPE fails with a dependency error; and drop the CHILDREN before their
-- parents ("RequirementLink" before "AcceptanceCriterion" and "Requirement",
-- "ApiOperationProbe" before "ApiOperation", "ComponentState" before
-- "ComponentItem", "ObservedJourney" before "TrafficIngest") or the DROP TABLE
-- fails for the same reason. `DROP TABLE … CASCADE` would also work and is not
-- used here on purpose: it hides exactly the dependency this ordering states.
--
-- NOTHING PRE-EXISTING IS TOUCHED BY A REVERT. Every object dropped was created
-- by this migration, no existing table gained a column, and no existing row was
-- read or written. That makes this the cheapest revert in the repo's history —
-- and also the most lossy one, which is the part to be clear-eyed about:
--
--   · Every requirement, acceptance criterion, manual test case and
--     requirement→test LINK goes with it. The links are the only objects here
--     that cannot be recovered by re-importing: a MANUAL link is a judgement a
--     person made, and re-importing restores the requirements and not the
--     judgements. EXPORT "RequirementLink" BEFORE REVERTING.
--   · Everything else is re-derivable. Requirements and manual cases come back
--     from their source systems, API operations from the documents,
--     components from the repository, journeys from a re-uploaded log. All of
--     them come back with `contentHash` NULL-free but with no history, so the
--     first import after a re-apply reports NOT_COMPARABLE for every row rather
--     than UNCHANGED — which is correct, and is why `classifyReimport` has that
--     fourth member at all.
--
--   ALTER TABLE "ObservedJourney" DROP CONSTRAINT "ObservedJourney_ingestId_fkey";
--   ALTER TABLE "ObservedJourney" DROP CONSTRAINT "ObservedJourney_projectId_fkey";
--   ALTER TABLE "TrafficIngest" DROP CONSTRAINT "TrafficIngest_projectId_fkey";
--   ALTER TABLE "ComponentState" DROP CONSTRAINT "ComponentState_componentId_fkey";
--   ALTER TABLE "ComponentItem" DROP CONSTRAINT "ComponentItem_projectId_fkey";
--   ALTER TABLE "ApiOperationProbe" DROP CONSTRAINT "ApiOperationProbe_operationId_fkey";
--   ALTER TABLE "ApiOperation" DROP CONSTRAINT "ApiOperation_projectId_fkey";
--   ALTER TABLE "ManualTestCase" DROP CONSTRAINT "ManualTestCase_automatedByTestId_fkey";
--   ALTER TABLE "ManualTestCase" DROP CONSTRAINT "ManualTestCase_projectId_fkey";
--   ALTER TABLE "RequirementLink" DROP CONSTRAINT "RequirementLink_byUserId_fkey";
--   ALTER TABLE "RequirementLink" DROP CONSTRAINT "RequirementLink_coverageItemId_fkey";
--   ALTER TABLE "RequirementLink" DROP CONSTRAINT "RequirementLink_testId_fkey";
--   ALTER TABLE "RequirementLink" DROP CONSTRAINT "RequirementLink_criterionId_fkey";
--   ALTER TABLE "RequirementLink" DROP CONSTRAINT "RequirementLink_requirementId_fkey";
--   ALTER TABLE "RequirementLink" DROP CONSTRAINT "RequirementLink_projectId_fkey";
--   ALTER TABLE "AcceptanceCriterion" DROP CONSTRAINT "AcceptanceCriterion_requirementId_fkey";
--   ALTER TABLE "Requirement" DROP CONSTRAINT "Requirement_projectId_fkey";
--
--   DROP TABLE "ObservedJourney";
--   DROP TABLE "TrafficIngest";
--   DROP TABLE "ComponentState";
--   DROP TABLE "ComponentItem";
--   DROP TABLE "ApiOperationProbe";
--   DROP TABLE "ApiOperation";
--   DROP TABLE "ManualTestCase";
--   DROP TABLE "RequirementLink";
--   DROP TABLE "AcceptanceCriterion";
--   DROP TABLE "Requirement";
--
--   DROP TYPE "ComponentStateKind";
--   DROP TYPE "ComponentItemKind";
--   DROP TYPE "ApiOperationVerification";
--   DROP TYPE "ApiAuthDeclaration";
--   DROP TYPE "ManualTestAutomationStatus";
--   DROP TYPE "RequirementLinkState";
--   DROP TYPE "RequirementLinkMethod";
--   DROP TYPE "AcceptanceCriterionFormat";
--   DROP TYPE "RequirementStatus";
--   DROP TYPE "SpecSourceSystem";
--
-- "SurfaceSource" is NOT dropped: it belongs to 20261024070000 and
-- "ComponentState"."source" only references it.
--
-- `prisma migrate resolve --rolled-back 20261024090000_requirements_api_and_component_surface`
-- then clears the failed-migration marker. NOT a `--roll-forward`: that marks
-- the migration applied without running anything, which on a database where
-- these statements did not execute leaves Prisma's client generating queries
-- against ten tables that do not exist.
