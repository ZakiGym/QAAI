'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, gitExportUrl, type GitPreview, type Integration } from '../../lib/api';
import { SetupHeader } from '../../components/setup/SetupHeader';
import { shortAgo } from '../../components/setup/time';
import { useProject } from '../../components/shell/ProjectContext';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/Modal';
import { Page, SectionLabel, Skeleton } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

const KINDS = [
  { id: 'GITHUB', label: 'GitHub', hint: 'github.com/owner/repo' },
  { id: 'GITLAB', label: 'GitLab', hint: 'gitlab.com/owner/repo' },
  { id: 'BITBUCKET', label: 'Bitbucket', hint: 'bitbucket.org/owner/repo' },
] as const;

/**
 * Source control (§7) — your tests, in your repo.
 *
 * Two paths, deliberately. Export needs nothing: it hands you the exact repo
 * QAAI would push, as a zip, so "you keep the code" is true even if you never
 * trust us with a credential. Connecting a token unlocks one-click push — always
 * an explicit, confirmed action, always to a branch, never a force-push.
 *
 * The export card leads for that reason. It is the claim the whole screen makes,
 * and it is the one that costs the reader nothing to verify.
 */
export default function SourceControlPage() {
  const router = useRouter();
  // Which app's tests get pushed is the shell's selection, not projects[0].
  const { project, projectId, loading: projectLoading } = useProject();
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [preview, setPreview] = useState<GitPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushed, setPushed] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);

  // Connect form.
  const [showConnect, setShowConnect] = useState(false);
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('GITHUB');
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [branch, setBranch] = useState('qaai/tests');

  // Push form. One at a time — two remotes cannot be mid-push at once.
  const [pushBranch, setPushBranch] = useState('');
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState<Integration | null>(null);

  // The remote awaiting a disconnect confirmation.
  const [pendingDisconnect, setPendingDisconnect] = useState<Integration | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadIntegrations = useCallback(async () => {
    const { integrations } = await api<{ integrations: Integration[] }>('/integrations').catch(
      () => ({ integrations: [] as Integration[] }),
    );
    setIntegrations(integrations);
  }, []);

  // Remotes belong to the org, so they load once regardless of the project.
  useEffect(() => {
    void loadIntegrations();
  }, [loadIntegrations]);

  // The file list is per-project, so it reloads when the shell switches app.
  useEffect(() => {
    if (!projectId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    void (async () => {
      try {
        const p = await api<GitPreview>(`/projects/${projectId}/git/preview`);
        if (!cancelled) setPreview(p);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load source control');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, router]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!repo.trim() || !token || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/integrations', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          name: repo.trim(),
          repo: repo.trim(),
          token,
          defaultBranch: branch.trim() || 'qaai/tests',
        }),
      });
      setToken('');
      setRepo('');
      setShowConnect(false);
      await loadIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(integration: Integration) {
    setDisconnecting(true);
    try {
      await api(`/integrations/${integration.id}`, { method: 'DELETE' }).catch(() => {});
      await loadIntegrations();
      setPendingDisconnect(null);
    } finally {
      setDisconnecting(false);
    }
  }

  async function push(integration: Integration) {
    if (!project) return;
    setBusy(true);
    setError(null);
    setPushed(null);
    try {
      const { push } = await api<{
        push: { commitSha: string; branch: string; repoUrl: string; fileCount: number };
      }>(`/projects/${project.id}/git/push`, {
        method: 'POST',
        body: JSON.stringify({
          integrationId: integration.id,
          ...(pushBranch.trim() ? { branch: pushBranch.trim() } : {}),
          ...(message.trim() ? { message: message.trim() } : {}),
          confirm: true,
        }),
      });
      setPushed(
        `Pushed ${push.fileCount} files to ${push.branch} — ${push.commitSha.slice(0, 8)}`,
      );
      setConfirming(null);
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push failed');
    } finally {
      setBusy(false);
    }
  }

  // "No app" and "not loaded yet" are different states, and only the first one
  // may stop waiting — the file list used to spin on "Building the file list…"
  // forever for anyone who had not created a project.
  const noProject = !projectLoading && !project;

  return (
    <Page width="setup">
      <SetupHeader />

      {error && (
        <p
          role="alert"
          className="border-fail/40 text-fail text-row-sub mt-6 rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3"
        >
          {error}
        </p>
      )}
      {pushed && (
        <p
          role="status"
          className="border-pass/40 text-pass text-row-sub mt-6 rounded-md border bg-[color-mix(in_srgb,var(--color-pass)_8%,transparent)] p-3"
        >
          {pushed}
        </p>
      )}

      <div className="mt-7">
        {/* ── The zip, which needs nothing from you ─────────────────────────── */}
        {noProject ? (
          <EmptyState
            title="Nothing to commit yet"
            body="There is no app here to take tests from. Add one, let the agent write its first tests, and this becomes the exact repo you can download or push."
            action={{ label: 'Add app', href: '/onboarding' }}
          />
        ) : (
          <section className="border-line rounded-lg border px-[18px] py-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-row font-semibold">Export the repo</p>
                <p className="text-ink-dim mt-1 text-[12px]">
                  The exact repo we would push — standard Playwright, runs under{' '}
                  <span className="font-mono text-[11px]">npx playwright test</span> with QAAI
                  uninstalled.
                </p>
              </div>
              {project && (
                <a
                  href={gitExportUrl(project.id)}
                  className="border-line text-ink hover:border-line-strong shrink-0 rounded-md border px-3.5 py-[7px] text-[12.5px] whitespace-nowrap transition-colors"
                >
                  Download repo.zip
                </a>
              )}
            </div>

            {preview ? (
              <p className="text-ink-faint text-micro mt-3 font-mono tabular-nums">
                {preview.totalFiles} files · {(preview.totalBytes / 1024).toFixed(1)} kB · no secret
                values{' '}
                <button
                  type="button"
                  onClick={() => setShowFiles((s) => !s)}
                  aria-expanded={showFiles}
                  className="text-accent hover:underline"
                >
                  {showFiles ? '· hide the list' : '· show the list'}
                </button>
              </p>
            ) : (
              <Skeleton className="mt-3 h-3 w-56" />
            )}

            {showFiles && preview && (
              <ul className="text-micro mt-2 max-h-56 space-y-0.5 overflow-y-auto font-mono">
                {preview.files.map((f) => (
                  <li key={f.path} className="text-ink-dim flex justify-between gap-4">
                    <span className="truncate">{f.path}</span>
                    <span className="text-ink-faint shrink-0 tabular-nums">{f.bytes}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ── Remotes ──────────────────────────────────────────────────────── */}
        <section className="mt-6">
          <SectionLabel>Remotes</SectionLabel>

          {integrations === null ? (
            <Skeleton className="h-[118px] w-full rounded-lg" />
          ) : integrations.length === 0 ? (
            <p className="border-line text-ink-faint text-row-sub rounded-lg border border-dashed px-[18px] py-4">
              No repo connected. Export works without one — a remote only adds the one-click push.
            </p>
          ) : (
            integrations.map((integration) => (
              <div
                key={integration.id}
                className="border-line mt-2.5 rounded-lg border px-[18px] py-4 first:mt-0"
              >
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="font-mono text-[12.5px]">{integration.repo}</span>
                  <span className="text-ink-faint text-micro font-mono">
                    branch {integration.defaultBranch}
                    {preview ? ` · ${preview.totalFiles} files` : ''} · updated{' '}
                    {shortAgo(integration.updatedAt)} ago
                    {integration.hasToken ? '' : ' · no token'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPendingDisconnect(integration)}
                    className="text-ink-faint hover:text-fail ml-auto text-[11.5px] transition-colors"
                  >
                    disconnect
                  </button>
                </div>

                <div className="mt-3.5 flex flex-wrap gap-2">
                  <input
                    aria-label="Branch to push to"
                    value={pushBranch}
                    onChange={(e) => setPushBranch(e.target.value)}
                    placeholder={`branch — ${integration.defaultBranch}`}
                    className="border-line placeholder:text-ink-faint focus:border-accent w-[200px] rounded-md border bg-transparent px-2.5 py-[7px] font-mono text-[11.5px] outline-none transition-colors"
                  />
                  <input
                    aria-label="Commit message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="commit message"
                    className="border-line placeholder:text-ink-faint focus:border-accent min-w-[200px] flex-1 rounded-md border bg-transparent px-2.5 py-[7px] text-[12.5px] outline-none transition-colors"
                  />
                  <Button
                    variant="primary"
                    onClick={() => {
                      setPushed(null);
                      setConfirming(integration);
                    }}
                    // Without a project there is nothing to push, and `push()`
                    // would return silently.
                    disabled={!integration.hasToken || !integration.enabled || !project || busy}
                  >
                    Push
                  </Button>
                </div>

                <p className="text-ink-faint text-micro mt-2.5 font-mono">
                  always to a branch · never a force-push · confirmed before anything moves
                </p>
              </div>
            ))
          )}

          <p className="mt-3">
            <button
              type="button"
              onClick={() => setShowConnect((s) => !s)}
              aria-expanded={showConnect}
              className="text-accent text-[12px] hover:underline"
            >
              {showConnect ? '– cancel' : '+ connect GitLab or Bitbucket'}
            </button>
          </p>

          {showConnect && (
            <form onSubmit={connect} className="border-line mt-3 space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap gap-2">
                {KINDS.map((k) => (
                  <Button
                    key={k.id}
                    size="sm"
                    aria-pressed={kind === k.id}
                    onClick={() => setKind(k.id)}
                    className={cn(kind === k.id && 'border-accent text-ink')}
                  >
                    {k.label}
                  </Button>
                ))}
              </div>
              <Field
                label="Repository"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder={KINDS.find((k) => k.id === kind)?.hint ?? 'owner/repo'}
                className="font-mono"
              />
              <Field
                label="Branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="qaai/tests"
                className="font-mono"
              />
              <Field
                label="Access token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="personal access token (repo write scope)"
                autoComplete="off"
                hint="AES-256-GCM · used only during a push · never in a URL or a log"
              />
              <Button type="submit" variant="primary" size="sm" loading={busy}>
                Connect
              </Button>
            </form>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) void push(confirming);
        }}
        title={confirming ? `Push to ${confirming.repo}?` : 'Push tests'}
        body={
          confirming
            ? `${preview?.totalFiles ?? 0} files go onto ${
                pushBranch.trim() || confirming.defaultBranch
              } as one commit. Nothing is force-pushed and no history is rewritten — if the branch exists, this adds to it.`
            : ''
        }
        confirmLabel="Yes, push"
        tone="primary"
        busy={busy}
      />

      <ConfirmDialog
        open={pendingDisconnect !== null}
        onClose={() => setPendingDisconnect(null)}
        onConfirm={() => {
          if (pendingDisconnect) void disconnect(pendingDisconnect);
        }}
        title={pendingDisconnect ? `Disconnect ${pendingDisconnect.name}?` : 'Disconnect'}
        body="The stored token is deleted. Anything already pushed stays in the repo."
        confirmLabel="Disconnect"
        busy={disconnecting}
      />
    </Page>
  );
}
