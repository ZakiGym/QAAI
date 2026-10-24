'use client';

import { DarkSurface, useDarkSurface } from '../../components/surface/DarkSurface';
import { SECTION_TABS_SLOT_ID } from '../../components/shell/AppShell';
import { useProject } from '../../components/shell/ProjectContext';
import { Page, PageHeader } from '../../components/ui/layout';

/**
 * The dark-surface screen.
 *
 * Deliberately thin, like /insights/coverage: the title and the section's tab
 * strip belong to the shell, and all of the judgement is in the component. The
 * hook that reads the endpoint is exported from there so nothing else has to
 * know the URL.
 *
 * It sits at /surface rather than under /insights/ because it is the one answer
 * in this product whose denominator comes from the source rather than from a
 * crawl — but it is listed as an Insights tab, so the header and the strip are
 * reproduced here to match its siblings rather than inherited from their layout.
 */
export default function SurfacePage() {
  const { project, projectId, loading } = useProject();
  const data = useDarkSurface(projectId, loading);

  return (
    <Page width="insights">
      <PageHeader
        // Which app this is a claim about. Every screen in this section says
        // something specific about one suite, and the project switcher in the
        // sidebar is easy to miss.
        eyebrow={`${project?.name ?? 'No app'} · Insights`}
        title="Dark surface"
        subtitle="The parts of your application no test has ever asserted anything about — read from your source, so it includes the ones a crawl can never reach."
      />
      <div id={SECTION_TABS_SLOT_ID} />
      <div className="mt-[26px]">
        <DarkSurface projectId={projectId} data={data} />
      </div>
    </Page>
  );
}
