'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type TestBehavior, type WeakAssertion } from '../../../lib/api';
import { StatusDot, duration, relativeTime } from '../../../components/ui';
import { BisectPanel } from '../../../components/BisectPanel';
import { usePaletteCommands } from '../../../components/shell/PaletteCommands';
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
  /**
   * What this test actually checks, from the suite-health analyser.
   *
   * GET /suite-health/:projectId/tests/:testId has existed since suite health
   * shipped and nothing called it — the project-wide report got a screen and
   * the per-test one got nothing. It belongs here because the question it
   * answers ("is this test any good?") is the one a bad pass rate raises, and
   * the answer is frequently "it asserts almost nothing".
   */
  const [behavior, setBehavior] = useState<TestBehavior | null>(null);

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

  // Second, and only once the project id is known — it comes back on the test,
  // not from the route. Failing quietly: this is an enrichment, and the history
  // above is the page.
  const projectId = history?.test.projectId ?? null;
  /*
   * ⌘K, on the test in front of you. Every one of these is gated on the thing
   * it needs existing: no "latest run" command until there is a run.
   */
  const latestRunId = history?.results[0]?.run.id ?? null;
  usePaletteCommands(
    'test-detail',
    () => {
      const items = [
        {
          id: 'test:editor',
          label: 'Open this test in the editor',
          detail: 'its code',
          group: 'This test',
          run: () => router.push(`/editor?test=${testId}`),
        },
      ];
      if (latestRunId) {
        items.push({
          id: 'test:latest-run',
          label: 'Open its latest run',
          detail: 'the cockpit',
          group: 'This test',
          run: () => router.push(`/runs/${latestRunId}`),
        });
      }
      return items;
    },
    [testId, latestRunId, router],
  );

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api<TestBehavior>(`/suite-health/${projectId}/tests/${testId}`)
      .then((data) => {
        if (!cancelled) setBehavior(data);
      })
      .catch(() => {
        if (!cancelled) setBehavior(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, testId]);

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
          <span className="flex items-center gap-2">
            {/*
              The code. This screen has always been able to tell you a test is
              unreliable and never been able to show you the test — the editor
              was reachable from /heals and from ⌘P and from nowhere that was
              actually looking at a specific test's failures.
            */}
            <Link
              href={`/editor?test=${test.id}`}
              className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-body-sm rounded-md border px-3.5 py-2"
              title="Open this test's code"
            >
              Open in editor
            </Link>
            {latest && (
              <Link
                href={`/runs/${latest.run.id}`}
                className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-body-sm rounded-md border px-3.5 py-2"
              >
                Latest run →
              </Link>
            )}
          </span>
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

      {/* ── What this test actually checks ──────────────────────────────────── */}
      {behavior && <BehaviorCard behavior={behavior} testId={test.id} />}

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

const WEAK_TONE: Record<WeakAssertion['severity'], 'fail' | 'flake' | 'neutral'> = {
  HIGH: 'fail',
  MEDIUM: 'flake',
  LOW: 'neutral',
};

/**
 * What this test actually checks — the per-test half of suite health.
 *
 * A pass rate says how often a test went green. It cannot say whether green
 * meant anything, and the two most common reasons it does not — the test
 * asserts only that an element exists, or a `try/catch` swallows the assertion
 * so it can never fail — are invisible from every other screen in this product.
 *
 * The weak-assertion list leads, because it is the finding. The assertion sites
 * follow with the real source line quoted, so the claim can be checked without
 * opening the file. `incomplete` is stated rather than swallowed: when the
 * parse gave up, an empty finding list means nothing at all and must not read
 * as a clean bill of health.
 */
function BehaviorCard({ behavior, testId }: { behavior: TestBehavior; testId: string }) {
  const { routes, actions, assertions, assertionSites } = behavior.behavior;
  const nothingRead =
    routes.length === 0 &&
    actions.length === 0 &&
    assertions.length === 0 &&
    assertionSites.length === 0;

  // Nothing was read and nothing was found — there is no claim to make, and a
  // card that says "0 weak assertions" about a file we could not parse would be
  // the most misleading thing on the page.
  if (nothingRead && behavior.weakAssertions.length === 0 && !behavior.incomplete) return null;

  return (
    <section className="mb-6">
      <SectionLabel>What this test checks</SectionLabel>
      <Card className="p-4">
        {behavior.incomplete && (
          <p className="border-flake/40 bg-flake/10 text-flake text-body-sm mb-4 rounded-md border p-2.5">
            {behavior.incompleteReason ??
              'This test could not be read in full, so nothing below is a complete account of it.'}{' '}
            An empty findings list here is not a clean bill of health.
          </p>
        )}

        {behavior.weakAssertions.length > 0 ? (
          <ul className="divide-line mb-4 divide-y">
            {behavior.weakAssertions.map((weak) => (
              <li key={`${weak.kind}-${weak.line ?? 0}`} className="py-3 first:pt-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={WEAK_TONE[weak.severity]} mono>
                    {weak.kind.toLowerCase().replace(/_/g, ' ')}
                  </Badge>
                  {weak.line !== null && (
                    <span className="text-ink-faint font-mono text-micro tabular-nums">
                      line {weak.line}
                    </span>
                  )}
                </div>
                <p className="text-ink-dim text-body-sm mt-1.5 leading-relaxed">{weak.why}</p>
                {weak.quote && (
                  <pre className="border-line bg-surface-2/50 text-ink-dim mt-2 overflow-x-auto rounded-md border p-2 font-mono text-micro whitespace-pre-wrap">
                    {weak.quote}
                  </pre>
                )}
                <p className="text-ink-faint text-micro mt-1.5">
                  Assert instead: {weak.assertInstead}{' '}
                  <Link href={`/editor?test=${testId}`} className="text-accent hover:underline">
                    Edit it →
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          !behavior.incomplete && (
            /*
             * Carefully NOT "this test is fine".
             *
             * The endpoint drops NO_NEGATIVE_PATH by construction — it is a
             * judgement about a whole feature and one test alone cannot support
             * it — so an empty list here is silence on that question, not a
             * clean answer to it. Saying otherwise would suppress a finding the
             * project report is holding right now.
             */
            <p className="text-ink-dim text-body-sm mb-4">
              Every assertion this test makes has something to fail on. Whether the feature it
              covers has an error path tested at all is a question about the whole suite —{' '}
              <Link href="/insights/health" className="text-accent hover:underline">
                the suite report answers it →
              </Link>
            </p>
          )
        )}

        {assertionSites.length > 0 && (
          <>
            <p className="text-ink-faint text-micro mb-2 font-semibold tracking-wider uppercase">
              Assertions ({assertionSites.length})
            </p>
            <ul className="border-line divide-line divide-y rounded-md border">
              {assertionSites.map((site) => (
                <li key={`${site.line}-${site.matcher}`} className="px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Badge mono>{site.matcher}</Badge>
                    <span className="text-ink-faint font-mono text-micro">{site.target}</span>
                    {site.volatile && (
                      // The reason is the useful half — "volatile" alone is a
                      // label, "asserts on a timestamp" is a thing to fix.
                      <Badge tone="flake">{site.volatileReason ?? 'volatile'}</Badge>
                    )}
                    {/* The worst finding in the whole analyser: an assertion
                        inside a try/catch cannot fail, so this test has been
                        green for reasons that have nothing to do with the app. */}
                    {site.swallowed && <Badge tone="fail">cannot fail — swallowed</Badge>}
                    <span className="text-ink-faint ml-auto font-mono text-micro tabular-nums">
                      line {site.line}
                    </span>
                  </div>
                  <pre className="text-ink-dim mt-1 overflow-x-auto font-mono text-micro whitespace-pre-wrap">
                    {site.quote}
                  </pre>
                </li>
              ))}
            </ul>
          </>
        )}

        {routes.length > 0 && (
          <p className="text-ink-faint text-micro mt-3">
            Reaches {routes.map((r) => r.replace(/^nav:/, '')).join(', ')}
            {' · '}
            <Link href="/insights/impact" className="hover:text-accent hover:underline">
              why it does or does not run on a diff →
            </Link>
          </p>
        )}
      </Card>
    </section>
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
