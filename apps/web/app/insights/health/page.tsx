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
  const { projectId, projects, loading: projectLoading } = useProject();
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

  /*
   * Two different reasons there is no report, and telling them apart is the
   * whole of this branch. An org with no apps at all was being told to "pick one
   * in the sidebar" — an instruction it is not possible to follow, because the
   * switcher it names is empty. /repro already makes this distinction; this is
   * the same branch.
   */
  if (!projectId || !report) {
    const noApps = projects.length === 0;
    return (
      <EmptyState
        title={noApps ? 'No app to score yet' : 'No project selected'}
        body={
          noApps
            ? 'Suite health scores the tests QAAI has for an app — how much they assert, how much they duplicate, how much of the critical path they touch. Connect an app and this fills in.'
            : 'Suite health is computed per app. Pick one in the sidebar and this fills in.'
        }
        {...(noApps ? { action: { label: 'Add your app', href: '/onboarding' } } : {})}
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
