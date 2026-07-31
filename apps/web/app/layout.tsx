import type { Metadata } from 'next';
import './globals.css';
import { DesktopChrome } from '../components/DesktopChrome';
import { AppShell } from '../components/shell/AppShell';
import { ToastProvider } from '../components/ui/Toast';
import { ProjectProvider } from '../components/shell/ProjectContext';

export const metadata: Metadata = {
  title: 'QAAI — Your AI QA engineer',
  description:
    'An autonomous agent that tests your app like a staff QA engineer, plus a cockpit where your team supervises it.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
