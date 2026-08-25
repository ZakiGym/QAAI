'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DiffEditor, type Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { cn } from '../../lib/cn';
import { EDITOR_THEME, defineTokenTheme } from './theme';

/**
 * Two test files, side by side, diffed.
 *
 * Monaco ships a diff editor, so this does not compute a diff: it hands two
 * buffers to `DiffEditor` and gets syntax highlighting, word-level intra-line
 * highlights, folded unchanged regions and a synchronised scroll for free. A
 * hand-rolled differ would be a week of work to arrive somewhere worse, in a
 * pane that then looked like a foreign widget dropped into the editor.
 *
 * ── One theme, defined once ─────────────────────────────────────────────────
 *
 * It installs `EDITOR_THEME` through `defineTokenTheme`, the same theme the
 * main editor runs on, rather than defining a diff-specific one. A second
 * theme is not a second look — Monaco keys themes by name and the last
 * `defineTheme` for a name wins globally, so two definitions mean the palette
 * in force is decided by mount order. That exact bug is what `theme.ts` was
 * written to end, and the comment at the top of that file is the record of it.
 *
 * The consequence worth naming: the red/green diff tints are inherited from
 * Monaco's `vs`/`vs-dark` base rather than being token-derived. Adding
 * `diffEditor.*` keys belongs in `theme.ts`, beside the rest of the palette,
 * not in a private override here.
 */

export interface DiffViewProps {
  /** The left-hand side — what it was. */
  original: string;
  /** The right-hand side — what it is. */
  modified: string;

  /** Names for the two sides. Shown in the header and read out by the labels. */
  originalLabel?: string;
  modifiedLabel?: string;

  language?: string;

  /**
   * Side by side needs width; inline reads better in a narrow pane. Optional
   * and controlled-if-supplied, like `SplitEditor`'s ratio — leave it off and
   * the header's own toggle drives it.
   */
  inline?: boolean;
  defaultInline?: boolean;
  onInlineChange?: (inline: boolean) => void;

  /** Swap the two sides. The button only appears when this is given. */
  onSwap?: () => void;

  /** The right-hand side is editable when a change handler is supplied. */
  onModifiedChange?: (value: string) => void;

  /**
   * Bump to re-derive the theme from the tokens in force.
   *
   * The palette is read from CSS custom properties at define time, so a theme
   * or accent switch while a diff is open leaves Monaco on the old colours
   * until something re-defines it. The parent already knows when that happened.
   */
  themeTick?: number;

  /** Hide the header when the surrounding surface already labels the diff. */
  showHeader?: boolean;
  className?: string;
}

export function DiffView({
  original,
  modified,
  originalLabel = 'Original',
  modifiedLabel = 'Modified',
  language = 'typescript',
  inline,
  defaultInline = false,
  onInlineChange,
  onSwap,
  onModifiedChange,
  themeTick,
  showHeader = true,
  className,
}: DiffViewProps) {
  const [internalInline, setInternalInline] = useState(defaultInline);
  const isInline = inline ?? internalInline;
  const monacoRef = useRef<Monaco | null>(null);

  const setInline = useCallback(
    (next: boolean) => {
      if (inline === undefined) setInternalInline(next);
      onInlineChange?.(next);
    },
    [inline, onInlineChange],
  );

  /*
   * Defined before the first paint, for the reason CodeEditor's own comment
   * gives: doing it on mount means one frame in Monaco's stock palette, which
   * in the light theme is a near-black panel flashing into view.
   */
  const beforeMount = useCallback((monaco: Monaco) => {
    monacoRef.current = monaco;
    defineTokenTheme(monaco);
  }, []);

  useEffect(() => {
    if (themeTick === undefined) return;
    if (monacoRef.current) defineTokenTheme(monacoRef.current);
  }, [themeTick]);

  /*
   * The live handler and the value the parent last gave us, read from inside a
   * subscription that is made once and never re-made.
   *
   * `onMount` fires exactly once, so anything it closes over is frozen at that
   * moment. A handler captured then would be the handler from the first render
   * — and since a parent almost always passes an inline arrow, that one closes
   * over first-render state and writes stale text back. Worse, a handler that
   * arrived AFTER mount would never be subscribed at all while `readOnly`
   * turned false on the same render: a pane the user can type into that drops
   * every keystroke on the floor.
   *
   * Assigned during render rather than in an effect, and that is deliberate:
   * `DiffEditor` pushes a new `modified` prop into the model from ITS effect,
   * and a child's effects run before its parent's — so an effect here would
   * still be holding the previous value at the moment the change fires, and the
   * guard below would mistake the parent's own write for a user edit.
   */
  const changeRef = useRef(onModifiedChange);
  changeRef.current = onModifiedChange;
  const modifiedRef = useRef(modified);
  modifiedRef.current = modified;

  const onMount = useCallback((diff: editor.IStandaloneDiffEditor) => {
    /*
     * `DiffEditor` has no `onChange`, so the change stream is taken from the
     * modified editor's own model — always, so that editability can be turned
     * on later — and disposed with the editor, because the subscription
     * outlives the render that made it.
     */
    const right = diff.getModifiedEditor();
    const sub = right.onDidChangeModelContent(() => {
      const value = right.getValue();
      // This fires for the parent's own writes too, when a new `modified` prop
      // is pushed into the model. Echoing those straight back would report an
      // edit nobody made, and in a controlled parent that is a render loop.
      if (value === modifiedRef.current) return;
      changeRef.current?.(value);
    });
    diff.onDidDispose(() => sub.dispose());
  }, []);

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      {showHeader && (
        <div className="border-line text-micro flex shrink-0 items-center gap-2 border-b px-3 py-1.5 font-mono">
          <span className="text-ink-faint truncate" title={originalLabel}>
            {originalLabel}
          </span>
          <span aria-hidden="true" className="text-ink-faint">
            →
          </span>
          <span className="text-ink truncate" title={modifiedLabel}>
            {modifiedLabel}
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onSwap && (
              <button
                type="button"
                onClick={onSwap}
                className="text-ink-faint hover:text-ink rounded-sm px-1.5 py-0.5"
              >
                Swap sides
              </button>
            )}
            {/*
              A pressed toggle rather than two buttons: the layout is one
              setting with two values, and `aria-pressed` says which is in force
              without relying on which of them looks highlighted.
            */}
            <button
              type="button"
              aria-pressed={!isInline}
              onClick={() => setInline(false)}
              className={cn(
                'rounded-sm px-1.5 py-0.5',
                isInline ? 'text-ink-faint hover:text-ink' : 'bg-surface-2 text-ink',
              )}
            >
              Side by side
            </button>
            <button
              type="button"
              aria-pressed={isInline}
              onClick={() => setInline(true)}
              className={cn(
                'rounded-sm px-1.5 py-0.5',
                isInline ? 'bg-surface-2 text-ink' : 'text-ink-faint hover:text-ink',
              )}
            >
              Inline
            </button>
          </div>
        </div>
      )}

      <div
        className="min-h-0 flex-1"
        role="group"
        aria-label={`Differences between ${originalLabel} and ${modifiedLabel}`}
      >
        <DiffEditor
          height="100%"
          language={language}
          original={original}
          modified={modified}
          beforeMount={beforeMount}
          onMount={onMount}
          theme={EDITOR_THEME}
          loading={<span className="text-ink-faint text-body-sm">Loading diff…</span>}
          options={{
            renderSideBySide: !isInline,
            readOnly: !onModifiedChange,
            originalEditable: false,
            // Matched to CodeEditor so the two panes are the same product.
            fontSize: 12.5,
            lineHeight: 22,
            fontFamily: 'var(--font-mono)',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderOverviewRuler: false,
            // Whitespace-only churn in a generated spec is noise nobody reviews.
            ignoreTrimWhitespace: true,
            // Collapse the untouched middle of a long file, but keep enough
            // either side of a change to see which test it is in.
            hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
            padding: { top: 10, bottom: 10 },
          }}
        />
      </div>
    </div>
  );
}

/**
 * `components/DiffView.tsx` also exports a `DiffView` — the older one used by
 * heal proposals and version history. A file that needs both would have to
 * rename an import; this alias is the cheaper half of that.
 */
export { DiffView as EditorDiffView };
