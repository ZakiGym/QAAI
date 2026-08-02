'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { Badge, Card, SectionLabel, Skeleton } from './ui/layout';

/**
 * Suite health — "is this suite still worth what it costs to run?"
 *
 * The score is rendered DECOMPOSED because a single number nobody can take
 * apart is a number nobody trusts. The first question anyone asks about a 74 is
 * "which part is bad?", and the endpoint answers it — per-component score, the
 * weight each one actually got after renormalisation, its contribution in
 * points, and a sentence of evidence — so the headline number here is built out
 * of its parts on screen rather than asserted above them.
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

// ─── Shared bits ─────────────────────────────────────────────────────────────

const GRADE_TONE: Record<string, string> = {
  A: 'text-pass',
  B: 'text-pass',
  C: 'text-flake',
  D: 'text-flake',
  F: 'text-fail',
};

const SEVERITY_TONE: Record<WeakSeverity, 'fail' | 'flake' | 'neutral'> = {
  HIGH: 'fail',
  MEDIUM: 'flake',
  LOW: 'neutral',
};

function bandColour(score: number): string {
  if (score >= 80) return 'bg-pass';
  if (score >= 50) return 'bg-flake';
  return 'bg-fail';
}

/** The score, at the size a headline number deserves. */
export function ScoreHeadline({
  report,
  compact = false,
}: {
  report: SuiteHealthReport;
  compact?: boolean;
}) {
  const worst = [...report.components]
    .filter((c) => c.available && c.score !== null)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];
  const unmeasured = report.components.filter((c) => !c.available);

  return (
    <div className="flex items-start gap-5">
      <div className="text-center">
        <div className={cn('text-5xl leading-none font-semibold tabular-nums', GRADE_TONE[report.grade])}>
          {report.score}
        </div>
        <div className="text-ink-faint text-micro mt-1.5">
          grade <span className={GRADE_TONE[report.grade]}>{report.grade}</span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-body-sm text-ink-dim leading-relaxed">
          Out of 100, over{' '}
          <span className="text-ink tabular-nums">{report.totals.tests}</span> runnable test
          {report.totals.tests === 1 ? '' : 's'}.
          {worst && (
            <>
              {' '}
              The weakest part is{' '}
              <span className="text-ink">{worst.label.toLowerCase()}</span> at{' '}
              <span className="tabular-nums">{worst.score}</span>.
            </>
          )}
          {unmeasured.length > 0 && (
            <>
              {' '}
              <span className="text-flake">
                {unmeasured.length} of {report.components.length} components could not be
                measured
              </span>{' '}
              and {unmeasured.length === 1 ? 'its weight was' : 'their weights were'}{' '}
              redistributed across the rest.
            </>
          )}
        </p>
        {!compact && (
          <p className="text-ink-faint text-micro mt-2">Scope: {report.limits.scope}.</p>
        )}
      </div>
    </div>
  );
}

/**
 * The score, taken apart.
 *
 * Each segment is as wide as the component's EFFECTIVE weight, and the filled
 * part of it is that component's contribution. Every filled pixel is a point in
 * the total, so the bar is the number rather than a picture of it.
 */
function ContributionBar({ components }: { components: HealthComponent[] }) {
  const available = components.filter((c) => c.available && c.effectiveWeight > 0);
  if (available.length === 0) return null;

  return (
    <div>
      <div className="border-line flex h-8 gap-0.5 overflow-hidden rounded-md border">
        {available.map((c) => (
          <div
            key={c.key}
            className="bg-surface-2 relative"
            style={{ flexGrow: c.effectiveWeight, flexBasis: 0 }}
            title={`${c.label}: ${c.contribution} of a possible ${c.effectiveWeight} points`}
          >
            <div
              className={cn('absolute inset-y-0 left-0', bandColour(c.score ?? 0))}
              style={{ width: `${c.score ?? 0}%` }}
            />
          </div>
        ))}
      </div>
      <p className="text-ink-faint text-meta mt-1.5">
        Each block is as wide as the weight that component actually carries; the filled part is
        the points it contributed.
      </p>
    </div>
  );
}

/** Evidence objects are free-form, so this renders any shape without guessing. */
function EvidenceValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-ink-faint">none</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-faint">none</span>;
    return (
      <ul className="space-y-0.5">
        {value.map((v, i) => (
          <li key={i}>
            <EvidenceValue value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <span className="text-ink-dim">
        {entries.map(([k, v], i) => (
          <span key={k}>
            {i > 0 && ' · '}
            <span className="text-ink-faint">{k}</span>{' '}
            <span className="tabular-nums">{String(v)}</span>
          </span>
        ))}
      </span>
    );
  }
  return <span className="tabular-nums">{String(value)}</span>;
}

function ComponentRow({ component }: { component: HealthComponent }) {
  const [open, setOpen] = useState(false);
  const evidence = Object.entries(component.evidence ?? {});

  // Unmeasured is its own presentation. Showing a 0 with a grey bar would read
  // as "scored zero", which is the opposite of what the API is saying.
  if (!component.available) {
    return (
      <div className="border-line border-t py-3.5">
        <div className="flex items-baseline gap-3">
          <span className="text-ink-dim text-body-sm flex-1 font-medium">{component.label}</span>
          <Badge tone="flake">not scored</Badge>
          <span className="text-ink-faint text-micro w-28 text-right tabular-nums">
            {component.weight}% redistributed
          </span>
        </div>
        <p className="text-ink-dim text-body-sm mt-1.5 leading-relaxed">{component.detail}</p>
      </div>
    );
  }

  const score = component.score ?? 0;

  return (
    <div className="border-line border-t py-3.5">
      <div className="flex items-baseline gap-3">
        <span className="text-ink text-body-sm flex-1 font-medium">{component.label}</span>
        <span className={cn('text-sm font-semibold tabular-nums', score >= 80 ? 'text-pass' : score >= 50 ? 'text-flake' : 'text-fail')}>
          {score}
        </span>
        <span className="text-ink-faint text-micro w-28 text-right tabular-nums">
          {component.weight}% → {component.effectiveWeight}%
        </span>
        <span className="text-ink-dim text-micro w-24 text-right tabular-nums">
          +{component.contribution} pts
        </span>
      </div>

      <div className="bg-surface-2 mt-2 h-1.5 overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full', bandColour(score))}
          style={{ width: `${score}%` }}
        />
      </div>

      <p className="text-ink-dim text-body-sm mt-2 leading-relaxed">{component.detail}</p>

      {evidence.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="text-ink-faint hover:text-ink text-micro mt-2 inline-flex items-center gap-1.5 transition-colors"
          >
            <span className={cn('transition-transform', open && 'rotate-90')} aria-hidden="true">
              ▸
            </span>
            {open ? 'Hide the numbers' : 'Check the numbers'}
          </button>
          {open && (
            <dl className="bg-surface-2/50 mt-2 grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-1.5 rounded-md p-3">
              {evidence.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-ink-faint text-micro font-mono">{key}</dt>
                  <dd className="text-ink-dim text-body-sm min-w-0">
                    <EvidenceValue value={value} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </div>
  );
}

export function ScoreDecomposition({ report }: { report: SuiteHealthReport }) {
  return (
    <Card className="p-5">
      <ScoreHeadline report={report} />

      <div className="mt-5">
        <ContributionBar components={report.components} />
      </div>

      <div className="mt-5">
        {report.components.map((c) => (
          <ComponentRow key={c.key} component={c} />
        ))}
      </div>

      {/* The arithmetic, as the API wrote it. Nothing is hidden behind the total. */}
      <div className="border-line mt-4 border-t pt-4">
        <SectionLabel>The arithmetic</SectionLabel>
        <code className="text-ink-dim bg-surface-2 block overflow-x-auto rounded-md px-3 py-2 font-mono text-micro leading-relaxed tabular-nums">
          {report.formula}
        </code>
      </div>
    </Card>
  );
}

// ─── Duplicates ──────────────────────────────────────────────────────────────

const VERDICT_TONE: Record<DuplicatePair['verdict'], 'fail' | 'flake' | 'neutral'> = {
  IDENTICAL: 'fail',
  NEAR_DUPLICATE: 'flake',
  OVERLAPPING: 'neutral',
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
        <div>
          <div className="text-ink-faint text-meta mb-1 uppercase">Shared</div>
          {facet.shared.length === 0 ? (
            <span className="text-ink-faint text-body-sm">nothing</span>
          ) : (
            <ul className="space-y-0.5">
              {facet.shared.map((s, i) => (
                <li key={i} className="text-ink-dim font-mono text-micro break-all">{s}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="text-ink-faint text-meta mb-1 uppercase">Only in the first</div>
          {facet.onlyInA.length === 0 ? (
            <span className="text-ink-faint text-body-sm">nothing</span>
          ) : (
            <ul className="space-y-0.5">
              {facet.onlyInA.map((s, i) => (
                <li key={i} className="text-flake font-mono text-micro break-all">{s}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="text-ink-faint text-meta mb-1 uppercase">Only in the second</div>
          {facet.onlyInB.length === 0 ? (
            <span className="text-ink-faint text-body-sm">nothing</span>
          ) : (
            <ul className="space-y-0.5">
              {facet.onlyInB.map((s, i) => (
                <li key={i} className="text-flake font-mono text-micro break-all">{s}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function DuplicatePairCard({ pair }: { pair: DuplicatePair }) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={VERDICT_TONE[pair.verdict]}>{pair.verdict.replace('_', ' ')}</Badge>
        <span className="text-ink-dim text-micro tabular-nums">
          {Math.round(pair.score * 100)}% similar
        </span>
        {pair.assertionsDiffer && (
          <Badge tone="pass">they check different things</Badge>
        )}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {[pair.a, pair.b].map((ref) => (
          <div key={ref.testId} className="border-line rounded-md border p-2.5">
            <div className="text-ink text-body-sm leading-snug">{ref.name}</div>
            <div className="text-ink-faint text-micro mt-1 font-mono break-all">
              {ref.filePath}
            </div>
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
    </Card>
  );
}

function ClusterCard({ cluster }: { cluster: DuplicateCluster }) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="flake">
          cluster of <span className="tabular-nums">{cluster.size}</span>
        </Badge>
        {cluster.membersDiffer && <Badge tone="pass">members differ</Badge>}
      </div>
      <ul className="mb-3 space-y-1">
        {cluster.members.map((m) => (
          <li key={m.testId} className="text-ink text-body-sm">
            {m.name}
            <span className="text-ink-faint ml-2 font-mono text-micro">{m.filePath}</span>
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
            <div className="text-ink-faint text-meta mb-1 uppercase">{label}</div>
            {values.length === 0 ? (
              <span className="text-ink-faint text-body-sm">none</span>
            ) : (
              <ul className="space-y-0.5">
                {values.map((v, i) => (
                  <li key={i} className="text-ink-dim font-mono text-micro break-all">{v}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <p className="text-ink-dim text-body-sm border-line mt-3 border-t pt-3">
        {cluster.recommendation}
      </p>
    </Card>
  );
}

export function Duplicates({ report }: { report: SuiteHealthReport }) {
  const { duplicates, duplicateClusters, limits } = report;

  if (duplicates.length === 0 && duplicateClusters.length === 0) {
    /*
     * "No pairs reported" and "no duplication" are different claims. When the
     * scan did not complete, the second one is not available and must not be
     * implied — the score itself refuses to grade duplication in that case.
     */
    return limits.duplicateScanComplete ? (
      <EmptyState
        title="No two tests overlap enough to report"
        body={`Every pair was compared at a ${Math.round(limits.minSimilarity * 100)}% similarity threshold and none reached it. ${limits.pairsCompared} pair(s) were checked.`}
      />
    ) : (
      <EmptyState
        title="The duplicate scan did not finish"
        body={`Nothing is listed here, and that is not the same as having no duplicates — the scan stopped early, so an empty list says nothing about this suite. ${limits.duplicateScanNote ?? `${limits.pairsCompared} pair(s) were compared before it stopped.`} The score leaves duplication out entirely rather than grading it off a partial answer.`}
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-ink-dim text-body-sm">
        Compared at a{' '}
        <span className="tabular-nums">{Math.round(limits.minSimilarity * 100)}%</span> similarity
        threshold over <span className="tabular-nums">{limits.pairsCompared}</span> pair(s).
        {limits.omittedPairs > 0 && (
          <>
            {' '}
            <span className="text-flake tabular-nums">{limits.omittedPairs}</span> qualifying
            pair(s) beyond the reporting cap are not shown.
          </>
        )}
      </p>

      {duplicateClusters.length > 0 && (
        <div>
          <SectionLabel>Clusters</SectionLabel>
          <div className="space-y-3">
            {duplicateClusters.map((c) => (
              <ClusterCard key={c.testIds.join('|')} cluster={c} />
            ))}
          </div>
          {limits.omittedClusters > 0 && (
            <p className="text-ink-faint text-micro mt-2">
              <span className="tabular-nums">{limits.omittedClusters}</span> further cluster(s)
              are counted in the score but not listed here.
            </p>
          )}
        </div>
      )}

      {duplicates.length > 0 && (
        <div>
          <SectionLabel>Pairs</SectionLabel>
          <div className="space-y-3">
            {duplicates.map((p) => (
              <DuplicatePairCard key={`${p.a.testId}-${p.b.testId}`} pair={p} />
            ))}
          </div>
        </div>
      )}
    </div>
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

function WeakCard({ finding }: { finding: WeakAssertion }) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Badge>
        <span className="text-ink text-body-sm font-medium">
          {WEAK_KIND_LABEL[finding.kind]}
        </span>
        {finding.feature && <span className="text-ink-faint text-micro">{finding.feature}</span>}
      </div>

      <div className="text-ink-dim text-body-sm">{finding.testName}</div>
      <div className="text-ink-faint text-micro font-mono break-all">
        {finding.filePath}
        {finding.line !== null && <span className="tabular-nums">:{finding.line}</span>}
      </div>

      {/* The real line, so the finding can be checked without opening the file. */}
      <pre className="bg-surface-2 text-ink mt-2.5 overflow-x-auto rounded-md px-3 py-2 font-mono text-micro leading-relaxed">
        <code>{finding.quote}</code>
      </pre>

      <p className="text-ink-dim text-body-sm mt-2.5 leading-relaxed">{finding.why}</p>

      <div className="border-line mt-2.5 border-t pt-2.5">
        <div className="text-ink-faint text-meta mb-1 font-semibold tracking-wider uppercase">
          Assert instead
        </div>
        <p className="text-ink-dim text-body-sm leading-relaxed">{finding.assertInstead}</p>
      </div>
    </Card>
  );
}

const SEVERITY_ORDER: Record<WeakSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function WeakAssertions({ report }: { report: SuiteHealthReport }) {
  const findings = [...report.weakAssertions].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  if (findings.length === 0) {
    return (
      <EmptyState
        title="Every test that was read asserts something real"
        body={`All ${report.totals.analyzed} readable test(s) check content, state or an outcome — none of them merely confirms that a page loaded or an element exists.`}
      />
    );
  }

  const bySeverity = report.totals.weakAssertionsBySeverity;

  return (
    <div className="space-y-4">
      <p className="text-ink-dim text-body-sm">
        <span className="text-ink tabular-nums">{findings.length}</span> finding
        {findings.length === 1 ? '' : 's'} across{' '}
        <span className="tabular-nums">{report.totals.analyzed}</span> readable test(s) —{' '}
        <span className="tabular-nums">{bySeverity.HIGH}</span> high,{' '}
        <span className="tabular-nums">{bySeverity.MEDIUM}</span> medium,{' '}
        <span className="tabular-nums">{bySeverity.LOW}</span> low.
        {report.limits.findingsCapped && (
          <span className="text-flake"> The finding list hit its cap and is not exhaustive.</span>
        )}
      </p>
      <div className="space-y-3">
        {findings.map((f, i) => (
          <WeakCard key={`${f.testId}-${f.kind}-${f.line ?? i}`} finding={f} />
        ))}
      </div>
    </div>
  );
}

// ─── Critical paths ──────────────────────────────────────────────────────────

const JOURNEY_TONE: Record<JourneyCoverage['status'], 'pass' | 'flake' | 'fail'> = {
  COVERED: 'pass',
  PARTIAL: 'flake',
  UNCOVERED: 'fail',
};

export function CriticalPaths({ report }: { report: SuiteHealthReport }) {
  const component = report.components.find((c) => c.key === 'criticalCoverage');

  if (report.criticalPaths.length === 0) {
    return (
      <EmptyState
        title="No critical-path journeys to measure against"
        body={
          component?.detail ??
          'The flow map names no CRITICAL_PATH journeys, so there is nothing to check coverage against. This component is left out of the score rather than guessed at.'
        }
        action={{ label: 'Open the flow map', href: '/flow-map' }}
      />
    );
  }

  return (
    <div className="space-y-3">
      {report.criticalPaths.map((journey) => (
        <Card key={journey.journeyId} className="p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone={JOURNEY_TONE[journey.status]}>{journey.status}</Badge>
            <span className="text-ink text-body-sm font-medium">{journey.name}</span>
            <span className="text-ink-faint text-micro ml-auto tabular-nums">
              best single test covers {Math.round(journey.bestRatio * 100)}%
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {journey.routes.map((r, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-ink-faint text-meta">→</span>}
                <code className="bg-surface-2 rounded px-1.5 py-0.5 font-mono text-micro">
                  {r}
                </code>
              </span>
            ))}
          </div>
          {journey.onlyQuarantined && (
            <p className="text-flake text-body-sm mt-2">
              The only tests touching this journey are quarantined, so the signal is switched
              off — it reads as uncovered however good those tests are.
            </p>
          )}
          <p className="text-ink-faint text-micro mt-2 tabular-nums">
            {journey.coveringTestIds.length} test(s) touch it
          </p>
        </Card>
      ))}
    </div>
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
    <Card className="mt-6 p-4">
      <SectionLabel>What this report could not see</SectionLabel>
      {notes.length > 0 && (
        <ul className="text-ink-dim text-body-sm mb-3 space-y-1">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {unanalyzed.length > 0 && (
        <>
          <p className="text-ink-dim text-body-sm mb-2">
            <span className="tabular-nums">{unanalyzed.length}</span> test(s) could not be read
            end to end. They are named rather than counted, because the test you need to open is
            the one that could not be parsed.
          </p>
          <ul className="divide-line divide-y">
            {unanalyzed.map((u) => (
              <li key={u.testId} className="py-2">
                <div className="text-ink text-body-sm">{u.name}</div>
                <div className="text-ink-faint text-micro font-mono break-all">{u.filePath}</div>
                <div className="text-ink-dim text-body-sm mt-0.5">{u.reason}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export function SuiteHealthSkeleton() {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-5">
        <Skeleton className="h-12 w-16" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
      <Skeleton className="mt-5 h-8 w-full" />
      <div className="mt-5 space-y-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-1.5 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    </Card>
  );
}
