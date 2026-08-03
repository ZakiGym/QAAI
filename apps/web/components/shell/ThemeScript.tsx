/**
 * Applies the saved theme and accent before the first paint.
 *
 * This has to be a blocking inline script in <head>, not a useEffect. Anything
 * that runs after hydration means a dark-mode user opening a light-mode default
 * — or the reverse — sees a full-screen flash of the wrong palette on every
 * navigation that touches the document. That flash is the single most visible
 * defect a theme switcher can ship with, and it is invisible in development
 * because the page is already warm.
 *
 * It is deliberately tiny and dependency-free: it runs before React, before the
 * bundle, and before anything that could throw. A try/catch around localStorage
 * because private-mode Safari makes reading it throw, and a broken theme must
 * never be able to stop the app from rendering.
 */

const THEME_KEY = 'qaai.theme';
const ACCENT_KEY = 'qaai.accent';

/*
 * Stringified rather than written as a real function so it can be inlined
 * verbatim. The keys are interpolated so this file stays the one place they are
 * named — useTheme reads the same two constants.
 */
const BOOTSTRAP = `
(function () {
  try {
    var d = document.documentElement;
    var t = localStorage.getItem('${THEME_KEY}');
    /*
     * No stored choice means follow the OS. Defaulting to dark regardless would
     * be defensible — this is a dark-first product — but it makes the app the
     * one window on a light desktop that ignores the setting.
     */
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    d.setAttribute('data-theme', t);

    var a = localStorage.getItem('${ACCENT_KEY}');
    d.setAttribute('data-accent', a === 'sage' || a === 'iris' ? a : 'mist');
  } catch (e) {
    /* Storage unavailable — the dark defaults in globals.css already apply. */
  }
})();
`;

export { THEME_KEY, ACCENT_KEY };

export function ThemeScript() {
  // eslint-disable-next-line react/no-danger -- a constant string, no input reaches it
  return <script dangerouslySetInnerHTML={{ __html: BOOTSTRAP }} />;
}
