'use client';

import Link from 'next/link';
import { Fragment, useMemo } from 'react';
import { cn } from '../../lib/cn';
import { relativeTime } from '../ui';
import { EmptyState } from '../ui/EmptyState';
import { SectionLabel, SkeletonRows } from '../ui/layout';
import { dayKey, dayLabel, runElapsedMs, statusWord, wallClockTight, type RunRow } from './format';

/**
 * RUN LOG — the list, grouped by the day each run was queued.
 *
 * It stopped being a boxed table. Twenty-five rows in a card is twenty-six
 * borders, and the outer one is the only one carrying no information; hairlines
 * between rows and the day label as the only heading is what lets someone scan
 * a fortnight of nightlies without the page feeling like a spreadsheet.
 *
 * The status filter runs client-side over the runs already in memory — no new
 * endpoint, no pagination. The list is short enough that filtering it locally is
 * instant, and it keeps working through the 4s poll without a refetch.
 *
 * ERRORED counts as failed: from where the user sits, a run that fell over is a
 * run that did not pass. QUEUED counts as live for the same reason — it is in
 * flight, and it would be odd for a run to vanish from the filter for the few
 * seconds between queueing and starting.
 */

export type StatusFilter = 'all' | 'failed' | 'passed' | 'running';

export const FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'all' },
  { id: 'failed', label: 'fail' },
  { id: 'passed', label: 'pass' },
  { id: 'running', label: 'live' },
];

export function matchesFilter(run: RunRow, filter: StatusFilter): boolean {
  switch (filter) {
    case 'failed':
      return run.status === 'FAILED' || run.status === 'ERRORED';
    case 'passed':
      return run.status === 'PASSED';
    case 'running':
      return run.status === 'RUNNING' || run.status === 'QUEUED';
    case 'all':
    default:
      return true;
  }
}

export interface RunLogProps {
  runs: RunRow[];
  filter: StatusFilter;
  onFilter: (filter: StatusFilter) => void;
  counts: Record<StatusFilter, number>;
  loading: boolean;
  /** The clock, so a run in flight counts up instead of freezing between polls. */
  now: number;
  /** Changes the empty-state copy: no apps at all is a different problem. */
  hasProjects: boolean;
}

export function RunLog({
  runs,
  filter,
  onFilter,
  counts,
  loading,
  now,
  hasProjects,
}: RunLogProps) {
  const visible = useMemo(
    () => (filter === 'all' ? runs : runs.filter((run) => matchesFilter(run, filter))),
    [runs, filter],
  );

  // Runs arrive newest-first and stay that way; this only inserts a heading
  // wherever the day changes, so the order the API chose is the order shown.
  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; runs: RunRow[] }> = [];
    for (const run of visible) {
      const key = dayKey(run.queuedAt);
      const last = out[out.length - 1];
      if (last?.key === key) last.runs.push(run);
      else out.push({ key, label: dayLabel(run.queuedAt), runs: [run] });
    }
    return out;
  }, [visible]);

  return (
    <section className="mt-9">
      <div className="flex items-baseline gap-2">
        <SectionLabel className="mb-0">Run log</SectionLabel>
        <div
          className="ml-auto flex gap-0.5 font-mono text-micro"
          role="group"
          aria-label="Filter runs by status"
        >
          {FILTERS.map(({ id, label }) => {
            const active = filter === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => onFilter(id)}
                className={cn(
                  'rounded-md px-[9px] py-1 transition-colors',
                  active ? 'bg-surface-2 text-ink' : 'text-ink-faint hover:text-ink',
                )}
              >
                {label} <span className="tabular-nums">{counts[id]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <SkeletonRows rows={6} className="mt-3.5" />
      ) : runs.length === 0 ? (
        <div className="mt-3.5">
          <EmptyState
            title="No runs yet"
            body={
              hasProjects
                ? 'Hit Run suite above to start one. Results stream in live — you do not have to wait on this page.'
                : 'Once an app is connected, every run lands here with its failures triaged and its flakes flagged.'
            }
            {...(hasProjects ? {} : { action: { label: 'Add your app', href: '/onboarding' } })}
          />
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-3.5">
          <EmptyState
            title="Nothing with that status"
            body="None of the recent runs match this filter. The list is live, so it fills in as runs land."
            action={{ label: 'Show all runs', onClick: () => onFilter('all') }}
          />
        </div>
      ) : (
        groups.map((group) => (
          <Fragment key={group.key}>
            <p className="text-ink-faint text-meta mt-3.5 font-mono tracking-[0.1em] uppercase">
              {group.label}
            </p>
            <div>
              {group.runs.map((run) => (
                <RunRowLink key={run.id} run={run} now={now} />
              ))}
            </div>
          </Fragment>
        ))
      )}
    </section>
  );
}

function RunRowLink({ run, now }: { run: RunRow; now: number }) {
  const status = statusWord(run.status);
  const red = run.status === 'FAILED' || run.status === 'ERRORED';
  const elapsed = runElapsedMs(run, now);

  return (
    <Link
      href={`/runs/${run.id}`}
      className={cn(
        'border-line flex items-center gap-3.5 border-b py-3 transition-colors',
        red
          ? 'bg-[color-mix(in_srgb,var(--color-fail)_4%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)]'
          : 'hover:bg-[color-mix(in_srgb,var(--color-surface-1)_60%,transparent)]',
      )}
    >
      <span
        className={cn(
          'w-[52px] shrink-0 font-mono text-micro font-semibold',
          status.tone,
          status.live && 'animate-pulse',
        )}
      >
        {status.word}
      </span>
      <span className="text-ink-dim w-[76px] shrink-0 truncate font-mono text-[11.5px]">
        {run.id.slice(-8)}
      </span>

      <span className={cn('text-row min-w-0 flex-1 truncate', red ? 'text-ink' : 'text-ink-dim')}>
        {run.environment.name} · {run.trigger.toLowerCase()}
        <Note run={run} />
      </span>

      <Counts run={run} />

      <span className="text-ink-dim w-[52px] shrink-0 text-right font-mono text-micro tabular-nums">
        {elapsed === null ? '' : wallClockTight(elapsed)}
      </span>
      <span className="text-ink-faint w-[58px] shrink-0 text-right font-mono text-micro tabular-nums">
        {relativeTime(run.queuedAt)}
      </span>
    </Link>
  );
}

/**
 * The half-sentence after the trigger — why this row is the colour it is.
 *
 * Ordered by how specific the answer is. A run that stopped early wrote down
 * which test tripped it; a run that blew up wrote down what blew up; a gate that
 * blocked wrote down what it blocked on. Only when all three are silent does
 * this fall back to counting, and the counts column is already saying that.
 */
function Note({ run }: { run: RunRow }) {
  if (run.status === 'QUEUED') {
    return <span className="text-ink-faint"> — waiting for a worker</span>;
  }
  if (run.status === 'RUNNING') {
    const done = run.passedCount + run.failedCount + run.flakyCount + run.skippedCount;
    return (
      <span className="text-ink-faint">
        {' '}
        — <span className="tabular-nums">{done}</span> of{' '}
        <span className="tabular-nums">{run.totalCount || '?'}</span>
        {(run.shardCount ?? 1) > 1 && ` · ${run.shardCount} shards`}
      </span>
    );
  }
  if (run.status === 'CANCELLED') {
    return <span className="text-ink-faint"> — cancelled{run.stopReason ? ` · ${run.stopReason}` : ''}</span>;
  }

  if (run.status === 'FAILED' || run.status === 'ERRORED') {
    const blocked = run.gateResult?.evaluations.find((e) => !e.passed)?.detail;
    const counted =
      run.failedCount > 0
        ? `${run.failedCount} ${run.failedCount === 1 ? 'test' : 'tests'} failed`
        : // A red run with nothing to count did not fail its tests — it never
          // got as far as running them, and "0 tests failed" says the opposite.
          'no tests ran';
    return <span className="text-fail"> — {run.stopReason ?? run.errorMessage ?? blocked ?? counted}</span>;
  }

  // A green run that retried its way there is not the same as a green run.
  if (run.flakyCount > 0) {
    return (
      <span className="text-flake">
        {' '}
        — <span className="tabular-nums">{run.flakyCount}</span>{' '}
        {run.flakyCount === 1 ? 'flake' : 'flakes'} retried and passed
      </span>
    );
  }
  return null;
}

/**
 * `118 / 6 / 4`, coloured, zeros omitted.
 *
 * A run with nothing wrong reads `128 pass` instead — three slash-separated
 * numbers where two of them are zero is a shape that implies something happened
 * in columns where nothing did.
 */
function Counts({ run }: { run: RunRow }) {
  if (run.totalCount === 0 && run.passedCount === 0) return null;

  const clean = run.failedCount === 0 && run.flakyCount === 0;
  return (
    <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
      <span className="text-pass">{run.passedCount}</span>
      {clean ? (
        <span className="text-ink-faint"> pass</span>
      ) : (
        <>
          {run.failedCount > 0 && (
            <>
              <span className="text-ink-faint"> / </span>
              <span className="text-fail">{run.failedCount}</span>
            </>
          )}
          {run.flakyCount > 0 && (
            <>
              <span className="text-ink-faint"> / </span>
              <span className="text-flake">{run.flakyCount}</span>
            </>
          )}
        </>
      )}
    </span>
  );
}
