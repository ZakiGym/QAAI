'use client';

import { CoverageGaps, useCoverage } from '../../../components/CoverageGaps';
import { useProject } from '../../../components/shell/ProjectContext';

/**
 * Coverage gaps.
 *
 * The title, the subtitle and the tab strip belong to the section and live in
 * the layout; everything below them is this answer. The page is deliberately
 * thin — all of the judgement is in the component, and the hook that fetches
 * the report is exported from there so nothing else has to know the endpoint.
 */
export default function CoveragePage() {
  const { projectId, loading: projectLoading } = useProject();
  const data = useCoverage(projectId, projectLoading);

  return <CoverageGaps projectId={projectId} data={data} />;
}
