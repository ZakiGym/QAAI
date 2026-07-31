'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { API_URL, api, ApiError, type Project } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Page, PageHeader } from '../../components/ui/layout';

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

function OnboardingInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [framework, setFramework] = useState('PLAYWRIGHT');
  const [envKind, setEnvKind] = useState('STAGING');

  const [phase, setPhase] = useState<Phase>('form');
  const [project, setProject] = useState<Project | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  /**
   * Teardown for the in-flight crawl watcher. followCrawl returns one, and it
   * used to be dropped on the floor — so the five-minute give-up timer fired
   * even after a successful crawl, flipping a user reading their plan back to
   * an empty form with a false "the crawl did not finish" error.
   */
  const stopWatchingRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWatchingRef.current?.(), []);

  /**
   * "Import existing tests" on /runs links here with ?mode=import, and this
   * screen ignored the parameter entirely — so someone who said they already
   * have a suite landed on the crawl form and was asked to point us at a URL
   * instead. The parameter has one meaning: you are here to import.
   */
  const mode = searchParams.get('mode');
  useEffect(() => {
    if (mode === 'import') router.replace('/import');
  }, [mode, router]);

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
      stop();
      setPhase('done');
    });

    const poll = setInterval(async () => {
      const plan = await api<{ plan: { items: unknown[] } }>(`/projects/${projectId}/plan`).catch(
        () => null,
      );
      if (plan) {
        stop();
        setPhase('done');
      }
    }, 3000);

    // Give up after five minutes rather than spin forever if the worker is down.
    const giveUp = setTimeout(() => {
      stop();
      setError(
        'The crawl did not finish. Is the worker running? Check that ANTHROPIC_API_KEY is set for the plan step.',
      );
      setPhase('error');
    }, 5 * 60_000);

    function stop() {
      clearInterval(poll);
      clearTimeout(giveUp);
      source.close();
    }

    return stop;
  }, []);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    try {
      /**
       * One project, one environment, one crawl — the whole first-run in a
       * single submit so nobody has to assemble it by hand.
       *
       * Each step reuses what already exists rather than re-creating it. This
       * matters on the retry path: creating the project and then failing at the
       * environment used to leave a project behind, and resubmitting hit "slug
       * already exists" (and, on the Free plan, "1 project allowed") forever.
       */
      const existing = project;
      const created =
        existing ??
        (
          await api<{ project: Project }>('/projects', {
            method: 'POST',
            body: JSON.stringify({ name, primaryFramework: framework }),
          })
        ).project;
      setProject(created);

      const environments = await api<{ environments: Array<{ id: string; baseUrl: string }> }>(
        `/projects/${created.id}/environments`,
      ).catch(() => ({ environments: [] as Array<{ id: string; baseUrl: string }> }));

      const environment =
        environments.environments[0] ??
        (
          await api<{ environment: { id: string } }>(`/projects/${created.id}/environments`, {
            method: 'POST',
            body: JSON.stringify({ name: envKind.toLowerCase(), kind: envKind, baseUrl }),
          })
        ).environment;

      await api(`/projects/${created.id}/explore`, {
        method: 'POST',
        body: JSON.stringify({ environmentId: environment.id, maxPages: 25, maxDepth: 3 }),
      });

      setPhase('crawling');
      setLog([`Crawling ${baseUrl}…`]);
      stopWatchingRef.current = followCrawl(created.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not start');
      setPhase('error');
    }
  }

  // Mid-redirect to /import — rendering the crawl form here would flash the
  // exact screen the parameter says the user did not want.
  if (mode === 'import') return null;

  return (
    <Page width="narrow">
      <PageHeader
        title="Add your app"
        subtitle="QAAI will crawl it, map the flows, and propose a test plan you approve."
      />

      {phase === 'form' || phase === 'error' ? (
        <form onSubmit={start} className="space-y-5">
          <Field
            id="name"
            label="Project name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Storefront"
          />

          <div>
            <Field
              id="url"
              label="URL to test"
              type="url"
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://staging.acme.com"
              aria-describedby="url-hint"
            />
            {/* Not the Field's own `hint`, because this one has a control in it. */}
            <p id="url-hint" className="text-ink-faint mt-1.5 text-xs">
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
              <label htmlFor="framework" className="text-ink-dim text-body-sm mb-1.5 block">
                Test framework
              </label>
              <select
                id="framework"
                value={framework}
                onChange={(e) => setFramework(e.target.value)}
                className="border-line bg-surface-1 text-body-sm focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
              >
                {FRAMEWORKS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="env" className="text-ink-dim text-body-sm mb-1.5 block">
                Environment
              </label>
              <select
                id="env"
                value={envKind}
                onChange={(e) => setEnvKind(e.target.value)}
                className="border-line bg-surface-1 text-body-sm focus:border-accent w-full rounded-md border px-3 py-2 outline-none"
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

          <Button type="submit" variant="primary" className="w-full">
            Crawl and propose tests
          </Button>
        </form>
      ) : (
        <div>
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
            className="border-line bg-surface-1 h-64 overflow-y-auto rounded-md border p-3 font-mono text-micro"
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
    </Page>
  );
}

/**
 * `useSearchParams()` forces a client-side bailout, and Next refuses to
 * statically prerender a page that does so without a Suspense boundary — it
 * failed the production build outright ("useSearchParams() should be wrapped in
 * a suspense boundary"). The boundary lets the shell prerender and the
 * param-dependent part hydrate on the client.
 */
export default function OnboardingPage() {
  return (
    <Suspense fallback={<main className="text-ink-faint p-10 text-body-sm">Loading…</main>}>
      <OnboardingInner />
    </Suspense>
  );
}
