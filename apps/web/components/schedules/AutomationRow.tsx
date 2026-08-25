'use client';

import { shortAgo } from '../setup/time';
import { Badge } from '../ui/layout';
import { Button } from '../ui/Button';
import { describeCron, describeInterval, describeStreak, formatZone, shortUntil, timeInZone } from './cadence';
import type { AutomationLastRun, EnvironmentRef, Monitor, RunStatus, Schedule, SuiteRef } from './types';

/**
 * One schedule, and one monitor, as a row.
 *
 * Hairline rows on the page background rather than cards, per the note on
 * `Card` in ui/layout.tsx: a list of five schedules is a list, and five boxes
 * stacked vertically is four borders nobody reads.
 *
 * The information order is fixed and is the argument of the whole screen:
 *
 *   1. WHAT IT IS — the name, and whether it is running at all.
 *   2. WHEN IT RUNS, in words, with the zone it runs in. Never the expression
 *      alone; never a time without a zone.
 *   3. WHAT IT RUNS — suite, environment, and the raw cron for anyone checking
 *      the working, in mono, deliberately quieter than the sentence above it.
 *   4. WHAT HAPPENED — the last fire and its outcome, and the next one.
 *
 * A monitor swaps (2) for its interval and (4) for its streak, because a
 * monitor's state is the streak: "3 consecutive failures, alerts at 5" is the
 * whole thing, and a row that showed only red or green would hide whether the
 * next failure pages the on-call or not.
 */

const STATUS_TONE: Record<RunStatus, 'pass' | 'fail' | 'flake' | 'accent' | 'neutral'> = {
  PASSED: 'pass',
  FAILED: 'fail',
  ERRORED: 'fail',
  CANCELLED: 'neutral',
  QUEUED: 'accent',
  RUNNING: 'accent',
};

function OutcomeBadge({ run }: { run: AutomationLastRun }) {
  return (
    <Badge tone={STATUS_TONE[run.status]} tint={run.status === 'FAILED' || run.status === 'ERRORED'}>
      {run.status}
    </Badge>
  );
}

/** The last fire, in the one sentence that says both when and what happened. */
function LastFire({
  at,
  run,
  ambiguous,
  now,
}: {
  at: string | null;
  run: AutomationLastRun | null;
  ambiguous: boolean;
  now: number;
}) {
  if (ambiguous) {
    return (
      <>
        another schedule runs the same suite against the same environment, so QAAI cannot tell
        their runs apart
      </>
    );
  }
  if (!at && !run) return <>never fired</>;

  const when = at ?? run?.queuedAt ?? null;
  return (
    <>
      fired {when ? `${shortAgo(when, now)} ago` : 'recently'}
      {run ? (
        <>
          {' · '}
          {run.failedCount > 0
            ? `${run.failedCount} of ${run.totalCount} failed`
            : `${run.passedCount} of ${run.totalCount} passed`}
        </>
      ) : (
        // Deliberately not silence: the run happened, it is simply older than
        // the window the API looks back over, and saying so beats implying the
        // schedule has no history.
        <> · outcome older than the last 300 automated runs</>
      )}
    </>
  );
}

interface RowActions {
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** True while this specific row has a request in flight. */
  busy: boolean;
  /** False for a VIEWER — the row still reads, it just cannot be changed. */
  canEdit: boolean;
}

function Actions({ enabled, onToggle, onEdit, onDelete, busy, canEdit }: RowActions & { enabled: boolean }) {
  if (!canEdit) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button size="sm" onClick={onToggle} disabled={busy}>
        {enabled ? 'Pause' : 'Resume'}
      </Button>
      <Button size="sm" onClick={onEdit} disabled={busy}>
        Edit
      </Button>
      <Button size="sm" variant="danger" onClick={onDelete} disabled={busy}>
        Delete
      </Button>
    </div>
  );
}

function Target({
  suite,
  environment,
}: {
  suite: SuiteRef | undefined;
  environment: EnvironmentRef | undefined;
}) {
  return (
    <>
      {suite?.name ?? 'a deleted suite'} → {environment?.name ?? 'a deleted environment'}
      {environment && <span className="opacity-70"> ({environment.kind.toLowerCase()})</span>}
    </>
  );
}

export function ScheduleRow({
  schedule,
  suite,
  environment,
  now,
  ...actions
}: {
  schedule: Schedule;
  suite: SuiteRef | undefined;
  environment: EnvironmentRef | undefined;
  now: number;
} & RowActions) {
  const cadence = describeCron(schedule.cron);
  const zone = formatZone(schedule.timezone, new Date(now));

  return (
    <li className="border-line flex items-start gap-4 border-b py-4 first:border-t">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-ink text-row min-w-0 truncate font-semibold">{schedule.name}</h3>
          {!schedule.enabled && <Badge>PAUSED</Badge>}
          {schedule.lastRun && <OutcomeBadge run={schedule.lastRun} />}
          {!zone.valid && (
            <Badge tone="fail" tint>
              BROKEN ZONE
            </Badge>
          )}
        </div>

        {/* The sentence. This is the line the screen exists for. */}
        <p className="text-ink-dim text-body-sm mt-1.5">
          {cadence.kind === 'words' ? (
            <>
              Runs <span className="text-ink">{cadence.text}</span>{' '}
              <span className="text-ink-faint">{zone.text}</span>
            </>
          ) : (
            <>
              Runs on <span className="text-ink font-mono text-[12px]">{cadence.text}</span> —{' '}
              <span className="text-ink-faint">
                too intricate to state in words; {zone.text}
              </span>
            </>
          )}
        </p>

        <p className="text-ink-faint text-micro mt-1.5 font-mono">
          <Target suite={suite} environment={environment} />
          {cadence.kind === 'words' && <> · {schedule.cron}</>}
        </p>

        <p className="text-ink-faint text-micro mt-1">
          <LastFire
            at={schedule.lastRunAt}
            run={schedule.lastRun}
            ambiguous={schedule.lastRunAmbiguous}
            now={now}
          />
          {' — '}
          {!schedule.enabled ? (
            'paused, so nothing is scheduled'
          ) : schedule.nextRunAt ? (
            <>
              next {timeInZone(schedule.nextRunAt, schedule.timezone)} (
              {shortUntil(schedule.nextRunAt, now)})
            </>
          ) : (
            // The worker arms a schedule it has never seen before it fires one,
            // so a brand-new schedule genuinely has no next time yet. Saying
            // "never" here would read as broken.
            'arming on the scheduler’s next sweep'
          )}
        </p>
      </div>

      <Actions enabled={schedule.enabled} {...actions} />
    </li>
  );
}

export function MonitorRow({
  monitor,
  suite,
  environment,
  now,
  ...actions
}: {
  monitor: Monitor;
  suite: SuiteRef | undefined;
  environment: EnvironmentRef | undefined;
  now: number;
} & RowActions) {
  const failing = monitor.consecutiveFailures > 0;
  const alerted = monitor.enabled && monitor.consecutiveFailures >= monitor.failureThreshold;

  return (
    <li className="border-line flex items-start gap-4 border-b py-4 first:border-t">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-ink text-row min-w-0 truncate font-semibold">{monitor.name}</h3>
          {!monitor.enabled && <Badge>PAUSED</Badge>}
          {monitor.lastStatus && monitor.enabled && (
            <Badge tone={STATUS_TONE[monitor.lastStatus]} tint={alerted}>
              {monitor.lastStatus}
            </Badge>
          )}
          {alerted && (
            <Badge tone="fail" tint>
              ALERTING
            </Badge>
          )}
        </div>

        <p className="text-ink-dim text-body-sm mt-1.5">
          Checks <span className="text-ink">{describeInterval(monitor.intervalMinutes)}</span>
        </p>

        <p className="text-ink-faint text-micro mt-1.5 font-mono">
          <Target suite={suite} environment={environment} />
        </p>

        {/* The streak, which is the entire state of a monitor. */}
        <p
          className={
            failing && monitor.enabled
              ? 'text-fail text-micro mt-1'
              : 'text-ink-faint text-micro mt-1'
          }
        >
          {describeStreak(monitor)}
          {monitor.lastCheckedAt && <> · last checked {shortAgo(monitor.lastCheckedAt, now)} ago</>}
          {monitor.lastRunAmbiguous && (
            <> · another monitor shares this suite and environment</>
          )}
        </p>
      </div>

      <Actions enabled={monitor.enabled} {...actions} />
    </li>
  );
}
