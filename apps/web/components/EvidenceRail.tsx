'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, artifactUrl, type Step, type TestResult } from '../lib/api';
import { VerdictChip, duration } from './ui';
import { Lightbox, type Shot } from './Lightbox';
import { cn } from '../lib/cn';

/**
 * The evidence for the SELECTED STEP.
 *
 * The rail used to show the console and the network for the whole test. When a
 * test does forty things and the twelfth broke, the request that explains it is
 * the twelfth of forty and the list is a haystack. Everything here is scoped to
 * the selected step first, with the full list always one click away — evidence
 * is defaulted away, never hidden.
 */

// ─── Shapes the API returns but lib/api.ts does not describe ─────────────────
//
// `GET /runs/:runId` includes the whole TestResult row and the whole Step row,
// so `network`, `consoleLog`, `step.startedAt` and `step.errorStack` have been
// on the wire since they were first written — they were simply never typed and
// never rendered. Declared here, next to the only code that reads them, the way
// this page already declares its shard types. They belong in lib/api.ts next
// time that file is opened (it is not owned by this change).

/** @see packages/shared/src/types.ts — NetworkEntry */
export interface NetworkEntry {
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  /** Captured for non-2xx by default, and always secret-masked at capture. */
  responseBodySnippet: string | null;
}

/** @see packages/shared/src/types.ts — ConsoleEntry */
export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  /** ISO instant. The only absolute timestamp in the evidence payload. */
  at: string;
}

export type EvidenceStep = Step & {
  startedAt: string | null;
  errorStack: string | null;
};

export type EvidenceResult = Omit<TestResult, 'steps'> & {
  steps: EvidenceStep[];
  network?: NetworkEntry[] | null;
  consoleLog?: ConsoleEntry[] | null;
};

export interface LiveLine {
  text: string;
  tone: string;
}

// ─── Correlation ─────────────────────────────────────────────────────────────

/**
 * A console line is emitted by the page a beat before the assertion that
 * notices it, and the runner stamps a step's start after the action has begun.
 * So the window is the step's own span with a small lead-in — wide enough to
 * catch the error that caused the failure, narrow enough that "the console for
 * this step" still means something.
 */
const LEAD_MS = 500;
const TAIL_MS = 250;

/** Named for what it is, and NOT `Window` — that shadows a DOM global. */
interface LogWindow {
  from: number;
  to: number;
}

/**
 * The time window for a step, or null when the timestamps cannot support one.
 *
 * Not every runner plugin stamps a distinct `startedAt` per step — the API and
 * security plugins record the same instant for every step in the test. Windowing
 * against those would either show everything or show nothing while claiming to
 * be precise, so when the stamps do not discriminate we return null and the
 * caller shows the unfiltered log with a note saying why. Silently filtering on
 * a timestamp we do not trust is how evidence goes missing.
 */
function stepWindow(steps: EvidenceStep[], step: EvidenceStep): LogWindow | null {
  if (!step.startedAt) return null;
  const stamps = new Set(steps.map((s) => s.startedAt).filter(Boolean));
  if (steps.length > 1 && stamps.size < 2) return null;
  const start = new Date(step.startedAt).getTime();
  if (Number.isNaN(start)) return null;
  return { from: start - LEAD_MS, to: start + Math.max(0, step.durationMs) + TAIL_MS };
}

/** Where an entry sits relative to the step, in words. */
function offsetLabel(atMs: number, step: EvidenceStep): string | null {
  if (!step.startedAt) return null;
  const start = new Date(step.startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const delta = atMs - start;
  if (delta < 0) return `${duration(Math.round(-delta))} before`;
  if (delta <= Math.max(0, step.durationMs)) return 'during';
  return `${duration(Math.round(delta - step.durationMs))} after`;
}

/** The path of a URL, for matching and for display. Falsy-safe on junk input. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * How much a request has to do with this step.
 *
 * NOTE — network entries carry NO absolute timestamp. `NetworkEntry` is
 * `{method, url, status, durationMs, responseBodySnippet}`; the runner has the
 * wall-clock time at capture and drops it (packages/runner/src/plugins/*).
 * So this cannot be a time window like the console is, and pretending otherwise
 * would put a confident, wrong label on the evidence. What it can do honestly is
 * rank: a request the step's own error names is almost certainly the one, a
 * request that failed or never completed is almost always worth reading, and
 * everything else is a click away.
 */
const NAMED_BY_STEP = 3;
const FAILED_ANYWHERE = 2;

function relevance(entry: NetworkEntry, tokens: string[]): number {
  if (namedByStep(entry, tokens)) return NAMED_BY_STEP;
  if (entry.status === null) return FAILED_ANYWHERE; // never completed — a hang or a reset
  if (entry.status >= 400) return FAILED_ANYWHERE;
  return 0;
}

/**
 * Does the step name this request?
 *
 * Matching runs against TOKENS, not against the raw string. A plain
 * `haystack.includes(path)` cannot match the root path — "/" is a substring of
 * every URL-shaped word in the text, so it has to be excluded, and then a step
 * titled `Headers and cookies: /` fails to match its own request to `/`. That
 * was not hypothetical: it is exactly what the security-smoke test does, and
 * the rail hid the one request the step was about while showing two 404s from
 * other steps. An exact token comparison handles the short paths and substring
 * matching handles the long ones.
 */
function namedByStep(entry: NetworkEntry, tokens: string[]): boolean {
  const path = pathOf(entry.url);
  for (const token of tokens) {
    if (token === entry.url || token === path) return true;
    if (path.length > 1 && token.includes(path)) return true;
  }
  return false;
}

/** Everything the step says about itself, split into words to match URLs against. */
function stepTokens(step: EvidenceStep): string[] {
  return [step.title, step.errorMessage, step.expected, step.actual, step.selector]
    .filter(Boolean)
    .join('\n')
    .split(/[\s"'`(),;<>[\]{}]+/)
    .filter(Boolean);
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function RailSection({
  title,
  count,
  children,
  action,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-ink-dim text-micro font-semibold tracking-wider uppercase">{title}</h3>
        {count !== undefined && (
          <span className="text-ink-faint font-mono text-meta tabular-nums">{count}</span>
        )}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

function ScopeToggle({
  showingAll,
  onToggle,
  scopedCount,
  totalCount,
}: {
  showingAll: boolean;
  onToggle: () => void;
  scopedCount: number;
  totalCount: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-ink-faint hover:text-accent text-micro underline decoration-dotted underline-offset-2"
      title={
        showingAll
          ? 'Show only what relates to the selected step'
          : 'Show every entry for the whole test'
      }
    >
      {showingAll ? `this step (${scopedCount})` : `show all (${totalCount})`}
    </button>
  );
}

const LEVEL_STYLE: Record<string, string> = {
  error: 'text-fail',
  warn: 'text-flake',
  info: 'text-accent',
  debug: 'text-ink-faint',
  log: 'text-ink-faint',
};

function statusStyle(status: number | null): string {
  if (status === null) return 'text-fail';
  if (status >= 500) return 'text-fail';
  if (status >= 400) return 'text-flake';
  if (status >= 300) return 'text-ink-dim';
  return 'text-pass';
}

function ConsoleRow({ entry, step }: { entry: ConsoleEntry; step: EvidenceStep | null }) {
  const atMs = new Date(entry.at).getTime();
  const offset = step && !Number.isNaN(atMs) ? offsetLabel(atMs, step) : null;
  return (
    <li className="border-line/60 flex gap-2 border-b px-2 py-1.5 last:border-b-0">
      <span className={cn('shrink-0 font-mono text-meta uppercase', LEVEL_STYLE[entry.level])}>
        {entry.level}
      </span>
      <span className="min-w-0 flex-1 font-mono text-micro break-words whitespace-pre-wrap">
        {entry.text}
      </span>
      {offset && (
        <span className="text-ink-faint shrink-0 font-mono text-meta tabular-nums">{offset}</span>
      )}
    </li>
  );
}

function NetworkRow({ entry, named }: { entry: NetworkEntry; named: boolean }) {
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(entry.responseBodySnippet);
  return (
    <li
      // The request the step actually names gets a rule down its edge. Without
      // it, "the one you asked about" and "a 404 from somewhere else in the
      // test" are the same grey row and the reader has to re-derive which is
      // which every time.
      className={cn(
        'border-line/60 border-b last:border-b-0',
        named && 'border-l-accent bg-accent/5 border-l-2',
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        // A row with nothing to expand must not look like a button that does
        // nothing when you press it.
        className={cn(
          'flex w-full items-baseline gap-2 px-2 py-1.5 text-left',
          hasBody ? 'hover:bg-surface-2 cursor-pointer' : 'cursor-default',
        )}
        aria-expanded={hasBody ? open : undefined}
        title={named ? `${entry.url} — named by this step` : entry.url}
      >
        <span className="text-ink-faint w-10 shrink-0 font-mono text-meta">{entry.method}</span>
        <span
          className={cn('w-8 shrink-0 font-mono text-meta tabular-nums', statusStyle(entry.status))}
        >
          {entry.status ?? '—'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-micro">{pathOf(entry.url)}</span>
        <span className="text-ink-faint shrink-0 font-mono text-meta tabular-nums">
          {duration(entry.durationMs)}
        </span>
        {hasBody && <span className="text-ink-faint shrink-0 text-meta">{open ? '▾' : '▸'}</span>}
      </button>
      {open && entry.responseBodySnippet && (
        <pre className="bg-surface-2 text-ink-dim mx-2 mb-2 max-h-48 overflow-auto rounded-md p-2 font-mono text-meta whitespace-pre-wrap">
          {entry.responseBodySnippet}
        </pre>
      )}
    </li>
  );
}

function RailEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-line text-ink-faint rounded-md border border-dashed px-3 py-2 text-micro">
      {children}
    </p>
  );
}

// ─── The rail ────────────────────────────────────────────────────────────────

export function EvidenceRail({
  runId,
  result,
  step,
  onSelectStep,
  onReviewed,
  live,
}: {
  runId: string;
  result: EvidenceResult | null;
  /** The step the middle pane has selected, if any. */
  step: EvidenceStep | null;
  onSelectStep: (index: number) => void;
  onReviewed: () => void;
  live: LiveLine[];
}) {
  const [showAllConsole, setShowAllConsole] = useState(false);
  const [showAllNetwork, setShowAllNetwork] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);

  // Scoping is a per-test decision: moving between steps of the same test keeps
  // whatever you chose, opening a different test starts scoped again.
  //
  // The lightbox closes with it. Its index points into THIS test's captures, so
  // carrying it across would either show the wrong screenshot or, on a test with
  // fewer captures, index past the end.
  useEffect(() => {
    setShowAllConsole(false);
    setShowAllNetwork(false);
    setStackOpen(false);
    setLightboxAt(null);
  }, [result?.id]);

  const consoleLog = useMemo(() => result?.consoleLog ?? [], [result?.consoleLog]);
  const network = useMemo(() => result?.network ?? [], [result?.network]);

  // Memoised so `scopedConsole` below has a stable dependency; a fresh object
  // every render would defeat its useMemo entirely.
  const logWindow = useMemo(
    () => (step ? stepWindow(result?.steps ?? [], step) : null),
    [result?.steps, step],
  );

  const scopedConsole = useMemo(() => {
    if (!logWindow) return consoleLog;
    return consoleLog.filter((e) => {
      const at = new Date(e.at).getTime();
      return !Number.isNaN(at) && at >= logWindow.from && at <= logWindow.to;
    });
  }, [consoleLog, logWindow]);

  /**
   * "An error logged milliseconds before the failure is usually the answer."
   *
   * The nearest error at or before the step's end — deliberately NOT limited to
   * the window, because an error logged two seconds earlier during a navigation
   * is still the explanation and burying it under a scroll would be the exact
   * failure this rail is being rebuilt to fix. The offset is spelled out so
   * nobody mistakes it for something logged inside the step.
   */
  const nearestError = useMemo(() => {
    if (!step?.startedAt || step.status !== 'FAILED') return null;
    const end = new Date(step.startedAt).getTime() + Math.max(0, step.durationMs) + TAIL_MS;
    if (Number.isNaN(end)) return null;
    let best: ConsoleEntry | null = null;
    let bestAt = -Infinity;
    for (const e of consoleLog) {
      if (e.level !== 'error') continue;
      const at = new Date(e.at).getTime();
      if (Number.isNaN(at) || at > end) continue;
      if (at >= bestAt) {
        best = e;
        bestAt = at;
      }
    }
    return best ? { entry: best, label: offsetLabel(bestAt, step) } : null;
  }, [consoleLog, step]);

  const tokens = useMemo(() => (step ? stepTokens(step) : []), [step]);
  const scopedNetwork = useMemo(() => {
    if (!step) return network;
    // Kept in the order the requests were made — with no timestamps, the array
    // order is the only true sequence there is, and reordering by score would
    // throw it away.
    const scored = network.filter((e) => relevance(e, tokens) > 0);
    // Nothing scored: the honest default is the whole list, not an empty pane
    // implying this step made no requests.
    return scored.length > 0 ? scored : network;
  }, [network, tokens, step]);

  const networkIsScoped = step !== null && scopedNetwork.length < network.length;
  const consoleIsScoped = logWindow !== null && scopedConsole.length < consoleLog.length;

  const shownConsole = showAllConsole ? consoleLog : scopedConsole;
  const shownNetwork = showAllNetwork ? network : scopedNetwork;

  // Every capture in this test, in step order — what the lightbox arrows walk.
  const shots: Shot[] = useMemo(() => {
    if (!result) return [];
    return result.steps
      .filter((s) => s.screenshotKey)
      .map((s) => ({
        stepIndex: s.index,
        title: s.title,
        status: s.status,
        src: artifactUrl(runId, s.screenshotKey!),
        alt: `Screenshot at step ${s.index}: ${s.title}`,
      }));
  }, [result, runId]);

  const shotForStep = step?.screenshotKey
    ? shots.findIndex((s) => s.stepIndex === step.index)
    : -1;

  return (
    <>
      {result?.verdict ? (
        <VerdictCard result={result} onReviewed={onReviewed} />
      ) : result && result.status !== 'PASSED' && result.status !== 'SKIPPED' ? (
        <p className="border-line text-ink-faint rounded-md border border-dashed p-3 text-xs">
          Triage has not produced a verdict yet. It runs on the worker right after the test finishes
          and needs <code className="font-mono">ANTHROPIC_API_KEY</code> to be set.
        </p>
      ) : null}

      {/* ── The screenshot ──────────────────────────────────────────────────
          A thumbnail is a link to the evidence, not the evidence. The whole
          figure is the hit target, because a 380px-wide image is a big obvious
          thing to click and a small "expand" icon is not. */}
      {shotForStep >= 0 && (
        <figure className="mt-4">
          <button
            type="button"
            onClick={() => setLightboxAt(shotForStep)}
            className="group border-line hover:border-accent focus-visible:border-accent relative block w-full overflow-hidden rounded-md border"
            title="Open full size — pan, zoom, arrow keys between captures"
          >
            <img
              src={shots[shotForStep]!.src}
              alt={shots[shotForStep]!.alt}
              className="block w-full"
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/45 group-hover:opacity-100 group-focus-visible:bg-black/45 group-focus-visible:opacity-100">
              <span className="border-line-strong bg-surface-1 rounded-md border px-2.5 py-1 text-xs">
                Open full size
              </span>
            </span>
          </button>
          <figcaption className="text-ink-faint mt-1.5 flex items-center gap-2 text-micro">
            <span>Captured at step {step!.index}</span>
            {shots.length > 1 && (
              <span className="tabular-nums">
                · {shotForStep + 1} of {shots.length} captures
              </span>
            )}
          </figcaption>
        </figure>
      )}

      {/* Captures exist, just not on the step you are looking at — say so
          rather than showing nothing and letting it read as "none captured". */}
      {shotForStep < 0 && shots.length > 0 && (
        <div className="mt-4">
          <RailEmpty>
            No capture at step {step?.index ?? '—'}.{' '}
            <button
              type="button"
              onClick={() => onSelectStep(shots[0]!.stepIndex)}
              className="text-accent underline decoration-dotted underline-offset-2"
            >
              Jump to step {shots[0]!.stepIndex}
            </button>
            , which has one.
          </RailEmpty>
        </div>
      )}

      <Lightbox
        open={lightboxAt !== null}
        shots={shots}
        index={lightboxAt ?? 0}
        onIndex={(next) => {
          setLightboxAt(next);
          // Arrowing through captures moves the rail with you, so closing
          // leaves you on the step you were actually looking at.
          const target = shots[next];
          if (target) onSelectStep(target.stepIndex);
        }}
        onClose={() => setLightboxAt(null)}
        testName={result?.test.name ?? ''}
      />

      {/* ── The failure itself ──────────────────────────────────────────────── */}
      {step?.errorMessage && (
        <RailSection title={`Step ${step.index}`}>
          {(step.expected || step.actual) && (
            <dl className="border-line mb-3 rounded-md border p-3 font-mono text-xs">
              <dt className="text-ink-faint">expected</dt>
              <dd className="text-pass mb-2 break-words">{step.expected ?? '—'}</dd>
              <dt className="text-ink-faint">actual</dt>
              <dd className="text-fail break-words">{step.actual ?? '—'}</dd>
            </dl>
          )}
          {step.selector && (
            <p className="text-ink-faint mb-2 font-mono text-micro break-all">
              selector <span className="text-ink-dim">{step.selector}</span>
            </p>
          )}
          <pre className="border-line overflow-x-auto rounded-md border p-3 font-mono text-micro whitespace-pre-wrap">
            {step.errorMessage}
          </pre>
          {step.errorStack && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setStackOpen((o) => !o)}
                className="text-ink-faint hover:text-accent text-micro underline decoration-dotted underline-offset-2"
              >
                {stackOpen ? 'hide stack' : 'show stack'}
              </button>
              {stackOpen && (
                <pre className="border-line text-ink-dim mt-2 max-h-72 overflow-auto rounded-md border p-3 font-mono text-meta whitespace-pre-wrap">
                  {step.errorStack}
                </pre>
              )}
            </div>
          )}
        </RailSection>
      )}

      {/* ── Console ─────────────────────────────────────────────────────────── */}
      {consoleLog.length > 0 && (
        <RailSection
          title="Console"
          count={shownConsole.length}
          action={
            consoleIsScoped ? (
              <ScopeToggle
                showingAll={showAllConsole}
                onToggle={() => setShowAllConsole((v) => !v)}
                scopedCount={scopedConsole.length}
                totalCount={consoleLog.length}
              />
            ) : null
          }
        >
          {nearestError && (
            <div className="border-fail/40 bg-fail/10 mb-2 rounded-md border p-2">
              <p className="text-fail text-meta font-semibold tracking-wider uppercase">
                Closest error{nearestError.label ? ` · ${nearestError.label}` : ''}
              </p>
              <p className="text-ink-dim mt-1 font-mono text-micro break-words whitespace-pre-wrap">
                {nearestError.entry.text}
              </p>
            </div>
          )}

          {!logWindow && step && (
            <p className="text-ink-faint mb-2 text-meta">
              This runner stamped every step with the same time, so the log cannot be narrowed to
              one step. Showing all {consoleLog.length}.
            </p>
          )}

          {shownConsole.length === 0 ? (
            <RailEmpty>
              Nothing logged during step {step?.index}.{' '}
              <button
                type="button"
                onClick={() => setShowAllConsole(true)}
                className="text-accent underline decoration-dotted underline-offset-2"
              >
                Show all {consoleLog.length}
              </button>
            </RailEmpty>
          ) : (
            <ul className="border-line max-h-80 overflow-y-auto rounded-md border">
              {shownConsole.map((entry, i) => (
                <ConsoleRow key={`${entry.at}-${i}`} entry={entry} step={step} />
              ))}
            </ul>
          )}
        </RailSection>
      )}

      {/* ── Network ─────────────────────────────────────────────────────────── */}
      {network.length > 0 && (
        <RailSection
          title="Network"
          count={shownNetwork.length}
          action={
            networkIsScoped ? (
              <ScopeToggle
                showingAll={showAllNetwork}
                onToggle={() => setShowAllNetwork((v) => !v)}
                scopedCount={scopedNetwork.length}
                totalCount={network.length}
              />
            ) : null
          }
        >
          {/* Say what the filter IS. Requests carry no timestamp, so this is a
              ranking and not a time window, and a label that implied otherwise
              would be a confident lie about the evidence. */}
          {networkIsScoped && !showAllNetwork && (
            <p className="text-ink-faint mb-2 text-meta">
              Requests this step names, plus everything that failed. Requests are not timestamped,
              so this is what relates to the step — not a time window.
            </p>
          )}
          <ul className="border-line max-h-80 overflow-y-auto rounded-md border">
            {shownNetwork.map((entry, i) => (
              <NetworkRow
                key={`${entry.method}-${entry.url}-${i}`}
                entry={entry}
                named={namedByStep(entry, tokens)}
              />
            ))}
          </ul>
        </RailSection>
      )}

      {/* ── Whole-test artifacts ────────────────────────────────────────────── */}
      {(result?.traceKey || result?.videoKey) && (
        <div className="mt-4 flex gap-2">
          {result.traceKey && (
            <a
              href={artifactUrl(runId, result.traceKey)}
              className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs"
            >
              Download trace
            </a>
          )}
          {result.videoKey && (
            <a
              href={artifactUrl(runId, result.videoKey)}
              className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs"
            >
              Video
            </a>
          )}
        </div>
      )}

      {/* Findings stay in the middle pane, where they already are — they are
          about the test, not about the selected step. */}

      {/* ── Live ────────────────────────────────────────────────────────────── */}
      {live.length > 0 && (
        <div className="mt-6">
          <h3 className="text-ink-dim mb-2 flex items-center gap-2 text-micro font-semibold tracking-wider uppercase">
            <span className="bg-accent inline-block h-1.5 w-1.5 animate-pulse rounded-full" />
            Live
          </h3>
          {/* Newest first, so the thing that just happened is where the eye
              already is — this list is watched, not scrolled. */}
          <ul className="space-y-1" aria-live="polite">
            {live.map((line, i) => (
              <li
                key={`${line.text}-${i}`}
                className={cn(
                  'text-micro flex items-baseline gap-2',
                  i === 0 ? 'text-ink-dim' : 'text-ink-faint',
                )}
              >
                <span className={cn('mt-1 h-1 w-1 shrink-0 rounded-full', line.tone)} />
                <span className="min-w-0 flex-1 truncate">{line.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** The verdict card and its keyboard-first review actions (§8). */
export function VerdictCard({
  result,
  onReviewed,
}: {
  result: EvidenceResult;
  onReviewed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const verdict = result.verdict!;

  async function review(action: 'accept' | 'override' | 'mute', overrideTo?: string) {
    setBusy(true);
    try {
      await api(`/verdicts/${verdict.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, overrideTo }),
      });
      onReviewed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-line bg-surface-1 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <VerdictChip verdict={verdict.verdict} confidence={verdict.confidence} />
        <span className="text-ink-faint ml-auto font-mono text-micro">{verdict.model}</span>
      </div>

      <p className="text-ink-dim mt-3 text-sm leading-relaxed">{verdict.explanation}</p>

      {verdict.evidence.length > 0 && (
        <ul className="border-line mt-3 space-y-1.5 border-t pt-3">
          {verdict.evidence.map((e, i) => (
            <li key={i} className="text-xs">
              <code className="text-ink-faint font-mono text-meta">
                {e.kind} {e.ref}
              </code>
              <span className="text-ink-dim ml-2">{e.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {verdict.reviewState === 'PENDING' ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void review('accept')}
            className="bg-accent rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void review('override', 'FLAKE')}
            className="border-line rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          >
            It&rsquo;s a flake
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void review('override', 'INTENDED_CHANGE')}
            className="border-line rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          >
            Intended change
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void review('mute')}
            className="border-line text-ink-faint rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          >
            Mute
          </button>
        </div>
      ) : (
        <p className="text-ink-faint mt-4 font-mono text-micro">
          reviewed · {verdict.reviewState.toLowerCase()}
        </p>
      )}
    </section>
  );
}
