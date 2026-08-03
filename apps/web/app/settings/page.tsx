'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { Badge, Page, PageHeader, SectionLabel, SkeletonRows, Tabs } from '../../components/ui/layout';

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
 * 'account' is the personal tab; every other tab on this screen is about the
 * ORGANISATION. It exists because POST /auth/password/change shipped with no
 * caller: the endpoint worked, and a signed-in person had nowhere in the entire
 * product to change their password — the only route to a new one was to sign
 * out and use the forgot-password email. That is this codebase's recurring
 * defect (correct code connected to nothing), committed in the same wave that
 * was fixing three other instances of it.
 */
type Tab = 'organization' | 'members' | 'apiKeys' | 'usage' | 'audit' | 'account';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'organization', label: 'Organization' },
  { id: 'members', label: 'Members' },
  { id: 'apiKeys', label: 'API keys' },
  { id: 'usage', label: 'Usage' },
  { id: 'audit', label: 'Audit log' },
  { id: 'account', label: 'Your account' },
];

export default function SettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('organization');

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
    <Page width="narrow">
      <PageHeader title="Settings" />

      {error && (
        <p
          role="alert"
          className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm"
        >
          {error}
        </p>
      )}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {!me ? (
        <p className="text-ink-faint text-sm">Loading…</p>
      ) : tab === 'organization' ? (
        <OrganizationTab org={activeOrg} />
      ) : tab === 'members' ? (
        <MembersTab me={me} activeOrg={activeOrg} />
      ) : tab === 'apiKeys' ? (
        <ApiKeysTab />
      ) : tab === 'usage' ? (
        <UsageTab />
      ) : tab === 'audit' ? (
        <AuditTab />
      ) : (
        <AccountTab me={me} />
      )}
    </Page>
  );
}

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
    <div className="space-y-6">
      <section className="border-line bg-surface-1 rounded-lg border p-5">
        <SectionLabel>Signed in as</SectionLabel>
        <p className="text-body-sm mt-1">{me.user?.name ?? me.user?.email ?? '—'}</p>
        {me.user?.name && <p className="text-ink-faint text-micro mt-0.5">{me.user.email}</p>}
      </section>

      <form onSubmit={submit} className="border-line bg-surface-1 rounded-lg border p-5">
        <SectionLabel>Change password</SectionLabel>

        <div className="mt-3 space-y-3">
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            hint="At least 12 characters."
            error={tooShort ? 'Use at least 12 characters.' : undefined}
          />
          <Field
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={mismatch ? 'These do not match.' : undefined}
          />
        </div>

        {error && (
          <p role="alert" className="text-fail mt-3 text-body-sm">
            {error}
          </p>
        )}

        <p className="text-ink-faint text-micro mt-3">
          Changing it signs you out everywhere else. This tab stays signed in.
        </p>

        <Button type="submit" variant="primary" className="mt-3" disabled={!ready} loading={busy}>
          Change password
        </Button>
      </form>
    </div>
  );
}

function OrganizationTab({ org }: { org: Org | null }) {
  if (!org) {
    return <p className="text-ink-faint text-sm">No active organization.</p>;
  }
  return (
    <section className="border-line bg-surface-1 rounded-lg border p-5">
      <dl className="space-y-4 text-sm">
        <div className="flex items-baseline justify-between">
          <dt className="text-ink-faint">Name</dt>
          <dd className="font-medium">{org.name}</dd>
        </div>
        <div className="flex items-baseline justify-between">
          <dt className="text-ink-faint">Slug</dt>
          <dd className="font-mono text-xs">{org.slug}</dd>
        </div>
        <div className="flex items-baseline justify-between">
          <dt className="text-ink-faint">Plan</dt>
          <dd className="font-mono text-xs">{org.plan.toLowerCase()}</dd>
        </div>
        <div className="flex items-baseline justify-between">
          <dt className="text-ink-faint">Your role</dt>
          <dd className="font-mono text-xs">{org.role.toLowerCase()}</dd>
        </div>
      </dl>
    </section>
  );
}

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

const SELECT_CLASS =
  'border-line bg-surface-1 text-body-sm focus:border-accent rounded-md border px-2.5 py-1.5 outline-none disabled:cursor-not-allowed disabled:opacity-50';

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
    <div className="space-y-8">
      {canManage && (
        <section>
          <SectionLabel>Invite a teammate</SectionLabel>

          <form onSubmit={sendInvite} className="flex items-start gap-2">
            <div className="flex-1">
              <Field
                type="email"
                aria-label="Email address to invite"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@example.com"
                autoComplete="off"
              />
            </div>
            <select
              aria-label="Role for the invited person"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as OrgRole)}
              disabled={inviting}
              className={SELECT_CLASS}
            >
              {ORG_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role.toLowerCase()}
                </option>
              ))}
            </select>
            <Button
              type="submit"
              variant="primary"
              loading={inviting}
              disabled={!inviteEmail.trim()}
            >
              Send invite
            </Button>
          </form>

          {inviteError && (
            <p role="alert" className="text-fail mt-2 text-xs">
              {inviteError}
            </p>
          )}

          {minted && (
            <div
              className={`mt-4 rounded-lg border p-4 ${
                minted.delivery === 'smtp'
                  ? 'border-accent/50 bg-accent/10'
                  : 'border-flake/40 bg-flake/10'
              }`}
            >
              <p className="text-sm font-medium">
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
              <code className="border-line bg-surface mt-3 block overflow-x-auto rounded border px-3 py-2 font-mono text-xs">
                {minted.acceptUrl}
              </code>
              <div className="mt-3 flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={() => void copyLink(minted.acceptUrl)}>
                  Copy link
                </Button>
                <Button size="sm" onClick={() => setMinted(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {canManage && (
        <section>
          <SectionLabel>Pending invitations</SectionLabel>

          {invitesError && (
            <p
              role="alert"
              className="border-fail/40 bg-fail/10 text-fail mb-3 rounded-md border p-3 text-sm"
            >
              {invitesError}
            </p>
          )}

          {invites === null ? (
            // A failed load already said so above; an empty box under the
            // message would read as "no invitations", which is not what we know.
            !invitesError && (
              <div className="border-line overflow-hidden rounded-lg border">
                <SkeletonRows rows={2} />
              </div>
            )
          ) : (
            <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
              {invites.map((invite) => {
                const expiry = expiryPhrase(invite.expiresAt);
                return (
                  <div key={invite.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="truncate text-sm font-medium">{invite.email}</span>
                    <Badge mono>{invite.role.toLowerCase()}</Badge>
                    <span
                      className={`ml-auto text-xs ${expiry.expired ? 'text-fail' : 'text-ink-faint'}`}
                    >
                      {expiry.text}
                    </span>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setPendingRevoke(invite)}
                      disabled={revoking}
                    >
                      Revoke
                    </Button>
                  </div>
                );
              })}
              {invites.length === 0 && (
                <p className="text-ink-faint px-4 py-6 text-center text-sm">
                  No invitations waiting. Invited people appear here until they sign up.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <section>
        <SectionLabel>{activeOrg ? `Members of ${activeOrg.name}` : 'Members'}</SectionLabel>

        {membersError && (
          <p
            role="alert"
            className="border-fail/40 bg-fail/10 text-fail mb-3 rounded-md border p-3 text-sm"
          >
            {membersError}
          </p>
        )}

        {members === null ? (
          !membersError && (
            <div className="border-line overflow-hidden rounded-lg border">
              <SkeletonRows rows={3} />
            </div>
          )
        ) : (
          <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
            {members.map((member) => (
              <div key={member.userId} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{nameOf(member)}</p>
                  {member.name && (
                    <p className="text-ink-faint truncate text-xs">{member.email}</p>
                  )}
                </div>
                {member.userId === me.user?.id && <Badge tone="accent">you</Badge>}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {canManage ? (
                    <select
                      aria-label={`Role for ${nameOf(member)}`}
                      value={member.role}
                      onChange={(e) => void changeRole(member, e.target.value as OrgRole)}
                      disabled={busyMember === member.userId}
                      className={SELECT_CLASS}
                    >
                      {ORG_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role.toLowerCase()}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Badge mono>{member.role.toLowerCase()}</Badge>
                  )}
                  {canManage && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setPendingRemove(member)}
                      disabled={busyMember === member.userId}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {members.length === 0 && (
              <p className="text-ink-faint px-4 py-6 text-center text-sm">
                Nobody is in this organisation yet.
              </p>
            )}
          </div>
        )}

        {!canManage && (
          <p className="text-ink-faint mt-2 text-xs">
            Inviting people and changing roles needs the admin or owner role.
          </p>
        )}
      </section>

      <section>
        <SectionLabel>Your organizations</SectionLabel>
        <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
          {me.orgs.map((org) => (
            <div key={org.id} className="flex items-center gap-4 px-4 py-3">
              <span className="text-sm">{org.name}</span>
              {org.id === me.activeOrgId && <span className="text-accent text-xs">active</span>}
              <span className="text-ink-faint ml-auto font-mono text-xs">
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

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * API keys (§1). The full secret is shown exactly once, right after creation —
 * the server only stores its hash, so there is no way to reveal it again. The
 * UI reflects that honestly: a one-time banner, then only the prefix forever.
 */
function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
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
    <div className="space-y-6">
      {freshSecret && (
        <div className="border-accent/50 bg-accent/10 rounded-lg border p-4">
          <p className="mb-2 text-sm font-medium">Copy this key now — it is never shown again.</p>
          <code className="border-line bg-surface block overflow-x-auto rounded border px-3 py-2 font-mono text-xs">
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

      <form onSubmit={create} className="flex items-start gap-2">
        <div className="flex-1">
          <Field
            aria-label="API key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. github-ci"
          />
        </div>
        <Button type="submit" variant="primary" loading={busy}>
          New key
        </Button>
      </form>
      {error && <p className="text-fail text-xs">{error}</p>}

      <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
        {keys.map((key) => (
          <div key={key.id} className="flex items-center gap-4 px-4 py-3">
            <span className="text-sm font-medium">{key.name}</span>
            <code className="text-ink-faint font-mono text-xs">{key.keyPrefix}…</code>
            <span className="text-ink-faint font-mono text-meta">{key.scopes.join(' ')}</span>
            <Button
              variant="danger"
              size="sm"
              className="ml-auto"
              onClick={() => setPendingRevoke(key)}
            >
              Revoke
            </Button>
          </div>
        ))}
        {keys.length === 0 && (
          <p className="text-ink-faint px-4 py-6 text-center text-sm">
            No API keys. Create one to run QAAI from your own CI, or to drive it from a script.
          </p>
        )}
      </div>

      <p className="text-ink-faint text-xs">
        Use a key with the CLI: <code className="font-mono">QAAI_API_KEY=… qaai run --env …</code>.
        See docs/ci.md.
      </p>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) void revoke(pendingRevoke.id);
        }}
        title="Revoke this key?"
        body="Anything using it will stop working immediately."
        confirmLabel="Revoke key"
        busy={revoking}
      />
    </div>
  );
}

/**
 * What the AI has cost. Every model call has always recorded its tokens and
 * price; none of it was visible, which is a poor property for a product that
 * bills partly on model usage.
 */
function UsageTab() {
  const [data, setData] = useState<{
    days: number;
    totalCalls: number;
    totalCostCents: number;
    byAgent: Array<{
      agent: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      costCents: number;
      failures: number;
    }>;
  } | null>(null);

  useEffect(() => {
    void api<typeof data>('/settings/usage')
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return <p className="text-ink-faint text-sm">Loading…</p>;

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-ink-faint text-xs">Last {data.days} days</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
            {money(data.totalCostCents)}
          </p>
        </div>
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-ink-faint text-xs">Model calls</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
            {data.totalCalls}
          </p>
        </div>
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-ink-faint text-xs">Failed calls</p>
          <p className="text-flake mt-1 text-2xl font-semibold tracking-tight tabular-nums">
            {data.byAgent.reduce((sum, a) => sum + a.failures, 0)}
          </p>
        </div>
      </div>

      <div className="border-line divide-line overflow-hidden rounded-lg border">
        {data.byAgent.map((row) => (
          <div key={row.agent} className="flex items-center gap-4 px-4 py-3">
            <span className="w-24 text-sm font-medium">{row.agent.toLowerCase()}</span>
            <span className="text-ink-faint text-xs tabular-nums">{row.calls} calls</span>
            <span className="text-ink-faint font-mono text-micro tabular-nums">
              {(row.inputTokens / 1000).toFixed(1)}k in / {(row.outputTokens / 1000).toFixed(1)}k out
            </span>
            {row.failures > 0 && (
              <span className="text-flake text-micro tabular-nums">{row.failures} failed</span>
            )}
            <span className="ml-auto font-mono text-sm tabular-nums">{money(row.costCents)}</span>
          </div>
        ))}
        {data.byAgent.length === 0 && (
          <p className="text-ink-faint px-4 py-6 text-center text-sm">
            No model calls yet. Once the agent explores or writes tests, every call and its cost is itemised here.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The audit trail. Recorded since the first commit, never once readable — which
 * makes an audit log a compliance checkbox rather than a tool.
 */
function AuditTab() {
  const [entries, setEntries] = useState<
    Array<{
      id: string;
      actor: string;
      action: string;
      targetType: string;
      targetId: string | null;
      metadata: Record<string, unknown> | null;
      ip: string | null;
      createdAt: string;
    }>
  >([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ entries: typeof entries }>('/settings/audit')
      .then((d) => setEntries(d.entries))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the audit log'));
  }, []);

  const shown = entries.filter(
    (e) =>
      !filter ||
      e.action.includes(filter) ||
      e.actor.toLowerCase().includes(filter.toLowerCase()),
  );

  if (error) return <p className="text-fail text-sm">{error}</p>;

  return (
    <div className="space-y-4">
      <Field
        aria-label="Filter by action or person…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by action or person…"
      />

      <div className="border-line divide-line max-h-[60vh] overflow-y-auto rounded-lg border">
        {shown.map((entry) => (
          <div key={entry.id} className="px-4 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-micro">{entry.action}</span>
              <span className="text-ink-faint text-xs">{entry.actor}</span>
              <span className="text-ink-faint ml-auto text-meta tabular-nums">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
            {entry.metadata && Object.keys(entry.metadata).length > 0 && (
              <p className="text-ink-faint mt-0.5 truncate font-mono text-meta">
                {JSON.stringify(entry.metadata)}
              </p>
            )}
          </div>
        ))}
        {shown.length === 0 && (
          <p className="text-ink-faint px-4 py-6 text-center text-sm">Nothing recorded yet.</p>
        )}
      </div>
    </div>
  );
}
