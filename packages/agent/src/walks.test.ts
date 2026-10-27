import { describe, expect, it } from 'vitest';
import { dimensionCellIdentity, type FlowEdge, type FlowNode } from '@qaai/shared';
import { stateCellKey } from './coverage-states';
import {
  DEFAULT_WALK_BUDGETS,
  WALK_BUDGETS,
  WALK_BUDGET_LABELS,
  WALK_CAPABILITIES,
  WALK_NOT_PRODUCED_REASONS,
  WALK_NOT_PRODUCED_REASON_LIST,
  WALK_SHAPES,
  WALK_SHAPE_DESCRIPTORS,
  WALK_SHAPE_LIST,
  WALK_STEP_KINDS,
  WALK_STEP_KIND_LIST,
  describeWalk,
  selectWalks,
  type Walk,
  type WalkEdge,
  type WalkNode,
  type WalkNotProducedReason,
  type WalkShape,
} from './walks';

/**
 * What this file is actually checking.
 *
 * The defect was that journeys are single first-discovery spanning paths, so
 * the tests that matter are not "does it return walks" — it obviously does —
 * but the properties that make the walks worth having and the report honest:
 *
 *   1. The shapes a spanning tree CANNOT produce are actually produced: a
 *      second path, a loop into another state, a mid-flow re-entry, back,
 *      forward, refresh.
 *   2. A shape that produced nothing says WHY, and "we looked and there is one
 *      path" is a different record from "we never looked".
 *   3. Every cap that bit is a count AND a reason, and the parts account for
 *      the whole.
 *   4. `atLeastMoreWalks` is NULL — never 0 — when the search cannot bound what
 *      it missed.
 *   5. A node nobody classified claims NO state cell, rather than being
 *      reported as the default one.
 *   6. One seed is byte-identical forever, and the seed does real work.
 */

const node = (over: Partial<WalkNode> & Pick<WalkNode, 'id' | 'route'>): WalkNode => ({
  stateKey: over.stateKey ?? 'default',
  behindAuth: false,
  ...over,
});

const edge = (id: string, from: string, to: string, over: Partial<WalkEdge> = {}): WalkEdge => ({
  id,
  from,
  to,
  action: `click "${id}"`,
  ...over,
});

/**
 * A diamond with a cycle: home → list → detail, home → detail directly, and
 * detail → list. So `detail` has two paths and `list` is revisitable, which is
 * the minimum graph that exercises every shape.
 */
const DIAMOND_NODES: WalkNode[] = [
  node({ id: 'n-home', route: '/', cellKind: 'PAGE_DEFAULT' }),
  node({ id: 'n-list', route: '/orders', cellKind: 'PAGE_DEFAULT' }),
  node({ id: 'n-detail', route: '/orders/:id', cellKind: 'PAGE_DEFAULT', behindAuth: true }),
  // Same route as n-list, different crawl state: the loop target.
  node({ id: 'n-list-empty', route: '/orders', stateKey: 'orders-empty', cellKind: 'PAGE_EMPTY' }),
];

const DIAMOND_EDGES: WalkEdge[] = [
  edge('e-home-list', 'n-home', 'n-list'),
  edge('e-list-detail', 'n-list', 'n-detail', { formId: 'form-filter' }),
  edge('e-home-detail', 'n-home', 'n-detail'),
  edge('e-detail-list', 'n-detail', 'n-list'),
];

const select = (over: Parameters<typeof selectWalks>[0] extends infer T ? Partial<T> : never = {}) =>
  selectWalks({
    nodes: DIAMOND_NODES,
    edges: DIAMOND_EDGES,
    entryNodeId: 'n-home',
    seed: 'run-seed-1',
    ...over,
  });

const shapesFor = (walks: Walk[], targetNodeId: string): WalkShape[] =>
  walks.filter((walk) => walk.targetNodeId === targetNodeId).map((walk) => walk.shape);

const reasonFor = (
  result: ReturnType<typeof selectWalks>,
  nodeId: string,
  shape: WalkShape,
): WalkNotProducedReason | undefined =>
  result.notProduced.find((entry) => entry.nodeId === nodeId && entry.shape === shape)?.reason;

describe('walk vocabulary parity', () => {
  it('gives every shape a descriptor, so none can be selected with no weight', () => {
    expect(WALK_SHAPE_LIST).toEqual([...WALK_SHAPES]);
    for (const shape of WALK_SHAPES) {
      const descriptor = WALK_SHAPE_DESCRIPTORS[shape];
      expect(descriptor.points).toBeGreaterThan(0);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.finds.length).toBeGreaterThan(0);
    }
  });

  it('derives the step-kind and not-produced-reason lists from their records', () => {
    expect(WALK_STEP_KIND_LIST).toEqual([...WALK_STEP_KINDS]);
    expect(WALK_NOT_PRODUCED_REASON_LIST).toEqual([...WALK_NOT_PRODUCED_REASONS]);
  });

  it('labels every budget, so a cap bite can never print undefined', () => {
    for (const budget of WALK_BUDGETS) {
      expect(WALK_BUDGET_LABELS[budget].length).toBeGreaterThan(0);
    }
  });

  it('ranks SHORTEST_PATH last, because the suite already has it', () => {
    const ladder = [...WALK_SHAPES].sort(
      (left, right) => WALK_SHAPE_DESCRIPTORS[right].points - WALK_SHAPE_DESCRIPTORS[left].points,
    );
    expect(ladder[ladder.length - 1]).toBe('SHORTEST_PATH');
    expect(ladder[0]).toBe('RE_ENTRY');
  });

  it('declares a capability for exactly the three history shapes', () => {
    const needing = WALK_SHAPES.filter((shape) => WALK_SHAPE_DESCRIPTORS[shape].needs !== null);
    expect([...needing].sort()).toEqual(['BACK', 'FORWARD', 'REFRESH_MID_FLOW']);
    for (const shape of needing) {
      const needs = WALK_SHAPE_DESCRIPTORS[shape].needs;
      expect(WALK_CAPABILITIES).toContain(needs);
    }
  });
});

describe('the shapes a spanning tree cannot produce', () => {
  it('produces a SECOND path to a node the shortest path already reaches', () => {
    const result = select({ budgets: { walksPerTarget: 7 } });
    expect(shapesFor(result.walks, 'n-detail')).toContain('ALTERNATIVE_PATH');

    const alternative = result.walks.find(
      (walk) => walk.targetNodeId === 'n-detail' && walk.shape === 'ALTERNATIVE_PATH',
    );
    const shortest = result.walks.find(
      (walk) => walk.targetNodeId === 'n-detail' && walk.shape === 'SHORTEST_PATH',
    );
    const edgesOf = (walk: Walk | undefined): string[] =>
      (walk?.steps ?? []).map((step) => step.target ?? step.kind);
    // The point of the shape: a DIFFERENT edge sequence, not a relabelling.
    expect(edgesOf(alternative)).not.toEqual(edgesOf(shortest));
    expect(edgesOf(shortest)).toEqual(['e-home-detail']);
    expect(edgesOf(alternative)).toEqual(['e-home-list', 'e-list-detail']);
  });

  it('loops back to a visited route in a DIFFERENT state, and reports both states', () => {
    const result = select({ budgets: { walksPerTarget: 7 } });
    const loop = result.walks.find(
      (walk) => walk.targetNodeId === 'n-detail' && walk.shape === 'LOOP_RE_STATE',
    );
    expect(loop).toBeDefined();

    const ordersRevisit = loop?.revisits.find((revisit) => revisit.route === '/orders');
    expect(ordersRevisit?.visits).toBe(2);
    // Two DISTINCT crawl states on one route — the fact a spanning tree cannot
    // express, and the reason this walk outranks a second happy path.
    expect(ordersRevisit?.states).toEqual(['default', 'orders-empty']);
  });

  it('re-enters in the MIDDLE of the path, not at its end', () => {
    const result = select({ budgets: { walksPerTarget: 7 } });
    const reEntry = result.walks.find(
      (walk) => walk.targetNodeId === 'n-detail' && walk.shape === 'RE_ENTRY',
    );
    expect(reEntry).toBeDefined();

    const labels = (reEntry?.steps ?? []).map((step) => step.label);
    expect(labels.some((label) => label.startsWith('leave the flow'))).toBe(true);
    expect(labels.some((label) => label.startsWith('re-enter at'))).toBe(true);
    expect(reEntry?.rankBasis.some((basis) => basis.includes('MIDDLE'))).toBe(true);
  });

  it('presses back, and back-then-forward, with the expected landing node where it can know one', () => {
    const result = select({ budgets: { walksPerTarget: 7 } });
    const back = result.walks.find(
      (walk) => walk.targetNodeId === 'n-detail' && walk.shape === 'BACK',
    );
    const forward = result.walks.find(
      (walk) => walk.targetNodeId === 'n-detail' && walk.shape === 'FORWARD',
    );

    expect(back?.steps.at(-1)?.kind).toBe('BACK');
    expect(forward?.steps.map((step) => step.kind).slice(-2)).toEqual(['BACK', 'FORWARD']);
    // Forward returns to the target, which the graph DOES know.
    expect(forward?.steps.at(-1)?.expectedNodeId).toBe('n-detail');
  });

  it('refreshes part way through and then continues to the target', () => {
    const result = select({ budgets: { walksPerTarget: 7 } });
    const refresh = result.walks.find(
      (walk) => walk.targetNodeId === 'n-detail' && walk.shape === 'REFRESH_MID_FLOW',
    );
    const kinds = (refresh?.steps ?? []).map((step) => step.kind);
    expect(kinds).toContain('REFRESH');
    // A refresh at the END would be a reload test, not a mid-flow test.
    expect(kinds.at(-1)).not.toBe('REFRESH');
  });

  it('ranks a mid-flow re-entry above a second happy path', () => {
    const result = select({ budgets: { walksPerTarget: 7 } });
    const rank = (shape: WalkShape): number =>
      result.walks.find((walk) => walk.targetNodeId === 'n-detail' && walk.shape === shape)?.rank ??
      -1;
    expect(rank('RE_ENTRY')).toBeGreaterThan(rank('SHORTEST_PATH'));
    expect(rank('RE_ENTRY')).toBeGreaterThan(rank('ALTERNATIVE_PATH'));
  });

  it('awards the wizard bonus only on a DECLARED control kind', () => {
    const withKind = selectWalks({
      nodes: DIAMOND_NODES,
      edges: DIAMOND_EDGES.map((candidate) =>
        candidate.id === 'e-list-detail' ? { ...candidate, kind: 'WIZARD_STEP' as const } : candidate,
      ),
      entryNodeId: 'n-home',
      seed: 'run-seed-1',
      budgets: { walksPerTarget: 7 },
    });
    const without = select({ budgets: { walksPerTarget: 7 } });

    const bonusOf = (result: ReturnType<typeof selectWalks>): boolean =>
      result.walks.some((walk) => walk.rankBasis.some((basis) => basis.includes('wizard step')));
    expect(bonusOf(withKind)).toBe(true);
    // An UNCAPTURED kind is not "not a wizard": no bonus, and the selection
    // says how many walks crossed an unclassified edge rather than implying
    // the application has no wizards.
    expect(bonusOf(without)).toBe(false);
    expect(without.walksWithUncapturedEdgeKinds).toBeGreaterThan(0);
  });
});

describe('a shape that produced nothing says why', () => {
  it('records NO_SECOND_PATH when the graph holds exactly one path — we LOOKED', () => {
    const result = selectWalks({
      nodes: [node({ id: 'a', route: '/' }), node({ id: 'b', route: '/only' })],
      edges: [edge('e', 'a', 'b')],
      entryNodeId: 'a',
      seed: 's',
    });
    expect(reasonFor(result, 'b', 'ALTERNATIVE_PATH')).toBe('NO_SECOND_PATH');
    const detail = result.notProduced.find((entry) => entry.shape === 'ALTERNATIVE_PATH')?.detail;
    expect(detail).toContain('We looked');
  });

  it('records NO_REVISIT_AVAILABLE rather than omitting the loop silently', () => {
    const result = selectWalks({
      nodes: [node({ id: 'a', route: '/' }), node({ id: 'b', route: '/only' })],
      edges: [edge('e', 'a', 'b')],
      entryNodeId: 'a',
      seed: 's',
    });
    expect(reasonFor(result, 'b', 'LOOP_RE_STATE')).toBe('NO_REVISIT_AVAILABLE');
  });

  it('records PATH_TOO_SHORT_FOR_SHAPE for a one-step flow instead of a broken walk', () => {
    const result = selectWalks({
      nodes: [node({ id: 'a', route: '/' }), node({ id: 'b', route: '/only' })],
      edges: [edge('e', 'a', 'b')],
      entryNodeId: 'a',
      seed: 's',
    });
    for (const shape of ['RE_ENTRY', 'BACK', 'FORWARD', 'REFRESH_MID_FLOW'] as const) {
      expect(reasonFor(result, 'b', shape)).toBe('PATH_TOO_SHORT_FOR_SHAPE');
    }
  });

  it('records NO_HISTORY_CAPABILITY as OUR limit when the harness cannot go back', () => {
    const result = select({ capabilities: ['RELOAD'], budgets: { walksPerTarget: 7 } });
    expect(shapesFor(result.walks, 'n-detail')).not.toContain('BACK');
    expect(reasonFor(result, 'n-detail', 'BACK')).toBe('NO_HISTORY_CAPABILITY');

    const detail = result.notProduced.find((entry) => entry.shape === 'BACK')?.detail;
    expect(detail).toContain('limit of ours');
    // RELOAD is available, so that shape is still produced.
    expect(shapesFor(result.walks, 'n-detail')).toContain('REFRESH_MID_FLOW');
  });

  it('records UNREACHABLE_FROM_ENTRY for a node in the graph and not in the flow', () => {
    const result = selectWalks({
      nodes: [node({ id: 'a', route: '/' }), node({ id: 'orphan', route: '/orphan' })],
      edges: [],
      entryNodeId: 'a',
      seed: 's',
    });
    expect(result.walks).toEqual([]);
    expect(reasonFor(result, 'orphan', 'SHORTEST_PATH')).toBe('UNREACHABLE_FROM_ENTRY');
  });

  it('refuses to re-root itself when the entry node is not in the graph', () => {
    const result = select({ entryNodeId: 'n-nope' });
    expect(result.walks).toEqual([]);
    for (const shape of WALK_SHAPES) {
      expect(reasonFor(result, 'n-list', shape)).toBe('NO_ENTRY_NODE');
    }
    // Never a silent empty success: the rule says what did not happen.
    expect(result.rule).toContain('selection that did not happen');
    expect(result.atLeastMoreWalks).toBeNull();
  });
});

describe('every cap is a count and a reason', () => {
  it('DISCLOSES the per-target cap, and the parts account for the whole', () => {
    const uncapped = select({ budgets: { walksPerTarget: 99 } });
    const capped = select({ budgets: { walksPerTarget: 2 } });

    const bite = capped.caps.find((cap) => cap.cap === 'WALKS_PER_TARGET');
    expect(bite).toBeDefined();
    expect(bite?.bites).toBeGreaterThan(0);
    expect(bite?.discarded).toBe(uncapped.walks.length - capped.walks.length);
    expect(bite?.reason).toContain('not');
    expect(bite?.limit).toBe(2);
  });

  it('DISCLOSES the whole-selection cap', () => {
    const capped = select({ budgets: { walksTotal: 3, walksPerTarget: 7 } });
    expect(capped.walks).toHaveLength(3);
    const bite = capped.caps.find((cap) => cap.cap === 'WALKS_TOTAL');
    expect(bite?.discarded).toBeGreaterThan(0);
    expect(bite?.limit).toBe(3);
  });

  it('DISCLOSES the not-produced record cap rather than dropping explanations silently', () => {
    const result = selectWalks({
      nodes: [node({ id: 'a', route: '/' }), node({ id: 'b', route: '/only' })],
      edges: [edge('e', 'a', 'b')],
      entryNodeId: 'a',
      seed: 's',
      budgets: { notProducedRecords: 1 },
    });
    expect(result.notProduced).toHaveLength(1);
    expect(result.notProducedDiscarded).toBeGreaterThan(0);
    const bite = result.caps.find((cap) => cap.cap === 'NOT_PRODUCED_RECORDS');
    expect(bite?.discarded).toBe(result.notProducedDiscarded);
  });

  it('reports atLeastMoreWalks as NULL, not 0, when the path search ran out', () => {
    const starved = select({ budgets: { pathEnumeration: 2 } });
    expect(starved.caps.some((cap) => cap.cap === 'PATH_ENUMERATION')).toBe(true);
    // The lie this prevents: an exhausted search reporting a complete selection.
    expect(starved.atLeastMoreWalks).toBeNull();
  });

  it('reports atLeastMoreWalks as a real lower bound when the search finished', () => {
    const complete = select({ budgets: { walksPerTarget: 1 } });
    expect(complete.caps.some((cap) => cap.cap === 'PATH_ENUMERATION')).toBe(false);
    expect(complete.atLeastMoreWalks).toBeGreaterThan(0);
  });
});

describe('state cells: one format, and no guesses', () => {
  it('spells a cell key exactly as stateCellKey does, never a second format', () => {
    const result = select({ budgets: { walksPerTarget: 7 } });
    const listState = result.walks
      .flatMap((walk) => walk.expectedStates)
      .find((state) => state.route === '/orders' && state.kind === 'PAGE_DEFAULT');

    expect(listState?.cellKey).toBe(stateCellKey({ itemKey: '/orders', kind: 'PAGE_DEFAULT' }));
    expect(listState?.cellKey).toBe(dimensionCellIdentity('/orders#PAGE_DEFAULT', []));
  });

  it('hangs the cell off the inventory item key when the caller supplies one', () => {
    const result = selectWalks({
      nodes: [
        node({ id: 'a', route: '/', cellKind: 'PAGE_DEFAULT' }),
        node({
          id: 'b',
          route: '/orders',
          cellKind: 'PAGE_DEFAULT',
          coverageItemKey: 'ROUTE:/orders',
        }),
      ],
      edges: [edge('e', 'a', 'b')],
      entryNodeId: 'a',
      seed: 's',
    });
    const state = result.walks
      .flatMap((walk) => walk.expectedStates)
      .find((candidate) => candidate.nodeId === 'b');
    expect(state?.itemKey).toBe('ROUTE:/orders');
    expect(state?.cellKey).toBe(stateCellKey({ itemKey: 'ROUTE:/orders', kind: 'PAGE_DEFAULT' }));
  });

  it('claims NO cell for a node nobody classified, rather than assuming the default one', () => {
    const result = selectWalks({
      // No `cellKind` at all: this graph predates state enumeration.
      nodes: [node({ id: 'a', route: '/' }), node({ id: 'b', route: '/orders' })],
      edges: [edge('e', 'a', 'b')],
      entryNodeId: 'a',
      seed: 's',
    });
    const states = result.walks.flatMap((walk) => walk.expectedStates);
    expect(states.every((state) => state.cellKey === null && state.kind === null)).toBe(true);
    expect(states.every((state) => state.why.includes('rather than assuming'))).toBe(true);
    expect(result.statesUnclassified).toBe(states.length);
  });

  it('distinguishes "classified nothing" from "nobody classified", in the sentence', () => {
    const result = selectWalks({
      nodes: [
        node({ id: 'a', route: '/', cellKind: null }),
        node({ id: 'b', route: '/orders' }),
      ],
      edges: [edge('e', 'a', 'b')],
      entryNodeId: 'a',
      seed: 's',
    });
    const why = (id: string): string =>
      result.walks
        .flatMap((walk) => walk.expectedStates)
        .find((state) => state.nodeId === id)?.why ?? '';
    expect(why('a')).toContain('state enumeration ran');
    expect(why('b')).toContain('nothing classified this node');
  });

  it('counts unclassified states over the SELECTED walks, never the constructed ones', () => {
    const capped = select({ budgets: { walksPerTarget: 1 } });
    const onSelected = capped.walks.reduce(
      (running, walk) =>
        running + walk.expectedStates.filter((state) => state.cellKey === null).length,
      0,
    );
    // The defect this pins: counting from inside the constructor reported more
    // unclassified states than the selection had walks to carry them.
    expect(capped.statesUnclassified).toBe(onSelected);
  });

  it('dedupes cells that repeat inside one walk, so a loop does not double-count', () => {
    const result = select({ budgets: { walksPerTarget: 7 } });
    for (const walk of result.walks) {
      const keys = walk.expectedStates
        .map((state) => state.cellKey)
        .filter((key): key is string => key !== null);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('determinism', () => {
  it('is byte-identical for the same seed', () => {
    const once = JSON.stringify(select({ budgets: { walksPerTarget: 7 } }));
    const twice = JSON.stringify(select({ budgets: { walksPerTarget: 7 } }));
    expect(once).toBe(twice);
  });

  it('is byte-identical regardless of the order the nodes and edges arrive in', () => {
    const forward = JSON.stringify(select({ budgets: { walksPerTarget: 7 } }));
    const reversed = JSON.stringify(
      selectWalks({
        nodes: [...DIAMOND_NODES].reverse(),
        edges: [...DIAMOND_EDGES].reverse(),
        entryNodeId: 'n-home',
        seed: 'run-seed-1',
        budgets: { walksPerTarget: 7 },
      }),
    );
    expect(forward).toBe(reversed);
  });

  it('gives walks content-derived ids, so widening a budget does not rename them', () => {
    const narrow = select({ budgets: { walksPerTarget: 1 } });
    const wide = select({ budgets: { walksPerTarget: 7 } });
    const kept = narrow.walks[0];
    expect(kept).toBeDefined();
    expect(wide.walks.map((walk) => walk.id)).toContain(kept?.id);
  });

  it('lets the seed choose between EQUAL-ranked walks, so fresh runs widen the sample', () => {
    /*
     * Two structurally identical branches, so their walks tie on rank exactly.
     * With a one-walk budget the seed is the only thing that can decide, and
     * across a fixed list of seeds more than one walk must be reachable —
     * otherwise the seed is decoration and two runs can never see more than
     * one of two equally interesting walks.
     */
    const nodes = [
      node({ id: 'n0', route: '/' }),
      node({ id: 'n1', route: '/a' }),
      node({ id: 'n2', route: '/b' }),
    ];
    const edges = [edge('e1', 'n0', 'n1'), edge('e2', 'n0', 'n2')];
    const chosen = new Set(
      ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e', 'seed-f'].map((seed) => {
        const result = selectWalks({ nodes, edges, entryNodeId: 'n0', seed, budgets: { walksTotal: 1 } });
        return result.walks[0]?.id ?? '';
      }),
    );
    expect(chosen.size).toBeGreaterThan(1);
    // And one seed is still exact.
    const a1 = selectWalks({ nodes, edges, entryNodeId: 'n0', seed: 'seed-a', budgets: { walksTotal: 1 } });
    const a2 = selectWalks({ nodes, edges, entryNodeId: 'n0', seed: 'seed-a', budgets: { walksTotal: 1 } });
    expect(JSON.stringify(a1)).toBe(JSON.stringify(a2));
  });

  it('echoes the seed, so a failing selection can be re-run', () => {
    expect(select().seed).toBe('run-seed-1');
    expect(select().rule).toContain('run-seed-1');
  });
});

describe('the graph a stored FlowMap already holds is accepted as-is', () => {
  it("takes a FlowMap's own nodes and edges with no conversion step", () => {
    /*
     * A COMPILE-TIME check wearing a test's clothes. `WalkNode` and `WalkEdge`
     * are narrow records so the module is testable with object literals; if
     * they ever stop being satisfied by the real `FlowNode`/`FlowEdge`, this
     * file stops compiling — which is the only way to notice, since nothing
     * else in the module mentions those types.
     */
    const flowNodes: FlowNode[] = [
      {
        id: 'f-home',
        route: '/',
        url: 'https://example.test/',
        title: 'Home',
        stateKey: 'default',
        requiresRoles: [],
        behindAuth: false,
        forms: [],
        affordances: [],
        screenshotKey: null,
        a11yViolationCount: 0,
      },
      {
        id: 'f-orders',
        route: '/orders',
        url: 'https://example.test/orders',
        title: 'Orders',
        stateKey: 'default',
        requiresRoles: ['ADMIN'],
        behindAuth: true,
        forms: [],
        affordances: [],
        screenshotKey: null,
        a11yViolationCount: 0,
      },
    ];
    const flowEdges: FlowEdge[] = [
      { id: 'f-e', from: 'f-home', to: 'f-orders', action: 'click "Orders"', selector: null },
    ];

    const result = selectWalks({
      nodes: flowNodes,
      edges: flowEdges,
      entryNodeId: 'f-home',
      seed: 'fm',
    });
    expect(result.walks.map((walk) => walk.shape)).toEqual(['SHORTEST_PATH']);
    expect(result.walks[0]?.rankBasis.some((basis) => basis.includes('authenticated'))).toBe(true);
  });
});

describe('describeWalk', () => {
  it('shows the shape and the rank, so two walks can be told apart at a glance', () => {
    const result = select({ budgets: { walksPerTarget: 7 } });
    const back = result.walks.find((walk) => walk.shape === 'BACK');
    expect(back).toBeDefined();
    const rendered = describeWalk(back!);
    expect(rendered).toContain('[BACK');
    expect(rendered).toContain('← back');
  });
});

describe('the budgets are the design, so the defaults are deliberate', () => {
  it('bounds the path search, which is what makes a real graph terminate', () => {
    expect(DEFAULT_WALK_BUDGETS.pathEnumeration).toBeGreaterThan(0);
    expect(DEFAULT_WALK_BUDGETS.maxPathLength).toBeGreaterThan(1);
    expect(DEFAULT_WALK_BUDGETS.walksPerTarget).toBeLessThan(DEFAULT_WALK_BUDGETS.walksTotal);
  });

  it('terminates on a dense cyclic graph instead of enumerating forever', () => {
    // Twelve nodes, every one linked to every other: more simple paths than
    // anybody can enumerate. The test is that this RETURNS, with the cap bite.
    const nodes = Array.from({ length: 12 }, (_, index) =>
      node({ id: `d${index}`, route: `/d${index}` }),
    );
    const edges: WalkEdge[] = [];
    for (const from of nodes) {
      for (const to of nodes) {
        if (from.id !== to.id) edges.push(edge(`e-${from.id}-${to.id}`, from.id, to.id));
      }
    }
    const result = selectWalks({ nodes, edges, entryNodeId: 'd0', seed: 'dense' });
    expect(result.caps.some((cap) => cap.cap === 'PATH_ENUMERATION')).toBe(true);
    expect(result.atLeastMoreWalks).toBeNull();
    expect(result.walks.length).toBeGreaterThan(0);
  });
});
