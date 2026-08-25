/**
 * What is selected, what has focus, and what the next keystroke does to both.
 *
 * Everything here operates on the FLATTENED VISIBLE ROW LIST — the rows the
 * explorer is actually painting after collapse and filtering — because that is
 * what the user is looking at when they press ↓. A model that navigated the
 * nested tree would step into a collapsed folder's children, which are not on
 * screen, and the cursor would appear to vanish.
 *
 * Two rules the rest of the file exists to keep:
 *
 * 1. ANCHOR AND LEAD ARE DIFFERENT THINGS. The anchor is where a Shift-range
 *    starts; the lead is the row with focus. Shift-clicking twice must re-extend
 *    from the ORIGINAL anchor, so the second click can SHRINK the range. Collapse
 *    them into one "last clicked" field and the range only ever grows — the
 *    single most common bug in a hand-rolled multi-select.
 *
 * 2. SELECTION IS HELD BY IDENTITY, NEVER BY INDEX. A background refresh
 *    rebuilds the row list; if row 3 were selected, row 3 of the new list is a
 *    different file, and the user's next Delete would hit it. Every function
 *    here takes and returns ids.
 *
 * No React, no DOM. `handleKey` returns a `KeyResult`: `handled`, the next
 * `selection`, the next `typeAhead`, a `reveal` id to scroll into view and an
 * `action` for the caller to perform. Scrolling and focus belong to the
 * component, which is the only thing that owns a node.
 *
 * ── WHICH ROW LIST ──────────────────────────────────────────────────────────
 *
 * Every function in this file takes the VISIBLE rows. That is the contract, and
 * it is the right one for navigation: ↓ moves to the next row on screen.
 *
 * It is the WRONG list for planning work. A selection can outlive the rows that
 * showed it — `reconcileSelection` deliberately keeps ids inside a collapsed
 * folder, so that collapsing a folder does not silently deselect what is in it
 * — and `selectedRows`/`selectedIds` can only see what is on screen. Anything
 * that turns a selection into operations (cut, copy, drop, delete) must use
 * `allSelectedIds`, and `hiddenSelectionCount` exists so the UI can say out
 * loud how many of the selected rows are not currently visible. See
 * `clipboard.ts`, which refuses rather than drops when handed a short list.
 */

/**
 * One row of the flattened list.
 *
 * Deliberately the smallest shape that supports navigation, so a richer row from
 * the renderer is structurally assignable and every function here stays generic
 * over `R extends TreeRow` and hands the caller back its OWN row type.
 *
 * `parentPath` is carried rather than parsed off `path` so this module does no
 * string surgery at all: the flattener already knows the parent, and re-deriving
 * it here would be a second, divergent implementation of the same rule.
 */
export interface TreeRow {
  /**
   * Stable across rebuilds. For a file this is the test id; for a folder, some
   * path-derived key. Two rows must never share one.
   */
  id: string;
  kind: 'file' | 'dir';
  /** Last path segment — `order-total.spec.ts`, or `checkout` for a folder. */
  name: string;
  /** Full path, no leading or trailing slash. Root-level rows have no slash. */
  path: string;
  /** Containing folder's path; `''` for a row at the root. */
  parentPath: string;
  depth: number;
  /** Folders only: is this folder open right now? Undefined on files. */
  expanded?: boolean;
}

/**
 * A row that names no place on disk.
 *
 * `grouping: 'feature'` is a live mode, and a feature group is a HEADING, not a
 * folder: it has no path, nothing under it shares a parent, and `rows.ts` gives
 * it `path: ''`. The root is also `''`, which is exactly why this predicate
 * exists — "the root" and "not addressable at all" must not be the same answer,
 * or dropping onto a feature group quietly moves files to the project root.
 *
 * Only folder rows can be pathless: a file row always carries its `filePath`,
 * whatever the tree is grouped by.
 */
export function isPathless(row: TreeRow): boolean {
  return row.kind === 'dir' && row.path === '';
}

export interface SelectionState {
  /** Ids of every selected row. Membership only — visible order comes from the rows. */
  readonly ids: ReadonlySet<string>;
  /** Where a Shift-range starts. Survives repeated Shift-clicks. */
  readonly anchor: string | null;
  /** The focused row — what ↑/↓ move from and F2 renames. */
  readonly lead: string | null;
}

export const EMPTY_SELECTION: SelectionState = Object.freeze({
  ids: Object.freeze(new Set<string>()),
  anchor: null,
  lead: null,
});

export interface ClickModifiers {
  shift?: boolean;
  /** ⌘ on macOS. */
  meta?: boolean;
  /** Ctrl elsewhere. Treated identically to `meta`. */
  ctrl?: boolean;
}

// ─── Reading a selection ─────────────────────────────────────────────────────

export function isSelected(state: SelectionState, id: string): boolean {
  return state.ids.has(id);
}

export function selectionSize(state: SelectionState): number {
  return state.ids.size;
}

/**
 * The selected rows in VISIBLE order.
 *
 * Order matters to every caller that turns a selection into work — a paste, a
 * multi-drag, a bulk delete — and the ids are a Set, which has none. Deriving it
 * from the row list rather than remembering click order means the answer is
 * always "top to bottom, as shown", which is the only order a user can predict.
 */
export function selectedRows<R extends TreeRow>(rows: readonly R[], state: SelectionState): R[] {
  return rows.filter((row) => state.ids.has(row.id));
}

/**
 * Selected ids in visible order — the id-only form of `selectedRows`.
 *
 * VISIBLE ONLY. This answers "what is on screen and selected", which is what a
 * toolbar summary or a highlight wants. It is not what a bulk operation wants:
 * use `allSelectedIds`.
 */
export function selectedIds(rows: readonly TreeRow[], state: SelectionState): string[] {
  return selectedRows(rows, state).map((row) => row.id);
}

/**
 * EVERY selected id — the ones on screen first, in visible order, then the rest
 * in the order they were selected.
 *
 * The rest are real. A folder collapsed after its files were selected keeps
 * them selected by design (`reconcileSelection` says why), so a delete planned
 * from `selectedIds` alone would act on fewer files than the count in the
 * toolbar promised — silently, and destructively. Ordering what CAN be ordered
 * and appending what cannot is the only version of this that loses nothing.
 */
export function allSelectedIds(rows: readonly TreeRow[], state: SelectionState): string[] {
  const visible = selectedIds(rows, state);
  const seen = new Set(visible);
  const hidden: string[] = [];
  for (const id of state.ids) if (!seen.has(id)) hidden.push(id);
  return [...visible, ...hidden];
}

/**
 * How many selected rows are NOT in `rows`.
 *
 * For the UI to say so — "12 selected (3 not visible)" — rather than leaving the
 * user to discover it when a delete reports a different number than they
 * counted. Zero in the ordinary case, which is when nothing is shown.
 */
export function hiddenSelectionCount(rows: readonly TreeRow[], state: SelectionState): number {
  const visible = new Set(rows.map((row) => row.id));
  let hidden = 0;
  for (const id of state.ids) if (!visible.has(id)) hidden += 1;
  return hidden;
}

// ─── Building a selection ────────────────────────────────────────────────────

function same(a: SelectionState, b: SelectionState): boolean {
  if (a.anchor !== b.anchor || a.lead !== b.lead || a.ids.size !== b.ids.size) return false;
  for (const id of a.ids) if (!b.ids.has(id)) return false;
  return true;
}

/**
 * Return `previous` when the new state is equivalent.
 *
 * The explorer re-renders on every selection change, and clicking the row that
 * is already the sole selection is the most common click there is. Handing back
 * the identical object lets React bail out of that render instead of repainting
 * a tree that looks the same.
 */
function settle(previous: SelectionState, next: SelectionState): SelectionState {
  return same(previous, next) ? previous : next;
}

/** Sole selection: the plain click, and what every fallback path collapses to. */
export function selectOnly(state: SelectionState, id: string): SelectionState {
  return settle(state, { ids: new Set([id]), anchor: id, lead: id });
}

/**
 * Add or remove one row, leaving the rest alone (⌘/Ctrl-click).
 *
 * The anchor moves to the toggled row in BOTH directions, including when the
 * click deselects it. That is what VS Code does and it is the useful behaviour:
 * ⌘-click a row, then Shift-click ten rows below, and you get the range you
 * pointed at rather than a range measured from wherever you last happened to be.
 */
export function toggleSelected(state: SelectionState, id: string): SelectionState {
  const ids = new Set(state.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return settle(state, { ids, anchor: id, lead: id });
}

/** Every id between two rows inclusive, in visible order. `[]` if either is gone. */
export function rangeIds(rows: readonly TreeRow[], fromId: string, toId: string): string[] {
  const from = indexOfId(rows, fromId);
  const to = indexOfId(rows, toId);
  if (from === -1 || to === -1) return [];
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const out: string[] = [];
  for (let i = lo; i <= hi; i += 1) {
    const row = rows[i];
    if (row) out.push(row.id);
  }
  return out;
}

/**
 * Shift-extend: replace the selection with anchor→`toId`, keeping the anchor.
 *
 * When there is no anchor, or the anchored row is no longer in the list (it was
 * collapsed away or deleted under us), there is no range to measure and the only
 * honest answer is to start a new one at the target — extending from an index we
 * cannot see would select rows the user never pointed at.
 */
export function extendSelection(
  rows: readonly TreeRow[],
  state: SelectionState,
  toId: string,
): SelectionState {
  if (indexOfId(rows, toId) === -1) return state;
  const anchor = state.anchor !== null && indexOfId(rows, state.anchor) !== -1 ? state.anchor : toId;
  const range = rangeIds(rows, anchor, toId);
  return settle(state, { ids: new Set(range), anchor, lead: toId });
}

/** Shift-extend that KEEPS what was already selected (⌘/Ctrl+Shift-click). */
export function extendSelectionAdditive(
  rows: readonly TreeRow[],
  state: SelectionState,
  toId: string,
): SelectionState {
  const extended = extendSelection(rows, state, toId);
  if (extended === state) return state;
  const ids = new Set(state.ids);
  for (const id of extended.ids) ids.add(id);
  return settle(state, { ids, anchor: extended.anchor, lead: extended.lead });
}

/**
 * The one entry point a row's onClick needs — routes the three click gestures.
 *
 * Clicking a row that is not in `rows` is ignored rather than selected: it means
 * the list the handler closed over is stale, and selecting a row nobody can see
 * leaves the tree in a state with no visible cursor.
 */
export function applyClick(
  rows: readonly TreeRow[],
  state: SelectionState,
  id: string,
  mods: ClickModifiers = {},
): SelectionState {
  if (indexOfId(rows, id) === -1) return state;
  const additive = mods.meta === true || mods.ctrl === true;
  if (mods.shift === true) {
    return additive ? extendSelectionAdditive(rows, state, id) : extendSelection(rows, state, id);
  }
  if (additive) return toggleSelected(state, id);
  return selectOnly(state, id);
}

/** Select every visible row (⌘/Ctrl+A), leading at the last. */
export function selectAll<R extends TreeRow>(
  rows: readonly R[],
  state: SelectionState,
): SelectionState {
  if (rows.length === 0) return state;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return state;
  return settle(state, {
    ids: new Set(rows.map((row) => row.id)),
    anchor: first.id,
    lead: last.id,
  });
}

export function clearSelection(state: SelectionState): SelectionState {
  return settle(state, EMPTY_SELECTION);
}

/**
 * Drop ids that no longer exist after the tree was rebuilt.
 *
 * `liveIds` is every id in the WHOLE tree, not the visible rows: collapsing a
 * folder must not deselect the files inside it, or expanding it again would show
 * a selection the user never cancelled. Only an id that has genuinely gone —
 * deleted, renamed into a new identity — is dropped.
 *
 * Without this, a poll that refreshes the test list leaves ids pointing at
 * nothing, `selectedRows` silently returns fewer rows than `ids.size`, and a
 * bulk delete quietly does less than the count in the toolbar promised.
 */
export function reconcileSelection(
  state: SelectionState,
  liveIds: Iterable<string>,
): SelectionState {
  const live = liveIds instanceof Set ? (liveIds as Set<string>) : new Set(liveIds);
  const ids = new Set<string>();
  for (const id of state.ids) if (live.has(id)) ids.add(id);
  const anchor = state.anchor !== null && live.has(state.anchor) ? state.anchor : null;
  const lead = state.lead !== null && live.has(state.lead) ? state.lead : null;
  return settle(state, { ids, anchor, lead });
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

/** The fields this module reads off a KeyboardEvent — nothing else is touched. */
export interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/**
 * The live type-to-select buffer.
 *
 * `at` is the timestamp of the last keystroke, carried in the state rather than
 * read from a clock inside the reducer so the whole keyboard path stays a pure
 * function of its arguments and the tests can drive time by hand.
 */
export interface TypeAhead {
  readonly query: string;
  readonly at: number;
}

export const NO_TYPE_AHEAD: TypeAhead = Object.freeze({ query: '', at: 0 });

/**
 * How long a type-to-select buffer survives between keystrokes. Windows Explorer
 * and VS Code both sit around here; much shorter and a two-handed typist loses
 * the second letter, much longer and an unrelated keystroke a second later jumps
 * the cursor somewhere they were not expecting.
 */
export const TYPE_AHEAD_MS = 500;

/**
 * Something for the caller to do that this module cannot: hit the API, open a
 * buffer, start an inline rename, change the expanded set.
 *
 * EVERY `id` here is a ROW id — `row.id`, the selection key — because a row is
 * all this module was given. Expansion and scope are keyed on the MODEL id, so
 * `expand`/`collapse` must be mapped back through `rowById(rows, id).nodeId`
 * before they touch the expanded set. The two spaces are not interchangeable;
 * `rows.ts` documents why.
 */
export type TreeAction =
  | { kind: 'open'; id: string }
  | { kind: 'expand'; id: string; path: string }
  | { kind: 'collapse'; id: string; path: string }
  | { kind: 'rename'; id: string }
  | { kind: 'delete'; ids: string[] };

export interface KeyResult {
  /**
   * True when this module owned the key. Arrow keys and Home/End are claimed
   * even when they change nothing — otherwise the pane scrolls under a cursor
   * that is already at the end of the list, which reads as the key being broken.
   */
  handled: boolean;
  selection: SelectionState;
  typeAhead: TypeAhead;
  /**
   * Row id to scroll into view — null when the cursor did not move, which
   * includes a delete (the rows are about to go) and a search that matched
   * nothing.
   */
  reveal: string | null;
  action: TreeAction | null;
}

export interface KeyContext {
  typeAhead?: TypeAhead;
  /** Injected so the reducer is pure; falls back to the clock for convenience. */
  now?: number;
}

function indexOfId(rows: readonly TreeRow[], id: string | null): number {
  if (id === null) return -1;
  return rows.findIndex((row) => row.id === id);
}

/**
 * Prefix search over the visible rows, wrapping past the end.
 *
 * `from` is where to start and `inclusive` decides whether the row already under
 * the cursor can match itself. Both matter: a GROWING query must be able to stay
 * on the row it already matched, and a repeated single letter must move on to
 * the next row that starts with it.
 */
function findByPrefix(
  rows: readonly TreeRow[],
  prefix: string,
  from: number,
  inclusive: boolean,
): number {
  if (rows.length === 0 || prefix === '') return -1;
  const needle = prefix.toLowerCase();
  const start = from === -1 ? 0 : from + (inclusive ? 0 : 1);
  for (let step = 0; step < rows.length; step += 1) {
    const index = (((start + step) % rows.length) + rows.length) % rows.length;
    const row = rows[index];
    if (row && row.name.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/**
 * One keystroke against the visible rows.
 *
 * Movement keys reset the type-ahead buffer: pressing ↓ ends the search, so the
 * letter you type next starts a new one rather than appending to a query from
 * three rows ago.
 */
export function handleKey<R extends TreeRow>(
  rows: readonly R[],
  state: SelectionState,
  event: KeyEventLike,
  ctx: KeyContext = {},
): KeyResult {
  const typeAhead = ctx.typeAhead ?? NO_TYPE_AHEAD;
  const now = ctx.now ?? Date.now();
  const shift = event.shiftKey === true;
  const additive = event.metaKey === true || event.ctrlKey === true;

  const ignored: KeyResult = {
    handled: false,
    selection: state,
    typeAhead,
    reveal: null,
    action: null,
  };
  /** Claimed the key, changed nothing, and ended any running search. */
  const consumed: KeyResult = {
    handled: true,
    selection: state,
    typeAhead: NO_TYPE_AHEAD,
    reveal: null,
    action: null,
  };

  const leadIndex = indexOfId(rows, state.lead);
  const leadRow = leadIndex === -1 ? null : (rows[leadIndex] ?? null);

  /**
   * Move the cursor to `index`.
   *
   * Shift extends from the anchor, and ⌘/Ctrl+Shift extends ADDITIVELY — which
   * is the same pair of gestures `applyClick` routes for the mouse. Without the
   * additive branch, ⌘⇧↓ silently discards a selection built with ⌘-clicks, and
   * the keyboard and the mouse disagree about what the same two modifiers mean.
   */
  const moveTo = (index: number): KeyResult => {
    const row = rows[index];
    if (!row) return consumed;
    let selection: SelectionState;
    if (shift) {
      selection = additive
        ? extendSelectionAdditive(rows, state, row.id)
        : extendSelection(rows, state, row.id);
    } else {
      selection = selectOnly(state, row.id);
    }
    return { handled: true, selection, typeAhead: NO_TYPE_AHEAD, reveal: row.id, action: null };
  };

  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (rows.length === 0) return consumed;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // A lead that is no longer visible (its folder was collapsed) is not a
      // position, so ↓ enters the list at the top and ↑ at the bottom.
      if (leadIndex === -1) return moveTo(step > 0 ? 0 : rows.length - 1);
      return moveTo(Math.min(rows.length - 1, Math.max(0, leadIndex + step)));
    }

    case 'Home':
      if (rows.length === 0) return consumed;
      return moveTo(0);

    case 'End':
      if (rows.length === 0) return consumed;
      return moveTo(rows.length - 1);

    case 'ArrowLeft': {
      if (!leadRow) return consumed;
      // An open folder closes; anything already closed steps out to its parent.
      // The second half is what makes ← usable as "go up a level" without
      // hunting for the parent row with the mouse.
      if (leadRow.kind === 'dir' && leadRow.expanded === true) {
        return {
          handled: true,
          selection: state,
          typeAhead: NO_TYPE_AHEAD,
          reveal: leadRow.id,
          action: { kind: 'collapse', id: leadRow.id, path: leadRow.path },
        };
      }
      // The root has no row, so a row whose parent IS the root has nowhere to
      // step to. Matching on `path === ''` would find a FEATURE GROUP, which is
      // pathless rather than root — and jumping the cursor into an unrelated
      // heading is worse than not moving.
      if (leadRow.parentPath === '') return consumed;
      const parent = rows.findIndex(
        (row) => row.kind === 'dir' && !isPathless(row) && row.path === leadRow.parentPath,
      );
      if (parent === -1) return consumed;
      return moveTo(parent);
    }

    case 'ArrowRight': {
      if (!leadRow || leadRow.kind !== 'dir') return consumed;
      if (leadRow.expanded !== true) {
        return {
          handled: true,
          selection: state,
          typeAhead: NO_TYPE_AHEAD,
          reveal: leadRow.id,
          action: { kind: 'expand', id: leadRow.id, path: leadRow.path },
        };
      }
      // Already open: step to the first child, which — in a flattened list — is
      // the next row, but only if it really belongs to this folder. An empty
      // open folder's next row is a sibling or an uncle, and jumping to that
      // would look like → skipped a row.
      //
      // DEPTH, not parentPath: the flattener owns depth, so this holds for a
      // compacted folder chain and for a feature group, whose children keep
      // their own `filePath` and therefore do NOT name the group as a parent.
      // Comparing paths there refused to step into any group at all.
      const next = rows[leadIndex + 1];
      if (!next || next.depth !== leadRow.depth + 1) return consumed;
      return moveTo(leadIndex + 1);
    }

    case 'Enter': {
      if (!leadRow) return consumed;
      // Enter on a folder toggles it — the same thing clicking its chevron does,
      // so the keyboard is not the one place a folder cannot be opened.
      if (leadRow.kind === 'dir') {
        return {
          handled: true,
          selection: state,
          typeAhead: NO_TYPE_AHEAD,
          reveal: leadRow.id,
          action: {
            kind: leadRow.expanded === true ? 'collapse' : 'expand',
            id: leadRow.id,
            path: leadRow.path,
          },
        };
      }
      return {
        handled: true,
        selection: state,
        typeAhead: NO_TYPE_AHEAD,
        reveal: leadRow.id,
        action: { kind: 'open', id: leadRow.id },
      };
    }

    case 'F2': {
      if (!leadRow) return consumed;
      // A feature group is a heading with no path, so there is nothing to
      // rename: the API renames by writing a new `filePath`, and computing one
      // for a row that has none produces a path at the project root. Claim the
      // key and do nothing rather than start an edit that cannot be saved.
      if (isPathless(leadRow)) return consumed;
      return {
        handled: true,
        selection: state,
        typeAhead: NO_TYPE_AHEAD,
        reveal: leadRow.id,
        action: { kind: 'rename', id: leadRow.id },
      };
    }

    case 'Delete':
    case 'Backspace': {
      // Backspace as well as Delete: Apple keyboards have no Delete key, and a
      // Mac user pressing the key labelled "delete" expects the file to go.
      //
      // `allSelectedIds`, not `selectedIds`: a file selected before its folder
      // was collapsed is still selected and still counted in the toolbar, and a
      // delete that quietly skipped it would do less than it said it would.
      const ids = allSelectedIds(rows, state);
      const targets = ids.length > 0 ? ids : leadRow ? [leadRow.id] : [];
      if (targets.length === 0) return consumed;
      return {
        handled: true,
        selection: state,
        typeAhead: NO_TYPE_AHEAD,
        reveal: null,
        action: { kind: 'delete', ids: targets },
      };
    }

    case 'Escape': {
      // Only claimed while a search is running, so Escape still closes whatever
      // the pane has open when nothing is being typed.
      if (typeAhead.query === '') return ignored;
      return { handled: true, selection: state, typeAhead: NO_TYPE_AHEAD, reveal: null, action: null };
    }

    default:
      break;
  }

  if (additive && (event.key === 'a' || event.key === 'A')) {
    const selection = selectAll(rows, state);
    return { handled: true, selection, typeAhead: NO_TYPE_AHEAD, reveal: selection.lead, action: null };
  }

  // ── Type-to-select ─────────────────────────────────────────────────────────
  // ⌘/Ctrl/Alt combinations are shortcuts, not text — swallowing them here would
  // eat ⌘X, ⌘C and ⌘V, which the caller routes to the clipboard module.
  const printable = event.key.length === 1 && !additive && event.altKey !== true;
  if (!printable) return ignored;
  // Space is deliberately only a search character mid-query. Leading space
  // matches nothing (no filename starts with one) and would cost the pane its
  // page-scroll for a keystroke that could never find anything.
  if (event.key === ' ' && typeAhead.query === '') return ignored;

  const continuing = now - typeAhead.at <= TYPE_AHEAD_MS && typeAhead.query !== '';
  const query = continuing ? typeAhead.query + event.key : event.key;
  const next: TypeAhead = { query, at: now };
  // A growing query re-searches from the current row INCLUSIVE, so typing
  // "or", "ord", "orde" stays on `order-total.spec.ts` instead of hopping to the
  // next `or…` on every letter. A fresh query starts after it, so pressing the
  // same letter repeatedly cycles through the rows that begin with it.
  const found = findByPrefix(rows, query, leadIndex, continuing);
  if (found === -1) return { handled: true, selection: state, typeAhead: next, reveal: null, action: null };
  const row = rows[found];
  if (!row) return { handled: true, selection: state, typeAhead: next, reveal: null, action: null };
  return {
    handled: true,
    selection: selectOnly(state, row.id),
    typeAhead: next,
    reveal: row.id,
    action: null,
  };
}
