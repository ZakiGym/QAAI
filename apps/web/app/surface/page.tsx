'use client';

import { useEffect, useState } from 'react';
import { DarkSurface, useDarkSurface } from '../../components/surface/DarkSurface';
import { SECTION_TABS_SLOT_ID } from '../../components/shell/AppShell';
import { useProject } from '../../components/shell/ProjectContext';
import { Page, PageHeader, SectionLabel } from '../../components/ui/layout';
import { AccessAndDrift, useAccessAndDrift } from './AccessAndDrift';

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
 *
 * ── WHY THE AUTHORIZATION, REACHABILITY AND DRIFT FACTS ARE ON THIS SCREEN ──
 *
 * Because they are all facts about the SAME denominator, and each of them can
 * make the number above them untrue without anything looking wrong: an
 * environment nobody can log into has no authenticated surface to count, a
 * matrix nobody probed is not a matrix of allowed cells, and a denominator that
 * has not been re-enumerated since a release is a denominator for an
 * application that no longer exists. Putting them anywhere else would mean a
 * reader could see the percentage without seeing what it is a percentage of,
 * which is the condition this whole section exists to remove.
 */
export default function SurfacePage() {
  const { project, projectId, loading } = useProject();
  const data = useDarkSurface(projectId, loading);

  /*
   * Authorization, reachability and drift are all per ENVIRONMENT, while the
   * dark surface is per project — so this screen needs one more choice than its
   * siblings. Defaulting to the first environment rather than to "none" is
   * deliberate: an unselected picker renders the honest-but-useless "pick an
   * environment" state on a screen somebody opened to read a number.
   */
  const environments = project?.environments ?? [];
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  useEffect(() => {
    setEnvironmentId(environments[0]?.id ?? null);
    // Keyed on the project, not on the array: a re-render that rebuilds the
    // array must not reset a choice the reader made.
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const access = useAccessAndDrift(projectId, environmentId, loading);

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

      <div className="border-line mt-[34px] border-t pt-[26px]">
        <SectionLabel>What this denominator depends on</SectionLabel>
        <p className="text-ink-dim text-row-sub leading-relaxed">
          Three things can make the figure above untrue without looking wrong: an environment
          nothing can sign into, an authorization axis nobody probed, and a crawl nobody repeated
          since the last release. Each one is reported below as a measurement or as an explicit
          absence — never as a zero.
        </p>
        {environments.length > 1 && (
          <label className="text-ink-dim text-row-sub mt-2.5 inline-flex items-baseline gap-2">
            Environment
            <select
              value={environmentId ?? ''}
              onChange={(event) => setEnvironmentId(event.target.value || null)}
              className="border-line bg-surface-1 text-ink text-row-sub rounded-md border px-2 py-1 font-mono"
            >
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name} ({environment.kind.toLowerCase()})
                </option>
              ))}
            </select>
          </label>
        )}
        <AccessAndDrift data={access} />
      </div>
    </Page>
  );
}
