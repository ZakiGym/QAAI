'use client';

import { useCallback, useEffect, useState } from 'react';
import { ACCENT_KEY, THEME_KEY } from './ThemeScript';

/**
 * The theme and accent, read from and written to the same place ThemeScript
 * bootstrapped them.
 *
 * State is initialised from the DOM rather than from localStorage, because by
 * the time this runs the inline script has already resolved "no stored choice"
 * into an actual theme by asking the OS. Reading storage again here would give
 * `null` for that user and flip them to the wrong palette on hydration — the
 * exact flash the bootstrap exists to prevent, reintroduced one layer down.
 */

export type Theme = 'dark' | 'light';
export type Accent = 'mist' | 'sage' | 'iris';

export const ACCENTS: readonly Accent[] = ['mist', 'sage', 'iris'];

function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function currentAccent(): Accent {
  if (typeof document === 'undefined') return 'mist';
  const value = document.documentElement.getAttribute('data-accent');
  return value === 'sage' || value === 'iris' ? value : 'mist';
}

export function useTheme() {
  /*
   * Both start at the server-rendered default and are corrected in an effect on
   * mount. Reading the DOM during the initial render would make the client's
   * first render disagree with the server's HTML, which is a hydration error —
   * the attribute is right on the element either way, so only this hook's own
   * state needs catching up.
   */
  const [theme, setThemeState] = useState<Theme>('dark');
  const [accent, setAccentState] = useState<Accent>('mist');

  useEffect(() => {
    setThemeState(currentTheme());
    setAccentState(currentAccent());
  }, []);

  const setTheme = useCallback((next: Theme) => {
    const root = document.documentElement;

    /*
     * Suppress transitions for one frame. Without this, every surface, border
     * and text colour in the app animates at once and the switch reads as the
     * page breaking rather than as a preference being applied.
     *
     * Two rAFs, not one: the first lands before the browser has painted with
     * the new attribute, so removing the guard there would let the transition
     * run anyway.
     */
    root.setAttribute('data-theme-switching', '');
    root.setAttribute('data-theme', next);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => root.removeAttribute('data-theme-switching')),
    );

    setThemeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode. The choice holds for this session and is simply not kept.
    }
  }, []);

  const setAccent = useCallback((next: Accent) => {
    document.documentElement.setAttribute('data-accent', next);
    setAccentState(next);
    try {
      localStorage.setItem(ACCENT_KEY, next);
    } catch {
      /* as above */
    }
  }, []);

  const toggleTheme = useCallback(
    () => setTheme(currentTheme() === 'light' ? 'dark' : 'light'),
    [setTheme],
  );

  return { theme, accent, setTheme, setAccent, toggleTheme };
}
