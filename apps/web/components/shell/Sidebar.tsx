'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, type Project, type Run } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useProject } from './ProjectContext';
import { IconChevronsLeft, IconChevronsRight, IconSearch } from './icons';
import { ALL_SECTIONS, isNavActive, type NavItemDef } from './nav';
import { ACCENTS, useTheme } from './useTheme';

/**
 * The sidebar — now the app's only chrome.
 *
 * There was a top bar as well, holding the project switcher, a breadcrumb and
 * the account menu. Two pieces of furniture for one column of content is one
 * too many: the breadcrumb repeated the sidebar's own active row, and the two
 * controls that were not repeats (which app am I looking at, who am I signed in
 * as) belong next to the destinations they scope. So they moved here, the bar
 * went, and every screen got its 48px back.
 *
 * It also owns the window-drag region on the desktop build (`.app-sidebar-drag`)
 * and the macOS traffic-light inset, both styled in globals.css.
 */

/** How often the two live badges re-ask. Slower than a screen's own poll: this
 *  is peripheral vision, not the thing you are looking at. */
const BADGE_POLL_MS = 10_000;

interface Me {
  user: { id: string; email: string; name: string | null } | null;
  activeOrgId: string;
  orgs: Array<{ id: string; name: string; slug: string; plan: string; role: string }>;
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
  const router = useRouter();
  const { projects, project, projectId, setProjectId, loading } = useProject();
  const { theme, accent, setTheme, setAccent } = useTheme();

  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState<'project' | 'account' | null>(null);
  const [liveRuns, setLiveRuns] = useState(0);
  const [openVerdicts, setOpenVerdicts] = useState(0);
  const [health, setHealth] = useState<Run['status'] | null>(null);
  const [testCounts, setTestCounts] = useState<Record<string, number>>({});
  const [isMac, setIsMac] = useState(true);

  const asideRef = useRef<HTMLElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const accountTrigger = useRef<HTMLButtonElement>(null);

  // ⌘ on macOS, Ctrl everywhere else. Resolved after mount so the server and the
  // client agree on the first render; the label corrects itself a frame later.
  useEffect(() => setIsMac(/mac/i.test(navigator.userAgent)), []);

  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch(() => {
        /* signed out — the page's own guard redirects */
      });
  }, []);

  /*
   * The suite size behind the project name. It is in the /projects payload that
   * ProjectContext already fetches, but not in the ProjectLite shape the context
   * exposes, so this asks for it separately. One request, once, and it should
   * collapse into the provider the next time that file is opened.
   */
  useEffect(() => {
    api<{ projects: Project[] }>('/projects')
      .then(({ projects }) =>
        setTestCounts(Object.fromEntries(projects.map((p) => [p.id, p._count.tests]))),
      )
      .catch(() => {
        /* the meta line falls back to the environment alone */
      });
  }, []);

  /*
   * The two live badges, and the health dot on the switcher.
   *
   * Both fail soft and silently: a sidebar is navigation first, and a counter
   * that 500s must never take the destinations down with it. Each call has its
   * own catch so one failing endpoint does not blank the other's badge.
   */
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const scope = projectId ? `&projectId=${encodeURIComponent(projectId)}` : '';
        const { runs } = await api<{ runs: Run[] }>(`/runs?limit=25${scope}`);
        if (cancelled) return;
        setLiveRuns(runs.filter((r) => r.status === 'RUNNING' || r.status === 'QUEUED').length);
        setHealth(runs[0]?.status ?? null);
      } catch {
        /* keep whatever the last good answer was */
      }
      try {
        const { verdicts } = await api<{ verdicts: unknown[] }>('/verdicts?state=PENDING');
        if (!cancelled) setOpenVerdicts(verdicts.length);
      } catch {
        /* as above */
      }
    };

    void load();
    const timer = setInterval(() => void load(), BADGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId]);

  // One outside-click / Escape handler for whichever menu is open. Escape hands
  // focus back to the button that opened it, or a keyboard user is dropped at
  // the top of the document.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!asideRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(null);
      (open === 'project' ? projectTrigger : accountTrigger).current?.focus();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // Even if the call fails the user wants to be signed out; the cookie is
      // httpOnly so the client cannot clear it, but sending them to /login at
      // least ends the session from their point of view.
    }
    // A full navigation, for the same reason the org switcher reloads: the
    // project list, the selected project and this session live at the root
    // layout and are fetched once on mount. router.push left all of the signed
    // -out user's data in memory behind the login form.
    window.location.assign('/login');
  }, []);

  const activeOrg = me?.orgs.find((o) => o.id === me.activeOrgId);
  const displayName = me?.user?.name || me?.user?.email || null;
  const environment = project?.environments[0]?.name;
  const tests = projectId ? testCounts[projectId] : undefined;
  const projectMeta =
    [tests === undefined ? null : `${tests} tests`, environment?.toLowerCase()]
      .filter(Boolean)
      .join(' · ') || project?.primaryFramework.toLowerCase();

  return (
    <aside
      ref={asideRef}
      data-collapsed={collapsed}
      className={cn(
        'app-sidebar-drag border-line bg-surface-1 flex h-full shrink-0 flex-col border-r pt-[18px] pb-3',
        mounted && 'transition-[width] duration-150 ease-out',
        collapsed ? 'w-16 px-2' : 'w-56 px-3',
      )}
    >
      {/*
        Brand. The wordmark is the mark — there is no logo tile any more.

        The collapse control shares this row. The redesign dropped the old
        bottom-of-sidebar "Collapse" button, but ⌘\, a palette command and an
        entry in the ⌘/ shortcut sheet all still drove the feature — three
        advertisements for something with no visible affordance, which is this
        codebase's recurring defect wearing a new hat. It sits here rather than
        at the foot because the foot now belongs to the user row.
      */}
      <div className={cn('group/brand flex items-center', collapsed ? 'justify-center' : 'pr-1')}>
        <Link
          href="/runs"
          title="QAAI"
          className={cn(
            'flex items-baseline gap-2 overflow-hidden',
            collapsed ? 'justify-center' : 'px-2.5',
          )}
        >
          <span className="font-display text-[19px] leading-none font-semibold tracking-[-0.01em]">
            {collapsed ? 'Q' : 'QAAI'}
          </span>
          {!collapsed && (
            <span className="text-ink-faint font-mono text-[10px] tracking-[0.08em]">CONSOLE</span>
          )}
        </Link>

        {!collapsed && (
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            title={`Collapse sidebar (${isMac ? '⌘' : 'Ctrl'}\\)`}
            /*
             * Quiet until the sidebar is hovered or the button is focused: a
             * control you press once a week should not compete with the nav for
             * attention, and `focus-visible` keeps it reachable by keyboard.
             */
            className="text-ink-faint hover:text-ink hover:bg-surface-2 ml-auto rounded-md p-1 opacity-0 transition-opacity group-hover/brand:opacity-100 focus-visible:opacity-100"
          >
            <IconChevronsLeft className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand sidebar"
          title={`Expand sidebar (${isMac ? '⌘' : 'Ctrl'}\\)`}
          className="text-ink-faint hover:text-ink hover:bg-surface-2 mt-2 flex justify-center rounded-md p-1.5"
        >
          <IconChevronsRight className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Project switcher — the fix for six screens silently using projects[0]. */}
      <div className="relative mt-4">
        <button
          ref={projectTrigger}
          type="button"
          onClick={() => setOpen(open === 'project' ? null : 'project')}
          aria-haspopup="menu"
          aria-expanded={open === 'project'}
          aria-label={project ? `Project: ${project.name}` : 'Choose a project'}
          title={collapsed ? (project?.name ?? 'No project') : undefined}
          className={cn(
            'border-line hover:border-line-strong flex w-full items-center gap-2 rounded-lg border text-left transition-colors',
            collapsed ? 'justify-center px-0 py-2.5' : 'px-2.5 py-2',
          )}
        >
          <HealthDot status={health} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="text-body-sm block truncate leading-[1.3] font-medium">
                  {loading && !project ? '…' : (project?.name ?? 'No project')}
                </span>
                <span className="text-ink-faint block truncate font-mono text-[10px]">
                  {projectMeta ?? '—'}
                </span>
              </span>
              <Chevron />
            </>
          )}
        </button>

        {open === 'project' && (
          <Popover label="Projects" placement="below">
            {projects.length === 0 && (
              <p className="text-ink-faint text-micro px-3 py-2">
                No apps yet. Connect one and its runs, tests and insights appear here.
              </p>
            )}
            {projects.map((p) => (
              <MenuItem
                key={p.id}
                active={p.id === project?.id}
                onClick={() => {
                  setProjectId(p.id);
                  setOpen(null);
                }}
              >
                <span className="truncate">{p.name}</span>
                <span className="text-ink-faint text-meta ml-auto font-mono">
                  {p.primaryFramework.toLowerCase()}
                </span>
              </MenuItem>
            ))}
            <div className="border-line mt-1 border-t pt-1">
              <MenuItem
                onClick={() => {
                  setOpen(null);
                  router.push('/onboarding');
                }}
              >
                + Add app
              </MenuItem>
            </div>
          </Popover>
        )}
      </div>

      <nav className="mt-5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {ALL_SECTIONS.map((item) => (
          <NavRow
            key={item.href}
            item={item}
            active={isNavActive(pathname, item.href)}
            collapsed={collapsed}
            liveRuns={liveRuns}
            openVerdicts={openVerdicts}
          />
        ))}
      </nav>

      {/* The palette. "Anything" because it is not only search — it runs the
          suite, switches app and opens a file. */}
      <button
        type="button"
        onClick={onOpenPalette}
        title={`Search and commands — ${isMac ? '⌘K' : 'Ctrl K'}`}
        className={cn(
          'border-line text-ink-faint hover:border-line-strong hover:text-ink text-row-sub flex w-full items-center gap-2 rounded-lg border transition-colors',
          collapsed ? 'justify-center px-0 py-2' : 'px-2.5 py-[7px]',
        )}
      >
        <IconSearch className="h-3.5 w-3.5 shrink-0" />
        {!collapsed && (
          <>
            <span className="flex-1 text-left">Anything</span>
            <kbd className="border-line text-meta rounded-sm border px-[5px] py-px font-mono whitespace-nowrap">
              {isMac ? '⌘K' : 'Ctrl K'}
            </kbd>
          </>
        )}
      </button>

      {/* Account. Absorbs the top bar's menu: org switcher, Settings, Billing,
          sign out — plus the theme control, which has nowhere else to live that
          is not a seventh nav row for a preference. */}
      <div className="border-line relative mt-2.5 border-t pt-3">
        <button
          ref={accountTrigger}
          type="button"
          onClick={() => setOpen(open === 'account' ? null : 'account')}
          aria-haspopup="true"
          aria-expanded={open === 'account'}
          aria-label="Account and appearance"
          title={collapsed ? (displayName ?? 'Account') : undefined}
          className={cn(
            'hover:bg-surface-2/60 flex w-full items-center gap-2.5 rounded-md py-1 text-left transition-colors',
            collapsed ? 'justify-center px-0' : 'px-2.5',
          )}
        >
          <span className="text-meta text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] font-semibold">
            {(displayName ?? '·').slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="text-row-sub block truncate leading-[1.3]">
                {displayName ?? '—'}
              </span>
              <span className="text-ink-faint text-meta block truncate font-mono">
                {activeOrg ? `${activeOrg.slug} · ${activeOrg.plan.toLowerCase()}` : '—'}
              </span>
            </span>
          )}
        </button>

        {open === 'account' && (
          <Popover label="Account and appearance" placement="above">
            <div className="border-line border-b px-3 py-2">
              <p className="text-body-sm truncate">{displayName ?? '—'}</p>
              {me?.user?.name && (
                <p className="text-ink-faint text-micro truncate">{me.user.email}</p>
              )}
            </div>

            <div className="border-line border-b px-3 py-2.5">
              <p className="text-ink-faint text-meta mb-2 font-mono tracking-[0.1em] uppercase">
                Appearance
              </p>
              <div className="flex flex-wrap gap-1">
                <Chip pressed={theme === 'light'} onClick={() => setTheme('light')}>
                  LIGHT
                </Chip>
                <Chip pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
                  DARK
                </Chip>
              </div>
              {/* Named, not swatched: the three accents are the only colours in
                  the app that are not tokens at this point, and picking one
                  re-tints everything behind the menu anyway. */}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {ACCENTS.map((value) => (
                  <Chip key={value} pressed={accent === value} onClick={() => setAccent(value)}>
                    {value.toUpperCase()}
                  </Chip>
                ))}
              </div>
            </div>

            {/* Org switcher — /auth/switch-org has existed with no UI. */}
            {(me?.orgs.length ?? 0) > 1 && (
              <div className="border-line border-b py-1">
                <p className="text-ink-faint text-meta px-3 py-1 font-mono tracking-[0.1em] uppercase">
                  Organisations
                </p>
                {me!.orgs.map((org) => (
                  <MenuItem
                    key={org.id}
                    active={org.id === me!.activeOrgId}
                    onClick={async () => {
                      await api('/auth/switch-org', {
                        method: 'POST',
                        body: JSON.stringify({ orgId: org.id }),
                      });
                      // A full reload is correct here: every cached list on
                      // every screen belongs to the previous org.
                      window.location.reload();
                    }}
                  >
                    <span className="truncate">{org.name}</span>
                  </MenuItem>
                ))}
              </div>
            )}

            <div className="py-1">
              <MenuItem
                onClick={() => {
                  setOpen(null);
                  router.push('/settings');
                }}
              >
                Settings
              </MenuItem>
              {/* Billing was unreachable from anywhere in the UI. */}
              <MenuItem
                onClick={() => {
                  setOpen(null);
                  router.push('/settings/billing');
                }}
              >
                Billing
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setOpen(null);
                  onToggle();
                }}
              >
                {collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                <span className="text-ink-faint text-meta ml-auto font-mono">
                  {isMac ? '⌘\\' : 'Ctrl \\'}
                </span>
              </MenuItem>
              <MenuItem onClick={() => void signOut()}>Sign out</MenuItem>
            </div>
          </Popover>
        )}
      </div>
    </aside>
  );
}

function NavRow({
  item,
  active,
  collapsed,
  liveRuns,
  openVerdicts,
}: {
  item: NavItemDef;
  active: boolean;
  collapsed: boolean;
  liveRuns: number;
  openVerdicts: number;
}) {
  const { Icon, label, href, badge } = item;
  const runsInFlight = badge === 'live-runs' && liveRuns > 0;
  const waiting = badge === 'open-verdicts' && openVerdicts > 0;

  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'text-row relative flex h-[34px] items-center rounded-md transition-colors',
        collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5',
        active ? 'bg-surface-2 text-ink' : 'text-ink-dim hover:text-ink',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}

      {runsInFlight && (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'bg-accent h-1.5 w-1.5 shrink-0 animate-pulse rounded-full',
              collapsed && 'absolute top-1.5 right-1.5',
            )}
          />
          <span className="sr-only">
            {liveRuns} {liveRuns === 1 ? 'run' : 'runs'} in flight
          </span>
        </>
      )}

      {waiting &&
        (collapsed ? (
          <>
            <span
              aria-hidden="true"
              className="bg-fail absolute top-1.5 right-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
            />
            <span className="sr-only">{openVerdicts} awaiting a verdict</span>
          </>
        ) : (
          <span className="text-fail text-meta shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-fail)_12%,transparent)] px-[7px] py-px font-mono font-medium tabular-nums">
            {openVerdicts}
            <span className="sr-only"> awaiting a verdict</span>
          </span>
        ))}
    </Link>
  );
}

/** The switcher's dot: how the app you are pointed at is doing, at a glance. */
function HealthDot({ status }: { status: Run['status'] | null }) {
  const tone =
    status === 'PASSED'
      ? 'bg-pass'
      : status === 'FAILED' || status === 'ERRORED'
        ? 'bg-fail'
        : status === 'RUNNING' || status === 'QUEUED'
          ? 'bg-accent'
          : 'bg-ink-faint';

  return (
    <span
      title={status ? `last run ${status.toLowerCase()}` : 'no runs yet'}
      className={cn('h-[7px] w-[7px] shrink-0 rounded-full', tone)}
    />
  );
}

function Popover({
  label,
  placement,
  children,
}: {
  label: string;
  /** The account menu is at the bottom of a full-height column, so its menu
   *  opens upward or it would be drawn off the bottom of the window. */
  placement: 'above' | 'below';
  children: React.ReactNode;
}) {
  return (
    /*
     * role="menu", restored. The old TopBar's dropdowns carried proper menu
     * semantics and the sidebar rewrite dropped them, so both triggers still
     * announced aria-haspopup="menu" and then opened something that was not
     * one — a promise made to the screen reader and broken one element later.
     * MenuItem below carries the matching role="menuitem".
     */
    <div
      role="menu"
      aria-label={label}
      className={cn(
        'border-line-strong bg-surface-1 absolute left-0 z-40 max-h-[70vh] w-60 overflow-y-auto rounded-lg border py-1 shadow-[var(--shadow-overlay)]',
        placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-1',
      )}
    >
      {children}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'text-body-sm hover:bg-surface-2 flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
        active ? 'text-ink' : 'text-ink-dim',
      )}
    >
      {active && <span className="text-accent -ml-1.5 w-1.5">•</span>}
      {children}
    </button>
  );
}

/** A pressable mono chip. Used for the theme and the three accents. */
function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'text-meta rounded-sm border px-2 py-1 font-mono tracking-[0.08em] transition-colors',
        pressed
          ? 'border-accent/40 text-accent bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]'
          : 'border-line text-ink-faint hover:text-ink hover:border-line-strong',
      )}
    >
      {children}
    </button>
  );
}

function Chevron() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className="text-ink-faint shrink-0"
    >
      <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
