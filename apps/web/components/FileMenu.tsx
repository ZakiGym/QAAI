'use client';

import { useEffect, useRef } from 'react';

/**
 * The right-click menu in the file tree.
 *
 * Positioned at the pointer and clamped to the viewport, so a right-click near
 * the bottom of a long tree does not open a menu you cannot reach. Closes on
 * Escape, on scroll, and on any click elsewhere — a context menu that outlives
 * its context is the most annoying kind of bug in a file tree.
 */

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Rendered in red and separated — deletes only. */
  danger?: boolean;
  disabled?: boolean;
  /** Draws a divider above this item. */
  separated?: boolean;
}

export interface FileMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const WIDTH = 176;
const ROW = 30;

export function FileMenu({ x, y, items, onClose }: FileMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  /**
   * Keep the menu on screen without ever letting it go negative.
   *
   * `||` rather than `??` on the viewport reads: a zero width is exactly the
   * broken case (it happens before layout settles), and `??` treats 0 as a
   * legitimate value — which put the menu at -184,-136, entirely off screen.
   * The final max() is the belt to that braces.
   */
  const height = items.length * ROW + 8;
  const viewportWidth = globalThis.innerWidth || 1280;
  const viewportHeight = globalThis.innerHeight || 800;
  const left = Math.max(8, Math.min(x, viewportWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(y, viewportHeight - height - 8));

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width: WIDTH }}
      className="border-line bg-surface-1 fixed z-50 overflow-hidden rounded-md border py-1 shadow-2xl"
    >
      {items.map((item, index) => (
        <div key={item.label}>
          {item.separated && index > 0 && <div className="border-line my-1 border-t" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`flex w-full items-center px-3 py-1.5 text-left text-[13px] disabled:opacity-40 ${
              item.danger ? 'text-fail hover:bg-fail/10' : 'text-ink-dim hover:bg-surface-2 hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
