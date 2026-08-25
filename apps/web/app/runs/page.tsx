'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Project, type Run } from '../../lib/api';
import { relativeTime } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/Toast';
import { Page, PageHeader } from '../../components/ui/layout';
import { Fleet } from '../../components/runs/Fleet';
import { NeedsYou, type FlakyTest } from '../../components/runs/NeedsYou';
import { RunLog, matchesFilter, type StatusFilter } from '../../components/runs/RunLog';
import { StatsBand } from '../../components/runs/StatsBand';
import { TERMINAL_RUN, type RunRow } from '../../components/runs/format';

/**
 * Runs home — the merge of /runs and /dashboard.
 *
 * The two screens were the same data twice, twelve sidebar rows apart: a fleet
 * rollup on one, the run log on the other, and no way to see a rate next to the
 * runs it was a rate over. /dashboard now redirects here and its aggregates are
 * the stats band at the top.
 *
 * Everything on the page comes from two lists — projects and the last hundred
 * runs — plus three cheap counts for NEEDS YOU. No endpoint was added; the
 * numbers the design shows that the API does not return are derived here or not
 * shown at all.
 */

// ─── Parallelism ─────────────────────────────────────────────────────────────

/** Only the parts of GET /billing this page needs: the ceiling, and its name. */
interface PlanCap {
  plan: string;
  limits: { label: string; maxParallelWorkers: number };
}

/** What the API answered when asked to split — reported whether or not it could. */
interface ShardingReport {
  requested: number;
  granted: number;
  cappedBy: 'plan' | 'tests' | null;
  maxParallelWorkers: number;
}

/**
 * The counts offered in the picker.
 *
 * A ladder rather than 1…N: the ceiling is 50 on the top plan, and a fifty-item
 * dropdown is not a choice, it is a list. Every rung a plan actually allows is
 * on it, and the ceiling itself is always offered even if it lands off-ladder.
 */
const SHARD_LADDER = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];

function shardOptionsFor(max: number): number[] {
  const rungs = SHARD_LADDER.filter((n) => n <= max);
  return rungs.includes(max) ? rungs : [...rungs, max];
}

/**
 * What actually happened, said plainly.
 *
 * The endpoint clamps a request to what the plan and the suite allow, and a
 * user who asked for eight workers and got five must be told that here — the
 * alternative is learning it from a wall clock that did not improve as much as
 * expected, which is a terrible way to find out what you are paying for.
 */
function describeSharding(report: ShardingReport | undefined, planLabel: string | null): string {
  // Reported even when the answer is "it could not be split at all", because a
  // request that quietly became one shard is the case worth naming.
  if (!report) return 'Run queued.';
  if (report.granted < 2) {
    return report.cappedBy === 'plan'
      ? `Run queued on one worker. Your ${planLabel ?? 'current'} plan does not include parallel workers.`
      : 'Run queued on one worker — there is only one test to run.';
  }

  const across = `Run queued across ${report.granted} shards.`;
  if (report.cappedBy === 'plan') {
    return `${across} You asked for ${report.requested}; your ${planLabel ?? 'current'} plan allows ${report.maxParallelWorkers} parallel workers.`;
  }
  if (report.cappedBy === 'tests') {
    return `${across} You asked for ${report.requested}, and the suite only has ${report.granted} tests to fill them.`;
  }
  return across;
}

// ─── The page ────────────────────────────────────────────────────────────────

export default function RunsPage() {
  const router = useRouter();
  const toast = useToast();
  const { project, projectId, setProjectId, loading: projectLoading } = useProject();

  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [environmentId, setEnvironmentId] = useState<string | null>(null);

  // NEEDS YOU and two cells of the band. Null means "not asked yet", which the
  // components render as absence rather than as zero.
  const [pendingVerdicts, setPendingVerdicts] = useState<number | null>(null);
  const [heals, setHeals] = useState<number | null>(null);
  const [flaky, setFlaky] = useState<FlakyTest[]>([]);

  /**
   * The org's parallel-worker ceiling, or null while we do not know it.
   *
   * Null hides the picker entirely, and that is the fail-safe direction: if
   * /billing is slow or unreachable, the page keeps working and every run
   * behaves exactly as it did before this control existed. Offering a choice we
   * cannot honour would be worse than not offering one.
   */
  const [planCap, setPlanCap] = useState<PlanCap | null>(null);
  const [shardCount, setShardCount] = useState(1);

  // Both collections initialise to `[]`, so without this the empty state — "No
  // runs yet" — is what renders during the very first fetch, telling the user
  // there is nothing there before we know. Only the first load shows skeletons;
  // the poll refreshes in place.
  const [loading, setLoading] = useState(true);

  /** A clock, so a run in flight counts up between polls rather than freezing. */
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        api<{ projects: Project[] }>('/projects'),
        // Unfiltered and deep: the fleet tiles need every project's health, and
        // the stats band needs enough history to mean something. One request
        // feeds both, and the log is scoped to the selected project below.
        api<{ runs: RunRow[] }>('/runs?limit=100'),
      ]);
      setProjects(p.projects);
      setRuns(r.runs);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load runs');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
    // A run in flight changes state without any user action, so the list polls.
    // Cheap, and it means the page is never stale for more than a few seconds.
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  /*
   * The three NEEDS YOU counts, on their own slower timer.
   *
   * Each has its own catch so one failing endpoint cannot blank the other two,
   * and none of them can take the run log down — a to-do list that 500s must
   * still leave you looking at your runs.
   */
  useEffect(() => {
    let cancelled = false;

    const loadSignals = async () => {
      /*
       * Two counts from ONE request that counts, instead of two that returned
       * lists.
       *
       * This used to fetch `/verdicts?state=PENDING` and `/heals` in full —
       * up to a hundred triage verdicts and the whole heals payload twice
       * over — every fifteen seconds, from every open tab, to render two
       * numbers. `/badges` answers with the numbers.
       */
      try {
        const badges = await api<{ verdicts: number; heals: number }>('/badges');
        if (!cancelled) {
          setPendingVerdicts(badges.verdicts);
          setHeals(badges.heals);
        }
      } catch {
        /* keep whatever the last good answer was */
      }
      if (!projectId) return;
      try {
        const { tests } = await api<{ tests: FlakyTest[] }>(`/projects/${projectId}/flaky`);
        if (!cancelled) setFlaky(tests);
      } catch {
        if (!cancelled) setFlaky([]);
      }
    };

    /*
     * Paused while the tab is hidden, and refreshed the moment it comes back.
     *
     * A background tab polling every fifteen seconds is load nobody is reading.
     * Refreshing on `visibilitychange` is what keeps that honest: the numbers
     * you look at are fetched when you look, so pausing costs freshness only
     * while there is nobody to be stale for.
     */
    const tick = () => {
      if (document.visibilityState === 'visible') void loadSignals();
    };
    void loadSignals();
    const timer = setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [projectId]);

  // Fetched once and kept out of the poll: a plan does not change every four
  // seconds, and a billing hiccup must not take the runs list down with it.
  useEffect(() => {
    let live = true;
    api<PlanCap>('/billing')
      .then((billing) => {
        if (live) setPlanCap(billing);
      })
      .catch(() => {
        /* the picker simply stays hidden; runs still start */
      });
    return () => {
      live = false;
    };
  }, []);

  const scoped = useMemo(
    // Before the shell settles on a project there is nothing to scope to, and
    // showing every project's runs for a frame is less wrong than showing none.
    () => (projectId ? runs.filter((run) => run.projectId === projectId) : runs),
    [runs, projectId],
  );

  const live = scoped.some((run) => !TERMINAL_RUN.has(run.status));
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // The environment the header's Run suite targets. Defaults to the project's
  // first, and resets when the selected project changes under it — a stale id
  // from another app would start a run against the wrong URL.
  const environments = project?.environments ?? [];
  const environment =
    environments.find((env) => env.id === environmentId) ?? environments[0] ?? null;
  useEffect(() => setEnvironmentId(null), [projectId]);

  const counts = useMemo<Record<StatusFilter, number>>(
    () => ({
      all: scoped.length,
      failed: scoped.filter((run) => matchesFilter(run, 'failed')).length,
      passed: scoped.filter((run) => matchesFilter(run, 'passed')).length,
      running: scoped.filter((run) => matchesFilter(run, 'running')).length,
    }),
    [scoped],
  );

  const selectedProject = projects.find((p) => p.id === projectId) ?? null;
  const runnable = (selectedProject?._count.tests ?? 0) > 0;
  const maxWorkers = planCap?.limits.maxParallelWorkers ?? 1;

  async function startRun() {
    if (!environment || starting) return;
    setStarting(true);
    try {
      const { run, sharding } = await api<{ run: Run; sharding?: ShardingReport }>('/runs', {
        method: 'POST',
        body: JSON.stringify({
          environmentId: environment.id,
          trigger: 'MANUAL',
          // Omitted, not sent as 1: a body without `shards` takes the exact
          // path every manual run took before this control existed.
          ...(shardCount > 1 ? { shards: shardCount } : {}),
        }),
      });
      toast.success(describeSharding(sharding, planCap?.limits.label ?? null), {
        label: 'View it',
        run: () => router.push(`/runs/${run.id}`),
      });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start the run';
      setError(message);
      toast.error(message);
    } finally {
      setStarting(false);
    }
  }

  const eyebrow = [project?.name, environment?.name].filter(Boolean).join(' · ') || 'ALL APPS';

  return (
    <Page width="runs">
      {error && (
        <p
          role="alert"
          className="border-fail/40 text-fail mb-6 rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_10%,transparent)] p-3 text-body-sm"
        >
          {error}
        </p>
      )}

      <PageHeader
        eyebrow={eyebrow}
        title="Runs"
        subtitle={
          <StatusSentence
            runs={scoped}
            loading={loading || projectLoading}
            runnable={runnable}
            projectName={selectedProject?.name ?? null}
          />
        }
        className="mb-0"
        actions={
          <>
            {/* Two identical selects rather than one: the design shows the shard
                picker alone because its mock project has one environment, and a
                Run button that cannot say which environment it targets is the
                kind of control people press once. */}
            {environments.length > 1 && (
              <select
                aria-label="Environment to run against"
                value={environment?.id ?? ''}
                onChange={(e) => setEnvironmentId(e.target.value)}
                className="border-line text-ink-dim rounded-md border bg-transparent px-2 py-[7px] text-[12.5px]"
              >
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </select>
            )}

            {planCap && (
              <select
                aria-label="Split the suite across parallel workers"
                value={shardCount}
                disabled={maxWorkers < 2}
                onChange={(e) => setShardCount(Number(e.target.value))}
                title={
                  maxWorkers < 2
                    ? `Your ${planCap.limits.label} plan runs one worker at a time, so a suite cannot be split.`
                    : `Up to ${maxWorkers} parallel workers on your ${planCap.limits.label} plan. Tests are divided by how long they recently took, so each shard finishes at about the same time.`
                }
                className="border-line text-ink-dim rounded-md border bg-transparent px-2 py-[7px] text-[12.5px] tabular-nums disabled:cursor-not-allowed disabled:opacity-50"
              >
                {shardOptionsFor(maxWorkers).map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? '1 shard' : `${n} shards`}
                  </option>
                ))}
              </select>
            )}

            {/*
              A project with no tests cannot run anything, and this button was a
              trap: it was enabled, it was the only enabled control on a new
              user's first screen, and pressing it produced a toast explaining
              there were no tests. The app knew the answer before the click. The
              reason is on the control now, and the plan is offered beside it.
            */}
            {!runnable && selectedProject && (
              <Link
                href={`/projects/${selectedProject.id}/plan`}
                className="bg-accent text-accent-ink text-row-sub rounded-md px-3.5 py-[7px] font-semibold transition-opacity hover:opacity-90"
              >
                Review the test plan →
              </Link>
            )}
            <Button
              variant={runnable ? 'primary' : 'secondary'}
              loading={starting}
              disabled={!runnable || !environment}
              onClick={() => void startRun()}
              title={
                runnable
                  ? environment
                    ? `Run the suite against ${environment.name}`
                    : 'This app has no environment to run against yet.'
                  : `${selectedProject?.name ?? 'This app'} has no tests yet — approve its plan first.`
              }
            >
              Run suite
            </Button>
          </>
        }
      />

      <StatsBand
        runs={scoped}
        pendingVerdicts={pendingVerdicts}
        quarantined={projectId ? flaky.filter((t) => t.quarantined).length : null}
        loading={loading}
        now={now}
      />

      <NeedsYou
        pendingVerdicts={pendingVerdicts}
        latestFailure={scoped.find((r) => r.status === 'FAILED' || r.status === 'ERRORED') ?? null}
        heals={heals}
        flaky={flaky}
        loading={loading}
      />

      <Fleet
        projects={projects}
        runs={runs}
        selectedId={projectId}
        onSelect={setProjectId}
        loading={loading}
      />

      <RunLog
        runs={scoped}
        filter={filter}
        onFilter={setFilter}
        counts={counts}
        loading={loading}
        now={now}
        hasProjects={projects.length > 0}
      />
    </Page>
  );
}

/**
 * The sentence under the title: where the suite stands, in words.
 *
 * The design's version — "Gate red on production since 21:38 UTC. Nightly at
 * 02:00. Last green on staging 1h ago." — is three facts, and every one of them
 * is in the runs array. A clause with no data behind it is dropped rather than
 * filled in, so a new account gets one true sentence instead of three
 * confident-sounding blanks.
 */
function StatusSentence({
  runs,
  loading,
  runnable,
  projectName,
}: {
  runs: Run[];
  loading: boolean;
  runnable: boolean;
  projectName: string | null;
}) {
  if (loading) return <span className="text-ink-faint">Reading the last hundred runs…</span>;

  if (!runnable) {
    return (
      <>
        {projectName ?? 'This app'} has no tests yet, so there is nothing to run. Approve a test plan
        and the Generator writes them.
      </>
    );
  }
  if (runs.length === 0) {
    return <>No runs yet. The first one fills this page in — the stats, the fleet and the log.</>;
  }

  const inFlight = runs.filter((r) => r.status === 'RUNNING' || r.status === 'QUEUED');
  const latestRed = runs.find((r) => r.status === 'FAILED' || r.status === 'ERRORED');
  const latestGreen = runs.find((r) => r.status === 'PASSED');

  const clauses: string[] = [];
  if (inFlight.length > 0) {
    clauses.push(
      `${inFlight.length} ${inFlight.length === 1 ? 'run' : 'runs'} in flight on ${inFlight[0]!.environment.name}.`,
    );
  }
  if (latestRed) {
    clauses.push(`Red on ${latestRed.environment.name} since ${relativeTime(latestRed.queuedAt)}.`);
  }
  if (latestGreen) {
    clauses.push(
      `Last green on ${latestGreen.environment.name} ${relativeTime(latestGreen.queuedAt)}.`,
    );
  }
  if (clauses.length === 0) clauses.push('Nothing has finished yet.');

  return <>{clauses.join(' ')}</>;
}
