-- Verification of an applied heal, and the link from a superseded proposal to
-- the one that replaced it.
--
-- WHY THIS EXISTS
--
-- `HealProposal.state = 'APPLIED'` was a claim nobody checked. Both apply paths
-- — the human-approved one in apps/api/src/routes/agent.ts and the unattended
-- one in apps/worker/src/processors/triage.ts — wrote the patched code, wrote a
-- TestVersion, flipped the state, and stopped. The test was never run again. So
-- a heal that applied cleanly, parsed, kept every assertion and still did not
-- FIX ANYTHING was recorded as applied, and the next human to look saw a
-- handled problem where there was a red test.
--
-- That is worse than no healing at all: an unhealed failure stays on the board.
--
-- WHAT THE COLUMNS ARE FOR
--
--   "verifyRunId"    the single-test Run started against the applied heal. A
--                    real Run row through the real queue, for the same reason
--                    the flake radar's confirmation runs are real Runs: a
--                    result produced through a private execution path is a
--                    measurement of the private path.
--   "verifyState"    PENDING -> VERIFIED | STILL_FAILING | UNVERIFIABLE.
--   "verifiedAt"     when the verdict landed.
--   "verifyNote"     the sentence a human reads, including the reason a
--                    verification could not be run at all.
--   "appliedVersion" the TestVersion this heal wrote. The revert path's only
--                    way back: without it, an auto-applied heal that fails
--                    verification can only be undone by guessing which version
--                    preceded it.
--   "supersededById" which proposal replaced this one.
--   "evidence"       machine-readable backing for a proposal no model wrote —
--                    the deflake findings, or the routes and locators behind a
--                    retirement.
--
-- NULL IS "NO CLAIM", AND THAT IS THE POINT
--
-- Every column here is nullable with NO DEFAULT and nothing is back-filled. A
-- proposal that was never applied has nothing to verify, and the three states
-- that must stay distinguishable are:
--
--   "verifyState" NULL            nobody applied this, so nothing was verified.
--   "verifyState" 'PENDING'       applied, and the verifying run has not landed.
--   "verifyState" 'UNVERIFIABLE'  applied, and we are telling you nobody
--                                 checked — no environment to run in, the org
--                                 is at its run cap, the run errored.
--
-- Defaulting the column to 'PENDING' would have claimed a verification was
-- under way for every heal ever applied before this migration, and the sweep
-- would then have chased runs that do not exist. Defaulting it to 'VERIFIED'
-- would be the original defect with a column attached.
--
-- "verifyState" IS TEXT AND NOT A PRISMA ENUM
--
-- Same reasoning as "MutationSurvivor"."reason":
-- apps/api/scripts/check-enums.ts enforces schema/TypeScript enum parity from a
-- HAND-MAINTAINED list, so a new enum with no entry in that list is an enum
-- with no drift guard — and the drift it hides is a value the database accepts
-- that TypeScript has never heard of. The domain is enforced at the producer
-- (HEAL_VERIFY_STATES in packages/agent/src/healer.ts, the only writer).
-- Promote it in the same change that adds its parity entry.
--
-- APPLYING THIS ON A LIVE DATABASE
--
-- Seven ADD COLUMNs on "HealProposal", every one nullable with no default, so
-- on PostgreSQL 11+ none of them rewrites the table. "HealProposal" is a small
-- table anyway — one row per proposed fix — but the property is worth keeping
-- for the same reason it mattered on "TestResult".
--
-- One index build, on that same small table.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- AlterTable
ALTER TABLE "HealProposal" ADD COLUMN     "appliedVersion" INTEGER,
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "supersededById" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifyNote" TEXT,
ADD COLUMN     "verifyRunId" TEXT,
ADD COLUMN     "verifyState" TEXT;

-- CreateIndex
-- The verification sweep's own query: "which applied heals are still waiting on
-- a verdict?", asked once per tick across every org. Without it that is a scan
-- of every heal the install has ever proposed, and because the overwhelming
-- majority of rows have "verifyState" NULL, this index stays tiny — Postgres
-- stores the NULLs but the PENDING set is what the sweep reads.
CREATE INDEX "HealProposal_verifyState_idx" ON "HealProposal"("verifyState");
