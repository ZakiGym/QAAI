'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';
import { relativeTime } from '../../components/ui';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import {
  Badge,
  Page,
  PageHeader,
  SectionLabel,
  Skeleton,
  SkeletonRows,
} from '../../components/ui/layout';

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

type Tone = 'neutral' | 'accent' | 'pass' | 'fail' | 'flake';

const VERDICT_META: Record<string, { label: string; blurb: string; tone: Tone }> = {
  REAL_BUG: {
    label: 'Real bug',
    blurb: 'The application is wrong. This is the only verdict that blocks a merge by default.',
    tone: 'fail',
  },
  INTENDED_CHANGE: {
    label: 'Intended change',
    blurb: 'The app changed on purpose and the test is now out of date — the healer proposes a fix.',
    tone: 'flake',
  },
  FLAKE: {
    label: 'Flake',
    blurb: 'Nothing is broken; the test is unreliable. Consider quarantining it.',
    tone: 'flake',
  },
  ENV_ISSUE: {
    label: 'Environment issue',
    blurb: 'The environment failed, not the app. Alerts, never gates.',
    tone: 'neutral',
  },
};

const OVERRIDES = ['REAL_BUG', 'INTENDED_CHANGE', 'FLAKE', 'ENV_ISSUE'] as const;

export default function TriagePage() {
  const router = useRouter();
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);
  // `[]` is indistinguishable from "not fetched yet", so without this the empty
  // state — "Nothing to review." — is what rendered during every load.
  const [loading, setLoading] = useState(true);
  /** Which action is in flight, so only that button spins. Null when idle. */
  const [busy, setBusy] = useState<string | null>(null);
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
      } finally {
        // Only the first fetch shows skeletons; refetches after a review keep
        // the list on screen rather than blinking it away.
        setLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    void load(showReviewed);
  }, [load, showReviewed]);

  const selected = verdicts.find((v) => v.id === selectedId) ?? null;

  async function review(verdict: Verdict, action: 'accept' | 'override' | 'mute', overrideTo?: string) {
    setBusy(overrideTo ?? action);
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
      setBusy(null);
    }
  }

  return (
    <Page width="full">
      <PageHeader
        title="Triage"
        subtitle={<>The agent&rsquo;s call on every failure. You get the last word.</>}
        actions={
          <label className="text-ink-dim flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={showReviewed}
              onChange={(e) => setShowReviewed(e.target.checked)}
              className="accent-accent"
            />
            Include reviewed
          </label>
        }
        className="border-line mb-0 shrink-0 items-center border-b px-6 py-4"
      />

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
          {loading ? (
            <SkeletonRows rows={7} />
          ) : verdicts.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Nothing to review."
                body="Verdicts appear when a failing test is triaged."
              />
            </div>
          ) : (
            verdicts.map((v) => {
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
                    <Badge tone={meta.tone} mono>
                      {meta.label}
                    </Badge>
                    <span className="tabular-nums">{Math.round(v.confidence * 100)}%</span>
                    {v.reviewState !== 'PENDING' && <span>· {v.reviewState.toLowerCase()}</span>}
                    <span className="ml-auto shrink-0 tabular-nums">{relativeTime(v.createdAt)}</span>
                  </div>
                </button>
              );
            })
          )}
        </aside>

        {loading ? (
          <section className="min-h-0 overflow-y-auto px-6 py-5">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="mt-2.5 h-3 w-44" />
            <Skeleton className="mt-6 h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-11/12" />
            <Skeleton className="mt-2 h-3 w-3/5" />
            <Skeleton className="mt-8 h-28 w-full" />
          </section>
        ) : selected ? (
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
              <Badge
                tone={(VERDICT_META[selected.verdict] ?? VERDICT_META.ENV_ISSUE!).tone}
                mono
                className="rounded-md px-2"
              >
                {(VERDICT_META[selected.verdict] ?? VERDICT_META.ENV_ISSUE!).label}
              </Badge>
              <Badge mono className="text-ink-dim rounded-md px-2 tabular-nums">
                {Math.round(selected.confidence * 100)}% confident
              </Badge>
            </div>

            <p className="text-ink-dim mt-4 text-sm leading-relaxed">{selected.explanation}</p>
            <p className="text-ink-faint mt-2 text-xs">
              {(VERDICT_META[selected.verdict] ?? VERDICT_META.ENV_ISSUE!).blurb}
            </p>

            <div className="mt-6">
              <SectionLabel>Evidence it used</SectionLabel>
            </div>
            <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
              {selected.evidence.map((e, i) => (
                <div key={i} className="px-4 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <Badge mono>{e.kind}</Badge>
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
            <p className="text-ink-faint mt-2 text-micro">
              Decided by {selected.model}.{' '}
              <span className="tabular-nums">{relativeTime(selected.createdAt)}</span>
            </p>

            {selected.reviewState === 'PENDING' ? (
              <div className="border-line mt-6 rounded-lg border p-4">
                <p className="mb-3 text-sm font-medium">Do you agree?</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    onClick={() => void review(selected, 'accept')}
                    disabled={busy !== null}
                    loading={busy === 'accept'}
                  >
                    Agree
                  </Button>
                  <Button
                    onClick={() => void review(selected, 'mute')}
                    disabled={busy !== null}
                    loading={busy === 'mute'}
                  >
                    Mute
                  </Button>
                </div>
                <p className="text-ink-faint mt-4 mb-2 text-xs">Or say what it really was:</p>
                <div className="flex flex-wrap gap-2">
                  {OVERRIDES.filter((o) => o !== selected.verdict).map((o) => (
                    <Button
                      key={o}
                      size="sm"
                      onClick={() => void review(selected, 'override', o)}
                      disabled={busy !== null}
                      loading={busy === o}
                    >
                      {(VERDICT_META[o] ?? VERDICT_META.ENV_ISSUE!).label}
                    </Button>
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
    </Page>
  );
}
