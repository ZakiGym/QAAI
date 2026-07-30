import type { Metadata } from 'next';
import './globals.css';
import { DesktopChrome } from '../components/DesktopChrome';
import { AppShell } from '../components/shell/AppShell';
import { ToastProvider } from '../components/ui/Toast';

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
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
