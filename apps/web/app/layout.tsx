import type { Metadata } from 'next';
import { IBM_Plex_Mono, Instrument_Sans, Source_Serif_4 } from 'next/font/google';
import './globals.css';
import { DesktopChrome } from '../components/DesktopChrome';
import { AppShell } from '../components/shell/AppShell';
import { ThemeScript } from '../components/shell/ThemeScript';
import { ToastProvider } from '../components/ui/Toast';
import { ProjectProvider } from '../components/shell/ProjectContext';

/*
 * Three families, three jobs. Self-hosted through next/font rather than linked
 * from Google: a webfont fetched at runtime means the first paint of a cockpit
 * someone opens under pressure is in Times, and the serif display type is
 * load-bearing enough here that the swap would be very visible.
 *
 * Each exposes a CSS variable that globals.css binds to --font-sans /
 * --font-display / --font-mono, so nothing downstream ever names a typeface.
 */
const sans = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-instrument-sans',
  display: 'swap',
});

const display = Source_Serif_4({
  subsets: ['latin'],
  weight: ['500', '600'],
  /*
   * Italic is not decoration here — it is how the UI marks prose the AGENT
   * wrote (verdict explanations, heal rationale) apart from prose the product
   * wrote. Without the real italic face the browser synthesises a slant, and
   * the distinction stops reading as deliberate.
   */
  style: ['normal', 'italic'],
  variable: '--font-source-serif',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'QAAI — Your AI QA engineer',
  description:
    'An autonomous agent that tests your app like a staff QA engineer, plus a cockpit where your team supervises it.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `suppressHydrationWarning` because ThemeScript writes data-theme and
     * data-accent onto this element before React hydrates — which is the entire
     * point of it, and which React would otherwise report as a mismatch.
     */
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
    >
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen antialiased">
        <DesktopChrome />
        {/* Outside the shell, so login and marketing can raise toasts too. */}
        {/* ProjectProvider sits ABOVE AppShell so the shell itself — the ⌘P
            quick-open in particular — can read the selected project. With the
            provider rendered inside AppShell, the shell was above its own
            context and fell back to projects[0], so ⌘P listed the wrong
            project's files and opening one 404'd silently. */}
        <ToastProvider>
          <ProjectProvider>
            <AppShell>{children}</AppShell>
          </ProjectProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
