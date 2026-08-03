'use client';

import { useEffect } from 'react';

/**
 * Marks the document when running inside the desktop shell.
 *
 * The cockpit is the same code in a browser tab and in Electron, but the
 * chrome differs: with a hidden title bar the window has no draggable area
 * unless the page provides one, and macOS draws its traffic lights over the
 * top-left of the content. Both are styled off `[data-desktop]` in globals.css,
 * so the browser build is completely unaffected.
 *
 * Detection is on the user agent because it needs no preload bridge — the
 * renderer runs with `contextIsolation` and no node integration by design, and
 * adding an IPC channel just to answer "am I in Electron" is not worth the
 * surface area.
 */
export function DesktopChrome() {
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!/electron/i.test(navigator.userAgent)) return;

    document.documentElement.dataset.desktop = 'true';

    /*
     * Three platforms, because they need three different things:
     *
     *   mac   — the OS draws its traffic lights OVER the page, so the sidebar
     *           insets to clear them and is itself the drag region.
     *   win   — the OS draws nothing, so the app supplies a title bar with its
     *           own caption buttons (see WindowsTitleBar).
     *   other — Linux, where the WM usually keeps a real frame. Left alone.
     *
     * `other` was previously everything-but-mac, which meant Windows users got a
     * frameless window with no title bar and no caption buttons at all: nowhere
     * to grab it, and no way to close it except a keyboard shortcut.
     */
    const ua = navigator.userAgent;
    document.documentElement.dataset.desktopPlatform = /mac/i.test(ua)
      ? 'mac'
      : /windows|win32|win64/i.test(ua)
        ? 'win'
        : 'other';
  }, []);

  return null;
}
