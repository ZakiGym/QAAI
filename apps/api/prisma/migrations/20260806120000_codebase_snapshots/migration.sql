-- What QAAI learned from an application's source (§7).
--
-- Sibling of ImportBatch, not an extension of it: that table's subject is a test
-- suite being converted, this one's is the application being understood. The
-- file bodies are deliberately absent — `paths` is a JSON string[], and nothing
-- re-reads a customer's source, so storing it would be a liability with no
-- consumer.

-- CreateTable
CREATE TABLE "CodebaseSnapshot" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "paths" JSONB NOT NULL,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "withContent" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" INTEGER NOT NULL DEFAULT 0,
    "detection" JSONB NOT NULL,
    "analysis" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodebaseSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodebaseSnapshot_orgId_projectId_idx" ON "CodebaseSnapshot"("orgId", "projectId");
