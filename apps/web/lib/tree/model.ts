/**
 * The pure tree model behind the tests explorer.
 *
 * Everything the panel renders is derived here: the folder tree itself, the
 * feature grouping that replaces it, the hide patterns, the folder scope and
 * the compacted single-child chains. It is one function because those features
 * interact — compaction has to happen after hiding, scope has to resolve before
 * compaction, and sorting has to see the aggregates that hiding changed. Split
 * across the component they would each be right on their own and wrong together.
 *
 * Nothing in this file touches React, the DOM, the network or the clock, so the
 * whole explorer is testable as data in, data out, and cheap enough to rebuild
 * on every keystroke.
 *
 * Supersedes ../tree.ts. `TreeTest`, `TreeFile` and `TreeDir` are supersets of
 * the shapes there, so a caller migrates by swapping the import and reading
 * `.roots` off the result — the extra return fields (hidden counts, breadcrumbs)
 * exist because a count that vanishes with the row it described is a bug.
 */

/**
 * Kept in sync with FIXTURE_PREFIX in @qaai/shared. Duplicated as a plain string
 * here rather than imported, because that package ships source TS and the web
 * build has no transpilePackages entry for it.
 */
export const FIXTURE_PREFIX = 'fixtures/';

/**
 * The columns the cockpit's `GET /projects/:id/tests` actually returns, narrowed
 * to what a tree row needs. `feature`, `flakeRate` and `lastRunAt` are optional
 * so the older callers — which selected none of them — still typecheck; a sort
 * mode that needs a missing field treats it as "never run" / "never flaked"
 * rather than throwing.
 */
export interface TreeTest {
  id: string;
  name: string;
  type: string;
  filePath: string;
  reviewFlags: string[];
  feature?: string | null;
  flakeRate?: number | null;
  lastRunAt?: string | Date | null;
}

/** Filesystem tree, or the feature field. Both produce the same node shape. */
export type Grouping = 'path' | 'feature';

/**
 * Folders always sort before files whatever this says — that is the rule every
 * file explorer has and people navigate by muscle memory, not by preference.
 * Every mode breaks its ties on name so the order is total: an unstable sort
 * makes rows swap places while someone is looking at them.
 */
export type SortMode = 'name' | 'type' | 'lastRun' | 'flakiness';

/** One clickable piece of a compacted folder label, e.g. the `checkout` in `hand-written/checkout/deep`. */
export interface DirSegment {
  name: string;
  /** Full path of this segment — what to hand back as an `uncompacted` entry or a `scope`. */
  path: string;
}

/** The counters every folder row can display. All aggregate over descendants. */
interface DirCounts {
  /** Visible files below this folder. */
  fileCount: number;
  /** Of those, how many carry generator review flags. */
  flagCount: number;
  /** Files below this folder that `hide` patterns removed. Never silently zero. */
  hiddenCount: number;
  /** Most recent descendant run, epoch ms; null when nothing below has ever run. */
  lastRunAt: number | null;
  /** Worst descendant flake rate, 0..1. */
  flakeRate: number;
}

export interface TreeFile {
  kind: 'file';
  source: Grouping;
  /** The test id. Stable, unique, and what selection and expansion state key on. */
  id: string;
  /** File name in path mode; the test's own name in feature mode, where the path is not the subject. */
  name: string;
  /** Full filePath. Present in both modes — a test is always a file somewhere. */
  path: string;
  test: TreeTest;
}

/** A real directory: it has a path, so it can be renamed, deleted and scoped to. */
export interface PathDir extends DirCounts {
  kind: 'dir';
  source: 'path';
  /**
   * Identity for expansion and selection. For a compacted chain this is the
   * OUTERMOST path, so toggling compaction does not make an open folder forget
   * it was open — the row keeps its identity while its label and `path` change.
   */
  id: string;
  /** `deep` normally; `hand-written/checkout/deep` when the chain is compacted. */
  name: string;
  /** The folder this row ACTS on — the deepest of a compacted chain, as in VS Code. */
  path: string;
  /** Every folder the label stands for, outermost first. Length 1 unless compacted. */
  segments: DirSegment[];
  children: TreeNode[];
  feature?: undefined;
}

/**
 * A feature group. It has no `path` and never will, and the missing field is
 * the point: `if (dir.source === 'path')` is what stops the UI offering "rename
 * folder" on something that is a database column, not a directory.
 */
export interface FeatureDir extends DirCounts {
  kind: 'dir';
  source: 'feature';
  /** Synthetic and stable: `feature:` + the feature name. */
  id: string;
  name: string;
  /** The raw feature value; '' for the group holding tests with no feature. */
  feature: string;
  children: TreeNode[];
  path?: undefined;
  segments?: undefined;
}

export type TreeDir = PathDir | FeatureDir;
export type TreeNode = TreeFile | TreeDir;

/** Prefix of every `FeatureDir.id`. Exported so callers can recognise one without a type import. */
export const FEATURE_ID_PREFIX = 'feature:';

/** Label for the group holding tests whose `feature` is null or blank. */
export const NO_FEATURE_LABEL = 'No feature';

export interface BuildTreeOptions {
  /** Default 'path'. */
  grouping?: Grouping;
  /** Default 'name'. */
  sort?: SortMode;
  /** Collapse single-child folder chains into one row. Default false. */
  compactFolders?: boolean;
  /**
   * Folder paths that must keep a row of their own even when compaction would
   * absorb them. This is how clicking segment 2 of 3 expands just that far:
   * add that segment's path here and the chain splits there.
   */
  uncompacted?: Iterable<string>;
  /** Glob-ish patterns (`*` and `**` only). Matched nodes vanish but stay counted. */
  hide?: readonly string[];
  /** Folder path (or feature dir id) to treat as the root. */
  scope?: string | null;
}

/** One step of the trail back out of a scoped folder. `id` is what to pass as the next `scope`. */
export interface TreeCrumb {
  name: string;
  id: string;
}

export interface TreeModel {
  roots: TreeNode[];
  /** Visible files in the current view. */
  fileCount: number;
  flagCount: number;
  /** Files the `hide` patterns removed from the current view. Surface it; a hidden file must never look like a missing one. */
  hiddenCount: number;
  /** Empty when unscoped; otherwise root-most folder first, ending at the scope itself. */
  scope: TreeCrumb[];
  /** True when a `scope` was asked for and no longer exists, and the full tree was shown instead of an empty panel. */
  scopeMissing: boolean;
  grouping: Grouping;
  sort: SortMode;
}

// ─── Glob-ish hide patterns ──────────────────────────────────────────────────

/**
 * `*` and `**`, matched by hand.
 *
 * These patterns are typed by a user, and apps/api/src/routes/projects.ts spells
 * out why user input never becomes a pattern object: a compiled RegExp cannot be
 * interrupted mid-match, so one pathological string is one wedged thread. The
 * same reasoning applies in a browser tab that rebuilds this tree on every
 * keystroke. A segment walk is linear in the path length no matter what is typed
 * and needs no cache to stay cheap.
 *
 * Matching is case-insensitive. A hide box is not a shell: someone who types
 * `*.PNG` means the png files, and being right about POSIX case rules here would
 * only ever read as a bug.
 */
interface HidePattern {
  /** Pattern split on '/', already lowercased. */
  segments: string[];
  /** Written with a trailing slash, so it may only match folders. */
  dirOnly: boolean;
  /** No '/' anywhere, so it matches a bare name at any depth as well as a full path. */
  bareName: boolean;
}

/** Longer than any pattern a person types; a longer one is a paste, and every `**` in it costs backtracking. */
const MAX_PATTERN_LENGTH = 200;

function parseHidePatterns(patterns: readonly string[] | undefined): HidePattern[] {
  if (!patterns || patterns.length === 0) return [];
  const out: HidePattern[] = [];
  for (const raw of patterns) {
    let text = raw.trim();
    if (text.length === 0 || text.length > MAX_PATTERN_LENGTH) continue;
    const dirOnly = text.endsWith('/');
    // Strip the decorations that mean nothing here: a leading './' or '/' is how
    // people write "from the root", which is the only thing these paths ever are.
    text = text.replace(/\/+$/, '');
    if (text.startsWith('./')) text = text.slice(2);
    while (text.startsWith('/')) text = text.slice(1);
    if (text.length === 0) continue;
    const segments = text.toLowerCase().split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    out.push({ segments, dirOnly, bareName: !text.includes('/') });
  }
  return out;
}

/**
 * `*` inside one segment: a two-pointer walk with a single backtrack point,
 * which is the standard way to match a star glob without recursion.
 */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * `**` spans zero or more segments: `a/**` matches `a` itself as well as
 * everything under it, and a `**` in the middle matches across any depth.
 */
function matchSegments(pattern: string[], p: number, path: string[], s: number): boolean {
  /*
   * Memoised on (pattern index, path index), which is what keeps this bounded.
   *
   * The plain recursion below is exponential in the number of `**` groups: each
   * one forks once per remaining segment, and two of them multiply. A pattern
   * like `**\/**\/**\/**\/**\/x` against a deep path is a frozen tab — not a
   * crash, not an error, just a browser that stops responding while a filter
   * box waits for a keystroke that already happened.
   *
   * That matters more here than the shape of the input suggests. Hide patterns
   * are typed by a person and stored per project, so one bad pattern is
   * persisted and reapplied on every load: the tab wedges again every time the
   * panel opens, and the only way out is clearing localStorage.
   *
   * Memoising collapses it to at most (pattern.length + 1) × (path.length + 1)
   * distinct states, each decided once. Failures are what get recorded — a
   * success returns immediately and never revisits anything.
   */
  const failed = new Set<number>();
  const stride = path.length + 1;

  const walk = (p0: number, s0: number): boolean => {
    let pi = p0;
    let si = s0;
    while (pi < pattern.length) {
      const key = pi * stride + si;
      if (failed.has(key)) return false;

      const token = pattern[pi] as string;
      if (token === '**') {
        for (let skip = si; skip <= path.length; skip += 1) {
          if (walk(pi + 1, skip)) return true;
        }
        failed.add(key);
        return false;
      }
      if (si >= path.length) {
        failed.add(key);
        return false;
      }
      if (!matchSegment(token, path[si] as string)) {
        failed.add(key);
        return false;
      }
      pi += 1;
      si += 1;
    }
    return si === path.length;
  };

  return walk(p, s);
}

function isHidden(patterns: HidePattern[], path: string, name: string, isDir: boolean): boolean {
  if (patterns.length === 0) return false;
  const lowerPath = path.toLowerCase().split('/').filter((s) => s.length > 0);
  const lowerName = [name.toLowerCase()];
  for (const pattern of patterns) {
    if (pattern.dirOnly && !isDir) continue;
    if (matchSegments(pattern.segments, 0, lowerPath, 0)) return true;
    // A pattern with no slash is a name, not a location: `*.log` and `snapshots`
    // are meant at any depth, the way every ignore file in the world reads them.
    if (pattern.bareName && matchSegments(pattern.segments, 0, lowerName, 0)) return true;
  }
  return false;
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

/**
 * Natural order, then an exact fallback. `localeCompare` with `numeric` puts
 * `step2` before `step10`, which is what a person means by alphabetical, but it
 * calls `A` and `a` equal — and "equal" in a comparator is what lets two rows
 * trade places between renders. The codepoint compare underneath makes the
 * order total.
 */
function compareName(a: string, b: string): number {
  const natural = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  if (natural !== 0) return natural;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Epoch ms, or null for "never ran". Accepts the API's ISO string or a real Date. */
function runTime(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function flakeOf(test: TreeTest): number {
  const rate = test.flakeRate;
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : 0;
}

function nodeLastRun(node: TreeNode): number | null {
  return node.kind === 'dir' ? node.lastRunAt : runTime(node.test.lastRunAt);
}

function nodeFlake(node: TreeNode): number {
  return node.kind === 'dir' ? node.flakeRate : flakeOf(node.test);
}

function compareNodes(a: TreeNode, b: TreeNode, sort: SortMode): number {
  // Folders first, always. Every explorer does this and people rely on it.
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;

  if (sort === 'type' && a.kind === 'file' && b.kind === 'file') {
    const byType = compareName(a.test.type, b.test.type);
    if (byType !== 0) return byType;
  }

  if (sort === 'lastRun') {
    const ta = nodeLastRun(a);
    const tb = nodeLastRun(b);
    if (ta !== tb) {
      // Never-run sinks whatever the direction: it is unknown, not old, and
      // floating it to the top of a "most recent" list would be a lie.
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
  }

  if (sort === 'flakiness') {
    const fa = nodeFlake(a);
    const fb = nodeFlake(b);
    if (fa !== fb) return fb - fa;
  }

  const byName = compareName(a.name, b.name);
  if (byName !== 0) return byName;
  // Two tests can share a file path. Ids cannot, so the order stays total.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortTree(nodes: TreeNode[], sort: SortMode): void {
  nodes.sort((a, b) => compareNodes(a, b, sort));
  for (const node of nodes) {
    if (node.kind === 'dir') sortTree(node.children, sort);
  }
}

// ─── Construction ────────────────────────────────────────────────────────────

function newPathDir(path: string, name: string): PathDir {
  return {
    kind: 'dir',
    source: 'path',
    id: path,
    name,
    path,
    segments: [{ name, path }],
    children: [],
    fileCount: 0,
    flagCount: 0,
    hiddenCount: 0,
    lastRunAt: null,
    flakeRate: 0,
  };
}

function newFeatureDir(feature: string): FeatureDir {
  return {
    kind: 'dir',
    source: 'feature',
    id: `${FEATURE_ID_PREFIX}${feature}`,
    name: feature === '' ? NO_FEATURE_LABEL : feature,
    feature,
    children: [],
    fileCount: 0,
    flagCount: 0,
    hiddenCount: 0,
    lastRunAt: null,
    flakeRate: 0,
  };
}

/** Path segments with the empty ones dropped; the server validates filePath, but the tree must never crash on odd input. */
function pathSegments(filePath: string): string[] {
  return filePath.split('/').filter(Boolean);
}

function buildPathTree(tests: readonly TreeTest[]): PathDir {
  const root = newPathDir('', '');
  const dirs = new Map<string, PathDir>([['', root]]);

  const ensureDir = (path: string): PathDir => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf('/');
    const parentPath = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parent = ensureDir(parentPath);
    const dir = newPathDir(path, name);
    parent.children.push(dir);
    dirs.set(path, dir);
    return dir;
  };

  for (const test of tests) {
    const segments = pathSegments(test.filePath);
    if (segments.length === 0) continue;
    const fileName = segments[segments.length - 1] as string;
    const dir = ensureDir(segments.slice(0, -1).join('/'));
    dir.children.push({
      kind: 'file',
      source: 'path',
      id: test.id,
      name: fileName,
      path: test.filePath,
      test,
    });
  }
  return root;
}

/**
 * The same node shape, grouped by the `feature` column instead of the folders.
 * Rows are labelled with the test NAME here: in this mode the path is not what
 * the person is reading by, and `checkout.spec.ts` three times under one feature
 * is a list of identical rows.
 */
function buildFeatureTree(tests: readonly TreeTest[]): PathDir {
  const root = newPathDir('', '');
  const groups = new Map<string, FeatureDir>();

  for (const test of tests) {
    if (pathSegments(test.filePath).length === 0) continue;
    const feature = (test.feature ?? '').trim();
    let group = groups.get(feature);
    if (!group) {
      group = newFeatureDir(feature);
      groups.set(feature, group);
      root.children.push(group);
    }
    group.children.push({
      kind: 'file',
      source: 'feature',
      id: test.id,
      name: test.name,
      path: test.filePath,
      test,
    });
  }
  return root;
}

// ─── Hiding ──────────────────────────────────────────────────────────────────

/**
 * Prune matched nodes, recording how many FILES each folder lost directly.
 * Returns the subtree's total, so a folder that empties out can roll its losses
 * up to its parent instead of leaving an empty row or dropping the count.
 */
function pruneHidden(dir: PathDir | FeatureDir, patterns: HidePattern[]): number {
  if (patterns.length === 0) return 0;
  const kept: TreeNode[] = [];
  let own = 0;
  let total = 0;

  for (const child of dir.children) {
    if (child.kind === 'file') {
      if (isHidden(patterns, child.path, fileBaseName(child), false)) {
        own += 1;
        total += 1;
      } else {
        kept.push(child);
      }
      continue;
    }
    // A feature group is a column value, not a path; no pattern can name one.
    if (child.source === 'path' && isHidden(patterns, child.path, child.name, true)) {
      const lost = countFiles(child);
      own += lost;
      total += lost;
      continue;
    }
    const inside = pruneHidden(child, patterns);
    total += inside;
    // A folder whose every file was hidden is not a folder worth a row, but its
    // losses are still losses: they move up to the parent rather than disappear.
    if (child.children.length === 0) own += inside;
    else kept.push(child);
  }

  dir.children = kept;
  dir.hiddenCount = own;
  return total;
}

/** In feature mode a row's name is the test name, so hide patterns need the real file name. */
function fileBaseName(file: TreeFile): string {
  const segments = pathSegments(file.path);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : file.name;
}

function countFiles(node: TreeNode): number {
  if (node.kind === 'file') return 1;
  let n = 0;
  for (const child of node.children) n += countFiles(child);
  return n;
}

// ─── Aggregates ──────────────────────────────────────────────────────────────

/** Bottom-up, once. `hiddenCount` arrives holding this folder's own losses and leaves holding the subtree's. */
function tally(dir: PathDir | FeatureDir): void {
  let files = 0;
  let flags = 0;
  let hidden = dir.hiddenCount;
  let last: number | null = null;
  let flake = 0;

  for (const child of dir.children) {
    if (child.kind === 'file') {
      files += 1;
      if (child.test.reviewFlags.length > 0) flags += 1;
      const ran = runTime(child.test.lastRunAt);
      if (ran !== null && (last === null || ran > last)) last = ran;
      flake = Math.max(flake, flakeOf(child.test));
    } else {
      tally(child);
      files += child.fileCount;
      flags += child.flagCount;
      hidden += child.hiddenCount;
      if (child.lastRunAt !== null && (last === null || child.lastRunAt > last)) last = child.lastRunAt;
      flake = Math.max(flake, child.flakeRate);
    }
  }

  dir.fileCount = files;
  dir.flagCount = flags;
  dir.hiddenCount = hidden;
  dir.lastRunAt = last;
  dir.flakeRate = flake;
}

// ─── Scope ───────────────────────────────────────────────────────────────────

/**
 * Find the scope root and the trail back out. Resolution runs BEFORE compaction,
 * on the tree where every folder still has its own node, so scoping to the
 * middle of a chain that renders as one row still works.
 */
function findScope(root: PathDir, scope: string): { dir: PathDir | FeatureDir; crumbs: TreeCrumb[] } | null {
  const walk = (dir: PathDir | FeatureDir, trail: TreeCrumb[]): { dir: PathDir | FeatureDir; crumbs: TreeCrumb[] } | null => {
    for (const child of dir.children) {
      if (child.kind !== 'dir') continue;
      const crumbs = [...trail, { name: child.name, id: child.id }];
      if (child.id === scope) return { dir: child, crumbs };
      const found = walk(child, crumbs);
      if (found) return found;
    }
    return null;
  };
  return walk(root, []);
}

// ─── Compaction ──────────────────────────────────────────────────────────────

/**
 * Collapse a folder that holds exactly one folder and no files into its child,
 * repeatedly, so `hand-written/checkout/deep` is one row. The row keeps the
 * whole chain in `segments`: VS Code lets you click any segment of that label,
 * and answering that click means knowing what each piece of it points at.
 *
 * Counts come from the OUTERMOST folder because they already aggregate the whole
 * subtree — and because an intermediate folder can hold hidden files even when
 * it holds only one visible child, and that count has to survive the collapse.
 */
function compactChain(dir: PathDir, stops: ReadonlySet<string>): PathDir {
  let deepest = dir;
  const segments = [...dir.segments];

  for (;;) {
    if (deepest.children.length !== 1) break;
    const only = deepest.children[0];
    if (!only || only.kind !== 'dir' || only.source !== 'path') break;
    if (stops.has(only.path)) break;
    segments.push(...only.segments);
    deepest = only;
  }

  return {
    ...dir,
    name: segments.map((s) => s.name).join('/'),
    path: deepest.path,
    segments,
    children: compactAll(deepest.children, stops),
  };
}

function compactAll(nodes: TreeNode[], stops: ReadonlySet<string>): TreeNode[] {
  return nodes.map((node) => {
    if (node.kind !== 'dir') return node;
    if (node.source === 'feature') return { ...node, children: compactAll(node.children, stops) };
    return compactChain(node, stops);
  });
}

// ─── The build ───────────────────────────────────────────────────────────────

/**
 * Turn the flat test list into the tree the panel renders.
 *
 * The order of the passes is load-bearing:
 *   build → hide → tally → scope → sort → compact
 * Hiding before the tally so the counts describe what is shown; scope before
 * compaction so any real folder path still resolves; sorting before compaction
 * so rows are ordered by their own folder names rather than by a joined label
 * where a '/' would decide the order.
 */
export function buildTree(tests: readonly TreeTest[], options: BuildTreeOptions = {}): TreeModel {
  const grouping: Grouping = options.grouping ?? 'path';
  const sort: SortMode = options.sort ?? 'name';

  const root = grouping === 'feature' ? buildFeatureTree(tests) : buildPathTree(tests);

  pruneHidden(root, parseHidePatterns(options.hide));
  tally(root);

  let view: PathDir | FeatureDir = root;
  let crumbs: TreeCrumb[] = [];
  let scopeMissing = false;
  if (options.scope) {
    const found = findScope(root, options.scope);
    if (found) {
      view = found.dir;
      crumbs = found.crumbs;
    } else {
      // Degrade to the whole tree. A folder that was renamed or deleted under a
      // saved scope must not present as a project with no tests in it.
      scopeMissing = true;
    }
  }

  sortTree(view.children, sort);

  const roots =
    options.compactFolders === true
      ? compactAll(view.children, new Set(options.uncompacted ?? []))
      : view.children;

  return {
    roots,
    fileCount: view.fileCount,
    flagCount: view.flagCount,
    hiddenCount: view.hiddenCount,
    scope: crumbs,
    scopeMissing,
    grouping,
    sort,
  };
}

// ─── Reading a built tree ────────────────────────────────────────────────────

/** Every folder id in a tree — the expand-all set. Ids, not paths: feature groups have no path. */
export function allDirIds(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      if (node.kind === 'dir') {
        out.push(node.id);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** The node with this id, anywhere in the tree, or null. */
export function findNode(nodes: readonly TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === 'dir') {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

export interface TreeRow {
  node: TreeNode;
  /** 0 for a root row. Multiply by the indent step; a compacted chain is still one level. */
  depth: number;
  /** Folders only; always false for a file. */
  expanded: boolean;
}

/**
 * The visible rows, in order — what a virtualised list renders.
 *
 * `forced` is unioned with `expanded` rather than replacing it, because that is
 * what the search filter needs: it can open folders to reveal matches without
 * touching, and later having to restore, what the person had actually opened.
 */
export function flattenTree(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  forced?: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: readonly TreeNode[], depth: number): void => {
    for (const node of list) {
      if (node.kind === 'file') {
        rows.push({ node, depth, expanded: false });
        continue;
      }
      const open = expanded.has(node.id) || forced?.has(node.id) === true;
      rows.push({ node, depth, expanded: open });
      if (open) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

/** True when a path is test DATA rather than a test — fixtures are tinted to say so. */
export function isFixturePath(path: string): boolean {
  return path.startsWith(FIXTURE_PREFIX);
}
