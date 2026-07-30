/**
 * Turn the flat test list into a real folder tree.
 *
 * Every test carries a `filePath` like `checkout/order-total.spec.ts` or
 * `fixtures/users.json`; the directory structure lives entirely in those
 * strings. This reshapes them into nested folder/file nodes — dirs before
 * files, alphabetical — so the editor can render an IDE-style explorer instead
 * of a one-level feature list. Pure and side-effect-free, so it is trivial to
 * test and cheap to recompute on every keystroke.
 */

/**
 * Kept in sync with FIXTURE_PREFIX in @qaai/shared. Duplicated as a plain string
 * here rather than imported, because that package ships source TS and the web
 * build has no transpilePackages entry for it.
 */
export const FIXTURE_PREFIX = 'fixtures/';

export interface TreeTest {
  id: string;
  name: string;
  type: string;
  filePath: string;
  reviewFlags: string[];
}

export interface TreeFile {
  kind: 'file';
  /** Last path segment, e.g. `order-total.spec.ts`. */
  name: string;
  /** Full filePath, unique per test. */
  path: string;
  test: TreeTest;
}

export interface TreeDir {
  kind: 'dir';
  name: string;
  /** Folder path with no trailing slash, e.g. `checkout` or `fixtures/api`. */
  path: string;
  children: TreeNode[];
  /** Descendant files, and how many carry generator review flags. */
  fileCount: number;
  flagCount: number;
}

export type TreeNode = TreeFile | TreeDir;

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.kind === 'dir') sortNodes(node.children);
  }
}

function tally(dir: TreeDir): void {
  let files = 0;
  let flags = 0;
  for (const child of dir.children) {
    if (child.kind === 'file') {
      files += 1;
      if (child.test.reviewFlags.length > 0) flags += 1;
    } else {
      tally(child);
      files += child.fileCount;
      flags += child.flagCount;
    }
  }
  dir.fileCount = files;
  dir.flagCount = flags;
}

export function buildTree(tests: TreeTest[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [], fileCount: 0, flagCount: 0 };
  const dirs = new Map<string, TreeDir>([['', root]]);

  const ensureDir = (path: string): TreeDir => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf('/');
    const parentPath = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parent = ensureDir(parentPath);
    const dir: TreeDir = { kind: 'dir', name, path, children: [], fileCount: 0, flagCount: 0 };
    parent.children.push(dir);
    dirs.set(path, dir);
    return dir;
  };

  for (const test of tests) {
    // Normalise: no leading slash, collapse empty segments. filePath is validated
    // relative on the server, but the tree must never crash on odd input.
    const segments = test.filePath.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const fileName = segments[segments.length - 1] as string;
    const dirPath = segments.slice(0, -1).join('/');
    const dir = ensureDir(dirPath);
    dir.children.push({ kind: 'file', name: fileName, path: test.filePath, test });
  }

  sortNodes(root.children);
  for (const child of root.children) {
    if (child.kind === 'dir') tally(child);
  }
  return root.children;
}

/** Every folder path in a tree — used to expand-all by default. */
export function allDirPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'dir') {
        out.push(node.path);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}
