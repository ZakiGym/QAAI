'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { iconFor } from '../../lib/tree/icons';
import { FileMenu, type MenuItem } from '../FileMenu';
import { parseTreeDrag } from '../tree/useTreeController';
import {
  TAB_DRAG_MIME,
  TREE_DRAG_MIME,
  activateTab,
  applyTabMenuAction,
  closeTab,
  dragKindFor,
  insertionIndex,
  moveTab,
  promoteTab,
  tabAccessibleName,
  tabById,
  tabMenuItems,
  type Tab,
  type TabMenuAction,
  type TabsState,
} from './tabs';

/**
 * The strip of open files.
 *
 * Every decision about WHAT the tabs do lives in `tabs.ts`; this file draws
 * them and turns gestures into calls. It holds exactly three pieces of state of
 * its own, and each is about the pointer or the keyboard rather than about the
 * editor: which tab has keyboard focus, where a drag would land, and where the
 * context menu is open. Everything else arrives as a prop and leaves as
 * `onChange`.
 *
 * ── It scrolls, it does not wrap ────────────────────────────────────────────
 *
 * A wrapping tab bar changes height as you open files, which moves the editor
 * underneath it and re-lays out Monaco. Twelve open files would push the code
 * down by two rows. So the strip is one line that scrolls, the active tab is
 * kept in view, and the toolbar the parent passes in stays put on the right.
 *
 * ── Keyboard ────────────────────────────────────────────────────────────────
 *
 * ONE tab stop for the whole strip — the same rule the explorer follows.
 * Arrow keys move focus between tabs without switching file (manual activation:
 * switching loads a buffer, and doing that on every arrow press would make
 * walking the strip a series of editor mounts). Enter or Space switches.
 * Delete or Backspace closes. Shift-F10 and the Menu key open the context menu
 * on the focused tab, which is where the pin, "close others" and "close to the
 * right" verbs live for anyone not using a mouse.
 *
 * The close ✕ is deliberately NOT its own tab stop. It carries a real
 * accessible name and is reachable with a pointer; giving it focus would double
 * the number of stops in a strip that can hold twenty files, and ARIA forbids
 * focusable descendants inside a `tab` anyway.
 */

// ─── Icons ───────────────────────────────────────────────────────────────────

/*
 * Two glyphs, on the same 16-unit grid and the same stroke weight as
 * `lib/tree/icons.tsx`, so a tab's file icon and its close button look like
 * they came from one set. `currentColor` throughout: the colour is decided by
 * the tab's state, in tokens, one level up.
 */

function CloseGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M4.5 4.5l7 7M11.5 4.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PinGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M9.6 1.9l4.5 4.5-1.6 1.6-1-.3-2.4 2.4.4 2.3-1.2 1.2-5.9-5.9 1.2-1.2 2.3.4L8.3 4.5l-.3-1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M4.2 11.8L1.6 14.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface TabStripProps {
  /** The whole tab model for THIS editor group. */
  state: TabsState;
  /** Every result of a state-machine call. The parent owns the value. */
  onChange: (next: TabsState) => void;

  /**
   * `id` of the element rendering the active file, for `aria-controls`. Give
   * the editor pane the same id and a screen reader can move between the tab
   * and what it controls.
   */
  panelId?: string;
  /** A name for the strip itself; matters once there are two of them. */
  label?: string;

  /**
   * Is this the focused editor group? Purely presentational — an unfocused
   * strip's active tab is drawn quieter so the two panes of a split can be told
   * apart. Defaults to true, which is right for a single strip.
   */
  focused?: boolean;
  /** Any pointer or keyboard interaction here; the split view uses it to follow focus. */
  onFocusGroup?: () => void;

  /**
   * Test ids dropped onto the strip from the tree, with the gap they landed in.
   * Only the parent knows a test's path, so it resolves them and calls
   * `openTab` itself — see the note on `readDrop`.
   */
  onDropTests?: (testIds: string[], index: number) => void;
  /**
   * How to read a tree drag's payload. The default reads `TREE_DRAG_MIME` —
   * the explorer's row payload — and returns the test ids in it; override it if
   * another surface ever drags something else onto the strip.
   */
  readDrop?: (data: DataTransfer) => string[];

  /**
   * Vetoable close. Return false to stop the close and handle it yourself —
   * this is how the unsaved-changes dialog gets a word in. Called for every
   * close route: the ✕, the middle click, Delete, and the menu.
   */
  onBeforeClose?: (tab: Tab) => boolean;

  /** The two menu verbs `tabs.ts` refuses to answer on its own. */
  onCopyPath?: (tab: Tab) => void;
  onSplitRight?: (tab: Tab) => void;

  /** Pinned to the right of the strip — the parent's Run button and friends. */
  actions?: ReactNode;
  className?: string;
}

// ─── Reading a drag ──────────────────────────────────────────────────────────

/**
 * The default payload reader — the explorer's own payload, read with the
 * explorer's own parser.
 *
 * Only `TREE_DRAG_MIME`. The old `text/plain` fallback looked generous and was
 * not: every drag in existence carries plain text, so the strip accepted
 * selected prose, links and anything else that passed over it, then found no
 * ids on drop and did nothing. `parseTreeDrag` is imported rather than
 * reimplemented because that string crosses an operating-system boundary and
 * every field of it has to be checked; a second, looser reader here would be
 * the one that crashes on a payload from another version of the app.
 *
 * Folder rows carry no `testId` and are dropped: a folder is not a file to
 * open, and the payload holds the dragged rows rather than their descendants,
 * so there is nothing here to expand it into.
 */
function defaultReadDrop(data: DataTransfer): string[] {
  const payload = parseTreeDrag(data.getData(TREE_DRAG_MIME));
  if (!payload) return [];
  const ids: string[] = [];
  for (const row of payload.rows) {
    if (row.testId !== null && !ids.includes(row.testId)) ids.push(row.testId);
  }
  return ids;
}

/**
 * Can this drag land here at all?
 *
 * Answered from `types` rather than from the data, because `getData` returns
 * an empty string during `dragover` in every browser — the payload is only
 * readable on drop. A target that tried to inspect the content to decide
 * whether to call `preventDefault` would refuse every drag. The rule itself is
 * in `tabs.ts`, where it can be tested.
 */
function dragKind(data: DataTransfer | null): 'tab' | 'tests' | null {
  return data ? dragKindFor(Array.from(data.types)) : null;
}

// ─── The component ───────────────────────────────────────────────────────────

export function TabStrip({
  state,
  onChange,
  panelId,
  label = 'Open files',
  focused = true,
  onFocusGroup,
  onDropTests,
  readDrop = defaultReadDrop,
  onBeforeClose,
  onCopyPath,
  onSplitRight,
  actions,
  className,
}: TabStripProps) {
  const { tabs, activeId } = state;

  /** The roving tab stop. Follows the active tab until the arrows move it. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** Where a drop would insert, as a gap index, or null when nothing is over us. */
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);
  /** Live DOM nodes, keyed by tab id — the drop geometry reads their rects. */
  const nodes = useRef(new Map<string, HTMLElement>());
  /**
   * The tab being dragged, remembered from `dragstart`.
   *
   * Kept in a ref rather than in state: it is read inside `dragover`, which
   * fires many times a second, and re-rendering the whole strip on each one to
   * store a value nothing draws would be pure waste.
   */
  const draggingId = useRef<string | null>(null);

  const roving =
    focusedId !== null && tabs.some((tab) => tab.id === focusedId)
      ? focusedId
      : (activeId ?? tabs[0]?.id ?? null);

  /*
   * Keep the active tab on screen.
   *
   * ⌃Tab and ⌘P can both make a tab active that is scrolled out of the strip,
   * and a tab bar that shows a different file from the editor below it is worse
   * than no tab bar. `nearest` rather than `center` so a tab already in view is
   * left where it is instead of jumping to the middle on every switch.
   */
  useEffect(() => {
    if (activeId === null) return;
    nodes.current.get(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  /*
   * Move focus into the context menu when it opens.
   *
   * `FileMenu` positions itself at the pointer and does not manage focus — fine
   * for a right-click, useless for Shift-F10, where focus would stay on a tab
   * behind a menu the user cannot reach. Focusing the first enabled item makes
   * the menu keyboard-operable without a second menu implementation in the app.
   */
  useEffect(() => {
    if (!menu) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
  }, [menu]);

  // ── Verbs ──────────────────────────────────────────────────────────────────

  const emit = useCallback(
    (next: TabsState) => {
      onFocusGroup?.();
      onChange(next);
    },
    [onChange, onFocusGroup],
  );

  /** Every close route funnels here so the dirty veto cannot be bypassed. */
  const requestClose = useCallback(
    (id: string) => {
      const tab = tabById(state, id);
      if (!tab) return;
      if (onBeforeClose && !onBeforeClose(tab)) return;
      emit(closeTab(state, id));
    },
    [state, onBeforeClose, emit],
  );

  const runMenuAction = useCallback(
    (action: TabMenuAction, id: string) => {
      const tab = tabById(state, id);
      if (!tab) return;

      // The two the state machine hands back — they need something it has no
      // business touching. Everything else it answers itself.
      if (action === 'copyPath') return onCopyPath?.(tab);
      if (action === 'splitRight') return onSplitRight?.(tab);
      if (action === 'close') return requestClose(id);

      const next = applyTabMenuAction(state, action, id);
      if (next) emit(next);
    },
    [state, onCopyPath, onSplitRight, requestClose, emit],
  );

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return [];
    return tabMenuItems(state, menu.id).map((item) => ({
      label: item.label,
      disabled: !item.enabled,
      ...(item.separatorBefore === true ? { separated: true } : {}),
      onSelect: () => runMenuAction(item.action, menu.id),
    }));
  }, [menu, state, runMenuAction]);

  const openMenuAt = useCallback((id: string, x: number, y: number) => {
    setFocusedId(id);
    setMenu({ id, x, y });
  }, []);

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const current = roving;
      if (current === null) return;
      const index = tabs.findIndex((tab) => tab.id === current);
      if (index === -1) return;

      const moveFocus = (to: number) => {
        const next = tabs[(to + tabs.length) % tabs.length];
        if (!next) return;
        event.preventDefault();
        setFocusedId(next.id);
        nodes.current.get(next.id)?.focus();
      };

      switch (event.key) {
        case 'ArrowRight':
          return moveFocus(index + 1);
        case 'ArrowLeft':
          return moveFocus(index - 1);
        case 'Home':
          return moveFocus(0);
        case 'End':
          return moveFocus(tabs.length - 1);
        case 'Enter':
        case ' ':
          event.preventDefault();
          return emit(activateTab(state, current));
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          return requestClose(current);
        case 'ContextMenu': {
          event.preventDefault();
          const rect = nodes.current.get(current)?.getBoundingClientRect();
          return openMenuAt(current, rect?.left ?? 0, rect?.bottom ?? 0);
        }
        case 'F10':
          if (event.shiftKey) {
            event.preventDefault();
            const rect = nodes.current.get(current)?.getBoundingClientRect();
            openMenuAt(current, rect?.left ?? 0, rect?.bottom ?? 0);
          }
          return;
        default:
          return;
      }
    },
    [roving, tabs, state, emit, requestClose, openMenuAt],
  );

  // ── Dragging ───────────────────────────────────────────────────────────────

  /** The gap a pointer at `clientX` is over, from the live tab midpoints. */
  const gapAt = useCallback(
    (clientX: number): number => {
      const centers = tabs.map((tab) => {
        const rect = nodes.current.get(tab.id)?.getBoundingClientRect();
        return rect ? rect.left + rect.width / 2 : Number.POSITIVE_INFINITY;
      });
      return insertionIndex(centers, clientX);
    },
    [tabs],
  );

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const kind = dragKind(event.dataTransfer);
      if (kind === null) return;
      if (kind === 'tests' && !onDropTests) return;
      // Without this the browser refuses the drop and animates it back.
      event.preventDefault();
      event.dataTransfer.dropEffect = kind === 'tab' ? 'move' : 'copy';
      setDropIndex(gapAt(event.clientX));
    },
    [gapAt, onDropTests],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const kind = dragKind(event.dataTransfer);
      const index = dropIndex ?? gapAt(event.clientX);
      setDropIndex(null);
      if (kind === null) return;
      event.preventDefault();

      if (kind === 'tab') {
        const id = event.dataTransfer.getData(TAB_DRAG_MIME) || draggingId.current;
        if (id) emit(moveTab(state, id, index));
        return;
      }
      const ids = readDrop(event.dataTransfer);
      if (ids.length > 0) onDropTests?.(ids, index);
    },
    [dropIndex, gapAt, state, emit, readDrop, onDropTests],
  );

  /**
   * Leaving the strip clears the caret — but `dragleave` also fires on every
   * move between children, so a naive handler makes the caret flicker off and
   * on. Checking that the pointer really left the container is what stops that.
   */
  const onDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDropIndex(null);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className={cn(
        'border-line bg-surface flex min-w-0 shrink-0 items-stretch border-b',
        className,
      )}
    >
      <div
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
        onMouseDown={onFocusGroup}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeId;
          const isRoving = tab.id === roving;
          return (
            /*
              No wrapper element around this one: a `tablist` must own `tab`
              children directly, and a positioning div between them is exactly
              the kind of thing that quietly turns a real tab list into a row of
              anonymous boxes. The drop caret is an absolutely positioned child
              of the tab instead.

              The close and pin buttons ARE interactive descendants of a `tab`,
              which ARIA discourages. It is the same trade every shipping tab
              bar makes — the alternative is a tab strip with no visible close
              control — and it is paid for here: neither button is a tab stop,
              both carry a real accessible name, and every verb they perform is
              also on the keyboard-reachable context menu.
            */
            <div
              key={tab.id}
              ref={(node) => {
                if (node) nodes.current.set(tab.id, node);
                else nodes.current.delete(tab.id);
              }}
              role="tab"
              id={`tab-${tab.id}`}
              /*
                An explicit name, because a computed one is assembled from this
                element's contents — which include a close button and, on a
                pinned tab, a pin button. Without it the tab announces as
                "order-total.spec.ts Close order-total.spec.ts". The states
                italics and the dot carry visually are folded into the name
                here; the buttons keep their own names for anyone who reaches
                them with a pointer or in browse mode.
              */
              aria-label={tabAccessibleName(tab)}
              aria-selected={isActive}
              {...(panelId ? { 'aria-controls': panelId } : {})}
              tabIndex={isRoving ? 0 : -1}
              title={`${tab.path}${tab.preview ? ' (preview)' : ''}`}
              draggable
              onFocus={() => setFocusedId(tab.id)}
              onClick={() => emit(activateTab(state, tab.id))}
              onDoubleClick={() => emit(promoteTab(activateTab(state, tab.id), tab.id))}
              onAuxClick={(event) => {
                // Middle click closes, everywhere a tab exists.
                if (event.button === 1) {
                  event.preventDefault();
                  requestClose(tab.id);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenuAt(tab.id, event.clientX, event.clientY);
              }}
              onDragStart={(event) => {
                draggingId.current = tab.id;
                event.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
                event.dataTransfer.setData('text/plain', tab.path);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                draggingId.current = null;
                setDropIndex(null);
              }}
              className={cn(
                'group/tab border-line text-micro relative flex max-w-56 min-w-0 shrink-0 cursor-pointer',
                'items-center gap-1.5 border-r px-2.5 py-1.5 font-mono select-none',
                // The active tab is a raised surface with a rule along its top
                // edge — two channels, so it is still legible where the accent
                // is the only thing carrying it.
                isActive
                  ? 'bg-surface-1 text-ink'
                  : 'text-ink-faint hover:bg-surface-1/60 hover:text-ink-dim',
                isActive &&
                  (focused
                    ? "before:bg-accent before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:content-['']"
                    : "before:bg-line-strong before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:content-['']"),
              )}
            >
              {dropIndex === index && <DropCaret side="left" />}
              {dropIndex === index + 1 && index === tabs.length - 1 && <DropCaret side="right" />}

              {tab.pinned && (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Unpin ${tab.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    runMenuAction('unpin', tab.id);
                  }}
                  className="text-accent hover:text-ink shrink-0"
                >
                  <PinGlyph className="size-3" />
                </button>
              )}

              {iconFor(tab.path, null, { className: 'size-3.5 shrink-0', decorative: true })}

              {/*
                  Italic is a typographic signal and a weak one for anybody not
                  comparing two tabs side by side — so preview, pinned and dirty
                  are all said in words by `tabAccessibleName` above. They used
                  to be `sr-only` spans here, which put them in the tab's
                  computed name in strip order rather than in a sentence, and
                  left them stranded once the name became explicit.
                */}
              <span className={cn('truncate', tab.preview && 'italic')}>{tab.label}</span>

              <button
                type="button"
                tabIndex={-1}
                aria-label={
                  tab.dirty ? `Close ${tab.label}, unsaved changes` : `Close ${tab.label}`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  requestClose(tab.id);
                }}
                className="hover:text-ink ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm"
              >
                {tab.dirty ? (
                  <>
                    {/*
                        The dot and the ✕ share one control, as they do in VS
                        Code: the dot says there is something to lose, and
                        reaching for it reveals the thing that would lose it.
                      */}
                    <span
                      aria-hidden="true"
                      className="text-accent text-body-sm leading-none group-hover/tab:hidden group-focus-within/tab:hidden"
                    >
                      ●
                    </span>
                    <CloseGlyph className="hidden size-3.5 group-hover/tab:block group-focus-within/tab:block" />
                  </>
                ) : (
                  <CloseGlyph className="size-3.5 opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100" />
                )}
              </button>
            </div>
          );
        })}

        {/* The empty strip still has to be a drop target, or the first file
            dragged from the tree into an empty editor lands nowhere. It also
            has to SAY so: the caret above is drawn relative to a tab, and with
            no tabs neither branch of it exists, so a drag over an empty strip
            showed no target at all — the one case where the user has least
            reason to believe the drop will work. */}
        {tabs.length === 0 && (
          <span className="text-ink-faint text-micro relative flex items-center px-3 py-1.5">
            {dropIndex !== null && <DropCaret side="left" />}
            No files open
          </span>
        )}
      </div>

      {actions && <div className="flex shrink-0 items-center gap-2 px-2">{actions}</div>}

      {menu && (
        <div ref={menuRef}>
          <FileMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
        </div>
      )}
    </div>
  );
}

/** Where a drop would land. A rule, not a tint — it reads at any tab width. */
function DropCaret({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-accent absolute inset-y-1 z-10 w-0.5',
        side === 'left' ? 'left-0' : 'right-0',
      )}
    />
  );
}
