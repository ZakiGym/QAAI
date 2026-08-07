'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Language, TestType, UiFramework } from '@qaai/shared';
import { NEW_TEST_TEMPLATES } from '@qaai/shared';
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
  reconcileFramework,
  suggestStack,
  uploadPayload,
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
   * Something worth saying that is not a failure — currently only the upload
   * trim. Kept apart from `error` because a repo that was too big to send whole
   * still produced a working project, and colouring that red would read as
   * "this did not work" when it did.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [createdTests, setCreatedTests] = useState<CreatedTest[]>([]);

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
   * Everything the chosen path needs, in order, each round trip named.
   *
   * The old screen ran up to three requests behind a single unlabelled press:
   * no busy state, nothing to stop a second click, and a failure halfway
   * through left a project with no environment and no way to tell. Each step
   * below sets `busy` to what it is doing, and the button is disabled while it
   * is set.
   */
  async function finish() {
    if (busy) return;
    setError(null);
    setNotice(null);

    try {
      setBusy('Creating the app…');
      const { project: created } = await api<{ project: Project }>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          primaryLanguage: language,
          primaryFramework: framework,
        }),
      });
      setProject(created);

      // An environment is what a run needs; the URL is optional on every path
      // except the crawl, so this is conditional rather than assumed.
      if (baseUrl.trim()) {
        setBusy('Adding the environment…');
        await api(`/projects/${created.id}/environments`, {
          method: 'POST',
          body: JSON.stringify({
            name: envKind.toLowerCase(),
            kind: envKind,
            baseUrl: baseUrl.trim(),
          }),
        });
      }

      if (path === 'codebase' && codebase) {
        /*
         * The repo goes up as paths plus the contents of the files detection
         * actually reads — readRepo already made that split in the browser, so
         * a monorepo does not become a 200MB POST.
         */
        setBusy('Reading your codebase…');
        /*
         * Trimmed to what the API accepts before it is sent. The read is
         * generous because it happens in this tab; the upload is not, because
         * `express.json` rejects a 2MB body outright and the person would meet
         * that as an unexplained failure at the last step of the funnel.
         */
        const payload = uploadPayload(codebase.files);
        await api(`/projects/${created.id}/source`, {
          method: 'POST',
          body: JSON.stringify({ files: payload.files }),
        });
        if (payload.droppedFiles > 0) {
          setNotice(
            `Sent ${payload.files.length.toLocaleString()} of ${codebase.files.length.toLocaleString()} files — the rest were over the upload limit.`,
          );
        }

        setBusy('Proposing scenarios…');
        await api(`/projects/${created.id}/analyze-source`, {
          method: 'POST',
          body: JSON.stringify({ autoApprove: false }),
        });
      }

      if (path === 'scratch') {
        /*
         * A starter file per chosen type, from the same templates the editor's
         * new-test dialog uses — so "start from scratch" opens on something
         * that runs, not an empty tree. The templates are validated against
         * their runner plugins by a test in packages/shared.
         */
        setBusy('Writing the starter tests…');
        const made: CreatedTest[] = [];
        for (const type of types) {
          const template = NEW_TEST_TEMPLATES[type];
          if (!template) continue;
          const slug = `starter-${type.toLowerCase().replace(/_/g, '-')}`;
          const { test } = await api<{ test: CreatedTest }>(
            `/projects/${created.id}/tests`,
            {
              method: 'POST',
              body: JSON.stringify({
                name: `Starter ${type.toLowerCase().replace(/_/g, ' ')} test`,
                type,
                feature: 'Hand-written',
                priority: 'NICE_TO_HAVE',
                filePath: `hand-written/${slug}${template.fileSuffix}`,
                code: template.code,
                // Spec-driven types carry a spec their plugin validates; the
                // editor's create dialog sends it the same conditional way.
                ...(template.spec !== undefined ? { spec: template.spec } : {}),
              }),
            },
          );
          made.push(test);
        }
        setCreatedTests(made);
      }

      if (path === 'import') {
        // The import screen owns its own upload and conversion; this funnel's
        // job was the project and the stack it converts into.
        router.push(`/import?project=${created.id}`);
        return;
      }

      advance('result');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
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
        <p
          role="alert"
          className="border-fail/40 bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] text-fail text-body-sm mt-5 rounded-md border px-3 py-2"
        >
          {error}
        </p>
      )}

      {step === 'source' && (
        <div className="mt-6">
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
