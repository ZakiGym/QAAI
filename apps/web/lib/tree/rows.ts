/**
 * The one row shape the panel actually renders, and the seam between two id
 * spaces that must not be confused for each other.
 *
 * Wave 1 produced two modules that both call their row a `TreeRow` and mean
 * different things. `model.flattenTree` returns `{ node, depth, expanded }` —
 * the tree, flattened. `selection`/`clipboard`/`dnd`/`undo` want
 * `{ id, kind, name, path, parentPath, depth }` — a row they can address
 * without knowing what a `TreeNode` is. Neither is wrong; they answer different
 * questions. This adapts one to the other so the component composes them
 * instead of reimplementing half of each.
 *
 * ── The two id spaces ───────────────────────────────────────────────────────
 *
 * MODEL IDS address a place in the tree. A folder's is its path, a feature
 * group's is `feature:<name>`. Expansion state and the persisted `scope`
 * preference are keyed on these, because both survive a rebuild and both are
 * about the tree rather than about a row.
 *
 * ROW IDS address a row on screen, and must be globally unique across files and
 * folders. A model id cannot serve: a file's is a raw test id and a folder's is
 * a raw path, drawn from different generators with no guarantee they differ. A
 * project containing a folder named exactly like some test's cuid would give two
 * rows one id, and every selection, cut and drop keyed on it would act on the
 * wrong one. Namespacing costs two characters and removes the class.
 *
 * Keep them apart at the call site: pass `row.node.id` to anything about the
 * TREE (expand, scope) and `row.id` to anything about the SELECTION.
 */

import type { TreeNode, TreeRow as ModelRow } from './model';
import type { TreeRow as InteractionRow } from './selection';

/** A row the renderer can draw and the interaction modules can address. */
export interface PanelRow extends InteractionRow {
  /** The node this came from — icons, decorations and counts all read it. */
  node: TreeNode;
  /** The model's own id, for expansion and scope. NOT the selection key. */
  nodeId: string;
}

/** `d:` folders, `f:` files. Two characters that make the space total. */
export const rowIdFor = (node: TreeNode): string =>
  node.kind === 'dir' ? `d:${node.id}` : `f:${node.id}`;

/**
 * The folder a row lives in.
 *
 * Taken from the node's own path rather than from the row above it: a compacted
 * chain draws three folders as one row, so "the row above" is not the parent in
 * any sense a move operation would accept.
 *
 * A feature group has no path at all, and neither do its children in that
 * grouping — there is nothing on disk to be the parent of. `''` is the honest
 * answer, and the panel refuses path operations in feature mode for the same
 * reason.
 */
function parentOf(node: TreeNode): string {
  const path = node.kind === 'dir' ? (node.source === 'path' ? node.path : '') : node.path;
  if (!path) return '';
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * Adapt the model's flattened rows into panel rows.
 *
 * Pure and order-preserving: the array that comes out is the array that goes on
 * screen, top to bottom, which is what every keyboard move and Shift-range in
 * `selection` is defined against.
 */
export function panelRows(rows: readonly ModelRow[]): PanelRow[] {
  return rows.map((row) => {
    const { node } = row;
    const path = node.kind === 'dir' ? (node.source === 'path' ? node.path : '') : node.path;
    return {
      id: rowIdFor(node),
      nodeId: node.id,
      kind: node.kind === 'dir' ? ('dir' as const) : ('file' as const),
      name: node.name,
      path,
      parentPath: parentOf(node),
      depth: row.depth,
      ...(node.kind === 'dir' ? { expanded: row.expanded } : {}),
      node,
    };
  });
}

/** The test id behind a row, or null for a folder. Undoes the `f:` prefix. */
export const testIdOf = (row: PanelRow): string | null =>
  row.kind === 'file' ? row.nodeId : null;

/** Look a row up by its selection id. */
export function rowById(rows: readonly PanelRow[], id: string): PanelRow | null {
  return rows.find((row) => row.id === id) ?? null;
}
