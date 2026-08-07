'use client';

import type { OutlineSymbol } from './outline';
import { cn } from '../../lib/cn';

/**
 * Where you are in the file, above the file.
 *
 * The tabs say which file is open and the tree says where it lives, but neither
 * survives scrolling: two hundred lines into a spec the only thing on screen is
 * code, and "which test is this `await` inside" is the question you are actually
 * holding. Sticky scroll answers it for the lines that fit; this answers it in
 * one row, always.
 *
 * The folder segments are inert — the tree is eighteen inches to the left and
 * already selects the open file. The SYMBOL segments are buttons, because those
 * are the ones with somewhere to go: clicking `Checkout` puts the cursor on the
 * line that opens it, which is what the same click does in VS Code.
 */

export interface BreadcrumbsProps {
  filePath: string;
  /** Outermost first — `symbolTrailAt` already orders them. */
  trail: OutlineSymbol[];
  onReveal: (line: number) => void;
}

function Chevron() {
  return (
    <span aria-hidden className="text-ink-faint/60 px-[5px] select-none">
      ›
    </span>
  );
}

export function Breadcrumbs({ filePath, trail, onReveal }: BreadcrumbsProps) {
  const segments = filePath.split('/').filter(Boolean);
  const fileName = segments.pop() ?? filePath;

  return (
    <nav
      aria-label="File location"
      className="border-line text-ink-faint flex shrink-0 items-center overflow-x-auto border-b px-4 py-[5px] text-[11px] whitespace-nowrap"
    >
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex items-center">
          <span className="font-mono">{segment}</span>
          <Chevron />
        </span>
      ))}

      <span className="text-ink-dim font-mono">{fileName}</span>

      {trail.map((symbol) => (
        <span key={`${symbol.startLine}-${symbol.name}`} className="flex items-center">
          <Chevron />
          <button
            type="button"
            onClick={() => onReveal(symbol.startLine)}
            title={`Go to line ${symbol.startLine}`}
            className={cn(
              'hover:text-ink max-w-[26ch] truncate transition-colors',
              // The last crumb is where the cursor is, so it is the one that
              // gets the ink. The rest are context.
              symbol === trail[trail.length - 1] ? 'text-ink-dim' : 'text-ink-faint',
            )}
          >
            {symbol.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
