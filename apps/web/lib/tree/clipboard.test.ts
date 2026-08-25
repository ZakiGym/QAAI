import { describe, expect, it } from 'vitest';
import {
  baseName,
  copy,
  cut,
  cutIds,
  folderTargetOf,
  isCut,
  isWithin,
  joinPath,
  parentOf,
  paste,
  planOps,
  pruneContained,
  resolveIds,
  splitName,
  uniqueName,
  type ClipboardState,
  type RefusalReason,
} from './clipboard';
import type { TreeRow } from './selection';

/**
 * A feature group: a folder row with NO path, which is what `rows.ts` produces
 * under `grouping: 'feature'`. It is the one row that looks like a container and
 * is not, and `''` is also the root — so every function that takes a path has to
 * be able to tell "the root" from "nowhere".
 */
function group(name: string): TreeRow {
  return { id: `d:feature:${name}`, kind: 'dir', name, path: '', parentPath: '', depth: 0, expanded: true };
}

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

function dir(path: string): TreeRow {
  const slash = path.lastIndexOf('/');
  return {
    id: `d:${path}`,
    kind: 'dir',
    name: slash === -1 ? path : path.slice(slash + 1),
    path,
    parentPath: slash === -1 ? '' : path.slice(0, slash),
    depth: path.split('/').length - 1,
    expanded: true,
  };
}

/**
 * Every row in the tree, collapsed folders included — which is what `planOps`
 * documents that it needs. `checkout-v2` is here to catch a prefix test written
 * without the separator.
 */
const ROWS: TreeRow[] = [
  dir('checkout'),
  file('checkout/cart.spec.ts'),
  file('checkout/order.spec.ts'),
  dir('checkout/sub'),
  file('checkout/sub/cart.spec.ts'),
  dir('checkout-v2'),
  dir('fixtures'),
  file('fixtures/users.json'),
  file('login.spec.ts'),
];

const id = (path: string): string => (ROWS.find((row) => row.path === path)?.id ?? `missing:${path}`);

const reasons = (refusals: { reason: RefusalReason }[]): RefusalReason[] =>
  refusals.map((refusal) => refusal.reason);

// ─── Paths ───────────────────────────────────────────────────────────────────

describe('path helpers', () => {
  const parents: Array<[string, string]> = [
    ['checkout/order.spec.ts', 'checkout'],
    ['checkout/sub/deep.spec.ts', 'checkout/sub'],
    ['login.spec.ts', ''],
    ['', ''],
  ];
  it.each(parents)('parentOf(%s) is %s', (path, expected) => {
    expect(parentOf(path)).toBe(expected);
  });

  const bases: Array<[string, string]> = [
    ['checkout/order.spec.ts', 'order.spec.ts'],
    ['login.spec.ts', 'login.spec.ts'],
    ['', ''],
  ];
  it.each(bases)('baseName(%s) is %s', (path, expected) => {
    expect(baseName(path)).toBe(expected);
  });

  const joins: Array<[string, string, string]> = [
    ['checkout', 'a.ts', 'checkout/a.ts'],
    ['', 'a.ts', 'a.ts'],
    ['a/b', 'c', 'a/b/c'],
  ];
  it.each(joins)('joinPath(%s, %s) is %s', (folder, name, expected) => {
    expect(joinPath(folder, name)).toBe(expected);
  });

  /*
   * The separator in the prefix test is load-bearing. Without it `checkout-v2`
   * reads as a child of `checkout` and a legal move into a sibling folder is
   * refused as recursion.
   */
  const within: Array<[string, string, boolean]> = [
    ['checkout/a.ts', 'checkout', true],
    ['checkout/sub/a.ts', 'checkout', true],
    ['checkout', 'checkout', false],
    ['checkout-v2/a.ts', 'checkout', false],
    ['checkoutx', 'checkout', false],
    ['anything', '', true],
    ['', '', false],
  ];
  it.each(within)('isWithin(%s, %s) is %s', (path, ancestor, expected) => {
    expect(isWithin(path, ancestor)).toBe(expected);
  });

  const splits: Array<[string, string, string]> = [
    ['order.spec.ts', 'order.spec', '.ts'],
    ['users.json', 'users', '.json'],
    ['checkout', 'checkout', ''],
    ['.gitignore', '.gitignore', ''],
    ['.env.local', '.env', '.local'],
  ];
  it.each(splits)('splitName(%s) is %s + %s', (name, stem, ext) => {
    expect(splitName(name)).toEqual({ stem, ext });
  });
});

describe('uniqueName', () => {
  const cases: Array<[string, string[], string]> = [
    ['a free name is left alone', ['b.ts'], 'a.ts'],
    ['the first clash gets " copy"', ['a.ts'], 'a copy.ts'],
    ['the second clash counts up', ['a.ts', 'a copy.ts'], 'a copy 2.ts'],
    ['and keeps counting', ['a.ts', 'a copy.ts', 'a copy 2.ts'], 'a copy 3.ts'],
  ];
  it.each(cases)('%s', (_name, taken, expected) => {
    expect(uniqueName('a.ts', new Set(taken))).toBe(expected);
  });

  it('keeps the real extension, not the first dot', () => {
    expect(uniqueName('order.spec.ts', new Set(['order.spec.ts']))).toBe('order.spec copy.ts');
  });

  it('treats a folder as all name', () => {
    expect(uniqueName('checkout', new Set(['checkout']))).toBe('checkout copy');
  });

  it('treats a dotfile as all name', () => {
    expect(uniqueName('.gitignore', new Set(['.gitignore']))).toBe('.gitignore copy');
  });

  /* Copying a copy must not stack suffixes into `a copy copy copy.ts`. */
  it('re-uses the root when the source is itself a copy', () => {
    expect(uniqueName('a copy.ts', new Set(['a copy.ts']))).toBe('a copy 2.ts');
    expect(uniqueName('a copy 2.ts', new Set(['a copy.ts', 'a copy 2.ts']))).toBe('a copy 3.ts');
  });

  /*
   * The number may never go DOWN. `a copy 2.ts` duplicated into a folder where
   * `a copy.ts` happens to be free used to come back as `a copy.ts` — a file
   * that sorts ABOVE the thing it was copied from and reads as the original.
   * The counter starts from the source's own number, which is the VS Code rule
   * this function's own comment claimed to implement.
   */
  const numbered: Array<[string, string, string[], string]> = [
    ['counts up from the source number', 'a copy 2.ts', ['a copy 2.ts'], 'a copy 3.ts'],
    ['skips a number taken above it', 'a copy 2.ts', ['a copy 2.ts', 'a copy 3.ts'], 'a copy 4.ts'],
    ['counts past nine', 'a copy 9.ts', ['a copy 9.ts'], 'a copy 10.ts'],
    ['floors a bogus zero', 'a copy 0.ts', ['a copy 0.ts'], 'a copy 2.ts'],
  ];
  it.each(numbered)('%s', (_name, source, taken, expected) => {
    expect(uniqueName(source, new Set(taken))).toBe(expected);
  });

  it('never returns a name that is already taken, however deep the run', () => {
    const taken = new Set(['a.ts', 'a copy.ts', 'a copy 2.ts', 'a copy 3.ts', 'a copy 4.ts']);
    const next = uniqueName('a copy 2.ts', taken);
    expect(next).toBe('a copy 5.ts');
    expect(taken.has(next)).toBe(false);
  });
});

// ─── Capture ─────────────────────────────────────────────────────────────────

describe('cut and copy', () => {
  it('snapshots the rows it was given', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts')]);
    expect(state).toEqual({
      mode: 'cut',
      entries: [
        {
          id: id('checkout/cart.spec.ts'),
          path: 'checkout/cart.spec.ts',
          name: 'cart.spec.ts',
          kind: 'file',
        },
      ],
      unresolved: [],
    });
  });

  it('returns null for no ids at all, so ⌘C on nothing keeps what was copied', () => {
    expect(cut(ROWS, [])).toBeNull();
    expect(copy(ROWS, [])).toBeNull();
  });

  /*
   * The bug this replaces. An id with no row used to be dropped on the floor:
   * `cut` returned null, ⌘V then said "nothing to do", and the real cause — the
   * caller handed the VISIBLE rows, so everything inside a collapsed folder was
   * invisible to the capture — was never mentioned to anyone. The ids are kept
   * and turned into a refusal that names the cause instead.
   */
  it('keeps the ids it could not resolve instead of dropping them', () => {
    const state = cut(ROWS, ['t:ghost.spec.ts']);
    expect(state).toEqual({ mode: 'cut', entries: [], unresolved: ['t:ghost.spec.ts'] });
    expect(copy(ROWS, ['t:ghost.spec.ts'])?.unresolved).toEqual(['t:ghost.spec.ts']);
  });

  it('separates what resolved from what did not, in one gesture', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts'), 't:ghost.spec.ts']);
    expect(state?.entries.map((entry) => entry.path)).toEqual(['checkout/cart.spec.ts']);
    expect(state?.unresolved).toEqual(['t:ghost.spec.ts']);
  });

  /*
   * The concrete case, spelled out: a file selected before its folder was
   * collapsed. `reconcileSelection` keeps it selected on purpose, so the ids
   * arriving here are real — it is the ROW LIST that is short, and the capture
   * has to say so rather than quietly cut two files out of three.
   */
  it('reports a selection that lives inside a collapsed folder', () => {
    const visible = ROWS.filter((row) => !row.path.startsWith('checkout/sub/'));
    const state = cut(visible, [id('checkout/cart.spec.ts'), id('checkout/sub/cart.spec.ts')]);
    expect(state?.unresolved).toEqual([id('checkout/sub/cart.spec.ts')]);
    const result = paste(visible, state, 'fixtures');
    expect(reasons(result.refusals)).toEqual(['unresolved']);
    expect(result.refusals[0]?.message).toContain('collapsed folder');
    // And the cut is NOT consumed: one of its rows is still waiting to move.
    expect(result.clipboard).toBe(state);
  });

  it('resolveIds returns entries in tree order, whatever order the ids arrive in', () => {
    const { entries, unresolved } = resolveIds(ROWS, [
      id('login.spec.ts'),
      'nope',
      id('checkout/cart.spec.ts'),
    ]);
    expect(entries.map((entry) => entry.path)).toEqual(['checkout/cart.spec.ts', 'login.spec.ts']);
    expect(unresolved).toEqual(['nope']);
  });

  /*
   * Shift-clicking a folder and a file inside it is one gesture. Moving the
   * folder already takes the file with it, so keeping both would issue a second
   * move for a path that stopped existing one operation earlier.
   */
  it('drops rows contained by another row in the same gesture', () => {
    const state = cut(ROWS, [
      id('checkout'),
      id('checkout/cart.spec.ts'),
      id('checkout/sub'),
      id('login.spec.ts'),
    ]);
    expect(state?.entries.map((entry) => entry.path)).toEqual(['checkout', 'login.spec.ts']);
  });

  it('keeps a sibling whose path merely shares a prefix', () => {
    const state = cut(ROWS, [id('checkout'), id('checkout-v2')]);
    expect(state?.entries.map((entry) => entry.path)).toEqual(['checkout', 'checkout-v2']);
  });

  it('prunes nothing when only files were picked', () => {
    expect(
      pruneContained([
        { path: 'a.ts', kind: 'file' as const },
        { path: 'b/c.ts', kind: 'file' as const },
      ]),
    ).toHaveLength(2);
  });
});

describe('cut rows render faded', () => {
  it('reports the ids a cut is holding', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts')]);
    expect([...cutIds(state)]).toEqual([id('checkout/cart.spec.ts')]);
    expect(isCut(state, id('checkout/cart.spec.ts'))).toBe(true);
    expect(isCut(state, id('login.spec.ts'))).toBe(false);
  });

  it('reports nothing for a copy — a copied file is not leaving', () => {
    const state = copy(ROWS, [id('checkout/cart.spec.ts')]);
    expect(cutIds(state).size).toBe(0);
    expect(isCut(state, id('checkout/cart.spec.ts'))).toBe(false);
  });

  it('reports nothing for an empty clipboard', () => {
    expect(cutIds(null).size).toBe(0);
    expect(isCut(null, 'anything')).toBe(false);
  });

  /*
   * An unresolved row was cut too — the list simply could not show it. Expand
   * the folder before pasting and that row must fade like the rest of its
   * gesture, or the tree says two files are leaving when three are.
   */
  it('fades a cut row that the capture could not see', () => {
    const visible = ROWS.filter((row) => row.path !== 'checkout/sub/cart.spec.ts');
    const state = cut(visible, [id('checkout/cart.spec.ts'), id('checkout/sub/cart.spec.ts')]);
    expect(isCut(state, id('checkout/sub/cart.spec.ts'))).toBe(true);
    expect(cutIds(state).size).toBe(2);
  });
});

describe('folderTargetOf', () => {
  it('pastes INTO a folder', () => {
    expect(folderTargetOf(ROWS, id('checkout'))).toBe('checkout');
  });

  it('pastes NEXT TO a file — a file is not a container', () => {
    expect(folderTargetOf(ROWS, id('checkout/cart.spec.ts'))).toBe('checkout');
  });

  it.each([
    ['nothing', null],
    ['a row that is gone', 't:ghost.spec.ts'],
  ])('targets the root for %s', (_name, target) => {
    expect(folderTargetOf(ROWS, target)).toBe('');
  });

  /*
   * A feature group is a heading, not a folder. Answering `''` here made it the
   * ROOT, so a paste aimed at "Checkout" while grouped by feature landed every
   * file at the top of the project — a gesture that looked like it worked.
   * `null` and `''` are different answers and have to stay different.
   */
  it('has no folder at all for a feature group, which is not the root', () => {
    const rows = [group('Checkout'), file('checkout/cart.spec.ts')];
    expect(folderTargetOf(rows, 'd:feature:Checkout')).toBeNull();
    expect(folderTargetOf(rows, null)).toBe('');
  });
});

// ─── Paste ───────────────────────────────────────────────────────────────────

describe('paste — the happy paths', () => {
  it('moves a cut file and consumes the clipboard', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts')]);
    const result = paste(ROWS, state, 'fixtures');
    expect(result.ops).toEqual([
      {
        kind: 'move',
        id: id('checkout/cart.spec.ts'),
        entity: 'file',
        from: 'checkout/cart.spec.ts',
        to: 'fixtures/cart.spec.ts',
      },
    ]);
    expect(result.refusals).toEqual([]);
    expect(result.clipboard).toBeNull();
  });

  it('copies a file and KEEPS the clipboard, so one ⌘C serves several folders', () => {
    const state = copy(ROWS, [id('checkout/cart.spec.ts')]);
    const result = paste(ROWS, state, 'fixtures');
    expect(result.ops).toEqual([
      {
        kind: 'copy',
        id: id('checkout/cart.spec.ts'),
        entity: 'file',
        from: 'checkout/cart.spec.ts',
        to: 'fixtures/cart.spec.ts',
      },
    ]);
    expect(result.clipboard).toBe(state);
  });

  it('pastes into the root', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts')]);
    expect(paste(ROWS, state, '').ops[0]?.to).toBe('cart.spec.ts');
  });

  /*
   * `entity: 'dir'` is the load-bearing field. The `id` on a folder op is
   * `d:<path>`, which addresses nothing on the server — the caller has to send
   * this one to POST /folders/move with `{ from, to }`, and `entity` is how it
   * knows that without looking the row up again.
   */
  it('moves a whole folder as one operation, marked for the folder endpoint', () => {
    const state = cut(ROWS, [id('checkout/sub')]);
    expect(paste(ROWS, state, 'fixtures').ops).toEqual([
      {
        kind: 'move',
        id: id('checkout/sub'),
        entity: 'dir',
        from: 'checkout/sub',
        to: 'fixtures/sub',
      },
    ]);
  });

  it('marks every op with the endpoint it is addressed to', () => {
    const state = cut(ROWS, [id('checkout/sub'), id('login.spec.ts')]);
    expect(paste(ROWS, state, 'fixtures').ops.map((op) => [op.entity, op.from])).toEqual([
      ['dir', 'checkout/sub'],
      ['file', 'login.spec.ts'],
    ]);
  });

  it('moves several files in one paste', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts'), id('checkout/order.spec.ts')]);
    expect(paste(ROWS, state, 'fixtures').ops.map((op) => op.to)).toEqual([
      'fixtures/cart.spec.ts',
      'fixtures/order.spec.ts',
    ]);
  });

  it('does nothing at all with an empty clipboard', () => {
    expect(paste(ROWS, null, 'fixtures')).toEqual({ ops: [], refusals: [], clipboard: null });
  });
});

describe('paste — collisions', () => {
  it('appends " copy" when a copy lands on an existing name', () => {
    const state = copy(ROWS, [id('checkout/cart.spec.ts')]);
    expect(paste(ROWS, state, 'checkout').ops[0]?.to).toBe('checkout/cart.spec copy.ts');
  });

  /*
   * Two files with the same name pasted in ONE gesture. The second has to see
   * the name the first is about to take, or both ops land on `cart.spec.ts` and
   * one file quietly loses.
   */
  it('counts the names earlier ops in the same paste are claiming', () => {
    const state = copy(ROWS, [id('checkout/cart.spec.ts'), id('checkout/sub/cart.spec.ts')]);
    expect(paste(ROWS, state, 'fixtures').ops.map((op) => op.to)).toEqual([
      'fixtures/cart.spec.ts',
      'fixtures/cart.spec copy.ts',
    ]);
  });

  /*
   * A MOVE onto an occupied name is refused rather than renamed. Renaming a file
   * the user asked to move loses track of which one is which — and the API 409s
   * on the duplicate path regardless.
   */
  it('refuses a move onto an occupied name', () => {
    const state = cut(ROWS, [id('checkout/sub/cart.spec.ts')]);
    const result = paste(ROWS, state, 'checkout');
    expect(result.ops).toEqual([]);
    expect(reasons(result.refusals)).toEqual(['duplicate-target']);
    expect(result.refusals[0]?.message).toBe('checkout/cart.spec.ts already exists');
    // Nothing moved, so the cut is still live and can be aimed somewhere else.
    expect(result.clipboard).toBe(state);
  });
});

describe('paste — refusals', () => {
  it('refuses a move into the folder the file already lives in', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts')]);
    const result = paste(ROWS, state, 'checkout');
    expect(result.ops).toEqual([]);
    expect(reasons(result.refusals)).toEqual(['same-folder']);
  });

  it('allows a COPY into the same folder — that is how duplicate works', () => {
    const state = copy(ROWS, [id('checkout/cart.spec.ts')]);
    expect(paste(ROWS, state, 'checkout').ops).toHaveLength(1);
  });

  /* The classic infinite-recursion bug, in both of its shapes. */
  const recursions: Array<[string, string, RefusalReason]> = [
    ['a folder into itself', 'checkout', 'into-self'],
    ['a folder into its own child', 'checkout/sub', 'into-descendant'],
  ];
  it.each(recursions)('refuses %s', (_name, target, reason) => {
    for (const mode of ['cut', 'copy'] as const) {
      const state: ClipboardState = {
        mode,
        entries: [{ id: id('checkout'), path: 'checkout', name: 'checkout', kind: 'dir' }],
        unresolved: [],
      };
      const result = paste(ROWS, state, target);
      expect(result.ops).toEqual([]);
      expect(reasons(result.refusals)).toEqual([reason]);
    }
  });

  it('allows a folder into a sibling whose name shares its prefix', () => {
    const state = cut(ROWS, [id('checkout')]);
    expect(paste(ROWS, state, 'checkout-v2').ops).toEqual([
      {
        kind: 'move',
        id: id('checkout'),
        entity: 'dir',
        from: 'checkout',
        to: 'checkout-v2/checkout',
      },
    ]);
  });

  /*
   * ⌘X, then the file is deleted in another tab, then ⌘V. The clipboard holds an
   * id, so the row simply is not there any more — and saying so beats issuing a
   * move for a path that no longer exists.
   */
  it('refuses an entry whose source vanished between the cut and the paste', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts'), id('checkout/order.spec.ts')]);
    const without = ROWS.filter((row) => row.path !== 'checkout/cart.spec.ts');
    const result = paste(without, state, 'fixtures');
    expect(result.ops.map((op) => op.from)).toEqual(['checkout/order.spec.ts']);
    expect(reasons(result.refusals)).toEqual(['vanished']);
    expect(result.refusals[0]?.path).toBe('checkout/cart.spec.ts');
  });

  /*
   * The captured path is stale by design: the entry is re-resolved by id, so a
   * file renamed after the cut still moves — from where it is NOW.
   */
  it('follows a file that was renamed after the cut', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts')]);
    const renamed: TreeRow = { ...file('checkout/basket.spec.ts'), id: id('checkout/cart.spec.ts') };
    const moved = ROWS.map((row) => (row.path === 'checkout/cart.spec.ts' ? renamed : row));
    expect(paste(moved, state, 'fixtures').ops[0]).toEqual({
      kind: 'move',
      id: id('checkout/cart.spec.ts'),
      entity: 'file',
      from: 'checkout/basket.spec.ts',
      to: 'fixtures/basket.spec.ts',
    });
  });

  it('refuses everything when the destination folder is not in the tree', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts')]);
    const result = paste(ROWS, state, 'nowhere');
    expect(result.ops).toEqual([]);
    expect(reasons(result.refusals)).toEqual(['no-target']);
  });

  it('will not treat a FILE path as a destination folder', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts')]);
    expect(reasons(paste(ROWS, state, 'login.spec.ts').refusals)).toEqual(['no-target']);
  });

  it('reports one refusal per entry and still moves the rest', () => {
    const state = cut(ROWS, [id('checkout/cart.spec.ts'), id('login.spec.ts')]);
    const result = paste(ROWS, state, 'checkout');
    expect(result.ops.map((op) => op.to)).toEqual(['checkout/login.spec.ts']);
    expect(reasons(result.refusals)).toEqual(['same-folder']);
    expect(result.clipboard).toBeNull();
  });
});

describe('planOps directly', () => {
  it('is empty for no entries', () => {
    expect(planOps(ROWS, [], 'cut', 'checkout')).toEqual({ ops: [], refusals: [] });
  });

  it('prunes contained entries even when they were passed in by hand', () => {
    const result = planOps(
      ROWS,
      [
        { id: id('checkout'), path: 'checkout', name: 'checkout', kind: 'dir' },
        {
          id: id('checkout/cart.spec.ts'),
          path: 'checkout/cart.spec.ts',
          name: 'cart.spec.ts',
          kind: 'file',
        },
      ],
      'cut',
      'fixtures',
    );
    expect(result.ops.map((op) => op.from)).toEqual(['checkout']);
    expect(result.refusals).toEqual([]);
  });
});

// ─── Feature grouping ────────────────────────────────────────────────────────

/*
 * `grouping: 'feature'` is a live mode and none of this module used to know it
 * existed. A feature group is a folder-shaped row with no path: every path
 * calculation here would have treated it as the project root, which is a real
 * folder, and produced a move that the API would happily carry out.
 */
describe('a row with no path', () => {
  const FEATURE_ROWS: TreeRow[] = [
    group('Checkout'),
    file('checkout/cart.spec.ts'),
    group('Login'),
    file('login.spec.ts'),
  ];

  it('is refused as a source rather than moved to the root', () => {
    const state = cut(FEATURE_ROWS, ['d:feature:Checkout']);
    const result = paste(FEATURE_ROWS, state, '');
    expect(result.ops).toEqual([]);
    expect(reasons(result.refusals)).toEqual(['no-path']);
    expect(result.refusals[0]?.message).toContain('feature group');
  });

  /*
   * `isWithin(anything, '')` is true, so a pathless folder in the same gesture
   * used to look like the ancestor of every other row and prune the whole
   * selection down to itself — one refusal, no ops, and two files that never
   * moved for a reason nobody could have guessed.
   */
  it('does not swallow the rest of the gesture when it is pruned against', () => {
    const state = cut(FEATURE_ROWS, ['d:feature:Checkout', 't:checkout/cart.spec.ts']);
    expect(state?.entries.map((entry) => entry.id)).toEqual([
      'd:feature:Checkout',
      't:checkout/cart.spec.ts',
    ]);
    // The root is the only destination feature grouping can name, and the file
    // still has a real path of its own to move out of.
    const result = paste(FEATURE_ROWS, state, '');
    expect(result.ops.map((op) => op.to)).toEqual(['cart.spec.ts']);
    expect(reasons(result.refusals)).toEqual(['no-path']);
  });

  it('keeps pruning real folders, which do contain things', () => {
    expect(
      pruneContained([
        { path: '', kind: 'dir' as const },
        { path: 'checkout', kind: 'dir' as const },
        { path: 'checkout/a.ts', kind: 'file' as const },
        { path: 'login.spec.ts', kind: 'file' as const },
      ]).map((entry) => entry.path),
    ).toEqual(['', 'checkout', 'login.spec.ts']);
  });

  it('still moves the FILES under a feature group, which have real paths', () => {
    const state = cut(FEATURE_ROWS, ['t:checkout/cart.spec.ts']);
    expect(paste(FEATURE_ROWS, state, '').ops.map((op) => op.to)).toEqual(['cart.spec.ts']);
  });
});

// ─── Refusals are about what was actually planned ────────────────────────────

/*
 * A gesture holding a folder and a file inside it is ONE thing: the file is
 * going along with the folder either way, and pruning it is not a decision the
 * user needs to hear about. Refusing over the un-pruned list produced two
 * complaints for a two-row selection that only ever had one row in it — and the
 * counts stopped adding up, so a UI showing "1 of 2 moved" was wrong twice.
 */
describe('refusals count what was planned, not what was passed in', () => {
  it('says nothing about a row that was pruned before it was considered', () => {
    const state = cut(ROWS, [id('checkout'), id('checkout/cart.spec.ts')]);
    const result = paste(ROWS, state, 'nowhere');
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.path).toBe('checkout');
    expect(result.ops).toEqual([]);
  });

  it('adds up: every planned row is either an op or exactly one refusal', () => {
    const state = cut(ROWS, [
      id('checkout'),
      id('checkout/cart.spec.ts'),
      id('checkout/sub'),
      id('login.spec.ts'),
    ]);
    const planned = state?.entries.length ?? 0;
    const result = paste(ROWS, state, 'fixtures');
    expect(planned).toBe(2);
    expect(result.ops.length + result.refusals.length).toBe(planned);
  });
});
