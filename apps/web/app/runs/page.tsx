'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Project, type Run } from '../../lib/api';
import { StatusDot, relativeTime } from '../../components/ui';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { Badge, Card, Page, PageHeader, Skeleton, SkeletonRows } from '../../components/ui/layout';

/**
 * The status filter is client-side over the 25 runs already in memory — no new
 * endpoint, no pagination. The list is short enough that filtering it locally is
 * instant, and it keeps working through the 4s poll without a refetch.
 *
 * ERRORED counts as Failed: from where the user sits, a run that fell over is a
 * run that did not pass. QUEUED counts as Running for the same reason — it is
 * in flight, and it would be odd for a run to vanish from the filter for the few
 * seconds between queueing and starting.
 */
type StatusFilter = 'all' | 'failed' | 'passed' | 'running';

const FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'failed', label: 'Failed' },
  { id: 'passed', label: 'Passed' },
  { id: 'running', label: 'Running' },
];

function matchesFilter(run: Run, filter: StatusFilter): boolean {
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

export default function RunsPage() {
  const router = useRouter();
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [startingEnv, setStartingEnv] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  // Both collections initialise to `[]`, so without this the empty state — "No
  // runs yet" — is what renders during the very first fetch, telling the user
  // there is nothing there before we know. Only the first load shows skeletons;
  // the poll refreshes in place.
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        api<{ projects: Project[] }>('/projects'),
        api<{ runs: Run[] }>('/runs?limit=25'),
      ]);
      setProjects(p.projects);
      setRuns(r.runs);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load runs');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
    // A run in flight changes state without any user action, so the list polls.
    // Cheap, and it means the page is never stale for more than a few seconds.
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const counts = useMemo<Record<StatusFilter, number>>(
    () => ({
      all: runs.length,
      failed: runs.filter((run) => matchesFilter(run, 'failed')).length,
      passed: runs.filter((run) => matchesFilter(run, 'passed')).length,
      running: runs.filter((run) => matchesFilter(run, 'running')).length,
    }),
    [runs],
  );

  const visibleRuns = useMemo(
    () => (filter === 'all' ? runs : runs.filter((run) => matchesFilter(run, filter))),
    [runs, filter],
  );

  async function startRun(environmentId: string) {
    setStartingEnv(environmentId);
    try {
      const { run } = await api<{ run: Run }>('/runs', {
        method: 'POST',
        body: JSON.stringify({ environmentId, trigger: 'MANUAL' }),
      });
      toast.success('Run queued.', {
        label: 'View it',
        run: () => router.push(`/runs/${run.id}`),
      });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start the run';
      setError(message);
      toast.error(message);
    } finally {
      setStartingEnv(null);
    }
  }

  return (
    <Page width="wide">
      {error && (
        <p
          role="alert"
          className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm"
        >
          {error}
        </p>
      )}

      <section className="mb-12">
        <PageHeader
          title="Projects"
          actions={
            <Link href="/onboarding" className="text-accent text-sm hover:underline">
              + Add app
            </Link>
          }
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {loading ? (
            <>
              {[0, 1].map((i) => (
                <Card key={i} className="p-5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="mt-2.5 h-3 w-24" />
                  <Skeleton className="mt-4 h-7 w-28" />
                </Card>
              ))}
            </>
          ) : (
            <>
              {projects.map((project) => (
                <Card key={project.id} interactive className="p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-medium">{project.name}</h3>
                    <Badge mono>{project.primaryFramework.toLowerCase()}</Badge>
                  </div>
                  <p className="text-ink-faint mt-1.5 text-xs">
                    <span className="tabular-nums">{project._count.tests}</span> tests ·{' '}
                    <span className="tabular-nums">{project._count.runs}</span> runs
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {project.environments.map((env) => (
                      <Button
                        key={env.id}
                        variant="primary"
                        size="sm"
                        // Every trigger is disabled while one is in flight, as
                        // before; only the one that was clicked spins.
                        disabled={startingEnv !== null && startingEnv !== env.id}
                        loading={startingEnv === env.id}
                        onClick={() => void startRun(env.id)}
                      >
                        ▶ Run {env.name}
                      </Button>
                    ))}
                  </div>
                </Card>
              ))}
              {projects.length === 0 && (
                <EmptyState
                  title="No apps connected yet"
                  body="Point QAAI at a URL or a repo and it explores the app, writes the tests, and runs them. Nothing to install first."
                  action={{ label: 'Add your app', href: '/onboarding' }}
                  secondary={{ label: 'Import existing tests', href: '/onboarding?mode=import' }}
                />
              )}
            </>
          )}
        </div>
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="text-lg font-semibold tracking-tight">Recent runs</h2>
          <div className="flex items-center gap-1" role="group" aria-label="Filter runs by status">
            {FILTERS.map(({ id, label }) => {
              const active = filter === id;
              return (
                <Button
                  key={id}
                  size="sm"
                  variant={active ? 'secondary' : 'ghost'}
                  aria-pressed={active}
                  onClick={() => setFilter(id)}
                  className={active ? 'border-line-strong bg-surface-2 text-ink' : undefined}
                >
                  {label}
                  <span className="tabular-nums opacity-60">{counts[id]}</span>
                </Button>
              );
            })}
          </div>
        </div>

        <Card className="divide-line divide-y overflow-hidden">
          {loading ? (
            <SkeletonRows rows={6} />
          ) : (
            <>
              {visibleRuns.map((run) => (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}`}
                  className="hover:bg-surface-2 flex items-center gap-4 px-4 py-3.5 transition-colors"
                >
                  <StatusDot status={run.status} />
                  <Badge mono>{run.id.slice(-8)}</Badge>
                  <span className="text-ink-dim text-sm">
                    {run.environment.name}
                    <span className="text-ink-faint"> · {run.trigger.toLowerCase()}</span>
                  </span>
                  <span className="ml-auto flex items-center gap-3 text-xs tabular-nums">
                    {run.passedCount > 0 && (
                      <span className="text-pass">{run.passedCount} passed</span>
                    )}
                    {run.failedCount > 0 && (
                      <span className="text-fail">{run.failedCount} failed</span>
                    )}
                    {run.flakyCount > 0 && (
                      <span className="text-flake">{run.flakyCount} flaky</span>
                    )}
                    <span className="text-ink-faint w-16 text-right">
                      {relativeTime(run.queuedAt)}
                    </span>
                  </span>
                </Link>
              ))}
              {runs.length === 0 && (
                <EmptyState
                  title="No runs yet"
                  body={
                    projects.length === 0
                      ? 'Once an app is connected, every run lands here with its failures triaged and its flakes flagged.'
                      : 'Hit Run above to start one. Results stream in live — you do not have to wait on this page.'
                  }
                  {...(projects.length === 0
                    ? { action: { label: 'Add your app', href: '/onboarding' } }
                    : {})}
                />
              )}
              {runs.length > 0 && visibleRuns.length === 0 && (
                <EmptyState
                  title="Nothing with that status"
                  body="None of the recent runs match this filter. The list is live, so it fills in as runs land."
                  action={{ label: 'Show all runs', onClick: () => setFilter('all') }}
                />
              )}
            </>
          )}
        </Card>
      </section>
    </Page>
  );
}
