-- One ticket per CAUSE, and a failure that knows whose it is.
--
-- WHY THIS EXISTS
--
-- Two defects, one shape: a failure could not reach the person who can fix it,
-- and when it did it arrived forty times.
--
-- 1. ONE TICKET PER FAILING RESULT. `POST /issues` took a single `resultId`,
--    and the only record of a filed ticket was "TriageVerdict"."issueUrl" — one
--    column on one result. That column can express "this result has a ticket"
--    and nothing else, so a shared dependency dying (one bug, forty tests
--    downstream of it) meant forty presses of the one-click button and forty
--    tickets, each with its own screenshot of the same cause. There was also
--    nowhere at all to record a ticket filed for something that is not a
--    result: an untested surface has no "TestResult" row, so the gap list —
--    the thing this product is sold on — could not be filed at all.
--
-- 2. THE VERDICT WAS NEVER ASSIGNED. Ownership already resolved in two places
--    (the digest's labels, GET /team/ownership/resolve) and both are reads:
--    nothing was ever written onto the failure, so every failure sat in a queue
--    that belongs to everybody, which in practice means nobody.
--
-- WHY "TrackerIssue" IS A TABLE AND NOT MORE COLUMNS ON "TriageVerdict"
--
-- Because the ticket is about a CAUSE, and a cause is not a row in any existing
-- table. It spans N results (a cluster signature), or none at all (a coverage
-- gap). "causeKey" is the idempotence key — sha256 of the subject, the project
-- and the cause's identity — and it is UNIQUE per org, so the second file for
-- the same cause finds the ticket already on the board and links to it instead
-- of minting a second one. That uniqueness is the whole feature; it is enforced
-- by the database rather than by a check-then-insert, because two clicks half a
-- second apart are exactly how the original defect reproduced.
--
-- "TriageVerdict"."issueCauseKey" is the other half: every member of a cause
-- carries the same "issueUrl" AND the same "issueCauseKey", so the triage card
-- for each of the forty failures links to the one ticket, and a later failure
-- with the same signature joins it.
--
-- NO FOREIGN KEYS ON "TrackerIssue", DELIBERATELY
--
-- Not to "Integration", not to "Project". The url points at a ticket on
-- someone else's system, and that ticket exists whether or not the integration
-- that filed it is still connected. Cascading this row away when an admin
-- disconnects a tracker would delete the only record that the bug was already
-- reported — and the next run would file it again, which is the defect this
-- migration exists to close.
--
-- WHY THE OWNER STATE IS A COLUMN AND NOT AN ABSENCE
--
-- "assigneeUserId" IS NULL has four possible meanings and only one of them is
-- benign: nobody has written any rules, the rules exist and none match, the
-- rules that would have matched could not be evaluated (routing has silently
-- STOPPED, which looks exactly like an unassigned suite), or nothing has tried
-- to route this verdict yet. "ownerState" keeps them apart —
-- OWNED / NO_RULES / NO_MATCH / RULES_UNUSABLE, with NULL reserved for the
-- fourth — and "ownerNote" carries the sentence a human reads. An unowned
-- failure that LOOKS owned is worse than one that is visibly unowned, and a
-- nullable id alone cannot tell the two apart.
--
-- TEXT, NOT AN ENUM, for "subject" and the two state columns. The same reason
-- "MutationSurvivor"."reason" is text: apps/api/scripts/check-enums.ts enforces
-- schema/TypeScript parity from a hand-maintained list, so an enum added
-- without an entry in it is an enum whose drift nothing guards — and the drift
-- it hides is a value the database accepts that TypeScript has never heard of.
-- The domain is enforced at the producer (OWNERSHIP_STATES and ISSUE_SUBJECTS
-- in apps/api/src/lib/ownership.ts, which is the only writer). Promote them in
-- the same change that adds their parity entries.
--
-- NO NEW INDEX ON "TriageVerdict", ALSO DELIBERATELY
--
-- Nothing queries the new columns by value yet: they are written per verdict
-- and read back by id. "Show me the failures assigned to me" is the read that
-- wants ("orgId", "assigneeUserId") and it does not exist — the triage list in
-- apps/api/src/routes/team.ts still filters by review state. An index with no
-- reader is pure write amplification on the hottest write path in triage, so it
-- belongs in the same change as the query that needs it.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- SEVEN ADD COLUMNs on "TriageVerdict", every one nullable with no default, so
-- on PostgreSQL 11+ none of them rewrites the table: the catalogue records the
-- new attributes and existing rows are not touched. Existing verdicts keep
-- NULL in "ownerState", which reads as "never routed" — correct, and the
-- reason that state is reserved rather than back-filled to NO_MATCH, which
-- would be a claim about rules that may not have existed yet.
--
-- One CREATE TABLE and two index builds on an empty relation.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- AlterTable
ALTER TABLE "TriageVerdict" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assigneeTeamId" TEXT,
ADD COLUMN     "assigneeUserId" TEXT,
ADD COLUMN     "issueCauseKey" TEXT,
ADD COLUMN     "ownerNote" TEXT,
ADD COLUMN     "ownerRuleId" TEXT,
ADD COLUMN     "ownerState" TEXT;

-- CreateTable
CREATE TABLE "TrackerIssue" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "causeKey" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "provider" "IntegrationKind" NOT NULL,
    "integrationId" TEXT,
    "url" TEXT NOT NULL,
    "key" TEXT,
    "title" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "ownerTeamId" TEXT,
    "ownerState" TEXT NOT NULL,
    "affectedCount" INTEGER NOT NULL DEFAULT 0,
    "subjectKeys" JSONB NOT NULL DEFAULT '[]',
    "filedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackerIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The idempotence key itself. UNIQUE because this is the constraint that stops
-- the second ticket: the filing path reads through it and, on a race, the
-- insert that loses gets a constraint violation instead of a duplicate board
-- entry. "orgId" leads because the tenant extension makes it an equality on
-- every read.
CREATE UNIQUE INDEX "TrackerIssue_orgId_causeKey_key" ON "TrackerIssue"("orgId", "causeKey");

-- CreateIndex
-- "Which gaps in this project are already filed?" — the read the surface report
-- makes so a cockpit list can mark a gap as reported rather than offering to
-- file it twice.
CREATE INDEX "TrackerIssue_projectId_subject_idx" ON "TrackerIssue"("projectId", "subject");
