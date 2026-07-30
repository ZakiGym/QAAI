/**
 * Thin API client. Every call carries the session cookie, so the browser and
 * the API share one auth mechanism and the cockpit needs no token handling.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `Request failed with ${response.status}`,
    );
  }

  return (await response.json()) as T;
}

// ─── Shapes the cockpit renders ──────────────────────────────────────────────

export interface Step {
  id: string;
  index: number;
  title: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  screenshotKey: string | null;
  errorMessage: string | null;
  selector: string | null;
  expected: string | null;
  actual: string | null;
}

export interface Finding {
  id: string;
  kind: string;
  severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';
  code: string;
  message: string;
  location: string;
  helpUrl: string | null;
}

export interface Verdict {
  id: string;
  verdict: 'REAL_BUG' | 'INTENDED_CHANGE' | 'FLAKE' | 'ENV_ISSUE';
  confidence: number;
  explanation: string;
  evidence: Array<{ kind: string; ref: string; detail: string }>;
  reviewState: 'PENDING' | 'ACCEPTED' | 'OVERRIDDEN' | 'MUTED';
  model: string;
}

export interface TestResult {
  id: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'FLAKY' | 'TIMED_OUT';
  durationMs: number;
  errorMessage: string | null;
  retriedAndPassed: boolean;
  videoKey: string | null;
  traceKey: string | null;
  test: {
    id: string;
    name: string;
    type: string;
    priority: string;
    filePath: string;
    quarantined: boolean;
  };
  steps: Step[];
  findings: Finding[];
  verdict: Verdict | null;
}

export interface Run {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'CANCELLED' | 'ERRORED';
  trigger: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalCount: number;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  skippedCount: number;
  gateResult: {
    passed: boolean;
    evaluations: Array<{ passed: boolean; action: string; detail: string }>;
  } | null;
  environment: { name: string; kind: string; baseUrl?: string };
  results?: TestResult[];
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  primaryFramework: string;
  environments: Array<{ id: string; name: string; kind: string; baseUrl: string }>;
  _count: { tests: number; runs: number };
}

export const artifactUrl = (runId: string, key: string) =>
  `${API_URL}/runs/${runId}/artifacts/${key.split('/').map(encodeURIComponent).join('/')}`;
