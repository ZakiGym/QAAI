import type { Metadata } from 'next';
import './globals.css';
import { DesktopChrome } from '../components/DesktopChrome';

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
        {children}
      </body>
    </html>
  );
}
