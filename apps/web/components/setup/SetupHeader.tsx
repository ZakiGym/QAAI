'use client';

import { SECTION_TABS_SLOT_ID } from '../shell/AppShell';
import { useProject } from '../shell/ProjectContext';
import { PageHeader } from '../ui/layout';

/**
 * The Setup section's title block, shared by all four of its screens.
 *
 * Environments, Source control, Runners and Add app are four routes but one
 * section, and the design gives them one heading — the tab strip is what moves,
 * not the title. Repeating the header per page is how the old app ended up with
 * "Environments", "Source control" and "Infrastructure" as three unrelated
 * screens that happened to sit next to each other in the sidebar.
 *
 * The empty `<div>` is the shell's tab-strip slot: the strip is derived from the
 * route (so Back works and every view stays linkable) but has to be positioned
 * under the page's own title, which only the page knows where to put.
 */
export function SetupHeader({
  title = 'Setup',
  subtitle = 'Where the tests run, and where the code lives.',
  eyebrowTail = 'Setup',
}: {
  title?: string;
  subtitle?: React.ReactNode;
  /** The second half of the eyebrow — `STOREFRONT · GITHUB APP` on the sibling. */
  eyebrowTail?: string;
}) {
  const { project } = useProject();

  return (
    <>
      <PageHeader
        eyebrow={project ? `${project.name} · ${eyebrowTail}` : eyebrowTail}
        title={title}
        subtitle={subtitle}
      />
      {/*
        Empty in React's model — the shell portals the strip in from an effect.
        It must therefore hydrate in the FIRST pass, which is why Add app renders
        this header outside its Suspense boundary: inside one, the shell's effect
        fires while the boundary's content is still waiting to hydrate, the nav
        lands in this node early, and React discards the subtree as a mismatch.
      */}
      <div id={SECTION_TABS_SLOT_ID} />
    </>
  );
}
