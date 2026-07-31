'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API_URL, api, artifactUrl, type Run, type TestResult } from '../../../lib/api';
import { SeverityLabel, StatusDot, VerdictChip, duration } from '../../../components/ui';
import { Button } from '../../../components/ui/Button';
import { useToast } from '../../../components/ui/Toast';

/**
 * The cockpit (§8).
 *
 * Left: the suite, grouped by status. Middle: the selected test as a step
 * timeline — the scrubber. Right: the evidence for the selected step, and the
 * Triage verdict card with its review actions.
 */
/**
 * Turning a stream event into a line a person can read.
 *
 * This pane used to render `step {"testId":"cms6vrt5i0003…","index":1,…}` —
 * the raw event payload, straight from the wire. It is the one part of the app
 * a user watches while they wait, and it was showing them our internal schema.
 *
 * Returning null drops an event rather than printing a placeholder for it: an
 * unnamed frame adds noise to the only surface where noise actually costs
 * something, because the whole point is to glance at it and know what is
 * happening.
 */
interface LiveLine {
  text: string;
  tone: string;
}

function describeEvent(label: string, data: Record<string, unknown>): LiveLine | null {
  const str = (key: string): string | null =>
    typeof data[key] === 'string' ? (data[key] as string) : null;
  const num = (key: string): number | null =>
    typeof data[key] === 'number' ? (data[key] as number) : null;

  switch (label) {
    case 'test.started': {
      const name = str('name');
      return name ? { text: `Running ${name}`, tone: 'bg-accent' } : null;
    }
    case 'test.finished': {
      const name = str('name');
      const status = str('status');
      if (!name || !status) return null;
      const ms = num('durationMs');
      const took = ms === null ? '' : ms >= 1000 ? ` · ${(ms / 1000).toFixed(1)}s` : ` · ${ms}ms`;
      const passed = status === 'PASSED';
      return {
        text: `${passed ? 'Passed' : status === 'SKIPPED' ? 'Skipped' : 'Failed'}: ${name}${took}`,
        tone: passed ? 'bg-pass' : status === 'SKIPPED' ? 'bg-skip' : 'bg-fail',
      };
    }
    case 'step': {
      // Step titles are what the test actually did — "Click Add to cart" — and
      // are the most useful thing in the stream.
      const title = str('title');
      if (!title) return null;
      const status = str('status');
      return {
        text: title,
        tone: status === 'FAILED' ? 'bg-fail' : status === 'PASSED' ? 'bg-pass' : 'bg-skip',
      };
    }
    case 'verdict': {
      const verdict = str('verdict');
      return verdict
        ? { text: `Triaged as ${verdict.toLowerCase().replace(/_/g, ' ')}`, tone: 'bg-flake' }
        : null;
    }
    case 'run.finished':
      return { text: 'Run finished', tone: 'bg-accent' };
    default:
      return null;
  }
}

/** A run in one of these states will never emit another event. */
const TERMINAL = new Set(['PASSED', 'FAILED', 'ERRORED', 'CANCELLED']);

export default function CockpitPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);

  const router = useRouter();
  const [run, setRun] = useState<Run | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [live, setLive] = useState<LiveLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  /** Live progress from test.started events — the worker now sends index/total. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const toast = useToast();

  /**
   * Re-run the exact same tests against the same environment. Passing the
   * original test ids rather than the whole project means "re-run" reproduces
   * what you were just looking at, even if it was a subset.
   */
  async function rerun() {
    if (!run || rerunning) return;
    setRerunning(true);
    try {
      const { run: fresh } = await api<{ run: { id: string } }>('/runs', {
        method: 'POST',
        body: JSON.stringify({
          environmentId: run.environmentId,
          testIds: run.results?.map((r) => r.test.id) ?? null,
          trigger: 'MANUAL',
        }),
      });
      router.push(`/runs/${fresh.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the re-run');
      setRerunning(false);
    }
  }

  /**
   * Stop the run.
   *
   * The API writes the status and the worker notices between tests, so this is
   * not instant. The toast says which of the two happened rather than implying
   * the run halted on the spot — otherwise the next thing the user does is
   * click Cancel three more times.
   */
  async function cancel() {
    if (!run || cancelling) return;
    setCancelling(true);
    try {
      const { stopsAfterCurrentTest } = await api<{ stopsAfterCurrentTest: boolean }>(
        `/runs/${runId}/cancel`,
        { method: 'POST' },
      );
      toast.success(
        stopsAfterCurrentTest
          ? 'Cancelling — the test already running will finish first.'
          : 'Run cancelled before it started.',
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel the run');
    } finally {
      setCancelling(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const { run } = await api<{ run: Run }>(`/runs/${runId}`);
      setRun(run);
      setError(null);
      return run;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the run');
      return null;
    }
  }, [runId]);

  useEffect(() => {
    void load().then((loaded) => {
      if (!loaded || selectedTestId) return;
      // Open on the first failure, and on its failing step — that is what the
      // person came to look at, and making them click twice to see the evidence
      // is the difference between a triage tool and a log viewer.
      const failing = loaded.results?.find((r) => r.status !== 'PASSED' && r.status !== 'SKIPPED');
      const target = failing ?? loaded.results?.[0];
      setSelectedTestId(target?.test.id ?? null);
      setSelectedStep(target?.steps.find((s) => s.status === 'FAILED')?.index ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Live events while the run is in flight; the stream closes itself when the
  // run reaches a terminal state, and a final reload picks up the verdicts.
  useEffect(() => {
    if (!run || TERMINAL.has(run.status)) {
      return;
    }
    const source = new EventSource(`${API_URL}/runs/${runId}/events`, { withCredentials: true });

    const record = (label: string) => (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as { data: Record<string, unknown> };
        const line = describeEvent(label, parsed.data);
        if (line) setLive((prev) => [line, ...prev].slice(0, 60));

        // The worker stamps index/total on test.started so the header can say
        // "4 of 11". index is 0-based and names the test about to run, so the
        // count of finished tests is the index itself.
        const { index, total } = parsed.data as { index?: number; total?: number };
        if (label === 'test.started' && typeof index === 'number' && typeof total === 'number') {
          setProgress({ done: index, total });
        }
      } catch {
        /* a malformed frame is not worth surfacing */
      }
      void load();
    };

    for (const type of ['test.started', 'test.finished', 'step', 'verdict', 'run.finished']) {
      source.addEventListener(type, record(type));
    }
    return () => source.close();
  }, [run?.status, runId, load, run]);

  if (error) {
    return (
      <main className="p-10">
        <p className="text-fail">{error}</p>
        <Link href="/runs" className="text-accent mt-4 inline-block text-sm">
          Back to runs
        </Link>
      </main>
    );
  }
  if (!run) return <main className="text-ink-faint p-10 text-sm">Loading…</main>;

  const inFlight = run.status === 'RUNNING' || run.status === 'QUEUED';
  const results = run.results ?? [];
  const selected = results.find((r) => r.test.id === selectedTestId) ?? results[0] ?? null;
  const step = selected?.steps.find((s) => s.index === selectedStep) ?? null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-line flex shrink-0 items-center gap-3 border-b px-5 py-3">
        <Link
          href="/runs"
          className="text-ink-dim hover:text-ink hover:border-accent border-line flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors"
          title="Back to all runs"
        >
          <span aria-hidden>←</span> Runs
        </Link>
        <span className="border-line rounded-md border px-2 py-0.5 font-mono text-micro">
          {run.id.slice(-8)}
        </span>
        <span className="text-ink-dim text-sm">{run.environment.name}</span>

        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="text-pass">{run.passedCount} passed</span>
          {run.failedCount > 0 && <span className="text-fail">{run.failedCount} failed</span>}
          {run.flakyCount > 0 && <span className="text-flake">{run.flakyCount} flaky</span>}
          {run.gateResult && (
            <span
              className={`rounded-md border px-2 py-0.5 font-mono ${
                run.gateResult.passed ? 'border-pass/40 text-pass' : 'border-fail/40 text-fail'
              }`}
              title={run.gateResult.evaluations.map((e) => e.detail).join('\n')}
            >
              gate {run.gateResult.passed ? 'pass' : 'block'}
            </span>
          )}
          {/*
            While a run is in flight the only useful action is stopping it, so
            the button becomes Cancel rather than a greyed-out Re-run with no
            explanation of why it is disabled.
          */}
          {inFlight ? (
            <>
              <span className="text-ink-dim tabular-nums" aria-live="polite">
                {progress ? `${progress.done} of ${progress.total}` : run.status.toLowerCase()}
              </span>
              <Button size="sm" variant="danger" loading={cancelling} onClick={() => void cancel()}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              loading={rerunning}
              onClick={() => void rerun()}
              title="Run the same tests again"
            >
              ↻ Re-run
            </Button>
          )}
          {/* "Is this failure new?" is the first question of any triage, and
              until now there was no way to ask it — re-running pushed you to a
              new run id with no link back to the one you were comparing. */}
          <Link
            href={`/runs/${run.id}/compare`}
            className="text-ink-faint hover:text-ink transition-colors"
            title="Compare with the previous run on this environment"
          >
            Compare
          </Link>
          <a
            href={`${API_URL}/runs/${run.id}/junit.xml`}
            className="text-ink-faint hover:text-ink transition-colors"
          >
            JUnit XML
          </a>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr_380px]">
        {/* ── Left: the suite ─────────────────────────────────────────────── */}
        <aside className="border-line min-h-0 overflow-y-auto border-r">
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              onClick={() => {
                setSelectedTestId(result.test.id);
                setSelectedStep(result.steps.find((s) => s.status === 'FAILED')?.index ?? null);
              }}
              className={`border-line/60 flex w-full items-start gap-2.5 border-b px-4 py-3 text-left ${
                selected?.id === result.id ? 'bg-surface-2' : 'hover:bg-surface-1'
              }`}
            >
              <span className="mt-1.5">
                <StatusDot status={result.status} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{result.test.name}</span>
                <span className="text-ink-faint mt-0.5 flex items-center gap-2 font-mono text-micro">
                  {result.test.type}
                  {result.test.quarantined && <span className="text-flake">quarantined</span>}
                  {result.verdict && <span>{result.verdict.verdict}</span>}
                </span>
              </span>
            </button>
          ))}
        </aside>

        {/* ── Middle: the step scrubber ───────────────────────────────────── */}
        <section className="min-h-0 overflow-y-auto px-5 py-4">
          {selected ? (
            <>
              <h2 className="text-lg font-medium">{selected.test.name}</h2>
              <p className="text-ink-faint mt-1 font-mono text-xs">
                {/* This was dead text on the highest-traffic triage screen,
                    while /heals and /triage both made the same string a link.
                    It goes to the test's own history, which answers the
                    question you ask next: has this always been unreliable? */}
                <Link
                  href={`/tests/${selected.test.id}`}
                  className="hover:text-ink transition-colors hover:underline"
                  title="This test's history"
                >
                  {selected.test.filePath}
                </Link>{' '}
                · <span className="tabular-nums">{duration(selected.durationMs)}</span> ·{' '}
                {selected.test.priority.toLowerCase().replace('_', ' ')}
              </p>

              {selected.retriedAndPassed && (
                <p className="border-flake/40 bg-flake/10 text-flake mt-4 rounded-md border p-3 text-xs">
                  This test failed and then passed on retry. A retry that passes is not a pass — it
                  is a flake candidate, and the gate treats it as one.
                </p>
              )}

              <ol className="mt-5 space-y-1.5">
                {selected.steps.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedStep(s.index)}
                      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left ${
                        selectedStep === s.index
                          ? 'border-accent bg-surface-2'
                          : s.status === 'FAILED'
                            ? 'border-fail/40 bg-fail/5 hover:bg-fail/10'
                            : 'border-line hover:bg-surface-1'
                      }`}
                    >
                      <StatusDot status={s.status} />
                      <span className="text-ink-faint font-mono text-micro">{s.index}</span>
                      <span className="flex-1 text-sm">{s.title}</span>
                      <span className="text-ink-faint font-mono text-micro">
                        {duration(s.durationMs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>

              {selected.steps.length === 0 && selected.errorMessage && (
                <pre className="border-fail/40 bg-fail/5 text-fail mt-5 overflow-x-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
                  {selected.errorMessage}
                </pre>
              )}

              {selected.findings.length > 0 && (
                <section className="mt-8">
                  <h3 className="text-ink-dim mb-2 text-xs font-semibold tracking-wider uppercase">
                    Findings ({selected.findings.length})
                  </h3>
                  <ul className="border-line divide-line divide-y rounded-md border">
                    {selected.findings.map((f) => (
                      <li key={f.id} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <SeverityLabel severity={f.severity} />
                          <code className="font-mono text-micro">{f.code}</code>
                        </div>
                        <p className="text-ink-dim mt-1 text-xs">{f.message}</p>
                        <p className="text-ink-faint mt-0.5 font-mono text-micro">{f.location}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <p className="text-ink-faint text-sm">This run has no results.</p>
          )}
        </section>

        {/* ── Right: evidence and verdict ─────────────────────────────────── */}
        <aside className="border-line min-h-0 overflow-y-auto border-l px-4 py-4">
          {selected?.verdict ? (
            <VerdictCard result={selected} onReviewed={() => void load()} />
          ) : selected && selected.status !== 'PASSED' && selected.status !== 'SKIPPED' ? (
            <p className="border-line text-ink-faint rounded-md border border-dashed p-3 text-xs">
              Triage has not produced a verdict yet. It runs on the worker right after the test
              finishes and needs <code className="font-mono">ANTHROPIC_API_KEY</code> to be set.
            </p>
          ) : null}

          {step?.screenshotKey && (
            <figure className="mt-4">
              <img
                src={artifactUrl(run.id, step.screenshotKey)}
                alt={`Screenshot at step ${step.index}: ${step.title}`}
                className="border-line w-full rounded-md border"
              />
              <figcaption className="text-ink-faint mt-1.5 text-micro">
                Captured at the failing step
              </figcaption>
            </figure>
          )}

          {step?.errorMessage && (
            <div className="mt-4">
              <h3 className="text-ink-dim mb-2 text-xs font-semibold tracking-wider uppercase">
                Step {step.index}
              </h3>
              {(step.expected || step.actual) && (
                <dl className="border-line mb-3 rounded-md border p-3 font-mono text-xs">
                  <dt className="text-ink-faint">expected</dt>
                  <dd className="text-pass mb-2">{step.expected ?? '—'}</dd>
                  <dt className="text-ink-faint">actual</dt>
                  <dd className="text-fail">{step.actual ?? '—'}</dd>
                </dl>
              )}
              <pre className="border-line overflow-x-auto rounded-md border p-3 font-mono text-micro whitespace-pre-wrap">
                {step.errorMessage}
              </pre>
            </div>
          )}

          {(selected?.traceKey || selected?.videoKey) && (
            <div className="mt-4 flex gap-2">
              {selected.traceKey && (
                <a
                  href={artifactUrl(run.id, selected.traceKey)}
                  className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs"
                >
                  Download trace
                </a>
              )}
              {selected.videoKey && (
                <a
                  href={artifactUrl(run.id, selected.videoKey)}
                  className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs"
                >
                  Video
                </a>
              )}
            </div>
          )}

          {live.length > 0 && (
            <div className="mt-6">
              <h3 className="text-ink-dim mb-2 flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
                <span className="bg-accent inline-block h-1.5 w-1.5 animate-pulse rounded-full" />
                Live
              </h3>
              {/* Newest first, so the thing that just happened is where the eye
                  already is — this list is watched, not scrolled. */}
              <ul className="space-y-1" aria-live="polite">
                {live.map((line, i) => (
                  <li
                    key={`${line.text}-${i}`}
                    className={`text-micro flex items-baseline gap-2 ${
                      i === 0 ? 'text-ink-dim' : 'text-ink-faint'
                    }`}
                  >
                    <span className={`mt-1 h-1 w-1 shrink-0 rounded-full ${line.tone}`} />
                    <span className="min-w-0 flex-1 truncate">{line.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The verdict card and its keyboard-first review actions (§8). */
function VerdictCard({ result, onReviewed }: { result: TestResult; onReviewed: () => void }) {
  const [busy, setBusy] = useState(false);
  const verdict = result.verdict!;

  async function review(action: 'accept' | 'override' | 'mute', overrideTo?: string) {
    setBusy(true);
    try {
      await api(`/verdicts/${verdict.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, overrideTo }),
      });
      onReviewed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-line bg-surface-1 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <VerdictChip verdict={verdict.verdict} confidence={verdict.confidence} />
        <span className="text-ink-faint ml-auto font-mono text-micro">{verdict.model}</span>
      </div>

      <p className="text-ink-dim mt-3 text-sm leading-relaxed">{verdict.explanation}</p>

      {verdict.evidence.length > 0 && (
        <ul className="border-line mt-3 space-y-1.5 border-t pt-3">
          {verdict.evidence.map((e, i) => (
            <li key={i} className="text-xs">
              <code className="text-ink-faint font-mono text-meta">
                {e.kind} {e.ref}
              </code>
              <span className="text-ink-dim ml-2">{e.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {verdict.reviewState === 'PENDING' ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void review('accept')}
            className="bg-accent rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void review('override', 'FLAKE')}
            className="border-line rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          >
            It&rsquo;s a flake
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void review('override', 'INTENDED_CHANGE')}
            className="border-line rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          >
            Intended change
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void review('mute')}
            className="border-line text-ink-faint rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          >
            Mute
          </button>
        </div>
      ) : (
        <p className="text-ink-faint mt-4 font-mono text-micro">
          reviewed · {verdict.reviewState.toLowerCase()}
        </p>
      )}
    </section>
  );
}
