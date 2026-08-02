import type { ComponentType } from 'react';
import {
  IconList,
  IconGrid,
  IconCode,
  IconMap,
  IconTriage,
  IconShield,
  IconHeal,
  IconBranch,
  IconKey,
  IconDownload,
  IconPlusSquare,
  IconSliders,
  IconActivity,
  IconBug,
  IconSearch,
} from './icons';
import { IconServer } from '../RunnerList';

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
  /**
   * Extra routes this entry owns — screens with no nav entry of their own that
   * should still light this one up. `/settings/github` is the GitHub App tab of
   * the Infrastructure screen: you reach it from a tab, not the sidebar, and
   * without this the highlight jumped to Settings the moment you switched tabs.
   */
  owns?: string[];
}

export const NAV: NavItemDef[] = [
  { href: '/runs', label: 'Runs', Icon: IconList },
  { href: '/dashboard', label: 'Dashboard', Icon: IconGrid },
  { href: '/editor', label: 'Editor', Icon: IconCode },
  { href: '/flow-map', label: 'Flow map', Icon: IconMap },
  { href: '/triage', label: 'Triage', Icon: IconTriage },
  { href: '/quality', label: 'Quality', Icon: IconShield },
  { href: '/insights', label: 'Insights', Icon: IconSearch },
  { href: '/heals', label: 'Self-healing', Icon: IconHeal },
  { href: '/environments', label: 'Environments', Icon: IconKey },
  { href: '/source-control', label: 'Source control', Icon: IconBranch },
  { href: '/traffic', label: 'Traffic', Icon: IconActivity },
  { href: '/repro', label: 'Reproduce a bug', Icon: IconBug },
  { href: '/import', label: 'Import', Icon: IconDownload },
  { href: '/onboarding', label: 'Add app', Icon: IconPlusSquare },
  // Infrastructure (runners + the GitHub App). The icon comes from the feature's
  // own file rather than ./icons because this change does not own that file.
  {
    href: '/settings/runners',
    label: 'Infrastructure',
    Icon: IconServer,
    owns: ['/settings/github'],
  },
];

export const SETTINGS_ITEM: NavItemDef = {
  href: '/settings',
  label: 'Settings',
  Icon: IconSliders,
};

/** Routes that must NOT get the app shell (marketing + auth stand alone). */
export const SHELL_EXCLUDED = new Set(['/', '/login', '/signup']);

function matchesPrefix(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/runs') {
    return (
      pathname === '/runs' || pathname.startsWith('/runs/') || pathname.startsWith('/projects/')
    );
  }

  const item = NAV.find((entry) => entry.href === href);
  if (item?.owns?.some((route) => matchesPrefix(pathname, route))) return true;

  /*
   * Settings yields to anything more specific.
   *
   * Infrastructure lives at `/settings/runners`, which the prefix rule also
   * hands to `/settings` — so on that screen TWO sidebar rows lit up and two
   * links carried `aria-current="page"`, which is both wrong to look at and
   * wrong to hear. The general rule: an entry nested under another entry wins
   * outright, and the parent stays dark.
   */
  if (href === SETTINGS_ITEM.href) {
    const claimedByNav = NAV.some(
      (entry) =>
        matchesPrefix(pathname, entry.href) ||
        (entry.owns ?? []).some((route) => matchesPrefix(pathname, route)),
    );
    if (claimedByNav) return false;
  }

  return matchesPrefix(pathname, href);
}
