import { describe, expect, it } from 'vitest';
import { TREE_DRAG_MIME as TREE_DRAG_MIME_FROM_THE_TREE } from '../tree/useTreeController';
import {
  EMPTY_TABS,
  MAX_CLOSED,
  MIN_PANE,
  SPLITTER_SIZE,
  TAB_DRAG_MIME,
  TREE_DRAG_MIME,
  activateTab,
  activeTab,
  applyTabMenuAction,
  cancelCycle,
  clampRatio,
  closeAllTabs,
  closeOtherTabs,
  closeSavedTabs,
  closeTab,
  closeTabsToRight,
  cycleTabs,
  dirtyTabs,
  dragKindFor,
  endCycle,
  indexOfTab,
  insertionIndex,
  labelFor,
  moveTab,
  nudgeRatio,
  openTab,
  parseTestIds,
  previewTab,
  promoteTab,
  ratioFromPointer,
  reopenClosedTab,
  retitleTab,
  setDirty,
  setPinned,
  tabAccessibleName,
  tabById,
  tabMenuItems,
  togglePinned,
  type TabsState,
} from './tabs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The visual order, as labels — what the strip would paint, left to right. */
const order = (state: TabsState): string[] => state.tabs.map((tab) => tab.label);

const path = (name: string): string => `checkout/${name}.spec.ts`;

/** Open `name` permanently (a double click, ⌘P, or a drop). */
const open = (state: TabsState, name: string, extra: Record<string, unknown> = {}): TabsState =>
  openTab(state, { id: name, path: path(name), ...extra });

/** Open `name` as a preview (a single click). */
const peek = (state: TabsState, name: string): TabsState =>
  openTab(state, { id: name, path: path(name), preview: true });

/** a, b, c open permanently, c active, MRU c > b > a. */
const abc = (): TabsState => open(open(open(EMPTY_TABS, 'a'), 'b'), 'c');

/**
 * The three invariants the module claims, asserted after every scenario below.
 * A test that only checks the thing it is about will not notice a verb that
 * quietly leaves two preview tabs or a stale id in the recency list.
 */
function expectInvariants(state: TabsState): void {
  expect(state.tabs.filter((tab) => tab.preview).length).toBeLessThanOrEqual(1);

  const lastPinned = state.tabs.map((tab) => tab.pinned).lastIndexOf(true);
  const firstLoose = state.tabs.map((tab) => tab.pinned).indexOf(false);
  if (lastPinned !== -1 && firstLoose !== -1) expect(lastPinned).toBeLessThan(firstLoose);

  const ids = state.tabs.map((tab) => tab.id);
  expect(new Set(ids).size).toBe(ids.length);
  // Recency may lag behind (a background-opened tab has never been active), but
  // it may never name something that is not open, or name anything twice.
  expect(state.mru.every((id) => ids.includes(id))).toBe(true);
  expect(new Set(state.mru).size).toBe(state.mru.length);
  if (state.activeId !== null) expect(ids).toContain(state.activeId);
}

// ─── Opening ─────────────────────────────────────────────────────────────────

describe('opening', () => {
  it('takes the label from the last path segment', () => {
    expect(labelFor('checkout/order-total.spec.ts')).toBe('order-total.spec.ts');
    expect(labelFor('smoke.spec.ts')).toBe('smoke.spec.ts');
    expect(labelFor('trailing/slash/')).toBe('slash');
  });

  it('appends and activates', () => {
    const state = abc();
    expect(order(state)).toEqual(['a.spec.ts', 'b.spec.ts', 'c.spec.ts']);
    expect(state.activeId).toBe('c');
    expectInvariants(state);
  });

  it('never opens the same file twice — it activates the tab that has it', () => {
    const state = open(abc(), 'a');
    expect(state.tabs).toHaveLength(3);
    expect(state.activeId).toBe('a');
    expectInvariants(state);
  });

  it('can open in the background without stealing focus', () => {
    const state = open(abc(), 'd', { activate: false });
    expect(order(state)).toEqual(['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts']);
    expect(state.activeId).toBe('c');
    expectInvariants(state);
  });

  it('drops a tab at an explicit index — the strip drop target', () => {
    const state = open(abc(), 'd', { index: 1 });
    expect(order(state)).toEqual(['a.spec.ts', 'd.spec.ts', 'b.spec.ts', 'c.spec.ts']);
    expectInvariants(state);
  });

  it('clamps an out-of-range drop index instead of leaving a hole', () => {
    expect(order(open(abc(), 'd', { index: 99 }))).toEqual([
      'a.spec.ts',
      'b.spec.ts',
      'c.spec.ts',
      'd.spec.ts',
    ]);
    expect(order(open(abc(), 'd', { index: -4 }))).toEqual([
      'd.spec.ts',
      'a.spec.ts',
      'b.spec.ts',
      'c.spec.ts',
    ]);
  });
});

// ─── (26) Preview tabs ───────────────────────────────────────────────────────

describe('preview tabs', () => {
  it('a single click opens one italic tab', () => {
    const state = peek(EMPTY_TABS, 'a');
    expect(previewTab(state)?.id).toBe('a');
    expect(state.activeId).toBe('a');
    expectInvariants(state);
  });

  it('the next single click REPLACES it, in place, and there is only ever one', () => {
    let state = open(EMPTY_TABS, 'keep');
    state = peek(state, 'a');
    expect(order(state)).toEqual(['keep.spec.ts', 'a.spec.ts']);

    state = peek(state, 'b');
    expect(order(state)).toEqual(['keep.spec.ts', 'b.spec.ts']);
    expect(state.tabs).toHaveLength(2);
    expect(previewTab(state)?.id).toBe('b');
    expectInvariants(state);
  });

  it('replaces in place rather than appending, so the strip does not shuffle', () => {
    // The preview sits in the middle: a background-opened tab follows it.
    let state = peek(open(EMPTY_TABS, 'keep'), 'a');
    state = open(state, 'tail', { activate: false });
    expect(order(state)).toEqual(['keep.spec.ts', 'a.spec.ts', 'tail.spec.ts']);

    state = peek(state, 'b');
    expect(order(state)).toEqual(['keep.spec.ts', 'b.spec.ts', 'tail.spec.ts']);
    expectInvariants(state);
  });

  it('a double click promotes the preview instead of opening a second tab', () => {
    let state = peek(EMPTY_TABS, 'a');
    state = open(state, 'a');
    expect(state.tabs).toHaveLength(1);
    expect(previewTab(state)).toBeNull();
    expectInvariants(state);
  });

  it('an edit promotes it — the whole point of the mechanism', () => {
    let state = peek(EMPTY_TABS, 'a');
    state = setDirty(state, 'a', true);
    expect(tabById(state, 'a')?.preview).toBe(false);

    // And the next single click can no longer take the buffer away.
    state = peek(state, 'b');
    expect(order(state)).toEqual(['a.spec.ts', 'b.spec.ts']);
    expect(dirtyTabs(state).map((tab) => tab.id)).toEqual(['a']);
    expectInvariants(state);
  });

  /*
   * Invariant 2, stated directly. Every other promotion route funnels into the
   * same field, and a single click on an already-permanent tab is the one call
   * that could plausibly set it back.
   */
  it('a promoted tab never silently reverts to preview', () => {
    let state = promoteTab(peek(EMPTY_TABS, 'a'), 'a');
    state = peek(state, 'a');
    expect(tabById(state, 'a')?.preview).toBe(false);

    state = setDirty(state, 'a', true);
    state = setDirty(state, 'a', false);
    expect(tabById(state, 'a')?.preview).toBe(false);
    expectInvariants(state);
  });

  it('pinning promotes, so a kept tab cannot be thrown away by a click', () => {
    let state = setPinned(peek(EMPTY_TABS, 'a'), 'a', true);
    expect(tabById(state, 'a')).toMatchObject({ pinned: true, preview: false });
    state = peek(state, 'b');
    expect(order(state)).toEqual(['a.spec.ts', 'b.spec.ts']);
    expectInvariants(state);
  });

  it('dragging promotes too', () => {
    const state = moveTab(peek(open(EMPTY_TABS, 'keep'), 'a'), 'a', 0);
    expect(order(state)).toEqual(['a.spec.ts', 'keep.spec.ts']);
    expect(previewTab(state)).toBeNull();
    expectInvariants(state);
  });

  /*
   * A background preview open that lands on top of the SHOWING preview tab.
   * The tab the editor was rendering has just ceased to exist, and answering
   * "nothing is active" leaves a strip full of tabs with none selected and an
   * editor pane with no file in it — a state no gesture can produce.
   */
  it('replacing the showing preview in the background still leaves something showing', () => {
    const state = openTab(peek(EMPTY_TABS, 'a'), {
      id: 'b',
      path: path('b'),
      preview: true,
      activate: false,
    });
    expect(state.tabs).toHaveLength(1);
    // Nothing else survives, so the replacement stands where the replaced tab
    // stood — but it is NOT recorded as used, which is what `activate: false`
    // asked for.
    expect(state.activeId).toBe('b');
    expect(state.mru).toEqual([]);
    expectInvariants(state);
  });

  it('prefers the most recently used survivor when there is one', () => {
    // 'keep' was used before the preview was opened, so it is where the editor
    // goes back to rather than to the file that arrived in the background.
    let state = peek(open(EMPTY_TABS, 'keep'), 'a');
    state = openTab(state, { id: 'b', path: path('b'), preview: true, activate: false });
    expect(state.activeId).toBe('keep');
    expect(order(state)).toEqual(['keep.spec.ts', 'b.spec.ts']);
    expectInvariants(state);
  });

  it('leaves the showing tab alone when the replaced preview was not it', () => {
    let state = peek(open(EMPTY_TABS, 'keep'), 'a');
    state = activateTab(state, 'keep');
    state = openTab(state, { id: 'b', path: path('b'), preview: true, activate: false });
    expect(state.activeId).toBe('keep');
    expectInvariants(state);
  });

  it('a replaced preview does not clutter the reopen stack', () => {
    const state = peek(peek(EMPTY_TABS, 'a'), 'b');
    expect(state.closed).toHaveLength(0);
    expect(state.mru).toEqual(['b']);
    expectInvariants(state);
  });
});

// ─── (23) Pinned tabs ────────────────────────────────────────────────────────

describe('pinned tabs', () => {
  it('sort first, in the order they were pinned', () => {
    let state = abc();
    state = setPinned(state, 'c', true);
    expect(order(state)).toEqual(['c.spec.ts', 'a.spec.ts', 'b.spec.ts']);
    state = setPinned(state, 'b', true);
    expect(order(state)).toEqual(['c.spec.ts', 'b.spec.ts', 'a.spec.ts']);
    expectInvariants(state);
  });

  it('unpinning drops the tab to the head of the loose run', () => {
    let state = setPinned(setPinned(abc(), 'c', true), 'b', true);
    state = togglePinned(state, 'c');
    expect(order(state)).toEqual(['b.spec.ts', 'c.spec.ts', 'a.spec.ts']);
    expectInvariants(state);
  });

  it('survive "close others"', () => {
    const state = closeOtherTabs(setPinned(abc(), 'a', true), 'c');
    expect(order(state)).toEqual(['a.spec.ts', 'c.spec.ts']);
    expect(state.activeId).toBe('c');
    expectInvariants(state);
  });

  it('survive "close all"', () => {
    const state = closeAllTabs(setPinned(abc(), 'b', true));
    expect(order(state)).toEqual(['b.spec.ts']);
    expect(state.activeId).toBe('b');
    expectInvariants(state);
  });

  it('survive "close to the right" even when the anchor is pinned', () => {
    let state = setPinned(setPinned(abc(), 'a', true), 'b', true);
    expect(order(state)).toEqual(['a.spec.ts', 'b.spec.ts', 'c.spec.ts']);
    state = closeTabsToRight(state, 'a');
    expect(order(state)).toEqual(['a.spec.ts', 'b.spec.ts']);
    expectInvariants(state);
  });

  it('still close when closed by name — pinning guards the bulk verbs only', () => {
    const state = closeTab(setPinned(abc(), 'a', true), 'a');
    expect(order(state)).toEqual(['b.spec.ts', 'c.spec.ts']);
    expectInvariants(state);
  });
});

// ─── (23) ⌃Tab, most-recently-used ───────────────────────────────────────────

describe('⌃Tab most-recently-used switching', () => {
  it('the first press lands on the previously used editor, not the neighbour', () => {
    // Visual order a,b,c. Recency after activating a: a > c > b.
    const state = cycleTabs(activateTab(abc(), 'a'), 1);
    expect(state.activeId).toBe('c');
    expectInvariants(state);
  });

  it('repeated presses walk further back while the modifier is held', () => {
    let state = activateTab(abc(), 'a'); // recency a > c > b
    state = cycleTabs(state, 1);
    expect(state.activeId).toBe('c');
    state = cycleTabs(state, 1);
    expect(state.activeId).toBe('b');
    state = cycleTabs(state, 1);
    expect(state.activeId).toBe('a'); // wrapped
    expectInvariants(state);
  });

  it('does not reorder recency mid-walk — the list you walk cannot move', () => {
    const start = activateTab(abc(), 'a');
    const walked = cycleTabs(cycleTabs(start, 1), 1);
    expect(walked.mru).toEqual(start.mru);
    expect(walked.cycle).toEqual({ order: ['a', 'c', 'b'], index: 2, origin: 'a' });
  });

  it('⌃⇧Tab walks the other way, starting at the least recent', () => {
    const state = cycleTabs(activateTab(abc(), 'a'), -1);
    expect(state.activeId).toBe('b');
    expectInvariants(state);
  });

  it('releasing commits: the landing becomes the most recent', () => {
    const landed = endCycle(cycleTabs(activateTab(abc(), 'a'), 1));
    expect(landed.cycle).toBeNull();
    expect(landed.mru).toEqual(['c', 'a', 'b']);
    expectInvariants(landed);
  });

  /*
   * The bug an MRU cycle exists to avoid. Walk two back, release, walk one
   * back: with recency updated mid-walk the second walk would return to the
   * tab you just left, and ⌃Tab would ping-pong between two files.
   */
  it('a committed walk leaves the rest of the history intact', () => {
    let state = activateTab(abc(), 'a'); // a > c > b
    state = endCycle(cycleTabs(cycleTabs(state, 1), 1)); // land on b
    expect(state.activeId).toBe('b');
    expect(state.mru).toEqual(['b', 'a', 'c']);
    state = endCycle(cycleTabs(state, 1));
    expect(state.activeId).toBe('a');
    expectInvariants(state);
  });

  it('Escape abandons the walk and restores the editor it started from', () => {
    const start = activateTab(abc(), 'a');
    const state = cancelCycle(cycleTabs(cycleTabs(start, 1), 1));
    expect(state.activeId).toBe('a');
    expect(state.cycle).toBeNull();
    expect(state.mru).toEqual(start.mru);
  });

  it('clicking a tab mid-walk ends the walk on the clicked tab', () => {
    const state = activateTab(cycleTabs(activateTab(abc(), 'a'), 1), 'b');
    expect(state.cycle).toBeNull();
    expect(state.activeId).toBe('b');
    expect(state.mru).toEqual(['b', 'a', 'c']);
  });

  it('reaches a tab that was opened in the background and never activated', () => {
    const state = cycleTabs(open(abc(), 'd', { activate: false }), -1);
    expect(state.activeId).toBe('d');
    expectInvariants(state);
  });

  it('is a no-op with nothing open, and harmless to end', () => {
    expect(cycleTabs(EMPTY_TABS, 1)).toBe(EMPTY_TABS);
    expect(endCycle(EMPTY_TABS)).toBe(EMPTY_TABS);
    expect(cancelCycle(EMPTY_TABS)).toBe(EMPTY_TABS);
  });

  /*
   * With no editor showing there is no position to step away from, so the walk
   * has to START on the tab a normal press would have stepped over. Beginning
   * at index 0 and stepping off it skipped the most recent file altogether.
   */
  it('with nothing showing, the first ⌃Tab lands on the most recent file', () => {
    const nothingShowing = { ...abc(), activeId: null };
    const walked = cycleTabs(nothingShowing, 1);
    expect(walked.activeId).toBe('c');
    expect(walked.cycle?.index).toBe(0);
    expectInvariants(walked);
  });

  it('with nothing showing, ⌃⇧Tab lands on the least recent file', () => {
    const nothingShowing = { ...abc(), activeId: null };
    expect(cycleTabs(nothingShowing, -1).activeId).toBe('a');
  });

  it('a walk that began with nothing showing returns to nothing on Escape', () => {
    const nothingShowing = { ...abc(), activeId: null };
    const cancelled = cancelCycle(cycleTabs(cycleTabs(nothingShowing, 1), 1));
    expect(cancelled.activeId).toBeNull();
    expect(cancelled.cycle).toBeNull();
    expectInvariants(cancelled);
  });

  /*
   * The showing tab is usually the front of the recency list, but "usually" is
   * not "always" — a tab can be made active without being touched in `mru`.
   * The walk's start is therefore looked up rather than assumed to be index 0,
   * or the first press lands one tab away from where the user actually is.
   */
  it('starts from the showing tab even when it is not the front of the recency list', () => {
    const skewed: TabsState = { ...abc(), activeId: 'b', mru: ['c', 'a', 'b'] };
    const walked = cycleTabs(skewed, 1);
    // 'b' sits last in the walk order, so one step forward wraps to 'c'.
    expect(walked.activeId).toBe('c');
    expect(cancelCycle(walked).activeId).toBe('b');
    expectInvariants(walked);
  });

  it('with a single tab open, walking stays on it', () => {
    const one = open(EMPTY_TABS, 'a');
    expect(cycleTabs(one, 1).activeId).toBe('a');
  });
});

// ─── Closing ─────────────────────────────────────────────────────────────────

describe('closing', () => {
  it('moves focus to the most recently used survivor, not the neighbour', () => {
    // Recency a > c > b; closing the active `a` should land on c, which is the
    // tab on the far side of b.
    const state = closeTab(activateTab(abc(), 'a'), 'a');
    expect(state.activeId).toBe('c');
    expectInvariants(state);
  });

  it('leaves focus alone when a background tab closes', () => {
    const state = closeTab(abc(), 'a');
    expect(state.activeId).toBe('c');
    expectInvariants(state);
  });

  it('closing the last tab leaves nothing active', () => {
    const state = closeTab(open(EMPTY_TABS, 'a'), 'a');
    expect(state.tabs).toHaveLength(0);
    expect(state.activeId).toBeNull();
    expect(activeTab(state)).toBeNull();
    expectInvariants(state);
  });

  it('ignores an id that is not open', () => {
    const state = abc();
    expect(closeTab(state, 'nope')).toBe(state);
  });

  it('"close others" keeps the anchor and makes it active', () => {
    const state = closeOtherTabs(abc(), 'a');
    expect(order(state)).toEqual(['a.spec.ts']);
    expect(state.activeId).toBe('a');
    expectInvariants(state);
  });

  it('"close to the right" leaves everything to the left', () => {
    const state = closeTabsToRight(abc(), 'a');
    expect(order(state)).toEqual(['a.spec.ts']);
    expect(state.activeId).toBe('a');
    expectInvariants(state);
  });

  it('"close saved" spares unsaved work', () => {
    const state = closeSavedTabs(setDirty(abc(), 'b', true));
    expect(order(state)).toEqual(['b.spec.ts']);
    expectInvariants(state);
  });

  it('"close all" empties the strip when nothing is pinned', () => {
    const state = closeAllTabs(abc());
    expect(state.tabs).toHaveLength(0);
    expect(state.activeId).toBeNull();
    expect(state.mru).toEqual([]);
    expectInvariants(state);
  });
});

// ─── ⇧⌘T ────────────────────────────────────────────────────────────────────

describe('reopen closed tab', () => {
  it('puts the file back where it was, and focuses it', () => {
    const state = reopenClosedTab(closeTab(abc(), 'b'));
    expect(order(state)).toEqual(['a.spec.ts', 'b.spec.ts', 'c.spec.ts']);
    expect(state.activeId).toBe('b');
    expectInvariants(state);
  });

  it('walks back through several closes, newest first', () => {
    let state = closeTab(closeTab(abc(), 'a'), 'b');
    state = reopenClosedTab(state);
    expect(state.activeId).toBe('b');
    state = reopenClosedTab(state);
    expect(state.activeId).toBe('a');
    expect(order(state)).toEqual(['a.spec.ts', 'b.spec.ts', 'c.spec.ts']);
    expect(state.closed).toHaveLength(0);
    expectInvariants(state);
  });

  it('brings a preview back permanent, so it cannot break the one-preview rule', () => {
    let state = peek(open(EMPTY_TABS, 'keep'), 'a');
    state = closeTab(state, 'a');
    state = peek(state, 'b'); // a second preview now exists
    state = reopenClosedTab(state);
    expect(tabById(state, 'a')?.preview).toBe(false);
    expectInvariants(state);
  });

  it('never duplicates a file that was reopened by other means', () => {
    let state = closeTab(abc(), 'b');
    state = open(state, 'b');
    state = reopenClosedTab(state);
    expect(state.tabs.filter((tab) => tab.id === 'b')).toHaveLength(1);
    expect(state.activeId).toBe('b');
    expect(state.closed).toHaveLength(0);
    expectInvariants(state);
  });

  it('is a no-op with an empty stack', () => {
    const state = abc();
    expect(reopenClosedTab(state)).toBe(state);
  });

  it('is bounded, so a long session cannot grow the stack forever', () => {
    let state = EMPTY_TABS;
    for (let i = 0; i < MAX_CLOSED + 8; i += 1) state = open(state, `t${i}`);
    for (let i = 0; i < MAX_CLOSED + 8; i += 1) state = closeTab(state, `t${i}`);
    expect(state.closed).toHaveLength(MAX_CLOSED);
    // The oldest closes fell off the end; the newest are still there.
    expect(state.closed[0]?.tab.id).toBe(`t${MAX_CLOSED + 7}`);
  });
});

// ─── Reordering ──────────────────────────────────────────────────────────────

describe('drag to reorder', () => {
  it('moves a tab to a gap index', () => {
    expect(order(moveTab(abc(), 'c', 0))).toEqual(['c.spec.ts', 'a.spec.ts', 'b.spec.ts']);
    expect(order(moveTab(abc(), 'a', 3))).toEqual(['b.spec.ts', 'c.spec.ts', 'a.spec.ts']);
    expect(order(moveTab(abc(), 'a', 2))).toEqual(['b.spec.ts', 'a.spec.ts', 'c.spec.ts']);
  });

  it('a drop that changes nothing returns the same state', () => {
    const state = abc();
    expect(moveTab(state, 'b', 1)).toBe(state);
    expect(moveTab(state, 'b', 2)).toBe(state);
    expect(moveTab(state, 'missing', 0)).toBe(state);
  });

  it('an unpinned tab dropped into the pinned run snaps to the first loose slot', () => {
    const state = moveTab(setPinned(abc(), 'a', true), 'c', 0);
    expect(order(state)).toEqual(['a.spec.ts', 'c.spec.ts', 'b.spec.ts']);
    expectInvariants(state);
  });

  it('reorders within the pinned run', () => {
    let state = setPinned(setPinned(abc(), 'a', true), 'b', true);
    expect(order(state)).toEqual(['a.spec.ts', 'b.spec.ts', 'c.spec.ts']);
    state = moveTab(state, 'b', 0);
    expect(order(state)).toEqual(['b.spec.ts', 'a.spec.ts', 'c.spec.ts']);
    expectInvariants(state);
  });

  it('picks the gap from the tab midpoints a pointer is over', () => {
    const centers = [20, 60, 100];
    expect(insertionIndex(centers, 0)).toBe(0);
    expect(insertionIndex(centers, 19)).toBe(0);
    expect(insertionIndex(centers, 21)).toBe(1);
    expect(insertionIndex(centers, 61)).toBe(2);
    expect(insertionIndex(centers, 400)).toBe(3);
    expect(insertionIndex([], 5)).toBe(0);
  });
});

// ─── Renames ─────────────────────────────────────────────────────────────────

describe('the tab follows the file', () => {
  it('relabels on a move or rename in the tree', () => {
    const state = retitleTab(abc(), 'a', 'smoke/renamed.spec.ts');
    expect(tabById(state, 'a')).toMatchObject({
      path: 'smoke/renamed.spec.ts',
      label: 'renamed.spec.ts',
    });
    expect(indexOfTab(state, 'a')).toBe(0);
    expectInvariants(state);
  });

  it('re-opening a moved file updates the path without duplicating the tab', () => {
    const state = openTab(abc(), { id: 'a', path: 'moved/a.spec.ts' });
    expect(state.tabs).toHaveLength(3);
    expect(tabById(state, 'a')?.path).toBe('moved/a.spec.ts');
  });
});

// ─── The context menu ────────────────────────────────────────────────────────

describe('the context menu', () => {
  const enabled = (state: TabsState, id: string): string[] =>
    tabMenuItems(state, id)
      .filter((item) => item.enabled)
      .map((item) => item.action);

  it('is empty for a tab that is not open', () => {
    expect(tabMenuItems(abc(), 'nope')).toEqual([]);
  });

  it('greys out the verbs that would do nothing', () => {
    const one = open(EMPTY_TABS, 'a');
    const off = tabMenuItems(one, 'a')
      .filter((item) => !item.enabled)
      .map((item) => item.action);
    // Nothing to keep open, nothing beside it, nothing to put back. "Close all"
    // and "close saved" are NOT among them: with one loose clean tab open they
    // both close it.
    expect(off).toEqual(['keepOpen', 'closeOthers', 'closeRight', 'reopenClosed']);
    expect(enabled(one, 'a')).toEqual([
      'close',
      'closeSaved',
      'closeAll',
      'pin',
      'splitRight',
      'copyPath',
    ]);
  });

  it('offers "keep open" only on a preview tab', () => {
    expect(enabled(peek(EMPTY_TABS, 'a'), 'a')).toContain('keepOpen');
    expect(enabled(open(EMPTY_TABS, 'a'), 'a')).not.toContain('keepOpen');
  });

  it('offers "close to the right" only when something is to the right', () => {
    expect(enabled(abc(), 'a')).toContain('closeRight');
    expect(enabled(abc(), 'c')).not.toContain('closeRight');
  });

  it('offers unpin on a pinned tab, and pin on a loose one', () => {
    expect(enabled(setPinned(abc(), 'a', true), 'a')).toContain('unpin');
    expect(enabled(abc(), 'a')).toContain('pin');
  });

  it('offers the reopen entry only once something has been closed', () => {
    expect(enabled(abc(), 'a')).not.toContain('reopenClosed');
    expect(enabled(closeTab(abc(), 'b'), 'a')).toContain('reopenClosed');
  });

  it('applies every verb it claims to own', () => {
    const state = setDirty(abc(), 'b', true);
    for (const item of tabMenuItems(state, 'a')) {
      const next = applyTabMenuAction(state, item.action, 'a');
      if (item.action === 'copyPath' || item.action === 'splitRight') {
        // Escalated to the component, deliberately — see the doc comment.
        expect(next).toBeNull();
      } else {
        expect(next).not.toBeNull();
        expectInvariants(next!);
      }
    }
  });
});

// ─── Drag payloads ───────────────────────────────────────────────────────────

describe('drag payloads from the tree', () => {
  it('reads a JSON array of ids', () => {
    expect(parseTestIds('["a","b"]')).toEqual(['a', 'b']);
  });

  it('reads a single bare id, quoted or not', () => {
    expect(parseTestIds('"a"')).toEqual(['a']);
    expect(parseTestIds('cme1abc')).toEqual(['cme1abc']);
  });

  it('reads a newline- or comma-separated list', () => {
    expect(parseTestIds('a\nb\n')).toEqual(['a', 'b']);
    expect(parseTestIds('a, b')).toEqual(['a', 'b']);
  });

  it('drops blanks, duplicates and non-strings so the caller need not', () => {
    expect(parseTestIds('["a","","a","b",3,null]')).toEqual(['a', 'b']);
    expect(parseTestIds('   ')).toEqual([]);
    expect(parseTestIds('{"id":"a"}')).toEqual([]);
  });
});

describe('what a drag over the strip is', () => {
  it('recognises the strip\u2019s own tabs and the explorer\u2019s rows', () => {
    expect(dragKindFor([TAB_DRAG_MIME, 'text/plain'])).toBe('tab');
    expect(dragKindFor([TREE_DRAG_MIME, 'text/plain'])).toBe('tests');
  });

  /*
   * The defect this exists to pin down: `text/plain` rides along on every drag
   * there is — prose selected in another application, a link, a word dragged
   * from the page below. Treating it as a row drag made the strip promise a
   * drop it had no ids to honour.
   */
  /*
   * The strip declares the explorer's MIME type rather than importing it, so
   * that this module stays loadable without the tree panel's hook. This is the
   * guard on that copy: if the explorer ever changes its dialect, the strip
   * would quietly refuse every row drag, and the failure would show up as "drag
   * and drop stopped working" rather than as a broken build.
   */
  it('speaks the same dialect the explorer writes', () => {
    expect(TREE_DRAG_MIME).toBe(TREE_DRAG_MIME_FROM_THE_TREE);
  });

  it('refuses a bare text drag from anywhere else', () => {
    expect(dragKindFor(['text/plain'])).toBeNull();
    expect(dragKindFor(['text/plain', 'text/html', 'text/uri-list'])).toBeNull();
    expect(dragKindFor(['Files'])).toBeNull();
    expect(dragKindFor([])).toBeNull();
  });
});

// ─── The name a tab is announced by ──────────────────────────────────────────

describe('the accessible name of a tab', () => {
  const tab = (extra: Partial<{ preview: boolean; pinned: boolean; dirty: boolean }> = {}) => ({
    id: 'a',
    path: path('a'),
    label: 'a.spec.ts',
    preview: false,
    pinned: false,
    dirty: false,
    ...extra,
  });

  it('is the filename, and nothing else, on a plain tab', () => {
    expect(tabAccessibleName(tab())).toBe('a.spec.ts');
  });

  it('says the states that are otherwise carried by italics, a glyph or a dot', () => {
    expect(tabAccessibleName(tab({ preview: true }))).toBe('a.spec.ts, preview');
    expect(tabAccessibleName(tab({ pinned: true }))).toBe('a.spec.ts, pinned');
    expect(tabAccessibleName(tab({ dirty: true }))).toBe('a.spec.ts, unsaved changes');
    expect(tabAccessibleName(tab({ pinned: true, dirty: true }))).toBe(
      'a.spec.ts, pinned, unsaved changes',
    );
  });

  it('never repeats the close button\u2019s own name', () => {
    expect(tabAccessibleName(tab({ dirty: true }))).not.toContain('Close');
  });
});

// ─── (24) The splitter's arithmetic ──────────────────────────────────────────

describe('the split view geometry', () => {
  it('never squeezes a pane below the minimum', () => {
    expect(clampRatio(0)).toBe(MIN_PANE);
    expect(clampRatio(1)).toBe(1 - MIN_PANE);
    expect(clampRatio(0.42)).toBe(0.42);
  });

  it('survives the values a layout pass produces before it has a size', () => {
    // A value that is not a number at all has no honest clamp, so both come
    // back as the midpoint rather than as an edge the user did not drag to.
    expect(clampRatio(Number.NaN)).toBe(0.5);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
    expect(ratioFromPointer(120, 0, 0)).toBe(0.5);
  });

  it('turns a pointer position into a ratio of the container', () => {
    expect(ratioFromPointer(300, 100, 400)).toBeCloseTo(0.5, 6);
    expect(ratioFromPointer(200, 100, 400)).toBeCloseTo(0.25, 6);
    // Dragged past the edge, it stops at the minimum rather than collapsing.
    expect(ratioFromPointer(-500, 100, 400)).toBe(MIN_PANE);
  });

  /*
   * The splitter is `shrink-0`, so the two panes divide `width - SPLITTER_SIZE`
   * between them and pane 0's edge sits at `ratio * (width - SPLITTER_SIZE)`.
   * Dividing by the full width instead let the rule slide away from the pointer
   * dragging it — by nothing in the middle and by the whole gutter at the ends.
   */
  it('leaves the splitter out of the space the panes divide', () => {
    const width = 405;
    const gutter = SPLITTER_SIZE;
    // The pointer grabs the middle of the rule, so a ratio of r puts it at
    // r * (width - gutter) + gutter / 2 from the container's left edge.
    for (const target of [0.25, 0.5, 0.75]) {
      const pointer = 100 + target * (width - gutter) + gutter / 2;
      expect(ratioFromPointer(pointer, 100, width, gutter)).toBeCloseTo(target, 6);
    }
  });

  it('is exact at the ends, where the old arithmetic was worst', () => {
    const width = 405;
    // Hard against the right-hand edge: the pointer is half a rule short of the
    // container's own edge, and that has to read as "all the way over".
    expect(ratioFromPointer(505 - SPLITTER_SIZE / 2, 100, width, SPLITTER_SIZE)).toBe(1 - MIN_PANE);
    expect(ratioFromPointer(100 + SPLITTER_SIZE / 2, 100, width, SPLITTER_SIZE)).toBe(MIN_PANE);
  });

  it('still answers with the midpoint when the box is smaller than its own rule', () => {
    expect(ratioFromPointer(120, 0, SPLITTER_SIZE, SPLITTER_SIZE)).toBe(0.5);
    expect(ratioFromPointer(120, 0, 2, SPLITTER_SIZE)).toBe(0.5);
  });

  it('nudges on both axes and leaves other keys to the browser', () => {
    expect(nudgeRatio(0.5, 'ArrowLeft')).toBeCloseTo(0.48, 6);
    expect(nudgeRatio(0.5, 'ArrowUp')).toBeCloseTo(0.48, 6);
    expect(nudgeRatio(0.5, 'ArrowRight')).toBeCloseTo(0.52, 6);
    expect(nudgeRatio(0.5, 'ArrowDown')).toBeCloseTo(0.52, 6);
    expect(nudgeRatio(0.5, 'ArrowRight', true)).toBeCloseTo(0.6, 6);
    expect(nudgeRatio(0.5, 'Home')).toBe(MIN_PANE);
    expect(nudgeRatio(0.5, 'End')).toBe(1 - MIN_PANE);
    expect(nudgeRatio(0.3, 'Enter')).toBe(0.5);
    expect(nudgeRatio(0.5, 'Tab')).toBeNull();
    expect(nudgeRatio(0.5, 'a')).toBeNull();
  });

  it('a nudge at the edge stops rather than passing it', () => {
    expect(nudgeRatio(MIN_PANE, 'ArrowLeft')).toBe(MIN_PANE);
    expect(nudgeRatio(1 - MIN_PANE, 'ArrowRight')).toBe(1 - MIN_PANE);
  });
});

// ─── Nothing here mutates ────────────────────────────────────────────────────

describe('immutability', () => {
  it('leaves the state it was given alone', () => {
    const before = abc();
    const snapshot = JSON.stringify(before);
    closeAllTabs(before);
    moveTab(before, 'a', 2);
    setPinned(before, 'a', true);
    setDirty(before, 'a', true);
    cycleTabs(before, 1);
    reopenClosedTab(closeTab(before, 'a'));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
