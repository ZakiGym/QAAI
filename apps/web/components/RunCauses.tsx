'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type ClusterReport, type FailureCluster, type UnclusteredFailure } from '../lib/api';
import { Badge } from './ui/layout';

/**
 * "How many things actually broke?" — the failure clusters, on the cockpit.
 *
 * GET /clusters/run/:runId has been mounted and answering since failure
 * clustering shipped, and no screen in this app had ever called it. The cockpit
 * lists failures one per row, which is the right shape for three and the wrong
 * one for forty: a person on a red build wants the number of CAUSES, and then
 * wants to look at one representative of each.
 *
 * Two rules the design follows, because both are ways this could lie:
 *
 *   · A cluster of one is not a cluster. The endpoint says so itself by putting
 *     it in `unclustered`, and this strip keeps that distinction visible — a
 *     one-off cause is drawn without a count badge and reads as one failure,
 *     never as a group of one.
 *   · `summary.failures` counts what was CLUSTERABLE. A result with no error
 *     text at all cannot be grouped, so when it is lower than the run's own
 *     failure count that difference is said out loud rather than quietly
 *     shrinking the total.
 */

interface Cause {
  id: string;
  label: string;
  count: number;
  sample: string;
  /** Present only for a real cluster — a single failure gets no recommendation. */
  suggested: FailureCluster['suggested'] | null;
  members: Array<{ testId: string; testResultId: string; testName: string }>;
  facets: FailureCluster['facets'];
}

function toCause(entry: FailureCluster | UnclusteredFailure): Cause {
  if ('members' in entry) {
    return {
      id: entry.id,
      label: entry.label,
      count: entry.count,
      sample: entry.sample,
      suggested: entry.suggested,
      members: entry.members.map((m) => ({
        testId: m.testId,
        testResultId: m.testResultId,
        testName: m.testName,
      })),
      facets: entry.facets,
    };
  }
  return {
    id: entry.id,
    label: entry.label,
    count: 1,
    sample: entry.sample,
    suggested: null,
    members: [
      {
        testId: entry.member.testId,
        testResultId: entry.member.testResultId,
        testName: entry.member.testName,
      },
    ],
    facets: entry.facets,
  };
}

export interface RunCausesProps {
  runId: string;
  /**
   * How many results in this run are failing, as the cockpit already counted
   * them. Used only to decide whether to ask at all and to reconcile the two
   * totals — never to render a number the endpoint did not agree with.
   */
  failingResults: number;
  /** Select this test in the cockpit — the whole reason a cause is clickable. */
  onSelectTest: (testId: string) => void;
  selectedTestId: string | null;
}

export function RunCauses({
  runId,
  failingResults,
  onSelectTest,
  selectedTestId,
}: RunCausesProps) {
  const [report, setReport] = useState<ClusterReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (failingResults === 0) return;
    let cancelled = false;
    api<ClusterReport>(`/clusters/run/${runId}`)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch(() => {
        // Clustering is derived from results the cockpit is already showing, so
        // losing it costs a summary and nothing else. It fails quietly rather
        // than putting an error banner above a screen that still works.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, failingResults]);

  // Nothing failed, the request died, or the run had no clusterable failures at
  // all — in every case there is no claim worth making.
  if (failingResults === 0 || failed || !report) return null;

  const causes = [...report.clusters.map(toCause), ...report.unclustered.map(toCause)].sort(
    (a, b) => b.count - a.count,
  );
  if (causes.length === 0) return null;

  const grouped = report.summary.clusters > 0;
  /*
   * The gap between "results that failed" and "failures we could read". A
   * result whose error text is empty is invisible to the clusterer, and a strip
   * that says "2 causes" above a list of three red tests is the kind of number
   * nobody can reconcile.
   */
  const unread = Math.max(0, failingResults - report.summary.failures);

  return (
    <section
      aria-label="What broke"
      className="border-line bg-surface-1/40 shrink-0 border-b px-5 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-ink-dim shrink-0 text-xs">
          <span className="tabular-nums">{report.summary.failures}</span>{' '}
          {report.summary.failures === 1 ? 'failure' : 'failures'} ·{' '}
          <span className="text-ink font-medium tabular-nums">{causes.length}</span>{' '}
          {causes.length === 1 ? 'cause' : 'distinct causes'}
          {grouped && (
            <span className="text-ink-faint">
              {' · biggest group '}
              <span className="tabular-nums">{report.summary.largestCluster}</span>
            </span>
          )}
          {unread > 0 && (
            /* Said out loud: these results are red and carried no error text, so
               nothing here describes them. */
            <span className="text-flake">
              {' · '}
              <span className="tabular-nums">{unread}</span> with no error text to read
            </span>
          )}
        </p>

        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {causes.map((cause) => {
            const open = openId === cause.id;
            const holdsSelection = cause.members.some((m) => m.testId === selectedTestId);
            return (
              <li key={cause.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    setOpenId(open ? null : cause.id);
                    // Jump straight to a representative. Naming a cause without
                    // being able to look at one of its failures would be a
                    // label, not a tool.
                    const first = cause.members[0];
                    if (first) onSelectTest(first.testId);
                  }}
                  aria-expanded={open}
                  title={cause.sample}
                  className={`flex max-w-full items-center gap-2 rounded-md border px-2.5 py-1 text-left text-xs transition-colors ${
                    holdsSelection
                      ? 'border-accent bg-surface-2 text-ink'
                      : 'border-line text-ink-dim hover:text-ink hover:border-line-strong'
                  }`}
                >
                  {cause.count > 1 && (
                    <span className="text-fail shrink-0 font-mono text-micro tabular-nums">
                      ×{cause.count}
                    </span>
                  )}
                  <span className="truncate">{cause.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* The expanded cause: its members, and the untouched error text the
          grouping was made from — without the sample, "these four are the same
          bug" is an assertion you cannot check. */}
      {causes.map((cause) =>
        openId === cause.id ? (
          <div key={cause.id} className="border-line mt-2.5 rounded-md border p-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm">{cause.label}</span>
              {cause.facets.httpStatus !== null && (
                <Badge mono tone="fail">
                  HTTP {cause.facets.httpStatus}
                </Badge>
              )}
              {cause.facets.assertion && <Badge mono>{cause.facets.assertion}</Badge>}
              {cause.facets.call && <Badge mono>{cause.facets.call}</Badge>}
              {cause.suggested && (
                /* A recommendation, labelled as one, with where it came from.
                   Accepting it is still a human action on /triage. */
                <span className="text-ink-faint text-micro">
                  suggests {cause.suggested.verdict.toLowerCase().replace(/_/g, ' ')} —{' '}
                  {cause.suggested.reason}
                </span>
              )}
            </div>

            <ul className="mt-2 flex flex-wrap gap-1.5">
              {cause.members.map((member) => (
                <li key={member.testResultId} className="flex items-center">
                  <button
                    type="button"
                    onClick={() => onSelectTest(member.testId)}
                    className={`border-line rounded-l-md border py-0.5 pr-2 pl-2 text-xs ${
                      member.testId === selectedTestId
                        ? 'bg-surface-2 text-ink'
                        : 'text-ink-dim hover:text-ink'
                    }`}
                  >
                    {member.testName}
                  </button>
                  {/* The other question a named cause raises: has this test
                      always done this? That is its history, not this run. */}
                  <Link
                    href={`/tests/${member.testId}`}
                    title="This test's history"
                    className="border-line text-ink-faint hover:text-accent rounded-r-md border border-l-0 px-1.5 py-0.5 font-mono text-micro"
                  >
                    ↗
                  </Link>
                </li>
              ))}
            </ul>

            <pre className="border-line bg-surface-2/50 text-ink-dim mt-2.5 max-h-32 overflow-auto rounded-md border p-2 font-mono text-micro whitespace-pre-wrap">
              {cause.sample}
            </pre>
          </div>
        ) : null,
      )}
    </section>
  );
}
