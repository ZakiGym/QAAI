'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FAILURE_KIND_LABELS, classifyFailureKind } from '@qaai/shared';
import { api, ApiError, type TestResult } from '../../../../lib/api';
import { KIND_TONE } from '../../../../components/runs/FailureSummary';
import { StatusDot, duration, relativeTime } from '../../../../components/ui';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { Badge, Card, Page, PageHeader, SkeletonRows } from '../../../../components/ui/layout';

/**
 * Run comparison (§5) — "is this failure new?"
 *
 * The page is built around one question, so it is built around one list.
 * NEWLY_FAILING renders first, expanded, with the error text visible: that is
 * the regression, and it is the entire reason someone opened this screen.
 * Everything else is a collapsed group underneath, present for confirmation
 * rather than for reading.
 */

type Category = 'NEWLY_FAILING' | 'FIXED' | 'STILL_FAILING' | 'STILL_PASSING' | 'ADDED' | 'REMOVED';

interface Side {
  runId: string;
  status: string;
  durationMs: number;
  errorMessage: string | null;
}

interface Row {
  testId: string;
  category: Category;
  name: string;
  filePath: string;
  type: string;
  priority: string;
  here: Side | null;
  there: Side | null;
  durationDeltaMs: number | null;
}

interface RunSummary {
  id: string;
  status: string;
  queuedAt: string;
  finishedAt: string | null;
  commitSha: string | null;
  branch: string | null;
  environment: { name: string; kind: string };
}

interface Comparison {
  here: RunSummary;
  there: RunSummary | null;
  basis: { mode: 'explicit' | 'auto' | 'none'; reason: string };
  partial: { here: boolean; there: boolean };
  counts: Record<Category, number>;
  total: number;
  rows: Row[];
}

/**
 * Group order is triage order, not alphabetical and not enum order. What broke
 * comes first; what is unchanged comes last, because "still passing" is the one
 * group nobody scrolls to on purpose.
 */
const GROUPS: ReadonlyArray<{
  id: Category;
  label: string;
  /** Said in the group header when the group is empty of drama or full of it. */
  blurb: string;
  tone: 'neutral' | 'accent' | 'pass' | 'fail' | 'flake';
  openByDefault: boolean;
}> = [
  {
    id: 'NEWLY_FAILING',
    label: 'Newly failing',
    blurb: 'Passed in the baseline, fails here. These are the regressions.',
    tone: 'fail',
    openByDefault: true,
  },
  {
    id: 'STILL_FAILING',
    label: 'Still failing',
    blurb: 'Red in both runs — already broken before this one.',
    tone: 'flake',
    openByDefault: false,
  },
  {
    id: 'FIXED',
    label: 'Fixed',
    blurb: 'Failed in the baseline and passes here.',
    tone: 'pass',
    openByDefault: false,
  },
  {
    id: 'ADDED',
    label: 'Added',
    blurb: 'Ran here but not in the baseline, so there is nothing to compare.',
    tone: 'accent',
    openByDefault: false,
  },
  {
    id: 'REMOVED',
    label: 'Removed',
    blurb: 'Ran in the baseline but not here. A test that vanished is not a pass.',
    tone: 'accent',
    openByDefault: false,
  },
  {
    id: 'STILL_PASSING',
    label: 'Unchanged',
    blurb: 'Green in both runs.',
    tone: 'neutral',
    openByDefault: false,
  },
];

/**
 * The comparison API types a side's status as a plain string. The classifier
 * wants the union, and the difference is load-bearing for exactly one rule —
 * a bare TIMED_OUT with no recognisable message.
 */
function resultStatus(raw: string | undefined): TestResult['status'] {
  switch (raw) {
    case 'PASSED':
    case 'SKIPPED':
    case 'FLAKY':
    case 'TIMED_OUT':
      return raw;
    default:
      return 'FAILED';
  }
}

/** Signed, human-readable duration delta. Only shown when it is worth reading. */
function delta(ms: number | null): string | null {
  if (ms === null) return null;
  if (Math.abs(ms) < 250) return null;
  return `${ms > 0 ? '+' : '−'}${duration(Math.abs(ms))}`;
}

export default function ComparePage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);

  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<Category>>(
    () => new Set(GROUPS.filter((g) => g.openByDefault).map((g) => g.id)),
  );

  const load = useCallback(async () => {
    try {
      // `against` is deliberately not a control on this page yet — the server's
      // default (previous completed run, same environment) is the answer 95% of
      // the time, and it explains itself in `basis.reason`.
      setData(await api<Comparison>(`/compare/${runId}`));
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : 'Could not compare this run',
      );
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(id: Category) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const backToCockpit = (
    <Link
      href={`/runs/${runId}`}
      className="text-ink-dim hover:text-ink hover:border-line-strong border-line text-body-sm rounded-md border px-3 py-1.5 transition-colors"
    >
      ← Back to the run
    </Link>
  );

  if (loading) {
    return (
      <Page width="wide">
        <PageHeader title="Compare" subtitle="Working out what changed since the last run." />
        <Card className="overflow-hidden">
          <SkeletonRows rows={6} />
        </Card>
      </Page>
    );
  }

  if (error || !data) {
    return (
      <Page width="wide">
        <PageHeader title="Compare" actions={backToCockpit} />
        <EmptyState
          title="This comparison could not be built"
          body={error ?? 'The run could not be loaded.'}
          action={{ label: 'Back to the run', href: `/runs/${runId}` }}
        />
      </Page>
    );
  }

  const { here, there, basis, counts, partial } = data;
  const newly = data.rows.filter((r) => r.category === 'NEWLY_FAILING');

  return (
    <Page width="wide">
      <PageHeader
        title="Compare"
        subtitle={
          <>
            {/*
              The headline number is the answer to the question the user walked
              in with, so it is said in words before any table appears.
            */}
            {counts.NEWLY_FAILING > 0 ? (
              <span className="text-fail font-medium">
                <span className="tabular-nums">{counts.NEWLY_FAILING}</span>{' '}
                {counts.NEWLY_FAILING === 1 ? 'test is' : 'tests are'} newly failing.
              </span>
            ) : there ? (
              <span className="text-pass font-medium">Nothing broke that was working before.</span>
            ) : (
              <span>No baseline to compare against.</span>
            )}{' '}
            <span className="text-ink-faint">{basis.reason}</span>
          </>
        }
        actions={backToCockpit}
      />

      {(partial.here || partial.there) && (
        <p
          role="status"
          className="border-flake/40 bg-flake/10 text-flake text-body-sm mb-6 rounded-md border p-3"
        >
          {partial.here
            ? 'This run has not finished. Tests that have not executed yet are counted as not-failing, so the comparison will keep changing.'
            : 'The baseline run has not finished, so parts of it are still placeholders.'}
        </p>
      )}

      {/* ── The two runs, side by side ────────────────────────────────────── */}
      <div className="mb-8 grid gap-3 sm:grid-cols-2">
        <RunCard run={here} label="This run" />
        {there ? (
          <RunCard
            run={there}
            label={basis.mode === 'explicit' ? 'Baseline (you picked)' : 'Baseline'}
          />
        ) : (
          <Card className="text-ink-faint text-body-sm flex items-center border-dashed p-4">
            No earlier completed run on {here.environment.name}.
          </Card>
        )}
      </div>

      {!there ? (
        <EmptyState
          title="Nothing to compare this against"
          body={basis.reason}
          action={{ label: 'Back to the run', href: `/runs/${runId}` }}
          secondary={{ label: 'All runs', href: '/runs' }}
        />
      ) : (
        <>
          {/* ── Counts ─────────────────────────────────────────────────────── */}
          <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
            {GROUPS.map((group) => (
              <span key={group.id} className="text-body-sm flex items-center gap-1.5">
                <Badge tone={counts[group.id] > 0 ? group.tone : 'neutral'} mono>
                  {counts[group.id]}
                </Badge>
                <span className={counts[group.id] > 0 ? 'text-ink-dim' : 'text-ink-faint'}>
                  {group.label.toLowerCase()}
                </span>
              </span>
            ))}
          </div>

          {/*
            When nothing regressed, say so where the regression list would have
            been. A page that just shows six collapsed groups leaves the user
            wondering whether it ran at all.
          */}
          {newly.length === 0 && (
            <div className="mb-6">
              <EmptyState
                title="No new failures"
                body={`Every test that passed in the baseline still passes. ${
                  counts.STILL_FAILING > 0
                    ? `${counts.STILL_FAILING} ${
                        counts.STILL_FAILING === 1 ? 'test was' : 'tests were'
                      } already failing before this run.`
                    : ''
                }`.trim()}
              />
            </div>
          )}

          <div className="space-y-4">
            {GROUPS.map((group) => {
              const rows = data.rows.filter((r) => r.category === group.id);
              if (rows.length === 0) return null;
              const isOpen = open.has(group.id);

              return (
                <section key={group.id}>
                  <button
                    type="button"
                    onClick={() => toggle(group.id)}
                    aria-expanded={isOpen}
                    className="hover:text-ink text-ink-dim mb-2 flex w-full items-center gap-2 text-left"
                  >
                    <span className="text-ink-faint text-micro w-3">{isOpen ? '▾' : '▸'}</span>
                    <span className="text-body-sm font-semibold tracking-tight">{group.label}</span>
                    <Badge tone={group.tone} mono>
                      {rows.length}
                    </Badge>
                    <span className="text-ink-faint text-micro hidden sm:inline">
                      {group.blurb}
                    </span>
                  </button>

                  {isOpen && (
                    <Card className="divide-line divide-y overflow-hidden">
                      {rows.map((row) => (
                        <TestRow key={row.testId} row={row} runId={runId} />
                      ))}
                    </Card>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </Page>
  );
}

function RunCard({ run, label }: { run: RunSummary; label: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <StatusDot status={run.status} />
        <span className="text-ink-faint text-micro font-semibold tracking-wider uppercase">
          {label}
        </span>
        {/*
          The baseline was named here and could not be opened. "What was the
          previous run doing?" is the second question this screen raises and the
          answer was a run id you had to paste into the URL bar yourself.
        */}
        <Link
          href={`/runs/${run.id}`}
          className="hover:text-accent ml-auto"
          title="Open this run in the cockpit"
        >
          <Badge mono>{run.id.slice(-8)} →</Badge>
        </Link>
      </div>
      <p className="text-body-sm text-ink-dim mt-2">
        {run.environment.name}
        <span className="text-ink-faint"> · {relativeTime(run.queuedAt)}</span>
      </p>
      {(run.branch || run.commitSha) && (
        <p className="text-ink-faint mt-1 font-mono text-micro">
          {run.branch ?? ''}
          {run.branch && run.commitSha ? ' @ ' : ''}
          {run.commitSha?.slice(0, 7) ?? ''}
        </p>
      )}
    </Card>
  );
}

/**
 * One test, both sides.
 *
 * The row links into the cockpit for whichever run actually has evidence to
 * look at — screenshots and a trace live on the failing side, so a NEWLY_FAILING
 * row points at this run and a REMOVED row points at the baseline.
 */
function TestRow({ row, runId }: { row: Row; runId: string }) {
  const target = row.here ? runId : (row.there?.runId ?? runId);
  const change = delta(row.durationDeltaMs);
  const error = row.here?.errorMessage ?? row.there?.errorMessage ?? null;
  const showError = row.category === 'NEWLY_FAILING' || row.category === 'STILL_FAILING';

  /*
   * The KIND, on the regression list.
   *
   * "Six tests are newly failing" is one number and six investigations. Naming
   * the kind turns the list into a shape you can act on before opening
   * anything — five selector misses after a component rename is one job, and a
   * refused connection sitting among them is a different one that would
   * otherwise be found last.
   *
   * Only the label, and only when a rule actually fired: the error text is
   * already printed underneath, and an unrecognised failure gets no chip
   * rather than a confident wrong one. Nothing about flakiness is passed in
   * either — the group header this row sits under already says whether it
   * passed in the baseline, and better than the classifier could infer it.
   */
  const kind =
    showError && error
      ? classifyFailureKind({
          status: resultStatus(row.here?.status),
          testType: row.type,
          errorMessage: error,
        })
      : null;

  return (
    <Link
      href={`/runs/${target}?test=${row.testId}`}
      className="hover:bg-surface-2 block px-4 py-3 transition-colors"
    >
      <div className="flex items-center gap-3">
        <span className="flex shrink-0 items-center gap-1.5">
          <StatusDot status={row.there?.status ?? 'SKIPPED'} />
          <span className="text-ink-faint text-micro">→</span>
          <StatusDot status={row.here?.status ?? 'SKIPPED'} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-sm">{row.name}</span>
          <span className="text-ink-faint mt-0.5 block truncate font-mono text-micro">
            {row.filePath}
          </span>
        </span>

        {row.priority === 'CRITICAL_PATH' && (
          <Badge tone="fail" className="hidden sm:inline-flex">
            critical path
          </Badge>
        )}
        <Badge mono className="hidden sm:inline-flex">
          {row.type.toLowerCase()}
        </Badge>

        <span className="text-ink-faint text-micro w-28 shrink-0 text-right font-mono tabular-nums">
          {row.there ? row.there.status.toLowerCase() : '—'} →{' '}
          {row.here ? row.here.status.toLowerCase() : '—'}
        </span>
        <span
          className={`text-micro w-16 shrink-0 text-right tabular-nums ${
            change && (row.durationDeltaMs ?? 0) > 0 ? 'text-flake' : 'text-ink-faint'
          }`}
          title={change ? 'Change in how long this test took' : undefined}
        >
          {change ?? ''}
        </span>
      </div>

      {showError && error && (
        <>
          {kind && (
            <span className="mt-2 flex">
              {/* Amber, not red, for the kinds where the application is not the
                  accused — the same tone map the cockpit's summary box uses, so
                  a missing binary does not read as a regression on either
                  screen. */}
              <Badge tone={KIND_TONE[kind]} tint>
                {FAILURE_KIND_LABELS[kind]}
              </Badge>
            </span>
          )}
          <pre className="border-fail/30 bg-fail/5 text-fail mt-2 max-h-24 overflow-hidden rounded-md border p-2 font-mono text-micro whitespace-pre-wrap">
            {error}
          </pre>
        </>
      )}
    </Link>
  );
}
