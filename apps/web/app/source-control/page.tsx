'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  ApiError,
  gitExportUrl,
  type GitPreview,
  type Integration,
} from '../../lib/api';
import { useProject } from '../../components/shell/ProjectContext';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/Modal';
import { Badge, Page, PageHeader, SectionLabel } from '../../components/ui/layout';

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
 */
export default function SourceControlPage() {
  const router = useRouter();
  // Which app's tests get pushed is the shell's selection, not projects[0].
  const { project, projectId, loading: projectLoading } = useProject();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [preview, setPreview] = useState<GitPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushed, setPushed] = useState<string | null>(null);

  // Connect form.
  const [showConnect, setShowConnect] = useState(false);
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('GITHUB');
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [branch, setBranch] = useState('qaai/tests');

  // Push form.
  const [pushBranch, setPushBranch] = useState('');
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

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
    if (!repo.trim() || !token) return;
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
    <Page width="narrow">
      <PageHeader
        title="Source control"
        subtitle="Your tests are plain Playwright code. Take them as a zip, or push them to your own repo."
      />

      {error && (
        <p role="alert" className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm">
          {error}
        </p>
      )}
      {pushed && (
        <p className="border-pass/40 bg-pass/10 text-pass mb-6 rounded-md border p-3 text-sm">
          {pushed}
        </p>
      )}

      {/* What would be pushed */}
      <section className="mb-10">
        <SectionLabel>What gets committed</SectionLabel>
        {noProject ? (
          <EmptyState
            title="Nothing to commit yet"
            body="There is no app here to take tests from. Add one, let the agent write its first tests, and this becomes the exact repo you can download or push."
            action={{ label: 'Add app', href: '/onboarding' }}
          />
        ) : (
          <div className="border-line bg-surface-1 rounded-lg border p-4">
            {preview ? (
              <>
                <p className="mb-3 text-sm">
                  <span className="font-medium tabular-nums">{preview.totalFiles} files</span>
                  <span className="text-ink-faint tabular-nums">
                    {' '}
                    · {(preview.totalBytes / 1024).toFixed(1)} kB · no secret values
                  </span>
                </p>
                <ul className="max-h-56 space-y-0.5 overflow-y-auto font-mono text-micro">
                  {preview.files.map((f) => (
                    <li key={f.path} className="text-ink-dim flex justify-between gap-4">
                      <span className="truncate">{f.path}</span>
                      <span className="text-ink-faint shrink-0 tabular-nums">{f.bytes}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-ink-faint text-sm">Building the file list…</p>
            )}

            {project && (
              <a
                href={gitExportUrl(project.id)}
                className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-micro mt-4 inline-flex items-center rounded-md border px-2.5 py-1.5 transition-colors"
              >
                ↓ Download as zip
              </a>
            )}
            <p className="text-ink-faint mt-2 text-micro">
              The zip needs no credentials — push it yourself if you prefer.
            </p>
          </div>
        )}
      </section>

      {/* Connected remotes */}
      <section>
        <div className="flex items-baseline justify-between">
          <SectionLabel>Remotes</SectionLabel>
          <Button variant="ghost" size="sm" onClick={() => setShowConnect((s) => !s)}>
            {showConnect ? 'Cancel' : '+ Connect a repo'}
          </Button>
        </div>

        {showConnect && (
          <form onSubmit={connect} className="border-line mb-4 space-y-3 rounded-lg border p-4">
            <div className="flex gap-2">
              {KINDS.map((k) => (
                <Button
                  key={k.id}
                  size="sm"
                  aria-pressed={kind === k.id}
                  onClick={() => setKind(k.id)}
                  className={kind === k.id ? 'border-accent text-ink' : undefined}
                >
                  {k.label}
                </Button>
              ))}
            </div>
            <Field
              aria-label="Repository"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder={KINDS.find((k) => k.id === kind)?.hint ?? 'owner/repo'}
              className="font-mono"
            />
            <Field
              aria-label="Branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="qaai/tests"
              className="font-mono"
            />
            <Field
              aria-label="Personal access token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="personal access token (repo write scope)"
              autoComplete="off"
            />
            <p className="text-ink-faint text-micro">
              The token is encrypted with AES-256-GCM and never shown again. It is used only during
              a push, and never appears in a URL or a log.
            </p>
            <Button type="submit" variant="primary" size="sm" loading={busy}>
              Connect
            </Button>
          </form>
        )}

        <div className="border-line divide-line bg-surface-1 divide-y overflow-hidden rounded-lg border">
          {integrations.map((integration) => (
            <div key={integration.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{integration.repo}</span>
                <Badge mono>{integration.kind.toLowerCase()}</Badge>
                {integration.hasToken && (
                  <span className="text-pass text-meta" title="A token is stored">
                    ● token stored
                  </span>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setPendingDisconnect(integration)}
                >
                  Disconnect
                </Button>
              </div>

              {confirming === integration.id ? (
                <div className="border-flake/40 bg-flake/5 mt-3 space-y-2 rounded-md border p-3">
                  <p className="text-sm">
                    Push <span className="tabular-nums">{preview?.totalFiles ?? 0}</span> files to{' '}
                    <span className="font-mono text-xs">
                      {integration.repo}:{pushBranch.trim() || integration.defaultBranch}
                    </span>
                    ?
                  </p>
                  <Field
                    aria-label="Branch to push to"
                    value={pushBranch}
                    onChange={(e) => setPushBranch(e.target.value)}
                    placeholder={integration.defaultBranch}
                    className="bg-surface px-2.5 py-1 font-mono text-micro"
                  />
                  <Field
                    aria-label="Commit message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="commit message (optional)"
                    className="bg-surface px-2.5 py-1 text-micro"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void push(integration)}
                      loading={busy}
                    >
                      {busy ? 'Pushing…' : 'Yes, push'}
                    </Button>
                    <Button size="sm" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </div>
                  <p className="text-ink-faint text-micro">
                    Adds a commit on that branch. Never force-pushes, never rewrites history.
                  </p>
                </div>
              ) : (
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setConfirming(integration.id);
                    setPushBranch('');
                    setPushed(null);
                  }}
                  // Without a project there is nothing to push, and `push()`
                  // would return silently.
                  disabled={!integration.hasToken || !integration.enabled || !project}
                >
                  ↑ Push tests
                </Button>
              )}
            </div>
          ))}
          {integrations.length === 0 && (
            <p className="text-ink-faint px-4 py-6 text-center text-sm">
              No repo connected. Export works without one.
            </p>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={pendingDisconnect !== null}
        onClose={() => setPendingDisconnect(null)}
        onConfirm={() => {
          if (pendingDisconnect) void disconnect(pendingDisconnect);
        }}
        title={pendingDisconnect ? `Disconnect ${pendingDisconnect.name}?` : 'Disconnect'}
        body="The stored token is deleted."
        confirmLabel="Disconnect"
        busy={disconnecting}
      />
    </Page>
  );
}
