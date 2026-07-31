'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Project, type Run } from '../../lib/api';
import { StatusDot, relativeTime } from '../../components/ui';
import { EmptyState } from '../../components/ui/EmptyState';
import { cn } from '../../lib/cn';
import {
  Badge,
  Card,
  Page,
  PageHeader,
  SectionLabel,
  Skeleton,
  SkeletonRows,
} from '../../components/ui/layout';

/**
 * A read-only overview of the fleet. Everything shown is derived client-side
 * from the runs list, so the page adds no endpoints — it is a different lens on
 * the same data the runs page loads.
 */
export default function DashboardPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Every number here is derived from `runs`, which starts empty — so during the
  // first fetch the page confidently reported a fleet of zero. Skeletons until
  // the first response lands; the 5s poll then refreshes in place.
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        api<{ projects: Project[] }>('/projects'),
        api<{ runs: Run[] }>('/runs?limit=100'),
      ]);
      setProjects(p.projects);
      setRuns(r.runs);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load the dashboard');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  // Aggregates over the loaded window (§9-ish rollup, but purely for display).
  const totalRuns = runs.length;
  const totalTests = runs.reduce((sum, run) => sum + run.totalCount, 0);
  const totalPassed = runs.reduce((sum, run) => sum + run.passedCount, 0);
  const passRate = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : null;
  const flakeCount = runs.reduce((sum, run) => sum + run.flakyCount, 0);
  const openFailures = runs.filter((run) => run.failedCount > 0).length;

  // Oldest-to-newest, left-to-right, so the bar row reads like a timeline.
  const timeline = runs.slice(0, 30).reverse();

  return (
    <Page width="wide">
      <PageHeader title="Dashboard" />

      {error && (
        <p
          role="alert"
          className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm"
        >
          {error}
        </p>
      )}

      <section className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total runs" value={totalRuns} loading={loading} />
        <Stat
          label="Pass rate"
          value={passRate === null ? '—' : `${passRate}%`}
          tone="text-pass"
          loading={loading}
        />
        <Stat label="Flakes" value={flakeCount} tone="text-flake" loading={loading} />
        <Stat label="Open failures" value={openFailures} tone="text-fail" loading={loading} />
      </section>

      <section className="mb-10">
        <SectionLabel>Pass rate over time</SectionLabel>
        <Card className="p-4">
          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : timeline.length > 0 ? (
            <div className="flex h-32 items-end gap-0.5">
              {timeline.map((run) => {
                const ratio = run.totalCount > 0 ? run.passedCount / run.totalCount : 0;
                const gatePassed = run.gateResult?.passed ?? false;
                return (
                  <div
                    key={run.id}
                    title={`${run.id.slice(-8)} · ${run.passedCount}/${run.totalCount} passed · ${
                      run.failedCount
                    } failed`}
                    style={{ height: `${Math.max(ratio * 100, 2)}%` }}
                    className={`flex-1 rounded-sm ${gatePassed ? 'bg-pass' : 'bg-fail'}`}
                  />
                );
              })}
            </div>
          ) : (
            <p className="text-ink-faint text-body-sm py-8 text-center">
              Pass rate over time appears once there are a few runs to compare.
            </p>
          )}
          {!loading && (
            <p className="text-ink-faint mt-3 text-micro">
              Last <span className="tabular-nums">{timeline.length}</span> runs · bar height is the
              pass ratio, colour is the gate result.
            </p>
          )}
        </Card>
      </section>

      <section className="mb-10">
        <SectionLabel>Projects</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          {loading ? (
            <>
              {[0, 1].map((i) => (
                <Card key={i} className="p-4">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="mt-2.5 h-3 w-24" />
                </Card>
              ))}
            </>
          ) : (
            <>
              {projects.map((project) => (
                <Card key={project.id} className="p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-medium">{project.name}</h3>
                    <Badge mono>{project.primaryFramework.toLowerCase()}</Badge>
                  </div>
                  <p className="text-ink-faint mt-1 text-xs">
                    <span className="tabular-nums">{project._count.tests}</span> tests ·{' '}
                    <span className="tabular-nums">{project._count.runs}</span> runs
                  </p>
                </Card>
              ))}
              {projects.length === 0 && (
                <EmptyState
                  title="No apps connected"
                  body="Connect one and QAAI explores it, writes a test plan, and starts running. This dashboard fills itself in."
                  action={{ label: 'Add your app', href: '/onboarding' }}
                />
              )}
            </>
          )}
        </div>
      </section>

      <section>
        <SectionLabel>Recent runs</SectionLabel>
        <Card className="divide-line divide-y overflow-hidden">
          {loading ? (
            <SkeletonRows rows={5} />
          ) : (
            <>
              {runs.slice(0, 10).map((run) => (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}`}
                  className="hover:bg-surface-2 flex items-center gap-4 px-4 py-3 transition-colors"
                >
                  <StatusDot status={run.status} />
                  <Badge mono>{run.id.slice(-8)}</Badge>
                  <span className="text-ink-dim text-sm">
                    {run.environment.name} · {run.trigger.toLowerCase()}
                  </span>
                  <span className="ml-auto flex items-center gap-3 text-xs tabular-nums">
                    <span className="text-pass">{run.passedCount} passed</span>
                    {run.failedCount > 0 && (
                      <span className="text-fail">{run.failedCount} failed</span>
                    )}
                    {run.flakyCount > 0 && (
                      <span className="text-flake">{run.flakyCount} flaky</span>
                    )}
                    <span className="text-ink-faint">{relativeTime(run.queuedAt)}</span>
                  </span>
                </Link>
              ))}
              {runs.length === 0 && (
                <EmptyState
                  title="No runs yet"
                  body="Every run shows up here with its failures already triaged — real bug, intended change, or flake."
                  action={{ label: 'Go to runs', href: '/runs' }}
                />
              )}
            </>
          )}
        </Card>
      </section>
    </Page>
  );
}

/**
 * One stat tile. Four hand-rolled copies of the same markup differed only in the
 * value's colour, and all four rendered `0` while the fetch was still in flight.
 */
function Stat({
  label,
  value,
  tone,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  loading: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-ink-faint text-xs">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <p className={cn('mt-1 text-2xl font-semibold tracking-tight tabular-nums', tone)}>
          {value}
        </p>
      )}
    </Card>
  );
}
