'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API_URL, api, ApiError, type Project } from '../../lib/api';

/**
 * Onboarding (§10) — the first-run path the spec targets at "under 15 minutes".
 *
 * Four steps on one screen: name the project, point it at a URL, watch the
 * Explorer crawl live, then land on the plan to approve. This is the flow that
 * makes the app usable on your own app instead of only the seeded demo — it was
 * the single biggest gap.
 *
 * The crawl needs no API key; the plan step it hands off to does. That split is
 * shown honestly rather than hidden behind a spinner that never resolves.
 */

type Phase = 'form' | 'crawling' | 'done' | 'error';

const FRAMEWORKS = [
  { value: 'PLAYWRIGHT', label: 'Playwright (TypeScript)' },
  { value: 'CYPRESS', label: 'Cypress' },
  { value: 'SELENIUM', label: 'Selenium' },
];

export default function OnboardingPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [framework, setFramework] = useState('PLAYWRIGHT');
  const [envKind, setEnvKind] = useState('STAGING');

  const [phase, setPhase] = useState<Phase>('form');
  const [project, setProject] = useState<Project | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const followCrawl = useCallback((projectId: string) => {
    const source = new EventSource(`${API_URL}/projects/${projectId}/explore/events`, {
      withCredentials: true,
    });

    source.addEventListener('log', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as {
          data: { message?: string };
        };
        if (parsed.data.message) setLog((prev) => [...prev, parsed.data.message!].slice(-200));
      } catch {
        /* ignore a malformed frame */
      }
    });

    // The crawl ends by writing a plan; the run.finished event carries the
    // item count. Poll for the plan too, in case the event is missed.
    source.addEventListener('run.finished', () => {
      source.close();
      setPhase('done');
    });

    const poll = setInterval(async () => {
      const plan = await api<{ plan: { items: unknown[] } }>(`/projects/${projectId}/plan`).catch(
        () => null,
      );
      if (plan) {
        clearInterval(poll);
        source.close();
        setPhase('done');
      }
    }, 3000);

    // Give up after five minutes rather than spin forever if the worker is down.
    const giveUp = setTimeout(() => {
      clearInterval(poll);
      source.close();
      setError(
        'The crawl did not finish. Is the worker running? Check that ANTHROPIC_API_KEY is set for the plan step.',
      );
      setPhase('error');
    }, 5 * 60_000);

    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
      source.close();
    };
  }, []);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    try {
      // One project, one environment, one crawl — the whole first-run in a
      // single submit so nobody has to assemble it by hand.
      const { project } = await api<{ project: Project }>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name, primaryFramework: framework }),
      });
      setProject(project);

      const { environment } = await api<{ environment: { id: string } }>(
        `/projects/${project.id}/environments`,
        {
          method: 'POST',
          body: JSON.stringify({ name: envKind.toLowerCase(), kind: envKind, baseUrl }),
        },
      );

      await api(`/projects/${project.id}/explore`, {
        method: 'POST',
        body: JSON.stringify({ environmentId: environment.id, maxPages: 25, maxDepth: 3 }),
      });

      setPhase('crawling');
      setLog([`Crawling ${baseUrl}…`]);
      followCrawl(project.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not start');
      setPhase('error');
    }
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Add your app</h1>
        <p className="text-ink-dim mt-2">
          QAAI will crawl it, map the flows, and propose a test plan you approve.
        </p>

        {phase === 'form' || phase === 'error' ? (
          <form onSubmit={start} className="mt-10 space-y-5">
            <div>
              <label htmlFor="name" className="mb-1.5 block text-sm font-medium">
                Project name
              </label>
              <input
                id="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Storefront"
                className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
              />
            </div>

            <div>
              <label htmlFor="url" className="mb-1.5 block text-sm font-medium">
                URL to test
              </label>
              <input
                id="url"
                type="url"
                required
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://staging.acme.com"
                className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
              />
              <p className="text-ink-faint mt-1.5 text-xs">
                A staging or preview URL is best. To test the bundled demo, use{' '}
                <button
                  type="button"
                  onClick={() => setBaseUrl('http://localhost:5050')}
                  className="text-accent underline"
                >
                  http://localhost:5050
                </button>
                .
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="framework" className="mb-1.5 block text-sm font-medium">
                  Test framework
                </label>
                <select
                  id="framework"
                  value={framework}
                  onChange={(e) => setFramework(e.target.value)}
                  className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
                >
                  {FRAMEWORKS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="env" className="mb-1.5 block text-sm font-medium">
                  Environment
                </label>
                <select
                  id="env"
                  value={envKind}
                  onChange={(e) => setEnvKind(e.target.value)}
                  className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
                >
                  <option value="LOCAL">Local</option>
                  <option value="PREVIEW">Preview</option>
                  <option value="STAGING">Staging</option>
                  <option value="PRODUCTION">Production</option>
                </select>
              </div>
            </div>

            {error && (
              <p
                role="alert"
                className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              className="bg-accent w-full rounded-md py-2.5 font-medium text-white hover:opacity-90"
            >
              Crawl and propose tests
            </button>
          </form>
        ) : (
          <div className="mt-10">
            <div className="mb-4 flex items-center gap-2">
              {phase === 'crawling' && (
                <span className="bg-accent inline-block h-2 w-2 animate-pulse rounded-full" />
              )}
              {phase === 'done' && <span className="bg-pass inline-block h-2 w-2 rounded-full" />}
              <span className="text-sm font-medium">
                {phase === 'crawling' ? 'Exploring your app…' : 'Crawl complete'}
              </span>
            </div>

            <div
              ref={logRef}
              className="border-line bg-surface-1 h-64 overflow-y-auto rounded-md border p-3 font-mono text-[11px]"
            >
              {log.map((line, i) => (
                <div key={i} className="text-ink-dim">
                  {line}
                </div>
              ))}
            </div>

            {phase === 'done' && project && (
              <Link
                href={`/projects/${project.id}/plan`}
                className="bg-accent mt-5 inline-block rounded-md px-5 py-2.5 font-medium text-white hover:opacity-90"
              >
                Review the proposed plan →
              </Link>
            )}
          </div>
        )}
    </main>
  );
}
