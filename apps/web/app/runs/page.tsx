'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Project, type Run } from '../../lib/api';
import { StatusDot, relativeTime } from '../../components/ui';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';

export default function RunsPage() {
  const router = useRouter();
  const toast = useToast();
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
      setStarting(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      {error && (
          <p
            role="alert"
            className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm"
          >
            {error}
          </p>
        )}

        <section className="mb-12">
          <div className="mb-4 flex items-baseline justify-between">
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <Link href="/onboarding" className="text-accent text-sm hover:underline">
              + Add app
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((project) => (
              <div key={project.id} className="border-line bg-surface-1 lift rounded-xl border p-5">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-medium">{project.name}</h3>
                  <span className="border-line text-ink-faint rounded border px-1.5 py-0.5 font-mono text-[10px]">
                    {project.primaryFramework.toLowerCase()}
                  </span>
                </div>
                <p className="text-ink-faint mt-1.5 text-xs">
                  {project._count.tests} tests · {project._count.runs} runs
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {project.environments.map((env) => (
                    <button
                      key={env.id}
                      type="button"
                      disabled={starting}
                      onClick={() => void startRun(env.id)}
                      className="bg-accent rounded-md px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      ▶ Run {env.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {projects.length === 0 && (
              <EmptyState
                title="No apps connected yet"
                body="Point QAAI at a URL or a repo and it explores the app, writes the tests, and runs them. Nothing to install first."
                action={{ label: 'Add your app', href: '/onboarding' }}
                secondary={{ label: 'Import existing tests', href: '/onboarding?mode=import' }}
              />
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold tracking-tight">Recent runs</h2>
          <div className="border-line divide-line bg-surface-1 divide-y overflow-hidden rounded-xl border">
            {runs.map((run) => (
              <Link
                key={run.id}
                href={`/runs/${run.id}`}
                className="hover:bg-surface-2 flex items-center gap-4 px-4 py-3.5 transition-colors"
              >
                <StatusDot status={run.status} />
                <span className="border-line text-ink-dim rounded border px-1.5 py-0.5 font-mono text-[11px]">
                  {run.id.slice(-8)}
                </span>
                <span className="text-ink-dim text-sm">
                  {run.environment.name}
                  <span className="text-ink-faint"> · {run.trigger.toLowerCase()}</span>
                </span>
                <span className="ml-auto flex items-center gap-3 text-xs">
                  {run.passedCount > 0 && (
                    <span className="text-pass">{run.passedCount} passed</span>
                  )}
                  {run.failedCount > 0 && (
                    <span className="text-fail">{run.failedCount} failed</span>
                  )}
                  {run.flakyCount > 0 && <span className="text-flake">{run.flakyCount} flaky</span>}
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
          </div>
        </section>
    </main>
  );
}
