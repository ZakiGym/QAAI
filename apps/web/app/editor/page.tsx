'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Run } from '../../lib/api';
import { CodeEditor } from '../../components/CodeEditor';
import { AgentPanel } from '../../components/AgentPanel';
import { RecordButton } from '../../components/RecordButton';
import { FileTree } from '../../components/FileTree';
import { InlineEdit } from '../../components/InlineEdit';
import { VersionHistory } from '../../components/VersionHistory';
import type { LocatorSuggestion } from '../../components/CodeEditor';
import { FIXTURE_PREFIX } from '../../lib/tree';
import { StatusDot, duration } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/Modal';
import { PromptDialog } from '../../components/ui/Field';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

/**
 * The editor (§8) — write and run tests by hand.
 *
 * Three panes, like the cockpit: file tree, Monaco, results. The point is that
 * a QA engineer who already knows what to write should not have to negotiate
 * with an agent to get it written. Save with Cmd-S, run with Cmd-Enter, and the
 * result lands in the right pane without leaving the page.
 */

interface TestSummary {
  id: string;
  name: string;
  type: string;
  feature: string | null;
  priority: string;
  filePath: string;
  reviewFlags: string[];
  quarantined: boolean;
}

interface FullTest extends TestSummary {
  code: string;
  spec: unknown;
}

/**
 * Every dialog this screen can raise, as one piece of state.
 *
 * Six of these were `window.prompt` / `window.confirm` — including creating a
 * test, which is the core act of the product, and moving a file, whose payload
 * was a hand-typed full path with no validation and no way to show what a valid
 * answer looks like. One dialog open at a time is the truth of the screen, so
 * it is modelled as one union rather than six booleans.
 */
type Dialog =
  | { kind: 'create'; folderPath: string; isFixture: boolean; dir: string }
  | { kind: 'move-file'; testId: string; filePath: string }
  | { kind: 'move-folder'; folderPath: string }
  | { kind: 'delete-file'; testId: string; filePath: string }
  | { kind: 'delete-folder'; folderPath: string }
  | { kind: 'close-dirty'; testId: string; filePath: string };

/** Non-Playwright plugins are configured with JSON, not source. */
const SPEC_DRIVEN = new Set(['API', 'ACCESSIBILITY', 'SECURITY_SMOKE', 'VISUAL', 'LOAD']);

const NEW_TEST_TEMPLATE = `import { test, expect } from '@playwright/test';

test('describe what must be true', async ({ page }) => {
  await test.step('Set up the state under test', async () => {
    await page.goto('/');
  });

  await test.step('Assert something that could actually be wrong', async () => {
    await expect(page.getByRole('heading')).toBeVisible();
  });
});
`;

const NEW_FIXTURE_TEMPLATE = `{
  "example": "replace with your test data"
}
`;

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Catch the paths the server will reject anyway, before the round-trip.
 *
 * Moving a file is still one text box — typing where it goes is the whole
 * interaction — but a malformed path now fails while you are still looking at
 * it, instead of coming back as an API error after the dialog has closed.
 */
function validatePath(input: string, kind: 'file' | 'folder'): string | null {
  const value = input.trim();
  if (value.startsWith('/')) return 'Use a path relative to the project — no leading slash.';
  if (value.includes('\\')) return 'Use forward slashes, not backslashes.';
  const segments = value.split('/');
  if (segments.some((s) => s.trim() === '')) return 'That path has an empty folder in it.';
  if (segments.some((s) => s === '.' || s === '..')) {
    return 'A path cannot step outside the project.';
  }
  if (kind === 'file' && !/\.[a-z0-9]+$/i.test(segments[segments.length - 1] ?? '')) {
    return 'A file needs an extension, like .spec.ts or .json.';
  }
  return null;
}

/** Monaco language for a file — by content type for tests, by extension for fixtures. */
function editorLanguage(test: { type: string; filePath: string }): string {
  if (SPEC_DRIVEN.has(test.type)) return 'json';
  if (test.filePath.endsWith('.json')) return 'json';
  if (test.filePath.endsWith('.js')) return 'javascript';
  if (test.filePath.endsWith('.csv') || test.filePath.endsWith('.txt')) return 'plaintext';
  return 'typescript';
}

export default function EditorPage() {
  const router = useRouter();

  // Which app am I editing? The top bar owns that answer now — this screen used
  // to silently take projects[0] and never say which project that was.
  const { project, projectId, loading: projectLoading } = useProject();

  const [tests, setTests] = useState<TestSummary[]>([]);
  /**
   * One entry per open tab. `openTest`, `draft` and `dirty` below are derived
   * from the active one, so everything downstream reads exactly as it did when
   * only a single file could be open.
   *
   * Tabs are what remove the discard-confirm: switching files used to threaten
   * your unsaved work, which made the editor feel hostile to actually editing.
   */
  const [tabs, setTabs] = useState<Array<{ test: FullTest; draft: string; dirty: boolean }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Stable, so the Modal's focus trap does not tear down and rebuild on every
  // keystroke in a PromptDialog.
  const closeDialog = useCallback(() => setDialog(null), []);

  const activeTab = tabs.find((t) => t.test.id === activeId) ?? null;
  const openTest = activeTab?.test ?? null;
  const draft = activeTab?.draft ?? '';
  const dirty = activeTab?.dirty ?? false;

  const patchActive = useCallback(
    (patch: Partial<{ draft: string; dirty: boolean; test: FullTest }>) =>
      setTabs((prev) =>
        prev.map((t) => (t.test.id === activeId ? { ...t, ...patch } : t)),
      ),
    [activeId],
  );
  const setDraft = useCallback((value: string) => patchActive({ draft: value }), [patchActive]);
  const setDirty = useCallback((value: boolean) => patchActive({ dirty: value }), [patchActive]);

  /** Drop a tab and move the selection to a sensible neighbour. */
  const discardTab = useCallback(
    (testId: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.test.id !== testId);
        if (testId === activeId) {
          const index = prev.findIndex((t) => t.test.id === testId);
          setActiveId(next[Math.min(index, next.length - 1)]?.test.id ?? null);
        }
        return next;
      });
    },
    [activeId],
  );

  /** Close a tab, warning once if it holds unsaved work. */
  const closeTab = useCallback(
    (testId: string) => {
      const tab = tabs.find((t) => t.test.id === testId);
      if (tab?.dirty) {
        setDialog({ kind: 'close-dirty', testId, filePath: tab.test.filePath });
        return;
      }
      discardTab(testId);
    },
    [tabs, discardTab],
  );
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const [locators, setLocators] = useState<LocatorSuggestion[]>([]);
  const [inlineSelection, setInlineSelection] = useState<{
    text: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);

  const loadTests = useCallback(async (projectId: string) => {
    const { tests } = await api<{ tests: TestSummary[] }>(`/projects/${projectId}/tests`);
    setTests(tests);
    return tests;
  }, []);

  // Follows the top bar. Switching apps reloads the tree and closes the open
  // tabs, because they belong to the project that was selected when they opened.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setTabs([]);
    setActiveId(null);
    setStatus(null);
    setError(null);
    void (async () => {
      try {
        // Locators come from the crawl and need no model — load them for
        // completions, and shrug if the project has never been explored.
        void api<{ locators: LocatorSuggestion[] }>(`/projects/${projectId}/locators`)
          .then((d) => {
            if (!cancelled) setLocators(d.locators);
          })
          .catch(() => {
            if (!cancelled) setLocators([]);
          });
        const loaded = await loadTests(projectId);
        if (cancelled) return;
        // ⌘P quick-open lands here as ?test=<id>; fall back to the first test.
        const wanted = new URLSearchParams(window.location.search).get('test');
        const target = (wanted && loaded.find((t) => t.id === wanted)) || loaded[0];
        if (target) void openFile(projectId, target.id);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load the editor');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs only when the selected project changes
  }, [projectId]);

  // The provider swallows a 401 so that signed-out surfaces still render, which
  // makes "no project" ambiguous. Ask once: the editor is not a screen anyone
  // should sit on while logged out.
  useEffect(() => {
    if (projectLoading || projectId) return;
    void api('/projects').catch((err) => {
      if (err instanceof ApiError && err.status === 401) router.push('/login');
    });
  }, [projectLoading, projectId, router]);

  async function openFile(projectId: string, testId: string) {
    // Already open? Just focus it — no fetch, and no unsaved work at risk.
    if (tabs.some((t) => t.test.id === testId)) {
      setActiveId(testId);
      setStatus(null);
      return;
    }
    const { test } = await api<{ test: FullTest }>(`/projects/${projectId}/tests/${testId}`);
    const initial = SPEC_DRIVEN.has(test.type)
      ? JSON.stringify(test.spec ?? {}, null, 2)
      : test.code;
    setTabs((prev) => [...prev, { test, draft: initial, dirty: false }]);
    setActiveId(test.id);
    setStatus(null);
  }

  const save = useCallback(async () => {
    if (!project || !openTest || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      const isSpec = SPEC_DRIVEN.has(openTest.type);
      // Anything stored as JSON — a spec-driven test's config, or a .json
      // fixture — is parsed before saving. Catching it here beats letting a test
      // discover the syntax error mid-run, when the failure looks like a bug.
      if (isSpec || openTest.filePath.endsWith('.json')) {
        try {
          JSON.parse(draft);
        } catch (err) {
          setStatus(
            `Not valid JSON — ${err instanceof Error ? err.message : 'fix it before saving'}`,
          );
          return;
        }
      }

      await api(`/projects/${project.id}/tests/${openTest.id}`, {
        method: 'PUT',
        body: JSON.stringify(
          isSpec ? { code: openTest.code, spec: JSON.parse(draft) } : { code: draft },
        ),
      });

      setDirty(false);
      setStatus('Saved');
      await loadTests(project.id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [project, openTest, draft, saving, loadTests]);

  const runThis = useCallback(async () => {
    if (!project || !openTest || running) return;
    // Fixtures are data, not tests — ⌘↵ on one is a no-op.
    if (openTest.filePath.startsWith(FIXTURE_PREFIX)) return;
    const environmentId = project.environments[0]?.id;
    if (!environmentId) {
      setStatus('This project has no environment to run against');
      return;
    }

    setRunning(true);
    setStatus('Running…');
    try {
      if (dirty) await save();

      const { run } = await api<{ run: Run }>('/runs', {
        method: 'POST',
        body: JSON.stringify({ environmentId, testIds: [openTest.id], trigger: 'MANUAL' }),
      });

      // Poll rather than open an SSE stream: a single test finishes in seconds
      // and a stream would be more machinery than the wait deserves.
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { run: latest } = await api<{ run: Run }>(`/runs/${run.id}`);
        setLastRun(latest);
        if (['PASSED', 'FAILED', 'ERRORED', 'CANCELLED'].includes(latest.status)) break;
      }
      setStatus(null);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }, [project, openTest, dirty, running, save]);

  // Cmd-Enter runs. Cmd-S is bound inside Monaco so it only fires with the
  // editor focused; run is useful from anywhere on the page.
  const runRef = useRef(runThis);
  runRef.current = runThis;
  // A native prompt froze the page, so nothing could fire behind it. An in-page
  // dialog does not, and ⌘↵ while naming a new test must not start a run.
  const dialogRef = useRef<Dialog | null>(dialog);
  dialogRef.current = dialog;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogRef.current) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void runRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Warn on tab close with unsaved work — Monaco holds the only copy.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // ⌘P quick-open dispatches this when the editor is already mounted — a
  // query-only navigation would not remount the page, so the ?test= read on
  // mount never re-fires. A ref keeps the listener on the current handler
  // (which honours the discard-confirm inside openFile).
  const openTestRef = useRef<(testId: string) => void>(() => {});
  openTestRef.current = (testId: string) => {
    if (project) void openFile(project.id, testId);
  };
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) openTestRef.current(id);
    };
    window.addEventListener('qaai:open-test', onOpen);
    return () => window.removeEventListener('qaai:open-test', onOpen);
  }, []);

  /**
   * Create a new file inside a folder. A folder under `fixtures/` makes test
   * DATA (a .json fixture); anywhere else makes a test spec. The folder defaults
   * to `hand-written/` when adding from the root, so hand-authored tests still
   * land somewhere sensible.
   */
  function createInFolder(folderPath: string) {
    const isFixture =
      folderPath === FIXTURE_PREFIX.slice(0, -1) || folderPath.startsWith(FIXTURE_PREFIX);
    setDialog({
      kind: 'create',
      folderPath,
      isFixture,
      dir: folderPath || (isFixture ? 'fixtures' : 'hand-written'),
    });
  }

  async function createFile(folderPath: string, name: string) {
    if (!project) return;
    const isFixture =
      folderPath === FIXTURE_PREFIX.slice(0, -1) || folderPath.startsWith(FIXTURE_PREFIX);

    const dir = folderPath || (isFixture ? 'fixtures' : 'hand-written');
    const slug = slugify(name) || (isFixture ? 'data' : 'test');
    const filePath = isFixture ? `${dir}/${slug}.json` : `${dir}/${slug}.spec.ts`;

    try {
      const { test } = await api<{ test: FullTest }>(`/projects/${project.id}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          type: 'E2E',
          feature: isFixture ? 'Fixtures' : 'Hand-written',
          priority: 'IMPORTANT',
          code: isFixture ? NEW_FIXTURE_TEMPLATE : NEW_TEST_TEMPLATE,
          filePath,
          tags: [],
        }),
      });
      await loadTests(project.id);
      await openFile(project.id, test.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the file');
    }
  }

  /** Shared by the ⌘K binding and the toolbar button. */
  function openInlineEdit() {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = ed.getSelection();
    const model = ed.getModel();
    setInlineSelection({
      text: sel && model && !sel.isEmpty() ? model.getValueInRange(sel) : '',
      startLine: sel?.startLineNumber ?? 1,
      endLine: sel?.endLineNumber ?? (model?.getLineCount() ?? 1),
    });
  }

  /** File operations. Each one reloads the tree, and closes the file if it went away. */
  async function fileOp(label: string, fn: () => Promise<unknown>, closedTestId?: string) {
    if (!project) return;
    try {
      await fn();
      await loadTests(project.id);
      if (closedTestId) {
        setTabs((prev) => prev.filter((t) => t.test.id !== closedTestId));
        setActiveId((cur) => (cur === closedTestId ? null : cur));
      }
      setStatus(label);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : `${label} failed`);
    }
  }

  function moveFile(testId: string, from: string, to: string) {
    if (to === from) return;
    void fileOp('Moved', () =>
      api(`/projects/${project!.id}/tests/${testId}/path`, {
        method: 'PATCH',
        body: JSON.stringify({ filePath: to }),
      }),
    );
  }

  function moveFolder(from: string, to: string) {
    if (to === from) return;
    void fileOp('Folder moved', () =>
      api(`/projects/${project!.id}/folders/move`, {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      }),
    );
  }

  function deleteFile(testId: string) {
    closeDialog();
    void fileOp(
      'Deleted',
      () => api(`/projects/${project!.id}/tests/${testId}`, { method: 'DELETE' }),
      testId,
    );
  }

  function deleteFolder(path: string) {
    closeDialog();
    void fileOp('Folder deleted', () =>
      api(`/projects/${project!.id}/folders/delete`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    );
  }

  const result = lastRun?.results?.[0] ?? null;
  const openIsFixture = openTest?.filePath.startsWith(FIXTURE_PREFIX) ?? false;

  if (error) {
    return (
      <Page width="narrow">
        <p className="text-fail">{error}</p>
        <Link href="/runs" className="text-accent mt-4 inline-block text-sm">
          Back to runs
        </Link>
      </Page>
    );
  }

  // There is nothing to edit until an app is connected. This used to read "No
  // projects yet — run the seed." — a developer's note shipped as product copy.
  if (!projectLoading && !project) {
    return (
      <Page width="narrow">
        <EmptyState
          title="No app connected yet"
          body="The editor writes tests against an app. Connect one and its files land here — the ones QAAI writes, and the ones you write yourself."
          action={{ label: 'Add your app', href: '/onboarding' }}
        />
      </Page>
    );
  }

  return (
    <Page width="full">
      {historyOpen && openTest && project && (
        <VersionHistory
          projectId={project.id}
          testId={openTest.id}
          filePath={openTest.filePath}
          currentCode={draft}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      <header className="border-line flex shrink-0 items-center gap-3 border-b px-5 py-3">
        <span className="text-ink-dim text-sm font-medium">Editor</span>
        {openTest && (
          <span className="text-ink-faint font-mono text-xs">
            {openTest.filePath}
            {dirty && <span className="text-flake"> ●</span>}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {status && <span className="text-ink-faint text-xs">{status}</span>}
          <RecordButton
            projectId={project?.id ?? ''}
            environmentId={project?.environments[0]?.id ?? null}
            onRecorded={(testId) => {
              if (project) {
                void loadTests(project.id).then(() => void openFile(project.id, testId));
              }
            }}
          />
          <Button
            size="sm"
            onClick={() => setHistoryOpen(true)}
            disabled={!openTest}
            title="Who changed this file, and what did they change"
          >
            History
          </Button>
          <Button
            size="sm"
            onClick={openInlineEdit}
            disabled={!openTest}
            title="Describe a change in plain English"
          >
            Edit <span className="text-ink-faint">⌘K</span>
          </Button>
          <Button size="sm" onClick={() => void save()} loading={saving} disabled={!dirty}>
            Save <span className="text-ink-faint">⌘S</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void runThis()}
            loading={running}
            disabled={!openTest || openIsFixture}
            title={openIsFixture ? 'Fixtures hold test data — there is nothing to run' : undefined}
          >
            {running ? 'Running…' : 'Run'} <span className="opacity-70">⌘↵</span>
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr_400px]">
        {/* ── File tree ───────────────────────────────────────────────────── */}
        <aside className="border-line min-h-0 overflow-y-auto border-r">
          <div className="border-line flex items-center justify-between border-b px-3 py-2">
            <span className="text-ink-faint text-micro font-semibold tracking-wider uppercase">
              {project?.name ?? 'Files'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => createInFolder('')}
              title="New test"
              aria-label="New test"
              className="text-ink-faint px-1 py-0 text-sm"
            >
              +
            </Button>
          </div>

          {project && (
            <FileTree
              tests={tests}
              projectId={project.id}
              openTestId={openTest?.id ?? null}
              dirtyTestId={dirty ? (openTest?.id ?? null) : null}
              onOpen={(testId) => void openFile(project.id, testId)}
              onAdd={(folderPath) => createInFolder(folderPath)}
              onRename={(t) => setDialog({ kind: 'move-file', testId: t.id, filePath: t.filePath })}
              onDuplicate={(t) =>
                void fileOp('Duplicated', () =>
                  api(`/projects/${project.id}/tests/${t.id}/duplicate`, { method: 'POST' }),
                )
              }
              onDelete={(t) =>
                setDialog({ kind: 'delete-file', testId: t.id, filePath: t.filePath })
              }
              onRenameFolder={(path) => setDialog({ kind: 'move-folder', folderPath: path })}
              onDeleteFolder={(path) => setDialog({ kind: 'delete-folder', folderPath: path })}
            />
          )}
        </aside>

        {/* ── Monaco ──────────────────────────────────────────────────────── */}
        <section className="relative grid min-h-0 grid-rows-[auto_1fr]">
          {/* Open files. Dirty tabs show a dot instead of the close ✕ until hovered,
              the way VS Code does — so unsaved work is visible without being noisy. */}
          {tabs.length > 0 && (
            <div className="border-line flex min-w-0 shrink-0 overflow-x-auto border-b">
              {tabs.map((tab) => {
                const active = tab.test.id === activeId;
                return (
                  <div
                    key={tab.test.id}
                    className={cn(
                      'group border-line text-micro flex shrink-0 items-center gap-2 border-r px-3 py-1.5',
                      active ? 'bg-surface text-ink' : 'text-ink-faint hover:bg-surface-1',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveId(tab.test.id)}
                      title={tab.test.filePath}
                      className="max-w-44 truncate"
                    >
                      {tab.test.filePath.split('/').pop()}
                    </button>
                    <button
                      type="button"
                      onClick={() => closeTab(tab.test.id)}
                      aria-label={`Close ${tab.test.filePath}`}
                      className="text-ink-faint hover:text-ink shrink-0 leading-none"
                    >
                      {tab.dirty ? (
                        <span className="text-flake group-hover:hidden">●</span>
                      ) : null}
                      <span className={tab.dirty ? 'hidden group-hover:inline' : ''}>✕</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="relative min-h-0">
          {openTest && inlineSelection && project && (
            <InlineEdit
              projectId={project.id}
              testId={openTest.id}
              selection={inlineSelection}
              language={editorLanguage(openTest)}
              onClose={() => setInlineSelection(null)}
              onAccept={(code) => {
                // Staged into the draft, not saved — the user still owns ⌘S.
                setDraft(code);
                setDirty(true);
                setInlineSelection(null);
                setStatus('Edit applied — ⌘S to save');
              }}
            />
          )}
          {openTest ? (
            <CodeEditor
              value={draft}
              language={editorLanguage(openTest)}
              onChange={(next) => {
                setDraft(next);
                setDirty(true);
              }}
              onSave={() => void save()}
              locators={locators}
              onInlineEdit={(selection) => setInlineSelection(selection)}
              onReady={(ed) => {
                editorRef.current = ed;
              }}
            />
          ) : (
            <p className="text-ink-faint p-6 text-sm">
              Select a test, or press + to write a new one.
            </p>
          )}
          </div>
        </section>

        {/* ── Agent + result ─────────────────────────────────────────────── */}
        <aside className="border-line grid min-h-0 grid-rows-[1fr_auto] border-l">
          <div className="min-h-0">
            <AgentPanel
              projectId={project?.id ?? ''}
              onApplied={() => {
                if (project) {
                  void loadTests(project.id);
                  if (openTest) void openFile(project.id, openTest.id);
                }
              }}
            />
          </div>

          <div className="border-line max-h-[45%] overflow-y-auto border-t px-3 py-3">
            {openTest?.reviewFlags.length ? (
              <div className="border-flake/40 bg-flake/10 mb-4 rounded-md border p-3">
                <p className="text-flake mb-1.5 text-micro font-semibold tracking-wider uppercase">
                  Generator flagged
                </p>
                <ul className="text-ink-dim space-y-1 text-xs">
                  {openTest.reviewFlags.map((flag, i) => (
                    <li key={i}>{flag}</li>
                  ))}
                </ul>
                <p className="text-ink-faint mt-2 text-micro">Saving clears these.</p>
              </div>
            ) : null}

            {result ? (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <StatusDot status={result.status} />
                  <span className="text-sm">{result.status}</span>
                  <span className="text-ink-faint ml-auto font-mono text-xs tabular-nums">
                    {duration(result.durationMs)}
                  </span>
                </div>

                <ol className="space-y-1">
                  {result.steps.map((s) => (
                    <li
                      key={s.id}
                      className={cn(
                        'flex items-center gap-2 rounded border px-2 py-1.5 text-xs',
                        s.status === 'FAILED' ? 'border-fail/40 bg-fail/5' : 'border-line',
                      )}
                    >
                      <StatusDot status={s.status} />
                      <span className="flex-1 truncate">{s.title}</span>
                      <span className="text-ink-faint text-meta font-mono tabular-nums">
                        {duration(s.durationMs)}
                      </span>
                    </li>
                  ))}
                </ol>

                {(result.errorMessage || result.steps.some((s) => s.errorMessage)) && (
                  <pre className="border-fail/40 bg-fail/5 text-fail text-micro mt-3 overflow-x-auto rounded-md border p-2.5 font-mono whitespace-pre-wrap">
                    {result.errorMessage ?? result.steps.find((s) => s.errorMessage)?.errorMessage}
                  </pre>
                )}

                {lastRun && (
                  <Link
                    href={`/runs/${lastRun.id}`}
                    className="text-accent mt-3 inline-block text-xs"
                  >
                    Open in cockpit →
                  </Link>
                )}
              </>
            ) : (
              <p className="text-ink-faint text-xs">
                Press <span className="font-mono">⌘↵</span> to run this test. The result lands here.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* ── Dialogs ───────────────────────────────────────────────────────── */}
      {dialog?.kind === 'create' && (
        <PromptDialog
          open
          onClose={closeDialog}
          onSubmit={(name) => void createFile(dialog.folderPath, name)}
          title={dialog.isFixture ? 'New fixture' : 'New test'}
          label={dialog.isFixture ? 'Fixture name' : 'Test name'}
          hint={`It lands in ${dialog.dir}/`}
          initialValue={dialog.isFixture ? 'data' : 'New test'}
          confirmLabel="Create"
        />
      )}

      {dialog?.kind === 'move-file' && (
        <PromptDialog
          open
          onClose={closeDialog}
          onSubmit={(next) => moveFile(dialog.testId, dialog.filePath, next)}
          title="Rename or move"
          label="New path (move it by changing the folders)"
          hint="Relative to the project — checkout/order-total.spec.ts"
          initialValue={dialog.filePath}
          confirmLabel="Move"
          validate={(value) => validatePath(value, 'file')}
        />
      )}

      {dialog?.kind === 'move-folder' && (
        <PromptDialog
          open
          onClose={closeDialog}
          onSubmit={(next) => moveFolder(dialog.folderPath, next)}
          title="Rename or move folder"
          label="New folder path"
          hint="Relative to the project — checkout/smoke"
          initialValue={dialog.folderPath}
          confirmLabel="Move"
          validate={(value) => validatePath(value, 'folder')}
        />
      )}

      {dialog?.kind === 'delete-file' && (
        <ConfirmDialog
          open
          onClose={closeDialog}
          onConfirm={() => deleteFile(dialog.testId)}
          title="Delete test"
          body={`Delete ${dialog.filePath}? Its history and past results are kept.`}
          confirmLabel="Delete test"
        />
      )}

      {dialog?.kind === 'delete-folder' && (
        <ConfirmDialog
          open
          onClose={closeDialog}
          onConfirm={() => deleteFolder(dialog.folderPath)}
          title="Delete folder"
          body={`Delete everything in ${dialog.folderPath}/?`}
          confirmLabel="Delete folder"
        />
      )}

      {dialog?.kind === 'close-dirty' && (
        <ConfirmDialog
          open
          onClose={closeDialog}
          onConfirm={() => {
            discardTab(dialog.testId);
            closeDialog();
          }}
          title="Unsaved changes"
          body={`${dialog.filePath} has unsaved changes. Close it anyway?`}
          confirmLabel="Close anyway"
        />
      )}
    </Page>
  );
}
