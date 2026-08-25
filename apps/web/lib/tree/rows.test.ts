import { describe, expect, it } from 'vitest';
import { buildTree, flattenTree, allDirIds, type TreeTest } from './model';
import { panelRows, rowIdFor, rowById, testIdOf } from './rows';

function mk(filePath: string, extra: Partial<TreeTest> = {}): TreeTest {
  return {
    id: `t-${filePath}`,
    name: filePath.split('/').pop() ?? filePath,
    type: 'E2E',
    filePath,
    reviewFlags: [],
    ...extra,
  };
}

const rowsFor = (tests: TreeTest[], opts = {}) => {
  const model = buildTree(tests, opts);
  return panelRows(flattenTree(model.roots, new Set(allDirIds(model.roots))));
};

describe('panelRows', () => {
  it('gives every row an id no other row shares', () => {
    const rows = rowsFor([mk('checkout/a.spec.ts'), mk('checkout/b.spec.ts'), mk('root.spec.ts')]);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps a folder and a test that share a raw id apart', () => {
    /*
     * The collision the namespace exists for. A folder's model id is its path
     * and a file's is its test id; nothing guarantees the two generators never
     * produce the same string. Unprefixed, both rows would answer to one id and
     * every selection, cut and drop keyed on it would act on the wrong row.
     */
    const collide = 'checkout';
    const rows = rowsFor([mk('checkout/a.spec.ts'), mk('other.spec.ts', { id: collide })]);

    const folder = rows.find((r) => r.kind === 'dir' && r.name === 'checkout');
    const file = rows.find((r) => r.kind === 'file' && r.nodeId === collide);
    expect(folder).toBeDefined();
    expect(file).toBeDefined();
    expect(folder!.id).not.toBe(file!.id);
  });

  it('preserves the on-screen order the keyboard and Shift-range are defined against', () => {
    const model = buildTree([mk('b/x.spec.ts'), mk('a.spec.ts')]);
    const flat = flattenTree(model.roots, new Set(allDirIds(model.roots)));
    expect(panelRows(flat).map((r) => r.name)).toEqual(flat.map((r) => r.node.name));
  });

  it('names the containing folder, not the row above it', () => {
    const rows = rowsFor([mk('a/b/deep.spec.ts')]);
    const file = rows.find((r) => r.kind === 'file')!;
    expect(file.parentPath).toBe('a/b');
    expect(file.path).toBe('a/b/deep.spec.ts');
  });

  it('reports a compacted chain by the folder it acts on', () => {
    // Compaction draws three folders as one row, so "the row above" is not the
    // parent in any sense a move would accept — the node's own path is.
    const rows = rowsFor([mk('a/b/c/only.spec.ts')], { compactFolders: true });
    const dir = rows.find((r) => r.kind === 'dir')!;
    expect(dir.path.endsWith('c')).toBe(true);
    const file = rows.find((r) => r.kind === 'file')!;
    expect(file.parentPath).toBe('a/b/c');
  });

  it('gives a feature group no path, because there is nothing on disk to move', () => {
    const rows = rowsFor([mk('a.spec.ts', { feature: 'Checkout' })], { grouping: 'feature' });
    const group = rows.find((r) => r.kind === 'dir')!;
    expect(group.path).toBe('');
    expect(group.parentPath).toBe('');
  });

  it('marks folders open or closed, and leaves files alone', () => {
    const model = buildTree([mk('a/x.spec.ts')]);
    const open = panelRows(flattenTree(model.roots, new Set(allDirIds(model.roots))));
    expect(open.find((r) => r.kind === 'dir')!.expanded).toBe(true);
    expect(open.find((r) => r.kind === 'file')!.expanded).toBeUndefined();

    const shut = panelRows(flattenTree(model.roots, new Set()));
    expect(shut.find((r) => r.kind === 'dir')!.expanded).toBe(false);
    // A closed folder hides its children, so the file is not a row at all.
    expect(shut.some((r) => r.kind === 'file')).toBe(false);
  });

  it('round-trips a row id back to the test it names', () => {
    const rows = rowsFor([mk('a.spec.ts')]);
    const file = rows.find((r) => r.kind === 'file')!;
    expect(testIdOf(file)).toBe('t-a.spec.ts');
    expect(rowById(rows, file.id)).toBe(file);
    expect(rowById(rows, 'nope')).toBeNull();
    expect(testIdOf(rows.find((r) => r.kind === 'dir') ?? file)).not.toBe(undefined);
  });

  it('rowIdFor agrees with what panelRows put on the row', () => {
    const model = buildTree([mk('a/x.spec.ts')]);
    const flat = flattenTree(model.roots, new Set(allDirIds(model.roots)));
    for (const [i, row] of panelRows(flat).entries()) {
      expect(row.id).toBe(rowIdFor(flat[i]!.node));
    }
  });
});
