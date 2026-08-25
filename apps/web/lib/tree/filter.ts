/**
 * The explorer's filter box: which rows survive a query, and where to underline.
 *
 * VS Code's rule, because it is the one people already have in their fingers —
 * type a few letters of a name, in order, and the tree narrows to what could be
 * meant. The letters need not be adjacent, but when they CAN be adjacent that is
 * the match we show: searching `abc` in `a-b-c-abc` has two subsequences and
 * only one of them is what the person meant.
 *
 * Matching that properly is not greedy. A left-to-right scan takes `a` at index
 * 0 and is then stuck spelling the query out of the hyphenated half. So this is
 * a small dynamic program over (query index × name index), which is affordable
 * because names are short and the alternative is a highlight that lands on the
 * wrong letters — the one part of a filter people notice immediately.
 *
 * Pure, and independent of how the tree was built: it takes the nodes model.ts
 * produced and returns new ones, so filtering never invalidates the model.
 */

import type { TreeDir, TreeNode } from './model';

/** Half-open `[start, end)` into the node's `name`. */
export interface MatchRange {
  start: number;
  end: number;
}

export interface FuzzyMatch {
  /** Higher is a better match. Comparable only between matches of the SAME query. */
  score: number;
  /** Contiguous runs, left to right, non-overlapping. */
  ranges: MatchRange[];
}

/*
 * The weights. A matched character is worth little on its own; what a reader
 * recognises is a run of them, and after that a letter that starts a word. So
 * contiguity outscores a word boundary — otherwise `abc` in `a-b-c-abc` ties,
 * three boundary hits against a run of three, and the highlight lands on the
 * hyphenated half by accident of tie-breaking.
 */
const SCORE_CHAR = 1;
const SCORE_CONTIGUOUS = 10;
const SCORE_BOUNDARY = 6;
const SCORE_FIRST = 4;

/** Past these lengths the table is not worth building; nothing a person types comes close. */
const MAX_FUZZY_TEXT = 512;
const MAX_FUZZY_QUERY = 64;

const CHOICE_STOP = 0;
const CHOICE_TAKE = 1;
const CHOICE_SKIP = 2;

/**
 * Lowercase one UTF-16 unit at a time, keeping any character whose lowercase is
 * a different length (Turkish dotted capital I is the famous one) as it was.
 * The DP indexes the lowercased text and the original interchangeably — for the
 * word-boundary test it needs the original case — so the two must line up
 * exactly, and `String.prototype.toLowerCase` on the whole string does not
 * promise that.
 */
function lowerAligned(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    const low = ch.toLowerCase();
    out += low.length === 1 ? low : ch;
  }
  return out;
}

function isBoundaryChar(ch: string): boolean {
  return ch === '-' || ch === '_' || ch === '.' || ch === '/' || ch === ' ' || ch === '@';
}

/** A word start: after a separator, or the lowercase→uppercase seam in `orderTotal`. */
function startsWord(text: string, at: number): boolean {
  if (at === 0) return true;
  const prev = text[at - 1] as string;
  if (isBoundaryChar(prev)) return true;
  const here = text[at] as string;
  return prev !== prev.toUpperCase() && here === here.toUpperCase() && here !== here.toLowerCase();
}

/** Merge matched indices into runs. Indices arrive ascending. */
function toRanges(indices: number[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === index) last.end = index + 1;
    else ranges.push({ start: index, end: index + 1 });
  }
  return ranges;
}

/**
 * Best subsequence match of `query` in `text`, case-insensitively, or null.
 *
 * Exported on its own because ranking a flat list — quick open, a command
 * palette — wants the score without the tree walk around it.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const needle = lowerAligned(query.trim());
  if (needle.length === 0) return null;
  if (needle.length > text.length) return null;
  if (needle.length > MAX_FUZZY_QUERY || text.length > MAX_FUZZY_TEXT) {
    // Degrade to a plain substring hit rather than refusing to match at all.
    const at = lowerAligned(text).indexOf(needle);
    if (at === -1) return null;
    return { score: needle.length * SCORE_CONTIGUOUS, ranges: [{ start: at, end: at + needle.length }] };
  }

  const hay = lowerAligned(text);
  const n = hay.length;
  const m = needle.length;
  const width = n + 1;
  // Two planes: [i][j][prev], where prev says text[j - 1] was itself matched.
  const size = (m + 1) * width * 2;
  const best = new Float64Array(size);
  const choice = new Int8Array(size);
  const at = (i: number, j: number, prev: 0 | 1): number => (i * width + j) * 2 + prev;

  for (let i = m; i >= 0; i -= 1) {
    for (let j = n; j >= 0; j -= 1) {
      for (const prev of [0, 1] as const) {
        const cell = at(i, j, prev);
        if (i === m) {
          // The query is spent; whatever is left of the name costs nothing.
          best[cell] = 0;
          choice[cell] = CHOICE_STOP;
          continue;
        }
        if (j === n) {
          best[cell] = -Infinity;
          choice[cell] = CHOICE_STOP;
          continue;
        }
        const skip = best[at(i, j + 1, 0)] as number;
        let take = -Infinity;
        if (needle[i] === hay[j]) {
          const bonus =
            SCORE_CHAR +
            (prev === 1 ? SCORE_CONTIGUOUS : 0) +
            (startsWord(text, j) ? SCORE_BOUNDARY : 0) +
            (j === 0 ? SCORE_FIRST : 0);
          take = bonus + (best[at(i + 1, j + 1, 1)] as number);
        }
        // `>=` prefers taking, so equal scores resolve to the leftmost match.
        if (take >= skip) {
          best[cell] = take;
          choice[cell] = CHOICE_TAKE;
        } else {
          best[cell] = skip;
          choice[cell] = CHOICE_SKIP;
        }
      }
    }
  }

  const total = best[at(0, 0, 0)] as number;
  if (!Number.isFinite(total)) return null;

  const indices: number[] = [];
  let i = 0;
  let j = 0;
  let prev: 0 | 1 = 0;
  while (i < m && j < n) {
    if (choice[at(i, j, prev)] === CHOICE_TAKE) {
      indices.push(j);
      i += 1;
      j += 1;
      prev = 1;
    } else {
      j += 1;
      prev = 0;
    }
  }

  return { score: total, ranges: toRanges(indices) };
}

export interface TreeMatches {
  /** The filtered tree. Identical reference to the input when the query is empty. */
  roots: TreeNode[];
  /** False for an empty or whitespace-only query: nothing was filtered. */
  active: boolean;
  /** Node id → ranges into that node's `name`. Only rows that matched appear. */
  ranges: Map<string, MatchRange[]>;
  /** Folder ids to force open so the matches below them are on screen. */
  expand: Set<string>;
  /** Highlighted rows — files and folders alike. `ranges.size`, named for what it means. */
  matchCount: number;
}

/**
 * Filter a built tree to the rows a query could mean.
 *
 * Two rules, and the second is the one worth stating: a folder whose OWN name
 * matches keeps its whole subtree, unfiltered and unexpanded — someone typing
 * `checkout` at a folder called checkout is asking to see the folder, not to
 * have its contents hidden for failing to spell `checkout` themselves. A folder
 * that does not match survives only for its matching descendants, and is forced
 * open, because a hit nobody can see is the same as no hit.
 */
export function matchTree(nodes: TreeNode[], query: string): TreeMatches {
  if (query.trim().length === 0) {
    // Identity, not a rebuild: the caller's memo on `roots` must not be busted
    // by clearing a search box.
    return {
      roots: nodes,
      active: false,
      ranges: new Map(),
      expand: new Set(),
      matchCount: 0,
    };
  }

  const ranges = new Map<string, MatchRange[]>();
  const expand = new Set<string>();

  const keepDir = (dir: TreeDir, children: TreeNode[]): TreeDir => {
    let fileCount = 0;
    let flagCount = 0;
    for (const child of children) {
      if (child.kind === 'file') {
        fileCount += 1;
        if (child.test.reviewFlags.length > 0) flagCount += 1;
      } else {
        fileCount += child.fileCount;
        flagCount += child.flagCount;
      }
    }
    // The other counters describe the folder, not the query, so they ride along
    // unchanged; these two would otherwise claim more rows than are drawn.
    return { ...dir, children, fileCount, flagCount };
  };

  const walk = (node: TreeNode): TreeNode | null => {
    if (node.kind === 'file') {
      const hit = fuzzyMatch(node.name, query);
      if (!hit) return null;
      ranges.set(node.id, hit.ranges);
      return node;
    }

    const self = fuzzyMatch(node.name, query);
    if (self) {
      ranges.set(node.id, self.ranges);
      return node;
    }

    const kids: TreeNode[] = [];
    for (const child of node.children) {
      const kept = walk(child);
      if (kept) kids.push(kept);
    }
    if (kids.length === 0) return null;
    expand.add(node.id);
    return keepDir(node, kids);
  };

  const roots: TreeNode[] = [];
  for (const node of nodes) {
    const kept = walk(node);
    if (kept) roots.push(kept);
  }

  return { roots, active: true, ranges, expand, matchCount: ranges.size };
}
