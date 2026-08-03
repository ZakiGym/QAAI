'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type Heal } from '../../lib/api';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/Modal';
import { useProject } from '../../components/shell/ProjectContext';
import { SECTION_TABS_SLOT_ID } from '../../components/shell/AppShell';
import { Page, PageHeader, SkeletonRows } from '../../components/ui/layout';
import { HealCard, appliesImmediately } from '../../components/triage/HealCard';

/**
 * Self-healing review (§3.4).
 *
 * When the app changes on purpose, QAAI proposes the code fix — and a human
 * decides. The screen is a stack of proposals rather than a queue with a detail
 * pane: a heal is a small patch and a whole decision, so there is nothing to
 * drill into, and a list you can read top to bottom is faster than a list you
 * have to click through.
 */

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
 * boundary in the app router, so the queue is split off behind one.
 *
 * The title and the section tab strip stay OUTSIDE that boundary. The shell
 * portals the strip into `#qaai-section-tabs`, resolving the element once when
 * the route changes — and a slot that only appears when a Suspense boundary
 * resolves is a slot the shell has already looked for and not found, which
 * left /heals with no way back to Verdicts or Quality.
 */
export default function HealsPage() {
  const { project } = useProject();
  const [showAll, setShowAll] = useState(false);

  return (
    <Page width="triage">
      <PageHeader
        /*
         * The h1 is the SECTION, not the tab — the same rule Tests, Insights
         * and Setup follow. Titling this one "Self-healing" made the heading
         * disagree with the highlighted sidebar row and repeated the eyebrow
         * directly beneath itself; which of the three views you are looking at
         * is the tab strip's job.
         */
        eyebrow={project ? `${project.name} · Self-healing` : 'Self-healing'}
        title="Triage"
        actions={
          <label className="text-ink-dim text-row-sub flex items-center gap-[7px] pb-1">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-accent"
            />
            Include decided
          </label>
        }
      />

      {/* The section strip — VERDICTS / HEALS / QUALITY — is the shell's. */}
      <div id={SECTION_TABS_SLOT_ID} />

      <p className="text-ink-dim text-row mt-5">
        The app changed on purpose; the healer proposes the code fix. Approving writes it to the test
        immediately — a version is recorded first, so it is revertible.
      </p>

      <Suspense
        fallback={
          <div className="mt-5">
            <SkeletonRows rows={4} />
          </div>
        }
      >
        <HealQueue showAll={showAll} />
      </Suspense>
    </Page>
  );
}

function HealQueue({ showAll }: { showAll: boolean }) {
  const router = useRouter();
  const focusTestId = useSearchParams().get('test');
  const [heals, setHeals] = useState<Heal[]>([]);
  // Without this the empty state — "Nothing to review." — is what rendered
  // while the first fetch was still running.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Which proposal is being written, so only its button spins. */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The heal awaiting an explicit "yes". Null when no dialog is open. */
  const [confirming, setConfirming] = useState<Heal | null>(null);

  const load = useCallback(
    async (all: boolean) => {
      try {
        const { heals } = await api<{ heals: Heal[] }>(`/heals${all ? '?state=all' : ''}`);
        setHeals(heals);
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
    [router],
  );

  useEffect(() => {
    void load(showAll);
  }, [load, showAll]);

  /*
   * A ?test= link scrolls to its proposal rather than filtering to it: the rest
   * of the queue is context you want while deciding, and hiding it would make
   * the link feel like a different screen.
   */
  const focusedCard = useRef<HTMLDivElement>(null);
  const focused = focusTestId ? heals.find((h) => h.test.id === focusTestId) : undefined;
  const focusedId = focused?.id ?? null;
  useEffect(() => {
    if (focusedId) focusedCard.current?.scrollIntoView({ block: 'center' });
  }, [focusedId]);

  function decide(heal: Heal, approve: boolean) {
    if (approve && !appliesImmediately(heal)) {
      setConfirming(heal);
      return;
    }
    void submit(heal, approve);
  }

  async function submit(heal: Heal, approve: boolean) {
    setBusyId(heal.id);
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
      setBusyId(null);
      setConfirming(null);
    }
  }

  return (
    <>
      {/*
        A ?test= link that matched nothing must say so. Silently showing the top
        of the queue would make the triage screen's "review the proposed fix"
        into a sentence that lands you on somebody else's test — which is worse
        than the dead-end it replaced.
      */}
      {!loading && focusTestId && !focused && (
        <p className="border-line bg-surface-1 text-ink-dim text-body-sm mt-4 rounded-lg border p-3">
          No proposal for that test{showAll ? '' : ' is awaiting review'}. The healer writes one when
          triage decides a failure was an intended change
          {showAll ? '' : ', and decided ones are hidden — tick “Include decided” to see them'}.{' '}
          <Link href={`/tests/${focusTestId}`} className="text-accent hover:underline">
            Open the test →
          </Link>
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="border-fail/40 text-fail text-body-sm mt-4 rounded-lg border bg-[color-mix(in_srgb,var(--color-fail)_10%,transparent)] p-3"
        >
          {error}
        </p>
      )}
      {note && !error && (
        <p
          role="status"
          className="border-pass/40 text-pass text-body-sm mt-4 rounded-lg border bg-[color-mix(in_srgb,var(--color-pass)_10%,transparent)] p-3"
        >
          {note}
        </p>
      )}

      {loading ? (
        <div className="mt-5">
          <SkeletonRows rows={4} />
        </div>
      ) : heals.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title="Nothing to review."
            body="Proposals appear when triage decides a failure was an intended change and the healer can write the fix."
            action={{ label: 'Open triage', href: '/triage' }}
          />
        </div>
      ) : (
        <>
          <div className="mt-4 space-y-3.5">
            {heals.map((heal) => (
              <div key={heal.id} ref={heal.id === focused?.id ? focusedCard : undefined}>
                <HealCard
                  heal={heal}
                  focused={heal.id === focused?.id}
                  busy={busyId === heal.id}
                  frozen={busyId !== null}
                  onApply={() => decide(heal, true)}
                  onReject={() => decide(heal, false)}
                />
              </div>
            ))}
          </div>

          {/* The policy, printed where the decisions are made. Every clause is
              enforced in packages/agent/src/healer.ts — if that changes, this
              sentence has to change with it. */}
          <p className="text-ink-faint mt-3.5 font-mono text-[10.5px]">
            selector-only fixes may auto-apply where a project opts in · risk is re-derived from the
            diff · anything touching an expect() is refused
          </p>
        </>
      )}

      {confirming && (
        <ConfirmDialog
          open
          onClose={() => {
            if (busyId === null) setConfirming(null);
          }}
          onConfirm={() => void submit(confirming, true)}
          title="Apply this fix?"
          body={confirmBody(confirming)}
          confirmLabel="Apply fix"
          busy={busyId === confirming.id}
        />
      )}
    </>
  );
}
