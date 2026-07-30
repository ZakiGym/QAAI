'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';

/**
 * Triage review (§3.3) — the screen where a human agrees or disagrees with the
 * machine.
 *
 * The endpoints have existed since early on and nothing rendered them, which
 * meant the AI's verdict on every failure was recorded and never challengeable.
 * That is the wrong default for a product whose value is "it tells you WHY",
 * so this leads with the evidence and makes disagreeing one click.
 */

interface Verdict {
  id: string;
  verdict: 'REAL_BUG' | 'INTENDED_CHANGE' | 'FLAKE' | 'ENV_ISSUE';
  confidence: number;
  explanation: string;
  evidence: Array<{ kind: string; ref: string; detail: string }>;
  reviewState: 'PENDING' | 'ACCEPTED' | 'OVERRIDDEN' | 'MUTED';
  model: string;
  createdAt: string;
  testResult: {
    id: string;
    runId: string;
    status: string;
    test: { id: string; name: string; filePath: string; priority: string };
  };
}

const VERDICT_META: Record<string, { label: string; blurb: string; className: string }> = {
  REAL_BUG: {
    label: 'Real bug',
    blurb: 'The application is wrong. This is the only verdict that blocks a merge by default.',
    className: 'border-fail/40 bg-fail/10 text-fail',
  },
  INTENDED_CHANGE: {
    label: 'Intended change',
    blurb: 'The app changed on purpose and the test is now out of date — the healer proposes a fix.',
    className: 'border-flake/40 bg-flake/10 text-flake',
  },
  FLAKE: {
    label: 'Flake',
    blurb: 'Nothing is broken; the test is unreliable. Consider quarantining it.',
    className: 'border-flake/40 bg-flake/10 text-flake',
  },
  ENV_ISSUE: {
    label: 'Environment issue',
    blurb: 'The environment failed, not the app. Alerts, never gates.',
    className: 'border-ink-faint/40 bg-surface-2 text-ink-dim',
  },
};

const OVERRIDES = ['REAL_BUG', 'INTENDED_CHANGE', 'FLAKE', 'ENV_ISSUE'] as const;

export default function TriagePage() {
  const router = useRouter();
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    async (all: boolean) => {
      try {
        const { verdicts } = await api<{ verdicts: Verdict[] }>(
          `/verdicts${all ? '' : '?state=PENDING'}`,
        );
        setVerdicts(verdicts);
        setSelectedId((cur) =>
          cur && verdicts.some((v) => v.id === cur) ? cur : (verdicts[0]?.id ?? null),
        );
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load verdicts');
      }
    },
    [router],
  );

  useEffect(() => {
    void load(showReviewed);
  }, [load, showReviewed]);

  const selected = verdicts.find((v) => v.id === selectedId) ?? null;

  async function review(verdict: Verdict, action: 'accept' | 'override' | 'mute', overrideTo?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api(`/verdicts/${verdict.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, ...(overrideTo ? { overrideTo } : {}) }),
      });
      setNote(
        action === 'accept'
          ? 'Verdict accepted.'
          : action === 'mute'
            ? 'Muted — it will not gate.'
            : `Overridden to ${overrideTo}.`,
      );
      await load(showReviewed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the review');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-full flex-col">
      <header className="border-line flex shrink-0 items-baseline gap-3 border-b px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Triage</h1>
        <p className="text-ink-faint text-xs">
          The agent&rsquo;s call on every failure. You get the last word.
        </p>
        <label className="text-ink-dim ml-auto flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={showReviewed}
            onChange={(e) => setShowReviewed(e.target.checked)}
            className="accent-accent"
          />
          Include reviewed
        </label>
      </header>

      {(error || note) && (
        <div className="shrink-0 px-6 pt-4">
          {error && (
            <p role="alert" className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm">
              {error}
            </p>
          )}
          {note && !error && (
            <p className="border-pass/40 bg-pass/10 text-pass rounded-md border p-3 text-sm">{note}</p>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr]">
        <aside className="border-line min-h-0 overflow-y-auto border-r">
          {verdicts.map((v) => {
            const meta = VERDICT_META[v.verdict] ?? VERDICT_META.ENV_ISSUE!;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => {
                  setSelectedId(v.id);
                  setNote(null);
                }}
                className={`border-line/60 flex w-full flex-col gap-1 border-b px-4 py-3 text-left ${
                  selectedId === v.id ? 'bg-surface-2' : 'hover:bg-surface-1'
                }`}
              >
                <span className="truncate text-body-sm font-medium">{v.testResult.test.name}</span>
                <div className="text-ink-faint flex items-center gap-2 text-meta">
                  <span className={`rounded border px-1.5 py-0.5 font-mono ${meta.className}`}>
                    {meta.label}
                  </span>
                  <span>{Math.round(v.confidence * 100)}%</span>
                  {v.reviewState !== 'PENDING' && <span>· {v.reviewState.toLowerCase()}</span>}
                </div>
              </button>
            );
          })}
          {verdicts.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-ink-dim text-sm">Nothing to review.</p>
              <p className="text-ink-faint mt-1 text-xs">
                Verdicts appear when a failing test is triaged.
              </p>
            </div>
          )}
        </aside>

        {selected ? (
          <section className="min-h-0 overflow-y-auto px-6 py-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-medium">{selected.testResult.test.name}</h2>
                <Link
                  href={`/runs/${selected.testResult.runId}`}
                  className="text-ink-faint hover:text-accent font-mono text-micro"
                >
                  {selected.testResult.test.filePath} →
                </Link>
              </div>
              <span
                className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-meta ${
                  (VERDICT_META[selected.verdict] ?? VERDICT_META.ENV_ISSUE!).className
                }`}
              >
                {(VERDICT_META[selected.verdict] ?? VERDICT_META.ENV_ISSUE!).label}
              </span>
              <span className="border-line text-ink-dim shrink-0 rounded-md border px-2 py-0.5 font-mono text-meta">
                {Math.round(selected.confidence * 100)}% confident
              </span>
            </div>

            <p className="text-ink-dim mt-4 text-sm leading-relaxed">{selected.explanation}</p>
            <p className="text-ink-faint mt-2 text-xs">
              {(VERDICT_META[selected.verdict] ?? VERDICT_META.ENV_ISSUE!).blurb}
            </p>

            <h3 className="text-ink-dim mt-6 mb-2 text-xs font-semibold tracking-wider uppercase">
              Evidence it used
            </h3>
            <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
              {selected.evidence.map((e, i) => (
                <div key={i} className="px-4 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="border-line text-ink-faint rounded border px-1.5 py-0.5 font-mono text-[9px]">
                      {e.kind}
                    </span>
                    <span className="text-ink-faint font-mono text-meta">{e.ref}</span>
                  </div>
                  <p className="text-ink-dim mt-1 text-xs">{e.detail}</p>
                </div>
              ))}
              {selected.evidence.length === 0 && (
                <p className="text-ink-faint text-micro px-4 py-3">
                  No screenshot, trace or console output was captured for this failure.
                </p>
              )}
            </div>
            <p className="text-ink-faint mt-2 text-micro">Decided by {selected.model}.</p>

            {selected.reviewState === 'PENDING' ? (
              <div className="border-line mt-6 rounded-lg border p-4">
                <p className="mb-3 text-sm font-medium">Do you agree?</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void review(selected, 'accept')}
                    disabled={busy}
                    className="bg-accent rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Agree
                  </button>
                  <button
                    type="button"
                    onClick={() => void review(selected, 'mute')}
                    disabled={busy}
                    className="border-line hover:border-accent rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    Mute
                  </button>
                </div>
                <p className="text-ink-faint mt-4 mb-2 text-xs">Or say what it really was:</p>
                <div className="flex flex-wrap gap-2">
                  {OVERRIDES.filter((o) => o !== selected.verdict).map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => void review(selected, 'override', o)}
                      disabled={busy}
                      className="border-line hover:border-accent text-ink-dim rounded-md border px-2.5 py-1 text-micro disabled:opacity-50"
                    >
                      {(VERDICT_META[o] ?? VERDICT_META.ENV_ISSUE!).label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-ink-faint mt-6 text-xs">
                Already reviewed — {selected.reviewState.toLowerCase()}.
              </p>
            )}
          </section>
        ) : (
          <section className="grid place-items-center">
            <p className="text-ink-faint text-sm">Select a verdict.</p>
          </section>
        )}
      </div>
    </main>
  );
}
