import { describe, expect, it } from 'vitest';
import { buildTree, flattenTree, allDirIds, type TreeTest } from '../../lib/tree/model';
import { panelRows, type PanelRow } from '../../lib/tree/rows';
import { planDropOn } from '../../lib/tree/dnd';
import { EMPTY_SELECTION } from '../../lib/tree/selection';
import type { TreeOp } from '../../lib/tree/clipboard';
import {
  ancestorDirIds,
  ancestorPaths,
  BATCH_LIMIT,
  buildDecorations,
  descendantFiles,
  descendantTestIds,
  DIR_ROW_PREFIX,
  editableName,
  expandedFrom,
  FILE_ROW_PREFIX,
  freeFolderName,
  hiddenFilePaths,
  hiddenNameTaken,
  hiddenTakenMessage,
  injectPendingFolders,
  isDirRowId,
  messageOf,
  nameSelection,
  nestRows,
  opIdsOf,
  outcomeMessage,
  parseTreeDrag,
  partialMessage,
  pendingRefusal,
  prunePending,
  rangesForSegments,
  refusalSummary,
  relativeToScope,
  renamePending,
  requestForEdit,
  requestsForEdits,
  requestsForOps,
  siblingDirIds,
  siblingNames,
  splitHiddenConflicts,
  splitPending,
  structuralOpsAllowed,
  testIdOfRowId,
  TREE_DRAG_MIME,
  treeDragPayload,
  validateName,
  type TreeTestRow,
} from './useTreeController';

/**
 * The explorer's decisions, tested without a DOM.
 *
 * `apps/web` has no jsdom and no component-test setup, so anything decided
 * inside a callback is untestable by construction. That constraint is why the
 * controller exports its reasoning as pure functions and keeps the hook down to
 * wiring — these tests are the return on that, and they cover the parts where
 * being wrong is expensive: which API a move is addressed to, what an undo
 * replays, and whether a gesture was planned against the right row list.
 */

function mk(filePath: string, extra: Partial<TreeTestRow> = {}): TreeTestRow {
  return {
    id: `t-${filePath}`,
    name: filePath.split('/').pop() ?? filePath,
    type: 'E2E',
    filePath,
    reviewFlags: [],
    ...extra,
  };
}

/** Every row, every folder open — the list planning must be given. */
function allRowsOf(tests: readonly TreeTest[], options = {}): PanelRow[] {
  const model = buildTree(tests, options);
  return panelRows(flattenTree(model.roots, new Set(allDirIds(model.roots))));
}

/** Only what is on screen with `collapsed` folders shut — the list keys move over. */
function visibleRowsOf(
  tests: readonly TreeTest[],
  collapsed: string[] = [],
  options = {},
): PanelRow[] {
  const model = buildTree(tests, options);
  const expanded = expandedFrom(allDirIds(model.roots), new Set(collapsed));
  return panelRows(flattenTree(model.roots, expanded));
}

const op = (over: Partial<TreeOp> & Pick<TreeOp, 'id' | 'entity'>): TreeOp => ({
  kind: 'move',
  from: 'a',
  to: 'b',
  ...over,
});

// ─── nestRows ────────────────────────────────────────────────────────────────

describe('nestRows', () => {
  it('rebuilds the shape the flattener threw away', () => {
    const rows = visibleRowsOf([
      mk('checkout/deep/a.spec.ts'),
      mk('checkout/b.spec.ts'),
      mk('root.spec.ts'),
    ]);
    const nested = nestRows(rows);

    expect(nested.map((node) => node.row.name)).toEqual(['checkout', 'root.spec.ts']);
    const checkout = nested[0]!;
    expect(checkout.children.map((node) => node.row.name)).toEqual(['deep', 'b.spec.ts']);
    expect(checkout.children[0]!.children.map((node) => node.row.name)).toEqual(['a.spec.ts']);
  });

  it('preserves order exactly — it is a regrouping, not a re-sort', () => {
    const rows = visibleRowsOf([mk('a/1.spec.ts'), mk('a/2.spec.ts'), mk('b/3.spec.ts')]);
    const flat: string[] = [];
    const walk = (nodes: ReturnType<typeof nestRows>): void => {
      for (const node of nodes) {
        flat.push(node.row.id);
        walk(node.children);
      }
    };
    walk(nestRows(rows));
    expect(flat).toEqual(rows.map((row) => row.id));
  });

  it('gives an empty list back rather than throwing', () => {
    expect(nestRows([])).toEqual([]);
  });
});

// ─── Paths ───────────────────────────────────────────────────────────────────

describe('ancestorPaths', () => {
  it('lists the folders above a file, outermost first', () => {
    expect(ancestorPaths('a/b/c.spec.ts')).toEqual(['a', 'a/b']);
  });

  it('has none for a file at the root', () => {
    expect(ancestorPaths('c.spec.ts')).toEqual([]);
  });
});

describe('ancestorDirIds', () => {
  const tests = [mk('checkout/deep/a.spec.ts'), mk('root.spec.ts')];

  it('walks the built tree, not the path string', () => {
    const model = buildTree(tests);
    expect(ancestorDirIds(model.roots, 't-checkout/deep/a.spec.ts')).toEqual([
      'checkout',
      'checkout/deep',
    ]);
  });

  it('answers with the compacted row that actually exists', () => {
    // Three folders, one row: auto-reveal has to open the row, and the row's id
    // is the OUTERMOST path.
    const model = buildTree(tests, { compactFolders: true });
    expect(ancestorDirIds(model.roots, 't-checkout/deep/a.spec.ts')).toEqual(['checkout']);
  });

  it('answers with the feature group when that is what the tree is made of', () => {
    const model = buildTree([mk('checkout/a.spec.ts', { feature: 'Checkout' })], {
      grouping: 'feature',
    });
    expect(ancestorDirIds(model.roots, 't-checkout/a.spec.ts')).toEqual(['feature:Checkout']);
  });

  it('is null for a node that is not in this tree', () => {
    expect(ancestorDirIds(buildTree(tests).roots, 'nope')).toBeNull();
  });
});

describe('relativeToScope', () => {
  it('is the whole path when nothing is scoped', () => {
    expect(relativeToScope('checkout/a.spec.ts', null)).toBe('checkout/a.spec.ts');
  });

  it('strips the scope when the path is inside it', () => {
    expect(relativeToScope('checkout/deep/a.spec.ts', 'checkout')).toBe('deep/a.spec.ts');
  });

  it('leaves a sibling folder alone — checkout-v2 is not inside checkout', () => {
    expect(relativeToScope('checkout-v2/a.spec.ts', 'checkout')).toBe('checkout-v2/a.spec.ts');
  });

  it('cannot shorten anything against a feature scope', () => {
    expect(relativeToScope('checkout/a.spec.ts', 'feature:Checkout')).toBe('checkout/a.spec.ts');
  });
});

// ─── Names ───────────────────────────────────────────────────────────────────

describe('validateName', () => {
  const free = new Set<string>();

  it('accepts an ordinary file name', () => {
    expect(validateName('order-total.spec.ts', 'file', free).ok).toBe(true);
  });

  it('refuses an empty name, and says which kind of thing needs one', () => {
    expect(validateName('   ', 'dir', free)).toEqual({
      ok: false,
      message: 'A folder needs a name',
    });
  });

  it('refuses a separator rather than silently making a folder', () => {
    expect(validateName('a/b.spec.ts', 'file', free).ok).toBe(false);
    expect(validateName('a\\b.spec.ts', 'file', free).ok).toBe(false);
  });

  it('refuses the two names that are not names', () => {
    expect(validateName('.', 'dir', free).ok).toBe(false);
    expect(validateName('..', 'dir', free).ok).toBe(false);
  });

  it('refuses control characters, which a paste can carry in invisibly', () => {
    expect(validateName('order\u0007.spec.ts', 'file', free).ok).toBe(false);
  });

  it('keeps hyphens, dots and spaces — those are ordinary in a filename', () => {
    expect(validateName('order total-2.spec.ts', 'file', free).ok).toBe(true);
  });

  it('refuses a name the destination already has, by name', () => {
    expect(validateName('a.spec.ts', 'file', new Set(['a.spec.ts']))).toEqual({
      ok: false,
      message: 'a.spec.ts already exists here',
    });
  });

  it('refuses a name past the length the path cap leaves room for', () => {
    expect(validateName('x'.repeat(400), 'file', free).ok).toBe(false);
  });
});

describe('editableName', () => {
  it('is the file name for a file', () => {
    const rows = allRowsOf([mk('checkout/a.spec.ts')]);
    const file = rows.find((row) => row.kind === 'file')!;
    expect(editableName(file)).toBe('a.spec.ts');
  });

  it('is the deepest folder of a compacted chain, not the joined label', () => {
    const rows = allRowsOf([mk('hand-written/checkout/deep/a.spec.ts')], {
      compactFolders: true,
    });
    const dir = rows.find((row) => row.kind === 'dir')!;
    // The row is LABELLED with the whole chain and ACTS on the last folder.
    expect(dir.name).toBe('hand-written/checkout/deep');
    expect(editableName(dir)).toBe('deep');
  });
});

describe('nameSelection', () => {
  it('preselects the stem so the extension survives the first keystroke', () => {
    expect(nameSelection('order-total.spec.ts', 'file')).toEqual({ start: 0, end: 16 });
  });

  it('selects a dotfile whole — a leading dot is name, not extension', () => {
    expect(nameSelection('.gitignore', 'file')).toEqual({ start: 0, end: 10 });
  });

  it('selects a folder name whole', () => {
    expect(nameSelection('checkout.v2', 'dir')).toEqual({ start: 0, end: 11 });
  });
});

describe('siblingNames', () => {
  it('collects what is taken in one folder, excluding the row being renamed', () => {
    const rows = allRowsOf([
      mk('checkout/a.spec.ts'),
      mk('checkout/b.spec.ts'),
      mk('other/c.spec.ts'),
    ]);
    const a = rows.find((row) => row.name === 'a.spec.ts')!;
    expect([...siblingNames(rows, 'checkout', a.id)]).toEqual(['b.spec.ts']);
    expect([...siblingNames(rows, 'checkout', null)].sort()).toEqual(['a.spec.ts', 'b.spec.ts']);
  });
});

describe('freeFolderName', () => {
  it('takes the plain name when nothing has it', () => {
    expect(freeFolderName('new-folder', new Set())).toBe('new-folder');
  });

  it('counts up rather than stacking suffixes', () => {
    expect(freeFolderName('new-folder', new Set(['new-folder', 'new-folder-2']))).toBe(
      'new-folder-3',
    );
  });
});

// ─── Reading a subtree ───────────────────────────────────────────────────────

describe('descendantFiles', () => {
  it('finds every file under a folder', () => {
    const model = buildTree([
      mk('checkout/deep/a.spec.ts'),
      mk('checkout/b.spec.ts'),
      mk('other/c.spec.ts'),
    ]);
    const checkout = model.roots.find((node) => node.name === 'checkout')!;
    expect(descendantTestIds(checkout).sort()).toEqual([
      't-checkout/b.spec.ts',
      't-checkout/deep/a.spec.ts',
    ]);
  });

  it('records the FILE name even in feature grouping, where the row shows the test name', () => {
    const model = buildTree([mk('checkout/a.spec.ts', { name: 'Checkout totals', feature: 'C' })], {
      grouping: 'feature',
    });
    const group = model.roots[0]!;
    // The row reads "Checkout totals"; an undo entry has to say the path.
    expect(descendantFiles(group)).toEqual([
      { id: 't-checkout/a.spec.ts', path: 'checkout/a.spec.ts', name: 'a.spec.ts' },
    ]);
  });
});

describe('siblingDirIds', () => {
  it('is the other folders at the same level, for Alt-click', () => {
    const rows = allRowsOf([mk('a/1.spec.ts'), mk('b/2.spec.ts'), mk('c/3.spec.ts')]);
    const a = rows.find((row) => row.name === 'a')!;
    expect(siblingDirIds(rows, a)).toEqual(['b', 'c']);
  });

  it("does not reach into another folder's children", () => {
    const rows = allRowsOf([mk('a/deep/1.spec.ts'), mk('b/2.spec.ts')]);
    const a = rows.find((row) => row.name === 'a')!;
    expect(siblingDirIds(rows, a)).toEqual(['b']);
  });
});

// ─── Expansion ───────────────────────────────────────────────────────────────

describe('expandedFrom', () => {
  it('opens everything nobody closed — a brand-new folder is open', () => {
    expect([...expandedFrom(['a', 'b'], new Set())].sort()).toEqual(['a', 'b']);
  });

  it('keeps closed exactly what was closed', () => {
    expect([...expandedFrom(['a', 'b'], new Set(['a']))]).toEqual(['b']);
  });

  it('ignores a stale entry for a folder that no longer exists', () => {
    expect([...expandedFrom(['a'], new Set(['gone']))]).toEqual(['a']);
  });
});

// ─── Pending folders ─────────────────────────────────────────────────────────

describe('pending folders', () => {
  it('drops one the moment the tree has grown it for real', () => {
    expect(prunePending(['a/new', 'b/new'], new Set(['a/new']))).toEqual(['b/new']);
  });

  it("inserts a row at the end of its parent, at the parent's depth plus one", () => {
    const rows = allRowsOf([mk('checkout/a.spec.ts'), mk('root.spec.ts')]);
    const out = injectPendingFolders(rows, ['checkout/drafts']);
    expect(out.map((row) => `${row.depth}:${row.name}`)).toEqual([
      '0:checkout',
      '1:a.spec.ts',
      '1:drafts',
      '0:root.spec.ts',
    ]);
  });

  it('gives the row the namespaced id everything else addresses rows by', () => {
    const out = injectPendingFolders(allRowsOf([mk('root.spec.ts')]), ['drafts']);
    const drafts = out.find((row) => row.name === 'drafts')!;
    expect(drafts.id).toBe('d:drafts');
    expect(drafts.nodeId).toBe('drafts');
    expect(drafts.parentPath).toBe('');
  });

  it('puts a root-level pending folder at the end rather than the top', () => {
    const out = injectPendingFolders(allRowsOf([mk('checkout/a.spec.ts')]), ['drafts']);
    expect(out[out.length - 1]!.name).toBe('drafts');
  });

  it('nests one pending folder inside another', () => {
    const out = injectPendingFolders(allRowsOf([mk('root.spec.ts')]), ['drafts/inner', 'drafts']);
    expect(out.map((row) => `${row.depth}:${row.name}`)).toEqual([
      '0:root.spec.ts',
      '0:drafts',
      '1:inner',
    ]);
  });

  it('drops one whose parent is not in the list, rather than floating it to the root', () => {
    const out = injectPendingFolders(allRowsOf([mk('root.spec.ts')]), ['missing/drafts']);
    expect(out.some((row) => row.name === 'drafts')).toBe(false);
  });

  it('carries nested pending folders along when the outer one is renamed', () => {
    expect(renamePending(['a/new', 'a/new/inner', 'b/other'], 'a/new', 'a/drafts')).toEqual([
      'a/drafts',
      'a/drafts/inner',
      'b/other',
    ]);
  });

  it('does not rename a sibling that merely shares a prefix', () => {
    expect(renamePending(['a/new-2'], 'a/new', 'a/drafts')).toEqual(['a/new-2']);
  });
});

// ─── Operations to requests ──────────────────────────────────────────────────

describe('requestsForOps', () => {
  it('sends a folder move to the folders endpoint, never to a test id', () => {
    const { requests } = requestsForOps([
      op({ id: 'd:checkout', entity: 'dir', from: 'checkout', to: 'archive/checkout' }),
    ]);
    expect(requests).toEqual([
      { kind: 'move-folder', opId: 'd:checkout', from: 'checkout', to: 'archive/checkout' },
    ]);
  });

  it('sends one file move as one PATCH, with the namespace stripped', () => {
    const { requests } = requestsForOps([
      op({ id: 'f:abc', entity: 'file', from: 'a.spec.ts', to: 'checkout/a.spec.ts' }),
    ]);
    expect(requests).toEqual([
      { kind: 'move-file', opId: 'f:abc', testId: 'abc', to: 'checkout/a.spec.ts' },
    ]);
  });

  it('batches two or more file moves so the set is validated before anything is written', () => {
    const { requests } = requestsForOps([
      op({ id: 'f:one', entity: 'file', from: '1.spec.ts', to: 'x/1.spec.ts' }),
      op({ id: 'f:two', entity: 'file', from: '2.spec.ts', to: 'x/2.spec.ts' }),
    ]);
    expect(requests).toEqual([
      {
        kind: 'batch-move',
        opIds: ['f:one', 'f:two'],
        moves: [
          { testId: 'one', filePath: 'x/1.spec.ts' },
          { testId: 'two', filePath: 'x/2.spec.ts' },
        ],
      },
    ]);
  });

  it("splits a drag larger than the API's batch cap instead of being refused by it", () => {
    const ops = Array.from({ length: BATCH_LIMIT + 5 }, (_, index) =>
      op({ id: `f:${index}`, entity: 'file', from: `${index}.ts`, to: `x/${index}.ts` }),
    );
    const { requests } = requestsForOps(ops);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.kind).toBe('batch-move');
    // Five left over is fewer than two, so the tail is a plain batch of five.
    expect(requests[1]).toMatchObject({ kind: 'batch-move' });
    const moved = requests.flatMap((request) =>
      request.kind === 'batch-move' ? request.moves.length : 1,
    );
    expect(moved.reduce((a, b) => a + b, 0)).toBe(BATCH_LIMIT + 5);
  });

  it('turns a file copy into a duplicate-then-move, because there is no copy-to-path API', () => {
    const { requests } = requestsForOps([
      { kind: 'copy', id: 'f:abc', entity: 'file', from: 'a.spec.ts', to: 'x/a copy.spec.ts' },
    ]);
    expect(requests).toEqual([
      { kind: 'copy-file', opId: 'f:abc', testId: 'abc', to: 'x/a copy.spec.ts' },
    ]);
  });

  it('refuses a folder copy by name instead of quietly skipping it', () => {
    const { requests, unsupported } = requestsForOps([
      { kind: 'copy', id: 'd:checkout', entity: 'dir', from: 'checkout', to: 'x/checkout' },
    ]);
    expect(requests).toEqual([]);
    expect(unsupported[0]!.message).toContain('cannot be copied');
  });

  it('reads `entity`, not the path — a folder named like a file still goes to /folders', () => {
    const { requests } = requestsForOps([
      op({ id: 'd:a.spec.ts', entity: 'dir', from: 'a.spec.ts', to: 'x/a.spec.ts' }),
    ]);
    expect(requests[0]!.kind).toBe('move-folder');
  });
});

// ─── Edits to requests ───────────────────────────────────────────────────────

describe('requestForEdit', () => {
  it('undoes a file move with a PATCH on the test', () => {
    expect(requestForEdit({ kind: 'move', id: 'f:abc', from: 'x/a.ts', to: 'a.ts' })).toEqual({
      kind: 'move-file',
      opId: 'f:abc',
      testId: 'abc',
      to: 'a.ts',
    });
  });

  it('undoes a folder move with the folders endpoint — a d: id addresses nothing', () => {
    expect(requestForEdit({ kind: 'move', id: 'd:x/c', from: 'x/c', to: 'c' })).toEqual({
      kind: 'move-folder',
      opId: 'd:x/c',
      from: 'x/c',
      to: 'c',
    });
  });

  it('maps delete and restore to their own endpoints', () => {
    expect(requestForEdit({ kind: 'delete', id: 'f:abc', path: 'a.ts', name: 'a.ts' })).toEqual({
      kind: 'delete-file',
      testId: 'abc',
    });
    expect(requestForEdit({ kind: 'restore', id: 'f:abc', path: 'a.ts', name: 'a.ts' })).toEqual({
      kind: 'restore-file',
      testId: 'abc',
    });
  });

  it('has no way to restore a folder, and says so rather than guessing', () => {
    // Which is why a folder delete is recorded as one edit per file.
    expect(requestForEdit({ kind: 'restore', id: 'd:x', path: 'x', name: 'x' })).toBeNull();
  });

  it('refuses the whole list when one edit cannot be replayed', () => {
    expect(
      requestsForEdits([
        { kind: 'delete', id: 'f:a', path: 'a.ts', name: 'a.ts' },
        { kind: 'restore', id: 'd:x', path: 'x', name: 'x' },
      ]),
    ).toBeNull();
  });

  it('maps a whole list when every edit can', () => {
    expect(
      requestsForEdits([
        { kind: 'delete', id: 'f:a', path: 'a.ts', name: 'a.ts' },
        { kind: 'restore', id: 'f:b', path: 'b.ts', name: 'b.ts' },
      ]),
    ).toHaveLength(2);
  });
});

// ─── Messages ────────────────────────────────────────────────────────────────

describe('messages', () => {
  it('says nothing when nothing was refused', () => {
    expect(refusalSummary([])).toBeNull();
  });

  it('gives the first reason in full, then a count', () => {
    expect(refusalSummary([{ message: 'a is already there' }, { message: 'b too' }])).toBe(
      'a is already there (+1 more)',
    );
  });

  it('offers the undo when the whole gesture landed', () => {
    expect(outcomeMessage('Moved', 3, [])).toBe('Moved 3 items. Undo with ⌘Z.');
  });

  it('leads with the refusal when part of it did not', () => {
    expect(outcomeMessage('Moved', 1, [{ message: 'x already exists' }])).toBe(
      'Moved 1 item — x already exists',
    );
  });

  it('prefers the error the server actually sent', () => {
    expect(messageOf(new Error('checkout/a.spec.ts already exists'), 'Move failed')).toBe(
      'checkout/a.spec.ts already exists',
    );
    expect(messageOf({}, 'Move failed')).toBe('Move failed');
  });
});

// ─── Decorations ─────────────────────────────────────────────────────────────

describe('buildDecorations', () => {
  it('gives a file its own badge under its ROW id', () => {
    const model = buildTree([mk('a.spec.ts')]);
    const map = buildDecorations(model.roots, () => ({ lastResult: 'FAILED' }));
    expect(map.get('f:t-a.spec.ts')?.kind).toBe('failed');
  });

  it("folds a folder over every tally, not over each child's winning badge", () => {
    /*
     * Two dirty-and-failed files. Folding the winners would give the folder
     * `dirty 2` and report ZERO failures — and the count on a folder badge is
     * the number people trust before they expand anything.
     */
    const model = buildTree([mk('x/a.spec.ts'), mk('x/b.spec.ts')]);
    const map = buildDecorations(model.roots, () => ({ dirty: true, lastResult: 'FAILED' }));
    const folder = map.get('d:x');
    expect(folder?.kind).toBe('dirty');
    expect(folder?.count).toBe(2);

    const clean = buildDecorations(model.roots, () => ({ lastResult: 'FAILED' })).get('d:x');
    expect(clean?.kind).toBe('failed');
    expect(clean?.count).toBe(2);
  });

  it('has an entry for every row, null included, so a lookup never has to guess', () => {
    const model = buildTree([mk('x/a.spec.ts')]);
    const map = buildDecorations(model.roots, () => ({}));
    expect(map.has('d:x')).toBe(true);
    expect(map.get('d:x')).toBeNull();
  });
});

// ─── Grouping ────────────────────────────────────────────────────────────────

describe('structuralOpsAllowed', () => {
  it('is on for folders and off for features, which have no path to write', () => {
    expect(structuralOpsAllowed({ grouping: 'path' })).toBe(true);
    expect(structuralOpsAllowed({ grouping: 'feature' })).toBe(false);
  });
});

// ─── The contract the two row lists exist for ────────────────────────────────

describe('planning against the right row list', () => {
  const tests = [mk('checkout/a.spec.ts'), mk('checkout/b.spec.ts'), mk('archive/z.spec.ts')];

  it("moves a collapsed folder's contents when planned against every row", () => {
    const rows = allRowsOf(tests);
    const checkout = rows.find((row) => row.id === 'd:checkout')!;
    const archive = rows.find((row) => row.id === 'd:archive')!;
    const plan = planDropOn(rows, [checkout.id], archive.id, 'move');

    expect(plan.refusals).toEqual([]);
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]).toMatchObject({
      entity: 'dir',
      from: 'checkout',
      to: 'archive/checkout',
    });
    // One folder move, not two file moves — the prefix rewrite is atomic.
    expect(requestsForOps(plan.ops).requests).toEqual([
      { kind: 'move-folder', opId: 'd:checkout', from: 'checkout', to: 'archive/checkout' },
    ]);
  });

  it('reports the shortfall when planned against the VISIBLE rows instead', () => {
    /*
     * The bug the contract exists to prevent, pinned. `checkout` is collapsed,
     * so a file inside it is not in the visible list: planning a drag of that
     * file there cannot resolve it. It must come back as a refusal that names
     * the cause, never as a silently smaller gesture.
     */
    const visible = visibleRowsOf(tests, ['checkout']);
    expect(visible.some((row) => row.id === 'f:t-checkout/a.spec.ts')).toBe(false);

    const archive = visible.find((row) => row.id === 'd:archive')!;
    const plan = planDropOn(visible, ['f:t-checkout/a.spec.ts'], archive.id, 'move');

    expect(plan.ops).toEqual([]);
    expect(plan.refusals[0]?.reason).toBe('unresolved');
  });

  it('drags the whole selection when the grabbed row is part of it', () => {
    const rows = allRowsOf(tests);
    const ids = ['f:t-checkout/a.spec.ts', 'f:t-checkout/b.spec.ts'];
    const selection = { ...EMPTY_SELECTION, ids: new Set(ids), lead: ids[0]!, anchor: ids[0]! };
    const archive = rows.find((row) => row.id === 'd:archive')!;

    const plan = planDropOn(rows, [...selection.ids], archive.id, 'move');
    expect(plan.ops).toHaveLength(2);
    // Two files in one batch, so either both land or neither does.
    expect(requestsForOps(plan.ops).requests).toEqual([
      {
        kind: 'batch-move',
        opIds: ids,
        moves: [
          { testId: 't-checkout/a.spec.ts', filePath: 'archive/a.spec.ts' },
          { testId: 't-checkout/b.spec.ts', filePath: 'archive/b.spec.ts' },
        ],
      },
    ]);
  });
});

// ─── Wave 2 review fixes ─────────────────────────────────────────────────────

describe('rangesForSegments', () => {
  const segments = [{ name: 'hand-written' }, { name: 'checkout' }, { name: 'deep' }];

  it('gives every segment an empty highlight when nothing is being filtered', () => {
    expect(rangesForSegments(segments, undefined)).toEqual([
      { ranges: [], separatorMatched: false },
      { ranges: [], separatorMatched: false },
      { ranges: [], separatorMatched: false },
    ]);
  });

  it('rebases a hit inside a later segment onto that segment', () => {
    /*
     * The joined label is `hand-written/checkout/deep`. `check` starts at 13 in
     * that string and at 0 in the segment that has to draw it — threading the
     * label-relative range straight through would mark the wrong five characters,
     * and threading nothing (the bug) marks none at all.
     */
    const label = segments.map((s) => s.name).join('/');
    const start = label.indexOf('check');
    const out = rangesForSegments(segments, [{ start, end: start + 5 }]);
    expect(out[0]?.ranges).toEqual([]);
    expect(out[1]?.ranges).toEqual([{ start: 0, end: 5 }]);
    expect(out[2]?.ranges).toEqual([]);
  });

  it('clips a hit that straddles a separator into both segments and marks the slash', () => {
    const label = segments.map((s) => s.name).join('/');
    const start = label.indexOf('ten/che');
    const out = rangesForSegments(segments, [{ start, end: start + 'ten/che'.length }]);

    // `hand-written` ends at 12, so the three characters before the '/'.
    expect(out[0]?.ranges).toEqual([{ start: 9, end: 12 }]);
    expect(out[0]?.separatorMatched).toBe(false);
    expect(out[1]?.ranges).toEqual([{ start: 0, end: 3 }]);
    // The '/' drawn BEFORE `checkout` is inside the match, so it is marked too.
    expect(out[1]?.separatorMatched).toBe(true);
  });

  it('keeps several hits in one segment separate', () => {
    const out = rangesForSegments([{ name: 'abcabc' }], [
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
    expect(out[0]?.ranges).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
  });
});

describe('row id prefixes', () => {
  it('are whatever rows.ts mints, never a second copy of the rule', () => {
    const rows = allRowsOf([mk('checkout/a.spec.ts')]);
    const file = rows.find((row) => row.kind === 'file');
    const dir = rows.find((row) => row.kind === 'dir');
    expect(file?.id).toBe(`${FILE_ROW_PREFIX}${file?.nodeId}`);
    expect(dir?.id).toBe(`${DIR_ROW_PREFIX}${dir?.nodeId}`);
    expect(testIdOfRowId(file?.id ?? '')).toBe('t-checkout/a.spec.ts');
    expect(isDirRowId(dir?.id ?? '')).toBe(true);
    expect(isDirRowId(file?.id ?? '')).toBe(false);
  });
});

describe('opIdsOf', () => {
  it('names the ops behind a prefix of requests, batches expanded', () => {
    const requests = requestsForOps([
      op({ id: 'd:a', entity: 'dir', from: 'a', to: 'b/a' }),
      op({ id: 'f:1', entity: 'file', from: 'a/x.ts', to: 'b/x.ts' }),
      op({ id: 'f:2', entity: 'file', from: 'a/y.ts', to: 'b/y.ts' }),
    ]).requests;

    // The folder move goes first, the two file moves share one batch.
    expect(opIdsOf(requests)).toEqual(['d:a', 'f:1', 'f:2']);
    // Stopping after the folder move means only the folder landed.
    expect(opIdsOf(requests.slice(0, 1))).toEqual(['d:a']);
  });

  it('covers a copy, which carries its own op id', () => {
    const requests = requestsForOps([
      { kind: 'copy', id: 'f:1', entity: 'file', from: 'a/x.ts', to: 'b/x.ts' },
    ]).requests;
    expect(opIdsOf(requests)).toEqual(['f:1']);
  });
});

describe('partialMessage', () => {
  it('is the bare reason when nothing landed', () => {
    expect(partialMessage(0, 12, 'Server said no', true)).toBe('Server said no');
  });

  it('says how far it got, and whether undo can take it back', () => {
    /*
     * The count is the whole point: six moves DID happen, and "Move failed" would
     * send someone to repeat work the server already did.
     */
    expect(partialMessage(6, 12, 'Server said no', true)).toBe(
      '6 of 12 done, then stopped — Server said no ⌘Z takes back the 6.',
    );
    expect(partialMessage(6, 12, 'Server said no', false)).toBe(
      '6 of 12 done, then stopped — Server said no',
    );
  });
});

describe('files the view cannot see', () => {
  const tests = [mk('checkout/a.spec.ts'), mk('checkout/secret.spec.ts')];

  it('names the file a hide pattern removed', () => {
    const rows = allRowsOf(tests, { hide: ['secret.spec.ts'] });
    expect(rows.some((row) => row.path === 'checkout/secret.spec.ts')).toBe(false);
    expect([...hiddenFilePaths(tests, rows)]).toEqual(['checkout/secret.spec.ts']);
  });

  it('sees nothing hidden when every test has a row', () => {
    expect(hiddenFilePaths(tests, allRowsOf(tests)).size).toBe(0);
  });

  it('treats a hidden file as taking both its own name and its folder', () => {
    const hidden = new Set(['checkout/secret.spec.ts']);
    expect(hiddenNameTaken('checkout/secret.spec.ts', 'file', hidden)).toBe(true);
    expect(hiddenNameTaken('checkout/other.spec.ts', 'file', hidden)).toBe(false);
    // A folder exists here only as the prefix of a file path.
    expect(hiddenNameTaken('checkout', 'dir', hidden)).toBe(true);
    expect(hiddenNameTaken('archive', 'dir', hidden)).toBe(false);
    expect(hiddenNameTaken('checkout/secret.spec.ts', 'file', new Set())).toBe(false);
  });

  it('refuses the op that would land on it, and says why in words', () => {
    const hidden = new Set(['archive/a.spec.ts']);
    const moves = [
      op({ id: 'f:1', entity: 'file', from: 'checkout/a.spec.ts', to: 'archive/a.spec.ts' }),
      op({ id: 'f:2', entity: 'file', from: 'checkout/b.spec.ts', to: 'archive/b.spec.ts' }),
    ];
    const split = splitHiddenConflicts(moves, hidden);

    expect(split.ops.map((entry) => entry.id)).toEqual(['f:2']);
    expect(split.refused).toEqual([
      {
        id: 'f:1',
        path: 'checkout/a.spec.ts',
        message: hiddenTakenMessage('a.spec.ts'),
      },
    ]);
    // The sentence names the cause rather than the API's uniqueness error.
    expect(hiddenTakenMessage('a.spec.ts')).toContain('a hidden file has that name');
  });

  it('passes every op through when no pattern is hiding anything', () => {
    const moves = [op({ id: 'f:1', entity: 'file', from: 'a/x.ts', to: 'b/x.ts' })];
    expect(splitHiddenConflicts(moves, new Set()).ops).toEqual(moves);
  });
});

describe('unsaved folders', () => {
  const tests = [mk('checkout/a.spec.ts')];

  it('are separated from the rows the server knows about', () => {
    const rows = injectPendingFolders(allRowsOf(tests), ['checkout/draft']);
    const pending = new Set(['checkout/draft']);
    const draft = rows.find((row) => row.path === 'checkout/draft');
    expect(draft).toBeTruthy();

    const split = splitPending(rows, [draft?.id ?? '', 'f:t-checkout/a.spec.ts'], pending);
    expect(split.ids).toEqual(['f:t-checkout/a.spec.ts']);
    expect(split.pending.map((row) => row.path)).toEqual(['checkout/draft']);
  });

  it('keeps an id that resolves to no row, so the planner can refuse it by name', () => {
    const rows = allRowsOf(tests);
    expect(splitPending(rows, ['f:gone'], new Set()).ids).toEqual(['f:gone']);
  });

  it('explains the refusal in terms of the server, not of the panel', () => {
    const rows = injectPendingFolders(allRowsOf(tests), ['checkout/draft']);
    const draft = rows.filter((row) => row.path === 'checkout/draft');
    expect(pendingRefusal(draft, 'move')).toBe(
      'draft/ is not saved yet — there is nothing on the server to move. Put a file in it first.',
    );
    expect(pendingRefusal([...draft, ...draft], 'copy')).toContain('2 unsaved folders');
  });
});

describe('the drag payload', () => {
  const tests = [mk('checkout/a.spec.ts'), mk('checkout/b.spec.ts')];

  it('has a MIME type of its own, so a dragged sentence is not a file drag', () => {
    // Stated as a literal here on purpose: this string is a contract with every
    // other drop target in the app, and changing it must break a test.
    expect(TREE_DRAG_MIME).toBe('application/x-qaai-tree-rows+json');
  });

  it('round-trips the rows it was built from', () => {
    const rows = allRowsOf(tests);
    const ids = ['d:checkout', 'f:t-checkout/a.spec.ts'];
    const payload = treeDragPayload(rows, ids, 'p1');

    expect(payload).toEqual({
      v: 1,
      projectId: 'p1',
      rows: [
        { id: 'd:checkout', kind: 'dir', path: 'checkout', testId: null },
        {
          id: 'f:t-checkout/a.spec.ts',
          kind: 'file',
          path: 'checkout/a.spec.ts',
          testId: 't-checkout/a.spec.ts',
        },
      ],
    });
    expect(parseTreeDrag(JSON.stringify(payload))).toEqual(payload);
  });

  it('drops an id nothing resolves to rather than inventing a row for it', () => {
    expect(treeDragPayload(allRowsOf(tests), ['f:gone'], 'p1').rows).toEqual([]);
  });

  it('refuses anything that is not this payload', () => {
    // `dataTransfer` is an OS boundary: the string can come from another tab, an
    // older build, or any application that decided to write our MIME type.
    expect(parseTreeDrag(null)).toBeNull();
    expect(parseTreeDrag('')).toBeNull();
    expect(parseTreeDrag('checkout/a.spec.ts')).toBeNull();
    expect(parseTreeDrag('[]')).toBeNull();
    expect(parseTreeDrag(JSON.stringify({ v: 2, projectId: 'p1', rows: [] }))).toBeNull();
    expect(parseTreeDrag(JSON.stringify({ v: 1, rows: [] }))).toBeNull();
    expect(
      parseTreeDrag(JSON.stringify({ v: 1, projectId: 'p1', rows: [{ id: 'f:1', kind: 'x' }] })),
    ).toBeNull();
  });
});

describe('a compacted row addresses the folder it acts on', () => {
  const tests = [mk('a/b/c/x.spec.ts')];

  it('keeps the id at the outermost link and the path at the deepest', () => {
    const rows = allRowsOf(tests, { compactFolders: true });
    const row = rows.find((entry) => entry.kind === 'dir');
    expect(row?.name).toBe('a/b/c');
    expect(row?.nodeId).toBe('a');
    expect(row?.path).toBe('a/b/c');
  });

  it('scopes to a different tree depending on which of the two is passed', () => {
    /*
     * The bug behind "Set as root", pinned where it can be seen: scoping by the
     * row's `nodeId` roots the tree at `a` and leaves `b/c` on screen, while
     * scoping by the folder the row acts on roots it at `a/b/c`. `buildTree`
     * resolves a scope BEFORE compaction, which is why the deep path resolves at
     * all.
     */
    const byId = buildTree(tests, { compactFolders: true, scope: 'a' });
    expect(byId.roots.map((node) => node.name)).toEqual(['b/c']);

    const byPath = buildTree(tests, { compactFolders: true, scope: 'a/b/c' });
    expect(byPath.roots.map((node) => node.name)).toEqual(['x.spec.ts']);
    expect(byPath.scopeMissing).toBe(false);
  });
});
