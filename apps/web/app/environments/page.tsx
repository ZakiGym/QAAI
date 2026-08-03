'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Environment } from '../../lib/api';
import { SecretsPanel } from '../../components/SecretsPanel';
import { SetupHeader } from '../../components/setup/SetupHeader';
import { useProject } from '../../components/shell/ProjectContext';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/Modal';
import { Page, SectionLabel, Skeleton } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

const KINDS = ['LOCAL', 'PREVIEW', 'STAGING', 'PRODUCTION'] as const;

/**
 * Environments + their secrets (§1–2).
 *
 * An environment is a base URL plus a set of credentials the tests run against.
 * The secrets sit in the encrypted vault; this screen manages the shape (which
 * environments exist, where they point) and hands each one to <SecretsPanel>.
 *
 * The list is the navigation and the right column is the subject — a two-pane
 * shape rather than a stack, because the one thing anyone comes here to do is
 * compare where staging points with where production points.
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

  // New-environment form, behind the `+ new environment` link.
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('STAGING');
  const [newUrl, setNewUrl] = useState('https://');
  const [creating, setCreating] = useState(false);

  // The base URL of the selected environment, and whether it has been edited.
  const [baseUrl, setBaseUrl] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);

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

  const selectedEnv = envs.find((e) => e.id === selected) ?? null;

  // The field follows the selection: switching rows must show that row's URL,
  // not keep the one you were looking at a moment ago.
  useEffect(() => {
    setBaseUrl(selectedEnv?.baseUrl ?? '');
  }, [selectedEnv?.id, selectedEnv?.baseUrl]);

  async function createEnv(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { environment } = await api<{ environment: Environment }>(
        `/projects/${projectId}/environments`,
        { method: 'POST', body: JSON.stringify({ name: name.trim(), kind, baseUrl: newUrl }) },
      );
      setName('');
      setNewUrl('https://');
      setAdding(false);
      await loadEnvs(projectId);
      setSelected(environment.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the environment');
    } finally {
      setCreating(false);
    }
  }

  async function saveBaseUrl(env: Environment) {
    if (!projectId || baseUrl === env.baseUrl || savingUrl) return;
    setSavingUrl(true);
    setError(null);
    try {
      await api(`/projects/${projectId}/environments/${env.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ baseUrl }),
      });
      await loadEnvs(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the base URL');
    } finally {
      setSavingUrl(false);
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

  // "No project" and "not fetched yet" look identical from the DOM; only the
  // first one may disable the form and say so.
  const noProject = !projectLoading && !projectId;
  const dirty = selectedEnv !== null && baseUrl !== selectedEnv.baseUrl;

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

      {noProject ? (
        <div className="mt-7">
          <EmptyState
            title="No app to configure yet"
            body="Environments hang off an app — they are where a run gets its base URL and its credentials. Add an app, then point one at staging or production."
            action={{ label: 'Add app', href: '/onboarding' }}
          />
        </div>
      ) : (
        <div className="mt-7 grid gap-8 md:grid-cols-[minmax(180px,240px)_minmax(300px,1fr)]">
          {/* ── The environments ───────────────────────────────────────────── */}
          <div>
            {loadingEnvs ? (
              <div className="space-y-1" aria-label="Loading" role="status">
                <Skeleton className="h-[58px] w-full rounded-lg" />
                <Skeleton className="h-[58px] w-full rounded-lg" />
                <Skeleton className="h-[58px] w-full rounded-lg" />
              </div>
            ) : envs.length === 0 ? (
              <p className="text-ink-faint text-row-sub">
                No environments yet. One points a run at staging or production.
              </p>
            ) : (
              envs.map((env) => (
                <button
                  key={env.id}
                  type="button"
                  onClick={() => setSelected(env.id)}
                  aria-pressed={selected === env.id}
                  className={cn(
                    'mt-1 block w-full rounded-lg border px-3 py-2.5 text-left transition-colors first:mt-0',
                    selected === env.id
                      ? 'border-line-strong bg-surface-1'
                      : 'hover:bg-surface-1 border-transparent',
                  )}
                >
                  <span className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-[13px]',
                        selected === env.id ? 'font-semibold' : 'text-ink-dim',
                      )}
                    >
                      {env.name}
                    </span>
                    <span className="text-ink-faint shrink-0 font-mono text-[9.5px] tracking-[0.05em]">
                      {env.kind}
                    </span>
                  </span>
                  <span className="text-ink-faint mt-[3px] block truncate font-mono text-[10.5px]">
                    {env.baseUrl.replace(/^https?:\/\//, '')}
                  </span>
                </button>
              ))
            )}

            <p className="mt-3">
              <button
                type="button"
                onClick={() => setAdding((a) => !a)}
                aria-expanded={adding}
                className="text-accent text-[12px] hover:underline"
              >
                {adding ? '– cancel' : '+ new environment'}
              </button>
            </p>

            {adding && (
              <form
                onSubmit={createEnv}
                className="border-line mt-3 space-y-2.5 rounded-lg border p-3"
              >
                <Field
                  label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="staging"
                />
                <div>
                  <label
                    htmlFor="env-kind"
                    className="text-meta text-ink-faint mb-2 block font-mono tracking-[0.08em] uppercase"
                  >
                    Kind
                  </label>
                  <select
                    id="env-kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
                    className="border-line text-row-sub focus:border-accent w-full rounded-md border bg-transparent px-2.5 py-2 outline-none transition-colors"
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </div>
                <Field
                  label="Base URL"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://staging.example.com"
                  className="font-mono"
                />
                <Button type="submit" variant="primary" size="sm" className="w-full" loading={creating}>
                  Create
                </Button>
              </form>
            )}
          </div>

          {/* ── The selected one ───────────────────────────────────────────── */}
          <div>
            {loadingEnvs ? (
              <div aria-hidden="true" className="space-y-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ) : !selectedEnv ? (
              <p className="text-ink-faint text-row-sub">
                Select an environment, or add the first one — a run needs a URL to point at.
              </p>
            ) : (
              <>
                <SectionLabel>Base URL</SectionLabel>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveBaseUrl(selectedEnv);
                  }}
                >
                  <input
                    aria-label="Base URL"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="border-line bg-surface-1 focus:border-accent min-w-0 flex-1 rounded-md border px-3 py-2 font-mono text-[12px] outline-none transition-colors"
                  />
                  <Button type="submit" loading={savingUrl} disabled={!dirty}>
                    Save
                  </Button>
                </form>
                <p className="text-ink-faint text-micro mt-1.5 font-mono">
                  every run against {selectedEnv.name} starts here
                </p>

                {projectId && (
                  <SecretsPanel projectId={projectId} environmentId={selectedEnv.id} />
                )}

                <p className="mt-7">
                  <button
                    type="button"
                    onClick={() => setPendingDelete(selectedEnv)}
                    className="text-fail text-[12px] hover:underline"
                  >
                    delete this environment…
                  </button>
                </p>
              </>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void deleteEnv(pendingDelete);
        }}
        title="Delete environment"
        body={
          pendingDelete
            ? `Delete the ${pendingDelete.name} environment and all its secrets? Any run or schedule pointed at it stops having somewhere to go.`
            : ''
        }
        confirmLabel="Delete environment"
        busy={deleting}
      />
    </Page>
  );
}
