'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useProject } from './ProjectContext';
import { NAV, SETTINGS_ITEM } from './nav';

/**
 * The top bar.
 *
 * The app had a sidebar and nothing else, so there was nowhere to put the four
 * things every screen needs and none had: which project you are looking at, where
 * you are, whether a run is happening, and who you are signed in as.
 *
 * Its absence was why `/settings/billing` became an orphan route reachable only
 * by typing the URL, and why there was no sign-out anywhere in the product even
 * though `POST /auth/logout` has existed on the API the whole time.
 */

interface Me {
  user: { id: string; email: string; name: string | null } | null;
  activeOrgId: string;
  orgs: Array<{ id: string; name: string; slug: string; plan: string; role: string }>;
}

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { projects, project, setProjectId } = useProject();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState<'project' | 'account' | null>(null);

  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch(() => {
        /* signed out — the page's own guard redirects */
      });
  }, []);

  // One outside-click/Escape handler for whichever menu is open.
  const barRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
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

  const crumb = crumbFor(pathname);
  const activeOrg = me?.orgs.find((o) => o.id === me.activeOrgId);

  return (
    <header
      ref={barRef}
      className="border-line bg-surface-1/80 sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur"
    >
      {/* Project switcher — the fix for six screens silently using projects[0]. */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(open === 'project' ? null : 'project')}
          aria-haspopup="menu"
          aria-expanded={open === 'project'}
          className="text-body-sm hover:bg-surface-2 text-ink flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors"
        >
          <span className="truncate font-medium">{project?.name ?? 'No project'}</span>
          <Chevron />
        </button>
        {open === 'project' && (
          <Menu>
            {projects.length === 0 && (
              <p className="text-ink-faint text-micro px-3 py-2">No projects yet.</p>
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
              <MenuItem onClick={() => router.push('/onboarding')}>+ Add app</MenuItem>
            </div>
          </Menu>
        )}
      </div>

      {crumb && (
        <>
          <span className="text-ink-faint" aria-hidden="true">
            /
          </span>
          <span className="text-body-sm text-ink-dim truncate">{crumb}</span>
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen(open === 'account' ? null : 'account')}
          aria-haspopup="menu"
          aria-expanded={open === 'account'}
          aria-label="Account"
          className="hover:bg-surface-2 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors"
        >
          <span className="bg-accent/20 text-accent text-meta flex h-6 w-6 items-center justify-center rounded-full font-semibold">
            {(me?.user?.name || me?.user?.email || '?').slice(0, 1).toUpperCase()}
          </span>
        </button>
        {open === 'account' && (
          <Menu align="right">
            <div className="border-line border-b px-3 py-2">
              <p className="text-body-sm truncate">{me?.user?.name ?? me?.user?.email ?? '—'}</p>
              {me?.user?.name && (
                <p className="text-ink-faint text-micro truncate">{me.user.email}</p>
              )}
              {activeOrg && (
                <p className="text-ink-faint text-micro mt-1 truncate">
                  {activeOrg.name} · {activeOrg.plan.toLowerCase()}
                </p>
              )}
            </div>

            {/* Org switcher — /auth/switch-org has existed with no UI. */}
            {(me?.orgs.length ?? 0) > 1 && (
              <div className="border-line border-b py-1">
                <p className="text-ink-faint text-meta px-3 py-1 tracking-wider uppercase">
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
              <MenuItem onClick={() => router.push(SETTINGS_ITEM.href)}>Settings</MenuItem>
              {/* Billing was unreachable from anywhere in the UI. */}
              <MenuItem onClick={() => router.push('/settings/billing')}>Billing</MenuItem>
              <MenuItem onClick={() => void signOut()}>Sign out</MenuItem>
            </div>
          </Menu>
        )}
      </div>
    </header>
  );
}

/** The current screen's name, from the nav that already defines it. */
function crumbFor(pathname: string): string | null {
  if (pathname.startsWith('/runs/')) return 'Run';
  if (pathname.startsWith('/projects/') && pathname.endsWith('/plan')) return 'Test plan';
  if (pathname.startsWith('/settings/billing')) return 'Billing';
  const item = [...NAV, SETTINGS_ITEM].find((n) => n.href === pathname);
  return item?.label ?? null;
}

function Menu({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <div
      role="menu"
      className={cn(
        'border-line-strong bg-surface-1 absolute top-full z-40 mt-1 max-h-80 w-60 overflow-y-auto rounded-lg border py-1 shadow-[var(--shadow-overlay)]',
        align === 'right' ? 'right-0' : 'left-0',
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

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
