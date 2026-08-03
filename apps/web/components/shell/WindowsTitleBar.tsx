'use client';

import { useEffect, useState } from 'react';
import { useProject } from './ProjectContext';

/**
 * The Windows title bar.
 *
 * macOS draws its traffic lights over the page, so there the app only has to
 * inset around them. Windows draws nothing at all on a frameless window — so
 * without this a Windows user gets a window with no title bar, nowhere to grab
 * it, and no way to close it short of Alt+F4.
 *
 * 32px, above everything, and the strip itself is the drag region. The three
 * caption buttons are 46×32 because that is the Windows hit area; making them
 * visually smaller would be a mis-fitting copy of a control people have decades
 * of muscle memory for.
 */

/**
 * The bridge Electron's preload would expose. It does not exist yet — the
 * renderer runs with contextIsolation and no node integration, and adding an
 * IPC channel is the desktop app's change to make, not the web app's.
 *
 * So the buttons degrade honestly: if the bridge is absent they are DISABLED
 * with a title saying so, rather than rendered as live controls that silently
 * do nothing. A dead close button is worse than no close button.
 */
interface WindowControls {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

declare global {
  interface Window {
    qaaiWindow?: WindowControls;
  }
}

export function WindowsTitleBar() {
  const { project } = useProject();
  const [controls, setControls] = useState<WindowControls | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    // Read after mount: the attribute is set by DesktopChrome's own effect, and
    // reading it during render would disagree with the server's HTML.
    setEnabled(document.documentElement.dataset.desktopPlatform === 'win');
    setControls(window.qaaiWindow ?? null);
  }, []);

  if (!enabled) return null;

  const title = project ? `QAAI — ${project.name}` : 'QAAI';
  const unavailable = controls
    ? undefined
    : 'Window controls need the desktop shell’s preload bridge, which this build does not provide.';

  return (
    <div
      // The strip is the drag handle; the buttons opt out via .no-drag below.
      className="app-titlebar border-line bg-surface-1 flex h-8 shrink-0 items-center border-b"
    >
      <span className="text-ink-faint text-meta truncate px-3 font-mono">{title}</span>

      <div className="ml-auto flex">
        {(
          [
            ['Minimize', '–', () => controls?.minimize()],
            ['Maximize', '▢', () => controls?.maximize()],
            ['Close', '✕', () => controls?.close()],
          ] as const
        ).map(([label, glyph, onClick]) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            title={unavailable ?? label}
            disabled={!controls}
            onClick={onClick}
            className={
              // 46×32 is the Windows caption hit area. Close gets the system red
              // on hover; the other two get the ordinary raised surface.
              'no-drag text-ink-dim hover:text-ink hover:bg-surface-2 flex h-8 w-[46px] items-center ' +
              'justify-center text-[13px] transition-colors disabled:opacity-40 ' +
              'disabled:hover:bg-transparent ' +
              (label === 'Close'
                ? 'hover:!bg-[#e81123] hover:!text-white disabled:hover:!bg-transparent'
                : '')
            }
          >
            {glyph}
          </button>
        ))}
      </div>
    </div>
  );
}
