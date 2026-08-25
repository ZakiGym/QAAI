'use client';

/**
 * One row of the explorer, and nothing else.
 *
 * No data fetching, no menus, no knowledge of what a click will do — every
 * decision arrives as a prop, so the row is a function of its inputs and the
 * panel above it owns the behaviour. That split is what lets `FileTree` be read
 * as a list of rules rather than as a pile of conditionals inside a `map`.
 *
 * THE ROW SETS NO TYPE OF ITS OWN. The column it lives in is mono 11.5px and
 * every row inherits that: a file tree is a list of paths, paths are machine
 * strings, and the size and the face belong to the pane. Only colour, weight and
 * layout are decided here.
 *
 * THE FOLDER ROW OWNS ITS SUBTREE. A folder renders its children inside itself
 * — as `role="group"`, which is what the tree pattern requires — and that
 * nesting is also what makes the sticky header work: a header pinned to the top
 * of the scroller has to stop pushing once its own subtree has scrolled past,
 * and it can only know that if the subtree is an element it contains.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. The drop target is a ring AND a message in
 * the panel's status line; a refused drop is a ring AND the browser's own
 * no-drop cursor. Every badge carries a word (`decorations.ts` decides which),
 * every icon-only control carries a label, and a filter match is underlined as
 * well as tinted.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { MatchRange } from '../../lib/tree/filter';
import { FolderIcon, iconFor } from '../../lib/tree/icons';
import { rowStyle, type Decoration, type LastResultStatus } from '../../lib/tree/decorations';
import type { PanelRow } from '../../lib/tree/rows';
import {
  INDENT,
  ROW_HEIGHT,
  editableName,
  nameSelection,
  rangesForSegments,
} from './useTreeController';

/** How a drop onto this row would end. `none` while nothing is being dragged over it. */
export type DropState = 'none' | 'ok' | 'refused';

export interface TreeRowProps {
  row: PanelRow;
  /** The file open in the editor. */
  active: boolean;
  selected: boolean;
  /** True on the one row that carries the tree's single tab stop. */
  focusable: boolean;
  /** On the clipboard as a cut — still here, but on its way out. */
  cut: boolean;
  /** A folder that exists only in this panel until a file lands in it. */
  pending: boolean;
  dirty: boolean;
  quarantined: boolean;
  lastResult: LastResultStatus | null;
  tintByResult: boolean;
  /** The one badge this row shows, already resolved by `decorations.ts`. */
  decoration: Decoration | null;
  /** Filter hits into `row.name`, or undefined when nothing is being filtered. */
  ranges: MatchRange[] | undefined;
  /** 1-based, for `aria-level`. */
  level: number;
  setSize: number;
  posInSet: number;
  drop: DropState;
  renaming: boolean;
  renameError: string | null;
  draggable: boolean;
  /** Files a `hide` pattern removed from beneath this folder. Never silently zero. */
  hiddenCount: number;
  /**
   * What this folder-shaped row IS, for the screen reader and the tooltips —
   * `folder`, or `suite` when the tree is grouped by suite.
   *
   * A suite row is not a folder and announcing it as one is not a small
   * inaccuracy: "Rename" on it renames a database row, and somebody who cannot
   * see the panel has only this word to tell the two apart.
   */
  dirNoun?: string;
  /**
   * Whether the hover "+" appears. False on a row with no path — a new file
   * "in" a suite heading would silently land at the project root.
   */
  canAdd?: boolean;

  onSelect: (mods: { shift: boolean; meta: boolean; ctrl: boolean }) => void;
  onToggle: (alsoSiblings: boolean) => void;
  /** Click a segment of a compacted label to split the chain there. */
  onSegment?: (path: string) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onAdd: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  /** Registers the element the panel scrolls to and focuses. */
  registerRef: (element: HTMLDivElement | null) => void;
  /** The rows beneath this folder, already rendered. */
  children?: ReactNode;
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={cn('h-2.5 w-2.5 shrink-0 transition-transform', open && 'rotate-90')}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

/**
 * The filter's hits, underlined as well as tinted.
 *
 * Underline rather than a background: at 11.5px in a 150px column a highlight
 * block on two letters of a filename is a smudge, and the underline survives
 * both themes and all three accents without needing a second colour.
 */
export function Highlighted({ text, ranges }: { text: string; ranges?: MatchRange[] }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach((range, index) => {
    if (range.start > at) out.push(text.slice(at, range.start));
    out.push(
      <mark
        key={`${range.start}-${index}`}
        className="text-accent decoration-accent/70 bg-transparent underline underline-offset-2"
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    at = range.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/**
 * Inline rename.
 *
 * Uncontrolled, so every keystroke is not a re-render of the whole tree, and
 * seeded once with the stem preselected — renaming `order.spec.ts` almost never
 * means renaming the `.ts`, and a fully-selected name loses the suffix that
 * decides whether the file is still a test.
 *
 * Blur COMMITS, the way VS Code does. When the commit is refused the panel keeps
 * the editor open with a message, and `error` is in the effect's deps precisely
 * so that focus comes back to the field the person now has to fix.
 */
function RenameInput({
  initial,
  kind,
  error,
  onCommit,
  onCancel,
}: {
  initial: string;
  kind: 'file' | 'dir';
  error: string | null;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    const { start, end } = nameSelection(element.value, kind);
    element.setSelectionRange(start, end);
  }, [kind, error]);

  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <input
        ref={ref}
        defaultValue={initial}
        aria-label={`New name for ${initial}`}
        aria-invalid={error !== null || undefined}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'border-line bg-surface-2 text-ink min-w-0 flex-1 rounded-[3px] border px-1 outline-none',
          'focus:border-accent',
          error && 'border-fail focus:border-fail',
        )}
        style={{ height: ROW_HEIGHT - 4 }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // The tree's keydown handler is an ancestor of this input; without
          // this, typing a name would also be typing at the tree.
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit(event.currentTarget.value);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={(event) => onCommit(event.currentTarget.value)}
      />
      {error && (
        <span role="alert" className="text-fail px-1 whitespace-normal">
          {error}
        </span>
      )}
    </span>
  );
}

/** A compacted folder label, each segment clickable to break the chain there. */
function CompactedLabel({
  row,
  ranges,
  onSegment,
}: {
  row: PanelRow;
  ranges: MatchRange[] | undefined;
  onSegment: (path: string) => void;
}) {
  const node = row.node;
  if (node.kind !== 'dir' || node.source !== 'path' || node.segments.length < 2) {
    return <Highlighted text={row.name} ranges={ranges} />;
  }
  /*
   * The filter's hits are indices into `row.name`, which for this row is the
   * JOINED label — so each one has to be walked back onto the segment it falls in
   * before any of these elements can draw it. Threading `ranges` straight through
   * would mark nothing at all here, and a filter that highlights every row except
   * the compacted ones reads as a filter that missed them.
   */
  const highlights = rangesForSegments(node.segments, ranges);
  return (
    <>
      {node.segments.map((segment, index) => {
        const hit = highlights[index];
        const inside = <Highlighted text={segment.name} ranges={hit?.ranges} />;
        return (
          <span key={segment.path}>
            {index > 0 && (
              <span
                className={cn(
                  'text-ink-faint/60',
                  // A query that ran across the join really did match the '/'.
                  hit?.separatorMatched &&
                    'text-accent decoration-accent/70 underline underline-offset-2',
                )}
              >
                /
              </span>
            )}
            {index === node.segments.length - 1 ? (
              <span>{inside}</span>
            ) : (
              <button
                type="button"
                // The tree is ONE tab stop, and every segment of every compacted
                // row would otherwise be another one — Tab would walk the tree
                // instead of leaving it, which is the exact trap the roving
                // tabindex exists to prevent. The chevron beside it is excluded
                // for the same reason.
                tabIndex={-1}
                // Splitting is the documented purpose of `uncompacted`: this row
                // stands for three folders, and clicking one of them is how you
                // get a row for it back.
                onClick={(event) => {
                  event.stopPropagation();
                  onSegment(segment.path);
                }}
                className="hover:text-ink hover:underline"
                title={`Show ${segment.path}/ as its own row`}
              >
                {inside}
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}

// ─── The row ─────────────────────────────────────────────────────────────────

export function TreeRow(props: TreeRowProps) {
  const {
    row,
    active,
    selected,
    focusable,
    cut,
    pending,
    dirty,
    quarantined,
    lastResult,
    tintByResult,
    decoration,
    ranges,
    level,
    setSize,
    posInSet,
    drop,
    renaming,
    renameError,
    draggable,
    hiddenCount,
    dirNoun = 'folder',
    canAdd = true,
    onSelect,
    onToggle,
    onSegment,
    onContextMenu,
    onAdd,
    onCommitRename,
    onCancelRename,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
    registerRef,
    children,
  } = props;

  const isDir = row.kind === 'dir';
  const open = row.expanded === true;
  const style = rowStyle({
    kind: row.kind,
    active,
    dirty,
    quarantined,
    lastResult,
    tintByResult,
  });

  const label = (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        // Rows nest, and so do their drop targets. Without this a drag hovering
        // a file would also register on every folder above it and on the panel
        // background, and the last handler to run would decide the highlight.
        event.stopPropagation();
        onDragOver(event);
      }}
      onDragLeave={(event) => {
        event.stopPropagation();
        onDragLeave();
      }}
      onDrop={(event) => {
        event.stopPropagation();
        onDrop(event);
      }}
      onClick={(event) =>
        onSelect({ shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey })
      }
      onContextMenu={onContextMenu}
      // A feature group has no path, so there is nothing to show but its name —
      // and appending a slash to it would claim it is a folder, which it is not.
      title={isDir ? (row.path ? `${row.path}/` : row.name) : row.path}
      className={cn(
        'group/row relative flex items-center gap-1 rounded-sm pr-1.5',
        /*
         * THE FOCUS RING BELONGS TO THE ROW, NOT TO THE ROW PLUS ITS SUBTREE.
         *
         * The element that takes focus is the `treeitem` wrapping this one, and
         * for a folder that element CONTAINS the `role="group"` holding every
         * descendant — a ring on it draws a box around the whole open subtree.
         * So the ring is drawn here, on the one line that actually has focus.
         *
         * A DIRECT-CHILD selector, not `group-focus-visible`: a descendant variant
         * matches every nested row's line as well, and focusing one folder would
         * outline all of them at once.
         */
        '[:focus-visible>&]:ring-accent [:focus-visible>&]:ring-1',
        /*
         * The whole subtree scrolls under its own folder heading. It needs an
         * opaque background of its own or the rows passing beneath show through,
         * and it is listed FIRST so a selected folder's own background still
         * wins — `cn` resolves the conflict in favour of the later class.
         */
        isDir && 'bg-surface sticky',
        style.className,
        selected && !active && 'bg-surface-1',
        cut && 'opacity-45',
        drop === 'ok' && 'ring-accent bg-accent/10 ring-1',
        drop === 'refused' && 'ring-fail bg-fail/10 cursor-not-allowed ring-1',
      )}
      style={{
        height: ROW_HEIGHT,
        paddingLeft: level * INDENT,
        ...(isDir ? { top: (level - 1) * ROW_HEIGHT, zIndex: Math.max(1, 20 - level) } : {}),
      }}
    >
      {/* Indent guides: one hairline per level already stepped over. */}
      {Array.from({ length: Math.max(0, level - 1) }, (_, step) => (
        <span
          key={step}
          aria-hidden
          className="bg-line absolute top-0 bottom-0 w-px"
          style={{ left: step * INDENT + 6 }}
        />
      ))}

      {isDir ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${row.name}`}
          title={`${open ? 'Collapse' : 'Expand'} ${row.name} (Alt-click for the whole level)`}
          // Alt-click folds the whole level — the fastest way back to an
          // overview once four things inside one folder are open.
          onClick={(event) => {
            event.stopPropagation();
            onToggle(event.altKey);
          }}
          className="hover:text-ink flex shrink-0 items-center"
        >
          <Chevron open={open} />
        </button>
      ) : (
        <span className="w-2.5 shrink-0" aria-hidden />
      )}

      <span className="flex shrink-0 items-center">
        {isDir ? (
          <FolderIcon open={open} decorative className="text-ink-faint" />
        ) : (
          iconFor(row.path, row.node.kind === 'file' ? row.node.test.type : null)
        )}
      </span>

      {renaming ? (
        <RenameInput
          initial={editableName(row)}
          kind={row.kind}
          error={renameError}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {isDir && onSegment ? (
            <CompactedLabel row={row} ranges={ranges} onSegment={onSegment} />
          ) : (
            <Highlighted text={row.name} ranges={ranges} />
          )}
        </span>
      )}

      {pending && (
        <span className="text-ink-faint shrink-0" title="Not saved — add a file to keep this folder">
          unsaved
        </span>
      )}

      {hiddenCount > 0 && (
        <span
          className="text-ink-faint shrink-0 tabular-nums"
          title={`${hiddenCount} hidden by a hide pattern`}
        >
          {`+${hiddenCount}`}
        </span>
      )}

      {decoration && (
        <span
          role="img"
          aria-label={decoration.label}
          title={decoration.label}
          className={cn('shrink-0 leading-none tabular-nums', decoration.className)}
        >
          {decoration.glyph}
          {decoration.showCount ? decoration.count : ''}
        </span>
      )}

      {isDir && canAdd && !renaming && (
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            onAdd();
          }}
          title={`New file in ${row.name}/`}
          aria-label={`New file in ${row.name}/`}
          className="hover:text-ink shrink-0 px-1 leading-none opacity-0 group-hover/row:opacity-100 focus:opacity-100"
        >
          +
        </button>
      )}
    </div>
  );

  /*
   * The accessible name is spelled out for folders because the treeitem CONTAINS
   * its group: left to the name-from-contents rule, a folder would announce
   * itself as every filename underneath it.
   */
  const ariaLabel = isDir
    ? [`${row.name} ${dirNoun}`, decoration?.label, hiddenCount > 0 ? `${hiddenCount} hidden` : null]
        .filter(Boolean)
        .join(', ')
    : undefined;

  const shared = {
    ref: registerRef,
    role: 'treeitem' as const,
    'aria-selected': selected,
    'aria-level': level,
    'aria-setsize': setSize,
    'aria-posinset': posInSet,
    // One tab stop for the whole tree; the arrows move a roving focus inside it.
    tabIndex: focusable ? 0 : -1,
    'data-row-id': row.id,
  };

  if (!isDir) {
    return (
      <div
        {...shared}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        className="rounded-sm outline-none"
      >
        {label}
      </div>
    );
  }

  return (
    <div
      {...shared}
      aria-expanded={open}
      aria-label={ariaLabel}
      className="relative rounded-sm outline-none"
    >
      {label}
      {open && children ? <div role="group">{children}</div> : null}
    </div>
  );
}
