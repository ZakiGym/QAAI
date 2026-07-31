'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API_URL, api, ApiError, type Project } from '../../lib/api';
import { useProject } from '../../components/shell/ProjectContext';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Page, PageHeader, SectionLabel } from '../../components/ui/layout';

/**
 * Suite import (§7) — the migration wedge, on the landing page as a headline.
 *
 * Upload your Cypress/Selenium/… suite → QAAI detects the framework, converts
 * to Playwright, and reports the coverage gained. Detection is instant and
 * shown before you commit; the guess is never binding — you can override it.
 */

interface Detection {
  framework: string;
  confidence: number;
  alternatives: Array<{ framework: string; score: number }>;
  evidence: string[];
  fileCount: number;
}

const FRAMEWORK_LABEL: Record<string, string> = {
  CYPRESS: 'Cypress',
  PLAYWRIGHT: 'Playwright',
  WEBDRIVERIO: 'WebdriverIO',
  PUPPETEER: 'Puppeteer',
  SELENIUM_JAVA: 'Selenium (Java)',
  SELENIUM_PYTHON: 'Selenium (Python)',
  SELENIUM_CSHARP: 'Selenium (C#)',
  SELENIUM_RUBY: 'Selenium (Ruby)',
  SELENIUM_JS: 'Selenium (JavaScript)',
  TESTCAFE: 'TestCafe',
  NIGHTWATCH: 'Nightwatch',
  ROBOT: 'Robot Framework',
  POSTMAN: 'Postman / Newman',
  KARATE: 'Karate',
  GHERKIN: 'Cucumber / Gherkin',
  UNKNOWN: 'Unknown',
};

const OVERRIDES = Object.keys(FRAMEWORK_LABEL).filter((f) => f !== 'UNKNOWN');

/** What an unfilled base URL becomes. Stated in the UI rather than only here. */
const DEFAULT_BASE_URL = 'http://localhost:3000';

type Phase = 'upload' | 'detected' | 'converting' | 'done' | 'error';

export default function ImportPage() {
  const router = useRouter();
  /**
   * Which project this imports into is the shell's answer, not `projects[0]`.
   * Someone with three apps under test was silently importing a Cypress suite
   * into whichever project happened to sort first.
   */
  const { project, loading: projectsLoading, reload } = useProject();
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [phase, setPhase] = useState<Phase>('upload');
  const [batchId, setBatchId] = useState<string | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [framework, setFramework] = useState<string>('');
  const [log, setLog] = useState<string[]>([]);
  const [convertedCount, setConvertedCount] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Import used to require a project to already exist — so someone arriving WITH
   * a Cypress suite and nothing else hit a screen that silently did nothing.
   * When there is no project, these fields appear and one is created on the way
   * through.
   */
  const [newProjectName, setNewProjectName] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  /** The project this page created, before the shell's list has caught up. */
  const [createdProject, setCreatedProject] = useState<Project | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const activeProjectId = createdProject?.id ?? project?.id ?? null;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  async function onPick(list: FileList | null) {
    if (!list) return;
    const read = await Promise.all(
      Array.from(list).map(
        (file) =>
          new Promise<{ path: string; content: string }>((resolve) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                path: file.webkitRelativePath || file.name,
                content: String(reader.result ?? ''),
              });
            reader.readAsText(file);
          }),
      ),
    );
    setFiles(read);

    // Name the project after the folder they dropped, when they have none yet.
    if (!newProjectName) {
      const top = read
        .map((f) => f.path.split('/')[0])
        .find((seg) => seg && !seg.includes('.'));
      setNewProjectName(top ? top.replace(/[-_]/g, ' ') : 'Imported tests');
    }
  }

  async function detect() {
    if (files.length === 0) return;
    setError(null);
    try {
      // No project yet? Make one, plus an environment for the tests to run
      // against later. Imported tests are converted to Playwright.
      let targetId = activeProjectId;
      if (!targetId) {
        const created = await api<{ project: Project }>('/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: newProjectName.trim() || 'Imported tests',
            primaryLanguage: 'TYPESCRIPT',
            primaryFramework: 'PLAYWRIGHT',
          }),
        });
        targetId = created.project.id;
        await api(`/projects/${targetId}/environments`, {
          method: 'POST',
          body: JSON.stringify({
            name: 'local',
            kind: 'LOCAL',
            baseUrl: newBaseUrl.trim() || DEFAULT_BASE_URL,
          }),
        }).catch(() => {
          /* the suite still imports without an environment; runs need one later */
        });
        setCreatedProject(created.project);
        // So the switcher in the top bar knows about it too.
        void reload();
      }

      const res = await api<{ batch: { id: string }; detection: Detection }>(
        `/projects/${targetId}/import`,
        { method: 'POST', body: JSON.stringify({ files }) },
      );
      setBatchId(res.batch.id);
      setDetection(res.detection);
      setFramework(res.detection.framework);
      setPhase('detected');
    } catch (err) {
      // The page no longer fetches /projects itself, so this is where a
      // signed-out session surfaces.
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Detection failed');
      setPhase('error');
    }
  }

  const follow = useCallback((id: string) => {
    const source = new EventSource(`${API_URL}/import/${id}/events`, { withCredentials: true });
    source.addEventListener('log', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { data: { message?: string } };
        if (parsed.data.message) setLog((prev) => [...prev, parsed.data.message!].slice(-200));
      } catch {
        /* ignore */
      }
    });
    const poll = setInterval(async () => {
      const res = await api<{
        batch: {
          state: string;
          convertedCount: number;
          summary: string | null;
          error: string | null;
        };
      }>(`/import/${id}`).catch(() => null);
      if (!res) return;
      if (res.batch.state === 'DONE') {
        clearInterval(poll);
        source.close();
        setConvertedCount(res.batch.convertedCount);
        setSummary(res.batch.summary);
        setPhase('done');
      } else if (res.batch.state === 'ERRORED') {
        clearInterval(poll);
        source.close();
        setError(res.batch.error ?? 'Conversion failed');
        setPhase('error');
      }
    }, 2000);
    return () => {
      clearInterval(poll);
      source.close();
    };
  }, []);

  async function convert() {
    if (!batchId) return;
    setPhase('converting');
    setLog([]);
    try {
      await api(`/import/${batchId}/convert`, {
        method: 'POST',
        body: JSON.stringify({ framework }),
      });
      follow(batchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start conversion');
      setPhase('error');
    }
  }

  return (
    <Page width="narrow">
      <PageHeader
        title="Import an existing suite"
        subtitle="Cypress, Selenium, WebdriverIO, Puppeteer, TestCafe, Nightwatch, Robot Framework, Postman, Karate, or Cucumber. QAAI detects it, converts to Playwright, and reports what you gained."
      />

      {(phase === 'upload' || phase === 'detected' || phase === 'error') && (
        <div>
          <label
            htmlFor="files"
            className="border-line hover:border-accent block cursor-pointer rounded-lg border border-dashed p-8 text-center"
          >
            <span className="text-ink-dim text-sm tabular-nums">
              {files.length > 0
                ? `${files.length} file(s) selected`
                : 'Choose your test files (or a whole folder)'}
            </span>
            <input
              id="files"
              type="file"
              multiple
              // @ts-expect-error — non-standard but widely supported folder upload
              webkitdirectory=""
              onChange={(e) => void onPick(e.target.files)}
              className="hidden"
            />
          </label>
          <p className="text-ink-faint mt-2 text-center text-xs">
            Nothing leaves your machine except the file contents, sent to your QAAI instance.
          </p>

          {/* No project yet — name the one this import will create. */}
          {files.length > 0 && !projectsLoading && !activeProjectId && (
            <div className="border-line mt-4 space-y-3 rounded-lg border p-4">
              <SectionLabel>New project</SectionLabel>
              <p className="text-ink-dim text-xs">
                You have no project yet, so this import will create one.
              </p>
              <Field
                aria-label="Project name"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Project name"
              />
              <Field
                aria-label="Base URL"
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                placeholder="https://staging.example.com (where these tests run)"
                // The default was silent: leaving this blank quietly pointed the
                // environment at localhost, which is nobody's staging server.
                hint={`Leave this blank and the environment is created against ${DEFAULT_BASE_URL}.`}
                className="font-mono"
              />
            </div>
          )}

          {files.length > 0 && phase !== 'detected' && (
            <Button variant="primary" onClick={() => void detect()} className="mt-4 w-full">
              Detect framework
            </Button>
          )}
        </div>
      )}

      {detection && (phase === 'detected' || phase === 'converting' || phase === 'done') && (
        <div className="border-line bg-surface-1 mt-6 rounded-lg border p-5">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-ink-faint text-xs">Detected</p>
              <p className="text-lg font-semibold">{FRAMEWORK_LABEL[detection.framework]}</p>
            </div>
            <span className="text-ink-faint font-mono text-xs tabular-nums">
              {Math.round(detection.confidence * 100)}% · {detection.fileCount} files
            </span>
          </div>

          {phase === 'detected' && (
            <>
              <label htmlFor="override" className="text-ink-faint mt-4 mb-1 block text-xs">
                Not right? Convert as:
              </label>
              <select
                id="override"
                value={framework}
                onChange={(e) => setFramework(e.target.value)}
                className="border-line bg-surface focus:border-accent w-full rounded-md border px-3 py-2 text-sm outline-none"
              >
                {OVERRIDES.map((f) => (
                  <option key={f} value={f}>
                    {FRAMEWORK_LABEL[f]}
                  </option>
                ))}
              </select>

              {framework !== 'POSTMAN' && (
                <p className="text-flake mt-3 text-xs">
                  Code conversion uses the model — it needs ANTHROPIC_API_KEY set. Postman
                  collections convert without a key.
                </p>
              )}

              <Button variant="primary" onClick={() => void convert()} className="mt-4 w-full">
                Convert to Playwright
              </Button>
            </>
          )}
        </div>
      )}

      {(phase === 'converting' || phase === 'done') && (
        <div className="mt-6">
          <div
            ref={logRef}
            className="border-line bg-surface-1 h-56 overflow-y-auto rounded-md border p-3 font-mono text-micro"
          >
            {log.map((line, i) => (
              <div key={i} className="text-ink-dim">
                {line}
              </div>
            ))}
          </div>

          {phase === 'done' && (
            <div className="border-pass/40 bg-pass/10 mt-4 rounded-lg border p-4">
              <p className="text-pass font-medium">
                Migrated <span className="tabular-nums">{convertedCount}</span> test
                {convertedCount === 1 ? '' : 's'} to the Imported suite.
              </p>
              {summary && (
                <p className="text-ink-dim mt-2 text-xs whitespace-pre-wrap">{summary}</p>
              )}
              <Link href="/editor" className="text-accent mt-3 inline-block text-sm">
                Open them in the editor →
              </Link>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-fail mt-6 text-sm">{error}</p>}
    </Page>
  );
}
