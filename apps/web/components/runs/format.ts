import type { Run } from '../../lib/api';
import { duration } from '../ui';

/**
 * A run row as `GET /runs` actually returns it.
 *
 * These five columns have been on the wire since they were written and the
 * shared `Run` interface in lib/api.ts — which the Runs section does not own —
 * never described them. `projectId` is what lets one unfiltered fetch feed both
 * the fleet tiles and a project-scoped log; `stopReason` and `errorMessage` are
 * the difference between a red row that says "6 failed" and one that says why.
 * They belong in lib/api.ts next time that file is opened.
 */
export type RunRow = Run & {
  projectId?: string;
  shardCount?: number;
  /** Set when the run itself blew up rather than its tests failing. */
  errorMessage?: string | null;
  /** Why a fail-fast run stopped early, in a sentence written to be shown. */
  stopReason?: string | null;
};

/**
 * The formatting the Runs section shares between its two screens.
 *
 * Both the run log and the cockpit header render "how long did this take" and
 * "what state is it in", and they were drifting: the cockpit had its own
 * `wallClock`, the list used the raw `duration()` primitive, and a twelve-minute
 * nightly read as `760.4s` in one place and `12m 40s` in the other.
 */

/**
 * How long something took, in units a person compares at a glance.
 *
 * `duration()` renders everything above a second in seconds, which is right for
 * a step and wrong for a run: nobody can rank `760.4s` against `482.0s` without
 * doing arithmetic, and ranking runs is the entire job of the run log. Under a
 * minute it defers to the primitive so the two never disagree.
 *
 * Hours roll over too, because they happen: a run handed to an on-prem pool with
 * no live agent sits in the queue until it is swept, and `1116m12s` is not a
 * number anybody reads — it is a number they count the digits of.
 */
export function wallClock(ms: number): string {
  if (ms < 60_000) return duration(ms);
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    return `${hours}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
  }
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** The compact column form — `12m40s`, no space, for the 52px duration cell. */
export function wallClockTight(ms: number): string {
  return wallClock(ms).replace(' ', '');
}

/**
 * A run's elapsed time, or null when there is nothing honest to say.
 *
 * A queued run has not started, so it has no duration — a zero would read as
 * "finished instantly". A running one is still counting, which is why `now` is
 * passed in rather than read here: the caller owns the clock and only ticks it
 * while something is moving.
 */
export function runElapsedMs(
  run: Pick<Run, 'startedAt' | 'finishedAt'>,
  now: number,
): number | null {
  if (!run.startedAt) return null;
  const started = new Date(run.startedAt).getTime();
  if (Number.isNaN(started)) return null;
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  return Math.max(0, end - started);
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * The status word and its colour.
 *
 * Five characters, mono, in a fixed 52px column, because that is what makes a
 * list of twenty-five runs scannable down its left edge rather than read
 * left-to-right one row at a time.
 *
 * ERRORED gets its own word rather than folding into FAIL: a run whose tests
 * failed and a run that never got to run its tests are different problems, and
 * the second one is not about the app under test at all.
 */
export interface StatusWord {
  word: string;
  tone: string;
  /** Runs in flight pulse. Nothing else does. */
  live: boolean;
}

const STATUS_WORDS: Record<string, StatusWord> = {
  PASSED: { word: 'PASS', tone: 'text-pass', live: false },
  FAILED: { word: 'FAIL', tone: 'text-fail', live: false },
  ERRORED: { word: 'ERR', tone: 'text-fail', live: false },
  RUNNING: { word: 'RUN', tone: 'text-accent', live: true },
  QUEUED: { word: 'QUEUE', tone: 'text-ink-faint', live: false },
  CANCELLED: { word: 'STOP', tone: 'text-ink-faint', live: false },
};

export function statusWord(status: string): StatusWord {
  return STATUS_WORDS[status] ?? { word: status.slice(0, 5), tone: 'text-ink-faint', live: false };
}

/** A run nobody is waiting on any more. */
export const TERMINAL_RUN = new Set(['PASSED', 'FAILED', 'ERRORED', 'CANCELLED']);

// ─── Day grouping ────────────────────────────────────────────────────────────

/** Local midnight, as the key the run log groups on. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? 'unknown'
    : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * `TODAY`, `YESTERDAY`, or the date.
 *
 * Relative for the two days a person is actually working in, absolute after
 * that — "4 days ago" is a number you have to convert before it means anything,
 * and by then the run is history rather than news.
 */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'EARLIER';
  if (dayKey(iso) === dayKey(now.toISOString())) return 'TODAY';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'YESTERDAY';
  return d
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    .toUpperCase();
}
