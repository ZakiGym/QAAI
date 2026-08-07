/**
 * Monaco, dressed in the app's own tokens.
 *
 * This used to live at the bottom of the editor page while CodeEditor kept a
 * SECOND definition of the same theme name written in literal hex. Two
 * definitions of one name meant the palette in force was whichever of them
 * called `setTheme` last, and for the first frames after mount it was the hex
 * one — a near-black panel dropped into a light theme until an effect corrected
 * it. There is one definition now, it is the token-derived one, and CodeEditor
 * installs it in `beforeMount` so the editor's first paint is already right.
 *
 * Nothing here can be a literal: the status colours are oklch, the accent is one
 * of three and switchable at runtime, and both palettes flip with the theme.
 */

import type { Monaco } from '@monaco-editor/react';

/** One name, one definition. Redefining it is how the theme follows the app. */
export const EDITOR_THEME = 'qaai-dark';

/**
 * A design token as the `#rrggbb` Monaco understands, or null.
 *
 * Canvas is the only normaliser the platform hands us that parses every colour
 * syntax CSS does, so a token written in oklch still reaches Monaco as hex.
 *
 * Null rather than a hard-coded fallback: a value that cannot be read is a value
 * this file has no honest answer for, and Monaco's `inherit` already has one.
 */
export function tokenColour(variable: string): string | null {
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

/** `#rrggbb` + an alpha byte, or null if the base could not be read. */
const alpha = (hex: string | null, aa: string): string | null => (hex ? `${hex}${aa}` : null);

/**
 * Define (or redefine) the editor theme from the tokens in force right now.
 *
 * Monaco is themed through its own API on purpose — reaching into its DOM with
 * CSS is how an embedded editor stops surviving its next version. That matters
 * more now than it did: the find widget, the minimap, sticky scroll and the
 * indent guides are all Monaco-owned chrome, and every one of them ships with a
 * stock colour that belongs to VS Code's palette rather than to this one.
 */
export function defineTokenTheme(monaco: Monaco): void {
  const light = document.documentElement.getAttribute('data-theme') === 'light';

  const ink = tokenColour('--color-ink');
  const dim = tokenColour('--color-ink-dim');
  const faint = tokenColour('--color-ink-faint');
  const surface = tokenColour('--color-surface');
  const surface1 = tokenColour('--color-surface-1');
  const surface2 = tokenColour('--color-surface-2');
  const line = tokenColour('--color-line');
  const lineStrong = tokenColour('--color-line-strong');
  const accent = tokenColour('--color-accent');
  const pass = tokenColour('--color-pass');
  const flake = tokenColour('--color-flake');
  const fail = tokenColour('--color-fail');

  /* Monaco's token rules want the six digits without the hash; its colours want it. */
  const rule = (token: string, hex: string | null, fontStyle?: string) =>
    hex ? [{ token, foreground: hex.slice(1), ...(fontStyle ? { fontStyle } : {}) }] : [];

  monaco.editor.defineTheme(EDITOR_THEME, {
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
      ...rule('variable', ink),
      ...rule('variable.predefined', accent),
      ...rule('regexp', flake),
      ...rule('tag', accent),
      ...rule('attribute.name', dim),
      ...rule('attribute.value', pass),
    ],
    colors: known({
      'editor.background': surface,
      'editor.foreground': ink,
      'editorCursor.foreground': accent,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': dim,
      // 40% of the accent: legible as a selection against both surfaces without
      // swamping the text it is selecting.
      'editor.selectionBackground': alpha(accent, '66'),
      // The OTHER occurrences of what you have selected, and the occurrences of
      // the word under the cursor. Both are Monaco features that were already on
      // and both were painting in VS Code's stock blue-grey.
      'editor.selectionHighlightBackground': alpha(accent, '26'),
      'editor.wordHighlightBackground': alpha(accent, '1f'),
      'editor.wordHighlightStrongBackground': alpha(accent, '2e'),
      'editor.lineHighlightBackground': surface1,
      'editorGutter.background': surface,

      /*
       * The find widget (⌘F) and replace (⌘⌥F).
       *
       * Its input boxes, its toggle buttons and its match highlights are all
       * separately themed, and left alone they are the single most VS-Code-blue
       * surface the app can put on screen. The current match is the accent at
       * full strength with a border; the other matches are the same hue at a
       * fifth of it, so "which one am I on" is readable without a second colour.
       */
      'editor.findMatchBackground': alpha(accent, '80'),
      'editor.findMatchBorder': accent,
      'editor.findMatchHighlightBackground': alpha(accent, '33'),
      'editor.findRangeHighlightBackground': alpha(accent, '14'),
      'editorWidget.background': surface1,
      'editorWidget.border': line,
      'editorWidget.foreground': ink,
      'editorWidget.resizeBorder': accent,
      'widget.shadow': alpha(surface, 'aa'),
      'input.background': surface2,
      'input.foreground': ink,
      'input.border': line,
      'input.placeholderForeground': faint,
      'inputOption.activeBorder': accent,
      'inputOption.activeBackground': alpha(accent, '33'),
      'inputOption.activeForeground': ink,
      'focusBorder': accent,
      'toolbar.hoverBackground': surface2,
      'icon.foreground': dim,
      'errorForeground': fail,
      'foreground': dim,
      'descriptionForeground': faint,

      /* The minimap, which is a preference rather than a default here. */
      'minimap.background': surface,
      'minimap.findMatchHighlight': accent,
      'minimap.selectionHighlight': alpha(accent, '99'),
      'minimapSlider.background': alpha(line, '99'),
      'minimapSlider.hoverBackground': lineStrong,
      'minimapSlider.activeBackground': lineStrong,

      /* Sticky scroll — the enclosing test/describe pinned to the top. */
      'editorStickyScroll.background': surface1,
      'editorStickyScrollHover.background': surface2,
      'editorStickyScroll.border': line,

      'editorIndentGuide.background1': line,
      'editorIndentGuide.activeBackground1': lineStrong,
      'editorWhitespace.foreground': line,

      'editorSuggestWidget.background': surface1,
      'editorSuggestWidget.border': line,
      'editorSuggestWidget.foreground': dim,
      'editorSuggestWidget.selectedBackground': surface2,
      'editorSuggestWidget.selectedForeground': ink,
      'editorSuggestWidget.highlightForeground': accent,
      'editorSuggestWidget.focusHighlightForeground': accent,
      'editorHoverWidget.background': surface1,
      'editorHoverWidget.border': line,
      'editorHoverWidget.foreground': dim,
      'list.hoverBackground': surface2,
      'list.focusBackground': surface2,
      'list.focusForeground': ink,
      'list.highlightForeground': accent,

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
      'editorBracketMatch.background': alpha(accent, '26'),
      'editorBracketMatch.border': alpha(accent, '80'),

      'editorError.foreground': fail,
      'editorWarning.foreground': flake,
      'editorInfo.foreground': accent,
      'editorGutter.foldingControlForeground': faint,
      'editorLink.activeForeground': accent,
      'editorCodeLens.foreground': faint,

      'editorOverviewRuler.background': surface,
      'editorOverviewRuler.border': line,
      'editorOverviewRuler.findMatchForeground': alpha(accent, 'cc'),
      'editorOverviewRuler.errorForeground': fail,
      'editorOverviewRuler.warningForeground': flake,
      'editorOverviewRuler.selectionHighlightForeground': alpha(accent, '66'),

      'scrollbarSlider.background': alpha(line, 'cc'),
      'scrollbarSlider.hoverBackground': surface2,
      'scrollbarSlider.activeBackground': lineStrong,
    }),
  });
  monaco.editor.setTheme(EDITOR_THEME);
}
