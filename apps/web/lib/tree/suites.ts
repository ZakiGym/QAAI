/**
 * Grouping the explorer by SUITE, and what a drag onto a suite row means.
 *
 * A suite is the third thing a test file belongs to, beside its folder and its
 * feature — and it is the only one of the three that is a row on the server.
 * That difference is the reason this module exists rather than another branch
 * inside `model.ts`:
 *
 *   · A PATH DIR is a place on disk. It can be renamed, moved into, deleted.
 *   · A FEATURE DIR is a column value. It has no id of its own and no server
 *     row behind it, so every structural gesture on it has to be refused.
 *   · A SUITE DIR is a column value AND a row. It cannot be moved into — there
 *     is no path — but it CAN be renamed and deleted, because there is a
 *     `Suite` with that id to rename and delete. Files can be put into it.
 *
 * Confusing the last two is what this file's types exist to prevent:
 * `suiteGroupOf` answers with a real suite id, with "the unassigned group", or
 * with nothing at all, and the panel offers rename and delete only on the first.
 * A group with no server row must never be handed to an endpoint that will 404.
 *
 * ── HOW THE TREE IS BUILT ───────────────────────────────────────────────────
 *
 * `buildSuiteTree` does not re-implement `buildTree`. It re-keys the tests by
 * suite and runs the model's own FEATURE grouping over them, then relabels the
 * groups. Hiding, the aggregate tally, the scope resolution and the sort are
 * therefore the same passes in the same order as every other view of this tree —
 * which is the point: a second implementation of "how many files are hidden
 * under this row" would be a second implementation to keep correct.
 *
 * Two things the wrapper owns because the model cannot know them:
 *
 *   · EMPTY SUITES. `buildTree` grows a group per value it finds in the tests,
 *     so a suite nobody has put a test in yet would have no row — and a suite
 *     with no row is a suite nothing can be dragged into, which makes creating
 *     one pointless. They are appended and the roots re-sorted.
 *   · IDENTITY. A group's id is `suite:<suiteId>`, not `suite:<name>`, so
 *     expansion state and a saved scope survive the suite being renamed.
 *
 * ── WHAT A DROP MEANS ───────────────────────────────────────────────────────
 *
 * Dropping files on a suite row assigns them (feature 31). It is not a move:
 * nothing about the file's path changes, so the `TreeOp` shape that `dnd.ts`
 * produces would be the wrong answer wearing the right clothes — a `move` with a
 * `to` that is not a path is exactly the confusion `entity` was added to stop.
 * `SuiteAssignOp` is its own shape with its own `kind`, and the panel's single
 * executor branches on `kind` the way it already branches on `entity`.
 *
 * The refusals reuse `clipboard.ts`'s `Refusal`, so a refused assignment lands
 * in the same status line, with the same shape, as a refused move.
 */

import { buildTree, type BuildTreeOptions, type FeatureDir, type Grouping, type SortMode, type TreeCrumb, type TreeModel, type TreeNode, type TreeTest } from './model';
import { resolveIds, unresolvedRefusal, type Refusal } from './clipboard';
import type { DropCheck } from './dnd';
import type { TreeRow } from './selection';

/** Grouping the panel offers, including the one `prefs.ts` does not persist. */
export type SuiteGrouping = Grouping | 'suite';

/** Prefix of every suite group's node id. `feature:` is the model's equivalent. */
export const SUITE_ID_PREFIX = 'suite:';

/**
 * The group holding tests that are in no suite.
 *
 * Named after `NO_FEATURE_LABEL` rather than inventing a second convention: the
 * model already answers "what do you call the group for rows with no value" and
 * this is the same question. Its id is the bare prefix — the empty key — for the
 * same reason the model's is `feature:`.
 */
export const NO_SUITE_LABEL = 'No suite';
export const UNASSIGNED_GROUP_ID = SUITE_ID_PREFIX;

/** The longest name the API will store (`suiteName` in apps/api/src/routes/suites.ts). */
export const MAX_SUITE_NAME = 80;

/** A suite as `GET /projects/:id/suites` returns it, narrowed to what a row needs. */
export interface TreeSuite {
  id: string;
  name: string;
  /** Tests the server counted in it. Not used to build the tree — the tests are. */
  testCount?: number;
}

/**
 * A test with the column this grouping reads.
 *
 * Optional, so every existing caller of the tree still typechecks. `GET
 * /projects/:id/tests` has always selected `suiteId`, so the value is there at
 * runtime even where the caller's own type has not declared it — and a caller
 * that really does not send it gets one honest "No suite" group rather than a
 * crash.
 */
export interface SuiteTest extends TreeTest {
  suiteId?: string | null;
}

/** `buildTree`'s answer, with the grouping named for what it actually is. */
export interface SuiteTreeModel extends Omit<TreeModel, 'grouping'> {
  grouping: 'suite';
}

// ─── Identity ────────────────────────────────────────────────────────────────

/** The node id for a suite's group row. Stable across renames — it is the id. */
export const suiteGroupId = (suiteId: string): string => `${SUITE_ID_PREFIX}${suiteId}`;

/**
 * What a group row IS, decided from its node id alone.
 *
 * The three answers are the three different things the panel may do with a row,
 * and keeping them apart in the type is what stops the menu offering "Rename" on
 * a heading the server has never heard of.
 */
export type SuiteGroup =
  /** A real `Suite` row: renameable, deletable, and a drop assigns into it. */
  | { kind: 'suite'; suiteId: string }
  /** The tests in no suite: a drop here UNASSIGNS. Nothing to rename or delete. */
  | { kind: 'unassigned' };

export function suiteGroupOf(nodeId: string): SuiteGroup | null {
  if (!nodeId.startsWith(SUITE_ID_PREFIX)) return null;
  const suiteId = nodeId.slice(SUITE_ID_PREFIX.length);
  return suiteId === '' ? { kind: 'unassigned' } : { kind: 'suite', suiteId };
}

// ─── The context a suite view needs ──────────────────────────────────────────

/**
 * The two lookups every function here needs, resolved once.
 *
 * `suiteOf` deliberately answers `null` for a test pointing at a suite this
 * client has not got — the two lists are two reads, and a test assigned in
 * another tab a second ago names an id the panel does not know yet. Grouping and
 * dropping both go through this one normalisation, so the row a file is drawn
 * under and the suite a drop compares against can never disagree.
 */
export interface SuiteContext {
  byId: ReadonlyMap<string, TreeSuite>;
  suiteOf: (testId: string) => string | null;
}

export function suiteContext(
  suites: readonly TreeSuite[],
  tests: readonly SuiteTest[],
): SuiteContext {
  const byId = new Map(suites.map((suite) => [suite.id, suite]));
  const assignment = new Map<string, string>();
  for (const test of tests) {
    const suiteId = test.suiteId ?? null;
    if (suiteId !== null && byId.has(suiteId)) assignment.set(test.id, suiteId);
  }
  return { byId, suiteOf: (testId) => assignment.get(testId) ?? null };
}

/** The label a suite id reads as, including the one that means "none". */
export function suiteLabel(context: SuiteContext, suiteId: string | null): string {
  if (suiteId === null) return NO_SUITE_LABEL;
  return context.byId.get(suiteId)?.name ?? NO_SUITE_LABEL;
}

// ─── Building the tree ───────────────────────────────────────────────────────

/**
 * Natural order with an exact fallback — the same rule `model.ts` sorts names
 * by, mirrored here rather than imported because it is not exported.
 *
 * It has to be mirrored rather than skipped: the group labels this file writes
 * are not the ones the model sorted by (an unassigned group is keyed on `''` and
 * labelled `No suite`, and an empty suite has no key at all), so the roots are
 * re-sorted once the labels are final.
 */
function compareName(a: string, b: string): number {
  const natural = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  if (natural !== 0) return natural;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `compareNodes` from the model, for the one case suite grouping has: dir vs dir. */
function compareGroups(a: FeatureDir, b: FeatureDir, sort: SortMode): number {
  if (sort === 'lastRun' && a.lastRunAt !== b.lastRunAt) {
    // Never-run sinks whatever the direction: it is unknown, not old.
    if (a.lastRunAt === null) return 1;
    if (b.lastRunAt === null) return -1;
    return b.lastRunAt - a.lastRunAt;
  }
  if (sort === 'flakiness' && a.flakeRate !== b.flakeRate) return b.flakeRate - a.flakeRate;
  const byName = compareName(a.name, b.name);
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** An empty suite's row: the same shape a group with tests in it has. */
function emptyGroup(suite: TreeSuite): FeatureDir {
  return {
    kind: 'dir',
    source: 'feature',
    id: suiteGroupId(suite.id),
    name: suite.name,
    // The model's `feature` field carries the value a group was keyed on. Here
    // that key is the suite's name, which is unique per project by the schema.
    feature: suite.name,
    children: [],
    fileCount: 0,
    flagCount: 0,
    hiddenCount: 0,
    lastRunAt: null,
    flakeRate: 0,
  };
}

const isGroup = (node: TreeNode): node is FeatureDir =>
  node.kind === 'dir' && node.source === 'feature';

/**
 * The tests, grouped by the suite they are in.
 *
 * `suites` is the project's suites — every one of them, including those with no
 * tests, because an empty suite still needs a row to drag files onto.
 *
 * A suite whose name is literally "No suite" gets its own row beside the
 * unassigned group, and the two are told apart by their ids rather than their
 * labels. That collision is inherited from the feature grouping, which has the
 * same one for a feature called "No feature", and inventing a different answer
 * here would make two views of the same tree disagree about the same edge.
 */
export function buildSuiteTree(
  tests: readonly SuiteTest[],
  suites: readonly TreeSuite[],
  options: BuildTreeOptions = {},
): SuiteTreeModel {
  const context = suiteContext(suites, tests);
  const idByName = new Map(suites.map((suite) => [suite.name, suite.id]));
  const sort: SortMode = options.sort ?? 'name';

  /*
   * Re-keyed onto `feature`, which is the field the model groups by. The key is
   * the suite's NAME rather than its id so the model's own sort and its group
   * labels are already right for everything except the two cases handled below;
   * names are unique per project (`@@unique([projectId, name])`).
   */
  const keyed: TreeTest[] = tests.map((test) => ({
    ...test,
    feature: suiteLabelKey(context, test),
  }));

  /*
   * A scope is stored as `suite:<id>` — the id, so it survives a rename — and
   * the model resolves scopes against the keys it built. An id this client does
   * not know translates to nothing, which is exactly right: the model reports
   * `scopeMissing` and shows the whole tree rather than an empty panel.
   */
  const scope = translateScope(options.scope ?? null, context);

  const base = buildTree(keyed, { ...options, grouping: 'feature', scope });

  const seen = new Set<string>();
  const roots: TreeNode[] = base.roots.map((node) => {
    if (!isGroup(node)) return node;
    const suiteId = idByName.get(node.feature) ?? null;
    if (suiteId !== null) seen.add(suiteId);
    return {
      ...node,
      id: suiteId === null ? UNASSIGNED_GROUP_ID : suiteGroupId(suiteId),
      name: node.feature === '' ? NO_SUITE_LABEL : node.name,
    };
  });

  /*
   * Only when the view is the whole tree. Inside a scope the roots are one
   * group's FILES, and appending suite rows there would put groups inside a
   * group.
   */
  if (base.scope.length === 0) {
    for (const suite of suites) if (!seen.has(suite.id)) roots.push(emptyGroup(suite));
    roots.sort((a, b) => compareGroups(a as FeatureDir, b as FeatureDir, sort));
  }

  return {
    ...base,
    roots,
    scope: base.scope.map((crumb) => renameCrumb(crumb, idByName)),
    grouping: 'suite',
  };
}

/** The group key for one test: its suite's name, or `''` for "in no suite". */
function suiteLabelKey(context: SuiteContext, test: SuiteTest): string {
  const suiteId = test.suiteId ?? null;
  if (suiteId === null) return '';
  return context.byId.get(suiteId)?.name ?? '';
}

/** `suite:<id>` → the `feature:<name>` the model will have built, or null. */
function translateScope(scope: string | null, context: SuiteContext): string | null {
  if (scope === null) return null;
  const group = suiteGroupOf(scope);
  if (!group) return scope;
  if (group.kind === 'unassigned') return 'feature:';
  const suite = context.byId.get(group.suiteId);
  // A scope naming a suite that no longer exists resolves to nothing on purpose.
  return suite ? `feature:${suite.name}` : scope;
}

function renameCrumb(crumb: TreeCrumb, idByName: ReadonlyMap<string, string>): TreeCrumb {
  if (!crumb.id.startsWith('feature:')) return crumb;
  const key = crumb.id.slice('feature:'.length);
  const suiteId = idByName.get(key) ?? null;
  return {
    name: key === '' ? NO_SUITE_LABEL : crumb.name,
    id: suiteId === null ? UNASSIGNED_GROUP_ID : suiteGroupId(suiteId),
  };
}

// ─── Names ───────────────────────────────────────────────────────────────────

/** Suite names already spoken for, so a rename can refuse a collision locally. */
export function suiteNamesExcept(
  suites: readonly TreeSuite[],
  exceptId: string | null,
): Set<string> {
  const out = new Set<string>();
  for (const suite of suites) if (suite.id !== exceptId) out.add(suite.name);
  return out;
}

/** `New suite`, `New suite 2`, … — the first one no suite in this project claims. */
export function freeSuiteName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * Control characters, which survive a paste and produce a name nothing can
 * render. Matching them IS the point, so the lint rule that reads a control
 * character in a pattern as a typo is wrong about this line — the same
 * exception `useTreeController` makes for the same class.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f]/;

export interface NameCheck {
  ok: boolean;
  /** Ready to show under the input. Null when `ok`. */
  message: string | null;
}

/**
 * Is this a suite name the server will take, and is it free?
 *
 * Checked here because a rename is an inline edit: the input is still open and
 * still focused, so saying "that name is taken" beside it costs nothing, while a
 * round trip that comes back 409 has already closed the editor and thrown the
 * typing away. The rules are the server's own — trimmed, 1 to 80 characters,
 * unique within the project.
 *
 * Slashes are allowed, unlike a file name: a suite is not a path, and "Checkout
 * / EU" is a name somebody will reasonably want.
 */
export function validateSuiteName(raw: string, taken: ReadonlySet<string>): NameCheck {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, message: 'A suite needs a name' };
  if (name.length > MAX_SUITE_NAME) {
    return { ok: false, message: `Keep it under ${MAX_SUITE_NAME} characters` };
  }
  if (INVISIBLE.test(name)) {
    return { ok: false, message: 'That name has invisible characters in it' };
  }
  if (taken.has(name)) return { ok: false, message: `A suite called ${name} already exists` };
  return { ok: true, message: null };
}

// ─── Dropping onto a suite ───────────────────────────────────────────────────

/**
 * One file's assignment.
 *
 * Shaped after `TreeOp` — same `kind`/`id`/`entity` front — so the panel's
 * executor can hold a union of the two and branch once. `from` and `to` are
 * suite ids rather than paths, and `null` is a real value on both: `to: null`
 * takes a file out of its suite, and `from: null` is a file that was in none.
 */
export interface SuiteAssignOp {
  kind: 'assign';
  /** The namespaced ROW id, exactly as `rows.ts` mints it (`f:<testId>`). */
  id: string;
  entity: 'file';
  testId: string;
  from: string | null;
  to: string | null;
  /** The file's path, for the sentence a refusal or an outcome is written into. */
  path: string;
}

export interface SuitePlan {
  ops: SuiteAssignOp[];
  refusals: Refusal[];
}

/** Where a drop aimed at this row would put files, or null when it is not a suite target. */
export interface SuiteDropTarget {
  /** The suite to assign into; `null` means the unassigned group — a drop UNASSIGNS. */
  suiteId: string | null;
  name: string;
}

/** A row the suite view can address. `PanelRow` satisfies it. */
export interface SuiteAwareRow extends TreeRow {
  /** The model id behind the row: a test id for a file, `suite:<id>` for a group. */
  nodeId: string;
}

/**
 * The suite a drop on `targetRowId` means.
 *
 * A group row means itself. A FILE row means the suite that file is in — the
 * cursor is over a place in a list, and the answer a person expects from
 * dropping onto a row inside "Checkout" is "put it in Checkout". That mirrors
 * how a drop onto a file in path grouping means the folder it lives in.
 *
 * `null` for anything else, including the panel background: in suite grouping
 * there is no root to fall back on, and inventing one would assign files to
 * whatever happened to be first.
 */
export function suiteDropTargetOf<R extends SuiteAwareRow>(
  context: SuiteContext,
  rows: readonly R[],
  targetRowId: string | null,
): SuiteDropTarget | null {
  if (targetRowId === null) return null;
  const row = rows.find((candidate) => candidate.id === targetRowId);
  if (!row) return null;

  if (row.kind === 'dir') {
    const group = suiteGroupOf(row.nodeId);
    if (!group) return null;
    if (group.kind === 'unassigned') return { suiteId: null, name: NO_SUITE_LABEL };
    // A group whose suite this client no longer knows about is not a target: the
    // assignment would name an id the server would 404 on.
    const suite = context.byId.get(group.suiteId);
    return suite ? { suiteId: suite.id, name: suite.name } : null;
  }

  const suiteId = context.suiteOf(row.nodeId);
  return { suiteId, name: suiteLabel(context, suiteId) };
}

/**
 * What dropping these rows on this target would do, and what it refuses.
 *
 * `allRows` is EVERY row in the tree, collapsed groups included — the same rule
 * `clipboard.ts` states and for the same reason: an id the list cannot resolve
 * is reported by name rather than dropped, because a drop that assigned three of
 * the five files somebody dragged, saying nothing about the other two, is
 * indistinguishable from a bug in the server.
 */
export function planSuiteDrop<R extends SuiteAwareRow>(
  context: SuiteContext,
  allRows: readonly R[],
  draggedIds: readonly string[],
  target: SuiteDropTarget,
): SuitePlan {
  const { entries, unresolved } = resolveIds(allRows, draggedIds);
  const byId = new Map(allRows.map((row) => [row.id, row]));

  const ops: SuiteAssignOp[] = [];
  const refusals: Refusal[] = unresolved.map(unresolvedRefusal);

  for (const entry of entries) {
    const row = byId.get(entry.id);
    if (!row) continue;

    /*
     * A group row. There is no gesture here worth inventing: suites do not
     * nest, and dragging one onto another has no meaning the server could
     * carry out. Refused by name — `no-path` is the reason the tree already
     * uses for a row that names nothing on disk.
     */
    if (row.kind === 'dir') {
      refusals.push({
        id: row.id,
        path: row.path,
        reason: 'no-path',
        message: `${row.name} is a suite, not a test — drag files onto it instead`,
      });
      continue;
    }

    const from = context.suiteOf(row.nodeId);
    if (from === target.suiteId) {
      /*
       * Already there. Refused rather than sent as a no-op: the server refuses
       * it too (`already in "Checkout"`), and a drop that spends a request, an
       * audit row and a full reload to change nothing makes the tree flicker for
       * no reason. `same-folder` is the reason a move onto its own folder earns,
       * which is the same shape of mistake.
       */
      refusals.push({
        id: row.id,
        path: row.path,
        reason: 'same-folder',
        message:
          target.suiteId === null
            ? `${row.name} is not in a suite already`
            : `${row.name} is already in ${target.name}`,
      });
      continue;
    }

    ops.push({
      kind: 'assign',
      id: row.id,
      entity: 'file',
      testId: row.nodeId,
      from,
      to: target.suiteId,
      path: row.path,
    });
  }

  return { ops, refusals };
}

/**
 * May this drag land on this row?
 *
 * Answered by planning the drop and reading the result, so the highlight the
 * user sees and the work that happens on mouse-up can never disagree — the same
 * contract `canDrop` keeps in `dnd.ts`. For a multi-drag, one file landing is
 * enough; the rest are reported, not silently dropped.
 */
export function canDropOnSuite<R extends SuiteAwareRow>(
  context: SuiteContext,
  allRows: readonly R[],
  draggedIds: readonly string[],
  targetRowId: string | null,
): DropCheck {
  const target = suiteDropTargetOf(context, allRows, targetRowId);
  if (!target) {
    return {
      ok: false,
      reason: 'no-target',
      message: 'Drop files onto a suite to put them in it',
    };
  }
  const plan = planSuiteDrop(context, allRows, draggedIds, target);
  if (plan.ops.length > 0) return { ok: true, reason: null, message: null };
  const first = plan.refusals[0];
  return { ok: false, reason: first?.reason ?? 'no-target', message: first?.message ?? null };
}

/**
 * One call to the API: a batch of tests, addressed to one suite.
 *
 * `suiteId` is always a real suite even for `unassign`, because the endpoint is
 * `POST /suites/:suiteId/tests/unassign` — the request says which suite the
 * caller believed it was emptying, and the server refuses a test that has since
 * moved elsewhere rather than quietly pulling it out of a suite nobody asked
 * about.
 */
export interface SuiteAssignRequest {
  suiteId: string;
  direction: 'assign' | 'unassign';
  /** The ops this call covers, so a partial batch knows exactly what landed. */
  opIds: string[];
  testIds: string[];
}

/**
 * Group planned assignments into the calls that perform them.
 *
 * Two things make this more than a map:
 *
 *   · AN UNASSIGNMENT IS ADDRESSED TO THE SUITE THE FILE IS LEAVING. One drop on
 *     the "No suite" row can carry files out of three different suites, and
 *     those are three different calls. Sending them as one — to whichever suite
 *     happened to be first — would be a request the server is right to refuse,
 *     and worse, one it might not.
 *   · A DROP CAN BE BIGGER THAN THE SERVER'S BATCH CAP. Split rather than
 *     refused: each chunk is atomic on its own, which is weaker than one
 *     transaction and far better than one request per file.
 *
 * An op that would move a test from no suite to no suite is dropped here rather
 * than addressed to a suite id that does not exist. The planner already refuses
 * that case; this is the second line, because the alternative is a URL with
 * `null` in it.
 */
export function suiteAssignRequests(
  ops: readonly SuiteAssignOp[],
  limit: number,
): SuiteAssignRequest[] {
  const batches = new Map<string, { suiteId: string; direction: 'assign' | 'unassign'; ops: SuiteAssignOp[] }>();

  for (const op of ops) {
    const direction: 'assign' | 'unassign' = op.to === null ? 'unassign' : 'assign';
    const suiteId = op.to ?? op.from;
    if (suiteId === null) continue;
    const key = `${direction}:${suiteId}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { suiteId, direction, ops: [] };
      batches.set(key, batch);
    }
    batch.ops.push(op);
  }

  const out: SuiteAssignRequest[] = [];
  for (const batch of batches.values()) {
    for (let at = 0; at < batch.ops.length; at += limit) {
      const chunk = batch.ops.slice(at, at + limit);
      out.push({
        suiteId: batch.suiteId,
        direction: batch.direction,
        opIds: chunk.map((op) => op.id),
        testIds: chunk.map((op) => op.testId),
      });
    }
  }
  return out;
}

/**
 * The sentence a landed assignment gets.
 *
 * Written here beside the plan rather than in the panel, because the two halves
 * — into a suite, out of one — are the same fact said two ways and a caller
 * assembling it by hand would eventually say "Assigned 3 files to No suite".
 */
export function assignmentSummary(count: number, target: SuiteDropTarget): string {
  const files = `${count} ${count === 1 ? 'file' : 'files'}`;
  return target.suiteId === null
    ? `Took ${files} out of their suite`
    : `Put ${files} in ${target.name}`;
}
