'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, artifactUrl } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  ConsoleEntry,
  EvidenceResult,
  EvidenceStep,
  LiveLine,
  NetworkEntry,
} from '../EvidenceRail';
import { Lightbox, type Shot } from '../Lightbox';
import { duration } from '../ui';
import { namedByStep, offsetLabel, pathOf, relevance, stepTokens, stepWindow } from './evidence';

/**
 * The triage rail — the verdict, and the evidence behind it.
 *
 * The order is the argument: what the model decided, how sure it was, why in
 * its own words, what it looked at, and then the four keys that let you agree
 * or disagree in one press. Everything below the action row is the raw material
 * — the screenshot, the console, the requests — scoped to the step the middle
 * pane has selected, because a test that did forty things has thirty-nine logs
 * that are not about the failure.
 *
 * The explanation is set in serif italic. That is not decoration: it is how this
 * UI marks prose the model wrote apart from prose the product wrote, and it is
 * the only italic on the screen.
 */

export interface TriageRailProps {
  runId: string;
  result: EvidenceResult | null;
  /** The step the middle pane has selected, if any. */
  step: EvidenceStep | null;
  onSelectStep: (index: number) => void;
  onReviewed: () => void;
  live: LiveLine[];
}

/** The chip word. `REAL_BUG` is a database value; `REAL BUG` is a label. */
const VERDICT_WORD: Record<string, string> = {
  REAL_BUG: 'REAL BUG',
  INTENDED_CHANGE: 'INTENDED',
  FLAKE: 'FLAKE',
  ENV_ISSUE: 'ENV ISSUE',
};

const VERDICT_TONE: Record<string, { text: string; tint: string }> = {
  REAL_BUG: {
    text: 'text-fail',
    tint: 'bg-[color-mix(in_srgb,var(--color-fail)_12%,transparent)]',
  },
  INTENDED_CHANGE: {
    text: 'text-accent',
    tint: 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]',
  },
  FLAKE: {
    text: 'text-flake',
    tint: 'bg-[color-mix(in_srgb,var(--color-flake)_12%,transparent)]',
  },
  ENV_ISSUE: { text: 'text-ink-dim', tint: 'bg-surface-2' },
};

export function TriageRail({
  runId,
  result,
  step,
  onSelectStep,
  onReviewed,
  live,
}: TriageRailProps) {
  const [showAllConsole, setShowAllConsole] = useState(false);
  const [showAllNetwork, setShowAllNetwork] = useState(false);
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);

  /*
   * Scoping is a per-test decision: moving between steps of the same test keeps
   * whatever you chose, opening a different test starts scoped again.
   *
   * The lightbox closes with it. Its index points into THIS test's captures, so
   * carrying it across would either show the wrong screenshot or, on a test with
   * fewer captures, index past the end.
   */
  useEffect(() => {
    setShowAllConsole(false);
    setShowAllNetwork(false);
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
    return consoleLog.filter((entry) => {
      const at = new Date(entry.at).getTime();
      return !Number.isNaN(at) && at >= logWindow.from && at <= logWindow.to;
    });
  }, [consoleLog, logWindow]);

  const tokens = useMemo(() => (step ? stepTokens(step) : []), [step]);
  const scopedNetwork = useMemo(() => {
    if (!step) return network;
    // Kept in the order the requests were made — with no timestamps, the array
    // order is the only true sequence there is, and reordering by score would
    // throw it away.
    const scored = network.filter((entry) => relevance(entry, tokens) > 0);
    // Nothing scored: the honest default is the whole list, not an empty pane
    // implying this step made no requests.
    return scored.length > 0 ? scored : network;
  }, [network, tokens, step]);

  const consoleIsScoped = logWindow !== null && scopedConsole.length < consoleLog.length;
  const networkIsScoped = step !== null && scopedNetwork.length < network.length;
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

  const shotAt = step?.screenshotKey ? shots.findIndex((s) => s.stepIndex === step.index) : -1;

  return (
    <aside
      aria-label="Triage"
      className="border-line min-h-0 overflow-y-auto border-l px-5 py-[18px]"
    >
      <Verdict result={result} onReviewed={onReviewed} />

      {shotAt >= 0 && (
        <div className="border-line mt-5 border-t pt-[18px]">
          <button
            type="button"
            onClick={() => setLightboxAt(shotAt)}
            className="border-line hover:border-accent relative block w-full overflow-hidden rounded-lg border transition-colors"
            title="Open full size — pan, zoom, arrow keys between captures"
          >
            <img src={shots[shotAt]!.src} alt={shots[shotAt]!.alt} className="block w-full" />
          </button>
          <p className="text-ink-faint text-meta mt-1.5 font-mono tabular-nums">
            capture {shotAt + 1} of {shots.length} · click to zoom
          </p>
        </div>
      )}

      {/* Captures exist, just not on the step you are looking at — say so rather
          than showing nothing and letting it read as "none captured". */}
      {shotAt < 0 && shots.length > 0 && (
        <p className="border-line text-ink-faint mt-5 rounded-lg border border-dashed px-3 py-2 text-micro">
          No capture at step {step?.index ?? '—'}.{' '}
          <button
            type="button"
            onClick={() => onSelectStep(shots[0]!.stepIndex)}
            className="text-accent underline decoration-dotted underline-offset-2"
          >
            Jump to step {shots[0]!.stepIndex}
          </button>
          , which has one.
        </p>
      )}

      <Lightbox
        open={lightboxAt !== null}
        shots={shots}
        index={lightboxAt ?? 0}
        onIndex={(next) => {
          setLightboxAt(next);
          // Arrowing through captures moves the rail with you, so closing leaves
          // you on the step you were actually looking at.
          const target = shots[next];
          if (target) onSelectStep(target.stepIndex);
        }}
        onClose={() => setLightboxAt(null)}
        testName={result?.test.name ?? ''}
      />

      {consoleLog.length > 0 && (
        <section className="mt-[18px]">
          <RailHeading
            title="Console"
            note={
              consoleIsScoped && !showAllConsole
                ? `scoped to step ${step?.index}`
                : `all ${consoleLog.length}`
            }
            toggle={
              consoleIsScoped
                ? {
                    label: showAllConsole ? `this step` : `all ${consoleLog.length}`,
                    onClick: () => setShowAllConsole((v) => !v),
                  }
                : null
            }
          />
          {!logWindow && step && (
            <p className="text-ink-faint text-meta mb-1.5">
              This runner stamped every step with the same time, so the log cannot be narrowed to
              one step.
            </p>
          )}
          {shownConsole.length === 0 ? (
            <p className="border-line text-ink-faint rounded-lg border border-dashed px-3 py-2 text-micro">
              Nothing logged during step {step?.index}.{' '}
              <button
                type="button"
                onClick={() => setShowAllConsole(true)}
                className="text-accent underline decoration-dotted underline-offset-2"
              >
                Show all {consoleLog.length}
              </button>
            </p>
          ) : (
            <ul className="border-line max-h-72 overflow-y-auto rounded-lg border font-mono text-micro leading-[1.5]">
              {shownConsole.map((entry, i) => (
                <ConsoleRow key={`${entry.at}-${i}`} entry={entry} step={step} first={i === 0} />
              ))}
            </ul>
          )}
        </section>
      )}

      {network.length > 0 && (
        <section className="mt-[18px]">
          <RailHeading
            title="Network"
            note={networkIsScoped && !showAllNetwork ? 'named by step' : `all ${network.length}`}
            toggle={
              networkIsScoped
                ? {
                    label: showAllNetwork ? 'this step' : `all ${network.length}`,
                    onClick: () => setShowAllNetwork((v) => !v),
                  }
                : null
            }
          />
          {/* Say what the filter IS. Requests carry no timestamp, so this is a
              ranking and not a time window, and a label that implied otherwise
              would be a confident lie about the evidence. */}
          {networkIsScoped && !showAllNetwork && (
            <p className="text-ink-faint text-meta mb-1.5">
              Requests this step names, plus everything that failed — not a time window.
            </p>
          )}
          <ul className="border-line max-h-72 overflow-y-auto rounded-lg border font-mono text-micro">
            {shownNetwork.map((entry, i) => (
              <NetworkRow
                key={`${entry.method}-${entry.url}-${i}`}
                entry={entry}
                named={namedByStep(entry, tokens)}
                first={i === 0}
              />
            ))}
          </ul>
        </section>
      )}

      {(result?.traceKey || result?.videoKey) && (
        <div className="mt-4 flex flex-wrap gap-3 text-[12px]">
          {result.traceKey && (
            /*
             * The in-app viewer comes FIRST, and the download second. This rail
             * offered a .zip since traces shipped, and /runs/:id/trace — the
             * screen this product actually builds — was linked from nowhere.
             */
            <Link href={`/runs/${runId}/trace?result=${result.id}`} className="text-accent hover:underline">
              open trace →
            </Link>
          )}
          {result.videoKey && (
            <a
              href={artifactUrl(runId, result.videoKey)}
              className="text-ink-faint hover:text-ink transition-colors"
            >
              video
            </a>
          )}
          {result.traceKey && (
            <a
              href={artifactUrl(runId, result.traceKey)}
              className="text-ink-faint hover:text-ink transition-colors"
              title="The raw Playwright trace, for trace.playwright.dev or your own tooling"
            >
              download .zip
            </a>
          )}
        </div>
      )}

      {live.length > 0 && (
        <section className="border-line mt-5 border-t pt-4">
          <h3 className="text-ink-faint text-meta mb-2 flex items-center gap-2 font-mono font-semibold tracking-[0.1em] uppercase">
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
                  'flex items-baseline gap-2 text-micro',
                  i === 0 ? 'text-ink-dim' : 'text-ink-faint',
                )}
              >
                <span className={cn('mt-1 h-1 w-1 shrink-0 rounded-full', line.tone)} />
                <span className="min-w-0 flex-1 truncate">{line.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

// ─── The verdict, and the four keys ──────────────────────────────────────────

function Verdict({
  result,
  onReviewed,
}: {
  result: EvidenceResult | null;
  onReviewed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const verdict = result?.verdict ?? null;
  const pending = verdict?.reviewState === 'PENDING';

  const review = useCallback(
    async (action: 'accept' | 'override' | 'mute', overrideTo?: string) => {
      if (!verdict || busy) return;
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
    },
    [verdict, busy, onReviewed],
  );

  /*
   * The four verbs, on four keys.
   *
   * On the document rather than on the rail, because the person deciding is
   * reading the middle column and their focus is wherever they last clicked —
   * a shortcut that only fires while the rail happens to hold focus is a
   * shortcut nobody discovers. Guarded against firing while someone is typing,
   * and against modifier chords, which belong to the browser and the palette.
   */
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      const action = KEYS[key];
      if (!action) return;
      e.preventDefault();
      void review(action.action, action.overrideTo);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, review]);

  if (!result) {
    return (
      <p className="text-ink-faint text-body-sm">
        Select a test and its verdict, evidence and captures appear here.
      </p>
    );
  }

  if (!verdict) {
    const green = result.status === 'PASSED' || result.status === 'SKIPPED';
    return (
      <>
        <RailHeading title="Triage" />
        <p className="border-line text-ink-faint mt-2 rounded-lg border border-dashed p-3 text-micro">
          {green
            ? 'This test passed, so there is nothing to triage. Verdicts are written for failures.'
            : 'Triage has not produced a verdict yet. It runs on the worker right after the test finishes and needs ANTHROPIC_API_KEY to be set.'}
        </p>
      </>
    );
  }

  const tone = VERDICT_TONE[verdict.verdict] ?? VERDICT_TONE.ENV_ISSUE!;

  return (
    <>
      <div className="flex items-baseline gap-2">
        <h3 className="text-ink-faint text-meta font-mono font-semibold tracking-[0.1em] uppercase">
          Triage
        </h3>
        <span className="text-ink-faint text-meta ml-auto truncate font-mono">{verdict.model}</span>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <span
          className={cn(
            'shrink-0 rounded-sm px-2 py-[3px] font-mono text-micro font-semibold tracking-[0.05em]',
            tone.text,
            tone.tint,
          )}
        >
          {VERDICT_WORD[verdict.verdict] ?? verdict.verdict}
        </span>
        {/* The model's own number, shown as the model states it. A verdict with
            no confidence attached asks the reader to trust it more than it
            earned. */}
        <span className="text-ink-faint font-mono text-micro tabular-nums">
          {verdict.confidence.toFixed(2)} confidence
        </span>
      </div>

      <p className="font-display text-ink-dim mt-3 text-[15px] leading-[1.55] italic">
        {verdict.explanation}
      </p>

      {verdict.evidence.length > 0 && (
        <div className="text-ink-faint mt-3 flex flex-col gap-1.5 font-mono text-[10.5px]">
          {verdict.evidence.map((item, i) => (
            <span key={i} className="break-words">
              → {item.kind} {item.ref} · {item.detail}
            </span>
          ))}
        </div>
      )}

      {pending ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {ACTIONS.map((action) => (
            <button
              key={action.key}
              type="button"
              disabled={busy}
              onClick={() => void review(action.action, action.overrideTo)}
              title={action.title}
              className={cn(
                'inline-flex items-center gap-[7px] rounded-md px-[11px] py-1.5 text-[12px] transition-colors disabled:opacity-50',
                action.primary
                  ? 'bg-accent text-accent-ink font-semibold hover:opacity-90'
                  : 'border-line text-ink-dim hover:text-ink hover:border-line-strong border',
              )}
            >
              <kbd
                className={cn(
                  'rounded-[3px] border px-1 font-mono text-[9.5px]',
                  action.primary
                    ? 'border-[color-mix(in_srgb,var(--color-accent-ink)_35%,transparent)]'
                    : 'border-line',
                )}
              >
                {action.key.toUpperCase()}
              </kbd>
              {action.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-ink-faint mt-4 font-mono text-micro" aria-live="polite">
          reviewed · {verdict.reviewState.toLowerCase()}
        </p>
      )}
    </>
  );
}

interface VerdictAction {
  key: string;
  label: string;
  title: string;
  action: 'accept' | 'override' | 'mute';
  overrideTo?: string;
  primary?: boolean;
}

const ACTIONS: VerdictAction[] = [
  {
    key: 'a',
    label: 'Agree',
    title: 'Accept the verdict as it stands',
    action: 'accept',
    primary: true,
  },
  {
    key: 'f',
    label: 'Flake',
    title: 'Nothing is broken — the test is unreliable',
    action: 'override',
    overrideTo: 'FLAKE',
  },
  {
    key: 'i',
    label: 'Intended',
    title: 'The app changed on purpose and the test is out of date',
    action: 'override',
    overrideTo: 'INTENDED_CHANGE',
  },
  { key: 'm', label: 'Mute', title: 'Stop this one gating, without ruling on it', action: 'mute' },
];

const KEYS: Record<string, VerdictAction> = Object.fromEntries(ACTIONS.map((a) => [a.key, a]));

// ─── Small pieces ────────────────────────────────────────────────────────────

function RailHeading({
  title,
  note,
  toggle,
}: {
  title: string;
  note?: string;
  toggle?: { label: string; onClick: () => void } | null;
}) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <h3 className="text-ink-faint text-meta font-mono font-semibold tracking-[0.1em] uppercase">
        {title}
      </h3>
      {note && <span className="text-ink-faint text-meta font-mono">{note}</span>}
      {toggle && (
        <button
          type="button"
          onClick={toggle.onClick}
          className="text-accent text-meta ml-auto font-mono hover:underline"
        >
          {toggle.label}
        </button>
      )}
    </div>
  );
}

const LEVEL_TONE: Record<string, string> = {
  error: 'text-fail',
  warn: 'text-flake',
  info: 'text-accent',
  debug: 'text-ink-faint',
  log: 'text-ink-faint',
};

/** `err` / `warn` / `inf` — three characters, so the column never reflows. */
const LEVEL_WORD: Record<string, string> = {
  error: 'err',
  warn: 'wrn',
  info: 'inf',
  debug: 'dbg',
  log: 'log',
};

function ConsoleRow({
  entry,
  step,
  first,
}: {
  entry: ConsoleEntry;
  step: EvidenceStep | null;
  first: boolean;
}) {
  const at = new Date(entry.at).getTime();
  const offset = step && !Number.isNaN(at) ? offsetLabel(at, step) : null;
  const isError = entry.level === 'error';
  return (
    <li
      className={cn(
        'flex gap-2 px-2.5 py-1.5',
        !first && 'border-line border-t',
        // The error is the line people came for; everything else is context.
        isError && 'bg-[color-mix(in_srgb,var(--color-fail)_7%,transparent)]',
      )}
    >
      <span className={cn('shrink-0', LEVEL_TONE[entry.level], isError && 'font-semibold')}>
        {LEVEL_WORD[entry.level] ?? entry.level}
      </span>
      <span
        className={cn('min-w-0 flex-1 break-words', isError ? 'text-ink-dim' : 'text-ink-faint')}
      >
        {entry.text}
      </span>
      {offset && <span className="text-ink-faint shrink-0 tabular-nums">{offset}</span>}
    </li>
  );
}

function statusTone(status: number | null): string {
  if (status === null || status >= 500) return 'text-fail';
  if (status >= 400) return 'text-flake';
  if (status >= 300) return 'text-ink-dim';
  return 'text-pass';
}

function NetworkRow({
  entry,
  named,
  first,
}: {
  entry: NetworkEntry;
  named: boolean;
  first: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(entry.responseBodySnippet);
  return (
    <li
      // The request the step actually names gets a rule down its edge. Without
      // it, "the one you asked about" and "a 404 from somewhere else in the
      // test" are the same grey row and the reader has to re-derive which is
      // which every time.
      className={cn(
        !first && 'border-line border-t',
        named && 'border-l-accent border-l-2 bg-[color-mix(in_srgb,var(--color-accent)_5%,transparent)]',
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        // A row with nothing to expand must not look like a button that does
        // nothing when you press it.
        className={cn(
          'flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left',
          hasBody ? 'hover:bg-surface-2 cursor-pointer' : 'cursor-default',
        )}
        aria-expanded={hasBody ? open : undefined}
        title={named ? `${entry.url} — named by this step` : entry.url}
      >
        <span className="text-ink-faint w-[34px] shrink-0">{entry.method}</span>
        <span className={cn('w-[26px] shrink-0 tabular-nums', statusTone(entry.status))}>
          {entry.status ?? '—'}
        </span>
        <span className={cn('min-w-0 flex-1 truncate', named ? 'text-ink' : 'text-ink-dim')}>
          {pathOf(entry.url)}
        </span>
        <span className="text-ink-faint shrink-0 tabular-nums">{duration(entry.durationMs)}</span>
      </button>
      {open && entry.responseBodySnippet && (
        <pre className="bg-surface-2 text-ink-dim mx-2.5 mb-2 max-h-48 overflow-auto rounded-md p-2 text-meta whitespace-pre-wrap">
          {entry.responseBodySnippet}
        </pre>
      )}
    </li>
  );
}
