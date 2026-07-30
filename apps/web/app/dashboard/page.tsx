'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Project, type Run } from '../../lib/api';
import { StatusDot, relativeTime } from '../../components/ui';

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
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Dashboard</h1>

      {error && (
        <p
          role="alert"
          className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm"
        >
          {error}
        </p>
      )}

      <section className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-ink-faint text-xs">Total runs</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{totalRuns}</p>
        </div>
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-ink-faint text-xs">Pass rate</p>
          <p className="text-pass mt-1 text-2xl font-semibold tracking-tight">
            {passRate === null ? '—' : `${passRate}%`}
          </p>
        </div>
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-ink-faint text-xs">Flakes</p>
          <p className="text-flake mt-1 text-2xl font-semibold tracking-tight">{flakeCount}</p>
        </div>
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-ink-faint text-xs">Open failures</p>
          <p className="text-fail mt-1 text-2xl font-semibold tracking-tight">{openFailures}</p>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-ink-dim mb-3 text-xs font-semibold tracking-wider uppercase">
          Pass rate over time
        </h2>
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          {timeline.length > 0 ? (
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
            <p className="text-ink-faint text-sm">No runs to chart yet.</p>
          )}
          <p className="text-ink-faint mt-3 text-[11px]">
            Last {timeline.length} runs · bar height is the pass ratio, colour is the gate result.
          </p>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-ink-dim mb-3 text-xs font-semibold tracking-wider uppercase">
          Projects
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((project) => (
            <div key={project.id} className="border-line bg-surface-1 rounded-lg border p-4">
              <div className="flex items-baseline justify-between">
                <h3 className="font-medium">{project.name}</h3>
                <span className="text-ink-faint font-mono text-xs">
                  {project.primaryFramework.toLowerCase()}
                </span>
              </div>
              <p className="text-ink-faint mt-1 text-xs">
                {project._count.tests} tests · {project._count.runs} runs
              </p>
            </div>
          ))}
          {projects.length === 0 && <p className="text-ink-faint text-sm">No projects yet.</p>}
        </div>
      </section>

      <section>
        <h2 className="text-ink-dim mb-3 text-xs font-semibold tracking-wider uppercase">
          Recent runs
        </h2>
        <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
          {runs.slice(0, 10).map((run) => (
            <Link
              key={run.id}
              href={`/runs/${run.id}`}
              className="hover:bg-surface-1 flex items-center gap-4 px-4 py-3"
            >
              <StatusDot status={run.status} />
              <span className="font-mono text-xs">{run.id.slice(-8)}</span>
              <span className="text-ink-dim text-sm">
                {run.environment.name} · {run.trigger.toLowerCase()}
              </span>
              <span className="ml-auto flex items-center gap-3 text-xs">
                <span className="text-pass">{run.passedCount} passed</span>
                {run.failedCount > 0 && <span className="text-fail">{run.failedCount} failed</span>}
                {run.flakyCount > 0 && <span className="text-flake">{run.flakyCount} flaky</span>}
                <span className="text-ink-faint">{relativeTime(run.queuedAt)}</span>
              </span>
            </Link>
          ))}
          {runs.length === 0 && (
            <p className="text-ink-faint px-4 py-8 text-center text-sm">No runs yet.</p>
          )}
        </div>
      </section>
    </main>
  );
}
