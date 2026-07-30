import type { ComponentType } from 'react';
import {
  IconList,
  IconGrid,
  IconCode,
  IconKey,
  IconDownload,
  IconPlusSquare,
  IconSliders,
} from './icons';

/**
 * The one source of truth for the sidebar's destinations. The cockpit
 * (`/runs/:id`) and plan approval (`/projects/:id/plan`) have no nav entry of
 * their own, so `isNavActive` folds them under Runs — otherwise nothing in the
 * sidebar lights up while you are looking at a run.
 */

export interface NavItemDef {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

export const NAV: NavItemDef[] = [
  { href: '/runs', label: 'Runs', Icon: IconList },
  { href: '/dashboard', label: 'Dashboard', Icon: IconGrid },
  { href: '/editor', label: 'Editor', Icon: IconCode },
  { href: '/environments', label: 'Environments', Icon: IconKey },
  { href: '/import', label: 'Import', Icon: IconDownload },
  { href: '/onboarding', label: 'Add app', Icon: IconPlusSquare },
];

export const SETTINGS_ITEM: NavItemDef = {
  href: '/settings',
  label: 'Settings',
  Icon: IconSliders,
};

/** Routes that must NOT get the app shell (marketing + auth stand alone). */
export const SHELL_EXCLUDED = new Set(['/', '/login']);

export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/runs') {
    return (
      pathname === '/runs' ||
      pathname.startsWith('/runs/') ||
      pathname.startsWith('/projects/')
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
