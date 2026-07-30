'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { API_URL, api, artifactUrl, type Run, type TestResult } from '../../../lib/api';
import { SeverityLabel, StatusDot, VerdictChip, duration } from '../../../components/ui';

/**
 * The cockpit (§8).
 *
 * Left: the suite, grouped by status. Middle: the selected test as a step
 * timeline — the scrubber. Right: the evidence for the selected step, and the
 * Triage verdict card with its review actions.
 */
export default function CockpitPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);

  const [run, setRun] = useState<Run | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [live, setLive] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

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
    if (!run || run.status === 'PASSED' || run.status === 'FAILED' || run.status === 'ERRORED') {
      return;
    }
    const source = new EventSource(`${API_URL}/runs/${runId}/events`, { withCredentials: true });

    const record = (label: string) => (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as { data: Record<string, unknown> };
        setLive((prev) => [`${label} ${JSON.stringify(parsed.data)}`, ...prev].slice(0, 60));
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

  const results = run.results ?? [];
  const selected = results.find((r) => r.test.id === selectedTestId) ?? results[0] ?? null;
  const step = selected?.steps.find((s) => s.index === selectedStep) ?? null;

  return (
    <div className="flex h-screen flex-col">
      <header className="app-drag border-line flex shrink-0 items-center gap-4 border-b px-5 py-3">
        <Link href="/runs" className="text-sm font-semibold tracking-tight">
          QAAI
        </Link>
        <StatusDot status={run.status} />
        <span className="font-mono text-xs">{run.id.slice(-8)}</span>
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
          <Link href="/editor" className="text-ink-faint hover:text-ink">
            Editor
          </Link>
          <a href={`${API_URL}/runs/${run.id}/junit.xml`} className="text-ink-faint hover:text-ink">
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
                <span className="text-ink-faint mt-0.5 flex items-center gap-2 font-mono text-[11px]">
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
                {selected.test.filePath} · {duration(selected.durationMs)} ·{' '}
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
                      <span className="text-ink-faint font-mono text-[11px]">{s.index}</span>
                      <span className="flex-1 text-sm">{s.title}</span>
                      <span className="text-ink-faint font-mono text-[11px]">
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
                          <code className="font-mono text-[11px]">{f.code}</code>
                        </div>
                        <p className="text-ink-dim mt-1 text-xs">{f.message}</p>
                        <p className="text-ink-faint mt-0.5 font-mono text-[11px]">{f.location}</p>
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
              <figcaption className="text-ink-faint mt-1.5 text-[11px]">
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
              <pre className="border-line overflow-x-auto rounded-md border p-3 font-mono text-[11px] whitespace-pre-wrap">
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
              <h3 className="text-ink-dim mb-2 text-xs font-semibold tracking-wider uppercase">
                Live
              </h3>
              <ul className="text-ink-faint space-y-0.5 font-mono text-[10px]">
                {live.map((line, i) => (
                  <li key={i} className="truncate">
                    {line}
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
        <span className="text-ink-faint ml-auto font-mono text-[11px]">{verdict.model}</span>
      </div>

      <p className="text-ink-dim mt-3 text-sm leading-relaxed">{verdict.explanation}</p>

      {verdict.evidence.length > 0 && (
        <ul className="border-line mt-3 space-y-1.5 border-t pt-3">
          {verdict.evidence.map((e, i) => (
            <li key={i} className="text-xs">
              <code className="text-ink-faint font-mono text-[10px]">
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
        <p className="text-ink-faint mt-4 font-mono text-[11px]">
          reviewed · {verdict.reviewState.toLowerCase()}
        </p>
      )}
    </section>
  );
}
