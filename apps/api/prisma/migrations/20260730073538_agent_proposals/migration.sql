-- CreateEnum
CREATE TYPE "ProposalState" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "error" TEXT,
ADD COLUMN     "pending" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AgentProposal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "testId" TEXT,
    "filePath" TEXT NOT NULL,
    "oldCode" TEXT NOT NULL,
    "newCode" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "testType" "TestType" NOT NULL DEFAULT 'E2E',
    "state" "ProposalState" NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentProposal_orgId_state_idx" ON "AgentProposal"("orgId", "state");

-- CreateIndex
CREATE INDEX "AgentProposal_conversationId_idx" ON "AgentProposal"("conversationId");

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
