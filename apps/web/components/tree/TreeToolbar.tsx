'use client';

/**
 * The strip above the tree: what is shown, how it is ordered, and how to get
 * back out of a folder you scoped into.
 *
 * Everything here writes a PREFERENCE and nothing here performs work. That is
 * the whole reason the toolbar is a separate file — sort order, grouping, hide
 * patterns and the scope are answers about a codebase that `prefs.ts` persists
 * per project, and mixing them into the panel that also moves files makes both
 * harder to read.
 *
 * The menus are real menus: `menuitemradio` and `menuitemcheckbox` with
 * `aria-checked`, arrow keys between items, Escape to close. A checkmark drawn
 * with a glyph and no role is a picture of a menu, and the one thing a settings
 * menu must never be is unreadable to the person who cannot see it.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { SortMode, TreeCrumb } from '../../lib/tree/model';
import type { TreePrefs } from '../../lib/tree/prefs';
import type { SuiteGrouping } from '../../lib/tree/suites';

export interface TreeToolbarProps {
  prefs: TreePrefs;
  onPrefs: (patch: Partial<TreePrefs>) => void;
  onToggle: (key: 'compactFolders' | 'tintByResult') => void;

  /**
   * The grouping in force, which is NOT `prefs.grouping`.
   *
   * `prefs.ts` persists two groupings and the panel offers three — suite
   * grouping is remembered by the controller instead, because a value the prefs
   * sanitiser does not know is a value it silently discards. So the radio group
   * below is driven by this pair and never by the prefs it sits beside.
   */
  grouping: SuiteGrouping;
  onGrouping: (value: SuiteGrouping) => void;

  query: string;
  onQuery: (value: string) => void;
  filterActive: boolean;
  matchCount: number;
  /** Files in the current view, after hiding and scoping. */
  fileCount: number;
  /** Files the hide patterns removed. Surfaced so a hidden file never reads as a missing one. */
  hiddenCount: number;
  /** Selected rows that are not on screen right now. */
  hiddenSelected: number;

  scope: TreeCrumb[];
  scopeMissing: boolean;
  onScope: (id: string | null) => void;

  onExpandAll: () => void;
  onCollapseAll: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  /** Suite grouping only: make an empty suite to drag files onto. */
  onNewSuite: () => void;

  autoReveal: boolean;
  onAutoReveal: (value: boolean) => void;

  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;

  /** False in feature grouping, where there are no folders to create or move into. */
  structural: boolean;
  busy: boolean;
}

const SORTS: ReadonlyArray<{ value: SortMode; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'type', label: 'Type' },
  { value: 'lastRun', label: 'Last run' },
  { value: 'flakiness', label: 'Flakiness' },
];

const GROUPINGS: ReadonlyArray<{ value: SuiteGrouping; label: string }> = [
  { value: 'path', label: 'Folders' },
  { value: 'feature', label: 'Feature' },
  { value: 'suite', label: 'Suite' },
];

// ─── A small, real menu ──────────────────────────────────────────────────────

function Menu({
  label,
  glyph,
  children,
}: {
  label: string;
  glyph: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** Arrow keys walk the items; the menu is a list, not a form. */
  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = items[(((at === -1 ? 0 : at + step) % items.length) + items.length) % items.length];
    next?.focus();
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((was) => !was)}
        className="text-ink-faint hover:text-ink px-1 leading-none"
      >
        {glyph}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          id={id}
          onKeyDown={onMenuKey}
          onClick={() => setOpen(false)}
          className="border-line bg-surface-1 absolute right-0 z-50 mt-1 w-48 rounded-md border py-1 shadow-2xl"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div className="text-ink-faint text-micro px-3 pt-1.5 pb-0.5 tracking-wide uppercase">
      {children}
    </div>
  );
}

function MenuOption({
  role,
  checked,
  label,
  onSelect,
  disabled,
}: {
  role: 'menuitemradio' | 'menuitemcheckbox';
  checked: boolean;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className="text-ink-dim hover:bg-surface-2 hover:text-ink text-body-sm flex w-full items-center gap-2 px-3 py-1 text-left disabled:opacity-40"
    >
      {/* The tick is a glyph, but `aria-checked` above is what actually carries
          the state — the shape is for the eye, the role for everything else. */}
      <span aria-hidden className={cn('w-3 shrink-0', checked ? 'text-accent' : 'opacity-0')}>
        ✓
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function MenuAction({
  label,
  onSelect,
  disabled,
}: {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="text-ink-dim hover:bg-surface-2 hover:text-ink text-body-sm flex w-full items-center gap-2 px-3 py-1 text-left disabled:opacity-40"
    >
      <span aria-hidden className="w-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="text-ink-faint hover:text-ink px-1 leading-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

// ─── The strip ───────────────────────────────────────────────────────────────

export function TreeToolbar(props: TreeToolbarProps) {
  const {
    prefs,
    onPrefs,
    onToggle,
    query,
    onQuery,
    filterActive,
    matchCount,
    fileCount,
    hiddenCount,
    hiddenSelected,
    scope,
    scopeMissing,
    onScope,
    onExpandAll,
    onCollapseAll,
    onNewFile,
    onNewFolder,
    onNewSuite,
    grouping,
    onGrouping,
    autoReveal,
    onAutoReveal,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    onUndo,
    onRedo,
    structural,
    busy,
  } = props;

  const [hideOpen, setHideOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const addPattern = () => {
    const pattern = draft.trim();
    if (pattern.length === 0) return;
    if (prefs.hide.includes(pattern)) {
      setDraft('');
      return;
    }
    onPrefs({ hide: [...prefs.hide, pattern] });
    setDraft('');
  };

  return (
    <div className="mb-1.5 flex flex-col gap-1">
      <div className="flex items-center gap-0.5">
        <span className="text-ink-faint min-w-0 flex-1 truncate">
          {filterActive
            ? `${matchCount} of ${fileCount}`
            : `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`}
          {hiddenCount > 0 && (
            <span title={`${hiddenCount} hidden by a hide pattern`}>{` · ${hiddenCount} hidden`}</span>
          )}
        </span>

        <ToolButton
          label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}
          onClick={onUndo}
          disabled={!canUndo || busy}
        >
          ↶
        </ToolButton>
        <ToolButton
          label={redoLabel ? `Redo ${redoLabel}` : 'Redo'}
          onClick={onRedo}
          disabled={!canRedo || busy}
        >
          ↷
        </ToolButton>
        <ToolButton label="New file" onClick={onNewFile}>
          +
        </ToolButton>
        {/*
          One button, two meanings, because they are the same intent in the two
          views: make the container this grouping is made of. A suite is a real
          row and can be created empty; a folder cannot, which is why the folder
          half is disabled outside path grouping rather than doing something else.
        */}
        {grouping === 'suite' ? (
          <ToolButton label="New suite" onClick={onNewSuite}>
            ⊞
          </ToolButton>
        ) : (
          <ToolButton
            label={structural ? 'New folder' : 'New folder — group by folder first'}
            onClick={onNewFolder}
            disabled={!structural}
          >
            ⊞
          </ToolButton>
        )}
        <ToolButton label="Collapse all folders" onClick={onCollapseAll}>
          ⊟
        </ToolButton>
        <ToolButton label="Expand all folders" onClick={onExpandAll}>
          ⊡
        </ToolButton>

        <Menu label="View options" glyph={<span aria-hidden>⋯</span>}>
          <MenuHeading>Sort by</MenuHeading>
          {SORTS.map((sort) => (
            <MenuOption
              key={sort.value}
              role="menuitemradio"
              checked={prefs.sort === sort.value}
              label={sort.label}
              onSelect={() => onPrefs({ sort: sort.value })}
            />
          ))}

          <MenuHeading>Group by</MenuHeading>
          {GROUPINGS.map((option) => (
            <MenuOption
              key={option.value}
              role="menuitemradio"
              checked={grouping === option.value}
              label={option.label}
              onSelect={() => onGrouping(option.value)}
            />
          ))}

          <MenuHeading>Show</MenuHeading>
          <MenuOption
            role="menuitemcheckbox"
            checked={prefs.compactFolders}
            label="Compact folders"
            onSelect={() => onToggle('compactFolders')}
            disabled={grouping !== 'path'}
          />
          <MenuOption
            role="menuitemcheckbox"
            checked={prefs.tintByResult}
            label="Tint by last result"
            onSelect={() => onToggle('tintByResult')}
          />
          <MenuOption
            role="menuitemcheckbox"
            checked={autoReveal}
            label="Reveal the open file"
            onSelect={() => onAutoReveal(!autoReveal)}
          />
          <MenuAction
            label={`Hide patterns… (${prefs.hide.length})`}
            onSelect={() => setHideOpen((was) => !was)}
          />
        </Menu>
      </div>

      {/* Filter. Outside the tree on purpose: type-to-select inside the tree must
          never be able to eat what someone is typing in here. */}
      <div className="flex items-center gap-1">
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query.length > 0) {
              event.preventDefault();
              onQuery('');
            }
          }}
          placeholder="Filter files"
          aria-label="Filter files"
          spellCheck={false}
          className="border-line bg-surface-1 text-ink placeholder:text-ink-faint min-w-0 flex-1 rounded-[3px] border px-1.5 py-0.5 outline-none focus:border-accent"
        />
        {query.length > 0 && (
          <ToolButton label="Clear the filter" onClick={() => onQuery('')}>
            ×
          </ToolButton>
        )}
      </div>

      {hiddenSelected > 0 && (
        <p className="text-ink-faint whitespace-normal">
          {`${hiddenSelected} selected ${hiddenSelected === 1 ? 'row is' : 'rows are'} not on screen — they still count.`}
        </p>
      )}

      {/* Scope: the way back out of "Set as root". */}
      {scope.length > 0 && (
        <nav
          aria-label={grouping === 'suite' ? 'Suite scope' : 'Folder scope'}
          className="flex flex-wrap items-center gap-x-1"
        >
          <button
            type="button"
            onClick={() => onScope(null)}
            className="text-accent hover:underline"
          >
            All files
          </button>
          {scope.map((crumb, index) => (
            <span key={crumb.id} className="flex items-center gap-x-1">
              <span aria-hidden className="text-ink-faint">
                /
              </span>
              {index === scope.length - 1 ? (
                <span className="text-ink-dim" aria-current="location">
                  {crumb.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onScope(crumb.id)}
                  className="text-accent hover:underline"
                >
                  {crumb.name}
                </button>
              )}
            </span>
          ))}
        </nav>
      )}

      {scopeMissing && (
        <p role="status" className="text-flake whitespace-normal">
          {grouping === 'suite'
            ? 'The suite you had set as the root is gone — showing everything. '
            : 'The folder you had set as the root is gone — showing everything. '}
          <button type="button" onClick={() => onScope(null)} className="text-accent underline">
            Clear it
          </button>
        </p>
      )}

      {hideOpen && (
        <div className="border-line rounded-md border border-dashed p-1.5">
          <div className="flex items-center gap-1">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addPattern();
                }
              }}
              placeholder="e.g. *.snap or fixtures/"
              aria-label="Pattern to hide"
              spellCheck={false}
              className="border-line bg-surface-1 text-ink placeholder:text-ink-faint min-w-0 flex-1 rounded-[3px] border px-1.5 py-0.5 outline-none focus:border-accent"
            />
            <ToolButton label="Add this hide pattern" onClick={addPattern}>
              +
            </ToolButton>
            <ToolButton label="Close hide patterns" onClick={() => setHideOpen(false)}>
              ×
            </ToolButton>
          </div>
          {prefs.hide.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1">
              {prefs.hide.map((pattern) => (
                <li key={pattern}>
                  <button
                    type="button"
                    onClick={() => onPrefs({ hide: prefs.hide.filter((one) => one !== pattern) })}
                    aria-label={`Stop hiding ${pattern}`}
                    title={`Stop hiding ${pattern}`}
                    className="border-line text-ink-dim hover:text-ink hover:border-line-strong rounded-full border px-1.5"
                  >
                    {pattern} <span aria-hidden>×</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-faint mt-1 whitespace-normal">
              {'Nothing hidden. `*` and `**` are the only wildcards, and a trailing / means folders only.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
