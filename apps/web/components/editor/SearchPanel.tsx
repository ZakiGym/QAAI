'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';

/**
 * ⌘⇧F — search every test file in the project.
 *
 * It lives in the left column, opposite the tree, because that is where the
 * space already is: putting search over the code would cover the only thing on
 * the screen you are searching for.
 *
 * The query goes to the server rather than being run over a list already in the
 * browser. The tests list the shell loads for ⌘P carries names and paths and no
 * `code` at all — quick-open never needed it — so a client-side search would
 * either match on filenames only (which is ⌘P again, not search) or fetch every
 * file to grep it, which is one request per test for a query that usually
 * matches three lines. See the endpoint's own note for what it will not do.
 *
 * Case and whole-word are offered. A regular expression is not: Node cannot
 * interrupt a running match, so one pathological pattern would take the API
 * down for every tenant, and an option that has to be rate-limited into
 * uselessness is worse than an option that was never drawn.
 */

interface SearchMatch {
  line: number;
  /** Where the hit starts in `text`, or -1 when it falls past the line cap. */
  column: number;
  length: number;
  text: string;
}

interface SearchFile {
  testId: string;
  name: string;
  filePath: string;
  type: string;
  /** Every hit in the file — `matches` is capped, this is not. */
  matchCount: number;
  matches: SearchMatch[];
}

interface SearchResponse {
  query: string;
  files: SearchFile[];
  totalMatches: number;
  truncated: boolean;
}

export interface SearchPanelProps {
  projectId: string;
  /**
   * Bumped every time ⌘⇧F is pressed. The panel may already be open with a
   * query in it, and the shortcut has to put the caret back in the box and
   * select what is there — pressing it twice is how you start a new search.
   */
  focusTick: number;
  onOpenMatch: (testId: string, line: number) => void;
}

/** Long enough that typing does not fire a request per keystroke. */
const DEBOUNCE_MS = 220;

export function SearchPanel({ projectId, focusTick, onOpenMatch }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  const run = useCallback(
    async (signal: AbortSignal) => {
      const trimmed = query.trim();
      if (!projectId || !trimmed) {
        setResult(null);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: trimmed });
        if (matchCase) params.set('case', '1');
        if (wholeWord) params.set('word', '1');
        const data = await api<SearchResponse>(
          `/projects/${projectId}/search?${params.toString()}`,
          { signal },
        );
        if (signal.aborted) return;
        setResult(data);
        setError(null);
        // A new result set arrives expanded: collapsing is something you do to
        // a file you have already looked at.
        setCollapsed(new Set());
      } catch (err) {
        // An aborted request is the NEXT keystroke, not a failure to report.
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setResult(null);
        setError(err instanceof ApiError ? err.message : 'Could not search this project');
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [projectId, query, matchCase, wholeWord],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void run(controller.signal), DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [run]);

  const toggleFile = (filePath: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });

  const files = result?.files ?? [];
  /** Rows actually rendered — not `totalMatches`, which is what was counted. */
  const shown = files.reduce((sum, file) => sum + file.matches.length, 0);

  return (
    <div className="flex min-h-0 flex-col whitespace-normal">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Escape clears rather than closes: the panel is a column, not an
          // overlay, and there is nothing behind it to get back to.
          if (event.key === 'Escape' && query) {
            event.stopPropagation();
            setQuery('');
          }
        }}
        placeholder="Search all files"
        aria-label="Search all files"
        spellCheck={false}
        className="border-line bg-surface-1 text-ink placeholder:text-ink-faint focus:border-line-strong w-full rounded-md border px-2 py-[5px] font-mono text-[11.5px] outline-none"
      />

      <div className="mt-1.5 flex items-center gap-1">
        <Toggle
          label="Aa"
          title="Match case"
          active={matchCase}
          onClick={() => setMatchCase((v) => !v)}
        />
        <Toggle
          label="ab"
          title="Match whole word"
          active={wholeWord}
          onClick={() => setWholeWord((v) => !v)}
        />
        <span aria-live="polite" className="text-ink-faint ml-auto text-[10.5px]">
          {loading
            ? 'Searching…'
            : result
              ? result.totalMatches === 0
                ? 'No results'
                : `${result.totalMatches} in ${files.length} file${files.length === 1 ? '' : 's'}`
              : ''}
        </span>
      </div>

      {error && <p className="text-fail mt-2 text-[11px] leading-relaxed">{error}</p>}

      {!error && !query.trim() && (
        <p className="text-ink-faint mt-3 text-[11px] leading-relaxed">
          Searches the code of every test in this project — the same text the editor shows you, so a
          spec-driven test is searched as the JSON you would edit.
        </p>
      )}

      {result?.truncated && (
        <p className="text-flake mt-2 text-[10.5px] leading-relaxed">
          {/*
            `totalMatches` is what the server COUNTED, and the rows below are
            what it returned — the two differ whenever a cap bites, so the
            sentence names the shown count and the counted one separately.
            Saying "showing the first {totalMatches}" was wrong in exactly the
            case the banner exists for.
          */}
          Showing {shown.toLocaleString()} of {result.totalMatches.toLocaleString()} matches.
          Narrow the query to see the rest.
        </p>
      )}

      <div className="mt-2 min-h-0 flex-1">
        {files.map((file) => {
          const open = !collapsed.has(file.filePath);
          const dir = file.filePath.split('/').slice(0, -1).join('/');
          const base = file.filePath.split('/').pop() ?? file.filePath;
          return (
            <div key={file.testId} className="mb-1">
              <button
                type="button"
                onClick={() => toggleFile(file.filePath)}
                aria-expanded={open}
                title={file.filePath}
                className="hover:bg-surface-1 flex w-full items-center gap-1 rounded-sm py-[1px] pr-1 text-left"
              >
                <span
                  aria-hidden
                  className={cn('text-ink-faint shrink-0 transition-transform', open && 'rotate-90')}
                >
                  ▸
                </span>
                <span className="text-ink-dim min-w-0 truncate">{base}</span>
                {dir && <span className="text-ink-faint min-w-0 shrink truncate">{dir}</span>}
                <span className="text-ink-faint ml-auto shrink-0 tabular-nums">
                  {file.matchCount}
                </span>
              </button>

              {open &&
                file.matches.map((match) => (
                  <button
                    key={`${file.testId}:${match.line}:${match.column}`}
                    type="button"
                    onClick={() => onOpenMatch(file.testId, match.line)}
                    title={`${file.filePath}:${match.line}`}
                    className="hover:bg-surface-1 flex w-full items-baseline gap-1.5 rounded-sm py-[1px] pr-1 pl-4 text-left"
                  >
                    <span className="text-ink-faint w-6 shrink-0 text-right tabular-nums">
                      {match.line}
                    </span>
                    <span className="text-ink-dim min-w-0 flex-1 truncate">
                      <Highlight text={match.text} at={match.column} length={match.length} />
                    </span>
                  </button>
                ))}

              {/* The per-file cap. Said out loud rather than silently dropped. */}
              {open && file.matchCount > file.matches.length && (
                <p className="text-ink-faint py-[1px] pl-4 text-[10.5px]">
                  +{file.matchCount - file.matches.length} more in this file
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Toggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'rounded-sm border px-1.5 py-[1px] text-[10.5px] transition-colors',
        active
          ? 'border-accent text-ink bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]'
          : 'border-line text-ink-faint hover:text-ink-dim',
      )}
    >
      {label}
    </button>
  );
}

/** The matched characters, in the accent. `at` is -1 when the server could not place it. */
function Highlight({ text, at, length }: { text: string; at: number; length: number }) {
  if (at < 0 || at >= text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="text-ink bg-[color-mix(in_srgb,var(--color-accent)_30%,transparent)]">
        {text.slice(at, at + length)}
      </span>
      {text.slice(at + length)}
    </>
  );
}
