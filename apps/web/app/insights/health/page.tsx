'use client';

import {
  DuplicationAndCriticalPaths,
  HealthLimits,
  NoRunnableTests,
  ScoreDecomposition,
  SuiteHealthSkeleton,
  WeakAssertions,
  useSuiteHealth,
} from '../../../components/SuiteHealth';
import { useProject } from '../../../components/shell/ProjectContext';
import { EmptyState } from '../../../components/ui/EmptyState';

/**
 * Suite health.
 *
 * The decomposed score leads and everything under it is the working: the
 * findings that dragged assertion strength down, then duplication and
 * critical-path coverage as one sentence each with their own evidence a click
 * away. Nothing sits behind a tab any more — the number and the reason for it
 * belong in the same viewport, and three tab bodies could not all be there.
 */
export default function HealthPage() {
  const { projectId, loading: projectLoading } = useProject();
  const { report, loading, error } = useSuiteHealth(projectId, projectLoading);

  if (loading) return <SuiteHealthSkeleton />;

  if (error) {
    return (
      <p
        role="alert"
        className="border-fail/40 text-fail text-body-sm rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3"
      >
        {error}
      </p>
    );
  }

  if (!projectId || !report) {
    return (
      <EmptyState
        title="No project selected"
        body="Suite health is computed per app. Pick one in the sidebar and this fills in."
      />
    );
  }

  if (report.totals.tests === 0) return <NoRunnableTests />;

  return (
    <>
      <ScoreDecomposition report={report} />
      <WeakAssertions report={report} />
      <DuplicationAndCriticalPaths report={report} />
      <HealthLimits report={report} />
    </>
  );
}
