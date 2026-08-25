import { describe, expect, it } from 'vitest';
import {
  allDirIds,
  buildTree,
  findNode,
  flattenTree,
  isFixturePath,
  type BuildTreeOptions,
  type PathDir,
  type SortMode,
  type TreeDir,
  type TreeNode,
  type TreeTest,
} from './model';
import { DEFAULT_TREE_PREFS, sanitizeTreePrefs, treePrefsKey } from './prefs';

/** A test row. `id` defaults to the path, which keeps failure messages readable. */
function mk(filePath: string, extra: Partial<TreeTest> = {}): TreeTest {
  return {
    id: extra.id ?? filePath,
    name: extra.name ?? (filePath.split('/').pop() as string),
    type: extra.type ?? 'E2E',
    filePath,
    reviewFlags: extra.reviewFlags ?? [],
    ...(extra.feature !== undefined ? { feature: extra.feature } : {}),
    ...(extra.flakeRate !== undefined ? { flakeRate: extra.flakeRate } : {}),
    ...(extra.lastRunAt !== undefined ? { lastRunAt: extra.lastRunAt } : {}),
  };
}

function names(nodes: readonly TreeNode[]): string[] {
  return nodes.map((n) => n.name);
}

function dir(nodes: readonly TreeNode[], id: string): TreeDir {
  const found = findNode(nodes, id);
  if (!found || found.kind !== 'dir') throw new Error(`no dir ${id} in [${allDirIds(nodes).join(', ')}]`);
  return found;
}

function pathDir(nodes: readonly TreeNode[], id: string): PathDir {
  const found = dir(nodes, id);
  if (found.source !== 'path') throw new Error(`${id} is a feature group, not a folder`);
  return found;
}

/** Every row the tree would draw fully expanded, as `depth:name`. */
function shape(nodes: readonly TreeNode[]): string[] {
  return flattenTree(nodes, new Set(allDirIds(nodes))).map((row) => `${row.depth}:${row.node.name}`);
}

const SUITE = [
  mk('checkout/order-total.spec.ts'),
  mk('checkout/payment/card.spec.ts'),
  mk('checkout/payment/paypal.spec.ts'),
  mk('login.spec.ts'),
  mk('fixtures/users.json'),
];

describe('buildTree — the folder tree', () => {
  it('nests folders from the paths and puts folders before files', () => {
    const model = buildTree(SUITE);
    expect(shape(model.roots)).toEqual([
      '0:checkout',
      '1:payment',
      '2:card.spec.ts',
      '2:paypal.spec.ts',
      '1:order-total.spec.ts',
      '0:fixtures',
      '1:users.json',
      '0:login.spec.ts',
    ]);
  });

  it('gives files the test id and folders the folder path', () => {
    const model = buildTree(SUITE);
    expect(pathDir(model.roots, 'checkout/payment').path).toBe('checkout/payment');
    const file = findNode(model.roots, 'login.spec.ts');
    expect(file?.kind).toBe('file');
    expect(file?.id).toBe('login.spec.ts');
  });

  it('returns an empty tree, not a crash, for no tests', () => {
    const model = buildTree([]);
    expect(model.roots).toEqual([]);
    expect(model.fileCount).toBe(0);
    expect(model.hiddenCount).toBe(0);
    expect(model.scope).toEqual([]);
    expect(model.scopeMissing).toBe(false);
  });

  it.each([
    ['leading slash', '/checkout/a.spec.ts', 'checkout'],
    ['double slashes', 'checkout//a.spec.ts', 'checkout'],
    ['trailing slash', 'checkout/a.spec.ts/', 'checkout'],
  ])('normalises a %s', (_label, filePath, expectedRoot) => {
    const model = buildTree([mk(filePath)]);
    expect(names(model.roots)).toEqual([expectedRoot]);
  });

  it('drops a test with no usable path rather than inventing a row for it', () => {
    // The server validates filePath; the tree still must not render an unnamed
    // folder or throw on a row that arrived from an older write.
    const model = buildTree([mk('///'), mk('ok.spec.ts')]);
    expect(names(model.roots)).toEqual(['ok.spec.ts']);
    expect(model.fileCount).toBe(1);
  });

  it('keeps two tests that share a file path as two rows', () => {
    const model = buildTree([mk('a/dup.spec.ts', { id: 'one' }), mk('a/dup.spec.ts', { id: 'two' })]);
    expect(pathDir(model.roots, 'a').fileCount).toBe(2);
    expect(names(pathDir(model.roots, 'a').children)).toEqual(['dup.spec.ts', 'dup.spec.ts']);
  });

  it('aggregates file, flag, run and flake counters up every folder', () => {
    const model = buildTree([
      mk('a/b/one.spec.ts', { reviewFlags: ['selector'], flakeRate: 0.4, lastRunAt: '2026-01-02T00:00:00.000Z' }),
      mk('a/b/two.spec.ts', { flakeRate: 0.9, lastRunAt: '2026-03-04T00:00:00.000Z' }),
      mk('a/three.spec.ts', { reviewFlags: ['assert'] }),
    ]);
    const a = pathDir(model.roots, 'a');
    expect(a.fileCount).toBe(3);
    expect(a.flagCount).toBe(2);
    expect(a.flakeRate).toBeCloseTo(0.9);
    expect(a.lastRunAt).toBe(Date.parse('2026-03-04T00:00:00.000Z'));
    expect(model.fileCount).toBe(3);
    expect(model.flagCount).toBe(2);
  });

  it('reads lastRunAt as a Date as happily as an ISO string, and ignores nonsense', () => {
    const model = buildTree([
      mk('a/date.spec.ts', { lastRunAt: new Date('2026-05-05T00:00:00.000Z') }),
      mk('a/junk.spec.ts', { lastRunAt: 'not a date' }),
      mk('a/never.spec.ts', { lastRunAt: null }),
    ]);
    expect(pathDir(model.roots, 'a').lastRunAt).toBe(Date.parse('2026-05-05T00:00:00.000Z'));
  });

  it('treats a missing flakeRate as zero rather than NaN', () => {
    const model = buildTree([mk('a/x.spec.ts'), mk('a/y.spec.ts', { flakeRate: null })]);
    expect(pathDir(model.roots, 'a').flakeRate).toBe(0);
  });
});

describe('buildTree — compact folders (13)', () => {
  const chain = [mk('hand-written/checkout/deep/case.spec.ts')];

  it('leaves the chain alone when compaction is off', () => {
    expect(shape(buildTree(chain).roots)).toEqual([
      '0:hand-written',
      '1:checkout',
      '2:deep',
      '3:case.spec.ts',
    ]);
  });

  it('renders the chain as one row labelled with the whole path', () => {
    const model = buildTree(chain, { compactFolders: true });
    expect(shape(model.roots)).toEqual(['0:hand-written/checkout/deep', '1:case.spec.ts']);
  });

  it('keeps the full path, the segment trail and a stable id on the compacted row', () => {
    const model = buildTree(chain, { compactFolders: true });
    const row = model.roots[0] as PathDir;
    // `path` is the folder the row acts on — the deepest, as in VS Code — while
    // `id` stays the outermost so toggling compaction does not lose expansion.
    expect(row.path).toBe('hand-written/checkout/deep');
    expect(row.id).toBe('hand-written');
    expect(row.segments).toEqual([
      { name: 'hand-written', path: 'hand-written' },
      { name: 'checkout', path: 'hand-written/checkout' },
      { name: 'deep', path: 'hand-written/checkout/deep' },
    ]);
  });

  it('splits the chain exactly where a clicked segment says to', () => {
    // Clicking segment 2 of 3 must expand just that far: the caller hands the
    // segment's path back as `uncompacted` and the row breaks there.
    const model = buildTree(chain, { compactFolders: true, uncompacted: ['hand-written/checkout'] });
    expect(shape(model.roots)).toEqual([
      '0:hand-written',
      '1:checkout/deep',
      '2:case.spec.ts',
    ]);
  });

  it.each([
    ['a file sits beside the single subfolder', [mk('a/b/c.spec.ts'), mk('a/loose.spec.ts')], ['0:a', '1:b', '2:c.spec.ts', '1:loose.spec.ts']],
    ['there are two subfolders', [mk('a/b/c.spec.ts'), mk('a/d/e.spec.ts')], ['0:a', '1:b', '2:c.spec.ts', '1:d', '2:e.spec.ts']],
  ])('does not compact when %s', (_label, tests, expected) => {
    expect(shape(buildTree(tests, { compactFolders: true }).roots)).toEqual(expected);
  });

  it('compacts chains that start below the root too', () => {
    const model = buildTree([mk('a/b/c/x.spec.ts'), mk('a/other.spec.ts')], { compactFolders: true });
    expect(shape(model.roots)).toEqual(['0:a', '1:b/c', '2:x.spec.ts', '1:other.spec.ts']);
  });

  it('keeps the counters of the whole chain, including files hidden partway down it', () => {
    const model = buildTree([mk('a/b/c/x.spec.ts', { reviewFlags: ['selector'] }), mk('a/noisy.log')], {
      compactFolders: true,
      hide: ['*.log'],
    });
    const row = model.roots[0] as PathDir;
    expect(row.name).toBe('a/b/c');
    expect(row.fileCount).toBe(1);
    expect(row.flagCount).toBe(1);
    // The row that would have reported the hidden file is gone; the count is not.
    expect(row.hiddenCount).toBe(1);
  });
});

describe('buildTree — sort modes (19)', () => {
  const mixed = [
    mk('z-dir/inner.spec.ts'),
    mk('apple.spec.ts', { type: 'API', flakeRate: 0.1, lastRunAt: '2026-01-01T00:00:00.000Z' }),
    mk('banana.spec.ts', { type: 'E2E', flakeRate: 0.9, lastRunAt: '2026-06-01T00:00:00.000Z' }),
    mk('cherry.spec.ts', { type: 'API', flakeRate: 0.5 }),
  ];

  it.each<[SortMode]>([['name'], ['type'], ['lastRun'], ['flakiness']])(
    'puts folders before files in %s order',
    (sort) => {
      const model = buildTree(mixed, { sort });
      expect(model.roots[0]?.kind).toBe('dir');
    },
  );

  it('sorts names the way a person reads numbers', () => {
    const model = buildTree([mk('step10.spec.ts'), mk('step2.spec.ts'), mk('step1.spec.ts')]);
    expect(names(model.roots)).toEqual(['step1.spec.ts', 'step2.spec.ts', 'step10.spec.ts']);
  });

  it('sorts by test type, then name', () => {
    const model = buildTree(mixed, { sort: 'type' });
    expect(names(model.roots)).toEqual(['z-dir', 'apple.spec.ts', 'cherry.spec.ts', 'banana.spec.ts']);
  });

  it('sorts most recent run first and sinks the never-run', () => {
    const model = buildTree(mixed, { sort: 'lastRun' });
    // cherry has never run: unknown, not old, so it goes last however the
    // others are ordered.
    expect(names(model.roots)).toEqual(['z-dir', 'banana.spec.ts', 'apple.spec.ts', 'cherry.spec.ts']);
  });

  it('sorts the flakiest first', () => {
    const model = buildTree(mixed, { sort: 'flakiness' });
    expect(names(model.roots)).toEqual(['z-dir', 'banana.spec.ts', 'cherry.spec.ts', 'apple.spec.ts']);
  });

  it('orders folders by their worst descendant, not by their own name', () => {
    const model = buildTree(
      [mk('calm/a.spec.ts', { flakeRate: 0.1 }), mk('bad/b.spec.ts', { flakeRate: 0.8 })],
      { sort: 'flakiness' },
    );
    expect(names(model.roots)).toEqual(['bad', 'calm']);
  });

  it('orders folders by their most recent descendant run', () => {
    const model = buildTree(
      [
        mk('stale/a.spec.ts', { lastRunAt: '2026-01-01T00:00:00.000Z' }),
        mk('fresh/b.spec.ts', { lastRunAt: '2026-08-01T00:00:00.000Z' }),
        mk('unrun/c.spec.ts'),
      ],
      { sort: 'lastRun' },
    );
    expect(names(model.roots)).toEqual(['fresh', 'stale', 'unrun']);
  });

  it.each<[SortMode]>([['name'], ['type'], ['lastRun'], ['flakiness']])(
    'is total in %s order — rows that tie on everything still order by id',
    (sort) => {
      // Same name, same type, same (absent) run and flake data. Without the id
      // tiebreak these two rows would be free to swap between renders.
      const tests = [mk('a/same.spec.ts', { id: 'zzz' }), mk('a/same.spec.ts', { id: 'aaa' })];
      const forwards = buildTree(tests, { sort });
      const backwards = buildTree([...tests].reverse(), { sort });
      const ids = (m: ReturnType<typeof buildTree>) => pathDir(m.roots, 'a').children.map((n) => n.id);
      expect(ids(forwards)).toEqual(['aaa', 'zzz']);
      expect(ids(backwards)).toEqual(['aaa', 'zzz']);
    },
  );

  it('sorts every level, not just the roots', () => {
    const model = buildTree([mk('a/z.spec.ts'), mk('a/b/y.spec.ts'), mk('a/b/x.spec.ts')]);
    expect(names(pathDir(model.roots, 'a/b').children)).toEqual(['x.spec.ts', 'y.spec.ts']);
  });
});

describe('buildTree — hide patterns (21)', () => {
  const noisy = [
    mk('checkout/a.spec.ts'),
    mk('checkout/debug.log'),
    mk('checkout/snapshots/one.png'),
    mk('fixtures/users.json'),
    mk('root.log'),
  ];

  it.each([
    ['a bare name at any depth', ['*.log'], ['checkout', 'fixtures'], 2],
    ['a whole folder by path', ['fixtures/**'], ['checkout', 'root.log'], 1],
    ['a folder by bare name at depth', ['snapshots'], ['checkout', 'fixtures', 'root.log'], 1],
    ['a rooted path', ['checkout/debug.log'], ['checkout', 'fixtures', 'root.log'], 1],
    ['a ** in the middle', ['checkout/**/*.png'], ['checkout', 'fixtures', 'root.log'], 1],
    ['everything', ['**'], [], 5],
  ])('hides %s and still counts what it hid', (_label, hide, expectedRoots, expectedHidden) => {
    const model = buildTree(noisy, { hide });
    expect(names(model.roots)).toEqual(expectedRoots);
    expect(model.hiddenCount).toBe(expectedHidden);
  });

  it('hides the folder itself, not only what is under it, for `x/**`', () => {
    const model = buildTree(noisy, { hide: ['fixtures/**'] });
    expect(findNode(model.roots, 'fixtures')).toBeNull();
  });

  it('drops a folder that loses every file, and moves the count up to its parent', () => {
    const model = buildTree([mk('a/b/only.log'), mk('a/keep.spec.ts')], { hide: ['*.log'] });
    expect(shape(model.roots)).toEqual(['0:a', '1:keep.spec.ts']);
    expect(pathDir(model.roots, 'a').hiddenCount).toBe(1);
    expect(model.hiddenCount).toBe(1);
  });

  it('counts hidden files on every folder above them', () => {
    const model = buildTree([mk('a/b/c/x.log'), mk('a/b/keep.spec.ts'), mk('a/y.log')], { hide: ['*.log'] });
    expect(pathDir(model.roots, 'a').hiddenCount).toBe(2);
    expect(pathDir(model.roots, 'a/b').hiddenCount).toBe(1);
    expect(model.hiddenCount).toBe(2);
  });

  it('matches case-insensitively, because a hide box is not a shell', () => {
    const model = buildTree([mk('a/NOISE.LOG'), mk('a/keep.spec.ts')], { hide: ['*.log'] });
    expect(names(pathDir(model.roots, 'a').children)).toEqual(['keep.spec.ts']);
  });

  it('only lets a trailing-slash pattern hide folders', () => {
    const model = buildTree([mk('snapshots'), mk('a/snapshots/x.png')], { hide: ['snapshots/'] });
    // The root-level *file* called `snapshots` survives; the folder does not.
    expect(names(model.roots)).toEqual(['snapshots']);
    expect(model.roots[0]?.kind).toBe('file');
    expect(model.hiddenCount).toBe(1);
  });

  it.each([
    ['blank', ['   ']],
    ['empty', ['']],
    ['a bare slash', ['/']],
    ['far too long', ['a'.repeat(400)]],
  ])('ignores a %s pattern instead of hiding everything', (_label, hide) => {
    const model = buildTree(noisy, { hide });
    expect(model.hiddenCount).toBe(0);
    expect(model.fileCount).toBe(5);
  });

  it.each([
    ['./a/x.log', 1],
    ['/a/x.log', 1],
    ['a/x.log', 1],
  ])('reads %s as the same rooted path', (pattern, expected) => {
    const model = buildTree([mk('a/x.log'), mk('a/y.spec.ts')], { hide: [pattern] });
    expect(model.hiddenCount).toBe(expected);
  });

  it('treats pattern characters as literals — a pattern is not a regular expression', () => {
    // `.` and `+` mean themselves. If these ever compiled to a RegExp, `.*`
    // would hide the whole project and `a+b` would throw or match nothing.
    const tests = [mk('a.b.spec.ts'), mk('axbxspecxts'), mk('.hidden'), mk('a+b.spec.ts')];
    expect(buildTree(tests, { hide: ['a.b.spec.ts'] }).fileCount).toBe(3);
    expect(buildTree(tests, { hide: ['.*'] }).fileCount).toBe(3);
    expect(buildTree(tests, { hide: ['a+b.spec.ts'] }).fileCount).toBe(3);
    expect(buildTree(tests, { hide: ['(a|b)'] }).fileCount).toBe(4);
  });

  it('does not let a single-star pattern cross a folder boundary', () => {
    const model = buildTree([mk('a/b/deep.log'), mk('a/shallow.log')], { hide: ['a/*.log'] });
    expect(model.hiddenCount).toBe(1);
    expect(findNode(model.roots, 'a/b')).not.toBeNull();
  });

  it('lets `**` stand for zero folders as well as many', () => {
    const model = buildTree([mk('a/x.spec.ts'), mk('a/b/c/x.spec.ts')], { hide: ['a/**/x.spec.ts'] });
    expect(model.hiddenCount).toBe(2);
  });
});

describe('a hide pattern cannot wedge the tab', () => {
  it('decides a pathological `**` pattern in bounded time', () => {
    /*
     * The unmemoised matcher forked once per remaining segment for every `**`,
     * so five groups against a deep path that never matches took longer than
     * anyone waits. A hide pattern is typed by a person and PERSISTED per
     * project, so one bad one wedged the tab on every load and the only escape
     * was clearing localStorage.
     *
     * Two seconds is a deliberately loose ceiling: memoised, this decides in
     * single-digit milliseconds, and what it guards against runs for minutes —
     * so there is no timing window narrow enough to flake on a loaded CI box.
     */
    const deep = Array.from({ length: 24 }, (_, i) => `d${i}`).join('/');
    const started = Date.now();
    const model = buildTree([mk(`${deep}/never-matches.spec.ts`)], {
      hide: ['**/**/**/**/**/nope'],
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    // And it still answers correctly: nothing matched, so nothing is hidden.
    expect(model.hiddenCount).toBe(0);
  });

  it('still matches across depth once memoised', () => {
    const model = buildTree([mk('a/b/c/d/keep.spec.ts'), mk('a/b/c/d/drop.log')], {
      hide: ['a/**/*.log'],
    });
    expect(model.hiddenCount).toBe(1);
  });
});

describe('buildTree — scope to a folder (18)', () => {
  it('makes the folder the root and hands back the way out', () => {
    const model = buildTree(SUITE, { scope: 'checkout/payment' });
    expect(names(model.roots)).toEqual(['card.spec.ts', 'paypal.spec.ts']);
    expect(model.scope).toEqual([
      { name: 'checkout', id: 'checkout' },
      { name: 'payment', id: 'checkout/payment' },
    ]);
    expect(model.scopeMissing).toBe(false);
  });

  it('reports the scoped folder’s counters, not the project’s', () => {
    const model = buildTree([...SUITE, mk('checkout/payment/skip.log')], {
      scope: 'checkout/payment',
      hide: ['*.log'],
    });
    expect(model.fileCount).toBe(2);
    expect(model.hiddenCount).toBe(1);
  });

  it.each([
    ['a folder that no longer exists', 'checkout/gone'],
    ['a file rather than a folder', 'login.spec.ts'],
    ['a path from another project', 'nowhere/at/all'],
  ])('degrades to the whole tree for %s', (_label, scope) => {
    const model = buildTree(SUITE, { scope });
    // An empty panel would read as "this project has no tests", which is the
    // one thing a stale preference must never be able to say.
    expect(model.scopeMissing).toBe(true);
    expect(names(model.roots)).toEqual(['checkout', 'fixtures', 'login.spec.ts']);
    expect(model.scope).toEqual([]);
  });

  it('degrades when the scoped folder is hidden by a pattern', () => {
    const model = buildTree(SUITE, { scope: 'fixtures', hide: ['fixtures/**'] });
    expect(model.scopeMissing).toBe(true);
    expect(model.fileCount).toBe(4);
  });

  it('resolves a folder that compaction would have swallowed', () => {
    // Scope is resolved before compaction, so `a/b` is findable even though it
    // renders as part of the row `a/b/c`.
    const model = buildTree([mk('a/b/c/x.spec.ts')], { scope: 'a/b', compactFolders: true });
    expect(model.scopeMissing).toBe(false);
    expect(shape(model.roots)).toEqual(['0:c', '1:x.spec.ts']);
    expect(model.scope.map((c) => c.id)).toEqual(['a', 'a/b']);
  });

  it('ignores an empty scope string as meaning the root', () => {
    const model = buildTree(SUITE, { scope: '' });
    expect(model.scopeMissing).toBe(false);
    expect(model.scope).toEqual([]);
    expect(model.fileCount).toBe(5);
  });
});

describe('buildTree — group by feature (27)', () => {
  const featured = [
    mk('checkout/a.spec.ts', { name: 'Order total', feature: 'Checkout' }),
    mk('checkout/b.spec.ts', { name: 'Applies a coupon', feature: 'Checkout' }),
    mk('login/c.spec.ts', { name: 'Signs in', feature: 'Auth' }),
    mk('misc/d.spec.ts', { name: 'Unsorted' }),
  ];

  it('groups by the feature field and labels rows with the test name', () => {
    const model = buildTree(featured, { grouping: 'feature' });
    expect(shape(model.roots)).toEqual([
      '0:Auth',
      '1:Signs in',
      '0:Checkout',
      '1:Applies a coupon',
      '1:Order total',
      '0:No feature',
      '1:Unsorted',
    ]);
  });

  it('gives feature groups a synthetic id and no path at all', () => {
    const model = buildTree(featured, { grouping: 'feature' });
    const group = dir(model.roots, 'feature:Checkout');
    expect(group.source).toBe('feature');
    expect(group.path).toBeUndefined();
    expect(group.name).toBe('Checkout');
    // The missing `path` is the point: nothing can offer "rename folder" here.
    expect(group.source === 'feature' && group.feature).toBe('Checkout');
  });

  it('collects the tests with no feature under one stable group', () => {
    const model = buildTree(
      [mk('a.spec.ts', { feature: null }), mk('b.spec.ts', { feature: '   ' }), mk('c.spec.ts')],
      { grouping: 'feature' },
    );
    expect(names(model.roots)).toEqual(['No feature']);
    expect(model.roots[0]?.id).toBe('feature:');
    expect(dir(model.roots, 'feature:').fileCount).toBe(3);
  });

  it('keeps the file path on the row even though the label is the test name', () => {
    const model = buildTree(featured, { grouping: 'feature' });
    const file = findNode(model.roots, 'login/c.spec.ts');
    expect(file?.kind === 'file' && file.path).toBe('login/c.spec.ts');
    expect(file?.name).toBe('Signs in');
  });

  it('applies hide patterns to the file path, not to the label', () => {
    const model = buildTree(featured, { grouping: 'feature', hide: ['checkout/**'] });
    expect(names(model.roots)).toEqual(['Auth', 'No feature']);
    expect(model.hiddenCount).toBe(2);
  });

  it('sorts inside a group by the chosen mode', () => {
    const model = buildTree(
      [
        mk('a.spec.ts', { name: 'Calm', feature: 'F', flakeRate: 0.1 }),
        mk('b.spec.ts', { name: 'Flaky', feature: 'F', flakeRate: 0.7 }),
      ],
      { grouping: 'feature', sort: 'flakiness' },
    );
    expect(names(dir(model.roots, 'feature:F').children)).toEqual(['Flaky', 'Calm']);
  });

  it('scopes to a feature group by its id', () => {
    const model = buildTree(featured, { grouping: 'feature', scope: 'feature:Checkout' });
    expect(names(model.roots)).toEqual(['Applies a coupon', 'Order total']);
    expect(model.scope).toEqual([{ name: 'Checkout', id: 'feature:Checkout' }]);
  });

  it('is untouched by compaction — a feature group is never a folder chain', () => {
    const model = buildTree(featured, { grouping: 'feature', compactFolders: true });
    expect(names(model.roots)).toEqual(['Auth', 'Checkout', 'No feature']);
  });

  it('reports which grouping and sort produced the tree', () => {
    const model = buildTree(featured, { grouping: 'feature', sort: 'lastRun' });
    expect(model.grouping).toBe('feature');
    expect(model.sort).toBe('lastRun');
  });
});

describe('reading a built tree', () => {
  it('lists every folder id for expand-all', () => {
    expect(allDirIds(buildTree(SUITE).roots)).toEqual(['checkout', 'checkout/payment', 'fixtures']);
  });

  it('finds a node anywhere by id, and null when there is none', () => {
    const model = buildTree(SUITE);
    expect(findNode(model.roots, 'checkout/payment/card.spec.ts')?.name).toBe('card.spec.ts');
    expect(findNode(model.roots, 'nope')).toBeNull();
  });

  it('flattens only what is open', () => {
    const model = buildTree(SUITE);
    const rows = flattenTree(model.roots, new Set(['checkout']));
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      '0:checkout',
      '1:payment',
      '1:order-total.spec.ts',
      '0:fixtures',
      '0:login.spec.ts',
    ]);
    expect(rows[0]?.expanded).toBe(true);
    expect(rows[1]?.expanded).toBe(false);
  });

  it('unions the forced set with the open one, leaving the open one alone', () => {
    // The filter opens folders to show matches; it must not have to remember,
    // and later restore, what the person had actually opened.
    const model = buildTree(SUITE);
    const open = new Set(['checkout']);
    const rows = flattenTree(model.roots, open, new Set(['fixtures']));
    expect(rows.map((r) => r.node.name)).toContain('users.json');
    expect(open).toEqual(new Set(['checkout']));
  });

  it('never marks a file as expanded', () => {
    const model = buildTree(SUITE);
    const rows = flattenTree(model.roots, new Set(allDirIds(model.roots)));
    expect(rows.filter((r) => r.node.kind === 'file').every((r) => !r.expanded)).toBe(true);
  });

  it('knows a fixture path from a test path', () => {
    expect(isFixturePath('fixtures/users.json')).toBe(true);
    expect(isFixturePath('checkout/fixtures/users.json')).toBe(false);
  });
});

describe('buildTree — the features together', () => {
  it('hides, scopes, sorts and compacts in an order that keeps each one right', () => {
    const options: BuildTreeOptions = {
      hide: ['*.log'],
      scope: 'suite',
      sort: 'flakiness',
      compactFolders: true,
    };
    const model = buildTree(
      [
        mk('suite/slow/deep/flaky.spec.ts', { flakeRate: 0.9 }),
        mk('suite/calm.spec.ts', { flakeRate: 0.1 }),
        mk('suite/slow/noise.log'),
        mk('elsewhere/other.spec.ts'),
      ],
      options,
    );
    expect(shape(model.roots)).toEqual(['0:slow/deep', '1:flaky.spec.ts', '0:calm.spec.ts']);
    expect(model.hiddenCount).toBe(1);
    expect(model.fileCount).toBe(2);
    expect((model.roots[0] as PathDir).segments.map((s) => s.path)).toEqual([
      'suite/slow',
      'suite/slow/deep',
    ]);
  });

  it('does not mutate the tests it was handed', () => {
    const tests = [mk('a/x.spec.ts')];
    const snapshot = JSON.stringify(tests);
    buildTree(tests, { hide: ['**'], compactFolders: true, sort: 'flakiness' });
    expect(JSON.stringify(tests)).toBe(snapshot);
  });
});

describe('prefs', () => {
  it('keys storage per project', () => {
    expect(treePrefsKey('proj_123')).toBe('qaai.tree.prefs.proj_123');
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['a number', 7],
    ['an array', []],
  ])('falls back to the defaults for %s', (_label, value) => {
    expect(sanitizeTreePrefs(value)).toEqual(DEFAULT_TREE_PREFS);
  });

  it('keeps the fields it recognises and defaults the rest independently', () => {
    // One stale key must not reset the other four — this is a year of somebody's
    // settings, written by older versions of this same app.
    // Spread from the defaults rather than restated: a hand-written copy of the
    // whole object turns "we added a preference" into a failing test about
    // nothing, and the thing under test here is the per-field fallback.
    expect(sanitizeTreePrefs({ sort: 'gone', grouping: 'feature', compactFolders: true })).toEqual({
      ...DEFAULT_TREE_PREFS,
      sort: 'name',
      grouping: 'feature',
      compactFolders: true,
    });
  });

  it('cleans the hide list rather than trusting it', () => {
    const prefs = sanitizeTreePrefs({ hide: ['  *.log  ', '', 42, 'a'.repeat(300), 'ok'] });
    expect(prefs.hide).toEqual(['*.log', 'ok']);
  });

  it('caps the hide list', () => {
    const prefs = sanitizeTreePrefs({ hide: Array.from({ length: 200 }, (_, i) => `p${i}`) });
    expect(prefs.hide).toHaveLength(50);
  });

  it('reads an empty scope as the root', () => {
    expect(sanitizeTreePrefs({ scope: '' }).scope).toBeNull();
    expect(sanitizeTreePrefs({ scope: 'a/b' }).scope).toBe('a/b');
  });
});
