/**
 * Undo for structural edits to the tree — moves, renames, creates, deletes.
 *
 * The stack holds RECORDS OF WHAT HAPPENED, not closures, and every record is
 * invertible from its own fields. That is the whole design constraint: a closure
 * captured over the tree from three edits ago inverts into a world that no
 * longer exists, while `{ kind: 'move', id, from, to }` inverts into a move in
 * the opposite direction no matter what happened since.
 *
 * WHAT MAKES A DELETE INVERTIBLE. The API's delete is soft — it stamps
 * `disabledAt` — and `POST /projects/:projectId/tests/:testId/restore` clears it
 * by id alone. So the id is all the inverse strictly needs. The record carries
 * the path anyway, because restore REFUSES when something else has taken the old
 * path in the meantime ("… is occupied — rename that file first"), and a caller
 * that knows the path can say which file is in the way instead of surfacing a
 * bare 409.
 *
 * WHAT IS NOT UNDOABLE, and why it is left out rather than silently swallowed:
 *
 *   - Edits to a file's CONTENT. Monaco keeps its own undo stack for the buffer;
 *     a tree-level undo that also rewound text would fight ⌘Z inside the editor
 *     and the user would never know which stack they were popping.
 *   - Anything the server did on its own — a generation run creating files, an
 *     import. There is no gesture to attribute the inverse to, and undoing work
 *     you did not ask for is not undo.
 *   - A create whose new id never came back (the request failed, or the caller
 *     did not thread the response through). `editForOp` returns null for exactly
 *     this case rather than recording a delete with no target.
 *   - A folder COPY, as one record. There is no folder row on the server to
 *     delete: copying `checkout/` into `fixtures/` creates one new TEST per file
 *     underneath, each with its own id, and a single `{ kind: 'create', id }`
 *     has no id it could carry. `editForOp` returns null for a `copy` op whose
 *     `entity` is `'dir'`, and the caller records the per-file creates instead —
 *     `entryForOps` over the file-level ops the folder expanded into, which
 *     undoes the whole gesture in one ⌘Z, because an entry holds many edits.
 *     A folder MOVE is different and IS fully undoable: it is one operation on
 *     the server (`POST /folders/move`, `{ from, to }`) and inverts by swapping
 *     the two paths.
 *
 * A FAILED INVERSE IS NOT AN UNDO. `peekUndo` reads the top of the stack without
 * moving it; the caller executes the inverted edits against the API and only
 * then calls `commitUndo`. If the API refuses — the path is occupied, someone
 * else moved the file — the stack is untouched and the user can try again after
 * clearing the way. A one-shot `undo()` that popped first would lose the entry
 * on the one occasion it mattered.
 */

import type { TreeOp } from './clipboard';

/**
 * One executed structural edit.
 *
 * `restore` exists so the set is CLOSED under inversion: undoing a delete yields
 * a restore, and redoing that has to yield a delete again. Without it, redo
 * after an undone delete has nothing to be.
 */
export type TreeEdit =
  | {
      kind: 'move';
      /**
       * The ROW id the op carried, and it means different things for the two
       * row kinds — which matters here because the inverse is executed by the
       * same code that executed the edit:
       *
       *   · A FILE's is `f:<testId>`; strip the prefix and it addresses
       *     `PATCH /projects/:id/tests/:testId/path`.
       *   · A FOLDER's is `d:<path>` — a key this app minted for the tree, not
       *     an id the server has ever seen. There is no folder row in the
       *     database, so it addresses nothing: the inverse of a folder move is
       *     `POST /projects/:id/folders/move` with `{ from, to }`, which are
       *     the two fields below. Sending this `id` to a test endpoint is a 404.
       *
       * `entity` on the originating `TreeOp` is what tells the two apart; a
       * move edit recorded by hand should carry a file id.
       */
      id: string;
      from: string;
      to: string;
      /** Display names, when the edit also renamed the test. Both or neither. */
      fromName?: string;
      toName?: string;
    }
  | {
      kind: 'create';
      /** The id the server assigned. Without it the create cannot be undone. */
      id: string;
      path: string;
      name: string;
      /** Set when the file was born as a copy — provenance for the label only. */
      copiedFrom?: string;
    }
  | { kind: 'delete'; id: string; path: string; name: string }
  | { kind: 'restore'; id: string; path: string; name: string };

/**
 * One user gesture. A multi-drag of six files, or a paste of a folder, is ONE
 * entry with six edits — undo must put back everything the gesture did, not the
 * last sixth of it.
 */
export interface UndoEntry {
  /** For the toast and the menu item. Falls back to `describeEntry`. */
  label?: string;
  edits: readonly TreeEdit[];
}

export interface UndoStack {
  /** Newest last. */
  readonly past: readonly UndoEntry[];
  readonly future: readonly UndoEntry[];
}

/**
 * How many gestures the stack remembers.
 *
 * Bounded because every record pins ids and paths from a tree the user may have
 * left long ago, and an unbounded stack in a tab that stays open for a day is a
 * slow leak whose entries get less trustworthy the older they are. Fifty is far
 * past the point where anyone remembers what they did.
 */
export const UNDO_DEPTH = 50;

export const EMPTY_UNDO: UndoStack = Object.freeze({
  past: Object.freeze<UndoEntry[]>([]),
  future: Object.freeze<UndoEntry[]>([]),
});

/**
 * The inverse of one edit. Total: every kind has one, from its own fields.
 *
 * `invert` is NOT an involution on `create`, and that is deliberate rather than
 * an oversight. Undoing a create deletes the file — softly, so the row keeps its
 * id — and REDOING that cannot be a create, because the test already exists with
 * that id and creating it again would fork the history. The redo is a restore.
 * So a create settles into the delete/restore pair after one round trip, which
 * is a fixed point: undo and redo can then be pressed forever without drifting.
 * Every other kind inverts back to itself exactly.
 */
export function invert(edit: TreeEdit): TreeEdit {
  switch (edit.kind) {
    case 'move':
      return {
        kind: 'move',
        id: edit.id,
        from: edit.to,
        to: edit.from,
        ...(edit.toName !== undefined ? { fromName: edit.toName } : {}),
        ...(edit.fromName !== undefined ? { toName: edit.fromName } : {}),
      };
    case 'create':
      return { kind: 'delete', id: edit.id, path: edit.path, name: edit.name };
    case 'delete':
      return { kind: 'restore', id: edit.id, path: edit.path, name: edit.name };
    case 'restore':
      return { kind: 'delete', id: edit.id, path: edit.path, name: edit.name };
  }
}

/**
 * The inverse of a whole gesture.
 *
 * The order is REVERSED as well as each edit inverted, and that is not cosmetic.
 * A paste that wrote `a.ts` and then `a copy.ts` has to be undone newest-first,
 * or the first delete frees a name the second edit still refers to. Any sequence
 * where one edit depends on the state the previous one left behind breaks if the
 * inverse runs forwards.
 */
export function invertEntry(entry: UndoEntry): UndoEntry {
  return {
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    edits: [...entry.edits].reverse().map(invert),
  };
}

/**
 * Push a gesture onto the stack.
 *
 * Recording clears the redo branch, which is the standard rule and the right
 * one: once you do something new, the future you undid is unreachable, and
 * offering to redo it would apply an inverse to a tree that has moved on.
 *
 * An entry with no edits is not a gesture and returns the stack untouched —
 * otherwise a refused paste would leave an undo step that does nothing, and the
 * user's next ⌘Z would appear to be ignored.
 */
export function record(stack: UndoStack, entry: UndoEntry): UndoStack {
  if (entry.edits.length === 0) return stack;
  const past = [...stack.past, entry];
  return { past: past.slice(Math.max(0, past.length - UNDO_DEPTH)), future: [] };
}

export function canUndo(stack: UndoStack): boolean {
  return stack.past.length > 0;
}

export function canRedo(stack: UndoStack): boolean {
  return stack.future.length > 0;
}

/** The gesture ⌘Z would reverse, without moving the stack. */
export function peekUndo(stack: UndoStack): UndoEntry | null {
  return stack.past[stack.past.length - 1] ?? null;
}

/** The gesture ⇧⌘Z would replay, without moving the stack. */
export function peekRedo(stack: UndoStack): UndoEntry | null {
  return stack.future[stack.future.length - 1] ?? null;
}

/** The edits to execute for ⌘Z, in the order they must run. `[]` when empty. */
export function undoEdits(stack: UndoStack): TreeEdit[] {
  const entry = peekUndo(stack);
  return entry ? [...invertEntry(entry).edits] : [];
}

/** The edits to execute for ⇧⌘Z. */
export function redoEdits(stack: UndoStack): TreeEdit[] {
  const entry = peekRedo(stack);
  return entry ? [...invertEntry(entry).edits] : [];
}

/**
 * Move the undone gesture to the redo branch. Call only after the inverse
 * actually landed; a refused inverse must leave the stack where it was.
 *
 * The FUTURE holds the inverted entry, not the original, because redoing means
 * re-applying the inverse of what was just executed — invert twice and you are
 * back to the original edits, which is exactly what redo should do.
 */
export function commitUndo(stack: UndoStack): UndoStack {
  const entry = peekUndo(stack);
  if (!entry) return stack;
  return {
    past: stack.past.slice(0, -1),
    future: [...stack.future, invertEntry(entry)],
  };
}

/** The mirror of `commitUndo`, for a redo that landed. */
export function commitRedo(stack: UndoStack): UndoStack {
  const entry = peekRedo(stack);
  if (!entry) return stack;
  const past = [...stack.past, invertEntry(entry)];
  return {
    past: past.slice(Math.max(0, past.length - UNDO_DEPTH)),
    future: stack.future.slice(0, -1),
  };
}

/**
 * Record the result of a paste or a drop.
 *
 * A move op inverts on its own, folders included. A copy op created a NEW test,
 * so undoing it means deleting that new test — which needs the id the server
 * assigned, and returns null until the caller has it. Null means "not
 * recordable yet", not "nothing happened": call again once the create resolves.
 *
 * A FOLDER copy returns null whatever id it is handed, and always will. The
 * folder is not a row on the server; the gesture created one test per file
 * underneath, and the honest record is those file-level creates. Record them
 * with `entryForOps` over the expanded ops — one entry, many edits, one ⌘Z.
 * Accepting a `createdId` here would write a delete aimed at whichever copied
 * file the caller happened to pass, and undo would remove one file out of
 * twenty.
 */
export function editForOp(op: TreeOp, createdId?: string): TreeEdit | null {
  if (op.kind === 'move') return { kind: 'move', id: op.id, from: op.from, to: op.to };
  if (op.entity === 'dir') return null;
  if (createdId === undefined || createdId === '') return null;
  const slash = op.to.lastIndexOf('/');
  return {
    kind: 'create',
    id: createdId,
    path: op.to,
    name: slash === -1 ? op.to : op.to.slice(slash + 1),
    copiedFrom: op.from,
  };
}

/**
 * Every op in a gesture as one entry, dropping the copies whose new ids are not
 * known — and the folder copies, which never have one. Partial is correct here:
 * a paste of three files where one create failed should still undo the two that
 * worked.
 *
 * `createdIds` is keyed by the op's `id`. For a folder copy the caller passes
 * the FILE-level ops it expanded the folder into, each with its own new id;
 * passing the folder op itself records nothing, by design.
 */
export function entryForOps(
  ops: readonly TreeOp[],
  createdIds: Readonly<Record<string, string>> = {},
  label?: string,
): UndoEntry {
  const edits: TreeEdit[] = [];
  for (const op of ops) {
    const edit = editForOp(op, createdIds[op.id]);
    if (edit) edits.push(edit);
  }
  return { ...(label !== undefined ? { label } : {}), edits };
}

/** One line of plain English for a toast or a menu item. */
export function describeEdit(edit: TreeEdit): string {
  switch (edit.kind) {
    case 'move': {
      const fromDir = edit.from.lastIndexOf('/');
      const toDir = edit.to.lastIndexOf('/');
      const sameFolder =
        (fromDir === -1 ? '' : edit.from.slice(0, fromDir)) ===
        (toDir === -1 ? '' : edit.to.slice(0, toDir));
      return sameFolder ? `Rename ${edit.from} to ${edit.to}` : `Move ${edit.from} to ${edit.to}`;
    }
    case 'create':
      return edit.copiedFrom !== undefined
        ? `Copy ${edit.copiedFrom} to ${edit.path}`
        : `Create ${edit.path}`;
    case 'delete':
      return `Delete ${edit.path}`;
    case 'restore':
      return `Restore ${edit.path}`;
  }
}

/** The entry's own label when it has one, else a description of what it did. */
export function describeEntry(entry: UndoEntry): string {
  if (entry.label !== undefined) return entry.label;
  const first = entry.edits[0];
  if (!first) return 'Nothing';
  if (entry.edits.length === 1) return describeEdit(first);
  return `${describeEdit(first)} (+${entry.edits.length - 1} more)`;
}
