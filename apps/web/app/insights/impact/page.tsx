'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  ApiError,
  type ImpactAnalysis,
  type ImpactConfidence,
  type ImpactDecision,
  type ImpactSignals,
} from '../../../lib/api';
import { useProject } from '../../../components/shell/ProjectContext';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { useToast } from '../../../components/ui/Toast';
import {
  Badge,
  Card,
  Page,
  PageHeader,
  SectionLabel,
  SkeletonRows,
} from '../../../components/ui/layout';
import { InsightsTabs } from '../page';

/**
 * Impact analysis — "which of my tests does this change actually need?"
 *
 * POST /impact/analyze and GET /impact/signals shipped fully built, fully
 * tested, mounted, and reachable only with curl: the route's own doc comment
 * contains a shell recipe, which is what a feature looks like when nobody gave
 * it a screen. This is the screen.
 *
 * It sits under Insights because it answers the third question of the same
 * kind: coverage asks what nobody tested, suite health asks whether the tests
 * were worth running, and this asks which of them this diff needs at all.
 *
 * Two things this page refuses to do, both because the API refuses to:
 *
 *   · It never presents a skip as safe. Every skipped test carries the sentence
 *     that skipped it, and the strategy line says when the whole suite is being
 *     run instead — a selection you cannot argue with is a selection you cannot
 *     trust.
 *   · It never hides `known: false`. A test that declares no route has nothing
 *     a diff can be checked against, so it can never be skipped, and that is
 *     the answer to "why is my test always in the run list".
 */

/**
 * Getting the diff.
 *
 * `--no-renames` is load-bearing and is repeated here verbatim from the API's
 * own doc comment: git detects renames by default and `--name-only` then prints
 * only the new path, so a renamed page reports as "a file appeared" and never
 * as "the old URL is gone" — and every test that still visits the old URL looks
 * unaffected right up until it 404s.
 */
const DIFF_RECIPE = 'git diff --name-only --no-renames origin/main...HEAD';

const CONFIDENCE_TONE: Record<ImpactConfidence, 'pass' | 'flake' | 'fail' | 'neutral'> = {
  HIGH: 'pass',
  MEDIUM: 'flake',
  LOW: 'fail',
  NONE: 'neutral',
};

const STRATEGY_BLURB: Record<string, string> = {
  RUN_EVERYTHING:
    'Nothing here can be skipped safely, so the answer is the whole suite. That is the analysis working, not failing.',
  SELECTIVE: 'Each test was decided on its own evidence. Read the reasons before trusting a skip.',
  SMOKE_FLOOR:
    'Too little was attributable to select on, so the critical-path floor runs regardless.',
};

/** One changed path per line — the shape `git diff --name-only` already emits. */
function parsePaths(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default function ImpactPage() {
  const router = useRouter();
  const toast = useToast();
  const { project, projectId, loading: projectLoading } = useProject();

  const [raw, setRaw] = useState('');
  const [analysis, setAnalysis] = useState<ImpactAnalysis | null>(null);
  const [signals, setSignals] = useState<ImpactSignals | null>(null);
  const [running, setRunning] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(true);
  const [showSignals, setShowSignals] = useState(false);

  // The signals table is what makes a skip auditable, and it does not depend on
  // a diff — so it loads with the page rather than waiting for one.
  const loadSignals = useCallback(async () => {
    if (!projectId) return;
    try {
      setSignals(await api<ImpactSignals>(`/impact/signals?projectId=${projectId}`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.push('/login');
      // A missing signals table costs the audit view and nothing else; the
      // analysis below still works, so this does not blank the screen.
    }
  }, [projectId, router]);

  useEffect(() => {
    setAnalysis(null);
    setSignals(null);
    void loadSignals();
  }, [loadSignals]);

  const paths = parsePaths(raw);

  async function analyze() {
    if (!projectId || paths.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      setAnalysis(
        await api<ImpactAnalysis>('/impact/analyze', {
          method: 'POST',
          body: JSON.stringify({ projectId, changedPaths: paths }),
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not analyse this diff');
    } finally {
      setRunning(false);
    }
  }

  /**
   * The whole point of the feature, made clickable.
   *
   * `testIds` is documented as ready to POST to /runs as-is, so the selection
   * turns into a run without a copy-paste step — and lands the user in the
   * cockpit for it, which is the next thing they were going to open anyway.
   */
  async function runSelected() {
    if (!analysis || !project) return;
    const environmentId = project.environments[0]?.id;
    if (!environmentId) {
      toast.error('This app has no environment to run against yet.');
      return;
    }
    setQueueing(true);
    try {
      const { run } = await api<{ run: { id: string } }>('/runs', {
        method: 'POST',
        body: JSON.stringify({
          environmentId,
          testIds: analysis.testIds,
          trigger: 'MANUAL',
        }),
      });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the run');
      setQueueing(false);
    }
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Impact analysis"
        subtitle="Which tests a change actually needs — with the sentence that decided each one, because a selection you cannot argue with is a selection you cannot trust."
      />
      <InsightsTabs active="impact" />

      {!projectLoading && !projectId ? (
        <EmptyState
          title="No project selected"
          body="The analysis reads this app's tests and its flow map. Pick an app in the top bar and this fills in."
        />
      ) : (
        <div className="space-y-6">
          {/* ── The diff ─────────────────────────────────────────────────── */}
          <Card className="p-4">
            <SectionLabel>Changed files</SectionLabel>
            <p className="text-ink-dim text-body-sm mb-3 leading-relaxed">
              One path per line, exactly as the diff reports them.{' '}
              <span className="text-ink-faint">
                Both sides of a rename must be here — <code className="font-mono">--no-renames</code>{' '}
                is what makes git print the old path, and without it a moved page reads as a new one
                and every test that visits the old URL looks unaffected.
              </span>
            </p>
            <code className="border-line bg-surface-2/50 text-ink-dim mb-3 block overflow-x-auto rounded-md border px-3 py-2 font-mono text-micro">
              {DIFF_RECIPE}
            </code>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={6}
              spellCheck={false}
              aria-label="Changed file paths, one per line"
              placeholder={'app/checkout/page.tsx\napp/cart/total.ts'}
              className="border-line bg-surface-1 placeholder:text-ink-faint focus:border-accent w-full rounded-md border px-3 py-2 font-mono text-micro outline-none transition-colors"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                onClick={() => void analyze()}
                disabled={paths.length === 0}
                loading={running}
              >
                Analyse
              </Button>
              <span className="text-ink-faint text-micro tabular-nums">
                {paths.length} {paths.length === 1 ? 'path' : 'paths'}
              </span>
              {error && (
                <span role="alert" className="text-fail text-micro">
                  {error}
                </span>
              )}
            </div>
          </Card>

          {running && !analysis && (
            <Card className="overflow-hidden">
              <SkeletonRows rows={5} />
            </Card>
          )}

          {analysis && (
            <>
              {/* ── The answer ─────────────────────────────────────────────── */}
              <Card className="p-5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
                  <p className="text-2xl font-semibold tracking-tight tabular-nums">
                    {analysis.totals.run} of {analysis.totals.tests}
                  </p>
                  <p className="text-ink-dim text-body-sm">
                    tests need to run
                    {analysis.savedPercent > 0 && (
                      <span className="text-pass">
                        {' — '}
                        <span className="tabular-nums">{analysis.savedPercent}%</span> of the suite
                        skipped
                      </span>
                    )}
                  </p>
                  <span className="ml-auto flex items-center gap-2">
                    <Badge mono>{analysis.strategy.toLowerCase().replace(/_/g, ' ')}</Badge>
                    <Badge mono tone={CONFIDENCE_TONE[analysis.confidence]}>
                      {analysis.confidence.toLowerCase()} confidence
                    </Badge>
                  </span>
                </div>

                <p className="text-ink-dim text-body-sm mt-3 leading-relaxed">{analysis.reason}</p>
                <p className="text-ink-faint text-micro mt-1.5">
                  {STRATEGY_BLURB[analysis.strategy]}
                </p>

                {/* Without a flow map the analysis has only the tests' own route
                    literals, so it cannot connect a changed route to a test that
                    reaches it indirectly. That changes how much to trust every
                    skip below, so it is said here and not in a footnote. */}
                {analysis.flowMapVersion === null ? (
                  <p className="border-flake/40 bg-flake/10 text-flake text-micro mt-4 rounded-md border p-2.5">
                    This app has never been crawled, so the only thing linking a test to the diff is
                    a route it names in its own source. A test that navigates through a helper looks
                    unrelated to everything.{' '}
                    <Link href="/flow-map" className="underline">
                      Crawl it →
                    </Link>
                  </p>
                ) : (
                  <p className="text-ink-faint text-micro mt-3">
                    Using flow map v
                    <span className="tabular-nums">{analysis.flowMapVersion}</span>.
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    onClick={() => void runSelected()}
                    loading={queueing}
                    disabled={analysis.testIds.length === 0}
                    title="Queue exactly these tests and open the run"
                  >
                    Run these {analysis.testIds.length}
                  </Button>
                  <Link
                    href="/insights/health"
                    className="text-ink-faint hover:text-accent text-micro hover:underline"
                    title="Sharding, duplicates and the tests that cost the most"
                  >
                    Why is the suite this slow? →
                  </Link>
                </div>
              </Card>

              {/* ── What each changed file was taken to mean ───────────────── */}
              <section>
                <SectionLabel>What each file was taken to mean</SectionLabel>
                <Card className="divide-line divide-y overflow-hidden">
                  {analysis.attributions.map((attribution) => (
                    <div key={attribution.path} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <code className="font-mono text-micro">{attribution.path}</code>
                        <Badge mono>{attribution.kind.replace(/-/g, ' ')}</Badge>
                        <Badge mono tone={CONFIDENCE_TONE[attribution.confidence]}>
                          {attribution.confidence.toLowerCase()}
                        </Badge>
                        {attribution.blastRadius && <Badge tone="fail">forces the whole suite</Badge>}
                        {attribution.ignored && <Badge>cannot affect the app</Badge>}
                      </div>
                      <p className="text-ink-dim text-micro mt-1.5">{attribution.why}</p>
                      {attribution.routes.length > 0 && (
                        <ul className="mt-1.5 flex flex-wrap gap-1.5">
                          {attribution.routes.map((route) => (
                            <li key={route.route}>
                              <Badge mono>
                                {route.route}
                                {route.subtree ? ' and below' : ''}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </Card>
              </section>

              {/* ── The decisions ─────────────────────────────────────────── */}
              <section>
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <SectionLabel>Every test, and why</SectionLabel>
                  {/* Only when there is something to hide. "Hide the 0 skipped"
                      is a control that does nothing, on the screen whose whole
                      job is to be believable. */}
                  {analysis.totals.skip > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowSkipped((v) => !v)}
                      aria-pressed={showSkipped}
                      className="text-ink-faint hover:text-ink mb-3 ml-auto text-micro"
                    >
                      {showSkipped ? 'Hide' : 'Show'} the {analysis.totals.skip} skipped
                    </button>
                  )}
                </div>
                <Card className="divide-line divide-y overflow-hidden">
                  {analysis.run.map((decision) => (
                    <DecisionRow key={decision.testId} decision={decision} />
                  ))}
                  {showSkipped &&
                    analysis.skip.map((decision) => (
                      <DecisionRow key={decision.testId} decision={decision} />
                    ))}
                </Card>
              </section>
            </>
          )}

          {/* ── The audit view ───────────────────────────────────────────── */}
          {signals && (
            <section>
              <button
                type="button"
                onClick={() => setShowSignals((v) => !v)}
                aria-expanded={showSignals}
                className="text-ink-dim hover:text-ink flex w-full items-center gap-2 text-left"
              >
                <span className="text-ink-faint text-micro w-3">{showSignals ? '▾' : '▸'}</span>
                <span className="text-body-sm font-semibold tracking-tight">
                  What the analysis believes each test covers
                </span>
                <Badge mono>{signals.signals.length}</Badge>
                {signals.unknownCount > 0 && (
                  <Badge tone="flake">
                    <span className="tabular-nums">{signals.unknownCount}</span> can never be skipped
                  </Badge>
                )}
              </button>

              {showSignals && (
                <>
                  <p className="text-ink-faint text-micro mt-2 mb-2 leading-relaxed">
                    A test is only skippable if it declares something a diff can be checked against,
                    and routes are the only thing that qualifies — a tag is a label somebody typed.
                    This is the answer to &ldquo;why was my test skipped&rdquo;, and to why one never
                    is.
                  </p>
                  <Card className="divide-line divide-y overflow-hidden">
                    {signals.signals.map((signal) => (
                      <div key={signal.testId} className="px-4 py-3">
                        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                          <Link
                            href={`/tests/${signal.testId}`}
                            className="hover:text-accent text-body-sm hover:underline"
                          >
                            {signal.name}
                          </Link>
                          <code className="text-ink-faint font-mono text-micro">
                            {signal.filePath}
                          </code>
                          {!signal.known && (
                            <Badge tone="flake">declares no route — always runs</Badge>
                          )}
                          {signal.coverageTruncated && (
                            <Badge tone="flake">read incompletely</Badge>
                          )}
                        </div>
                        {signal.routes.length > 0 && (
                          <ul className="mt-1.5 flex flex-wrap gap-1.5">
                            {signal.routes.map((route) => (
                              <li key={route}>
                                <Badge mono>{route}</Badge>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </Card>
                </>
              )}
            </section>
          )}
        </div>
      )}
    </Page>
  );
}

/**
 * One test's decision.
 *
 * The reason is not a tooltip. It is the row's second line, always visible, and
 * the test's name links to its history — because the question after "this was
 * skipped" is "and has it been failing anyway?", which is a different screen.
 */
function DecisionRow({ decision }: { decision: ImpactDecision }) {
  const run = decision.decision === 'run';
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Badge tone={run ? 'accent' : 'neutral'} mono>
          {run ? 'run' : 'skip'}
        </Badge>
        <Link
          href={`/tests/${decision.testId}`}
          className="hover:text-accent text-body-sm hover:underline"
          title="This test's history"
        >
          {decision.name}
        </Link>
        <code className="text-ink-faint font-mono text-micro">{decision.filePath}</code>
        {decision.priority === 'CRITICAL_PATH' && <Badge tone="fail">critical path</Badge>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Badge mono tone={CONFIDENCE_TONE[decision.confidence]}>
            {decision.confidence.toLowerCase()}
          </Badge>
        </span>
      </div>
      <p className="text-ink-dim text-micro mt-1.5 leading-relaxed">{decision.reason}</p>
      {decision.matchedPaths.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {decision.matchedPaths.map((path) => (
            <li key={path}>
              <Badge mono>{path}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
