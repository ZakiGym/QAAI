'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The two editor settings a person changes often enough to want remembered.
 *
 * They are preferences, not props: word wrap is about the width of YOUR window
 * and the minimap is about whether you navigate by shape or by scrolling, and
 * neither answer belongs to a file. So they live in localStorage against the
 * session rather than against the project — the same reasoning as the sidebar's
 * collapse state.
 *
 * Both default off. The minimap costs a strip of the only column where the code
 * is, and a wrapped test file hides the indentation that says which `await`
 * belongs to which step; a person who wants either can say so in one click and
 * never say it again.
 */

export interface EditorPrefs {
  minimap: boolean;
  wordWrap: boolean;
}

export const DEFAULT_PREFS: EditorPrefs = { minimap: false, wordWrap: false };

const STORAGE_KEY = 'qaai.editor.prefs';

function read(): EditorPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<EditorPrefs>;
    return {
      minimap: typeof parsed.minimap === 'boolean' ? parsed.minimap : DEFAULT_PREFS.minimap,
      wordWrap: typeof parsed.wordWrap === 'boolean' ? parsed.wordWrap : DEFAULT_PREFS.wordWrap,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * Read in an effect rather than in the initialiser: the server renders this
 * page too, and seeding state from localStorage during render is the hydration
 * mismatch that makes React throw the tree away and re-mount Monaco.
 */
export function useEditorPrefs(): [EditorPrefs, (key: keyof EditorPrefs) => void] {
  const [prefs, setPrefs] = useState<EditorPrefs>(DEFAULT_PREFS);

  useEffect(() => {
    setPrefs(read());
  }, []);

  const toggle = useCallback((key: keyof EditorPrefs) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode — the choice is just for this session */
      }
      return next;
    });
  }, []);

  return [prefs, toggle];
}
