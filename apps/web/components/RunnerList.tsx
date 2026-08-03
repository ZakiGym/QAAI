'use client';

import Link from 'next/link';
import type { Runner, RunnerJob } from '../lib/api';
import { cn } from '../lib/cn';
import { shortAgo } from './setup/time';

/**
 * The fleet, told the truth about.
 *
 * The hard fact this component exists to render: **we never dial a runner.** An
 * agent behind a customer's firewall that dies gives us no RST, no timeout, no
 * signal at all — a missing heartbeat is the only evidence we will ever have.
 * So liveness here is derived from `lastSeenAt` and stated with a number in it
 * ("silent for 46m"), because how long is the whole question. A green dot that
 * goes grey tells the person on call nothing.
 *
 * Four states, and they are genuinely different situations:
 *
 *   never   The token was minted and no agent has ever presented it. Nothing is
 *           wrong yet — it has not been started.
 *   live    Heard from inside the online window the API uses (60s).
 *   quiet   Silent, but for less than the 15-minute grace the server waits
 *           before it starts declaring work unservable. A restarting agent
 *           lives here, and calling it dead would be wrong.
 *   stale   Silent past that grace. This is the one that costs test coverage:
 *           queued work only this runner could serve is now being SKIPPED, and
 *           skipped tests are green-ish in every report that counts failures.
 *
 * Rows, not cards. Three runners as three bordered panels is three boxes to
 * read; three hairlines is a fleet you can scan for the one red dot.
 */

/** Mirrors RUNNER_ONLINE_MS in apps/api/src/lib/runners.ts. */
const ONLINE_MS = 60_000;
/** Mirrors RUNNER_UNSERVABLE_GRACE_MS — when silence starts costing coverage. */
const STALE_MS = 15 * 60_000;
/** Mirrors RUNNER_HEARTBEAT_MS, quoted in the copy so the number is checkable. */
const HEARTBEAT_SECONDS = 15;

/** Job statuses that mean a runner is holding work right now. */
const HELD: readonly RunnerJob['status'][] = ['CLAIMED', 'RUNNING'];

export function heldJobsFor(jobs: readonly RunnerJob[], runnerId: string): RunnerJob[] {
  return jobs.filter((job) => job.runnerId === runnerId && HELD.includes(job.status));
}

/**
 * "40 minutes", not "40m ago" — this goes inside a sentence.
 *
 * Rounded down deliberately: claiming 60 minutes when it has been 59 is the
 * kind of small dishonesty that makes an operator stop believing the screen.
 */
export function elapsed(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export interface Liveness {
  state: 'never' | 'live' | 'quiet' | 'stale';
  /** The row's own sentence — short, with the number that matters in it. */
  line: string;
  /** The long form, for the confirmation that acts on this runner. */
  sentence: string;
  /** The mono age column: `4s ago`, `46m`. Empty when it has never connected. */
  age: string;
  dot: string;
  text: string;
}

export function liveness(runner: Runner, now = Date.now()): Liveness {
  if (!runner.lastSeenAt) {
    return {
      state: 'never',
      line: `never connected — registered ${elapsed(runner.createdAt, now)} ago`,
      sentence: `Registered ${elapsed(runner.createdAt, now)} ago, and no agent has ever presented this token. Start the agent on the host with the token you were given.`,
      age: '',
      dot: 'bg-skip',
      text: 'text-ink-faint',
    };
  }

  const silent = elapsed(runner.lastSeenAt, now);
  const short = shortAgo(runner.lastSeenAt, now);
  const silentMs = now - new Date(runner.lastSeenAt).getTime();

  if (runner.online && silentMs < ONLINE_MS) {
    return {
      state: 'live',
      line: 'idle',
      sentence: `Last heard from ${silent} ago.`,
      age: `${short} ago`,
      dot: 'bg-pass',
      text: 'text-pass',
    };
  }

  if (silentMs < STALE_MS) {
    return {
      state: 'quiet',
      line: `quiet for ${short} — it calls home every ${HEARTBEAT_SECONDS}s, so it is restarting or it cannot reach us`,
      sentence: `We have not heard from this runner in ${silent}. It calls home every ${HEARTBEAT_SECONDS} seconds, so it is restarting, or it cannot reach QAAI from where it runs.`,
      age: short,
      dot: 'bg-flake',
      text: 'text-flake',
    };
  }

  return {
    state: 'stale',
    line: `silent for ${short} — its queued work is being skipped`,
    sentence: `We have not heard from this runner in ${silent}. Treat it as gone: queued work that no online runner can serve is skipped after 15 minutes, and those tests report as skipped — not failed — so a green build can hide them.`,
    age: short,
    dot: 'bg-fail',
    text: 'text-fail',
  };
}

/** `chromium 126 · node 20 · pool staging` — what it says it can do. */
function capabilityLine(runner: Runner): string {
  const caps = runner.capabilities;
  const parts = [...caps.browsers, ...caps.toolchains, ...caps.languages];
  parts.push(runner.pools.length === 0 ? 'default pool' : `pool ${runner.pools.join(', ')}`);
  return parts.join(' · ');
}

export function RunnerList({
  runners,
  jobs,
  canManage,
  busyId,
  onRotate,
  onRevoke,
  now,
}: {
  runners: Runner[];
  /** The queue, so each runner can say what it is executing right now. */
  jobs: RunnerJob[];
  /** ADMIN and OWNER only — the API enforces it; the UI should not pretend. */
  canManage: boolean;
  busyId: string | null;
  onRotate: (runner: Runner) => void;
  onRevoke: (runner: Runner) => void;
  /** Passed in so every row on the screen ages against the same clock. */
  now: number;
}) {
  return (
    <div>
      {runners.map((runner) => (
        <RunnerRow
          key={runner.id}
          runner={runner}
          held={heldJobsFor(jobs, runner.id)}
          canManage={canManage}
          busy={busyId === runner.id}
          onRotate={() => onRotate(runner)}
          onRevoke={() => onRevoke(runner)}
          now={now}
        />
      ))}
    </div>
  );
}

function RunnerRow({
  runner,
  held,
  canManage,
  busy,
  onRotate,
  onRevoke,
  now,
}: {
  runner: Runner;
  held: RunnerJob[];
  canManage: boolean;
  busy: boolean;
  onRotate: () => void;
  onRevoke: () => void;
  now: number;
}) {
  const live = liveness(runner, now);
  const introduced =
    runner.capabilities.browsers.length > 0 ||
    runner.capabilities.testTypes.length > 0 ||
    runner.capabilities.languages.length > 0 ||
    runner.capabilities.toolchains.length > 0;

  return (
    <div
      className={cn(
        'border-line flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b py-3',
        busy && 'opacity-60',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-[7px] w-[7px] shrink-0 rounded-full',
          live.dot,
          live.state === 'live' && 'animate-pulse',
        )}
      />
      <span className="w-[120px] shrink-0 truncate font-mono text-[12px]">{runner.name}</span>

      {/* What it is doing, which is a different question from whether it is up. */}
      <span className={cn('min-w-0 flex-1 text-[12.5px]', live.state === 'live' && 'text-ink-dim')}>
        {live.state === 'live' && held.length > 0 ? (
          <>
            holding{' '}
            {held.map((job, i) => (
              <span key={job.id}>
                {i > 0 && ', '}
                <Link href={`/runs/${job.runId}`} className="text-accent hover:underline">
                  {job.runId.slice(-8)}
                </Link>
                {job.shardIndex !== null && ` · shard ${job.shardIndex}`}
              </span>
            ))}
          </>
        ) : (
          <span className={live.state === 'live' ? 'text-ink-faint' : live.text}>{live.line}</span>
        )}
      </span>

      <span className="text-ink-faint text-micro max-w-[260px] shrink-0 truncate font-mono">
        {introduced
          ? capabilityLine(runner)
          : runner.lastSeenAt
            ? 'no capabilities reported — only unrestricted work is offered'
            : 'nothing reported yet'}
      </span>

      <span className={cn('text-micro w-12 shrink-0 text-right font-mono tabular-nums', live.text)}>
        {live.age || '—'}
      </span>

      {canManage && (
        <span className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={onRotate}
            disabled={busy}
            className="text-ink-faint hover:text-ink text-[11.5px] transition-colors disabled:opacity-50"
          >
            rotate
          </button>
          <button
            type="button"
            onClick={onRevoke}
            disabled={busy}
            className="text-ink-faint hover:text-fail text-[11.5px] transition-colors disabled:opacity-50"
          >
            revoke
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * The sidebar icon for this area.
 *
 * It lives here rather than in components/shell/icons.tsx because that file is
 * not this change's to edit; nav.ts imports it from here so the entry can exist
 * without touching a file three other people are also appending to.
 */
export function IconServer({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}
