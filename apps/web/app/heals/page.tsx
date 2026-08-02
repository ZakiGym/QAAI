'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type Heal } from '../../lib/api';
import { DiffView } from '../../components/DiffView';
import { relativeTime } from '../../components/ui';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';
import { Badge, Page, PageHeader, Skeleton, SkeletonRows } from '../../components/ui/layout';

/**
 * Self-healing review (§3.4).
 *
 * When the app changes on purpose, QAAI proposes the code fix — and a human
 * decides. The whole screen is built around making that decision fast and
 * informed: what changed, how risky it is, how sure the agent is, and whether
 * the patch still applies. Approving writes the fix to the test immediately.
 *
 * The risk level is the most important thing on the page, because the three
 * levels are genuinely different decisions: a renamed selector is a rubber
 * stamp, a changed assertion means the test now checks something different, and
 * a structural change deserves reading properly.
 */

type Tone = 'neutral' | 'accent' | 'pass' | 'fail' | 'flake';

const RISK: Record<string, { label: string; blurb: string; tone: Tone; dot: string }> = {
  SELECTOR_ONLY: {
    label: 'Selector only',
    blurb: 'Only a locator changed. No assertion was touched, so the test still checks the same thing.',
    tone: 'pass',
    dot: 'bg-pass',
  },
  ASSERTION_CHANGE: {
    label: 'Assertion change',
    blurb: 'An expected value changed — read this one. After applying, the test checks something different than before.',
    tone: 'flake',
    dot: 'bg-flake',
  },
  STRUCTURAL: {
    label: 'Structural',
    blurb: 'Steps were added, removed, or reordered. Review it as you would a colleague’s pull request.',
    tone: 'fail',
    dot: 'bg-fail',
  },
};

const STATE_LABEL: Record<string, string> = {
  PROPOSED: 'Awaiting review',
  APPROVED: 'Approved',
  APPLIED: 'Applied',
  AUTO_APPLIED: 'Auto-applied',
  REJECTED: 'Rejected',
};

/**
 * What approving actually does, said out loud.
 *
 * This used to be a `window.confirm()` — the product's entire trust contract
 * ("the agent proposes, you decide") handed to an unstyleable OS dialog that
 * could say nothing about which file was about to be rewritten.
 */
function confirmBody(heal: Heal): string {
  const lead =
    heal.riskLevel === 'ASSERTION_CHANGE'
      ? 'This changes what the test asserts. Apply it?'
      : 'This restructures the test. Apply it?';
  return `${lead} The diff is written to ${heal.test.filePath} straight away and every later run uses the new version. A version is recorded first, so you can revert it.`;
}

/**
 * `?test=<id>` arrives from triage, where an INTENDED_CHANGE verdict says "the
 * healer proposes a fix" — that sentence pointed at the whole queue and left
 * you to find the one proposal it meant. `useSearchParams` needs a Suspense
 * boundary in the app router, so the page is split around one.
 */
export default function HealsPage() {
  return (
    <Suspense
      fallback={
        <Page width="full">
          <SkeletonRows rows={7} />
        </Page>
      }
    >
      <HealsPageInner />
    </Suspense>
  );
}

function HealsPageInner() {
  const router = useRouter();
  const focusTestId = useSearchParams().get('test');
  const [heals, setHeals] = useState<Heal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Without this the queue's empty state — "Nothing to review." — is what
  // rendered while the first fetch was still running.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The heal awaiting an explicit "yes". Null when no dialog is open. */
  const [confirming, setConfirming] = useState<Heal | null>(null);

  const load = useCallback(
    async (all: boolean) => {
      try {
        const { heals } = await api<{ heals: Heal[] }>(`/heals${all ? '?state=all' : ''}`);
        setHeals(heals);
        setSelectedId((cur) => {
          if (cur && heals.some((h) => h.id === cur)) return cur;
          // A ?test= link opens on that test's proposal. It does NOT filter the
          // queue: the rest of the list is context you want while deciding, and
          // hiding it would make the link feel like a different screen.
          const focused = focusTestId ? heals.find((h) => h.test.id === focusTestId) : undefined;
          return focused?.id ?? heals[0]?.id ?? null;
        });
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load proposals');
      } finally {
        // Only the first fetch shows skeletons; a refetch after a decision
        // keeps the queue on screen.
        setLoading(false);
      }
    },
    [router, focusTestId],
  );

  useEffect(() => {
    void load(showAll);
  }, [load, showAll]);

  const selected = heals.find((h) => h.id === selectedId) ?? null;

  function decide(heal: Heal, approve: boolean) {
    if (approve && heal.riskLevel !== 'SELECTOR_ONLY') {
      setConfirming(heal);
      return;
    }
    void submit(heal, approve);
  }

  async function submit(heal: Heal, approve: boolean) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { note } = await api<{ note?: string }>(`/heals/${heal.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ approve }),
      });
      setNote(note ?? (approve ? 'Applied.' : 'Rejected.'));
      await load(showAll);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the decision');
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  return (
    <Page width="full">
      <PageHeader
        title="Self-healing"
        subtitle="The agent proposes; you decide. Approving writes the fix to the test."
        actions={
          <label className="text-ink-dim flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-accent"
            />
            Include decided
          </label>
        }
        className="border-line mb-0 shrink-0 items-center border-b px-6 py-4"
      />

      {/*
        A ?test= link that matched nothing must say so. Silently showing the top
        of the queue would make the triage screen's "review the proposed fix"
        into a sentence that lands you on somebody else's test — which is worse
        than the dead-end it replaced.
      */}
      {!loading && focusTestId && !heals.some((h) => h.test.id === focusTestId) && (
        <div className="shrink-0 px-6 pt-4">
          <p className="border-line bg-surface-1 text-ink-dim rounded-md border p-3 text-sm">
            No proposal for that test{showAll ? '' : ' is awaiting review'}. The healer writes one
            when triage decides a failure was an intended change{showAll ? '' : ', and decided ones are hidden — tick “Include decided” to see them'}.{' '}
            <Link href={`/tests/${focusTestId}`} className="text-accent hover:underline">
              Open the test →
            </Link>
          </p>
        </div>
      )}

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

      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr]">
        {/* Queue */}
        <aside className="border-line min-h-0 overflow-y-auto border-r">
          {loading ? (
            <SkeletonRows rows={7} />
          ) : heals.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Nothing to review."
                body="Proposals appear when triage decides a failure was an intended change."
              />
            </div>
          ) : (
            heals.map((heal) => {
              const risk = RISK[heal.riskLevel] ?? RISK.STRUCTURAL!;
              return (
                <button
                  key={heal.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(heal.id);
                    setNote(null);
                  }}
                  className={`border-line/60 flex w-full flex-col gap-1 border-b px-4 py-3 text-left ${
                    selectedId === heal.id ? 'bg-surface-2' : 'hover:bg-surface-1'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${risk.dot}`} />
                    <span className="min-w-0 flex-1 truncate text-body-sm font-medium">
                      {heal.test.name}
                    </span>
                    {heal.state !== 'PROPOSED' && (
                      <span className="text-ink-faint shrink-0 text-meta">
                        {STATE_LABEL[heal.state] ?? heal.state}
                      </span>
                    )}
                  </div>
                  <span className="text-ink-faint truncate font-mono text-meta">
                    {heal.test.filePath}
                  </span>
                  <div className="text-ink-faint flex items-center gap-2 text-meta">
                    <span>{risk.label}</span>
                    <span>·</span>
                    <span className="tabular-nums">{Math.round(heal.confidence * 100)}% sure</span>
                    {!heal.preview.applies && <span className="text-flake">· stale</span>}
                    <span className="ml-auto shrink-0 tabular-nums">
                      {relativeTime(heal.createdAt)}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </aside>

        {/* Detail */}
        {loading ? (
          <section className="min-h-0 overflow-y-auto px-6 py-5">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="mt-2.5 h-3 w-44" />
            <Skeleton className="mt-6 h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-11/12" />
            <Skeleton className="mt-8 h-56 w-full" />
          </section>
        ) : selected ? (
          <section className="flex min-h-0 flex-col">
            <div className="border-line shrink-0 border-b px-6 py-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-medium">{selected.test.name}</h2>
                  <Link
                    href={`/editor?test=${selected.test.id}`}
                    className="text-ink-faint hover:text-accent font-mono text-micro"
                  >
                    {selected.test.filePath} →
                  </Link>
                </div>
                <Badge
                  tone={(RISK[selected.riskLevel] ?? RISK.STRUCTURAL!).tone}
                  mono
                  className="rounded-md px-2"
                >
                  {(RISK[selected.riskLevel] ?? RISK.STRUCTURAL!).label}
                </Badge>
                <Badge mono className="text-ink-dim rounded-md px-2 tabular-nums">
                  {Math.round(selected.confidence * 100)}% confident
                </Badge>
                <span className="text-ink-faint shrink-0 self-center text-meta tabular-nums">
                  {relativeTime(selected.createdAt)}
                </span>
              </div>

              <p className="text-ink-dim mt-3 text-sm leading-relaxed">{selected.explanation}</p>
              <p className="text-ink-faint mt-2 text-xs">
                {(RISK[selected.riskLevel] ?? RISK.STRUCTURAL!).blurb}
              </p>

              {!selected.preview.applies && (
                <p className="border-flake/40 bg-flake/10 text-flake mt-3 rounded-md border p-2.5 text-xs">
                  {selected.preview.reason}
                </p>
              )}
              {selected.preview.applies && (selected.preview.fuzz ?? 0) > 0 && (
                <p className="text-ink-faint mt-3 text-xs">
                  The patch needs <span className="tabular-nums">{selected.preview.fuzz}</span>{' '}
                  line(s) of fuzz to fit — check the result.
                </p>
              )}

              {selected.state === 'PROPOSED' && (
                <div className="mt-4 flex items-center gap-2">
                  <Button
                    variant="primary"
                    onClick={() => decide(selected, true)}
                    disabled={busy || !selected.preview.applies}
                    loading={busy}
                    title={
                      selected.preview.applies ? undefined : 'The diff no longer applies to this test'
                    }
                  >
                    {busy ? 'Applying…' : 'Apply fix'}
                  </Button>
                  <Button
                    onClick={() => decide(selected, false)}
                    disabled={busy}
                    className="hover:border-fail"
                  >
                    Reject
                  </Button>
                  <span className="text-ink-faint ml-2 text-micro">
                    Applying updates the test and records a version you can revert.
                  </span>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1">
              {selected.preview.applies && selected.preview.code ? (
                <DiffView
                  original={selected.test.code}
                  modified={selected.preview.code}
                  language={selected.test.filePath.endsWith('.json') ? 'json' : 'typescript'}
                />
              ) : (
                <pre className="text-ink-dim h-full overflow-auto p-6 font-mono text-micro whitespace-pre-wrap">
                  {selected.diff}
                </pre>
              )}
            </div>
          </section>
        ) : (
          <section className="grid place-items-center">
            <p className="text-ink-faint text-sm">Select a proposal.</p>
          </section>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          open
          onClose={() => {
            if (!busy) setConfirming(null);
          }}
          onConfirm={() => void submit(confirming, true)}
          title="Apply this fix?"
          body={confirmBody(confirming)}
          confirmLabel="Apply fix"
          busy={busy}
        />
      )}
    </Page>
  );
}
