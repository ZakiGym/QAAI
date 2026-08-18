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
import { Badge, SectionLabel, SkeletonRows } from '../../../components/ui/layout';
import { cn } from '../../../lib/cn';

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
 *   · It never hides a test that declares no route. It has nothing a diff can be
 *     checked against, so it can never be skipped, and it is listed among the
 *     skips in the flake colour saying exactly that — which is the answer to
 *     "why is my test always in the run list".
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

const CONFIDENCE_TONE: Record<ImpactConfidence, string> = {
  HIGH: 'text-pass',
  MEDIUM: 'text-ink-dim',
  LOW: 'text-flake',
  NONE: 'text-ink-faint',
};

const STRATEGY_BLURB: Record<string, string> = {
  RUN_EVERYTHING:
    'Nothing here can be skipped safely, so the answer is the whole suite. That is the analysis working, not failing.',
  SELECTIVE: 'Each test was decided on its own evidence. Read the reasons before trusting a skip.',
  SMOKE_FLOOR:
    'Too little was attributable to select on, so the critical-path floor runs regardless.',
};

/**
 * Signals that mean "this ran for a reason that is not the diff".
 *
 * The word on the right of a run row is the confidence the analysis had in the
 * attribution, except for these — a floor test ran because of a rule, not
 * because anything linked it to a changed file, and printing `NONE` next to it
 * reads as "we are not sure" when the truth is "we did not have to be".
 */
const FLOOR_SIGNALS = new Set([
  'smoke-floor',
  'priority-floor',
  'no-coverage-signal',
  'truncated-coverage',
]);

function isFloor(decision: ImpactDecision): boolean {
  return decision.signals.some((s) => FLOOR_SIGNALS.has(s));
}

/** A test that cannot be skipped at all, as opposed to one that ran on evidence. */
function declaresNothing(decision: ImpactDecision): boolean {
  return decision.signals.includes('no-coverage-signal');
}

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
  const { project, projectId, projects, loading: projectLoading } = useProject();

  const [raw, setRaw] = useState('');
  const [analysis, setAnalysis] = useState<ImpactAnalysis | null>(null);
  const [signals, setSignals] = useState<ImpactSignals | null>(null);
  const [running, setRunning] = useState(false);
  const [queueing, setQueueing] = useState<'selected' | 'everything' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSignals, setShowSignals] = useState(false);
  const [showAttributions, setShowAttributions] = useState(false);

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
   * `null` is the same endpoint's way of saying "everything", which is what the
   * escape hatch beside it sends when somebody does not believe the selection.
   */
  async function queue(what: 'selected' | 'everything') {
    if (!project) return;
    const environmentId = project.environments[0]?.id;
    if (!environmentId) {
      toast.error('This app has no environment to run against yet.');
      return;
    }
    setQueueing(what);
    try {
      const { run } = await api<{ run: { id: string } }>('/runs', {
        method: 'POST',
        body: JSON.stringify({
          environmentId,
          testIds: what === 'everything' ? null : (analysis?.testIds ?? null),
          trigger: 'MANUAL',
        }),
      });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the run');
      setQueueing(null);
    }
  }

  /*
   * A zero-project org cannot pick anything in the sidebar, so saying so left
   * it with an instruction and no way to carry it out. `projects` is only read
   * once the provider has settled, which is what `!projectLoading` above
   * guarantees — before that, "no apps" and "not fetched yet" look identical.
   */
  if (!projectLoading && !projectId) {
    const noApps = projects.length === 0;
    return (
      <EmptyState
        title={noApps ? 'No app to analyse yet' : 'No project selected'}
        body={
          noApps
            ? "The analysis decides which of an app's tests a diff actually needs, by reading those tests and its flow map. Connect an app and this fills in."
            : "The analysis reads this app's tests and its flow map. Pick an app in the sidebar and this fills in."
        }
        {...(noApps ? { action: { label: 'Add your app', href: '/onboarding' } } : {})}
      />
    );
  }

  /*
   * A test that ran because it declares no route belongs with the skips, not
   * with them: the question it answers is "why was this one NOT skipped", and
   * that question is asked while reading the skip list.
   */
  const unskippable = (analysis?.run ?? []).filter(declaresNothing);

  return (
    <>
      <p className="text-ink-dim text-row">
        Paste the changed paths; each test is decided on its own evidence. A skip you cannot audit
        is a skip you cannot trust.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <code className="border-line bg-surface-1 text-ink-dim rounded-md border px-2.5 py-1.5 font-mono text-[11px]">
          {DIFF_RECIPE}
        </code>
        <span className="text-ink-faint text-meta font-mono">--no-renames is load-bearing</span>
      </div>

      <label htmlFor="impact-paths" className="sr-only">
        Changed file paths, one per line
      </label>
      <textarea
        id="impact-paths"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={'src/checkout/quote.ts\nsrc/cart/drawer.tsx\nREADME.md'}
        className="border-line bg-surface-1 text-ink-dim placeholder:text-ink-faint focus:border-line-strong mt-2.5 block w-full resize-y rounded-lg border px-3.5 py-3 font-mono text-[11.5px] leading-[1.7] outline-none transition-colors"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={() => void analyze()}
          disabled={paths.length === 0}
          loading={running}
        >
          Analyze
        </Button>
        {analysis ? (
          <span className="text-ink-dim text-micro font-mono">
            {analysis.strategy.replace(/_/g, ' ')} —{' '}
            <span className="text-pass tabular-nums">{analysis.totals.run} run</span> ·{' '}
            <span className="text-ink-faint tabular-nums">{analysis.totals.skip} skipped</span>
          </span>
        ) : (
          <span className="text-ink-faint text-micro font-mono tabular-nums">
            {paths.length} {paths.length === 1 ? 'path' : 'paths'}
          </span>
        )}
        {error && (
          <span role="alert" className="text-fail text-micro">
            {error}
          </span>
        )}
      </div>

      {running && !analysis && <SkeletonRows rows={5} className="mt-7" />}

      {analysis && (
        <>
          <p className="text-ink-dim text-row-sub mt-4 leading-relaxed">
            {analysis.reason}{' '}
            <span className="text-ink-faint">{STRATEGY_BLURB[analysis.strategy]}</span>
          </p>

          {/* Without a flow map the analysis has only the tests' own route
              literals, so it cannot connect a changed route to a test that
              reaches it indirectly. That changes how much to trust every skip
              below, so it is said here and not in a footnote. */}
          {analysis.flowMapVersion === null ? (
            <p className="border-flake/40 text-flake text-micro mt-3 rounded-md border bg-[color-mix(in_srgb,var(--color-flake)_8%,transparent)] p-2.5">
              This app has never been crawled, so the only thing linking a test to the diff is a
              route it names in its own source. A test that navigates through a helper looks
              unrelated to everything.{' '}
              <Link href="/flow-map" className="underline">
                Crawl it →
              </Link>
            </p>
          ) : (
            <p className="text-ink-faint text-meta mt-2 font-mono">
              using flow map v<span className="tabular-nums">{analysis.flowMapVersion}</span>
            </p>
          )}

          {/* ── What each changed file was taken to mean ─────────────────── */}
          <section className="mt-7">
            <div className="flex items-baseline gap-3">
              <SectionLabel className="mb-0">
                Changed files · {analysis.totals.changedPaths}
              </SectionLabel>
              <button
                type="button"
                onClick={() => setShowAttributions((v) => !v)}
                aria-expanded={showAttributions}
                className="text-accent ml-auto shrink-0 text-[12px] hover:underline"
              >
                {showAttributions ? 'hide' : 'what each one was taken to mean'} →
              </button>
            </div>
            {showAttributions && (
              <div className="mt-1.5">
                {analysis.attributions.map((attribution) => (
                  <div key={attribution.path} className="border-line border-b py-2.5">
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <code className="text-micro font-mono">{attribution.path}</code>
                      <Badge>{attribution.kind.replace(/-/g, ' ')}</Badge>
                      <span
                        className={cn(
                          'text-meta font-mono',
                          CONFIDENCE_TONE[attribution.confidence],
                        )}
                      >
                        {attribution.confidence}
                      </span>
                      {attribution.blastRadius && <Badge tone="fail">forces the whole suite</Badge>}
                      {attribution.ignored && <Badge>cannot affect the app</Badge>}
                    </div>
                    <p className="text-ink-faint text-row-sub mt-1">{attribution.why}</p>
                    {attribution.routes.length > 0 && (
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {attribution.routes.map((route) => (
                          <li key={route.route}>
                            <Badge>
                              {route.route}
                              {route.subtree ? ' and below' : ''}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── What runs ─────────────────────────────────────────────────── */}
          <section className="mt-7">
            <SectionLabel className="mb-1.5">Runs · {analysis.totals.run}</SectionLabel>
            <div>
              {analysis.run.map((decision) => (
                <DecisionRow key={decision.testId} decision={decision} />
              ))}
            </div>
          </section>

          {/* ── What does not, and why ───────────────────────────────────── */}
          <section className="mt-6">
            <SectionLabel className="mb-1.5">
              Skipped · {analysis.totals.skip} — every one with its sentence
            </SectionLabel>
            {analysis.totals.skip === 0 && unskippable.length === 0 ? (
              <p className="border-line text-ink-dim text-body-sm border-b py-2.5">
                Nothing was skipped — every test in this suite can reach the change.
              </p>
            ) : (
              <div>
                {analysis.skip.map((decision) => (
                  <DecisionRow key={decision.testId} decision={decision} />
                ))}
                {/*
                 * Listed here even though they RAN. "Declares no route" is the
                 * answer to why a test is never absent from a run list, and it
                 * is only ever asked while reading the skips.
                 */}
                {unskippable.map((decision) => (
                  <div
                    key={decision.testId}
                    className="border-line flex items-baseline gap-3 border-b py-2.5"
                  >
                    <span className="min-w-0 flex-1">
                      <Link
                        href={`/tests/${decision.testId}`}
                        className="text-ink-dim text-body-sm hover:text-accent block"
                      >
                        {decision.name}
                      </Link>
                      <span className="text-flake text-row-sub mt-0.5 block">
                        declares no route — can never be skipped safely; runs
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="mt-5 flex flex-wrap gap-2.5">
            <Button
              variant="primary"
              onClick={() => void queue('selected')}
              loading={queueing === 'selected'}
              disabled={analysis.testIds.length === 0 || queueing !== null}
              title="Queue exactly these tests and open the run"
            >
              Queue the {analysis.testIds.length}
            </Button>
            {/*
             * Always offered. The analysis is a recommendation and the reader is
             * allowed not to believe it — hiding the whole-suite button behind
             * "are you sure" would make the selection feel binding, which is the
             * one thing it must never be.
             */}
            <Button
              onClick={() => void queue('everything')}
              loading={queueing === 'everything'}
              disabled={queueing !== null}
              title={`Ignore the selection and run all ${analysis.totals.tests} tests`}
            >
              Run everything instead
            </Button>
          </div>
        </>
      )}

      {/* ── The audit view ────────────────────────────────────────────────── */}
      {signals && (
        <section className="mt-8">
          <div className="flex items-baseline gap-3">
            <SectionLabel className="mb-0">
              What the analysis believes each test covers · {signals.signals.length}
            </SectionLabel>
            {signals.unknownCount > 0 && (
              <span className="text-flake text-meta font-mono">
                <span className="tabular-nums">{signals.unknownCount}</span> can never be skipped
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowSignals((v) => !v)}
              aria-expanded={showSignals}
              className="text-accent ml-auto shrink-0 text-[12px] hover:underline"
            >
              {showSignals ? 'hide' : 'open'} →
            </button>
          </div>

          {showSignals && (
            <>
              <p className="text-ink-faint text-row-sub mt-1.5 leading-relaxed">
                A test is only skippable if it declares something a diff can be checked against, and
                routes are the only thing that qualifies — a tag is a label somebody typed. This is
                the answer to &ldquo;why was my test skipped&rdquo;, and to why one never is.
              </p>
              <div className="mt-1.5">
                {signals.signals.map((signal) => (
                  <div key={signal.testId} className="border-line border-b py-2.5">
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <Link
                        href={`/tests/${signal.testId}`}
                        className="text-row hover:text-accent hover:underline"
                      >
                        {signal.name}
                      </Link>
                      <code className="text-ink-faint text-meta font-mono">{signal.filePath}</code>
                      {!signal.known && (
                        <span className="text-flake text-row-sub">
                          declares no route — always runs
                        </span>
                      )}
                      {signal.coverageTruncated && (
                        <span className="text-flake text-row-sub">read incompletely</span>
                      )}
                    </div>
                    {signal.routes.length > 0 && (
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {signal.routes.map((route) => (
                          <li key={route}>
                            <Badge>{route}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}

/**
 * One test's decision.
 *
 * The reason is not a tooltip — it is the row's second line, always visible,
 * because the whole feature is the sentence rather than the selection. It gets
 * its own line rather than sharing one with the name: the API's reasons are
 * full sentences ("Nothing links it to this diff, but attribution is only LOW
 * confidence and an IMPORTANT test needs MEDIUM before it is skipped"), and
 * side by side they squeezed the test's name down to four characters.
 *
 * The name links to the test's history, since the question after "this was
 * skipped" is "and has it been failing anyway?", which is a different screen.
 */
function DecisionRow({ decision }: { decision: ImpactDecision }) {
  const run = decision.decision === 'run';
  const floor = isFloor(decision);
  return (
    <div className="border-line flex items-baseline gap-3 border-b py-2.5">
      <span className="min-w-0 flex-1">
        <Link
          href={`/tests/${decision.testId}`}
          className={cn('text-body-sm hover:text-accent block', run ? 'text-ink' : 'text-ink-dim')}
          title="This test's history"
        >
          {decision.name}
        </Link>
        <span className="text-ink-faint text-row-sub mt-0.5 block">{decision.reason}</span>
      </span>
      <span
        className={cn(
          'text-meta shrink-0 font-mono',
          floor ? 'text-ink-faint' : CONFIDENCE_TONE[decision.confidence],
        )}
      >
        {floor ? 'FLOOR' : decision.confidence}
      </span>
    </div>
  );
}
