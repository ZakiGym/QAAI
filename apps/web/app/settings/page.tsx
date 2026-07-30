'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';

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

type Tab = 'organization' | 'members' | 'apiKeys' | 'usage' | 'audit';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'organization', label: 'Organization' },
  { id: 'members', label: 'Members' },
  { id: 'apiKeys', label: 'API keys' },
  { id: 'usage', label: 'Usage' },
  { id: 'audit', label: 'Audit log' },
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
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Settings</h1>

      {error && (
        <p
          role="alert"
          className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm"
        >
          {error}
        </p>
      )}

      <nav className="border-line mb-8 flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.id
                ? 'border-accent text-ink'
                : 'text-ink-faint hover:text-ink border-transparent'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

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
      ) : (
        <AuditTab />
      )}
    </main>
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

function MembersTab({ me, activeOrg }: { me: Me; activeOrg: Org | null }) {
  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    void api<{ members: Member[] }>('/settings/members')
      .then((d) => setMembers(d.members))
      .catch(() => setMembers([]));
  }, []);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-ink-dim mb-3 text-xs font-semibold tracking-wider uppercase">
          {activeOrg ? `Members of ${activeOrg.name}` : 'Members'}
        </h2>
        <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
          {members.map((member) => (
            <div key={member.userId} className="flex items-center gap-4 px-4 py-3">
              <span className="text-sm font-medium">{member.name || member.email}</span>
              {member.name && <span className="text-ink-faint text-xs">{member.email}</span>}
              <span className="text-ink-faint ml-auto font-mono text-xs">
                {member.role.toLowerCase()}
              </span>
            </div>
          ))}
          {members.length === 0 && (
            <div className="flex items-center gap-4 px-4 py-3">
              <span className="text-sm font-medium">
                {me.user?.name ?? me.user?.email ?? 'You'}
              </span>
              <span className="text-ink-faint ml-auto font-mono text-xs">
                {activeOrg?.role.toLowerCase() ?? ''}
              </span>
            </div>
          )}
        </div>
        <p className="text-ink-faint mt-2 text-xs">
          Email invites are not built yet — new members join by signing up and being added to the
          org.
        </p>
      </section>

      <section>
        <h2 className="text-ink-dim mb-3 text-xs font-semibold tracking-wider uppercase">
          Your organizations
        </h2>
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
    if (!confirm('Revoke this key? Anything using it will stop working immediately.')) return;
    await api(`/settings/api-keys/${id}`, { method: 'DELETE' }).catch(() => {});
    await load();
  }

  return (
    <div className="space-y-6">
      {freshSecret && (
        <div className="border-accent/50 bg-accent/10 rounded-lg border p-4">
          <p className="mb-2 text-sm font-medium">Copy this key now — it is never shown again.</p>
          <code className="border-line bg-surface block overflow-x-auto rounded border px-3 py-2 font-mono text-xs">
            {freshSecret}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(freshSecret);
              setFreshSecret(null);
            }}
            className="bg-accent mt-3 rounded-md px-3 py-1 text-xs font-medium text-white"
          >
            Copy and dismiss
          </button>
        </div>
      )}

      <form onSubmit={create} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. github-ci"
          className="border-line bg-surface-1 focus:border-accent flex-1 rounded-md border px-3 py-1.5 text-sm outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="bg-accent rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          New key
        </button>
      </form>
      {error && <p className="text-fail text-xs">{error}</p>}

      <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
        {keys.map((key) => (
          <div key={key.id} className="flex items-center gap-4 px-4 py-3">
            <span className="text-sm font-medium">{key.name}</span>
            <code className="text-ink-faint font-mono text-xs">{key.keyPrefix}…</code>
            <span className="text-ink-faint font-mono text-meta">{key.scopes.join(' ')}</span>
            <button
              type="button"
              onClick={() => void revoke(key.id)}
              className="text-fail ml-auto text-xs hover:underline"
            >
              Revoke
            </button>
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
          <p className="mt-1 text-2xl font-semibold tracking-tight">{money(data.totalCostCents)}</p>
        </div>
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-ink-faint text-xs">Model calls</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{data.totalCalls}</p>
        </div>
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          <p className="text-ink-faint text-xs">Failed calls</p>
          <p className="text-flake mt-1 text-2xl font-semibold tracking-tight">
            {data.byAgent.reduce((sum, a) => sum + a.failures, 0)}
          </p>
        </div>
      </div>

      <div className="border-line divide-line overflow-hidden rounded-lg border">
        {data.byAgent.map((row) => (
          <div key={row.agent} className="flex items-center gap-4 px-4 py-3">
            <span className="w-24 text-sm font-medium">{row.agent.toLowerCase()}</span>
            <span className="text-ink-faint text-xs">{row.calls} calls</span>
            <span className="text-ink-faint font-mono text-micro">
              {(row.inputTokens / 1000).toFixed(1)}k in / {(row.outputTokens / 1000).toFixed(1)}k out
            </span>
            {row.failures > 0 && (
              <span className="text-flake text-micro">{row.failures} failed</span>
            )}
            <span className="ml-auto font-mono text-sm">{money(row.costCents)}</span>
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
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by action or person…"
        className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-1.5 text-sm outline-none"
      />

      <div className="border-line divide-line max-h-[60vh] overflow-y-auto rounded-lg border">
        {shown.map((entry) => (
          <div key={entry.id} className="px-4 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-micro">{entry.action}</span>
              <span className="text-ink-faint text-xs">{entry.actor}</span>
              <span className="text-ink-faint ml-auto text-meta">
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
