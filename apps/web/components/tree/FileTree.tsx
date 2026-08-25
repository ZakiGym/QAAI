'use client';

/**
 * The editor's file explorer.
 *
 * Supersedes `components/FileTree.tsx`, which was a folder tree and nothing
 * else. This one is the panel: multi-select, drag and drop, cut/copy/paste,
 * inline rename, undo, a filter, folder scoping, sort and grouping menus, and a
 * keyboard that can reach all of it.
 *
 * It is deliberately thin. Every decision lives in `useTreeController` (and, one
 * layer under that, in `lib/tree/*`), so what remains here is the three things
 * that genuinely need a DOM: rendering rows, moving focus, and opening menus.
 *
 * THE PANEL IS ONE TAB STOP. `role="tree"` with roving `tabindex`: the lead row
 * carries `tabIndex={0}` and every other row `-1`, so Tab enters and leaves the
 * explorer in one press and the arrow keys move inside it. A tab stop per row
 * in a project with four hundred files is a keyboard trap with a nice name.
 *
 * IT SETS NO TYPE OF ITS OWN. The column it lives in is mono 11.5px and every
 * row inherits it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { FileMenu, type MenuItem } from '../FileMenu';
import type { PanelRow } from '../../lib/tree/rows';
import { TreeRow, type DropState } from './TreeRow';
import { TreeToolbar } from './TreeToolbar';
import {
  useTreeController,
  type RowNode,
  type TreeControllerOptions,
  type TreeTestRow,
} from './useTreeController';

export type { TreeTestRow } from './useTreeController';

export interface FileTreeProps extends TreeControllerOptions {
  /** Mirror the panel's status line somewhere else — the editor's status bar, say. */
  onStatus?: (message: string) => void;
}

/**
 * How long a second click on the already-selected row waits before it becomes a
 * rename. Long enough that a slow double-click to open a file does not trip it,
 * short enough to feel deliberate — the same window VS Code uses.
 */
const SLOW_CLICK_MS = 500;

export function FileTree(props: FileTreeProps) {
  const { onStatus, ...options } = props;
  const tree = useTreeController(options);

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const treeRef = useRef<HTMLDivElement>(null);
  const slowClick = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSlowClick = useCallback(() => {
    if (slowClick.current === null) return;
    clearTimeout(slowClick.current);
    slowClick.current = null;
  }, []);

  useEffect(() => cancelSlowClick, [cancelSlowClick]);

  /*
   * Mirror the status line, keyed on the VALUE and never on the callback.
   *
   * `onStatus` is written inline by nearly every caller, so its identity changes
   * on each parent render — depending on it would re-push the same sentence into
   * the editor's status bar every time anything above re-rendered, which reads as
   * the panel shouting about a gesture that finished minutes ago. The ref keeps
   * the newest callback reachable without making it a trigger.
   */
  const statusSink = useRef(onStatus);
  useEffect(() => {
    statusSink.current = onStatus;
  }, [onStatus]);
  useEffect(() => {
    if (tree.status) statusSink.current?.(tree.status);
  }, [tree.status]);

  /*
   * Reveal: scroll the row into view, and take focus ONLY if the tree already
   * had it. Auto-reveal fires whenever the editor changes file, including when
   * the change came from a tab click or a link in the triage screen — pulling
   * focus back to the explorer then would move the caret out from under someone
   * who was about to type.
   */
  const revealTick = tree.reveal?.tick;
  const revealId = tree.reveal?.id;
  useEffect(() => {
    if (!revealId) return;
    const element = rowRefs.current.get(revealId);
    if (!element) return;
    element.scrollIntoView({ block: 'nearest' });
    const inside = treeRef.current?.contains(document.activeElement);
    if (inside) element.focus({ preventScroll: true });
  }, [revealId, revealTick]);

  // ── The context menu ──────────────────────────────────────────────────────

  const openMenu = useCallback(
    (event: React.MouseEvent, row: PanelRow) => {
      event.preventDefault();
      cancelSlowClick();
      // Right-clicking outside the selection makes that row the selection, so
      // the menu always acts on what is highlighted.
      if (!tree.selection.ids.has(row.id)) tree.selectRow(row.id);

      const isDir = row.kind === 'dir';
      const selected = tree.selection.ids.size;
      const many = selected > 1 && tree.selection.ids.has(row.id);
      const subject = many ? `${selected} items` : isDir ? `${row.name}/` : row.name;
      const scoped = tree.prefs.scope !== null;

      const items: MenuItem[] = [];

      if (isDir) {
        items.push({ label: 'New file…', onSelect: () => tree.addFile(row.path) });
        items.push({
          label: 'New folder…',
          onSelect: () => tree.newFolder(row.path),
          disabled: !tree.structural,
        });
      } else {
        items.push({ label: 'Open', onSelect: () => tree.openRow(row) });
      }

      items.push({
        label: isDir ? 'Run this folder' : 'Run this file',
        onSelect: () => tree.runFolder(row),
        disabled: !props.onRunTests,
        separated: true,
      });
      items.push({
        label: isDir ? 'Find in folder' : 'Find in this folder',
        onSelect: () => tree.findInFolder(row),
        disabled: !props.onFindInFolder,
      });

      /*
       * Compare, offered only when the selection is exactly two files. A diff
       * of one thing or of three is not a diff, and an item that explains that
       * after you click it is worse than one that says so by being unavailable.
       */
      const comparable = tree.rows
        .filter((r) => r.kind === 'file' && tree.selection.ids.has(r.id))
        .map((r) => r.nodeId);
      items.push({
        label:
          comparable.length === 2
            ? 'Compare the two selected files'
            : 'Compare — select two files',
        onSelect: () => props.onCompare?.(comparable[0]!, comparable[1]!),
        disabled: !props.onCompare || comparable.length !== 2,
      });
      if (isDir) {
        /*
         * Scope to the folder the ROW ACTS ON, as every other action on it does.
         * A compacted row labelled `a/b/c` has `nodeId === 'a'` — the outermost
         * link of the chain, kept as the id so the row survives being expanded —
         * while its `path` is `a/b/c`. Scoping by the id would answer "Set as
         * root" on `a/b/c` by rooting the tree at `a`. A path folder's id IS its
         * path before compaction, which is when `buildTree` resolves the scope, so
         * the deep path resolves. A feature group has no path at all and can only
         * be addressed by its `feature:` id.
         */
        const node = row.node;
        const scopeId = node.kind === 'dir' && node.source === 'path' ? row.path : row.nodeId;
        items.push({
          label: 'Set as root',
          onSelect: () => tree.setScope(scopeId),
          disabled: node.kind !== 'dir',
        });
      }
      if (scoped) items.push({ label: 'Clear root', onSelect: () => tree.setScope(null) });

      items.push({
        label: `Rename ${subject}`,
        onSelect: () => tree.beginRename(row.id),
        disabled: many || !tree.structural,
        separated: true,
      });
      if (!isDir) {
        items.push({
          label: 'Duplicate',
          onSelect: () => tree.doDuplicate(row.id),
          disabled: many,
        });
      }
      items.push({ label: `Cut ${subject}`, onSelect: () => tree.doCut(), disabled: !tree.structural });
      items.push({ label: `Copy ${subject}`, onSelect: () => tree.doCopy(), disabled: !tree.structural });
      items.push({
        label: 'Paste here',
        onSelect: () => tree.doPaste(row.id),
        disabled: tree.clipboard === null || !tree.structural,
      });

      items.push({ label: 'Copy path', onSelect: () => tree.copyPath(row, false), separated: true });
      // Only when it would say something different: unscoped, every path in this
      // app is already project-relative, and two identical menu items is worse
      // than one honest one.
      if (scoped) {
        items.push({ label: 'Copy relative path', onSelect: () => tree.copyPath(row, true) });
      }

      items.push({
        label: isDir ? `Delete ${row.name}/ and everything in it` : `Delete ${subject}`,
        onSelect: () => tree.doDelete(),
        danger: true,
        separated: true,
      });

      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [cancelSlowClick, props.onFindInFolder, props.onRunTests, props.onCompare, tree],
  );

  // ── Rows ──────────────────────────────────────────────────────────────────

  const onSelect = useCallback(
    (row: PanelRow, mods: { shift: boolean; meta: boolean; ctrl: boolean }) => {
      const plain = !mods.shift && !mods.meta && !mods.ctrl;
      /*
       * Slow double-click to rename, and only on FILES. A single click on a
       * folder toggles it, so the same gesture there would open a rename box on
       * a row that just moved under the cursor. Measured before the click is
       * applied: the second click of the pair lands on a row that was already
       * the sole selection.
       */
      const wasSole =
        plain &&
        row.kind === 'file' &&
        tree.selection.lead === row.id &&
        tree.selection.ids.size === 1;

      cancelSlowClick();
      tree.clickRow(row, mods);

      if (wasSole && tree.renamingId === null && tree.structural) {
        slowClick.current = setTimeout(() => {
          slowClick.current = null;
          tree.beginRename(row.id);
        }, SLOW_CLICK_MS);
      }
    },
    [cancelSlowClick, tree],
  );

  const renderNode = useCallback(
    (node: RowNode, index: number, siblings: number): ReactNode => {
      const { row } = node;
      const isDir = row.kind === 'dir';
      const file = row.node.kind === 'file' ? (row.node.test as TreeTestRow) : null;
      const dragging = tree.drag.over && tree.drag.overRowId === row.id;
      const drop: DropState = dragging ? (tree.drag.ok ? 'ok' : 'refused') : 'none';
      const compacted =
        isDir && row.node.kind === 'dir' && (row.node.segments?.length ?? 0) > 1
          ? tree.splitCompacted
          : undefined;

      return (
        <TreeRow
          key={row.id}
          row={row}
          active={!isDir && options.openTestId === row.nodeId}
          selected={tree.selection.ids.has(row.id)}
          focusable={tree.focusableId === row.id}
          cut={tree.clipboardCutIds.has(row.id)}
          pending={isDir && tree.pendingPaths.has(row.path)}
          dirty={!isDir && options.dirtyTestId === row.nodeId}
          quarantined={file?.quarantined === true}
          lastResult={file?.lastStatus ?? null}
          tintByResult={tree.prefs.tintByResult}
          decoration={tree.decorations.get(row.id) ?? null}
          // The filter keys its ranges on the MODEL id, which is the node's, not
          // the row's namespaced one. Two id spaces; `rows.ts` says why.
          ranges={tree.ranges.get(row.nodeId)}
          level={row.depth + 1}
          setSize={siblings}
          posInSet={index + 1}
          drop={drop}
          renaming={tree.renamingId === row.id}
          renameError={tree.renamingId === row.id ? tree.renameError : null}
          draggable={tree.structural && tree.renamingId !== row.id}
          hiddenCount={row.node.kind === 'dir' ? row.node.hiddenCount : 0}
          onSelect={(mods) => onSelect(row, mods)}
          onToggle={(alsoSiblings) => tree.toggleDir(row, alsoSiblings)}
          {...(compacted ? { onSegment: compacted } : {})}
          onContextMenu={(event) => openMenu(event, row)}
          onAdd={() => tree.addFile(row.path)}
          onCommitRename={(name) => tree.commitRename(row.id, name)}
          onCancelRename={tree.cancelRename}
          onDragStart={(event) => {
            cancelSlowClick();
            tree.dragStart(row, event);
          }}
          onDragOver={(event) => tree.dragOver(row.id, event)}
          onDragLeave={() => tree.dragLeave(row.id)}
          onDrop={(event) => tree.drop(row.id, event)}
          onDragEnd={tree.dragEnd}
          registerRef={(element) => {
            if (element) rowRefs.current.set(row.id, element);
            else rowRefs.current.delete(row.id);
          }}
        >
          {node.children.length > 0
            ? node.children.map((child, at) => renderNode(child, at, node.children.length))
            : null}
        </TreeRow>
      );
    },
    [cancelSlowClick, onSelect, openMenu, options.dirtyTestId, options.openTestId, tree],
  );

  const body = useMemo(
    () => tree.nested.map((node, index) => renderNode(node, index, tree.nested.length)),
    [renderNode, tree.nested],
  );

  // ── Empty states ──────────────────────────────────────────────────────────

  const empty = ((): ReactNode => {
    if (tree.rows.length > 0) return null;
    if (tree.filterActive) {
      return (
        <p className="text-ink-faint whitespace-normal">
          {`No file matches “${tree.query}”. `}
          <button type="button" onClick={() => tree.setQuery('')} className="text-accent underline">
            Clear the filter
          </button>
        </p>
      );
    }
    if (tree.model.hiddenCount > 0) {
      return (
        <p className="text-ink-faint whitespace-normal">
          {`Every file here is hidden by a pattern (${tree.model.hiddenCount}). Change them in the view menu.`}
        </p>
      );
    }
    if (tree.prefs.scope !== null) {
      return (
        <p className="text-ink-faint whitespace-normal">
          Nothing in this folder.{' '}
          <button
            type="button"
            onClick={() => tree.setScope(null)}
            className="text-accent underline"
          >
            Show all files
          </button>
        </p>
      );
    }
    return (
      <p className="text-ink-faint whitespace-normal">
        No files yet. Press + to write one.
      </p>
    );
  })();

  // ── The panel ─────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-0 flex-col">
      <TreeToolbar
        prefs={tree.prefs}
        onPrefs={tree.prefsApi.set}
        onToggle={tree.prefsApi.toggle}
        query={tree.query}
        onQuery={tree.setQuery}
        filterActive={tree.filterActive}
        matchCount={tree.matchCount}
        fileCount={tree.model.fileCount}
        hiddenCount={tree.model.hiddenCount}
        hiddenSelected={tree.hiddenSelected}
        scope={tree.scope}
        scopeMissing={tree.scopeMissing}
        onScope={tree.setScope}
        onExpandAll={tree.expandAll}
        onCollapseAll={tree.collapseAll}
        onNewFile={() => tree.addFile('')}
        onNewFolder={() => tree.newFolder()}
        autoReveal={tree.autoReveal}
        onAutoReveal={tree.setAutoReveal}
        canUndo={tree.canUndo}
        canRedo={tree.canRedo}
        undoLabel={tree.undoLabel}
        redoLabel={tree.redoLabel}
        onUndo={tree.doUndo}
        onRedo={tree.doRedo}
        structural={tree.structural}
        busy={tree.busy}
      />

      {/*
        The tree, and the project root as a drop target. A drag released on the
        empty space below the last row means the root — the one destination that
        has no row of its own.
      */}
      <div
        ref={treeRef}
        role="tree"
        aria-label="Test files"
        aria-multiselectable
        aria-busy={tree.busy || undefined}
        onKeyDown={tree.onKeyDown}
        onDragOver={(event) => tree.dragOver(null, event)}
        onDragLeave={() => tree.dragLeave(null)}
        onDrop={(event) => tree.drop(null, event)}
        onScroll={cancelSlowClick}
        className={cn(
          'min-h-[40px] flex-1 rounded-sm outline-none',
          tree.drag.over && tree.drag.overRowId === null && tree.drag.ok && 'bg-accent/5',
        )}
      >
        {body}
      </div>

      {empty}

      {/*
        One status line for the whole panel: what a gesture did, why a drop was
        refused, what ⌘Z would take back. `role="status"` so it is announced
        rather than only seen — a refusal nobody hears is a refusal that reads as
        the app ignoring the gesture.
      */}
      {(() => {
        // The drop refusal outranks the last gesture's outcome while a drag is
        // actually over something; the moment it ends, the outcome is what
        // matters again.
        const refusal = tree.drag.over ? tree.drag.message : null;
        const line = refusal ?? tree.status;
        if (!line) return null;
        return (
          <p
            role="status"
            className={cn('mt-1.5 whitespace-normal', refusal ? 'text-fail' : 'text-ink-faint')}
          >
            {line}
          </p>
        );
      })()}

      {menu && (
        <FileMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
