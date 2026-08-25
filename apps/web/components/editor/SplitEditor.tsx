'use client';

import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { MIN_PANE, SPLITTER_SIZE, clampRatio, nudgeRatio, ratioFromPointer } from './tabs';

/**
 * Two editors, side by side, with a splitter between them.
 *
 * ── Why the editor arrives as a function ────────────────────────────────────
 *
 * `children` is `(pane) => ReactNode` rather than an import of `CodeEditor`,
 * and that is a structural choice rather than a stylistic one. This component
 * would otherwise depend on Monaco, its Playwright type stubs, the locator
 * completion provider and everything those reach — for a job that is entirely
 * about two boxes and a draggable rule between them. The parent already owns
 * the wiring each pane needs (its buffer, its dirty flag, its save handler),
 * so it renders the editor and this arranges it.
 *
 * ── Focus follows the pane you click ────────────────────────────────────────
 *
 * Which pane is "current" decides where the next ⌘P, ⌘S or ⌃Tab lands, so it
 * has to track the pointer and the caret rather than being something you set in
 * a menu. Both are captured on the way down (`onFocusCapture`,
 * `onPointerDownCapture`) so a click that lands inside Monaco — which stops
 * plenty of events itself — still registers here first.
 *
 * The focused pane is named as such in its accessible label as well as being
 * drawn brighter, because "which half am I typing into" is exactly the kind of
 * state that must not be carried by a border colour alone.
 */

export type PaneIndex = 0 | 1;

export interface SplitEditorProps {
  /** One pane, or two. A single pane draws no splitter at all. */
  split: boolean;
  /** Which pane is current. Controlled, so ⌘1 / ⌘2 can move it from outside. */
  focusedPane: PaneIndex;
  onFocusPane: (pane: PaneIndex) => void;

  /** `columns` puts the panes side by side (the default); `rows` stacks them. */
  layout?: 'columns' | 'rows';

  /**
   * The split position, as pane 0's share of the box.
   *
   * Optional and controlled-if-supplied: leave it off and the component keeps
   * its own, which is what a parent that does not persist the layout wants.
   * `onRatioChange` fires either way, so persisting it later costs one prop.
   */
  ratio?: number;
  defaultRatio?: number;
  onRatioChange?: (ratio: number) => void;

  /** The editor for a pane. Called once per visible pane. */
  children: (pane: PaneIndex) => ReactNode;

  /** Names the two panes for a screen reader, e.g. `['Left', 'Right']`. */
  paneLabels?: readonly [string, string];
  className?: string;
}

export function SplitEditor({
  split,
  focusedPane,
  onFocusPane,
  layout = 'columns',
  ratio,
  defaultRatio = 0.5,
  onRatioChange,
  children,
  paneLabels = ['Primary editor', 'Secondary editor'],
  className,
}: SplitEditorProps) {
  const [internal, setInternal] = useState(() => clampRatio(defaultRatio));
  const controlled = ratio !== undefined;
  const current = clampRatio(controlled ? ratio : internal);

  const boxRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const columns = layout === 'columns';

  const setRatio = useCallback(
    (next: number) => {
      const value = clampRatio(next);
      if (!controlled) setInternal(value);
      onRatioChange?.(value);
    },
    [controlled, onRatioChange],
  );

  /**
   * Drag with pointer capture rather than window listeners.
   *
   * Capture is what keeps the splitter receiving moves once the pointer has
   * left it — which it does immediately, because dragging a 5px rule means
   * being off it. It also guarantees the matching `pointerup`, so a drag that
   * ends outside the window cannot leave the splitter stuck to the cursor.
   */
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const box = boxRef.current?.getBoundingClientRect();
      if (!box) return;
      /*
       * The splitter's own thickness is passed in, not folded into the box: the
       * panes share `width - SPLITTER_SIZE`, so a ratio taken over the full
       * width puts pane 0's edge where the pointer is not.
       */
      setRatio(
        columns
          ? ratioFromPointer(event.clientX, box.left, box.width, SPLITTER_SIZE)
          : ratioFromPointer(event.clientY, box.top, box.height, SPLITTER_SIZE),
      );
    },
    [dragging, columns, setRatio],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const next = nudgeRatio(current, event.key, event.shiftKey);
      // `null` is a key this control does not own — Tab above all, which must
      // stay a way out of the splitter rather than a way to resize it.
      if (next === null) return;
      event.preventDefault();
      setRatio(next);
    },
    [current, setRatio],
  );

  const pane = (index: PaneIndex, grow: number): ReactNode => {
    const focused = split && index === focusedPane;
    const style: CSSProperties = { flexGrow: grow, flexBasis: 0 };
    return (
      <div
        role="group"
        aria-label={`${paneLabels[index]}${focused ? ' (focused)' : ''}`}
        style={style}
        onFocusCapture={() => onFocusPane(index)}
        onPointerDownCapture={() => onFocusPane(index)}
        className={cn(
          'relative flex min-h-0 min-w-0 flex-col',
          // Only ever drawn when there are two panes to tell apart; a lone pane
          // has nothing to be brighter than.
          split && !focused && 'opacity-90',
        )}
      >
        {children(index)}
      </div>
    );
  };

  if (!split) {
    return (
      <div className={cn('flex min-h-0 min-w-0 flex-1', className)} ref={boxRef}>
        {pane(0, 1)}
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className={cn(
        'flex min-h-0 min-w-0 flex-1',
        columns ? 'flex-row' : 'flex-col',
        // A drag that wanders over the editor must not start selecting its text.
        dragging && 'cursor-grabbing select-none',
        className,
      )}
    >
      {pane(0, current)}

      <div
        role="separator"
        tabIndex={0}
        aria-orientation={columns ? 'vertical' : 'horizontal'}
        aria-label="Resize editor panes"
        aria-valuenow={Math.round(current * 100)}
        aria-valuemin={Math.round(MIN_PANE * 100)}
        aria-valuemax={Math.round((1 - MIN_PANE) * 100)}
        aria-valuetext={`${Math.round(current * 100)}% to the ${columns ? 'left' : 'top'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setRatio(0.5)}
        onKeyDown={onKeyDown}
        style={columns ? { width: SPLITTER_SIZE } : { height: SPLITTER_SIZE }}
        className={cn(
          'bg-line shrink-0 touch-none',
          // The hit area is the whole 5px rule; the hover tint is what says so.
          columns ? 'cursor-col-resize' : 'cursor-row-resize',
          dragging ? 'bg-accent' : 'hover:bg-line-strong',
        )}
      />

      {pane(1, 1 - current)}
    </div>
  );
}
