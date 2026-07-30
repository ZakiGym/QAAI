'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  ApiError,
  gitExportUrl,
  type GitPreview,
  type Integration,
  type Project,
} from '../../lib/api';

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
  const [project, setProject] = useState<Project | null>(null);
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

  const loadIntegrations = useCallback(async () => {
    const { integrations } = await api<{ integrations: Integration[] }>('/integrations').catch(
      () => ({ integrations: [] as Integration[] }),
    );
    setIntegrations(integrations);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { projects } = await api<{ projects: Project[] }>('/projects');
        const first = projects[0];
        if (!first) return;
        setProject(first);
        await loadIntegrations();
        const p = await api<GitPreview>(`/projects/${first.id}/git/preview`);
        setPreview(p);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load source control');
      }
    })();
  }, [router, loadIntegrations]);

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
    if (!confirm(`Disconnect ${integration.name}? The stored token is deleted.`)) return;
    await api(`/integrations/${integration.id}`, { method: 'DELETE' }).catch(() => {});
    await loadIntegrations();
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

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Source control</h1>
      <p className="text-ink-dim mb-8 text-sm">
        Your tests are plain Playwright code. Take them as a zip, or push them to your own repo.
      </p>

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
        <h2 className="text-ink-dim mb-3 text-xs font-semibold tracking-wider uppercase">
          What gets committed
        </h2>
        <div className="border-line bg-surface-1 rounded-lg border p-4">
          {preview ? (
            <>
              <p className="mb-3 text-sm">
                <span className="font-medium">{preview.totalFiles} files</span>
                <span className="text-ink-faint">
                  {' '}
                  · {(preview.totalBytes / 1024).toFixed(1)} kB · no secret values
                </span>
              </p>
              <ul className="max-h-56 space-y-0.5 overflow-y-auto font-mono text-micro">
                {preview.files.map((f) => (
                  <li key={f.path} className="text-ink-dim flex justify-between gap-4">
                    <span className="truncate">{f.path}</span>
                    <span className="text-ink-faint shrink-0">{f.bytes}</span>
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
              className="border-line hover:border-accent mt-4 inline-block rounded-md border px-3 py-1.5 text-xs"
            >
              ↓ Download as zip
            </a>
          )}
          <p className="text-ink-faint mt-2 text-micro">
            The zip needs no credentials — push it yourself if you prefer.
          </p>
        </div>
      </section>

      {/* Connected remotes */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-ink-dim text-xs font-semibold tracking-wider uppercase">Remotes</h2>
          <button
            type="button"
            onClick={() => setShowConnect((s) => !s)}
            className="text-accent text-sm hover:underline"
          >
            {showConnect ? 'Cancel' : '+ Connect a repo'}
          </button>
        </div>

        {showConnect && (
          <form onSubmit={connect} className="border-line mb-4 space-y-3 rounded-lg border p-4">
            <div className="flex gap-2">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setKind(k.id)}
                  className={`rounded-md border px-3 py-1.5 text-xs ${
                    kind === k.id ? 'border-accent text-ink' : 'border-line text-ink-dim'
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder={KINDS.find((k) => k.id === kind)?.hint ?? 'owner/repo'}
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-1.5 font-mono text-xs outline-none"
            />
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="qaai/tests"
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-1.5 font-mono text-xs outline-none"
            />
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="personal access token (repo write scope)"
              autoComplete="off"
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-1.5 text-xs outline-none"
            />
            <p className="text-ink-faint text-micro">
              The token is encrypted with AES-256-GCM and never shown again. It is used only during
              a push, and never appears in a URL or a log.
            </p>
            <button
              type="submit"
              disabled={busy}
              className="bg-accent rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              Connect
            </button>
          </form>
        )}

        <div className="border-line divide-line bg-surface-1 divide-y overflow-hidden rounded-lg border">
          {integrations.map((integration) => (
            <div key={integration.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{integration.repo}</span>
                <span className="border-line text-ink-faint rounded border px-1.5 py-0.5 font-mono text-[9px]">
                  {integration.kind.toLowerCase()}
                </span>
                {integration.hasToken && (
                  <span className="text-pass text-meta" title="A token is stored">
                    ● token stored
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void disconnect(integration)}
                  className="text-fail ml-auto text-xs hover:underline"
                >
                  Disconnect
                </button>
              </div>

              {confirming === integration.id ? (
                <div className="border-flake/40 bg-flake/5 mt-3 space-y-2 rounded-md border p-3">
                  <p className="text-sm">
                    Push {preview?.totalFiles ?? 0} files to{' '}
                    <span className="font-mono text-xs">
                      {integration.repo}:{pushBranch.trim() || integration.defaultBranch}
                    </span>
                    ?
                  </p>
                  <input
                    value={pushBranch}
                    onChange={(e) => setPushBranch(e.target.value)}
                    placeholder={integration.defaultBranch}
                    className="border-line bg-surface w-full rounded-md border px-2.5 py-1 font-mono text-micro outline-none"
                  />
                  <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="commit message (optional)"
                    className="border-line bg-surface w-full rounded-md border px-2.5 py-1 text-micro outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void push(integration)}
                      disabled={busy}
                      className="bg-accent rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {busy ? 'Pushing…' : 'Yes, push'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="border-line rounded-md border px-3 py-1.5 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-ink-faint text-micro">
                    Adds a commit on that branch. Never force-pushes, never rewrites history.
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(integration.id);
                    setPushBranch('');
                    setPushed(null);
                  }}
                  disabled={!integration.hasToken || !integration.enabled}
                  className="border-line hover:border-accent mt-2 rounded-md border px-3 py-1 text-xs disabled:opacity-40"
                >
                  ↑ Push tests
                </button>
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
    </main>
  );
}
