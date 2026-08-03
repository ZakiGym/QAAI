'use client';

import { useProject } from '../../components/shell/ProjectContext';
import { SECTION_TABS_SLOT_ID } from '../../components/shell/AppShell';
import { Page, PageHeader } from '../../components/ui/layout';

/**
 * One header for all three insights views.
 *
 * Coverage, suite health and impact are three answers to the same question —
 * what does this suite actually know about this app — and the redesign says so
 * by giving them one title and a tab strip rather than three page headings that
 * happen to sit next to each other. A layout rather than a shared component
 * because it also means the header does not remount when you move between the
 * tabs: the title holds still and only the answer under it changes.
 *
 * The strip itself belongs to the shell (it is derived from the route, so Back
 * works and every tab stays linkable); this only says where on the page it goes.
 */
export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  const { project } = useProject();

  return (
    <Page width="insights">
      <PageHeader
        // Which app these numbers are about. Every screen in this section makes
        // a claim about a specific suite, and the sidebar's project switcher is
        // easy to miss.
        eyebrow={`${project?.name ?? 'No app'} · Insights`}
        title="Insights"
        subtitle="What nobody tested, whether the tests are worth running, and which of them a diff needs."
      />
      <div id={SECTION_TABS_SLOT_ID} />
      <div className="mt-[26px]">{children}</div>
    </Page>
  );
}
