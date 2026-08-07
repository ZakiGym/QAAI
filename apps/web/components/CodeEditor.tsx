'use client';

import { useRef } from 'react';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import type { editor, MarkerSeverity, Position } from 'monaco-editor';
import { EDITOR_THEME, defineTokenTheme } from './editor/theme';
import type { EditorPrefs } from './editor/prefs';

/**
 * The Monaco wrapper — the same editor VS Code is built on.
 *
 * The QA-specific part is `PLAYWRIGHT_TYPES`: an ambient declaration for
 * `@playwright/test` loaded into Monaco's TypeScript service so `page.` and
 * `expect(...)` autocomplete inside a generated spec. Without it the editor is
 * a syntax-highlighted textarea, which is not worth the 300kb.
 *
 * It is a hand-written subset, not the real .d.ts. Shipping Playwright's full
 * type surface into the browser is megabytes; this covers the locator and
 * assertion API that test code actually touches, and gracefully knows nothing
 * about the rest.
 */
const PLAYWRIGHT_TYPES = `
declare module '@playwright/test' {
  export interface Locator {
    click(options?: { force?: boolean; timeout?: number }): Promise<void>;
    dblclick(): Promise<void>;
    fill(value: string): Promise<void>;
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
    check(): Promise<void>;
    uncheck(): Promise<void>;
    selectOption(value: string | string[]): Promise<void>;
    hover(): Promise<void>;
    focus(): Promise<void>;
    scrollIntoViewIfNeeded(): Promise<void>;
    textContent(): Promise<string | null>;
    innerText(): Promise<string>;
    inputValue(): Promise<string>;
    getAttribute(name: string): Promise<string | null>;
    count(): Promise<number>;
    all(): Promise<Locator[]>;
    first(): Locator;
    last(): Locator;
    nth(index: number): Locator;
    filter(options: { hasText?: string | RegExp; has?: Locator }): Locator;
    locator(selector: string): Locator;
    getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
    getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator;
    getByPlaceholder(text: string | RegExp): Locator;
    getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
    getByTestId(testId: string): Locator;
    isVisible(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
    isChecked(): Promise<boolean>;
    waitFor(options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden' }): Promise<void>;
  }

  export interface Response {
    status(): number;
    ok(): boolean;
    url(): string;
    json(): Promise<any>;
    text(): Promise<string>;
  }

  export interface Page {
    /** Relative paths resolve against the environment's base URL. */
    goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<Response | null>;
    goBack(): Promise<Response | null>;
    reload(): Promise<Response | null>;
    locator(selector: string): Locator;
    getByRole(role: 'button' | 'link' | 'heading' | 'textbox' | 'checkbox' | 'radio' | 'combobox' | 'list' | 'listitem' | 'table' | 'row' | 'cell' | 'img' | 'alert' | 'status' | 'dialog' | 'navigation' | 'main' | 'form' | 'search' | (string & {}), options?: { name?: string | RegExp; exact?: boolean; level?: number }): Locator;
    getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator;
    getByPlaceholder(text: string | RegExp): Locator;
    getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
    getByTestId(testId: string): Locator;
    title(): Promise<string>;
    url(): string;
    content(): Promise<string>;
    screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
    waitForURL(url: string | RegExp): Promise<void>;
    waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;
    waitForResponse(url: string | RegExp): Promise<Response>;
    evaluate<T>(fn: () => T): Promise<T>;
    setViewportSize(size: { width: number; height: number }): Promise<void>;
  }

  export interface Assertions {
    toBe(expected: any): Promise<void>;
    toEqual(expected: any): Promise<void>;
    toBeVisible(): Promise<void>;
    toBeHidden(): Promise<void>;
    toBeEnabled(): Promise<void>;
    toBeDisabled(): Promise<void>;
    toBeChecked(): Promise<void>;
    toHaveText(expected: string | RegExp | Array<string | RegExp>): Promise<void>;
    toContainText(expected: string | RegExp): Promise<void>;
    toHaveValue(value: string | RegExp): Promise<void>;
    toHaveAttribute(name: string, value?: string | RegExp): Promise<void>;
    toHaveCount(count: number): Promise<void>;
    toHaveURL(url: string | RegExp): Promise<void>;
    toHaveTitle(title: string | RegExp): Promise<void>;
    toBeGreaterThan(n: number): Promise<void>;
    toBeLessThan(n: number): Promise<void>;
    toBeTruthy(): Promise<void>;
    toBeFalsy(): Promise<void>;
    toBeNull(): Promise<void>;
    toContain(expected: any): Promise<void>;
    readonly not: Assertions;
  }

  export function expect(actual: any): Assertions;

  export interface TestArgs {
    page: Page;
  }

  export interface TestFunction {
    (name: string, fn: (args: TestArgs) => Promise<void> | void): void;
    /** Each step becomes one card on the cockpit's timeline. */
    step(title: string, body: () => Promise<void> | void): Promise<void>;
    describe(name: string, fn: () => void): void;
    beforeEach(fn: (args: TestArgs) => Promise<void> | void): void;
    afterEach(fn: (args: TestArgs) => Promise<void> | void): void;
    skip(name: string, fn: (args: TestArgs) => Promise<void> | void): void;
    setTimeout(ms: number): void;
  }

  export const test: TestFunction;
}
`;

/** A locator the last crawl found — offered as a completion. */
export interface LocatorSuggestion {
  label: string;
  route: string;
  kind: string;
  strategy: string;
  confidence: number;
  expression: string;
}

export interface CodeEditorProps {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Cmd-S. Wired here rather than on window so it only fires with focus in the editor. */
  onSave?: () => void;
  /**
   * Locators from the project's flow map. These are what makes completion here
   * different from a generic assistant's: they are elements the crawler actually
   * saw, not plausible guesses.
   */
  locators?: LocatorSuggestion[];
  /** ⌘K with the editor focused — inline edit on the current selection. */
  onInlineEdit?: (selection: {
    text: string;
    startLine: number;
    endLine: number;
  }) => void;
  /** The mounted editor, so a toolbar button can read the current selection. */
  onReady?: (editor: editor.IStandaloneCodeEditor) => void;
  /**
   * Word wrap and the minimap, owned by the status bar.
   *
   * They arrive as a prop rather than being read from localStorage here because
   * the toggles that change them live outside this component — one source of
   * truth, passed down, is what stops the bar and the editor disagreeing.
   */
  prefs?: EditorPrefs;
  /** Every caret move: what the status bar's `Ln 12, Col 4` is made of. */
  onCursor?: (state: {
    position: { line: number; column: number };
    selection: { chars: number; lines: number } | null;
  }) => void;
  /**
   * Markers from the TypeScript service, debounced by Monaco itself.
   *
   * Reported as counts rather than the markers: the bar shows how many and
   * jumps to the first, and handing the page the full list would invite it to
   * render diagnostics it has no room for.
   */
  onProblems?: (problems: { errors: number; warnings: number }) => void;
}

export function CodeEditor({
  value,
  language = 'typescript',
  readOnly,
  onChange,
  onSave,
  locators,
  onInlineEdit,
  onReady,
  prefs,
  onCursor,
  onProblems,
}: CodeEditorProps) {
  // Kept in a ref so the Monaco keybinding always calls the latest handler
  // rather than the one captured when the editor mounted.
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const inlineEditRef = useRef(onInlineEdit);
  inlineEditRef.current = onInlineEdit;
  // Read inside the provider, so newly-crawled locators appear without
  // re-registering (and without leaking a provider per render).
  const locatorsRef = useRef(locators);
  locatorsRef.current = locators;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onProblemsRef = useRef(onProblems);
  onProblemsRef.current = onProblems;

  /*
   * The theme is defined BEFORE the editor exists, so its first frame is
   * already in the app's palette. Defining it in `onMount` meant one paint in
   * Monaco's stock colours — a dark panel flashing inside the light theme.
   */
  const handleBeforeMount: BeforeMount = (monaco) => {
    defineTokenTheme(monaco);
  };

  const handleMount: OnMount = (editor, monaco) => {

    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2022,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      strict: true,
      allowNonTsExtensions: true,
      lib: ['es2023', 'dom'],
    });

    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      PLAYWRIGHT_TYPES,
      'file:///node_modules/@playwright/test/index.d.ts',
    );

    // Monaco cannot see node_modules, so unresolved-import errors are noise
    // here and would flag every correct file. Real type errors still surface.
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      diagnosticCodesToIgnore: [2307, 2792],
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());

    // ⌘K belongs to the editor when the editor has focus — the command palette
    // keeps it everywhere else. This is the Cursor/VS Code convention, and the
    // reason AppShell's global handler skips events originating inside Monaco.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!model) return;
      inlineEditRef.current?.({
        text: selection && !selection.isEmpty() ? model.getValueInRange(selection) : '',
        startLine: selection?.startLineNumber ?? 1,
        endLine: selection?.endLineNumber ?? model.getLineCount(),
      });
    });

    /**
     * Locator completions from the crawl.
     *
     * Registered once per mount and reading `locatorsRef`, so it stays correct as
     * the list loads. Triggered after a `.` (so `page.` offers them) and on the
     * usual identifier characters, and each item inserts the real Playwright
     * expression with the element's label and route as its documentation.
     */
    const provider = monaco.languages.registerCompletionItemProvider(['typescript', 'javascript'], {
      triggerCharacters: ['.', "'", '"'],
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        const all = locatorsRef.current;
        if (!all?.length) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        return {
          suggestions: all.map((locator, index) => ({
            label: {
              label: locator.expression,
              description: `${locator.label} · ${locator.route}`,
            },
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: locator.expression,
            range,
            detail: `${locator.kind} on ${locator.route}`,
            documentation: {
              value: [
                `**${locator.label}**`,
                '',
                `Seen on \`${locator.route}\` during the last crawl.`,
                '',
                `Strategy: \`${locator.strategy}\` · confidence ${Math.round(locator.confidence * 100)}%`,
              ].join('\n'),
            },
            // Confidence order is meaningful; keep it rather than let Monaco
            // re-sort alphabetically.
            sortText: String(index).padStart(4, '0'),
          })),
        };
      },
    });

    /*
     * Caret and selection, reported on change rather than polled.
     *
     * Both handlers are registered here and read through refs for the same
     * reason the save binding does: they outlive the render that mounted them.
     */
    const report = () => {
      const position = editor.getPosition();
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!position || !model) return;
      const selected =
        selection && !selection.isEmpty()
          ? {
              chars: model.getValueLengthInRange(selection),
              lines: selection.endLineNumber - selection.startLineNumber + 1,
            }
          : null;
      onCursorRef.current?.({
        position: { line: position.lineNumber, column: position.column },
        selection: selected,
      });
    };
    report();
    const cursorSub = editor.onDidChangeCursorPosition(report);
    const selectionSub = editor.onDidChangeCursorSelection(report);

    /*
     * Markers are owned by the language service and arrive well after mount,
     * so this listens rather than reads once. Filtered to THIS model: Monaco
     * reports every model it holds, including the ones behind other tabs.
     */
    const markerSub = monaco.editor.onDidChangeMarkers(() => {
      const model = editor.getModel();
      if (!model) return;
      const markers: editor.IMarker[] = monaco.editor.getModelMarkers({ resource: model.uri });
      const severity = monaco.MarkerSeverity as unknown as typeof MarkerSeverity;
      onProblemsRef.current?.({
        errors: markers.filter((m) => m.severity === severity.Error).length,
        warnings: markers.filter((m) => m.severity === severity.Warning).length,
      });
    });

    editor.onDidDispose(() => {
      provider.dispose();
      cursorSub.dispose();
      selectionSub.dispose();
      markerSub.dispose();
    });

    onReadyRef.current?.(editor);
  };

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      onChange={(next) => onChange?.(next ?? '')}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      theme={EDITOR_THEME}
      loading={<span className="text-ink-faint text-sm">Loading editor…</span>}
      options={{
        readOnly,
        /*
         * The app's own mono face and measure. Monaco writes `fontFamily`
         * straight into the style it puts on the view lines, so a custom
         * property resolves there exactly as it does anywhere else — which is
         * what stops this pane from being the one place in the product set in a
         * different typeface. It has to live in these options rather than in a
         * caller's `updateOptions`, because the library re-applies this object
         * on every render and would overwrite anything set from outside.
         */
        fontSize: 12.5,
        lineHeight: 22,
        fontFamily: 'var(--font-mono)',
        minimap: { enabled: prefs?.minimap ?? false },
        wordWrap: prefs?.wordWrap ? 'on' : 'off',
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        renderLineHighlight: 'line',
        automaticLayout: true,
        tabSize: 2,
        padding: { top: 14, bottom: 14 },
        stickyScroll: { enabled: true },
        bracketPairColorization: { enabled: true },
        suggestSelection: 'first',
        fixedOverflowWidgets: true,
      }}
    />
  );
}
