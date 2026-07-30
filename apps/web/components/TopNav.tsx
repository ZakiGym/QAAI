'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The one navigation bar for every full-page screen.
 *
 * Before this, nav was a scattered set of text links that differed per page —
 * which reads as unfinished. A single consistent bar with a real logo mark and
 * an active-state indicator is most of the difference between "basic" and
 * "considered", and it means a user always knows where they are and how to get
 * anywhere else.
 */

const LINKS = [
  { href: '/runs', label: 'Runs' },
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/editor', label: 'Editor' },
  { href: '/import', label: 'Import' },
  { href: '/onboarding', label: 'Add app' },
  { href: '/settings', label: 'Settings' },
];

export function Brand({ className = '' }: { className?: string }) {
  return (
    <Link href="/runs" className={`flex items-center gap-2 ${className}`}>
      <span className="brand-gradient flex h-6 w-6 items-center justify-center rounded-md text-[13px] font-bold text-white shadow-sm">
        Q
      </span>
      <span className="text-base font-semibold tracking-tight">QAAI</span>
    </Link>
  );
}

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="app-drag border-line bg-surface/70 sticky top-0 z-30 flex items-center gap-1 border-b px-5 py-2.5 backdrop-blur">
      <Brand className="mr-4" />
      <nav className="flex items-center gap-0.5">
        {LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                active ? 'bg-surface-2 text-ink' : 'text-ink-dim hover:text-ink hover:bg-surface-1'
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
