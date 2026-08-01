'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_URL, api, artifactUrl } from '../lib/api';
import { StatusDot, duration } from './ui';
import { Badge, SectionLabel, Skeleton } from './ui/layout';
import { EmptyState } from './ui/EmptyState';
import { cn } from '../lib/cn';

/**
 * The inline trace viewer (§8).
 *
 * QAAI's pitch is that it tells you *why* a test failed, with evidence. Until
 * this screen the evidence was a link to a `.zip` — and nobody downloads a zip
 * in the middle of triage, so the central claim went unmet at the exact moment
 * it mattered. This is that claim, rendered.
 *
 * Three panes, in the cockpit's own grammar. The timeline on the left is the
 * scrubber: every action Playwright recorded, nested the way the test reads,
 * with the failing one marked and selected on arrival. The middle is what the
 * browser actually had on screen at that action — the rebuilt DOM, or the
 * screencast frame. The right is the evidence for *that action alone*: its
 * Playwright log, its requests, its console.
 *
 * Two decisions are worth stating outright.
 *
 * The DOM pane is an iframe sandboxed to `allow-same-origin` and nothing else.
 * What it renders is the customer's own markup; it must not execute inside our
 * origin, so it gets no `allow-scripts`, the server has already stripped every
 * `<script>` and `on*` handler, and the document carries a `default-src 'none'`
 * CSP of its own. `allow-same-origin` is there for one reason: it lets this
 * component reach into the frame afterwards and restore the scroll offsets
 * Playwright recorded, which is the one piece of page state that cannot be
 * expressed in markup.
 *
 * And nothing is loaded until it is looked at. The timeline arrives without
 * payloads; a snapshot, a frame and an action's network slice are each fetched
 * on selection and remembered. A 200MB trace is a real thing, and the way to
 * survive one is to never ask for all of it.
 */

// ─── The API's shapes ────────────────────────────────────────────────────────

type ActionCategory = 'step' | 'action' | 'expect' | 'hook' | 'fixture' | 'attach' | 'other';

interface TraceAction {
  id: string;
  parentId: string | null;
  depth: number;
  title: string;
  apiName: string;
  category: ActionCategory;
  isSetup: boolean;
  startMs: number;
  endMs: number;
  durationMs: number;
  error: { message: string; stack: string | null } | null;
  failing: boolean;
  location: { file: string; line: number; column: number } | null;
  params: Record<string, string>;
  result: string | null;
  pageId: string | null;
  snapshots: { before: string | null; action: string | null; after: string | null };
  defaultSnapshot: { name: string; kind: 'before' | 'action' | 'after' | 'nearest' } | null;
  point: { x: number; y: number } | null;
  counts: { log: number; network: number; console: number };
}

interface NetworkEntry {
  id: string;
  startMs: number;
  durationMs: number;
  method: string;
  url: string;
  status: number;
  statusText: string;
  mimeType: string;
  requestBytes: number;
  responseBytes: number;
  failed: boolean;
  pageId: string | null;
}

interface ConsoleEntry {
  id: string;
  timeMs: number;
  level: string;
  text: string;
  location: string | null;
}

interface TraceMeta {
  browserName: string | null;
  playwrightVersion: string | null;
  platform: string | null;
  baseUrl: string | null;
  viewport: { width: number; height: number } | null;
  startedAt: string | null;
  durationMs: number;
  pageIds: string[];
}

interface Attachment {
  name: string;
  contentType: string;
  sha1: string;
  bytes: number;
}

interface TraceEnvelope {
  test: {
    resultId: string;
    name: string;
    status: string;
    errorMessage: string | null;
    traceKey: string | null;
    videoKey: string | null;
  };
  trace:
    | {
        available: true;
        meta: TraceMeta;
        actions: TraceAction[];
        attachments: Attachment[];
        counts: { actions: number; network: number; console: number };
        limits: { truncated: boolean; notes: string[] };
      }
    | { available: false; reason: string; message: string };
}

interface ActionDetail {
  logs: Array<{ timeMs: number; message: string }>;
  network: NetworkEntry[];
  console: ConsoleEntry[];
  screenshot: { sha1: string; width: number; height: number } | null;
}

interface RenderedSnapshot {
  html: string;
  viewport: { width: number; height: number } | null;
  frameUrl: string | null;
  timeMs: number;
  notes: string[];
  truncated: boolean;
}

// ─── Small pieces ────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<ActionCategory, string> = {
  step: 'step',
  action: 'action',
  expect: 'expect',
  hook: 'hook',
  fixture: 'fixture',
  attach: 'attach',
  other: 'call',
};

/** Bytes, at the resolution a person reading a network row actually wants. */
function bytes(value: number): string {
  if (value <= 0) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function statusTone(status: number): string {
  if (status === 0) return 'text-fail';
  if (status >= 500) return 'text-fail';
  if (status >= 400) return 'text-flake';
  if (status >= 300) return 'text-ink-dim';
  return 'text-pass';
}

const CONSOLE_TONE: Record<string, string> = {
  error: 'text-fail',
  warning: 'text-flake',
  stderr: 'text-fail',
  stdout: 'text-ink-dim',
};

// ─── The viewer ──────────────────────────────────────────────────────────────

type EvidenceTab = 'log' | 'network' | 'console' | 'error';
type StagePane = 'before' | 'action' | 'after' | 'screenshot';

export function TraceViewer({ runId, resultId }: { runId: string; resultId: string }) {
  const [envelope, setEnvelope] = useState<TraceEnvelope | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [pane, setPane] = useState<StagePane | null>(null);
  const [tab, setTab] = useState<EvidenceTab>('log');
  const [detail, setDetail] = useState<ActionDetail | null>(null);
  const [snapshot, setSnapshot] = useState<RenderedSnapshot | null>(null);
  const [snapshotPending, setSnapshotPending] = useState(false);
  const [zoomToFit, setZoomToFit] = useState(true);
  // Three panes do not fit a 1280px laptop once the app sidebar takes its cut,
  // and the DOM is the pane you came to look at. Folding the evidence away hands
  // its width to the stage for as long as you are reading the page.
  const [evidenceOpen, setEvidenceOpen] = useState(true);

  // Fetched once each, then reused — scrubbing the timeline with the arrow keys
  // must not re-download a snapshot the user already looked at.
  const detailCache = useRef(new Map<string, ActionDetail>());
  const snapshotCache = useRef(new Map<string, RenderedSnapshot>());

  useEffect(() => {
    let cancelled = false;
    setEnvelope(null);
    setLoadError(null);
    setSelectedId(null);
    detailCache.current.clear();
    snapshotCache.current.clear();

    api<TraceEnvelope>(`/trace/${runId}/${resultId}`)
      .then((loaded) => {
        if (cancelled) return;
        setEnvelope(loaded);
        if (!loaded.trace.available) return;
        // Land on the failure. Anything else makes the person who came here to
        // read one assertion click their way to it first.
        const failing = loaded.trace.actions.find((action) => action.failing);
        const fallback =
          loaded.trace.actions.find((action) => !action.isSetup) ?? loaded.trace.actions[0];
        setSelectedId((failing ?? fallback)?.id ?? null);
        setTab(failing ? 'error' : 'log');
        if (failing?.isSetup) setShowSetup(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load trace');
      });

    return () => {
      cancelled = true;
    };
  }, [runId, resultId]);

  const trace = envelope?.trace.available ? envelope.trace : null;
  const actions = useMemo(() => trace?.actions ?? [], [trace]);
  const visible = useMemo(
    () => actions.filter((action) => showSetup || !action.isSetup),
    [actions, showSetup],
  );
  const selected = useMemo(
    () => actions.find((action) => action.id === selectedId) ?? null,
    [actions, selectedId],
  );

  /** Which stage panes this action can actually offer. */
  const panes = useMemo((): StagePane[] => {
    if (!selected) return [];
    const available: StagePane[] = [];
    if (selected.snapshots.before) available.push('before');
    if (selected.snapshots.action) available.push('action');
    if (selected.snapshots.after) available.push('after');
    if (available.length === 0 && selected.defaultSnapshot) available.push('after');
    available.push('screenshot');
    return available;
  }, [selected]);

  /** The snapshot name the chosen pane resolves to, `nearest` fallback included. */
  const snapshotName = useMemo(() => {
    if (!selected || pane === null || pane === 'screenshot') return null;
    // A pane can be offered without a snapshot of its own — the `defaultSnapshot`
    // fallback is what puts the nearest recorded DOM on screen instead of nothing.
    return selected.snapshots[pane] ?? selected.defaultSnapshot?.name ?? null;
  }, [selected, pane]);

  // Reset the stage to this action's own best pane whenever the selection moves.
  useEffect(() => {
    if (!selected) return;
    setPane((current) => {
      if (current && panes.includes(current)) return current;
      const kind = selected.defaultSnapshot?.kind;
      if (kind && kind !== 'nearest' && panes.includes(kind)) return kind;
      return panes[0] ?? null;
    });
  }, [selected, panes]);

  // ── Per-action fetches ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    const cached = detailCache.current.get(selected.id);
    if (cached) {
      setDetail(cached);
      return;
    }
    let cancelled = false;
    setDetail(null);
    api<{ detail: ActionDetail }>(`/trace/${runId}/${resultId}/actions/${selected.id}`)
      .then((loaded) => {
        if (cancelled) return;
        detailCache.current.set(selected.id, loaded.detail);
        setDetail(loaded.detail);
      })
      .catch(() => {
        // An action whose slice will not load is an empty slice, not a crash —
        // the timeline and the DOM beside it are still worth reading.
        if (!cancelled) setDetail({ logs: [], network: [], console: [], screenshot: null });
      });
    return () => {
      cancelled = true;
    };
  }, [selected, runId, resultId]);

  useEffect(() => {
    if (!snapshotName) {
      setSnapshot(null);
      setSnapshotPending(false);
      return;
    }
    const cached = snapshotCache.current.get(snapshotName);
    if (cached) {
      setSnapshot(cached);
      setSnapshotPending(false);
      return;
    }
    let cancelled = false;
    setSnapshotPending(true);
    api<{ snapshot: RenderedSnapshot }>(
      `/trace/${runId}/${resultId}/snapshot?name=${encodeURIComponent(snapshotName)}`,
    )
      .then((loaded) => {
        if (cancelled) return;
        snapshotCache.current.set(snapshotName, loaded.snapshot);
        setSnapshot(loaded.snapshot);
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      })
      .finally(() => {
        if (!cancelled) setSnapshotPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshotName, runId, resultId]);

  // ── Scrubbing ──────────────────────────────────────────────────────────────

  const move = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const index = visible.findIndex((action) => action.id === selectedId);
      const next = index === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, index + delta));
      setSelectedId(visible[next]?.id ?? null);
    },
    [visible, selectedId],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal a key from someone typing, and never from a modified press
      // that belongs to the browser.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setSelectedId(visible[0]?.id ?? null);
      } else if (event.key === 'End') {
        event.preventDefault();
        setSelectedId(visible[visible.length - 1]?.id ?? null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [move, visible]);

  // ── States before the grid ─────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="p-8">
        <EmptyState
          title="The trace could not be loaded"
          body={loadError}
          action={{ label: 'Back to the run', href: `/runs/${runId}` }}
        />
      </div>
    );
  }

  if (!envelope) {
    return (
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '320px minmax(0,1fr)' }}>
        <div className="border-line space-y-2 border-r p-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
        <div className="p-6">
          <Skeleton className="h-full min-h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!envelope.trace.available) {
    return (
      <div className="mx-auto w-full max-w-2xl p-10">
        <EmptyState
          title="No trace to show for this test"
          body={envelope.trace.message}
          action={
            envelope.test.traceKey
              ? {
                  label: 'Download the raw trace',
                  href: artifactUrl(runId, envelope.test.traceKey),
                }
              : { label: 'Back to the run', href: `/runs/${runId}` }
          }
          secondary={
            envelope.test.traceKey
              ? { label: 'Back to the run', href: `/runs/${runId}` }
              : undefined
          }
        />
        {envelope.test.errorMessage && (
          <div className="mt-6">
            <SectionLabel>What the runner reported</SectionLabel>
            <pre className="border-line text-ink-dim overflow-x-auto rounded-md border p-3 font-mono text-micro whitespace-pre-wrap">
              {envelope.test.errorMessage}
            </pre>
          </div>
        )}
      </div>
    );
  }

  const totalMs = Math.max(1, trace?.meta.durationMs ?? 1);

  return (
    <div
      className="grid min-h-0 flex-1"
      style={{ gridTemplateColumns: `272px minmax(0,1fr) ${evidenceOpen ? '320px' : '0px'}` }}
    >
      {/* ── Left: the timeline ─────────────────────────────────────────────── */}
      <aside className="border-line flex min-h-0 flex-col border-r" aria-label="Action timeline">
        <div className="border-line flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <span className="text-ink-faint text-micro tabular-nums">
            {visible.length} of {actions.length}
          </span>
          <label className="text-ink-dim hover:text-ink ml-auto flex cursor-pointer items-center gap-1.5 text-micro">
            <input
              type="checkbox"
              checked={showSetup}
              onChange={(event) => setShowSetup(event.target.checked)}
              className="accent-accent h-3 w-3"
            />
            setup &amp; teardown
          </label>
        </div>

        <ol className="min-h-0 flex-1 overflow-y-auto">
          {visible.map((action) => (
            <TimelineRow
              key={action.id}
              action={action}
              totalMs={totalMs}
              selected={action.id === selectedId}
              onSelect={() => setSelectedId(action.id)}
            />
          ))}
        </ol>

        <p className="border-line text-ink-faint shrink-0 border-t px-3 py-2 text-meta">
          <kbd className="border-line rounded border px-1">←</kbd>{' '}
          <kbd className="border-line rounded border px-1">→</kbd> to scrub
        </p>
      </aside>

      {/* ── Middle: what the browser had on screen ─────────────────────────── */}
      <section className="flex min-h-0 flex-col" aria-label="Snapshot">
        <div className="border-line flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
          {panes.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setPane(option)}
              className={cn(
                'rounded-md border px-2 py-0.5 text-micro transition-colors',
                pane === option
                  ? 'border-accent text-accent'
                  : 'border-line text-ink-dim hover:text-ink',
              )}
            >
              {/* An action with no snapshot of its own still gets a DOM pane —
                  labelled for what it is, so nobody reads a borrowed snapshot as
                  this action's own "after". */}
              {option === 'screenshot'
                ? 'screenshot'
                : selected?.snapshots[option]
                  ? option
                  : 'closest DOM'}
            </button>
          ))}

          {pane !== 'screenshot' && snapshot?.frameUrl && (
            <span
              className="text-ink-faint ml-2 min-w-0 flex-1 truncate font-mono text-meta"
              title={snapshot.frameUrl}
            >
              {snapshot.frameUrl}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {/* State, not verb: the highlighted one is what you are looking at. */}
            {([true, false] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                onClick={() => setZoomToFit(value)}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-micro transition-colors',
                  zoomToFit === value
                    ? 'border-accent text-accent'
                    : 'border-line text-ink-dim hover:text-ink',
                )}
              >
                {value ? 'fit' : '1:1'}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setEvidenceOpen((open) => !open)}
              aria-expanded={evidenceOpen}
              className="border-line text-ink-dim hover:text-ink rounded-md border px-2 py-0.5 text-micro transition-colors"
              title={evidenceOpen ? 'Hide the evidence rail' : 'Show the evidence rail'}
            >
              evidence {evidenceOpen ? '›' : '‹'}
            </button>
          </div>
        </div>

        <div className="bg-surface min-h-0 flex-1 overflow-auto p-4">
          {pane === 'screenshot' ? (
            <ScreenshotPane
              runId={runId}
              resultId={resultId}
              detail={detail}
              zoomToFit={zoomToFit}
            />
          ) : (
            <SnapshotPane
              snapshot={snapshot}
              pending={snapshotPending}
              zoomToFit={zoomToFit}
              point={pane === 'action' || panes.length === 1 ? (selected?.point ?? null) : null}
              nearest={selected?.defaultSnapshot?.kind === 'nearest' && !selected.snapshots.after}
            />
          )}
        </div>

        {trace?.limits.truncated && (
          <div className="border-line text-flake shrink-0 border-t px-3 py-2 text-micro">
            {trace.limits.notes.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}
      </section>

      {/* ── Right: the evidence for this action alone ──────────────────────── */}
      <aside
        className={cn('border-line flex min-h-0 flex-col border-l', !evidenceOpen && 'hidden')}
        aria-label="Evidence"
      >
        {selected ? (
          <>
            <div className="border-line shrink-0 border-b px-3 py-2.5">
              <p className="text-body-sm leading-snug break-words">{selected.title}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge tone={selected.failing ? 'fail' : 'neutral'} mono>
                  {CATEGORY_LABEL[selected.category]}
                </Badge>
                <span className="text-ink-faint text-micro tabular-nums">
                  {duration(selected.durationMs)}
                </span>
                <span className="text-ink-faint text-micro tabular-nums">
                  at {duration(selected.startMs)}
                </span>
                {selected.location && (
                  <span
                    className="text-ink-faint truncate font-mono text-meta"
                    title={`${selected.location.file}:${selected.location.line}`}
                  >
                    {selected.location.file}:{selected.location.line}
                  </span>
                )}
              </div>
              {selected.result !== null && (
                <p className="text-ink-dim mt-1.5 font-mono text-micro">
                  returned <span className="text-ink">{selected.result}</span>
                </p>
              )}
            </div>

            <div className="border-line flex shrink-0 gap-1 border-b px-2" role="tablist">
              {(
                [
                  ['log', selected.counts.log],
                  ['network', selected.counts.network],
                  ['console', selected.counts.console],
                  ['error', selected.error ? 1 : 0],
                ] as Array<[EvidenceTab, number]>
              ).map(([id, count]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={cn(
                    '-mb-px border-b-2 px-2 py-1.5 text-micro capitalize transition-colors',
                    tab === id
                      ? 'border-accent text-ink'
                      : 'text-ink-dim hover:text-ink border-transparent',
                    id === 'error' && count > 0 && tab !== id && 'text-fail',
                  )}
                >
                  {id}
                  {count > 0 && (
                    <span className="text-ink-faint ml-1 text-meta tabular-nums">{count}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <EvidencePane tab={tab} action={selected} detail={detail} />
            </div>
          </>
        ) : (
          <p className="text-ink-faint p-4 text-body-sm">
            Pick an action on the left to see its evidence.
          </p>
        )}
      </aside>
    </div>
  );
}

// ─── Timeline row ────────────────────────────────────────────────────────────

function TimelineRow({
  action,
  totalMs,
  selected,
  onSelect,
}: {
  action: TraceAction;
  totalMs: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);

  // Keyboard scrubbing is useless if the selection walks off screen.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const left = Math.min(100, (action.startMs / totalMs) * 100);
  const width = Math.max(0.8, Math.min(100 - left, (action.durationMs / totalMs) * 100));

  return (
    <li ref={ref}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'border-line/50 w-full border-b px-3 py-1.5 text-left transition-colors',
          selected ? 'bg-surface-2' : 'hover:bg-surface-1',
          action.isSetup && !selected && 'opacity-60',
        )}
      >
        <div
          className="flex items-center gap-2"
          style={{ paddingLeft: `${Math.min(action.depth, 4) * 10}px` }}
        >
          <StatusDot status={action.error ? (action.failing ? 'FAILED' : 'FLAKY') : 'PASSED'} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-body-sm',
              action.failing && 'text-fail font-medium',
            )}
            title={action.title}
          >
            {action.title}
          </span>
          <span className="text-ink-faint shrink-0 text-meta tabular-nums">
            {duration(action.durationMs)}
          </span>
        </div>
        {/* Where this action sits in the test's own wall clock. A step that took
            nothing and a step that took four seconds should not look alike. */}
        <div className="bg-surface-2 mt-1 h-0.5 w-full overflow-hidden rounded-full">
          <div
            className={cn('h-full rounded-full', action.failing ? 'bg-fail' : 'bg-accent/50')}
            style={{ marginLeft: `${left}%`, width: `${width}%` }}
          />
        </div>
      </button>
    </li>
  );
}

// ─── Stage ───────────────────────────────────────────────────────────────────

function SnapshotPane({
  snapshot,
  pending,
  zoomToFit,
  point,
  nearest,
}: {
  snapshot: RenderedSnapshot | null;
  pending: boolean;
  zoomToFit: boolean;
  point: { x: number; y: number } | null;
  nearest: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [available, setAvailable] = useState(0);

  /**
   * A callback ref, not `useRef` + `useEffect`.
   *
   * This component returns a skeleton before the snapshot arrives, so on the
   * mount pass there is no element to measure — and an effect with `[]` deps
   * never looks again. The width stayed 0, "fit" computed a scale of 1, and
   * every snapshot rendered at 1280px inside a 600px pane with the right-hand
   * half of the page simply cut off.
   */
  const measure = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!element) {
      observer.current = null;
      return;
    }
    observer.current = new ResizeObserver(() => setAvailable(element.clientWidth));
    observer.current.observe(element);
    setAvailable(element.clientWidth);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  /**
   * Restore the scroll offsets Playwright recorded.
   *
   * Scroll position is the one piece of page state with no markup for it, so the
   * server emits it as `data-playwright-scroll-*` and this puts it back. Reaching
   * into `contentDocument` is possible only because the frame is
   * `allow-same-origin`; it stays safe because the frame has no `allow-scripts`,
   * so nothing inside it can reach back.
   */
  const restoreScroll = useCallback(() => {
    try {
      const doc = frame.current?.contentDocument;
      if (!doc) return;
      for (const element of doc.querySelectorAll<HTMLElement>('[data-playwright-scroll-top]')) {
        element.scrollTop = Number(element.getAttribute('data-playwright-scroll-top')) || 0;
      }
      for (const element of doc.querySelectorAll<HTMLElement>('[data-playwright-scroll-left]')) {
        element.scrollLeft = Number(element.getAttribute('data-playwright-scroll-left')) || 0;
      }
    } catch {
      /* A frame we cannot reach still renders; the page is just not scrolled. */
    }
  }, []);

  if (pending) return <Skeleton className="h-full min-h-64 w-full" />;

  if (!snapshot) {
    return (
      <EmptyState
        title="No DOM was captured here"
        body={
          'Playwright records a DOM snapshot around each browser action. This step never touched ' +
          'the page — a fixture, a hook, or an assertion on plain values — so there is nothing ' +
          'to rebuild. The screenshot tab may still have a frame from this moment.'
        }
      />
    );
  }

  const viewport = snapshot.viewport ?? { width: 1280, height: 720 };
  const scale = zoomToFit && available > 0 ? Math.min(1, available / viewport.width) : 1;

  return (
    <div ref={measure} className="w-full">
      {nearest && (
        <p className="border-flake/40 text-flake mb-2 rounded-md border border-dashed px-2.5 py-1.5 text-micro">
          This action recorded no snapshot of its own, so this is the closest DOM captured before it
          — which for a failed assertion is the page the assertion read.
        </p>
      )}

      <div
        className="relative overflow-hidden rounded-md border border-line bg-white"
        style={{ width: viewport.width * scale, height: viewport.height * scale }}
      >
        <iframe
          ref={frame}
          title="DOM snapshot"
          onLoad={restoreScroll}
          /*
           * `allow-same-origin` and nothing else. This is the customer's own
           * markup: no allow-scripts, no allow-forms, no allow-popups. The
           * document also carries its own default-src 'none' CSP from the
           * server, so it cannot reach the network either.
           */
          sandbox="allow-same-origin"
          srcDoc={snapshot.html}
          style={{
            width: viewport.width,
            height: viewport.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            border: 0,
          }}
        />
        {point && (
          <span
            aria-hidden
            className="border-accent bg-accent/25 pointer-events-none absolute rounded-full border-2"
            style={{
              left: point.x * scale - 9,
              top: point.y * scale - 9,
              width: 18,
              height: 18,
            }}
          />
        )}
      </div>

      <div className="text-ink-faint mt-2 flex flex-wrap items-center gap-3 text-meta">
        <span className="tabular-nums">
          {viewport.width}×{viewport.height}
          {scale < 1 && ` · ${Math.round(scale * 100)}%`}
        </span>
        <span className="tabular-nums">at {duration(snapshot.timeMs)}</span>
        {snapshot.notes.map((note) => (
          <span key={note} className="text-flake">
            {note}
          </span>
        ))}
      </div>
    </div>
  );
}

function ScreenshotPane({
  runId,
  resultId,
  detail,
  zoomToFit,
}: {
  runId: string;
  resultId: string;
  detail: ActionDetail | null;
  zoomToFit: boolean;
}) {
  if (!detail) return <Skeleton className="h-full min-h-64 w-full" />;

  if (!detail.screenshot) {
    return (
      <EmptyState
        title="No frame was captured here"
        body={
          'Playwright records screencast frames while the page is changing, not on a fixed clock. ' +
          'Nothing was painted during this action, so the nearest evidence is the DOM snapshot.'
        }
      />
    );
  }

  return (
    <ScreencastFrame
      runId={runId}
      resultId={resultId}
      shot={detail.screenshot}
      zoomToFit={zoomToFit}
    />
  );
}

function ScreencastFrame({
  runId,
  resultId,
  shot,
  zoomToFit,
}: {
  runId: string;
  resultId: string;
  shot: { sha1: string; width: number; height: number };
  zoomToFit: boolean;
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);

  return (
    <figure>
      {/*
        Real size by default — a screenshot scaled to fit is a screenshot you
        cannot read the error text in, which is usually the only reason to open
        one. `fit` is opt-in via the toggle above.

        No width/height attributes: Playwright records the screencast at its own
        scale (a 1280×720 page is commonly captured at 800×450), so pinning the
        element to the page's dimensions would upscale the frame and call the
        blur "real size".
      */}
      <img
        src={`${API_URL}/trace/${runId}/${resultId}/resource/${encodeURIComponent(shot.sha1)}`}
        alt="Page at the selected action"
        onLoad={(event) =>
          setNatural({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
        className={cn('border-line rounded-md border bg-white', zoomToFit && 'h-auto max-w-full')}
      />
      <figcaption className="text-ink-faint mt-2 text-meta tabular-nums">
        {natural ? `${natural.width}×${natural.height} frame` : 'frame'}
        {shot.width > 0 && ` of a ${shot.width}×${shot.height} page`} · captured closest to this
        action
      </figcaption>
    </figure>
  );
}

// ─── Evidence ────────────────────────────────────────────────────────────────

function EvidencePane({
  tab,
  action,
  detail,
}: {
  tab: EvidenceTab;
  action: TraceAction;
  detail: ActionDetail | null;
}) {
  if (tab === 'error') {
    if (!action.error) {
      return <p className="text-ink-faint text-body-sm">This action did not fail.</p>;
    }
    return (
      <div className="space-y-3">
        <pre className="border-fail/40 bg-fail/5 text-fail overflow-x-auto rounded-md border p-3 font-mono text-micro whitespace-pre-wrap">
          {action.error.message}
        </pre>
        {Object.keys(action.params).length > 0 && (
          <dl className="border-line rounded-md border p-3 font-mono text-micro">
            {Object.entries(action.params).map(([key, value]) => (
              <div key={key} className="flex gap-2 py-0.5">
                <dt className="text-ink-faint shrink-0">{key}</dt>
                <dd className="text-ink-dim min-w-0 break-all">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {action.error.stack && (
          <details>
            <summary className="text-ink-dim hover:text-ink cursor-pointer text-micro">
              stack
            </summary>
            <pre className="text-ink-faint mt-2 overflow-x-auto font-mono text-meta whitespace-pre-wrap">
              {action.error.stack}
            </pre>
          </details>
        )}
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  }

  if (tab === 'log') {
    if (detail.logs.length === 0) {
      return (
        <p className="text-ink-faint text-body-sm">
          Playwright logged nothing for this action. Only calls that wait on the page — clicks,
          assertions, navigations — narrate what they were waiting for.
        </p>
      );
    }
    return (
      <ol className="space-y-1">
        {detail.logs.map((line, index) => (
          <li key={`${line.timeMs}-${index}`} className="flex gap-2 font-mono text-meta">
            <span className="text-ink-faint shrink-0 tabular-nums">{line.timeMs}ms</span>
            <span className="text-ink-dim min-w-0 break-words whitespace-pre-wrap">
              {line.message}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  if (tab === 'network') {
    if (detail.network.length === 0) {
      return <p className="text-ink-faint text-body-sm">No requests during this action.</p>;
    }
    return (
      <ul className="divide-line divide-y">
        {detail.network.map((entry) => (
          <li key={entry.id} className="py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-ink-faint shrink-0 font-mono text-meta">{entry.method}</span>
              <span
                className={cn(
                  'shrink-0 font-mono text-meta tabular-nums',
                  statusTone(entry.status),
                )}
              >
                {entry.status || 'ERR'}
              </span>
              <span className="text-ink-faint ml-auto shrink-0 text-meta tabular-nums">
                {duration(entry.durationMs)}
              </span>
            </div>
            <p className="text-ink-dim mt-0.5 font-mono text-meta break-all" title={entry.url}>
              {entry.url}
            </p>
            <p className="text-ink-faint mt-0.5 text-meta tabular-nums">
              {entry.mimeType || 'unknown'} · {bytes(entry.responseBytes)}
            </p>
          </li>
        ))}
      </ul>
    );
  }

  if (detail.console.length === 0) {
    return (
      <p className="text-ink-faint text-body-sm">The page logged nothing during this action.</p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {detail.console.map((entry) => (
        <li key={entry.id} className="font-mono text-meta">
          <span className={cn('mr-1.5', CONSOLE_TONE[entry.level] ?? 'text-ink-faint')}>
            {entry.level}
          </span>
          <span className="text-ink-dim break-words whitespace-pre-wrap">{entry.text}</span>
          {entry.location && (
            <span className="text-ink-faint ml-1.5 break-all">{entry.location}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
