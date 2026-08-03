'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { WindowsTitleBar } from './WindowsTitleBar';
import { ALL_SECTIONS, SHELL_EXCLUDED, isTabActive, sectionFor } from './nav';
import { CommandPalette, type PaletteItem, type PaletteMode } from '../CommandPalette';
import { useProject } from './ProjectContext';
import { PaletteCommandsProvider, usePaletteRegistry } from './PaletteCommands';
import { useToast } from '../ui/Toast';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';

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

/**
 * Screens with no row and no tab of their own.
 *
 * Every other destination now comes from `ALL_SECTIONS` and its tab strips, so
 * this list is what is left over: reachable screens that do not need an id from
 * the current page and do not appear in any strip. The trace viewer is absent
 * because it needs a run.
 */
const EXTRA_DESTINATIONS: ReadonlyArray<{ href: string; label: string; detail: string }> = [
  { href: '/settings/github', label: 'GitHub App', detail: 'checks on pull requests' },
];

/**
 * Where a page can ask for its section's tab strip.
 *
 * The strip is the shell's — it is derived from the route, and a page that
 * forgets to render it leaves the section with no way out of the view you are
 * in. But it belongs UNDER the page's own title, which only the page can place,
 * so a page renders `<div id={SECTION_TABS_SLOT_ID} />` at that spot and the
 * shell portals into it. Until one does, the shell draws the strip itself at
 * the top of the column, so no section is ever left without its tabs.
 */
export const SECTION_TABS_SLOT_ID = 'qaai-section-tabs';

export function AppShell({ children }: { children: React.ReactNode }) {
  /*
   * The provider wraps BOTH the frame and the children, because the frame owns
   * the palette (the reader) and the children contribute to it (the writers).
   * Rendering it inside the frame would put the reader above its own context —
   * the same mistake ProjectProvider was moved out of AppShell to fix.
   */
  return (
    <PaletteCommandsProvider>
      <ShellFrame>{children}</ShellFrame>
    </PaletteCommandsProvider>
  );
}

function ShellFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const inShell = !SHELL_EXCLUDED.has(pathname);
  const { project, projects, projectId, setProjectId } = useProject();
  const toast = useToast();
  const contributed = usePaletteRegistry();

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
  //
  // Reads the SELECTED project, not projects[0]. It used to re-fetch /projects
  // and take index 0, so after switching apps in the top bar ⌘P still listed
  // the first project's files; picking one pushed /editor?test=<id>, the editor
  // fetched it under the selected project, 404'd, and nothing opened — no
  // toast, no error, the palette just closed.
  const loadFiles = useCallback(async () => {
    if (!projectId) return;
    try {
      const { tests } = await api<{ tests: TestLite[] }>(`/projects/${projectId}/tests`);
      setFiles(tests);
    } catch {
      /* signed out or no project — the palette just shows no files */
    }
  }, [projectId]);

  useEffect(() => {
    setFiles([]);
  }, [projectId]);

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
    /*
     * Every destination, one entry per URL — not one per sidebar row.
     *
     * The sidebar went from sixteen rows to six sections with tab strips, and
     * the palette was built from the rows. Listing only the rows would have
     * quietly removed ten screens from ⌘K (heals, quality, flow map, import,
     * repro, traffic, members, keys, billing, account) the moment they stopped
     * having a row of their own.
     */
    const nav = ALL_SECTIONS.flatMap((section) =>
      section.tabs
        ? section.tabs.map((tab) => ({
            id: `go:${tab.href}`,
            label: `Go to ${section.label} · ${tab.label}`,
            detail: tab.href,
            group: 'Navigate',
            run: () => router.push(tab.href),
          }))
        : [
            {
              id: `go:${section.href}`,
              label: `Go to ${section.label}`,
              detail: section.href,
              group: 'Navigate',
              run: () => router.push(section.href),
            },
          ],
    );

    const extras = EXTRA_DESTINATIONS.map((n) => ({
      id: `go:${n.href}`,
      label: `Go to ${n.label}`,
      detail: n.detail,
      group: 'Navigate',
      run: () => router.push(n.href),
    }));

    /*
     * The one action this product exists to perform, and it lived on a single
     * button on a single screen. Not offered without an environment to run
     * against — a command that can only fail is worse than no command.
     */
    const environmentId = project?.environments[0]?.id ?? null;
    const runNow: PaletteItem[] = environmentId
      ? [
          {
            id: 'act:run',
            label: `Run the whole suite on ${project?.environments[0]?.name ?? 'this app'}`,
            detail: 'starts a run',
            group: 'Actions',
            run: () => {
              void (async () => {
                try {
                  const { run } = await api<{ run: { id: string } }>('/runs', {
                    method: 'POST',
                    body: JSON.stringify({ environmentId, testIds: null, trigger: 'MANUAL' }),
                  });
                  // Straight to the cockpit rather than a "queued!" toast: the
                  // run page is the only thing that can say what actually
                  // happened, and a toast that claims success for a job that
                  // died in the worker is a bug this product has shipped before.
                  router.push(`/runs/${run.id}`);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Could not start the run');
                }
              })();
            },
          },
        ]
      : [];

    /*
     * Switching app is a top-bar dropdown, which is fine when you can see it
     * and useless from the keyboard. Only offered when there is more than one —
     * a command that switches to the app you are already in is noise.
     */
    const switchProject: PaletteItem[] =
      projects.length > 1
        ? projects
            .filter((p) => p.id !== projectId)
            .map((p) => ({
              id: `act:project:${p.id}`,
              label: `Switch to ${p.name}`,
              detail: 'changes every screen',
              group: 'Actions',
              run: () => setProjectId(p.id),
            }))
        : [];

    return [
      // Screen-contributed commands lead: they are about what is in front of
      // you, and the palette is opened far more often to do something here than
      // to leave for somewhere else.
      ...contributed,
      ...runNow,
      ...switchProject,
      ...nav,
      ...extras,
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
  }, [
    paletteMode,
    files,
    collapsed,
    router,
    toggle,
    openFiles,
    contributed,
    project,
    projects,
    projectId,
    setProjectId,
    toast,
  ]);

  if (!inShell) return <>{children}</>;

  return (
    /*
     * A column, so the Windows title bar can sit ABOVE the sidebar rather than
     * beside it. It renders nothing on macOS, on Linux, or in a browser — the
     * component checks the platform itself and returns null.
     */
    <div className="flex h-screen flex-col overflow-hidden">
      <WindowsTitleBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          collapsed={collapsed}
          mounted={mounted}
          onToggle={toggle}
          onOpenPalette={openCommands}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {/* useSearchParams needs a boundary or `next build` fails on every
              statically rendered route. Settings' tabs are query params, so the
              strip genuinely has to read them. */}
          <Suspense fallback={null}>
            <SectionTabs />
          </Suspense>
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
    </div>
  );
}

/**
 * The section's tab strip — Triage's verdicts/heals/quality, Tests' five
 * screens, Settings' five.
 *
 * Every tab is a real `<Link>` to a real URL, which is the whole reason the
 * sixteen-row sidebar could shrink to six without losing anything: a run link
 * in Slack, a bookmarked heals queue and every selector in the dogfood suite
 * all still resolve. It is derived from the path rather than from local state,
 * so Back works and the strip is never out of step with what is on screen.
 */
function SectionTabs() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const section = sectionFor(pathname);

  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById(SECTION_TABS_SLOT_ID));
  }, [pathname, search]);

  if (!section?.tabs) return null;

  const strip = (
    <nav
      aria-label={`${section.label} views`}
      className="border-line flex flex-wrap gap-[22px] border-b"
    >
      {section.tabs.map((tab) => {
        const active = isTabActive(pathname, search, tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'text-micro -mb-px border-b-2 px-0.5 pb-[9px] font-mono tracking-[0.08em] uppercase transition-colors',
              active
                ? 'border-accent text-ink'
                : 'text-ink-faint hover:text-ink-dim border-transparent',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );

  if (slot) return createPortal(strip, slot);
  return <div className="mx-auto w-full max-w-[1080px] px-10 pt-9">{strip}</div>;
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
              <p className="text-ink-faint mb-2 text-micro font-semibold tracking-wider uppercase">
                {group}
              </p>
              <dl className="space-y-1.5">
                {rows.map(([keys, what]) => (
                  <div key={keys + what} className="flex items-baseline gap-3">
                    <dt className="border-line text-ink-dim w-24 shrink-0 rounded border px-1.5 py-0.5 text-center font-mono text-micro">
                      {keys}
                    </dt>
                    <dd className="text-ink-dim text-body-sm">{what}</dd>
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
