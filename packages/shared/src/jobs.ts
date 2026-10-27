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

/**
 * Turn a stored codebase analysis into proposed scenarios.
 *
 * Declared here rather than only in the worker because the API is the producer:
 * the worker registered a consumer for this queue and the endpoint that feeds
 * it was never written, so the analysis a source ingest computed sat in the
 * database with nothing to act on it.
 */
export interface AnalyzeSourceJob {
  orgId: string;
  projectId: string;
  /** Who asked, for the audit row and the plan's provenance. */
  requestedBy: string;
  /** Skip the approval screen and generate straight away (onboarding only). */
  autoApprove?: boolean;
}

/**
 * One attempt, and one analysis per project IN FLIGHT. Both halves matter, and
 * the two producers of this queue each had the opposite half wrong.
 *
 * `attempts: 1` because the processor WRITES: `flowMap.create` and
 * `testPlan.create`, plain creates and not upserts. A retry does not re-do the
 * work, it duplicates it, and the person is left approving one of two identical
 * plans. apps/api/src/lib/queues.ts states that rule on its own `attempts`
 * parameter — "a job whose processor is not idempotent must pass attempts:1" —
 * and the API's producer did not pass it, so the live path inherited the queue
 * default of 3.
 *
 * `removeOnComplete` AND `removeOnFail`, both, because a BullMQ job id is a
 * Redis key and this one is keyed on the PROJECT rather than on a one-shot
 * entity. A retained completed — or worse, FAILED — job keeps the key, and
 * every later `add()` for that project collapses onto the corpse. Nothing logs
 * an error: the API still answers 202 `{ queued: true }`, the audit row still
 * records `source.analyze`, and no plan is ever proposed. The worker's
 * `enqueueAnalyzeSource` pinned the id and set neither, so its own comment's
 * "one analysis per project in flight" actually meant one per project EVER.
 *
 * This is the same defect `enqueueExplore` was fixed for, in the same file. The
 * comment there lists the producers deliberately left alone — `run-<id>`,
 * `triage-<resultId>`, `bisect-<id>-<step>`, `deliver-<id>`, all ids of a
 * one-shot-per-entity thing where permanent de-duplication is what is wanted.
 * `analyze-source-<projectId>` is not one of those and was not on the list; it
 * was missed. The canonical statement of the trap is on
 * apps/worker/src/processors/recompute-coverage.ts.
 *
 * The cost is that a failed analysis leaves Redis rather than sitting in the
 * failed set, and that is the right trade for the same reason it is right for
 * explore: the processor records its outcome in the DATABASE, whereas a
 * swallowed enqueue is readable nowhere.
 *
 * Lives in shared, beside the payload, because the API and the worker are
 * separate apps that cannot import each other's modules and each had its own
 * copy of these options. Two producers of one queue whose retry and
 * de-duplication semantics disagree is how one install duplicates plans while
 * another silently proposes none.
 */
export const ANALYZE_SOURCE_ATTEMPTS = 1;

export function analyzeSourceJobOptions(projectId: string): {
  jobId: string;
  attempts: number;
  removeOnComplete: true;
  removeOnFail: true;
} {
  return {
    jobId: `analyze-source-${projectId}`,
    attempts: ANALYZE_SOURCE_ATTEMPTS,
    removeOnComplete: true,
    removeOnFail: true,
  };
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
  'qaai.analyze-source': AnalyzeSourceJob;
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
