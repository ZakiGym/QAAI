'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { API_URL, api, ApiError, type Project } from '../../lib/api';
import { SetupHeader } from '../../components/setup/SetupHeader';
import { clock } from '../../components/setup/time';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Page, SectionLabel, Skeleton } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

/**
 * Add app (§10) — the first-run path the spec targets at "under 15 minutes".
 *
 * Four steps, and the stepper says which one you are in: name the app, point it
 * at a URL, watch the Explorer crawl live, then land on the plan to approve.
 * This is the flow that makes the product usable on your own app instead of only
 * the seeded demo — it was the single biggest gap.
 *
 * The crawl needs no API key; the plan step it hands off to does. That split is
 * shown honestly rather than hidden behind a spinner that never resolves.
 */

type Phase = 'form' | 'starting' | 'crawling' | 'stopped' | 'done' | 'error';

const FRAMEWORKS = [
  { value: 'PLAYWRIGHT', label: 'Playwright (TypeScript)' },
  { value: 'CYPRESS', label: 'Cypress' },
  { value: 'SELENIUM', label: 'Selenium' },
];

/** How long without a new log line before the screen says so, in ms. */
const QUIET_MS = 20_000;

function OnboardingInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [framework, setFramework] = useState('PLAYWRIGHT');
  const [envKind, setEnvKind] = useState('STAGING');

  const [phase, setPhase] = useState<Phase>('form');
  /** What the submit is doing right now — three round-trips, named one by one. */
  const [step, setStep] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  /*
   * The crawl's own clock. It exists because the Explorer can genuinely sit for
   * minutes on a slow app, and a log that has not moved for ninety seconds is
   * indistinguishable from a worker that died — the screen said nothing either
   * way, so people reloaded and started a second crawl.
   */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastLogAt, setLastLogAt] = useState<number>(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

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
    setLastLogAt(Date.now());
  }, [log]);

  // Ticks only while something is actually in flight.
  useEffect(() => {
    if (phase !== 'crawling') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const followCrawl = useCallback((projectId: string) => {
    const source = new EventSource(`${API_URL}/projects/${projectId}/explore/events`, {
      withCredentials: true,
    });

    source.addEventListener('log', (event) => {
      try {
        const parsed = JSON.parse(event.data) as {
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

    const poll = setInterval(() => {
      void (async () => {
        const plan = await api<{ plan: { items: unknown[] } }>(`/projects/${projectId}/plan`).catch(
          () => null,
        );
        if (plan) {
          stop();
          setPhase('done');
        }
      })();
    }, 3000);

    /*
     * Give up after five minutes rather than spin forever if the worker is
     * down — but do not guess at why. This used to assert "The crawl did not
     * finish" flatly, and the most common way to reach it was a crawl that had
     * finished perfectly and was already in the database. Ask the flow map
     * whether that happened before saying anything.
     */
    const giveUp = setTimeout(() => {
      stop();
      void api<{ flowMap: { version: number; nodeCount: number } }>(
        `/projects/${projectId}/flow-map`,
      )
        .then((result) => {
          setError(
            `The crawl finished — flow map v${result.flowMap.version}, ${result.flowMap.nodeCount} states — but no test plan was written from it. That step runs in the worker: check that it is running and read its log for the reason.`,
          );
        })
        .catch(() => {
          setError(
            'The crawl did not finish and no flow map was written. Is the worker running? Its log will say what stopped.',
          );
        })
        .finally(() => setPhase('error'));
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
    // Three round-trips used to happen with no feedback and nothing stopping a
    // second press — which created a second project on the retry path, or hit
    // the Free plan's one-project cap and reported it as a failure to crawl.
    if (phase === 'starting') return;
    setError(null);
    setPhase('starting');

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
      setStep(existing ? 'Reusing the app you already created…' : 'Creating the app…');
      const created =
        existing ??
        (
          await api<{ project: Project }>('/projects', {
            method: 'POST',
            body: JSON.stringify({ name, primaryFramework: framework }),
          })
        ).project;
      setProject(created);

      setStep('Setting up the environment…');
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

      setStep('Starting the crawl…');
      await api(`/projects/${created.id}/explore`, {
        method: 'POST',
        body: JSON.stringify({ environmentId: environment.id, maxPages: 25, maxDepth: 3 }),
      });

      setStep(null);
      setPhase('crawling');
      setLog([`Crawling ${baseUrl}…`]);
      setStartedAt(Date.now());
      setNow(Date.now());
      stopWatchingRef.current = followCrawl(created.id);
    } catch (err) {
      setStep(null);
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not start');
      setPhase('error');
    }
  }

  function watchAgain() {
    if (!project) return;
    setPhase('crawling');
    setStartedAt((at) => at ?? Date.now());
    setNow(Date.now());
    stopWatchingRef.current = followCrawl(project.id);
  }

  // Mid-redirect to /import — rendering the crawl form here would flash the
  // exact screen the parameter says the user did not want.
  if (mode === 'import') return null;

  const editing = phase === 'form' || phase === 'starting' || phase === 'error';
  const quietFor = phase === 'crawling' ? Math.floor((now - lastLogAt) / 1000) : 0;

  return (
    <div className="mt-7">
      <Stepper phase={phase} />

        <div className="mt-6 grid gap-7 md:grid-cols-[minmax(240px,340px)_minmax(280px,1fr)]">
          {/* ── The app ──────────────────────────────────────────────────── */}
          <div>
            <SectionLabel>The app</SectionLabel>

            {editing ? (
              <form onSubmit={start} className="space-y-4">
                <Field
                  id="name"
                  label="Name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Storefront"
                  disabled={phase === 'starting'}
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
                    className="font-mono"
                    disabled={phase === 'starting'}
                  />
                  {/* Not the Field's own `hint`, because this one has a control in it. */}
                  <p id="url-hint" className="text-ink-faint text-micro mt-1.5">
                    A staging or preview URL is best. To test the bundled demo, use{' '}
                    <button
                      type="button"
                      onClick={() => setBaseUrl('http://localhost:5050')}
                      className="text-accent font-mono underline"
                    >
                      http://localhost:5050
                    </button>
                    .
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="framework"
                      className="text-meta text-ink-faint mb-2 block font-mono tracking-[0.08em] uppercase"
                    >
                      Framework
                    </label>
                    <select
                      id="framework"
                      value={framework}
                      onChange={(e) => setFramework(e.target.value)}
                      disabled={phase === 'starting'}
                      className="border-line text-row-sub focus:border-accent w-full rounded-md border bg-transparent px-2.5 py-2 outline-none transition-colors"
                    >
                      {FRAMEWORKS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="env"
                      className="text-meta text-ink-faint mb-2 block font-mono tracking-[0.08em] uppercase"
                    >
                      Environment
                    </label>
                    <select
                      id="env"
                      value={envKind}
                      onChange={(e) => setEnvKind(e.target.value)}
                      disabled={phase === 'starting'}
                      className="border-line text-row-sub focus:border-accent w-full rounded-md border bg-transparent px-2.5 py-2 outline-none transition-colors"
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
                    className="border-fail/40 text-fail text-row-sub rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3"
                  >
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  variant="primary"
                  className="w-full"
                  loading={phase === 'starting'}
                >
                  {phase === 'error' ? 'Try again' : 'Crawl and propose tests'}
                </Button>

                {step && (
                  <p className="text-ink-dim text-micro font-mono" aria-live="polite">
                    {step}
                  </p>
                )}
              </form>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="border-line bg-surface-1 rounded-md border px-3 py-2 text-[13px]">
                  {project?.name ?? name}
                </span>
                <span className="border-line bg-surface-1 rounded-md border px-3 py-2 font-mono text-[11.5px] break-all">
                  {baseUrl}
                </span>
                <span className="border-line bg-surface-1 text-ink-dim rounded-md border px-3 py-2 text-[12.5px]">
                  {FRAMEWORKS.find((f) => f.value === framework)?.label ?? framework} ·{' '}
                  {envKind.toLowerCase()}
                </span>
              </div>
            )}

            <p className="text-ink-faint mt-2.5 text-[11.5px]">
              The crawl needs no API key; writing the plan does. That split is shown, not hidden
              behind a spinner.
            </p>
          </div>

          {/* ── The Explorer ─────────────────────────────────────────────── */}
          <div>
            <SectionLabel>
              Explorer{' '}
              <span className={phase === 'done' ? 'text-pass' : undefined}>
                · {phase === 'crawling' ? 'live' : phase === 'done' ? 'finished' : 'idle'}
              </span>
              {phase === 'crawling' && (
                <span className="bg-accent ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full align-middle" />
              )}
            </SectionLabel>

            {log.length === 0 ? (
              <div className="border-line text-ink-faint text-micro rounded-lg border border-dashed px-3.5 py-6 leading-relaxed">
                The Explorer&apos;s log appears here — every page it visits, every form it finds, and
                every auth wall it records rather than crosses.
              </div>
            ) : (
              <div
                ref={logRef}
                className="border-line bg-surface-1 max-h-[220px] overflow-y-auto rounded-lg border px-3.5 py-3 font-mono text-[10.5px] leading-[1.8]"
              >
                {log.map((line, i) => (
                  <p
                    key={i}
                    className={i === log.length - 1 ? 'text-ink-dim' : 'text-ink-faint'}
                  >
                    {line}
                  </p>
                ))}
              </div>
            )}

            {/* The progress signal. Elapsed alone answers "is it stuck?"; the
                quiet counter answers "has it stopped?" — different questions. */}
            {phase === 'crawling' && (
              <p
                className="text-ink-faint text-micro mt-2.5 font-mono tabular-nums"
                aria-live="polite"
              >
                {log.length} line{log.length === 1 ? '' : 's'} ·{' '}
                {clock(now - (startedAt ?? now))} · stops at 5m or when the frontier is empty
                {quietFor >= QUIET_MS / 1000 && (
                  <span className="text-flake"> · still going — nothing new for {quietFor}s</span>
                )}
              </p>
            )}

            {phase === 'crawling' && (
              <p className="mt-2">
                <button
                  type="button"
                  onClick={() => {
                    stopWatchingRef.current?.();
                    stopWatchingRef.current = null;
                    setPhase('stopped');
                  }}
                  className="text-ink-faint hover:text-ink text-[12px] transition-colors"
                >
                  stop watching
                </button>
              </p>
            )}

            {phase === 'stopped' && (
              <div className="mt-2.5">
                <p className="text-ink-dim text-row-sub leading-relaxed">
                  Stopped watching. The crawl itself keeps running in the worker — nothing was
                  cancelled, and the flow map fills in when it finishes.
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button size="sm" onClick={watchAgain}>
                    Watch again
                  </Button>
                  <Link
                    href="/flow-map"
                    className="border-line text-ink-dim hover:text-ink hover:border-line-strong inline-flex items-center rounded-md border px-[11px] py-[5px] text-[12px] transition-colors"
                  >
                    Open the flow map
                  </Link>
                </div>
              </div>
            )}

            {phase === 'done' && project && (
              <div className="mt-3">
                <Link
                  href={`/projects/${project.id}/plan`}
                  className="bg-accent text-accent-ink text-row-sub inline-block rounded-md px-3.5 py-[7px] font-semibold hover:opacity-90"
                >
                  Review the proposed plan →
                </Link>
                <p className="text-ink-faint text-micro mt-2 font-mono">
                  writing the plan is the step that needs an API key
                </p>
              </div>
            )}

            {/*
              The error phase re-renders the form, which used to throw away the
              crawl log with it — leaving someone who just watched twelve pages
              get visited with a bare error and no evidence of what happened. It
              is the only record of the crawl the screen has; keep it.
            */}
            {phase === 'error' && log.length > 0 && (
              <p className="text-ink-faint text-micro mt-2.5 font-mono">
                the log above is what the crawl reported before it stopped
              </p>
            )}
        </div>
      </div>
    </div>
  );
}

/**
 * Where you are in the four steps.
 *
 * Derived from the phase rather than tracked separately — a stepper that can
 * disagree with the screen it labels is worse than no stepper.
 */
function Stepper({ phase }: { phase: Phase }) {
  // The URL is only "pointed at" once the crawl has actually been accepted, so
  // `starting` still counts as being on step one.
  const pointed = phase === 'crawling' || phase === 'stopped' || phase === 'done';
  const crawled = phase === 'done';
  const states: ReadonlyArray<'done' | 'active' | 'pending'> = [
    pointed ? 'done' : 'active',
    crawled ? 'done' : pointed ? 'active' : 'pending',
    crawled ? 'active' : 'pending',
    'pending',
  ];
  const steps = ['POINT', 'CRAWL', 'PLAN', 'FIRST RUN'].map((label, i) => ({
    label,
    state: states[i]!,
  }));

  return (
    <ol className="flex flex-wrap font-mono text-[10.5px] tracking-[0.06em]">
      {steps.map((s, i) => (
        <li
          key={s.label}
          className={cn(
            'flex items-center gap-[7px] px-[18px] first:pr-[18px] first:pl-0',
            i > 0 && 'border-line border-l',
            s.state === 'done' && 'text-pass',
            s.state === 'active' && 'text-ink',
            s.state === 'pending' && 'text-ink-faint',
          )}
          aria-current={s.state === 'active' ? 'step' : undefined}
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px]',
              s.state === 'done' && 'bg-[color-mix(in_srgb,var(--color-pass)_15%,transparent)]',
              s.state === 'active' && 'bg-accent text-accent-ink',
              s.state === 'pending' && 'border-line border',
            )}
          >
            {s.state === 'done' ? '✓' : i + 1}
          </span>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

/**
 * `useSearchParams()` forces a client-side bailout, and Next refuses to
 * statically prerender a page that does so without a Suspense boundary — it
 * failed the production build outright ("useSearchParams() should be wrapped in
 * a suspense boundary"). The boundary lets the shell prerender and the
 * param-dependent part hydrate on the client.
 *
 * The header stays OUTSIDE it, and that placement is load-bearing rather than
 * cosmetic: it carries the shell's tab-strip slot, which the shell fills from an
 * effect. Inside the boundary, that effect fires while this subtree is still
 * queued for hydration, React finds a `<nav>` in a node it rendered empty, and
 * throws the whole page away and re-renders it. Outside, the slot hydrates in
 * the first pass, before any effect runs.
 */
export default function OnboardingPage() {
  return (
    <Page width="setup">
      <SetupHeader />
      <Suspense
        fallback={
          <div className="mt-7 space-y-3" role="status" aria-label="Loading">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        }
      >
        <OnboardingInner />
      </Suspense>
    </Page>
  );
}
