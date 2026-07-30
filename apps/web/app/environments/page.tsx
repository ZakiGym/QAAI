'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Environment, type Project } from '../../lib/api';
import { SecretsPanel } from '../../components/SecretsPanel';

const KINDS = ['LOCAL', 'PREVIEW', 'STAGING', 'PRODUCTION'] as const;

/**
 * Environments + their secrets (§1–2).
 *
 * An environment is a base URL plus a set of credentials the tests run against.
 * The secrets sit in the encrypted vault; this screen manages the shape (which
 * environments exist, where they point) and hands each one to <SecretsPanel>.
 */
export default function EnvironmentsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-environment form.
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('STAGING');
  const [baseUrl, setBaseUrl] = useState('https://');
  const [creating, setCreating] = useState(false);

  const loadEnvs = useCallback(async (pid: string) => {
    const { environments } = await api<{ environments: Environment[] }>(
      `/projects/${pid}/environments`,
    );
    setEnvs(environments);
    setSelected((cur) => cur ?? environments[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { projects } = await api<{ projects: Project[] }>('/projects');
        setProjects(projects);
        const first = projects[0];
        if (!first) return;
        setProjectId(first.id);
        await loadEnvs(first.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load environments');
      }
    })();
  }, [router, loadEnvs]);

  async function switchProject(pid: string) {
    setProjectId(pid);
    setSelected(null);
    setEnvs([]);
    await loadEnvs(pid).catch((err) =>
      setError(err instanceof Error ? err.message : 'Could not load environments'),
    );
  }

  async function createEnv(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { environment } = await api<{ environment: Environment }>(
        `/projects/${projectId}/environments`,
        { method: 'POST', body: JSON.stringify({ name: name.trim(), kind, baseUrl }) },
      );
      setName('');
      setBaseUrl('https://');
      await loadEnvs(projectId);
      setSelected(environment.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the environment');
    } finally {
      setCreating(false);
    }
  }

  async function saveBaseUrl(env: Environment, next: string) {
    if (!projectId || next === env.baseUrl) return;
    try {
      await api(`/projects/${projectId}/environments/${env.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ baseUrl: next }),
      });
      await loadEnvs(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the base URL');
    }
  }

  async function deleteEnv(env: Environment) {
    if (!projectId) return;
    if (!confirm(`Delete the ${env.name} environment and all its secrets?`)) return;
    try {
      await api(`/projects/${projectId}/environments/${env.id}`, { method: 'DELETE' });
      setSelected(null);
      await loadEnvs(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the environment');
    }
  }

  const selectedEnv = envs.find((e) => e.id === selected) ?? null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-8 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Environments</h1>
        {projects.length > 1 && (
          <select
            value={projectId ?? ''}
            onChange={(e) => void switchProject(e.target.value)}
            className="border-line bg-surface-1 rounded-md border px-2 py-1 text-sm"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <p role="alert" className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm">
          {error}
        </p>
      )}

      <div className="grid gap-6 sm:grid-cols-[260px_1fr]">
        {/* Environment list + create */}
        <div className="space-y-4">
          <div className="border-line divide-line bg-surface-1 divide-y overflow-hidden rounded-lg border">
            {envs.map((env) => (
              <button
                key={env.id}
                type="button"
                onClick={() => setSelected(env.id)}
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left ${
                  selected === env.id ? 'bg-surface-2' : 'hover:bg-surface-1'
                }`}
              >
                <span className="text-sm font-medium">{env.name}</span>
                <span className="border-line text-ink-faint rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase">
                  {env.kind.toLowerCase()}
                </span>
                <span className="text-ink-faint ml-auto text-[11px]">
                  {env._count?.secrets ?? 0} 🔑
                </span>
              </button>
            ))}
            {envs.length === 0 && (
              <p className="text-ink-faint px-3 py-4 text-center text-xs">No environments yet.</p>
            )}
          </div>

          <form onSubmit={createEnv} className="border-line space-y-2 rounded-lg border p-3">
            <p className="text-ink-faint text-[11px] font-semibold tracking-wider uppercase">
              New environment
            </p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Staging"
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-2.5 py-1.5 text-sm outline-none"
            />
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
              className="border-line bg-surface-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.toLowerCase()}
                </option>
              ))}
            </select>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://staging.example.com"
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-2.5 py-1.5 font-mono text-xs outline-none"
            />
            <button
              type="submit"
              disabled={creating}
              className="bg-accent w-full rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Create
            </button>
          </form>
        </div>

        {/* Selected environment */}
        <div>
          {selectedEnv ? (
            <div className="space-y-6">
              <div className="border-line bg-surface-1 rounded-lg border p-4">
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="font-medium">{selectedEnv.name}</h2>
                  <span className="border-line text-ink-faint rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase">
                    {selectedEnv.kind.toLowerCase()}
                  </span>
                  <button
                    type="button"
                    onClick={() => void deleteEnv(selectedEnv)}
                    className="text-fail ml-auto text-xs hover:underline"
                  >
                    Delete
                  </button>
                </div>
                <label className="text-ink-faint mb-1 block text-[11px]">Base URL</label>
                <input
                  defaultValue={selectedEnv.baseUrl}
                  key={selectedEnv.id}
                  onBlur={(e) => void saveBaseUrl(selectedEnv, e.target.value)}
                  className="border-line bg-surface focus:border-accent w-full rounded-md border px-3 py-1.5 font-mono text-xs outline-none"
                />
                <p className="text-ink-faint mt-1 text-[11px]">
                  Tests run against this URL. Changes save on blur.
                </p>
              </div>

              <div>
                <h3 className="text-ink-dim mb-3 text-xs font-semibold tracking-wider uppercase">
                  Secrets
                </h3>
                {projectId && (
                  <SecretsPanel projectId={projectId} environmentId={selectedEnv.id} />
                )}
              </div>
            </div>
          ) : (
            <p className="text-ink-faint text-sm">Select or create an environment.</p>
          )}
        </div>
      </div>
    </main>
  );
}
