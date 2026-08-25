'use client';

/**
 * Everything the explorer knows and everything it can do — assembled here so
 * that `FileTree` is a renderer and nothing else.
 *
 * Wave 1 left eight pure modules that each answer one question well: what the
 * tree looks like (`model`), which rows a query keeps (`filter`), what is
 * selected (`selection`), what a paste means (`clipboard`), whether a drag can
 * land (`dnd`), what a row says about itself (`decorations`), and how to take
 * any of it back (`undo`). None of them talks to React or to the API. This file
 * is the one place those seams are joined, and it owns the API calls each
 * gesture makes.
 *
 * TWO THINGS SHAPE IT.
 *
 * 1. EVERY DECISION IS A PURE FUNCTION, exported above the hook. `apps/web` has
 *    no jsdom and no component-test setup, so a decision made inside a callback
 *    is a decision no test can reach. Rename validation, the flat-to-nested
 *    regrouping, which API requests a set of operations becomes, where a pending
 *    folder row is inserted — all of it is data in, data out, and the hook only
 *    wires state to those answers.
 *
 * 2. THE TWO ROW LISTS ARE NOT INTERCHANGEABLE, and mixing them is a real bug
 *    rather than an inefficiency. Keyboard navigation and Shift-ranges are
 *    defined against the rows ON SCREEN — stepping into a collapsed folder would
 *    move the cursor somewhere nobody can see. Clipboard and drop PLANNING need
 *    every row in the tree, collapsed ones included: cutting a collapsed folder
 *    whose contents are absent from the list plans a move against a folder the
 *    planner believes is empty, and the refusal it reports is not the real one.
 *    So `rows` is the visible list and `allRows` is the whole tree with every
 *    folder open, and each is passed only where it belongs.
 *
 * WHAT IS DELIBERATELY NOT HERE: rendering, focus, scrolling and menus. Those
 * need a DOM node, and they belong to the component that owns one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import {
  allDirIds,
  buildTree,
  flattenTree,
  type PathDir,
  type TreeCrumb,
  type TreeFile,
  type TreeModel,
  type TreeNode,
  type TreeTest,
} from '../../lib/tree/model';
import { matchTree, type MatchRange } from '../../lib/tree/filter';
import {
  buildOptionsFromPrefs,
  useTreePrefs,
  type TreePrefs,
  type TreePrefsApi,
} from '../../lib/tree/prefs';
import { panelRows, rowById, rowIdFor, type PanelRow } from '../../lib/tree/rows';
import {
  allSelectedIds,
  applyClick,
  EMPTY_SELECTION,
  handleKey,
  hiddenSelectionCount,
  NO_TYPE_AHEAD,
  reconcileSelection,
  selectOnly,
  type SelectionState,
  type TypeAhead,
} from '../../lib/tree/selection';
import {
  baseName,
  copy as clipCopy,
  cut as clipCut,
  cutIds,
  folderTargetOf,
  isWithin,
  joinPath,
  parentOf,
  paste as clipPaste,
  pruneContained,
  splitName,
  type ClipboardState,
  type Refusal,
  type TreeOp,
} from '../../lib/tree/clipboard';
import {
  canDropOn,
  dragIdsFor,
  effectFromModifiers,
  planDropOn,
  type DropEffect,
} from '../../lib/tree/dnd';
import {
  assignmentSummary,
  buildSuiteTree,
  canDropOnSuite,
  freeSuiteName,
  NO_SUITE_LABEL,
  planSuiteDrop,
  suiteAssignRequests,
  suiteContext,
  suiteDropTargetOf,
  suiteGroupId,
  suiteGroupOf,
  suiteNamesExcept,
  validateSuiteName,
  type SuiteAssignOp,
  type SuiteContext,
  type SuiteGrouping,
  type SuiteTreeModel,
  type TreeSuite,
} from '../../lib/tree/suites';
import {
  canRedo,
  canUndo,
  commitRedo,
  commitUndo,
  describeEntry,
  EMPTY_UNDO,
  entryForOps,
  peekRedo,
  peekUndo,
  record,
  redoEdits,
  undoEdits,
  type TreeEdit,
  type UndoEntry,
  type UndoStack,
} from '../../lib/tree/undo';
import {
  decorationCounts,
  mergeDecorationCounts,
  topDecoration,
  type Decoration,
  type DecorationCounts,
  type LastResultStatus,
  type RowSignals,
} from '../../lib/tree/decorations';

// ─── Shapes the panel is given ───────────────────────────────────────────────

/**
 * A test as `GET /projects/:id/tests` actually returns it.
 *
 * `TreeTest` is the model's minimum; these two extra columns are what the badges
 * are made of. Optional, so a caller that has not threaded them through still
 * typechecks and simply gets no result badges rather than a compile error.
 */
export interface TreeTestRow extends TreeTest {
  /** The last run's status. `null` for a test that has never run — not the same as skipped. */
  lastStatus?: LastResultStatus | null;
  quarantined?: boolean;
  /**
   * The suite this test is in, which is what `grouping: 'suite'` groups by.
   *
   * Optional for the same reason as the two above: `GET /projects/:id/tests` has
   * always selected it, so it is in the payload whether or not a caller's own
   * type declares it, and a caller that really does omit it gets one honest "No
   * suite" group rather than a compile error.
   */
  suiteId?: string | null;
}

export interface TreeControllerOptions {
  tests: readonly TreeTestRow[];
  projectId: string;
  /** The file open in the editor — the active row, and what auto-reveal chases. */
  openTestId: string | null;
  /** That file when its buffer has unsaved edits. */
  dirtyTestId: string | null;
  onOpen: (testId: string) => void;
  /** Ask the parent for its "new file" flow, rooted at `folderPath` (`''` = project root). */
  onAdd: (folderPath: string) => void;
  /** A structural change landed; reload the test list. Awaited before the status settles. */
  onChanged?: () => void | Promise<void>;
  /** These tests are gone — close their tabs. */
  onClosed?: (testIds: string[]) => void;
  /** Feature 30: scope the search panel to a folder. */
  onFindInFolder?: (folderPath: string) => void;
  /** Feature 29: start a run over exactly these tests. */
  onRunTests?: (testIds: string[], label: string) => void;
  /**
   * Feature 25 — compare exactly two files.
   *
   * Two ids rather than a list: a diff of three things is not a diff, and
   * offering it for any other count would put a menu item on screen that
   * refuses itself. The panel only enables the item when two files are
   * selected, so the caller never receives a count it cannot render.
   */
  onCompare?: (leftTestId: string, rightTestId: string) => void;
}

// ─── Layout constants the row and the panel share ────────────────────────────

/**
 * The row height in pixels, stated rather than inherited.
 *
 * Sticky folder headers need it: a header at depth 2 has to stop below the two
 * above it, which is `depth * ROW_HEIGHT` and nothing else. A row sized by its
 * line box would make that offset a guess that drifts with the font.
 */
export const ROW_HEIGHT = 22;

/** Pixels of indent per level. One indent guide is drawn per step. */
export const INDENT = 12;

// ─── Nesting, for groups and sticky headers ──────────────────────────────────

/** A visible row and the rows drawn underneath it. */
export interface RowNode {
  row: PanelRow;
  children: RowNode[];
}

/**
 * Re-nest the flattened list by depth.
 *
 * Two things need the shape back. ARIA: a `treeitem`'s children belong in a
 * `role="group"`, and a flat run of siblings is a lie about the structure a
 * screen reader reads out. And sticky headers: a folder header should stay
 * pinned only until ITS OWN subtree has scrolled past, which means the subtree
 * has to be an element the header lives inside — given the whole panel as its
 * container it would sit over folders it has nothing to do with.
 *
 * The flat list stays the source of truth for navigation; this is a rendering
 * regrouping and it preserves order exactly.
 */
export function nestRows(rows: readonly PanelRow[]): RowNode[] {
  const roots: RowNode[] = [];
  const stack: RowNode[] = [];
  for (const row of rows) {
    const node: RowNode = { row, children: [] };
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top && top.row.depth < row.depth) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/** Every ancestor folder of a path, root-most first. `a/b/c.ts` → `a`, `a/b`. */
export function ancestorPaths(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * The folder ids between the roots and `targetId`, outermost first, or null when
 * the node is not in this tree.
 *
 * Derived from the built tree rather than from the path string, because the
 * answer differs by mode and by preference: in feature grouping the ancestor is
 * `feature:Checkout` and has no path at all, and under compaction three real
 * folders share one row and therefore one id. Auto-reveal has to open the rows
 * that exist, not the folders that would exist in some other view.
 */
export function ancestorDirIds(nodes: readonly TreeNode[], targetId: string): string[] | null {
  const walk = (list: readonly TreeNode[], trail: string[]): string[] | null => {
    for (const node of list) {
      if (node.id === targetId) return trail;
      if (node.kind === 'dir') {
        const found = walk(node.children, [...trail, node.id]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(nodes, []);
}

/**
 * A path as it reads from the tree's current root.
 *
 * "Copy relative path" is only a different answer from "Copy path" while a scope
 * is set — everything this app stores is already project-relative, the way git
 * stores it. A feature scope is not a path and cannot shorten one.
 */
export function relativeToScope(path: string, scope: string | null): string {
  if (!scope || scope.startsWith('feature:')) return path;
  if (!isWithin(path, scope)) return path;
  return path.slice(scope.length + 1);
}

// ─── Names ───────────────────────────────────────────────────────────────────

/** Long enough for any real filename, short enough to keep the 300-char path cap reachable. */
const MAX_NAME = 120;

/**
 * Control characters, which survive a paste and produce a path nothing can
 * address. Matching them IS the point here, so `no-control-regex` — a rule that
 * reads a control character in a pattern as a typo — is wrong about this one
 * line, and is turned off for it rather than worked around with an escape that
 * would obscure what the class contains.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f]/;

export interface NameCheck {
  ok: boolean;
  /** Ready to show under the input. Null when `ok`. */
  message: string | null;
}

/**
 * Is this a name the server will accept, and is it free?
 *
 * Checked here rather than left to the API because a rename is an inline edit:
 * the input is still open and still focused, so saying "that name has a slash in
 * it" beside it costs nothing, while a round trip that comes back 400 has
 * already closed the editor and thrown the typing away.
 *
 * The rules are the server's own (`relativeFilePath` in @qaai/shared: relative,
 * no `..`) plus the two that a single path SEGMENT adds — a name cannot contain
 * a separator, and `.`/`..` are not names.
 */
export function validateName(
  raw: string,
  kind: 'file' | 'dir',
  taken: ReadonlySet<string>,
): NameCheck {
  const name = raw.trim();
  const thing = kind === 'dir' ? 'A folder' : 'A file';
  if (name.length === 0) return { ok: false, message: `${thing} needs a name` };
  if (name.length > MAX_NAME) return { ok: false, message: `Keep it under ${MAX_NAME} characters` };
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, message: 'A name cannot contain a slash — drag it instead to move it' };
  }
  if (name === '.' || name === '..') return { ok: false, message: 'That is not a name' };
  if (INVISIBLE.test(name)) return { ok: false, message: 'That name has invisible characters in it' };
  if (taken.has(name)) return { ok: false, message: `${name} already exists here` };
  return { ok: true, message: null };
}

/**
 * The text an inline rename starts with.
 *
 * A compacted folder row is LABELLED `hand-written/checkout/deep` and ACTS on
 * the deepest folder — so the thing being renamed is `deep`, and offering the
 * joined label as editable text would invite a name with slashes in it that the
 * validator would then have to refuse.
 */
export function editableName(row: PanelRow): string {
  if (row.kind !== 'dir') return row.name;
  return baseName(row.path) || row.name;
}

/**
 * What to preselect when the input opens: the stem, leaving the extension.
 *
 * Renaming `order-total.spec.ts` almost never means renaming the `.ts`, and a
 * fully-selected name means the first keystroke destroys the suffix that decides
 * whether the file is still a test. A folder has no extension, so its whole name
 * is selected.
 */
export function nameSelection(name: string, kind: 'file' | 'dir'): { start: number; end: number } {
  if (kind === 'dir') return { start: 0, end: name.length };
  const { stem } = splitName(name);
  return { start: 0, end: stem.length };
}

// ─── Highlighting a compacted label ──────────────────────────────────────────

/** Where the filter's hits fall inside one segment of a compacted folder label. */
export interface SegmentHighlight {
  /** The hits, rebased onto this segment's own text. */
  ranges: MatchRange[];
  /** True when the `/` drawn BEFORE this segment is itself inside a hit. */
  separatorMatched: boolean;
}

/**
 * Map filter hits onto the segments of a compacted folder label.
 *
 * `filter.ts` returns ranges into the node's `name`, and for a compacted row that
 * name is the JOINED label — `hand-written/checkout/deep`. The row draws one
 * element per segment, so a range at offset 14 belongs to no string the renderer
 * holds until it has been walked back onto the segment it falls in. Without this
 * step a match inside a compacted chain is the one match in the tree that is
 * never marked, and the filter silently looks broken exactly where the label is
 * longest.
 *
 * A range that straddles a separator is clipped into both segments and the `/`
 * between them is reported as matched, because a query of `out/de` really did hit
 * across the join and drawing only half of it would be a different lie.
 */
export function rangesForSegments(
  segments: readonly { name: string }[],
  ranges: readonly MatchRange[] | undefined,
): SegmentHighlight[] {
  const out: SegmentHighlight[] = segments.map(() => ({ ranges: [], separatorMatched: false }));
  if (!ranges || ranges.length === 0) return out;
  let at = 0;
  segments.forEach((segment, index) => {
    const hit = out[index];
    const end = at + segment.name.length;
    if (hit) {
      // The separator sits one character before this segment; segment 0 has none.
      const separator = index === 0 ? -1 : at - 1;
      for (const range of ranges) {
        if (separator >= 0 && range.start <= separator && range.end > separator) {
          hit.separatorMatched = true;
        }
        const from = Math.max(range.start, at);
        const to = Math.min(range.end, end);
        if (from < to) hit.ranges.push({ start: from - at, end: to - at });
      }
    }
    at = end + 1;
  });
  return out;
}

/** Names already spoken for in a folder, so a rename can refuse a collision. */
export function siblingNames(
  rows: readonly PanelRow[],
  parentPath: string,
  exceptId: string | null,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.parentPath !== parentPath || row.id === exceptId) continue;
    out.add(row.kind === 'dir' ? editableName(row) : row.name);
  }
  return out;
}

/** `new-folder`, `new-folder-2`, … — the first one nothing else in that folder claims. */
export function freeFolderName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ─── Reading a subtree ───────────────────────────────────────────────────────

/** Every file beneath a node, itself included when it is one. */
export function descendantFiles(node: TreeNode): Array<{ id: string; path: string; name: string }> {
  const out: Array<{ id: string; path: string; name: string }> = [];
  const walk = (current: TreeNode): void => {
    if (current.kind === 'file') {
      // The file NAME, not the row's label: in feature grouping a row is
      // labelled with the test's name, and an undo entry reading "Restore
      // Checkout totals" instead of a path is a record of nothing.
      out.push({ id: current.id, path: current.path, name: baseName(current.path) });
      return;
    }
    for (const child of current.children) walk(child);
  };
  walk(node);
  return out;
}

/** The test ids beneath a node — what "Run this folder" hands to the runner. */
export function descendantTestIds(node: TreeNode): string[] {
  return descendantFiles(node).map((file) => file.id);
}

/** Sibling folder ids of a row — Alt-clicking a chevron collapses exactly these. */
export function siblingDirIds(rows: readonly PanelRow[], row: PanelRow): string[] {
  return rows
    .filter(
      (candidate) =>
        candidate.kind === 'dir' &&
        candidate.depth === row.depth &&
        candidate.parentPath === row.parentPath &&
        candidate.id !== row.id,
    )
    .map((candidate) => candidate.nodeId);
}

// ─── Expansion ───────────────────────────────────────────────────────────────

/**
 * Expansion is stored as the folders that were CLOSED, not the ones left open.
 *
 * Folders here are implicit in paths, so the Generator writing a test into a
 * folder nobody has seen before creates a folder nobody has an opinion about.
 * Remembering openings would draw that folder shut, and every new folder in the
 * project would arrive collapsed. Remembering closures makes "open" the default
 * and keeps a person's actual choices — which is what the old panel did, down to
 * the storage key, so nobody's collapsed folders spring open the day the panel
 * is swapped.
 */
export function expandedFrom(
  dirIds: readonly string[],
  collapsed: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const id of dirIds) if (!collapsed.has(id)) out.add(id);
  return out;
}

export const collapsedKey = (projectId: string): string => `qaai.tree.collapsed.${projectId}`;
export const autoRevealKey = (projectId: string): string => `qaai.tree.autoReveal.${projectId}`;

// ─── Pending folders (feature 2) ─────────────────────────────────────────────

/*
 * An empty folder cannot exist on the server. There is no folder table; a folder
 * is the slashes inside some test's `filePath`, exactly as in git. So "New
 * Folder" cannot persist anything, and pretending otherwise would hand someone a
 * folder that survives until they reload.
 *
 * What it does instead: keep the folder in this panel's own state, draw it as a
 * real row that can be renamed, dropped into and have a file created in — and
 * say plainly that it is not saved yet. The moment a file lands inside it the
 * path is real, the model grows the folder itself, and the pending entry is
 * dropped (`prunePending`). Nothing is faked and nothing is lost silently: a
 * reload with no file in it takes the row away, which is the truth.
 */

function pendingDirNode(path: string, name: string): PathDir {
  return {
    kind: 'dir',
    source: 'path',
    id: path,
    name,
    path,
    segments: [{ name, path }],
    children: [],
    fileCount: 0,
    flagCount: 0,
    hiddenCount: 0,
    lastRunAt: null,
    flakeRate: 0,
  };
}

/** Drop the pending folders the tree has since grown for real. */
export function prunePending(
  pending: readonly string[],
  realDirPaths: ReadonlySet<string>,
): string[] {
  return pending.filter((path) => !realDirPaths.has(path));
}

/**
 * Splice pending folder rows into a row list, each at the end of its parent's
 * children so it reads as the newest thing in that folder.
 *
 * Sorted, so `a` is inserted before `a/b` and a pending folder nested inside a
 * pending folder finds its parent already there. A pending row whose parent is
 * not in the list is dropped rather than floated up to the root — a row that
 * appears in the wrong folder is worse than one that waits for its folder to be
 * expanded.
 */
export function injectPendingFolders(
  rows: readonly PanelRow[],
  pending: readonly string[],
): PanelRow[] {
  if (pending.length === 0) return [...rows];
  const out = [...rows];
  for (const path of [...pending].sort()) {
    const parent = parentOf(path);
    const name = baseName(path);
    const parentIndex =
      parent === '' ? -1 : out.findIndex((row) => row.kind === 'dir' && row.path === parent);
    if (parent !== '' && parentIndex === -1) continue;
    const parentRow = parentIndex === -1 ? null : out[parentIndex];
    const depth = parentRow ? parentRow.depth + 1 : 0;
    // Past the parent's whole subtree. At the root that walks to the end of the
    // list, since no row has a depth below zero.
    let at = parentIndex + 1;
    while (at < out.length) {
      const row = out[at];
      if (!row || row.depth < depth) break;
      at += 1;
    }
    const node = pendingDirNode(path, name);
    out.splice(at, 0, {
      id: rowIdFor(node),
      nodeId: node.id,
      kind: 'dir',
      name,
      path,
      parentPath: parent,
      depth,
      expanded: true,
      node,
    });
  }
  return out;
}

/** Rename a pending folder, carrying anything nested inside it along with it. */
export function renamePending(pending: readonly string[], from: string, to: string): string[] {
  return pending.map((path) =>
    path === from ? to : isWithin(path, from) ? `${to}${path.slice(from.length)}` : path,
  );
}

// ─── Turning operations into API calls ───────────────────────────────────────

/**
 * The API's cap on one batch (`BATCH_MAX_FILES` in apps/api). A multi-drag larger
 * than this is split rather than refused — each chunk is atomic on its own,
 * which is weaker than one transaction and still far better than one request per
 * file.
 */
export const BATCH_LIMIT = 200;

/** A single call this panel makes. Named, so the mapping is testable without a network. */
export type TreeRequest =
  | { kind: 'move-file'; opId: string; testId: string; to: string }
  | { kind: 'batch-move'; opIds: string[]; moves: Array<{ testId: string; filePath: string }> }
  | { kind: 'move-folder'; opId: string; from: string; to: string }
  | { kind: 'copy-file'; opId: string; testId: string; to: string }
  | { kind: 'delete-file'; testId: string }
  | { kind: 'batch-delete'; testIds: string[] }
  | { kind: 'delete-folder'; path: string }
  | { kind: 'restore-file'; testId: string }
  /**
   * Putting tests into a suite, or taking them out. Addressed to the SUITE
   * because the endpoint is: `direction` says which of its two batch routes,
   * and both are atomic on the server.
   */
  | {
      kind: 'suite-assign';
      opIds: string[];
      suiteId: string;
      direction: 'assign' | 'unassign';
      testIds: string[];
    }
  | { kind: 'suite-rename'; suiteId: string; name: string }
  | { kind: 'suite-delete'; suiteId: string };

/**
 * Everything a gesture in this panel can plan.
 *
 * A `TreeOp` moves or copies a FILE PATH; a `SuiteAssignOp` changes which suite
 * a test is in and touches no path at all. They are one union rather than two
 * pipelines so that a drop, wherever it lands, goes through one planner, one
 * executor and one status line — `requestsForOps` below is the single place the
 * difference is read, and it reads `kind`, never a path.
 */
export type PanelOp = TreeOp | SuiteAssignOp;

/**
 * How far a sequential batch got.
 *
 * The requests go out one at a time, so "it failed" is never the whole truth:
 * everything before the failure has already been written. `done` is how many of
 * them that was, and it is what decides whether the tree is stale, what undo may
 * record, and what the status line is allowed to claim.
 */
export interface BatchOutcome {
  /** Server-assigned ids for the rows a copy created, keyed by op id. */
  created: Record<string, string>;
  /** How many requests the server accepted before it stopped. */
  done: number;
  /** What stopped it, or null when every request landed. */
  error: unknown;
}

/** An operation this panel cannot perform, with the reason a person needs. */
export interface Unsupported {
  id: string;
  path: string;
  message: string;
}

/*
 * The `d:` / `f:` namespacing, ASKED FOR rather than restated.
 *
 * `rows.ts` owns that convention. A second literal `'d:'` here would be a copy
 * of a rule that lives somewhere else, and the day the two disagree every cut,
 * move and drop keyed on an id acts on the wrong row — the class of bug the
 * namespacing was introduced to remove in the first place. So this asks
 * `rowIdFor` to name a node whose id is empty: what comes back IS the prefix, by
 * construction, and it cannot drift.
 *
 * A `DIR_ROW_PREFIX` exported from `rows.ts` would be tidier still; that file is
 * not this wave's to edit.
 */
const EMPTY_ID_DIR: PathDir = {
  kind: 'dir',
  source: 'path',
  id: '',
  name: '',
  path: '',
  segments: [],
  children: [],
  fileCount: 0,
  flagCount: 0,
  hiddenCount: 0,
  lastRunAt: null,
  flakeRate: 0,
};

const EMPTY_ID_FILE: TreeFile = {
  kind: 'file',
  source: 'path',
  id: '',
  name: '',
  path: '',
  test: { id: '', name: '', type: '', filePath: '', reviewFlags: [] },
};

export const DIR_ROW_PREFIX = rowIdFor(EMPTY_ID_DIR);
export const FILE_ROW_PREFIX = rowIdFor(EMPTY_ID_FILE);

/** Row ids are namespaced (`rows.ts`), which is also how an op says what it acts on. */
export const isDirRowId = (id: string): boolean => id.startsWith(DIR_ROW_PREFIX);

/** The bare test id behind a file row id. */
export const testIdOfRowId = (id: string): string =>
  id.startsWith(FILE_ROW_PREFIX) ? id.slice(FILE_ROW_PREFIX.length) : id;

/**
 * The calls a planned paste or drop becomes.
 *
 * Three shapes, because the API has three and each earns its place:
 *
 *  · A folder move is ONE request (`POST /folders/move`) that rewrites a path
 *    prefix across everything beneath it. Expanding it into a move per file here
 *    would be slower, non-atomic, and would break the moment a folder held more
 *    files than one batch may carry.
 *  · Two or more file moves go through `tests/batch/move`, which validates the
 *    whole set before writing any of it. Forty PATCHes is not a slower version
 *    of that — it is a different operation, one that can stop on the thirty-ninth
 *    and leave a tree matching neither state.
 *  · A single file move stays a single PATCH. Wrapping one move in a batch buys
 *    nothing and reports its errors less precisely.
 *
 * Copying a FOLDER has no endpoint behind it, and is refused by name rather than
 * quietly skipped — see `Unsupported`.
 *
 * Grouping reorders file moves relative to folder moves, which is safe because
 * `pruneContained` has already removed anything nested inside a moving folder,
 * leaving the remaining operations independent of one another.
 */
export function requestsForOps(ops: readonly PanelOp[]): {
  requests: TreeRequest[];
  unsupported: Unsupported[];
} {
  const requests: TreeRequest[] = [];
  const unsupported: Unsupported[] = [];
  const fileMoves: TreeOp[] = [];
  const assignments: SuiteAssignOp[] = [];

  for (const op of ops) {
    /*
     * An assignment is not a move with a different destination — nothing about
     * the file's path changes — so it is split out on `kind` before anything
     * here looks at `from`/`to`, which for these ops hold suite ids. Grouping
     * and chunking them is `suites.ts`'s job, next to the planner that made
     * them.
     */
    if (op.kind === 'assign') {
      assignments.push(op);
      continue;
    }
    // `entity`, never the id: `clipboard.ts` states outright that a `d:` id
    // addresses nothing on the server, and guessing the kind from the path is
    // the mistake that field exists to stop.
    const isDir = op.entity === 'dir';
    if (op.kind === 'move') {
      if (isDir) requests.push({ kind: 'move-folder', opId: op.id, from: op.from, to: op.to });
      else fileMoves.push(op);
      continue;
    }
    if (isDir) {
      unsupported.push({
        id: op.id,
        path: op.from,
        message: `${baseName(op.from)}/ cannot be copied — copy the files inside it instead`,
      });
      continue;
    }
    requests.push({ kind: 'copy-file', opId: op.id, testId: testIdOfRowId(op.id), to: op.to });
  }

  for (let at = 0; at < fileMoves.length; at += BATCH_LIMIT) {
    const chunk = fileMoves.slice(at, at + BATCH_LIMIT);
    const only = chunk.length === 1 ? chunk[0] : null;
    if (only) {
      requests.push({
        kind: 'move-file',
        opId: only.id,
        testId: testIdOfRowId(only.id),
        to: only.to,
      });
      continue;
    }
    requests.push({
      kind: 'batch-move',
      opIds: chunk.map((op) => op.id),
      moves: chunk.map((op) => ({ testId: testIdOfRowId(op.id), filePath: op.to })),
    });
  }

  for (const call of suiteAssignRequests(assignments, BATCH_LIMIT)) {
    requests.push({ kind: 'suite-assign', ...call });
  }

  return { requests, unsupported };
}

/**
 * Every op id a list of requests covers.
 *
 * The batch is sent one request at a time, so a failure halfway leaves the
 * requests BEFORE it already applied on the server. Undo has to be told about
 * exactly those and no others — recording the whole gesture would make ⌘Z try to
 * reverse moves that never happened, and recording none of it would strand six
 * real moves with no way back. This maps the prefix of requests that landed onto
 * the ops behind them.
 */
export function opIdsOf(requests: readonly TreeRequest[]): string[] {
  const out: string[] = [];
  for (const request of requests) {
    if (request.kind === 'batch-move' || request.kind === 'suite-assign') {
      out.push(...request.opIds);
    } else if ('opId' in request) {
      out.push(request.opId);
    }
  }
  return out;
}

/**
 * The call that undoes (or redoes) one recorded edit.
 *
 * `null` means the edit cannot be replayed against this API, and the caller must
 * refuse the whole gesture rather than apply the half it understands. In
 * practice only a folder `restore` reaches that, and folder deletes are recorded
 * as one edit PER FILE precisely so their inverse is a list of file restores the
 * API does have — see `doDelete`. A bare `create` is likewise unreachable,
 * because `undo.ts` settles a create into the delete/restore pair after one
 * round trip.
 */
export function requestForEdit(edit: TreeEdit): TreeRequest | null {
  switch (edit.kind) {
    case 'move':
      return isDirRowId(edit.id)
        ? { kind: 'move-folder', opId: edit.id, from: edit.from, to: edit.to }
        : { kind: 'move-file', opId: edit.id, testId: testIdOfRowId(edit.id), to: edit.to };
    case 'delete':
      return isDirRowId(edit.id)
        ? { kind: 'delete-folder', path: edit.path }
        : { kind: 'delete-file', testId: testIdOfRowId(edit.id) };
    case 'restore':
      return isDirRowId(edit.id) ? null : { kind: 'restore-file', testId: testIdOfRowId(edit.id) };
    case 'create':
      return null;
  }
}

/** All of them, or null the moment one cannot be replayed. */
export function requestsForEdits(edits: readonly TreeEdit[]): TreeRequest[] | null {
  const out: TreeRequest[] = [];
  for (const edit of edits) {
    const request = requestForEdit(edit);
    if (!request) return null;
    out.push(request);
  }
  return out;
}

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * One line for a list of refusals: the first reason in full, then a count.
 *
 * The first in full rather than a tally of all of them, because a refusal is only
 * useful if it says which file and why, and a panel this narrow has room for
 * exactly one sentence.
 */
export function refusalSummary(refusals: ReadonlyArray<{ message: string }>): string | null {
  const first = refusals[0];
  if (!first) return null;
  return refusals.length === 1 ? first.message : `${first.message} (+${refusals.length - 1} more)`;
}

/** What the status line says once a gesture has landed. */
export function outcomeMessage(
  verb: string,
  done: number,
  refused: ReadonlyArray<{ message: string }>,
): string {
  const head = `${verb} ${done} ${done === 1 ? 'item' : 'items'}`;
  const tail = refusalSummary(refused);
  return tail ? `${head} — ${tail}` : `${head}. Undo with ⌘Z.`;
}

/** ApiError carries the server's own sentence; anything else gets a fallback. */
export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * What the status line says when a sequential batch stopped partway.
 *
 * The count is not decoration. Request seven of twelve failing does not mean
 * "the move failed" — six moves ALREADY happened on the server, and a bare
 * failure invites the person to repeat work that succeeded and then read a
 * second, stranger error when the source is no longer where it was. So the
 * number of landed requests is stated, and whether ⌘Z can take them back is
 * stated with it, because that differs by gesture: a move records the ops that
 * actually applied, while a delete's undo entry is built by hand from a list
 * that no longer describes what happened.
 */
export function partialMessage(
  done: number,
  total: number,
  reason: string,
  undoable: boolean,
): string {
  if (done === 0) return reason;
  const head = `${done} of ${total} done, then stopped — ${reason}`;
  return undoable ? `${head} ⌘Z takes back the ${done}.` : head;
}

// ─── Files the view cannot see ───────────────────────────────────────────────

/**
 * The files a `hide` pattern removed from the view.
 *
 * `allRows` is the whole tree with every folder open, and it is still not every
 * file: `buildTree` prunes hidden ones out of the model itself. That leaves a
 * collision nothing on screen can explain — rename `a.spec.ts` to the name of a
 * file the hide pattern ate and the sibling check passes, the request goes out,
 * and the server answers with a uniqueness error about a file the person cannot
 * see anywhere in the panel.
 *
 * Comparing the test list this panel was GIVEN against the paths it drew names
 * the difference. A scope narrows the model too, but a scoped-away path can
 * never equal a destination inside the scope, so it cannot produce a false
 * positive here.
 */
/** One shared empty set, so "nothing is hidden" is not a new object every render. */
const NO_HIDDEN_PATHS: ReadonlySet<string> = new Set<string>();

export function hiddenFilePaths(
  tests: readonly { filePath: string }[],
  rows: readonly PanelRow[],
): Set<string> {
  const visible = new Set<string>();
  for (const row of rows) if (row.kind === 'file') visible.add(row.path);
  const out = new Set<string>();
  for (const test of tests) if (!visible.has(test.filePath)) out.add(test.filePath);
  return out;
}

/**
 * Would this destination land on a file the view cannot see?
 *
 * A folder is taken as soon as ONE hidden file lives under it — folders exist
 * only as the prefixes of file paths here, so a hidden file at `a/c/x.spec.ts`
 * is exactly what makes `a/c` already exist.
 */
export function hiddenNameTaken(
  target: string,
  kind: 'file' | 'dir',
  hidden: ReadonlySet<string>,
): boolean {
  if (hidden.size === 0) return false;
  if (kind === 'file') return hidden.has(target);
  for (const path of hidden) if (isWithin(path, target)) return true;
  return false;
}

/** The sentence a collision with an invisible file gets. It names the cause, not the API's. */
export function hiddenTakenMessage(name: string): string {
  return `${name} already exists — a hidden file has that name. Clear the hide patterns in the view menu to see it.`;
}

/**
 * Split planned ops into the ones that can be sent and the ones that would land
 * on a hidden file, refused here rather than by the server.
 */
export function splitHiddenConflicts(
  ops: readonly TreeOp[],
  hidden: ReadonlySet<string>,
): { ops: TreeOp[]; refused: Unsupported[] } {
  if (hidden.size === 0) return { ops: [...ops], refused: [] };
  const keep: TreeOp[] = [];
  const refused: Unsupported[] = [];
  for (const op of ops) {
    if (hiddenNameTaken(op.to, op.entity === 'dir' ? 'dir' : 'file', hidden)) {
      refused.push({ id: op.id, path: op.from, message: hiddenTakenMessage(baseName(op.to)) });
    } else {
      keep.push(op);
    }
  }
  return { ops: keep, refused };
}

// ─── Unsaved folders ─────────────────────────────────────────────────────────

/**
 * Split row ids into the ones the server knows about and the unsaved folders it
 * does not.
 *
 * A pending folder lives in panel state and nowhere else — there is no directory
 * to move and no file to copy — so cut, copy and drag have to special-case it
 * the way rename and delete already do. An id that resolves to no row at all is
 * kept: the planners refuse it by name, and swallowing it here would hide that.
 */
export function splitPending(
  rows: readonly PanelRow[],
  ids: readonly string[],
  pendingPaths: ReadonlySet<string>,
): { ids: string[]; pending: PanelRow[] } {
  const keep: string[] = [];
  const pending: PanelRow[] = [];
  for (const id of ids) {
    const row = rowById(rows, id);
    if (row && row.kind === 'dir' && pendingPaths.has(row.path)) pending.push(row);
    else keep.push(id);
  }
  return { ids: keep, pending };
}

/** Why an unsaved folder cannot be cut, copied or dragged. `verb` is `move` or `copy`. */
export function pendingRefusal(rows: readonly PanelRow[], verb: string): string {
  const only = rows.length === 1 ? rows[0] : null;
  if (only) {
    const name = baseName(only.path) || only.name;
    return `${name}/ is not saved yet — there is nothing on the server to ${verb}. Put a file in it first.`;
  }
  return `${rows.length} unsaved folders have nothing on the server to ${verb} — put a file in each first.`;
}

// ─── The drag payload ────────────────────────────────────────────────────────

/**
 * The MIME type the tree writes when rows are dragged, and the ONLY thing a drop
 * target may use to recognise them.
 *
 * `text/plain` is written alongside it so that a drag out of the panel into an
 * editor or a terminal pastes paths rather than `[object Object]` — but it can
 * never be the signal. Dragging a selected sentence out of any other application
 * arrives as `text/plain` too, and a target that accepted that would light up as
 * a file drop for a word someone highlighted in a browser.
 *
 * READING IT: during `dragover` the DnD spec exposes only `dataTransfer.types` —
 * the data itself is protected until the drop. So a target decides whether it
 * will accept with `types.includes(TREE_DRAG_MIME)` and calls `getData` only in
 * its `drop` handler, where `parseTreeDrag` turns the string back into rows.
 */
export const TREE_DRAG_MIME = 'application/x-qaai-tree-rows+json';

/** One dragged row, as it crosses the `dataTransfer` boundary. */
export interface TreeDragRow {
  /** The namespaced row id (`d:` / `f:`), exactly as `rows.ts` mints it. */
  id: string;
  kind: 'file' | 'dir';
  /** Project-relative path. A folder's is the folder the row ACTS on. */
  path: string;
  /** The test id behind a file row; null for a folder, which has none. */
  testId: string | null;
}

/** The payload behind {@link TREE_DRAG_MIME}. */
export interface TreeDragPayload {
  /** Bumped if the shape ever changes. A reader that does not know the version must refuse. */
  v: 1;
  /** A drag between two projects open side by side must not land; the reader checks this. */
  projectId: string;
  rows: TreeDragRow[];
}

/** The payload for a set of dragged rows. Unresolvable ids are dropped, not guessed at. */
export function treeDragPayload(
  rows: readonly PanelRow[],
  ids: readonly string[],
  projectId: string,
): TreeDragPayload {
  const out: TreeDragRow[] = [];
  for (const id of ids) {
    const row = rowById(rows, id);
    if (!row) continue;
    out.push({
      id: row.id,
      kind: row.kind,
      path: row.path,
      testId: row.kind === 'file' ? row.nodeId : null,
    });
  }
  return { v: 1, projectId, rows: out };
}

/**
 * Read a payload back, or null.
 *
 * Every field is checked rather than trusted. `dataTransfer` is a boundary the
 * operating system hands to us: the string can come from another version of this
 * app in a second tab, or from any application at all that decided to write our
 * MIME type, and a drop handler that assumes the shape crashes the panel on
 * malformed input instead of ignoring it.
 */
export function parseTreeDrag(raw: string | null | undefined): TreeDragPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const shape = parsed as Partial<TreeDragPayload>;
  if (shape.v !== 1 || typeof shape.projectId !== 'string' || !Array.isArray(shape.rows)) {
    return null;
  }
  const rows: TreeDragRow[] = [];
  for (const entry of shape.rows) {
    if (typeof entry !== 'object' || entry === null) return null;
    const row = entry as Partial<TreeDragRow>;
    if (typeof row.id !== 'string' || typeof row.path !== 'string') return null;
    if (row.kind !== 'file' && row.kind !== 'dir') return null;
    if (typeof row.testId !== 'string' && row.testId !== null) return null;
    rows.push({ id: row.id, kind: row.kind, path: row.path, testId: row.testId });
  }
  return { v: 1, projectId: shape.projectId, rows };
}

// ─── Decorations, folded once per tree ───────────────────────────────────────

/**
 * Every row's badge, computed in one bottom-up pass and keyed by ROW id.
 *
 * Per row on render would be O(subtree) for every folder on screen, recomputed on
 * each keystroke in the filter box. It also has to fold over each descendant's
 * whole tally rather than over its winning badge — `decorations.ts` spells out
 * why: a folder of dirty-and-failed files would otherwise report zero failures.
 */
export function buildDecorations(
  nodes: readonly TreeNode[],
  signalsFor: (test: TreeTest) => RowSignals,
): Map<string, Decoration | null> {
  const out = new Map<string, Decoration | null>();
  const walk = (node: TreeNode): DecorationCounts => {
    if (node.kind === 'file') {
      const counts = decorationCounts(signalsFor(node.test));
      out.set(rowIdFor(node), topDecoration(counts));
      return counts;
    }
    const merged = mergeDecorationCounts(node.children.map(walk));
    out.set(rowIdFor(node), topDecoration(merged));
    return merged;
  };
  for (const node of nodes) walk(node);
  return out;
}

// ─── Grouping and what it forbids ────────────────────────────────────────────

/**
 * Feature grouping is a view over a database column, not over the filesystem. A
 * feature group has no path and never will, so a drop, a paste, a new folder or
 * a rename inside one has no destination to name. The honest answer is to refuse
 * the gesture and say why, not to silently target the project root — which is
 * where `folderTargetOf` would land, and where the files would actually go.
 */
export const STRUCTURAL_OFF_IN_FEATURES =
  'Group by folder to move, rename or create files — a feature is a column, not a folder.';

/**
 * The same rule for suite grouping, said in its own words.
 *
 * A suite row IS a server row — it can be renamed and deleted, and files can be
 * dropped into it — so borrowing the sentence above would be wrong twice over:
 * it names the wrong thing, and it implies nothing here can be edited when a
 * great deal can. What is off is only the PATH gestures.
 */
export const STRUCTURAL_OFF_IN_SUITES =
  'Group by folder to move or create files — a suite holds tests, not paths.';

/**
 * Takes the grouping in an object so the prefs can be passed straight in, and
 * accepts the suite grouping that `prefs.ts` does not persist.
 */
export function structuralOpsAllowed(prefs: { grouping: SuiteGrouping }): boolean {
  return prefs.grouping === 'path';
}

/** Which refusal a path gesture earns in the grouping that is on. */
export function structuralRefusal(grouping: SuiteGrouping): string {
  return grouping === 'suite' ? STRUCTURAL_OFF_IN_SUITES : STRUCTURAL_OFF_IN_FEATURES;
}

/** Where the panel remembers that it was left grouped by suite. See `prefs.ts`. */
export const suiteGroupingKey = (projectId: string): string => `qaai.tree.suiteGrouping.${projectId}`;

// ─── Drag state ──────────────────────────────────────────────────────────────

export interface DragState {
  /** Row ids being dragged. Empty when no drag is in progress. */
  ids: string[];
  effect: DropEffect;
  /** The row the cursor is over, or null for the panel background (the root). */
  overRowId: string | null;
  over: boolean;
  ok: boolean;
  message: string | null;
}

export const NO_DRAG: DragState = {
  ids: [],
  effect: 'move',
  overRowId: null,
  over: false,
  ok: false,
  message: null,
};

// ─── The controller ──────────────────────────────────────────────────────────

export interface TreeController {
  prefs: TreePrefs;
  prefsApi: TreePrefsApi;
  /**
   * The grouping actually in force.
   *
   * NOT `prefs.grouping`: `prefs.ts` persists a whitelist of two and this panel
   * offers three. Suite grouping is remembered in a key of this hook's own
   * (`suiteGroupingKey`), the way the collapsed set and auto-reveal already are,
   * so nothing here writes a value the prefs sanitiser would silently drop on
   * the next load.
   */
  grouping: SuiteGrouping;
  setGrouping: (value: SuiteGrouping) => void;
  /** The project's suites, loaded while suite grouping is on. Empty otherwise. */
  suites: readonly TreeSuite[];
  model: TreeModel | SuiteTreeModel;
  /** The rows on screen, in order. Keyboard navigation and Shift-ranges use ONLY this. */
  rows: PanelRow[];
  /** Every row in the tree, collapsed folders included. Planning uses ONLY this. */
  allRows: PanelRow[];
  nested: RowNode[];
  decorations: Map<string, Decoration | null>;
  ranges: Map<string, MatchRange[]>;
  filterActive: boolean;
  matchCount: number;
  query: string;
  setQuery: (value: string) => void;
  selection: SelectionState;
  clipboard: ClipboardState | null;
  clipboardCutIds: ReadonlySet<string>;
  expandedIds: ReadonlySet<string>;
  pendingPaths: ReadonlySet<string>;
  scope: TreeCrumb[];
  scopeMissing: boolean;
  /** The tree's single tab stop — roving focus lands here. */
  focusableId: string | null;
  renamingId: string | null;
  renameError: string | null;
  drag: DragState;
  status: string | null;
  busy: boolean;
  autoReveal: boolean;
  /** Selected rows that are NOT on screen — collapsed away or filtered out. */
  hiddenSelected: number;
  /** False in feature and suite grouping, where rows have no path to act on. */
  structural: boolean;
  /**
   * May this row be dragged?
   *
   * Per row rather than one flag, because suite grouping splits the answer: a
   * FILE can be dragged (onto a suite, to be put in it — feature 31) while the
   * suite heading above it cannot be dragged anywhere at all.
   */
  canDrag: (row: PanelRow) => boolean;
  /** The suite a row IS, when it is one: what the panel may offer rename and delete on. */
  suiteOfRow: (row: PanelRow) => TreeSuite | null;
  /** Create a suite and open its name for editing. Suite grouping only. */
  newSuite: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Bumped when a row should be scrolled to (and focused, if the tree already has focus). */
  reveal: { id: string; tick: number } | null;

  setAutoReveal: (value: boolean) => void;
  setStatus: (value: string | null) => void;
  toggleDir: (row: PanelRow, alsoSiblings?: boolean) => void;
  expandAll: () => void;
  collapseAll: () => void;
  splitCompacted: (path: string) => void;
  setScope: (id: string | null) => void;
  clickRow: (row: PanelRow, mods: { shift?: boolean; meta?: boolean; ctrl?: boolean }) => void;
  /** Make one row the selection without opening or toggling it — what a right-click does. */
  selectRow: (rowId: string) => void;
  openRow: (row: PanelRow) => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  beginRename: (rowId: string) => void;
  cancelRename: () => void;
  commitRename: (rowId: string, name: string) => void;
  newFolder: (parentPath?: string) => void;
  addFile: (folderPath: string) => void;
  doCut: (ids?: string[]) => void;
  doCopy: (ids?: string[]) => void;
  doPaste: (targetRowId?: string | null) => void;
  doDelete: (ids?: string[]) => void;
  doDuplicate: (rowId: string) => void;
  doUndo: () => void;
  doRedo: () => void;
  copyPath: (row: PanelRow, relative: boolean) => void;
  runFolder: (row: PanelRow) => void;
  findInFolder: (row: PanelRow) => void;
  dragStart: (row: PanelRow, event: ReactDragEvent) => void;
  dragOver: (rowId: string | null, event: ReactDragEvent) => void;
  dragLeave: (rowId: string | null) => void;
  drop: (rowId: string | null, event: ReactDragEvent) => void;
  dragEnd: () => void;
}

export function useTreeController(options: TreeControllerOptions): TreeController {
  const {
    tests,
    projectId,
    openTestId,
    dirtyTestId,
    onOpen,
    onAdd,
    onChanged,
    onClosed,
    onFindInFolder,
    onRunTests,
  } = options;

  const [prefs, prefsApi] = useTreePrefs(projectId);
  /*
   * Suite grouping is held here rather than in `prefs`. `sanitizeTreePrefs`
   * accepts exactly `path` and `feature` and falls back to `path` for anything
   * else, so writing `suite` into the prefs would appear to work and then be
   * dropped on the next load — a setting that forgets itself once per session is
   * worse than one that is stored somewhere honest.
   */
  const [bySuite, setBySuite] = useState(false);
  const [suites, setSuites] = useState<readonly TreeSuite[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [uncompacted, setUncompacted] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [undoStack, setUndoStack] = useState<UndoStack>(EMPTY_UNDO);
  const [pending, setPending] = useState<readonly string[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState>(NO_DRAG);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoReveal, setAutoRevealState] = useState(true);
  const [reveal, setReveal] = useState<{ id: string; tick: number } | null>(null);

  const typeAhead = useRef<TypeAhead>(NO_TYPE_AHEAD);
  const revealTick = useRef(0);

  /*
   * Read in an effect, not in the initialiser. This page is server-rendered, and
   * seeding state from localStorage during render is the hydration mismatch that
   * makes React throw the tree away and re-mount it — which here means every
   * open folder snapping shut on load. Same reasoning as `useTreePrefs`.
   */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(collapsedKey(projectId));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      setCollapsed(
        new Set(
          Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [],
        ),
      );
    } catch {
      setCollapsed(new Set());
    }
    try {
      setAutoRevealState(localStorage.getItem(autoRevealKey(projectId)) !== 'off');
    } catch {
      setAutoRevealState(true);
    }
    try {
      setBySuite(localStorage.getItem(suiteGroupingKey(projectId)) === 'on');
    } catch {
      setBySuite(false);
    }
  }, [projectId]);

  const writeCollapsed = useCallback(
    (next: ReadonlySet<string>): ReadonlySet<string> => {
      try {
        localStorage.setItem(collapsedKey(projectId), JSON.stringify([...next]));
      } catch {
        /* private mode — the choice is just for this session */
      }
      return next;
    },
    [projectId],
  );

  const setAutoReveal = useCallback(
    (value: boolean) => {
      setAutoRevealState(value);
      try {
        localStorage.setItem(autoRevealKey(projectId), value ? 'on' : 'off');
      } catch {
        /* ignore */
      }
    },
    [projectId],
  );

  // ── Grouping, and the suites it needs ────────────────────────────────────

  const grouping: SuiteGrouping = bySuite ? 'suite' : prefs.grouping;

  const refreshSuites = useCallback(async () => {
    const { suites: loaded } = await api<{ suites: TreeSuite[] }>(`/projects/${projectId}/suites`);
    setSuites(loaded);
  }, [projectId]);

  /*
   * Fetched by the panel rather than passed in, because the one caller renders
   * `<FileTree>` with the props it already had and adding a required one would
   * make suite grouping a change to a screen this work does not own. Loaded only
   * while the grouping is on: a project the user never groups by suite pays
   * nothing for the feature.
   */
  useEffect(() => {
    if (grouping !== 'suite') return;
    let live = true;
    void (async () => {
      try {
        await refreshSuites();
      } catch (error) {
        if (live) setStatus(messageOf(error, 'Could not load this project’s suites'));
      }
    })();
    return () => {
      live = false;
    };
  }, [grouping, refreshSuites]);

  const suiteCtx: SuiteContext = useMemo(() => suiteContext(suites, tests), [suites, tests]);

  const setGrouping = useCallback(
    (next: SuiteGrouping) => {
      const wantsSuites = next === 'suite';
      setBySuite(wantsSuites);
      try {
        localStorage.setItem(suiteGroupingKey(projectId), wantsSuites ? 'on' : 'off');
      } catch {
        /* private mode — the choice is just for this session */
      }
      /*
       * A scope belongs to the grouping it was set in: `suite:<id>` means
       * nothing to the folder tree and a folder path means nothing to the suite
       * tree, and leaving one behind would greet the switch with "the folder you
       * had set as the root is gone".
       */
      const scopeIsSuite = prefs.scope !== null && suiteGroupOf(prefs.scope) !== null;
      if (wantsSuites) {
        if (prefs.scope !== null && !scopeIsSuite) prefsApi.set({ scope: null });
        return;
      }
      prefsApi.set({ grouping: next, ...(scopeIsSuite ? { scope: null } : {}) });
    },
    [prefs.scope, prefsApi, projectId],
  );

  // ── The model, and the two row lists ─────────────────────────────────────

  const model = useMemo(
    () =>
      grouping === 'suite'
        ? buildSuiteTree(tests, suites, { ...buildOptionsFromPrefs(prefs), uncompacted })
        : buildTree(tests, { ...buildOptionsFromPrefs(prefs), uncompacted }),
    [grouping, suites, tests, prefs, uncompacted],
  );

  const dirIds = useMemo(() => allDirIds(model.roots), [model]);
  const expandedIds = useMemo(() => expandedFrom(dirIds, collapsed), [dirIds, collapsed]);

  const realDirPaths = useMemo(() => {
    const out = new Set<string>();
    const walk = (nodes: readonly TreeNode[]): void => {
      for (const node of nodes) {
        if (node.kind !== 'dir') continue;
        // Every segment of a compacted chain is a real folder, even though the
        // three of them share one row.
        if (node.source === 'path') for (const segment of node.segments) out.add(segment.path);
        walk(node.children);
      }
    };
    walk(model.roots);
    return out;
  }, [model]);

  const livePending = useMemo(() => prunePending(pending, realDirPaths), [pending, realDirPaths]);
  const pendingPaths = useMemo(() => new Set(livePending), [livePending]);

  const matches = useMemo(() => matchTree(model.roots, query), [model, query]);

  /*
   * A pending folder is hidden while a filter is running. It has no contents to
   * match, so leaving it in would make it the one row in a filtered tree that is
   * there for no reason the query can explain.
   */
  const rows = useMemo(() => {
    const flat = panelRows(
      flattenTree(matches.roots, expandedIds, matches.active ? matches.expand : undefined),
    );
    return matches.active ? flat : injectPendingFolders(flat, livePending);
  }, [matches, expandedIds, livePending]);

  /*
   * Every row, every folder open, filter ignored. This is what plans a paste or
   * a drop: the destination's contents decide the name collisions, and half of
   * them may be inside a collapsed folder or filtered off the screen.
   *
   * The one thing it cannot see is a file removed by a `hide` pattern — those are
   * pruned from the model itself. A collision with one of those is caught by the
   * API's own uniqueness check and surfaced as its 409: a worse message than the
   * one this would have written, but not a wrong outcome.
   */
  const allRows = useMemo(
    () => injectPendingFolders(panelRows(flattenTree(model.roots, new Set(dirIds))), livePending),
    [model, dirIds, livePending],
  );

  /*
   * The paths `allRows` cannot see. Nothing is computed while no pattern is
   * hiding anything, which is the normal case and also the case where a scope
   * would otherwise put in-project files into this set for no reason.
   */
  const hiddenPaths = useMemo(
    () => (model.hiddenCount > 0 ? hiddenFilePaths(tests, allRows) : NO_HIDDEN_PATHS),
    [model.hiddenCount, tests, allRows],
  );

  const liveIds = useMemo(() => allRows.map((row) => row.id), [allRows]);
  useEffect(() => {
    setSelection((previous) => reconcileSelection(previous, liveIds));
  }, [liveIds]);

  const nested = useMemo(() => nestRows(rows), [rows]);

  const decorations = useMemo(
    () =>
      buildDecorations(model.roots, (test) => {
        const row = test as TreeTestRow;
        return {
          dirty: dirtyTestId === test.id,
          quarantined: row.quarantined === true,
          reviewFlags: test.reviewFlags,
          lastResult: row.lastStatus ?? null,
        };
      }),
    [model, dirtyTestId],
  );

  const structural = structuralOpsAllowed({ grouping });
  const offMessage = structuralRefusal(grouping);
  const clipboardCutIds = useMemo(() => cutIds(clipboard), [clipboard]);

  /** The suite behind a row, or null — the check every suite-only gesture starts with. */
  const suiteOfRow = useCallback(
    (row: PanelRow): TreeSuite | null => {
      if (grouping !== 'suite' || row.kind !== 'dir') return null;
      const group = suiteGroupOf(row.nodeId);
      // `unassigned` deliberately answers null: it is a heading with no server
      // row, so rename and delete must not be offered on it.
      if (!group || group.kind !== 'suite') return null;
      return suiteCtx.byId.get(group.suiteId) ?? null;
    },
    [grouping, suiteCtx],
  );

  const canDrag = useCallback(
    (row: PanelRow): boolean => structural || (grouping === 'suite' && row.kind === 'file'),
    [grouping, structural],
  );

  /*
   * One tab stop for the whole tree. The lead row carries it while it is on
   * screen; when the lead is inside a folder that has since been collapsed there
   * is no visible row to hold focus, and the first row takes it so Tab can still
   * get into the tree at all.
   */
  const focusableId = useMemo(() => {
    if (selection.lead && rows.some((row) => row.id === selection.lead)) return selection.lead;
    return rows[0]?.id ?? null;
  }, [rows, selection.lead]);

  // ── Expansion ─────────────────────────────────────────────────────────────

  const expandIds = useCallback(
    (ids: readonly string[]) => {
      setCollapsed((previous) => {
        if (!ids.some((id) => previous.has(id))) return previous;
        const next = new Set(previous);
        for (const id of ids) next.delete(id);
        return writeCollapsed(next);
      });
    },
    [writeCollapsed],
  );

  const toggleDir = useCallback(
    (row: PanelRow, alsoSiblings = false) => {
      const siblings = alsoSiblings ? siblingDirIds(rows, row) : [];
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(row.nodeId)) next.delete(row.nodeId);
        else next.add(row.nodeId);
        // Alt-click: fold the row's whole level. The fastest way back to an
        // overview once you have opened four things inside one folder.
        if (alsoSiblings) for (const id of siblings) next.add(id);
        return writeCollapsed(next);
      });
    },
    [rows, writeCollapsed],
  );

  const expandAll = useCallback(() => {
    setCollapsed(() => writeCollapsed(new Set<string>()));
  }, [writeCollapsed]);

  const collapseAll = useCallback(() => {
    setCollapsed(() => writeCollapsed(new Set(dirIds)));
  }, [dirIds, writeCollapsed]);

  /** Click a segment of a compacted label to break the chain open at that point. */
  const splitCompacted = useCallback((path: string) => {
    setUncompacted((previous) => {
      if (previous.has(path)) return previous;
      const next = new Set(previous);
      next.add(path);
      return next;
    });
  }, []);

  const setScope = useCallback(
    (id: string | null) => {
      prefsApi.set({ scope: id });
      setQuery('');
    },
    [prefsApi],
  );

  // ── Auto-reveal (feature 8) ───────────────────────────────────────────────

  /*
   * VS Code's autoReveal, with its one important restraint: it does not fight a
   * filter. While a query is running the row list is the answer to a question
   * the person just asked, and opening folders underneath it to chase the
   * editor's active tab moves the ground under them.
   *
   * `revealedFor` keeps it to once per file. Without it, every background reload
   * of the test list would re-reveal — and re-revealing takes focus back off
   * whatever the person had moved to since.
   */
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!autoReveal) {
      revealedFor.current = null;
      return;
    }
    if (matches.active || !openTestId) return;
    if (revealedFor.current === openTestId) return;
    const trail = ancestorDirIds(model.roots, openTestId);
    if (!trail) return;
    revealedFor.current = openTestId;
    expandIds(trail);
    revealTick.current += 1;
    setReveal({ id: `${FILE_ROW_PREFIX}${openTestId}`, tick: revealTick.current });
  }, [autoReveal, matches.active, openTestId, model, expandIds]);

  // ── Executing work ────────────────────────────────────────────────────────

  const send = useCallback(
    async (request: TreeRequest): Promise<Record<string, string>> => {
      const base = `/projects/${projectId}`;
      switch (request.kind) {
        case 'move-file':
          await api(`${base}/tests/${request.testId}/path`, {
            method: 'PATCH',
            body: JSON.stringify({ filePath: request.to }),
          });
          return {};
        case 'batch-move':
          await api(`${base}/tests/batch/move`, {
            method: 'POST',
            body: JSON.stringify({ moves: request.moves }),
          });
          return {};
        case 'move-folder':
          await api(`${base}/folders/move`, {
            method: 'POST',
            body: JSON.stringify({ from: request.from, to: request.to }),
          });
          return {};
        case 'copy-file': {
          /*
           * Two calls, because the API has no "copy to this path": `duplicate`
           * picks its own `-copy` name, while the paste has already decided what
           * the file should be called at its destination. The move is what makes
           * the copy land where it was dropped rather than beside its source.
           */
          const { test } = await api<{ test: { id: string } }>(
            `${base}/tests/${request.testId}/duplicate`,
            { method: 'POST' },
          );
          await api(`${base}/tests/${test.id}/path`, {
            method: 'PATCH',
            body: JSON.stringify({ filePath: request.to }),
          });
          return { [request.opId]: test.id };
        }
        case 'delete-file':
          await api(`${base}/tests/${request.testId}`, { method: 'DELETE' });
          return {};
        case 'batch-delete':
          await api(`${base}/tests/batch/delete`, {
            method: 'POST',
            body: JSON.stringify({ testIds: request.testIds }),
          });
          return {};
        case 'delete-folder':
          await api(`${base}/folders/delete`, {
            method: 'POST',
            body: JSON.stringify({ path: request.path }),
          });
          return {};
        case 'restore-file':
          await api(`${base}/tests/${request.testId}/restore`, { method: 'POST' });
          return {};
        case 'suite-assign':
          await api(`${base}/suites/${request.suiteId}/tests/${request.direction}`, {
            method: 'POST',
            body: JSON.stringify({ testIds: request.testIds }),
          });
          return {};
        case 'suite-rename':
          await api(`${base}/suites/${request.suiteId}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: request.name }),
          });
          return {};
        case 'suite-delete':
          await api(`${base}/suites/${request.suiteId}`, { method: 'DELETE' });
          return {};
      }
    },
    [projectId],
  );

  /**
   * Send a batch one request at a time and REPORT where it stopped rather than
   * throwing.
   *
   * Throwing loses the only thing the caller needs. The requests before the
   * failure have already been applied on the server, so the number that landed
   * decides what undo records, what the status line may claim, and — above all —
   * that the tree must be reloaded even though the gesture "failed".
   */
  const sendAll = useCallback(
    async (requests: readonly TreeRequest[]): Promise<BatchOutcome> => {
      const created: Record<string, string> = {};
      let done = 0;
      for (const request of requests) {
        try {
          Object.assign(created, await send(request));
        } catch (error) {
          return { created, done, error };
        }
        done += 1;
      }
      return { created, done, error: null };
    },
    [send],
  );

  /** Run a gesture's requests, record what landed for undo, and reload the tree. */
  const applyOps = useCallback(
    async (
      ops: readonly PanelOp[],
      refusals: readonly Refusal[],
      verb: string,
      closedTestIds: readonly string[] = [],
      /**
       * The headline for a gesture whose own planner writes it — an assignment
       * says "Put 3 files in Smoke", which `verb + count + "items"` cannot. It
       * also carries no "⌘Z" claim: `undo.ts` has four edit kinds and none of
       * them is an assignment, so an assignment genuinely cannot be taken back
       * from here and must not say it can.
       */
      headline?: (done: number) => string,
    ) => {
      /*
       * The hidden-file check is about PATHS, so only the path ops go through
       * it. An assignment's `to` is a suite id; asking whether a suite id
       * collides with a hidden file path would be a category error that happens
       * to answer "no" almost every time — which is the worst kind.
       */
      const moves = ops.filter((op): op is TreeOp => op.kind !== 'assign');
      const assigns = ops.filter((op): op is SuiteAssignOp => op.kind === 'assign');
      // A destination held by a file a `hide` pattern removed looks free to every
      // check the panel can make. Refuse it here, by name, instead of letting the
      // server answer with a uniqueness error about a file nobody can see.
      const planned = splitHiddenConflicts(moves, hiddenPaths);
      const plannedOps: PanelOp[] = [...planned.ops, ...assigns];
      const { requests, unsupported } = requestsForOps(plannedOps);
      const refused = [...refusals, ...unsupported, ...planned.refused];
      if (requests.length === 0) {
        setStatus(refusalSummary(refused) ?? 'Nothing to do');
        return;
      }
      setBusy(true);
      try {
        const outcome = await sendAll(requests);
        const landed = new Set(opIdsOf(requests.slice(0, outcome.done)));
        const applied = plannedOps.filter((op) => landed.has(op.id));
        // Only the path ops become an undo entry — see `headline` above.
        const undoable = applied.filter((op): op is TreeOp => op.kind !== 'assign');
        if (undoable.length > 0) {
          setUndoStack((previous) => record(previous, entryForOps(undoable, outcome.created, verb)));
        }
        if (closedTestIds.length > 0 && outcome.done > 0) onClosed?.([...closedTestIds]);
        /*
         * Reload on the way out whether the batch succeeded or not. A partial
         * failure is the case that needs it MOST: work really did happen on the
         * server, and leaving the panel showing the tree from before it means the
         * next click re-sends moves that already went through.
         */
        await onChanged?.();
        const tail = refusalSummary(refused);
        const landedLine = headline
          ? `${headline(applied.length)}${tail ? ` — ${tail}` : '.'}`
          : outcomeMessage(verb, applied.length, refused);
        setStatus(
          outcome.error === null
            ? landedLine
            : partialMessage(
                applied.length,
                plannedOps.length,
                messageOf(outcome.error, `${verb} failed`),
                // ⌘Z can only take back the path ops, so it is offered only when
                // there are some. An assignment that half-landed says how far it
                // got and stops there.
                undoable.length > 0,
              ),
        );
      } catch (error) {
        // `sendAll` no longer throws, so anything here came from the reload the
        // parent owns. Reporting it beats an unhandled rejection nobody sees.
        setStatus(messageOf(error, `${verb} failed`));
      } finally {
        setBusy(false);
      }
    },
    [hiddenPaths, onChanged, onClosed, sendAll],
  );

  /** The same, for gestures whose undo entry is built by hand rather than from ops. */
  const applyEdits = useCallback(
    async (
      requests: readonly TreeRequest[],
      entry: UndoEntry | null,
      note: string,
      failure: string,
      closedTestIds: readonly string[] = [],
      /**
       * A second reload this gesture needs, awaited beside the parent's.
       *
       * The suites list is a separate read from the tests list, so renaming or
       * deleting a suite leaves this panel holding a name the server no longer
       * has. Refreshing it from the call site instead would race the request it
       * is refreshing after.
       */
      refresh?: () => Promise<void>,
    ) => {
      if (requests.length === 0) return;
      setBusy(true);
      try {
        const outcome = await sendAll(requests);
        /*
         * The entry is recorded only when EVERY request landed. Unlike `applyOps`
         * there is no map from requests back to edits here — one `delete-folder`
         * stands for a whole subtree's worth of them — so a hand-built entry after
         * a partial failure would tell ⌘Z to restore files that were never
         * deleted. The message says as much instead of pretending otherwise.
         */
        if (outcome.error === null && entry) setUndoStack((previous) => record(previous, entry));
        // Tabs for files that ARE gone must close even on a partial failure; a tab
        // closed for a file that survived is reopened with one click, a tab left
        // open on a deleted file breaks the next save.
        if (closedTestIds.length > 0 && outcome.done > 0) onClosed?.([...closedTestIds]);
        if (refresh) {
          try {
            await refresh();
          } catch {
            // The write landed; only the second read did not. Reporting this as
            // a failed rename would send somebody to undo something that worked.
          }
        }
        await onChanged?.();
        setStatus(
          outcome.error === null
            ? note
            : partialMessage(
                outcome.done,
                requests.length,
                messageOf(outcome.error, failure),
                false,
              ),
        );
      } catch (error) {
        setStatus(messageOf(error, failure));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onClosed, sendAll],
  );

  // ── Selection and opening ─────────────────────────────────────────────────

  const openRow = useCallback(
    (row: PanelRow) => {
      if (row.kind === 'file') onOpen(row.nodeId);
    },
    [onOpen],
  );

  /*
   * Selection without the side effect. A right-click has to make its row the
   * subject of the menu, and routing that through `clickRow` would ALSO open the
   * file or toggle the folder — a context menu that changes the thing it is
   * about before you have read it.
   */
  const selectRow = useCallback((rowId: string) => {
    setSelection((previous) => selectOnly(previous, rowId));
  }, []);

  const clickRow = useCallback(
    (row: PanelRow, mods: { shift?: boolean; meta?: boolean; ctrl?: boolean }) => {
      setSelection((previous) => applyClick(rows, previous, row.id, mods));
      const plain = mods.shift !== true && mods.meta !== true && mods.ctrl !== true;
      if (!plain) return;
      if (row.kind === 'dir') toggleDir(row);
      else openRow(row);
    },
    [rows, toggleDir, openRow],
  );

  // ── Rename (feature 3) ────────────────────────────────────────────────────

  const beginRename = useCallback(
    (rowId: string) => {
      const row = rowById(allRows, rowId);
      if (!row) return;
      /*
       * A suite row is the one heading in this tree that CAN be renamed: there
       * is a `Suite` with that id behind it. The unassigned group is not one —
       * `suiteOfRow` answers null for it — and neither is a feature group, so
       * both still fall through to the refusal.
       */
      if (!structural && !pendingPaths.has(row.path) && !suiteOfRow(row)) {
        setStatus(offMessage);
        return;
      }
      setRenameError(null);
      setRenamingId(rowId);
      setSelection((previous) => selectOnly(previous, rowId));
    },
    [allRows, offMessage, structural, pendingPaths, suiteOfRow],
  );

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameError(null);
  }, []);

  const commitRename = useCallback(
    (rowId: string, raw: string) => {
      const row = rowById(allRows, rowId);
      if (!row) {
        cancelRename();
        return;
      }
      const name = raw.trim();
      if (name === editableName(row)) {
        cancelRename();
        return;
      }

      /*
       * Renaming a SUITE is a different write with different rules — no path, no
       * sibling files, no extension to preserve — so it is answered before any
       * of the path arithmetic below runs. Validated locally first because the
       * input is still open: a 409 from the server would have closed the editor
       * and thrown the typing away.
       */
      const suite = suiteOfRow(row);
      if (suite) {
        const suiteCheck = validateSuiteName(name, suiteNamesExcept(suites, suite.id));
        if (!suiteCheck.ok) {
          setRenameError(suiteCheck.message);
          return;
        }
        cancelRename();
        void applyEdits(
          [{ kind: 'suite-rename', suiteId: suite.id, name }],
          // No undo entry: `undo.ts` has four edit kinds and a suite rename is
          // none of them, so claiming ⌘Z here would be a claim the stack cannot
          // honour.
          null,
          `Renamed the suite to ${name}`,
          'Renaming the suite failed',
          [],
          refreshSuites,
        );
        return;
      }

      const check = validateName(name, row.kind, siblingNames(allRows, row.parentPath, row.id));
      if (!check.ok) {
        setRenameError(check.message);
        return;
      }
      const to = joinPath(row.parentPath, name);
      /*
       * `siblingNames` can only see rows, and a `hide` pattern took some files out
       * of the row list entirely. Saying so here keeps the input open on the name
       * that has to change; the alternative is closing the editor, discarding the
       * typing, and showing the server's uniqueness error about a file that is
       * nowhere on screen.
       */
      if (hiddenNameTaken(to, row.kind, hiddenPaths)) {
        setRenameError(hiddenTakenMessage(name));
        return;
      }
      cancelRename();

      // A pending folder exists only here, so renaming it is a state change and
      // nothing more. Reporting it as saved would be the exact lie this whole
      // feature is written to avoid.
      if (pendingPaths.has(row.path)) {
        setPending((previous) => renamePending(previous, row.path, to));
        setStatus(`${name}/ is not saved yet — put a file in it to keep it.`);
        return;
      }

      const request: TreeRequest =
        row.kind === 'dir'
          ? { kind: 'move-folder', opId: row.id, from: row.path, to }
          : { kind: 'move-file', opId: row.id, testId: row.nodeId, to };
      const entry: UndoEntry = {
        label: 'Rename',
        edits: [{ kind: 'move', id: row.id, from: row.path, to }],
      };
      void applyEdits([request], entry, `Renamed to ${name}. Undo with ⌘Z.`, 'Rename failed');
    },
    [allRows, applyEdits, cancelRename, hiddenPaths, pendingPaths, refreshSuites, suiteOfRow, suites],
  );

  // ── New folder (feature 2) ────────────────────────────────────────────────

  const newFolder = useCallback(
    (parentPath?: string) => {
      if (!structural) {
        setStatus(offMessage);
        return;
      }
      const resolved = parentPath ?? folderTargetOf(allRows, selection.lead);
      if (resolved === null) {
        setStatus(offMessage);
        return;
      }
      const parent = resolved;
      const name = freeFolderName('new-folder', siblingNames(allRows, parent, null));
      const path = joinPath(parent, name);
      setPending((previous) => [...previous, path]);
      if (parent !== '') {
        const parentRow = allRows.find((row) => row.kind === 'dir' && row.path === parent);
        if (parentRow) expandIds([parentRow.nodeId]);
      }
      const rowId = `${DIR_ROW_PREFIX}${path}`;
      setSelection((previous) => selectOnly(previous, rowId));
      setRenamingId(rowId);
      setRenameError(null);
      setStatus('Folders live inside file paths — this one is saved when a file lands in it.');
    },
    [allRows, expandIds, offMessage, selection.lead, structural],
  );

  const addFile = useCallback((folderPath: string) => onAdd(folderPath), [onAdd]);

  // ── Cut / copy / paste (features 4, 5) ────────────────────────────────────

  const idsOrSelection = useCallback(
    (ids?: readonly string[]): string[] => {
      if (ids && ids.length > 0) return [...ids];
      /*
       * EVERY selected id, not only the ones on screen. Collapsing a folder
       * keeps the files inside it selected on purpose, so a delete planned from
       * the visible rows alone would act on fewer files than the toolbar's count
       * promised — silently, and destructively.
       */
      const chosen = allSelectedIds(allRows, selection);
      if (chosen.length > 0) return chosen;
      return selection.lead ? [selection.lead] : [];
    },
    [allRows, selection],
  );

  const doCut = useCallback(
    (ids?: string[]) => {
      if (!structural) {
        setStatus(offMessage);
        return;
      }
      /*
       * An unsaved folder is a row and nothing else — no directory on the server,
       * so no move to plan and nothing for a later paste to carry. Rename and
       * delete already say so out loud; saying nothing here would put a folder on
       * the clipboard that ⌘V could only fail on.
       */
      const split = splitPending(allRows, idsOrSelection(ids), pendingPaths);
      if (split.ids.length === 0) {
        if (split.pending.length > 0) setStatus(pendingRefusal(split.pending, 'move'));
        return;
      }
      const next = clipCut(allRows, split.ids);
      if (!next) return;
      setClipboard(next);
      const head = `Cut ${next.entries.length} — ⌘V in the destination folder.`;
      setStatus(
        split.pending.length > 0 ? `${head} ${pendingRefusal(split.pending, 'move')}` : head,
      );
    },
    [allRows, idsOrSelection, offMessage, pendingPaths, structural],
  );

  const doCopy = useCallback(
    (ids?: string[]) => {
      if (!structural) {
        setStatus(offMessage);
        return;
      }
      // Same reason as `doCut`: there is nothing on the server to copy.
      const split = splitPending(allRows, idsOrSelection(ids), pendingPaths);
      if (split.ids.length === 0) {
        if (split.pending.length > 0) setStatus(pendingRefusal(split.pending, 'copy'));
        return;
      }
      const next = clipCopy(allRows, split.ids);
      if (!next) return;
      setClipboard(next);
      const head = `Copied ${next.entries.length} — ⌘V in the destination folder.`;
      setStatus(
        split.pending.length > 0 ? `${head} ${pendingRefusal(split.pending, 'copy')}` : head,
      );
    },
    [allRows, idsOrSelection, offMessage, pendingPaths, structural],
  );

  const doPaste = useCallback(
    (targetRowId?: string | null) => {
      if (!clipboard) return;
      const target = folderTargetOf(
        allRows,
        targetRowId === undefined ? selection.lead : targetRowId,
      );
      // `null` is a feature group, which is a heading and not a folder. Pasting
      // into `''` instead would move the files to the project root and look like
      // it had worked.
      if (target === null) {
        setStatus(offMessage);
        return;
      }
      const result = clipPaste(allRows, clipboard, target);
      setClipboard(result.clipboard);
      void applyOps(result.ops, result.refusals, clipboard.mode === 'cut' ? 'Moved' : 'Copied');
    },
    [allRows, applyOps, clipboard, offMessage, selection.lead],
  );

  // ── Delete ────────────────────────────────────────────────────────────────

  /*
   * No confirmation dialog, on purpose. The API's delete is SOFT — it stamps
   * `disabledAt`, and `restore` clears it — so the destructive-looking gesture is
   * reversible by the ⌘Z that is already bound, and the status line says so. A
   * modal in front of a reversible action teaches people to dismiss modals.
   */
  const doDelete = useCallback(
    (ids?: string[]) => {
      const targets = pruneContained(
        idsOrSelection(ids)
          .map((id) => rowById(allRows, id))
          .filter((row): row is PanelRow => row !== null),
      );
      if (targets.length === 0) return;

      /*
       * Deleting a SUITE is its own gesture and does not mix with deleting
       * files. Mixed into one batch it would be an undo entry that claims to
       * restore everything and can only restore the files — so a selection that
       * names a suite is read as being about suites, and the files in it are
       * deliberately left alone. Deleting the suite does not delete them anyway:
       * the API unassigns them and says how many.
       */
      const groupTargets = targets.filter((row) => row.kind === 'dir');
      if (grouping === 'suite' && groupTargets.length > 0) {
        const requests: TreeRequest[] = [];
        const names: string[] = [];
        for (const row of groupTargets) {
          const suite = suiteOfRow(row);
          // The unassigned group has no server row. Skipped, not refused as an
          // error: it is a heading, and there was nothing there to delete.
          if (!suite) continue;
          requests.push({ kind: 'suite-delete', suiteId: suite.id });
          names.push(suite.name);
        }
        if (requests.length === 0) {
          setStatus(`${NO_SUITE_LABEL} is a heading, not a suite — there is nothing to delete`);
          return;
        }
        const what = names.length === 1 ? names[0] : `${names.length} suites`;
        void applyEdits(
          requests,
          // Not undoable: there is no endpoint that puts a suite back, and the
          // assignments it held are gone with it.
          null,
          `Deleted ${what}. The tests are still here, in no suite.`,
          'Deleting the suite failed',
          [],
          refreshSuites,
        );
        return;
      }

      const pendingTargets = targets.filter((row) => pendingPaths.has(row.path));
      if (pendingTargets.length > 0) {
        setPending((previous) =>
          previous.filter(
            (path) => !pendingTargets.some((row) => path === row.path || isWithin(path, row.path)),
          ),
        );
      }
      const real = targets.filter((row) => !pendingPaths.has(row.path));
      if (real.length === 0) {
        setStatus('Removed the unsaved folder.');
        return;
      }
      if (!structural && real.some((row) => row.kind === 'dir')) {
        setStatus(offMessage);
        return;
      }

      const requests: TreeRequest[] = [];
      const edits: TreeEdit[] = [];
      const closed: string[] = [];
      const looseFiles: PanelRow[] = [];

      for (const row of real) {
        if (row.kind !== 'dir') {
          looseFiles.push(row);
          continue;
        }
        requests.push({ kind: 'delete-folder', path: row.path });
        // Recorded per FILE, never as one folder edit: the inverse of a folder
        // delete has to be something the API can actually do, and `restore` takes
        // a test id. It also means undo puts the files back even if the folder
        // has been used for something else since.
        for (const file of descendantFiles(row.node)) {
          edits.push({
            kind: 'delete',
            id: `${FILE_ROW_PREFIX}${file.id}`,
            path: file.path,
            name: file.name,
          });
          closed.push(file.id);
        }
      }

      for (const row of looseFiles) {
        edits.push({ kind: 'delete', id: row.id, path: row.path, name: baseName(row.path) });
        closed.push(row.nodeId);
      }
      for (let at = 0; at < looseFiles.length; at += BATCH_LIMIT) {
        const chunk = looseFiles.slice(at, at + BATCH_LIMIT);
        const only = chunk.length === 1 ? chunk[0] : null;
        if (only) requests.push({ kind: 'delete-file', testId: only.nodeId });
        else requests.push({ kind: 'batch-delete', testIds: chunk.map((row) => row.nodeId) });
      }

      const count = closed.length;
      void applyEdits(
        requests,
        { label: 'Delete', edits },
        `Deleted ${count} ${count === 1 ? 'file' : 'files'}. Undo with ⌘Z.`,
        'Delete failed',
        closed,
      );
    },
    [
      allRows,
      applyEdits,
      grouping,
      idsOrSelection,
      offMessage,
      pendingPaths,
      refreshSuites,
      structural,
      suiteOfRow,
    ],
  );

  const doDuplicate = useCallback(
    (rowId: string) => {
      const row = rowById(allRows, rowId);
      if (!row || row.kind !== 'file') return;
      setBusy(true);
      void (async () => {
        try {
          const { test } = await api<{ test: { id: string; filePath: string } }>(
            `/projects/${projectId}/tests/${row.nodeId}/duplicate`,
            { method: 'POST' },
          );
          setUndoStack((previous) =>
            record(previous, {
              label: 'Duplicate',
              edits: [
                {
                  kind: 'create',
                  id: `${FILE_ROW_PREFIX}${test.id}`,
                  path: test.filePath,
                  name: baseName(test.filePath),
                  copiedFrom: row.path,
                },
              ],
            }),
          );
          await onChanged?.();
          setStatus(`Duplicated to ${test.filePath}. Undo with ⌘Z.`);
        } catch (error) {
          setStatus(messageOf(error, 'Duplicate failed'));
        } finally {
          setBusy(false);
        }
      })();
    },
    [allRows, onChanged, projectId],
  );

  // ── New suite ─────────────────────────────────────────────────────────────

  /*
   * Unlike a folder, a suite is a real row and can be created empty — which is
   * the whole reason this button exists. Without it the only way to get a suite
   * would be to have one already, and every feature hanging off suites
   * (schedules, monitors, running a named subset) stays unreachable.
   *
   * Created with a free name and immediately opened for renaming, the way "New
   * Folder" does: the name matters, and typing it is the next thing anyone
   * wants to do.
   */
  const newSuite = useCallback(() => {
    if (grouping !== 'suite') {
      setStatus('Group by suite first — the panel is showing folders');
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const name = freeSuiteName('New suite', suiteNamesExcept(suites, null));
        const { suite } = await api<{ suite: TreeSuite }>(`/projects/${projectId}/suites`, {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        await refreshSuites();
        const rowId = `${DIR_ROW_PREFIX}${suiteGroupId(suite.id)}`;
        setSelection((previous) => selectOnly(previous, rowId));
        setRenamingId(rowId);
        setRenameError(null);
        setStatus(`Created ${suite.name} — drag files onto it to put them in it.`);
      } catch (error) {
        setStatus(messageOf(error, 'Creating the suite failed'));
      } finally {
        setBusy(false);
      }
    })();
  }, [grouping, projectId, refreshSuites, suites]);

  // ── Undo / redo (feature 12) ──────────────────────────────────────────────

  /*
   * Peek, execute, and only then move the stack. A refused inverse — the old path
   * is occupied, someone else moved the file — leaves the entry exactly where it
   * was, so the gesture can be retried once the way is clear. Popping first would
   * lose the entry on the one occasion it mattered.
   */
  const stepStack = useCallback(
    (direction: 'undo' | 'redo') => {
      const entry = direction === 'undo' ? peekUndo(undoStack) : peekRedo(undoStack);
      if (!entry) return;
      const edits = direction === 'undo' ? undoEdits(undoStack) : redoEdits(undoStack);
      const requests = requestsForEdits(edits);
      if (!requests) {
        setStatus(`${describeEntry(entry)} cannot be ${direction === 'undo' ? 'undone' : 'redone'}`);
        return;
      }
      const failure = `${direction === 'undo' ? 'Undo' : 'Redo'} failed`;
      setBusy(true);
      void (async () => {
        try {
          const outcome = await sendAll(requests);
          // The entry only moves when the whole inverse replayed. A half-replayed
          // undo is still an undo that can be finished, and popping the entry
          // would throw away the one record of what is left to do.
          if (outcome.error === null) {
            setUndoStack((previous) =>
              direction === 'undo' ? commitUndo(previous) : commitRedo(previous),
            );
          }
          // Some of the inverse landed even when the rest did not, so the panel
          // is out of date either way.
          await onChanged?.();
          setStatus(
            outcome.error === null
              ? `${direction === 'undo' ? 'Undid' : 'Redid'} ${describeEntry(entry).toLowerCase()}`
              : partialMessage(
                  outcome.done,
                  requests.length,
                  messageOf(outcome.error, failure),
                  false,
                ),
          );
        } catch (error) {
          setStatus(messageOf(error, failure));
        } finally {
          setBusy(false);
        }
      })();
    },
    [onChanged, sendAll, undoStack],
  );

  const doUndo = useCallback(() => stepStack('undo'), [stepStack]);
  const doRedo = useCallback(() => stepStack('redo'), [stepStack]);

  // ── Paths, folders, runs (features 20, 29, 30) ────────────────────────────

  const copyPath = useCallback(
    (row: PanelRow, relative: boolean) => {
      const text = relative ? relativeToScope(row.path, prefs.scope) : row.path;
      void (async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus(`Copied ${text}`);
        } catch {
          // Clipboard access is permission-gated and refused outright in some
          // embedded contexts. Printing the path is the fallback that still lets
          // somebody select it by hand.
          setStatus(text);
        }
      })();
    },
    [prefs.scope],
  );

  const runFolder = useCallback(
    (row: PanelRow) => {
      const ids = descendantTestIds(row.node);
      if (ids.length === 0) {
        setStatus('Nothing to run in there yet');
        return;
      }
      if (!onRunTests) {
        setStatus('Running from the tree is not wired up on this screen');
        return;
      }
      // A suite is not a folder, so it does not get a folder's trailing slash —
      // this label ends up on the run itself, where "Smoke/" would read as a
      // directory nobody has.
      const label = row.kind === 'dir' && !suiteOfRow(row) ? `${row.name}/` : row.name;
      onRunTests(ids, label);
    },
    [onRunTests, suiteOfRow],
  );

  const findInFolder = useCallback(
    (row: PanelRow) => {
      if (!onFindInFolder) {
        setStatus('Search is not wired up on this screen');
        return;
      }
      onFindInFolder(row.kind === 'dir' ? row.path : row.parentPath);
    },
    [onFindInFolder],
  );

  // ── Drag and drop (feature 1) ─────────────────────────────────────────────

  const dragStart = useCallback(
    (row: PanelRow, event: ReactDragEvent) => {
      /*
       * Suite grouping is the one place a drag is allowed while path gestures
       * are not: dragging a FILE onto a suite puts it in that suite, which
       * changes no path at all (feature 31). A suite HEADING still cannot be
       * dragged — there is nowhere for it to go — and is refused here rather
       * than left to produce a drag that can only end in a refusal.
       */
      if (!canDrag(row)) {
        event.preventDefault();
        setStatus(grouping === 'suite' ? 'A suite is not something to drag' : offMessage);
        return;
      }
      // An unsaved folder has no directory behind it, so there is nothing for a
      // drop to move. Refusing at `dragStart` is the earliest honest moment.
      const split = splitPending(allRows, dragIdsFor(selection, row.id), pendingPaths);
      if (split.ids.length === 0) {
        event.preventDefault();
        setStatus(pendingRefusal(split.pending, 'move'));
        return;
      }
      const ids = split.ids;
      // Grabbing a row outside the selection makes it the selection, so what is
      // highlighted and what is moving are never two different sets.
      if (!selection.ids.has(row.id)) setSelection((previous) => selectOnly(previous, row.id));
      event.dataTransfer.effectAllowed = 'copyMove';
      const payload = treeDragPayload(allRows, ids, projectId);
      // The typed payload is the signal; see TREE_DRAG_MIME for why `text/plain`
      // cannot be. The plain text is written anyway so a drag into an editor or a
      // terminal pastes paths rather than "[object Object]".
      event.dataTransfer.setData(TREE_DRAG_MIME, JSON.stringify(payload));
      event.dataTransfer.setData('text/plain', payload.rows.map((entry) => entry.path).join('\n'));
      setDrag({ ...NO_DRAG, ids, effect: 'move' });
    },
    [allRows, canDrag, grouping, offMessage, pendingPaths, projectId, selection],
  );

  const dragOver = useCallback(
    (rowId: string | null, event: ReactDragEvent) => {
      if (drag.ids.length === 0) return;
      const effect = effectFromModifiers({ alt: event.altKey, ctrl: event.ctrlKey });
      /*
       * In suite grouping the path planner is never consulted, and that is a
       * correctness point rather than an optimisation: a file row here still
       * carries its real `filePath`, so `canDropOn` would happily resolve a drop
       * onto a file to the FOLDER that file lives in and light the row up for a
       * move nobody asked for.
       */
      const check =
        grouping === 'suite'
          ? canDropOnSuite(suiteCtx, allRows, drag.ids, rowId)
          : canDropOn(allRows, drag.ids, rowId, effect);
      /*
       * preventDefault only when the drop would land. Leaving it alone on a
       * refusal is what makes the browser draw its "no drop" cursor, and the
       * reason lands in the panel's status line at the same moment — the refusal
       * is visible twice over, never silent.
       */
      if (check.ok) {
        event.preventDefault();
        // An assignment is never a copy: a test is in one suite, and ⌥ has
        // nothing different to mean here. Showing the copy cursor would promise
        // a second file that is not coming.
        event.dataTransfer.dropEffect = grouping === 'suite' ? 'move' : effect;
      }
      setDrag((previous) =>
        previous.over &&
        previous.overRowId === rowId &&
        previous.ok === check.ok &&
        previous.effect === effect &&
        previous.message === check.message
          ? previous
          : {
              ...previous,
              overRowId: rowId,
              over: true,
              ok: check.ok,
              effect,
              message: check.message,
            },
      );
    },
    [allRows, drag.ids, grouping, suiteCtx],
  );

  const dragLeave = useCallback((rowId: string | null) => {
    setDrag((previous) =>
      previous.overRowId === rowId
        ? { ...previous, over: false, overRowId: null, message: null }
        : previous,
    );
  }, []);

  const dragEnd = useCallback(() => setDrag(NO_DRAG), []);

  const drop = useCallback(
    (rowId: string | null, event: ReactDragEvent) => {
      event.preventDefault();
      const ids = drag.ids;
      const effect = effectFromModifiers({ alt: event.altKey, ctrl: event.ctrlKey });
      setDrag(NO_DRAG);
      if (ids.length === 0) return;
      if (grouping === 'suite') {
        const target = suiteDropTargetOf(suiteCtx, allRows, rowId);
        if (!target) {
          // The panel background, or a heading whose suite this client no longer
          // has. There is no root to fall back on when the tree is grouped by a
          // column, so the honest answer is that nothing happened and why.
          setStatus('Drop files onto a suite to put them in it');
          return;
        }
        const plan = planSuiteDrop(suiteCtx, allRows, ids, target);
        void applyOps(plan.ops, plan.refusals, 'Assigned', [], (done) =>
          assignmentSummary(done, target),
        );
        return;
      }
      const plan = planDropOn(allRows, ids, rowId, effect);
      void applyOps(plan.ops, plan.refusals, effect === 'copy' ? 'Copied' : 'Moved');
    },
    [allRows, applyOps, drag.ids, grouping, suiteCtx],
  );

  // ── The keyboard (features 6, 11) ─────────────────────────────────────────

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // The inline rename input lives inside the tree, so its keystrokes bubble
      // to here. Type-to-select must never eat what someone is typing into a
      // field. (The filter box is outside the tree entirely, which is the other
      // half of the same rule.)
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === 'x') {
          event.preventDefault();
          doCut();
          return;
        }
        if (key === 'c') {
          event.preventDefault();
          doCopy();
          return;
        }
        if (key === 'v') {
          event.preventDefault();
          doPaste();
          return;
        }
        if (key === 'd') {
          event.preventDefault();
          if (selection.lead) doDuplicate(selection.lead);
          return;
        }
        if (key === 'z') {
          event.preventDefault();
          if (event.shiftKey) doRedo();
          else doUndo();
          return;
        }
      }

      const result = handleKey(rows, selection, event, { typeAhead: typeAhead.current });
      typeAhead.current = result.typeAhead;
      if (!result.handled) return;
      event.preventDefault();
      if (result.selection !== selection) setSelection(result.selection);
      if (result.reveal) {
        revealTick.current += 1;
        setReveal({ id: result.reveal, tick: revealTick.current });
      }

      const action = result.action;
      if (!action) return;
      switch (action.kind) {
        case 'open': {
          const row = rowById(rows, action.id);
          if (row) openRow(row);
          break;
        }
        case 'expand':
        case 'collapse': {
          const row = rowById(rows, action.id);
          if (row) toggleDir(row);
          break;
        }
        case 'rename':
          beginRename(action.id);
          break;
        case 'delete':
          doDelete(action.ids);
          break;
      }
    },
    [
      beginRename,
      doCopy,
      doCut,
      doDelete,
      doDuplicate,
      doPaste,
      doRedo,
      doUndo,
      openRow,
      rows,
      selection,
      toggleDir,
    ],
  );

  const undoTop = peekUndo(undoStack);
  const redoTop = peekRedo(undoStack);

  return {
    prefs,
    prefsApi,
    grouping,
    setGrouping,
    suites,
    model,
    rows,
    allRows,
    nested,
    decorations,
    ranges: matches.ranges,
    filterActive: matches.active,
    matchCount: matches.matchCount,
    query,
    setQuery,
    selection,
    clipboard,
    clipboardCutIds,
    expandedIds,
    pendingPaths,
    scope: model.scope,
    scopeMissing: model.scopeMissing,
    hiddenSelected: hiddenSelectionCount(rows, selection),
    focusableId,
    renamingId,
    renameError,
    drag,
    status,
    busy,
    autoReveal,
    structural,
    canDrag,
    suiteOfRow,
    newSuite,
    canUndo: canUndo(undoStack),
    canRedo: canRedo(undoStack),
    undoLabel: undoTop ? describeEntry(undoTop) : null,
    redoLabel: redoTop ? describeEntry(redoTop) : null,
    reveal,
    setAutoReveal,
    setStatus,
    toggleDir,
    expandAll,
    collapseAll,
    splitCompacted,
    setScope,
    clickRow,
    selectRow,
    openRow,
    onKeyDown,
    beginRename,
    cancelRename,
    commitRename,
    newFolder,
    addFile,
    doCut,
    doCopy,
    doPaste,
    doDelete,
    doDuplicate,
    doUndo,
    doRedo,
    copyPath,
    runFolder,
    findInFolder,
    dragStart,
    dragOver,
    dragLeave,
    drop,
    dragEnd,
  };
}
