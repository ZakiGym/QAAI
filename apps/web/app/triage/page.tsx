'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, type ClusterReport } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import { useProject } from '../../components/shell/ProjectContext';
import { SECTION_TABS_SLOT_ID } from '../../components/shell/AppShell';
import { Page, PageHeader, SectionLabel, SkeletonRows } from '../../components/ui/layout';
import { CauseGroup, busyKey, type Action, type OwnerRow } from '../../components/triage/CauseGroup';
import {
  groupByCause,
  indexCauses,
  metaFor,
  type CauseGroup as Cause,
  type CauseIndex,
  type TriageVerdict,
  type VerdictKind,
} from '../../components/triage/verdicts';

/**
 * Triage — the screen where a human agrees or disagrees with the machine.
 *
 * ── Why this is grouped by cause ────────────────────────────────────────────
 *
 * It was a flat queue: one row per failure, a detail pane on the right, one
 * decision at a time. That is the right shape for three failures and the wrong
 * one for forty. When a shared dependency breaks, forty tests fail for one
 * reason, and reviewing them individually is exactly the tax this product
 * exists to remove — the answer to all forty is the same sentence and a person
 * should get to say it once.
 *
 * So the queue is now the causes, from the clusterer that already computes
 * them for the cockpit, with the failures listed under each. Two things keep
 * that from becoming a rubber stamp, and both are printed on the screen:
 *
 *   • The server records a group decision as N decisions, not one. What a human
 *     reviewed is a matter of fact and the audit log has to be able to state it.
 *   • It is reversible, and the undo strip stays up until it is used or
 *     dismissed. A four-second toast is not an undo.
 */

interface BulkResponse {
  batch: { id: string; action: string; overriddenTo: string | null } | null;
  applied: number;
  skipped: Array<{ verdictId: string; test: string; reason: string }>;
}

/** What the undo strip needs to remember about the last bulk decision. */
interface AppliedBatch {
  id: string;
  applied: number;
  skipped: number;
  /** The whole sentence, built where the decision was made. */
  sentence: string;
}

/**
 * How many runs' clusters to ask for.
 *
 * Pending verdicts almost always come from one or two runs. The cap exists so
 * that a queue left untouched for a fortnight cannot turn one page load into
 * forty requests; anything past it simply falls through to the singles list,
 * which is the honest degradation — an ungrouped failure, not a wrong group.
 */
const MAX_CLUSTERED_RUNS = 6;

export default function TriagePage() {
  const router = useRouter();
  const toast = useToast();
  const { project } = useProject();

  const [verdicts, setVerdicts] = useState<TriageVerdict[]>([]);
  const [showReviewed, setShowReviewed] = useState(false);
  // `[]` is indistinguishable from "not fetched yet", so without this the empty
  // state — "Nothing to review." — is what rendered during every load.
  const [loading, setLoading] = useState(true);
  /** Which action is in flight, so only that button spins. Null when idle. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<AppliedBatch | null>(null);

  /** testId → who owns it, when an ownership rule matched. */
  const [owners, setOwners] = useState<Map<string, OwnerRow>>(new Map());
  /**
   * Tests the healer has actually written a proposal for.
   *
   * The INTENDED_CHANGE blurb offered "Review the proposed fix for this test →"
   * for every such verdict, on the assumption that a verdict of that kind always
   * has a heal waiting. It does not: the healer runs separately and only for
   * failures it can pattern-match, so the common case for a fresh INTENDED_CHANGE
   * was a link to /heals?test=… that filtered a list down to nothing.
   */
  const [healedTestIds, setHealedTestIds] = useState<Set<string>>(new Set());
  /** testResultId → the cause it belongs to. Empty until the clusters land. */
  const [causes, setCauses] = useState<CauseIndex>(new Map());

  /** The j/k cursor, over causes then singles. */
  const [focusIndex, setFocusIndex] = useState(0);
  /** Which failure's evidence is expanded. One at a time, like a disclosure. */
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(
    async (all: boolean) => {
      try {
        const { verdicts } = await api<{ verdicts: TriageVerdict[] }>(
          `/verdicts${all ? '' : '?state=PENDING'}`,
        );
        setVerdicts(verdicts);
        setOpenId((cur) => (cur && verdicts.some((v) => v.id === cur) ? cur : null));
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

  /*
   * The causes themselves.
   *
   * /clusters/run/:id is the same endpoint the cockpit's "what broke" rail uses,
   * and it is per-run — so this asks once per run represented in the queue and
   * merges the answers on `signature`, which is stable across runs. Failing
   * softly on purpose: without it every failure lands in the singles list and
   * the screen is the flat queue it used to be, which is a worse screen and not
   * a broken one.
   */
  const runKey = useMemo(
    () =>
      [...new Set(verdicts.map((v) => v.testResult.runId))].sort().slice(0, MAX_CLUSTERED_RUNS).join(','),
    [verdicts],
  );

  useEffect(() => {
    if (!runKey) {
      setCauses(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      runKey
        .split(',')
        .map((runId) => api<ClusterReport>(`/clusters/run/${runId}`).catch(() => null)),
    ).then((reports) => {
      if (!cancelled) setCauses(indexCauses(reports));
    });
    return () => {
      cancelled = true;
    };
  }, [runKey]);

  /*
   * Ownership, resolved for what is on screen.
   *
   * Failing silently on purpose: ownership is an enrichment, and a team that has
   * not set up any rules — which is every team on day one — must not see an
   * error on the triage screen because of a feature they are not using. The
   * chips simply do not appear.
   */
  useEffect(() => {
    const projectId = project?.id;
    if (!projectId || verdicts.length === 0) {
      setOwners(new Map());
      return;
    }

    let cancelled = false;
    const testIds = [...new Set(verdicts.map((v) => v.testResult.test.id))].slice(0, 200);

    void api<{ tests: OwnerRow[] }>(
      `/team/ownership/resolve?projectId=${encodeURIComponent(projectId)}&testIds=${testIds.map(encodeURIComponent).join(',')}`,
    )
      .then(({ tests }) => {
        if (cancelled) return;
        setOwners(new Map(tests.filter((row) => row.owner).map((row) => [row.testId, row])));
      })
      .catch(() => {
        if (!cancelled) setOwners(new Map());
      });

    return () => {
      cancelled = true;
    };
  }, [project?.id, verdicts]);

  /*
   * Which failures actually have a fix to review. Same soft-failure contract as
   * ownership: if this call fails the link simply does not appear, which is the
   * safe direction — a missing link costs a click through the sidebar, a dead
   * one costs a click into an empty screen and the belief that the healer is
   * broken.
   *
   * `state=all` on purpose. A proposal that has already been approved or
   * rejected is still worth reading from the failure it came from.
   */
  useEffect(() => {
    if (verdicts.length === 0) {
      setHealedTestIds(new Set());
      return;
    }

    let cancelled = false;
    void api<{ heals: Array<{ testId: string }> }>('/heals?state=all')
      .then(({ heals }) => {
        if (!cancelled) setHealedTestIds(new Set(heals.map((h) => h.testId)));
      })
      .catch(() => {
        if (!cancelled) setHealedTestIds(new Set());
      });

    return () => {
      cancelled = true;
    };
  }, [verdicts]);

  const { groups, singles } = useMemo(
    () => groupByCause(verdicts, causes),
    [verdicts, causes],
  );
  const rows = useMemo(() => [...groups, ...singles], [groups, singles]);
  const openCount = verdicts.filter((v) => v.reviewState === 'PENDING').length;

  // A cursor past the end after a decision emptied the queue would leave the
  // keyboard verbs pointing at nothing.
  useEffect(() => {
    setFocusIndex((index) => Math.max(0, Math.min(index, rows.length - 1)));
  }, [rows.length]);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    const focused = rows[focusIndex];
    // `nearest` so a cursor that is already on screen does not jerk the page —
    // it only scrolls when j/k has walked off the edge of the viewport.
    if (focused) rowRefs.current.get(focused.key)?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex, rows]);

  async function reviewOne(
    verdict: TriageVerdict,
    action: Action,
    overrideTo?: VerdictKind,
    scope = verdict.id,
  ) {
    setBusy(busyKey(scope, action, overrideTo));
    setError(null);
    try {
      await api(`/verdicts/${verdict.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, ...(overrideTo ? { overrideTo } : {}) }),
      });
      toast.success(
        action === 'accept'
          ? 'Verdict accepted.'
          : action === 'mute'
            ? 'Muted — it will not gate.'
            : `Overridden to ${metaFor(overrideTo ?? '').label}.`,
      );
      await load(showReviewed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the review');
    } finally {
      setBusy(null);
    }
  }

  /** One verdict, applied to every pending failure under a cause. */
  async function decideGroup(group: Cause, action: Action, overrideTo?: VerdictKind) {
    const pending = group.members.filter((m) => m.reviewState === 'PENDING');
    if (pending.length === 0) return;
    // A group of one is not a batch: the bulk endpoint would write a batch row
    // with nothing to reconcile, and the undo strip would claim a plural.
    if (pending.length === 1) {
      await reviewOne(pending[0]!, action, overrideTo, group.key);
      return;
    }

    setBusy(busyKey(group.key, action, overrideTo));
    setError(null);
    try {
      const result = await api<BulkResponse>('/team/triage/bulk', {
        method: 'POST',
        body: JSON.stringify({
          action,
          ...(overrideTo ? { overrideTo } : {}),
          verdictIds: pending.map((v) => v.id),
        }),
      });

      if (!result.batch || result.applied === 0) {
        // Everything in the group had already been reviewed by somebody else — a
        // normal race on a shared queue, and not an error.
        toast.toast('info', 'Nothing changed — those were all reviewed already.');
      } else {
        setBatch({
          id: result.batch.id,
          applied: result.applied,
          skipped: result.skipped.length,
          sentence: sentenceFor(action, result.applied, overrideTo),
        });
      }
      await load(showReviewed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply that to the whole cause');
    } finally {
      setBusy(null);
    }
  }

  const undoBatch = useCallback(
    async (id: string) => {
      setBusy('undo');
      setError(null);
      try {
        const result = await api<{ restored: number; keptIds: string[] }>(
          `/team/triage/batches/${id}/undo`,
          { method: 'POST' },
        );
        setBatch(null);
        toast.success(
          result.keptIds.length > 0
            ? `Put ${result.restored} back. ${result.keptIds.length} had been reviewed again since and were left alone.`
            : `Put ${result.restored} back for review.`,
        );
        await load(showReviewed);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not undo that batch');
      } finally {
        setBusy(null);
      }
    },
    [load, showReviewed, toast],
  );

  /*
   * The verbs, on the keyboard.
   *
   * Printed in the legend at the foot of the page, which is the only reason
   * they are discoverable — and the reason they have to actually work: a legend
   * that lists a binding the screen does not implement is worse than no legend.
   *
   * `decideGroup` closes over the current queue and is therefore a new function
   * every render; going through a ref keeps the listener registered once instead
   * of being torn down and rebuilt on every keystroke's re-render.
   */
  const decideRef = useRef(decideGroup);
  decideRef.current = decideGroup;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // Never steal a keystroke from something being typed into.
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) {
        return;
      }

      const focused = rows[focusIndex] ?? null;
      const move = (delta: number) => {
        e.preventDefault();
        setFocusIndex((index) => Math.max(0, Math.min(rows.length - 1, index + delta)));
      };

      switch (e.key) {
        case 'j':
          move(1);
          return;
        case 'k':
          move(-1);
          return;
        case 'u':
          if (batch && busy === null) {
            e.preventDefault();
            void undoBatch(batch.id);
          }
          return;
        case 'Enter': {
          // Enter belongs to whatever is focused if that is a control; this is
          // for when nothing in particular is.
          if (target?.closest('button, a, [role="menuitem"]')) return;
          const first = focused?.members[0];
          if (first) {
            e.preventDefault();
            setOpenId((cur) => (cur === first.id ? null : first.id));
          }
          return;
        }
        default:
          break;
      }

      if (!focused || busy !== null) return;
      const action: [Action, VerdictKind?] | null =
        e.key === 'a'
          ? ['accept']
          : e.key === 'f'
            ? ['override', 'FLAKE']
            : e.key === 'i'
              ? ['override', 'INTENDED_CHANGE']
              : e.key === 'm'
                ? ['mute']
                : null;
      if (!action) return;
      e.preventDefault();
      void decideRef.current(focused, action[0], action[1]);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, focusIndex, batch, busy, undoBatch]);

  return (
    <Page width="triage">
      <PageHeader
        eyebrow={project ? `${project.name} · Verdict queue` : 'Verdict queue'}
        title="Triage"
        subtitle={
          loading ? (
            <>The agent decided; you get the last word.</>
          ) : (
            <>
              <span className="tabular-nums">{openCount}</span> open
              {groups.length > 0 ? ', grouped by cause' : ''}. The agent decided; you get the last
              word.
            </>
          )
        }
        actions={
          <label className="text-ink-dim text-row-sub flex items-center gap-[7px] pb-1">
            <input
              type="checkbox"
              checked={showReviewed}
              onChange={(e) => setShowReviewed(e.target.checked)}
              className="accent-accent"
            />
            Include reviewed
          </label>
        }
      />

      {/* The section strip — VERDICTS / HEALS / QUALITY — is the shell's, and it
          belongs under this page's title, so the shell portals it in here. */}
      <div id={SECTION_TABS_SLOT_ID} />

      {error && (
        <p
          role="alert"
          className="border-fail/40 text-fail text-body-sm mt-5 rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_10%,transparent)] p-3"
        >
          {error}
        </p>
      )}

      {batch && (
        /* Deliberately persistent. The value of an undo is that it is still
           there when you realise you were wrong, which is never within four
           seconds of pressing the button. */
        <div
          role="status"
          className="border-line bg-surface-1 mt-5 flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-2.5"
        >
          <p className="text-body-sm min-w-0 flex-1">
            {batch.sentence}
            <span className="text-ink-faint">
              {' '}
              — recorded as <span className="tabular-nums">{batch.applied}</span>{' '}
              {batch.applied === 1 ? 'decision' : 'decisions'}, reversible
              {batch.skipped > 0 && (
                <>
                  {' · '}
                  <span className="tabular-nums">{batch.skipped}</span> had already been reviewed and
                  were left alone
                </>
              )}
            </span>
          </p>
          <Button
            size="sm"
            onClick={() => void undoBatch(batch.id)}
            disabled={busy !== null}
            loading={busy === 'undo'}
          >
            Undo
          </Button>
          <button
            type="button"
            onClick={() => setBatch(null)}
            aria-label="Dismiss"
            className="text-ink-faint hover:text-ink px-0.5 text-[13px] transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {loading ? (
        <div className="mt-8">
          <SkeletonRows rows={6} />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="Nothing to review."
            body="Verdicts appear when a failing test is triaged. Every failure the agent has already decided on, and you have agreed with, leaves this queue."
            action={{ label: 'Look at the runs', href: '/runs' }}
          />
        </div>
      ) : (
        <>
          <div className="mt-8 space-y-7">
            {groups.map((group, index) => (
              <div
                key={group.key}
                ref={(node) => {
                  if (node) rowRefs.current.set(group.key, node);
                  else rowRefs.current.delete(group.key);
                }}
              >
                <CauseGroup
                  group={group}
                  focused={focusIndex === index}
                  owners={owners}
                  healedTestIds={healedTestIds}
                  openId={openId}
                  onToggleEvidence={(id) => setOpenId((cur) => (cur === id ? null : id))}
                  onFocus={() => setFocusIndex(index)}
                  onDecideGroup={(action, to) => void decideGroup(group, action, to)}
                  onDecideOne={(verdict, action, to) => void reviewOne(verdict, action, to)}
                  busy={busy}
                />
              </div>
            ))}
          </div>

          {singles.length > 0 && (
            <div className="mt-9">
              {groups.length > 0 && (
                /* Said out loud, because "one row" and "a group with one member
                   in it" are different claims and only one of them is true. */
                <SectionLabel className="mb-3">Causes of one</SectionLabel>
              )}
              <div className="space-y-7">
                {singles.map((group, index) => (
                  <div
                    key={group.key}
                    ref={(node) => {
                      if (node) rowRefs.current.set(group.key, node);
                      else rowRefs.current.delete(group.key);
                    }}
                  >
                    <CauseGroup
                      group={group}
                      focused={focusIndex === groups.length + index}
                      owners={owners}
                      healedTestIds={healedTestIds}
                      openId={openId}
                      onToggleEvidence={(id) => setOpenId((cur) => (cur === id ? null : id))}
                      onFocus={() => setFocusIndex(groups.length + index)}
                      onDecideGroup={(action, to) => void decideGroup(group, action, to)}
                      onDecideOne={(verdict, action, to) => void reviewOne(verdict, action, to)}
                      busy={busy}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-ink-faint mt-11 text-center font-mono text-[10.5px]">
            j/k move · a agree · f flake · i intended · m mute · u undo · ⏎ evidence
          </p>
        </>
      )}
    </Page>
  );
}

/** What the undo strip says happened, in the words a person would use. */
function sentenceFor(action: Action, applied: number, overrideTo?: VerdictKind): string {
  const failures = `${applied} ${applied === 1 ? 'failure' : 'failures'}`;
  if (action === 'accept') return `Agreed with ${failures} in one go`;
  if (action === 'mute') return `Muted ${failures} in one go`;
  return `Called ${failures} ${metaFor(overrideTo ?? '').label.toLowerCase()} in one go`;
}
