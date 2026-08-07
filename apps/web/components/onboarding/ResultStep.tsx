'use client';

import Link from 'next/link';
import {
  LANGUAGE_LABELS,
  UI_FRAMEWORK_LABELS,
  type Language,
  type TestType,
  type UiFramework,
} from '@qaai/shared';
import { SectionLabel } from '../ui/layout';
import { CrawlPanel } from './CrawlPanel';
import { splitByModelNeed } from './funnel';
import type { CodebaseResult } from './CodebaseDrop';
import type { FunnelPath } from './funnel';

export interface CreatedTest {
  id: string;
  name: string;
  filePath: string;
  type: TestType;
}

/**
 * Step 4 — what happened, and what is true now.
 *
 * Three separate claims, kept separate on purpose, because conflating them is
 * how a first-run screen starts lying:
 *
 *  1. What QAAI LEARNED from the repo. Real, and narrow: detection reads the
 *     envelope — languages, package managers, workspaces, whether a runner is
 *     configured. It never opens a route, a component or an endpoint, so it
 *     cannot propose a scenario, and this section says so rather than letting
 *     "we learned your codebase" imply more than happened.
 *  2. What was CREATED. Files that exist, at paths that open.
 *  3. What QAAI PROPOSES. That comes from the crawl, because behaviour is the
 *     thing a static read cannot supply.
 */
export function ResultStep({
  path,
  projectId,
  projectName,
  language,
  framework,
  codebase,
  baseUrl,
  createdTests,
  selectedTypes,
  onCrawlError,
}: {
  path: FunnelPath;
  projectId: string;
  projectName: string;
  language: Language;
  framework: UiFramework;
  codebase: CodebaseResult | null;
  /** Empty when no crawl was started — the URL was optional on this path. */
  baseUrl: string;
  createdTests: CreatedTest[];
  selectedTypes: readonly TestType[];
  onCrawlError: (message: string) => void;
}) {
  const split = splitByModelNeed(selectedTypes);

  return (
    <div className="mt-5 space-y-7">
      {codebase && <Learned codebase={codebase} />}

      <section>
        <SectionLabel>What was set up</SectionLabel>
        <dl className="border-line divide-line divide-y rounded-lg border text-[12.5px]">
          <Row label="App">{projectName}</Row>
          <Row label="Suite written in">
            {LANGUAGE_LABELS[language]} · {UI_FRAMEWORK_LABELS[framework]}
          </Row>
          <Row label="Starter tests">
            {createdTests.length === 0 ? (
              <span className="text-ink-faint">
                none — you skipped the test types, and the editor opens empty
              </span>
            ) : (
              <ul className="space-y-1">
                {createdTests.map((test) => (
                  <li key={test.id}>
                    <Link
                      href={`/editor?test=${test.id}`}
                      className="hover:text-ink font-mono text-[11.5px] underline underline-offset-2"
                    >
                      {test.filePath}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Row>
          {baseUrl && <Row label="Pointed at">{baseUrl}</Row>}
        </dl>

        {createdTests.length > 0 && (
          <p className="text-ink-faint text-micro mt-2 leading-relaxed">
            Every one of those is runnable now — each template is held to its own runner plugin&apos;s
            validator by a test, so none of them fails its first run with &ldquo;invalid spec&rdquo;.
          </p>
        )}
      </section>

      {baseUrl ? (
        <section>
          <CrawlPanel projectId={projectId} baseUrl={baseUrl} onError={onCrawlError} />
          {split.needsModel.length > 0 && (
            <p className="text-ink-faint text-micro mt-2.5 leading-relaxed">
              Of the types you picked, {split.modelFree.length > 0 && (
                <>
                  <span className="text-pass">{split.modelFree.length}</span> can be written
                  straight from the crawl, and{' '}
                </>
              )}
              <span className="text-flake">{split.needsModel.length}</span> wait on{' '}
              <code className="font-mono">ANTHROPIC_API_KEY</code>. The plan proposes them either
              way — approving is what queues them.
            </p>
          )}
        </section>
      ) : (
        <section>
          <SectionLabel>What QAAI can propose next</SectionLabel>
          <p className="text-ink-dim text-row-sub leading-relaxed">
            {path === 'codebase'
              ? 'QAAI is reading your source now — the routes, endpoints, forms and auth surfaces it declares — and proposing a test for each claim the code makes. Nothing is rendered and no request is sent, so the plan describes what your code SAYS it does. Point the Explorer at a running URL to find out whether it holds.'
              : 'Nothing is pointed at an app yet, so there is nothing to explore. Add an environment and the Explorer will crawl it and propose a plan.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {path === 'codebase' && (
              <Link
                href={`/projects/${projectId}/plan`}
                className="border-line hover:border-line-strong text-ink-dim hover:text-ink rounded-md border px-3 py-1.5 text-[12px] transition-colors"
              >
                Review the proposed plan →
              </Link>
            )}
            <Link
              href="/environments"
              className="bg-accent text-accent-ink text-row-sub inline-block rounded-md px-3.5 py-[7px] font-semibold hover:opacity-90"
            >
              Add a URL to crawl →
            </Link>
            <Link
              href="/editor"
              className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-row-sub inline-flex items-center rounded-md border px-3.5 py-[7px]"
            >
              Open the editor
            </Link>
          </div>
        </section>
      )}

      <section>
        <SectionLabel>Where to go from here</SectionLabel>
        <ul className="text-ink-dim divide-line divide-y text-[12.5px]">
          <Next href="/editor" label="Editor">
            Write and edit tests by hand. Your starter files are already in it.
          </Next>
          <Next href="/runs" label="Runs">
            Run a suite and watch the results land.
          </Next>
          <Next href="/import" label="Import">
            Still have a Cypress or Selenium suite somewhere? Convert it in.
          </Next>
          <Next href="/environments" label="Setup">
            Change the language, the framework, the URL — none of it was locked in.
          </Next>
        </ul>
      </section>
    </div>
  );
}

/** The narrow, real claim: what a static read of a repo can and cannot say. */
function Learned({ codebase }: { codebase: CodebaseResult }) {
  const { detection } = codebase;
  const languages = detection.languages.filter((l) => l.fileCount > 0).slice(0, 4);
  const runner = detection.candidates[0];

  return (
    <section>
      <SectionLabel>What QAAI learned from your repo</SectionLabel>
      <dl className="border-line divide-line divide-y rounded-lg border text-[12.5px]">
        <Row label="Read">
          <span className="tabular-nums">{codebase.seen.toLocaleString()}</span> files listed ·{' '}
          <span className="tabular-nums">{codebase.read}</span> manifest
          {codebase.read === 1 ? '' : 's'} opened · none uploaded
        </Row>
        <Row label="Languages">
          {languages.length === 0
            ? 'none recognised'
            : languages.map((l) => `${l.language.toLowerCase()} (${l.fileCount})`).join(' · ')}
        </Row>
        <Row label="Workspaces">
          {detection.roots.join(', ')}
          {detection.monorepo && <span className="text-ink-faint"> · monorepo</span>}
        </Row>
        <Row label="Existing tests">
          {detection.hasTests && runner ? (
            <>
              {runner.label} · <span className="tabular-nums">{runner.testFileCount}</span> file
              {runner.testFileCount === 1 ? '' : 's'} under{' '}
              <span className="font-mono text-[11.5px]">
                {runner.testDirs.slice(0, 2).join(', ') || runner.root}
              </span>
            </>
          ) : (
            <span className="text-ink-faint">
              none found — QAAI is not claiming this repo has tests
            </span>
          )}
        </Row>
      </dl>

      {/*
        The limit, stated where the claim is made. Detection is a read of a file
        listing: it knows the repo is Next.js-shaped TypeScript with pnpm
        workspaces, and it knows nothing whatever about what the app does. Saying
        "QAAI learned your codebase" and stopping there would be the single most
        misleading sentence on this screen.
      */}
      <p className="text-ink-faint text-micro mt-2 leading-relaxed">
        That is the shape of the repo, not the behaviour of the app. Detection reads manifests and
        paths — it never opens a route, a component or an endpoint — so it can configure QAAI to
        your stack but cannot invent a scenario from it.
      </p>

      {detection.hasTests && (
        <p className="text-ink-dim text-micro mt-2 leading-relaxed">
          You already have a suite. Bringing it in through{' '}
          <Link href="/import" className="text-accent underline underline-offset-2">
            Import
          </Link>{' '}
          converts it rather than duplicating it.
        </p>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[130px_1fr] sm:gap-3">
      <dt className="text-ink-faint text-micro font-mono tracking-[0.06em] uppercase sm:pt-[1px]">
        {label}
      </dt>
      <dd className="text-ink-dim min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Next({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <Link href={href} className="hover:bg-surface-1 -mx-2 flex gap-3 rounded-md px-2 py-2.5">
        <span className="text-ink w-[70px] shrink-0 font-medium">{label}</span>
        <span className="text-ink-faint min-w-0 flex-1 leading-relaxed">{children}</span>
        <span className="text-ink-faint shrink-0">→</span>
      </Link>
    </li>
  );
}
