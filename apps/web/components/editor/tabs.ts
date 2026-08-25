/**
 * The tab bar's brain: what is open, which one is showing, and what every verb
 * does to both.
 *
 * Not a component and not a hook — a set of pure functions over one frozen
 * value. The reason is the feature list rather than purity for its own sake.
 * Preview tabs, pinning and ⌃Tab are almost entirely bookkeeping, they interact
 * with each other in ways that are easy to get subtly wrong, and `apps/web` has
 * no component-test setup at all. Everything expressible without the DOM lives
 * here so it can be tested; `TabStrip` is left with drawing and events.
 *
 * ── One state per editor group ──────────────────────────────────────────────
 *
 * A split view is two groups, and each holds its OWN `TabsState`: its own open
 * list, its own active tab, its own MRU history and its own reopen stack. That
 * is what VS Code does, and it is the only arrangement where closing the last
 * tab in the right-hand pane cannot disturb the left one. The parent keeps two
 * of these; nothing in this file knows panes exist.
 *
 * ── The three invariants everything else is built on ────────────────────────
 *
 * 1. AT MOST ONE PREVIEW TAB. A preview tab is the italic one a single click
 *    opens, and the next single click REPLACES it in place. Two of them would
 *    make "replace the preview" ambiguous, so `openTab` is the only door and it
 *    keeps the count at one.
 *
 * 2. A PROMOTED TAB NEVER REVERTS. Double-clicking, editing, pinning or
 *    dragging a tab makes it permanent, and no later single click can turn it
 *    back into a preview. A tab that could silently become disposable again is
 *    a tab that eats somebody's unsaved work the next time they click a file.
 *
 * 3. PINNED TABS COME FIRST, in the order they were pinned. Held by a stable
 *    partition applied after every mutation rather than by a sort key, so
 *    reordering within a region is preserved and no operation can leave the
 *    list interleaved.
 *
 * ── Two orders, deliberately different ──────────────────────────────────────
 *
 * `tabs` is VISUAL order — left to right, what the strip paints. `mru` is
 * RECENCY order — most recently active first, what ⌃Tab walks. Conflating them
 * gives you a ⌃Tab that steps sideways through the strip instead of back
 * through where you have been, which is the whole point of the gesture.
 */

// ─── The shapes ──────────────────────────────────────────────────────────────

/** One open editor. */
export interface Tab {
  /** The test id. A tab's identity, stable across renames. */
  id: string;
  /** Full file path — the tooltip, and what `label` is derived from. */
  path: string;
  /** Last path segment, which is all the strip has room for. */
  label: string;
  /** Italic, disposable, replaced by the next single click. */
  preview: boolean;
  /** Sorts first, survives "close others" and "close all". */
  pinned: boolean;
  /** Unsaved edits — the dot. */
  dirty: boolean;
}

/** A closed tab, and where it was, so ⇧⌘T can put it back. */
export interface ClosedTab {
  readonly tab: Tab;
  readonly index: number;
}

/**
 * A ⌃Tab walk in progress.
 *
 * `order` is a SNAPSHOT of the MRU list taken when the modifier went down, and
 * it must not change while the key is held: the list you are walking cannot be
 * reordered by the walking, or the second press would take you back to where
 * the first one started and ⌃Tab would toggle between two files forever.
 *
 * `origin` is what was showing when the walk began — `null` when nothing was.
 * It is recorded rather than re-derived because Escape has to put the editor
 * back exactly where it was, and `order[0]` is only the same thing while the
 * active tab happens to be the most recent one. It is not after a close, after
 * a background open, or when the walk started with no active tab at all, and in
 * that last case Escape reading `order[0]` would land the user on a file they
 * had never been shown.
 */
export interface CycleState {
  readonly order: readonly string[];
  readonly index: number;
  readonly origin: string | null;
}

export interface TabsState {
  /** Visual order, pinned first. */
  readonly tabs: readonly Tab[];
  readonly activeId: string | null;
  /** Recency order, most recent first. Every open tab appears exactly once. */
  readonly mru: readonly string[];
  /** Newest first. Bounded — see MAX_CLOSED. */
  readonly closed: readonly ClosedTab[];
  /** Non-null only while ⌃ is held. */
  readonly cycle: CycleState | null;
}

export const EMPTY_TABS: TabsState = Object.freeze({
  tabs: [],
  activeId: null,
  mru: [],
  closed: [],
  cycle: null,
});

/**
 * How far back ⇧⌘T remembers.
 *
 * Bounded because the stack holds a full `Tab` each and a long session closes a
 * lot of files; twenty is more than anyone reaches for and costs nothing.
 */
export const MAX_CLOSED = 20;

// ─── Reading a state ─────────────────────────────────────────────────────────

/** `checkout/order-total.spec.ts` → `order-total.spec.ts`. */
export const labelFor = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

export function tabById(state: TabsState, id: string): Tab | null {
  return state.tabs.find((tab) => tab.id === id) ?? null;
}

export function activeTab(state: TabsState): Tab | null {
  return state.activeId === null ? null : tabById(state, state.activeId);
}

/** The one italic tab, if there is one. Invariant 1 says there is at most one. */
export function previewTab(state: TabsState): Tab | null {
  return state.tabs.find((tab) => tab.preview) ?? null;
}

/** Visual index, or -1. */
export function indexOfTab(state: TabsState, id: string): number {
  return state.tabs.findIndex((tab) => tab.id === id);
}

export const isOpen = (state: TabsState, id: string): boolean => indexOfTab(state, id) !== -1;

/** Any tab holding unsaved work — what a "close all" confirm needs to count. */
export function dirtyTabs(state: TabsState): Tab[] {
  return state.tabs.filter((tab) => tab.dirty);
}

// ─── Internals ───────────────────────────────────────────────────────────────

/**
 * Invariant 3, as a stable partition rather than a sort.
 *
 * Stability is the point: `Array.prototype.sort` on a pinned flag would be free
 * to permute equal elements, which would scramble a drag-reorder the moment
 * anything else touched the list.
 */
function orderTabs(tabs: readonly Tab[]): Tab[] {
  const pinned: Tab[] = [];
  const rest: Tab[] = [];
  for (const tab of tabs) (tab.pinned ? pinned : rest).push(tab);
  return [...pinned, ...rest];
}

/** Move `id` to the front of the recency list, adding it if it is new. */
function touchMru(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter((other) => other !== id)];
}

/**
 * Rebuild a state around a new tab list, dropping anything the list no longer
 * contains from the recency order.
 *
 * Every mutation goes through here so no caller has to remember that `mru` and
 * `tabs` are two views of one set — a stale id in `mru` would make ⌃Tab land on
 * a file that is not open.
 */
function withTabs(state: TabsState, tabs: readonly Tab[], activeId: string | null): TabsState {
  const ordered = orderTabs(tabs);
  const live = new Set(ordered.map((tab) => tab.id));
  return {
    tabs: ordered,
    activeId: activeId !== null && live.has(activeId) ? activeId : null,
    mru: state.mru.filter((id) => live.has(id)),
    closed: state.closed,
    cycle: null,
  };
}

/** Replace one tab by id, leaving the array alone when nothing changed. */
function mapTab(state: TabsState, id: string, change: (tab: Tab) => Tab): TabsState {
  const index = indexOfTab(state, id);
  if (index === -1) return state;
  const current = state.tabs[index]!;
  const next = change(current);
  if (
    next.preview === current.preview &&
    next.pinned === current.pinned &&
    next.dirty === current.dirty &&
    next.path === current.path &&
    next.label === current.label
  ) {
    return state;
  }
  const tabs = [...state.tabs];
  tabs[index] = next;
  return { ...state, tabs: orderTabs(tabs) };
}

/**
 * Who gets focus when the active tab closes.
 *
 * The most recently used survivor, not the neighbour. Both are defensible and
 * VS Code ships the first as its default, for a reason worth keeping: closing
 * a file you opened to glance at should return you to the one you were working
 * in, which is rarely the one that happens to sit next to it. The positional
 * fallback exists only for a state where recency has nothing to say.
 */
function nextActiveAfterClose(
  remaining: readonly Tab[],
  mru: readonly string[],
  closedIndex: number,
): string | null {
  if (remaining.length === 0) return null;
  const live = new Set(remaining.map((tab) => tab.id));
  const recent = mru.find((id) => live.has(id));
  if (recent !== undefined) return recent;
  return remaining[Math.min(closedIndex, remaining.length - 1)]?.id ?? null;
}

// ─── Opening ─────────────────────────────────────────────────────────────────

export interface OpenOptions {
  id: string;
  path: string;
  /**
   * A disposable preview — this is what a SINGLE click passes. Default false,
   * because every other way of opening a file (double click, ⌘P, "go to
   * definition", a drop onto the strip) means it permanently.
   */
  preview?: boolean;
  /**
   * Where to insert a NEW tab, as a gap index into the current list. Only the
   * drop-onto-the-strip gesture supplies it; everything else appends.
   */
  index?: number;
  /** Open in the background. Default true — open and show. */
  activate?: boolean;
}

/**
 * Open a file, or bring the tab that already has it forward.
 *
 * The three cases, in the order they are checked:
 *
 *  · ALREADY OPEN. Never duplicated. A non-preview open promotes it; a preview
 *    open leaves it exactly as it was, which is invariant 2 — the italic state
 *    only ever travels one way.
 *
 *  · NEW, AS A PREVIEW, WITH A PREVIEW ALREADY SHOWING. The old one is replaced
 *    IN PLACE, so a run of single clicks down the tree animates one tab
 *    changing its name rather than a strip filling up with files nobody asked
 *    to keep. The replaced tab does not go on the reopen stack: it was never
 *    committed to, and ⇧⌘T offering to restore a file you glanced at would
 *    bury the one you actually closed.
 *
 *  · NEW. Appended, or dropped at `index`.
 */
export function openTab(state: TabsState, options: OpenOptions): TabsState {
  const { id, path } = options;
  const preview = options.preview ?? false;
  const activate = options.activate ?? true;
  const label = labelFor(path);

  const existing = tabById(state, id);
  if (existing) {
    // `preview: false` promotes; `preview: true` is ignored on a tab that is
    // already permanent. Path is refreshed either way so a rename lands.
    const promoted = mapTab(state, id, (tab) => ({
      ...tab,
      path,
      label,
      preview: preview ? tab.preview : false,
    }));
    return activate ? activateTab(promoted, id) : { ...promoted, cycle: null };
  }

  const fresh: Tab = { id, path, label, preview, pinned: false, dirty: false };
  const replacing = preview ? previewTab(state) : null;

  let tabs: Tab[];
  if (replacing) {
    tabs = state.tabs.map((tab) => (tab.id === replacing.id ? fresh : tab));
  } else {
    tabs = [...state.tabs];
    const at = options.index === undefined ? tabs.length : clampIndex(options.index, tabs.length);
    tabs.splice(at, 0, fresh);
  }

  /*
   * A background open that replaces the SHOWING preview tab has to name a
   * successor. `state.activeId` points at a tab that no longer exists, and
   * `withTabs` would faithfully turn that into `null` — leaving a strip full of
   * tabs with nothing selected and an editor pane with no file in it, which is
   * a state no gesture can produce and none of the verbs below expect.
   *
   * The successor is chosen by the same rule a close uses, because this IS a
   * close from the strip's point of view: the most recently used survivor,
   * falling back to whatever now stands in the replaced tab's slot — which,
   * with no recency to go on, is the tab just opened.
   */
  const replacedActive = replacing !== null && !activate && state.activeId === replacing.id;
  const nextActive = replacedActive
    ? nextActiveAfterClose(tabs, state.mru, indexOfTab(state, replacing.id))
    : state.activeId;

  const opened = withTabs(state, tabs, nextActive);
  return activate ? activateTab(opened, id) : opened;
}

const clampIndex = (index: number, length: number): number =>
  Math.max(0, Math.min(length, Math.trunc(index)));

/** Double-click, ⌘K-Enter, "keep open" — make a preview tab permanent. */
export function promoteTab(state: TabsState, id: string): TabsState {
  return mapTab(state, id, (tab) => ({ ...tab, preview: false }));
}

/**
 * The dirty dot, and the other half of invariant 2.
 *
 * Editing a preview tab promotes it. Without that, typing into a file and then
 * clicking a second file in the tree would replace the buffer you were editing
 * — the single worst thing a preview tab can do, and the reason VS Code
 * promotes on the first keystroke rather than on save.
 */
export function setDirty(state: TabsState, id: string, dirty: boolean): TabsState {
  return mapTab(state, id, (tab) => ({
    ...tab,
    dirty,
    preview: dirty ? false : tab.preview,
  }));
}

/** A move or rename in the tree — the tab has to follow the file. */
export function retitleTab(state: TabsState, id: string, path: string): TabsState {
  return mapTab(state, id, (tab) => ({ ...tab, path, label: labelFor(path) }));
}

// ─── Activation and the ⌃Tab walk ────────────────────────────────────────────

/**
 * Show a tab, and record that it was used.
 *
 * Ends any cycle in progress: clicking a tab mid-walk is an answer, and the
 * click's target is what recency should remember rather than wherever the walk
 * had got to.
 */
export function activateTab(state: TabsState, id: string): TabsState {
  if (!isOpen(state, id)) return state;
  return { ...state, activeId: id, mru: touchMru(state.mru, id), cycle: null };
}

/** The recency list, filtered to what is open and backfilled with the rest. */
function mruOrder(state: TabsState): string[] {
  const live = new Set(state.tabs.map((tab) => tab.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of state.mru) {
    if (live.has(id) && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  // A tab opened in the background never entered `mru`. It belongs at the far
  // end of the walk rather than nowhere: ⌃⇧Tab should still be able to reach it.
  for (const tab of state.tabs) if (!seen.has(tab.id)) order.push(tab.id);
  return order;
}

/**
 * One step of ⌃Tab (`1`) or ⌃⇧Tab (`-1`), with the modifier still held.
 *
 * The first press starts the walk from the CURRENT editor's position, so ⌃Tab
 * lands on the previously used file and ⌃⇧Tab on the least recent one. `mru` is
 * untouched for the duration — see `CycleState` — and `endCycle` is what
 * commits the landing.
 *
 * ── Where the walk starts when nothing is showing ───────────────────────────
 *
 * With no active tab there is no position to step away FROM, so the walk starts
 * on the tab it would otherwise have stepped over: ⌃Tab on the most recent,
 * ⌃⇧Tab on the least. Treating the missing position as index 0 — which is what
 * an `?? 0` does — makes the first press skip the most recent file entirely,
 * and Escape then returns to a tab that was never in front of the user.
 *
 * The starting position is looked up rather than assumed to be index 0 for the
 * same reason: `closeTab` and a background `openTab` can both leave a tab
 * active without moving it to the front of the recency list.
 */
export function cycleTabs(state: TabsState, direction: 1 | -1): TabsState {
  const order = state.cycle?.order ?? mruOrder(state);
  if (order.length === 0) return state;

  const from = state.cycle ? state.cycle.index : indexOfInOrder(order, state.activeId);
  const index =
    from === null
      ? direction === 1
        ? 0
        : order.length - 1
      : (from + direction + order.length) % order.length;

  const id = order[index];
  if (id === undefined) return state;
  const origin = state.cycle ? state.cycle.origin : state.activeId;
  return { ...state, activeId: id, cycle: { order, index, origin } };
}

/** Position of the showing tab in a walk order, or `null` if nothing is. */
function indexOfInOrder(order: readonly string[], activeId: string | null): number | null {
  if (activeId === null) return null;
  const index = order.indexOf(activeId);
  return index === -1 ? null : index;
}

/** ⌃ released. The tab you landed on becomes the most recent. */
export function endCycle(state: TabsState): TabsState {
  if (!state.cycle) return state;
  const id = state.activeId;
  return { ...state, mru: id === null ? state.mru : touchMru(state.mru, id), cycle: null };
}

/** Escape during a walk — go back to where the walk started, remember nothing. */
export function cancelCycle(state: TabsState): TabsState {
  if (!state.cycle) return state;
  // The recorded origin, not `order[0]`: a walk that began with nothing showing
  // has to end with nothing showing rather than on the most recent file.
  const origin = state.cycle.origin;
  return {
    ...state,
    activeId: origin !== null && isOpen(state, origin) ? origin : null,
    cycle: null,
  };
}

// ─── Closing, and putting it back ────────────────────────────────────────────

/**
 * Close one tab.
 *
 * A pinned tab closes here: pinning protects against the BULK verbs, not
 * against being asked directly. ⌘W and the strip's own ✕ have to mean what they
 * say, or the only way to close a pinned file would be to unpin it first.
 */
export function closeTab(state: TabsState, id: string): TabsState {
  const index = indexOfTab(state, id);
  if (index === -1) return state;
  const tab = state.tabs[index]!;
  const tabs = state.tabs.filter((other) => other.id !== id);
  const mru = state.mru.filter((other) => other !== id);
  const activeId = state.activeId === id ? nextActiveAfterClose(tabs, mru, index) : state.activeId;

  return {
    tabs,
    activeId,
    mru,
    closed: [{ tab, index }, ...state.closed].slice(0, MAX_CLOSED),
    cycle: null,
  };
}

/**
 * Fold `closeTab` over a list rather than filtering in one pass.
 *
 * Slower and worth it: the reopen stack, the recency list and the choice of the
 * next active tab all have rules, and a second implementation of them for the
 * bulk verbs is a second implementation to keep in step. Every "close many"
 * below is this function plus a predicate.
 */
function closeEach(state: TabsState, ids: readonly string[]): TabsState {
  return ids.reduce((acc, id) => closeTab(acc, id), state);
}

/** Everything but this tab and the pinned ones. */
export function closeOtherTabs(state: TabsState, id: string): TabsState {
  const doomed = state.tabs.filter((tab) => tab.id !== id && !tab.pinned).map((tab) => tab.id);
  const closed = closeEach(state, doomed);
  return isOpen(closed, id) ? activateTab(closed, id) : closed;
}

/**
 * Everything to the right of this tab, pinned excepted.
 *
 * "To the right" is visual order, which is the order the person is looking at.
 * Pinned tabs sort left of every unpinned one, so this only meets them when the
 * anchor is itself pinned — and they are skipped there too.
 */
export function closeTabsToRight(state: TabsState, id: string): TabsState {
  const index = indexOfTab(state, id);
  if (index === -1) return state;
  const doomed = state.tabs
    .slice(index + 1)
    .filter((tab) => !tab.pinned)
    .map((tab) => tab.id);
  return closeEach(state, doomed);
}

/** Everything unpinned. Pinned tabs are exactly what survives this. */
export function closeAllTabs(state: TabsState): TabsState {
  return closeEach(
    state,
    state.tabs.filter((tab) => !tab.pinned).map((tab) => tab.id),
  );
}

/** Everything unpinned with no unsaved edits — the safe half of "close all". */
export function closeSavedTabs(state: TabsState): TabsState {
  return closeEach(
    state,
    state.tabs.filter((tab) => !tab.pinned && !tab.dirty).map((tab) => tab.id),
  );
}

/**
 * ⇧⌘T.
 *
 * The tab comes back permanent even if it was a preview when it closed:
 * restoring it as a preview could put a second italic tab on the strip beside
 * an existing one, breaking invariant 1, and "I deliberately asked for that
 * file back" is not a glance.
 *
 * A file that has been reopened by other means in the meantime consumes its
 * stack entry and is merely activated, so ⇧⌘T never produces a duplicate and
 * never appears to do nothing.
 */
export function reopenClosedTab(state: TabsState): TabsState {
  const [entry, ...rest] = state.closed;
  if (!entry) return state;
  const trimmed: TabsState = { ...state, closed: rest };

  if (isOpen(trimmed, entry.tab.id)) return activateTab(trimmed, entry.tab.id);

  const tabs = [...trimmed.tabs];
  tabs.splice(clampIndex(entry.index, tabs.length), 0, { ...entry.tab, preview: false });
  const reopened = withTabs(trimmed, tabs, trimmed.activeId);
  return activateTab({ ...reopened, closed: rest }, entry.tab.id);
}

// ─── Pinning and reordering ──────────────────────────────────────────────────

/**
 * Pin (or unpin) a tab.
 *
 * Pinning promotes: a pinned preview would be a tab you asked to keep that the
 * next single click throws away, which is a contradiction rather than an edge
 * case. The stable partition in `orderTabs` then places it after the tabs
 * pinned before it, which is what "pinned tabs keep their order" means.
 */
export function setPinned(state: TabsState, id: string, pinned: boolean): TabsState {
  return mapTab(state, id, (tab) => ({
    ...tab,
    pinned,
    preview: pinned ? false : tab.preview,
  }));
}

export function togglePinned(state: TabsState, id: string): TabsState {
  const tab = tabById(state, id);
  return tab ? setPinned(state, id, !tab.pinned) : state;
}

/**
 * Drag-to-reorder. `toIndex` is a GAP index into the list as it looks now — 0
 * is before the first tab, `tabs.length` is after the last.
 *
 * Dragging also promotes, on the same reasoning as pinning: arranging a tab is
 * a statement that you want it where you put it.
 *
 * The partition still rules afterwards, so an unpinned tab dropped into the
 * pinned run settles at the first unpinned slot instead of splitting the run.
 * That is a visible, predictable snap rather than a refused drop.
 */
export function moveTab(state: TabsState, id: string, toIndex: number): TabsState {
  const from = indexOfTab(state, id);
  if (from === -1) return state;
  const moving = state.tabs[from]!;
  const without = state.tabs.filter((_, index) => index !== from);
  const target = clampIndex(toIndex > from ? toIndex - 1 : toIndex, without.length);
  // Reused unchanged when it is already permanent, so the identity check below
  // can recognise a drag that ended where it started and hand back `state`.
  const moved = moving.preview ? { ...moving, preview: false } : moving;
  const tabs = [...without];
  tabs.splice(target, 0, moved);
  const ordered = orderTabs(tabs);
  const unchanged =
    ordered.length === state.tabs.length &&
    ordered.every((tab, index) => tab === state.tabs[index]);
  return unchanged ? state : { ...state, tabs: ordered };
}

// ─── The context menu ────────────────────────────────────────────────────────

export type TabMenuAction =
  | 'keepOpen'
  | 'close'
  | 'closeOthers'
  | 'closeRight'
  | 'closeSaved'
  | 'closeAll'
  | 'pin'
  | 'unpin'
  | 'reopenClosed'
  | 'copyPath'
  | 'splitRight';

export interface TabMenuItem {
  action: TabMenuAction;
  label: string;
  /** A rule stated to the user, not hidden from them — see below. */
  enabled: boolean;
  /** Draw a rule above this item. */
  separatorBefore?: boolean;
}

/**
 * The menu for one tab, with each verb's availability decided here rather than
 * in the renderer.
 *
 * Items are DISABLED rather than omitted. A menu whose contents change shape
 * per tab has to be re-read every time it opens; one whose items grey out can
 * be learned once, and the greying is itself the explanation for why "close to
 * the right" does nothing on the last tab.
 */
export function tabMenuItems(state: TabsState, id: string): TabMenuItem[] {
  const tab = tabById(state, id);
  if (!tab) return [];
  const index = indexOfTab(state, id);
  const others = state.tabs.filter((other) => other.id !== id && !other.pinned);
  const toRight = state.tabs.slice(index + 1).filter((other) => !other.pinned);

  return [
    { action: 'keepOpen', label: 'Keep open', enabled: tab.preview },
    { action: 'close', label: 'Close', enabled: true, separatorBefore: true },
    { action: 'closeOthers', label: 'Close others', enabled: others.length > 0 },
    { action: 'closeRight', label: 'Close to the right', enabled: toRight.length > 0 },
    {
      action: 'closeSaved',
      label: 'Close saved',
      enabled: state.tabs.some((other) => !other.pinned && !other.dirty),
    },
    {
      action: 'closeAll',
      label: 'Close all',
      enabled: state.tabs.some((other) => !other.pinned),
    },
    {
      action: 'reopenClosed',
      label: 'Reopen closed tab',
      enabled: state.closed.length > 0,
      separatorBefore: true,
    },
    {
      action: tab.pinned ? 'unpin' : 'pin',
      label: tab.pinned ? 'Unpin' : 'Pin',
      enabled: true,
      separatorBefore: true,
    },
    { action: 'splitRight', label: 'Open to the side', enabled: true },
    { action: 'copyPath', label: 'Copy path', enabled: true },
  ];
}

/**
 * Apply a menu action that this module can answer on its own.
 *
 * `copyPath` and `splitRight` are not among them — one touches the clipboard
 * and the other belongs to whoever owns the panes — so they come back as
 * `null` and the component escalates. Returning null rather than silently
 * returning the state unchanged is what stops a missing case from looking like
 * a working one.
 */
export function applyTabMenuAction(
  state: TabsState,
  action: TabMenuAction,
  id: string,
): TabsState | null {
  switch (action) {
    case 'keepOpen':
      return promoteTab(state, id);
    case 'close':
      return closeTab(state, id);
    case 'closeOthers':
      return closeOtherTabs(state, id);
    case 'closeRight':
      return closeTabsToRight(state, id);
    case 'closeSaved':
      return closeSavedTabs(state);
    case 'closeAll':
      return closeAllTabs(state);
    case 'pin':
      return setPinned(state, id, true);
    case 'unpin':
      return setPinned(state, id, false);
    case 'reopenClosed':
      return reopenClosedTab(state);
    case 'copyPath':
    case 'splitRight':
      return null;
  }
}

// ─── Dragging: onto the strip, and along it ──────────────────────────────────

/**
 * The drag payloads this strip speaks.
 *
 * Custom MIME types rather than `text/plain`, because a drop target must be
 * able to decide whether it can accept a drag DURING dragover — and the one
 * thing the platform allows there is reading `dataTransfer.types`. The data
 * itself is unreadable until drop, in every browser, by design.
 */
export const TAB_DRAG_MIME = 'application/x-qaai-tab';

/**
 * The type the explorer writes on a row drag.
 *
 * Declared here rather than imported from `components/tree/useTreeController`
 * so that this module — the editor's state, which a test can load on its own —
 * does not depend on the tree panel's hook and everything that reaches. The
 * duplication is guarded: a test asserts the two strings are the same one, so
 * the day the tree changes its dialect this file fails rather than silently
 * refusing every drop.
 */
export const TREE_DRAG_MIME = 'application/x-qaai-tree-rows+json';

/**
 * What a drag hovering the strip is, decided from `dataTransfer.types` alone.
 *
 * ONLY the two custom types count. `text/plain` used to be accepted here as a
 * courtesy, and it is on every drag in existence: a phrase selected in another
 * application, a link, a word dragged from the page below. Accepting it made
 * the strip call `preventDefault`, draw a drop caret and promise a drop it had
 * no ids to honour — a target that lights up for a gesture it cannot complete
 * is worse than one that stays dark. A real row drag out of the tree carries
 * `TREE_DRAG_MIME`; anything else is somebody else's drag passing over.
 */
export function dragKindFor(types: readonly string[]): 'tab' | 'tests' | null {
  if (types.includes(TAB_DRAG_MIME)) return 'tab';
  if (types.includes(TREE_DRAG_MIME)) return 'tests';
  return null;
}

/**
 * What a screen reader should call a tab.
 *
 * Given to the `role="tab"` element as an explicit `aria-label`, which is the
 * whole point: without one the name is COMPUTED from the element's contents,
 * and those contents include a close button ("Close order-total.spec.ts") and,
 * on a pinned tab, a pin button. The announced name becomes the filename with
 * its own controls read out after it. An explicit label ends that, and states
 * that are otherwise carried by italics, a dot or a glyph are said in words
 * here instead of in `sr-only` spans that the same computation would swallow.
 */
export function tabAccessibleName(tab: Tab): string {
  const notes: string[] = [];
  if (tab.pinned) notes.push('pinned');
  if (tab.preview) notes.push('preview');
  if (tab.dirty) notes.push('unsaved changes');
  return notes.length === 0 ? tab.label : `${tab.label}, ${notes.join(', ')}`;
}

/**
 * Test ids out of a drag payload.
 *
 * Tolerant on purpose: the tree writes a JSON array, but a payload that arrives
 * as one bare id, or as a newline-separated list from some other surface, is
 * unambiguous and refusing it would only produce a drop that does nothing.
 * Empty strings and duplicates are dropped so the caller can open the result
 * without checking it again.
 */
export function parseTestIds(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let candidates: string[];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    candidates = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : typeof parsed === 'string'
        ? [parsed]
        : [];
  } catch {
    candidates = trimmed.split(/[\n,]/);
  }

  const out: string[] = [];
  for (const candidate of candidates) {
    const id = candidate.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Which gap a pointer at `x` is over, given each tab's horizontal midpoint in
 * visual order.
 *
 * Midpoints rather than edges: a drop is "before or after this tab", and the
 * boundary a person aims at is the middle of the tab they are hovering, not the
 * seam between two of them. Returns a gap index in `[0, centers.length]`.
 */
export function insertionIndex(centers: readonly number[], x: number): number {
  let index = 0;
  while (index < centers.length && x > centers[index]!) index += 1;
  return index;
}

// ─── The split view's geometry ───────────────────────────────────────────────

/*
 * These live here, in the tabs module, for one blunt reason: `apps/web` has no
 * component-test setup, so anything inside `SplitEditor.tsx` cannot be tested
 * at all. A splitter's arithmetic is exactly the kind of thing that is wrong by
 * one clamp and looks fine until a pane collapses to nothing, so it is pulled
 * out to where a test can reach it. The alternative — a correctly named module
 * nobody can verify — is worse than a slightly crowded one.
 */

/** No pane may be squeezed below this fraction; below it a pane is unusable. */
export const MIN_PANE = 0.15;

/** The default step for an arrow key on the splitter, and its coarse variant. */
export const RATIO_STEP = 0.02;
export const RATIO_STEP_COARSE = 0.1;

/**
 * The splitter's thickness in px. Lives here rather than in `SplitEditor`
 * because it is not decoration — it is a term in the ratio arithmetic below,
 * and the two have to agree or the rule drifts away from the pointer.
 */
export const SPLITTER_SIZE = 5;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(1 - MIN_PANE, Math.max(MIN_PANE, ratio));
}

/**
 * Pointer position → split ratio.
 *
 * `size` is the container's length along the split axis and `gutter` is the
 * splitter's thickness, which the panes do NOT share: the rule is `shrink-0`,
 * so the two panes divide `size - gutter` between them and pane 0's edge sits
 * at `ratio * (size - gutter)`. Dividing by the full `size` instead makes the
 * rule lag the pointer by up to the width of the rule — worst at the extremes,
 * where the accumulated error is the whole gutter — so the thing being dragged
 * visibly slides away from the finger dragging it. Half the gutter comes off
 * the pointer because the pointer grabs the MIDDLE of the rule, not its left
 * edge.
 *
 * A zero-size container happens for one frame during layout, and dividing by it
 * would put `Infinity` into the state; `clampRatio` catches that, but returning
 * the midpoint here says what should happen rather than relying on a guard
 * downstream. Same for a container narrower than its own splitter.
 */
export function ratioFromPointer(
  position: number,
  start: number,
  size: number,
  gutter = 0,
): number {
  const track = size - gutter;
  if (track <= 0) return 0.5;
  return clampRatio((position - start - gutter / 2) / track);
}

/**
 * Keyboard on the splitter. `null` for a key this does not own, so the handler
 * can leave the event alone instead of swallowing Tab.
 *
 * Both axes are handled: the same component splits horizontally and vertically,
 * and a person on the vertical one reaches for ↑/↓.
 */
export function nudgeRatio(ratio: number, key: string, coarse = false): number | null {
  const step = coarse ? RATIO_STEP_COARSE : RATIO_STEP;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return clampRatio(ratio - step);
    case 'ArrowRight':
    case 'ArrowDown':
      return clampRatio(ratio + step);
    case 'Home':
      return MIN_PANE;
    case 'End':
      return 1 - MIN_PANE;
    case 'Enter':
      return 0.5;
    default:
      return null;
  }
}
