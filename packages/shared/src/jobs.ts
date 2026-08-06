/**
 * Job payloads on the BullMQ queues (§5). The API enqueues, the worker consumes,
 * and this file is the only contract between them.
 *
 * Payloads carry ids, never objects. A job may sit in the queue for minutes; by
 * the time it runs, an embedded copy of a project or a test could be stale, so
 * the worker always re-reads from the database.
 */

import type { RunTrigger } from './job-enums';

export interface ExploreJob {
  orgId: string;
  projectId: string;
  environmentId: string;
  /** Who asked, for the audit log and the activity feed. */
  requestedBy: string;
  maxPages: number;
  maxDepth: number;
  /** Skip straight to generating tests for every proposed item (onboarding). */
  autoApprove: boolean;
}

export interface GenerateJob {
  orgId: string;
  projectId: string;
  testPlanId: string;
  planItemIds: string[];
  requestedBy: string;
}

export interface RunJob {
  orgId: string;
  runId: string;
}

export interface TriageJob {
  orgId: string;
  runId: string;
  testResultId: string;
}

export interface CopilotJob {
  orgId: string;
  projectId: string;
  conversationId: string;
  userMessageId: string;
}

/** One inline edit: the agent rewrites a test from a plain-English instruction. */
export interface EditJob {
  orgId: string;
  projectId: string;
  /** The AgentProposal row the worker fills in. */
  proposalId: string;
  instruction: string;
  selection: string;
  selectionStartLine: number;
  selectionEndLine: number;
}

export interface ImportJob {
  orgId: string;
  projectId: string;
  /** Persisted on the ImportBatch row; the worker reads the files from there. */
  importBatchId: string;
  requestedBy: string;
}

export interface NotifyJob {
  orgId: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface ScheduleTickJob {
  /** Empty — the worker sweeps for due schedules itself. */
  at: string;
}

export interface JobPayloads {
  'qaai.explore': ExploreJob;
  'qaai.generate': GenerateJob;
  'qaai.run': RunJob;
  'qaai.triage': TriageJob;
  'qaai.notify': NotifyJob;
  'qaai.copilot': CopilotJob;
  'qaai.edit': EditJob;
  'qaai.import': ImportJob;
  'qaai.schedule': ScheduleTickJob;
}

export interface CreateRunRequest {
  projectId: string;
  environmentId: string;
  suiteId: string | null;
  testIds: string[] | null;
  trigger: RunTrigger;
  triggeredBy: string | null;
  commitSha: string | null;
  branch: string | null;
  prNumber: number | null;
  baseUrlOverride: string | null;
}
