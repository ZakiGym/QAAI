-- Public, read-only share links for a single run.
--
-- Purely additive: one new table, no column added to and no constraint changed
-- on any existing one. Nothing reads or writes RunShare except the new
-- /share routes, so on a live database this is a CREATE TABLE plus three index
-- builds on an empty relation — it takes no lock any running query can notice
-- and there is no backfill to do. Safe to apply while the API is serving.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- CreateTable
CREATE TABLE "RunShare" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),

    CONSTRAINT "RunShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The public endpoint's ONLY lookup: one indexed read on the HMAC of the token
-- the visitor presented. Unique because two links may not collide onto one
-- digest, and because it is what makes that read a single index probe rather
-- than a scan of every link the install has ever minted.
CREATE UNIQUE INDEX "RunShare_tokenHash_key" ON "RunShare"("tokenHash");

-- CreateIndex
CREATE INDEX "RunShare_orgId_idx" ON "RunShare"("orgId");

-- CreateIndex
-- "Is there a live link on this run?" — the run page's control reads it on
-- every open, and the mint path uses it to find what it is replacing.
CREATE INDEX "RunShare_runId_revokedAt_idx" ON "RunShare"("runId", "revokedAt");

-- AddForeignKey
-- CASCADE, and it is the point rather than a default: when a run is deleted by
-- the retention sweep the link to it must stop working in the same statement.
-- A share row that outlived its run would be a live public URL pointing at
-- nothing, and the reader would have to invent a fourth failure mode for it.
ALTER TABLE "RunShare" ADD CONSTRAINT "RunShare_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
