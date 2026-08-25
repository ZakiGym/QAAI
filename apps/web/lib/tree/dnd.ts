/**
 * Whether a drag can land, and what it does when it does.
 *
 * A drop is a paste with a mouse, so this module does not re-implement the
 * rules: it builds clipboard entries from the dragged rows and hands them to
 * `planOps`. That is a deliberate structural choice rather than convenience —
 * two implementations of "can this folder go there" WILL drift, and the half
 * that drifts is always the one without a dialog in front of it. The caller gets
 * `TreeOp[]` from both paths and executes them with one function.
 *
 * The refusals worth naming, because each costs something real:
 *
 *   - Onto ITSELF, or into its own descendant: the recursion trap.
 *   - Into the folder it already lives in: a legal move that changes nothing,
 *     and still spends a request, an audit row and a full tree re-render. The
 *     tree flickers and the file is exactly where it was.
 *   - Onto a name that is already taken: a move that would need to overwrite. It
 *     is refused rather than renamed, because a drag is an easy gesture to make
 *     by accident and the file being dragged is the one that would lose.
 *
 * Multi-drag is in scope: a drag carries every selected row when the row under
 * the cursor is part of the selection, and just that row when it is not.
 *
 * Two more that are not about the tree's shape at all:
 *
 *   - Onto a FEATURE GROUP. Under `grouping: 'feature'` the headings are not
 *     folders and have no path, so there is nowhere to drop; the old answer —
 *     the project root — moved the file somewhere the user never pointed at.
 *   - A dragged id with no row in the list this was planned against. Like
 *     `clipboard.ts`, that is refused by name rather than dropped, because the
 *     alternative is a drop that reports success over fewer files than were
 *     dragged.
 *
 * `rows` is EVERY row in the tree here too, for the reasons `clipboard.ts`
 * gives. A drag can only START on a visible row, but the destination's contents
 * decide the collisions and a collapsed folder still holds its files.
 */

import { planOps, pruneContained, folderTargetOf, resolveIds, unresolvedRefusal } from './clipboard';
import type { PlanResult, Refusal, RefusalReason } from './clipboard';
import type { SelectionState, TreeRow } from './selection';

export type { TreeOp, Refusal, RefusalReason } from './clipboard';

/** A plain move, or a copy (⌥ on macOS, Ctrl elsewhere). */
export type DropEffect = 'move' | 'copy';

export interface DropCheck {
  /** True when at least one dragged row would actually land. */
  ok: boolean;
  /**
   * Why not — the first refusal, which is the one to put in a tooltip or a
   * cursor. `null` when `ok`. The full list is on `planDrop`.
   */
  reason: RefusalReason | null;
  message: string | null;
}

/**
 * The rows a drag starting on `rowId` should carry.
 *
 * Grabbing a row INSIDE the selection drags the whole selection; grabbing one
 * outside it drags only that row. Anything else surprises someone: dragging
 * always-the-selection moves files a user forgot were selected, and
 * always-one-row makes multi-select useless for the gesture it most exists for.
 */
export function dragIdsFor(selection: SelectionState, rowId: string): string[] {
  return selection.ids.has(rowId) ? [...selection.ids] : [rowId];
}

/** ⌥ on macOS, Ctrl on Windows and Linux — the drag copies instead of moving. */
export function effectFromModifiers(mods: { alt?: boolean; ctrl?: boolean } = {}): DropEffect {
  return mods.alt === true || mods.ctrl === true ? 'copy' : 'move';
}

/**
 * Resolve the row under the cursor to the folder a drop would go into: a path,
 * `''` for the root, or `null` when the row is a feature group — which is not a
 * folder and must not be treated as the root. `canDropOn`/`planDropOn` handle
 * that case for you; a caller resolving the target by hand has to check it.
 */
export { folderTargetOf as dropFolderOf } from './clipboard';

/** Every dragged id refused for one reason — the whole gesture, not a sample. */
function refuseAll<R extends TreeRow>(
  allRows: readonly R[],
  draggedIds: readonly string[],
  refuse: (row: R) => Refusal,
): PlanResult {
  const { entries, unresolved } = resolveIds(allRows, draggedIds);
  const byId = new Map(allRows.map((row) => [row.id, row]));
  const refusals = [
    ...unresolved.map(unresolvedRefusal),
    ...entries.map((entry) => refuse(byId.get(entry.id) as R)),
  ];
  return { ops: [], refusals };
}

/**
 * The operations a drop onto `targetFolder` would produce, plus everything it
 * refused. `''` is the root.
 *
 * `rows` is every row in the tree, visible or not — see `planOps`. A drag can
 * only start on a visible row, but the destination's contents decide the name
 * collisions, and a collapsed folder's files are still in it.
 */
export function planDrop<R extends TreeRow>(
  allRows: readonly R[],
  draggedIds: readonly string[],
  targetFolder: string,
  effect: DropEffect = 'move',
): PlanResult {
  const { entries, unresolved } = resolveIds(allRows, draggedIds);
  const plan = planOps(
    allRows,
    pruneContained(entries),
    effect === 'copy' ? 'copy' : 'cut',
    targetFolder,
  );
  if (unresolved.length === 0) return plan;
  // A dragged row the list cannot resolve is reported, never skipped — the
  // same rule the clipboard follows, and for the same reason: a drop that
  // moved three of the five rows the user dragged, with nothing said about the
  // other two, is indistinguishable from a bug in the server.
  return { ops: plan.ops, refusals: [...unresolved.map(unresolvedRefusal), ...plan.refusals] };
}

/**
 * May this drag land here?
 *
 * Answered by planning the drop and looking at the result, so the highlight the
 * user sees and the work that happens on mouse-up can never disagree.
 *
 * For a multi-drag, "at least one row lands" is enough. Dragging a folder and a
 * sibling into that folder is a real gesture with an obvious meaning — the
 * sibling goes in — and refusing the whole drop because one of its rows is the
 * destination would make the tree feel broken rather than careful. The rows that
 * cannot move are reported, not silently dropped.
 */
export function canDrop<R extends TreeRow>(
  allRows: readonly R[],
  draggedIds: readonly string[],
  targetFolder: string,
  effect: DropEffect = 'move',
): DropCheck {
  const plan = planDrop(allRows, draggedIds, targetFolder, effect);
  if (plan.ops.length > 0) return { ok: true, reason: null, message: null };
  const first = plan.refusals[0];
  return {
    ok: false,
    reason: first?.reason ?? null,
    message: first?.message ?? null,
  };
}

/**
 * `canDrop`, addressed by the row under the cursor rather than by folder path.
 *
 * A cursor over a feature group resolves to no folder at all, and that is the
 * answer the highlight needs: the row must not light up.
 */
export function canDropOn<R extends TreeRow>(
  allRows: readonly R[],
  draggedIds: readonly string[],
  targetRowId: string | null,
  effect: DropEffect = 'move',
): DropCheck {
  const folder = folderTargetOf(allRows, targetRowId);
  if (folder === null) {
    const first = planDropOn(allRows, draggedIds, targetRowId, effect).refusals[0];
    return { ok: false, reason: first?.reason ?? 'no-path', message: first?.message ?? null };
  }
  return canDrop(allRows, draggedIds, folder, effect);
}

/** `planDrop`, addressed by the row under the cursor. */
export function planDropOn<R extends TreeRow>(
  allRows: readonly R[],
  draggedIds: readonly string[],
  targetRowId: string | null,
  effect: DropEffect = 'move',
): PlanResult {
  const folder = folderTargetOf(allRows, targetRowId);
  if (folder !== null) return planDrop(allRows, draggedIds, folder, effect);
  // The target is a feature group. Every dragged row is refused, and each
  // refusal names the row that could not move rather than the heading it was
  // dropped on — the user is being told what happened to their files.
  const target = allRows.find((row) => row.id === targetRowId);
  const name = target?.name ?? 'This group';
  return refuseAll(allRows, draggedIds, (row) => ({
    id: row.id,
    path: row.path,
    reason: 'no-path',
    message: `${name} is a feature group, not a folder — switch to path grouping to move files`,
  }));
}
