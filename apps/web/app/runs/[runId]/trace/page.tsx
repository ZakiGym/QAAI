'use client';

import { Suspense, use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, artifactUrl, type Run, type TestResult } from '../../../../lib/api';
import { StatusDot, duration } from '../../../../components/ui';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { SkeletonRows } from '../../../../components/ui/layout';
import { TraceViewer } from '../../../../components/TraceViewer';

/**
 * The trace route (§8) — full width, because a 1280px viewport rendered inside
 * a 5xl column is a thumbnail, and the whole point is to look at the page.
 *
 * The page itself owns only two things: which test result is being viewed, and
 * the header that lets you change it. Everything below is `<TraceViewer/>`.
 *
 * The result lives in `?result=` rather than in component state so the URL is
 * the thing you paste into a bug report — "here is the failure, here is the
 * action, look at the DOM" is a link, not a set of instructions.
 */
export default function TraceRoute({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  return (
    <Suspense fallback={<main className="text-ink-faint p-10 text-body-sm">Loading…</main>}>
      <TraceRouteInner runId={runId} />
    </Suspense>
  );
}

function TraceRouteInner({ runId }: { runId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get('result');

  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ run: Run }>(`/runs/${runId}`)
      .then((loaded) => {
        if (!cancelled) setRun(loaded.run);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this run');
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const results = useMemo(() => run?.results ?? [], [run]);

  /**
   * Which test to open on.
   *
   * An explicit `?result=` wins, even when that test kept no trace — the viewer
   * explains why rather than silently showing a different test's evidence, and
   * silently redirecting a shared link is worse than an honest empty state.
   */
  const selected = useMemo((): TestResult | null => {
    if (requested) return results.find((result) => result.id === requested) ?? null;
    const withTrace = results.filter((result) => result.traceKey);
    const failing = withTrace.find(
      (result) => result.status !== 'PASSED' && result.status !== 'SKIPPED',
    );
    return failing ?? withTrace[0] ?? results[0] ?? null;
  }, [requested, results]);

  if (error) {
    return (
      <main className="p-10">
        <EmptyState
          title="This run could not be loaded"
          body={error}
          action={{ label: 'Back to runs', href: '/runs' }}
        />
      </main>
    );
  }

  if (!run) {
    return (
      <main className="p-8">
        <SkeletonRows rows={6} />
      </main>
    );
  }

  if (results.length === 0) {
    return (
      <main className="mx-auto w-full max-w-2xl p-10">
        <EmptyState
          title="This run has no test results"
          body="A run that never executed a test has nothing to trace. Re-run it, or open the run to see why it stopped."
          action={{ label: 'Open the run', href: `/runs/${runId}` }}
        />
      </main>
    );
  }

  if (!selected) {
    return (
      <main className="mx-auto w-full max-w-2xl p-10">
        <EmptyState
          title="That test is not in this run"
          body="The result id in the link does not belong to this run — it may have been from a re-run, which creates fresh results under a new id."
          action={{ label: 'Open the run', href: `/runs/${runId}` }}
        />
      </main>
    );
  }

  return (
    /*
     * `flex-1`, not `h-full`. The shell renders the TopBar and the page inside
     * one scroll container, so a page that asks for the container's full height
     * is always taller than the space left for it by exactly the bar. On most
     * screens the overflow is invisible; here the timeline calls scrollIntoView
     * on the failing action, which cashed that overflow in and pulled the whole
     * page — header and all — off the top of the window.
     */
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-line flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-3">
        <Link
          href={`/runs/${runId}`}
          className="text-ink-dim hover:text-ink hover:border-accent border-line flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors"
          title="Back to the cockpit"
        >
          <span aria-hidden>←</span> Run
        </Link>
        <span className="border-line rounded-md border px-2 py-0.5 font-mono text-micro">
          {run.id.slice(-8)}
        </span>

        <span className="flex min-w-0 items-center gap-2">
          <StatusDot status={selected.status} />
          <span className="truncate text-sm" title={selected.test.name}>
            {selected.test.name}
          </span>
          <span className="text-ink-faint shrink-0 text-micro tabular-nums">
            {duration(selected.durationMs)}
          </span>
        </span>

        {/* Only worth a control when there is a choice to make. */}
        {results.length > 1 && (
          <label className="ml-auto flex items-center gap-2 text-micro">
            <span className="text-ink-faint">test</span>
            <select
              value={selected.id}
              onChange={(event) =>
                router.replace(`/runs/${runId}/trace?result=${event.target.value}`)
              }
              className="border-line bg-surface-1 text-ink max-w-64 rounded-md border px-2 py-1 text-micro"
            >
              {results.map((result) => (
                <option key={result.id} value={result.id}>
                  {result.traceKey ? '' : '(no trace) '}
                  {result.test.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className={`flex items-center gap-2 ${results.length > 1 ? '' : 'ml-auto'}`}>
          {selected.videoKey && (
            <a
              href={artifactUrl(runId, selected.videoKey)}
              className="border-line hover:border-accent text-ink-dim hover:text-ink rounded-md border px-2 py-1 text-micro transition-colors"
            >
              Video
            </a>
          )}
          {selected.traceKey && (
            <a
              href={artifactUrl(runId, selected.traceKey)}
              className="border-line hover:border-accent text-ink-dim hover:text-ink rounded-md border px-2 py-1 text-micro transition-colors"
              title="The raw Playwright trace, for opening in trace.playwright.dev"
            >
              Download .zip
            </a>
          )}
        </div>
      </header>

      {/* Remounting per result is deliberate: every cache in the viewer is keyed
          to one trace, and keeping them across a switch shows the wrong DOM. */}
      <TraceViewer key={selected.id} runId={runId} resultId={selected.id} />
    </div>
  );
}
