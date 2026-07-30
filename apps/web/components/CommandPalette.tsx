'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * ⌘K command palette and ⌘P quick-open (§8 "Command palette (⌘K)").
 *
 * One component serves both because they are the same interaction with a
 * different item list — VS Code models them the same way, and having two
 * near-identical overlays diverge in behaviour is a worse outcome than a shared
 * `mode` prop.
 */

export interface PaletteItem {
  id: string;
  label: string;
  /** Right-aligned context: a file path, a test type, a shortcut hint. */
  detail?: string;
  /** Grouping header. Items are rendered in the order given, grouped in place. */
  group?: string;
  run: () => void;
}

export type PaletteMode = 'commands' | 'files';

/**
 * Subsequence match, the way editors do it: "ordtot" finds "order-total".
 * Returns a score (lower is better) or null when there is no match at all.
 *
 * Consecutive hits and matches right after a word boundary score better, so
 * "cart" ranks `cart/single-line.spec.ts` above `checkout/add-to-cart.spec.ts`.
 */
function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;

  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();

  let score = 0;
  let hi = 0;
  let lastHit = -1;

  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;

    if (found === lastHit + 1) score += 0;
    else if (found > 0 && /[\s/\-_.]/.test(h[found - 1] ?? '')) score += 1;
    else score += 3;

    lastHit = found;
    hi = found + 1;
  }

  // Prefer shorter targets when scores tie — a exact-ish short name beats a
  // long path that happens to contain the same letters.
  return score + haystack.length * 0.01;
}

export interface CommandPaletteProps {
  open: boolean;
  mode: PaletteMode;
  items: PaletteItem[];
  onClose: () => void;
}

export function CommandPalette({ open, mode, items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset on every open so the palette never reopens holding a stale query.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after paint; focusing during render is a no-op on a hidden node.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items.slice(0, 60);
    return items
      .map((item) => ({
        item,
        score: fuzzyScore(query.trim(), `${item.label} ${item.detail ?? ''}`),
      }))
      .filter((entry): entry is { item: PaletteItem; score: number } => entry.score !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 60)
      .map((entry) => entry.item);
  }, [items, query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((i) => Math.min(filtered.length - 1, i + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case 'Enter':
        event.preventDefault();
        choose(filtered[active]);
        break;
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
    }
  };

  let lastGroup: string | undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="border-line bg-surface-1 w-[560px] overflow-hidden rounded-lg border shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'files' ? 'Go to file' : 'Run a command'}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={mode === 'files' ? 'Go to file…' : 'Run a command…'}
          className="border-line w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
        />

        <ul ref={listRef} className="max-h-[45vh] overflow-y-auto py-1">
          {filtered.map((item, index) => {
            const header = item.group && item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;

            return (
              <li key={item.id}>
                {header && (
                  <p className="text-ink-faint px-4 pt-2 pb-1 font-mono text-[10px] tracking-wider uppercase">
                    {header}
                  </p>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(item)}
                  className={`flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm ${
                    index === active ? 'bg-surface-2 text-ink' : 'text-ink-dim'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.detail && (
                    <span className="text-ink-faint shrink-0 font-mono text-[11px]">
                      {item.detail}
                    </span>
                  )}
                </button>
              </li>
            );
          })}

          {filtered.length === 0 && (
            <li className="text-ink-faint px-4 py-6 text-center text-sm">No matches</li>
          )}
        </ul>
      </div>
    </div>
  );
}
