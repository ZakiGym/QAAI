'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API_URL, api, type Run } from '../../../lib/api';
import { SeverityLabel, StatusDot, duration } from '../../../components/ui';
import { Button } from '../../../components/ui/Button';
import { useToast } from '../../../components/ui/Toast';
import { EvidenceRail, type EvidenceResult } from '../../../components/EvidenceRail';

/**
 * The cockpit (§8).
 *
 * Left: the suite, grouped by status. Middle: the selected test as a step
 * timeline — the scrubber. Right: the evidence for the selected step, and the
 * Triage verdict card with its review actions.
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
 * unsplit one. Declared here so the panel below is typed; they belong in
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
 * what the rail correlates against; see components/EvidenceRail.tsx.
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

/**
 * How long a shard has been going, or took.
 *
 * `duration()` renders everything above a second in seconds, which is right for
 * a step and wrong for a slice of a nightly: an eight-minute shard reading
 * "480.0s" is a number nobody can compare at a glance, and comparing shards is
 * the entire point of the panel. Under a minute it defers to the primitive so
 * the two never disagree.
 */
function wallClock(ms: number): string {
  if (ms < 60_000) return duration(ms);
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
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

// ─── The evidence rail's width ───────────────────────────────────────────────
//
// It was a hard-coded 380px at every viewport, which is where "read this stack
// trace" turned into "read this stack trace four words at a time". Draggable,
// collapsible, and persisted with the same key convention and the same
// try/catch-around-localStorage as the sidebar in components/shell/AppShell.

const RAIL_WIDTH_KEY = 'qaai.cockpit.rail.width';
const RAIL_COLLAPSED_KEY = 'qaai.cockpit.rail.collapsed';
const RAIL_DEFAULT = 380;
const RAIL_MIN = 300;
const RAIL_MAX = 960;
/** The strip left behind when collapsed — never zero, because a rail with no
 *  handle is a rail you cannot get back. */
const RAIL_RAIL = 34;

/** Keep the middle pane usable no matter how far the rail is dragged. */
function clampRail(width: number): number {
  const viewportMax =
    typeof window === 'undefined' ? RAIL_MAX : Math.max(RAIL_MIN, window.innerWidth - 620);
  return Math.round(Math.min(Math.min(RAIL_MAX, viewportMax), Math.max(RAIL_MIN, width)));
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
   * A clock, so a running shard's elapsed time counts up between events rather
   * than freezing on whatever the last refetch happened to catch. Only ticks
   * while there is something to tick for.
   */
  const [now, setNow] = useState(() => Date.now());
  const toast = useToast();

  /*
   * Rail geometry. The initial state must match what the server rendered, so
   * the persisted value is applied in an effect and `railReady` gates the width
   * transition — restoring a collapsed rail should snap, not animate open then
   * shut, which is the same reason AppShell has its `mounted` flag.
   */
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railReady, setRailReady] = useState(false);
  const [railDragging, setRailDragging] = useState(false);
  const railDrag = useRef<{ x: number; from: number } | null>(null);

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(RAIL_WIDTH_KEY));
      if (Number.isFinite(stored) && stored > 0) setRailWidth(clampRail(stored));
      setRailCollapsed(localStorage.getItem(RAIL_COLLAPSED_KEY) === '1');
    } catch {
      /* private mode / no storage — the defaults are fine */
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setRailReady(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, []);

  // A width that was legal on a wide monitor is not legal in a narrow window.
  useEffect(() => {
    const onResize = () => setRailWidth((w) => clampRail(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const persistRailWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(RAIL_WIDTH_KEY, String(width));
    } catch {
      /* ignore */
    }
  }, []);

  /** Set and persist in one go — the keyboard path, where every press commits. */
  const commitRailWidth = useCallback(
    (width: number) => {
      const next = clampRail(width);
      setRailWidth(next);
      persistRailWidth(next);
    },
    [persistRailWidth],
  );

  /*
   * The drag itself lives on the WINDOW, not on the handle.
   *
   * The handle is 8px wide; a pointer moving at any speed leaves it on the
   * first frame, so listening on the element only works if pointer capture
   * holds for the whole gesture — and if capture is ever refused or dropped
   * (a synthetic pointer, a pen that goes out of range, a release outside the
   * window) the rail sticks at whatever width it had reached and never commits.
   * Window listeners have no such failure mode: the gesture ends when the
   * pointer goes up anywhere, or when the window loses focus mid-drag.
   */
  const railWidthRef = useRef(railWidth);
  railWidthRef.current = railWidth;

  useEffect(() => {
    if (!railDragging) return;

    const onMove = (e: PointerEvent) => {
      const drag = railDrag.current;
      if (!drag) return;
      // Dragging left widens the rail, so the delta is inverted.
      setRailWidth(clampRail(drag.from - (e.clientX - drag.x)));
    };
    const onEnd = () => {
      railDrag.current = null;
      setRailDragging(false);
      persistRailWidth(railWidthRef.current);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onEnd);

    // Own the cursor and kill text selection for the whole gesture — without
    // this, dragging across the step list selects every step title on the way.
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [railDragging, persistRailWidth]);

  const toggleRail = useCallback(() => {
    setRailCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

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
   * The elapsed clock for a running shard. Bound to the run's status so it
   * stops the moment there is nothing moving — a finished run must not hold a
   * timer open for as long as the tab is.
   */
  const ticking = run !== null && !TERMINAL.has(run.status) && (run.shards?.length ?? 0) > 0;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  if (error) {
    return (
      <main className="p-10">
        <p className="text-fail">{error}</p>
        <Link href="/runs" className="text-accent mt-4 inline-block text-sm">
          Back to runs
        </Link>
      </main>
    );
  }
  if (!run) return <main className="text-ink-faint p-10 text-sm">Loading…</main>;

  const inFlight = run.status === 'RUNNING' || run.status === 'QUEUED';
  const results = run.results ?? [];
  const selected = results.find((r) => r.test.id === selectedTestId) ?? results[0] ?? null;
  const step = selected?.steps.find((s) => s.index === selectedStep) ?? null;

  // Empty on every run that was not split, which is most of them.
  const shards = run.shards ?? [];
  const pendingShards = shards.filter((s) => !SHARD_TERMINAL.has(s.status));
  const doneShards = shards.length - pendingShards.length;
  const testsDone = Object.values(doneByShard).reduce((a, b) => a + b, 0);

  return (
    <div className="flex h-full flex-col">
      <header className="border-line flex shrink-0 items-center gap-3 border-b px-5 py-3">
        <Link
          href="/runs"
          className="text-ink-dim hover:text-ink hover:border-accent border-line flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors"
          title="Back to all runs"
        >
          <span aria-hidden>←</span> Runs
        </Link>
        <span className="border-line rounded-md border px-2 py-0.5 font-mono text-micro">
          {run.id.slice(-8)}
        </span>
        <span className="text-ink-dim text-sm">{run.environment.name}</span>

        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="text-pass">{run.passedCount} passed</span>
          {run.failedCount > 0 && <span className="text-fail">{run.failedCount} failed</span>}
          {run.flakyCount > 0 && <span className="text-flake">{run.flakyCount} flaky</span>}
          {run.gateResult && (
            <span
              className={`rounded-md border px-2 py-0.5 font-mono ${
                run.gateResult.passed ? 'border-pass/40 text-pass' : 'border-fail/40 text-fail'
              }`}
              title={run.gateResult.evaluations.map((e) => e.detail).join('\n')}
            >
              gate {run.gateResult.passed ? 'pass' : 'block'}
            </span>
          )}
          {/*
            While a run is in flight the only useful action is stopping it, so
            the button becomes Cancel rather than a greyed-out Re-run with no
            explanation of why it is disabled.
          */}
          {inFlight ? (
            <>
              <span className="text-ink-dim tabular-nums" aria-live="polite">
                {suiteTotal !== null
                  ? `${testsDone} of ${suiteTotal}`
                  : run.status.toLowerCase()}
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
              ↻ Re-run
            </Button>
          )}
          {/* "Is this failure new?" is the first question of any triage, and
              until now there was no way to ask it — re-running pushed you to a
              new run id with no link back to the one you were comparing. */}
          <Link
            href={`/runs/${run.id}/compare`}
            className="text-ink-faint hover:text-ink transition-colors"
            title="Compare with the previous run on this environment"
          >
            Compare
          </Link>
          <a
            href={`${API_URL}/runs/${run.id}/junit.xml`}
            className="text-ink-faint hover:text-ink transition-colors"
          >
            JUnit XML
          </a>
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
          className="border-line flex shrink-0 items-center gap-2 overflow-x-auto border-b px-5 py-2"
        >
          <p className="text-ink-dim shrink-0 text-xs">
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
            const elapsed = shardElapsedMs(shard, now);
            const failedItsTests = shard.status === 'FAILED' || shard.status === 'ABANDONED';
            return (
              <div
                key={shard.id}
                title={`Shard ${shard.index} of ${shard.total} · ${shard.testCount} tests · predicted ${wallClock(
                  shard.estimatedMs,
                )}${shard.errorMessage ? ` · ${shard.errorMessage}` : ''}`}
                className={`flex shrink-0 items-center gap-2.5 rounded-md border px-2.5 py-1 ${
                  failedItsTests ? 'border-fail/40 bg-fail/5' : 'border-line bg-surface-1'
                }`}
              >
                <StatusDot status={shardDotStatus(shard)} />
                <span className="text-ink-faint font-mono text-micro tabular-nums">
                  #{shard.index}
                </span>
                <span className="text-xs">{SHARD_STATUS_LABEL[shard.status]}</span>
                <span className="text-ink-faint text-micro tabular-nums">
                  {shard.testCount} tests
                </span>
                {/* A shard that has not started has no elapsed time to show, and
                    a dash is more honest than a zero. */}
                <span className="text-ink-dim text-micro tabular-nums">
                  {elapsed === null ? '—' : wallClock(elapsed)}
                </span>
              </div>
            );
          })}
        </section>
      )}

      <div
        className={`grid min-h-0 flex-1 ${
          railReady && !railDragging ? 'transition-[grid-template-columns] duration-150 ease-out' : ''
        }`}
        style={{
          gridTemplateColumns: `280px minmax(0,1fr) ${railCollapsed ? RAIL_RAIL : railWidth}px`,
        }}
      >
        {/* ── Left: the suite ─────────────────────────────────────────────── */}
        <aside className="border-line min-h-0 overflow-y-auto border-r">
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              onClick={() => {
                setSelectedTestId(result.test.id);
                setSelectedStep(result.steps.find((s) => s.status === 'FAILED')?.index ?? null);
              }}
              className={`border-line/60 flex w-full items-start gap-2.5 border-b px-4 py-3 text-left ${
                selected?.id === result.id ? 'bg-surface-2' : 'hover:bg-surface-1'
              }`}
            >
              <span className="mt-1.5">
                <StatusDot status={result.status} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{result.test.name}</span>
                <span className="text-ink-faint mt-0.5 flex items-center gap-2 font-mono text-micro">
                  {result.test.type}
                  {result.test.quarantined && <span className="text-flake">quarantined</span>}
                  {result.verdict && <span>{result.verdict.verdict}</span>}
                </span>
              </span>
            </button>
          ))}
        </aside>

        {/* ── Middle: the step scrubber ───────────────────────────────────── */}
        <section className="min-h-0 overflow-y-auto px-5 py-4">
          {selected ? (
            <>
              <h2 className="text-lg font-medium">{selected.test.name}</h2>
              <p className="text-ink-faint mt-1 font-mono text-xs">
                {/* This was dead text on the highest-traffic triage screen,
                    while /heals and /triage both made the same string a link.
                    It goes to the test's own history, which answers the
                    question you ask next: has this always been unreliable? */}
                <Link
                  href={`/tests/${selected.test.id}`}
                  className="hover:text-ink transition-colors hover:underline"
                  title="This test's history"
                >
                  {selected.test.filePath}
                </Link>{' '}
                · <span className="tabular-nums">{duration(selected.durationMs)}</span> ·{' '}
                {selected.test.priority.toLowerCase().replace('_', ' ')}
              </p>

              {selected.retriedAndPassed && (
                <p className="border-flake/40 bg-flake/10 text-flake mt-4 rounded-md border p-3 text-xs">
                  This test failed and then passed on retry. A retry that passes is not a pass — it
                  is a flake candidate, and the gate treats it as one.
                </p>
              )}

              <ol className="mt-5 space-y-1.5">
                {selected.steps.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedStep(s.index)}
                      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left ${
                        selectedStep === s.index
                          ? 'border-accent bg-surface-2'
                          : s.status === 'FAILED'
                            ? 'border-fail/40 bg-fail/5 hover:bg-fail/10'
                            : 'border-line hover:bg-surface-1'
                      }`}
                    >
                      <StatusDot status={s.status} />
                      <span className="text-ink-faint font-mono text-micro">{s.index}</span>
                      <span className="flex-1 text-sm">{s.title}</span>
                      <span className="text-ink-faint font-mono text-micro">
                        {duration(s.durationMs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>

              {selected.steps.length === 0 && selected.errorMessage && (
                <pre className="border-fail/40 bg-fail/5 text-fail mt-5 overflow-x-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
                  {selected.errorMessage}
                </pre>
              )}

              {selected.findings.length > 0 && (
                <section className="mt-8">
                  <h3 className="text-ink-dim mb-2 text-xs font-semibold tracking-wider uppercase">
                    Findings ({selected.findings.length})
                  </h3>
                  <ul className="border-line divide-line divide-y rounded-md border">
                    {selected.findings.map((f) => (
                      <li key={f.id} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <SeverityLabel severity={f.severity} />
                          <code className="font-mono text-micro">{f.code}</code>
                        </div>
                        <p className="text-ink-dim mt-1 text-xs">{f.message}</p>
                        <p className="text-ink-faint mt-0.5 font-mono text-micro">{f.location}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <p className="text-ink-faint text-sm">This run has no results.</p>
          )}
        </section>

        {/* ── Right: evidence and verdict ─────────────────────────────────── */}
        <aside className="border-line relative min-h-0 border-l" aria-label="Evidence">
          {railCollapsed ? (
            /* Collapsed to a strip, never to nothing: the live feed lives in
               this rail, so a run in flight keeps a pulsing dot on the handle
               rather than silently losing its only progress surface. */
            <button
              type="button"
              onClick={toggleRail}
              title="Show evidence"
              aria-label="Show evidence"
              aria-expanded={false}
              className="text-ink-faint hover:text-ink hover:bg-surface-1 flex h-full w-full flex-col items-center gap-3 py-3"
            >
              <span aria-hidden>‹</span>
              {live.length > 0 && (
                <span className="bg-accent inline-block h-1.5 w-1.5 animate-pulse rounded-full" />
              )}
              <span className="text-micro [writing-mode:vertical-rl]">Evidence</span>
            </button>
          ) : (
            <>
              {/*
                The drag handle. It sits on the border rather than beside it, so
                the rail does not jump the first time you grab it, and it is a
                real focusable separator — arrow keys resize it, which is the
                only way this is usable without a mouse.
              */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize evidence rail"
                aria-valuenow={railWidth}
                aria-valuemin={RAIL_MIN}
                aria-valuemax={RAIL_MAX}
                tabIndex={0}
                onPointerDown={(e) => {
                  railDrag.current = { x: e.clientX, from: railWidth };
                  setRailDragging(true);
                  // preventDefault stops the browser starting a text selection,
                  // and also suppresses the focus it would otherwise give — so
                  // focus is taken explicitly, keeping the keyboard path alive
                  // for anyone who grabs the handle with a mouse first.
                  e.preventDefault();
                  e.currentTarget.focus();
                }}
                onDoubleClick={() => commitRailWidth(RAIL_DEFAULT)}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 80 : 16;
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    commitRailWidth(railWidth + step);
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    commitRailWidth(railWidth - step);
                  } else if (e.key === 'Home') {
                    e.preventDefault();
                    commitRailWidth(RAIL_MAX);
                  } else if (e.key === 'End') {
                    e.preventDefault();
                    commitRailWidth(RAIL_MIN);
                  }
                }}
                title="Drag to resize · double-click to reset"
                className={`hover:bg-accent/60 focus-visible:bg-accent absolute top-0 -left-1 z-10 h-full w-2 cursor-col-resize ${
                  railDragging ? 'bg-accent/60' : 'bg-transparent'
                }`}
              />

              <div className="flex h-full min-h-0 flex-col">
                <div className="border-line flex shrink-0 items-center gap-2 border-b px-4 py-2">
                  <h2 className="text-ink-faint text-micro font-semibold tracking-wider uppercase">
                    Evidence
                  </h2>
                  <span className="text-ink-faint ml-auto font-mono text-meta tabular-nums">
                    {railWidth}px
                  </span>
                  <button
                    type="button"
                    onClick={toggleRail}
                    title="Collapse evidence rail"
                    aria-label="Collapse evidence rail"
                    aria-expanded
                    className="text-ink-faint hover:text-ink text-sm leading-none"
                  >
                    ›
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                  <EvidenceRail
                    runId={run.id}
                    result={selected}
                    step={step}
                    onSelectStep={setSelectedStep}
                    onReviewed={() => void load()}
                    live={live}
                  />
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

