'use client';

import type { EditorPrefs } from './prefs';
import { cn } from '../../lib/cn';

/**
 * The strip along the bottom of the editor.
 *
 * Everything here answers a question the code itself cannot: where the caret is,
 * how much is selected, what language the file is being parsed as, and whether
 * the type service has anything to say about it. The two toggles are here rather
 * than in a settings screen for the same reason they are here in VS Code — word
 * wrap and the minimap are things you change because of the window you are in
 * right now, and a preference you have to leave the file to change is one you
 * stop changing.
 *
 * `Ln 12, Col 4` is the one string in the app that is genuinely a coordinate,
 * so it is mono and tabular: the numbers must not shift the row as they tick.
 */

const LANGUAGE_LABEL: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  plaintext: 'Plain text',
};

export interface StatusBarProps {
  /** Null before the editor has mounted, or with no file open. */
  position: { line: number; column: number } | null;
  /** Present only while something is selected. */
  selection: { chars: number; lines: number } | null;
  language: string;
  tabSize: number;
  /** Markers from the language service. Null while none have been reported. */
  problems: { errors: number; warnings: number } | null;
  prefs: EditorPrefs;
  onTogglePref: (key: keyof EditorPrefs) => void;
  onFormat: () => void;
  /** Jump to the first marker — the count is only useful if it goes somewhere. */
  onGoToProblem: () => void;
  disabled?: boolean;
}

function Cell({
  children,
  onClick,
  title,
  active,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  active?: boolean;
  className?: string;
}) {
  const shared = cn(
    'rounded-sm px-1.5 py-[1px] whitespace-nowrap transition-colors',
    active && 'text-ink',
    className,
  );
  if (!onClick) return <span className={shared}>{children}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(shared, 'hover:bg-surface-2 hover:text-ink')}
    >
      {children}
    </button>
  );
}

export function StatusBar({
  position,
  selection,
  language,
  tabSize,
  problems,
  prefs,
  onTogglePref,
  onFormat,
  onGoToProblem,
  disabled,
}: StatusBarProps) {
  const errors = problems?.errors ?? 0;
  const warnings = problems?.warnings ?? 0;

  return (
    <div className="border-line text-ink-faint flex shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-t px-2.5 py-[3px] text-[10.5px]">
      <Cell className="font-mono tabular-nums">
        {position ? `Ln ${position.line}, Col ${position.column}` : 'Ln —, Col —'}
      </Cell>

      {selection && selection.chars > 0 && (
        <Cell className="font-mono tabular-nums">
          {selection.lines > 1
            ? `${selection.chars} selected on ${selection.lines} lines`
            : `${selection.chars} selected`}
        </Cell>
      )}

      {/*
        Quiet when the file is clean. A permanent "0 problems" trains people to
        stop reading the spot where the real count will appear.
      */}
      {errors + warnings > 0 && (
        <Cell
          onClick={onGoToProblem}
          title="Go to the first problem"
          className={cn('font-mono tabular-nums', errors > 0 ? 'text-fail' : 'text-flake')}
        >
          {errors > 0 && `${errors} error${errors === 1 ? '' : 's'}`}
          {errors > 0 && warnings > 0 && ' · '}
          {warnings > 0 && `${warnings} warning${warnings === 1 ? '' : 's'}`}
        </Cell>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-x-1 gap-y-0.5">
        <Cell
          onClick={disabled ? undefined : onFormat}
          title="Format this file (⇧⌥F)"
          className={cn(disabled && 'opacity-50')}
        >
          Format
        </Cell>
        <Cell
          onClick={() => onTogglePref('wordWrap')}
          active={prefs.wordWrap}
          title={prefs.wordWrap ? 'Turn word wrap off' : 'Turn word wrap on'}
        >
          Wrap
        </Cell>
        <Cell
          onClick={() => onTogglePref('minimap')}
          active={prefs.minimap}
          title={prefs.minimap ? 'Hide the minimap' : 'Show the minimap'}
        >
          Minimap
        </Cell>
        <Cell className="font-mono tabular-nums">Spaces: {tabSize}</Cell>
        <Cell className="font-mono">{LANGUAGE_LABEL[language] ?? language}</Cell>
      </div>
    </div>
  );
}
