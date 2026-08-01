'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { relativeTime } from './ui';
import { Badge, SectionLabel, Skeleton } from './ui/layout';
import { cn } from '../lib/cn';

/**
 * "What moved since this test last passed?"
 *
 * The evidence rail already shows the failure screenshot, and a screenshot is
 * the wrong instrument for the most common failure there is: a control that
 * kept every pixel and lost its accessible name. This panel reads the DOM from
 * the failing run and the DOM from the last green run and says the sentence out
 * loud — "this button moved and lost its accessible name" — with the changes
 * the test's own locators touch pulled to the top.
 *
 * Three things it deliberately does NOT do.
 *
 * It never renders an empty list as reassurance. "No baseline" and "nothing
 * changed" look identical if you are careless with empty states, and they mean
 * opposite things during triage, so every unavailable case prints its own
 * reason.
 *
 * It never hides the filter. The API drops volatile attributes to keep the diff
 * under a hundred lines instead of four hundred, and the footer says exactly
 * which ones and how often — a filter you cannot see is a filter you cannot
 * trust.
 *
 * It never substitutes a red baseline for a green one silently. When the last
 * green run kept no DOM, the panel offers the comparison as an explicit,
 * labelled choice, because "changed since it passed" and "changed since it last
 * failed" support opposite conclusions.
 */

// ─── The shape GET /dom-diff/:resultId returns ───────────────────────────────
//
// Declared here rather than in lib/api.ts, which this change does not own. They
// belong there next time that file is opened.

type ChangeKind =
  | 'REMOVED'
  | 'ADDED'
  | 'NAME_CHANGED'
  | 'ROLE_CHANGED'
  | 'TESTID_CHANGED'
  | 'ID_CHANGED'
  | 'MOVED'
  | 'HIDDEN'
  | 'REVEALED'
  | 'DISABLED'
  | 'ENABLED'
  | 'TEXT_CHANGED';

interface ElementRef {
  tag: string;
  role: string;
  name: string;
  nameSource: string;
  testId: string | null;
  id: string | null;
  text: string;
  path: string;
  hidden: boolean;
  disabled: boolean;
}

interface DomChange {
  kind: ChangeKind;
  summary: string;
  before: ElementRef | null;
  after: ElementRef | null;
  matchedLocators: string[];
  touchedByTest: boolean;
  actionTarget: boolean;
  score: number;
}

interface IgnoredAttribute {
  attribute: string;
  occurrences: number;
  reason: string;
}

interface Diff {
  changes: DomChange[];
  findingCount: number;
  contextCount: number;
  truncated: number;
  counts: { before: number; after: number; matched: number };
  ignoredAttributes: IgnoredAttribute[];
  before: { url: string; label: string };
  after: { url: string; label: string };
  urlsComparable: boolean;
}

interface ResultSummary {
  resultId: string;
  runId: string;
  status: string;
  runStatus: string;
  environment: string;
  commitSha: string | null;
  branch: string | null;
  queuedAt: string;
  finishedAt: string | null;
  hasSnapshot: boolean;
}

interface DomDiffResponse {
  result: ResultSummary;
  test: { id: string; name: string; filePath: string };
  basis: 'explicit' | 'last-green' | 'none';
  basisReason: string;
  lastGreen: ResultSummary | null;
  alternative: ResultSummary | null;
  baseline?: ResultSummary;
  locators?: string[];
  diff: Diff | null;
  unavailable: { reason: string; detail: string } | null;
}

// ─── Presentation ────────────────────────────────────────────────────────────

/**
 * Tone by consequence, not by category.
 *
 * `fail` is reserved for the changes that make a locator return nothing —
 * gone, renamed, re-roled, re-test-id'd. Hidden and disabled are amber because
 * they fail differently (a timeout, not a lookup miss) and that distinction is
 * the first thing you need when reading a stack trace.
 */
const KIND_TONE: Record<ChangeKind, 'fail' | 'flake' | 'accent' | 'neutral'> = {
  REMOVED: 'fail',
  NAME_CHANGED: 'fail',
  ROLE_CHANGED: 'fail',
  TESTID_CHANGED: 'fail',
  HIDDEN: 'flake',
  DISABLED: 'flake',
  ID_CHANGED: 'flake',
  MOVED: 'accent',
  TEXT_CHANGED: 'accent',
  ADDED: 'neutral',
  REVEALED: 'neutral',
  ENABLED: 'neutral',
};

const KIND_LABEL: Record<ChangeKind, string> = {
  REMOVED: 'gone',
  ADDED: 'new',
  NAME_CHANGED: 'renamed',
  ROLE_CHANGED: 'role',
  TESTID_CHANGED: 'test id',
  ID_CHANGED: 'id',
  MOVED: 'moved',
  HIDDEN: 'hidden',
  REVEALED: 'revealed',
  DISABLED: 'disabled',
  ENABLED: 'enabled',
  TEXT_CHANGED: 'text',
};

/** Short, stable handle for a run. The sha if there is one, else the id tail. */
function runHandle(summary: ResultSummary): string {
  if (summary.commitSha) return summary.commitSha.slice(0, 7);
  return summary.runId.slice(-6);
}

function whenLabel(summary: ResultSummary): string {
  return relativeTime(summary.finishedAt ?? summary.queuedAt);
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-line text-ink-dim text-micro rounded-md border border-dashed p-3 leading-relaxed">
      {children}
    </p>
  );
}

/**
 * One element, as a line you can scan.
 *
 * The path is NOT on this line. It was, and in the rail's width it won a
 * tug-of-war with the accessible name — the one field you actually recognise an
 * element by — leaving `span [order-total] $5… html>body>main>div>div:nth-o…`.
 * The path is how you find the element in dev tools afterwards, so it sits
 * underneath, once, and only expands to two lines when it is the thing that
 * changed.
 */
function ElementLine({ element, tone }: { element: ElementRef; tone: 'before' | 'after' }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 font-mono">
      <span
        className={cn('text-meta w-7 shrink-0', tone === 'before' ? 'text-ink-faint' : 'text-ink-dim')}
      >
        {tone === 'before' ? 'was' : 'now'}
      </span>
      <span className="text-ink-dim text-micro shrink-0">
        {element.role || element.tag.toLowerCase()}
      </span>
      {element.testId && <span className="text-accent text-micro shrink-0">[{element.testId}]</span>}
      {element.name && <span className="text-ink text-micro min-w-0 truncate">"{element.name}"</span>}
      {!element.name && element.text && (
        <span className="text-ink-dim text-micro min-w-0 truncate">{element.text}</span>
      )}
      {element.hidden && <span className="text-flake text-meta shrink-0">hidden</span>}
      {element.disabled && <span className="text-flake text-meta shrink-0">disabled</span>}
    </div>
  );
}

function PathLine({ path, prefix }: { path: string; prefix?: string }) {
  return (
    <div className="text-ink-faint text-meta flex min-w-0 gap-1.5 font-mono">
      {prefix && <span className="w-7 shrink-0">{prefix}</span>}
      {/*
       * Wrapped and clamped rather than truncated. A single-line truncation
       * loses the tail, and the tail (`…>span:nth-of-type(2)`) is the half that
       * identifies the element; reversing the text direction to save the tail
       * instead reorders the brackets. Two lines is honest and always correct.
       */}
      <span className="line-clamp-2 min-w-0 break-all" title={path}>
        {path}
      </span>
    </div>
  );
}

function ChangeCard({ change, finding }: { change: DomChange; finding: boolean }) {
  const { before, after } = change;
  const movedPath = Boolean(before && after && before.path !== after.path);

  return (
    <li
      className={cn(
        'rounded-md border p-2.5',
        finding ? 'border-line-strong bg-surface-1' : 'border-line/60',
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={KIND_TONE[change.kind]} mono>
          {KIND_LABEL[change.kind]}
        </Badge>
        {change.actionTarget && (
          <Badge tone="accent" mono>
            action target
          </Badge>
        )}
        {change.matchedLocators.map((locator) => (
          <code
            key={locator}
            className="text-accent text-meta min-w-0 truncate font-mono"
            title={locator}
          >
            {locator}
          </code>
        ))}
      </div>

      <p className={cn('text-body-sm leading-relaxed', finding ? 'text-ink' : 'text-ink-dim')}>
        {change.summary}
      </p>

      {(before || after) && (
        <div className="border-line/60 mt-2 space-y-0.5 border-t pt-2">
          {before && <ElementLine element={before} tone="before" />}
          {movedPath && before && <PathLine path={before.path} prefix="at" />}
          {after && <ElementLine element={after} tone="after" />}
          {movedPath && after && <PathLine path={after.path} prefix="at" />}
          {!movedPath && <PathLine path={(after ?? before)!.path} />}
        </div>
      )}
    </li>
  );
}

// ─── The panel ───────────────────────────────────────────────────────────────

export function DomDiff({ resultId }: { resultId: string }) {
  const [data, setData] = useState<DomDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Set only when the user explicitly asked for a non-green baseline. */
  const [against, setAgainst] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [showFiltered, setShowFiltered] = useState(false);

  const load = useCallback(
    async (baselineId: string | null, cancelled?: () => boolean) => {
      setLoading(true);
      setError(null);
      try {
        const query = baselineId ? `?against=${encodeURIComponent(baselineId)}` : '';
        const response = await api<DomDiffResponse>(`/dom-diff/${resultId}${query}`);
        if (cancelled?.()) return;
        setData(response);
      } catch (err) {
        if (cancelled?.()) return;
        // A rendering problem must never look like "nothing changed".
        setError(err instanceof Error ? err.message : 'The DOM diff could not be loaded');
      } finally {
        if (!cancelled?.()) setLoading(false);
      }
    },
    [resultId],
  );

  useEffect(() => {
    let dead = false;
    void load(against, () => dead);
    return () => {
      dead = true;
    };
  }, [load, against]);

  // Switching test results has to clear an explicitly chosen baseline, or the
  // next result silently inherits the previous one's comparison.
  useEffect(() => {
    setAgainst(null);
    setShowContext(false);
  }, [resultId]);

  if (loading && !data) {
    return (
      <section className="mt-6">
        <SectionLabel>DOM vs last green</SectionLabel>
        <div className="space-y-2" role="status" aria-label="Loading DOM diff">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="mt-6">
        <SectionLabel>DOM vs last green</SectionLabel>
        <Note>
          {error}{' '}
          <button
            type="button"
            onClick={() => void load(against)}
            className="text-accent underline decoration-dotted underline-offset-2"
          >
            Try again
          </button>
        </Note>
      </section>
    );
  }

  if (!data) return null;

  const { diff, unavailable, baseline, alternative, lastGreen } = data;

  // The heading is a claim about what was compared, so it has to follow the
  // baseline. Saying "vs last green" over a red baseline the user picked
  // themselves would be the panel lying in its own title.
  const heading = baseline && baseline.status !== 'PASSED' ? 'DOM vs baseline' : 'DOM vs last green';

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-ink-dim text-micro font-semibold tracking-wider uppercase">{heading}</h3>
        {diff && (
          <span className="text-ink-faint text-meta font-mono tabular-nums">
            {diff.findingCount + diff.contextCount}
          </span>
        )}
        {loading && <span className="text-ink-faint text-meta ml-auto">refreshing…</span>}
      </div>

      {/* What this was compared against, always, before anything else. */}
      {baseline ? (
        <p className="text-ink-dim text-micro mb-3 leading-relaxed">
          Compared against{' '}
          <span className="text-ink font-mono">{runHandle(baseline)}</span>
          {baseline.branch && <span className="text-ink-faint font-mono"> ({baseline.branch})</span>}{' '}
          — the test{' '}
          <span className={baseline.status === 'PASSED' ? 'text-pass' : 'text-fail'}>
            {baseline.status === 'PASSED' ? 'passed' : baseline.status.toLowerCase()}
          </span>{' '}
          there, {whenLabel(baseline)}. {data.basisReason}
        </p>
      ) : null}

      {/*
       * The reason, whenever there is one — including when a baseline WAS
       * named. An explicitly chosen run that turns out to have kept no trace
       * would otherwise render as "Compared against e07vlt" followed by an
       * empty panel, which reads as "and nothing changed".
       */}
      {unavailable && (
        <div className="mb-3 space-y-2">
          <Note>{unavailable.detail}</Note>
          {!baseline && lastGreen && !lastGreen.hasSnapshot && (
            <p className="text-ink-faint text-meta">
              Last green: <span className="font-mono">{runHandle(lastGreen)}</span>,{' '}
              {whenLabel(lastGreen)}.
            </p>
          )}
          {alternative && (
            <button
              type="button"
              onClick={() => setAgainst(alternative.resultId)}
              className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-micro rounded-md border px-2.5 py-1.5"
            >
              Compare against {runHandle(alternative)} instead — it{' '}
              {alternative.status === 'PASSED' ? 'passed' : 'also failed'}, {whenLabel(alternative)}
            </button>
          )}
        </div>
      )}

      {against && (
        <button
          type="button"
          onClick={() => setAgainst(null)}
          className="text-ink-faint hover:text-accent text-micro mb-3 underline decoration-dotted underline-offset-2"
        >
          Back to the automatic baseline
        </button>
      )}

      {diff && (
        <>
          {!diff.urlsComparable && (
            <div className="border-flake/40 bg-flake/10 text-ink-dim text-micro mb-3 rounded-md border p-2.5 leading-relaxed">
              These two snapshots are of different pages —{' '}
              <span className="font-mono">{diff.before.url}</span> and{' '}
              <span className="font-mono">{diff.after.url}</span>. Almost everything below will
              differ for that reason alone, so read it as “the run ended somewhere else”, not as a
              list of regressions.
            </div>
          )}

          {diff.changes.length === 0 ? (
            <Note>
              Nothing changed in the accessibility shape of{' '}
              <span className="font-mono">{diff.after.url}</span> — same{' '}
              <span className="tabular-nums">{diff.counts.after}</span> elements, same roles, names,
              positions and states as when this test passed. The failure is somewhere other than the
              markup: timing, data, or the network.
            </Note>
          ) : (
            <>
              {diff.findingCount > 0 && (
                <>
                  <p className="text-ink-faint text-meta mb-1.5">
                    Your test&rsquo;s locators touch{' '}
                    <span className="tabular-nums">{diff.findingCount}</span> of these.
                  </p>
                  <ul className="space-y-2">
                    {diff.changes
                      .filter((change) => change.touchedByTest || change.actionTarget)
                      .map((change, index) => (
                        <ChangeCard key={`${change.kind}-${index}`} change={change} finding />
                      ))}
                  </ul>
                </>
              )}

              {diff.findingCount === 0 && (
                <Note>
                  {diff.contextCount} element
                  {diff.contextCount === 1 ? '' : 's'} changed, but none of them is one this
                  test&rsquo;s locators look for
                  {data.locators?.length
                    ? ` (${data.locators.length} locator${data.locators.length === 1 ? '' : 's'} read from the spec)`
                    : ' — no locators could be read from the spec, so nothing could be ranked against it'}
                  . The cause may still be below.
                </Note>
              )}

              {diff.contextCount > 0 && (
                <div className={diff.findingCount > 0 ? 'mt-3' : 'mt-2'}>
                  <button
                    type="button"
                    onClick={() => setShowContext((open) => !open)}
                    aria-expanded={showContext}
                    className="text-ink-faint hover:text-accent text-micro underline decoration-dotted underline-offset-2"
                  >
                    {showContext ? 'Hide' : 'Show'} {diff.contextCount} other change
                    {diff.contextCount === 1 ? '' : 's'} as context
                  </button>
                  {showContext && (
                    <ul className="mt-2 space-y-2">
                      {diff.changes
                        .filter((change) => !change.touchedByTest && !change.actionTarget)
                        .map((change, index) => (
                          <ChangeCard key={`ctx-${change.kind}-${index}`} change={change} finding={false} />
                        ))}
                    </ul>
                  )}
                  {diff.truncated > 0 && (
                    <p className="text-ink-faint text-meta mt-1.5">
                      <span className="tabular-nums">{diff.truncated}</span> further change
                      {diff.truncated === 1 ? '' : 's'} were not listed — at that volume the page was
                      rewritten, not edited.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {/*
           * The filter, made visible. This is the panel's own claim about what
           * it chose not to show you, and it has to be checkable.
           */}
          <div className="border-line/60 mt-4 border-t pt-2.5">
            <p className="text-ink-faint text-meta tabular-nums">
              {diff.counts.matched} of {diff.counts.before} elements matched across the two
              snapshots.
            </p>
            {diff.ignoredAttributes.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowFiltered((open) => !open)}
                  aria-expanded={showFiltered}
                  className="text-ink-faint hover:text-accent text-meta mt-1 underline decoration-dotted underline-offset-2"
                >
                  {showFiltered ? 'Hide' : 'Show'} the {diff.ignoredAttributes.length} attribute
                  {diff.ignoredAttributes.length === 1 ? '' : 's'} this diff ignored
                </button>
                {showFiltered && (
                  <dl className="border-line mt-2 rounded-md border p-2.5">
                    {diff.ignoredAttributes.map((entry) => (
                      <div key={entry.attribute} className="flex gap-2 py-0.5">
                        <dt className="text-ink-dim text-meta w-32 shrink-0 font-mono">
                          {entry.attribute}
                          <span className="text-ink-faint ml-1 tabular-nums">
                            ×{entry.occurrences}
                          </span>
                        </dt>
                        <dd className="text-ink-faint text-meta min-w-0 flex-1">{entry.reason}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
