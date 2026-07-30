'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type Heal } from '../../lib/api';
import { DiffView } from '../../components/DiffView';

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

const RISK: Record<
  string,
  { label: string; blurb: string; className: string; dot: string }
> = {
  SELECTOR_ONLY: {
    label: 'Selector only',
    blurb: 'Only a locator changed. No assertion was touched, so the test still checks the same thing.',
    className: 'border-pass/40 bg-pass/10 text-pass',
    dot: 'bg-pass',
  },
  ASSERTION_CHANGE: {
    label: 'Assertion change',
    blurb: 'An expected value changed — read this one. After applying, the test checks something different than before.',
    className: 'border-flake/40 bg-flake/10 text-flake',
    dot: 'bg-flake',
  },
  STRUCTURAL: {
    label: 'Structural',
    blurb: 'Steps were added, removed, or reordered. Review it as you would a colleague’s pull request.',
    className: 'border-fail/40 bg-fail/10 text-fail',
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

export default function HealsPage() {
  const router = useRouter();
  const [heals, setHeals] = useState<Heal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (all: boolean) => {
      try {
        const { heals } = await api<{ heals: Heal[] }>(`/heals${all ? '?state=all' : ''}`);
        setHeals(heals);
        setSelectedId((cur) => (cur && heals.some((h) => h.id === cur) ? cur : (heals[0]?.id ?? null)));
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load proposals');
      }
    },
    [router],
  );

  useEffect(() => {
    void load(showAll);
  }, [load, showAll]);

  const selected = heals.find((h) => h.id === selectedId) ?? null;

  async function decide(heal: Heal, approve: boolean) {
    if (
      approve &&
      heal.riskLevel !== 'SELECTOR_ONLY' &&
      !confirm(
        heal.riskLevel === 'ASSERTION_CHANGE'
          ? 'This changes what the test asserts. Apply it?'
          : 'This restructures the test. Apply it?',
      )
    ) {
      return;
    }

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
    }
  }

  return (
    <main className="flex h-full flex-col">
      <header className="border-line flex shrink-0 items-baseline gap-3 border-b px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Self-healing</h1>
        <p className="text-ink-faint text-xs">
          The agent proposes; you decide. Approving writes the fix to the test.
        </p>
        <label className="text-ink-dim ml-auto flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="accent-accent"
          />
          Include decided
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

      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr]">
        {/* Queue */}
        <aside className="border-line min-h-0 overflow-y-auto border-r">
          {heals.map((heal) => {
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
                  <span>{Math.round(heal.confidence * 100)}% sure</span>
                  {!heal.preview.applies && <span className="text-flake">· stale</span>}
                </div>
              </button>
            );
          })}
          {heals.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-ink-dim text-sm">Nothing to review.</p>
              <p className="text-ink-faint mt-1 text-xs">
                Proposals appear when triage decides a failure was an intended change.
              </p>
            </div>
          )}
        </aside>

        {/* Detail */}
        {selected ? (
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
                <span
                  className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-meta ${
                    (RISK[selected.riskLevel] ?? RISK.STRUCTURAL!).className
                  }`}
                >
                  {(RISK[selected.riskLevel] ?? RISK.STRUCTURAL!).label}
                </span>
                <span className="border-line text-ink-dim shrink-0 rounded-md border px-2 py-0.5 font-mono text-meta">
                  {Math.round(selected.confidence * 100)}% confident
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
                  The patch needs {selected.preview.fuzz} line(s) of fuzz to fit — check the result.
                </p>
              )}

              {selected.state === 'PROPOSED' && (
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void decide(selected, true)}
                    disabled={busy || !selected.preview.applies}
                    title={
                      selected.preview.applies ? undefined : 'The diff no longer applies to this test'
                    }
                    className="bg-accent rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  >
                    {busy ? 'Applying…' : 'Apply fix'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide(selected, false)}
                    disabled={busy}
                    className="border-line hover:border-fail text-ink-dim rounded-md border px-3 py-1.5 text-xs disabled:opacity-40"
                  >
                    Reject
                  </button>
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
    </main>
  );
}
