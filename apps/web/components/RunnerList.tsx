'use client';

import Link from 'next/link';
import type { Runner, RunnerJob } from '../lib/api';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';
import { Badge, Card } from './ui/layout';

/**
 * The fleet, told the truth about.
 *
 * The hard fact this component exists to render: **we never dial a runner.** An
 * agent behind a customer's firewall that dies gives us no RST, no timeout, no
 * signal at all — a missing heartbeat is the only evidence we will ever have.
 * So liveness here is derived from `lastSeenAt` and stated as a sentence with a
 * number in it ("we have not heard from this runner in 40 minutes"), because
 * that is the sentence the person on call actually needs. A green dot that goes
 * grey tells them nothing about how long, and how long is the whole question.
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
  label: string;
  /** The whole point: what this state means, in one sentence, with a number. */
  sentence: string;
  dot: string;
  text: string;
}

export function liveness(runner: Runner, now = Date.now()): Liveness {
  if (!runner.lastSeenAt) {
    return {
      state: 'never',
      label: 'Never connected',
      sentence: `Registered ${elapsed(runner.createdAt, now)} ago, and no agent has ever presented this token. Start the agent on the host with the token you were given.`,
      dot: 'bg-skip',
      text: 'text-ink-dim',
    };
  }

  const silent = elapsed(runner.lastSeenAt, now);
  const silentMs = now - new Date(runner.lastSeenAt).getTime();

  if (runner.online && silentMs < ONLINE_MS) {
    return {
      state: 'live',
      label: 'Online',
      sentence: `Last heard from ${silent} ago.`,
      dot: 'bg-pass',
      text: 'text-pass',
    };
  }

  if (silentMs < STALE_MS) {
    return {
      state: 'quiet',
      label: 'Quiet',
      sentence: `We have not heard from this runner in ${silent}. It calls home every ${HEARTBEAT_SECONDS} seconds, so it is restarting, or it cannot reach QAAI from where it runs.`,
      dot: 'bg-flake',
      text: 'text-flake',
    };
  }

  return {
    state: 'stale',
    label: 'Stale',
    sentence: `We have not heard from this runner in ${silent}. Treat it as gone: queued work that no online runner can serve is skipped after 15 minutes, and those tests report as skipped — not failed — so a green build can hide them.`,
    dot: 'bg-fail',
    text: 'text-fail',
  };
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
    <ul className="space-y-3">
      {runners.map((runner) => (
        <li key={runner.id}>
          <RunnerRow
            runner={runner}
            held={heldJobsFor(jobs, runner.id)}
            canManage={canManage}
            busy={busyId === runner.id}
            onRotate={() => onRotate(runner)}
            onRevoke={() => onRevoke(runner)}
            now={now}
          />
        </li>
      ))}
    </ul>
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
  const caps = runner.capabilities;
  const introduced =
    caps.browsers.length > 0 ||
    caps.testTypes.length > 0 ||
    caps.languages.length > 0 ||
    caps.toolchains.length > 0;

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            live.dot,
            live.state === 'live' && 'animate-pulse',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{runner.name}</h3>
            <span className={cn('text-micro font-medium', live.text)}>{live.label}</span>
            {runner.pools.length === 0 ? (
              <Badge>default pool</Badge>
            ) : (
              runner.pools.map((pool) => (
                <Badge key={pool} tone="accent" mono>
                  {pool}
                </Badge>
              ))
            )}
            {runner.platform && <Badge mono>{runner.platform}</Badge>}
            {runner.agentVersion && <Badge mono>agent {runner.agentVersion}</Badge>}
          </div>
          <p className="text-ink-dim text-body-sm mt-1.5 leading-relaxed">{live.sentence}</p>
        </div>

        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={onRotate} disabled={busy}>
              Rotate token
            </Button>
            <Button size="sm" variant="danger" onClick={onRevoke} disabled={busy}>
              Revoke
            </Button>
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <section>
          <h4 className="text-meta text-ink-faint mb-2 font-semibold tracking-wider uppercase">
            Executing now
          </h4>
          {held.length === 0 ? (
            <p className="text-ink-faint text-body-sm">
              {live.state === 'live'
                ? 'Idle — polling for work.'
                : 'Holding no work.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {held.map((job) => (
                <li key={job.id} className="text-body-sm">
                  <Link
                    href={`/runs/${job.runId}`}
                    className="text-accent font-mono hover:underline"
                  >
                    {job.runId.slice(-8)}
                  </Link>
                  <span className="text-ink-dim">
                    {job.shardIndex === null ? ' · whole run' : ` · shard ${job.shardIndex}`}
                    {job.claimedAt && ` · picked up ${elapsed(job.claimedAt, now)} ago`}
                  </span>
                  {job.attempt > 1 && (
                    <span className="text-flake text-micro ml-1.5 tabular-nums">
                      attempt {job.attempt} of {job.maxAttempts}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4 className="text-meta text-ink-faint mb-2 font-semibold tracking-wider uppercase">
            Can run
          </h4>
          {!introduced ? (
            <p className="text-ink-faint text-body-sm leading-relaxed">
              {runner.lastSeenAt
                ? 'This agent has connected but not reported its capabilities, so QAAI will only offer it work with no requirements.'
                : 'Nothing reported yet — an agent describes its browsers and toolchains when it first connects.'}
            </p>
          ) : (
            <dl className="text-body-sm space-y-1">
              <CapabilityRow label="Browsers" values={caps.browsers} />
              <CapabilityRow label="Test types" values={caps.testTypes} />
              <CapabilityRow label="Languages" values={caps.languages} />
              <CapabilityRow label="Toolchains" values={caps.toolchains} />
              <div className="flex gap-2">
                <dt className="text-ink-faint w-24 shrink-0">At once</dt>
                <dd className="text-ink-dim tabular-nums">
                  {caps.maxConcurrency} job{caps.maxConcurrency === 1 ? '' : 's'}
                </dd>
              </div>
            </dl>
          )}
        </section>
      </div>

      <p className="text-ink-faint text-micro border-line mt-4 flex flex-wrap gap-x-3 gap-y-1 border-t pt-3">
        <code className="font-mono">{runner.tokenPrefix}…</code>
        <span className="tabular-nums">registered {elapsed(runner.createdAt, now)} ago</span>
        {runner.tokenRotatedAt && (
          <span className="tabular-nums">
            token rotated {elapsed(runner.tokenRotatedAt, now)} ago
          </span>
        )}
        {runner.lastClaimAt && (
          <span className="tabular-nums">
            last took work {elapsed(runner.lastClaimAt, now)} ago
          </span>
        )}
      </p>
    </Card>
  );
}

/** One capability line. Absent lists are omitted rather than shown as empty. */
function CapabilityRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="flex gap-2">
      <dt className="text-ink-faint w-24 shrink-0">{label}</dt>
      <dd className="text-ink-dim text-micro min-w-0 font-mono leading-relaxed">
        {values.join(', ')}
      </dd>
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
