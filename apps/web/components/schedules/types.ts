/**
 * The shapes GET /automation/:projectId returns.
 *
 * These live here rather than in lib/api.ts because they are read by exactly
 * one screen and nothing else in the app has an opinion about a schedule. Every
 * timestamp is a string: it crossed JSON to get here, and typing it as `Date`
 * is the lie that produces `lastRunAt.getTime is not a function` in production.
 */

export type RunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'PASSED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ERRORED';

export interface AutomationLastRun {
  id: string;
  status: RunStatus;
  queuedAt: string;
  finishedAt: string | null;
  totalCount: number;
  passedCount: number;
  failedCount: number;
}

interface AutomationCommon {
  id: string;
  name: string;
  enabled: boolean;
  suiteId: string;
  environmentId: string;
  lastRun: AutomationLastRun | null;
  /**
   * True when more than one schedule (or monitor) points at this same suite and
   * environment, so no run can be attributed to one of them in particular. The
   * row says so instead of showing somebody else's result.
   */
  lastRunAmbiguous: boolean;
}

export interface Schedule extends AutomationCommon {
  cron: string;
  /** IANA zone. THIS is the zone the worker fires in — not the browser's. */
  timezone: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface Monitor extends AutomationCommon {
  intervalMinutes: number;
  failureThreshold: number;
  consecutiveFailures: number;
  lastStatus: RunStatus | null;
  lastCheckedAt: string | null;
}

export interface SuiteRef {
  id: string;
  name: string;
}

export interface EnvironmentRef {
  id: string;
  name: string;
  kind: string;
}

export interface AutomationView {
  project: { id: string; name: string };
  schedules: Schedule[];
  monitors: Monitor[];
  suites: SuiteRef[];
  environments: EnvironmentRef[];
}

/** What both dialogs hand back. The monitor half is ignored for a schedule. */
export interface ScheduleDraft {
  name: string;
  suiteId: string;
  environmentId: string;
  cron: string;
  timezone: string;
}

export interface MonitorDraft {
  name: string;
  suiteId: string;
  environmentId: string;
  intervalMinutes: number;
  failureThreshold: number;
}
