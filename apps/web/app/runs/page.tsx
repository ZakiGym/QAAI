'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Project, type Run } from '../../lib/api';
import { StatusDot, relativeTime } from '../../components/ui';

export default function RunsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

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
    }
  }, [router]);

  useEffect(() => {
    void load();
    // A run in flight changes state without any user action, so the list polls.
    // Cheap, and it means the page is never stale for more than a few seconds.
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  async function startRun(environmentId: string) {
    setStarting(true);
    try {
      const { run } = await api<{ run: Run }>('/runs', {
        method: 'POST',
        body: JSON.stringify({ environmentId, trigger: 'MANUAL' }),
      });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the run');
    } finally {
      setStarting(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="app-drag -mx-6 mb-10 flex items-baseline gap-4 px-6 py-3">
        <Link href="/" className="text-base font-semibold tracking-tight">
          QAAI
        </Link>
        <h1 className="text-ink-dim text-sm">Runs</h1>
        <Link href="/onboarding" className="text-ink-dim hover:text-ink ml-auto text-sm">
          Add app
        </Link>
        <Link href="/import" className="text-ink-dim hover:text-ink text-sm">
          Import
        </Link>
        <Link href="/dashboard" className="text-ink-dim hover:text-ink text-sm">
          Dashboard
        </Link>
        <Link href="/editor" className="text-ink-dim hover:text-ink text-sm">
          Editor
        </Link>
        <Link href="/settings" className="text-ink-dim hover:text-ink text-sm">
          Settings
        </Link>
      </header>

      {error && (
        <p
          role="alert"
          className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm"
        >
          {error}
        </p>
      )}

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
              <div className="mt-3 flex flex-wrap gap-2">
                {project.environments.map((env) => (
                  <button
                    key={env.id}
                    type="button"
                    disabled={starting}
                    onClick={() => void startRun(env.id)}
                    className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
                  >
                    Run against {env.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {projects.length === 0 && (
            <p className="text-ink-faint text-sm">
              No projects yet. Run <code className="font-mono">npm run db:seed</code>.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-ink-dim mb-3 text-xs font-semibold tracking-wider uppercase">
          Recent runs
        </h2>
        <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
          {runs.map((run) => (
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
