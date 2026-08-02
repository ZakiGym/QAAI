'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useProject } from '../../components/shell/ProjectContext';
import { CoverageHeadline, useCoverage } from '../../components/CoverageGaps';
import { ScoreHeadline, useSuiteHealth } from '../../components/SuiteHealth';
import { EmptyState } from '../../components/ui/EmptyState';
import { Card, Page, PageHeader, SectionLabel, Skeleton, Tabs } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

/**
 * Insights — the two questions no other screen in this product answers.
 *
 * Everything else here reports on tests that ran. Coverage reports on the tests
 * nobody wrote, and suite health reports on whether the ones that did run were
 * worth the minutes. Both were fully built, fully verified, and reachable only
 * with curl; this is the front door to them.
 *
 * This page leads with both answers and gets out of the way. The detail lives
 * one click down, because the first thing somebody needs is the number and the
 * second thing is the argument for it — never both at once.
 */

/**
 * The tab strip for the three insights routes.
 *
 * It lives in this module rather than a layout so that the whole surface stays
 * inside the files this change owns, and it drives the router rather than local
 * state so each view keeps a URL you can send to somebody.
 */
export function InsightsTabs({ active }: { active: 'overview' | 'coverage' | 'health' }) {
  const router = useRouter();
  return (
    <Tabs
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'coverage', label: 'Coverage gaps' },
        { id: 'health', label: 'Suite health' },
      ] as const}
      active={active}
      onChange={(id) =>
        router.push(id === 'overview' ? '/insights' : `/insights/${id}`)
      }
    />
  );
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-accent text-body-sm mt-4 inline-flex items-center gap-1.5 hover:underline"
    >
      {children}
      <span aria-hidden="true">→</span>
    </Link>
  );
}

export default function InsightsPage() {
  const { projectId, loading: projectLoading } = useProject();
  const coverage = useCoverage(projectId, projectLoading);
  const health = useSuiteHealth(projectId, projectLoading);

  const topGaps = (coverage.report?.gaps ?? []).slice(0, 3);
  const worstComponents = [...(health.report?.components ?? [])]
    .filter((c) => c.available && c.score !== null)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, 3);

  return (
    <Page width="wide">
      <PageHeader
        title="Insights"
        subtitle="What the suite does not test, and whether what it does test is worth running."
      />
      <InsightsTabs active="overview" />

      {!projectLoading && !projectId ? (
        <EmptyState
          title="No project selected"
          body="Both reports are computed per app. Pick one in the sidebar and this fills in."
        />
      ) : (
        <div className="space-y-6">
          {/* ── Coverage ─────────────────────────────────────────────────── */}
          <section>
            <SectionLabel>Coverage gaps</SectionLabel>
            {coverage.loading ? (
              <Card className="p-5">
                <Skeleton className="h-6 w-80" />
                <Skeleton className="mt-2 h-3 w-full max-w-lg" />
                <div className="border-line mt-5 grid grid-cols-2 gap-6 border-t pt-5 sm:grid-cols-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i}>
                      <Skeleton className="mb-2 h-2.5 w-16" />
                      <Skeleton className="h-1 w-full" />
                    </div>
                  ))}
                </div>
              </Card>
            ) : coverage.error ? (
              <p className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm">
                {coverage.error}
              </p>
            ) : !coverage.report ? null : !coverage.report.crawled ? (
              <EmptyState
                title="This app has never been crawled"
                body="Coverage compares what the crawler proved your app can do against what the tests assert. With no flow map there is no first half — which is not the same as being fully covered."
                action={{ label: 'Open the flow map', href: '/flow-map' }}
              />
            ) : (
              <>
                <CoverageHeadline report={coverage.report} />
                {topGaps.length > 0 && (
                  <Card className="mt-3 p-4">
                    <SectionLabel>Ranked highest</SectionLabel>
                    <ul className="divide-line divide-y">
                      {topGaps.map((gap) => (
                        <li key={gap.id} className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
                          <span
                            className={cn(
                              'w-8 shrink-0 text-sm font-semibold tabular-nums',
                              gap.score >= 70
                                ? 'text-fail'
                                : gap.score >= 40
                                  ? 'text-flake'
                                  : 'text-ink-dim',
                            )}
                          >
                            {gap.score}
                          </span>
                          <div className="min-w-0">
                            <div className="text-ink text-body-sm leading-snug">{gap.title}</div>
                            {/* One line of evidence even here — the claim never
                                travels without at least some of its support. */}
                            <div className="text-ink-faint text-micro mt-0.5 line-clamp-1">
                              {gap.evidence[0]}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <CardLink href="/insights/coverage">
                      See all {coverage.report.totals.gaps} gaps with their evidence
                    </CardLink>
                  </Card>
                )}
              </>
            )}
          </section>

          {/* ── Suite health ─────────────────────────────────────────────── */}
          <section>
            <SectionLabel>Suite health</SectionLabel>
            {health.loading ? (
              <Card className="p-5">
                <div className="flex gap-5">
                  <Skeleton className="h-12 w-16" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                </div>
              </Card>
            ) : health.error ? (
              <p className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm">
                {health.error}
              </p>
            ) : !health.report ? null : (
              <Card className="p-5">
                <ScoreHeadline report={health.report} compact />
                {worstComponents.length > 0 && (
                  <div className="border-line mt-5 border-t pt-4">
                    <SectionLabel>Weakest components</SectionLabel>
                    <ul className="space-y-2.5">
                      {worstComponents.map((c) => (
                        <li key={c.key}>
                          <div className="mb-1 flex items-baseline gap-3">
                            <span className="text-ink-dim text-body-sm flex-1">{c.label}</span>
                            <span className="text-ink text-body-sm tabular-nums">{c.score}</span>
                            <span className="text-ink-faint text-micro w-20 text-right tabular-nums">
                              +{c.contribution} pts
                            </span>
                          </div>
                          <div className="bg-surface-2 h-1 overflow-hidden rounded-full">
                            <div
                              className={cn(
                                'h-full rounded-full',
                                (c.score ?? 0) >= 80
                                  ? 'bg-pass'
                                  : (c.score ?? 0) >= 50
                                    ? 'bg-flake'
                                    : 'bg-fail',
                              )}
                              style={{ width: `${c.score ?? 0}%` }}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <CardLink href="/insights/health">
                  Take the score apart
                </CardLink>
              </Card>
            )}
          </section>
        </div>
      )}
    </Page>
  );
}
