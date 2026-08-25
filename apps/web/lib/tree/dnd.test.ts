import { describe, expect, it } from 'vitest';
import {
  canDrop,
  canDropOn,
  dragIdsFor,
  dropFolderOf,
  effectFromModifiers,
  planDrop,
  planDropOn,
  type DropEffect,
} from './dnd';
import type { RefusalReason } from './clipboard';
import type { SelectionState, TreeRow } from './selection';

/** A feature group: folder-shaped, and with no path at all. See `rows.ts`. */
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

const ROWS: TreeRow[] = [
  dir('checkout'),
  file('checkout/cart.spec.ts'),
  file('checkout/order.spec.ts'),
  dir('checkout/sub'),
  file('checkout/sub/cart.spec.ts'),
  dir('fixtures'),
  file('fixtures/users.json'),
  file('login.spec.ts'),
];

const id = (path: string): string => (ROWS.find((row) => row.path === path)?.id ?? `missing:${path}`);

const sel = (ids: string[]): SelectionState => ({ ids: new Set(ids), anchor: null, lead: null });

describe('what a drag carries', () => {
  it('drags the whole selection when the grabbed row is part of it', () => {
    const selection = sel([id('checkout/cart.spec.ts'), id('login.spec.ts')]);
    expect(dragIdsFor(selection, id('login.spec.ts')).sort()).toEqual(
      [id('checkout/cart.spec.ts'), id('login.spec.ts')].sort(),
    );
  });

  /*
   * Grabbing a row OUTSIDE the selection drags only that row. Carrying the old
   * selection along would move files the user had forgotten were selected, on a
   * gesture that gave them no chance to look.
   */
  it('drags only the grabbed row when it is not in the selection', () => {
    const selection = sel([id('checkout/cart.spec.ts')]);
    expect(dragIdsFor(selection, id('login.spec.ts'))).toEqual([id('login.spec.ts')]);
  });

  it('drags the grabbed row when nothing is selected', () => {
    expect(dragIdsFor(sel([]), id('login.spec.ts'))).toEqual([id('login.spec.ts')]);
  });

  const effects: Array<[string, { alt?: boolean; ctrl?: boolean }, DropEffect]> = [
    ['nothing held', {}, 'move'],
    ['alt held', { alt: true }, 'copy'],
    ['ctrl held', { ctrl: true }, 'copy'],
  ];
  it.each(effects)('is a %s drag with %o', (_name, mods, expected) => {
    expect(effectFromModifiers(mods)).toBe(expected);
  });

  it('is a move with no modifiers at all', () => {
    expect(effectFromModifiers()).toBe('move');
  });
});

describe('dropFolderOf', () => {
  it.each([
    ['a folder targets itself', id('checkout'), 'checkout'],
    ['a file targets its folder', id('checkout/cart.spec.ts'), 'checkout'],
    ['a root file targets the root', id('login.spec.ts'), ''],
  ])('%s', (_name, target, expected) => {
    expect(dropFolderOf(ROWS, target)).toBe(expected);
  });

  it('targets the root when the drop lands on nothing', () => {
    expect(dropFolderOf(ROWS, null)).toBe('');
  });
});

describe('canDrop refuses', () => {
  const refusals: Array<[string, string[], string, RefusalReason]> = [
    ['a folder onto itself', ['d:checkout'], 'checkout', 'into-self'],
    ['a folder into its own descendant', ['d:checkout'], 'checkout/sub', 'into-descendant'],
    [
      'a file into the folder it already lives in',
      ['t:checkout/cart.spec.ts'],
      'checkout',
      'same-folder',
    ],
    [
      'a file onto a name that is taken',
      ['t:checkout/sub/cart.spec.ts'],
      'checkout',
      'duplicate-target',
    ],
    ['anything into a folder that does not exist', ['t:login.spec.ts'], 'nowhere', 'no-target'],
  ];
  it.each(refusals)('%s', (_name, dragged, target, reason) => {
    const check = canDrop(ROWS, dragged, target);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(reason);
    expect(check.message).toBeTruthy();
  });

  /*
   * Dropping a file onto ITSELF resolves to its own folder, which is the no-op
   * move — legal as far as the API is concerned, and still a request, an audit
   * row and a full re-render for a file that does not move.
   */
  it('a file dropped onto itself', () => {
    expect(canDropOn(ROWS, [id('checkout/cart.spec.ts')], id('checkout/cart.spec.ts')).ok).toBe(
      false,
    );
  });

  /*
   * A dragged id with no row. It used to be dropped before the planner saw it,
   * so `canDrop` came back false with NOTHING to say — the cursor showed a
   * refusal the UI could not caption. The row list is what was short, and the
   * refusal now says exactly that.
   */
  it('a row that is not in the row list this was planned against', () => {
    const check = canDrop(ROWS, ['t:ghost.spec.ts'], 'checkout');
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('unresolved');
    expect(check.message).toContain('collapsed folder');
  });

  it('reports the unresolved rows and still moves the ones it can', () => {
    const result = planDrop(ROWS, ['t:ghost.spec.ts', id('login.spec.ts')], 'checkout');
    expect(result.ops.map((op) => op.from)).toEqual(['login.spec.ts']);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['unresolved']);
  });

  it('an empty drag', () => {
    expect(canDrop(ROWS, [], 'checkout').ok).toBe(false);
  });
});

describe('canDrop allows', () => {
  it('a file into another folder', () => {
    expect(canDrop(ROWS, [id('checkout/cart.spec.ts')], 'fixtures')).toEqual({
      ok: true,
      reason: null,
      message: null,
    });
  });

  it('a file dropped onto the root', () => {
    expect(canDropOn(ROWS, [id('checkout/cart.spec.ts')], null).ok).toBe(true);
  });

  it('a folder into an unrelated folder', () => {
    expect(canDrop(ROWS, [id('checkout/sub')], 'fixtures').ok).toBe(true);
  });

  /*
   * ⌥-dragging a file into its own folder is how you duplicate it, so the
   * no-op-move refusal must not apply to a copy.
   */
  it('a COPY into the folder the file already lives in', () => {
    expect(canDrop(ROWS, [id('checkout/cart.spec.ts')], 'checkout', 'copy').ok).toBe(true);
  });
});

describe('what a drop produces', () => {
  it('is the same operation shape a paste produces', () => {
    expect(planDrop(ROWS, [id('checkout/cart.spec.ts')], 'fixtures')).toEqual({
      ops: [
        {
          kind: 'move',
          id: id('checkout/cart.spec.ts'),
          entity: 'file',
          from: 'checkout/cart.spec.ts',
          to: 'fixtures/cart.spec.ts',
        },
      ],
      refusals: [],
    });
  });

  it('emits copy ops for an alt-drag, renaming around the collision', () => {
    expect(planDrop(ROWS, [id('checkout/cart.spec.ts')], 'checkout', 'copy').ops).toEqual([
      {
        kind: 'copy',
        id: id('checkout/cart.spec.ts'),
        entity: 'file',
        from: 'checkout/cart.spec.ts',
        to: 'checkout/cart.spec copy.ts',
      },
    ]);
  });

  it('resolves the row under the cursor to its folder', () => {
    expect(planDropOn(ROWS, [id('login.spec.ts')], id('fixtures/users.json')).ops).toEqual([
      {
        kind: 'move',
        id: id('login.spec.ts'),
        entity: 'file',
        from: 'login.spec.ts',
        to: 'fixtures/login.spec.ts',
      },
    ]);
  });

  /*
   * Multi-drag with one impossible row. Refusing the whole gesture because the
   * destination happened to be one of the dragged rows would read as the tree
   * being broken; moving what CAN move and reporting the rest is what the user
   * meant.
   */
  it('moves what it can and reports what it cannot', () => {
    const result = planDrop(ROWS, [id('checkout'), id('login.spec.ts')], 'checkout');
    expect(result.ops).toEqual([
      {
        kind: 'move',
        id: id('login.spec.ts'),
        entity: 'file',
        from: 'login.spec.ts',
        to: 'checkout/login.spec.ts',
      },
    ]);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['into-self']);
  });

  it('drops rows contained by another dragged folder', () => {
    const result = planDrop(
      ROWS,
      [id('checkout/sub'), id('checkout/sub/cart.spec.ts')],
      'fixtures',
    );
    expect(result.ops.map((op) => op.from)).toEqual(['checkout/sub']);
  });

  it('renames around collisions when several copies land in one drop', () => {
    const result = planDrop(
      ROWS,
      [id('checkout/cart.spec.ts'), id('checkout/sub/cart.spec.ts')],
      'fixtures',
      'copy',
    );
    expect(result.ops.map((op) => op.to)).toEqual([
      'fixtures/cart.spec.ts',
      'fixtures/cart.spec copy.ts',
    ]);
  });
});

/*
 * The property that keeps the highlight honest: the tree may only invite a drop
 * it will actually act on. If these two ever diverge, a row lights up and mouse-
 * up does nothing.
 *
 * The sweep below used to assert `canDrop().ok === (plan.ops.length > 0)`,
 * which is the line `canDrop` is written on — it could not have failed. What
 * follows is what a diverging pair would actually break: an outcome table
 * written by hand rather than derived from the planner, and then invariants
 * that hold over every combination.
 */
describe('canDrop and planDrop never disagree', () => {
  const targets = ['', 'checkout', 'checkout/sub', 'fixtures', 'nowhere'];
  const drags = [
    [id('checkout')],
    [id('checkout/sub')],
    [id('checkout/cart.spec.ts')],
    [id('login.spec.ts')],
    [id('checkout'), id('login.spec.ts')],
    ['t:ghost.spec.ts'],
    [],
  ];
  const effectValues: DropEffect[] = ['move', 'copy'];

  /*
   * Worked out by hand from the rules, not from the code: what SHOULD happen
   * when each of these is dragged onto each of these. Every line is a sentence
   * somebody can argue with, which is the whole difference between this and the
   * assertion it replaces.
   */
  const expected: Array<[string, string[], string, DropEffect, RefusalReason | null]> = [
    ['a folder onto itself', [id('checkout')], 'checkout', 'move', 'into-self'],
    ['a folder into its own child', [id('checkout')], 'checkout/sub', 'move', 'into-descendant'],
    ['a folder into an unrelated folder', [id('checkout/sub')], 'fixtures', 'move', null],
    ['a folder onto the root it already sits in', [id('checkout')], '', 'move', 'same-folder'],
    ['a file into its own folder', [id('checkout/cart.spec.ts')], 'checkout', 'move', 'same-folder'],
    ['the same file COPIED into its own folder', [id('checkout/cart.spec.ts')], 'checkout', 'copy', null],
    ['a file onto an occupied name', [id('checkout/sub/cart.spec.ts')], 'checkout', 'move', 'duplicate-target'],
    ['the same file COPIED onto that name', [id('checkout/sub/cart.spec.ts')], 'checkout', 'copy', null],
    ['a file into a folder that is not there', [id('login.spec.ts')], 'nowhere', 'move', 'no-target'],
    ['a file into a free folder', [id('login.spec.ts')], 'fixtures', 'move', null],
    ['a drag holding the destination and a file', [id('checkout'), id('login.spec.ts')], 'checkout', 'move', null],
    ['a row nobody can find', ['t:ghost.spec.ts'], 'fixtures', 'move', 'unresolved'],
    ['nothing at all', [], 'fixtures', 'move', null],
  ];
  it.each(expected)('%s', (_name, dragged, target, effect, reason) => {
    const check = canDrop(ROWS, dragged, target, effect);
    // An empty drag lands nothing and has nothing to complain about.
    expect(check.ok).toBe(reason === null && dragged.length > 0);
    expect(check.reason).toBe(reason);
  });

  /*
   * And over every combination, the three things that must hold whatever the
   * rules say:
   *
   *  1. The highlight and the work agree.
   *  2. A refusal is always captioned. A drop that fails with nothing to say is
   *     a cursor the UI cannot label — which is exactly how the unresolved row
   *     used to behave.
   *  3. Every planned row is accounted for exactly once, as an op or as one
   *     refusal. This is what catches a refusal emitted for a row that was
   *     pruned out of the gesture before it was ever considered.
   */
  it('agrees, explains itself, and accounts for every row', () => {
    for (const dragged of drags) {
      for (const target of targets) {
        for (const effect of effectValues) {
          const plan = planDrop(ROWS, dragged, target, effect);
          const check = canDrop(ROWS, dragged, target, effect);
          expect(check.ok).toBe(plan.ops.length > 0);
          if (!check.ok && dragged.length > 0) {
            expect(check.reason).not.toBeNull();
            expect(check.message).toBeTruthy();
          }
          // The rows this gesture actually planned: dragged, minus the ones
          // another dragged folder already carries.
          const paths = dragged
            .map((rowId) => ROWS.find((row) => row.id === rowId)?.path)
            .filter((path): path is string => path !== undefined);
          const planned = dragged.filter((rowId) => {
            const row = ROWS.find((candidate) => candidate.id === rowId);
            if (!row) return true;
            return !paths.some((folder) => folder !== '' && row.path.startsWith(`${folder}/`));
          });
          expect(plan.ops.length + plan.refusals.length).toBe(planned.length);
          for (const op of plan.ops) {
            expect(op.to).not.toBe(op.from);
            expect(op.to.startsWith(`${op.from}/`)).toBe(false);
            expect(op.to.startsWith(target === '' ? '' : `${target}/`)).toBe(true);
          }
        }
      }
    }
  });
});

// ─── Feature grouping ────────────────────────────────────────────────────────

/*
 * Under `grouping: 'feature'` the tree's top level is headings, not folders.
 * They have no path, and `dropFolderOf` used to answer `''` for them — the
 * project ROOT — so dropping a file onto the "Checkout" heading moved it to the
 * top of the project and the tree redrew as though the drop had worked.
 */
describe('dropping onto a feature group', () => {
  const FEATURE_ROWS: TreeRow[] = [
    group('Checkout'),
    file('checkout/cart.spec.ts'),
    group('Login'),
    file('login.spec.ts'),
  ];

  it('resolves to no folder, which is not the root', () => {
    expect(dropFolderOf(FEATURE_ROWS, 'd:feature:Checkout')).toBeNull();
    expect(dropFolderOf(FEATURE_ROWS, null)).toBe('');
  });

  it('refuses the drop instead of moving the file to the root', () => {
    const check = canDropOn(FEATURE_ROWS, ['t:login.spec.ts'], 'd:feature:Checkout');
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('no-path');
    expect(check.message).toContain('Checkout');
  });

  it('plans nothing, and says so once per dragged row', () => {
    const result = planDropOn(
      FEATURE_ROWS,
      ['t:login.spec.ts', 't:checkout/cart.spec.ts'],
      'd:feature:Checkout',
    );
    expect(result.ops).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['no-path', 'no-path']);
    // Tree order, not the order the ids were dragged in — the same order the
    // ops would have come out in, so the report reads down the panel.
    expect(result.refusals.map((refusal) => refusal.path)).toEqual([
      'checkout/cart.spec.ts',
      'login.spec.ts',
    ]);
  });

  it('refuses to DRAG one, too — a heading has no path to move', () => {
    const check = canDropOn(FEATURE_ROWS, ['d:feature:Checkout'], null);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('no-path');
  });
});
