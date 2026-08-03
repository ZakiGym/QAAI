/**
 * Ages, in the two lengths this section needs.
 *
 * `shortAgo` is the mono column form — `4s`, `46m`, `2d`. It is deliberately
 * NOT a sentence: it sits in a tabular-nums column next to five others, and the
 * whole point of that column is that the eye can compare them without reading.
 *
 * Rounded down, like `elapsed` in RunnerList and for the same reason: claiming
 * an hour when it has been fifty-nine minutes is the kind of small dishonesty
 * that makes an operator stop believing the screen.
 */
export function shortAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `mm:ss`, for a duration that is being watched rather than reported. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
