'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import type {
  DuplicateCluster,
  DuplicatePair,
  FacetComparison,
  HealthComponent,
  JourneyCoverage,
  SuiteHealthReport,
  WeakAssertion,
  WeakSeverity,
} from '../lib/api';
import { cn } from '../lib/cn';
import { EmptyState } from './ui/EmptyState';
import { Badge, SectionLabel, Skeleton } from './ui/layout';

/**
 * Suite health — "is this suite still worth what it costs to run?"
 *
 * The score is rendered DECOMPOSED because a single number nobody can take
 * apart is a number nobody trusts. The first question anyone asks about a 72 is
 * "which part is bad?", so the four components sit beside the numeral rather
 * than under a disclosure, the weakest one is drawn in the flake colour, and
 * the arithmetic the API wrote is printed underneath in full.
 *
 * Two things this screen will not do. It never offers a one-click delete on a
 * duplicate: the API returns `safeToDelete: false` on every pair it finds,
 * because a "duplicate" that differs in one assertion is regularly the only
 * test that catches a regression, and that deletion is unrecoverable. And it
 * never reads an empty duplicate list as "no duplicates" when the scan did not
 * complete — a shorter list is not a cleaner suite.
 */

// ─── Data ────────────────────────────────────────────────────────────────────

export interface SuiteHealthData {
  report: SuiteHealthReport | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useSuiteHealth(
  projectId: string | null,
  projectSettling: boolean,
): SuiteHealthData {
  const [report, setReport] = useState<SuiteHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectSettling) return;
    if (!projectId) {
      setReport(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await api<SuiteHealthReport>(`/suite-health/${projectId}`);
        if (!cancelled) setReport(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load suite health');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, projectSettling]);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setReport(await api<SuiteHealthReport>(`/suite-health/${projectId}`));
  }, [projectId]);

  return { report, loading: loading || projectSettling, error, reload };
}

// ─── The score, taken apart ──────────────────────────────────────────────────

/** The lowest-scoring component that was actually measured, or null. */
function weakestOf(components: HealthComponent[]): HealthComponent | null {
  return (
    [...components]
      .filter((c) => c.available && c.score !== null)
      .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0] ?? null
  );
}

/**
 * One component of the score.
 *
 * The weakest measured component is drawn in the flake colour and every other
 * one in the accent, which is the whole grammar of this block: you read the
 * numeral, then your eye lands on the one part that is dragging it down. A
 * traffic-light ramp per component would colour four bars differently and say
 * nothing about which one to fix first.
 */
function ComponentBar({ component, weakest }: { component: HealthComponent; weakest: boolean }) {
  // Unmeasured is its own presentation. A 0 with a grey bar reads as "scored
  // zero", which is the opposite of what the API is saying.
  if (!component.available || component.score === null) {
    return (
      <div>
        <p className="text-meta text-ink-faint mb-[5px] flex justify-between font-mono tracking-[0.08em] uppercase">
          <span>{component.label}</span>
          <span className="text-flake">not scored</span>
        </p>
        <span className="bg-surface-2 block h-1 rounded-full" />
        <p className="text-ink-faint text-meta mt-1.5 tabular-nums">
          {component.weight}% redistributed
        </p>
      </div>
    );
  }

  const score = component.score;
  return (
    <div>
      <p className="text-meta text-ink-faint mb-[5px] flex justify-between font-mono tracking-[0.08em] uppercase">
        <span>{component.label}</span>
        <span className={cn('tabular-nums', weakest ? 'text-flake' : 'text-ink')}>{score}</span>
      </p>
      <span className="bg-surface-2 block h-1 overflow-hidden rounded-full">
        <span
          className={cn('block h-full rounded-full', weakest ? 'bg-flake' : 'bg-accent')}
          style={{ width: `${score}%` }}
        />
      </span>
      <p className="text-ink-faint text-meta mt-1.5 font-mono tabular-nums">
        {component.weight}% → {component.effectiveWeight}% · +{component.contribution} pts
      </p>
    </div>
  );
}

export function ScoreDecomposition({ report }: { report: SuiteHealthReport }) {
  const weakest = weakestOf(report.components);
  const unmeasured = report.components.filter((c) => !c.available);

  return (
    <>
      <div className="flex flex-wrap items-start gap-x-9 gap-y-5">
        <div className="shrink-0">
          <span className="font-display text-score leading-none font-semibold tabular-nums">
            {report.score}
          </span>
          <span className="text-ink-faint font-mono text-[12px]"> /100</span>
          <span className="text-ink-faint mt-1.5 block font-mono text-[12px]">
            grade {report.grade} · {report.totals.tests} runnable test
            {report.totals.tests === 1 ? '' : 's'}
          </span>
        </div>
        <div className="grid min-w-[280px] flex-1 grid-cols-1 gap-x-7 gap-y-3.5 pt-1.5 sm:grid-cols-2">
          {report.components.map((c) => (
            <ComponentBar key={c.key} component={c} weakest={c.key === weakest?.key} />
          ))}
        </div>
      </div>

      <p className="text-ink-faint mt-3.5 text-[12px]">
        Shown taken apart — a number nobody can decompose is a number nobody trusts.
        {weakest && (
          <>
            {' '}
            <span className="text-ink-dim">{weakest.detail}</span>
          </>
        )}
      </p>

      {unmeasured.length > 0 && (
        <p className="text-flake mt-1.5 text-[12px]">
          <span className="tabular-nums">{unmeasured.length}</span> of{' '}
          <span className="tabular-nums">{report.components.length}</span> components could not be
          measured, and {unmeasured.length === 1 ? 'its weight was' : 'their weights were'}{' '}
          redistributed across the rest.
        </p>
      )}

      {/* The arithmetic, as the API wrote it. Nothing is hidden behind the total. */}
      <p className="text-ink-faint text-meta mt-2 overflow-x-auto font-mono whitespace-nowrap tabular-nums">
        {report.formula}
      </p>
      <p className="text-ink-faint text-meta mt-1">Scope: {report.limits.scope}.</p>
    </>
  );
}

// ─── Weak assertions ─────────────────────────────────────────────────────────

const WEAK_KIND_LABEL: Record<WeakAssertion['kind'], string> = {
  NO_ASSERTIONS: 'Asserts nothing',
  TRANSPORT_ONLY: 'Only checks the transport',
  EXISTENCE_ONLY: 'Only checks that it exists',
  VOLATILE_ASSERTION: 'Asserts something volatile',
  SWALLOWED_ASSERTION: 'Assertion is swallowed',
  NO_NEGATIVE_PATH: 'Never watches it fail',
};

const SEVERITY_ORDER: Record<WeakSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * One finding, as a hairline row.
 *
 * `open →` goes to the test rather than to a modal: the per-test screen already
 * renders this same finding with the offending source line and the assertion
 * the analysis would write instead, and duplicating that here would give the
 * reader two places to check one fact.
 */
function WeakRow({ finding }: { finding: WeakAssertion }) {
  return (
    <div className="border-line flex items-baseline gap-3 border-b py-[11px]">
      <span className="min-w-0 flex-1">
        <span className="text-body-sm block">
          {WEAK_KIND_LABEL[finding.kind]}
          <span className="text-ink-faint"> · {finding.testName}</span>
        </span>
        <span className="text-ink-faint text-micro mt-0.5 block font-mono break-all">
          {finding.filePath}
          {finding.line !== null && <span className="tabular-nums">:{finding.line}</span>} —{' '}
          {finding.why}
        </span>
      </span>
      <Link
        href={`/tests/${finding.testId}`}
        className="text-accent shrink-0 text-[12px] hover:underline"
      >
        open →
      </Link>
    </div>
  );
}

export function WeakAssertions({ report }: { report: SuiteHealthReport }) {
  const findings = [...report.weakAssertions].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const bySeverity = report.totals.weakAssertionsBySeverity;

  return (
    <section className="mt-8">
      <SectionLabel className="mb-1.5">Weak assertions · {findings.length}</SectionLabel>
      {findings.length === 0 ? (
        <p className="text-ink-dim text-body-sm py-2">
          Every test that was read asserts something real. All{' '}
          <span className="tabular-nums">{report.totals.analyzed}</span> readable test(s) check
          content, state or an outcome — none of them merely confirms that a page loaded or an
          element exists.
        </p>
      ) : (
        <>
          <p className="text-ink-faint text-meta mb-1 font-mono tabular-nums">
            {bySeverity.HIGH} high · {bySeverity.MEDIUM} medium · {bySeverity.LOW} low
            {report.limits.findingsCapped && (
              <span className="text-flake"> · list hit its cap, not exhaustive</span>
            )}
          </p>
          <div>
            {findings.map((f, i) => (
              <WeakRow key={`${f.testId}-${f.kind}-${f.line ?? i}`} finding={f} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ─── Duplication and critical paths ──────────────────────────────────────────

const VERDICT_TONE: Record<DuplicatePair['verdict'], 'fail' | 'flake' | 'neutral'> = {
  IDENTICAL: 'fail',
  NEAR_DUPLICATE: 'flake',
  OVERLAPPING: 'neutral',
};

const JOURNEY_TONE: Record<JourneyCoverage['status'], 'pass' | 'flake' | 'fail'> = {
  COVERED: 'pass',
  PARTIAL: 'flake',
  UNCOVERED: 'fail',
};

function FacetRow({ name, facet }: { name: string; facet: FacetComparison }) {
  if (facet.score === null) {
    return (
      <div className="border-line border-t py-2">
        <div className="text-ink-faint text-micro">{name} — neither test has any</div>
      </div>
    );
  }
  return (
    <div className="border-line border-t py-2">
      <div className="text-ink-dim text-micro mb-1.5 flex items-center justify-between">
        <span className="capitalize">{name}</span>
        <span className="tabular-nums">{Math.round(facet.score * 100)}% the same</span>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {(
          [
            ['Shared', facet.shared, 'text-ink-dim'],
            ['Only in the first', facet.onlyInA, 'text-flake'],
            ['Only in the second', facet.onlyInB, 'text-flake'],
          ] as const
        ).map(([label, values, tone]) => (
          <div key={label}>
            <div className="text-ink-faint text-meta mb-1 font-mono uppercase">{label}</div>
            {values.length === 0 ? (
              <span className="text-ink-faint text-body-sm">nothing</span>
            ) : (
              <ul className="space-y-0.5">
                {values.map((s, i) => (
                  <li key={i} className={cn('text-meta font-mono break-all', tone)}>
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DuplicatePairDetail({ pair }: { pair: DuplicatePair }) {
  return (
    <div className="border-line bg-surface-1 rounded-lg border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={VERDICT_TONE[pair.verdict]}>{pair.verdict.replace('_', ' ')}</Badge>
        <span className="text-ink-dim text-micro tabular-nums">
          {Math.round(pair.score * 100)}% similar
        </span>
        {pair.assertionsDiffer && <Badge tone="pass">they check different things</Badge>}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {[pair.a, pair.b].map((ref) => (
          <div key={ref.testId} className="border-line rounded-md border p-2.5">
            <div className="text-ink text-row leading-snug">{ref.name}</div>
            <div className="text-ink-faint text-meta mt-1 font-mono break-all">{ref.filePath}</div>
            <div className="mt-1.5 flex gap-1.5">
              {ref.feature && <Badge>{ref.feature}</Badge>}
              <Badge>{ref.priority}</Badge>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <FacetRow name="routes" facet={pair.facets.routes} />
        <FacetRow name="actions" facet={pair.facets.actions} />
        <FacetRow name="assertions" facet={pair.facets.assertions} />
        <FacetRow name="data" facet={pair.facets.data} />
      </div>

      <p className="text-ink-dim text-body-sm border-line mt-3 border-t pt-3 leading-relaxed">
        {pair.recommendation}
      </p>
      {/*
       * Stated, not implied by the absence of a button. `safeToDelete` is false
       * on every pair this analysis can produce, and the reader deserves to know
       * that is a property of the finding rather than a missing feature.
       */}
      <p className="text-ink-faint text-micro mt-1.5">
        Neither test is safe to delete on this evidence — a pair that differs in one assertion is
        regularly the one that catches a regression, so this screen will not offer to remove
        either.
      </p>
    </div>
  );
}

function ClusterDetail({ cluster }: { cluster: DuplicateCluster }) {
  return (
    <div className="border-line bg-surface-1 rounded-lg border p-4">
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="flake">
          cluster of <span className="tabular-nums">{cluster.size}</span>
        </Badge>
        {cluster.membersDiffer && <Badge tone="pass">members differ</Badge>}
      </div>
      <ul className="mb-3 space-y-1">
        {cluster.members.map((m) => (
          <li key={m.testId} className="text-ink text-row">
            {m.name}
            <span className="text-ink-faint text-meta ml-2 font-mono">{m.filePath}</span>
          </li>
        ))}
      </ul>
      <div className="grid gap-3 md:grid-cols-3">
        {(
          [
            ['Shared routes', cluster.sharedRoutes],
            ['Shared actions', cluster.sharedActions],
            ['Shared assertions', cluster.sharedAssertions],
          ] as const
        ).map(([label, values]) => (
          <div key={label}>
            <div className="text-ink-faint text-meta mb-1 font-mono uppercase">{label}</div>
            {values.length === 0 ? (
              <span className="text-ink-faint text-body-sm">none</span>
            ) : (
              <ul className="space-y-0.5">
                {values.map((v, i) => (
                  <li key={i} className="text-ink-dim text-meta font-mono break-all">
                    {v}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <p className="text-ink-dim text-body-sm border-line mt-3 border-t pt-3">
        {cluster.recommendation}
      </p>
    </div>
  );
}

/**
 * A summary row that opens its own working.
 *
 * Duplication and critical-path coverage each collapse to one sentence, which
 * is all most readers want; the pairs, the facet-by-facet comparison and the
 * journey routes are behind the row's own link rather than on a tab, because a
 * tab would push the score off screen and the number and the reason for it
 * belong in the same viewport.
 */
function ExpandingRow({
  lead,
  detail,
  action,
  children,
}: {
  lead: React.ReactNode;
  detail: React.ReactNode;
  action: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-line border-b">
      <div className="flex items-baseline gap-3 py-[11px]">
        <p className="text-body-sm flex-1">
          {lead}
          <span className="text-ink-faint"> — {detail}</span>
        </p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-accent shrink-0 text-[12px] hover:underline"
        >
          {open ? 'hide' : action} →
        </button>
      </div>
      {open && <div className="mb-3 space-y-3">{children}</div>}
    </div>
  );
}

export function DuplicationAndCriticalPaths({ report }: { report: SuiteHealthReport }) {
  const { duplicates, duplicateClusters, limits, criticalPaths } = report;
  const pairs = report.totals.duplicatePairs;
  const clusters = report.totals.duplicateClusters;
  const uncovered = criticalPaths.filter((j) => j.status !== 'COVERED');

  return (
    <section className="mt-8">
      <SectionLabel className="mb-1.5">Duplication &amp; critical paths</SectionLabel>

      {pairs === 0 && clusters === 0 ? (
        /*
         * "No pairs reported" and "no duplication" are different claims. When
         * the scan did not complete the second one is not available and must not
         * be implied — the score itself refuses to grade duplication in that
         * case, and so does this sentence.
         */
        <p className="border-line text-body-sm border-b py-[11px]">
          {limits.duplicateScanComplete ? (
            <>
              No two tests overlap enough to report
              <span className="text-ink-faint">
                {' '}
                — every pair was compared at a{' '}
                <span className="tabular-nums">{Math.round(limits.minSimilarity * 100)}%</span>{' '}
                threshold and none of the{' '}
                <span className="tabular-nums">{limits.pairsCompared}</span> reached it
              </span>
            </>
          ) : (
            <>
              The duplicate scan did not finish
              <span className="text-flake">
                {' '}
                — an empty list here says nothing about this suite, so the score leaves duplication
                out entirely rather than grading it off a partial answer
              </span>
            </>
          )}
        </p>
      ) : (
        <ExpandingRow
          lead={
            <>
              <span className="tabular-nums">{pairs}</span> near-duplicate pair
              {pairs === 1 ? '' : 's'}
              {clusters > 0 && (
                <>
                  {' '}
                  and <span className="tabular-nums">{clusters}</span> cluster
                  {clusters === 1 ? '' : 's'}
                </>
              )}{' '}
              walk the same ground
            </>
          }
          detail={
            <>
              compared at{' '}
              <span className="tabular-nums">{Math.round(limits.minSimilarity * 100)}%</span> over{' '}
              <span className="tabular-nums">{limits.pairsCompared}</span> pair(s)
              {limits.omittedPairs > 0 && (
                <>
                  ; <span className="tabular-nums">{limits.omittedPairs}</span> beyond the reporting
                  cap are not listed
                </>
              )}
            </>
          }
          action="review"
        >
          {duplicateClusters.map((c) => (
            <ClusterDetail key={c.testIds.join('|')} cluster={c} />
          ))}
          {duplicates.map((p) => (
            <DuplicatePairDetail key={`${p.a.testId}-${p.b.testId}`} pair={p} />
          ))}
        </ExpandingRow>
      )}

      {criticalPaths.length === 0 ? (
        <p className="border-line text-body-sm border-b py-[11px]">
          No critical-path journeys to measure against
          <span className="text-ink-faint">
            {' '}
            — the flow map names none, so this component is left out of the score rather than
            guessed at
          </span>
        </p>
      ) : (
        <ExpandingRow
          lead={
            uncovered.length === 0 ? (
              <>
                Every critical journey has a test that walks it end to end
              </>
            ) : (
              <>
                <span className="tabular-nums">{uncovered.length}</span> of{' '}
                <span className="tabular-nums">{criticalPaths.length}</span> critical journey
                {criticalPaths.length === 1 ? '' : 's'}{' '}
                {uncovered.length === 1 ? 'is not' : 'are not'} fully covered
              </>
            )
          }
          detail={
            uncovered.length === 0
              ? `all ${criticalPaths.length} checked against the flow map`
              : uncovered.map((j) => j.name).join(', ')
          }
          action="plan"
        >
          {criticalPaths.map((journey) => (
            <div key={journey.journeyId} className="border-line bg-surface-1 rounded-lg border p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge tone={JOURNEY_TONE[journey.status]}>{journey.status}</Badge>
                <span className="text-ink text-row font-medium">{journey.name}</span>
                <span className="text-ink-faint text-meta ml-auto font-mono tabular-nums">
                  best single test covers {Math.round(journey.bestRatio * 100)}%
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {journey.routes.map((r, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-ink-faint text-meta">→</span>}
                    <code className="bg-surface-2 text-meta rounded-sm px-1.5 py-0.5 font-mono">
                      {r}
                    </code>
                  </span>
                ))}
              </div>
              {journey.onlyQuarantined && (
                <p className="text-flake text-row-sub mt-2">
                  The only tests touching this journey are quarantined, so the signal is switched
                  off — it reads as uncovered however good those tests are.
                </p>
              )}
              <p className="text-ink-faint text-meta mt-2 font-mono tabular-nums">
                {journey.coveringTestIds.length} test(s) touch it
              </p>
            </div>
          ))}
        </ExpandingRow>
      )}
    </section>
  );
}

// ─── Honest limits, always on screen ─────────────────────────────────────────

export function HealthLimits({ report }: { report: SuiteHealthReport }) {
  const { limits, unanalyzed } = report;
  const notes: React.ReactNode[] = [];

  if (limits.partial && limits.note) notes.push(limits.note);
  if (limits.flowMapVersion === null) {
    notes.push(
      'This project has no flow map, so critical-path coverage could not be measured at all.',
    );
  }
  if (limits.skippedCommonTokens.length > 0) {
    notes.push(
      `Tokens too common to compare were skipped: ${limits.skippedCommonTokens.join(', ')}.`,
    );
  }

  if (notes.length === 0 && unanalyzed.length === 0) return null;

  return (
    <section className="mt-8">
      <SectionLabel className="mb-1.5">What this report could not see</SectionLabel>
      {notes.length > 0 && (
        <ul className="text-ink-dim text-row-sub mb-3 space-y-1">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {unanalyzed.length > 0 && (
        <>
          <p className="text-ink-dim text-row-sub mb-1">
            <span className="tabular-nums">{unanalyzed.length}</span> test(s) could not be read end
            to end. They are named rather than counted, because the test you need to open is the
            one that could not be parsed.
          </p>
          <div>
            {unanalyzed.map((u) => (
              <div key={u.testId} className="border-line border-b py-2.5">
                <div className="text-ink text-row">{u.name}</div>
                <div className="text-ink-faint text-meta font-mono break-all">{u.filePath}</div>
                <div className="text-ink-dim text-row-sub mt-0.5">{u.reason}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ─── Empty and loading ───────────────────────────────────────────────────────

export function NoRunnableTests() {
  return (
    <EmptyState
      title="There are no runnable tests to grade"
      body="Suite health scores enabled, non-fixture tests. This project has none yet, so there is no suite to report on — a missing score, not a bad one."
      action={{ label: 'Add tests', href: '/editor' }}
    />
  );
}

export function SuiteHealthSkeleton() {
  return (
    <div>
      <div className="flex flex-wrap items-start gap-x-9 gap-y-5">
        <Skeleton className="h-14 w-24" />
        <div className="grid min-w-[280px] flex-1 grid-cols-1 gap-x-7 gap-y-3.5 pt-1.5 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <Skeleton className="mb-1.5 h-2.5 w-28" />
              <Skeleton className="h-1 w-full" />
            </div>
          ))}
        </div>
      </div>
      <Skeleton className="mt-4 h-3 w-96 max-w-full" />
      <Skeleton className="mt-8 h-2.5 w-36" />
      <div className="divide-line mt-2 divide-y" aria-label="Loading" role="status">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="py-3">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="mt-2 h-2.5 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}
