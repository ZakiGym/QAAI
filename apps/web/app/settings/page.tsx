'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { API_URL, api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import {
  Badge,
  Page,
  PageHeader,
  SectionLabel,
  Skeleton,
  SkeletonRows,
} from '../../components/ui/layout';
import { SECTION_TABS_SLOT_ID } from '../../components/shell/AppShell';

/** The shape of GET /auth/me — declared here since it is settings-specific. */
interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
}

interface Me {
  user: { id: string; email: string; name: string | null } | null;
  activeOrgId: string;
  orgs: Org[];
}

/*
 * The tabs are the URL now.
 *
 * The strip itself belongs to the shell (SETTINGS_ITEM.tabs in nav.ts) and is
 * portalled into the slot below the title, so every view here is a real address:
 * /settings?tab=members can be pasted into Slack, bookmarked, and reached with
 * Back. It used to be `useState`, which meant five screens shared one URL and
 * the browser's own history buttons did nothing on any of them.
 *
 * 'account' is the personal tab; every other tab is about the ORGANISATION. It
 * exists because POST /auth/password/change shipped with no caller: the endpoint
 * worked, and a signed-in person had nowhere in the entire product to change
 * their password — the only route to a new one was to sign out and use the
 * forgot-password email.
 *
 * Billing is the one view that is a route rather than a query param, because it
 * comes back from Stripe with `?pending=1` and has to survive a full page load.
 * The old 'usage' and 'audit' tabs are gone from the strip: both are readings of
 * this organisation, and they now sit under Organization where somebody looking
 * for "what has this org been doing" will actually find them.
 */
const TABS = ['organization', 'members', 'apiKeys', 'account'] as const;
type Tab = (typeof TABS)[number];

/** Anything unrecognised is the first tab — a bad ?tab= must not blank the page. */
function tabFrom(param: string | null): Tab {
  return (TABS as readonly string[]).includes(param ?? '') ? (param as Tab) : 'organization';
}

/**
 * The frame: the title, the tab slot, and whoever is signed in.
 *
 * Everything that reads `?tab=` sits inside the Suspense boundary below, and
 * nothing else does. Two reasons, both of which have bitten this repo: `next
 * build` refuses to prerender a page that calls `useSearchParams()` with no
 * boundary above it, and the shell resolves its tab slot with a single
 * `getElementById` — so a slot rendered inside a fallback is a *different* DOM
 * node from the one rendered after it resolves, and the strip would end up
 * portalled into a detached element.
 */
export default function SettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Me>('/auth/me');
      setMe(data);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load settings');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeOrg = me?.orgs.find((org) => org.id === me.activeOrgId) ?? null;

  return (
    <Page width="settings">
      <PageHeader
        // A non-breaking space while the org name is in flight: the eyebrow is
        // one line tall either way, so the title does not jump when it lands.
        eyebrow={activeOrg ? `${activeOrg.name} · Settings` : ' '}
        title="Settings"
      />

      {/* The shell portals the section strip in here, under the title. */}
      <div id={SECTION_TABS_SLOT_ID} />

      <div className="mt-[26px]">
        {error && <ErrorNote>{error}</ErrorNote>}

        {!me ? (
          <SkeletonRows rows={4} />
        ) : (
          <Suspense fallback={<SkeletonRows rows={4} />}>
            <SettingsTab me={me} activeOrg={activeOrg} />
          </Suspense>
        )}
      </div>
    </Page>
  );
}

function SettingsTab({ me, activeOrg }: { me: Me; activeOrg: Org | null }) {
  const tab = tabFrom(useSearchParams().get('tab'));

  if (tab === 'members') return <MembersTab me={me} activeOrg={activeOrg} />;
  if (tab === 'apiKeys') return <ApiKeysTab />;
  if (tab === 'account') return <AccountTab me={me} />;
  return <OrganizationTab org={activeOrg} />;
}

/* ─── Shared bits ─────────────────────────────────────────────────────────── */

/**
 * A failure, said in place rather than in a toast that has already gone by the
 * time you look up. 8% of fail against the page, not a solid slab — the sentence
 * is the message; the colour is only there to say which kind of message it is.
 */
function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="border-fail/40 bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] text-fail text-body-sm mb-4 rounded-md border px-3 py-2"
    >
      {children}
    </p>
  );
}

/** The label/value grid. Mono uppercase slot name, value in whatever it is. */
function DefGrid({
  labelWidth = 140,
  className,
  children,
}: {
  labelWidth?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <dl
      className={cn('text-body-sm grid items-baseline gap-x-5 gap-y-3.5', className)}
      style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` }}
    >
      {children}
    </dl>
  );
}

function Def({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-meta text-ink-faint font-mono tracking-[0.08em] uppercase">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** A quiet destructive verb. The weight belongs on the confirmation, not here. */
function RowLink({
  children,
  onClick,
  disabled,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'text-micro text-ink-faint shrink-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        danger ? 'hover:text-fail' : 'hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

const ROW_SELECT =
  'border-line text-ink-dim text-micro focus:border-accent rounded-sm border bg-transparent px-1.5 py-1 outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const FORM_SELECT =
  'border-line text-ink-dim text-row-sub focus:border-accent shrink-0 rounded-md border bg-transparent px-2 py-2 outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/**
 * 26px initial. Decorative — the name it stands for is on the same row, so a
 * screen reader that announced the letter too would just be repeating itself.
 */
function Avatar({ label, tone }: { label: string; tone: 'accent' | 'neutral' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
        tone === 'accent'
          ? 'bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-accent'
          : 'bg-surface-2 text-ink-dim',
      )}
    >
      {label}
    </span>
  );
}

/* ─── Organization ────────────────────────────────────────────────────────── */

interface PlanRow {
  label: string;
  monthlyPriceUsd: number | null;
  maxProjects: number;
  maxRunsPerMonth: number | null;
}

interface BillingLite {
  paying: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  limits: PlanRow;
  usage: { runsThisMonth: number; projects: number };
}

interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface AgentSpend {
  days: number;
  totalCalls: number;
  totalCostCents: number;
  /** QAAI_MONTHLY_TOKEN_BUDGET on the API; 0 means no ceiling is set. */
  monthlyTokenBudget: number;
  tokensThisMonth: number;
  byAgent: Array<{
    agent: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    failures: number;
  }>;
}

/**
 * The organisation, its ceilings, and what it has done.
 *
 * The usage bars read the same `GET /billing` payload the billing page does,
 * rather than a count of anything this page could compute — a limit shown here
 * that disagrees with the one the API enforces is worse than no limit at all.
 */
function OrganizationTab({ org }: { org: Org | null }) {
  const [billing, setBilling] = useState<BillingLite | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);

  useEffect(() => {
    void api<BillingLite>('/billing')
      .then((data) => {
        setBilling(data);
        setBillingError(null);
      })
      .catch((err: unknown) =>
        setBillingError(err instanceof Error ? err.message : 'Could not load usage'),
      );
  }, []);

  if (!org) {
    return <p className="text-ink-faint text-body-sm">No active organization.</p>;
  }

  const renewal =
    billing?.currentPeriodEnd && billing.paying
      ? `${billing.cancelAtPeriodEnd ? 'ends' : 'renews'} ${new Date(
          billing.currentPeriodEnd,
        ).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : null;

  return (
    <div>
      <DefGrid>
        <Def label="Name">{org.name}</Def>
        <Def label="Slug">
          <span className="font-mono text-[12px]">{org.slug}</span>
        </Def>
        <Def label="Plan">
          {billing?.limits.label ?? org.plan.toLowerCase()}
          {renewal && ` · ${renewal}`} ·{' '}
          <Link href="/settings/billing" className="text-accent text-[12.5px] hover:underline">
            billing →
          </Link>
        </Def>
        <Def label="Your role">
          <span className="font-mono text-[12px]">{org.role.toLowerCase()}</span>
        </Def>
      </DefGrid>

      <section className="mt-[30px]">
        <SectionLabel>Usage · this month</SectionLabel>
        {billingError ? (
          <ErrorNote>{billingError}</ErrorNote>
        ) : !billing ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            <UsageBar
              label="Runs"
              used={billing.usage.runsThisMonth}
              cap={billing.limits.maxRunsPerMonth}
            />
            <UsageBar
              label="Projects"
              used={billing.usage.projects}
              cap={billing.limits.maxProjects}
            />
          </div>
        )}
      </section>

      <AgentSpendSection />
      <AuditSection canRead={org.role === 'OWNER' || org.role === 'ADMIN'} />
    </div>
  );
}

/**
 * A ceiling you are approaching, or a number with no ceiling.
 *
 * `> 1000` counts as unlimited because that is how the catalogue expresses it —
 * Enterprise's project cap is MAX_SAFE_INTEGER, and "4 / 9007199254740991" is
 * not a sentence anybody can read.
 */
function UsageBar({ label, used, cap }: { label: string; used: number; cap: number | null }) {
  const unlimited = cap === null || cap > 1000;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, cap)) * 100));
  // Only alarms when there is something to be alarmed about.
  const tone = pct >= 100 ? 'bg-fail' : pct >= 80 ? 'bg-flake' : 'bg-accent';

  return (
    <div>
      <p className="text-meta text-ink-faint mb-1.5 flex justify-between font-mono">
        <span className="tracking-[0.08em] uppercase">{label}</span>
        <span className="text-ink tabular-nums">
          {used.toLocaleString()} / {unlimited ? 'unlimited' : cap.toLocaleString()}
        </span>
      </p>
      <span className="bg-surface-2 block h-1 overflow-hidden rounded-full">
        <span className={cn('block h-full', tone)} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

/**
 * What the model has cost.
 *
 * Every agent call has always recorded its tokens and its price and none of it
 * was visible, which is a poor property for a product that bills partly on model
 * usage. It reads as usage rather than as billing, so it sits under the usage
 * bars instead of on the billing page.
 */
function AgentSpendSection() {
  const [spend, setSpend] = useState<AgentSpend | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api<AgentSpend>('/settings/usage')
      .then(setSpend)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <section className="mt-[30px]">
      <SectionLabel>{spend ? `Model spend · last ${spend.days} days` : 'Model spend'}</SectionLabel>
      {/* The ceiling, only when one is set — the same numbers the API's budget gate compares. */}
      {spend && spend.monthlyTokenBudget > 0 && (
        <p className="text-ink-faint text-micro mb-1.5 font-mono tabular-nums">
          budget: {spend.tokensThisMonth.toLocaleString()} of{' '}
          {spend.monthlyTokenBudget.toLocaleString()} tokens used this month
          (QAAI_MONTHLY_TOKEN_BUDGET)
        </p>
      )}
      {!spend ? (
        <SkeletonRows rows={2} />
      ) : spend.byAgent.length === 0 ? (
        <p className="text-ink-dim text-body-sm">
          No model calls yet. Once the agent explores or writes tests, every call and its cost is
          itemised here.
        </p>
      ) : (
        <>
          <p className="text-ink-dim text-body-sm">
            {money(spend.totalCostCents)} across {spend.totalCalls.toLocaleString()} calls.
          </p>
          <div className="mt-2.5">
            {spend.byAgent.map((row) => (
              <div
                key={row.agent}
                className="border-line hover:bg-surface-1/60 flex items-baseline gap-3 border-b py-[11px] transition-colors"
              >
                <span className="text-row w-24 shrink-0">{row.agent.toLowerCase()}</span>
                <span className="text-ink-faint text-meta min-w-0 flex-1 font-mono tabular-nums">
                  {row.calls.toLocaleString()} calls · {(row.inputTokens / 1000).toFixed(1)}k in /{' '}
                  {(row.outputTokens / 1000).toFixed(1)}k out
                  {row.failures > 0 && (
                    <span className="text-flake"> · {row.failures} failed</span>
                  )}
                </span>
                <span className="text-row-sub shrink-0 font-mono tabular-nums">
                  {money(row.costCents)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** `21:52` for today, `Aug 3 21:52` before that. A bare time lies about a week-old row. */
function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const time = at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * The audit trail. Recorded since the first commit, never once readable — which
 * makes an audit log a compliance checkbox rather than a tool.
 *
 * ADMIN-only on the server, so a member is told that rather than shown a 403.
 * The CSV is a plain link to the API's own `?format=csv` — the session cookie is
 * SameSite=Lax, so a top-level navigation carries it, and the browser gets to do
 * the download rather than this page rebuilding one out of JSON.
 */
function AuditSection({ canRead }: { canRead: boolean }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!canRead) return;
    void api<{ entries: AuditEntry[] }>('/settings/audit')
      .then((data) => setEntries(data.entries))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not load the audit log'),
      );
  }, [canRead]);

  const shown = (entries ?? []).filter(
    (entry) =>
      !filter ||
      entry.action.includes(filter.toLowerCase()) ||
      entry.actor.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <section className="mt-[30px]">
      <SectionLabel>Audit log</SectionLabel>
      <p className="text-ink-dim text-body-sm">
        Append-only, secret-masked. Every review, override, heal and push is a row.
      </p>

      {!canRead ? (
        <p className="text-ink-faint text-micro mt-2.5">
          Reading it needs the admin or owner role — it names who did what.
        </p>
      ) : error ? (
        <div className="mt-2.5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : entries === null ? (
        <div className="mt-2.5">
          <SkeletonRows rows={3} />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-ink-faint text-micro mt-2.5">
          Nothing recorded yet. Invites, role changes, verdict overrides and heals land here as they
          happen.
        </p>
      ) : (
        <>
          <div className="mt-3 max-w-[280px]">
            <Field
              aria-label="Filter the audit log by action or person"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by action or person…"
            />
          </div>
          <div className="text-meta text-ink-faint mt-2.5 max-h-[280px] overflow-y-auto font-mono leading-[2]">
            {shown.map((entry) => (
              <p key={entry.id} className="truncate">
                <span className="tabular-nums">{stamp(entry.createdAt)}</span> {entry.actor}{' '}
                <span className="text-ink-dim">{entry.action}</span>
                {entry.targetId && ` ${entry.targetType.toLowerCase()}:${entry.targetId}`}
              </p>
            ))}
            {shown.length === 0 && <p>Nothing matches “{filter}”.</p>}
          </div>
        </>
      )}

      {canRead && (
        <p className="mt-2.5">
          <a
            href={`${API_URL}/settings/audit?format=csv`}
            className="text-accent text-[12px] hover:underline"
          >
            export CSV →
          </a>
        </p>
      )}
    </section>
  );
}

/* ─── Members ─────────────────────────────────────────────────────────────── */

interface Member {
  userId: string;
  role: string;
  name: string;
  email: string;
  joinedAt: string;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * What actually happened to the email, straight from POST /settings/invites.
 *
 * Only `smtp` means a message left the building. `console` means this
 * deployment has no mail server and the link went to the API log; `failed`
 * means the send threw. Both leave a working invite that somebody has to
 * deliver by hand, and saying "invite sent" for either is the lie this screen
 * used to tell in the other direction.
 */
type Delivery = 'smtp' | 'console' | 'failed';

/**
 * Kept in sync with ORG_ROLES in @qaai/shared. Duplicated as a plain tuple
 * rather than imported because nothing else in the web app pulls from the
 * shared package, and one constant is not worth the dependency.
 */
const ORG_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
type OrgRole = (typeof ORG_ROLES)[number];

const nameOf = (member: Member) => member.name || member.email;

/** ApiError carries the server's own sentence — the readable one is the point. */
const reasonFor = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/**
 * Invites expire, and GET /settings/invites returns the expired ones too — they
 * are unaccepted, which is all that query asks. An expired row that reads like a
 * live one sends an admin off to chase a link that cannot work.
 */
function expiryPhrase(iso: string): { text: string; expired: boolean } {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return { text: 'expiry unknown', expired: false };
  if (ms <= 0) return { text: 'expired', expired: true };
  // A date beyond a day out, a countdown inside one. Rounding a 7-day link to
  // "6 days" reads as a bug, and rounding it up would promise time it does not
  // have; the date is the only phrasing that is never off by one.
  if (ms >= 86_400_000) {
    const on = new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { text: `expires ${on}`, expired: false };
  }
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return { text: `expires in ${hours} hour${hours === 1 ? '' : 's'}`, expired: false };
}

function MembersTab({ me, activeOrg }: { me: Me; activeOrg: Org | null }) {
  const router = useRouter();
  const toast = useToast();

  /*
   * Every mutation on this tab — invite, revoke, role change, remove — is
   * requireRole('ADMIN') on the server. The current role is already on screen,
   * so rendering controls that are certain to 403 only teaches people that the
   * product argues with them. The *rules* stay server-side: the last-OWNER
   * guard is not reimplemented here, because a control this page disabled that
   * the server would have allowed is its own bug.
   */
  const canManage = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN';

  /*
   * OWNER is the one exception to "the rules stay server-side". It is not a
   * guard whose answer the page would have to guess — it is a flat refusal that
   * depends only on the viewer's own role, which is already on screen, and both
   * POST /settings/invites and PATCH /settings/members/:userId now reject it the
   * same way. Offering an ADMIN a choice that always comes back "Only an owner
   * can make someone else an owner" reads as a broken product, and offering it
   * at all was how the escalation looked legitimate.
   */
  const canGrantOwner = activeOrg?.role === 'OWNER';
  const inviteRoleOptions = canGrantOwner ? ORG_ROLES : ORG_ROLES.filter((r) => r !== 'OWNER');

  const [members, setMembers] = useState<Member[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [busyMember, setBusyMember] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<Member | null>(null);
  const [removing, setRemoving] = useState(false);

  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<Invite | null>(null);
  const [revoking, setRevoking] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('MEMBER');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // The link is returned exactly once. It stays on screen until dismissed so an
  // admin who wants to send it themselves is never racing a toast.
  const [minted, setMinted] = useState<{
    email: string;
    role: string;
    acceptUrl: string;
    delivery: Delivery;
    expiresAt: string;
  } | null>(null);

  const loadMembers = useCallback(async () => {
    try {
      const data = await api<{ members: Member[] }>('/settings/members');
      setMembers(data.members);
      setMembersError(null);
    } catch (err) {
      // This used to fall back to a fabricated row for the current user, which
      // answers "who is in this org" with "only you" — a wrong answer, not a
      // missing one.
      setMembersError(reasonFor(err, 'Could not load the members list'));
    }
  }, []);

  const loadInvites = useCallback(async () => {
    if (!canManage) return;
    try {
      const data = await api<{ invites: Invite[] }>('/settings/invites');
      setInvites(data.invites);
      setInvitesError(null);
    } catch (err) {
      setInvitesError(reasonFor(err, 'Could not load pending invitations'));
    }
  }, [canManage]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Invite link copied');
    } catch {
      // The clipboard is unavailable outside a secure context. The link is on
      // screen and selectable, so say that rather than fail silently.
      toast.error('Could not reach the clipboard — select the link and copy it by hand.');
    }
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email || inviting) return;
    setInviting(true);
    setInviteError(null);
    try {
      const result = await api<{
        invite: Invite;
        acceptUrl: string;
        delivery: Delivery;
      }>('/settings/invites', {
        method: 'POST',
        body: JSON.stringify({ email, role: inviteRole }),
      });
      setMinted({
        email: result.invite.email,
        role: result.invite.role,
        acceptUrl: result.acceptUrl,
        delivery: result.delivery,
        expiresAt: result.invite.expiresAt,
      });
      setInviteEmail('');
      await loadInvites();
    } catch (err) {
      setInviteError(reasonFor(err, 'Could not create the invitation'));
    } finally {
      setInviting(false);
    }
  }

  /*
   * Optimistic, because a select that snaps back to its old value while a
   * request is in flight reads as a rejected choice. The rollback below is the
   * price: on failure the row returns to the role the server still holds, and
   * the server's sentence — "This is the only owner…" — is what gets shown.
   */
  async function changeRole(member: Member, role: OrgRole) {
    const previous = member.role;
    if (previous === role) return;
    setBusyMember(member.userId);
    setMembersError(null);
    setMembers((current) =>
      current?.map((m) => (m.userId === member.userId ? { ...m, role } : m)) ?? current,
    );
    try {
      await api(`/settings/members/${member.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
    } catch (err) {
      setMembers((current) =>
        current?.map((m) => (m.userId === member.userId ? { ...m, role: previous } : m)) ?? current,
      );
      setMembersError(reasonFor(err, `Could not change ${nameOf(member)}'s role`));
    } finally {
      setBusyMember(null);
    }
  }

  /*
   * Not optimistic: a row that disappears and then reappears with an error is a
   * worse account of a destructive action than a spinner in the dialog, and the
   * dialog's busy state already makes the button unpressable twice.
   */
  async function removeMember(member: Member) {
    setRemoving(true);
    setMembersError(null);
    try {
      await api(`/settings/members/${member.userId}`, { method: 'DELETE' });
      setPendingRemove(null);
      if (member.userId === me.user?.id) {
        // The server revokes this user's sessions for this org, so every
        // request from here is a 401. Leaving them on a dead page is worse than
        // sending them somewhere that works.
        router.push('/login');
        return;
      }
      setMembers((current) => current?.filter((m) => m.userId !== member.userId) ?? current);
    } catch (err) {
      setPendingRemove(null);
      setMembersError(reasonFor(err, `Could not remove ${nameOf(member)}`));
    } finally {
      setRemoving(false);
    }
  }

  async function revokeInvite(invite: Invite) {
    setRevoking(true);
    setInvitesError(null);
    try {
      await api(`/settings/invites/${invite.id}`, { method: 'DELETE' });
      setInvites((current) => current?.filter((i) => i.id !== invite.id) ?? current);
      setPendingRevoke(null);
      // The link on screen is this invite's; leaving it up would hand out a
      // token that no longer opens anything.
      setMinted((current) => (current?.email === invite.email ? null : current));
    } catch (err) {
      setPendingRevoke(null);
      setInvitesError(reasonFor(err, `Could not revoke the invitation for ${invite.email}`));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="space-y-9">
      <section>
        {membersError && <ErrorNote>{membersError}</ErrorNote>}

        {members === null ? (
          // A failed load already said so above; an empty list under the message
          // would read as "nobody is here", which is not what we know.
          !membersError && <SkeletonRows rows={3} />
        ) : (
          <div>
            {members.map((member) => {
              const you = member.userId === me.user?.id;
              return (
                <div
                  key={member.userId}
                  className="border-line hover:bg-surface-1/60 flex items-center gap-3 border-b py-[11px] transition-colors"
                >
                  <Avatar
                    label={nameOf(member).trim().charAt(0).toUpperCase()}
                    tone={you ? 'accent' : 'neutral'}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-row block truncate">{nameOf(member)}</span>
                    {member.name && (
                      <span className="text-ink-faint text-meta block truncate font-mono">
                        {member.email}
                      </span>
                    )}
                  </span>
                  {you && <Badge tone="accent">you</Badge>}
                  {canManage ? (
                    <select
                      aria-label={`Role for ${nameOf(member)}`}
                      value={member.role}
                      onChange={(e) => void changeRole(member, e.target.value as OrgRole)}
                      disabled={busyMember === member.userId}
                      className={ROW_SELECT}
                    >
                      {ORG_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role.charAt(0) + role.slice(1).toLowerCase()}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-ink-faint text-meta shrink-0 font-mono tracking-[0.05em]">
                      {member.role}
                    </span>
                  )}
                  {canManage && (
                    <RowLink
                      danger
                      onClick={() => setPendingRemove(member)}
                      disabled={busyMember === member.userId}
                    >
                      remove
                    </RowLink>
                  )}
                </div>
              );
            })}
            {members.length === 0 && (
              <p className="text-ink-faint text-body-sm py-6 text-center">
                Nobody is in this organisation yet.
              </p>
            )}
          </div>
        )}

        {canManage ? (
          <>
            <form onSubmit={sendInvite} className="mt-4 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Field
                  type="email"
                  aria-label="Email address to invite"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.dev"
                  autoComplete="off"
                />
              </div>
              <select
                aria-label="Role for the invited person"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                disabled={inviting}
                className={FORM_SELECT}
              >
                {inviteRoleOptions.map((role) => (
                  <option key={role} value={role}>
                    {role.charAt(0) + role.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
              <Button
                type="submit"
                variant="primary"
                loading={inviting}
                disabled={!inviteEmail.trim()}
              >
                Invite
              </Button>
            </form>

            {inviteError && (
              <p role="alert" className="text-fail text-micro mt-2">
                {inviteError}
              </p>
            )}

            {minted && (
              <div
                className={cn(
                  'mt-4 rounded-lg border p-4',
                  minted.delivery === 'smtp'
                    ? 'border-accent/40 bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]'
                    : 'border-flake/40 bg-[color-mix(in_srgb,var(--color-flake)_8%,transparent)]',
                )}
              >
                <p className="text-row font-medium">
                  {minted.delivery === 'smtp'
                    ? `Invitation emailed to ${minted.email}`
                    : `Invitation created for ${minted.email} — nothing was emailed`}
                </p>
                <p className="text-ink-dim text-body-sm mt-1 leading-relaxed">
                  {minted.delivery === 'smtp'
                    ? `They can join as ${minted.role.toLowerCase()} with the link below — the same one in their inbox.`
                    : minted.delivery === 'console'
                      ? 'This deployment has no mail server, so the link went to the API log instead. Send it to them yourself.'
                      : 'The email did not send. The invitation is saved either way — send the link to them yourself.'}{' '}
                  This link {expiryPhrase(minted.expiresAt).text}.
                </p>
                <code className="border-line bg-surface text-meta mt-3 block overflow-x-auto rounded-sm border px-3 py-2 font-mono">
                  {minted.acceptUrl}
                </code>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void copyLink(minted.acceptUrl)}
                  >
                    Copy link
                  </Button>
                  <Button size="sm" onClick={() => setMinted(null)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-ink-faint text-micro mt-3">
            Inviting people and changing roles needs the admin or owner role.
          </p>
        )}
      </section>

      {canManage && (
        <section>
          <SectionLabel>Pending invitations</SectionLabel>

          {invitesError && <ErrorNote>{invitesError}</ErrorNote>}

          {invites === null ? (
            !invitesError && <SkeletonRows rows={2} />
          ) : invites.length === 0 ? (
            <p className="text-ink-faint text-body-sm">
              No invitations waiting. Invited people appear here until they sign up.
            </p>
          ) : (
            <div>
              {invites.map((invite) => {
                const expiry = expiryPhrase(invite.expiresAt);
                return (
                  <div
                    key={invite.id}
                    className="border-line hover:bg-surface-1/60 flex items-center gap-3 border-b py-[11px] transition-colors"
                  >
                    <span className="text-row min-w-0 flex-1 truncate">{invite.email}</span>
                    <span className="text-ink-faint text-meta shrink-0 font-mono tracking-[0.05em]">
                      {invite.role}
                    </span>
                    <span
                      className={cn(
                        'text-meta shrink-0 font-mono',
                        expiry.expired ? 'text-fail' : 'text-ink-faint',
                      )}
                    >
                      {expiry.text}
                    </span>
                    <RowLink danger onClick={() => setPendingRevoke(invite)} disabled={revoking}>
                      revoke
                    </RowLink>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section>
        <SectionLabel>Your organizations</SectionLabel>
        <div>
          {me.orgs.map((org) => (
            <div
              key={org.id}
              className="border-line flex items-center gap-3 border-b py-[11px] last:border-b-0"
            >
              <span className="text-row min-w-0 flex-1 truncate">{org.name}</span>
              {org.id === me.activeOrgId && <Badge tone="accent">active</Badge>}
              <span className="text-ink-faint text-meta shrink-0 font-mono">
                {org.plan.toLowerCase()} · {org.role.toLowerCase()}
              </span>
            </div>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) void removeMember(pendingRemove);
        }}
        title={pendingRemove ? `Remove ${nameOf(pendingRemove)}?` : 'Remove this member?'}
        body={
          pendingRemove?.userId === me.user?.id
            ? `You lose access to ${activeOrg?.name ?? 'this organisation'} immediately and are signed out of it. Your account and everything you created stay.`
            : `${pendingRemove ? nameOf(pendingRemove) : 'They'} loses access to ${
                activeOrg?.name ?? 'this organisation'
              } immediately and any session they have here is ended. Their account and everything they created stay.`
        }
        confirmLabel="Remove member"
        busy={removing}
      />

      <ConfirmDialog
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) void revokeInvite(pendingRevoke);
        }}
        title="Revoke this invitation?"
        body={`The link sent to ${pendingRevoke?.email ?? 'this address'} stops working. You can invite them again at any time.`}
        confirmLabel="Revoke invite"
        busy={revoking}
      />
    </div>
  );
}

/* ─── API keys ────────────────────────────────────────────────────────────── */

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** How long since it was last used, or the honest answer that it never was. */
function lastUsedPhrase(iso: string | null): string {
  if (!iso) return 'never used';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'never used';
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `last used ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `last used ${hours}h ago`;
  return `last used ${Math.round(hours / 24)}d ago`;
}

/**
 * API keys. The full secret is shown exactly once, right after creation — the
 * server only stores its hash, so there is no way to reveal it again. The UI
 * reflects that honestly: a one-time banner, then only the prefix forever.
 */
function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The key awaiting confirmation. Held as the whole record so the dialog can
  // name it — a confirm that does not say what it is about is a coin flip.
  const [pendingRevoke, setPendingRevoke] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    const data = await api<{ keys: ApiKey[] }>('/settings/api-keys').catch(() => ({ keys: [] }));
    setKeys(data.keys);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { key } = await api<{ key: { secret: string } }>('/settings/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setFreshSecret(key.secret);
      setName('');
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the key');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(true);
    try {
      await api(`/settings/api-keys/${id}`, { method: 'DELETE' }).catch(() => {});
      await load();
      setPendingRevoke(null);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div>
      {freshSecret && (
        <div className="border-accent/40 bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] mb-5 rounded-lg border p-4">
          <p className="text-row font-medium">Copy this key now — it is never shown again.</p>
          <code className="border-line bg-surface text-meta mt-2 block overflow-x-auto rounded-sm border px-3 py-2 font-mono">
            {freshSecret}
          </code>
          <Button
            variant="primary"
            size="sm"
            className="mt-3"
            onClick={() => {
              void navigator.clipboard.writeText(freshSecret);
              setFreshSecret(null);
            }}
          >
            Copy and dismiss
          </Button>
        </div>
      )}

      {keys === null ? (
        <SkeletonRows rows={2} />
      ) : keys.length === 0 ? (
        <p className="text-ink-dim text-body-sm">
          No API keys. Create one to run QAAI from your own CI, or to drive it from a script.
        </p>
      ) : (
        <div>
          {keys.map((key) => (
            <div
              key={key.id}
              className="border-line hover:bg-surface-1/60 flex items-baseline gap-3 border-b py-[11px] transition-colors"
            >
              <span className="text-row w-[110px] shrink-0 truncate">{key.name}</span>
              <span className="text-ink-dim text-row-sub min-w-0 flex-1 truncate font-mono">
                {key.keyPrefix}
                {'•••••••'}
              </span>
              <span className="text-ink-faint text-meta shrink-0 font-mono">
                created {shortDate(key.createdAt)} · {lastUsedPhrase(key.lastUsedAt)}
                {key.scopes.length > 0 && ` · ${key.scopes.join(' ')}`}
              </span>
              <RowLink danger onClick={() => setPendingRevoke(key)}>
                revoke
              </RowLink>
            </div>
          ))}
        </div>
      )}

      {creating ? (
        <form onSubmit={create} className="mt-4 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Field
              autoFocus
              aria-label="API key name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. github-ci"
            />
          </div>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            Create
          </Button>
          <Button
            onClick={() => {
              setCreating(false);
              setName('');
              setError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <p className="mt-4">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="text-accent text-[12px] hover:underline"
          >
            + new key
          </button>
          <span className="text-ink-faint text-meta font-mono">
            {' '}
            · shown once — the server keeps only its hash
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="text-fail text-micro mt-2">
          {error}
        </p>
      )}

      <p className="text-ink-faint text-micro mt-5">
        Use a key with the CLI: <code className="font-mono">QAAI_API_KEY=… qaai run --env …</code>.
        See docs/ci.md.
      </p>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) void revoke(pendingRevoke.id);
        }}
        title={pendingRevoke ? `Revoke ${pendingRevoke.name}?` : 'Revoke this key?'}
        body="Anything using it will stop working immediately."
        confirmLabel="Revoke key"
        busy={revoking}
      />
    </div>
  );
}

/* ─── Account ─────────────────────────────────────────────────────────────── */

/**
 * Your own account, as opposed to the organisation's.
 *
 * Changing a password requires the current one even though the caller already
 * holds a session — that is what stops a borrowed laptop from becoming
 * permanent ownership of the account, and the API enforces it regardless of
 * what this form does.
 */
function AccountTab({ me }: { me: Me }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Matches the API's own rule (packages/shared changePasswordSchema) so the
  // failure is shown before a round trip rather than after one.
  const tooShort = next.length > 0 && next.length < 12;
  const mismatch = confirm.length > 0 && confirm !== next;
  const ready = current.length > 0 && next.length >= 12 && confirm === next;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password/change', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      setCurrent('');
      setNext('');
      setConfirm('');
      // Said out loud because it is a real consequence the user should know
      // about before they walk to another machine and find it signed out.
      toast.success('Password changed. Every other session has been signed out.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[420px]">
      <DefGrid labelWidth={110} className="gap-y-3">
        {me.user?.name && <Def label="Name">{me.user.name}</Def>}
        <Def label="Email">
          <span className="font-mono text-[12px]">{me.user?.email ?? '—'}</span>
        </Def>
      </DefGrid>

      <form onSubmit={submit} className="mt-7">
        <SectionLabel>Change password</SectionLabel>

        <div className="flex flex-col gap-2">
          <Field
            type="password"
            aria-label="Current password"
            placeholder="current password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Field
            type="password"
            aria-label="New password"
            // The rule lives in the placeholder rather than a permanent hint
            // line: a hint between the second and third field breaks the stack
            // into two halves and reads as if it belonged to both.
            placeholder="new password — at least 12 characters"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            error={tooShort ? 'Use at least 12 characters.' : undefined}
          />
          <Field
            type="password"
            aria-label="Confirm the new password"
            placeholder="new password, again"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={mismatch ? 'These do not match.' : undefined}
          />
        </div>

        {error && (
          <p role="alert" className="text-fail text-body-sm mt-2.5">
            {error}
          </p>
        )}

        <p className="text-ink-faint text-micro mt-2.5 leading-relaxed">
          The current password is required even though you are signed in — a borrowed laptop must
          not become ownership. Changing it signs you out everywhere else; this tab stays signed in.
        </p>

        <Button type="submit" variant="primary" className="mt-3" disabled={!ready} loading={busy}>
          Update
        </Button>
      </form>
    </div>
  );
}
