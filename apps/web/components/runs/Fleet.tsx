'use client';

import Link from 'next/link';
import type { Project, Run } from '../../lib/api';
import { cn } from '../../lib/cn';
import { relativeTime } from '../ui';
import { EmptyState } from '../ui/EmptyState';
import { Card, SectionLabel, Skeleton } from '../ui/layout';

/**
 * FLEET — every app under test, one tile each.
 *
 * This is the only place in the product that shows all of them at once, and on
 * the old Dashboard the tiles went nowhere: "11 tests · 90 runs" with no way to
 * open either. Every other screen reads the shell's selected project, so a tile
 * that navigated without selecting first landed you on a different app's data
 * under the name you just clicked. Here a tile IS the selection — the page
 * behind it re-scopes in place, which is both the cheapest interaction and the
 * one that cannot lie about which app you are looking at.
 */

export interface FleetProps {
  projects: Project[];
  /** Every run in the window, across projects — the tiles derive health from it. */
  runs: Array<Run & { projectId?: string }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}

export function Fleet({ projects, runs, selectedId, onSelect, loading }: FleetProps) {
  return (
    <section className="mt-9">
      <SectionLabel>Fleet</SectionLabel>

      {loading ? (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="bg-transparent px-3.5 py-3">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="mt-2 h-2.5 w-32" />
            </Card>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No apps connected yet"
          body="Point QAAI at a URL or a repo and it explores the app, writes the tests, and runs them. Nothing to install first."
          action={{ label: 'Add your app', href: '/onboarding' }}
          secondary={{ label: 'Import existing tests', href: '/onboarding?mode=import' }}
        />
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {projects.map((project) => (
            <FleetCard
              key={project.id}
              project={project}
              runs={runs.filter((r) => r.projectId === project.id)}
              selected={project.id === selectedId}
              onSelect={() => onSelect(project.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FleetCard({
  project,
  runs,
  selected,
  onSelect,
}: {
  project: Project;
  runs: Run[];
  selected: boolean;
  onSelect: () => void;
}) {
  const latest = runs[0] ?? null;
  const tests = runs.reduce((sum, r) => sum + r.totalCount, 0);
  const passed = runs.reduce((sum, r) => sum + r.passedCount, 0);
  const passRate = tests > 0 ? ((passed / tests) * 100).toFixed(1) : null;

  /*
   * A project with no tests cannot run anything, and this card is the whole of a
   * new user's first screen. What that person needs is the plan the Explorer
   * already wrote for them — which nothing on Runs or Editor linked to — so at
   * zero tests the tile leads with it instead of reporting a pass rate over a
   * suite that does not exist.
   */
  const runnable = project._count.tests > 0;

  const meta = runnable
    ? [
        `${project._count.tests} tests`,
        passRate === null ? null : `${passRate}%`,
        latest ? relativeTime(latest.queuedAt) : 'no runs yet',
      ]
        .filter(Boolean)
        .join(' · ')
    : 'no tests yet · plan not approved';

  return (
    <div
      className={cn(
        'rounded-lg border transition-colors',
        selected ? 'border-line-strong bg-surface-1' : 'border-line hover:border-line-strong',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={`Look at ${project.name}`}
        className="w-full px-3.5 py-3 text-left"
      >
        <span className="flex items-center gap-[7px]">
          <HealthDot run={latest} runnable={runnable} />
          <span className="text-body-sm truncate font-semibold">{project.name}</span>
        </span>
        <span className="text-ink-faint text-meta mt-1.5 block truncate font-mono tabular-nums">
          {meta}
        </span>
      </button>

      {!runnable && (
        <Link
          href={`/projects/${project.id}/plan`}
          className="text-accent border-line block border-t px-3.5 py-2 text-[11.5px] hover:underline"
        >
          Review the test plan →
        </Link>
      )}
    </div>
  );
}

/** How the app is doing, at a glance. Grey means nobody has asked yet. */
function HealthDot({ run, runnable }: { run: Run | null; runnable: boolean }) {
  const tone = !runnable
    ? 'bg-ink-faint'
    : run === null
      ? 'bg-ink-faint'
      : run.status === 'FAILED' || run.status === 'ERRORED'
        ? 'bg-fail'
        : run.status === 'RUNNING' || run.status === 'QUEUED'
          ? 'bg-accent animate-pulse'
          : run.flakyCount > 0
            ? 'bg-flake'
            : run.status === 'PASSED'
              ? 'bg-pass'
              : 'bg-ink-faint';

  return (
    <span
      aria-hidden="true"
      title={run ? `last run ${run.status.toLowerCase()}` : 'no runs yet'}
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone)}
    />
  );
}
