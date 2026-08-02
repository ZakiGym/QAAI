'use client';

import { useState } from 'react';
import {
  CriticalPaths,
  Duplicates,
  HealthLimits,
  ScoreDecomposition,
  SuiteHealthSkeleton,
  WeakAssertions,
  useSuiteHealth,
} from '../../../components/SuiteHealth';
import { useProject } from '../../../components/shell/ProjectContext';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Page, PageHeader, Tabs } from '../../../components/ui/layout';
import { InsightsTabs } from '../page';

/**
 * Suite health.
 *
 * The decomposed score sits at the top and stays there, because it is the
 * answer and the three lists below are the working. Findings are tabbed rather
 * than stacked so the score is never pushed off screen by a long list of weak
 * assertions — the number and the reason for it belong in the same viewport.
 */
export default function HealthPage() {
  const { projectId, loading: projectLoading } = useProject();
  const { report, loading, error } = useSuiteHealth(projectId, projectLoading);
  const [tab, setTab] = useState<'duplicates' | 'weak' | 'critical'>('weak');

  return (
    <Page width="wide">
      <PageHeader
        title="Suite health"
        subtitle="Is this suite still worth what it costs to run? The score is shown taken apart, because a number nobody can decompose is a number nobody trusts."
      />
      <InsightsTabs active="health" />

      {loading ? (
        <SuiteHealthSkeleton />
      ) : error ? (
        <p className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : !projectId || !report ? (
        <EmptyState
          title="No project selected"
          body="Suite health is computed per app. Pick one in the sidebar and this fills in."
        />
      ) : report.totals.tests === 0 ? (
        <EmptyState
          title="There are no runnable tests to grade"
          body="Suite health scores enabled, non-fixture tests. This project has none yet, so there is no suite to report on — a missing score, not a bad one."
          action={{ label: 'Add tests', href: '/editor' }}
        />
      ) : (
        <>
          <ScoreDecomposition report={report} />

          <div className="mt-8">
            <Tabs
              tabs={[
                { id: 'weak', label: 'Weak assertions', count: report.totals.weakAssertions },
                {
                  id: 'duplicates',
                  label: 'Duplicates',
                  count: report.totals.duplicatePairs + report.totals.duplicateClusters,
                },
                { id: 'critical', label: 'Critical paths', count: report.criticalPaths.length },
              ] as const}
              active={tab}
              onChange={setTab}
            />
            {tab === 'weak' && <WeakAssertions report={report} />}
            {tab === 'duplicates' && <Duplicates report={report} />}
            {tab === 'critical' && <CriticalPaths report={report} />}
          </div>

          <HealthLimits report={report} />
        </>
      )}
    </Page>
  );
}
