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

// ─── Parallelism ─────────────────────────────────────────────────────────────

/**
 * `shardCount` is a column on Run and comes back on every row, but the shared
 * `Run` interface in lib/api.ts — which this page does not own — does not
 * describe it yet. Narrowed here rather than cast away; it belongs in lib/api.ts
 * next time that file is opened.
 */
type RunRow = Run & { shardCount?: number };

/** Only the parts of GET /billing this page needs: the ceiling, and its name. */
interface PlanCap {
  plan: string;
  limits: { label: string; maxParallelWorkers: number };
}

/** What the API answered when asked to split — reported whether or not it could. */
interface ShardingReport {
  requested: number;
  granted: number;
  cappedBy: 'plan' | 'tests' | null;
  maxParallelWorkers: number;
}

/**
 * The counts offered in the picker.
 *
 * A ladder rather than 1…N: the ceiling is 50 on the top plan, and a fifty-item
 * dropdown is not a choice, it is a list. Every rung a plan actually allows is
 * on it, and the ceiling itself is always offered even if it lands off-ladder.
 */
const SHARD_LADDER = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];

function shardOptionsFor(max: number): number[] {
  const rungs = SHARD_LADDER.filter((n) => n <= max);
  return rungs.includes(max) ? rungs : [...rungs, max];
}

/**
 * What actually happened, said plainly.
 *
 * The endpoint clamps a request to what the plan and the suite allow, and a
 * user who asked for eight workers and got five must be told that here — the
 * alternative is learning it from a wall clock that did not improve as much as
 * expected, which is a terrible way to find out what you are paying for.
 */
function describeSharding(report: ShardingReport | undefined, planLabel: string | null): string {
  // Reported even when the answer is "it could not be split at all", because a
  // request that quietly became one shard is the case worth naming.
  if (!report) return 'Run queued.';
  if (report.granted < 2) {
    return report.cappedBy === 'plan'
      ? `Run queued on one worker. Your ${planLabel ?? 'current'} plan does not include parallel workers.`
      : 'Run queued on one worker — there is only one test to run.';
  }

  const across = `Run queued across ${report.granted} shards.`;
  if (report.cappedBy === 'plan') {
    return `${across} You asked for ${report.requested}; your ${planLabel ?? 'current'} plan allows ${report.maxParallelWorkers} parallel workers.`;
  }
  if (report.cappedBy === 'tests') {
    return `${across} You asked for ${report.requested}, and the suite only has ${report.granted} tests to fill them.`;
  }
  return across;
}

export default function RunsPage() {
  const router = useRouter();
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [startingEnv, setStartingEnv] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  /**
   * The org's parallel-worker ceiling, or null while we do not know it.
   *
   * Null hides the picker entirely, and that is the fail-safe direction: if
   * /billing is slow or unreachable, the page keeps working and every run
   * behaves exactly as it did before this control existed. Offering a choice we
   * cannot honour would be worse than not offering one.
   */
  const [planCap, setPlanCap] = useState<PlanCap | null>(null);
  const [shardCount, setShardCount] = useState(1);
  // Both collections initialise to `[]`, so without this the empty state — "No
  // runs yet" — is what renders during the very first fetch, telling the user
  // there is nothing there before we know. Only the first load shows skeletons;
  // the poll refreshes in place.
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        api<{ projects: Project[] }>('/projects'),
        api<{ runs: RunRow[] }>('/runs?limit=25'),
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

  // Fetched once and kept out of the poll: a plan does not change every four
  // seconds, and a billing hiccup must not take the runs list down with it.
  useEffect(() => {
    let live = true;
    api<PlanCap>('/billing')
      .then((billing) => {
        if (live) setPlanCap(billing);
      })
      .catch(() => {
        /* the picker simply stays hidden; runs still start */
      });
    return () => {
      live = false;
    };
  }, []);

  const maxWorkers = planCap?.limits.maxParallelWorkers ?? 1;

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
      const { run, sharding } = await api<{ run: Run; sharding?: ShardingReport }>('/runs', {
        method: 'POST',
        body: JSON.stringify({
          environmentId,
          trigger: 'MANUAL',
          // Omitted, not sent as 1: a body without `shards` takes the exact
          // path every manual run took before this control existed.
          ...(shardCount > 1 ? { shards: shardCount } : {}),
        }),
      });
      toast.success(describeSharding(sharding, planCap?.limits.label ?? null), {
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

        {/*
          The parallelism control sits above the Run buttons rather than inside
          each card: it is one choice that applies to whichever button you press
          next, and repeating it per environment would imply otherwise.
        */}
        {planCap && (
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <label htmlFor="shard-count" className="text-ink-dim shrink-0 text-sm">
              Split across
            </label>
            <select
              id="shard-count"
              value={shardCount}
              disabled={maxWorkers < 2}
              onChange={(e) => setShardCount(Number(e.target.value))}
              className="border-line bg-surface-1 rounded-md border px-2.5 py-1.5 text-sm tabular-nums disabled:cursor-not-allowed disabled:opacity-50"
            >
              {shardOptionsFor(maxWorkers).map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? '1 shard' : `${n} shards`}
                </option>
              ))}
            </select>
            {/*
              The cap is stated, never silently applied. A Free-plan user who
              cannot split needs to know that is the plan talking and not a
              broken control — and where to go if they want it.
            */}
            <p className="text-ink-faint text-micro">
              {maxWorkers < 2 ? (
                <>
                  Your <span className="text-ink-dim">{planCap.limits.label}</span> plan runs one
                  worker at a time, so a suite cannot be split.{' '}
                  <Link href="/settings/billing" className="text-accent hover:underline">
                    Compare plans
                  </Link>
                </>
              ) : (
                <>
                  Up to <span className="tabular-nums">{maxWorkers}</span> parallel workers on your{' '}
                  <span className="text-ink-dim">{planCap.limits.label}</span> plan. Tests are
                  divided between shards by how long they recently took, so each one finishes at
                  about the same time.
                </>
              )}
            </p>
          </div>
        )}

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
              {projects.map((project) => {
                /*
                 * A project with no tests cannot run anything, and this card was
                 * the whole of a new user's first screen: "▶ Run staging" was
                 * enabled, was the ONLY enabled control on the page, and pressing
                 * it produced a toast explaining there were no tests. The toast
                 * was right and the button was a trap — the app knew the answer
                 * before the click and offered the click anyway.
                 *
                 * What that user actually needs is the plan the Explorer already
                 * wrote for them, which nothing on /runs or /editor linked to.
                 * So at zero tests the card leads with the plan and keeps the run
                 * triggers visible-but-disabled, with the reason on the control
                 * rather than in a toast after the fact.
                 */
                const runnable = project._count.tests > 0;
                return (
                  <Card key={project.id} interactive className="p-5">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-medium">{project.name}</h3>
                      <Badge mono>{project.primaryFramework.toLowerCase()}</Badge>
                    </div>
                    <p className="text-ink-faint mt-1.5 text-xs">
                      <span className="tabular-nums">{project._count.tests}</span> tests ·{' '}
                      <span className="tabular-nums">{project._count.runs}</span> runs
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {!runnable && (
                        <Link
                          href={`/projects/${project.id}/plan`}
                          className="bg-accent text-micro inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium text-white transition-opacity hover:opacity-90"
                        >
                          Review the test plan →
                        </Link>
                      )}
                      {project.environments.map((env) => (
                        <Button
                          key={env.id}
                          variant={runnable ? 'primary' : 'secondary'}
                          size="sm"
                          // Every trigger is disabled while one is in flight, as
                          // before; only the one that was clicked spins.
                          disabled={!runnable || (startingEnv !== null && startingEnv !== env.id)}
                          loading={startingEnv === env.id}
                          onClick={() => void startRun(env.id)}
                          title={
                            runnable
                              ? undefined
                              : `${project.name} has no tests yet — approve its plan first.`
                          }
                        >
                          ▶ Run {env.name}
                        </Button>
                      ))}
                    </div>
                    {!runnable && (
                      <p className="text-ink-faint mt-2.5 text-xs">
                        No tests yet, so there is nothing to run. Approve a test plan and the
                        Generator writes them.
                      </p>
                    )}
                  </Card>
                );
              })}
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
                  {/* Only on runs that were actually split — 1 is the default
                      and saying "1 shard" on every row would be noise. */}
                  {(run.shardCount ?? 1) > 1 && (
                    <Badge tone="accent">
                      <span className="tabular-nums">{run.shardCount}</span>
                      <span className="ml-1">shards</span>
                    </Badge>
                  )}
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
