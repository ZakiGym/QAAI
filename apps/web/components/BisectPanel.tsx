'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  api,
  ApiError,
  type BisectCommitVerdict,
  type BisectFlakeEvidence,
  type BisectProbeRun,
  type BisectReport,
  type BisectStart,
  type BisectView,
} from '../lib/api';
import { relativeTime } from './ui';
import { Button } from './ui/Button';
import { Badge, Card, SectionLabel, Skeleton } from './ui/layout';
import { useToast } from './ui/Toast';
import { cn } from '../lib/cn';

/**
 * "When did this start failing?"
 *
 * The question is asked in front of the run-history strip — that is what the
 * strip is FOR — and until now the only way to answer it was to open run after
 * run and remember what you saw. POST /bisect does the search; this panel is
 * the place to press it and the place the answer lands.
 *
 * ── The two things this must never do ───────────────────────────────────────
 *
 * It must never present a suspicion as a conclusion. A bisect names a commit,
 * and a named commit gets a person's name attached to it in the next standup,
 * so the workings sit ON the answer rather than behind a disclosure: which
 * commits were green, which were red, how many probes ran, how many of them
 * disagreed with themselves, and every caveat the API computed. `ANSWERED` is
 * rendered as a *judgement with evidence*, never as a fact.
 *
 * And when the API REFUSES — most importantly because the test is too flaky to
 * bisect — that refusal is the feature working, not a failure. It renders as an
 * explanation with the measured flake rate next to it. There is no error toast
 * on that path, because a toast says "something went wrong" and nothing did:
 * the search declined to name an innocent commit, which is the whole point.
 *
 * ── Why the id is remembered ────────────────────────────────────────────────
 * A bisect that needs probes takes as long as the runs take. The API keeps its
 * state in audit rows precisely so the answer survives the week, so the panel
 * stores the last investigation id per test and re-attaches on the next visit —
 * otherwise the durable record would be unreachable from the one screen that
 * asks the question.
 */

// ─── Remembering the last investigation ──────────────────────────────────────

const STORAGE_PREFIX = 'qaai.bisect.';

function recall(testId: string): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + testId);
  } catch {
    // Private browsing, or storage disabled. Losing the handle is a smaller
    // problem than a panel that throws on mount.
    return null;
  }
}

function remember(testId: string, bisectId: string | null): void {
  try {
    if (bisectId) window.localStorage.setItem(STORAGE_PREFIX + testId, bisectId);
    else window.localStorage.removeItem(STORAGE_PREFIX + testId);
  } catch {
    /* see recall() */
  }
}

// ─── Polling ─────────────────────────────────────────────────────────────────

/**
 * Most bisects are a database query and are done before the first poll; the
 * ones that are not are waiting on real browser runs and take minutes. So: a
 * tight interval at first, then a slow one, and never a fixed number of
 * requests per second for forty-five minutes.
 *
 * A transient failure keeps polling and keeps the last view on screen. A report
 * that blanks itself because one request timed out is worse than a stale one,
 * and 404 is the only response that means "this id is not a thing".
 */
const FAST_POLL_MS = 1500;
const SLOW_POLL_MS = 5000;
const FAST_POLLS = 20;
const MAX_POLLS = 600;

export interface BisectPoll {
  view: BisectView | null;
  /** A transport-level failure. Never a REFUSED report — that is a result. */
  error: string | null;
  loading: boolean;
  /** The id 404s: the investigation aged out of the audit window, or never was. */
  gone: boolean;
  refresh: () => void;
}

export function useBisectPoll(bisectId: string | null): BisectPoll {
  const [view, setView] = useState<BisectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [gone, setGone] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!bisectId) {
      setView(null);
      setError(null);
      setGone(false);
      setLoading(false);
      return;
    }

    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;

    setLoading(true);
    setGone(false);

    const tick = async () => {
      try {
        const next = await api<BisectView>(`/bisect/${encodeURIComponent(bisectId)}`);
        if (dead) return;
        setView(next);
        setError(null);
        setLoading(false);
        if (next.state === 'DONE') return;
        polls += 1;
        if (polls < MAX_POLLS) {
          timer = setTimeout(tick, polls > FAST_POLLS ? SLOW_POLL_MS : FAST_POLL_MS);
        }
      } catch (err) {
        if (dead) return;
        setLoading(false);
        if (err instanceof ApiError && err.status === 404) {
          setGone(true);
          setView(null);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not read this bisect');
        polls += 1;
        if (polls < MAX_POLLS) timer = setTimeout(tick, SLOW_POLL_MS);
      }
    };

    void tick();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
  }, [bisectId, nonce]);

  return { view, error, loading, gone, refresh };
}

// ─── Presentation ────────────────────────────────────────────────────────────

/**
 * The API's own prose uses twelve characters, so the screen does too. A commit
 * you cannot match to the sentence above it is a commit you have to re-derive.
 */
function sha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

const VERDICT_TONE: Record<BisectCommitVerdict, string> = {
  GREEN: 'bg-pass',
  RED: 'bg-fail',
  MIXED: 'bg-flake',
  UNUSABLE: 'bg-skip/50',
};

const VERDICT_TEXT: Record<BisectCommitVerdict, string> = {
  GREEN: 'text-pass',
  RED: 'text-fail',
  MIXED: 'text-flake',
  UNUSABLE: 'text-ink-faint',
};

const VERDICT_WORD: Record<BisectCommitVerdict, string> = {
  GREEN: 'passed',
  RED: 'failed',
  MIXED: 'both',
  UNUSABLE: 'no result',
};

const STATUS_TONE: Record<BisectReport['status'], 'fail' | 'flake' | 'accent' | 'neutral'> = {
  ANSWERED: 'accent',
  REFUSED: 'neutral',
  INCONCLUSIVE: 'flake',
  NEEDS_PROBES: 'flake',
};

/**
 * The headline for each outcome.
 *
 * "Not bisected" rather than "Failed" or "Error" — REFUSED is a decision the
 * search made on purpose, and the heading is the first thing that has to say so.
 */
const STATUS_HEADING: Record<BisectReport['status'], string> = {
  ANSWERED: 'Suspected commit',
  REFUSED: 'Not bisected',
  INCONCLUSIVE: 'Narrowed to a range',
  NEEDS_PROBES: 'Still planning',
};

const CONFIDENCE_NOTE: Record<'confirmed' | 'probable', string> = {
  confirmed:
    'Green on one side of the boundary and red on the other, the test measured stable, and nothing about the ordering was ambiguous.',
  probable:
    'The boundary holds, but something behind it is thinner than we would like — read the caveats.',
};

function Note({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'flake' }) {
  return (
    <p
      className={cn(
        'text-micro rounded-md border p-3 leading-relaxed',
        tone === 'flake'
          ? 'border-flake/40 bg-flake/10 text-ink-dim'
          : 'border-line text-ink-dim border-dashed',
      )}
    >
      {children}
    </p>
  );
}

/** A label above a value. Used for the boundary and the probe accounting. */
function Stat({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="text-ink-faint text-meta font-semibold tracking-wider uppercase">{label}</p>
      <div className="text-ink text-body-sm mt-1 min-w-0">{children}</div>
      {hint && <p className="text-ink-faint text-meta mt-1 leading-relaxed">{hint}</p>}
    </div>
  );
}

// ─── Stability, always stated ────────────────────────────────────────────────

/**
 * The measurement the refusal rests on, rendered as a fact rather than a
 * complaint.
 *
 * `measured: false` gets its own sentence, because "we did not measure this"
 * and "we measured zero" are opposite claims and a single greyed-out `0%` would
 * be read as the second one.
 */
function Stability({ flake }: { flake: BisectFlakeEvidence }) {
  if (!flake.measured) {
    return (
      <Stat
        label="Stability"
        hint={
          flake.repeatedCommits === 0
            ? 'No commit in the window was run twice, so this test never had the chance to disagree with itself.'
            : 'Too few commits were run more than once for this to be a measurement.'
        }
      >
        <span className="text-ink-dim">not measured</span>
        <span className="text-ink-faint text-micro ml-2 tabular-nums">
          {flake.repeatedCommits} repeated · {flake.usableSamples} usable samples
        </span>
      </Stat>
    );
  }

  return (
    <Stat
      label="Stability"
      hint={
        flake.disagreeingCommits === 0
          ? 'It never gave two different answers on identical code.'
          : 'A commit that gave both answers is direct evidence of non-determinism — the axis a bisect searches along.'
      }
    >
      <span
        className={cn(
          'font-semibold tabular-nums',
          flake.ratePercent === 0
            ? 'text-pass'
            : flake.ratePercent > 10
              ? 'text-fail'
              : 'text-flake',
        )}
      >
        {flake.ratePercent.toFixed(0)}%
      </span>
      <span className="text-ink-faint text-micro ml-2 tabular-nums">
        disagreed at {flake.disagreeingCommits} of {flake.repeatedCommits} repeated commits
      </span>
    </Stat>
  );
}

// ─── The commit timeline: the evidence, in full ──────────────────────────────

const TIMELINE_PREVIEW = 12;

function CommitStrip({ report }: { report: BisectReport }) {
  return (
    <ol className="flex flex-wrap items-end gap-1">
      {report.timeline.map((commit) => {
        const isSuspect = commit.commitSha === report.suspectCommit;
        const isLastGood = commit.commitSha === report.boundary.lastGreen;
        return (
          <li key={commit.commitSha} className="relative">
            <span
              title={`${sha(commit.commitSha)} — ${VERDICT_WORD[commit.verdict]} (${commit.passed} passed, ${commit.failed} failed${
                commit.discarded ? `, ${commit.discarded} discarded` : ''
              })${commit.probed ? ' · probed by this bisect' : ''}${
                commit.reordered ? ' · ran out of order' : ''
              }`}
              className={cn(
                'block h-7 w-2.5 rounded-sm',
                VERDICT_TONE[commit.verdict],
                (isSuspect || isLastGood) && 'ring-ink ring-offset-surface-1 ring-1 ring-offset-1',
              )}
            >
              <span className="sr-only">
                {sha(commit.commitSha)} {VERDICT_WORD[commit.verdict]}
                {isSuspect ? ' — suspected commit' : ''}
                {isLastGood ? ' — last known good' : ''}
              </span>
            </span>
            {commit.probed && (
              // A probe is a run this investigation paid for. It has to be
              // distinguishable from a result CI happened to already have,
              // because one of them cost CI time and the other did not.
              <span
                aria-hidden="true"
                className="bg-accent absolute -bottom-1.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function CommitTable({ report }: { report: BisectReport }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? report.timeline : report.timeline.slice(-TIMELINE_PREVIEW);
  const hidden = report.timeline.length - rows.length;

  return (
    <>
      <div className="border-line mt-3 overflow-x-auto rounded-md border">
        <table className="w-full min-w-[34rem] border-collapse">
          <thead>
            <tr className="border-line text-ink-faint text-meta border-b text-left">
              <th className="px-2.5 py-1.5 font-semibold tracking-wider uppercase">Commit</th>
              <th className="px-2.5 py-1.5 font-semibold tracking-wider uppercase">Verdict</th>
              <th className="px-2.5 py-1.5 font-semibold tracking-wider uppercase">Evidence</th>
              <th className="px-2.5 py-1.5 font-semibold tracking-wider uppercase">Runs</th>
            </tr>
          </thead>
          <tbody className="divide-line/60 divide-y">
            {rows.map((commit) => {
              const isSuspect = commit.commitSha === report.suspectCommit;
              const isLastGood = commit.commitSha === report.boundary.lastGreen;
              return (
                <tr key={commit.commitSha} className={cn(isSuspect && 'bg-fail/5')}>
                  <td className="px-2.5 py-1.5 align-top">
                    <span className="text-ink text-micro font-mono">{sha(commit.commitSha)}</span>
                    {isSuspect && (
                      <span className="text-fail text-meta ml-1.5 whitespace-nowrap">suspect</span>
                    )}
                    {isLastGood && (
                      <span className="text-pass text-meta ml-1.5 whitespace-nowrap">last good</span>
                    )}
                  </td>
                  <td className={cn('text-micro px-2.5 py-1.5 align-top', VERDICT_TEXT[commit.verdict])}>
                    {VERDICT_WORD[commit.verdict]}
                  </td>
                  <td className="text-ink-dim text-micro px-2.5 py-1.5 align-top tabular-nums">
                    <span className="text-pass">{commit.passed}</span>
                    <span className="text-ink-faint"> passed · </span>
                    <span className="text-fail">{commit.failed}</span>
                    <span className="text-ink-faint"> failed</span>
                    {commit.discarded > 0 && (
                      <span className="text-ink-faint"> · {commit.discarded} discarded</span>
                    )}
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {commit.probed && (
                        <span className="text-accent text-meta">probed by this bisect</span>
                      )}
                      {!commit.probeable && (
                        <span
                          className="text-ink-faint text-meta"
                          title="No run at this commit recorded a commit-pinned URL, so re-running it would measure whatever is deployed now."
                        >
                          cannot be re-run
                        </span>
                      )}
                      {commit.reordered && (
                        <span
                          className="text-flake text-meta"
                          title="Its runs interleave with a neighbour's, so its position on the timeline is inferred rather than observed."
                        >
                          ran out of order
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-2.5 py-1.5 align-top">
                    {commit.runIds.length === 0 ? (
                      <span className="text-ink-faint text-meta">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {commit.runIds.map((runId) => (
                          <Link
                            key={runId}
                            href={`/runs/${runId}`}
                            className="text-accent text-meta font-mono hover:underline"
                          >
                            {runId.slice(-6)}
                          </Link>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-ink-faint hover:text-accent text-micro mt-2 underline decoration-dotted underline-offset-2"
        >
          Show the <span className="tabular-nums">{hidden}</span> older commit
          {hidden === 1 ? '' : 's'} in the window
        </button>
      )}
    </>
  );
}

// ─── Probe runs ──────────────────────────────────────────────────────────────

function ProbeRuns({ runs }: { runs: BisectProbeRun[] }) {
  if (runs.length === 0) return null;
  return (
    <div className="mt-4">
      <SectionLabel>Probe runs</SectionLabel>
      <ul className="divide-line/60 border-line divide-y rounded-md border">
        {runs.map((run) => (
          <li key={run.runId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5">
            <Link
              href={`/runs/${run.runId}`}
              className="text-accent text-micro font-mono hover:underline"
            >
              {run.runId.slice(-8)}
            </Link>
            <span className="text-ink-dim text-micro font-mono">
              {run.commitSha ? sha(run.commitSha) : 'no commit'}
            </span>
            <span
              className={cn(
                'text-micro',
                run.result === 'PASSED' && !run.retriedAndPassed
                  ? 'text-pass'
                  : run.result
                    ? 'text-fail'
                    : 'text-ink-faint',
              )}
            >
              {run.result ? run.result.toLowerCase() : run.status.toLowerCase()}
            </span>
            {run.retriedAndPassed && <Badge tone="flake">passed on retry</Badge>}
            <span className="text-ink-faint text-meta ml-auto tabular-nums">
              {relativeTime(run.finishedAt ?? run.queuedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── The report ──────────────────────────────────────────────────────────────

/**
 * The concluded investigation. Shared by the panel and by /bisect/:id, because
 * a permalinked answer that reads differently from the one on the test page is
 * two answers.
 */
export function BisectReportView({
  report,
  probeRuns,
  requestedAt,
}: {
  report: BisectReport;
  probeRuns: BisectProbeRun[];
  requestedAt?: string | null;
}) {
  const answered = report.status === 'ANSWERED';
  const hasBoundary = Boolean(report.boundary.lastGreen || report.boundary.firstRed);

  return (
    <div>
      {/* ── The verdict ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[report.status]} mono>
          {report.status.toLowerCase().replace(/_/g, ' ')}
        </Badge>
        {answered && report.confidence !== 'none' && (
          <Badge
            tone={report.confidence === 'confirmed' ? 'pass' : 'flake'}
            className="cursor-help"
          >
            <span title={CONFIDENCE_NOTE[report.confidence]}>{report.confidence}</span>
          </Badge>
        )}
        <span className="text-ink-faint text-meta">
          {report.source === 'history'
            ? 'from recorded results — nothing was re-run'
            : `recorded results plus ${report.probes.runIds.length} probe run${
                report.probes.runIds.length === 1 ? '' : 's'
              }`}
        </span>
        {requestedAt && (
          <span className="text-ink-faint text-meta ml-auto tabular-nums">
            {relativeTime(requestedAt)}
          </span>
        )}
      </div>

      <p className="text-ink-faint text-meta mt-3 font-semibold tracking-wider uppercase">
        {STATUS_HEADING[report.status]}
      </p>

      {answered && report.suspectCommit ? (
        <>
          <p className="text-ink mt-1 font-mono text-xl break-all">{sha(report.suspectCommit)}</p>
          {/*
           * The disclaimer is attached to the commit itself, not tucked into a
           * footnote. Everything under it is the workings that produced it, and
           * the reader is meant to check them before they say a name out loud.
           */}
          <p className="text-ink-dim text-micro mt-1.5 leading-relaxed">
            A judgement from the evidence below, not a certainty. QAAI orders commits by when it
            first ran them, so this means <em>the first commit QAAI saw fail</em> — the change may
            sit in any commit between it and the last good one that nobody ran.
          </p>
        </>
      ) : (
        <p className="text-ink-dim text-body-sm mt-1">No commit is being named.</p>
      )}

      {/* The API's own paragraph. It carries the thresholds and the reasoning
          in prose, and rewriting it here would put a second voice on the same
          judgement. */}
      <p className="text-ink text-body-sm mt-3 leading-relaxed">{report.summary}</p>

      {/* ── How this was decided ────────────────────────────────────────────── */}
      <div className="border-line/60 mt-5 grid gap-4 border-t pt-4 sm:grid-cols-3">
        <Stability flake={report.flake} />

        <Stat
          label="Probes"
          hint={
            report.probes.used === 0
              ? 'The recorded results were enough — no browser started and no CI time was spent.'
              : `Each probe re-ran this test ${report.probes.repeats} time${
                  report.probes.repeats === 1 ? '' : 's'
                } at one commit.`
          }
        >
          <span className="tabular-nums">
            {report.probes.used}
            {report.probes.budget > 0 && (
              <span className="text-ink-faint"> of {report.probes.budget} budgeted</span>
            )}
          </span>
        </Stat>

        <Stat
          label="Ambiguous probes"
          hint={
            report.probes.ambiguous === 0
              ? 'No probe contradicted itself.'
              : 'That is the test moving under the search, not a commit boundary — it stops the search.'
          }
        >
          <span
            className={cn(
              'tabular-nums',
              report.probes.ambiguous > 0 ? 'text-flake font-semibold' : 'text-ink-dim',
            )}
          >
            {report.probes.ambiguous}
          </span>
        </Stat>
      </div>

      {/* ── The boundary ────────────────────────────────────────────────────── */}
      {hasBoundary && (
        <div className="border-line/60 mt-4 grid gap-4 border-t pt-4 sm:grid-cols-3">
          <Stat label="Last known good">
            {report.boundary.lastGreen ? (
              <span className="text-pass font-mono break-all">{sha(report.boundary.lastGreen)}</span>
            ) : (
              <span className="text-ink-faint">none in the window</span>
            )}
          </Stat>
          <Stat
            label="Unexplained between"
            hint={
              report.boundary.unknownBetween > 0
                ? 'Commits inside the range with no result for this test.'
                : report.boundary.lastGreen && report.boundary.firstRed
                  ? 'The green and the red commits are adjacent on QAAI’s timeline.'
                  : // Only one side of the boundary exists — a refusal over a
                    // flaky test stops before it finds a green, and claiming the
                    // two commits are "adjacent" when one of them is null is the
                    // panel inventing a boundary the report did not find.
                    'Only one side of the boundary was found, so there is no range.'
            }
          >
            <span className="tabular-nums">{report.boundary.unknownBetween}</span>
          </Stat>
          <Stat label="First seen red">
            {report.boundary.firstRed ? (
              <span className="text-fail font-mono break-all">{sha(report.boundary.firstRed)}</span>
            ) : (
              <span className="text-ink-faint">none in the window</span>
            )}
          </Stat>
        </div>
      )}

      {report.boundary.priorRegressions > 0 && (
        <p className="text-ink-faint text-micro mt-3 leading-relaxed">
          This test went red and green again{' '}
          <span className="tabular-nums">{report.boundary.priorRegressions}</span> other time
          {report.boundary.priorRegressions === 1 ? '' : 's'} in this window. Only the most recent
          regression is being explained.
        </p>
      )}

      {/* ── The commits it looked at ────────────────────────────────────────── */}
      {report.timeline.length > 0 ? (
        <div className="border-line/60 mt-5 border-t pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <SectionLabel>
              The <span className="tabular-nums">{report.timeline.length}</span> commits it looked at
            </SectionLabel>
            <span className="text-ink-faint text-meta mb-3">oldest → newest</span>
          </div>
          <CommitStrip report={report} />
          <div className="text-ink-faint text-meta mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {(['GREEN', 'RED', 'MIXED', 'UNUSABLE'] as const).map((verdict) => (
              <span key={verdict} className="flex items-center gap-1.5">
                <span className={cn('inline-block h-2 w-1.5 rounded-sm', VERDICT_TONE[verdict])} />
                {VERDICT_WORD[verdict]}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="bg-accent inline-block h-1 w-1 rounded-full" />
              probed by this bisect
            </span>
          </div>
          <CommitTable report={report} />
        </div>
      ) : (
        <div className="border-line/60 mt-5 border-t pt-4">
          <SectionLabel>The commits it looked at</SectionLabel>
          <Note>
            None. No run of this test in the window carried a commit sha, so there was no timeline to
            place results on — every count above is zero because there was nothing to count, not
            because everything passed.
          </Note>
        </div>
      )}

      <ProbeRuns runs={probeRuns} />

      {/* ── Caveats ─────────────────────────────────────────────────────────── */}
      {report.caveats.length > 0 && (
        <div className="border-line/60 mt-5 border-t pt-4">
          <SectionLabel>What this does not tell you</SectionLabel>
          <ul className="space-y-2">
            {report.caveats.map((caveat, index) => (
              <li key={index} className="text-ink-dim text-micro flex gap-2 leading-relaxed">
                <span className="text-ink-faint shrink-0" aria-hidden="true">
                  •
                </span>
                <span className="min-w-0">{caveat}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Progress ────────────────────────────────────────────────────────────────

const PHASE_COPY: Record<BisectView['progress']['phase'], string> = {
  'reading history':
    'Reading the results QAAI already has. If the answer is already in the timeline it will appear without anything being re-run.',
  probing:
    'History was too sparse, so this test is being re-run at intermediate commits. Each probe is a real run and takes as long as a run takes.',
  concluded: 'Done.',
};

export function BisectProgressView({ view }: { view: BisectView }) {
  const { progress } = view;
  const budget = progress.probeBudget;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="bg-accent h-2 w-2 shrink-0 animate-pulse rounded-full"
          aria-hidden="true"
        />
        <span className="text-ink text-body-sm">{progress.phase}</span>
        {view.requestedAt && (
          <span className="text-ink-faint text-meta ml-auto tabular-nums">
            started {relativeTime(view.requestedAt)}
          </span>
        )}
      </div>

      <p className="text-ink-dim text-micro mt-2 leading-relaxed">{PHASE_COPY[progress.phase]}</p>

      {/*
       * The counters appear only once a plan exists. Rendering "0 of 0 probes"
       * during the history read would claim a search had started and found
       * nothing, which is the opposite of what is happening.
       */}
      {budget !== null && (
        <dl className="border-line/60 mt-3 grid grid-cols-3 gap-3 border-t pt-3">
          <div>
            <dt className="text-ink-faint text-meta font-semibold tracking-wider uppercase">
              Probes
            </dt>
            <dd className="text-ink text-body-sm tabular-nums">
              {progress.probesDone} <span className="text-ink-faint">of {budget}</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-faint text-meta font-semibold tracking-wider uppercase">
              Runs finished
            </dt>
            <dd className="text-ink text-body-sm tabular-nums">
              {progress.runsFinished} <span className="text-ink-faint">of {progress.runsQueued}</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-faint text-meta font-semibold tracking-wider uppercase">
              Runs per probe
            </dt>
            <dd className="text-ink text-body-sm tabular-nums">{progress.probeRepeats ?? '—'}</dd>
          </div>
        </dl>
      )}

      <ProbeRuns runs={view.probeRuns} />
    </div>
  );
}

// ─── The panel ───────────────────────────────────────────────────────────────

export function BisectPanel({
  testId,
  /** From the history window the page already loaded. Only used to set expectations. */
  currentlyRed,
}: {
  testId: string;
  currentlyRed?: boolean;
}) {
  const toast = useToast();
  const [bisectId, setBisectId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** True when the id came from storage rather than from a press just now. */
  const [restored, setRestored] = useState(false);

  // Re-attach to the last investigation for THIS test. Keyed on testId so
  // navigating between two tests never shows one test's answer under the other.
  useEffect(() => {
    const stored = recall(testId);
    setBisectId(stored);
    setRestored(Boolean(stored));
    setStarting(false);
  }, [testId]);

  const { view, error, loading, gone, refresh } = useBisectPoll(bisectId);

  // An id the API no longer knows is a dead handle, not an error worth showing.
  useEffect(() => {
    if (!gone || !bisectId) return;
    remember(testId, null);
    setBisectId(null);
    setRestored(false);
  }, [gone, bisectId, testId]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const started = await api<BisectStart>('/bisect', {
        method: 'POST',
        body: JSON.stringify({ testId }),
      });
      remember(testId, started.id);
      setBisectId(started.id);
      setRestored(false);
      if (started.reused) {
        toast.toast('info', 'A bisect for this test was already running — showing that one.');
      }
    } catch (err) {
      // This one IS an error: the request did not reach a verdict. A refusal
      // never lands here, it lands in the report.
      toast.error(
        err instanceof ApiError && err.status === 403
          ? 'Starting a bisect needs at least the Member role.'
          : err instanceof Error
            ? err.message
            : 'Could not start a bisect',
      );
    } finally {
      setStarting(false);
    }
  }, [testId, toast]);

  const running = view !== null && view.state !== 'DONE';
  const report = view?.result ?? null;

  return (
    <Card className="mb-6 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <SectionLabel>When did this start failing?</SectionLabel>
        <div className="mb-3 flex items-center gap-2">
          {bisectId && (
            <Link
              href={`/bisect/${bisectId}`}
              className="text-ink-faint hover:text-accent text-micro underline decoration-dotted underline-offset-2"
            >
              Permalink
            </Link>
          )}
          {bisectId && !running && (
            <Button size="sm" variant="ghost" onClick={start} loading={starting}>
              Bisect again
            </Button>
          )}
        </div>
      </div>

      {/* ── Nothing started ─────────────────────────────────────────────────── */}
      {!bisectId && !loading && (
        <div>
          <p className="text-ink-dim text-body-sm leading-relaxed">
            Bisect reads the results QAAI already has and looks for the commit where this test
            turned red. If the timeline already contains the answer, nothing is re-run. It only
            spends CI time when history is too sparse — and then only at commits that had their own
            deploy URL, because re-running an old commit against the shared environment would measure
            today’s deploy and label it with yesterday’s sha.
          </p>
          {currentlyRed === false && (
            <p className="text-ink-faint text-micro mt-2 leading-relaxed">
              This test is passing in its recent history, so a bisect will most likely report there
              is nothing to find.
            </p>
          )}
          <div className="mt-4">
            <Button variant="primary" onClick={start} loading={starting}>
              Find the commit that broke this
            </Button>
          </div>
        </div>
      )}

      {/* ── First read of a restored id ─────────────────────────────────────── */}
      {bisectId && loading && !view && (
        <div className="space-y-2" role="status" aria-label="Loading bisect">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {/*
       * A transport failure. Shown inline and non-destructively — the last
       * report, if there is one, stays on screen underneath.
       */}
      {error && (
        <div className="mb-3">
          <Note>
            {error}{' '}
            <button
              type="button"
              onClick={refresh}
              className="text-accent underline decoration-dotted underline-offset-2"
            >
              Try again
            </button>
          </Note>
        </div>
      )}

      {view && restored && !running && (
        <p className="text-ink-faint text-meta mb-3">
          The last bisect you ran on this test.
        </p>
      )}

      {view && running && <BisectProgressView view={view} />}

      {report && (
        <BisectReportView
          report={report}
          probeRuns={view?.probeRuns ?? []}
          requestedAt={view?.requestedAt ?? null}
        />
      )}

      {/*
       * Concluded, but the report could not be read back. The audit row exists
       * (or GET would have 404'd), so this is a malformed blob rather than a
       * missing investigation, and saying so beats an empty card.
       */}
      {view && view.state === 'DONE' && !report && (
        <Note tone="flake">
          This bisect finished, but the record it wrote could not be read back as a report. The
          probe runs it created, if any, are listed above and are still the evidence.
        </Note>
      )}
    </Card>
  );
}
