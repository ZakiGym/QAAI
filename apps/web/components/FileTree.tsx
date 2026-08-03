'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildTree, type TreeNode, type TreeTest } from '../lib/tree';
import { FileMenu, type MenuItem } from './FileMenu';
import { cn } from '../lib/cn';

/**
 * The editor's file explorer — a real, collapsible folder tree built from each
 * test's `filePath`. Folders remember whether you collapsed them (per project,
 * in localStorage) and default to open, so a fresh project reads at a glance.
 * Fixtures (paths under `fixtures/`) are test DATA, not tests, and are tinted to
 * say so. Hovering a folder reveals a `+` to add a file right there.
 *
 * It sets no type of its own: the column it lives in is mono 11.5px and every
 * row inherits that. A file tree is a list of paths, and paths are machine
 * strings — the size and the face belong to the pane, not to each row.
 *
 * The stroke icons are gone. At 150px the glyph, the chevron and the indent
 * between them took most of the width a filename needed, and the extension
 * already says which of these is a fixture.
 */

const IND = 12; // px of indent per depth level

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

export interface FileTreeProps {
  tests: TreeTest[];
  projectId: string;
  openTestId: string | null;
  /** The open test's id when it has unsaved edits — drives the dirty dot. */
  dirtyTestId: string | null;
  onOpen: (testId: string) => void;
  /** Create a new file inside `folderPath` ('' = root). */
  onAdd: (folderPath: string) => void;
  /** Right-click operations. Each reloads the tree when it settles. */
  onRename?: (test: TreeTest) => void;
  onDuplicate?: (test: TreeTest) => void;
  onDelete?: (test: TreeTest) => void;
  onRenameFolder?: (folderPath: string) => void;
  onDeleteFolder?: (folderPath: string) => void;
}

export function FileTree({
  tests,
  projectId,
  openTestId,
  dirtyTestId,
  onOpen,
  onAdd,
  onRename,
  onDuplicate,
  onDelete,
  onRenameFolder,
  onDeleteFolder,
}: FileTreeProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  /** Right-click on a file. */
  const fileMenu = (event: React.MouseEvent, test: TreeTest): void => {
    event.preventDefault();
    const items: MenuItem[] = [
      { label: 'Open', onSelect: () => onOpen(test.id) },
      { label: 'Rename or move…', onSelect: () => onRename?.(test), disabled: !onRename },
      { label: 'Duplicate', onSelect: () => onDuplicate?.(test), disabled: !onDuplicate },
      { label: 'Delete', onSelect: () => onDelete?.(test), disabled: !onDelete, danger: true, separated: true },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  /** Right-click on a folder. */
  const folderMenu = (event: React.MouseEvent, path: string): void => {
    event.preventDefault();
    const items: MenuItem[] = [
      { label: 'New file…', onSelect: () => onAdd(path) },
      { label: 'Rename or move…', onSelect: () => onRenameFolder?.(path), disabled: !onRenameFolder },
      { label: 'Delete folder', onSelect: () => onDeleteFolder?.(path), disabled: !onDeleteFolder, danger: true, separated: true },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  };
  const nodes = useMemo(() => buildTree(tests), [tests]);

  // Persist which folders the user COLLAPSED — default is open, and a folder we
  // have never seen (a brand-new one) is open too. Stale entries are harmless.
  const storageKey = `qaai.tree.collapsed.${projectId}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
      else setCollapsed(new Set());
    } catch {
      setCollapsed(new Set());
    }
  }, [storageKey]);

  const toggle = useCallback(
    (path: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.kind === 'dir') {
      const open = !collapsed.has(node.path);
      return (
        <div key={`dir:${node.path}`}>
          <div
            onContextMenu={(e) => folderMenu(e, node.path)}
            className="group text-ink-faint hover:bg-surface-1 flex items-center gap-1 rounded-sm py-[1px] pr-1.5 leading-[1.9]"
            style={{ paddingLeft: depth * IND + 4 }}
          >
            <button
              type="button"
              onClick={() => toggle(node.path)}
              className="flex min-w-0 flex-1 items-center gap-1 text-left"
            >
              <Chevron open={open} />
              <span className="truncate">{node.name}/</span>
              {node.flagCount > 0 && (
                <span
                  className="text-flake shrink-0 tabular-nums"
                  title={`${node.flagCount} flagged`}
                >
                  ⚑{node.flagCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => onAdd(node.path)}
              title={`New file in ${node.name}/`}
              aria-label={`New file in ${node.name}/`}
              className="hover:text-ink shrink-0 px-1 leading-none opacity-0 group-hover:opacity-100"
            >
              +
            </button>
          </div>
          {open && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const active = openTestId === node.test.id;
    const dirty = dirtyTestId === node.test.id;
    return (
      <button
        key={`file:${node.test.id}`}
        type="button"
        onClick={() => onOpen(node.test.id)}
        onContextMenu={(e) => fileMenu(e, node.test)}
        title={node.test.name}
        style={{ paddingLeft: depth * IND + 16 }}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-sm py-[1px] pr-1.5 text-left leading-[1.9]',
          active ? 'bg-surface-2 text-ink' : 'hover:bg-surface-1 text-ink-dim',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {node.test.reviewFlags.length > 0 && (
          <span className="text-flake shrink-0" title="Generator flagged this for review">
            ⚑
          </span>
        )}
        {/* The accent dot, not the flake one: unsaved is a state of the buffer,
            not a warning about the test. */}
        {dirty && (
          <span className="text-accent shrink-0 leading-none" title="Unsaved changes">
            ●
          </span>
        )}
      </button>
    );
  };

  if (nodes.length === 0) {
    return (
      <p className="text-ink-faint leading-relaxed whitespace-normal">
        No files yet. Press + new test to write one.
      </p>
    );
  }

  return (
    <>
      <div>{nodes.map((node) => renderNode(node, 0))}</div>
      {menu && <FileMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
