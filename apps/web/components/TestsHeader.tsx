'use client';

import { SECTION_TABS_SLOT_ID } from './shell/AppShell';
import { useProject } from './shell/ProjectContext';
import { PageHeader } from './ui/layout';

/**
 * The masthead the five Tests screens share.
 *
 * The tab strip is the shell's — it is derived from the route so that Back
 * works and every view stays linkable — but it belongs UNDER the section title,
 * which only a page can place. The empty div is the portal target the shell
 * looks for; without it the strip draws itself at the top of the column, above
 * the heading it is supposed to sit beneath.
 *
 * `detail` is whatever that screen can honestly say about the app in a mono
 * eyebrow — the editor knows the file count, the flow map knows the state
 * count, the rest know nothing extra and say nothing extra.
 */
export function TestsHeader({ detail, className }: { detail?: string; className?: string }) {
  const { project } = useProject();

  return (
    <div className={className ?? 'shrink-0 px-10 pt-8'}>
      <PageHeader
        className="mb-0"
        size="sm"
        title="Tests"
        eyebrow={[project?.name, detail].filter(Boolean).join(' · ')}
      />
      <div id={SECTION_TABS_SLOT_ID} className="mt-[18px]" />
    </div>
  );
}
