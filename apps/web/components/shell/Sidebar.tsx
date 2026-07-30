'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV, SETTINGS_ITEM, isNavActive, type NavItemDef } from './nav';
import { IconSearch, IconChevronsLeft, IconChevronsRight } from './icons';

/**
 * The persistent left sidebar — the app's spine, VS Code / Cursor style.
 *
 * One column that collapses from a labelled 240px to a 64px icon rail. It owns
 * the window-drag region on the desktop build (`.app-sidebar-drag`), so no page
 * needs its own drag header any more. Active state is derived from the path, so
 * the sidebar always reflects where you are — including on the cockpit and plan
 * routes, which fold under Runs.
 */

interface NavRowProps {
  item: NavItemDef;
  active: boolean;
  collapsed: boolean;
}

function NavRow({ item, active, collapsed }: NavRowProps) {
  const { Icon, label, href } = item;
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={`group relative flex items-center rounded-md text-sm transition-colors ${
        collapsed ? 'h-9 w-9 justify-center' : 'h-9 gap-3 px-2.5'
      } ${
        active
          ? 'bg-surface-2 text-ink'
          : 'text-ink-dim hover:text-ink hover:bg-surface-2/60'
      }`}
    >
      {active && (
        <span className="bg-accent absolute top-1/2 left-0 h-4 w-[2.5px] -translate-y-1/2 rounded-r-full" />
      )}
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

export interface SidebarProps {
  collapsed: boolean;
  /** False until the persisted width has been restored — gates the transition
   *  so restoring a collapsed sidebar snaps rather than animating open→closed. */
  mounted: boolean;
  onToggle: () => void;
  onOpenPalette: () => void;
}

export function Sidebar({ collapsed, mounted, onToggle, onOpenPalette }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      data-collapsed={collapsed}
      className={`app-sidebar-drag border-line bg-surface-1 flex h-full shrink-0 flex-col border-r ${
        mounted ? 'transition-[width] duration-150 ease-out' : ''
      } ${collapsed ? 'w-16' : 'w-60'}`}
    >
      {/* Brand */}
      <div className={`flex h-14 items-center ${collapsed ? 'justify-center px-0' : 'px-3'}`}>
        <Link
          href="/runs"
          title="QAAI"
          className="flex items-center gap-2 overflow-hidden"
        >
          <span className="brand-gradient flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[14px] font-bold text-white shadow-sm">
            Q
          </span>
          {!collapsed && (
            <span className="text-[15px] font-semibold tracking-tight">QAAI</span>
          )}
        </Link>
      </div>

      {/* Search / command palette entry */}
      <div className={`pb-1 ${collapsed ? 'px-3' : 'px-3'}`}>
        <button
          type="button"
          onClick={onOpenPalette}
          title="Search — ⌘K"
          className={`text-ink-faint hover:text-ink hover:border-line-strong border-line bg-surface flex items-center rounded-md border text-sm transition-colors ${
            collapsed ? 'h-9 w-9 justify-center' : 'h-9 w-full gap-2 px-2.5'
          }`}
        >
          <IconSearch className="h-4 w-4 shrink-0" />
          {!collapsed && (
            <>
              <span>Search</span>
              <kbd className="border-line text-ink-faint ml-auto rounded border px-1 py-0.5 font-mono text-[10px]">
                ⌘K
              </kbd>
            </>
          )}
        </button>
      </div>

      {/* Primary nav */}
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2">
        {NAV.map((item) => (
          <NavRow
            key={item.href}
            item={item}
            active={isNavActive(pathname, item.href)}
            collapsed={collapsed}
          />
        ))}
      </nav>

      {/* Footer: settings + collapse */}
      <div className="border-line flex flex-col gap-0.5 border-t px-3 py-2">
        <NavRow
          item={SETTINGS_ITEM}
          active={isNavActive(pathname, SETTINGS_ITEM.href)}
          collapsed={collapsed}
        />
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar — ⌘\\' : 'Collapse sidebar — ⌘\\'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`text-ink-faint hover:text-ink hover:bg-surface-2/60 flex items-center rounded-md text-sm transition-colors ${
            collapsed ? 'h-9 w-9 justify-center' : 'h-9 gap-3 px-2.5'
          }`}
        >
          {collapsed ? (
            <IconChevronsRight className="h-[18px] w-[18px] shrink-0" />
          ) : (
            <IconChevronsLeft className="h-[18px] w-[18px] shrink-0" />
          )}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
