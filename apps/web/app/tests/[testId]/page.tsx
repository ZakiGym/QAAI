'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../../lib/api';
import { StatusDot, duration, relativeTime } from '../../../components/ui';
import { BisectPanel } from '../../../components/BisectPanel';
import { DomDiff } from '../../../components/DomDiff';
import { EmptyState } from '../../../components/ui/EmptyState';
import {
  Badge,
  Card,
  Page,
  PageHeader,
  SectionLabel,
  SkeletonRows,
} from '../../../components/ui/layout';
import { cn } from '../../../lib/cn';

/**
 * The test detail page — one test's whole story.
 *
 * A test has only ever been visible inside a single run, which answers "did it
 * pass this time" and nothing else. The two questions that actually decide what
 * to do about an unreliable test — has it always been like this, and when did it
 * change — needed a person to open run after run and remember what they saw.
 *
 * The run-history strip is the point of the screen. A flaky test and a test that
 * broke on Tuesday have identical flake rates and completely different shapes,
 * and the shape is legible in about a second.
 */

interface TestDetail {
  id: string;
  projectId: string;
  name: string;
  filePath: string;
  type: string;
  priority: string;
  tags: string[];
  quarantined: boolean;
  quarantinedAt: string | null;
  quarantineReason: string | null;
  flakeRate: number;
  consecutiveFailures: number;
  lastRunAt: string | null;
  reviewFlags: string[];
}

interface HistoryResult {
  id: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'FLAKY' | 'TIMED_OUT';
  durationMs: number;
  errorMessage: string | null;
  retriedAndPassed: boolean;
  createdAt: string;
  run: {
    id: string;
    queuedAt: string;
    trigger: string;
    branch: string | null;
    commitSha: string | null;
    environment: { name: string; kind: string };
  };
}

interface HistoryWindow {
  limit: number;
  total: number;
  returned: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Percent, like Test.flakeRate. Null when nothing in the window actually ran. */
  passRate: number | null;
  streak: { outcome: 'pass' | 'fail'; count: number } | null;
}

interface History {
  test: TestDetail;
  results: HistoryResult[];
  window: HistoryWindow;
}

type Mark = 'pass' | 'fail' | 'flake' | 'skip';

/**
 * A retry that passes is not a pass (§5), so it gets the flake colour rather
 * than the green it technically earned. Amber next to green is the difference
 * between "this suite is fine" and "this suite is lying to you", and the strip
 * is the one place that is visible without reading a single number.
 */
function markOf(result: HistoryResult): Mark {
  if (result.status === 'SKIPPED') return 'skip';
  if (result.status === 'FLAKY' || result.retriedAndPassed) return 'flake';
  if (result.status === 'PASSED') return 'pass';
  return 'fail';
}

const MARK_TONE: Record<Mark, string> = {
  pass: 'bg-pass',
  fail: 'bg-fail',
  flake: 'bg-flake',
  skip: 'bg-skip/50',
};

const MARK_LABEL: Record<Mark, string> = {
  pass: 'passed',
  fail: 'failed',
  flake: 'flaked',
  skip: 'did not run',
};

/** The one number on the page, so it should not be a flattering one. */
function passRateTone(rate: number): string {
  if (rate >= 95) return 'text-pass';
  if (rate >= 80) return 'text-flake';
  return 'text-fail';
}

export default function TestDetailPage({ params }: { params: Promise<{ testId: string }> }) {
  const { testId } = use(params);
  const router = useRouter();

  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Without this the empty state renders during the first fetch, telling someone
  // their test has never run before we have any idea whether it has.
  const [loading, setLoading] = useState(true);
  /**
   * Which failure has its DOM diff open. One at a time, by result id: two open
   * diffs of the same page are two ~100-row lists you have to scroll past each
   * other to compare, and the comparison is against the green run anyway.
   */
  const [openDiff, setOpenDiff] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHistory(await api<History>(`/tests/${testId}/history?limit=50`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load this test');
    } finally {
      setLoading(false);
    }
  }, [testId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Page width="wide">
        <PageHeader title="Test history" subtitle="Loading…" />
        <Card className="overflow-hidden">
          <SkeletonRows rows={6} />
        </Card>
      </Page>
    );
  }

  if (error || !history) {
    return (
      <Page width="wide">
        <PageHeader title="Test history" />
        <p
          role="alert"
          className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm"
        >
          {error ?? 'Could not load this test'}
        </p>
        <Link href="/quality" className="text-accent mt-4 inline-block text-sm hover:underline">
          Back to quality
        </Link>
      </Page>
    );
  }

  const { test, results, window: stats } = history;
  // Oldest first: left-to-right has to mean time moving forward, or a run of
  // failures reads as a run of failures in the wrong direction.
  const strip = [...results].reverse();
  const latest = results[0];
  const failures = results
    .filter((r) => markOf(r) === 'fail' || markOf(r) === 'flake')
    .slice(0, 12);

  return (
    <Page width="wide">
      <PageHeader
        title={test.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <code className="font-mono">{test.filePath}</code>
            <span className="text-ink-faint">·</span>
            <Badge mono>{test.type.toLowerCase()}</Badge>
            <Badge mono>{test.priority.toLowerCase().replace(/_/g, ' ')}</Badge>
            {test.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </span>
        }
        actions={
          latest && (
            <Link
              href={`/runs/${latest.run.id}`}
              className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-body-sm rounded-md border px-3.5 py-2"
            >
              Latest run →
            </Link>
          )
        }
      />

      {test.quarantined && (
        <Card className="border-flake/40 bg-flake/5 mb-6 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="flake">quarantined</Badge>
            {test.quarantinedAt && (
              <span className="text-ink-faint text-micro tabular-nums">
                {relativeTime(test.quarantinedAt)}
              </span>
            )}
          </div>
          <p className="text-ink-dim text-body-sm mt-2 leading-relaxed">
            {test.quarantineReason ?? 'This test was quarantined by hand — no reason was recorded.'}{' '}
            It still runs on every run; it just stops gating a deploy.
          </p>
        </Card>
      )}

      {test.reviewFlags.length > 0 && (
        <Card className="mb-6 p-4">
          <SectionLabel>Needs review</SectionLabel>
          <p className="text-ink-dim text-body-sm leading-relaxed">
            The generator was unsure about{' '}
            <span className="tabular-nums">{test.reviewFlags.length}</span>{' '}
            {test.reviewFlags.length === 1 ? 'selector' : 'selectors'} here. Unsure selectors are
            the usual root cause of a test that flakes without the app changing.
          </p>
          <ul className="mt-2.5 flex flex-wrap gap-1.5">
            {test.reviewFlags.map((flag) => (
              <li key={flag}>
                <Badge mono tone="flake">
                  {flag}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── The numbers ─────────────────────────────────────────────────────── */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <SectionLabel>Pass rate</SectionLabel>
          <p
            className={`text-3xl font-semibold tabular-nums ${
              stats.passRate === null ? 'text-ink-faint' : passRateTone(stats.passRate)
            }`}
          >
            {stats.passRate === null ? '—' : `${stats.passRate.toFixed(0)}%`}
          </p>
          <p className="text-ink-faint text-micro mt-1.5 tabular-nums">
            {stats.passed} of {stats.passed + stats.failed} runs · last{' '}
            {Math.min(stats.returned, stats.total)} of {stats.total}
          </p>
        </Card>

        <Card className="p-4">
          <SectionLabel>Flake rate</SectionLabel>
          <p
            className={`text-3xl font-semibold tabular-nums ${
              test.flakeRate > 20 ? 'text-fail' : test.flakeRate > 5 ? 'text-flake' : 'text-ink'
            }`}
          >
            {test.flakeRate.toFixed(0)}%
          </p>
          <p className="text-ink-faint text-micro mt-1.5">
            Share of recent runs that were unstable
          </p>
        </Card>

        <Card className="p-4">
          <SectionLabel>Current streak</SectionLabel>
          <p
            className={`text-3xl font-semibold tabular-nums ${
              stats.streak === null
                ? 'text-ink-faint'
                : stats.streak.outcome === 'pass'
                  ? 'text-pass'
                  : 'text-fail'
            }`}
          >
            {stats.streak === null ? '—' : stats.streak.count}
          </p>
          <p className="text-ink-faint text-micro mt-1.5">
            {stats.streak === null
              ? 'Has not run yet'
              : `${stats.streak.outcome === 'pass' ? 'passes' : 'failures'} in a row${
                  test.lastRunAt ? ` · last run ${relativeTime(test.lastRunAt)}` : ''
                }`}
          </p>
        </Card>
      </div>

      {/* ── The strip ───────────────────────────────────────────────────────── */}
      <Card className="mb-6 p-4">
        {/* SectionLabel owns its own bottom margin, so the caption matches it
            rather than the row adding a second one. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <SectionLabel>Run history</SectionLabel>
          <span className="text-ink-faint text-meta mb-3">oldest → newest</span>
        </div>

        {strip.length === 0 ? (
          <EmptyState
            title="This test has never run"
            body="It was generated or imported but no run has included it yet. Start a run and its history begins here."
            action={{ label: 'Go to runs', href: '/runs' }}
          />
        ) : (
          <>
            <ol className="flex flex-wrap items-end gap-1">
              {strip.map((result) => {
                const mark = markOf(result);
                return (
                  <li key={result.id}>
                    <Link
                      href={`/runs/${result.run.id}`}
                      // The tooltip carries what a mark cannot: which run, when,
                      // and where. Without it the strip is a pretty shape you
                      // cannot act on.
                      title={`${MARK_LABEL[mark]} · ${relativeTime(result.run.queuedAt)} · ${
                        result.run.environment.name
                      } · ${duration(result.durationMs)}`}
                      className={`block h-7 w-2 rounded-sm transition-transform hover:scale-y-110 ${MARK_TONE[mark]}`}
                    >
                      <span className="sr-only">
                        {MARK_LABEL[mark]} {relativeTime(result.run.queuedAt)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>

            <div className="text-ink-faint text-meta mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {(['pass', 'fail', 'flake', 'skip'] as const).map((mark) => (
                <span key={mark} className="flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-1.5 rounded-sm ${MARK_TONE[mark]}`} />
                  {MARK_LABEL[mark]}
                </span>
              ))}
              <span className="ml-auto tabular-nums">
                {strip.length} of {stats.total} runs
              </span>
            </div>
          </>
        )}
      </Card>

      {/* ── When did this start failing? ────────────────────────────────────── */}
      {/*
        Directly under the strip, because the strip is what makes someone ask.
        A shape that goes green-green-green-red-red is the question "what
        happened on Tuesday" in visual form, and the answer used to require
        opening every run in it by hand.
      */}
      {/* `undefined`, not `false`, when there is no streak at all: a test that
          has never run is not "currently passing", and telling someone a bisect
          will find nothing is a different claim from having no idea. */}
      <BisectPanel
        testId={test.id}
        currentlyRed={stats.streak ? stats.streak.outcome === 'fail' : undefined}
      />

      {/* ── The failures ────────────────────────────────────────────────────── */}
      <section>
        <SectionLabel>Recent failures</SectionLabel>
        <Card className="divide-line divide-y overflow-hidden">
          {failures.length === 0 ? (
            <EmptyState
              title={strip.length === 0 ? 'Nothing to show yet' : 'No failures in this window'}
              body={
                strip.length === 0
                  ? 'Failures land here with their error message and a link into the run that produced them.'
                  : `This test has passed every run in the last ${strip.length}. Nothing here needs your attention.`
              }
            />
          ) : (
            failures.map((result) => (
              <FailureRow
                key={result.id}
                result={result}
                open={openDiff === result.id}
                onToggle={() => setOpenDiff((current) => (current === result.id ? null : result.id))}
              />
            ))
          )}
        </Card>
      </section>
    </Page>
  );
}

/**
 * One failure, with "what changed since it last passed" attached to it.
 *
 * DomDiff existed and was reachable from nowhere. This is where the question
 * gets asked — you are looking at the failure, and the next thing you want is
 * the DOM it failed against versus the DOM from the last green run — so it
 * opens in place rather than on another screen.
 *
 * The row is a disclosure and the run link is its sibling, not its parent. It
 * was one big `<Link>`; putting a button inside that would have nested an
 * interactive element in an anchor, which is invalid and breaks keyboard
 * activation on both.
 */
function FailureRow({
  result,
  open,
  onToggle,
}: {
  result: HistoryResult;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={cn('px-4 py-3.5 transition-colors', open && 'bg-surface-2/50')}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="group min-w-0 flex-1 cursor-pointer text-left"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StatusDot status={result.status} />
            <Badge mono>{result.run.id.slice(-8)}</Badge>
            <span className="text-ink-dim text-body-sm">
              {result.run.environment.name}
              <span className="text-ink-faint"> · {result.run.trigger.toLowerCase()}</span>
            </span>
            {result.run.branch && <Badge mono>{result.run.branch}</Badge>}
            {result.retriedAndPassed && <Badge tone="flake">passed on retry</Badge>}
            <span className="text-ink-faint text-micro ml-auto flex items-center gap-3 tabular-nums">
              <span>{duration(result.durationMs)}</span>
              <span className="w-16 text-right">{relativeTime(result.run.queuedAt)}</span>
            </span>
          </div>
          {result.errorMessage && (
            // Truncated to two lines: a stack trace is the whole reason people
            // bounce off failure lists, and the run itself is one click away
            // for the full thing.
            <p className="text-ink-dim text-micro mt-2 line-clamp-2 font-mono break-words whitespace-pre-wrap">
              {result.errorMessage}
            </p>
          )}
          <span
            className={cn(
              'text-micro mt-2 inline-flex items-center gap-1 underline decoration-dotted underline-offset-2',
              open ? 'text-accent' : 'text-ink-faint group-hover:text-accent',
            )}
          >
            {open ? 'Hide' : 'What changed since it last passed?'}
          </span>
        </button>
        <Link
          href={`/runs/${result.run.id}`}
          className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-micro shrink-0 rounded-md border px-2.5 py-1.5"
        >
          Run →
        </Link>
      </div>

      {/*
       * Mounted only when open. DomDiff reads two Playwright traces out of
       * storage on the server; twelve of them fetching on page load would cost
       * more than the whole rest of the screen.
       */}
      {open && <DomDiff resultId={result.id} />}
    </div>
  );
}
