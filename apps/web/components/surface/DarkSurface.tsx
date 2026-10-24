'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SurfaceItemCoverage } from '@qaai/shared';
import { api, ApiError } from '../../lib/api';
import { useProject } from '../shell/ProjectContext';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { useToast } from '../ui/Toast';
import { Skeleton } from '../ui/layout';
import {
  DEFAULT_FILTERS,
  formatPercent,
  surfaceQuery,
  type RecomputeResult,
  type StoredSnapshot,
  type SurfaceFilters,
  type SurfaceReport,
  type SurfaceTrend,
} from '../../lib/surface';
import { SurfaceHeadline } from './SurfaceHeadline';
import { SurfaceList } from './SurfaceList';
import { WaiveDialog } from './WaiveDialog';

/**
 * The dark surface — what nothing has ever tested, by name.
 *
 * The screen is deliberately two things in one column: ONE number with its
 * caveats, and then the list. Not a grid of panels. The API returns more than
 * is drawn here on purpose — a panel for every field it offers is how this
 * cockpit got too dense in the first place, and the list is the part a customer
 * forwards to somebody who can act on it.
 *
 * The read never writes. `GET /surface/:id` recomputes without storing, so the
 * figure is always current; storing one is an explicit act (the button in the
 * header), because a snapshot is a claim about a point in time and minting one
 * every time somebody opened a dashboard would fill the trend with duplicates
 * and make a CI gate's delta meaningless.
 */

export interface SurfaceData {
  report: SurfaceReport | null;
  trend: StoredSnapshot[];
  loading: boolean;
  error: string | null;
  filters: SurfaceFilters;
  setFilters: (next: SurfaceFilters) => void;
  reload: () => Promise<void>;
}

/**
 * `projectSettling` is the shell still deciding which project is selected. It
 * has to hold the screen in its loading state — resolving it to "no project"
 * for one frame renders an empty state over a project that is about to arrive.
 */
export function useDarkSurface(projectId: string | null, projectSettling: boolean): SurfaceData {
  const [report, setReport] = useState<SurfaceReport | null>(null);
  const [trend, setTrend] = useState<StoredSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<SurfaceFilters>(DEFAULT_FILTERS);

  const fetchAll = useCallback(async (id: string, query: SurfaceFilters) => {
    const [surface, history] = await Promise.all([
      api<SurfaceReport>(`/surface/${id}?${surfaceQuery(query)}`),
      // The trend is a courtesy — it only exists once somebody has stored a
      // snapshot. Its absence must not take the report down with it.
      api<SurfaceTrend>(`/surface/${id}/trend?limit=30`).catch(() => ({
        projectId: id,
        snapshots: [] as StoredSnapshot[],
      })),
    ]);
    return { surface, snapshots: history.snapshots };
  }, []);

  useEffect(() => {
    if (projectSettling) return;
    if (!projectId) {
      setReport(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Also on a filter change and on a project switch — the previous answer
    // must not sit there looking like it belongs to the new question.
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const { surface, snapshots } = await fetchAll(projectId, filters);
        if (cancelled) return;
        setReport(surface);
        setTrend(snapshots);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not read the surface report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, projectSettling, filters, fetchAll]);

  const reload = useCallback(async () => {
    if (!projectId) return;
    const { surface, snapshots } = await fetchAll(projectId, filters);
    setReport(surface);
    setTrend(snapshots);
  }, [projectId, filters, fetchAll]);

  // Filters are reset on a project switch: a kind filter that made sense for
  // one app silently narrows the next app's denominator.
  useEffect(() => {
    setFilters(DEFAULT_FILTERS);
  }, [projectId]);

  return {
    report,
    trend,
    loading: loading || projectSettling,
    error,
    filters,
    setFilters,
    reload,
  };
}

// ─── The screen ──────────────────────────────────────────────────────────────

export function DarkSurface({ projectId, data }: { projectId: string | null; data: SurfaceData }) {
  const { report, trend, loading, error, filters, setFilters, reload } = data;
  const toast = useToast();
  /*
   * Read here rather than taken as a prop: the empty state below has to tell an
   * org with NO apps apart from one that simply has none selected, and the page
   * passes only the selected id — which is null for both.
   */
  const { projects } = useProject();
  const [waiving, setWaiving] = useState<SurfaceItemCoverage | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  if (loading) return <SurfaceSkeleton />;

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
    const noApps = projects.length === 0;
    return (
      <EmptyState
        title={noApps ? 'No app to read yet' : 'No project selected'}
        body={
          noApps
            ? 'This screen reads your repository and names the routes, endpoints, forms and auth surfaces no test has ever asserted anything about. Connect an app and it fills in.'
            : 'The surface is read per app. Pick one in the sidebar and this fills in.'
        }
        {...(noApps ? { action: { label: 'Add your app', href: '/onboarding' } } : {})}
      />
    );
  }

  const totals = report.snapshot.totals;
  /*
   * Nothing in the inventory at all. The headline says "not measured yet" and
   * why — this adds the one action that changes it, because a screen that
   * explains an empty number and then stops is a dead end.
   */
  const inventoryEmpty = totals.denominator + totals.waived === 0;

  /** Storing a snapshot is what gives a CI gate something to compare against. */
  async function recompute() {
    if (!projectId) return;
    setRecomputing(true);
    try {
      const result = await api<RecomputeResult>(`/surface/${projectId}/recompute`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      toast.success(
        `Snapshot stored at ${formatPercent(result.snapshot.totals.percent)} over ${
          result.snapshot.totals.denominator
        } items.`,
      );
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not store a snapshot');
    } finally {
      setRecomputing(false);
    }
  }

  async function waive(body: { key: string; reason: string; expiresAt?: string }) {
    if (!projectId) return;
    try {
      await api(`/surface/${projectId}/waivers`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (err) {
      /*
       * A waiver names a row in the stored inventory, and the read path never
       * writes one — so on a project nobody has ever recomputed, every row on
       * screen is real and unwaivable. The API's 404 is correct and unreadable;
       * this is what it means.
       */
      if (err instanceof ApiError && err.status === 404) {
        throw new Error(
          'This item is not in the stored inventory yet, so there is nothing to attach a waiver to. Store a snapshot first — the button above the number — then waive it.',
          // The 404 is kept as the cause: the readable sentence is for the
          // dialog, and the status it was inferred from is what a bug report
          // needs.
          { cause: err },
        );
      }
      throw err;
    }
    toast.success('Waiver recorded. The item has left the denominator.');
    await reload();
  }

  async function withdraw(entry: SurfaceItemCoverage) {
    if (!projectId) return;
    setWithdrawing(entry.item.key);
    try {
      // The key holds a colon and slashes, so it travels encoded; Express
      // decodes the param once, which is exactly what the route expects.
      await api(`/surface/${projectId}/waivers/${encodeURIComponent(entry.item.key)}`, {
        method: 'DELETE',
      });
      toast.success('Waiver withdrawn. The item is back in the denominator.');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not withdraw the waiver');
    } finally {
      setWithdrawing(null);
    }
  }

  return (
    <>
      <div className="mb-6 flex justify-end">
        <Button size="sm" loading={recomputing} onClick={() => void recompute()}>
          Store this measurement
        </Button>
      </div>

      <SurfaceHeadline report={report} trend={trend} />

      <div className="mt-10">
        {inventoryEmpty ? (
          <EmptyState
            title="Nothing has been read from this application yet"
            body="The denominator comes from your source — the routes, endpoints, forms and auth surfaces the code declares, whether or not anything has ever reached them. Until the repository has been analysed there is nothing to divide by, which is not the same as being fully covered."
            action={{ label: 'Connect the repository', href: '/source-control' }}
            secondary={{ label: 'Add an app', href: '/onboarding' }}
          />
        ) : (
          <SurfaceList
            report={report}
            filters={filters}
            onFilters={setFilters}
            onWaive={setWaiving}
            onWithdraw={(entry) => void withdraw(entry)}
            withdrawing={withdrawing}
          />
        )}
      </div>

      <WaiveDialog entry={waiving} onClose={() => setWaiving(null)} onSubmit={waive} />
    </>
  );
}

/**
 * Shaped like the answer it stands in for: a headline, a caveat block, then
 * hairline rows. A skeleton of a different shape produces a visible jump on
 * every load, which is the one thing a skeleton exists to prevent.
 */
function SurfaceSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-[22rem] max-w-full" />
      <Skeleton className="mt-3 h-3 w-full max-w-lg" />
      <div className="mt-6 flex gap-7">
        {[0, 1, 2, 3].map((index) => (
          <div key={index}>
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="mt-1.5 h-3 w-20" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-8 h-2.5 w-28" />
      <div className="divide-line mt-2 divide-y" aria-label="Loading" role="status">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="py-3">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="mt-2 h-2.5 w-1/3" />
            <Skeleton className="mt-2 h-2.5 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}
