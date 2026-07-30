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
    // Only macOS draws its window buttons over the page, so the header inset is
    // platform-specific. `Mac` in the UA is reliable enough for a CSS hook.
    document.documentElement.dataset.desktopPlatform = /mac/i.test(navigator.userAgent)
      ? 'mac'
      : 'other';
  }, []);

  return null;
}
