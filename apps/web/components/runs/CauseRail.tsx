'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type ClusterReport,
  type FailureCluster,
  type UnclusteredFailure,
} from '../../lib/api';
import { cn } from '../../lib/cn';
import type { EvidenceResult } from '../EvidenceRail';

/**
 * WHAT BROKE — the cockpit's left rail.
 *
 * It used to be the suite: one row per test, 128 of them, ordered by nothing in
 * particular. That is the right shape for a run with three results and the
 * wrong one for a red build, where the question is never "which of these 128
 * tests am I looking at" but "how many things actually broke".
 *
 * GET /clusters/run/:id answers that and had been mounted, answering, and
 * called by nothing since failure clustering shipped. It is what makes this
 * rail possible: six failures, three causes, and a representative of each.
 *
 * Two rules the design follows, because both are ways this could lie:
 *
 *   · A cluster of one is not a cluster. The endpoint says so itself by putting
 *     it in `unclustered`, and this rail keeps that distinction visible — a
 *     one-off cause is drawn without a count and reads as one failure, never as
 *     a group of one.
 *   · `summary.failures` counts what was CLUSTERABLE. A result with no error
 *     text at all cannot be grouped, so when it is lower than the run's own
 *     failure count that difference is said out loud rather than quietly
 *     shrinking the total.
 */

interface Cause {
  id: string;
  label: string;
  count: number;
  /** Present only for a real cluster — a single failure gets no recommendation. */
  suggested: FailureCluster['suggested'] | null;
  members: Array<{ testId: string; testName: string }>;
}

function toCause(entry: FailureCluster | UnclusteredFailure): Cause {
  if ('members' in entry) {
    return {
      id: entry.id,
      label: entry.label,
      count: entry.count,
      suggested: entry.suggested,
      members: entry.members.map((m) => ({ testId: m.testId, testName: m.testName })),
    };
  }
  return {
    id: entry.id,
    label: entry.label,
    count: 1,
    suggested: null,
    members: [{ testId: entry.member.testId, testName: entry.member.testName }],
  };
}

/** The recommendation's provenance, in the two or three words the rail has room for. */
const BASIS_LABEL: Record<FailureCluster['suggested']['basis'], string> = {
  HUMAN_OVERRIDE: 'a human already said so',
  TRIAGE_MAJORITY: 'how most of these were triaged',
  SIGNATURE: 'the error signature',
};

export interface CauseRailProps {
  runId: string;
  results: EvidenceResult[];
  selectedTestId: string | null;
  onSelectTest: (testId: string) => void;
}

export function CauseRail({ runId, results, selectedTestId, onSelectTest }: CauseRailProps) {
  const [report, setReport] = useState<ClusterReport | null>(null);
  const [clusteringFailed, setClusteringFailed] = useState(false);
  const [openGroup, setOpenGroup] = useState<'flaky' | 'passed' | null>(null);

  const failing = useMemo(
    () => results.filter((r) => r.status === 'FAILED' || r.status === 'TIMED_OUT'),
    [results],
  );
  const flaky = useMemo(
    () => results.filter((r) => r.status === 'FLAKY' || r.retriedAndPassed),
    [results],
  );
  const passed = useMemo(
    () => results.filter((r) => r.status === 'PASSED' && !r.retriedAndPassed),
    [results],
  );

  useEffect(() => {
    if (failing.length === 0) return;
    let cancelled = false;
    api<ClusterReport>(`/clusters/run/${runId}`)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch(() => {
        // Clustering is derived from results this screen already has, so losing
        // it costs the grouping and nothing else. The rail falls back to one
        // row per failure rather than putting an error banner over the only
        // navigation the cockpit has.
        if (!cancelled) setClusteringFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, failing.length]);

  const causes: Cause[] = useMemo(() => {
    if (report) {
      return [...report.clusters.map(toCause), ...report.unclustered.map(toCause)].sort(
        (a, b) => b.count - a.count,
      );
    }
    if (!clusteringFailed) return [];
    return failing.map((result) => ({
      id: result.id,
      label: result.test.name,
      count: 1,
      suggested: null,
      members: [{ testId: result.test.id, testName: result.test.name }],
    }));
  }, [report, clusteringFailed, failing]);

  /*
   * Which cause is open is DERIVED from the selected test, not stored beside it.
   * Two sources of truth for one selection is how a rail ends up highlighting a
   * cause whose member is not the test the middle pane is showing.
   */
  const openCauseId =
    causes.find((c) => c.members.some((m) => m.testId === selectedTestId))?.id ?? null;

  /*
   * The gap between "results that failed" and "failures we could read". A
   * result whose error text is empty is invisible to the clusterer, and a rail
   * that says "2 causes" above three red tests is the kind of number nobody can
   * reconcile.
   */
  const unread = report ? Math.max(0, failing.length - report.summary.failures) : 0;

  return (
    <aside
      aria-label="What broke"
      className="border-line min-h-0 overflow-y-auto border-r px-3.5 py-4"
    >
      <p className="text-ink-faint text-meta mb-1 font-mono font-semibold tracking-[0.1em] uppercase">
        What broke
      </p>
      <p className="text-ink-faint mb-3 text-[11.5px]">
        {failing.length === 0 ? (
          'Nothing failed'
        ) : (
          <>
            <span className="tabular-nums">{failing.length}</span>{' '}
            {failing.length === 1 ? 'failure' : 'failures'}
            {causes.length > 0 && (
              <>
                {' · '}
                <span className="tabular-nums">{causes.length}</span>{' '}
                {causes.length === 1 ? 'cause' : 'causes'}
              </>
            )}
          </>
        )}
      </p>

      {unread > 0 && (
        // Said out loud: these results are red and carried no error text, so
        // nothing above describes them.
        <p className="text-flake mb-3 text-[11.5px]">
          <span className="tabular-nums">{unread}</span> with no error text to group on
        </p>
      )}

      {failing.length > 0 && causes.length === 0 && !clusteringFailed && (
        <p className="text-ink-faint text-[11.5px]">Grouping the failures…</p>
      )}

      {causes.map((cause) =>
        cause.id === openCauseId ? (
          <div
            key={cause.id}
            className="bg-surface-1 border-line-strong mb-1 rounded-lg border p-3"
          >
            <div className="flex items-baseline gap-2">
              {cause.count > 1 && (
                <span className="text-fail shrink-0 font-mono text-micro font-semibold tabular-nums">
                  ×{cause.count}
                </span>
              )}
              <span className="text-body-sm leading-[1.35] font-semibold">{cause.label}</span>
            </div>
            {cause.suggested && (
              /* A recommendation, labelled as one, with where it came from.
                 Accepting it is still a human action — in the rail on the right,
                 or in bulk on Triage. */
              <p className="text-ink-faint mt-1.5 font-mono text-[10.5px]">
                suggests {cause.suggested.verdict.toLowerCase().replace(/_/g, ' ')} ·{' '}
                {BASIS_LABEL[cause.suggested.basis]}
              </p>
            )}
            <div className="mt-2.5 flex flex-col">
              {cause.members.map((member) => (
                <button
                  key={member.testId}
                  type="button"
                  onClick={() => onSelectTest(member.testId)}
                  aria-current={member.testId === selectedTestId ? 'true' : undefined}
                  className={cn(
                    '-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors',
                    member.testId === selectedTestId
                      ? 'text-ink bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                      : 'text-ink-dim hover:text-ink',
                  )}
                >
                  <span className="bg-fail h-[5px] w-[5px] shrink-0 rounded-full" />
                  <span className="min-w-0 flex-1 truncate">{member.testName}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            key={cause.id}
            type="button"
            // Jump straight to a representative. Naming a cause without being
            // able to look at one of its failures would be a label, not a tool.
            onClick={() => cause.members[0] && onSelectTest(cause.members[0].testId)}
            className="hover:bg-surface-1 mb-1 block w-full rounded-lg p-3 text-left transition-colors"
          >
            <span className="flex items-baseline gap-2">
              {cause.count > 1 && (
                <span className="text-fail shrink-0 font-mono text-micro font-semibold tabular-nums">
                  ×{cause.count}
                </span>
              )}
              <span className="text-ink-dim text-body-sm leading-[1.35]">{cause.label}</span>
            </span>
            {cause.suggested && (
              <span className="text-ink-faint mt-1.5 block font-mono text-[10.5px]">
                suggests {cause.suggested.verdict.toLowerCase().replace(/_/g, ' ')}
              </span>
            )}
          </button>
        ),
      )}

      {/*
        The rest of the suite, collapsed.

        This rail replaced a list of every test in the run, and everything that
        did not fail still has to be reachable — a flake you want to look at, a
        pass you want to confirm actually asserted something. Collapsed, because
        on a red build they are not what you came for.
      */}
      {(flaky.length > 0 || passed.length > 0) && (
        <div className="border-line mt-3 border-t pt-2.5">
          {flaky.length > 0 && (
            <Group
              label={`${flaky.length} flaky — passed on retry`}
              tone="text-flake"
              open={openGroup === 'flaky'}
              onToggle={() => setOpenGroup(openGroup === 'flaky' ? null : 'flaky')}
              results={flaky}
              selectedTestId={selectedTestId}
              onSelectTest={onSelectTest}
            />
          )}
          {passed.length > 0 && (
            <Group
              label={`${passed.length} passed`}
              tone="text-ink-faint"
              open={openGroup === 'passed'}
              onToggle={() => setOpenGroup(openGroup === 'passed' ? null : 'passed')}
              results={passed}
              selectedTestId={selectedTestId}
              onSelectTest={onSelectTest}
            />
          )}
        </div>
      )}

      {results.length === 0 && (
        <p className="text-ink-faint text-[11.5px]">
          No results yet. They appear here as each test finishes.
        </p>
      )}
    </aside>
  );
}

function Group({
  label,
  tone,
  open,
  onToggle,
  results,
  selectedTestId,
  onSelectTest,
}: {
  label: string;
  tone: string;
  open: boolean;
  onToggle: () => void;
  results: EvidenceResult[];
  selectedTestId: string | null;
  onSelectTest: (testId: string) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'hover:bg-surface-1 flex w-full items-center rounded-md px-3 py-[7px] text-left text-[12.5px] transition-colors',
          tone,
        )}
      >
        <span className="flex-1 tabular-nums">{label}</span>
        <span className="text-ink-faint" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="mb-1 flex flex-col">
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              onClick={() => onSelectTest(result.test.id)}
              aria-current={result.test.id === selectedTestId ? 'true' : undefined}
              className={cn(
                'truncate rounded-md px-3 py-1 text-left text-[12px] transition-colors',
                result.test.id === selectedTestId
                  ? 'text-ink bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                  : 'text-ink-faint hover:text-ink',
              )}
            >
              {result.test.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
