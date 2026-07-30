/** Small shared primitives for the cockpit. */

const STATUS_COLOUR: Record<string, string> = {
  PASSED: 'bg-pass',
  FAILED: 'bg-fail',
  ERRORED: 'bg-fail',
  TIMED_OUT: 'bg-fail',
  FLAKY: 'bg-flake',
  RUNNING: 'bg-accent animate-pulse',
  QUEUED: 'bg-skip',
  SKIPPED: 'bg-skip',
  CANCELLED: 'bg-skip',
};

export function StatusDot({ status }: { status: string }) {
  return (
    <span
      aria-label={status.toLowerCase()}
      title={status}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_COLOUR[status] ?? 'bg-skip'}`}
    />
  );
}

const VERDICT_STYLE: Record<string, string> = {
  REAL_BUG: 'border-fail/50 bg-fail/10 text-fail',
  INTENDED_CHANGE: 'border-accent/50 bg-accent/10 text-accent',
  FLAKE: 'border-flake/50 bg-flake/10 text-flake',
  ENV_ISSUE: 'border-line bg-surface-2 text-ink-dim',
};

export function VerdictChip({ verdict, confidence }: { verdict: string; confidence?: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-xs ${
        VERDICT_STYLE[verdict] ?? VERDICT_STYLE.ENV_ISSUE
      }`}
    >
      {verdict}
      {confidence !== undefined && (
        <span className="opacity-70">{Math.round(confidence * 100)}%</span>
      )}
    </span>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  CRITICAL: 'text-fail',
  SERIOUS: 'text-fail/80',
  MODERATE: 'text-flake',
  MINOR: 'text-ink-faint',
};

export function SeverityLabel({ severity }: { severity: string }) {
  return (
    <span className={`font-mono text-micro ${SEVERITY_STYLE[severity] ?? 'text-ink-faint'}`}>
      {severity}
    </span>
  );
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
