'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API_URL, api, type Run } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { StatusDot } from '../../../components/ui';
import { Button } from '../../../components/ui/Button';
import { Skeleton } from '../../../components/ui/layout';
import { useToast } from '../../../components/ui/Toast';
import type { EvidenceResult } from '../../../components/EvidenceRail';
import { CauseRail } from '../../../components/runs/CauseRail';
import { FailureStory } from '../../../components/runs/FailureStory';
import { TriageRail } from '../../../components/runs/TriageRail';
import { wallClock } from '../../../components/runs/format';
import { usePaletteCommands } from '../../../components/shell/PaletteCommands';

/**
 * The cockpit.
 *
 * Three columns, and the left one changed what it is. It used to be the suite —
 * one row per test — which is the right shape for a run with three results and
 * the wrong one for a red build with 128. It is now the CAUSES: six failures,
 * three causes, and a representative of each, from GET /clusters/run/:id.
 *
 * Middle is the failure story for the selected test; right is the triage rail,
 * scoped to the selected step. Selecting a cause selects its first member and
 * that member's failing step, so one click lands on the evidence rather than on
 * a name.
 */

/**
 * Turning a stream event into a line a person can read.
 *
 * This pane used to render `step {"testId":"cms6vrt5i0003…","index":1,…}` —
 * the raw event payload, straight from the wire. It is the one part of the app
 * a user watches while they wait, and it was showing them our internal schema.
 *
 * Returning null drops an event rather than printing a placeholder for it: an
 * unnamed frame adds noise to the only surface where noise actually costs
 * something, because the whole point is to glance at it and know what is
 * happening.
 */
interface LiveLine {
  text: string;
  tone: string;
}

// ─── Shards ──────────────────────────────────────────────────────────────────

/**
 * `GET /runs/:id` has returned `shards` since sharding shipped; the shared `Run`
 * interface in lib/api.ts — which this page does not own — never described
 * them, which is most of the reason a split run has looked exactly like an
 * unsplit one. Declared here so the strip below is typed; they belong in
 * lib/api.ts next time that file is opened.
 */
type RunShardStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED';

interface RunShard {
  id: string;
  index: number;
  total: number;
  status: RunShardStatus;
  testCount: number;
  /** What the packer predicted this slice would cost, in ms. */
  estimatedMs: number;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  skippedCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
}

/**
 * `results` is re-typed to `EvidenceResult`, which is the same row plus the
 * three columns the API has always returned and lib/api.ts never described:
 * `network`, `consoleLog` and each step's `startedAt` / `errorStack`. Those are
 * what the triage rail correlates against; see components/EvidenceRail.tsx.
 */
type ShardedRun = Omit<Run, 'results'> & {
  shardCount?: number;
  shards?: RunShard[];
  results?: EvidenceResult[];
};

/**
 * Kept in sync with RUN_SHARD_TERMINAL in @qaai/shared. Duplicated as a plain
 * list rather than imported, because that package ships source TS and the web
 * build has no transpilePackages entry for it.
 *
 * This is the definition the whole feature rests on: a run is finished when
 * every shard is in this set, and never before.
 */
const SHARD_TERMINAL = new Set<RunShardStatus>(['COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED']);

const SHARD_STATUS_LABEL: Record<RunShardStatus, string> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'done',
  FAILED: 'died',
  CANCELLED: 'cancelled',
  // The word matters: an abandoned shard did not fail its tests, it never ran
  // them, and those tests are sitting at their placeholder status right now.
  ABANDONED: 'never ran',
};

/**
 * The dot for a shard.
 *
 * A shard's own status says whether the worker got through its slice, not
 * whether the tests in it passed — COMPLETED with four failures is a completed
 * shard. So a shard that finished cleanly is coloured by its counts, and the
 * error colour is kept for a slice whose tests did not run at all.
 */
function shardDotStatus(shard: RunShard): string {
  switch (shard.status) {
    case 'COMPLETED':
      if (shard.failedCount > 0) return 'FAILED';
      return shard.flakyCount > 0 ? 'FLAKY' : 'PASSED';
    case 'FAILED':
    case 'ABANDONED':
      return 'ERRORED';
    default:
      return shard.status;
  }
}

/** Elapsed for a shard. A finished one is fixed; a running one is still counting. */
function shardElapsedMs(shard: RunShard, now: number): number | null {
  if (!shard.startedAt) return null;
  const end = shard.finishedAt ? new Date(shard.finishedAt).getTime() : now;
  return Math.max(0, end - new Date(shard.startedAt).getTime());
}

function describeEvent(label: string, data: Record<string, unknown>): LiveLine | null {
  const str = (key: string): string | null =>
    typeof data[key] === 'string' ? (data[key] as string) : null;
  const num = (key: string): number | null =>
    typeof data[key] === 'number' ? (data[key] as number) : null;

  switch (label) {
    case 'test.started': {
      const name = str('name');
      return name ? { text: `Running ${name}`, tone: 'bg-accent' } : null;
    }
    case 'test.finished': {
      const name = str('name');
      const status = str('status');
      if (!name || !status) return null;
      const ms = num('durationMs');
      const took = ms === null ? '' : ms >= 1000 ? ` · ${(ms / 1000).toFixed(1)}s` : ` · ${ms}ms`;
      const passed = status === 'PASSED';
      return {
        text: `${passed ? 'Passed' : status === 'SKIPPED' ? 'Skipped' : 'Failed'}: ${name}${took}`,
        tone: passed ? 'bg-pass' : status === 'SKIPPED' ? 'bg-skip' : 'bg-fail',
      };
    }
    case 'step': {
      // Step titles are what the test actually did — "Click Add to cart" — and
      // are the most useful thing in the stream.
      const title = str('title');
      if (!title) return null;
      const status = str('status');
      return {
        text: title,
        tone: status === 'FAILED' ? 'bg-fail' : status === 'PASSED' ? 'bg-pass' : 'bg-skip',
      };
    }
    case 'verdict': {
      const verdict = str('verdict');
      return verdict
        ? { text: `Triaged as ${verdict.toLowerCase().replace(/_/g, ' ')}`, tone: 'bg-flake' }
        : null;
    }
    // Five workers interleaving their test lines is confusing without something
    // saying how many there are and when each one is done.
    case 'shard.started': {
      const index = num('shard');
      const total = num('shards');
      const tests = num('tests');
      if (index === null || total === null) return null;
      return {
        text: `Shard ${index} of ${total} started${tests === null ? '' : ` · ${tests} tests`}`,
        tone: 'bg-accent',
      };
    }
    case 'shard.finished': {
      const index = num('shard');
      const total = num('shards');
      if (index === null || total === null) return null;
      if (data.errored === true) {
        return { text: `Shard ${index} of ${total} did not complete`, tone: 'bg-fail' };
      }
      const failed = num('failed') ?? 0;
      return {
        text: `Shard ${index} of ${total} finished${failed > 0 ? ` · ${failed} failed` : ''}`,
        tone: failed > 0 ? 'bg-fail' : 'bg-pass',
      };
    }
    case 'run.finished':
      return { text: 'Run finished', tone: 'bg-accent' };
    default:
      return null;
  }
}

/** A run in one of these states will never emit another event. */
const TERMINAL = new Set(['PASSED', 'FAILED', 'ERRORED', 'CANCELLED']);

/** `21:38 UTC` — the one absolute time on the screen, so shifts can be compared. */
function startedAtLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export default function CockpitPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);

  const router = useRouter();
  const [run, setRun] = useState<ShardedRun | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [live, setLive] = useState<LiveLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  /**
   * Live progress from test.started events, kept per shard.
   *
   * This used to be one `{done, total}`, which was right for one worker and a
   * lie for five: the worker scopes index/total to the slice it is executing,
   * so on a sharded run each shard reports "3 of 8" about a different eighth of
   * the suite and the last event to land overwrote the rest — a 40-test run
   * cheerfully announcing "3 of 8". Keyed by shard index (`-1` for the single
   * worker of an unsharded run) the parts add up to a number about the run.
   */
  const [doneByShard, setDoneByShard] = useState<Record<number, number>>({});
  const [suiteTotal, setSuiteTotal] = useState<number | null>(null);
  /**
   * A clock, so elapsed time counts up between events rather than freezing on
   * whatever the last refetch happened to catch. Only ticks while there is
   * something to tick for.
   */
  const [now, setNow] = useState(() => Date.now());
  const toast = useToast();

  /**
   * Re-run the exact same tests against the same environment. Passing the
   * original test ids rather than the whole project means "re-run" reproduces
   * what you were just looking at, even if it was a subset.
   */
  async function rerun() {
    if (!run || rerunning) return;
    setRerunning(true);
    try {
      const { run: fresh } = await api<{ run: { id: string } }>('/runs', {
        method: 'POST',
        body: JSON.stringify({
          environmentId: run.environmentId,
          testIds: run.results?.map((r) => r.test.id) ?? null,
          trigger: 'MANUAL',
        }),
      });
      router.push(`/runs/${fresh.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the re-run');
      setRerunning(false);
    }
  }

  /**
   * Stop the run.
   *
   * The API writes the status and the worker notices between tests, so this is
   * not instant. The toast says which of the two happened rather than implying
   * the run halted on the spot — otherwise the next thing the user does is
   * click Cancel three more times.
   */
  async function cancel() {
    if (!run || cancelling) return;
    setCancelling(true);
    try {
      const { stopsAfterCurrentTest } = await api<{ stopsAfterCurrentTest: boolean }>(
        `/runs/${runId}/cancel`,
        { method: 'POST' },
      );
      toast.success(
        stopsAfterCurrentTest
          ? 'Cancelling — the test already running will finish first.'
          : 'Run cancelled before it started.',
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel the run');
    } finally {
      setCancelling(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const { run } = await api<{ run: ShardedRun }>(`/runs/${runId}`);
      setRun(run);
      setError(null);
      return run;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the run');
      return null;
    }
  }, [runId]);

  useEffect(() => {
    void load().then((loaded) => {
      if (!loaded || selectedTestId) return;
      // Open on the first failure, and on its failing step — that is what the
      // person came to look at, and making them click twice to see the evidence
      // is the difference between a triage tool and a log viewer.
      const failing = loaded.results?.find((r) => r.status !== 'PASSED' && r.status !== 'SKIPPED');
      const target = failing ?? loaded.results?.[0];
      setSelectedTestId(target?.test.id ?? null);
      setSelectedStep(target?.steps.find((s) => s.status === 'FAILED')?.index ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Live events while the run is in flight; the stream closes itself when the
  // run reaches a terminal state, and a final reload picks up the verdicts.
  useEffect(() => {
    if (!run || TERMINAL.has(run.status)) {
      return;
    }
    const source = new EventSource(`${API_URL}/runs/${runId}/events`, { withCredentials: true });

    const record = (label: string) => (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as { data: Record<string, unknown> };
        const line = describeEvent(label, parsed.data);
        if (line) setLive((prev) => [line, ...prev].slice(0, 60));

        /*
         * The worker stamps index/total on test.started so the header can say
         * "4 of 11". index is 0-based and names the test about to run, so the
         * count of finished tests is the index itself.
         *
         * On a sharded run those two are the emitting shard's own slice — five
         * workers cannot share one counter without a round trip per test — and
         * `runTotal` carries the size of the whole suite. So the index is
         * banked against the shard that reported it and only the totals speak
         * for the run.
         */
        const { index, total, shard, runTotal } = parsed.data as {
          index?: number;
          total?: number;
          shard?: number;
          runTotal?: number;
        };
        if (label === 'test.started' && typeof index === 'number') {
          const key = typeof shard === 'number' ? shard : -1;
          setDoneByShard((prev) => (prev[key] === index ? prev : { ...prev, [key]: index }));
          const forRun = typeof runTotal === 'number' ? runTotal : total;
          if (typeof forRun === 'number') setSuiteTotal(forRun);
        }
      } catch {
        /* a malformed frame is not worth surfacing */
      }
      void load();
    };

    for (const type of [
      'test.started',
      'test.finished',
      'step',
      'verdict',
      'shard.started',
      'shard.finished',
      'run.finished',
    ]) {
      source.addEventListener(type, record(type));
    }
    return () => source.close();
  }, [run?.status, runId, load, run]);

  /*
   * The elapsed clock. Bound to the run's status so it stops the moment there is
   * nothing moving — a finished run must not hold a timer open for as long as
   * the tab is.
   */
  const ticking = run !== null && !TERMINAL.has(run.status);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  /*
   * ── The cockpit's own ⌘K commands ──────────────────────────────────────
   *
   * Registered here, above the early returns, because hooks cannot be
   * conditional — and gated on real state, so nothing is offered that this run
   * cannot service. `Open the trace` in particular exists only when a result
   * actually kept one; offering it otherwise would send a person to a screen
   * whose whole content is an apology.
   */
  const paletteRun = run;
  const paletteTrace =
    paletteRun?.results?.find(
      (r) => r.traceKey && r.status !== 'PASSED' && r.status !== 'SKIPPED',
    ) ??
    paletteRun?.results?.find((r) => r.traceKey) ??
    null;
  const paletteInFlight = paletteRun?.status === 'RUNNING' || paletteRun?.status === 'QUEUED';

  usePaletteCommands(
    'cockpit',
    () => {
      if (!paletteRun) return [];
      const items = [
        {
          id: 'run:compare',
          label: 'Compare this run with the previous one',
          detail: 'is this failure new?',
          group: 'This run',
          run: () => router.push(`/runs/${paletteRun.id}/compare`),
        },
      ];
      if (paletteTrace) {
        items.push({
          id: 'run:trace',
          label: 'Open the trace',
          detail: 'DOM, network and console per action',
          group: 'This run',
          run: () => router.push(`/runs/${paletteRun.id}/trace?result=${paletteTrace.id}`),
        });
      }
      if (paletteInFlight) {
        items.push({
          id: 'run:cancel',
          label: 'Cancel this run',
          detail: 'stops after the current test',
          group: 'This run',
          run: () => void cancel(),
        });
      } else {
        items.push({
          id: 'run:rerun',
          label: 'Re-run these tests',
          detail: 'same tests, same environment',
          group: 'This run',
          run: () => void rerun(),
        });
      }
      return items;
    },
    [paletteRun?.id, paletteTrace?.id, paletteInFlight, router],
  );

  if (error) {
    return (
      <main className="p-10">
        <p className="text-fail text-body-sm" role="alert">
          {error}
        </p>
        <Link href="/runs" className="text-accent mt-4 inline-block text-body-sm hover:underline">
          Back to runs
        </Link>
      </main>
    );
  }
  if (!run) return <CockpitSkeleton />;

  const inFlight = run.status === 'RUNNING' || run.status === 'QUEUED';
  const results = run.results ?? [];

  /*
   * A failure that has not been triaged yet.
   *
   * The default gate is BLOCK_ON_VERDICT REAL_BUG, so it is scored against
   * verdicts — and a failure with no verdict is not a REAL_BUG verdict, so it
   * finds nothing to block on and the gate comes back `passed: true`. On a run
   * with real failures that renders a green "gate pass" beside "2 failed",
   * which is the one thing this screen must never do.
   *
   * The run processor's own docstring says a run whose triage is in flight
   * "reports its gate as provisional"; nothing ever implemented that word. This
   * is it, on the surface where it is read. The gate value is not altered —
   * GitHub's check conclusion already treats an un-triaged failure as
   * actionable and fails — only the claim the badge makes about it.
   */
  const awaitingTriage = results.some(
    (r) => r.status !== 'PASSED' && r.status !== 'SKIPPED' && !r.verdict,
  );
  const selected = results.find((r) => r.test.id === selectedTestId) ?? results[0] ?? null;
  const step = selected?.steps.find((s) => s.index === selectedStep) ?? null;

  // Empty on every run that was not split, which is most of them.
  const shards = run.shards ?? [];
  const pendingShards = shards.filter((s) => !SHARD_TERMINAL.has(s.status));
  const doneShards = shards.length - pendingShards.length;
  const testsDone = Object.values(doneByShard).reduce((a, b) => a + b, 0);

  const startedLabel = startedAtLabel(run.startedAt);
  const elapsed = run.startedAt
    ? Math.max(
        0,
        (run.finishedAt ? new Date(run.finishedAt).getTime() : now) -
          new Date(run.startedAt).getTime(),
      )
    : null;

  /*
   * The trace viewer at /runs/:id/trace has existed since the trace feature
   * shipped and NOTHING linked to it — the only route in was typing the URL.
   * The header link opens on the failure worth looking at; the per-test link in
   * the middle column opens on the selected one. Both are conditional on a
   * result that actually kept a trace, because the viewer's honest empty state
   * ("this test kept no trace") is not somewhere to send a person on purpose.
   */
  const traceTarget =
    results.find((r) => r.traceKey && r.status !== 'PASSED' && r.status !== 'SKIPPED') ??
    results.find((r) => r.traceKey) ??
    null;

  /** Selecting a test always lands on the step that explains it. */
  const selectTest = (testId: string) => {
    setSelectedTestId(testId);
    const target = results.find((r) => r.test.id === testId);
    setSelectedStep(target?.steps.find((s) => s.status === 'FAILED')?.index ?? null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Wraps rather than scrolls: at 900px this header has a back chip, an id,
          four facts, a gate verdict, three counts, a button and three links, and
          a single line of that is a horizontal scrollbar over the one strip
          nobody should have to scroll. */}
      <header className="border-line flex shrink-0 flex-wrap items-center gap-x-3.5 gap-y-2 border-b px-6 py-3.5">
        <Link
          href="/runs"
          className="border-line text-ink-dim hover:text-ink hover:border-line-strong inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[5px] text-[12px] whitespace-nowrap transition-colors"
          title="Back to all runs"
        >
          <span aria-hidden>←</span> runs
        </Link>
        <span className="font-mono text-[12.5px]">{run.id.slice(-8)}</span>
        <span className="text-ink-dim text-body-sm">
          {run.environment.name} · {run.trigger.toLowerCase()}
          {startedLabel && ` · started ${startedLabel}`}
          {elapsed !== null && (
            <>
              {' · '}
              <span className="tabular-nums">{wallClock(elapsed)}</span>
            </>
          )}
        </span>

        {run.gateResult && <GateChip gate={run.gateResult} provisional={awaitingTriage} />}

        <div className="ml-auto flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <span className="font-mono text-[11.5px] tabular-nums whitespace-nowrap">
            <span className="text-pass">{run.passedCount}</span>
            <span className="text-ink-faint"> pass</span>
            {run.failedCount > 0 && (
              <>
                <span className="text-ink-faint"> · </span>
                <span className="text-fail">{run.failedCount}</span>
                <span className="text-ink-faint"> fail</span>
              </>
            )}
            {run.flakyCount > 0 && (
              <>
                <span className="text-ink-faint"> · </span>
                <span className="text-flake">{run.flakyCount}</span>
                <span className="text-ink-faint"> flaky</span>
              </>
            )}
          </span>

          {/* While a run is in flight the only useful action is stopping it, so
              the button becomes Cancel rather than a greyed-out Re-run with no
              explanation of why it is disabled. */}
          {inFlight ? (
            <>
              <span className="text-ink-dim text-[11.5px] tabular-nums" aria-live="polite">
                {suiteTotal !== null ? `${testsDone} of ${suiteTotal}` : run.status.toLowerCase()}
                {/* The one number that must never be missing from a sharded run
                    in flight: a suite where four of five workers are done still
                    has a fifth of its tests unrun. */}
                {shards.length > 0 && (
                  <span className="text-ink-faint">
                    {' · '}
                    {doneShards} of {shards.length} shards
                  </span>
                )}
              </span>
              <Button size="sm" variant="danger" loading={cancelling} onClick={() => void cancel()}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              loading={rerunning}
              onClick={() => void rerun()}
              title="Run the same tests again"
            >
              Re-run
            </Button>
          )}

          <span className="inline-flex items-center gap-3.5 text-[12.5px] whitespace-nowrap">
            {/* "Is this failure new?" is the first question of any triage, and
                until this existed there was no way to ask it — re-running pushed
                you to a new run id with no link back. */}
            <Link
              href={`/runs/${run.id}/compare`}
              className="text-ink-faint hover:text-ink transition-colors"
              title="Compare with the previous run on this environment"
            >
              compare
            </Link>
            {traceTarget && (
              <Link
                href={`/runs/${run.id}/trace?result=${traceTarget.id}`}
                className="text-ink-faint hover:text-ink transition-colors"
                title="Step through the recorded browser session — DOM, network and console at every action"
              >
                trace
              </Link>
            )}
            <a
              href={`${API_URL}/runs/${run.id}/junit.xml`}
              className="text-ink-faint hover:text-ink transition-colors"
            >
              junit
            </a>
          </span>
        </div>
      </header>

      {/*
        ── The shards ──────────────────────────────────────────────────────
        A full-width strip rather than a column, because it is about the run and
        not about the selected test, and because a slow shard is only obvious
        when the others are next to it. Absent entirely on an unsharded run.
      */}
      {shards.length > 0 && (
        <section
          aria-label="Shards"
          className="border-line flex shrink-0 items-center gap-2 overflow-x-auto border-b px-6 py-2"
        >
          <p className="text-ink-dim shrink-0 text-[11.5px]">
            <span className="tabular-nums">{doneShards}</span> of{' '}
            <span className="tabular-nums">{shards.length}</span> shards done
            {pendingShards.length > 0 && (
              // Named, not counted. "Waiting on shard 3" is the sentence that
              // stops someone reading a partial suite as a finished one.
              <span className="text-ink-faint">
                {' · waiting on '}
                {pendingShards.map((s) => `#${s.index}`).join(', ')}
              </span>
            )}
          </p>

          {shards.map((shard) => {
            const shardElapsed = shardElapsedMs(shard, now);
            const failedItsTests = shard.status === 'FAILED' || shard.status === 'ABANDONED';
            return (
              <div
                key={shard.id}
                title={`Shard ${shard.index} of ${shard.total} · ${shard.testCount} tests · predicted ${wallClock(
                  shard.estimatedMs,
                )}${shard.errorMessage ? ` · ${shard.errorMessage}` : ''}`}
                className={cn(
                  'flex shrink-0 items-center gap-2.5 rounded-md border px-2.5 py-1',
                  failedItsTests
                    ? 'border-fail/40 bg-[color-mix(in_srgb,var(--color-fail)_5%,transparent)]'
                    : 'border-line bg-surface-1',
                )}
              >
                <StatusDot status={shardDotStatus(shard)} />
                <span className="text-ink-faint font-mono text-meta tabular-nums">
                  #{shard.index}
                </span>
                <span className="text-[12px]">{SHARD_STATUS_LABEL[shard.status]}</span>
                <span className="text-ink-faint font-mono text-meta tabular-nums">
                  {shard.testCount} tests
                </span>
                {/* A shard that has not started has no elapsed time to show, and
                    a dash is more honest than a zero. */}
                <span className="text-ink-dim font-mono text-meta tabular-nums">
                  {shardElapsed === null ? '—' : wallClock(shardElapsed)}
                </span>
              </div>
            );
          })}
        </section>
      )}

      {/*
        Three columns, minmax on all of them, and the container scrolls
        horizontally rather than any one of them collapsing: the left rail stops
        being useful below ~170px and the middle stops being readable below
        ~280px, so past that point the honest answer is a scrollbar.
      */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(170px,240px)_minmax(280px,1fr)_minmax(200px,320px)] overflow-x-auto">
        <CauseRail
          runId={run.id}
          results={results}
          selectedTestId={selected?.test.id ?? null}
          onSelectTest={selectTest}
        />

        <FailureStory
          runId={run.id}
          result={selected}
          selectedStep={selectedStep}
          onSelectStep={setSelectedStep}
        />

        <TriageRail
          runId={run.id}
          result={selected}
          step={step}
          onSelectStep={setSelectedStep}
          onReviewed={() => void load()}
          live={live}
        />
      </div>
    </div>
  );
}

/**
 * The gate, as a word rather than a colour.
 *
 * `provisional` is the third state and the reason this is not a boolean: a gate
 * scored against verdicts finds nothing to block on when nothing has been
 * triaged yet, and reports a pass. It is not a pass. It has not been decided.
 */
function GateChip({
  gate,
  provisional,
}: {
  gate: NonNullable<Run['gateResult']>;
  provisional: boolean;
}) {
  const undecided = gate.passed && provisional;
  const detail = gate.evaluations.map((e) => e.detail).join('\n');
  const word = undecided ? 'PROVISIONAL' : gate.passed ? 'PASS' : 'BLOCK';
  const tone = undecided
    ? 'text-flake bg-[color-mix(in_srgb,var(--color-flake)_12%,transparent)]'
    : gate.passed
      ? 'text-pass bg-[color-mix(in_srgb,var(--color-pass)_12%,transparent)]'
      : 'text-fail bg-[color-mix(in_srgb,var(--color-fail)_12%,transparent)]';

  return (
    <span
      title={
        undecided
          ? `${detail}\n\nProvisional: the gate is scored on triage verdicts and at least one failure has not been triaged yet, so nothing has been cleared. It is not a pass.`
          : detail
      }
      className={cn(
        'shrink-0 rounded-sm px-2 py-[3px] font-mono text-[10.5px] font-semibold tracking-[0.06em] whitespace-nowrap',
        tone,
      )}
    >
      GATE — {word}
    </span>
  );
}

/**
 * The cockpit while the run is still being fetched.
 *
 * Shaped like the screen it stands in for, three columns and all — a spinner
 * centred in an empty page tells you to wait, and this tells you what for.
 */
function CockpitSkeleton() {
  return (
    <div className="flex h-full flex-col" role="status" aria-label="Loading the run">
      <div className="border-line flex shrink-0 items-center gap-3.5 border-b px-6 py-3.5">
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-3.5 w-60" />
        <Skeleton className="ml-auto h-6 w-24" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(170px,240px)_minmax(280px,1fr)_minmax(200px,320px)]">
        <div className="border-line border-r px-3.5 py-4">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="mt-4 h-20 w-full" />
          <Skeleton className="mt-2 h-12 w-full" />
        </div>
        <div className="px-8 py-6">
          <Skeleton className="h-2.5 w-48" />
          <Skeleton className="mt-3 h-6 w-80" />
          <Skeleton className="mt-6 h-40 w-full" />
        </div>
        <div className="border-line border-l px-5 py-[18px]">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="mt-3 h-5 w-32" />
          <Skeleton className="mt-4 h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
