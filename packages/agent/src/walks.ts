/**
 * State-machine walk selection — the paths a spanning tree can never produce.
 *
 * THE DEFECT THIS FIXES: journeys are derived in `packages/agent/src/crawler.ts`
 * as FIRST-DISCOVERY SPANNING PATHS. Every node gets exactly one route to it —
 * the one the crawl happened to find first — so the suite contains no scenario
 * that reaches a screen a second way, no scenario that returns to a route in a
 * DIFFERENT state, no scenario that leaves and comes back, and nothing at all
 * that presses the browser's back button. That is not a gap in breadth, it is a
 * gap in the kind of bug a suite can find:
 *
 *   · the second route into checkout that skips the validation the first does;
 *   · the wizard re-entered at step 3 with step 1's answers still in memory;
 *   · the cart page after the cart emptied, which is the same route and a
 *     different screen;
 *   · back-after-submit, which is where double submission, stale totals and
 *     resurrected deleted rows live;
 *   · refresh mid-flow, which is where a wizard that kept its state in a
 *     component falls over.
 *
 * A spanning tree cannot express any of them, because each needs a path that
 * revisits something.
 *
 * ── THE WALK SPACE IS INFINITE, SO THE CAP IS THE DESIGN ────────────────────
 *
 * A graph with one cycle has infinitely many walks. So this module does not
 * "enumerate walks"; it SELECTS a bounded, ranked set and reports what the
 * bound cost as a count and a reason — {@link WalkSelection.caps} and
 * {@link WalkSelection.atLeastMoreWalks}. A capped list presented as a complete
 * one is the dishonest-coverage failure this product exists to stop, and here
 * it would be the most tempting version of it: the cap is doing almost all of
 * the work.
 *
 * The ranking is the other half. {@link WALK_SHAPE_DESCRIPTORS} weights shapes
 * by the bug class they find rather than by how cheap they are, which is why
 * SHORTEST_PATH ranks LAST — it is the walk the spanning tree already produces,
 * so a selection that spent its budget on more of them would add nothing.
 *
 * ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────
 *
 * It opens nothing and drives nothing. Every input is a narrow record a caller
 * already holds — {@link WalkNode} is not a `FlowNode` and {@link WalkEdge} is
 * not a `FlowEdge`, though a `FlowMap`'s own arrays are assignable to both, so
 * `selectWalks({ nodes: map.nodes, edges: map.edges, … })` compiles and the
 * whole module is still exercised with plain objects, no browser and no clock.
 * There is no `Math.random()` and no `Date.now()` anywhere below: the run seed
 * is an argument, and the same seed produces byte-identical output forever.
 *
 * ── THE ONE CELL-KEY FORMAT ─────────────────────────────────────────────────
 *
 * A walk carries the state cells it expects to traverse so the state dimension
 * can count it, and it spells them with `stateCellKey` from coverage-states.ts
 * — which is `dimensionCellIdentity` with the state folded into the base. This
 * module deliberately does NOT invent a second spelling, and deliberately does
 * NOT put `FlowNode.stateKey` in the key: coverage-states.ts carries the crawl's
 * state key into the EVIDENCE and never into the key, because a key that moved
 * when a state was re-decided would retire a cell and mint a new one on every
 * crawl. The consequence is honest and worth stating: a loop that visits
 * `/cart` in two crawl states contributes ONE cell when both classify the same
 * way, and the two distinct states it visited are reported separately in
 * {@link Walk.revisits}, which is the fact that justifies the walk's rank.
 */

import {
  createSyntheticFactory,
  type CapBite,
  type CoverageCellKind,
  type NodeStatus,
} from '@qaai/shared';
import { stateCellKey } from './coverage-states.js';
import type { InteractionKind } from './crawl/interact.js';

// ─── 1. The shapes, and why each one is worth a slot ────────────────────────

/**
 * The seven walk shapes, ordered by nothing — {@link WALK_SHAPE_DESCRIPTORS}
 * carries the weight, so this array's order is not a ranking and no reader
 * should infer one from it.
 *
 * SHORTEST_PATH is in the list on purpose even though the existing journey
 * derivation already produces it. Without it the selection could not say "this
 * target got one happy path and two re-entries" — and a report that cannot
 * place its new walks beside the baseline is one nobody can review.
 */
export const WALK_SHAPES = [
  /** The spanning-tree path. The baseline the other six have to beat. */
  'SHORTEST_PATH',
  /** A different edge sequence to the same node. The second door into checkout. */
  'ALTERNATIVE_PATH',
  /** Returns to a route already visited, in a DIFFERENT state. */
  'LOOP_RE_STATE',
  /** Leaves the target and comes back. State that did not reset lives here. */
  'RE_ENTRY',
  /** Walks forward, then presses the browser's back button. */
  'BACK',
  /** Back, then forward again. The history entry nobody tested. */
  'FORWARD',
  /** Reloads at a node in the middle of the path, not at its end. */
  'REFRESH_MID_FLOW',
] as const;
export type WalkShape = (typeof WALK_SHAPES)[number];

/**
 * The compile-time half of the presence guard; walks.test.ts holds the
 * run-time half by comparing this list against {@link WALK_SHAPES}.
 *
 * Two mechanisms rather than one for the reason `PRINCIPAL_KIND_PRESENT` gives
 * in principals.ts: a `Record` keyed on the union cannot be written without
 * naming every member, and the list-versus-record comparison catches the
 * reverse. An eighth shape that reached this file without a descriptor would be
 * a shape with no weight, which sorts as `undefined` and is therefore a shape
 * that silently never gets selected.
 */
const WALK_SHAPE_PRESENT: Record<WalkShape, true> = {
  SHORTEST_PATH: true,
  ALTERNATIVE_PATH: true,
  LOOP_RE_STATE: true,
  RE_ENTRY: true,
  BACK: true,
  FORWARD: true,
  REFRESH_MID_FLOW: true,
};

/** Derived, never hand-listed. See the note on the record above. */
export const WALK_SHAPE_LIST = Object.keys(WALK_SHAPE_PRESENT) as ReadonlyArray<WalkShape>;

/**
 * The capabilities a walk can need from the harness.
 *
 * Declared rather than assumed, the same way `capabilitiesOf` in
 * crawl/variants.ts declares the variant capabilities: a harness without
 * history control must produce a BACK walk recorded as NOT PRODUCED with a
 * named reason, never a BACK walk that silently becomes a second forward walk.
 */
export const WALK_CAPABILITIES = ['HISTORY_BACK', 'HISTORY_FORWARD', 'RELOAD'] as const;
export type WalkCapability = (typeof WALK_CAPABILITIES)[number];

export interface WalkShapeDescriptor {
  label: string;
  /**
   * The base rank, in INTEGER POINTS out of 100.
   *
   * Integers and not a 0–1 float because the rank is compared, summed with
   * bonuses and asserted on in tests, and a float ladder makes an exact-equality
   * assertion a hostage to the order the bonuses were added in.
   */
  points: number;
  /** The bug class this shape finds. Printed beside the walk in the report. */
  finds: string;
  /** The harness capability it needs, or null when it needs none. */
  needs: WalkCapability | null;
  /** True when the shape requires the path to revisit something. */
  revisits: boolean;
}

/**
 * Shape → weight and justification, as data.
 *
 * The ladder is the argument this module has to be able to defend, so here it
 * is explicitly: a walk that RE-ENTERS a flow beats one that merely reaches it,
 * because re-entry is the only way to catch state that did not reset — and
 * state that did not reset is a bug every framework makes easy to write.
 * SHORTEST_PATH is 30 rather than 0 because it is still a real walk; it is last
 * because the suite already has it.
 */
export const WALK_SHAPE_DESCRIPTORS: Record<WalkShape, WalkShapeDescriptor> = {
  RE_ENTRY: {
    label: 're-entry after leaving',
    points: 100,
    finds:
      'state that did not reset — a wizard re-entered at step 3 with step 1 still filled in, a ' +
      'form that keeps a stale id, a modal that remembers what it showed last time',
    needs: null,
    revisits: true,
  },
  LOOP_RE_STATE: {
    label: 'a loop back to a visited route in a different state',
    points: 95,
    finds:
      'the same route rendering a different screen — the cart page after the cart emptied, the ' +
      'list page after the last row was deleted',
    needs: null,
    revisits: true,
  },
  BACK: {
    label: 'browser back',
    points: 90,
    finds:
      'double submission, stale totals and resurrected rows: back-after-submit is the single ' +
      'most common way a user reaches a screen the application thinks is gone',
    needs: 'HISTORY_BACK',
    revisits: true,
  },
  REFRESH_MID_FLOW: {
    label: 'a refresh in the middle of the flow',
    points: 85,
    finds:
      'flow state held only in a component — a wizard that loses step 1 on reload, a draft that ' +
      'was never persisted',
    needs: 'RELOAD',
    revisits: true,
  },
  ALTERNATIVE_PATH: {
    label: 'a second path to the same node',
    points: 80,
    finds:
      'the door that skips a check the other door performs — a deep link past a consent step, a ' +
      'second entry point that does not validate',
    needs: null,
    revisits: false,
  },
  FORWARD: {
    label: 'browser back then forward',
    points: 60,
    finds:
      'a history entry the application cannot re-render, which is what a single-page app with ' +
      'imperative navigation produces',
    needs: 'HISTORY_FORWARD',
    revisits: true,
  },
  SHORTEST_PATH: {
    label: 'the shortest path',
    points: 30,
    finds: 'nothing the existing spanning-tree journeys do not already find; the baseline',
    needs: null,
    revisits: false,
  },
};

// ─── 2. Steps ───────────────────────────────────────────────────────────────

/**
 * What a walk does, step by step.
 *
 * GOTO is separate from TRAVERSE because a re-entry sometimes has no edge to
 * come back along: the graph records that `/orders/:id` is reachable from the
 * list, not that it is reachable from wherever the user wandered off to. A GOTO
 * is an honest navigation and a TRAVERSE is a click, and a report that showed
 * them as the same step would claim the application offers a control it does
 * not.
 */
export const WALK_STEP_KINDS = ['TRAVERSE', 'GOTO', 'BACK', 'FORWARD', 'REFRESH'] as const;
export type WalkStepKind = (typeof WALK_STEP_KINDS)[number];

/** Compile-time half of the presence guard. */
const WALK_STEP_KIND_PRESENT: Record<WalkStepKind, true> = {
  TRAVERSE: true,
  GOTO: true,
  BACK: true,
  FORWARD: true,
  REFRESH: true,
};

/** Derived, never hand-listed. */
export const WALK_STEP_KIND_LIST = Object.keys(
  WALK_STEP_KIND_PRESENT,
) as ReadonlyArray<WalkStepKind>;

export interface WalkStep {
  kind: WalkStepKind;
  /**
   * The `WalkEdge.id` for TRAVERSE, the `WalkNode.id` for GOTO and REFRESH,
   * and null for BACK and FORWARD — which name no target by definition, since
   * what they land on is whatever the browser's history says.
   */
  target: string | null;
  /**
   * The node this step is EXPECTED to land on, or null when the walk cannot
   * know.
   *
   * Null is load-bearing for BACK and FORWARD: the graph does not model history,
   * so "back from here lands on the previous node in this walk" is an
   * expectation about the browser and not a fact the crawl recorded. A test
   * generated from this step asserts the expectation; a null says there is
   * nothing to assert, which is different from asserting nothing.
   */
  expectedNodeId: string | null;
  /** What a reader sees in the plan: `click "Add to cart"`, `press back`. */
  label: string;
}

// ─── 3. The graph, narrowly ─────────────────────────────────────────────────

/**
 * One node, as this module needs it.
 *
 * A `FlowNode` is assignable to it — every member here is present on `FlowNode`
 * with a compatible type — so `selectWalks` takes a stored map's own array
 * without a conversion step, while the module itself is testable with four-field
 * object literals.
 *
 * `coverageItemKey` and `cellKind` follow the three-state convention the rest of
 * this repo established on `FormField`'s constraints: ABSENT means this graph
 * predates the capture, NULL means somebody looked and there is nothing, and a
 * value is the fact. Reading absent as "no state" is how an unclassified node
 * comes to be reported as a healthy one.
 */
export interface WalkNode {
  id: string;
  /** Normalised route template, e.g. `/orders/:id`. */
  route: string;
  /** `FlowNode.stateKey` — the crawl's discriminator between states of one route. */
  stateKey: string;
  /** True when the crawl hit an auth wall reaching this node. */
  behindAuth: boolean;
  /** The navigation status, when the crawl recorded one. Never read as 200. */
  status?: NodeStatus | null;
  /** `CoverageItem.key` for this node's route, when the inventory holds one. */
  coverageItemKey?: string | null;
  /**
   * The state cell this node IS, when something classified it.
   *
   * Supplied by a caller that has run state enumeration (coverage-states.ts
   * owns that derivation and this module does not duplicate it). When it is
   * absent or null the walk records an UNCLASSIFIED state and the selection
   * counts it — see {@link WalkSelection.statesUnclassified} — rather than
   * guessing PAGE_DEFAULT, which would report as measured a thing nobody
   * measured.
   */
  cellKind?: CoverageCellKind | null;
  /** The forms on this node. Ids only; a form is a ranking signal here. */
  forms?: readonly { id: string }[];
}

/**
 * One edge, as this module needs it. `FlowEdge` and `InteractionEdge` are both
 * assignable.
 *
 * `kind` is OPTIONAL and its absence is NOT "this is not a wizard step": a URL
 * crawl produces edges with no control classification at all. The ranking only
 * ever awards the wizard bonus on a DECLARED kind, and the count of walks whose
 * edge kinds were never captured is disclosed on the selection, so a reader can
 * tell a graph that has no wizards from a graph nobody asked.
 */
export interface WalkEdge {
  id: string;
  /** `WalkNode.id`. */
  from: string;
  /** `WalkNode.id`. */
  to: string;
  /** What traversing it does: `click "Add to cart"`. */
  action: string;
  /** Set when traversal requires filling a form first. */
  formId?: string;
  /** The control's classification, when the interaction pass ran. */
  kind?: InteractionKind;
}

// ─── 4. States a walk expects to traverse ───────────────────────────────────

/**
 * One state cell a walk expects to visit.
 *
 * `cellKey` is NULL exactly when `kind` is null, and that pairing is the whole
 * honesty mechanism of this type: a walk that visits a node nobody classified
 * cannot name a cell, so it names none and says why. A `cellKey` of `''` or a
 * `kind` defaulted to PAGE_DEFAULT would both be a null that became a value.
 */
export interface WalkState {
  nodeId: string;
  route: string;
  /** The item key the cell hangs off: `coverageItemKey` when known, else the route. */
  itemKey: string;
  /** `stateCellKey(...)`, or null when the node carries no classification. */
  cellKey: string | null;
  kind: CoverageCellKind | null;
  /** One sentence: what classified this, or what was missing. */
  why: string;
}

/**
 * A route this walk visits more than once, and in how many distinct crawl
 * states.
 *
 * This is where `FlowNode.stateKey` legitimately lives: it is EVIDENCE for the
 * walk's rank and for the report, and it never enters a cell key. A walk with
 * `states: 2` on one route is a walk that saw two screens at one URL, which is
 * precisely the thing a spanning tree cannot do.
 */
export interface WalkRevisit {
  route: string;
  /** How many times the walk lands on this route. Always ≥ 2 to be listed. */
  visits: number;
  /** The distinct `WalkNode.stateKey` values, sorted, for the report. */
  states: string[];
}

// ─── 5. A walk ──────────────────────────────────────────────────────────────

export interface Walk {
  /**
   * Content-derived and stable: `<shape>@<target>#<step targets>`.
   *
   * Derived from the walk's own content rather than from its position in the
   * output, because a positional id renames every walk the moment the selection
   * takes one more of something — and a renamed walk is a retired coverage cell
   * and a new one, on a crawl where nothing about the application changed.
   */
  id: string;
  shape: WalkShape;
  /** The node this walk is ABOUT — the one whose coverage it is claimed for. */
  targetNodeId: string;
  steps: WalkStep[];
  /** Deduped by `cellKey`, in first-visit order. */
  expectedStates: WalkState[];
  /** Routes visited more than once. Empty for the two non-revisiting shapes. */
  revisits: WalkRevisit[];
  /** Integer points. See {@link WalkShapeDescriptor.points} and `rankBasis`. */
  rank: number;
  /** Every signal that contributed to `rank`, named, so a reader can audit it. */
  rankBasis: string[];
  /** One sentence for a reviewer deciding whether to keep this walk. */
  why: string;
  /** The harness capability this walk needs, or null. */
  needs: WalkCapability | null;
}

/**
 * Why a (node, shape) pair produced no walk.
 *
 * Every member is an ANSWER rather than an absence, which is the point: "there
 * is exactly one path to /checkout, so there is no alternative path" and "we
 * never looked for a second path to /checkout" are different facts with
 * different remedies, and a selection that simply omitted both would render
 * them identically.
 */
export const WALK_NOT_PRODUCED_REASONS = [
  /** The caller named no entry node, or named one the graph does not hold. */
  'NO_ENTRY_NODE',
  /** No path from the entry node reaches it. The node is in the graph and not in the flow. */
  'UNREACHABLE_FROM_ENTRY',
  /** Every path to it is longer than the path-length cap. A cap, and reported as one. */
  'BEYOND_PATH_LENGTH',
  /** We looked: the graph holds exactly one path to this node. */
  'NO_SECOND_PATH',
  /** We looked: no path to it revisits anything, so there is no loop or re-entry. */
  'NO_REVISIT_AVAILABLE',
  /** The shape needs a harness capability this run has not got. */
  'NO_HISTORY_CAPABILITY',
  /** The path is one step long, so there is no MIDDLE to refresh or go back from. */
  'PATH_TOO_SHORT_FOR_SHAPE',
] as const;
export type WalkNotProducedReason = (typeof WALK_NOT_PRODUCED_REASONS)[number];

/** Compile-time half of the presence guard. */
const WALK_NOT_PRODUCED_REASON_PRESENT: Record<WalkNotProducedReason, true> = {
  NO_ENTRY_NODE: true,
  UNREACHABLE_FROM_ENTRY: true,
  BEYOND_PATH_LENGTH: true,
  NO_SECOND_PATH: true,
  NO_REVISIT_AVAILABLE: true,
  NO_HISTORY_CAPABILITY: true,
  PATH_TOO_SHORT_FOR_SHAPE: true,
};

/** Derived, never hand-listed. */
export const WALK_NOT_PRODUCED_REASON_LIST = Object.keys(
  WALK_NOT_PRODUCED_REASON_PRESENT,
) as ReadonlyArray<WalkNotProducedReason>;

export interface WalkNotProduced {
  nodeId: string;
  shape: WalkShape;
  reason: WalkNotProducedReason;
  /** The sentence the report prints. Names the node and the shape. */
  detail: string;
}

// ─── 6. Budgets, and the disclosure of every one that bit ───────────────────

/**
 * This module's own cap vocabulary.
 *
 * Separate from `CRAWL_CAPS` in @qaai/shared for the reason `OBSERVATION_CAPS`
 * in crawl/observe.ts gives at length: those eight are the TRAVERSAL's caps,
 * these are the SELECTION's, and inventing a `cap` value the shared list does
 * not contain would produce a `CapBite` whose label lookup is `undefined`.
 * Filing a path-enumeration ceiling under `JOURNEY_LIMIT` would be worse — it
 * is the near-miss that makes a report unreadable, because `JOURNEY_LIMIT`
 * already means something else and a reader would believe it.
 *
 * The SHAPE is shared: {@link WalkCapBite} is `CapBite` with this union, so a
 * change to the cap-disclosure contract breaks this file at compile time
 * instead of drifting away from it.
 */
export const WALK_BUDGETS = [
  'WALKS_TOTAL',
  'WALKS_PER_TARGET',
  'PATH_LENGTH',
  'PATH_ENUMERATION',
  'NOT_PRODUCED_RECORDS',
] as const;
export type WalkBudget = (typeof WALK_BUDGETS)[number];

export const WALK_BUDGET_LABELS: Record<WalkBudget, string> = {
  WALKS_TOTAL: 'the whole-selection walk limit',
  WALKS_PER_TARGET: 'the per-target walk limit',
  PATH_LENGTH: 'the maximum path length',
  PATH_ENUMERATION: 'the path-enumeration expansion budget',
  NOT_PRODUCED_RECORDS: 'the limit on recorded not-produced explanations',
};

/** `CapBite` with this module's cap vocabulary. See the note on {@link WALK_BUDGETS}. */
export type WalkCapBite = Omit<CapBite, 'cap'> & { cap: WalkBudget };

export interface WalkBudgets {
  /** How many walks the whole selection may hold. */
  walksTotal: number;
  /** How many walks one target node may contribute. */
  walksPerTarget: number;
  /** The longest path, in edges, that counts as a path to a node. */
  maxPathLength: number;
  /**
   * How many node expansions the simple-path search may spend, in TOTAL.
   *
   * This is the cap that makes the module terminate on a real application's
   * graph, and it is therefore the one most likely to bite: a 400-node graph
   * with ordinary connectivity has far more simple paths than anybody can
   * enumerate. When it bites the selection says so AND says it cannot bound
   * what it missed, because an exhausted search genuinely does not know how
   * many paths were left — see {@link WalkSelection.atLeastMoreWalks}.
   */
  pathEnumeration: number;
  /** How many not-produced explanations to keep. The rest are counted, not listed. */
  notProducedRecords: number;
}

/**
 * The defaults, each a number somebody chose.
 *
 * `walksPerTarget: 4` — the shortest path plus three of the six interesting
 * shapes, which is the most a reviewer will read per screen. `maxPathLength: 8`
 * — longer than any checkout in the wild and short enough that the search's
 * branching stays affordable. `pathEnumeration: 20_000` — expansions, not
 * paths; it is roughly a second of work and it is the knob to raise when a
 * customer's graph reports the PATH_ENUMERATION bite.
 */
export const DEFAULT_WALK_BUDGETS: WalkBudgets = {
  walksTotal: 200,
  walksPerTarget: 4,
  maxPathLength: 8,
  pathEnumeration: 20_000,
  notProducedRecords: 200,
};

function walkCapBite(
  cap: WalkBudget,
  limit: number,
  bites: number,
  discarded: number,
  scope: string | null,
  reason: string,
): WalkCapBite {
  return { cap, limit, bites, discarded, scope, reason };
}

// ─── 7. Selection ───────────────────────────────────────────────────────────

export interface WalkSelectionInput {
  nodes: readonly WalkNode[];
  edges: readonly WalkEdge[];
  /**
   * Where a walk starts. Usually the crawl's entry node.
   *
   * A node id the graph does not hold is not treated as "start anywhere": every
   * node is recorded NO_ENTRY_NODE and no walk is produced, because a selection
   * that silently re-rooted itself would report walks nobody can run.
   */
  entryNodeId: string;
  /**
   * The run seed. Required, and the module is byte-identical for one seed.
   *
   * It is used for exactly one thing: breaking EXACT rank ties, through the one
   * seeded-token mechanism this repo has (`createSyntheticFactory(...).token`)
   * rather than a second hash. The effect is deliberate — two runs with
   * different seeds take different equal-ranked samples, so repeated runs widen
   * what the suite has seen, while one seed replays exactly. A `Math.random()`
   * tie-break would give the first property and destroy the second, which is
   * the commonest cause of the flake this product exists to eliminate.
   */
  seed: string | number;
  /** What the harness can do. A shape needing more is recorded, not silently dropped. */
  capabilities?: readonly WalkCapability[];
  budgets?: Partial<WalkBudgets>;
  /**
   * Restrict the targets considered. Empty or absent means every node the entry
   * node reaches.
   */
  targetNodeIds?: readonly string[];
}

export interface WalkSelection {
  /** Ranked, highest first. Deterministic for one seed. */
  walks: Walk[];
  /** Every (node, shape) pair that produced nothing, with the reason. */
  notProduced: WalkNotProduced[];
  /** How many explanations the `notProducedRecords` cap discarded. */
  notProducedDiscarded: number;
  /** Every budget that bit, as a count and a reason. Empty = none did. */
  caps: WalkCapBite[];
  /**
   * A LOWER BOUND on the walks that existed and were not selected, or null.
   *
   * NULL — not 0 — when the path search exhausted its expansion budget, because
   * an exhausted search does not know what it did not reach. Rendering that as
   * zero would claim a complete selection on behalf of the one run that is
   * guaranteed incomplete. A 0 here means the search finished and there was
   * genuinely nothing more.
   */
  atLeastMoreWalks: number | null;
  /** Walk states whose node carried no classification, so they name no cell. */
  statesUnclassified: number;
  /** Walks over at least one edge whose control kind was never captured. */
  walksWithUncapturedEdgeKinds: number;
  /** The sentence the report prints above the list. */
  rule: string;
  /** Echoed so a failure can be re-run with the selection that produced it. */
  seed: string;
}

/** The simple-path search's own result, including whether it ran out. */
interface PathSearch {
  /** Simple paths (no repeated node) as ordered edge-id lists, shortest first. */
  paths: string[][];
  /** True when the expansion budget stopped the search. */
  exhausted: boolean;
  /** Expansions spent. */
  expansions: number;
}

/**
 * Every simple path from `from` to `to`, up to `maxLength` edges, bounded by a
 * shared expansion budget.
 *
 * Depth-first with an explicit visited set, iterating a SORTED adjacency so the
 * output order is a property of the graph and not of insertion order — which is
 * what makes the whole module reproducible without a seed.
 *
 * `budget` is a mutable box shared across every call in one selection, because
 * the cap that matters is the TOTAL work, not the work per target: a selection
 * that spent 20,000 expansions on each of 400 nodes would take minutes and
 * report nothing about it.
 */
function simplePaths(
  from: string,
  to: string,
  adjacency: ReadonlyMap<string, readonly WalkEdge[]>,
  maxLength: number,
  budget: { remaining: number },
): PathSearch {
  const paths: string[][] = [];
  let exhausted = false;
  let expansions = 0;
  const visited = new Set<string>([from]);
  const stack: string[] = [];

  const walk = (node: string): void => {
    if (exhausted) return;
    if (budget.remaining <= 0) {
      exhausted = true;
      return;
    }
    budget.remaining -= 1;
    expansions += 1;

    if (node === to && stack.length > 0) {
      paths.push([...stack]);
      // A simple path that reached the target does not continue through it:
      // continuing would revisit `to`, which is what the LOOP and RE_ENTRY
      // shapes construct deliberately rather than discover here.
      return;
    }
    if (stack.length >= maxLength) return;

    for (const edge of adjacency.get(node) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      stack.push(edge.id);
      walk(edge.to);
      stack.pop();
      visited.delete(edge.to);
      if (exhausted) return;
    }
  };

  walk(from);
  paths.sort((left, right) =>
    left.length !== right.length ? left.length - right.length : left.join('>').localeCompare(right.join('>')),
  );
  return { paths, exhausted, expansions };
}

/** Node id → outgoing edges, sorted by edge id so traversal order is stable. */
function buildAdjacency(
  nodes: readonly WalkNode[],
  edges: readonly WalkEdge[],
): Map<string, WalkEdge[]> {
  const known = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, WalkEdge[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of [...edges].sort((left, right) => left.id.localeCompare(right.id))) {
    // An edge pointing at a node the graph does not hold is a dangling
    // reference in the stored map. Following it would produce a walk whose
    // steps cannot be rendered, so it is dropped here; its absence shows up as
    // the target being UNREACHABLE_FROM_ENTRY rather than as a broken walk.
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge);
  }
  return adjacency;
}

/**
 * The state cell a node contributes, or an explicit refusal to name one.
 *
 * The only derivation in this module that could lie, so it is the one with no
 * default arm: an absent or null `cellKind` returns a null `cellKey` with the
 * reason in `why`. See {@link WalkNode.cellKind}.
 */
function walkStateFor(node: WalkNode): WalkState {
  const itemKey = node.coverageItemKey ?? node.route;
  const kind = node.cellKind ?? null;
  if (kind === null) {
    return {
      nodeId: node.id,
      route: node.route,
      itemKey,
      cellKey: null,
      kind: null,
      why:
        node.cellKind === null
          ? 'state enumeration ran and classified no cell for this node, so this walk claims none'
          : 'nothing classified this node, so this walk claims no state cell rather than assuming the default one',
    };
  }
  return {
    nodeId: node.id,
    route: node.route,
    itemKey,
    cellKey: stateCellKey({ itemKey, kind }),
    kind,
    why: `the node is classified ${kind}`,
  };
}

interface RankedShape {
  points: number;
  basis: string[];
}

/**
 * The bonuses, and the one rule they all obey: a bonus is awarded only on a
 * fact the graph RECORDED.
 *
 * The wizard bonus is the clearest case. `WalkEdge.kind` is optional, and an
 * absent kind means the URL crawl produced this edge and never classified the
 * control. Awarding "not a wizard" there would rank a wizard re-entry below a
 * plain one on every graph that predates the interaction pass.
 */
function rankWalk(
  shape: WalkShape,
  pathEdges: readonly WalkEdge[],
  nodes: readonly WalkNode[],
  revisits: readonly WalkRevisit[],
  reEntryIsMidFlow: boolean,
): RankedShape {
  const descriptor = WALK_SHAPE_DESCRIPTORS[shape];
  const basis = [`${descriptor.label} is worth ${descriptor.points}: ${descriptor.finds}`];
  let points = descriptor.points;

  const crossesForm =
    pathEdges.some((edge) => edge.formId !== undefined) ||
    nodes.some((node) => (node.forms?.length ?? 0) > 0);
  if (crossesForm) {
    points += 10;
    basis.push('+10: the walk crosses a form, so a failure is attributable to a submission');
  }

  const wizardEdge = pathEdges.find((edge) => edge.kind === 'WIZARD_STEP');
  if (wizardEdge) {
    points += 15;
    basis.push(
      `+15: the walk traverses a declared wizard step (${wizardEdge.action}), which is the ` +
        'highest-value place to re-enter',
    );
  }

  if (reEntryIsMidFlow) {
    points += 10;
    basis.push('+10: the re-entry lands in the MIDDLE of the path, not at its end');
  }

  if (revisits.length > 0) {
    const distinct = revisits.reduce(
      (running, revisit) => running + Math.max(0, revisit.states.length - 1),
      0,
    );
    if (distinct > 0) {
      points += Math.min(15, distinct * 5);
      basis.push(
        `+${Math.min(15, distinct * 5)}: the walk sees ${distinct + revisits.length} distinct ` +
          'state(s) on route(s) it visits more than once',
      );
    }
  }

  if (nodes.some((node) => node.behindAuth)) {
    points += 5;
    basis.push('+5: the walk crosses an authenticated node');
  }

  return { points, basis };
}

/** Routes visited more than once, with their distinct crawl states. */
function revisitsOf(nodes: readonly WalkNode[]): WalkRevisit[] {
  const byRoute = new Map<string, { visits: number; states: Set<string> }>();
  for (const node of nodes) {
    const entry = byRoute.get(node.route) ?? { visits: 0, states: new Set<string>() };
    entry.visits += 1;
    entry.states.add(node.stateKey);
    byRoute.set(node.route, entry);
  }
  return [...byRoute.entries()]
    .filter(([, entry]) => entry.visits > 1)
    .map(([route, entry]) => ({
      route,
      visits: entry.visits,
      states: [...entry.states].sort(),
    }))
    .sort((left, right) => left.route.localeCompare(right.route));
}

/**
 * Select a bounded, ranked set of walks.
 *
 * Pure, and byte-identical for one `seed`. Every cap that bit is in
 * `caps`; every (node, shape) pair that produced nothing is in `notProduced`
 * with a reason; and `atLeastMoreWalks` is NULL rather than 0 when the search
 * could not bound what it missed.
 */
export function selectWalks(input: WalkSelectionInput): WalkSelection {
  const budgets: WalkBudgets = { ...DEFAULT_WALK_BUDGETS, ...input.budgets };
  const seed = String(input.seed);
  const tiebreaker = createSyntheticFactory({ seed, scope: 'walks' });
  const capabilities = new Set(input.capabilities ?? WALK_CAPABILITIES);
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(input.edges.map((edge) => [edge.id, edge]));
  const adjacency = buildAdjacency(input.nodes, input.edges);

  const notProducedAll: WalkNotProduced[] = [];
  const caps: WalkCapBite[] = [];
  const record = (nodeId: string, shape: WalkShape, reason: WalkNotProducedReason, detail: string): void => {
    notProducedAll.push({ nodeId, shape, reason, detail });
  };

  const finish = (walks: Walk[], extra: {
    atLeastMoreWalks: number | null;
    statesUnclassified: number;
    walksWithUncapturedEdgeKinds: number;
    rule: string;
  }): WalkSelection => {
    const kept = notProducedAll.slice(0, Math.max(0, budgets.notProducedRecords));
    const discarded = notProducedAll.length - kept.length;
    if (discarded > 0) {
      caps.push(
        walkCapBite(
          'NOT_PRODUCED_RECORDS',
          budgets.notProducedRecords,
          1,
          discarded,
          null,
          `${discarded} further explanation(s) of why a shape produced no walk were not listed; ` +
            'they were counted, not found absent',
        ),
      );
    }
    return {
      walks,
      notProduced: kept,
      notProducedDiscarded: discarded,
      caps,
      ...extra,
      seed,
    };
  };

  const entry = nodeById.get(input.entryNodeId);
  if (!entry) {
    for (const node of input.nodes) {
      for (const shape of WALK_SHAPE_LIST) {
        record(
          node.id,
          shape,
          'NO_ENTRY_NODE',
          `no walk was selected for ${node.route}: the entry node ${input.entryNodeId} is not in ` +
            'this graph, and re-rooting the search would produce walks nobody can run',
        );
      }
    }
    return finish([], {
      atLeastMoreWalks: null,
      statesUnclassified: 0,
      walksWithUncapturedEdgeKinds: 0,
      rule:
        `no walk was selected at all: the entry node ${input.entryNodeId} is not one of the ` +
        `${input.nodes.length} node(s) in this graph. This is a selection that did not happen, ` +
        'not a graph with nothing in it.',
    });
  }

  const requested = new Set(input.targetNodeIds ?? []);
  const targets = input.nodes
    .filter((node) => node.id !== entry.id && (requested.size === 0 || requested.has(node.id)))
    .sort((left, right) => left.id.localeCompare(right.id));

  const budget = { remaining: Math.max(0, budgets.pathEnumeration) };
  let searchExhausted = false;
  let unselectedPaths = 0;
  const candidates: Walk[] = [];
  /** Walk id → the edges its path crossed, so the final counts can be honest. */
  const pathEdgesOfWalk = new Map<string, readonly WalkEdge[]>();

  const edgesOf = (path: readonly string[]): WalkEdge[] =>
    path.map((id) => edgeById.get(id)).filter((edge): edge is WalkEdge => edge !== undefined);

  const nodesOf = (steps: readonly WalkStep[]): WalkNode[] => {
    const seen: WalkNode[] = [entry];
    for (const step of steps) {
      if (step.expectedNodeId === null) continue;
      const node = nodeById.get(step.expectedNodeId);
      if (node) seen.push(node);
    }
    return seen;
  };

  /*
   * PURE, and deliberately so. An earlier draft incremented the unclassified
   * counter from inside here, which counted every CONSTRUCTED walk — including
   * the ones the per-target cap then dropped — so the selection reported more
   * unclassified states than it had walks to carry them. The counts below are
   * computed over the SELECTED walks at the end, where they are true.
   */
  const statesOf = (nodes: readonly WalkNode[]): WalkState[] => {
    const out: WalkState[] = [];
    const seenKeys = new Set<string>();
    for (const node of nodes) {
      const state = walkStateFor(node);
      if (state.cellKey === null) {
        out.push(state);
        continue;
      }
      if (seenKeys.has(state.cellKey)) continue;
      seenKeys.add(state.cellKey);
      out.push(state);
    }
    return out;
  };

  const traverseSteps = (path: readonly string[]): WalkStep[] =>
    edgesOf(path).map((edge) => ({
      kind: 'TRAVERSE' as const,
      target: edge.id,
      expectedNodeId: edge.to,
      label: edge.action,
    }));

  const propose = (
    shape: WalkShape,
    target: WalkNode,
    steps: WalkStep[],
    pathEdges: readonly WalkEdge[],
    why: string,
    reEntryIsMidFlow = false,
  ): void => {
    const descriptor = WALK_SHAPE_DESCRIPTORS[shape];
    const nodes = nodesOf(steps);
    const revisits = revisitsOf(nodes);
    const ranked = rankWalk(shape, pathEdges, nodes, revisits, reEntryIsMidFlow);
    const id = `${shape}@${target.id}#${steps.map((step) => step.target ?? step.kind).join('>')}`;
    pathEdgesOfWalk.set(id, pathEdges);
    candidates.push({
      id,
      shape,
      targetNodeId: target.id,
      steps,
      expectedStates: statesOf(nodes),
      revisits,
      rank: ranked.points,
      rankBasis: ranked.basis,
      why,
      needs: descriptor.needs,
    });
  };

  for (const target of targets) {
    const search = simplePaths(entry.id, target.id, adjacency, budgets.maxPathLength, budget);
    if (search.exhausted) searchExhausted = true;

    if (search.paths.length === 0) {
      // Two different facts, and they get two different reasons. A node the
      // search could not reach within the length cap is a CAP finding with a
      // remedy; a node with no path at all is a graph finding.
      const reason: WalkNotProducedReason = search.exhausted
        ? 'BEYOND_PATH_LENGTH'
        : 'UNREACHABLE_FROM_ENTRY';
      for (const shape of WALK_SHAPE_LIST) {
        record(
          target.id,
          shape,
          reason,
          reason === 'BEYOND_PATH_LENGTH'
            ? `${target.route}: the path search ran out of its expansion budget before finding a ` +
                `path of ${budgets.maxPathLength} edge(s) or fewer — raise pathEnumeration or ` +
                'maxPathLength rather than reading this as unreachable'
            : `${target.route}: no path of ${budgets.maxPathLength} edge(s) or fewer reaches it ` +
                `from ${entry.route}, so it is in the graph and not in the flow`,
        );
      }
      continue;
    }

    const shortest = search.paths[0];
    if (!shortest) continue;
    const shortestEdges = edgesOf(shortest);

    /*
     * THE SPINE: the path the five revisiting shapes are built from.
     *
     * The LONGEST enumerated path, not the shortest, and that choice is a
     * correction rather than a preference. Loop, re-entry, back, forward and
     * refresh all need something to come BACK to; building them off the
     * shortest path meant a node reachable in one hop never got any of them,
     * even when the graph held a three-hop route to the same node — so
     * `/orders/:id`, reachable both by deep link and through the list, got no
     * back-after-submit walk at all, which is the single most valuable walk on
     * that screen. The first test to exercise this module found exactly that.
     *
     * SHORTEST_PATH and ALTERNATIVE_PATH deliberately stay on their own paths:
     * they are claims ABOUT those paths, and re-pointing them at the spine
     * would make "the shortest path" a sentence about the longest one.
     *
     * `search.paths` is sorted shortest-first (see `simplePaths`), so the last
     * entry is the longest, and it is already bounded by `maxPathLength` — so
     * preferring the longest cannot run away.
     */
    const spine = search.paths[search.paths.length - 1] ?? shortest;
    const spineEdges = edgesOf(spine);

    // ── SHORTEST_PATH: the baseline ──
    propose(
      'SHORTEST_PATH',
      target,
      traverseSteps(shortest),
      shortestEdges,
      `the shortest path to ${target.route}, which the existing spanning-tree journeys already ` +
        'produce; selected so the other shapes can be read beside it',
    );

    // ── ALTERNATIVE_PATH: a second edge sequence to the same node ──
    const second = search.paths.find((path) => path.join('>') !== shortest.join('>'));
    if (second) {
      propose(
        'ALTERNATIVE_PATH',
        target,
        traverseSteps(second),
        edgesOf(second),
        `a second route to ${target.route} (${second.length} step(s) against ` +
          `${shortest.length}); a door that skips a check the other door performs is invisible to ` +
          'a spanning tree',
      );
    } else {
      record(
        target.id,
        'ALTERNATIVE_PATH',
        'NO_SECOND_PATH',
        `${target.route}: the graph holds exactly one path to it within ${budgets.maxPathLength} ` +
          'edge(s). We looked — this is not an unasked question.',
      );
    }

    // ── LOOP_RE_STATE: come back to a route already on the SPINE, in another state ──
    // The spine and not the shortest path, for the same reason the four shapes
    // below use it: a longer path visits more routes, so there are more of them
    // to loop back to. On a graph where the target is one hop from the entry,
    // the shortest path visits nothing but the target and no loop exists at all.
    const routesOnPath = new Map<string, WalkNode[]>();
    for (const edge of spineEdges) {
      const node = nodeById.get(edge.to);
      if (!node) continue;
      const list = routesOnPath.get(node.route) ?? [];
      list.push(node);
      routesOnPath.set(node.route, list);
    }
    const loopNode = input.nodes
      .filter(
        (candidate) =>
          routesOnPath.has(candidate.route) &&
          !routesOnPath.get(candidate.route)?.some((onPath) => onPath.stateKey === candidate.stateKey),
      )
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (loopNode) {
      propose(
        'LOOP_RE_STATE',
        target,
        [
          ...traverseSteps(spine),
          {
            kind: 'GOTO',
            target: loopNode.id,
            expectedNodeId: loopNode.id,
            label: `open ${loopNode.route} again, expecting its "${loopNode.stateKey}" state`,
          },
        ],
        spineEdges,
        `after reaching ${target.route}, return to ${loopNode.route} in its "${loopNode.stateKey}" ` +
          'state — the same URL rendering a different screen, which one path per node cannot express',
      );
    } else {
      record(
        target.id,
        'LOOP_RE_STATE',
        'NO_REVISIT_AVAILABLE',
        `${target.route}: no node in this graph shares a route with its path in a different ` +
          'state, so there is no loop to walk. We looked.',
      );
    }

    // ── RE_ENTRY: leave and come back, landing mid-path where possible ──
    if (spineEdges.length >= 2) {
      const midIndex = Math.floor(spineEdges.length / 2);
      const pivot = spineEdges[midIndex - 1];
      const pivotNode = pivot ? nodeById.get(pivot.to) : undefined;
      if (pivotNode) {
        propose(
          'RE_ENTRY',
          target,
          [
            ...traverseSteps(spine),
            {
              kind: 'GOTO',
              target: entry.id,
              expectedNodeId: entry.id,
              label: `leave the flow: open ${entry.route}`,
            },
            {
              kind: 'GOTO',
              target: pivotNode.id,
              expectedNodeId: pivotNode.id,
              label: `re-enter at ${pivotNode.route}, step ${midIndex} of ${spineEdges.length}`,
            },
          ],
          spineEdges,
          `reach ${target.route}, leave, then re-enter the flow at ${pivotNode.route} — step ` +
            `${midIndex} of ${spineEdges.length}. State that did not reset is only visible here.`,
          true,
        );
      }
    } else {
      record(
        target.id,
        'RE_ENTRY',
        'PATH_TOO_SHORT_FOR_SHAPE',
        `${target.route}: the LONGEST path to it within ${budgets.maxPathLength} edge(s) is ` +
          `${spineEdges.length} edge(s) long, so it has no middle to re-enter at. A one-step ` +
          'flow cannot be re-entered part way through.',
      );
    }

    // ── BACK / FORWARD / REFRESH_MID_FLOW: the three that need the harness ──
    const historyShapes: WalkShape[] = ['BACK', 'FORWARD', 'REFRESH_MID_FLOW'];
    for (const shape of historyShapes) {
      const descriptor = WALK_SHAPE_DESCRIPTORS[shape];
      if (descriptor.needs !== null && !capabilities.has(descriptor.needs)) {
        record(
          target.id,
          shape,
          'NO_HISTORY_CAPABILITY',
          `${target.route}: this run's harness does not offer ${descriptor.needs}, so the ` +
            `${descriptor.label} walk was not produced. It is a limit of ours, not an absence in ` +
            'the application.',
        );
        continue;
      }
      if (spineEdges.length < 2) {
        record(
          target.id,
          shape,
          'PATH_TOO_SHORT_FOR_SHAPE',
          `${target.route}: a ${descriptor.label} walk needs a path of at least 2 edges, and the ` +
            `longest one the search found within ${budgets.maxPathLength} edge(s) has ` +
            `${spineEdges.length}.`,
        );
        continue;
      }

      const previous = spineEdges[spineEdges.length - 2];
      const previousNode = previous ? nodeById.get(previous.to) : undefined;
      if (shape === 'BACK') {
        propose(
          shape,
          target,
          [
            ...traverseSteps(spine),
            {
              kind: 'BACK',
              target: null,
              expectedNodeId: previousNode?.id ?? null,
              label: 'press the browser back button',
            },
          ],
          spineEdges,
          `reach ${target.route} and press back. ${descriptor.finds}`,
        );
      } else if (shape === 'FORWARD') {
        propose(
          shape,
          target,
          [
            ...traverseSteps(spine),
            {
              kind: 'BACK',
              target: null,
              expectedNodeId: previousNode?.id ?? null,
              label: 'press the browser back button',
            },
            {
              kind: 'FORWARD',
              target: null,
              expectedNodeId: target.id,
              label: 'press the browser forward button',
            },
          ],
          spineEdges,
          `reach ${target.route}, go back, then forward again. ${descriptor.finds}`,
        );
      } else {
        const midIndex = Math.floor(spineEdges.length / 2);
        const partial = spine.slice(0, midIndex);
        const refreshAt = spineEdges[midIndex - 1];
        propose(
          shape,
          target,
          [
            ...traverseSteps(partial),
            {
              kind: 'REFRESH',
              target: refreshAt?.to ?? null,
              expectedNodeId: refreshAt?.to ?? null,
              label: `reload at step ${midIndex} of ${spineEdges.length}`,
            },
            ...traverseSteps(spine.slice(midIndex)),
          ],
          spineEdges,
          `reload part way to ${target.route} and continue. ${descriptor.finds}`,
        );
      }
    }

    /*
     * Every path the search found that no shape above consumed is a walk that
     * EXISTED and was not selected, so it feeds the lower bound rather than
     * vanishing.
     *
     * Counted as a SET of distinct paths rather than as a number of shapes,
     * because three of the shapes draw on an enumerated path and they can draw
     * on the same one: SHORTEST_PATH takes `paths[0]`, ALTERNATIVE_PATH takes
     * the first path that differs from it, and the four length-hungry shapes
     * all share the spine — which on a two-path graph IS the alternative. A
     * hard-coded count would overstate what was consumed on exactly the graphs
     * where the lower bound matters most.
     */
    const consumed = new Set<string>([shortest.join('>'), spine.join('>')]);
    if (second) consumed.add(second.join('>'));
    unselectedPaths += Math.max(0, search.paths.length - consumed.size);
  }

  // ── Per-target cap ──
  const byTarget = new Map<string, Walk[]>();
  for (const walk of candidates) {
    const list = byTarget.get(walk.targetNodeId) ?? [];
    list.push(walk);
    byTarget.set(walk.targetNodeId, list);
  }
  const rankOrder = (left: Walk, right: Walk): number => {
    if (left.rank !== right.rank) return right.rank - left.rank;
    // The ONE place the seed is used. Equal-ranked walks are ordered by a
    // seeded token, so one seed replays exactly and a fresh seed samples a
    // different equal-ranked walk — see WalkSelectionInput.seed.
    const leftToken = tiebreaker.scoped(left.id).token;
    const rightToken = tiebreaker.scoped(right.id).token;
    if (leftToken !== rightToken) return leftToken.localeCompare(rightToken);
    return left.id.localeCompare(right.id);
  };

  let perTargetBites = 0;
  let perTargetDiscarded = 0;
  const kept: Walk[] = [];
  for (const [, list] of [...byTarget.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const ordered = [...list].sort(rankOrder);
    const take = ordered.slice(0, Math.max(0, budgets.walksPerTarget));
    if (ordered.length > take.length) {
      perTargetBites += 1;
      perTargetDiscarded += ordered.length - take.length;
    }
    kept.push(...take);
  }
  if (perTargetDiscarded > 0) {
    caps.push(
      walkCapBite(
        'WALKS_PER_TARGET',
        budgets.walksPerTarget,
        perTargetBites,
        perTargetDiscarded,
        'walks per target node',
        `${perTargetDiscarded} walk(s) across ${perTargetBites} target(s) ranked below the ` +
          `per-target limit of ${budgets.walksPerTarget}; they were constructed and dropped, not ` +
          'found absent',
      ),
    );
  }

  const ranked = kept.sort(rankOrder);
  const walks = ranked.slice(0, Math.max(0, budgets.walksTotal));
  if (ranked.length > walks.length) {
    caps.push(
      walkCapBite(
        'WALKS_TOTAL',
        budgets.walksTotal,
        1,
        ranked.length - walks.length,
        null,
        `${ranked.length - walks.length} ranked walk(s) exceeded the whole-selection limit of ` +
          `${budgets.walksTotal} and were dropped`,
      ),
    );
  }
  if (searchExhausted) {
    caps.push(
      walkCapBite(
        'PATH_ENUMERATION',
        budgets.pathEnumeration,
        1,
        0,
        null,
        `the simple-path search spent its whole budget of ${budgets.pathEnumeration} expansion(s), ` +
          'so an unknown number of paths were never enumerated — this is why atLeastMoreWalks is ' +
          'null rather than a number',
      ),
    );
  }

  const dropped =
    perTargetDiscarded + Math.max(0, ranked.length - walks.length) + unselectedPaths;

  /*
   * Both counts are computed over the SELECTED walks, not the constructed ones.
   * A count over the constructed set would describe a selection the caller
   * never receives, which is the "reported as measured, not measured" shape of
   * lie in a quieter register.
   */
  const statesUnclassified = walks.reduce(
    (running, walk) => running + walk.expectedStates.filter((state) => state.cellKey === null).length,
    0,
  );
  const walksWithUncapturedEdgeKinds = walks.filter((walk) =>
    (pathEdgesOfWalk.get(walk.id) ?? []).some((edge) => edge.kind === undefined),
  ).length;

  return finish(walks, {
    // NULL, not 0, when the search ran out: it genuinely does not know.
    atLeastMoreWalks: searchExhausted ? null : dropped,
    statesUnclassified,
    walksWithUncapturedEdgeKinds,
    rule:
      `${walks.length} walk(s) selected from ${candidates.length} constructed, over ` +
      `${targets.length} target node(s), ranked by the bug class each shape finds rather than by ` +
      `cost (see WALK_SHAPE_DESCRIPTORS). The walk space is infinite, so this is a SAMPLE: every ` +
      `budget that bit is in caps, every shape that produced nothing is in notProduced with a ` +
      `reason, and atLeastMoreWalks is a lower bound — null when the path search could not bound ` +
      `what it missed. Seed ${seed} orders equal-ranked walks, so this selection replays exactly.`,
  });
}

/**
 * A one-line rendering of a walk, for a plan item's steps and for the report.
 *
 * Exported because a reader comparing two walks needs to see the difference at
 * a glance, and `steps.map(s => s.label)` loses the shape — which is the only
 * thing that distinguishes a BACK walk from a FORWARD one that happens to end
 * in the same place.
 */
export function describeWalk(walk: Walk): string {
  const body = walk.steps
    .map((step) =>
      step.kind === 'BACK'
        ? '← back'
        : step.kind === 'FORWARD'
          ? '→ forward'
          : step.kind === 'REFRESH'
            ? '⟳ reload'
            : step.label,
    )
    .join(' → ');
  return `[${walk.shape} ${walk.rank}] ${body}`;
}
