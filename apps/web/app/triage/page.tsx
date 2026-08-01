'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';
import { relativeTime } from '../../components/ui';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import { useProject } from '../../components/shell/ProjectContext';
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
 *
 * ── Why this screen also does bulk ──────────────────────────────────────────
 *
 * One verdict at a time is the right shape for three failures and the wrong one
 * for forty. When a shared dependency breaks, forty tests fail for one reason,
 * and reviewing them individually is the tax this product exists to remove: the
 * answer to all forty is the same sentence, and a person should say it once.
 *
 * Two things keep that from becoming a rubber stamp:
 *
 *   • The server records it as N decisions, not one. What a human reviewed is a
 *     matter of fact and the audit log has to be able to state it.
 *   • It is reversible. A bulk action with no undo is one people are right to be
 *     afraid of, and a triage screen people are afraid of is one they stop using.
 *     The undo strip below stays up until it is used or dismissed — a four-second
 *     toast is not an undo.
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

const metaFor = (verdict: string) => VERDICT_META[verdict] ?? VERDICT_META.ENV_ISSUE!;

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
  label: string;
}

interface OwnerRow {
  testId: string;
  owner: { kind: 'USER' | 'TEAM'; id: string; label: string } | null;
  reason: string | null;
}

export default function TriagePage() {
  const router = useRouter();
  const toast = useToast();
  const { project } = useProject();

  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);
  // `[]` is indistinguishable from "not fetched yet", so without this the empty
  // state — "Nothing to review." — is what rendered during every load.
  const [loading, setLoading] = useState(true);
  /** Which action is in flight, so only that button spins. Null when idle. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Ids picked for a bulk decision. Empty means the screen behaves as it always has. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<AppliedBatch | null>(null);
  /** testId → who owns it, when an ownership rule matched. */
  const [owners, setOwners] = useState<Map<string, OwnerRow>>(new Map());

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
        // A selection that survives a reload would apply a decision to rows the
        // user can no longer see.
        setPicked((cur) => new Set([...cur].filter((id) => verdicts.some((v) => v.id === id))));
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
   * Ownership, resolved for what is on screen.
   *
   * Failing softly and silently on purpose: ownership is an enrichment, and a
   * team that has not set up any rules — which is every team on day one — must
   * not see an error on the triage screen because of a feature they are not
   * using. The chips simply do not appear.
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

  const selected = verdicts.find((v) => v.id === selectedId) ?? null;
  const pickable = useMemo(() => verdicts.filter((v) => v.reviewState === 'PENDING'), [verdicts]);
  const allPicked = pickable.length > 0 && pickable.every((v) => picked.has(v.id));

  function togglePicked(id: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function review(
    verdict: Verdict,
    action: 'accept' | 'override' | 'mute',
    overrideTo?: string,
  ) {
    setBusy(overrideTo ?? action);
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

  /** One verdict, applied to everything picked. */
  async function reviewPicked(action: 'accept' | 'override' | 'mute', overrideTo?: string) {
    const verdictIds = [...picked];
    if (verdictIds.length === 0) return;

    setBusy(`bulk:${overrideTo ?? action}`);
    setError(null);
    try {
      const result = await api<BulkResponse>('/team/triage/bulk', {
        method: 'POST',
        body: JSON.stringify({ action, ...(overrideTo ? { overrideTo } : {}), verdictIds }),
      });

      if (!result.batch || result.applied === 0) {
        // Everything picked had already been reviewed by somebody else — a normal
        // race on a shared queue, and not an error.
        toast.toast('info', 'Nothing changed — those were all reviewed already.');
      } else {
        setBatch({
          id: result.batch.id,
          applied: result.applied,
          skipped: result.skipped.length,
          label:
            action === 'accept'
              ? 'agreed with'
              : action === 'mute'
                ? 'muted'
                : `called ${metaFor(overrideTo ?? '').label.toLowerCase()}`,
        });
      }

      setPicked(new Set());
      await load(showReviewed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply that to the selection');
    } finally {
      setBusy(null);
    }
  }

  async function undoBatch(id: string) {
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
  }

  const bulkBusy = busy?.startsWith('bulk:') ?? false;

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

      {(error || batch) && (
        <div className="shrink-0 space-y-3 px-6 pt-4">
          {error && (
            <p role="alert" className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm">
              {error}
            </p>
          )}
          {batch && (
            /* Deliberately persistent. The value of an undo is that it is still
               there when you realise you were wrong, which is never within four
               seconds of pressing the button. */
            <div
              role="status"
              className="border-line bg-surface-1 flex flex-wrap items-center gap-3 rounded-md border p-3"
            >
              <p className="text-body-sm flex-1">
                You {batch.label}{' '}
                <span className="tabular-nums">{batch.applied}</span>{' '}
                {batch.applied === 1 ? 'failure' : 'failures'} in one go.
                {batch.skipped > 0 && (
                  <span className="text-ink-faint">
                    {' '}
                    <span className="tabular-nums">{batch.skipped}</span> had already been reviewed
                    and were left alone.
                  </span>
                )}
              </p>
              <Button
                size="sm"
                onClick={() => void undoBatch(batch.id)}
                disabled={busy !== null}
                loading={busy === 'undo'}
              >
                Undo
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBatch(null)} disabled={busy !== null}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      )}

      {picked.size > 0 && (
        <div className="border-accent/40 bg-accent/5 mx-6 mt-4 shrink-0 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body-sm mr-1 font-medium">
              <span className="tabular-nums">{picked.size}</span> selected
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void reviewPicked('accept')}
              disabled={busy !== null}
              loading={busy === 'bulk:accept'}
            >
              Agree with all
            </Button>
            <Button
              size="sm"
              onClick={() => void reviewPicked('mute')}
              disabled={busy !== null}
              loading={busy === 'bulk:mute'}
            >
              Mute all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPicked(new Set())}
              disabled={busy !== null}
            >
              Clear
            </Button>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-ink-faint text-micro">Or call all of them:</span>
            {OVERRIDES.map((verdict) => (
              <Button
                key={verdict}
                size="sm"
                onClick={() => void reviewPicked('override', verdict)}
                disabled={busy !== null}
                loading={busy === `bulk:${verdict}`}
              >
                {metaFor(verdict).label}
              </Button>
            ))}
          </div>
          <p className="text-ink-faint text-micro mt-2.5">
            {/* The honest description of what the server does, because a bulk
                action that quietly logs itself as one decision is one nobody
                should trust. */}
            Recorded as {picked.size} separate decisions, and reversible.
          </p>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr]">
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
            <>
              {pickable.length > 0 && (
                <div className="border-line/60 flex items-center gap-2 border-b px-4 py-2">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={allPicked}
                    onChange={() =>
                      setPicked(allPicked ? new Set() : new Set(pickable.map((v) => v.id)))
                    }
                    aria-label="Select every failure awaiting review"
                    disabled={bulkBusy}
                  />
                  <span className="text-ink-faint text-meta">
                    <span className="tabular-nums">{pickable.length}</span> awaiting review
                  </span>
                  {project && owners.size > 0 && (
                    <span className="text-ink-faint text-micro ml-auto truncate">
                      owners for {project.name}
                    </span>
                  )}
                </div>
              )}

              {verdicts.map((v) => {
                const meta = metaFor(v.verdict);
                const owner = owners.get(v.testResult.test.id)?.owner ?? null;
                const isPending = v.reviewState === 'PENDING';

                return (
                  <div
                    key={v.id}
                    className={`border-line/60 flex items-start gap-2 border-b pr-2 pl-3 ${
                      selectedId === v.id ? 'bg-surface-2' : 'hover:bg-surface-1'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-accent mt-3.5"
                      checked={picked.has(v.id)}
                      onChange={() => togglePicked(v.id)}
                      // A reviewed verdict cannot be part of a batch: the server
                      // refuses it, and offering it here would promise something
                      // that comes back as a skip.
                      disabled={!isPending || bulkBusy}
                      aria-label={`Select ${v.testResult.test.name}`}
                    />
                    <button
                      type="button"
                      onClick={() => setSelectedId(v.id)}
                      className="flex min-w-0 flex-1 flex-col gap-1 py-3 text-left"
                    >
                      <span className="truncate text-body-sm font-medium">
                        {v.testResult.test.name}
                      </span>
                      <div className="text-ink-faint flex items-center gap-2 text-meta">
                        <Badge tone={meta.tone} mono>
                          {meta.label}
                        </Badge>
                        <span className="tabular-nums">{Math.round(v.confidence * 100)}%</span>
                        {v.reviewState !== 'PENDING' && <span>· {v.reviewState.toLowerCase()}</span>}
                        <span className="ml-auto shrink-0 tabular-nums">
                          {relativeTime(v.createdAt)}
                        </span>
                      </div>
                      {owner && (
                        <span className="text-ink-faint text-micro truncate">{owner.label}</span>
                      )}
                    </button>
                  </div>
                );
              })}
            </>
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
              <Badge tone={metaFor(selected.verdict).tone} mono className="rounded-md px-2">
                {metaFor(selected.verdict).label}
              </Badge>
              <Badge mono className="text-ink-dim rounded-md px-2 tabular-nums">
                {Math.round(selected.confidence * 100)}% confident
              </Badge>
            </div>

            {owners.get(selected.testResult.test.id)?.owner && (
              <p className="text-ink-faint text-micro mt-2">
                Owned by {owners.get(selected.testResult.test.id)!.owner!.label}
                {owners.get(selected.testResult.test.id)!.reason
                  ? ` — ${owners.get(selected.testResult.test.id)!.reason}`
                  : ''}
              </p>
            )}

            <p className="text-ink-dim mt-4 text-sm leading-relaxed">{selected.explanation}</p>
            <p className="text-ink-faint mt-2 text-xs">
              {metaFor(selected.verdict).blurb}
              {/* The blurb has always said "the healer proposes a fix" and then
                  left the user to find /heals in the sidebar on their own. The
                  triage loop was described but never linked together. */}
              {selected.verdict === 'INTENDED_CHANGE' && (
                <>
                  {' '}
                  <Link href="/heals" className="text-accent hover:underline">
                    Review proposed fixes →
                  </Link>
                </>
              )}
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
                      {metaFor(o).label}
                    </Button>
                  ))}
                </div>
                {pickable.length > 1 && picked.size === 0 && (
                  <p className="text-ink-faint text-micro mt-4">
                    {/* The discoverability problem this feature actually has:
                        nobody looks for a checkbox until they know there is one. */}
                    Same cause as others in the list? Tick them on the left and decide once.
                  </p>
                )}
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
