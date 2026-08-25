/**
 * Tests for suite grouping and for what a drag onto a suite row means.
 *
 * The row lists these tests plan against are BUILT, not hand-written:
 * `buildSuiteTree` → `flattenTree` → `panelRows`, the same three calls the
 * panel makes. Hand-made rows would let a group id agree with itself while
 * disagreeing with what `rows.ts` actually mints, and the whole point of
 * `suite:<id>` is that one function writes it and another reads it back.
 *
 * Two properties most of this file exists for:
 *
 *   1. A SUITE GROUP IS ADDRESSED BY ID, NEVER BY NAME. The tree is grouped by
 *      the suite's name because that is what sorts and reads correctly, so the
 *      test that a group keeps its identity across a rename is the one that
 *      would catch a regression to name-keying — and with it a scope and an
 *      expansion state that reset every time somebody renames a suite.
 *   2. A REFUSED DROP IS REFUSED VISIBLY. Every refusal case asserts that no
 *      operation came out AND that a message did, because an assignment that
 *      quietly does nothing is indistinguishable from a broken request.
 */

import { describe, expect, it } from 'vitest';
import { flattenTree, type TreeNode } from './model';
import { panelRows, type PanelRow } from './rows';
import {
  NO_SUITE_LABEL,
  UNASSIGNED_GROUP_ID,
  assignmentSummary,
  buildSuiteTree,
  canDropOnSuite,
  freeSuiteName,
  planSuiteDrop,
  suiteContext,
  suiteDropTargetOf,
  suiteGroupId,
  suiteGroupOf,
  suiteAssignRequests,
  suiteNamesExcept,
  validateSuiteName,
  type SuiteAssignOp,
  type SuiteTest,
  type TreeSuite,
} from './suites';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function test(over: Partial<SuiteTest> & { id: string; filePath: string }): SuiteTest {
  const slash = over.filePath.lastIndexOf('/');
  return {
    name: over.filePath.slice(slash + 1),
    type: 'E2E',
    reviewFlags: [],
    suiteId: null,
    ...over,
  };
}

const SUITES: TreeSuite[] = [
  { id: 'sui_smoke', name: 'Smoke' },
  { id: 'sui_checkout', name: 'Checkout' },
];

const TESTS: SuiteTest[] = [
  test({ id: 't_cart', filePath: 'checkout/cart.spec.ts', suiteId: 'sui_checkout' }),
  test({ id: 't_order', filePath: 'checkout/order.spec.ts', suiteId: 'sui_checkout' }),
  test({ id: 't_login', filePath: 'login.spec.ts', suiteId: 'sui_smoke' }),
  test({ id: 't_loose', filePath: 'misc/loose.spec.ts', suiteId: null }),
];

/** The rows the panel would have, built the way the panel builds them. */
function rowsFor(
  tests: readonly SuiteTest[] = TESTS,
  suites: readonly TreeSuite[] = SUITES,
): PanelRow[] {
  const model = buildSuiteTree(tests, suites);
  const open = new Set(model.roots.filter((node) => node.kind === 'dir').map((node) => node.id));
  return panelRows(flattenTree(model.roots, open));
}

const context = (
  tests: readonly SuiteTest[] = TESTS,
  suites: readonly TreeSuite[] = SUITES,
) => suiteContext(suites, tests);

const groupNames = (roots: readonly TreeNode[]): string[] => roots.map((node) => node.name);
const groupIds = (roots: readonly TreeNode[]): string[] => roots.map((node) => node.id);

const rowIdOf = (rows: readonly PanelRow[], nodeId: string): string =>
  rows.find((row) => row.nodeId === nodeId)?.id ?? `missing:${nodeId}`;

// ─── Identity ────────────────────────────────────────────────────────────────

describe('suiteGroupOf', () => {
  it('reads a real suite id out of a group id', () => {
    expect(suiteGroupOf('suite:sui_smoke')).toEqual({ kind: 'suite', suiteId: 'sui_smoke' });
  });

  it('tells the unassigned group apart from a real suite', () => {
    expect(suiteGroupOf(UNASSIGNED_GROUP_ID)).toEqual({ kind: 'unassigned' });
  });

  it('is null for anything that is not a suite group', () => {
    // A feature group and a folder path both look like group ids and are not
    // ones. Answering `{kind:'suite'}` for either would put a folder path in a
    // URL as a suite id.
    expect(suiteGroupOf('feature:Checkout')).toBeNull();
    expect(suiteGroupOf('checkout/sub')).toBeNull();
    expect(suiteGroupOf('')).toBeNull();
  });
});

// ─── The tree ────────────────────────────────────────────────────────────────

describe('buildSuiteTree', () => {
  it('puts each test under its suite, and keys the group on the suite id', () => {
    const model = buildSuiteTree(TESTS, SUITES);
    expect(groupNames(model.roots)).toEqual(['Checkout', NO_SUITE_LABEL, 'Smoke']);
    expect(groupIds(model.roots)).toEqual([
      suiteGroupId('sui_checkout'),
      UNASSIGNED_GROUP_ID,
      suiteGroupId('sui_smoke'),
    ]);
    expect(model.grouping).toBe('suite');
  });

  it('keeps a group’s identity when the suite is renamed', () => {
    const renamed = buildSuiteTree(TESTS, [
      { id: 'sui_smoke', name: 'Zebra' },
      { id: 'sui_checkout', name: 'Checkout' },
    ]);
    const smoke = renamed.roots.find((node) => node.name === 'Zebra');
    // Name-keyed ids would make this `suite:Zebra`, and every open group and
    // saved scope would reset the moment somebody renamed a suite.
    expect(smoke?.id).toBe(suiteGroupId('sui_smoke'));
  });

  it('gives an empty suite a row, so there is something to drag files onto', () => {
    const model = buildSuiteTree(TESTS, [...SUITES, { id: 'sui_new', name: 'Nightly' }]);
    const nightly = model.roots.find((node) => node.id === suiteGroupId('sui_new'));
    expect(nightly).toBeTruthy();
    expect(nightly?.kind === 'dir' && nightly.children).toEqual([]);
    // And in its sorted place, not appended to the end.
    expect(groupNames(model.roots)).toEqual(['Checkout', 'Nightly', NO_SUITE_LABEL, 'Smoke']);
  });

  it('collects the tests in no suite under one group, labelled like the model’s', () => {
    const model = buildSuiteTree(TESTS, SUITES);
    const none = model.roots.find((node) => node.id === UNASSIGNED_GROUP_ID);
    expect(none?.kind === 'dir' && none.children.map((child) => child.id)).toEqual(['t_loose']);
  });

  it('treats a test pointing at a suite this client has not got as unassigned', () => {
    const model = buildSuiteTree(
      [test({ id: 't_x', filePath: 'a.spec.ts', suiteId: 'sui_from_another_tab' })],
      SUITES,
    );
    const none = model.roots.find((node) => node.id === UNASSIGNED_GROUP_ID);
    expect(none?.kind === 'dir' && none.children.map((child) => child.id)).toEqual(['t_x']);
    // And no group is invented for an id with no name to show.
    expect(groupIds(model.roots)).not.toContain('suite:sui_from_another_tab');
  });

  it('aggregates the model’s own counts per group', () => {
    const model = buildSuiteTree(
      [
        test({ id: 't1', filePath: 'a.spec.ts', suiteId: 'sui_smoke', reviewFlags: ['selector'] }),
        test({ id: 't2', filePath: 'b.spec.ts', suiteId: 'sui_smoke' }),
      ],
      SUITES,
    );
    const smoke = model.roots.find((node) => node.id === suiteGroupId('sui_smoke'));
    expect(smoke?.kind === 'dir' && smoke.fileCount).toBe(2);
    expect(smoke?.kind === 'dir' && smoke.flagCount).toBe(1);
    expect(model.fileCount).toBe(2);
  });

  it('still hides what a hide pattern hides, and still counts it', () => {
    const model = buildSuiteTree(TESTS, SUITES, { hide: ['*.spec.ts'] });
    expect(model.fileCount).toBe(0);
    expect(model.hiddenCount).toBe(4);
  });

  it('sorts empty and never-run groups last under “last run”, not first', () => {
    const model = buildSuiteTree(
      [
        test({
          id: 't1',
          filePath: 'a.spec.ts',
          suiteId: 'sui_checkout',
          lastRunAt: '2026-05-01T00:00:00.000Z',
        }),
      ],
      [...SUITES, { id: 'sui_new', name: 'Aardvark' }],
      { sort: 'lastRun' },
    );
    // Checkout ran; Aardvark and Smoke never did and sink despite their names.
    expect(groupNames(model.roots)).toEqual(['Checkout', 'Aardvark', 'Smoke']);
  });

  it('scopes to one suite by its id, and hands the crumb back as an id', () => {
    const model = buildSuiteTree(TESTS, SUITES, { scope: suiteGroupId('sui_checkout') });
    expect(model.scopeMissing).toBe(false);
    expect(model.roots.map((node) => node.id)).toEqual(['t_cart', 't_order']);
    // The crumb has to be something `setScope` can be given back, which means a
    // suite id and never the `feature:` id the model resolved it through.
    expect(model.scope).toEqual([{ name: 'Checkout', id: suiteGroupId('sui_checkout') }]);
  });

  it('scopes to the unassigned group', () => {
    const model = buildSuiteTree(TESTS, SUITES, { scope: UNASSIGNED_GROUP_ID });
    expect(model.roots.map((node) => node.id)).toEqual(['t_loose']);
    expect(model.scope).toEqual([{ name: NO_SUITE_LABEL, id: UNASSIGNED_GROUP_ID }]);
  });

  it('degrades to the whole tree when the scoped suite is gone', () => {
    const model = buildSuiteTree(TESTS, SUITES, { scope: suiteGroupId('sui_deleted') });
    expect(model.scopeMissing).toBe(true);
    expect(model.roots.length).toBeGreaterThan(0);
  });

  it('does not append empty suites inside a scope', () => {
    const model = buildSuiteTree(TESTS, [...SUITES, { id: 'sui_new', name: 'Nightly' }], {
      scope: suiteGroupId('sui_checkout'),
    });
    // Inside a scope the roots are that suite's FILES; a group row here would be
    // a suite drawn inside a suite.
    expect(model.roots.every((node) => node.kind === 'file')).toBe(true);
  });
});

// ─── Where a drop lands ──────────────────────────────────────────────────────

describe('suiteDropTargetOf', () => {
  it('resolves a group row to its own suite', () => {
    const rows = rowsFor();
    const target = suiteDropTargetOf(
      context(),
      rows,
      rowIdOf(rows, suiteGroupId('sui_checkout')),
    );
    expect(target).toEqual({ suiteId: 'sui_checkout', name: 'Checkout' });
  });

  it('resolves the unassigned group to “no suite”', () => {
    const rows = rowsFor();
    const target = suiteDropTargetOf(context(), rows, rowIdOf(rows, UNASSIGNED_GROUP_ID));
    expect(target).toEqual({ suiteId: null, name: NO_SUITE_LABEL });
  });

  it('resolves a FILE row to the suite that file is in', () => {
    const rows = rowsFor();
    const target = suiteDropTargetOf(context(), rows, rowIdOf(rows, 't_cart'));
    // Pointing at a row inside Checkout means Checkout, the same way pointing at
    // a file in path grouping means the folder it lives in.
    expect(target).toEqual({ suiteId: 'sui_checkout', name: 'Checkout' });
  });

  it('is null for the panel background — suite grouping has no root to fall back on', () => {
    expect(suiteDropTargetOf(context(), rowsFor(), null)).toBeNull();
  });

  it('is null for a group whose suite this client no longer knows about', () => {
    const rows = rowsFor();
    const stale = suiteContext([{ id: 'sui_smoke', name: 'Smoke' }], TESTS);
    // The Checkout row is still on screen from the previous build; its suite is
    // not in the list any more, and assigning into it would 404.
    expect(suiteDropTargetOf(stale, rows, rowIdOf(rows, suiteGroupId('sui_checkout')))).toBeNull();
  });
});

// ─── Planning a drop ─────────────────────────────────────────────────────────

describe('planSuiteDrop', () => {
  const target = { suiteId: 'sui_smoke', name: 'Smoke' };

  it('assigns every dragged file, recording the suite each came out of', () => {
    const rows = rowsFor();
    const plan = planSuiteDrop(
      context(),
      rows,
      [rowIdOf(rows, 't_cart'), rowIdOf(rows, 't_loose')],
      target,
    );
    expect(plan.refusals).toEqual([]);
    expect(plan.ops.map((op) => [op.testId, op.from, op.to])).toEqual([
      ['t_cart', 'sui_checkout', 'sui_smoke'],
      ['t_loose', null, 'sui_smoke'],
    ]);
    // The op carries the ROW id, which is what the panel's executor strips the
    // namespace off — a bare test id here would be a 404 waiting to happen.
    expect(plan.ops[0]!.id).toBe(rowIdOf(rows, 't_cart'));
    expect(plan.ops[0]!.entity).toBe('file');
  });

  it('refuses a file that is already in the target, visibly and with no op', () => {
    const rows = rowsFor();
    const plan = planSuiteDrop(context(), rows, [rowIdOf(rows, 't_login')], target);
    expect(plan.ops).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]!.reason).toBe('same-folder');
    expect(plan.refusals[0]!.message).toContain('already in Smoke');
  });

  it('lands the files it can and reports the ones it cannot', () => {
    const rows = rowsFor();
    const plan = planSuiteDrop(
      context(),
      rows,
      [rowIdOf(rows, 't_login'), rowIdOf(rows, 't_cart')],
      target,
    );
    expect(plan.ops.map((op) => op.testId)).toEqual(['t_cart']);
    expect(plan.refusals.map((refusal) => refusal.id)).toEqual([rowIdOf(rows, 't_login')]);
  });

  it('refuses a dragged suite row rather than inventing a nesting gesture', () => {
    const rows = rowsFor();
    const plan = planSuiteDrop(
      context(),
      rows,
      [rowIdOf(rows, suiteGroupId('sui_checkout'))],
      target,
    );
    expect(plan.ops).toEqual([]);
    expect(plan.refusals[0]!.reason).toBe('no-path');
    expect(plan.refusals[0]!.message).toContain('not a test');
  });

  it('reports an id it cannot resolve instead of quietly dropping it', () => {
    const rows = rowsFor();
    const plan = planSuiteDrop(context(), rows, ['f:not_in_this_tree'], target);
    expect(plan.ops).toEqual([]);
    expect(plan.refusals[0]!.reason).toBe('unresolved');
  });

  it('takes files out of their suite when the target is the unassigned group', () => {
    const rows = rowsFor();
    const plan = planSuiteDrop(context(), rows, [rowIdOf(rows, 't_cart')], {
      suiteId: null,
      name: NO_SUITE_LABEL,
    });
    expect(plan.ops.map((op) => [op.testId, op.from, op.to])).toEqual([
      ['t_cart', 'sui_checkout', null],
    ]);
  });

  it('refuses a file that is already in no suite, dropped on the unassigned group', () => {
    const rows = rowsFor();
    const plan = planSuiteDrop(context(), rows, [rowIdOf(rows, 't_loose')], {
      suiteId: null,
      name: NO_SUITE_LABEL,
    });
    expect(plan.ops).toEqual([]);
    expect(plan.refusals[0]!.message).toContain('not in a suite already');
  });
});

describe('canDropOnSuite', () => {
  it('says yes when at least one dragged file would land', () => {
    const rows = rowsFor();
    const check = canDropOnSuite(
      context(),
      rows,
      [rowIdOf(rows, 't_login'), rowIdOf(rows, 't_cart')],
      rowIdOf(rows, suiteGroupId('sui_smoke')),
    );
    expect(check.ok).toBe(true);
    expect(check.message).toBeNull();
  });

  it('says no with the first reason when nothing would land', () => {
    const rows = rowsFor();
    const check = canDropOnSuite(
      context(),
      rows,
      [rowIdOf(rows, 't_login')],
      rowIdOf(rows, suiteGroupId('sui_smoke')),
    );
    expect(check.ok).toBe(false);
    expect(check.message).toContain('already in Smoke');
  });

  it('says no, and why, when the cursor is not over a suite at all', () => {
    const rows = rowsFor();
    const check = canDropOnSuite(context(), rows, [rowIdOf(rows, 't_cart')], null);
    expect(check.ok).toBe(false);
    expect(check.message).toContain('Drop files onto a suite');
  });
});

// ─── Names ───────────────────────────────────────────────────────────────────

describe('naming a suite', () => {
  it('collects the names taken, excluding the suite being renamed', () => {
    expect([...suiteNamesExcept(SUITES, 'sui_smoke')]).toEqual(['Checkout']);
    expect([...suiteNamesExcept(SUITES, null)].sort()).toEqual(['Checkout', 'Smoke']);
  });

  it('counts up rather than colliding', () => {
    expect(freeSuiteName('New suite', new Set())).toBe('New suite');
    expect(freeSuiteName('New suite', new Set(['New suite']))).toBe('New suite 2');
    expect(freeSuiteName('New suite', new Set(['New suite', 'New suite 2']))).toBe('New suite 3');
  });

  it('accepts an ordinary name, and a slash — a suite is not a path', () => {
    expect(validateSuiteName('Checkout / EU', new Set()).ok).toBe(true);
  });

  it('refuses a blank name', () => {
    expect(validateSuiteName('   ', new Set())).toEqual({
      ok: false,
      message: 'A suite needs a name',
    });
  });

  it('refuses a name past what the server will store', () => {
    expect(validateSuiteName('x'.repeat(81), new Set()).ok).toBe(false);
  });

  it('refuses a name already taken, by name', () => {
    const check = validateSuiteName('Smoke', new Set(['Smoke']));
    expect(check.ok).toBe(false);
    expect(check.message).toContain('Smoke');
  });

  it('refuses control characters, which a paste can carry in invisibly', () => {
    expect(validateSuiteName(`Smoke${String.fromCharCode(7)}`, new Set()).ok).toBe(false);
  });
});

// ─── Planned ops to calls ────────────────────────────────────────────────────

describe('suiteAssignRequests', () => {
  const op = (over: Partial<SuiteAssignOp> & { testId: string }): SuiteAssignOp => ({
    kind: 'assign',
    id: `f:${over.testId}`,
    entity: 'file',
    from: null,
    to: 'sui_smoke',
    path: `${over.testId}.spec.ts`,
    ...over,
  });

  it('sends one call per suite, carrying the ops it covers', () => {
    const calls = suiteAssignRequests([op({ testId: 'a' }), op({ testId: 'b' })], 200);
    expect(calls).toEqual([
      {
        suiteId: 'sui_smoke',
        direction: 'assign',
        opIds: ['f:a', 'f:b'],
        testIds: ['a', 'b'],
      },
    ]);
  });

  it('addresses an unassignment to the suite each file is LEAVING', () => {
    const calls = suiteAssignRequests(
      [
        op({ testId: 'a', from: 'sui_smoke', to: null }),
        op({ testId: 'b', from: 'sui_checkout', to: null }),
        op({ testId: 'c', from: 'sui_smoke', to: null }),
      ],
      200,
    );
    // One drop on "No suite" carrying files out of two suites is two calls, not
    // one addressed to whichever suite happened to be first.
    expect(calls).toEqual([
      { suiteId: 'sui_smoke', direction: 'unassign', opIds: ['f:a', 'f:c'], testIds: ['a', 'c'] },
      { suiteId: 'sui_checkout', direction: 'unassign', opIds: ['f:b'], testIds: ['b'] },
    ]);
  });

  it('splits a drop larger than the server’s cap instead of being refused by it', () => {
    const ops = Array.from({ length: 5 }, (_, at) => op({ testId: `t${at}` }));
    const calls = suiteAssignRequests(ops, 2);
    expect(calls.map((call) => call.testIds)).toEqual([
      ['t0', 't1'],
      ['t2', 't3'],
      ['t4'],
    ]);
  });

  it('never addresses a call to a suite that is not there', () => {
    // from null and to null cannot come out of the planner, and if it ever did
    // the URL would contain the word "null".
    expect(suiteAssignRequests([op({ testId: 'a', from: null, to: null })], 200)).toEqual([]);
  });
});

describe('assignmentSummary', () => {
  it('says where the files went', () => {
    expect(assignmentSummary(3, { suiteId: 'sui_smoke', name: 'Smoke' })).toBe(
      'Put 3 files in Smoke',
    );
    expect(assignmentSummary(1, { suiteId: 'sui_smoke', name: 'Smoke' })).toBe(
      'Put 1 file in Smoke',
    );
  });

  it('does not claim files were put into a group that is not a suite', () => {
    expect(assignmentSummary(2, { suiteId: null, name: NO_SUITE_LABEL })).toBe(
      'Took 2 files out of their suite',
    );
  });
});
