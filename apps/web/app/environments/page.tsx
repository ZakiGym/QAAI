'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Environment } from '../../lib/api';
import { SecretsPanel } from '../../components/SecretsPanel';
import { useProject } from '../../components/shell/ProjectContext';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/Modal';
import { Badge, Page, PageHeader, SectionLabel, SkeletonRows } from '../../components/ui/layout';

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
  // Which app's environments these are is a session-wide fact, owned by the
  // shell's switcher. This screen used to take projects[0] and never say so.
  const { projectId, loading: projectLoading } = useProject();
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadingEnvs, setLoadingEnvs] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New-environment form.
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('STAGING');
  const [baseUrl, setBaseUrl] = useState('https://');
  const [creating, setCreating] = useState(false);

  // The environment awaiting a delete confirmation.
  const [pendingDelete, setPendingDelete] = useState<Environment | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Switching projects mid-flight must not let the slower response win and
  // repaint the previous project's environments over the new one's.
  const request = useRef(0);
  const loadEnvs = useCallback(async (pid: string) => {
    const ticket = ++request.current;
    const { environments } = await api<{ environments: Environment[] }>(
      `/projects/${pid}/environments`,
    );
    if (ticket !== request.current) return;
    setEnvs(environments);
    setSelected((cur) => cur ?? environments[0]?.id ?? null);
  }, []);

  useEffect(() => {
    // No project selected yet: drop whatever the last one had and stay in the
    // loading shape — `noProject` below is what distinguishes "none" from
    // "not fetched yet", and only it may render a dead end.
    if (!projectId) {
      request.current++;
      setEnvs([]);
      setSelected(null);
      return;
    }
    setEnvs([]);
    setSelected(null);
    setLoadingEnvs(true);
    void loadEnvs(projectId)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load environments');
      })
      .finally(() => setLoadingEnvs(false));
  }, [projectId, loadEnvs, router]);

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
    setDeleting(true);
    try {
      await api(`/projects/${projectId}/environments/${env.id}`, { method: 'DELETE' });
      setPendingDelete(null);
      setSelected(null);
      await loadEnvs(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the environment');
    } finally {
      setDeleting(false);
    }
  }

  const selectedEnv = envs.find((e) => e.id === selected) ?? null;
  // "No project" and "not fetched yet" look identical from the DOM; only the
  // first one may disable the form and say so.
  const noProject = !projectLoading && !projectId;

  return (
    <Page width="wide">
      <PageHeader title="Environments" />

      {error && (
        <p role="alert" className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm">
          {error}
        </p>
      )}

      <div className="grid gap-6 sm:grid-cols-[260px_1fr]">
        {/* Environment list + create */}
        <div className="space-y-4">
          <div className="border-line divide-line bg-surface-1 divide-y overflow-hidden rounded-lg border">
            {noProject ? (
              <p className="text-ink-faint text-micro px-3 py-4 text-center">
                No app yet — nothing to point at.
              </p>
            ) : loadingEnvs ? (
              <SkeletonRows rows={3} />
            ) : (
              <>
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
                    <Badge mono className="uppercase">
                      {env.kind.toLowerCase()}
                    </Badge>
                    <span className="text-ink-faint ml-auto text-micro tabular-nums">
                      {env._count?.secrets ?? 0} 🔑
                    </span>
                  </button>
                ))}
                {envs.length === 0 && (
                  <p className="text-ink-faint text-micro px-3 py-4 text-center">
                    No environments. Add one to point runs at staging or production.
                  </p>
                )}
              </>
            )}
          </div>

          <form onSubmit={createEnv} className="border-line space-y-2 rounded-lg border p-3">
            <p className="text-ink-faint text-micro font-semibold tracking-wider uppercase">
              New environment
            </p>
            <Field
              aria-label="Environment name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Staging"
              disabled={noProject}
              className="disabled:cursor-not-allowed disabled:opacity-50"
            />
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
              aria-label="Environment kind"
              disabled={noProject}
              className="border-line bg-surface-1 w-full rounded-md border px-2.5 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.toLowerCase()}
                </option>
              ))}
            </select>
            <Field
              aria-label="Base URL"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://staging.example.com"
              disabled={noProject}
              className="font-mono disabled:cursor-not-allowed disabled:opacity-50"
            />
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={creating}
              disabled={noProject}
            >
              Create
            </Button>
            {noProject && (
              <p className="text-ink-faint text-micro">
                An environment belongs to an app, and there is no app yet. Add one first.
              </p>
            )}
          </form>
        </div>

        {/* Selected environment */}
        <div>
          {selectedEnv ? (
            <div className="space-y-6">
              <div className="border-line bg-surface-1 rounded-lg border p-4">
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="font-medium">{selectedEnv.name}</h2>
                  <Badge mono className="uppercase">
                    {selectedEnv.kind.toLowerCase()}
                  </Badge>
                  <Button
                    variant="danger"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setPendingDelete(selectedEnv)}
                  >
                    Delete
                  </Button>
                </div>
                {/* Uncontrolled and keyed by environment, so switching rows
                    reloads the field instead of keeping the old URL. */}
                <Field
                  key={selectedEnv.id}
                  label="Base URL"
                  defaultValue={selectedEnv.baseUrl}
                  onBlur={(e) => void saveBaseUrl(selectedEnv, e.target.value)}
                  hint="Tests run against this URL. Changes save on blur."
                  className="bg-surface font-mono"
                />
              </div>

              <div>
                <SectionLabel>Secrets</SectionLabel>
                {projectId && (
                  <SecretsPanel projectId={projectId} environmentId={selectedEnv.id} />
                )}
              </div>
            </div>
          ) : noProject ? (
            <EmptyState
              title="No app to configure yet"
              body="Environments hang off an app — they are where a run gets its base URL and its credentials. Add an app, then point one at staging or production."
              action={{ label: 'Add app', href: '/onboarding' }}
            />
          ) : (
            <p className="text-ink-faint text-sm">Select or create an environment.</p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void deleteEnv(pendingDelete);
        }}
        title="Delete environment"
        body={
          pendingDelete
            ? `Delete the ${pendingDelete.name} environment and all its secrets?`
            : ''
        }
        confirmLabel="Delete environment"
        busy={deleting}
      />
    </Page>
  );
}
