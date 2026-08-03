'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMonaco } from '@monaco-editor/react';
import type { Monaco } from '@monaco-editor/react';
import { api, ApiError, type Run, type TestResult } from '../../lib/api';
import { CodeEditor } from '../../components/CodeEditor';
import { AgentPanel } from '../../components/AgentPanel';
import { RecordButton } from '../../components/RecordButton';
import { FileTree } from '../../components/FileTree';
import { InlineEdit } from '../../components/InlineEdit';
import { VersionHistory } from '../../components/VersionHistory';
import type { LocatorSuggestion } from '../../components/CodeEditor';
import { FIXTURE_PREFIX } from '../../lib/tree';
import { duration, relativeTime } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { TestsHeader } from '../../components/TestsHeader';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/Modal';
import { PromptDialog } from '../../components/ui/Field';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page } from '../../components/ui/layout';
import { cn } from '../../lib/cn';
import './monaco-decorations.css';

/**
 * The editor (§8) — write and run tests by hand.
 *
 * Three panes: the tree, the file, and the run rail. The point is that a QA
 * engineer who already knows what to write should not have to negotiate with an
 * agent to get it written. Save with Cmd-S, run with Cmd-Enter, and the result
 * lands in the rail without leaving the page.
 *
 * The rail answers the question the screen actually raises — "why is this test
 * red?" — before you have run anything: it loads the file's last real result on
 * open, and the lines that failed are washed in the failure colour inside the
 * code itself.
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

/** One row of the VERSIONS rail. Same payload the history sheet reads. */
interface TestVersion {
  id: string;
  version: number;
  source: string;
  message: string | null;
  createdAt: string;
}

/** The file's last real result, plus where to go to see the whole run. */
interface LastRun {
  runId: string;
  environment: string;
  at: string;
  result: TestResult | null;
  /** Set when only the history row could be read — status without the steps. */
  fallback: { status: string; durationMs: number; errorMessage: string | null } | null;
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

/** Who wrote a version, in the rail's voice. `HUMAN` is the only one with a face. */
const VERSION_SOURCE: Record<string, string> = {
  HUMAN: 'hand edit',
  GENERATOR: 'generator',
  HEALER: 'healer',
  AGENT: 'agent',
  IMPORT: 'import',
};

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

/**
 * A design token as the `#rrggbb` Monaco understands, or null.
 *
 * Nothing here can be a literal: the status colours are oklch, the accent is one
 * of three and switchable at runtime, and both palettes flip with the theme.
 * Canvas is the only normaliser the platform hands us that parses every colour
 * syntax CSS does, so a token written in oklch still reaches Monaco as hex.
 *
 * Null rather than a hard-coded fallback: a value that cannot be read is a value
 * this file has no honest answer for, and Monaco's `inherit` already has one.
 */
function tokenColour(variable: string): string | null {
  if (typeof document === 'undefined') return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (!raw) return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;

  // An unparseable colour leaves fillStyle where it was, so a sentinel is the
  // only way to tell "resolved to black" from "was rejected".
  const sentinel = '#010203';
  ctx.fillStyle = sentinel;
  ctx.fillStyle = raw;
  const resolved = ctx.fillStyle;
  if (typeof resolved !== 'string' || !/^#[0-9a-f]{6}$/i.test(resolved)) return null;
  return resolved === sentinel ? null : resolved;
}

/** Drops the pairs whose token could not be read, so `inherit` covers them. */
function known(entries: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter((pair): pair is [string, string] => pair[1] !== null),
  );
}

/**
 * The editor, dressed in the app's own tokens.
 *
 * CodeEditor defines `qaai-dark` from constants when it mounts, which was right
 * when there was one palette and is wrong now that there are two themes and
 * three accents. Redefining the SAME name rather than adding another means
 * whichever of us calls `setTheme` last, the definition in force is this one.
 * Monaco is themed through its own API here on purpose — reaching into its DOM
 * with CSS is how an embedded editor stops surviving its next version.
 */
function applyTokenTheme(monaco: Monaco): void {
  const light = document.documentElement.getAttribute('data-theme') === 'light';

  const ink = tokenColour('--color-ink');
  const dim = tokenColour('--color-ink-dim');
  const faint = tokenColour('--color-ink-faint');
  const surface = tokenColour('--color-surface');
  const surface1 = tokenColour('--color-surface-1');
  const surface2 = tokenColour('--color-surface-2');
  const line = tokenColour('--color-line');
  const accent = tokenColour('--color-accent');
  const pass = tokenColour('--color-pass');
  const flake = tokenColour('--color-flake');
  const fail = tokenColour('--color-fail');

  /* Monaco's token rules want the six digits without the hash; its colours want it. */
  const rule = (token: string, hex: string | null, fontStyle?: string) =>
    hex ? [{ token, foreground: hex.slice(1), ...(fontStyle ? { fontStyle } : {}) }] : [];

  monaco.editor.defineTheme('qaai-dark', {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      ...rule('', ink),
      ...rule('comment', faint, 'italic'),
      ...rule('string', pass),
      ...rule('string.value.json', pass),
      ...rule('string.key.json', dim),
      ...rule('keyword', accent),
      ...rule('keyword.json', accent),
      ...rule('type', accent),
      ...rule('type.identifier', accent),
      ...rule('number', flake),
      ...rule('delimiter', dim),
    ],
    colors: known({
      'editor.background': surface,
      'editor.foreground': ink,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': dim,
      // 40% of the accent: legible as a selection against both surfaces without
      // swamping the text it is selecting.
      'editor.selectionBackground': accent && `${accent}66`,
      'editor.lineHighlightBackground': surface1,
      'editorGutter.background': surface,
      'editorIndentGuide.background1': line,
      'editorWidget.background': surface1,
      'editorWidget.border': line,
      'editorSuggestWidget.background': surface1,
      'editorSuggestWidget.border': line,
      'editorSuggestWidget.selectedBackground': surface2,
      'editorHoverWidget.background': surface1,
      'editorHoverWidget.border': line,
      /*
       * Bracket-pair colouring is on, and its stock palette is gold/magenta/blue
       * — three colours this design does not contain, on the most frequent glyph
       * in a test file. Bound to the palette it becomes depth rather than decoration.
       */
      'editorBracketHighlight.foreground1': dim,
      'editorBracketHighlight.foreground2': accent,
      'editorBracketHighlight.foreground3': faint,
      'editorBracketHighlight.foreground4': dim,
      'editorBracketHighlight.foreground5': accent,
      'editorBracketHighlight.foreground6': faint,
      'editorBracketHighlight.unexpectedBracket.foreground': fail,
      'scrollbarSlider.background': line && `${line}cc`,
      'scrollbarSlider.hoverBackground': surface2,
    }),
  });
  monaco.editor.setTheme('qaai-dark');
}

/**
 * Which lines of THIS file the last run died on.
 *
 * Playwright puts the failing frame in the message it hands back, so the line
 * numbers are already in the payload — they only had to be read out of it. A
 * message that names no line simply washes nothing, which is the right failure
 * mode for a hint.
 */
function failingLines(result: TestResult | null, filePath: string): number[] {
  const base = filePath.split('/').pop();
  if (!result || !base) return [];

  const pattern = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`, 'g');
  const lines = new Set<number>();
  for (const text of [result.errorMessage, ...result.steps.map((s) => s.errorMessage)]) {
    if (!text) continue;
    for (const match of text.matchAll(pattern)) {
      const line = Number(match[1]);
      if (Number.isFinite(line) && line > 0) lines.add(line);
    }
  }
  return [...lines];
}

export default function EditorPage() {
  const router = useRouter();

  // Which app am I editing? The sidebar's switcher owns that answer now — this
  // screen used to silently take projects[0] and never say which project it was.
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
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [lastRunLoading, setLastRunLoading] = useState(false);
  const [versions, setVersions] = useState<TestVersion[]>([]);
  const [locators, setLocators] = useState<LocatorSuggestion[]>([]);
  const [inlineSelection, setInlineSelection] = useState<{
    text: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);
  /** Flipped in `onReady`, so the theme and decoration effects run after mount. */
  const [editorReady, setEditorReady] = useState(0);
  const failWashRef = useRef<import('monaco-editor').editor.IEditorDecorationsCollection | null>(
    null,
  );

  const openTestId = openTest?.id ?? null;
  const openFilePath = openTest?.filePath ?? null;

  const loadTests = useCallback(async (projectId: string) => {
    const { tests } = await api<{ tests: TestSummary[] }>(`/projects/${projectId}/tests`);
    setTests(tests);
    return tests;
  }, []);

  // Follows the sidebar. Switching apps reloads the tree and closes the open
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
        /*
         * ⌘P quick-open and the deep links from triage/heals arrive as
         * ?test=<id>.
         *
         * This used to read `loaded.find(...) || loaded[0]`, which quietly
         * opened an UNRELATED test whenever the requested one was not in the
         * tree — deleted, moved to another project, or archived. Someone
         * following "open the failing test" from triage would land in a
         * different file, with the correct filename in the tab and no hint that
         * the app had substituted it, and start editing the wrong test.
         *
         * `|| loaded[0]` is right for a bare /editor visit (open something so
         * the screen is not blank) and wrong for a request that named a test.
         */
        const wanted = new URLSearchParams(window.location.search).get('test');
        if (wanted) {
          const target = loaded.find((t) => t.id === wanted);
          if (target) void openFile(projectId, target.id);
          else
            setStatus(
              'That test is not in this app — it may have been deleted, or it belongs to another app. Pick one from the tree.',
            );
        } else if (loaded[0]) {
          void openFile(projectId, loaded[0].id);
        }
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

  /**
   * The rail's LAST RUN, for the file you just opened.
   *
   * Two hops, both on endpoints that already existed: the history row says
   * which run last touched this test, and the run itself carries the steps and
   * the expected/actual the rail is made of. If the second hop fails the first
   * one still answers "did it pass, and when" — a rail that says less is better
   * than a rail that says nothing.
   */
  useEffect(() => {
    if (!openTestId) {
      setLastRun(null);
      return;
    }
    let cancelled = false;
    setLastRunLoading(true);
    setLastRun(null);
    void (async () => {
      try {
        const history = await api<{
          results: Array<{
            status: string;
            durationMs: number;
            errorMessage: string | null;
            createdAt: string;
            run: { id: string; environment: { name: string } };
          }>;
        }>(`/tests/${openTestId}/history?limit=1`);
        if (cancelled) return;

        const latest = history.results[0];
        if (!latest) {
          setLastRun(null);
          return;
        }

        const base: LastRun = {
          runId: latest.run.id,
          environment: latest.run.environment.name,
          at: latest.createdAt,
          result: null,
          fallback: {
            status: latest.status,
            durationMs: latest.durationMs,
            errorMessage: latest.errorMessage,
          },
        };
        setLastRun(base);

        const { run } = await api<{ run: Run }>(`/runs/${latest.run.id}`);
        if (cancelled) return;
        const result = run.results?.find((r) => r.test.id === openTestId) ?? null;
        if (result) setLastRun({ ...base, result, fallback: null });
      } catch {
        /* no history, or signed out — the rail says so in its own words */
      } finally {
        if (!cancelled) setLastRunLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openTestId]);

  /** The rail's VERSIONS. Re-read after a save, which writes one. */
  const [versionsTick, setVersionsTick] = useState(0);
  useEffect(() => {
    if (!projectId || !openTestId) {
      setVersions([]);
      return;
    }
    let cancelled = false;
    void api<{ versions: TestVersion[] }>(`/projects/${projectId}/tests/${openTestId}/versions`)
      .then((d) => {
        if (!cancelled) setVersions(d.versions);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, openTestId, versionsTick]);

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
      setVersionsTick((n) => n + 1);
      await loadTests(project.id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [project, openTest, draft, saving, loadTests, setDirty]);

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
        setLastRun({
          runId: latest.id,
          environment: latest.environment.name,
          at: latest.finishedAt ?? latest.startedAt ?? latest.queuedAt,
          result: latest.results?.[0] ?? null,
          fallback: null,
        });
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

  /*
   * Monaco, in the app's palette.
   *
   * Runs after `onReady` on purpose: CodeEditor installs its own definition of
   * `qaai-dark` as it mounts, and this has to be the later word.
   *
   * It follows the theme by WATCHING `<html>` rather than by subscribing to
   * `useTheme`. That hook holds per-component state, so the copy of it in this
   * page never hears about a switch made from the sidebar's own copy — the
   * attribute on the document is the one fact both of them agree on, and it is
   * also what the accent picker writes.
   */
  const monaco = useMonaco();
  useEffect(() => {
    if (!monaco || editorReady === 0) return;
    applyTokenTheme(monaco);

    const observer = new MutationObserver(() => applyTokenTheme(monaco));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    return () => observer.disconnect();
  }, [monaco, editorReady]);

  /* The lines the last run died on, washed in the failure colour. */
  const result = lastRun?.result ?? null;
  useEffect(() => {
    const ed = editorRef.current;
    if (!monaco || !ed || editorReady === 0) return;

    const model = ed.getModel();
    const total = model?.getLineCount() ?? 0;
    const decorations = failingLines(result, openFilePath ?? '')
      .filter((line) => line <= total)
      .map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          // Plain class names, defined in ./monaco-decorations.css — Monaco
          // rewrites every bracket and paren in a class string it is handed, so
          // a Tailwind arbitrary value arrives as rubble. See that file.
          className: 'qaai-fail-line',
          lineNumberClassName: 'qaai-fail-line-number',
        },
      }));

    if (failWashRef.current) failWashRef.current.set(decorations);
    else failWashRef.current = ed.createDecorationsCollection(decorations);
  }, [monaco, editorReady, result, openFilePath]);

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

  /** Shared by the ⌘K binding and the footer bar. */
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

  const openIsFixture = openTest?.filePath.startsWith(FIXTURE_PREFIX) ?? false;

  if (error) {
    return (
      <Page width="narrow">
        <p className="text-fail text-body-sm">{error}</p>
        <Link href="/runs" className="text-accent text-body-sm mt-4 inline-block">
          Back to runs
        </Link>
      </Page>
    );
  }

  // There is nothing to edit until an app is connected. This used to read "No
  // projects yet — run the seed." — a developer's note shipped as product copy.
  if (!projectLoading && !project) {
    return (
      <Page width="full">
        <TestsHeader />
        <div className="mx-auto w-full max-w-[760px] px-10 pt-10">
          <EmptyState
            title="No app connected yet"
            body="The editor writes tests against an app. Connect one and its files land here — the ones QAAI writes, and the ones you write yourself."
            action={{ label: 'Add your app', href: '/onboarding' }}
          />
        </div>
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

      <TestsHeader detail={tests.length > 0 ? `${tests.length} tests` : undefined} />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(150px,220px)_minmax(320px,1fr)_minmax(180px,290px)] overflow-x-auto">
        {/* ── The tree ────────────────────────────────────────────────────── */}
        <aside className="border-line min-h-0 overflow-auto border-r px-2.5 py-3.5 font-mono text-[11.5px] whitespace-nowrap">
          {/*
            An app is connected but has no tests — the state every new user is in
            right after onboarding, and the one the sidebar rendered as a blank
            panel. The plan the Explorer wrote for them is one route away and
            nothing on this screen or on /runs linked to it, so the only ways
            forward were writing a test by hand or guessing the URL.
          */}
          {project && tests.length === 0 && (
            <div className="border-line/60 mb-3 rounded-md border border-dashed p-2.5 whitespace-normal">
              {/*
                Deliberately does not assert a plan exists — a project created
                outside onboarding has none, and the plan page says so with a
                working "Run the Explorer" button. Promising a plan that isn't
                there is the same mistake as the triage fix-review link.
              */}
              <p className="text-ink-dim font-sans text-[11.5px] leading-relaxed">
                No tests yet for {project.name}. Approve a test plan and the Generator writes them
                here.
              </p>
              <Link
                href={`/projects/${project.id}/plan`}
                className="text-accent mt-2 inline-block font-sans text-[11.5px] hover:underline"
              >
                Review the test plan →
              </Link>
            </div>
          )}

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

          <button
            type="button"
            onClick={() => createInFolder('')}
            className="text-accent mt-3.5 block text-[11px] hover:underline"
          >
            + new test
          </button>
        </aside>

        {/* ── The file ────────────────────────────────────────────────────── */}
        <section className="flex min-h-0 min-w-0 flex-col">
          {/*
            Open files, then the verbs. The row wraps rather than scrolls: at a
            narrow width the Run button dropping to a second line is readable,
            and a horizontally scrolled toolbar hides the only control on the
            screen that starts anything.
          */}
          <div className="border-line flex shrink-0 flex-wrap items-center gap-2 gap-y-1.5 border-b px-4 py-2">
            {tabs.map((tab) => {
              const active = tab.test.id === activeId;
              return (
                <span
                  key={tab.test.id}
                  className={cn(
                    'text-micro inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 font-mono whitespace-nowrap',
                    active ? 'border-line bg-surface-1 text-ink border' : 'text-ink-faint',
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
                  {/* The dirty dot is the tab's state; ✕ is what you do about it. */}
                  {tab.dirty && <span className="text-accent leading-none">●</span>}
                  <button
                    type="button"
                    onClick={() => closeTab(tab.test.id)}
                    aria-label={`Close ${tab.test.filePath}`}
                    className="hover:text-ink shrink-0 leading-none"
                  >
                    ✕
                  </button>
                </span>
              );
            })}

            {status && (
              <span aria-live="polite" className="text-ink-faint text-micro min-w-0">
                {status}
              </span>
            )}

            <div className="ml-auto flex flex-wrap items-center gap-2 gap-y-1.5">
              <RecordButton
                projectId={project?.id ?? ''}
                environmentId={project?.environments[0]?.id ?? null}
                onRecorded={(testId) => {
                  if (project) {
                    void loadTests(project.id).then(() => void openFile(project.id, testId));
                  }
                }}
              />
              <Button size="sm" onClick={() => void save()} loading={saving} disabled={!dirty}>
                Save <span className="text-ink-faint font-mono text-[9.5px]">⌘S</span>
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void runThis()}
                loading={running}
                disabled={!openTest || openIsFixture}
                title={
                  openIsFixture ? 'Fixtures hold test data — there is nothing to run' : undefined
                }
              >
                {running ? 'Running…' : 'Run'}{' '}
                <span className="font-mono text-[9.5px] opacity-70">⌘⏎</span>
              </Button>
            </div>
          </div>

          <div className="relative min-h-0 flex-1">
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
                  failWashRef.current = null;
                  setEditorReady((n) => n + 1);
                }}
              />
            ) : (
              <p className="text-ink-faint text-body-sm p-6">
                Select a test, or press <span className="font-mono">+ new test</span> to write one.
              </p>
            )}
          </div>

          {/* The footer is the affordance, not a caption — ⌘K is the binding and
              this is the same command for anyone reaching for a mouse. */}
          <button
            type="button"
            onClick={openInlineEdit}
            disabled={!openTest}
            className="border-line text-ink-faint hover:text-ink-dim flex shrink-0 items-center gap-2.5 border-t px-4 py-2 text-left transition-colors disabled:hover:text-current"
          >
            <span className="font-mono text-[10px]">⌘K</span>
            <span className="text-[12px]">
              Edit the selection in plain English — &ldquo;also assert the tax line&rdquo;
            </span>
          </button>
        </section>

        {/* ── The rail ────────────────────────────────────────────────────── */}
        <aside className="border-line flex min-h-0 flex-col overflow-y-auto border-l px-[18px] py-4">
          <LastRunPanel
            lastRun={lastRun}
            loading={lastRunLoading}
            hasFile={Boolean(openTest)}
            isFixture={openIsFixture}
          />

          {openTest?.reviewFlags.length ? (
            <section className="border-line mt-5 border-t pt-4">
              <h3 className="text-meta text-flake font-mono font-semibold tracking-[0.1em] uppercase">
                Generator flagged
              </h3>
              <ul className="text-ink-dim mt-2 space-y-1 text-[12px]">
                {openTest.reviewFlags.map((flag, i) => (
                  <li key={i}>{flag}</li>
                ))}
              </ul>
              <p className="text-ink-faint text-meta mt-2">Saving clears these.</p>
            </section>
          ) : null}

          <section className="border-line mt-5 border-t pt-4">
            <div className="flex items-baseline gap-2">
              <h3 className="text-meta text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
                Versions
              </h3>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                disabled={!openTest}
                className="text-accent ml-auto text-[11.5px] hover:underline disabled:opacity-50 disabled:hover:no-underline"
                title="Who changed this file, and what did they change"
              >
                compare →
              </button>
            </div>
            {versions.length === 0 ? (
              <p className="text-ink-faint mt-2 text-[11.5px] leading-relaxed">
                Every save writes one — by you, by the generator, by a heal. This file has none yet.
              </p>
            ) : (
              <div className="mt-2 flex flex-col gap-2 text-[12px]">
                {versions.slice(0, 6).map((version) => (
                  <div key={version.id} className="flex gap-2">
                    <span className="text-ink-faint font-mono text-[10.5px] tabular-nums">
                      v{version.version}
                    </span>
                    <span className="text-ink-dim min-w-0 flex-1 truncate">
                      {VERSION_SOURCE[version.source] ?? version.source.toLowerCase()}
                      {version.message ? ` — ${version.message}` : ''}
                    </span>
                    <span className="text-ink-faint font-mono text-[10px] whitespace-nowrap">
                      {relativeTime(version.createdAt).replace(' ago', '')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/*
            The copilot. Closed by default — the rail's job on arrival is to say
            why the file is red — but kept here because this is its only door in
            the whole product, and a feature you cannot reach is a feature you
            deleted.
          */}
          <section className="border-line mt-5 flex min-h-0 flex-col border-t pt-4">
            <button
              type="button"
              onClick={() => setAgentOpen((open) => !open)}
              aria-expanded={agentOpen}
              className="text-meta text-ink-faint hover:text-ink-dim flex items-center gap-1.5 font-mono font-semibold tracking-[0.1em] uppercase transition-colors"
            >
              Agent
              <span aria-hidden className={cn('transition-transform', agentOpen && 'rotate-90')}>
                ▸
              </span>
            </button>
            {agentOpen && (
              <div className="mt-3 min-h-[320px] flex-1">
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
            )}
          </section>
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

// ─── LAST RUN ────────────────────────────────────────────────────────────────

const RESULT_TONE: Record<string, { chip: string; word: string }> = {
  PASSED: { chip: 'text-pass bg-[color-mix(in_srgb,var(--color-pass)_12%,transparent)]', word: 'PASS' },
  FAILED: { chip: 'text-fail bg-[color-mix(in_srgb,var(--color-fail)_12%,transparent)]', word: 'FAIL' },
  ERRORED: { chip: 'text-fail bg-[color-mix(in_srgb,var(--color-fail)_12%,transparent)]', word: 'ERROR' },
  TIMED_OUT: { chip: 'text-fail bg-[color-mix(in_srgb,var(--color-fail)_12%,transparent)]', word: 'TIMEOUT' },
  FLAKY: { chip: 'text-flake bg-[color-mix(in_srgb,var(--color-flake)_12%,transparent)]', word: 'FLAKE' },
  SKIPPED: { chip: 'text-ink-faint bg-surface-2', word: 'SKIP' },
};

function LastRunPanel({
  lastRun,
  loading,
  hasFile,
  isFixture,
}: {
  lastRun: LastRun | null;
  loading: boolean;
  hasFile: boolean;
  isFixture: boolean;
}) {
  const result = lastRun?.result ?? null;
  const status = result?.status ?? lastRun?.fallback?.status ?? null;
  const tone = (status && RESULT_TONE[status]) || RESULT_TONE.SKIPPED!;
  const ms = result?.durationMs ?? lastRun?.fallback?.durationMs ?? null;
  const failedStep = result?.steps.find((s) => s.status === 'FAILED') ?? null;
  const errorMessage = result?.errorMessage ?? lastRun?.fallback?.errorMessage ?? null;

  return (
    <section>
      <div className="flex items-baseline gap-2">
        <h3 className="text-meta text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
          Last run
        </h3>
        {lastRun && (
          <span className="text-ink-faint ml-auto font-mono text-[10px]">
            {relativeTime(lastRun.at)} · {lastRun.environment}
          </span>
        )}
      </div>

      {!lastRun && (
        <p className="text-ink-faint mt-2.5 text-[11.5px] leading-relaxed">
          {!hasFile
            ? 'Open a file and its last result lands here.'
            : isFixture
              ? 'Fixtures hold test data — there is nothing to run, so there is nothing to report.'
              : loading
                ? 'Reading this file’s last result…'
                : 'This file has never run. Press ⌘⏎ and the result lands here.'}
        </p>
      )}

      {lastRun && (
        <>
          <div className="mt-2.5 flex items-center gap-2">
            <span
              className={cn(
                'text-micro rounded-sm px-2 py-[3px] font-mono font-semibold tracking-[0.05em]',
                tone.chip,
              )}
            >
              {tone.word}
            </span>
            {ms !== null && (
              <span className="text-ink-faint font-mono text-[11px] tabular-nums">
                {duration(ms)}
              </span>
            )}
            <Link
              href={`/runs/${lastRun.runId}`}
              className="text-accent ml-auto text-[11.5px] hover:underline"
            >
              open in cockpit →
            </Link>
          </div>

          {result && result.steps.length > 0 && (
            <div className="mt-3 flex flex-col gap-[7px] text-[12px]">
              {result.steps.map((step) => (
                <div key={step.id} className="flex items-center gap-2">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      step.status === 'FAILED'
                        ? 'bg-fail'
                        : step.status === 'PASSED'
                          ? 'bg-pass'
                          : 'bg-skip',
                    )}
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      step.status === 'FAILED' ? 'font-semibold' : 'text-ink-dim',
                    )}
                    title={step.title}
                  >
                    {step.title}
                  </span>
                  <span className="text-ink-faint font-mono text-[10px] tabular-nums">
                    {duration(step.durationMs)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Expected against actual, in that order — the assertion is the claim
              and the app's answer is the evidence against it. */}
          {failedStep?.expected && failedStep.actual && (
            <div className="mt-2.5 rounded-lg border border-[color-mix(in_srgb,var(--color-fail)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-fail)_6%,transparent)] px-3 py-2.5 font-mono text-[11px] leading-relaxed">
              <span className="text-ink-faint">expected</span>{' '}
              <span className="text-pass break-all">{failedStep.expected}</span>{' '}
              <span className="text-ink-faint">·</span>{' '}
              <span className="text-ink-faint">actual</span>{' '}
              <span className="text-fail break-all">{failedStep.actual}</span>
            </div>
          )}

          {!failedStep?.expected && errorMessage && (
            <pre className="mt-2.5 max-h-40 overflow-auto rounded-lg border border-[color-mix(in_srgb,var(--color-fail)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-fail)_6%,transparent)] px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {errorMessage}
            </pre>
          )}
        </>
      )}
    </section>
  );
}
