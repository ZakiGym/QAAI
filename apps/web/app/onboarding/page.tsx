'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Language, TestType, UiFramework } from '@qaai/shared';
import { api, ApiError, type Project } from '../../lib/api';
import { SetupHeader } from '../../components/setup/SetupHeader';
import { Button } from '../../components/ui/Button';
import { Page, Skeleton } from '../../components/ui/layout';
import { CodebaseDrop, type CodebaseResult } from '../../components/onboarding/CodebaseDrop';
import { ChangeableLater, FunnelStepper } from '../../components/onboarding/FunnelStepper';
import { PathPicker } from '../../components/onboarding/PathPicker';
import { ResultStep, type CreatedTest } from '../../components/onboarding/ResultStep';
import { StackStep } from '../../components/onboarding/StackStep';
import { TestTypesStep } from '../../components/onboarding/TestTypesStep';
import {
  DEFAULT_TEST_TYPES,
  nameFromPaths,
  provision,
  reconcileFramework,
  suggestStack,
  type FunnelPath,
} from '../../components/onboarding/funnel';

/**
 * Add app — the first-run funnel.
 *
 * The old screen asked one question ("what URL?") and assumed the answer. That
 * suits exactly one kind of user: somebody with a running staging environment
 * who has already decided QAAI should crawl it. Everyone else — a team with a
 * repo and no deployed URL, a team with an existing suite, a team who wants to
 * write the first test by hand — had to pretend to be that person or leave.
 *
 * So the first question is now WHERE TESTS COME FROM, and the three steps after
 * it narrow rather than interrogate: the stack (pre-filled from the repo when
 * there was one, with the reason shown), the types of test wanted, and then the
 * result. Every step says the choices are changeable in Setup afterwards,
 * because a funnel that reads as a commitment is a funnel people abandon.
 *
 * The four paths are deliberately not four screens: they share a project, a
 * stack and a set of test types, and differ only in what QAAI is given to work
 * from. Keeping them in one stepper is what stops the shared parts drifting.
 */

const STEP_INDEX = { source: 0, stack: 1, types: 2, result: 3 } as const;
type StepName = keyof typeof STEP_INDEX;

/** The order steps unlock in, so the stepper can offer a jump back. */
const ORDER: StepName[] = ['source', 'stack', 'types', 'result'];

/** Only the parts of GET /billing this screen needs: the app cap, and its name. */
interface PlanCap {
  limits: { label: string; maxProjects: number };
  usage: { projects: number };
}

function OnboardingInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  /*
   * `?mode=import` has linked here from the runs list since before this screen
   * had paths at all. It preselects the import card rather than being a
   * separate route: the link's promise was "start an import", and landing on
   * the picker with that choice already made keeps it.
   */
  const [path, setPath] = useState<FunnelPath | null>(
    searchParams.get('mode') === 'import' ? 'import' : null,
  );

  const [step, setStep] = useState<StepName>('source');
  const [furthest, setFurthest] = useState<StepName>('source');

  const [codebase, setCodebase] = useState<CodebaseResult | null>(null);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<Language>('TYPESCRIPT');
  const [framework, setFramework] = useState<UiFramework>('PLAYWRIGHT');
  const [baseUrl, setBaseUrl] = useState('');
  const [envKind, setEnvKind] = useState('STAGING');
  const [types, setTypes] = useState<ReadonlySet<TestType>>(new Set(DEFAULT_TEST_TYPES));

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The one thing to do about the error, when there is one.
   *
   * Only the plan cap sets this so far, and it is the reason it exists: "You
   * have used all 1 project included with Free" is not actionable text, it is a
   * dead end at the end of a four-step form.
   */
  const [errorAction, setErrorAction] = useState<{ label: string; href: string } | null>(null);
  /**
   * Something worth saying that is not a failure — currently only the upload
   * trim. Kept apart from `error` because a repo that was too big to send whole
   * still produced a working project, and colouring that red would read as
   * "this did not work" when it did.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [createdTests, setCreatedTests] = useState<CreatedTest[]>([]);

  /**
   * The project cap, asked BEFORE the form rather than discovered by the 402 at
   * the end of it.
   *
   * A Free org is allowed one app. Every step of this funnel worked for someone
   * who already had one — the picker, the folder read, the stack, the types —
   * and the refusal arrived after all of it, on the press that was meant to
   * finish. Reading /billing on arrival costs one request and turns that into a
   * sentence on step 1. Failures are swallowed on purpose: an unreachable
   * billing endpoint must not stop somebody adding their first app, and the
   * 402 handler below is still there as the backstop.
   */
  const [cap, setCap] = useState<PlanCap | null>(null);
  useEffect(() => {
    let live = true;
    api<PlanCap>('/billing')
      .then((billing) => {
        if (live) setCap(billing);
      })
      .catch(() => {
        /* the notice simply does not appear; creating still reports the cap */
      });
    return () => {
      live = false;
    };
  }, []);
  const atProjectCap = cap !== null && cap.usage.projects >= cap.limits.maxProjects;

  const suggestion = useMemo(
    () => (codebase ? suggestStack(codebase.detection) : null),
    [codebase],
  );

  /**
   * Accept a repo pick: adopt what it implies, without overwriting what the
   * person has already typed.
   *
   * A pre-filled field is a suggestion; a field that overwrites an edit is a
   * bug. Hence the `||` guards — the name and stack move only while they are
   * still at their defaults.
   */
  const onCodebase = useCallback((result: CodebaseResult | null) => {
    setCodebase(result);
    setError(null);
    if (!result) return;

    setName((current) => current || nameFromPaths(result.paths) || '');
    const stack = suggestStack(result.detection);
    if (stack) {
      setLanguage(stack.language);
      setFramework(stack.framework);
    }
  }, []);

  const onLanguage = useCallback((next: Language) => {
    setLanguage(next);
    // The API refuses a pair its generator cannot emit, so the framework
    // follows the language here rather than letting the person build an
    // invalid pair and meet the refusal after they press the button.
    setFramework((current) => reconcileFramework(next, current));
  }, []);

  const toggleType = useCallback((type: TestType) => {
    setTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  function advance(to: StepName) {
    setStep(to);
    if (ORDER.indexOf(to) > ORDER.indexOf(furthest)) setFurthest(to);
  }

  const canLeaveSource =
    path !== null && (path !== 'codebase' || codebase !== null);
  const canLeaveStack =
    name.trim().length > 0 && (path !== 'url' || baseUrl.trim().length > 0);

  /**
   * Everything the chosen path needs, in order — see `provision`.
   *
   * The requests themselves live in funnel.ts because a request that is never
   * SENT renders identically to one that was, and this component cannot be
   * unit-tested. That is not a hypothetical: the crawl this funnel's `url` path
   * exists to start went missing for a release, and the screen looked right the
   * whole time.
   */
  async function finish() {
    if (busy || !path) return;
    setError(null);
    setErrorAction(null);
    setNotice(null);

    try {
      const result = await provision<Project>(
        { api, onBusy: setBusy, onProject: setProject },
        {
          path,
          name,
          language,
          framework,
          baseUrl,
          envKind,
          types: [...types],
          files: codebase?.files ?? null,
        },
      );

      setNotice(result.notice);
      setCreatedTests(result.createdTests);

      if (result.next === 'import') {
        router.push(`/import?project=${result.project.id}`);
        return;
      }

      advance('result');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      /*
       * The plan cap, met at the last step. The API's sentence is the honest
       * one — it names the plan and the number — but on its own it leaves the
       * person on a form they can no longer submit, so it gets the one link
       * that changes the answer. The notice on step 1 usually gets there first;
       * this is what catches an org that filled a slot in another tab.
       */
      if (err instanceof ApiError && err.status === 402) {
        setError(err.message);
        setErrorAction({ label: 'See plans', href: '/settings/billing' });
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not finish setting up');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page width="setup">
      <SetupHeader />

      <div className="mt-7">
        <FunnelStepper
          current={STEP_INDEX[step]}
          furthest={STEP_INDEX[furthest]}
          onJump={(index) => {
            // Backwards only, and never once the project exists — the earlier
            // steps describe decisions that have already been acted on.
            if (project) return;
            const target = ORDER[index];
            if (target && index <= STEP_INDEX[furthest]) setStep(target);
          }}
        />
      </div>

      {notice && !error && (
        <p className="border-line bg-surface-1 text-ink-dim text-body-sm mt-5 rounded-md border px-3 py-2">
          {notice}
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="border-fail/40 bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] text-fail text-body-sm mt-5 rounded-md border px-3 py-2"
        >
          <p>{error}</p>
          {errorAction && (
            <Link
              href={errorAction.href}
              className="mt-1.5 inline-block font-semibold underline underline-offset-2"
            >
              {errorAction.label} →
            </Link>
          )}
        </div>
      )}

      {step === 'source' && (
        <div className="mt-6">
          {/*
            Said here, on the first step, rather than by a 402 on the last one.
            Not a blocker — the plan can be changed in another tab and the
            funnel picked up where it was left — so this is a notice with a
            link, not a disabled Continue.
          */}
          {atProjectCap && cap && (
            <div className="border-flake/40 text-body-sm mb-5 rounded-md border bg-[color-mix(in_srgb,var(--color-flake)_8%,transparent)] px-3 py-2">
              <p className="text-ink-dim">
                Your {cap.limits.label} plan includes{' '}
                <span className="tabular-nums">{cap.limits.maxProjects}</span> app
                {cap.limits.maxProjects === 1 ? '' : 's'}, and you already have{' '}
                <span className="tabular-nums">{cap.usage.projects}</span>. Setting this one up will
                be refused at the last step unless you upgrade first.
              </p>
              <Link
                href="/settings/billing"
                className="text-accent mt-1.5 inline-block font-semibold underline underline-offset-2"
              >
                See plans →
              </Link>
            </div>
          )}

          <PathPicker value={path} onChange={setPath}>
            {(choice) =>
              choice === 'codebase' ? (
                <CodebaseDrop result={codebase} onResult={onCodebase} />
              ) : null
            }
          </PathPicker>

          <div className="mt-7 flex items-center gap-3">
            <Button
              variant="primary"
              disabled={!canLeaveSource}
              onClick={() => advance('stack')}
            >
              Continue
            </Button>
            {path === 'codebase' && !codebase && (
              <span className="text-ink-faint text-row-sub">
                Pick the folder your application lives in.
              </span>
            )}
          </div>
          <ChangeableLater />
        </div>
      )}

      {step === 'stack' && (
        <div className="mt-6">
          <StackStep
            name={name}
            onName={setName}
            language={language}
            framework={framework}
            onLanguage={onLanguage}
            onFramework={setFramework}
            suggestion={suggestion}
            baseUrl={baseUrl}
            onBaseUrl={setBaseUrl}
            urlRequired={path === 'url'}
            envKind={envKind}
            onEnvKind={setEnvKind}
            disabled={busy !== null}
          />

          <div className="mt-7 flex items-center gap-3">
            <Button variant="secondary" onClick={() => setStep('source')}>
              Back
            </Button>
            <Button variant="primary" disabled={!canLeaveStack} onClick={() => advance('types')}>
              Continue
            </Button>
          </div>
          <ChangeableLater />
        </div>
      )}

      {step === 'types' && (
        <div className="mt-6">
          <TestTypesStep
            selected={types}
            onToggle={toggleType}
            onClear={() => setTypes(new Set())}
            disabled={busy !== null}
          />

          <div className="mt-7 flex items-center gap-3">
            <Button variant="secondary" disabled={busy !== null} onClick={() => setStep('stack')}>
              Back
            </Button>
            <Button
              variant="primary"
              loading={busy !== null}
              disabled={types.size === 0}
              onClick={() => void finish()}
            >
              {busy ?? 'Set up my app'}
            </Button>
            {types.size === 0 && (
              <span className="text-ink-faint text-row-sub">Pick at least one kind of test.</span>
            )}
          </div>
          <ChangeableLater />
        </div>
      )}

      {step === 'result' && project && (
        <ResultStep
          path={path ?? 'scratch'}
          projectId={project.id}
          projectName={project.name}
          language={language}
          framework={framework}
          codebase={codebase}
          baseUrl={path === 'url' ? baseUrl.trim() : ''}
          createdTests={createdTests}
          selectedTypes={[...types]}
          onCrawlError={setError}
        />
      )}
    </Page>
  );
}

export default function OnboardingPage() {
  return (
    /*
     * `?mode=import` is read with useSearchParams, which `next build` refuses to
     * prerender without a boundary above it. This has broken the build twice.
     */
    <Suspense
      fallback={
        <Page width="setup">
          <SetupHeader />
          <Skeleton className="mt-8 h-64 w-full" />
        </Page>
      }
    >
      <OnboardingInner />
    </Suspense>
  );
}
