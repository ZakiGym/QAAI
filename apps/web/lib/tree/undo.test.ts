import { describe, expect, it } from 'vitest';
import {
  EMPTY_UNDO,
  UNDO_DEPTH,
  canRedo,
  canUndo,
  commitRedo,
  commitUndo,
  describeEdit,
  describeEntry,
  editForOp,
  entryForOps,
  invert,
  invertEntry,
  peekRedo,
  peekUndo,
  record,
  redoEdits,
  undoEdits,
  type TreeEdit,
  type UndoStack,
} from './undo';
import type { TreeOp } from './clipboard';

const MOVE: TreeEdit = { kind: 'move', id: 't1', from: 'checkout/a.ts', to: 'fixtures/a.ts' };
const CREATE: TreeEdit = { kind: 'create', id: 't2', path: 'checkout/b.ts', name: 'b.ts' };
const DELETE: TreeEdit = { kind: 'delete', id: 't3', path: 'checkout/c.ts', name: 'c.ts' };
const RESTORE: TreeEdit = { kind: 'restore', id: 't3', path: 'checkout/c.ts', name: 'c.ts' };

const entry = (...edits: TreeEdit[]) => ({ edits });

describe('invert', () => {
  const cases: Array<[string, TreeEdit, TreeEdit]> = [
    ['a move goes back the way it came', MOVE, { kind: 'move', id: 't1', from: 'fixtures/a.ts', to: 'checkout/a.ts' }],
    ['a create becomes a delete', CREATE, { kind: 'delete', id: 't2', path: 'checkout/b.ts', name: 'b.ts' }],
    ['a delete becomes a restore', DELETE, RESTORE],
    ['a restore becomes a delete', RESTORE, DELETE],
  ];
  it.each(cases)('%s', (_name, edit, expected) => {
    expect(invert(edit)).toEqual(expected);
  });

  /* Inverting twice has to land exactly where it started, or redo drifts. */
  it.each([MOVE, DELETE, RESTORE])('is its own inverse for %o', (edit) => {
    expect(invert(invert(edit))).toEqual(edit);
  });

  /*
   * The documented exception. A create inverts to a soft delete, and the inverse
   * of THAT is a restore rather than a second create — creating again would fork
   * a file that still exists under the same id. It addresses the same file at
   * the same path, and settles into a delete/restore pair that never drifts.
   */
  it('settles a create into the delete/restore pair rather than re-creating', () => {
    const once = invert(CREATE);
    const twice = invert(once);
    expect(once).toEqual({ kind: 'delete', id: 't2', path: 'checkout/b.ts', name: 'b.ts' });
    expect(twice).toEqual({ kind: 'restore', id: 't2', path: 'checkout/b.ts', name: 'b.ts' });
    expect(invert(invert(twice))).toEqual(twice);
  });

  it('carries the display name back with a rename', () => {
    const rename: TreeEdit = {
      kind: 'move',
      id: 't1',
      from: 'checkout/a.ts',
      to: 'checkout/b.ts',
      fromName: 'A',
      toName: 'B',
    };
    expect(invert(rename)).toEqual({
      kind: 'move',
      id: 't1',
      from: 'checkout/b.ts',
      to: 'checkout/a.ts',
      fromName: 'B',
      toName: 'A',
    });
  });

  /*
   * The delete record keeps the path even though `POST …/restore` only needs the
   * id: restore REFUSES when something has taken the old path since, and a
   * caller holding the path can name the file that is in the way instead of
   * surfacing a bare 409.
   */
  it('keeps enough of a delete to explain a refused restore', () => {
    const back = invert(DELETE);
    expect(back).toMatchObject({ kind: 'restore', id: 't3', path: 'checkout/c.ts', name: 'c.ts' });
  });
});

describe('invertEntry', () => {
  /*
   * Order is not cosmetic. A paste that wrote `a.ts` and then `a copy.ts` must
   * be undone newest-first; run forwards, the first delete frees a name the
   * second edit still refers to.
   */
  it('reverses the gesture as well as inverting each edit', () => {
    const gesture = entry(
      { kind: 'create', id: 't1', path: 'a.ts', name: 'a.ts' },
      { kind: 'create', id: 't2', path: 'a copy.ts', name: 'a copy.ts' },
    );
    expect(invertEntry(gesture).edits).toEqual([
      { kind: 'delete', id: 't2', path: 'a copy.ts', name: 'a copy.ts' },
      { kind: 'delete', id: 't1', path: 'a.ts', name: 'a.ts' },
    ]);
  });

  it('keeps the label', () => {
    expect(invertEntry({ label: 'Paste 2 files', edits: [MOVE] }).label).toBe('Paste 2 files');
  });

  /*
   * Spelled out rather than compared against `invert` — `invertEntry` IS
   * reverse-then-invert, so asserting it equals `[invert(MOVE)]` restates the
   * implementation and passes however either of them is rewritten.
   */
  it('handles a one-edit gesture', () => {
    expect(invertEntry(entry(MOVE)).edits).toEqual([
      { kind: 'move', id: 't1', from: 'fixtures/a.ts', to: 'checkout/a.ts' },
    ]);
  });
});

describe('the stack', () => {
  it('starts empty', () => {
    expect(canUndo(EMPTY_UNDO)).toBe(false);
    expect(canRedo(EMPTY_UNDO)).toBe(false);
    expect(peekUndo(EMPTY_UNDO)).toBeNull();
    expect(peekRedo(EMPTY_UNDO)).toBeNull();
    expect(undoEdits(EMPTY_UNDO)).toEqual([]);
    expect(redoEdits(EMPTY_UNDO)).toEqual([]);
  });

  it('records a gesture', () => {
    const stack = record(EMPTY_UNDO, entry(MOVE));
    expect(canUndo(stack)).toBe(true);
    expect(peekUndo(stack)?.edits).toEqual([MOVE]);
  });

  /*
   * An entry with no edits is not a gesture. Recording one would leave a step
   * that does nothing, and the user's next ⌘Z would appear to be ignored.
   */
  it('ignores an empty gesture', () => {
    expect(record(EMPTY_UNDO, entry())).toBe(EMPTY_UNDO);
  });

  it('drops the oldest gesture past the cap', () => {
    let stack: UndoStack = EMPTY_UNDO;
    for (let i = 0; i < UNDO_DEPTH + 5; i += 1) {
      stack = record(stack, { label: `edit ${i}`, edits: [MOVE] });
    }
    expect(stack.past).toHaveLength(UNDO_DEPTH);
    expect(stack.past[0]?.label).toBe('edit 5');
    expect(stack.past[UNDO_DEPTH - 1]?.label).toBe(`edit ${UNDO_DEPTH + 4}`);
  });

  /*
   * Once you do something new the future you undid is unreachable — applying its
   * inverse to a tree that has moved on is how redo corrupts things.
   */
  it('clears the redo branch when something new is recorded', () => {
    let stack = record(EMPTY_UNDO, entry(MOVE));
    stack = commitUndo(stack);
    expect(canRedo(stack)).toBe(true);
    stack = record(stack, entry(DELETE));
    expect(canRedo(stack)).toBe(false);
  });
});

describe('the two-phase undo protocol', () => {
  /*
   * Reading the top of the stack must not move it: the caller executes the
   * inverse against the API first and only commits if it landed. A one-shot
   * undo() that popped first would throw the entry away on the one occasion it
   * mattered — a restore refused because the path is occupied.
   */
  it('peeking leaves the stack exactly where it was', () => {
    const stack = record(EMPTY_UNDO, entry(MOVE));
    const past = stack.past;
    // Read it three times — the shape a UI actually does, rendering the menu
    // item, showing the toast and then executing. Comparing two calls of a pure
    // function to each other could not have failed; comparing the stack to the
    // arrays it was built with can.
    peekUndo(stack);
    undoEdits(stack);
    peekUndo(stack);
    expect(stack.past).toBe(past);
    expect(stack.past).toHaveLength(1);
    expect(stack.future).toHaveLength(0);
    // And it is still executable afterwards, which is the point of peeking.
    expect(commitUndo(stack).future).toHaveLength(1);
  });

  /*
   * The edits come out as a fresh array. A caller that filters or splices the
   * list it was handed — dropping the edits whose API call already succeeded,
   * say — must not be editing the stack's own record through the back door.
   */
  it('hands out a copy, not the stack’s own list', () => {
    const stack = record(EMPTY_UNDO, entry(MOVE, DELETE));
    const edits = undoEdits(stack);
    edits.pop();
    expect(edits).toHaveLength(1);
    expect(undoEdits(stack)).toHaveLength(2);
    expect(peekUndo(stack)?.edits).toHaveLength(2);
  });

  it('hands back the inverted edits to execute, newest first', () => {
    const stack = record(EMPTY_UNDO, entry(MOVE, CREATE));
    expect(undoEdits(stack)).toEqual([invert(CREATE), invert(MOVE)]);
  });

  it('moves the gesture to the redo branch on commit', () => {
    const stack = commitUndo(record(EMPTY_UNDO, entry(MOVE)));
    expect(stack.past).toHaveLength(0);
    expect(stack.future).toHaveLength(1);
  });

  it('replays the original edits on redo', () => {
    const original = entry(MOVE, DELETE);
    const stack = commitUndo(record(EMPTY_UNDO, original));
    expect(redoEdits(stack)).toEqual(original.edits);
  });

  it('returns to where it started after undo then redo', () => {
    const original = entry(MOVE, DELETE);
    const start = record(EMPTY_UNDO, original);
    const round = commitRedo(commitUndo(start));
    expect(round.past).toEqual(start.past);
    expect(round.future).toHaveLength(0);
    expect(undoEdits(round)).toEqual(undoEdits(start));
  });

  /*
   * The one edit that does NOT round-trip to itself, and it is right that it
   * does not. Undoing a create deletes the file — softly, so it keeps its id —
   * and redoing that has to RESTORE it, not create a second test with the same
   * id. After that first round trip the pair is a fixed point, so ⌘Z / ⇧⌘Z can
   * be held down forever without the record drifting.
   */
  it('redoes an undone create as a restore, then stays put', () => {
    const start = record(EMPTY_UNDO, entry(CREATE));
    expect(undoEdits(start)).toEqual([
      { kind: 'delete', id: 't2', path: 'checkout/b.ts', name: 'b.ts' },
    ]);
    const undone = commitUndo(start);
    expect(redoEdits(undone)).toEqual([
      { kind: 'restore', id: 't2', path: 'checkout/b.ts', name: 'b.ts' },
    ]);
    const redone = commitRedo(undone);
    expect(undoEdits(redone)).toEqual([
      { kind: 'delete', id: 't2', path: 'checkout/b.ts', name: 'b.ts' },
    ]);
    expect(redoEdits(commitUndo(redone))).toEqual(redoEdits(undone));
  });

  it('survives several undos and redos in a row', () => {
    let stack = record(EMPTY_UNDO, { label: 'one', edits: [MOVE] });
    stack = record(stack, { label: 'two', edits: [DELETE] });
    expect(peekUndo(stack)?.label).toBe('two');
    stack = commitUndo(stack);
    expect(peekUndo(stack)?.label).toBe('one');
    stack = commitUndo(stack);
    expect(canUndo(stack)).toBe(false);
    expect(stack.future).toHaveLength(2);
    stack = commitRedo(stack);
    expect(peekUndo(stack)?.label).toBe('one');
    stack = commitRedo(stack);
    expect(peekUndo(stack)?.label).toBe('two');
    expect(canRedo(stack)).toBe(false);
  });

  const commits: Array<[string, (stack: UndoStack) => UndoStack]> = [
    ['undo', commitUndo],
    ['redo', commitRedo],
  ];
  it.each(commits)('committing a %s with nothing to commit changes nothing', (_name, commit) => {
    expect(commit(EMPTY_UNDO)).toBe(EMPTY_UNDO);
  });

  it('caps the past on redo too', () => {
    let stack: UndoStack = EMPTY_UNDO;
    for (let i = 0; i < UNDO_DEPTH; i += 1) stack = record(stack, { label: `e${i}`, edits: [MOVE] });
    stack = commitUndo(stack);
    stack = commitRedo(stack);
    expect(stack.past).toHaveLength(UNDO_DEPTH);
  });
});

describe('recording a paste or a drop', () => {
  const moveOp: TreeOp = {
    kind: 'move',
    id: 't1',
    entity: 'file',
    from: 'checkout/a.ts',
    to: 'fixtures/a.ts',
  };
  const copyOp: TreeOp = {
    kind: 'copy',
    id: 't1',
    entity: 'file',
    from: 'checkout/a.ts',
    to: 'fixtures/a copy.ts',
  };

  it('turns a move op into a move edit', () => {
    expect(editForOp(moveOp)).toEqual(MOVE);
  });

  /*
   * A copy created a NEW test, and undoing it means deleting THAT test — which
   * needs the id the server assigned. Null means "not recordable yet", not
   * "nothing happened".
   */
  const missingIds: Array<[string, string | undefined]> = [
    ['no id at all', undefined],
    ['an empty id', ''],
  ];
  it.each(missingIds)('refuses to record a copy with %s', (_name, createdId) => {
    expect(editForOp(copyOp, createdId)).toBeNull();
  });

  it('records a copy once the server id is known', () => {
    expect(editForOp(copyOp, 't9')).toEqual({
      kind: 'create',
      id: 't9',
      path: 'fixtures/a copy.ts',
      name: 'a copy.ts',
      copiedFrom: 'checkout/a.ts',
    });
  });

  it('names a file pasted into the root', () => {
    const rootCopy: TreeOp = {
      kind: 'copy',
      id: 't1',
      entity: 'file',
      from: 'a.ts',
      to: 'a copy.ts',
    };
    expect(editForOp(rootCopy, 't9')).toMatchObject({ path: 'a copy.ts', name: 'a copy.ts' });
  });

  it('gathers a whole gesture into one entry', () => {
    const gesture = entryForOps([moveOp, copyOp], { t1: 't9' }, 'Paste');
    expect(gesture.label).toBe('Paste');
    expect(gesture.edits).toHaveLength(2);
  });

  /*
   * Partial is right here: if one create failed, the two that worked should
   * still undo.
   */
  it('keeps the ops it can record and drops the ones it cannot', () => {
    const gesture = entryForOps([moveOp, copyOp]);
    expect(gesture.edits).toEqual([MOVE]);
  });

  // ── Folders ───────────────────────────────────────────────────────────────

  const folderMove: TreeOp = {
    kind: 'move',
    id: 'd:checkout',
    entity: 'dir',
    from: 'checkout',
    to: 'fixtures/checkout',
  };
  const folderCopy: TreeOp = {
    kind: 'copy',
    id: 'd:checkout',
    entity: 'dir',
    from: 'checkout',
    to: 'fixtures/checkout',
  };

  /*
   * A folder MOVE is one operation on the server — POST /folders/move rewrites
   * the prefix of everything underneath in a transaction — so it inverts by
   * swapping the two paths, exactly like a file move. The `id` it carries is
   * `d:<path>`, which no test endpoint can address; `from`/`to` are what the
   * inverse is executed with.
   */
  it('records a folder move, which is one reversible operation', () => {
    expect(editForOp(folderMove)).toEqual({
      kind: 'move',
      id: 'd:checkout',
      from: 'checkout',
      to: 'fixtures/checkout',
    });
    expect(invert(editForOp(folderMove) as TreeEdit)).toMatchObject({
      from: 'fixtures/checkout',
      to: 'checkout',
    });
  });

  /*
   * A folder COPY is not recordable as one edit and never will be: the gesture
   * created one new TEST per file underneath, each with its own id, and a
   * single create record has no id it could carry. Documented in undo.ts's
   * non-undoable list; asserted here so the documentation and the code cannot
   * drift apart.
   *
   * Passing an id does NOT unlock it. Accepting one would write a delete aimed
   * at whichever copied file the caller happened to pass, and ⌘Z would remove
   * one file out of twenty.
   */
  it.each([
    ['with no id', undefined],
    ['with an id the caller guessed at', 't9'],
  ])('refuses to record a folder copy %s', (_name, createdId) => {
    expect(editForOp(folderCopy, createdId)).toBeNull();
  });

  it('records the per-file creates a folder copy expanded into instead', () => {
    const expanded: TreeOp[] = [
      { kind: 'copy', id: 'f:t1', entity: 'file', from: 'checkout/a.ts', to: 'fixtures/checkout/a.ts' },
      { kind: 'copy', id: 'f:t2', entity: 'file', from: 'checkout/b.ts', to: 'fixtures/checkout/b.ts' },
    ];
    const gesture = entryForOps([folderCopy, ...expanded], { 'f:t1': 't9', 'f:t2': 't10' }, 'Copy checkout/');
    expect(gesture.edits.map((edit) => edit.kind)).toEqual(['create', 'create']);
    expect(gesture.edits.map((edit) => edit.id)).toEqual(['t9', 't10']);
    // One gesture, one ⌘Z — and it deletes the newest file first, so a name
    // freed by the first delete cannot be one the second still refers to.
    expect(invertEntry(gesture).edits).toEqual([
      { kind: 'delete', id: 't10', path: 'fixtures/checkout/b.ts', name: 'b.ts' },
      { kind: 'delete', id: 't9', path: 'fixtures/checkout/a.ts', name: 'a.ts' },
    ]);
  });

  it('produces an entry that record() will refuse when nothing was recordable', () => {
    const gesture = entryForOps([copyOp]);
    expect(gesture.edits).toEqual([]);
    expect(record(EMPTY_UNDO, gesture)).toBe(EMPTY_UNDO);
  });
});

describe('describing an edit', () => {
  const cases: Array<[TreeEdit, string]> = [
    [MOVE, 'Move checkout/a.ts to fixtures/a.ts'],
    [
      { kind: 'move', id: 't1', from: 'checkout/a.ts', to: 'checkout/b.ts' },
      'Rename checkout/a.ts to checkout/b.ts',
    ],
    [{ kind: 'move', id: 't1', from: 'a.ts', to: 'b.ts' }, 'Rename a.ts to b.ts'],
    [CREATE, 'Create checkout/b.ts'],
    [
      { kind: 'create', id: 't2', path: 'x/b.ts', name: 'b.ts', copiedFrom: 'y/b.ts' },
      'Copy y/b.ts to x/b.ts',
    ],
    [DELETE, 'Delete checkout/c.ts'],
    [RESTORE, 'Restore checkout/c.ts'],
  ];
  it.each(cases)('%o reads as "%s"', (edit, expected) => {
    expect(describeEdit(edit)).toBe(expected);
  });

  it('prefers the label the caller gave the gesture', () => {
    expect(describeEntry({ label: 'Paste 3 files', edits: [MOVE] })).toBe('Paste 3 files');
  });

  it('falls back to the single edit', () => {
    expect(describeEntry(entry(MOVE))).toBe('Move checkout/a.ts to fixtures/a.ts');
  });

  it('counts the rest of a multi-edit gesture', () => {
    expect(describeEntry(entry(MOVE, DELETE, CREATE))).toBe(
      'Move checkout/a.ts to fixtures/a.ts (+2 more)',
    );
  });

  it('says something for an empty gesture rather than crashing', () => {
    expect(describeEntry(entry())).toBe('Nothing');
  });
});
