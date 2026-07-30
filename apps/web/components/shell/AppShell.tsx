'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { NAV, SETTINGS_ITEM, SHELL_EXCLUDED } from './nav';
import { CommandPalette, type PaletteItem, type PaletteMode } from '../CommandPalette';
import { api } from '../../lib/api';

/**
 * The application shell — the persistent frame every signed-in surface lives in.
 *
 * Mounted once at the root, it renders the sidebar + a scrolling content region
 * around `{children}`, and owns the two things that have to be global: the
 * collapse state (persisted) and the ⌘K / ⌘P command palette. Marketing (`/`)
 * and login stand outside the frame, so for those it renders children bare —
 * `usePathname` resolves on the server too, so there is no shell flash.
 */

const COLLAPSE_KEY = 'qaai.sidebar.collapsed';

interface TestLite {
  id: string;
  name: string;
  filePath: string;
  type: string;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const inShell = !SHELL_EXCLUDED.has(pathname);

  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('commands');
  const [files, setFiles] = useState<TestLite[]>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* private mode / no storage — default expanded */
    }
    // Enable the width transition only AFTER the restored width has painted, so
    // a sidebar the user left collapsed snaps to 64px instead of animating open
    // (240px) → closed on every load. Two frames guarantees the correction has
    // committed before transitions turn on.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setMounted(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // The project's tests power ⌘P quick-open. Loaded on first use, not on mount —
  // most sessions never open the palette in files mode.
  const loadFiles = useCallback(async () => {
    try {
      const { projects } = await api<{ projects: { id: string }[] }>('/projects');
      const first = projects[0];
      if (!first) return;
      const { tests } = await api<{ tests: TestLite[] }>(`/projects/${first.id}/tests`);
      setFiles(tests);
    } catch {
      /* signed out or no project — the palette just shows no files */
    }
  }, []);

  const openCommands = useCallback(() => {
    setPaletteMode('commands');
    setPaletteOpen(true);
  }, []);

  const openFiles = useCallback(() => {
    setPaletteMode('files');
    setPaletteOpen(true);
    if (files.length === 0) void loadFiles();
  }, [files.length, loadFiles]);

  useEffect(() => {
    if (!inShell) return;
    // On macOS the palette lives on ⌘; Ctrl is reserved for the OS's own
    // text-editing bindings (Ctrl-K kill-line, Ctrl-P up), so we must NOT catch
    // ctrlKey there. Elsewhere Ctrl is the shortcut modifier.
    const isMac = /mac/i.test(navigator.userAgent);
    const onKey = (e: KeyboardEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        // ⌘K inside the code editor means "edit this selection", per the
        // Cursor/VS Code convention. Let Monaco's own binding take it there;
        // ⌘⇧P still opens the palette from anywhere.
        const target = e.target as HTMLElement | null;
        if (!e.shiftKey && target?.closest?.('.monaco-editor')) return;
        e.preventDefault();
        openCommands();
      } else if (k === 'p' && e.shiftKey) {
        // ⌘⇧P — the palette, always, even with the editor focused.
        e.preventDefault();
        openCommands();
      } else if (k === 'p') {
        e.preventDefault();
        openFiles();
      } else if (k === '\\') {
        e.preventDefault();
        toggle();
      } else if (k === '/') {
        // ⌘/ — the shortcuts themselves. Every frequent action here has a
        // binding, and until now none of them were discoverable anywhere.
        e.preventDefault();
        setShortcutsOpen((open) => !open);
      }
    };
    // Capture so the palette wins even when focus is inside Monaco.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [inShell, openCommands, openFiles, toggle]);

  const items: PaletteItem[] = useMemo(() => {
    if (paletteMode === 'files') {
      return files.map((t) => ({
        id: t.id,
        label: t.name,
        detail: t.filePath,
        group: 'Tests',
        run: () => {
          // A query-only push does not remount an already-open editor, so its
          // mount-time ?test= read never re-fires. Signal it directly; the push
          // still updates the URL. From any other route the editor isn't
          // listening yet and opens from ?test= when it mounts.
          window.dispatchEvent(new CustomEvent('qaai:open-test', { detail: t.id }));
          router.push(`/editor?test=${t.id}`);
        },
      }));
    }
    const nav = [...NAV, SETTINGS_ITEM].map((n) => ({
      id: `go:${n.href}`,
      label: `Go to ${n.label}`,
      detail: n.href,
      group: 'Navigate',
      run: () => router.push(n.href),
    }));
    return [
      ...nav,
      {
        id: 'view:toggle',
        label: collapsed ? 'Expand sidebar' : 'Collapse sidebar',
        detail: '⌘\\',
        group: 'View',
        run: toggle,
      },
      {
        id: 'files:open',
        label: 'Go to file…',
        detail: '⌘P',
        group: 'View',
        run: openFiles,
      },
      {
        id: 'view:shortcuts',
        label: 'Keyboard shortcuts',
        detail: '⌘/',
        group: 'View',
        run: () => setShortcutsOpen(true),
      },
    ];
  }, [paletteMode, files, collapsed, router, toggle, openFiles]);

  if (!inShell) return <>{children}</>;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        collapsed={collapsed}
        mounted={mounted}
        onToggle={toggle}
        onOpenPalette={openCommands}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {children}
      </div>
      <CommandPalette
        open={paletteOpen}
        mode={paletteMode}
        items={items}
        onClose={() => setPaletteOpen(false)}
      />
      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}

/** Every binding in one place. Reached with ⌘/ or from the command palette. */
function ShortcutSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const GROUPS: Array<[string, Array<[string, string]>]> = [
    [
      'Anywhere',
      [
        ['⌘K', 'Command palette'],
        ['⌘⇧P', 'Command palette (even in the editor)'],
        ['⌘P', 'Go to file'],
        ['⌘\\', 'Collapse the sidebar'],
        ['⌘/', 'This sheet'],
      ],
    ],
    [
      'In the editor',
      [
        ['⌘K', 'Edit the selection in plain English'],
        ['⌘S', 'Save'],
        ['⌘↵', 'Run the open test'],
        ['⌘F', 'Find in file'],
        ['Right-click', 'Rename, duplicate or delete a file'],
      ],
    ],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="border-line bg-surface-1 w-full max-w-md overflow-hidden rounded-lg border shadow-2xl"
      >
        <div className="border-line flex items-baseline gap-2 border-b px-5 py-3">
          <h2 className="text-sm font-medium">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-faint hover:text-ink ml-auto text-sm"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="space-y-5 px-5 py-4">
          {GROUPS.map(([group, rows]) => (
            <div key={group}>
              <p className="text-ink-faint mb-2 text-[11px] font-semibold tracking-wider uppercase">
                {group}
              </p>
              <dl className="space-y-1.5">
                {rows.map(([keys, what]) => (
                  <div key={keys + what} className="flex items-baseline gap-3">
                    <dt className="border-line text-ink-dim w-24 shrink-0 rounded border px-1.5 py-0.5 text-center font-mono text-[11px]">
                      {keys}
                    </dt>
                    <dd className="text-ink-dim text-[13px]">{what}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
