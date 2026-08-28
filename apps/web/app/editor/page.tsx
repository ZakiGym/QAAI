'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMonaco } from '@monaco-editor/react';
import {
  NEW_TEST_TEMPLATES,
  SPEC_DRIVEN_TEST_TYPES,
  testFileSlug,
  type TestType,
} from '@qaai/shared';
import { api, ApiError, type Run, type TestResult } from '../../lib/api';
import { CodeEditor } from '../../components/CodeEditor';
import { NewTestDialog } from '../../components/NewTestDialog';
import { AgentPanel } from '../../components/AgentPanel';
import { RecordButton } from '../../components/RecordButton';
import { FileTree } from '../../components/tree/FileTree';
import { InlineEdit } from '../../components/InlineEdit';
import { VersionHistory } from '../../components/VersionHistory';
import type { LocatorSuggestion } from '../../components/CodeEditor';
import { FIXTURE_PREFIX } from '../../lib/tree/model';
import { duration, relativeTime } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { TestsHeader } from '../../components/TestsHeader';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/Modal';
import { PromptDialog } from '../../components/ui/Field';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page } from '../../components/ui/layout';
import { SearchPanel } from '../../components/editor/SearchPanel';
import { StatusBar } from '../../components/editor/StatusBar';
import { TabStrip } from '../../components/editor/TabStrip';
import { SplitEditor, type PaneIndex } from '../../components/editor/SplitEditor';
import { DiffView } from '../../components/editor/DiffView';
import {
  EMPTY_TABS,
  closeTab as closeTabState,
  openTab,
  promoteTab,
  setDirty as setTabDirty,
  tabById,
  type TabsState,
} from '../../components/editor/tabs';
import { fileOutline, symbolTrailAt } from '../../components/editor/outline';
import { useEditorPrefs } from '../../components/editor/prefs';
import { defineTokenTheme } from '../../components/editor/theme';
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
  /*
   * What the tree needs to badge and tint a row. Both come from
   * GET /projects/:id/tests already; they are declared here because a narrower
   * type would silently degrade every badge to "none" rather than failing to
   * compile, and a decoration that quietly stops appearing is indistinguishable
   * from a test that has no problem.
   */
  lastStatus?: 'PASSED' | 'FAILED' | 'FLAKY' | 'SKIPPED' | null;
  flakeRate?: number | null;
  lastRunAt?: string | null;
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

/**
 * Non-Playwright plugins are configured with JSON, not source.
 *
 * Imported rather than listed here, because the local copy of this set held
 * five types while fifteen plugins were spec-driven — open an EMAIL_OTP or
 * DATABASE test and the editor showed its placeholder `code` as TypeScript,
 * and save could never touch the `spec` that actually runs. The shared module
 * derives the set from the same templates the create dialog offers, and the
 * runner's template test pins both to what each plugin really parses.
 */
const SPEC_DRIVEN = SPEC_DRIVEN_TEST_TYPES;

/** Who wrote a version, in the rail's voice. `HUMAN` is the only one with a face. */
const VERSION_SOURCE: Record<string, string> = {
  HUMAN: 'hand edit',
  GENERATOR: 'generator',
  HEALER: 'healer',
  AGENT: 'agent',
  IMPORT: 'import',
};

const NEW_FIXTURE_TEMPLATE = `{
  "example": "replace with your test data"
}
`;

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

/**
 * The element the active tab controls, named so `aria-controls` can point at
 * it. A screen reader on a tab can then move straight to the buffer it opens.
 */
const EDITOR_PANEL_ID = 'qaai-editor-pane';

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
  /*
   * TWO STRUCTURES, ON PURPOSE.
   *
   * `buffers` is the CONTENT of each open file — the loaded test, the working
   * draft, and whether it differs from what was saved. It is the page's, because
   * only the page fetches, saves and edits.
   *
   * `tabState` is the STRIP — order, which tab is a disposable preview, which are
   * pinned, the most-recently-used stack ⌃Tab walks, and the closed-tab history
   * ⇧⌘T restores from. It is a pure state machine in components/editor/tabs.ts,
   * and every operation on it is a function that returns the next value.
   *
   * Keeping them apart is what lets the strip have VS Code's behaviour without
   * the page caring: a preview tab being replaced is one call, and the buffer it
   * held is dropped by reconciling against the tab list rather than by every
   * close path remembering to do it.
   *
   * They are joined by the test id, and `reconcileBuffers` is the only place
   * that has to agree — it drops any buffer whose tab has gone.
   */
  const [buffers, setBuffers] = useState<
    Array<{ test: FullTest; draft: string; dirty: boolean }>
  >([]);
  const [tabState, setTabState] = useState<TabsState>(EMPTY_TABS);
  /**
   * The second editor group (feature 24).
   *
   * A separate TabsState rather than a second copy of everything: the two panes
   * share one `buffers` store, so the same file open on both sides is ONE
   * buffer and an edit on the left is already on the right. That is what makes
   * a split useful for comparing a spec with the fixture it reads, and it is
   * why the buffer store is keyed by test id rather than by tab.
   */
  const [rightTabs, setRightTabs] = useState<TabsState>(EMPTY_TABS);
  const [split, setSplit] = useState(false);
  const [focusedPane, setFocusedPane] = useState<PaneIndex>(0);
  /**
   * Two files being compared (feature 25), or null for the normal editor.
   *
   * Held as ids, not content: the buffers are the source of truth and a diff
   * showing a stale copy of a file you are editing beside it would be its own
   * small lie.
   */
  const [compare, setCompare] = useState<{ left: string; right: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Stable, so the Modal's focus trap does not tear down and rebuild on every
  // keystroke in a PromptDialog.
  const closeDialog = useCallback(() => setDialog(null), []);

  // The FOCUSED pane decides what ⌘S saves and what the status bar describes.
  const activeId = (focusedPane === 0 ? tabState : rightTabs).activeId;
  const activeBuffer = buffers.find((b) => b.test.id === activeId) ?? null;
  const openTest = activeBuffer?.test ?? null;
  const draft = activeBuffer?.draft ?? '';
  const dirty = activeBuffer?.dirty ?? false;

  /*
   * The diff reads THROUGH the buffers, so a file being edited on one side is
   * compared as it stands rather than as it was last saved — otherwise the one
   * screen whose whole job is showing a difference would hide the newest one.
   */
  const bufferText = useCallback(
    (testId: string) => buffers.find((b) => b.test.id === testId)?.draft ?? '',
    [buffers],
  );
  const bufferPath = useCallback(
    (testId: string) => buffers.find((b) => b.test.id === testId)?.test.filePath ?? testId,
    [buffers],
  );
  const compareLanguage = useMemo(() => {
    const test = compare ? buffers.find((b) => b.test.id === compare.right)?.test : null;
    return test ? editorLanguage(test) : 'typescript';
  }, [compare, buffers]);

  /**
   * Apply the next tab state for a pane, and drop any buffer NEITHER pane holds.
   *
   * The reconciliation is across both groups on purpose: closing a file on the
   * left while it is still open on the right must not throw away the buffer the
   * right pane is rendering.
   */
  /*
   * Takes a REDUCER, not a value.
   *
   * Two `openFile` calls awaited back to back both read `tabState` from the
   * same render's closure, so the second computed its next state from the tab
   * list as it was BEFORE the first — and overwrote it. The first file's tab
   * vanished, the buffer reconciliation below then dropped its buffer, and the
   * diff that opened next showed one real file against an empty pane labelled
   * with a raw test id.
   *
   * Reducers make the sequence order-independent: each update sees whatever the
   * one before it produced, which is the only correct reading of "open this,
   * then open that".
   */
  const applyTabsFor = useCallback((pane: PaneIndex, update: (prev: TabsState) => TabsState) => {
    const setter = pane === 0 ? setTabState : setRightTabs;
    let applied: TabsState | null = null;
    setter((prev) => {
      applied = update(prev);
      return applied;
    });
    setBuffers((prev) => {
      // The OTHER pane is read through its setter for the same reason.
      const otherSetter = pane === 0 ? setRightTabs : setTabState;
      let other: TabsState = EMPTY_TABS;
      otherSetter((current) => {
        other = current;
        return current;
      });
      const next = applied;
      if (!next) return prev;
      const live = new Set([...next.tabs, ...other.tabs].map((tab) => tab.id));
      return prev.every((b) => live.has(b.test.id)) ? prev : prev.filter((b) => live.has(b.test.id));
    });
  }, []);

  /**
   * Close these files in BOTH panes.
   *
   * A delete that closed only the focused group would leave the other pane
   * rendering a buffer for a test the project no longer has — and the next ⌘S
   * there would 404 against a file nobody can see.
   */
  const closeEverywhere = useCallback(
    (testIds: readonly string[]) => {
      const shut = (prev: TabsState) => testIds.reduce((state, id) => closeTabState(state, id), prev);
      applyTabsFor(0, shut);
      applyTabsFor(1, shut);
    },
    [applyTabsFor],
  );

  const applyTabs = useCallback(
    (next: TabsState) => applyTabsFor(focusedPane, () => next),
    [applyTabsFor, focusedPane],
  );

  const patchActive = useCallback(
    (patch: Partial<{ draft: string; dirty: boolean; test: FullTest }>) =>
      setBuffers((prev) => prev.map((b) => (b.test.id === activeId ? { ...b, ...patch } : b))),
    [activeId],
  );
  const setDraft = useCallback((value: string) => patchActive({ draft: value }), [patchActive]);

  /**
   * Mark the active buffer dirty or clean.
   *
   * The strip is told too, because a dirty tab shows a dot AND — VS Code's rule,
   * and the reason a preview tab never eats your edits — an edited preview tab
   * becomes permanent. `promoteTab` is a no-op on a tab that is already
   * permanent, so this stays a single unconditional call.
   */
  const setDirty = useCallback(
    (value: boolean) => {
      patchActive({ dirty: value });
      // Both groups: the same file can be open in each, and a dot on one and
      // not the other would be two answers to one question.
      const mark = (prev: TabsState): TabsState => {
        if (!activeId || !tabById(prev, activeId)) return prev;
        const marked = setTabDirty(prev, activeId, value);
        return value ? promoteTab(marked, activeId) : marked;
      };
      setTabState(mark);
      setRightTabs(mark);
    },
    [patchActive, activeId],
  );

  /** Drop a tab. The state machine picks the successor. */
  const discardTab = useCallback(
    (testId: string) => closeEverywhere([testId]),
    [applyTabs, tabState],
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
  const [prefs, togglePref] = useEditorPrefs();
  const [caret, setCaret] = useState<{
    position: { line: number; column: number };
    selection: { chars: number; lines: number } | null;
  } | null>(null);
  const [problems, setProblems] = useState<{ errors: number; warnings: number } | null>(null);
  /*
   * The left column is one column showing one of two things. VS Code makes the
   * activity bar a permanent rail; there is no room for a fourth column here,
   * and the tree and the search results answer the same question — "which file"
   * — so they take turns. ⌘⇧F switches to search; Escape in the box goes back.
   */
  const [leftPanel, setLeftPanel] = useState<'files' | 'search'>('files');
  /** Bumped per ⌘⇧F so a second press re-focuses and selects the query. */
  const [searchTick, setSearchTick] = useState(0);
  /**
   * Feature 30 — the folder "Find in folder" narrowed the search to.
   *
   * Lives on the page rather than inside SearchPanel because the tree is what
   * sets it and the two are siblings. ⌘⇧F clears it, so the shortcut always
   * means "search this project" and a scope can never be silently in force.
   */
  const [searchScope, setSearchScope] = useState<string | null>(null);
  /**
   * Is the right rail open?
   *
   * The three columns were fixed, and the code — the only thing on this screen
   * a person came to read — got 43% of the window. The rail carries the last
   * run, the version list and the agent: real, and none of it needed while you
   * are typing. Closing it hands its width to the editor.
   *
   * Remembered per session rather than per project: it is an answer about the
   * window you are working in, like the sidebar's own collapse.
   */
  const [railOpen, setRailOpen] = useState(true);
  useEffect(() => {
    try {
      setRailOpen(localStorage.getItem('qaai.editor.rail') !== 'closed');
    } catch {
      /* private mode — the rail is open, which is the old behaviour */
    }
  }, []);
  const toggleRail = useCallback(() => {
    setRailOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem('qaai.editor.rail', next ? 'open' : 'closed');
      } catch {
        /* the choice is just for this session */
      }
      return next;
    });
  }, []);
  /**
   * A line to jump to once the file it belongs to is the one on screen.
   *
   * Opening a file and revealing a line in it are two steps with a render
   * between them, and the first version of this deferred the reveal by one
   * `requestAnimationFrame` and hoped. It was wrong in the case that matters:
   * clicking a match in a file that was not already open moved the caret while
   * Monaco still held the PREVIOUS model, and the swap that followed dropped it
   * at the end of the new file instead of on the match.
   *
   * So the reveal is stored and performed by an effect that runs after the
   * render where the tab actually became active — a fact, rather than a guess
   * about how many frames the swap takes.
   */
  const [pendingReveal, setPendingReveal] = useState<{ testId: string; line: number } | null>(
    null,
  );
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
    setTabState(EMPTY_TABS);
    setBuffers([]);
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

  /**
   * Open a file.
   *
   * `permanent` is the preview-tab rule: a single click in the tree opens a
   * disposable tab that the NEXT single click replaces, so browsing a folder
   * leaves one tab behind rather than thirty. A double-click, or any edit,
   * makes it permanent. Everything that is not casual browsing — ⌘P, a search
   * hit, restoring a closed tab — opens permanently, because the person named
   * the file they wanted.
   */
  async function openFile(projectId: string, testId: string, permanent = false) {
    const known = buffers.find((b) => b.test.id === testId);
    if (known) {
      // Already loaded: focus it, and promote it if this open was deliberate.
      applyTabsFor(focusedPane, (prev) =>
        openTab(prev, {
          id: testId,
          path: known.test.filePath,
          preview: !permanent && (tabById(prev, testId)?.preview ?? true),
        }),
      );
      setStatus(null);
      return;
    }
    const { test } = await api<{ test: FullTest }>(`/projects/${projectId}/tests/${testId}`);
    const initial = SPEC_DRIVEN.has(test.type)
      ? JSON.stringify(test.spec ?? {}, null, 2)
      : test.code;
    setBuffers((prev) => [...prev, { test, draft: initial, dirty: false }]);
    applyTabsFor(focusedPane, (prev) =>
      openTab(prev, { id: test.id, path: test.filePath, preview: !permanent }),
    );
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

  /**
   * Feature 29 — run exactly these tests.
   *
   * The tree collects the ids under a folder and hands them over; this owns the
   * environment, the busy state and the navigation, because they belong to the
   * page and not to a panel. It navigates to the cockpit rather than polling
   * the way ⌘↵ does: one file finishes in seconds and is worth waiting for
   * inline, a folder is a real run and belongs on the run screen.
   */
  const runTests = useCallback(
    async (testIds: string[], label: string) => {
      if (!project || running) return;
      if (testIds.length === 0) {
        setStatus(`Nothing runnable in ${label}`);
        return;
      }
      const environmentId = project.environments[0]?.id;
      if (!environmentId) {
        setStatus('This project has no environment to run against');
        return;
      }
      setRunning(true);
      setStatus(`Starting ${testIds.length} test${testIds.length === 1 ? '' : 's'} from ${label}…`);
      try {
        if (dirty) await save();
        const { run } = await api<{ run: Run }>('/runs', {
          method: 'POST',
          body: JSON.stringify({ environmentId, testIds, trigger: 'MANUAL' }),
        });
        setStatus(null);
        router.push(`/runs/${run.id}`);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Could not start the run');
      } finally {
        setRunning(false);
      }
    },
    [project, running, dirty, save, router],
  );

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

  /*
   * The outline is parsed from the DRAFT, not the saved file: the breadcrumb
   * has to name the test you are typing inside, including one you have not
   * saved yet. Memoised on the text because the parse walks the whole buffer
   * and the caret moves far more often than the text does — recomputing it per
   * keystroke is fine, per cursor move is not.
   */
  const outline = useMemo(
    () => (openTest ? fileOutline(draft, editorLanguage(openTest)) : []),
    [draft, openTest],
  );
  const symbolTrail = useMemo(
    () => (caret ? symbolTrailAt(outline, caret.position.line) : []),
    [outline, caret],
  );

  /**
   * Put the caret on a line and scroll it into view.
   *
   * `revealLineInCenter` rather than `revealLine`: a match that lands one row
   * above the fold is a match you scroll to find, which defeats clicking it.
   * Focus follows, because the point of jumping there is to type.
   */
  const revealLine = useCallback((line: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  }, []);

  /** ⇧⌥F, and the status bar's Format. Monaco owns the formatter. */
  const formatDocument = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    void ed.getAction('editor.action.formatDocument')?.run();
    ed.focus();
  }, []);

  /**
   * Jump to the first diagnostic.
   *
   * The count in the bar is only worth drawing if it goes somewhere — a number
   * that says "3 errors" and cannot show you one is decoration.
   */
  const goToProblem = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    void ed.getAction('editor.action.marker.next')?.run();
    ed.focus();
  }, []);

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
      // ⌘⇧F. Compared case-insensitively: with shift held the browser reports
      // `F`, and matching only 'f' is why this shortcut silently did nothing
      // the first time it was tried.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setLeftPanel('search');
        // The shortcut means the whole project. Leaving a folder scope in place
        // would make ⌘⇧F quietly search a tenth of the suite and find nothing.
        setSearchScope(null);
        setSearchTick((n) => n + 1);
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
   * CodeEditor installs the SAME definition in `beforeMount`, so the first
   * paint is already right; this effect exists to REDEFINE it when the theme or
   * accent changes underneath a mounted editor.
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
    defineTokenTheme(monaco);

    const observer = new MutationObserver(() => defineTokenTheme(monaco));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    return () => observer.disconnect();
  }, [monaco, editorReady]);

  /*
   * Perform a queued reveal once its file is the open one.
   *
   * `draft` is in the deps because the model's CONTENT arrives with it: the tab
   * can be active for one render while Monaco still holds the previous text,
   * and revealing line 40 of a file that currently has 9 lines is how the caret
   * ends up somewhere no one asked for.
   */
  useEffect(() => {
    if (!pendingReveal) return;
    if (activeId !== pendingReveal.testId) return;
    if (!editorRef.current || editorReady === 0) return;
    revealLine(pendingReveal.line);
    setPendingReveal(null);
  }, [pendingReveal, activeId, draft, editorReady, revealLine]);

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

  async function createFile(folderPath: string, name: string, type: TestType = 'E2E') {
    if (!project) return;
    const isFixture =
      folderPath === FIXTURE_PREFIX.slice(0, -1) || folderPath.startsWith(FIXTURE_PREFIX);

    // The template is the honesty contract: the picker only offers types with
    // one, and packages/runner's template test proves each type's own plugin
    // accepts exactly this code and spec — so the file is runnable the moment
    // it exists, never a scaffold whose first run is FAILED "invalid spec".
    const template = NEW_TEST_TEMPLATES[type];
    if (!isFixture && !template) return;

    const dir = folderPath || (isFixture ? 'fixtures' : 'hand-written');
    const slug = testFileSlug(name, isFixture ? 'data' : 'test');
    const filePath = isFixture ? `${dir}/${slug}.json` : `${dir}/${slug}${template!.fileSuffix}`;

    try {
      const { test } = await api<{ test: FullTest }>(`/projects/${project.id}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          // Fixtures are data, not tests — their row keeps the default type.
          type: isFixture ? 'E2E' : type,
          feature: isFixture ? 'Fixtures' : 'Hand-written',
          priority: 'IMPORTANT',
          code: isFixture ? NEW_FIXTURE_TEMPLATE : template!.code,
          ...(!isFixture && template!.spec !== undefined ? { spec: template!.spec } : {}),
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
      if (closedTestId) closeEverywhere([closedTestId]);
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

      <TestsHeader />

      {/*
        The tree stays narrow, the code takes what is left, and the rail can be
        shut. A file tree wants enough room for a name and no more; the editor
        wants everything else.
      */}
      <div
        className={cn(
          'grid min-h-0 flex-1 overflow-x-auto',
          railOpen
            ? 'grid-cols-[minmax(150px,200px)_minmax(320px,1fr)_minmax(180px,270px)]'
            : 'grid-cols-[minmax(150px,200px)_minmax(320px,1fr)]',
        )}
      >
        {/* ── The tree, or search ─────────────────────────────────────────── */}
        {leftPanel === 'search' && project ? (
          <aside className="border-line flex min-h-0 flex-col overflow-hidden border-r">
            <div className="border-line flex shrink-0 items-center justify-between border-b px-2.5 py-2">
              <span className="text-ink-faint text-micro tracking-wide uppercase">Search</span>
              <button
                type="button"
                onClick={() => setLeftPanel('files')}
                className="text-ink-faint hover:text-ink text-micro"
              >
                Files
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <SearchPanel
                projectId={project.id}
                focusTick={searchTick}
                scopePath={searchScope}
                onClearScope={() => setSearchScope(null)}
                onOpenMatch={(testId, line) => {
                  setPendingReveal({ testId, line });
                  void openFile(project.id, testId);
                }}
              />
            </div>
          </aside>
        ) : (
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
              /*
               * Awaited, not fired and forgotten: the panel holds its status
               * line until the reload lands, so "Moved 3 files" appears over a
               * tree that already shows them moved. Rename, delete, paste, drop
               * and undo all route through here.
               */
              onChanged={async () => {
                await loadTests(project.id);
              }}
              /*
               * A tab whose file no longer exists is a buffer pointing at
               * nothing: ⌘S would 404 and the editor would show a file the
               * project does not have. The panel deletes; the page owns tabs,
               * so it closes them.
               */
              onClosed={(ids) => closeEverywhere(ids)}
              onFindInFolder={(folderPath) => {
                setSearchScope(folderPath);
                setLeftPanel('search');
                setSearchTick((n) => n + 1);
              }}
              onRunTests={(testIds, label) => void runTests(testIds, label)}
              /*
               * Feature 25 — compare two files. Both are loaded before the diff
               * opens, because DiffView reads their buffers and an unloaded one
               * would render as an empty side, which reads as "this file is
               * empty" rather than "we have not fetched it".
               */
              onCompare={(left, right) => {
                if (!project) return;
                void (async () => {
                  try {
                    await openFile(project.id, left, true);
                    await openFile(project.id, right, true);
                    setCompare({ left, right });
                  } catch (err) {
                    setStatus(err instanceof Error ? err.message : 'Could not open both files');
                  }
                })();
              }}
              onStatus={setStatus}
            />
          )}

          <button
            type="button"
            onClick={() => createInFolder('')}
            className="text-accent mt-3.5 block text-[11px] hover:underline"
          >
            + new test
          </button>

          <button
            type="button"
            onClick={() => {
              setLeftPanel('search');
              setSearchTick((n) => n + 1);
            }}
            className="text-ink-faint hover:text-ink-dim mt-2 block text-[11px]"
          >
            Search files <span className="font-mono text-[9.5px]">⌘⇧F</span>
          </button>
        </aside>
        )}

        {/* ── The file ────────────────────────────────────────────────────── */}
        <section className="flex min-h-0 min-w-0 flex-col">
          {/*
            The open files, in a strip that SCROLLS rather than wraps.
            
            The old row wrapped, on the argument that a wrapped Run button is
            readable where a scrolled one is hidden. Splitting the two settles
            it better: the tabs are their own scrolling strip, and the verbs
            below keep a row they cannot be pushed out of.
          */}
          <TabStrip
            state={tabState}
            onChange={applyTabs}
            panelId={EDITOR_PANEL_ID}
            label="Open files"
            /*
              Record / Save / Run ride ALONG the tab strip rather than on a band
              of their own. They were a full row for three controls, and the
              strip already has the width: the tabs scroll, so the verbs keep a
              place on the right that cannot be pushed off by an eleventh file.
            */
            actions={
              <div className="flex shrink-0 items-center gap-2">
                {status && (
                  <span aria-live="polite" className="text-ink-faint text-micro min-w-0 truncate">
                    {status}
                  </span>
                )}
                <RecordButton
                  projectId={project?.id ?? ''}
                  environmentId={project?.environments[0]?.id ?? null}
                  onRecorded={(testId) => {
                    if (project) {
                      void loadTests(project.id).then(() => void openFile(project.id, testId, true));
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
            }
            onBeforeClose={(tab) => {
              const buffer = buffers.find((b) => b.test.id === tab.id);
              if (!buffer?.dirty) return true;
              // The page owns the dialog, so the strip stands down and the
              // confirm path closes the tab if the person says so.
              setDialog({ kind: 'close-dirty', testId: tab.id, filePath: buffer.test.filePath });
              return false;
            }}
            onSplitRight={(tab) => {
              // Open the same file on the right and focus it, which is what
              // "Split right" means everywhere else it exists.
              setSplit(true);
              const buffer = buffers.find((b) => b.test.id === tab.id);
              setRightTabs((prev) =>
                openTab(prev, { id: tab.id, path: buffer?.test.filePath ?? tab.path, preview: false }),
              );
              setFocusedPane(1);
            }}
            onCopyPath={(tab) => {
              void navigator.clipboard?.writeText(tab.path);
              setStatus(`Copied ${tab.path}`);
            }}
            onDropTests={(testIds) => {
              // Dropped from the tree. Opened permanently — dragging a file
              // onto the strip is as deliberate as an open gets.
              if (!project) return;
              for (const id of testIds) void openFile(project.id, id, true);
            }}
          />

          <div id={EDITOR_PANEL_ID} className="relative flex min-h-0 flex-1 flex-col">
            {openTest && inlineSelection && project && !compare && (
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

            {compare ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-line flex shrink-0 items-center justify-between border-b px-3 py-1">
                  <span className="text-ink-faint text-[10.5px]">Comparing two files</span>
                  <button
                    type="button"
                    onClick={() => setCompare(null)}
                    className="text-ink-faint hover:text-ink text-[11px]"
                  >
                    Close diff
                  </button>
                </div>
              {/*
                Comparing two files takes the whole pane rather than opening a
                third one: a diff read in a third of the width is a diff nobody
                reads. Closing returns to whatever was open.

                Braced, because a bare block comment in JSX CHILDREN position is
                not a comment — it is text, and it rendered verbatim across the
                top of the diff.
              */}
              <DiffView
                original={bufferText(compare.left)}
                modified={bufferText(compare.right)}
                originalLabel={bufferPath(compare.left)}
                modifiedLabel={bufferPath(compare.right)}
                language={compareLanguage}
                onSwap={() =>
                  setCompare((c) => (c ? { left: c.right, right: c.left } : c))
                }
                />
              </div>
            ) : (
              <SplitEditor
                split={split}
                focusedPane={focusedPane}
                onFocusPane={setFocusedPane}
                paneLabels={['Left editor', 'Right editor']}
                onRatioChange={undefined}
              >
                {(pane: PaneIndex) => {
                  const groupState = pane === 0 ? tabState : rightTabs;
                  const paneBuffer =
                    buffers.find((b) => b.test.id === groupState.activeId) ?? null;
                  if (!paneBuffer) {
                    return (
                      <p className="text-ink-faint text-body-sm p-6">
                        {pane === 0
                          ? 'Select a test, or press + new test to write one.'
                          : 'Open a file here, or close this pane.'}
                      </p>
                    );
                  }
                  return (
                    <div className="flex min-h-0 flex-1 flex-col">
                      {/* Each pane names its own file: with two open, the
                          breadcrumb above the split would describe only one. */}
                      {split && (
                        <div className="border-line text-ink-faint truncate border-b px-3 py-1 font-mono text-[10.5px]">
                          {paneBuffer.test.filePath}
                        </div>
                      )}
                      <div className="min-h-0 flex-1">
                        <CodeEditor
                          value={paneBuffer.draft}
                          language={editorLanguage(paneBuffer.test)}
                          onChange={(next) => {
                            setFocusedPane(pane);
                            setDraft(next);
                            setDirty(true);
                          }}
                          onSave={() => void save()}
                          prefs={prefs}
                          onCursor={pane === focusedPane ? setCaret : undefined}
                          onProblems={pane === focusedPane ? setProblems : undefined}
                          locators={locators}
                          onInlineEdit={(selection) => {
                            setFocusedPane(pane);
                            setInlineSelection(selection);
                          }}
                          onReady={(ed) => {
                            /*
                             * Only the LEFT pane owns editorRef. The decorations,
                             * the fail-wash and the reveal all address one editor,
                             * and letting the right pane claim the ref would point
                             * every one of them at whichever mounted last.
                             */
                            if (pane !== 0) return;
                            editorRef.current = ed;
                            failWashRef.current = null;
                            setEditorReady((n) => n + 1);
                          }}
                        />
                      </div>
                    </div>
                  );
                }}
              </SplitEditor>
            )}
          </div>

          {openTest && (
            <StatusBar
              position={caret?.position ?? null}
              selection={caret?.selection ?? null}
              language={editorLanguage(openTest)}
              tabSize={2}
              problems={problems}
              trail={symbolTrail}
              onRevealLine={revealLine}
              prefs={prefs}
              onTogglePref={togglePref}
              onFormat={formatDocument}
              onGoToProblem={goToProblem}
              extras={
                <button
                  type="button"
                  onClick={toggleRail}
                  aria-pressed={railOpen}
                  title={railOpen ? 'Hide the run panel' : 'Show the run panel'}
                  className="hover:bg-surface-2 hover:text-ink rounded-sm px-1.5 py-[1px] whitespace-nowrap transition-colors"
                >
                  Panel
                </button>
              }
            />
          )}

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
        {railOpen && (
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
        )}
      </div>

      {/* ── Dialogs ───────────────────────────────────────────────────────── */}
      {/* A fixture is one string of a name; a test is a name AND a type, so the
          two get different dialogs rather than one dialog with a hidden mode. */}
      {dialog?.kind === 'create' && dialog.isFixture && (
        <PromptDialog
          open
          onClose={closeDialog}
          onSubmit={(name) => void createFile(dialog.folderPath, name)}
          title="New fixture"
          label="Fixture name"
          hint={`It lands in ${dialog.dir}/`}
          initialValue="data"
          confirmLabel="Create"
        />
      )}

      {dialog?.kind === 'create' && !dialog.isFixture && (
        <NewTestDialog
          open
          dir={dialog.dir}
          onClose={closeDialog}
          onCreate={(name, type) => void createFile(dialog.folderPath, name, type)}
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
