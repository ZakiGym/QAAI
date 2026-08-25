import type { ComponentType } from 'react';
import { IconList, IconCode, IconTriage, IconSliders, IconSearch } from './icons';
import { IconServer } from '../RunnerList';

/**
 * The sidebar's destinations, and the tab strips inside them.
 *
 * ─── Why this shrank from sixteen rows to six ────────────────────────────────
 *
 * The old sidebar listed every screen the product has. Sixteen equally-weighted
 * rows is not navigation, it is an index — nothing told you that Triage is
 * where your day starts and Import is something you do once, and the two most
 * closely related screens in the app (Runs and Dashboard) sat apart with twelve
 * rows between them.
 *
 * Six sections, each with a tab strip. Every screen the product had is still
 * reachable and still at its own URL, which matters more than it looks: a run
 * link pasted in Slack, a bookmark, a link in an email and every selector in
 * the dogfood suite all keep working. The only genuine merge is /dashboard,
 * which became the stats band at the top of Runs and now redirects there.
 */

export interface NavTab {
  href: string;
  /** Rendered mono/uppercase in the strip; written here in its display case. */
  label: string;
}

export interface NavItemDef {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  /**
   * Extra routes this entry owns — screens with no row of their own that should
   * still light this one up (a cockpit under Runs, the GitHub App tab under
   * Setup). Without it the sidebar goes dark exactly when you have navigated
   * somewhere deep and most need to know where you are.
   */
  owns?: string[];
  /** The strip under the page title. Absent for sections with a single screen. */
  tabs?: NavTab[];
  /**
   * A live signal rendered on the row: a pulse dot for runs in flight, a count
   * pill for verdicts waiting on a human. Resolved by the Sidebar — this file
   * stays free of data fetching.
   */
  badge?: 'live-runs' | 'open-verdicts';
}

export const NAV: NavItemDef[] = [
  {
    href: '/runs',
    label: 'Runs',
    Icon: IconList,
    // The cockpit and the plan-approval screen fold under Runs. /dashboard is
    // listed because its redirect is a client hop and the row must not flicker.
    owns: ['/dashboard', '/projects'],
    badge: 'live-runs',
  },
  {
    href: '/triage',
    label: 'Triage',
    Icon: IconTriage,
    owns: ['/heals', '/quality'],
    badge: 'open-verdicts',
    tabs: [
      { href: '/triage', label: 'Verdicts' },
      { href: '/heals', label: 'Heals' },
      { href: '/quality', label: 'Quality' },
    ],
  },
  {
    href: '/editor',
    label: 'Tests',
    Icon: IconCode,
    owns: ['/flow-map', '/import', '/repro', '/traffic', '/tests'],
    tabs: [
      { href: '/editor', label: 'Editor' },
      { href: '/flow-map', label: 'Flow map' },
      { href: '/import', label: 'Import' },
      { href: '/repro', label: 'From a bug' },
      { href: '/traffic', label: 'From traffic' },
    ],
  },
  {
    href: '/insights',
    label: 'Insights',
    Icon: IconSearch,
    tabs: [
      { href: '/insights/coverage', label: 'Coverage' },
      { href: '/insights/health', label: 'Suite health' },
      { href: '/insights/impact', label: 'Impact' },
    ],
  },
  {
    href: '/environments',
    label: 'Setup',
    Icon: IconServer,
    /*
     * `/schedules` MUST be listed here as well as in the strip below.
     *
     * `isNavActive` prefix-matches a section's own href, and /schedules shares
     * no prefix with /environments — so without this claim the sidebar goes
     * dark on the schedules screen, `sectionFor` returns null, and the shell
     * renders no tab strip at all, stranding the page with no way back into
     * its own section.
     */
    owns: [
      '/schedules',
      '/source-control',
      '/integrations',
      '/settings/runners',
      '/settings/github',
      '/onboarding',
    ],
    tabs: [
      { href: '/environments', label: 'Environments' },
      /*
       * A tab, not a sixteenth sidebar row — and a tab is enough, because the
       * palette is built from tab hrefs rather than from section rows (see
       * EXTRA_DESTINATIONS and the note above `nav` in AppShell). That is the
       * fix for the redesign's one regression, where ten screens fell out of
       * ⌘K the moment they stopped having a row; a screen listed here inherits
       * it. Placed second because a schedule points at an environment, so this
       * is the next question after "where does it run".
       */
      { href: '/schedules', label: 'Schedules' },
      { href: '/source-control', label: 'Source control' },
      { href: '/integrations', label: 'Integrations' },
      { href: '/settings/runners', label: 'Runners' },
      { href: '/onboarding', label: 'Add app' },
    ],
  },
];

export const SETTINGS_ITEM: NavItemDef = {
  href: '/settings',
  label: 'Settings',
  Icon: IconSliders,
  owns: ['/settings/billing'],
  tabs: [
    { href: '/settings?tab=organization', label: 'Organization' },
    { href: '/settings?tab=members', label: 'Members' },
    { href: '/settings?tab=apiKeys', label: 'API keys' },
    { href: '/settings/billing', label: 'Billing' },
    { href: '/settings?tab=account', label: 'Account' },
  ],
};

/** Every section, in sidebar order. Settings sits below a spacer in the UI. */
export const ALL_SECTIONS: NavItemDef[] = [...NAV, SETTINGS_ITEM];

/**
 * Routes that must NOT get the app shell (marketing + auth stand alone).
 *
 * `/reset-password` is reached from a link in an email by someone who is, by
 * definition, signed out — a sidebar of destinations they cannot open is noise
 * at best, and its project fetches 401 on every one of them.
 */
export const SHELL_EXCLUDED = new Set(['/', '/login', '/signup', '/reset-password']);

function matchesPrefix(pathname: string, href: string): boolean {
  const path = href.split('?')[0]!;
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function isNavActive(pathname: string, href: string): boolean {
  const item = ALL_SECTIONS.find((entry) => entry.href === href);

  /*
   * A nested claim wins outright. Setup owns /settings/runners and
   * /settings/github, which the prefix rule below would also hand to Settings —
   * so on those screens TWO rows lit up and two links carried
   * aria-current="page", which is wrong to look at and wrong to hear.
   */
  if (item?.owns?.some((route) => matchesPrefix(pathname, route))) return true;

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

/** Which section owns a path. Null on the routes that stand outside the shell. */
export function sectionFor(pathname: string): NavItemDef | null {
  return ALL_SECTIONS.find((item) => isNavActive(pathname, item.href)) ?? null;
}

/** Whether a tab in a strip is the one currently being shown. */
export function isTabActive(pathname: string, search: string, tabHref: string): boolean {
  const [path, query] = tabHref.split('?');
  if (pathname !== path) {
    // /insights redirects to /insights/coverage; treat the bare route as its
    // first tab so the strip is never blank on arrival.
    return path === '/insights/coverage' && pathname === '/insights';
  }
  if (!query) return true;

  const want = new URLSearchParams(query);
  const have = new URLSearchParams(search);
  for (const [key, value] of want) {
    // A URL with no tab param means the screen's own default, which is the first.
    if ((have.get(key) ?? 'organization') !== value) return false;
  }
  return true;
}
