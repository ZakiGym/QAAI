'use client';

import { DiffEditor, type Monaco } from '@monaco-editor/react';

/**
 * A side-by-side (or inline) diff, using the same Monaco the editor runs on.
 *
 * Reused by every "review a change" surface: heal proposals, agent proposals,
 * and version history. Reaching for Monaco rather than a hand-rolled diff means
 * syntax highlighting, word-level intra-line highlights, and folded unchanged
 * regions all come for free — and the diff looks like the editor rather than a
 * foreign widget.
 */

function defineTheme(monaco: Monaco): void {
  monaco.editor.defineTheme('qaai-diff', {
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
      'editor.background': '#0b0d11',
      'editor.foreground': '#e9ecf1',
      'editorLineNumber.foreground': '#3a4149',
      'editorGutter.background': '#0b0d11',
      // Muted diff tints: readable against near-black without shouting.
      'diffEditor.insertedTextBackground': '#3fb95022',
      'diffEditor.removedTextBackground': '#f8514922',
      'diffEditor.insertedLineBackground': '#3fb95014',
      'diffEditor.removedLineBackground': '#f8514914',
      'diffEditor.border': '#262b34',
      'diffEditorGutter.insertedLineBackground': '#3fb95022',
      'diffEditorGutter.removedLineBackground': '#f8514922',
    },
  });
}

export interface DiffViewProps {
  original: string;
  modified: string;
  language?: string;
  /** Side-by-side needs width; inline reads better in a narrow pane. */
  inline?: boolean;
  height?: string;
}

export function DiffView({
  original,
  modified,
  language = 'typescript',
  inline = false,
  height = '100%',
}: DiffViewProps) {
  return (
    <DiffEditor
      height={height}
      language={language}
      original={original}
      modified={modified}
      onMount={(_editor, monaco) => {
        defineTheme(monaco);
        monaco.editor.setTheme('qaai-diff');
      }}
      loading={<span className="text-ink-faint text-sm">Loading diff…</span>}
      options={{
        renderSideBySide: !inline,
        readOnly: true,
        // The proposal is the subject; the surrounding file is context.
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4 },
        fontSize: 12.5,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderOverviewRuler: false,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      }}
    />
  );
}
