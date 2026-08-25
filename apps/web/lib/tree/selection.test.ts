import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  NO_TYPE_AHEAD,
  TYPE_AHEAD_MS,
  allSelectedIds,
  applyClick,
  clearSelection,
  extendSelection,
  handleKey,
  hiddenSelectionCount,
  isPathless,
  rangeIds,
  reconcileSelection,
  selectAll,
  selectOnly,
  selectedIds,
  toggleSelected,
  type ClickModifiers,
  type KeyEventLike,
  type SelectionState,
  type TreeRow,
} from './selection';

/**
 * A row built from its path, so the fixtures read as the tree they describe.
 * Folder ids are path-derived and file ids are test ids — the same split the
 * real flattener makes.
 */
function file(path: string): TreeRow {
  const slash = path.lastIndexOf('/');
  return {
    id: `t:${path}`,
    kind: 'file',
    name: slash === -1 ? path : path.slice(slash + 1),
    path,
    parentPath: slash === -1 ? '' : path.slice(0, slash),
    depth: path.split('/').length - 1,
  };
}

function dir(path: string, expanded: boolean): TreeRow {
  const slash = path.lastIndexOf('/');
  return {
    id: `d:${path}`,
    kind: 'dir',
    name: slash === -1 ? path : path.slice(slash + 1),
    path,
    parentPath: slash === -1 ? '' : path.slice(0, slash),
    depth: path.split('/').length - 1,
    expanded,
  };
}

/**
 * checkout/ is open, fixtures/ is closed — so `fixtures/users.json` is in the
 * tree but NOT in this list, which is the distinction every function here turns
 * on.
 */
const ROWS: TreeRow[] = [
  dir('checkout', true),
  file('checkout/cart.spec.ts'),
  file('checkout/order.spec.ts'),
  dir('fixtures', false),
  file('login.spec.ts'),
];

const CHECKOUT = 'd:checkout';
const CART = 't:checkout/cart.spec.ts';
const ORDER = 't:checkout/order.spec.ts';
const FIXTURES = 'd:fixtures';
const LOGIN = 't:login.spec.ts';

const sel = (ids: string[], anchor: string | null, lead: string | null): SelectionState => ({
  ids: new Set(ids),
  anchor,
  lead,
});

const ids = (state: SelectionState): string[] => selectedIds(ROWS, state);

describe('applyClick', () => {
  it('replaces the selection on a plain click', () => {
    const state = applyClick(ROWS, sel([CART, ORDER], CART, ORDER), LOGIN);
    expect(ids(state)).toEqual([LOGIN]);
    expect(state.anchor).toBe(LOGIN);
    expect(state.lead).toBe(LOGIN);
  });

  const modifierCases: Array<[string, ClickModifiers]> = [
    ['meta', { meta: true }],
    ['ctrl', { ctrl: true }],
  ];
  it.each(modifierCases)('toggles one row on %s-click, leaving the rest', (_name, mods) => {
    const added = applyClick(ROWS, sel([CART], CART, CART), LOGIN, mods);
    expect(ids(added)).toEqual([CART, LOGIN]);

    const removed = applyClick(ROWS, added, CART, mods);
    expect(ids(removed)).toEqual([LOGIN]);
    // The anchor follows the row you clicked even when the click deselected it.
    expect(removed.anchor).toBe(CART);
  });

  it('extends from the anchor on shift-click', () => {
    const start = applyClick(ROWS, EMPTY_SELECTION, CHECKOUT);
    const state = applyClick(ROWS, start, ORDER, { shift: true });
    expect(ids(state)).toEqual([CHECKOUT, CART, ORDER]);
    expect(state.anchor).toBe(CHECKOUT);
    expect(state.lead).toBe(ORDER);
  });

  it('extends upwards too', () => {
    const start = applyClick(ROWS, EMPTY_SELECTION, LOGIN);
    const state = applyClick(ROWS, start, CART, { shift: true });
    expect(ids(state)).toEqual([CART, ORDER, FIXTURES, LOGIN]);
  });

  /*
   * The bug this whole anchor/lead split exists to prevent. A model with one
   * "last clicked" field measures the second shift-click from the first one's
   * TARGET, so the range only ever grows and the user cannot take rows back out
   * of it by shift-clicking closer to where they started.
   */
  it('re-extends from the ORIGINAL anchor on a second shift-click, so the range can shrink', () => {
    const start = applyClick(ROWS, EMPTY_SELECTION, CHECKOUT);
    const wide = applyClick(ROWS, start, LOGIN, { shift: true });
    expect(ids(wide)).toEqual([CHECKOUT, CART, ORDER, FIXTURES, LOGIN]);

    const narrow = applyClick(ROWS, wide, CART, { shift: true });
    expect(ids(narrow)).toEqual([CHECKOUT, CART]);
    expect(narrow.anchor).toBe(CHECKOUT);
  });

  it('keeps the existing selection on ctrl+shift-click', () => {
    const state = applyClick(ROWS, sel([LOGIN], CHECKOUT, LOGIN), CART, { shift: true, meta: true });
    expect(ids(state)).toEqual([CHECKOUT, CART, LOGIN]);
  });

  it('ignores a click on a row that is not in the list', () => {
    const before = sel([CART], CART, CART);
    expect(applyClick(ROWS, before, 't:gone.spec.ts')).toBe(before);
  });

  it('returns the same object when the click changes nothing', () => {
    const before = selectOnly(EMPTY_SELECTION, CART);
    expect(applyClick(ROWS, before, CART)).toBe(before);
  });
});

describe('extendSelection without a usable anchor', () => {
  it('starts a fresh range when there is no anchor', () => {
    const state = extendSelection(ROWS, EMPTY_SELECTION, ORDER);
    expect(ids(state)).toEqual([ORDER]);
    expect(state.anchor).toBe(ORDER);
  });

  /*
   * The anchored row was collapsed away or deleted. Measuring a range to an
   * index we cannot see would sweep in rows the user never pointed at, so the
   * range restarts at the target instead.
   */
  it('starts a fresh range when the anchor is no longer visible', () => {
    const state = extendSelection(ROWS, sel([], 't:fixtures/users.json', null), ORDER);
    expect(ids(state)).toEqual([ORDER]);
    expect(state.anchor).toBe(ORDER);
  });

  it('ignores an extend to a row that is not in the list', () => {
    const before = sel([CART], CART, CART);
    expect(extendSelection(ROWS, before, 't:gone.spec.ts')).toBe(before);
  });
});

describe('rangeIds', () => {
  const rangeCases: Array<[string, string, string, string[]]> = [
    ['downwards', CHECKOUT, ORDER, [CHECKOUT, CART, ORDER]],
    ['upwards', ORDER, CHECKOUT, [CHECKOUT, CART, ORDER]],
    ['one row', CART, CART, [CART]],
    ['whole list', CHECKOUT, LOGIN, [CHECKOUT, CART, ORDER, FIXTURES, LOGIN]],
  ];
  it.each(rangeCases)('%s', (_name, from, to, expected) => {
    expect(rangeIds(ROWS, from, to)).toEqual(expected);
  });

  it.each([
    ['from missing', 'nope', CART],
    ['to missing', CART, 'nope'],
    ['both missing', 'nope', 'also-nope'],
  ])('is empty when %s', (_name, from, to) => {
    expect(rangeIds(ROWS, from, to)).toEqual([]);
  });

  it('is empty over an empty list', () => {
    expect(rangeIds([], CART, CART)).toEqual([]);
  });
});

describe('selection survives a rebuild', () => {
  /*
   * The reason nothing here is index-based. A poll rebuilds the list with a new
   * file at the top; every index shifts by one, and an index-based selection
   * would now point at different files — including for the next Delete.
   */
  it('holds by identity when rows shift', () => {
    const state = sel([CART, LOGIN], CART, LOGIN);
    const rebuilt = [file('aaa.spec.ts'), ...ROWS];
    expect(selectedIds(rebuilt, state)).toEqual([CART, LOGIN]);
  });

  it('keeps ids that are merely hidden inside a collapsed folder', () => {
    const state = sel([CART, 't:fixtures/users.json'], CART, CART);
    const live = [...ROWS.map((row) => row.id), 't:fixtures/users.json'];
    expect([...reconcileSelection(state, live).ids].sort()).toEqual(
      [CART, 't:fixtures/users.json'].sort(),
    );
  });

  it('drops ids that have genuinely gone, and the anchor and lead with them', () => {
    const state = sel([CART, ORDER], ORDER, ORDER);
    const next = reconcileSelection(state, [CART, LOGIN]);
    expect([...next.ids]).toEqual([CART]);
    expect(next.anchor).toBeNull();
    expect(next.lead).toBeNull();
  });

  it('returns the same object when everything survived', () => {
    const state = sel([CART], CART, CART);
    expect(reconcileSelection(state, ROWS.map((row) => row.id))).toBe(state);
  });

  it('empties cleanly when the whole tree went away', () => {
    const next = reconcileSelection(sel([CART], CART, CART), []);
    expect(next.ids.size).toBe(0);
  });
});

describe('selectedRows / selectAll / clear', () => {
  it('returns rows in visible order regardless of the order they were selected', () => {
    expect(ids(sel([LOGIN, CHECKOUT, ORDER], LOGIN, ORDER))).toEqual([CHECKOUT, ORDER, LOGIN]);
  });

  it('selects everything visible, anchored at the first row', () => {
    const state = selectAll(ROWS, EMPTY_SELECTION);
    expect(ids(state)).toEqual([CHECKOUT, CART, ORDER, FIXTURES, LOGIN]);
    expect(state.anchor).toBe(CHECKOUT);
    expect(state.lead).toBe(LOGIN);
  });

  it('leaves an empty list alone', () => {
    expect(selectAll([], EMPTY_SELECTION)).toBe(EMPTY_SELECTION);
  });

  it('clears to the shared empty state', () => {
    expect(clearSelection(sel([CART], CART, CART)).ids.size).toBe(0);
    expect(clearSelection(EMPTY_SELECTION)).toBe(EMPTY_SELECTION);
  });

  it('toggling the last selected row leaves the lead on it', () => {
    const state = toggleSelected(sel([CART], CART, CART), CART);
    expect(state.ids.size).toBe(0);
    expect(state.lead).toBe(CART);
  });
});

// ─── Keyboard ────────────────────────────────────────────────────────────────

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: k, ...mods });

describe('handleKey — moving', () => {
  it.each([
    ['ArrowDown from the top', 'ArrowDown', CHECKOUT, CART],
    ['ArrowDown into a collapsed folder row', 'ArrowDown', ORDER, FIXTURES],
    ['ArrowUp', 'ArrowUp', ORDER, CART],
    ['Home', 'Home', ORDER, CHECKOUT],
    ['End', 'End', CHECKOUT, LOGIN],
  ])('%s', (_name, k, from, expected) => {
    const result = handleKey(ROWS, selectOnly(EMPTY_SELECTION, from), key(k));
    expect(result.handled).toBe(true);
    expect(result.selection.lead).toBe(expected);
    expect(result.reveal).toBe(expected);
    expect(ids(result.selection)).toEqual([expected]);
  });

  it.each([
    ['down enters at the top', 'ArrowDown', CHECKOUT],
    ['up enters at the bottom', 'ArrowUp', LOGIN],
  ])('with no lead, %s', (_name, k, expected) => {
    const result = handleKey(ROWS, EMPTY_SELECTION, key(k));
    expect(result.selection.lead).toBe(expected);
  });

  /*
   * A lead inside a folder the user just collapsed is not a position in this
   * list, so the arrow re-enters the list from its end rather than staying put
   * or throwing the cursor at index 0 for BOTH directions.
   */
  it('re-enters the list when the lead was collapsed away', () => {
    const hidden = selectOnly(EMPTY_SELECTION, 't:fixtures/users.json');
    expect(handleKey(ROWS, hidden, key('ArrowUp')).selection.lead).toBe(LOGIN);
    expect(handleKey(ROWS, hidden, key('ArrowDown')).selection.lead).toBe(CHECKOUT);
  });

  it.each([
    ['down at the last row', 'ArrowDown', LOGIN],
    ['up at the first row', 'ArrowUp', CHECKOUT],
  ])('clamps %s but still claims the key', (_name, k, from) => {
    const result = handleKey(ROWS, selectOnly(EMPTY_SELECTION, from), key(k));
    expect(result.handled).toBe(true);
    expect(result.selection.lead).toBe(from);
  });

  it.each(['ArrowDown', 'ArrowUp', 'Home', 'End'])('claims %s over an empty list', (k) => {
    const result = handleKey([], EMPTY_SELECTION, key(k));
    expect(result.handled).toBe(true);
    expect(result.reveal).toBeNull();
  });
});

describe('handleKey — shift-arrows extend from the anchor', () => {
  it('grows the range', () => {
    const start = selectOnly(EMPTY_SELECTION, CHECKOUT);
    const one = handleKey(ROWS, start, key('ArrowDown', { shiftKey: true })).selection;
    const two = handleKey(ROWS, one, key('ArrowDown', { shiftKey: true })).selection;
    expect(ids(two)).toEqual([CHECKOUT, CART, ORDER]);
    expect(two.anchor).toBe(CHECKOUT);
  });

  /*
   * The off-by-one that a range built by accumulating ids never catches:
   * reversing direction has to SHRINK the range back towards the anchor, not add
   * the row above it.
   */
  it('shrinks the range when the direction reverses', () => {
    let state = selectOnly(EMPTY_SELECTION, CHECKOUT);
    state = handleKey(ROWS, state, key('ArrowDown', { shiftKey: true })).selection;
    state = handleKey(ROWS, state, key('ArrowDown', { shiftKey: true })).selection;
    state = handleKey(ROWS, state, key('ArrowUp', { shiftKey: true })).selection;
    expect(ids(state)).toEqual([CHECKOUT, CART]);
  });

  it('crosses the anchor and re-forms the range on the other side', () => {
    let state = selectOnly(EMPTY_SELECTION, ORDER);
    state = handleKey(ROWS, state, key('ArrowUp', { shiftKey: true })).selection;
    state = handleKey(ROWS, state, key('ArrowUp', { shiftKey: true })).selection;
    expect(ids(state)).toEqual([CHECKOUT, CART, ORDER]);
    state = handleKey(ROWS, state, key('ArrowDown', { shiftKey: true })).selection;
    expect(ids(state)).toEqual([CART, ORDER]);
  });

  it('extends to the end with shift+End', () => {
    const state = handleKey(
      ROWS,
      selectOnly(EMPTY_SELECTION, ORDER),
      key('End', { shiftKey: true }),
    ).selection;
    expect(ids(state)).toEqual([ORDER, FIXTURES, LOGIN]);
  });
});

describe('handleKey — left and right', () => {
  it('collapses an open folder', () => {
    const result = handleKey(ROWS, selectOnly(EMPTY_SELECTION, CHECKOUT), key('ArrowLeft'));
    expect(result.action).toEqual({ kind: 'collapse', id: CHECKOUT, path: 'checkout' });
    expect(result.selection.lead).toBe(CHECKOUT);
  });

  it('steps out to the parent from a closed folder', () => {
    const rows = [dir('fixtures', true), dir('fixtures/api', false), file('fixtures/api/u.json')];
    const result = handleKey(rows, selectOnly(EMPTY_SELECTION, 'd:fixtures/api'), key('ArrowLeft'));
    expect(result.action).toBeNull();
    expect(result.selection.lead).toBe('d:fixtures');
  });

  it('steps out to the parent from a file', () => {
    const result = handleKey(ROWS, selectOnly(EMPTY_SELECTION, CART), key('ArrowLeft'));
    expect(result.selection.lead).toBe(CHECKOUT);
  });

  it('does nothing at the root, and still claims the key', () => {
    const result = handleKey(ROWS, selectOnly(EMPTY_SELECTION, LOGIN), key('ArrowLeft'));
    expect(result.handled).toBe(true);
    expect(result.selection.lead).toBe(LOGIN);
    expect(result.action).toBeNull();
  });

  it('expands a closed folder', () => {
    const result = handleKey(ROWS, selectOnly(EMPTY_SELECTION, FIXTURES), key('ArrowRight'));
    expect(result.action).toEqual({ kind: 'expand', id: FIXTURES, path: 'fixtures' });
  });

  it('steps into the first child of an open folder', () => {
    const result = handleKey(ROWS, selectOnly(EMPTY_SELECTION, CHECKOUT), key('ArrowRight'));
    expect(result.selection.lead).toBe(CART);
  });

  /*
   * An open but EMPTY folder's next row belongs to someone else. Treating "the
   * row after me" as "my first child" would jump the cursor to a sibling and
   * look like → skipped a row.
   */
  it('does not step into an open folder that has no children', () => {
    const rows = [dir('empty', true), file('login.spec.ts')];
    const result = handleKey(rows, selectOnly(EMPTY_SELECTION, 'd:empty'), key('ArrowRight'));
    expect(result.selection.lead).toBe('d:empty');
    expect(result.action).toBeNull();
  });

  it('does nothing on a file', () => {
    const result = handleKey(ROWS, selectOnly(EMPTY_SELECTION, LOGIN), key('ArrowRight'));
    expect(result.handled).toBe(true);
    expect(result.action).toBeNull();
  });
});

describe('handleKey — actions', () => {
  it('opens a file on Enter', () => {
    expect(handleKey(ROWS, selectOnly(EMPTY_SELECTION, CART), key('Enter')).action).toEqual({
      kind: 'open',
      id: CART,
    });
  });

  it.each([
    ['open', CHECKOUT, 'collapse', 'checkout'],
    ['closed', FIXTURES, 'expand', 'fixtures'],
  ])('toggles a %s folder on Enter', (_name, id, kind, path) => {
    expect(handleKey(ROWS, selectOnly(EMPTY_SELECTION, id), key('Enter')).action).toEqual({
      kind,
      id,
      path,
    });
  });

  it('renames the lead on F2', () => {
    expect(handleKey(ROWS, selectOnly(EMPTY_SELECTION, CART), key('F2')).action).toEqual({
      kind: 'rename',
      id: CART,
    });
  });

  it.each(['Delete', 'Backspace'])('deletes the whole selection on %s, in visible order', (k) => {
    const state = sel([LOGIN, CART], CART, LOGIN);
    expect(handleKey(ROWS, state, key(k)).action).toEqual({ kind: 'delete', ids: [CART, LOGIN] });
  });

  it('falls back to the lead when nothing is selected', () => {
    const state: SelectionState = { ids: new Set(), anchor: null, lead: CART };
    expect(handleKey(ROWS, state, key('Delete')).action).toEqual({ kind: 'delete', ids: [CART] });
  });

  it('has nothing to delete with no selection and no lead', () => {
    expect(handleKey(ROWS, EMPTY_SELECTION, key('Delete')).action).toBeNull();
  });

  it('selects everything on ctrl/meta+A', () => {
    expect(ids(handleKey(ROWS, EMPTY_SELECTION, key('a', { metaKey: true })).selection)).toEqual([
      CHECKOUT,
      CART,
      ORDER,
      FIXTURES,
      LOGIN,
    ]);
  });

  it.each(['x', 'c', 'v'])('leaves cmd+%s for the clipboard module', (k) => {
    expect(handleKey(ROWS, EMPTY_SELECTION, key(k, { metaKey: true })).handled).toBe(false);
  });
});

describe('handleKey — type to select', () => {
  const type = (
    state: SelectionState,
    k: string,
    at: number,
    query = '',
    queryAt = 0,
  ) =>
    handleKey(ROWS, state, key(k), { typeAhead: { query, at: queryAt }, now: at });

  it('jumps to the first row starting with the letter', () => {
    const result = type(EMPTY_SELECTION, 'l', 1000);
    expect(result.selection.lead).toBe(LOGIN);
    expect(result.reveal).toBe(LOGIN);
    expect(result.typeAhead).toEqual({ query: 'l', at: 1000 });
  });

  it('matches case-insensitively', () => {
    expect(type(EMPTY_SELECTION, 'L', 1000).selection.lead).toBe(LOGIN);
  });

  /*
   * A fresh buffer searches from AFTER the current row, so pressing the same
   * letter again walks to the next match instead of sticking on the first.
   */
  it('cycles through matches when the same letter is pressed after the buffer expires', () => {
    const first = type(EMPTY_SELECTION, 'c', 1000);
    expect(first.selection.lead).toBe(CHECKOUT);
    const second = type(first.selection, 'c', 1000 + TYPE_AHEAD_MS + 1, 'c', 1000);
    expect(second.selection.lead).toBe(CART);
  });

  it('wraps past the end of the list', () => {
    const state = selectOnly(EMPTY_SELECTION, LOGIN);
    expect(type(state, 'c', 1000).selection.lead).toBe(CHECKOUT);
  });

  /*
   * A GROWING query re-searches from the current row inclusive, so typing
   * "c-h-e" stays on `checkout` instead of hopping to the next `c…` on the
   * second keystroke and losing the row it had already found.
   */
  it('keeps the row it already matched as the query grows', () => {
    const first = type(EMPTY_SELECTION, 'c', 1000);
    const second = type(first.selection, 'h', 1200, 'c', 1000);
    expect(second.typeAhead.query).toBe('ch');
    expect(second.selection.lead).toBe(CHECKOUT);
  });

  it('starts a new query once the buffer has expired', () => {
    const result = type(selectOnly(EMPTY_SELECTION, CHECKOUT), 'l', 2000, 'ch', 2000 - TYPE_AHEAD_MS - 1);
    expect(result.typeAhead.query).toBe('l');
    expect(result.selection.lead).toBe(LOGIN);
  });

  it('keeps the buffer but moves nothing when nothing matches', () => {
    const before = selectOnly(EMPTY_SELECTION, CART);
    const result = type(before, 'z', 1000);
    expect(result.handled).toBe(true);
    expect(result.selection).toBe(before);
    expect(result.reveal).toBeNull();
    expect(result.typeAhead).toEqual({ query: 'z', at: 1000 });
  });

  it('searches from the top when the lead is not in the list', () => {
    const hidden = selectOnly(EMPTY_SELECTION, 't:fixtures/users.json');
    expect(type(hidden, 'c', 1000).selection.lead).toBe(CHECKOUT);
  });

  /*
   * Leading space can never match a filename, and claiming it would cost the
   * pane its page-scroll for a keystroke that does nothing. Mid-query it is a
   * real character.
   */
  it('ignores a leading space but accepts one inside a query', () => {
    expect(type(EMPTY_SELECTION, ' ', 1000).handled).toBe(false);
    const rows = [file('order total.spec.ts'), file('other.spec.ts')];
    const result = handleKey(rows, EMPTY_SELECTION, key(' '), {
      typeAhead: { query: 'order', at: 1000 },
      now: 1100,
    });
    expect(result.typeAhead.query).toBe('order ');
    expect(result.selection.lead).toBe('t:order total.spec.ts');
  });

  const comboCases: Array<[string, Partial<KeyEventLike>]> = [
    ['alt', { altKey: true }],
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
  ];
  it.each(comboCases)('does not treat %s+letter as typing', (_name, mods) => {
    expect(handleKey(ROWS, EMPTY_SELECTION, key('z', mods), { now: 1000 }).handled).toBe(false);
  });

  it('is reset by a movement key, so the next letter starts fresh', () => {
    const result = handleKey(ROWS, selectOnly(EMPTY_SELECTION, CART), key('ArrowDown'), {
      typeAhead: { query: 'ca', at: 1000 },
      now: 1100,
    });
    expect(result.typeAhead).toBe(NO_TYPE_AHEAD);
  });

  it('is cleared by Escape, which is otherwise left alone', () => {
    const running = handleKey(ROWS, EMPTY_SELECTION, key('Escape'), {
      typeAhead: { query: 'ca', at: 1000 },
      now: 1100,
    });
    expect(running.handled).toBe(true);
    expect(running.typeAhead).toBe(NO_TYPE_AHEAD);
    expect(handleKey(ROWS, EMPTY_SELECTION, key('Escape')).handled).toBe(false);
  });

  it('does nothing over an empty list', () => {
    const result = handleKey([], EMPTY_SELECTION, key('c'), { now: 1000 });
    expect(result.selection).toBe(EMPTY_SELECTION);
    expect(result.reveal).toBeNull();
  });
});

// ─── What is selected vs what is on screen ───────────────────────────────────

/*
 * The gap this closes. `reconcileSelection` keeps an id whose folder was
 * collapsed — on purpose, so collapsing a folder is not a way to silently
 * deselect its contents — but every reader in this file works off the VISIBLE
 * rows, so `selectedIds` could not see it. A bulk delete planned from that list
 * acted on fewer files than the toolbar had been counting, and said nothing.
 */
describe('a selection that outlives its rows', () => {
  const HIDDEN = 't:fixtures/users.json';
  const state = sel([CART, HIDDEN, LOGIN], CART, LOGIN);

  it('selectedIds answers what is on screen', () => {
    expect(selectedIds(ROWS, state)).toEqual([CART, LOGIN]);
  });

  it('allSelectedIds answers what is selected — visible order first, then the rest', () => {
    expect(allSelectedIds(ROWS, state)).toEqual([CART, LOGIN, HIDDEN]);
  });

  it('counts the shortfall so the UI can say it out loud', () => {
    expect(hiddenSelectionCount(ROWS, state)).toBe(1);
    expect(hiddenSelectionCount(ROWS, sel([CART], CART, CART))).toBe(0);
    expect(hiddenSelectionCount([], state)).toBe(3);
  });

  it('deletes every selected row, not only the ones being drawn', () => {
    const action = handleKey(ROWS, state, key('Delete')).action;
    expect(action).toEqual({ kind: 'delete', ids: [CART, LOGIN, HIDDEN] });
  });

  it('is unchanged when nothing is hidden', () => {
    const plain = sel([CART, LOGIN], CART, LOGIN);
    expect(allSelectedIds(ROWS, plain)).toEqual(selectedIds(ROWS, plain));
  });
});

// ─── Keyboard gestures that had no coverage ──────────────────────────────────

describe('handleKey — shift+Home and shift+End', () => {
  it('extends to the top of the list with shift+Home', () => {
    const state = handleKey(
      ROWS,
      selectOnly(EMPTY_SELECTION, ORDER),
      key('Home', { shiftKey: true }),
    ).selection;
    expect(ids(state)).toEqual([CHECKOUT, CART, ORDER]);
    expect(state.anchor).toBe(ORDER);
    expect(state.lead).toBe(CHECKOUT);
  });

  /* Home and End are a pair; the anchor holds still for both. */
  it('sweeps the whole list when Home follows End', () => {
    let state = selectOnly(EMPTY_SELECTION, ORDER);
    state = handleKey(ROWS, state, key('End', { shiftKey: true })).selection;
    expect(ids(state)).toEqual([ORDER, FIXTURES, LOGIN]);
    state = handleKey(ROWS, state, key('Home', { shiftKey: true })).selection;
    expect(ids(state)).toEqual([CHECKOUT, CART, ORDER]);
  });
});

/*
 * ⌘/Ctrl+Shift+arrow is the keyboard half of ⌘-shift-CLICK, and it was routed to
 * the plain extend — so building a selection with ⌘-clicks and then extending it
 * from the keyboard threw the ⌘-clicked rows away. The mouse and the keyboard
 * have to mean the same thing by the same two modifiers.
 */
describe('handleKey — additive shift-arrows', () => {
  const additive: Array<[string, Partial<KeyEventLike>]> = [
    ['meta', { shiftKey: true, metaKey: true }],
    ['ctrl', { shiftKey: true, ctrlKey: true }],
  ];
  it.each(additive)('keeps the existing selection with %s+shift+arrow', (_name, mods) => {
    const start = sel([LOGIN], CART, CART);
    const state = handleKey(ROWS, start, key('ArrowDown', mods)).selection;
    expect(ids(state)).toEqual([CART, ORDER, LOGIN]);
    expect(state.anchor).toBe(CART);
    expect(state.lead).toBe(ORDER);
  });

  it('discards it without the modifier, which is what plain shift means', () => {
    const start = sel([LOGIN], CART, CART);
    const state = handleKey(ROWS, start, key('ArrowDown', { shiftKey: true })).selection;
    expect(ids(state)).toEqual([CART, ORDER]);
  });

  it('extends additively with Home and End too', () => {
    const start = sel([LOGIN], ORDER, ORDER);
    const state = handleKey(
      ROWS,
      start,
      key('Home', { shiftKey: true, metaKey: true }),
    ).selection;
    expect(ids(state)).toEqual([CHECKOUT, CART, ORDER, LOGIN]);
  });
});

// ─── Feature grouping ────────────────────────────────────────────────────────

/** A feature group: folder-shaped, with no path. See `rows.ts`. */
function group(name: string): TreeRow {
  return { id: `d:feature:${name}`, kind: 'dir', name, path: '', parentPath: '', depth: 0, expanded: true };
}

/*
 * `grouping: 'feature'` is a live mode, and its headings are the one row that
 * looks like a folder and is not: no path, and children that do not name it as
 * their parent. Every rule in this file that reached for a path had to be told.
 */
describe('rows with no path', () => {
  const FEATURE_ROWS: TreeRow[] = [
    group('Checkout'),
    file('checkout/cart.spec.ts'),
    group('Login'),
    file('login.spec.ts'),
  ];

  it('knows one when it sees one', () => {
    expect(isPathless(group('Checkout'))).toBe(true);
    expect(isPathless(dir('checkout', true))).toBe(false);
    expect(isPathless(file('login.spec.ts'))).toBe(false);
  });

  /*
   * The root has no row of its own, and `path === ''` matches a feature group.
   * ← from a root-level file used to jump the cursor into whichever heading
   * happened to be first, which is not its parent by any reading.
   */
  it('does not step ← from a root file into a feature group', () => {
    const result = handleKey(
      FEATURE_ROWS,
      selectOnly(EMPTY_SELECTION, 't:login.spec.ts'),
      key('ArrowLeft'),
    );
    expect(result.handled).toBe(true);
    expect(result.selection.lead).toBe('t:login.spec.ts');
    expect(result.action).toBeNull();
  });

  /*
   * And → still steps IN. A group's children keep their own filePath, so they
   * do not name the group as a parent; matching on paths refused to enter any
   * group at all. Depth is what the flattener actually promises.
   */
  it('steps → into a feature group', () => {
    const result = handleKey(
      FEATURE_ROWS,
      selectOnly(EMPTY_SELECTION, 'd:feature:Checkout'),
      key('ArrowRight'),
    );
    expect(result.selection.lead).toBe('t:checkout/cart.spec.ts');
  });

  it('still refuses to step → into an open group with nothing under it', () => {
    const rows = [group('Empty'), group('Login'), file('login.spec.ts')];
    const result = handleKey(rows, selectOnly(EMPTY_SELECTION, 'd:feature:Empty'), key('ArrowRight'));
    expect(result.selection.lead).toBe('d:feature:Empty');
    expect(result.action).toBeNull();
  });

  /*
   * F2 renames by writing a new filePath. A group has none, so the rename would
   * be computed against the project root — an edit the user never asked for on
   * files they cannot see from here. Claim the key, start nothing.
   */
  it('refuses to rename a feature group', () => {
    const result = handleKey(
      FEATURE_ROWS,
      selectOnly(EMPTY_SELECTION, 'd:feature:Checkout'),
      key('F2'),
    );
    expect(result.handled).toBe(true);
    expect(result.action).toBeNull();
  });

  it('still renames a file inside one', () => {
    const result = handleKey(
      FEATURE_ROWS,
      selectOnly(EMPTY_SELECTION, 't:checkout/cart.spec.ts'),
      key('F2'),
    );
    expect(result.action).toEqual({ kind: 'rename', id: 't:checkout/cart.spec.ts' });
  });

  it('still expands and collapses one — that costs no path', () => {
    const rows = [{ ...group('Checkout'), expanded: false }, file('login.spec.ts')];
    expect(handleKey(rows, selectOnly(EMPTY_SELECTION, 'd:feature:Checkout'), key('Enter')).action)
      .toEqual({ kind: 'expand', id: 'd:feature:Checkout', path: '' });
  });
});
