'use client';

import { useRef } from 'react';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';

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

/**
 * A dark theme matched to the cockpit. Monaco's stock `vs-dark` is a different
 * shade of near-black and reads as a foreign panel dropped into the app.
 */
function defineTheme(monaco: Monaco): void {
  monaco.editor.defineTheme('qaai-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7480', fontStyle: 'italic' },
      { token: 'string', foreground: '9ecbff' },
      { token: 'keyword', foreground: 'ff7b72' },
      { token: 'number', foreground: 'd29922' },
      { token: 'type', foreground: '4c8dff' },
    ],
    colors: {
      'editor.background': '#0e1013',
      'editor.foreground': '#e8eaed',
      'editorLineNumber.foreground': '#3a4149',
      'editorLineNumber.activeForeground': '#9aa3ad',
      'editor.selectionBackground': '#264f78',
      'editor.lineHighlightBackground': '#14171c',
      'editorGutter.background': '#0e1013',
      'editorWidget.background': '#14171c',
      'editorWidget.border': '#262b33',
      'editorSuggestWidget.background': '#14171c',
      'editorSuggestWidget.border': '#262b33',
      'editorSuggestWidget.selectedBackground': '#1b1f26',
    },
  });
}

export interface CodeEditorProps {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Cmd-S. Wired here rather than on window so it only fires with focus in the editor. */
  onSave?: () => void;
}

export function CodeEditor({
  value,
  language = 'typescript',
  readOnly,
  onChange,
  onSave,
}: CodeEditorProps) {
  // Kept in a ref so the Monaco keybinding always calls the latest handler
  // rather than the one captured when the editor mounted.
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  const handleMount: OnMount = (editor, monaco) => {
    defineTheme(monaco);
    monaco.editor.setTheme('qaai-dark');

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
  };

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      onChange={(next) => onChange?.(next ?? '')}
      onMount={handleMount}
      loading={<span className="text-ink-faint text-sm">Loading editor…</span>}
      options={{
        readOnly,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        minimap: { enabled: false },
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
