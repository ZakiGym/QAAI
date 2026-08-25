/**
 * Cut, copy and paste over the file tree — and the planner that decides what a
 * paste (or a drop; see `dnd.ts`) actually MEANS.
 *
 * The output is data, never an effect: a paste produces a list of
 * `{ kind, from, to }` operations for the caller to execute against the API, and
 * a list of refusals with reasons the UI can show. Nothing here fetches, and
 * nothing here mutates the tree.
 *
 * Three refusals are the reason this file is not four lines long, and each is a
 * bug that has shipped in real explorers:
 *
 *   - A folder pasted into ITSELF or into its own descendant. A naive
 *     implementation walks the folder's children while writing new children into
 *     it and never terminates.
 *   - A name that already exists in the destination. A copy gets " copy"
 *     appended, the way VS Code does; a MOVE is refused outright, because
 *     silently renaming a file the user asked to move is data loss wearing a
 *     rename's clothes — and the API 409s on it anyway.
 *   - A cut whose source vanished between the ⌘X and the ⌘V. The clipboard holds
 *     ids, so the entry is simply gone at paste time, and saying so beats
 *     issuing a move for a path that no longer exists.
 *
 * `clipboard.ts` also owns the tree's path arithmetic. It is the module that has
 * to build destination paths, so the helpers live next to their only real user
 * rather than in a utility file that every module would import for one call.
 *
 * ── WHICH ROW LIST ─────────────────────────────────────────────────────────
 *
 * Every function here takes EVERY row in the tree — collapsed folders and
 * filtered-out rows included — never the visible list `selection.ts` navigates.
 * Two different things go wrong with the short list, and both are silent:
 *
 *   - `cut`/`copy` cannot resolve a selected id that is off screen, so cutting
 *     a collapsed folder's contents captures nothing and the paste reports
 *     "nothing to do" rather than the truth.
 *   - `planOps` decides name collisions from the destination's contents, and a
 *     collapsed folder still holds its files. Planning against what is visible
 *     moves a file on top of one it cannot see.
 *
 * So the shortfall is made loud instead of assumed away: `cut`/`copy` record
 * the ids they could NOT resolve on `ClipboardState.unresolved`, and `paste`
 * turns each of them into a refusal with the real reason. A caller that hands
 * these functions the visible rows gets a list of complaints, not a quiet
 * partial result.
 */

import { isPathless, type TreeRow } from './selection';

// ─── Paths ───────────────────────────────────────────────────────────────────

/** `checkout/order.spec.ts` → `checkout`; a root-level path → `''`. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** `checkout/order.spec.ts` → `order.spec.ts`. */
export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Join a folder path and a name, with `''` meaning the root. */
export function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`;
}

/**
 * Is `path` inside `ancestor`? Strictly inside — a path is not within itself.
 *
 * The trailing slash is the whole point: `checkout-v2` starts with `checkout`
 * but is a sibling, not a child, and a prefix test without the separator would
 * refuse a perfectly legal move into it.
 */
export function isWithin(path: string, ancestor: string): boolean {
  if (ancestor === '') return path !== '';
  return path.startsWith(`${ancestor}/`);
}

/**
 * Split a file name into the part that gets " copy" appended and the extension
 * that stays on the end.
 *
 * The LAST dot only, so `order-total.spec.ts` becomes `order-total.spec` + `.ts`
 * and the copy reads `order-total.spec copy.ts` — the file keeps being a `.ts`
 * file, which is what decides whether the editor can even open it. A leading dot
 * is not an extension: `.gitignore` is all name, and `.gitignore copy` is the
 * right answer.
 */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * A name that is free in the destination.
 *
 * Already-taken names walk " copy", " copy 2", " copy 3". Copying something that
 * is itself a copy re-uses its root rather than stacking suffixes, so pasting
 * `order copy.ts` twice gives `order copy 2.ts` and not `order copy copy.ts`.
 *
 * The counter starts from the SOURCE's own number, which is the half of the VS
 * Code rule that is easy to lose: `a copy 2.ts` duplicated is `a copy 3.ts`.
 * Restarting the walk at " copy" made the number go backwards — `a copy 2.ts`
 * became `a copy.ts` whenever that name happened to be free — so the copy of a
 * copy sorted ABOVE its own source and looked like the original.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const { stem, ext } = splitName(name);
  const already = /^(.*?) copy(?: (\d+))?$/.exec(stem);
  const root = already?.[1] ?? stem;
  // Where to count from: an un-numbered " copy" is number 1, a plain name is
  // number 0 (so the first candidate is the un-numbered " copy"), and a bogus
  // ` copy 0` is floored to 1 rather than counting down into it.
  const start = already ? Math.max(1, Number(already[2] ?? '1')) : 0;
  for (let n = start + 1; ; n += 1) {
    const candidate = n === 1 ? `${root} copy${ext}` : `${root} copy ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ─── Operations ──────────────────────────────────────────────────────────────

/**
 * One unit of work for the caller to execute. Paste and drop both emit these, so
 * there is exactly one execution path to write and one to get right.
 *
 * `from`/`to` are always paths. `id` is the ROW id — and what that is worth
 * depends entirely on `entity`, which is why `entity` is not optional:
 *
 *   - `entity: 'file'` — `id` is `f:<testId>`. Strip the namespace (`testIdOf`
 *     in `rows.ts`) and the op is a `PATCH /projects/:id/tests/:testId/path`,
 *     or one row of `POST /projects/:id/tests/batch/move`.
 *   - `entity: 'dir'` — `id` is `d:<folderPath>`, which addresses NOTHING on
 *     the server; there is no folder row in the database. The op is
 *     `POST /projects/:id/folders/move` with `{ from, to }`, which rewrites the
 *     prefix of every test underneath in one transaction. Passing this `id` to
 *     a test endpoint is a 404, and it is the mistake `entity` exists to stop.
 */
export interface TreeOp {
  kind: 'move' | 'copy';
  /** See above: only meaningful once you know `entity`. */
  id: string;
  /** Which API this op is addressed to. Never guess it from the path. */
  entity: 'file' | 'dir';
  from: string;
  to: string;
}

export type RefusalReason =
  /** The row is no longer in the tree — deleted or renamed since the cut. */
  | 'vanished'
  /** A folder pasted into itself. */
  | 'into-self'
  /** A folder pasted into something it contains. */
  | 'into-descendant'
  /** A move whose source and destination folder are the same — a no-op request. */
  | 'same-folder'
  /** A move blocked by an existing file of that name. */
  | 'duplicate-target'
  /** The destination folder does not exist in the tree we were given. */
  | 'no-target'
  /**
   * The row could not be resolved against the rows this call was given — it is
   * filtered out, or inside a collapsed folder, and the caller passed the
   * VISIBLE rows where every row was required. Never silently dropped: a
   * gesture that cannot see what it was asked to act on has to say so.
   */
  | 'unresolved'
  /**
   * The row, or the destination, has no path at all — a feature group under
   * `grouping: 'feature'`. There is no `filePath` to write, and the root is not
   * a sensible stand-in for "nowhere".
   */
  | 'no-path';

export interface Refusal {
  id: string;
  /** The path as last known — for a vanished row this is the stale one. */
  path: string;
  reason: RefusalReason;
  /** Ready to show. Written for a person looking at a tree, not for a log. */
  message: string;
}

/** What a cut or copy captured, resolved against the tree at paste time by `id`. */
export interface ClipboardEntry {
  id: string;
  path: string;
  name: string;
  kind: 'file' | 'dir';
}

export interface ClipboardState {
  mode: 'cut' | 'copy';
  entries: readonly ClipboardEntry[];
  /**
   * Selected ids `cut`/`copy` could not find in the rows they were handed.
   *
   * Empty in the ordinary case. Required rather than optional on purpose: a
   * field you can forget to set is a field that goes straight back to dropping
   * these ids in silence, which is the bug this exists to end. `paste` turns
   * each one into an `unresolved` refusal, so the shortfall reaches the user as
   * a sentence rather than as a smaller number of files than they selected.
   */
  unresolved: readonly string[];
}

export interface PlanResult {
  ops: TreeOp[];
  refusals: Refusal[];
}

export interface PasteResult extends PlanResult {
  /**
   * The clipboard to keep. A cut is consumed by the paste that lands it — the
   * files are no longer waiting to move — while a copy stays, so one ⌘C can be
   * pasted into several folders.
   *
   * A cut holding UNRESOLVED ids is never consumed, even when the rows it could
   * resolve all moved. Those ids are still waiting to go somewhere, and
   * throwing the clipboard away would leave the user no way to finish the
   * gesture except to find the rows again and cut them a second time.
   */
  clipboard: ClipboardState | null;
}

/**
 * Drop entries contained by another entry in the same set.
 *
 * Selecting a folder AND a file inside it and cutting both is easy to do with
 * Shift-click. Moving the folder already takes the file with it, so emitting
 * both would issue a move for a path that stopped existing one operation ago —
 * a 404, or worse, a second file left at the destination root.
 */
export function pruneContained<T extends { path: string; kind: 'file' | 'dir' }>(
  entries: readonly T[],
): T[] {
  // A pathless folder — a feature group — is excluded from the ancestor list,
  // and the exclusion is load-bearing: its path is `''`, `isWithin(x, '')` is
  // true of every other row, and one such entry in the set would prune the
  // whole gesture down to itself.
  const folders = entries
    .filter((entry) => entry.kind === 'dir' && entry.path !== '')
    .map((entry) => entry.path);
  return entries.filter((entry) => !folders.some((folder) => isWithin(entry.path, folder)));
}

/** What `resolveIds` found, and what it could not find. */
export interface Resolution {
  /** In TREE order, not in the order the ids were given. Contained rows kept. */
  entries: ClipboardEntry[];
  /** Ids with no row in `allRows`. See `ClipboardState.unresolved`. */
  unresolved: string[];
}

/**
 * Turn selected ids into clipboard entries against EVERY row in the tree.
 *
 * The shared front half of cut, copy and drag, so all three agree about what a
 * selection means — and, more to the point, so all three report the same way
 * when it means less than it should. An id with no row is not dropped here; it
 * comes back in `unresolved` for the planner to refuse by name.
 *
 * Entries come out in tree order rather than in the order the ids arrived,
 * because that is the order the user sees and therefore the order a multi-file
 * paste should land in.
 */
export function resolveIds<R extends TreeRow>(
  allRows: readonly R[],
  ids: readonly string[],
): Resolution {
  const wanted = new Set(ids);
  const found = new Set<string>();
  const entries: ClipboardEntry[] = [];
  for (const row of allRows) {
    if (!wanted.has(row.id)) continue;
    found.add(row.id);
    entries.push({ id: row.id, path: row.path, name: row.name, kind: row.kind });
  }
  const unresolved: string[] = [];
  for (const id of ids) if (!found.has(id)) unresolved.push(id);
  return { entries, unresolved };
}

/**
 * Snapshot rows onto the clipboard.
 *
 * `allRows` is every row in the tree — see the note at the top of this file.
 *
 * Returns null only when nothing at all was asked for, which the caller should
 * read as "leave the clipboard alone": ⌘C with an empty selection must not
 * silently throw away what was copied a minute ago. A gesture that asked for
 * rows and resolved NONE of them still produces a clipboard, because that
 * clipboard is how the failure reaches the user at ⌘V.
 */
function capture<R extends TreeRow>(
  allRows: readonly R[],
  ids: readonly string[],
  mode: 'cut' | 'copy',
): ClipboardState | null {
  if (ids.length === 0) return null;
  const { entries, unresolved } = resolveIds(allRows, ids);
  return { mode, entries: pruneContained(entries), unresolved };
}

export function cut<R extends TreeRow>(
  allRows: readonly R[],
  ids: readonly string[],
): ClipboardState | null {
  return capture(allRows, ids, 'cut');
}

export function copy<R extends TreeRow>(
  allRows: readonly R[],
  ids: readonly string[],
): ClipboardState | null {
  return capture(allRows, ids, 'copy');
}

/**
 * Ids to render faded — a cut row is still there, but it is on its way out.
 *
 * The unresolved ids are in here too. They were cut; the row list simply could
 * not show them at the time. If the folder holding one is expanded before the
 * paste, that row must fade like every other row in the same gesture.
 */
export function cutIds(clipboard: ClipboardState | null): ReadonlySet<string> {
  if (!clipboard || clipboard.mode !== 'cut') return new Set<string>();
  return new Set([...clipboard.entries.map((entry) => entry.id), ...clipboard.unresolved]);
}

export function isCut(clipboard: ClipboardState | null, id: string): boolean {
  if (clipboard?.mode !== 'cut') return false;
  // Scanned rather than routed through `cutIds`, which would build a fresh Set
  // per call — and this is called once per row, on every render of the panel.
  return (
    clipboard.entries.some((entry) => entry.id === id) || clipboard.unresolved.includes(id)
  );
}

/**
 * The folder a gesture aimed at a row means, or `null` when the row is not a
 * place files can go.
 *
 * Pasting or dropping onto a FILE targets the folder that file lives in — the
 * user is pointing at a place in the list, and a file is not a container. A null
 * id, or one that is not in the tree, is the root (`''`).
 *
 * `null` is reserved for the one row that looks like a folder and is not: a
 * FEATURE GROUP, which has no path. Returning `''` for it — as this did — reads
 * as "the project root", so dropping a file onto the "Checkout" heading while
 * grouped by feature moved that file to the root of the project and the tree
 * re-rendered as if the drop had worked. The two answers have to be
 * distinguishable at the type level or that bug comes straight back.
 */
export function folderTargetOf(rows: readonly TreeRow[], id: string | null): string | null {
  if (id === null) return '';
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) return '';
  if (isPathless(row)) return null;
  return row.kind === 'dir' ? row.path : row.parentPath;
}

/** The refusal a row that has no path earns, for whichever gesture asked. */
export function pathlessRefusal(id: string, path: string, name: string): Refusal {
  return {
    id,
    path,
    reason: 'no-path',
    message: `${name} is a feature group, not a folder — switch to path grouping to move files`,
  };
}

/**
 * The refusal an id with no row earns.
 *
 * The message names the two things that actually cause it, because "nothing
 * happened" is what this used to say and it sent people looking for a server
 * error that was never there.
 */
export function unresolvedRefusal(id: string): Refusal {
  return {
    id,
    // Unknown, and honestly so: the row was never found, so there is no path to
    // report. A stale path invented here would be worse than none.
    path: '',
    reason: 'unresolved',
    message:
      'A selected row was not in the row list this gesture was planned against — ' +
      'it is filtered out, or inside a collapsed folder. Nothing was done with it.',
  };
}

/**
 * Turn entries + a destination into operations. The shared core of paste and
 * drop, so the two can never disagree about what is legal.
 *
 * `allRows` must be EVERY row in the tree, not just the visible ones: a
 * collapsed folder still occupies its path, and planning against the visible
 * list alone would happily move a file on top of one it cannot see.
 *
 * `targetFolder` is a real folder path or `''` for the root — never the `null`
 * `folderTargetOf` returns for a feature group. Resolve that first; a gesture
 * aimed at a heading has to be refused, not aimed at the root instead.
 */
export function planOps<R extends TreeRow>(
  allRows: readonly R[],
  entries: readonly ClipboardEntry[],
  mode: 'cut' | 'copy',
  targetFolder: string,
): PlanResult {
  const ops: TreeOp[] = [];
  const refusals: Refusal[] = [];
  if (entries.length === 0) return { ops, refusals };

  const byId = new Map(allRows.map((row) => [row.id, row]));

  /*
   * Prune BEFORE anything is refused, not just before ops are built. A gesture
   * holding a folder and a file inside it is one gesture: the file is going
   * along with the folder either way, and a refusal naming a row that was about
   * to be pruned anyway is a complaint about something the user never asked
   * for. It also keeps the counts honest — refusals + ops now add up to the
   * number of things that were actually planned.
   */
  const planned = pruneContained(entries);

  // The root always exists; any other destination has to be a folder we can see,
  // or the paths we build point into nothing.
  if (
    targetFolder !== '' &&
    !allRows.some((row) => row.kind === 'dir' && row.path === targetFolder)
  ) {
    for (const entry of planned) {
      refusals.push({
        id: entry.id,
        path: entry.path,
        reason: 'no-target',
        message: `${targetFolder}/ is not a folder in this project`,
      });
    }
    return { ops, refusals };
  }

  // Names already spoken for at the destination — including the ones earlier ops
  // in THIS paste are about to claim, so pasting two `order.spec.ts` gives
  // `order copy.spec.ts` and `order copy 2.spec.ts` rather than two collisions.
  const taken = new Set(
    allRows.filter((row) => row.parentPath === targetFolder).map((row) => row.name),
  );

  for (const entry of planned) {
    const row = byId.get(entry.id);
    if (!row) {
      refusals.push({
        id: entry.id,
        path: entry.path,
        reason: 'vanished',
        message: `${entry.path} is no longer in this project`,
      });
      continue;
    }

    /*
     * A feature group has no path, so there is no `from` to move and no name to
     * write. Refuse it by name rather than computing `joinPath(target, name)`
     * and inventing a folder at the destination that never existed.
     */
    if (isPathless(row)) {
      refusals.push(pathlessRefusal(row.id, row.path, row.name));
      continue;
    }

    // The LIVE path, not the one captured at ⌘X — the file may have been moved
    // by a rename, or by another tab, since the clipboard was filled.
    const from = row.path;

    if (row.kind === 'dir' && targetFolder === from) {
      refusals.push({
        id: row.id,
        path: from,
        reason: 'into-self',
        message: `${row.name}/ cannot go inside itself`,
      });
      continue;
    }
    if (row.kind === 'dir' && isWithin(targetFolder, from)) {
      refusals.push({
        id: row.id,
        path: from,
        reason: 'into-descendant',
        message: `${row.name}/ cannot go inside a folder it contains`,
      });
      continue;
    }
    if (mode === 'cut' && row.parentPath === targetFolder) {
      refusals.push({
        id: row.id,
        path: from,
        reason: 'same-folder',
        message: `${row.name} is already there`,
      });
      continue;
    }

    let name: string;
    if (mode === 'cut') {
      if (taken.has(row.name)) {
        refusals.push({
          id: row.id,
          path: from,
          reason: 'duplicate-target',
          message: `${joinPath(targetFolder, row.name)} already exists`,
        });
        continue;
      }
      name = row.name;
    } else {
      name = uniqueName(row.name, taken);
    }

    taken.add(name);
    ops.push({
      kind: mode === 'cut' ? 'move' : 'copy',
      id: row.id,
      entity: row.kind === 'dir' ? 'dir' : 'file',
      from,
      to: joinPath(targetFolder, name),
    });
  }

  return { ops, refusals };
}

/**
 * Paste the clipboard into `targetFolder` (`''` is the root).
 *
 * The returned `clipboard` is what the caller should store next — see the field
 * comment on `PasteResult`. A paste that produced nothing leaves a cut clipboard
 * intact, so a refusal is recoverable by clicking a different folder rather than
 * by cutting again.
 */
export function paste<R extends TreeRow>(
  allRows: readonly R[],
  clipboard: ClipboardState | null,
  targetFolder: string,
): PasteResult {
  if (!clipboard) return { ops: [], refusals: [], clipboard: null };
  const plan = planOps(allRows, clipboard.entries, clipboard.mode, targetFolder);
  // First, because they are the loudest thing that can be wrong: the gesture
  // was planned against a list that did not contain everything it was given.
  const refusals = [...clipboard.unresolved.map(unresolvedRefusal), ...plan.refusals];
  const consumed =
    clipboard.mode === 'cut' && plan.ops.length > 0 && clipboard.unresolved.length === 0;
  return { ops: plan.ops, refusals, clipboard: consumed ? null : clipboard };
}
