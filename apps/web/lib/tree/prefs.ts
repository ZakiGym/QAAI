'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Grouping, SortMode } from './model';

/**
 * How this person likes the explorer, remembered per PROJECT.
 *
 * Per project rather than per session, unlike the editor's own prefs: sort order
 * and hide patterns are answers about a codebase, not about a pair of eyes. The
 * patterns that hide a generated fixtures folder in one project hide nothing in
 * the next, and a scope — "I am working inside checkout" — belongs to the tree
 * it points into and is meaningless anywhere else.
 *
 * Everything here is stored, read and sanitised as plain data so the reducer
 * above the hook stays testable; the hook is only the localStorage wiring.
 */

export interface TreePrefs {
  sort: SortMode;
  grouping: Grouping;
  compactFolders: boolean;
  /** Glob-ish patterns; see buildTree's `hide`. */
  hide: string[];
  /** Folder path or feature id being used as the root, null for the whole project. */
  scope: string | null;
  /**
   * Tint each row by how that test last finished (feature 28).
   *
   * A preference rather than always-on: the tree's job is to say WHERE a file
   * is, and painting it pass/fail turns the explorer into a second results
   * screen. Some people want exactly that; for others it competes with the
   * active row and the unsaved dot for the same few pixels. Off by default, so
   * the panel reads as a file tree until somebody asks for more.
   */
  tintByResult: boolean;
}

/**
 * Compaction defaults OFF. It is the right default in an IDE with a full-height
 * sidebar and the wrong one in a 150px column, where `hand-written/checkout/deep`
 * is a row that ellipsises to `hand-written/…` and says less than `deep` did.
 */
export const DEFAULT_TREE_PREFS: TreePrefs = {
  sort: 'name',
  grouping: 'path',
  compactFolders: false,
  hide: [],
  scope: null,
  tintByResult: false,
};

const SORT_MODES: readonly SortMode[] = ['name', 'type', 'lastRun', 'flakiness'];
const GROUPINGS: readonly Grouping[] = ['path', 'feature'];

/** Patterns kept per project. Past this the box is a paste, not a preference. */
const MAX_HIDE_PATTERNS = 50;
const MAX_HIDE_LENGTH = 200;

export function treePrefsKey(projectId: string): string {
  return `qaai.tree.prefs.${projectId}`;
}

/**
 * Coerce anything JSON.parse hands back into a usable TreePrefs.
 *
 * Stored prefs are older versions of this app's own writes, which is to say
 * arbitrary shapes: a sort mode we have since renamed, a scope pointing at a
 * deleted folder, `hide` saved as a string before it was a list. Every field
 * falls back independently, so one stale key cannot reset the other four.
 */
export function sanitizeTreePrefs(value: unknown): TreePrefs {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_TREE_PREFS };
  const raw = value as Record<string, unknown>;

  const sort = SORT_MODES.includes(raw.sort as SortMode)
    ? (raw.sort as SortMode)
    : DEFAULT_TREE_PREFS.sort;
  const grouping = GROUPINGS.includes(raw.grouping as Grouping)
    ? (raw.grouping as Grouping)
    : DEFAULT_TREE_PREFS.grouping;

  const hide = Array.isArray(raw.hide)
    ? raw.hide
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && entry.length <= MAX_HIDE_LENGTH)
        .slice(0, MAX_HIDE_PATTERNS)
    : [];

  return {
    sort,
    grouping,
    compactFolders: typeof raw.compactFolders === 'boolean' ? raw.compactFolders : DEFAULT_TREE_PREFS.compactFolders,
    tintByResult: typeof raw.tintByResult === 'boolean' ? raw.tintByResult : DEFAULT_TREE_PREFS.tintByResult,
    hide,
    // '' is not a scope, it is the root, and the root is what null means.
    scope: typeof raw.scope === 'string' && raw.scope.length > 0 ? raw.scope : null,
  };
}

export function readTreePrefs(projectId: string): TreePrefs {
  try {
    const raw = localStorage.getItem(treePrefsKey(projectId));
    if (!raw) return { ...DEFAULT_TREE_PREFS };
    return sanitizeTreePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TREE_PREFS };
  }
}

export function writeTreePrefs(projectId: string, prefs: TreePrefs): void {
  try {
    localStorage.setItem(treePrefsKey(projectId), JSON.stringify(prefs));
  } catch {
    /* private mode — the choice is just for this session */
  }
}

export interface TreePrefsApi {
  /** Merge a change and persist it. */
  set: (patch: Partial<TreePrefs>) => void;
  /** Flip a boolean pref without spelling out its current value. */
  toggle: (key: 'compactFolders' | 'tintByResult') => void;
  /** Back to the whole project, keeping every other preference. */
  clearScope: () => void;
  reset: () => void;
}

/**
 * Read in an effect rather than in the initialiser: the server renders this page
 * too, and seeding state from localStorage during render is the hydration
 * mismatch that makes React throw the tree away and re-mount it — which in the
 * explorer means every open folder snapping shut on load.
 *
 * The first paint is therefore the defaults, for one frame, on purpose.
 */
export function useTreePrefs(projectId: string): [TreePrefs, TreePrefsApi] {
  const [prefs, setPrefs] = useState<TreePrefs>(DEFAULT_TREE_PREFS);

  useEffect(() => {
    setPrefs(readTreePrefs(projectId));
  }, [projectId]);

  const api = useMemo<TreePrefsApi>(() => {
    const commit = (next: TreePrefs): TreePrefs => {
      writeTreePrefs(projectId, next);
      return next;
    };
    return {
      set: (patch) => setPrefs((prev) => commit({ ...prev, ...patch })),
      toggle: (key) => setPrefs((prev) => commit({ ...prev, [key]: !prev[key] })),
      clearScope: () => setPrefs((prev) => commit({ ...prev, scope: null })),
      reset: () => setPrefs(() => commit({ ...DEFAULT_TREE_PREFS })),
    };
  }, [projectId]);

  return [prefs, api];
}

/** The subset of prefs buildTree takes, so a caller can spread one into the other. */
export function buildOptionsFromPrefs(prefs: TreePrefs): {
  sort: SortMode;
  grouping: Grouping;
  compactFolders: boolean;
  hide: string[];
  scope: string | null;
} {
  return {
    sort: prefs.sort,
    grouping: prefs.grouping,
    compactFolders: prefs.compactFolders,
    hide: prefs.hide,
    scope: prefs.scope,
  };
}
